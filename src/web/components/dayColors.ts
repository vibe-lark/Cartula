/**
 * The colours a multi-day plan is drawn in.
 *
 * One line on the map carries two identities at once: which plan it belongs to,
 * and which day of that plan it covers. Hue carries the plan; a ladder of
 * lightness and saturation steps inside that hue carries the day.
 *
 * Everything here is deterministic. The same plan colour always produces the
 * same ladder, so a screenshot, a shared link and a re-render all agree — which
 * rules out picking shades at random, however well-separated random would be.
 *
 * What the generator has to satisfy at once:
 *
 *  1. Every shade is legible on the palest basemap Cartula ships
 *     (`MIN_BASEMAP_CONTRAST` against `#eef2e8`).
 *  2. Consecutive days of one plan are clearly different (ΔE ≥ 25) and any two
 *     days of one plan are at least distinguishable (ΔE ≥ 12).
 *  3. The days of one plan look like one family: hue held within 16°, saturation
 *     within a 26-point window and never below 45%. Without this the days are
 *     told apart but the *plan* stops being identifiable — a grey lavender and
 *     an electric blue are not two days of the same route.
 *  4. No plan's day lands on another plan's day (ΔE ≥ 15 across the first six).
 *  5. Twelve distinct shades before the ladder repeats, so a two-week itinerary
 *     never draws two days in exactly the same colour.
 *
 * Requirements 2 and 4 pull against each other — spreading one plan's days
 * pushes them outward toward its neighbours — and requirement 3 bounds how far
 * either can go. `LadderSpec` records the three measured facts that decide how
 * the budget is spent, and `tests/day-colors.test.ts` asserts every number above
 * against the ladders this actually produces.
 */
import type { MapLayer } from '../../core/types.js';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `#RRGGBB` → HSL. The schema guarantees that form; anything else → undefined. */
export function toHsl(hex: string): { h: number; s: number; l: number } | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => channel / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  const l = (max + Math.min(r, g, b)) / 2;
  if (!span) return { h: 0, s: 0, l: l * 100 };
  const hue = max === r ? (g - b) / span + (g < b ? 6 : 0) : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return { h: hue * 60, s: (span / (1 - Math.abs(2 * l - 1))) * 100, l: l * 100 };
}

export function toHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const light = clamp(l, 0, 100) / 100;
  const chromaValue = (1 - Math.abs(2 * light - 1)) * (clamp(s, 0, 100) / 100);
  const second = chromaValue * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = light - chromaValue / 2;
  const rgb = hue < 60 ? [chromaValue, second, 0] : hue < 120 ? [second, chromaValue, 0] : hue < 180 ? [0, chromaValue, second]
    : hue < 240 ? [0, second, chromaValue] : hue < 300 ? [second, 0, chromaValue] : [chromaValue, 0, second];
  return `#${rgb.map(channel => Math.round((channel + base) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Linear-light channels, shared by the luminance and Lab conversions. */
function linear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
    .map(channel => channel / 255)
    .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return [r, g, b];
}

/** Relative luminance (WCAG), the honest measure of "will this line show up". */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
    .map(channel => channel / 255)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type Lab = [number, number, number];

/** CIE Lab (D65 white point) — the space distances are measured in. */
export function toLab(hex: string): Lab {
  const [r, g, b] = linear(hex);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * CIE76 ΔE: plain Euclidean distance in Lab.
 *
 * Deliberately not ΔE2000. CIE76 overstates the difference between saturated
 * blues, which is the one place it would flatter this palette — so using it as
 * the *acceptance* measure is the conservative choice for hue separation, and
 * it keeps the numbers reproducible with four lines of arithmetic.
 */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const labDistance = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Lab chroma. Near zero the colour is grey and its hue says nothing. */
export function chroma(hex: string): number {
  const [, a, b] = toLab(hex);
  return Math.hypot(a, b);
}

/**
 * The palest basemap Cartula ships, and the contrast a route line keeps against
 * it. Lightness alone does not decide visibility: a yellow-green high on the
 * ladder is far more luminous than a blue at the same value.
 */
export const BASEMAP = '#eef2e8';
const BASEMAP_LUMINANCE = luminance(BASEMAP);
export const MIN_BASEMAP_CONTRAST = 1.55;

export function basemapContrast(hex: string): number {
  const value = luminance(hex);
  const [hi, lo] = value > BASEMAP_LUMINANCE ? [value, BASEMAP_LUMINANCE] : [BASEMAP_LUMINANCE, value];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Nudge a colour until it clears the basemap contrast ratio, taking whichever
 * direction reaches it in fewer steps.
 *
 * The old rule walked downwards only, and stopped at lightness 26 whether or
 * not it had succeeded — so it both drove hues into the band where blue, violet
 * and red are all indistinguishable ink, and could return a colour that still
 * failed the ratio. This searches outwards from the requested lightness and
 * returns the first shade in either direction that satisfies it.
 *
 * Worth knowing before reading this as "so it lightens sometimes": against the
 * palest basemap Cartula ships it never does. `#eef2e8` has relative luminance
 * 0.875, so even pure white reaches only 1.135 against it — under the 1.55 a
 * route line needs. Every shade that fails here is too light, and darkening is
 * the only direction that can satisfy the ratio at all. The two-directional
 * search still earns its place: it is what removed the L26 floor, it never
 * returns an unsatisfied colour while a satisfying one exists, and it picks the
 * shorter move on a dark basemap, where lightening is the direction that works.
 *
 * Returns the input unchanged when no lightness satisfies the ratio, because a
 * silently wrong colour is worse than an honestly unattainable one.
 */
