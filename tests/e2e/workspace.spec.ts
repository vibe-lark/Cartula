import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { MapSnapshot, WriteResult } from '../../src/core/types.js';
import { DEMO_INPUT } from '../../src/core/demo.js';
import { WebMercatorViewport } from '@deck.gl/core';
import { focusBounds, padBounds } from '../../src/web/components/geo.js';

async function createMap(request: APIRequestContext) {
  const response = await request.put(`/m/e2e-${randomUUID()}`, { data: DEMO_INPUT });
  expect(response.ok()).toBeTruthy();
  return await response.json() as WriteResult;
}
async function readMap(request: APIRequestContext, map: WriteResult) { return await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json() as MapSnapshot; }
/**
 * Put a layer's stop list on the stage and keep it there.
 *
 * The list is on screen only while the pointer rests on the layer's dot in
 * the rail or on the list itself, and it goes a moment after the pointer
 * leaves — so a list left over from an earlier step is not a stable thing to
 * reach into. A press on the dot opens it (and frames the layer), and moving
 * onto it is what holds it, the way a person does.
 */
async function openLayer(page: Page, layerId: string) {
  const panel = page.locator('.layer-panel');
  const dot = page.getByTestId(`layer-${layerId}`);
  const marker = layerId === 'greater-khingan' ? 'jiagedaqi' : 'harbin';
  // A list still on screen from an earlier step may be a moment from going;
  // resting on its dot is what cancels that, so go there first either way.
  if (await panel.isVisible() && await panel.getByTestId(`point-${marker}`).count()) await dot.hover();
  else await dot.click();
  await expect(panel.getByTestId(`point-${marker}`)).toBeVisible();
  await panel.hover();
  return panel;
}
/** Open the 路段标注 top-bar menu and pick one density item. */
async function setLegMode(page: Page, label: '自动' | '全部' | '隐藏') {
  await page.getByRole('button', { name: '路段标注', exact: true }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
}
/** Click an empty patch of map to place a new point, then fill the minimal form. */
async function addPointAtMapCenter(page: Page, name: string) {
  await openLayer(page, 'lesser-khingan');
  await page.getByRole('button', { name: '添加地点', exact: true }).click();
  const box = (await page.locator('.map-canvas').boundingBox())!;
  // Off the routes: the demo map's legs run through the exact centre.
  await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.28);
  await page.getByLabel('地点名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '确认添加', exact: true }).click();
}
/**
 * Bring a folding panel out.
 *
 * The panels over the map show their heading and fold the rest away when the
 * pointer is elsewhere, so a test reaches into one the way a person does: move
 * onto it first. Playwright will not move the mouse to a hidden control, which
 * is exactly the deadlock this avoids.
 */
async function reveal(page: Page, selector: string) {
  const panel = page.locator(selector);
  await panel.hover();
  await expect(panel).toHaveAttribute('data-collapsed', 'false');
  return panel;
}
async function editFirstNote(page: Page, note: string) {
  await openLayer(page, 'lesser-khingan');
  await page.getByTestId('point-harbin').getByRole('button').first().click();
  await reveal(page, '.point-popover');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill(note);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
}

test('Agent data renders with real tiles; user edits and imports become semantic changes', async ({ page, request }, info) => {
  const map = await createMap(request);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const tile = page.waitForResponse(response => /\/basemap\/planet\/.+\.pbf/.test(response.url()) && response.status() === 200);
  await page.goto(map.editUrl!);
  await expect(page.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
  await tile;
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  // The credit is off the map and behind the menu, but it is complete when it
  // is opened and it still carries the provider's own links.
  await expect(page.locator('.maplibregl-ctrl-attrib')).toHaveCount(0);
  await expect(page.getByText('OpenFreeMap', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '地图数据与开源声明', exact: true }).click();
  const credits = page.getByRole('dialog', { name: '地图数据与开源声明' });
  await expect(credits.getByRole('link', { name: 'OpenFreeMap', exact: true })).toHaveAttribute('href', 'https://openfreemap.org');
  await expect(credits.getByRole('link', { name: 'OpenStreetMap', exact: true })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  await expect(credits.getByText('MapLibre GL JS', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('credits.png') });
  await credits.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.screenshot({ path: info.outputPath('workspace.png') });
  await editFirstNote(page, 'Warning: 这里补给后再出发');
  await expect.poll(async () => (await readMap(request, map)).layers[0].points[0].note).toBe('Warning: 这里补给后再出发');
  await openLayer(page, 'lesser-khingan');
  // 哈尔滨 is day 1's only stop, so 下移 carries it into day 2 — the next row
  // down on screen — instead of sliding it past 伊春 while it stayed on day 1,
  // which the list could not show and the map drew as a zigzag.
  await page.getByRole('button', { name: '下移 哈尔滨', exact: true }).click();
  await expect.poll(async () => (await readMap(request, map)).layers[0].points.find(point => point.id === 'harbin')?.day).toBe(2);
  await expect.poll(async () => (await readMap(request, map)).layers[0].points[0].id).toBe('harbin');
  await addPointAtMapCenter(page, '测试补给站');
  await expect.poll(async () => (await readMap(request, map)).layers[0].points.length).toBe(5);
  await page.getByRole('button', { name: '删除 测试补给站', exact: true }).click();
  await expect.poll(async () => (await readMap(request, map)).layers[0].points.length).toBe(4);
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await page.getByLabel('图层名称', { exact: true }).fill('沿途补给');
  await page.getByLabel('图层类型', { exact: true }).selectOption('spots');
  await page.getByRole('button', { name: '创建图层', exact: true }).click();
  await expect.poll(async () => (await readMap(request, map)).layers.length).toBe(4);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '导入数据', exact: true }).click();
  await page.getByLabel('地图 JSON', { exact: true }).fill(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[126, 48], [127, 48], [127, 49], [126, 48]]] }, properties: { name: '保护区' } }] }));
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect.poll(async () => (await readMap(request, map)).layers.length).toBe(5);
  const latest = await readMap(request, map);
  expect(latest.changed).toBe(true);
  expect(latest.changes.join(' ')).toContain('测试补给站');
  expect(latest.events.every(event => event.actor === 'user')).toBe(true);
  expect(latest.layers[4].geojson?.features[0].geometry.type).toBe('Polygon');
  expect(errors).toEqual([]);
});

