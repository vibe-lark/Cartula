/**
 * Coordinate budgets and geometry simplification.
 *
 * Two budgets, because they answer two different questions:
 *
 *  - **Input quota** (`LIMITS.coordsPerMap`) bounds what a *caller* writes in
 *    one map: stops, GeoJSON vertices, and road geometry the caller supplies or
 *    rewrites. Exceeding it is a hard 400 that names the category, the
 *    threshold, the actual count and how to correct it. Nothing is written.
 *
 *  - **Derived quota** (`LIMITS.derivedCoordsPerMap`) bounds the road geometry
 *    *Cartula* stores: resolved from a routing provider, or carried over
 *    byte-for-byte from the previous version. Over-budget geometry is
 *    simplified to fit and the reduction is reported, so an edit to a note or
 *    an intent is not blocked by geometry the caller did not write.
 *
 * The line between the two is not a field a caller can set. Geometry counts as
 * derived only when it is identical to what Cartula already stored for that
 * layer, so claiming `routing.source: "OSRM"` buys nothing; `routingStatus` is
 * a report, never a permission.
 *
 * Pure functions over plain data: the browser workbench, the server and the
 * offline bundle share this accounting.
 */
import { LIMITS } from './schema.js';
import type { Coord, Geometry, MapLayer, RouteLeg, RoutingStatus } from './types.js';

/** Positions in a GeoJSON geometry. */
export function countGeometryCoords(geometry: Geometry): number {
  switch (geometry.type) {
    case 'Point':
      return 1;
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates.length;
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.reduce((sum, part) => sum + part.length, 0);
    case 'MultiPolygon':
      return geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0),
        0,
      );
    default:
      return 0;
  }
}

export function geojsonCoords(layer: Pick<MapLayer, 'geojson'>): number {
  return layer.geojson?.features.reduce((sum, feature) => sum + countGeometryCoords(feature.geometry), 0) ?? 0;
}

const sameCoords = (a: Coord[], b: Coord[]): boolean =>
  a.length === b.length && a.every((coord, i) => coord[0] === b[i][0] && coord[1] === b[i][1]);

/** Leg paths joined end to end, dropping the duplicated seam coordinate. */
export function concatLegPaths(layer: Pick<MapLayer, 'routing'>): Coord[] {
  const out: Coord[] = [];
  for (const leg of layer.routing?.legs ?? []) {
    for (const coord of leg.path ?? []) {
      const previous = out.at(-1);
      if (previous && previous[0] === coord[0] && previous[1] === coord[1]) continue;
      out.push(coord);
    }
  }
  return out;
}

const legCoordCount = (layer: Pick<MapLayer, 'routing'>): number =>
  (layer.routing?.legs ?? []).reduce((sum, leg) => sum + (leg.path?.length ?? 0), 0);

/**
 * Whether `layer.path` is exactly the concatenation of the leg paths.
 *
 * Cartula stores the same resolved polyline twice — once whole for callers and
 * the camera, once per leg for per-segment colour and traffic — so when the two
 * agree the budget charges for it once, and simplification rebuilds the whole
 * line from the simplified legs instead of decimating it separately.
 */
export function pathMirrorsLegs(layer: Pick<MapLayer, 'path' | 'routing'>): boolean {
  const path = layer.path;
  if (!path?.length || !legCoordCount(layer)) return false;
  // Walk both without materialising the concatenation: this runs on every write.
  let index = 0;
  for (const leg of layer.routing?.legs ?? []) {
    for (const coord of leg.path ?? []) {
      const previous = index > 0 ? path[index - 1] : undefined;
      if (previous && previous[0] === coord[0] && previous[1] === coord[1]) continue;
      const at = path[index];
      if (!at || at[0] !== coord[0] || at[1] !== coord[1]) return false;
      index += 1;
    }
  }
  return index === path.length;
}

/** Road coordinates a layer stores: `path` plus `routing.legs[].path`, counted once when they mirror each other. */
export function routeCoords(layer: Pick<MapLayer, 'path' | 'routing'>): number {
  const root = layer.path?.length ?? 0;
  const legs = legCoordCount(layer);
  if (!legs) return root;
  return pathMirrorsLegs(layer) ? Math.max(root, legs) : root + legs;
}

