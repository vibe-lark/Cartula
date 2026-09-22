/**
 * Who may touch a map: spaces, accounts, sessions, share tokens and favorites.
 *
 * Shares one SQLite connection with `MapStore` so a claim can move a map and
 * its space inside a single transaction. Only digests are stored; the plaintext
 * space key, preview token and session token exist exactly once, in the
 * response that mints them.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../core/model.js';
import type { ApiKeyInfo, CreatedApiKey, FavoriteMap, LibraryMap, PreviewLink, ShareLinkInfo, SpaceCredential } from '../core/access.js';
import type { MapSnapshot } from '../core/types.js';
import { digest, digestMatches, mintApiKey, mintId, mintPreviewToken, mintSpaceKey, mintSessionToken, SESSION_TTL_SECONDS } from './auth.js';

/**
 * A map created inside a space has no per-map key at all. The column keeps the
 * legacy meaning — "the digest of this map's own edit key" — and this sentinel
 * is shorter than any SHA-256 hex digest, so no credential can ever match it.
 */
export const NO_MAP_KEY = 'none';

export type MapVisibility = 'private' | 'legacy-public';
/**
 * `agent_version` and `handoff_version` are two different boundaries and are
 * kept apart on purpose: the first is the version the Agent last *wrote*, the
 * second the version a user last *handed to the conversation*. See
 * `MapStore.recordHandoff`.
 */
export interface MapRow { id: string; key_hash: string; head: number; agent_version: number; handoff_version: number; space_id: string | null; visibility: MapVisibility }
export interface SpaceRow { id: string; key_hash: string; account_id: string | null; created_at: string }
export interface AccountRow { id: string; email: string; password_hash: string; created_at: string }

