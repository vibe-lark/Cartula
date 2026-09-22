/**
 * Core model tests: geometry, CRS, validation, and semantic editing.
 * Run with `npx tsx --test tests/model.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { gcj02ToWgs84, haversineKm, routeDistance } from '../src/core/geo.js';
import { DomainError, applyOperations, normalizeMap, toMapInput } from '../src/core/model.js';
import { EditOperationSchema, LIMITS, MapInputSchema } from '../src/core/schema.js';
import { DEMO_INPUT } from '../src/core/demo.js';
import type { Coord, EditOperation, MapInput, MapLayer, MapSnapshot } from '../src/core/types.js';

// --- helpers --------------------------------------------------------------

/** Wrap normalised layers in the snapshot shape the edit path consumes. */
function snapshotOf(input: MapInput, actor: 'agent' | 'user' = 'agent'): MapSnapshot {
  const parsed = MapInputSchema.parse(input);
  const { title, layers } = normalizeMap(parsed, undefined, actor);
  return {
    id: 'test',
    title,
    layers,
    version: 1,
    parent: null,
    changed: false,
    changes: [],
    events: [],
    updatedAt: '2026-09-05T00:00:00.000Z',
    url: 'https://example.test/m/test',
  };
}

/** Fold an edit result back into a snapshot, the way the storage layer will. */
const advance = (snapshot: MapSnapshot, result: { title: string; layers: MapLayer[] }): MapSnapshot => ({
  ...snapshot,
  title: result.title,
  layers: result.layers,
  version: snapshot.version + 1,
});

const layerOf = (snapshot: MapSnapshot, name: string): MapLayer => {
  const layer = snapshot.layers.find((candidate) => candidate.name === name);
  assert.ok(layer, `expected a layer named ${name}`);
  return layer;
};

const pointOf = (layer: MapLayer, name: string): string => {
  const point = layer.points.find((candidate) => candidate.name === name);
  assert.ok(point, `expected a point named ${name}`);
  return point.id;
};

const HARBIN: Coord = [126.53, 45.7975];
const YICHUN: Coord = [128.8347, 47.7256];
const HEIHE: Coord = [127.492, 50.242];

const twoPointRoute: MapInput = {
  title: '双点线',
  layers: [{ name: '主线', kind: 'route', points: [{ name: '哈尔滨', at: HARBIN }, { name: '伊春', at: YICHUN }] }],
};

const errorOf = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to throw');
};

// --- geo ------------------------------------------------------------------

test('haversineKm matches known great-circle distances', () => {
  // One degree of longitude at the equator, and a textbook long-haul pair.
  assert.ok(Math.abs(haversineKm([0, 0], [1, 0]) - 111.195) < 0.01);
  assert.ok(Math.abs(haversineKm([-0.1276, 51.5072], [-74.006, 40.7128]) - 5570) < 15, 'London–New York ≈ 5570 km');
  assert.ok(Math.abs(haversineKm([0, 0], [180, 0]) - 20015.1) < 1, 'antipodal points, no NaN from float overshoot');
  assert.equal(haversineKm(HARBIN, HARBIN), 0);
  // Symmetric, and unaffected by the 180° meridian.
  assert.equal(haversineKm(HARBIN, HEIHE), haversineKm(HEIHE, HARBIN));
  assert.ok(Math.abs(haversineKm([179.5, 0], [-179.5, 0]) - 111.195) < 0.01);
});

test('routeDistance sums consecutive legs and is 0 below two points', () => {
  assert.equal(routeDistance([]), 0);
  assert.equal(routeDistance([HARBIN]), 0);
  const chain = routeDistance([HARBIN, YICHUN, HEIHE]);
  assert.ok(Math.abs(chain - (haversineKm(HARBIN, YICHUN) + haversineKm(YICHUN, HEIHE))) < 1e-9);
  // A detour is never shorter than the direct line.
  assert.ok(chain > haversineKm(HARBIN, HEIHE));
});

test('gcj02ToWgs84 inverts the published offset inside China', () => {
  // Round-trip against the forward offset: convert back, and the shift must be
  // both in the right direction and small enough to be sub-metre accurate.
  const gcjBeijing: Coord = [116.4062479, 39.9014349]; // GCJ-02 for [116.4, 39.9]
  const wgs = gcj02ToWgs84(gcjBeijing);
  assert.ok(Math.abs(wgs[0] - 116.4) < 1e-4, `lon ${wgs[0]}`);
  assert.ok(Math.abs(wgs[1] - 39.9) < 1e-4, `lat ${wgs[1]}`);
  // The correction is a few hundred metres — real, but never kilometres.
  const shift = haversineKm(gcjBeijing, wgs) * 1000;
  assert.ok(shift > 100 && shift < 1000, `shift ${shift} m`);
});

test('gcj02ToWgs84 leaves coordinates outside China untouched', () => {
  for (const outside of [[139.6917, 35.6895], [-74.006, 40.7128], [151.2093, -33.8688], [0, 0]] as Coord[]) {
    assert.deepEqual(gcj02ToWgs84(outside), outside);
  }
  // Tokyo would move hundreds of metres if the offset were applied blindly.
  assert.equal(haversineKm([139.6917, 35.6895], gcj02ToWgs84([139.6917, 35.6895])), 0);
});

// --- schema ---------------------------------------------------------------

test('schema rejects out-of-range longitude and latitude', () => {
  const bad = MapInputSchema.safeParse({ layers: [{ name: 'x', points: [{ name: 'p', at: [181, 0] }] }] });
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0].message, /经度/);

  const badLat = MapInputSchema.safeParse({ layers: [{ name: 'x', points: [{ name: 'p', at: [0, -91] }] }] });
  assert.equal(badLat.success, false);
  assert.match(badLat.error!.issues[0].message, /纬度/);

  // Boundaries are inclusive, and a third (altitude) element is dropped.
  const ok = MapInputSchema.parse({
    layers: [{ name: 'x', points: [{ name: 'a', at: [-180, -90] }, { name: 'b', at: [180, 90, 640] }] }],
  });
  assert.deepEqual(ok.layers[0].points!.map((p) => p.at), [[-180, -90], [180, 90]]);

  for (const at of [[1], 'x', [1, 'a'], [null, 1], [1, Number.NaN]]) {
    assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'x', points: [{ name: 'p', at }] }] }).success, false);
  }
});

test('schema scopes point ids to their layer and layer ids to the map', () => {
  const dupLayers = MapInputSchema.safeParse({ layers: [{ id: 'a', name: '1' }, { id: 'a', name: '2' }] });
  assert.equal(dupLayers.success, false);
  assert.match(dupLayers.error!.issues[0].message, /重复的图层 id/);

  // Duplicates inside one layer are still ambiguous.
  const dupPoints = MapInputSchema.safeParse({
    layers: [{ name: 'l', points: [{ id: 'p', name: 'a', at: [0, 0] }, { id: 'p', name: 'b', at: [1, 1] }] }],
  });
  assert.equal(dupPoints.success, false);
  assert.match(dupPoints.error!.issues[0].message, /图层「l」内重复的点 id/);

  // But point ids are layer-local: every EditOperation carries a layerId, so
  // two routes may each have their own '哈尔滨'.
  assert.equal(
    MapInputSchema.safeParse({
      layers: [
        { name: '小兴安岭线', points: [{ id: 'harbin', name: '哈尔滨', at: [126.53, 45.8] }] },
        { name: '大兴安岭线', points: [{ id: 'harbin', name: '哈尔滨', at: [126.53, 45.8] }] },
      ],
    }).success,
    true,
    'the same point id in different layers is fine',
  );
  // A point id may also equal a layer id — different namespaces.
  assert.equal(
    MapInputSchema.safeParse({ layers: [{ id: 'x', name: 'l', points: [{ id: 'x', name: 'a', at: [0, 0] }] }] }).success,
    true,
  );
  assert.equal(MapInputSchema.safeParse({ layers: [{ id: 'a', name: '1' }, { id: 'b', name: '2' }] }).success, true);
});

