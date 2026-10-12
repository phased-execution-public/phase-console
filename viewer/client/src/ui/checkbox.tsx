import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * A checkbox — a pick in a list, including the three-state kind
 * (`checked="indeterminate"` for "some of these"). Imported by path.
 *
 * Ticked is INK, never amber: picking a row has not made it urgent, and amber
 * is the one summons (design.md §3). The drawn box is 16 px; on touch its hit
 * area is the thumb floor (`tap-area`), so the box stays small and the target
 * does not. The check is an icon, so it draws the same in every face.
 */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'relative inline-grid size-4 shrink-0 place-items-center rounded-sm border border-rule-strong bg-ground',
        'transition-colors duration-fast ease-transit hover:border-ink-faint',
        'data-[state=checked]:border-action data-[state=checked]:bg-action data-[state=checked]:text-ground',
        'data-[state=indeterminate]:border-action data-[state=indeterminate]:text-action',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'tap-area',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === 'indeterminate' ? (
          <Minus size={12} strokeWidth={3} aria-hidden />
        ) : (
          <Check size={12} strokeWidth={3} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
