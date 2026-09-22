import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { planningMessage, agentAdjustmentText } from '../src/web/handoff.js';
import { MAP_URL_LABEL } from '../src/core/handoff.js';
import { toolSchema } from '../src/server/tool-schema.js';
import { MapInputSchema } from '../src/core/schema.js';
import type { MapInput } from '../src/core/types.js';

const input: MapInput = { title: '法国到瑞士', layers: [{ id: 'route', name: '自驾', points: [
  { id: 'nice', name: '尼斯', at: [7.26, 43.70] }, { id: 'geneva', name: '日内瓦', at: [6.14, 46.20] },
], path: Array.from({ length: 4502 }, (_, i) => [7.26 - i / 5000, 43.7 + i / 2000]),
  routing: { source: 'OSRM', distanceKm: 1554, durationMinutes: 1080 } }] };

test('MCP model schemas advertise portable arrays and explicit creation without replacement', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'feedback-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const server = await (await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })).json() as { result?: { instructions?: string } };
  const listed = await client.listTools();
  const tools = listed.tools;
  const listedNames = tools.map(tool => tool.name);
  const instructions = server.result?.instructions ?? '';
  for (const name of ['create_map', 'patch_map', 'get_map', 'submit_changes']) {
    assert.ok(instructions.includes(name), name);
    assert.ok(listedNames.includes(name), name);
  }
  const creation = tools.find(tool => tool.name === 'create_map')!;
  assert.equal(creation.annotations?.destructiveHint, false);
  assert.equal(tools.find(tool => tool.name === 'patch_map')!.annotations?.destructiveHint, false);
  const getMap = tools.find(tool => tool.name === 'get_map')!;
  assert.ok(JSON.stringify(getMap).includes('affected'));
  assert.ok(JSON.stringify(getMap).includes('includeGeometry'));
  assert.deepEqual((creation._meta?.ui as { visibility: string[] }).visibility, ['model', 'app']);
  function checkSchema(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    // Host converters (observed: Doubao) drop the whole tool when its schema
    // carries any of these. Keep the wire schema to the lowest common
    // denominator; src/server/tool-schema.ts is what enforces it.
    for (const keyword of ['prefixItems', 'oneOf', 'anyOf', 'allOf', 'const', 'pattern', 'propertyNames', 'exclusiveMinimum', 'exclusiveMaximum', '$ref', '$defs', 'definitions']) {
      assert.ok(!(keyword in v), `model schemas must not use ${keyword}`);
    }
    assert.ok(!Array.isArray(v.items), 'model schemas must not use tuple items arrays');
    Object.values(v).forEach(checkSchema);
  }
  tools.forEach(tool => checkSchema(tool.inputSchema));
  const result = await client.callTool({ name: 'create_map', arguments: { id: 'portable', map: input } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(store.get('portable').layers[0].routing?.distanceKm, 1554);
  assert.ok(JSON.stringify(result.content).includes('#space='), 'editable URL is explicit for the owner');
  assert.ok(JSON.stringify(result.structuredContent).includes('"spaceKey"'), 'the space key is returned once, on creation');
  assert.ok((await client.callTool({ name: 'create_map', arguments: { id: 'portable', map: { layers: [] } } })).isError);
  assert.equal(store.get('portable').version, 1);
  const invalid = await client.callTool({ name: 'create_map', arguments: { map: { layers: [{ name: '错误纬度', points: [{ name: '错误点', at: [120, 99] }] }] } } });
  assert.ok(invalid.isError, 'portable schema must retain core coordinate validation');
});

test('toolSchema caches per looseFields set, not just per schema', () => {
  // The same core schema is shared by several tools with different loosening
  // sets; a cache keyed only by the schema would hand one tool another's
  // conversion silently.
  const full = toolSchema(MapInputSchema);
  const loosened = toolSchema(MapInputSchema, { looseFields: ['geojson'] });
  const loosenedAgain = toolSchema(MapInputSchema, { looseFields: ['geojson'] });
  assert.equal(loosened, loosenedAgain, 'same opts hit the cache');
  assert.notEqual(full, loosened, 'different opts produce different conversions');
  const fullShape = (full as unknown as { def: { shape: Record<string, unknown> } }).def.shape;
  const looseShape = (loosened as unknown as { def: { shape: Record<string, unknown> } }).def.shape;
  assert.ok(fullShape.layers, 'unloosened schema keeps its structure');
  assert.ok(looseShape.layers, 'loosened schema keeps layers too');
});

test('MCP summary and unchanged reads keep thousands of road coordinates out of model context', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'feedback-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('large', input);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const summary = await client.callTool({ name: 'get_map', arguments: { id: map.id, spaceKey: map.editKey } });
  const exposed = JSON.stringify({ content: summary.content, structuredContent: summary.structuredContent });
  assert.ok(exposed.length < 6000, `summary was ${exposed.length} characters`);
  assert.ok(!exposed.includes('"path":['));
  assert.ok(exposed.includes('1554'));
  assert.ok(!exposed.includes(map.editKey!));
  assert.equal((summary._meta?.cartula as { map: typeof map }).map.layers[0].path?.length, 4502, 'UI keeps full geometry');
  const unchanged = await client.callTool({ name: 'get_map', arguments: { id: map.id, since: 1, spaceKey: map.editKey } });
  assert.equal((unchanged.structuredContent as { unchanged: boolean }).unchanged, true);
  assert.ok(!('layers' in (unchanged.structuredContent as object)));
  assert.ok(JSON.stringify({ content: unchanged.content, structuredContent: unchanged.structuredContent }).length < 1200);
  const full = await client.callTool({ name: 'get_map', arguments: { id: map.id, view: 'full', spaceKey: map.editKey } });
  assert.equal((full.structuredContent as unknown as typeof map).layers[0].path?.length, 4502);
  assert.ok(JSON.stringify(full.content).length < 1000, 'full read must not duplicate JSON into text');
  await store.edit(map.id, map.editKey, 1, [{ op: 'layer.add', layer: { ...input.layers[0], id: 'second' } }]);
  const delta = await client.callTool({ name: 'get_map', arguments: { id: map.id, since: 1, view: 'changes', spaceKey: map.editKey } });
  assert.ok(!JSON.stringify(delta.structuredContent).includes('"path":['), 'geometry must also be removed from event operations');
  assert.ok(!('layers' in (delta.structuredContent as object)));
});