test('a spot pin renders and is selectable without a CSP-blocked atlas fetch', async ({ page, request }) => {
  const map = await (await request.put(`/m/pin-${randomUUID()}`, { data: {
    title: '图钉显示验证', layers: [{ id: 'spots', name: '候选地点', kind: 'spots', points: [{ id: 'pin', name: '河边休息', at: [121.48, 31.22] }] }],
  } })).json() as WriteResult;
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-center', '121.48000,31.22000');
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-label-count', '1');
  const box = (await page.locator('.map-canvas').boundingBox())!;
  // The tip is at the map centre; select its head, below the text label.
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 12);
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('map stage dominates at 1295×986 and 800px never restores a 342px sidebar', async ({ page, request }) => {
  const map = await createMap(request);
  await page.setViewportSize({ width: 1295, height: 986 });
  await page.goto(map.editUrl!);
  await expect(page.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
  await expect(page.locator('.layer-panel')).toBeHidden();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  const workspace = (await page.locator('.workspace').boundingBox())!;
  // An embedded card is capped at its own height ceiling (styles.css); this
  // page is a surface the map is meant to fill, so the ceiling must not reach
  // it — at 986px tall that would show up as 720 and a band of empty page.
  expect(Math.round(workspace.height)).toBe(986);
  const stage = (await page.locator('.map-stage').boundingBox())!;
  expect(stage.width).toBeGreaterThan(workspace.width * 0.7);
  expect(stage.height).toBeGreaterThan(workspace.height * 0.7);
  await expect(page.locator('.sidebar')).toHaveCount(0);

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator('.layer-panel')).toBeHidden();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  // Undo, redo, version and save state are in the top bar; bottom right has only agent send fab.
  await expect(page.locator('.topbar .save-state')).toBeVisible();
  await expect(page.locator('.topbar .save-state')).toHaveText('已保存');
  await expect(page.getByRole('button', { name: '撤销' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重做' })).toBeVisible();
  await expect(page.getByRole('button', { name: '最近修改 · v1', exact: true })).toBeVisible();
  await expect(page.locator('.agent-send-fab')).toBeVisible();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  const canvas = (await page.locator('.map-canvas').boundingBox())!;
  expect(canvas.width).toBeGreaterThan(500);
  expect(canvas.height).toBeGreaterThan(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('share links are read-only, live changes arrive, and narrow screens remain usable', async ({ page, request }, info) => {
  const map = await createMap(request);
  await page.setViewportSize({ width: 390, height: 844 });
  const preview = await (await request.post(`/api/maps/${map.id}/preview`, { headers: { Authorization: `Bearer ${map.editKey}` }, data: {} })).json();
  await page.goto(preview.previewUrl);
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeDisabled();
  // Showing and hiding a layer is in its list, which a read-only map still opens.
  await page.getByTestId('layer-lesser-khingan').click();
  await expect(page.getByRole('button', { name: /隐藏 小兴安岭/ })).toBeEnabled();
  await page.getByRole('button', { name: /隐藏 小兴安岭/ }).click();
  await expect(page.getByRole('button', { name: /显示 小兴安岭/ })).toBeVisible();
  await page.getByRole('button', { name: /显示 小兴安岭/ }).click();
  const response = await request.post(`/api/maps/${map.id}/edit`, { headers: { Authorization: `Bearer ${map.editKey}` }, data: { baseVersion: 1, operations: [{ op: 'update', layerId: map.layers[0].id, pointId: map.layers[0].points[0].id, patch: { name: '实时同步后的哈尔滨' } }] } });
  expect(response.ok()).toBeTruthy();
  await page.getByTestId('layer-lesser-khingan').click();
  await expect(page.getByText('实时同步后的哈尔滨', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const canvas = await page.locator('.map-canvas').boundingBox();
  expect(canvas!.height).toBeGreaterThan(220);
  await page.screenshot({ path: info.outputPath('mobile.png') });
});

test('offline HTML makes no external requests, remains editable and exports current data', async ({ browser, request }, info) => {
  const map = await createMap(request);
  const response = await request.get(`/m/${map.id}/export.html`, { headers: { Authorization: `Bearer ${map.editKey}` } });
  expect(response.ok()).toBeTruthy();
  const html = await response.text(); expect(html).not.toContain(map.editKey!);
  const file = info.outputPath('offline.html'); await writeFile(file, html);
  const context = await browser.newContext();
  const requests: string[] = [];
  await context.route(/^https?:\/\//, route => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
  await expect(page.getByText('离线编辑', { exact: false }).first()).toBeVisible();
  await editFirstNote(page, '断网编辑也能保存到文件');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 JSON/ }).click();
  const download = await downloading;
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(data.layers[0].points[0].note).toBe('断网编辑也能保存到文件');
  expect(requests).toEqual([]);
  await context.close();
});

test('MCP Apps official bridge renders in opaque iframe and writes user changes to model context', async ({ page, request }) => {
  const map = await createMap(request);
  await page.goto(`/mcp-host.html?noWorkers=1&id=${map.id}#key=${map.editKey}`);
  await expect(page.locator('#status')).toHaveText('MCP Apps bridge 已连接');
  const frame = page.frameLocator('#app');
  await expect(frame.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await frame.locator('html').evaluate(el => el.style.getPropertyValue('--host-height')))).toBeGreaterThan(200);
  await expect(frame.locator('html')).toHaveAttribute('data-display-mode', 'inline');
  await frame.getByTestId('layer-lesser-khingan').click();
  await frame.getByTestId('point-harbin').getByRole('button').first().click();
  await frame.locator('.point-popover').hover();
  await expect(frame.locator('.point-popover')).toHaveAttribute('data-collapsed', 'false');
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.getByLabel('备注', { exact: true }).fill('从 MCP App 调整的地点');
  await frame.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#context')).toContainText('"version":2');
  expect((await readMap(request, map)).layers[0].points[0].note).toBe('从 MCP App 调整的地点');
});

test('WebGL denial falls back to an editable SVG map', async ({ page, request }) => {
  const map = await createMap(request);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) { if (type.includes('webgl')) return null; return (getContext as Function).apply(this, [type, ...args]); } as typeof getContext;
  });
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas svg').first()).toBeVisible();

  /* The fallback compares plans the same way: the unselected route is drawn
   * faded, and pressing the line is what switches to it. Done before the edit
   * below, which pans the camera to the stop it opens. */
  const backdrop = page.locator('.map-canvas svg path[data-layer="greater-khingan"][data-backdrop="true"]').first();
  await expect(backdrop).toHaveAttribute('stroke-opacity', /0\.5/);
  // Click the middle of the first drawn segment: the centre of a diagonal
  // path's bounding box is not on the line.
  const [, x1, y1, x2, y2] = /M([\d.-]+),([\d.-]+)L([\d.-]+),([\d.-]+)/.exec((await backdrop.getAttribute('d'))!)!.map(Number);
  const box = (await page.locator('.map-canvas').boundingBox())!;
  await page.mouse.click(box.x + (x1 + x2) / 2, box.y + (y1 + y2) / 2);
  await expect(page.locator('.map-canvas svg path[data-layer="greater-khingan"][data-backdrop="true"]')).toHaveCount(0);
  await expect(page.locator('.map-canvas svg path[data-layer="lesser-khingan"][data-backdrop="true"]').first()).toBeVisible();

  await editFirstNote(page, '兼容视图中的编辑');
  await expect.poll(async () => (await readMap(request, map)).layers[0].points[0].note).toBe('兼容视图中的编辑');
});

/**
 * The switcher is furniture; the map is the subject.
 *
 * So the cards open under the pointer and close when it leaves — reading the
 * map costs nothing — and staying open is the thing that takes a click. What is
 * pinned down here is that the peek really does close itself, that a pin really
 * does survive the pointer leaving *and* a reload, and that a second click
 * gives the map back.
 */
test('a layer list opens while the pointer rests on its dot, goes when the pointer leaves, and stays once pinned', async ({ page, request }) => {
  const map = await createMap(request);
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  const dot = page.getByTestId('layer-lesser-khingan');
  const panel = page.locator('.layer-panel');
  // Nothing but the rail on arrival: no bar, no cards, the map is clear.
  await expect(page.getByRole('group', { name: '图层', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^图层 ·/ })).toHaveCount(0);
  await expect(panel).toBeHidden();
  await expect(dot).toHaveAttribute('aria-expanded', 'false');

  await dot.hover();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('point-harbin')).toBeVisible();
  await expect(dot).toHaveAttribute('aria-expanded', 'true');
  // The list stays while the pointer travels across the gap into it — the gap
  // between the dot and the list is not a boundary the list may go across.
  await panel.getByTestId('point-harbin').hover();
  await expect(panel).toBeVisible();
  // And down the rail the list follows the dot under the pointer, at once.
  await page.getByTestId('layer-greater-khingan').hover();
  await expect(panel.getByTestId('point-jiagedaqi')).toBeVisible();
  await expect(page.getByTestId('layer-greater-khingan')).toHaveAttribute('aria-expanded', 'true');
  await expect(dot).toHaveAttribute('aria-expanded', 'false');

  // Leaving puts the map back with no click at all.
  await page.mouse.move(700, 600);
  await expect(panel).toBeHidden();

  // Pinned, it stays with the pointer far away. Pinned is a preference, not a
  // session state: it survives a reload.
  await dot.hover();
  await panel.getByRole('button', { name: /^固定展开/ }).click();
  await page.mouse.move(700, 600);
  await page.mouse.move(730, 630);
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('point-harbin')).toBeVisible();

  await panel.getByRole('button', { name: /^取消固定/ }).click();
  await page.mouse.move(700, 600);
  await page.mouse.move(730, 630);
  await expect(panel).toBeHidden();
});

/**
 * The rest of the furniture folds too.
 *
 * A plan's stop list is a 280px column and a stop card is a block in the
 * corner; both sat on top of the map until they were dismissed by hand. They
 * now fold to their own headings once the pointer has moved on — but only once
 * it *moves*, because a card that vanished while the user was still looking at
 * what they just clicked would be worse than one that stays.
 */
test('the stop list goes and the stop card folds once the pointer moves on, and a pin holds them', async ({ page, request }, info) => {
  const map = await createMap(request);
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('layer-lesser-khingan').click();
  const detail = page.locator('.layer-panel');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('point-harbin')).toBeVisible();

  // Move on, and the list goes. It has no folded form of its own: the dot in
  // the rail is its handle, and the map gets the whole column back.
  await page.mouse.move(900, 640);
  await page.mouse.move(930, 670);
  await expect(detail).toBeHidden();
  await page.screenshot({ path: info.outputPath('panels-folded.png') });

  // The dot brings it back, with no click.
  await page.getByTestId('layer-lesser-khingan').hover();
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('point-harbin')).toBeVisible();

  // A stop card, opened from the list, behaves the same way.
  await page.getByTestId('point-harbin').getByRole('button').first().click();
  const card = page.locator('.point-popover');
  await expect(card).toHaveAttribute('data-collapsed', 'false');
  await page.mouse.move(900, 300);
  await page.mouse.move(930, 330);
  await expect(card).toHaveAttribute('data-collapsed', 'true');
  // Folded, it still names which marker on the map is the selected one.
  await expect(card.getByRole('heading', { name: '哈尔滨', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '编辑', exact: true })).toBeHidden();
  await card.hover();
  await expect(card).toHaveAttribute('data-collapsed', 'false');
  await expect(card.getByRole('button', { name: '编辑', exact: true })).toBeVisible();

  // Pinned, the card stays whole with the pointer far away.
  await card.getByRole('button', { name: '固定展开地点卡片', exact: true }).click();
  await page.mouse.move(700, 700);
  await page.mouse.move(720, 720);
  await expect(card).toHaveAttribute('data-collapsed', 'false');
  await card.getByRole('button', { name: '取消固定地点卡片', exact: true }).click();
  await page.mouse.move(500, 700);
  await page.mouse.move(520, 720);
  await expect(card).toHaveAttribute('data-collapsed', 'true');
});

