import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { GUIDE_ALIAS, GUIDE_URI, GUIDE_VERSION, SKILL_TEXT } from '../src/server/guide.js';
import type { MapInput, MapLayer, MapSnapshot } from '../src/core/types.js';
import { deltaE } from '../src/web/components/dayColors.js';
import { segmentColor } from '../src/web/components/legs.js';

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  return (Array.isArray(content) ? content : []).filter((item): item is { type: string; text?: string } => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'text')
    .map(item => item.text ?? '').join('\n');
}

test('Cartula publishes one installable Skill through MCP and HTTP fallbacks', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'guide-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const installed = readFileSync(new URL('../skills/cartula/SKILL.md', import.meta.url), 'utf8');
  assert.equal(SKILL_TEXT, installed);
  assert.equal(GUIDE_VERSION, createHash('sha256').update(installed).digest('hex'));
  assert.ok(client.getInstructions()?.includes(GUIDE_URI));
  assert.ok(client.getInstructions()?.includes(GUIDE_ALIAS));
  assert.equal(client.getServerCapabilities()?.prompts?.listChanged, false);
  assert.equal(client.getServerCapabilities()?.resources?.listChanged, false);
  assert.ok(!client.getServerCapabilities()?.resources?.subscribe);

  const resources = await client.listResources();
  const guide = resources.resources.find(item => item.uri === GUIDE_URI)!;
  assert.equal(guide.mimeType, 'text/markdown');
  assert.equal(guide.size, Buffer.byteLength(SKILL_TEXT));
  assert.ok(Number.isFinite(Date.parse(guide.annotations!.lastModified!)));
  assert.equal((guide._meta as { 'cartula/guideVersion': string })['cartula/guideVersion'], GUIDE_VERSION);
  assert.ok(resources.resources.some(item => item.uri === GUIDE_ALIAS));
  assert.notEqual(resources.resources.find(item => item.uri === GUIDE_ALIAS)?.title, guide.title);
  assert.deepEqual((await client.readResource({ uri: GUIDE_URI })).contents[0], { uri: GUIDE_URI, mimeType: 'text/markdown', text: SKILL_TEXT });
  const alias = (await client.readResource({ uri: GUIDE_ALIAS })).contents[0];
  assert.equal('text' in alias ? alias.text : undefined, installed);
  await assert.rejects(client.readResource({ uri: GUIDE_URI.replace(GUIDE_VERSION, 'unknown-revision') }), /not found/i);

  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some(prompt => prompt.name === 'cartula_guide'));
  const prompt = await client.getPrompt({ name: 'cartula_guide' });
  assert.equal(prompt.messages[0].content.type, 'text');
  assert.equal((prompt.messages[0].content as { text: string }).text, SKILL_TEXT);

  const tools = await client.listTools();
  const guideTool = tools.tools.find(tool => tool.name === 'get_guide')!;
  assert.equal(guideTool.annotations?.readOnlyHint, true);
  assert.equal(guideTool.annotations?.idempotentHint, true);
  // A host exposing only tools and text blocks still gets the complete Skill.
  const fullGuide = await client.callTool({ name: 'get_guide', arguments: {} });
  assert.equal((fullGuide.content as Array<{ text?: string }>)[0].text, installed);
  assert.ok(resultText(fullGuide).includes(GUIDE_VERSION), 'text-only hosts can identify the content version');
  const selected = await client.callTool({ name: 'get_guide', arguments: { section: 'routing' } });
  assert.ok(!selected.isError);
  assert.match(resultText(selected), /省略 `path`/);
  assert.ok(resultText(selected).length < installed.length / 2, 'section requests do not load the whole guide');
  assert.ok((await client.callTool({ name: 'get_guide', arguments: { section: '../../secrets' } })).isError);
  assert.deepEqual((selected.structuredContent as { sections: string[] }).sections,
    ['all', 'essentials', 'quickstart', 'collaboration', 'routing', 'days', 'editing', 'errors', 'delivery']);

  const markdown = await fetch(`${url}/skills/cartula/SKILL.md`);
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await markdown.text(), SKILL_TEXT);
  const llms = await (await fetch(`${url}/llms.txt`)).text();
  assert.match(llms, /^# Cartula\n\n> /, 'llms.txt opens with the llmstxt.org title and summary');
  // Addresses come from the deployment's PUBLIC_URL (the default here), never from the request.
  const base = 'http://localhost:3900';
  for (const fact of ['MIT License', 'https://github.com/vibe-lark/Cartula', `${base}/mcp`, `${base}/plugins/cartula.zip`, `${base}/skills/cartula/SKILL.md`, `${base}/openapi.json`, 'Bearer <API_KEY>']) {
    assert.ok(llms.includes(fact), `llms.txt names ${fact}`);
  }
  assert.ok(llms.includes('- 新图用 `create_map`'), 'llms.txt carries the essentials');
  const full = await (await fetch(`${url}/llms-full.txt`)).text();
  assert.ok(full.startsWith(llms) && full.endsWith(installed), 'llms-full.txt appends the whole Skill');
  const notModified = await fetch(`${url}/skills/cartula/SKILL.md`, { headers: { 'if-none-match': markdown.headers.get('etag')! } });
  assert.equal(notModified.status, 304);
  const zip = await fetch(`${url}/skills/cartula.zip`);
  assert.equal(zip.status, 200);
  const archive = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...archive.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const archiveText = new TextDecoder().decode(archive);
  assert.match(archiveText, /cartula\/SKILL\.md/);
  assert.match(archiveText, /name: cartula/);
});

