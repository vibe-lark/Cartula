/**
 * What a plan's day colours have to satisfy to be readable on the map.
 *
 * A route line says two things at once: which plan it belongs to (hue) and which
 * day of that plan it covers (the ladder of shades inside that hue). Both have to
 * survive, and the failure that started this was losing each in turn — first day
 * 2 and day 6 of the blue plan sat ΔE 7.1 apart, then a fix that separated the
 * days did it by making one plan's shades range from grey lavender to electric
 * blue, so the *plan* stopped being identifiable.
 *
 * ΔE is CIE76 — plain Euclidean distance in CIE Lab. Deliberately not ΔE2000:
 * CIE76 *overstates* the difference between saturated blues, so using it as the
 * acceptance measure is the conservative choice for exactly the hues this
 * palette leans on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_PALETTE, normalizeMap } from '../src/core/model.js';
import type { MapInput } from '../src/core/types.js';
import {
  BASEMAP,
  LADDER,
  MAX_HUE_DRIFT,
  MIN_BASEMAP_CONTRAST,
  PALETTE_LADDERS,
  basemapContrast,
  buildPaletteLadders,
  dayLadder,
  deltaE,
  hueSpanFor,
  lightnessCeiling,
  onBasemap,
  toHsl,
} from '../src/web/components/dayColors.js';
import { planDayColor, pointColor, segmentColor } from '../src/web/components/legs.js';

/** The scope the cross-plan target is stated over: the first six plans. */
const PLANS = LAYER_PALETTE.slice(0, 6);
const DAYS = LADDER.period;

const hslOf = (hex: string) => {
  const hsl = toHsl(hex);
  assert.ok(hsl, `unparseable colour ${hex}`);
  return hsl!;
};
/** Signed hue difference in degrees, shortest way round the circle. */
const hueDrift = (from: string, to: string) => Math.abs(((hslOf(to).h - hslOf(from).h + 540) % 360) - 180);

/* ---------------------------------------------------- ① consecutive days */

test('consecutive days of one plan are clearly different (ΔE ≥ 25)', () => {
  let worst = { distance: Infinity, where: '' };
  for (const base of LAYER_PALETTE) {
    const days = Array.from({ length: DAYS }, (_, i) => planDayColor(base, i + 1));
    for (let i = 0; i < days.length; i += 1) {
      // Wrapping matters: a plan running past the period draws day P+1 next to
      // day 1, so that seam is a consecutive pair too.
      const next = (i + 1) % days.length;
      const distance = deltaE(days[i], days[next]);
      if (distance < worst.distance) {
        worst = { distance, where: `${base} D${i + 1}/D${next + 1} ${days[i]}/${days[next]}` };
      }
    }
  }
  assert.ok(worst.distance >= 25, `相邻两天只差 ΔE ${worst.distance.toFixed(2)}：${worst.where}`);
});

/* ------------------------------------------------------- ② any two days */

test('any two days of one plan stay distinguishable (ΔE ≥ 12)', () => {
  let worst = { distance: Infinity, where: '' };
  for (const base of LAYER_PALETTE) {
    const days = Array.from({ length: DAYS }, (_, i) => planDayColor(base, i + 1));
    for (let i = 0; i < days.length; i += 1) {
      for (let j = i + 1; j < days.length; j += 1) {
        const distance = deltaE(days[i], days[j]);
        if (distance < worst.distance) {
          worst = { distance, where: `${base} D${i + 1}/D${j + 1} ${days[i]}/${days[j]}` };
        }
      }
    }
  }
  assert.ok(worst.distance >= 12, `同方案两天只差 ΔE ${worst.distance.toFixed(2)}：${worst.where}`);
});

/* -------------------------------------------- ③ period, and no exact repeat */

test('the ladder holds twelve distinct shades, so a two-week plan never repeats a colour exactly', () => {
  assert.ok(LADDER.period >= 12, `周期 ${LADDER.period} 小于 12`);
  for (const base of LAYER_PALETTE) {
    const days = Array.from({ length: DAYS }, (_, i) => planDayColor(base, i + 1));
    assert.equal(new Set(days).size, DAYS, `${base} 的 ${DAYS} 天里有完全相同的颜色：${days.join(' ')}`);
  }
  // Past the period the ladder does repeat — that is the documented limit, not
  // an accident, and it is what keeps a 20-day plan from being pushed into
  // colours that would collide with another plan.
  for (const base of PLANS) {
    assert.equal(planDayColor(base, DAYS + 1), planDayColor(base, 1), `${base} 超出周期后应循环`);
    assert.equal(planDayColor(base, DAYS + 5), planDayColor(base, 5));
  }
});

