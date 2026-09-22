import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createApp } from '../src/server/app.js';
import { buildPluginPackage, PLUGIN_INDEX_PATH, PLUGIN_PACKAGE_PATH } from '../src/server/plugin.js';
import { GUIDE_VERSION, SKILL_TEXT } from '../src/server/guide.js';
import { RELEASE_VERSION } from '../src/core/release.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Read through the ZIP central directory, validating offsets and CRCs as an unzipper does. */
function unzip(archive: Buffer): Record<string, string> {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  assert.equal(offset + archive.readUInt32LE(end + 12), end);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    assert.equal(archive.readUInt16LE(offset + 10), 0, 'stored ZIP entries');
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
    assert.ok(!Object.hasOwn(files, name), 'no duplicate paths');
    const local = archive.readUInt32LE(offset + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    assert.equal(archive.subarray(local + 30, local + 30 + archive.readUInt16LE(local + 26)).toString(), name);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + size);
    assert.equal(data.length, size);
    assert.equal(crc32(data), archive.readUInt32LE(offset + 16), name);
    files[name] = data.toString();
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return files;
}

test('plugin downloads assemble the native Skill and this deployment MCP without request credentials', async t => {
  const publicUrl = 'https://cartula.example';
  const { app } = await createApp({ dbPath: ':memory:', publicUrl });
  t.after(() => app.close());
  const response = await app.inject(PLUGIN_INDEX_PATH);
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  const index = response.json();
  assert.equal(index.format, 'cartula-plugin-index-v1');
  assert.equal(index.version, RELEASE_VERSION);
  assert.equal(index.skillSha256, GUIDE_VERSION);
  assert.equal(index.mcpUrl, `${publicUrl}/mcp`);
  const download = await app.inject({ url: PLUGIN_PACKAGE_PATH, headers: {
    host: 'untrusted.example', 'x-forwarded-host': 'untrusted.example',
    authorization: 'Bearer private-test-key', cookie: 'cartula_session=private-test-session',
  } });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-type']), /^application\/zip/);
  assert.equal(index.sha256, sha256(download.rawPayload));
  assert.equal(index.size, download.rawPayload.length);
  const files = unzip(download.rawPayload);
  assert.deepEqual(Object.keys(files).sort(), [
    'cartula/LICENSE', 'cartula/README.md', 'cartula/mcp.json', 'cartula/plugin.json', 'cartula/skills/cartula/SKILL.md',
  ]);
  const manifest = JSON.parse(files['cartula/plugin.json']);
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.version, index.version);
  assert.equal(manifest.name, 'cartula');
  assert.equal(manifest.homepage, publicUrl);
  assert.deepEqual(JSON.parse(files['cartula/mcp.json']), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { cartula: { type: 'streamable-http', url: `${publicUrl}/mcp` } },
  });
  assert.equal(files['cartula/skills/cartula/SKILL.md'], readFileSync(new URL('../skills/cartula/SKILL.md', import.meta.url), 'utf8'));
  assert.equal(sha256(files['cartula/skills/cartula/SKILL.md']), index.skillSha256);
  assert.equal(files['cartula/LICENSE'], readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
  assert.doesNotMatch(download.rawPayload.toString(), /private-test-key|private-test-session|untrusted\.example/);

  const pinnedPath = new URL(index.downloadUrl).pathname;
  assert.equal(new URL(index.downloadUrl).origin, publicUrl);
  assert.ok(pinnedPath.includes(index.sha256));
  const pinned = await app.inject(pinnedPath);
  assert.equal(pinned.statusCode, 200);
  assert.deepEqual(pinned.rawPayload, download.rawPayload);
  assert.match(String(pinned.headers['cache-control']), /immutable/);
  assert.match(String(download.headers['cache-control']), /must-revalidate/);

  for (const path of [PLUGIN_INDEX_PATH, PLUGIN_PACKAGE_PATH, pinnedPath]) {
    const read = await app.inject(path);
    const unchanged = await app.inject({ url: path, headers: { 'if-none-match': `"older", W/${read.headers.etag}` } });
    assert.equal(unchanged.statusCode, 304, path);
    assert.equal(unchanged.body, '');
    const head = await app.inject({ method: 'HEAD', url: path });
    assert.equal(head.statusCode, 200, path);
    assert.equal(head.headers.etag, read.headers.etag);
    assert.equal(head.body, '');
  }
  const unknown = await app.inject(`/plugins/cartula-0.0.0-${'0'.repeat(64)}.zip`);
  assert.equal(unknown.statusCode, 404, 'old artifacts must not silently return new bytes');
  assert.equal(unknown.headers['cache-control'], 'no-store');
  assert.equal(unknown.json().indexPath, PLUGIN_INDEX_PATH);
  assert.deepEqual(unzip((await app.inject('/skills/cartula.zip')).rawPayload), { 'cartula/SKILL.md': SKILL_TEXT });
});

test('plugin identity includes the deployment URL and downloads use conditional revalidation', async t => {
  const beta = buildPluginPackage('https://beta.example/');
  const prod = buildPluginPackage('https://prod.example');
  assert.deepEqual(beta.archive, buildPluginPackage('https://beta.example').archive, 'same source yields reproducible bytes');
  assert.notEqual(beta.index.sha256, prod.index.sha256);
  assert.notEqual(beta.filename, prod.filename);
  const { app } = await createApp({ dbPath: ':memory:', publicUrl: 'https://prod.example' });
  t.after(() => app.close());
  const fresh = await app.inject({ url: PLUGIN_PACKAGE_PATH, headers: { 'if-none-match': `"${beta.index.sha256}"` } });
  assert.equal(fresh.statusCode, 200, 'a cached package for another endpoint cannot satisfy this download');
  assert.deepEqual(fresh.rawPayload, prod.archive);
  assert.equal((await app.inject(new URL(beta.index.downloadUrl).pathname)).statusCode, 404);
});

test('portable remote config rejects unsafe PUBLIC_URL without disabling the existing service', async t => {
  for (const url of [
    'http://cartula.example', 'https://name:secret@cartula.example',
    'https://cartula.example?key=secret', 'https://cartula.example#secret', 'file:///tmp/cartula',
  ]) assert.throws(() => buildPluginPackage(url), /PUBLIC_URL/);
  for (const url of ['http://localhost:3900', 'http://127.0.0.1:3900', 'http://[::1]:3900']) {
    assert.equal(buildPluginPackage(url).index.mcpUrl, `${url}/mcp`);
  }
  const { app } = await createApp({ dbPath: ':memory:', publicUrl: 'http://192.0.2.1:3900' });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  for (const path of [PLUGIN_INDEX_PATH, PLUGIN_PACKAGE_PATH]) {
    const unavailable = await app.inject(path);
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.headers['cache-control'], 'no-store');
    assert.match(unavailable.json().hint, /HTTPS/);
  }
});

test('release export contains an installable directory and the identical downloadable ZIP', t => {
  const out = mkdtempSync(join(tmpdir(), 'cartula-plugin-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const script = new URL('../scripts/package-plugin.ts', import.meta.url);
  const args = ['--import', 'tsx', script.pathname, '--public-url', 'https://release.example', '--out', out];
  const exported = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  const expected = buildPluginPackage('https://release.example');
  assert.deepEqual(readFileSync(exported.archive), expected.archive);
  for (const [path, body] of Object.entries(expected.files)) assert.equal(readFileSync(join(exported.directory, path), 'utf8'), body);
  assert.equal(readFileSync(`${exported.archive}.sha256`, 'utf8'), `${expected.index.sha256}  ${expected.filename}\n`);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })), exported, 'repeat export does not change identity');
});
