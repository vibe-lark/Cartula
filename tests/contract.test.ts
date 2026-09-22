/**
 * REL-02 (delta flags) and API-01 (edit contract) at the tool and REST layers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { LEGACY_RESOURCE_URI, RESOURCE_URI } from '../src/server/mcp.js';
import { RELEASE } from '../src/server/release.js';
import { resourceTag } from '../src/core/release.js';
import type { MapInput, MapSnapshot } from '../src/core/types.js';

const input: MapInput = { title: '增量语义', layers: [{ id: 'route', name: '自驾', points: [
  { id: 'a', name: '甲', at: [126.6, 45.7] },
  { id: 'b', name: '乙', at: [127.5, 46.3] },
  { id: 'c', name: '丙', at: [128.2, 47.1] },
] }] };

type Delta = { changed: boolean; unchanged: boolean; hasUserChanges: boolean; hasAgentChanges: boolean; sinceVersion?: number; changes: string[]; version: number; layers?: unknown[]; events?: unknown[] };

/** Reads are private now, so every read carries the owner credential. */
const read = async (app: Awaited<ReturnType<typeof createApp>>['app'], query: string, key?: string) =>
  (await app.inject({ url: `/m/delta${query}`, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) })).json() as Delta;

test('REL-02 changed answers "anything new since the version I read", by any author', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('delta', input);
  const key = map.editKey!;

  // v2 written by the Agent, v3 by the user.
  await store.edit('delta', key, 1, [{ op: 'point.update', layerId: 'route', pointId: 'a', patch: { day: 1 } }], undefined, 'agent');
  await store.edit('delta', key, 2, [{ op: 'annotate', layerId: 'route', pointId: 'b', text: '用户写的备注' }], undefined, 'user');

  assert.equal((await app.inject('/m/delta?view=summary')).statusCode, 403, 'the map id alone reads nothing');
  const sinceOne = await read(app, '?since=1&view=summary', key);
  assert.equal(sinceOne.changed, true, 'two versions happened since v1');
  assert.equal(sinceOne.unchanged, false);
  assert.equal(sinceOne.hasAgentChanges, true);
  assert.equal(sinceOne.hasUserChanges, true);
  assert.equal(sinceOne.sinceVersion, 1);
  assert.ok(sinceOne.changes.length >= 2);

  // The case from the report: only the Agent moved, and `changed` used to be
  // false while `changes` was not empty.
  const agentOnly = await read(app, '?since=1&view=affected', key);
  assert.equal(agentOnly.changed, true);
  assert.notEqual(agentOnly.changed, agentOnly.unchanged, 'changed and unchanged are always opposites');

  const sinceTwo = await read(app, '?since=2&view=summary', key);
  assert.equal(sinceTwo.changed, true);
  assert.equal(sinceTwo.hasUserChanges, true);
  assert.equal(sinceTwo.hasAgentChanges, false, 'the agent event is v2, which is not after v2');

  const current = await read(app, '?since=3&view=summary', key);
  assert.equal(current.changed, false);
  assert.equal(current.unchanged, true);
  assert.equal(current.hasUserChanges, false);
  assert.equal(current.hasAgentChanges, false);
  assert.deepEqual(current.changes, []);
  assert.ok(!('layers' in current), 'an unchanged read stays compact');

  // Every view agrees on the same window.
  for (const view of ['summary', 'changes', 'full', 'affected']) {
    const body = await read(app, `?since=1&view=${view}`, key);
    assert.equal(body.changed, true, view);
    assert.equal(body.unchanged, false, view);
    assert.equal(body.hasUserChanges, true, view);
    assert.equal(body.hasAgentChanges, true, view);
    assert.equal(body.sinceVersion, 1, view);
  }
  const full = await read(app, '?view=full&since=3', key);
  assert.equal(full.changed, false);
  assert.equal(full.unchanged, true);
  assert.ok(Array.isArray(full.layers), 'full still returns the map');
});

test('REL-02 omitting since keeps the "after the last Agent write" window', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('delta', input);
  const bare = await read(app, '', map.editKey);
  assert.equal(bare.changed, false, 'the Agent just wrote v1, so nothing is new for it');
  assert.equal(bare.unchanged, true);
  assert.ok(Array.isArray(bare.layers), 'without since the caller still gets the map');

  await store.edit('delta', map.editKey!, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '用户改动' }], undefined, 'user');
  const afterUser = await read(app, '', map.editKey);
  assert.equal(afterUser.changed, true);
  assert.equal(afterUser.hasUserChanges, true);
  assert.equal(afterUser.hasAgentChanges, false);
  assert.equal(afterUser.sinceVersion, 1, 'the window is the Agent cursor, reported explicitly');

  // An Agent write moves the cursor; a replay of the same edit does not add a version.
  await store.edit('delta', map.editKey!, 2, [{ op: 'point.update', layerId: 'route', pointId: 'b', patch: { day: 2 } }], 'retry-1', 'agent');
  const afterAgent = await read(app, '', map.editKey);
  assert.equal(afterAgent.changed, false);
  assert.equal(afterAgent.sinceVersion, 3);
  const replay = await store.edit('delta', map.editKey!, 2, [{ op: 'point.update', layerId: 'route', pointId: 'b', patch: { day: 2 } }], 'retry-1', 'agent');
  assert.equal(replay.version, 3, 'requestId replay returns the same version');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE map_id=?').get('delta')!.n, 3);
});