/* ----------------------------------------------------------- ④ cross-plan */

test('no plan-day lands on another plan-day (ΔE ≥ 15 over 6 plans × 12 days)', () => {
  const all: { hex: string; base: string; label: string }[] = [];
  for (const base of PLANS) {
    for (let day = 1; day <= DAYS; day += 1) all.push({ hex: planDayColor(base, day), base, label: `${base} D${day}` });
  }
  assert.equal(all.length, 72);
  let worst = { distance: Infinity, a: '', b: '' };
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      // Within one plan is targets ① and ② above; this is the cross-plan rule.
      if (all[i].base === all[j].base) continue;
      const distance = deltaE(all[i].hex, all[j].hex);
      if (distance < worst.distance) {
        worst = { distance, a: `${all[i].label} ${all[i].hex}`, b: `${all[j].label} ${all[j].hex}` };
      }
    }
  }
  assert.ok(worst.distance >= 15, `跨方案撞色：${worst.a} 与 ${worst.b} 只差 ΔE ${worst.distance.toFixed(2)}`);
});

/* ------------------------------------------------------ ⑤ family coherence */

test('the days of one plan read as one family, not as unrelated colours', () => {
  // The regression this pins: a ladder that separated days by letting saturation
  // range 46%–95%, so day 2 was a grey lavender and day 3 electric blue. Days
  // told apart, plan identity destroyed — which is the more expensive failure.
  for (const base of LAYER_PALETTE) {
    const days = Array.from({ length: DAYS }, (_, i) => planDayColor(base, i + 1));
    const saturations = days.map(hex => hslOf(hex).s);
    const range = Math.max(...saturations) - Math.min(...saturations);
    assert.ok(range <= 30, `${base} 的饱和度极差 ${range.toFixed(1)} 个百分点，同方案看不出是一族`);
    assert.ok(Math.min(...saturations) >= 45, `${base} 有一天饱和度只有 ${Math.min(...saturations).toFixed(1)}%，接近灰色`);
    for (const [index, hex] of days.entries()) {
      const drift = hueDrift(base, hex);
      assert.ok(drift <= MAX_HUE_DRIFT, `${base} D${index + 1} = ${hex} 色相偏移 ${drift.toFixed(1)}°，超出 ${MAX_HUE_DRIFT}°`);
    }
  }
});

test('day 1 is the plan\'s own colour, so a plan stays recognisable', () => {
  for (const base of LAYER_PALETTE) {
    const first = planDayColor(base, 1);
    assert.ok(deltaE(base, first) <= 6, `${base} 的第 1 天是 ${first}，与方案色差 ΔE ${deltaE(base, first).toFixed(1)}`);
    assert.ok(hueDrift(base, first) <= 2, `${base} 的第 1 天色相偏了 ${hueDrift(base, first).toFixed(1)}°`);
  }
});

/* ------------------------------------------------------------- ⑥ contrast */

test('every generated colour stays legible on the palest basemap', () => {
  for (const base of LAYER_PALETTE) {
    for (let day = 1; day <= DAYS; day += 1) {
      const hex = planDayColor(base, day);
      const ratio = basemapContrast(hex);
      assert.ok(ratio >= MIN_BASEMAP_CONTRAST, `${base} D${day} = ${hex} 在 ${BASEMAP} 上对比度仅 ${ratio.toFixed(3)}`);
    }
  }
});

test('no shade falls into the band where hue stops being readable', () => {
  // The original defect: the old ladder pushed even days to L26–31, where blue,
  // violet and red all read as one dark mass, and `onBasemap` only ever
  // darkened — driving colours further into it.
  for (const base of LAYER_PALETTE) {
    for (let day = 1; day <= DAYS; day += 1) {
      const hex = planDayColor(base, day);
      const light = hslOf(hex).l;
      assert.ok(light >= LADDER.lightFloor - 1, `${base} D${day} = ${hex} 亮度 ${light.toFixed(0)}，色相不可读`);
    }
  }
});

