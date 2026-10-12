import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { DIR_MIRROR, useDocumentDir } from './direction';
import { field } from './field';

/**
 * A select — one of a short, known list (model, effort, account, policy).
 * Radix owns typeahead, the keyboard and the popper; this owns the paint: the
 * trigger is the `field` control (the one definition), the list never exceeds
 * the visible viewport, and each option is thumb-high on touch.
 *
 * For a list you search through, use `Combobox`; for a two-item choice a
 * switch reads better than a select.
 */
export function Select({ dir, ...props }: ComponentProps<typeof SelectPrimitive.Root>) {
  // The document's direction, so the list and its typeahead read as the page does (`./direction`).
  const page = useDocumentDir();
  return <SelectPrimitive.Root dir={dir ?? page} {...props} />;
}
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      {...DIR_MIRROR}
      className={cn(
        field,
        'inline-flex w-full items-center justify-between gap-2 text-start',
        'hover:border-ink-faint data-[placeholder]:text-ink-faint',
        'aria-[invalid=true]:border-failed/70',
        '[&>span]:min-w-0 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        {...DIR_MIRROR}
        position={position}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          'z-(--z-scrim) min-w-(--radix-select-trigger-width) max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-rule bg-surface text-body text-ink shadow-overlay',
          'max-h-[min(20rem,var(--radix-select-content-available-height),calc(var(--app-height,100%)-2rem))]',
          'data-[state=open]:animate-fade',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-ink-faint">
          <ChevronUp size={14} aria-hidden />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-ink-faint">
          <ChevronDown size={14} aria-hidden />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label className={cn('px-2 py-1.5 text-meta text-ink-muted', className)} {...props} />
  );
}

export function SelectItem({
  className,
  children,
  hint,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & { hint?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex w-full cursor-default select-none items-center gap-2 rounded py-1.5 pe-2 ps-8 text-body text-ink',
        'data-[highlighted]:bg-surface-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
      {...props}
    >
      <span className="absolute start-2 inline-flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check size={14} aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {hint != null && <span className="ms-auto ps-3 text-meta text-ink-faint">{hint}</span>}
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-rule', className)} {...props} />;
}
