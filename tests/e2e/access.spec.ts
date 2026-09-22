import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { WriteResult } from '../../src/core/types.js';
import type { MapAccess, MapLibrary, SpaceCredential } from '../../src/core/access.js';

type Created = WriteResult & SpaceCredential & { access: MapAccess };
const password = 'A-long-Cartula-password-2026!';
const input = (title: string) => ({ title, layers: [{ id: 'route', name: '周末路线', points: [
  { id: 'start', name: '河边出发', at: [121.48, 31.22] },
  { id: 'end', name: '花园休息', at: [121.49, 31.23] },
] }] });
const headers = (key: string) => ({ Authorization: `Bearer ${key}` });
async function createMap(request: APIRequestContext, title: string, key?: string): Promise<Created> {
  const result = await request.put(`/m/access-${randomUUID()}`, { data: input(title), headers: key ? headers(key) : {} });
  expect(result.ok()).toBeTruthy();
  return result.json();
}
async function useFallback(page: Page) {
  // Authorization UI does not depend on basemap availability. The existing
  // workspace suite separately covers live tiles and WebGL rendering.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      return type.includes('webgl') ? null : (getContext as Function).apply(this, [type, ...args]);
    } as typeof getContext;
  });
}
async function registerThroughForm(page: Page, email: string) {
  const dialog = page.getByRole('dialog').last();
  if (!(await dialog.getByLabel('确认密码', { exact: true }).isVisible())) {
    await dialog.getByRole('button', { name: /^(注册|没有账号，去注册)$/ }).click();
  }
  await dialog.getByLabel('邮箱', { exact: true }).fill(email);
  await dialog.getByLabel('密码', { exact: true }).fill(password);
  await dialog.getByLabel('确认密码', { exact: true }).fill(password);
  const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^注册(?:并.*)?$/ }).last().click();
  expect((await registered).ok()).toBeTruthy();
}

test('anonymous space credentials survive reload and are reused for a new map', async ({ page, request }, info) => {
  await useFallback(page);
  const first = await createMap(request, '匿名空间的第一张图');
  await page.goto(first.editUrl!);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账号', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存到账号', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.screenshot({ path: info.outputPath('anonymous-desktop.png') });
  await page.reload();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
  await page.goto('/app?new=1');
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await page.getByLabel('图层名称', { exact: true }).fill('新建路线');
  await page.getByRole('button', { name: '创建图层', exact: true }).click();
  await expect(page).toHaveURL(/\/map\//);
  const secondId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(secondId).not.toBe(first.id);
  const library = await (await request.get('/api/maps', { headers: headers(first.spaceKey) })).json() as MapLibrary;
  expect(library.maps.map(map => map.id)).toEqual(expect.arrayContaining([first.id, secondId]));
  await page.reload();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
});

test('opening another anonymous space does not strand the first or override an explicit preview', async ({ page, request }) => {
  await useFallback(page);
  const first = await createMap(request, '保留第一空间的访问');
  const second = await createMap(request, '第二个匿名空间');
  for (const map of [first, second]) {
    await page.goto(map.editUrl!);
    await expect(page.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
  }
  await page.goto(first.url);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
  const shared = await request.post(`/api/maps/${first.id}/preview`, { headers: headers(first.spaceKey), data: {} });
  const { previewUrl } = await shared.json();
  await page.goto(previewUrl);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '分享', exact: true })).toHaveCount(0);
  await request.delete(`/api/maps/${first.id}/preview`, { headers: headers(first.spaceKey) });
  await page.reload();
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeVisible();
});

