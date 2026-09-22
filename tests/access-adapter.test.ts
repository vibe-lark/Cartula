/**
 * Spaces, accounts and shares as the view actually performs them.
 *
 * Two things are being pinned down here. The first is what a credential is
 * allowed to do: an owner key never authorises a favorite, a preview token
 * never authorises a share, and a key kept in this browser is dropped the
 * moment an account takes the space over — otherwise signing out would leave
 * the next person holding the door open.
 *
 * The second is that nothing about the map — its version cursor, its pending
 * writes, the credential it is read with — may be reshaped by an answer that
 * arrives after the view has moved on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAdapter } from '../src/web/adapters/browser.js';
import { McpAdapter, type HostApp } from '../src/web/adapters/mcp.js';
import { agentNote } from '../src/web/handoff.js';
import {
  accessErrorText, authProblem, confirmProblem, createSpaceStore, credentialUrl, emailProblem, errorStatus,
  normalizeEmail, parseCredential, passwordProblem, readAccess, SPACE_STORAGE_KEY,
} from '../src/web/adapters/access.js';
import type { MapAccess } from '../src/core/access.js';
import type { AdapterUpdate } from '../src/web/adapters/types.js';
import type { MapSnapshot } from '../src/core/types.js';

test('only an agent version with something to say opens a card over the map', () => {
  // What every freshly created map carries. A card announcing this over the
  // map the user just watched appear tells them nothing.
  assert.equal(agentNote({ version: 1, changes: ['Agent 创建了地图'] }), null);
  assert.equal(agentNote({ version: 2, changes: ['Agent 更新了地图方案'] }), null);
  assert.equal(agentNote({ version: 2, changes: [] }), null);
  assert.equal(agentNote(undefined), null);

  // An authored reason is the agent explaining itself — always worth showing,
  // even alongside the boilerplate the server prepends.
  assert.equal(
    agentNote({ version: 3, changes: ['Agent 更新了地图方案'], reason: '按你的意图避开了山路' }),
    'v3 · 按你的意图避开了山路',
  );
  assert.equal(agentNote({ version: 3, changes: [], reason: '   ' }), null, 'a blank reason is not a reason');

  // Real change lines survive the filter; the boilerplate riding in front of
  // them does not.
  assert.equal(
    agentNote({ version: 4, changes: ['Agent 更新了地图方案', '路线几何超出预算，已抽稀'] }),
    'v4 · 路线几何超出预算，已抽稀',
  );
  const many = Array.from({ length: 10 }, (_, i) => `改动 ${i + 1}`);
  const long = agentNote({ version: 5, changes: ['Agent 创建了地图', ...many] })!;
  assert.match(long, /^v5 · 改动 1；/);
  assert.ok(long.endsWith('…'), 'a long list is cut off rather than covering the map');
  assert.ok(!long.includes('Agent 创建了地图'));
});

test('a fragment names which credential it carries, and legacy keys still parse', () => {
  assert.deepEqual(parseCredential('#space=csk_abc'), { owner: 'csk_abc' });
  assert.deepEqual(parseCredential('#preview=cpt_xyz'), { previewToken: 'cpt_xyz' });
  // Links handed out before spaces existed keep working, unchanged.
  assert.deepEqual(parseCredential('#key=old-edit-key'), { owner: 'old-edit-key' });
  assert.deepEqual(parseCredential('#space=csk_new&key=old'), { owner: 'csk_new' });
  assert.deepEqual(parseCredential(''), {});
  assert.deepEqual(parseCredential('#other=1'), {});
  // Round trip, including a value that would break a bare concatenation.
  const owner = 'csk_a+b/c=';
  assert.deepEqual(parseCredential(new URL(credentialUrl('https://c.test/map/m1', { owner })).hash), { owner });
  // Holding both, the owner credential is the one that reopens the page.
  assert.equal(credentialUrl('https://c.test/map/m1', { owner: 'k', previewToken: 't' }), 'https://c.test/map/m1#space=k');
  assert.equal(credentialUrl('https://c.test/map/m1', { previewToken: 't' }), 'https://c.test/map/m1#preview=t');
  assert.equal(credentialUrl('https://c.test/map/m1', {}), 'https://c.test/map/m1');
});

test('the password rules are the server\'s, stated field by field', () => {
  assert.match(passwordProblem('Short1!')!, /至少 12 位/);
  assert.match(passwordProblem(`${'Aa1!'.repeat(32)}x`)!, /最多 128 位/);
  assert.match(passwordProblem('alllowercase1!')!, /大写字母/);
  assert.match(passwordProblem('ALLUPPERCASE1!')!, /小写字母/);
  assert.match(passwordProblem('NoDigitsHere!!')!, /数字/);
  assert.match(passwordProblem('NoSymbolsHere1')!, /非空白符号/);
  // A space is not the missing symbol: it is whitespace.
  assert.match(passwordProblem('No Symbol Here1')!, /非空白符号/);
  assert.equal(passwordProblem('Sommar-Resa-2026!'), undefined);
  assert.equal(passwordProblem('中文密码Abc1!长一点点'), undefined);
  assert.match(confirmProblem('Sommar-Resa-2026!', 'Sommar-Resa-2026')!, /不一致/);
  assert.equal(confirmProblem('Sommar-Resa-2026!', 'Sommar-Resa-2026!'), undefined);
});

test('an email is normalised the way the server stores it, and checked before it is sent', () => {
  assert.equal(normalizeEmail('  Anna@Example.COM '), 'anna@example.com');
  assert.match(emailProblem('')!, /请填写邮箱/);
  assert.match(emailProblem('anna@example')!, /格式/);
  assert.match(emailProblem(`${'a'.repeat(250)}@example.com`)!, /254/);
  assert.equal(emailProblem(' Anna@Example.com '), undefined);
  // Signing in must not re-run the strength rules: an old password may predate
  // them, and refusing it locally would lock the account out of its own page.
  assert.equal(authProblem({ email: 'anna@example.com', password: 'short' }, 'login'), undefined);
  assert.match(authProblem({ email: 'anna@example.com', password: '' }, 'login')!, /请填写密码/);
  assert.match(authProblem({ email: 'anna@example.com', password: 'short', passwordConfirm: 'short' }, 'register')!, /至少 12 位/);
  assert.equal(authProblem({ email: 'anna@example.com', password: 'Sommar-Resa-2026!', passwordConfirm: 'Sommar-Resa-2026!' }, 'register'), undefined);
});

test('the form never refuses an address the server would have accepted', () => {
  // The client check exists to save a round trip and name what is wrong, not
  // to be the authority — the server's `z.email()` decides (src/server/auth.ts).
  // The one direction that must never happen is the form rejecting an address
  // the server would take: that locks someone out of their own account with a
  // message no one can act on. Being *more* permissive is fine and deliberate,
  // including for Unicode/IDN addresses this version does not support — those
  // reach the server and come back with its wording rather than ours.
  for (const valid of [
    'anna@example.com', ' Anna@Example.COM ', 'a.b+tag@sub.example.co.uk',
    "o'brien@example.com", 'user_name-1@example.io', 'x@y.zz',
  ]) assert.equal(emailProblem(valid), undefined, `${valid} is valid to the server, so the form must send it`);

  // Rejected locally only where the server is certain to refuse too.
  for (const invalid of ['', '   ', 'anna@example', 'anna@@example.com', 'anna example@x.com', 'anna@localhost']) {
    assert.ok(emailProblem(invalid), `${invalid} cannot reach the server as an address`);
  }
  // Over-length is a rule the form can state exactly, so it does.
  assert.match(emailProblem(`${'a'.repeat(250)}@example.com`)!, /254/);
});

test('access is read from either shape, and never invented', () => {
  const access: MapAccess = { kind: 'owner', editable: true, canShare: true, canClaim: true, claimed: false };
  assert.deepEqual(readAccess({ id: 'm1', version: 3, access }), access);
  assert.deepEqual(readAccess({ id: 'm1', version: 3, ...access }), access);
  assert.equal(readAccess({ id: 'm1', version: 3 }), undefined);
  assert.equal(readAccess({ access: { kind: 'something-else' } }), undefined);
  assert.equal(readAccess(null), undefined);
  assert.match(accessErrorText(403, 'FORBIDDEN'), /私有/);
  assert.match(accessErrorText(404, 'NOT_FOUND'), /停用/);
  assert.equal(accessErrorText(500, '服务器错误'), '服务器错误');
  assert.equal(errorStatus(Object.assign(new Error('x'), { status: 403 })), 403);
  assert.equal(errorStatus(new Error('x')), undefined);
});

test('a map key is never evicted to make room, however many maps a browser has', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  } as unknown as Storage;
  const store = createSpaceStore(storage);
  // Well past any round number worth choosing as a cap. Once the fragment that
  // carried a key has been consumed this is the only copy of it, so dropping
  // the oldest to make room does not free a cache — it destroys the only way
  // back into that map. The deployment's own maxMaps is what bounds this.
  const total = 120;
  for (let i = 0; i < total; i += 1) assert.equal(store.remember(`m${i}`, `csk_${i}`), true);
  const later = createSpaceStore(storage);
  for (let i = 0; i < total; i += 1) {
    assert.equal(later.forMap(`m${i}`), `csk_${i}`, `m${i} must still be reachable after ${total} maps`);
  }
  // Re-remembering an unchanged entry is a no-op, not a rewrite that could
  // reorder or drop anything.
  assert.equal(later.remember('m0', 'csk_0'), true);
  assert.equal(later.forMap('m0'), 'csk_0');
  assert.equal(Object.keys(JSON.parse(backing.get('cartula:space-maps')!)).length, total);
});

test('a key forgotten in one tab does not come back from another instance\'s memory', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  } as unknown as Storage;
  // Two tabs on the same origin: separate instances, one shared localStorage.
  const tabA = createSpaceStore(storage);
  const tabB = createSpaceStore(storage);
  tabA.write('csk_shared');
  tabA.remember('m1', 'csk_shared');
  tabA.remember('m2', 'csk_other');
  // Tab B reads them, which is what used to populate a permanent in-memory ring.
  assert.equal(tabB.forMap('m1'), 'csk_shared');
  assert.equal(tabB.forMap('m2'), 'csk_other');

  // The space is claimed in tab A. Storage is the record of that.
  tabA.forget('csk_shared');
  assert.equal(tabA.forMap('m1'), undefined);

  // Tab B must not still be holding it — and, worse, must not write it back.
  assert.equal(tabB.forMap('m1'), undefined, 'a claimed key must not survive in another tab');
  assert.equal(tabB.read(), undefined);
  tabB.remember('m3', 'csk_third');
  const onDisk = JSON.parse(backing.get('cartula:space-maps')!);
  assert.equal(onDisk.m1, undefined, 'writing an unrelated entry must not resurrect the forgotten one');
  assert.equal(onDisk.m2, 'csk_other', 'the space that was not claimed is untouched');
  assert.equal(onDisk.m3, 'csk_third');

  // Same for a whole new instance started after the claim — e.g. a reload.
  assert.equal(createSpaceStore(storage).forMap('m1'), undefined);
});

test('the anonymous space key survives a reload, and is only cleared when it is the one claimed', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  } as unknown as Storage;
  const store = createSpaceStore(storage);
  store.write('csk_one');
  assert.equal(createSpaceStore(storage).read(), 'csk_one', 'a later visit finds the same space');
  store.clear('csk_other');
  assert.equal(store.read(), 'csk_one', 'clearing another space must not sign this browser out of its own');
  store.clear('csk_one');
  assert.equal(store.read(), undefined);

  // A sandboxed frame throws on every access; the session still works, it just
  // does not outlive the page.
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage;
  const fallback = createSpaceStore(hostile);
  fallback.write('csk_memory');
  assert.equal(fallback.read(), 'csk_memory');
  assert.equal(createSpaceStore(hostile).read(), undefined);
});

test('a successful read of nothing is an answer, but an unreadable store is not', () => {
  // The distinction the default key turns on. "Storage says there is no key"
  // means another tab claimed the space and removed it — the key is gone, and
  // an in-memory copy must not bring it back. "Storage cannot be asked" means
  // nothing about the key, and the page falls back so it stays usable.
  const values = new Map<string, string>();
  let readable = true;
  const flaky = {
    getItem: (name: string) => { if (!readable) throw new Error('denied'); return values.get(name) ?? null; },
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as unknown as Storage;
  const store = createSpaceStore(flaky);
  store.write('csk_one');
  assert.equal(store.read(), 'csk_one');

  // Removed out from under this instance, and readable: gone means gone.
  values.delete(SPACE_STORAGE_KEY);
  assert.equal(store.read(), undefined, 'a readable empty store is authoritative');

  // Now the store cannot be asked at all. The last key this page wrote is the
  // best it has, and losing it would break a session that is doing nothing
  // wrong.
  store.write('csk_two');
  readable = false;
  assert.equal(store.read(), 'csk_two', 'an unreadable store falls back rather than forgetting');
  readable = true;
  assert.equal(store.read(), 'csk_two', 'and the same value is really in storage');

  // A store that accepts nothing at all still serves this page's own writes.
  const writeOnlyFail = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    get length() { return 0; },
  } as unknown as Storage;
  const lossy = createSpaceStore(writeOnlyFail);
  lossy.write('csk_three');
  // Storage answered "no key" successfully, so that is the answer — the write
  // never landed, and pretending otherwise is what strands a map later.
  assert.equal(lossy.read(), undefined, 'a write that did not persist must not read back as persisted');
  assert.equal(lossy.remember('m1', 'csk_three'), false, 'and the caller is told, so the URL keeps the key');
});

test('a key is remembered per map, so a second space does not strand the first', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
    removeItem: (key: string) => { backing.delete(key); },
  } as unknown as Storage;
  const store = createSpaceStore(storage);
  store.write('csk_one');
  assert.equal(store.remember('m1', 'csk_one'), true, 'a key kept only in memory would not survive the reload');
  // A second space arrives; "the space this browser creates in" moves on, but
  // the first map's way in must not.
  store.write('csk_two');
  store.remember('m2', 'csk_two');
  const later = createSpaceStore(storage);
  assert.equal(later.forMap('m1'), 'csk_one', 'going back to the first map still has its key');
  assert.equal(later.forMap('m2'), 'csk_two');
  assert.equal(later.read(), 'csk_two');
  assert.equal(later.forMap('m3'), undefined);

  // Claiming one space takes that key out of the browser entirely — including
  // from under every map it opened — while the other space is untouched.
  later.forget('csk_one');
  const after = createSpaceStore(storage);
  assert.equal(after.forMap('m1'), undefined);
  assert.equal(after.forMap('m2'), 'csk_two');
  assert.equal(after.read(), 'csk_two');
  after.forget('csk_two');
  assert.equal(createSpaceStore(storage).read(), undefined);

  // Corrupt storage is ignored rather than thrown from: the page still opens.
  backing.set('cartula:space-maps', 'not json');
  assert.equal(createSpaceStore(storage).forMap('m1'), undefined);
  const sandboxed = createSpaceStore(undefined);
  assert.equal(sandboxed.remember('m1', 'csk_one'), false, 'nothing durable, so the URL must keep the key');
  assert.equal(sandboxed.forMap('m1'), 'csk_one', 'and it is still usable for this page');
});

/* ------------------------------------------------------------------ *
 * A browser, close enough: URL, storage, sockets and fetch.
 * ------------------------------------------------------------------ */

