import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Bike, Bus, Car, Footprints, Lock, Plane, Ship, TrainFront, Trash2, X } from 'lucide-react';
import type { MapLayer, MapPoint } from '../../core/types.js';
import { POINT_ICON_META, iconFill, markerIcon } from '../../core/icons.js';
import { routeDistance } from '../../core/geo.js';
import { POI_PATHS } from './poiIcons.js';
import { imageProxyUrl } from './geo.js';
import { luminance } from './dayColors.js';
import { TRAVEL_TIME_NOTE, formatDistance, formatDuration, legModeLabel, pointColor, segmentColor, transportKind, travelTimeLabel, type RouteColorMode, type TransportKind } from './legs.js';
import { usePeek } from './peek.js';
import PinButton from './PinButton.js';

/**
 * The cards that open from the map: one stop, one candidate spot, one leg.
 *
 * One template with fixed slots, always in this order — what the thing is and
 * which plan it belongs to; its marker and its name; the facts as chips; the
 * picture; the note; the planning intent; the way on to the next stop; the
 * actions. A field the data does not carry leaves no gap behind, and nothing
 * an Agent writes can change the arrangement, only which slots are filled.
 * The Agent's contract is the point's fields (`src/core/types.ts`), not a
 * markup language: a note is prose, an intent is an intent, a picture is an
 * HTTPS link Cartula fetches itself.
 *
 * Like every panel over the map a card folds to its title once the pointer
 * has moved on and opens again on hover (`peek.ts`); the title is the part
 * worth keeping, because it says which marker on the map is the selected one.
 */

const TRANSPORT_ICONS: Record<TransportKind, typeof Car> = {
  driving: Car, walking: Footprints, cycling: Bike, transit: Bus, flight: Plane, train: TrainFront, ferry: Ship,
};

export function TransportMark({ profile, size = 14, plain = false }: { profile?: string; size?: number; plain?: boolean }) {
  const kind = transportKind(profile);
  if (!kind) return null;
  const Icon = TRANSPORT_ICONS[kind];
  return <Icon size={size} className={plain ? undefined : 'transport-icon'} aria-hidden="true"/>;
}

/** Text that reads on this background: the same threshold as the plan rail's dots. */
const inkOn = (hex: string) => (luminance(hex) > 0.32 ? 'var(--ink)' : '#fff');

function kindLabel(layer: MapLayer): string {
  return layer.kind === 'route' ? '停靠点' : layer.kind === 'spots' ? '候选地点' : '地点';
}

function CardHeading({ kind, layerName, color, pinned, pinLabel, onPin, closeLabel, onClose }: {
  kind: string; layerName: string; color: string; pinned: boolean; pinLabel: string; onPin: (pinned: boolean) => void; closeLabel: string; onClose: () => void;
}) {
  return <div className="card-heading">
    <span className="card-kind" style={{ '--card-color': color } as CSSProperties}><i aria-hidden="true"/>{kind}<span className="card-layer" title={layerName}>{layerName}</span></span>
    <span className="card-tools">
      <PinButton pinned={pinned} label={pinLabel} onPin={onPin}/>
      <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}><X size={17}/></button>
    </span>
  </div>;
}

/** The marker as the card draws it: a stop's ordinal disc, or a spot's pictogram. */
function MarkerGlyph({ layer, point, index, color }: { layer: MapLayer; point: MapPoint; index: number; color: string }) {
  const icon = markerIcon(layer.kind, point.icon);
  if (!icon) {
    return <span className="card-glyph number" style={{ background: color, color: inkOn(color), '--glyph-color': color } as CSSProperties} aria-hidden="true">{index + 1}</span>;
  }
  const fill = iconFill(icon, 'light', point.warn);
  const path = POI_PATHS[icon];
  return <span className="card-glyph" style={{ background: fill, '--glyph-color': fill } as CSSProperties} aria-hidden="true">
    {path ? <svg viewBox="0 0 24 24" width="15" height="15"><path d={path} fill="#fff"/></svg> : <i className="card-glyph-dot"/>}
  </span>;
}

function Chip({ tone, color, icon, children }: { tone?: 'day' | 'warn' | 'fixed' | 'flag'; color?: string; icon?: ReactNode; children: ReactNode }) {
  return <span className={tone ? `chip ${tone}` : 'chip'} style={color ? { '--chip-color': color } as CSSProperties : undefined}>{icon}{children}</span>;
}

/**
 * A point's picture, fetched through Cartula's image proxy and shown only
 * once it has actually arrived. Until then it takes no room, and a link that
 * never answers leaves nothing behind — not a blank box, not a broken-image
 * glyph. Offline there is nothing to fetch, so there is nothing to show.
 */
