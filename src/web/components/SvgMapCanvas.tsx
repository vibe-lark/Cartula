import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Coord, MapLayer, MapPoint, PointIcon } from '../../core/types.js';
import { iconFill, markerIcon, pointLabel } from '../../core/icons.js';
import { layoutAnnotations } from './labels.js';
import type { MapCanvasProps } from './MapCanvas.js';
import type { MapWorkerState } from '../map-worker-health.js';
import { PIN_SIZE, pinExtent, pinSvgPath } from './markerIcons.js';
import { luminance } from './dayColors.js';

/* The same marker geometry as the WebGL canvas: an 11px-radius numbered disc
 * in a 5px halo, and a pin with a 24px head. */
const DISC_R = 11;
const HALO_PAD = 5;
const PIN_SCALE = 1.1;
const PIN_EXTENT = pinExtent(PIN_SIZE);
import { POI_PATHS, poiTheme } from './poiIcons.js';
import { ROUTE_OPACITY, ROUTE_WIDTH, backdropColor, backdropSegmentStyle, buildLegAnnotations, legKey, planSummary, pointColor, segmentColor, segmentStyle, type LegAnnotation } from './legs.js';
import {
  WARN_COLOR,
  type Bounds,
  divergenceAnchor,
  focusBounds,
  isValidCoord,
  mercatorLat,
  mercatorLng,
  mercatorX,
  mercatorY,
  padBounds,
  routeGeometry,
} from './geo.js';

interface View {
  /** Normalised Mercator window currently on screen. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface NodeDatum {
  key: string;
  point: MapPoint;
  layerId: string;
  color: string;
  index: number;
  selected: boolean;
  emphasized: boolean;
  /** Belongs to a plan that is not the selected one, while plans are compared. */
  backdrop: boolean;
  marker?: PointIcon;
  layerKind: MapLayer['kind'];
}

/** A backdrop plan's switch label, on the stretch where it differs. */
interface PlanChip {
  key: string;
  layerId: string;
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hovered: boolean;
}

interface LegPill {
  key: string;
  leg: LegAnnotation;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  hovered: boolean;
}

const LAND = '#eef1ea';
const GRID = '#c8d2c4';
const WORLD: View = { x0: 0, y0: 0, x1: 1, y1: 1 };

function viewFromBounds(b: Bounds | null, aspect: number): View {
  if (!b) return WORLD;
  const padded = padBounds(b);
  let x0 = mercatorX(padded.minLng);
  let x1 = mercatorX(padded.maxLng);
  let y0 = mercatorY(padded.maxLat);
  let y1 = mercatorY(padded.minLat);

  let w = Math.max(x1 - x0, 1e-6);
  let h = Math.max(y1 - y0, 1e-6);
  // Match the viewport's aspect so nothing is squashed.
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  x0 = cx - w / 2;
  x1 = cx + w / 2;
  y0 = cy - h / 2;
  y1 = cy + h / 2;
  return { x0, y0, x1, y1 };
}