test('Skill examples create routed days and add a collaborator layer without replacing the original', async t => {
  // Execute the actual published examples, so valid-looking prose cannot drift
  // away from the real schema, routing trigger, day renderer or write contract.
  const examples = [...SKILL_TEXT.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const map = examples.find(example => example.layers) as MapInput;
  const addition = examples.find(example => example.op === 'layer.add') as { op: string; layer: MapLayer };
  assert.ok(map && addition);
  const calls: string[] = [];
  const mockRouter = async (input: unknown) => {
    const url = new URL(String(input)); calls.push(url.href);
    const points = url.pathname.split('/').at(-1)!.split(';').map(pair => pair.split(',').map(Number));
    const legs = points.slice(1).map((point, index) => ({
      distance: 100000, duration: 3600,
      steps: [{ geometry: { type: 'LineString', coordinates: [points[index], [points[index][0] + 0.03, points[index][1] + 0.05], point] } }],
    }));
    return new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: legs.length * 100000, duration: legs.length * 3600, legs }] }), { headers: { 'content-type': 'application/json' } });
  };
  const { app, store } = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: mockRouter as never });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'guide-examples', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const space = (await client.callTool({ name: 'create_space', arguments: {} })).structuredContent as { spaceKey: string };
  const created = await client.callTool({ name: 'create_map', arguments: { map, spaceKey: space.spaceKey, requestId: 'guide-create' } });
  assert.ok(!created.isError, resultText(created));
  const id = (created.structuredContent as { id: string }).id;
  const original = structuredClone(store.get(id).layers[0]);
  assert.equal(original.routingStatus?.geometry, 'resolved');
  assert.equal(original.stats.distanceKind, 'provided');
  assert.equal(original.routing?.durationMinutes, 120);
  assert.match(resultText(created), /OSRM.*已解算/);
  assert.match(resultText(created), /路由里程 200 km/);
  assert.match(resultText(created), /纯移动时间 120 分钟/);
  assert.ok(original.path!.length > original.points.length, 'road geometry includes bends, not just stop chords');
  const [firstLeg, secondLeg] = original.routing!.legs!;
  assert.ok(deltaE(segmentColor(firstLeg, original), segmentColor(secondLeg, original)) >= 25,
    'the example actually draws adjacent days in clearly distinct colours');
  const shared = await client.callTool({ name: 'share_map', arguments: { id, spaceKey: space.spaceKey, canWrite: true } });
  const previewToken = (shared.structuredContent as { previewToken: string }).previewToken;
  assert.ok(previewToken);
  // Owner changes something after the collaborator's read of version 1.
  await client.callTool({ name: 'patch_map', arguments: { id, spaceKey: space.spaceKey, baseVersion: 1, requestId: 'owner-note', operations: [
    { op: 'point.update', layerId: original.id, pointId: original.points[0].id, patch: { note: '保留用户备注' } },
  ] } });
  const attempt = { id, previewToken, baseVersion: 1, requestId: 'collaborator-add', operations: [addition] };
  const conflict = await client.callTool({ name: 'patch_map', arguments: attempt });
  assert.ok(conflict.isError);
  const error = JSON.parse(resultText(conflict));
  assert.equal(error.error, 'VERSION_CONFLICT');
  assert.match(error.guide, /get_guide/);
  assert.equal(store.get(id).layers.length, 1);
  const read = await client.callTool({ name: 'get_map', arguments: { id, previewToken, since: attempt.baseVersion, view: 'affected' } });
  assert.match(JSON.stringify(read.structuredContent), /保留用户备注/);
  assert.match(resultText(read), /备注已更新/);
  assert.match(resultText(read), /其他凭据/);
  assert.ok(!resultText(read).includes(space.spaceKey));
  assert.ok(!resultText(read).includes(previewToken));
  const retry = { ...attempt, baseVersion: (read.structuredContent as MapSnapshot).version, requestId: 'collaborator-rebased' };
  const added = await client.callTool({ name: 'patch_map', arguments: retry });
  assert.ok(!added.isError, resultText(added));
  const replay = await client.callTool({ name: 'patch_map', arguments: retry });
  assert.ok(!replay.isError, resultText(replay));
  const final = store.get(id);
  assert.equal(final.layers.length, 2, 'replay does not duplicate the collaborator layer');
  assert.equal(final.version, 3);
  assert.deepEqual(final.layers[0].path, original.path);
  assert.equal(final.layers[0].points[0].note, '保留用户备注');
  assert.equal(final.layers[1].id, addition.layer.id);
  assert.equal(final.layers[1].routingStatus?.geometry, 'resolved');
  assert.notEqual(final.layers[0].color, final.layers[1].color);
  assert.ok(calls.every(call => call.includes('/route/v1/driving/')));
  const ownerRead = await client.callTool({ name: 'get_map', arguments: { id, spaceKey: space.spaceKey, since: 2, view: 'affected' } });
  assert.match(resultText(ownerRead), /新增图层/);
  assert.match(resultText(ownerRead), /方案 B · 经安纳西/);
  assert.match(resultText(ownerRead), /其他凭据/);
  const withoutHistory = await client.callTool({ name: 'get_map', arguments: { id, spaceKey: space.spaceKey, since: 1, includeHistory: false } });
  assert.ok(!resultText(withoutHistory).includes('保留用户备注'));
  assert.ok(!resultText(withoutHistory).includes('本次可见变化'));
  const unchanged = await client.callTool({ name: 'get_map', arguments: { id, spaceKey: space.spaceKey, since: final.version } });
  assert.match(resultText(unchanged), /无变化/);
  assert.ok(!resultText(unchanged).includes('已解算'));
  assert.ok(!resultText(unchanged).includes('本次可见变化'));
});

