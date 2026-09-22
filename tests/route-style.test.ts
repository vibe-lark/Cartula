/**
 * What a colour, a dash and a duration on the map are allowed to mean.
 *
 * The rules under test: a caller's `layer.color` is the default identity of a
 * route; day colouring is an explicit mode; a reminder on a stop is not a road
 * condition; `traffic: 'unknown'` is not a road condition either; and a
 * routing duration is time in motion, never a trip time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMap } from '../src/core/model.js';
import type { MapInput, MapLayer } from '../src/core/types.js';
import { routeGeometry } from '../src/web/components/geo.js';
import { LADDER, deltaE } from '../src/web/components/dayColors.js';
import {
  RISK_COLORS,
  RISK_LABELS,
  TRAVEL_TIME_NOTE,
  planDayColor,
  pointColor,
  segmentColor,
  segmentRisk,
  segmentStyle,
  travelTimeLabel,
} from '../src/web/components/legs.js';
import { activeMapIntents, priorityLabel } from '../src/web/components/intents.js';

function layer(input: MapInput['layers'][number]): MapLayer {
  return normalizeMap({ layers: [input] }, undefined, 'agent').layers[0];
}
const PLAN_A = (extra: Partial<MapInput['layers'][number]> = {}) => layer({
  id: 'a', name: '方案 A', color: '#2563eb',
  points: [
    { id: 'p1', name: '哈尔滨', at: [126.53, 45.8], day: 1 },
    { id: 'p2', name: '伊春', at: [128.9, 47.72], day: 2 },
    { id: 'p3', name: '嘉荫', at: [130.4, 48.89], day: 3 },
  ],
  ...extra,
});

/** WCAG relative luminance, for "will this line show up on the basemap". */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('a route with nothing to separate stays exactly the colour the caller set', () => {
  // No day numbers at all: no rainbow by position, no shading.
  const undated = PLAN_A({ points: PLAN_A().points.map(({ day: _day, ...rest }) => rest) });
  for (const seg of routeGeometry(undated).segments) {
    assert.equal(segmentColor(seg, undated), '#2563eb', '默认按图层颜色');
    assert.equal(segmentStyle(seg, undated).color, '#2563eb');
    assert.equal(segmentStyle(seg, undated).dashed, false);
  }
  assert.equal(new Set(routeGeometry(undated).segments.map(seg => segmentColor(seg, undated))).size, 1);
  assert.equal(pointColor(undated.points[1], undated), '#2563eb');

  // One single day is not a distinction either.
  const oneDay = PLAN_A({ points: PLAN_A().points.map(point => ({ ...point, day: 1 })) });
  assert.equal(segmentColor(routeGeometry(oneDay).segments[0], oneDay), '#2563eb');
  assert.equal(pointColor(oneDay.points[0], oneDay), '#2563eb');

  // `layer` mode flattens a dated plan back to the one colour, for comparing
  // whole alternatives without the day detail.
  const dated = PLAN_A();
  assert.equal(new Set(routeGeometry(dated).segments.map(seg => segmentColor(seg, dated, 'layer'))).size, 1);
  assert.equal(pointColor(dated.points[2], dated, 'layer'), '#2563eb');
});