interface Call { path: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }
type Reply = { status?: number; body?: unknown };

class FakeSocket {
  static OPEN = 1;
  static last?: FakeSocket;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: URL | string) { FakeSocket.last = this; FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  } as unknown as Storage;
}

function snapshot(id: string, version = 1, access?: MapAccess): MapSnapshot & { access?: MapAccess } {
  return {
    id, title: '北境路线', version, parent: version - 1, changed: false, changes: [], events: [],
    updatedAt: new Date(2026, 8, 8).toISOString(), url: `https://cartula.test/map/${id}`, layers: [],
    ...(access ? { access } : {}),
  };
}
const owner: MapAccess = { kind: 'owner', editable: true, canShare: true, canClaim: true, claimed: false, spaceId: 'sp_1', spaceMapCount: 3 };
const preview: MapAccess = { kind: 'preview', editable: false, canShare: false, canClaim: false, claimed: true };

/**
 * Install a page. Every request is recorded, and `routes` decides the answer;
 * anything it does not answer is a 404, so a call the test did not expect fails
 * loudly instead of silently succeeding.
 */
function openPage(t: { after: (fn: () => void) => void }, options: {
  url?: string;
  local?: Record<string, string>;
  session?: Record<string, string>;
  routes: (call: Call) => Reply | undefined;
}) {
  const calls: Call[] = [];
  const replaced: string[] = [];
  const url = new URL(options.url ?? 'https://cartula.test/');
  let reloads = 0;
  const location = { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, href: url.href, assign() {}, reload() { reloads += 1; } };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { location: globals.location, history: globals.history, localStorage: globals.localStorage, sessionStorage: globals.sessionStorage, WebSocket: globals.WebSocket, fetch: globals.fetch, window: globals.window };
  globals.location = location;
  // A window that can actually carry a hashchange listener: same-document
  // navigation is how a share link arrives at a page that is already open.
  const hashListeners = new Set<() => void>();
  globals.window = {
    addEventListener: (type: string, fn: () => void) => { if (type === 'hashchange') hashListeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'hashchange') hashListeners.delete(fn); },
  };
  globals.history = { replaceState: (_state: unknown, _title: string, next: string) => {
    replaced.push(next);
    const parsed = new URL(next, url.origin);
    location.pathname = parsed.pathname; location.hash = parsed.hash;
  } };
  globals.localStorage = memoryStorage(options.local);
  globals.sessionStorage = memoryStorage(options.session);
  FakeSocket.last = undefined; FakeSocket.instances = [];
  globals.WebSocket = FakeSocket;
  globals.fetch = async (path: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {}, headers };
    calls.push(call);
    const reply = options.routes(call) ?? { status: 404, body: { error: 'NOT_FOUND' } };
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body ?? {}, text: async () => JSON.stringify(reply.body ?? {}) } as unknown as Response;
  };
  t.after(() => { Object.assign(globals, saved); });
  return {
    calls, replaced,
    /** Navigate within the same document, as `page.goto('…#preview=T')` does. */
    navigateHash(hash: string) {
      location.hash = hash;
      location.href = `${location.origin}${location.pathname}${hash}`;
      for (const listener of [...hashListeners]) listener();
    },
    reloaded: () => reloads,
    local: () => globals.localStorage as Storage,
    session: () => globals.sessionStorage as Storage,
    find: (path: string, method = 'GET') => calls.filter(call => call.path.startsWith(path) && call.method === method),
  };
}

const config = { path: '/api/config', body: { tileUrl: 'https://tiles.test/{z}/{x}/{y}.png' } };

/** Answer a draft's first save, whatever id the page minted for it. */
function savingRoutes(spaceKey: string): (call: Call) => Reply | undefined {
  return call => {
    if (call.path.startsWith('/api/config')) return { body: config.body };
    if (call.path === '/api/session') return { body: { user: null } };
    // A draft's first save settles its destination before writing, so the space
    // exists — and is stored — before the map that would be lost without it.
    if (call.path === '/api/spaces') return { body: { spaceId: 'sp_1', spaceKey, claimed: false } };
    const created = /^\/m\/([\w-]+)$/.exec(call.path);
    if (created && call.method === 'PUT') return { body: { ...snapshot(created[1], 1, owner), spaceId: 'sp_1', spaceKey, claimed: false, editKey: spaceKey } };
    const written = /^\/api\/maps\/([\w-]+)\/replace$/.exec(call.path);
    if (written) return { body: snapshot(written[1], 2, owner) };
    return undefined;
  };
}

test('an anonymous space key is remembered, reused for the next map and sent as a bearer', async t => {
  const page = openPage(t, { routes: savingRoutes('csk_first') });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const draft = await adapter.initialize(() => {});
  assert.equal(draft.version, 0, 'the home page opens on a draft');
  await adapter.replace({ title: '北境路线', layers: [] }, draft);
  assert.equal(page.local().getItem('cartula:space'), 'csk_first', 'the key has to outlive the tab or the map is lost');
  const mapId = new URL(page.replaced.at(-1)!, 'https://cartula.test').pathname.split('/').at(-1)!;
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!)[mapId], 'csk_first', 'and reopening this map has to find it');
  // Stored, so the address bar does not have to carry a bearer credential
  // around — but only in that order.
  assert.equal(page.replaced.at(-1), `/map/${mapId}`);

  // A second visit — a fresh page, same browser — creates its next map inside
  // the same space instead of stranding it in one of its own.
  const second = openPage(t, { local: { 'cartula:space': 'csk_first' }, routes: savingRoutes('csk_first') });
  const next = new BrowserAdapter();
  t.after(() => next.dispose());
  const secondDraft = await next.initialize(() => {});
  await next.replace({ title: '第二张', layers: [] }, secondDraft);
  const write = second.calls.find(call => call.method === 'PUT')!;
  assert.equal(write.headers.Authorization, 'Bearer csk_first', 'the same space, so the same key');
  assert.equal(write.headers['X-Cartula-Request'], '1');
});