/**
 * The day distinction, measured on the drawn line rather than in the ladder.
 *
 * `tests/day-colors.test.ts` proves the shades are far enough apart; this proves
 * they reach the map at all — that the default colour mode is still `day`, that
 * a plan keeps one hue while its days differ, and that a stop without a day
 * number is the one case that comes out flat. Everything between the ladder and
 * the stroke has broken this before: a stored preference, a per-leg colour
 * copied from the layer, a review that turned day colouring into an opt-in.
 */
test('a multi-day plan draws one shade per day, and a plan without days stays flat', async ({ page, request }) => {
  const map = await createMap(request);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) { if (type.includes('webgl')) return null; return (getContext as Function).apply(this, [type, ...args]); } as typeof getContext;
  });
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas svg').first()).toBeVisible();
  // 小兴安岭线: days 1, 2 and 4 — three legs, each drawn from its origin's day.
  const strokes = await page.locator('.map-canvas svg path[data-layer="lesser-khingan"]:not([data-backdrop="true"])')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('stroke')!));
  expect(strokes.length).toBeGreaterThanOrEqual(3);
  expect(new Set(strokes).size).toBe(strokes.length);
  // One hue: these are days of one plan, not three plans.
  for (const stroke of strokes) expect(stroke).toMatch(/^#[0-9a-f]{6}$/i);
  const hues = strokes.map(stroke => {
    const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(stroke.slice(at, at + 2), 16) / 255);
    const max = Math.max(r, g, b); const span = max - Math.min(r, g, b);
    if (!span) return 0;
    return (((max === r ? (g - b) / span + (g < b ? 6 : 0) : max === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60) + 360) % 360;
  });
  expect(Math.max(...hues) - Math.min(...hues)).toBeLessThanOrEqual(32);

  // The same map with its day numbers stripped: nothing to separate, so the
  // plan keeps exactly the colour the caller set.
  const flat = await request.put(`/m/e2e-flat-${randomUUID()}`, { data: { ...DEMO_INPUT, layers: DEMO_INPUT.layers!.map(layer => ({
    ...layer, points: layer.points!.map(({ day: _day, ...point }) => point),
  })) } });
  expect(flat.ok()).toBeTruthy();
  await page.goto((await flat.json()).editUrl);
  await expect(page.locator('.map-canvas svg').first()).toBeVisible();
  const flatStrokes = await page.locator('.map-canvas svg path[data-layer="lesser-khingan"]:not([data-backdrop="true"])')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('stroke')!));
  expect(flatStrokes.length).toBeGreaterThanOrEqual(3);
  expect(new Set(flatStrokes).size).toBe(1);
});

