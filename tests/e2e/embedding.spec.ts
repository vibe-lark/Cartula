/**
 * Embedding behaviour against a real MCP Apps host (`AppBridge` in
 * `src/web/mcp-host.ts`): container-size negotiation across the matrix from
 * the spec, display-mode outcomes, and the hand-off states.
 *
 * A simulated host proves protocol handling only. It does not prove that
 * Codex — or any other real host — completes 发送 → agent 读取 → 回写.
 */
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const input = {
  title: '大小兴安岭自驾', layers: [
    { id: 'plan-a', name: '方案 A', kind: 'route', color: '#2563eb', points: [
      { id: 'harbin', name: '哈尔滨', at: [126.53, 45.8], day: 1 },
      { id: 'yichun', name: '伊春', at: [128.9, 47.72], day: 2 },
      { id: 'jiayin', name: '嘉荫', at: [130.4, 48.89], day: 3 },
    ], routing: { source: 'OSRM', profile: 'driving', distanceKm: 620, durationMinutes: 480,
      legs: [
        { fromPointId: 'harbin', toPointId: 'yichun', distanceKm: 320, durationMinutes: 260 },
        { fromPointId: 'yichun', toPointId: 'jiayin', distanceKm: 300, durationMinutes: 220 },
      ] } },
    { id: 'plan-b', name: '方案 B', kind: 'route', color: '#d66836', points: [
      { id: 'harbin-b', name: '哈尔滨', at: [126.53, 45.8], day: 1 },
      { id: 'wudalianchi', name: '五大连池', at: [126.19, 48.7], day: 2 },
    ], routing: { source: 'OSRM', profile: 'driving', distanceKm: 340, durationMinutes: 270,
      legs: [{ fromPointId: 'harbin-b', toPointId: 'wudalianchi', distanceKm: 340, durationMinutes: 270 }] } },
    { id: 'spots', name: '候选景点', kind: 'spots', color: '#26856a', points: [
      { id: 'tanglin', name: '汤旺河石林', at: [129.5, 48.4], icon: 'park' },
    ] },
  ],
};

async function createMap(request: Page['request'], prefix: string) {
  return (await (await request.put(`/m/${prefix}-${randomUUID()}`, { data: input })).json()) as { id: string; url: string; editKey: string; editUrl: string };
}
async function openHost(page: Page, map: { id: string; editKey: string }, query = '') {
  await page.goto(`/mcp-host.html?noWorkers=1&id=${map.id}${query}#key=${map.editKey}`);
  await expect(page.locator('#status')).toHaveText('MCP Apps bridge 已连接');
  const frame = page.frameLocator('#app');
  await expect(frame.locator('.workspace')).toBeVisible();
  return frame;
}
const rootAttr = (frame: FrameLocator, name: string) => frame.locator(':root').getAttribute(name);
/** The number a host that measures the document instead of listening reads. */
const documentHeight = (frame: FrameLocator) =>
  frame.locator(':root').evaluate(root => Math.round(root.getBoundingClientRect().height));

test('embedded anchors use the bridge, including credits, home and middle-click', async ({ page, request }) => {
  const map = await createMap(request, 'host-links');
  const frame = await openHost(page, map, '&links=record');
  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '地图数据与开源声明', exact: true }).click();
  const credit = frame.getByRole('dialog').locator('a[href^="https:"]').first();
  const target = await credit.getAttribute('href');
  await credit.click();
  await credit.click({ button: 'middle' });
  await frame.getByRole('dialog').getByRole('button', { name: /关闭/ }).click();
  await frame.locator('a.brand').click();
  const links = () => page.evaluate(() => (window as unknown as { cartulaHost: { openedLinks: string[] } }).cartulaHost.openedLinks);
  await expect.poll(links).toEqual([target, target, 'http://127.0.0.1:3911/']);
  await expect(frame.locator('.workspace')).toBeVisible();
});

test('an unavailable or refused host link leaves a copyable address', async ({ page, request }) => {
  const map = await createMap(request, 'host-link-fallback');
  for (const query of ['&noOpenLinks=1', '&links=reject']) {
    const frame = await openHost(page, map, query);
    await frame.locator('a.brand').click();
    await expect(frame.getByRole('dialog', { name: '打开链接' })).toBeVisible();
    await expect(frame.getByRole('textbox', { name: '链接地址' })).toHaveValue('http://127.0.0.1:3911/');
    await expect(frame.locator('.workspace')).toBeVisible();
  }
});

