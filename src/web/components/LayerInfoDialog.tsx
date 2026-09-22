import { Sparkles } from 'lucide-react';
import type { MapLayer } from '../../core/types.js';
import { Modal } from './Modal.js';
import RouteMetrics from './RouteMetrics.js';
import { layerKind } from './LayerPanel.js';

/**
 * Everything about a plan that is not a stop: how its distance and time were
 * arrived at, where its data came from, who last touched it. All of it used to
 * be resident in the stop list — a metrics block above the first day, a
 * footer and a 数据来源 disclosure below the last — and none of it is read
 * more than once per plan. Behind one button it costs the list nothing.
 */
export default function LayerInfoDialog({ layer, onClose }: { layer: MapLayer; onClose: () => void }) {
  return <Modal title={layer.name} onClose={onClose}>
    <p className="dialog-description">{layerKind(layer)} · {layer.points.length} 个地点{layer.geojson ? ` · ${layer.geojson.features.length} 个要素` : ''}</p>
    {layer.kind === 'route' && <RouteMetrics layer={layer}/>}
    <dl className="layer-info">
      <div><dt>提供方</dt><dd><span className={`author ${layer.edited_by}`}><Sparkles size={11}/>{layer.edited_by === 'user' ? '你已调整' : 'Agent 提供'}</span></dd></div>
      {layer.from && <div><dt>数据来源</dt><dd>{layer.from}</dd></div>}
      {layer.intent && <div><dt>规划意图</dt><dd>{layer.intent}</dd></div>}
      {layer.note && <div><dt>说明</dt><dd>{layer.note}</dd></div>}
    </dl>
  </Modal>;
}
