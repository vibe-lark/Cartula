import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { RESOURCE_URI } from '../src/server/mcp.js';
import { MapStore } from '../src/server/store.js';
import { MapInputSchema } from '../src/core/schema.js';
import { RELEASE, RELEASE_NAME, RELEASE_VERSION, BUILD } from '../src/server/release.js';
import { buildStamp, releaseId } from '../src/core/release.js';
import { bootstrapScript } from '../src/server/html.js';
import { readFile } from 'node:fs/promises';
import { roundSummary } from '../src/web/handoff.js';
import type { MapInput, MapSnapshot } from '../src/core/types.js';

const input: MapInput = { title: '测试行程', layers: [{ id: 'route', name: '北上路线', points: [{ id: 'harbin', name: '哈尔滨', at: [126.642, 45.757], day: 1 }, { id: 'heihe', name: '黑河', at: [127.499, 50.25], day: 3 }] }] };
test('REST: create → semantic edits → agent read; bearer, replay and concurrency protection', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const created = await app.inject({ method: 'PUT', url: '/m/trip', payload: input });
  assert.equal(created.statusCode, 200);
  const first = created.json();
  assert.ok(first.editKey.length >= 24);
  assert.equal(first.spaceKey, first.editKey, 'the space key is what the editKey alias now carries');
  assert.ok(first.spaceId);
  assert.ok(first.editUrl.includes('#space='));
  assert.ok(!first.url.includes(first.editKey));
  assert.equal(first.access.kind, 'owner');
  assert.equal(first.access.editable, true);
  assert.equal(first.access.claimed, false);
  const headers = { authorization: `Bearer ${first.editKey}` };
  // A new map is private: the id alone reads nothing.
  assert.equal((await app.inject('/m/trip')).statusCode, 403);
  assert.equal((await app.inject({ url: '/m/trip', headers: { authorization: 'Bearer csk_not-a-real-key' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/m/trip', payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/trip/edit', payload: { baseVersion: 1, operations: [{ op: 'delete', layerId: 'route', pointId: 'heihe' }] } })).statusCode, 403);
  const edited = await app.inject({ method: 'POST', url: '/api/maps/trip/edit', headers, payload: { baseVersion: 1, operations: [
    { op: 'insert', layerId: 'route', after: 'heihe', point: { id: 'wudalianchi', name: '五大连池', at: [126.203, 48.705], day: 4 } },
    { op: 'annotate', layerId: 'route', pointId: 'heihe', text: '补给点' },
  ] } });
  assert.equal(edited.statusCode, 200, edited.body);
  const map = edited.json();
  assert.equal(map.version, 2);
  assert.equal(map.parent, 1);
  assert.equal(map.changed, true);
  assert.ok(map.changes.some((c: string) => c.includes('五大连池') && c.includes('黑河')));
  const replay = await app.inject({ method: 'PUT', url: '/m/trip', headers, payload: input });
  assert.equal(replay.json().version, 2, 'replaying old successful PUT cannot overwrite later user edits');
  assert.equal(replay.json().layers[0].points.length, 3);
  assert.equal(replay.json().editKey, undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get()!.n, 2);
  const reader1 = (await app.inject({ url: '/m/trip', headers })).json();
  const reader2 = (await app.inject({ url: '/m/trip', headers })).json();
  assert.deepEqual(reader1.changes, reader2.changes, 'reading must not consume another client’s changes');
  assert.equal(reader1.editKey, undefined);
  assert.equal(reader1.layers[0].points[2].name, '五大连池');
  assert.deepEqual((await app.inject({ url: '/m/trip?since=2', headers })).json().changes, []);
  assert.equal((await app.inject({ url: '/m/trip?since=999', headers })).statusCode, 400);
  const stale = await app.inject({ method: 'POST', url: '/api/maps/trip/edit', headers, payload: { baseVersion: 1, operations: [{ op: 'delete', layerId: 'route', pointId: 'harbin' }] } });
  assert.equal(stale.statusCode, 409);
  const deliberate = await app.inject({ method: 'PUT', url: '/m/trip', headers: { ...headers, 'idempotency-key': 'reapply-original', 'if-match': '"2"' }, payload: input });
  assert.equal(deliberate.json().version, 3);
  // A write result reports its own delta: something did change since v2, and it
  // was the Agent, not the user.
  assert.equal(deliberate.json().changed, true);
  assert.equal(deliberate.json().hasUserChanges, false);
  assert.equal(deliberate.json().hasAgentChanges, true);
  assert.equal(deliberate.json().sinceVersion, 2);
  assert.equal((await app.inject({ method: 'PUT', url: '/m/trip', headers: { ...headers, 'idempotency-key': 'reapply-original' }, payload: { ...input, title: 'changed request' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PUT', url: '/m/trip', headers: { ...headers, 'if-match': '"2"' }, payload: { ...input, title: 'new title' } })).statusCode, 409);
});

test('bad input is actionable, atomic and origin restricted', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const reversed = await app.inject({ method: 'PUT', url: '/m/bad', payload: { layers: [{ name: '路线', points: [{ name: '哈尔滨', at: [45.757, 126.642] }] }] } });
  assert.equal(reversed.statusCode, 400); assert.deepEqual(reversed.json().fix, [126.642, 45.757]);
  assert.equal((await app.inject('/m/bad')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', headers: { origin: 'https://attacker.example' }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'attacker.example' }, payload: {} })).statusCode, 403);
  const api = await app.inject('/openapi.json');
  assert.equal(api.statusCode, 200);
  assert.ok(api.json().paths['/m/{id}'].put.requestBody.content['application/json'].schema);
  const map = await store.put('atomic', MapInputSchema.parse(input));
  const response = await app.inject({ method: 'POST', url: '/api/maps/atomic/edit', headers: { authorization: `Bearer ${map.editKey}` }, payload: { baseVersion: 1, operations: [{ op: 'delete', layerId: 'route', pointId: 'harbin' }, { op: 'delete', layerId: 'route', pointId: 'missing' }] } });
  assert.ok(response.statusCode >= 400);
  assert.equal(store.get('atomic').layers[0].points.length, 2);
  assert.equal(store.get('atomic').version, 1);
});

test('SQLite persists map, credentials and versions across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartula-test-'));
  try {
    let store = new MapStore({ path: join(dir, 'db.sqlite'), publicUrl: 'http://localhost:3900' });
    const first = await store.put('persistent', input);
    await store.edit('persistent', first.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '持久化备注' }]);
    store.close();
    store = new MapStore({ path: join(dir, 'db.sqlite'), publicUrl: 'http://localhost:3900' });
    assert.equal(store.get('persistent').version, 2);
    assert.equal(store.get('persistent').layers[0].points[1].note, '持久化备注');
    assert.doesNotThrow(() => store.authorize('persistent', first.editKey));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('user JSON import preserves change tracking, concurrency and retry safety', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const first = await store.put('import-test', input);
  const headers = { authorization: `Bearer ${first.editKey}` };
  const payload = { baseVersion: 1, requestId: 'import-once', map: { ...input, title: '用户导入的行程' } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/import-test/replace', payload })).statusCode, 403);
  const response = await app.inject({ method: 'POST', url: '/api/maps/import-test/replace', headers, payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().changed, true);
  assert.equal(response.json().events[0].actor, 'user');
  assert.equal(response.json().title, '用户导入的行程');
  await store.edit('import-test', first.editKey, 2, [
    { op: 'annotate', layerId: 'route', pointId: 'heihe', text: '导入后增加的备注' },
    { op: 'update', layerId: 'route', pointId: 'heihe', patch: { day: null } },
  ]);
  const replay = await app.inject({ method: 'POST', url: '/api/maps/import-test/replace', headers, payload });
  assert.equal(replay.json().version, 3);
  assert.equal(replay.json().layers[0].points[1].note, '导入后增加的备注');
  assert.equal(replay.json().layers[0].points[1].day, undefined, 'clearing a day removes the optional value');
  assert.equal(replay.json().layers[0].stats.days, 1);
  const stale = await app.inject({ method: 'POST', url: '/api/maps/import-test/replace', headers, payload: { ...payload, requestId: 'another-import' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(store.get('import-test').events.length, 2, 'imports must not advance the Agent cursor');
});

type Frame = { type: string; version?: number; ok?: boolean; changes?: string[] };
/** Poll the collected frames instead of racing `once`: auth answers with two messages. */
const waitFor = async (frames: Frame[], match: (frame: Frame) => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hit = frames.find(match);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
};

test('WebSocket withholds a private map until authenticated, then sends notices and authorized suggestions', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const map = await store.put('live', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  const socket = new WebSocket(`${url.replace('http', 'ws')}/m/live`);
  const frames: Frame[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  t.after(async () => { socket.terminate(); await app.close(); });
  await once(socket, 'open');

  // Not authenticated: no version, no changes, not even a subscription.
  await store.edit('live', map.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '到此加油' }]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(frames, [], 'a private map sends nothing to an unauthenticated socket');
  socket.send(JSON.stringify({ type: 'suggest', text: '未认证建议' }));
  await waitFor(frames, frame => frame.type === 'error', 'refused suggestion');

  socket.send(JSON.stringify({ type: 'auth', key: map.editKey }));
  assert.equal((await waitFor(frames, frame => frame.type === 'auth', 'auth ok')).ok, true);
  assert.equal((await waitFor(frames, frame => frame.type === 'edit', 'current version')).version, 2);
  socket.send(JSON.stringify({ type: 'suggest', text: '在五大连池住一晚', highlight: ['五大连池'] }));
  await waitFor(frames, frame => frame.type === 'suggest', 'broadcast suggestion');
  await store.edit('live', map.editKey, 2, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '认证后改动' }]);
  assert.equal((await waitFor(frames, frame => frame.type === 'edit' && frame.version === 3, 'live edit')).version, 3);

  // A wrong key never authenticates, and never lets a second socket in.
  const intruder = new WebSocket(`${url.replace('http', 'ws')}/m/live`);
  const intruderFrames: Frame[] = [];
  intruder.on('message', data => intruderFrames.push(JSON.parse(data.toString())));
  t.after(() => intruder.terminate());
  await once(intruder, 'open');
  intruder.send(JSON.stringify({ type: 'auth', key: 'csk_wrong-key-entirely' }));
  await waitFor(intruderFrames, frame => frame.type === 'error', 'refused auth');
  await store.edit('live', map.editKey, 3, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '入侵者看不到' }]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!intruderFrames.some(frame => frame.type === 'edit'), 'a refused socket never joins the subscription');

  socket.close();
  await store.edit('live', map.editKey, 4, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '断线后改动' }]);
  assert.equal((await app.inject({ url: '/m/live?since=2', headers })).json().version, 5);
});

test('official MCP client initializes, discovers Apps metadata and completes write/read', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'cartula-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const { tools } = await client.listTools();
  const createTool = tools.find(tool => tool.name === 'create_map')!;
  // The build's own address, not the fixed one earlier builds published — see
  // UI-04 in tests/contract.test.ts for why the name has to move.
  assert.equal((createTool._meta?.ui as { resourceUri: string }).resourceUri, RESOURCE_URI);
  const editTool = tools.find(tool => tool.name === 'edit_map')!;
  assert.deepEqual((editTool._meta?.ui as { visibility: string[] }).visibility, ['app']);
  // Nothing on the list introduces itself as deprecated: a tool a model is told
  // not to use is a tool that should not have been offered to it.
  const deprecated = tools.filter(tool => /弃用|废弃|deprecated/i.test(`${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`));
  assert.deepEqual(deprecated.map(tool => tool.name), []);
  const written = await client.callTool({ name: 'create_map', arguments: { id: 'mcp-trip', map: input } });
  assert.ok(!written.isError);
  assert.ok(JSON.stringify(written.content).includes('/map/mcp-trip'), 'non-Apps hosts get a usable text URL');
  const data = written.structuredContent as { editKey: string; version: number };
  assert.ok(data.editKey);
  const edited = await client.callTool({ name: 'edit_map', arguments: { id: 'mcp-trip', editKey: data.editKey, baseVersion: 1, operations: [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: 'MCP App 备注' }] } });
  assert.ok(!edited.isError);
  const read = await client.callTool({ name: 'get_map', arguments: { id: 'mcp-trip', spaceKey: data.editKey } });
  assert.equal((read.structuredContent as { changed: boolean }).changed, true);
  assert.ok(JSON.stringify(read.structuredContent).includes('MCP App 备注'));
  assert.ok(!JSON.stringify(read.structuredContent).includes(data.editKey), 'a read never echoes the credential back to the model');
  const anonymous = await client.callTool({ name: 'get_map', arguments: { id: 'mcp-trip' } });
  assert.ok(anonymous.isError, 'the map id alone reads nothing');
  assert.ok(!JSON.stringify(anonymous).includes('MCP App 备注'));
  const resources = await client.listResources();
  assert.equal(resources.resources[0].mimeType, 'text/html;profile=mcp-app');
});