test('host teardown acknowledges after unmounting the map workspace', async ({ page, request }) => {
  const map = await createMap(request, 'host-teardown');
  const frame = await openHost(page, map);
  const result = await page.evaluate(() => (window as unknown as { cartulaHost: { teardown: () => Promise<unknown> } }).cartulaHost.teardown());
  expect(result).toEqual({});
  await expect(frame.locator('.workspace')).toHaveCount(0);
  await expect(frame.locator('.map-canvas')).toHaveCount(0);
});
/** The hand-off dialog's own status line; the workspace has status roles too. */
const deliveryState = (frame: FrameLocator) => frame.getByRole('dialog', { name: '继续规划' }).getByRole('status');
async function reportedSizes(page: Page) {
  return page.evaluate(() => (window as unknown as { cartulaHost: { sizes: { width?: number; height?: number }[] } }).cartulaHost.sizes);
}

test('an unconstrained host is asked for the 1280×720 desktop target and the layout fills it', async ({ page, request }) => {
  const map = await createMap(request, 'size-free');
  const frame = await openHost(page, map, '&noDims=1');
  // A map is unreadable in a small card, so both open axes are asked for.
  await expect.poll(async () => (await reportedSizes(page)).at(-1)).toEqual({ width: 1280, height: 720 });
  // The request and the root layout agree: the workspace uses the granted box.
  await expect.poll(async () => (await frame.locator('.workspace').boundingBox())?.height).toBe(720);
  expect(await rootAttr(frame, 'data-display-mode')).toBe('inline');
  expect(await rootAttr(frame, 'data-compact')).toBeNull();
});

test('a host-fixed axis the view fills is honoured and never re-requested', async ({ page, request }) => {
  const map = await createMap(request, 'size-fixed');
  const frame = await openHost(page, map, '&h=500&w=900');
  await expect(frame.getByRole('button', { name: '展开' })).toBeVisible();
  const box = await frame.locator('.workspace').boundingBox();
  expect(Math.round(box!.height)).toBe(500);
  // Both axes are filled exactly as declared, so every notification would only
  // tell the host the numbers it just sent. There must be none.
  await page.waitForTimeout(800);
  expect(await reportedSizes(page)).toEqual([]);
});

/**
 * The regression the first fix walked straight past: it checked a 1600px
 * *elastic* bound and left the fixed one, which had been reported as "1600
 * filled — the host's decision", in the matrix as expected behaviour.
 *
 * A host that fixes the height at 1600px has decided how much room it has, not
 * that one card must use all of it. The card renders its own height and reports
 * it, which is the host's only chance to take the rest back — and it has to
 * come out right whether or not the host acts on that report.
 */
test('a large host-fixed height is a bound, not an instruction: the card stays one screen', async ({ page, request }) => {
  const map = await createMap(request, 'size-fixed-tall');
  for (const suffix of ['', '&deaf=1']) {
    const frame = await openHost(page, map, `&h=1600&w=900${suffix}`);
    await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height, { message: suffix || 'listening host' }).toBe(720);
    // The frame stays 1600 here — this host fixed it and is not shrinking it —
    // so these three are what decides whether the reader has to scroll.
    expect(await documentHeight(frame), suffix).toBe(720);
    expect(Math.round((await frame.locator('#root').boundingBox())!.height), suffix).toBe(720);
    expect(Math.round((await frame.locator('.workspace').boundingBox())!.height), suffix).toBe(720);
  }
});

test('the layout renders the height the request describes, in every host shape', async ({ page, request }) => {
  const map = await createMap(request, 'size-agreement');
  // One formula, written twice — `--app-height` in styles.css and axisExtent in
  // adapters/host-size.ts. They disagreeing is how a card ends up reporting one
  // height and drawing another, so the pairing is checked rather than assumed.
  // No fixed + elastic pair on one axis: the SDK types `containerDimensions` as
  // `{height} | {maxHeight}`, and Zod drops the other key on the way in. The
  // unit tests still pin `min()` over both, since that is the function's
  // contract — it just cannot be reached through a real bridge.
  for (const [query, expected] of [
    ['&noDims=1', 720], ['&h=1600', 720], ['&maxh=1600', 720],
    ['&h=500', 500], ['&maxh=240', 240], ['&maxh=600', 600],
    ['&maxh=5000&w=766', 720],
  ] as const) {
    const frame = await openHost(page, map, `${query}&deaf=1`);
    // The computed `height`, not `--app-height` itself: a custom property reads
    // back as the token stream that was written, never as what it resolved to.
    expect(await frame.locator(':root').evaluate(root => getComputedStyle(root).height), query).toBe(`${expected}px`);
    expect(await documentHeight(frame), query).toBe(expected);
  }
  // The one place the two deliberately differ: a fractional bound is kept exact
  // by the layout, so the box cannot exceed it, while the request rounds down,
  // so it cannot ask for more than the host allowed. Under a pixel apart, and
  // never on the wrong side of the bound.
  const frame = await openHost(page, map, '&maxh=700.9&deaf=1');
  expect(await frame.locator(':root').evaluate(root => getComputedStyle(root).height)).toBe('700.891px');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(700);
});