test('SVG fallback pills select their leg origin and never spawn a node in adding mode', async ({ page, request }) => {
  const map = await createMap(request);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) { if (type.includes('webgl')) return null; return (getContext as Function).apply(this, [type, ...args]); } as typeof getContext;
  });
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas svg').first()).toBeVisible();
  await setLegMode(page, '全部');
  // 哈尔滨→伊春 is the only 325 km leg; clicking its pill selects the origin.
  const pill = page.locator('.map-leg-label', { hasText: '325 km' }).first();
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByRole('region', { name: '路段详情', exact: true })).toBeVisible();
  await expect(page.locator('.leg-popover h2')).toHaveText('哈尔滨 → 伊春');
  await page.getByRole('button', { name: '关闭路段详情', exact: true }).click();
  await openLayer(page, 'lesser-khingan');
  await page.getByRole('button', { name: '在 哈尔滨 后添加', exact: true }).click();
  await pill.click();
  await expect(page.getByRole('region', { name: '添加地点', exact: true })).toBeHidden();
  await expect(page.locator('.leg-popover h2')).toHaveText('哈尔滨 → 伊春');
});

test('on-map leg annotations follow the density control and persist; a dot opens and the heading closes the list', async ({ page, request }) => {
  const map = await createMap(request);
  await page.goto(map.editUrl!);
  const canvas = page.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '路段标注', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /自动/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(async () => Number(await canvas.getAttribute('data-leg-label-count'))).toBeGreaterThan(0);
  const auto = Number(await canvas.getAttribute('data-leg-label-count'));
  const keys = JSON.parse((await canvas.getAttribute('data-leg-label-keys')) ?? '[]') as string[];
  expect(keys.some(key => key.startsWith('lesser-khingan '))).toBe(true);
  await setLegMode(page, '全部');
  await expect.poll(async () => Number(await canvas.getAttribute('data-leg-label-count'))).toBeGreaterThanOrEqual(auto);
  await setLegMode(page, '隐藏');
  await expect(canvas).toHaveAttribute('data-leg-label-count', '0');
  await page.reload();
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '路段标注', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /隐藏/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(canvas).toHaveAttribute('data-leg-label-count', '0');
  await setLegMode(page, '全部');

  const panel = page.locator('.layer-panel');
  await expect(panel).toBeHidden();
  const dot = page.getByTestId('layer-lesser-khingan');
  await expect(dot).toHaveAttribute('aria-expanded', 'false');
  await dot.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('point-harbin')).toBeVisible();
  await expect(dot).toHaveAttribute('aria-expanded', 'true');
  await expect(dot).toHaveAttribute('aria-current', 'true');
  await panel.getByRole('button', { name: /^关闭 / }).click();
  await expect(panel).toBeHidden();
  await expect(dot).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('layer-greater-khingan').click();
  await expect(panel.getByTestId('point-jiagedaqi')).toBeVisible();
  await expect(page.getByTestId('layer-greater-khingan')).toHaveAttribute('aria-current', 'true');
  await expect(dot).not.toHaveAttribute('aria-current', 'true');
});

