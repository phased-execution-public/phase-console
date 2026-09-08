/**
 * How the sessions list is ordered and narrowed.
 *
 * Sessions was the last list in the console with no controls at all: Plans and
 * Runs shared `components/toolbar.tsx`, and this page grouped by a hard-coded
 * kind order and stopped there. On a machine running four lanes, two shells and
 * a dozen `claude` processes the presence hook can see, "which one is the one I
 * left waiting" was a scroll.
 *
 * The split is the same one every list here makes. The MECHANISM —
 * comparators, pinning, per-filter predicates — is `lib/list-model.ts`. The
 * VOCABULARY is this file, and it is the only thing that knows what a session
 * is. The kinds themselves are not re-spelled: `SESSION_GROUPS` in `list.tsx`
 * owns them, and both the order and the chips read it.
 *
 * ## Two clocks, and why both orders exist
 *
 * `startedAt` on a row is the LAST thing that happened to it (a pty's exit, a
 * foreign session's last sighting); `createdAt` is when it began. They answer
 * different questions — "what has gone quiet" against "what has been running
 * all afternoon" — and a list with only the first cannot find a shell somebody
 * opened this morning and forgot.
 *
 * ## What is pinned, and what merely sorts
 *
 * A session stopped waiting on a PERSON is pinned to the top of every order,
 * for the reason the fleet pins a live run: whatever you sorted by, the thing
 * that cannot proceed without you is the row you came to see. Being live is
 * not a pin — it is the first clause of each comparator — because "live" is a
 * property this list is often ordered *against* (the ended records are exactly
 * what the created order is for).
 */

import { defineFilters, defineSorts, matchesWords, words } from '@/lib/list-model';
import { KIND_ORDER, SESSION_GROUPS, type SessionGroupKind, type SessionRow } from './list';

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

const byLive = (a: SessionRow, b: SessionRow) => Number(b.live) - Number(a.live);
const byLabel = (a: SessionRow, b: SessionRow) => a.label.localeCompare(b.label);
const byRecency = (a: SessionRow, b: SessionRow) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || byLabel(a, b);

export const { SORTS, isSortId, sortRows } = defineSorts<SessionRow, 'activity' | 'created' | 'kind'>(
  {
    activity: {
      label: 'Activity',
      hint: 'most recently active first',
      blurb: 'Live first, then whatever last printed, answered or was last seen.',
      // The kind tiebreak is what the page shipped with, and it is what keeps
      // the grouped rendering identical to the ungrouped one within a section.
      compare: (a, b) => byLive(a, b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byRecency(a, b),
    },
    created: {
      label: 'Started',
      hint: 'newest session first',
      blurb: 'When each session began — the oldest live one is at the bottom.',
      compare: (a, b) => byLive(a, b) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || byLabel(a, b),
    },
    kind: {
      label: 'Kind',
      hint: 'lanes, then sessions, then shells, then everyone else',
      blurb: 'The four kinds in the order the sections use, each newest first.',
      compare: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byLive(a, b) || byRecency(a, b),
    },
  },
  { pin: (row) => Boolean(row.attention) },
);

export type SortId = 'activity' | 'created' | 'kind';

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * ⚠️ A type alias, never an `interface`: `defineFilters` constrains its filter
 * set to `Record<string, unknown>`, and TypeScript infers an implicit index
 * signature for an alias and refuses one for an interface.
 */
export type Filters = {
  /** Free text over the label, the directory, and both kinds of id. */
  query: string;
  /** One `SessionGroupKind`, or every kind. A word the list does not offer reads as every kind. */
  kind: string;
};

export const { NO_FILTERS, applyFilters, activeCount } = defineFilters<SessionRow, Filters>({
  query: {
    initial: '',
    prepare: (value) => words(String(value)),
    inert: (value) => !words(String(value)).length,
    keep: (row, terms) =>
      matchesWords(
        // The cwd is in here because it is the only thing that distinguishes
        // eight shells all labelled `zsh`, and both ids because an id is what
        // a lock, a journal line or a `--resume` command hands you.
        `${row.label} ${row.detail ?? ''} ${row.id ?? ''} ${row.sessionId ?? ''}`,
        terms as string[],
      ),
  },
  kind: {
    initial: '',
    keep: (row, value) => row.kind === value,
  },
});

/** How many of each kind are in view — the chips' own counts. */
export function kindCounts(rows: readonly SessionRow[]): Record<SessionGroupKind, number> {
  const counts = Object.fromEntries(SESSION_GROUPS.map((group) => [group.kind, 0])) as Record<
    SessionGroupKind,
    number
  >;
  for (const row of rows) counts[row.kind]++;
  return counts;
}
