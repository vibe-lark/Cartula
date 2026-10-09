/**
 * Rendering helpers for the map canvases.
 *
 * Scope: geometry and colour needed to *draw* a map. The data model
 * (normalize / applyOperations / stats) lives in `src/core/model.ts` and is not
 * duplicated here. Distances come from `src/core/geo.ts`.
 *
 * No I/O and no host globals beyond the optional read-only `__CARTULA_CONFIG__`.
 */
import type { Coord, FeatureCollection, MapLayer, TrafficState } from '../../core/types.js';
import { haversineKm } from '../../core/geo.js';

/** Optional host-supplied basemap configuration. Read-only; never written. */
declare global {
  interface Window {
    __CARTULA_CONFIG__?: {
      tileUrl?: string;
      styleUrl?: string;
      tileAttribution?: string;
      tileMaxZoom?: number;
      /** Where Cartula itself answers, for assets an opaque frame cannot reach by a relative path. */
      publicUrl?: string;
    };
  }
}

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const DEFAULT_TILE_ATTRIBUTION = '© OpenStreetMap 贡献者';

export interface BasemapConfig {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
}

export function readBasemapConfig(): BasemapConfig {
  const cfg = typeof window === 'undefined' ? undefined : window.__CARTULA_CONFIG__;
  const url = typeof cfg?.tileUrl === 'string' ? cfg.tileUrl.trim() : '';
  const attr = typeof cfg?.tileAttribution === 'string' ? cfg.tileAttribution.trim() : '';
  const maxZoom = typeof cfg?.tileMaxZoom === 'number' && cfg.tileMaxZoom > 0 ? cfg.tileMaxZoom : 19;
  return {
    tileUrl: url || DEFAULT_TILE_URL,
    attribution: attr || DEFAULT_TILE_ATTRIBUTION,
    maxZoom,
  };
}

/**
 * Where a card's picture is fetched from: Cartula's image proxy, never the
 * picture's own host — `src/server/images.ts` says why. The path is relative
 * when the page is served by Cartula itself, and absolute against
 * `publicUrl` inside an opaque App frame or an exported page, where a
 * relative path resolves to nowhere. Anything that is not an `https:` URL
 * yields nothing, so the card simply has no picture.
 */
export function imageProxyUrl(url?: string): string | undefined {
  if (!url || !/^https:\/\/\S+$/.test(url)) return undefined;
  const cfg = typeof window === 'undefined' ? undefined : window.__CARTULA_CONFIG__;
  const base = typeof cfg?.publicUrl === 'string' ? cfg.publicUrl.trim().replace(/\/+$/, '') : '';
  let prefix = base;
  try {
    if (base && typeof location !== 'undefined' && new URL(base).origin === location.origin) prefix = '';
  } catch { /* keep the absolute form */ }
  return `${prefix}/img?u=${encodeURIComponent(url)}`;
}

/* ------------------------------------------------------------------ colour */

/** Stops that carry a reminder are always this red — never the layer hue. */
export const WARN_COLOR = '#c62828';

export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const raw = String(hex ?? '').trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full.slice(0, 6)) || full.length < 6) return [90, 90, 90, alpha];
  const n = Number.parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/* ---------------------------------------------------------------- geometry */

export function isValidCoord(c: unknown): c is Coord {
  return (
    Array.isArray(c) &&
    c.length >= 2 &&
    typeof c[0] === 'number' &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    Math.abs(c[0]) <= 180 &&
    Math.abs(c[1]) <= 90
  );
}

export interface Bounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export function boundsOf(coords: Coord[]): Bounds | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let found = false;
  for (const c of coords) {
    if (!isValidCoord(c)) continue;
    found = true;
    if (c[0] < minLng) minLng = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[0] > maxLng) maxLng = c[0];
    if (c[1] > maxLat) maxLat = c[1];
  }
  return found ? { minLng, minLat, maxLng, maxLat } : null;
}

/** Grows a box so a single point or a straight line still frames sensibly. */
export function padBounds(b: Bounds, ratio = 0.12, min = 0.02): Bounds {
  const dx = Math.max((b.maxLng - b.minLng) * ratio, min);
  const dy = Math.max((b.maxLat - b.minLat) * ratio, min);
  return {
    minLng: Math.max(-180, b.minLng - dx),
    minLat: Math.max(-85, b.minLat - dy),
    maxLng: Math.min(180, b.maxLng + dx),
    maxLat: Math.min(85, b.maxLat + dy),
  };
}