test('BUILD-01 the service and the App it serves declare one traceable release', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'cartula-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });

  // One version, kept where the package declares it — a second copy is how the
  // App came to introduce itself as 0.2.0 while the server said 0.3.0.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(RELEASE_VERSION, pkg.version);
  assert.ok(RELEASE.startsWith(RELEASE_VERSION), RELEASE);

  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  assert.deepEqual(client.getServerVersion(), { name: RELEASE_NAME, version: RELEASE }, 'the handshake names the build');

  const health = (await app.inject('/healthz')).json() as { version: string; release: string; build?: string };
  assert.equal(health.release, RELEASE, 'ops and the model see the same string');
  assert.equal(health.version, RELEASE_VERSION);
  assert.equal(health.build, BUILD);
  assert.equal((await app.inject('/openapi.json')).json().info.version, RELEASE);

  // The App does not compile its own guess: the page carries the release that
  // served it, and that is what it declares back through ui/initialize.
  const bootstrap = bootstrapScript({ mode: 'mcp', release: RELEASE });
  assert.equal((JSON.parse(bootstrap.replace(/^[^>]+>/, '').replace(/<\/script>$/, '')) as { release: string }).release, RELEASE);
  // What the App then does with it — declaring it in `ui/initialize` — is
  // asserted against a real host in tests/e2e/embedding.spec.ts.
});

