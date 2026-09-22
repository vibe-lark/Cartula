/**
 * Turn an OSRM route response into Cartula path + routing facts.
 *
 * Cartula still never invents driving time from straight-line distance.
 * This module only maps a real routing-engine payload onto the existing
 * `layer.path` / `layer.routing` fields so Agents can send stops, not polylines.
 */
import { layerStats } from './model.js';
import { concatLegPaths, decimatePath, fitDerivedGeometry, reductionMessage, routeCoords } from './geometry.js';
import type { Coord, MapLayer, RouteLeg, RoutingInput } from './types.js';

export type OsrmProfile = 'driving' | 'walking' | 'cycling';

export interface ParsedOsrmRoute {
  path: Coord[];
  distanceKm: number;
  durationMinutes: number;
  legs: Array<Pick<RouteLeg, 'fromPointId' | 'toPointId' | 'distanceKm' | 'durationMinutes' | 'path' | 'profile'>>;
}

export interface ResolvedRoute {
  layerId: string;
  signature: string;
  path: Coord[];
  routing: RoutingInput;
}

const OSRM_PROFILES: Record<string, OsrmProfile> = {
  driving: 'driving', car: 'driving', drive: 'driving', 'driving-car': 'driving',
  walking: 'walking', foot: 'walking', hike: 'walking', hiking: 'walking', 'foot-walking': 'walking',
  cycling: 'cycling', bike: 'cycling', bicycle: 'cycling', 'cycling-regular': 'cycling',
};

export function osrmProfile(profile?: string): OsrmProfile | undefined {
  if (!profile) return 'driving';
  return OSRM_PROFILES[profile.trim().toLowerCase()];
}

export function routeSignature(points: Array<{ id: string; at: Coord }>): string {
  return points.map(point => `${point.id}:${point.at[0].toFixed(5)},${point.at[1].toFixed(5)}`).join('|');
}

function asCoord(value: unknown): Coord | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lon = Number(value[0]); const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined;
  return [lon, lat];
}

function lineCoords(value: unknown): Coord[] {
  if (!value || typeof value !== 'object') return [];
  const geometry = value as { type?: string; coordinates?: unknown };
  if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return [];
  const coords: Coord[] = [];
  for (const item of geometry.coordinates) {
    const coord = asCoord(item);
    if (coord) coords.push(coord);
  }
  return coords;
}

function appendLine(target: Coord[], next: Coord[]) {
  for (const coord of next) {
    const prev = target.at(-1);
    if (prev && prev[0] === coord[0] && prev[1] === coord[1]) continue;
    target.push(coord);
  }
}

/**
 * First-line cap on a single leg. The map-wide budget is enforced later by
 * `fitDerivedGeometry`, which simplifies by distance rather than by stride.
 */
export const downsamplePath = decimatePath;

export function parseOsrmRoute(payload: unknown, points: Array<{ id: string; at: Coord }>, profile: OsrmProfile): ParsedOsrmRoute | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as { code?: string; routes?: unknown };
  if (body.code !== 'Ok' || !Array.isArray(body.routes) || !body.routes[0] || typeof body.routes[0] !== 'object') return undefined;
  const route = body.routes[0] as { distance?: unknown; duration?: unknown; geometry?: unknown; legs?: unknown };
  const pairs = points.length - 1;
  if (pairs < 1) return undefined;
  const osrmLegs = Array.isArray(route.legs) ? route.legs : [];
  if (osrmLegs.length !== pairs) return undefined;

  const legs: ParsedOsrmRoute['legs'] = [];
  const path: Coord[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const raw = osrmLegs[i];
    if (!raw || typeof raw !== 'object') return undefined;
    const leg = raw as { distance?: unknown; duration?: unknown; steps?: unknown };
    const distanceKm = Number(leg.distance) / 1000;
    const durationMinutes = Number(leg.duration) / 60;
    if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(durationMinutes) || durationMinutes < 0) return undefined;
    const stepPath: Coord[] = [];
    if (Array.isArray(leg.steps)) {
      for (const step of leg.steps) {
        if (step && typeof step === 'object') appendLine(stepPath, lineCoords((step as { geometry?: unknown }).geometry));
      }
    }
    const from = points[i];
    const to = points[i + 1];
    if (stepPath.length < 2) appendLine(stepPath, [from.at, to.at]);
    legs.push({
      fromPointId: from.id, toPointId: to.id, profile,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      path: downsamplePath(stepPath),
    });
    appendLine(path, legs[i].path ?? []);
  }

  // The whole line is exactly the legs joined up — never a second, coarser
  // decimation of the same road, which is what made the stored geometry
  // inconsistent with its own segments.
  const finalPath = path.length >= 2 ? path : downsamplePath(lineCoords(route.geometry));
  if (finalPath.length < 2) return undefined;
  const distanceKm = Number(route.distance) / 1000;
  const durationMinutes = Number(route.duration) / 60;
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(durationMinutes) || durationMinutes < 0) return undefined;
  return {
    path: finalPath,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    durationMinutes: Math.round(durationMinutes * 10) / 10,
    legs,
  };
}

