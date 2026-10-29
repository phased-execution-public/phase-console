import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@/lib/cn';
import { useNarrow } from '@/lib/media';
import { scrim } from './dialog';
import { useSettledWidth } from './sheet-width';

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
 *
 * Every drawer fits its content (2026-10-20). `side="auto"` is a bottom sheet
 * below 640 and an end drawer from 640 — so a tablet held upright gets a side
 * drawer that leaves the page's edge in view. An end drawer is as wide as its
 * content asks (`max-content`) inside the bounds of its `size`, the content's
 * measure: `narrow` 20–28 rem (a picker, a View), `reading` 30–44 rem (Help,
 * the Inbox), `form` 34–52 rem (a Your turn card, an issue to write), `wide`
 * 44–72 rem (a table, a report) — never past the viewport less 2 rem. While it
 * is open it never NARROWS (`useSettledWidth`): data arriving or a section
 * folding does not pull the text from under the reader. Its body is a
 * container (`@container/drawer`), so what sits in it lays itself out by the
 * drawer's width, never the viewport's. A bottom sheet's handle is a control:
 * drag it up for the whole screen, down to let it go, or press it to grow and
 * shrink the sheet; Escape closes every side.
 *
 * Escape closes it whatever else stood up after it (#413). Radix hands Escape
 * to the NEWEST dismissable layer only, and a toast is one: a press inside the
 * sheet that said its words in a toast left the next Escape to the toast, and
 * the sheet stayed. So an Escape that no layer took — not prevented — and that
 * was pressed inside the sheet or on the bare body closes the topmost sheet.
 * And a control that is disabled under the person's focus (a busy Save) puts
 * focus on the sheet itself rather than letting it fall to the body, and back
 * on the control once it is enabled again (`useFocusKept`).
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetSide = 'bottom' | 'end' | 'full' | 'auto';

/** The content's measure, which bounds an end drawer's width (see above). */
export type SheetSize = 'narrow' | 'reading' | 'form' | 'wide';

/** How far a bottom sheet's handle travels before a release lets it go, or grows it. */
const LET_GO_PX = 96;
const GROW_PX = 48;

/** Is this sheet the last modal standing — the one an Escape is meant for? */
function topmost(node: HTMLElement): boolean {
  const open = node.ownerDocument.querySelectorAll(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  return open[open.length - 1] === node;
}

/**
 * The sheet keeps Escape and the person's focus (#413). `close` is a Close
 * control of the sheet's own, so the root's `onOpenChange` hears it as any
 * other way out.
 */
function useFocusKept(node: HTMLDivElement | null, close: { current: HTMLButtonElement | null }): void {
  useEffect(() => {
    if (!node) return undefined;
    const doc = node.ownerDocument;
    // Radix's own handler (capture, on the document) runs first and prevents
    // the Escape it acts on; this one, bubbling, hears only what it left.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && !node.contains(active)) return;
      if (!topmost(node)) return;
      event.preventDefault();
      close.current?.click();
    };
    // The control that was disabled under focus, to be given it back.
    let parked: HTMLElement | null = null;
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (!(target instanceof HTMLElement)) continue;
        const active = doc.activeElement;
        if (target.hasAttribute('disabled')) {
          if (active === target || ((active === null || active === doc.body) && topmost(node))) {
            parked = target;
            node.focus({ preventScroll: true });
          }
        } else if (target === parked) {
          parked = null;
          if (active === node || active === null || active === doc.body)
            target.focus({ preventScroll: true });
        }
      }
    });
    watch.observe(node, { attributes: true, attributeFilter: ['disabled'], subtree: true });
    doc.addEventListener('keydown', onKey);
    return () => {
      watch.disconnect();
      doc.removeEventListener('keydown', onKey);
    };
  }, [node, close]);
}

