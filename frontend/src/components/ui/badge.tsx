import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
const badge = cva('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: { variant: {
    default: 'bg-primary text-primary-foreground', success: 'bg-success text-success-foreground',
    warning: 'bg-warning text-warning-foreground', destructive: 'bg-destructive text-destructive-foreground',
    outline: 'border border-border text-foreground',
  } },
  defaultVariants: { variant: 'default' },
});
export const Badge = ({ className, variant, ...p }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) =>
  <span className={cn(badge({ variant }), className)} {...p} />;
