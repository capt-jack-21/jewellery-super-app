import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Label + control + hint/error, wired with ids for a11y. The child receives id via render prop. */
export function Field({ label, hint, error, children, className }: {
  label: string; hint?: string; error?: string | null; className?: string; children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children(id, desc)}
      {error ? <p id={`${id}-err`} className="text-xs text-destructive">{error}</p>
        : hint ? <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} className={cn('flex min-h-tap w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...p} />
));
Select.displayName = 'Select';

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-tap items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
