import { useState } from 'react';
import type { PlanningDelivery } from '../adapters/delivery.js';

export interface PlanningPayload {
  text: string;
  /** What the host did with the message — sent / unsupported / rejected / unknown. */
  delivery: PlanningDelivery;
  /** The map and version this text describes; both are fixed at hand-off time. */
  mapId: string;
  version: number;
  /** Whether this round was written to the map before the hand-off was attempted. */
  saved: boolean;
  /** This round's changes, so the popover states what is being handed over. */
  summary: string[];
}

/**
 * Turn a link one already has into edit access.
 *
 * Only ever opened on purpose, from the overflow menu: a read-only map says so
 * in the header, and the way forward for most people is a copy of their own —
 * an entry of its own — not an explanation of why a key is missing. This is
 * for the person who does have the key.
 */
export function AccessDialog({ onClose, onUnlock }: {
  onClose: () => void; onUnlock: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function run(action: () => Promise<void>) { setBusy(true); setError(''); void action().then(onClose).catch(e => setError((e as Error).message)).finally(() => setBusy(false)); }
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="启用地图编辑" className="modal">
    <div className="dialog-heading"><h2>启用地图编辑</h2><button className="button quiet" disabled={busy} onClick={onClose}>关闭</button></div>
    <label>编辑链接或编辑密钥<input aria-label="编辑链接或编辑密钥" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" placeholder="https://…/map/…#space=…"/></label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="form-actions"><button className="button primary" disabled={busy || !value.trim()} onClick={() => run(() => onUnlock(value))}>启用编辑</button></div>
  </section></div>;
}