test('days of one plan are shades of that plan, and neighbouring days never look alike', () => {
  const route = PLAN_A();
  const [first, second] = routeGeometry(route).segments;
  // Default mode is day shading: this is what a multi-day plan looks like.
  assert.equal(segmentColor(first, route), planDayColor('#2563eb', 1));
  assert.equal(segmentColor(second, route), planDayColor('#2563eb', 2));
  assert.equal(pointColor(route.points[2], route), planDayColor('#2563eb', 3));

  // The ladder repeats after `LADDER.period` days on purpose. Squeezing more
  // distinct shades out of one hue is what used to put day 2 and day 6 of the
  // blue plan ΔE 7.1 apart, and pushed one plan's late days onto another plan's
  // colour; a repeated shade inside a plan, whose stops are numbered and dated
  // in the list, is the cheaper compromise. `day-colors.test.ts` states the
  // separations this buys and measures them in Lab.
  const period = LADDER.period;
  const cycle = Array.from({ length: period }, (_, i) => planDayColor('#2563eb', i + 1));
  assert.equal(new Set(cycle).size, period, '一个周期内每天都应有独立色阶');
  assert.equal(planDayColor('#2563eb', period + 1), cycle[0], '超过周期后色阶循环使用');
  for (let i = 1; i < cycle.length; i += 1) {
    // Lab ΔE, not raw RGB distance: RGB under-reports differences between warm
    // colours and over-reports them between blues, so it is the wrong ruler for
    // "can a reader tell these two lines apart".
    assert.ok(deltaE(cycle[i], cycle[i - 1]) >= 25, `D${i} 与 D${i + 1} 太接近：${cycle[i - 1]} / ${cycle[i]}`);
    // The palest basemap Cartula ships; a line has to stay readable on it.
    assert.ok(contrast(cycle[i], '#eef2e8') >= 1.45, `D${i + 1} 在浅底图上看不清：${cycle[i]}`);
  }
});

test('a shade never leaves its plan: two plans stay distinguishable day by day', () => {
  const plans = ['#2563eb', '#e11d48', '#16a34a', '#f59e0b'];
  for (const [a, b] of plans.flatMap((x, i) => plans.slice(i + 1).map(y => [x, y] as const))) {
    for (let day = 1; day <= 14; day += 1) {
      assert.notEqual(planDayColor(a, day), planDayColor(b, day));
      for (let other = 1; other <= 14; other += 1) {
        assert.ok(deltaE(planDayColor(a, day), planDayColor(b, other)) >= 15,
          `${a} D${day} 与 ${b} D${other} 撞色`);
      }
    }
  }
  // A colour Cartula cannot parse is passed through, never guessed at.
  assert.equal(planDayColor('rebeccapurple', 3), 'rebeccapurple');
});