export function CardImage({ src, alt, offline, compact }: { src?: string; alt: string; offline?: boolean; compact?: boolean }) {
  const url = offline ? undefined : imageProxyUrl(src);
  const ref = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // A picture the browser already holds can be complete before the load
  // handler is attached, so the element is asked as well as listened to.
  useEffect(() => {
    const img = ref.current;
    setState(img?.complete && img.naturalWidth > 0 ? 'ready' : 'loading');
  }, [url]);
  if (!url || state === 'failed') return null;
  return <figure className={compact ? 'card-media compact' : 'card-media'} data-state={state}>
    <img ref={ref} src={url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onLoad={() => setState('ready')} onError={() => setState('failed')}/>
  </figure>;
}

/** A note, three lines at a time. Long ones open on request rather than pushing the actions off the card. */
function NoteText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => { setExpanded(false); }, [text]);
  // Measured after every render, not only on mount: a folded card has no
  // height to measure, and the note is first laid out when the card opens.
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const next = el.scrollHeight > el.clientHeight + 1;
    if (next !== overflowing) setOverflowing(next);
  });
  return <>
    <p ref={ref} className={expanded ? 'card-note' : 'card-note clamped'}>{text}</p>
    {(overflowing || expanded) && <button type="button" className="card-more" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开全文'}</button>}
  </>;
}

export interface PointPopoverProps {
  layer: MapLayer; point: MapPoint; editable: boolean; busy: boolean; offline: boolean;
  colorMode?: RouteColorMode;
  pinned: boolean; onPin: (pinned: boolean) => void;
  onClose: () => void; onEdit: () => void; onMove: () => void; onDelete: () => Promise<void>;
}

/** The card for one stop or one candidate spot. */
export function PointPopover({ layer, point, editable, busy, offline, colorMode = 'day', pinned, onPin, onClose, onEdit, onMove, onDelete }: PointPopoverProps) {
  const peek = usePeek<HTMLElement>({ pinned, subject: `${layer.id} ${point.id}` });
  const index = layer.points.findIndex(item => item.id === point.id);
  const isRoute = layer.kind === 'route';
  // Only a route has a "next": candidate spots are a set, and the one listed
  // after this hotel is not somewhere anyone is going next.
  const next = isRoute ? layer.points[index + 1] : undefined;
  const leg = next ? layer.routing?.legs?.find(part => part.fromPointId === point.id && part.toPointId === next.id) : undefined;
  const profile = leg?.profile ?? layer.routing?.profile;
  const mode = legModeLabel(profile);
  const color = pointColor(point, layer, colorMode);
  const nights = point.day && next?.day && next.day > point.day ? next.day - point.day : undefined;
  const dayText = point.day ? (nights && nights > 1 ? `D${point.day}–${point.day + nights - 1} · ${nights} 晚` : `第 ${point.day} 天`) : undefined;
  const icon = markerIcon(layer.kind, point.icon);
  const iconLabel = icon && icon !== 'pin' ? POINT_ICON_META[icon].label : undefined;
  const distance = next ? (leg?.distanceKm !== undefined ? `${formatDistance(leg.distanceKm)} 路由` : `${formatDistance(routeDistance([point.at, next.at]))} 直线`) : undefined;
  const duration = leg?.durationMinutes !== undefined ? formatDuration(leg.durationMinutes) : undefined;
  const chips = Boolean(dayText || iconLabel || point.warn || point.flexibility || (isRoute && index === 0));
  return <section className="point-inspector point-popover" data-collapsed={!peek.open} data-kind={layer.kind} ref={peek.ref} {...peek.handlers} aria-label="地点">
    <CardHeading kind={kindLabel(layer)} layerName={layer.name} color={layer.color} pinned={pinned} pinLabel="地点卡片" onPin={onPin} closeLabel="关闭地点详情" onClose={onClose}/>
    <div className="card-title"><MarkerGlyph layer={layer} point={point} index={index} color={color}/><h2>{point.name}</h2></div>
    <div className="card-body">
      {chips && <div className="card-chips">
        {dayText && <Chip tone="day" color={color}>{dayText}</Chip>}
        {isRoute && index === 0 && <Chip>起点</Chip>}
        {iconLabel && <Chip>{iconLabel}</Chip>}
        {point.warn && <Chip tone="warn" icon={<AlertTriangle size={11}/>}>需留意</Chip>}
        {point.flexibility === 'fixed' && <Chip tone="fixed">必须保留</Chip>}
        {point.flexibility === 'flexible' && <Chip>允许调整</Chip>}
      </div>}
      <CardImage src={point.img} alt={point.name} offline={offline} compact/>
      {point.note && <NoteText text={point.note}/>}
      {point.intent && <div className="card-intent"><span className="eyebrow">规划意图</span><p>{point.intent}</p></div>}
      {isRoute && <p className="card-context">{next
        ? <><TransportMark profile={profile}/><span>下一站 <b>{next.name}</b>{mode ? ` · ${mode}` : ''} · {distance}{duration ? ` · ${duration}` : ''}</span></>
        : <span>终点 · 这个方案的最后一站</span>}</p>}
      {editable
        ? <div className="form-actions wrap card-actions">
          <button type="button" className="button danger quiet compact" aria-label={`删除 ${point.name}`} disabled={busy} onClick={() => void onDelete()}><Trash2 size={14}/>删除</button>
          <button type="button" className="button compact" disabled={busy} onClick={onMove}>移动</button>
          <button type="button" className="button primary compact" disabled={busy} onClick={onEdit}>编辑</button>
        </div>
        : <p className="card-readonly"><Lock size={11}/>只读地图 · 可以查看和导出</p>}
    </div>
  </section>;
}

