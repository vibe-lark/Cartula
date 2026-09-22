/**
 * What the credits dialog is allowed to say, and where it gets it from.
 *
 * Moving the attribution off the map does not weaken it: a provider's own
 * credit — including its links — has to survive intact, no markup may reach the
 * DOM as markup, and the component list has to keep describing the build it
 * actually ships with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPEN_SOURCE_COMPONENTS, mentionsOsm, parseAttribution } from '../src/web/components/credits.js';

/** The credit OpenFreeMap serves in its TileJSON, verbatim. */
const OPENFREEMAP = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

test("a provider's credit keeps every name and every link it came with", () => {
  assert.deepEqual(parseAttribution(OPENFREEMAP), [
    { text: 'OpenFreeMap', href: 'https://openfreemap.org' },
    { text: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
    { text: 'Data from' },
    { text: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
  ]);
  // The rendered sentence still reads as the provider wrote it.
  assert.equal(parseAttribution(OPENFREEMAP).map(part => part.text).join(' '), 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
});

test('plain-text attribution passes through untouched', () => {
  assert.deepEqual(parseAttribution('© OpenStreetMap 贡献者'), [{ text: '© OpenStreetMap 贡献者' }]);
  assert.deepEqual(parseAttribution('  '), []);
});

test('no markup survives, and only http(s) links stay links', () => {
  const hostile = '<img src=x onerror=alert(1)><a href="javascript:alert(1)">点我</a><script>alert(2)</script>正常文字';
  const parts = parseAttribution(hostile);
  assert.deepEqual(parts, [{ text: '点我' }, { text: '正常文字' }]);
  for (const part of parts) {
    assert.doesNotMatch(part.text, /[<>]/, '标签不得进入渲染内容');
    assert.equal(part.href, undefined, 'javascript: 链接不得保留为链接');
  }
  // A relative or protocol-relative href keeps its label and loses its target.
  assert.deepEqual(parseAttribution('<a href="/local">本地</a>'), [{ text: '本地' }]);
  assert.deepEqual(parseAttribution("<a href='HTTPS://example.org/x'>大写协议</a>"), [{ text: '大写协议', href: 'HTTPS://example.org/x' }]);
});

test('the ODbL sentence appears for OpenStreetMap data and for nothing else', () => {
  assert.equal(mentionsOsm([OPENFREEMAP]), true);
  assert.equal(mentionsOsm(['© OpenStreetMap contributors']), true);
  assert.equal(mentionsOsm(['© 天地图']), false);
  assert.equal(mentionsOsm([]), false);
});

test('the listed components match the ones this build actually ships', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const item of OPEN_SOURCE_COMPONENTS) {
    const declared = pkg.dependencies[item.pkg];
    assert.ok(declared, `${item.pkg} 不在依赖里，声明就成了空话`);
    assert.equal(declared.replace(/^[\^~]/, ''), item.version, `${item.pkg} 版本与 package.json 不一致`);
    assert.ok(notices.includes(`## ${item.pkg} ${item.version} (${item.license})`), `${item.pkg} 与 THIRD_PARTY_NOTICES.md 对不上`);
    assert.match(item.url, /^https:\/\//);
    assert.ok(item.role.length > 0, `${item.pkg} 要说明它在这里做什么`);
  }
});
