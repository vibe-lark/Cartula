import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import websocketPlugin from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MapStore } from './store.js';
import { registerMcp } from './mcp.js';
import { appHtml } from './html.js';
import { DomainError } from '../core/model.js';
import { MapInputSchema, IntentSchema } from '../core/schema.js';
import type { EditOperation, WriteResult } from '../core/types.js';
import type { MapAccess } from '../core/access.js';
import {
  assertBrowserIntent, assertPasswordConfirmed, assertPasswordStrength, burnPasswordAttempt,
  clearedSessionCookie, hashPassword, normalizeEmail, parseCookies, SESSION_COOKIE, sessionCookie, verifyPassword,
} from './auth.js';
import { bearerOf, grantFor, principalFromCredentials, principalFromRequest, requireAccount, requireOwner, requireRead, requireWrite, shareCredentialFor, type Principal } from './guard.js';
import { DEMO_INPUT } from '../core/demo.js';
import { openApiDocument } from './openapi.js';
import { registerTiles } from './tiles.js';
import { registerBasemap } from './basemap.js';
import { registerImages } from './images.js';
import { deltaFlags, presentMap } from './presentation.js';
import { planningMessage } from '../core/handoff.js';
import { resolveMissingRoutes } from '../core/osrm.js';
import { createOsrmClient } from './osrm.js';
import { BUILD, RELEASE, RELEASE_VERSION } from './release.js';
import { registerGuideHttp } from './guide.js';
import { registerPluginHttp } from './plugin.js';

export interface AppOptions { dbPath?: string; publicUrl?: string; logger?: boolean; /** Where log lines go when `logger` is on; stdout when absent. */ logStream?: { write(line: string): unknown }; basemapStyle?: string; tileUrl?: string; tileUpstream?: string; tileProxy?: string; tileAttribution?: string; /** Test seams for the image proxy behind card pictures. */ imageFetch?: unknown; imageLookup?: unknown; allowedOrigins?: string[]; allowedHosts?: string[]; maxMaps?: number; osrmUrl?: string; osrmProxy?: string; osrmFetch?: typeof fetch }
/**
 * The envelope is validated here; the operations themselves are validated by
 * `applyOperations`, so an unknown field reports the same path and the same
 * correction over HTTP as it does through MCP — one contract, one message.
 */