test('schema requires only name and point.at/name', () => {
  assert.deepEqual(MapInputSchema.parse({ layers: [] }), { layers: [] });
  assert.deepEqual(MapInputSchema.parse({}), { layers: [] });
  const minimal = MapInputSchema.parse({ layers: [{ name: '空图层' }] });
  assert.deepEqual(minimal.layers[0], { name: '空图层' });
  assert.equal(MapInputSchema.parse({ layers: [{ name: 'l', points: [] }] }).layers[0].points!.length, 0);

  assert.equal(MapInputSchema.safeParse({ layers: [{ points: [] }] }).success, false, 'layer needs a name');
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: '  ' }] }).success, false, 'blank name is not a name');
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', points: [{ name: 'p' }] }] }).success, false);
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', points: [{ at: [0, 0] }] }] }).success, false);
});

test('schema strips unknown fields so a snapshot can be PUT back', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const reparsed = MapInputSchema.parse(snapshot) as Record<string, unknown>;
  assert.equal((reparsed.layers as unknown[]).length, DEMO_INPUT.layers.length);
  for (const key of ['id', 'version', 'parent', 'events', 'updatedAt', 'url', 'changed', 'changes']) {
    assert.equal(key in reparsed, false, `${key} must be stripped from the map`);
  }
  const layer = (reparsed.layers as Record<string, unknown>[])[0];
  assert.ok(!('stats' in layer) && !('edited_by' in layer) && !('inputCrs' in layer));
  assert.equal(layer.id, DEMO_INPUT.layers[0].id, 'ids survive so a re-PUT updates in place');
});

test('schema enforces colour, img url, crs, and length limits', () => {
  assert.equal(MapInputSchema.parse({ layers: [{ name: 'l', color: '#AABBCC' }] }).layers[0].color, '#aabbcc');
  for (const color of ['red', '#abc', '#12345g', '#1234567', 'rgb(0,0,0)']) {
    assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', color }] }).success, false, color);
  }

  // img is the one URL field: https, or empty for "no image".
  const url = (img: string) => MapInputSchema.safeParse({ layers: [{ name: 'l', points: [{ name: 'p', at: [0, 0], img }] }] });
  assert.equal(url('https://example.com/a.jpg').success, true);
  assert.equal(url('').success, true, 'empty img means "no image"');
  for (const bad of ['http://example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://h/a']) {
    assert.equal(url(bad).success, false, bad);
  }

  // note/from/text are plain prose and are never URL-checked: a colon in
  // ordinary writing must not be mistaken for a URI scheme.
  const prose = ['Warning: low fuel', 'source: demo', '注意：油量偏低', 'tel:110 打不通', 'javascript:不是链接，只是吐槽'];
  for (const value of prose) {
    assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', from: value }] }).success, true, `from: ${value}`);
    assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', note: value }] }).success, true, `note: ${value}`);
    assert.equal(
      MapInputSchema.safeParse({ layers: [{ name: 'l', points: [{ name: 'p', at: [0, 0], note: value }] }] }).success,
      true,
      `point.note: ${value}`,
    );
    assert.equal(EditOperationSchema.safeParse({ op: 'annotate', layerId: 'l', pointId: 'p', text: value }).success, true, value);
  }

  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', crs: 'gcj02' }] }).success, true);
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', crs: 'bd09' }] }).success, false);
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', kind: 'heatmap' }] }).success, false);

  assert.equal(MapInputSchema.safeParse({ title: 'x'.repeat(LIMITS.title + 1) }).success, false);
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'x'.repeat(LIMITS.name + 1) }] }).success, false);
  assert.equal(
    MapInputSchema.safeParse({ layers: [{ name: 'l', points: [{ name: 'p', at: [0, 0], note: 'x'.repeat(LIMITS.note + 1) }] }] })
      .success,
    false,
  );
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', from: 'x'.repeat(LIMITS.from + 1) }] }).success, false);
});

test('schema accepts readable ids and rejects unusable ones', () => {
  // The demo ships hyphenated ids, and generated ones use underscores.
  for (const id of ['demo-lesser-khingan', 'p_0a1b2c3d4e', 'A.b:1', '哈尔滨']) {
    assert.equal(MapInputSchema.safeParse({ layers: [{ id, name: 'l' }] }).success, true, id);
  }
  // Whitespace and control characters would break ids in URLs and logs.
  for (const id of ['has space', 'tab\tid', 'nul\u0000id', 'nl\nid', '\u007f', '', '   ', 'x'.repeat(LIMITS.id + 1)]) {
    assert.equal(MapInputSchema.safeParse({ layers: [{ id, name: 'l' }] }).success, false, JSON.stringify(id));
  }
  // Surrounding whitespace is trimmed rather than rejected.
  assert.equal(MapInputSchema.parse({ layers: [{ id: '  keep-me  ', name: 'l' }] }).layers[0].id, 'keep-me');
});

test('schema enforces layer, point, and whole-map size budgets', () => {
  const layers = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `层${i}` }));
  assert.equal(MapInputSchema.safeParse({ layers: layers(LIMITS.layers) }).success, true);
  assert.equal(MapInputSchema.safeParse({ layers: layers(LIMITS.layers + 1) }).success, false);

  const points = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `点${i}`, at: [100, 40] as Coord }));
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', points: points(LIMITS.pointsPerLayer) }] }).success, true);
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'l', points: points(LIMITS.pointsPerLayer + 1) }] }).success, false);

  // Coordinates are budgeted across the whole map, path and geojson included.
  // The budget depends on who wrote the geometry, so normalizeMap owns it.
  const path = Array.from({ length: 1000 }, () => [100, 40] as Coord);
  const oversized = { layers: Array.from({ length: 25 }, (_, i) => ({ name: `层${i}`, points: points(1000), path })) };
  assert.equal(MapInputSchema.safeParse(oversized).success, true, 'the schema still validates shape, not the map-wide budget');
  const rejected = errorOf(() => normalizeMap(oversized, undefined, 'agent'));
  assert.equal(rejected.statusCode, 400);
  const details = rejected.details as { code: string; limit: string; threshold: number; actual: number; breakdown: { stops: number; geojson: number; callerRoute: number } };
  assert.equal(details.code, 'COORDINATE_BUDGET');
  assert.equal(details.limit, 'coordsPerMap');
  assert.equal(details.threshold, LIMITS.coordsPerMap);
  assert.equal(details.actual, 50_000);
  assert.equal(details.breakdown.stops, 25_000);
  assert.equal(details.breakdown.callerRoute, 25_000);
  assert.match(rejected.message, /上限 20000/);
});

test('schema validates standard GeoJSON geometries and ring closure', () => {
  const geo = (geometry: unknown) =>
    MapInputSchema.safeParse({
      layers: [{ name: 'g', geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: null }] } }],
    });

  const ring: Coord[] = [[0, 0], [1, 0], [1, 1], [0, 0]];
  assert.equal(geo({ type: 'Point', coordinates: [126, 45] }).success, true);
  assert.equal(geo({ type: 'MultiPoint', coordinates: [[126, 45], [127, 46]] }).success, true);
  assert.equal(geo({ type: 'LineString', coordinates: [[126, 45], [127, 46]] }).success, true);
  assert.equal(geo({ type: 'MultiLineString', coordinates: [[[126, 45], [127, 46]]] }).success, true);
  assert.equal(geo({ type: 'Polygon', coordinates: [ring] }).success, true);
  assert.equal(geo({ type: 'MultiPolygon', coordinates: [[ring]] }).success, true);

  const open = geo({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
  assert.equal(open.success, false);
  assert.match(open.error!.issues[0].message, /闭合/);
  assert.equal(geo({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }).success, false, 'ring needs 4 positions');
  assert.equal(geo({ type: 'LineString', coordinates: [[126, 45]] }).success, false, 'LineString needs 2 positions');
  assert.equal(geo({ type: 'Circle', coordinates: [126, 45] }).success, false);
  assert.equal(geo({ type: 'Point', coordinates: [200, 45] }).success, false, 'geojson coords are range checked too');
  // properties defaults to null; a FeatureCollection wrapper is required.
  assert.equal(
    MapInputSchema.parse({
      layers: [{ name: 'g', geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }] } }],
    }).layers[0].geojson!.features[0].properties,
    null,
  );
  assert.equal(MapInputSchema.safeParse({ layers: [{ name: 'g', geojson: { type: 'Feature' } }] }).success, false);
});

