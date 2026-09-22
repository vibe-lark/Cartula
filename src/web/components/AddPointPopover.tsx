import { useState } from 'react';
import { Check, MapPin, X } from 'lucide-react';
import type { Coord, MapLayer } from '../../core/types.js';

export interface AddPointPopoverProps {
  layer: MapLayer;
  /** Coordinates picked from the map — measured, never typed. */
  at: Coord;
  /** Inherited from the point this one is inserted after, when known. */
  day?: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; note: string }) => Promise<void> | void;
}

/**
 * The whole add-a-point form: a name, a note, and a spot already picked on the
 * map. Everything else the data model carries is inherited (the layer, the
 * day, the position after a sibling) or edited later from the point's own
 * inspector.
 */
export default function AddPointPopover({ layer, at, day, busy, onClose, onSubmit }: AddPointPopoverProps) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const coordText = `${at[1].toFixed(5)}°, ${at[0].toFixed(5)}°`;
  return <section className="point-inspector add-popover" aria-label="添加地点">
    <div className="inspector-heading"><span className="eyebrow">NEW PLACE</span><button type="button" className="icon-button" aria-label="关闭添加地点" onClick={onClose}><X size={18}/></button></div>
    <h2>添加一个地点</h2>
    <p className="inspector-layer"><i style={{ background: layer.color }}/>{layer.name}{day ? ` · 第 ${day} 天` : ''}</p>
    <form onSubmit={e => { e.preventDefault(); setSaving(true); void Promise.resolve(onSubmit({ name: name.trim(), note: note.trim() })).catch(() => setSaving(false)); }}>
      <fieldset disabled={busy || saving}>
        <label>地点名称<input name="name" value={name} onChange={e => setName(e.target.value)} placeholder="例如：五大连池" required maxLength={80} autoFocus/></label>
        <label>简单描述<textarea aria-label="简单描述" name="note" rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} placeholder="停留安排、灵感或提醒（可选）"/></label>
        <p className="field-hint"><MapPin size={12}/> 坐标 {coordText}（点击地图自动获得）</p>
      </fieldset>
      <div className="form-actions">
        <button type="button" className="button quiet" onClick={onClose}>取消</button>
        <button type="submit" className="button primary" disabled={busy || saving || !name.trim()}><Check size={16}/>{saving ? '正在添加…' : '确认添加'}</button>
      </div>
    </form>
  </section>;
}