test('an explicit per-leg colour always wins, in either mode', () => {
  const custom = PLAN_A({ routing: { source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', color: '#111111' }] } });
  const [legFirst] = routeGeometry(custom).segments;
  assert.equal(segmentColor(legFirst, custom, 'layer'), '#111111');
  assert.equal(segmentColor(legFirst, custom, 'day'), '#111111');
});

test('a per-leg copy of the layer colour does not suppress day colours', () => {
  const copied = PLAN_A({ routing: {
    source: 'OSRM',
    legs: [
      { fromPointId: 'p1', toPointId: 'p2', color: '#2563eb' },
      { fromPointId: 'p2', toPointId: 'p3', color: '#2563eb' },
    ],
  } });
  const [first, second] = routeGeometry(copied).segments;
  assert.equal(segmentColor(first, copied, 'day'), planDayColor('#2563eb', 1));
  assert.equal(segmentColor(second, copied, 'day'), planDayColor('#2563eb', 2));
  assert.notEqual(segmentColor(first, copied, 'day'), segmentColor(second, copied, 'day'));
  // The explicit layer mode still honours the copied colour, so comparison
  // mode remains a true one-colour-per-plan view.
  assert.equal(segmentColor(second, copied, 'layer'), '#2563eb');
});

test('a stop reminder keeps the route colour; only supplied traffic gets a traffic hue', () => {
  const route = PLAN_A({
    points: [
      { id: 'p1', name: '哈尔滨', at: [126.53, 45.8] },
      { id: 'p2', name: '伊春', at: [128.9, 47.72], warn: true },
      { id: 'p3', name: '嘉荫', at: [130.4, 48.89] },
    ],
  });
  const segments = routeGeometry(route).segments;
  for (const seg of segments) {
    const style = segmentStyle(seg, route);
    assert.equal(segmentRisk(seg), 'reminder');
    assert.equal(style.color, '#2563eb', '季节提醒不得被画成红色路况');
    assert.notEqual(style.color, RISK_COLORS.closed);
    assert.notEqual(style.color, RISK_COLORS.congested);
    assert.equal(style.dashed, true, '仍然与普通路段区分');
  }
  assert.ok(RISK_LABELS.reminder.includes('不代表路况'));
});

test('traffic unknown is not a road condition, and each known state has its own style', () => {
  const unknown = PLAN_A({ routing: { source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', traffic: 'unknown' }] } });
  const [seg] = routeGeometry(unknown).segments;
  assert.equal(seg.traffic, undefined, 'unknown 不写进渲染数据');
  assert.equal(segmentRisk(seg), 'none');
  // Still the plan's own colour for that day — no traffic hue was invented.
  assert.equal(segmentStyle(seg, unknown).color, planDayColor('#2563eb', 1));

  const states: Array<[MapLayer['routing'], string, string]> = [
    [{ source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', traffic: 'heavy' }] }, 'congested', RISK_COLORS.congested],
    [{ source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', traffic: 'moderate' }] }, 'slow', RISK_COLORS.slow],
    [{ source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', closed: true }] }, 'closed', RISK_COLORS.closed],
    [{ source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', note: '用户要求避免 哈尔滨 至 伊春' }] }, 'avoid', RISK_COLORS.avoid],
  ];
  for (const [routing, risk, color] of states) {
    const route = PLAN_A({ routing });
    const [first] = routeGeometry(route).segments;
    assert.equal(segmentRisk(first), risk, risk);
    assert.equal(segmentStyle(first, route).color, color, risk);
  }
  // A clear road is a fact too, and it is not a warning.
  const clear = PLAN_A({ routing: { source: 'OSRM', legs: [{ fromPointId: 'p1', toPointId: 'p2', traffic: 'clear' }] } });
  assert.equal(segmentRisk(routeGeometry(clear).segments[0]), 'none');
});

test('routing durations are named as time in motion, per transport mode', () => {
  assert.equal(travelTimeLabel('driving'), '纯驾驶时间');
  assert.equal(travelTimeLabel(' CAR '), '纯驾驶时间');
  assert.equal(travelTimeLabel('walking'), '纯步行时间');
  assert.equal(travelTimeLabel('cycling'), '纯骑行时间');
  assert.equal(travelTimeLabel('train'), '纯乘车时间');
  assert.equal(travelTimeLabel('flight'), '纯飞行时间');
  assert.equal(travelTimeLabel('ferry'), '纯乘船时间');
  // An unknown or absent profile must not be labelled as driving.
  assert.equal(travelTimeLabel(undefined), '纯移动时间');
  assert.equal(travelTimeLabel('缆车'), '纯移动时间');
  assert.ok(!travelTimeLabel(undefined).includes('驾驶'));
  assert.ok(TRAVEL_TIME_NOTE.includes('不含'));
  for (const label of ['纯驾驶时间', '纯步行时间']) assert.ok(!label.includes('行程'), '不再叫“预计行程时间”');
});

test('planning priorities read as Chinese, and resolved intents leave the canvas', () => {
  assert.equal(priorityLabel('must'), '必须做到');
  assert.equal(priorityLabel('prefer'), '尽量做到');
  assert.equal(priorityLabel('avoid'), '尽量避免');
  assert.equal(priorityLabel('optional'), '可选');
  assert.equal(priorityLabel(undefined), '尽量做到');
  const intents = activeMapIntents([
    { scope: 'map', text: '减少长途驾驶', priority: 'must' },
    { scope: 'map', text: '旧的要求', priority: 'prefer', status: 'resolved' },
    { scope: 'layer', layerId: 'a', text: '图层意图' },
  ]);
  assert.deepEqual(intents.map(intent => intent.text), ['减少长途驾驶']);
  assert.deepEqual(activeMapIntents(undefined), []);
});