test('a browser that cannot store anything keeps the key in the address bar', async t => {
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { return null; }, get length() { return 0; } } as unknown as Storage;
  const globals = globalThis as unknown as Record<string, unknown>;
  const page = openPage(t, { routes: savingRoutes('csk_first') });
  globals.localStorage = hostile;
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const draft = await adapter.initialize(() => {});
  await adapter.replace({ title: '北境路线', layers: [] }, draft);
  // Nothing durable is holding it, so taking it out of the URL would be
  // throwing the only copy away.
  assert.match(page.replaced.at(-1)!, /^\/map\/[\w-]+#space=csk_first$/);
});

test('an owner link opens the map, authorises the socket and never puts the key in the path', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  assert.equal(map.version, 4);
  assert.equal(adapter.editable, true);
  assert.equal(adapter.access.state().access?.kind, 'owner');
  assert.equal(page.local().getItem('cartula:space'), 'csk_first', 'an owner link is also how a space arrives');
  for (const call of page.calls.filter(item => item.path.startsWith('/api/maps') || item.path.startsWith('/m/'))) {
    assert.equal(call.headers.Authorization, 'Bearer csk_first');
    assert.ok(!call.path.includes('csk_first'), 'a bearer belongs in a header, never in a URL');
  }
  // The socket carries no header, so the credential is named in the first frame.
  FakeSocket.last!.onopen!();
  assert.deepEqual(JSON.parse(FakeSocket.last!.sent[0]), { type: 'auth', key: 'csk_first' });
});

const annotate = [{ op: 'annotate' as const, layerId: 'route', pointId: 'p', text: '备注' }];

test('a conflicting edit is replayed once against the refreshed version, with a new request id', async t => {
  const editRequests: Record<string, unknown>[] = [];
  let liveVersion = 4;
  openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/edit' && call.method === 'POST') {
        editRequests.push(call.body);
        // The first attempt loses the race: something else reached v9 first.
        if (editRequests.length === 1) { liveVersion = 9; return { status: 409, body: { error: 'VERSION_CONFLICT', hint: '请先读取 since=4 的摘要，再只提交受影响操作' } }; }
        return { body: snapshot('m1', (call.body.baseVersion as number) + 1, owner) };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', liveVersion, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  assert.equal(map.version, 4);
  const result = await adapter.edit(map, annotate);
  assert.equal(result.version, 10, "the retry's own result is returned, as if the first attempt had produced it");
  assert.equal(editRequests.length, 2, 'exactly two edit requests were sent');
  assert.equal(editRequests[0].baseVersion, 4);
  assert.equal(editRequests[1].baseVersion, 9, 'the retry uses the version the refresh reported');
  assert.notEqual(editRequests[1].requestId, editRequests[0].requestId, '409 means nothing was written; the retry must not reuse the id');
});

test('two edit conflicts in a row surface a plain-language error, never the raw VERSION_CONFLICT text', async t => {
  const editRequests: Record<string, unknown>[] = [];
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/edit' && call.method === 'POST') {
        editRequests.push(call.body);
        return { status: 409, body: { error: 'VERSION_CONFLICT', hint: '请先读取 since=4 的摘要，再只提交受影响操作' } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 9, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  await assert.rejects(adapter.edit(map, annotate), (error: unknown) => {
    if (!(error instanceof Error)) throw new Error(`expected an Error, got ${error}`);
    assert.ok(!error.message.includes('VERSION_CONFLICT'), error.message);
    assert.equal((error as { code?: string }).code, 'conflict');
    return true;
  });
  assert.equal(editRequests.length, 2, 'one retry, not a loop');
  assert.equal(editRequests[1].baseVersion, 9, 'the retry still uses the refreshed version, even though it fails too');
  assert.notEqual(editRequests[1].requestId, editRequests[0].requestId);
});

test('a stated rejection other than a conflict is never retried', async t => {
  let editCalls = 0;
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/edit' && call.method === 'POST') { editCalls += 1; return { status: 400, body: { error: '请求格式不正确' } }; }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  const before = page.find('/m/m1').length;
  await assert.rejects(adapter.edit(map, annotate), /请求格式不正确/);
  assert.equal(editCalls, 1, 'a non-409 rejection gets no retry');
  assert.equal(page.find('/m/m1').length, before, 'and no refresh either');
});

test('a replace conflict refreshes the map but is never replayed, unlike an edit', async t => {
  let replaceAttempts = 0;
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/replace' && call.method === 'POST') {
        replaceAttempts += 1;
        return { status: 409, body: { error: 'VERSION_CONFLICT', hint: '请先读取 since=4 的摘要，再只提交受影响操作' } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 9, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  await assert.rejects(adapter.replace({ title: '重写', layers: [] }, map), (error: unknown) => {
    if (!(error instanceof Error)) throw new Error(`expected an Error, got ${error}`);
    assert.ok(!error.message.includes('VERSION_CONFLICT'), error.message);
    assert.equal((error as { code?: string }).code, 'conflict');
    return true;
  });
  assert.equal(replaceAttempts, 1, 'a whole-map replace is never replayed after a conflict');
});

test('a remembered key that does not open this map is dropped for it, not complained about', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m9',
    local: { 'cartula:space': 'csk_other' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      // The stored key belongs to another space entirely.
      if (call.path === '/api/maps/m9/access') return call.headers.Authorization ? { status: 403, body: { error: 'FORBIDDEN' } } : { body: { id: 'm9', version: 2, ...preview } };
      if (call.path.startsWith('/m/m9')) return { body: snapshot('m9', 2, preview) };
      return undefined;
    },
  });
  const updates: string[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(update => { if (update.error) updates.push(update.error); });
  assert.equal(map.version, 2);
  assert.equal(adapter.editable, false);
  assert.deepEqual(updates, [], 'a guess that did not fit is not an error the user has to read');
  assert.equal(page.local().getItem('cartula:space'), 'csk_other', 'the other space is still this browser\'s');
  assert.equal(page.find('/m/m9')[0].headers.Authorization, undefined, 'the read went out without the key that was refused');
});

test('opening a second space leaves the first map reachable, and consumes the fragment only once it is', async t => {
  const first = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_one',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return call.headers.Authorization === 'Bearer csk_one' ? { body: { id: 'm1', version: 1, ...owner, spaceId: 'sp_one' } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 1, owner) };
      return undefined;
    },
  });
  const one = new BrowserAdapter();
  t.after(() => one.dispose());
  await one.initialize(() => {});
  // The credential is out of the address bar, but only because it is stored.
  assert.equal(first.replaced.at(-1), '/map/m1');
  const stored = { ...Object.fromEntries(['cartula:space', 'cartula:space-maps'].map(key => [key, first.local().getItem(key)!])) };
  assert.equal(stored['cartula:space'], 'csk_one');

  // A second space, same browser: it becomes the one new maps are made in.
  const second = openPage(t, {
    url: 'https://cartula.test/map/m2#space=csk_two',
    local: stored,
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m2/access') return call.headers.Authorization === 'Bearer csk_two' ? { body: { id: 'm2', version: 1, ...owner, spaceId: 'sp_two' } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m2')) return { body: snapshot('m2', 1, owner) };
      return undefined;
    },
  });
  const two = new BrowserAdapter();
  t.after(() => two.dispose());
  await two.initialize(() => {});
  assert.equal(second.local().getItem('cartula:space'), 'csk_two');

  // Back button to the first map, now with a bare URL: the browser has to
  // remember which of the two spaces opened it.
  const back = openPage(t, {
    url: 'https://cartula.test/map/m1',
    local: Object.fromEntries(['cartula:space', 'cartula:space-maps'].map(key => [key, second.local().getItem(key)!])),
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return call.headers.Authorization === 'Bearer csk_one' ? { body: { id: 'm1', version: 1, ...owner, spaceId: 'sp_one' } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 1, owner) };
      return undefined;
    },
  });
  const again = new BrowserAdapter();
  t.after(() => again.dispose());
  const map = await again.initialize(() => {});
  assert.equal(map.id, 'm1');
  assert.equal(again.editable, true, 'the first space still opens its own map');
  assert.equal(back.find('/api/maps/m1/access', 'POST')[0].headers.Authorization, 'Bearer csk_one', 'and with its key, not the newer space\'s');
});

test('a socket is live only once the server has accepted it', async t => {
  openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const states: string[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => { if (update.connection) states.push(update.connection); });
  const socket = FakeSocket.last!;
  socket.onopen!();
  // Open is not accepted: until the server says so, nothing guarantees this
  // connection will ever be told about somebody else's edit.
  assert.ok(!states.includes('live'), 'an unacknowledged socket must not be announced as live');
  socket.onmessage!({ data: JSON.stringify({ type: 'auth', ok: true }) });
  assert.equal(states.at(-1), 'live');
  socket.onmessage!({ data: JSON.stringify({ type: 'auth', ok: false }) });
  assert.equal(states.at(-1), 'polling');
});

test('an unacknowledged socket stays polling even while reads keep succeeding', async t => {
  openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const states: string[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => { if (update.connection) states.push(update.connection); });
  const socket = FakeSocket.last!;
  socket.onopen!();
  // A poll succeeding says the map is readable over HTTP; it says nothing
  // about whether this socket will ever deliver anyone else's edit. The old
  // implementation read `readyState === OPEN` here and called it live.
  await (adapter as unknown as { refresh(): Promise<void> }).refresh();
  assert.equal(socket.readyState, FakeSocket.OPEN);
  assert.equal(states.at(-1), 'polling', 'an open-but-unaccepted socket is exactly what polling is for');

  // A cookie-authorised socket is announced to without ever being asked: the
  // server's first notification is itself the acceptance.
  socket.onmessage!({ data: JSON.stringify({ type: 'edit', version: 4, changes: [], actor: 'agent' }) });
  assert.equal(states.at(-1), 'live');

  // A reconnect starts over: the new socket has proved nothing yet.
  socket.onclose!();
  assert.equal(states.at(-1), 'polling');
});

test('a socket that opens after the view moved on cannot mark the new map live', async t => {
  openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/copy') return { body: { ...snapshot('m2', 1, owner), spaceId: 'sp_1', spaceKey: 'csk_first', claimed: false } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      if (call.path.startsWith('/m/m2')) return { body: snapshot('m2', 1, owner) };
      return undefined;
    },
  });
  const states: string[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(update => { if (update.connection) states.push(update.connection); });
  const first = FakeSocket.last!;
  await adapter.fork!(map);
  const second = FakeSocket.last!;
  assert.notEqual(first, second, 'the copy is followed by a socket of its own');

  // The old map's socket is finally accepted — after the view has left it.
  first.onmessage!({ data: JSON.stringify({ type: 'auth', ok: true }) });
  assert.notEqual(states.at(-1), 'live', 'an answer about the map we left says nothing about this one');
  second.onmessage!({ data: JSON.stringify({ type: 'auth', ok: true }) });
  assert.equal(states.at(-1), 'live');
});

