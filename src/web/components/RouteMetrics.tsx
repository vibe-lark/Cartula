import { layerStats } from '../../core/model.js';
import { routeDistance } from '../../core/geo.js';
import type { MapLayer } from '../../core/types.js';
import { TRAVEL_TIME_NOTE, compactDuration, formatDistance, formatDuration, layerTravelProfile, legModeLabel, travelTimeLabel } from './legs.js';

export { formatDistance, formatDuration };

/**
 * The leg out of a stop, as the one line under its name in the list:
 * 驾车 244.8 km · 3小时6分. It sits under the stop it leaves and the row's
 * connector runs from there to the next one, so the line does not say 至下一站;
 * with that prefix, 路由 and the spaced duration it was ~225px and ended in an
 * ellipsis before the numbers on every editable row (163px of text). 直线 stays:
 * it is the one qualifier that changes what the number means.
 */
export function segmentInfo(layer: MapLayer, index: number) {
  const start = layer.points[index], end = layer.points[index + 1];
  if (layer.kind !== 'route' || !start || !end) return undefined;
  const leg = layer.routing?.legs?.find(part => part.fromPointId === start.id && part.toPointId === end.id);
  const mode = legModeLabel(leg?.profile ?? layer.routing?.profile);
  const distance = leg?.distanceKm !== undefined ? formatDistance(leg.distanceKm) : `${formatDistance(routeDistance([start.at, end.at]))} 直线`;
  const parts = [mode ? `${mode} ${distance}` : distance];
  if (leg?.durationMinutes !== undefined) parts.push(compactDuration(leg.durationMinutes));
  return parts.join(' · ');
}

/**
 * Where a route's distance and time come from, in full. This used to sit at
 * the top of every stop list; it is reference material, read once, so it now
 * lives behind the list's 信息 button (see `LayerInfoDialog`) and the list
 * itself keeps one line of totals.
 */
export default function RouteMetrics({ layer }: { layer: MapLayer }) {
  const stats = layerStats(layer);
  // The routing provider measures time in motion only. Calling that a trip
  // time hides every stop, so the label names the mode and the exclusion.
  const timeLabel = travelTimeLabel(layerTravelProfile(layer));
  return <div className="route-metrics">
    <div className="layer-stats">
      <span><b>{formatDistance(stats.routingDistanceKm ?? stats.distanceKm)}</b><small>{stats.routingDistanceKm !== undefined ? '路由里程' : stats.geometryDistanceKm !== undefined ? '路径长度' : '直线距离'}</small></span>
      <span>{stats.durationMinutes !== undefined ? <><b>{formatDuration(stats.durationMinutes)}</b><small>{timeLabel}</small></> : <small>时间待路由数据提供</small>}</span>
      <span><b>{layer.points.some(p => p.day) ? `${stats.days} 天` : '—'}</b><small>{layer.points.some(p => p.day) ? '安排天数' : '未指定天数'}</small></span>
    </div>
    <dl className="metric-details">
      <div><dt>地点间直线合计</dt><dd>{formatDistance(stats.straightDistanceKm ?? stats.distanceKm)}</dd></div>
      <div><dt>路径几何长度</dt><dd>{stats.geometryDistanceKm !== undefined ? formatDistance(stats.geometryDistanceKm) : '未提供路径'}</dd></div>
      <div><dt>路由服务里程</dt><dd>{stats.routingDistanceKm !== undefined ? formatDistance(stats.routingDistanceKm) : '未提供'}</dd></div>
      <div><dt>{timeLabel}</dt><dd>{stats.durationMinutes !== undefined ? formatDuration(stats.durationMinutes) : '未提供，不从距离推算'}</dd></div>
    </dl>
    <p className="metric-note">路由时间{TRAVEL_TIME_NOTE}；整段行程还需另加停留时间。</p>
    {stats.routingSource && <p className="metric-note">路由来源：{stats.routingSource}{layer.routing?.profile ? ` · ${layer.routing.profile}` : ''}</p>}
  </div>;
}