test('EditOperationSchema accepts every op and rejects malformed ones', () => {
  const ops: EditOperation[] = [
    { op: 'insert', layerId: 'l', point: { name: 'p', at: [126, 45] }, after: 'p1' },
    { op: 'delete', layerId: 'l', pointId: 'p1' },
    { op: 'update', layerId: 'l', pointId: 'p1', patch: { name: 'x', at: [1, 2], day: 3, note: 'n', warn: true, img: '' } },
    { op: 'annotate', layerId: 'l', pointId: 'p1', text: '备注' },
    { op: 'reorder', layerId: 'l', pointId: 'p1', toIndex: 0 },
    { op: 'layer.add', layer: { name: '新层' } },
    { op: 'layer.update', layerId: 'l', patch: { name: 'x', visible: false } },
    { op: 'layer.delete', layerId: 'l' },
    { op: 'intent', text: '减少长途' },
    { op: 'intent.set', scope: 'map', text: '减少长途', priority: 'prefer' },
    { op: 'point.insert', layerId: 'l', point: { name: 'p', at: [126, 45] } },
    { op: 'points.reorder', layerId: 'l', pointIds: ['p1', 'p2'] },
    { op: 'route.leg.update', layerId: 'l', fromPointId: 'a', toPointId: 'b', patch: { durationMinutes: 90 } },
    { op: 'draft.commit', note: 'ok' },
  ];
  for (const op of ops) assert.equal(EditOperationSchema.safeParse(op).success, true, op.op);

  // An empty patch is a valid no-op; an unknown patch key is a rejected edit,
  // never a partially applied one.
  assert.equal(EditOperationSchema.safeParse({ op: 'update', layerId: 'l', pointId: 'p', patch: {} }).success, true);
  const unknownKey = EditOperationSchema.safeParse({ op: 'update', layerId: 'l', pointId: 'p', patch: { id: 'nope' } });
  assert.equal(unknownKey.success, false);
  assert.deepEqual(unknownKey.error!.issues[0].path, ['patch']);
  assert.match(unknownKey.error!.issues[0].message, /point\.update 的 patch 只支持/);
  const droppedPoints = EditOperationSchema.safeParse({ op: 'layer.update', layerId: 'l', patch: { name: 'x', points: [{ name: 'p', at: [1, 2] }] } });
  assert.equal(droppedPoints.success, false, 'layer.update.patch.points must not be silently ignored');
  assert.match(droppedPoints.error!.issues[0].message, /points\.reorder/);
  for (const bad of [
    { op: 'nope', layerId: 'l' },
    { op: 'insert', layerId: 'l', point: { at: [1, 2] } },
    { op: 'insert', layerId: 'l', point: { name: 'p', at: [1, 200] } },
    { op: 'insert', layerId: 'l', point: { name: 'p', at: [1, 2], category: 'hotel' } },
    { op: 'delete', pointId: 'p' },
    { op: 'delete', layerId: 'l', pointId: 'p', extra: 1 },
    { op: 'reorder', layerId: 'l', pointId: 'p', toIndex: -1 },
    { op: 'reorder', layerId: 'l', pointId: 'p', toIndex: 1.5 },
    { op: 'point.reorder', layerId: 'l', pointIds: ['p1'] },
    { op: 'points.reorder', layerId: 'l', pointIds: [] },
    { op: 'points.reorder', layerId: 'l', pointId: 'p', toIndex: 0 },
    { op: 'layer.update', layerId: 'l', patch: { color: 'red' } },
    { op: 'layer.add', layer: {} },
    { op: 'route.leg.update', layerId: 'l', fromPointId: 'a', toPointId: 'b', patch: { speedKph: 80 } },
  ]) {
    assert.equal(EditOperationSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  // The rejection names the field and the shape the caller should have sent.
  const mistaken = EditOperationSchema.safeParse({ op: 'point.reorder', layerId: 'l', pointIds: ['p1'] });
  assert.match(mistaken.error!.issues.map(issue => issue.message).join(' '), /points\.reorder \+ pointIds/);
});

// --- normalizeMap ---------------------------------------------------------

test('normalizeMap fills ids, colours, crs, visibility, and edited_by', () => {
  const snapshot = snapshotOf(twoPointRoute);
  const layer = snapshot.layers[0];
  assert.match(layer.id, /^l_[0-9a-f]{10}$/);
  assert.match(layer.points[0].id, /^p_[0-9a-f]{10}$/);
  assert.notEqual(layer.points[0].id, layer.points[1].id);
  assert.match(layer.color, /^#[0-9a-f]{6}$/);
  assert.equal(layer.crs, 'wgs84');
  assert.equal(layer.visible, true);
  assert.equal(layer.edited_by, 'agent');
  assert.equal(snapshot.title, '双点线');
  assert.equal(normalizeMap({ layers: [] }, undefined, 'agent').title, '未命名地图');
  // Distinct colours per layer.
  const many = snapshotOf({ layers: Array.from({ length: 6 }, (_, i) => ({ name: `层${i}` })) });
  assert.equal(new Set(many.layers.map((l) => l.color)).size, 6);
});

test('normalizeMap keeps ids stable by id first and name second', () => {
  const first = snapshotOf(DEMO_INPUT);
  const lesser = layerOf(first, '小兴安岭线：哈尔滨—黑河');
  const harbinId = pointOf(lesser, '哈尔滨');

  // Re-PUT without any ids: matched by name, ids must not churn.
  const stripped: MapInput = {
    title: first.title,
    layers: first.layers.map((layer) => ({ name: layer.name, kind: layer.kind, points: layer.points.map((p) => ({ name: p.name, at: p.at })) })),
  };
  const second = normalizeMap(MapInputSchema.parse(stripped), first, 'agent');
  assert.equal(second.layers[0].id, lesser.id, 'layer id preserved by name');
  assert.equal(pointOf(second.layers[0], '哈尔滨'), harbinId, 'point id preserved by name');

  // An explicit id wins over a same-named earlier layer.
  const byId = normalizeMap(
    MapInputSchema.parse({ layers: [{ name: '别的名字' }, { id: lesser.id, name: '小兴安岭线：哈尔滨—黑河' }] }),
    first,
    'agent',
  );
  assert.equal(byId.layers[1].id, lesser.id);
  assert.notEqual(byId.layers[0].id, lesser.id);

  // Two same-named input layers cannot both claim the same previous id.
  const twins = normalizeMap(MapInputSchema.parse({ layers: [{ name: '主线' }, { name: '主线' }] }), snapshotOf(twoPointRoute), 'agent');
  assert.notEqual(twins.layers[0].id, twins.layers[1].id);
});

test('normalizeMap converts gcj02 once and records inputCrs', () => {
  const gcjInput: MapInput = {
    layers: [{ name: '高德导出', crs: 'gcj02', kind: 'route', points: [{ name: '北京', at: [116.4062479, 39.9014349] }], path: [[116.4062479, 39.9014349], [116.4162479, 39.9114349]] }],
  };
  const first = snapshotOf(gcjInput);
  const layer = first.layers[0];
  assert.equal(layer.crs, 'wgs84');
  assert.equal(layer.inputCrs, 'gcj02');
  assert.ok(Math.abs(layer.points[0].at[0] - 116.4) < 1e-4, 'points converted');
  assert.ok(Math.abs(layer.path![0][0] - 116.4) < 1e-4, 'path converted too');

  // PUT the snapshot back: crs is already wgs84, so no second conversion.
  const again = normalizeMap(MapInputSchema.parse(toMapInput(first)), first, 'agent');
  assert.deepEqual(again.layers[0].points[0].at, layer.points[0].at);
  assert.deepEqual(again.layers[0].path, layer.path);
  assert.equal(again.layers[0].inputCrs, 'gcj02', 'provenance survives the round trip');

  // Even PUT-ing the raw snapshot object (extra fields and all) is idempotent.
  const raw = normalizeMap(MapInputSchema.parse(first), first, 'agent');
  assert.deepEqual(raw.layers[0].points[0].at, layer.points[0].at);
});

test('normalizeMap computes stats: provided path beats straight line, days never come from distance', () => {
  const straight = snapshotOf(twoPointRoute).layers[0];
  assert.equal(straight.stats.distanceKind, 'straight');
  assert.ok(Math.abs(straight.stats.distanceKm - haversineKm(HARBIN, YICHUN)) < 1e-3);
  assert.equal(straight.stats.pointCount, 2);
  assert.equal(straight.stats.days, 2, 'no day field: one day per node');

  // A path that detours must be longer than the direct line, and flagged.
  const withPath = snapshotOf({
    layers: [{ name: '带路网', kind: 'route', points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }], path: [HARBIN, [127.7, 47.5], YICHUN] }],
  }).layers[0];
  assert.equal(withPath.stats.distanceKind, 'provided');
  assert.ok(withPath.stats.distanceKm > straight.stats.distanceKm);
  // stats round to metres; the figure is the length of the supplied geometry.
  assert.ok(Math.abs(withPath.stats.distanceKm - routeDistance(withPath.path!)) < 1e-3);

  // Explicit days win over the node estimate, in both directions.
  const dayed = snapshotOf({
    layers: [{ name: '多日', kind: 'route', points: [{ name: 'a', at: HARBIN, day: 1 }, { name: 'b', at: YICHUN, day: 4 }] }],
  }).layers[0];
  assert.equal(dayed.stats.days, 4);
  const compressed = snapshotOf({
    layers: [{ name: '两点一日', kind: 'route', points: [{ name: 'a', at: HARBIN, day: 1 }, { name: 'b', at: YICHUN, day: 1 }] }],
  }).layers[0];
  assert.equal(compressed.stats.days, 1, 'day fields may compress the trip below the node count');

  // Long distance must not inflate days: a 1000 km hop with day:1 stays 1 day.
  const far = snapshotOf({
    layers: [{ name: '远', kind: 'route', points: [{ name: 'a', at: [116.4, 39.9], day: 1 }, { name: 'b', at: HARBIN, day: 1 }] }],
  }).layers[0];
  assert.ok(far.stats.distanceKm > 1000);
  assert.equal(far.stats.days, 1);

  // Non-itineraries and empty layers claim no mileage and no duration.
  const spots = snapshotOf({ layers: [{ name: '候选', kind: 'spots', points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }] }] }).layers[0];
  assert.equal(spots.stats.distanceKm, 0);
  assert.equal(spots.stats.days, 0);
  const empty = snapshotOf({ layers: [{ name: '空' }] }).layers[0];
  assert.deepEqual(empty.stats, { distanceKm: 0, straightDistanceKm: 0, days: 0, distanceKind: 'straight', pointCount: 0 });
});