test('BUILD-01 a build stamp is traceable, or absent — never half-formed', () => {
  assert.equal(releaseId(undefined), RELEASE_VERSION);
  assert.equal(releaseId('9f2c1ab'), `${RELEASE_VERSION}+9f2c1ab`);
  assert.equal(releaseId('  2026-09-08.3  '), `${RELEASE_VERSION}+2026-09-08.3`);
  assert.equal(buildStamp('9f2c1ab'), '9f2c1ab');
  // A stamp travels into a handshake string, an HTML bootstrap and a health
  // check; anything that could change the meaning of one of those is dropped
  // rather than escaped, because "no build" is still a true answer.
  for (const junk of ['', '   ', 'a b', 'a"b', '</script>', '-leading', 'x'.repeat(41)]) {
    assert.equal(buildStamp(junk), undefined, JSON.stringify(junk));
    assert.equal(releaseId(junk), RELEASE_VERSION, JSON.stringify(junk));
  }
});

test('RETEST-01 the hand-off boundary is server-side, permission-checked, monotonic and separate from the Agent cursor', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'cartula-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('handoff-boundary', input);
  const key = map.editKey!;
  const headers = { authorization: `Bearer ${key}` };
  await store.edit(map.id, key, 1, [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '用户改的备注' }], undefined, 'user');
  await store.edit(map.id, key, 2, [{ op: 'draft.commit', note: '交给 Agent 继续规划' }], undefined, 'user');

  // A submission is recorded on the map; delivery is not, and nothing claims it.
  assert.equal(store.get(map.id).handoffVersion, 0, 'a draft.commit is a submission, not a delivery');

  // Only the view can confirm delivery, and it needs write access to say so.
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, payload: { version: 3 } })).statusCode, 403);
  const share = store.access.createPreview(map.id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, headers: { authorization: `Bearer ${share.previewToken}` }, payload: { version: 3 } })).statusCode, 403, 'a share token cannot move the boundary');

  const eventsBefore = store.get(map.id, 0).events.length;
  const recorded = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, headers, payload: { version: 3 } });
  assert.equal(recorded.statusCode, 200, recorded.body);
  assert.equal(recorded.json().handoffVersion, 3);
  assert.equal(store.get(map.id).version, 3, 'recording a hand-off writes no version');
  assert.equal(store.get(map.id, 0).events.length, eventsBefore, 'and no event');

  // Forward only: a late confirmation from an earlier round cannot pull it back.
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, headers, payload: { version: 1 } })).json().handoffVersion, 3);
  // Never past the head: a boundary above the map would hide changes nobody handed over.
  const ahead = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, headers, payload: { version: 9 } });
  assert.equal(ahead.statusCode, 400);
  assert.equal(ahead.json().code, 'UNKNOWN_VERSION');
  assert.equal(store.get(map.id).handoffVersion, 3);
  assert.equal((await app.inject({ method: 'POST', url: `/api/maps/${map.id}/handoff`, headers, payload: { version: 3, extra: 1 } })).statusCode, 400, 'unknown fields are refused, not ignored');

  // The two boundaries stay apart: an Agent write moves its own cursor only.
  await store.edit(map.id, key, 3, [{ op: 'annotate', layerId: 'route', pointId: 'harbin', text: 'Agent 调整' }], undefined, 'agent');
  const after = store.get(map.id, 0);
  assert.equal(after.agentVersion, 4);
  assert.equal(after.handoffVersion, 3, 'an Agent version is not evidence of a hand-off');

  // The App reads both back through its own hidden channel.
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const state = await client.callTool({ name: 'get_map_state', arguments: { id: map.id, spaceKey: key } });
  const hidden = (state._meta?.cartula as { map: { handoffVersion: number; agentVersion: number } }).map;
  assert.equal(hidden.handoffVersion, 3);
  assert.equal(hidden.agentVersion, 4);
  assert.ok(!JSON.stringify(state.structuredContent).includes(key));

  // ...and confirms deliveries through an app-only tool, with the same rules.
  const tools = (await client.listTools()).tools;
  const record = tools.find(tool => tool.name === 'record_handoff')!;
  assert.deepEqual((record._meta?.ui as { visibility: string[] }).visibility, ['app'], 'the model has no reason to call this');
  assert.equal((await client.callTool({ name: 'record_handoff', arguments: { id: map.id, version: 4 } })).isError, true, 'no credential, no boundary move');
  const acked = await client.callTool({ name: 'record_handoff', arguments: { id: map.id, version: 4, spaceKey: key } });
  assert.ok(!acked.isError, JSON.stringify(acked.content));
  assert.equal((acked.structuredContent as { handoffVersion: number }).handoffVersion, 4);
  assert.equal(store.get(map.id).version, 4, 'still no version of its own');
  assert.ok(!JSON.stringify(acked).includes(key), 'the acknowledgement echoes no credential');
});

