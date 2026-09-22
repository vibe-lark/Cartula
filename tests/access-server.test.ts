/**
 * Server-side unit coverage for the access model: the credential primitives
 * themselves, and the routes/tools the transport-level acceptance suite in
 * `access-boundaries.test.ts` does not reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { MapStore } from '../src/server/store.js';
import { assertPasswordStrength, digest, hashPassword, normalizeEmail, parseCookies, verifyPassword } from '../src/server/auth.js';
import type { CreatedApiKey, MapAccess, MapLibrary, PreviewLink, SpaceCredential } from '../src/core/access.js';
import type { MapInput, WriteResult } from '../src/core/types.js';

type App = Awaited<ReturnType<typeof createApp>>['app'];
type Created = WriteResult & SpaceCredential & { access: MapAccess };
const input: MapInput = { title: '账号模型行程', layers: [{ id: 'route', name: '路线', points: [
  { id: 'a', name: '甲', at: [126.6, 45.7] }, { id: 'b', name: '乙', at: [127, 46] },
] }] };
const csrf = { 'x-cartula-request': '1' };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function create(app: App, id: string = randomUUID(), key?: string): Promise<Created> {
  const response = await app.inject({ method: 'PUT', url: `/m/${id}`, headers: key ? bearer(key) : {}, payload: input });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function register(app: App, email = `${randomUUID()}@example.test`) {
  const password = `Cartula-${randomBytes(12).toString('base64url')}7bZ!`;
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { email, password, passwordConfirm: password } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { email, password, cookie, headers: { ...csrf, cookie } };
}
async function share(app: App, map: { id: string; spaceKey: string }): Promise<PreviewLink> {
  const response = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/preview`, headers: bearer(map.spaceKey), payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('passwords are hashed with async scrypt, verified constant-time and bounded in concurrency', async () => {
  const password = 'Correct-Horse-Battery-2026!';
  const stored = await hashPassword(password);
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.ok(!stored.includes(password));
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword(`${password}x`, stored), false);
  assert.equal(await verifyPassword(password, await hashPassword(password)) && stored !== await hashPassword(password), true, 'each hash gets its own salt');
  assert.equal(await verifyPassword(password, 'not-a-stored-hash'), false);

  // The cost is paid on the thread pool, not on the event loop: a timer set
  // while two hashes are in flight still fires before they finish.
  let ticked = false;
  const inFlight = Promise.all([hashPassword(password), hashPassword(password)]);
  setTimeout(() => { ticked = true; }, 5);
  await inFlight;
  assert.equal(ticked, true, 'scrypt must not block the event loop');

  // Past the queue limit the answer is "busy", not an unbounded memory pile-up.
  const flood = await Promise.allSettled(Array.from({ length: 24 }, () => hashPassword(password)));
  const refused = flood.filter(result => result.status === 'rejected');
  assert.ok(refused.length > 0, 'a login flood must be shed rather than queued forever');
  assert.equal((refused[0] as PromiseRejectedResult).reason.statusCode, 503);
  // And the limiter recovers: nothing is left holding a slot.
  assert.equal(await verifyPassword(password, stored), true);
});

test('email and password rules are enforced server-side, and cookie parsing survives junk', async () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  for (const bad of ['', 'nope', 'a@b', 'a@@b.c', '.a@b.c', 'a.@b.c', 'a..b@c.d', `${'x'.repeat(250)}@example.com`, 'a b@example.com']) {
    assert.throws(() => normalizeEmail(bad), /邮箱/, JSON.stringify(bad));
  }
  for (const weak of ['short1A!', 'nouppercase-2026!', 'NOLOWERCASE-2026!', 'NoDigitsHere!!', 'NoSymbols20260101', 'x'.repeat(129)]) {
    assert.throws(() => assertPasswordStrength(weak), /密码/, JSON.stringify(weak));
  }
  assert.equal(assertPasswordStrength('Cartula-2026-Access!'), 'Cartula-2026-Access!');
  // The server enforces exactly the rule the form states — no hidden extra
  // condition that would refuse a password the form had just accepted.
  assert.equal(assertPasswordStrength(' LeadingSpace1! '), ' LeadingSpace1! ');
  assert.deepEqual(parseCookies('a=1; cartula_session=tok%20en; broken'), { a: '1', cartula_session: 'tok en' });
  assert.deepEqual(parseCookies('bad=%zz'), { bad: '%zz' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('login failures are indistinguishable and a revoked or expired session grants nothing', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const user = await register(app);
  const map = await create(app);
  const login = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload });

  const unknown = await login({ email: `${randomUUID()}@example.test`, password: user.password });
  const wrong = await login({ email: user.email, password: `${user.password}x` });
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.json().error, wrong.json().error, 'one message for every login failure');
  assert.equal(unknown.headers['set-cookie'], undefined, 'a failed login establishes nothing');
  assert.equal((await login({ email: ` ${user.email.toUpperCase()} `, password: user.password })).statusCode, 200, 'email is normalized on login too');
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } })).statusCode, 403, 'login needs browser intent');

  // Claim the space so the cookie is the credential under test.
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/claim`, headers: { ...user.headers, ...bearer(map.spaceKey) }, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: { cookie: user.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: user.cookie } })).json().user.email, user.email);

  // Expire it in place: the store re-reads the row on every use.
  store.db.prepare(`UPDATE sessions SET expires_at='2020-01-01T00:00:00.000Z'`).run();
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: user.cookie } })).json().user, null);
  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: { cookie: user.cookie } })).statusCode, 403);
  const token = parseCookies(user.cookie).cartula_session;
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?').get(digest(token))!.n), 0, 'an expired session is cleaned up when it is used');
  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: bearer(map.spaceKey) })).statusCode, 200, 'the Agent key still works');
});

test('space allocation follows the caller: anonymous, account default, and never a caller-invented key', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const anonymous = (await app.inject({ method: 'POST', url: '/api/spaces', payload: {} })).json<SpaceCredential>();
  assert.equal(anonymous.claimed, false);
  assert.match(anonymous.spaceKey, /^csk_/);
  assert.ok(anonymous.spaceKey.length >= 40);

  const user = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/spaces', headers: { cookie: user.cookie }, payload: {} })).statusCode, 403, 'a cookie-bearing mutation needs the header');
  const owned = (await app.inject({ method: 'POST', url: '/api/spaces', headers: user.headers, payload: {} })).json<SpaceCredential>();
  assert.equal(owned.claimed, true);

  // A keyless create by a logged-in caller lands in that account's own space,
  // and is readable by the cookie alone.
  const mine = await app.inject({ method: 'PUT', url: `/m/${randomUUID()}`, headers: user.headers, payload: input });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal(mine.json().access.spaceId, owned.spaceId);
  assert.equal(mine.json().spaceKey, undefined, 'no new key is minted for an account that already has a space');
  assert.equal(mine.json().access.claimed, true);
  assert.equal(mine.json().access.canClaim, false, 'an already-claimed space has nothing left to claim');
  assert.equal((await app.inject({ url: `/m/${mine.json().id}`, headers: { cookie: user.cookie } })).statusCode, 200);

  // An unknown bearer is a mistake, not a licence to mint a space under it.
  const invented = `csk_${randomBytes(32).toString('base64url')}`;
  const before = Number(store.db.prepare('SELECT COUNT(*) AS n FROM spaces').get()!.n);
  assert.equal((await app.inject({ method: 'PUT', url: '/m/invented-key', headers: bearer(invented), payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/m/invented-key', headers: bearer('short'), payload: input })).statusCode, 403);
  assert.equal(store.access.mapRow('invented-key'), undefined, 'a refused create writes nothing');
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM spaces').get()!.n), before);

  // A share token cannot create either.
  const map = await create(app, undefined, anonymous.spaceKey);
  const preview = await share(app, { id: map.id, spaceKey: anonymous.spaceKey });
  assert.equal((await app.inject({ method: 'PUT', url: '/m/preview-created', headers: bearer(preview.previewToken), payload: input })).statusCode, 403);
  assert.equal(store.access.mapRow('preview-created'), undefined);
});

test('the access endpoint answers for every kind of caller without leaking the others', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const owner = await create(app);
  await create(app, undefined, owner.spaceKey);
  const preview = await share(app, owner);
  const ask = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/maps/${owner.id}/access`, headers, payload: {} });

  const asOwner = (await ask(bearer(owner.spaceKey))).json();
  assert.equal(asOwner.kind, 'owner');
  assert.equal(asOwner.editable, true);
  assert.equal(asOwner.canShare, true);
  assert.equal(asOwner.canClaim, true);
  assert.equal(asOwner.claimed, false);
  assert.equal(asOwner.spaceId, owner.spaceId);
  assert.equal(asOwner.spaceMapCount, 2, 'the owner sees how many maps a claim would cover');
  assert.equal(asOwner.version, 1);

  const asPreview = (await ask(bearer(preview.previewToken))).json();
  assert.equal(asPreview.kind, 'preview');
  assert.equal(asPreview.editable, false);
  assert.equal(asPreview.canShare, false);
  assert.equal(asPreview.canClaim, false);
  assert.equal(asPreview.spaceId, undefined, 'a preview is never told which space it is looking at');
  assert.equal(asPreview.spaceMapCount, undefined);

  assert.equal((await ask({})).statusCode, 403);
  assert.equal((await ask(bearer(`${owner.spaceKey}x`))).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/missing-map/access', headers: bearer(owner.spaceKey), payload: {} })).statusCode, 404);

  // Claiming needs both halves, and a preview is neither of them.
  const user = await register(app);
  const claim = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/maps/${owner.id}/claim`, headers, payload: {} });
  assert.equal((await claim({ ...user.headers, ...bearer(preview.previewToken) })).statusCode, 403);
  assert.equal((await claim(bearer(owner.spaceKey))).statusCode, 403, 'claiming always requires the browser-intent header');
  assert.equal((await claim({ ...csrf, ...bearer(owner.spaceKey) })).statusCode, 401, 'claiming without an account is not possible');
  assert.equal((await claim({ cookie: user.cookie, ...bearer(owner.spaceKey) })).statusCode, 403, 'claiming needs the browser-intent header');
  const claimed = await claim({ ...user.headers, ...bearer(owner.spaceKey) });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.equal(claimed.json().claimedMapCount, 2);
  assert.equal(claimed.json().access.claimed, true);
  assert.equal(claimed.json().access.canClaim, false);
});

test('sharing mints independent tokens, revocation is wholesale, and favorites follow the grant', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const owner = await create(app);
  const first = await share(app, owner);
  const second = await share(app, owner);
  assert.notEqual(first.previewToken, second.previewToken, 'each explicit share is its own token');
  assert.ok(first.previewUrl.includes(`#preview=${encodeURIComponent(first.previewToken)}`));
  for (const link of [first, second]) assert.equal((await app.inject({ url: `/m/${owner.id}`, headers: bearer(link.previewToken) })).statusCode, 200);

  const reader = await register(app);
  const favorite = (headers: Record<string, string>) => app.inject({ method: 'PUT', url: `/api/me/favorites/${owner.id}`, headers, payload: {} });
  assert.equal((await favorite({ ...reader.headers, ...bearer(owner.spaceKey) })).statusCode, 403, 'an owner key is not a share grant');
  assert.equal((await favorite(bearer(first.previewToken))).statusCode, 403, 'favorites always require the browser-intent header');
  assert.equal((await favorite({ ...csrf, ...bearer(first.previewToken) })).statusCode, 401, 'favorites need an account');
  assert.equal((await favorite({ cookie: reader.cookie, ...bearer(first.previewToken) })).statusCode, 403, 'and the browser-intent header');
  assert.equal((await favorite({ ...reader.headers, ...bearer(first.previewToken) })).statusCode, 200);
  assert.equal((await favorite({ ...reader.headers, ...bearer(second.previewToken) })).statusCode, 200, 'favoriting twice is idempotent');

  const library = (await app.inject({ url: '/api/maps', headers: reader.headers })).json<MapLibrary>();
  assert.deepEqual(library.maps, [], 'a reader with no space of its own owns nothing');
  assert.equal(library.favorites.length, 1);
  assert.equal(library.favorites[0].available, true);
  assert.equal(library.favorites[0].title, input.title);
  assert.ok(library.favorites[0].url.endsWith(`/map/${owner.id}`), 'a favorite opens through the account, not through a token in the URL');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/maps/${owner.id}/preview`, headers: bearer(owner.spaceKey) })).statusCode, 200);
  for (const link of [first, second]) assert.equal((await app.inject({ url: `/m/${owner.id}`, headers: bearer(link.previewToken) })).statusCode, 403, 'revocation covers every share');
  assert.equal((await app.inject({ url: `/m/${owner.id}`, headers: reader.headers })).statusCode, 403);
  const stale = (await app.inject({ url: '/api/maps', headers: reader.headers })).json<MapLibrary>();
  assert.equal(stale.favorites[0].available, false);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/me/favorites/${owner.id}`, headers: { ...reader.headers, ...bearer(first.previewToken) } })).statusCode, 200, 'a dead favorite can still be removed');
  assert.deepEqual((await app.inject({ url: '/api/maps', headers: reader.headers })).json<MapLibrary>().favorites, []);
});

test('the owner can see which shares are still live, and stop one without stopping the rest', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const owner = await create(app);
  const list = async (headers: Record<string, string>) => app.inject({ url: `/api/maps/${owner.id}/preview`, headers });
  assert.deepEqual((await list(bearer(owner.spaceKey))).json().links, [], 'a map nobody has shared lists nothing');

  const readOnly = await share(app, owner);
  const writable = (await app.inject({ method: 'POST', url: `/api/maps/${owner.id}/preview`, headers: bearer(owner.spaceKey), payload: { canWrite: true } })).json<PreviewLink>();
  const links = (await list(bearer(owner.spaceKey))).json().links as Array<{ id: string; createdAt: string; canWrite: boolean }>;
  assert.equal(links.length, 2);
  assert.deepEqual([...links].map(link => link.id).sort(), [readOnly.id, writable.id].sort(), 'the mint answers with the id the list reports');
  assert.equal(links.find(link => link.id === writable.id)!.canWrite, true);
  assert.equal(links.find(link => link.id === readOnly.id)!.canWrite, false);
  assert.ok(links.every(link => Date.parse(link.createdAt) > 0));
  // The tokens are not recoverable — only their digests were kept — so nothing
  // in a listing may resemble one.
  assert.ok(!JSON.stringify(links).includes(readOnly.previewToken));
  assert.ok(!JSON.stringify(links).includes(writable.previewToken));

  // Listing is owner-only: a share token may read the map it names, never the
  // list of everyone else holding one.
  assert.equal((await list(bearer(readOnly.previewToken))).statusCode, 403);
  const stranger = await create(app);
  assert.equal((await list(bearer(stranger.spaceKey))).statusCode, 403);

  const revoke = (id: string, key: string) => app.inject({ method: 'DELETE', url: `/api/maps/${owner.id}/preview/${id}`, headers: bearer(key) });
  assert.equal((await revoke(readOnly.id, stranger.spaceKey)).statusCode, 403, 'another space cannot close this map\'s doors');
  assert.equal((await revoke(readOnly.id, owner.spaceKey)).statusCode, 200);
  assert.equal((await revoke(readOnly.id, owner.spaceKey)).statusCode, 404, 'a link that is already gone is not silently revoked again');
  assert.equal((await revoke('sh_never-existed', owner.spaceKey)).statusCode, 404);

  assert.equal((await app.inject({ url: `/m/${owner.id}`, headers: bearer(readOnly.previewToken) })).statusCode, 403, 'the revoked one stops reading');
  assert.equal((await app.inject({ url: `/m/${owner.id}`, headers: bearer(writable.previewToken) })).statusCode, 200, 'and the other one is untouched');
  assert.deepEqual((await list(bearer(owner.spaceKey))).json().links.map((link: { id: string }) => link.id), [writable.id]);
});

test('the library needs a credential and never mixes two spaces together', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const a = await create(app);
  const a2 = await create(app, undefined, a.spaceKey);
  const b = await create(app);
  assert.equal((await app.inject('/api/maps')).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/maps', headers: bearer('csk_nope') })).statusCode, 403);
  const listed = (await app.inject({ url: '/api/maps', headers: bearer(a.spaceKey) })).json<MapLibrary>();
  assert.deepEqual(listed.maps.map(map => map.id).sort(), [a.id, a2.id].sort());
  assert.deepEqual(listed.favorites, []);
  assert.equal(listed.maps.every(map => map.title === input.title && map.version === 1), true);
  assert.equal((await app.inject({ url: '/api/maps', headers: bearer(b.spaceKey) })).json<MapLibrary>().maps.length, 1);
});

test('a WebSocket authenticated by cookie stops the moment the session is revoked', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const map = await create(app);
  const user = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/claim`, headers: { ...user.headers, ...bearer(map.spaceKey) }, payload: {} })).statusCode, 200);
  const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${map.id}`, { headers: { cookie: user.cookie } });
  const frames: Array<{ type: string; version?: number }> = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  t.after(async () => { socket.terminate(); await app.close(); });
  await once(socket, 'open');
  const settle = async () => { for (let i = 0; i < 100 && !frames.length; i += 1) await new Promise(resolve => setTimeout(resolve, 15)); };
  await settle();
  assert.equal(frames[0]?.type, 'edit', 'a cookie that owns the map subscribes immediately');

  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: user.headers, payload: {} })).statusCode, 200);
  const seen = frames.length;
  await store.edit(map.id, map.spaceKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '注销之后的私密改动' }]);
  for (let i = 0; i < 100 && socket.readyState !== WebSocket.CLOSED; i += 1) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(socket.readyState, WebSocket.CLOSED, 'a logged-out socket is closed, not merely skipped');
  assert.equal(frames.slice(seen).some(frame => frame.type === 'edit'), false);
});

test('a bare auth frame is answered from the credentials the handshake already carried', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const map = await create(app);
  const user = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/claim`, headers: { ...user.headers, ...bearer(map.spaceKey) }, payload: {} })).statusCode, 200);
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.close(); });
  const open = async (headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${map.id}`, { headers });
    sockets.push(socket);
    const frames: Array<{ type: string; ok?: boolean; error?: string }> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'auth' }));
    // An already-authorised handshake also sends its initial `edit` frame, so
    // wait for the answer to this frame rather than for any traffic at all.
    const answered = () => frames.some(frame => frame.type === 'auth' || frame.type === 'error');
    for (let i = 0; i < 100 && !answered(); i += 1) await new Promise(resolve => setTimeout(resolve, 15));
    return frames;
  };
  // The browser sends `{type:'auth'}` to have the server confirm the cookie the
  // handshake already carried; refusing it leaves an authenticated page waiting
  // forever for an acknowledgement.
  const bySession = await open({ cookie: user.cookie });
  assert.ok(bySession.some(frame => frame.type === 'auth' && frame.ok === true), 'a session handshake must be acknowledged');
  const byBearer = await open(bearer(map.spaceKey));
  assert.ok(byBearer.some(frame => frame.type === 'auth' && frame.ok === true), 'so must a bearer handshake');
  // With nothing to confirm it is still an error, and still discloses nothing.
  const anonymous = await open();
  assert.equal(anonymous.some(frame => frame.type === 'auth' && frame.ok), false);
  assert.equal(anonymous.some(frame => frame.type === 'edit'), false, 'an unauthenticated socket gets no map data');
  assert.equal(anonymous[0]?.type, 'error');
});

test('share retry receipts survive restart without storing tokens or reviving revoked links', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cartula-share-retry-'));
  const path = join(dir, 'db.sqlite');
  let store = new MapStore({ path, publicUrl: 'https://cartula.test' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const map = await store.create(input);
  const link = store.access.createPreview(map.id, false, 'share-retry');
  assert.deepEqual(store.access.createPreview(map.id, false, 'share-retry'), link);
  assert.equal(store.access.previewCount(map.id), 1);
  assert.throws(() => store.access.createPreview(map.id, true, 'share-retry'), /不同权限/);
  for (const table of ['previews', 'preview_requests']) {
    assert.ok(!JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes(link.previewToken));
  }
  // A retry must still succeed when the live-share limit has been reached.
  for (let i = 0; i < 49; i++) store.access.createPreview(map.id);
  assert.deepEqual(store.access.createPreview(map.id, false, 'share-retry'), link);
  assert.throws(() => store.access.createPreview(map.id, false, 'another'), /过多/);
  store.close();
  store = new MapStore({ path, publicUrl: 'https://cartula.test' });
  assert.throws(() => store.access.createPreview(map.id, false, 'share-retry'), /已生成，未重复创建/);
  assert.equal(store.access.previewCount(map.id), 50);
  store.access.revokePreview(map.id, link.id);
  assert.throws(() => store.access.createPreview(map.id, false, 'share-retry'), /已停用/);
  assert.equal(store.access.previewCount(map.id), 49);
  store.delete(map.id, map.spaceKey);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM preview_requests').get()!.n, 0);
});

test('MCP share retries return one link and still require ownership', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'share-retry-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const map = await create(app);
  const args = { id: map.id, spaceKey: map.spaceKey, requestId: 'lost-response' };
  const first = await client.callTool({ name: 'share_map', arguments: args });
  assert.ok(!first.isError);
  const replay = await client.callTool({ name: 'share_map', arguments: args });
  assert.deepEqual(replay.structuredContent, first.structuredContent);
  assert.equal(store.access.previewCount(map.id), 1);
  const denied = await client.callTool({ name: 'share_map', arguments: { id: map.id, requestId: args.requestId } });
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify(denied).includes((first.structuredContent as unknown as PreviewLink).previewToken));
});

test('copy de-duplication is durable and atomic, not an in-memory lock', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cartula-copy-atomic-'));
  const path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A resolver that stalls widens the window between "have I copied this yet?"
  // and the write itself — the window in which retries used to allocate a copy
  // each.
  let gate: Promise<void> | undefined;
  let release = () => {};
  let store = new MapStore({ path, publicUrl: 'http://localhost:3900', resolveRoutes: async () => { if (gate) await gate; return []; } });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const source = await store.put('atomic-source', input);
  const target = store.createSpace();
  const args = { spaceId: target.spaceId, requestId: 'stalled-resolver' };
  const maps = () => Number(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n);

  gate = new Promise<void>(resolve => { release = resolve; });
  const inflight = [store.copy(source.id, args), store.copy(source.id, args), store.copy(source.id, args)];
  release();
  const copies = await Promise.all(inflight);
  gate = undefined;
  assert.equal(new Set(copies.map(copy => copy.id)).size, 1, 'a stalled resolver must not let retries each allocate a copy');
  assert.equal(maps(), 2, 'only the source and one copy exist');

  // Durability: the reservation is committed with the map, so a process that
  // dies immediately after the copy still recognises the retry. Reopening the
  // database is the same thing a restart does.
  const reserved = store.db.prepare('SELECT request_key, map_id FROM minted').all();
  store.close();
  store = new MapStore({ path, publicUrl: 'http://localhost:3900' });
  assert.deepEqual(store.db.prepare('SELECT request_key, map_id FROM minted').all(), reserved, 'the reservation outlives the process');
  assert.equal((await store.copy(source.id, args)).id, copies[0].id, 'a retry after a restart is still one copy');
  assert.equal(maps(), 2);

  // The two rows are written together or not at all: a reservation pointing at
  // a rolled-back map is exactly the corruption the transaction rules out.
  assert.deepEqual(store.db.prepare('SELECT request_key FROM minted t LEFT JOIN maps m ON m.id=t.map_id WHERE m.id IS NULL').all(), []);
});

test('a wrong credential presented beside a right one is refused, not absorbed', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'multi-credential-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const spaceA = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  const spaceB = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  const mapA = (await call('create_map', { map: input, spaceKey: spaceA.spaceKey })).structuredContent as unknown as Created;
  const mapB = (await call('create_map', { map: input, spaceKey: spaceB.spaceKey })).structuredContent as unknown as Created;
  const shareA = (await call('share_map', { id: mapA.id, spaceKey: spaceA.spaceKey })).structuredContent as unknown as PreviewLink;
  const shareB = (await call('share_map', { id: mapB.id, spaceKey: spaceB.spaceKey })).structuredContent as unknown as PreviewLink;
  const ops = [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '越权' }];

  // Two real credentials for different spaces in one call. Merging them and
  // letting the last one win would make the argument order decide whether the
  // wrong key was noticed — and would let a correct key vouch for it.
  for (const [label, args] of [
    ['wrong key first', { spaceKey: spaceB.spaceKey, editKey: spaceA.spaceKey }],
    ['wrong key last', { spaceKey: spaceA.spaceKey, editKey: spaceB.spaceKey }],
    ['right preview, wrong key', { previewToken: shareA.previewToken, spaceKey: spaceB.spaceKey }],
    ['wrong preview, right key', { previewToken: shareB.previewToken, spaceKey: spaceA.spaceKey }],
  ] as const) {
    const read = await call('get_map', { id: mapA.id, ...args });
    assert.equal(read.isError, true, `get_map must refuse: ${label}`);
    assert.equal(JSON.stringify(read).includes(input.title!), false, `${label} discloses nothing`);
    assert.equal((read._meta as { cartula?: unknown } | undefined)?.cartula, undefined);
    assert.equal((await call('submit_changes', { id: mapA.id, ...args })).isError, true, `submit_changes must refuse: ${label}`);
  }
  // The write tools take keys but no share token, so the pairing to check there
  // is two keys — one of which is for the wrong space.
  for (const [label, args] of [
    ['wrong key first', { spaceKey: spaceB.spaceKey, editKey: spaceA.spaceKey }],
    ['wrong key last', { spaceKey: spaceA.spaceKey, editKey: spaceB.spaceKey }],
  ] as const) {
    assert.equal((await call('patch_map', { id: mapA.id, baseVersion: 1, operations: ops, ...args })).isError, true, `patch_map must refuse: ${label}`);
    assert.equal((await call('share_map', { id: mapA.id, ...args })).isError, true, `share_map must refuse: ${label}`);
  }
  // The same credentials on their own still work exactly as before.
  assert.ok(!(await call('get_map', { id: mapA.id, spaceKey: spaceA.spaceKey })).isError);
  assert.ok(!(await call('get_map', { id: mapA.id, previewToken: shareA.previewToken })).isError);
  const both = await call('get_map', { id: mapA.id, previewToken: shareA.previewToken, spaceKey: spaceA.spaceKey });
  assert.ok(!both.isError, 'two credentials for the same map are fine');
  // Naming a share token says how this request wants to be read, and every
  // owner path honours it — not just the account one. Two owner paths
  // disagreeing about it is how a rule stated once becomes untrue in half the
  // cases that reach it.
  assert.equal((both.structuredContent as { access: MapAccess }).access.kind, 'preview', 'an explicit share token stays read-only beside a space key too');
  assert.equal((both._meta as { cartula?: { spaceKey?: string } } | undefined)?.cartula?.spaceKey, undefined, 'and the card is handed the share token, not the key');
  assert.ok(!(await call('copy_map', { id: mapA.id, previewToken: shareA.previewToken, targetSpaceKey: spaceB.spaceKey })).isError, 'a separate destination key is not an out-of-scope source credential');

  // The WebSocket auth frame resolves credentials the same way.
  const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${mapA.id}`);
  const frames: Array<{ type: string; ok?: boolean }> = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', previewToken: shareB.previewToken, key: spaceA.spaceKey }));
  for (let i = 0; i < 100 && !frames.some(frame => frame.type === 'auth' || frame.type === 'error'); i += 1) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(frames.some(frame => frame.type === 'auth' && frame.ok), false, 'a wrong share token is not rescued by a valid key');
  assert.equal(frames.some(frame => frame.type === 'edit'), false, 'and no map data is sent');
});

test('an explicit credential decides the scope, and a session never widens it', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const mine = await create(app);
  const user = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${mine.id}/claim`, headers: { ...user.headers, ...bearer(mine.spaceKey) }, payload: {} })).statusCode, 200);
  // The cookie alone opens the account's own map.
  assert.equal((await app.inject({ url: `/m/${mine.id}`, headers: { cookie: user.cookie } })).statusCode, 200);

  // A valid credential that authorises something *else* must read as "no access
  // here" rather than falling back to the account that is also logged in — and
  // that holds for every mutation route, not only the read.
  const stranger = await create(app);
  const strangerShare = await share(app, stranger);
  const ops = { baseVersion: 1, operations: [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '越权写入' }] };
  const mutations = (headers: Record<string, string>) => [
    app.inject({ method: 'POST', url: `/api/maps/${mine.id}/edit`, headers, payload: ops }),
    app.inject({ method: 'PATCH', url: `/m/${mine.id}`, headers, payload: ops }),
    app.inject({ method: 'PUT', url: `/m/${mine.id}`, headers, payload: { ...input, title: '覆盖' } }),
    app.inject({ method: 'POST', url: `/api/maps/${mine.id}/replace`, headers, payload: { baseVersion: 1, map: input } }),
    app.inject({ method: 'POST', url: `/api/maps/${mine.id}/preview`, headers, payload: {} }),
    app.inject({ method: 'DELETE', url: `/api/maps/${mine.id}/preview`, headers }),
    app.inject({ method: 'POST', url: `/api/maps/${mine.id}/claim`, headers, payload: {} }),
  ];
  for (const key of [stranger.spaceKey, strangerShare.previewToken]) {
    const headers = { ...user.headers, ...bearer(key) };
    const response = await app.inject({ url: `/m/${mine.id}`, headers });
    assert.equal(response.statusCode, 403, 'an out-of-scope credential cannot borrow the session');
    assert.equal(response.body.includes(input.title!), false);
    for (const result of await Promise.all(mutations(headers))) {
      assert.equal(result.statusCode, 403, `an out-of-scope credential cannot write either: ${result.body}`);
    }
  }
  assert.equal(store.get(mine.id).version, 1, 'and none of that wrote anything');

  // An explicit share token of one's own map stays read-only: naming a weaker
  // credential is a choice the server honours, not one it silently upgrades.
  const ownShare = await share(app, mine);
  const limited = await app.inject({ url: `/m/${mine.id}`, headers: { cookie: user.cookie, ...bearer(ownShare.previewToken) } });
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.json().access.kind, 'preview');
  assert.equal(limited.json().access.editable, false);
  for (const result of await Promise.all(mutations({ ...user.headers, ...bearer(ownShare.previewToken) }))) {
    assert.equal(result.statusCode, 403, `a named preview cannot borrow the owner cookie: ${result.body}`);
  }
  // submit answers a read-only caller with a summary, but records nothing.
  const submitted = await app.inject({ method: 'POST', url: `/api/maps/${mine.id}/submit`, headers: { ...user.headers, ...bearer(ownShare.previewToken) }, payload: { intents: [{ scope: 'map', text: '预览不该写入的意图' }], currentVersion: 1 } });
  assert.equal(submitted.json().access.kind, 'preview');
  assert.equal(store.get(mine.id).version, 1, 'a preview submit records no intent');
  assert.deepEqual(store.get(mine.id).intents ?? [], []);

  // The cookie alone still does everything it should: scoping narrows only when
  // the caller actually named a credential.
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${mine.id}/edit`, headers: user.headers, payload: ops })).statusCode, 200);

  // Copying through a share token still lands in the reader's own account: the
  // source credential scopes the read, not the destination write.
  const reader = await register(app);
  const copied = await app.inject({ method: 'POST', url: `/api/maps/${stranger.id}/copy`, headers: { ...reader.headers, ...bearer(strangerShare.previewToken) }, payload: {} });
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal(copied.json().access.editable, true, 'the copy belongs to the account that made it');
  assert.equal((await app.inject({ url: `/m/${copied.json().id}`, headers: { cookie: reader.cookie } })).statusCode, 200);
});

test('MCP space tools scope to their own credentials and copy never carries the source grant', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'access-server-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  const space = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  assert.match(space.spaceKey, /^csk_/);
  assert.equal(space.claimed, false);
  const first = (await call('create_map', { map: input, spaceKey: space.spaceKey })).structuredContent as unknown as Created;
  const second = (await call('create_map', { map: { ...input, title: '同空间第二张' }, spaceKey: space.spaceKey })).structuredContent as unknown as Created;
  assert.equal(first.spaceKey, undefined, 'reusing a space key does not re-mint it');
  assert.equal(first.access.spaceId, space.spaceId);

  const listed = (await call('list_maps', { spaceKey: space.spaceKey })).structuredContent as unknown as { spaceId: string; maps: Array<{ id: string; title: string }> };
  assert.equal(listed.spaceId, space.spaceId);
  assert.deepEqual(listed.maps.map(map => map.id).sort(), [first.id, second.id].sort());
  assert.ok((await call('list_maps', { spaceKey: `csk_${randomBytes(32).toString('base64url')}` })).isError);
  const invented = await call('create_map', { map: input, spaceKey: `csk_${randomBytes(32).toString('base64url')}` });
  assert.ok(invented.isError, 'a model-invented space key is refused, not adopted');

  // Copy: the source grant reads, the target key writes, and the two never merge.
  const preview = (await call('share_map', { id: first.id, spaceKey: space.spaceKey })).structuredContent as unknown as PreviewLink;
  const target = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  const copied = await call('copy_map', { id: first.id, previewToken: preview.previewToken, targetSpaceKey: target.spaceKey, title: '我的副本', requestId: 'copy-1' });
  assert.ok(!copied.isError, JSON.stringify(copied.content));
  const copy = copied.structuredContent as unknown as Created;
  assert.notEqual(copy.id, first.id);
  assert.equal(copy.access.spaceId, target.spaceId);
  assert.equal(copy.title, '我的副本');
  const replayed = (await call('copy_map', { id: first.id, previewToken: preview.previewToken, targetSpaceKey: target.spaceKey, title: '我的副本', requestId: 'copy-1' })).structuredContent as unknown as Created;
  assert.equal(replayed.id, copy.id, 'the same request is one copy');
  assert.ok((await call('get_map', { id: copy.id, previewToken: preview.previewToken })).isError, 'the source share grants nothing on the copy');
  assert.ok((await call('copy_map', { id: first.id, previewToken: preview.previewToken, requestId: 'no-target' })).isError, 'retry safety is refused without a target space');
  assert.ok((await call('share_map', { id: copy.id, spaceKey: space.spaceKey })).isError, 'the source space cannot share the copy');

  // Revoking the source's shares leaves the copy alone.
  assert.ok(!(await call('share_map', { id: first.id, spaceKey: space.spaceKey, revoke: true })).isError);
  assert.ok((await call('get_map', { id: first.id, previewToken: preview.previewToken })).isError);
  assert.ok(!(await call('get_map', { id: copy.id, spaceKey: target.spaceKey })).isError);
});

/**
 * Every assertion above this one reads `structuredContent`, which is why a tool
 * could tell the model 请保存 spaceKey and never name the key: the suite was
 * looking at a field the host does not have to show. A minted credential the
 * caller can only read out of the structured payload is a credential half the
 * hosts will lose, so each one has to survive the trip through the text.
 */