test('normalizeMap scopes point ids per layer and rejects duplicates within one', () => {
  // Two routes both calling their stop 'harbin' is legitimate input.
  const shared = normalizeMap(
    MapInputSchema.parse({
      layers: [
        { id: 'lesser', name: '小兴安岭线', kind: 'route', points: [{ id: 'harbin', name: '哈尔滨', at: HARBIN }, { id: 'yichun', name: '伊春', at: YICHUN }] },
        { id: 'greater', name: '大兴安岭线', kind: 'route', points: [{ id: 'harbin', name: '哈尔滨', at: HARBIN }, { id: 'heihe', name: '黑河', at: HEIHE }] },
      ],
    }),
    undefined,
    'agent',
  );
  assert.deepEqual(shared.layers.map((l) => l.points[0].id), ['harbin', 'harbin'], 'both keep the id they asked for');
  assert.deepEqual(shared.layers.map((l) => l.id), ['lesser', 'greater']);

  // A point id may also match a layer id — separate namespaces.
  const overlap = normalizeMap(
    MapInputSchema.parse({ layers: [{ id: 'x', name: 'l', points: [{ id: 'x', name: 'p', at: HARBIN }] }] }),
    undefined,
    'agent',
  );
  assert.equal(overlap.layers[0].id, 'x');
  assert.equal(overlap.layers[0].points[0].id, 'x');

  // Within one layer a repeat is still ambiguous.
  const dup = errorOf(() =>
    normalizeMap(
      { layers: [{ name: 'l', points: [{ id: 'p', name: 'a', at: HARBIN }, { id: 'p', name: 'b', at: YICHUN }] }] },
      undefined,
      'agent',
    ),
  );
  assert.equal(dup.statusCode, 400);
  assert.match(dup.message, /图层「l」内重复的点 id/);

  // Layer ids stay unique across the map.
  const dupLayer = errorOf(() => normalizeMap({ layers: [{ id: 'same', name: 'a' }, { id: 'same', name: 'b' }] }, undefined, 'agent'));
  assert.equal(dupLayer.statusCode, 400);
  assert.match(dupLayer.message, /重复的图层 id/);

  // Re-PUT is a fixed point even with ids shared across layers.
  const snapshot: MapSnapshot = { ...snapshotOf({ layers: [] }), layers: shared.layers, title: shared.title };
  const again = normalizeMap(MapInputSchema.parse(toMapInput(snapshot)), snapshot, 'agent');
  assert.equal(JSON.stringify(again.layers), JSON.stringify(shared.layers));
});

test('normalizeMap does not mutate its input and rejects duplicate explicit ids', () => {
  const input = structuredClone(DEMO_INPUT);
  const frozenInput = JSON.stringify(input);
  const previous = snapshotOf(DEMO_INPUT);
  const frozenPrevious = JSON.stringify(previous);
  normalizeMap(input, previous, 'user');
  assert.equal(JSON.stringify(input), frozenInput, 'input payload untouched');
  assert.equal(JSON.stringify(previous), frozenPrevious, 'previous snapshot untouched');

  const duplicate = errorOf(() => normalizeMap({ layers: [{ id: 'same', name: 'a' }, { id: 'same', name: 'b' }] }, undefined, 'agent'));
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.message, /重复的图层 id/);
});

test('normalizeMap keeps edited_by for untouched layers', () => {
  const agentMap = snapshotOf(DEMO_INPUT, 'agent');
  const unchanged = normalizeMap(MapInputSchema.parse(toMapInput(agentMap)), agentMap, 'user');
  assert.ok(unchanged.layers.every((layer) => layer.edited_by === 'agent'), 're-PUT of identical content keeps the author');

  const input = toMapInput(agentMap);
  input.layers[0].points![0].name = '哈尔滨（改）';
  const edited = normalizeMap(MapInputSchema.parse(input), agentMap, 'user');
  assert.equal(edited.layers[0].edited_by, 'user', 'the changed layer flips to the new actor');
  assert.equal(edited.layers[1].edited_by, 'agent', 'siblings are untouched');
});

// --- applyOperations -----------------------------------------------------

test('normalizeMap validates its own input and reports ZodError as DomainError(400)', () => {
  // Callers that skip the schema still get the same guarantees.
  const badCoord = errorOf(() => normalizeMap({ layers: [{ name: 'l', points: [{ name: 'p', at: [999, 0] }] }] }, undefined, 'agent'));
  assert.equal(badCoord.statusCode, 400);
  assert.match(badCoord.message, /经度必须在 -180 到 180 之间/);
  assert.match(badCoord.message, /layers\[0\]\.points\[0\]\.at\[0\]/, 'the message locates the offending value');
  assert.ok(badCoord.hint);
  const details = badCoord.details as { issues: { path: string; message: string }[] };
  assert.equal(details.issues[0].path, 'layers[0].points[0].at[0]');

  for (const bad of [
    { layers: [{ name: 'l', points: [{ name: 'p', at: [0, 91] }] }] },
    { layers: [{ name: '' }] },
    { layers: [{ name: 'l', color: 'red' }] },
    { layers: [{ name: 'l', crs: 'bd09' }] },
    { layers: Array.from({ length: LIMITS.layers + 1 }, (_, i) => ({ name: `层${i}` })) },
    { layers: [{ name: 'l', points: [{ id: 'p', name: 'a', at: [0, 0] }, { id: 'p', name: 'b', at: [1, 1] }] }] },
  ] as MapInput[]) {
    assert.equal(errorOf(() => normalizeMap(bad, undefined, 'agent')).statusCode, 400, JSON.stringify(bad));
  }

  // Multiple issues are counted, not hidden.
  const many = errorOf(() => normalizeMap({ layers: [{ name: 'l', points: [{ name: 'a', at: [999, 0] }, { name: 'b', at: [0, 999] }] }] }, undefined, 'agent'));
  assert.match(many.message, /另有 1 处问题/);
  assert.equal((many.details as { issues: unknown[] }).issues.length, 2);

  // Valid input is unaffected, and pre-parsed input stays a fixed point.
  const once = normalizeMap(twoPointRoute, undefined, 'agent');
  const twice = normalizeMap(MapInputSchema.parse(twoPointRoute), undefined, 'agent');
  assert.equal(once.layers[0].name, twice.layers[0].name);
  assert.deepEqual(once.layers[0].points.map((p) => p.at), twice.layers[0].points.map((p) => p.at));
});