export function geojsonCoords(fc: FeatureCollection | undefined): Coord[] {
  if (!fc) return [];
  const out: Coord[] = [];
  const walk = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (isValidCoord(v)) {
      out.push([v[0], v[1]]);
      return;
    }
    for (const item of v) walk(item);
  };
  for (const f of fc.features ?? []) walk(f?.geometry?.coordinates as unknown);
  return out;
}

/** Every coordinate a layer contributes to the viewport. */
export function layerCoords(layer: MapLayer): Coord[] {
  const out: Coord[] = [];
  for (const p of layer.points ?? []) if (isValidCoord(p.at)) out.push(p.at);
  for (const c of layer.path ?? []) if (isValidCoord(c)) out.push(c);
  out.push(...geojsonCoords(layer.geojson));
  return out;
}

export function layersBounds(layers: MapLayer[]): Bounds | null {
  const coords: Coord[] = [];
  for (const l of layers) coords.push(...layerCoords(l));
  return boundsOf(coords);
}

/**
 * What the camera should frame: the focused layer alone when one is focused
 * (and it has geometry), otherwise everything. `pointIds` narrows the focused
 * layer further to some of its stops and the roads out of them — one day of
 * an itinerary, as a day group's 缩放至这一天 asks for.
 */
export function focusBounds(layers: MapLayer[], focusLayerId: string | null, pointIds?: readonly string[] | null): Bounds | null {
  if (focusLayerId) {
    const focused = layers.find((l) => l.id === focusLayerId);
    if (focused && pointIds?.length) {
      const ids = new Set(pointIds);
      const coords = focused.points.filter(p => ids.has(p.id)).map(p => p.at);
      for (const leg of focused.routing?.legs ?? []) if (ids.has(leg.fromPointId)) coords.push(...(leg.path ?? []));
      const subset = boundsOf(coords);
      if (subset) return subset;
    }
    if (focused) {
      const only = boundsOf(layerCoords(focused));
      if (only) return only;
    }
  }
  return layersBounds(layers);
}

/* ------------------------------------------------------- route composition */

export interface RouteSegment {
  coords: Coord[];
  /** Anything that needs attention: a stop reminder, an avoid request or bad traffic. */
  warn: boolean;
  /**
   * The attention comes from a stop's own note (`point.warn`) and from nothing
   * else. A seasonal reminder is not a road condition, so `segmentStyle` in
   * `legs.ts` keeps it in the route colour instead of the closure/jam hues.
   */
  reminder?: boolean;
  fromPointId?: string;
  toPointId?: string;
  traffic?: TrafficState;
  avoid?: boolean;
  color?: string;
}

export interface RouteGeometry {
  segments: RouteSegment[];
  /** `provided` = caller-supplied geometry (per-leg path or layer.path); `straight` = points joined in order. */
  kind: 'provided' | 'straight';
}

/**
 * Drawable geometry for a route layer.
 *
 * Prefer one labelled segment per consecutive stop pair when any
 * `routing.legs[].path` has real coordinates. Without per-leg paths a supplied
 * `layer.path` is drawn verbatim as one unlabelled polyline — Cartula never
 * guesses which part of someone else's geometry belongs to which leg. With
 * neither, the points are joined in order. A leg is flagged when either
 * endpoint carries `warn`.
 */
