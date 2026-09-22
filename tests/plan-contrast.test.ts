/**
 * What "one plan is the answer, the others are its backdrop" is allowed to do
 * to a map.
 *
 * The rules under test: a backdrop plan keeps its identity (same hue, so the
 * line still names the plan) while clearly yielding to the selected one; it
 * never fades below the point of being visible; a road condition on it stays
 * legible; and the chip that switches to it is anchored on the stretch where
 * the two plans actually differ, not on the part they share.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMap } from '../src/core/model.js';
import type { Coord, MapInput, MapLayer } from '../src/core/types.js';
import { BASEMAP, MIN_BACKDROP_CONTRAST, MIN_BASEMAP_CONTRAST, backdropColor, basemapContrast, deltaE, toHsl } from '../src/web/components/dayColors.js';
import { ROUTE_OPACITY, ROUTE_WIDTH, backdropSegmentStyle, planSummary, segmentStyle } from '../src/web/components/legs.js';
import { divergenceAnchor, routeGeometry } from '../src/web/components/geo.js';

function layer(input: MapInput['layers'][number]): MapLayer {
  return normalizeMap({ layers: [input] }, undefined, 'agent').layers[0];
}

const PALETTE = ['#2563eb', '#d66836', '#26856a', '#b48b2e', '#8b62b6', '#138aa4'];

test('a backdrop plan keeps its hue, loses its insistence, and stays visible', () => {
  for (const base of PALETTE) {
    const muted = backdropColor(base);
    const from = toHsl(base)!;
    const to = toHsl(muted)!;
    const drift = Math.abs(((from.h - to.h + 540) % 360) - 180);
    assert.ok(drift <= 1, `${base}: 背景色必须保持同一色相（漂移 ${drift.toFixed(1)}°）`);
    assert.ok(to.s < from.s, `${base}: 背景色必须降低饱和度`);
    assert.ok(to.l > from.l, `${base}: 在浅底图上背景色必须更淡`);

    // Weaker than a line meant to be read, but still findable on the basemap.
    const before = basemapContrast(base);
    const after = basemapContrast(muted);
    assert.ok(before >= MIN_BASEMAP_CONTRAST, `${base}: 前提是主线本身达标`);
    assert.ok(after <= before * 0.6, `${base}: 背景线要明显退到底图后面（${before.toFixed(2)} → ${after.toFixed(2)}）`);
    assert.ok(after >= MIN_BACKDROP_CONTRAST, `${base}: 背景色仍需可见`);
    // And distinguishable from the plan it is standing back from.
    assert.ok(deltaE(base, muted) > 15, `${base}: 主线与背景线必须一眼分得开`);
  }
});

test('two backdrops stay distinguishable from each other, not just from the selected plan', () => {
  // Three plans means two backdrops. Draining both of colour would make them
  // each other's twin, and "which of these is the one I rejected" is a
  // question the map should still answer.
  for (let i = 0; i < PALETTE.length; i += 1) {
    for (let j = i + 1; j < PALETTE.length; j += 1) {
      const apart = deltaE(backdropColor(PALETTE[i]), backdropColor(PALETTE[j]));
      assert.ok(apart > 12, `${PALETTE[i]} 与 ${PALETTE[j]} 的背景色太接近（ΔE ${apart.toFixed(1)}）`);
    }
  }
});

test('a colour already as pale as the basemap gives up chroma instead of vanishing', () => {
  // Lightening this further would take it under the visibility floor, so the
  // fade has to stop and take saturation alone.
  const pale = '#f4d35e';
  const muted = backdropColor(pale);
  assert.ok(basemapContrast(muted) >= MIN_BACKDROP_CONTRAST, '不能淡到看不见');
  assert.ok(toHsl(muted)!.s < toHsl(pale)!.s, '至少要褪去饱和度');
  assert.ok(deltaE(pale, muted) > 15, '仍要与原色分得开');
});

test('an unparsable colour becomes a neutral backdrop rather than a loud unknown', () => {
  const muted = backdropColor('rebeccapurple');
  assert.equal(muted, '#b4bdb3');
  assert.ok(basemapContrast(muted) >= MIN_BACKDROP_CONTRAST);
  assert.notEqual(muted, BASEMAP);
});

test('a road condition on a backdrop plan fades less than the rest of that plan', () => {
  const plan = layer({
    id: 'b', name: '方案 B', color: '#d66836',
    points: [{ id: 'p1', name: '甲', at: [126.5, 45.8] }, { id: 'p2', name: '乙', at: [128.9, 47.7] }],
    routing: { source: 'router', legs: [{ fromPointId: 'p1', toPointId: 'p2', closed: true }] },
  });
  const [segment] = routeGeometry(plan).segments;
  const style = segmentStyle(segment, plan);
  assert.equal(style.risk, 'closed');

  const closed = backdropSegmentStyle(style);
  const plain = backdropSegmentStyle({ color: plan.color, dashed: false, risk: 'none' });
  assert.ok(closed.alpha > plain.alpha, '封路段不能和普通路段一样淡');
  assert.equal(closed.dashed, true, '虚线的含义不随淡化改变');
  assert.equal(plain.alpha, ROUTE_OPACITY.backdrop);
  // Pointing at the plan brings the whole of it forward, short of selecting it.
  assert.equal(backdropSegmentStyle(style, true).alpha, ROUTE_OPACITY.backdropHover);
  assert.ok(ROUTE_OPACITY.backdropHover < ROUTE_OPACITY.selected);
  assert.ok(ROUTE_WIDTH.backdrop < ROUTE_WIDTH.selected);
});

test('the switch chip is anchored where the plans differ, not where they agree', () => {
  // Two routes from the same start to the same end; B detours north in the middle.
  const shared: Coord[] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const detour: Coord[] = [[0, 0], [1, 0], [2, 1.5], [3, 0], [4, 0]];
  const spot = divergenceAnchor(detour, shared);
  assert.ok(spot, '有几何就必须能给出锚点');
  assert.deepEqual(spot.at, [2, 1.5]);
  assert.ok(spot.awayKm > 100, `分歧距离应为真实距离，得到 ${spot.awayKm}`);
  assert.deepEqual(spot.before, [1, 0]);
  assert.deepEqual(spot.after, [3, 0]);
});

test('two identical plans still get an anchor, and an empty one gets none', () => {
  const line: Coord[] = [[0, 0], [1, 0], [2, 0]];
  const same = divergenceAnchor(line, line);
  assert.ok(same, '完全重合时也要给出可点击的位置');
  assert.ok(same.awayKm < 0.001, '重合的两条线之间没有距离可言');

  // Nothing to compare against: the whole line is the difference.
  const alone = divergenceAnchor(line, []);
  assert.ok(alone);
  assert.equal(alone.awayKm, Number.POSITIVE_INFINITY);
  assert.equal(divergenceAnchor([], line), undefined);
});

test('the chip names the plan and repeats the provenance rules of every other number', () => {
  const routed = layer({
    id: 'a', name: '方案 A', color: '#2563eb',
    points: [{ id: 'p1', name: '哈尔滨', at: [126.53, 45.8] }, { id: 'p2', name: '伊春', at: [128.9, 47.72] }],
    routing: { source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', distanceKm: 325, durationMinutes: 245 }] },
  });
  const summary = planSummary(routed);
  assert.match(summary, /^方案 A · 325 km · 4 小时 5 分钟$/);
  assert.doesNotMatch(summary, /直线/, '路由距离不得标成直线');

  const estimated = layer({
    id: 'b', name: '方案 B', color: '#d66836',
    points: [{ id: 'p1', name: '甲', at: [126.53, 45.8] }, { id: 'p2', name: '乙', at: [128.9, 47.72] }],
  });
  assert.match(planSummary(estimated), /直线$/, 'Cartula 自己算的距离必须标注直线');

  // A plan named for what it covers keeps the name, not the description.
  const described = layer({ id: 'c', name: '小兴安岭线：哈尔滨—黑河', color: '#26856a', points: [] });
  assert.equal(planSummary(described), '小兴安岭线');
  const long = layer({ id: 'd', name: '一个很长很长的方案名称用来测试截断', color: '#26856a', points: [] });
  assert.equal(planSummary(long), '一个很长很长的方…', '芯片上的名字要截断，否则会盖住地图');
});