export function onBasemap(h: number, s: number, l: number): string {
  const start = toHex(h, s, l);
  if (basemapContrast(start) >= MIN_BASEMAP_CONTRAST) return start;
  for (let step = 2; step <= 100; step += 2) {
    const down = l - step;
    const up = l + step;
    // Ties go to the darker shade: a route line reads as ink on paper.
    if (down >= 0) {
      const hex = toHex(h, s, down);
      if (basemapContrast(hex) >= MIN_BASEMAP_CONTRAST) return hex;
    }
    if (up <= 100) {
      const hex = toHex(h, s, up);
      if (basemapContrast(hex) >= MIN_BASEMAP_CONTRAST) return hex;
    }
  }
  return start;
}

/* ------------------------------------------------------------- the day ladder */

/**
 * The shape of the search the ladder generator runs.
 *
 * Three geometric facts about this problem, measured rather than assumed, decide
 * every number here. They are recorded because each one is counter-intuitive and
 * each one cost a wrong design first:
 *
 * 1. **The pale basemap punishes dark hues twice.** Clearing
 *    `MIN_BASEMAP_CONTRAST` against `#eef2e8` puts a *ceiling* on each hue's
 *    lightness, and the ceiling is wildly uneven: 82 for blue and violet, but
 *    45–46 for yellow-green and teal. A hue with eleven usable lightness steps
 *    cannot carry as many distinguishable shades as one with forty-eight. That
 *    is why `LAYER_PALETTE` no longer contains `#65a30d` or `#0d9488` — they
 *    were the two weakest colours in the product before they were the two that
 *    failed the measurement.
 * 2. **Hue degrees are not perceptual distance.** Lab compresses the greens, so
 *    two hues 57° apart there can be closer than two blues 22° apart. Ordering
 *    the palette by hue spread put both greens in the first six plans and
 *    cross-plan separation collapsed to ΔE 3.7. Ordering it by Lab distance
 *    halved the hue gap (30° → 17°) and broke the day ladders instead. The
 *    palette's original order beats both — see `pickColor` in `core/model.ts`.
 * 3. **The objective has to be minimax.** Every acceptance target is a
 *    *minimum*, so summing squared shortfall lets the search trade one pair down
 *    to ΔE 1.6 in exchange for small gains elsewhere, and counting violations is
 *    scale-blind enough to collapse a pair to exactly 0. Maximising the worst
 *    normalised gap first, with the sum only as a tie-break, is what refuses
 *    both trades.
 *
 * `hueSpan` is per-hue for reason 1: a hue with headroom needs only a few
 * degrees, while one the basemap has squeezed needs more to spread its days at
 * all. It is capped so the *measured* deviation stays inside the family rule —
 * HSL→hex→HSL does not round-trip exactly, so a nominal ±16 can read back as
 * 16.4 and fail.
 *
 * `lightFloor` is the original headline fix: the old ladder reached down to 26,
 * where blue, violet and red are all indistinguishable ink.
 *
 * The saturation window keeps a plan's days looking like one family. Without it
 * the generator produced a plan whose day 2 was a grey lavender at 46%
 * saturation and whose day 3 was electric blue at 95% — days told apart, plan
 * identity destroyed.
 */
export interface LadderSpec {
  /** Widest hue rotation allowed, before the per-hue reduction. */
  hueSpan: number;
  lightFloor: number;
  /** Saturation window width, in percentage points. */
  satWindow: number;
  /** Lowest saturation any shade may have. */
  satFloor: number;
  /** Distinct shades before the ladder repeats. */
  period: number;
  /**
   * What the generator *aims* for. Deliberately above the acceptance
   * thresholds (25 / 12 / 15): a local search lands slightly under whatever it
   * targets, so asking for exactly the threshold reliably misses it by tenths.
   */
  adjacentTarget: number;
  anyTarget: number;
  crossTarget: number;
  /** Plans held to the full cross-plan target — the acceptance scope. */
  crossScope: number;
}

