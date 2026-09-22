import type { FastifyInstance } from 'fastify';
import { fetch, ProxyAgent } from 'undici';

/** OpenFreeMap permits public and commercial use without an API key. */
export async function registerBasemap(app: FastifyInstance, publicUrl: string, proxy?: string) {
  const upstream = 'https://tiles.openfreemap.org/';
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  type Asset = { bytes: Buffer; type: string; expires: number };
  const cache = new Map<string, Asset>();
  const pending = new Map<string, Promise<Asset>>();
  let size = 0;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith(upstream) ? `${publicUrl}/basemap/${value.slice(upstream.length)}` : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, rewrite(v)]));
    return value;
  };
  app.get<{ Params: { '*': string } }>('/basemap/*', {
    config: { rateLimit: { max: 1800, timeWindow: '1 minute' } },
    // Public, credential-free assets: expose real errors to opaque App frames
    // too, including rate-limit responses sent before the handler runs.
    onSend: async (_request, reply) => { reply.header('Access-Control-Allow-Origin', '*'); },
  }, async (request, reply) => {
    const path = request.params['*'];
    if (path.length > 512 || !/^(?:styles\/(?:positron|liberty|bright|dark)$|planet(?:\/|$)|fonts\/|sprites\/|natural_earth\/)/.test(path) || /[\\?#\x00-\x1f]/.test(path) || path.split('/').includes('..')) return reply.code(400).send({ error: 'Invalid basemap asset' });
    let asset = cache.get(path);
    if (asset && asset.expires < Date.now()) { size -= asset.bytes.length; cache.delete(path); asset = undefined; }
    if (!asset) {
      if (pending.size >= 48 && !pending.has(path)) return reply.code(503).send({ error: 'Basemap queue busy' });
      let task = pending.get(path);
      if (!task) {
        task = (async () => {
          const response = await fetch(new URL(path, upstream), { dispatcher, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Cartula/0.1.0 interactive map' } });
          if (!response.ok) { await response.body?.cancel(); throw new Error('Basemap unavailable'); }
          const type = response.headers.get('content-type') ?? '';
          if (/html/.test(type) || !response.body) { await response.body?.cancel(); throw new Error('Unexpected basemap response'); }
          const chunks: Uint8Array[] = []; let length = 0;
          for await (const chunk of response.body) { length += chunk.length; if (length > 4 * 1024 * 1024) throw new Error('Basemap asset too large'); chunks.push(chunk); }
          let bytes = Buffer.concat(chunks);
          if (type.includes('json')) bytes = Buffer.from(JSON.stringify(rewrite(JSON.parse(bytes.toString()))));
          const result = { bytes, type: type || 'application/octet-stream', expires: Date.now() + 3600_000 };
          while (cache.size && (cache.size >= 800 || size + bytes.length > 48 * 1024 * 1024)) { const key = cache.keys().next().value!; size -= cache.get(key)!.bytes.length; cache.delete(key); }
          cache.set(path, result); size += bytes.length; return result;
        })();
        pending.set(path, task);
      }
      try { asset = await task; } catch { return reply.code(502).header('Cache-Control', 'no-store').send({ error: '底图资源暂时不可用' }); }
      finally { pending.delete(path); }
    }
    return reply.header('Cache-Control', 'public, max-age=3600').type(asset.type).send(asset.bytes);
  });
  app.addHook('onClose', async () => { await dispatcher?.close(); });
}