test('a host that fixes only the height is still asked for the width it left open', async ({ page, request }) => {
  const map = await createMap(request, 'size-fixed-height');
  const frame = await openHost(page, map, '&h=500');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)).toEqual({ width: 1280 });
  // The fixed axis is taken as given, exactly as it was declared.
  expect(Math.round((await frame.locator('.workspace').boundingBox())!.height)).toBe(500);
});

test('elastic axes stay inside the host bound and settle without a resize loop', async ({ page, request }) => {
  const map = await createMap(request, 'size-max');
  const frame = await openHost(page, map, '&maxh=600&maxw=520');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)).toEqual({ width: 520, height: 600 });
  const box = await frame.locator('.workspace').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(600);
  expect(box!.width).toBeLessThanOrEqual(520);
  // The host echoes a new context after applying the size; the view must not
  // answer that echo with the same numbers again.
  await page.waitForTimeout(1000);
  expect((await reportedSizes(page)).length).toBeLessThanOrEqual(2);
  // Horizontal overflow would mean the width bound was ignored.
  const overflow = await frame.locator('.workspace').evaluate(node => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('a 240px host keeps the compact layout inside its own bound, with the expand entry visible', async ({ page, request }) => {
  const map = await createMap(request, 'size-tiny');
  const frame = await openHost(page, map, '&maxh=240');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(240);
  // The old formula asked for 320 here, overshooting the host's own limit.
  expect((await reportedSizes(page)).some(size => (size.height ?? 0) > 240)).toBe(false);
  expect(await rootAttr(frame, 'data-compact')).toBe('true');
  await expect(frame.getByRole('button', { name: '展开' })).toBeVisible();
  const box = await frame.locator('.workspace').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(240);
});

/**
 * The reported bug, in the numbers the real host actually sent.
 *
 * `containerDimensions: {maxHeight: 5000, width: 766}` was read off the
 * diagnostics panel in Claude Desktop 1.49585.0 on 2026-09-09 — an elastic
 * height bound roughly six screens tall, and a fixed card width. While
 * `axisRequest` took the whole elastic bound (73df4c5) the card asked for all
 * 5000px and `max-height:var(--host-max-height,none)` resolved to 5000px too,
 * which is the "scroll through several screens of map" this all started from.
 */
test('the Claude Desktop shape: 5000px of offered height still renders one screen', async ({ page, request }) => {
  const map = await createMap(request, 'size-claude');
  for (const suffix of ['', '&deaf=1']) {
    const frame = await openHost(page, map, `&maxh=5000&w=766${suffix}`);
    // The width is fixed and filled, so only the height is worth reporting.
    await expect.poll(async () => (await reportedSizes(page)).at(-1), { message: suffix || 'listening host' }).toEqual({ height: 720 });
    expect(await documentHeight(frame), suffix).toBe(720);
    expect(Math.round((await frame.locator('#root').boundingBox())!.height), suffix).toBe(720);
    expect(Math.round((await frame.locator('.workspace').boundingBox())!.width), suffix).toBe(766);
  }
});

/**
 * Claude Desktop 1.49585.0 closes both routes to a bigger canvas at once: it
 * declares `availableDisplayModes: ["inline"]`, and it renders the App in a
 * sandboxed iframe with no `allow="fullscreen"`, so `document.fullscreenEnabled`
 * is false too. Pressing 展开 there did nothing at all — the request was never
 * sent, the browser fallback was refused, and the only sign was a notice after
 * the fact. The entry now depends on a route existing.
 */
test('with no route to a bigger canvas the expand entry is replaced, not left dead', async ({ page, request }) => {
  const map = await createMap(request, 'size-noexpand');
  const shut = await openHost(page, map, '&maxh=5000&w=766&modes=inline&noFullscreen=1');
  expect(await shut.locator(':root').evaluate(() => document.fullscreenEnabled), 'the frame has no fullscreen permission').toBe(false);
  await expect(shut.getByRole('button', { name: '展开' })).toHaveCount(0);
  // What replaces it actually works, and names what it is for.
  await expect(shut.getByRole('button', { name: '在独立页面打开大画布' })).toBeVisible();

  // Either route on its own is enough to keep the entry: the host offering the
  // mode, or the frame being allowed to go fullscreen by itself.
  const hostRoute = await openHost(page, map, '&maxh=5000&w=766&noFullscreen=1');
  await expect(hostRoute.getByRole('button', { name: '展开' })).toBeVisible();
  const browserRoute = await openHost(page, map, '&maxh=5000&w=766&modes=inline');
  await expect(browserRoute.getByRole('button', { name: '展开' })).toBeVisible();
});

test('a host with more room than the card can use is asked for the target, not the whole bound', async ({ page, request }) => {
  const map = await createMap(request, 'size-roomy');
  const frame = await openHost(page, map, '&maxh=1600&maxw=1400');
  // An elastic bound is permission, not an instruction: 1600px of room is the
  // host describing itself, and a card that took all of it is the several
  // screens of map the reader had to scroll past.
  await expect.poll(async () => (await reportedSizes(page)).at(-1)).toEqual({ width: 1280, height: 720 });
  expect(Math.round((await frame.locator('.workspace').boundingBox())!.height)).toBe(720);
});

/**
 * The hosts this has to survive do not act on `ui/notifications/size-changed`;
 * they size the frame by measuring the document instead
 * (anthropics/claude-ai-mcp#69). So the card has to come out the right height
 * with no cooperation at all — and a host bound below the target still wins,
 * which is the other half: the same app was a 240px sliver in one host while it
 * was several screens tall in another.
 */
test('a host that never acts on a size notification still renders a card of the right height', async ({ page, request }) => {
  const map = await createMap(request, 'size-deaf');
  for (const [query, expected] of [['&noDims=1', 720], ['&maxh=1600&maxw=1400', 720], ['&maxh=240', 240]] as const) {
    const frame = await openHost(page, map, `${query}&deaf=1`);
    // What such a host reads off the frame, and what it actually shows.
    await expect.poll(() => documentHeight(frame), { message: query }).toBe(expected);
    expect(Math.round((await frame.locator('#root').boundingBox())!.height), query).toBe(expected);
    expect(Math.round((await frame.locator('.workspace').boundingBox())!.height), query).toBe(expected);
  }
});

test('a partial context update relayouts without losing the negotiated dimensions', async ({ page, request }) => {
  const map = await createMap(request, 'size-partial');
  const frame = await openHost(page, map, '&maxh=600');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(600);
  const before = (await reportedSizes(page)).length;
  // Theme-only update: the SDK merges it into the context, dimensions stay.
  await page.evaluate(() => (window as unknown as { cartulaHost: { sendPartial: (patch: unknown) => void } }).cartulaHost.sendPartial({ theme: 'dark' }));
  await page.waitForTimeout(500);
  expect(await reportedSizes(page)).toHaveLength(before);
  expect(await rootAttr(frame, 'data-display-mode')).toBe('inline');
  await expect(frame.locator('.workspace')).toBeVisible();

  // Dimensions-only update: a new bound is adopted and reported once.
  await page.evaluate(() => (window as unknown as { cartulaHost: { setDimensions: (d: unknown) => void } }).cartulaHost.setDimensions({ maxHeight: 420 }));
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(420);
  await expect.poll(async () => (await frame.locator('.workspace').boundingBox())?.height).toBeLessThanOrEqual(420);
  await expect(frame.locator('.map-canvas')).toBeVisible();
});

test('a refused fullscreen request is visible and offers the standalone page', async ({ page, request }) => {
  const map = await createMap(request, 'expand-deny');
  const frame = await openHost(page, map, '&display=deny&noFullscreen=1&links=record');
  await frame.getByRole('button', { name: '展开' }).click();
  const notice = frame.locator('.notice.info');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('宿主没有切换到全屏');
  await expect(notice).toContainText('浏览器全屏也未生效');
  const link = frame.getByRole('link', { name: '在独立页面打开大画布' });
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toContain(`/map/${map.id}`);
  await link.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { cartulaHost: { openedLinks: string[] } }).cartulaHost.openedLinks))
    .toEqual([await link.getAttribute('href')]);
  // A refused request must not leave the app claiming a fullscreen mode.
  expect(await rootAttr(frame, 'data-display-mode')).toBe('inline');
  expect(await rootAttr(frame, 'data-browser-fullscreen')).toBeNull();
});

