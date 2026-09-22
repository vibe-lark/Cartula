import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MapWorkspace from './components/MapWorkspace.js';
import Landing from './components/Landing.js';
import { BrowserAdapter } from './adapters/browser.js';
import { OfflineAdapter } from './adapters/offline.js';
import { McpAdapter } from './adapters/mcp.js';
import { DISPLAY_MODE_EVENT, type Adapter, type Connection, type DisplayModeAttempt, type DisplayModeOutcome } from './adapters/types.js';
import { latestOf } from './adapters/state.js';
import type { MapSnapshot, Suggestion } from '../core/types.js';
import './styles.css';
import { planningMessage, roundSummary } from './handoff.js';
import { HandoffCursor, browserCursorStorages, handoffFloor } from './handoff-cursor.js';
import { AccessDialog } from './components/CollaborationDialogs.js';
import { AccountPanel, ClaimDialog, CopyDialog, ShareDialog } from './components/AccountPanel.js';
import type { AccessState, CopyOutcome } from './adapters/access.js';
import type { PlanningDelivery } from './adapters/delivery.js';
import { configureMapWorker } from './worker.js';
import { mountSizeDiagnostics } from './adapters/diagnostics.js';
import { installHostLinks } from './adapters/host-links.js';
import { Modal } from './components/Modal.js';
import { CopyField } from './components/CopyField.js';

configureMapWorker();

