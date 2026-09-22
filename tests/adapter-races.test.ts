/**
 * The races that only exist between a request and its response, tested on the
 * real `McpAdapter` through an injected host.
 *
 * Everything here is a scenario the pure helpers cannot prove: a poll that
 * lands after the host opened another map, an edit that returns to a view that
 * has moved on, and a hand-off whose write reached the server while its
 * response was lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpAdapter, type HostApp } from '../src/web/adapters/mcp.js';
import { submitOutcome } from '../src/web/adapters/delivery.js';
import type { MapSnapshot } from '../src/core/types.js';
import type { AdapterUpdate } from '../src/web/adapters/types.js';

function snapshot(id: string, version: number, title = id, window: { sinceVersion?: number; events?: MapSnapshot['events'] } = {}): MapSnapshot {
  return {
    id, title, version, parent: version - 1, changed: false, changes: [], events: [], ...window,
    updatedAt: new Date(2026, 8, 7).toISOString(), url: `https://cartula.test/map/${id}`,
    layers: [{ id: 'route', name: '路线', kind: 'route', color: '#2563eb', visible: true, crs: 'wgs84', edited_by: 'agent', points: [], stats: { distanceKm: 0, days: 0, distanceKind: 'straight', pointCount: 0 } }],
  };
}
function toolResult(map: MapSnapshot, editKey?: string) {
  return { _meta: { cartula: { map, ...(editKey ? { editKey } : {}) } } };
}

type Call = { name: string; arguments: Record<string, unknown> };

/**
 * A host under test control: every tool call is queued so the test decides
 * when — and in which order — each response comes back.
 */
class FakeHost {
  calls: Call[] = [];
  messages: string[] = [];
  contexts: unknown[] = [];
  /** Sizes the host received. */
  sizes: { width?: number; height?: number }[] = [];
  /** Sizes the view tried to declare, refused ones included. */
  sizeAttempts: { width?: number; height?: number }[] = [];
  /** Set to make `sendSizeChanged` fail the way a host or transport can. */
  sizeFailure?: Error;
  /** What `getHostContext()` answers; both axes fixed unless a test says otherwise. */
  context: { displayMode?: string; containerDimensions?: Record<string, number> } = { displayMode: 'inline', containerDimensions: { height: 500, width: 900 } };
  private pending: { call: Call; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  private handler: (call: Call) => unknown | Promise<unknown> = () => { throw new Error('no handler'); };
  private deferred = false;
  /** Set while `updateModelContext` is held open. */
  contextGate?: Promise<void>;
  private openContextGate?: () => void;
  app: HostApp;
  constructor() {
    const host = this;
    this.app = {
      getHostContext: () => host.context,
      getHostCapabilities: () => ({ message: { text: {} } }),
      connect: async () => {},
      close: async () => {},
      callServerTool: async (params: unknown) => {
        const call = params as Call;
        host.calls.push(call);
        if (!host.deferred) return host.handler(call);
        return new Promise((resolve, reject) => { host.pending.push({ call, resolve, reject }); });
      },
      sendMessage: async (params: unknown) => { host.messages.push(JSON.stringify(params)); return {}; },
      sendSizeChanged: async (size: unknown) => {
        host.sizeAttempts.push(size as { height?: number });
        if (host.sizeFailure) throw host.sizeFailure;
        host.sizes.push(size as { height?: number });
      },
      updateModelContext: async (params: unknown) => {
        host.contexts.push(params);
        if (host.contextGate) await host.contextGate;
        return {};
      },
      requestDisplayMode: async () => ({ mode: 'inline' as const }),
      downloadFile: async () => ({}),
      ontoolresult: undefined,
      ontoolcancelled: undefined,
      onhostcontextchanged: undefined,
    } as unknown as HostApp;
  }
  /** Answer calls immediately with `handler`. */
  respond(handler: (call: Call) => unknown) { this.handler = handler; this.deferred = false; }
  /** Hold every call until the test releases it. */
  hold() { this.deferred = true; }
  /** Keep `updateModelContext` unresolved — the window after a write lands. */
  holdContext() { this.contextGate = new Promise<void>(resolve => { this.openContextGate = resolve; }); }
  releaseContext() { this.openContextGate?.(); this.contextGate = undefined; }
  private take(match: string | ((call: Call) => boolean)) {
    const test = typeof match === 'string' ? (call: Call) => call.name === match : match;
    const index = this.pending.findIndex(entry => test(entry.call));
    assert.ok(index >= 0, `no pending call for ${String(match)}`);
    return this.pending.splice(index, 1)[0];
  }
  release(match: string | ((call: Call) => boolean), value: unknown) { this.take(match).resolve(value); }
  fail(match: string | ((call: Call) => boolean), error: unknown) { this.take(match).reject(error); }
  /** The host pushes a tool result, e.g. because the user opened another map. */
  push(result: unknown) { this.app.ontoolresult?.(result as never); }
  named(name: string) { return this.calls.filter(call => call.name === name); }
}

async function openAdapter(t: { after: (fn: () => void) => void }, host: FakeHost, first: MapSnapshot, editKey = 'key-a') {
  const adapter = new McpAdapter(host.app);
  const updates: AdapterUpdate[] = [];
  const ready = adapter.initialize(update => updates.push(update));
  host.push(toolResult(first, editKey));
  await ready;
  // The adapter polls on a timer; a test that ends without disposing would
  // hold the process open.
  t.after(() => adapter.dispose());
  return { adapter, updates };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a poll answered after the host opened another map never touches the new one', async t => {
  const host = new FakeHost();
  const a = snapshot('map-a', 4);
  const { adapter, updates } = await openAdapter(t, host, a);
  host.hold();
  // A refresh for map A is in flight when the host swaps in map B.
  const polling = (adapter as unknown as { refresh(): Promise<void> }).refresh();
  host.push(toolResult(snapshot('map-b', 1), 'key-b'));
  host.release('get_map_state', toolResult(snapshot('map-a', 9), 'key-a'));
  await polling;
  await settle();
  const delivered = updates.filter(update => update.snapshot).map(update => update.snapshot!);
  assert.deepEqual(delivered.map(map => `${map.id}@${map.version}`), ['map-a@4', 'map-b@1'], 'the late A result must not be delivered');
  assert.equal(adapter.editUrl?.includes('key-b'), true, "A's credential must not survive on B");
  adapter.dispose();
});

