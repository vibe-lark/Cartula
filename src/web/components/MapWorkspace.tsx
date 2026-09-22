import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, LocateFixed, MapPin, Route, Sparkles, Trash2, Upload, X, Send, AlertTriangle } from 'lucide-react';
import type { Coord, EditOperation, MapInput, MapLayer, MapPoint, MapSnapshot, PointIcon, PointInput, Suggestion } from '../../core/types.js';
import { POINT_ICONS, POINT_ICON_META } from '../../core/icons.js';
import { MapInputSchema } from '../../core/schema.js';
import { applyOperations } from '../../core/model.js';
import MapCanvas from './MapCanvas.js';
import LayerPanel from './LayerPanel.js';
import TopBar from './TopBar.js';
import PlanRail from './PlanRail.js';
import LayerInfoDialog from './LayerInfoDialog.js';
import { Modal } from './Modal.js';
import InfoPanel, { type InfoItem } from './InfoPanel.js';
import AddPointPopover from './AddPointPopover.js';
import SendPopover from './SendPopover.js';
import Legend from './Legend.js';
import { useLegLabelMode, useMapPreferences, usePinnedPanel, useRouteColorMode } from './preferences.js';
import { CardImage, LegPopover, PointPopover } from './PointCard.js';
import { CLOSE_MS, OPEN_MS } from './peek.js';
import { segmentRisk, type LegRef, type SegmentRisk } from './legs.js';
import { routeGeometry } from './geo.js';
import { activeMapIntents, priorityLabel } from './intents.js';
import { ODBL_URL, OPEN_SOURCE_COMPONENTS, OSM_COPYRIGHT_URL, mentionsOsm, parseAttribution } from './credits.js';
import { invertOperations } from './history.js';
import { agentNote } from '../handoff.js';
import { randomId } from '../id.js';
import type { PlanningPayload } from './CollaborationDialogs.js';
import type { PlanningDelivery } from '../adapters/delivery.js';
import { ConflictError } from '../adapters/state.js';