export interface LegPopoverProps {
  layer: MapLayer; from: MapPoint; to: MapPoint; editable: boolean; busy: boolean; colorMode: RouteColorMode;
  /** The leg was opened by clicking it, so the insert lands on that spot. */
  atClick: boolean;
  pinned: boolean; onPin: (pinned: boolean) => void;
  onClose: () => void; onInsertHere: () => Promise<void>; onPickOnMap: () => void; onAvoid: () => Promise<void>; onDetail: () => void;
}

const TRAFFIC_LABELS = { clear: '畅通', moderate: '缓行', heavy: '拥堵', closed: '封路' } as const;

/** The card for one leg of a route. */
export function LegPopover({ layer, from, to, editable, busy, colorMode, atClick, pinned, onPin, onClose, onInsertHere, onPickOnMap, onAvoid, onDetail }: LegPopoverProps) {
  const peek = usePeek<HTMLElement>({ pinned, subject: `${layer.id} ${from.id} ${to.id}` });
  const leg = layer.routing?.legs?.find(part => part.fromPointId === from.id && part.toPointId === to.id);
  const profile = leg?.profile ?? layer.routing?.profile;
  const mode = legModeLabel(profile);
  const routed = leg?.distanceKm !== undefined;
  const distance = routed ? formatDistance(leg.distanceKm!) : formatDistance(routeDistance([from.at, to.at]));
  const traffic = leg?.traffic && leg.traffic !== 'unknown' ? leg.traffic : undefined;
  const flags = [leg?.border && '边境', leg?.toll && '收费', leg?.tunnel && '隧道', leg?.closed && '封路'].filter((flag): flag is string => Boolean(flag));
  const source = leg?.source ?? layer.routing?.source;
  const updated = (leg?.updatedAt ?? layer.routing?.updatedAt)?.replace('T', ' ').replace(/(?:\.\d+)?Z$/, '');
  const legColor = segmentColor({ color: leg?.color, fromPointId: from.id, toPointId: to.id }, layer, colorMode);
  return <section className="point-inspector leg-popover" data-collapsed={!peek.open} ref={peek.ref} {...peek.handlers} aria-label="路段详情">
    <CardHeading kind="路段" layerName={layer.name} color={legColor} pinned={pinned} pinLabel="路段卡片" onPin={onPin} closeLabel="关闭路段详情" onClose={onClose}/>
    <div className="card-title">
      <span className="card-glyph" style={{ background: legColor, color: inkOn(legColor), '--glyph-color': legColor } as CSSProperties} aria-hidden="true">{transportKind(profile) ? <TransportMark profile={profile} size={14} plain/> : <i className="card-glyph-dot"/>}</span>
      <h2>{from.name} → {to.name}</h2>
    </div>
    <div className="card-body">
      <div className="card-chips">
        {from.day ? <Chip tone="day" color={legColor}>第 {from.day} 天</Chip> : null}
        <Chip>{mode ?? '交通方式未提供'}</Chip>
        {traffic && <Chip tone={traffic === 'heavy' || traffic === 'closed' ? 'warn' : undefined}>路况 {TRAFFIC_LABELS[traffic]}</Chip>}
        {flags.map(flag => <Chip key={flag} tone="flag">{flag}</Chip>)}
      </div>
      <dl className="leg-facts">
        <dt>距离</dt><dd>{distance}<small>{routed ? '路由' : '直线估算'}</small></dd>
        <dt>{travelTimeLabel(profile)}</dt>
        <dd>{leg?.durationMinutes !== undefined ? <>{formatDuration(leg.durationMinutes)}<small>{TRAVEL_TIME_NOTE}</small></> : <span className="muted">没有时间数据，不会用距离推算</span>}</dd>
        {leg?.delayMinutes ? <><dt>延误</dt><dd>预计 {formatDuration(leg.delayMinutes)}</dd></> : null}
        {(source || updated) && <><dt>来源</dt><dd>{[source, updated && `更新于 ${updated}`].filter(Boolean).join(' · ')}</dd></>}
      </dl>
      {leg?.note && <NoteText text={leg.note}/>}
      <div className="form-actions wrap card-actions">
        {editable && <>
          {/* One press inserts the stop — no second click on the map. The label
              says where it will land, so the primary action is never a guess. */}
          <button type="button" className="button primary compact" disabled={busy} onClick={() => void onInsertHere()}
            title={atClick ? '在你点击的位置插入一个中途地点' : '在这段路线的中点插入一个中途地点'}>
            {atClick ? '在此插入地点' : '插入中途地点'}
          </button>
          <button type="button" className="button compact" disabled={busy} onClick={onPickOnMap} title="改为在地图上点选位置">在地图上点选…</button>
          <button type="button" className="button compact" disabled={busy} onClick={() => void onAvoid()}>避免这段</button>
        </>}
        <button type="button" className="button compact quiet" onClick={onDetail}>查看详情</button>
      </div>
      {!editable && <p className="card-readonly"><Lock size={11}/>只读地图 · 可以查看和导出</p>}
    </div>
  </section>;
}
