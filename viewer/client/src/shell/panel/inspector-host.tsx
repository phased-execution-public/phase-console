import { useSyncExternalStore, type ReactNode } from 'react';
import { Inspector, type InspectorTab } from '@/ui/inspector';
import { openPanel } from './modes';

/**
 * Inspect — the second door to depth, hosted by the shell (design.md
 * principle 3). A page hands the panel ONE record — its name, its identity
 * row, and its four tabs (Overview · Actions · History · Raw; a tab the record
 * has nothing for is not drawn) — with `inspect()`, and the panel draws it
 * where the width calls for: the column at 1200 and up, a sheet below. The
 * record is module state rather than context, so a row deep in a lazy chunk
 * can inspect itself without the shell knowing its page.
 *
 * `key` names the record, so a page can tell whether ITS row is the one on
 * show (`useInspected`) and mark it; `inspect(null)` clears it.
 */
export interface Inspected {
  key: string;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  overview: ReactNode;
  actions?: ReactNode;
  history?: ReactNode;
  raw?: ReactNode;
  tab?: InspectorTab;
}

let current: Inspected | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const notify of listeners) notify();
}

/**
 * Show a record in the panel — and open the panel in Details, where it draws.
 * `open: false` hands the panel the record without opening it: a page whose
 * subject IS one record (an open session) puts it there for whenever the
 * panel stands, and leaves the opening to the person.
 */
export function inspect(record: Inspected | null, options: { open?: boolean } = {}): void {
  current = record;
  publish();
  if (record && options.open !== false) openPanel('details');
}

export function useInspected(): Inspected | null {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => current,
    () => current,
  );
}

export function __resetInspectorForTests(): void {
  current = null;
  publish();
}

/** The Details mode's body: the inspected record as the kit's bare frame, or one line saying there is none. */
export function InspectorHost() {
  const record = useInspected();
  if (!record) {
    return (
      <div className="px-(--pad-x) py-(--pad-y)">
        <p className="text-body text-ink-muted">Nothing is inspected. Pick a row to see its details here.</p>
      </div>
    );
  }
  const { key, tab, ...rest } = record;
  return <Inspector key={key} host="inline" defaultTab={tab} {...rest} />;
}
