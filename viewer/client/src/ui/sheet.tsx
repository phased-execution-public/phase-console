import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import { cn } from '@/lib/cn';
import { scrim } from './dialog';

/**
 * A sheet — the Dialog primitive entering from an edge: the BOTTOM on a phone
 * (More, a picker, a View sheet), the END edge on a desk (the inspector
 * between 900 and 1200, a drawer), and FULL, the whole phone screen, for a flow
 * of its own. Same Radix root as `Dialog`, so focus, dismissal and
 * `aria-modal` are identical. Every side is LOGICAL: the end sheet mirrors
 * under `dir="rtl"` with no second spelling.
 *
 * Sized by `--app-height` — the visible viewport — never `dvh`. A bottom sheet
 * rides up with the keyboard (`100% − --app-height` is the keyboard's share of
 * the layout viewport a fixed element is positioned in) and clears the home
 * indicator (`pb-safe`). A full sheet is exactly `--app-height` tall.
 *
 * Exactly one scroller, and it is the body: a header that does not shrink, an
 * optional `subheader` and `footer` that do not either, and a body that takes
 * the remainder and scrolls. `className` lands on the sheet; `bodyClassName`
 * is how the body's padding is changed.
 *
 * Opening moves focus inside, as a modal must — to the first control, or with
 * `focusTitle` to the title instead: a sheet that is mostly reading (Help)
 * would otherwise open with a ring on whatever control happens to come first,
 * and a screen reader would start mid-way down it (quiet-console phase 27).
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetSide = 'bottom' | 'end' | 'full';

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
  focusTitle = false,
  onOpenAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** Required for assistive tech; visually hidden unless `showTitle` (always shown on `full`). */
  title: string;
  description?: ReactNode;
  side?: SheetSide;
  showTitle?: boolean;
  /** The scrolling body's own classes — this is where a `p-0` belongs. */
  bodyClassName?: string;
  /** Between the header and the body, never scrolled away: a tab strip, a filter row. */
  subheader?: ReactNode;
  /** Under the body, never scrolled away: the buttons. Clears the home indicator by itself. */
  footer?: ReactNode;
  /** The scrolling body, for a caller that resets its scroll. */
  bodyRef?: Ref<HTMLDivElement>;
  /** Open with focus on the title rather than the first control — for a sheet that is read before it is used. */
  focusTitle?: boolean;
}) {
  const titled = showTitle || side === 'full';
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The title is a place to start reading, never a control: focusable only
  // from here (`tabIndex` -1), so it is no tab stop of its own. Its ring is the
  // browser's to show or not — none after a tap, the global one when the sheet
  // opened from an address with no press before it — and never suppressed
  // (`styles/touch.test.ts` holds the kit to that).
  const titleFocus = focusTitle ? { ref: titleRef, tabIndex: -1 } : {};
  const opened: ComponentProps<typeof DialogPrimitive.Content>['onOpenAutoFocus'] = (event) => {
    onOpenAutoFocus?.(event);
    if (!focusTitle || event.defaultPrevented) return;
    event.preventDefault();
    titleRef.current?.focus({ preventScroll: true });
  };
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={scrim} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-(--z-scrim) flex flex-col bg-surface shadow-overlay',
          side === 'bottom' && [
            // Rides up with the keyboard, never taller than 85 % of what is visible.
            'inset-x-0 bottom-[calc(100%-var(--app-height,100%))] max-h-[calc(var(--app-height,100%)*0.85)]',
            'rounded-t-lg border-t border-rule data-[state=open]:animate-rise',
            footer == null && 'pb-safe',
          ],
          side === 'end' && [
            'end-0 top-0 h-(--app-height) w-[min(28rem,calc(100%-2rem))]',
            'border-s border-rule data-[state=open]:animate-fade',
          ],
          side === 'full' && [
            'inset-x-0 top-0 h-(--app-height) w-full',
            'pt-safe data-[state=open]:animate-fade',
          ],
          className,
        )}
        {...props}
        onOpenAutoFocus={opened}
      >
        {side === 'bottom' ? (
          // The grab handle is a header row, not a sticky thing inside the
          // scroller: a flex header cannot be scrolled away.
          <div className="shrink-0 bg-surface pt-2">
            <div className="mx-auto h-1 w-9 rounded-full bg-rule-strong" aria-hidden />
            <DialogPrimitive.Title
              {...titleFocus}
              className={titled ? 'px-3 pt-2 text-section font-semibold text-ink' : 'sr-only'}
            >
              {title}
            </DialogPrimitive.Title>
            {description != null && (
              <DialogPrimitive.Description className={titled ? 'px-3 text-body text-ink-muted' : 'sr-only'}>
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
              <DialogPrimitive.Title
                {...titleFocus}
                className={titled ? 'text-section font-semibold text-ink' : 'sr-only'}
              >
                {title}
              </DialogPrimitive.Title>
              {description != null && (
                <DialogPrimitive.Description
                  className={titled ? 'mt-0.5 text-body text-ink-muted' : 'sr-only'}
                >
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
        {/* `min-h-0` is what makes `flex-1` able to scroll. */}
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