test('a signed-in browser still reaches its own library when a leftover key is refused', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1',
    local: { 'cartula:space': 'csk_stale' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      // The server is fail-closed about a credential it does not recognise:
      // it refuses rather than falling back to the session behind it.
      if (call.path === '/api/maps' && call.headers.Authorization) return { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path === '/api/maps') return { body: { maps: [{ id: 'm1', title: '账号里的地图', version: 1, updatedAt: '2026-09-08', url: '/map/m1' }], favorites: [] } };
      if (call.path === '/api/maps/m1/access') return call.headers.Authorization ? { status: 403, body: { error: 'FORBIDDEN' } } : { body: { id: 'm1', version: 4, ...owner, claimed: true, canClaim: false } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  // The stale key was a guess about this map; being refused here dropped it
  // rather than blocking the account that does own the map.
  assert.equal(adapter.editable, true);
  assert.equal(page.find('/m/m1')[0].headers.Authorization, undefined);
  const library = await adapter.access.library!();
  assert.deepEqual(library.maps.map(item => item.id), ['m1']);
});

test('signing out of a claimed space takes its key out of this browser too', async t => {
  const claimed: MapAccess = { ...owner, claimed: true, canClaim: false };
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_claimed',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/auth/logout') return { body: { ok: true } };
      if (call.path === '/api/maps/m1/access') {
        // Once the session is gone the key alone no longer opens it either:
        // the space belongs to the account now.
        return page.find('/api/auth/logout', 'POST').length ? { status: 401, body: { error: 'UNAUTHORIZED' } } : { body: { id: 'm1', version: 4, ...claimed } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, claimed) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  assert.equal(page.local().getItem('cartula:space'), null, 'a claimed space is not this browser\'s to remember');
  await adapter.access.logout!();
  assert.equal(adapter.editable, false);
  assert.equal(adapter.editUrl, undefined, 'nothing left in this browser to reopen the space with');
  assert.equal(page.local().getItem('cartula:space'), null);
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps') ?? '{}').m1, undefined);
});

test('a link that names a wrong key is refused outright, not quietly downgraded', async t => {
  openPage(t, {
    url: 'https://cartula.test/map/m9#space=csk_wrong',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m9/access') return call.headers.Authorization ? { status: 403, body: { error: 'FORBIDDEN' } } : { body: { id: 'm9', version: 2, ...preview } };
      if (call.path.startsWith('/m/m9')) return { body: snapshot('m9', 2, preview) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  // The URL made a statement about this map and the server rejected it. Falling
  // back to what anonymous access happens to allow would answer a question
  // nobody asked, and would show the page as though the link had worked.
  const failure = await adapter.initialize(() => {}).then(() => undefined, error => error as Error & { status?: number });
  assert.ok(failure, 'a refused link must not resolve as a successful load');
  assert.match(failure.message, /链接/);
  assert.equal(failure.status, 403);
  assert.equal(adapter.editable, false);
});

test('a revoked share link says so rather than reopening on the account behind it', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#preview=cpt_revoked',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      // Signed in as somebody who can still read this map another way — the
      // owner, or an account whose favorite still grants it.
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') {
        return call.headers.Authorization
          ? { status: 403, body: { error: '分享链接已失效' } }
          : { body: { id: 'm1', version: 4, ...owner } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const failure = await adapter.initialize(() => {}).then(() => undefined, error => error as Error & { status?: number });
  // The share was revoked. Silently reopening with the cookie's own access
  // would hide that from the person holding the dead link — and would show
  // them an editable map they arrived at through a read-only address.
  assert.ok(failure, 'a revoked share must not silently become owner access');
  assert.match(failure.message, /停用|失效/);
  assert.equal(adapter.editable, false);
  assert.equal(adapter.access.state().access, undefined);
  // Never retried without the token: that retry is what would have upgraded it.
  for (const call of page.find('/api/maps/m1/access', 'POST')) {
    assert.equal(call.headers.Authorization, 'Bearer cpt_revoked');
  }
});

test('a map nobody may read fails with a way back, not a blank page', async t => {
  openPage(t, {
    url: 'https://cartula.test/map/m5',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m5/access') return { status: 403, body: { error: 'FORBIDDEN', hint: '需要凭证' } };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const failure = await adapter.initialize(() => {}).then(() => undefined, error => error as Error & { status?: number });
  assert.ok(failure, 'the page must not pretend it loaded');
  assert.equal(failure.status, 403);
  assert.match(failure.message, /私有|登录/);
});

test('claiming a space hands it to the account and takes the key out of this browser', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    // An earlier visit to another map of the same space left a copy behind.
    session: { 'cartula:edit:m4': 'csk_first' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/auth/register') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/claim') return { body: { access: { ...owner, claimed: true, canClaim: false }, claimedMapCount: 3 } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  await adapter.access.register!({ email: ' Anna@Example.com ', password: 'Sommar-Resa-2026!', passwordConfirm: 'Sommar-Resa-2026!' });
  const registration = page.find('/api/auth/register', 'POST')[0];
  assert.equal(registration.body.email, 'anna@example.com', 'the address is normalised the way it is stored');
  assert.equal(registration.headers.Authorization, undefined, 'a sign-in is not authorised by a space key');
  assert.equal(registration.headers['X-Cartula-Request'], '1');

  const result = await adapter.access.claim!();
  assert.equal(result.claimedMapCount, 3);
  const claim = page.find('/api/maps/m1/claim', 'POST')[0];
  assert.equal(claim.headers.Authorization, 'Bearer csk_first', 'the claim proves the key as well as the session');
  // From here the cookie is the authority. The key still works for the agent
  // that has it — it is only gone from this browser.
  assert.equal(page.local().getItem('cartula:space'), null);
  assert.equal(page.session().getItem('cartula:edit:m4'), null, 'a copy under another map would survive the sign-out too');
  assert.equal(page.replaced.at(-1), '/map/m1');
  assert.equal(adapter.editUrl, undefined);
  assert.equal(adapter.access.state().access?.claimed, true);
});

test('signing out gives the maps up, even though the page still remembers what it read', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/auth/logout') return { body: { ok: true } };
      if (call.path === '/api/maps/m1/access') {
        // After the sign-out there is no session and no key left to fall back on.
        return page.find('/api/auth/logout', 'POST').length ? { status: 401, body: { error: 'UNAUTHORIZED' } } : { body: { id: 'm1', version: 4, ...owner, claimed: true, canClaim: false } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const errors: string[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => { if (update.error) errors.push(update.error); });
  assert.equal(adapter.editable, true);
  await adapter.access.logout!();
  assert.equal(adapter.access.state().user, null);
  assert.equal(adapter.editable, false, 'editing is over the moment the session is');
  assert.equal(adapter.access.state().access, undefined);
  assert.match(errors.at(-1)!, /退出登录/);
});

test('a favorite is authorised by the share it records, never by an owner key', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      if (call.path === '/api/me/favorites/m3') return { body: { ok: true } };
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  assert.equal(adapter.editable, false);
  assert.deepEqual(adapter.access.capabilities(), { account: true, library: true, copy: true, openExternal: true, share: false, favorite: true });
  await adapter.access.favorite!();
  const favorite = page.find('/api/me/favorites/m3', 'PUT')[0];
  assert.equal(favorite.headers.Authorization, 'Bearer cpt_token');
  assert.equal(adapter.access.state().favorited, true);
  // Removing one is the account's own doing and needs no share at all.
  await adapter.access.unfavorite!('m3');
  assert.equal(page.find('/api/me/favorites/m3', 'DELETE')[0].headers.Authorization, undefined);
  assert.equal(adapter.access.state().favorited, false);
  // The socket authenticates as a preview, never as an owner.
  FakeSocket.last!.onopen!();
  assert.deepEqual(JSON.parse(FakeSocket.last!.sent[0]), { type: 'auth', previewToken: 'cpt_token' });
});

test('an owner key is never offered as a share, and a preview cannot mint one', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/preview' && call.method === 'POST') return { body: { id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false, previewToken: 'cpt_new', previewUrl: 'https://cartula.test/map/m1#preview=cpt_new' } };
      if (call.path === '/api/maps/m1/preview' && call.method === 'GET') return { body: { links: [{ id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false }] } };
      if (call.path === '/api/maps/m1/preview/sh_old' && call.method === 'DELETE') return { body: { ok: true } };
      if (call.path === '/api/maps/m1/preview' && call.method === 'DELETE') return { body: { ok: true } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  const link = await adapter.access.share!();
  assert.equal(link.previewUrl, 'https://cartula.test/map/m1#preview=cpt_new');
  assert.notEqual(link.previewToken, 'csk_first', 'a share link is a token of its own, not the space key');
  assert.equal(page.find('/api/maps/m1/preview', 'POST')[0].headers.Authorization, 'Bearer csk_first');

  // What the dialog's 停用全部分享 button is about: the links this map is
  // already open through. Metadata only — the token exists once, in the mint.
  const links = await adapter.access.listShares!();
  assert.deepEqual(links, [{ id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false }]);
  assert.equal(page.find('/api/maps/m1/preview', 'GET')[0].headers.Authorization, 'Bearer csk_first');

  // One share, or all of them: two different addresses, never one standing in
  // for the other.
  await adapter.access.revokeShare!('sh_old');
  assert.equal(page.find('/api/maps/m1/preview/sh_old', 'DELETE').length, 1);
  assert.equal(page.find('/api/maps/m1/preview', 'DELETE').filter(call => call.path === '/api/maps/m1/preview').length, 0);
  await adapter.access.revokeShare!();
  assert.equal(page.find('/api/maps/m1/preview', 'DELETE').filter(call => call.path === '/api/maps/m1/preview').length, 1);
});

test('copying a preview asks the server for a new map and moves the view onto it', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    local: { 'cartula:space': 'csk_mine' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      if (call.path === '/api/maps/m3/copy') return { body: { ...snapshot('m7', 1, owner), spaceId: 'sp_mine', spaceKey: 'csk_mine', claimed: false } };
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      if (call.path.startsWith('/m/m7')) return { body: snapshot('m7', 1, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const source = await adapter.initialize(() => {});
  const copy = await adapter.fork!(source);
  assert.equal(copy.id, 'm7');
  const request = page.find('/api/maps/m3/copy', 'POST')[0];
  assert.equal(request.headers.Authorization, 'Bearer cpt_token', 'the source is authorised by the share it was read with');
  assert.equal(request.body.targetSpaceKey, 'csk_mine', 'and the destination by a key of one\'s own');
  assert.ok(request.body.requestId, 'a retry must not leave two copies behind');
  assert.equal(page.find('/api/spaces', 'POST').length, 0, 'a space already in hand is reused rather than piling up new ones');
  assert.equal(adapter.editable, true);
  assert.equal(page.replaced.at(-1), '/map/m7', 'the key is stored against the copy, so the URL need not carry it');
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m7, 'csk_mine');
  assert.equal(adapter.access.capabilities().favorite, false, 'the copy is not a share any more');
});

test('an anonymous copy takes a space first, so a lost answer can be retried into the same one', async t => {
  let attempt = 0;
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      if (call.path === '/api/spaces') return { body: { spaceId: 'sp_new', spaceKey: 'csk_new', claimed: false } };
      // The first attempt is answered by a server error: the copy may or may
      // not exist, which is exactly the case the request id is for.
      if (call.path === '/api/maps/m3/copy') {
        attempt += 1;
        return attempt === 1 ? { status: 502, body: { error: 'BAD_GATEWAY' } } : { body: { ...snapshot('m7', 1, owner), spaceId: 'sp_new' } };
      }
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      if (call.path.startsWith('/m/m7')) return { body: snapshot('m7', 1, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const source = await adapter.initialize(() => {});
  await assert.rejects(adapter.fork!(source));
  const copy = await adapter.fork!(source);
  assert.equal(copy.id, 'm7');
  const copies = page.find('/api/maps/m3/copy', 'POST');
  assert.equal(copies.length, 2);
  assert.equal(copies[0].body.requestId, copies[1].body.requestId, 'the same intent, so the same request id');
  assert.equal(copies[0].body.targetSpaceKey, 'csk_new');
  assert.equal(copies[1].body.targetSpaceKey, 'csk_new', 'and the same destination, or the id would mean nothing');
  assert.equal(page.find('/api/spaces', 'POST').length, 1, 'one space, minted before the first attempt');
  assert.equal(page.local().getItem('cartula:space'), 'csk_new', 'saved before it was used, so a reload finds it too');
  assert.equal(adapter.editable, true);
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m7, 'csk_new');
});

test('signing in on a page that was refused loads the map it may now read', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/auth/login') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      const signedIn = page.find('/api/auth/login', 'POST').length > 0;
      if (call.path === '/api/maps/m1/access') return signedIn ? { body: { id: 'm1', version: 4, ...owner, claimed: true, canClaim: false } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m1')) return signedIn ? { body: snapshot('m1', 4, owner) } : { status: 403, body: { error: 'FORBIDDEN' } };
      return undefined;
    },
  });
  const seen: MapSnapshot[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.initialize(update => { if (update.snapshot) seen.push(update.snapshot); }));
  assert.equal(seen.length, 0, 'nothing was readable before the sign-in');
  await adapter.access.login!({ email: 'anna@example.com', password: 'Sommar-Resa-2026!' });
  // The recovered map is delivered *before* login resolves, not after. The
  // shell closes the account panel in the sign-in's own continuation and
  // decides from whether a map arrived, so a map handed over one tick later
  // would leave the panel sitting over the map the user came for.
  assert.equal(seen.at(-1)?.id, 'm1', 'the map that was refused arrives without a reload, and before login resolves');
  assert.equal(adapter.editable, true);
  assert.ok(FakeSocket.last, 'and it starts following the map it just got');
});

test('a sign-in that still cannot read the map reports no map, so the page keeps its way back', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      // Signing in works — but as somebody who was never given this map.
      if (call.path === '/api/auth/login') return { body: { user: { id: 'u2', email: 'bob@example.com' } } };
      if (call.path === '/api/maps/m1/access') return { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m1')) return { status: 403, body: { error: 'FORBIDDEN' } };
      return undefined;
    },
  });
  const seen: MapSnapshot[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await assert.rejects(adapter.initialize(update => { if (update.snapshot) seen.push(update.snapshot); }));
  await adapter.access.login!({ email: 'bob@example.com', password: 'Sommar-Resa-2026!' });
  assert.equal(adapter.access.state().user?.email, 'bob@example.com', 'the sign-in itself succeeded');
  assert.equal(seen.length, 0, 'but no map was recovered, and none may be claimed to have been');
  assert.equal(adapter.editable, false);
  assert.ok(page.find('/api/auth/login', 'POST').length === 1);
});

/* ------------------------------------------------------------------ *
 * Inside a host: no passwords, no cookies, only tools and openLink.
 * ------------------------------------------------------------------ */

function hostSnapshot(id: string, version = 1): MapSnapshot {
  return { id, title: '北境路线', version, parent: version - 1, changed: false, changes: [], events: [], updatedAt: new Date(2026, 8, 8).toISOString(), url: `https://cartula.test/map/${id}`, layers: [] };
}

function fakeHost(options: { openLinks?: boolean; answer?: (call: { name: string; arguments: Record<string, unknown> }) => unknown } = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const links: string[] = [];
  const app = {
    getHostContext: () => ({ displayMode: 'inline', containerDimensions: { height: 500, width: 900 } }),
    getHostCapabilities: () => ({ message: { text: {} }, ...(options.openLinks === false ? {} : { openLinks: {} }) }),
    connect: async () => {},
    close: async () => {},
    callServerTool: async (params: unknown) => {
      const call = params as { name: string; arguments: Record<string, unknown> };
      calls.push(call);
      return options.answer?.(call) ?? {};
    },
    sendMessage: async () => ({}),
    sendSizeChanged: async () => {},
    updateModelContext: async () => ({}),
    requestDisplayMode: async () => ({ mode: 'inline' as const }),
    downloadFile: async () => ({}),
    openLink: async ({ url }: { url: string }) => { links.push(url); return {}; },
    ontoolresult: undefined,
    ontoolcancelled: undefined,
    onhostcontextchanged: undefined,
  } as unknown as HostApp;
  return { app, calls, links, named: (name: string) => calls.filter(call => call.name === name) };
}

async function openHost(t: { after: (fn: () => void) => void }, host: ReturnType<typeof fakeHost>, meta: Record<string, unknown>) {
  const adapter = new McpAdapter(host.app);
  const ready = adapter.initialize(() => {});
  host.app.ontoolresult?.({ _meta: { cartula: meta } } as never);
  await ready;
  t.after(() => adapter.dispose());
  return adapter;
}

test('a space key travels under its own name; a legacy key keeps the old one', async t => {
  const spaceHost = fakeHost({ answer: () => ({ _meta: { cartula: { map: hostSnapshot('m1', 2), spaceKey: 'csk_first', access: owner } } }) });
  const spaceAdapter = await openHost(t, spaceHost, { map: hostSnapshot('m1'), spaceId: 'sp_1', spaceKey: 'csk_first', access: owner });
  await spaceAdapter.edit(hostSnapshot('m1'), [{ op: 'annotate', layerId: 'l', pointId: 'p', text: '备注' }]);
  const write = spaceHost.named('edit_map')[0].arguments;
  assert.equal(write.spaceKey, 'csk_first');
  assert.ok(!('editKey' in write), 'a space key must not be passed off as a per-map key');
  assert.equal(spaceAdapter.editUrl, 'https://cartula.test/map/m1#space=csk_first');

  const legacyHost = fakeHost({ answer: () => ({ _meta: { cartula: { map: hostSnapshot('m2', 2), editKey: 'old-key' } } }) });
  const legacyAdapter = await openHost(t, legacyHost, { map: hostSnapshot('m2'), editKey: 'old-key' });
  await legacyAdapter.edit(hostSnapshot('m2'), [{ op: 'annotate', layerId: 'l', pointId: 'p', text: '备注' }]);
  assert.equal(legacyHost.named('edit_map')[0].arguments.editKey, 'old-key');
});

test('a host view shares and copies through tools, and sends the account elsewhere', async t => {
  const host = fakeHost({
    answer: call => {
      if (call.name === 'share_map') {
        if (call.arguments.list) return { structuredContent: { links: [{ id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false }] } };
        if (call.arguments.revoke || call.arguments.revokeId) return { structuredContent: { ok: true } };
        return { structuredContent: { id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false, previewToken: 'cpt_new', previewUrl: 'https://cartula.test/map/m1#preview=cpt_new' } };
      }
      if (call.name === 'copy_map') return { structuredContent: { id: 'm8', title: '北境路线 · 副本', url: 'https://cartula.test/map/m8' }, _meta: { cartula: { spaceKey: 'csk_first' } } };
      return { _meta: { cartula: { map: hostSnapshot('m1', 2), spaceKey: 'csk_first', access: owner } } };
    },
  });
  const adapter = await openHost(t, host, { map: hostSnapshot('m1'), spaceId: 'sp_1', spaceKey: 'csk_first', access: owner });
  const port = adapter.access;
  assert.deepEqual(port.capabilities(), { account: false, library: false, favorite: false, copy: true, share: true, openExternal: true });

  const link = await port.share!();
  assert.equal(link.previewUrl, 'https://cartula.test/map/m1#preview=cpt_new');
  assert.equal(host.named('share_map')[0].arguments.spaceKey, 'csk_first');
  // The embedded dialog lists and revokes through the same tool, so a card can
  // show what this map is open through instead of only a 停用全部 button.
  assert.deepEqual(await port.listShares!(), [{ id: 'sh_new', createdAt: '2026-09-14T00:00:00.000Z', canWrite: false }]);
  assert.equal(host.named('share_map')[1].arguments.list, true);
  await port.revokeShare!('sh_new');
  assert.deepEqual(
    { revokeId: host.named('share_map')[2].arguments.revokeId, revoke: host.named('share_map')[2].arguments.revoke },
    { revokeId: 'sh_new', revoke: undefined },
    'revoking one share must not ask for all of them',
  );
  await port.revokeShare!();
  assert.equal(host.named('share_map')[3].arguments.revoke, true);

  const copy = await port.copy!();
  assert.equal(copy.editUrl, 'https://cartula.test/map/m8#space=csk_first');
  assert.ok(host.named('copy_map')[0].arguments.requestId);

  // No password is typed in a frame: the account entry is a link out, opened
  // with the credential this view already holds.
  await port.openExternal!(port.externalUrl!()!);
  assert.deepEqual(host.links, ['https://cartula.test/map/m1#space=csk_first']);
});

test('a host copy names its destination, and replays the same request when the answer is lost', async t => {
  let attempt = 0;
  const host = fakeHost({
    answer: call => {
      if (call.name === 'copy_map') {
        attempt += 1;
        return attempt === 1
          ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 503, error: '暂时不可用' }) }] }
          : { structuredContent: { id: 'm8', title: '北境路线 · 副本', url: 'https://cartula.test/map/m8' } };
      }
      return { _meta: { cartula: { map: hostSnapshot('m1', 2), spaceKey: 'csk_first', access: owner } } };
    },
  });
  const adapter = await openHost(t, host, { map: hostSnapshot('m1'), spaceId: 'sp_1', spaceKey: 'csk_first', access: owner });
  await assert.rejects(adapter.access.copy!());
  const copy = await adapter.access.copy!();
  const calls = host.named('copy_map');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].arguments.targetSpaceKey, 'csk_first', 'the space this view already holds is the destination');
  assert.equal(calls[0].arguments.requestId, calls[1].arguments.requestId, 'the same intent, so the same request id');
  assert.equal(calls[0].arguments.title, calls[1].arguments.title);
  // Without a destination the server would mint a space, and an id could not
  // recognise the retry — so it is never sent on its own.
  assert.equal(copy.editUrl, 'https://cartula.test/map/m8#space=csk_first', 'the copy is in that space, so that key opens it');
});