export const LADDER: LadderSpec = {
  hueSpan: 14,
  lightFloor: 36,
  satWindow: 26,
  satFloor: 45,
  period: 12,
  adjacentTarget: 26,
  anyTarget: 13,
  crossTarget: 15,
  crossScope: 6,
};

/** Hue drift a shade may show from its plan's own hue, as measured back. */
export const MAX_HUE_DRIFT = 16;

/**
 * The lightness ceiling a hue can reach and still clear the basemap contrast.
 *
 * This is fact 1 above, as a function. It is why the ladder cannot use one
 * lightness band for every plan.
 */
export function lightnessCeiling(base: string): number {
  const hsl = toHsl(base);
  if (!hsl) return 50;
  for (let light = 100; light >= 0; light -= 1) {
    if (basemapContrast(toHex(hsl.h, Math.min(95, hsl.s), light)) >= MIN_BASEMAP_CONTRAST) return light;
  }
  return 50;
}

/**
 * How much hue rotation this plan's ladder may use.
 *
 * A hue with plenty of lightness headroom separates its days by lightness alone
 * and needs almost no rotation; one the basemap has squeezed into eleven steps
 * needs the extra dimension or its days cannot be told apart at all.
 */
export function hueSpanFor(base: string, spec: LadderSpec = LADDER): number {
  const ceiling = lightnessCeiling(base);
  return Math.min(spec.hueSpan, ceiling >= 70 ? 6 : ceiling >= 60 ? 12 : 14);
}

interface Candidate { hex: string; lab: Lab }

/**
 * Every shade of `base` that may appear in its ladder.
 *
 * Four hard constraints, none of them negotiable by the search — which is the
 * point. Family coherence in particular has to be a property of the *pool*: as
 * a term in the objective it gets traded away for day separation, which is
 * exactly how plan identity was lost before.
 *
 *  - legible on the palest basemap;
 *  - within this hue's own lightness band (floor to its measured ceiling);
 *  - saturation inside a bounded window that contains the plan's own, so the
 *    days of one plan read as one family and a muted plan colour stays muted;
 *  - hue drift within the family rule, checked on the value that comes *back*
 *    rather than the value asked for.
 *
 * The saturation floor applies only to colours that already have saturation to
 * spend. A deliberately grey or near-grey `layer.color` is held to a window
 * around *its own* value instead: forcing it up to the floor would answer "give
 * me a muted plan" with a vivid one, which is a worse failure than a grey plan
 * whose days are separated by lightness alone.
 */
function candidates(base: string, spec: LadderSpec = LADDER, step = 1): Candidate[] {
  const hsl = toHsl(base);
  if (!hsl) return [];
  const span = hueSpanFor(base, spec);
  const ceiling = lightnessCeiling(base);
  // The window is placed to contain the plan's own saturation, so day 1 really
  // is the colour the caller chose; it only rises to the floor when the base
  // can reach it.
  const low = hsl.s >= spec.satFloor
    ? Math.max(spec.satFloor, Math.min(hsl.s - spec.satWindow / 2, 95 - spec.satWindow))
    : Math.max(0, hsl.s - spec.satWindow / 2);
  const high = Math.min(95, low + spec.satWindow);
  const out: Candidate[] = [];
  for (let dh = -span; dh <= span; dh += step) {
    for (let s = low; s <= high; s += 2 * step) {
      for (let light = spec.lightFloor; light <= ceiling; light += step) {
        const hex = toHex(hsl.h + dh, s, light);
        if (basemapContrast(hex) < MIN_BASEMAP_CONTRAST) continue;
        const drift = toHsl(hex);
        if (!drift) continue;
        const delta = Math.abs(((drift.h - hsl.h + 540) % 360) - 180);
        if (delta > MAX_HUE_DRIFT - 0.5) continue;
        out.push({ hex, lab: toLab(hex) });
      }
    }
  }
  return out;
}

/**
 * Which separation a pair of slots is supposed to have.
 *
 * Same plan: consecutive days get the adjacent target, everything else the
 * weaker any-two-days target. The distance wraps, because a plan that runs past
 * the period draws its day P+1 next to its day 1.
 *
 * Different plans: the full cross-plan target inside the acceptance scope, and a
 * softened one beyond it — the later palette entries still have to stay off the
 * earlier ones, but they must not distort the ladders that matter most.
 */
