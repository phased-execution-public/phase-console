import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { DIR_MIRROR, useDocumentDir } from './direction';

/**
 * A menu — a row's overflow verbs (the `⋯` of the toolbar grammar), a
 * switcher. Radix owns typeahead, the keyboard and dismissal; this owns the
 * paint and the phone rule: every item is thumb-high on touch, and the menu
 * never exceeds the visible viewport (`--app-height`, never `dvh`).
 *
 * A destructive item says so (`destructive`) and paints in the failed hue; it
 * still confirms elsewhere — a menu item is never the last click. A group's
 * label is a sentence-case word in muted ink, never a tracked-out caption.
 */
export function DropdownMenu({ dir, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  // The document's direction, so a submenu opens to the page's end (`./direction`).
  const page = useDocumentDir();
  return <DropdownMenuPrimitive.Root dir={dir ?? page} {...props} />;
}
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const panel =
  'z-(--z-scrim) max-w-[calc(100%-1rem)] rounded-lg border border-rule bg-surface p-1 text-body text-ink shadow-overlay ' +
  'max-h-[min(24rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto overscroll-contain';

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        {...DIR_MIRROR}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(panel, 'min-w-44 data-[state=open]:animate-fade', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const itemClass =
  'relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-body text-ink ' +
  'data-[highlighted]:bg-surface-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ' +
  '[@media(hover:none)]:min-h-(--tap-min)';

export function DropdownMenuItem({
  className,
  inset,
  destructive,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean; destructive?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        itemClass,
        inset && 'ps-8',
        destructive && 'text-failed data-[highlighted]:bg-failed/10',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(itemClass, 'ps-8', className)} {...props}>
      <span className="absolute start-2 inline-flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check size={14} aria-hidden />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(itemClass, 'ps-8', className)} {...props}>
      <span className="absolute start-2 inline-flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          {/* Ink, not amber: a chosen option is not a summons. */}
          <span className="block size-2 rounded-full bg-ink" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 py-1.5 text-meta text-ink-muted', inset && 'ps-8', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-rule', className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ms-auto ps-4 text-meta text-ink-faint', className)} {...props} />;
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(itemClass, inset && 'ps-8', 'data-[state=open]:bg-surface-raised', className)}
      {...props}
    >
      {children}
      <ChevronRight size={14} aria-hidden className="ms-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        {...DIR_MIRROR}
        className={cn(panel, 'min-w-40', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}
