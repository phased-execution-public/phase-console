import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';

/**
 * A dialog — a question or a short form in the middle of the screen. Radix
 * owns focus trapping, `aria-modal`, Escape and outside-click; this owns the
 * paint and the phone rules: centred in and bounded by `--app-height` (the
 * visible viewport the shell lays out against — never `dvh`, which on iOS
 * ignores the software keyboard), never sized by the full viewport width (the unit that
 * ignores the scrollbar), scrolling inside itself with overscroll contained.
 *
 * Centred with no physical side: `inset-x-0` and `margin: auto` centre a box
 * of definite width; `top-0`, a bottom at the keyboard's share of the layout
 * viewport and `height: fit-content` centre it in what is visible. The one
 * shadow the kit casts is this one — a dialog floats over the page.
 *
 * Two shapes. The plain dialog scrolls as one box. `frame` fixes the header,
 * an optional `subheader` and an optional `footer` and scrolls ONLY the body,
 * so a form taller than the screen never scrolls its primary action away.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const scrim = 'fixed inset-0 z-(--z-scrim) bg-ground-deep/60 data-[state=open]:animate-fade';

/** The centred box — the dialog's, and the confirm's (`ui/confirm.tsx`), which is one. */
export const dialogBox = [
  'fixed inset-x-0 top-0 bottom-[calc(100%-var(--app-height,100%))] z-(--z-scrim) m-auto h-fit',
  'w-[min(34rem,calc(100%-2rem))] rounded-lg border border-rule bg-surface shadow-overlay',
  'data-[state=open]:animate-fade',
].join(' ');
const box = dialogBox;

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
  /** Fixed header and footer, scrolling body. */
  frame?: boolean;
  /** The scrolling body's own classes (`frame` only). */
  bodyClassName?: string;
  /** Between the header and the body, fixed (`frame` only). */
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
      <DialogPrimitive.Title className="text-section font-semibold text-ink">{title}</DialogPrimitive.Title>
      {description != null && (
        <DialogPrimitive.Description className="mt-1 text-body text-ink-muted">
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
            box,
            'flex max-h-[min(48rem,calc(var(--app-height,100%)-2rem))] flex-col overflow-hidden',
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
          {/* `min-h-0` is what makes `flex-1` able to scroll: without it a flex
              item's minimum size is its content and the body grows the dialog
              instead of overflowing inside it. */}
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
          box,
          'max-h-[min(42rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto overscroll-contain p-4',
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

/** The buttons of a plain dialog, at its end edge. */
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex flex-wrap justify-end gap-2', className)} {...props} />;
}
