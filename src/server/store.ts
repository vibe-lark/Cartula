import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyOperations, DomainError, distanceLabel, normalizeMap, layerStats, toMapInput } from '../core/model.js';
import { applyResolvedRoutes, enforceRouteGeometryBudget, type ResolvedRoute } from '../core/osrm.js';
import type { EditOperation, MapInput, MapLayer, MapSnapshot, SemanticEvent, WriteResult } from '../core/types.js';
import { AccessStore, NO_MAP_KEY, type MapRow } from './access-store.js';

type Head = MapRow;
export type RouteResolver = (layers: MapLayer[]) => Promise<ResolvedRoute[]>;
export type StoreOptions = { path: string; publicUrl: string; maxMaps?: number; maxVersions?: number; maxBytes?: number; maxSpaces?: number; resolveRoutes?: RouteResolver };
/**
 * How a write proves it may happen: a space key (or a legacy map's own edit
 * key), or the account that owns the map's space. Re-checked inside the write
 * transaction, so a revocation between the route check and the commit loses.
 */
export type WriteAuth = { key?: string; accountId?: string; previewToken?: string };

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validateId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new DomainError(400, '地图 ID 格式不正确', '使用 1–80 位字母、数字、短横线或下划线。私密分享请选择随机 ID。');
}
/**
 * Raised inside the write transaction when this logical request already has a
 * map: the reservation is the one decided by the database, so the caller
 * returns that map instead of the one it was about to create. Never escapes
 * `MapStore`.
 */
