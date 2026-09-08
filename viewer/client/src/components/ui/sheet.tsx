import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';

/**
 * A sheet — the Dialog primitive entering from an edge: the BOTTOM on a
 * phone (the tab-bar "More", a session picker, a filter tray), the RIGHT
 * on a desktop (the bell drawer, the run settings), and — since Phase 8 —
 * FULL, the whole phone screen, for a flow with stages of its own (the
 * launch dialog). Same Radix root as `Dialog`, so focus, dismissal and
 * `aria-modal` are identical.
 *
 * Sized by `--app-height` — the visible viewport the shell lays out against —
 * never `dvh`, which on iOS ignores the software keyboard and left a sheet's
 * buttons under it. A bottom sheet rides up with the keyboard (`100% −
 * --app-height` is the keyboard's share of the layout viewport a fixed
 * element is positioned in) and clears the home indicator (`pb-safe`). A full
 * sheet is exactly `--app-height` tall from the top, so its footer sits on the
 * keyboard's upper edge while the keyboard is up and on the home indicator
 * when it is not.
 *
 * ## Exactly one scroller, and it is the body
 *
 * The content is a flex column: a header that does not shrink, an optional
 * `subheader` (a stage bar) and `footer` (the buttons) that do not either,
 * and a body that takes the remainder and scrolls. The sheet itself scrolls
 * nothing.
 *
 * It was the other way round — the sheet scrolled and the children sat in a
 * plain `<div>` of auto height — and that is a drawer that cannot be scrolled.
 * A panel inside asking for `h-full` resolved against a parent with no definite
 * height, got `auto`, grew past the viewport, and its own `overflow-y-auto`
 * then had nothing to scroll; the outer scroller meanwhile saw content it had
 * already been told fitted. Two scrollers, neither of them working.
 *
 * `className` still lands on the sheet (position, width, the animation);
 * `bodyClassName` is how the padding is changed, because a `p-0` aimed at the
 * padding and landing on the sheet is a no-op — which is exactly what the bell
 * drawer and the help sheet have been passing.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const scrim =
  'fixed inset-0 z-(--z-scrim) bg-ground-deep/70 backdrop-blur-[2px] data-[state=open]:animate-fade';

export type SheetSide = 'bottom' | 'right' | 'full';

export function SheetContent({
  className,
  bodyClassName,
  children,
  title,
  description,
  side = 'bottom',
  showTitle = false,
  subheader,
  footer,
  bodyRef,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** Required for assistive tech; visually hidden unless `showTitle` (always shown on `full`). */
  title: string;
  description?: ReactNode;
  side?: SheetSide;
  showTitle?: boolean;
  /** The scrolling body's own classes — this is where a `p-0` belongs. */
  bodyClassName?: string;
  /** Between the header and the body, never scrolled away: a stage bar, a filter row. */
  subheader?: ReactNode;
  /** Under the body, never scrolled away: the buttons. Clears the home indicator by itself. */
  footer?: ReactNode;
  /** The scrolling body, for a caller that resets its scroll. */
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const titled = showTitle || side === 'full';
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-(--z-scrim) flex flex-col bg-surface shadow-card outline-none',
          side === 'bottom' && [
            // Rides up with the keyboard, never taller than 85 % of what is visible.
            'inset-x-0 bottom-[calc(100%-var(--app-height,100%))] max-h-[calc(var(--app-height,100%)*0.85)]',
            'rounded-t-lg border-t border-rule data-[state=open]:animate-rise',
            footer == null && 'pb-safe',
          ],
          side === 'right' && [
            'right-0 top-0 h-(--app-height) w-[min(28rem,calc(100%-2rem))]',
            'border-l border-rule data-[state=open]:animate-fade',
          ],
          side === 'full' && [
            'inset-x-0 top-0 h-(--app-height) w-full',
            'pt-safe data-[state=open]:animate-fade',
          ],
          className,
        )}
        {...props}
      >
        {side === 'bottom' ? (
          // The grab handle is a header row, not a sticky thing inside the
          // scroller: a flex header cannot be scrolled away, so it needs no
          // layer of its own and cannot be caught mid-slide.
          <div className="shrink-0 bg-surface pt-2">
            <div className="mx-auto h-1 w-9 rounded-full bg-rule-strong" aria-hidden />
            <DialogPrimitive.Title className={titled ? 'px-3 pt-2 font-display text-lg' : 'sr-only'}>
              {title}
            </DialogPrimitive.Title>
            {description != null && (
              <DialogPrimitive.Description className={titled ? 'px-3 text-sm text-ink-muted' : 'sr-only'}>
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'flex shrink-0 items-start justify-between gap-3 px-4 py-3',
              subheader == null && 'border-b border-rule',
            )}
          >
            <div className="min-w-0">
              <DialogPrimitive.Title className={titled ? 'font-display text-lg' : 'sr-only'}>
                {title}
              </DialogPrimitive.Title>
              {description != null && (
                <DialogPrimitive.Description className={titled ? 'mt-0.5 text-sm text-ink-muted' : 'sr-only'}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-m-1 inline-grid size-9 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
            >
              <X size={16} aria-hidden />
            </DialogPrimitive.Close>
          </div>
        )}
        {subheader != null && (
          <div className={cn('shrink-0 border-b border-rule', side === 'bottom' ? 'px-3' : 'px-4')}>
            {subheader}
          </div>
        )}
        {/* `min-h-0` is what makes `flex-1` able to scroll: without it a flex
            item's minimum size is its content, so the body would grow the sheet
            instead of overflowing inside it. */}
        <div
          ref={bodyRef}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain',
            side === 'bottom' ? 'p-3' : 'p-4',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <div
            className={cn(
              'shrink-0 border-t border-rule pb-safe',
              side === 'bottom' ? 'px-3 py-2' : 'px-4 py-3',
            )}
          >
            {footer}
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