test('REL-02 event pages keep the flags honest', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('delta', input);
  for (let i = 0; i < 45; i += 1) {
    await store.edit('delta', map.editKey!, i + 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: `第 ${i} 次` }], undefined, 'user');
  }
  const page = await read(app, '?since=1&view=changes', map.editKey) as Delta & { moreEvents?: boolean; nextSince?: number };
  assert.equal(page.changed, true);
  assert.equal(page.moreEvents, true);
  assert.equal(page.events!.length, 40);
  assert.equal(page.nextSince, 41);
  const next = await read(app, `?since=${page.nextSince}&view=changes`, map.editKey) as Delta & { moreEvents?: boolean };
  assert.equal(next.changed, true);
  assert.equal(next.moreEvents, undefined);
  const done = await read(app, `?since=${next.version}&view=changes`, map.editKey);
  assert.equal(done.changed, false);
  assert.equal(done.unchanged, true);
});

test('API-01 unknown operations and unknown patch fields are rejected, never half-applied', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('strict', input);
  const headers = { authorization: `Bearer ${map.editKey}` };

  // The exact call from the report: a points array smuggled into layer.update.
  const smuggled = await app.inject({ method: 'PATCH', url: '/m/strict', headers, payload: { baseVersion: 1, operations: [
    { op: 'layer.update', layerId: 'route', patch: { name: '改过的名字', points: [{ name: '新点', at: [1, 2] }] } },
  ] } });
  assert.equal(smuggled.statusCode, 400, smuggled.body);
  const error = smuggled.json() as { error: string; hint: string; issues: Array<{ path: string; message: string; unknownFields?: string[] }> };
  assert.match(error.error, /未知字段「points」/);
  assert.equal(error.issues[0].path, '[0].patch');
  assert.deepEqual(error.issues[0].unknownFields, ['points']);
  assert.match(error.issues[0].message, /points\.reorder/);
  assert.equal(store.get('strict').version, 1, 'nothing was written');
  assert.equal(store.get('strict').layers[0].name, '自驾', 'not even the part that was valid');

  const unknownOp = await app.inject({ method: 'PATCH', url: '/m/strict', headers, payload: { baseVersion: 1, operations: [{ op: 'point.move', layerId: 'route', pointId: 'a' }] } });
  assert.equal(unknownOp.statusCode, 400, unknownOp.body);
  assert.match((unknownOp.json() as { error: string }).error, /op 只能是/);
  assert.match((unknownOp.json() as { error: string }).error, /points\.reorder/);
  assert.equal(store.get('strict').version, 1);
});

