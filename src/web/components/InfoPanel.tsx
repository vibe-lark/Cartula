import { AlertTriangle, Info, Route, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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

/**
 * The kinds that arrive: something the Agent or Cartula said since the user
 * last looked. Intents and layer notes are standing context — they are on
 * every planned map, and counting them kept the badge red forever, so a new
 * adjustment only nudged it from 4 to 5.
 */
const NEWS: ReadonlySet<InfoItemKind> = new Set(['agent', 'suggestion', 'reroute']);

function readSeen(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]); } catch { return new Set(); }
}

/**
 * Which feed items are new to this reader. `unread` drives the icon's badge;
 * `fresh` is what was unread when the feed was opened, so the panel can mark
 * those items even though opening it is what counts them as read. Seen ids
 * are kept per map where storage allows; an MCP iframe without it just
 * forgets on reload, which errs toward showing the badge.
 */
export function useInfoSeen(mapId: string, items: InfoItem[], open: boolean) {
  const key = `cartula:info-seen:${mapId}`;
  const [seen, setSeen] = useState(() => readSeen(key));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const unread = items.filter(item => NEWS.has(item.kind) && !seen.has(item.id));
  useEffect(() => { setSeen(readSeen(key)); }, [key]);
  useEffect(() => {
    if (!open || !unread.length) return;
    setFresh(current => new Set([...current, ...unread.map(item => item.id)]));
    setSeen(current => {
      const next = new Set([...current, ...unread.map(item => item.id)]);
      try { localStorage.setItem(key, JSON.stringify([...next].slice(-60))); } catch { /* opaque MCP iframe */ }
      return next;
    });
  }, [open, unread.map(item => item.id).join('\n'), key]);
  useEffect(() => { if (!open) setFresh(new Set()); }, [open]);
  return { unread: unread.length, fresh };
}

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
export default function InfoPanel({ items, fresh, pinned, onPin, onClose }: { items: InfoItem[]; fresh?: ReadonlySet<string>; pinned: boolean; onPin: (pinned: boolean) => void; onClose: () => void }) {
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
      {items.map(item => <article key={item.id} className={`info-item kind-${item.kind} ${fresh?.has(item.id) ? 'fresh' : ''}`}>
        <span className="info-item-icon" aria-hidden="true"><KindIcon kind={item.kind}/></span>
        <div className="info-item-body">
          <span className="eyebrow">{KIND_LABEL[item.kind]}{fresh?.has(item.id) && <b className="info-item-new">新</b>}</span>
          <h3>{item.title}</h3>
          <p>{item.text}</p>
          {item.actionLabel && item.onAction && <button type="button" className="button compact primary" onClick={item.onAction}>{item.actionLabel}</button>}
        </div>
        {item.onDismiss && <button type="button" className="icon-button" aria-label="关闭这条信息" onClick={item.onDismiss}><X size={14}/></button>}
      </article>)}
    </div>
  </aside>;
}
