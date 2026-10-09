/**
 * The list arithmetic behind a stop list's day groups (`itinerary.ts`).
 *
 * The list is drawn per day, `reorder` works on the layer's single order. The
 * arrow buttons used to move a stop by its layer index, so 上移 on the first
 * stop of day 2 slid it in front of day 1's last stop while it stayed in day 2:
 * nothing moved in the list, the numbers went 01,03 / 02,04 and the map drew a
 * zigzag back into day 1. A drop on a day's header from a later day landed one
 * before that day's last stop instead of after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, normalizeMap } from '../src/core/model.js';
import type { MapInput, MapLayer, MapSnapshot } from '../src/core/types.js';
import { dailyLimitMinutes, dayTravel, groupEndTarget, layerIntentTexts, stepMove } from '../src/web/components/itinerary.js';

const INPUT: MapInput = {
  title: '行程',
  layers: [{
    id: 'plan', name: '方案 A', color: '#2563eb',
    points: [
      { id: 'a', name: '甲', at: [8.5, 47.3], day: 1 },
      { id: 'b', name: '乙', at: [8.6, 47.4], day: 1 },
      { id: 'c', name: '丙', at: [8.7, 47.5], day: 2 },
      { id: 'd', name: '丁', at: [8.8, 47.6], day: 2 },
      { id: 'e', name: '戊', at: [8.9, 47.7], day: 3 },
    ],
    routing: {
      source: 'test', profile: 'driving',
      legs: [
        { fromPointId: 'a', toPointId: 'b', distanceKm: 100, durationMinutes: 80 },
        { fromPointId: 'b', toPointId: 'c', distanceKm: 50, durationMinutes: 40 },
        { fromPointId: 'c', toPointId: 'd', distanceKm: 200, durationMinutes: 150 },
        { fromPointId: 'd', toPointId: 'e', distanceKm: 120 },
      ],
    },
  }],
};

function snapshotOf(input: MapInput): MapSnapshot {
  const { layers, title } = normalizeMap(input, undefined, 'agent');
  return { id: 'm', title, layers, version: 1, parent: null, changed: false, changes: [], events: [], updatedAt: '', url: '' };
}
const layerOf = (snapshot: MapSnapshot) => snapshot.layers[0];
const dayOf = (layer: MapLayer, day: number) => layer.points.filter(point => point.day === day);
const reorder = (snapshot: MapSnapshot, pointId: string, toIndex: number) =>
  applyOperations(snapshot, [{ op: 'reorder', layerId: 'plan', pointId, toIndex }]).layers[0].points.map(point => point.id);

const groupsOf = (layer: MapLayer) => [...new Set(layer.points.map(point => point.day!))].sort((a, b) => a - b)
  .map(day => ({ day, points: dayOf(layer, day) }));
/** Apply an arrow the way the workspace does: reorder, plus the day when it changes. */
function step(snapshot: MapSnapshot, pointId: string, dir: -1 | 1) {
  const layer = layerOf(snapshot);
  const move = stepMove(layer, groupsOf(layer), pointId, dir);
  if (!move) return null;
  const from = layer.points.findIndex(point => point.id === pointId);
  const result = applyOperations(snapshot, [
    ...(move.toIndex >= 0 && move.toIndex !== from ? [{ op: 'reorder' as const, layerId: 'plan', pointId, toIndex: move.toIndex }] : []),
    ...(move.toDay !== undefined ? [{ op: 'update' as const, layerId: 'plan', pointId, patch: { day: move.toDay } }] : []),
  ]);
  return result.layers[0].points.map(point => `${point.id}${point.day}`).join(' ');
}

test('an arrow swaps a stop with its neighbour in the same day', () => {
  const snapshot = snapshotOf(INPUT);
  assert.equal(step(snapshot, 'd', -1), 'a1 b1 d2 c2 e3');
  assert.equal(step(snapshot, 'c', 1), 'a1 b1 d2 c2 e3');
});

test('off the end of a day an arrow moves the stop into the adjacent day, where the list shows it', () => {
  const snapshot = snapshotOf(INPUT);
  // 上移 on day 2's first stop: the last stop of day 1, not a day-2 stop
  // wedged between A and B (the old zigzag).
  assert.equal(step(snapshot, 'c', -1), 'a1 b1 c1 d2 e3');
  // 下移 on day 1's last stop: the first stop of day 2.
  assert.equal(step(snapshot, 'b', 1), 'a1 b2 c2 d2 e3');
  assert.equal(step(snapshot, 'd', 1), 'a1 b1 c2 d3 e3');
  // Nowhere to go past the first and last day.
  assert.equal(step(snapshot, 'a', -1), null);
  assert.equal(step(snapshot, 'e', 1), null);
});

