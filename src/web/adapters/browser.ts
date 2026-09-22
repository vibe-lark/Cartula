import { randomId } from '../id.js';
import { normalizeMap, toMapInput } from '../../core/model.js';
import { DEMO_INPUT } from '../../core/demo.js';
import type { EditOperation, MapInput, MapSnapshot, Suggestion, WriteResult } from '../../core/types.js';
import type { AccountSession, ApiKeyInfo, ClaimResult, CreatedApiKey, MapAccess, MapLibrary, PreviewLink, ShareLinkInfo, SpaceCredential } from '../../core/access.js';
import { download, type Adapter, type AdapterUpdate, type HandoffResult } from './types.js';
import { IdempotentRequest, beginSubmit, reportReplaceConflict, retryEditConflictOnce, type PendingSubmit } from './state.js';
import { rejection } from './delivery.js';
import {
  AccessSignal, accessErrorText, authProblem, createSpaceStore, credentialUrl, errorStatus, normalizeEmail, parseCredential, readAccess,
  type AccessPort, type AuthInput, type SpaceStore,
} from './access.js';

export function draftSnapshot(input: MapInput = DEMO_INPUT): MapSnapshot {
  return { ...normalizeMap(input, undefined, 'agent'), id: 'draft', version: 0, parent: null, updatedAt: new Date().toISOString(), changed: false, changes: [], events: [], url: '' };
}
/** A write response, plus the space credential a new space comes back with. */
type WriteResponse = WriteResult & Partial<SpaceCredential> & { access?: MapAccess };

