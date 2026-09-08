/**
 * Settle history — how each run's work reached (or failed to reach) the trunk.
 *
 * ## The window is rendered, not logged
 *
 * `GET /api/repo/settles` reads a journal TAIL — 25 runs × 500 entries by
 * default — because a full journal read is up to 32 MB *per run*. Settling is
 * the last thing a run does, so the tail carries its own rows; but a lane that
 * landed early in a long run can fall off the end of one. The response says how
 * far it looked, and Phase 8 asked this surface in as many words to SHOW that:
 * a history displayed without its window claims a completeness it does not have.
 *
 * ## `via` here is not `via` on a checkout
 *
 * On a checkout `via` is `record | branch` — evidence versus a guess. Here it is
 * `record | journal`: which of two sources carried the row. Both are real, and
 * they are complementary — the run record survives a trimmed journal and carries
 * the strategy; the journal carries the per-lane detail. One moment legitimately
 * appears from both, and that is two pieces of evidence, not a duplicate.
 */

import { useMemo } from 'react';
import { GitPullRequestArrow } from 'lucide-react';
import { Badge, Chip, DataTable, Empty } from '@/components/ui';
import type { BadgeTone, Column } from '@/components/ui';
import type { RepoSettleEvent, RepoSettles, SettleKind } from '@/lib/api';
import { relativeTime } from '@/lib/format';

/**
 * How each settle event paints.
 *
 * `pending` and `unsupported` are deliberately not amber: neither is a problem
 * with the run. `pending` is a settle that has not happened yet and
 * `unsupported` is a strategy this repository cannot do — a standing
 * configuration fact. `failed` is the one that gets the alarm.
 */
const KIND_TONE: Readonly<Record<SettleKind, BadgeTone>> = Object.freeze({
  settled: 'ok',
  landed: 'ok',
  pending: 'neutral',
  unsupported: 'neutral',
  failed: 'bad',
  released: 'neutral',
  pruned: 'neutral',
});

const KIND_BLURB: Readonly<Record<SettleKind, string>> = Object.freeze({
  settled: 'The lane folded back into the run branch.',
  landed: 'The work reached the trunk.',
  pending: 'A settle that has not happened yet. Not a failure.',
  unsupported: 'This repository cannot settle that way — a configuration fact, not an error.',
  failed: 'The settle did not complete. The detail says what stopped it.',
  released: 'The lane let go of its scope.',
  pruned: 'The checkout was removed.',
});

/**
 * The columns, and the one number each of them declares.
 *
 * Every `min` below was measured against the widest real content the column can
 * hold, not guessed: `unsupported` is the longest kind word and its `Badge` is
 * 78 px of border box, `fast-forward` the longest strategy. Under-declaring one
 * is what flips a whole table to scroll mode for four pixels and takes the
 * sticky header with it — see `components/ui/table.tsx`.
 *
 * The run leads, and that is a change from the hand-rolled version where the
 * event badge did. The identity column is the one that pins left when the table
 * has to scroll, so an identity in column two pins nothing useful and leaves the
 * cell before it sliding underneath.
 */