test('a host copy the server refuses outright is a new attempt next time, not a replay', async t => {
  let attempt = 0;
  const host = fakeHost({
    answer: call => {
      if (call.name === 'copy_map') {
        attempt += 1;
        // The destination was refused: nothing was written, so replaying the
        // same request id would only be refused again.
        return attempt === 1
          ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 403, error: '目标空间密钥无效' }) }] }
          : { structuredContent: { id: 'm8', title: '北境路线 · 副本', url: 'https://cartula.test/map/m8' } };
      }
      return { _meta: { cartula: { map: hostSnapshot('m1', 2), spaceKey: 'csk_first', access: owner } } };
    },
  });
  const adapter = await openHost(t, host, { map: hostSnapshot('m1'), spaceId: 'sp_1', spaceKey: 'csk_first', access: owner });
  await assert.rejects(adapter.access.copy!(), /目标空间密钥无效/);
  await adapter.access.copy!();
  const calls = host.named('copy_map');
  assert.notEqual(calls[0].arguments.requestId, calls[1].arguments.requestId);
});

test('a claimed space is not offered as a copy destination from inside a host', async t => {
  const claimed: MapAccess = { ...owner, claimed: true, canClaim: false };
  const host = fakeHost({
    answer: call => call.name === 'copy_map'
      ? { structuredContent: { id: 'm8', title: '北境路线 · 副本', url: 'https://cartula.test/map/m8' }, _meta: { cartula: { spaceKey: 'csk_new' } } }
      : { _meta: { cartula: { map: hostSnapshot('m1', 2), spaceKey: 'csk_first', access: claimed } } },
  });
  const adapter = await openHost(t, host, { map: hostSnapshot('m1'), spaceId: 'sp_1', spaceKey: 'csk_first', access: claimed });
  const copy = await adapter.access.copy!();
  const call = host.named('copy_map')[0].arguments;
  // The space belongs to an account now; the server refuses it as a target
  // from a tool, so naming it would only turn a copy into an error.
  assert.equal(call.targetSpaceKey, undefined);
  assert.ok(call.requestId, 'the host account may provide the destination; every copy still needs a retry key');
  assert.equal(copy.editUrl, 'https://cartula.test/map/m8#space=csk_new');
});

