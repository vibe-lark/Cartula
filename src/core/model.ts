/**
 * Pure domain model: normalising a whole-map write, applying semantic edits,
 * and turning a stored snapshot back into a write payload.
 *
 * Everything here is a pure function over plain data. No fetch, no storage, no
 * `window`, no Node built-ins — the browser workbench, the Fastify server, the
 * MCP adapter and the single-file offline bundle all run this same code.
 *
 * Two honesty rules are baked in and must not be relaxed:
 *  - Distances are great-circle estimates unless the caller supplied `path`;
 *    `stats.distanceKind` always says which one it is.
 *  - `stats.days` reflects `point.day` when present, otherwise a node-count
 *    estimate. It is never derived from distance and never claims real driving
 *    time or that a road exists.
 */
import { z } from 'zod';
import { gcj02ToWgs84, routeDistance } from './geo.js';
import { EditOperationsSchema, LIMITS, MapInputSchema } from './schema.js';
import { censusCoords, fitDerivedGeometry, reductionMessage, routeCoords, routeGeometryKey } from './geometry.js';
import type {
  Coord,
  EditOperation,
  Feature,
  FeatureCollection,
  Geometry,
  Intent,
  LayerInput,
  MapInput,
  MapLayer,
  MapPoint,
  MapSnapshot,
  PointInput,
  RouteLeg,
} from './types.js';

/**
 * An error with the HTTP status the API should report. `hint` is a short,
 * actionable sentence for the agent or the UI; `details` carries machine
 * readable context (ids, indexes, limits).
 */
export class DomainError extends Error {
  readonly statusCode: number;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, hint?: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
    if (hint !== undefined) this.hint = hint;
    if (details !== undefined) this.details = details;
    // Keeps `instanceof` working when this file is transpiled down.
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

const DEFAULT_TITLE = '未命名地图';

/** `layers[0].points[2].at` — where a validation issue lives, for the client. */
const issuePath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), '');

/**
 * Run a zod schema and report failures as `DomainError(400)`.
 *
 * Callers of this module only have to catch one error type, and the message
 * keeps zod's own wording (which is already written for the agent) plus the
 * path, so `坐标必须在…` is attributable to a specific point.
 */
function validate<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
    // `unrecognized_keys` is the difference between "your edit was rejected" and
    // "your edit half-applied": name the offending fields so the caller can drop them.
    ...('keys' in issue && Array.isArray(issue.keys) ? { unknownFields: issue.keys as string[] } : {}),
  }));
  const first = issues[0];
  const where = first?.path ? `${first.path}：` : '';
  const unknown = first?.unknownFields?.length ? `未知字段${first.unknownFields.map((key) => `「${key}」`).join('、')}。` : '';
  const more = issues.length > 1 ? `（另有 ${issues.length - 1} 处问题）` : '';
  throw new DomainError(400, `${what}校验失败：${where}${unknown}${first?.message ?? '数据不合法'}${more}`, '请修正后重新提交；未知字段不会被忽略，整批操作不会写入', {
    issues,
  });
}

// --- coordinate budgets ---------------------------------------------------

/**
 * Enforce the caller's coordinate quota, and keep Cartula's own road geometry
 * inside its separate budget by simplifying rather than refusing.
 *
 * `derived` marks the layers whose road geometry Cartula produced or already
 * held — decided by the write path (`normalizeMap` compares the stored
 * geometry, `applyOperations` tracks which operations rewrote it), never by a
 * field in the payload. That is what keeps `routing.source: "OSRM"` from
 * buying a bigger input quota.
 *
 * Returns the reduction notes so the caller can report them; throws
 * `DomainError(400)` with the category, threshold and actual count when the
 * caller's own coordinates are over quota — before anything is written.
 */
function enforceCoordinateBudgets(layers: MapLayer[], derived: (layer: MapLayer) => boolean, what: string): string[] {
  const notes = fitDerivedGeometry(layers, derived).map(reductionMessage);
  const census = censusCoords(layers, derived);
  if (census.input > LIMITS.coordsPerMap) {
    throw new DomainError(
      400,
      `${what}超出坐标配额：调用方坐标共 ${census.input} 个，上限 ${LIMITS.coordsPerMap} 个（停靠点 ${census.stops}，GeoJSON 顶点 ${census.geojson}，本次提供的路线几何 ${census.callerRoute}）`,
      '交互停靠点与路线/GeoJSON 顶点合并计入这一配额。自驾/步行/骑行路线可以省略 path，由 Cartula 解算道路几何——服务端派生的几何走独立配额，不占用本配额。',
      {
        code: 'COORDINATE_BUDGET',
        limit: 'coordsPerMap',
        threshold: LIMITS.coordsPerMap,
        actual: census.input,
        breakdown: { stops: census.stops, geojson: census.geojson, callerRoute: census.callerRoute },
        derived: { limit: 'derivedCoordsPerMap', threshold: LIMITS.derivedCoordsPerMap, actual: census.derivedRoute },
      },
    );
  }
  return notes;
}

/**
 * Layer colours, in assignment order. Distinguishable on light and dark basemaps.
 *
 * Ten, not twelve. `#65a30d` and `#0d9488` were removed: the palest basemap
 * Cartula ships (`#eef2e8`) requires a route line to clear a contrast ratio, and
 * that puts a *ceiling* on each hue's lightness — 82 for blue, but only 45 and
 * 46 for those two. Eleven usable lightness steps against blue's forty-eight is
 * not enough to carry twelve distinguishable day shades, so they were the two
 * weakest colours in the product before they were the two that failed the
 * measurement. Ten alternatives is far more than any real map compares, and an
 * eleventh layer still gets a colour from the modulo fallback in `pickColor`.
 *
 * Order matters and is deliberately unchanged — see `pickColor`.
 */
export const LAYER_PALETTE = [
  '#2563eb',
  '#e11d48',
  '#16a34a',
  '#f59e0b',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#ea580c',
  '#4f46e5',
  '#b45309',
] as const;

// --- ids ------------------------------------------------------------------

/**
 * 10 hex characters of randomness. Prefers `crypto.randomUUID`, falls back to
 * `crypto.getRandomValues` (available without a secure context) and finally to
 * `Math.random`, so ids can be minted in any of the four runtimes.
 */
function randomToken(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID().replace(/-/g, '').slice(0, 10);
  }
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(5));
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
  }
  return Math.random().toString(16).slice(2, 12).padEnd(10, '0');
}