class AlreadyWritten extends Error {
  constructor(readonly mapId: string) { super(mapId); }
}
export class MapStore {
  readonly db: DatabaseSync;
  readonly publicUrl: string;
  readonly access: AccessStore;
  private listeners = new Set<(event: { id: string; version: number; changes: string[]; actor: 'agent' | 'user'; author?: string; reason?: string; deleted?: true }) => void>();
  constructor(private options: StoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.publicUrl = options.publicUrl.replace(/\/$/, '');
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS maps (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, head INTEGER NOT NULL, agent_version INTEGER NOT NULL, handoff_version INTEGER NOT NULL DEFAULT 0, space_id TEXT, visibility TEXT NOT NULL DEFAULT 'private');
      CREATE TABLE IF NOT EXISTS versions (map_id TEXT NOT NULL REFERENCES maps(id), version INTEGER NOT NULL, payload TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(map_id,version));
      CREATE TABLE IF NOT EXISTS writes (map_id TEXT NOT NULL REFERENCES maps(id), request_key TEXT NOT NULL, body_hash TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(map_id, request_key));
      CREATE INDEX IF NOT EXISTS version_map ON versions(map_id,version);`);
    // Older databases predate `space_id` / `visibility`; every map already in
    // them keeps its link and its edit key as `legacy-public`.
    AccessStore.migrateMaps(this.db);
    this.access = new AccessStore(this.db, this.publicUrl);
  }
  close() { this.db.close(); }
  onChange(listener: (event: { id: string; version: number; changes: string[]; actor: 'agent' | 'user'; author?: string; deleted?: true }) => void) {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private head(id: string): Head | undefined {
    validateId(id);
    return this.access.mapRow(id);
  }
  /**
   * Prove the right to write this map, from the database rather than from the
   * shape of the credential.
   *
   * Four proofs are equivalent: the key of the space the map lives in, the
   * account that owns that space, a share token minted to allow editing *this*
   * map, and — for a map created before the access model — that map's own edit
   * key. A read-only share is still refused here, and so is a writable share
   * presented on a different map than the one it names.
   */
  authorize(id: string, auth?: string | WriteAuth) {
    const head = this.head(id);
    if (!head) throw new DomainError(404, '地图不存在', '先调用 PUT /m/{id} 创建地图。');
    const { key, accountId, previewToken } = typeof auth === 'string' ? { key: auth, accountId: undefined, previewToken: undefined } : (auth ?? {});
    if (key) {
      const space = this.access.spaceByKey(key);
      if (space && head.space_id === space.id) return head;
      if (this.access.legacyKeyMatches(head, key)) return head;
    }
    if (accountId && head.space_id && this.access.spaceById(head.space_id)?.account_id === accountId) return head;
    if (previewToken) {
      const share = this.access.preview(previewToken);
      if (share?.canWrite && share.mapId === id) return head;
    }
    throw new DomainError(403, '需要空间密钥', '以 Authorization: Bearer <spaceKey> 传入创建时返回的密钥（旧地图用原 editKey），或使用所有者签发的可编辑分享链接。');
  }
  /** The same question without the exception, for paths that answer differently. */
  private mayWrite(id: string, auth?: string | WriteAuth) {
    try { this.authorize(id, auth); return true; } catch { return false; }
  }
  /**
   * Who is writing, as the event log names them.
   *
   * Derived here rather than passed in, because a caller that forgets it does
   * not fail — it silently writes an unattributed version and leaves that
   * author's read cursor behind, so the Agent then re-reads its own edits as
   * news. Every owner proof collapses to the space that holds the map: the
   * space key in the Agent and the account cookie in the browser are one owner,
   * and "was this mine?" has to answer yes to both. A writable share is its own
   * author — that is the whole point of it.
   */
  private authorOf(id: string, auth?: string | WriteAuth): string {
    const previewToken = typeof auth === 'string' ? undefined : auth?.previewToken;
    if (previewToken) {
      const share = this.access.preview(previewToken);
      if (share?.canWrite && share.mapId === id) return share.id;
    }
    return this.head(id)?.space_id ?? `lg_${id}`;
  }
  /**
   * Read the map, with the delta relative to one read window.
   *
   * The window is `since` when the caller names a version, and otherwise the
   * last version this map's Agent wrote — the historical "what happened while I
   * was away" cursor, kept for callers that never pass `since`.
   *
   * `changed` means exactly "there is at least one version in that window", by
   * any author. `hasUserChanges` / `hasAgentChanges` split it by author, so an
   * Agent can still ask the narrower question without `changed` having to lie:
   * previously `changed` only counted user events, so an Agent that had made
   * the last edit read `changed: false` next to a non-empty `changes` list and
   * stopped early.
   */
  get(id: string, since?: number, author?: string): MapSnapshot {
    const head = this.head(id);
    if (!head) throw new DomainError(404, '地图不存在', '检查地图 ID，或用 PUT /m/{id} 创建。');
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0 || since > head.head)) throw new DomainError(400, 'since 必须是已存在的版本号', `可用范围 0–${head.head}。`);
    const row = this.db.prepare('SELECT payload FROM versions WHERE map_id=? AND version=?').get(id, head.head) as { payload: string };
    const snapshot = JSON.parse(row.payload) as MapSnapshot;
    // An explicit `since` always wins. Otherwise this caller's own last write
    // is the window, and only if it has never written here does the map-wide
    // `agent_version` stand in — which is what every caller saw before cursors
    // existed, so a map that predates them reads exactly as it used to.
    const sinceVersion = since ?? (author === undefined ? undefined : this.access.cursor(id, author)) ?? head.agent_version;
    const events = this.db.prepare('SELECT event FROM versions WHERE map_id=? AND version>? ORDER BY version').all(id, sinceVersion).map(row => JSON.parse(String(row.event)) as SemanticEvent);
    return {
      ...snapshot,
      layers: snapshot.layers.map(layer => ({ ...layer, stats: layerStats(layer) })),
      events, sinceVersion,
      // Two boundaries, never merged: what the Agent has written, and what a
      // user confirmed as handed to the conversation. See `recordHandoff`.
      agentVersion: head.agent_version,
      handoffVersion: head.handoff_version,
      changed: events.length > 0,
      hasUserChanges: events.some(event => event.actor === 'user'),
      hasAgentChanges: events.some(event => event.actor === 'agent'),
      changes: events.flatMap(e => e.changes),
      ...(snapshot.intents?.length ? { intents: snapshot.intents } : {}),
    };
  }
  /**
   * Record that a round was actually handed to the conversation.
   *
   * Two boundaries exist and neither can stand in for the other:
   *
   *  - `agent_version` — the version the Agent last *wrote*. The server keeps
   *    it for the "what happened while I was away" window a caller gets when it
   *    passes no `since`. An Agent write says nothing about whether the user's
   *    edits before it were ever shown to anybody: the Agent may have written
   *    for its own reasons, and edits made while it was replying sit below it.
   *  - `handoff_version` — the version a user confirmed as delivered. Only the
   *    view knows this: `submit_changes` records a `draft.commit`, but that is
   *    a *submission*; the message can still be refused, lost, or never pasted.
   *    So the view reports it here once the host accepted `ui/message`, or once
   *    the user copied the message.
   *
   * Nothing here touches the version chain: no version, no event, no change
   * line, so an acknowledgement can never conflict with a write or be replayed
   * into one. It only moves forward and never past the head — a boundary that
   * ran ahead would hide user changes nobody has handed over, while one that
   * lags only offers a round again.
   *
   * The point of storing it at all is the embedded App: inside a sandboxed
   * frame the origin is opaque and every web storage API throws, so a reload
   * has nowhere local to read the boundary back from.
   */
  recordHandoff(id: string, auth: string | WriteAuth | undefined, version: number): { id: string; handoffVersion: number; agentVersion: number; version: number } {
    const head = this.authorize(id, auth);
    if (!Number.isSafeInteger(version) || version < 0) throw new DomainError(400, 'version 必须是非负整数版本号', '传入这次交接消息所描述的版本。');
    if (version > head.head) {
      throw new DomainError(400, `version 不能大于当前版本（收到 ${version}，当前 ${head.head}）`, '先重新读取地图，再记录实际交接的版本。', {
        code: 'UNKNOWN_VERSION', clientVersion: version, currentVersion: head.head,
      });
    }
    this.db.prepare('UPDATE maps SET handoff_version=MAX(handoff_version, ?) WHERE id=?').run(version, id);
    const updated = this.head(id)!;
    return { id, handoffVersion: updated.handoff_version, agentVersion: updated.agent_version, version: updated.head };
  }
  /**
   * How far behind the version a client says it is looking at.
   *
   * This is the report, not the check: callers that write through this version
   * pass it to `edit` as `baseVersion`, which is where a stale write is
   * refused. A version ahead of the head is not a version this map ever had, so
   * it is rejected rather than described.
   */
  viewStatus(id: string, clientVersion?: number): { clientVersion?: number; staleView?: boolean; changesSinceClientVersion?: string[] } {
    if (clientVersion === undefined) return {};
    const head = this.head(id);
    if (!head) throw new DomainError(404, '地图不存在', '检查地图 ID，或用 PUT /m/{id} 创建。');
    if (clientVersion > head.head) {
      throw new DomainError(400, `currentVersion 不能大于当前版本（收到 ${clientVersion}，当前 ${head.head}）`, '传入你实际读到的版本号；如果本地状态更新，请先重新读取地图。', {
        code: 'UNKNOWN_VERSION', clientVersion, currentVersion: head.head,
      });
    }
    return {
      clientVersion,
      staleView: clientVersion !== head.head,
      ...(clientVersion < head.head ? { changesSinceClientVersion: this.get(id, clientVersion).changes.slice(0, 20) } : {}),
    };
  }
  private conflict(baseVersion: number, currentVersion: number, conflictingChanges: string[] = []) {
    throw new DomainError(409, 'VERSION_CONFLICT', `请先读取 since=${baseVersion} 的摘要，再只提交受影响操作`, {
      error: 'VERSION_CONFLICT', baseVersion, currentVersion, conflictingChanges,
    });
  }
  private commit(id: string, content: Pick<MapSnapshot, 'title' | 'layers' | 'intents'>, actor: 'agent' | 'user', changes: string[], operations: SemanticEvent['operations'], previous?: MapSnapshot, reason?: string, author?: string): MapSnapshot {
    const version = (previous?.version ?? 0) + 1;
    if (version > (this.options.maxVersions ?? 1000)) throw new DomainError(507, '该地图已达到版本容量上限', '请导出 JSON，再以新的地图 ID 保存。');
    const updatedAt = new Date().toISOString();
    const event: SemanticEvent = { version, actor, at: updatedAt, changes, operations, ...(reason ? { reason } : {}), ...(author ? { author } : {}) };
    // Stored flags describe the write itself; `get` recomputes them for the
    // reader's own window, which is the only place they are authoritative.
    const snapshot: MapSnapshot = { ...content, id, version, parent: previous?.version ?? null, updatedAt, changed: true, hasUserChanges: actor === 'user', hasAgentChanges: actor === 'agent', sinceVersion: previous?.version ?? 0, changes, events: [], url: `${this.publicUrl}/map/${id}` };
    const pageCount = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    if (pageCount * pageSize + Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(event)) > (this.options.maxBytes ?? 512 * 1024 * 1024)) throw new DomainError(507, '地图存储已达到容量上限', '请联系部署者备份、归档或扩容。');
    this.db.prepare('INSERT INTO versions (map_id,version,payload,event) VALUES (?,?,?,?)').run(id, version, JSON.stringify(snapshot), JSON.stringify(event));
    this.db.prepare(`UPDATE maps SET head=?, agent_version=CASE WHEN ?='agent' THEN ? ELSE agent_version END WHERE id=?`).run(version, actor, version, id);
    // The per-author window moves on exactly the rule `agent_version` uses, and
    // for the same reason: a user edit made in the browser must not count as
    // "the Agent has seen this". The browser usually holds the very same space
    // key as the Agent, so advancing on every write would hide the user's own
    // changes from the Agent that is supposed to read them.
    if (author && actor === 'agent') this.access.advanceCursor(id, author, version);
    return snapshot;
  }
  private async previewRoutes(layers: MapLayer[]): Promise<ResolvedRoute[]> {
    if (!this.options.resolveRoutes) return [];
    try { return await this.options.resolveRoutes(layers); } catch { return []; }
  }
  /**
   * Merge resolved road geometry into the layers, then hold the map to the
   * derived-geometry budget. Enforcing it here — after every injection, on
   * every write path — is what keeps "the write succeeded" and "the map can
   * still be edited" from drifting apart. Any reduction is appended to
   * `changes` so the caller sees the degradation.
   */
  private attachRoutes(layers: MapLayer[], resolved: ResolvedRoute[], changes?: string[]) {
    const filled = applyResolvedRoutes(layers, resolved);
    const reduced = enforceRouteGeometryBudget(layers);
    if (!changes) return filled;
    for (let i = 0; i < changes.length; i += 1) {
      if (filled.some(name => changes[i].includes(`「${name}」`) && changes[i].includes('当前为直线估算'))) {
        changes[i] = changes[i].replace('需要重新提供路由，当前为直线估算', '已用 OSRM 按道路重新解算');
      }
    }
    for (const name of filled) {
      if (!changes.some(line => line.includes(name) && line.includes('OSRM'))) changes.push(`已用 OSRM 按道路解算「${name}」`);
      // The mileage line was written while the layer was briefly on a
      // straight-line estimate. It never reached storage in that state, so
      // report the road that did.
      const layer = layers.find(item => item.name === name);
      const index = changes.findIndex(line => line.includes(`「${name}」里程由`) && line.endsWith('（直线估算）'));
      if (layer && index >= 0) {
        changes[index] = `${changes[index].slice(0, changes[index].indexOf('变为'))}变为 ${Math.round(layer.stats.distanceKm)} 公里（${distanceLabel(layer.stats.distanceKind, true)}）`;
      }
    }
    changes.push(...reduced);
    return filled;
  }
  /**
   * Where a keyless creation lands.
   *
   * An explicit space key must name a space that exists — an unknown key is a
   * mistake to report, never a licence to mint a new space under a caller
   * chosen secret. A logged-in caller creates in its own default space; anyone
   * else gets a fresh anonymous space whose key is returned exactly once.
   */
  private targetSpace(opts: { key?: string; accountId?: string; spaceId?: string }): { spaceId: string; created?: { spaceId: string; spaceKey: string } } {
    if (opts.spaceId) return { spaceId: opts.spaceId };
    if (opts.key) {
      const space = this.access.spaceByKey(opts.key);
      if (!space) throw new DomainError(403, '空间密钥无效', '用 POST /api/spaces（或 MCP create_space）申请空间密钥；不要自行生成。');
      return { spaceId: space.id };
    }
    if (opts.accountId) return { spaceId: this.access.defaultSpaceId(opts.accountId) };
    const credential = this.createSpace();
    return { spaceId: credential.spaceId, created: credential };
  }
  /**
   * Delete a map and everything that pointed at it, in one transaction.
   *
   * The one write with no version to record: what it produces is the absence of
   * the map, so there is nothing left for an event to hang on. It is also the
   * only write that reaches outside the space — every share token dies with the
   * map, and so does every favorite those tokens backed. That is what makes it
   * owner-only at the boundary (`requireOwner`), not merely writable-only.
   *
   * `authorize` runs again inside the transaction for the same reason every
   * other write re-checks it: a key revoked between the route check and the
   * commit must lose. Order is not cosmetic — `PRAGMA foreign_keys=ON` means the
   * referencing rows have to go first.
   */
  delete(id: string, auth?: string | WriteAuth): { id: string; title: string } {
    validateId(id);
    let removed!: { title: string; version: number };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const head = this.authorize(id, auth);
      removed = { title: this.access.summaries([id])[0]?.title ?? id, version: head.head };
      this.access.forgetMap(id);
      this.db.prepare('DELETE FROM writes WHERE map_id=?').run(id);
      this.db.prepare('DELETE FROM versions WHERE map_id=?').run(id);
      this.db.prepare('DELETE FROM maps WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // Announced like any other write, so every transport learns about it the
    // same way. Nobody reads the payload: a subscriber is re-authorised before
    // delivery, finds no map, and is closed instead of being told.
    for (const listener of this.listeners) listener({ id, version: removed.version, changes: [], actor: 'user', deleted: true });
    return { id, title: removed.title };
  }
  /** Mint a space, subject to the deployment's capacity. The key exists only in the return value. */
  createSpace(accountId?: string) {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM spaces').get() as { n: number }).n);
    if (total >= (this.options.maxSpaces ?? 100_000)) throw new DomainError(507, '服务已达到空间数量上限', '请联系部署者扩容或归档。');
    return this.access.createSpace(accountId);
  }
  async put(id: string, input: MapInput, opts: { key?: string; accountId?: string; spaceId?: string; previewToken?: string; ifMatch?: number; idempotencyKey?: string; createOnly?: boolean; reserve?: { requestKey: string; bodyHash: string; conflict: () => DomainError } } = {}): Promise<WriteResult> {
    validateId(id);
    // A writable share authorises updates to the map it names. It cannot reach
    // the creation branch below, which refuses a share outright — being allowed
    // to edit one map is not being allowed to make another.
    const auth: WriteAuth = { key: opts.key, accountId: opts.accountId, previewToken: opts.previewToken };
    const bodyHash = digest(canonical(input));
    const requestKey = opts.idempotencyKey ? `key:${opts.idempotencyKey}` : `body:${bodyHash}`;
    const previewHead = this.head(id);
    // Permission before content, on every path. A `createOnly` caller that
    // cannot write this map is told the id is taken and nothing else: without
    // this, an unauthorised create with a matching payload would read another
    // space's map — through `normalizeMap`, through route resolution, and
    // finally through the idempotency replay that answers with the snapshot.
    if (previewHead) {
      if (!opts.createOnly) this.authorize(id, auth);
      else if (!this.mayWrite(id, auth)) throw new DomainError(409, '地图 ID 已存在', '换一个 ID 创建，或带编辑密钥使用 patch_map 更新。');
    }
    const prepared = normalizeMap(input, previewHead ? this.get(id) : undefined, 'agent');
    const resolved = await this.previewRoutes(prepared.layers);
    let created: { spaceId: string; spaceKey: string } | undefined;
    let spaceId: string | null = previewHead?.space_id ?? null;
    let committed: MapSnapshot | undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const head = this.head(id);
      if (head) {
        if (!opts.createOnly) this.authorize(id, auth);
        else if (!this.mayWrite(id, auth)) throw new DomainError(409, '地图 ID 已存在', '换一个 ID 创建，或带编辑密钥使用 patch_map 更新。');
        spaceId = head.space_id;
        const seen = this.db.prepare('SELECT body_hash FROM writes WHERE map_id=? AND request_key=?').get(id, requestKey) as { body_hash: string } | undefined;
        if (seen) {
          if (seen.body_hash !== bodyHash) throw new DomainError(409, 'Idempotency-Key 已用于另一份内容', '重试时发送原始内容；新的写入请使用新的 Idempotency-Key。');
          this.db.exec('COMMIT'); return this.get(id);
        }
        if (opts.createOnly) throw new DomainError(409, '地图 ID 已存在', '换一个 ID 创建，或带编辑密钥使用 patch_map 更新。');
        if (opts.ifMatch !== undefined && opts.ifMatch !== head.head) {
          const latest = this.get(id, opts.ifMatch);
          this.conflict(opts.ifMatch, head.head, latest.changes);
        }
      } else {
        if (opts.ifMatch !== undefined) throw new DomainError(409, '地图尚未创建，If-Match 不匹配');
        const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n);
        if (count >= (this.options.maxMaps ?? 1000)) throw new DomainError(507, '服务已达到地图数量上限', '请联系部署者扩容或归档。');
        // New maps are private and have no per-map key: the space key or the
        // owning account is the only way in.
        const target = this.targetSpace(opts);
        spaceId = target.spaceId; created = target.created;
        this.db.prepare(`INSERT INTO maps (id,key_hash,head,agent_version,space_id,visibility) VALUES (?,?,0,0,?,'private')`).run(id, NO_MAP_KEY, spaceId);
        // Claim the request id in the same transaction that creates the map, so
        // two simultaneous retries cannot both pass a "not written yet" check
        // and allocate a map each. The loser reads a committed reservation and
        // rolls this one back. The row is inserted after the map it references,
        // because SQLite checks foreign keys immediately.
        if (opts.reserve) {
          const owner = this.access.reserveRequest(opts.reserve.requestKey, id, opts.reserve.bodyHash);
          if (owner.map_id !== id) {
            if (owner.body_hash !== opts.reserve.bodyHash) throw opts.reserve.conflict();
            throw new AlreadyWritten(owner.map_id);
          }
        }
      }
      const previous = head ? this.get(id) : undefined;
      // `geometryNotes` reports geometry normalisation had to shrink; it is a
      // change line, never part of the stored document.
      const { geometryNotes = [], ...content } = normalizeMap(input, previous, 'agent');
      const changes = [head ? 'Agent 更新了地图方案' : 'Agent 创建了地图', ...geometryNotes];
      this.attachRoutes(content.layers, resolved, changes);
      committed = this.commit(id, content, 'agent', changes, [{ op: 'replace' }], previous, undefined, this.authorOf(id, auth));
      this.db.prepare('INSERT INTO writes VALUES (?,?,?,?)').run(id, requestKey, bodyHash, committed.version);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      // Another concurrent retry of the same logical request won the
      // reservation; its map is the answer, and this call wrote nothing.
      if (error instanceof AlreadyWritten) return this.get(error.mapId, 0);
      throw error;
    }
    const result = this.get(id, previewHead?.head ?? 0);
    for (const listener of this.listeners) listener({ id, version: committed.version, changes: committed.changes, actor: 'agent' });
    // A newly minted space key travels exactly once, in the response that
    // created it. `editKey` / `#key=` stay as aliases so an Agent holding the
    // old contract keeps working.
    return created
      ? { ...result, spaceId: created.spaceId, spaceKey: created.spaceKey, editKey: created.spaceKey, editUrl: `${result.url}#space=${encodeURIComponent(created.spaceKey)}` }
      : { ...result, ...(spaceId ? { spaceId } : {}) };
  }
  /**
   * Create a map that must not overwrite an existing one.
   *
   * With an explicit id, a retry is de-duplicated by that id. Without one, the
   * id is Cartula's to choose, so a retry would otherwise pick a new UUID and
   * create a second map: `requestId` reserves one generated id for the whole
   * logical creation, in the same transaction that writes it. The reservation
   * is scoped to the resolved space, so the same request id in two spaces is
   * two different creations.
   *
   * A keyless anonymous creation has no space to scope the reservation to, and
   * its first call is also the only time its space key exists — if that
   * response is lost, the key is gone and no retry could reach the map anyway.
   * Rather than accept a `requestId` it cannot honour, that combination is
   * refused with instructions, the same way `copy` refuses it.
   */
  async create(input: MapInput, opts: { id?: string; requestId?: string; key?: string; accountId?: string; spaceId?: string } = {}): Promise<WriteResult> {
    if (opts.id || !opts.requestId) {
      return this.put(opts.id ?? randomUUID(), input, { createOnly: true, idempotencyKey: opts.requestId, key: opts.key, accountId: opts.accountId, spaceId: opts.spaceId });
    }
    const spaceId = opts.spaceId
      ?? (opts.key ? this.targetSpace({ key: opts.key }).spaceId : undefined)
      ?? (opts.accountId ? this.access.defaultSpaceId(opts.accountId) : undefined);
    if (!spaceId) {
      throw new DomainError(400, '没有空间时无法保证 requestId 重试幂等', '先调用 create_space（或 POST /api/spaces）取得并保存 spaceKey，再带 spaceKey 和同一个 requestId 创建；或者省略 requestId 与 id，接受每次调用都新建一张地图和一个空间。');
    }
    const requestKey = `create:${spaceId}:${opts.requestId}`;
    const bodyHash = digest(canonical(input));
    const conflict = () => new DomainError(409, '创建请求 ID 已用于不同内容', '重试请发送原始内容；新的创建请使用新的 requestId。');
    const seen = this.access.copyOf(requestKey);
    if (seen) {
      if (seen.body_hash !== bodyHash) throw conflict();
      if (this.head(seen.map_id)) return { ...this.get(seen.map_id, 0), spaceId };
    }
    return this.put(randomUUID(), input, { createOnly: true, spaceId, reserve: { requestKey, bodyHash, conflict } });
  }
  async edit(id: string, key: string | WriteAuth | undefined, baseVersion: number, operations: EditOperation[], requestId?: string, actor: 'agent' | 'user' = 'user', reason?: string): Promise<MapSnapshot> {
    const ops = structuredClone(operations);
    const bodyHash = digest(canonical(operations));
    const requestKey = requestId ? `${actor === 'agent' ? 'agent-edit' : 'edit'}:${requestId}` : undefined;
    const head = this.authorize(id, key);
    const author = this.authorOf(id, key);
    if (requestKey) {
      const seen = this.db.prepare('SELECT body_hash FROM writes WHERE map_id=? AND request_key=?').get(id, requestKey) as { body_hash: string } | undefined;
      if (seen) {
        if (seen.body_hash !== bodyHash) throw new DomainError(409, '编辑请求 ID 已用于不同操作');
        return this.get(id, baseVersion);
      }
    }
    if (head.head !== baseVersion) this.conflict(baseVersion, head.head, this.get(id, baseVersion).changes);
    const prepared = applyOperations(this.get(id), structuredClone(ops), actor);
    const resolved = prepared.changes.length ? await this.previewRoutes(prepared.layers) : [];
    this.db.exec('BEGIN IMMEDIATE');
    let committed: MapSnapshot | undefined;
    try {
      const live = this.authorize(id, key);
      if (requestKey) {
        const seen = this.db.prepare('SELECT body_hash FROM writes WHERE map_id=? AND request_key=?').get(id, requestKey) as { body_hash: string } | undefined;
        if (seen) {
          if (seen.body_hash !== bodyHash) throw new DomainError(409, '编辑请求 ID 已用于不同操作');
          this.db.exec('COMMIT'); return this.get(id, baseVersion);
        }
      }
      if (live.head !== baseVersion) this.conflict(baseVersion, live.head, this.get(id, baseVersion).changes);
      const current = this.get(id);
      const content = applyOperations(current, structuredClone(ops), actor);
      this.attachRoutes(content.layers, resolved, content.changes);
      if (content.changes.length) committed = this.commit(id, content, actor, content.changes, content.operations, current, reason?.trim() || undefined, author);
      if (requestKey) this.db.prepare('INSERT INTO writes VALUES (?,?,?,?)').run(id, requestKey, bodyHash, committed?.version ?? live.head);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (committed) for (const listener of this.listeners) listener({ id, version: committed.version, changes: committed.changes, actor, ...(author ? { author } : {}), ...(reason?.trim() ? { reason: reason.trim() } : {}) });
    // Report the delta against the version the caller wrote from, so a write
    // result always describes its own write — including any geometry Cartula
    // had to simplify — instead of the reader-cursor window.
    return this.get(id, baseVersion);
  }
  async replaceByUser(id: string, key: string | WriteAuth | undefined, baseVersion: number, input: MapInput, requestId?: string): Promise<MapSnapshot> {
    const bodyHash = digest(canonical(input));
    const requestKey = requestId ? `import:${requestId}` : undefined;
    const head = this.authorize(id, key);
    const author = this.authorOf(id, key);
    if (requestKey) {
      const seen = this.db.prepare('SELECT body_hash FROM writes WHERE map_id=? AND request_key=?').get(id, requestKey) as { body_hash: string } | undefined;
      if (seen) {
        if (seen.body_hash !== bodyHash) throw new DomainError(409, '导入请求 ID 已用于不同内容');
        return this.get(id, baseVersion);
      }
    }
    if (head.head !== baseVersion) this.conflict(baseVersion, head.head, this.get(id, baseVersion).changes);
    const prepared = normalizeMap(input, this.get(id), 'user');
    const resolved = await this.previewRoutes(prepared.layers);
    this.db.exec('BEGIN IMMEDIATE');
    let committed: MapSnapshot | undefined;
    try {
      const live = this.authorize(id, key);
      if (requestKey) {
        const seen = this.db.prepare('SELECT body_hash FROM writes WHERE map_id=? AND request_key=?').get(id, requestKey) as { body_hash: string } | undefined;
        if (seen) {
          if (seen.body_hash !== bodyHash) throw new DomainError(409, '导入请求 ID 已用于不同内容');
          this.db.exec('COMMIT'); return this.get(id, baseVersion);
        }
      }
      if (live.head !== baseVersion) this.conflict(baseVersion, live.head, this.get(id, baseVersion).changes);
      const current = this.get(id);
      const { geometryNotes = [], ...content } = normalizeMap(input, current, 'user');
      const changes = [`用户导入了地图数据（${content.layers.length} 个图层）`, ...geometryNotes];
      this.attachRoutes(content.layers, resolved, changes);
      committed = this.commit(id, content, 'user', changes, [{ op: 'replace' }], current, undefined, author);
      if (requestKey) this.db.prepare('INSERT INTO writes VALUES (?,?,?,?)').run(id, requestKey, bodyHash, committed.version);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const listener of this.listeners) listener({ id, version: committed.version, changes: committed.changes, actor: 'user', ...(author ? { author } : {}) });
    return this.get(id, baseVersion);
  }
  /**
   * A copy is a new, independent map: title, layers and intents only.
   *
   * History, the source's version numbers, its space, its edit key and every
   * share it ever issued stay behind — the copy exists in the caller's own
   * space, and revoking the original's shares can never reach into it. The
   * caller must already hold read access; this method does not check it.
   *
   * `requestId` de-duplicates within one resolved target space, and is keyed to
   * that space rather than to the source, so the same id cannot be re-pointed at
   * a different map. Without a target space every call would mint a new space
   * and a retry could never be recognised, so asking for retry safety there is
   * refused instead of quietly promised.
   *
   * The fingerprint is the source id and the title the *caller* asked for, so
   * renaming the original later does not turn an honest retry into a 409. The
   * reservation is taken inside the copy's own creating transaction, so two
   * simultaneous retries produce one copy rather than one each.
   */
  async copy(sourceId: string, opts: { spaceId?: string; key?: string; accountId?: string; title?: string; requestId?: string; newId?: string } = {}): Promise<WriteResult> {
    const source = this.get(sourceId);
    if (opts.requestId && !opts.spaceId && !opts.key && !opts.accountId) {
      throw new DomainError(400, '复制前需要先确定目标空间，才能保证 requestId 重试幂等', '先取得 spaceKey（POST /api/spaces 或 MCP create_space）并作为 targetSpaceKey 传入；或省略 requestId，接受每次调用都新建一份副本。', { code: 'COPY_TARGET_REQUIRED' });
    }
    const target = this.targetSpace(opts);
    const title = opts.title?.trim() || `${source.title} 副本`;
    const requestKey = opts.requestId ? `copy:${target.spaceId}:${opts.requestId}` : undefined;
    // Only what the caller asked for. Including the inferred title would make
    // the fingerprint depend on the source's current name, so a rename after a
    // successful copy would answer the next retry with a spurious conflict.
    const bodyHash = digest(canonical({ source: sourceId, title: opts.title?.trim() || null }));
    const conflict = () => new DomainError(409, '复制请求 ID 已用于不同内容', '重试请保持源地图和标题不变；新的复制请使用新的 requestId。');
    if (requestKey) {
      const seen = this.access.copyOf(requestKey);
      if (seen) {
        if (seen.body_hash !== bodyHash) throw conflict();
        if (this.head(seen.map_id)) return { ...this.get(seen.map_id, 0), spaceId: target.spaceId };
      }
    }
    const copied = await this.put(opts.newId ?? randomUUID(), { ...toMapInput(source), title }, {
      createOnly: true, spaceId: target.spaceId,
      ...(requestKey ? { reserve: { requestKey, bodyHash, conflict } } : {}),
    });
    // The reservation was committed with the copy itself, so there is nothing
    // left to record here — and no window in which a retry could miss it.
    return target.created
      ? { ...copied, spaceId: target.created.spaceId, spaceKey: target.created.spaceKey, editKey: target.created.spaceKey, editUrl: `${copied.url}#space=${encodeURIComponent(target.created.spaceKey)}` }
      : { ...copied, spaceId: target.spaceId };
  }
}
