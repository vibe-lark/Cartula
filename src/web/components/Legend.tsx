import type { MapLayer } from '../../core/types.js';
import { RISK_COLORS, RISK_LABELS, layerDays, planDayColor, type RouteColorMode, type SegmentRisk } from './legs.js';

export interface LegendProps {
  /** Route layers, in map order. Spots and GeoJSON layers have no legend rows. */
  routes: MapLayer[];
  colorMode: RouteColorMode;
  onColorMode: (mode: RouteColorMode) => void;
  /** Risk styles actually drawn right now — the legend never lists absent ones. */
  risks: SegmentRisk[];
  /** Itinerary days present on the visible layers. */
  days: number[];
  /** Several routes are on the map, so one of them is drawn as the answer. */
  comparing: boolean;
  /** Opens the basemap credits and third-party licences. */
  onCredits: () => void;
}

/**
 * The map legend, shown from the top bar's 图例 menu. Content is whatever the
 * map actually draws: per-plan day shades in `day` mode, flat route colours in
 * `layer` mode, and only the risk styles present on screen. The colour-mode
 * toggle lives here too, next to the colours it switches.
 */
export default function Legend({ routes, colorMode, onColorMode, risks, days, comparing, onCredits }: LegendProps) {
  return <div className="legend-card" aria-label="地图图例">
    <div className="leg-mode" role="group" aria-label="路线配色">
      {([['day', '方案 + 按天分色', '每个方案保留自己的色系，方案内按行程天数分深浅'] as const, ['layer', '每方案单色', '每条路线一种颜色，不区分天数'] as const]).map(([value, label, title]) =>
        <button key={value} type="button" title={title} aria-pressed={colorMode === value} className={colorMode === value ? 'checked' : ''} onClick={() => onColorMode(value)}>{label}</button>)}
    </div>
    <p className="legend-note">{colorMode === 'day' ? '每个方案一种色系，方案内按天分深浅。' : '每条路线一种颜色，方便对照。'}时间不含停留。</p>
    {colorMode === 'day' && (days.length
      ? routes.map(layer => {
        const own = layerDays(layer);
        return <p className="legend-row" key={layer.id}>
          <span className="legend-title">{layer.name}</span>
          {own.length
            ? own.map(day => <span key={day} className="legend-item"><i style={{ background: planDayColor(layer.color, day) }}/>D{day}</span>)
            : <span className="legend-item"><i style={{ background: layer.color }}/>未填天数</span>}
        </p>;
      })
      : <p className="legend-row">
        <span className="legend-title">按天分色已开启</span>
        <span className="legend-item">当前可见地点没有填写天数，仍按方案颜色绘制</span>
      </p>)}
    {colorMode === 'layer' && <p className="legend-row"><span className="legend-title">路线颜色</span>{routes.map(layer => <span key={layer.id} className="legend-item"><i style={{ background: layer.color }}/>{layer.name}</span>)}</p>}
    {risks.length > 0 && <p className="legend-row">
      <span className="legend-title">线型含义</span>
      {risks.map(risk => <span key={risk} className="legend-item">
        <i style={{ background: risk === 'reminder' ? '#8f959e' : RISK_COLORS[risk as keyof typeof RISK_COLORS] ?? '#8f959e', borderRadius: 2 }}/>
        {RISK_LABELS[risk]}
      </span>)}
    </p>}
    {comparing && <p className="legend-note">当前方案为实线，其余方案淡化为背景。点按背景路线或它的标签即可切换过去。</p>}
    <p className="legend-note">虚线表示这一段需要留意；地点提醒不代表路况。</p>
    <p className="legend-note">标注带「直线」的距离是两点间的直线估算，其余距离和时间来自路线数据。</p>
    <button type="button" className="legend-credits" onClick={onCredits}>地图数据与开源声明</button>
  </div>;
}
