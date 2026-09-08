/**
 * Branches, and the parallel-execution story told from the repository's side.
 *
 * `features/runs/git-card.tsx` answers this for ONE run out of the live
 * runner's cache, which is why it goes blank the moment that run stops. This
 * asks the repository instead, so a branch a dead console left behind is a row
 * here exactly like a live one — the difference between them is what the row is
 * FOR.
 *
 * Two fields carry that difference and neither may be flattened into the other:
 *
 * - **`run` is parsed from the NAME.** `pe/<slug>-p<N>` is a convention an
 *   operator can type by hand, so a `run` here is a reading, never evidence.
 * - **`heldBy` is the checkout registry.** A tree standing on this branch is a
 *   fact git printed, and it is what makes a branch unsafe to delete.
 *
 * And the two absent-number rules are the ones the seed card got right and a
 * redraw would get wrong: `ahead`/`behind` are `undefined` when there is nothing
 * to measure against, never `0` — a branch with no upstream is not "up to date",
 * it is untracked — and `divergenceTruncated` means some rows were not measured
 * at all, which a blank cell would otherwise report as zero.
 */

import { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { Badge, Chip, DataTable, Empty } from '@/components/ui';
import type { Column } from '@/components/ui';
import type { RepoBranch, RepoBranches } from '@/lib/api';
import { relativeTime, homePath, plural } from '@/lib/format';

/** The dash. One spelling, so "not measured" looks the same in every row. */
const UNKNOWN = '—';

/**
 * `3 ahead · 1 behind`, or the dash — and the dash is NEVER zero.
 *
 * Each side reports independently. `?? 0` on one half of a pair where only the
 * other was measured is the same lie as `?? 0` on both: it prints a
 * measurement that was not taken. Absent means absent, per side.
 */
export function divergence(branch: RepoBranch): string {
  if (branch.ahead === undefined && branch.behind === undefined) return UNKNOWN;
  const ahead = branch.ahead === undefined ? UNKNOWN : String(branch.ahead);
  const behind = branch.behind === undefined ? UNKNOWN : String(branch.behind);
  return `${ahead} ahead · ${behind} behind`;
}

/**
 * The columns, and why the branch name is a `<button>` rather than a link.
 *
 * Picking a branch opens the inspector beside the list — it changes what the
 * page shows, it does not navigate — so `rowHref` is the wrong primitive and
 * the identity cell carries its own control. The floor comes off above `sm`,
 * where the row is already 44 px of padded cell and a taller button would only
 * space the list out.
 *
 * `min`s are measured against real content: the divergence string is at its
 * longest `— ahead · — behind` (18 characters of `text-2xs`), `checked out` is
 * the widest badge, and the Run chip holds a slug plus `· p12`.
 */
function branchColumns(home: string | undefined, onPick: (b: RepoBranch) => void): Column<RepoBranch>[] {
  return [
    {
      id: 'name',
      head: 'Branch',
      identity: true,
      flex: true,
      card: 'title',
      min: 240,
      priority: 1,
      cell: (branch) => (
        <button
          type="button"
          onClick={() => onPick(branch)}
          // `items-stretch` (the default) and NOT `items-start`. In a column
          // flex box `align-items: start` sizes each child to its own content
          // instead of to the box — so the subject line below was as wide as
          // the commit message and `truncate` on it never engaged. Measured in
          // the phone card list at 360: 139px past `<main>`'s clip edge, cut
          // with no ellipsis and no way to reach the rest. `text-left` is what
          // was actually wanted here, and it is already on the button.
          className="flex min-h-(--tap-min) w-full min-w-0 flex-col justify-center gap-0.5 text-left sm:min-h-0"
          aria-label={`Branch ${branch.name}`}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <GitBranch size={12} className="shrink-0 text-ink-faint" aria-hidden />
            <code className="min-w-0 truncate font-mono text-2xs text-ink" title={branch.name}>
              {branch.name}
            </code>
            {branch.current && (
              <Badge tone="accent" title="This is the branch the working tree is on.">
                checked out
              </Badge>
            )}
            {branch.trunk && (
              <Badge tone="ok" title="The trunk this repository settles onto.">
                trunk
              </Badge>
            )}
          </span>
          {branch.subject && (
            <span className="min-w-0 truncate text-2xs text-ink-muted" title={branch.subject}>
              {branch.subject}
            </span>
          )}
        </button>
      ),
    },
    {
      id: 'run',
      head: 'Run (from the name)',
      priority: 3,
      min: 176,
      cellClassName: 'align-top',
      cell: (branch) =>
        branch.run ? (
          // It BREAKS, and 176px is therefore a floor rather than a promise.
          // A plan slug is arbitrary length — this repository's own branches
          // carry `phase-console-commerce · p23`, about 240px of `Badge`, whose
          // base class is `whitespace-nowrap`. Under `table-fixed` a chip that
          // will not break does not widen its column, it escapes it, which is
          // the exact escape this table was migrated to close. Same answer as
          // `components/scope-chips.tsx`: the vocabulary badges stay nowrap, a
          // value that came out of a plan file wraps.
          <Chip
            tone="accent"
            mono
            className="max-w-full break-all whitespace-normal"
            data-testid="branch-run"
            title={`Read from the branch NAME as ${branch.run.slug}${
              branch.run.phase === undefined ? '' : ` phase ${branch.run.phase}`
            }. A name is something an operator can type — nothing here checked a run record.`}
          >
            {branch.run.slug}
            {branch.run.phase === undefined ? '' : ` · p${branch.run.phase}`}
          </Chip>
        ) : (
          <span className="text-2xs text-ink-faint">{UNKNOWN}</span>
        ),
    },
    {
      id: 'divergence',
      head: 'Divergence',
      priority: 4,
      min: 136,
      card: 'meta',
      cellClassName: 'align-top',
      cell: (branch) => <span className="text-2xs text-ink-muted">{divergence(branch)}</span>,
    },
    {
      id: 'held',
      head: 'Held by',
      priority: 4,
      min: 112,
      cellClassName: 'align-top',
      cell: (branch) =>
        branch.heldBy?.length ? (
          <span
            className="text-2xs text-ink-muted"
            data-testid="branch-held"
            title={branch.heldBy.map((d) => homePath(d, home) ?? d).join('\n')}
          >
            {plural(branch.heldBy.length, 'checkout')}
          </span>
        ) : (
          <span className="text-2xs text-ink-faint">free</span>
        ),
    },
    {
      id: 'at',
      head: 'Last commit',
      priority: 2,
      min: 116,
      card: 'meta',
      cellClassName: 'align-top',
      cell: (branch) => {
        const at = branch.at ? Date.parse(branch.at) : NaN;
        return (
          <span className="text-2xs text-ink-faint">{Number.isNaN(at) ? UNKNOWN : relativeTime(at)}</span>
        );
      },
    },
  ];
}

export function BranchTable({
  view,
  home,
  active,
  onPick,
}: {
  view: RepoBranches;
  home?: string;
  active?: string;
  onPick: (branch: RepoBranch) => void;
}) {
  // Before the early return: a hook may not run conditionally.
  const columns = useMemo(() => branchColumns(home, onPick), [home, onPick]);
  if (view.branches.length === 0) {
    return (
      <Empty
        icon={<GitBranch size={20} aria-hidden />}
        title="No branches here"
        body="A repository with no local branches — a fresh clone that has not checked one out, or one that only ever ran detached."
      />
    );
  }
  /*
   * The trunk may be named and absent from its own list, and that is not a bug
   * to paper over. `trunk` is asked of git directly, so a repository with more
   * branches than the row cap can name a trunk whose row fell out of the
   * window. Saying so is strictly better than the alternative it replaced,
   * which was reporting whatever HEAD happened to stand on.
   */
  const trunkMissing = Boolean(view.trunk) && !view.branches.some((b) => b.name === view.trunk);
  return (
    <>
      <DataTable
        label="Branches"
        columns={columns}
        rows={view.branches}
        getRowKey={(b) => b.name}
        rowProps={(b) => ({
          'data-testid': 'branch-row',
          'data-name': b.name,
          ...(b.name === active ? { 'aria-current': 'true' } : {}),
        })}
        rowClassName={(b) => (b.name === active ? 'bg-surface-raised' : undefined)}
      />
      <div className="mt-2 flex flex-col gap-1 text-2xs text-ink-faint">
        {view.truncated && (
          <p data-testid="branches-truncated">
            More branches than this list holds. What is shown is the most recently committed — a longer list
            is a query away, not a click.
          </p>
        )}
        {view.divergenceTruncated && (
          <p data-testid="divergence-truncated">
            Ahead/behind was measured for the first rows only. A dash below that line means{' '}
            <em>not measured</em>, which is not the same as zero.
          </p>
        )}
        {trunkMissing && (
          <p data-testid="trunk-missing">
            The trunk is <code className="font-mono">{view.trunk}</code>, which has no row here: it was
            resolved from git directly and fell outside this list&rsquo;s window.
          </p>
        )}
      </div>
    </>
  );
}