test('API-01 the closure reaches nested edit payloads, not just the top level', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('nested', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  const patch = (operations: unknown[]) => app.inject({ method: 'PATCH', url: '/m/nested', headers, payload: { baseVersion: store.get('nested').version, operations } });

  // A typo one level down used to return 200 with the name applied and the
  // whole routing object quietly reduced to `{source}`.
  const typo = await patch([{ op: 'layer.update', layerId: 'route', patch: { name: 'changed', routing: { source: 'caller', durationMinuts: 12 } } }]);
  assert.equal(typo.statusCode, 400, typo.body);
  assert.match((typo.json() as { error: string }).error, /未知字段「durationMinuts」/);
  assert.match((typo.json() as { error: string }).error, /\[0\]\.patch\.routing/);
  assert.equal(store.get('nested').version, 1, 'nothing was written');
  assert.equal(store.get('nested').layers[0].name, '自驾', 'not even the valid half');

  for (const [operations, where] of [
    [[{ op: 'layer.update', layerId: 'route', patch: { routing: { source: 'x', legs: [{ fromPointId: 'a', toPointId: 'b', durationMin: 5 }] } } }], /legs/],
    [[{ op: 'layer.add', layer: { name: '新层', colour: '#ff0000' } }], /layer/],
    [[{ op: 'layer.add', layer: { name: '新层', points: [{ name: 'p', at: [1, 2], category: 'hotel' }] } }], /point/],
    [[{ op: 'layer.add', layer: { name: '新层', routing: { source: 'x', profil: 'driving' } } }], /routing/],
  ] as Array<[unknown[], RegExp]>) {
    const rejected = await patch(operations);
    assert.equal(rejected.statusCode, 400, JSON.stringify(operations));
    assert.match((rejected.json() as { error: string }).error, where);
  }
  assert.equal(store.get('nested').version, 1);

  // Undo replays a layer read back from a snapshot: Cartula's own derived
  // fields are tolerated and dropped, so the round trip keeps working.
  const replayed = await patch([{ op: 'layer.add', layer: {
    id: 'undone', name: '撤销恢复的层', kind: 'route', color: '#123456', visible: true, crs: 'wgs84',
    points: [{ id: 'x', name: '甲', at: [1, 2] }],
    stats: { distanceKm: 9, days: 1, distanceKind: 'straight', pointCount: 1 },
    edited_by: 'user', inputCrs: 'gcj02', routingStatus: { geometry: 'resolved', coordinates: 4 },
  } }]);
  assert.equal(replayed.statusCode, 200, replayed.body);
  const added = store.get('nested').layers.find(layer => layer.id === 'undone')!;
  assert.equal(added.name, '撤销恢复的层');
  assert.equal(added.stats.pointCount, 1, 'stats are recomputed, not taken from the payload');
  assert.equal(added.routingStatus, undefined, 'a caller cannot plant provenance through layer.add');
  assert.equal(added.inputCrs, undefined);
  assert.equal(added.edited_by, 'agent');
  const event = store.get('nested', 1).events.at(-1)!;
  assert.ok(!JSON.stringify(event.operations).includes('"stats"'), 'derived fields do not enter the event log');

  // GeoJSON keeps the standard's own leniency: free-form properties and legal
  // foreign members are data, not contract mistakes.
  const geo = await patch([{ op: 'layer.add', layer: { name: '边界', geojson: { type: 'FeatureCollection', features: [
    { type: 'Feature', bbox: [0, 0, 1, 1], geometry: { type: 'Point', coordinates: [1, 2] }, properties: { 任意键: 1, nested: { anything: true } } },
  ] } } }]);
  assert.equal(geo.statusCode, 200, geo.body);
  assert.deepEqual(store.get('nested').layers.at(-1)!.geojson?.features[0].properties, { 任意键: 1, nested: { anything: true } });
});

test('API-01 points.reorder validates the whole permutation atomically', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('seq', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  const patch = (operations: unknown[], baseVersion = store.get('seq').version) =>
    app.inject({ method: 'PATCH', url: '/m/seq', headers, payload: { baseVersion, operations } });

  for (const [pointIds, expected] of [
    [['a', 'b'], /缺少的 id：c/],
    [['a', 'b', 'c', 'c'], /重复的 id：c/],
    [['a', 'b', 'z'], /不存在的 id：z/],
  ] as const) {
    const bad = await patch([{ op: 'points.reorder', layerId: 'route', pointIds }]);
    assert.equal(bad.statusCode, 400, JSON.stringify(pointIds));
    assert.match((bad.json() as { error: string }).error, expected);
    assert.equal(store.get('seq').version, 1, 'a rejected reorder writes nothing');
  }

  // A whole reversal in one operation, with the stops and legs kept intact.
  const reversed = await patch([{ op: 'points.reorder', layerId: 'route', pointIds: ['c', 'b', 'a'] }]);
  assert.equal(reversed.statusCode, 200, reversed.body);
  assert.deepEqual(store.get('seq').layers[0].points.map(point => point.id), ['c', 'b', 'a']);
  assert.match(store.get('seq', 1).changes.join(' '), /整段反转/);

  // Reordering to the current order changes nothing and creates no version.
  const noop = await patch([{ op: 'points.reorder', layerId: 'route', pointIds: ['c', 'b', 'a'] }]);
  assert.equal(noop.statusCode, 200, noop.body);
  assert.equal(store.get('seq').version, 2);

  // The single-point form still works next to it.
  const single = await patch([{ op: 'point.reorder', layerId: 'route', pointId: 'a', toIndex: 0 }]);
  assert.equal(single.statusCode, 200, single.body);
  assert.deepEqual(store.get('seq').layers[0].points.map(point => point.id), ['a', 'c', 'b']);
});

test('REL-02 the handoff still summarises the whole round after a submit', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('handoff', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  await store.edit('handoff', map.editKey!, 1, [{ op: 'annotate', layerId: 'route', pointId: 'b', text: '这一站想住两晚' }], undefined, 'user');
  const submitted = await app.inject({ method: 'POST', url: '/api/maps/handoff/submit', headers, payload: { baseVersion: 1, userMessage: '少开点车' } });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const body = submitted.json() as { message: string; changed: boolean; hasUserChanges: boolean; sinceVersion: number };
  assert.match(body.message, /这一站想住两晚/, 'a change made before the submit is still in the handoff');
  assert.match(body.message, /少开点车/);
  assert.equal(body.changed, true);
  assert.equal(body.hasUserChanges, true);
  assert.equal(body.sinceVersion, 1);
});