test('Agent PATCH preserves user notes, records actor and retries without overwriting later edits', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await store.put('patch', input), headers = { authorization: `Bearer ${map.editKey}` };
  await store.edit('patch', map.editKey, 1, [{ op: 'update', layerId: 'route', pointId: 'geneva', patch: { note: '用户刚写的备注', flexibility: 'fixed', intent: '留给瑞士两天' } }]);
  const payload = { baseVersion: 2, requestId: 'agent-local', operations: [
    { op: 'update', layerId: 'route', pointId: 'nice', patch: { day: 1 } }, { op: 'intent', text: '按用户要求保留瑞士住宿' },
  ] };
  assert.equal((await app.inject({ method: 'PATCH', url: '/m/patch', payload })).statusCode, 403);
  const conflict = await app.inject({ method: 'PATCH', url: '/m/patch', headers, payload: { ...payload, baseVersion: 1 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'VERSION_CONFLICT');
  assert.equal(conflict.json().currentVersion, 2);
  assert.ok(Array.isArray(conflict.json().conflictingChanges));
  assert.ok(String(conflict.json().conflictingChanges.join(' ')).includes('瑞士'));
  const updated = await app.inject({ method: 'PATCH', url: '/m/patch', headers, payload });
  assert.equal(updated.statusCode, 200, updated.body);
  const current = store.get('patch', 1);
  assert.equal(current.layers[0].points[1].note, '用户刚写的备注');
  assert.equal(current.layers[0].points[1].flexibility, 'fixed');
  assert.deepEqual(current.events.map(e => e.actor), ['user', 'agent']);
  await store.edit('patch', map.editKey, 3, [{ op: 'annotate', layerId: 'route', pointId: 'nice', text: '后来写的内容' }]);
  assert.equal((await app.inject({ method: 'PATCH', url: '/m/patch', headers, payload })).json().version, 4);
  assert.equal(store.get('patch').layers[0].points[0].note, '后来写的内容');
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/patch/access', headers })).json().editable, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/patch/access' })).statusCode, 403);
  assert.equal((await app.inject({ url: '/m/patch?since=4&view=summary', headers })).json().unchanged, true);
  assert.equal((await app.inject({ url: '/m/patch?view=invalid', headers })).statusCode, 400);
  assert.equal((await app.inject('/m/patch?since=4&view=summary')).statusCode, 403, 'reads are private too');
});