/* -------------------------------------------------- palette and determinism */

test('the palette drops the two hues the pale basemap crushes', () => {
  // Clearing the contrast ratio caps each hue's lightness, and the cap is very
  // uneven: 82 for blue, 45–46 for yellow-green and teal. Eleven usable steps
  // cannot carry twelve distinguishable shades, so those two were removed.
  assert.equal(LAYER_PALETTE.length, 10);
  assert.ok(!LAYER_PALETTE.includes('#65a30d' as never), '#65a30d 应已从调色板移除');
  assert.ok(!LAYER_PALETTE.includes('#0d9488' as never), '#0d9488 应已从调色板移除');
  for (const base of LAYER_PALETTE) {
    assert.ok(lightnessCeiling(base) >= 49, `${base} 的亮度上限只有 ${lightnessCeiling(base)}，装不下 12 阶`);
  }
  // The removed hues really are the crushed ones — the reason, not just the fact.
  for (const dropped of ['#65a30d', '#0d9488']) {
    assert.ok(lightnessCeiling(dropped) <= 46, `${dropped} 的亮度上限 ${lightnessCeiling(dropped)}，与移除理由不符`);
  }
});

test('the same map always renders in the same colours', () => {
  // Reproducibility is a requirement, not a nicety: a screenshot and a shared
  // link have to show the same route in the same colour, so nothing here may
  // depend on a random source or on insertion order at runtime.
  const once = buildPaletteLadders([...LAYER_PALETTE]);
  const twice = buildPaletteLadders([...LAYER_PALETTE]);
  assert.deepEqual(once, twice);
  // And the baked table is exactly what the generator produces, so the rule in
  // the code stays the single source of truth for the values shipped.
  LAYER_PALETTE.forEach((base, index) => {
    assert.deepEqual(once[index], [...PALETTE_LADDERS[base]], `${base} 的预生成阶梯与生成规则不一致`);
  });
});

test('a hue with lightness headroom needs less rotation than one the basemap squeezed', () => {
  // Fact 1 in LadderSpec, as behaviour: the wedge is per-hue for a reason.
  assert.ok(hueSpanFor('#2563eb') < hueSpanFor('#16a34a'),
    `蓝色 ±${hueSpanFor('#2563eb')}° 应小于绿色 ±${hueSpanFor('#16a34a')}°`);
  for (const base of LAYER_PALETTE) assert.ok(hueSpanFor(base) <= LADDER.hueSpan);
});

/* -------------------------------------------- colours outside the palette */

/**
 * Every guarantee a custom ladder makes, checked as the *cycle* it is.
 *
 * A ladder is drawn cyclically: a plan with more days than the ladder has rungs
 * wraps, so its last rung is drawn next to its first. The seam is therefore a
 * consecutive pair and is held to the same 25 as any other — this is exactly the
 * pair an earlier version of these tests walked past, because it only iterated
 * `index`/`index+1` inside the array and never closed the loop.
 *
 * A ladder is allowed to be *short*: an arbitrary colour may not have room for
 * twelve rungs, and a repeat is cheaper than a pair nobody can tell apart. What
 * is never allowed is a seam under 25.
 */
