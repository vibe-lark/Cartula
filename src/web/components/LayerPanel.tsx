import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, AlertTriangle, ChevronDown, Eye, EyeOff, Focus, GripVertical, Info, LocateFixed, Plus, Settings2, X } from 'lucide-react';
import type { MapLayer, MapPoint, PointIcon } from '../../core/types.js';
import { iconFill, markerIcon } from '../../core/icons.js';
import { POI_PATHS } from './poiIcons.js';
import { layerStats } from '../../core/model.js';
import { segmentInfo } from './RouteMetrics.js';
import { TRAVEL_TIME_NOTE, compactDuration, formatDistance, layerDays, layerTravelProfile, legModeLabel, pointColor, travelTimeLabel, type LegRef, type RouteColorMode } from './legs.js';
import { luminance } from './dayColors.js';
import PinButton from './PinButton.js';
import { usePeek } from './peek.js';

export const layerKind = (layer: MapLayer) =>
  layer.kind === 'route' ? '路线' : layer.kind === 'spots' ? '地点集' : '地理数据';

/**
 * The numeral drawn on a dot filled with the layer's own colour. The palette
 * runs from navy to amber, and no single ink reads on both: white on `#f59e0b`
 * is 2.1:1, ink on `#2563eb` is 3.1:1. Chosen per colour instead, at the
 * luminance where the two swap places.
 */
export function dotInk(color: string): string {
  return luminance(color) > 0.32 ? 'var(--ink)' : '#fff';
}

function SpotMark({ icon, warn }: { icon: PointIcon; warn?: boolean }) {
  const color = iconFill(icon, 'light', warn);
  const path = POI_PATHS[icon];
  return <span className="point-number point-mark" style={{ background: color, borderColor: color }} aria-hidden>
    {path
      ? <svg viewBox="0 0 24 24" width="14" height="14"><path d={path} fill="#fff"/></svg>
      : <span className="point-mark-dot"/>}
  </span>;
}

/**
 * The two numbers a route's list does not otherwise show, for the line beside
 * the tools: how far, and how long in motion. Each is a `<b>` value with a
 * qualifier beside it, so the number is the thing that reads and the
 * qualifier the thing that keeps it honest — distance still says whether it
 * was routed, and the time still names the mode that marks it as time in
 * motion, with the exclusion spelled out in the tooltip. Point and day counts
 * are not here: the day groups below say both, and the line has ~150px.
 */
export function layerFacts(layer: MapLayer): { key: string; value: string; note?: string; title?: string }[] {
  const stats = layerStats(layer);
  const facts: { key: string; value: string; note?: string; title?: string }[] = [];
  if (layer.kind === 'geojson') facts.push({ key: 'features', value: `${layer.geojson?.features.length ?? 0} 要素` });
  if (layer.kind !== 'route') facts.push({ key: 'points', value: `${layer.points.length} 点` });
  if (layer.kind === 'route') {
    facts.push(stats.routingDistanceKm !== undefined
      ? { key: 'distance', value: formatDistance(stats.routingDistanceKm), note: '路由', title: '路由服务里程' }
      : { key: 'distance', value: formatDistance(stats.distanceKm), note: stats.distanceKind === 'straight' ? '直线' : undefined, title: stats.distanceKind === 'straight' ? '地点间直线合计' : '路径几何长度' });
    if (stats.durationMinutes !== undefined) {
      const profile = layerTravelProfile(layer);
      facts.push({ key: 'time', value: compactDuration(stats.durationMinutes), note: legModeLabel(profile) ?? '移动', title: `${travelTimeLabel(profile)}，${TRAVEL_TIME_NOTE}` });
    }
  }
  return facts;
}

