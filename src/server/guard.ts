/**
 * The single place a credential turns into permission.
 *
 * Routes and MCP tools both call `grantFor` before they read or write
 * anything, so "who is asking" is decided once, from the database, and never
 * from a token's shape. `MapStore.get` stays a trusted internal read; nothing
 * reaches it without passing through here first.
 */
import type { MapAccess } from '../core/access.js';
import { DomainError } from '../core/model.js';
import type { MapRow } from './access-store.js';
import type { MapStore } from './store.js';
import { assertBrowserIntent, parseCookies, SESSION_COOKIE } from './auth.js';

export interface Principal {
  /** A space key the caller demonstrably holds. */
  space?: { id: string; key: string; accountId: string | null };
  /** A live share token, scoped to exactly one map. `canWrite` is read from the row, never from the prefix. */
  preview?: { mapId: string; token: string; id: string; canWrite: boolean };
  /** A pre-access-model per-map edit key. Authorises that map and nothing else. */
  legacy?: { mapId: string; key: string };
  account?: { id: string; email: string };
  sessionToken?: string;
  /**
   * The bearer was an account API key. Unlike a session cookie, it is a named
   * credential — so it sets `scoped` — but unlike a space or share token it
   * authorises the whole account, so `grantFor` still treats it as ownership
   * of every space that account has claimed. A preview or space key presented
   * beside it still narrows the call.
   */
  accountKey?: boolean;
  /**
   * The caller named a credential explicitly, so that credential — not the
   * session cookie that happens to ride along — decides what this request may
   * see. Set even when the credential turns out to authorise nothing here.
   */
  scoped?: boolean;
}

export interface Grant {
  map: MapRow;
  access: MapAccess;
  /** Credential to hand `MapStore`, which re-checks it inside the write transaction. */
  writeAuth: { key?: string; accountId?: string; previewToken?: string };
}

export const bearerOf = (header?: string) => header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;

const empty: Principal = {};

/**
 * Resolve one presented bearer against the database.
 *
 * Prefixes route the lookup, but never decide it: a token is a preview token
 * because its digest is in `previews`, not because it starts with `cpt_`. An
 * unrecognised credential is an error, not a downgrade to anonymous.
 */
export function principalFromBearer(store: MapStore, bearer: string | undefined, mapId?: string): Principal {
  if (!bearer) return empty;
  if (bearer.length > 512) throw new DomainError(400, '凭证过长', '请检查 Authorization 请求头。');
  const share = store.access.preview(bearer);
  if (share) return { scoped: true, preview: { mapId: share.mapId, token: bearer, id: share.id, canWrite: share.canWrite } };
  const space = store.access.spaceByKey(bearer);
  if (space) return { scoped: true, space: { id: space.id, key: bearer, accountId: space.account_id } };
  const account = store.access.accountByApiKey(bearer);
  if (account) return { scoped: true, accountKey: true, account: { id: account.id, email: account.email } };
  if (mapId) {
    const map = store.access.mapRow(mapId);
    if (map && store.access.legacyKeyMatches(map, bearer)) return { scoped: true, legacy: { mapId, key: bearer } };
  }
  throw new DomainError(403, '凭证无效或已失效', '空间密钥或账号 API Key 用 Authorization: Bearer 传入；分享链接失效时请向所有者重新索取。');
}

/**
 * The same resolution for callers that name their credentials as values rather
 * than headers: MCP tool arguments and the WebSocket `auth` frame.
 *
 * Every named credential is verified on its own *and* against the map it is
 * being used on. A caller that presents two valid keys for different spaces has
 * named one that does not apply here, and that is an error to report — merging
 * them and letting the last write win would mean the argument order decided
 * whether the wrong key was noticed.
 */
export function principalFromCredentials(store: MapStore, options: { mapId?: string; key?: string; previewToken?: string; sessionToken?: string }): Principal {
  const principal: Principal = {};
  if (options.previewToken) {
    const share = store.access.preview(options.previewToken);
    if (!share) throw new DomainError(403, '分享链接已失效', '请向所有者索取新的分享链接。');
    principal.scoped = true;
    principal.preview = { mapId: share.mapId, token: options.previewToken, id: share.id, canWrite: share.canWrite };
  }
  if (options.key) {
    const named = principalFromBearer(store, options.key, options.mapId);
    // Both a share token and a key: they have to be talking about the same map.
    if (principal.preview && named.preview && named.preview.mapId !== principal.preview.mapId) {
      throw outOfScope();
    }
    principal.scoped = true;
    if (named.preview) principal.preview = named.preview;
    if (named.space) principal.space = named.space;
    if (named.legacy) principal.legacy = named.legacy;
    if (named.accountKey) {
      principal.accountKey = true;
      principal.account = named.account;
    }
  }
  if (options.mapId) assertReachesMap(store, options.mapId, principal);
  if (options.sessionToken) {
    const account = store.access.sessionAccount(options.sessionToken);
    if (account) {
      if (principal.accountKey && principal.account && principal.account.id !== account.id) {
        throw new DomainError(403, '凭证互相冲突', '账号 API Key 与当前登录不是同一个账号。');
      }
      principal.sessionToken = options.sessionToken;
      if (!principal.accountKey) principal.account = { id: account.id, email: account.email };
    }
  }
  return principal;
}