test('UI-02 a submit whose response was lost commits exactly once', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('submit', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  const submit = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/maps/submit/submit', headers, payload });
  const drafts = () => store.get('submit', 0).events.flatMap(event => event.operations as Array<{ op: string }>).filter(op => op.op === 'draft.commit').length;

  // The client's requestId is derived from (mapId, baseVersion, userMessage) and
  // the batch from (userMessage, intents), so a retry is byte-identical. This
  // test is also what pins that purity: put a timestamp, a random id or the
  // version into the batch and the retry below fails with "请求 ID 已用于不同操作".
  const first = await submit({ baseVersion: 1, userMessage: '少开车', intents: [{ scope: 'map', text: '少开车', priority: 'prefer' }], requestId: 'submit-abc' });
  assert.equal(first.statusCode, 200, first.body);
  const version = store.get('submit').version;
  assert.equal(drafts(), 1);

  // The response was lost, the client polled and saw the new version, the user
  // pressed the button again: the request-id replay answers before any version
  // check, so nothing is written twice.
  const retry = await submit({ baseVersion: 1, userMessage: '少开车', intents: [{ scope: 'map', text: '少开车', priority: 'prefer' }], requestId: 'submit-abc' });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(store.get('submit').version, version, 'the replay created no second version');
  assert.equal(drafts(), 1, 'and no second draft.commit');

  // Even after somebody else writes, the same retry still de-duplicates rather
  // than turning into a conflict.
  await store.edit('submit', map.editKey!, version, [{ op: 'annotate', layerId: 'route', pointId: 'b', text: '另一端的改动' }], undefined, 'user');
  const late = await submit({ baseVersion: 1, userMessage: '少开车', intents: [{ scope: 'map', text: '少开车', priority: 'prefer' }], requestId: 'submit-abc' });
  assert.equal(late.statusCode, 200, late.body);
  assert.equal(drafts(), 1);

  // A different submission is a different requestId, and it is accepted.
  const second = await submit({ baseVersion: 1, userMessage: '再说一句', requestId: 'submit-def' });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(drafts(), 2);
});

test('UI-02 a stale submit cannot overwrite another client‘s intent', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  // An intent replaces whatever intent holds its scope, so a stale submit that
  // carries one is a lost update, not an append.
  const map = await store.put('cas', { ...input, intents: [{ scope: 'map', text: 'A' }] });
  const headers = { authorization: `Bearer ${map.editKey}` };
  const submit = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/maps/cas/submit', headers, payload });
  const mapIntent = () => store.get('cas').intents?.find(intent => intent.scope === 'map')?.text;

  // Another client moves the map to v2 with intent B.
  await store.edit('cas', map.editKey!, 1, [{ op: 'intent.set', scope: 'map', text: 'B' }], undefined, 'user');
  assert.equal(mapIntent(), 'B');

  // The stale page submits C against the version it still shows.
  const stale = await submit({ baseVersion: 1, currentVersion: 1, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'fresh-stale' });
  assert.equal(stale.statusCode, 409, stale.body);
  const conflict = stale.json() as { error: string; currentVersion: number; conflictingChanges: string[] };
  assert.equal(conflict.error, 'VERSION_CONFLICT');
  assert.equal(conflict.currentVersion, 2);
  assert.match(conflict.conflictingChanges.join(' '), /B/);
  assert.equal(store.get('cas').version, 2, 'the refused submit created no version');
  assert.equal(mapIntent(), 'B', 'and B survived');

  // The user rereads and retries with a fresh requestId and a fresh version.
  const retried = await submit({ baseVersion: 1, currentVersion: 2, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'after-conflict' });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(store.get('cas').version, 3);
  assert.equal(mapIntent(), 'C');

  // That submission's response is lost: the same requestId replays once.
  const replay = await submit({ baseVersion: 1, currentVersion: 2, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'after-conflict' });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(store.get('cas').version, 3, 'no second version');

  // Someone else writes D, and the same replay arrives late: it must not
  // resurrect C over D.
  await store.edit('cas', map.editKey!, 3, [{ op: 'intent.set', scope: 'map', text: 'D' }], undefined, 'user');
  const late = await submit({ baseVersion: 1, currentVersion: 2, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'after-conflict' });
  assert.equal(late.statusCode, 200, late.body);
  assert.equal(store.get('cas').version, 4);
  assert.equal(mapIntent(), 'D', 'the replay returned its old result without rewriting');

  // A version the map never had is a client bug, not a stale read.
  const ahead = await submit({ baseVersion: 1, currentVersion: 99, userMessage: 'C' });
  assert.equal(ahead.statusCode, 400, ahead.body);
  assert.equal((ahead.json() as { code: string }).code, 'UNKNOWN_VERSION');
  assert.equal(store.get('cas').version, 4);
});

