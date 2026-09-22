import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

/**
 * The image proxy behind every `point.img` the cards show.
 *
 * An Agent hands Cartula an HTTPS URL and nothing else, and the card has to
 * show it in two places that cannot load it directly: an MCP host frames the
 * App under a CSP whose `img-src` is the domains the App declared (its own,
 * and the tile server), so a picture on any other host is simply blocked; and
 * a plain `<img>` pointed at an arbitrary server leaks the reader's address
 * and the map's existence to whoever runs it. So the browser only ever asks
 * Cartula, and Cartula fetches the picture the way it fetches tiles — through
 * the deployment's egress proxy when it has one, with a timeout, a size cap
 * and no credentials of any kind.
 *
 * What is refused, and why:
 *  - anything but `https:` — no cleartext, no `data:`/`file:`/`javascript:`;
 *  - IP literals, `localhost`, `.local`/`.internal`/`.home.arpa` names and,
 *    without an egress proxy, any name that resolves to a private, loopback,
 *    link-local or otherwise non-public address — the proxy must not be a
 *    door into the network Cartula runs in;
 *  - redirects to anywhere those rules would have refused;
 *  - responses that are not raster images. SVG is an image the browser
 *    would happily draw, but a document served from Cartula's own origin runs
 *    scripts under Cartula's policy the moment someone opens it directly,
 *    so it is treated as "not a picture";
 *  - bodies over `MAX_BYTES`.
 */
export const IMAGE_PATH = '/img';
export const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const CACHE_ENTRIES = 96;
const CACHE_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|bmp)(?:\s*;.*)?$/i;

export interface ImageProxyOptions {
  /** Egress HTTP proxy, the same one tiles and routing use. */
  proxy?: string;
  /** Test seam; `undici.fetch` in production. */
  fetchImpl?: typeof undiciFetch;
  /** Test seam; `dns.promises.lookup` in production. */
  lookupImpl?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

type Verdict = { ok: true; url: URL } | { ok: false; reason: string };

/** Loopback, private, link-local, CGNAT, multicast, unspecified — never public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && parts[2] === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return false; // link-local fe80::/10
    if (/^ff/.test(lower)) return false; // multicast
    return true;
  }
  return false;
}

/** The URL rules that need no network: scheme, host shape, no credentials. */
export function checkImageUrl(raw: string): Verdict {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return { ok: false, reason: '图片地址必须是 2048 字符以内的 HTTPS 链接' };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: '图片地址不是合法的 URL' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: '图片只接受 HTTPS 链接' };
  if (url.username || url.password) return { ok: false, reason: '图片地址不能携带用户名或密码' };
  if (url.port && url.port !== '443') return { ok: false, reason: '图片地址只允许默认端口' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || isIP(host)) return { ok: false, reason: '图片地址必须使用域名，不能是 IP' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || !host.includes('.')) {
    return { ok: false, reason: '图片地址必须是公网域名' };
  }
  url.hash = '';
  return { ok: true, url };
}

export async function registerImages(app: FastifyInstance, options: ImageProxyOptions = {}) {
  const dispatcher = options.proxy ? new ProxyAgent(options.proxy) : undefined;
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const lookupImpl = options.lookupImpl ?? (async (hostname: string) => lookup(hostname, { all: true }));
  type Cached = { bytes: Buffer; type: string; expires: number };
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;
  const remember = (key: string, value: Cached) => {
    while (cache.size && (cache.size >= CACHE_ENTRIES || cacheBytes + value.bytes.length > CACHE_BYTES)) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes.length;
      cache.delete(oldest);
    }
    cache.set(key, value);
    cacheBytes += value.bytes.length;
  };

  /** Without an egress proxy Cartula connects itself, so the name must resolve somewhere public. */
  const resolvesPublic = async (url: URL): Promise<boolean> => {
    if (options.proxy) return true;
    try {
      const addresses = await lookupImpl(url.hostname);
      return addresses.length > 0 && addresses.every(entry => isPublicAddress(entry.address));
    } catch { return false; }
  };

  const load = async (start: URL): Promise<Cached> => {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await resolvesPublic(url))) throw new Error('not public');
      const response = await fetchImpl(url, {
        dispatcher, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Cartula/0.4 image card', Accept: 'image/png,image/jpeg,image/webp,image/avif,image/gif,image/*;q=0.8' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect without location');
        const next = checkImageUrl(new URL(location, url).toString());
        if (!next.ok) throw new Error('redirect refused');
        url = next.url;
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`upstream ${response.status}`); }
      const type = (response.headers.get('content-type') ?? '').trim();
      if (!IMAGE_TYPES.test(type)) { await response.body.cancel(); throw new Error('not an image'); }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) { await response.body.cancel(); throw new Error('too large'); }
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_BYTES) { await response.body.cancel().catch(() => undefined); throw new Error('too large'); }
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), type: type.split(';')[0].trim().toLowerCase(), expires: Date.now() + CACHE_TTL_MS };
    }
    throw new Error('too many redirects');
  };

  app.get<{ Querystring: { u?: string } }>(IMAGE_PATH, {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    // Public, credential-free bytes; the opaque App frame must see real errors too.
    onSend: async (_request, reply) => { reply.header('Access-Control-Allow-Origin', '*'); },
  }, async (request, reply) => {
    const verdict = checkImageUrl(String(request.query.u ?? ''));
    if (!verdict.ok) return reply.code(400).header('Cache-Control', 'no-store').send({ error: verdict.reason });
    const key = verdict.url.toString();
    let cached = cache.get(key);
    if (cached && cached.expires < Date.now()) { cacheBytes -= cached.bytes.length; cache.delete(key); cached = undefined; }
    if (!cached) {
      try { cached = await load(verdict.url); }
      catch { return reply.code(502).header('Cache-Control', 'no-store').send({ error: '图片暂时无法加载' }); }
      remember(key, cached);
    }
    return reply.header('Cache-Control', 'public, max-age=86400').header('Content-Disposition', 'inline').type(cached.type).send(cached.bytes);
  });
  app.addHook('onClose', async () => { await dispatcher?.close(); });
}