test('applyOperations validates the incoming batch', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const heihe = pointOf(layer, '黑河');

  // An out-of-range coordinate from the offline editor is still rejected.
  const offline = errorOf(() => applyOperations(snapshot, [{ op: 'update', layerId: layer.id, pointId: heihe, patch: { at: [126.5, 95] } }]));
  assert.equal(offline.statusCode, 400);
  assert.match(offline.message, /纬度必须在 -90 到 90 之间/);

  for (const bad of [
    { op: 'insert', layerId: layer.id, point: { name: 'p', at: [181, 0] } },
    { op: 'insert', layerId: layer.id, point: { name: '', at: [126, 45] } },
    { op: 'reorder', layerId: layer.id, pointId: heihe, toIndex: -1 },
    { op: 'layer.update', layerId: layer.id, patch: { color: 'chartreuse' } },
    { op: 'nope', layerId: layer.id },
  ] as unknown as EditOperation[]) {
    const error = errorOf(() => applyOperations(snapshot, [bad]));
    assert.equal(error.statusCode, 400, JSON.stringify(bad));
    assert.match(error.message, /编辑操作校验失败/);
  }

  // Too many operations at once is refused rather than half-applied.
  const flood = Array.from({ length: LIMITS.operations + 1 }, () => ({ op: 'annotate' as const, layerId: layer.id, pointId: heihe, text: 'x' }));
  assert.equal(errorOf(() => applyOperations(snapshot, flood)).statusCode, 400);
  // And nothing was mutated by any rejected batch.
  assert.equal(layerOf(snapshot, '小兴安岭线：哈尔滨—黑河').points.length, 4);
});

test('applyOperations re-checks whole-map budgets after the batch', () => {
  // Each layer.add is individually fine; together they exceed the layer cap.
  const nearCap = snapshotOf({ layers: Array.from({ length: LIMITS.layers - 1 }, (_, i) => ({ name: `层${i}` })) });
  const oneMore = applyOperations(nearCap, [{ op: 'layer.add', layer: { name: '刚好' } }]);
  assert.equal(oneMore.layers.length, LIMITS.layers, 'exactly at the cap still succeeds');

  const overflow = errorOf(() =>
    applyOperations(nearCap, [{ op: 'layer.add', layer: { name: '第 50 层' } }, { op: 'layer.add', layer: { name: '第 51 层' } }]),
  );
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.message, /编辑后的地图校验失败/);
  assert.match(overflow.message, new RegExp(`最多 ${LIMITS.layers} 个图层`));

  // Same for points in one layer: repeated inserts cannot walk past the limit.
  const fullLayer = snapshotOf({
    layers: [{ name: '满层', kind: 'route', points: Array.from({ length: LIMITS.pointsPerLayer - 1 }, (_, i) => ({ name: `点${i}`, at: [126, 45] as Coord })) }],
  });
  const layerId = fullLayer.layers[0].id;
  assert.equal(applyOperations(fullLayer, [{ op: 'insert', layerId, point: { name: '最后一个', at: [126, 45] } }]).layers[0].points.length, LIMITS.pointsPerLayer);
  const tooMany = errorOf(() =>
    applyOperations(fullLayer, [
      { op: 'insert', layerId, point: { name: '第 1000 个', at: [126, 45] } },
      { op: 'insert', layerId, point: { name: '第 1001 个', at: [126, 45] } },
    ]),
  );
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.message, /编辑后的地图校验失败/);

  // The rejected batch leaves the snapshot untouched.
  assert.equal(fullLayer.layers[0].points.length, LIMITS.pointsPerLayer - 1);
  assert.equal(nearCap.layers.length, LIMITS.layers - 1);
});

test('applyOperations describes inserts, deletes, reorders, and notes in Chinese', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const heihe = pointOf(layer, '黑河');
  const yichun = pointOf(layer, '伊春');

  const inserted = applyOperations(snapshot, [
    { op: 'insert', layerId: layer.id, point: { name: '嘉荫', at: [130.4, 48.89] }, after: yichun },
  ]);
  assert.deepEqual(inserted.changes.slice(0, 1), ['在「伊春」之后插入了「嘉荫」']);
  assert.deepEqual(inserted.layers[0].points.map((p) => p.name), ['哈尔滨', '伊春', '嘉荫', '五大连池', '黑河']);
  const mintedInsert = inserted.operations[0];
  assert.equal(mintedInsert.op, 'insert');
  assert.ok(mintedInsert.op === 'insert' && mintedInsert.point.id);
  assert.equal(mintedInsert.op === 'insert' && mintedInsert.point.id, inserted.layers[0].points[2].id);

  const appended = applyOperations(snapshot, [{ op: 'insert', layerId: layer.id, point: { name: '同江', at: [132.5, 47.65] } }]);
  assert.equal(appended.layers[0].points.at(-1)!.name, '同江');
  assert.match(appended.changes[0], /^在「小兴安岭线：哈尔滨—黑河」末尾添加了「同江」$/);

  const deleted = applyOperations(snapshot, [{ op: 'delete', layerId: layer.id, pointId: heihe }]);
  assert.equal(deleted.changes[0], '删除了「黑河」');
  assert.equal(deleted.layers[0].points.length, 3);

  const moved = applyOperations(snapshot, [{ op: 'reorder', layerId: layer.id, pointId: heihe, toIndex: 1 }]);
  // 黑河 carries day 5, so the line says which day's itinerary it landed in as
  // well as the position — that is what a cross-day drag needs to read back.
  assert.equal(moved.changes[0], '将「黑河」移到第 5 天第 2 站');
  assert.deepEqual(moved.layers[0].points.map((p) => p.name), ['哈尔滨', '黑河', '伊春', '五大连池']);

  // A stop with no day keeps the shorter wording: there is no day to name.
  const undatedLayer = applyOperations(snapshot, [{ op: 'update', layerId: layer.id, pointId: heihe, patch: { day: null } }]);
  const undatedMove = applyOperations({ ...snapshot, layers: undatedLayer.layers }, [{ op: 'reorder', layerId: layer.id, pointId: heihe, toIndex: 1 }]);
  assert.equal(undatedMove.changes[0], '将「黑河」移至第 2 站');

  const spots = layerOf(snapshot, '候选景点');
  const sunIsland = pointOf(spots, '太阳岛');
  const annotated = applyOperations(snapshot, [{ op: 'annotate', layerId: spots.id, pointId: sunIsland, text: '冬季有雪雕，夏季可骑行' }]);
  assert.equal(annotated.changes[0], '为「太阳岛」添加备注：冬季有雪雕，夏季可骑行');

  // Overwriting and clearing an existing note read differently.
  const withNote = advance(snapshot, annotated);
  assert.equal(
    applyOperations(withNote, [{ op: 'annotate', layerId: spots.id, pointId: sunIsland, text: '改成别的' }]).changes[0],
    '更新了「太阳岛」的备注：改成别的',
  );
  const cleared = applyOperations(withNote, [{ op: 'annotate', layerId: spots.id, pointId: sunIsland, text: '' }]);
  assert.equal(cleared.changes[0], '移除了「太阳岛」的备注');
  assert.equal('note' in cleared.layers.find((l) => l.id === spots.id)!.points.find((p) => p.id === sunIsland)!, false);

  // A long note is truncated in the log but stored in full.
  const long = '这是一段很长的备注'.repeat(6);
  const truncated = applyOperations(snapshot, [{ op: 'annotate', layerId: spots.id, pointId: sunIsland, text: long }]);
  assert.match(truncated.changes[0], /…$/);
  assert.equal(truncated.layers.find((l) => l.id === spots.id)!.points.find((p) => p.id === sunIsland)!.note, long);
});