test('a lost first-save response can be retried with the saved space key', async ({ page, request }) => {
  await useFallback(page);
  let savedId: string | undefined;
  let attempts = 0;
  const keys: string[] = [];
  await page.route('**/m/*', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    attempts += 1;
    keys.push(route.request().headers().authorization ?? '');
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    if (attempts === 1) { savedId = saved.id; await route.abort('failed'); }
    else { expect(saved.id).toBe(savedId); await route.fulfill({ response }); }
  });
  await page.goto('/?new=1');
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await page.getByLabel('图层名称', { exact: true }).fill('重试后仍然保存的路线');
  await page.getByRole('button', { name: '创建图层', exact: true }).click();
  await expect.poll(() => attempts).toBe(1);
  await expect(page.getByRole('button', { name: '创建图层', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '创建图层', exact: true }).click();
  await expect(page).toHaveURL(/\/map\//);
  expect(attempts).toBe(2);
  expect(keys[0]).toMatch(/^Bearer csk_/);
  expect(keys[1]).toBe(keys[0]);
  const library = await (await request.get('/api/maps', { headers: { Authorization: keys[0] } })).json() as MapLibrary;
  expect(library.maps.map(map => map.id)).toEqual([savedId]);
  await page.reload();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
});

test('register from a result, claim the complete space, logout and reopen through the account', async ({ page, request }, info) => {
  await useFallback(page);
  const first = await createMap(request, '准备保存到账号的路线');
  const second = await createMap(request, '相同空间里的另一张图', first.spaceKey);
  await page.goto(first.editUrl!);
  await page.getByRole('button', { name: '保存到账号', exact: true }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toContainText('2 张地图');
  const email = `${randomUUID()}@example.test`;
  await registerThroughForm(page, email);
  await expect(page.getByRole('button', { name: '保存到账号', exact: true })).toHaveCount(0);
  const state = await (await page.request.get(`/m/${first.id}`)).json();
  expect(state.access).toMatchObject({ claimed: true, editable: true });
  const library = await (await page.request.get('/api/maps')).json() as MapLibrary;
  expect(library.maps.map(map => map.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  await page.getByRole('button', { name: /^账号(?: · )?/ }).click();
  await page.getByRole('button', { name: '我的地图', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: second.title })).toBeVisible();
  await page.screenshot({ path: info.outputPath('account-library.png') });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toHaveCount(0);
  await page.goto(first.url);
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  const unauthorized = await page.request.get(`/m/${first.id}`);
  expect([401, 403, 404]).toContain(unauthorized.status());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const login = page.getByRole('dialog').last();
  await login.getByLabel('邮箱', { exact: true }).fill(email);
  await login.getByLabel('密码', { exact: true }).fill(password);
  await login.getByRole('button', { name: /^登录(?:并.*)?$/ }).last().click();
  await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建图层', exact: true })).toBeEnabled();
  // Claim did not interrupt the Agent holding the original space key.
  const agentRead = await request.get(`/m/${first.id}`, { headers: headers(first.spaceKey) });
  expect(agentRead.ok()).toBeTruthy();
});

test('a preview can be favorited and copied, and revocation leaves the copy intact', async ({ page, browser, request }, info) => {
  await useFallback(page);
  const map = await createMap(request, '可收藏的周末路线');
  await page.goto(map.editUrl!);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const shareDialog = page.getByRole('dialog').last();
  // Nothing is shared yet, so the button that would stop every share has
  // nothing to stop.
  await expect(shareDialog.getByRole('button', { name: '停用全部分享', exact: true })).toBeDisabled();
  await expect(shareDialog.getByText('还没有分享链接。', { exact: true })).toBeVisible();
  await shareDialog.getByRole('button', { name: '生成只读链接', exact: true }).click();
  // The address is on screen, in a field, whether or not this browser allows
  // the clipboard — that is the only way a link leaves a host webview.
  await expect(shareDialog.getByLabel('分享链接', { exact: true })).toHaveValue(/#preview=/);
  await expect(shareDialog.getByLabel('分享给 Agent', { exact: true })).toHaveValue(/previewToken/);
  await expect(shareDialog.getByRole('button', { name: '复制分享链接', exact: true })).toBeVisible();
  // And the list now names the link the button above would revoke.
  await expect(shareDialog.locator('.share-list li')).toHaveCount(1);
  await expect(shareDialog.getByText('只读', { exact: true })).toBeVisible();
  const previewUrl = await shareDialog.getByLabel('分享链接', { exact: true }).inputValue();
  expect(previewUrl).toContain('#preview=');
  expect(previewUrl).not.toContain(map.spaceKey);
  const previewToken = new URLSearchParams(new URL(previewUrl).hash.slice(1)).get('preview')!;
  expect(previewToken).toBeTruthy();
  const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const viewer = await viewerContext.newPage();
    await useFallback(viewer);
    await viewer.goto(previewUrl);
    await expect(viewer.getByRole('heading', { name: map.title, exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: '新建图层', exact: true })).toBeDisabled();
    await expect(viewer.getByRole('button', { name: '分享', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: '保存到账号', exact: true })).toHaveCount(0);
    await viewer.getByRole('button', { name: '收藏', exact: true }).click();
    await registerThroughForm(viewer, `${randomUUID()}@example.test`);
    await expect.poll(async () => {
      const list = await (await viewer.request.get('/api/maps')).json() as MapLibrary;
      return list.favorites?.some(item => item.id === map.id && item.available) ?? false;
    }).toBe(true);
    await viewer.screenshot({ path: info.outputPath('preview-mobile.png') });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.getByRole('button', { name: /^账号(?: · )?/ }).click();
    const accountPanel = viewer.getByRole('dialog', { name: '账号', exact: true });
    await accountPanel.getByRole('button', { name: '收藏', exact: true }).click();
    const removed = viewer.waitForResponse(response => response.url().endsWith(`/api/me/favorites/${map.id}`) && response.request().method() === 'DELETE');
    // Row actions live behind the ⋯ menu — see `LibraryList`.
    await accountPanel.getByRole('button', { name: `${map.title} 的操作`, exact: true }).click();
    await accountPanel.getByRole('menuitem', { name: '移除收藏', exact: true }).click();
    expect((await removed).ok()).toBeTruthy();
    await expect(accountPanel.getByRole('link', { name: map.title })).toHaveCount(0);
    await accountPanel.getByRole('button', { name: '关闭账号面板', exact: true }).click();
    const noFavorites = await (await viewer.request.get('/api/maps')).json() as MapLibrary;
    expect(noFavorites.favorites.some(item => item.id === map.id)).toBe(false);
    const favoritedAgain = viewer.waitForResponse(response => response.url().endsWith(`/api/me/favorites/${map.id}`) && response.request().method() === 'PUT');
    await viewer.getByRole('button', { name: '收藏', exact: true }).click();
    expect((await favoritedAgain).ok()).toBeTruthy();
    await viewer.getByRole('button', { name: '复制地图', exact: true }).click();
    await expect(viewer.getByRole('heading', { name: `${map.title} · 副本`, exact: true })).toBeVisible();
    const copyId = new URL(viewer.url()).pathname.split('/').at(-1)!;
    expect(copyId).not.toBe(map.id);
    const copy = await (await viewer.request.get(`/m/${copyId}`)).json();
    expect(copy.access.editable).toBe(true);
    const revoked = page.waitForResponse(response => response.url().endsWith(`/api/maps/${map.id}/preview`) && response.request().method() === 'DELETE');
    await shareDialog.getByRole('button', { name: '停用全部分享', exact: true }).click();
    expect((await revoked).ok()).toBeTruthy();
    const denied = await request.get(`/m/${map.id}`, { headers: headers(previewToken) });
    expect([401, 403, 404]).toContain(denied.status());
    await viewer.reload();
    await expect(viewer.getByRole('heading', { name: `${map.title} · 副本`, exact: true })).toBeVisible();
    const list = await (await viewer.request.get('/api/maps')).json() as MapLibrary;
    expect(list.favorites.find(item => item.id === map.id)?.available).toBe(false);
    expect(list.maps.some(item => item.id === copyId)).toBe(true);
  } finally { await viewerContext.close(); }
});

/**
 * The share dialog as it behaves inside a host that forbids the clipboard.
 *
 * Reported from a real MCP card: every 复制 button answered 无法复制 while the
 * same page copied fine in a browser. A card runs in an iframe the host owns and
 * `clipboard-write` defaults to `self`, so the async API is refused and cannot
 * be asked for. Both routes are blocked here on purpose — what has to survive is
 * the link itself, on screen, selected, with the keystroke named.
 *
 * The list is the other half: 停用全部分享 used to sit under nothing at all.
 */
test('the share dialog hands over the link where the clipboard is refused, and lists what it would revoke', async ({ page, request }, info) => {
  await useFallback(page);
  const map = await createMap(request, '分享面板');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('NotAllowedError')) },
    });
    // The older route is not governed by the permission policy, so a webview
    // that refuses it too is the worst case this has to survive.
    document.execCommand = () => false;
  });
  await page.goto(map.editUrl!);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享地图', exact: true });
  await expect(dialog.getByText('还没有分享链接。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '停用全部分享', exact: true })).toBeDisabled();

  await dialog.getByRole('button', { name: '生成只读链接', exact: true }).click();
  const link = dialog.getByLabel('分享链接', { exact: true });
  await expect(link).toHaveValue(/#preview=/);
  const handoff = dialog.getByLabel('分享给 Agent', { exact: true });
  await expect(handoff).toHaveValue(/previewToken/);
  await dialog.getByRole('button', { name: '复制分享链接', exact: true }).click();
  await expect(dialog.getByText('这个环境不允许自动复制，已选中，请按 Ctrl/⌘+C。', { exact: true })).toBeVisible();
  // Selected, so the keystroke is the only step left — and the address is still
  // readable, which is what makes this a way out rather than a dead end.
  const selected = await link.evaluate(field => {
    const input = field as HTMLInputElement;
    return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
  });
  expect(selected).toBe(await link.inputValue());
  await page.screenshot({ path: info.outputPath('share-dialog.png') });

  // A second link, editable this time. Each mint is its own row.
  await dialog.getByText('允许对方编辑').click();
  await dialog.getByRole('button', { name: '生成可编辑链接', exact: true }).click();
  await expect(dialog.locator('.share-list li')).toHaveCount(2);
  await expect(dialog.getByText('可编辑', { exact: true })).toBeVisible();
  const listed = await (await request.get(`/api/maps/${map.id}/preview`, { headers: headers(map.spaceKey) })).json();
  expect(listed.links).toHaveLength(2);
  expect(JSON.stringify(listed.links)).not.toContain('cpt_');

  // One row at a time, and then the rest.
  await dialog.locator('.share-list li').first().getByRole('button').click();
  await expect(dialog.locator('.share-list li')).toHaveCount(1);
  await dialog.getByRole('button', { name: '停用全部分享', exact: true }).click();
  await expect(dialog.getByText('还没有分享链接。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '停用全部分享', exact: true })).toBeDisabled();
  const emptied = await (await request.get(`/api/maps/${map.id}/preview`, { headers: headers(map.spaceKey) })).json();
  expect(emptied.links).toEqual([]);
});

test('a bare private result has a login recovery entry without revealing map content', async ({ page, request }) => {
  const map = await createMap(request, '不应显示的私有地图标题');
  await page.goto(map.url);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByText(map.title, { exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
});