test('text-only hosts can distinguish unavailable routing from caller-supplied geometry', async t => {
  for (const unavailable of ['unconfigured', 'failed'] as const) await t.test(unavailable, async t => {
    const examples = [...SKILL_TEXT.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    const map = examples.find(example => example.layers) as MapInput;
    const { app, store } = await createApp({ dbPath: ':memory:', ...(unavailable === 'failed' ? {
      osrmUrl: 'https://router.example', osrmFetch: (async () => new Response('Unavailable', { status: 503 })) as never,
    } : {}) });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'guide-routing-fallback', version: '1' });
    t.after(async () => { await client.close(); await app.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const created = await client.callTool({ name: 'create_map', arguments: { map } });
    assert.ok(!created.isError, resultText(created));
    const { id, spaceKey } = created.structuredContent as { id: string; spaceKey: string };
    assert.equal(store.get(id).layers[0].routing, undefined, 'default driving example must not pre-label a failed route as OSRM');
    assert.match(resultText(created), /直线示意，未取得道路几何/);
    assert.match(resultText(created), /未提供车程/);
    const declared = await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: 1, operations: [
      { op: 'layer.update', layerId: map.layers[0].id, patch: { routing: { source: 'OSRM', profile: 'driving' } } },
    ] } });
    assert.ok(!declared.isError, resultText(declared));
    assert.match(resultText(declared), /直线示意/);
    assert.doesNotMatch(resultText(declared), /已解算/);
    const supplied = await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: 2, operations: [
      { op: 'layer.update', layerId: map.layers[0].id, patch: { path: map.layers[0].points!.map(point => point.at) } },
    ] } });
    assert.ok(!supplied.isError, resultText(supplied));
    assert.match(resultText(supplied), /调用方提供几何.*未验证道路解算/);
    assert.doesNotMatch(resultText(supplied), /已解算/);
  });
});