test('applyOperations covers update, layer.add, layer.update, layer.delete', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const yichun = pointOf(layer, '伊春');

  const updated = applyOperations(snapshot, [
    { op: 'update', layerId: layer.id, pointId: yichun, patch: { name: '伊春（新）', day: 3, warn: true, note: '' } },
  ]);
  assert.match(updated.changes[0], /^更新了「伊春」：改名为「伊春（新）」、安排在第 3 天、备注已移除、已加上提醒标记$/);
  const point = updated.layers[0].points[1];
  assert.equal(point.name, '伊春（新）');
  assert.equal(point.day, 3);
  assert.equal(point.warn, true);
  assert.equal('note' in point, false, 'empty patch value removes the field');

  const added = applyOperations(snapshot, [
    { op: 'layer.add', layer: { name: '铁路段', kind: 'route', points: [{ name: '哈尔滨西', at: [126.5, 45.72] }, { name: '齐齐哈尔', at: [123.96, 47.35] }] } },
  ]);
  assert.equal(added.changes[0], '新增图层「铁路段」');
  const newLayer = added.layers.at(-1)!;
  const mintedLayer = added.operations[0];
  assert.equal(mintedLayer.op, 'layer.add');
  assert.equal(mintedLayer.op === 'layer.add' && mintedLayer.layer.id, newLayer.id);
  assert.equal(mintedLayer.op === 'layer.add' && mintedLayer.layer.points?.[0]?.id, newLayer.points[0].id);
  assert.equal(mintedLayer.op === 'layer.add' && mintedLayer.layer.points?.[1]?.id, newLayer.points[1].id);
  assert.equal(newLayer.edited_by, 'user');
  assert.equal(newLayer.crs, 'wgs84');
  assert.equal(newLayer.stats.pointCount, 2);
  assert.ok(newLayer.stats.distanceKm > 0);
  assert.ok(!added.layers.slice(0, -1).some((l) => l.color === newLayer.color), 'auto colour avoids existing layers');

  const renamed = applyOperations(snapshot, [{ op: 'layer.update', layerId: layer.id, patch: { name: '东线', visible: false, color: '#123456' } }]);
  assert.equal(renamed.changes[0], '图层「小兴安岭线：哈尔滨—黑河」：改名为「东线」、颜色改为 #123456、已隐藏');
  assert.equal(renamed.layers[0].visible, false);

  const removed = applyOperations(snapshot, [{ op: 'layer.delete', layerId: layer.id }]);
  assert.equal(removed.changes[0], '删除了图层「小兴安岭线：哈尔滨—黑河」');
  assert.equal(removed.layers.length, snapshot.layers.length - 1);
});

test('applyOperations never mutates the snapshot it was given', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const frozen = JSON.stringify(snapshot);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');

  const result = applyOperations(snapshot, [
    { op: 'delete', layerId: layer.id, pointId: pointOf(layer, '伊春') },
    { op: 'insert', layerId: layer.id, point: { name: '新点', at: [127, 47] } },
    { op: 'layer.update', layerId: layer.id, patch: { note: '改过了' } },
  ]);
  assert.equal(JSON.stringify(snapshot), frozen, 'snapshot deep-unchanged');
  assert.notEqual(JSON.stringify(result.layers), JSON.stringify(snapshot.layers));
  // Deep structures are copies, not aliases.
  result.layers[0].points[0].at[0] = 0;
  assert.notEqual(snapshot.layers[0].points[0].at[0], 0);
});

test('applyOperations is atomic: a failing op discards the whole batch', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const frozen = JSON.stringify(snapshot);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');

  const failed = errorOf(() =>
    applyOperations(snapshot, [
      { op: 'insert', layerId: layer.id, point: { name: '会被丢弃', at: [127, 47] } },
      { op: 'delete', layerId: layer.id, pointId: 'p_does_not_exist' },
    ]),
  );
  assert.equal(failed.statusCode, 404);
  assert.equal(JSON.stringify(snapshot), frozen);

  // Later ops observe earlier ones within one successful batch.
  const chained = applyOperations(snapshot, [
    { op: 'insert', layerId: layer.id, point: { id: 'p_new', name: '新站', at: [127, 47] } },
    { op: 'reorder', layerId: layer.id, pointId: 'p_new', toIndex: 0 },
    { op: 'annotate', layerId: layer.id, pointId: 'p_new', text: '临时加的' },
  ]);
  assert.equal(chained.layers[0].points[0].name, '新站');
  assert.equal(chained.layers[0].points[0].note, '临时加的');
});

test('applyOperations maps failures to 404 and 400 with hints', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const heihe = pointOf(layer, '黑河');

  const noLayer = errorOf(() => applyOperations(snapshot, [{ op: 'delete', layerId: 'nope', pointId: heihe }]));
  assert.equal(noLayer.statusCode, 404);
  assert.ok(noLayer.hint);
  assert.deepEqual(noLayer.details, { layerId: 'nope' });

  const noPoint = errorOf(() => applyOperations(snapshot, [{ op: 'update', layerId: layer.id, pointId: 'nope', patch: { day: 1 } }]));
  assert.equal(noPoint.statusCode, 404);

  const noAnchor = errorOf(() =>
    applyOperations(snapshot, [{ op: 'insert', layerId: layer.id, point: { name: 'x', at: [1, 2] }, after: 'nope' }]),
  );
  assert.equal(noAnchor.statusCode, 404);

  for (const toIndex of [layer.points.length, 99]) {
    const oob = errorOf(() => applyOperations(snapshot, [{ op: 'reorder', layerId: layer.id, pointId: heihe, toIndex }]));
    assert.equal(oob.statusCode, 400);
    assert.match(oob.message, /越界/);
  }

  const clash = errorOf(() => applyOperations(snapshot, [{ op: 'insert', layerId: layer.id, point: { id: heihe, name: '撞车', at: [1, 2] } }]));
  assert.equal(clash.statusCode, 400);
  assert.match(clash.message, /已被占用/);

  // ...but the same id in a *different* layer is not a collision at all.
  const spots = layerOf(snapshot, '候选景点');
  const reused = applyOperations(snapshot, [{ op: 'insert', layerId: spots.id, point: { id: heihe, name: '黑河（候选）', at: [127.49, 50.24] } }]);
  assert.equal(reused.layers.find((l) => l.id === spots.id)!.points.at(-1)!.id, heihe);
  assert.equal(reused.layers.find((l) => l.id === layer.id)!.points.some((p) => p.id === heihe), true, 'both layers keep it');
  // And each is addressable through its own layerId.
  const both = advance(snapshot, reused);
  const renamed = applyOperations(both, [{ op: 'update', layerId: spots.id, pointId: heihe, patch: { name: '只改候选层' } }]);
  assert.equal(renamed.layers.find((l) => l.id === spots.id)!.points.at(-1)!.name, '只改候选层');
  assert.equal(renamed.layers.find((l) => l.id === layer.id)!.points.find((p) => p.id === heihe)!.name, '黑河');

  const blankName = errorOf(() => applyOperations(snapshot, [{ op: 'update', layerId: layer.id, pointId: heihe, patch: { name: '   ' } }]));
  assert.equal(blankName.statusCode, 400);

  const badCoord = errorOf(() =>
    applyOperations(snapshot, [{ op: 'update', layerId: layer.id, pointId: heihe, patch: { at: [Number.NaN, 1] } }]),
  );
  assert.equal(badCoord.statusCode, 400);
  assert.ok(badCoord instanceof Error && badCoord.name === 'DomainError');
});

