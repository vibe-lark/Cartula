/**
 * Leg annotations: transport mode, distance and travel time BETWEEN two
 * consecutive stops, as drawable pill text. Pure functions shared by the
 * deck.gl canvas, the SVG fallback and the sidebar — no React, no I/O.
 *
 * The same honesty rules as the core model apply:
 *  - A distance Cartula computed itself (great-circle) always carries the
 *    suffix 直线; a caller-supplied routing distance is marked 路由 unless a
 *    transport-mode word already says a router produced it.
 *  - Travel time is shown only when the caller supplied it; it is never
 *    derived from distance.
 */
import type { Coord, MapLayer, MapPoint } from '../../core/types.js';
import { haversineKm } from '../../core/geo.js';
import { layerStats } from '../../core/model.js';
import { backdropColor, layerDays, planDayColorFrom } from './dayColors.js';
import { isValidCoord, pathMidpoint, type RouteSegment } from './geo.js';

export { backdropColor, layerDays };

/** Display mode for the on-map leg annotations. */
export type LegLabelMode = 'auto' | 'all' | 'off';

/** Identifies one leg between two adjacent stops of a layer. */
export interface LegRef {
  layerId: string;
  fromPointId: string;
  toPointId: string;
}

export const formatDistance = (value: number) =>
  value < 1 ? `${Math.round(value * 1000)} m` : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} km`;

export function formatDuration(minutes: number) {
  const total = Math.round(minutes);
  return total < 60 ? `${total} 分钟` : `${Math.floor(total / 60)} 小时${total % 60 ? ` ${total % 60} 分钟` : ''}`;
}

/** `formatDuration` without its spaces: 10小时50分 where the line has no room for 10 小时 50 分钟. */
export function compactDuration(minutes: number) {
  const total = Math.round(minutes);
  return total < 60 ? `${total}分` : `${Math.floor(total / 60)}小时${total % 60 ? `${total % 60}分` : ''}`;
}

export type TransportKind = 'driving' | 'walking' | 'cycling' | 'transit' | 'flight' | 'train' | 'ferry';

/** Transport-mode words we recognise, rendered as short Chinese labels. */
const MODE_KINDS: Record<string, TransportKind> = {
  driving: 'driving',
  car: 'driving',
  walking: 'walking',
  foot: 'walking',
  cycling: 'cycling',
  bike: 'cycling',
  bicycle: 'cycling',
  transit: 'transit',
  bus: 'transit',
  flight: 'flight',
  plane: 'flight',
  train: 'train',
  rail: 'train',
  ferry: 'ferry',
};

const MODE_LABELS: Record<TransportKind, string> = {
  driving: '驾车',
  walking: '步行',
  cycling: '骑行',
  transit: '公交',
  flight: '航班',
  train: '火车',
  ferry: '轮渡',
};

/**
 * What a routing provider's `durationMinutes` actually measures: time in
 * motion for that transport mode. It contains no sightseeing, meals, parking
 * or overnight stops, so the label says so instead of calling it a trip time.
 */
const TRAVEL_TIME_LABELS: Record<TransportKind, string> = {
  driving: '纯驾驶时间',
  walking: '纯步行时间',
  cycling: '纯骑行时间',
  transit: '纯乘车时间',
  flight: '纯飞行时间',
  train: '纯乘车时间',
  ferry: '纯乘船时间',
};

/** Duration wording for a routing profile; unknown modes stay generic. */
export function travelTimeLabel(profile: string | undefined): string {
  const kind = transportKind(profile);
  return kind ? TRAVEL_TIME_LABELS[kind] : '纯移动时间';
}

/**
 * The transport mode a route total describes: the layer profile when it has
 * one, otherwise the legs' own profile when every leg agrees. Mixed or missing
 * modes stay undefined — a total is never labelled as driving just because
 * driving is the common case.
 */
export function layerTravelProfile(layer: Pick<MapLayer, 'routing'>): string | undefined {
  const declared = layer.routing?.profile?.trim();
  if (declared) return declared;
  const legs = layer.routing?.legs ?? [];
  const profiles = new Set(legs.map(leg => leg.profile?.trim()).filter((value): value is string => Boolean(value)));
  return profiles.size === 1 && legs.every(leg => leg.profile?.trim()) ? [...profiles][0] : undefined;
}

/** Always shown next to a routing duration, so it is never read as a day plan. */
export const TRAVEL_TIME_NOTE = '不含游览、用餐、休息与住宿';

/** Canonical transport kind for a routing profile. Unknown / absent → undefined. */
export function transportKind(profile: string | undefined): TransportKind | undefined {
  const raw = profile?.trim().toLowerCase();
  if (!raw) return undefined;
  return MODE_KINDS[raw];
}

/**
 * Chinese label for a routing profile string. Known values map to short
 * labels; anything else is shown trimmed and capped so a long free-form
 * profile cannot blow up the pill (or the text atlas). Absent → undefined:
 * a mode is never inferred.
 */
export function legModeLabel(profile: string | undefined): string | undefined {
  const raw = profile?.trim();
  if (!raw) return undefined;
  const known = transportKind(raw);
  if (known) return MODE_LABELS[known];
  const chars = [...raw];
  return chars.length > 10 ? `${chars.slice(0, 10).join('')}…` : raw;
}

/** One drawable annotation for the leg between two adjacent stops. */
export interface LegAnnotation extends LegRef {
  from: MapPoint;
  to: MapPoint;
  /** Geographic midpoint of the two stops — the pill anchor. */
  anchor: Coord;
  /** Pill text, e.g. 驾车 · 325 km · 4 小时 5 分钟 or 128 km 直线. */
  text: string;
  /** Spoken/hover sentence with provenance, e.g. 从哈尔滨至伊春：…（距离为路由数据）. */
  ariaText: string;
  warn: boolean;
  /** Auto-mode always shows this pill: longest, border, closure, heavy traffic or warn. */
  important: boolean;
  /** Visual theme color for this leg (custom leg.color > day shade > layer.color). */
  color: string;
  day?: number;
}

/**
 * A line on the map carries two identities at once: which plan it belongs to,
 * and which day of that plan it covers. Hue carries the plan — the colour the
 * caller set on the layer — while a ladder of lightness and saturation steps
 * inside that hue carries the day.
 *
 * The ladder itself, and the reasoning behind its floors and its period, live
 * in `dayColors.ts`; `planDayColor` is the lookup this module needs.
 */
export function planDayColor(base: string, day: number): string {
  return planDayColorFrom(base, day);
}

/**
 * Whether day shading applies to this layer at all. One day — or none — has
 * nothing to separate, so the plan keeps exactly the colour the caller set
 * instead of being redrawn in a shade of it.
 */
function shadesDays(layer: Pick<MapLayer, 'points'>, mode: RouteColorMode): boolean {
  return mode === 'day' && layerDays(layer).length > 1;
}

/**
 * How route geometry is coloured.
 *
 * `day` — the default — keeps each plan's own hue and separates the days
 * inside it by shade, so which plan a line belongs to and which day it covers
 * are both readable at a glance. `layer` flattens every plan to one colour,
 * for comparing whole alternatives without the day detail. Either way road
 * conditions keep their own reserved hues, so a shade is never mistaken for a
 * jam or a closure.
 */
export type RouteColorMode = 'day' | 'layer';

/**
 * A leg's display colour:
 * 1. explicit per-segment colour, then explicit `leg.color`
 * 2. the day shade of `layer.color` — only in `day` mode
 * 3. `layer.color`
 *
 * There is deliberately no positional palette fallback: a route with several
 * stops and no day numbers used to come out rainbow-coloured even though the
 * caller had set a single layer colour.
 */
export function segmentColor(
  seg: { color?: string; fromPointId?: string; toPointId?: string },
  layer: MapLayer,
  mode: RouteColorMode = 'day'
): string {
  const leg = layer.routing?.legs?.find(l => l.fromPointId === seg.fromPointId && l.toPointId === seg.toPointId);
  // Some callers copied the layer colour into every leg while trying to
  // disable the old positional palette. That value carries no extra
  // information: in day mode it must not mask the date distinction the user
  // asked for. A genuinely different per-leg colour remains an explicit
  // override in either mode.
  const explicit = seg.color ?? leg?.color;
  if (explicit && !(mode === 'day' && explicit === layer.color)) return explicit;
  if (shadesDays(layer, mode)) {
    const fromPoint = layer.points.find(p => p.id === seg.fromPointId);
    if (fromPoint?.day != null && fromPoint.day > 0) return planDayColor(layer.color, fromPoint.day);
  }
  return layer.color;
}

/** A stop's display colour under the current colour mode. */
export function pointColor(point: { day?: number }, layer: Pick<MapLayer, 'color' | 'points'>, mode: RouteColorMode = 'day'): string {
  return shadesDays(layer, mode) && point.day != null && point.day > 0 ? planDayColor(layer.color, point.day) : layer.color;
}

/**
 * Why a stretch of road is drawn differently from the rest of its route.
 *
 * These are not interchangeable, and the map must not imply the strong ones
 * from the weak ones:
 *  - `closed` / `congested` / `slow` are traffic facts a caller supplied.
 *  - `avoid` is the user's instruction, waiting for the agent to re-route.
 *  - `reminder` is a note on one of the two stops (a season warning, say). It
 *    is *not* a road condition, so it keeps the route colour.
 * `traffic: 'unknown'` produces none of these — an absent measurement is not
 * a measurement of "clear".
 */
export type SegmentRisk = 'none' | 'reminder' | 'avoid' | 'slow' | 'congested' | 'closed';

/** Road conditions get their own hues; nothing else borrows them. */
export const RISK_COLORS: Record<Exclude<SegmentRisk, 'none' | 'reminder'>, string> = {
  slow: '#c47a12',
  congested: '#c2410c',
  closed: '#7f1d1d',
  avoid: '#6b7280',
};

export const RISK_LABELS: Record<SegmentRisk, string> = {
  none: '按图层颜色绘制',
  reminder: '地点有提醒（不代表路况）',
  avoid: '你要求避开，待 Agent 重算',
  slow: '路况：缓行',
  congested: '路况：拥堵',
  closed: '路况：封闭',
};

export function segmentRisk(seg: Pick<RouteSegment, 'warn' | 'reminder' | 'traffic' | 'avoid'>): SegmentRisk {
  if (seg.traffic === 'closed') return 'closed';
  if (seg.avoid) return 'avoid';
  if (seg.traffic === 'heavy') return 'congested';
  if (seg.traffic === 'moderate') return 'slow';
  // `warn` without a reason of its own is a stop reminder, not a road state.
  return seg.reminder || seg.warn ? 'reminder' : 'none';
}

export interface SegmentStyle {
  color: string;
  /** Dashed = "do not read this as a normal, confirmed stretch". */
  dashed: boolean;
  risk: SegmentRisk;
}

/**
 * Colour and stroke for one drawn segment. A stop-level reminder keeps the
 * route colour (dashed) so a seasonal note can never be mistaken for a known
 * closure or jam.
 */
export function segmentStyle(seg: RouteSegment, layer: MapLayer, mode: RouteColorMode = 'day'): SegmentStyle {
  const risk = segmentRisk(seg);
  const base = segmentColor(seg, layer, mode);
  if (risk === 'none') return { color: base, dashed: false, risk };
  if (risk === 'reminder') return { color: base, dashed: true, risk };
  return { color: RISK_COLORS[risk], dashed: risk === 'closed' || risk === 'avoid', risk };
}

/* ------------------------------------------------- comparing whole plans */

/**
 * How opaque a route line is drawn, 0–255.
 *
 * With one plan on the map there is nothing to compare and everything is drawn
 * at `selected`. With several, exactly one of them is the answer to the
 * question the user is currently asking and the rest are the alternatives it is
 * being judged against — so they are drawn as a backdrop instead of being
 * hidden, which is the whole point of putting them on the same map.
 */
export const ROUTE_OPACITY = {
  /** The plan being worked on, and every plan when only one is visible. */
  selected: 235,
  /** An unselected plan: still readable, never competing for the eye. */
  backdrop: 140,
  /** The pointer is on it — it answers before it is clicked. */
  backdropHover: 210,
  /**
   * A closure or a jam on an unselected plan. Faded like the rest of its
   * route, but not as far: a road fact is why someone would switch to — or
   * away from — that alternative, so it must survive the fade.
   */
  backdropRisk: 190,
} as const;

/** Line width in pixels, by the same rule. */
export const ROUTE_WIDTH = { selected: 6, backdrop: 4 } as const;

/**
 * The same segment, drawn as a backdrop rather than as the answer.
 *
 * Colour, dash and risk keep their meanings — this only decides how loudly
 * they are said. `hovered` is the preview state: pointing at a backdrop route
 * brings it most of the way back, so a plan can be examined before the click
 * that switches to it.
 */
export function backdropSegmentStyle(style: SegmentStyle, hovered = false): { color: string; dashed: boolean; alpha: number } {
  const road = style.risk !== 'none' && style.risk !== 'reminder';
  return {
    color: backdropColor(style.color),
    dashed: style.dashed,
    alpha: hovered ? ROUTE_OPACITY.backdropHover : road ? ROUTE_OPACITY.backdropRisk : ROUTE_OPACITY.backdrop,
  };
}

/**
 * A plan's name, cut down to what fits on a chip on top of a map.
 *
 * Plans are routinely named for what they cover — 小兴安岭线：哈尔滨—黑河,
 * 方案 A：山路多一点 — and the part before the colon is the name people use for
 * it; the rest is a description that the panels have room for and a chip does
 * not. Anything still too long is cut with an ellipsis, which at least says
 * that something was removed instead of pretending that is the whole name.
 */
export function planChipName(name: string, limit = 8): string {
  const head = name.split(/[：:]/)[0]?.trim();
  const chosen = head && [...head].length <= limit ? head : name.trim();
  const chars = [...chosen];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chosen;
}

/**
 * One line naming an unselected plan, for the chip that switches to it.
 *
 * Short on purpose: this sits on the map, next to the stretch that makes the
 * plan different, and it is a switch rather than a report — the panels are
 * where a plan is read in full. The same provenance rules still hold, so a
 * distance Cartula estimated itself keeps its 直线 marker here too.
 */
export function planSummary(layer: MapLayer): string {
  const stats = layerStats(layer);
  const parts = [planChipName(layer.name)];
  if (stats?.routingDistanceKm !== undefined) parts.push(formatDistance(stats.routingDistanceKm));
  else if (stats?.distanceKm) parts.push(`${formatDistance(stats.distanceKm)}${stats.distanceKind === 'straight' ? ' 直线' : ''}`);
  if (stats?.durationMinutes !== undefined) parts.push(formatDuration(stats.durationMinutes));
  return parts.join(' · ');
}

/**
 * Build the annotations of every route layer: one per consecutive point
 * pair. Pairs with neither routing metrics nor a meaningful straight-line
 * distance (< 50 m, i.e. duplicate coordinates) are skipped.
 *
 * Mode resolves per leg first, then the layer-wide `routing.profile`.
 */
export function buildLegAnnotations(layers: MapLayer[], colorMode: RouteColorMode = 'day'): LegAnnotation[] {
  const out: LegAnnotation[] = [];
  for (const layer of layers) {
    if (layer.kind !== 'route') continue;
    const points = layer.points ?? [];
    const layerLegs: LegAnnotation[] = [];
    let longest: LegAnnotation | undefined;
    let longestKm = -1;
    for (let i = 1; i < points.length; i += 1) {
      const from = points[i - 1];
      const to = points[i];
      const leg = layer.routing?.legs?.find((part) => part.fromPointId === from.id && part.toPointId === to.id);
      const mode = legModeLabel(leg?.profile ?? layer.routing?.profile);
      const routedDistance = leg?.distanceKm !== undefined;
      const distanceKm = routedDistance ? leg.distanceKm! : haversineKm(from.at, to.at);
      const hasDuration = leg?.durationMinutes !== undefined;
      if (!leg && distanceKm < 0.05) continue;

      const parts: string[] = [];
      if (mode) parts.push(mode);
      // A mode word already asserts a router produced the number, so the
      // 路由 suffix is only needed without one. 直线 can never be dropped:
      // that distance is Cartula's own great-circle estimate.
      parts.push(routedDistance ? (mode ? formatDistance(distanceKm) : `${formatDistance(distanceKm)} 路由`) : `${formatDistance(distanceKm)} 直线`);
      if (hasDuration) parts.push(formatDuration(leg!.durationMinutes!));
      if (leg?.delayMinutes) parts.push(`延误 ${formatDuration(leg.delayMinutes)}`);
      if (leg?.border) parts.push('边境');
      if (leg?.toll) parts.push('收费');
      if (leg?.tunnel) parts.push('隧道');
      // Traffic words come from the caller's data only; `unknown` says nothing.
      if (leg?.traffic === 'heavy') parts.push('拥堵');
      else if (leg?.traffic === 'moderate') parts.push('缓行');
      if (leg?.closed || leg?.traffic === 'closed') parts.push('封路');

      const warn = Boolean(from.warn || to.warn);
      const important = Boolean(warn || leg?.border || leg?.closed || leg?.delayMinutes || leg?.traffic === 'heavy' || leg?.traffic === 'closed');
      const text = `${warn ? '⚠ ' : ''}${parts.join(' · ')}`;
      // Provenance stays mode-neutral here; the panels name the travel-time
      // kind (`travelTimeLabel`) where there is room to explain the exclusion.
      const provenance = [`距离为${routedDistance ? '路由数据' : '直线估算'}`];
      if (hasDuration) provenance.push('时间为路由数据');
      const path = (leg?.path ?? []).filter(isValidCoord);
      const legColor = segmentColor({ color: leg?.color, fromPointId: from.id, toPointId: to.id }, layer, colorMode);
      const item: LegAnnotation = {
        layerId: layer.id,
        fromPointId: from.id,
        toPointId: to.id,
        from,
        to,
        anchor: path.length >= 2 ? pathMidpoint(path)! : [(from.at[0] + to.at[0]) / 2, (from.at[1] + to.at[1]) / 2],
        text,
        ariaText: `从${from.name}至${to.name}：${parts.join('，')}（${provenance.join('，')}）`,
        warn,
        important,
        color: legColor,
        day: from.day,
      };
      if (distanceKm > longestKm) { longestKm = distanceKm; longest = item; }
      layerLegs.push(item);
    }
    if (longest) longest.important = true;
    out.push(...layerLegs);
  }
  return out;
}

export const legKey = (ref: LegRef): string => `${ref.layerId} ${ref.fromPointId}->${ref.toPointId}`;