export function routeGeometry(layer: MapLayer): RouteGeometry {
  const pts = (layer.points ?? []).filter((p) => isValidCoord(p.at));
  const legs = layer.routing?.legs ?? [];
  const labelled: RouteSegment[] = [];
  let anyLegPath = false;
  for (let i = 1; i < pts.length; i += 1) {
    const from = pts[i - 1];
    const to = pts[i];
    const leg = legs.find((part) => part.fromPointId === from.id && part.toPointId === to.id);
    const legPath = (leg?.path ?? []).filter(isValidCoord);
    // `leg.closed` is a road fact and maps to traffic; `avoid` is the user's
    // instruction; `reminder` is a note on a stop. Three different things.
    const avoid = Boolean(leg?.closed || (leg?.note && leg.note.includes('避免')));
    const traffic = leg?.closed ? 'closed' : leg?.traffic;
    const reminder = Boolean(from.warn || to.warn);
    const warn = Boolean(reminder || avoid || traffic === 'heavy' || traffic === 'closed');
    const extra = {
      ...(traffic && traffic !== 'unknown' ? { traffic } : {}),
      ...(avoid ? { avoid: true } : {}),
      ...(reminder ? { reminder: true } : {}),
      ...(leg?.color ? { color: leg.color } : {}),
    };
    if (legPath.length >= 2) {
      anyLegPath = true;
      labelled.push({ coords: legPath, warn, fromPointId: from.id, toPointId: to.id, ...extra });
    } else {
      labelled.push({ coords: [from.at, to.at], warn, fromPointId: from.id, toPointId: to.id, ...extra });
    }
  }
  if (anyLegPath) return { segments: labelled, kind: 'provided' };

  const path = (layer.path ?? []).filter(isValidCoord);
  const avoided = labelled.filter(seg => seg.avoid);
  if (path.length >= 2) {
    // Keep the supplied road, and overlay a dashed chord on avoided pairs so
    // the user's intent is visible without inventing a replacement route.
    if (!avoided.length) return { segments: [{ coords: path, warn: false }], kind: 'provided' };
    return { segments: [{ coords: path, warn: false }, ...avoided], kind: 'provided' };
  }

  return { segments: labelled, kind: 'straight' };
}

export function lerpCoord(a: Coord, b: Coord, t: number): Coord {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Distance-weighted midpoint of a polyline. Degenerate input returns the first valid coordinate. */
export function pathMidpoint(coords: Coord[]): Coord | undefined {
  const valid = coords.filter(isValidCoord);
  if (!valid.length) return undefined;
  if (valid.length === 1) return valid[0];
  let total = 0;
  for (let i = 1; i < valid.length; i += 1) total += haversineKm(valid[i - 1], valid[i]);
  if (!(total > 0)) return valid[Math.floor(valid.length / 2)];
  const half = total / 2;
  let acc = 0;
  for (let i = 1; i < valid.length; i += 1) {
    const step = haversineKm(valid[i - 1], valid[i]);
    if (acc + step >= half) {
      const t = step > 0 ? (half - acc) / step : 0;
      return lerpCoord(valid[i - 1], valid[i], t);
    }
    acc += step;
  }
  return valid[valid.length - 1];
}

/* ------------------------------------------------------------- divergence */

export interface Divergence {
  /** The spot on `target` that is furthest from `reference`. */
  at: Coord;
  /** Its neighbours on `target`, so a caller can take a local direction. */
  before?: Coord;
  after?: Coord;
  /** How far that spot lies from `reference`, in km. */
  awayKm: number;
}

/** Kilometres per degree of latitude — the scale of the local plane below. */
const KM_PER_DEGREE = 111.32;

/**
 * Distance from a point to a segment, on a plane tangent at the point.
 *
 * Good to a fraction of a percent at the scale this is used for (how far one
 * route strays from another), and cheap enough to run over every vertex of a
 * plan. Meridian wrap is not handled: a pair of routes that straddle ±180° gets
 * a distance that is too large, which can only move a label, never a line.
 */
function segmentDistanceKm(p: Coord, a: Coord, b: Coord): number {
  const scale = Math.cos((p[1] * Math.PI) / 180);
  const px = p[0] * scale;
  const ax = a[0] * scale;
  const bx = b[0] * scale;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), p[1] - (a[1] + t * dy)) * KM_PER_DEGREE;
}

/**
 * Where two routes disagree most — the place a comparison is decided.
 *
 * Alternatives usually share their ends and most of their middle; what tells
 * them apart is one stretch where they part company. That stretch is where a
 * label belongs, because a chip on the shared part would name a plan while
 * sitting on a line that belongs to both.
 *
 * Both polylines are thinned to a sample budget first: a routed plan can carry
 * thousands of vertices, and the answer only has to be good enough to place a
 * label. Without reference geometry the whole line is the difference, so the
 * midpoint comes back with an infinite distance rather than a fabricated one.
 */