test('an edit answered after a map switch is reported, not applied to the new map', async t => {
  const host = new FakeHost();
  const { adapter, updates } = await openAdapter(t, host, snapshot('map-a', 4));
  host.hold();
  const editing = adapter.edit(snapshot('map-a', 4), [{ op: 'annotate', layerId: 'route', pointId: 'p', text: '备注' }]);
  host.push(toolResult(snapshot('map-b', 1), 'key-b'));
  host.release('edit_map', toolResult(snapshot('map-a', 5), 'key-a'));
  await assert.rejects(editing, /地图已切换/);
  const last = updates.filter(update => update.snapshot).at(-1)!.snapshot!;
  assert.equal(last.id, 'map-b');
  assert.equal(last.version, 1, 'the edit result for A must not overwrite B');
  adapter.dispose();
});

test('switching maps drops pending write ids so the next edit starts from the new map', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  const operations = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];
  host.hold();
  const failing = adapter.edit(snapshot('map-a', 4), operations);
  host.fail('edit_map', new Error('network'));
  await assert.rejects(failing, /network/);
  host.push(toolResult(snapshot('map-b', 7), 'key-b'));
  host.respond(() => toolResult(snapshot('map-b', 8), 'key-b'));
  await adapter.edit(snapshot('map-b', 7), operations);
  const edits = host.named('edit_map');
  assert.equal(edits.length, 2);
  assert.notEqual(edits[1].arguments.requestId, edits[0].arguments.requestId, 'a new map must not reuse the old request id');
  assert.equal(edits[1].arguments.baseVersion, 7, 'nor the old base version');
  assert.equal(edits[1].arguments.id, 'map-b');
  adapter.dispose();
});

/** The isError tool-result shape `raise()` unpacks, for a stated HTTP status. */
function toolFailure(status: number, error: string, hint?: string) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status, error, ...(hint ? { hint } : {}) }) }] };
}