/** A credential that is real, but not for the map it was presented on. */
export const outOfScope = () => new DomainError(403, '凭证不属于这张地图', '每个凭证只授权它自己的空间或地图；请只传该地图对应的 spaceKey / editKey / previewToken。HTTP Authorization 已经带了账号 API Key 时，把多余的 spaceKey 参数去掉即可，不需要换一把。');

/**
 * Every credential the caller named has to reach this map.
 *
 * `grantFor` asks whether *some* credential proves access, which is the right
 * question for one and the wrong one for several: a correct key presented
 * alongside a key for another space would carry both. Refusing here means the
 * mistake is reported rather than absorbed, and the argument order stops
 * mattering. Only named credentials are checked — a session cookie is ambient,
 * not an assertion about this map.
 */
export function assertReachesMap(store: MapStore, id: string, principal: Principal) {
  const map = store.access.mapRow(id);
  if (!map) return;
  if (principal.space && map.space_id !== principal.space.id) throw outOfScope();
  if (principal.preview && principal.preview.mapId !== id) throw outOfScope();
  if (principal.legacy && principal.legacy.mapId !== id) throw outOfScope();
}

export interface RequestLike { headers: Record<string, unknown>; }

/**
 * Everything the request proves about itself: bearer credential plus session
 * cookie.
 *
 * A cookie-carrying mutation must also carry `X-Cartula-Request: 1`; without it
 * the request is refused rather than quietly treated as anonymous, because
 * "quietly anonymous" is how a cross-site POST turns into a new map in the
 * wrong place. An expired or unknown session cookie grants nothing and is
 * ignored — it is stale browser state, not an assertion.
 */
export function principalFromRequest(store: MapStore, request: RequestLike, options: { mapId?: string; mutation?: boolean; cookieOnly?: boolean } = {}): Principal {
  const cookie = parseCookies(request.headers.cookie as string | undefined)[SESSION_COOKIE];
  if (cookie && options.mutation) assertBrowserIntent(request.headers);
  // `cookieOnly` is for the account endpoints, where a bearer plays no part:
  // a revoked share token must not stop someone tidying up their own list.
  const bearer = options.cookieOnly ? undefined : bearerOf(request.headers.authorization as string | undefined);
  const principal = { ...principalFromBearer(store, bearer, options.mapId) };
  if (cookie) {
    const account = store.access.sessionAccount(cookie);
    if (account) {
      if (principal.accountKey && principal.account && principal.account.id !== account.id) {
        throw new DomainError(403, '凭证互相冲突', '账号 API Key 与当前登录不是同一个账号。');
      }
      principal.sessionToken = cookie;
      if (!principal.accountKey) principal.account = { id: account.id, email: account.email };
    }
  }
  return principal;
}

/** The logged-in account, or a 401 that names the missing credential. */
export function requireAccount(principal: Principal) {
  if (!principal.account) throw new DomainError(401, '请先登录', '这个操作需要登录后的会话 cookie，或账号 API Key。');
  return principal.account;
}

/**
 * What this principal may do with this map.
 *
 * Ownership can be proved three ways — the space key, the account that owns the
 * space, or a legacy map's own edit key — and they are equivalent. Read-only
 * access comes from a live share token, from a favorite still backed by one, or
 * from a map that predates the access model and was always public.
 *
 * A named credential decides the scope of the request that named it. When the
 * caller presents one explicitly, the session cookie riding along in the same
 * request does not widen the answer: a key for another space reads as "no
 * access here", not as "fall back to whoever is logged in", and an explicit
 * share token stays read-only even for the map's own owner. Otherwise a browser
 * holding a stale or borrowed key would silently act with account authority it
 * never asked to use.
 */