export function divergenceAnchor(target: Coord[], reference: Coord[], samples = 160): Divergence | undefined {
  const line = target.filter(isValidCoord);
  if (!line.length) return undefined;
  const other = reference.filter(isValidCoord);
  const midpoint = pathMidpoint(line);
  if (other.length < 2) return midpoint ? { at: midpoint, awayKm: Number.POSITIVE_INFINITY } : undefined;

  const stride = Math.max(1, Math.ceil(other.length / (samples * 2)));
  const thinned: Coord[] = [];
  for (let i = 0; i < other.length; i += stride) thinned.push(other[i]);
  const last = other[other.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);

  const step = Math.max(1, Math.ceil(line.length / samples));
  let bestIndex = -1;
  let bestKm = -1;
  for (let i = 0; i < line.length; i += step) {
    let nearest = Infinity;
    for (let j = 1; j < thinned.length; j += 1) {
      const distance = segmentDistanceKm(line[i], thinned[j - 1], thinned[j]);
      if (distance < nearest) nearest = distance;
      if (nearest <= bestKm) break; // cannot win any more
    }
    if (nearest > bestKm) { bestKm = nearest; bestIndex = i; }
  }
  if (bestIndex < 0) return midpoint ? { at: midpoint, awayKm: 0 } : undefined;
  return { at: line[bestIndex], before: line[bestIndex - 1], after: line[bestIndex + 1], awayKm: bestKm };
}

/**
 * Cuts a polyline into visible dash pieces.
 *
 * deck.gl's dash support lives in `@deck.gl/extensions`, which this project
 * does not depend on, so dashes are cut geometrically. Degenerate input returns
 * the original line: a warn stretch stays solid red rather than vanishing.
 */
export function dashSegments(coords: Coord[], dashKm: number, gapKm: number): Coord[][] {
  if (coords.length < 2 || !(dashKm > 0) || !(gapKm > 0)) return [coords];

  const out: Coord[][] = [];
  let current: Coord[] = [coords[0]];
  let drawing = true;
  let remaining = dashKm;

  for (let i = 1; i < coords.length; i += 1) {
    const from = coords[i - 1];
    const to = coords[i];
    const legTotal = haversineKm(from, to);
    if (!(legTotal > 0)) continue;

    let legLeft = legTotal;
    let t0 = 0;
    let guard = 0;
    while (legLeft > remaining && guard < 20000) {
      guard += 1;
      // `remaining / legTotal` is the fraction of this leg the next dash or
      // gap covers, so the cut advances t0 by exactly that much.
      const t1 = Math.min(1, t0 + remaining / legTotal);
      const cut = lerpCoord(from, to, t1);
      if (drawing) {
        current.push(cut);
        if (current.length >= 2) out.push(current);
        current = [];
      } else {
        current = [cut];
      }
      drawing = !drawing;
      legLeft -= remaining;
      remaining = drawing ? dashKm : gapKm;
      t0 = t1;
    }
    remaining -= legLeft;
    if (drawing) current.push(to);
  }
  if (drawing && current.length >= 2) out.push(current);
  return out.length ? out : [coords];
}

/** Dash length in km that stays visually stable across zoom levels. */
export function dashLengthKm(zoom: number): number {
  const quantized = Math.max(0, Math.min(20, Math.round(zoom)));
  // ≈14 CSS px at this zoom, expressed in km at the equator.
  return (14 * 156543.03392) / 2 ** quantized / 1000;
}

/* ------------------------------------------------------------- projection */

/** Web-Mercator Y in normalised [0,1] space. */
export function mercatorY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI);
}

export function mercatorLat(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

export function mercatorLng(x: number): number {
  return x * 360 - 180;
}

/** Lon/lat graticule for the offline basemap — generated locally. */
export function graticule(stepDeg = 15): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  for (let lng = -180; lng <= 180; lng += stepDeg) {
    const line: Coord[] = [];
    for (let lat = -80; lat <= 80; lat += 5) line.push([lng, lat]);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { major: lng === 0 },
    });
  }
  for (let lat = -80; lat <= 80; lat += stepDeg) {
    const line: Coord[] = [];
    for (let lng = -180; lng <= 180; lng += 5) line.push([lng, lat]);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { major: lat === 0 },
    });
  }
  return { type: 'FeatureCollection', features };
}

/* ------------------------------------------------------------------ misc */

/**
 * Stable per-marker key. Point ids are only unique within their layer, so the
 * layer id has to be part of the key.
 */
export function markerKey(layerId: string, pointId: string): string {
  return `${layerId}\u0000${pointId}`;
}

export function formatCoord(c: Coord): string {
  return `${c[0].toFixed(4)}, ${c[1].toFixed(4)}`;
}
