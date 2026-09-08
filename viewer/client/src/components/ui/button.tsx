import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ForwardedRef } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * `action` is the amber one, and it is rationed: amber means "this is the thing
 * to do now" (start the ready phase, answer the card). A screen with two amber
 * buttons has told you nothing. Everything else is `default` or `ghost`.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium ' +
    'transition-colors duration-fast ease-transit ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    // Every control is thumb-sized on a touch device. On a mouse the same
    // control can be its natural height — 44px of chrome around a text button
    // reads as a form, not a toolbar.
    //
    // BOTH directions, since Phase 7. The height alone was half a floor, and
    // the half that was missing is the one short labels fail: Insights' `Cost`
    // and `Phase` sort buttons measured 24–25px wide and a full 44 tall, so a
    // control that looked compliant in one axis was a quarter of a thumb in the
    // other.
    //
    // A `min-w` squashes nothing on its own — but it does make a button WIDER
    // than the space it was given, and a floor is only a floor while the box
    // that holds it lets it be seen. Measured at 360 under a coarse pointer:
    // these same two buttons became 44px each inside a `ButtonGroup` that had
    // shrunk to 50px, and `overflow: hidden` hid the second one — 5px of its
    // 44px box, its centre answering `<main>`. The group is what was fixed
    // (below); the rule here is that a floor declared on a control is a claim
    // ABOUT ITS ANCESTORS TOO.
    '[@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:min-w-(--tap-min)',
  {
    variants: {
      variant: {
        default: 'border border-rule bg-surface text-ink hover:bg-surface-raised hover:border-rule-strong',
        action: 'border border-action/60 bg-action/12 text-action hover:bg-action/20',
        ghost: 'border border-transparent text-ink-muted hover:bg-surface hover:text-ink',
        danger: 'border border-blocked/50 bg-blocked/10 text-blocked hover:bg-blocked/20',
      },
      size: {
        sm: 'h-7 px-2 text-2xs',
        md: 'h-9 px-3 text-sm',
        lg: 'h-11 px-4 text-md',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef(function Button(
  { className, variant, size, asChild = false, type = 'button', ...props }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      // A `<button>` inside a form defaults to `submit`; every button in this
      // app that meant submit says so.
      {...(asChild ? {} : { type })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

/**
 * A segmented group — the theme switcher, density, sort.
 *
 * Two rules here are load-bearing, and both were bought at the price of a
 * shipped defect (Phase 7, QA round 2).
 *
 * **It does not shrink.** It was a shrinkable flex item, and `theme.css`'s base
 * `* { min-width: 0 }` means shrinkable goes all the way to nothing. In a
 * `CardHeader` at 360 sharing 334px with a title, a 45-character note and Copy
 * CSV, the Insights sort group shrank to **50px** around two children the
 * coarse-pointer floor makes **44px each**. A segmented control that eats its
 * own segments is a broken primitive, so this one keeps its content width and
 * the container is what gives — `CardHeader` wraps.
 *
 * **It does not clip.** The 50px group was `overflow-hidden`, so the second
 * segment was not merely squeezed, it was INVISIBLE: 5px of its 44px box drawn,
 * its centre answering `<main>`, and a hit-test probe that asks "is the control
 * in the stack" answering yes the whole time — the ancestor answers where the
 * child was clipped away. The radius therefore lives on the end segments
 * instead. Nothing between a control and the viewport may hide it; a clip is
 * the one failure the probes cannot see, so the primitive does not own one.
 * (It also stops the group clipping a first/last segment's focus ring.)
 */
export function ButtonGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn(
        'inline-flex shrink-0 rounded border border-rule',
        '[&>button]:rounded-none [&>button]:border-0 [&>button]:border-r [&>button]:border-rule',
        // −1px: the segment nests inside the group's 1px border, so its own
        // radius has to be that much tighter or the corner reads as thick.
        '[&>button:first-child]:rounded-l-[calc(var(--radius)-1px)]',
        '[&>button:last-child]:rounded-r-[calc(var(--radius)-1px)]',
        '[&>button:last-child]:border-r-0',
        '[&>button[aria-pressed=true]]:bg-action/15 [&>button[aria-pressed=true]]:text-action',
        className,
      )}
      {...props}
    />
  );
}
