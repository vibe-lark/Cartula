import { randomId } from '../id.js';
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import type { EditOperation, MapInput, MapSnapshot } from '../../core/types.js';
import type { Adapter, AdapterUpdate, DisplayModeOutcome, HandoffResult } from './types.js';
import { offlineDocument } from './offline.js';
import { toMapInput } from '../../core/model.js';
import { PREFERRED_HEIGHT, PREFERRED_WIDTH, SIZE_DECLARED_EVENT, hostLayout, resolveSizeRequest, sameSizeRequest, type SizeDeclaration, type SizeRequest } from './host-size.js';
import { RELEASE_NAME, RELEASE_VERSION } from '../../core/release.js';
import { classifyMessageError, classifyMessageResult, rejection, type PlanningDelivery } from './delivery.js';
import { IdempotentRequest, beginSubmit, isStaleSnapshot, reportReplaceConflict, retryEditConflictOnce, widensWindow, type PendingSubmit } from './state.js';
import {
  AccessSignal, credentialUrl, parseCredential,
  type AccessPort, type CopyOutcome, type MapAccess, type PreviewLink, type ShareLinkInfo,
} from './access.js';
type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[]; _meta?: Record<string, unknown> };
type CartulaMeta = {
  map?: MapSnapshot; tileUrl?: string; tileAttribution?: string; styleUrl?: string;
  /** Only ever the credentials this caller already holds. */
  editKey?: string; spaceId?: string; spaceKey?: string; previewToken?: string; access?: MapAccess;
};

/**
 * The App surface this adapter uses. Naming it keeps the host injectable, so
 * the races that only appear between a request and its response can be tested
 * without a browser.
 */
export type HostApp = Pick<App,
  | 'getHostContext' | 'getHostCapabilities' | 'connect' | 'callServerTool' | 'sendMessage'
  | 'sendSizeChanged' | 'updateModelContext' | 'requestDisplayMode' | 'downloadFile' | 'openLink' | 'close'
  | 'ontoolresult' | 'ontoolcancelled' | 'onhostcontextchanged' | 'onteardown'>;

/** Which map a pending call was issued against, and in which generation. */
interface MapIdentity { mapId: string; generation: number }

/**
 * The App as it introduces itself to the host.
 *
 * `release` is the build the service stamped into this page, so the version in
 * `ui/initialize` is the one that actually served the frame rather than a
 * constant compiled into the bundle; without a stamp the bundle's own version
 * is still a true answer. See `src/core/release.ts`.
 */
export function defaultHostApp(release = RELEASE_VERSION): HostApp {
  // autoResize is the SDK's own reporter: a ResizeObserver on `body` that sends
  // `ui/notifications/size-changed` with the measured box. It is off here.
  //
  // Not because we need to ask for a wider card: on a *fixed* width axis
  // (Claude Desktop sends `width: 766`) `axisRequest` withholds the width
  // request entirely — a fixed axis is the host's to decide, and the only way
  // past it is `ui/request-display-mode` (the expand entry), not a size
  // notification. On an elastic width axis the SDK would still only report the
  // width it measured, i.e. the frame's own — a number the host already has.
  //
  // The positive reason is the height axis. The SDK's measurement path sets
  // `documentElement.style.height = max-content` before measuring (see
  // docs/host-embedding.md, pitfall 4), which bypasses the CSS ceiling that
  // keeps an embedded card at its negotiated height — re-enabling autoResize
  // reopens the "card as tall as the host's elastic bound" bug. With it off,
  // `--app-height` pins `body` to exactly the extent `resolveSizeRequest`
  // reports, so what autoResize would measure is what declarePreferredSize
  // declares anyway; `tests/e2e/embedding.spec.ts` asserts that pairing across
  // every host shape. Owning the notification here is a formatting choice,
  // not a second opinion.
  return new App({ name: RELEASE_NAME, version: release }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
}

/**
 * Apply a host context to the document.
 *
 * The SDK merges `ui/notifications/host-context-changed` shallowly into the
 * context it hands back from `getHostContext()`, so a partial update (theme
 * only, dimensions only) is already resolved against the previous state by the
 * time this runs. Everything here is therefore driven by the *merged* context,
 * never by the delta.
 */
function applyHostContext(ctx?: McpUiHostContext) {
  if (typeof document === 'undefined') return;
  try {
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  } catch { /* Host theming is optional; layout still applies. */ }
  const root = document.documentElement;
  // The host owns this attribute in embedded mode; browser fullscreen is
  // tracked separately so the two mechanisms are never confused.
  root.dataset.displayMode = ctx?.displayMode ?? 'inline';
  const layout = hostLayout(ctx);
  for (const [name, value] of Object.entries(layout.variables)) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  if (layout.compact) root.dataset.compact = 'true';
  else delete root.dataset.compact;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cartula:host-context-changed', { detail: ctx }));
  }
}