export interface LayerPanelProps {
  layer: MapLayer;
  /** This layer's number in the rail, so the heading carries the same dot. */
  ordinal: number;
  /** Selection within this layer only; null when another layer owns it. */
  selectedPointId: string | null;
  editable: boolean;
  busy: boolean;
  /** Whether the map is drawing this layer. */
  visible: boolean;
  /** Take keyboard focus on mount — only for user-initiated opens, never on load. */
  grabFocus: boolean;
  /**
   * Opened by a press, a key or a dialog rather than by the pointer resting on
   * the dot. Such a list gets the grace every clicked-open panel gets (and is
   * what keeps it up on a touch screen, where nothing hovers); a list the
   * pointer summoned lives and dies by the pointer alone.
   */
  deliberate: boolean;
  /** Route colouring in force, so list and map never disagree on a colour. */
  colorMode?: RouteColorMode;
  /**
   * Kept open on purpose. Unpinned, the list is on screen only while the
   * pointer is on it or on its dot in the rail — it is a 300px column over the
   * map it describes, and the map is what the page is for. See `peek.ts`.
   */
  pinned: boolean;
  /** The pointer is on this layer's dot in the rail: the list must not go. */
  held: boolean;
  /**
   * Opened by something other than the pointer — a dialog, a leg card — so
   * the list stays until the pointer has actually reached it. See `peek.ts`.
   */
  sticky: boolean;
  onPin: (pinned: boolean) => void;
  /**
   * Reports whether the list is being read (pointer on it, focus in it, held,
   * pinned or still in its grace). `false` is the workspace's cue to take the
   * panel away, after the same delay every panel folds with.
   */
  onPeek: (open: boolean) => void;
  onSelect: (pointId: string) => void;
  /**
   * Move a stop. `toDay` is the day group it was dropped into — a number, or
   * null for 未排期 — and is undefined when the position changed but the group
   * did not (the arrow buttons, or a drop inside the same group).
   */
  onReorder: (pointId: string, toIndex: number, toDay?: number | null) => void;
  /** Append a point at the end of the layer. */
  onAddPoint: () => void;
  /** Insert a new point after this one (map click picks the spot). */
  onInsertAfter: (pointId: string) => void;
  onOpenSettings: () => void;
  /** The layer's provenance and route metrics, in a dialog. */
  onOpenInfo: () => void;
  onToggleVisible: () => void;
  /** Show only this layer on the map. */
  onSolo: () => void;
  onFit: () => void;
  onClose: () => void;
  /** Hover/focus on a row previews its outgoing leg's annotation on the map. */
  onHoverLeg: (leg: LegRef | null) => void;
}