test('a credential a tool mints is readable in the text the model gets, not only in structuredContent', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'minted-credential-text-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const said = (result: Awaited<ReturnType<typeof call>>) =>
    (result.content as Array<{ type: string; text?: string }>).map(part => part.text ?? '').join('\n');

  const minted = await call('create_space');
  const space = minted.structuredContent as unknown as SpaceCredential;
  assert.ok(said(minted).includes(space.spaceKey), `create_space must say the key it minted: ${said(minted)}`);
  assert.ok(said(minted).includes(space.spaceId), 'and the id of the space it opens');

  // The id is the half that authorises nothing. A caller that reads the text
  // and spends the id as a key has to be refused, not quietly accepted.
  const impostor = await call('create_map', { map: input, spaceKey: space.spaceId });
  assert.equal(impostor.isError, true, 'a spaceId is not a spaceKey');

  // create_map and copy_map mint a key only when no space was named, and hide
  // it inside editUrl; share_map hides its token inside previewUrl.
  const anonymous = await call('create_map', { map: input });
  const own = anonymous.structuredContent as unknown as Created;
  assert.match(own.spaceKey, /^csk_/);
  assert.ok(said(anonymous).includes(own.spaceKey), 'create_map hands its minted key over in the edit link');

  const shared = await call('share_map', { id: own.id, spaceKey: own.spaceKey });
  const link = shared.structuredContent as unknown as PreviewLink;
  assert.ok(said(shared).includes(link.previewToken), 'share_map hands the token over in the share link');

  const forked = await call('copy_map', { id: own.id, spaceKey: own.spaceKey, title: '副本' });
  const fork = forked.structuredContent as unknown as Created;
  assert.match(fork.spaceKey, /^csk_/);
  assert.ok(said(forked).includes(fork.spaceKey), 'copy_map hands its minted key over in the edit link');

  // Read-only results still keep the caller's own key out of the transcript.
  const read = await call('get_map', { id: own.id, spaceKey: own.spaceKey });
  assert.equal(said(read).includes(own.spaceKey), false, 'a read never repeats a key back');
});