/** Identity of a layer's road geometry — what makes it "the same geometry we stored". */
export function routeGeometryKey(layer: Pick<MapLayer, 'path' | 'routing'>): string {
  return JSON.stringify([
    layer.path ?? null,
    (layer.routing?.legs ?? []).map((leg) => [leg.fromPointId, leg.toPointId, leg.path ?? null]),
  ]);
}

// --- census ---------------------------------------------------------------

export interface CoordCensus {
  /** Interactive stops. Always the caller's. */
  stops: number;
  /** GeoJSON vertices. Always the caller's: overlay data is never auto-simplified. */
  geojson: number;
  /** Road geometry this write supplies or rewrites. */
  callerRoute: number;
  /** Road geometry Cartula resolved, or the caller returned unchanged. */
  derivedRoute: number;
  /** What the input quota governs. */
  input: number;
}

/**
 * Split every coordinate in the map into the caller's bucket and Cartula's.
 *
 * `derived(layer)` answers "is this layer's road geometry the geometry Cartula
 * already had?" — decided by the caller's write path, never by the payload.
 */
export function censusCoords(layers: MapLayer[], derived: (layer: MapLayer) => boolean): CoordCensus {
  let stops = 0;
  let geojson = 0;
  let callerRoute = 0;
  let derivedRoute = 0;
  for (const layer of layers) {
    stops += layer.points.length;
    geojson += geojsonCoords(layer);
    const road = routeCoords(layer);
    if (derived(layer)) derivedRoute += road;
    else callerRoute += road;
  }
  return { stops, geojson, callerRoute, derivedRoute, input: stops + geojson + callerRoute };
}

// --- simplification -------------------------------------------------------

const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320;

/**
 * Douglas–Peucker with a metre tolerance, endpoints always kept.
 *
 * Coordinates are projected onto a local equirectangular plane scaled at the
 * line's own latitude, which is accurate enough to decide "is this vertex
 * within N metres of the chord" anywhere outside the poles. Iterative rather
 * than recursive: a leg can carry thousands of vertices.
 */
export function simplifyPath(coords: Coord[], toleranceMeters: number): Coord[] {
  if (coords.length <= 2 || toleranceMeters <= 0) return coords;
  const kx = Math.cos((coords[coords.length >> 1][1] * Math.PI) / 180) * METRES_PER_DEG_LON;
  const xs = coords.map((coord) => coord[0] * kx);
  const ys = coords.map((coord) => coord[1] * METRES_PER_DEG_LAT);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const tolerance2 = toleranceMeters * toleranceMeters;
  const stack: number[] = [0, coords.length - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last <= first + 1) continue;
    const ax = xs[first];
    const ay = ys[first];
    const dx = xs[last] - ax;
    const dy = ys[last] - ay;
    const length2 = dx * dx + dy * dy;
    let furthest = -1;
    let worst = tolerance2;
    for (let i = first + 1; i < last; i += 1) {
      const px = xs[i] - ax;
      const py = ys[i] - ay;
      let t = length2 > 0 ? (px * dx + py * dy) / length2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const distance2 = ex * ex + ey * ey;
      if (distance2 > worst) {
        worst = distance2;
        furthest = i;
      }
    }
    if (furthest === -1) continue;
    keep[furthest] = 1;
    stack.push(first, furthest, furthest, last);
  }
  const out: Coord[] = [];
  for (let i = 0; i < coords.length; i += 1) if (keep[i]) out.push(coords[i]);
  return out;
}

/** Even stride, endpoints kept. The last resort when a tolerance cannot hit a hard cap. */
export function decimatePath(coords: Coord[], max = 8_000): Coord[] {
  if (coords.length <= max) return coords;
  const stride = Math.ceil(coords.length / max);
  const out: Coord[] = [];
  for (let i = 0; i < coords.length; i += stride) out.push(coords[i]);
  const last = coords.at(-1)!;
  const previous = out.at(-1);
  if (!previous || previous[0] !== last[0] || previous[1] !== last[1]) out.push(last);
  return out;
}