/** One collapsible day group: a parent row and the stops made on that day. */
function DayGroup({ label, day, points, layer, dayColor, selectedPointId, editable, busy, colorMode, defaultOpen, dragged, onDragStart, onDrop, onDragEnd, onSelect, onReorder, onInsertAfter, onHoverLeg, registerRow }: {
  label: string;
  /** This group's itinerary day; null for 未排期. Dropping here sets it. */
  day: number | null;
  points: MapPoint[];
  layer: MapLayer;
  /** This day's colour on the map, or null for the unscheduled group. */
  dayColor: string | null;
  selectedPointId: string | null;
  editable: boolean;
  busy: boolean;
  colorMode: RouteColorMode;
  defaultOpen: boolean;
  dragged: string | null;
  onDragStart: (pointId: string) => void;
  onDrop: (toIndex: number, toDay: number | null) => void;
  onDragEnd: () => void;
  onSelect: (pointId: string) => void;
  onReorder: (pointId: string, toIndex: number, toDay?: number | null) => void;
  onInsertAfter: (pointId: string) => void;
  onHoverLeg: (leg: LegRef | null) => void;
  registerRow: (pointId: string, el: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A drop anywhere in the group — not only on one of its rows — has to work:
  // the group may be empty, or collapsed, and its header is the largest target.
  // Landing on the group itself appends to it.
  const [over, setOver] = useState(false);
  const acceptDrop = (event: React.DragEvent) => {
    if (!dragged) return;
    event.preventDefault();
    setOver(true);
  };
  const groupDrop = (event: React.DragEvent) => {
    if (!dragged) return;
    event.preventDefault();
    setOver(false);
    // The index of the last stop in this group, so the dragged stop joins the
    // end of the day rather than displacing its first stop. An empty group has
    // no anchor of its own: the layer order is left alone and only `day` moves.
    const last = points.at(-1);
    const anchor = last ? layer.points.findIndex(item => item.id === last.id) : -1;
    onDrop(anchor, day);
  };
  // One custom property feeds both the wash and the left edge in styles.css, so
  // the two can never drift apart. An undated group passes none and inherits
  // the neutral default there: "未排期" is not a day, and tinting it would
  // claim a place on the map that it does not have. The drop highlight is
  // `.day-group.drop-target` in the same file.
  const style = dayColor ? { '--day-color': dayColor } as CSSProperties : undefined;
  return <div className={`day-group ${open ? 'open' : ''} ${over ? 'drop-target' : ''}`} style={style}
    onDragOver={acceptDrop} onDragEnter={acceptDrop}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
    onDrop={groupDrop}>
    <button type="button" className="day-group-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <ChevronDown size={13} className="day-group-chevron" aria-hidden="true"/>
      <span>{label}</span>
      <span className="day-group-count">{points.length} 点</span>
    </button>
    {open && <div className="day-group-body">
      {points.map(point => {
        const index = layer.points.findIndex(item => item.id === point.id);
        const leg: LegRef | null = index < layer.points.length - 1
          ? { layerId: layer.id, fromPointId: point.id, toPointId: layer.points[index + 1].id }
          : null;
        const rowColor = pointColor(point, layer, colorMode);
        return <div key={point.id} ref={el => registerRow(point.id, el)}
          className={`point-row ${selectedPointId === point.id ? 'selected' : ''} ${dragged === point.id ? 'dragging' : ''}`}
          draggable={editable && !busy}
          onDragStart={e => { onDragStart(point.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', point.id); }}
          onDragOver={e => { if (dragged) e.preventDefault(); }}
          // Dropping on a row takes that row's place, and its day: the group a
          // row is rendered in is the day it belongs to.
          onDrop={e => { if (!dragged) return; e.preventDefault(); e.stopPropagation(); setOver(false); onDrop(index, day); }}
          onDragEnd={onDragEnd}
          onMouseEnter={() => onHoverLeg(leg)} onMouseLeave={() => onHoverLeg(null)}
          onFocus={() => onHoverLeg(leg)} onBlur={() => onHoverLeg(null)}
          data-testid={`point-${point.id}`}>
          {/* Name, then the leg out of it. No day line: the group this row is in
              already says the day, and a second copy under every stop was a third
              of the row's height. Only an unscheduled stop, which has no group of
              its own to say where it is, keeps its coordinates. */}
          <button className="point-select" onClick={() => onSelect(point.id)}>{layer.kind === 'spots' ? <SpotMark icon={markerIcon('spots', point.icon)!} warn={point.warn}/> : <span className="point-number" style={{ borderColor: rowColor, color: rowColor }}>{String(index + 1).padStart(2, '0')}</span>}<span className="point-text"><strong>{point.name}{point.warn && <AlertTriangle size={12} aria-label="提醒"/>}</strong>{!point.day && <small>{`${point.at[0].toFixed(3)}°, ${point.at[1].toFixed(3)}°`}</small>}{point.flexibility && <small className="point-intent">{point.flexibility === 'fixed' ? '必须保留' : '允许调整'}</small>}{segmentInfo(layer, index) && <small className="segment-stat" title="至下一站">{segmentInfo(layer, index)}</small>}</span></button>
          {editable && <div className="point-actions">
            <button className="icon-button" aria-label={`在 ${point.name} 后添加`} title="在地图上点选新地点的位置" disabled={busy} onClick={() => onInsertAfter(point.id)}><Plus size={14}/></button>
            <button className="icon-button" aria-label={`上移 ${point.name}`} disabled={busy || index === 0} onClick={() => onReorder(point.id, index - 1)}><ArrowUp size={13}/></button>
            <button className="icon-button" aria-label={`下移 ${point.name}`} disabled={busy || index === layer.points.length - 1} onClick={() => onReorder(point.id, index + 1)}><ArrowDown size={13}/></button>
            <GripVertical size={13} className="drag-handle"/>
          </div>}
        </div>;
      })}
      {editable && points.length === 0 && <p className="day-group-empty">把地点拖到这里，安排进{label}</p>}
    </div>}
  </div>;
}

/**
 * One layer's stop list, floating beside the rail over the map stage.
 *
 * It is on screen while the pointer rests on the layer's dot in the rail or on
 * the list itself, and gone otherwise — the dot is the handle, so the list has
 * no folded form of its own. Points are grouped by itinerary day as collapsible
 * parents. The heading is two rows: the name, and a line of totals with the
 * tools beside it; everything about the layer that is not a stop is behind
 * 信息 in that line.
 */
export default function LayerPanel(props: LayerPanelProps) {
  const { layer, ordinal, selectedPointId, editable, busy, visible, colorMode = 'day', pinned, held, sticky, deliberate, onHoverLeg, onPeek } = props;
  const panelRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Drag source lives above the day groups: a drop can cross a day boundary.
  const [dragged, setDragged] = useState<string | null>(null);
  // Folding mid-drag would take the drop targets away from a stop already in
  // the air, so a drag holds the list open regardless of where the pointer is.
  const peek = usePeek<HTMLElement>({ pinned, hold: held || Boolean(dragged), subject: layer.id, grace: deliberate, sticky, eager: true });
  const registerRow = (pointId: string, el: HTMLDivElement | null) => { if (el) rowRefs.current.set(pointId, el); else rowRefs.current.delete(pointId); };

  // Keyboard entry point when the user opens the panel; tabIndex=-1 → no focus
  // ring. Initial page load renders the panel without stealing focus.
  useEffect(() => { if (props.grabFocus) panelRef.current?.focus(); }, []);
  useEffect(() => {
    if (selectedPointId) rowRefs.current.get(selectedPointId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedPointId]);
  useEffect(() => { onPeek(peek.open); }, [peek.open]);

  const days = layerDays(layer);
  // `pointColor`, not `planDayColor` directly: it is the rule the map draws by,
  // so a single-day plan or 图层 colour mode tints the list with exactly the
  // colour on the canvas instead of a shade the map never uses.
  const groups: { key: string; label: string; day: number | null; points: MapPoint[]; color: string | null }[] = days.map(day => ({
    key: `day-${day}`, label: `第 ${day} 天`, day, points: layer.points.filter(point => point.day === day),
    color: pointColor({ day }, layer, colorMode),
  }));
  const unscheduled = layer.points.filter(point => !point.day);
  // The unscheduled group stays on screen while a drag is in progress even when
  // it is empty: it is the drop target for "take this back off the itinerary",
  // and a target that vanishes as you reach for it cannot be used.
  if (unscheduled.length || (editable && dragged)) {
    groups.push({ key: 'unscheduled', label: '未排期', day: null, points: unscheduled, color: null });
  }

  return (
    <section id="layer-panel" className={`layer-panel ${visible ? '' : 'hidden-layer'}`}
      ref={element => { panelRef.current = element; peek.ref(element); }} {...peek.handlers}
      tabIndex={-1} aria-label={`${layer.name} 地点列表`}>
      <div className="panel-heading">
        <span className="plan-dot small" aria-hidden="true" style={{ '--layer-color': layer.color, '--dot-ink': dotInk(layer.color) } as CSSProperties}>{ordinal}</span>
        {/* One line, however long the name is: a phrase like 方案C · 高山湖泊线
            （苏黎世进出） ends in an ellipsis and the full text is in the tooltip.
            Two wrapped lines cost the list a row and made every heading a
            different height. `.panel-name`, not `.panel-title`: that one is the
            info panel's two-line title block, and on this element it wrapped
            the name over three lines at the page's base size. */}
        <strong className="panel-name" title={layer.name}>{layer.name}</strong>
        <PinButton pinned={pinned} label={`${layer.name} 的地点列表`} onPin={props.onPin}/>
        <button className="icon-button" aria-label={`关闭 ${layer.name} 的地点列表`} onClick={props.onClose}><X size={16}/></button>
      </div>
      <div className="panel-tools">
        <span className="panel-facts">{layerFacts(layer).map(fact => <small key={fact.key} title={fact.title}><b>{fact.value}</b>{fact.note && ` ${fact.note}`}</small>)}</span>
        <button className="icon-button" aria-label={`${layer.name} 的信息`} title="距离与时间依据、数据来源" onClick={props.onOpenInfo}><Info size={14}/></button>
        <button className="icon-button" aria-label={`缩放至 ${layer.name}`} title="缩放至这个图层" onClick={props.onFit}><LocateFixed size={14}/></button>
        <button className="icon-button" aria-label={`${visible ? '隐藏' : '显示'} ${layer.name}`} aria-pressed={!visible} title={visible ? '在地图上隐藏' : '在地图上显示'} onClick={props.onToggleVisible}>{visible ? <Eye size={14}/> : <EyeOff size={14}/>}</button>
        <button className="icon-button" aria-label={`只看 ${layer.name}`} title={`隐藏其他路线，只看 ${layer.name}`} onClick={props.onSolo}><Focus size={14}/></button>
        {editable && <button className="icon-button" aria-label={`设置 ${layer.name}`} title="名称、类型与颜色" onClick={props.onOpenSettings}><Settings2 size={14}/></button>}
      </div>
      <div className="panel-body">
        {layer.points.length > 0 ? (
          <div className="itinerary" aria-label={`${layer.name}地点列表`}>
            {groups.map(group => <DayGroup key={group.key} label={group.label} day={group.day} points={group.points} layer={layer} dayColor={group.color}
              selectedPointId={selectedPointId} editable={editable} busy={busy} colorMode={colorMode} defaultOpen
              dragged={dragged} onDragStart={setDragged} onDragEnd={() => setDragged(null)}
              onDrop={(toIndex, toDay) => { if (dragged) props.onReorder(dragged, toIndex, toDay); setDragged(null); }}
              onSelect={props.onSelect} onReorder={props.onReorder} onInsertAfter={props.onInsertAfter}
              onHoverLeg={onHoverLeg} registerRow={registerRow}/>)}
          </div>
        ) : (
          <p className="panel-empty">这个图层还没有地点{editable ? '，点击下方按钮添加第一个。' : '。'}</p>
        )}
        {editable && <button className="add-point" disabled={busy} onClick={props.onAddPoint}><Plus size={15}/>添加地点</button>}
      </div>
    </section>
  );
}