test('a rejected ui/message is reported as refused, with the copy fallback intact', async ({ page, request }) => {
  const map = await createMap(request, 'msg-reject');
  const frame = await openHost(page, map, '&message=reject');
  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await frame.getByLabel('这次修改的意图', { exact: true }).fill('每天开车不超过三小时');
  await frame.getByRole('button', { name: '提交给 Agent 继续规划' }).click();
  const state = deliveryState(frame);
  await expect(state).toContainText('这条消息被拒绝了');
  await expect(state).toContainText('修改已保存到地图');
  // A refusal means nothing arrived, so resending needs no confirmation.
  await expect(frame.getByRole('button', { name: '再发送一次', exact: true })).toBeEnabled();
  await expect(frame.getByRole('button', { name: '复制消息', exact: true })).toBeVisible();
  expect(await frame.getByLabel('本轮修改消息').inputValue()).toContain('每天开车不超过三小时');
});

/**
 * Getting a link out of a card the host will not let touch the clipboard.
 *
 * Measured here rather than assumed, because the app cannot ask for the
 * permission and the host does not grant it: inside this sandboxed iframe —
 * `sandbox="allow-scripts allow-downloads"`, so an opaque origin, the same
 * shape Claude Desktop uses — `navigator.clipboard.writeText` rejects, while
 * `document.execCommand('copy')` still works. That asymmetry is the whole
 * reason `clipboard.ts` tries both, and this is the test that would catch it
 * going away.
 *
 * Either way the link and the Agent hand-off are on screen in fields the reader
 * can select, which is what makes a refusal survivable rather than a dead end.
 */
