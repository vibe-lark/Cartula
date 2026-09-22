import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMap } from '../src/core/model.js';
import type { MapInput, MapLayer } from '../src/core/types.js';
import { pathMidpoint, routeGeometry } from '../src/web/components/geo.js';

function layer(input: MapInput['layers'][number]): MapLayer {
  return normalizeMap({ layers: [input] }, undefined, 'agent').layers[0];
}

test('per-leg paths draw as labelled provided segments; missing legs fall back to the stop pair', () => {
  const route = layer({
    id: 'r', name: '线',
    points: [{ id: 'a', name: '甲', at: [0, 0] }, { id: 'b', name: '乙', at: [1, 0] }, { id: 'c', name: '丙', at: [2, 0] }],
    path: [[0, 0], [0.5, 0.5], [2, 0]],
    routing: {
      source: 'router',
      legs: [{ fromPointId: 'a', toPointId: 'b', path: [[0, 0], [0, 1], [1, 0]] }],
    },
  });
  const geometry = routeGeometry(route);
  assert.equal(geometry.kind, 'provided');
  assert.equal(geometry.segments.length, 2);
  assert.deepEqual(geometry.segments[0], { coords: [[0, 0], [0, 1], [1, 0]], warn: false, fromPointId: 'a', toPointId: 'b' });
  assert.deepEqual(geometry.segments[1], { coords: [[1, 0], [2, 0]], warn: false, fromPointId: 'b', toPointId: 'c' });
});

test('an unlabelled layer.path stays one polyline when no per-leg path exists', () => {
  const route = layer({
    id: 'r', name: '线',
    points: [{ id: 'a', name: '甲', at: [0, 0] }, { id: 'b', name: '乙', at: [1, 0] }],
    path: [[0, 0], [0.4, 0.2], [1, 0]],
  });
  const geometry = routeGeometry(route);
  assert.equal(geometry.kind, 'provided');
  assert.equal(geometry.segments.length, 1);
  assert.equal(geometry.segments[0].fromPointId, undefined);
  assert.equal(geometry.segments[0].toPointId, undefined);
  assert.deepEqual(geometry.segments[0].coords, [[0, 0], [0.4, 0.2], [1, 0]]);
});

test('straight warn segments stay labelled so they can be picked and highlighted', () => {
  const route = layer({
    id: 'r', name: '线',
    points: [{ id: 'a', name: '甲', at: [0, 0], warn: true }, { id: 'b', name: '乙', at: [1, 0] }],
  });
  const geometry = routeGeometry(route);
  assert.equal(geometry.kind, 'straight');
  assert.equal(geometry.segments.length, 1);
  assert.equal(geometry.segments[0].warn, true);
  assert.equal(geometry.segments[0].fromPointId, 'a');
  assert.equal(geometry.segments[0].toPointId, 'b');
});

test('pathMidpoint walks distance, not coordinate index', () => {
  assert.deepEqual(pathMidpoint([[0, 0], [1, 0], [2, 0]]), [1, 0]);
  assert.equal(pathMidpoint([]), undefined);
});

test('avoided legs overlay a dashed chord without dropping the supplied layer.path', () => {
  const route = layer({
    id: 'r', name: '线',
    points: [{ id: 'a', name: '甲', at: [0, 0] }, { id: 'b', name: '乙', at: [1, 0] }],
    path: [[0, 0], [0.4, 0.2], [1, 0]],
    routing: { source: 'OSRM', legs: [{ fromPointId: 'a', toPointId: 'b', note: '用户要求避免 甲 至 乙', distanceKm: 12 }] },
  });
  const geometry = routeGeometry(route);
  assert.equal(geometry.kind, 'provided');
  assert.equal(geometry.segments.length, 2);
  assert.deepEqual(geometry.segments[0].coords, [[0, 0], [0.4, 0.2], [1, 0]]);
  assert.equal(geometry.segments[1].avoid, true);
  assert.equal(geometry.segments[1].warn, true);
  assert.deepEqual(geometry.segments[1].coords, [[0, 0], [1, 0]]);
});