export class McpAdapter implements Adapter {
  mode = 'mcp' as const;
  /**
   * Whether this view may write — the server's answer, not a guess from what
   * this frame is holding.
   *
   * The two are not the same, and the difference is a whole authentication
   * mode: when the MCP client config carries an account API Key, the session is
   * authorised by an HTTP header this frame never sees, and a tool call needs no
   * credential argument at all. `this.key` is empty in exactly that case, so
   * gating the write paths on it made the card render editable — `access.editable`
   * lights the UI — and then refuse every edit as "read-only", which was not
   * true of the map, only of the key drawer. Everything writeable asks this
   * instead; `auth()` still sends whatever credential there is, and the server
   * remains the one deciding.
   */
  editable = false;
  /** Owner credential handed over with the tool result, if there was one. */
  private key?: string;
  /** Whether that credential opens a space or a single legacy map. */
  private keyIsSpace = false;
  /**
   * Share credential. Read-only or editable — only the server knows which, so
   * this is sent on reads and writes alike and withheld only where ownership is
   * required (minting or revoking a share), which no share token ever grants.
   */
  private previewToken?: string;
  private signal = new AccessSignal();
  /** A copy in flight: destination and id are fixed until it is confirmed. */
  private pendingCopy?: { mapId: string; title: string; targetSpaceKey?: string; requestId: string; targetPromise?: Promise<string> };
  private pendingShare?: { mapId: string; canWrite: boolean; requestId: string };
  private snapshot?: MapSnapshot;
  /** The map this view is showing. Everything in flight is bound to it. */
  private mapId?: string;
  /** Bumped whenever the open map changes, so late results can be recognised. */
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  /** The size the host is known to have received. Only a successful send sets it. */
  private lastSize: SizeRequest | null = null;
  private lastMode?: string;
  private sizeFrame?: ReturnType<typeof setTimeout>;
  /** The request a failed declaration has already been retried for, if any. */
  private sizeRetry?: string;
  private edits = new IdempotentRequest(randomId);
  private imports = new IdempotentRequest(randomId);
  private submit?: PendingSubmit;
  private onUpdate: (update: AdapterUpdate) => void = () => {};
  private app: HostApp;
  /**
   * `release` names the build that served this page; it only applies to the
   * default host app, since an injected one introduces itself.
   */
  constructor(app?: HostApp, release?: string) { this.app = app ?? defaultHostApp(release); }
  /** Identity to bind an outgoing call to; undefined before the first map. */
  private identity(): MapIdentity | undefined {
    return !this.disposed && this.mapId ? { mapId: this.mapId, generation: this.generation } : undefined;
  }
  private current(expect: MapIdentity): boolean {
    return !this.disposed && expect.generation === this.generation && expect.mapId === this.mapId;
  }
  /** Turn a failed tool result into the error it states. Never returns. */
  private raise(result: Result, expect?: MapIdentity): never {
    const text = result.content?.find(c => c.type === 'text')?.text ?? '操作失败';
    try {
      const data = JSON.parse(text);
      // Only the map that is still open may be reset and re-read by a conflict.
      if (data.status === 409 && (!expect || this.current(expect))) { this.edits.clear(); this.imports.clear(); void this.refresh(); }
      const message = [data.error, data.hint].filter(Boolean).join(' · ');
      // Only a 4xx is a refusal the server stated: it decided, and nothing
      // was written. A 5xx (or an unrecognised shape) leaves the outcome open.
      const refused = typeof data.status === 'number' && data.status >= 400 && data.status < 500;
      throw Object.assign(refused ? rejection(message) : new Error(message), typeof data.status === 'number' ? { status: data.status } : {});
    } catch (e) { if (e instanceof SyntaxError) throw new Error(text); throw e; }
  }
  /** The payload of a tool that answers with something other than a map. */
  private payload<T>(result: Result): T {
    if (result.isError) this.raise(result);
    if (result.structuredContent) return result.structuredContent as T;
    const text = result.content?.find(c => c.type === 'text')?.text;
    if (text) { try { return JSON.parse(text) as T; } catch { /* not JSON */ } }
    throw new Error('这次操作没有返回结果，请稍后重试。');
  }
  /** Errors first: a failed result never reaches the map state. */
  private parse(result: Result, expect?: MapIdentity): { map: MapSnapshot; context?: CartulaMeta } {
    if (result.isError) this.raise(result, expect);
    const context = result._meta?.cartula as CartulaMeta | undefined;
    const map = context?.map ?? (result.structuredContent?.layers ? result.structuredContent as unknown as MapSnapshot : undefined);
    if (!map?.id || !Array.isArray(map.layers)) throw new Error('宿主没有提供地图数据。请使用工具返回的网页链接继续。');
    return { map, context };
  }
  /** Credential and basemap config belong to the map they arrived with. */
  private applyMeta(context: CartulaMeta | undefined) {
    if (context?.spaceKey) { this.key = context.spaceKey; this.keyIsSpace = true; }
    else if (context?.editKey) { this.key = context.editKey; this.keyIsSpace = false; }
    if (context?.previewToken) this.previewToken = context.previewToken;
    this.editable = context?.access ? context.access.editable : Boolean(this.key);
    if (context?.access) this.signal.set({ access: context.access });
    // Merged, not replaced: the page's bootstrap already put `publicUrl` there,
    // and the image proxy behind every card picture is reached through it.
    if (context?.tileUrl && typeof window !== 'undefined') {
      const holder = window as unknown as { __CARTULA_CONFIG__?: Record<string, unknown> };
      holder.__CARTULA_CONFIG__ = { ...holder.__CARTULA_CONFIG__, tileUrl: context.tileUrl, tileAttribution: context.tileAttribution, styleUrl: context.styleUrl };
    }
  }
  /**
   * The credential arguments for a tool call.
   *
   * A preview token is offered only where a read is enough; owner tools get the
   * owner credential under the name the server issued it with, because a space
   * key and a legacy per-map key are not interchangeable.
   */
  /**
   * The credential to name on a tool call, chosen for what that call will do.
   *
   * `owner` covers minting and revoking shares, which no share token can ever
   * perform — it is left out rather than sent to be refused. `write` may carry
   * one, because an editable share authorises exactly this: changing the map it
   * points at. Which kind this token is stays the server's answer, not a guess
   * made here from its shape.
   */
  private auth(scope: 'read' | 'write' | 'owner' = 'read'): Record<string, string> {
    if (this.key) return this.keyIsSpace ? { spaceKey: this.key } : { editKey: this.key };
    return scope !== 'owner' && this.previewToken ? { previewToken: this.previewToken } : {};
  }
  /** `unlock` clears `previewToken` the moment an owner credential replaces it, so the two never both name this caller. */
  shareCredential() { return this.previewToken ? { previewToken: this.previewToken, canWrite: this.editable } : undefined; }
  /**
   * A result the host pushed at us (`ui/notifications/tool-result`). Only this
   * path may open a different map: everything pending then belongs to the map
   * we just left, so credentials and un-acknowledged writes are dropped.
   */
  private receive(result: Result): MapSnapshot {
    const { map, context } = this.parse(result);
    if (map.id !== this.mapId) {
      this.generation += 1;
      this.mapId = map.id;
      this.key = undefined; this.keyIsSpace = false; this.previewToken = undefined;
      this.editable = false;
      this.signal.set({ access: undefined, favorited: false });
      this.edits.clear(); this.imports.clear(); this.pendingCopy = undefined; this.pendingShare = undefined; this.submit = undefined;
      this.snapshot = map;
    } else if (isStaleSnapshot(this.snapshot, map)) {
      return this.snapshot!;
    } else {
      this.snapshot = map;
    }
    this.applyMeta(context);
    return this.snapshot!;
  }
  /**
   * A response to a call this adapter issued. It is only allowed to touch the
   * state when the map it was issued against is still the one on screen —
   * otherwise it is a late answer about a map the user has already left.
   *
   * `fresh` separates "this result advanced the map" from "this result was
   * older than what we already hold", so a caller does not re-announce a
   * version the view already has.
   */
  private accept(result: Result, expect: MapIdentity): { snapshot: MapSnapshot; fresh: boolean } | undefined {
    const { map, context } = this.parse(result, expect);
    if (!this.current(expect) || map.id !== expect.mapId) return undefined;
    if (isStaleSnapshot(this.snapshot, map)) return { snapshot: this.snapshot!, fresh: false };
    this.snapshot = map;
    this.applyMeta(context);
    return { snapshot: this.snapshot, fresh: true };
  }
  /**
   * A rejection the server stated outright — conflict, unknown version, bad
   * request, no permission. Nothing was written, so the attempt it refused is
   * over; only unknown outcomes (timeouts, transport errors) may be replayed.
   */
  private statedRejection(result: Result): boolean {
    const text = result.content?.find(c => c.type === 'text')?.text;
    if (!text) return false;
    try {
      const status = (JSON.parse(text) as { status?: unknown }).status;
      return typeof status === 'number' && status >= 400 && status < 500;
    } catch { return false; }
  }
  /** The map moved on while this write was in flight. */
  private switched(): Error {
    return new Error('地图已切换，这次操作仍然作用在原来的地图上。请回到那张地图查看结果。');
  }
  async initialize(onUpdate: (update: AdapterUpdate) => void) {
    this.onUpdate = onUpdate;
    this.app.onhostcontextchanged = () => {
      if (this.disposed) return;
      const ctx = this.app.getHostContext();
      applyHostContext(ctx);
      // A mode switch re-does the whole layout, so the previous declaration no
      // longer describes anything: re-declare even if the numbers repeat.
      if (ctx?.displayMode !== this.lastMode) { this.lastMode = ctx?.displayMode; this.forgetSizeDeclaration(); }
      // The host said something new, so a size that failed before is worth one
      // more attempt.
      this.sizeRetry = undefined;
      this.scheduleSize();
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const first = new Promise<MapSnapshot>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('宿主暂未返回地图。请打开工具结果中的网页链接，完整地图可独立使用。')), 15_000);
      this.app.ontoolresult = result => {
        if (this.disposed) return;
        try { const snapshot = this.receive(result as Result); clearTimeout(timeout); onUpdate({ snapshot, connection: 'live' }); resolve(snapshot); } catch (e) { clearTimeout(timeout); reject(e); }
      };
      this.app.ontoolcancelled = () => { clearTimeout(timeout); reject(new Error('地图工具调用已取消。')); };
      this.app.onteardown = async () => {
        this.stop();
        clearTimeout(timeout);
        reject(new Error('地图已关闭。'));
        onUpdate({ closed: true });
        // Keep the transport open for this response. The Host destroys the
        // frame after the acknowledgement; closing here would lose the reply.
        return {};
      };
    });
    // Register every handler before ui/initialize; strict hosts can deliver the tool result immediately.
    try {
      // The layout is settled the moment the handshake returns a context, and
      // it must not wait on the tool result: a host that takes seconds to
      // deliver the map would spend those seconds showing a card sized off
      // nothing, and one that never delivers it would never be told a size at
      // all. Both halves still run — this only stops one from gating the other.
      const connected = this.app.connect(undefined, { timeout: 12_000 }).then(() => {
        const ctx = this.app.getHostContext();
        applyHostContext(ctx);
        this.lastMode = ctx?.displayMode;
        return this.declarePreferredSize();
      });
      const [map] = await Promise.all([first, connected]);
      if (!this.disposed) this.timer = setInterval(() => { void this.refresh(); }, 7000);
      return map;
    } finally { clearTimeout(timeout); }
  }
  /** The layout changed under the declaration: send again, even if it repeats. */
  private forgetSizeDeclaration() { this.lastSize = null; this.sizeRetry = undefined; }
  /** Coalesce bursts of context updates (drag-resize) into one notification. */
  private scheduleSize(delay = 120) {
    if (this.disposed) return;
    clearTimeout(this.sizeFrame);
    this.sizeFrame = setTimeout(() => { void this.declarePreferredSize(); }, delay);
  }
  /**
   * Declare the size this view wants, per axis, and only when the host has not
   * already been told this exact box. Re-sending the same numbers after the
   * host echoes a new context is what turns a negotiation into a resize loop.
   *
   * De-duplication follows what the host actually received, not what was
   * attempted: recording the request before the send meant one failed
   * notification silenced that size forever, and an inline map kept whatever
   * height the host had guessed with no way back. So `lastSize` moves only on
   * success, a failure leaves the same size sendable, and the outcome is
   * returned rather than swallowed — with one automatic retry per distinct
   * request, after which it waits for the host to say something new.
   */
  async declarePreferredSize(preferredHeight = PREFERRED_HEIGHT, preferredWidth = PREFERRED_WIDTH): Promise<SizeDeclaration> {
    const declaration = await this.declare(preferredHeight, preferredWidth);
    // Announced for the diagnostics read-out, which is the only listener and is
    // usually not even in the bundle. Nothing depends on being heard, so the
    // announcement is skipped wherever there is no DOM to hear it — including
    // the partial `window` a unit test stands up to drive this adapter.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(SIZE_DECLARED_EVENT, { detail: declaration }));
    }
    return declaration;
  }
  private async declare(preferredHeight: number, preferredWidth: number): Promise<SizeDeclaration> {
    if (this.disposed) return { status: 'skipped', request: null };
    const request = resolveSizeRequest(this.app.getHostContext(), preferredHeight, preferredWidth);
    if (!request) return { status: 'skipped', request: null };
    if (sameSizeRequest(request, this.lastSize)) return { status: 'unchanged', request };
    try {
      await this.app.sendSizeChanged(request);
      this.lastSize = request;
      this.sizeRetry = undefined;
      return { status: 'sent', request };
    } catch (error) {
      // Nothing was declared, so nothing may be remembered as declared.
      this.lastSize = null;
      const key = JSON.stringify(request);
      if (this.sizeRetry !== key && !this.disposed) { this.sizeRetry = key; this.scheduleSize(1500); }
      const detail = error instanceof Error && error.message ? error.message.slice(0, 200) : undefined;
      return { status: 'failed', request, ...(detail ? { detail } : {}) };
    }
  }
  private async refresh() {
    const expect = this.identity();
    if (!expect || !this.snapshot || this.disposed) return;
    const held = this.snapshot;
    try {
      const result = await this.app.callServerTool({ name: 'get_map_state', arguments: { id: expect.mapId, ...this.auth() } });
      // A poll issued for the previous map must not land on the current one,
      // and a poll that came back behind the view has nothing to announce. A
      // poll at the same version still can: `get_map_state` reads the whole
      // history, so it widens the window a write left narrow — which is what
      // the un-handed-over count is derived from.
      const accepted = this.accept(result as Result, expect);
      if (accepted?.fresh && (accepted.snapshot.version > held.version || widensWindow(held, accepted.snapshot))) this.onUpdate({ snapshot: accepted.snapshot, connection: 'live' });
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
  private async refreshVersion(expect: MapIdentity): Promise<number> {
    const held = this.snapshot;
    const result = await this.app.callServerTool({ name: 'get_map_state', arguments: { id: expect.mapId, ...this.auth() } });
    const accepted = this.accept(result as Result, expect);
    if (!accepted) throw this.switched();
    if (accepted.fresh && held && (accepted.snapshot.version > held.version || widensWindow(held, accepted.snapshot))) this.onUpdate({ snapshot: accepted.snapshot, connection: 'live' });
    return accepted.snapshot.version;
  }
  get editUrl() { return this.snapshot && this.key ? credentialUrl(this.snapshot.url, { owner: this.key }) : undefined; }
  async unlock(credential: string) {
    const expect = this.identity();
    if (!this.snapshot || !expect) return;
    const raw = credential.trim();
    let parsed = parseCredential(raw.startsWith('#') ? raw : '');
    if (/^https?:/.test(raw)) {
      const url = new URL(raw);
      if (`${url.origin}${url.pathname}` !== this.snapshot.url) throw new Error('请输入这张地图的链接。');
      parsed = parseCredential(url.hash);
    } else if (!parsed.owner && !parsed.previewToken) parsed = { owner: raw };
    if (!parsed.owner) throw new Error('这是只读分享链接，不能用来编辑。请向创建地图的 Agent 获取编辑链接。');
    const key = parsed.owner;
    // The server decides what the credential is; a space key and a legacy
    // per-map key are tried under their own names, never guessed by prefix.
    const result = await this.app.callServerTool({ name: 'get_map_state', arguments: { id: expect.mapId, spaceKey: key } }) as Result;
    const usable = result.isError
      ? await this.app.callServerTool({ name: 'get_map_state', arguments: { id: expect.mapId, editKey: key } }) as Result
      : result;
    const wasSpace = !result.isError;
    // Succeeding is not the same as unlocking. `get_map_state` asks for read
    // access, and a share token has that, so a cpt_ token pasted in here comes
    // back clean — and would then be installed as this view's owner credential
    // and announced as an unlock, until the first edit collected a 403 from the
    // server. The server already said what the credential is; that answer
    // decides, exactly as it does in the standalone page.
    //
    // Read from this answer rather than from the adapter afterwards, and read it
    // before anything is applied. `accept` skips `applyMeta` for a snapshot
    // older than the one on screen, so state read after it can belong to the
    // previous call — and a refusal must not be what rewrites the view either:
    // a card that was writeable before the paste is still writeable after it.
    const verdict = this.parse(usable, expect).context?.access;
    if (verdict && !verdict.editable) throw new Error('这个密钥只能查看这张地图，不能编辑。');
    const accepted = this.accept(usable, expect);
    if (!accepted) throw this.switched();
    this.key = key; this.keyIsSpace = wasSpace; this.previewToken = undefined; this.editable = true;
    this.onUpdate({ snapshot: accepted.snapshot });
  }
  /**
   * Hand the message to the host conversation and report what is actually
   * known. A timeout is `unknown`, never "not sent": the host may have taken
   * it, so the view must not resend on its own.
   */
  async sendPlanningMessage(text: string): Promise<PlanningDelivery> {
    if (!this.app.getHostCapabilities()?.message) return { status: 'unsupported' };
    try {
      return classifyMessageResult(await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }, { timeout: 12_000 }));
    } catch (error) { return classifyMessageError(error); }
  }
  /**
   * Hand this round to the agent.
   *
   * The submission is pinned on the first attempt: base version, the version it
   * is written against, the user's message and a request id minted for that
   * attempt. A retry replays exactly that, so a write whose response was lost —
   * and which background polling has already surfaced as a new version — is
   * de-duplicated server-side instead of committing the round a second time.
   * Once the write is known to have landed, a retry only re-reads. An explicit
   * conflict is the one outcome that drops the record: the submitted intents
   * are an upsert, so a rejected attempt must be rebuilt against the version
   * the user actually has instead of being replayed.
   */
  async submitChanges(snapshot: MapSnapshot, input: { since: number; userMessage?: string }): Promise<HandoffResult> {
    const expect = this.identity();
    if (!expect || snapshot.id !== expect.mapId) throw this.switched();
    if (!this.editable) throw new Error('这是只读地图，无法提交修改。');
    const userMessage = input.userMessage?.trim() ?? '';
    const pending = beginSubmit(this.submit, { mapId: snapshot.id, baseVersion: input.since, currentVersion: snapshot.version, userMessage }, randomId);
    this.submit = pending;
    // Same contract as the REST path: an intent is an upsert, so it travels
    // with the version it is written against and a stale attempt is rejected.
    const intents = userMessage ? [{ scope: 'map' as const, text: userMessage, priority: 'prefer' as const }] : [];
    if (pending.message === undefined) {
      const result = await this.app.callServerTool({ name: 'submit_changes', arguments: {
        id: pending.mapId, ...this.auth('write'), baseVersion: pending.baseVersion, currentVersion: pending.currentVersion,
        ...(userMessage ? { userMessage } : {}), ...(intents.length ? { intents } : {}), requestId: pending.requestId,
      } }) as Result;
      // Identity first: a late answer for a map the view has left may not
      // touch the error, message or pending state of the map it is on now.
      if (!this.current(expect)) throw this.switched();
      if (result.isError) {
        if (this.statedRejection(result)) this.submit = undefined;
        this.parse(result, expect);
      }
      pending.message = result.structuredContent && 'message' in result.structuredContent ? String(result.structuredContent.message) : result.content?.find(c => c.type === 'text')?.text ?? '';
      // The version this message describes. Without one, stay on the version
      // the attempt was written against: a cursor that lags is recoverable,
      // one that runs ahead silently drops somebody's changes.
      const reported = result.structuredContent && typeof result.structuredContent.version === 'number' ? result.structuredContent.version : undefined;
      pending.version = reported ?? pending.currentVersion;
    }
    // A failure from here on leaves the record in place: the write already
    // happened, so a retry must re-read rather than submit again — and the
    // failure is reported as an unknown outcome, never as a refusal of a round
    // that is already committed.
    let refreshed: { snapshot: MapSnapshot; fresh: boolean } | undefined;
    try {
      refreshed = this.accept(await this.app.callServerTool({ name: 'get_map_state', arguments: { id: pending.mapId, ...this.auth() } }) as Result, expect);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '读取最新地图失败。');
    }
    if (!refreshed) throw this.switched();
    const handoff = { mapId: pending.mapId, version: pending.version ?? pending.currentVersion, message: pending.message };
    this.submit = undefined;
    await this.notify(refreshed.snapshot);
    // Awaiting the host is another window for it to open a different map. A
    // result handed back now would be about a map the user has left — the view
    // would flip back to it, and its message would go into the conversation.
    if (!this.current(expect)) throw this.switched();
    return { ...handoff, snapshot: refreshed.snapshot };
  }
  /**
   * Report a confirmed hand-off, so the boundary outlives this frame.
   *
   * An App in a sandboxed frame has an opaque origin and no storage at all, so
   * the server is the only place this can be read back from. It is not part of
   * the hand-off itself — the round is already in the conversation — so a
   * failure is reported to the caller and changes nothing else; the in-memory
   * cursor still holds for this session.
   */
  async recordHandoff(mapId: string, version: number) {
    // Silent when it cannot apply, which is why the condition matters more here
    // than where an error would have been raised: gated on `this.key`, an
    // account-authorised session recorded no boundary at all and quietly
    // re-offered the same round after every reload.
    if (!this.editable || mapId !== this.mapId) return;
    const result = await this.app.callServerTool({ name: 'record_handoff', arguments: { id: mapId, version, ...this.auth('write') } }) as Result;
    if (result.isError) this.raise(result);
  }
  private async notify(snapshot: MapSnapshot) {
    try { await this.app.updateModelContext({ content: [{ type: 'text', text: `Cartula「${snapshot.title}」已保存至 v${snapshot.version}。等待用户通过「继续规划」提交本轮修改后再处理。` }], structuredContent: { id: snapshot.id, version: snapshot.version } }); }
    catch { /* Saving does not depend on host context support. Explicit submission offers copy fallback. */ }
  }
  async edit(snapshot: MapSnapshot, operations: EditOperation[]) {
    const expect = this.identity();
    if (!expect || snapshot.id !== expect.mapId) throw this.switched();
    if (!this.editable) throw new Error('这是只读地图，打开时需提供编辑密钥。');
    const attempt = this.edits.begin(JSON.stringify(operations), snapshot.version);
    const updated = await retryEditConflictOnce(attempt, async ({ baseVersion, requestId }) => {
      const result = await this.app.callServerTool({ name: 'edit_map', arguments: { id: expect.mapId, ...this.auth('write'), baseVersion, requestId, operations } });
      const accepted = this.accept(result as Result, expect);
      if (!accepted) throw this.switched();
      return accepted.snapshot;
    }, () => this.refreshVersion(expect), randomId);
    this.edits.clear();
    await this.notify(updated);
    if (!this.current(expect)) throw this.switched();
    return updated;
  }
  async replace(input: MapInput, snapshot: MapSnapshot) {
    const expect = this.identity();
    if (!expect || snapshot.id !== expect.mapId) throw this.switched();
    if (!this.editable) throw new Error('这是只读地图，无法修改。');
    const { requestId, baseVersion } = this.imports.begin(JSON.stringify(input), snapshot.version);
    let updated: MapSnapshot;
    try {
      const result = await this.app.callServerTool({ name: 'replace_map', arguments: { id: expect.mapId, map: input, ...this.auth('write'), baseVersion, requestId } });
      const accepted = this.accept(result as Result, expect);
      if (!accepted) throw this.switched();
      updated = accepted.snapshot;
    } catch (error) {
      // Never retried — see `reportReplaceConflict` for why replaying a
      // whole-map write is unsafe where replaying an operations list is not.
      return reportReplaceConflict(error, () => this.refreshVersion(expect), () => this.imports.clear());
    }
    this.imports.clear();
    await this.notify(updated);
    if (!this.current(expect)) throw this.switched();
    return updated;
  }
  async export(snapshot: MapSnapshot, format: 'json' | 'html') {
    if (!this.app.getHostCapabilities()?.downloadFile) throw new Error('此宿主不支持文件下载。请打开地图网页后导出。');
    const result = await this.app.downloadFile({ contents: [{ type: 'resource', resource: {
      uri: `file:///cartula-${snapshot.id}.${format}`, mimeType: format === 'json' ? 'application/json' : 'text/html',
      text: format === 'json' ? JSON.stringify(toMapInput(snapshot), null, 2) : offlineDocument(snapshot),
    } }] });
    if (result.isError) throw new Error('下载已取消，可在地图网页中重新导出。');
  }
  /**
   * Ask the host for a display mode and report the mode it actually returned.
   * The host may answer with a different mode than requested; the UI follows
   * that answer instead of assuming the request succeeded.
   */
  /** What the host says it can grant right now; see `Adapter`. */
  availableDisplayModes(): readonly string[] | undefined {
    return this.app.getHostContext()?.availableDisplayModes;
  }
  async requestDisplayMode(mode: 'inline' | 'fullscreen' | 'pip'): Promise<DisplayModeOutcome> {
    const ctx = this.app.getHostContext();
    const current = (ctx?.displayMode ?? 'inline') as DisplayModeOutcome['mode'];
    if (ctx?.availableDisplayModes && !ctx.availableDisplayModes.includes(mode)) return { mode: current, status: 'unsupported' };
    try {
      const result = await this.app.requestDisplayMode({ mode });
      applyHostContext(this.app.getHostContext());
      const actual = result.mode as DisplayModeOutcome['mode'];
      if (actual === 'inline') { this.forgetSizeDeclaration(); void this.declarePreferredSize(); }
      return { mode: actual, status: actual === mode ? 'granted' : 'denied' };
    } catch (error) {
      return { mode: current, status: 'error', ...(error instanceof Error && error.message ? { detail: error.message.slice(0, 200) } : {}) };
    }
  }
  /**
   * What an embedded view may do about access.
   *
   * No password ever reaches this frame and no session cookie is relied on
   * across it: signing in happens on the standalone page, which the host opens
   * with the credentials this view already holds. Sharing and copying are
   * ordinary tool calls, so they stay inside the permissions the tool arguments
   * carry.
   */
  readonly access: AccessPort = {
    capabilities: () => ({
      account: false, library: false, favorite: false, copy: true,
      share: this.signal.state().access?.canShare ?? Boolean(this.key),
      openExternal: Boolean(this.app.getHostCapabilities()?.openLinks),
    }),
    state: () => this.signal.state(),
    subscribe: listener => this.signal.subscribe(listener),
    refresh: async () => this.signal.state(),
    share: async (canWrite?: boolean) => {
      const expect = this.identity();
      if (!expect) throw new Error('这张地图还没有准备好，请稍后重试。');
      const writable = canWrite === true;
      if (this.pendingShare?.mapId !== expect.mapId || this.pendingShare?.canWrite !== writable) this.pendingShare = undefined;
      const attempt = this.pendingShare ??= { mapId: expect.mapId, canWrite: writable, requestId: randomId() };
      const result = await this.app.callServerTool({ name: 'share_map', arguments: { id: attempt.mapId, ...this.auth('owner'), canWrite: attempt.canWrite, requestId: attempt.requestId } }) as Result;
      if (!this.current(expect)) throw this.switched();
      if (result.isError && this.statedRejection(result) && this.pendingShare === attempt) this.pendingShare = undefined;
      const link = this.payload<PreviewLink>(result);
      if (this.pendingShare === attempt) this.pendingShare = undefined;
      return link;
    },
    listShares: async () => {
      const expect = this.identity();
      if (!expect) return [];
      const result = await this.app.callServerTool({ name: 'share_map', arguments: { id: expect.mapId, ...this.auth('owner'), list: true } }) as Result;
      return this.payload<{ links?: ShareLinkInfo[] }>(result).links ?? [];
    },
    revokeShare: async (linkId?: string) => {
      const expect = this.identity();
      if (!expect) return;
      const scope = linkId ? { revokeId: linkId } : { revoke: true };
      this.payload<{ ok: boolean }>(await this.app.callServerTool({ name: 'share_map', arguments: { id: expect.mapId, ...this.auth('owner'), ...scope } }) as Result);
    },
    copy: async (): Promise<CopyOutcome> => {
      const expect = this.identity();
      if (!expect || !this.snapshot) throw new Error('这张地图还没有准备好，请稍后重试。');
      const title = `${this.snapshot.title.slice(0, 115)} · 副本`;
      // A Host account may supply the destination without exposing its key.
      // Anonymous callers get an explicit refusal before anything is copied;
      // only then acquire a destination and keep it for every retry.
      if (this.pendingCopy && this.pendingCopy.mapId !== expect.mapId) this.pendingCopy = undefined;
      const state = this.signal.state().access;
      const target = this.keyIsSpace && state?.kind === 'owner' && !state.claimed ? this.key : undefined;
      this.pendingCopy ??= { mapId: expect.mapId, title, ...(target ? { targetSpaceKey: target } : {}), requestId: randomId() };
      const attempt = this.pendingCopy;
      const sourceAuth = this.auth();
      const send = () => this.app.callServerTool({ name: 'copy_map', arguments: {
        id: attempt.mapId, ...sourceAuth, title: attempt.title, requestId: attempt.requestId,
        ...(attempt.targetSpaceKey ? { targetSpaceKey: attempt.targetSpaceKey } : {}),
      } }) as Promise<Result>;
      let result = await send();
      if (!this.current(expect)) throw this.switched();
      let needsTarget = false;
      if (result.isError) {
        try { needsTarget = JSON.parse(result.content?.find(c => c.type === 'text')?.text ?? '{}').code === 'COPY_TARGET_REQUIRED'; } catch { /* ordinary tool failure */ }
      }
      if (needsTarget) {
        if (!attempt.targetSpaceKey) {
          attempt.targetPromise ??= (async () => {
            const space = this.payload<{ spaceKey: string }>(await this.app.callServerTool({ name: 'create_space', arguments: {} }) as Result);
            if (!space.spaceKey) throw new Error('没有拿到副本空间，请重试。');
            return space.spaceKey;
          })().catch(error => { attempt.targetPromise = undefined; throw error; });
          attempt.targetSpaceKey = await attempt.targetPromise;
        }
        if (!this.current(expect)) throw this.switched();
        result = await send();
        if (!this.current(expect)) throw this.switched();
      }
      // A refusal the server stated outright wrote nothing, so this attempt is
      // over and replaying it would only be refused again. Only an unknown
      // outcome keeps the record for an identical retry.
      if (result.isError && this.statedRejection(result) && this.pendingCopy === attempt) this.pendingCopy = undefined;
      const copy = this.payload<{ id?: string; title?: string; url?: string; spaceKey?: string; editKey?: string }>(result);
      const meta = result._meta?.cartula as CartulaMeta | undefined;
      // The copy exists either way; without an address there is nothing to
      // hand over, and saying so beats offering a broken link.
      const id = copy.id ?? meta?.map?.id;
      const url = copy.url ?? meta?.map?.url;
      if (!id || !url) throw new Error('副本已经创建，但没有拿到它的地址。请在地图网页的「我的地图」里打开。');
      if (this.pendingCopy === attempt) this.pendingCopy = undefined;
      const owner = meta?.spaceKey ?? copy.spaceKey ?? meta?.editKey ?? copy.editKey ?? attempt.targetSpaceKey;
      return { id, title: copy.title ?? meta?.map?.title ?? title, url, editUrl: credentialUrl(url, { owner }) };
    },
    externalUrl: () => (this.snapshot ? credentialUrl(this.snapshot.url, { owner: this.key, previewToken: this.previewToken }) : undefined),
    openExternal: async (url: string) => {
      if (!this.app.getHostCapabilities()?.openLinks) throw new Error('当前宿主不能打开链接，请手动复制网址。');
      const result = await this.app.openLink({ url });
      if (result?.isError) throw new Error('宿主没有打开这个链接，请手动复制网址。');
    },
  };
  private stop() { this.disposed = true; clearInterval(this.timer); clearTimeout(this.sizeFrame); }
  dispose() { this.stop(); void this.app.close(); }
}
