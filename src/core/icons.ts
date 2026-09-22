/**
 * Closed set of custom-marker icons. Spots layers render as pins; route
 * stops stay numbered circles unless a point sets `icon` explicitly.
 *
 * Basemap POIs (OpenFreeMap / OpenMapTiles) stay decorative. Only Cartula
 * points — the ones an Agent or user actually added — are interactive.
 *
 * Map markers draw Google-style coloured pictograms, not the old one-character
 * glyphs. `glyph` remains a short label for tests and text-only fallbacks.
 */
import type { PointIcon } from './types.js';

export const POINT_ICONS = [
  'pin', 'hotel', 'restaurant', 'cafe', 'viewpoint', 'museum', 'park',
  'parking', 'fuel', 'airport', 'station', 'camp', 'shop', 'hospital', 'note',
] as const satisfies readonly PointIcon[];

/** MapLibre `icon-size` and the deck.gl pin scale. */
export const ICON_SCALE = 1.2;

export type IconTheme = 'light' | 'dark';

/** Same red the canvases use for a stop reminder — kept here so core stays UI-free. */
export const ICON_WARN_COLOR = '#c62828';

export const POINT_ICON_META: Record<PointIcon, { label: string; glyph: string; color: string; darkColor: string }> = {
  pin: { label: '图钉', glyph: '', color: '#EA4335', darkColor: '#FF6B6B' },
  hotel: { label: '住宿', glyph: '住', color: '#EA4335', darkColor: '#FF6B6B' },
  restaurant: { label: '餐厅', glyph: '餐', color: '#F9AB00', darkColor: '#FFC107' },
  cafe: { label: '咖啡', glyph: '咖', color: '#E8710A', darkColor: '#FF8A3D' },
  viewpoint: { label: '观景', glyph: '景', color: '#34A853', darkColor: '#4ADE80' },
  museum: { label: '博物馆', glyph: '博', color: '#A142F4', darkColor: '#C084FC' },
  park: { label: '公园', glyph: '园', color: '#188038', darkColor: '#34A853' },
  parking: { label: '停车', glyph: '停', color: '#5F6368', darkColor: '#9AA0A6' },
  fuel: { label: '加油', glyph: '油', color: '#F9AB00', darkColor: '#FFC107' },
  airport: { label: '机场', glyph: '机', color: '#1A73E8', darkColor: '#5B9BFF' },
  station: { label: '车站', glyph: '站', color: '#1A73E8', darkColor: '#5B9BFF' },
  camp: { label: '露营', glyph: '营', color: '#34A853', darkColor: '#4ADE80' },
  shop: { label: '购物', glyph: '购', color: '#F9AB00', darkColor: '#FFC107' },
  hospital: { label: '医疗', glyph: '医', color: '#D93025', darkColor: '#FF6B6B' },
  note: { label: '备注', glyph: '注', color: '#5F6368', darkColor: '#9AA0A6' },
};

export function iconFill(icon: PointIcon, theme: IconTheme = 'light', warn = false): string {
  if (warn) return ICON_WARN_COLOR;
  const meta = POINT_ICON_META[icon];
  return theme === 'dark' ? meta.darkColor : meta.color;
}

const ICON_SET = new Set<string>(POINT_ICONS);

export function parsePointIcon(value?: string | null): PointIcon | undefined {
  if (!value) return undefined;
  return ICON_SET.has(value) ? value as PointIcon : undefined;
}

/** Spots always pin; a route stop pins only when `icon` is set. */
export function markerIcon(layerKind: string | undefined, icon?: string): PointIcon | undefined {
  const parsed = parsePointIcon(icon);
  if (parsed) return parsed;
  if (layerKind === 'spots') return 'pin';
  return undefined;
}

/**
 * The text beside a marker. A route stop is prefixed with its ordinal unless
 * the marker already shows it (`numbered`): the numbered disc the canvases
 * draw carries the ordinal itself, so the label beside it is just the name.
 */
export function pointLabel(index: number, name: string, layerKind?: string, numbered = false): string {
  return layerKind === 'route' && !numbered ? `${index + 1} ${name}` : name;
}
