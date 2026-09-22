import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMap } from '../src/core/model.js';
import { haversineKm } from '../src/core/geo.js';
import type { MapInput, MapLayer, MapPoint, RoutingInput } from '../src/core/types.js';
import { buildLegAnnotations, formatDistance, legKey, legModeLabel, transportKind } from '../src/web/components/legs.js';

const STOPS: Array<Pick<MapPoint, 'id' | 'name' | 'at'>> = [
  { id: 'a', name: '甲地', at: [0, 0] },
  { id: 'b', name: '乙地', at: [1, 0] },
  { id: 'c', name: '丙地', at: [2, 0] },
];

function routeLayer(routing?: RoutingInput, points: MapInput['layers'][number]['points'] = STOPS): MapLayer {
  const input: MapInput = { layers: [{ id: 'r', name: '路线', points, ...(routing ? { routing } : {}) }] };
  return normalizeMap(input, undefined, 'agent').layers[0];
}

test('known profiles expose a transport kind for icons without changing pill text', () => {
  assert.equal(transportKind('driving'), 'driving');
  assert.equal(transportKind(' CAR '), 'driving');
  assert.equal(transportKind('walking'), 'walking');
  assert.equal(transportKind('flight'), 'flight');
  assert.equal(transportKind(undefined), undefined);
  assert.equal(transportKind('缆车'), undefined);
});

test('transport mode words map to short Chinese labels; unknown profiles stay raw but capped', () => {
  const known: Record<string, string> = {
    driving: '驾车', car: '驾车', walking: '步行', foot: '步行',
    cycling: '骑行', bike: '骑行', bicycle: '骑行', transit: '公交', bus: '公交',
    flight: '航班', plane: '航班', train: '火车', rail: '火车', ferry: '轮渡',
  };
  for (const [profile, label] of Object.entries(known)) assert.equal(legModeLabel(profile), label, profile);
  assert.equal(legModeLabel(' DRIVING '), '驾车');
  assert.equal(legModeLabel(undefined), undefined);
  assert.equal(legModeLabel('   '), undefined);
  assert.equal(legModeLabel('缆车'), '缆车');
  assert.equal(legModeLabel('a'.repeat(20)), `${'a'.repeat(10)}…`);
});

test('straight-line honesty: computed distances always carry 直线 and never invent duration', () => {
  const legs = buildLegAnnotations([routeLayer()]);
  assert.equal(legs.length, 2);
  for (const leg of legs) {
    assert.match(leg.text, /km 直线$/);
    assert.ok(!leg.text.includes('小时') && !leg.text.includes('分钟'), leg.text);
    assert.ok(leg.ariaText.includes('直线估算'));
    assert.ok(!leg.ariaText.includes('车程'));
  }
  assert.equal(legs[0].text, `${formatDistance(haversineKm([0, 0], [1, 0]))} 直线`);
  assert.deepEqual(legs[0].anchor, [0.5, 0]);
  assert.equal(legs[0].from.id, 'a');
  assert.equal(legs[0].to.id, 'b');
});

test('routed legs show mode, distance and duration; the mode word replaces the 路由 suffix', () => {
  const layer = routeLayer({ source: 'OSRM', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 325, durationMinutes: 245, profile: 'driving' }] });
  const [first, second] = buildLegAnnotations([layer]);
  assert.equal(first.text, '驾车 · 325 km · 4 小时 5 分钟');
  assert.equal(first.ariaText, '从甲地至乙地：驾车，325 km，4 小时 5 分钟（距离为路由数据，时间为路由数据）');
  // The unrouted second leg stays a straight-line estimate.
  assert.match(second.text, /km 直线$/);
});

test('the spoken duration provenance stays mode-neutral for flights and mode-less legs', () => {
  const flight = routeLayer({ source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 2900, durationMinutes: 190, profile: 'flight' }] });
  const [first] = buildLegAnnotations([flight]);
  assert.ok(first.ariaText.includes('航班'));
  assert.ok(first.ariaText.includes('时间为路由数据'));
  assert.ok(!first.ariaText.includes('车程'));
  const noMode = routeLayer({ source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', durationMinutes: 45 }] });
  const [second] = buildLegAnnotations([noMode]);
  assert.ok(second.ariaText.includes('距离为直线估算'));
  assert.ok(second.ariaText.includes('时间为路由数据'));
  assert.ok(!second.ariaText.includes('车程'));
  assert.match(second.text, /km 直线 · 45 分钟$/);
});

test('layer-level profile is the fallback; a leg profile overrides it', () => {
  const layer = routeLayer({
    source: 'router', profile: 'driving',
    legs: [
      { fromPointId: 'a', toPointId: 'b', distanceKm: 100 },
      { fromPointId: 'b', toPointId: 'c', distanceKm: 120, profile: 'walking' },
    ],
  });
  const [first, second] = buildLegAnnotations([layer]);
  assert.equal(first.text, '驾车 · 100 km');
  assert.equal(second.text, '步行 · 120 km');
});

