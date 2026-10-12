import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A control's name. The hint — where a value came from, what it does — goes
 * UNDER the label in the meta size, never into it: a label is the accessible
 * NAME, and a name that is a sentence is a name nobody can say.
 */
export function Label({
  className,
  hint,
  children,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root> & { hint?: string }) {
  return (
    <LabelPrimitive.Root className={cn('block text-body font-medium text-ink', className)} {...props}>
      {children}
      {hint && <span className="mt-0.5 block text-meta font-normal text-ink-muted">{hint}</span>}
    </LabelPrimitive.Root>
  );
}
