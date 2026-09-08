import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';

/**
 * A dialog — a question or a form in the middle of the screen. Radix owns
 * focus trapping, `aria-modal`, Escape and outside-click; this owns the paint
 * and the phone rules: centred in and bounded by `--app-height` (the visible
 * viewport the shell lays out against — never `dvh`, which on iOS ignores the
 * software keyboard and left the wizard's buttons under it), never sized by
 * the full viewport width (the unit that ignores the scrollbar), scrolling
 * inside itself with overscroll contained.
 *
 * ## Two shapes
 *
 * The plain dialog scrolls as one box: header, body and buttons travel
 * together, which is right for a question and a short form. `frame` is the
 * other shape, for a form taller than the screen: the header, an optional
 * `subheader` (a stage bar) and an optional `footer` (the buttons) are fixed,
 * and ONLY the body scrolls — so the primary action never leaves the screen
 * behind a scroll of the form above it, which is what the launch dialog's
 * Start button did at every viewport (Phase 6 register, row 441). The sheet
 * has had this arrangement since 3.0; this is the same one, centred.
 *
 * The edge-anchored variant lives in `sheet.tsx`; the one that cannot be
 * dismissed by accident in `alert-dialog.tsx`.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

const scrim =
  'fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px] data-[state=open]:animate-fade';

export function DialogContent({
  className,
  bodyClassName,
  children,
  title,
  description,
  hideHeader = false,
  frame = false,
  subheader,
  footer,
  bodyRef,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** Required for assistive tech; rendered as the header unless `hideHeader`. */
  title: string;
  description?: ReactNode;
  /** Keep the title for screen readers only — the palette draws its own chrome. */
  hideHeader?: boolean;
  /** Fixed header and footer, scrolling body. See the file header. */
  frame?: boolean;
  /** The scrolling body's own classes (`frame` only) — where a `p-0` belongs. */
  bodyClassName?: string;
  /** Between the header and the body, fixed (`frame` only): a stage bar, a filter row. */
  subheader?: ReactNode;
  /** Under the body, fixed (`frame` only): the buttons. */
  footer?: ReactNode;
  /** The scrolling body (`frame` only), for a caller that resets its scroll. */
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const close = (
    <DialogPrimitive.Close
      aria-label="Close"
      className="-m-1 inline-grid size-8 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
    >
      <X size={16} aria-hidden />
    </DialogPrimitive.Close>
  );
  const heading = (
    <div className="min-w-0">
      <DialogPrimitive.Title className="font-display text-xl">{title}</DialogPrimitive.Title>
      {description != null && (
        <DialogPrimitive.Description className="mt-1 text-sm text-ink-muted">
          {description}
        </DialogPrimitive.Description>
      )}
    </div>
  );

  if (frame) {
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={scrim} />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[calc(var(--app-height,100%)/2)] z-(--z-scrim) w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[min(48rem,calc(var(--app-height,100%)-2rem))] flex-col overflow-hidden',
            'rounded-lg border border-rule bg-surface shadow-card outline-none',
            'data-[state=open]:animate-fade',
            className,
          )}
          {...props}
        >
          <div
            className={cn(
              'flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-4',
              subheader == null && 'border-b border-rule',
            )}
          >
            {heading}
            {close}
          </div>
          {subheader != null && <div className="shrink-0 border-b border-rule px-4">{subheader}</div>}
          {/* `min-h-0` is what makes `flex-1` able to scroll — without it a
              flex item's minimum size is its content and the body grows the
              dialog instead of overflowing inside it (the sheet learned this
              first). */}
          <div
            ref={bodyRef}
            className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain p-4', bodyClassName)}
          >
            {children}
          </div>
          {footer != null && <div className="shrink-0 border-t border-rule px-4 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-[calc(var(--app-height,100%)/2)] z-(--z-scrim) w-[min(34rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[min(42rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto overscroll-contain',
          'rounded-lg border border-rule bg-surface p-4 shadow-card outline-none',
          'data-[state=open]:animate-fade',
          className,
        )}
        {...props}
      >
        {hideHeader ? (
          <>
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            {description != null && (
              <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
            )}
          </>
        ) : (
          <div className="mb-3 flex items-start justify-between gap-3">
            {heading}
            {close}
          </div>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

/* The sheet used to live here; it is its own file now (bottom on a phone,
   right for a drawer). Re-exported so nothing that imported it from here
   breaks until Phase 11 sweeps those imports. */
export { Sheet, SheetClose, SheetContent, SheetTrigger } from './sheet';
