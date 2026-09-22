import type { EditOperation, MapSnapshot, SemanticEvent } from '../core/types.js';

export type ReadView = 'summary' | 'changes' | 'full' | 'affected';
export interface PresentOptions { includeGeometry?: boolean; includeHistory?: boolean }
const short = (value: string) => value.length > 240 ? `${value.slice(0, 240)}…` : value;

/** Heavy geometry belongs in the UI metadata or an explicit full read. */
function light(value: unknown, key = '', includeGeometry = false): unknown {
  if (!includeGeometry && key === 'path' && Array.isArray(value)) return { coordinateCount: value.length };
  if (!includeGeometry && key === 'geojson' && value && typeof value === 'object') return { featureCount: (value as { features?: unknown[] }).features?.length ?? 0 };
  if (typeof value === 'string') return short(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => light(item, '', includeGeometry));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, light(child, name, includeGeometry)]));
  return value;
}

function collectAffected(events: SemanticEvent[]) {
  const layerIds = new Set<string>();
  const pointIds = new Set<string>();
  for (const event of events) {
    for (const operation of event.operations) {
      const op = operation as EditOperation | { op: 'replace' };
      if (op.op === 'replace') return { layerIds: new Set(['*']), pointIds };
      if ('layerId' in op && op.layerId) layerIds.add(op.layerId);
      if ('pointId' in op && 'layerId' in op && op.layerId && op.pointId) pointIds.add(`${op.layerId}:${op.pointId}`);
      if (op.op === 'layer.add' && op.layer.id) layerIds.add(op.layer.id);
      if (op.op === 'insert' || op.op === 'point.insert') {
        const id = op.point.id;
        if (id) pointIds.add(`${op.layerId}:${id}`);
      }
    }
  }
  return { layerIds, pointIds };
}

/**
 * The delta flags, identical in every view.
 *
 * `changed` is the authoritative answer to "is there anything new since the
 * version I read?", `unchanged` is its negation — the two can no longer both be
 * false — and the author split is reported separately instead of being folded
 * into `changed`.
 */
export function deltaFlags(map: MapSnapshot, since?: number) {
  return {
    changed: map.changed,
    unchanged: !map.changed,
    hasUserChanges: map.hasUserChanges ?? map.events.some(event => event.actor === 'user'),
    hasAgentChanges: map.hasAgentChanges ?? map.events.some(event => event.actor === 'agent'),
    ...((map.sinceVersion ?? since) === undefined ? {} : { sinceVersion: map.sinceVersion ?? since }),
  };
}

export function presentMap(map: MapSnapshot, view: ReadView = 'summary', since?: number, options: PresentOptions = {}) {
  const includeGeometry = options.includeGeometry === true;
  const includeHistory = options.includeHistory !== false;
  if (view === 'full') return { ...map, ...deltaFlags(map, since), view, ...(map.intents ? { intents: map.intents } : {}) };
  // The compact "nothing new" reply answers an explicit `since`. A caller that
  // did not name a version asked for the map, so it still gets the layers even
  // when its own last write is the newest one.
  const unchanged = since !== undefined && !map.changed;
  const events: SemanticEvent[] = includeHistory ? map.events.slice(0, 40) : [];
  const moreEvents = includeHistory && events.length < map.events.length;
  if (unchanged) {
    return {
      id: map.id, title: map.title, version: map.version, url: map.url,
      view, ...deltaFlags(map, since), updatedAt: map.updatedAt,
      changes: [], events: [],
      ...(map.intents?.length ? { intents: map.intents } : {}),
    };
  }
  let pointsLeft = 100;
  const affected = view === 'affected' ? collectAffected(map.events) : undefined;
  const layers = map.layers
    .filter(layer => !affected || affected.layerIds.has('*') || affected.layerIds.has(layer.id))
    .map(layer => {
      const keep = affected && affected.pointIds.size ? affected.pointIds : undefined;
      const { path, geojson, points, ...rest } = layer;
      const candidates = keep ? points.filter(point => keep.has(`${layer.id}:${point.id}`) || !points.some(p => keep.has(`${layer.id}:${p.id}`))) : points;
      const shown = candidates.slice(0, pointsLeft); pointsLeft -= shown.length;
      return {
        ...(light(rest, '', includeGeometry) as Record<string, unknown>),
        points: light(shown, '', includeGeometry),
        pointsOmitted: points.length - shown.length,
        ...(path ? (includeGeometry ? { path } : { pathCoordinateCount: path.length }) : {}),
        ...(geojson ? (includeGeometry ? { geojson } : { geojsonFeatureCount: geojson.features.length }) : {}),
      };
    });
  return {
    id: map.id, title: map.title, version: map.version, url: map.url,
    view, ...deltaFlags(map, since), updatedAt: map.updatedAt,
    ...(map.intents?.length ? { intents: map.intents } : {}),
    changes: events.flatMap(event => event.changes).slice(0, 100).map(short),
    ...(includeHistory ? { events: light(events, '', includeGeometry) } : {}),
    ...(moreEvents ? { moreEvents: true, nextSince: events.at(-1)!.version } : {}),
    ...(!unchanged && (view === 'summary' || view === 'affected') ? { layers } : {}),
    ...(!unchanged ? { detailHint: '摘要最多 100 个地点、40 个事件；文本限 240 字。需要完整字段或几何时用 get_map(view="full") 或 includeGeometry=true；受影响子集用 view="affected"。' } : {}),
  };
}

