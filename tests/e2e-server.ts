import { createApp } from '../src/server/app.js';
const { app } = await createApp({ dbPath: ':memory:', publicUrl: 'http://127.0.0.1:3911',
  basemapStyle: 'liberty',
  tileProxy: process.env.TILE_PROXY_URL,
  tileAttribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: '127.0.0.1', port: 3911 });
