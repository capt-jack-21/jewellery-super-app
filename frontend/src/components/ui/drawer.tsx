import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';

/** Right-side panel for add/edit forms (no extra dependency). Esc / backdrop / close button all call onClose. */
export function Drawer({ open, title, closeLabel, onClose, children, footer }: {
  open: boolean; title: string; closeLabel: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-foreground/30" aria-hidden onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-lg outline-none">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-heading text-lg font-semibold">{title}</h2>
          <Button size="icon" variant="ghost" aria-label={closeLabel} onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
