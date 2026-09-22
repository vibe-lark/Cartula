import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createApp } from '../src/server/app.js';

test('public map assets expose success and failure to opaque frames without opening business APIs', async t => {
  const original = getGlobalDispatcher();
  const upstream = new MockAgent(); upstream.disableNetConnect();
  setGlobalDispatcher(upstream);
  t.after(async () => { setGlobalDispatcher(original); await upstream.close(); });
  const vector = upstream.get('https://tiles.openfreemap.org');
  vector.intercept({ path: '/styles/liberty' }).reply(200, { version: 8, sources: {}, layers: [] }, { headers: { 'content-type': 'application/json' } });
  vector.intercept({ path: '/planet/fail.pbf' }).reply(503, 'down');
  vector.intercept({ path: '/planet/redirect.pbf' }).reply(302, '', { headers: { location: 'https://untrusted.example/tile' } });
  const raster = upstream.get('https://tiles.example');
  raster.intercept({ path: '/0/0/0.png' }).reply(503, 'down');
  const { app } = await createApp({ dbPath: ':memory:', basemapStyle: 'liberty', tileUpstream: 'https://tiles.example/{z}/{x}/{y}.png' });
  t.after(() => app.close());
  const headers = { origin: 'null' };
  for (const [url, status] of [
    ['/basemap/styles/liberty', 200],
    ['/basemap/nope', 400],
    ['/basemap/planet/fail.pbf', 502],
    ['/basemap/planet/redirect.pbf', 502],
    ['/tiles/20/0/0.png', 400],
    ['/tiles/0/0/0.png', 502],
  ] as const) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, status, url);
    assert.equal(response.headers['access-control-allow-origin'], '*', url);
    assert.equal(response.headers['access-control-allow-credentials'], undefined, url);
  }
  // The policy belongs only to registered public asset routes.
  for (const url of ['/mcp', '/api/config', '/m/private-map']) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 403, url);
    assert.equal(response.headers['access-control-allow-origin'], undefined, url);
  }
  upstream.assertNoPendingInterceptors();
});

test('a rate limit before the public asset handler still has CORS', async t => {
  const { app } = await createApp({ dbPath: ':memory:', basemapStyle: 'liberty' });
  t.after(() => app.close());
  // Invalid requests need no upstream; use the real route limiter, not a fake 429.
  for (let i = 0; i < 1800; i++) {
    assert.equal((await app.inject({ url: '/basemap/nope', headers: { origin: 'null' } })).statusCode, 400);
  }
  const response = await app.inject({ url: '/basemap/nope', headers: { origin: 'null' } });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['access-control-allow-origin'], '*');
});