function targetFor(spec: LadderSpec, planA: number, dayA: number, planB: number, dayB: number): number {
  if (planA !== planB) {
    return planA < spec.crossScope && planB < spec.crossScope ? spec.crossTarget : spec.crossTarget * 0.75;
  }
  const gap = Math.min(Math.abs(dayA - dayB), spec.period - Math.abs(dayA - dayB));
  return gap === 1 ? spec.adjacentTarget : spec.anyTarget;
}

/**
 * A minimax score: the worst normalised gap first, the sum only to break ties.
 *
 * Fact 3 in `LadderSpec`, as code. Normalising each distance by the separation
 * its pair is supposed to have is what lets one number compare "far enough from
 * yesterday" with "far enough from the other plan"; taking the *worst* of them
 * is what stops the search paying for broad small gains by collapsing one pair.
 */
type Score = [worst: number, total: number];
const improves = (a: Score, b: Score) =>
  a[0] > b[0] + 1e-12 || (Math.abs(a[0] - b[0]) <= 1e-12 && a[1] > b[1] + 1e-9);

/**
 * The minimax score of a finished ladder, read as the cycle it is: the pair that
 * closes it (last rung against day 1) counts as a consecutive pair, because that
 * is how it is drawn on a plan running past the period.
 */
function cycleScore(seq: readonly Candidate[], affinity: Map<Candidate, number>, spec: LadderSpec): Score {
  let worst = Infinity;
  let total = 0;
  for (let i = 0; i < seq.length; i += 1) {
    for (let j = i + 1; j < seq.length; j += 1) {
      const gap = Math.min(j - i, seq.length - (j - i));
      const target = gap === 1 ? spec.adjacentTarget : spec.anyTarget;
      const ratio = labDistance(seq[i].lab, seq[j].lab) / target;
      if (ratio < worst) worst = ratio;
      total += Math.min(ratio, 3);
    }
    total += affinity.get(seq[i]) ?? 0;
  }
  return [worst, total];
}

/**
 * Ladders for a whole palette, solved together.
 *
 * Building each plan's ladder alone maximises its own day separation and drives
 * neighbouring hues into the same corner of Lab — measured at cross-plan ΔE 2.3.
 * Solving them jointly is what keeps plan identity intact.
 *
 * Three phases, all deterministic — fixed candidate order, fixed sweep order,
 * strict improvement only — so a map renders in the same colours every time,
 * which is what makes a screenshot match its shared link:
 *
 *  1. Day 1 of each plan is the shade closest to the colour the caller set, so
 *     a plan stays recognisable. It is then pinned.
 *  2. The rest are filled by farthest-point insertion.
 *  3. Every free rung is swept and moved wherever it most improves the minimax
 *     score, then each plan's days are tried in swapped orders — reordering
 *     changes *which* pairs count as consecutive, and is the only direct lever
 *     on the adjacent-day metric.
 */