// --- fitting the derived budget ------------------------------------------

export interface GeometryReduction {
  layerId: string;
  layerName: string;
  fromCoordinates: number;
  toCoordinates: number;
  toleranceMeters: number;
  decimated: boolean;
  /** Per-leg polylines removed from this layer. */
  droppedLegPaths: number;
  /** Every dropped leg was only the stop-to-stop chord, so nothing was lost. */
  legPathsRecoverable: boolean;
  /** The whole line was cut down to its endpoints. */
  endpointsOnly: boolean;
  reason: 'derived-budget';
}

/** Metre tolerances tried in order; the first one that fits the budget wins. */
const TOLERANCES = [5, 10, 20, 40, 80, 160, 320, 640, 1_280] as const;

interface Original {
  layer: MapLayer;
  path?: Coord[];
  legs: Array<Coord[] | undefined>;
  mirrors: boolean;
  coords: number;
  /** Coordinates left after sampling, before any structural step. */
  sampled: number;
  /** Structural steps taken after tolerance and decimation ran out of room. */
  dropped: number;
  recoverable: boolean;
  endpointsOnly: boolean;
}

function restore(original: Original) {
  const { layer } = original;
  if (original.path) layer.path = original.path.map((coord): Coord => [coord[0], coord[1]]);
  original.legs.forEach((path, index) => {
    const leg = layer.routing?.legs?.[index];
    if (leg && path) leg.path = path.map((coord): Coord => [coord[0], coord[1]]);
  });
}

/**
 * Apply one tolerance (and optionally a hard coordinate cap) to a layer,
 * keeping the whole line and its legs in step.
 *
 * `cap` is the layer's whole share of the budget; it is split the same way
 * `routeCoords` charges for the layer, so a layer whose `path` and legs are two
 * different polylines pays for both.
 */
function reduce(original: Original, toleranceMeters: number, cap?: number) {
  const { layer } = original;
  const legPaths = original.legs.reduce((sum, path) => sum + (path?.length ?? 0), 0);
  const rootPath = original.path?.length ?? 0;
  const share = (part: number): number | undefined =>
    cap === undefined ? undefined : Math.max(2, Math.round((cap * part) / (original.mirrors ? Math.max(rootPath, legPaths) : rootPath + legPaths || 1)));
  const shrink = (coords: Coord[], budget?: number): Coord[] => {
    const simplified = simplifyPath(coords, toleranceMeters);
    return budget === undefined ? simplified : decimatePath(simplified, budget);
  };
  const legs = layer.routing?.legs;
  if (legs?.length && legPaths) {
    const legCap = share(legPaths);
    original.legs.forEach((path, index) => {
      const leg = legs[index];
      if (!leg || !path) return;
      leg.path = shrink(path, legCap === undefined ? undefined : Math.max(2, Math.round((legCap * path.length) / legPaths)));
    });
  }
  if (!original.path) return;
  // The whole line is the legs joined up: rebuild it so the two never drift
  // into two different decimations of the same road.
  layer.path = original.mirrors ? concatLegPaths(layer) : shrink(original.path, share(rootPath));
}

function noteReduction(item: Original, to: number, toleranceMeters: number, decimated: boolean) {
  const { layer } = item;
  // Only claim the tolerance when it actually removed something from this layer.
  const sampled = item.sampled < item.coords;
  const status: RoutingStatus = layer.routingStatus
    ? { ...layer.routingStatus }
    : { geometry: 'simplified', coordinates: to };
  status.coordinates = to;
  status.simplified = {
    reason: 'derived-budget',
    fromCoordinates: item.coords,
    toCoordinates: to,
    toleranceMeters: sampled ? toleranceMeters : 0,
    ...(decimated && sampled ? { decimated: true } : {}),
    ...(item.dropped ? { droppedLegPaths: item.dropped, legPathsRecoverable: item.recoverable } : {}),
    ...(item.endpointsOnly ? { endpointsOnly: true } : {}),
  };
  layer.routingStatus = status;
}