test('a routed distance without any mode keeps the 路由 marker; duration appears only when supplied', () => {
  const layer = routeLayer({ source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 42.25 }] });
  const [first] = buildLegAnnotations([layer]);
  assert.equal(first.text, `${formatDistance(42.25)} 路由`);
  assert.ok(!first.text.includes('小时'));
  assert.equal(first.ariaText, `从甲地至乙地：${formatDistance(42.25)} 路由（距离为路由数据）`);
});

test('a warn on either endpoint prefixes the pill text', () => {
  const layer = routeLayer(undefined, [
    { id: 'a', name: '甲地', at: [0, 0] },
    { id: 'b', name: '乙地', at: [1, 0], warn: true },
    { id: 'c', name: '丙地', at: [2, 0] },
  ]);
  const [first, second] = buildLegAnnotations([layer]);
  assert.equal(first.warn, true);
  assert.ok(first.text.startsWith('⚠ '));
  assert.ok(second.text.startsWith('⚠ '));
  assert.ok(!first.ariaText.includes('⚠'));
});

test('duplicate-coordinate pairs with no routing data are skipped; a supplied leg always shows', () => {
  const close = [
    { id: 'a', name: '甲地', at: [0, 0] as [number, number] },
    { id: 'b', name: '乙地', at: [0.0001, 0] as [number, number] },
  ];
  assert.equal(buildLegAnnotations([routeLayer(undefined, close)]).length, 0);
  const routed = routeLayer({ source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 0.4 }] }, close);
  assert.equal(buildLegAnnotations([routed]).length, 1);
});

test('spots layers produce no annotations and legKey is unique per layer', () => {
  const input: MapInput = { layers: [{ id: 's', name: '散点', kind: 'spots', points: STOPS }] };
  assert.equal(buildLegAnnotations(normalizeMap(input, undefined, 'agent').layers).length, 0);
  assert.equal(legKey({ layerId: 'r', fromPointId: 'a', toPointId: 'b' }), 'r a->b');
});

test('pill anchors sit on the supplied leg path midpoint, not the stop chord', () => {
  const path: Array<[number, number]> = [[0, 0], [0, 1], [1, 1]];
  const layer = routeLayer({
    source: 'router',
    legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 200, path }],
  }, [
    { id: 'a', name: '甲地', at: [0, 0] },
    { id: 'b', name: '乙地', at: [1, 1] },
  ]);
  const [leg] = buildLegAnnotations([layer]);
  assert.ok(leg);
  assert.notDeepEqual(leg.anchor, [0.5, 0.5]);
  assert.ok(Math.abs(leg.anchor[0]) < 0.05, String(leg.anchor));
  assert.ok(leg.anchor[1] > 0.9, String(leg.anchor));
});


test('longest, border and closed legs are marked important for auto-mode pills', () => {
  const layer = routeLayer({
    source: 'router',
    legs: [
      { fromPointId: 'a', toPointId: 'b', distanceKm: 40 },
      { fromPointId: 'b', toPointId: 'c', distanceKm: 400, border: true },
    ],
  });
  const [first, second] = buildLegAnnotations([layer]);
  assert.equal(first.important, false);
  assert.equal(second.important, true);
  const closed = routeLayer({ source: 'router', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 10, closed: true }] });
  assert.equal(buildLegAnnotations([closed])[0].important, true);
});

test('supplied delay minutes appear on the pill and mark it important', () => {
  const layer = routeLayer({ source: 'OSRM', profile: 'driving', legs: [{ fromPointId: 'a', toPointId: 'b', distanceKm: 80, durationMinutes: 70, delayMinutes: 18, traffic: 'heavy' }] });
  const [first] = buildLegAnnotations([layer]);
  assert.ok(first.text.includes('延误 18 分钟'));
  assert.equal(first.important, true);
});

test('distinct route legs receive day-based colors and support explicit leg color override', () => {
  const layer = routeLayer({
    source: 'test',
    legs: [
      { fromPointId: 'a', toPointId: 'b', distanceKm: 50 },
      { fromPointId: 'b', toPointId: 'c', distanceKm: 80, color: '#e11d48' },
    ],
  });
  layer.points[0].day = 1;
  layer.points[1].day = 2;

  const [first, second] = buildLegAnnotations([layer]);
  assert.equal(first.day, 1);
  assert.ok(first.color && first.color.startsWith('#'), 'first leg should have day 1 color');
  assert.equal(second.color, '#e11d48', 'explicit leg color overrides day palette');
  assert.notEqual(first.color, second.color, 'adjacent legs should have distinct colors for schedule distinction');
});