test('UI-02 submit_changes applies the same concurrency rule through MCP', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('cas-mcp', { ...input, intents: [{ scope: 'map', text: 'A' }] });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const submit = (args: Record<string, unknown>) => client.callTool({ name: 'submit_changes', arguments: { id: map.id, editKey: map.editKey, ...args } });
  const mapIntent = () => store.get('cas-mcp').intents?.find(intent => intent.scope === 'map')?.text;
  const errorOf = (result: Awaited<ReturnType<typeof submit>>) =>
    JSON.parse((result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? '{}') as { error: string; code?: string; currentVersion?: number };

  await store.edit('cas-mcp', map.editKey!, 1, [{ op: 'intent.set', scope: 'map', text: 'B' }], undefined, 'user');
  const stale = await submit({ baseVersion: 1, currentVersion: 1, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'mcp-stale' });
  assert.ok(stale.isError, JSON.stringify(stale.content));
  assert.equal(errorOf(stale).error, 'VERSION_CONFLICT');
  assert.equal(errorOf(stale).currentVersion, 2);
  assert.equal(mapIntent(), 'B');
  assert.equal(store.get('cas-mcp').version, 2);

  const ok = await submit({ baseVersion: 1, currentVersion: 2, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'mcp-ok' });
  assert.ok(!ok.isError, JSON.stringify(ok.content));
  assert.equal(mapIntent(), 'C');
  const replay = await submit({ baseVersion: 1, currentVersion: 2, userMessage: 'C', intents: [{ scope: 'map', text: 'C' }], requestId: 'mcp-ok' });
  assert.ok(!replay.isError, JSON.stringify(replay.content));
  assert.equal(store.get('cas-mcp').version, 3, 'the replay wrote nothing');

  const ahead = await submit({ baseVersion: 1, currentVersion: 99, userMessage: 'C' });
  assert.ok(ahead.isError);
  assert.equal(errorOf(ahead).code, 'UNKNOWN_VERSION');
});

test('UI-02 a submit that replaces nothing reports a stale view instead of refusing it', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('view', input);
  const headers = { authorization: `Bearer ${map.editKey}` };
  const submit = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/maps/view/submit', headers, payload });

  // Advertised and ignored is the failure mode; refuse it by name.
  const smuggled = await submit({ baseVersion: 1, changes: [{ op: 'point.delete', layerId: 'route', pointId: 'a' }] });
  assert.equal(smuggled.statusCode, 400, smuggled.body);
  assert.equal((smuggled.json() as { code: string; field: string }).code, 'UNSUPPORTED_FIELD');
  assert.equal((smuggled.json() as { field: string }).field, 'changes');
  assert.equal(store.get('view').version, 1, 'a refused submit writes nothing');

  // No intents: this submission records a draft commit and a handoff message
  // and replaces nothing, so a stale view is reported rather than refused.
  // (A submit carrying intents is checked — see the concurrency test above.)
  await store.edit('view', map.editKey!, 1, [{ op: 'annotate', layerId: 'route', pointId: 'b', text: '另一端的改动' }], undefined, 'user');
  const stale = await submit({ baseVersion: 1, currentVersion: 1, userMessage: '少开车', requestId: 'submit-1' });
  assert.equal(stale.statusCode, 200, stale.body);
  const body = stale.json() as { clientVersion: number; staleView: boolean; changesSinceClientVersion: string[]; version: number };
  assert.equal(body.clientVersion, 1);
  assert.equal(body.staleView, true);
  assert.match(body.changesSinceClientVersion.join(' '), /另一端的改动/);
  assert.equal(body.version, 3, 'the handoff was still recorded');

  // Up to date: reported as such.
  const fresh = await submit({ baseVersion: 1, currentVersion: 3, userMessage: '再说一句', requestId: 'submit-2' });
  assert.equal((fresh.json() as { staleView: boolean }).staleView, false);
  assert.equal((fresh.json() as { changesSinceClientVersion?: string[] }).changesSinceClientVersion, undefined);

  // Omitting it says nothing, as before.
  const silent = await submit({ baseVersion: 1, userMessage: '第三句', requestId: 'submit-3' });
  assert.equal((silent.json() as { staleView?: boolean }).staleView, undefined);

  // The envelope is closed: a misspelt field is reported, not dropped.
  const typo = await submit({ baseVersion: 1, userMessag: '少开车' });
  assert.equal(typo.statusCode, 400, typo.body);
  assert.match((typo.json() as { error: string }).error, /未知字段「userMessag」/);
  const badIntent = await submit({ baseVersion: 1, intents: [{ scope: 'map', text: '少开车', priorty: 'must' }] });
  assert.equal(badIntent.statusCode, 400, badIntent.body);
  assert.match((badIntent.json() as { error: string }).error, /priorty|intent/);
});