/** Float noise from a CRS conversion or a JSON round trip, nothing more. */
const COORD_EPSILON = 1e-9;
const samePlace = (a: Coord, b: Coord): boolean =>
  Math.abs(a[0] - b[0]) <= COORD_EPSILON && Math.abs(a[1] - b[1]) <= COORD_EPSILON;

/**
 * A leg polyline that holds nothing the stops do not already hold: at most two
 * coordinates, and those coordinates *are* the two stops.
 *
 * The comparison is exact on purpose. A routing provider snaps to the road, so
 * a leg that starts a few metres from its stop marks a real entrance or kerb
 * position; dropping it moves the drawn line, which makes it a loss to report
 * rather than a redundancy to reclaim.
 */
function isChordLeg(layer: MapLayer, leg: RouteLeg): boolean {
  const path = leg.path;
  if (!path || path.length > 2) return false;
  if (path.length < 2) return true;
  const from = layer.points.find((point) => point.id === leg.fromPointId)?.at;
  const to = layer.points.find((point) => point.id === leg.toPointId)?.at;
  return !!from && !!to && samePlace(path[0], from) && samePlace(path[1], to);
}

/**
 * Drop per-leg polylines. `onlyRecoverable` keeps everything that carries shape
 * the stops cannot reproduce; without it the segments fall back to straight
 * chords, which is a real loss and is reported as one.
 *
 * Leg metrics (distance, duration, traffic, colour) and the leg's association
 * with its two stops are untouched — only the drawing geometry goes.
 */
function dropLegPaths(item: Original, onlyRecoverable: boolean): number {
  const legs = item.layer.routing?.legs ?? [];
  let dropped = 0;
  for (const leg of legs) {
    if (!leg.path) continue;
    if (onlyRecoverable && !isChordLeg(item.layer, leg)) continue;
    if (!onlyRecoverable && !isChordLeg(item.layer, leg)) item.recoverable = false;
    delete leg.path;
    dropped += 1;
  }
  item.dropped += dropped;
  item.mirrors = false;
  return dropped;
}

/**
 * Bring Cartula-held road geometry inside `budget`, mutating `layers` in place.
 *
 * Escalating steps, each reached only when the previous one could not free
 * enough. The structural ones exist because sampling cannot go below two
 * coordinates per polyline, and a map of two-point leg paths is already there:
 *
 *  1. Distance tolerance (5 m … 1280 m); the smallest that fits wins.
 *  2. Even decimation to each layer's proportional share.
 *  3. Drop leg polylines that are exactly the stop-to-stop chord — the renderer
 *     draws that same line from the stops.
 *  4. Drop the remaining leg polylines, heaviest layer first: those segments
 *     become straight chords, which is a loss and is reported as one.
 *  5. Cut whole lines down to their endpoints.
 *
 * Step 5 bounds the whole thing: two coordinates per layer, `LIMITS.layers`
 * layers, so the floor is 100 coordinates. The closing check is a guard against
 * a budget configured below that floor.
 *
 * Stops, GeoJSON, leg-to-stop association and provider distance/duration are
 * untouched: mileage and driving time keep coming from the routing service.
 */