test('share_map lists the live shares by id in its text, and revokes one of them', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'share-list-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const said = (result: Awaited<ReturnType<typeof call>>) =>
    (result.content as Array<{ type: string; text?: string }>).map(part => part.text ?? '').join('\n');

  const map = (await call('create_map', { map: input })).structuredContent as unknown as Created;
  const empty = await call('share_map', { id: map.id, spaceKey: map.spaceKey, list: true });
  assert.deepEqual((empty.structuredContent as { links: unknown[] }).links, []);
  assert.match(said(empty), /没有有效的分享链接/);

  const readOnly = (await call('share_map', { id: map.id, spaceKey: map.spaceKey })).structuredContent as unknown as PreviewLink;
  const writable = (await call('share_map', { id: map.id, spaceKey: map.spaceKey, canWrite: true })).structuredContent as unknown as PreviewLink;
  const listed = await call('share_map', { id: map.id, spaceKey: map.spaceKey, list: true });
  // A host shows the model `content`, not `structuredContent`, so a list the
  // model is expected to revoke from has to name its ids in the text.
  for (const link of [readOnly, writable]) assert.ok(said(listed).includes(link.id), `the list must name ${link.id}: ${said(listed)}`);
  assert.equal(said(listed).includes(readOnly.previewToken), false, 'a listing is not a second chance to read the token');
  assert.equal((listed.structuredContent as { links: unknown[] }).links.length, 2);

  assert.ok((await call('share_map', { id: map.id, spaceKey: map.spaceKey, revokeId: 'sh_nope' })).isError, 'an unknown share id is refused, not reported as revoked');
  const gone = await call('share_map', { id: map.id, spaceKey: map.spaceKey, revokeId: readOnly.id });
  assert.ok(!gone.isError, said(gone));
  assert.ok((await call('get_map', { id: map.id, previewToken: readOnly.previewToken })).isError, 'the revoked share stops reading');
  assert.ok(!(await call('get_map', { id: map.id, previewToken: writable.previewToken })).isError, 'the other share is untouched');
  assert.deepEqual(
    ((await call('share_map', { id: map.id, spaceKey: map.spaceKey, list: true })).structuredContent as { links: Array<{ id: string }> }).links.map(link => link.id),
    [writable.id],
  );
});

