import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { field } from './field';

export interface InputProps extends ComponentProps<'input'> {
  /** Take the whole width of the row. */
  block?: boolean;
}

/**
 * A text input wearing the one control class: 36 px on a desk, thumb-high on
 * touch, 16 px so iOS never zooms into it. An invalid value says so on the
 * rule (`aria-invalid`), never in a colour alone — the message beside it is the
 * caller's.
 */
export function Input({ className, block = false, type = 'text', ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        field,
        'placeholder:text-ink-faint hover:border-ink-faint',
        'aria-[invalid=true]:border-failed/70 aria-[invalid=true]:focus-visible:outline-failed',
        block && 'w-full',
        className,
      )}
      {...props}
    />
  );
}