test('the unselected plan becomes a backdrop, and its chip switches to it without moving the camera', async ({ page, request }, info) => {
  const map = await createMap(request);
  await page.goto(map.editUrl!);
  const canvas = page.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  // Two routes and one of them selected: the map is comparing plans.
  await expect(canvas).toHaveAttribute('data-comparing', 'true');
  const chips = async () => JSON.parse((await canvas.getAttribute('data-plan-chips')) ?? '[]') as { id: string; x: number; y: number }[];
  await expect.poll(async () => (await chips()).map(chip => chip.id)).toEqual(['greater-khingan']);

  // In auto density the backdrop plan's own leg pills step aside for the
  // selected plan's; the chip is what still speaks for it.
  const keys = JSON.parse((await canvas.getAttribute('data-leg-label-keys')) ?? '[]') as string[];
  expect(keys.some(key => key.startsWith('lesser-khingan '))).toBe(true);
  expect(keys.some(key => key.startsWith('greater-khingan '))).toBe(false);

  await page.screenshot({ path: info.outputPath('plan-backdrop.png') });
  const before = await canvas.getAttribute('data-center');
  const box = (await canvas.boundingBox())!;
  const [chip] = await chips();
  await page.mouse.click(box.x + chip.x, box.y + chip.y);
  // The plans trade places: what was the backdrop is now the answer.
  await expect.poll(async () => (await chips()).map(item => item.id)).toEqual(['lesser-khingan']);
  await expect(canvas).toHaveAttribute('data-center', before ?? '');
  await page.screenshot({ path: info.outputPath('plan-switched.png') });

  // Hiding the other route ends the comparison: nothing left to stand back
  // from. The control is in the layer's list, one hover away in the rail.
  await page.getByTestId('layer-lesser-khingan').hover();
  await page.getByRole('button', { name: /^隐藏 小兴安岭/ }).click();
  await expect(canvas).toHaveAttribute('data-comparing', 'false');
  await expect(canvas).toHaveAttribute('data-plan-chips', '[]');
});