test('planning handoff contains this round of user intent without geometry or editor credentials', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const first = await store.put('handoff', input);
  await store.edit('handoff', first.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'nice', text: '上一轮修改' }]);
  await store.edit('handoff', first.editKey, 2, [{ op: 'delete', layerId: 'route', pointId: 'nice' }, { op: 'intent', text: '把两天加给瑞士' }]);
  const message = planningMessage(store.get('handoff'), 2);
  assert.ok(message.includes('把两天加给瑞士'));
  assert.ok(!message.includes('上一轮修改'));
  assert.ok(message.includes('since=2'));
  assert.ok(message.includes('view="affected"'));
  assert.ok(message.includes('reason'));
  assert.ok(!message.includes(first.editKey!));
  assert.ok(message.length < 3000);
  // RETEST-03: the map's own address is private. Calling it a read-only link
  // invited forwarding it — to someone it would not open for, or together with
  // the key that would make it work. Only share_map mints a share.
  assert.ok(message.includes(`${MAP_URL_LABEL}：${store.get('handoff').url}`), message);
  assert.ok(!message.includes('只读链接'), message);
  assert.ok(message.includes('share_map'), 'the message says where a real share comes from');
  assert.ok(message.includes('当前空间的凭据'), message);
  assert.equal(agentAdjustmentText({ version: 4, changes: ['Agent：改了尼斯'], reason: '把后半段改走瑞士内陆，避开尼斯拥堵' }), 'v4 · 把后半段改走瑞士内陆，避开尼斯拥堵');
  assert.equal(agentAdjustmentText({ version: 2, changes: ['Agent：更新了路段'] }), 'v2 · Agent：更新了路段');
});