export interface MapWorkspaceProps {
  snapshot: MapSnapshot; editable: boolean; busy?: boolean;
  connection: 'live' | 'polling' | 'offline' | 'connecting'; error?: string; suggestion?: Suggestion | null;
  /** Non-blocking status from the shell, e.g. an expand request the host refused. */
  notice?: { text: string; href?: string; label?: string } | null;
  onClearNotice?: () => void;
  onEdit: (operations: EditOperation[]) => Promise<void>;
  onReplace: (input: MapInput) => Promise<void>;
  onExport: (format: 'json' | 'html') => void;
  /** Adapter mode, for the send popover's wording. */
  mode: string;
  /** Hand-off window start, as main.tsx computes it. */
  since: number;
  /** The share token this view holds, for the send popover's own fallback message. Absent for the owner. */
  shareCredential?: { previewToken: string; canWrite: boolean };
  onPrepare: (intent: string) => Promise<PlanningPayload>;
  onCopied: (mapId: string, version: number) => void;
  onResend?: (payload: PlanningPayload) => Promise<PlanningDelivery>;
  /**
   * How many changes are waiting to be handed over — the size of the window
   * 继续规划 would send. Above zero it earns a badge on the send entry.
   */
  pendingHandoff?: number;
  /** Paste a key to unlock editing. Absent where no key can be proved. */
  onAccess?: () => void;
  onNew: () => void; onShare: () => void; onClearError: () => void;
  onExpand?: () => void;
  canShare?: boolean;
  onAccount?: () => void;
  accountOpen?: boolean;
  accountEmail?: string;
  onOpenStandalone?: () => void;
  onSaveToAccount?: () => void;
  onFavorite?: () => void;
  favorited?: boolean;
  onCopy?: () => void;
}
type Selection = { layerId: string; pointId: string };
type Dialog = 'layer' | 'layer-info' | 'import' | 'settings' | 'credits' | null;
const colors = ['#2563eb', '#d66836', '#26856a', '#b48b2e', '#8b62b6', '#138aa4'];
const uid = randomId;
function submitForm(event: React.MouseEvent<HTMLButtonElement>) {
  const form = event.currentTarget.form;
  if (form?.reportValidity()) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
function httpsImage(url?: string) {
  return url && /^https:\/\//.test(url) ? url : undefined;
}

export default function MapWorkspace(props: MapWorkspaceProps) {
  const { editable, busy = false, connection, error, suggestion } = props;
  /**
   * A local, already-applied copy of edits that have not been stored yet.
   *
   * Reordering is the one edit where the server round trip is felt: `busy`
   * disables every row's `draggable` and every button while a write is in
   * flight, so dragging three stops into place meant three waits with the list
   * frozen in between. Rendering from a local copy lets the list settle under
   * the pointer immediately while the write happens behind it.
   *
   * `applyOperations` is the same pure function the server runs, so the local
   * copy cannot describe a different outcome than the one being saved. The
   * stored snapshot is never modified, so dropping this copy *is* the rollback.
   */
  const [local, setLocal] = useState<MapSnapshot | null>(null);
  /** What the workspace renders: the local copy while it stands, else the store. */
  const snapshot = local ?? props.snapshot;
  const snapshotRef = useRef(props.snapshot);
  snapshotRef.current = props.snapshot;
  const localRef = useRef<MapSnapshot | null>(null);
  localRef.current = local;
  /** Local edits still being saved; the copy is dropped once this reaches 0. */
  const savingRef = useRef(0);
  /** Bumped by a failure, so writes already queued behind it are abandoned. */
  const generationRef = useRef(0);
  /** Serializes writes: each one is sent against the version the last returned. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [saving, setSaving] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(props.snapshot.layers[0]?.id ?? null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedLeg, setSelectedLeg] = useState<LegRef | null>(null);
  /** Where the selected leg was clicked, for inserting a stop right there. */
  const [legAt, setLegAt] = useState<Coord | null>(null);
  const [pointEditing, setPointEditing] = useState(false);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [insertAfter, setInsertAfter] = useState<string | undefined>();
  const [hoverAt, setHoverAt] = useState<Coord | null>(null);
  const [relocating, setRelocating] = useState(false);
  const [focusAt, setFocusAt] = useState<Coord | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [newPoint, setNewPoint] = useState<{ layerId: string; at: Coord; after?: string; day?: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editLayer, setEditLayer] = useState<MapLayer | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [localError, setLocalError] = useState('');
  const [dismissedSuggestion, setDismissedSuggestion] = useState<Suggestion | null>(null);
  const [rerouteHint, setRerouteHint] = useState<{ from: string; to: string } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [fitLayerId, setFitLayerId] = useState<string | null>(null);
  /**
   * The layer whose stop list is on the stage, when one is: put there by the
   * pointer resting on its dot in the rail, by a press on that dot, or by
   * something that opened it from elsewhere (a layer just created, 查看详情 on
   * a leg card). Cleared once the list reports that nobody is reading it. A
   * pinned list is the active layer's and shows without this being set.
   */
  const [shownId, setShownId] = useState<string | null>(null);
  /** The dot the pointer is on, so the list it opened does not go while it rests there. */
  const [railHover, setRailHover] = useState<string | null>(null);
  /** Opened from somewhere other than the rail: stays until the pointer reaches it. */
  const [detailSticky, setDetailSticky] = useState(false);
  const [panelGrabFocus, setPanelGrabFocus] = useState(false);
  const [infoLayerId, setInfoLayerId] = useState<string | null>(null);
  const railTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const foldTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The surfaces that float over the map and fold when the pointer is
  // elsewhere: a plan's stop list, the card for one stop or one leg, the feed.
  const [detailPinned, setDetailPinned] = usePinnedPanel('detail');
  const [cardPinned, setCardPinned] = usePinnedPanel('card');
  const [infoPinned, setInfoPinned] = usePinnedPanel('info');
  const [infoOpen, setInfoOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [legMode, setLegMode] = useLegLabelMode();
  const [colorMode, setColorMode] = useRouteColorMode();
  const preferences = useMapPreferences();
  const [hoveredLeg, setHoveredLeg] = useState<LegRef | null>(null);
  /** The basemap's own credit lines, as the loaded style reports them. */
  const [attribution, setAttribution] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<{ apply: EditOperation[]; undo: EditOperation[]; attempt?: number }[]>([]);
  const [redoStack, setRedoStack] = useState<{ apply: EditOperation[]; undo: EditOperation[]; attempt?: number }[]>([]);
  const active = snapshot.layers.find(l => l.id === activeId);
  /** The layer whose list is on the stage: the hovered or opened one, else the pinned active one. */
  const panelLayer = snapshot.layers.find(l => l.id === (shownId ?? (detailPinned ? activeId : null)));
  const panelShown = useRef(false);
  panelShown.current = Boolean(panelLayer);
  const infoLayer = snapshot.layers.find(l => l.id === infoLayerId);
  const inspectedLayer = snapshot.layers.find(l => l.id === (newPoint?.layerId ?? selected?.layerId));
  const inspectedPoint = inspectedLayer?.points.find(p => p.id === selected?.pointId);
  const visibleLayers = snapshot.layers.filter(l => visibility[l.id] ?? l.visible);
  const selectedLegLayer = selectedLeg ? snapshot.layers.find(l => l.id === selectedLeg.layerId) : undefined;
  const selectedLegFrom = selectedLegLayer?.points.find(p => p.id === selectedLeg?.fromPointId);
  const selectedLegTo = selectedLegLayer?.points.find(p => p.id === selectedLeg?.toPointId);
  useEffect(() => {
    if (!snapshot.layers.some(l => l.id === activeId)) setActiveId(snapshot.layers[0]?.id ?? null);
    if (shownId && !snapshot.layers.some(l => l.id === shownId)) setShownId(null);
  }, [snapshot.layers, activeId, shownId]);
  /* Host display mode and browser fullscreen are different mechanisms and get
   * different attributes: entering browser fullscreen inside an inline host
   * must not make the app believe the host granted a fullscreen mode. The
   * host owns `data-display-mode`; a standalone page has no host at all. */
  useEffect(() => {
    const root = document.documentElement;
    if (!root.dataset.displayMode) root.dataset.displayMode = 'standalone';
    const sync = () => {
      if (document.fullscreenElement) root.dataset.browserFullscreen = 'true';
      else delete root.dataset.browserFullscreen;
      window.dispatchEvent(new CustomEvent('cartula:host-context-changed'));
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  /**
   * Drop the local copy once the store has caught up with it, or has moved on.
   *
   * A version at or beyond the local copy's means the writes it stood for have
   * landed (or been superseded by someone else's), so the store is now the
   * better answer. Nothing is dropped while a write is still in flight: the
   * store is one version behind by construction until the last one returns.
   */
  useEffect(() => {
    if (local && saving === 0 && props.snapshot.version >= local.version) setLocal(null);
  }, [props.snapshot, local, saving]);
  async function persist(operations: EditOperation[]) {
    if (!editable || busy) return false;
    setLocalError('');
    try { await props.onEdit(operations); return true; }
    catch (e) {
      // A `ConflictError` (see adapters/state.ts) already reads as a complete
      // sentence for a person — the adapter refreshed the map and, where it
      // could, replayed the edit before giving up — so it needs no wrapping
      // here. An unrecognised rejection says nothing about whether the write
      // landed, hence the generic fallback below.
      setLocalError(e instanceof Error ? e.message : '这次改动的结果不确定，请稍后重试。');
      return false;
    }
  }
  async function edit(operations: EditOperation[]) {
    const inverse = invertOperations(snapshot, operations);
    if (!await persist(operations)) return false;
    setUndoStack(stack => [...stack.slice(-40), { apply: operations, undo: inverse }]);
    setRedoStack([]);
    return true;
  }
  /**
   * Apply an edit locally at once, then save it.
   *
   * Only for the position/day edits, where waiting a round trip per drag is the
   * complaint. Everything else still goes through `edit`, because a local
   * preview only pays for itself where the same control is used repeatedly.
   *
   * The local copy is computed with `applyOperations` — the very function the
   * server will run — so what the user sees is what will be stored, and a
   * rejected batch (`DomainError`) is caught here before anything is shown.
   * Writes are queued rather than issued in parallel: each is sent against the
   * version the previous one produced, which is what keeps `If-Match` from
   * turning a fast second drag into a version conflict. A failure abandons the
   * whole queue and restores the stored snapshot, so the list can never keep
   * showing an order the server rejected.
   *
   * Undo/redo is unchanged: the same operations and the same inverse go on the
   * stacks, computed against the state the user actually acted on.
   */
  function editOptimistic(operations: EditOperation[]): boolean {
    if (!editable) return false;
    const base = localRef.current ?? snapshotRef.current;
    let next: MapSnapshot;
    try {
      const result = applyOperations(base, operations);
      if (!result.changes.length) return false;
      next = { ...base, ...result, version: base.version + 1, changes: [...base.changes, ...result.changes] };
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '这次改动无法应用。');
      return false;
    }
    const inverse = invertOperations(base, operations);
    const generation = generationRef.current;
    setLocalError('');
    setLocal(next);
    localRef.current = next;
    // Tagged with the attempt it belongs to, so a rollback can drop exactly the
    // entries whose edits were abandoned — including any that were queued
    // behind the one that failed and therefore never reached the server.
    setUndoStack(stack => [...stack.slice(-40), { apply: operations, undo: inverse, attempt: generation }]);
    setRedoStack([]);
    savingRef.current += 1;
    setSaving(n => n + 1);
    queueRef.current = queueRef.current.then(async () => {
      // A write queued before a failure belongs to the abandoned attempt: the
      // state it was computed against is gone, so sending it would apply an
      // edit the user has already seen reverted.
      if (generationRef.current !== generation) return;
      try {
        await props.onEdit(operations);
      } catch (e) {
        generationRef.current += 1;
        const message = e instanceof Error ? e.message : '这次改动的结果不确定，请稍后重试。';
        // A `ConflictError` already refreshed the map before giving up, so the
        // rollback below lands on the server's own order; anything else only
        // knows to restore the order this edit started from.
        setLocalError(e instanceof ConflictError ? `${message}（已恢复为服务器上的顺序）` : `${message}（已恢复改动前的顺序）`);
        // The stored snapshot was never touched, so dropping the local copy is
        // the rollback — for this edit and for everything queued behind it.
        setLocal(null);
        localRef.current = null;
        setUndoStack(stack => stack.filter(entry => entry.attempt !== generation));
      } finally {
        savingRef.current = Math.max(0, savingRef.current - 1);
        setSaving(n => Math.max(0, n - 1));
      }
    });
    return true;
  }
  async function undo() {
    const entry = undoStack.at(-1);
    if (!entry || !entry.undo.length) return;
    // Wait for any optimistic writes to be stored first: undoing is computed
    // against the map as it stands, so it must not overtake a save in flight.
    await queueRef.current;
    if (!await persist(entry.undo)) return;
    setUndoStack(stack => stack.slice(0, -1));
    setRedoStack(stack => [...stack, entry]);
  }
  async function redo() {
    const entry = redoStack.at(-1);
    if (!entry) return;
    await queueRef.current;
    if (!await persist(entry.apply)) return;
    setRedoStack(stack => stack.slice(0, -1));
    setUndoStack(stack => [...stack, entry]);
  }
  function fitTo(id: string | null) { setFitLayerId(id); setFitKey(n => n + 1); }
  function focusStop(layerId: string, pointId: string) {
    const point = snapshot.layers.find(layer => layer.id === layerId)?.points.find(item => item.id === pointId);
    if (!point) return;
    setFocusAt(point.at);
    setFocusKey(n => n + 1);
  }
  /**
   * A press on a layer's dot: select it, draw it, frame it, and put its list
   * up. The list then lives by the pointer like any hovered one. A second press
   * re-frames rather than closing: hover already has the list up by the time
   * the press lands, and a press that took it away would read as the dot doing
   * the opposite of what it just did.
   */
  function activate(layer: MapLayer) {
    setActiveId(layer.id);
    setVisibility(v => ({ ...v, [layer.id]: true }));
    openDetail(layer.id, false);
    setInfoOpen(false);
    fitTo(layer.id);
  }
  /**
   * Put a layer's list on the stage. `sticky` is for opens that happen far
   * from the pointer — a layer created in a dialog, 查看详情 on a leg card —
   * where the ordinary 24px grace would take the list away on the very move
   * made to reach it; such a list waits until the pointer has been on it.
   */
  function openDetail(layerId: string, sticky: boolean) {
    clearTimeout(railTimer.current);
    clearTimeout(foldTimer.current);
    setShownId(layerId);
    setDetailSticky(sticky);
    setPanelGrabFocus(true);
    setHoveredLeg(null);
  }
  /** Take the list off the stage. Closing the pinned list is what unpins it. */
  function closeDetail() {
    clearTimeout(railTimer.current);
    clearTimeout(foldTimer.current);
    if (!shownId || shownId === activeId) setDetailPinned(false);
    setShownId(null);
    setHoveredLeg(null);
  }
  /**
   * The pointer arrived on a dot, or left the rail. A list opens after the
   * same rest every panel waits for — unless one is already up, in which case
   * it switches at once, so moving down the rail reads plan after plan.
   */
  function hoverRail(layerId: string | null) {
    clearTimeout(railTimer.current);
    setRailHover(layerId);
    if (!layerId) return;
    clearTimeout(foldTimer.current);
    const show = () => { setShownId(layerId); setDetailSticky(false); setPanelGrabFocus(false); };
    if (panelShown.current) show(); else railTimer.current = setTimeout(show, OPEN_MS);
  }
  /**
   * The list reports whether it is being read. Not read → gone, after the
   * delay every panel folds with, so a pointer crossing the gap back to the
   * rail does not lose it. A pinned list never reports false; a preview of
   * another layer shown over it does, and clearing that is what brings the
   * pinned one back.
   */
  function peekDetail(open: boolean) {
    clearTimeout(foldTimer.current);
    if (open) return;
    foldTimer.current = setTimeout(() => { setShownId(null); setHoveredLeg(null); }, CLOSE_MS);
  }
  /**
   * Make a plan the selected one, from a press on the map itself.
   *
   * Deliberately smaller than `activate`: the camera stays exactly where it is
   * and no panel opens. The user pressed a line they could already see, and the
   * answer to that press is on the map — the plan they picked comes forward,
   * the one they left becomes its backdrop. Re-framing would move the very
   * geometry they were comparing out from under the pointer.
   */
  function switchPlan(layerId: string) {
    if (layerId === activeId) return;
    setActiveId(layerId);
    setVisibility(v => ({ ...v, [layerId]: true }));
    setSelected(null);
    setSelectedLeg(null);
    setNewPoint(null);
    setAdding(false);
    setInsertAfter(undefined);
    setHoveredLeg(null);
    setPointEditing(false);
    setRelocating(false);
  }
  /**
   * Show one route on its own. Spots and GeoJSON layers stay as they are:
   * switching between routes should not take the candidate places off the map
   * that the routes are being compared against.
   */
  function solo(layerId: string) {
    setVisibility(v => Object.fromEntries(snapshot.layers.map(l =>
      [l.id, l.kind === 'route' ? l.id === layerId : v[l.id] ?? l.visible])));
    setActiveId(layerId);
    fitTo(layerId);
  }
  function select(layerId: string, pointId: string) {
    setActiveId(layerId);
    setSelected({ layerId, pointId });
    setSelectedLeg(null);
    setNewPoint(null);
    setAdding(false);
    setInsertAfter(undefined);
    setHoveredLeg(null);
    setPointEditing(false);
    setRelocating(false);
  }
  function selectLeg(layerId: string, fromPointId: string, toPointId: string, at?: Coord) {
    setActiveId(layerId);
    setSelectedLeg({ layerId, fromPointId, toPointId });
    // Remembered so 在此插入地点 can use the spot the user actually pressed
    // instead of the segment's midpoint. A pick with no coordinate (the pill,
    // or the sidebar) leaves it unset and the midpoint remains the fallback.
    setLegAt(at ?? null);
    setSelected(null);
    setNewPoint(null);
    setAdding(false);
    setInsertAfter(undefined);
    setPointEditing(false);
  }
  /**
   * Begin a point insertion. `after` names the sibling the new point follows;
   * its day is inherited so the form never asks. Coordinates arrive from the
   * map click that follows.
   */
  function startPoint(at?: Coord, after?: string) {
    if (!active || !editable) return;
    const sibling = after ? active.points.find(p => p.id === after) : undefined;
    const maxDay = active.points.reduce((m, p) => Math.max(m, p.day ?? 0), 0);
    const day = sibling?.day ?? (after ? undefined : maxDay || undefined);
    setNewPoint({ layerId: active.id, at: at ?? sibling?.at ?? active.points.at(-1)?.at ?? [116.397, 39.908], after, day });
    setSelected(null); setSelectedLeg(null); setAdding(false); setInsertAfter(undefined); setHoverAt(null);
  }
  /**
   * Enter map-click mode, either appending or inserting after a sibling. The
   * list this is pressed in may be a hovered layer rather than the selected
   * one, and the point has to land in the layer whose list it was — so that
   * layer is selected first, the same way a press on its dot would.
   */
  function beginAdd(after?: string, layerId: string | null = activeId) {
    if (!editable) return;
    if (layerId && layerId !== activeId) switchPlan(layerId);
    setInsertAfter(after);
    setAdding(true);
    setSelected(null); setSelectedLeg(null); setNewPoint(null); setHoverAt(null);
  }
  async function addPoint(input: { name: string; note: string }) {
    if (!newPoint) return;
    const id = uid();
    const point: PointInput = {
      name: input.name, at: newPoint.at,
      ...(newPoint.day ? { day: newPoint.day } : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    if (await edit([{ op: 'insert', layerId: newPoint.layerId, point: { ...point, id }, ...(newPoint.after ? { after: newPoint.after } : {}) }])) {
      setNewPoint(null);
      setSelected({ layerId: newPoint.layerId, pointId: id });
    }
  }
  /**
   * Move a stop within its layer, and — when it was dropped into a different
   * day group — into that day.
   *
   * Two operations, not one. `reorder` moves a stop in the layer's order and
   * `update {day}` changes which day it belongs to; they are separate facts and
   * the API keeps them separate. Giving `reorder` a hidden day side effect would
   * be worse than a second operation: an agent calling `point.reorder` to
   * reverse a leg would silently re-date the stops it moved, and the change log
   * would attribute a re-dating to a call that never mentioned a day. Batched
   * together they are still atomic — `applyOperations` validates and applies the
   * whole batch or none of it — so the user sees one undoable step either way.
   *
   * `toDay === undefined` means the drop stayed inside its own group (or came
   * from the arrow buttons), so only the position moves.
   */
  function reorder(layerId: string, pointId: string, toIndex: number, toDay?: number | null) {
    const layer = snapshot.layers.find(item => item.id === layerId);
    const point = layer?.points.find(item => item.id === pointId);
    if (!layer || !point) return;
    const from = layer.points.indexOf(point);
    // An empty target group has no row to land next to, so the drop only
    // changes the day; -1 says "leave the order alone".
    const target = toIndex < 0 ? from : toIndex;
    const changesDay = toDay !== undefined && (toDay ?? undefined) !== point.day;
    const operations: EditOperation[] = [];
    if (target !== from) operations.push({ op: 'reorder', layerId, pointId, toIndex: target });
    if (changesDay) operations.push({ op: 'update', layerId, pointId, patch: { day: toDay === null ? null : toDay } });
    if (!operations.length) return;
    editOptimistic(operations);
  }
  /**
   * Whether the point list has to lock its controls.
   *
   * `busy` covers every write the shell has in flight, and locking on it is
   * right for anything that has to read the stored map back. A reorder Cartula
   * has already applied locally is different: the list on screen is already the
   * answer, so freezing it would reintroduce exactly the wait this avoids.
   * Writes queue behind each other and each is sent against the version the
   * last one produced, so consecutive drags stay consistent without a lock.
   */
  const listBusy = busy && saving === 0;
  // One version on screen, and it lives with the changes it describes: the
  // canvas says whether the map is saved, the change list says which version.
  const saveLabel = busy || saving > 0 ? '正在保存…' : connection === 'offline' ? '离线编辑' : connection === 'polling' ? '正在重连' : snapshot.version === 0 ? '待保存的草稿' : editable ? '已保存' : '只读分享';
  const changesLabel = snapshot.version > 0 ? `最近修改 · v${snapshot.version}` : '最近修改';
  // Saved is not handed over. When something is waiting, say how much and put
  // the badge where the send entry already draws the eye.
  const pending = props.pendingHandoff ?? 0;
  const pendingTitle = [
    `还有 ${pending} 条修改没有交给 Agent`,
    snapshot.handoffVersion ? `已交接至 v${snapshot.handoffVersion}` : '本图还没有交接记录',
    snapshot.agentVersion ? `Agent 已处理至 v${snapshot.agentVersion}` : 'Agent 还没有写入过',
  ].join('；');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || dialog) return;
      if (selected || newPoint || selectedLeg) { setSelected(null); setNewPoint(null); setSelectedLeg(null); setPointEditing(false); return; }
      if (sendOpen) { setSendOpen(false); return; }
      if (infoOpen) { setInfoOpen(false); return; }
      if (panelLayer) { closeDetail(); return; }
      setChangesOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, selected, newPoint, selectedLeg, sendOpen, infoOpen, shownId, detailPinned, activeId, undoStack, redoStack]);

  const routeLayers = snapshot.layers.filter(l => l.kind === 'route');
  /** The same rule the canvas draws by: several routes shown, one of them selected. */
  const comparingPlans = (() => {
    const shown = visibleLayers.filter(l => l.kind === 'route');
    return shown.length > 1 && shown.some(l => l.id === activeId);
  })();
  /** Risk styles actually drawn, so the legend never lists what is not there. */
  const shownRisks = useMemo(() => {
    const seen = new Set<SegmentRisk>();
    for (const layer of visibleLayers) {
      if (layer.kind !== 'route') continue;
      for (const seg of routeGeometry(layer).segments) {
        const risk = segmentRisk(seg);
        if (risk !== 'none') seen.add(risk);
      }
    }
    return [...seen];
  }, [snapshot.layers, visibility]);
  const shownDays = useMemo(() => {
    const days = new Set<number>();
    for (const layer of visibleLayers) for (const point of layer.points) if (point.day) days.add(point.day);
    return [...days].sort((a, b) => a - b);
  }, [snapshot.layers, visibility]);
  const mapIntents = activeMapIntents(snapshot.intents);
  const shownSuggestion = suggestion && suggestion !== dismissedSuggestion ? suggestion : null;
  /**
   * Everything the planning process has to say about this map, in one feed.
   * The map is the page; none of this is resident — the icon's badge says how
   * much is waiting.
   */
  const infoItems: InfoItem[] = useMemo(() => {
    const items: InfoItem[] = [];
    for (const intent of mapIntents) items.push({ id: `map-intent-${intent.priority}-${intent.text}`, kind: 'intent', title: priorityLabel(intent.priority), text: intent.text });
    for (const intent of (snapshot.intents ?? []).filter(i => i.scope === 'layer' && i.status !== 'resolved')) {
      const layer = snapshot.layers.find(l => l.id === intent.layerId);
      items.push({ id: `layer-intent-${intent.layerId}-${intent.text}`, kind: 'intent', title: `${layer?.name ?? '图层'} · ${priorityLabel(intent.priority)}`, text: intent.text });
    }
    for (const layer of snapshot.layers) if (layer.note) items.push({ id: `note-${layer.id}`, kind: 'note', title: layer.name, text: layer.note });
    for (const event of snapshot.events.filter(e => e.actor === 'agent').slice(-3)) {
      const text = agentNote(event);
      if (text) items.push({ id: `agent-${event.version}`, kind: 'agent', title: `v${event.version}`, text });
    }
    if (shownSuggestion) items.push({ id: 'suggestion', kind: 'suggestion', title: '建议', text: shownSuggestion.text, onDismiss: () => setDismissedSuggestion(shownSuggestion) });
    if (rerouteHint) items.push({
      id: 'reroute', kind: 'reroute', title: '路线重算',
      text: `已按你的意图去掉「${rerouteHint.from} → ${rerouteHint.to}」的原路车程，这段改为直线估算。交给 Agent 后会按避免意图重算道路。`,
      actionLabel: '交给 Agent 重算',
      onAction: () => { setRerouteHint(null); setSendOpen(true); },
    });
    return items;
  }, [snapshot, mapIntents, shownSuggestion, rerouteHint]);
  // Language only does something with a styled basemap; the SVG fallback and
  // offline mode have no labels to localize.
  const basemapAvailable = connection !== 'offline' && typeof window !== 'undefined' && Boolean((window as unknown as { __CARTULA_CONFIG__?: { styleUrl?: string } }).__CARTULA_CONFIG__?.styleUrl);
  return <div className="workspace">
    <TopBar
      title={snapshot.title} saveLabel={saveLabel} connection={connection}
      mapStyle={preferences.style} onMapStyle={preferences.setStyle}
      colorMode={colorMode} onColorMode={setColorMode}
      language={preferences.language} onLanguage={preferences.setLanguage} languageAvailable={basemapAvailable}
      legMode={legMode} onLegMode={setLegMode}
      legend={<Legend routes={routeLayers} colorMode={colorMode} onColorMode={setColorMode} risks={shownRisks} days={shownDays} comparing={comparingPlans} onCredits={() => setDialog('credits')}/>}
      editable={editable} busy={busy} pending={pending}
      changesLabel={changesLabel}
      canUndo={Boolean(undoStack.length)}
      canRedo={Boolean(redoStack.length)}
      onUndo={() => void undo()}
      onRedo={() => void redo()}
      onExpand={props.onExpand} onShare={props.onShare} canShare={props.canShare}
      onSaveToAccount={props.onSaveToAccount} onFavorite={props.onFavorite} favorited={props.favorited}
      onCopy={props.onCopy} onAccount={props.onAccount} accountOpen={props.accountOpen} accountEmail={props.accountEmail}
      onOpenStandalone={props.onOpenStandalone}
      onContinue={() => setSendOpen(true)}
      onChanges={() => setChangesOpen(v => !v)}
      onExport={props.onExport}
      onImport={() => setDialog('import')}
      onAccess={props.onAccess}
      onNew={props.onNew}
      onCredits={() => setDialog('credits')}
      onSettings={() => setDialog('settings')}/>
    <div className="workspace-body">
      <main className="map-stage">
        <MapCanvas layers={visibleLayers} activeLayerId={activeId} selected={selected} adding={adding} relocating={relocating} editable={editable && !busy} offline={connection === 'offline'} fitLayerId={fitLayerId} fitKey={fitKey} legMode={legMode} colorMode={colorMode} hoveredLeg={hoveredLeg} selectedLeg={selectedLeg} insertFrom={insertAfter && active ? active.points.find(pt => pt.id === insertAfter)?.at ?? null : null} insertTo={insertAfter && active ? active.points[active.points.findIndex(pt => pt.id === insertAfter) + 1]?.at ?? null : null} hoverAt={hoverAt} focusAt={focusAt} focusKey={focusKey} mapStyle={preferences.style} mapLanguage={preferences.language} onHoverAt={setHoverAt} onSelect={select} onSelectLeg={selectLeg} onActivateLayer={switchPlan} onAttribution={setAttribution} onMove={(layerId, pointId, at) => { void edit([{ op: 'update', layerId, pointId, patch: { at } }]); }} onAdd={at => {
          if (relocating && selected) { void edit([{ op: 'update', layerId: selected.layerId, pointId: selected.pointId, patch: { at } }]); setRelocating(false); setHoverAt(null); return; }
          startPoint(at, insertAfter);
          setAdding(false); setHoverAt(null);
        }}/>
        <PlanRail layers={snapshot.layers} visible={l => visibility[l.id] ?? l.visible} activeId={activeId} shownId={panelLayer?.id ?? null}
          editable={editable} busy={busy}
          onOpen={activate} onHover={hoverRail}
          onNewLayer={() => { setEditLayer(null); setDialog('layer'); }}/>
        {/* Keyed by layer: moving down the rail swaps one list for another, and
            a list carries state (an open drag, collapsed days, its own grace)
            that belongs to the layer it was opened for. */}
        {panelLayer && <LayerPanel key={panelLayer.id} layer={panelLayer} ordinal={snapshot.layers.indexOf(panelLayer) + 1}
          selectedPointId={selected?.layerId === panelLayer.id ? selected.pointId : null}
          editable={editable} busy={listBusy} visible={visibility[panelLayer.id] ?? panelLayer.visible}
          grabFocus={panelGrabFocus} deliberate={panelGrabFocus} colorMode={colorMode}
          pinned={detailPinned && panelLayer.id === activeId} held={railHover !== null} sticky={detailSticky}
          // Pinning is a statement about the selected layer, so pinning a
          // hovered one selects it first — without re-framing, the way a press
          // on the map does. Unpinning leaves the list up until the pointer goes.
          onPin={next => { if (next && panelLayer.id !== activeId) switchPlan(panelLayer.id); setDetailPinned(next); setShownId(panelLayer.id); }}
          onPeek={peekDetail}
          onSelect={pointId => { select(panelLayer.id, pointId); focusStop(panelLayer.id, pointId); }}
          onReorder={(pointId, toIndex, toDay) => reorder(panelLayer.id, pointId, toIndex, toDay)}
          onAddPoint={() => beginAdd(undefined, panelLayer.id)}
          onInsertAfter={pointId => beginAdd(pointId, panelLayer.id)}
          onOpenSettings={() => { setEditLayer(panelLayer); setDialog('layer'); }}
          onOpenInfo={() => { setInfoLayerId(panelLayer.id); setDialog('layer-info'); }}
          onToggleVisible={() => setVisibility(v => ({ ...v, [panelLayer.id]: !(v[panelLayer.id] ?? panelLayer.visible) }))}
          onSolo={() => solo(panelLayer.id)}
          onFit={() => fitTo(panelLayer.id)}
          onClose={closeDetail}
          onHoverLeg={setHoveredLeg}/>}
        {infoOpen && <InfoPanel items={infoItems} pinned={infoPinned} onPin={setInfoPinned} onClose={() => setInfoOpen(false)}/>}
        <div className="map-top-tools"><div className="map-tools">
          <button type="button" className={`icon-button floating map-info-button ${infoOpen ? 'active' : ''}`} aria-label="信息" aria-expanded={infoOpen} title="规划意图、Agent 调整说明与建议" onClick={() => { setInfoOpen(v => !v); setShownId(null); }}>
            <Info size={17}/>
            {infoItems.length > 0 && <span className="info-badge map-info-badge">{infoItems.length > 99 ? '99+' : infoItems.length}</span>}
          </button>
          <button type="button" className="icon-button floating" aria-label="适应全部图层" onClick={() => fitTo(null)}><LocateFixed size={17}/></button>
        </div></div>
        {(error || localError) && <div className="notice error" role="alert"><AlertTriangle size={17}/><span>{error || localError}</span><button className="icon-button" aria-label="关闭错误" onClick={() => { setLocalError(''); props.onClearError(); }}><X size={15}/></button></div>}
        {props.notice && !error && !localError && <div className="notice info" role="status"><Info size={17}/><span>{props.notice.text}</span>{props.notice.href && <a className="button compact" href={props.notice.href} target="_blank" rel="noreferrer noopener">{props.notice.label ?? '打开独立页面'}</a>}<button className="icon-button" aria-label="关闭提示" onClick={() => props.onClearNotice?.()}><X size={15}/></button></div>}
        {(adding || relocating) && <div className="adding-hint"><MapPin size={17}/>{relocating ? '点击地图，移动该地点' : `点击地图，为「${active?.name}」${insertAfter ? '插入中途地点' : '添加一个地点'}`}</div>}
        {!snapshot.layers.length && <div className="empty-map"><div className="empty-map-icon"><Route size={34}/></div><span className="eyebrow">CARTULA</span><h2>新建地图</h2><p>先加一个图层，再把地点放到地图上。</p>{editable && <button className="button primary" onClick={() => { setEditLayer(null); setDialog('layer'); }}><MapPin size={16}/>创建第一个图层</button>}</div>}
        {inspectedLayer && inspectedPoint && !newPoint && !pointEditing && !relocating && <PointPopover layer={inspectedLayer} point={inspectedPoint} editable={editable} busy={busy} offline={connection === 'offline'} colorMode={colorMode} pinned={cardPinned} onPin={setCardPinned} onClose={() => { setSelected(null); setPointEditing(false); setRelocating(false); }} onEdit={() => setPointEditing(true)} onMove={() => { setRelocating(true); setAdding(false); setSelectedLeg(null); }} onDelete={async () => { if (await edit([{ op: 'delete', layerId: inspectedLayer.id, pointId: inspectedPoint.id }])) setSelected(null); }}/>}
        {newPoint && inspectedLayer && <AddPointPopover key={`${newPoint.layerId}-${newPoint.at.join(',')}`} layer={inspectedLayer} at={newPoint.at} day={newPoint.day} busy={busy}
          onClose={() => setNewPoint(null)}
          onSubmit={input => void addPoint(input)}/>}
        {inspectedLayer && inspectedPoint && pointEditing && !newPoint && <PointInspector key={`${inspectedLayer.id}-${inspectedPoint.id}-${snapshot.version}`} layer={inspectedLayer} point={inspectedPoint} editable={editable} busy={busy} offline={connection === 'offline'} onClose={() => { setSelected(null); setPointEditing(false); }} onSave={async point => {
          if (inspectedPoint && await edit([{ op: 'update', layerId: inspectedLayer.id, pointId: inspectedPoint.id, patch: { ...point, day: point.day ?? null, flexibility: point.flexibility ?? null, icon: point.icon ?? null } }])) setPointEditing(false);
        }} onDelete={async intent => { if (inspectedPoint && await edit([...(intent ? [{ op: 'intent.set' as const, scope: 'point' as const, layerId: inspectedLayer.id, pointId: inspectedPoint.id, text: intent, priority: 'prefer' as const }] : []), { op: 'delete', layerId: inspectedLayer.id, pointId: inspectedPoint.id }])) { setSelected(null); setPointEditing(false); } }}/>}
        {selectedLegLayer && selectedLegFrom && selectedLegTo && <LegPopover layer={selectedLegLayer} from={selectedLegFrom} to={selectedLegTo} editable={editable} busy={busy} colorMode={colorMode} pinned={cardPinned} onPin={setCardPinned}
          atClick={Boolean(legAt)}
          onClose={() => { setSelectedLeg(null); setLegAt(null); }}
          /**
           * Insert a stop on this leg in one action.
           *
           * The position is where the leg was clicked when that is known, and
           * the segment's midpoint otherwise — so this always lands somewhere
           * sensible without a second click on the map. The new stop opens in
           * the editor with its name selected, which is the only thing still
           * missing, and inherits the day of the stop it follows so it joins
           * that day's itinerary rather than falling out of the plan.
           */
          onInsertHere={async () => {
            const id = uid();
            const at: Coord = legAt ?? [(selectedLegFrom.at[0] + selectedLegTo.at[0]) / 2, (selectedLegFrom.at[1] + selectedLegTo.at[1]) / 2];
            const day = selectedLegFrom.day;
            if (await edit([{ op: 'insert', layerId: selectedLegLayer.id, point: { id, name: `${selectedLegFrom.name}–${selectedLegTo.name}中途`, at, ...(day ? { day } : {}) }, after: selectedLegFrom.id }])) {
              setSelectedLeg(null); setLegAt(null); setSelected({ layerId: selectedLegLayer.id, pointId: id }); setPointEditing(true);
            }
          }}
          /** The original two-step route, for picking a spot off the line. */
          onPickOnMap={() => { setLegAt(null); beginAdd(selectedLegFrom.id); }}
          onAvoid={async () => {
            const from = selectedLegFrom.name, to = selectedLegTo.name;
            const routing = selectedLegLayer.routing ? { ...selectedLegLayer.routing } : { source: '未注明来源' };
            delete routing.distanceKm; delete routing.durationMinutes;
            if (await edit([
              { op: 'intent.set', scope: 'layer', layerId: selectedLegLayer.id, text: `避免 ${from} 至 ${to}`, priority: 'avoid' },
              { op: 'layer.update', layerId: selectedLegLayer.id, patch: { routing } },
              { op: 'route.leg.update', layerId: selectedLegLayer.id, fromPointId: selectedLegFrom.id, toPointId: selectedLegTo.id, patch: { note: `用户要求避免 ${from} 至 ${to}`, path: null, distanceKm: null, durationMinutes: null, delayMinutes: null } },
            ])) { setSelectedLeg(null); setRerouteHint({ from, to }); }
          }}
          onDetail={() => openDetail(selectedLegLayer.id, true)}/>}
        <div className="map-bottom">
          <button
            type="button"
            className="agent-send-fab send-button"
            disabled={busy}
            title={pendingTitle}
            aria-label="交给 Agent"
            onClick={() => setSendOpen(true)}
          >
            <Send size={18}/>
            {pending > 0 && <span className="send-badge">{pending > 99 ? '99+' : pending}</span>}
          </button>
        </div>
        {changesOpen && <aside className="changes-drawer" aria-label="最近修改">
          <div className="dialog-heading"><h2>最近修改 · v{snapshot.version}</h2><button className="icon-button" aria-label="关闭最近修改" onClick={() => setChangesOpen(false)}><X size={16}/></button></div>
          <ul>{(snapshot.changes.length ? snapshot.changes.slice(-16) : ['还没有改动']).map((change, i) => <li key={i}>{change}</li>)}</ul>
          {pending > 0 && <p className="pending-note">其中 {pending} 条还没有交给 Agent。</p>}
          <button className="button primary compact" disabled={busy} onClick={() => { setChangesOpen(false); setSendOpen(true); }}><Sparkles size={14}/>按这些修改继续规划</button>
        </aside>}
        {sendOpen && <SendPopover map={snapshot} mode={props.mode} since={props.since} shareCredential={props.shareCredential} busy={busy} onClose={() => setSendOpen(false)}
          onPrepare={props.onPrepare} onCopied={props.onCopied} onResend={props.onResend}/>}
      </main>
    </div>
    {dialog === 'layer' && <LayerDialog layer={editLayer} color={colors[snapshot.layers.length % colors.length]} busy={busy} onClose={() => setDialog(null)} onSave={async values => {
      const id = editLayer?.id ?? uid();
      if (await edit([editLayer ? { op: 'layer.update', layerId: id, patch: values } : { op: 'layer.add', layer: { id, ...values, points: [] } }])) { setDialog(null); setActiveId(id); openDetail(id, true); }
    }} onDelete={editLayer ? async () => { if (await edit([{ op: 'layer.delete', layerId: editLayer.id }])) setDialog(null); } : undefined}/>}
    {dialog === 'import' && <ImportDialog busy={busy} onClose={() => setDialog(null)} onImport={async (input, replace) => {
      if (replace) { await props.onReplace(input); setSelected(null); setNewPoint(null); }
      else if (!await edit(input.layers.map(layer => ({ op: 'layer.add', layer: { ...layer, id: uid() } })))) return;
      setDialog(null); fitTo(null);
    }}/>}
    {dialog === 'layer-info' && infoLayer && <LayerInfoDialog layer={infoLayer} onClose={() => setDialog(null)}/>}
    {dialog === 'credits' && <CreditsDialog attribution={attribution} offline={connection === 'offline'}
      routingSources={[...new Set(snapshot.layers.map(layer => layer.routing?.source?.trim()).filter((source): source is string => Boolean(source)))]}
      onClose={() => setDialog(null)}/>}
    {dialog === 'settings' && <Modal title="地图设置" onClose={() => setDialog(null)}><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const title = String(data.get('title')); const intent = String(data.get('intent') ?? '').trim(); const current = snapshot.intents?.find(item => item.scope === 'map')?.text ?? ''; void (async () => { if (title !== snapshot.title) await props.onReplace({ title, layers: snapshot.layers, intents: snapshot.intents }); if (intent !== current) await edit([{ op: 'intent.set', scope: 'map', text: intent, priority: 'prefer' }]); setDialog(null); })().catch(() => {}); }}><label>地图名称<input name="title" defaultValue={snapshot.title} required maxLength={120}/></label><label>整张地图的规划意图<textarea name="intent" rows={2} defaultValue={snapshot.intents?.find(item => item.scope === 'map')?.text ?? ''} maxLength={2000} placeholder="例如：减少长途驾驶，把时间留给瑞士"/></label><div className="form-actions"><button type="button" className="button" onClick={() => setDialog(null)}>取消</button><button type="button" onClick={submitForm} className="button primary" disabled={busy}>保存</button></div></form></Modal>}
  </div>;
}

function PointInspector({ layer, point, editable, busy, offline, onClose, onSave, onDelete }: { layer: MapLayer; point: MapPoint; editable: boolean; busy: boolean; offline: boolean; onClose: () => void; onSave: (input: PointInput) => Promise<void>; onDelete: (intent?: string) => Promise<void> }) {
  const [name, setName] = useState(point?.name ?? '');
  return <section className="point-inspector" aria-label="地点详情"><div className="inspector-heading"><span className="eyebrow">地点详情</span><button className="icon-button" aria-label="关闭地点详情" onClick={onClose}><X size={18}/></button></div><h2>{point.name}</h2><p className="inspector-layer"><i style={{ background: layer.color }}/>{layer.name}</p>
    <CardImage src={point.img} alt={point.name} offline={offline}/>
    <form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); const day = String(d.get('day') ?? ''); const icon = String(d.get('icon') ?? ''); void onSave({ name: String(d.get('name')), at: [Number(d.get('lng')), Number(d.get('lat'))], ...(day ? { day: Number(day) } : {}), note: String(d.get('note')), intent: String(d.get('intent')), ...(d.get('flexibility') ? { flexibility: String(d.get('flexibility')) as PointInput['flexibility'] } : {}), warn: d.get('warn') === 'on', img: String(d.get('img')), ...(icon ? { icon: icon as PointIcon } : {}) }); }}>
      <fieldset disabled={!editable || busy}><label>地点名称<input name="name" value={name} onChange={e => setName(e.target.value)} placeholder="例如：五大连池" required maxLength={80}/></label><label>标记样式<select aria-label="标记样式" name="icon" defaultValue={point?.icon ?? (layer.kind === 'spots' ? 'pin' : '')}>{layer.kind !== 'spots' && <option value="">路线节点（编号圆点）</option>}{POINT_ICONS.map(icon => <option key={icon} value={icon}>{POINT_ICON_META[icon].label}</option>)}</select></label><div className="form-columns"><label>经度<input name="lng" type="number" step="any" min={-180} max={180} defaultValue={point.at[0]} required/></label><label>纬度<input name="lat" type="number" step="any" min={-90} max={90} defaultValue={point.at[1]} required/></label></div><label>行程天数<input name="day" type="number" min={1} max={3650} defaultValue={point.day} placeholder="可选，例如第 3 天"/></label><label>备注<textarea aria-label="备注" name="note" rows={3} defaultValue={point.note} maxLength={1000} placeholder="在这里记录停留安排、灵感或提醒"/></label><label>规划意图<textarea aria-label="地点规划意图" name="intent" rows={2} defaultValue={point.intent} maxLength={1000} placeholder="例如：这里必须保留；删掉这里，把时间留给瑞士。"/></label><label>调整状态<select aria-label="调整状态" name="flexibility" defaultValue={point.flexibility ?? ''}><option value="">未指定</option><option value="fixed">必须保留</option><option value="flexible">允许调整</option></select></label><label className="checkbox-label"><input type="checkbox" name="warn" defaultChecked={point.warn}/>标记为需留意的地点</label><details className="image-field" open={Boolean(httpsImage(point.img))}><summary>图片链接</summary><label>HTTPS 图片地址<input name="img" type="url" pattern="https://.*" defaultValue={point.img} placeholder="https://…" maxLength={2048}/></label><p className="field-hint">地点图片只接受 HTTPS 链接，不能从本地上传文件。</p></details></fieldset>
      {editable ? <div className="form-actions">{point && <button type="button" className="button danger quiet" aria-label={`删除 ${point.name}`} disabled={busy} onClick={e => void onDelete(String(new FormData(e.currentTarget.form!).get('intent') ?? '').trim())}><Trash2 size={15}/>删除</button>}<button type="button" onClick={submitForm} className="button primary" disabled={busy}><Check size={16}/>保存修改</button></div> : <p className="read-only-note">只读分享 · 可以查看和导出此地图</p>}
    </form></section>;
}
/**
 * Where the map's credits live now that they are not drawn on the map.
 *
 * The basemap's own words come first, links intact, because that is the part a
 * licence actually asks for — the OSM Foundation's guidelines allow the credit
 * to sit behind an About entry in a menu exactly like this one, provided it can
 * be found and provided it is complete when it is. Route provenance and the
 * bundled components follow: different obligations, kept visibly apart.
 *
 * Nothing here is asserted on the provider's behalf. The ODbL sentence appears
 * only when the credit that arrived with the tiles names OpenStreetMap, and an
 * empty credit means no basemap data is on screen — which the dialog says,
 * rather than naming a source that is not being shown.
 */
