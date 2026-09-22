import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { parseOsrmRoute, osrmProfile, downsamplePath, applyResolvedRoutes, resolveMissingRoutes } from '../src/core/osrm.js';
import type { MapLayer } from '../src/core/types.js';

const milan = { id: 'milan', at: [9.19, 45.46] as [number, number] };
const turin = { id: 'turin', at: [7.6869, 45.0703] as [number, number] };

const osrmPayload = {
  code: 'Ok',
  routes: [{
    distance: 145123, duration: 6300,
    geometry: { type: 'LineString', coordinates: [[9.19, 45.46], [8.5, 45.2], [7.6869, 45.0703]] },
    legs: [{
      distance: 145123, duration: 6300,
      steps: [
        { geometry: { type: 'LineString', coordinates: [[9.19, 45.46], [8.9, 45.3]] } },
        { geometry: { type: 'LineString', coordinates: [[8.9, 45.3], [7.6869, 45.0703]] } },
      ],
    }],
  }],
};

test('parseOsrmRoute maps metres/seconds onto adjacent stop ids and concatenates step geometry', () => {
  const parsed = parseOsrmRoute(osrmPayload, [milan, turin], 'driving');
  assert.ok(parsed);
  assert.equal(parsed.distanceKm, 145.123);
  assert.equal(parsed.durationMinutes, 105);
  assert.equal(parsed.legs.length, 1);
  assert.equal(parsed.legs[0].fromPointId, 'milan');
  assert.equal(parsed.legs[0].toPointId, 'turin');
  assert.deepEqual(parsed.path, [[9.19, 45.46], [8.9, 45.3], [7.6869, 45.0703]]);
  assert.equal(osrmProfile('car'), 'driving');
  assert.equal(osrmProfile('train'), undefined);
  assert.equal(osrmProfile('flight'), undefined);
  assert.equal(downsamplePath(Array.from({ length: 20 }, (_, i) => [i, 0]), 5).length <= 6, true);
});

test('resolveMissingRoutes fills driving layers without path and skips flights or supplied geometry', async () => {
  const layers = [
    { id: 'drive', name: '自驾', kind: 'route', color: '#000', visible: true, crs: 'wgs84', edited_by: 'agent', points: [
      { id: 'milan', name: '米兰', at: [9.19, 45.46] }, { id: 'turin', name: '都灵', at: [7.6869, 45.0703] },
    ], stats: { distanceKm: 1, days: 2, distanceKind: 'straight', pointCount: 2 } },
    { id: 'fly', name: '航班', kind: 'route', color: '#000', visible: true, crs: 'wgs84', edited_by: 'agent', routing: { source: 'manual', profile: 'flight' }, points: [
      { id: 'milan', name: '米兰', at: [9.19, 45.46] }, { id: 'nice', name: '尼斯', at: [7.26, 43.70] },
    ], stats: { distanceKm: 1, days: 2, distanceKind: 'straight', pointCount: 2 } },
    { id: 'kept', name: '已有路', kind: 'route', color: '#000', visible: true, crs: 'wgs84', edited_by: 'agent', path: [[0, 0], [1, 1]], points: [
      { id: 'a', name: '甲', at: [0, 0] }, { id: 'b', name: '乙', at: [1, 1] },
    ], stats: { distanceKm: 1, days: 2, distanceKind: 'provided', pointCount: 2 } },
  ] as MapLayer[];
  const resolved = await resolveMissingRoutes(layers, async () => parseOsrmRoute(osrmPayload, [milan, turin], 'driving'));
  assert.deepEqual(resolved.map(item => item.layerId), ['drive']);
  const filled = applyResolvedRoutes(layers, resolved);
  assert.deepEqual(filled, ['自驾']);
  assert.ok((layers[0].path?.length ?? 0) >= 2);
  assert.equal(layers[0].routing?.source, 'OSRM');
  assert.equal(layers[1].path, undefined);
  assert.deepEqual(layers[2].path, [[0, 0], [1, 1]]);
});

function mockFetch(payload: unknown = osrmPayload, ok = true) {
  return async () => ({ ok, json: async () => payload, body: { cancel: async () => undefined } });
}

test('create_map without path stores OSRM geometry for the UI and keeps it out of Agent summaries', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: mockFetch() as never });
  t.after(() => app.close());
  const created = await app.inject({ method: 'PUT', url: '/m/osrm-trip', payload: { title: '米兰到都灵', layers: [{ id: 'route', name: '自驾', points: [
    { id: 'milan', name: '米兰', at: [9.19, 45.46] }, { id: 'turin', name: '都灵', at: [7.6869, 45.0703] },
  ] }] } });
  assert.equal(created.statusCode, 200, created.body);
  const map = store.get('osrm-trip');
  assert.ok((map.layers[0].path?.length ?? 0) >= 2);
  assert.equal(map.layers[0].routing?.source, 'OSRM');
  assert.equal(map.layers[0].routing?.durationMinutes, 105);
  assert.equal(map.layers[0].routing?.legs?.[0].fromPointId, 'milan');
  const summary = await app.inject({ url: '/m/osrm-trip?view=summary', headers: { authorization: `Bearer ${created.json().editKey}` } });
  const body = JSON.stringify(summary.json());
  assert.ok(!body.includes('"path":['));
  assert.ok(body.includes('105') || body.includes('durationMinutes'));
});

