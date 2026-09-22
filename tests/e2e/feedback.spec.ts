import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const input = { title: '法国与瑞士的假期', layers: [{ id: 'route', name: '自驾方案', kind: 'route', points: [
  { id: 'nice', name: '尼斯', at: [7.26, 43.70] }, { id: 'geneva', name: '日内瓦', at: [6.14, 46.20] },
], routing: { source: 'OSRM', profile: 'driving', distanceKm: 1554, durationMinutes: 1080,
  legs: [{ fromPointId: 'nice', toPointId: 'geneva', distanceKm: 1554, durationMinutes: 1080 }] } }] };
async function openRoute(page: Page) {
  const panel = page.locator('.layer-panel');
  const dot = page.getByTestId('layer-route');
  // The list is on screen only while the pointer rests on the layer's dot or
  // on the list itself. One still up from an earlier step may be a moment from
  // going, and resting on the dot is what cancels that — so go there first.
  if (await panel.isVisible()) await dot.hover(); else await dot.click();
  await expect(panel.getByTestId('point-geneva')).toBeVisible();
  await panel.hover();
}
async function fillIntent(page: Page) {
  await openRoute(page);
  await page.getByTestId('point-geneva').getByRole('button').first().click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('地点规划意图', { exact: true }).fill('保留瑞士两天');
  await page.getByLabel('调整状态', { exact: true }).selectOption('fixed');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('region', { name: '地点详情', exact: true })).toHaveCount(0);
  await openRoute(page);
}
async function continuePlanning(page: Page) {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
}
test('read-only access can be unlocked; metrics, intent and a copyable planning message are visible', async ({ page, request }, info) => {
  const map = await (await request.put(`/m/feedback-${randomUUID()}`, { data: input })).json();
  const preview = await (await request.post(`/api/maps/${map.id}/preview`, { headers: { Authorization: `Bearer ${map.editKey}` }, data: {} })).json();
  await page.goto(preview.previewUrl);
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeDisabled();
  await page.getByTestId('layer-route').click();
  // The totals are one line under the name; where they came from is behind 信息.
  const panel = page.locator('.layer-panel');
  await expect(panel.getByText('1,554 km', { exact: true })).toBeVisible();
  await expect(panel.getByText('18小时', { exact: true })).toBeVisible();
  await expect(panel.getByText('距离与时间依据')).toHaveCount(0);
  await panel.getByRole('button', { name: /的信息$/ }).click();
  const about = page.getByRole('dialog', { name: '自驾方案', exact: true });
  await expect(about.getByText('路由服务里程', { exact: true })).toBeVisible();
  await expect(about.getByText('1,554 km', { exact: true }).first()).toBeVisible();
  await about.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '启用编辑', exact: true }).click();
  await page.getByLabel('编辑链接或编辑密钥').fill(map.editUrl);
  await page.getByRole('button', { name: '启用编辑', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
  await fillIntent(page);
  await expect(page.getByTestId('point-geneva').getByText('必须保留', { exact: true })).toBeVisible();
  await continuePlanning(page);
  await page.getByLabel('这次修改的意图', { exact: true }).fill('删掉尼斯，把两天加给瑞士');
  await page.getByRole('button', { name: '生成继续规划消息' }).click();
  const text = await page.getByLabel('本轮修改消息').inputValue();
  expect(text).toContain('把两天加给瑞士'); expect(text).toContain('patch_map'); expect(text).not.toContain(map.editKey);
  const updated = await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json();
  expect(updated.layers[0].points[1].flexibility).toBe('fixed');
  const lastOps = updated.events.at(-1).operations as Array<{ op: string; text?: string }>;
  expect(lastOps.some(op => op.op === 'intent.set' && op.text === '删掉尼斯，把两天加给瑞士')).toBe(true);
  expect(lastOps.some(op => op.op === 'draft.commit')).toBe(true);
  await page.getByRole('button', { name: '关闭发送', exact: true }).click();
  await page.screenshot({ path: info.outputPath('feedback-desktop.png') });
});

