import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useEffect, useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { mirrorUnless, useDocumentDir } from './direction';

/**
 * Tabs — the views of one page (Phases · Run · Source), the panel's modes.
 * Radix owns the roving tabindex and the arrow keys; what is added here is
 * that the strip scrolls sideways on a phone rather than wrapping, the active
 * trigger scrolls itself into view by moving the list's own `scrollLeft`
 * (never `scrollIntoView`, which drags the page), and the underline is ink.
 * The rule under the strip is an inset shadow, not a border a trigger reaches
 * down over: a scroll box clips whatever leaves it.
 */
export function Tabs({ dir, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  // Told the document's direction, or Radix draws `dir="ltr"` and the strip
  // stays unmirrored — its arrow keys backwards — in a right-to-left page.
  const page = useDocumentDir();
  return <TabsPrimitive.Root dir={dir ?? page} {...mirrorUnless(dir)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const list = useRef<HTMLDivElement>(null);
  const lastActive = useRef<string | null>(null);
  // Runs after every render (the active trigger is DOM state Radix owns, not a
  // prop), so it must SCROLL only when the active tab actually changed.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    const key = active.id || active.textContent || '';
    if (key === lastActive.current) return;
    lastActive.current = key;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (right > node.scrollLeft + node.clientWidth) node.scrollLeft = right - node.clientWidth;
  });
  return (
    <TabsPrimitive.List
      ref={list}
      className={cn(
        'flex items-stretch gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--rule)]',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'max-md:[mask-image:linear-gradient(90deg,black_88%,transparent)]',
        'rtl:max-md:[mask-image:linear-gradient(270deg,black_88%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative shrink-0 whitespace-nowrap px-3 py-2 text-body text-ink-muted',
        'border-b-2 border-transparent transition-colors duration-fast ease-transit',
        'hover:text-ink',
        'data-[state=active]:border-action data-[state=active]:text-ink',
        '[@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-3', className)} {...props} />;
}