export class BrowserAdapter implements Adapter {
  mode = 'browser' as const;
  editable = false;
  /** Owner credential: a space key, or a legacy per-map edit key. */
  private key?: string;
  /** Read-only share credential. Never used where an owner key is required. */
  private previewToken?: string;
  /** Whether the credential in hand was named by the URL rather than remembered. */
  private explicit: boolean;
  /**
   * Whether the credential in hand is only "the space this browser creates in"
   * — never confirmed against this map. It is dropped before the account
   * cookie is relied on, because a fail-closed server refuses a bearer it does
   * not recognise instead of falling back to the session behind it.
   */
  private guessed = false;
  private id = /^\/map\/([\w-]+)$/.exec(location.pathname)?.[1];
  private spaces: SpaceStore = createSpaceStore();
  private signal = new AccessSignal();
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private onUpdate: (update: AdapterUpdate) => void = () => {};
  private activeVersion = 0;
  /** Bumped by fork/first save: results for the previous map are then ignored. */
  private generation = 0;
  private edits = new IdempotentRequest(randomId);
  private imports = new IdempotentRequest(randomId);
  /** A copy in flight: its destination and id are fixed until it is confirmed. */
  private pendingCopy?: { mapId: string; title: string; targetSpaceKey?: string; requestId: string };
  private submit?: PendingSubmit;
  /** Whether the socket has been accepted; only then is it worth calling live. */
  private liveAck = false;
  /** An owner key this browser has written somewhere a reload can find it. */
  private durable?: string;
  /** The in-flight session probe, so a save can wait for it rather than guess. */
  private session?: Promise<unknown>;
  /** The fragment this side last wrote, to tell its own echo from a navigation. */
  private knownHash = typeof location === 'undefined' ? '' : location.hash;
  private onHashChange?: () => void;
  constructor() {
    const inbound = parseCredential(location.hash);
    this.explicit = Boolean(inbound.owner || inbound.previewToken);
    this.previewToken = inbound.previewToken;
    // A remembered key is a guess about this map; the URL is a statement about
    // it. The two are told apart so only the guess may be dropped silently.
    // The key this browser last opened *this* map with comes first: the one
    // space key it creates maps in is a different question, and answering
    // this one with it would strand every map of an earlier space.
    const known = this.id && !inbound.previewToken ? this.spaces.forMap(this.id) ?? this.mapKey(this.id) : undefined;
    this.key = inbound.owner ?? known ?? (this.id && !inbound.previewToken ? this.spaces.read() : undefined);
    // Nothing has said this key opens this map: it is simply the space this
    // browser happens to create in.
    this.guessed = !inbound.owner && !known && Boolean(this.key);
    this.durable = inbound.owner ? undefined : this.key;
    this.editable = !this.id || Boolean(this.key);
  }
  get editUrl() { return this.id && this.key ? credentialUrl(`${location.origin}/map/${this.id}`, { owner: this.key }) : undefined; }
  /** `this.key` and `this.previewToken` are always mutually exclusive — see their declarations above. */
  shareCredential() { return this.previewToken ? { previewToken: this.previewToken, canWrite: this.editable } : undefined; }
  /** Identity to bind an in-flight request to. */
  private identity() { return this.id ? { mapId: this.id, generation: this.generation } : undefined; }
  private current(expect: { mapId: string; generation: number }) { return !this.disposed && this.id === expect.mapId && this.generation === expect.generation; }
  /** A different map is open now; anything pending belonged to the old one. */
  private switchTo(id: string) {
    this.generation += 1;
    this.id = id;
    this.edits.clear(); this.imports.clear(); this.pendingCopy = undefined; this.submit = undefined;
    // Permission, share state and favorites are all about the map that just
    // left; the view must not carry any of them onto this one.
    this.signal.set({ access: undefined, favorited: false });
  }
  private switched() { return new Error('地图已切换，这次操作仍然作用在原来的地图上。请回到那张地图查看结果。'); }
  /** Legacy per-map edit keys, kept where they have always lived. */
  private mapKey(id: string) { try { return sessionStorage.getItem(`cartula:edit:${id}`) ?? undefined; } catch { return undefined; } }
  private rememberMapKey(id: string, key: string) { try { sessionStorage.setItem(`cartula:edit:${id}`, key); } catch { /* sandbox */ } }
  private forgetMapKey(id: string) { try { sessionStorage.removeItem(`cartula:edit:${id}`); } catch { /* sandbox */ } }
  /**
   * Forget an owner credential, wherever this browser put it.
   *
   * Called when an account takes the space over. One copy left behind — under
   * the space, under the per-map ring, or under any single legacy map — would
   * quietly give the maps back after a sign-out, which is the one thing signing
   * out has to prevent.
   */
  private forgetOwnerKey(key: string | undefined) {
    if (!key) { this.spaces.clear(); return; }
    this.spaces.forget(key);
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const name = sessionStorage.key(index);
        if (name?.startsWith('cartula:edit:') && sessionStorage.getItem(name) === key) sessionStorage.removeItem(name);
      }
    } catch { /* sandbox */ }
  }
  /**
   * Adopt what a response says about this map.
   *
   * Only a credential the server itself calls a space key is remembered as the
   * space this browser creates maps in: a legacy per-map key opens exactly one
   * map, and storing it as this browser's space would send later creations
   * somewhere they cannot go. Either kind is remembered *against this map*, so
   * a second space opened in the same browser does not strand the first.
   */
  private applyAccess(access: MapAccess | undefined, key?: string) {
    if (access) this.editable = access.editable;
    if (key && access?.kind === 'owner' && !access.claimed) {
      if (access.spaceId) this.spaces.write(key);
      if (this.id && this.spaces.remember(this.id, key)) this.durable = key;
    }
    this.signal.set({ access });
  }
  private adoptWrite(result: WriteResponse) {
    const key = result.spaceKey ?? result.editKey;
    if (key) {
      this.key = key;
      const claimed = result.claimed || Boolean(result.access?.claimed);
      if (result.spaceKey && !claimed) this.spaces.write(result.spaceKey);
      if (!claimed && this.spaces.remember(result.id, key)) this.durable = key;
      if (!result.spaceKey) this.rememberMapKey(result.id, key);
    }
    this.editable = result.access ? result.access.editable : Boolean(this.key);
    this.signal.set({ access: result.access });
  }
  async unlock(credential: string) {
    if (!this.id) return;
    const raw = credential.trim();
    let parsed = parseCredential(raw.startsWith('#') ? raw : '');
    if (/^https?:/.test(raw)) {
      const url = new URL(raw);
      if (url.origin !== location.origin || url.pathname !== `/map/${this.id}`) throw new Error('请输入这张地图的链接。');
      parsed = parseCredential(url.hash);
    } else if (!parsed.owner && !parsed.previewToken) parsed = { owner: raw };
    // A share link is no longer read-only by construction: whether it may edit
    // is a property of the token, and only the server knows it. So ask, and let
    // the answer decide — refusing on the shape of the link would turn a working
    // collaboration link into "ask someone for a different one".
    if (parsed.previewToken && !parsed.owner) {
      const token = parsed.previewToken;
      const expect = this.identity()!;
      const access = readAccess(await this.request(`/api/maps/${expect.mapId}/access`, { method: 'POST', body: '{}' }, token));
      if (!this.current(expect)) throw this.switched();
      if (!access?.editable) throw new Error('这是只读分享链接，不能用来编辑。请向分享给你的人索取可编辑的链接。');
      this.key = undefined; this.previewToken = token; this.explicit = true; this.editable = true; this.guessed = false;
      this.applyAccess(access);
      this.replaceUrl(credentialUrl(`/map/${this.id}`, { previewToken: token }));
      await this.reload();
      return;
    }
    const key = parsed.owner ?? '';
    if (!key) throw new Error('这个链接里没有可用的密钥。');
    const expect = this.identity()!;
    const access = readAccess(await this.request(`/api/maps/${expect.mapId}/access`, { method: 'POST', body: '{}' }, key));
    if (!this.current(expect)) throw this.switched();
    if (access && !access.editable) throw new Error('这个密钥只能查看这张地图，不能编辑。');
    this.key = key; this.previewToken = undefined; this.explicit = true; this.editable = true; this.guessed = false;
    if (!access?.spaceId) this.rememberMapKey(this.id, key);
    this.applyAccess(access, key);
    this.replaceUrl(credentialUrl(`/map/${this.id}`, { owner: key }));
    await this.reload();
    this.tidyUrl();
  }
  /**
   * Read the map again after the credentials changed.
   *
   * This is the path back from a page that had no permission at all: nothing
   * was ever loaded, so the read also has to start the live connection.
   */
  private async reload() {
    const expect = this.identity();
    if (!expect) return;
    const map = await this.request<MapSnapshot & { access?: MapAccess }>(`/m/${expect.mapId}?since=0`);
    if (!this.current(expect) || map.id !== expect.mapId) return;
    if (map.access) this.applyAccess(map.access, this.key);
    this.activeVersion = Math.max(this.activeVersion, map.version);
    this.onUpdate({ snapshot: map });
    if (!this.timer) this.watch();
  }
  /**
   * A space this browser may write to, for a copy that is about to be made.
   *
   * An anonymous copy has to name its destination *before* it is attempted:
   * without one the server cannot recognise a retry, and answers a request that
   * carries a `requestId` with a 400 rather than quietly making a second map.
   * An unclaimed space already in hand is reused; otherwise one is minted and
   * saved first, so a lost response is retried into the same place.
   */
  private async targetSpaceKey(): Promise<string | undefined> {
    // Whether an account can answer for the destination is a question with a
    // real answer, so it is waited for rather than guessed at: a draft can be
    // saved before the session probe returns, and treating "not known yet" as
    // "anonymous" would mint a space the account never needed.
    await this.session?.catch(() => undefined);
    if (this.signal.state().user) return undefined;
    const held = this.spaces.read();
    if (held) return held;
    const created = await this.request<SpaceCredential>('/api/spaces', { method: 'POST', body: '{}' }, null);
    // Saved before it is used: if the write's answer is lost, the retry has to
    // find the same destination rather than mint another one.
    this.spaces.write(created.spaceKey);
    return created.spaceKey;
  }
  /**
   * A copy of one's own.
   *
   * The server makes it: a copy is a new independent map, and none of the
   * source's history, ownership or share links may travel with it. The read
   * credential authorises the source, `targetSpaceKey` the destination, and
   * they are deliberately not the same field.
   *
   * Everything the request is made of — title, destination, request id — is
   * pinned on the first attempt and kept until the copy is confirmed. A retry
   * after a lost response therefore replays the identical request and the
   * server hands back the copy it already made; the source moving on in the
   * meantime, from another tab or the agent, changes none of it. A refusal the
   * server states outright is the opposite case: nothing was written, and
   * replaying it would only be refused again, so the record is dropped.
   */
  async fork(snapshot: MapSnapshot): Promise<MapSnapshot> {
    const expect = this.identity();
    if (!expect) throw new Error('这张草稿还没有保存，先保存后才能创建副本。');
    if (this.pendingCopy && this.pendingCopy.mapId !== expect.mapId) this.pendingCopy = undefined;
    if (!this.pendingCopy) {
      const target = await this.targetSpaceKey();
      if (!this.current(expect)) throw this.switched();
      this.pendingCopy = {
        mapId: expect.mapId, title: `${snapshot.title.slice(0, 115)} · 副本`,
        ...(target ? { targetSpaceKey: target } : {}), requestId: randomId(),
      };
    }
    const attempt = this.pendingCopy;
    let result: WriteResponse;
    try {
      result = await this.request<WriteResponse>(`/api/maps/${attempt.mapId}/copy`, {
        method: 'POST',
        body: JSON.stringify({ requestId: attempt.requestId, title: attempt.title, ...(attempt.targetSpaceKey ? { targetSpaceKey: attempt.targetSpaceKey } : {}) }),
      });
    } catch (error) {
      const status = errorStatus(error);
      // A 4xx is the server having decided: nothing was written, so this
      // attempt is over. Only an unknown outcome — a lost response, a 5xx —
      // keeps the record for an identical retry.
      if (status && status >= 400 && status < 500) {
        this.pendingCopy = undefined;
        // The destination itself may be why: a space that has since been
        // claimed, or one this server no longer knows. Letting go of it means
        // the next attempt mints a space that does work, instead of replaying
        // a refusal for as long as the key sits in storage.
        if (attempt.targetSpaceKey && (status === 403 || status === 400) && attempt.targetSpaceKey !== this.key) {
          this.spaces.clear(attempt.targetSpaceKey);
        }
      }
      throw error;
    }
    this.pendingCopy = undefined;
    if (!this.current(expect)) throw this.switched();
    this.switchTo(result.id);
    this.previewToken = undefined; this.explicit = false; this.guessed = false;
    // The copy's credential is stated outright rather than inherited. The
    // source's key authorised *reading the original*; it says nothing about
    // the copy, and when the destination was the account's own space (no
    // `targetSpaceKey`, no key in the response) there is no key at all — the
    // cookie is the authority. Keeping the source key there would send another
    // space's credential with every read of this map.
    this.key = result.spaceKey ?? result.editKey ?? attempt.targetSpaceKey;
    this.adoptWrite(result);
    if (attempt.targetSpaceKey && !result.spaceKey && this.spaces.remember(result.id, attempt.targetSpaceKey)) this.durable = attempt.targetSpaceKey;
    this.replaceUrl(credentialUrl(`/map/${result.id}`, { owner: this.key }));
    this.tidyUrl();
    this.activeVersion = result.version; this.watch();
    return result;
  }
  /**
   * @param credential `undefined` sends whatever authorises this map, `null`
   * sends nothing (session-cookie calls), a string forces one credential.
   */
  private async request<T>(path: string, init: RequestInit = {}, credential?: string | null): Promise<T> {
    // Bound to the map this request is about: a late failure for a map the
    // view has left must not reset the pending writes of the one it is on.
    const at = this.identity();
    const bearer = credential === undefined ? this.previewToken ?? this.key : credential;
    let response: Response;
    try {
      response = await fetch(path, {
        ...init, credentials: 'same-origin',
        // Named on every request: the server refuses cookie-carrying writes
        // that a third-party page could have triggered without it.
        // `Content-Type` only where there is a body to describe — Fastify
        // rejects a bodyless request that claims to carry JSON, which is what
        // a DELETE is.
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Cartula-Request': '1',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    }
    // The request may well have reached the server and been applied; all this
    // side knows is that it never saw the answer.
    catch { throw new Error('连接中断，这次操作是否已经保存还不确定。请保留页面，恢复连接后重试。'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // A rejection the server stated outright wrote nothing, so the attempt
      // that was refused is over; only unknown outcomes (transport failures,
      // 5xx) keep their payload for a replay.
      if (!at || this.current(at)) {
        if (path.includes('/submit') && response.status >= 400 && response.status < 500) this.submit = undefined;
        if (response.status === 409) { this.edits.clear(); this.imports.clear(); void this.refresh(); }
      }
      const message = [data.error, data.hint].filter(Boolean).join(' · ') || `请求失败（${response.status}）`;
      // Only a 4xx is the server stating a decision; a 5xx leaves the outcome
      // of the request open.
      const error = response.status < 500 ? rejection(message) : new Error(message);
      throw Object.assign(error, { status: response.status });
    }
    return data as T;
  }
  /**
   * What the credentials in hand grant here.
   *
   * A key remembered from an earlier visit is a guess: it may belong to another
   * space entirely, and being refused by this map says nothing about the other
   * maps it does open. So the guess is dropped for this map only, and the read
   * is retried without it before the page gives up. The server is deliberately
   * fail-closed about a bearer that is valid but scoped elsewhere — it refuses
   * rather than falling back to the session cookie behind it — so a guess is
   * not offered at all once there is a session that could have answered
   * instead. Opening an account's own map from a bare URL must not depend on
   * which anonymous space this browser last created in.
   */
  private async resolveAccess(): Promise<MapAccess | undefined> {
    const expect = this.identity();
    if (!expect) return undefined;
    // Signed in and holding nothing but a guess: the cookie is the better
    // credential and the guess can only get in its way.
    if (this.guessed && this.signal.state().user && !this.previewToken) { this.key = undefined; this.guessed = false; }
    try {
      const access = readAccess(await this.request(`/api/maps/${expect.mapId}/access`, { method: 'POST', body: '{}' }));
      if (!this.current(expect)) return undefined;
      this.guessed = false;
      this.applyAccess(access, this.key);
      return access;
    } catch (error) {
      const status = errorStatus(error);
      if (!this.current(expect) || !(status === 401 || status === 403)) throw error;
      // Only a guess may be retried without. A credential the URL named is a
      // statement about this map, and being refused is the answer: a revoked
      // share must surface as "this link no longer works", not quietly become
      // whatever the cookie behind it can still read. Otherwise someone who
      // favorited this map — or who owns it — would see the page reopen with
      // more access than the link they followed was ever given.
      if (this.explicit || this.previewToken) {
        this.editable = false;
        this.signal.set({ access: undefined });
        // `stated` keeps this wording: it already names what went wrong, and
        // the generic "this map is private" would be less true and less useful.
        throw Object.assign(new Error(this.explicitRefusal()), { status, stated: true });
      }
      if (!this.guessed) throw error;
      // The guess is dropped rather than restored: it was refused here, and
      // keeping it would send it again with every later read of this map.
      this.key = undefined;
      const access = readAccess(await this.request(`/api/maps/${expect.mapId}/access`, { method: 'POST', body: '{}' }));
      if (!this.current(expect)) return undefined;
      this.guessed = false;
      this.applyAccess(access);
      return access;
    }
  }
  /** Why a credential the URL named was refused, in the terms the user has. */
  private explicitRefusal() {
    return this.previewToken
      ? '这个分享链接已经停用。请向分享给你的人索取新的链接。'
      : '这个链接对这张地图无效。请向创建地图的 Agent 获取正确的链接，或创建可编辑副本。';
  }
  async initialize(onUpdate: (update: AdapterUpdate) => void) {
    this.onUpdate = onUpdate;
    this.watchHash();
    const config = await this.request<{ tileUrl: string }>('/api/config', {}, null);
    (window as unknown as { __CARTULA_CONFIG__: unknown }).__CARTULA_CONFIG__ = config;
    const session = this.session = this.loadSession();
    if (!this.id) { onUpdate({ connection: 'live' }); return draftSnapshot(new URLSearchParams(location.search).has('new') ? { title: '新的探索', layers: [] } : DEMO_INPUT); }
    // Whether a guess is worth offering depends on whether there is a session
    // that could answer instead, so on a bare URL that question is settled
    // first. With a credential the URL named there is nothing to decide, and
    // the read starts without waiting.
    if (this.guessed) await session;
    // Permission first: a private map answers nothing at all without it, and
    // the page must be able to say why — and offer a way back — instead of
    // stalling on "loading".
    try { await this.resolveAccess(); }
    catch (error) {
      const status = errorStatus(error);
      // A refusal that already names what went wrong — a dead share link, a
      // key for another map — keeps its own words; only an unexplained one is
      // turned into the general "this map is private" with its way back.
      const stated = (error as { stated?: unknown }).stated === true;
      throw Object.assign(new Error(stated ? (error as Error).message : accessErrorText(status, (error as Error).message)), { status });
    }
    const map = await this.request<MapSnapshot & { access?: MapAccess }>(`/m/${this.id}?since=0`);
    if (map.access) this.applyAccess(map.access, this.key);
    // A space key already has one home; per-map copies of it would only be
    // copies a sign-out cannot reach.
    if (this.key && this.id && !map.access?.spaceId) this.rememberMapKey(this.id, this.key);
    this.tidyUrl();
    this.activeVersion = map.version; this.watch(); return map;
  }
  /**
   * Take a consumed credential back out of the address bar.
   *
   * Only once something durable is holding it: a fragment that is dropped
   * before the key is stored anywhere is a map nobody can reopen. A preview
   * token stays put — it is not remembered anywhere, and it is the whole of
   * what the address is.
   */
  private tidyUrl() {
    if (!this.id || !this.key || this.previewToken || !location.hash) return;
    if (this.durable !== this.key && this.mapKey(this.id) !== this.key) return;
    this.replaceUrl(`/map/${this.id}${location.search}`);
  }
  /**
   * Rewrite the address without treating it as an inbound credential.
   *
   * `replaceState` fires no event, but `watchHash` compares against what this
   * side last wrote, and every rewrite here is this side's own doing —
   * recording it keeps a later genuine navigation distinguishable from the
   * echo of a fragment we just consumed.
   */
  private replaceUrl(next: string) {
    history.replaceState(null, '', next);
    this.knownHash = location.hash;
  }
  /**
   * Follow a credential that arrives without a page load.
   *
   * `/map/x#preview=T` from `/map/x` is a same-document navigation: the SPA is
   * never rebuilt, so a constructor that only reads the fragment once would
   * keep the owner key it already had and show an editable map to someone who
   * followed a read-only link. The browser fires `hashchange` for exactly this
   * case — and not for `replaceState`, which is how the adapter tidies the URL
   * itself, so the two do not chase each other.
   *
   * Reloading is deliberate rather than re-deriving state in place: the
   * credential decides what the whole session may do — which socket, which
   * cached key, which pending write is still valid — and a fresh document is
   * the one way to be sure none of the old answers survive.
   */
  private watchHash() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.onHashChange = () => {
      if (this.disposed || location.hash === this.knownHash) return;
      const inbound = parseCredential(location.hash);
      // Only a credential is worth reacting to; any other fragment is somebody
      // else's business.
      if (!inbound.owner && !inbound.previewToken) { this.knownHash = location.hash; return; }
      // Already the credential in hand — the address merely restated it.
      if (inbound.previewToken ? inbound.previewToken === this.previewToken : inbound.owner === this.key && !this.previewToken) {
        this.knownHash = location.hash;
        return;
      }
      this.knownHash = location.hash;
      location.reload();
    };
    window.addEventListener('hashchange', this.onHashChange);
  }
  private async refresh() {
    const expect = this.identity();
    if (!expect || this.disposed) return;
    try {
      const snapshot = await this.request<MapSnapshot & { access?: MapAccess }>(`/m/${expect.mapId}?since=0`);
      // A read issued before a fork must not land on the copy.
      if (!this.current(expect) || snapshot.id !== expect.mapId) return;
      if (snapshot.access) this.applyAccess(snapshot.access, this.key);
      if (snapshot.version > this.activeVersion) { this.activeVersion = snapshot.version; this.onUpdate({ snapshot }); }
      this.onUpdate({ connection: this.live() ? 'live' : 'polling' });
    } catch { if (this.current(expect)) this.onUpdate({ connection: 'polling' }); }
  }
  /**
   * Re-read this map and report its version, for a conflict to replay
   * against.
   *
   * Close to `refresh()`, but deliberately not built on it: that method
   * swallows every failure to keep polling quiet, while a conflict retry
   * cannot pick a base version it never confirmed, so its failure has to
   * reach the caller instead of being reported as a bare "polling" state.
   */
  private async refreshVersion(expect: { mapId: string; generation: number }): Promise<number> {
    const snapshot = await this.request<MapSnapshot & { access?: MapAccess }>(`/m/${expect.mapId}?since=0`);
    if (!this.current(expect) || snapshot.id !== expect.mapId) throw this.switched();
    if (snapshot.access) this.applyAccess(snapshot.access, this.key);
    if (snapshot.version > this.activeVersion) { this.activeVersion = snapshot.version; this.onUpdate({ snapshot }); }
    return snapshot.version;
  }
  /** Live means the server accepted the socket, not merely that it opened. */
  private live() { return this.liveAck && this.ws?.readyState === WebSocket.OPEN; }
  private watch() {
    if (this.disposed || !this.id) return;
    this.liveAck = false;
    this.ws?.close();
    const url = new URL(`/m/${this.id}`, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.ws = ws;
    // A socket carries no Authorization header, so the credential is named in
    // the first frame; until the server accepts it, a private map sends
    // nothing. The frame is sent even with nothing to name — the session
    // cookie the handshake already carried is a credential too, and the server
    // acknowledges it the same way.
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: 'auth', ...(this.previewToken ? { previewToken: this.previewToken } : this.key ? { key: this.key } : {}) })); } catch { /* closed already */ }
      // Polling until the ack: the socket is open, but nothing has said it may
      // read, and claiming "live" before that is claiming someone else's edits
      // will show up here.
      this.onUpdate({ connection: 'polling' }); void this.refresh();
    };
    ws.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event.type === 'auth') {
          if (event.ok === false) { this.liveAck = false; this.onUpdate({ connection: 'polling' }); }
          else if (this.ws === ws) { this.liveAck = true; this.onUpdate({ connection: 'live' }); }
          return;
        }
        // An initial version notification is the other way the server says the
        // connection may read — a cookie-authorised socket is announced to
        // before it ever asks.
        if (event.type === 'edit') { if (this.ws === ws && !this.liveAck) { this.liveAck = true; this.onUpdate({ connection: 'live' }); } void this.refresh(); }
        if (event.type === 'suggest') this.onUpdate({ suggestion: event as Suggestion });
      } catch { /* Ignore malformed notifications; GET remains authoritative. */ }
    };
    ws.onclose = () => { if (!this.disposed && this.ws === ws) { this.liveAck = false; this.onUpdate({ connection: 'polling' }); this.reconnect = setTimeout(() => this.watch(), 3000); } };
    ws.onerror = () => ws.close();
    if (!this.timer) this.timer = setInterval(() => { void this.refresh(); }, 5000);
  }
  /**
   * Write the map, creating it on the first save.
   *
   * A draft's first save is the one write whose *response* carries something
   * irreplaceable: the key to a brand-new space. If that response is lost the
   * map exists on the server and nothing here can ever open it again. So the
   * destination is settled first — an unclaimed space already in hand, the
   * account's cookie, or a space minted and stored before the map is written —
   * and the PUT then goes out authorised by a credential this browser already
   * has. The id and body stay fixed across retries, and `Idempotency-Key` is
   * unchanged for updates, so CAS and de-duplication behave exactly as before.
   */
  private async persist(input: MapInput, previous?: MapSnapshot) {
    const isNew = !this.id;
    if (isNew) {
      // Settled before the id exists, so a failure here leaves nothing behind.
      const target = await this.targetSpaceKey();
      this.switchTo(randomId());
      this.key = target;
      this.guessed = false;
    }
    const result = await this.request<WriteResponse>(`/m/${this.id}`, { method: 'PUT', body: JSON.stringify(input), headers: previous?.version ? { 'If-Match': `"${previous.version}"`, 'Idempotency-Key': randomId() } : {} });
    this.adoptWrite(result);
    this.replaceUrl(credentialUrl(`/map/${this.id}`, { owner: this.key }));
    this.tidyUrl();
    this.activeVersion = result.version;
    this.onUpdate({ snapshot: result });
    if (isNew || !this.timer) this.watch();
    return result;
  }
  /**
   * The whole history at the version a write just produced.
   *
   * A write answers against its own `baseVersion`, so its event list covers
   * that write alone; the view counts what is still un-handed-over from those
   * events, and after two edits it would show one. Re-reading with `since=0`
   * costs one GET and keeps the rendered snapshot complete. If that read fails
   * the write still succeeded, so its own result stands.
   */
  private async withFullHistory(mapId: string, written: MapSnapshot): Promise<MapSnapshot> {
    try {
      const full = await this.request<MapSnapshot>(`/m/${mapId}?since=0`);
      return full.id === written.id && full.version >= written.version ? full : written;
    } catch { return written; }
  }
  async edit(snapshot: MapSnapshot, operations: EditOperation[]) {
    if (!this.editable) throw new Error('这是只读分享链接，请使用编辑链接打开。');
    if (snapshot.version === 0) snapshot = await this.persist(toMapInput(snapshot));
    const expect = this.identity()!;
    const attempt = this.edits.begin(JSON.stringify(operations), snapshot.version);
    const result = await retryEditConflictOnce(attempt, async ({ baseVersion, requestId }) => {
      const written = await this.request<MapSnapshot>(`/api/maps/${expect.mapId}/edit`, { method: 'POST', body: JSON.stringify({ baseVersion, requestId, operations }) });
      if (!this.current(expect)) throw this.switched();
      return written;
    }, () => this.refreshVersion(expect), randomId);
    this.edits.clear();
    this.activeVersion = result.version;
    return this.withFullHistory(expect.mapId, result);
  }
  async replace(input: MapInput, snapshot: MapSnapshot) {
    if (!this.editable) throw new Error('这是只读分享链接，请使用编辑链接打开。');
    if (snapshot.version === 0) snapshot = await this.persist(toMapInput(snapshot));
    const expect = this.identity()!;
    const { requestId, baseVersion } = this.imports.begin(JSON.stringify(input), snapshot.version);
    let result: MapSnapshot;
    try {
      result = await this.request<MapSnapshot>(`/api/maps/${expect.mapId}/replace`, { method: 'POST', body: JSON.stringify({ baseVersion, requestId, map: input }) });
      if (!this.current(expect)) throw this.switched();
    } catch (error) {
      // Never retried — see `reportReplaceConflict` for why replaying a
      // whole-map write is unsafe where replaying an operations list is not.
      return reportReplaceConflict(error, () => this.refreshVersion(expect), () => this.imports.clear());
    }
    this.imports.clear();
    this.activeVersion = result.version;
    return this.withFullHistory(expect.mapId, result);
  }
  /**
   * Hand this round over.
   *
   * The payload is pinned on the first attempt, so a retry after a lost
   * response replays the same request id and the server de-duplicates instead
   * of committing the round twice; a failing read-back never triggers a second
   * write. Only an explicit conflict drops the record: the map moved on, so
   * the next attempt is written against the version the user now has.
   */
  /**
   * Record that this round reached the conversation — here, that the user
   * copied the message. Kept server-side so the boundary survives a reload, a
   * new tab, or opening the same map somewhere else entirely.
   */
  async recordHandoff(mapId: string, version: number) {
    if (!this.editable || mapId !== this.id) return;
    await this.request(`/api/maps/${mapId}/handoff`, { method: 'POST', body: JSON.stringify({ version }) });
  }
  async submitChanges(snapshot: MapSnapshot, input: { since: number; userMessage?: string }): Promise<HandoffResult> {
    if (!this.editable) throw new Error('这是只读分享链接，请使用编辑链接打开。');
    if (snapshot.version === 0) snapshot = await this.persist(toMapInput(snapshot));
    const expect = this.identity()!;
    const userMessage = input.userMessage?.trim() ?? '';
    const pending = beginSubmit(this.submit, { mapId: expect.mapId, baseVersion: input.since, currentVersion: snapshot.version, userMessage }, randomId);
    this.submit = pending;
    // An intent is an upsert keyed by scope, so a submission that carries one
    // is a real write and must name the version it is written against; the
    // server compares it and rejects a stale attempt instead of silently
    // replacing someone else's intent. A message-only submission carries no
    // intents at all and stays advisory.
    const intents = userMessage ? [{ scope: 'map' as const, text: userMessage, priority: 'prefer' as const }] : [];
    if (pending.message === undefined) {
      const result = await this.request<{ message: string; version: number } & MapSnapshot>(`/api/maps/${pending.mapId}/submit`, {
        method: 'POST', body: JSON.stringify({
          baseVersion: pending.baseVersion, currentVersion: pending.currentVersion,
          ...(userMessage ? { userMessage } : {}), ...(intents.length ? { intents } : {}), requestId: pending.requestId,
        }),
      });
      if (!this.current(expect)) throw this.switched();
      pending.message = result.message;
      // The version the message describes, which a later read may already have
      // moved past.
      pending.version = typeof result.version === 'number' ? result.version : pending.currentVersion;
      this.activeVersion = Math.max(this.activeVersion, pending.version);
    }
    // Keep the record until the round is fully read back: a failure here means
    // the write already happened and must not be repeated, and it must not be
    // reported as a refusal of a round that is already committed.
    let snapshotNow: MapSnapshot;
    try {
      snapshotNow = await this.request<MapSnapshot>(`/m/${pending.mapId}?since=0`);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '读取最新地图失败。');
    }
    if (!this.current(expect) || snapshotNow.id !== expect.mapId) throw this.switched();
    const handoff = { mapId: pending.mapId, version: pending.version ?? pending.currentVersion, message: pending.message };
    this.submit = undefined;
    this.activeVersion = snapshotNow.version;
    return { ...handoff, snapshot: snapshotNow };
  }
  async export(snapshot: MapSnapshot, format: 'json' | 'html') {
    if (format === 'json') { download(JSON.stringify(toMapInput(snapshot), null, 2), `cartula-${snapshot.id}.json`); return; }
    if (snapshot.version === 0) snapshot = await this.persist(toMapInput(snapshot));
    const bearer = this.previewToken ?? this.key;
    const response = await fetch(`/m/${snapshot.id}/export.html`, { credentials: 'same-origin', headers: { 'X-Cartula-Request': '1', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
    if (!response.ok) throw new Error('离线地图生成失败，请重试。');
    download(await response.text(), `cartula-${snapshot.id}.html`, 'text/html');
  }

  private async loadSession() {
    try {
      const session = await this.request<AccountSession>('/api/session', {}, null);
      this.signal.set({ user: session.user ?? null });
      return session.user ?? null;
    } catch { this.signal.set({ user: null }); return null; }
  }
  private async authenticate(kind: 'login' | 'register', input: AuthInput) {
    const problem = authProblem(input, kind === 'register' ? 'register' : 'login');
    if (problem) throw new Error(problem);
    const email = normalizeEmail(input.email);
    const body = kind === 'register' ? { email, password: input.password, passwordConfirm: input.passwordConfirm ?? '' } : { email, password: input.password };
    const session = await this.request<AccountSession>(`/api/auth/${kind}`, { method: 'POST', body: JSON.stringify(body) }, null);
    this.signal.set({ user: session.user ?? null });
    // Signing in can grant more than the key did — or nothing at all; either
    // way the header must stop showing the previous answer, and a map that was
    // refused before the sign-in has to appear now that it is allowed.
    if (!this.id) return;
    const before = this.editable;
    const access = await this.resolveAccess().catch(() => undefined);
    if (access && (this.activeVersion === 0 || access.editable !== before)) await this.reload().catch(() => undefined);
  }
  /**
   * Sign out, and mean it.
   *
   * The cookie was this browser's authority over claimed maps, so a key to a
   * space an account owns is dropped here as well as at claim time: that key is
   * exactly how a sign-out would quietly hand the account's maps to whoever
   * uses the browser next. A key to a space no account has claimed is left
   * alone — it opens maps the account never owned, it is the only copy of that
   * credential this browser has, and forgetting it would not protect anything,
   * it would just lose those maps.
   *
   * What is already on screen is a separate question. A private map loaded
   * under the session is still in memory, and leaving it rendered behind an
   * error would keep showing a map this browser may no longer read.
   */
  private async signOut() {
    await this.request('/api/auth/logout', { method: 'POST', body: '{}' }, null);
    // Whether the *held* key survives depends on whose space it opens; either
    // way it is no longer what this view is authorised by until the server has
    // said so again.
    const held = this.key;
    if (held && this.signal.state().access?.claimed) {
      this.key = undefined; this.guessed = false; this.durable = undefined;
      this.forgetOwnerKey(held);
    }
    // The socket was accepted under the session that has just ended.
    this.liveAck = false; this.ws?.close();
    this.signal.set({ user: null, favorited: false });
    if (!this.id) return;
    try {
      const access = await this.resolveAccess();
      // Still readable without the session — an unclaimed space this browser
      // holds the key to, or a legacy public map. Nothing was revoked.
      if (access) return;
      throw new Error('已退出登录。');
    } catch (error) {
      this.editable = false;
      this.signal.set({ access: undefined });
      const status = errorStatus(error);
      this.onUpdate({
        cleared: 'access-revoked',
        error: status === 401 || status === 403 || status === undefined
          ? '已退出登录。这张地图需要登录后才能查看。'
          : (error as Error).message,
      });
    }
  }
  private async claimSpace(): Promise<ClaimResult> {
    const expect = this.identity();
    if (!expect) throw new Error('这张草稿还没有保存，先保存后才能存到账号。');
    const key = this.key;
    const result = await this.request<ClaimResult>(`/api/maps/${expect.mapId}/claim`, { method: 'POST', body: '{}' }, key ?? null);
    // The account owns the space now, whatever the view has moved on to, so
    // the key leaves this browser's storage either way. Dropping it is the
    // point: it is what makes a later sign-out actually take the maps away
    // again. The key itself keeps working — whoever else holds it, agent
    // included, is unaffected; it is only gone from here.
    this.forgetOwnerKey(key);
    this.forgetMapKey(expect.mapId);
    // The credential *in hand*, though, belongs to whichever map is open now.
    // If that is no longer the map this claim was about, it is another space's
    // key and clearing it would lock the view out of a map it can still edit.
    if (!this.current(expect)) return result;
    this.key = undefined;
    this.guessed = false;
    this.durable = undefined;
    this.replaceUrl(`/map/${expect.mapId}`);
    this.applyAccess(result.access);
    return result;
  }
  /** Everything the account panel and the share dialog are allowed to do here. */
  readonly access: AccessPort = {
    capabilities: () => ({
      account: true, library: true, copy: true, openExternal: true,
      // A share link is the owner's to make; a favorite records someone else's.
      share: this.signal.state().access?.canShare ?? true,
      favorite: Boolean(this.previewToken),
    }),
    state: () => this.signal.state(),
    subscribe: listener => this.signal.subscribe(listener),
    /**
     * The owner key this page is actually holding, for the one surface whose
     * whole purpose is to hand it back to the person who owns it.
     *
     * Three conditions, each sufficient on its own to withhold it. `kind ===
     * 'owner'` is the server's word that a credential governs this map, so a
     * preview token — kept in a separate field and never read here — has no
     * route in. A key that is still only a guess has not been confirmed against
     * this map, and presenting it would label another space's credential as
     * this one's; the guess is normally dropped or confirmed before any of this
     * renders, and this is what makes that ordering not something the panel has
     * to depend on. `spaceId` is what tells a space key from a legacy per-map
     * key, which is a difference in what the key that gets shown can do.
     *
     * Nothing is fetched. When the answer is `undefined` — an account-owned map
     * this browser has no key for, cleared storage — that is the truth, and the
     * caller says so instead of asking the server for a key it must not return.
     */
    ownerKey: () => {
      const access = this.signal.state().access;
      if (!this.key || this.guessed || access?.kind !== 'owner') return undefined;
      return { key: this.key, scope: access.spaceId ? 'space' : 'map' };
    },
    refresh: async () => {
      await this.loadSession();
      if (this.id) await this.resolveAccess().catch(() => undefined);
      return this.signal.state();
    },
    register: input => this.authenticate('register', input),
    login: input => this.authenticate('login', input),
    logout: () => this.signOut(),
    claim: () => this.claimSpace(),
    library: async () => {
      // Both principals at once where both are held: the account's maps and
      // the anonymous space this browser still creates in. A key that turns out
      // not to be one — stale, revoked, from a space since claimed — must not
      // take the account's own library down with it.
      if (!this.key) return this.request<MapLibrary>('/api/maps', {}, null);
      try { return await this.request<MapLibrary>('/api/maps', {}, this.key); }
      catch (error) {
        const status = errorStatus(error);
        if (!this.signal.state().user || !(status === 401 || status === 403)) throw error;
        return this.request<MapLibrary>('/api/maps', {}, null);
      }
    },
    /**
     * Delete one of the maps the library just listed.
     *
     * That list merges two principals — the account's own spaces and the
     * anonymous space this browser still holds a key for — and a row does not
     * record which one it came from. So the account is tried first, which is
     * where a signed-in person's maps are, and the key is the fallback. Sending
     * the key speculatively would be worse than useless: a key that belongs to
     * another space is refused outright rather than ignored, so it would turn a
     * deletable map into a 403.
     */
    deleteMap: async (id: string) => {
      try { await this.request(`/api/maps/${id}`, { method: 'DELETE' }, null); }
      catch (error) {
        const status = errorStatus(error);
        if (!this.key || !(status === 401 || status === 403)) throw error;
        await this.request(`/api/maps/${id}`, { method: 'DELETE' }, this.key);
      }
      // The key this browser remembers for that map id is left alone: it is the
      // space's key, still live and still what opens the map's siblings. What it
      // no longer opens is one map, and that is already true on the server.
      //
      // Nothing this page would do next — poll, reconnect, save — is about a map
      // that still exists, so it does not stay open on one that does not.
      if (id === this.id) location.assign('/app?new=1');
    },
    share: (canWrite?: boolean) => {
      if (!this.id) throw new Error('这张草稿还没有保存，先保存后才能分享。');
      return this.request<PreviewLink>(`/api/maps/${this.id}/preview`, { method: 'POST', body: JSON.stringify({ canWrite: canWrite === true }) }, this.key ?? null);
    },
    listShares: async () => {
      if (!this.id) return [];
      return (await this.request<{ links: ShareLinkInfo[] }>(`/api/maps/${this.id}/preview`, {}, this.key ?? null)).links ?? [];
    },
    revokeShare: async (linkId?: string) => {
      if (!this.id) return;
      const path = linkId ? `/api/maps/${this.id}/preview/${encodeURIComponent(linkId)}` : `/api/maps/${this.id}/preview`;
      await this.request(path, { method: 'DELETE' }, this.key ?? null);
    },
    favorite: async () => {
      // A favorite records a share one was given, so it is authorised by that
      // share — never by an owner key one happens to hold.
      if (!this.id || !this.previewToken) throw new Error('只有通过分享链接打开时才能收藏。');
      const expect = this.identity()!;
      await this.request(`/api/me/favorites/${expect.mapId}`, { method: 'PUT', body: '{}' }, this.previewToken);
      // The favorite is recorded either way; the star belongs to the map it was
      // recorded for, so a late success must not light it up on another one.
      if (this.current(expect)) this.signal.set({ favorited: true });
    },
    unfavorite: async (id: string) => {
      await this.request(`/api/me/favorites/${id}`, { method: 'DELETE' }, null);
      if (id === this.id) this.signal.set({ favorited: false });
    },
    listApiKeys: async () => (await this.request<{ keys: ApiKeyInfo[] }>('/api/me/api-keys', {}, null)).keys,
    createApiKey: (name?: string) => this.request<CreatedApiKey>('/api/me/api-keys', { method: 'POST', body: JSON.stringify(name ? { name } : {}) }, null),
    revokeApiKey: async (id: string) => { await this.request(`/api/me/api-keys/${id}`, { method: 'DELETE' }, null); },
    externalUrl: () => (this.id ? credentialUrl(`${location.origin}/map/${this.id}`, { owner: this.key, previewToken: this.previewToken }) : location.origin),
    openExternal: async (url: string) => { window.open(url, '_blank', 'noopener'); },
  };
  dispose() {
    this.disposed = true;
    if (this.onHashChange && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('hashchange', this.onHashChange);
    clearInterval(this.timer);
    clearTimeout(this.reconnect);
    this.ws?.close();
  }
}
