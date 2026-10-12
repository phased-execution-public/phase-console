import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A button says exactly what happens when it is pressed (design.md §9), and
 * looks like one of four things:
 *
 *   `default`  the quiet button — a hairline, the surface tone;
 *   `primary`  the one thing to do now — ink-solid, ONE per screen;
 *   `ghost`    a control that is a word — no box until it is hovered;
 *   `danger`   a destructive verb, in the failed hue — it still confirms.
 *
 * There is no amber button: amber is a summons, and a button is never one. On
 * touch every button is thumb-high and thumb-wide (`--tap-min`); the drawn box
 * on a desk is 32 px. `asChild` lends the look to a link.
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded',
    'text-body font-medium transition-colors duration-fast ease-transit',
    'disabled:pointer-events-none disabled:opacity-50',
    '[@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:min-w-(--tap-min)',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'border border-rule-strong bg-surface text-ink hover:bg-surface-raised hover:border-ink-faint',
        primary: 'bg-action text-ground hover:opacity-90',
        ghost: 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        danger: 'border border-failed/50 text-failed hover:bg-failed/10',
      },
      size: {
        sm: 'h-7 px-2 text-meta',
        md: 'h-8 px-3',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child (a link) with the button's look instead of a `<button>`. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}

/**
 * Buttons that belong together, drawn as one box. It neither shrinks nor
 * clips: a group that squashed its segments was how a measured phone lost the
 * middle button of three.
 */
export function ButtonGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn(
        'inline-flex shrink-0 rounded border border-rule-strong',
        '[&>button]:rounded-none [&>button]:border-0 [&>button:first-child]:rounded-s [&>button:last-child]:rounded-e',
        '[&>button+button]:border-s [&>button+button]:border-rule-strong',
        '[&>button[aria-pressed=true]]:bg-surface-raised [&>button[aria-pressed=true]]:text-ink',
        className,
      )}
      {...props}
    />
  );
}
