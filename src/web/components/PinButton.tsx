import { Pin, PinOff } from 'lucide-react';

/**
 * The one control a folding panel needs: keep it open, or let it fold again.
 *
 * Every panel over the map has the same two states and the same two sentences
 * about them, so they say it the same way — a pin in the heading, pressed or
 * not. On a touch screen it is also the only way to fold a panel by hand, since
 * there is no pointer to move away.
 */
export default function PinButton({ pinned, label, onPin }: { pinned: boolean; label: string; onPin: (pinned: boolean) => void }) {
  return <button type="button" className={`icon-button pin-button ${pinned ? 'pinned' : ''}`}
    aria-pressed={pinned} aria-label={`${pinned ? '取消固定' : '固定展开'}${label}`}
    title={pinned ? '取消固定：移开鼠标后自动收起' : '固定展开：不随鼠标收起'}
    onClick={() => onPin(!pinned)}>{pinned ? <Pin size={14}/> : <PinOff size={14}/>}</button>;
}
