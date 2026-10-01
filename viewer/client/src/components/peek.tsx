/**
 * A peek — the facts behind a link, shown while the pointer rests on it or
 * focus lands on it (control-tower phase 19; §Architecture 6:
 * `@radix-ui/react-hover-card`).
 *
 * Outside the `@/components/ui` barrel on purpose: the barrel is one
 * modulepreloaded chunk, and nothing new may enter first paint through it
 * (`scripts/check-dist.mjs` holds the hover card out of first paint by content).
 *
 * **The trigger must itself be a link or a button.** A peek is a shortcut to
 * facts that are also one press away — the trigger IS that press — so nothing a
 * peek shows is hover-only: a touch screen (which never hovers), a keyboard and
 * a screen reader all reach the same facts by pressing it. A span trigger would
 * make the peek the only door to what it shows, so it is refused at render:
 * the trigger is drawn bare, with no peek at all (`peekableTrigger`).
 */

import * as HoverCard from '@radix-ui/react-hover-card';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

/** A peek's trigger is a real `<a href>` or a `<button>` — never a span with a hover. */
export function peekableTrigger(node: ReactNode): node is ReactElement {
  if (!isValidElement(node)) return false;
  if (node.type === 'button') return true;
  return node.type === 'a' && Boolean((node.props as { href?: string }).href);
}

export function Peek({
  children,
  content,
  label,
  side = 'bottom',
  align = 'start',
}: {
  /** The trigger: a link or a button, whose press reaches everything the peek shows. */
  children: ReactNode;
  /** What the peek shows — facts, never controls (a hover card cannot be relied on to stay open). */
  content: ReactNode;
  /** The peek's accessible name. */
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  if (!peekableTrigger(children)) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={400} closeDelay={120}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          data-testid="peek"
          className="z-(--z-scrim) w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-rule bg-surface-raised p-3 text-2xs text-ink shadow-card"
        >
          {content}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
