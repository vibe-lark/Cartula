/**
 * Credential primitives: password hashing, opaque tokens, session cookies and
 * the browser-intent (CSRF) check.
 *
 * Nothing here stores a secret. Every credential Cartula issues — space key,
 * preview token, session token, password — is kept as a SHA-256 digest or a
 * scrypt hash, so a database copy cannot be replayed against the service.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/model.js';

export const SESSION_COOKIE = 'cartula_session';
/** 30 days, matching the cookie the browser is given. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SPACE_KEY_PREFIX = 'csk_';
export const PREVIEW_TOKEN_PREFIX = 'cpt_';
export const API_KEY_PREFIX = 'cak_';

/** SHA-256 hex. Used for the credentials whose secret is already high entropy. */
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Fixed-length hex digests, so a mismatch never throws on length. */
export function digestMatches(value: string, storedDigest: string) {
  const actual = Buffer.from(digest(value));
  const expected = Buffer.from(storedDigest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const mintSpaceKey = () => `${SPACE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
export const mintPreviewToken = () => `${PREVIEW_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const mintApiKey = () => `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
export const mintSessionToken = () => randomBytes(32).toString('base64url');
export const mintId = (prefix: string) => `${prefix}${randomBytes(12).toString('base64url')}`;

// --- passwords -------------------------------------------------------------

/**
 * scrypt cost. 2^15 · r=8 is ~32 MiB and ~100 ms of one thread per hash, which
 * is why `SCRYPT_SLOTS` below caps how many can run at once: the parameters
 * that make a stolen digest expensive to attack also make an unbounded login
 * flood a memory exhaustion bug.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 } as const;
const maxmemFor = (N: number, r: number) => 256 * N * r;
/** Concurrent hashes; the libuv pool is 4 threads by default, leave room. */
const SCRYPT_SLOTS = 2;
/** Callers waiting for a slot. Beyond this the service says "busy" instead of queueing forever. */
const SCRYPT_QUEUE_LIMIT = 16;

let activeHashes = 0;
const waiting: Array<() => void> = [];
/**
 * Hand the slot straight to the next waiter instead of releasing and
 * re-acquiring it, so two callers can never observe the same free slot.
 */
async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeHashes < SCRYPT_SLOTS) activeHashes += 1;
  else {
    if (waiting.length >= SCRYPT_QUEUE_LIMIT) {
      throw new DomainError(503, '登录服务繁忙，请稍后重试', '同时进行的密码校验过多；稍后再试即可。');
    }
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next(); else activeHashes -= 1;
  }
}

const scrypt = (password: string, salt: Buffer, N: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) }, (error, key) => {
      if (error) reject(error); else resolve(key as Buffer);
    });
  });

/** `scrypt$N$r$p$salt$hash`, so stored digests stay readable after a cost change. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await withHashSlot(() => scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await withHashSlot(() => scrypt(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Spend the same work on an unknown email as on a known one, so "no such
 * account" and "wrong password" are indistinguishable in latency as well as in
 * wording. Runs under the same slot limit, so it cannot be used to bypass it.
 */
const DUMMY_PASSWORD = randomBytes(32).toString('base64url');
let dummyHash: Promise<string> | undefined;
export async function burnPasswordAttempt(password: string): Promise<void> {
  dummyHash ??= hashPassword(DUMMY_PASSWORD);
  await verifyPassword(password, await dummyHash).catch(() => false);
}

// --- account input ---------------------------------------------------------

/**
 * Enough structure to catch a typo, using the validator the project already
 * depends on rather than another hand-rolled pattern. Deliberately not an
 * attempt at deliverability: Cartula never sends mail, so an address is only
 * an identifier the person has to be able to retype.
 *
 * Zod's rule is ASCII-only, so an internationalised address such as
 * `用户@例子.中国` is refused; that is a deliberate contract choice, recorded in
 * `docs/access-handoff-backend.md`, not an oversight.
 */
const EMAIL = z.email();
export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL.safeParse(email).success) {
    throw new DomainError(400, '邮箱格式不正确', '请输入形如 name@example.com 的邮箱，最长 254 字符。');
  }
  return email;
}

/**
 * 12–128 characters with upper case, lower case, a digit and a non-whitespace
 * symbol. The same rule the form states, checked again here — a form is a
 * convenience, not a boundary.
 *
 * Exactly that rule and no more: an extra server-only condition would reject a
 * password the form had just called acceptable, which reads to the person as
 * the service losing their input for no stated reason.
 */
export function assertPasswordStrength(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new DomainError(400, '密码需要 12–128 个字符', '请使用 12 位以上、包含大小写字母、数字和符号的密码。');
  }
  const rules: Array<[boolean, string]> = [
    [/[a-z]/.test(password), '小写字母'],
    [/[A-Z]/.test(password), '大写字母'],
    [/[0-9]/.test(password), '数字'],
    [/[^\p{L}\p{N}\s]/u.test(password), '符号'],
  ];
  const missing = rules.filter(([ok]) => !ok).map(([, name]) => name);
  if (missing.length) throw new DomainError(400, `密码还缺少${missing.join('、')}`, '密码需要同时包含大小写字母、数字和符号，且不能只用空白字符。');
  return password;
}

export function assertPasswordConfirmed(password: string, confirm: unknown) {
  if (typeof confirm !== 'string' || confirm !== password) {
    throw new DomainError(400, '两次输入的密码不一致', '请重新输入确认密码。');
  }
}

// --- cookies and browser intent -------------------------------------------

/** Someone else's malformed cookie is not this request's problem: it is skipped, not thrown. */
export function parseCookies(header?: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try { jar[name] = decodeURIComponent(raw); } catch { jar[name] = raw; }
  }
  return jar;
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
export const clearedSessionCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/**
 * A cookie-carrying mutation has to look like it came from Cartula's own page:
 * a header no cross-origin form can set, and a `Sec-Fetch-Site` that is not a
 * cross-site navigation. `Origin` itself is checked once, globally, for every
 * request.
 */
export function assertBrowserIntent(headers: Record<string, unknown>) {
  if (headers['x-cartula-request'] !== '1') {
    throw new DomainError(403, '缺少 X-Cartula-Request 请求头', '浏览器端的账号操作需要发送 X-Cartula-Request: 1；命令行请改用 Authorization: Bearer。');
  }
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && !['same-origin', 'same-site', 'none'].includes(site)) {
    throw new DomainError(403, '跨站请求被拒绝', '请从 Cartula 页面发起该操作。');
  }
}
