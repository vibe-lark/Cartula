import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutAnnotations, layoutLabels, type LegLabelCandidate } from '../src/web/components/labels.js';
import { languageExpression } from '../src/web/components/preferences.js';

function leg(key: string, ax: number, ay: number, lengthPx: number, extra: Partial<LegLabelCandidate> = {}): LegLabelCandidate {
  return { key, text: '325 km 直线', ax, ay, dirX: 1, dirY: 0, lengthPx, ...extra };
}
interface Box { left: number; right: number; top: number; bottom: number }
const pillBox = (p: { x: number; y: number; width: number; height: number }): Box => ({ left: p.x - p.width / 2 - 2, right: p.x + p.width / 2 + 2, top: p.y - p.height / 2 - 2, bottom: p.y + p.height / 2 + 2 });
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test('screen-space labels never overlap and crowded maps retain unlabelled markers as input', () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ key: `p${i}`, name: `站点 ${i}`, x: 100 + i % 10 * 30, y: 100 + Math.floor(i / 10) * 30 }));
  const labels = layoutLabels(nodes, 600, 600, 5);
  assert.ok(labels.length > 0 && labels.length < nodes.length);
  for (const [i, a] of labels.entries()) for (const b of labels.slice(i + 1)) {
    assert.ok(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || a.y <= b.y - b.height || b.y <= a.y - a.height, `${a.key} overlaps ${b.key}`);
  }
  assert.equal(nodes.length, 100);
});
test('zoom and separation reveal labels; selected points take priority and long names wrap', () => {
  const points = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, name: `城市地点${i}`, x: 200, y: 200, selected: i === 39 }));
  const dense = layoutLabels(points, 800, 600, 3);
  assert.ok(dense.some(label => label.key === 'p39'));
  const separated = layoutLabels(points.map((p, i) => ({ ...p, x: 70 + i % 8 * 95, y: 80 + Math.floor(i / 8) * 100 })), 900, 600, 12);
  assert.ok(separated.length > dense.length);
  const long = '很长的地点名称'.repeat(6);
  const label = layoutLabels([{ key: 'long', name: long, x: 150, y: 280, selected: true }], 320, 480, 4)[0];
  assert.equal(label.text.replaceAll('\n', ''), long); assert.ok(label.text.includes('\n')); assert.ok(label.width < 300);
});
test('a selected label in a tight grid still places even when neighbours block every offset', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    key: `spots p${i}`,
    name: `${i + 1} 重叠地点 ${i}`,
    x: 360 + (i % 10) * 8,
    y: 280 + Math.floor(i / 10) * 8,
    selected: i === 25,
  }));
  const labels = layoutLabels(nodes, 800, 600, 8);
  assert.ok(labels.some(label => label.key === 'spots p25'), 'selected label is preserved');
  assert.ok(labels.length < nodes.length);
});
test('offscreen points do not consume label space and language has a local fallback', () => {
  assert.deepEqual(layoutLabels([{ key: 'a', name: 'a', x: -50, y: 50 }], 500, 500, 4), []);
  assert.deepEqual(languageExpression('zh').slice(0, 4), ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh'], ['get', 'name']]);
  assert.deepEqual(languageExpression('zh-Hant').slice(0, 4), ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name']]);
  assert.deepEqual(languageExpression('en')[1], ['get', 'name:en']);
  assert.deepEqual(languageExpression('local')[1], ['get', 'name']);
});

test('leg pills respect the density gates: auto hides short legs, all reveals them, off hides everything', () => {
  const nodes = [{ key: 'a', name: '甲', x: 100, y: 300 }, { key: 'b', name: '乙', x: 155, y: 300 }];
  const short = leg('r a->b', 127.5, 300, 50);
  assert.equal(layoutAnnotations(nodes, [short], 800, 600, 8).legs.length, 0, 'auto gates a 50px leg');
  assert.equal(layoutAnnotations(nodes, [short], 800, 600, 8, { mode: 'all' }).legs.length, 1, 'all reveals it');
  assert.equal(layoutAnnotations(nodes, [short], 800, 600, 8, { mode: 'off' }).legs.length, 0, 'off hides everything');
  assert.equal(layoutAnnotations(nodes, [{ ...short, forced: true }], 800, 600, 8).legs.length, 1, 'forced bypasses the gate');
  assert.equal(layoutAnnotations(nodes, [{ ...short, active: true }], 800, 600, 8).legs.length, 1, 'active layer has a lower gate');
  const long = leg('r a->b', 400, 300, 120);
  assert.equal(layoutAnnotations([], [long], 800, 600, 8).legs.length, 1, 'auto keeps a long leg');
});

test('leg pills never collide with node labels, markers or each other', () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ key: `p${i}`, name: `站点${i}`, x: 100 + i * 200, y: 300 }));
  const legs = nodes.slice(1).map((node, i) => leg(`r p${i}->p${i + 1}`, (nodes[i].x + node.x) / 2, 300, 200, { text: '驾车 · 325 km · 4 小时 5 分钟' }));
  const { labels, legs: pills } = layoutAnnotations(nodes, legs, 1200, 800, 8);
  assert.ok(pills.length > 0);
  const labelBoxes: Box[] = labels.map(l => ({ left: l.x - l.width / 2 - 3, right: l.x + l.width / 2 + 3, top: l.y - l.height - 3, bottom: l.y + 3 }));
  const markerBoxes: Box[] = nodes.map(n => ({ left: n.x - 6, right: n.x + 6, top: n.y - 6, bottom: n.y + 6 }));
  const boxes = pills.map(pillBox);
  for (const [i, box] of boxes.entries()) {
    for (const other of [...labelBoxes, ...markerBoxes]) assert.ok(!overlaps(box, other), `pill ${pills[i].key} overlaps a label or marker`);
    for (const other of boxes.slice(i + 1)) assert.ok(!overlaps(box, other), `pill ${pills[i].key} overlaps another pill`);
  }
});