const settleColumns: Column<RepoSettleEvent>[] = [
  {
    id: 'run',
    head: 'Run',
    identity: true,
    flex: true,
    card: 'title',
    min: 200,
    priority: 1,
    // Two stacked lines against one-line neighbours: the slug reads level with
    // them only from the top.
    cellClassName: 'align-top',
    cell: (e) => (
      <>
        <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <code className="min-w-0 truncate font-mono text-2xs text-ink" title={e.slug}>
            {e.slug}
          </code>
          {e.phase !== undefined && <span className="text-2xs text-ink-muted">p{e.phase}</span>}
        </span>
        {/* A `<span className="block">`, not a `<p>`. `DataTable` wraps the
            identity cell in a `<span>` when the row is expandable (and settles
            is, at realistic widths) and again in `CardList` — block content
            inside phrasing content is legal in the DOM React builds and not in
            the markup it represents. */}
        {e.detail && (
          <span className="mt-0.5 block min-w-0 break-words text-2xs text-ink-faint">{e.detail}</span>
        )}
      </>
    ),
  },
  {
    id: 'kind',
    head: 'Event',
    priority: 1,
    min: 108,
    cellClassName: 'align-top',
    cell: (e) => (
      <Badge tone={KIND_TONE[e.kind] ?? 'neutral'} title={KIND_BLURB[e.kind] ?? e.kind}>
        {e.kind}
      </Badge>
    ),
  },
  {
    id: 'branch',
    head: 'Branch',
    priority: 3,
    min: 168,
    cellClassName: 'align-top',
    cell: (e) =>
      e.branch ? (
        <code className="block min-w-0 truncate font-mono text-2xs text-ink-muted" title={e.branch}>
          {e.branch}
        </code>
      ) : (
        <span className="text-2xs text-ink-faint">—</span>
      ),
  },
  {
    id: 'strategy',
    head: 'Strategy',
    priority: 4,
    min: 108,
    cellClassName: 'align-top',
    cell: (e) => <span className="text-2xs text-ink-muted">{e.strategy ?? '—'}</span>,
  },
  {
    id: 'via',
    head: 'Source',
    priority: 4,
    min: 96,
    cellClassName: 'align-top',
    cell: (e) => (
      <Chip
        tone="neutral"
        data-testid="settle-via"
        title={
          e.via === 'record'
            ? 'From the run record: it survives a trimmed journal and carries the strategy.'
            : 'From the run journal: it carries the per-lane detail. A moment may legitimately appear from both sources.'
        }
      >
        {e.via}
      </Chip>
    ),
  },
  {
    id: 'at',
    head: 'When',
    priority: 2,
    min: 112,
    card: 'meta',
    cellClassName: 'align-top',
    cell: (e) => {
      const at = Date.parse(e.at);
      return (
        <span
          className="text-2xs text-ink-faint"
          title={Number.isNaN(at) ? e.at : new Date(at).toLocaleString()}
        >
          {Number.isNaN(at) ? e.at : relativeTime(at)}
        </span>
      );
    },
  },
];

/** The window this history was read through. Always rendered — see the file lead. */
export function ScannedNote({ view }: { view: RepoSettles }) {
  return (
    <p className="mt-2 text-2xs text-ink-faint" data-testid="settles-scanned">
      Read from the tail of {view.scanned.runs} run journal{view.scanned.runs === 1 ? '' : 's'}, at most{' '}
      {view.scanned.entriesPerRun} entries each — settling is the last thing a run does, so the tail usually
      carries it. A lane that settled early in a long run can be missing from this list.
      {view.truncated && ' The list itself also hit its cap.'}
    </p>
  );
}

export function SettleTable({ view }: { view: RepoSettles }) {
  const rowProps = useMemo(
    () => (e: RepoSettleEvent) => ({ 'data-testid': 'settle-row', 'data-kind': e.kind, 'data-via': e.via }),
    [],
  );
  if (view.events.length === 0) {
    return (
      <div>
        <Empty
          icon={<GitPullRequestArrow size={20} aria-hidden />}
          title="No settle events in the window"
          body="Either nothing has settled here yet, or every settle happened further back than the tail this read covers — the line below says which window was searched."
        />
        <ScannedNote view={view} />
      </div>
    );
  }
  return (
    <div>
      <DataTable
        label="Settle history"
        columns={settleColumns}
        rows={view.events}
        // No index in the key. It was harmless as a React key and it is not
        // one here: `DataTable` keys its `open: Set<string>` on this string, so
        // a new settle arriving at the head of the list shifted every key below
        // it and the open disclosure jumped to a different event. The phase is
        // what actually distinguishes two rows a run can write at the same
        // instant — a per-phase worktree landing.
        getRowKey={(e) => `${e.runId}-${e.at}-${e.kind}-${e.via}-${e.phase ?? ''}`}
        rowProps={rowProps}
      />
      <ScannedNote view={view} />
    </div>
  );
}