test('an edit_map conflict is replayed once against the refreshed version, with a new request id', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  const operations = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];
  // `raise()`'s own generic 409 handling also fires a background refresh, so
  // `get_map_state` may be asked for once or twice here; only `edit_map` is
  // this test's concern.
  host.respond(call => {
    if (call.name === 'edit_map') {
      const edits = host.named('edit_map');
      if (edits.length === 1) return toolFailure(409, 'VERSION_CONFLICT', '请先读取 since=4 的摘要，再只提交受影响操作');
      return toolResult(snapshot('map-a', (call.arguments.baseVersion as number) + 1), 'key-a');
    }
    if (call.name === 'get_map_state') return toolResult(snapshot('map-a', 9), 'key-a');
    throw new Error(`unexpected call ${call.name}`);
  });
  const result = await adapter.edit(snapshot('map-a', 4), operations);
  assert.equal(result.version, 10, "the retry's own result is returned, as if the first attempt had produced it");
  const edits = host.named('edit_map');
  assert.equal(edits.length, 2, 'exactly two edit requests were sent');
  assert.equal(edits[0].arguments.baseVersion, 4);
  assert.equal(edits[1].arguments.baseVersion, 9, 'the retry uses the version the refresh reported');
  assert.notEqual(edits[1].arguments.requestId, edits[0].arguments.requestId, '409 means nothing was written; the retry must not reuse the id');
  adapter.dispose();
});

test('two edit_map conflicts in a row surface a plain-language error, never the raw VERSION_CONFLICT text', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  const operations = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];
  host.respond(call => {
    if (call.name === 'edit_map') return toolFailure(409, 'VERSION_CONFLICT', '请先读取 since=4 的摘要，再只提交受影响操作');
    if (call.name === 'get_map_state') return toolResult(snapshot('map-a', 9), 'key-a');
    throw new Error(`unexpected call ${call.name}`);
  });
  await assert.rejects(adapter.edit(snapshot('map-a', 4), operations), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('VERSION_CONFLICT'), error.message);
    assert.equal((error as { code?: string }).code, 'conflict');
    return true;
  });
  assert.equal(host.named('edit_map').length, 2, 'one retry, not a loop');
  adapter.dispose();
});

test('a stated rejection other than a conflict is never retried', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  const operations = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];
  host.respond(call => {
    if (call.name === 'edit_map') return toolFailure(400, '请求格式不正确');
    throw new Error(`unexpected call ${call.name}`);
  });
  await assert.rejects(adapter.edit(snapshot('map-a', 4), operations), /请求格式不正确/);
  assert.equal(host.named('edit_map').length, 1, 'a non-409 rejection gets no retry, and no get_map_state refresh');
  assert.equal(host.named('get_map_state').length, 0);
  adapter.dispose();
});

test('a replace_map conflict refreshes the map but is never replayed, unlike an edit', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => {
    if (call.name === 'replace_map') return toolFailure(409, 'VERSION_CONFLICT', '请先读取 since=4 的摘要，再只提交受影响操作');
    if (call.name === 'get_map_state') return toolResult(snapshot('map-a', 9), 'key-a');
    throw new Error(`unexpected call ${call.name}`);
  });
  await assert.rejects(adapter.replace({ title: '重写', layers: [] }, snapshot('map-a', 4)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('VERSION_CONFLICT'), error.message);
    assert.equal((error as { code?: string }).code, 'conflict');
    return true;
  });
  assert.equal(host.named('replace_map').length, 1, 'a whole-map replace is never replayed after a conflict');
  assert.ok(host.named('get_map_state').length >= 1, 'the map is still refreshed so a person can retry by hand');
  adapter.dispose();
});

test('a write that finishes notifying after the host opened another map is not handed back', async t => {
  const host = new FakeHost();
  const { adapter, updates } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(() => toolResult(snapshot('map-a', 5), 'key-a'));
  // The write landed; the host swaps in map B while the model context update
  // is still open.
  host.holdContext();
  const editing = adapter.edit(snapshot('map-a', 4), [{ op: 'annotate', layerId: 'route', pointId: 'p', text: '备注' }]);
  await settle();
  host.push(toolResult(snapshot('map-b', 1), 'key-b'));
  host.releaseContext();
  await assert.rejects(editing, /地图已切换/);
  const last = updates.filter(update => update.snapshot).at(-1)!.snapshot!;
  assert.equal(last.id, 'map-b');
  assert.equal(last.version, 1, "A's result must not be able to overwrite B");
  adapter.dispose();
});