export function buildPaletteLadders(palette: readonly string[], spec: LadderSpec = LADDER): string[][] {
  const plans = palette.map(base => ({ base, hsl: toHsl(base), pool: candidates(base, spec) }));
  // A colour with no usable shades keeps itself; nothing else is honest.
  if (plans.some(plan => plan.pool.length < spec.period)) {
    return plans.map(plan => (plan.pool.length ? plan.pool.map(c => c.hex).slice(0, spec.period) : [plan.base]));
  }

  const chosen: Candidate[][] = plans.map(({ base, hsl, pool }) => {
    const anchor = toLab(toHex(hsl!.h, hsl!.s, clamp(hsl!.l, spec.lightFloor, lightnessCeiling(base))));
    let seed = pool[0];
    let best = Infinity;
    for (const candidate of pool) {
      const distance = labDistance(candidate.lab, anchor);
      if (distance < best) { best = distance; seed = candidate; }
    }
    const seq = [seed];
    while (seq.length < spec.period) {
      let pick = pool[0];
      let score = -Infinity;
      for (const candidate of pool) {
        let worst = Infinity;
        for (let i = 0; i < seq.length; i += 1) {
          const target = i === seq.length - 1 ? spec.adjacentTarget : spec.anyTarget;
          worst = Math.min(worst, labDistance(seq[i].lab, candidate.lab) / target);
        }
        if (worst > score) { score = worst; pick = candidate; }
      }
      seq.push(pick);
    }
    return seq;
  });

  const placed = () => {
    const out: { plan: number; day: number; candidate: Candidate }[] = [];
    chosen.forEach((row, plan) => row.forEach((candidate, day) => out.push({ plan, day, candidate })));
    return out;
  };
  /** Minimax score of one slot against everything else on the map. */
  const slotScore = (plan: number, day: number, candidate: Candidate, others: ReturnType<typeof placed>): Score => {
    let worst = Infinity;
    let total = 0;
    for (const other of others) {
      const ratio = labDistance(candidate.lab, other.candidate.lab) / targetFor(spec, plan, day, other.plan, other.day);
      if (ratio < worst) worst = ratio;
      // Capped so an already-comfortable pair cannot outvote a tight one.
      total += Math.min(ratio, 3);
    }
    return [worst, total];
  };
  const worstOverall = () => {
    const all = placed();
    let worst = Infinity;
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const target = targetFor(spec, all[i].plan, all[i].day, all[j].plan, all[j].day);
        worst = Math.min(worst, labDistance(all[i].candidate.lab, all[j].candidate.lab) / target);
      }
    }
    return worst;
  };

  for (let sweep = 0; sweep < 50; sweep += 1) {
    let improved = false;
    for (let plan = 0; plan < plans.length; plan += 1) {
      for (let day = 1; day < spec.period; day += 1) {
        const others = placed().filter(item => !(item.plan === plan && item.day === day));
        let best = chosen[plan][day];
        let score = slotScore(plan, day, best, others);
        for (const candidate of plans[plan].pool) {
          const value = slotScore(plan, day, candidate, others);
          if (improves(value, score)) { score = value; best = candidate; improved = true; }
        }
        chosen[plan][day] = best;
      }
    }
    let overall = worstOverall();
    for (let plan = 0; plan < plans.length; plan += 1) {
      for (let i = 1; i < spec.period; i += 1) {
        for (let j = i + 1; j < spec.period; j += 1) {
          [chosen[plan][i], chosen[plan][j]] = [chosen[plan][j], chosen[plan][i]];
          const value = worstOverall();
          if (value > overall + 1e-9) { overall = value; improved = true; }
          else [chosen[plan][i], chosen[plan][j]] = [chosen[plan][j], chosen[plan][i]];
        }
      }
    }
    if (!improved) break;
  }
  return chosen.map(row => row.map(candidate => candidate.hex));
}

/**
 * The ladder for one colour that is not in the palette.
 *
 * A hand-picked `layer.color` still has to work — agents and saved maps carry
 * arbitrary hex, including the two hues dropped from `LAYER_PALETTE` — so it gets
 * the same treatment on demand, repelled from every baked palette shade so it
 * separates from the automatic ones too.
 *
 * Unlike the palette, this ladder is allowed to be *shorter* than `period`. The
 * palette's colours were chosen partly because they can hold twelve shades;
 * an arbitrary one may not — a dark, low-chroma or near-grey colour simply has
 * less room. Stopping when the next rung would fall below the adjacent target
 * keeps the promise that consecutive days look different, at the cost of
 * repeating sooner. Padding to twelve instead would break the promise on every
 * map that used the colour, which is the worse trade: a repeat is a shade the
 * reader has seen before, a crowded pair is two days they cannot tell apart.
 */