export function grantFor(store: MapStore, id: string, principal: Principal): Grant {
  const map = store.access.mapRow(id);
  if (!map) throw new DomainError(404, '地图不存在', '检查地图 ID，或用 PUT /m/{id} 创建。');
  // HTTP bearers reach this boundary directly too; legacy public access must
  // not swallow a valid credential that was presented for the wrong map.
  assertReachesMap(store, id, principal);
  const space = map.space_id ? store.access.spaceById(map.space_id) : undefined;
  const claimed = Boolean(space?.account_id);

  // Naming a share token is a statement about how this request wants to be
  // read, and it is honoured whatever else the caller holds. It used to apply
  // only to the account path, so the same "here is a share token" produced a
  // read-only answer beside an API key and an editable one beside a space key —
  // two owner paths disagreeing about a rule stated once, above.
  const named = !principal.preview;
  const viaSpace = named && Boolean(principal.space && map.space_id === principal.space.id);
  const viaLegacy = named && principal.legacy?.mapId === id;
  // A session cookie speaks only when no explicit credential was presented.
  // An account API key *is* an explicit credential, but its scope is the
  // account, so it still owns every claimed space.
  const viaAccount = named && Boolean(principal.account && space?.account_id === principal.account.id && (!principal.scoped || principal.accountKey));
  if (viaSpace || viaLegacy || viaAccount) {
    // A stable, non-secret name for whoever is writing: the space that holds
    // the map, whichever of the three owner proofs got them here. Naming the
    // credential instead would give one person two identities — the space key
    // in the Agent and the account key in the browser are the same owner, and
    // "was this edit mine?" has to answer yes to both. A pre-space-model map is
    // keyed per map, so the map itself names its one author.
    const authorId = map.space_id ?? `lg_${id}`;
    const access: MapAccess = {
      kind: 'owner', editable: true, canShare: true,
      // Only a key holder can hand a space to an account; being the account
      // that already owns it is not something left to claim.
      canClaim: !claimed && (viaSpace || viaLegacy),
      claimed, authorId,
      ...(map.space_id ? { spaceId: map.space_id, spaceMapCount: store.access.mapCount(map.space_id) } : { spaceMapCount: 1 }),
    };
    const writeAuth = viaSpace ? { key: principal.space!.key }
      : viaLegacy ? { key: principal.legacy!.key }
        : { accountId: principal.account!.id };
    return { map, access, writeAuth };
  }

  const viaPreview = principal.preview?.mapId === id;
  // A favorite is account-derived, so it too yields to an explicit credential.
  const viaFavorite = !principal.scoped && Boolean(principal.account && store.access.favoriteGrants(principal.account.id, id));
  if (viaPreview || viaFavorite) {
    // A share that was minted to allow editing writes this one map and nothing
    // else. `kind` deliberately is not `owner`, so `requireOwner` keeps
    // deletion, re-sharing and claiming out of its reach with no extra check.
    // A favorite is a read grant however the share it points at was minted.
    const canWrite = viaPreview && principal.preview!.canWrite;
    return {
      map,
      access: {
        kind: canWrite ? 'shared-edit' : 'preview',
        editable: canWrite, canShare: false, canClaim: false, claimed: false,
        ...(viaPreview ? { authorId: principal.preview!.id } : {}),
      },
      writeAuth: canWrite ? { previewToken: principal.preview!.token } : {},
    };
  }
  if (map.visibility === 'legacy-public') {
    return { map, access: { kind: 'legacy-public', editable: false, canShare: false, canClaim: false, claimed: false }, writeAuth: {} };
  }
  throw new DomainError(403, '没有这张地图的访问权限', '用 Authorization: Bearer <spaceKey> 传入空间密钥，或使用所有者提供的分享链接。');
}

/** Read access, already checked — the caller may then use the trusted store read. */
export function requireRead(store: MapStore, id: string, principal: Principal): Grant {
  return grantFor(store, id, principal);
}

export function requireWrite(store: MapStore, id: string, principal: Principal): Grant {
  const grant = grantFor(store, id, principal);
  if (!grant.access.editable) {
    throw new DomainError(403, '这张地图是只读的', grant.access.kind === 'preview' ? '分享链接只能查看、收藏或复制；编辑请向所有者索取空间密钥。' : '这是旧的公开地图，需要原 editKey 才能编辑。');
  }
  return grant;
}

/** Sharing, revoking and claiming are owner-only, even for a readable map. */
export function requireOwner(store: MapStore, id: string, principal: Principal): Grant {
  const grant = grantFor(store, id, principal);
  if (grant.access.kind !== 'owner') throw new DomainError(403, '需要地图所有者权限', '用空间密钥或已认领该空间的账号登录后重试。');
  return grant;
}

/**
 * The share credential worth handing to a hand-off message, or none.
 *
 * Naming a previewToken pins *this call* to exactly what the token allows —
 * read-only or writable — even beside a valid space key or account session
 * (see `grantFor` above): `access.kind` is `'preview'` or `'shared-edit'`
 * either way, so it cannot by itself tell a genuine share recipient apart
 * from an owner who merely named their own map's token alongside their own
 * credential. That distinction only shows up by asking the question again
 * with the token set aside: `scoped` is recomputed too, since it was true
 * only because the token had been named, and leaving it stale would make
 * `grantFor` refuse the very session or space key that answers the question.
 * An owner found this way must never be told their own map is a read-only
 * link to copy from.
 */
export function shareCredentialFor(store: MapStore, id: string, principal: Principal, access: MapAccess): { previewToken: string; canWrite: boolean } | undefined {
  if (access.kind !== 'preview' && access.kind !== 'shared-edit') return undefined;
  if (!principal.preview) return undefined;
  const withoutShare: Principal = { ...principal, preview: undefined, scoped: Boolean(principal.space || principal.legacy || principal.accountKey) };
  try {
    if (grantFor(store, id, withoutShare).access.kind === 'owner') return undefined;
  } catch { /* reaches nothing without the token — still a share recipient */ }
  return { previewToken: principal.preview.token, canWrite: access.kind === 'shared-edit' };
}
