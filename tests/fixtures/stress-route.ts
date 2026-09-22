/**
 * A deterministic stand-in for the create_map payload behind REL-01.
 *
 * The feedback's own attachment (`cartula-create-fixture.json`) is not in this
 * workspace, so nothing here reproduces the original trip: this is a
 * **substitute** built to the same shape — 3 route layers, 35 stops, no
 * caller-supplied `path` — whose auto-routed geometry is larger than the 50,497
 * coordinates the report measured. It is not the real Greater Khingan itinerary
 * and must not be presented as one.
 *
 * `stressOsrmFetch()` is a local routing stub. Every leg's geometry is
 * generated from a seeded PRNG, so the coordinate counts below are reproducible
 * on any machine and no test ever touches the public OSRM service.
 */
import type { Coord, MapInput } from '../../src/core/types.js';

/** Stops per layer, matching the shape reported in feedback.md (13 / 10 / 12). */
const LAYER_STOPS = [13, 10, 12] as const;
const LAYER_IDS = ['plan-a', 'plan-b', 'plan-c'] as const;
const LAYER_NAMES = ['方案 A · 北线', '方案 B · 中线', '方案 C · 南线'] as const;
/** Raw geometry coordinates the stub returns per leg. 32 legs × 1600 ≫ 50,497. */
export const COORDS_PER_LEG = 1_600;

/** Deterministic, portable PRNG: same fixture on every machine and every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Stops spread across north-east China, far enough apart to be a real trip. */
function stopAt(layer: number, index: number): Coord {
  const random = mulberry32(1000 * (layer + 1) + index);
  return [round6(121.5 + layer * 1.7 + index * 0.62 + random() * 0.2), round6(45.3 + layer * 0.9 + index * 0.31 + random() * 0.2)];
}

export const STRESS_INPUT: MapInput = {
  title: '压力替代 fixture · 三方案 35 停靠点',
  layers: LAYER_STOPS.map((count, layer) => ({
    id: LAYER_IDS[layer],
    name: LAYER_NAMES[layer],
    kind: 'route' as const,
    // No path, no routing metrics: the server resolves the road itself, which
    // is exactly the call shape that produced the 50,497-coordinate map.
    points: Array.from({ length: count }, (_, index) => ({
      id: `${LAYER_IDS[layer].at(-1)}${index + 1}`,
      name: `${LAYER_NAMES[layer]} 第 ${index + 1} 站`,
      at: stopAt(layer, index),
      day: index + 1,
    })),
  })),
};

export const STRESS_STOP_COUNT = LAYER_STOPS.reduce((sum, count) => sum + count, 0);
export const STRESS_LEG_COUNT = LAYER_STOPS.reduce((sum, count) => sum + count - 1, 0);
/** What the old code would have stored: every leg plus the whole line again. */
export const STRESS_RAW_COORDS = STRESS_LEG_COUNT * COORDS_PER_LEG * 2;

/** A wandering line between two stops, dense enough to matter and stable per leg. */
function legGeometry(from: Coord, to: Coord, seed: number): Coord[] {
  const random = mulberry32(seed);
  const coords: Coord[] = [];
  for (let i = 0; i < COORDS_PER_LEG; i += 1) {
    const t = i / (COORDS_PER_LEG - 1);
    // Road-like: ~40 m between vertices, ~±20 m of lateral wander, tapering to
    // zero at both ends. Dense enough to blow the budget, smooth enough that a
    // distance tolerance behaves the way it would on a real OSRM polyline.
    const wobble = Math.sin(t * Math.PI) * 0.0004;
    coords.push([
      round6(from[0] + (to[0] - from[0]) * t + (random() - 0.5) * wobble),
      round6(from[1] + (to[1] - from[1]) * t + (random() - 0.5) * wobble),
    ]);
  }
  coords[0] = [from[0], from[1]];
  coords[coords.length - 1] = [to[0], to[1]];
  return coords;
}

/** Kilometres a stub leg claims. Provider metrics must survive simplification untouched. */
const legDistanceKm = (index: number): number => 120 + index * 7;

/**
 * A local OSRM stand-in: same request shape as the real client, deterministic
 * response, no network. Returns metres/seconds like OSRM does.
 */
export function stressOsrmFetch() {
  let calls = 0;
  return async (url: string | URL) => {
    calls += 1;
    const text = String(url);
    const coordinates = text.slice(text.lastIndexOf('/') + 1, text.indexOf('?')).split(';').map(pair => pair.split(',').map(Number) as Coord);
    const legs = coordinates.slice(1).map((to, index) => {
      const path = legGeometry(coordinates[index], to, 7_000 + index);
      return {
        distance: legDistanceKm(index) * 1000,
        duration: legDistanceKm(index) * 45,
        steps: [{ geometry: { type: 'LineString', coordinates: path } }],
      };
    });
    return {
      ok: true,
      body: { cancel: async () => undefined },
      json: async () => ({
        code: 'Ok',
        routes: [{
          distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
          duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
          geometry: { type: 'LineString', coordinates: legs.flatMap(leg => leg.steps[0].geometry.coordinates) },
          legs,
        }],
      }),
    };
  };
}

/** How many road coordinates a stored map holds, counted the way the budget does. */
export function storedRouteCoords(layers: Array<{ path?: Coord[]; routing?: { legs?: Array<{ path?: Coord[] }> } }>): { path: number; legs: number; total: number } {
  const path = layers.reduce((sum, layer) => sum + (layer.path?.length ?? 0), 0);
  const legs = layers.reduce((sum, layer) => sum + (layer.routing?.legs ?? []).reduce((inner, leg) => inner + (leg.path?.length ?? 0), 0), 0);
  return { path, legs, total: path + legs };
}
