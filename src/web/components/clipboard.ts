/**
 * Copying text out of Cartula, including from inside a host that will not allow
 * it.
 *
 * `navigator.clipboard.writeText` is gated by the `clipboard-write` permission
 * policy, whose default allowlist is `self`. An MCP card runs in a cross-origin
 * iframe the host owns, and no host currently sets `allow="clipboard-write"` on
 * it, so the promise rejects with `NotAllowedError` no matter how the user got
 * there. It is not a permission Cartula can ask for either: the prompt belongs
 * to the top-level page, and MCP Apps has no message for requesting one.
 *
 * So there are three steps, tried in order, and the caller is told which one
 * answered:
 *
 *  1. The async clipboard API — what works on the standalone page.
 *  2. `document.execCommand('copy')` over a selection. Deprecated, and not
 *     gated by the permission policy: it needs a user gesture, which every
 *     caller here has, and it is what still works in some embedded frames.
 *  3. Nothing. The surface then has to *show* the text and let the reader take
 *     it themselves, which is why this returns an outcome instead of throwing:
 *     "copy failed" is an error, "this host cannot copy, here is the text" is
 *     the working path.
 */
export type CopyResult = 'clipboard' | 'selection' | 'unavailable';

/**
 * Put `text` on the clipboard, by whichever route this host allows.
 *
 * Never rejects: every failure is an outcome the caller is meant to render.
 */
export async function copyText(text: string): Promise<CopyResult> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    }
  } catch {
    // A refusal, not an absence — fall through to the older route, which is
    // governed by different rules and sometimes succeeds where this one did not.
  }
  return execCommandCopy(text) ? 'selection' : 'unavailable';
}

/**
 * The pre-permissions copy path: select text in a throwaway field and ask the
 * document to copy the selection.
 *
 * The field is positioned rather than hidden — `display:none` and
 * `visibility:hidden` elements cannot be selected, so the copy silently does
 * nothing — and the reader's own selection is restored afterwards, because
 * copying a link should not clear the sentence they had highlighted.
 */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  const selection = document.getSelection();
  const held = selection && selection.rangeCount ? selection.getRangeAt(0) : undefined;
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.setSelectionRange(0, field.value.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  if (held && selection) { selection.removeAllRanges(); selection.addRange(held); }
  return copied;
}

/**
 * Select the whole value of a field, so a reader whose host refuses both copy
 * routes only has to press the shortcut.
 */
export function selectAll(field: HTMLInputElement | HTMLTextAreaElement | null | undefined) {
  if (!field) return;
  field.focus({ preventScroll: true });
  field.setSelectionRange(0, field.value.length);
}

/** What to say when neither route worked. Short, and names the way out. */
export const MANUAL_COPY_HINT = '这个环境不允许自动复制，已选中，请按 Ctrl/⌘+C。';