test('a card copies its share link through the route a sandboxed host still allows', async ({ page, request }) => {
  const map = await createMap(request, 'share-copy');
  const frame = await openHost(page, map);
  const refusal = await frame.locator(':root').evaluate(async () => {
    try { await navigator.clipboard.writeText('probe'); return 'allowed'; }
    catch (error) { return (error as Error).name; }
  });
  expect(refusal, 'the premise: a host iframe refuses the async clipboard').toBe('NotAllowedError');

  await frame.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = frame.getByRole('dialog', { name: '分享地图', exact: true });
  await expect(dialog.getByText('还没有分享链接。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '生成只读链接', exact: true }).click();
  await expect(dialog.getByLabel('分享链接', { exact: true })).toHaveValue(/#preview=/);
  await expect(dialog.getByLabel('分享给 Agent', { exact: true })).toHaveValue(/previewToken/);
  // The list the 停用全部分享 button is about — built through the same tool call
  // the card uses for everything else.
  await expect(dialog.locator('.share-list li')).toHaveCount(1);
  await dialog.getByRole('button', { name: '复制分享链接', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '复制分享链接', exact: true })).toHaveAttribute('title', '已复制');
  await dialog.locator('.share-list li').first().getByRole('button').click();
  await expect(dialog.getByText('还没有分享链接。', { exact: true })).toBeVisible();
});

test('an unanswered ui/message is reported as unknown and is never resent automatically', async ({ page, request }) => {
  const map = await createMap(request, 'msg-timeout');
  const frame = await openHost(page, map, '&message=timeout');
  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await frame.getByRole('button', { name: '提交给 Agent 继续规划' }).click();
  const state = deliveryState(frame);
  await expect(state).toContainText('结果未知', { timeout: 25_000 });
  await expect(frame.getByText('不要重复发送')).toBeVisible();
  // Resending stays behind an explicit confirmation that the user looked: the
  // message may already be sitting in the conversation.
  const resend = frame.getByRole('button', { name: '再发送一次', exact: true });
  await expect(resend).toBeDisabled();
  await frame.getByText('我已回对话确认，那里没有这条消息').click();
  await expect(resend).toBeEnabled();
  await expect(frame.getByRole('button', { name: '复制消息', exact: true })).toBeVisible();
  // Nothing reached the conversation, and nothing was retried on its own.
  expect(await page.locator('#message').textContent()).toBe('');
});

test('saving stays available and distinct from handing over when the host takes no messages', async ({ page, request }) => {
  const map = await createMap(request, 'msg-none');
  const frame = await openHost(page, map, '&noMessage=1');
  await frame.getByTestId('layer-plan-a').getByRole('button').first().click();
  await frame.getByTestId('point-yichun').getByRole('button').first().click();
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.getByLabel('地点规划意图', { exact: true }).fill('这里多留一天');
  await frame.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#context')).toContainText('"version":2');
  await expect(page.locator('#message')).toHaveText('');

  await frame.getByRole('button', { name: '更多', exact: true }).click();
  await frame.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await expect(frame.getByText(/本轮修改摘要/)).toBeVisible();
  await frame.getByRole('button', { name: '提交给 Agent 继续规划' }).click();
  const state = deliveryState(frame);
  await expect(state).toContainText('不能直接发送到对话');
  await expect(state).toContainText('修改已保存到地图');
  await expect(frame.getByText(/本轮交给 Agent 的修改/)).toBeVisible();
  expect(await frame.getByLabel('本轮修改消息').inputValue()).toContain('这里多留一天');
});

test('routes keep their layer colour, and 只看 keeps the candidate spots on the map', async ({ page, request }) => {
  const map = await createMap(request, 'compare');
  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '对比路线' }).click();
  const compare = page.locator('.route-compare');
  await expect(compare).toBeVisible();
  const rows = compare.locator('.compare-list .compare-name');
  await expect(rows).toHaveText(['方案 A', '方案 B']);
  // Distance and the routing provider's travel time, not an invented trip time.
  // Each value sits with its own label; a flat grid used to pair "620 km"
  // with the next metric's caption.
  const metrics = compare.locator('.compare-list li').first().locator('.compare-metric');
  await expect(metrics).toHaveCount(3);
  for (const [index, value, label] of [[0, '620 km', '路由里程'], [1, '8 小时', '纯驾驶时间'], [2, '3 天', '按天安排']] as const) {
    await expect(metrics.nth(index)).toContainText(value);
    await expect(metrics.nth(index)).toContainText(label);
  }
  const swatch = compare.locator('.compare-swatch').first();
  expect(await swatch.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(37, 99, 235)');

  // Colouring is two-dimensional by default: one legend row per plan, and
  // inside a row every day is a visibly different shade of that plan.
  const planRow = compare.locator('.compare-legend .legend-row').filter({ hasText: '方案 A' });
  const shades = await planRow.locator('.legend-item i').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  expect(shades).toHaveLength(3);
  expect(new Set(shades).size).toBe(3);

  await compare.getByRole('button', { name: '只看 方案 A' }).click();
  await expect(page.getByTestId('layer-plan-b')).toHaveClass(/hidden-layer/);
  await expect(page.getByTestId('layer-spots')).not.toHaveClass(/hidden-layer/);
  await expect(page.getByTestId('layer-plan-a')).not.toHaveClass(/hidden-layer/);
  await compare.getByRole('button', { name: '显示全部路线' }).click();
  await expect(page.getByTestId('layer-plan-b')).not.toHaveClass(/hidden-layer/);
});

test('planning intents start collapsed and read as Chinese when opened', async ({ page, request }) => {
  const map = await createMap(request, 'intents');
  await (await request.post(`/api/maps/${map.id}/edit`, {
    headers: { Authorization: `Bearer ${map.editKey}` },
    data: { baseVersion: 1, requestId: randomUUID(), operations: [{ op: 'intent.set', scope: 'map', text: '国庆期间避开高速拥堵', priority: 'must' }] },
  })).json();
  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  const banner = page.locator('.map-intent-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('规划意图 · 1 条');
  await expect(banner).not.toContainText('国庆期间避开高速拥堵');
  await expect(banner).not.toContainText('must');
  await banner.getByRole('button').click();
  await expect(banner).toContainText('必须做到');
  await expect(banner).toContainText('国庆期间避开高速拥堵');
});


test('a granted fullscreen mode is adopted, asks for no size, and hands the layout back on exit', async ({ page, request }) => {
  const map = await createMap(request, 'expand-grant');
  const frame = await openHost(page, map, '&display=host&maxh=520');
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(520);
  const inlineHeight = (await frame.locator('.workspace').boundingBox())!.height;
  const before = (await reportedSizes(page)).length;

  await frame.getByRole('button', { name: '展开' }).click();
  await expect.poll(() => rootAttr(frame, 'data-display-mode')).toBe('fullscreen');
  // The host owns the surface in fullscreen; asking for a size there would
  // fight it, and the refusal notice must not appear for a granted request.
  await expect(frame.locator('.notice.info')).toHaveCount(0);
  await expect.poll(async () => (await frame.locator('.workspace').boundingBox())!.height).toBeGreaterThan(inlineHeight);
  expect(await reportedSizes(page)).toHaveLength(before);
  // Browser fullscreen was never involved, so its own marker stays absent.
  expect(await rootAttr(frame, 'data-browser-fullscreen')).toBeNull();

  await page.evaluate(() => (window as unknown as { cartulaHost: { setDisplayMode: (mode: string) => void } }).cartulaHost.setDisplayMode('inline'));
  await expect.poll(() => rootAttr(frame, 'data-display-mode')).toBe('inline');
  await expect.poll(async () => (await frame.locator('.workspace').boundingBox())!.height).toBeLessThanOrEqual(520);
  // Coming back is a new negotiation, and it stays inside the host's bound.
  await expect.poll(async () => (await reportedSizes(page)).at(-1)?.height).toBe(520);
  expect((await reportedSizes(page)).some(size => (size.height ?? 0) > 520)).toBe(false);
});

test('a resize keeps the camera the user chose', async ({ page, request }) => {
  // Two close stops leave most of the canvas empty, so the drag below pans the
  // map instead of grabbing a marker.
  const map = await (await request.put(`/m/camera-${randomUUID()}`, { data: { title: '相机', layers: [{ id: 'route', name: '短途', kind: 'route', color: '#2563eb', points: [
    { id: 'a', name: '起点', at: [126.53, 45.8] }, { id: 'b', name: '终点', at: [126.58, 45.84] },
  ] }] } })).json() as { editUrl: string };
  await page.goto(map.editUrl);
  const canvas = page.locator('.map-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-mode', 'webgl');
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(4);
  // Pan by hand: from here the view belongs to the user.
  const box = (await canvas.boundingBox())!;
  const framed = await canvas.getAttribute('data-center');
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const zoom = await canvas.getAttribute('data-zoom');
  const center = await canvas.getAttribute('data-center');
  expect(center).not.toBe(framed);

  await page.setViewportSize({ width: 900, height: 620 });
  await page.waitForTimeout(900);
  expect(await canvas.getAttribute('data-zoom')).toBe(zoom);
  expect(await canvas.getAttribute('data-center')).toBe(center);

  // Asking to see everything is still the way back to a framed view.
  await page.getByRole('button', { name: '适应全部图层', exact: true }).click();
  await expect.poll(async () => canvas.getAttribute('data-center')).not.toBe(center);
});

test('a submit whose response is lost is not committed twice when the user retries', async ({ page, request }) => {
  const map = await createMap(request, 'submit-recovery');
  // The request reaches the server; only the response is dropped, which is
  // exactly what a flaky connection does after a successful write.
  let dropped = 0;
  await page.route('**/api/maps/*/submit', async route => {
    if (dropped > 0) { await route.continue(); return; }
    dropped += 1;
    await route.fetch();
    await route.abort('connectionfailed');
  });
  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '继续规划' });
  await dialog.getByLabel('这次修改的意图', { exact: true }).fill('国庆前一天出发');
  await dialog.getByRole('button', { name: '生成继续规划消息' }).click();
  // The write landed, so the version moves even though the page saw an error.
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('可复制的继续规划消息')).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json()).version).toBe(2);

  // Polling has surfaced the new version by now; retrying the same round must
  // replay the same request, not write a second one.
  await expect.poll(async () => page.getByRole('button', { name: /最近修改/ }).first().textContent(), { timeout: 15_000 }).toContain('v2');
  await dialog.getByRole('button', { name: '生成继续规划消息' }).click();
  await expect(dialog.getByLabel('本轮修改消息')).toBeVisible();
  const state = await (await request.get(`/m/${map.id}?since=0`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json();
  expect(state.version).toBe(2);
  // De-duplication has to be decided before the version check, or the replay
  // would come back as a conflict instead of the original result.
  const commits = (state.events as Array<{ operations: Array<{ op: string }> }>).flatMap(event => event.operations).filter(op => op.op === 'draft.commit');
  expect(commits).toHaveLength(1);
  // Submitted intents upsert rather than append, so a double write would be
  // invisible in the intent list — the event count above is what proves it.
  expect((state.intents as Array<{ text: string }>).filter(intent => intent.text === '国庆前一天出发')).toHaveLength(1);
  expect(await dialog.getByLabel('本轮修改消息').inputValue()).toContain('国庆前一天出发');
});


