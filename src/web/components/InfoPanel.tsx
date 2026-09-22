import { AlertTriangle, Info, Route, Sparkles, X } from 'lucide-react';
import PinButton from './PinButton.js';
import { usePeek } from './peek.js';

export type InfoItemKind = 'intent' | 'note' | 'agent' | 'suggestion' | 'reroute';

export interface InfoItem {
  id: string;
  kind: InfoItemKind;
  title: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const KIND_LABEL: Record<InfoItemKind, string> = {
  intent: '规划意图',
  note: '说明',
  agent: 'AGENT 调整说明',
  suggestion: '建议',
  reroute: '待 Agent 重算',
};

function KindIcon({ kind }: { kind: InfoItemKind }) {
  if (kind === 'agent' || kind === 'suggestion') return <Sparkles size={15}/>;
  if (kind === 'reroute') return <Route size={15}/>;
  if (kind === 'intent') return <AlertTriangle size={15}/>;
  return <Info size={15}/>;
}

/**
 * Everything the agent or the planning process has to say about this map, in
 * one list behind one icon. The map is the page; none of this is resident —
 * the icon's badge says how much is waiting.
 */
export default function InfoPanel({ items, pinned, onPin, onClose }: { items: InfoItem[]; pinned: boolean; onPin: (pinned: boolean) => void; onClose: () => void }) {
  // Same rule as every other panel over the map: the heading stays, the list
  // folds away once the pointer has moved on. See `peek.ts`.
  const peek = usePeek<HTMLElement>({ pinned });
  return <aside className="info-panel" data-collapsed={!peek.open} ref={peek.ref} {...peek.handlers} aria-label="信息">
    <div className="panel-heading">
      <span className="panel-title"><strong>信息 · {items.length} 条</strong></span>
      <PinButton pinned={pinned} label="信息列表" onPin={onPin}/>
      <button type="button" className="icon-button" aria-label="关闭信息列表" onClick={onClose}><X size={16}/></button>
    </div>
    <div className="panel-body">
      {items.length === 0 && <p className="panel-empty">暂时没有信息。</p>}
      {items.map(item => <article key={item.id} className={`info-item kind-${item.kind}`}>
        <span className="info-item-icon" aria-hidden="true"><KindIcon kind={item.kind}/></span>
        <div className="info-item-body">
          <span className="eyebrow">{KIND_LABEL[item.kind]}</span>
          <h3>{item.title}</h3>
          <p>{item.text}</p>
          {item.actionLabel && item.onAction && <button type="button" className="button compact primary" onClick={item.onAction}>{item.actionLabel}</button>}
        </div>
        {item.onDismiss && <button type="button" className="icon-button" aria-label="关闭这条信息" onClick={item.onDismiss}><X size={14}/></button>}
      </article>)}
    </div>
  </aside>;
}