export function SheetContent({
  className,
  bodyClassName,
  children,
  title,
  description,
  side: asked = 'bottom',
  size = 'reading',
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
  /** An end drawer's measure: how wide its content may make it. */
  size?: SheetSize;
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
  const narrow = useNarrow();
  const side: Exclude<SheetSide, 'auto'> = asked === 'auto' ? (narrow ? 'bottom' : 'end') : asked;
  const titled = showTitle || side === 'full';
  const titleRef = useRef<HTMLHeadingElement>(null);
  const settled = useSettledWidth<HTMLDivElement>(side === 'end');
  // The content itself, and a Close of its own on every side: what `useFocusKept` reads.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const content = useCallback(
    (next: HTMLDivElement | null) => {
      settled(next);
      setNode(next);
    },
    [settled],
  );
  const closer = useRef<HTMLButtonElement>(null);
  useFocusKept(node, closer);
  // The bottom sheet's handle: how far it is held from where it was taken, and
  // whether the sheet stands at the whole screen.
  const [grown, setGrown] = useState(false);
  const [held, setHeld] = useState(0);
  const grip = useRef<{ y: number; moved: boolean } | null>(null);
  // A drag ends in a click as well; this says the click was the drag's.
  const dragged = useRef(false);
  const letGo = useRef<HTMLButtonElement>(null);
  const take = (event: PointerEvent<HTMLButtonElement>) => {
    grip.current = { y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!grip.current) return;
    const by = event.clientY - grip.current.y;
    if (Math.abs(by) > 6) grip.current.moved = true;
    setHeld(Math.max(0, by));
  };
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const from = grip.current;
    grip.current = null;
    setHeld(0);
    dragged.current = Boolean(from?.moved);
    if (!from?.moved) return;
    const by = event.clientY - from.y;
    if (by > LET_GO_PX) letGo.current?.click();
    else if (by < -GROW_PX) setGrown(true);
    else if (by > GROW_PX) setGrown(false);
  };
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
        ref={content}
        data-sheet-side={side}
        {...(side === 'end' ? { 'data-sheet-size': size } : {})}
        style={held ? { transform: `translateY(${held}px)` } : undefined}
        className={cn(
          'fixed z-(--z-scrim) flex flex-col bg-surface shadow-overlay',
          side === 'bottom' && [
            // Rides up with the keyboard, never taller than 85 % of what is
            // visible — or the whole of it, once grown.
            'inset-x-0 bottom-[calc(100%-var(--app-height,100%))]',
            grown
              ? 'h-[calc(var(--app-height,100%)-env(safe-area-inset-top,0px))]'
              : 'max-h-[calc(var(--app-height,100%)*0.85)]',
            'rounded-t-lg border-t border-rule data-[state=open]:animate-rise',
            footer == null && 'pb-safe',
          ],
          side === 'end' && [
            'sheet-fit end-0 top-0 h-(--app-height)',
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
          <div className="shrink-0 bg-surface pt-1">
            <button
              type="button"
              data-sheet-handle=""
              aria-label={grown ? 'Shrink the sheet' : 'Grow the sheet to the whole screen'}
              aria-expanded={grown}
              onClick={() => {
                // Only a press that did not move grows or shrinks the sheet.
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setGrown((was) => !was);
              }}
              onPointerDown={take}
              onPointerMove={move}
              onPointerUp={release}
              onPointerCancel={() => {
                grip.current = null;
                setHeld(0);
              }}
              className="mx-auto flex h-6 w-16 touch-none items-center justify-center rounded-full [@media(hover:none)]:h-(--tap-min)"
            >
              <span aria-hidden className="h-1 w-9 rounded-full bg-rule-strong" />
            </button>
            <DialogPrimitive.Close
              ref={(button) => {
                letGo.current = button;
                closer.current = button;
              }}
              tabIndex={-1}
              aria-hidden
              className="sr-only"
            />
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
              ref={closer}
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
            '@container/drawer min-h-0 flex-1 overflow-y-auto overscroll-contain',
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
