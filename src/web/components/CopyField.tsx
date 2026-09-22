import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { MANUAL_COPY_HINT, copyText, selectAll } from './clipboard.js';

/**
 * A value to hand to someone else: the text itself, and one icon that copies it.
 *
 * The text is on screen, always. Inside a host webview the clipboard is often
 * refused outright (see `clipboard.ts`), and a button that can only fail is not
 * a way to get a link out of a card — the field is. Copying is the shortcut, not
 * the mechanism, which is also why the field is a real focusable input: select,
 * Ctrl/⌘+C works everywhere, including where nothing else does.
 *
 * When both copy routes fail the value is selected for the reader and the hint
 * says which keys to press, rather than reporting an error they cannot act on.
 */
export function CopyField({ label, value, rows }: { label: string; value: string; rows?: number }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A new value has not been copied, whatever the last one's outcome was.
  useEffect(() => { setState('idle'); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    clearTimeout(timer.current);
    void copyText(value).then(result => {
      if (result === 'unavailable') { selectAll(field.current); setState('manual'); return; }
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 2500);
    });
  };
  const common = {
    readOnly: true, value, 'aria-label': label,
    onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => selectAll(event.currentTarget),
  };
  return <div className="copy-field">
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      {rows
        ? <textarea {...common} rows={rows} ref={element => { field.current = element; }}/>
        : <input {...common} ref={element => { field.current = element; }}/>}
      <button type="button" className="icon-button" aria-label={`复制${label}`} title={state === 'copied' ? '已复制' : '复制'} onClick={copy}>
        {state === 'copied' ? <Check size={15}/> : <Copy size={15}/>}
      </button>
    </div>
    {state === 'manual' && <p role="status" className="copy-hint">{MANUAL_COPY_HINT}</p>}
  </div>;
}
