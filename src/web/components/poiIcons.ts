/**
 * Google Maps-style POI pictograms.
 *
 * Two consumers:
 * - Cartula's own points: a teardrop atlas in markerIcons.ts (deck.gl IconLayer).
 * - OSM vector tiles: MapLibre symbol layers on OpenMapTiles `poi` / `aerodrome_label`.
 *
 * Data: Cartula points use `{ name, at: [lng, lat], icon?: PointIcon }`.
 * OpenMapTiles POIs use source-layer `poi` with `class`, `subclass`, `rank`, `name`.
 */
import type { ExpressionSpecification, Map as LibreMap } from 'maplibre-gl';
import { POINT_ICONS, iconFill, type IconTheme } from '../../core/icons.js';
import type { PointIcon } from '../../core/types.js';
import type { MapStyle } from './preferences.js';

export type { IconTheme };

/**
 * Basemap POIs are context, not content. They are drawn as small, muted dots
 * — 60% of a Cartula pin head, blended toward grey — and only from
 * `BASEMAP_POI_MIN_ZOOM`, so that at street level the marks an Agent put on
 * the map are the ones the eye lands on. The pictogram set is shared with
 * Cartula's own pins on purpose (a hotel is a hotel), the size and the
 * saturation are what say which is which.
 */
export const BASEMAP_POI_SCALE = 0.62;
export const BASEMAP_POI_MIN_ZOOM = 15;
const BASEMAP_POI_OPACITY = 0.88;

