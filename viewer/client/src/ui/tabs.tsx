import { DirectionProvider } from '@base-ui/react/direction-provider';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { useEffect, useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { mirrorUnless, useDocumentDir, type Direction } from './direction';

/**
 * Tabs — the views of one record (the Inspector's Overview · Actions · History
 * · Raw), as a BAY (2026-10-20, Tower strips): a recessed track whose current
 * tab is a raised tile that slides to the tab chosen. Base UI owns the roving
 * focus, the arrow keys and the tile's place (`Tabs.Indicator`, which sets
 * `--active-tab-left`, `-right` and `-width` from the active tab's box); what
 * is added here is the look, that the track scrolls sideways on a phone
 * rather than wrapping, and that the active tab scrolls itself into view by
 * moving the track's own `scrollLeft` (never `scrollIntoView`, which drags
 * the page). The tile is logical: it is placed from the start edge of the
 * reading direction, so it mirrors under `dir="rtl"` with the arrow keys.
 */
export function Tabs({
  dir,
  ...props
}: Omit<ComponentProps<typeof BaseTabs.Root>, 'dir'> & { dir?: Direction | undefined }) {
  // Told the document's direction, or the arrow keys run backwards in a
  // right-to-left page.
  const page = useDocumentDir();
  return (
    <DirectionProvider direction={dir ?? page}>
      <BaseTabs.Root dir={dir ?? page} {...mirrorUnless(dir)} {...props} />
    </DirectionProvider>
  );
}

export function TabsList({ className, children, ...props }: ComponentProps<typeof BaseTabs.List>) {
  const list = useRef<HTMLDivElement>(null);
  const lastActive = useRef<string | null>(null);
  // Runs after every render (the active tab is DOM state the primitive owns,
  // not a prop), so it must SCROLL only when the active tab actually changed.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
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
    <BaseTabs.List
      ref={list}
      className={cn(
        'relative flex max-w-full items-stretch gap-0.5 self-start overflow-x-auto rounded-lg bg-ground-deep p-1',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'max-md:[mask-image:linear-gradient(90deg,black_88%,transparent)]',
        'rtl:max-md:[mask-image:linear-gradient(270deg,black_88%,transparent)]',
        className,
      )}
      {...props}
    >
      {/* The raised tile under the active tab — first, so every tab paints above it. */}
      <BaseTabs.Indicator
        data-tab-tile=""
        className={cn(
          'absolute inset-y-1 w-(--active-tab-width) rounded-md border border-rule-strong bg-surface',
          'ltr:start-(--active-tab-left) rtl:start-(--active-tab-right)',
          'transition-[inset-inline-start,width] duration-medium ease-transit',
        )}
      />
      {children}
    </BaseTabs.List>
  );
}

export function TabsTrigger({ className, onMouseDown, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      // A tab is taken on the press, as the kit's tabs always were (Radix's
      // habit), not on the release: the panel answers the finger's first touch.
      onMouseDown={(event) => {
        onMouseDown?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || props.disabled) return;
        event.currentTarget.click();
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 whitespace-nowrap',
        'text-body text-ink-muted transition-colors duration-fast ease-transit',
        'hover:text-ink data-[active]:font-medium data-[active]:text-ink',
        '[@media(hover:none)]:min-h-(--tap-min)',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn('pt-3', className)} {...props} />;
}
