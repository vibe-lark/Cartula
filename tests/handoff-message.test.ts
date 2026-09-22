/**
 * planningMessage's share-credential options.
 *
 * The bug: a share recipient who pastes the hand-off message into their own
 * Agent gets one that calls get_map with no credential at all, so their Agent
 * is refused. The fix threads the previewToken the recipient is holding into
 * the message itself — read-only or writable — while leaving the owner's own
 * message untouched, byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { planningMessage } from '../src/core/handoff.js';
import type { MapInput } from '../src/core/types.js';

const input: MapInput = { title: '交接消息测试', layers: [{ id: 'route', name: '自驾', points: [
  { id: 'a', name: '甲', at: [120.1, 30.2] }, { id: 'b', name: '乙', at: [121.4, 31.2] },
] }] };

/** Every occurrence of `needle` inside the first `(...)` call named `fn` in `text`. */
function hintCallOf(text: string, fn: string): string {
  return text.match(new RegExp(`${fn}\\([^)]*\\)`))?.[0] ?? '';
}
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test('planningMessage with a writable share token hands it to get_map and patch_map, once each', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await store.put('writable', input);
  await store.edit('writable', map.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '用户改动' }]);
  const token = 'cpt_faketokenwritable';
  const message = planningMessage(store.get('writable'), 0, { previewToken: token, canWrite: true });

  assert.equal(message.includes(`分享凭据 previewToken: ${token}`), true, 'the credential line names the token');
  assert.equal(countOf(hintCallOf(message, 'get_map'), token), 1, 'get_map names the token exactly once');
  assert.equal(countOf(hintCallOf(message, 'patch_map'), token), 1, 'patch_map names the token exactly once');
  assert.equal(message.includes('copy_map'), false, 'a writable share is never pointed at copy_map');
  assert.equal(message.includes('用你当前空间的凭据'), false, 'the recipient is never told to open the address with a space credential it does not have');
});

test('planningMessage with a read-only share token points at copy_map and never mentions patch_map', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await store.put('readonly', input);
  await store.edit('readonly', map.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '用户改动' }]);
  const token = 'cpt_faketokenreadonly';
  const message = planningMessage(store.get('readonly'), 0, { previewToken: token, canWrite: false });

  assert.equal(message.includes(`分享凭据 previewToken: ${token}`), true, 'the credential line names the token');
  assert.equal(countOf(hintCallOf(message, 'get_map'), token), 1, 'get_map names the token exactly once');
  assert.equal(countOf(hintCallOf(message, 'copy_map'), token), 1, 'copy_map names the token exactly once');
  assert.equal(message.includes('patch_map'), false, 'a read-only share is never told to patch_map');
  assert.equal(message.includes('只读'), true, 'the message says the link cannot write');
  assert.equal(message.includes('用你当前空间的凭据'), false, 'the recipient is never told to open the address with a space credential it does not have');
});

test('planningMessage without a share token is exactly the owner message it always was', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await store.put('owner', input);
  await store.edit('owner', map.editKey, 1, [{ op: 'annotate', layerId: 'route', pointId: 'a', text: '用户改动' }]);
  const snapshot = store.get('owner');
  // Read from the current head: no user event is left past it, so the hint's
  // own `since=` cursor falls back to exactly this version — not a second,
  // independently-computed number this test would have to predict.
  const since = snapshot.version;
  const withoutOptions = planningMessage(snapshot, since);
  const withEmptyOptions = planningMessage(snapshot, since, {});

  assert.equal(withEmptyOptions, withoutOptions, 'an options object naming neither field changes nothing');
  assert.equal(withoutOptions.includes('previewToken'), false, 'no credential line, and no token argument, for the owner');
  assert.equal(withoutOptions.includes('分享凭据'), false);
  assert.equal(withoutOptions.includes('copy_map'), false);
  assert.equal(withoutOptions.includes(`get_map(id="${snapshot.id}", since=${since}, view="affected")`), true, 'the get_map hint is exactly the one the owner has always seen');
  assert.equal(withoutOptions.includes('只用 patch_map 更新受影响的部分'), true, 'the owner keeps the plain patch_map instruction');
  assert.equal(withoutOptions.includes('用你当前空间的凭据'), true, 'the owner still gets told to open the address with their own space credential');
});