test('the tail of an old map write leaves the new pending write alone', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  const operations = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];
  host.respond(() => toolResult(snapshot('map-a', 5), 'key-a'));
  host.holdContext();
  const editingA = adapter.edit(snapshot('map-a', 4), operations);
  await settle();
  host.push(toolResult(snapshot('map-b', 7), 'key-b'));
  // B starts a write of its own and fails, so B keeps a pending request id.
  host.respond(() => { throw new Error('network'); });
  await assert.rejects(adapter.edit(snapshot('map-b', 7), operations), /network/);
  const failedB = host.named('edit_map').at(-1)!.arguments.requestId;
  host.releaseContext();
  await assert.rejects(editingA, /地图已切换/);
  // B retries the same edit: it must still be the same logical write.
  host.respond(() => toolResult(snapshot('map-b', 8), 'key-b'));
  await adapter.edit(snapshot('map-b', 7), operations);
  const retried = host.named('edit_map').at(-1)!.arguments;
  assert.equal(retried.requestId, failedB, "A's tail must not clear B's pending write");
  assert.equal(retried.id, 'map-b');
  adapter.dispose();
});

test("a late submit answer for the old map leaves the new map's hand-off untouched", async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.hold();
  const submitA = adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: 'A 的意图' });
  await settle();
  host.push(toolResult(snapshot('map-b', 1), 'key-b'));
  // B starts its own round and loses the answer, so B keeps its attempt.
  const submitB = adapter.submitChanges(snapshot('map-b', 1), { since: 0, userMessage: 'B 的意图' });
  await settle();
  host.fail(call => call.name === 'submit_changes' && call.arguments.id === 'map-b', new Error('network'));
  await assert.rejects(submitB, /network/);
  const firstB = host.named('submit_changes').find(call => call.arguments.id === 'map-b')!.arguments;

  // A's rejection arrives afterwards; it belongs to a map nobody is on.
  host.release(call => call.name === 'submit_changes' && call.arguments.id === 'map-a',
    { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 409, error: 'VERSION_CONFLICT' }) }] });
  await assert.rejects(submitA, /地图已切换/);

  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 2, message: '已交给 Agent' } }
    : toolResult(snapshot('map-b', 2), 'key-b')));
  await adapter.submitChanges(snapshot('map-b', 1), { since: 0, userMessage: 'B 的意图' });
  const retryB = host.named('submit_changes').filter(call => call.arguments.id === 'map-b').at(-1)!.arguments;
  assert.equal(retryB.requestId, firstB.requestId, "A's rejection must not discard B's attempt");
  assert.equal(retryB.currentVersion, firstB.currentVersion);
  // And A's answer must not have made the adapter read map A with B's key.
  assert.equal(host.named('get_map_state').filter(call => call.arguments.id === 'map-a' && call.arguments.editKey === 'key-b').length, 0);
  adapter.dispose();
});

test('a hand-off whose notify outlives the map is refused, so its message cannot be sent from the new one', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 5, message: '请按 map-a 的修改继续规划' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  host.holdContext();
  const submitting = adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' });
  await settle();
  host.push(toolResult(snapshot('map-b', 1), 'key-b'));
  host.releaseContext();
  // The round stays saved on map A; the caller is told rather than handed a
  // message it would then send from map B.
  await assert.rejects(submitting, /地图已切换/);
  assert.equal(host.messages.length, 0);
  adapter.dispose();
});

test('a stale poll result never rolls the open map back to an older version', async t => {
  const host = new FakeHost();
  const { adapter, updates } = await openAdapter(t, host, snapshot('map-a', 4));
  host.hold();
  const polling = (adapter as unknown as { refresh(): Promise<void> }).refresh();
  host.push(toolResult(snapshot('map-a', 9), 'key-a'));
  host.release('get_map_state', toolResult(snapshot('map-a', 5), 'key-a'));
  await polling;
  const delivered = updates.filter(update => update.snapshot).map(update => update.snapshot!.version);
  assert.deepEqual(delivered, [4, 9], 'v5 arrived after v9 and must be ignored');
  adapter.dispose();
});

test('a submit whose response was lost is replayed with the same request id, even after polling moved on', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => {
    if (call.name === 'submit_changes') throw new Error('connection lost');
    return toolResult(snapshot('map-a', 4), 'key-a');
  });
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' }), /connection lost/);

  // The write did land: polling now reports the committed version.
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  const retry = await adapter.submitChanges(snapshot('map-a', 5), { since: 2, userMessage: '每天不超过三小时' });
  assert.equal(retry.message, '已交给 Agent');
  const submits = host.named('submit_changes');
  assert.equal(submits.length, 2);
  assert.equal(submits[1].arguments.requestId, submits[0].arguments.requestId, 'the server must see one logical submission');
  assert.equal(submits[1].arguments.currentVersion, 4, 'the retry keeps the version it was written from');
  assert.equal(submits[1].arguments.baseVersion, 2);
  adapter.dispose();
});

