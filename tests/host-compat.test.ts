import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type AppOptions } from '../src/server/app.js';
import { normalizeArguments } from '../src/server/mcp.js';

/**
 * What every host converter seen so far accepts. A keyword outside this set is
 * not "probably fine": a Doubao client dropped the three tools that carried
 * `pattern` (see src/server/tool-schema.ts), and nothing on the server side
 * can tell which keyword the next host will refuse.
 */
const PORTABLE = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties', '$schema']);

function keywordsOf(schema: unknown, into: Map<string, string>, path = '', underProperties = false): void {
  if (Array.isArray(schema)) { schema.forEach((item, i) => keywordsOf(item, into, `${path}[${i}]`)); return; }
  if (!schema || typeof schema !== 'object') return;
  for (const [key, child] of Object.entries(schema)) {
    if (!underProperties && !into.has(key)) into.set(key, `${path}.${key}`);
    keywordsOf(child, into, `${path}.${key}`, !underProperties && key === 'properties');
  }
}

const map = { title: '法国到瑞士', layers: [{ id: 'route', name: '自驾', points: [{ id: 'nice', name: '尼斯', at: [7.26, 43.7] }, { id: 'geneva', name: '日内瓦', at: [6.14, 46.2] }] }] };

async function connect(t: { after(fn: () => Promise<void>): void }, options: AppOptions = {}) {
  const { app, store } = await createApp({ dbPath: ':memory:', ...options });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'host-compat-test', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return { client, store };
}

const text = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map(item => item.text ?? '').join('\n');

