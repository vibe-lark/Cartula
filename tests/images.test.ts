import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { MAX_BYTES, checkImageUrl, isPublicAddress } from '../src/server/images.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = async (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response('missing', { status: 404 });
  };
  return { fetchImpl, calls };
}
const publicDns = async (hostname: string) => [{ address: hostname === 'private.example' ? '10.0.0.8' : '203.0.113.9', family: 4 }];

test('image URL rules: https only, real public host names, no credentials or odd ports', () => {
  assert.equal(checkImageUrl('https://pics.example/a.png').ok, true);
  const stripped = checkImageUrl('https://pics.example/a.png#frag');
  assert.ok(stripped.ok && stripped.url.toString() === 'https://pics.example/a.png');
  for (const bad of [
    'http://pics.example/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://127.0.0.1/a.png', 'https://[::1]/a.png',
    'https://localhost/a.png', 'https://app.localhost/a.png', 'https://nas.local/a.png', 'https://db.internal/a.png', 'https://router.home.arpa/a.png',
    'https://intranet/a.png', 'https://user:pw@pics.example/a.png', 'https://pics.example:8443/a.png', '', 'not a url', `https://pics.example/${'a'.repeat(2100)}`,
  ]) assert.equal(checkImageUrl(bad).ok, false, bad);
});

test('non-public addresses are recognised in both families', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), true, address);
});

test('the proxy serves raster pictures from public HTTPS hosts and refuses everything else', async t => {
  const { fetchImpl, calls } = fakeFetch({
    'https://pics.example/a.png': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    'https://pics.example/page.html': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    'https://pics.example/logo.svg': () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    'https://pics.example/moved': () => new Response(null, { status: 302, headers: { location: '/a.png' } }),
    'https://pics.example/leak': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.8/secret.png' } }),
    'https://pics.example/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    'https://pics.example/big.png': () => new Response(Buffer.alloc(MAX_BYTES + 1), { status: 200, headers: { 'content-type': 'image/png' } }),
    'https://pics.example/declared-big.png': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) } }),
    'https://private.example/a.png': () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  });
  const { app } = await createApp({ dbPath: ':memory:', imageFetch: fetchImpl, imageLookup: publicDns });
  t.after(() => app.close());
  const get = (u: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/img?u=${encodeURIComponent(u)}`, headers });

  const ok = await get('https://pics.example/a.png');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
  assert.equal(ok.headers['access-control-allow-origin'], '*');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.ok(ok.rawPayload.equals(PNG));
  const fetched = calls.length;
  assert.equal((await get('https://pics.example/a.png')).statusCode, 200);
  assert.equal(calls.length, fetched, 'a second request is served from the cache');

  // An <img> inside an opaque App frame sends no Origin; a page that does is still served.
  assert.equal((await get('https://pics.example/a.png', { origin: 'https://elsewhere.example' })).statusCode, 200);

  assert.equal((await get('https://pics.example/moved')).statusCode, 200, 'same-host https redirects are followed');
  assert.equal((await get('https://pics.example/leak')).statusCode, 502, 'a redirect to a cleartext or private target is refused');
  assert.equal((await get('https://pics.example/loop')).statusCode, 502);
  assert.equal((await get('https://pics.example/page.html')).statusCode, 502);
  assert.equal((await get('https://pics.example/logo.svg')).statusCode, 502, 'SVG is a document, not a picture');
  assert.equal((await get('https://pics.example/big.png')).statusCode, 502);
  assert.equal((await get('https://pics.example/declared-big.png')).statusCode, 502);
  assert.equal((await get('https://private.example/a.png')).statusCode, 502, 'a public name resolving to a private address is refused');
  assert.equal((await get('https://missing.example/a.png')).statusCode, 502);
  for (const bad of ['http://pics.example/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png']) {
    const refused = await get(bad);
    assert.equal(refused.statusCode, 400, bad);
    assert.equal(refused.headers['cache-control'], 'no-store');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/img' })).statusCode, 400);
});