test('when the write landed but the read-back failed, the retry only re-reads', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => {
    if (call.name === 'submit_changes') return { structuredContent: { message: '已交给 Agent' } };
    throw new Error('read failed');
  });
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '再想想' }), /read failed/);
  assert.equal(host.named('submit_changes').length, 1);

  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { message: '不应该再写一次' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  const recovered = await adapter.submitChanges(snapshot('map-a', 5), { since: 2, userMessage: '再想想' });
  assert.equal(host.named('submit_changes').length, 1, 'the round was already committed; only the read repeats');
  assert.equal(recovered.message, '已交给 Agent', 'the message from the successful write is preserved');
  assert.equal(recovered.snapshot.version, 5);
  adapter.dispose();
});

test('the hand-off reports the version its message describes, not a newer read-back', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 2));
  // The submit commits v3 and the message describes v3; by the time the
  // read-back runs, another client has already written v4.
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 3, message: '请按 v3 的修改继续规划' } }
    : toolResult(snapshot('map-a', 4), 'key-a')));
  const handoff = await adapter.submitChanges(snapshot('map-a', 2), { since: 1, userMessage: '删掉尼斯' });
  assert.equal(handoff.version, 3, 'the cursor may only move to what the message contains');
  assert.equal(handoff.mapId, 'map-a');
  assert.equal(handoff.message, '请按 v3 的修改继续规划');
  assert.equal(handoff.snapshot.version, 4, 'the view still follows the newest state');
  adapter.dispose();
});

test('a server that reports no version leaves the cursor on the version submitted against', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 2));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { message: '没有版本号的回应' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  const handoff = await adapter.submitChanges(snapshot('map-a', 2), { since: 1, userMessage: '删掉尼斯' });
  // Lagging is recoverable; running ahead would silently mark someone else's
  // changes as handed over.
  assert.equal(handoff.version, 2);
  assert.equal(handoff.snapshot.version, 5);
  adapter.dispose();
});

test('the recovered hand-off keeps the version of the write that landed', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 2));
  host.respond(call => {
    if (call.name === 'submit_changes') return { structuredContent: { version: 3, message: '请按 v3 的修改继续规划' } };
    throw new Error('read failed');
  });
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 2), { since: 1, userMessage: '删掉尼斯' }), /read failed/);
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 9, message: '不应该再写一次' } }
    : toolResult(snapshot('map-a', 4), 'key-a')));
  const handoff = await adapter.submitChanges(snapshot('map-a', 4), { since: 1, userMessage: '删掉尼斯' });
  assert.equal(host.named('submit_changes').length, 1);
  assert.equal(handoff.version, 3, 'the retry re-reads; it does not re-date the hand-off');
  assert.equal(handoff.message, '请按 v3 的修改继续规划');
  adapter.dispose();
});

test('the same sentence submitted twice is two writes, not one de-duplicated write', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 5, message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  // The hand-off was never delivered, so the read cursor stays where it was
  // and the user submits the same intent again after someone else edited.
  await adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' });
  await adapter.submitChanges(snapshot('map-a', 5), { since: 2, userMessage: '每天不超过三小时' });
  const submits = host.named('submit_changes');
  assert.equal(submits.length, 2);
  assert.notEqual(submits[1].arguments.requestId, submits[0].arguments.requestId, 'a second submission must reach the server, not be swallowed as a replay');
  assert.equal(submits[1].arguments.currentVersion, 5);
  adapter.dispose();
});

test('a refused read-back does not turn a committed round into a refusal', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 2));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 3, message: '请按 v3 的修改继续规划' } }
    : { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 403, error: 'FORBIDDEN', hint: '需要编辑密钥' }) }] }));
  const failure = await adapter.submitChanges(snapshot('map-a', 2), { since: 1, userMessage: '删掉尼斯' }).catch(error => error);
  // The write landed; only the read-back was refused, so nothing may be said
  // about whether this round reached the map.
  assert.equal(submitOutcome(failure), 'unknown');
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 9, message: '不应该再写一次' } }
    : toolResult(snapshot('map-a', 3), 'key-a')));
  const handoff = await adapter.submitChanges(snapshot('map-a', 3), { since: 1, userMessage: '删掉尼斯' });
  assert.equal(host.named('submit_changes').length, 1, 'the retry only re-reads');
  assert.equal(handoff.version, 3);
  adapter.dispose();
});

