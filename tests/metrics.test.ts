import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, layerStats, normalizeMap, toMapInput } from '../src/core/model.js';
import { MapInputSchema } from '../src/core/schema.js';
import type { MapInput, MapSnapshot, RoutingInput } from '../src/core/types.js';

const routing: RoutingInput = { source: 'OSRM', distanceKm: 1554, durationMinutes: 1080 };
const input: MapInput = { layers: [{ id: 'r', name: '路线', intent: '尽量少开车', points: [
  { id: 'a', name: '甲', at: [0, 0], flexibility: 'fixed', intent: '必须保留' },
  { id: 'b', name: '乙', at: [1, 0] }, { id: 'c', name: '丙', at: [2, 0] },
], path: [[0, 0], [1, 1], [2, 0]], routing }] };
function snapshot(data: MapInput = input): MapSnapshot {
  return { ...normalizeMap(data, undefined, 'agent'), id: 'metrics', version: 1, parent: null, changed: false, changes: [], events: [], updatedAt: '', url: '' };
}
test('route-reported distance/time is independent of simplified geometry and survives roundtrip', () => {
  const map = snapshot(), stats = layerStats(map.layers[0]);
  assert.equal(stats.routingDistanceKm, 1554); assert.equal(stats.durationMinutes, 1080);
  assert.ok(stats.geometryDistanceKm! > stats.straightDistanceKm!); assert.ok(stats.geometryDistanceKm! < 1554);
  assert.equal(stats.distanceKm, stats.geometryDistanceKm);
  const roundtrip = snapshot(toMapInput(map));
  assert.deepEqual(roundtrip.layers, map.layers);
  const simplified = applyOperations(map, [{ op: 'layer.update', layerId: 'r', patch: { path: [[0, 0], [2, 0]] } }]);
  assert.equal(simplified.layers[0].stats.routingDistanceKm, 1554);
  assert.equal(simplified.layers[0].stats.durationMinutes, 1080);
  assert.notEqual(simplified.layers[0].stats.geometryDistanceKm, stats.geometryDistanceKm);
});
test('unknown metrics stay absent; complete legs sum each available metric independently', () => {
  const data = structuredClone(input); delete data.layers[0].routing;
  assert.equal(snapshot(data).layers[0].stats.durationMinutes, undefined);
  data.layers[0].routing = { source: 'router', legs: [
    { fromPointId: 'a', toPointId: 'b', distanceKm: 20, durationMinutes: 30 },
    { fromPointId: 'b', toPointId: 'c', distanceKm: 40 },
  ] };
  let map = snapshot(data);
  assert.equal(map.layers[0].stats.routingDistanceKm, 60); assert.equal(map.layers[0].stats.durationMinutes, undefined);
  data.layers[0].routing.legs![1].durationMinutes = 45;
  map = snapshot(data); assert.equal(map.layers[0].stats.durationMinutes, 75);
  data.layers[0].routing.distanceKm = 65;
  assert.equal(snapshot(data).layers[0].stats.routingDistanceKm, 65);
  data.layers[0].routing.legs!.pop(); delete data.layers[0].routing.distanceKm;
  assert.equal(snapshot(data).layers[0].stats.routingDistanceKm, undefined);
});
test('route leg references must be unique adjacent point IDs; values are finite nonnegative', () => {
  for (const legs of [
    [{ fromPointId: 'a', toPointId: 'c' }], [{ fromPointId: 'a', toPointId: 'missing' }],
    [{ fromPointId: 'a', toPointId: 'b' }, { fromPointId: 'a', toPointId: 'b' }],
  ]) {
    const data = structuredClone(input); data.layers[0].routing = { source: 'router', legs };
    assert.throws(() => snapshot(data), /相邻地点/);
  }
  for (const value of [-1, Infinity, NaN]) {
    const data = structuredClone(input); data.layers[0].routing!.durationMinutes = value;
    assert.equal(MapInputSchema.safeParse(data).success, false);
  }
});
test('node edits invalidate geometry and routing; new measurements follow operation order', () => {
  const map = snapshot();
  for (const operation of [
    { op: 'update' as const, layerId: 'r', pointId: 'b', patch: { at: [1, 2] as [number, number] } },
    { op: 'delete' as const, layerId: 'r', pointId: 'b' },
    { op: 'reorder' as const, layerId: 'r', pointId: 'b', toIndex: 2 },
    { op: 'insert' as const, layerId: 'r', point: { id: 'd', name: '丁', at: [3, 0] as [number, number] } },
    { op: 'layer.update' as const, layerId: 'r', patch: { kind: 'spots' as const } },
  ]) {
    const result = applyOperations(map, [operation]);
    assert.equal(result.layers[0].path, undefined); assert.equal(result.layers[0].routing, undefined);
    assert.equal(result.layers[0].stats.durationMinutes, undefined);
  }
  const changed = { op: 'update' as const, layerId: 'r', pointId: 'b', patch: { at: [1, 2] as [number, number] } };
  const fresh = { op: 'layer.update' as const, layerId: 'r', patch: { path: [[0, 0], [1, 2], [2, 0]] as [number, number][], routing: { source: 'new router', distanceKm: 100, durationMinutes: 90 } } };
  const kept = applyOperations(map, [changed, fresh]); assert.equal(kept.layers[0].routing?.distanceKm, 100);
  assert.equal(kept.layers[0].path?.[1][1], 2);
  const cleared = applyOperations(map, [fresh, changed]); assert.equal(cleared.layers[0].routing, undefined);
  assert.deepEqual(map.layers[0].routing, routing, 'input snapshot remains untouched');
});
test('per-leg transport profile round-trips through normalize and operations; schema bounds it', () => {
  const data = structuredClone(input);
  data.layers[0].routing = { source: 'router', profile: 'driving', legs: [
    { fromPointId: 'a', toPointId: 'b', distanceKm: 20, profile: 'walking' },
    { fromPointId: 'b', toPointId: 'c', distanceKm: 40 },
  ] };
  const map = snapshot(data);
  assert.equal(map.layers[0].routing?.legs?.[0].profile, 'walking');
  const roundtrip = snapshot(toMapInput(map));
  assert.deepEqual(roundtrip.layers, map.layers);
  const updated = applyOperations(map, [{ op: 'layer.update', layerId: 'r', patch: { routing: { source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', profile: 'ferry' }] } } }]);
  assert.equal(updated.layers[0].routing?.legs?.[0].profile, 'ferry');
  const invalid = structuredClone(data);
  (invalid.layers[0].routing!.legs![0] as unknown as Record<string, unknown>).profile = 5;
  assert.equal(MapInputSchema.safeParse(invalid).success, false);
  invalid.layers[0].routing!.legs![0].profile = 'x'.repeat(81);
  assert.equal(MapInputSchema.safeParse(invalid).success, false);
  invalid.layers[0].routing!.legs![0].profile = '缆车';
  assert.equal(MapInputSchema.safeParse(invalid).success, true);
  assert.deepEqual(map.layers[0].routing?.legs?.[0], { fromPointId: 'a', toPointId: 'b', distanceKm: 20, profile: 'walking' }, 'input snapshot remains untouched');
});
test('intent and flexibility retain actor, can be cleared and do not invalidate road metrics', () => {
  const map = snapshot();
  const result = applyOperations(map, [
    { op: 'update', layerId: 'r', pointId: 'a', patch: { intent: '', flexibility: null } },
    { op: 'layer.update', layerId: 'r', patch: { intent: '缩短驾驶时间' } }, { op: 'intent', text: '把两天加给瑞士' },
  ], 'agent');
  assert.equal(result.layers[0].points[0].intent, undefined); assert.equal(result.layers[0].points[0].flexibility, undefined);
  assert.equal(result.layers[0].routing?.distanceKm, 1554); assert.equal(result.layers[0].edited_by, 'agent');
  assert.ok(result.changes.every(change => change.startsWith('Agent：')));
  assert.ok(result.changes.some(change => change.includes('把两天加给瑞士')));
  const failed = [{ op: 'layer.update' as const, layerId: 'r', patch: { routing: { source: 'broken', legs: [{ fromPointId: 'c', toPointId: 'a' }] } } }];
  assert.throws(() => applyOperations(map, failed), /相邻地点/);
  assert.deepEqual(map.layers[0].routing, routing);
});
test('point.* aliases, intent.set, route.leg.update and draft.commit are first-class operations', () => {
  const map = snapshot();
  const inserted = applyOperations(map, [{ op: 'point.insert', layerId: 'r', point: { id: 'd', name: '丁', at: [3, 0] }, after: 'a' }]);
  assert.equal(inserted.layers[0].points[1].id, 'd');
  const intents = applyOperations(map, [
    { op: 'intent.set', scope: 'map', text: '减少长途驾驶', priority: 'prefer' },
    { op: 'intent.set', scope: 'point', layerId: 'r', pointId: 'a', text: '必须保留甲', priority: 'must' },
  ]);
  assert.equal(intents.intents?.find(item => item.scope === 'map')?.text, '减少长途驾驶');
  assert.equal(intents.layers[0].points[0].intent, '必须保留甲');
  const leg = applyOperations(map, [{ op: 'route.leg.update', layerId: 'r', fromPointId: 'a', toPointId: 'b', patch: { durationMinutes: 40, traffic: 'moderate', profile: 'driving' } }]);
  assert.equal(leg.layers[0].routing?.legs?.[0].durationMinutes, 40);
  assert.equal(leg.layers[0].routing?.legs?.[0].traffic, 'moderate');
  const committed = applyOperations(map, [{ op: 'draft.commit', note: '本轮结束' }]);
  assert.ok(committed.changes.some(change => change.includes('本轮结束')));
});

test('avoiding a leg clears its routing facts so stats fall back to remaining legs', () => {
  const map = snapshot();
  const routing = { ...map.layers[0].routing! };
  delete routing.distanceKm; delete routing.durationMinutes;
  const avoided = applyOperations(map, [
    { op: 'layer.update', layerId: 'r', patch: { routing } },
    { op: 'route.leg.update', layerId: 'r', fromPointId: 'a', toPointId: 'b', patch: { note: '用户要求避免 甲 至 乙', path: null, distanceKm: null, durationMinutes: null, delayMinutes: null } },
  ]);
  const leg = avoided.layers[0].routing?.legs?.find(part => part.fromPointId === 'a' && part.toPointId === 'b');
  assert.equal(leg?.note, '用户要求避免 甲 至 乙');
  assert.equal(leg?.distanceKm, undefined);
  assert.equal(leg?.durationMinutes, undefined);
  assert.equal(avoided.layers[0].routing?.distanceKm, undefined);
  assert.equal(avoided.layers[0].stats.routingDistanceKm, undefined);
});