const boot = JSON.parse(document.getElementById('cartula-bootstrap')?.textContent ?? '{}') as { mode?: 'mcp' | 'offline'; publicUrl?: string; snapshot?: MapSnapshot; tileUrl?: string; tileAttribution?: string; styleUrl?: string; release?: string; diagnostics?: boolean };
if (boot.tileUrl || boot.publicUrl) (window as unknown as { __CARTULA_CONFIG__: unknown }).__CARTULA_CONFIG__ = { tileUrl: boot.tileUrl, tileAttribution: boot.tileAttribution, styleUrl: boot.styleUrl, publicUrl: boot.publicUrl };
// Being embedded is known from the page itself, so it is declared here rather
// than waited for. The height ceiling in styles.css hangs off `data-embedded`,
// and a host that sizes the card by measuring the document must not see an
// uncapped layout in the window before the handshake lands — or at all, if the
// handshake never lands. Keying it to the bootstrap rather than to a display
// mode also means a host that sends an unexpected mode, or none, still gets a
// card of the right height.
//
// `inline` is set alongside it as the spec's default display mode, which the
// host replaces in `ui/initialize` if it grants another one; the dense embedded
// arrangement keys off that. MapWorkspace still falls back to `standalone`
// when there is no host at all.
if (boot.mode === 'mcp') {
  document.documentElement.dataset.embedded = 'true';
  document.documentElement.dataset.displayMode = 'inline';
  // Deployment-gated read-out of the size negotiation, for diagnosing a card
  // inside a host we cannot attach a debugger to. See adapters/diagnostics.ts.
  //
  // Imported statically, not on demand. The bundle is one inlined file, so a
  // dynamic import costs nothing to load — but it is one more thing that has to
  // work for the read-out to appear, and the read-out exists precisely for the
  // case where we cannot tell what is failing. A diagnostic with its own
  // failure mode is worth less than the two kilobytes it saves.
  if (boot.diagnostics) mountSizeDiagnostics();
}
function Application() {
  // `boot.release` is the build that served this page: the App declares it back
  // to the host, so both sides of the handshake name one build.
  const adapter = useMemo<Adapter>(() => boot.mode === 'offline' && boot.snapshot ? new OfflineAdapter(boot.snapshot) : boot.mode === 'mcp' ? new McpAdapter(undefined, boot.release) : new BrowserAdapter(), []);
  const [snapshot, setSnapshot] = useState<MapSnapshot>();
  const [closed, setClosed] = useState(false);
  const [linkFailure, setLinkFailure] = useState<{ url: string; message: string } | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [share, setShare] = useState(false);
  const [access, setAccess] = useState(false);
  const [notice, setNotice] = useState<{ text: string; href?: string; label?: string } | null>(null);
  const port = adapter.access;
  // Access lives on the adapter — a tool result or a sign-in can change it
  // without React knowing — so the view follows it rather than caching it.
  const [accessState, setAccessState] = useState<AccessState>(() => port?.state() ?? {});
  const [account, setAccount] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [copy, setCopy] = useState<CopyOutcome | null>(null);
  /** What to finish once signing in is done, when it turned out to be needed. */
  const [afterSignIn, setAfterSignIn] = useState<'favorite' | 'claim' | null>(null);
  /**
   * Whether the account panel was opened from a page that had no map at all.
   *
   * The entry there is labelled 登录, so it opens the sign-in form directly and
   * closes itself once the map it was blocking arrives. Remembering *how* the
   * panel was opened keeps both halves of that from depending on whether the
   * map has loaded yet, which is decided asynchronously.
   */
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (!port) return;
    setAccessState(port.state());
    return port.subscribe(setAccessState);
  }, [port]);
  /**
   * Whether a bigger canvas is reachable from inside this frame at all.
   *
   * Both routes are checked before the entry is drawn, because both can be
   * closed and the only way the user finds out is by pressing something that
   * does nothing. That is what Claude Desktop 1.49585.0 does: it declares
   * `availableDisplayModes: ["inline"]` *and* renders the App in a sandboxed
   * iframe without `allow="fullscreen"`, so `document.fullscreenEnabled` is
   * false as well. With no way to grow in place, the honest thing is to offer
   * the standalone page rather than a button that cannot work.
   *
   * A host that declared nothing has not ruled fullscreen out — asking is how
   * that gets settled, and hosts that say nothing do grant it — so the entry
   * stays. Only an explicit list without `fullscreen` closes the host route.
   */
  const [expandable, setExpandable] = useState(true);
  useEffect(() => {
    const sync = () => {
      const browserFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
      const modes = adapter.availableDisplayModes?.();
      setExpandable(!adapter.requestDisplayMode ? browserFullscreen : !modes || modes.includes('fullscreen') || browserFullscreen);
    };
    // `availableDisplayModes` arrives with the host context and can change.
    sync();
    window.addEventListener('cartula:host-context-changed', sync);
    return () => window.removeEventListener('cartula:host-context-changed', sync);
  }, [adapter]);
  /**
   * Access surfaces belong to the map that opened them.
   *
   * A host can swap the map, and a copy switches to one on purpose. A share
   * dialog holding the previous map's link, or a claim about the space it was
   * in, would then be acting on something that is no longer on screen. Saving a
   * draft is not such a switch — the id changes, but it is the same map, and
   * sharing a draft is precisely the flow that saves it first. The copy dialog
   * is deliberately not reset either: it is about the map that just arrived.
   */
  const openId = snapshot?.id;
  const previousId = useRef<string>(undefined);
  useEffect(() => {
    const left = previousId.current;
    previousId.current = openId;
    if (!left || !openId || left === openId || left === 'draft') return;
    setShare(false); setClaiming(false); setAccess(false);
    setAccount(false); setAfterSignIn(null); setNotice(null);
  }, [openId]);
  /**
   * The "already handed over" boundary, per map, kept across reloads.
   *
   * Every mode uses it, not only the standalone page: an embedded App is
   * reloaded by things the user never did — a host re-rendering its widget, a
   * frame restored after a navigation — and a cursor that started again at 0
   * offered the whole change log as this round and handed it over twice. See
   * `handoff-cursor.ts` for why it moves forward only.
   */
  const cursor = useMemo(() => new HandoffCursor(browserCursorStorages()), []);
  /** Re-render when the boundary moves, so the pending count follows it. */
  const [handedOff, setHandedOff] = useState(0);
  /** What is on screen right now, readable from async callbacks. */
  const openMap = useRef<MapSnapshot>(undefined);
  // Follows the rendered map, except that a map the adapter has already handed
  // over must not be un-seen by a render that has not caught up with it yet.
  if (snapshot || !openMap.current) openMap.current = snapshot;
  useEffect(() => {
    if (adapter.mode !== 'mcp' || closed) return;
    return installHostLinks({
      baseUrl: () => openMap.current?.url ?? boot.publicUrl,
      open: async url => {
        if (!port?.openExternal) throw new Error('当前宿主不能打开链接，请复制地址。');
        await port.openExternal(url);
      },
      onError: (url, message) => setLinkFailure({ url, message }),
    });
  }, [adapter, port, closed]);
  /**
   * Where this map's next hand-off starts.
   *
   * Two sources, the higher wins. `map.handoffVersion` is this map's server
   * record of a delivery the view confirmed — the one that survives a frame
   * with no storage at all. The local cursor can be ahead of it for a moment,
   * when the delivery was confirmed but the acknowledgement has not landed yet.
   *
   * Neither the Agent's write cursor nor a `draft.commit` in the history is
   * used: a submission is not a delivery, and an Agent version after one does
   * not prove the message arrived. Guessing there would drop user changes; a
   * round offered twice is the recoverable failure.
   */
  function submittedVersion(map: MapSnapshot) {
    return cursor.read(map.id, map.version, handoffFloor(map));
  }
  const since = snapshot ? submittedVersion(snapshot) : 0;
  /**
   * How much has been changed since the last confirmed hand-off — the same
   * window 继续规划 would describe, so the entry that opens it can say what it
   * is about instead of leaving it to be discovered inside a menu.
   *
   * Declared here, above the loading branch: a hook that only runs once a map
   * has arrived is not a hook. `handedOff` is a dependency on purpose — the
   * boundary lives outside React, and that counter is what says it moved.
   */
  const pendingChanges = useMemo(() => (snapshot ? roundSummary(snapshot, since).length : 0), [snapshot, since, handedOff]);
  /**
   * Record a confirmed hand-off, and let the view follow the new boundary.
   *
   * The server copy is what a reopened frame reads back, so it is written here
   * too — best effort, because the round is already in the conversation and a
   * failed acknowledgement must not be reported as a failed hand-off. Losing it
   * costs a repeated round, never a dropped one.
   */
  function markSubmitted(id: string, version: number) {
    cursor.mark(id, version);
    setHandedOff(n => n + 1);
    void adapter.recordHandoff?.(id, version).catch(() => undefined);
  }
  useEffect(() => {
    let active = true;
    adapter.initialize(update => {
      if (!active) return;
      if (update.closed) { flushSync(() => setClosed(true)); return; }
      // A map arriving where there was none answers whatever refusal is on
      // screen — signing in or pasting a link is how it got here.
      if (update.snapshot && !openMap.current) setError('');
      if (update.snapshot) setSnapshot(old => !old || old.id !== update.snapshot!.id || old.version <= update.snapshot!.version ? update.snapshot : old);
      // Readable before React re-renders. A sign-in that recovers a refused
      // page finishes inside the same await that delivered this map, and has
      // to know the map arrived without waiting for the render that shows it.
      if (update.snapshot) openMap.current = update.snapshot;
      // Permission was withdrawn, not merely a read that failed: the copy in
      // memory goes with it, or signing out would leave the map on screen
      // behind a message saying it may no longer be read. Dropping the
      // snapshot returns the page to its own recovery view — the one with the
      // sign-in entry — rather than a workspace nobody is allowed to see.
      if (update.cleared === 'access-revoked') { setSnapshot(undefined); openMap.current = undefined; }
      if (update.connection) setConnection(update.connection);
      if (update.error) setError(update.error);
      if (update.suggestion) setSuggestion(update.suggestion);
      // The initialize promise resolves with the first map. By then the host
      // may already have pushed a newer version, or a different map entirely.
    }).then(map => { if (active) setSnapshot(old => old ?? map); }).catch(e => { if (active) setError(e instanceof Error ? e.message : '地图加载失败'); });
    return () => { active = false; adapter.dispose(); };
  }, [adapter]);
  /**
   * Run a write and apply its result.
   *
   * A result for a map the view has left is dropped: the host can open another
   * map while a write is in flight, and letting that answer through would flip
   * the workspace back to the map the user is no longer on. `switchesMap` is
   * for the one action that changes the map on purpose — forking a copy.
   */
  async function mutate(action: () => Promise<MapSnapshot>, options: { switchesMap?: boolean } = {}) {
    const from = openMap.current?.id;
    setBusy(true); setError('');
    try {
      const result = await action();
      if (!options.switchesMap && openMap.current && openMap.current.id !== result.id) return;
      // Keep async handlers (notably the hand-off dialog) on the same version
      // before React commits the next render.
      openMap.current = result;
      setSnapshot(old => !old || old.id !== result.id || result.version >= old.version ? result : old);
      if (options.switchesMap) openMap.current = result;
    }
    catch (e) { if (!from || openMap.current?.id === from) setError(e instanceof Error ? e.message : '保存失败'); throw e; }
    finally { setBusy(false); }
  }
  const capabilities = port?.capabilities();
  /** Copying is one action with two shapes: switch to the copy, or point at it. */
  const canCopy = Boolean(adapter.fork || port?.copy);
  /**
   * Whether saving this space to an account is on the table. Being signed out
   * is not a reason to hide it — signing in is the first half of the action —
   * so an unclaimed space one owns is enough.
   */
  const canSave = Boolean(port?.claim && accessState.access && !accessState.access.claimed
    && (accessState.access.canClaim || accessState.access.kind === 'owner'));
  /**
   * Arrived here on a link someone else minted, read-only or editable.
   *
   * Favoriting is offered on both: a collaborator given an editable link has
   * the same problem a reader does — the map is not in their own space, so the
   * link is the only way back to it.
   */
  const arrivedOnAShare = accessState.access?.kind === 'preview' || accessState.access?.kind === 'shared-edit';
  async function makeCopy() {
    if (adapter.fork && snapshot) { await mutate(() => adapter.fork!(snapshot), { switchesMap: true }); return; }
    if (!port?.copy) throw new Error('这里不能创建副本，请打开地图网页。');
    setCopy(await port.copy());
  }
  async function addFavorite() {
    if (!port?.favorite) return;
    // Asked of the adapter, not of React: this runs immediately after a sign-in
    // resolves, before the re-render that would show it.
    // Signing in is part of favoriting, not a detour, so the panel comes back
    // to this action instead of leaving the user to find it again.
    if (!port.state().user) { setAfterSignIn('favorite'); setAccount(true); return; }
    try { await port.favorite(); } catch (e) { setError((e as Error).message); }
  }
  function resume() {
    const next = afterSignIn;
    setAfterSignIn(null);
    if (next === 'favorite') { setAccount(false); void addFavorite(); }
    if (next === 'claim') { setAccount(false); setClaiming(true); }
    // Signing in on a page that was refused *was* the action: what the user
    // came for is the map, so the panel gets out of its way once it is there.
    // Both halves are read here rather than inferred from the render — the
    // adapter delivers the recovered map inside the same await that resolved
    // this sign-in, and sets `openMap` synchronously as it does. If the map
    // did not come back (signed into the wrong account, say), the panel stays
    // open over the refusal instead of closing onto a dead end.
    if (!next && recovering && openMap.current) { setAccount(false); setRecovering(false); }
  }
  /**
   * Everything that opens on top of the map. It is rendered even before the
   * first map arrives: a page that was refused needs the way back — signing in,
   * or opening the link that carries the key — right there on the error.
   */
  if (closed) return null;
  const overlays = <>
    {linkFailure && <Modal title="打开链接" onClose={() => setLinkFailure(null)}>
      <p role="alert" className="form-error">{linkFailure.message}</p>
      <CopyField label="链接地址" value={linkFailure.url}/>
    </Modal>}
    {account && port && <AccountPanel port={port} state={accessState} onClose={() => { setAccount(false); setAfterSignIn(null); setRecovering(false); }}
      pending={afterSignIn === 'favorite' ? '登录后会继续收藏这张地图。' : afterSignIn === 'claim' ? '登录后会继续把这个空间保存到账号。' : undefined}
      // The entry that led here said 登录, so clicking it must be the sign-in
      // itself, not another menu offering it.
      initial={recovering ? 'login' : undefined}
      onResume={resume}/>}
    {claiming && port && <ClaimDialog port={port} state={accessState} onClose={() => setClaiming(false)} onClaimed={result => {
      setClaiming(false);
      setNotice({ text: result.claimedMapCount > 1 ? `已把 ${result.claimedMapCount} 张地图保存到账号。原来的链接仍然有效。` : '已保存到账号。原来的链接仍然有效。' });
    }}/>}
    {share && port && snapshot && <ShareDialog port={port} mapId={snapshot.id} onClose={() => setShare(false)}/>}
    {copy && <CopyDialog title={copy.title} url={copy.editUrl} onClose={() => setCopy(null)}
      onOpen={port?.openExternal ? () => { void port.openExternal!(copy.editUrl).catch(e => setError((e as Error).message)); } : undefined}/>}
    {access && <AccessDialog onClose={() => setAccess(false)} onUnlock={async value => {
      if (!adapter.unlock) throw new Error('此模式不支持编辑链接。'); await adapter.unlock(value);
    }}/>}
  </>;

  if (!snapshot) return <div className="app-loading" style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', gap: 12, fontFamily: 'system-ui', background: '#f5f6f1', color: '#164d43', padding: 32 }}>
    <h1>Cartula</h1>
    <p role={error ? 'alert' : 'status'}>{error || '正在展开地图…'}</p>
    {error && <div className="form-actions">
      {capabilities?.account && <button className="button primary" onClick={() => { setRecovering(true); setAccount(true); }}>登录</button>}
      {adapter.unlock && <button className="button" onClick={() => setAccess(true)}>用链接打开</button>}
      <a className="button quiet" href="/">返回首页</a>
    </div>}
    {overlays}
  </div>;
  const standalone = adapter.mode === 'browser' ? '' : adapter.editUrl || snapshot.url;
  /**
   * Expand and report what actually happened. A host display mode and the
   * browser Fullscreen API are different mechanisms: neither proves the other
   * succeeded, so both are attempted in order and every failure is visible,
   * with the standalone page as the always-available large canvas.
   */
  async function expand() {
    setNotice(null);
    const outcome: DisplayModeOutcome | undefined = adapter.requestDisplayMode
      ? await adapter.requestDisplayMode('fullscreen').catch((): DisplayModeOutcome => ({ mode: 'inline', status: 'error' }))
      : undefined;
    // Announced for the diagnostics read-out only. Every exit announces, so a
    // silent button can be told apart from a host that answered `granted` and
    // then did nothing — which look the same from the outside.
    const announce = (browserFullscreen?: boolean) => {
      const detail: DisplayModeAttempt = { requested: 'fullscreen', ...(outcome ? { outcome } : {}), ...(browserFullscreen === undefined ? {} : { browserFullscreen }) };
      window.dispatchEvent(new CustomEvent(DISPLAY_MODE_EVENT, { detail }));
    };
    if (outcome?.status === 'granted') { announce(); return; }
    try {
      const target = document.querySelector('.workspace') as HTMLElement | null;
      if (!target?.requestFullscreen) throw new Error('fullscreen unsupported');
      await target.requestFullscreen();
      if (!document.fullscreenElement) throw new Error('fullscreen not entered');
      announce(true);
    } catch {
      announce(false);
      const hostReason = !outcome ? ''
        : outcome.status === 'unsupported' ? '当前宿主未提供全屏模式。'
        : outcome.status === 'denied' ? `宿主没有切换到全屏（返回 ${outcome.mode}）。`
        : `向宿主申请全屏失败${outcome.detail ? `：${outcome.detail}` : '。'}`;
      setNotice({ text: `${hostReason}浏览器全屏也未生效。`, ...(standalone ? { href: standalone, label: '在独立页面打开大画布' } : {}) });
    }
  }
  return <>
    <MapWorkspace snapshot={snapshot} editable={adapter.editable} busy={busy} connection={connection} error={error} suggestion={suggestion}
      notice={notice} onClearNotice={() => setNotice(null)}
      mode={adapter.mode} since={since} shareCredential={adapter.shareCredential?.()}
      onPrepare={async intent => {
      setBusy(true); setError('');
      // The map this round started on. A browser draft turns into a real map
      // during the first save, and that id change is this call's own doing.
      // Read the synchronous ref first: React may still be committing the
      // result of the edit that opened this dialog while the click arrives.
      const startSnapshot = openMap.current ?? snapshot;
      const startId = startSnapshot.id;
      try {
        let current = startSnapshot;
        if (current.version === 0 && adapter.mode === 'browser') current = await adapter.replace({ title: current.title, layers: current.layers }, current);
        const from = submittedVersion(current);
        let text: string;
        let saved = false;
        // The version this hand-off actually describes. The snapshot may move
        // past it while the submit is in flight, but the cursor must not.
        let handoffVersion = current.version;
        let handoffMapId = current.id;
        if (adapter.submitChanges && adapter.editable) {
          const result = await adapter.submitChanges(current, { since: from, userMessage: intent });
          current = result.snapshot;
          text = result.message;
          handoffVersion = result.version;
          handoffMapId = result.mapId;
          saved = true;
        } else {
          if (intent.trim() && adapter.editable) { current = await adapter.edit(current, [{ op: 'intent', text: intent.trim() }]); saved = true; }
          text = planningMessage(current, from, adapter.shareCredential?.());
          if (intent.trim() && !adapter.editable) text += `\n本次意图：${intent.trim()}`;
          handoffVersion = current.version;
          handoffMapId = current.id;
        }
        // Identity before any state write: if the host opened another map while
        // this round was in flight, nothing here belongs to what is on screen —
        // the round stays saved on its own map and must not be written back
        // into, or sent from, the current one.
        const switched = () => new Error('地图已切换，这一轮修改仍然保存在原来的地图上。请回到那张地图再交给 Agent。');
        if (openMap.current && openMap.current.id !== handoffMapId && openMap.current.id !== startId) throw switched();
        setSnapshot(old => {
          if (!old) return current;
          if (old.id === current.id) return current.version >= old.version ? current : old;
          // The only id change this call may apply is the draft it just saved.
          return old.id === startId ? current : old;
        });
        if (adapter.mode === 'offline') text = `以下修改来自离线副本，尚未同步到在线地图。请结合我导出的 JSON 文件处理，不要把在线版本视为这些修改已经保存。\n${text.split('\n\n请调用')[0]}`;
        // Changes newer than the hand-off are not part of it.
        const summary = roundSummary(current, from, handoffVersion);
        // "已保存到地图" means the shared map. An offline copy is not that, and
        // its message already carries the "not synced" caveat above.
        if (adapter.mode === 'offline') saved = false;
        // Re-checked here too: the render between the two writes above is
        // another chance for the host to have swapped the map.
        if (openMap.current && openMap.current.id !== handoffMapId && openMap.current.id !== startId) throw switched();
        const delivery: PlanningDelivery = await adapter.sendPlanningMessage?.(text) ?? { status: 'unsupported' };
        // Only a confirmed hand-off moves the read cursor, and only up to the
        // version the message describes.
        if (delivery.status === 'sent') markSubmitted(handoffMapId, handoffVersion);
        return { text, delivery, mapId: handoffMapId, version: handoffVersion, saved, summary };
      } finally { setBusy(false); }
    }}
      onCopied={(mapId, version) => markSubmitted(mapId, version)}
      onResend={async payload => {
        // Only ever reached through an explicit click, and always about the
        // round that produced this text — not whatever the map has become
        // while the previous send was still unanswered.
        const delivery = await adapter.sendPlanningMessage?.(payload.text) ?? { status: 'unsupported' as const };
        if (delivery.status === 'sent') markSubmitted(payload.mapId, payload.version);
        return delivery;
      }}
      pendingHandoff={pendingChanges} onAccess={adapter.unlock ? () => setAccess(true) : undefined}
      /* `latestOf` guards against the render's own `snapshot` closure going
       * stale while a queued write is still in flight — see its doc comment in
       * adapters/state.ts. Both arguments are read when the write actually
       * goes out, not when this render created the closure, so a write queued
       * behind an earlier one still picks up whatever `mutate` just produced. */
      onEdit={operations => mutate(() => adapter.edit(latestOf(openMap.current, snapshot), operations))}
      onReplace={input => mutate(() => adapter.replace(input, latestOf(openMap.current, snapshot)))}
      onExport={format => { void adapter.export(snapshot, format).catch(e => setError((e as Error).message)); }}
      onNew={() => { if (adapter.mode === 'browser') location.assign('/app?new=1'); else setError('新建地图请打开 Cartula 独立网页。当前地图可继续添加图层。'); }}
      onShare={() => {
        // A draft has no address to share yet; saving it is part of the ask.
        if (snapshot.version === 0 && adapter.mode === 'browser') {
          void mutate(() => adapter.replace({ title: snapshot.title, layers: snapshot.layers }, snapshot)).then(() => setShare(true)).catch(() => {});
        } else setShare(true);
      }} onClearError={() => setError('')}
      onExpand={expandable ? () => { void expand(); } : undefined}
      canShare={Boolean(capabilities?.share)}
      accountEmail={accessState.user?.email}
      {...(capabilities?.account ? { accountOpen: account } : {})}
      onAccount={capabilities?.account ? () => setAccount(open => !open) : undefined}
      onOpenStandalone={!capabilities?.account && capabilities?.openExternal && port?.externalUrl ? () => {
        // No password is ever typed inside a host frame: the standalone page
        // takes over, opened with the credentials this view already holds. A
        // preview arrives there as a preview, which is what favoriting needs.
        const url = port.externalUrl!();
        if (url) void port.openExternal!(url).catch(e => setError((e as Error).message));
      } : undefined}
      onSaveToAccount={canSave ? () => setClaiming(true) : undefined}
      onFavorite={capabilities?.favorite && arrivedOnAShare ? () => void addFavorite() : undefined}
      onCopy={canCopy ? () => { void makeCopy().catch(e => setError((e as Error).message)); } : undefined}
      favorited={accessState.favorited}/>
    {overlays}
  </>;
}
// The product homepage owns `/` on the web; the map workspace (demo draft, or a
// saved map under /map/:id) lives one level down.
//
// An embedded card and an offline export are the map by construction, and
// neither picks the path it is served from: the host chooses it — the Codex
// sandbox serves the frame at `/` — and a file:// export has no route at all.
// So for those two the path is not evidence of anything and must not decide;
// only the bootstrap says which document this is.
const alwaysMap = boot.mode === 'mcp' || boot.mode === 'offline';
createRoot(document.getElementById('root')!).render(!alwaysMap && location.pathname === '/' ? <Landing /> : <Application />);
