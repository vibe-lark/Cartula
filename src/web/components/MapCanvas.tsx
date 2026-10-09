import * as maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import type { Coord, MapLayer, MapPoint, PointIcon } from '../../core/types.js';
import { markerIcon, pointLabel } from '../../core/icons.js';
import SvgMapCanvas from './SvgMapCanvas.js';
import { watchMapWorker, type MapWorkerState } from '../map-worker-health.js';
import { PIN_ICON_MAPPING, PIN_SIZE, pinExtent, pinIconAtlas } from './markerIcons.js';
import { applyBasemapPoiIcons, pinAtlasIcon, poiTheme } from './poiIcons.js';
import { basemapPlaceName, localizeBasemap, type MapLanguage, type MapStyle } from './preferences.js';
import { layoutAnnotations, type PlacedLegLabel } from './labels.js';
import { ROUTE_OPACITY, ROUTE_WIDTH, backdropColor, backdropSegmentStyle, buildLegAnnotations, legKey, planSummary, pointColor, segmentColor, segmentStyle, type LegAnnotation, type LegLabelMode, type LegRef, type RouteColorMode } from './legs.js';
import {
  WARN_COLOR,
  dashLengthKm,
  dashSegments,
  divergenceAnchor,
  focusBounds,
  graticule,
  hexToRgba,
  isValidCoord,
  padBounds,
  readBasemapConfig,
  routeGeometry,
  type RGBA,
} from './geo.js';

/** How far a marker's halo reaches past its disc, in px. */
const HALO_PAD = 5;

export interface MapCanvasSelection {
  layerId: string;
  pointId: string;
}

export interface MapCanvasProps {
  /** Already filtered for visibility by the caller. */
  layers: MapLayer[];
  /**
   * The emphasized plan: drawn wider, at full strength and on top.
   *
   * With a second route layer on the map the others become its backdrop —
   * faded, still readable, and clickable to switch. With only one route layer
   * there is nothing to compare, and nothing is faded.
   */
  activeLayerId: string | null;
  selected: MapCanvasSelection | null;
  adding: boolean;
  editable: boolean;
  offline: boolean;
  /** Camera framing target only. */
  fitLayerId: string | null;
  /** Narrows the framing to these stops of `fitLayerId` — one itinerary day. */
  fitPointIds?: readonly string[] | null;
  fitKey: number;
  /** On-map leg annotations: auto density, everything, or hidden. */
  legMode: LegLabelMode;
  /** Route colouring: one colour per layer (default) or per itinerary day. */
  colorMode?: RouteColorMode;
  /** Leg hovered in the sidebar list: its pill is force-shown and highlighted. */
  hoveredLeg: LegRef | null;
  selectedLeg?: LegRef | null;
  onSelect: (layerId: string, pointId: string) => void;
  /**
   * A leg was picked. `at` is where the pointer actually landed on it, so an
   * insertion can happen there rather than at the segment's midpoint.
   */
  onSelectLeg?: (layerId: string, fromPointId: string, toPointId: string, at?: Coord) => void;
  /**
   * A backdrop plan was picked — its line or its chip. Switching to it is what
   * the pick means; nothing is selected and the camera does not move.
   */
  onActivateLayer?: (layerId: string) => void;
  /**
   * The basemap's own credits, as the loaded style reports them. Sent on every
   * style change so the About dialog names whatever is actually on screen; an
   * empty list means no basemap data is being displayed at all.
   */
  onAttribution?: (credits: string[]) => void;
  onMove: (layerId: string, pointId: string, at: Coord) => void;
  /** A spot picked for a new stop; `name` is the basemap label under it, when there is one. */
  onAdd: (at: Coord, name?: string) => void;
  /** The stop under the pointer on the map, so the open list can mark its row. */
  onHoverPoint?: (point: MapCanvasSelection | null) => void;
  insertFrom?: Coord | null;
  insertTo?: Coord | null;
  hoverAt?: Coord | null;
  relocating?: boolean;
  onHoverAt?: (at: Coord | null) => void;
  /** Pan the camera to this coordinate when `focusKey` bumps (timeline / list). */
  focusAt?: Coord | null;
  focusKey?: number;
  /** Basemap style and label language, owned by the workspace's top bar. */
  mapStyle?: MapStyle;
  mapLanguage?: MapLanguage;
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

interface PathDatum {
  coords: Coord[];
  color: RGBA;
  width: number;
  layerId?: string;
  fromPointId?: string;
  toPointId?: string;
}

/** A backdrop plan's switch label, anchored where it differs from the selected one. */
interface PlanChip {
  key: string;
  layerId: string;
  text: string;
  anchor: Coord;
  color: string;
  /** Neighbouring vertices, for the label's direction on screen. */
  before?: Coord;
  after?: Coord;
}

interface PlanPill extends PlacedLegLabel {
  layerId: string;
  anchor: Coord;
  color: string;
}

interface LegPill extends PlacedLegLabel {
  anchor: Coord;
  warn: boolean;
  layerId: string;
  fromPointId: string;
  toPointId: string;
}

const LAND = '#eef1ea';
const GRID = '#c8d2c4';
/** A reminder marker on a backdrop plan: frosted like the rest of that plan. */
const WARN_BACKDROP = backdropColor(WARN_COLOR);

/**
 * A stop's drawn colour. Backdrop stops fade with the line that joins them —
 * vivid dots over a frosted route would put the eye back on the plan the user
 * is not reading — but they stay opaque enough to be found and picked.
 */
function nodeColor(node: { point: MapPoint; color: string; backdrop: boolean }): RGBA {
  if (node.backdrop) return hexToRgba(node.point.warn ? WARN_BACKDROP : backdropColor(node.color), 225);
  return hexToRgba(node.point.warn ? WARN_COLOR : node.color, 255);
}

/** Fully inline style: no tiles, glyphs or sprites, so nothing is requested. */
function offlineStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: { graticule: { type: 'geojson', data: graticule() as never } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': LAND } },
      {
        id: 'grid',
        type: 'line',
        source: 'graticule',
        paint: { 'line-color': GRID, 'line-width': ['case', ['get', 'major'], 1.4, 0.7] },
      },
    ],
  };
}