test('an arrow skips over stops of other days that sit between two of the same day', () => {
  const interleaved = snapshotOf({ ...INPUT, layers: [{ ...INPUT.layers[0], points: [
    { id: 'a', name: '甲', at: [8.5, 47.3], day: 1 },
    { id: 'x', name: '插', at: [8.55, 47.35], day: 2 },
    { id: 'b', name: '乙', at: [8.6, 47.4], day: 1 },
  ], routing: undefined }] });
  assert.equal(step(interleaved, 'b', -1), 'b1 a1 x2');
  assert.equal(step(interleaved, 'a', 1), 'x2 b1 a1');
});

test('a drop on a day header lands after that day\'s last stop, from either direction', () => {
  const snapshot = snapshotOf(INPUT);
  const layer = layerOf(snapshot);
  // From a later day: E onto 第 1 天 → after B, not between A and B.
  assert.deepEqual(reorder(snapshot, 'e', groupEndTarget(layer, dayOf(layer, 1), 'e')), ['a', 'b', 'e', 'c', 'd']);
  // From an earlier day: A onto 第 2 天 → after D.
  assert.deepEqual(reorder(snapshot, 'a', groupEndTarget(layer, dayOf(layer, 2), 'a')), ['b', 'c', 'd', 'a', 'e']);
  // An empty day has nothing to land after: the caller changes only the day.
  assert.equal(groupEndTarget(layer, [], 'a'), -1);
});

test('a day\'s travel is the legs out of its stops, the ones the rows show', () => {
  const layer = layerOf(snapshotOf(INPUT));
  assert.deepEqual(dayTravel(layer, dayOf(layer, 1)), { distanceKm: 150, straight: false, minutes: 120, partialTime: false, legs: 2 });
  // D → E reports a distance and no time: the day's time is a lower bound.
  const day2 = dayTravel(layer, dayOf(layer, 2))!;
  assert.equal(day2.distanceKm, 320);
  assert.equal(day2.minutes, 150);
  assert.equal(day2.partialTime, true);
  // The last stop of the route leaves for nowhere.
  assert.equal(dayTravel(layer, dayOf(layer, 3)), null);
});

test('a leg without a routed distance falls back to straight-line and says so', () => {
  const layer = layerOf(snapshotOf({ ...INPUT, layers: [{ ...INPUT.layers[0], routing: undefined }] }));
  const travel = dayTravel(layer, dayOf(layer, 1))!;
  assert.equal(travel.straight, true);
  assert.equal(travel.minutes, undefined);
  assert.ok(travel.distanceKm > 0);
});

test('a per-day cap is read from the way people write it', () => {
  assert.equal(dailyLimitMinutes(['每天开车不超过三小时']), 180);
  assert.equal(dailyLimitMinutes(['每日车程控制在 4 小时以内']), 240);
  assert.equal(dailyLimitMinutes(['单日驾驶最多两个半小时']), 150);
  assert.equal(dailyLimitMinutes(['每天不超过90分钟车程']), 90);
  assert.equal(dailyLimitMinutes(['每天开车不超过十二小时']), 720);
  // The tighter of two caps wins; prose without a number is not a cap.
  assert.equal(dailyLimitMinutes(['每天开车不超过5小时', '这一段每天开车不超过三小时']), 180);
  assert.equal(dailyLimitMinutes(['减少长途驾驶，把时间留给瑞士', undefined]), undefined);
});

test('the cap comes from the map and this layer, never another layer or a resolved intent', () => {
  const texts = layerIntentTexts({ id: 'plan', intent: '每天开车不超过四小时' }, [
    { scope: 'map', text: '每天开车不超过三小时' },
    { scope: 'layer', layerId: 'other', text: '每天开车不超过一小时' },
    { scope: 'layer', layerId: 'plan', text: '每天开车不超过两小时', status: 'resolved' },
  ]);
  assert.equal(dailyLimitMinutes(texts), 180);
});

test('a new stop takes the name of the labelled place under the click', async () => {
  const { basemapPlaceName } = await import('../src/web/components/preferences.js');
  const road = { sourceLayer: 'transportation_name', properties: { name: '清华东路' } };
  const poi = { sourceLayer: 'poi', properties: { name: 'Interlaken Ost', 'name:zh-Hans': '因特拉肯东站', 'name:en': 'Interlaken Ost' } };
  const town = { sourceLayer: 'place', properties: { name: 'Interlaken' } };
  // A road label nearest the click is not the place; the POI beats the town.
  assert.equal(basemapPlaceName([road, town, poi], 'zh'), '因特拉肯东站');
  assert.equal(basemapPlaceName([road, town, poi], 'en'), 'Interlaken Ost');
  assert.equal(basemapPlaceName([road, town], 'zh'), 'Interlaken');
  assert.equal(basemapPlaceName([road], 'zh'), undefined);
});