/** `hex` pulled `amount` of the way toward `toward`, for the muted basemap dots. */
export function mutedFill(hex: string, theme: IconTheme, amount = theme === 'dark' ? 0.42 : 0.5): string {
  const toward = theme === 'dark' ? '#6b7178' : '#9aa0a6';
  const channel = (at: number) => {
    const a = parseInt(hex.slice(at, at + 2), 16);
    const b = parseInt(toward.slice(at, at + 2), 16);
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

export function poiTheme(style: MapStyle | undefined): IconTheme {
  return style === 'dark' ? 'dark' : 'light';
}

/** 24×24 filled silhouettes, white on a coloured disc / pin head. */
export const POI_PATHS: Record<PointIcon, string> = {
  pin: '',
  hotel: 'M4 12h16v8h-2.2v-4.2H6.2V20H4v-8zm1.8-7.5h8.2v6.2H5.8V4.5z',
  restaurant: 'M6 2h1.7v7.2H6V2zm2.15 0h1.7v7.2h-1.7V2zm2.15 0H12v7.2h-1.7V2zM7.1 10h3.8v12H7.1V10zm8.2-8c.55 4.2 2.2 9.2 2.2 13.2 0 2.2-1 3.6-2.2 3.6S13 17.4 13 15.2C13 11.2 14.7 6.2 15.3 2z',
  cafe: 'M4.5 4h11.2v7.3A3.7 3.7 0 0112 15H8.2a3.7 3.7 0 01-3.7-3.7V4zm11.2 1.8h1.9A2.3 2.3 0 0120 8.1a2.3 2.3 0 01-2.4 2.3h-1.9V5.8zM8 17.2h8v2.3H8v-2.3z',
  viewpoint: 'M2.5 19.5l6.2-10.2 3.4 5.4 2.8-4.6 6.6 9.4H2.5zm13.8-12.2a2.1 2.1 0 10.02-4.2 2.1 2.1 0 00-.02 4.2z',
  museum: 'M3 19.2h18V21H3v-1.8zM5.2 8.2h2.1V18H5.2V8.2zm3.8 0h2.1V18H9V8.2zm3.8 0h2.1V18h-2.1V8.2zm3.8 0h2.1V18h-2.1V8.2zM12 2.2L2.2 7.2v1h19.6v-1L12 2.2z',
  park: 'M12 2.2L3.8 13.8h4.3V21h7.8v-7.2h4.3L12 2.2z',
  parking: 'M6.2 3h7.6A4.7 4.7 0 0118.5 7.7 4.7 4.7 0 0113.8 12.4H10.4V21H6.2V3zm4.2 2.6v4.2h3.4a2.1 2.1 0 000-4.2H10.4z',
  fuel: 'M7.2 2.2h8.2V14H7.2V2.2zm9.6 3.4h2.1v8.2a1.7 1.7 0 102.3 0V9.2L19.6 7.6V5.6h-2.8zM6.4 14.5h10v7.3H6.4v-7.3z',
  airport: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
  station: 'M4 6.2C4 3.8 7.6 2 12 2s8 1.8 8 4.2v9.2c0 1.1-.9 2-2 2l1 1.8V21h-2.6l-1.4-2.8H9l-1.4 2.8H5v-1.6l1-1.8c-1.1 0-2-.9-2-2V6.2zM7.2 15.6A1.5 1.5 0 108.7 14a1.5 1.5 0 00-1.5 1.6zm9.6 0A1.5 1.5 0 1018.3 14a1.5 1.5 0 00-1.5 1.6zM6.2 7h11.6v4.2H6.2V7z',
  camp: 'M12 3.2L2 21h20L12 3.2z',
  shop: 'M16 6.2V4.8A4 4 0 008 4.8v1.4H4.8v15h14.4v-15H16zM10 4.8a2 2 0 014 0v1.4h-4V4.8z',
  hospital: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z',
  note: 'M6.2 2.2h9.2L19.8 7v14.8H6.2V2.2zm9 1.4V8h4.2',
};

const OSM_CLASS_TO_ICON: Record<string, PointIcon> = {
  lodging: 'hotel', hotel: 'hotel', guest_house: 'hotel', motel: 'hotel',
  restaurant: 'restaurant', fast_food: 'restaurant', food_court: 'restaurant',
  cafe: 'cafe', bar: 'cafe', pub: 'cafe',
  attraction: 'viewpoint', viewpoint: 'viewpoint', monument: 'viewpoint',
  museum: 'museum', artwork: 'museum', gallery: 'museum',
  park: 'park', garden: 'park', picnic_site: 'park',
  campsite: 'camp', camp_site: 'camp',
  parking: 'parking',
  fuel: 'fuel',
  airport: 'airport', aerodrome: 'airport',
  bus: 'station', rail: 'station', railway: 'station', station: 'station',
  hospital: 'hospital', doctor: 'hospital', pharmacy: 'hospital',
  shop: 'shop', grocery: 'shop', supermarket: 'shop', mall: 'shop', clothes: 'shop',
};

export const OSM_POI_CLASSES = Object.keys(OSM_CLASS_TO_ICON);

export function poiClassToIcon(value?: string | null): PointIcon | undefined {
  if (!value) return undefined;
  return OSM_CLASS_TO_ICON[value];
}

export function poiImageId(icon: PointIcon, theme: IconTheme): string {
  return `cartula-poi-${icon}-${theme}`;
}

export function pinAtlasIcon(icon: PointIcon, theme: IconTheme, warn = false): string {
  return warn ? `${icon}-warn` : `${icon}-${theme}`;
}

export function drawPoiPictogram(ctx: CanvasRenderingContext2D, icon: PointIcon, cx: number, cy: number, size: number) {
  const d = POI_PATHS[icon];
  ctx.save();
  ctx.fillStyle = '#ffffff';
  if (!d) {
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.translate(cx, cy);
  ctx.scale(size / 24, size / 24);
  ctx.translate(-12, -12);
  ctx.fill(new Path2D(d));
  ctx.restore();
}

const DOT_BITMAP = 40;
const DOT_PIXEL_RATIO = 2;

function rasterPoiDot(icon: PointIcon, fill: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = DOT_BITMAP;
  canvas.height = DOT_BITMAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new ImageData(DOT_BITMAP, DOT_BITMAP);
  const cx = DOT_BITMAP / 2;
  const cy = DOT_BITMAP / 2;
  const r = DOT_BITMAP * 0.4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  drawPoiPictogram(ctx, icon, cx, cy, DOT_BITMAP * 0.5);
  return ctx.getImageData(0, 0, DOT_BITMAP, DOT_BITMAP);
}

export function poiDotSvg(icon: PointIcon, theme: IconTheme): string {
  const fill = iconFill(icon, theme);
  const path = POI_PATHS[icon];
  const mark = path
    ? `<path d="${path}" fill="#fff" transform="translate(12 12) scale(0.5) translate(-12 -12)"/>`
    : '<circle cx="12" cy="12" r="3.2" fill="#fff"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10.4" fill="${fill}" stroke="#fff" stroke-width="1.6"/>${mark}</svg>`;
}

export function poiIconImageExpression(theme: IconTheme): ExpressionSpecification {
  const branches: string[] = [];
  for (const [cls, icon] of Object.entries(OSM_CLASS_TO_ICON)) {
    branches.push(cls, poiImageId(icon, theme));
  }
  return [
    'match',
    ['to-string', ['coalesce', ['get', 'class'], '']],
    ...branches,
    ['to-string', ['coalesce', ['get', 'subclass'], ['get', 'class'], '']],
  ] as ExpressionSpecification;
}

function vectorSourceId(map: LibreMap): string | undefined {
  const sources = map.getStyle()?.sources ?? {};
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'vector') return id;
  }
  return undefined;
}

function registerDotImages(map: LibreMap, theme: IconTheme) {
  for (const icon of POINT_ICONS) {
    const id = poiImageId(icon, theme);
    const image = rasterPoiDot(icon, mutedFill(iconFill(icon, theme), theme));
    if (map.hasImage(id)) map.updateImage(id, image);
    else map.addImage(id, image, { pixelRatio: DOT_PIXEL_RATIO });
  }
}

const OWN_POI_LAYER = 'cartula-poi';

/**
 * Swap OSM POI text for coloured icons. Liberty/bright already have `poi_*`
 * symbol layers — those keep placement, lose the name, and pick up our images.
 * Positron/dark have no POI layer, so one is added on the OpenMapTiles source.
 */
export function applyBasemapPoiIcons(map: LibreMap, theme: IconTheme): void {
  if (typeof document === 'undefined') return;
  const style = map.getStyle();
  if (!style) return;
  registerDotImages(map, theme);

  const iconImage = poiIconImageExpression(theme);
  const poiIds: string[] = [];
  const aerodromeIds: string[] = [];
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    if (sourceLayer === 'poi') poiIds.push(layer.id);
    if (sourceLayer === 'aerodrome_label') aerodromeIds.push(layer.id);
  }

  const hideText = (id: string, image: ExpressionSpecification | string, minZoom?: number) => {
    try {
      map.setLayoutProperty(id, 'icon-image', image);
      map.setLayoutProperty(id, 'icon-size', BASEMAP_POI_SCALE);
      map.setLayoutProperty(id, 'icon-anchor', 'center');
      map.setLayoutProperty(id, 'text-field', '');
      map.setPaintProperty(id, 'icon-opacity', BASEMAP_POI_OPACITY);
      if (minZoom !== undefined) {
        const layer = map.getLayer(id);
        map.setLayerZoomRange(id, Math.max(layer?.minzoom ?? 0, minZoom), layer?.maxzoom ?? 24);
      }
    } catch { /* layer may not accept icon layout */ }
  };
  for (const id of poiIds) hideText(id, iconImage, BASEMAP_POI_MIN_ZOOM);
  // Airports are landmarks at any zoom; they keep the style's own range.
  for (const id of aerodromeIds) hideText(id, poiImageId('airport', theme));

  const sourceId = vectorSourceId(map);
  if (poiIds.length || !sourceId) {
    if (map.getLayer(OWN_POI_LAYER)) map.removeLayer(OWN_POI_LAYER);
    return;
  }

  if (map.getLayer(OWN_POI_LAYER)) {
    map.setLayoutProperty(OWN_POI_LAYER, 'icon-image', iconImage);
    map.setLayoutProperty(OWN_POI_LAYER, 'icon-size', BASEMAP_POI_SCALE);
    return;
  }

  const beforeId = style.layers.find(layer => layer.type === 'symbol' && 'source-layer' in layer && layer['source-layer'] === 'place')?.id;
  try {
    map.addLayer({
      id: OWN_POI_LAYER,
      type: 'symbol',
      source: sourceId,
      'source-layer': 'poi',
      minzoom: BASEMAP_POI_MIN_ZOOM,
      filter: [
        'all',
        ['==', ['geometry-type'], 'Point'],
        ['match', ['get', 'class'], OSM_POI_CLASSES, true, false],
        ['<=', ['coalesce', ['get', 'rank'], 99], ['interpolate', ['linear'], ['zoom'], 15, 8, 16, 16, 17, 30]],
      ],
      layout: {
        'icon-image': iconImage,
        'icon-size': BASEMAP_POI_SCALE,
        'icon-anchor': 'center',
        'icon-padding': 4,
        'icon-allow-overlap': false,
        'icon-optional': true,
        'text-field': '',
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: { 'icon-opacity': BASEMAP_POI_OPACITY },
    }, beforeId);
  } catch {
    /* source-layer absent in a raster-only style */
  }
}
