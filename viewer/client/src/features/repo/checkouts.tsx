/**
 * Working trees — where the console's parallel work physically is, and what is
 * left over from work that ended.
 *
 * This is the surface Phase 8's `treeClaims` join exists for, and the row it
 * exists for is **`debris`**: a tree under the console's own state directory
 * that no surviving run record claims. Before the join, `runGit` answered `null`
 * for a shared run, an unowned run and a refused one alike, so the moment a run
 * stopped every directory and branch it left behind became unattributable. A
 * reclaim decision needs the opposite of that.
 *
 * **`via` is the whole point of the table and it is rendered as such.** A row
 * attributed `record` is the console's own written evidence: it can name the run
 * id, the run's status and whether it is still live. A row attributed `branch`
 * is a GUESS from a directory or branch name, which an operator can write by
 * hand — an orphan a killed console left, or somebody's own `../repo-pe-<slug>`.
 * Those two look identical without the column, and they are the two rows a
 * person is choosing between when they decide what to delete.
 *
 * Nothing here deletes anything. This destination reads; `git worktree prune`
 * and the console's own reclaim verbs are somebody's deliberate act elsewhere,
 * and a browse surface that grew a delete button would be the one place in the
 * console where reading and destroying share a screen.
 */

import { useMemo } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Badge, Chip, DataTable, Empty } from '@/components/ui';
import type { BadgeTone, Column } from '@/components/ui';
import type { RepoCheckout, RepoCheckouts } from '@/lib/api';
import { homePath } from '@/lib/format';

/**
 * What each role IS, in one sentence, on the badge itself.
 *
 * `staging` and `debris` were once decided by a regex over the path shape and
 * came out exactly INVERTED — the one tree that must never be swept reported as
 * orphaned and a genuinely orphaned tree reported as the staging area (P8 QA
 * round 1, High). The role is decided by identity now; these sentences are what
 * a reader checks it against.
 */
export const ROLE_BLURB: Readonly<Record<RepoCheckout['role'], string>> = Object.freeze({
  root: 'The main working tree — the repository itself, not a linked checkout.',
  run: "A run's own checkout, holding that whole run's work.",
  lane: 'One phase of one run, in a checkout of its own so it can run beside its siblings.',
  staging: "Every plan's folded work waits here. This one is never swept.",
  operator: 'A linked checkout the console did not create.',
  debris: 'Under the console’s state directory, and no surviving run record claims it.',
});

const ROLE_TONE: Readonly<Record<RepoCheckout['role'], BadgeTone>> = Object.freeze({
  root: 'neutral',
  run: 'accent',
  lane: 'accent',
  staging: 'ok',
  operator: 'neutral',
  debris: 'wait',
});

/** The `via` column, and it is the evidence column — see the file lead. */
export function ViaChip({ checkout }: { checkout: RepoCheckout }) {
  if (checkout.via === 'record') {
    return (
      <Chip
        tone="ok"
        data-testid="via-chip"
        data-via="record"
        title={`The run record says so: ${checkout.run.slug}${
          checkout.run.phase === undefined ? '' : ` phase ${checkout.run.phase}`
        }, run ${checkout.run.runId}${checkout.run.status ? `, ${checkout.run.status}` : ''}.`}
      >
        record
      </Chip>
    );
  }
  if (checkout.via === 'branch') {
    return (
      <Chip
        tone="warn"
        data-testid="via-chip"
        data-via="branch"
        title="Read from the branch name alone. No record claims this tree — a killed console's orphan, or a checkout somebody made by hand. Not evidence."
      >
        by name
      </Chip>
    );
  }
  return (
    <span className="text-2xs text-ink-faint" data-testid="via-chip" data-via="none">
      unattributed
    </span>
  );
}

/** `live` exists only on a `record` row, and that asymmetry is the useful part. */
function liveness(checkout: RepoCheckout) {
  if (checkout.via !== 'record') return null;
  return checkout.run.live ? (
    <Badge tone="accent" title="A runner is driving this checkout right now.">
      live
    </Badge>
  ) : (
    <Badge
      tone="neutral"
      title={`The run has stopped${checkout.run.status ? ` (${checkout.run.status})` : ''}.`}
    >
      stopped
    </Badge>
  );
}

/**
 * The columns.
 *
 * The Repository column is built only when the registry spans more than one —
 * a column reading `root` on every row is noise in a single repository — and
 * that is why this is a function of `showRepo` rather than a constant array.
 *
 * `detached` used to have neither `truncate` nor a wrap: `detached@1f44624…` is
 * a code span, and a code span that can do neither is the shape that escapes its
 * declared track. It truncates now, with the full text on the title, exactly
 * like the branch beside it.
 */