test('an anonymous host copy obtains one destination and reuses it after a lost response', async t => {
  let copies = 0;
  const host = fakeHost({ answer: call => {
    if (call.name === 'create_space') return { structuredContent: { spaceKey: 'csk_destination' } };
    if (call.name === 'copy_map') {
      if (!call.arguments.targetSpaceKey) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 400, code: 'COPY_TARGET_REQUIRED' }) }] };
      if (++copies === 1) throw new Error('response lost');
      return { structuredContent: { id: 'copy', title: '副本', url: 'https://cartula.test/map/copy' } };
    }
    return {};
  } });
  const adapter = await openHost(t, host, { map: hostSnapshot('source'), previewToken: 'cpt_source', access: preview });
  await assert.rejects(adapter.access.copy!(), /response lost/);
  const copy = await adapter.access.copy!();
  const calls = host.named('copy_map');
  assert.equal(host.named('create_space').length, 1);
  assert.equal(new Set(calls.map(call => call.arguments.requestId)).size, 1);
  assert.deepEqual(calls[1].arguments, calls[2].arguments);
  assert.equal(calls[2].arguments.previewToken, 'cpt_source');
  assert.equal(copy.editUrl, 'https://cartula.test/map/copy#space=csk_destination');
});

test('host account copies keep the same retry key without allocating another space', async t => {
  let attempts = 0;
  const host = fakeHost({ answer: call => {
    assert.equal(call.name, 'copy_map');
    if (++attempts === 1) throw new Error('response lost');
    return { structuredContent: { id: 'copy', title: '副本', url: 'https://cartula.test/map/copy' } };
  } });
  const adapter = await openHost(t, host, { map: hostSnapshot('source'), access: { ...owner, claimed: true } });
  await assert.rejects(adapter.access.copy!(), /response lost/);
  await adapter.access.copy!();
  assert.deepEqual(host.calls[0], host.calls[1]);
  assert.ok(host.calls[0].arguments.requestId);
  assert.equal(host.calls[0].arguments.targetSpaceKey, undefined);
});

test('a lost share response keeps its retry key, while a deliberate new share gets another', async t => {
  let attempts = 0;
  const link = { id: 'share', previewToken: 'cpt_shared', previewUrl: 'https://cartula.test/map/source#preview=cpt_shared' };
  const host = fakeHost({ answer: () => {
    if (++attempts === 1) throw new Error('response lost');
    return { structuredContent: link };
  } });
  const adapter = await openHost(t, host, { map: hostSnapshot('source'), spaceKey: 'csk_owner', access: owner });
  await assert.rejects(adapter.access.share!(), /response lost/);
  assert.equal((await adapter.access.share!()).previewToken, link.previewToken);
  await adapter.access.share!();
  const calls = host.named('share_map');
  assert.deepEqual(calls[0], calls[1]);
  assert.ok(calls[0].arguments.requestId);
  assert.notEqual(calls[1].arguments.requestId, calls[2].arguments.requestId);
});

test('a copy destination the server rejects is let go of, so the next attempt can work', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    // A space this browser saved long ago; the server no longer knows it —
    // it was claimed by an account, or the deployment was rebuilt.
    local: { 'cartula:space': 'csk_gone' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      if (call.path === '/api/spaces') return { body: { spaceId: 'sp_new', spaceKey: 'csk_new', claimed: false } };
      if (call.path === '/api/maps/m3/copy') {
        return call.body.targetSpaceKey === 'csk_gone'
          ? { status: 403, body: { error: '目标空间密钥无效' } }
          : { body: { ...snapshot('m7', 1, owner), spaceId: 'sp_new' } };
      }
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      if (call.path.startsWith('/m/m7')) return { body: snapshot('m7', 1, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const source = await adapter.initialize(() => {});
  await assert.rejects(adapter.fork!(source));
  // A stated refusal ends that attempt, and the destination it named goes with
  // it — replaying it would be refused for as long as the key sat in storage.
  assert.equal(page.local().getItem('cartula:space'), null);
  const copy = await adapter.fork!(source);
  assert.equal(copy.id, 'm7');
  const copies = page.find('/api/maps/m3/copy', 'POST');
  assert.equal(copies[1].body.targetSpaceKey, 'csk_new', 'the second attempt names a space that exists');
  assert.notEqual(copies[0].body.requestId, copies[1].body.requestId, 'a different destination is a different request');
});

test('signing out of a map an unclaimed key still opens keeps it on screen', async t => {
  const page = openPage(t, {
    // Opened with a space key of this browser's own. The account was a
    // separate thing; signing out of it takes nothing away here.
    url: 'https://cartula.test/map/m1#space=csk_mine',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/auth/logout') return { body: { ok: true } };
      // The key is what authorises this map, with or without a session.
      if (call.path === '/api/maps/m1/access') return call.headers.Authorization === 'Bearer csk_mine' ? { body: { id: 'm1', version: 4, ...owner } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const updates: AdapterUpdate[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => updates.push(update));
  await adapter.access.logout!();
  assert.equal(adapter.access.state().user, null, 'the session is gone');
  // …but the authority for this map never was the session. Clearing the map
  // here would be taking away access the user still demonstrably has.
  assert.ok(!updates.some(update => update.cleared), 'nothing was revoked, so nothing may be cleared');
  assert.equal(adapter.editable, true);
  assert.equal(adapter.editUrl, 'https://cartula.test/map/m1#space=csk_mine');
  assert.equal(page.local().getItem('cartula:space'), 'csk_mine', 'an unclaimed key is not the account\'s to take');
});

test('signing out on a still-valid share link leaves the preview readable', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/auth/logout') return { body: { ok: true } };
      // The share is what grants this, and it outlives the session.
      if (call.path === '/api/maps/m3/access') return call.headers.Authorization === 'Bearer cpt_token' ? { body: { id: 'm3', version: 2, ...preview } } : { status: 403, body: { error: 'FORBIDDEN' } };
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      return undefined;
    },
  });
  const updates: AdapterUpdate[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => updates.push(update));
  await adapter.access.logout!();
  assert.equal(adapter.access.state().user, null);
  assert.ok(!updates.some(update => update.cleared), 'a share link is not something signing out can revoke');
  assert.equal(adapter.access.state().access?.kind, 'preview', 'still readable, still read-only');
  assert.equal(page.find('/api/maps/m3/access', 'POST').at(-1)!.headers.Authorization, 'Bearer cpt_token');
});

test('signing out drops the claimed space\'s key and the map it had loaded, but not an unrelated space', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_claimed',
    // A second, still-anonymous space this browser also has. It opens maps the
    // account never owned, and this is the only copy of its key — forgetting
    // it would protect nothing and lose those maps.
    local: { 'cartula:space': 'csk_other', 'cartula:space-maps': JSON.stringify({ m5: 'csk_other' }) },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/auth/logout') return { body: { ok: true } };
      const out = page.find('/api/auth/logout', 'POST').length > 0;
      if (call.path === '/api/maps/m1/access') return out ? { status: 401, body: { error: 'UNAUTHORIZED' } } : { body: { id: 'm1', version: 4, ...owner, claimed: true, canClaim: false } };
      if (call.path.startsWith('/m/m1')) return out ? { status: 401, body: { error: 'UNAUTHORIZED' } } : { body: snapshot('m1', 4, { ...owner, claimed: true, canClaim: false }) };
      return undefined;
    },
  });
  const updates: AdapterUpdate[] = [];
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(update => { if (update.cleared || update.error) updates.push(update); });
  assert.equal(adapter.editable, true);

  await adapter.access.logout!();
  assert.equal(adapter.access.state().user, null);
  assert.equal(adapter.editable, false);
  assert.equal(adapter.editUrl, undefined, 'the claimed space is no longer reachable from this browser');
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m1, undefined);
  // The other space is untouched: signing out is not "throw away every map
  // this browser ever made".
  assert.equal(page.local().getItem('cartula:space'), 'csk_other');
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m5, 'csk_other');
  // The private map that was loaded under the session must not stay on screen
  // behind the message saying it can no longer be read.
  assert.equal(updates.at(-1)?.cleared, 'access-revoked');
  assert.match(updates.at(-1)!.error!, /退出登录/);
});