test('the hand-off cursor stops at the version its message describes', async ({ page, context, request }) => {
  const map = await createMap(request, 'handoff-cursor');
  await context.grantPermissions(['clipboard-write']);
  // While the submit is in flight another client writes: the read-back that
  // follows already sees that newer version, but the message does not contain
  // it, so it must not count as handed over.
  let injected = false;
  await page.route('**/api/maps/*/submit', async route => {
    const response = await route.fetch();
    if (!injected) {
      injected = true;
      const written = await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json() as { version: number };
      const other = await request.post(`/api/maps/${map.id}/edit`, {
        headers: { Authorization: `Bearer ${map.editKey}` },
        data: { baseVersion: written.version, requestId: randomUUID(), operations: [{ op: 'annotate', layerId: 'plan-a', pointId: 'jiayin', text: '另一端补充的备注' }] },
      });
      expect(other.ok()).toBeTruthy();
    }
    await route.fulfill({ response });
  });

  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  // One edit of our own first, so this round has something to hand over.
  await page.getByTestId('layer-plan-a').getByRole('button').first().click();
  await page.getByTestId('point-yichun').getByRole('button').first().click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('出发前再确认');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json()).version).toBe(2);

  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '继续规划' });
  await dialog.getByLabel('这次修改的意图', { exact: true }).fill('把行程压到十天');
  await dialog.getByRole('button', { name: '生成继续规划消息' }).click();

  // v3 is this hand-off; v4 belongs to the other client.
  await expect(dialog.getByRole('status')).toContainText('修改已保存到地图 v3');
  expect(await (await request.get(`/m/${map.id}`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json()).toMatchObject({ version: 4 });
  const delta = await (await request.get(`/m/${map.id}?since=3`, { headers: { Authorization: `Bearer ${map.editKey}` } })).json() as { changes: string[] };
  const otherChange = delta.changes[0];
  expect(otherChange).toBeTruthy();
  // This round is not empty, and it does not include the other client's edit.
  await expect(dialog.getByText(/本轮交给 Agent 的修改 · [1-9]\d* 条/)).toBeVisible();
  await expect(dialog.getByText(otherChange, { exact: false })).toHaveCount(0);

  await dialog.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  // Reopening shows the other client's change as still un-submitted: the
  // cursor moved to v3, not to whatever the map had become.
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await expect(dialog.getByText(/本轮修改摘要 · [1-9]\d* 条/)).toBeVisible();
  await expect(dialog.getByText(otherChange, { exact: false })).toBeVisible();
});

