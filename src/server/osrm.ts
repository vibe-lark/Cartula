import { fetch, ProxyAgent } from 'undici';
import { parseOsrmRoute, type OsrmProfile, type ParsedOsrmRoute } from '../core/osrm.js';
import { RELEASE_VERSION } from '../core/release.js';
import type { Coord } from '../core/types.js';

export interface OsrmClientOptions {
  baseUrl: string;
  proxy?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOsrmClient(options: OsrmClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '');
  const dispatcher = options.proxy ? new ProxyAgent(options.proxy) : undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const cache = new Map<string, ParsedOsrmRoute>();

  /**
   * The cache is keyed by profile and coordinates, but a parsed route carries
   * the *caller's* point ids on its legs. Two layers can ask for the same road
   * with different stop ids — a duplicated plan, or two alternatives sharing a
   * section — so a cache hit has to be re-labelled with the ids of the layer
   * asking now. Legs are positional (`legs[i]` joins `points[i]` to
   * `points[i+1]`), which makes the relabelling exact.
   */
  const relabel = (route: ParsedOsrmRoute, points: Array<{ id: string; at: Coord }>): ParsedOsrmRoute | undefined => {
    if (route.legs.length !== points.length - 1) return undefined;
    return { ...route, legs: route.legs.map((leg, i) => ({ ...leg, fromPointId: points[i].id, toPointId: points[i + 1].id })) };
  };

  return async function route(input: { profile: OsrmProfile; points: Array<{ id: string; at: Coord }> }): Promise<ParsedOsrmRoute | undefined> {
    const coords = input.points.map(point => `${point.at[0]},${point.at[1]}`).join(';');
    const cacheKey = `${input.profile}:${coords}`;
    const cached = cache.get(cacheKey);
    if (cached) return relabel(cached, input.points);
    const url = `${base}/route/v1/${input.profile}/${coords}?overview=simplified&geometries=geojson&steps=true&alternatives=false`;
    const response = await fetchImpl(url, {
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      // Taken from the release constant rather than written out, so the version
      // this identifies itself with cannot fall behind the one it ships as.
      headers: { Accept: 'application/json', 'User-Agent': `Cartula/${RELEASE_VERSION} (route resolve)` },
    } as Parameters<typeof fetch>[1]);
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const payload = await response.json();
    const parsed = parseOsrmRoute(payload, input.points, input.profile);
    if (!parsed) return undefined;
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, parsed);
    return parsed;
  };
}
