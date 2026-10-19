import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useTouch } from '@/lib/media';

export const TooltipProvider = TooltipPrimitive.Provider;

const bubble =
  'z-(--z-toast) max-w-72 rounded border border-rule bg-surface-raised px-2 py-1 text-meta text-ink shadow-overlay';

/**
 * A tooltip is a hover affordance, and a phone has no hover — so nothing
 * load-bearing is put in one. On touch this renders the trigger alone; the
 * information has to exist somewhere a thumb can reach.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  ...props
}: {
  content: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
} & Omit<ComponentProps<typeof TooltipPrimitive.Root>, 'children'>) {
  if (content == null || content === '') return <>{children}</>;
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className={bubble}>
          {content}
          <TooltipPrimitive.Arrow className="fill-surface-raised" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * Where a word sits inside something a person already presses or tabs to.
 * `[role=grid]` and its kin manage their own focus; a negative tabindex (a
 * `<main tabIndex={-1}>` skip target) is not a tab stop.
 */
const CONTROL =
  'a[href], button, input, select, textarea, summary, label, [contenteditable="true"], ' +
  '[tabindex]:not([tabindex^="-"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="treeitem"], [role="slider"], [role="grid"], [role="treegrid"], ' +
  '[role="listbox"], [role="menu"], [role="tablist"], [role="tree"]';

/** Is this element inside a control (not counting itself)? */
export function insideControl(el: Element): boolean {
  return el.parentElement?.closest(CONTROL) != null;
}

/** A ref that makes a lone trigger a tab stop — set on the DOM once, never through state. */
/**
 * Was the last thing the person did a key, rather than a pointer? A focus that
 * follows a press (a sheet moving focus to its first stop) is not a keyboard
 * reader's, and must not lay a bubble over what the press just opened. Nor is
 * a focus before ANY input: a page that places focus as it arrives — a push
 * landing on `#/turn/<id>` opens the card and focuses its first stop — would
 * otherwise lay a bubble over the card it landed on, and the browser calls
 * that programmatic focus `:focus-visible` (#394: the rehearsal's returned
 * item, its copy button under its own status's tooltip). So it starts false.
 */
let keyedLast = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (keyedLast = true), true);
  window.addEventListener('pointerdown', () => (keyedLast = false), true);
}

/** Is this focus a keyboard reader's? Only when a key was the last input. */
function focusVisible(): boolean {
  return keyedLast;
}

function focusableAlone(el: HTMLElement | null): void {
  if (el && !el.hasAttribute('tabindex') && !insideControl(el)) el.tabIndex = 0;
}

/**
 * A tooltip that answers a hover, a keyboard focus AND a tap (#365) — for a
 * word whose meaning a person must reach on any device, such as a status.
 *
 * Cheap enough for a page that draws hundreds: it carries its own provider
 * (no page has to mount one), and builds its content — `content` is a
 * function — only while open. The trigger is the child itself (`asChild`), so
 * the child must forward a ref and its props.
 *
 * Standing alone, the child becomes a tab stop (keyboard focus opens the
 * tooltip) and a tap target. Inside a control — a link, a button, a row of a
 * grid, anything already focusable — it is neither: a focusable thing inside
 * another is an axe violation and a second tab stop for one row, and the tap
 * belongs to the control it sits in. Hover works everywhere. Both are read
 * from the DOM, once when the child mounts and at the press, so no instance
 * holds state for it. A Radix tooltip never opens from touch on its own, so
 * the tap is ours: the press records whether it was open before Radix's own
 * pointer-down closes it, and the click sets the opposite.
 */
export function TapTip({
  content,
  children,
  side = 'top',
}: {
  content: () => ReactNode;
  children: ReactElement;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
}) {
  const [open, setOpen] = useState(false);
  // At a touch press: whether it was open before the press. Null otherwise.
  const tap = useRef<boolean | null>(null);
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger
          asChild
          // Radix stamps its open state as `data-state`, the 6.x status
          // attribute the family promises never to carry (the ratchet).
          data-state={undefined}
          ref={focusableAlone}
          onPointerDown={(event) => {
            tap.current = event.pointerType === 'touch' && !insideControl(event.currentTarget) ? open : null;
          }}
          // Focus opens it only when the focus is a keyboard reader's: a sheet
          // or a panel that moves focus to its first stop after a press must
          // not lay a bubble over what it just opened (one-pool phase 14).
          onFocus={(event) => {
            if (!focusVisible()) event.preventDefault();
          }}
          onClick={(event) => {
            if (tap.current === null) return;
            const was = tap.current;
            tap.current = null;
            // Stops Radix's own close-on-click, which would undo the tap.
            event.preventDefault();
            setOpen(!was);
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        {open && (
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content side={side} sideOffset={6} collisionPadding={8} className={bubble}>
              {content()}
              <TooltipPrimitive.Arrow className="fill-surface-raised" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        )}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * The TOUCH path for a blurb: a dedicated tap target, because Radix tooltips
 * deliberately never open from touch and a tap on an action already means "do
 * the action". On hover devices it behaves as the plain tooltip; on touch the
 * ⓘ toggles a CONTROLLED tooltip — dismissed by a second tap, Escape, or a
 * pointer-down anywhere outside.
 */
export function InfoTip({
  content,
  label = 'What this does',
  side = 'top',
  className,
}: {
  content: ReactNode;
  label?: string;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
  className?: string;
}) {
  const touch = useTouch();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!touch || !open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && trigger.current?.contains(target)) return; // the toggle handles itself
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [touch, open]);

  if (content == null || content === '') return null;

  return (
    <TooltipPrimitive.Root
      {...(touch
        ? {
            open,
            onOpenChange: (next: boolean) => {
              if (next) setOpen(true);
            },
          }
        : {})}
    >
      <TooltipPrimitive.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          aria-expanded={touch ? open : undefined}
          onClick={touch ? () => setOpen((value) => !value) : undefined}
          className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink',
            '[@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:min-w-(--tap-min)',
            className,
          )}
        >
          <Info size={14} aria-hidden />
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          // While controlled-by-touch, outside-tap dismissal is ours (the
          // capture listener above); Radix must not also close on its pointer
          // heuristics mid-scroll.
          onPointerDownOutside={touch ? (event) => event.preventDefault() : undefined}
          className={bubble}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-surface-raised" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
