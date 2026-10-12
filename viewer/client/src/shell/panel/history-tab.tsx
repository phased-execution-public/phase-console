import type { ReactNode } from 'react';
import { RelativeTime } from '@/ui';

/** One thing that happened to the record: when, what, and who, if known. */
export interface HistoryEntry {
  at: string;
  text: ReactNode;
  by?: string;
}

/**
 * The inspector's History tab: what happened to this record, newest first,
 * one line each — a clock, the words, and who. Space between lines, a rule
 * only where the caller groups them.
 */
export function HistoryTab({ entries }: { entries: readonly HistoryEntry[] }) {
  if (!entries.length) return <p className="text-body text-ink-muted">Nothing has happened to it yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="flex items-baseline gap-3 text-body">
          <RelativeTime at={entry.at} className="w-16 shrink-0 text-meta text-ink-faint" />
          <span className="min-w-0 flex-1 text-ink">{entry.text}</span>
          {entry.by && <span className="shrink-0 text-meta text-ink-muted">{entry.by}</span>}
        </li>
      ))}
    </ol>
  );
}