export function buildDayLadder(base: string, avoid: readonly Lab[] = [], spec: LadderSpec = LADDER): string[] {
  const hsl = toHsl(base);
  if (!hsl) return [base];
  // A coarser grid than the palette's own solve uses. This runs on a render
  // path — a caller's custom `layer.color` is discovered when the map is drawn —
  // so it has to finish in well under a frame's worth of patience, and the fine
  // grid took seconds. Two-degree hue and two-point lightness steps are far
  // below the ΔE thresholds being enforced, so the extra resolution bought
  // nothing measurable.
  const pool = candidates(base, spec, 2);
  if (pool.length === 0) {
    return [onBasemap(hsl.h, hsl.s, clamp(hsl.l, spec.lightFloor, lightnessCeiling(base)))];
  }
  const anchor = toLab(toHex(hsl.h, hsl.s, clamp(hsl.l, spec.lightFloor, lightnessCeiling(base))));
  let seed = pool[0];
  let nearest = Infinity;
  for (const candidate of pool) {
    const distance = labDistance(candidate.lab, anchor);
    if (distance < nearest) { nearest = distance; seed = candidate; }
  }
  const period = Math.min(spec.period, pool.length);
  /**
   * Each candidate's standing preference for being far from the palette's own
   * shades, computed once.
   *
   * Distance from the palette is a preference, not a gate — there are 120 baked
   * shades, and treating each as a hard minimum leaves some hues (teal, which
   * holds ten rungs on its own) with almost no legal shade at all. A plan is
   * read by its own days; keeping Cartula's *assigned* colours apart is what the
   * palette order already handles.
   *
   * Precomputed because it does not depend on which days are chosen, and folding
   * it into the inner loop instead cost 120 extra distance calculations per
   * candidate per sweep — about 160M operations, which is the difference between
   * this returning in a moment and locking the tab for a minute.
   */
  const affinity = new Map<Candidate, number>();
  for (const candidate of pool) {
    let total = 0;
    for (const other of avoid) total += Math.min(labDistance(other, candidate.lab) / spec.crossTarget, 3);
    affinity.set(candidate, total);
  }
  /**
   * How good a candidate is as the next rung of `seq`: the worst of its
   * normalised distances, with the sum only as a tie-break.
   *
   * Both of the pairs that will be *consecutive* are held to the adjacent
   * target — the day before it, and day 1, which it is drawn next to when a plan
   * runs past the period and wraps.
   */
  const score = (candidate: Candidate, seq: readonly Candidate[]): Score => {
    let worst = Infinity;
    let total = affinity.get(candidate) ?? 0;
    for (let i = 0; i < seq.length; i += 1) {
      const target = i === seq.length - 1 || i === 0 ? spec.adjacentTarget : spec.anyTarget;
      const ratio = labDistance(seq[i].lab, candidate.lab) / target;
      if (ratio < worst) worst = ratio;
      total += Math.min(ratio, 3);
    }
    return [worst, total];
  };

  /**
   * A rung is admissible after `against` if it clears the *acceptance*
   * separation (25, not the generator's slightly higher aim) from both of its
   * neighbours, and 12 from every other day.
   *
   * Its neighbours are the day before it **and day 1**: the ladder is a cycle,
   * so the last rung is drawn next to the first on a plan that runs past the
   * period. Missing that wrap is what let `#65a30d` close at ΔE 20.1 while every
   * pair inside the array cleared 25.
   */
  const admissible = (candidate: Candidate, against: readonly Candidate[]) => {
    if (labDistance(against[against.length - 1].lab, candidate.lab) < 25) return false;
    if (labDistance(against[0].lab, candidate.lab) < 25) return false;
    return against.every(day => labDistance(day.lab, candidate.lab) >= 12);
  };
  /**
   * Grow a cycle greedily from a given second rung.
   *
   * Only *admissible* candidates are ranked. Ranking first and rejecting the
   * winner afterwards ends the ladder early whenever the best-scoring candidate
   * happens to be inadmissible even though usable ones remain — that cost
   * `#c026d3` eight of its twelve rungs.
   */
  const grow = (second: Candidate): Candidate[] => {
    const seq = [seed, second];
    while (seq.length < period) {
      let best: Candidate | undefined;
      let value: Score = [-Infinity, -Infinity];
      for (const candidate of pool) {
        if (!admissible(candidate, seq)) continue;
        const next = score(candidate, seq);
        if (improves(next, value)) { value = next; best = candidate; }
      }
      if (!best) break;
      seq.push(best);
    }
    return seq;
  };
  /**
   * Day 1 is pinned to the caller's colour, and a greedy pick for day 2 then
   * decides how much room is left for everything after it — in a cycle where
   * every rung needs 25 from *two* neighbours that matters a lot. `#65a30d`
   * stopped at two rungs this way while admissible three-rung cycles existed.
   *
   * So the second rung is *chosen by outcome*: try each admissible candidate for
   * it, keep whichever produces the longest ladder, and break ties on the
   * minimax score. That is a full re-grow per attempt rather than a search over
   * every later slot, which keeps this linear enough for a render path — a
   * caller's custom colour is discovered while the map is being drawn.
   */
  const chosen = ((): Candidate[] => {
    const seeds = pool.filter(candidate => admissible(candidate, [seed]));
    if (seeds.length === 0) return [seed];
    let best = grow(seeds[0]);
    let bestScore = cycleScore(best, affinity, spec);
    for (const candidate of seeds.slice(1)) {
      const attempt = grow(candidate);
      const attemptScore = cycleScore(attempt, affinity, spec);
      // Longer wins outright: a longer cycle is fewer repeats for the reader.
      // Equal length falls back to the minimax score, so the choice is fully
      // determined and reproducible.
      if (attempt.length > best.length
        || (attempt.length === best.length && improves(attemptScore, bestScore))) {
        best = attempt;
        bestScore = attemptScore;
      }
    }
    return best;
  })();
  // Same improvement pass, on this one ladder. `feasible` keeps it from trading
  // the acceptance floor away: the pass may only move to arrangements that still
  // satisfy 25 between consecutive days and 12 between any two.
  const ladderScore = (): Score => {
    let worst = Infinity;
    let total = 0;
    for (let i = 0; i < chosen.length; i += 1) {
      for (let j = i + 1; j < chosen.length; j += 1) {
        const gap = Math.min(j - i, chosen.length - (j - i));
        const target = gap === 1 ? spec.adjacentTarget : spec.anyTarget;
        const ratio = labDistance(chosen[i].lab, chosen[j].lab) / target;
        if (ratio < worst) worst = ratio;
        total += Math.min(ratio, 3);
      }
      total += affinity.get(chosen[i]) ?? 0;
    }
    return [worst, total];
  };
  /**
   * Whether the ladder as it stands meets the acceptance floors.
   *
   * `gap` is the *cyclic* distance between two days, so the pair that closes the
   * cycle — last rung against day 1 — is checked as the consecutive pair it is.
   * This is what keeps the improvement pass below from re-introducing the seam
   * the growth loop above just avoided.
   */
  const feasible = (): boolean => {
    for (let i = 0; i < chosen.length; i += 1) {
      for (let j = i + 1; j < chosen.length; j += 1) {
        const gap = Math.min(j - i, chosen.length - (j - i));
        const distance = labDistance(chosen[i].lab, chosen[j].lab);
        if (distance < (gap === 1 ? 25 : 12)) return false;
      }
    }
    return true;
  };
  let current = ladderScore();
  for (let sweep = 0; sweep < 30; sweep += 1) {
    let improved = false;
    for (let slot = 1; slot < chosen.length; slot += 1) {
      const held = chosen[slot];
      let best = held;
      for (const candidate of pool) {
        chosen[slot] = candidate;
        const value = ladderScore();
        if (feasible() && improves(value, current)) { current = value; best = candidate; improved = true; }
      }
      chosen[slot] = best;
    }
    for (let i = 1; i < chosen.length; i += 1) {
      for (let j = i + 1; j < chosen.length; j += 1) {
        [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
        const value = ladderScore();
        if (feasible() && improves(value, current)) { current = value; improved = true; }
        else [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
      }
    }
    if (!improved) break;
  }
  return chosen.map(candidate => candidate.hex);
}

/* ------------------------------------------------------------------ the lookup */

/**
 * The ladders `buildPaletteLadders(LAYER_PALETTE)` produces, written down.
 *
 * The generator is the source of truth for *how* these are chosen, and
 * `tests/day-colors.test.ts` re-runs it and asserts this table still matches —
 * so the rule cannot drift away from the values without a test failing. They
 * are baked rather than computed at import because the search takes most of a
 * second, and every stop and every leg on the map asks for a colour: paying
 * that on load, in every embedded card, to rediscover a constant would be the
 * wrong trade.
 *
 * Keys are the palette entries, lower-cased.
 */
export const PALETTE_LADDERS: Readonly<Record<string, readonly string[]>> = {
  '#2563eb': ['#1f62ea', '#1c409b', '#0646f9', '#1c519b', '#053bc7', '#7c9ee9', '#0e39aa', '#297ffa', '#065af9', '#2267c9', '#92bcf6', '#5e91f7'],
  '#e11d48': ['#e11e49', '#db5c7a', '#9c1b2b', '#f20d28', '#f75f71', '#ad0b1e', '#f4497c', '#e99ba4', '#d31229', '#f78290', '#b90e44', '#f891b2'],
  '#16a34a': ['#19a34a', '#0dbf25', '#229652', '#0fe071', '#28b379', '#2cc44b', '#26d38f', '#0fe052', '#1cc56b', '#229668', '#17a129', '#0dde29'],
  '#f59e0b': ['#f49d0b', '#e2b660', '#ecbe09', '#b7800b', '#dcc241', '#ae630a', '#a48b13', '#df9853', '#c79f05', '#d15c05', '#f8b844', '#9b721c'],
  '#7c3aed': ['#7d3bed', '#a486e9', '#581c9b', '#cea5fd', '#4606db', '#9d60e2', '#5d07c5', '#9460fb', '#8824f9', '#bb83fc', '#5c22b9', '#d4b7f6'],
  '#0891b2': ['#0690b1', '#15a7f9', '#08d9d7', '#106ca8', '#06d5f4', '#1091cb', '#1c939b', '#06b9f9', '#12b9c4', '#1c749b', '#51bfe6', '#0883d4'],
  '#db2777': ['#dd2878', '#ebb2c6', '#a22a6b', '#f287c0', '#b11556', '#f269b4', '#eb1462', '#d96e94', '#ef3e9e', '#91264b', '#f15f94', '#f7a6d1'],
  '#ea580c': ['#ea570b', '#ecb498', '#cf5726', '#f94106', '#a63511', '#e37a26', '#fcb379', '#fa6b3d', '#e38364', '#c73405', '#f5974d', '#fba489'],
  '#4f46e5': ['#5047e6', '#bdbff0', '#100ff0', '#878be3', '#1b219c', '#afadfa', '#0f17c8', '#8975f5', '#5335f3', '#5d55d8', '#1110a7', '#6e73dd'],
  '#b45309': ['#b45308', '#f99462', '#f97624', '#fbb05b', '#f98706', '#e4986c', '#f89a35', '#9b601c', '#ed7940', '#9b471c', '#cf8026', '#e9bb86'],
};

/** Lab positions of every baked shade — what a custom colour is repelled from. */
let paletteAvoid: Lab[] | undefined;
function avoidList(): Lab[] {
  paletteAvoid ??= Object.values(PALETTE_LADDERS).flatMap(ladder => ladder.map(toLab));
  return paletteAvoid;
}

/** Ladders for colours outside the palette, so a custom plan colour is built once. */
const customLadders = new Map<string, string[]>();

/**
 * The ladder for one plan colour: the baked one where the colour came from the
 * palette, otherwise built on demand and repelled from every palette shade, so
 * a hand-picked colour still separates from the automatic ones.
 */
export function dayLadder(base: string): readonly string[] {
  const key = base.trim().toLowerCase();
  const known = PALETTE_LADDERS[key];
  if (known) return known;
  const cached = customLadders.get(key);
  if (cached) return cached;
  const built = buildDayLadder(base, avoidList());
  customLadders.set(key, built);
  return built;
}

/**
 * The colour of day `day` within the plan whose colour is `base`.
 *
 * Day numbers past the ladder's period reuse it. That is a real limit, not a
 * rounding: the palette's hues sit close enough together that squeezing a
 * seventh distinct shade out of one of them would put it within ΔE 15 of a
 * neighbouring plan, and a repeated shade *inside* one plan — where the list
 * numbers and dates every stop anyway — costs the reader far less than a shade
 * that lies about which plan a line belongs to.
 *
 * A colour Cartula cannot parse comes back unchanged rather than guessed at.
 */
export function planDayColorFrom(base: string, day: number): string {
  if (!toHsl(base)) return base;
  const ladder = dayLadder(base);
  return ladder[(Math.max(1, Math.round(day)) - 1) % ladder.length];
}

/**
 * The lowest contrast an unselected plan may keep against the basemap.
 *
 * Well under `MIN_BASEMAP_CONTRAST`: that floor is what a line the user is
 * *reading* needs, and a backdrop route is deliberately weaker than that. It
 * still has a floor, because "recede" is not "disappear" — an alternative the
 * eye cannot find is the same as one that was never drawn.
 */
export const MIN_BACKDROP_CONTRAST = 1.28;

/**
 * The same plan colour, seen through frosted glass.
 *
 * Only two of the three HSL components move. Hue stays exactly where it was,
 * so a backdrop line still says which plan it belongs to and matches its own
 * card in the switcher; chroma and lightness are what carry "this one is not
 * the one you are looking at". The fade is tried from strongest to weakest and
 * the first candidate that still clears `MIN_BACKDROP_CONTRAST` wins, which
 * matters for the pale end of the palette: on Cartula's near-white basemap
 * lightening is the direction that destroys contrast, so a colour that starts
 * light gets a gentler fade rather than a prettier ratio.
 *
 * Lightness does nearly all the receding, and chroma is given up sparingly on
 * purpose. Three plans on one map means two backdrops, and draining them both
 * of colour makes them each other's twin — measurably: at the fade this used
 * to apply, the closest pair of palette colours came out ΔE 9.7 apart, against
 * 13.7 now, while the distance from a plan to its own backdrop is unchanged.
 *
 * A colour Cartula cannot parse comes back as a neutral grey instead of being
 * passed through: an unparsed colour drawn at full strength would out-shout the
 * plan the user actually selected.
 */
export function backdropColor(base: string): string {
  const hsl = toHsl(base);
  if (!hsl) return '#b4bdb3';
  for (const fade of [0.62, 0.5, 0.38, 0.26, 0.14]) {
    const candidate = toHex(hsl.h, hsl.s * (1 - fade * 0.5), hsl.l + (92 - hsl.l) * fade);
    if (basemapContrast(candidate) >= MIN_BACKDROP_CONTRAST) return candidate;
  }
  // Nothing lighter survives the floor (a colour already paler than the
  // basemap): keep the hue and drop chroma alone.
  return toHex(hsl.h, hsl.s * 0.45, hsl.l);
}

/** Every day number a layer's stops mention, ascending — the legend's rows. */
export function layerDays(layer: Pick<MapLayer, 'points'>): number[] {
  const days = new Set<number>();
  for (const point of layer.points) if (point.day != null && point.day > 0) days.add(Math.round(point.day));
  return [...days].sort((a, b) => a - b);
}
