import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_SCALE, ICON_WARN_COLOR, POINT_ICONS, POINT_ICON_META, iconFill, markerIcon, parsePointIcon, pointLabel } from '../src/core/icons.js';
import { POI_PATHS, poiClassToIcon, poiImageId, pinAtlasIcon } from '../src/web/components/poiIcons.js';
import { applyOperations, normalizeMap, toMapInput } from '../src/core/model.js';
import { MapInputSchema } from '../src/core/schema.js';
import type { MapSnapshot } from '../src/core/types.js';

test('marker catalog is closed, spots default to pin, route stops stay circles unless icon is set', () => {
  assert.equal(POINT_ICONS.length, Object.keys(POINT_ICON_META).length);
  assert.equal(parsePointIcon('castle'), undefined);
  assert.equal(markerIcon('route'), undefined);
  assert.equal(markerIcon('route', 'hotel'), 'hotel');
  assert.equal(markerIcon('spots'), 'pin');
  assert.equal(markerIcon('spots', 'restaurant'), 'restaurant');
  assert.equal(pointLabel(0, '尼斯', 'route'), '1 尼斯');
  assert.equal(pointLabel(0, '咖啡店', 'spots'), '咖啡店');
  assert.equal(pointLabel(2, '尼斯', 'route', true), '尼斯', 'a numbered disc already shows the ordinal');
  assert.equal(ICON_SCALE, 1.2);
  assert.equal(iconFill('hotel', 'light'), '#EA4335');
  assert.equal(iconFill('restaurant', 'light'), '#F9AB00');
  assert.equal(iconFill('viewpoint', 'light'), '#34A853');
  assert.equal(iconFill('hotel', 'dark'), POINT_ICON_META.hotel.darkColor);
  assert.equal(iconFill('restaurant', 'light', true), ICON_WARN_COLOR);
  for (const icon of POINT_ICONS) {
    if (icon === 'pin') assert.equal(POI_PATHS[icon], '');
    else assert.ok(POI_PATHS[icon].length > 8, `${icon} has a pictogram`);
    assert.match(POINT_ICON_META[icon].color, /^#[0-9A-F]{6}$/i);
  }
  assert.equal(poiClassToIcon('hotel'), 'hotel');
  assert.equal(poiClassToIcon('fast_food'), 'restaurant');
  assert.equal(poiClassToIcon('rail'), 'station');
  assert.equal(poiClassToIcon('florist'), undefined);
  assert.equal(pinAtlasIcon('hotel', 'light'), 'hotel-light');
  assert.equal(pinAtlasIcon('hotel', 'dark', true), 'hotel-warn');
  assert.equal(poiImageId('airport', 'dark'), 'cartula-poi-airport-dark');
});

test('schema accepts known icons, strips unknown, and round-trips through the model', () => {
  const parsed = MapInputSchema.parse({
    layers: [{ name: '候选', kind: 'spots', points: [{ name: '湖边餐厅', at: [6.14, 46.2], icon: 'restaurant' }] }],
  });
  assert.equal(parsed.layers[0].points![0].icon, 'restaurant');
  assert.equal(MapInputSchema.safeParse({
    layers: [{ name: '候选', points: [{ name: 'x', at: [0, 0], icon: 'castle' }] }],
  }).success, false);

  const { title, layers } = normalizeMap(parsed, undefined, 'agent');
  const snapshot: MapSnapshot = {
    id: 'test', title, layers, version: 1, parent: null, changed: false, changes: [], events: [],
    updatedAt: '2026-09-07T00:00:00.000Z', url: 'https://example.test/m/test',
  };
  assert.equal(layers[0].points[0].icon, 'restaurant');
  assert.equal(toMapInput(snapshot).layers[0].points![0].icon, 'restaurant');

  const cleared = applyOperations(snapshot, [{ op: 'update', layerId: layers[0].id, pointId: layers[0].points[0].id, patch: { icon: null } }]);
  assert.equal(cleared.layers[0].points[0].icon, undefined);
  const hotel = applyOperations(snapshot, [{ op: 'update', layerId: layers[0].id, pointId: layers[0].points[0].id, patch: { icon: 'hotel' } }]);
  assert.equal(hotel.layers[0].points[0].icon, 'hotel');
});
