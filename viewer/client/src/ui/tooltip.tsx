import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
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
