import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import type { MapSnapshot } from '../../core/types.js';
import { deliveryNotice, fallbackNotice, submitErrorText, submitOutcome, type PlanningDelivery, type SubmitOutcome } from '../adapters/delivery.js';
import { planningMessage, roundSummary } from '../handoff.js';
import { MANUAL_COPY_HINT, copyText, selectAll } from './clipboard.js';
import type { PlanningPayload } from './CollaborationDialogs.js';

export interface SendPopoverProps {
  map: MapSnapshot;
  mode: string;
  since: number;
  /** The share token this view holds, if any — folded into the local fallback message below. */
  shareCredential?: { previewToken: string; canWrite: boolean };
  busy: boolean;
  onClose: () => void;
  onPrepare: (intent: string) => Promise<PlanningPayload>;
  onCopied: (mapId: string, version: number) => void;
  /** Explicit, user-initiated retry. Never called automatically. */
  onResend?: (payload: PlanningPayload) => Promise<PlanningDelivery>;
}

/**
 * The hand-off, in a popover: a line for the user's own description, the
 * round's changes listed underneath, and one send button. The result step
 * carries the delivery state and a copy of the message, because a host that
 * cannot take the message still leaves a copy worth taking.
 */
export default function SendPopover({ map, mode, since, shareCredential, busy, onClose, onPrepare, onCopied, onResend }: SendPopoverProps) {
  const [intent, setIntent] = useState('');
  const [result, setResult] = useState<PlanningPayload>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<{ text: string; mapId: string; version: number; summary: string[]; intent: string; outcome: SubmitOutcome }>();
  const [checked, setChecked] = useState(false);
  // The host can swap the map underneath an open popover. A draft for map A
  // must never be sent into map B — this ref guards the answers too.
  const openMapId = useRef(map.id);
  // The two places the message is on screen, so a refused clipboard can hand
  // the reader a selection instead of an apology.
  const fallbackField = useRef<HTMLTextAreaElement>(null);
  const resultField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    openMapId.current = map.id;
    setResult(undefined); setFallback(undefined); setIntent(''); setError(''); setCopied(false); setChecked(false);
  }, [map.id]);
  const summary = result?.summary ?? roundSummary(map, since);
  const notice = result ? deliveryNotice(result.delivery, { mode, version: result.version, saved: result.saved }) : undefined;
  const stale = Boolean(result && result.mapId !== map.id);
  /**
   * Copy the hand-off message, or fall back to the message itself.
   *
   * A host webview usually refuses the clipboard outright (see `clipboard.ts`),
   * and this message is the whole point of the popover — so when neither copy
   * route works the text above is selected and the hint names the keystroke.
   * The round still counts as handed over either way: the message exists and
   * the user has it in front of them.
   */
  function copy(text: string, mapId: string, version: number, field: HTMLTextAreaElement | null) {
    setError('');
    void copyText(text).then(result => {
      if (result === 'unavailable') { selectAll(field); setError(MANUAL_COPY_HINT); return; }
      setCopied(true);
      onCopied(mapId, version);
    });
  }
  return <section className="send-popover" aria-label="交给 Agent">
    <div className="dialog-heading"><h2>按这些修改继续规划</h2><button type="button" className="icon-button" aria-label="关闭发送" onClick={onClose}><X size={16}/></button></div>
    {!result ? <>
      <p className="delivery-hint">{mode === 'browser' ? '生成一段消息，请复制回原来的对话。' : mode === 'offline' ? '离线修改需连同导出的 JSON 一起交给 Agent。' : '通过宿主发送；宿主不支持时可复制消息。'}</p>
      <label>补充说明（可选）<textarea aria-label="这次修改的意图" value={intent} onChange={e => setIntent(e.target.value)} maxLength={2000} rows={3} placeholder="例如：删掉尼斯，把两天加给瑞士；每天开车不超过三小时。"/></label>
      <details className="changes-log" open={summary.length > 0}><summary>本轮修改 · {summary.length ? `${summary.length} 条` : '暂无新修改'}（当前 v{map.version}）</summary>
        <ul>{(summary.length ? summary.slice(-12) : ['自上次提交以来还没有新的修改']).map((change, i) => <li key={i}>{change}</li>)}</ul>
      </details>
      {error && <p role="alert" className="form-error">{error}</p>}
      {fallback && <>
        <p className="delivery-hint">{fallbackNotice({ version: fallback.version, hasIntent: Boolean(fallback.intent), outcome: fallback.outcome })}</p>
        <label>可复制的继续规划消息<textarea ref={fallbackField} aria-label="可复制的继续规划消息" className="json-input" readOnly value={fallback.text} rows={6} onFocus={e => e.target.select()}/></label>
        <div className="form-actions"><button type="button" className="button" onClick={() => copy(fallback.text, fallback.mapId, fallback.version, fallbackField.current)}>{copied ? '已复制' : '复制消息'}</button></div>
      </>}
      <div className="form-actions">
        <button type="button" className="button primary" disabled={busy || sending} onClick={() => {
          const basis = map;
          const basisSince = since;
          setSending(true); setError(''); setFallback(undefined);
          void onPrepare(intent)
            .then(payload => { if (openMapId.current === basis.id) setResult(payload); })
            .catch(e => {
              if (openMapId.current !== basis.id) return;
              setError(submitErrorText((e as Error).message));
              setFallback({
                text: `${planningMessage(basis, basisSince, shareCredential)}${intent.trim() ? `\n本次意图：${intent.trim()}` : ''}`,
                mapId: basis.id, version: basis.version, summary: roundSummary(basis, basisSince), intent: intent.trim(),
                outcome: submitOutcome(e),
              });
            })
            .finally(() => { if (openMapId.current === basis.id) setSending(false); });
        }}><Sparkles size={15}/>{sending ? '正在整理…' : mode === 'mcp' ? '一键发送给 Agent' : '生成继续规划消息'}</button>
      </div>
    </> : <>
      <p role="status" className={`delivery-state ${notice!.tone}`}>{notice!.text}</p>
      <p className="delivery-hint">{notice!.hint}</p>
      {stale && <p role="alert" className="form-error">地图已经切换到另一张，这段消息属于上一张地图。请复制后手动发送，不要在这里重发。</p>}
      <details className="changes-log" open={summary.length > 0}><summary>本轮交给 Agent 的修改 · {summary.length} 条</summary>
        <ul>{(summary.length ? summary.slice(-12) : ['本轮没有记录到新的修改']).map((change, i) => <li key={i}>{change}</li>)}</ul>
      </details>
      <label>本轮修改消息<textarea ref={resultField} aria-label="本轮修改消息" className="json-input" readOnly value={result.text} rows={7} onFocus={e => e.target.select()}/></label>
      {notice!.canRetry && onResend && !stale && notice!.confirmBeforeRetry && <label className="checkbox-label">
        <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/>我已回对话确认，那里没有这条消息
      </label>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="form-actions">
        {notice!.canRetry && onResend && !stale && <button type="button" className="button" disabled={sending || (notice!.confirmBeforeRetry && !checked)} onClick={() => {
          const sendingPayload = result;
          setSending(true); setError('');
          void onResend(sendingPayload)
            .then(delivery => { if (openMapId.current === sendingPayload.mapId) { setResult({ ...sendingPayload, delivery }); setChecked(false); } })
            .catch(e => { if (openMapId.current === sendingPayload.mapId) setError(submitErrorText((e as Error).message)); })
            .finally(() => { if (openMapId.current === sendingPayload.mapId) setSending(false); });
        }}>{sending ? '正在发送…' : '再发送一次'}</button>}
        <button type="button" className="button primary" onClick={() => copy(result.text, result.mapId, result.version, resultField.current)}>{copied ? '已复制' : '复制消息'}</button>
      </div>
    </>}
  </section>;
}
