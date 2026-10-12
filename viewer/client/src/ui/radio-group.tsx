import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { mirrorUnless, useDocumentDir } from './direction';

/**
 * One choice of several, each a card a thumb can hit: its label, and what
 * choosing it means beneath. Radix owns the roving focus and the arrow keys;
 * this owns the shape — the whole card is the target, never the dot. The
 * chosen card is marked in INK (the rule and the dot), never amber: a choice
 * is not a summons. Imported by path.
 */
export function RadioGroup({ className, dir, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  // The document's direction, so the arrow keys follow a mirrored page (`./direction`).
  const page = useDocumentDir();
  return (
    <RadioGroupPrimitive.Root
      className={cn('grid gap-2', className)}
      dir={dir ?? page}
      {...mirrorUnless(dir)}
      {...props}
    />
  );
}

export function RadioItem({
  id,
  value,
  label,
  description,
  disabled,
  className,
}: {
  id: string;
  value: string;
  label: ReactNode;
  /** What choosing it means — a line under the label. */
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-rule bg-surface px-3 py-2.5',
        'transition-colors duration-fast ease-transit hover:border-ink-faint',
        'has-[[data-state=checked]]:border-ink',
        '[@media(hover:none)]:min-h-(--tap-min)',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <RadioGroupPrimitive.Item
        id={id}
        value={value}
        disabled={disabled}
        className={cn(
          'mt-0.5 inline-grid size-4 shrink-0 place-items-center rounded-full border border-rule-strong bg-ground',
          'transition-colors duration-fast ease-transit data-[state=checked]:border-ink',
        )}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-ink" />
      </RadioGroupPrimitive.Item>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body text-ink">{label}</span>
        {description != null && <span className="text-meta text-ink-muted">{description}</span>}
      </span>
    </label>
  );
}