test('get_map affected view, submit_changes and VERSION_CONFLICT are first-class', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'feedback-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('loop', input);
  await store.edit(map.id, map.editKey, 1, [{ op: 'point.update', layerId: 'route', pointId: 'geneva', patch: { note: '瑞士多留一天', intent: '留给瑞士两天' } }]);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const affected = await client.callTool({ name: 'get_map', arguments: { id: map.id, since: 1, view: 'affected', spaceKey: map.editKey } });
  const body = JSON.stringify(affected.structuredContent);
  assert.ok(body.includes('geneva'));
  assert.ok(!body.includes('"path":['));
  // submit_changes records intents and a handoff; it never applies operations.
  // Accepting `changes` and quietly ignoring them read as success, so it is now
  // an explicit refusal that names the field and the tool to use instead.
  const smuggled = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, changes: [{ op: 'point.delete', layerId: 'route', pointId: 'nice' }] } });
  assert.ok(smuggled.isError, 'an ignored operations payload must not report success');
  const refusal = JSON.parse((smuggled.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? '{}') as { error: string; code: string; field: string };
  assert.equal(refusal.code, 'UNSUPPORTED_FIELD');
  assert.equal(refusal.field, 'changes');
  assert.equal(store.get(map.id).version, 2, 'the refused submit wrote nothing');

  const submitted = await client.callTool({ name: 'submit_changes', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, currentVersion: 2, userMessage: '减少长途驾驶', intents: [{ scope: 'map', text: '减少长途驾驶', priority: 'prefer' }] } });
  assert.ok(!submitted.isError, JSON.stringify(submitted.content));
  assert.ok(store.get(map.id).intents?.some(intent => intent.text === '减少长途驾驶'));
  assert.equal(store.get(map.id).layers[0].points.some(point => point.id === 'nice'), true, 'submit_changes never deletes a stop');
  const submittedText = (submitted.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? '';
  assert.ok(submittedText.includes('减少长途驾驶'));
  assert.ok(submittedText.includes('view="affected"'));
  assert.ok(!submittedText.includes(map.editKey!));
  const submittedBody = JSON.stringify(submitted.structuredContent);
  assert.ok(submittedBody.includes('减少长途驾驶'));
  assert.ok(submittedBody.includes('"view":"affected"') || submittedBody.includes('affected'));
  assert.ok(!submittedBody.includes(map.editKey!));
  assert.ok(!submittedBody.includes('editUrl'));
  const conflict = await client.callTool({ name: 'patch_map', arguments: { id: map.id, editKey: map.editKey, baseVersion: 1, operations: [{ op: 'point.update', layerId: 'route', pointId: 'nice', patch: { day: 2 } }] } });
  assert.ok(conflict.isError);
  const text = (conflict.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text ?? '';
  const payload = JSON.parse(text) as { error: string; currentVersion: number; conflictingChanges: string[] };
  assert.equal(payload.error, 'VERSION_CONFLICT');
  assert.ok(payload.currentVersion > 1);
  assert.ok(Array.isArray(payload.conflictingChanges));
  assert.ok(payload.conflictingChanges.join(' ').includes('瑞士'));
});

test('affected view keeps layers and points minted without caller ids', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const map = await store.put('minted', { title: 'mint', layers: [{ id: 'route', name: '原线', points: [{ id: 'a', name: '甲', at: [0, 0] }, { id: 'b', name: '乙', at: [1, 0] }] }] });
  await store.edit(map.id, map.editKey, 1, [{ op: 'layer.add', layer: { name: '新层' } }]);
  const added = store.get(map.id);
  const newLayer = added.layers.find(layer => layer.name === '新层')!;
  assert.ok(newLayer.id);
  const owner = { authorization: `Bearer ${map.editKey}` };
  const layerView = (await app.inject({ url: `/m/${map.id}?view=affected&since=1`, headers: owner })).json() as { layers: Array<{ id: string; name: string; points: Array<{ id: string; name: string }> }> };
  assert.ok(layerView.layers.some(layer => layer.id === newLayer.id && layer.name === '新层'));
  const since = added.version;
  await store.edit(map.id, map.editKey, since, [
    { op: 'insert', layerId: 'route', point: { name: '丙', at: [2, 0] } },
    { op: 'point.update', layerId: 'route', pointId: 'b', patch: { note: '改乙' } },
  ]);
  const mixed = store.get(map.id);
  const inserted = mixed.layers[0].points.find(point => point.name === '丙')!;
  const mixedView = (await app.inject({ url: `/m/${map.id}?view=affected&since=${since}`, headers: owner })).json() as { layers: Array<{ id: string; points: Array<{ id: string; name: string }> }> };
  const route = mixedView.layers.find(layer => layer.id === 'route');
  assert.ok(route?.points.some(point => point.id === inserted.id && point.name === '丙'));
  assert.ok(route?.points.some(point => point.id === 'b'));
});

