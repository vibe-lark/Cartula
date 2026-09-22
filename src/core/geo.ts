/**
 * Spherical distance and CRS helpers. Pure functions, no I/O, no globals:
 * identical results in the browser, the Fastify server and the offline bundle.
 *
 * Distances are great-circle ("straight line") distances on a sphere. They are
 * NOT road distances and must never be presented as driving mileage or time.
 */
import type { Coord } from './types.js';

/** IUGG mean Earth radius, in kilometres. */
const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two WGS84 coordinates, in kilometres. */
export function haversineKm(a: Coord, b: Coord): number {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  if (![lonA, latA, lonB, latB].every(Number.isFinite)) return 0;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * sinLon * sinLon;
  // asin form stays accurate for short legs; clamp guards float overshoot at antipodes.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Length of a polyline: the sum of great-circle legs between consecutive
 * coordinates. Fewer than two coordinates means zero length.
 */
export function routeDistance(points: Coord[]): number {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

// --- GCJ-02 -> WGS84 ------------------------------------------------------
// GCJ-02 ("Mars coordinates") is the obfuscated datum used by Chinese map
// providers. The published offset is only defined inside China, so anything
// outside the mainland bounding box is returned untouched.

const GCJ_A = 6378245.0; // Krasovsky 1940 semi-major axis used by the GCJ-02 offset
const GCJ_EE = 0.00669342162296594323; // and its squared eccentricity

function outOfChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

/** Offset added to a WGS84 coordinate to obtain the GCJ-02 one. */
function offset(lon: number, lat: number): Coord {
  const dLat = transformLat(lon - 105, lat - 35);
  const dLon = transformLon(lon - 105, lat - 35);
  const radLat = toRad(lat);
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return [
    (dLon * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI),
    (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI),
  ];
}

const round7 = (n: number): number => Math.round(n * 1e7) / 1e7;

/**
 * Convert a GCJ-02 coordinate to WGS84.
 *
 * The forward offset is only invertible numerically, so this iterates the fixed
 * point `w = gcj - offset(w)`; three passes land within a millimetre across
 * China. Coordinates outside China (and non-finite input) are returned as-is,
 * because the offset is undefined there and converting would introduce error.
 */
export function gcj02ToWgs84(at: Coord): Coord {
  const [lon, lat] = at;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || outOfChina(lon, lat)) return [lon, lat];
  let wgsLon = lon;
  let wgsLat = lat;
  for (let i = 0; i < 3; i += 1) {
    const [dLon, dLat] = offset(wgsLon, wgsLat);
    wgsLon = lon - dLon;
    wgsLat = lat - dLat;
  }
  return [round7(wgsLon), round7(wgsLat)];
}