test('a favorite recorded for one map does not light up the star on the next', async t => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      if (call.path === '/api/me/favorites/m3') return { body: { ok: true } };
      if (call.path === '/api/maps/m3/copy') return { body: { ...snapshot('m8', 1, owner), spaceId: 'sp_1', spaceKey: 'csk_new', claimed: false } };
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      if (call.path.startsWith('/m/m8')) return { body: snapshot('m8', 1, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const source = await adapter.initialize(() => {});
  // Favorite the shared map, then copy it before that answer comes back.
  const favoriting = adapter.access.favorite!();
  await adapter.fork!(source);
  release!();
  await held;
  await favoriting;
  // The favorite was recorded — for m3, which is no longer what is on screen.
  assert.equal(page.find('/api/me/favorites/m3', 'PUT').length, 1);
  assert.notEqual(adapter.access.state().favorited, true, 'the star belongs to the map it was recorded for');
});

test('claiming from a map the view has left still hands over the space, without locking the new map out', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/claim') return { body: { access: { ...owner, claimed: true, canClaim: false }, claimedMapCount: 2 } };
      if (call.path === '/api/maps/m1/copy') return { body: { ...snapshot('m9', 1, owner), spaceId: 'sp_other', spaceKey: 'csk_other', claimed: false } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      if (call.path.startsWith('/m/m9')) return { body: snapshot('m9', 1, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  // The claim is in flight when the view moves to another map entirely.
  const claiming = adapter.access.claim!();
  await adapter.fork!(map);
  const result = await claiming;

  assert.equal(result.claimedMapCount, 2, 'the claim itself still happened');
  // The claimed space is gone from storage wherever it was kept…
  assert.equal(page.local().getItem('cartula:space'), 'csk_other');
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m1, undefined);
  // …but the credential in hand belongs to the map that is open now, and
  // clearing it would lock the view out of a copy it can still edit.
  assert.equal(adapter.editable, true);
  assert.equal(adapter.editUrl, 'https://cartula.test/map/m9#space=csk_other');
  assert.equal(adapter.access.state().access?.claimed, false, 'the claim result describes m1, not the map on screen');
});

test('an account\'s own map opens from a bare URL without offering a guessed key at all', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1',
    // A perfectly valid key — for a different space. The server is fail-closed
    // about a bearer scoped elsewhere: it refuses rather than falling back to
    // the session behind it, so sending this at all would 403 the account out
    // of its own map.
    local: { 'cartula:space': 'csk_elsewhere' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') {
        return call.headers.Authorization
          ? { status: 403, body: { error: 'FORBIDDEN' } }
          : { body: { id: 'm1', version: 4, ...owner, claimed: true, canClaim: false } };
      }
      if (call.path.startsWith('/m/m1')) return call.headers.Authorization ? { status: 403, body: { error: 'FORBIDDEN' } } : { body: snapshot('m1', 4, { ...owner, claimed: true, canClaim: false }) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const map = await adapter.initialize(() => {});
  assert.equal(map.id, 'm1');
  assert.equal(adapter.editable, true);
  // Not "recovered after a 403" — never sent. The session is read first, and a
  // key nothing has tied to this map is not offered when a cookie can answer.
  const attempts = page.find('/api/maps/m1/access', 'POST');
  assert.equal(attempts.length, 1, 'one probe, not a refusal followed by a retry');
  assert.equal(attempts[0].headers.Authorization, undefined);
  for (const call of page.find('/m/m1')) assert.equal(call.headers.Authorization, undefined);
  // The other space is still this browser's; it was simply not relevant here.
  assert.equal(page.local().getItem('cartula:space'), 'csk_elsewhere');
});

test('an explicit preview stays read-only even for the account that owns the map', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#preview=cpt_token',
    // Signed in as the owner, and holding the owner key too. Neither may
    // upgrade a link that was handed out as read-only: the URL says preview,
    // so preview is what this page is.
    local: { 'cartula:space': 'csk_owner' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') {
        // What the tightened server answers for preview + owner cookie.
        return call.headers.Authorization === 'Bearer cpt_token'
          ? { body: { id: 'm1', version: 4, ...preview } }
          : { status: 403, body: { error: 'FORBIDDEN' } };
      }
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, preview) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  assert.equal(adapter.editable, false, 'a share link is read-only however much else the viewer holds');
  assert.equal(adapter.access.state().access?.kind, 'preview');
  // The preview token is the only credential offered — the owner key in
  // storage is never substituted for it, and never sent alongside.
  for (const call of [...page.find('/api/maps/m1/access', 'POST'), ...page.find('/m/m1')]) {
    assert.equal(call.headers.Authorization, 'Bearer cpt_token');
  }
  // And the entries follow the access the server stated, not what is in hand.
  assert.equal(adapter.access.capabilities().share, false, 'a preview cannot mint shares');
  assert.equal(adapter.access.capabilities().favorite, true, 'but it is exactly what a favorite records');
  assert.equal(adapter.editUrl, undefined, 'no owner address is offered from a preview page');
  FakeSocket.last!.onopen!();
  assert.deepEqual(JSON.parse(FakeSocket.last!.sent[0]), { type: 'auth', previewToken: 'cpt_token' });
});

/**
 * The one surface that hands the owner their own key back.
 *
 * The key is what an agent is configured with, so it has to be reachable — and
 * it is a bearer credential, so "reachable" has to mean exactly one principal.
 * `ownerKey` is that gate, and every way of being not-the-owner is checked here
 * rather than left to the panel: a share visitor, and the case where `access`
 * says owner because of the account cookie while the key in storage belongs to
 * a different space.
 */
test('the owner key is offered to the owner, to nobody else, and never fetched', async t => {
  const routes = (access: MapAccess, key: string): (call: Call) => Reply | undefined => call => {
    if (call.path.startsWith('/api/config')) return { body: config.body };
    if (call.path === '/api/session') return { body: { user: null } };
    if (call.path === '/api/maps/m1/access') return call.headers.Authorization === `Bearer ${key}` ? { body: { id: 'm1', version: 1, ...access } } : { status: 403, body: { error: 'FORBIDDEN' } };
    if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 1, access) };
    return undefined;
  };

  const page = openPage(t, { url: 'https://cartula.test/map/m1#space=csk_first', routes: routes(owner, 'csk_first') });
  const held = new BrowserAdapter();
  t.after(() => held.dispose());
  await held.initialize(() => {});
  assert.deepEqual(held.access.ownerKey!(), { key: 'csk_first', scope: 'space' });
  // Nothing was asked of the server: the key is only ever the copy in hand.
  assert.equal(page.find('/api/spaces', 'POST').length, 0);

  // Claimed changes nothing about the key: the account cookie is a second
  // principal, and configuring MCP is exactly what the key is still for.
  openPage(t, { url: 'https://cartula.test/map/m1#space=csk_first', routes: routes({ ...owner, claimed: true, canClaim: false }, 'csk_first') });
  const claimedSpace = new BrowserAdapter();
  t.after(() => claimedSpace.dispose());
  await claimedSpace.initialize(() => {});
  assert.deepEqual(claimedSpace.access.ownerKey!(), { key: 'csk_first', scope: 'space' });

  // A legacy per-map key authorises one map, so it is not called a space key.
  openPage(t, { url: 'https://cartula.test/map/m1#key=old-key', routes: routes({ kind: 'owner', editable: true, canShare: true, canClaim: true, claimed: false }, 'old-key') });
  const legacy = new BrowserAdapter();
  t.after(() => legacy.dispose());
  await legacy.initialize(() => {});
  assert.deepEqual(legacy.access.ownerKey!(), { key: 'old-key', scope: 'map' });

  // A share visitor holds a preview token, which never reaches this accessor.
  openPage(t, { url: 'https://cartula.test/map/m1#preview=cpt_token', routes: routes(preview, 'cpt_token') });
  const visitor = new BrowserAdapter();
  t.after(() => visitor.dispose());
  await visitor.initialize(() => {});
  assert.equal(visitor.access.ownerKey!(), undefined, 'a read-only visitor must never be shown an owner credential');

  // Signed in, holding a key for another space: the cookie answers for this map
  // and the guess is dropped, so there is no owner key here to show.
  const elsewhere = openPage(t, {
    url: 'https://cartula.test/map/m1',
    local: { 'cartula:space': 'csk_other' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'a1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') return call.headers.Authorization ? { status: 403, body: { error: 'FORBIDDEN' } } : { body: { id: 'm1', version: 1, ...owner, claimed: true, canClaim: false } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 1, { ...owner, claimed: true, canClaim: false }) };
      return undefined;
    },
  });
  const viaAccount = new BrowserAdapter();
  t.after(() => viaAccount.dispose());
  await viaAccount.initialize(() => {});
  assert.equal(viaAccount.access.state().access?.kind, 'owner', 'the account owns this map');
  assert.equal(viaAccount.access.ownerKey!(), undefined, 'but the key in storage is another space\'s, not this one\'s');
  assert.equal(elsewhere.local().getItem('cartula:space'), 'csk_other', 'and it stays this browser\'s own space');
});