test('UI-02 submit_changes reports a stale view through MCP without failing', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('readonly', input);
  await store.edit('readonly', map.editKey!, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '用户改动' }], undefined, 'user');
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

  assert.ok((await client.callTool({ name: 'submit_changes', arguments: { id: map.id, baseVersion: 1, currentVersion: 1 } })).isError, 'a private map is not readable without a credential');
  const stale = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, spaceKey: map.editKey, baseVersion: 1, currentVersion: 1 } });
  assert.ok(!stale.isError, JSON.stringify(stale.content));
  const structured = stale.structuredContent as { clientVersion: number; staleView: boolean; changesSinceClientVersion: string[] };
  assert.equal(structured.clientVersion, 1);
  assert.equal(structured.staleView, true);
  assert.match(structured.changesSinceClientVersion.join(' '), /用户改动/);
  assert.match((stale.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? '', /你提交时看到的是 v1/);

  // The stale submit above still recorded its draft commit, so "up to date"
  // means the version that write produced.
  const fresh = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, spaceKey: map.editKey, baseVersion: 1, currentVersion: store.get(map.id).version } });
  assert.equal((fresh.structuredContent as { staleView: boolean }).staleView, false);
});

test('UI-02 submit_changes carries the whole map in the hidden App channel', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  // Two layers, one of them carrying real geometry, so the affected view can
  // legitimately omit a layer the App still has to draw.
  const map = await store.put('handoff-app', { title: '两层', layers: [
    { id: 'route', name: '自驾', points: [{ id: 'a', name: '甲', at: [126.6, 45.7] }, { id: 'b', name: '乙', at: [127.5, 46.3] }],
      path: [[126.6, 45.7], [127.0, 46.0], [127.5, 46.3]] },
    { id: 'spots', name: '候选点', kind: 'spots', points: [{ id: 's1', name: '温泉', at: [128.2, 47.1] }] },
  ] });
  await store.edit('handoff-app', map.editKey!, 1, [{ op: 'annotate', layerId: 'route', pointId: 'b', text: '住一晚' }], undefined, 'user');
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

  const submitted = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, currentVersion: 2, userMessage: '少开车' } });
  assert.ok(!submitted.isError, JSON.stringify(submitted.content));

  // What the model sees: the affected subset, no geometry, no credentials.
  const shown = submitted.structuredContent as { view: string; layers?: Array<{ id: string; pathCoordinateCount?: number }>; message: string };
  assert.equal(shown.view, 'affected');
  assert.deepEqual(shown.layers?.map(layer => layer.id), ['route'], 'the untouched layer is absent from the summary');
  const exposed = JSON.stringify({ content: submitted.content, structuredContent: submitted.structuredContent });
  assert.ok(!exposed.includes('"path":['), 'no geometry in the model-visible summary');
  assert.ok(!exposed.includes(map.editKey!), 'no edit key in the model-visible summary');

  // What the App sees: the whole snapshot, geometry included, plus the basemap.
  const context = submitted._meta?.cartula as { map: MapSnapshot; editKey?: string; tileUrl: string; tileAttribution: string; styleUrl?: string };
  assert.ok(context, 'the tool advertises the App resource, so it must send the App context');
  assert.deepEqual(context.map.layers.map(layer => layer.id), ['route', 'spots'], 'every layer, not just the affected one');
  assert.equal(context.map.layers[0].path?.length, 3, 'geometry the summary omitted');
  assert.equal(context.map.version, store.get(map.id).version);
  assert.equal(context.map.title, '两层');
  assert.equal(context.editKey, map.editKey, 'the caller proved it holds the key');
  assert.ok(context.tileUrl.length > 0);
  assert.ok(context.tileAttribution.length > 0);

  // A share token opens the App read-only: the whole map, and no rights invented.
  const share = await client.callTool({ name: 'share_map', arguments: { id: map.id, spaceKey: map.editKey } });
  const previewToken = (share.structuredContent as { previewToken: string }).previewToken;
  const readOnly = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, previewToken, baseVersion: 1 } });
  assert.ok(!readOnly.isError, JSON.stringify(readOnly.content));
  const readOnlyContext = readOnly._meta?.cartula as { map: MapSnapshot; editKey?: string; spaceKey?: string; previewToken?: string; access: { kind: string; editable: boolean } };
  assert.equal(readOnlyContext.map.layers.length, 2);
  assert.equal(readOnlyContext.editKey, undefined);
  assert.equal(readOnlyContext.spaceKey, undefined, 'a preview context never carries the space key');
  assert.equal(readOnlyContext.previewToken, previewToken);
  assert.equal(readOnlyContext.access.kind, 'preview');
  assert.equal(readOnlyContext.access.editable, false);
  assert.equal(store.get(map.id).version, 3, 'a read-only submit records nothing');

  // No credential at all: nothing, not even a read-only view.
  const anonymous = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, baseVersion: 1 } });
  assert.ok(anonymous.isError);
  assert.equal(anonymous._meta?.cartula, undefined);

  // A wrong key fails before anything is read, and leaks neither key nor map.
  const denied = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, spaceKey: `csk_${'x'.repeat(32)}`, baseVersion: 1 } });
  assert.ok(denied.isError);
  assert.equal(denied._meta?.cartula, undefined);
  const deniedBody = JSON.stringify(denied);
  assert.ok(!deniedBody.includes(map.editKey!));
  assert.ok(!deniedBody.includes('"layers"'));
});