test('REST submit records draft.commit and returns a handoff without credentials', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await store.put('submit', input);
  await store.edit(map.id, map.editKey!, 1, [{ op: 'point.update', layerId: 'route', pointId: 'geneva', patch: { note: '瑞士多留一天' } }]);
  const submitted = await app.inject({ method: 'POST', url: '/api/maps/submit/submit', headers: { authorization: `Bearer ${map.editKey}` }, payload: { baseVersion: 1, userMessage: '减少长途驾驶', intents: [{ scope: 'map', text: '减少长途驾驶', priority: 'prefer' }] } });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const body = submitted.json();
  assert.ok(String(body.message).includes('减少长途驾驶'));
  assert.ok(String(body.message).includes('view="affected"'));
  assert.ok(!JSON.stringify(body).includes(map.editKey!));
  assert.ok(store.get(map.id).intents?.some(intent => intent.text === '减少长途驾驶'));
  assert.ok(store.get(map.id).changes.join(' ').includes('提交草稿') || store.get(map.id, 0).events.some(event => event.operations.some(op => op.op === 'draft.commit')));
});

test('patch_map reason is stored on the agent event and returned to the client', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'feedback-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  const map = await store.put('reason', input);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const patched = await client.callTool({
    name: 'patch_map',
    arguments: {
      id: map.id, editKey: map.editKey, baseVersion: 1, reason: '按用户意图把尼斯改成中途停留',
      operations: [{ op: 'route.leg.update', layerId: 'route', fromPointId: 'nice', toPointId: 'geneva', patch: { durationMinutes: 200, delayMinutes: 25, traffic: 'heavy' } }],
    },
  });
  assert.ok(!patched.isError, JSON.stringify(patched.content));
  const latest = store.get(map.id, 0);
  const event = latest.events.at(-1);
  assert.equal(event?.actor, 'agent');
  assert.equal(event?.reason, '按用户意图把尼斯改成中途停留');
  assert.equal(latest.layers[0].routing?.legs?.[0].delayMinutes, 25);
  assert.equal(latest.layers[0].routing?.legs?.[0].traffic, 'heavy');
});

test('RETEST-03 the private map address is never presented as a share, and carries no key', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'feedback-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const created = await client.callTool({ name: 'create_map', arguments: { id: 'wording', map: input } });
  const key = (created.structuredContent as { spaceKey: string }).spaceKey;
  const textOf = (result: unknown) => (((result as { content?: { type: string; text?: string }[] }).content ?? []).find(item => item.type === 'text')?.text ?? '');

  // A read by the owner: the page URL opens only for a credential the reader
  // already holds, so that is what it is called.
  const read = await client.callTool({ name: 'get_map', arguments: { id: 'wording', spaceKey: key } });
  const owner = textOf(read);
  assert.ok(owner.includes(MAP_URL_LABEL), owner);
  assert.ok(!owner.includes('只读链接'), owner);
  assert.ok(owner.includes('share_map'), 'a real share has its own address');
  assert.ok(!owner.includes(key), 'no credential rides along in the model-visible text');

  // The creation link is the owner's, and says so; it is not a share either.
  const creation = textOf(created);
  assert.ok(creation.includes('#space='));
  assert.ok(creation.includes('不要当作分享'), creation);

  // Only share_map produces something that may be called 只读分享.
  const shared = await client.callTool({ name: 'share_map', arguments: { id: 'wording', spaceKey: key } });
  const share = textOf(shared);
  assert.ok(share.includes('只读分享链接'), share);
  assert.ok(share.includes('#preview='), share);
  assert.ok(!share.includes(key), 'a share never exposes the space key');

  // Read through that share: still an address, still not re-shareable.
  const token = (shared.structuredContent as { previewToken: string }).previewToken;
  const preview = textOf(await client.callTool({ name: 'get_map', arguments: { id: 'wording', previewToken: token } }));
  assert.ok(preview.includes('地图地址（需要当前分享权限）'), preview);
  assert.ok(preview.includes('不能编辑，也不能再分享'), preview);
  assert.ok(!preview.includes(token) && !preview.includes(key), preview);
  assert.equal(store.get('wording').version, 1, 'reading and sharing wrote nothing');
});