test('RETEST-01 a database written before the boundary existed keeps its maps and starts at 0', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cartula-handoff-'));
  const path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = new MapStore({ path, publicUrl: 'http://localhost:3900' });
  const map = await before.put('legacy-boundary', input);
  before.recordHandoff('legacy-boundary', map.editKey!, 1);
  assert.equal(before.get('legacy-boundary').handoffVersion, 1);
  // Roll the schema back to what an older deployment wrote.
  before.db.exec('ALTER TABLE maps DROP COLUMN handoff_version');
  before.close();

  const after = new MapStore({ path, publicUrl: 'http://localhost:3900' });
  t.after(() => after.close());
  const restored = after.get('legacy-boundary');
  assert.equal(restored.version, 1, 'the map itself is untouched');
  assert.equal(restored.handoffVersion, 0, 'an unknown boundary offers the round again rather than skipping it');
  assert.equal(after.recordHandoff('legacy-boundary', map.editKey!, 1).handoffVersion, 1);
});

test('UX-03 the App gets the whole history back from a write, while the model payload stays compact', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'cartula-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('window', input);
  const key = map.editKey!;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

  // Two user edits in a row. Each write answers against its own baseVersion, so
  // its event list covers that write alone — the window the model wants, and
  // far too narrow for the view, which counts this round from it.
  const first = await client.callTool({ name: 'edit_map', arguments: { id: map.id, spaceKey: key, baseVersion: 1, operations: [{ op: 'annotate', layerId: 'route', pointId: 'harbin', text: '第一处修改' }] } });
  assert.ok(!first.isError, JSON.stringify(first.content));
  const second = await client.callTool({ name: 'edit_map', arguments: { id: map.id, spaceKey: key, baseVersion: 2, operations: [{ op: 'annotate', layerId: 'route', pointId: 'heihe', text: '第二处修改' }] } });
  assert.ok(!second.isError, JSON.stringify(second.content));

  const hidden = (second._meta?.cartula as { map: MapSnapshot }).map;
  assert.equal(hidden.version, 3);
  // Both edits are still in the round the pending entry offers to hand over.
  assert.deepEqual(roundSummary(hidden, 1).length, 2, JSON.stringify(hidden.changes));
  assert.ok(JSON.stringify(hidden.events).includes('第一处修改'));
  assert.ok(JSON.stringify(hidden.events).includes('第二处修改'));
  assert.equal(hidden.handoffVersion, 0);
  // The model-visible payload is untouched: id and version, no history, no key.
  assert.deepEqual(Object.keys(second.structuredContent as object).sort(), ['access', 'id', 'version']);
  assert.ok(!JSON.stringify(second.structuredContent).includes('第一处修改'));
  assert.ok(!JSON.stringify(second.structuredContent).includes(key));

  // The same holds for the hand-off tool, which the view reads its summary from.
  const submitted = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, spaceKey: key, baseVersion: 3, userMessage: '交给你了' } });
  const handoffMap = (submitted._meta?.cartula as { map: MapSnapshot }).map;
  assert.equal(roundSummary(handoffMap, 1).length >= 3, true, '两次编辑加一次草稿提交');
  assert.ok(!JSON.stringify(submitted.structuredContent).includes(key));

  // And a replace, which is the import path.
  const replaced = await client.callTool({ name: 'replace_map', arguments: { id: map.id, spaceKey: key, baseVersion: 4, map: { title: '导入后的地图', layers: input.layers } } });
  assert.ok(!replaced.isError, JSON.stringify(replaced.content));
  const afterReplace = (replaced._meta?.cartula as { map: MapSnapshot }).map;
  assert.ok(roundSummary(afterReplace, 1).length >= 3, 'the earlier rounds are still in the window');
  assert.deepEqual(Object.keys(replaced.structuredContent as object).sort(), ['access', 'id', 'version']);
});

