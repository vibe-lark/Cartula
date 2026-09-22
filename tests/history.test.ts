import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, normalizeMap } from '../src/core/model.js';
import { invertOperations } from '../src/web/components/history.js';
import type { EditOperation, MapInput, MapSnapshot, RoutingInput } from '../src/core/types.js';

const routing: RoutingInput = { source: 'OSRM', distanceKm: 1554, durationMinutes: 1080 };
const input: MapInput = { layers: [{ id: 'r', name: '路线', intent: '尽量少开车', points: [
  { id: 'a', name: '甲', at: [0, 0], flexibility: 'fixed', intent: '必须保留' },
  { id: 'b', name: '乙', at: [1, 0] }, { id: 'c', name: '丙', at: [2, 0] },
], path: [[0, 0], [1, 1], [2, 0]], routing }] };
function snapshot(data: MapInput = input): MapSnapshot {
  return { ...normalizeMap(data, undefined, 'agent'), id: 'history', version: 1, parent: null, changed: false, changes: [], events: [], updatedAt: '', url: '' };
}

test('invertOperations restores intent.set and route.leg.update; draft.commit has no inverse', () => {
  const map = snapshot();
  const ops: EditOperation[] = [
    { op: 'intent.set', scope: 'map', text: '减少长途驾驶', priority: 'prefer' },
    { op: 'intent.set', scope: 'point', layerId: 'r', pointId: 'a', text: '新意图', priority: 'must' },
    { op: 'route.leg.update', layerId: 'r', fromPointId: 'a', toPointId: 'b', patch: { durationMinutes: 40, traffic: 'moderate' } },
    { op: 'draft.commit', note: '本轮结束' },
  ];
  const inverse = invertOperations(map, ops);
  assert.equal(inverse.some(op => op.op === 'draft.commit'), false);
  const mapIntent = inverse.find(op => op.op === 'intent.set' && op.scope === 'map');
  assert.equal(mapIntent && mapIntent.op === 'intent.set' ? mapIntent.text : undefined, '');
  const pointIntent = inverse.find(op => op.op === 'intent.set' && op.scope === 'point');
  assert.equal(pointIntent && pointIntent.op === 'intent.set' ? pointIntent.text : undefined, '必须保留');
  const applied = applyOperations(map, ops);
  const restored = applyOperations({ ...map, layers: applied.layers, intents: applied.intents }, inverse);
  assert.equal(restored.intents?.find(item => item.scope === 'map'), undefined);
  assert.equal(restored.layers[0].points[0].intent, '必须保留');
  assert.equal(restored.layers[0].routing?.durationMinutes, 1080);
  assert.equal(restored.layers[0].routing?.legs?.[0]?.durationMinutes, undefined);
  assert.equal(restored.layers[0].routing?.legs?.[0]?.traffic, undefined);
});

test('invertOperations undoes a map-scope intent alias', () => {
  const map = snapshot();
  const inverse = invertOperations(map, [{ op: 'intent', text: '把两天加给瑞士' }]);
  assert.equal(inverse[0]?.op, 'intent.set');
  const applied = applyOperations(map, [{ op: 'intent', text: '把两天加给瑞士' }]);
  const restored = applyOperations({ ...map, layers: applied.layers, intents: applied.intents }, inverse);
  assert.equal(restored.intents?.find(item => item.scope === 'map'), undefined);
});