test('a new round after a completed submit gets its own request id', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 5, message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  await adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '第一轮' });
  await adapter.submitChanges(snapshot('map-a', 5), { since: 5, userMessage: '第二轮' });
  const submits = host.named('submit_changes');
  assert.equal(submits.length, 2);
  assert.notEqual(submits[1].arguments.requestId, submits[0].arguments.requestId);
  assert.equal(submits[1].arguments.baseVersion, 5);
  adapter.dispose();
});

test('a conflict rebuilds the submission as a new write against the version the user has', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 409, error: 'VERSION_CONFLICT', hint: '请重新读取' }) }] }
    : toolResult(snapshot('map-a', 6), 'key-a')));
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '冲突轮' }), /VERSION_CONFLICT/);
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 6), 'key-a')));
  await adapter.submitChanges(snapshot('map-a', 6), { since: 2, userMessage: '冲突轮' });
  const submits = host.named('submit_changes');
  // Submitted intents are an upsert, so the server rejects an attempt written
  // against a version that has moved. The rebuilt attempt targets the version
  // the user now has and is a different write, with its own request id.
  assert.equal(submits[0].arguments.currentVersion, 4);
  assert.equal(submits[1].arguments.currentVersion, 6);
  assert.notEqual(submits[1].arguments.requestId, submits[0].arguments.requestId);
  adapter.dispose();
});

test('an unknown failure keeps the attempt; only an explicit conflict starts a new one', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  // Unknown outcome: the write may have landed, so the attempt is replayed.
  host.respond(call => { if (call.name === 'submit_changes') throw new Error('network'); return toolResult(snapshot('map-a', 4), 'key-a'); });
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '同一轮' }), /network/);
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 5), { since: 2, userMessage: '同一轮' }), /network/);
  const replayed = host.named('submit_changes');
  assert.equal(replayed[1].arguments.requestId, replayed[0].arguments.requestId);
  assert.equal(replayed[1].arguments.currentVersion, 4, 'polling must not move the attempt');

  // Explicit conflict: nothing was written, and the map moved on.
  host.respond(call => (call.name === 'submit_changes'
    ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 409, error: 'VERSION_CONFLICT' }) }] }
    : toolResult(snapshot('map-a', 7), 'key-a')));
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 5), { since: 2, userMessage: '同一轮' }), /VERSION_CONFLICT/);
  host.respond(call => (call.name === 'submit_changes' ? { structuredContent: { message: '已交给 Agent' } } : toolResult(snapshot('map-a', 7), 'key-a')));
  await adapter.submitChanges(snapshot('map-a', 7), { since: 2, userMessage: '同一轮' });
  const all = host.named('submit_changes');
  assert.equal(all.at(-1)!.arguments.currentVersion, 7);
  assert.notEqual(all.at(-1)!.arguments.requestId, all[0].arguments.requestId);
  adapter.dispose();
});

test('a conflict ends the attempt: the next try is re-based and never loops', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  // The request never reached the server, so the attempt is replayed as-is.
  host.respond(call => { if (call.name === 'submit_changes') throw new Error('network'); return toolResult(snapshot('map-a', 4), 'key-a'); });
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' }), /network/);
  // Someone else wrote meanwhile, so the replay is rejected — once.
  host.respond(call => (call.name === 'submit_changes'
    ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 409, error: 'VERSION_CONFLICT', currentVersion: 6 }) }] }
    : toolResult(snapshot('map-a', 6), 'key-a')));
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 6), { since: 2, userMessage: '每天不超过三小时' }), /VERSION_CONFLICT/);
  const rejected = host.named('submit_changes');
  assert.equal(rejected[1].arguments.requestId, rejected[0].arguments.requestId, 'the lost attempt is replayed unchanged');
  assert.equal(rejected[1].arguments.currentVersion, 4);
  // After the conflict the user re-reads and tries again: new base, new id.
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 7, message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 7), 'key-a')));
  const handoff = await adapter.submitChanges(snapshot('map-a', 6), { since: 2, userMessage: '每天不超过三小时' });
  const all = host.named('submit_changes');
  assert.equal(all.length, 3);
  assert.equal(all[2].arguments.currentVersion, 6, 'written against what the user has now');
  assert.notEqual(all[2].arguments.requestId, all[0].arguments.requestId);
  assert.equal(handoff.version, 7);
  adapter.dispose();
});