function assertCustomLadder(colour: string) {
  const ladder = dayLadder(colour);
  assert.ok(ladder.length >= 1, `${colour} 没有生成任何色阶`);
  assert.deepEqual([...dayLadder(colour)], [...ladder], `${colour} 的阶梯必须可复现`);
  assert.equal(new Set(ladder).size, ladder.length, `${colour} 的阶梯里有完全相同的颜色`);

  const saturations = ladder.map(hex => hslOf(hex).s);
  assert.ok(Math.max(...saturations) - Math.min(...saturations) <= 30, `${colour} 的饱和度极差过大`);
  for (const hex of ladder) {
    assert.ok(basemapContrast(hex) >= MIN_BASEMAP_CONTRAST, `${colour} 的 ${hex} 在底图上看不清`);
    assert.ok(hueDrift(colour, hex) <= MAX_HUE_DRIFT, `${colour} 的 ${hex} 色相偏移 ${hueDrift(colour, hex).toFixed(1)}°`);
  }

  // A single-rung ladder is the documented degenerate case: a colour with no
  // room for a second shade that clears 25 from it on both sides. It has no
  // consecutive pair at all, so every day of that plan is drawn in the plan's
  // own colour — days told apart by the numbered list rather than by hue, which
  // is honest, where a crowded second shade would not be.
  if (ladder.length === 1) {
    assert.match(ladder[0], /^#[0-9a-f]{6}$/, `${colour} 的单阶必须是有效颜色`);
    return ladder;
  }

  for (let i = 0; i < ladder.length; i += 1) {
    // Wrapping: the last rung's next neighbour is day 1.
    const next = (i + 1) % ladder.length;
    const distance = deltaE(ladder[i], ladder[next]);
    const seam = next === 0 ? '（接缝）' : '';
    assert.ok(distance >= 25,
      `${colour} 第 ${i + 1}/${next + 1} 天${seam}只差 ΔE ${distance.toFixed(2)}：${ladder[i]}/${ladder[next]}`);
  }
  for (let i = 0; i < ladder.length; i += 1) {
    for (let j = i + 1; j < ladder.length; j += 1) {
      const gap = Math.min(j - i, ladder.length - (j - i));
      if (gap === 1) continue;
      const distance = deltaE(ladder[i], ladder[j]);
      assert.ok(distance >= 12, `${colour} 第 ${i + 1}/${j + 1} 天只差 ΔE ${distance.toFixed(2)}`);
    }
  }
  return ladder;
}

test('a colour dropped from the palette still gets a working ladder, seam included', () => {
  // Maps and agents already wrote `#65a30d` / `#0d9488` into `layer.color`, and
  // removing them from the palette must not break those. They take the runtime
  // path in `dayLadder`, so the guarantees are asserted here rather than assumed.
  for (const dropped of ['#65a30d', '#0d9488']) assertCustomLadder(dropped);
});

test('an arbitrary caller colour gets a ladder that meets the day rules, seam included', () => {
  // Anything may arrive in `layer.color`: a violet, a slate, a muted brown.
  for (const custom of ['#8b5cf6', '#334155', '#8a5a2b', '#c026d3']) {
    assertCustomLadder(custom);
    // And it separates from the palette's own colours, or a custom plan would be
    // mistaken for an automatic one.
    for (const base of PLANS) {
      assert.ok(deltaE(planDayColor(custom, 1), planDayColor(base, 1)) >= 10,
        `${custom} 的第 1 天与 ${base} 的第 1 天太接近`);
    }
  }
});

test('a short custom ladder is an honest capacity limit, not a broken one', () => {
  // The pale basemap caps these hues so hard that a cycle — where every rung
  // needs 25 from *two* neighbours — has very little room. The ladders come back
  // short, and that is the right answer: measured against an exhaustive search
  // over the same candidate grid, each of these is already at its upper bound.
  for (const squeezed of ['#65a30d', '#6b7280', '#334155', '#0d9488']) {
    const ladder = assertCustomLadder(squeezed);
    assert.ok(ladder.length < LADDER.period,
      `${squeezed} 意外地达到了完整周期，容量假设需要复核`);
    // Short means it repeats sooner — which must still be exactly the ladder.
    assert.equal(planDayColor(squeezed, ladder.length + 1), ladder[0],
      `${squeezed} 超出自身周期后应回到第 1 阶`);
  }
});

test('a colour Cartula cannot parse is passed through, never guessed at', () => {
  assert.equal(planDayColor('rebeccapurple', 3), 'rebeccapurple');
  assert.equal(planDayColor('', 1), '');
});

test('a grey plan colour stays grey instead of being turned vivid', () => {
  // The saturation floor applies only where the base has saturation to spend: a
  // deliberately muted `layer.color` must not come back as a saturated one, or
  // "give me a grey plan" is answered with a colourful one.
  const grey = '#6b7280';
  const ladder = assertCustomLadder(grey);
  const baseSaturation = hslOf(grey).s;
  for (const hex of ladder) {
    assert.ok(hslOf(hex).s <= baseSaturation + LADDER.satWindow,
      `${hex} 饱和度 ${hslOf(hex).s.toFixed(0)}% 远高于灰色方案自身的 ${baseSaturation.toFixed(0)}%`);
  }
});

/* --------------------------------------------------------------- onBasemap */

test('onBasemap searches both directions but cannot lighten past a pale basemap', () => {
  // A pale yellow-green fails the ratio and has to be darkened…
  const pale = onBasemap(80, 90, 88);
  assert.ok(basemapContrast(pale) >= MIN_BASEMAP_CONTRAST);
  assert.ok(hslOf(pale).l < 88, '过亮的颜色应当被压暗');
  // …and a colour already clear of the ratio is returned unchanged.
  const fine = onBasemap(221, 83, 53);
  assert.ok(basemapContrast(fine) >= MIN_BASEMAP_CONTRAST);
  assert.equal(Math.round(hslOf(fine).l), 53, '已达标的颜色不应被改动');

  // Why lightening never actually fires here, recorded so it is not mistaken for
  // the old one-directional bug: `#eef2e8` has relative luminance 0.875, so even
  // pure white reaches only 1.135 against it — below the 1.55 a route line needs.
  // Every failing shade is too *light*, and darkening is the only direction that
  // can satisfy the ratio. The two-directional search still matters: it removed
  // the old L26 floor, and it picks the shorter move on a dark basemap.
  assert.ok(basemapContrast('#ffffff') < MIN_BASEMAP_CONTRAST, '浅色底图上提亮无法达标');
  for (let hue = 0; hue < 360; hue += 15) {
    for (let l = 40; l <= 80; l += 10) {
      const out = onBasemap(hue, 60, l);
      if (basemapContrast(out) < MIN_BASEMAP_CONTRAST) continue;
      assert.ok(hslOf(out).l <= l + 0.5, `h${hue} L${l} 被提亮到 ${hslOf(out).l.toFixed(0)}，但提亮不可能达标`);
    }
  }
  // The old rule stopped at L26 and gave up; this one keeps searching, so a shade
  // needing to go below that band still comes back satisfying the ratio.
  const stubborn = onBasemap(60, 95, 95);
  assert.ok(basemapContrast(stubborn) >= MIN_BASEMAP_CONTRAST, `${stubborn} 仍未达标`);
});

/* ---------------------------------------------------------------- pickColor */

test('pickColor follows palette order, which the measurements say beats farthest-point', () => {
  const layers = (count: number): MapInput => ({
    layers: Array.from({ length: count }, (_, i) => ({ name: `方案 ${i + 1}`, points: [{ name: `p${i}`, at: [100 + i, 30] }] })),
  });
  const six = normalizeMap(layers(6), undefined, 'agent').layers.map(layer => layer.color);
  assert.deepEqual(six, [...PLANS], '自动分配应严格按调色板顺序');
  // Deterministic: the same map comes back in the same colours.
  assert.deepEqual(normalizeMap(layers(6), undefined, 'agent').layers.map(l => l.color), six);
  // A colour the caller set is respected and not handed out again.
  const withExplicit = normalizeMap({
    layers: [
      { name: '定制', color: '#2563eb', points: [{ name: 'a', at: [100, 30] }] },
      { name: '自动', points: [{ name: 'b', at: [101, 30] }] },
    ],
  }, undefined, 'agent').layers.map(layer => layer.color);
  assert.equal(withExplicit[0], '#2563eb');
  assert.notEqual(withExplicit[1], '#2563eb', '自动色不能重复调用方已占用的颜色');
  // Past the palette's length it still hands out a colour rather than failing.
  const many = normalizeMap(layers(LAYER_PALETTE.length + 2), undefined, 'agent').layers;
  assert.equal(many.length, LAYER_PALETTE.length + 2);
  for (const layer of many) assert.match(layer.color, /^#[0-9a-f]{6}$/);
});

test('day colours reach the map and the list through the same resolver', () => {
  // The list, the markers and the route all have to agree, or the legend lies.
  const input: MapInput = {
    layers: [{
      id: 'r', name: '方案 A', color: '#2563eb',
      points: [
        { id: 'p1', name: '甲', at: [126.5, 45.8], day: 1 },
        { id: 'p2', name: '乙', at: [128.9, 47.7], day: 2 },
      ],
    }],
  };
  const layer = normalizeMap(input, undefined, 'agent').layers[0];
  assert.equal(segmentColor({ fromPointId: 'p1', toPointId: 'p2' }, layer), planDayColor('#2563eb', 1));
  assert.equal(pointColor(layer.points[1], layer), planDayColor('#2563eb', 2));
  assert.notEqual(pointColor(layer.points[0], layer), pointColor(layer.points[1], layer));
});
