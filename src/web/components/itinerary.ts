import type { Intent, MapLayer, MapPoint } from '../../core/types.js';
import { routeDistance } from '../../core/geo.js';

/**
 * List arithmetic for one day group of a stop list.
 *
 * The list is drawn per day (`point.day`) but `reorder` moves a stop in the
 * layer's single order. Every control that moves a stop inside a group has to
 * translate between the two, and getting that wrong is what makes a press look
 * like nothing happened while the map draws a zigzag. These are the
 * translations, kept pure so they can be pinned by tests.
 */

export interface DayGroupRef {
  /** The group's day; null for 未排期. */
  day: number | null;
  points: Pick<MapPoint, 'id'>[];
}

/**
 * Where 上移 / 下移 sends a stop, as the list draws it.
 *
 * Inside its group the stop swaps places with the neighbouring stop of the
 * same day, however many stops of other days sit between the two in the layer
 * order. At the edge of the group it crosses into the adjacent group on
 * screen: 下移 on a day's last stop makes it the first stop of the next day,
 * 上移 on a day's first stop makes it the last of the previous one — and
 * `toDay` says so, because a position that disagrees with the day is what
 * drew the zigzag. `null` when there is nowhere to go.
 */
export function stepMove(layer: Pick<MapLayer, 'points'>, groups: DayGroupRef[], pointId: string, dir: -1 | 1): { toIndex: number; toDay?: number | null } | null {
  const g = groups.findIndex(group => group.points.some(point => point.id === pointId));
  if (g < 0) return null;
  const group = groups[g];
  const at = group.points.findIndex(point => point.id === pointId);
  const neighbour = group.points[at + dir];
  if (neighbour) {
    const index = layer.points.findIndex(point => point.id === neighbour.id);
    return index < 0 ? null : { toIndex: index };
  }
  const next = groups[g + dir];
  if (!next) return null;
  if (dir < 0) {
    const toIndex = groupEndTarget(layer, next.points, pointId);
    return { toIndex, toDay: next.day };
  }
  const first = next.points[0];
  if (!first) return { toIndex: -1, toDay: next.day };
  const from = layer.points.findIndex(point => point.id === pointId);
  const start = layer.points.findIndex(point => point.id === first.id);
  // Before the next group's first stop: from above, removing this stop shifts
  // that one up a place first.
  return { toIndex: from < start ? start - 1 : start, toDay: next.day };
}

/**
 * The `toIndex` that puts a dragged stop after the last stop of a group, so a
 * drop on the group's header joins the end of that day from either direction.
 *
 * `reorder` removes the stop before inserting it. Coming from above, the
 * group's last stop has shifted up one by then and its old index already means
 * "after it"; coming from below, nothing shifted and the index has to be one
 * past it. -1 for an empty group, which has no stop to land after: the caller
 * then only changes the day.
 */
export function groupEndTarget(layer: Pick<MapLayer, 'points'>, group: Pick<MapPoint, 'id'>[], draggedId: string): number {
  const last = group.at(-1);
  if (!last) return -1;
  const end = layer.points.findIndex(point => point.id === last.id);
  const from = layer.points.findIndex(point => point.id === draggedId);
  if (end < 0) return -1;
  return from > end ? end + 1 : end;
}

export interface DayTravel {
  distanceKm: number;
  /** Some leg had no routed distance, so part of the total is straight-line. */
  straight: boolean;
  /** Time in motion over the legs that report one; undefined when none does. */
  minutes?: number;
  /** Some leg reported a distance but no time, so `minutes` is a lower bound. */
  partialTime: boolean;
  legs: number;
}

/**
 * One day's travel: the legs out of each of its stops, the same legs whose
 * lines the rows show and the map draws in that day's colour (`segmentColor`
 * colours a leg by the day of the stop it leaves). Summing anything else would
 * give a header that disagrees with both the rows under it and the map.
 */
export function dayTravel(layer: MapLayer, group: MapPoint[]): DayTravel | null {
  if (layer.kind !== 'route') return null;
  let distanceKm = 0, minutes = 0, timed = 0, legs = 0, straight = false;
  for (const point of group) {
    const index = layer.points.findIndex(item => item.id === point.id);
    const next = layer.points[index + 1];
    if (index < 0 || !next) continue;
    const leg = layer.routing?.legs?.find(part => part.fromPointId === point.id && part.toPointId === next.id);
    legs += 1;
    if (leg?.distanceKm !== undefined) distanceKm += leg.distanceKm;
    else { distanceKm += routeDistance([point.at, next.at]); straight = true; }
    if (leg?.durationMinutes !== undefined) { minutes += leg.durationMinutes; timed += 1; }
  }
  if (!legs) return null;
  return { distanceKm, straight, minutes: timed ? minutes : undefined, partialTime: timed > 0 && timed < legs, legs };
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 0–99 in Arabic or simple Chinese numerals (三, 十, 十二, 二十五). */
function parseCount(text: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const ten = text.indexOf('十');
  if (ten < 0) return text.length === 1 && text in CN_DIGITS ? CN_DIGITS[text] : undefined;
  const tens = ten === 0 ? 1 : CN_DIGITS[text.slice(0, ten)];
  const ones = ten === text.length - 1 ? 0 : CN_DIGITS[text.slice(ten + 1)];
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}

const DAILY_LIMIT = /(?:每天|每日|单日|一天)[^，。；,;]{0,8}?(?:不超过|不多于|不超|少于|以内|最多|控制在|≤|<=)\s*([0-9.]+|[零一二两三四五六七八九十]+)\s*(?:个)?(半)?\s*(小时|h|分钟|min)/i;

/**
 * The per-day travel cap a person wrote in plain words — 每天开车不超过三小时,
 * 每日车程控制在 4 小时以内 — in minutes. It is the project's own example of an
 * intent, and the day headers can only flag a day that breaks it if they know
 * the number. Unrecognised phrasing yields undefined: no limit is better than
 * a wrong one.
 */
export function dailyLimitMinutes(texts: (string | undefined)[]): number | undefined {
  let limit: number | undefined;
  for (const text of texts) {
    const match = text?.match(DAILY_LIMIT);
    if (!match) continue;
    const whole = parseCount(match[1]);
    if (whole === undefined) continue;
    const count = whole + (match[2] ? 0.5 : 0);
    if (count <= 0) continue;
    const minutes = /^(小时|h)$/i.test(match[3]) ? count * 60 : count;
    limit = limit === undefined ? minutes : Math.min(limit, minutes);
  }
  return limit;
}

/** The texts a layer's daily limit can come from: the map's and the layer's live intents. */
export function layerIntentTexts(layer: Pick<MapLayer, 'id' | 'intent'>, intents: Intent[] | undefined): string[] {
  const live = (intents ?? []).filter(intent => intent.status !== 'resolved'
    && (intent.scope === 'map' || (intent.scope === 'layer' && intent.layerId === layer.id)));
  return [layer.intent ?? '', ...live.map(intent => intent.text)];
}