export function routingFromParsed(parsed: ParsedOsrmRoute, profile: OsrmProfile, source = 'OSRM'): RoutingInput {
  return {
    source,
    profile,
    distanceKm: parsed.distanceKm,
    durationMinutes: parsed.durationMinutes,
    updatedAt: new Date().toISOString(),
    legs: parsed.legs.map(leg => ({ ...leg })),
  };
}

function needsRoute(layer: MapLayer): boolean {
  if (layer.kind !== 'route' || layer.points.length < 2) return false;
  if (layer.path && layer.path.length >= 2) return false;
  if (!osrmProfile(layer.routing?.profile)) return false;
  return layer.points.every(point => Number.isFinite(point.at[0]) && Number.isFinite(point.at[1]));
}

export async function resolveMissingRoutes(
  layers: MapLayer[],
  route: (input: { profile: OsrmProfile; points: Array<{ id: string; at: Coord }> }) => Promise<ParsedOsrmRoute | undefined>,
): Promise<ResolvedRoute[]> {
  const jobs = layers.filter(needsRoute).filter(layer => layer.points.length <= 100);
  const resolved: ResolvedRoute[] = [];
  for (const layer of jobs) {
    const profile = osrmProfile(layer.routing?.profile);
    if (!profile) continue;
    const points = layer.points.map(point => ({ id: point.id, at: point.at }));
    try {
      const parsed = await route({ profile, points });
      if (!parsed) continue;
      resolved.push({
        layerId: layer.id,
        signature: routeSignature(points),
        path: parsed.path,
        routing: routingFromParsed(parsed, profile, layer.routing?.source?.trim() || 'OSRM'),
      });
    } catch {
      // Caller keeps the straight-line fallback; never fail a map write because routing is down.
    }
  }
  return resolved;
}

export function applyResolvedRoutes(layers: MapLayer[], resolved: ResolvedRoute[]): string[] {
  if (!resolved.length) return [];
  const byLayer = new Map(resolved.map(item => [item.layerId, item]));
  const filled: string[] = [];
  for (const layer of layers) {
    const match = byLayer.get(layer.id);
    if (!match) continue;
    if (routeSignature(layer.points) !== match.signature) continue;
    if (layer.path && layer.path.length >= 2) continue;
    layer.path = match.path;
    const previous = layer.routing;
    layer.routing = {
      ...match.routing,
      ...(previous?.distanceKm !== undefined ? { distanceKm: previous.distanceKm } : {}),
      ...(previous?.durationMinutes !== undefined ? { durationMinutes: previous.durationMinutes } : {}),
      ...(previous?.source ? { source: previous.source } : {}),
      ...(previous?.profile ? { profile: previous.profile } : {}),
    };
    if (previous?.legs?.length) {
      layer.routing.legs = match.routing.legs?.map(leg => {
        const kept = previous.legs?.find(item => item.fromPointId === leg.fromPointId && item.toPointId === leg.toPointId);
        return kept ? { ...leg, ...kept, path: kept.path ?? leg.path } : leg;
      });
      // A kept leg may carry the caller's own geometry, so the whole line has to
      // be rebuilt from what is actually stored per leg.
      const joined = concatLegPaths(layer);
      if (joined.length >= 2) layer.path = joined;
    }
    layer.routingStatus = {
      geometry: 'resolved',
      provider: layer.routing.source,
      ...(layer.routing.profile ? { profile: layer.routing.profile } : {}),
      coordinates: routeCoords(layer),
      updatedAt: layer.routing.updatedAt ?? new Date().toISOString(),
    };
    layer.stats = layerStats(layer);
    filled.push(layer.name);
  }
  return filled;
}

/**
 * The invariant a write owes the next write: geometry Cartula resolved fits the
 * derived budget, so the map that just succeeded can still be edited.
 *
 * Returns one reported line per layer it had to reduce. Distances and driving
 * times keep coming from the routing provider — a shorter drawn line never
 * becomes a shorter trip.
 */
export function enforceRouteGeometryBudget(layers: MapLayer[]): string[] {
  const reductions = fitDerivedGeometry(layers, layer => layer.routingStatus !== undefined);
  for (const reduction of reductions) {
    const layer = layers.find(item => item.id === reduction.layerId);
    if (layer) layer.stats = layerStats(layer);
  }
  return reductions.map(reductionMessage);
}
