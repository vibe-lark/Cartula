import { useEffect, useRef, useState, type FocusEvent } from 'react';

/**
 * Panels that float over the map fold themselves away when they are not being
 * read.
 *
 * The map is the page. Every panel Cartula opens over it — the plan switcher,
 * a plan's stop list, the card for one stop or one leg — is furniture, and
 * furniture that stays where you put it means the user pays clicks to see the
 * thing they came for. So a panel shrinks to its own heading when the pointer is
 * elsewhere, opens again when the pointer comes back, and stays open for as long
 * as it is pinned.
 *
 * Three rules make that liveable rather than twitchy:
 *
 *  1. **A panel that just opened does not vanish.** It was opened on purpose,
 *     usually by a click on the map, and the pointer is still sitting where that
 *     click landed. Folding on a timer would snatch it away mid-read. Instead it
 *     stays open until the pointer *travels* — `ARM_DISTANCE` away from where it
 *     was, or onto the panel itself. Leave the mouse alone and the card stays.
 *  2. **Touch never folds anything.** There is no hover to bring it back, so on
 *     a touch screen these panels behave exactly as they did before: open until
 *     closed. The pin button is the touch affordance.
 *  3. **Keyboard focus and explicit holds win.** A panel never folds while it
 *     contains the focus (Tab must not walk into a disappearing list) or while
 *     its owner says it is busy — a drag in progress, an editor open.
 *
 * Hover is decided by measuring the pointer against the panel's own rectangle
 * on every move, **not** by `pointerenter` / `pointerleave`. Those are boundary
 * events computed from the element under the cursor, and these panels rewrite
 * that element while the cursor sits on it — pressing the pin swaps the icon,
 * which removes the node the browser was tracking. The boundary pair then
 * desynchronises and the panel is left believing it is still hovered, seconds
 * after the pointer has gone (measured: a card that would not fold again until
 * it was hovered a second time). A rectangle cannot get out of step with itself.
 */

/** How long the pointer rests on a panel before it opens. Keeps a pointer that
 *  is merely crossing the panel from flinging it open. Exported because the
 *  plan rail opens a panel it does not own and has to keep the same timing. */
export const OPEN_MS = 120;
/** And how long it may be away before it folds. Longer, because panels are made
 *  of separate boxes with gaps between them, and a fold across a gap the pointer
 *  is travelling through would make the panel unreachable. */
export const CLOSE_MS = 320;
/** How far the pointer has to travel before a freshly opened panel may fold. */
const ARM_DISTANCE = 24;

export interface PeekOptions {
  /** Kept open on purpose; the pointer stops mattering. */
  pinned: boolean;
  /**
   * Never fold while this is true — a drag in flight, an open editor, anything
   * whose disappearance would cancel work in progress.
   */
  hold?: boolean;
  /**
   * What the panel is currently about (a layer id, a point id). Changing it
   * restarts the grace period, because a card for a different subject is a new
   * thing to read, not the same one still on screen.
   */
  subject?: string;
  /**
   * Whether rule 1 applies — the grace period a panel gets for having just been
   * opened. True for anything that appears because the user asked for it: the
   * card they clicked open must not evaporate under their eyes.
   *
   * False for the furniture that is simply always there. The plan switcher is
   * on screen from the moment the map is, and nobody asked for it, so opening
   * a page with its cards spread over the map would be exactly the occlusion
   * this whole mechanism exists to remove.
   */
  grace?: boolean;
  /**
   * A stricter grace: the panel stays until the pointer has actually been on
   * it, however far it travels meanwhile. For panels that appear far from the
   * pointer because of something done elsewhere — a plan created in a dialog,
   * 查看详情 pressed on a leg card — where the 24px rule would take the panel
   * away on the very move made to reach it. Only meaningful with `grace`.
   */
  sticky?: boolean;
  /**
   * Open the moment the pointer arrives, with no rest. The rest exists so a
   * pointer crossing a *folded* panel does not fling it open; a panel that is
   * never on screen folded — the stop list, which is taken away instead — has
   * nothing to be crossed, and the rest would only lose the race against its
   * own removal when the pointer comes back in the last moment.
   */
  eager?: boolean;
}

export interface Peek<T extends HTMLElement> {
  /** Attach to the panel's root: it is the rectangle the pointer is measured against. */
  ref: (element: T | null) => void;
  open: boolean;
  /** Spread on the panel's root element. */
  handlers: {
    onFocus: (event: FocusEvent<T>) => void;
    onBlur: (event: FocusEvent<T>) => void;
  };
}

export function usePeek<T extends HTMLElement>({ pinned, hold, subject, grace = true, sticky = false, eager = false }: PeekOptions): Peek<T> {
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  /** False while the panel is still in its grace period — see rule 1. */
  const [armed, setArmed] = useState(!grace);
  const element = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** What is on screen right now, for the listener below. */
  const shown = useRef(true);

  useEffect(() => {
    setArmed(!grace);
    setHovering(false);
    let settled = !grace;
    let inside = false;
    let origin: { x: number; y: number } | undefined;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const rect = element.current?.getBoundingClientRect();
      const over = Boolean(rect && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom);
      if (!settled) {
        // Onto the panel, or away from where the opening click left the pointer:
        // either way the hand has moved and the ordinary hover rule takes over.
        origin ??= { x: event.clientX, y: event.clientY };
        if (over || (!sticky && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= ARM_DISTANCE)) {
          settled = true;
          setArmed(true);
        }
      }
      if (over === inside) return;
      // A button held down is the map being dragged, not the panel being
      // reached for — crossing it mid-drag must not open it.
      if (over && event.buttons) return;
      inside = over;
      clearTimeout(timer.current);
      // Arriving on a panel that is *already* open holds it open at once. The
      // open delay is there to stop a pointer crossing a folded panel from
      // flinging it open; applying it to a panel the pointer has just reached
      // would fold it for those milliseconds and then open it again — a blink
      // under the cursor, and a control that moves out from under a click.
      if (over && (shown.current || eager)) { setHovering(true); return; }
      timer.current = setTimeout(() => setHovering(over), over ? OPEN_MS : CLOSE_MS);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { window.removeEventListener('pointermove', onMove); clearTimeout(timer.current); };
  }, [subject, grace, sticky, eager]);

  const open = pinned || Boolean(hold) || hovering || focused || !armed;
  shown.current = open;
  return {
    ref: (node: T | null) => { element.current = node; },
    open,
    handlers: {
      // Keyboard focus only: a click focuses the panel too, and a panel that
      // reopened on the very click that unpinned it could never be put away.
      onFocus: event => { if ((event.target as HTMLElement).matches?.(':focus-visible')) setFocused(true); },
      onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); },
    },
  };
}