test('auto mode caps pill count; forced legs may exceed the cap by a small margin', () => {
  const legs = Array.from({ length: 30 }, (_, i) => leg(`r a${i}->b${i}`, 100 + (i % 6) * 190, 100 + Math.floor(i / 6) * 140, 200, { text: '5 km 直线' }));
  const nodes = [{ key: 'n0', name: '远点', x: 600, y: 780 }];
  assert.equal(layoutAnnotations(nodes, legs, 1200, 800, 8).legs.length, 20, 'auto budget at this viewport is 20');
  assert.equal(layoutAnnotations(nodes, legs, 1200, 800, 8, { mode: 'all' }).legs.length, 30, 'all mode fits every pill');
  const forced = legs.map((l, i) => ({ ...l, forced: i < 26 }));
  assert.equal(layoutAnnotations(nodes, forced, 1200, 800, 8).legs.length, 24, 'forced overflow is capped at budget + 4');
});

test('off-screen anchors are skipped and pill offsets sit perpendicular to the segment', () => {
  const nodes = [{ key: 'a', name: '甲', x: 100, y: 100 }, { key: 'b', name: '乙', x: 400, y: 100 }];
  const placed = layoutAnnotations(nodes, [leg('r a->b', 250, 100, 300)], 800, 600, 8).legs;
  assert.equal(placed.length, 1);
  assert.notEqual(placed[0].offset[1], 0, 'perpendicular offset');
  assert.deepEqual(layoutAnnotations(nodes, [leg('off', 900, 100, 300)], 800, 600, 8).legs, []);
});

test('labels clear the marker they name: a pin head lifts its label, a wide disc pushes it out', () => {
  const [pin] = layoutLabels([{ key: 'pin', name: '衡山宾馆', x: 300, y: 300, markerRadius: 18, markerTop: 41 }], 800, 600, 14);
  assert.ok(pin.y <= 300 - 41 - 12, `label bottom ${pin.y} sits above the pin head`);
  const [disc] = layoutLabels([{ key: 'disc', name: '徐家汇天主堂', x: 300, y: 300, markerRadius: 16 }], 800, 600, 14);
  assert.ok(disc.y <= 300 - 16 - 12, `label bottom ${disc.y} clears the disc and its halo`);
  const [dot] = layoutLabels([{ key: 'dot', name: '小点', x: 300, y: 300 }], 800, 600, 14);
  assert.equal(dot.y, 300 - 18, 'a bare 6px dot keeps the historical lift');
});