test('the published contracts describe the delta flags and the submit rules', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const openapi = (await app.inject('/openapi.json')).json() as {
    paths: Record<string, { get?: { parameters: Array<{ name: string; description: string }>; responses: Record<string, { description: string }> }; post?: { description: string; responses: Record<string, { description: string }> } }>;
  };
  const read = openapi.paths['/m/{id}'].get!;
  assert.match(read.parameters.find(parameter => parameter.name === 'since')!.description, /不论出自用户还是 Agent/);
  assert.match(read.responses['200'].description, /hasUserChanges/);
  assert.match(read.responses['200'].description, /unchanged/);
  const submit = openapi.paths['/api/maps/{id}/submit'].post!;
  assert.match(submit.description, /409 VERSION_CONFLICT/);
  assert.match(submit.description, /changes 会被 400 拒绝/);
  assert.match(submit.description, /重放先于版本校验/);
  assert.ok(submit.responses['409']);

  // The hand-off boundary is a separate contract from submitting: it records a
  // delivery the view confirmed, and it must not read as another way to write.
  const handoff = openapi.paths['/api/maps/{id}/handoff'].post!;
  assert.match(handoff.description, /不写版本、事件或改动记录/);
  assert.match(handoff.description, /边界只前进/);
  assert.match(handoff.description, /UNKNOWN_VERSION/);
  assert.match(handoff.description, /只读分享令牌不能移动边界/);
  for (const status of ['200', '400', '403', '404']) assert.ok(handoff.responses[status], status);
  assert.match(handoff.responses['200'].description, /handoffVersion/);
  assert.match(handoff.responses['200'].description, /agentVersion/);

  // /llms.txt is the deployment's overview: it carries the Skill's essentials
  // verbatim and points at the Skill itself rather than restating the contract.
  const skill = readFileSync(new URL('../skills/cartula/SKILL.md', import.meta.url), 'utf8');
  const essentials = skill.slice(skill.indexOf('## essentials'), skill.indexOf('## quickstart')).replace(/^## .*\n+/, '').trimEnd();
  const llms = (await app.inject('/llms.txt')).body;
  assert.ok(llms.includes(essentials), 'the overview carries the essentials word for word');
  assert.ok(!llms.includes('## quickstart'), 'the overview links to the rest of the Skill instead of copying it');
  assert.equal((await app.inject('/llms-full.txt')).body, `${llms}\n---\n\n${skill}`, 'the full text is the overview followed by the installable Skill');
});

test('API-01 the model-visible contract carries the operations and short examples', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const tools = (await client.listTools()).tools;
  const patchTool = tools.find(tool => tool.name === 'patch_map')!;
  const advertised = JSON.stringify(patchTool);
  for (const fragment of ['points.reorder', 'point.reorder', 'intent.set', 'layer.add', 'toIndex', 'pointIds']) {
    assert.ok(advertised.includes(fragment), fragment);
  }
  assert.ok(String(patchTool.description).includes('{"op":"point.update"'), 'the description shows a usable example');
  assert.ok(String(patchTool.description).includes('未知 patch 字段会被拒绝'), 'and says unknown fields are rejected');
  const getTool = tools.find(tool => tool.name === 'get_map')!;
  assert.ok(String(getTool.description).includes('hasUserChanges'), 'the delta contract is discoverable');

  // The tool boundary rejects the smuggled field with a path, not "Invalid input".
  const map = await store.put('advertised', input);
  const rejected = await client.callTool({ name: 'patch_map', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, operations: [
    { op: 'layer.update', layerId: 'route', patch: { name: 'x', points: [] } },
  ] } }).catch((error: Error) => error);
  const text = rejected instanceof Error ? rejected.message : JSON.stringify(rejected.content);
  assert.match(text, /points/);
  assert.match(text, /operations\[0\]\.patch|patch/);
  assert.equal(store.get('advertised').version, 1);

  // Conflicts and idempotent replay still behave.
  const ok = await client.callTool({ name: 'patch_map', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, requestId: 'once', operations: [
    { op: 'points.reorder', layerId: 'route', pointIds: ['c', 'b', 'a'] },
  ] } });
  assert.ok(!ok.isError, JSON.stringify(ok.content));
  const replay = await client.callTool({ name: 'patch_map', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, requestId: 'once', operations: [
    { op: 'points.reorder', layerId: 'route', pointIds: ['c', 'b', 'a'] },
  ] } });
  assert.ok(!replay.isError, JSON.stringify(replay.content));
  assert.equal(store.get(map.id).version, 2, 'the replay did not create a second version');
  const conflict = await client.callTool({ name: 'patch_map', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, operations: [
    { op: 'points.reorder', layerId: 'route', pointIds: ['a', 'b', 'c'] },
  ] } });
  assert.ok(conflict.isError);
  assert.match((conflict.content as Array<{ text?: string }>)[0].text ?? '', /VERSION_CONFLICT/);
});

