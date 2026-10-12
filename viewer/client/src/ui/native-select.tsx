import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { field } from './field';

/**
 * A select the platform draws — a phone opens its own picker, a desk its own
 * list — for a SHORT list of plain words (a model, an effort), where the
 * kit's `select.tsx` popover would be more machinery than choice. It wears
 * the one control class (`field`: the 36 px desk height, the thumb floor on
 * touch, `min-w-0` so it never sizes to its widest option) and a maximum width
 * of its own, because its options are data. Imported by path.
 */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(field, 'max-w-60', className)} {...props} />;
}