function clampView(v: View): View {
  const w = Math.min(1, v.x1 - v.x0);
  const h = Math.min(1, v.y1 - v.y0);
  let { x0, y0 } = v;
  x0 = Math.max(0, Math.min(1 - w, x0));
  y0 = Math.max(0, Math.min(1 - h, y0));
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/**
 * SVG fallback for machines without WebGL2.
 *
 * Draws the same geometry as the deck.gl canvas — routes, warn dashes, spots,
 * GeoJSON outlines, numbered labels and per-leg annotation pills — on an
 * equirectangular-in-Mercator projection, and keeps every editing affordance:
 * selecting a node, dragging it and clicking to add. There is no basemap here
 * in either mode, so it makes no network requests at all.
 */
export default function SvgMapCanvas(props: MapCanvasProps & { fallbackReason?: 'webgl' | 'engine'; workerState?: MapWorkerState }): React.JSX.Element {
  const { layers, activeLayerId, selected, adding, editable, offline, fitLayerId, fitKey, legMode, colorMode = 'day', hoveredLeg, selectedLeg, onSelect, onSelectLeg, onActivateLayer, onAttribution, onMove, onAdd, insertFrom, insertTo, hoverAt, relocating, onHoverAt, focusAt, focusKey, mapStyle = 'positron' } =
    props;

  const [hoveredKey, setHoveredKey] = useState<string>();
  const [hoveredLegKey, setHoveredLegKey] = useState<string>();
  /** Pointer is over a backdrop plan: its line and chip come forward. */
  const [hoveredPlanId, setHoveredPlanId] = useState<string>();

  /* This canvas draws no basemap in either mode, so it owes credit to nobody
   * and says so — the About dialog then explains that the tiles are missing
   * rather than listing a provider whose data is not on screen. */
  const attributionRef = useRef(onAttribution);
  attributionRef.current = onAttribution;
  useEffect(() => { attributionRef.current?.([]); }, []);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>(WORLD);
  const [drag, setDrag] = useState<{
    key: string;
    layerId: string;
    pointId: string;
    at: Coord;
    /** Pointer start in local px, for the tap-vs-drag threshold. */
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{ px: number; py: number; view: View } | null>(null);
  const movedRef = useRef(false);
  /** Node under a view-only press: tap selects it, a drag stays a pan. */
  const pressedNodeRef = useRef<{ layerId: string; pointId: string } | null>(null);

  /* --------------------------------------------------------------- sizing */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const measure = (): void => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  /* -------------------------------------------------------------- framing */

  const bounds = useMemo(() => focusBounds(layers, fitLayerId, props.fitPointIds), [layers, fitLayerId, props.fitPointIds]);
  const aspect = size.w / Math.max(1, size.h);
  const hasFitted = useRef(false);
  const lastFitKey = useRef(fitKey);

  useEffect(() => {
    if (!bounds) return;
    const requested = fitKey !== lastFitKey.current;
    if (!requested && hasFitted.current) return;
    lastFitKey.current = fitKey;
    setView(clampView(viewFromBounds(bounds, aspect)));
    hasFitted.current = true;
  }, [fitKey, bounds, aspect]);

  const lastFocusKey = useRef(focusKey);
  useEffect(() => {
    if (!focusAt || !isValidCoord(focusAt)) return;
    if (focusKey === lastFocusKey.current) return;
    lastFocusKey.current = focusKey;
    const fx = mercatorX(focusAt[0]);
    const fy = mercatorY(focusAt[1]);
    setView(current => {
      const spanX = current.x1 - current.x0;
      const spanY = current.y1 - current.y0;
      if (spanX <= 0 || spanY <= 0) return current;
      const nx = (fx - current.x0) / spanX;
      const ny = (fy - current.y0) / spanY;
      // List/timeline focus should reveal an off-screen stop, not reframe a
      // cluster that is already visible — a fixed degree window can zoom OUT
      // and collapse labels onto each other.
      const margin = 0.18;
      if (nx >= margin && nx <= 1 - margin && ny >= margin && ny <= 1 - margin) return current;
      // Match MapLibre: pan at the current zoom; only zoom in if coarser than ~z7.
      const maxSpanX = Math.max(1e-6, size.w / (512 * 2 ** 7));
      const scale = spanX > maxSpanX ? maxSpanX / spanX : 1;
      const w = spanX * scale;
      const h = spanY * scale;
      return clampView({ x0: fx - w / 2, x1: fx + w / 2, y0: fy - h / 2, y1: fy + h / 2 });
    });
  }, [focusAt, focusKey, size.w]);

  /* ----------------------------------------------------------- projection */

  const project = useCallback(
    (at: Coord): { x: number; y: number } => ({
      x: ((mercatorX(at[0]) - view.x0) / (view.x1 - view.x0)) * size.w,
      y: ((mercatorY(at[1]) - view.y0) / (view.y1 - view.y0)) * size.h,
    }),
    [view, size],
  );

  const unproject = useCallback(
    (x: number, y: number): Coord => [
      mercatorLng(view.x0 + (x / size.w) * (view.x1 - view.x0)),
      mercatorLat(view.y0 + (y / size.h) * (view.y1 - view.y0)),
    ],
    [view, size],
  );

  const localPoint = useCallback((event: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  /* ------------------------------------------------------------ pan & zoom */

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (drag) return;
      const p = localPoint(event);
      panRef.current = { px: p.x, py: p.y, view };
      movedRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [drag, localPoint, view],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const p = localPoint(event);

      if (drag) {
        const moved = drag.moved || Math.abs(p.x - drag.sx) > 3 || Math.abs(p.y - drag.sy) > 3;
        setDrag({ ...drag, moved, at: unproject(p.x, p.y) });
        return;
      }
      if ((adding || relocating) && editable) onHoverAt?.(unproject(p.x, p.y));
      const pan = panRef.current;
      if (!pan) return;
      const dx = p.x - pan.px;
      const dy = p.y - pan.py;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
      const spanX = pan.view.x1 - pan.view.x0;
      const spanY = pan.view.y1 - pan.view.y0;
      setView(
        clampView({
          x0: pan.view.x0 - (dx / size.w) * spanX,
          x1: pan.view.x1 - (dx / size.w) * spanX,
          y0: pan.view.y0 - (dy / size.h) * spanY,
          y1: pan.view.y1 - (dy / size.h) * spanY,
        }),
      );
    },
    [adding, relocating, editable, drag, localPoint, onHoverAt, size, unproject],
  );

  const endDrag = useCallback(() => {
    if (!drag) return;
    onMove(drag.layerId, drag.pointId, drag.at);
    setDrag(null);
  }, [drag, onMove]);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag) {
        /* Pointer capture retargets the click to the svg, so node selection
         * must be settled here: a tap selects, a real drag commits the move. */
        if (!drag.moved) {
          setDrag(null);
          onSelect(drag.layerId, drag.pointId);
        } else {
          endDrag();
        }
        panRef.current = null;
        return;
      }
      const pressed = pressedNodeRef.current;
      pressedNodeRef.current = null;
      const wasPan = panRef.current;
      panRef.current = null;
      // View-only tap on a node selects it; a drag was a pan.
      if (wasPan && !movedRef.current && pressed) {
        onSelect(pressed.layerId, pressed.pointId);
        return;
      }
      // A click on empty map (not a pan) adds a node when in adding mode.
      if (wasPan && !movedRef.current && (adding || relocating) && editable) {
        const p = localPoint(event);
        onAdd(unproject(p.x, p.y));
      }
    },
    [adding, relocating, editable, drag, endDrag, localPoint, onAdd, onSelect, unproject],
  );

  /** A cancelled gesture is neither a tap nor a committed drag. */
  const onPointerCancel = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panRef.current = null;
    pressedNodeRef.current = null;
    setDrag(null);
  }, []);

  const onWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      const p = localPoint(event);
      const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
      const spanX = (view.x1 - view.x0) * factor;
      const spanY = (view.y1 - view.y0) * factor;
      if (spanX > 1.4 || spanX < 1e-6) return;
      // Keep the coordinate under the cursor fixed while zooming.
      const ax = p.x / size.w;
      const ay = p.y / size.h;
      const cx = view.x0 + ax * (view.x1 - view.x0);
      const cy = view.y0 + ay * (view.y1 - view.y0);
      setView(
        clampView({ x0: cx - ax * spanX, x1: cx + (1 - ax) * spanX, y0: cy - ay * spanY, y1: cy + (1 - ay) * spanY }),
      );
    },
    [localPoint, size, view],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const spanX = (view.x1 - view.x0) * factor;
      const spanY = (view.y1 - view.y0) * factor;
      if (spanX > 1.4 || spanX < 1e-6) return;
      const cx = (view.x0 + view.x1) / 2;
      const cy = (view.y0 + view.y1) / 2;
      setView(clampView({ x0: cx - spanX / 2, x1: cx + spanX / 2, y0: cy - spanY / 2, y1: cy + spanY / 2 }));
    },
    [view],
  );

  /* ------------------------------------------------------------- geometry */

  const graticuleLines = useMemo(() => {
    const out: { d: string; major: boolean }[] = [];
    for (let lng = -180; lng <= 180; lng += 15) {
      const pts: string[] = [];
      for (let lat = -80; lat <= 80; lat += 10) {
        const p = project([lng, lat]);
        pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      }
      out.push({ d: `M${pts.join('L')}`, major: lng === 0 });
    }
    for (let lat = -80; lat <= 80; lat += 15) {
      const pts: string[] = [];
      for (let lng = -180; lng <= 180; lng += 20) {
        const p = project([lng, lat]);
        pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      }
      out.push({ d: `M${pts.join('L')}`, major: lat === 0 });
    }
    return out;
  }, [project]);

  const toPath = useCallback(
    (coords: Coord[]): string => {
      const pts = coords.filter(isValidCoord).map((c) => {
        const p = project(c);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      });
      return pts.length >= 2 ? `M${pts.join('L')}` : '';
    },
    [project],
  );

  /** Active layer draws last, so its routes and nodes sit on top. */
  const ordered = useMemo(
    () => [...layers].sort((a, b) => (a.id === activeLayerId ? 1 : 0) - (b.id === activeLayerId ? 1 : 0)),
    [layers, activeLayerId],
  );

  /** Same rule as the deck.gl canvas: two or more routes, one of them selected. */
  const comparing = useMemo(() => {
    const routeLayers = layers.filter(layer => layer.kind === 'route');
    return routeLayers.length > 1 && routeLayers.some(layer => layer.id === activeLayerId);
  }, [layers, activeLayerId]);
  const isBackdrop = useCallback(
    (layer: MapLayer) => comparing && layer.kind === 'route' && layer.id !== activeLayerId,
    [comparing, activeLayerId],
  );

  const routes = useMemo(() => {
    const out: { key: string; d: string; color: string; width: number; dashed: boolean; opacity: number; backdrop: boolean; layerId?: string; fromPointId?: string; toPointId?: string }[] = [];
    ordered.forEach((layer) => {
      if (layer.kind !== 'route') return;
      const active = layer.id === activeLayerId;
      const behind = isBackdrop(layer);
      const geometry = routeGeometry(layer);
      geometry.segments.forEach((seg, i) => {
        const d = toPath(seg.coords);
        if (!d) return;
        // Same resolver as the deck.gl canvas: a stop reminder stays in the
        // route colour, supplied traffic gets its own hue.
        const style = segmentStyle(seg, layer, colorMode);
        const muted = behind ? backdropSegmentStyle(style, layer.id === hoveredPlanId) : undefined;
        out.push({
          key: `${layer.id}-${seg.fromPointId ?? i}-${seg.toPointId ?? 'path'}`,
          d,
          color: muted?.color ?? style.color,
          width: (active ? ROUTE_WIDTH.selected : ROUTE_WIDTH.backdrop) + (style.risk === 'none' || style.risk === 'reminder' ? 0 : 1),
          dashed: style.dashed,
          opacity: (muted?.alpha ?? ROUTE_OPACITY.selected) / 255,
          backdrop: behind,
          layerId: layer.id,
          fromPointId: seg.fromPointId,
          toPointId: seg.toPointId,
        });
      });
    });
    return out;
  }, [ordered, activeLayerId, toPath, colorMode, isBackdrop, hoveredPlanId]);

  const geojsonOutlines = useMemo(() => {
    const out: { key: string; d: string; color: string; width: number }[] = [];
    for (const layer of ordered) {
      if (!layer.geojson) continue;
      // GeoJSON gets the same active-layer emphasis as routes and nodes.
      const width = layer.id === activeLayerId ? 3.5 : 2;
      (layer.geojson.features ?? []).forEach((f, i) => {
        const g = f?.geometry;
        if (!g || g.type === 'Point') return;
        const rings: Coord[][] =
          g.type === 'LineString' || g.type === 'MultiPoint'
            ? [g.coordinates as Coord[]]
            : g.type === 'MultiLineString' || g.type === 'Polygon'
              ? (g.coordinates as Coord[][])
              : g.type === 'MultiPolygon'
                ? (g.coordinates as Coord[][][]).flat()
                : [];
        rings.forEach((ring, j) => {
          const d = toPath(ring);
          if (d) out.push({ key: `${layer.id}-${i}-${j}`, d, color: layer.color, width });
        });
      });
    }
    return out;
  }, [ordered, activeLayerId, toPath]);

  const nodes = useMemo((): NodeDatum[] => {
    const out: NodeDatum[] = [];
    for (const layer of ordered) {
      const emphasized = layer.id === activeLayerId;
      const backdrop = isBackdrop(layer);
      (layer.points ?? []).forEach((point, index) => {
        if (!isValidCoord(point.at)) return;
        out.push({
          key: `${layer.id} ${point.id}`,
          point,
          layerId: layer.id,
          // Stops carry the day shade too, so the marker and the leg leaving
          // it are the same colour and the sidebar agrees with the map.
          color: pointColor(point, layer, colorMode),
          index,
          selected: selected?.layerId === layer.id && selected?.pointId === point.id,
          emphasized,
          backdrop,
          marker: markerIcon(layer.kind, point.icon),
          layerKind: layer.kind,
        });
      });
    }
    return out;
  }, [ordered, activeLayerId, selected, colorMode, isBackdrop]);

  // Hover runs both ways, as in MapCanvas: the open list marks this stop's row.
  useEffect(() => {
    const node = hoveredKey ? nodes.find(n => n.key === hoveredKey) : undefined;
    props.onHoverPoint?.(node ? { layerId: node.layerId, pointId: node.point.id } : null);
  }, [hoveredKey]);

  const legAnnotations = useMemo(() => buildLegAnnotations(layers, colorMode), [layers, colorMode]);

  /** Single-leg preview for the hovered pill/sidebar row. Uses the labelled
   * segment; an unlabelled layer.path has no leg-to-subpath correspondence. */
  const highlightLeg = useMemo((): { d: string; color: string; width: number } | null => {
    const key = hoveredLegKey ?? (hoveredLeg ? legKey(hoveredLeg) : undefined) ?? (selectedLeg ? legKey(selectedLeg) : undefined);
    if (!key) return null;
    const leg = legAnnotations.find(a => legKey(a) === key);
    const layer = leg ? layers.find(l => l.id === leg.layerId) : undefined;
    if (!leg || !layer) return null;
    const seg = routeGeometry(layer).segments.find(s => s.fromPointId === leg.fromPointId && s.toPointId === leg.toPointId);
    if (!seg || seg.coords.length < 2) return null;
    const d = toPath(seg.coords);
    if (!d) return null;
    const segColor = leg.color ?? segmentColor(seg, layer, colorMode);
    return { d, color: segColor, width: (layer.id === activeLayerId ? 6 : 4) + 3 };
  }, [hoveredLegKey, hoveredLeg, selectedLeg, legAnnotations, layers, activeLayerId, toPath, colorMode]);

  /** Legs that must show regardless of density: hovered/selected adjacency,
   * sidebar row hover and pill hover. */
  const forcedLegKeys = useMemo(() => {
    const keys = new Set<string>();
    const adjacent = (layerId: string, pointId: string) => {
      for (const leg of legAnnotations) {
        if (leg.layerId === layerId && (leg.fromPointId === pointId || leg.toPointId === pointId)) keys.add(legKey(leg));
      }
    };
    const hoveredNode = hoveredKey ? nodes.find(n => n.key === hoveredKey) : undefined;
    if (hoveredNode) adjacent(hoveredNode.layerId, hoveredNode.point.id);
    if (selected) adjacent(selected.layerId, selected.pointId);
    if (hoveredLeg) keys.add(legKey(hoveredLeg));
    if (selectedLeg) keys.add(legKey(selectedLeg));
    if (hoveredLegKey) keys.add(hoveredLegKey);
    return keys;
  }, [legAnnotations, hoveredKey, selected, hoveredLeg, selectedLeg, hoveredLegKey, nodes]);

  /**
   * One switch chip per backdrop plan, anchored where it differs most from the
   * selected one. Same rule and same helper as the deck.gl canvas.
   */
  const planChips = useMemo(() => {
    if (!comparing) return [] as { key: string; layerId: string; text: string; color: string; anchor: Coord; before?: Coord; after?: Coord }[];
    const lines = new Map<string, Coord[]>();
    for (const layer of layers) {
      if (layer.kind !== 'route') continue;
      const coords: Coord[] = [];
      for (const seg of routeGeometry(layer).segments) coords.push(...seg.coords);
      lines.set(layer.id, coords);
    }
    const reference = lines.get(activeLayerId ?? '') ?? [];
    const out: { key: string; layerId: string; text: string; color: string; anchor: Coord; before?: Coord; after?: Coord }[] = [];
    for (const layer of layers) {
      if (!isBackdrop(layer)) continue;
      const spot = divergenceAnchor(lines.get(layer.id) ?? [], reference);
      if (!spot) continue;
      out.push({ key: `plan-chip ${layer.id}`, layerId: layer.id, text: planSummary(layer), color: layer.color, anchor: spot.at, before: spot.before, after: spot.after });
    }
    return out;
  }, [comparing, layers, activeLayerId, isBackdrop]);

  const annotationLayout = useMemo(() => {
    const zoom = Math.log2(size.w / (512 * (view.x1 - view.x0)));
    const nodeInputs = nodes.map(node => {
      const p = project(drag?.key === node.key ? drag.at : node.point.at);
      const layer = layers.find(layer => layer.id === node.layerId);
      return { ...node, name: pointLabel(node.index, node.point.name, node.layerKind, !node.marker), x: p.x, y: p.y, hovered: node.key === hoveredKey, dimmed: node.backdrop, endpoint: node.index === 0 || node.index === (layer?.points.length ?? 0) - 1, markerRadius: node.marker ? PIN_EXTENT.halfWidth : DISC_R + HALO_PAD, markerTop: node.marker ? PIN_EXTENT.top : DISC_R + HALO_PAD };
    });
    const legInputs = legMode === 'off' ? [] : legAnnotations.flatMap(leg => {
      const key = legKey(leg);
      const forced = forcedLegKeys.has(key);
      // A backdrop plan's own numbers step aside in auto mode; its chip speaks
      // for it. Hover brings the pill back, and 全部 still means all.
      if (comparing && legMode === 'auto' && leg.layerId !== activeLayerId && !forced) return [];
      const a = project(leg.from.at);
      const b = project(leg.to.at);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const m = project(leg.anchor);
      return [{ key, text: leg.text, ax: m.x, ay: m.y, dirX: len > 0 ? dx / len : 1, dirY: len > 0 ? dy / len : 0, lengthPx: len, active: leg.layerId === activeLayerId, forced: forced || leg.important }];
    });
    const chipInputs = planChips.map(chip => {
      const a = project(chip.before ?? chip.anchor);
      const b = project(chip.after ?? chip.anchor);
      const m = project(chip.anchor);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      return { key: chip.key, text: chip.text, ax: m.x, ay: m.y, dirX: len > 0 ? dx / len : 1, dirY: len > 0 ? dy / len : 0, lengthPx: len, active: false, forced: true };
    });
    return layoutAnnotations(nodeInputs, legInputs, size.w, size.h, zoom, { mode: legMode, chips: chipInputs });
  }, [nodes, layers, project, drag, hoveredKey, size, view, legAnnotations, forcedLegKeys, activeLayerId, legMode, comparing, planChips]);
  const placedLabels = annotationLayout.labels;
  const placedLegLabels = annotationLayout.legs;
  const placedPlanChips = useMemo((): PlanChip[] => {
    const byKey = new Map(planChips.map(chip => [chip.key, chip]));
    const out: PlanChip[] = [];
    for (const placed of annotationLayout.chips) {
      const chip = byKey.get(placed.key);
      if (chip) out.push({ ...placed, layerId: chip.layerId, color: chip.color, hovered: chip.layerId === hoveredPlanId });
    }
    return out;
  }, [annotationLayout, planChips, hoveredPlanId]);
  const labelMap = new Map(placedLabels.map(label => [label.key, label]));

  /** Pill geometry joined back to its leg for colour, aria text and clicks. */
  const legPills = useMemo((): LegPill[] => {
    const byKey = new Map<string, LegAnnotation>(legAnnotations.map(a => [legKey(a), a]));
    const out: LegPill[] = [];
    for (const p of placedLegLabels) {
      const leg = byKey.get(p.key);
      if (!leg) continue;
      out.push({
        key: p.key,
        leg,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        text: p.text,
        hovered: p.key === hoveredLegKey || (hoveredLeg ? legKey(hoveredLeg) === p.key : false) || (selectedLeg ? legKey(selectedLeg) === p.key : false),
      });
    }
    return out;
  }, [placedLegLabels, legAnnotations, hoveredLegKey, hoveredLeg, selectedLeg]);

  /* Any GeoJSON point features, drawn as small dots. */
  const geojsonDots = useMemo(() => {
    const out: { key: string; x: number; y: number; color: string; r: number }[] = [];
    for (const layer of ordered) {
      if (!layer.geojson) continue;
      const r = layer.id === activeLayerId ? 4.5 : 3.5;
      (layer.geojson.features ?? []).forEach((f, i) => {
        const g = f?.geometry;
        if (!g) return;
        const coords: Coord[] =
          g.type === 'Point'
            ? [g.coordinates]
            : g.type === 'MultiPoint'
              ? (g.coordinates as Coord[])
              : [];
        coords.forEach((c, j) => {
          if (!isValidCoord(c)) return;
          const p = project(c);
          out.push({
            key: `${layer.id}-gd-${i}-${j}`,
            x: p.x,
            y: p.y,
            color: layer.color,
            r,
          });
        });
      });
    }
    return out;
  }, [ordered, activeLayerId, project]);

  const positionOf = (d: NodeDatum): Coord => (drag && drag.key === d.key ? drag.at : d.point.at);

  const startNodeDrag = useCallback(
    (event: React.PointerEvent, d: NodeDatum) => {
      if (!editable) return;
      event.stopPropagation();
      const p = localPoint(event);
      setDrag({ key: d.key, layerId: d.layerId, pointId: d.point.id, at: positionOf(d), sx: p.x, sy: p.y, moved: false });
      // Capture on the svg so the pointer can leave the small circle.
      svgRef.current?.setPointerCapture(event.pointerId);
    },
    // positionOf reads `drag`, which is null at drag start by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, localPoint],
  );

  const dash = Math.max(6, Math.min(18, size.w / 60));

  return (
    <div
      ref={hostRef}
      className="map-canvas"
      data-mode="svg"
      data-worker={props.workerState ?? 'idle'}
      data-fallback={props.fallbackReason ?? 'webgl'}
      data-label-count={placedLabels.length}
      data-label-keys={JSON.stringify(placedLabels.map(label => label.key))}
      data-leg-label-count={placedLegLabels.length}
      data-leg-label-keys={JSON.stringify(placedLegLabels.map(label => label.key))}
      aria-label="地图画布"
      style={{ position: 'relative', width: '100%', height: '100%', background: LAND, overflow: 'hidden' }}
    >
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        role="presentation"
        style={{
          position: 'absolute',
          inset: 0,
          touchAction: 'none',
          cursor: drag ? 'grabbing' : (adding || relocating) && editable ? 'crosshair' : 'grab',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => onHoverAt?.(null)}
        onWheel={onWheel}
      >
        <rect x={0} y={0} width={size.w} height={size.h} fill={LAND} />
        <g>
          {graticuleLines.map((l, i) => (
            <path key={i} d={l.d} fill="none" stroke={GRID} strokeWidth={l.major ? 1.4 : 0.7} />
          ))}
        </g>

        {geojsonOutlines.map((o) => (
          <path
            key={o.key}
            d={o.d}
            fill={o.color}
            fillOpacity={0.14}
            stroke={o.color}
            strokeWidth={o.width}
            strokeOpacity={0.9}
            strokeLinejoin="round"
          />
        ))}

        {/* Paper under every backdrop line, so a faded route reads as glass
            over the map rather than as a line that failed to draw. */}
        {routes.filter(r => r.backdrop).map((r) => (
          <path key={`casing-${r.key}`} d={r.d} fill="none" stroke="#fffdf8" strokeOpacity={0.6}
            strokeWidth={r.width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
        ))}

        {routes.map((r) => (
          <path
            key={r.key}
            data-layer={r.layerId}
            data-backdrop={r.backdrop}
            d={r.d}
            fill="none"
            stroke={r.color}
            strokeOpacity={r.opacity}
            strokeWidth={r.width}
            strokeLinecap={r.dashed ? 'butt' : 'round'}
            strokeLinejoin="round"
            strokeDasharray={r.dashed ? `${dash} ${dash * 0.75}` : undefined}
            style={{ cursor: r.fromPointId || r.backdrop ? 'pointer' : undefined }}
            onPointerEnter={r.backdrop ? () => setHoveredPlanId(r.layerId) : undefined}
            onPointerLeave={r.backdrop ? () => setHoveredPlanId(undefined) : undefined}
            onPointerDown={r.fromPointId || r.backdrop ? (e) => e.stopPropagation() : undefined}
            onClick={r.fromPointId || r.backdrop ? (e) => {
              e.stopPropagation();
              // A press on a backdrop plan asks for that plan, not for one of
              // its legs; the leg is one press away once it is drawn in full.
              if (r.backdrop && onActivateLayer) { setHoveredPlanId(undefined); onActivateLayer(r.layerId!); return; }
              if (!r.fromPointId) return;
              // Where the pointer met the line, so a mid-stop lands there
              // rather than at the segment's midpoint.
              const p = localPoint(e);
              if (onSelectLeg) onSelectLeg(r.layerId!, r.fromPointId!, r.toPointId!, unproject(p.x, p.y));
              else onSelect(r.layerId!, r.fromPointId!);
            } : undefined}
          />
        ))}

        {highlightLeg ? (
          <path
            d={highlightLeg.d}
            fill="none"
            stroke={highlightLeg.color}
            strokeWidth={highlightLeg.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        ) : null}

        {adding && insertFrom && hoverAt ? (
          <path
            d={toPath([insertFrom, hoverAt, ...(insertTo ? [insertTo] : [])])}
            fill="none"
            stroke="#4c947a"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="6 5"
            pointerEvents="none"
          />
        ) : null}
        {adding && hoverAt ? (
          <circle cx={project(hoverAt).x} cy={project(hoverAt).y} r={7} fill="#4c947a" stroke="#fff" strokeWidth={2} pointerEvents="none" />
        ) : null}

        {geojsonDots.map((d) => (
          <circle key={d.key} cx={d.x} cy={d.y} r={d.r} fill={d.color} />
        ))}

        {legPills.map((pill) => {
          const fontSize = pill.hovered ? 13 : 11;
          /* measureLeg's box already includes the pill padding — drawing extra
           * padding here would spill past the space the layout reserved. */
          const w = pill.width * (pill.hovered ? fontSize / 11 : 1);
          const h = pill.height * (pill.hovered ? fontSize / 11 : 1);
          return (
            <g
              key={pill.key}
              className="map-leg-label"
              transform={`translate(${pill.x.toFixed(1)} ${pill.y.toFixed(1)})`}
              onPointerEnter={() => setHoveredLegKey(pill.key)}
              onPointerLeave={() => setHoveredLegKey(undefined)}
              /* Without this the svg's pan handler captures the pointer,
               * retargeting the click away from the pill (and, in adding
               * mode, spawning a node under it). */
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                // The pill sits beside the line: the leg's own anchor is the
                // honest insertion point, not where the label happens to be.
                if (onSelectLeg) onSelectLeg(pill.leg.layerId, pill.leg.fromPointId, pill.leg.toPointId, pill.leg.anchor);
                else onSelect(pill.leg.layerId, pill.leg.fromPointId);
              }}
              style={{ cursor: 'pointer' }}
            >
              <title>{pill.leg.ariaText}</title>
              <rect
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                rx={6}
                fill="#fffefa"
                fillOpacity={pill.hovered ? 0.96 : 0.88}
                stroke="#e2e7df"
                strokeWidth={1}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fontWeight={600}
                fill={pill.leg.warn ? WARN_COLOR : '#263c36'}
                style={{ userSelect: 'none' }}
              >
                {pill.text}
              </text>
            </g>
          );
        })}

        {/* The way back to a plan the map is not showing in full. */}
        {placedPlanChips.map((chip) => (
          <g key={chip.key} transform={`translate(${chip.x} ${chip.y})`}
            onPointerEnter={() => setHoveredPlanId(chip.layerId)}
            onPointerLeave={() => setHoveredPlanId(undefined)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setHoveredPlanId(undefined); onActivateLayer?.(chip.layerId); }}
            style={{ cursor: 'pointer' }}>
            <title>{`切换到 ${chip.text}`}</title>
            <rect x={-chip.width / 2 - 3} y={-chip.height / 2} width={chip.width + 6} height={chip.height} rx={7}
              fill={chip.hovered ? chip.color : '#fffefa'} fillOpacity={chip.hovered ? 0.96 : 0.93}
              stroke={chip.color} strokeOpacity={0.86} strokeWidth={1.5}/>
            {/* Identity on the border, not in the text: see the deck.gl canvas. */}
            <text textAnchor="middle" dominantBaseline="central" fontSize={chip.hovered ? 12 : 11} fontWeight={600}
              fill={chip.hovered ? '#fffdf8' : '#263c36'} style={{ userSelect: 'none' }}>{chip.text}</text>
          </g>
        ))}

        {nodes.map((d) => {
          const p = project(positionOf(d));
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
          const label = labelMap.get(d.key);
          const markFill = d.marker ? iconFill(d.marker, poiTheme(mapStyle), d.point.warn) : d.color;
          const fill = d.backdrop ? backdropColor(d.point.warn ? WARN_COLOR : markFill) : d.point.warn && !d.marker ? WARN_COLOR : markFill;
          const r = d.selected ? DISC_R + 2 : d.backdrop ? DISC_R - 2 : DISC_R;
          const ink = luminance(fill) > 0.32 ? '#16211f' : '#ffffff';
          const pinScale = PIN_SCALE * (d.selected ? 1.2 : d.backdrop ? 0.85 : 1);
          const pictogram = d.marker ? POI_PATHS[d.marker] : '';
          return (
            <g key={d.key} opacity={d.backdrop ? 0.88 : 1} onPointerEnter={() => setHoveredKey(d.key)} onPointerLeave={() => setHoveredKey(undefined)}><title>{d.point.name}</title>
              {label && <text className="map-point-label" x={label.x} y={label.y - 4} textAnchor="middle" fontSize={d.selected || d.key === hoveredKey ? 14 : d.emphasized ? 13 : d.backdrop ? 11 : 12} fontWeight={600} fill={d.backdrop ? '#586860' : '#16211f'} stroke="#fffdf8" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {label.text.split('\n').map((line, i, lines) => <tspan key={i} x={label.x} dy={i ? '1.25em' : `${-(lines.length - 1) * 1.25}em`}>{line}</tspan>)}
              </text>}
              {d.marker ? (
                <g transform={`translate(${p.x} ${p.y}) scale(${pinScale})`}
                  style={{ cursor: editable ? 'grab' : 'pointer' }}
                  onPointerDown={(e) => {
                    if (editable) startNodeDrag(e, d);
                    else pressedNodeRef.current = { layerId: d.layerId, pointId: d.point.id };
                  }}>
                  <circle cx={0} cy={-22} r={16.5} fill={fill} fillOpacity={d.backdrop ? 0.14 : 0.22} style={{ pointerEvents: 'none' }}/>
                  <path d={pinSvgPath()} fill={fill} stroke={d.selected ? '#16211f' : '#ffffff'} strokeWidth={d.selected ? 2.6 : 2}/>
                  {pictogram
                    ? <g transform="translate(0 -22) scale(0.5) translate(-12 -12)" style={{ pointerEvents: 'none' }}><path d={pictogram} fill="#fffdf8"/></g>
                    : <circle cx={0} cy={-22} r={4.5} fill="#fffdf8" style={{ pointerEvents: 'none' }}/>}
                  <circle cx={0} cy={-8} r={16} fill="transparent"/>
                </g>
              ) : (
                <>
                  <circle cx={p.x} cy={p.y} r={r + HALO_PAD} fill={fill} fillOpacity={d.backdrop ? 0.16 : 0.24} pointerEvents="none"/>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={fill}
                    stroke={d.selected ? '#16211f' : '#ffffff'}
                    strokeWidth={d.selected ? 3 : 2.5}
                    style={{ cursor: editable ? 'grab' : 'pointer' }}
                    onPointerDown={(e) => {
                      if (editable) startNodeDrag(e, d);
                      else pressedNodeRef.current = { layerId: d.layerId, pointId: d.point.id };
                    }}
                  />
                  <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fontSize={Math.round(r * (d.index >= 9 ? 0.95 : 1.1))} fontWeight={700} fill={ink} fillOpacity={d.backdrop ? 0.85 : 1} pointerEvents="none" style={{ userSelect: 'none' }}>{d.index + 1}</text>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r + 8}
                    fill="transparent"
                    style={{ cursor: editable ? 'grab' : 'pointer' }}
                    onPointerDown={(e) => {
                      if (editable) startNodeDrag(e, d);
                      else pressedNodeRef.current = { layerId: d.layerId, pointId: d.point.id };
                    }}
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="svg-zoom">
        <button type="button" aria-label="放大" onClick={() => zoomBy(1 / 1.4)}>
          ＋
        </button>
        <button type="button" aria-label="缩小" onClick={() => zoomBy(1.4)}>
          －
        </button>
      </div>

      <div style={noticeStyle} role="status">
        {offline
          ? '离线模式 · 坐标网格视图，编辑功能完整'
          : props.fallbackReason === 'engine'
            ? '地图引擎受限，已切换为无底图的简化视图，编辑功能完整'
            : '当前设备无法使用 WebGL，已切换为无底图的简化视图，编辑功能完整'}
      </div>

      {adding && editable ? <div style={addHintStyle}>点击地图添加节点</div> : null}
    </div>
  );
}

const noticeStyle: React.CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  zIndex: 2,
  maxWidth: 'calc(100% - 90px)',
  padding: '5px 10px',
  borderRadius: 8,
  background: 'rgba(255,253,248,0.94)',
  border: '1px solid rgba(22,33,31,0.12)',
  color: '#475652',
  font: '500 12px/1.5 system-ui, -apple-system, "PingFang SC", sans-serif',
  pointerEvents: 'none',
};

const addHintStyle: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 12,
  transform: 'translateX(-50%)',
  zIndex: 3,
  padding: '6px 14px',
  borderRadius: 999,
  background: 'rgba(13,95,84,0.94)',
  color: '#fff',
  font: '600 13px/1.5 system-ui, -apple-system, "PingFang SC", sans-serif',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};