/**
 * The App has to be *findable*, which is a separate contract from being right.
 *
 * A host renders whatever URI the tool points at, and caches what it reads from
 * one. A fixed URI plus a caching host is a deploy nobody can observe: the
 * server serves the new HTML to everyone who asks, and the host never asks.
 * Two rounds of size fixes were verified live on the server and never reached
 * the card, which is what these assertions are for.
 */
test('UI-04 the App resource is named for its build, and every reference agrees', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

  // The name carries the release, so a new build is a new URI — nothing a host
  // already holds can answer for it.
  assert.equal(RESOURCE_URI, `ui://cartula/map.${resourceTag(RELEASE)}.html`);
  assert.notEqual(RESOURCE_URI, LEGACY_RESOURCE_URI);
  assert.equal(resourceTag('0.3.0+abc1234'), '0.3.0-abc1234', 'one path segment, no "+"');
  assert.equal(resourceTag('0.3.0'), '0.3.0');

  // Published, and the compatibility alias with it: a host that kept an older
  // tool definition must still get HTML rather than a missing resource.
  const listed = (await client.listResources()).resources.map(resource => resource.uri);
  assert.ok(listed.includes(RESOURCE_URI), `${RESOURCE_URI} not in ${listed.join(', ')}`);
  assert.ok(listed.includes(LEGACY_RESOURCE_URI), 'the old address still answers');

  // Every tool that renders the App points at the current build, never the
  // alias — the alias is a fallback, not something new sessions are sent to.
  const uiRef = (meta: unknown) => {
    const bag = meta as { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string } | undefined;
    return bag?.ui?.resourceUri ?? bag?.['ui/resourceUri'];
  };
  const tools = (await client.listTools()).tools;
  const rendering = tools.filter(tool => uiRef(tool._meta));
  assert.ok(rendering.length >= 5, 'the map tools declare a UI resource');
  for (const tool of rendering) assert.equal(uiRef(tool._meta), RESOURCE_URI, tool.name);

  // Both names serve the same current build, so which one a host asks for only
  // decides how stale its cache may be, never whether it works.
  const body = async (uri: string) => {
    const contents = (await client.readResource({ uri })).contents[0] as { uri: string; mimeType?: string; text: string };
    assert.equal(contents.uri, uri, 'the answer names the URI that was asked for');
    assert.equal(contents.mimeType, 'text/html;profile=mcp-app');
    return contents.text;
  };
  assert.equal(await body(RESOURCE_URI), await body(LEGACY_RESOURCE_URI));

  // And any release's name, including ones this build has never heard of. A
  // host caches `_meta.ui.resourceUri`, so after a deploy it may ask for the
  // *previous* release's address; answering "no such resource" would render
  // nothing at all, which is worse than the stale copy versioning prevents.
  const current = await body(RESOURCE_URI);
  for (const stale of ['ui://cartula/map.0.3.0-ecf2652.html', 'ui://cartula/map.0.2.0.html', 'ui://cartula/map.0.9.9-future.html']) {
    assert.equal(await body(stale), current, stale);
  }
  // Only the current release is advertised, though: the fallback is a safety
  // net for names already in the wild, not a set of addresses to hand out.
  assert.equal(listed.filter(uri => uri.startsWith('ui://cartula/map.')).length, 2, listed.join(', '));

  // The read-out is a deployment opt-in, and a default build is not opted in.
  assert.ok(!current.includes('"diagnostics":true'), 'CARTULA_DIAGNOSTICS is off unless a deployment sets it');

  // And the result names it too, for a host that reads the linkage there.
  const made = await store.put('findable', { title: '可发现', layers: [{ id: 'route', name: '路线', points: [
    { id: 'a', name: '甲', at: [126.6, 45.7] }, { id: 'b', name: '乙', at: [127.5, 46.3] },
  ] }] });
  // Reads are private, so the credential travels with the call; without it the
  // result is a refusal, which carries no App linkage and proves nothing.
  const result = await client.callTool({ name: 'get_map', arguments: { id: 'findable', spaceKey: made.spaceKey ?? made.editKey } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(uiRef(result._meta), RESOURCE_URI);
});