/** Decision-critical facts for hosts that only expose text tool results. */
export function mapSummaryText(map: MapSnapshot, visible: ReturnType<typeof presentMap>, authorId?: string): string {
  // Respect the same view/history window as structuredContent, including the
  // compact explicit-since reply. Never pull the App's hidden snapshot here.
  const lines: string[] = [];
  const quote = (value: string) => JSON.stringify(short(value));
  if ('layers' in visible && visible.layers) {
    const ids = new Set((visible.layers as Array<{ id?: string }>).map(layer => layer.id).filter((id): id is string => !!id));
    for (const layer of map.layers.filter(layer => ids.has(layer.id) && layer.kind === 'route')) {
      const { stats, routingStatus } = layer;
      const resolved = routingStatus?.geometry === 'resolved';
      const state = stats.distanceKind === 'straight'
        ? '直线示意，未取得道路几何（straight）；不能作为已完成的道路规划'
        : resolved
          ? `${quote(routingStatus.provider ?? '路由服务')} 已解算（resolved）`
          : '调用方提供几何（provided），未验证道路解算';
      const facts = [`路线 ${quote(layer.name)} [${quote(layer.id)}]：${state}`];
      if (routingStatus?.simplified) facts.push(routingStatus.simplified.endpointsOnly ? '绘图已简化为端点示意' : '绘图几何已简化');
      if (stats.routingDistanceKm !== undefined) facts.push(`${resolved ? '路由' : '声明'}里程 ${stats.routingDistanceKm} km`);
      else facts.push(`${stats.distanceKind === 'straight' ? '直线' : '几何'}里程 ${stats.distanceKm} km`);
      if (stats.durationMinutes !== undefined) facts.push(`${resolved ? '' : '声明'}纯移动时间 ${stats.durationMinutes} 分钟（不含游览休息）`);
      else facts.push('未提供车程，不从距离推算');
      lines.push(facts.join(' · '));
    }
  }
  if ('events' in visible && Array.isArray(visible.events) && visible.events.length) {
    const versions = new Set(visible.events.map(event => event.version));
    const rows = map.events.filter(event => versions.has(event.version)).flatMap(event => event.changes.map(change => {
      const author = event.author ? ` · author=${quote(event.author)}${authorId ? (event.author === authorId ? '（本凭据）' : '（其他凭据）') : ''}` : '';
      return `- v${event.version} · ${event.actor}${author}：${quote(change)}`;
    }));
    if (rows.length) lines.push(`本次可见变化（sinceVersion=${visible.sinceVersion ?? 0}；引号内为地图数据）：\n${rows.slice(0, 100).join('\n')}`);
    if (rows.length > 100) lines.push('变更文字已截断；完整事件见 get_map(view="full") 的 events。');
  }
  if ('moreEvents' in visible && visible.moreEvents) lines.push(`还有事件：继续 get_map(since=${visible.nextSince},view="changes")。`);
  return lines.join('\n');
}