test('an id Cartula chooses is still de-duplicated by requestId, even under concurrency', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'minted-id-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const idOf = (result: Awaited<ReturnType<typeof call>>) => (result.structuredContent as unknown as Created).id;
  const space = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  const maps = () => Number(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n);

  // Without an explicit id, a retry used to mint a fresh UUID and create a
  // second map: the request id has to reserve the generated one.
  const args = { map: input, spaceKey: space.spaceKey, requestId: 'create-retry' };
  const created = await call('create_map', args);
  assert.ok(!created.isError, JSON.stringify(created.content));
  assert.equal(idOf(await call('create_map', args)), idOf(created), 'a retry without an id is the same map');
  assert.equal(maps(), 1);
  assert.ok((await call('create_map', { ...args, map: { ...input, title: '换了内容' } })).isError, 'the same requestId with different content conflicts');

  // Simultaneous retries: the reservation lives in the creating transaction, so
  // one of them writes and the other reads the winner.
  const together = await Promise.all([call('create_map', { ...args, requestId: 'create-race' }), call('create_map', { ...args, requestId: 'create-race' })]);
  for (const result of together) assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(idOf(together[0]), idOf(together[1]), 'simultaneous creates must not allocate two maps');
  assert.equal(maps(), 2);

  // The same request id in another space is a different creation.
  const other = (await call('create_space')).structuredContent as unknown as SpaceCredential;
  assert.notEqual(idOf(await call('create_map', { ...args, spaceKey: other.spaceKey })), idOf(created));
  assert.equal(maps(), 3);

  // A keyless anonymous creation has no space to scope the reservation to, and
  // its first response is the only place its space key ever exists — a lost
  // response loses the key, so no retry could reach the map even if it were
  // de-duplicated. That is refused with instructions rather than accepted as a
  // promise the tool cannot keep.
  const impossible = await call('create_map', { map: input, requestId: 'anonymous-retry' });
  assert.equal(impossible.isError, true, 'a retry promise that cannot be honoured is refused');
  const refusal = JSON.parse((impossible.content as Array<{ text: string }>)[0].text) as { error: string; hint: string; status: number };
  assert.equal(refusal.status, 400);
  assert.match(refusal.hint, /create_space/, 'and says how to get retry safety');
  assert.equal(maps(), 3, 'the refusal writes nothing');
  // Without a requestId the same anonymous call still works, and still mints a key.
  const oneShot = await call('create_map', { map: input });
  assert.ok(!oneShot.isError, JSON.stringify(oneShot.content));
  assert.ok((oneShot.structuredContent as unknown as Created).spaceKey, 'a keyless create still returns its new space key');
  assert.equal(maps(), 4);
});

