import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Words over more than one line. The field's rule, ground, radius and invalid
 * mark, never its fixed height (`field`'s `h-9`): a textarea 36 px tall is a
 * defect. On a phone it grows with what is typed rather than scrolling inside
 * three rows under the keyboard. 16 px on touch, like every input (the
 * coarse-pointer floor in `theme.css`). Imported by path.
 */
export interface TextareaProps extends ComponentProps<'textarea'> {
  /** Take the whole width of the row. */
  block?: boolean;
}

export function Textarea({ className, block = false, rows = 3, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(
        'min-w-0 rounded border border-rule-strong bg-ground px-2.5 py-1.5 text-body text-ink',
        'placeholder:text-ink-faint hover:border-ink-faint disabled:opacity-50',
        'aria-[invalid=true]:border-failed/70 aria-[invalid=true]:focus-visible:outline-failed',
        'field-sizing-content max-h-[min(20rem,calc(var(--app-height,100%)*0.5))]',
        block && 'w-full',
        className,
      )}
      {...props}
    />
  );
}
