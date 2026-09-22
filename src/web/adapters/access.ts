/**
 * Accounts, space keys and shares — the half that is identical in every
 * transport.
 *
 * A space key is the whole of what a browser can prove about ownership, so
 * where it is remembered, what a URL fragment carries and which passwords the
 * server will accept are decided once, here. The transports differ only in how
 * they reach the server: HTTP in the standalone page, tools inside a host.
 */
import { z } from 'zod';
import type { AccountUser, ApiKeyInfo, ClaimResult, CreatedApiKey, FavoriteMap, LibraryMap, MapAccess, MapLibrary, PreviewLink, ShareLinkInfo } from '../../core/access.js';

export type { AccountUser, ApiKeyInfo, ClaimResult, CreatedApiKey, FavoriteMap, LibraryMap, MapAccess, MapLibrary, PreviewLink, ShareLinkInfo };

/**
 * A credential that arrived in a URL fragment.
 *
 * `owner` covers both a space key and a legacy per-map edit key: only the
 * server can tell them apart, and it does so from the stored digest, never from
 * the prefix. A preview token is kept separate because it grants strictly less
 * and must never be offered where an owner credential is required.
 */
export interface UrlCredential { owner?: string; previewToken?: string }

export function parseCredential(hash: string): UrlCredential {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const owner = params.get('space') ?? params.get('key') ?? undefined;
  const previewToken = params.get('preview') ?? undefined;
  return { ...(owner ? { owner } : {}), ...(previewToken ? { previewToken } : {}) };
}

/**
 * The address whoever holds `credential` can reopen `base` with.
 *
 * The owner credential wins when both are held: it is the one that reopens the
 * page as the person actually has it. A fragment, never a query — it is a
 * bearer credential, and only a fragment stays out of referrers and logs.
 */
export function credentialUrl(base: string, credential: UrlCredential): string {
  if (credential.owner) return `${base}#space=${encodeURIComponent(credential.owner)}`;
  if (credential.previewToken) return `${base}#preview=${encodeURIComponent(credential.previewToken)}`;
  return base;
}

export const PASSWORD_RULE = '12–128 位，同时包含大写字母、小写字母、数字，以及一个非空白符号。';

/**
 * The password rules the server enforces, stated before the request is sent.
 *
 * The form is the friendlier of the two checks, never the authoritative one:
 * it says what is missing so the field can be fixed, while the server decides.
 */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 12) return '密码至少 12 位。';
  if (password.length > 128) return '密码最多 128 位。';
  const missing = ([[/[a-z]/, '小写字母'], [/[A-Z]/, '大写字母'], [/\d/, '数字'], [/[^\p{L}\p{N}\s]/u, '非空白符号']] as const)
    .filter(([pattern]) => !pattern.test(password)).map(([, name]) => name);
  return missing.length ? `密码还缺少${missing.join('、')}。` : undefined;
}

export function confirmProblem(password: string, passwordConfirm: string): string | undefined {
  return password === passwordConfirm ? undefined : '两次输入的密码不一致。';
}

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

/**
 * The same address check the server applies, not an approximation of it.
 *
 * `z.email()` is what `normalizeEmail` in `src/server/auth.ts` validates with,
 * and zod is already in this bundle, so the form asks the identical question.
 * A hand-rolled pattern here could only differ in one of two ways: too strict,
 * which locks someone out of their own account with a message the server never
 * sent, or too loose, which promises an address the server then refuses.
 * Unicode and IDN addresses are out of scope for this version precisely
 * because that is what `z.email()` decides — this side does not extend it.
 */
const EMAIL = z.email();

export function emailProblem(email: string): string | undefined {
  const value = normalizeEmail(email);
  if (!value) return '请填写邮箱。';
  if (value.length > 254) return '邮箱最多 254 个字符。';
  return EMAIL.safeParse(value).success ? undefined : '邮箱格式不正确。';
}

export interface AuthInput { email: string; password: string; passwordConfirm?: string }

/** Everything a registration form must satisfy before it is worth sending. */
export function authProblem(input: AuthInput, mode: 'login' | 'register'): string | undefined {
  const email = emailProblem(input.email);
  if (email) return email;
  if (mode === 'login') return input.password ? undefined : '请填写密码。';
  return passwordProblem(input.password) ?? confirmProblem(input.password, input.passwordConfirm ?? '');
}

export const SPACE_STORAGE_KEY = 'cartula:space';
export const MAP_KEY_STORAGE_KEY = 'cartula:space-maps';