export function fitDerivedGeometry(
  layers: MapLayer[],
  derived: (layer: MapLayer) => boolean,
  budget: number = LIMITS.derivedCoordsPerMap,
): GeometryReduction[] {
  const candidates = layers.filter((layer) => derived(layer) && routeCoords(layer) > 0);
  // Copying the geometry is only worth it once we know something has to give.
  if (candidates.reduce((sum, layer) => sum + routeCoords(layer), 0) <= budget) return [];
  const managed: Original[] = candidates
    .map((layer) => ({
      layer,
      ...(layer.path ? { path: layer.path.map((coord): Coord => [coord[0], coord[1]]) } : {}),
      legs: (layer.routing?.legs ?? []).map((leg) => leg.path?.map((coord): Coord => [coord[0], coord[1]])),
      mirrors: pathMirrorsLegs(layer),
      coords: routeCoords(layer),
      sampled: routeCoords(layer),
      dropped: 0,
      recoverable: true,
      endpointsOnly: false,
    }));
  const before = managed.reduce((sum, item) => sum + item.coords, 0);
  const total = () => managed.reduce((sum, item) => sum + routeCoords(item.layer), 0);
  /** Whoever is still holding the most geometry gives it up first. */
  const heaviestFirst = () => managed
    .map((item) => ({ item, weight: routeCoords(item.layer) }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ item }) => item);
  let toleranceMeters = 0;
  let decimated = false;

  for (const tolerance of TOLERANCES) {
    managed.forEach((item) => reduce(item, tolerance));
    toleranceMeters = tolerance;
    if (total() <= budget) break;
  }
  if (total() > budget) {
    decimated = true;
    managed.forEach((item) => reduce(item, toleranceMeters, Math.max(2, Math.floor((budget * item.coords) / before))));
  }
  // Sampling is done. What each layer still holds here is what the tolerance
  // achieved; anything removed below is a structural loss, reported as one.
  for (const item of managed) item.sampled = routeCoords(item.layer);
  if (total() > budget) {
    // Redundant first: these legs are exactly the chord between their two
    // stops, which is what the renderer falls back to when a leg has no path.
    for (const item of managed) dropLegPaths(item, true);
  }
  if (total() > budget) {
    for (const item of heaviestFirst()) {
      if (dropLegPaths(item, false) === 0) continue;
      if (total() <= budget) break;
    }
  }
  if (total() > budget) {
    for (const item of heaviestFirst()) {
      if ((item.layer.path?.length ?? 0) <= 2) continue;
      item.layer.path = [item.layer.path![0], item.layer.path!.at(-1)!];
      item.endpointsOnly = true;
      if (total() <= budget) break;
    }
  }
  if (total() > budget) {
    // Unreachable in production: a layer's floor is two coordinates, so the
    // whole map's floor is `LIMITS.layers * 2` = 100, far under the budget
    // (`derived budget covers the structural floor` in the tests pins that).
    // Reaching here means the configuration broke the invariant, and throwing
    // beats storing a map the next edit cannot validate.
    throw new Error(`派生几何无法压缩到 ${budget} 个坐标以内（当前 ${total()}，${managed.length} 个图层；每层至少保留 2 个坐标，配额需不低于 ${managed.length * 2}）`);
  }

  const reductions: GeometryReduction[] = [];
  for (const item of managed) {
    const after = routeCoords(item.layer);
    if (after >= item.coords && !item.dropped && !item.endpointsOnly) {
      restore(item);
      continue;
    }
    noteReduction(item, after, toleranceMeters, decimated);
    reductions.push({
      layerId: item.layer.id,
      layerName: item.layer.name,
      fromCoordinates: item.coords,
      toCoordinates: after,
      toleranceMeters: item.sampled < item.coords ? toleranceMeters : 0,
      decimated: decimated && item.sampled < item.coords,
      droppedLegPaths: item.dropped,
      legPathsRecoverable: item.recoverable,
      endpointsOnly: item.endpointsOnly,
      reason: 'derived-budget',
    });
  }
  return reductions;
}

/** One user-facing line per reduced layer: what was cut, by how much, and what was kept. */
export function reductionMessage(reduction: GeometryReduction): string {
  const steps: string[] = [];
  if (reduction.toleranceMeters > 0) steps.push(reduction.decimated ? `按 ${reduction.toleranceMeters} 米容差简化并等距抽稀` : `按 ${reduction.toleranceMeters} 米容差简化`);
  if (reduction.droppedLegPaths) {
    steps.push(reduction.legPathsRecoverable
      ? `移除 ${reduction.droppedLegPaths} 段与停靠点连线重复的分段几何（显示不变）`
      : `移除 ${reduction.droppedLegPaths} 段分段几何，这些路段改按停靠点直线绘制`);
  }
  if (reduction.endpointsOnly) steps.push('整条路线只保留首尾坐标');
  return `「${reduction.layerName}」的道路几何已${steps.join('、')}：${reduction.fromCoordinates} → ${reduction.toCoordinates} 个坐标（超出派生几何配额 ${LIMITS.derivedCoordsPerMap}；停靠点、分段关联与路由提供方的里程/车程不变）`;
}