test('a stated rejection other than a conflict also ends the attempt', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 400, error: 'UNKNOWN_VERSION', hint: 'currentVersion 超前' }) }] }
    : toolResult(snapshot('map-a', 4), 'key-a')));
  await assert.rejects(adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' }), /UNKNOWN_VERSION/);
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 5, message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  await adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' });
  const submits = host.named('submit_changes');
  // Replaying a payload the server already refused could only be refused again.
  assert.notEqual(submits[1].arguments.requestId, submits[0].arguments.requestId);
  adapter.dispose();
});

test('an intent travels with the version it is written against; a message-only submit carries none', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { version: 5, message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  await adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '每天不超过三小时' });
  const withIntent = host.named('submit_changes')[0].arguments;
  assert.deepEqual(withIntent.intents, [{ scope: 'map', text: '每天不超过三小时', priority: 'prefer' }]);
  assert.equal(withIntent.currentVersion, 4, 'an upsert must name its base version');

  await adapter.submitChanges(snapshot('map-a', 5), { since: 5 });
  const messageOnly = host.named('submit_changes')[1].arguments;
  assert.ok(!('intents' in messageOnly), 'an empty intent list is not an intent write');
  assert.ok(!('userMessage' in messageOnly));
  adapter.dispose();
});

test('the hand-off message reports what the host answered, and the map is saved either way', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(call => (call.name === 'submit_changes'
    ? { structuredContent: { message: '已交给 Agent' } }
    : toolResult(snapshot('map-a', 5), 'key-a')));
  const result = await adapter.submitChanges(snapshot('map-a', 4), { since: 2, userMessage: '去掉尼斯' });
  assert.equal(result.snapshot.version, 5);
  assert.ok(host.contexts.length > 0, 'saving still updates the model context');
  assert.deepEqual(await adapter.sendPlanningMessage(result.message), { status: 'sent' });
  assert.equal(host.messages.length, 1);
  adapter.dispose();
});

test('a size the host refused is not remembered as declared, and can be sent again', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  await settle();
  assert.deepEqual(host.sizeAttempts, [], 'both axes are fixed here, so there is nothing to ask for');
  // Mocked from here on, so the only timer that fires is one the test asks for.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise(resolve => process.nextTick(resolve));
  // Elastic height: now there is something to declare, and the host drops it.
  host.context = { displayMode: 'inline', containerDimensions: { maxHeight: 600 } };
  host.sizeFailure = new Error('host dropped the notification');

  const failed = await adapter.declarePreferredSize();
  assert.equal(failed.status, 'failed', 'a failed notification is reported, not swallowed');
  assert.deepEqual(failed.request, { width: 1280, height: 600 });
  assert.equal(failed.detail, 'host dropped the notification');
  assert.deepEqual(host.sizes, [], 'nothing reached the host');

  // The fix: a refused size stays sendable. Recording it as declared before the
  // send meant one dropped notification pinned the view at whatever height the
  // host had guessed, with no way back.
  const again = await adapter.declarePreferredSize();
  assert.equal(again.status, 'failed');
  assert.equal(host.sizeAttempts.length, 2, 'the same size is attempted again after a failure');

  host.sizeFailure = undefined;
  assert.equal((await adapter.declarePreferredSize()).status, 'sent');
  assert.deepEqual(host.sizes, [{ width: 1280, height: 600 }]);

  // Once the host has it, de-duplication resumes: repeating the same numbers is
  // how a negotiation turns into a resize loop.
  assert.equal((await adapter.declarePreferredSize()).status, 'unchanged');
  assert.deepEqual(host.sizes, [{ width: 1280, height: 600 }]);
  assert.equal(host.sizeAttempts.length, 3, 'an unchanged size is not even attempted');
  // Nothing is left armed once the host accepted the size.
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(host.sizeAttempts.length, 3);

  // A fixed axis is still left alone, failure or not.
  host.context = { displayMode: 'inline', containerDimensions: { height: 500, width: 900 } };
  assert.deepEqual(await adapter.declarePreferredSize(), { status: 'skipped', request: null });
  adapter.dispose();
  assert.deepEqual(await adapter.declarePreferredSize(), { status: 'skipped', request: null }, 'a disposed view declares nothing');
});

