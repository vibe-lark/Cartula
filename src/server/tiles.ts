import type { FastifyInstance } from 'fastify';
import { fetch, ProxyAgent } from 'undici';
/** Fixed deployment-configured tile source, never a user-supplied URL proxy. */
export async function registerTiles(app: FastifyInstance, upstream: string, proxyUrl?: string) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const origin = new URL(upstream.replace(/\{[zxy]\}/g, '0'));
  if (origin.protocol !== 'https:') throw new Error('TILE_UPSTREAM_URL must use HTTPS');
  const cache = new Map<string, { bytes: Buffer; expires: number }>();
  const pending = new Map<string, Promise<Buffer>>();
  let cacheBytes = 0;
  app.get<{ Params: { z: string; x: string; y: string } }>('/tiles/:z/:x/:y.png', {
    config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
    onSend: async (_request, reply) => { reply.header('Access-Control-Allow-Origin', '*'); },
  }, async (request, reply) => {
    const { z, x, y } = request.params;
    const values = [z, x, y];
    if (!values.every(v => /^\d{1,7}$/.test(v)) || +z > 19 || +x >= 2 ** +z || +y >= 2 ** +z) return reply.code(400).send({ error: 'Invalid tile coordinate' });
    const key = `${z}/${x}/${y}`;
    let cached = cache.get(key);
    if (cached && cached.expires <= Date.now()) { cacheBytes -= cached.bytes.length; cache.delete(key); cached = undefined; }
    let bytes = cached?.bytes;
    if (!bytes) {
      if (pending.size >= 24 && !pending.has(key)) return reply.code(503).header('Retry-After', '1').send({ error: 'Tile queue busy' });
      let promise = pending.get(key);
      if (!promise) {
        promise = (async () => {
          const url = upstream.replace('{z}', z).replace('{x}', x).replace('{y}', y);
          const response = await fetch(url, { dispatcher, redirect: 'error', headers: { 'User-Agent': 'Cartula/0.1.0 (internal map viewer)', Accept: 'image/png' }, signal: AbortSignal.timeout(12_000) });
          if (!response.ok || response.headers.has('x-blocked') || !response.headers.get('content-type')?.includes('image/png')) { await response.body?.cancel(); throw new Error('Basemap provider unavailable'); }
          if (Number(response.headers.get('content-length') ?? '0') > 512_000) { await response.body?.cancel(); throw new Error('Tile exceeds size limit'); }
          const chunks: Uint8Array[] = []; let length = 0;
          if (!response.body) throw new Error('Empty tile');
          for await (const chunk of response.body) { length += chunk.length; if (length > 512_000) throw new Error('Tile exceeds size limit'); chunks.push(chunk); }
          const data = Buffer.concat(chunks);
          if (data.length < 8 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG tile');
          while (cache.size && (cache.size >= 500 || cacheBytes + data.length > 32 * 1024 * 1024)) { const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest); }
          cache.set(key, { bytes: data, expires: Date.now() + 86400_000 }); cacheBytes += data.length;
          return data;
        })();
        pending.set(key, promise);
      }
      try { bytes = await promise; } catch { return reply.code(502).header('Cache-Control', 'no-store').send({ error: '底图暂时不可用，路线与编辑功能仍可使用。' }); }
      finally { pending.delete(key); }
    }
    return reply.header('Cache-Control', 'public, max-age=86400').type('image/png').send(bytes);
  });
  app.addHook('onClose', async () => { await dispatcher?.close(); });
}