function onlineStyle(style: MapStyle): maplibregl.StyleSpecification | string {
  if (window.__CARTULA_CONFIG__?.styleUrl) return window.__CARTULA_CONFIG__.styleUrl.replace(/\/styles\/(positron|liberty|bright|dark)$/, `/styles/${style}`);
  const { tileUrl, attribution, maxZoom } = readBasemapConfig();
  return {
    version: 8,
    sources: {
      basemap: { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: maxZoom, attribution },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': LAND } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}

/**
 * What the basemap on screen owes credit to, in the provider's own words.
 *
 * Cartula does not hard-code who that is. A deployment points the App at a
 * style or a tile URL, and the credit for it arrives with the data: declared on
 * the style's sources, or — for OpenMapTiles-shaped vector sources, where it is
 * the usual place — in the TileJSON that lands on the live source object a
 * moment later. The configured `tileAttribution` is the last resort, so a
 * provider that states nothing still gets named.
 *
 * Offline mode requests nothing and draws a bare graticule, so it credits
 * nobody: there is no map data on screen to attribute.
 */
function basemapCredits(map: maplibregl.Map, offline: boolean): string[] {
  if (offline) return [];
  const out: string[] = [];
  const sources = map.getStyle()?.sources ?? {};
  for (const id of Object.keys(sources)) {
    const live = (map.getSource(id) as { attribution?: string } | undefined)?.attribution;
    const declared = (sources[id] as { attribution?: string }).attribution;
    const credit = (live ?? declared ?? '').trim();
    if (credit && !out.includes(credit)) out.push(credit);
  }
  if (!out.length) {
    const configured = readBasemapConfig().attribution.trim();
    if (configured) out.push(configured);
  }
  return out;
}

/**
 * WebGL2 probe. MapLibre 6 requires WebGL2; a WebGL1-only context, a blocked
 * worker or a disabled GPU all end up on the SVG fallback instead of a blank
 * rectangle.
 */
function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    // Release immediately; MapLibre creates its own context.
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const errorBoxStyle: React.CSSProperties = {
  position: 'absolute',
  left: 12,
  top: 12,
  zIndex: 3,
  maxWidth: 'min(360px, calc(100% - 24px))',
  padding: '8px 12px',
  borderRadius: 10,
  background: 'rgba(255,253,248,0.96)',
  border: '1px solid #c62828',
  color: '#7f1d1d',
  font: '500 13px/1.5 system-ui, -apple-system, "PingFang SC", sans-serif',
  boxShadow: '0 6px 20px rgba(22,33,31,0.14)',
  pointerEvents: 'none',
};

/**
 * The map surface: a MapLibre basemap with a deck.gl overlay carrying routes,
 * spots, GeoJSON, type pictograms, numbered stop labels and per-leg annotation pills.
 *
 * Falls back to an SVG canvas — with point selection, dragging and click-to-add
 * intact — when WebGL2 is unavailable. Offline mode loads no external resource
 * of any kind.
 */
export default function MapCanvas(props: MapCanvasProps): React.JSX.Element {
  const { layers, activeLayerId, selected, adding, editable, offline, fitLayerId, fitKey, legMode, colorMode = 'day', hoveredLeg, selectedLeg, onSelect, onSelectLeg, onActivateLayer, onAttribution, onMove, onAdd, insertFrom, insertTo, hoverAt, relocating, onHoverAt, focusAt, focusKey, mapStyle = 'positron', mapLanguage = 'zh' } =
    props;

  const languageRef = useRef(mapLanguage); languageRef.current = mapLanguage;
  const appliedStyle = useRef(mapStyle);
  const [viewRevision, setViewRevision] = useState(0);
  const [hoveredKey, setHoveredKey] = useState<string>();
  const [hoveredLegKey, setHoveredLegKey] = useState<string>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  const [webgl, setWebgl] = useState(webglAvailable);
  const [fallbackReason, setFallbackReason] = useState<'webgl' | 'engine'>('webgl');
  const [workerState, setWorkerState] = useState<MapWorkerState>('idle');
  // Ready for camera framing and route overlays, not proof of basemap loading.
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(3);
  /** Exposed for tests: proves a resize did not move the user's camera. */
  const [center, setCenter] = useState('');
  const [tileError, setTileError] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ key: string; at: Coord } | null>(null);

  /** Pointer is over a backdrop plan (its line or its chip): it previews. */
  const [hoveredPlanId, setHoveredPlanId] = useState<string>();

  // Long-lived map handlers read the latest callbacks through refs.
  const cb = useRef({ onSelect, onSelectLeg, onActivateLayer, onAttribution, onMove, onAdd, onHoverAt, onHoverPoint: props.onHoverPoint });
  cb.current = { onSelect, onSelectLeg, onActivateLayer, onAttribution, onMove, onAdd, onHoverAt, onHoverPoint: props.onHoverPoint };
  const mode = useRef({ adding, editable, relocating });
  mode.current = { adding, editable, relocating };
  const dragRef = useRef<{ key: string; layerId: string; pointId: string; at: Coord } | null>(null);

  const bounds = useMemo(() => focusBounds(layers, fitLayerId, props.fitPointIds), [layers, fitLayerId, props.fitPointIds]);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const hasFitted = useRef(false);
  const lastFitKey = useRef(fitKey);
  /** Set once the user pans or zooms; a resize then keeps their camera. */
  const userMoved = useRef(false);

  useEffect(() => {
    if (workerState === 'blocked' || workerState === 'error' || workerState === 'timeout') {
      // Fixed diagnostic codes only: never log Worker payloads or map credentials.
      console.warn(`[Cartula] MAP_WORKER_${workerState.toUpperCase()}`);
    }
  }, [workerState]);

  useEffect(() => {
    const onPolicy = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective === 'worker-src') { setWorkerState('blocked'); setFallbackReason('engine'); setWebgl(false); }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (/worker/i.test(String(event.reason)) && /security|denied|blocked|construct|policy/i.test(String(event.reason))) {
        event.preventDefault(); setWorkerState('error'); setFallbackReason('engine'); setWebgl(false);
      }
    };
    window.addEventListener('securitypolicyviolation', onPolicy);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('securitypolicyviolation', onPolicy); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);

  /* ------------------------------------------------------------ map setup */

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webgl) return undefined;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: offline ? offlineStyle() : onlineStyle(mapStyle),
        center: [105, 35],
        zoom: 3,
        attributionControl: false,
        maplibreLogo: false,
        dragRotate: false,
        pitchWithRotate: false,
        // Renders CJK labels from a local font instead of a glyph server.
        localIdeographFontFamily: 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif',
      });
    } catch {
      setFallbackReason('engine'); setWebgl(false);
      return undefined;
    }

    mapRef.current = map;
    setWorkerState('idle');
    const stopWorkerWatch = watchMapWorker(map, setWorkerState);
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    /* The credits are not drawn on the map. MapLibre's own control is left off
     * and the strings are reported to the shell instead, which puts them one
     * press away in the top bar — the "About option in a menu" the OSM
     * Foundation's attribution guidelines allow. The map keeps its corners; the
     * credit keeps its link. */
    let reported: string | undefined;
    const reportCredits = (): void => {
      if (!mapRef.current) return;
      const credits = basemapCredits(map, offline);
      const key = credits.join(' ');
      if (key === reported) return;
      reported = key;
      cb.current.onAttribution?.(credits);
    };
    // A style swap replaces the sources, and TileJSON resolves after the style
    // itself, so both events have to be watched for the credit to be complete.
    map.on('styledata', reportCredits);
    map.on('sourcedata', reportCredits);

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    overlayRef.current = overlay;
    map.addControl(overlay);

    let frame = 0;
    const syncZoom = (): void => {
      setZoom(map.getZoom());
      const middle = map.getCenter();
      setCenter(`${middle.lng.toFixed(5)},${middle.lat.toFixed(5)}`);
      setViewRevision(n => n + 1);
    };
    const syncView = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; syncZoom(); }); };
    map.on('move', syncView); map.on('resize', syncView);
    // Camera framing must not wait for every tile/glyph in the initial world
    // view. A loaded style is enough; fit the actual route before those loads.
    let styleLoaded = false;
    map.on('style.load', () => {
      if (!offline) {
        localizeBasemap(map, languageRef.current);
        applyBasemapPoiIcons(map, poiTheme(appliedStyle.current));
      }
      styleLoaded = true; setReady(true); syncZoom();
    });
    map.on('load', () => {
      setReady(true);
      syncZoom();
    });
    map.on('zoomend', syncZoom);

    // A failed tile must not look like a failed map: say so, keep the routes.
    const onError = (event: maplibregl.ErrorEvent): void => {
      if (/worker/i.test(event.error?.message ?? '')) { setWorkerState('error'); setFallbackReason('engine'); setWebgl(false); return; }
      if (/webgl/i.test(event.error?.message ?? '')) { setFallbackReason('webgl'); setWebgl(false); return; }
      // Only a style that never reaches 'style.load' leaves the route
      // unframed behind the notice; once the style has loaded, a later tile
      // or glyph error is transient and must not hide an otherwise-working map.
      if (!offline && !styleLoaded) { setTileError(true); setReady(true); }
    };
    map.on('error', onError);
    let lastSize = { w: container.clientWidth, h: container.clientHeight };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    /* A host panel drag or a display-mode switch must not throw away where the
     * user is looking. The viewport is synchronized on every resize; the camera
     * is only re-framed when the user has not moved it themselves — otherwise
     * "查看全图" and the layer fit buttons remain the way back. */
    const handleResize = () => {
      if (!mapRef.current) return;
      map.resize();
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dw = Math.abs(w - lastSize.w);
      const dh = Math.abs(h - lastSize.h);
      lastSize = { w, h };
      if ((dw <= 60 && dh <= 60) || !hasFitted.current || userMoved.current || !boundsRef.current) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!mapRef.current || !boundsRef.current || userMoved.current) return;
        map.resize();
        const padded = padBounds(boundsRef.current);
        map.fitBounds(
          [
            [padded.minLng, padded.minLat],
            [padded.maxLng, padded.maxLat],
          ],
          { padding: Math.min(w, h) < 480 ? 28 : 64, duration: 400, maxZoom: 12 },
        );
      }, 150);
    };
    // Only a gesture counts as "the user chose this camera"; programmatic
    // fitBounds calls carry no originalEvent.
    const onUserMove = (event: { originalEvent?: unknown }) => { if (event?.originalEvent) userMoved.current = true; };
    map.on('dragstart', onUserMove);
    map.on('zoomstart', onUserMove);

    const resize = new ResizeObserver(handleResize);
    resize.observe(container);

    const onHostResize = () => {
      requestAnimationFrame(handleResize);
    };
    window.addEventListener('cartula:host-context-changed', onHostResize);
    window.addEventListener('resize', onHostResize);

    const onClick = (e: maplibregl.MapMouseEvent): void => {
      if (!mode.current.editable) return;
      if (!mode.current.adding && !mode.current.relocating) return;
      // A new stop dropped on a labelled place takes that label as its
      // suggested name. Nearest first, within a fingertip of the click.
      let name: string | undefined;
      if (mode.current.adding) {
        try {
          const r = 8;
          const near = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]])
            .filter(feature => feature.layer?.type === 'symbol')
            .map(feature => {
              const g = feature.geometry;
              const c = g.type === 'Point' ? map.project(g.coordinates as [number, number]) : e.point;
              return { feature, d: Math.hypot(c.x - e.point.x, c.y - e.point.y) };
            })
            .sort((a, b) => a.d - b.d)
            .map(({ feature }) => ({ sourceLayer: feature.sourceLayer, properties: feature.properties }));
          name = basemapPlaceName(near, languageRef.current ?? 'zh');
        } catch { /* no basemap labels to read */ }
      }
      cb.current.onAdd([e.lngLat.lng, e.lngLat.lat], name);
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent): void => {
      if (mode.current.adding || mode.current.relocating) cb.current.onHoverAt?.([e.lngLat.lng, e.lngLat.lat]);
    };
    const onMouseLeave = (): void => { cb.current.onHoverAt?.(null); };
    map.on('click', onClick);
    map.on('mousemove', onMouseMove);
    map.getCanvas().addEventListener('mouseleave', onMouseLeave);

    return () => {
      stopWorkerWatch();
      setReady(false);
      overlayRef.current = null;
      mapRef.current = null;
      window.removeEventListener('cartula:host-context-changed', onHostResize);
      window.removeEventListener('resize', onHostResize);
      clearTimeout(resizeTimer);
      resize.disconnect(); cancelAnimationFrame(frame);
      try {
        map.remove();
      } catch {
        /* already torn down */
      }
    };
  }, [offline, webgl]);

  /** Pointer is over a route line: the cursor says it can be acted on. */
  const [hoveredRoute, setHoveredRoute] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = (adding || relocating) && editable ? 'crosshair' : hoveredRoute ? 'pointer' : '';
  }, [adding, relocating, editable, ready, hoveredRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && ready && !offline) localizeBasemap(map, mapLanguage);
  }, [mapLanguage, ready, offline]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || offline || appliedStyle.current === mapStyle) return;
    appliedStyle.current = mapStyle; setTileError(false);
    map.setStyle(onlineStyle(mapStyle));
  }, [mapStyle, ready, offline]);

  /* ------------------------------------------------------------ framing */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !bounds) return;

    // Re-frame on an explicit fitKey bump, and once when data first arrives.
    const requested = fitKey !== lastFitKey.current;
    if (!requested && hasFitted.current) return;
    lastFitKey.current = fitKey;
    // An explicit fit replaces the user's camera on purpose, so a later resize
    // may keep tracking the data again.
    userMoved.current = false;

    const padded = padBounds(bounds);
    try {
      // A resize and the fit button can land in the same frame; synchronize
      // viewport dimensions before calculating the new camera.
      map.resize();
      map.fitBounds(
        [
          [padded.minLng, padded.minLat],
          [padded.maxLng, padded.maxLat],
        ],
        { padding: 64, duration: hasFitted.current ? 600 : 0, maxZoom: 12 },
      );
      hasFitted.current = true;
    } catch {
      /* degenerate bounds — leave the camera where it is */
    }
  }, [fitKey, ready, bounds]);

  const lastFocusKey = useRef(focusKey);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusAt || !isValidCoord(focusAt)) return;
    if (focusKey === lastFocusKey.current) return;
    lastFocusKey.current = focusKey;
    try {
      map.easeTo({ center: focusAt, zoom: Math.max(map.getZoom(), 7), duration: 450 });
    } catch { /* ignore */ }
  }, [focusAt, focusKey, ready]);

  /* -------------------------------------------------------- deck.gl layers */

  const dashKm = useMemo(() => dashLengthKm(zoom), [zoom]);

  /** Active layer draws last, so its routes and nodes sit on top. */
  const ordered = useMemo(
    () => [...layers].sort((a, b) => (a.id === activeLayerId ? 1 : 0) - (b.id === activeLayerId ? 1 : 0)),
    [layers, activeLayerId],
  );

  /**
   * Whether the map is comparing plans.
   *
   * Two or more route layers on screen, one of them selected. A selected spots
   * layer does not start a comparison: nothing would be emphasized, so fading
   * the routes would only take contrast away from every one of them.
   */
  const comparing = useMemo(() => {
    const routes = layers.filter(layer => layer.kind === 'route');
    return routes.length > 1 && routes.some(layer => layer.id === activeLayerId);
  }, [layers, activeLayerId]);
  /** True for a plan drawn as backdrop rather than as the answer. */
  const isBackdrop = useCallback(
    (layer: MapLayer) => comparing && layer.kind === 'route' && layer.id !== activeLayerId,
    [comparing, activeLayerId],
  );

  /* Marker sizes, in px. A route stop is a numbered disc, a spot is a pin,
   * and both sit in a halo of their own colour: the mark that says "one of
   * ours" against the basemap's small grey POI dots. They grow a little with
   * zoom — a 22px disc on a country-scale map is a crowd, on a street map it
   * is what the eye goes to first — and a little more under the pointer. */
  const zoomScale = zoom <= 6 ? 0.82 : zoom >= 11 ? 1 : 0.82 + 0.18 * ((zoom - 6) / 5);
  const discRadiusOf = (d: { selected: boolean; backdrop: boolean; key: string }): number =>
    Math.round((d.selected ? 13 : d.backdrop ? 9 : 11) * zoomScale * (!d.selected && d.key === hoveredKey ? 1.12 : 1));
  const pinSizeOf = (d: { selected: boolean; backdrop: boolean; key: string }): number =>
    Math.round(PIN_SIZE * (d.selected ? 1.2 : d.backdrop ? 0.85 : 1) * zoomScale * (!d.selected && d.key === hoveredKey ? 1.1 : 1));

  const nodes = useMemo((): NodeDatum[] => {
    const out: NodeDatum[] = [];
    for (const layer of ordered) {
      const emphasized = layer.id === activeLayerId;
      const backdrop = isBackdrop(layer);
      (layer.points ?? []).forEach((point, index) => {
        if (!isValidCoord(point.at)) return;
        out.push({
          // Point ids are unique only within a layer.
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

  // Hover runs both ways: a list row lights its leg here, and a marker here
  // tells the workspace, so the open list can mark and reveal its row.
  useEffect(() => {
    const node = hoveredKey ? nodes.find(n => n.key === hoveredKey) : undefined;
    cb.current.onHoverPoint?.(node ? { layerId: node.layerId, pointId: node.point.id } : null);
  }, [hoveredKey]);

  /** Each route layer's drawn line, flattened — the input to a comparison. */
  const planLines = useMemo(() => {
    const out = new Map<string, Coord[]>();
    for (const layer of layers) {
      if (layer.kind !== 'route') continue;
      const coords: Coord[] = [];
      for (const seg of routeGeometry(layer).segments) coords.push(...seg.coords);
      out.set(layer.id, coords);
    }
    return out;
  }, [layers]);

  /**
   * One switch chip per backdrop plan, placed where that plan differs most
   * from the selected one — the stretch that is the reason to consider it.
   * Identical plans still get a chip at their midpoint: overlapping lines are
   * exactly the case where the chip is the only way to pick the other one.
   */
  const planChips = useMemo((): PlanChip[] => {
    if (!comparing) return [];
    const reference = planLines.get(activeLayerId ?? '') ?? [];
    const out: PlanChip[] = [];
    for (const layer of layers) {
      if (!isBackdrop(layer)) continue;
      const spot = divergenceAnchor(planLines.get(layer.id) ?? [], reference);
      if (!spot) continue;
      out.push({ key: `plan-chip ${layer.id}`, layerId: layer.id, text: planSummary(layer), anchor: spot.at, color: layer.color, before: spot.before, after: spot.after });
    }
    return out;
  }, [comparing, layers, activeLayerId, planLines, isBackdrop]);

  const legAnnotations = useMemo(() => buildLegAnnotations(layers, colorMode), [layers, colorMode]);

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

  const annotationLayout = useMemo(() => {
    const map = mapRef.current;
    if (!map || !ready) return { labels: [], legs: [], chips: [] } as ReturnType<typeof layoutAnnotations>;
    const center = map.getCenter().lng;
    const projectWrap = (at: Coord) => map.project([at[0] + Math.round((center - at[0]) / 360) * 360, at[1]]);
    const nodeInputs = nodes.map(node => {
      const at = dragPreview?.key === node.key ? dragPreview.at : node.point.at;
      const p = projectWrap(at);
      const layer = layers.find(layer => layer.id === node.layerId);
      // A backdrop plan's stops keep their labels, but yield the space to the
      // selected plan's whenever the two compete for it.
      // Labels keep clear of the whole marker, halo included; a pin's label
      // clears its head rather than its tip.
      const extent = node.marker ? pinExtent(pinSizeOf(node)) : { top: discRadiusOf(node) + HALO_PAD, halfWidth: discRadiusOf(node) + HALO_PAD };
      return { ...node, name: pointLabel(node.index, node.point.name, node.layerKind, !node.marker), x: p.x, y: p.y, hovered: node.key === hoveredKey, dimmed: node.backdrop, endpoint: node.index === 0 || node.index === (layer?.points.length ?? 0) - 1, markerRadius: extent.halfWidth, markerTop: extent.top };
    });
    const legInputs = legMode === 'off' ? [] : legAnnotations.flatMap(leg => {
      const key = legKey(leg);
      const forced = forcedLegKeys.has(key);
      /* While plans are compared, a backdrop plan's per-leg pills are dropped
       * in auto mode: the numbers of a route nobody is reading are what makes
       * the comparison unreadable, and the plan's own chip carries its totals.
       * Pointing at one still brings its pill back, and 全部 still means all. */
      if (comparing && legMode === 'auto' && leg.layerId !== activeLayerId && !forced) return [];
      const a = projectWrap(leg.from.at);
      const b = projectWrap(leg.to.at);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const m = projectWrap(leg.anchor);
      return [{ key, text: leg.text, ax: m.x, ay: m.y, dirX: len > 0 ? dx / len : 1, dirY: len > 0 ? dy / len : 0, lengthPx: len, active: leg.layerId === activeLayerId, forced: forced || leg.important }];
    });
    // Chips are laid out before anything else; see `LayoutLegOptions.chips`.
    const chipInputs = planChips.map(chip => {
      const a = projectWrap(chip.before ?? chip.anchor);
      const b = projectWrap(chip.after ?? chip.anchor);
      const m = projectWrap(chip.anchor);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      return { key: chip.key, text: chip.text, ax: m.x, ay: m.y, dirX: len > 0 ? dx / len : 1, dirY: len > 0 ? dy / len : 0, lengthPx: len, active: false, forced: true };
    });
    return layoutAnnotations(nodeInputs, legInputs, map.getContainer().clientWidth, map.getContainer().clientHeight, zoom, { mode: legMode, chips: chipInputs });
  }, [nodes, layers, ready, viewRevision, dragPreview, hoveredKey, zoom, legAnnotations, forcedLegKeys, activeLayerId, legMode, comparing, planChips]);
  const placedLabels = annotationLayout.labels;
  const placedLegLabels = annotationLayout.legs;
  const placedPlanChips = annotationLayout.chips;
  const labelMap = useMemo(() => new Map(placedLabels.map(label => [label.key, label])), [placedLabels]);

  /** Pill data = placed pill geometry joined back to its leg annotation. */
  const legPills = useMemo((): LegPill[] => {
    const byKey = new Map<string, LegAnnotation>(legAnnotations.map(a => [legKey(a), a]));
    const out: LegPill[] = [];
    for (const p of placedLegLabels) {
      const a = byKey.get(p.key);
      if (a) out.push({ ...p, anchor: a.anchor, warn: a.warn, layerId: a.layerId, fromPointId: a.fromPointId, toPointId: a.toPointId });
    }
    return out;
  }, [placedLegLabels, legAnnotations]);

  /** Chip data = placed chip geometry joined back to the plan it switches to. */
  const planPills = useMemo((): PlanPill[] => {
    const byKey = new Map(planChips.map(chip => [chip.key, chip]));
    const out: PlanPill[] = [];
    for (const placed of placedPlanChips) {
      const chip = byKey.get(placed.key);
      if (chip) out.push({ ...placed, layerId: chip.layerId, anchor: chip.anchor, color: chip.color });
    }
    return out;
  }, [placedPlanChips, planChips]);

  /** Pointer hover over a pill, or the sidebar row hover — one key for both. */
  const hoveredPillKey = hoveredLegKey ?? (hoveredLeg ? legKey(hoveredLeg) : undefined) ?? (selectedLeg ? legKey(selectedLeg) : undefined);

  /** The leg to emphasize on the route itself: pill hover wins, then the
   * sidebar row hover. Uses the labelled segment (per-leg path or straight
   * chord). An unlabelled layer.path has no leg-to-subpath correspondence. */
  const highlightLeg = useMemo((): { coords: Coord[]; color: [number, number, number, number]; width: number } | null => {
    if (!hoveredPillKey) return null;
    const leg = legAnnotations.find(a => legKey(a) === hoveredPillKey);
    const layer = leg ? layers.find(l => l.id === leg.layerId) : undefined;
    if (!leg || !layer) return null;
    const seg = routeGeometry(layer).segments.find(s => s.fromPointId === leg.fromPointId && s.toPointId === leg.toPointId);
    if (!seg || seg.coords.length < 2) return null;
    const active = layer.id === activeLayerId;
    const segColor = leg.color ?? segmentColor(seg, layer, colorMode);
    return { coords: seg.coords, color: hexToRgba(segColor, 255), width: (active ? ROUTE_WIDTH.selected : ROUTE_WIDTH.backdrop) + 3 };
  }, [hoveredPillKey, legAnnotations, layers, activeLayerId, colorMode]);

  /**
   * Route path data, memoized apart from the per-frame label churn: deck
   * re-tessellates on data identity, so camera frames must not rebuild these.
   * Hovering a backdrop plan must not rebuild them either — that is why the
   * preview is an alpha the colour accessor applies, not a different dataset.
   *
   * Four buckets, drawn in this order: the frosted casing that lifts a backdrop
   * plan off the basemap, the backdrop lines themselves, then the selected
   * plan's solid and dashed geometry on top of both.
   */
  const routePaths = useMemo((): { casing: PathDatum[]; backdrop: PathDatum[]; solid: PathDatum[]; warn: PathDatum[] } => {
    const casing: PathDatum[] = [];
    const backdrop: PathDatum[] = [];
    const solid: PathDatum[] = [];
    const warn: PathDatum[] = [];
    for (const layer of ordered) {
      // `spots` layers are points only — no connecting line.
      if (layer.kind !== 'route') continue;
      const behind = isBackdrop(layer);
      const active = layer.id === activeLayerId;
      const width = active ? ROUTE_WIDTH.selected : ROUTE_WIDTH.backdrop;
      const geometry = routeGeometry(layer);
      for (const seg of geometry.segments) {
        if (seg.coords.length < 2) continue;
        // Colour and stroke come from one resolver, so a stop reminder keeps
        // the route colour while supplied traffic gets its own hue.
        const style = segmentStyle(seg, layer, colorMode);
        const emphasis = style.risk === 'none' || style.risk === 'reminder' ? 0 : 1;
        const ref = { layerId: layer.id, fromPointId: seg.fromPointId, toPointId: seg.toPointId };
        if (behind) {
          const muted = backdropSegmentStyle(style);
          // The casing is what makes it read as glass rather than as a faint
          // line: paper under the colour, so the basemap stops showing through.
          casing.push({ coords: seg.coords, color: [255, 253, 248, 150], width: width + 5, ...ref });
          const line = { coords: seg.coords, color: hexToRgba(muted.color, muted.alpha), width, ...ref };
          if (!muted.dashed || geometry.kind !== 'provided') { backdrop.push(line); continue; }
          for (const piece of dashSegments(seg.coords, dashKm, dashKm * 0.75)) {
            if (piece.length < 2) continue;
            backdrop.push({ ...line, coords: piece });
          }
          continue;
        }
        const datum: PathDatum = { coords: seg.coords, color: hexToRgba(style.color, ROUTE_OPACITY.selected), width, ...ref };
        if (!style.dashed) {
          solid.push(datum);
          continue;
        }
        const stroke = { ...datum, color: hexToRgba(style.color, 255), width: width + emphasis };
        if (geometry.kind === 'provided') {
          for (const piece of dashSegments(seg.coords, dashKm, dashKm * 0.75)) {
            if (piece.length < 2) continue;
            warn.push({ ...stroke, coords: piece });
          }
        } else {
          warn.push(stroke);
        }
      }
    }
    return { casing, backdrop, solid, warn };
  }, [ordered, activeLayerId, dashKm, colorMode, isBackdrop]);

  const highlightLegs = useMemo(() => (highlightLeg ? [highlightLeg] : []), [highlightLeg]);

  const deckLayers = useMemo((): Layer[] => {
    const out: Layer[] = [];

    for (const layer of ordered) {
      if (!layer.geojson) continue;
      const active = layer.id === activeLayerId;
      const width = active ? 6 : 4;
      out.push(
        new GeoJsonLayer({
          id: `geojson-${layer.id}`,
          data: layer.geojson as never,
          pickable: false,
          stroked: true,
          filled: true,
          getFillColor: hexToRgba(layer.color, 56),
          getLineColor: hexToRgba(layer.color, 235),
          getLineWidth: width,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          getPointRadius: 4,
          pointRadiusUnits: 'pixels',
          pointRadiusMinPixels: 3,
          updateTriggers: { getLineColor: [active], getFillColor: [active], getLineWidth: [width] },
        }),
      );
    }

    const { casing, backdrop, solid, warn } = routePaths;
    const pickLeg = (info: PickingInfo) => {
      const d = info.object as PathDatum | undefined;
      if (!d?.layerId) return false;
      /* A press on a backdrop plan is a request for that plan, not for one of
       * its legs. Editing a route you are not looking at through a line you
       * cannot properly see is not what the click meant — so the first press
       * switches, and the leg is then one press away on a route drawn in full. */
      if (comparing && d.layerId !== activeLayerId && cb.current.onActivateLayer) {
        cb.current.onActivateLayer(d.layerId);
        setHoveredPlanId(undefined);
        return true;
      }
      if (!d.fromPointId || !d.toPointId) return false;
      // Where on the line the click landed: that is where a mid-stop belongs.
      const at = info.coordinate && info.coordinate.length >= 2
        ? ([info.coordinate[0], info.coordinate[1]] as Coord)
        : undefined;
      if (cb.current.onSelectLeg) cb.current.onSelectLeg(d.layerId, d.fromPointId, d.toPointId, at);
      else cb.current.onSelect(d.layerId, d.fromPointId);
      return true;
    };
    /** A route line under the pointer is clickable; say so with the cursor. */
    const hoverRoute = (info: PickingInfo) => {
      const d = info.object as PathDatum | undefined;
      setHoveredRoute(Boolean(d?.layerId && ((d.fromPointId && d.toPointId) || comparing)));
      // Pointing at a backdrop plan brings it forward, so what a click would
      // switch to can be read before the click.
      setHoveredPlanId(d?.layerId && comparing && d.layerId !== activeLayerId ? d.layerId : undefined);
    };
    if (casing.length) {
      out.push(
        new PathLayer<PathDatum>({
          id: 'routes-backdrop-casing',
          data: casing,
          pickable: false,
          widthUnits: 'pixels',
          widthMinPixels: 10,
          capRounded: true,
          jointRounded: true,
          getPath: (d) => d.coords as never,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
        }),
      );
    }
    if (backdrop.length) {
      out.push(
        new PathLayer<PathDatum>({
          id: 'routes-backdrop',
          data: backdrop,
          pickable: true,
          widthUnits: 'pixels',
          widthMinPixels: 8,
          capRounded: true,
          jointRounded: true,
          getPath: (d) => d.coords as never,
          // Hover raises the alpha in place: same data, same tessellation.
          getColor: (d) => (d.layerId === hoveredPlanId ? [d.color[0], d.color[1], d.color[2], ROUTE_OPACITY.backdropHover] : d.color),
          getWidth: (d) => d.width,
          onClick: pickLeg,
          onHover: hoverRoute,
          updateTriggers: { getColor: [hoveredPlanId] },
        }),
      );
    }
    if (solid.length) {
      out.push(
        new PathLayer<PathDatum>({
          id: 'routes',
          data: solid,
          pickable: true,
          widthUnits: 'pixels',
          widthMinPixels: 8,
          capRounded: true,
          jointRounded: true,
          getPath: (d) => d.coords as never,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          onClick: pickLeg,
          onHover: hoverRoute,
        }),
      );
    }
    if (warn.length) {
      out.push(
        new PathLayer<PathDatum>({
          id: 'routes-warn',
          data: warn,
          pickable: true,
          widthUnits: 'pixels',
          widthMinPixels: 8,
          capRounded: false,
          jointRounded: true,
          getPath: (d) => d.coords as never,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          onClick: pickLeg,
          onHover: hoverRoute,
        }),
      );
    }

    if (highlightLegs.length) {
      out.push(
        new PathLayer<{ coords: Coord[]; color: [number, number, number, number]; width: number }>({
          id: 'leg-highlight',
          data: highlightLegs,
          pickable: false,
          widthUnits: 'pixels',
          widthMinPixels: 2,
          capRounded: true,
          jointRounded: true,
          getPath: (d) => d.coords as never,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
        }),
      );
    }

    // Leg pills come before the nodes so node markers win picking on overlap.
    if (legPills.length) {
      out.push(
        new TextLayer<LegPill>({
          id: 'leg-labels',
          data: legPills,
          pickable: true,
          characterSet: 'auto',
          fontFamily: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
          fontWeight: 600,
          fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
          getPosition: (d) => d.anchor as never,
          getText: (d) => d.text,
          getSize: (d) => (d.key === hoveredPillKey ? 13 : 11),
          sizeUnits: 'pixels',
          getColor: (d) => (d.warn ? [198, 40, 40, 235] : [38, 60, 54, 235]),
          getPixelOffset: (d) => d.offset,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          outlineWidth: 4,
          outlineColor: [255, 253, 248, 240],
          background: true,
          getBackgroundColor: (d) => (d.key === hoveredPillKey ? [255, 253, 248, 245] : [255, 253, 248, 222]),
          backgroundPadding: [5, 3],
          onHover: (info: PickingInfo) => { setHoveredLegKey((info.object as LegPill | undefined)?.key); },
          onClick: (info: PickingInfo) => {
            const d = info.object as LegPill | undefined;
            if (!d) return false;
            // The pill sits beside the line, not on it, so the leg's own anchor
            // is the honest insertion point rather than wherever the label is.
            if (cb.current.onSelectLeg) cb.current.onSelectLeg(d.layerId, d.fromPointId, d.toPointId, d.anchor);
            else cb.current.onSelect(d.layerId, d.fromPointId);
            return true;
          },
          updateTriggers: {
            getText: [legPills],
            getPixelOffset: [legPills],
            getSize: [hoveredPillKey],
            getColor: [legPills],
            getBackgroundColor: [hoveredPillKey],
          },
        }),
      );
    }

    const circleNodes = nodes.filter(node => !node.marker);
    const pinNodes = nodes.filter(node => node.marker);
    const markerTheme = poiTheme(mapStyle);

    const positionOf = (d: NodeDatum): Coord =>
      dragPreview && dragPreview.key === d.key ? dragPreview.at : d.point.at;
    const dragTrigger = [dragPreview?.key, dragPreview?.at[0], dragPreview?.at[1]];
    const nodeEvents = {
      onHover: (info: PickingInfo) => {
        setHoveredKey((info.object as NodeDatum | undefined)?.key);
        if (info.object) setHoveredLegKey(undefined);
      },
      onClick: (info: PickingInfo) => {
        const d = info.object as NodeDatum | undefined;
        if (!d) return false;
        cb.current.onSelect(d.layerId, d.point.id);
        return true;
      },
      onDragStart: (info: PickingInfo) => {
        const d = info.object as NodeDatum | undefined;
        if (!d || !mode.current.editable) return false;
        dragRef.current = { key: d.key, layerId: d.layerId, pointId: d.point.id, at: d.point.at };
        mapRef.current?.dragPan.disable();
        return true;
      },
      onDrag: (info: PickingInfo) => {
        const active = dragRef.current;
        if (!active || !info.coordinate) return false;
        const at: Coord = [info.coordinate[0], info.coordinate[1]];
        active.at = at;
        setDragPreview({ key: active.key, at });
        return true;
      },
      onDragEnd: () => {
        const active = dragRef.current;
        dragRef.current = null;
        mapRef.current?.dragPan.enable();
        setDragPreview(null);
        if (!active) return false;
        cb.current.onMove(active.layerId, active.pointId, active.at);
        return true;
      },
    };

    const activeKind = layers.find(layer => layer.id === activeLayerId)?.kind;
    const pushCircles = () => {
      if (!circleNodes.length) return;
      // Text that reads on the disc: the same rule as the plan rail's dots.
      const inkOn = (c: RGBA): RGBA => {
        const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]) > 0.32 ? [22, 33, 31, 255] : [255, 255, 255, 255];
      };
      out.push(
        // A soft ring of the stop's own colour under the disc.
        new ScatterplotLayer<NodeDatum>({
          id: 'node-halos',
          data: circleNodes,
          pickable: false,
          stroked: false,
          filled: true,
          radiusUnits: 'pixels',
          getPosition: (d) => positionOf(d) as never,
          getRadius: (d) => discRadiusOf(d) + HALO_PAD + (d.selected ? 2 : 0),
          getFillColor: (d) => { const c = nodeColor(d); return [c[0], c[1], c[2], d.backdrop ? 40 : d.selected ? 90 : 60]; },
          updateTriggers: {
            getPosition: dragTrigger,
            getRadius: [selected?.pointId, selected?.layerId, activeLayerId, hoveredKey, zoom],
            getFillColor: [activeLayerId, comparing, selected?.pointId, selected?.layerId],
          },
        }),
        new ScatterplotLayer<NodeDatum>({
          id: 'nodes',
          data: circleNodes,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 5,
          lineWidthUnits: 'pixels',
          getPosition: (d) => positionOf(d) as never,
          getRadius: (d) => discRadiusOf(d),
          getFillColor: (d) => nodeColor(d),
          getLineColor: (d) => (d.selected ? [22, 33, 31, 255] : [255, 255, 255, d.backdrop ? 210 : 255]),
          getLineWidth: (d) => (d.selected ? 3 : 2.5),
          ...nodeEvents,
          updateTriggers: {
            getPosition: dragTrigger,
            getRadius: [selected?.pointId, selected?.layerId, activeLayerId, hoveredKey, zoom],
            getFillColor: [activeLayerId, comparing],
            getLineColor: [selected?.pointId, selected?.layerId, comparing],
            getLineWidth: [selected?.pointId, selected?.layerId],
          },
        }),
        // The ordinal inside the disc: the order of a plan on the map itself,
        // not only in the list beside it.
        new TextLayer<NodeDatum>({
          id: 'node-numbers',
          data: circleNodes,
          pickable: false,
          characterSet: [...'0123456789'],
          fontFamily: "Inter, 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif",
          fontWeight: 700,
          fontSettings: { sdf: true, fontSize: 48, buffer: 4 },
          getPosition: (d) => positionOf(d) as never,
          getText: (d) => String(d.index + 1),
          getSize: (d) => Math.max(9, Math.round(discRadiusOf(d) * (d.index >= 99 ? 0.8 : d.index >= 9 ? 0.95 : 1.1))),
          sizeUnits: 'pixels',
          getColor: (d) => { const ink = inkOn(nodeColor(d)); return d.backdrop ? [ink[0], ink[1], ink[2], 215] : ink; },
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          updateTriggers: {
            getPosition: dragTrigger,
            getSize: [selected?.pointId, selected?.layerId, activeLayerId, hoveredKey, zoom],
            getColor: [activeLayerId, comparing],
          },
        }),
      );
    };
    const pushPins = () => {
      if (!pinNodes.length) return;
      out.push(
        new IconLayer<NodeDatum>({
          id: 'markers',
          data: pinNodes,
          pickable: true,
          // deck's image loader accepts the canvas directly. Resolving this
          // local resource avoids fetching a data: URL under the host's CSP.
          iconAtlas: 'cartula:pin-atlas',
          fetch: async () => pinIconAtlas(),
          iconMapping: PIN_ICON_MAPPING,
          getIcon: (d) => pinAtlasIcon(d.marker!, markerTheme, d.point.warn),
          getPosition: (d) => positionOf(d) as never,
          getSize: (d) => pinSizeOf(d),
          sizeUnits: 'pixels',
          getColor: (d) => (d.backdrop ? [255, 255, 255, 210] : [255, 255, 255, 255]),
          billboard: true,
          ...nodeEvents,
          updateTriggers: {
            getPosition: dragTrigger,
            getIcon: [markerTheme],
            getSize: [selected?.pointId, selected?.layerId, activeLayerId, comparing, hoveredKey, zoom],
            getColor: [comparing],
          },
        }),
      );
    };
    // The selected layer's marks draw on top: a plan's numbered discs over
    // the candidate pins, or the pins over the discs once a spots layer is
    // the one being read.
    if (activeKind === 'spots') { pushCircles(); pushPins(); } else { pushPins(); pushCircles(); }

    const previewCoords = [insertFrom, hoverAt, insertTo].filter((c): c is Coord => Array.isArray(c) && c.length >= 2);
    if (adding && previewCoords.length >= 2) {
      out.push(new PathLayer<{ coords: Coord[] }>({
        id: 'insert-preview',
        data: [{ coords: previewCoords }],
        pickable: false,
        widthUnits: 'pixels',
        widthMinPixels: 3,
        capRounded: true,
        getPath: (d) => d.coords as never,
        getColor: [76, 148, 122, 220],
        getWidth: 3,
      }));
    }
    if (adding && hoverAt) {
      out.push(new ScatterplotLayer<{ at: Coord }>({
        id: 'insert-cursor',
        data: [{ at: hoverAt }],
        pickable: false,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        getPosition: (d) => d.at as never,
        getRadius: 8,
        getFillColor: [76, 148, 122, 230],
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
      }));
    }

    // Direct labels: identity never rests on hue alone.

    out.push(
      new TextLayer<NodeDatum>({
        id: 'node-labels',
        data: nodes.filter(node => labelMap.has(node.key)),
        pickable: false,
        characterSet: 'auto',
        fontFamily: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
        fontWeight: 600,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        getPosition: (d) => positionOf(d) as never,
        getText: (d) => labelMap.get(d.key)?.text ?? '',
        getSize: (d) => (d.selected || d.key === hoveredKey ? 14 : d.emphasized ? 13 : d.backdrop ? 11 : 12),
        sizeUnits: 'pixels',
        // Backdrop names stay black enough to read, light enough to skip over.
        getColor: (d) => (d.backdrop ? [88, 104, 96, 225] : [22, 33, 31, 255]),
        getPixelOffset: (d) => labelMap.get(d.key)?.offset ?? [0, -18],
        lineHeight: 1.25,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        outlineWidth: 4,
        outlineColor: [255, 253, 248, 240],
        background: true,
        getBackgroundColor: (d) => (d.backdrop ? [255, 253, 248, 205] : [255, 253, 248, 235]),
        backgroundPadding: [4, 2],
        updateTriggers: {
          getPosition: dragTrigger,
          getText: [placedLabels],
          getPixelOffset: [placedLabels],
          getSize: [selected?.pointId, selected?.layerId, hoveredKey, activeLayerId, comparing],
          getColor: [comparing, activeLayerId],
          getBackgroundColor: [comparing, activeLayerId],
        },
      }),
    );

    /* The way back to a plan the map is not showing in full: a chip on the
     * stretch that makes it different, carrying its name and its totals.
     * Pointing at it previews the plan on the map; pressing it switches. */
    if (planPills.length) {
      out.push(
        new TextLayer<PlanPill>({
          id: 'plan-chips',
          data: planPills,
          pickable: true,
          characterSet: 'auto',
          fontFamily: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
          fontWeight: 600,
          fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
          getPosition: (d) => d.anchor as never,
          getText: (d) => d.text,
          getSize: (d) => (d.layerId === hoveredPlanId ? 12 : 11),
          sizeUnits: 'pixels',
          /* Ink on paper at rest, with the plan's colour on the border only.
           * Colouring the text would put a plan whose colour happens to be red
           * in the same voice as a closure warning; the border carries the
           * identity, and the line it sits on is in the same hue anyway. Under
           * the pointer the chip fills in — the affordance saying it can be
           * taken, and a preview of the colour it will be drawn in. */
          getColor: (d) => (d.layerId === hoveredPlanId ? [255, 253, 248, 255] : [38, 60, 54, 240]),
          getPixelOffset: (d) => d.offset,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          outlineWidth: 0,
          background: true,
          getBackgroundColor: (d) => (d.layerId === hoveredPlanId ? hexToRgba(d.color, 245) : [255, 253, 248, 238]),
          backgroundPadding: [7, 4],
          getBorderColor: (d) => hexToRgba(d.color, 220),
          getBorderWidth: 1.5,
          onHover: (info: PickingInfo) => {
            const d = info.object as PlanPill | undefined;
            setHoveredPlanId(d?.layerId);
            setHoveredRoute(Boolean(d));
          },
          onClick: (info: PickingInfo) => {
            const d = info.object as PlanPill | undefined;
            if (!d) return false;
            cb.current.onActivateLayer?.(d.layerId);
            setHoveredPlanId(undefined);
            return true;
          },
          updateTriggers: {
            getText: [planPills],
            getPixelOffset: [planPills],
            getSize: [hoveredPlanId],
            getColor: [hoveredPlanId, planPills],
            getBackgroundColor: [hoveredPlanId, planPills],
            getBorderColor: [planPills],
          },
        }),
      );
    }

    return out;
  }, [ordered, nodes, activeLayerId, selected, routePaths, highlightLegs, dragPreview, labelMap, placedLabels, hoveredKey, legPills, hoveredPillKey, planPills, hoveredPlanId, comparing, adding, insertFrom, insertTo, hoverAt, mapStyle, zoom]);

  useEffect(() => {
    overlayRef.current?.setProps({ layers: deckLayers });
  }, [deckLayers]);

  /* A camera move without pointer motion leaves deck picking stale: the last
   * hovered pill/node would stay enlarged under a shifted map. Clear hover on
   * every view change; the next pointermove re-picks. */
  useEffect(() => {
    setHoveredLegKey(undefined);
    setHoveredKey(undefined);
    setHoveredPlanId(undefined);
  }, [viewRevision]);

  /* Keyboard route to add a node without a pointer. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!adding || !editable) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const map = mapRef.current;
      if (!map) return;
      event.preventDefault();
      const c = map.getCenter();
      onAdd([c.lng, c.lat]);
    },
    [adding, editable, onAdd],
  );

  if (!webgl) {
    return <SvgMapCanvas {...props} fallbackReason={fallbackReason} workerState={workerState} />;
  }

  /* Which plans are one press away, and where that press lands. The position
   * is part of the read-out on purpose: a switch chip nobody can hit is not a
   * way back to the plan, so a test has to be able to hit it. */
  const chipReadout = JSON.stringify(planPills.map(chip => ({ id: chip.layerId, x: Math.round(chip.x), y: Math.round(chip.y) })));

  return (
    <div
      className="map-canvas"
      data-ready={ready}
      data-mode="webgl"
      data-worker={workerState}
      data-label-count={placedLabels.length}
      data-label-keys={JSON.stringify(placedLabels.map(label => label.key))}
      data-leg-label-count={placedLegLabels.length}
      data-leg-label-keys={JSON.stringify(placedLegLabels.map(label => label.key))}
      data-comparing={comparing}
      data-plan-chips={chipReadout}
      data-zoom={zoom.toFixed(2)}
      data-center={center}
      data-style={mapStyle}
      data-language={mapLanguage}
      aria-label="地图画布"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        tabIndex={adding && editable ? 0 : -1}
        aria-label={adding && editable ? '按回车在地图中心添加节点' : undefined}
        onKeyDown={onKeyDown}
      />
      {workerState === 'timeout' || workerState === 'error'
        ? <div style={{ ...errorBoxStyle, top: 108 }} role="status">地图引擎暂未响应，底图可能无法显示；路线与编辑仍可使用。</div>
        : tileError ? <div style={{ ...errorBoxStyle, top: 108 }} role="status">底图暂时不可用，路线与编辑不受影响。</div> : null}
    </div>
  );
}