test('a draft secures its space before the map exists, so a lost response loses nothing', async t => {
  let writes = 0;
  const page = openPage(t, {
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/spaces') return { body: { spaceId: 'sp_1', spaceKey: 'csk_first', claimed: false } };
      const created = /^\/m\/([\w-]+)$/.exec(call.path);
      if (created && call.method === 'PUT') {
        writes += 1;
        // The first save reaches the server and is applied — but the answer,
        // which would have carried the only copy of a new space key, is lost.
        return writes === 1
          ? { status: 502, body: { error: 'BAD_GATEWAY' } }
          : { body: { ...snapshot(created[1], 1, owner), spaceId: 'sp_1', spaceKey: 'csk_first', claimed: false } };
      }
      const written = /^\/api\/maps\/([\w-]+)\/replace$/.exec(call.path);
      if (written) return { body: snapshot(written[1], 2, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const draft = await adapter.initialize(() => {});
  await assert.rejects(adapter.replace({ title: '北境路线', layers: [] }, draft));
  // The key was obtained and stored *before* the map was written, so the map
  // the server just created is still reachable even though its response never
  // arrived. This is the whole point: a first save is the one write whose
  // response carries something that cannot be asked for again.
  assert.equal(page.local().getItem('cartula:space'), 'csk_first');
  const attempt = page.calls.find(call => call.method === 'PUT')!;
  assert.equal(attempt.headers.Authorization, 'Bearer csk_first', 'the write is authorised by a key already in hand');

  // Retrying keeps the same id and the same destination rather than stranding
  // the first attempt under an id nothing remembers.
  await adapter.replace({ title: '北境路线', layers: [] }, draft);
  const ids = page.calls.filter(call => call.method === 'PUT').map(call => call.path);
  assert.equal(new Set(ids).size, 1, 'a retry rewrites the same map, it does not create a second one');
  assert.equal(page.find('/api/spaces', 'POST').length, 1, 'and reuses the space it already minted');
});

test('a signed-in draft is saved into the account, without minting a space for it', async t => {
  const page = openPage(t, {
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      const created = /^\/m\/([\w-]+)$/.exec(call.path);
      if (created && call.method === 'PUT') return { body: { ...snapshot(created[1], 1, { ...owner, claimed: true, canClaim: false }), spaceId: 'sp_account' } };
      const written = /^\/api\/maps\/([\w-]+)\/replace$/.exec(call.path);
      if (written) return { body: snapshot(written[1], 2, { ...owner, claimed: true, canClaim: false }) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const draft = await adapter.initialize(() => {});
  await adapter.replace({ title: '账号里的新图', layers: [] }, draft);
  // The cookie already names a destination, so there is nothing to mint and no
  // key to keep: the account owns this map.
  assert.equal(page.find('/api/spaces', 'POST').length, 0);
  assert.equal(page.calls.find(call => call.method === 'PUT')!.headers.Authorization, undefined);
  assert.equal(page.local().getItem('cartula:space'), null);
  assert.equal(adapter.editUrl, undefined, 'an account map is not addressed by a key');
});

test('a copy into the account keeps no key from the map it was copied from', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m3#preview=cpt_token',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m3/access') return { body: { id: 'm3', version: 2, ...preview } };
      // Signed in, so the destination is the account's own space and the
      // response carries no key at all.
      if (call.path === '/api/maps/m3/copy') return { body: { ...snapshot('m7', 1, { ...owner, claimed: true, canClaim: false }), spaceId: 'sp_account' } };
      if (call.path.startsWith('/m/m3')) return { body: snapshot('m3', 2, preview) };
      if (call.path.startsWith('/m/m7')) return { body: snapshot('m7', 1, { ...owner, claimed: true, canClaim: false }) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  const source = await adapter.initialize(() => {});
  const copy = await adapter.fork!(source);
  assert.equal(copy.id, 'm7');
  assert.equal(page.find('/api/maps/m3/copy', 'POST')[0].body.targetSpaceKey, undefined, 'the cookie names the destination');
  // The source was read with a preview token and the copy belongs to the
  // account. Neither is an owner key for m7, and carrying one over would send
  // another space's credential with every read of this map.
  assert.equal(adapter.editUrl, undefined);
  for (const call of page.find('/m/m7')) assert.equal(call.headers.Authorization, undefined);
  assert.equal(page.replaced.at(-1), '/map/m7');
  assert.equal(adapter.editable, true, 'the cookie is what makes it editable');
});

test('a preview link is not overridden by a key cached for that very map', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#preview=cpt_token',
    // The sharpest version of the collision: this browser has previously
    // opened *this same map* as its owner, so the per-map entry, the legacy
    // per-map key and the default space key all name a credential for m1.
    // None of them may answer a URL that says preview.
    local: { 'cartula:space': 'csk_owner', 'cartula:space-maps': JSON.stringify({ m1: 'csk_owner' }) },
    session: { 'cartula:edit:m1': 'legacy-m1-key' },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') {
        return call.headers.Authorization === 'Bearer cpt_token'
          ? { body: { id: 'm1', version: 4, ...preview } }
          : { status: 403, body: { error: 'FORBIDDEN' } };
      }
      if (call.path.startsWith('/m/m1')) {
        return call.headers.Authorization === 'Bearer cpt_token'
          ? { body: snapshot('m1', 4, preview) }
          : { status: 403, body: { error: 'FORBIDDEN' } };
      }
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  assert.equal(adapter.editable, false, 'the link says preview, so the page is a preview');
  assert.equal(adapter.access.state().access?.kind, 'preview');
  // Every request carries the token and nothing else — the cached owner
  // credentials are not sent, not substituted, and not tried as a fallback.
  const sent = [...page.find('/api/maps/m1/access', 'POST'), ...page.find('/m/m1')];
  assert.ok(sent.length > 0);
  for (const call of sent) assert.equal(call.headers.Authorization, 'Bearer cpt_token');
  assert.equal(adapter.editUrl, undefined, 'and no owner address is offered from here');
  // The owner key is still this browser's — it was simply not what this URL
  // asked for, so opening a preview must not cost the user their own key.
  assert.equal(page.local().getItem('cartula:space'), 'csk_owner');
  assert.equal(JSON.parse(page.local().getItem('cartula:space-maps')!).m1, 'csk_owner');
});

test('a share link followed from the same page is not ignored as an echo', async t => {
  const page = openPage(t, {
    // Already open as the owner, fragment consumed and tidied away.
    url: 'https://cartula.test/map/m1',
    local: { 'cartula:space': 'csk_owner', 'cartula:space-maps': JSON.stringify({ m1: 'csk_owner' }) },
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  assert.equal(adapter.editable, true);
  assert.equal(page.reloaded(), 0);

  // `/map/m1` → `/map/m1#preview=T` is a same-document navigation: no page
  // load, so nothing would re-read the fragment on its own. Left unhandled,
  // whoever followed a read-only link would keep the owner's editing rights.
  page.navigateHash('#preview=cpt_token');
  assert.equal(page.reloaded(), 1, 'the credential changed, so the session is rebuilt around it');
});

test('the adapter does not reload on its own URL tidying, or on a fragment it already holds', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: null } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  // initialize consumed the fragment and rewrote the URL itself. That rewrite
  // must not look like somebody navigating — a reload loop is the failure mode.
  assert.equal(page.reloaded(), 0);

  // Re-stating the credential already in hand is not a change either.
  page.navigateHash('#space=csk_first');
  assert.equal(page.reloaded(), 0, 'the same key is not a new credential');

  // Nor is a fragment that carries no credential at all.
  page.navigateHash('#section=notes');
  assert.equal(page.reloaded(), 0, 'someone else\'s fragment is none of our business');

  // A genuinely different owner key is.
  page.navigateHash('#space=csk_second');
  assert.equal(page.reloaded(), 1);
});

test('a bodyless request does not claim to carry JSON', async t => {
  const page = openPage(t, {
    url: 'https://cartula.test/map/m1#space=csk_first',
    routes: call => {
      if (call.path.startsWith('/api/config')) return { body: config.body };
      if (call.path === '/api/session') return { body: { user: { id: 'u1', email: 'anna@example.com' } } };
      if (call.path === '/api/maps/m1/access') return { body: { id: 'm1', version: 4, ...owner } };
      if (call.path === '/api/maps/m1/preview' && call.method === 'DELETE') return { body: { ok: true } };
      if (call.path === '/api/me/favorites/m1' && call.method === 'DELETE') return { body: { ok: true } };
      if (call.path.startsWith('/m/m1')) return { body: snapshot('m1', 4, owner) };
      return undefined;
    },
  });
  const adapter = new BrowserAdapter();
  t.after(() => adapter.dispose());
  await adapter.initialize(() => {});
  await adapter.access.revokeShare!();
  await adapter.access.unfavorite!('m1');
  // Fastify rejects a request that announces `Content-Type: application/json`
  // and then sends nothing — "Body cannot be empty", a 400 raised before the
  // route is even reached, which is what broke 停用全部分享 and 移除收藏.
  // Both are bodyless, so neither may claim a body.
  const bodyless = page.calls.filter(call => call.method === 'DELETE');
  assert.deepEqual(bodyless.map(call => call.path).sort(), ['/api/maps/m1/preview', '/api/me/favorites/m1']);
  for (const call of bodyless) {
    assert.equal(call.headers['Content-Type'], undefined, `${call.path} sends no body, so it must not claim one`);
    // Dropping the type header may not drop anything else with it.
    assert.equal(call.headers.Accept, 'application/json', `${call.path} still states what it wants back`);
    assert.equal(call.headers['X-Cartula-Request'], '1', `${call.path} still carries the CSRF header`);
  }
  // Revoking a share is authorised by the owner key; removing a favorite is the
  // account's own doing and deliberately sends no bearer at all.
  assert.equal(bodyless.find(call => call.path === '/api/maps/m1/preview')!.headers.Authorization, 'Bearer csk_first');
  assert.equal(bodyless.find(call => call.path === '/api/me/favorites/m1')!.headers.Authorization, undefined);
  // Requests that do carry a body keep describing it.
  const withBody = page.find('/api/maps/m1/access', 'POST')[0];
  assert.equal(withBody.headers['Content-Type'], 'application/json');
  assert.equal(withBody.body !== undefined, true);
});

test('a preview inside a host offers only what a preview may do', async t => {
  const host = fakeHost({ openLinks: false, answer: () => ({ _meta: { cartula: { map: hostSnapshot('m3', 2), previewToken: 'cpt_token', access: preview } } }) });
  const adapter = await openHost(t, host, { map: hostSnapshot('m3'), previewToken: 'cpt_token', access: preview });
  assert.equal(adapter.editable, false);
  const capabilities = adapter.access.capabilities();
  assert.equal(capabilities.share, false, 'a preview cannot hand out shares of its own');
  assert.equal(capabilities.favorite, false, 'and cannot sign in here to keep one');
  assert.equal(capabilities.openExternal, false, 'a host without openLink gets no entry it cannot honour');
  assert.equal(adapter.access.externalUrl!(), 'https://cartula.test/map/m3#preview=cpt_token');
  await assert.rejects(adapter.access.openExternal!('https://cartula.test/map/m3'), /宿主/);
  // Reads carry the token; there is no owner credential to fall back to.
  await (adapter as unknown as { refresh(): Promise<void> }).refresh();
  assert.equal(host.named('get_map_state').at(-1)!.arguments.previewToken, 'cpt_token');
});