test('applyOperations drops caller path when nodes move, and recomputes stats', () => {
  const base = snapshotOf({
    layers: [
      {
        name: '有路网的线',
        kind: 'route',
        points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }, { name: 'c', at: HEIHE }],
        path: [HARBIN, [127.7, 47.5], YICHUN, [128.0, 49.0], HEIHE],
      },
    ],
  });
  const layer = base.layers[0];
  assert.equal(layer.stats.distanceKind, 'provided');
  const providedKm = layer.stats.distanceKm;

  // Reordering invalidates the geometry.
  const reordered = applyOperations(base, [{ op: 'reorder', layerId: layer.id, pointId: pointOf(layer, 'c'), toIndex: 0 }]);
  assert.equal('path' in reordered.layers[0], false);
  assert.equal(reordered.layers[0].stats.distanceKind, 'straight');
  assert.ok(reordered.changes.some((line) => /节点已变化.*清除.*道路几何.*直线估算/.test(line)));
  assert.ok(reordered.changes.some((line) => line.includes('里程由') && line.includes('直线估算')));

  // So does dragging a node, deleting one, or inserting one.
  for (const op of [
    { op: 'update', layerId: layer.id, pointId: pointOf(layer, 'b'), patch: { at: [128.9, 47.8] } },
    { op: 'delete', layerId: layer.id, pointId: pointOf(layer, 'b') },
    { op: 'insert', layerId: layer.id, point: { name: 'd', at: [127, 47] } },
  ] as EditOperation[]) {
    const result = applyOperations(base, [op]);
    assert.equal('path' in result.layers[0], false, op.op);
    assert.equal(result.layers[0].stats.distanceKind, 'straight');
  }

  // A non-geometric edit keeps the supplied geometry and its mileage.
  const annotated = applyOperations(base, [{ op: 'annotate', layerId: layer.id, pointId: pointOf(layer, 'b'), text: '中途休息' }]);
  assert.deepEqual(annotated.layers[0].path, layer.path);
  assert.equal(annotated.layers[0].stats.distanceKind, 'provided');
  assert.equal(annotated.layers[0].stats.distanceKm, providedKm);
  assert.ok(!annotated.changes.some((line) => line.includes('里程由')), 'unchanged mileage is not reported');
});

test('applyOperations recomputes stats and reports mileage as an estimate', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const before = layer.stats.distanceKm;

  const shortened = applyOperations(snapshot, [{ op: 'delete', layerId: layer.id, pointId: pointOf(layer, '五大连池') }]);
  const after = shortened.layers[0].stats;
  assert.equal(after.pointCount, 3);
  assert.equal(after.days, 5, 'days still come from point.day, not from the shorter distance');
  assert.ok(after.distanceKm < before);
  const mileage = shortened.changes.find((line) => line.includes('里程由'));
  assert.ok(mileage, 'a mileage change is explained');
  assert.match(mileage!, /直线估算/, 'and labelled as an estimate, not driving distance');
  assert.ok(!/小时|分钟|驾车/.test(mileage!), 'never phrased as travel time');

  // Deleting all points leaves an honest empty layer.
  const emptied = applyOperations(snapshot, layer.points.map((p) => ({ op: 'delete' as const, layerId: layer.id, pointId: p.id })));
  assert.deepEqual(emptied.layers[0].stats, { distanceKm: 0, straightDistanceKm: 0, days: 0, distanceKind: 'straight', pointCount: 0 });
});

test('applyOperations returns no changes when nothing actually changed', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const harbin = layer.points[0];

  assert.deepEqual(applyOperations(snapshot, []).changes, []);
  const noop = applyOperations(snapshot, [
    { op: 'update', layerId: layer.id, pointId: harbin.id, patch: { name: harbin.name, at: harbin.at, note: harbin.note, day: harbin.day } },
    { op: 'annotate', layerId: layer.id, pointId: harbin.id, text: harbin.note! },
    { op: 'reorder', layerId: layer.id, pointId: harbin.id, toIndex: 0 },
    { op: 'layer.update', layerId: layer.id, patch: { name: layer.name, visible: layer.visible, color: layer.color } },
  ]);
  assert.deepEqual(noop.changes, []);
  assert.equal(JSON.stringify(noop.layers), JSON.stringify(snapshot.layers), 'and the map is byte-identical');
  assert.ok(noop.layers.every((l) => l.edited_by === 'agent'), 'a no-op does not reassign authorship');
});

test('applyOperations marks changed layers edited_by user and leaves others alone', () => {
  const snapshot = snapshotOf(DEMO_INPUT, 'agent');
  const layer = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const result = applyOperations(snapshot, [{ op: 'delete', layerId: layer.id, pointId: pointOf(layer, '伊春') }]);
  assert.equal(result.layers[0].edited_by, 'user');
  assert.ok(result.layers.slice(1).every((l) => l.edited_by === 'agent'));
  assert.equal(result.title, snapshot.title, 'title is carried through unchanged');
});

test('applyOperations handles layer.add with gcj02 input and same-batch edits', () => {
  const base = snapshotOf({ layers: [{ name: '底图层' }] });
  const added = applyOperations(base, [
    {
      op: 'layer.add',
      layer: {
        id: 'gd',
        name: '高德导出',
        crs: 'gcj02',
        kind: 'route',
        points: [{ id: 'gd1', name: '北京', at: [116.4062479, 39.9014349] }, { id: 'gd2', name: '天津', at: [117.2172, 39.1339] }],
        path: [[116.4062479, 39.9014349], [116.9, 39.5], [117.2172, 39.1339]],
      },
    },
  ]);
  const layer = added.layers.find((l) => l.id === 'gd')!;
  assert.equal(layer.crs, 'wgs84');
  assert.equal(layer.inputCrs, 'gcj02');
  assert.ok(Math.abs(layer.points[0].at[0] - 116.4) < 1e-4, 'points converted on add');
  assert.ok(Math.abs(layer.path![0][0] - 116.4) < 1e-4, 'path converted on add');
  assert.equal(layer.stats.distanceKind, 'provided', 'an untouched supplied path survives the batch');
  assert.deepEqual(added.changes, ['新增图层「高德导出」'], 'a brand-new layer reports no mileage delta');

  // A layer added and then edited in the same batch loses its stale geometry.
  const edited = applyOperations(base, [
    {
      op: 'layer.add',
      layer: { id: 'nl', name: '带路网', kind: 'route', points: [{ id: 'n1', name: 'a', at: HARBIN }, { id: 'n2', name: 'b', at: YICHUN }], path: [HARBIN, [127.7, 47.5], YICHUN] },
    },
    { op: 'update', layerId: 'nl', pointId: 'n2', patch: { at: HEIHE } },
  ]);
  const moved = edited.layers.find((l) => l.id === 'nl')!;
  assert.equal('path' in moved, false);
  assert.equal(moved.stats.distanceKind, 'straight');
  assert.ok(edited.changes.some((line) => line.includes('清除')));
});

test('applyOperations explains a kind change instead of announcing 0 km', () => {
  const route = snapshotOf({ layers: [{ name: '线', kind: 'route', points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }] }] });
  const toSpots = applyOperations(route, [{ op: 'layer.update', layerId: route.layers[0].id, patch: { kind: 'spots' } }]);
  assert.equal(toSpots.layers[0].stats.distanceKm, 0);
  const line = toSpots.changes.find((c) => c.includes('里程'))!;
  assert.match(line, /不再作为路线统计里程/);
  assert.ok(!line.includes('变为 0 公里'), 'a set of candidates has no route, rather than a zero-length one');

  const spots = snapshotOf({ layers: [{ name: '候选', kind: 'spots', points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }] }] });
  const toRoute = applyOperations(spots, [{ op: 'layer.update', layerId: spots.layers[0].id, patch: { kind: 'route' } }]);
  assert.match(toRoute.changes.find((c) => c.includes('里程'))!, /开始按路线统计里程：约 \d+ 公里（直线估算）/);

  // Deleting a layer must not leave a mileage line about a layer that is gone.
  const deleted = applyOperations(route, [{ op: 'layer.delete', layerId: route.layers[0].id }]);
  assert.deepEqual(deleted.changes, ['删除了图层「线」']);
});

