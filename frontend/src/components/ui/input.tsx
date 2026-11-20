import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn('flex min-h-tap w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...p} />
));
Input.displayName = 'Input';
