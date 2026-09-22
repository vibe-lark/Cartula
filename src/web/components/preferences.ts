import { useState } from 'react';
import type { Map as LibreMap, ExpressionSpecification } from 'maplibre-gl';
import type { LegLabelMode, RouteColorMode } from './legs.js';

export type MapStyle = 'positron' | 'liberty' | 'bright' | 'dark';
export type MapLanguage = 'zh' | 'zh-Hant' | 'en' | 'local';

function stored<T extends string>(key: string, choices: T[], fallback: T) {
  try { const value = localStorage.getItem(key) as T; return choices.includes(value) ? value : fallback; } catch { return fallback; }
}

export function useMapPreferences() {
  const [style, updateStyle] = useState<MapStyle>(() => stored('cartula:style', ['positron', 'liberty', 'bright', 'dark'], 'positron'));
  const [language, updateLanguage] = useState<MapLanguage>(() => stored('cartula:language', ['zh', 'zh-Hant', 'en', 'local'], 'zh'));
  const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* opaque MCP iframe */ } };
  return { style, language, setStyle: (value: MapStyle) => { updateStyle(value); save('cartula:style', value); }, setLanguage: (value: MapLanguage) => { updateLanguage(value); save('cartula:language', value); } };
}

/** On-map leg annotations （交通方式/距离/时间）: auto density, everything, or hidden. */
export function useLegLabelMode() {
  const [mode, updateMode] = useState<LegLabelMode>(() => stored('cartula:leg-labels', ['auto', 'all', 'off'], 'auto'));
  const setMode = (value: LegLabelMode) => { updateMode(value); try { localStorage.setItem('cartula:leg-labels', value); } catch { /* opaque MCP iframe */ } };
  return [mode, setMode] as const;
}

/**
 * Route colouring. Default `day` shades each plan's own colour by itinerary
 * day, so plans and days are both readable; `layer` flattens a plan to the one
 * colour the caller set. The default matters more than the stored preference:
 * an MCP host iframe often has no usable localStorage, so most renders start
 * from it.
 */
export function useRouteColorMode() {
  // `layer` was the default in the release that introduced the comparison
  // card. A versioned key prevents that historical default from silently
  // disabling date colours after an upgrade; an explicit choice made in this
  // release remains persistent.
  const key = 'cartula:route-colors-v2';
  const [mode, updateMode] = useState<RouteColorMode>(() => stored(key, ['layer', 'day'], 'day'));
  const setMode = (value: RouteColorMode) => { updateMode(value); try { localStorage.setItem(key, value); } catch { /* opaque MCP iframe */ } };
  return [mode, setMode] as const;
}

/**
 * Whether one of the panels floating over the map stays open instead of folding
 * when the pointer leaves it.
 *
 * Off by default for all of them: the map is what the page is for, and every
 * panel opens on hover anyway, so keeping one on screen has to be something the
 * user asked for. Remembered because the work a pin belongs to — comparing
 * plans, walking a stop list — spans reloads, and re-pinning it every visit is
 * the same click this removed.
 *
 * One key per panel, not one for all of them: pinning the stop list is a
 * statement about stop lists, and it should not also nail the info feed over
 * the map the list is about.
 */
export function usePinnedPanel(key: 'detail' | 'card' | 'info') {
  const storageKey = `cartula:${key}-pinned`;
  const [pinned, update] = useState(() => stored(storageKey, ['on', 'off'], 'off') === 'on');
  const setPinned = (value: boolean) => {
    update(value);
    try { localStorage.setItem(storageKey, value ? 'on' : 'off'); } catch { /* opaque MCP iframe */ }
  };
  return [pinned, setPinned] as const;
}

export function languageExpression(language: MapLanguage): ExpressionSpecification {
  if (language === 'zh') {
    // 优先读取规范的简体中文 name:zh-Hans，避免命中包含 "韩国 / 南韓" 的原始 name:zh 简繁双并列脏数据
    return ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name:zh'], ['get', 'name'], ['get', 'name:latin'], ['get', 'name:en'], ''];
  }
  if (language === 'zh-Hant') {
    // 优先读取纯净的繁体中文 name:zh-Hant
    return ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name'], ['get', 'name:latin'], ['get', 'name:en'], ''];
  }
  if (language === 'en') {
    return ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name'], ''];
  }
  return ['coalesce', ['get', 'name'], ['get', 'name:latin'], ['get', 'name:en'], ''];
}

export function localizeBasemap(map: LibreMap, language: MapLanguage) {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
    const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    // POI names are replaced by coloured icons in applyBasemapPoiIcons.
    if (sourceLayer === 'poi' || sourceLayer === 'aerodrome_label' || layer.id.startsWith('cartula-poi')) continue;
    // Road shields and other numeric labels keep their own expressions.
    if (!/name(?::[\w-]+)?/.test(JSON.stringify(layer.layout['text-field']))) continue;
    map.setLayoutProperty(layer.id, 'text-field', languageExpression(language));

    // 底层渲染优化：提升文字清晰度与对比度，防止文字与底图背景混叠
    try {
      const haloWidth = map.getPaintProperty(layer.id, 'text-halo-width');
      if (typeof haloWidth !== 'number' || haloWidth < 1.6) {
        map.setPaintProperty(layer.id, 'text-halo-width', 1.8);
      }
      const haloBlur = map.getPaintProperty(layer.id, 'text-halo-blur');
      if (typeof haloBlur !== 'number' || haloBlur < 0.8) {
        map.setPaintProperty(layer.id, 'text-halo-blur', 1);
      }
      // 检查是否缺失 halo-color（部分上游公路图层缺少 halo-color 导致文字透明光晕看不清）
      const haloColor = map.getPaintProperty(layer.id, 'text-halo-color');
      if (!haloColor) {
        map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(255, 255, 255, 0.9)');
      }
    } catch {
      // 忽略部分不支持 paint 属性设置的边界情况
    }
  }
}