test('a copy request survives a later rename of its source and never writes twice', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const source = await create(app);
  const target = (await app.inject({ method: 'POST', url: '/api/spaces', payload: {} })).json<SpaceCredential>();
  const request = { method: 'POST' as const, url: `/api/maps/${source.id}/copy`, headers: bearer(source.spaceKey),
    payload: { targetSpaceKey: target.spaceKey, requestId: 'copy-then-rename' } };
  const copy = (await app.inject(request)).json<Created>();

  // The fingerprint is what the caller asked for, so renaming the original does
  // not turn an honest retry into a conflict — and does not overwrite the copy.
  await store.put(source.id, { ...input, title: '原图后来改名' }, { key: source.spaceKey, ifMatch: 1, idempotencyKey: 'rename' });
  await store.edit(copy.id, target.spaceKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '只改副本' }]);
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().id, copy.id);
  assert.equal(store.get(copy.id).version, 2, 'the replay returns the edited copy rather than rewriting it');
  assert.equal(store.get(copy.id).layers[0].points[0].note, '只改副本');
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM maps').get()!.n), 2);

  // A space key stays the space's authorisation after an account claims it: an
  // Agent that never logs in keeps writing where it was told to.
  const user = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${copy.id}/claim`, headers: { ...user.headers, ...bearer(target.spaceKey) }, payload: {} })).statusCode, 200);
  const afterClaim = await app.inject({ ...request, payload: { ...request.payload, requestId: 'copy-after-claim' } });
  assert.equal(afterClaim.statusCode, 200, afterClaim.body);
  assert.equal(afterClaim.json().access.spaceId, target.spaceId);
});

test('an unauthorized create never reads the map that id already names', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const owner = await create(app, 'taken-id');
  const intruder = (await app.inject({ method: 'POST', url: '/api/spaces', payload: {} })).json<SpaceCredential>();
  // Same id, same payload, wrong space: answered from the id alone, without
  // reading — or replaying the idempotency record of — someone else's map.
  const collision = await app.inject({ method: 'PUT', url: '/m/taken-id', headers: bearer(intruder.spaceKey), payload: input });
  assert.equal(collision.statusCode, 403);
  for (const secret of [input.title!, '"layers"', owner.spaceKey]) assert.equal(collision.body.includes(secret), false);
  assert.equal(store.get('taken-id').version, 1, 'and nothing was written');
});

test('a rejected account body is not described as bad map data', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const bad = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { email: 'a@example.test', password: 'Cartula-2026-Access!', passwordConfirm: 'Cartula-2026-Access!', nickname: '多余字段' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.includes('地图'), false, 'an account form is not map data');
  assert.equal(String(bad.json().hint).includes('经度'), false, 'and coordinates are not the correction');
  assert.ok(bad.json().error.includes('nickname'), bad.body);
  // A genuinely malformed map still gets the map-shaped correction.
  const map = await app.inject({ method: 'PUT', url: '/m/reversed-coords', payload: { title: 'x', layers: [{ name: 'L', points: [{ name: 'P', at: [45.7, 126.6] }] }] } });
  assert.equal(map.statusCode, 400);
  assert.ok(String(map.json().hint).includes('经度'), map.body);
});

test('the library returns every owned map, without a silent cap', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:', maxMaps: 320 }); t.after(() => app.close());
  const first = await create(app);
  for (let i = 0; i < 210; i += 1) {
    await store.put(`bulk-${i}`, { ...input, title: `批量 ${i}` }, { key: first.spaceKey });
  }
  const listed = (await app.inject({ url: '/api/maps', headers: bearer(first.spaceKey) })).json<MapLibrary>();
  assert.equal(listed.maps.length, 211, 'a library past 200 entries must not quietly lose maps');
  assert.ok(listed.maps.some(map => map.id === 'bulk-0'), 'including the oldest');
});


test('deleting a map takes its history, its shares and the favorites they backed', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); });
  const map = await create(app);
  const sibling = await create(app, randomUUID(), map.spaceKey);
  await store.edit(map.id, map.spaceKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '第二版' }]);
  const link = await share(app, map);
  const reader = await register(app);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/me/favorites/${map.id}`, headers: { ...reader.headers, ...bearer(link.previewToken) }, payload: {} })).statusCode, 200);

  // A live subscriber is closed rather than left listening to a map that no
  // longer exists.
  const socket = new WebSocket(`${address.replace('http', 'ws')}/m/${map.id}`, { headers: bearer(map.spaceKey) });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const closed = once(socket, 'close');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/maps/${map.id}`, headers: bearer(link.previewToken) })).statusCode, 403, 'a share is not ownership');
  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: bearer(map.spaceKey) })).statusCode, 200, 'and a refused delete deletes nothing');
  const removed = await app.inject({ method: 'DELETE', url: `/api/maps/${map.id}`, headers: bearer(map.spaceKey) });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().title, input.title);
  await closed;

  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: bearer(map.spaceKey) })).statusCode, 404);
  // The share token is not merely pointed at nothing — it is gone, so it is
  // refused as a credential before any map is looked up.
  assert.equal((await app.inject({ url: `/m/${map.id}`, headers: bearer(link.previewToken) })).statusCode, 403, 'the share link dies with the map');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/maps/${map.id}`, headers: bearer(map.spaceKey) })).statusCode, 404, 'and it stays deleted');
  const library = (await app.inject({ url: '/api/maps', headers: { ...bearer(map.spaceKey), cookie: reader.cookie } })).json<MapLibrary>();
  assert.deepEqual(library.favorites, [], 'a favorite of a deleted map is not a dead row somebody has to tidy up');
  assert.deepEqual(library.maps.map(entry => entry.id), [sibling.id], 'the space and its other maps are untouched');
  for (const table of ['versions', 'writes', 'previews', 'favorites']) {
    const rows = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE map_id=?`).get(map.id) as { n: number };
    assert.equal(Number(rows.n), 0, `${table} rows go with the map`);
  }

  // The Agent's own entrance to the same operation, and the same refusal.
  const client = new Client({ name: 'delete-mcp', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  const siblingShare = await share(app, { id: sibling.id, spaceKey: map.spaceKey });
  assert.ok((await client.callTool({ name: 'delete_map', arguments: { id: sibling.id, editKey: siblingShare.previewToken } })).isError, 'a share token cannot delete, whatever parameter it arrives under');
  assert.ok((await client.callTool({ name: 'delete_map', arguments: { id: sibling.id } })).isError, 'nor can an id on its own');
  const byAgent = await client.callTool({ name: 'delete_map', arguments: { id: sibling.id, spaceKey: map.spaceKey } });
  assert.ok(!byAgent.isError, JSON.stringify(byAgent.content));
  assert.equal((await app.inject({ url: `/m/${sibling.id}`, headers: bearer(map.spaceKey) })).statusCode, 404);
});

test('an account API key authorises every claimed map and is what MCP Authorization carries', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); });
  const user = await register(app);
  const first = await create(app);
  const second = await create(app);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${first.id}/claim`, headers: { ...user.headers, ...bearer(first.spaceKey) }, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${second.id}/claim`, headers: { ...user.headers, ...bearer(second.spaceKey) }, payload: {} })).statusCode, 200);
  const outsider = await create(app);

  assert.equal((await app.inject({ method: 'POST', url: '/api/me/api-keys', headers: csrf, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/me/api-keys', headers: { ...csrf, ...bearer(first.spaceKey) }, payload: {} })).statusCode, 401, 'a space key cannot mint an account key');
  const minted = await app.inject({ method: 'POST', url: '/api/me/api-keys', headers: user.headers, payload: { name: 'Codex' } });
  assert.equal(minted.statusCode, 200, minted.body);
  const created = minted.json() as CreatedApiKey;
  assert.match(created.apiKey, /^cak_/);
  assert.equal(created.name, 'Codex');
  assert.match(created.hint, /^cak_.+…[A-Za-z0-9_-]{4}$/);
  assert.notEqual(created.hint, created.apiKey);

  const listed = await app.inject({ url: '/api/me/api-keys', headers: { cookie: user.cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().keys.length, 1);
  assert.equal(JSON.stringify(listed.json()).includes(created.apiKey), false, 'the secret is not recoverable');

  const auth = bearer(created.apiKey);
  const library = (await app.inject({ url: '/api/maps', headers: auth })).json<MapLibrary>();
  assert.deepEqual(library.maps.map(map => map.id).sort(), [first.id, second.id].sort());
  assert.equal((await app.inject({ url: `/m/${first.id}`, headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ url: `/m/${second.id}`, headers: auth })).json().access.editable, true);
  assert.equal((await app.inject({ url: `/m/${outsider.id}`, headers: auth })).statusCode, 403);
  const edited = await app.inject({ method: 'POST', url: `/api/maps/${first.id}/edit`, headers: auth, payload: { baseVersion: 1, operations: [{ op: 'annotate', layerId: 'route', pointId: 'a', text: 'API Key 可写' }] } });
  assert.equal(edited.statusCode, 200, edited.body);

  const ownShare = await share(app, first);

  const client = new Client({ name: 'api-key-mcp', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${created.apiKey}` } } }));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const viaHeader = (await call('list_maps')).structuredContent as unknown as { maps: Array<{ id: string }> };
  assert.deepEqual(viaHeader.maps.map(map => map.id).sort(), [first.id, second.id].sort());
  const owned = await call('get_map', { id: first.id });
  assert.ok(!owned.isError, 'the header is enough to read a claimed map');
  assert.equal((owned.structuredContent as { access: MapAccess }).access.editable, true);
  const limited = await call('get_map', { id: first.id, previewToken: ownShare.previewToken });
  assert.ok(!limited.isError);
  assert.equal((limited.structuredContent as { access: MapAccess }).access.kind, 'preview', 'an explicit preview stays read-only even with an owner API key');
  assert.ok((await call('get_map', { id: outsider.id })).isError, 'and not an unclaimed one');
  const made = await call('create_map', { map: { ...input, title: 'API Key 新建' }, requestId: 'ak-create-1' });
  assert.ok(!made.isError, JSON.stringify(made.content));
  const createdMap = made.structuredContent as unknown as Created;
  assert.equal((await app.inject({ url: `/m/${createdMap.id}`, headers: { cookie: user.cookie } })).statusCode, 200, 'new maps land in the account');
  // The header authorised the write but cannot be put into a link, so there is
  // no editUrl — and the answer says so where the decision is made, instead of
  // telling the Agent to use a spaceKey it was never given.
  const text = (made.content as Array<{ text?: string }>).map(part => part.text ?? '').join('\n');
  assert.equal((made.structuredContent as { editUrl?: string }).editUrl, undefined);
  assert.ok(text.includes('本次没有可以交给用户的编辑链接'), text);
  assert.ok(text.includes('create_space'), text);
  // The card is still writeable: it inherits the same authenticated session,
  // which is why `access.editable` and not a held key is what may gate it.
  const context = (made._meta as { cartula?: { access?: MapAccess; spaceKey?: string } }).cartula;
  assert.equal(context?.access?.editable, true);
  assert.equal(context?.spaceKey, undefined, 'and it is handed no credential to do it with');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/me/api-keys/${created.id}`, headers: user.headers })).statusCode, 200);
  assert.equal((await app.inject({ url: `/m/${first.id}`, headers: auth })).statusCode, 403);
});