function CreditsDialog({ attribution, offline, routingSources, onClose }: {
  attribution: string[]; offline: boolean; routingSources: string[]; onClose: () => void;
}) {
  const osm = mentionsOsm(attribution);
  return <Modal title="地图数据与开源声明" onClose={onClose}>
    <section className="credits">
      <h3>底图数据</h3>
      {attribution.length
        ? attribution.map((credit, index) => <p key={index} className="credit-line">
          {parseAttribution(credit).map((part, at) => <span key={at}>
            {at ? ' ' : ''}
            {part.href ? <a href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a> : part.text}
          </span>)}
        </p>)
        : <p className="credit-line">{offline ? '离线模式：只绘制坐标网格，没有加载任何底图数据。' : '当前视图没有加载底图数据。'}</p>}
      {osm && <p className="credit-note">
        底图数据来自 OpenStreetMap 贡献者，依据 <a href={ODBL_URL} target="_blank" rel="noreferrer noopener">ODbL</a> 授权；
        详见 <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer noopener">openstreetmap.org/copyright</a>。
      </p>}
      {routingSources.length > 0 && <>
        <h3>路线数据</h3>
        <p className="credit-line">{routingSources.join(' · ')}</p>
        <p className="credit-note">路线的距离与时间由这些来源提供；标注「直线」的距离是 Cartula 自己的估算。</p>
      </>}
      <h3>开源组件</h3>
      <ul className="credit-list">
        {OPEN_SOURCE_COMPONENTS.map(item => <li key={item.pkg}>
          <a href={item.url} target="_blank" rel="noreferrer noopener">{item.name}</a>
          <span>{item.version} · {item.license}</span>
          <small>{item.role}</small>
        </li>)}
      </ul>
      <p className="credit-note">完整的第三方许可原文随源码一起发布，见 THIRD_PARTY_NOTICES.md。</p>
    </section>
  </Modal>;
}
function LayerDialog({ layer, color, busy, onClose, onSave, onDelete }: { layer: MapLayer | null; color: string; busy: boolean; onClose: () => void; onSave: (input: { name: string; kind: 'route' | 'spots' | 'geojson'; color: string; note: string; from: string; intent: string }) => Promise<void>; onDelete?: () => Promise<void> }) {
  return <Modal title={layer ? '图层设置' : '新建图层'} onClose={onClose}><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); void onSave({ name: String(d.get('name')), kind: String(d.get('kind')) as 'route' | 'spots' | 'geojson', color: String(d.get('color')), note: String(d.get('note')), from: String(d.get('from')), intent: String(d.get('intent')) }); }}><label>图层名称<input name="name" placeholder="例如：沿江自驾路线" defaultValue={layer?.name} required maxLength={80} autoFocus/></label><div className="form-columns"><label>图层类型<select aria-label="图层类型" name="kind" defaultValue={layer?.kind ?? 'route'}><option value="route">路线 · 按顺序连接</option><option value="spots">地点集 · 独立散点</option>{layer?.geojson && <option value="geojson">地理数据</option>}</select></label><label>图层颜色<input name="color" type="color" defaultValue={layer?.color ?? color}/></label></div><label>说明<textarea name="note" rows={2} defaultValue={layer?.note} maxLength={2000} placeholder="描述这个图层的用途"/></label><label>路线 / 图层的规划意图<textarea name="intent" rows={2} defaultValue={layer?.intent} maxLength={2000} placeholder="例如：这一段每天开车不超过三小时"/></label><label>数据来源<input name="from" defaultValue={layer?.from} maxLength={500} placeholder="可选，注明数据来源"/></label><div className="form-actions">{onDelete && <button type="button" className="button danger quiet" disabled={busy} onClick={() => void onDelete()}><Trash2 size={15}/>删除图层</button>}<button type="button" onClick={submitForm} className="button primary" disabled={busy}>{layer ? '保存图层' : '创建图层'}</button></div></form></Modal>;
}
function ImportDialog({ busy, onClose, onImport }: { busy: boolean; onClose: () => void; onImport: (input: MapInput, replace: boolean) => Promise<void> }) {
  const [text, setText] = useState(''); const [replace, setReplace] = useState(false); const [error, setError] = useState('');
  async function submit() {
    try {
      const parsed = JSON.parse(text);
      const data = parsed.type === 'FeatureCollection' ? { layers: [{ name: '导入的地理数据', kind: 'geojson', geojson: parsed }] } : parsed.type === 'Feature' ? { layers: [{ name: '导入的地理数据', kind: 'geojson', geojson: { type: 'FeatureCollection', features: [parsed] } }] } : Array.isArray(parsed) ? { layers: parsed } : parsed.layers ? parsed : { layers: [parsed] };
      const input = MapInputSchema.parse(data);
      if (!replace && !input.layers.length) throw new Error('这份数据中还没有图层');
      await onImport(input, replace);
    } catch (e) { setError(e instanceof SyntaxError ? 'JSON 格式不正确，请检查逗号、引号和括号。' : e instanceof Error ? e.message : '导入失败'); }
  }
  return <Modal title="导入地图数据" onClose={onClose}><p className="dialog-description">粘贴 Agent 给出的地图 JSON，或放入 GeoJSON 数据。</p><label className="file-upload"><Upload size={22}/><span>选择 JSON / GeoJSON 文件</span><input type="file" accept=".json,.geojson,application/json" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setError('文件最大 2 MiB'); return; } void file.text().then(setText).catch(() => setError('文件读取失败')); }}/></label><label>或直接粘贴<textarea aria-label="地图 JSON" className="json-input" value={text} onChange={e => { setText(e.target.value); setError(''); }} rows={8} spellCheck={false} placeholder={'{"layers":[{"name":"我的路线","points":[]}]}'}/></label><label className="checkbox-label"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)}/>替换整张地图（默认追加为新图层）</label>{error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !text.trim()} onClick={() => void submit()}><Upload size={15}/>导入</button></div></Modal>;
}
