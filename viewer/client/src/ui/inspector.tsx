import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Sheet, SheetContent, type SheetSize } from './sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

/**
 * Inspect — the second door to depth (design.md §1, principle 3): the full
 * structured account of ONE record, in four tabs that are the same on every
 * page — Overview · Actions · History · Raw. A tab the record has nothing
 * for is not drawn.
 *
 * Where it stands is the shell's decision, not the page's: the right panel at
 * 1200 and up, an end drawer from 640, a bottom sheet below (2026-10-20). So the
 * inspector comes in two hosts — `sheet`, which opens itself on the edge the
 * width calls for, and `inline`, the bare frame the shell docks into its
 * panel. The title is always visible: an inspector that hides its name is a
 * drawer of unattributed facts. The body pads on the density tokens.
 */
export type InspectorTab = 'overview' | 'actions' | 'history' | 'raw';

export interface InspectorProps {
  /** The record's name. */
  title: string;
  /** One line under the name, when the name is not enough. */
  description?: ReactNode;
  /** The identity row — the status, an id, a clock — first in the body. */
  meta?: ReactNode;
  overview: ReactNode;
  actions?: ReactNode;
  history?: ReactNode;
  /** The record as the machine holds it: a string is drawn as a mono block. */
  raw?: ReactNode;
  tab?: InspectorTab;
  defaultTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
  /** `sheet` opens on the edge the width calls for; `inline` is the frame alone, for the shell's panel. */
  host?: 'sheet' | 'inline';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** The record's measure — how wide its content may make a drawer (`ui/sheet.tsx`). */
  size?: SheetSize;
  /**
   * The record draws its own head (a Your turn card, 2026-10-20): the frame
   * draws no heading, description or meta row over it, so one record wears
   * ONE title and ONE status. The title still names the region.
   */
  headless?: boolean;
}

const TAB_LABELS: Readonly<Record<InspectorTab, string>> = {
  overview: 'Overview',
  actions: 'Actions',
  history: 'History',
  raw: 'Raw',
};

function InspectorBody({
  meta,
  overview,
  actions,
  history,
  raw,
  tab: controlled,
  defaultTab = 'overview',
  onTabChange,
}: Pick<
  InspectorProps,
  'meta' | 'overview' | 'actions' | 'history' | 'raw' | 'tab' | 'defaultTab' | 'onTabChange'
>) {
  const [uncontrolled, setUncontrolled] = useState<InspectorTab>(defaultTab);
  const present: InspectorTab[] = (['overview', 'actions', 'history', 'raw'] as const).filter((t) =>
    t === 'overview'
      ? true
      : t === 'actions'
        ? actions != null
        : t === 'history'
          ? history != null
          : raw != null,
  );
  const current = controlled ?? uncontrolled;
  const tab = present.includes(current) ? current : 'overview';
  const panes: Record<InspectorTab, ReactNode> = {
    overview,
    actions,
    history,
    raw:
      typeof raw === 'string' ? (
        <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta text-ink-muted">
          {raw}
        </pre>
      ) : (
        raw
      ),
  };
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (controlled === undefined) setUncontrolled(next as InspectorTab);
        onTabChange?.(next as InspectorTab);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {meta != null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-(--pad-x) pb-2">{meta}</div>
      )}
      {present.length > 1 && (
        <TabsList aria-label="Inspector views" className="shrink-0 px-(--pad-x)">
          {present.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TAB_LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      {present.map((t) => (
        <TabsContent
          key={t}
          value={t}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-(--pad-x) py-(--pad-y)"
        >
          {panes[t]}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function Inspector({
  title,
  description,
  host = 'sheet',
  open = true,
  onOpenChange,
  className,
  size = 'reading',
  headless = false,
  meta,
  ...body
}: InspectorProps) {
  if (host === 'inline') {
    return (
      <section
        data-inspector
        data-headless={headless ? '' : undefined}
        aria-label={title}
        className={cn('flex h-full min-h-0 flex-col', className, headless && 'pt-(--pad-y)')}
      >
        {!headless && (
          <header className="shrink-0 px-(--pad-x) pb-2 pt-(--pad-y)">
            <h2 className="text-section font-semibold text-ink">{title}</h2>
            {description != null && <p className="mt-0.5 text-body text-ink-muted">{description}</p>}
          </header>
        )}
        <InspectorBody {...body} meta={headless ? undefined : meta} />
      </section>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange ?? (() => {})}>
      <SheetContent
        title={title}
        side="auto"
        size={size}
        showTitle={!headless}
        {...(description != null && !headless ? { description } : {})}
        className={className}
        bodyClassName="flex flex-col p-0"
      >
        <InspectorBody {...body} meta={headless ? undefined : meta} />
      </SheetContent>
    </Sheet>
  );
}