/**
 * The handshake must not promise notifications this deployment cannot send.
 *
 * `/mcp` is stateless — a fresh server per POST, no session id, JSON responses,
 * `GET` answered with 405 — so there is no stream to push a notification on.
 * `listChanged: true` would tell a client it may cache a list until told
 * otherwise, and a cached *tool* list is a cached `_meta.ui.resourceUri`: the
 * client keeps rendering the App address it learned once. See
 * `withoutUndeliverableNotifications`, which reaches into SDK internals to
 * unset this — if an upstream rename makes that a no-op, this test says so
 * rather than the promise quietly coming back.
 */
test('UI-04 the handshake promises no notification this transport cannot deliver', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());

  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capability-test', version: '1' } } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null, 'stateless: nothing to send a later notification to');
  const capabilities = (JSON.parse(await response.text()) as { result: { capabilities: Record<string, { listChanged?: boolean }> } }).result.capabilities;
  assert.equal(capabilities.tools.listChanged, false, JSON.stringify(capabilities));
  assert.equal(capabilities.resources.listChanged, false, JSON.stringify(capabilities));

  // The other half of the same fact: no stream exists to carry one.
  const stream = await fetch(`${url}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.equal(stream.status, 405);
  await stream.body?.cancel();
});

test('the verification host keeps its unsafe-eval; every other page keeps the tighter CSP', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const root = await app.inject('/');
  assert.ok(!/unsafe-eval/.test(root.headers['content-security-policy'] as string), root.headers['content-security-policy'] as string);
  // mcp-host.html's MCP client compiles JSON schemas with `new Function`, so
  // only that page's script-src carries 'unsafe-eval'.
  const host = await app.inject('/mcp-host.html');
  assert.ok(/unsafe-eval/.test(host.headers['content-security-policy'] as string), host.headers['content-security-policy'] as string);
});
