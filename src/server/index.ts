import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3900);
const { app } = await createApp({
  dbPath: process.env.DATABASE_PATH ?? './data/cartula.sqlite',
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  tileUrl: process.env.TILE_URL || undefined,
  basemapStyle: process.env.BASEMAP_STYLE || undefined,
  tileUpstream: process.env.TILE_UPSTREAM_URL,
  tileProxy: process.env.TILE_PROXY_URL,
  tileAttribution: process.env.TILE_ATTRIBUTION,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean),
  allowedHosts: process.env.ALLOWED_HOSTS?.split(',').filter(Boolean),
  maxMaps: Number(process.env.MAX_MAPS ?? 1000),
  osrmUrl: process.env.OSRM_URL === '' ? undefined : (process.env.OSRM_URL || 'https://router.project-osrm.org'),
  osrmProxy: process.env.OSRM_PROXY_URL || process.env.TILE_PROXY_URL || undefined,
  logger: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
