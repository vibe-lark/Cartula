/**
 * REL-01: a map that create_map accepted must stay editable.
 *
 * The fixture is a deterministic substitute for the report's missing
 * `cartula-create-fixture.json` — same shape (3 routes, 35 stops, no supplied
 * `path`), auto-routed geometry well past the 50,497 coordinates that broke the
 * original map, and a local routing stub instead of the public OSRM service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { LIMITS } from '../src/core/schema.js';
import { simplifyPath, censusCoords, fitDerivedGeometry, reductionMessage, routeCoords } from '../src/core/geometry.js';
import { routeDistance } from '../src/core/geo.js';
import { DomainError, applyOperations, normalizeMap } from '../src/core/model.js';
import type { Coord, MapLayer, MapSnapshot } from '../src/core/types.js';
import {
  COORDS_PER_LEG,
  STRESS_INPUT,
  STRESS_LEG_COUNT,
  STRESS_RAW_COORDS,
  STRESS_STOP_COUNT,
  storedRouteCoords,
  stressOsrmFetch,
} from './fixtures/stress-route.js';

const routed = () => createApp({ dbPath: ':memory:', osrmUrl: 'https://router.test', osrmFetch: stressOsrmFetch() as never });

test('the stress fixture really is bigger than the reported failure', () => {
  assert.equal(STRESS_STOP_COUNT, 35);
  assert.equal(STRESS_LEG_COUNT, 32);
  assert.equal(STRESS_INPUT.layers.length, 3);
  assert.ok(STRESS_INPUT.layers.every(layer => layer.path === undefined && layer.routing === undefined));
  assert.ok(STRESS_RAW_COORDS > 50_497, `raw geometry ${STRESS_RAW_COORDS} must exceed the reported 50497`);
});

test('REL-01 create then keep editing: 3 routes, 35 stops, auto-routed geometry stays in budget', async t => {
  const { app, store } = await routed();
  t.after(() => app.close());

  const created = await app.inject({ method: 'PUT', url: '/m/stress', payload: STRESS_INPUT });
  assert.equal(created.statusCode, 200, created.body);
  const v1 = store.get('stress');
  assert.equal(v1.version, 1);
  assert.equal(v1.layers.reduce((sum, layer) => sum + layer.points.length, 0), STRESS_STOP_COUNT);

  // Every layer got real road geometry, and the whole map fits the derived budget.
  assert.ok(v1.layers.every(layer => (layer.path?.length ?? 0) >= 2), 'each route resolved a road');
  const derived = v1.layers.reduce((sum, layer) => sum + routeCoords(layer), 0);
  assert.ok(derived <= LIMITS.derivedCoordsPerMap, `derived coordinates ${derived} must fit ${LIMITS.derivedCoordsPerMap}`);
  const stored = storedRouteCoords(v1.layers);
  assert.ok(stored.total < STRESS_RAW_COORDS / 2, `stored ${stored.total} must be far below the raw ${STRESS_RAW_COORDS}`);

  // The reduction is reported, not silent, and says what was preserved.
  const creationChanges = store.get('stress', 0).changes.join(' ');
  assert.match(creationChanges, /道路几何已按 \d+ 米容差简化/);
  assert.match(creationChanges, /里程\/车程不变/);
  for (const layer of v1.layers) {
    assert.equal(layer.routingStatus?.geometry, 'resolved');
    assert.equal(layer.routingStatus?.provider, 'OSRM');
    assert.equal(layer.routingStatus?.coordinates, routeCoords(layer));
    assert.equal(layer.routingStatus?.simplified?.reason, 'derived-budget');
    assert.ok((layer.routingStatus?.simplified?.fromCoordinates ?? 0) > (layer.routingStatus?.simplified?.toCoordinates ?? 0));
  }

  // Endpoints, leg association and provider metrics survive the simplification.
  const key = (created.json() as { editKey: string }).editKey;
  const headers = { authorization: `Bearer ${key}` };
  for (const layer of v1.layers) {
    const legs = layer.routing?.legs ?? [];
    assert.equal(legs.length, layer.points.length - 1);
    legs.forEach((leg, index) => {
      assert.equal(leg.fromPointId, layer.points[index].id);
      assert.equal(leg.toPointId, layer.points[index + 1].id);
      assert.deepEqual(leg.path?.at(0), layer.points[index].at, 'a simplified leg still starts at its stop');
      assert.deepEqual(leg.path?.at(-1), layer.points[index + 1].at, 'a simplified leg still ends at its stop');
      assert.equal(leg.distanceKm, 120 + index * 7, 'provider distance is never recomputed from the drawn line');
    });
    const legTotal = legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0), 0);
    assert.ok(Math.abs((layer.stats.routingDistanceKm ?? 0) - legTotal) < 0.01);
    assert.ok((layer.stats.durationMinutes ?? 0) > 0);
  }

  // The operation that used to fail: a metadata-only edit on the created map.
  let version = v1.version;
  const edit = async (operations: unknown[], label: string) => {
    const base = version;
    const response = await app.inject({ method: 'PATCH', url: '/m/stress', headers, payload: { baseVersion: version, operations } });
    assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
    version = store.get('stress').version;
    return store.get('stress', base).changes;
  };
  await edit([{ op: 'intent.set', scope: 'map', text: '10 天以内，每天开车不超过 5 小时', priority: 'must' }], 'intent.set');
  await edit([{ op: 'layer.update', layerId: 'plan-a', patch: { note: '北线：多留一天给漠河' } }], 'layer.update note');
  await edit([{ op: 'point.update', layerId: 'plan-b', pointId: 'b3', patch: { at: [122.9, 47.1] } }], 'point.update at');
  const reorderChanges = await edit([{ op: 'points.reorder', layerId: 'plan-a', pointIds: store.get('stress').layers[0].points.map(point => point.id).reverse() }], 'points.reorder');
  // The road was re-resolved in the same version, so the report must describe
  // the stored road rather than the straight-line estimate that never landed.
  assert.match(reorderChanges.join(' '), /已用 OSRM 按道路重新解算/);
  assert.ok(!reorderChanges.some(line => line.includes('里程由') && line.endsWith('（直线估算）')), reorderChanges.join(' | '));
  await edit([{ op: 'annotate', layerId: 'plan-c', pointId: 'c2', text: '加油站在镇口' }], 'annotate again');

  const latest = store.get('stress');
  assert.equal(latest.version, version);
  const after = latest.layers.reduce((sum, layer) => sum + routeCoords(layer), 0);
  assert.ok(after <= LIMITS.derivedCoordsPerMap, `after five edits: ${after}`);
  // Reordering and moving a stop re-resolved the road instead of accumulating a
  // second copy of it.
  assert.ok(storedRouteCoords(latest.layers).total <= storedRouteCoords(v1.layers).total * 1.2, 'round trips must not accumulate geometry');
  assert.equal(latest.layers[0].points[0].id, 'a13', 'the reversal held');
  assert.ok(latest.layers.every(layer => (layer.path?.length ?? 0) >= 2), 'every route still draws a road');
});

test('REL-01 a stored map that predates the budget is repaired, not blocked', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  // Legacy shape: geometry already in the map, no routingStatus, far over budget.
  const legacyLeg = (from: Coord, to: Coord): Coord[] =>
    Array.from({ length: 13_000 }, (_, i): Coord => [from[0] + ((to[0] - from[0]) * i) / 12_999, from[1] + ((to[1] - from[1]) * i) / 12_999]);
  const path = legacyLeg([120, 45], [126, 48]);
  const created = await app.inject({ method: 'PUT', url: '/m/legacy', payload: { layers: [
    { id: 'route', name: '旧线', points: [{ id: 'a', name: '甲', at: [120, 45] }, { id: 'b', name: '乙', at: [126, 48] }], path,
      routing: { source: 'OSRM', distanceKm: 640, durationMinutes: 480, legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 640, durationMinutes: 480, path }] } },
  ] } });
  assert.equal(created.statusCode, 200, created.body);
  const stored = store.get('legacy');
  assert.ok(routeCoords(stored.layers[0]) > LIMITS.derivedCoordsPerMap, 'caller geometry inside quota but over the derived budget is stored as sent');

  const headers = { authorization: `Bearer ${(created.json() as { editKey: string }).editKey}` };
  const edited = await app.inject({ method: 'PATCH', url: '/m/legacy', headers, payload: { baseVersion: 1, operations: [
    { op: 'intent.set', scope: 'layer', layerId: 'route', text: '这段不要走夜路', priority: 'must' },
  ] } });
  assert.equal(edited.statusCode, 200, edited.body);
  const repaired = store.get('legacy', 1);
  assert.ok(routeCoords(repaired.layers[0]) <= LIMITS.derivedCoordsPerMap);
  assert.equal(repaired.layers[0].routingStatus?.geometry, 'simplified');
  assert.match(repaired.changes.join(' '), /道路几何已按/);
  assert.equal(repaired.layers[0].routing?.distanceKm, 640, 'provider mileage is untouched by the repair');
  assert.deepEqual(repaired.layers[0].path?.at(0), [120, 45]);
  assert.deepEqual(repaired.layers[0].path?.at(-1), [126, 48]);
});

test('REL-01 the input quota is strict, atomic and cannot be bought with a routing source', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const wall = (count: number): Coord[] => Array.from({ length: count }, (_, i): Coord => [120 + i / 1e6, 45]);
  const oversized = {
    layers: [
      { id: 'a', name: '甲线', points: [{ id: 'p1', name: '起', at: [120, 45] }, { id: 'p2', name: '终', at: [126, 48] }], path: wall(15_000) },
      { id: 'b', name: '乙线', points: [{ id: 'q1', name: '起', at: [120, 45] }, { id: 'q2', name: '终', at: [126, 48] }], path: wall(15_000),
        // Claiming the provider changes nothing: provenance is what Cartula stored, not what the payload says.
        routing: { source: 'OSRM', profile: 'driving', distanceKm: 640 } },
    ],
  };
  const rejected = await app.inject({ method: 'PUT', url: '/m/quota', payload: oversized });
  assert.equal(rejected.statusCode, 400, rejected.body);
  const body = rejected.json() as { error: string; hint: string; code: string; limit: string; threshold: number; actual: number; breakdown: { stops: number; callerRoute: number }; derived: { threshold: number } };
  assert.match(body.error, /超出坐标配额/, 'the human message survives the machine code');
  assert.equal(body.code, 'COORDINATE_BUDGET');
  assert.equal(body.limit, 'coordsPerMap');
  assert.equal(body.threshold, LIMITS.coordsPerMap);
  assert.equal(body.actual, 30_004);
  assert.equal(body.breakdown.callerRoute, 30_000);
  assert.equal(body.breakdown.stops, 4);
  assert.equal(body.derived.threshold, LIMITS.derivedCoordsPerMap);
  assert.match(body.hint, /独立配额/);
  assert.throws(() => store.get('quota'), (error: unknown) => error instanceof DomainError && error.statusCode === 404, 'a rejected write creates nothing');

  // Same coordinates, but resolved by Cartula: allowed, because that geometry
  // is charged to the derived budget and simplified rather than refused.
  const ok = await app.inject({ method: 'PUT', url: '/m/quota', payload: { layers: [oversized.layers[0]] } });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('REL-01 a full read can be written straight back, and rewriting geometry makes it the caller‘s again', async t => {
  const { app, store } = await routed();
  t.after(() => app.close());
  const created = await app.inject({ method: 'PUT', url: '/m/roundtrip', payload: STRESS_INPUT });
  const key = (created.json() as { editKey: string }).editKey;
  const full = (await app.inject({ url: '/m/roundtrip', headers: { authorization: `Bearer ${key}` } })).json() as MapSnapshot;
  const derivedBefore = full.layers.reduce((sum, layer) => sum + routeCoords(layer as MapLayer), 0);
  assert.ok(derivedBefore > 0);

  const rewritten = await app.inject({ method: 'PUT', url: '/m/roundtrip', headers: { authorization: `Bearer ${key}` }, payload: full });
  assert.equal(rewritten.statusCode, 200, rewritten.body);
  const after = store.get('roundtrip');
  assert.equal(after.version, 2);
  assert.equal(after.layers[0].routingStatus?.geometry, 'resolved', 'unchanged geometry keeps its provenance');
  assert.equal(after.layers.reduce((sum, layer) => sum + routeCoords(layer), 0), derivedBefore, 'a round trip neither grows nor re-simplifies');

  // Touch one coordinate and the whole layer's geometry is the caller's input.
  const layers = structuredClone(full.layers);
  layers[0].path = [...layers[0].path!, [125.5, 46.5]];
  const claimed = normalizeMap({ title: full.title, layers }, after, 'agent');
  const census = censusCoords(claimed.layers, layer => layer.routingStatus?.geometry === 'resolved' && layer.id !== 'plan-a');
  assert.ok(census.callerRoute > 0, 'the edited layer is charged to the caller');
  assert.equal(claimed.layers[0].routingStatus, undefined, 'and loses the resolved provenance');
});

test('REL-01 the budget holds when sampling has nothing left to remove', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  // Every leg is already at the two-coordinate floor, so tolerance and
  // decimation can free nothing: 6 × 999 chord legs, no whole line.
  const chordLayer = (n: number) => ({
    id: `l${n}`, name: `层${n}`,
    points: Array.from({ length: 1000 }, (_, i) => ({ id: `p${n}_${i}`, name: `点${i}`, at: [100 + i / 1000, 40 + n / 100] as Coord })),
    routing: { source: 'caller', legs: Array.from({ length: 999 }, (_, i) => ({
      fromPointId: `p${n}_${i}`, toPointId: `p${n}_${i + 1}`, distanceKm: 1 + i / 100, durationMinutes: 2,
      path: [[100 + i / 1000, 40 + n / 100], [100 + (i + 1) / 1000, 40 + n / 100]] as Coord[],
    })) },
  });
  const created = await app.inject({ method: 'PUT', url: '/m/floor', payload: { layers: [1, 2, 3, 4, 5, 6].map(chordLayer) } });
  assert.equal(created.statusCode, 200, created.body);
  const headers = { authorization: `Bearer ${(created.json() as { editKey: string }).editKey}` };
  const added = await app.inject({ method: 'PATCH', url: '/m/floor', headers, payload: { baseVersion: 1, operations: [{ op: 'layer.add', layer: chordLayer(7) }] } });
  assert.equal(added.statusCode, 200, added.body);
  const meta = await app.inject({ method: 'PATCH', url: '/m/floor', headers, payload: { baseVersion: 2, operations: [{ op: 'intent.set', scope: 'map', text: '少开车' }] } });
  assert.equal(meta.statusCode, 200, meta.body);

  const stored = store.get('floor');
  const derived = stored.layers.reduce((sum, layer) => sum + routeCoords(layer), 0);
  assert.ok(derived <= LIMITS.derivedCoordsPerMap, `derived ${derived} must fit ${LIMITS.derivedCoordsPerMap}`);
  assert.equal(stored.layers.length, 7);

  // What was given up: only geometry the stops reproduce exactly.
  for (const layer of stored.layers) {
    const status = layer.routingStatus!;
    assert.equal(status.simplified?.reason, 'derived-budget');
    assert.equal(status.simplified?.droppedLegPaths, 999);
    assert.equal(status.simplified?.legPathsRecoverable, true);
    assert.equal(status.coordinates, routeCoords(layer));
    const legs = layer.routing?.legs ?? [];
    assert.equal(legs.length, 999, 'legs themselves survive');
    assert.ok(legs.every(leg => leg.path === undefined));
    assert.ok(legs.every((leg, i) => leg.fromPointId === layer.points[i].id && leg.toPointId === layer.points[i + 1].id), 'leg-to-stop association is untouched');
    assert.equal(legs[3].distanceKm, 1.03, 'provider metrics are untouched');
    assert.equal(legs[3].durationMinutes, 2);
  }
  const reported = store.get('floor', 2).changes.join(' ');
  assert.match(reported, /移除 999 段与停靠点连线重复的分段几何（显示不变）/);
  assert.match(reported, /里程\/车程不变/);
});

test('REL-01 only an exact chord counts as recoverable geometry', () => {
  // Two identical layers except for their leg endpoints: one sits exactly on
  // its stops, the other ~8 m away — a routing provider snapping to the road.
  const layer = (id: string, offset: number) => ({
    id, name: `层${id}`,
    points: [{ id: `${id}a`, name: '甲', at: [100, 40] as Coord }, { id: `${id}b`, name: '乙', at: [101, 40] as Coord }],
    routing: { source: 'caller', legs: [{ fromPointId: `${id}a`, toPointId: `${id}b`, distanceKm: 90, path: [[100 + offset, 40], [101 + offset, 40]] as Coord[] }] },
  });
  const layers = normalizeMap({ layers: [layer('exact', 0), layer('snapped', 0.0001)] }, undefined, 'agent').layers;
  // A budget that only the redundant copy can satisfy, then not even that.
  const reductions = fitDerivedGeometry(layers, () => true, 1);
  assert.equal(layers.reduce((sum, item) => sum + routeCoords(item), 0), 0, 'both had to give up their geometry');

  const exact = reductions.find(reduction => reduction.layerId === 'exact')!;
  assert.equal(exact.droppedLegPaths, 1);
  assert.equal(exact.legPathsRecoverable, true);
  assert.match(reductionMessage(exact), /与停靠点连线重复的分段几何（显示不变）/);

  // ~8 m from the stop is a real entrance or kerb position: dropping it moves
  // the drawn line, so it is a loss and must not claim otherwise.
  const snapped = reductions.find(reduction => reduction.layerId === 'snapped')!;
  assert.equal(snapped.droppedLegPaths, 1);
  assert.equal(snapped.legPathsRecoverable, false);
  assert.match(reductionMessage(snapped), /改按停靠点直线绘制/);
  assert.ok(!reductionMessage(snapped).includes('显示不变'));
  assert.equal(layers[1].routingStatus?.simplified?.legPathsRecoverable, false);
  assert.equal(layers[1].routing?.legs?.[0].distanceKm, 90, 'provider metrics stay');
});

test('REL-01 the fit is bounded by structure, not by hope', () => {
  // A budget nothing can be sampled into: the escalation has to end in a
  // structural step, and it has to end inside the budget.
  const layers = normalizeMap({ layers: Array.from({ length: 6 }, (_, n) => ({
    id: `l${n}`, name: `层${n}`,
    points: [{ id: `a${n}`, name: '甲', at: [100 + n, 40] as Coord }, { id: `b${n}`, name: '乙', at: [101 + n, 41] as Coord }],
    path: Array.from({ length: 40 }, (_, i): Coord => [100 + n + i / 40, 40 + Math.sin(i) / 20]),
    routing: { source: 'caller', legs: [{ fromPointId: `a${n}`, toPointId: `b${n}`, distanceKm: 12, path: Array.from({ length: 40 }, (_, i): Coord => [100 + n + i / 40, 40 + Math.sin(i) / 20]) }] },
  })) }, undefined, 'agent').layers;
  const floor = layers.length * 2;
  const reductions = fitDerivedGeometry(layers, () => true, floor);
  const total = layers.reduce((sum, layer) => sum + routeCoords(layer), 0);
  assert.ok(total <= floor, `total ${total} must fit the structural floor of ${floor}`);
  assert.ok(reductions.some(reduction => reduction.endpointsOnly), 'the last step is reported');
  assert.ok(layers.every(layer => (layer.path?.length ?? 0) <= 2));
  assert.ok(layers.every(layer => layer.routing?.legs?.every(leg => leg.distanceKm === 12)), 'provider metrics survive the deepest step');
  assert.ok(reductions.every(reduction => reduction.toCoordinates < reduction.fromCoordinates));

  // Below that floor nothing can succeed, and it fails loudly instead of
  // storing a map the next edit would reject.
  assert.throws(() => fitDerivedGeometry(normalizeMap({ layers: [
    { id: 'x', name: '一层', points: [{ id: 'a', name: '甲', at: [1, 1] }, { id: 'b', name: '乙', at: [2, 2] }], path: [[1, 1], [1.5, 1.4], [2, 2]] },
  ] }, undefined, 'agent').layers, () => true, 1), /配额需不低于 2/);
});

test('REL-01 the derived budget covers the structural floor', () => {
  // Two coordinates per layer is the floor the escalation can reach; the budget
  // has to stay above it or `fitDerivedGeometry` has no legal outcome.
  assert.ok(LIMITS.layers * 2 <= LIMITS.derivedCoordsPerMap, `${LIMITS.layers} layers need at least ${LIMITS.layers * 2} coordinates`);
});

test('REL-01 a repaired round trip reports the reduction and refreshes its stats', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  // Caller geometry inside the input quota but over the derived budget: legal
  // to write, and repaired the moment it comes back as carried geometry.
  const wiggly = Array.from({ length: 12_500 }, (_, i): Coord => [120 + i / 20_000, 45 + Math.sin(i / 3) / 400]);
  const created = await app.inject({ method: 'PUT', url: '/m/repair', payload: { layers: [
    { id: 'route', name: '旧线', points: [{ id: 'a', name: '甲', at: wiggly[0] }, { id: 'b', name: '乙', at: wiggly.at(-1)! }], path: wiggly },
  ] } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(routeCoords(store.get('repair').layers[0]), 12_500);

  const repairKey = (created.json() as { editKey: string }).editKey;
  const full = (await app.inject({ url: '/m/repair', headers: { authorization: `Bearer ${repairKey}` } })).json() as MapSnapshot;
  const back = await app.inject({ method: 'PUT', url: '/m/repair', headers: { authorization: `Bearer ${repairKey}` }, payload: full });
  assert.equal(back.statusCode, 200, back.body);
  const repaired = store.get('repair', 1);
  assert.match(repaired.changes.join(' '), /道路几何已按 \d+ 米容差简化/, 'the repair is reported on the write that made it');
  const layer = repaired.layers[0];
  assert.ok(routeCoords(layer) <= LIMITS.derivedCoordsPerMap);
  assert.equal(layer.routingStatus?.simplified?.reason, 'derived-budget');
  assert.equal(layer.routingStatus?.coordinates, routeCoords(layer));
  assert.equal(layer.stats.distanceKind, 'provided');
  assert.ok(Math.abs((layer.stats.geometryDistanceKm ?? 0) - routeDistance(layer.path!)) < 0.001, 'stats describe the geometry actually stored');
  assert.deepEqual(layer.path?.at(0), wiggly[0]);
  assert.deepEqual(layer.path?.at(-1), wiggly.at(-1));
});

test('simplifyPath keeps endpoints and respects its tolerance', () => {
  const straight: Coord[] = Array.from({ length: 500 }, (_, i): Coord => [120 + i / 1000, 45]);
  const simplified = simplifyPath(straight, 20);
  assert.equal(simplified.length, 2, 'a straight line collapses to its endpoints');
  assert.deepEqual(simplified[0], straight[0]);
  assert.deepEqual(simplified.at(-1), straight.at(-1));

  // A 2 km detour is not noise: a 20 m tolerance has to keep it.
  const detour: Coord[] = [[120, 45], [120.01, 45.02], [120.02, 45]];
  assert.deepEqual(simplifyPath(detour, 20), detour);
  assert.equal(simplifyPath([[120, 45], [121, 46]], 20).length, 2);
  assert.equal(simplifyPath([], 20).length, 0);
});

test('applyOperations rejects a batch that pushes the caller past the quota', () => {
  const base = normalizeMap({ layers: [{ id: 'route', name: '线', points: [{ id: 'a', name: '甲', at: [120, 45] }, { id: 'b', name: '乙', at: [121, 46] }] }] }, undefined, 'agent');
  const snapshot = { id: 'm', title: '线', layers: base.layers, version: 1, parent: null, changed: false, changes: [], events: [], updatedAt: '', url: '' } satisfies MapSnapshot;
  const huge: Coord[] = Array.from({ length: 19_000 }, (_, i): Coord => [120 + i / 1e6, 45]);
  assert.throws(
    () => applyOperations(snapshot, [{ op: 'layer.update', layerId: 'route', patch: { path: huge } }, { op: 'layer.add', layer: { name: '再来一层', points: [], path: huge } }]),
    (error: unknown) => error instanceof DomainError && error.statusCode === 400 && (error.details as { code: string }).code === 'COORDINATE_BUDGET',
  );
  // One of them alone is inside the quota.
  const ok = applyOperations(snapshot, [{ op: 'layer.update', layerId: 'route', patch: { path: huge } }]);
  assert.equal(ok.layers[0].path?.length, 19_000);
  assert.equal(ok.layers[0].routingStatus, undefined);
  assert.equal(COORDS_PER_LEG, 1_600);
});