const EditSchema = z.object({ baseVersion: z.number().int().positive(), operations: z.array(z.unknown()).min(1).max(100), requestId: z.string().min(1).max(128).optional(), reason: z.string().min(1).max(2000).optional() });
const SuggestSchema = z.object({ type: z.literal('suggest'), text: z.string().min(1).max(2000), highlight: z.array(z.string().max(160)).max(50).optional() });
export async function createApp(options: AppOptions = {}) {
  const publicUrl = options.publicUrl ?? 'http://localhost:3900';
  const basemapStyle = options.basemapStyle ?? (!options.tileUrl && !options.tileUpstream ? 'liberty' : undefined);
  const tileUrl = options.tileUrl ?? (options.tileUpstream || basemapStyle ? `${publicUrl}/tiles/{z}/{x}/{y}.png` : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  const styleUrl = basemapStyle ? `${publicUrl}/basemap/styles/${basemapStyle}` : undefined;
  if (basemapStyle && !['positron', 'liberty', 'bright', 'dark'].includes(basemapStyle)) throw new Error('Unknown BASEMAP_STYLE');
  const tileOrigin = new URL(tileUrl.replace(/\{[zxy]\}/g, '0')).origin;
  const tileAttribution = options.tileAttribution ?? '© OpenStreetMap contributors';
  const osrmUrl = options.osrmUrl?.trim();
  const osrm = osrmUrl ? createOsrmClient({ baseUrl: osrmUrl, proxy: options.osrmProxy ?? options.tileProxy, fetchImpl: options.osrmFetch as never }) : undefined;
  const store = new MapStore({
    path: options.dbPath ?? './data/cartula.sqlite', publicUrl, maxMaps: options.maxMaps,
    resolveRoutes: osrm ? layers => resolveMissingRoutes(layers, osrm) : undefined,
  });
  // Every credential-bearing header, in both directions: an Authorization
  // bearer, the session cookie the request sent, and the one a response sets.
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], ...(options.logStream ? { stream: options.logStream } : {}) } : false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 30_000 });
  const origins = new Set([new URL(publicUrl).origin, 'http://localhost:3900', 'http://127.0.0.1:3900', ...(options.allowedOrigins ?? [])]);
  const hosts = new Set([new URL(publicUrl).hostname, 'localhost', '127.0.0.1', '[::1]', ...(options.allowedHosts ?? [])]);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocketPlugin, { options: { maxPayload: 16_384 } });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (request.url.startsWith('/mcp') && !hosts.has(request.hostname)) return reply.code(403).send({ error: 'Host 不被允许', hint: '请使用 PUBLIC_URL 中配置的 MCP 地址。' });
    if (origin && !origins.has(origin) && !request.url.startsWith('/tiles/') && !request.url.startsWith('/basemap/') && !/^\/img(?:\?|$)/.test(request.url)) return reply.code(403).send({ error: '来源不被允许', hint: '从 Cartula 页面或配置的客户端访问。部署者可配置 ALLOWED_ORIGINS。' });
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const publicOrigin = new URL(publicUrl).origin;
    const wsOrigin = publicOrigin.replace(/^http/, 'ws');
    // The verification host's MCP client compiles JSON schemas with `new Function`;
    // only that page needs 'unsafe-eval', so every other page keeps the tighter policy.
    const scriptSrc = request.url.split('?')[0] === '/mcp-host.html' ? `'self' 'unsafe-inline' 'unsafe-eval' blob:` : `'self' 'unsafe-inline' blob:`;
    reply.header('Content-Security-Policy', `default-src 'self'; script-src ${scriptSrc}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ${tileOrigin} ${publicOrigin} ${wsOrigin}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      // Same shape as the core's `validate`: the field path, the offending
      // unknown keys and the whole issue list, so an HTTP caller can correct a
      // request without guessing which field was refused.
      const issues = error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        ...('keys' in issue && Array.isArray(issue.keys) ? { unknownFields: issue.keys as string[] } : {}),
      }));
      const first = issues[0];
      const unknown = first?.unknownFields?.length ? `未知字段${first.unknownFields.map(key => `「${key}」`).join('、')}。` : '';
      // A rejected account or space body is not map data: telling someone who
      // mistyped a registration field about [longitude, latitude] sends them to
      // fix the wrong thing.
      if (!/^\/(m\/|api\/maps\/[^/]+\/(edit|replace|submit|copy)$)/.test(request.url.split('?')[0])) {
        return reply.code(400).send({
          error: `请求格式不正确：${first?.path ? `${first.path}：` : ''}${unknown}${first?.message ?? '检查输入'}`,
          path: first?.path, issues,
          hint: unknown ? '未知字段不会被忽略；请只发送该接口声明的字段。' : '请按接口声明的字段和类型发送请求。',
        });
      }
      const body = request.body as { layers?: { points?: { at?: number[] }[] }[] } | undefined;
      const reversed = Array.isArray(body?.layers) ? body.layers.flatMap(l => Array.isArray(l?.points) ? l.points : []).find(p => Array.isArray(p?.at) && p.at.length === 2 && Math.abs(p.at[1]) > 90 && Math.abs(p.at[1]) <= 180 && Math.abs(p.at[0]) <= 90) : undefined;
      return reply.code(400).send({
        error: `地图数据格式不正确：${first?.path ? `${first.path}：` : ''}${unknown}${first?.message ?? '检查输入'}`,
        path: first?.path, issues,
        hint: reversed ? '坐标格式是 [经度, 纬度]，这组坐标可能写反了。' : '未知字段不会被忽略；坐标使用 [经度, 纬度]，图层和节点都需要 name。',
        ...(reversed ? { got: reversed.at, fix: [reversed.at![1], reversed.at![0]] } : {}),
      });
    }
    if (error instanceof DomainError) {
      const details = (error.details && typeof error.details === 'object') ? error.details as Record<string, unknown> : undefined;
      return reply.code(error.statusCode).send({ error: error.message, hint: error.hint, ...(details ?? { details: error.details }) });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'Request failed');
    return reply.code(statusCode).send({ error: statusCode >= 500 ? '服务暂时无法完成请求' : (error as Error).message, hint: statusCode >= 500 ? '稍后重试；如持续失败，请查看服务日志。' : '请检查请求格式。' });
  });
  const secureCookies = new URL(publicUrl).protocol === 'https:';
  /** Everything the request proves; `mutation` also demands the browser-intent header when a cookie is involved. */
  const who = (request: { headers: Record<string, unknown> }, options: { mapId?: string; mutation?: boolean; cookieOnly?: boolean } = {}) => principalFromRequest(store, request, options);
  /**
   * The access block that travels with a map response. When the write named or
   * minted the space, describe the caller as its owner: that credential is in
   * this very exchange, even if it did not arrive in the Authorization header.
   */
  const accessOf = (id: string, principal: Principal, credential?: { spaceId?: string; spaceKey?: string }): MapAccess =>
    grantFor(store, id, credential?.spaceId && credential.spaceKey ? { ...principal, space: { id: credential.spaceId, key: credential.spaceKey, accountId: null } } : principal).access;
  const sessionOf = (account: { id: string; email: string } | undefined) => ({ user: account ? { id: account.id, email: account.email } : null });
  const LOGIN_FAILED = '邮箱或密码不正确';
  // `release` is what the MCP handshake and the App declare; `version` stays as
  // the bare product version existing monitors already read.
  app.get('/healthz', async () => ({ ok: true, service: 'cartula', version: RELEASE_VERSION, release: RELEASE, ...(BUILD ? { build: BUILD } : {}), database: store.db.prepare('SELECT 1 AS ok').get()!.ok === 1, routing: Boolean(osrm) }));
  app.get('/api/config', async () => ({ tileUrl, publicUrl, tileAttribution, styleUrl }));
  if (styleUrl) await registerBasemap(app, publicUrl, options.tileProxy);
  await registerImages(app, { proxy: options.tileProxy, fetchImpl: options.imageFetch as never, lookupImpl: options.imageLookup as never });
  if (options.tileUpstream) await registerTiles(app, options.tileUpstream, options.tileProxy);
  app.get('/api/demo', async () => DEMO_INPUT);
  app.get('/openapi.json', async () => openApiDocument(publicUrl));
  registerGuideHttp(app, publicUrl);
  registerPluginHttp(app, publicUrl);
  app.put<{ Params: { id: string } }>('/m/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = MapInputSchema.parse(request.body);
    const match = request.headers['if-match'];
    const parsed = match ? /^"?(\d+)"?$/.exec(String(match)) : null;
    if (match && !parsed) throw new DomainError(400, 'If-Match 格式错误', '使用上次读取返回的 ETag，例如 "2"。');
    const idempotencyKey = request.headers['idempotency-key'];
    if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128)) throw new DomainError(400, 'Idempotency-Key 最多 128 字符');
    const id = request.params.id;
    const principal = who(request, { mapId: id, mutation: true });
    const options = { ifMatch: parsed ? Number(parsed[1]) : undefined, idempotencyKey: idempotencyKey as string | undefined };
    // An existing map is written through its own permission check; a new one is
    // created in the space the caller proved, in its account's default space,
    // or in a fresh anonymous space whose key this response carries once.
    let result: WriteResult;
    if (store.access.mapRow(id)) {
      result = await store.put(id, input, { ...requireWrite(store, id, principal).writeAuth, ...options });
    } else {
      // Even an editable share only ever authorises the one map it names, and
      // this id is not that map — it does not exist yet.
      if (principal.preview) throw new DomainError(403, '分享令牌不能创建地图', '分享链接只授权它指向的那一张地图；用空间密钥创建，或先 POST /api/spaces 申请一个。');
      result = await store.put(id, input, { key: principal.space?.key, accountId: principal.account?.id, ...options });
    }
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${result.version}"`).send({ ...result, access: accessOf(id, principal, result) });
  });
  /** A subscriber plus the live answer to "may this socket still see this map?". */
  type Subscriber = { socket: WebSocket; access: () => MapAccess | undefined };
  const subscribers = new Map<string, Set<Subscriber>>();
  /**
   * Re-authorise on every notification. A revoked share, a logged-out session,
   * a claimed space or a deleted favorite has to stop the data immediately —
   * the socket that can no longer read is closed rather than merely skipped.
   */
  const broadcast = (id: string, message: unknown) => {
    for (const client of subscribers.get(id) ?? []) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!client.access()) { client.socket.close(1008, 'Access revoked'); continue; }
      client.socket.send(JSON.stringify(message));
    }
  };
  // A deletion is announced through the same channel as an edit, but it is not
  // one: there is no version to fetch afterwards. Every socket on that map is
  // closed by the re-authorisation inside `broadcast` before the frame is sent,
  // so this is what a client that somehow still reads would see.
  const unsubscribe = store.onChange(({ id, deleted, ...event }) => broadcast(id, deleted ? { type: 'deleted', id } : { type: 'edit', ...event }));
  const AuthFrameSchema = z.object({ type: z.literal('auth'), key: z.string().max(512).optional(), previewToken: z.string().max(512).optional() });
  app.route<{ Params: { id: string }; Querystring: { since?: string; view?: string; includeGeometry?: string; includeHistory?: string } }>({
    method: 'GET', url: '/m/:id',
    handler: async (request, reply) => {
      const id = request.params.id;
      // Permission first: a private map answers 403 before any part of it —
      // title, layers, events — is read.
      const access = requireRead(store, id, who(request, { mapId: id })).access;
      // No `since` means "since I last wrote", which on a shared map has to be
      // per-caller; see `MapStore.get`.
      const snapshot = store.get(id, request.query.since === undefined ? undefined : Number(request.query.since), access.authorId);
      const view = z.enum(['full', 'summary', 'changes', 'affected']).parse(request.query.view ?? 'full');
      const flag = (value?: string) => value === undefined ? undefined : value === 'true' || value === '1';
      const since = request.query.since === undefined ? undefined : Number(request.query.since);
      // The default full read stays the whole snapshot for backwards
      // compatibility, but carries the same delta flags as every other view.
      const body = view === 'full' && flag(request.query.includeGeometry) !== false
        ? { ...snapshot, ...deltaFlags(snapshot, since) }
        : presentMap(snapshot, view, since, { includeGeometry: flag(request.query.includeGeometry), includeHistory: flag(request.query.includeHistory) });
      return reply.header('Cache-Control', 'no-store').header('ETag', `"${snapshot.version}"`).send({ ...body, access });
    },
    wsHandler: (socket, request) => {
      const id = request.params.id;
      const fail = (error: string, code = 1008) => { socket.send(JSON.stringify({ type: 'error', error })); socket.close(code); };
      if (!store.access.mapRow(id)) { fail('地图不存在'); return; }
      // Credentials the connection carries, plus whatever an `auth` frame adds.
      const held: { key?: string; previewToken?: string; sessionToken?: string } = {
        key: bearerOf(request.headers.authorization),
        sessionToken: parseCookies(request.headers.cookie)[SESSION_COOKIE],
      };
      const access = () => {
        try { return grantFor(store, id, principalFromCredentials(store, { mapId: id, ...held })).access; } catch { return undefined; }
      };
      const clients = subscribers.get(id) ?? new Set<Subscriber>();
      const client: Subscriber = { socket, access };
      let joined = false;
      const join = () => {
        if (joined) return true;
        if (clients.size >= 50 || [...subscribers.values()].reduce((n, set) => n + set.size, 0) >= 300) { socket.close(1013, 'Too many subscribers'); return false; }
        clients.add(client); subscribers.set(id, clients); joined = true;
        return true;
      };
      const announce = () => { if (join()) socket.send(JSON.stringify({ type: 'edit', changes: [], version: store.get(id).version, actor: 'agent' })); };
      // Nothing about a private map — not even its version — before the
      // connection proves it may read; an unauthenticated socket is dropped.
      let timeout: NodeJS.Timeout | undefined;
      if (access()) announce();
      else timeout = setTimeout(() => { socket.send(JSON.stringify({ type: 'error', error: '未认证，已关闭连接' })); socket.close(1008, 'Unauthenticated'); }, 10_000);
      let messages = 0;
      const reset = setInterval(() => { messages = 0; }, 60_000);
      socket.on('message', raw => {
        try {
          if (++messages > 60) { socket.close(1008, 'Rate limited'); return; }
          const value = JSON.parse(raw.toString());
          if (value?.type === 'auth') {
            const frame = AuthFrameSchema.parse(value);
            // A bare `{type:'auth'}` is the browser asking the server to
            // confirm what the handshake already carried — a session cookie or
            // a Bearer header. Refusing it would leave a legitimately
            // authenticated page waiting for an acknowledgement that never
            // comes, so the frame is answered from the credentials in hand.
            const attempt = { ...held, ...(frame.key ? { key: frame.key } : {}), ...(frame.previewToken ? { previewToken: frame.previewToken } : {}) };
            if (!attempt.key && !attempt.previewToken && !attempt.sessionToken) {
              throw new DomainError(400, 'auth 需要 key 或 previewToken', '未登录的连接请发送 {type:"auth",key:"<spaceKey>"} 或 {type:"auth",previewToken:"..."}。');
            }
            grantFor(store, id, principalFromCredentials(store, { mapId: id, ...attempt }));
            Object.assign(held, attempt);
            if (timeout) { clearTimeout(timeout); timeout = undefined; }
            socket.send(JSON.stringify({ type: 'auth', ok: true }));
            announce();
            return;
          }
          const current = access();
          if (!current) throw new DomainError(403, '未认证，无法发送建议');
          // A share token is a read grant; suggesting is part of editing.
          if (!current.editable) throw new DomainError(403, '只读访问不能发送建议', '分享链接只能查看；编辑请向所有者索取空间密钥。');
          broadcast(id, SuggestSchema.parse(value));
        } catch (e) { socket.send(JSON.stringify({ type: 'error', error: e instanceof DomainError ? e.message : '消息格式不正确' })); }
      });
      socket.on('close', () => {
        clearInterval(reset); if (timeout) clearTimeout(timeout);
        clients.delete(client); if (!clients.size) subscribers.delete(id);
      });
    },
  });
  app.patch<{ Params: { id: string } }>('/m/:id', async (request, reply) => {
    const body = EditSchema.parse(request.body);
    const id = request.params.id;
    const principal = who(request, { mapId: id, mutation: true });
    const grant = requireWrite(store, id, principal);
    const map = await store.edit(id, grant.writeAuth, body.baseVersion, body.operations as EditOperation[], body.requestId, 'agent', body.reason);
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${map.version}"`).send({ ...presentMap(map), access: grant.access });
  });
  /**
   * "What may I do with this map?" — answerable by a read-only caller too, so
   * the UI can decide what to offer without first attempting a write. A wrong
   * credential is still refused.
   */
  app.post<{ Params: { id: string } }>('/api/maps/:id/access', async (request, reply) => {
    const id = request.params.id;
    const grant = grantFor(store, id, who(request, { mapId: id }));
    return reply.header('Cache-Control', 'no-store').send({ id: grant.map.id, version: grant.map.head, ...grant.access });
  });
  app.post<{ Params: { id: string } }>('/api/maps/:id/edit', async (request, reply) => {
    const body = EditSchema.parse(request.body);
    const id = request.params.id;
    const grant = requireWrite(store, id, who(request, { mapId: id, mutation: true }));
    const snapshot = await store.edit(id, grant.writeAuth, body.baseVersion, body.operations as EditOperation[], body.requestId);
    return reply.header('Cache-Control', 'no-store').send({ ...snapshot, access: grant.access });
  });
  app.post<{ Params: { id: string } }>('/api/maps/:id/replace', async (request, reply) => {
    const body = z.object({ baseVersion: z.number().int().positive(), map: MapInputSchema, requestId: z.string().min(1).max(128).optional() }).parse(request.body);
    const id = request.params.id;
    const grant = requireWrite(store, id, who(request, { mapId: id, mutation: true }));
    return reply.header('Cache-Control', 'no-store').send({ ...await store.replaceByUser(id, grant.writeAuth, body.baseVersion, body.map, body.requestId), access: grant.access });
  });
  app.post<{ Params: { id: string } }>('/api/maps/:id/submit', async (request, reply) => {
    // Closed set: a misspelt field here is a mistake to report, not to drop.
    const body = z.strictObject({
      baseVersion: z.number().int().nonnegative().optional(),
      /** The version the client was looking at. Reported back, never enforced. */
      currentVersion: z.number().int().positive().optional(),
      userMessage: z.string().max(2000).optional(),
      intents: z.array(IntentSchema).max(20).optional(),
      /** Declared only so it can be refused: submit records, it does not apply operations. */
      changes: z.array(z.unknown()).max(100).optional(),
      requestId: z.string().min(1).max(128).optional(),
    }, 'submit 只支持 baseVersion / currentVersion / userMessage / intents / requestId').parse(request.body ?? {});
    const id = request.params.id;
    if (body.changes?.length) {
      throw new DomainError(400, 'submit 不应用 changes 里的操作', '操作请用 PATCH /m/{id} 或 POST /api/maps/{id}/edit；submit 只记录 intents、草稿提交和交接消息。', {
        code: 'UNSUPPORTED_FIELD', field: 'changes', received: body.changes.length,
      });
    }
    const principal = who(request, { mapId: id, mutation: true });
    const grant = requireRead(store, id, principal);
    let map = store.get(id, body.baseVersion);
    const view = store.viewStatus(id, body.currentVersion);
    // Derived only from userMessage and intents, so a retry of the same logical
    // submission hashes to the same batch and de-duplicates instead of writing
    // a second draft.commit. Never add a timestamp or an id here.
    const ops = [
      ...(body.intents ?? []).map(intent => ({ op: 'intent.set' as const, scope: intent.scope, text: intent.text, layerId: intent.layerId, pointId: intent.pointId, priority: intent.priority, status: intent.status })),
      { op: 'draft.commit' as const, note: body.userMessage?.trim() || '交给 Agent 继续规划' },
    ];
    // An intent replaces whatever intent already holds its scope, so a submit
    // carrying intents is checked against the version the client was looking
    // at; `store.edit` answers a requestId replay first, so retrying a
    // submission that already landed still succeeds. A draft commit alone
    // replaces nothing and goes in against the live head.
    //
    // Without write access nothing is recorded: a read-only caller gets the
    // same handoff summary, and its intents are refused rather than applied.
    if (grant.access.editable) {
      await store.edit(id, grant.writeAuth, body.intents?.length && body.currentVersion !== undefined ? body.currentVersion : map.version, ops, body.requestId, 'user');
      // Re-read against the caller's baseVersion: the handoff summarises the
      // whole round, not only the draft.commit that closed it.
      map = store.get(id, body.baseVersion);
    }
    // A previewToken bearer is a share recipient: hand the same token back so
    // their own Agent can act on it, instead of one that only works for
    // whoever holds this space's key. Never for the owner, even one who named
    // their own map's token alongside a space key or session — see
    // `shareCredentialFor`.
    const shareCredential = shareCredentialFor(store, id, principal, grant.access);
    const message = `${planningMessage(map, body.baseVersion ?? 0, shareCredential)}${body.userMessage ? `\n用户：${body.userMessage}` : ''}`;
    return reply.header('Cache-Control', 'no-store').send({ ...presentMap(map, 'affected', body.baseVersion), ...view, message, version: map.version, access: grant.access });
  });
  /**
   * "This round reached the conversation."
   *
   * Separate from `/submit` because they answer different questions: submitting
   * records a draft commit on the map, while delivery is only known afterwards
   * — the host accepted `ui/message`, or the user copied the message. The
   * boundary moves forward only and writes no version, so it can neither
   * conflict with an edit nor be replayed into one.
   */
  app.post<{ Params: { id: string } }>('/api/maps/:id/handoff', async (request, reply) => {
    const body = z.strictObject({ version: z.number().int().nonnegative() }, 'handoff 只支持 version').parse(request.body ?? {});
    const id = request.params.id;
    const grant = requireWrite(store, id, who(request, { mapId: id, mutation: true }));
    return reply.header('Cache-Control', 'no-store').send(store.recordHandoff(id, grant.writeAuth, body.version));
  });
  app.get<{ Params: { id: string } }>('/m/:id/export.html', async (request, reply) => {
    const id = request.params.id;
    requireRead(store, id, who(request, { mapId: id }));
    const snapshot = store.get(id);
    return reply.header('Cache-Control', 'no-store').header('Content-Disposition', `attachment; filename="cartula-${snapshot.id}.html"`).type('text/html; charset=utf-8').send(await appHtml({ mode: 'offline', snapshot, release: RELEASE }));
  });
  // --- spaces, accounts, sharing -----------------------------------------
  const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const EmptySchema = z.strictObject({}, '这个接口不接受请求体字段');
  const ShareSchema = z.strictObject({ canWrite: z.boolean().optional() }, '分享接口只接受 canWrite 字段');
  const CredentialSchema = z.string().min(1).max(512);

  app.post('/api/spaces', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    EmptySchema.parse(request.body ?? {});
    const principal = who(request, { mutation: true });
    return reply.header('Cache-Control', 'no-store').send(store.createSpace(principal.account?.id));
  });

  app.get('/api/session', async (request, reply) =>
    reply.header('Cache-Control', 'no-store').send(sessionOf(who(request, { cookieOnly: true }).account)));

  app.post('/api/auth/register', authLimit, async (request, reply) => {
    assertBrowserIntent(request.headers);
    const body = z.strictObject({ email: z.string().max(320), password: z.string().max(256), passwordConfirm: z.string().max(256) }, '注册只接受 email / password / passwordConfirm').parse(request.body ?? {});
    const email = normalizeEmail(body.email);
    const password = assertPasswordStrength(body.password);
    assertPasswordConfirmed(password, body.passwordConfirm);
    // Hash before the insert so a duplicate email costs the same as a new one.
    const account = store.access.createAccount(email, await hashPassword(password));
    const token = store.access.createSession(account.id);
    return reply.header('Cache-Control', 'no-store').header('Set-Cookie', sessionCookie(token, secureCookies)).send(sessionOf(account));
  });

  app.post('/api/auth/login', authLimit, async (request, reply) => {
    assertBrowserIntent(request.headers);
    const body = z.strictObject({ email: z.string().max(320), password: z.string().max(256) }, '登录只接受 email / password').parse(request.body ?? {});
    // One message and one cost for every failure: an unknown address must not
    // answer faster, or differently, than a wrong password.
    const account = store.access.accountByEmail(body.email.trim().toLowerCase());
    if (!account) {
      await burnPasswordAttempt(body.password);
      throw new DomainError(401, LOGIN_FAILED, '检查邮箱和密码后重试。');
    }
    if (!await verifyPassword(body.password, account.password_hash)) throw new DomainError(401, LOGIN_FAILED, '检查邮箱和密码后重试。');
    const token = store.access.createSession(account.id);
    return reply.header('Cache-Control', 'no-store').header('Set-Cookie', sessionCookie(token, secureCookies)).send(sessionOf(account));
  });

  app.post('/api/auth/logout', authLimit, async (request, reply) => {
    assertBrowserIntent(request.headers);
    EmptySchema.parse(request.body ?? {});
    const cookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (cookie) store.access.revokeSession(cookie);
    return reply.header('Cache-Control', 'no-store').header('Set-Cookie', clearedSessionCookie(secureCookies)).send({ ok: true });
  });

  app.get('/api/me/api-keys', async (request, reply) => {
    const account = requireAccount(who(request, { cookieOnly: true }));
    return reply.header('Cache-Control', 'no-store').send({ keys: store.access.apiKeysOfAccount(account.id) });
  });
  app.post('/api/me/api-keys', authLimit, async (request, reply) => {
    assertBrowserIntent(request.headers);
    const body = z.strictObject({ name: z.string().max(80).optional() }, '创建 API Key 只接受 name').parse(request.body ?? {});
    const account = requireAccount(who(request, { mutation: true, cookieOnly: true }));
    return reply.header('Cache-Control', 'no-store').send(store.access.createApiKey(account.id, body.name ?? 'MCP'));
  });
  app.delete<{ Params: { id: string } }>('/api/me/api-keys/:id', async (request, reply) => {
    assertBrowserIntent(request.headers);
    const account = requireAccount(who(request, { mutation: true, cookieOnly: true }));
    if (!store.access.revokeApiKey(account.id, request.params.id)) throw new DomainError(404, 'API Key 不存在', '它可能已经停用。');
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  app.get('/api/maps', async (request, reply) => {
    const principal = who(request);
    if (!principal.account && !principal.space) throw new DomainError(403, '需要空间密钥、账号 API Key 或登录账号', '用 Authorization: Bearer <spaceKey 或 API Key>，或先登录。');
    const spaceIds = [...new Set([
      ...(principal.account ? store.access.spacesOfAccount(principal.account.id).map(space => space.id) : []),
      ...(principal.space ? [principal.space.id] : []),
    ])];
    return reply.header('Cache-Control', 'no-store').send({
      maps: store.access.summaries(store.access.mapIdsOfSpaces(spaceIds)),
      favorites: principal.account ? store.access.favorites(principal.account.id) : [],
    });
  });

  /**
   * Delete one map for good.
   *
   * Owner-only, and irreversible: the versions, the share links and every
   * favorite backed by them go with it. Subscribers are not left on a socket
   * about a map that no longer exists — the store announces the deletion, and
   * `broadcast` re-authorises each one, finds no map, and closes it.
   */
  app.delete<{ Params: { id: string } }>('/api/maps/:id', async (request, reply) => {
    const id = request.params.id;
    const grant = requireOwner(store, id, who(request, { mapId: id, mutation: true }));
    return reply.header('Cache-Control', 'no-store').send({ ok: true, ...store.delete(id, grant.writeAuth) });
  });

  /**
   * Save the whole space this map lives in to the account. One owner, decided
   * atomically: a second account claiming the same key gets a 409, and the same
   * account claiming twice gets the same answer as the first time.
   */
  app.post<{ Params: { id: string } }>('/api/maps/:id/claim', authLimit, async (request, reply) => {
    assertBrowserIntent(request.headers);
    EmptySchema.parse(request.body ?? {});
    const id = request.params.id;
    const principal = who(request, { mapId: id, mutation: true });
    const account = requireAccount(principal);
    requireOwner(store, id, principal);
    const { claimedMapCount } = store.access.claim(id, account.id);
    return reply.header('Cache-Control', 'no-store').send({ access: grantFor(store, id, principal).access, claimedMapCount });
  });

  app.post<{ Params: { id: string } }>('/api/maps/:id/preview', async (request, reply) => {
    // `canWrite` has to be asked for explicitly: an old client that still posts
    // `{}` keeps minting exactly the read-only link it means to.
    const body = ShareSchema.parse(request.body ?? {});
    const id = request.params.id;
    requireOwner(store, id, who(request, { mapId: id, mutation: true }));
    if (store.access.previewCount(id) >= 50) throw new DomainError(429, '这张地图的分享链接过多', '先停用现有分享，再生成新的链接。');
    // Each explicit share is its own token; existing links keep working until
    // the owner revokes them all.
    return reply.header('Cache-Control', 'no-store').send(store.access.createPreview(id, body.canWrite === true));
  });

  /**
   * The shares of this map that are still live. Owner-only, and tokenless: the
   * plaintext left in the response that minted each one, so this dates a link
   * and says what it may do, and never hands it out a second time.
   */
  app.get<{ Params: { id: string } }>('/api/maps/:id/preview', async (request, reply) => {
    const id = request.params.id;
    requireOwner(store, id, who(request, { mapId: id }));
    return reply.header('Cache-Control', 'no-store').send({ links: store.access.previews(id) });
  });

  app.delete<{ Params: { id: string } }>('/api/maps/:id/preview', async (request, reply) => {
    const id = request.params.id;
    requireOwner(store, id, who(request, { mapId: id, mutation: true }));
    store.access.revokePreviews(id);
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  /**
   * Revoke one share without touching the others — the difference between
   * taking back one person's link and cutting off everyone this map was ever
   * shared with. A link id that is not this map's is a 404 rather than an
   * {ok:true} that revoked nothing.
   */
  app.delete<{ Params: { id: string; linkId: string } }>('/api/maps/:id/preview/:linkId', async (request, reply) => {
    const id = request.params.id;
    requireOwner(store, id, who(request, { mapId: id, mutation: true }));
    if (!store.access.revokePreview(id, request.params.linkId)) throw new DomainError(404, '这条分享链接不存在', '它可能已经被停用了。');
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  /**
   * A favorite is a reference to a share grant, so it takes the share token —
   * an owner key proves ownership, not that the map was shared with anyone.
   */
  app.put<{ Params: { id: string } }>('/api/me/favorites/:id', async (request, reply) => {
    assertBrowserIntent(request.headers);
    EmptySchema.parse(request.body ?? {});
    const id = request.params.id;
    const principal = who(request, { mapId: id, mutation: true });
    const account = requireAccount(principal);
    if (principal.preview?.mapId !== id) throw new DomainError(403, '收藏需要有效的分享链接', '用 Authorization: Bearer <previewToken> 传入分享令牌；空间密钥不是分享授权。');
    store.access.addFavorite(account.id, id, principal.preview.token);
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/me/favorites/:id', async (request, reply) => {
    assertBrowserIntent(request.headers);
    const principal = who(request, { mutation: true, cookieOnly: true });
    // Removable even after the share was revoked — otherwise a dead entry could
    // never leave the list.
    store.access.removeFavorite(requireAccount(principal).id, request.params.id);
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/maps/:id/copy', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.strictObject({
      targetSpaceKey: CredentialSchema.optional(),
      title: z.string().max(120).optional(),
      requestId: z.string().min(1).max(128).optional(),
    }, 'copy 只支持 targetSpaceKey / title / requestId').parse(request.body ?? {});
    const id = request.params.id;
    const principal = who(request, { mapId: id, mutation: true });
    requireRead(store, id, principal);
    // Reading the source never authorises writing the copy: the destination is
    // named separately, or is the account's own space, or is brand new.
    let spaceId: string | undefined;
    if (body.targetSpaceKey) {
      const target = store.access.spaceByKey(body.targetSpaceKey);
      if (!target) throw new DomainError(403, '目标空间密钥无效', '用 POST /api/spaces 申请空间密钥，或省略 targetSpaceKey 让 Cartula 新建一个。');
      // Holding the key is the authorisation. Claiming a space gives an account
      // a second way in; it does not revoke the key, so an Agent that never logs
      // in keeps writing to the space it was given.
      spaceId = target.id;
    }
    const copied = await store.copy(id, { spaceId, accountId: spaceId ? undefined : principal.account?.id, title: body.title, requestId: body.requestId });
    const held = copied.spaceKey ? { spaceId: copied.spaceId, spaceKey: copied.spaceKey } : body.targetSpaceKey ? { spaceId, spaceKey: body.targetSpaceKey } : undefined;
    // The copy's access is the destination's question, so it is answered from
    // the credential that authorised the *write* — a share token that only ever
    // let this caller read the source says nothing about the new map.
    const destination: Principal = { account: principal.account, sessionToken: principal.sessionToken };
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${copied.version}"`).send({ ...copied, access: accessOf(copied.id, destination, held) });
  });

  await registerMcp(app, store, tileUrl, tileAttribution, styleUrl);
  if (existsSync(resolve('dist/web'))) {
    await app.register(staticPlugin, { root: resolve('dist/web'), wildcard: false, index: false });
    app.get('/', async (_req, reply) => reply.sendFile('index.html', { maxAge: 0 }));
    app.get('/app', async (_req, reply) => reply.header('Cache-Control', 'no-store').sendFile('index.html'));
    app.get('/map/:id', async (_req, reply) => reply.header('Cache-Control', 'no-store').sendFile('index.html'));
  } else {
    app.get('/', async (_request, reply) => reply.type('text/html').send('<h1>Cartula</h1><p>Run npm run build, or open the Vite development server.</p>'));
  }
  app.addHook('onClose', async () => { unsubscribe(); for (const clients of subscribers.values()) for (const client of clients) client.socket.terminate(); store.close(); });
  return { app, store };
}
