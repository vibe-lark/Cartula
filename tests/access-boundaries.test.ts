/** Independent transport-level acceptance of the capability/account boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { MapStore } from '../src/server/store.js';
import { normalizeMap } from '../src/core/model.js';
import type { MapInput, MapSnapshot, WriteResult } from '../src/core/types.js';
import type { ClaimResult, MapAccess, MapLibrary, PreviewLink, SpaceCredential } from '../src/core/access.js';

type App = Awaited<ReturnType<typeof createApp>>['app'];
type CreatedMap = WriteResult & SpaceCredential & { access: MapAccess };
const input: MapInput = { title: '不应跨越空间的行程', layers: [{ id: 'route', name: '私有路线', points: [
  { id: 'a', name: '私有地点甲', at: [126.6, 45.7] }, { id: 'b', name: '私有地点乙', at: [127, 46] },
], path: [[126.6, 45.7], [126.8, 45.85], [127, 46]] }] };
const csrf = { 'x-cartula-request': '1' };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const note = (text: string) => [{ op: 'annotate', layerId: 'route', pointId: 'a', text }];
async function create(app: App, id: string, key?: string): Promise<CreatedMap> {
  const response = await app.inject({ method: 'PUT', url: `/m/${id}`, headers: key ? bearer(key) : {}, payload: input });
  assert.equal(response.statusCode, 200, 'map creation must succeed');
  return response.json();
}
async function register(app: App, email = `${randomUUID()}@example.test`) {
  const password = `Cartula-${randomBytes(14).toString('base64url')}9aZ!`;
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf,
    payload: { email, password, passwordConfirm: password } });
  assert.ok([200, 201].includes(response.statusCode), `register status ${response.statusCode}`);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  assert.ok(cookies.some(value => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value)), 'session cookie is HttpOnly and SameSite');
  assert.ok(response.json().user?.id);
  return { cookie, password, email, user: response.json().user, headers: { ...csrf, cookie } };
}
async function share(app: App, map: CreatedMap): Promise<PreviewLink> {
  const result = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/preview`, headers: bearer(map.spaceKey), payload: {} });
  assert.equal(result.statusCode, 200);
  const link = result.json<PreviewLink>();
  assert.ok(link.previewUrl.includes('#preview='));
  assert.ok(!link.previewUrl.includes(map.spaceKey));
  return link;
}
function denied(response: { statusCode: number; body: string }, label: string) {
  assert.ok([401, 403, 404].includes(response.statusCode), `${label}: expected denial, got ${response.statusCode}`);
  for (const secret of [input.title!, '私有地点甲', '"layers"', '"events"']) {
    assert.equal(response.body.includes(secret), false, `${label}: denied responses must not disclose map content`);
  }
}

test('access: private reads, exports and writes enforce source scope across every REST view', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const a = await create(app, 'owner-a');
  assert.ok(a.spaceKey.length >= 43);
  assert.ok(a.spaceId);
  assert.equal(a.access.editable, true);
  const a2 = await create(app, 'owner-a-second', a.spaceKey);
  const b = await create(app, 'owner-b');
  assert.equal(a2.access.spaceId, a.spaceId);
  const preview = await share(app, a);
  for (const suffix of ['', '?view=summary', '?view=affected&since=0', '?view=changes&since=0', '?view=full&includeGeometry=true', '/export.html']) {
    for (const key of [undefined, b.spaceKey, `${a.spaceKey}wrong`]) {
      denied(await app.inject({ url: `/m/${a.id}${suffix}`, headers: key ? bearer(key) : {} }), `read ${suffix}`);
    }
    const allowed = await app.inject({ url: `/m/${a.id}${suffix}`, headers: bearer(preview.previewToken) });
    assert.equal(allowed.statusCode, 200, `preview read ${suffix}`);
    assert.equal(allowed.body.includes(a.spaceKey), false, `preview ${suffix}: no owner key`);
  }
  for (const [method, path, payload] of [
    ['PUT', `/m/${a.id}`, input],
    ['PATCH', `/m/${a.id}`, { baseVersion: 1, operations: note('越权修改') }],
    ['POST', `/api/maps/${a.id}/edit`, { baseVersion: 1, operations: note('越权修改') }],
    ['POST', `/api/maps/${a.id}/replace`, { baseVersion: 1, map: input }],
    ['POST', `/api/maps/${a.id}/preview`, {}],
    ['DELETE', `/api/maps/${a.id}/preview`, undefined],
  ] as const) {
    denied(await app.inject({ method, url: path, payload, headers: bearer(preview.previewToken) }), `preview ${method} ${path}`);
  }
  // Read-only submit may provide a summary, but must never apply the intents.
  const submitted = await app.inject({ method: 'POST', url: `/api/maps/${a.id}/submit`, headers: bearer(preview.previewToken), payload: {
    baseVersion: 0, currentVersion: 1, intents: [{ scope: 'map', text: '不能写入' }], requestId: 'forbidden-intent',
  } });
  assert.ok(submitted.statusCode === 200 || [401, 403].includes(submitted.statusCode));
  assert.equal(store.get(a.id).version, 1);
  denied(await app.inject({ url: '/api/maps', headers: bearer(preview.previewToken) }), 'preview cannot list the space');
  denied(await app.inject({ url: `/m/${b.id}`, headers: bearer(preview.previewToken) }), 'preview is bound to its map');
  const library = (await app.inject({ url: '/api/maps', headers: bearer(a.spaceKey) })).json<MapLibrary>();
  assert.deepEqual(library.maps.map(map => map.id).sort(), [a.id, a2.id].sort());
});

test('access: account claim is atomic, sessions obey CSRF/logout and the original Agent key survives', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const a = await create(app, 'claim-a');
  const second = await create(app, 'claim-a2', a.spaceKey);
  const users = [await register(app), await register(app)];
  const claims = await Promise.all(users.map(user => app.inject({ method: 'POST', url: `/api/maps/${a.id}/claim`, headers: { ...user.headers, ...bearer(a.spaceKey) }, payload: {} })));
  assert.deepEqual(claims.map(response => response.statusCode).sort(), [200, 409]);
  const winnerIndex = claims.findIndex(response => response.statusCode === 200);
  const owner = users[winnerIndex]; const loser = users[1 - winnerIndex];
  assert.equal(claims[winnerIndex].json<ClaimResult>().claimedMapCount, 2);
  const replay = await app.inject({ method: 'POST', url: `/api/maps/${a.id}/claim`, headers: { ...owner.headers, ...bearer(a.spaceKey) }, payload: {} });
  assert.equal(replay.statusCode, 200);
  for (const id of [a.id, second.id]) {
    assert.equal((await app.inject({ url: `/m/${id}`, headers: { cookie: owner.cookie } })).statusCode, 200);
    denied(await app.inject({ url: `/m/${id}`, headers: { cookie: loser.cookie } }), 'other account');
  }
  const payload = { baseVersion: 1, operations: note('账号修改') };
  denied(await app.inject({ method: 'POST', url: `/api/maps/${a.id}/edit`, headers: { cookie: owner.cookie }, payload }), 'cookie mutation without CSRF header');
  denied(await app.inject({ method: 'POST', url: `/api/maps/${a.id}/edit`, headers: { ...owner.headers, origin: 'https://foreign.example' }, payload }), 'cross-site mutation');
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${a.id}/edit`, headers: owner.headers, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `/m/${a.id}`, headers: bearer(a.spaceKey), payload: { baseVersion: 2, operations: note('Agent 接着修改') } })).statusCode, 200);
  const latest = await create(app, 'agent-after-claim', a.spaceKey);
  assert.equal((await app.inject({ url: `/m/${latest.id}`, headers: owner.headers })).statusCode, 200);
  denied(await app.inject({ url: `/m/${a.id}`, headers: { cookie: owner.cookie, ...bearer('csk_invalid') } }), 'invalid explicit key cannot fall back to account');
  const foreign = await create(app, 'claim-unrelated-space');
  const foreignPreview = await share(app, foreign);
  for (const key of [foreign.spaceKey, foreignPreview.previewToken]) {
    denied(await app.inject({ url: `/m/${a.id}`, headers: { cookie: owner.cookie, ...bearer(key) } }), 'valid but out-of-scope explicit credential cannot fall back to account');
  }
  const ownPreview = await share(app, a);
  const limited = await app.inject({ url: `/m/${a.id}`, headers: { cookie: owner.cookie, ...bearer(ownPreview.previewToken) } });
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.json().access.kind, 'preview', 'an explicit preview remains read-only even with an owner session');
  denied(await app.inject({ method: 'POST', url: `/api/maps/${a.id}/preview`, headers: { ...owner.headers, ...bearer(ownPreview.previewToken) }, payload: {} }), 'preview cannot borrow owner cookie to reshare');
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: owner.headers, payload: {} })).statusCode, 200);
  denied(await app.inject({ url: `/m/${a.id}`, headers: { cookie: owner.cookie } }), 'revoked session cookie');
  assert.equal((await app.inject({ url: `/m/${a.id}`, headers: bearer(a.spaceKey) })).statusCode, 200);
  const duplicate = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { email: ` ${owner.email.toUpperCase()} `, password: owner.password, passwordConfirm: owner.password } });
  assert.equal(duplicate.statusCode, 409, 'email normalization cannot create a second account');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { email: owner.email, password: owner.password } });
  assert.equal(login.statusCode, 200);
  // Assert the whole database, not just a column named key_hash.
  for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const table = String(row.name).replaceAll('"', '""');
    const persisted = JSON.stringify(store.db.prepare(`SELECT * FROM "${table}"`).all());
    for (const value of [a.spaceKey, owner.password, owner.cookie.split('=')[1]]) assert.equal(persisted.includes(value), false, 'plaintext credential persisted in SQLite');
  }
});

test('access: account validation is enforced by the server and unrelated malformed cookies are harmless', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const password = 'Valid-Cartula-password-2026!';
  const payload = { email: 'validation@example.test', password, passwordConfirm: password };
  const noIntent = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
  assert.equal(noIntent.statusCode, 403, 'login/register also require browser intent');
  // Enough to catch obvious format errors without imposing an email-delivery
  // or domain-ownership check that the product deliberately does not have.
  for (const email of ['not-an-email', 'a@@example.test', '.a@example.test', 'a..b@example.test']) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { ...payload, email } });
    assert.equal(result.statusCode, 400, 'invalid email must be rejected');
  }
  for (const weak of ['Short1!', 'all-lowercase-2026!', 'ALL-UPPERCASE-2026!', 'NoNumbersHere!', 'OnlyLettersAndDigits2026']) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { ...payload, password: weak, passwordConfirm: weak } });
    assert.equal(result.statusCode, 400, 'weak passwords must be rejected without trusting the form');
  }
  const mismatch = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { ...payload, passwordConfirm: `${password}different` } });
  assert.equal(mismatch.statusCode, 400);
  const who = await app.inject({ url: '/api/session', headers: { cookie: 'unrelated=bad%zz' } });
  assert.equal(who.statusCode, 200, 'unrelated cookie parse errors must not break session lookup');
  assert.equal(who.json().user, null);
});

test('access: preview favorites expire on revocation while an idempotent copy remains independent', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const original = await create(app, 'preview-source');
  const preview = await share(app, original);
  const reader = await register(app);
  denied(await app.inject({ method: 'POST', url: `/api/maps/${original.id}/claim`, headers: { ...reader.headers, ...bearer(preview.previewToken) }, payload: {} }), 'preview cannot claim');
  const favorite = () => app.inject({ method: 'PUT', url: `/api/me/favorites/${original.id}`, headers: { ...reader.headers, ...bearer(preview.previewToken) }, payload: {} });
  assert.equal((await favorite()).statusCode, 200);
  assert.equal((await favorite()).statusCode, 200);
  const copyRequest = { method: 'POST' as const, url: `/api/maps/${original.id}/copy`, headers: { ...reader.headers, ...bearer(preview.previewToken) }, payload: { requestId: 'copy-with-lost-response' } };
  const copiedResponse = await app.inject(copyRequest);
  assert.equal(copiedResponse.statusCode, 200);
  const copy = copiedResponse.json<CreatedMap>();
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.access.editable, true);
  const editResponse = await app.inject({ method: 'POST', url: `/api/maps/${copy.id}/edit`, headers: reader.headers, payload: { baseVersion: 1, operations: note('只改副本') } });
  assert.equal(editResponse.statusCode, 200);
  assert.equal(store.get(original.id).version, 1);
  await store.edit(original.id, original.spaceKey, 1, note('原图后来改变') as Parameters<typeof store.edit>[3]);
  const replay = await app.inject(copyRequest);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, copy.id, 'retry returns the same independently edited copy');
  assert.equal(store.get(copy.id).version, 2);
  assert.equal(store.get(copy.id).layers[0].points[0].note, '只改副本');
  const library = (await app.inject({ url: '/api/maps', headers: reader.headers })).json<MapLibrary>();
  assert.equal(library.favorites.filter(map => map.id === original.id).length, 1);
  assert.equal(library.favorites[0].available, true);
  assert.equal((await app.inject({ url: `/m/${original.id}`, headers: reader.headers })).statusCode, 200, 'active favorite is a read grant');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/maps/${original.id}/preview`, headers: bearer(original.spaceKey) })).statusCode, 200);
  denied(await app.inject({ url: `/m/${original.id}`, headers: bearer(preview.previewToken) }), 'revoked preview');
  denied(await app.inject({ url: `/m/${original.id}`, headers: reader.headers }), 'revoked favorite');
  assert.equal((await app.inject({ url: `/m/${copy.id}`, headers: reader.headers })).statusCode, 200, 'copy survives source revocation');
  const expired = (await app.inject({ url: '/api/maps', headers: reader.headers })).json<MapLibrary>();
  assert.equal(expired.favorites.find(map => map.id === original.id)?.available, false);
  const privateTitle = '撤销分享后才加入的私有目的地';
  await store.put(original.id, { ...input, title: privateTitle }, { key: original.spaceKey, ifMatch: 2, idempotencyKey: 'private-after-revoke' });
  const afterPrivateChange = await app.inject({ url: '/api/maps', headers: reader.headers });
  assert.equal(afterPrivateChange.body.includes(privateTitle), false, 'revoked favorites must not read the latest private title');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/me/favorites/${original.id}`, headers: reader.headers })).statusCode, 200);
});

async function until(predicate: () => boolean, description: string) {
  const timeout = Date.now() + 3000;
  while (!predicate() && Date.now() < timeout) await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(predicate(), description);
}

test('access: anonymous copy pins its target before writing and binds requestId to the logical copy', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const original = await create(app, 'anonymous-copy-source');
  const preview = await share(app, original);
  const sourceHeaders = bearer(preview.previewToken);
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n;
  const ambiguous = await app.inject({ method: 'POST', url: `/api/maps/${original.id}/copy`, headers: sourceHeaders, payload: { requestId: 'anonymous-copy' } });
  assert.equal(ambiguous.statusCode, 400, 'cannot promise retry safety without a known target');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n, before);
  const space = await app.inject({ method: 'POST', url: '/api/spaces', payload: {} });
  assert.equal(space.statusCode, 200);
  const target = space.json<SpaceCredential>();
  const request = { method: 'POST' as const, url: `/api/maps/${original.id}/copy`, headers: sourceHeaders,
    payload: { requestId: 'anonymous-copy', targetSpaceKey: target.spaceKey, title: '我的独立副本' } };
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200);
  const copy = response.json<CreatedMap>();
  assert.equal(copy.access.spaceId, target.spaceId);
  assert.equal((await app.inject({ url: `/m/${copy.id}`, headers: bearer(target.spaceKey) })).statusCode, 200);
  denied(await app.inject({ url: `/m/${copy.id}`, headers: sourceHeaders }), 'source preview is not a grant on the copy');
  assert.equal((await app.inject(request)).json().id, copy.id);
  assert.equal((await app.inject({ ...request, payload: { ...request.payload, title: '不同的复制请求' } })).statusCode, 409);
  const nextSource = await create(app, 'other-anonymous-copy-source', original.spaceKey);
  const nextPreview = await share(app, { ...nextSource, spaceKey: original.spaceKey });
  assert.equal((await app.inject({ ...request, url: `/api/maps/${nextSource.id}/copy`, headers: bearer(nextPreview.previewToken) })).statusCode, 409);
  await app.inject({ method: 'DELETE', url: `/api/maps/${original.id}/preview`, headers: bearer(original.spaceKey) });
  denied(await app.inject(request), 'a revoked source grant cannot use a remembered requestId to retrieve a copy');
  assert.equal((await app.inject({ url: `/m/${copy.id}`, headers: bearer(target.spaceKey) })).statusCode, 200);
});

test('access: concurrent copy retries and a later source rename still resolve to exactly one copy', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const source = await create(app, 'concurrent-copy-source');
  const space = (await app.inject({ method: 'POST', url: '/api/spaces', payload: {} })).json<SpaceCredential>();
  const request = { method: 'POST' as const, url: `/api/maps/${source.id}/copy`, headers: bearer(source.spaceKey),
    payload: { targetSpaceKey: space.spaceKey, requestId: 'concurrent-copy' } };
  const results = await Promise.all([app.inject(request), app.inject(request)]);
  for (const result of results) assert.equal(result.statusCode, 200);
  assert.equal(results[0].json().id, results[1].json().id, 'simultaneous retries must not allocate two copies');
  const firstCopyId = results[0].json().id;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n, 2);
  await store.put(source.id, { ...input, title: '原图在复制成功后改名' }, { key: source.spaceKey, ifMatch: 1, idempotencyKey: 'rename-source' });
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, 'the inferred title must not change the original request fingerprint');
  assert.equal(replay.json().id, firstCopyId);
});

test('access: copy deduplication stays atomic while route preparation is waiting', async t => {
  let routeGate: Promise<void> | undefined;
  let release = () => {};
  const store = new MapStore({ path: ':memory:', publicUrl: 'http://localhost:3900', resolveRoutes: async () => {
    if (routeGate) await routeGate;
    return [];
  } });
  t.after(() => store.close());
  const source = await store.put('delayed-copy-source', input);
  const target = store.createSpace();
  routeGate = new Promise<void>(resolve => { release = resolve; });
  const args = { spaceId: target.spaceId, requestId: 'one-copy-with-delayed-routing' };
  const first = store.copy(source.id, args);
  const second = store.copy(source.id, args);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].id, results[1].id, 'both responses must name the same copy');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n, 2, 'only the source and one copy exist');
});

test('access: a claimed target space still accepts its Agent key when copying without a session', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const destination = await create(app, 'claimed-copy-target');
  const source = await create(app, 'external-copy-source');
  const owner = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${destination.id}/claim`, headers: { ...owner.headers, ...bearer(destination.spaceKey) }, payload: {} })).statusCode, 200);
  const copied = await app.inject({ method: 'POST', url: `/api/maps/${source.id}/copy`, headers: bearer(source.spaceKey),
    payload: { targetSpaceKey: destination.spaceKey, requestId: 'agent-copy-after-claim' } });
  assert.equal(copied.statusCode, 200, 'the persistent key grants access independently of login');
  assert.equal(copied.json().access.spaceId, destination.spaceId);
  assert.equal((await app.inject({ url: `/m/${copied.json().id}`, headers: owner.headers })).statusCode, 200);
});

test('access: cookie-authenticated WebSocket acknowledges bare auth and loses access after logout', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const map = await create(app, 'session-ws'); const user = await register(app);
  await app.inject({ method: 'POST', url: `/api/maps/${map.id}/claim`, headers: { ...user.headers, ...bearer(map.spaceKey) }, payload: {} });
  const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${map.id}`, { headers: { cookie: user.cookie } });
  const messages: Array<{ type: string; ok?: boolean; version?: number }> = [];
  socket.on('message', value => messages.push(JSON.parse(value.toString())));
  t.after(async () => { socket.terminate(); await app.close(); });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth' }));
  await until(() => messages.some(message => message.type === 'auth' && message.ok === true), 'session auth needs a positive acknowledgement');
  const beforeLogout = messages.length;
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: user.headers, payload: {} });
  await app.inject({ method: 'POST', url: `/api/maps/${map.id}/edit`, headers: bearer(map.spaceKey), payload: { baseVersion: 1, operations: note('注销之后的信息') } });
  await until(() => socket.readyState === WebSocket.CLOSED, 'logged-out session must stop receiving map events');
  assert.equal(messages.slice(beforeLogout).some(message => message.type === 'edit'), false);
});

test('access: a private WebSocket discloses nothing before auth and stops after preview revocation', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const map = await create(app, 'private-ws'); const preview = await share(app, map);
  const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${map.id}`);
  const messages: Array<{ type: string; version?: number; ok?: boolean; changes?: string[] }> = [];
  socket.on('message', value => messages.push(JSON.parse(value.toString())));
  t.after(async () => { socket.terminate(); await app.close(); });
  await once(socket, 'open');
  // Complete an authorized write; an unauthenticated subscriber gets no trace
  // of it, even though its TCP/WebSocket handshake was accepted.
  await app.inject({ method: 'POST', url: `/api/maps/${map.id}/edit`, headers: bearer(map.spaceKey), payload: { baseVersion: 1, operations: note('尚未认证期间') } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(messages.some(message => message.type === 'edit'), false);
  socket.send(JSON.stringify({ type: 'auth', previewToken: preview.previewToken }));
  await until(() => messages.some(message => message.type === 'edit' && message.version === 2), 'preview auth must receive current version');
  const beforeSuggestion = messages.length;
  socket.send(JSON.stringify({ type: 'suggest', text: '预览不能发送建议' }));
  await until(() => messages.length > beforeSuggestion, 'read-only suggestion must be answered');
  assert.equal(messages.slice(beforeSuggestion).some(message => message.type === 'suggest'), false);
  const beforeRevoke = messages.length;
  await app.inject({ method: 'DELETE', url: `/api/maps/${map.id}/preview`, headers: bearer(map.spaceKey) });
  await app.inject({ method: 'POST', url: `/api/maps/${map.id}/edit`, headers: bearer(map.spaceKey), payload: { baseVersion: 2, operations: note('撤销之后的私有信息') } });
  await until(() => socket.readyState === WebSocket.CLOSED, 'revoked preview socket must close');
  assert.equal(messages.slice(beforeRevoke).some(message => message.type === 'edit' || message.type === 'suggest'), false);
});

test('access: MCP hidden snapshots enforce capabilities and a preview never becomes an owner', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'access-boundary-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const advertisedShare = (await client.listTools()).tools.find(tool => tool.name === 'share_map');
  assert.deepEqual((advertisedShare?._meta?.ui as { visibility?: string[] } | undefined)?.visibility, ['model', 'app'], 'share_map must be available to the Agent instructed to call it');
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const created = await call('create_map', { id: 'mcp-private', map: input });
  assert.ok(!created.isError);
  const data = created.structuredContent as unknown as CreatedMap;
  assert.ok(data.spaceKey && data.spaceId);
  const others = await call('create_space', {});
  assert.ok(!others.isError);
  const foreign = (others.structuredContent as unknown as SpaceCredential).spaceKey;
  const retryArgs = { map: input, spaceKey: foreign, requestId: 'mcp-create-without-id' };
  const firstCreate = await call('create_map', retryArgs);
  const secondCreate = await call('create_map', retryArgs);
  assert.ok(!firstCreate.isError && !secondCreate.isError);
  assert.equal((secondCreate.structuredContent as { id: string } | undefined)?.id, (firstCreate.structuredContent as { id: string } | undefined)?.id, 'create_map requestId must also work when id is omitted');
  for (const name of ['get_map', 'get_map_state', 'subscribe_map', 'submit_changes']) {
    for (const credentials of [{}, { spaceKey: foreign }]) {
      const response = await call(name, { id: data.id, ...credentials });
      assert.equal(response.isError, true, `${name} must reject inaccessible maps`);
      assert.equal((response._meta as { cartula?: unknown } | undefined)?.cartula, undefined);
      assert.equal(JSON.stringify(response).includes('私有地点甲'), false);
    }
  }
  const shared = await call('share_map', { id: data.id, spaceKey: data.spaceKey });
  assert.ok(!shared.isError);
  const preview = shared.structuredContent as unknown as PreviewLink;
  assert.ok(preview.previewToken);
  const beforeCreation = store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n;
  for (const [label, credentials] of [
    ['as-space-key', { spaceKey: preview.previewToken }],
    ['as-target', { spaceKey: preview.previewToken, requestId: 'preview-cannot-create' }],
  ] as const) {
    const refused = await call('create_map', { id: `preview-cannot-${label}`, map: input, ...credentials });
    assert.ok(refused.isError, 'a preview is not a destination space key');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n, beforeCreation, 'rejected credentials must not leave orphan maps');
  }
  for (const name of ['get_map', 'get_map_state', 'submit_changes']) {
    const response = await call(name, { id: data.id, previewToken: preview.previewToken });
    assert.ok(!response.isError, `${name} supports read-only preview`);
    const hidden = (response._meta as { cartula?: { map?: MapSnapshot; editKey?: string; spaceKey?: string; access?: MapAccess } } | undefined)?.cartula;
    assert.equal(hidden?.map?.layers[0].path?.length, 3);
    assert.equal(hidden?.editKey, undefined);
    assert.equal(hidden?.spaceKey, undefined);
    assert.equal(hidden?.access?.editable, false);
    assert.equal(JSON.stringify(response).includes(data.spaceKey), false);
  }
  const spoofed = await call('get_map', { id: data.id, editKey: preview.previewToken });
  if (!spoofed.isError) assert.equal(((spoofed._meta as { cartula: { access: MapAccess } }).cartula.access).editable, false, 'changing parameter names never changes token scope');
  const updated = await call('patch_map', { id: data.id, spaceKey: data.spaceKey, baseVersion: 1, operations: note('合法 Agent 修改') });
  assert.ok(!updated.isError);
  assert.ok((await call('patch_map', { id: data.id, spaceKey: preview.previewToken, baseVersion: 2, operations: note('越权') })).isError);
  assert.ok((await call('share_map', { id: data.id, spaceKey: preview.previewToken })).isError);
});

test('access: legacy SQLite migrates without rewriting content, and claim closes public access', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cartula-legacy-auth-'));
  const path = join(dir, 'legacy.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(24).toString('base64url');
  const digest = createHash('sha256').update(key).digest('hex');
  const content = normalizeMap(input, undefined, 'agent');
  const payload = JSON.stringify({ ...content, id: 'old-map', version: 1, parent: null, changed: true, changes: ['旧地图'], events: [], updatedAt: '2026-09-07T00:00:00Z', url: 'http://localhost:3900/map/old-map' });
  const event = JSON.stringify({ version: 1, actor: 'agent', at: '2026-09-07T00:00:00Z', changes: ['旧地图'], operations: [{ op: 'replace' }] });
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE maps (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, head INTEGER NOT NULL, agent_version INTEGER NOT NULL); CREATE TABLE versions (map_id TEXT NOT NULL REFERENCES maps(id), version INTEGER NOT NULL, payload TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(map_id,version)); CREATE TABLE writes (map_id TEXT NOT NULL REFERENCES maps(id), request_key TEXT NOT NULL, body_hash TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(map_id,request_key));');
  old.prepare('INSERT INTO maps VALUES (?,?,1,1)').run('old-map', digest);
  old.prepare('INSERT INTO versions VALUES (?,1,?,?)').run('old-map', payload, event);
  old.prepare('INSERT INTO writes VALUES (?,?,?,1)').run('old-map', 'old-request', 'old-body-hash');
  old.close();
  let running = await createApp({ dbPath: path });
  t.after(() => running.app.close());
  assert.equal((await running.app.inject('/m/old-map')).statusCode, 200);
  const unrelated = await create(running.app, 'unrelated-to-legacy');
  denied(await running.app.inject({ url: '/m/old-map', headers: bearer(unrelated.spaceKey) }), 'an explicit wrong key must not fall back to legacy public access');
  assert.equal(running.store.db.prepare('SELECT key_hash FROM maps WHERE id=?').get('old-map')!.key_hash, digest);
  const before = running.store.db.prepare('SELECT * FROM versions WHERE map_id=?').all('old-map');
  assert.equal(before[0].payload, payload); assert.equal(before[0].event, event);
  const user = await register(running.app);
  const claim = await running.app.inject({ method: 'POST', url: '/api/maps/old-map/claim', headers: { ...user.headers, ...bearer(key) }, payload: {} });
  assert.equal(claim.statusCode, 200);
  denied(await running.app.inject('/m/old-map'), 'legacy map becomes private on claim');
  assert.equal((await running.app.inject({ url: '/m/old-map', headers: bearer(key) })).statusCode, 200);
  const accountMap = await running.app.inject({ method: 'PUT', url: '/m/same-claimed-space', headers: user.headers, payload: input });
  assert.equal(accountMap.statusCode, 200);
  assert.equal(accountMap.json().access.spaceId, claim.json().access.spaceId);
  denied(await running.app.inject({ url: '/m/same-claimed-space', headers: bearer(key) }), 'legacy edit key must not widen to sibling maps in its claimed space');
  const newMap = await create(running.app, 'new-after-migration');
  denied(await running.app.inject({ url: `/m/${newMap.id}`, headers: bearer(key) }), 'legacy key remains map-scoped');
  assert.deepEqual(running.store.db.prepare('SELECT * FROM versions WHERE map_id=?').all('old-map'), before);
  assert.deepEqual({ ...running.store.db.prepare('SELECT request_key,body_hash,version FROM writes WHERE map_id=?').get('old-map') }, { request_key: 'old-request', body_hash: 'old-body-hash', version: 1 });
  await running.app.close();
  running = await createApp({ dbPath: path });
  denied(await running.app.inject('/m/old-map'), 'migration is idempotent after restart');
  denied(await running.app.inject(`/m/${newMap.id}`), 'restart cannot label a new map legacy-public');
  assert.equal((await running.app.inject({ url: '/m/old-map', headers: bearer(key) })).statusCode, 200);
  assert.equal((await running.app.inject({ url: '/m/old-map', headers: user.headers })).statusCode, 200);
});
