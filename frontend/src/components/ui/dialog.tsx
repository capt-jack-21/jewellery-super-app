import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Centred modal dialog, portalled to <body> (no extra dependency; same behaviour as the shadcn / Radix Dialog). On screen it is a
 * fixed, scrollable overlay over the page, so it always opens in view. Focus moves into the panel on open and Tab stays inside it;
 * Esc, a click on the backdrop and the close button all call onClose; focus goes back to `returnFocus` (the trigger) when it closes.
 * `overlayTestId` names the <body> child itself: print CSS (print095.css) hooks on it, and resets the overlay chrome for print.
 */
export function Dialog({ open, title, closeLabel, onClose, returnFocus, overlayTestId, panelTestId, className, children }: {
  open: boolean; title: ReactNode; closeLabel: string; onClose: () => void; returnFocus?: RefObject<HTMLElement | null>;
  overlayTestId?: string; panelTestId?: string; className?: string; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const back = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return; }
      const box = panel.current;
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items.at(0); const last = items.at(-1);
      if (!first || !last) { e.preventDefault(); box.focus(); return; }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !box.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); back?.focus(); };
  }, [open, returnFocus]);
  if (!open) return null;
  return createPortal(
    <section data-testid={overlayTestId} data-dialog-overlay="" className="fixed inset-0 z-50 overflow-y-auto bg-foreground/30 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={panelTestId} data-dialog-panel=""
        className={cn('relative mx-auto my-8 w-full max-w-3xl rounded-lg border border-border bg-background p-4 text-foreground shadow-lg outline-none', className)}>
        <div className="mb-3 flex items-center justify-between gap-2 print:hidden">
          <h2 id={titleId} className="font-heading text-lg font-semibold">{title}</h2>
          <Button type="button" size="icon" variant="ghost" aria-label={closeLabel} data-testid="dialog-close" onClick={() => close.current()}><X className="h-4 w-4" aria-hidden /></Button>
        </div>
        {children}
      </div>
    </section>,
    document.body,
  );
}