test('normalizeMap defaults kind to route, geojson only without points', () => {
  const ring: Coord[] = [[126, 45], [127, 45], [127, 46], [126, 45]];
  const geojson = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: null, geometry: { type: 'Polygon' as const, coordinates: [ring] } }] };
  const snapshot = snapshotOf({
    layers: [
      { name: '边界', geojson },
      { name: '空层' },
      { name: '单点', points: [{ name: 'a', at: HARBIN }] },
      { name: '两点', points: [{ name: 'a', at: HARBIN }, { name: 'b', at: YICHUN }] },
      // Points plus overlay data is still an itinerary.
      { name: '点加边界', points: [{ name: 'a', at: HARBIN }], geojson },
      { name: '显式候选', kind: 'spots', points: [{ name: 'a', at: HARBIN }] },
    ],
  });
  assert.deepEqual(snapshot.layers.map((l) => l.kind), ['geojson', 'route', 'route', 'route', 'route', 'spots']);

  // A one-point route reports its single node, no distance to speak of yet.
  const single = snapshot.layers[2];
  assert.deepEqual(single.stats, { distanceKm: 0, straightDistanceKm: 0, days: 1, distanceKind: 'straight', pointCount: 1 });
  // So appending a second stop does not change what the layer means.
  const grown = applyOperations(snapshot, [{ op: 'insert', layerId: single.id, point: { name: 'b', at: YICHUN } }]);
  assert.equal(grown.layers[2].kind, 'route');
  assert.ok(grown.layers[2].stats.distanceKm > 200);

  assert.deepEqual(snapshot.layers[0].stats, { distanceKm: 0, straightDistanceKm: 0, days: 0, distanceKind: 'straight', pointCount: 0 });

  const again = normalizeMap(MapInputSchema.parse(toMapInput(snapshot)), snapshot, 'agent');
  assert.deepEqual(again.layers[0].geojson, snapshot.layers[0].geojson, 'geojson survives export and re-import');
  assert.deepEqual(again.layers.map((l) => l.kind), snapshot.layers.map((l) => l.kind), 'an explicit kind is not re-inferred');
});

test('DomainError carries an HTTP status and optional hint/details', () => {
  const bare = new DomainError(409, '版本冲突');
  assert.equal(bare.statusCode, 409);
  assert.equal(bare.message, '版本冲突');
  assert.equal(bare.hint, undefined);
  assert.equal(bare.details, undefined);
  assert.ok(bare instanceof Error && bare instanceof DomainError);
  assert.equal(bare.name, 'DomainError');

  const full = new DomainError(400, '坐标超范围', '经度需在 -180 到 180 之间', { at: [999, 0] });
  assert.equal(full.hint, '经度需在 -180 到 180 之间');
  assert.deepEqual(full.details, { at: [999, 0] });
});

// --- toMapInput ----------------------------------------------------------

test('toMapInput strips derived fields, keeps ids and wgs84, and round-trips', () => {
  const snapshot = snapshotOf(DEMO_INPUT);
  const input = toMapInput(snapshot);
  assert.equal(input.title, snapshot.title);
  assert.equal(input.layers.length, snapshot.layers.length);

  input.layers.forEach((layer, index) => {
    const source = snapshot.layers[index];
    const asRecord = layer as unknown as Record<string, unknown>;
    assert.equal('stats' in asRecord, false);
    assert.equal('edited_by' in asRecord, false);
    assert.equal('inputCrs' in asRecord, false);
    assert.equal(layer.id, source.id);
    assert.equal(layer.crs, 'wgs84');
    assert.deepEqual(layer.points!.map((p) => p.id), source.points.map((p) => p.id));
    assert.deepEqual(layer.points!.map((p) => p.at), source.points.map((p) => p.at));
  });

  // Feeding it back through validation + normalisation is a fixed point.
  const again = normalizeMap(MapInputSchema.parse(input), snapshot, 'agent');
  assert.equal(JSON.stringify(again.layers), JSON.stringify(snapshot.layers));

  // The returned payload is a copy: mutating it cannot reach the snapshot.
  input.layers[0].points![0].at[0] = 0;
  input.layers[0].name = 'mutated';
  assert.notEqual(snapshot.layers[0].points[0].at[0], 0);
  assert.notEqual(snapshot.layers[0].name, 'mutated');
});

// --- demo & example -------------------------------------------------------

test('DEMO_INPUT validates and yields sensible, honest stats', () => {
  const parsed = MapInputSchema.safeParse(DEMO_INPUT);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error!.issues));
  const snapshot = snapshotOf(DEMO_INPUT);
  assert.equal(snapshot.layers.length, 3);

  const lesser = layerOf(snapshot, '小兴安岭线：哈尔滨—黑河');
  const greater = layerOf(snapshot, '大兴安岭线：加格达奇—漠河');
  const spots = layerOf(snapshot, '候选景点');
  assert.notEqual(lesser.color, greater.color);
  assert.notEqual(lesser.color, spots.color);
  assert.equal(spots.visible, false, 'candidates start hidden');

  for (const layer of [lesser, greater]) {
    assert.equal(layer.kind, 'route');
    assert.equal(layer.stats.distanceKind, 'straight', 'demo supplies no road geometry');
    assert.equal('path' in layer, false);
    assert.match(layer.from!, /不是真实驾车规划/);
    assert.equal(layer.stats.days, 5, 'days come from point.day');
  }
  // Straight-line totals for these itineraries land in the hundreds of km.
  assert.ok(lesser.stats.distanceKm > 600 && lesser.stats.distanceKm < 800, `${lesser.stats.distanceKm}`);
  assert.ok(greater.stats.distanceKm > 350 && greater.stats.distanceKm < 550, `${greater.stats.distanceKm}`);
  assert.equal(spots.stats.distanceKm, 0, 'a spots layer claims no mileage');

  // Every coordinate is plausibly in northeast China, and names are unique.
  const all = snapshot.layers.flatMap((layer) => layer.points);
  for (const point of all) {
    assert.ok(point.at[0] > 118 && point.at[0] < 136, `${point.name} lon ${point.at[0]}`);
    assert.ok(point.at[1] > 43 && point.at[1] < 55, `${point.name} lat ${point.at[1]}`);
  }
  assert.equal(new Set(all.map((p) => p.name)).size, all.length);
  assert.ok(all.filter((p) => p.note).length >= 8, 'demo carries useful notes');

  // Named places really are where the demo says: check a few against the
  // itinerary's own ordering and each other.
  const named = new Map(all.map((point) => [point.name, point.at]));
  assert.ok(named.get('漠河')![1] > named.get('加格达奇')![1], '漠河 is further north');
  assert.ok(named.get('北极村')![1] > named.get('漠河')![1], '北极村 is north of 漠河 city');
  assert.ok(haversineKm(named.get('哈尔滨')!, named.get('伊春')!) < 350);
  assert.ok(haversineKm(named.get('五大连池')!, named.get('老黑山')!) < 30, '老黑山 sits by 五大连池');
  assert.ok(haversineKm(named.get('根河')!, named.get('敖鲁古雅使鹿部落')!) < 30);
  assert.ok(named.get('黑河')![1] > named.get('五大连池')![1], 'the route runs south to north');
});

test('examples/xinganling.json is a valid minimal PUT payload', () => {
  const raw = readFileSync(new URL('../examples/xinganling.json', import.meta.url), 'utf8');
  const parsed = MapInputSchema.safeParse(JSON.parse(raw));
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error!.issues));
  const snapshot = snapshotOf(parsed.data!);
  assert.equal(snapshot.title, '小兴安岭四日线');
  assert.equal(snapshot.layers.length, 2);
  assert.equal(snapshot.layers[0].stats.days, 4);
  assert.equal(snapshot.layers[0].stats.distanceKind, 'straight');
  assert.ok(snapshot.layers[0].stats.distanceKm > 600);
  assert.ok(raw.length < 4000, `example should stay small, got ${raw.length} bytes`);
});