test('a caller-supplied path is not overwritten; routing failure leaves a straight estimate', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: mockFetch({ code: 'NoRoute' }) as never });
  t.after(() => app.close());
  const created = await app.inject({ method: 'PUT', url: '/m/no-route', payload: { layers: [{ name: '自驾', points: [
    { id: 'a', name: '甲', at: [9.19, 45.46] }, { id: 'b', name: '乙', at: [7.68, 45.07] },
  ] }] } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(store.get('no-route').layers[0].path, undefined);
  assert.equal(store.get('no-route').layers[0].stats.distanceKind, 'straight');
  assert.equal(store.get('no-route').layers[0].stats.durationMinutes, undefined);

  const kept = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: mockFetch() as never });
  t.after(() => kept.app.close());
  const supplied = [[9.19, 45.46], [0, 0], [7.68, 45.07]];
  const written = await kept.app.inject({ method: 'PUT', url: '/m/kept-path', payload: { layers: [{ name: '自驾', path: supplied, points: [
    { id: 'a', name: '甲', at: [9.19, 45.46] }, { id: 'b', name: '乙', at: [7.68, 45.07] },
  ] }] } });
  assert.equal(written.statusCode, 200, written.body);
  assert.deepEqual(kept.store.get('kept-path').layers[0].path, supplied);
});

test('a cached route is relabelled with the ids of the layer asking for it', async t => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return mockFetch()(); };
  const { app, store } = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: fetchImpl as never });
  t.after(() => app.close());
  // Two layers, same road, different stop ids: the second must not inherit the
  // first layer's leg ids from the cache, or its legs stop matching its points.
  const created = await app.inject({ method: 'PUT', url: '/m/shared', payload: { layers: [
    { id: 'plan-a', name: '方案 A', points: [{ id: 'a1', name: '米兰', at: [9.19, 45.46] }, { id: 'a2', name: '都灵', at: [7.6869, 45.0703] }] },
    { id: 'plan-b', name: '方案 B', points: [{ id: 'b1', name: '米兰', at: [9.19, 45.46] }, { id: 'b2', name: '都灵', at: [7.6869, 45.0703] }] },
  ] } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(calls, 1, 'the identical road is fetched once');
  const map = store.get('shared');
  assert.deepEqual(map.layers[0].routing?.legs?.map(leg => [leg.fromPointId, leg.toPointId]), [['a1', 'a2']]);
  assert.deepEqual(map.layers[1].routing?.legs?.map(leg => [leg.fromPointId, leg.toPointId]), [['b1', 'b2']]);
  assert.ok((map.layers[1].path?.length ?? 0) >= 2);
  // Cross-talk used to make the second layer's legs unusable for editing.
  const edited = await app.inject({ method: 'PATCH', url: '/m/shared', headers: { authorization: `Bearer ${created.json().editKey}` }, payload: { baseVersion: 1, operations: [
    { op: 'route.leg.update', layerId: 'plan-b', fromPointId: 'b1', toPointId: 'b2', patch: { traffic: 'heavy' } },
  ] } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(store.get('shared').layers[1].routing?.legs?.[0].traffic, 'heavy');
});

test('moving a stop invalidates the old road and re-resolves in the same version', async t => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mockFetch()();
  };
  const { app, store } = await createApp({ dbPath: ':memory:', osrmUrl: 'https://router.example', osrmFetch: fetchImpl as never });
  t.after(() => app.close());
  const created = await app.inject({ method: 'PUT', url: '/m/move', payload: { layers: [{ id: 'route', name: '自驾', points: [
    { id: 'milan', name: '米兰', at: [9.19, 45.46] }, { id: 'turin', name: '都灵', at: [7.6869, 45.0703] },
  ] }] } });
  const map = created.json();
  assert.equal(calls, 1);
  const moved = await app.inject({ method: 'POST', url: '/api/maps/move/edit', headers: { authorization: `Bearer ${map.editKey}` }, payload: { baseVersion: 1, operations: [{ op: 'update', layerId: 'route', pointId: 'turin', patch: { at: [7.7, 45.1] } }] } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().version, 2);
  assert.equal(calls, 2);
  assert.ok(store.get('move').layers[0].path);
  assert.ok(moved.json().changes.join(' ').includes('OSRM') || store.get('move').layers[0].routing?.source === 'OSRM');
});