test('every schema on the wire stays inside the portable keyword subset', async t => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 10);
  for (const tool of tools) {
    for (const [label, schema] of [['inputSchema', tool.inputSchema], ['outputSchema', tool.outputSchema]] as const) {
      if (!schema) continue;
      const seen = new Map<string, string>();
      keywordsOf(schema, seen);
      for (const [keyword, where] of seen) assert.ok(PORTABLE.has(keyword), `${tool.name}.${label}: "${keyword}" is not portable (${where})`);
    }
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must be an object at the root`);
  }
});

test('arguments a host sends as strings are unwrapped before validation, and the strict core still decides', async t => {
  const { client, store } = await connect(t);
  const created = await client.callTool({ name: 'create_map', arguments: { map: JSON.stringify(map) } });
  assert.equal(created.isError, undefined, text(created));
  const { id, spaceKey } = created.structuredContent as { id: string; spaceKey: string };
  assert.ok(id && spaceKey, 'a map and its space key came back');

  const patched = await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: '1', operations: JSON.stringify([{ op: 'point.update', layerId: 'route', pointId: 'nice', patch: { day: 2 } }]) } });
  assert.equal(patched.isError, undefined, text(patched));
  assert.equal(store.get(id).version, 2, 'the stringified operation was applied');
  assert.equal(store.get(id).layers[0].points[0].day, 2);

  const submitted = await client.callTool({ name: 'submit_changes', arguments: { id, spaceKey, currentVersion: '2', intents: JSON.stringify([{ scope: 'map', text: '每天不超过 5 小时', priority: 'must' }]) } });
  assert.equal(submitted.isError, undefined, text(submitted));

  const read = await client.callTool({ name: 'get_map', arguments: { id, spaceKey, since: '0', includeGeometry: 'false' } });
  assert.equal(read.isError, undefined, text(read));

  // Unwrapping does not loosen what is accepted: the same unknown field is
  // refused with the same path whether the operations came as text or not.
  const smuggled = await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: '3', operations: JSON.stringify([{ op: 'layer.update', layerId: 'route', patch: { name: 'x', points: [] } }]) } });
  assert.equal(smuggled.isError, true);
  assert.match(text(smuggled), /未知字段「points」/);
  assert.match(text(smuggled), /\[0\]\.patch/);
});

test('a string that is not the JSON of the expected shape is still refused by field name', async t => {
  const { client } = await connect(t);
  for (const [name, args, field] of [
    ['create_map', { map: 'not json' }, /at map\b/],
    ['create_map', { map: '[1,2]' }, /at map\b/],
    ['patch_map', { id: 'x', baseVersion: 'one', operations: '{"op":"draft.commit"}' }, /at (baseVersion|operations)\b/],
  ] as const) {
    // The SDK reports a refused argument as an isError result whose text
    // carries the JSON-RPC code, so a model can read which field to fix.
    const refused = await client.callTool({ name, arguments: { ...args } });
    assert.equal(refused.isError, true, `${name} accepted ${JSON.stringify(args)}`);
    assert.match(text(refused), /Input validation error/);
    assert.match(text(refused), field);
  }
});

test('normalizeArguments rewrites only what the tool declares, and says what it rewrote', () => {
  const kinds = { map: 'object', operations: 'array', baseVersion: 'number', includeGeometry: 'boolean' } as const;
  const args: Record<string, unknown> = { map: ' {"title":"t"} ', operations: '[{"op":"draft.commit"}]', baseVersion: '-3', includeGeometry: 'true', title: '{"kept":"as text"}', spaceKey: '123' };
  assert.deepEqual(normalizeArguments(args, kinds).sort(), ['baseVersion', 'includeGeometry', 'map', 'operations']);
  assert.deepEqual(args.map, { title: 't' });
  assert.deepEqual(args.operations, [{ op: 'draft.commit' }]);
  assert.equal(args.baseVersion, -3);
  assert.equal(args.includeGeometry, true);
  assert.equal(args.title, '{"kept":"as text"}', 'a string field is never parsed');
  assert.equal(args.spaceKey, '123', 'a string field is never turned into a number');
  assert.deepEqual(normalizeArguments({ map: '{broken', baseVersion: '1.5.2', includeGeometry: 'yes' }, kinds), []);
  assert.deepEqual(normalizeArguments({ map: { already: 'an object' }, baseVersion: 4 }, kinds), []);
  assert.deepEqual(normalizeArguments('not an object', kinds), []);
});

test('each tool call leaves one log line naming the host, the tool and the outcome — never the arguments', async t => {
  const lines: string[] = [];
  const { client } = await connect(t, { logger: true, logStream: { write: (line: string) => { lines.push(line); } } });
  const created = await client.callTool({ name: 'create_map', arguments: { map: JSON.stringify(map) } });
  const { id, spaceKey } = created.structuredContent as { id: string; spaceKey: string };
  await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: 1, operations: [{ op: 'point.move', layerId: 'route', pointId: 'nice' }] } });
  await client.callTool({ name: 'patch_map', arguments: { id, spaceKey, baseVersion: 1, operations: [{ op: 'layer.update', layerId: 'route', patch: { points: [] } }] } });

  const events = lines.map(line => { try { return JSON.parse(line) as { mcp?: Record<string, unknown> }; } catch { return {}; } }).map(entry => entry.mcp).filter((entry): entry is Record<string, unknown> => !!entry);
  const initialize = events.find(event => event.event === 'initialize');
  assert.ok(initialize, 'initialize is logged');
  assert.equal((initialize.clientInfo as { name: string }).name, 'host-compat-test');

  const calls = events.filter(event => event.event === 'call');
  assert.deepEqual(calls.map(event => [event.tool, event.outcome]), [['create_map', 'ok'], ['patch_map', 'rejected'], ['patch_map', 'error']], JSON.stringify(calls));
  assert.deepEqual(calls[0].normalized, ['map'], 'the unwrapped argument is named');
  assert.equal(calls[1].code, -32602, 'an SDK rejection carries its JSON-RPC code');
  assert.match(String(calls[1].message), /op/);
  assert.equal(calls[2].status, 400, 'a domain error carries its status');
  assert.match(String(calls[2].message), /未知字段/);
  for (const call of calls) assert.equal(typeof call.ms, 'number');
  assert.ok(!lines.some(line => line.includes(spaceKey)), 'the space key never reaches the log');
  assert.ok(!lines.some(line => line.includes('尼斯')), 'argument contents never reach the log');
});