test('creating an editable copy preserves the original and gives the copy its own credential', async ({ page, request }) => {
  const map = await (await request.put(`/m/fork-${randomUUID()}`, { data: input })).json();
  const preview = await (await request.post(`/api/maps/${map.id}/preview`, { headers: { Authorization: `Bearer ${map.editKey}` }, data: {} })).json();
  await page.goto(preview.previewUrl);
  await page.getByRole('button', { name: '复制地图', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${input.title} · 副本`, exact: true })).toBeVisible();
  expect(page.url()).not.toContain(`/map/${map.id}`);
  await page.reload();
  await expect(page.getByRole('heading', { name: `${input.title} · 副本`, exact: true })).toBeVisible();
  await fillIntent(page);
  const original = await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json();
  expect(original.version).toBe(1); expect(original.layers[0].points[1].intent).toBeUndefined();
});

test('MCP saves wait for explicit submission; ui/message includes the batch intent', async ({ page, request }) => {
  const map = await (await request.put(`/m/host-${randomUUID()}`, { data: input })).json();
  await page.goto(`/mcp-host.html?noWorkers=1&id=${map.id}#key=${map.editKey}`);
  await expect(page.locator('#status')).toHaveText('MCP Apps bridge 已连接');
  const frame = page.frameLocator('#app');
  await frame.getByTestId('layer-route').click();
  await frame.getByTestId('point-geneva').getByRole('button').first().click();
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.getByLabel('地点规划意图', { exact: true }).fill('希望多留一天');
  await frame.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#context')).toContainText('"version":2');
  await expect(page.locator('#message')).toHaveText('');
  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await frame.getByLabel('这次修改的意图', { exact: true }).fill('请只调整后两天');
  await frame.getByRole('button', { name: '一键发送给 Agent' }).click();
  await expect(page.locator('#message')).toContainText('请只调整后两天');
  await expect(page.locator('#message')).toContainText('希望多留一天');
  // Saved and handed over stay two separate claims, and neither says the
  // agent started working.
  const delivered = frame.getByRole('region', { name: '交给 Agent' }).getByRole('status');
  await expect(delivered).toContainText('已交给对话');
  await expect(delivered).toContainText('修改已保存到地图');
  await expect(frame.getByText('等待对话里继续处理')).toBeVisible();
  expect(await page.locator('#message').textContent()).not.toContain(map.editKey);
});

test('MCP hosts without messages get a copy fallback', async ({ page, request }) => {
  const map = await (await request.put(`/m/fallback-${randomUUID()}`, { data: input })).json();
  await page.goto(`/mcp-host.html?noWorkers=1&noMessage=1&id=${map.id}#key=${map.editKey}`);
  await expect(page.locator('#status')).toHaveText('MCP Apps bridge 已连接');
  const frame = page.frameLocator('#app');
  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await frame.getByLabel('这次修改的意图', { exact: true }).fill('每天开车不超过三小时');
  await frame.getByRole('button', { name: '一键发送给 Agent' }).click();
  await expect(frame.getByRole('button', { name: '复制消息', exact: true })).toBeVisible();
  expect(await frame.getByLabel('本轮修改消息').inputValue()).toContain('每天开车不超过三小时');
  await expect(page.locator('#message')).toHaveText('');
});

test('color styles, map language and label visibility respond to the viewport', async ({ page, request }, info) => {
  const points = Array.from({ length: 120 }, (_, i) => ({ id: `p${String(i).padStart(3, '0')}`, name: `巴黎周边的地点 ${i}`, at: [2 + i % 12 * 0.03, 48.5 + Math.floor(i / 12) * 0.03] }));
  const map = await (await request.put(`/m/labels-${randomUUID()}`, { data: { title: '密集地点与地图语言', layers: [{ id: 'spots', name: '巴黎周边', kind: 'spots', points }] } })).json();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(map.editUrl);
  const canvas = page.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '底图色彩', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /彩色/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '地名语言', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /中文优先/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(async () => Number(await canvas.getAttribute('data-label-count'))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute('data-label-count'))).toBeLessThan(120);
  await page.getByTestId('layer-spots').click();
  await page.getByTestId('point-p066').getByRole('button').first().click();
  await expect(canvas).toHaveAttribute('data-label-keys', /spots p066/);
  await page.getByRole('button', { name: '关闭地点详情' }).click();
  const before = await canvas.getAttribute('data-label-keys');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => canvas.getAttribute('data-label-keys')).not.toBe(before);
  const styleResponse = page.waitForResponse(response => response.url().endsWith('/basemap/styles/positron') && response.status() === 200);
  await page.getByRole('button', { name: '底图色彩', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /简洁/ }).click(); await styleResponse;
  await page.getByRole('button', { name: '地名语言', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /English/ }).click();
  await expect(canvas).toHaveAttribute('data-language', 'en');
  await page.getByRole('button', { name: '底图色彩', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /彩色/ }).click();
  await page.getByRole('button', { name: '地名语言', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /中文优先/ }).click();
  await page.screenshot({ path: info.outputPath('labels-and-language.png') });
  expect(errors).toEqual([]);
});

test('SVG fallback uses the same collision rules and preserves selected labels', async ({ page, request }) => {
  const points = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `重叠地点 ${i}`, at: [2 + i % 10 * 0.01, 48.5 + Math.floor(i / 10) * 0.01] }));
  const map = await (await request.put(`/m/svg-labels-${randomUUID()}`, { data: { layers: [{ id: 'spots', name: '密集点', kind: 'spots', points }] } })).json();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, ...args: unknown[]) { return type.includes('webgl') ? null : (original as Function).apply(this, [type, ...args]); } as typeof original;
  });
  await page.goto(map.editUrl);
  const canvas = page.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-mode', 'svg');
  expect(Number(await canvas.getAttribute('data-label-count'))).toBeLessThan(60);
  await page.getByTestId('layer-spots').click();
  await page.getByTestId('point-p25').getByRole('button').first().click();
  await expect(canvas).toHaveAttribute('data-label-keys', /spots p25/);
  await expect(page.locator('.map-point-label').filter({ hasText: '重叠地点 25' })).toBeVisible();
});

test('frames the route before slow basemap tiles finish loading', async ({ page, request }) => {
  const map = await (await request.put(`/m/slow-tiles-${randomUUID()}`, { data: { layers: [{ name: '巴黎散步', points: [{ name: '出发', at: [2.33, 48.82] }, { name: '终点', at: [2.37, 48.88] }] }] } })).json();
  await page.route('**/basemap/styles/*', route => route.fulfill({ json: { version: 8, sources: { slow: { type: 'raster', tiles: ['http://127.0.0.1:3911/basemap/planet/test/{z}/{x}/{y}.png'], tileSize: 256 } }, layers: [{ id: 'slow-tiles', type: 'raster', source: 'slow' }] } }));
  // Intentionally keep requests pending; camera and route overlays are local.
  await page.route('**/basemap/planet/test/**', () => {});
  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 5000 });
  await expect.poll(async () => Number(await page.locator('.map-canvas').getAttribute('data-zoom')), { timeout: 5000 }).toBeGreaterThan(9);
  await expect.poll(async () => Number(await page.locator('.map-canvas').getAttribute('data-label-count'))).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '适应全部图层', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('.map-canvas').getAttribute('data-label-count'))).toBe(2);
});