test('BUILD-01 the App declares the release of the service that served it', async ({ page, request }) => {
  const map = await createMap(request, 'release');
  await openHost(page, map);
  const health = await (await request.get('/healthz')).json() as { release: string; version: string };
  // Both halves of the handshake name one build: the server in `serverInfo`,
  // the App in `ui/initialize`. A mismatch means the frame outlived a deploy.
  await expect.poll(async () => page.evaluate(() => (window as unknown as { cartulaHost: { appVersion: () => { name: string; version: string } | undefined } }).cartulaHost.appVersion()))
    .toEqual({ name: 'Cartula', version: health.release });
  expect(health.release.startsWith(health.version)).toBe(true);
});

test('UX-03 / RETEST-01 pending changes are named, handed over once, and stay handed over across a reopen', async ({ page, request }) => {
  const map = await createMap(request, 'pending-handoff');
  const auth = { Authorization: `Bearer ${map.editKey}` };
  const frame = await openHost(page, map);
  // Nothing is waiting on a map nobody has touched.
  await expect(frame.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toHaveCount(0);

  await frame.getByTestId('layer-plan-a').getByRole('button').first().click();
  await frame.getByTestId('point-yichun').getByRole('button').first().click();
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.getByLabel('备注', { exact: true }).fill('这里多留一天');
  await frame.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#context')).toContainText('"version":2');

  // Saved is not handed over, and the entry says how much is waiting.
  const pending = frame.getByRole('button', { name: /交给 Agent · \d+ 条/ });
  await expect(pending).toBeVisible();
  // It opens the same dialog the menu does — one submission path, not two.
  await pending.click();
  await frame.getByRole('button', { name: '提交给 Agent 继续规划' }).click();
  await expect(deliveryState(frame)).toContainText('已交给对话');
  await frame.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(pending).toHaveCount(0, { timeout: 15_000 });
  // The delivery is recorded on the server, which is the only place a sandboxed
  // frame can read it back from.
  await expect.poll(async () => (await (await request.get(`/m/${map.id}?since=0`, { headers: auth })).json()).handoffVersion).toBeGreaterThan(0);

  // Reopen: a new frame, a new App, and — in a sandboxed host — no storage at
  // all. No Agent has answered; the boundary still has to come back.
  const reopened = await openHost(page, map);
  await expect(reopened.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toHaveCount(0);
  await reopened.getByRole('button', { name: /最近修改/ }).first().click();
  await reopened.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await expect(reopened.getByText(/本轮修改摘要 · 暂无新修改/)).toBeVisible();
  await expect(reopened.getByText('这里多留一天')).toHaveCount(0);

  // A change made after that hand-off is this round, and it is offered again.
  await reopened.getByRole('button', { name: '关闭', exact: true }).click();
  const now = await (await request.get(`/m/${map.id}?since=0`, { headers: auth })).json() as { version: number };
  const later = await request.post(`/api/maps/${map.id}/edit`, { headers: auth, data: { baseVersion: now.version, requestId: randomUUID(), operations: [{ op: 'annotate', layerId: 'plan-a', pointId: 'harbin', text: '出发前再确认' }] } });
  expect(later.ok()).toBeTruthy();
  await expect(reopened.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toBeVisible({ timeout: 15_000 });
});

test('RETEST-01 the standalone page keeps its hand-off boundary across a reload', async ({ page, context, request }) => {
  const map = await createMap(request, 'cursor-reload');
  await context.grantPermissions(['clipboard-write']);
  await page.goto(map.editUrl);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('layer-plan-a').getByRole('button').first().click();
  await page.getByTestId('point-yichun').getByRole('button').first().click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('这里多留一天');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toBeVisible();

  // A standalone page hands over by copying the message; that is the confirmation.
  await page.getByRole('button', { name: /交给 Agent · \d+ 条/ }).click();
  const dialog = page.getByRole('dialog', { name: '继续规划' });
  await dialog.getByRole('button', { name: '生成继续规划消息' }).click();
  await dialog.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toHaveCount(0);

  // Reload with no agent answer at all: the boundary is this side's own record.
  await page.reload();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: /交给 Agent · \d+ 条/ })).toHaveCount(0);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '按这些修改继续规划', exact: true }).click();
  await expect(page.getByText(/本轮修改摘要 · 暂无新修改/)).toBeVisible();
});