test('map marker drag, map insertion and list drag reorder persist spatial edits', async ({ page, request }) => {
  const map = await createMap(request);
  await page.goto(map.editUrl!);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  const box = (await page.locator('.map-canvas').boundingBox())!;
  const bounds = padBounds(focusBounds(map.layers.filter(layer => layer.visible), null)!);
  const viewport = new WebMercatorViewport({ width: box.width, height: box.height }).fitBounds([[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]], { padding: 64, maxZoom: 12 });
  const initial = map.layers[0].points[0].at;
  const [x, y] = viewport.project(initial);
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 45, box.y + y - 25, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await readMap(request, map)).layers[0].points[0].at[0]).not.toBe(initial[0]);
  await addPointAtMapCenter(page, '地图上选中的营地');
  await expect.poll(async () => (await readMap(request, map)).layers[0].points.length).toBe(5);
  await page.getByRole('button', { name: '关闭地点详情', exact: true }).click();
  await openLayer(page, 'lesser-khingan');
  await page.getByTestId('point-harbin').dragTo(page.getByTestId('point-wudalianchi'));
  await expect.poll(async () => (await readMap(request, map)).layers[0].points[2].id).toBe('harbin');
});

test('two 下移 clicks fired back to back both land: no conflict banner, and the version advances by two', async ({ page, request }) => {
  const map = await createMap(request);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(map.editUrl!);
  await expect(page.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
  await openLayer(page, 'lesser-khingan');
  const before = await readMap(request, map);
  // Scoped by point id, not by the "下移 <name>" label: two stops can share a
  // name, and this is the second edit's closure racing the first one's write,
  // not a name-lookup concern — see MapWorkspace's `editOptimistic` queue.
  const moveDown = page.getByTestId('point-harbin').getByRole('button', { name: /^下移/ });
  await moveDown.click();
  await moveDown.click();
  // The second click's write used to be sent with the first click's already
  // out-of-date baseVersion (a closure over the render's own `snapshot`), so
  // the server rejected it and the optimistic queue rolled both moves back.
  await expect.poll(async () => (await readMap(request, map)).version).toBe(before.version + 2);
  await expect(page.locator('.notice.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