function checkoutColumns(
  home: string | undefined,
  showRepo: boolean,
  onPick: (c: RepoCheckout) => void,
): Column<RepoCheckout>[] {
  const columns: Column<RepoCheckout>[] = [
    {
      id: 'dir',
      head: 'Directory',
      identity: true,
      flex: true,
      card: 'title',
      min: 240,
      priority: 1,
      cell: (checkout) => {
        const shown = homePath(checkout.dir, home) ?? checkout.dir;
        return (
          <button
            type="button"
            onClick={() => onPick(checkout)}
            // One 12px line was a ~17px tap target, and this button is the only
            // way into the working-tree inspector — where the reclaim decision
            // this whole surface exists for gets made.
            className="flex min-h-(--tap-min) w-full min-w-0 items-center text-left sm:min-h-0"
            aria-label={`Checkout ${shown}`}
          >
            {/* A path is a plain mono span with a title — `MonoId` truncates to
                eight characters, which is for shas. */}
            <span className="block min-w-0 truncate font-mono text-2xs text-ink" title={checkout.dir}>
              {shown}
            </span>
          </button>
        );
      },
    },
  ];
  if (showRepo) {
    columns.push({
      id: 'repo',
      head: 'Repository',
      priority: 3,
      min: 144,
      cellClassName: 'align-top',
      cell: (checkout) => (
        <code
          className="block min-w-0 truncate font-mono text-2xs text-ink-muted"
          title={checkout.repo === 'root' ? 'The repository root' : `Submodule ${checkout.repo}`}
          data-testid="checkout-repo"
        >
          {checkout.repo}
        </code>
      ),
    });
  }
  columns.push(
    {
      id: 'role',
      head: 'Role',
      priority: 1,
      min: 104,
      cellClassName: 'align-top',
      cell: (checkout) => (
        <Badge tone={ROLE_TONE[checkout.role]} title={ROLE_BLURB[checkout.role]}>
          {checkout.role}
        </Badge>
      ),
    },
    {
      id: 'via',
      head: 'Attributed',
      // The column the file's own header calls the whole point: it is what
      // separates written evidence from a guess at a name, and it is what a
      // person reads before reclaiming anything. It does not fold away.
      priority: 1,
      min: 120,
      cellClassName: 'align-top',
      cell: (checkout) => <ViaChip checkout={checkout} />,
    },
    {
      id: 'branch',
      head: 'Branch',
      priority: 3,
      min: 168,
      cellClassName: 'align-top',
      cell: (checkout) =>
        checkout.branch ? (
          <code className="block min-w-0 truncate font-mono text-2xs text-ink-muted" title={checkout.branch}>
            {checkout.branch}
          </code>
        ) : checkout.detached ? (
          <code
            className="block min-w-0 truncate font-mono text-2xs text-ink-faint"
            title={`${checkout.detached} — this tree stands on no branch, so it names where it stands, exactly as its lock does.`}
          >
            {checkout.detached}
          </code>
        ) : (
          <span className="text-2xs text-ink-faint">—</span>
        ),
    },
    {
      id: 'state',
      head: 'State',
      priority: 2,
      min: 152,
      cellClassName: 'align-top',
      cell: (checkout) => (
        <span className="flex flex-wrap items-center gap-1">
          {liveness(checkout)}
          {checkout.prunable && (
            <Badge tone="wait" title="git still lists this checkout and its directory is gone.">
              prunable
            </Badge>
          )}
          {checkout.managed && (
            <Badge tone="neutral" title="Under the console's own state directory — something it created.">
              managed
            </Badge>
          )}
        </span>
      ),
    },
  );
  return columns;
}

export function CheckoutTable({
  view,
  home,
  active,
  onPick,
}: {
  view: RepoCheckouts;
  home?: string;
  active?: string;
  onPick: (checkout: RepoCheckout) => void;
}) {
  // A superproject's registry spans its submodules; a single repository's does
  // not, and a column reading `root` on every row would be noise there.
  // Computed before the early return: a hook may not run conditionally.
  const showRepo = useMemo(() => new Set(view.checkouts.map((c) => c.repo)).size > 1, [view.checkouts]);
  const columns = useMemo(() => checkoutColumns(home, showRepo, onPick), [home, showRepo, onPick]);
  if (view.checkouts.length === 0) {
    return (
      <Empty
        icon={<FolderGit2 size={20} aria-hidden />}
        title="No working trees listed"
        body="Not even the root — which means git could not be asked, rather than that there is nothing here."
      />
    );
  }
  const debris = view.checkouts.filter((c) => c.role === 'debris');
  return (
    <>
      <DataTable
        label="Working trees"
        columns={columns}
        rows={view.checkouts}
        getRowKey={(c) => c.dir}
        rowProps={(c) => ({
          'data-testid': 'checkout-row',
          'data-role': c.role,
          ...(c.dir === active ? { 'aria-current': 'true' } : {}),
        })}
        rowClassName={(c) => (c.dir === active ? 'bg-surface-raised' : undefined)}
      />
      {debris.length > 0 && (
        <p className="mt-2 text-2xs text-ink-muted" data-testid="debris-note">
          {debris.length === 1 ? 'One tree is' : `${debris.length} trees are`} under this console&rsquo;s
          state directory with no surviving run record. Read the <em>Attributed</em> column before reclaiming
          any of them: a <code className="font-mono">by name</code> row is a guess from a directory name, and
          somebody may still be working in it.
        </p>
      )}
    </>
  );
}
