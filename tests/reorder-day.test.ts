/**
 * Dragging a stop between day groups.
 *
 * The bug this pins: the sidebar renders its groups purely from `point.day`
 * (`LayerPanel` filters `points.filter(p => p.day === day)`), while `reorder`
 * only ever moved the stop's position in `layer.points`. Dropping an unscheduled
 * stop into 第 2 天 therefore changed the array order, left `day` unset, and the
 * next render put the row straight back where it came from — the user's "拖完之
 * 后也没有效果".
 *
 * The fix is on the calling side: a cross-group drop sends `reorder` *and*
 * `update {day}` as one batch. These tests cover the model half — that the batch
 * is atomic, that the two operations compose, and that `reorder` on its own
 * still has no day side effect, which is what keeps the API predictable for
 * agents calling `point.reorder` to re-sequence a leg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, normalizeMap } from '../src/core/model.js';
import type { EditOperation, MapInput, MapSnapshot } from '../src/core/types.js';
import { invertOperations } from '../src/web/components/history.js';

const INPUT: MapInput = {
  title: '行程',
  layers: [{
    id: 'plan', name: '方案 A', color: '#2563eb',
    points: [
      { id: 'a', name: '甲', at: [126.5, 45.8], day: 1 },
      { id: 'b', name: '乙', at: [127.5, 46.2], day: 2 },
      { id: 'c', name: '丙', at: [128.5, 46.9], day: 2 },
      { id: 'loose', name: '待定', at: [129.5, 47.5] },
    ],
  }],
};

function snapshotOf(input: MapInput): MapSnapshot {
  const { layers, title } = normalizeMap(input, undefined, 'agent');
  return { id: 'm', title, layers, version: 1, parent: null, changed: false, changes: [], events: [], updatedAt: '', url: '' };
}
const order = (snapshot: { layers: { points: { id: string }[] }[] }) => snapshot.layers[0].points.map(point => point.id);
const dayOf = (snapshot: { layers: { points: { id: string; day?: number }[] }[] }, id: string) =>
  snapshot.layers[0].points.find(point => point.id === id)?.day;

test('an unscheduled stop dragged into a day group actually joins that day', () => {
  const snapshot = snapshotOf(INPUT);
  assert.equal(dayOf(snapshot, 'loose'), undefined);
  // What the panel now sends for "dropped onto 第 2 天, after 丙".
  const result = applyOperations(snapshot, [
    { op: 'reorder', layerId: 'plan', pointId: 'loose', toIndex: 2 },
    { op: 'update', layerId: 'plan', pointId: 'loose', patch: { day: 2 } },
  ]);
  assert.deepEqual(order(result), ['a', 'b', 'loose', 'c']);
  assert.equal(dayOf(result, 'loose'), 2, '拖进第 2 天后必须真的属于第 2 天');
  // Both facts are reported, and in words the user can read back.
  assert.ok(result.changes.some(line => line.includes('待定') && line.includes('第 3 站')), result.changes.join(' | '));
  assert.ok(result.changes.some(line => line.includes('安排在第 2 天')), result.changes.join(' | '));
});

test('a stop dragged to the unscheduled group loses its day', () => {
  const snapshot = snapshotOf(INPUT);
  const result = applyOperations(snapshot, [
    { op: 'reorder', layerId: 'plan', pointId: 'b', toIndex: 3 },
    { op: 'update', layerId: 'plan', pointId: 'b', patch: { day: null } },
  ]);
  assert.equal(dayOf(result, 'b'), undefined, '拖到未排期必须清空 day');
  assert.deepEqual(order(result), ['a', 'c', 'loose', 'b']);
  assert.ok(result.changes.some(line => line.includes('已清除行程天数')), result.changes.join(' | '));
});

test('moving between two dated days changes the day, not just the position', () => {
  const snapshot = snapshotOf(INPUT);
  const result = applyOperations(snapshot, [
    { op: 'reorder', layerId: 'plan', pointId: 'c', toIndex: 0 },
    { op: 'update', layerId: 'plan', pointId: 'c', patch: { day: 1 } },
  ]);
  assert.equal(dayOf(result, 'c'), 1);
  assert.deepEqual(order(result), ['c', 'a', 'b', 'loose']);
});

test('a drop inside the same group moves the position and leaves the day alone', () => {
  const snapshot = snapshotOf(INPUT);
  // The panel omits the day operation entirely when the group did not change.
  const result = applyOperations(snapshot, [{ op: 'reorder', layerId: 'plan', pointId: 'c', toIndex: 1 }]);
  assert.deepEqual(order(result), ['a', 'c', 'b', 'loose']);
  assert.equal(dayOf(result, 'c'), 2, '同组内拖动不应改变 day');
});

test('reorder alone never changes a day: the API keeps position and date separate', () => {
  // This is the reason the fix lives in the caller rather than in `reorder`. An
  // agent re-sequencing a leg must not have its stops silently re-dated, and a
  // change line must not attribute a re-dating to a call that never mentioned
  // a day.
  const snapshot = snapshotOf(INPUT);
  const before = snapshot.layers[0].points.map(point => [point.id, point.day ?? null]);
  const result = applyOperations(snapshot, [
    { op: 'points.reorder', layerId: 'plan', pointIds: ['loose', 'c', 'b', 'a'] },
  ]);
  const after = result.layers[0].points.map(point => [point.id, point.day ?? null]);
  for (const [id, day] of before) {
    assert.deepEqual(after.find(entry => entry[0] === id), [id, day], `${id} 的 day 不应被 reorder 改动`);
  }
});

test('the batch is atomic: a rejected day leaves the order untouched', () => {
  const snapshot = snapshotOf(INPUT);
  // `day` must be a positive integer; the whole batch has to fail, or the list
  // would show a move the server never stored.
  assert.throws(() => applyOperations(snapshot, [
    { op: 'reorder', layerId: 'plan', pointId: 'loose', toIndex: 0 },
    { op: 'update', layerId: 'plan', pointId: 'loose', patch: { day: 0 } },
  ] as EditOperation[]));
  assert.deepEqual(order(snapshot), ['a', 'b', 'c', 'loose'], '被拒绝的批次不得改动快照');
  assert.equal(dayOf(snapshot, 'loose'), undefined);
});

test('undo restores both the position and the day of a cross-day drag', () => {
  const snapshot = snapshotOf(INPUT);
  const operations: EditOperation[] = [
    { op: 'reorder', layerId: 'plan', pointId: 'loose', toIndex: 1 },
    { op: 'update', layerId: 'plan', pointId: 'loose', patch: { day: 1 } },
  ];
  const inverse = invertOperations(snapshot, operations);
  const moved = applyOperations(snapshot, operations);
  assert.equal(dayOf(moved, 'loose'), 1);
  assert.deepEqual(order(moved), ['a', 'loose', 'b', 'c']);

  const undone = applyOperations({ ...snapshot, layers: moved.layers }, inverse);
  assert.deepEqual(order(undone), ['a', 'b', 'c', 'loose'], 'undo 应恢复原顺序');
  assert.equal(dayOf(undone, 'loose'), undefined, 'undo 应恢复未排期状态');
});