function mintId(prefix: 'l' | 'p', used: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = `${prefix}_${randomToken()}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new DomainError(500, '无法生成唯一 id', '请重试；如反复出现说明随机源不可用');
}

// --- small helpers --------------------------------------------------------

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Human-facing kilometres: whole numbers once the figure is large enough. */
function formatKm(km: number): string {
  if (km >= 100) return String(Math.round(km));
  if (km >= 1) return String(round(km, 1));
  return String(round(km, 2));
}

/**
 * Where a mileage figure comes from. `provided` splits in two, because
 * "geometry Cartula resolved from a routing service" and "geometry the caller
 * drew" are different claims and a change line must not blur them.
 */
export function distanceLabel(kind: 'provided' | 'straight', resolved = false): string {
  if (kind === 'straight') return '直线估算';
  return resolved ? '路由服务解算的几何' : '调用方提供的几何';
}

function requireCoord(at: unknown, where: string): Coord {
  if (!Array.isArray(at) || at.length < 2 || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) {
    throw new DomainError(400, `${where} 的 at 必须是 [经度, 纬度] 两个有限数字`, '例如 [126.5341, 45.8038]', { at });
  }
  return [Number(at[0]), Number(at[1])];
}

// --- CRS ------------------------------------------------------------------

type Converter = (at: Coord) => Coord;
const identity: Converter = (at) => at;

function convertGeometry(geometry: Geometry, convert: Converter): Geometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: convert(geometry.coordinates) };
    case 'MultiPoint':
    case 'LineString':
      return { type: geometry.type, coordinates: geometry.coordinates.map(convert) };
    case 'MultiLineString':
    case 'Polygon':
      return { type: geometry.type, coordinates: geometry.coordinates.map((part) => part.map(convert)) };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(convert))),
      };
    default: {
      const unknown = geometry as { type?: unknown };
      throw new DomainError(400, `不支持的 geometry.type「${String(unknown.type)}」`, '请使用标准 GeoJSON 几何类型');
    }
  }
}

/** Rebuild a FeatureCollection in canonical key order, converting coordinates. */
function normalizeGeojson(collection: FeatureCollection, convert: Converter): FeatureCollection {
  const features: Feature[] = collection.features.map((feature) => {
    const normalized: Feature = {
      type: 'Feature',
      geometry: convertGeometry(feature.geometry, convert),
      properties: feature.properties ?? null,
    };
    if (feature.id !== undefined) normalized.id = feature.id;
    return normalized;
  });
  return { type: 'FeatureCollection', features };
}

// --- points ---------------------------------------------------------------

/** Canonical `MapPoint`: fixed key order, blank optionals dropped. */
function buildPoint(id: string, input: PointInput, convert: Converter, where: string): MapPoint {
  const name = text(input.name);
  if (!name) throw new DomainError(400, `${where} 缺少 name`, '每个点都需要一个名字');
  const point: MapPoint = { id, name, at: convert(requireCoord(input.at, `${where}「${name}」`)) };
  if (typeof input.day === 'number' && Number.isFinite(input.day)) point.day = Math.trunc(input.day);
  const note = text(input.note);
  if (note) point.note = note;
  if (input.warn === true) point.warn = true;
  const img = text(input.img);
  if (img) point.img = img;
  if (text(input.intent)) point.intent = text(input.intent);
  if (input.flexibility) point.flexibility = input.flexibility;
  if (input.icon) point.icon = input.icon;
  return point;
}

// --- stats ----------------------------------------------------------------

/**
 * Recompute `stats` from the layer's own content.
 *
 * Distance: a supplied `path` wins (`distanceKind: 'provided'`); otherwise the
 * straight-line chain through the points, and only for itineraries — a `spots`
 * or `geojson` layer is a set of candidates, not an ordered trip, so its
 * distance stays 0.
 *
 * Days: the largest `point.day` when any point carries one; otherwise, for a
 * route only, one day per node. An empty layer is 0 days rather than 1: we do
 * not invent a duration for a layer that has no nodes.
 */
function validateRouting(layer: MapLayer) {
  const routing = layer.routing;
  if (!routing) return;
  if (layer.kind !== 'route') throw new DomainError(400, `图层「${layer.name}」的 routing 只能用于 route 图层`);
  const adjacent = new Set(layer.points.slice(1).map((point, i) => JSON.stringify([layer.points[i].id, point.id])));
  const seen = new Set<string>();
  for (const leg of routing.legs ?? []) {
    const pair = JSON.stringify([leg.fromPointId, leg.toPointId]);
    if (!adjacent.has(pair) || seen.has(pair)) throw new DomainError(400, `图层「${layer.name}」的路由分段必须引用同层相邻地点且不能重复`, 'legs 使用 fromPointId / toPointId，并与 points 的顺序一致。');
    seen.add(pair);
  }
}

/** Geometry lengths and routing-service measurements have independent units
 * and provenance. Never infer a travel time from geometry. Works for old stored
 * snapshots as well as new writes without a database migration. */
export function layerStats(layer: MapLayer): MapLayer['stats'] {
  const straight = layer.kind === 'route' ? routeDistance(layer.points.map(point => point.at)) : 0;
  const geometry = layer.path && layer.path.length >= 2 ? routeDistance(layer.path) : undefined;
  const days = layer.points.reduce((max, point) => Math.max(max, point.day ?? 0), 0);
  const routing = layer.kind === 'route' ? layer.routing : undefined;
  const legs = routing?.legs;
  const legMetric = (key: 'distanceKm' | 'durationMinutes') => {
    if (!legs?.length || legs.length !== layer.points.length - 1 || !legs.every(leg => leg[key] !== undefined)) return undefined;
    return legs.reduce((sum, leg) => sum + leg[key]!, 0);
  };
  const routingDistanceKm = routing?.distanceKm ?? legMetric('distanceKm');
  const durationMinutes = routing?.durationMinutes ?? legMetric('durationMinutes');
  return {
    distanceKm: round(geometry ?? straight, 3), distanceKind: geometry === undefined ? 'straight' : 'provided',
    straightDistanceKm: round(straight, 3), ...(geometry === undefined ? {} : { geometryDistanceKm: round(geometry, 3) }),
    days: days || (layer.kind === 'route' ? layer.points.length : 0), pointCount: layer.points.length,
    ...(routingDistanceKm === undefined ? {} : { routingDistanceKm: round(routingDistanceKm, 3) }),
    ...(durationMinutes === undefined ? {} : { durationMinutes: round(durationMinutes, 3) }),
    ...(routing ? { routingSource: routing.source } : {}),
  };
}
function withStats(layer: MapLayer): MapLayer { validateRouting(layer); layer.stats = layerStats(layer); return layer; }

/** Identity of a layer's user-visible content; `stats`/`edited_by` excluded. */
function layerContentKey(layer: MapLayer): string {
  return JSON.stringify([
    layer.name,
    layer.kind,
    layer.color,
    layer.visible,
    layer.from ?? null,
    layer.note ?? null,
    layer.intent ?? null,
    layer.routing ?? null,
    layer.inputCrs ?? null,
    layer.points.map((point) => [
      point.id,
      point.name,
      point.at[0],
      point.at[1],
      point.day ?? null,
      point.note ?? null,
      point.intent ?? null,
      point.flexibility ?? null,
      point.warn === true,
      point.img ?? null,
    ]),
    layer.path ?? null,
    layer.geojson ?? null,
  ]);
}

/** Node identity and order — the part of a layer that invalidates `path`. */
function pointSignature(layer: MapLayer): string {
  return JSON.stringify(layer.points.map((point) => [point.id, point.at[0], point.at[1]]));
}

/**
 * Default `kind` when the caller did not say: an itinerary, unless the layer
 * carries no points at all and does carry GeoJSON — then it is overlay data.
 * A single point is still a route, so appending a second stop does not change
 * what the layer means.
 */
function inferKind(input: Pick<LayerInput, 'points' | 'geojson'>): 'route' | 'spots' | 'geojson' {
  const count = input.points?.length ?? 0;
  if (count === 0 && input.geojson) return 'geojson';
  return 'route';
}

/**
 * The colour for a new layer: the first free entry in `LAYER_PALETTE`.
 *
 * This *was* farthest-point insertion — pick the free colour whose smallest
 * perceptual distance to the colours already used is largest — on the reasoning
 * that maximising ΔE between plans must be better than following a fixed order.
 * Measurement says otherwise, and the reason is worth keeping:
 *
 * Farthest-point ranks by ΔE, which for the first six plans it does slightly
 * better on (base ΔE 35.9 against 34.4). But it gets there by *halving the hue
 * gap* — 17° against 30° — and hue distance, not base ΔE, is what the day
 * ladders need: every plan spreads its days through a wedge around its own hue,
 * so two plans 17° apart have overlapping wedges and their late days collide.
 * Running the ladder solver on both orders is unambiguous: palette order meets
 * all six acceptance targets (adjacent 25.6, cross-plan 16.8) while
 * farthest-point fails on adjacent days (24.6). Lab distance between two base
 * colours is a proxy; the ladders are the product, so the ladders decide.
 *
 * The order in `LAYER_PALETTE` is therefore load-bearing, not decorative, and
 * `tests/day-colors.test.ts` pins the result. `index` keeps the round-robin so a
 * map with more layers than colours still gets one.
 */
function pickColor(used: Set<string>, index: number): string {
  const free = LAYER_PALETTE.find((color) => !used.has(color));
  const color = free ?? LAYER_PALETTE[index % LAYER_PALETTE.length];
  used.add(color);
  return color;
}

// --- normalizeMap ---------------------------------------------------------

/**
 * Validate a whole-map payload and turn it into canonical layers.
 *
 * The input is validated here rather than trusted from the caller, so the
 * offline bundle and the MCP adapter get the same coordinate-range, size and
 * duplicate-id guarantees as the HTTP route. Validation failures surface as
 * `DomainError(400)`. Passing an already-parsed payload is fine and cheap —
 * the schema is idempotent on its own output.
 *
 * Ids are stable across writes: a layer or point keeps the id it had in
 * `previous`, matched by explicit id first and by name second (each previous
 * object can only be claimed once). Unmatched objects get a fresh id, so an
 * agent that re-sends a map without ids does not churn the user's selection.
 * Layer ids are unique per map; point ids only per layer, since every edit
 * addresses a point through its `layerId`.
 *
 * `crs: 'gcj02'` converts every coordinate in the layer (points, `path`,
 * `geojson`) to WGS84 and records `inputCrs: 'gcj02'`. Output `crs` is always
 * `'wgs84'`, so PUT-ing a snapshot back — where `crs` is already `'wgs84'` —
 * cannot convert twice. `inputCrs` is carried over from the matched previous
 * layer as provenance about where the coordinates originally came from.
 *
 * `edited_by` becomes `actor` for layers whose content differs from `previous`;
 * untouched layers keep their old author, so re-sending a map unchanged does
 * not relabel the user's own layers as agent-written.
 *
 * Caller-supplied `path` is kept as given: the caller sent points and geometry
 * in one payload, so it is theirs to keep consistent. (Semantic edits are
 * different — see `applyOperations`.)
 *
 * Road geometry that comes back byte-for-byte identical to what the matched
 * previous layer already stored is a round trip, not a new write: it keeps its
 * `routingStatus` and is charged to the derived budget instead of the caller's
 * quota. Change one coordinate and the whole layer's geometry becomes the
 * caller's again. This is why a `GET` → `PUT` of a Cartula-resolved map always
 * works, and why claiming a routing source in the payload buys nothing.
 */
export function normalizeMap(
  input: MapInput,
  previous: MapSnapshot | undefined,
  actor: 'agent' | 'user',
): { title: string; layers: MapLayer[]; intents?: Intent[]; geometryNotes?: string[] } {
  const parsed = validate(MapInputSchema, input, '地图数据');
  const inputLayers = parsed.layers;
  const previousLayers = previous?.layers ?? [];

  const previousById = new Map<string, MapLayer>();
  const previousByName = new Map<string, MapLayer>();
  for (const layer of previousLayers) {
    previousById.set(layer.id, layer);
    const name = text(layer.name);
    if (name && !previousByName.has(name)) previousByName.set(name, layer);
  }

  // Two passes so an explicit id always wins the previous layer it names, even
  // when an earlier same-named layer would otherwise have claimed it.
  const claimed = new Set<string>();
  const matches = new Array<MapLayer | undefined>(inputLayers.length);
  inputLayers.forEach((layer, index) => {
    const id = text(layer.id);
    const found = id ? previousById.get(id) : undefined;
    if (found && !claimed.has(found.id)) {
      claimed.add(found.id);
      matches[index] = found;
    }
  });
  inputLayers.forEach((layer, index) => {
    if (matches[index]) return;
    const name = text(layer.name);
    const found = name ? previousByName.get(name) : undefined;
    if (found && !claimed.has(found.id)) {
      claimed.add(found.id);
      matches[index] = found;
    }
  });

  // Reserve every colour that is explicit or inherited before auto-assigning,
  // so an automatic colour never steals one a later layer asked for.
  const usedColors = new Set<string>();
  const colors = inputLayers.map((layer, index) => {
    const color = text(layer.color)?.toLowerCase() ?? matches[index]?.color;
    if (color) usedColors.add(color);
    return color;
  });

  // Layer ids are document-wide; point ids only have to be unique inside their
  // own layer, because every EditOperation carries a layerId alongside the
  // pointId. Two routes may each have a point called 'harbin'.
  const usedLayerIds = new Set<string>();
  /** Layers whose road geometry is exactly the geometry Cartula already stored. */
  const carried = new Set<string>();
  const layers = inputLayers.map((input_, index) => {
    const previousLayer = matches[index];
    const name = text(input_.name);
    if (!name) throw new DomainError(400, `第 ${index + 1} 个图层缺少 name`, '每个图层都需要一个名字');

    const explicitId = text(input_.id);
    let id = explicitId ?? previousLayer?.id;
    if (!id || usedLayerIds.has(id)) {
      if (explicitId && usedLayerIds.has(explicitId)) {
        throw new DomainError(400, `重复的图层 id「${explicitId}」`, '同一幅地图里图层 id 必须唯一', { id: explicitId });
      }
      id = mintId('l', usedLayerIds);
    }
    usedLayerIds.add(id);

    const fromGcj = input_.crs === 'gcj02';
    const convert: Converter = fromGcj ? gcj02ToWgs84 : identity;
    const kind = input_.kind ?? previousLayer?.kind ?? inferKind(input_);

    // Same two-pass id matching for points, scoped to the matched layer.
    const inputPoints = input_.points ?? [];
    const previousPoints = previousLayer?.points ?? [];
    const pointById = new Map<string, MapPoint>();
    const pointByName = new Map<string, MapPoint>();
    for (const point of previousPoints) {
      pointById.set(point.id, point);
      if (!pointByName.has(point.name)) pointByName.set(point.name, point);
    }
    const claimedPoints = new Set<string>();
    const pointMatches = new Array<MapPoint | undefined>(inputPoints.length);
    inputPoints.forEach((point, pointIndex) => {
      const pointId = text(point.id);
      const found = pointId ? pointById.get(pointId) : undefined;
      if (found && !claimedPoints.has(found.id)) {
        claimedPoints.add(found.id);
        pointMatches[pointIndex] = found;
      }
    });
    inputPoints.forEach((point, pointIndex) => {
      if (pointMatches[pointIndex]) return;
      const pointName = text(point.name);
      const found = pointName ? pointByName.get(pointName) : undefined;
      if (found && !claimedPoints.has(found.id)) {
        claimedPoints.add(found.id);
        pointMatches[pointIndex] = found;
      }
    });

    const usedPointIds = new Set<string>();
    const points = inputPoints.map((point, pointIndex) => {
      const explicitPointId = text(point.id);
      let pointId = explicitPointId ?? pointMatches[pointIndex]?.id;
      if (!pointId || usedPointIds.has(pointId)) {
        if (explicitPointId && usedPointIds.has(explicitPointId)) {
          throw new DomainError(400, `图层「${name}」内重复的点 id「${explicitPointId}」`, '同一图层内点 id 必须唯一', {
            layerId: id,
            id: explicitPointId,
          });
        }
        pointId = mintId('p', usedPointIds);
      }
      usedPointIds.add(pointId);
      return buildPoint(pointId, point, convert, `图层「${name}」的第 ${pointIndex + 1} 个点`);
    });

    const layer: MapLayer = {
      id,
      name,
      points,
      kind,
      color: colors[index] ?? pickColor(usedColors, index),
      visible: input_.visible ?? previousLayer?.visible ?? true,
      crs: 'wgs84',
      edited_by: actor,
      stats: { distanceKm: 0, days: 0, distanceKind: 'straight', pointCount: points.length },
    };
    const from = text(input_.from);
    if (from) layer.from = from;
    const note = text(input_.note);
    if (note) layer.note = note;
    if (text(input_.intent)) layer.intent = text(input_.intent);
    if (input_.routing) layer.routing = structuredClone(input_.routing);
    const inputCrs = fromGcj ? 'gcj02' : previousLayer?.inputCrs;
    if (inputCrs) layer.inputCrs = inputCrs;
    if (input_.path && input_.path.length > 0) {
      layer.path = input_.path.map((at, i) => convert(requireCoord(at, `图层「${name}」path 第 ${i + 1} 个坐标`)));
    }
    if (input_.geojson) layer.geojson = normalizeGeojson(input_.geojson, convert);

    // Unchanged road geometry keeps the provenance — and the budget — it had.
    if (previousLayer && routeGeometryKey(previousLayer) === routeGeometryKey(layer)) {
      if (previousLayer.routingStatus) layer.routingStatus = structuredClone(previousLayer.routingStatus);
      if (routeCoords(layer) > 0) carried.add(id);
    }

    withStats(layer);
    if (previousLayer && layerContentKey(previousLayer) === layerContentKey(layer)) {
      layer.edited_by = previousLayer.edited_by;
    }
    return layer;
  });

  // A round trip of geometry that predates the derived budget is repaired here
  // rather than refused. Stats then describe the geometry actually stored, and
  // the reduction travels back to the caller as `geometryNotes` so the write
  // that triggered it can report the degradation instead of hiding it.
  const geometryNotes = enforceCoordinateBudgets(layers, (layer) => carried.has(layer.id), '地图数据');
  if (geometryNotes.length) {
    for (const layer of layers) {
      if (layer.routingStatus) layer.routingStatus.coordinates = routeCoords(layer);
      layer.stats = layerStats(layer);
    }
  }

  const title = text(parsed.title) ?? text(previous?.title) ?? DEFAULT_TITLE;
  const intents = parsed.intents?.length ? structuredClone(parsed.intents) : previous?.intents;
  return { title, layers, ...(intents?.length ? { intents } : {}), ...(geometryNotes.length ? { geometryNotes } : {}) };
}

// --- applyOperations -----------------------------------------------------

interface LayerBefore {
  key: string;
  pointSig: string;
  distanceKm: number;
  distanceKind: 'provided' | 'straight';
  /** The geometry behind `distanceKm` came from a routing provider. */
  resolved: boolean;
  kind: 'route' | 'spots' | 'geojson';
  /** Added by this batch: no "before" mileage worth reporting. */
  fresh?: boolean;
}

function findLayer(layers: MapLayer[], layerId: string): MapLayer {
  const layer = layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    throw new DomainError(404, `图层「${layerId}」不存在`, '请先用 GET 取回当前图层 id', { layerId });
  }
  return layer;
}

function findPointIndex(layer: MapLayer, pointId: string): number {
  const index = layer.points.findIndex((point) => point.id === pointId);
  if (index === -1) {
    throw new DomainError(404, `图层「${layer.name}」中没有 id 为「${pointId}」的点`, '请先用 GET 取回当前点 id', {
      layerId: layer.id,
      pointId,
    });
  }
  return index;
}

/**
 * Claim an id for a new object. `used` is the namespace it must be unique in:
 * all layer ids for a layer, or one layer's point ids for a point.
 */
function claimId(explicit: string | undefined, prefix: 'l' | 'p', used: Set<string>, scope: string): string {
  const id = text(explicit);
  if (!id) return mintId(prefix, used);
  if (used.has(id)) {
    throw new DomainError(400, `${scope} 中 id「${id}」已被占用`, '请换一个 id，或省略 id 让 Cartula 生成', { id });
  }
  used.add(id);
  return id;
}

const quote = (value: string): string => `「${value}」`;

/** Short preview of note text for the change log. */
function preview(value: string): string {
  const chars = [...value];
  return chars.length <= 24 ? value : `${chars.slice(0, 24).join('')}…`;
}

/**
 * Validate a batch of semantic edits, apply them in order, and atomically.
 *
 * This is the interactive path — the browser workbench and the UI-only
 * `edit_map` MCP tool — so layers whose content actually changes are marked
 * `edited_by: 'user'`, and layers no operation really changed keep their
 * previous author (an agent layer stays `agent`, a user layer stays `user`).
 *
 * The batch is validated on the way in (`EditOperationsSchema`) and the
 * resulting map on the way out (`MapInputSchema`): a long run of `layer.add` or
 * `insert` cannot grow a map past the layer/point/coordinate budgets one
 * individually-valid operation at a time, and a coordinate that only the
 * offline editor could produce is still range-checked. Both report
 * `DomainError(400)`.
 *
 * `snapshot` is never mutated: everything runs on a deep copy, so a rejected
 * operation leaves the caller's snapshot exactly as it was and the whole batch
 * can be discarded. Missing layers/points are 404, out-of-range indexes and id
 * collisions are 400.
 *
 * When a layer's nodes move or get reordered, a caller-supplied `path` is
 * dropped rather than kept next to nodes it no longer connects; the layer falls
 * back to a straight-line estimate and says so in `changes`.
 *
 * Operations that change nothing produce no change line — an entirely
 * inconsequential batch returns `changes: []`.
 */
export function applyOperations(
  snapshot: MapSnapshot,
  operations: EditOperation[],
  actor: 'agent' | 'user' = 'user',
): { title: string; layers: MapLayer[]; changes: string[]; intents?: Intent[]; operations: EditOperation[] } {
  const batch = validate(EditOperationsSchema, operations ?? [], '编辑操作');
  const layers: MapLayer[] = structuredClone(snapshot.layers ?? []);
  const intents: Intent[] = structuredClone(snapshot.intents ?? []);
  /** Document-wide layer ids. */
  const layerIds = new Set(layers.map((layer) => layer.id));
  /** Point ids of one layer — the only scope a point id must be unique in. */
  const pointIds = (layer: MapLayer): Set<string> => new Set(layer.points.map((point) => point.id));
  const before = new Map<string, LayerBefore>();
  for (const layer of layers) {
    before.set(layer.id, {
      key: layerContentKey(layer),
      pointSig: pointSignature(layer),
      distanceKm: layer.stats.distanceKm,
      distanceKind: layer.stats.distanceKind,
      resolved: layer.routingStatus?.geometry === 'resolved',
      kind: layer.kind,
    });
  }

  /**
   * Layers whose road geometry this batch did not write. Their coordinates are
   * charged to the derived budget and simplified if needed, so editing a note
   * is never blocked by geometry that arrived with an earlier version.
   */
  const carried = new Set(layers.map((layer) => layer.id));

  const changes: string[] = [];
  const invalidate = (layer: MapLayer) => {
    if (layer.path?.length || layer.routing) changes.push(`${quote(layer.name)}的节点已变化，已清除旧道路几何与路由里程/车程；需要重新提供路由，当前为直线估算`);
    delete layer.path; delete layer.routing; delete layer.routingStatus;
  };
  for (const operation of batch) {
    const target = 'layerId' in operation ? layers.find(layer => layer.id === operation.layerId) : undefined;
    const signature = target ? pointSignature(target) : undefined;
    switch (operation.op) {
      case 'insert':
      case 'point.insert': {
        const layer = findLayer(layers, operation.layerId);
        const id = claimId(operation.point?.id, 'p', pointIds(layer), `图层${quote(layer.name)}`);
        operation.point.id = id;
        const point = buildPoint(id, operation.point, identity, `图层「${layer.name}」的新增点`);
        if (operation.after !== undefined) {
          const anchorIndex = findPointIndex(layer, operation.after);
          layer.points.splice(anchorIndex + 1, 0, point);
          changes.push(`在${quote(layer.points[anchorIndex].name)}之后插入了${quote(point.name)}`);
        } else {
          layer.points.push(point);
          changes.push(`在${quote(layer.name)}末尾添加了${quote(point.name)}`);
        }
        break;
      }

      case 'delete':
      case 'point.delete': {
        const layer = findLayer(layers, operation.layerId);
        const index = findPointIndex(layer, operation.pointId);
        const [removed] = layer.points.splice(index, 1);
        changes.push(`删除了${quote(removed.name)}`);
        break;
      }

      case 'update':
      case 'point.update': {
        const layer = findLayer(layers, operation.layerId);
        const index = findPointIndex(layer, operation.pointId);
        const point = layer.points[index];
        const patch = operation.patch ?? {};
        const parts: string[] = [];
        const originalName = point.name;

        if (patch.name !== undefined) {
          const name = text(patch.name);
          if (!name) throw new DomainError(400, 'name 不能为空', '想删除这个点请用 delete 操作');
          if (name !== point.name) {
            point.name = name;
            parts.push(`改名为${quote(name)}`);
          }
        }
        if (patch.at !== undefined) {
          const at = requireCoord(patch.at, `点${quote(point.name)}`);
          if (at[0] !== point.at[0] || at[1] !== point.at[1]) {
            point.at = at;
            parts.push('坐标已调整');
          }
        }
        if (patch.day === null && point.day !== undefined) {
          delete point.day;
          parts.push('已清除行程天数');
        } else if (patch.day !== undefined && patch.day !== null && Number.isFinite(patch.day)) {
          const day = Math.trunc(patch.day);
          if (day !== point.day) {
            point.day = day;
            parts.push(`安排在第 ${day} 天`);
          }
        }
        if (patch.note !== undefined) {
          const note = text(patch.note);
          if (note !== point.note) {
            if (note) point.note = note;
            else delete point.note;
            parts.push(note ? '备注已更新' : '备注已移除');
          }
        }
        if (patch.intent !== undefined) {
          const intent = text(patch.intent);
          if (intent !== point.intent) { if (intent) point.intent = intent; else delete point.intent; parts.push(intent ? `规划意图：${intent}` : '已清除规划意图'); }
        }
        if (patch.flexibility !== undefined && (patch.flexibility ?? undefined) !== point.flexibility) {
          if (patch.flexibility) point.flexibility = patch.flexibility; else delete point.flexibility;
          parts.push(patch.flexibility === 'fixed' ? '必须保留' : patch.flexibility === 'flexible' ? '允许调整' : '调整状态已清除');
        }
        if (patch.warn !== undefined) {
          const warn = patch.warn === true;
          if (warn !== (point.warn === true)) {
            if (warn) point.warn = true;
            else delete point.warn;
            parts.push(warn ? '已加上提醒标记' : '已取消提醒标记');
          }
        }
        if (patch.img !== undefined) {
          const img = text(patch.img);
          if (img !== point.img) {
            if (img) point.img = img;
            else delete point.img;
            parts.push(img ? '图片已更新' : '图片已移除');
          }
        }
        if (patch.icon !== undefined && (patch.icon ?? undefined) !== point.icon) {
          if (patch.icon) point.icon = patch.icon; else delete point.icon;
          parts.push(patch.icon ? `标记改为${patch.icon}` : '已恢复为默认标记');
        }
        if (parts.length > 0) changes.push(`更新了${quote(originalName)}：${parts.join('、')}`);
        break;
      }

      case 'annotate': {
        const layer = findLayer(layers, operation.layerId);
        const index = findPointIndex(layer, operation.pointId);
        const point = layer.points[index];
        const note = text(operation.text);
        if (note === point.note) break;
        const had = point.note !== undefined;
        if (note) point.note = note;
        else delete point.note;
        if (!note) changes.push(`移除了${quote(point.name)}的备注`);
        else if (had) changes.push(`更新了${quote(point.name)}的备注：${preview(note)}`);
        else changes.push(`为${quote(point.name)}添加备注：${preview(note)}`);
        break;
      }

      case 'reorder':
      case 'point.reorder': {
        const layer = findLayer(layers, operation.layerId);
        const index = findPointIndex(layer, operation.pointId);
        const target = operation.toIndex;
        if (!Number.isInteger(target) || target < 0 || target >= layer.points.length) {
          throw new DomainError(
            400,
            `toIndex 越界：图层${quote(layer.name)}只有 ${layer.points.length} 个点`,
            `toIndex 需要在 0 到 ${Math.max(0, layer.points.length - 1)} 之间`,
            { layerId: layer.id, toIndex: target, pointCount: layer.points.length },
          );
        }
        if (target === index) break;
        const [moved] = layer.points.splice(index, 1);
        layer.points.splice(target, 0, moved);
        // The day this stop belongs to, when it has one, makes the line say
        // where it landed rather than only how far it moved. A cross-day drag
        // sends `update {day}` alongside this op, and that operation reports the
        // day change itself — so this stays about position only.
        changes.push(moved.day ? `将${quote(moved.name)}移到第 ${moved.day} 天第 ${target + 1} 站` : `将${quote(moved.name)}移至第 ${target + 1} 站`);
        break;
      }

      case 'points.reorder': {
        // One call for "reverse this route". A permutation, never a partial
        // list: dropping a stop has to be an explicit point.delete, so a
        // forgotten id is reported instead of silently deleting a stop.
        const layer = findLayer(layers, operation.layerId);
        const current = layer.points.map((point) => point.id);
        const wanted = operation.pointIds;
        const seen = new Set<string>();
        const duplicates = wanted.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
        const unknown = wanted.filter((id) => !current.includes(id));
        const missing = current.filter((id) => !seen.has(id));
        if (duplicates.length || unknown.length || missing.length) {
          throw new DomainError(
            400,
            `points.reorder 的 pointIds 必须是图层${quote(layer.name)}全部 ${current.length} 个点 id 的一次排列` +
              `${unknown.length ? `；不存在的 id：${unknown.join('、')}` : ''}` +
              `${duplicates.length ? `；重复的 id：${[...new Set(duplicates)].join('、')}` : ''}` +
              `${missing.length ? `；缺少的 id：${missing.join('、')}` : ''}`,
            '先用 GET 取回当前点 id，再整段提交新顺序；只增删地点请用 point.insert / point.delete',
            { layerId: layer.id, expected: current, received: wanted, unknown, duplicates, missing },
          );
        }
        if (wanted.every((id, i) => id === current[i])) break;
        const byId = new Map(layer.points.map((point) => [point.id, point]));
        layer.points = wanted.map((id) => byId.get(id)!);
        const reversed = wanted.length > 1 && wanted.every((id, i) => id === current[current.length - 1 - i]);
        changes.push(
          reversed
            ? `将${quote(layer.name)}的 ${wanted.length} 个地点整段反转，起点改为${quote(layer.points[0].name)}`
            : `重排了${quote(layer.name)}的 ${wanted.length} 个地点，起点为${quote(layer.points[0].name)}`,
        );
        break;
      }

      case 'layer.add': {
        const input = operation.layer;
        const name = text(input?.name);
        if (!name) throw new DomainError(400, '新图层缺少 name', '每个图层都需要一个名字');
        const id = claimId(input.id, 'l', layerIds, '本地图');
        operation.layer.id = id;
        const fromGcj = input.crs === 'gcj02';
        const convert: Converter = fromGcj ? gcj02ToWgs84 : identity;
        // A new layer starts its own point-id namespace.
        const newPointIds = new Set<string>();
        const points = (input.points ?? []).map((point, pointIndex) => {
          const pointId = claimId(point.id, 'p', newPointIds, `图层${quote(name)}`);
          point.id = pointId;
          return buildPoint(pointId, point, convert, `图层「${name}」的第 ${pointIndex + 1} 个点`);
        });
        const usedColors = new Set(layers.map((layer) => layer.color));
        const layer: MapLayer = {
          id,
          name,
          points,
          kind: input.kind ?? inferKind(input),
          color: text(input.color)?.toLowerCase() ?? pickColor(usedColors, layers.length),
          visible: input.visible ?? true,
          crs: 'wgs84',
          edited_by: actor,
          stats: { distanceKm: 0, days: 0, distanceKind: 'straight', pointCount: points.length },
        };
        const from = text(input.from);
        if (from) layer.from = from;
        const note = text(input.note);
        if (note) layer.note = note;
        if (text(input.intent)) layer.intent = text(input.intent);
        if (input.routing) layer.routing = structuredClone(input.routing);
        if (fromGcj) layer.inputCrs = 'gcj02';
        if (input.path && input.path.length > 0) {
          layer.path = input.path.map((at, i) => convert(requireCoord(at, `图层「${name}」path 第 ${i + 1} 个坐标`)));
        }
        if (input.geojson) layer.geojson = normalizeGeojson(input.geojson, convert);
        withStats(layer);
        layers.push(layer);
        // Record it as a baseline so later ops in the same batch treat it like
        // any other layer (path invalidation, mileage reporting).
        before.set(layer.id, {
          key: layerContentKey(layer),
          pointSig: pointSignature(layer),
          distanceKm: layer.stats.distanceKm,
          distanceKind: layer.stats.distanceKind,
          resolved: false,
          kind: layer.kind,
          fresh: true,
        });
        changes.push(`新增图层${quote(name)}`);
        break;
      }

      case 'layer.update': {
        const layer = findLayer(layers, operation.layerId);
        const patch = operation.patch ?? {};
        const originalName = layer.name;
        const parts: string[] = [];

        if (patch.name !== undefined) {
          const name = text(patch.name);
          if (!name) throw new DomainError(400, '图层 name 不能为空', '想删除图层请用 layer.delete 操作');
          if (name !== layer.name) {
            layer.name = name;
            parts.push(`改名为${quote(name)}`);
          }
        }
        if (patch.kind !== undefined && patch.kind !== layer.kind) {
          invalidate(layer);
          layer.kind = patch.kind;
          parts.push(`类型改为 ${patch.kind}`);
        }
        if (patch.color !== undefined) {
          const color = text(patch.color)?.toLowerCase();
          if (color && color !== layer.color) {
            layer.color = color;
            parts.push(`颜色改为 ${color}`);
          }
        }
        if (patch.visible !== undefined && patch.visible !== layer.visible) {
          layer.visible = patch.visible;
          parts.push(patch.visible ? '已显示' : '已隐藏');
        }
        if (patch.from !== undefined) {
          const from = text(patch.from);
          if (from !== layer.from) {
            if (from) layer.from = from;
            else delete layer.from;
            parts.push(from ? '来源说明已更新' : '来源说明已移除');
          }
        }
        if (patch.note !== undefined) {
          const note = text(patch.note);
          if (note !== layer.note) {
            if (note) layer.note = note;
            else delete layer.note;
            parts.push(note ? '说明已更新' : '说明已移除');
          }
        }
        if (patch.intent !== undefined && text(patch.intent) !== layer.intent) {
          if (text(patch.intent)) layer.intent = text(patch.intent); else delete layer.intent;
          parts.push(layer.intent ? `规划意图：${layer.intent}` : '规划意图已清除');
        }
        // Writing geometry makes it the caller's: it leaves the derived budget,
        // loses the resolved provenance, and counts against the input quota.
        if (patch.path !== undefined || patch.routing !== undefined) {
          carried.delete(layer.id);
          delete layer.routingStatus;
        }
        if (patch.path !== undefined && JSON.stringify(patch.path ?? undefined) !== JSON.stringify(layer.path)) {
          if (patch.path?.length) layer.path = structuredClone(patch.path); else delete layer.path;
          parts.push(patch.path?.length ? '路径几何已更新' : '路径几何已清除');
        }
        if (patch.routing !== undefined && JSON.stringify(patch.routing ?? undefined) !== JSON.stringify(layer.routing)) {
          if (patch.routing) layer.routing = structuredClone(patch.routing); else delete layer.routing;
          parts.push(patch.routing ? '路由里程/车程已更新' : '路由里程/车程已清除');
        }
        if (parts.length > 0) changes.push(`图层${quote(originalName)}：${parts.join('、')}`);
        break;
      }

      case 'layer.delete': {
        const layer = findLayer(layers, operation.layerId);
        layers.splice(layers.indexOf(layer), 1);
        changes.push(`删除了图层${quote(layer.name)}`);
        break;
      }

      case 'intent': {
        const intent: Intent = { scope: 'map', text: operation.text, author: actor, status: 'active' };
        upsertIntent(intents, intent);
        changes.push(`本轮规划意图：${operation.text}`);
        break;
      }

      case 'intent.set': {
        if (operation.scope === 'layer' && !operation.layerId) throw new DomainError(400, '图层意图需要 layerId');
        if (operation.scope === 'point' && (!operation.layerId || !operation.pointId)) throw new DomainError(400, '地点意图需要 layerId 和 pointId');
        const body = text(operation.text);
        if (operation.scope === 'point') {
          const layer = findLayer(layers, operation.layerId!);
          const point = layer.points[findPointIndex(layer, operation.pointId!)];
          if (body) point.intent = body; else delete point.intent;
        } else if (operation.scope === 'layer') {
          const layer = findLayer(layers, operation.layerId!);
          if (body) layer.intent = body; else delete layer.intent;
        }
        const intent: Intent = {
          scope: operation.scope, text: body ?? '', author: actor, status: operation.status ?? 'active',
          ...(operation.layerId ? { layerId: operation.layerId } : {}),
          ...(operation.pointId ? { pointId: operation.pointId } : {}),
          ...(operation.priority ? { priority: operation.priority } : {}),
        };
        if (!body) removeIntent(intents, intent);
        else upsertIntent(intents, { ...intent, text: body });
        const target = operation.scope === 'point'
          ? quote(findLayer(layers, operation.layerId!).points[findPointIndex(findLayer(layers, operation.layerId!), operation.pointId!)].name)
          : operation.scope === 'layer' ? `图层${quote(findLayer(layers, operation.layerId!).name)}` : '本地图';
        changes.push(body ? `${target}规划意图：${body}` : `已清除${target}规划意图`);
        break;
      }

      case 'route.leg.update': {
        const layer = findLayer(layers, operation.layerId);
        if (layer.kind !== 'route') throw new DomainError(400, `图层「${layer.name}」不是路线，不能更新路段`);
        const fromIndex = findPointIndex(layer, operation.fromPointId);
        const toIndex = findPointIndex(layer, operation.toPointId);
        if (toIndex !== fromIndex + 1) throw new DomainError(400, `路段必须引用同层相邻地点`, 'fromPointId 与 toPointId 需与 points 顺序相邻。');
        if (!layer.routing) layer.routing = { source: '未注明来源' };
        const legs = layer.routing.legs ?? (layer.routing.legs = []);
        let leg = legs.find(part => part.fromPointId === operation.fromPointId && part.toPointId === operation.toPointId);
        if (!leg) {
          leg = { fromPointId: operation.fromPointId, toPointId: operation.toPointId };
          legs.push(leg);
        }
        if (operation.patch?.path !== undefined) { carried.delete(layer.id); delete layer.routingStatus; }
        applyLegPatch(leg, operation.patch ?? {});
        if (!leg.source && layer.routing.source) leg.source = layer.routing.source;
        changes.push(`更新了${quote(layer.points[fromIndex].name)}至${quote(layer.points[toIndex].name)}的路段事实`);
        break;
      }

      case 'draft.commit': {
        if (text(operation.note)) changes.push(`提交草稿：${operation.note}`);
        break;
      }

      default: {
        const unknown = operation as { op?: unknown };
        throw new DomainError(400, `不支持的操作「${String(unknown?.op)}」`, '请查看 API 文档中的 EditOperation 列表', {
          op: unknown?.op,
        });
      }
    }
    if (target && signature !== pointSignature(target)) invalidate(target);
  }

  // Drop road geometry that no longer matches the nodes, then recompute stats.
  for (const layer of layers) {
    const prior = before.get(layer.id);
    withStats(layer);
    if (!prior || prior.key !== layerContentKey(layer)) layer.edited_by = actor;
  }

  // Mileage moved: report it as the estimate it is, never as driving distance.
  for (const layer of layers) {
    const prior = before.get(layer.id);
    if (!prior || prior.fresh) continue;
    const { distanceKm, distanceKind } = layer.stats;
    if (Math.abs(distanceKm - prior.distanceKm) < 0.05) continue;
    // Becoming (or ceasing to be) an itinerary is a change of meaning, not of
    // mileage: a spots layer has no route to measure, so say that instead of
    // announcing a drop to 0.
    if (layer.kind !== 'route' || prior.kind !== 'route') {
      if (prior.kind === 'route') {
        changes.push(`${quote(layer.name)}不再作为路线统计里程（原 ${formatKm(prior.distanceKm)} 公里，${distanceLabel(prior.distanceKind, prior.resolved)}）`);
      } else if (layer.kind === 'route') {
        changes.push(`${quote(layer.name)}开始按路线统计里程：约 ${formatKm(distanceKm)} 公里（${distanceLabel(distanceKind, layer.routingStatus?.geometry === 'resolved')}）`);
      }
      continue;
    }
    changes.push(
      `${quote(layer.name)}里程由 ${formatKm(prior.distanceKm)} 公里（${distanceLabel(prior.distanceKind, prior.resolved)}）` +
        `变为 ${formatKm(distanceKm)} 公里（${distanceLabel(distanceKind, layer.routingStatus?.geometry === 'resolved')}）`,
    );
  }

  // Geometry this batch wrote is the caller's and must fit their quota; geometry
  // it merely inherited is Cartula's problem to keep in budget, not a reason to
  // refuse an intent or a note. Reductions are reported, never silent. This runs
  // before the schema pass so an oversized inherited path is repaired rather
  // than blocking the edit that would have shrunk it.
  const reduced = enforceCoordinateBudgets(layers, (layer) => carried.has(layer.id), '编辑后的地图');
  changes.push(...reduced);
  for (const layer of layers) {
    if (layer.routingStatus) layer.routingStatus.coordinates = routeCoords(layer);
    // Stats describe the geometry actually stored; the reduction note above is
    // the one place a shortened display line is announced.
    if (reduced.length) layer.stats = layerStats(layer);
  }
  // Re-check the finished map against the same budgets a PUT has to satisfy.
  // Each operation is valid on its own, but a batch of them can still push the
  // map past the layer/point/coordinate limits, and only this pass catches that.
  // `toMapInput` shape, so `stats`/`edited_by` are not mistaken for input.
  validate(MapInputSchema, toMapInput({ ...snapshot, title: snapshot.title, layers, intents }), '编辑后的地图');

  return {
    title: snapshot.title,
    layers,
    changes: actor === 'agent' ? changes.map(change => `Agent：${change}`) : changes,
    operations: batch,
    ...(intents.length ? { intents } : {}),
  };
}

function intentKey(intent: Pick<Intent, 'scope' | 'layerId' | 'pointId'>): string {
  return `${intent.scope}:${intent.layerId ?? ''}:${intent.pointId ?? ''}`;
}
function upsertIntent(intents: Intent[], next: Intent) {
  const key = intentKey(next);
  const index = intents.findIndex(item => intentKey(item) === key);
  if (index >= 0) intents[index] = { ...intents[index], ...next };
  else intents.push(next);
}
function removeIntent(intents: Intent[], target: Pick<Intent, 'scope' | 'layerId' | 'pointId'>) {
  const key = intentKey(target);
  const index = intents.findIndex(item => intentKey(item) === key);
  if (index >= 0) intents.splice(index, 1);
}
function applyLegPatch(leg: RouteLeg, patch: NonNullable<Extract<EditOperation, { op: 'route.leg.update' }>['patch']>) {
  const set = <K extends keyof RouteLeg>(key: K, value: RouteLeg[K] | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value === '') delete leg[key];
    else leg[key] = value as RouteLeg[K];
  };
  set('distanceKm', patch.distanceKm as RouteLeg['distanceKm']);
  set('durationMinutes', patch.durationMinutes as RouteLeg['durationMinutes']);
  set('delayMinutes', patch.delayMinutes as RouteLeg['delayMinutes']);
  set('profile', patch.profile as RouteLeg['profile']);
  set('source', patch.source as RouteLeg['source']);
  set('traffic', patch.traffic as RouteLeg['traffic']);
  set('updatedAt', patch.updatedAt as RouteLeg['updatedAt']);
  set('legId', patch.legId as RouteLeg['legId']);
  set('border', patch.border as RouteLeg['border']);
  set('toll', patch.toll as RouteLeg['toll']);
  set('tunnel', patch.tunnel as RouteLeg['tunnel']);
  set('closed', patch.closed as RouteLeg['closed']);
  set('note', patch.note as RouteLeg['note']);
  set('color', patch.color as RouteLeg['color']);
  if (patch.path !== undefined) {
    if (patch.path?.length) leg.path = structuredClone(patch.path);
    else delete leg.path;
  }
}

// --- toMapInput ----------------------------------------------------------

/**
 * Snapshot -> write payload: drops everything Cartula derives (`stats`,
 * `edited_by`, `inputCrs`, versions, events) and keeps ids so a re-PUT updates
 * the same layers and points instead of creating new ones. `crs` is pinned to
 * `'wgs84'` because the stored coordinates already are, which is what keeps a
 * GCJ-02 layer from being converted a second time.
 */
export function toMapInput(snapshot: MapSnapshot): MapInput {
  const layers: LayerInput[] = (snapshot.layers ?? []).map((layer) => {
    const points: PointInput[] = layer.points.map((point) => {
      const copy: PointInput = { id: point.id, name: point.name, at: [point.at[0], point.at[1]] };
      if (point.day !== undefined) copy.day = point.day;
      if (point.note !== undefined) copy.note = point.note;
      if (point.intent !== undefined) copy.intent = point.intent;
      if (point.flexibility !== undefined) copy.flexibility = point.flexibility;
      if (point.warn === true) copy.warn = true;
      if (point.img !== undefined) copy.img = point.img;
      if (point.icon !== undefined) copy.icon = point.icon;
      return copy;
    });
    const copy: LayerInput = {
      id: layer.id,
      name: layer.name,
      points,
      kind: layer.kind,
      color: layer.color,
      visible: layer.visible,
      crs: 'wgs84',
    };
    if (layer.from !== undefined) copy.from = layer.from;
    if (layer.note !== undefined) copy.note = layer.note;
    if (layer.intent !== undefined) copy.intent = layer.intent;
    if (layer.routing !== undefined) copy.routing = structuredClone(layer.routing);
    if (layer.path !== undefined) copy.path = layer.path.map((at) => [at[0], at[1]]);
    if (layer.geojson !== undefined) copy.geojson = structuredClone(layer.geojson);
    return copy;
  });
  const intents = snapshot.intents?.length ? structuredClone(snapshot.intents) : undefined;
  return { title: snapshot.title, layers, ...(intents ? { intents } : {}) };
}
