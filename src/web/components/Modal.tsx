import { X } from 'lucide-react';

/** The one dialog chrome in the app: a backdrop that closes it, a heading, a close button. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={title} className="modal" onClick={e => e.stopPropagation()}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={19}/></button></div>{children}</section></div>;
}