const now = () => new Date().toISOString();
/** Enough to recognise a key on a list, not enough to use it. */
function maskSecret(key: string) {
  return key.length <= 14 ? '•'.repeat(key.length) : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export class AccessStore {
  // A short retry window without persisting plaintext bearer tokens. Durable
  // receipts below still prevent duplicate issuance after restart or eviction.
  private previewReplies = new Map<string, { link: PreviewLink; expires: number }>();
  constructor(private db: DatabaseSync, private publicUrl: string) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, account_id TEXT REFERENCES accounts(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS previews (token_hash TEXT PRIMARY KEY, map_id TEXT NOT NULL REFERENCES maps(id), created_at TEXT NOT NULL, id TEXT, can_write INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS preview_requests (map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE, request_key TEXT NOT NULL, share_id TEXT NOT NULL, can_write INTEGER NOT NULL, PRIMARY KEY(map_id, request_key));
      CREATE TABLE IF NOT EXISTS cursors (map_id TEXT NOT NULL REFERENCES maps(id), author TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(map_id, author));
      CREATE TABLE IF NOT EXISTS favorites (account_id TEXT NOT NULL REFERENCES accounts(id), map_id TEXT NOT NULL REFERENCES maps(id), token_hash TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_id, map_id));
      CREATE TABLE IF NOT EXISTS minted (request_key TEXT PRIMARY KEY, map_id TEXT NOT NULL REFERENCES maps(id), body_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), key_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hint TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS space_account ON spaces(account_id);
      CREATE INDEX IF NOT EXISTS api_key_account ON api_keys(account_id);
      CREATE INDEX IF NOT EXISTS map_space ON maps(space_id);
      CREATE INDEX IF NOT EXISTS preview_map ON previews(map_id);
      CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id);`);
    this.migratePreviews();
  }

  /**
   * Bring a `previews` table written before writable shares up to date.
   *
   * `can_write` defaults to 0, so every share that already exists stays exactly
   * as read-only as the link its holder was given — a migration must never
   * widen a grant. `id` is backfilled because it names the author of a write in
   * the event log, and a share with no id could write versions nobody could
   * attribute.
   */
  private migratePreviews() {
    const columns = (this.db.prepare('PRAGMA table_info(previews)').all() as Array<{ name: string }>).map(column => column.name);
    if (!columns.includes('id')) this.db.exec('ALTER TABLE previews ADD COLUMN id TEXT');
    if (!columns.includes('can_write')) this.db.exec('ALTER TABLE previews ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0');
    const orphans = this.db.prepare('SELECT token_hash FROM previews WHERE id IS NULL').all() as Array<{ token_hash: string }>;
    const name = this.db.prepare('UPDATE previews SET id=? WHERE token_hash=?');
    for (const row of orphans) name.run(mintId('sh_'), row.token_hash);
  }

  /**
   * Bring a database written before the access model up to date, without
   * rewriting a single version, event or idempotency record.
   *
   * Every map that already existed keeps its link and its edit key and is
   * marked `legacy-public`; only a request that proves the old edit key can
   * claim it into a private space. New maps default to `private`, so this can
   * never turn a fresh keyless creation into a public one.
   */
  static migrateMaps(db: DatabaseSync) {
    const columns = (db.prepare('PRAGMA table_info(maps)').all() as Array<{ name: string }>).map(column => column.name);
    // Added after the access model: a map that predates the hand-off boundary
    // starts at 0, which claims nothing has been handed over. That is the
    // recoverable direction — the round may be offered again, never skipped.
    if (!columns.includes('handoff_version')) db.exec('ALTER TABLE maps ADD COLUMN handoff_version INTEGER NOT NULL DEFAULT 0');
    if (columns.includes('visibility')) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns.includes('space_id')) db.exec('ALTER TABLE maps ADD COLUMN space_id TEXT');
      db.exec(`ALTER TABLE maps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
      db.exec(`UPDATE maps SET visibility='legacy-public'`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return true;
  }

  // --- maps ----------------------------------------------------------------

  mapRow(id: string): MapRow | undefined {
    return this.db.prepare('SELECT id, key_hash, head, agent_version, handoff_version, space_id, visibility FROM maps WHERE id=?').get(id) as MapRow | undefined;
  }
  /** True only when this map has its own legacy key and the caller proved it. */
  legacyKeyMatches(map: MapRow, key: string) {
    return map.key_hash !== NO_MAP_KEY && digestMatches(key, map.key_hash);
  }
  mapCount(spaceId: string) {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM maps WHERE space_id=?').get(spaceId) as { n: number }).n);
  }
  /**
   * Every map in these spaces. Deliberately not capped: a silent `LIMIT` makes
   * a library quietly lose maps the person owns, with nothing in the response
   * to say so. The deployment's `maxMaps` is what bounds this; if paging is
   * ever needed it has to be an explicit contract, not a truncation.
   */
  mapIdsOfSpaces(spaceIds: string[]): string[] {
    if (!spaceIds.length) return [];
    const holes = spaceIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT id FROM maps WHERE space_id IN (${holes}) ORDER BY rowid DESC`).all(...spaceIds) as Array<{ id: string }>).map(row => row.id);
  }

  /**
   * Drop everything this store keeps *about* one map: its shares, the favorites
   * those shares backed, and the id reservations that name it.
   *
   * Called only from `MapStore.delete`, inside its transaction — foreign keys
   * are on, so these rows have to go before the map row itself. Favorites belong
   * to other accounts, which is the point: a deleted map is not merely
   * unreachable, and leaving a row that says otherwise would put a dead entry in
   * somebody's list with no way to explain it.
   */
  forgetMap(mapId: string) {
    this.db.prepare('DELETE FROM favorites WHERE map_id=?').run(mapId);
    this.db.prepare('DELETE FROM previews WHERE map_id=?').run(mapId);
    this.db.prepare('DELETE FROM preview_requests WHERE map_id=?').run(mapId);
    this.db.prepare('DELETE FROM minted WHERE map_id=?').run(mapId);
    this.db.prepare('DELETE FROM cursors WHERE map_id=?').run(mapId);
  }

  // --- per-author read cursors ---------------------------------------------

  /**
   * Where one author's "what happened while I was away" window starts.
   *
   * `maps.agent_version` is a single column advanced by any agent write, which
   * is right for one Agent and wrong for two: a collaborator's Agent writing
   * would move the window past changes this Agent never read, and it would
   * stop early on its own next call. A row per author keeps the question
   * per-caller — and falls back to `agent_version` when there is no row, so a
   * map that predates this behaves exactly as before.
   */
  cursor(mapId: string, author: string): number | undefined {
    const row = this.db.prepare('SELECT version FROM cursors WHERE map_id=? AND author=?').get(mapId, author) as { version: number } | undefined;
    return row === undefined ? undefined : Number(row.version);
  }
  /** Only ever forward: a replayed or out-of-order write must not reopen a window already passed. */
  advanceCursor(mapId: string, author: string, version: number) {
    this.db.prepare(`INSERT INTO cursors (map_id,author,version) VALUES (?,?,?)
      ON CONFLICT(map_id,author) DO UPDATE SET version=MAX(version, excluded.version)`).run(mapId, author, version);
  }

  /** Title / version / updatedAt straight from the head payload — no event replay. */
  summaries(ids: string[]): LibraryMap[] {
    const read = this.db.prepare('SELECT v.payload AS payload FROM maps m JOIN versions v ON v.map_id=m.id AND v.version=m.head WHERE m.id=?');
    const out: LibraryMap[] = [];
    for (const id of ids) {
      const row = read.get(id) as { payload: string } | undefined;
      if (!row) continue;
      const snapshot = JSON.parse(row.payload) as MapSnapshot;
      out.push({ id, title: snapshot.title, version: snapshot.version, updatedAt: snapshot.updatedAt, url: `${this.publicUrl}/map/${id}` });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // --- spaces --------------------------------------------------------------

  createSpace(accountId?: string): SpaceCredential {
    const spaceKey = mintSpaceKey();
    const spaceId = mintId('sp_');
    this.db.prepare('INSERT INTO spaces (id,key_hash,account_id,created_at) VALUES (?,?,?,?)').run(spaceId, digest(spaceKey), accountId ?? null, now());
    return { spaceId, spaceKey, claimed: Boolean(accountId) };
  }
  spaceByKey(key: string): SpaceRow | undefined {
    return this.db.prepare('SELECT * FROM spaces WHERE key_hash=?').get(digest(key)) as SpaceRow | undefined;
  }
  spaceById(id: string): SpaceRow | undefined {
    return this.db.prepare('SELECT * FROM spaces WHERE id=?').get(id) as SpaceRow | undefined;
  }
  spacesOfAccount(accountId: string): SpaceRow[] {
    return this.db.prepare('SELECT * FROM spaces WHERE account_id=? ORDER BY created_at').all(accountId) as unknown as SpaceRow[];
  }
  /** Where a logged-in caller's keyless creations land. Created on first use. */
  defaultSpaceId(accountId: string): string {
    const existing = this.spacesOfAccount(accountId)[0];
    return existing ? existing.id : this.createSpace(accountId).spaceId;
  }

  // --- accounts and sessions ----------------------------------------------

  accountByEmail(email: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE email=?').get(email) as AccountRow | undefined;
  }
  accountById(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
  }
  createAccount(email: string, passwordHash: string): AccountRow {
    const account: AccountRow = { id: mintId('ac_'), email, password_hash: passwordHash, created_at: now() };
    try {
      this.db.prepare('INSERT INTO accounts (id,email,password_hash,created_at) VALUES (?,?,?,?)').run(account.id, account.email, account.password_hash, account.created_at);
    } catch {
      throw new DomainError(409, '该邮箱已注册', '直接登录，或换一个邮箱注册。');
    }
    return account;
  }
  createSession(accountId: string): string {
    const token = mintSessionToken();
    const created = new Date();
    this.db.prepare('INSERT INTO sessions (token_hash,account_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(digest(token), accountId, created.toISOString(), new Date(created.getTime() + SESSION_TTL_SECONDS * 1000).toISOString());
    return token;
  }
  /** Re-read on every use: logout and expiry take effect immediately, including mid-WebSocket. */
  sessionAccount(token: string): AccountRow | undefined {
    const row = this.db.prepare('SELECT account_id, expires_at FROM sessions WHERE token_hash=?').get(digest(token)) as { account_id: string; expires_at: string } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= now()) { this.revokeSession(token); return undefined; }
    return this.accountById(row.account_id);
  }
  revokeSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  }

  // --- account API keys ----------------------------------------------------

  /**
   * An account-wide bearer for Agents. Distinct from a space key: one key
   * authorises every space the account already owns, and it is minted from the
   * signed-in page rather than at space creation, so a lost space key is not
   * the end of MCP access. The secret is returned once; afterwards only a
   * recognisable hint remains.
   */
  static readonly MAX_API_KEYS = 10;
  createApiKey(accountId: string, name = 'MCP'): CreatedApiKey {
    const trimmed = name.trim() || 'MCP';
    if (trimmed.length > 80) throw new DomainError(400, '名称最多 80 个字符', '给这把密钥起一个短一点的名字。');
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_id=?').get(accountId) as { n: number }).n);
    if (count >= AccessStore.MAX_API_KEYS) {
      throw new DomainError(429, '这个账号的 API Key 数量已达上限', `每个账号最多 ${AccessStore.MAX_API_KEYS} 把；先停用一把再创建。`);
    }
    const apiKey = mintApiKey();
    const info = { id: mintId('ak_'), name: trimmed, hint: maskSecret(apiKey), createdAt: now() };
    this.db.prepare('INSERT INTO api_keys (id,account_id,key_hash,name,hint,created_at) VALUES (?,?,?,?,?,?)')
      .run(info.id, accountId, digest(apiKey), info.name, info.hint, info.createdAt);
    return { ...info, apiKey };
  }
  apiKeysOfAccount(accountId: string): ApiKeyInfo[] {
    return (this.db.prepare('SELECT id, name, hint, created_at FROM api_keys WHERE account_id=? ORDER BY created_at DESC')
      .all(accountId) as Array<{ id: string; name: string; hint: string; created_at: string }>)
      .map(row => ({ id: row.id, name: row.name, hint: row.hint, createdAt: row.created_at }));
  }
  accountByApiKey(key: string): AccountRow | undefined {
    const row = this.db.prepare('SELECT account_id FROM api_keys WHERE key_hash=?').get(digest(key)) as { account_id: string } | undefined;
    return row ? this.accountById(row.account_id) : undefined;
  }
  revokeApiKey(accountId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM api_keys WHERE id=? AND account_id=?').run(id, accountId).changes) === 1;
  }

  // --- share tokens --------------------------------------------------------

  /**
   * Mint a share of one map. `canWrite` is the whole difference between "look
   * at this" and "help me with this": both are the same random bearer, scoped
   * to this map alone and revoked together, and neither is ever an owner — a
   * writable share cannot delete the map, re-share it or claim the space.
   *
   * Handing out the space key would do none of that: it opens every map in the
   * space, carries delete, and has no revocation at all.
   */
  createPreview(mapId: string, canWrite = false, requestId?: string): PreviewLink {
    const requestKey = requestId ? digest(requestId) : undefined;
    const cacheKey = JSON.stringify([mapId, requestKey]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (requestKey) {
        const seen = this.db.prepare('SELECT share_id, can_write FROM preview_requests WHERE map_id=? AND request_key=?')
          .get(mapId, requestKey) as { share_id: string; can_write: number } | undefined;
        if (seen) {
          if (seen.can_write !== Number(canWrite)) throw new DomainError(409, '分享请求 ID 已用于不同权限', '新的分享请使用新的 requestId。');
          const live = this.db.prepare('SELECT 1 FROM previews WHERE map_id=? AND id=?').get(mapId, seen.share_id);
          if (!live) throw new DomainError(409, '这次请求生成的分享已停用', '需要新的分享时请重新生成。', { code: 'SHARE_REVOKED', shareId: seen.share_id });
          const cached = this.previewReplies.get(cacheKey);
          if (!cached || cached.link.id !== seen.share_id || cached.expires <= Date.now()) {
            this.previewReplies.delete(cacheKey);
            throw new DomainError(409, '分享链接已生成，未重复创建', '链接明文已无法恢复。请在已生成的链接中停用这条分享，再生成新的。', { code: 'SHARE_ALREADY_CREATED', shareId: seen.share_id });
          }
          this.db.exec('COMMIT');
          return { ...cached.link };
        }
      }
      if (this.previewCount(mapId) >= 50) throw new DomainError(429, '这张地图的分享链接过多', '先停用现有分享，再生成新的链接。');
      const previewToken = mintPreviewToken();
      const id = mintId('sh_');
      const createdAt = now();
      this.db.prepare('INSERT INTO previews (token_hash,map_id,created_at,id,can_write) VALUES (?,?,?,?,?)')
        .run(digest(previewToken), mapId, createdAt, id, canWrite ? 1 : 0);
      if (requestKey) this.db.prepare('INSERT INTO preview_requests VALUES (?,?,?,?)').run(mapId, requestKey, id, Number(canWrite));
      this.db.exec('COMMIT');
      const link = { id, createdAt, canWrite, previewToken, previewUrl: `${this.publicUrl}/map/${mapId}#preview=${encodeURIComponent(previewToken)}` };
      if (requestKey) {
        for (const [key, value] of this.previewReplies) if (value.expires <= Date.now()) this.previewReplies.delete(key);
        if (this.previewReplies.size >= 1000) this.previewReplies.delete(this.previewReplies.keys().next().value!);
        this.previewReplies.set(cacheKey, { link, expires: Date.now() + 10 * 60_000 });
      }
      return { ...link };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * Every live share of one map, newest first — what the owner is actually
   * handing out, as opposed to what they remember handing out.
   *
   * Without the token, because there is no token to have: the plaintext left
   * the process in the response that minted it. So a row is enough to date a
   * link, tell a read-only one from an editable one and revoke it, and nothing
   * here can reconstruct the link itself.
   */
  previews(mapId: string): ShareLinkInfo[] {
    return (this.db.prepare('SELECT id, created_at, can_write FROM previews WHERE map_id=? ORDER BY created_at DESC, rowid DESC')
      .all(mapId) as Array<{ id: string | null; created_at: string; can_write: number }>)
      .map(row => ({ id: row.id ?? `sh_${digest(row.created_at).slice(0, 24)}`, createdAt: row.created_at, canWrite: row.can_write === 1 }));
  }
  /** Revoke one share by the id the list reports. Unknown id → false, never a silent success. */
  revokePreview(mapId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM previews WHERE map_id=? AND id=?').run(mapId, id).changes) === 1;
  }
  /** The share this token names, or undefined. `canWrite` is read here, never inferred from the prefix. */
  preview(token: string): { id: string; mapId: string; canWrite: boolean } | undefined {
    const row = this.db.prepare('SELECT id, map_id, can_write FROM previews WHERE token_hash=?').get(digest(token)) as { id: string | null; map_id: string; can_write: number } | undefined;
    if (!row) return undefined;
    // `migratePreviews` backfills every pre-existing row, and `createPreview`
    // always writes one, so the digest is a fallback that should never be
    // reached rather than a second id scheme.
    return { id: row.id ?? `sh_${digest(row.map_id).slice(0, 24)}`, mapId: row.map_id, canWrite: row.can_write === 1 };
  }
  previewMapId(token: string): string | undefined {
    return this.preview(token)?.mapId;
  }
  /** Revokes every share of one map at once; favorites backed by them stop reading. */
  revokePreviews(mapId: string): number {
    return Number(this.db.prepare('DELETE FROM previews WHERE map_id=?').run(mapId).changes);
  }
  previewCount(mapId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM previews WHERE map_id=?').get(mapId) as { n: number }).n);
  }

  // --- favorites -----------------------------------------------------------

  /**
   * Remember what the reader could see when they saved it. Once the share is
   * revoked the entry stays listable — you can still find and remove it — but
   * it reports that snapshot, never a title the map has acquired since.
   */
  addFavorite(accountId: string, mapId: string, token: string) {
    const saved = this.summaries([mapId])[0];
    this.db.prepare(`INSERT INTO favorites (account_id,map_id,token_hash,title,version,updated_at,created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id,map_id) DO UPDATE SET token_hash=excluded.token_hash, title=excluded.title, version=excluded.version, updated_at=excluded.updated_at`)
      .run(accountId, mapId, digest(token), saved?.title ?? '', saved?.version ?? 0, saved?.updatedAt ?? now(), now());
  }
  removeFavorite(accountId: string, mapId: string) {
    this.db.prepare('DELETE FROM favorites WHERE account_id=? AND map_id=?').run(accountId, mapId);
  }
  /** A favorite reads only while the share token that created it is still live. */
  favoriteGrants(accountId: string, mapId: string): boolean {
    const row = this.db.prepare('SELECT token_hash FROM favorites WHERE account_id=? AND map_id=?').get(accountId, mapId) as { token_hash: string } | undefined;
    if (!row) return false;
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM previews WHERE token_hash=?').get(row.token_hash));
  }
  favorites(accountId: string): FavoriteMap[] {
    const rows = this.db.prepare('SELECT map_id, token_hash, title, version, updated_at FROM favorites WHERE account_id=? ORDER BY created_at DESC')
      .all(accountId) as unknown as Array<{ map_id: string; token_hash: string; title: string; version: number; updated_at: string }>;
    const live = new Set(rows.filter(row => this.db.prepare('SELECT 1 AS ok FROM previews WHERE token_hash=?').get(row.token_hash)).map(row => row.map_id));
    const current = new Map(this.summaries([...live]).map(entry => [entry.id, entry]));
    return rows.map(row => live.has(row.map_id) && current.has(row.map_id)
      ? { ...current.get(row.map_id)!, available: true }
      : { id: row.map_id, title: row.title, version: row.version, updatedAt: row.updated_at, url: `${this.publicUrl}/map/${row.map_id}`, available: false });
  }

  // --- id reservations for writes whose id Cartula chooses -------------------

  /**
   * A copy and a keyless `create_map` both let Cartula pick the map id, so a
   * retry has nothing of its own to de-duplicate against. `minted` remembers
   * which map one logical request produced, scoped to the target space.
   */
  copyOf(requestKey: string): { map_id: string; body_hash: string } | undefined {
    return this.db.prepare('SELECT map_id, body_hash FROM minted WHERE request_key=?').get(requestKey) as { map_id: string; body_hash: string } | undefined;
  }
  /**
   * Claim a request id for one map, and report who actually holds it.
   *
   * `INSERT OR IGNORE` plus the read-back is the whole race decider: it runs
   * inside the caller's write transaction, so of two simultaneous retries one
   * inserts and the other reads the winner's map id instead of creating a
   * second map. A returned id other than `mapId` means this call lost.
   */
  reserveRequest(requestKey: string, mapId: string, bodyHash: string): { map_id: string; body_hash: string } {
    this.db.prepare('INSERT OR IGNORE INTO minted (request_key,map_id,body_hash,created_at) VALUES (?,?,?,?)').run(requestKey, mapId, bodyHash, now());
    return this.copyOf(requestKey)!;
  }

  // --- claiming ------------------------------------------------------------

  /**
   * Give one account the whole space a map lives in, atomically.
   *
   * Two shapes, one transaction each:
   *  - a map already in a space: the space gets an owner, and every map in it
   *    comes along. `WHERE account_id IS NULL` is the race decider, so two
   *    accounts claiming the same key concurrently produce one winner and one
   *    409 rather than a silent hand-over.
   *  - a legacy public map proved by its old edit key: a fresh private space is
   *    created for it. `key_hash` is untouched, so the old key keeps working —
   *    for that one map, as it always did.
   */
  claim(mapId: string, accountId: string): { spaceId: string; claimedMapCount: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const map = this.mapRow(mapId);
      if (!map) throw new DomainError(404, '地图不存在');
      let spaceId = map.space_id;
      if (spaceId) {
        const space = this.spaceById(spaceId);
        if (!space) throw new DomainError(404, '空间不存在');
        if (space.account_id && space.account_id !== accountId) {
          throw new DomainError(409, '该空间已归属其他账号', '这些地图已经被另一个账号保存；换一个空间，或请对方分享给你。');
        }
        if (!space.account_id) {
          const updated = this.db.prepare('UPDATE spaces SET account_id=? WHERE id=? AND account_id IS NULL').run(accountId, spaceId);
          if (Number(updated.changes) !== 1) throw new DomainError(409, '该空间已归属其他账号', '刚刚有另一个账号完成了保存；刷新后查看。');
        }
      } else {
        spaceId = this.createSpace(accountId).spaceId;
        const moved = this.db.prepare(`UPDATE maps SET space_id=?, visibility='private' WHERE id=? AND space_id IS NULL`).run(spaceId, mapId);
        if (Number(moved.changes) !== 1) throw new DomainError(409, '该地图已归属其他空间', '刚刚有另一个账号完成了保存；刷新后查看。');
      }
      const claimedMapCount = this.mapCount(spaceId);
      this.db.exec('COMMIT');
      return { spaceId, claimedMapCount };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