test('a refused size is retried once, not in a loop', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  await settle();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise(resolve => process.nextTick(resolve));
  host.context = { displayMode: 'inline', containerDimensions: { maxHeight: 600 } };
  host.sizeFailure = new Error('host dropped the notification');
  assert.equal((await adapter.declarePreferredSize()).status, 'failed');
  const attempted = host.sizeAttempts.length;
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(host.sizeAttempts.length, attempted + 1, 'the failure earns one automatic retry');
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(host.sizeAttempts.length, attempted + 1, 'and then waits for the host to say something new');

  // A new host context is something new: the size becomes worth one more try.
  host.context = { displayMode: 'inline', containerDimensions: { maxHeight: 600 } };
  host.app.onhostcontextchanged?.(undefined as never);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(host.sizeAttempts.length, attempted + 2);
  adapter.dispose();
});

test('a hand-off acknowledgement is reported honestly and never invents a boundary', async t => {
  const host = new FakeHost();
  const { adapter } = await openAdapter(t, host, snapshot('map-a', 4));
  host.respond(() => ({ structuredContent: { id: 'map-a', handoffVersion: 5, agentVersion: 3, version: 5 } }));
  await adapter.recordHandoff('map-a', 5);
  const acked = host.named('record_handoff');
  assert.equal(acked.length, 1);
  assert.deepEqual(acked[0].arguments, { id: 'map-a', version: 5, editKey: 'key-a' }, 'the owner credential, and nothing else');

  // A refused acknowledgement is an error, not a silent success: the caller
  // decides what to do, and the round is already in the conversation either way.
  host.respond(() => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 403, error: 'FORBIDDEN' }) }] }));
  await assert.rejects(adapter.recordHandoff('map-a', 6), /FORBIDDEN/);
  // The lost acknowledgement is safe to repeat — the server takes the maximum.
  host.respond(() => ({ structuredContent: { id: 'map-a', handoffVersion: 6, agentVersion: 3, version: 6 } }));
  await adapter.recordHandoff('map-a', 6);
  assert.equal(host.named('record_handoff').length, 3);

  // It belongs to the map it was confirmed on, and to a view that may write.
  await adapter.recordHandoff('map-b', 2);
  assert.equal(host.named('record_handoff').length, 3, 'another map is not this map');
  adapter.dispose();
});

test('a poll at the same version is delivered when it carries more of the history', async t => {
  const host = new FakeHost();
  const userEvent = (version: number, change: string) => ({ version, actor: 'user' as const, at: new Date(2026, 8, 8).toISOString(), changes: [change], operations: [] });
  // What a write hands back: the same version, but only its own event — the
  // window the caller's baseVersion asked for.
  const written = snapshot('map-a', 5, 'map-a', { sinceVersion: 4, events: [userEvent(5, '第二处修改')] });
  const { adapter, updates } = await openAdapter(t, host, written);
  const delivered = () => updates.filter(update => update.snapshot).map(update => update.snapshot!);
  assert.equal(delivered().at(-1)!.events.length, 1);

  // The poll reads the whole history at that same version. Before this, the
  // view was only told about newer versions, so the un-handed-over count stayed
  // at one until somebody else wrote.
  const full = snapshot('map-a', 5, 'map-a', { sinceVersion: 0, events: [userEvent(4, '第一处修改'), userEvent(5, '第二处修改')] });
  host.respond(() => toolResult(full, 'key-a'));
  await (adapter as unknown as { refresh(): Promise<void> }).refresh();
  const latest = delivered().at(-1)!;
  assert.equal(latest.version, 5);
  assert.equal(latest.events.length, 2, 'the wider window reached the view');
  assert.deepEqual(latest.events.map(event => event.changes[0]), ['第一处修改', '第二处修改']);

  // Repeating that same window is not news, so it is not announced again.
  const before = delivered().length;
  await (adapter as unknown as { refresh(): Promise<void> }).refresh();
  assert.equal(delivered().length, before, 'nothing changed, nothing announced');
  adapter.dispose();
});