/**
 * Where an unclaimed anonymous owner key lives.
 *
 * Two questions, one answer, because one key can be the answer to both. `read`
 * is "which space does this browser create maps in" — it has to survive a
 * reload, or the next map lands in a space of its own and the previous ones
 * become unreachable. `forMap` is "which key opened this particular map", and
 * it exists because the first answer is a single value: opening a map from a
 * second space overwrites it, and going back in history to the first map would
 * otherwise arrive with no way in.
 *
 * Nothing here is a cache. Once the fragment that carried a key has been
 * consumed, this is the only copy the browser has, so entries are never
 * evicted to make room — an anonymous map whose key is dropped is gone for
 * good, and no bound on how many a browser may remember is worth that. The
 * deployment's own `maxMaps` is what limits the size of this.
 *
 * Entries leave only when the space is claimed: from then on the account
 * cookie is the browser's authority, and a key left behind — under the space
 * or under any one map — would hand account maps back to whoever used this
 * browser after a sign-out.
 */
export interface SpaceStore {
  read(): string | undefined;
  write(key: string): void;
  /** Drop the stored key; with an argument, only when it is that exact key. */
  clear(key?: string): void;
  /** The owner key this browser last opened `mapId` with. */
  forMap(mapId: string): string | undefined;
  /**
   * Tie a key to one map. Returns whether it was written somewhere that
   * survives a reload — the caller may only take the credential out of the URL
   * once something else is holding it.
   */
  remember(mapId: string, key: string): boolean;
  /** Forget this key wherever it is held, including under every map it opened. */
  forget(key: string): void;
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function createSpaceStore(storage: Storage | undefined = safeStorage()): SpaceStore {
  // Sandboxed frames throw on every access, not just the first, so each call is
  // guarded and an in-memory copy keeps the session working regardless.
  let memory: string | undefined;
  /** Only ever consulted when storage cannot be read. Never a cache of it. */
  let fallback: Record<string, string> = {};
  /**
   * The default space key, from storage every time.
   *
   * A *successful* read of nothing is an answer — another tab claimed the space
   * and removed it — so it must not be papered over with the copy this instance
   * happened to keep. `?? memory` did exactly that: it could not tell "storage
   * says there is no key" from "storage could not be asked", and revived a
   * credential this browser had been told to drop. Memory is a fallback for the
   * second case only, which is what keeps a sandboxed page working within its
   * own lifetime.
   */
  const read = () => {
    if (!storage) return memory;
    try { return storage.getItem(SPACE_STORAGE_KEY) ?? undefined; } catch { return memory; }
  };
  /**
   * Read the map keys, from storage every time, for the same reason.
   *
   * Storage is shared by every tab and every instance, and it is where claiming
   * and signing out do their forgetting. A copy held in this closure would go
   * stale the moment another tab claimed a space — and handing that copy back
   * would not merely be out of date, it would resurrect a credential this
   * browser was told to drop, and `save` would then write it back.
   */
  function keys(): Record<string, string> {
    if (!storage) return fallback;
    try {
      const raw = storage.getItem(MAP_KEY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch { return fallback; }
  }
  function save(next: Record<string, string>): boolean {
    try {
      if (!storage) { fallback = next; return false; }
      storage.setItem(MAP_KEY_STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch { fallback = next; return false; }
  }
  return {
    read,
    write(key) {
      // Memory is written first so a storage that refuses the write still
      // leaves this page able to use the key for its own lifetime.
      memory = key;
      try { storage?.setItem(SPACE_STORAGE_KEY, key); } catch { /* memory only */ }
    },
    clear(key) {
      if (key !== undefined && read() !== key) return;
      memory = undefined;
      try { storage?.removeItem(SPACE_STORAGE_KEY); } catch { /* memory only */ }
    },
    forMap(mapId) { const value = keys()[mapId]; return typeof value === 'string' ? value : undefined; },
    remember(mapId, key) {
      const current = keys();
      if (current[mapId] === key) return Boolean(storage);
      return save({ ...current, [mapId]: key });
    },
    forget(key) {
      this.clear(key);
      const current = keys();
      const entries = Object.entries(current).filter(([, value]) => value !== key);
      if (entries.length !== Object.keys(current).length) save(Object.fromEntries(entries));
    },
  };
}

/** What the credentials in hand currently grant, as far as the view knows. */
export interface AccessState {
  /** Access to the open map; undefined until the server has said. */
  access?: MapAccess;
  /** The signed-in account, `null` when anonymous, undefined while unknown. */
  user?: AccountUser | null;
  /** Whether the open preview is already in the account's favorites. */
  favorited?: boolean;
}

/**
 * Which entries this transport can offer at all — separate from whether the
 * current credentials allow them. A button that cannot work in this
 * transport is never drawn; one that needs a credential explains itself.
 */
export interface AccessCapabilities {
  /** Email and password are only ever entered on the standalone page. */
  account: boolean;
  share: boolean;
  favorite: boolean;
  copy: boolean;
  library: boolean;
  /** Can hand a URL to the surrounding browser or host. */
  openExternal: boolean;
}

/** A copy that was created: a new map of one's own, with no shared history. */
export interface CopyOutcome { id: string; title: string; url: string; editUrl: string }

/**
 * An owner credential this client is already holding.
 *
 * The scope is part of the answer because the warning that has to accompany the
 * key differs: a space key edits every map in the space, a legacy per-map key
 * exactly one. Only the transport can tell them apart — it is the side that
 * knows where the credential came from.
 */
export interface HeldOwnerKey { key: string; scope: 'space' | 'map' }

export interface AccessPort {
  /** Asked at render time: a host can gain or lose `openLink` while running. */
  capabilities(): AccessCapabilities;
  state(): AccessState;
  subscribe(listener: (state: AccessState) => void): () => void;
  /** Re-read session and map access; called when a panel is opened. */
  refresh(): Promise<AccessState>;
  /**
   * The owner credential this client already has in memory, if any.
   *
   * A read of what is held, never a request: the key is returned by the server
   * exactly once, at creation, and a plain get must not be able to recover it.
   * So `undefined` is a real answer — the space was claimed and the browser
   * dropped its copy, or storage was cleared — and the surface that asks has to
   * say so rather than retry. Owner-only by construction: a preview token is a
   * different field in every transport and never reaches this.
   */
  ownerKey?(): HeldOwnerKey | undefined;
  register?(input: AuthInput): Promise<void>;
  login?(input: AuthInput): Promise<void>;
  logout?(): Promise<void>;
  /** Move this whole space under the signed-in account. */
  claim?(): Promise<ClaimResult>;
  library?(): Promise<MapLibrary>;
  /**
   * Destroy one of the caller's own maps.
   *
   * Offered only where the library is, because it is the same authority: what
   * can list a space's maps is what can delete one of them. Irreversible on the
   * server, so the surface that calls it has to have asked first.
   */
  deleteMap?(id: string): Promise<void>;
  /**
   * Mint a share of this map. `canWrite` decides whether the link may edit it;
   * it defaults to false, so a caller that forgets hands out the narrower grant.
   */
  share?(canWrite?: boolean): Promise<PreviewLink>;
  /**
   * The shares of this map that are still live, newest first.
   *
   * Metadata only — the token is returned once, when the link is minted, and
   * the server keeps nothing but its digest. So this answers "what is still
   * open, and since when", not "what was the link".
   */
  listShares?(): Promise<ShareLinkInfo[]>;
  /** Stop one share by id, or every share of this map when no id is given. */
  revokeShare?(id?: string): Promise<void>;
  favorite?(): Promise<void>;
  unfavorite?(id: string): Promise<void>;
  listApiKeys?(): Promise<ApiKeyInfo[]>;
  createApiKey?(name?: string): Promise<CreatedApiKey>;
  revokeApiKey?(id: string): Promise<void>;
  copy?(): Promise<CopyOutcome>;
  /** The standalone address for the open map, carrying credentials in hand. */
  externalUrl?(): string | undefined;
  openExternal?(url: string): Promise<void>;
}

/** Minimal observable: the access state changes outside React's knowledge. */
export class AccessSignal {
  private listeners = new Set<(state: AccessState) => void>();
  private current: AccessState = {};
  state(): AccessState { return this.current; }
  set(patch: AccessState) {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener(this.current);
  }
  subscribe(listener: (state: AccessState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/**
 * Read `MapAccess` out of a response.
 *
 * Full reads nest it under `access`; the access probe answers with the fields
 * alongside `id` and `version`. Both are accepted, and anything that does not
 * carry a `kind` is treated as "not stated" rather than guessed at.
 */
export function readAccess(payload: unknown): MapAccess | undefined {
  const body = payload as { access?: unknown } | null;
  const found = (body && typeof body === 'object' && body.access ? body.access : payload) as Partial<MapAccess> | null;
  if (!found || typeof found !== 'object' || !['owner', 'shared-edit', 'preview', 'legacy-public'].includes(found.kind as string)) return undefined;
  // Only the permission fields: whatever else the envelope carried — an id, a
  // version — is about that response, and would go stale sitting in here.
  return {
    kind: found.kind as MapAccess['kind'],
    editable: Boolean(found.editable), canShare: Boolean(found.canShare), canClaim: Boolean(found.canClaim), claimed: Boolean(found.claimed),
    ...(found.spaceId ? { spaceId: found.spaceId } : {}),
    ...(typeof found.spaceMapCount === 'number' ? { spaceMapCount: found.spaceMapCount } : {}),
    // Who this page is in the event log, so the view can tell a collaborator's
    // version from one of its own.
    ...(found.authorId ? { authorId: found.authorId } : {}),
  };
}

/**
 * What to say when a map cannot be read at all.
 *
 * The page must never stop at "loading": whoever lands here needs to know which
 * of the two ways back applies to them — the link that carries the key, or the
 * account the space was saved to.
 */
export function accessErrorText(status: number | undefined, message: string): string {
  if (status === 401 || status === 403) return '这张地图是私有的。请用创建它的链接打开，或登录已保存它的账号。';
  if (status === 404) return '这张地图不存在，或者分享链接已经停用。';
  return message;
}

/** HTTP status a failed request reported, when it reported one. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}
