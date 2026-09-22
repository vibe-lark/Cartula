/** Real Workers, unlike the size/interaction matrix which deliberately blocks them. */
import { test, expect, type Page, type Worker } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function createMap(request: Page['request']) {
  return (await (await request.put(`/m/worker-${randomUUID()}`, { data: {
    title: 'Worker 底图验证', layers: [{ id: 'route', name: '上海路线', kind: 'route', points: [
      { id: 'a', name: '人民广场', at: [121.475, 31.230] },
      { id: 'b', name: '外滩', at: [121.490, 31.240] },
    ] }],
  } })).json()) as { id: string; editKey: string; editUrl: string };
}

for (const embedded of [false, true]) {
  test(`classic Worker loads real vector tiles and fonts in ${embedded ? 'an opaque MCP App' : 'the browser'}`, async ({ page, request }, info) => {
    const map = await createMap(request);
    const workers: Worker[] = []; page.on('worker', worker => workers.push(worker));
    const seen = { tile: false, glyph: false };
    page.on('response', response => {
      if (response.status() !== 200) return;
      if (/\/basemap\/planet\/.+\.pbf/.test(response.url())) seen.tile = true;
      if (/\/basemap\/fonts\/.+\.pbf/.test(response.url())) seen.glyph = true;
    });
    await page.goto(embedded ? `/mcp-host.html?id=${map.id}#key=${map.editKey}` : map.editUrl);
    const root = embedded ? page.frameLocator('#app').locator(':root') : page.locator(':root');
    if (embedded) {
      await expect(page.locator('#status')).toHaveText('MCP Apps bridge 已连接');
      expect(await root.evaluate(() => self.origin)).toBe('null');
      expect(await page.locator('#app').getAttribute('sandbox')).not.toContain('allow-same-origin');
    }
    const canvas = root.locator('.map-canvas');
    await expect(canvas).toHaveAttribute('data-mode', 'webgl');
    await expect(canvas).toHaveAttribute('data-worker', 'ok');
    await expect.poll(() => seen, { timeout: 30_000 }).toEqual({ tile: true, glyph: true });
    // This pins MapLibre's .cjs selector by behaviour, not a regex over its source.
    expect(workers).toHaveLength(1);
    expect(workers[0].url()).toMatch(/#cartula-worker\.cjs$/);
    expect(await workers[0].evaluate(() => {
      try { (globalThis as unknown as { importScripts(): void }).importScripts(); return 'classic'; }
      catch { return 'module'; }
    })).toBe('classic');
    await expect(root.getByText('地图引擎暂未响应', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(embedded ? 'opaque-basemap.png' : 'browser-basemap.png') });
  });
}

test('an asynchronously failed Worker warns after timeout and keeps map interaction', async ({ page, request }) => {
  // Fault injection is confined to the test. Product code never replaces Worker.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(_url: string | URL, options?: WorkerOptions) {
        const broken = URL.createObjectURL(new Blob(['throw new Error("CARTULA_TEST_WORKER_FAILURE")'], { type: 'text/javascript' }));
        super(broken, options);
        URL.revokeObjectURL(broken);
      }
    };
  });
  const warnings: string[] = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  const map = await createMap(request);
  await page.goto(`/mcp-host.html?id=${map.id}#key=${map.editKey}`);
  const frame = page.frameLocator('#app'); const canvas = frame.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-worker', 'timeout', { timeout: 20_000 });
  await expect(canvas).toHaveAttribute('data-mode', 'webgl');
  await expect(frame.getByText('地图引擎暂未响应', { exact: false })).toBeVisible();
  expect(warnings).toContain('[Cartula] MAP_WORKER_TIMEOUT');
  const zoom = await canvas.getAttribute('data-zoom');
  await frame.locator('.maplibregl-ctrl-zoom-in').click();
  await expect(canvas).not.toHaveAttribute('data-zoom', zoom!);
});

test('a host that denies Workers gets an accurate SVG fallback', async ({ page, request }) => {
  const map = await createMap(request);
  await page.goto(`/mcp-host.html?noWorkers=1&id=${map.id}#key=${map.editKey}`);
  const frame = page.frameLocator('#app');
  await expect(frame.locator('.map-canvas')).toHaveAttribute('data-mode', 'svg');
  await expect(frame.locator('.map-canvas')).toHaveAttribute('data-worker', 'blocked');
  await expect(frame.getByText('地图引擎受限', { exact: false })).toBeVisible();
});
