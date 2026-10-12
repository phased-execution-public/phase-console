/**
 * Branches — every local branch, what claims it and how far it has run (7.0,
 * quiet-console phase 17).
 *
 * The parallel-execution story told from the repository's side: a branch a
 * dead console left behind is a row here exactly like a live one. Two claims
 * look alike in a list and are never flattened into one:
 *
 * - **the run is read from the NAME** — `pe/<slug>-p<N>` is a convention a
 *   person can type, so it is a reading, never evidence;
 * - **held by is the checkout registry** — a tree standing on the branch is a
 *   fact git printed, and what makes a branch unsafe to delete.
 *
 * And the two absent-number rules: ahead and behind are absent when there is
 * nothing to measure against — the dash, never 0 — and a capped divergence
 * pass leaves rows that were never measured, which is said under the list.
 */

import { useMemo, useState } from 'react';
import type { RepoBranch } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useRepoBranches } from '@/data/repo';
import { plural } from '@/lib/format';
import { useInspected } from '@/shell/panel/inspector-host';
import type { Route } from '@/shell/routes';
import { Button, Empty, Mono, RelativeTime, useEverything } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { Toolbar } from '@/ui/toolbar';
import { branchKey, inspectBranch, useAddressed, type BranchSubject } from './inspector';
import { NOT_MEASURED, divergenceWords, runWords } from './model';
import { PanelChoices, ReadError, RowsLoading, TargetPanel, reopens, targetLabel, useTargets } from './parts';
import { repoSectionHref, repoTargetOf, type RepoSectionId } from './routes';

/* ---------------- the columns ---------------- */

/** Which branches the list keeps. */
type BranchShow = 'all' | 'runs' | 'held' | 'free';

const SHOWS: readonly { id: BranchShow; label: string; blurb: string }[] = [
  { id: 'all', label: 'Every branch', blurb: 'As git lists them, the most recently committed first.' },
  { id: 'runs', label: 'Run branches', blurb: 'Whose name reads as a run or a lane.' },
  { id: 'held', label: 'Held by a tree', blurb: 'A working tree stands on it: not safe to delete.' },
  { id: 'free', label: 'Free', blurb: 'No working tree stands on it.' },
];

type BranchOrder = 'recent' | 'name' | 'ahead';

const ORDERS: readonly { id: BranchOrder; label: string }[] = [
  { id: 'recent', label: 'Last commit' },
  { id: 'name', label: 'Name' },
  { id: 'ahead', label: 'Most ahead' },
];

const keeps = (show: BranchShow, b: RepoBranch): boolean =>
  show === 'runs'
    ? b.run !== undefined
    : show === 'held'
      ? Boolean(b.heldBy?.length)
      : show === 'free'
        ? !b.heldBy?.length
        : true;

function ordered(rows: readonly RepoBranch[], order: BranchOrder): RepoBranch[] {
  if (order === 'name') return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  // A branch never measured sorts after every measured one, never as 0.
  if (order === 'ahead') return [...rows].sort((a, b) => (b.ahead ?? -1) - (a.ahead ?? -1));
  return [...rows];
}

export const BRANCH_COLUMNS: readonly Column<RepoBranch>[] = [
  {
    id: 'name',
    head: 'Branch',
    identity: true,
    flex: true,
    card: 'title',
    min: 240,
    priority: 1,
    value: (b) => b.name,
    cell: (b) => (
      <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Mono value={b.name} className="min-w-0 wrap-anywhere text-body text-ink" />
          {b.current && <span className="text-meta text-ink-muted">Checked out</span>}
          {b.trunk && <span className="text-meta text-ink-muted">Trunk</span>}
        </span>
        {b.subject && (
          <span className="block min-w-0 truncate text-meta text-ink-muted" title={b.subject}>
            {b.subject}
          </span>
        )}
      </span>
    ),
  },
  {
    id: 'run',
    head: 'Run, from the name',
    min: 176,
    priority: 3,
    value: (b) => runWords(b.run),
    cell: (b) =>
      b.run ? (
        <span
          className="break-words text-meta text-ink"
          data-testid="branch-run"
          title="Read from the branch name, which a person can type: nothing here checked a run record."
        >
          {runWords(b.run)}
        </span>
      ) : (
        <span className="text-meta text-ink-faint">{NOT_MEASURED}</span>
      ),
  },
  {
    id: 'divergence',
    head: 'Divergence',
    min: 144,
    priority: 2,
    card: 'meta',
    value: (b) => divergenceWords(b),
    cell: (b) => <span className="tnum text-meta text-ink-muted">{divergenceWords(b)}</span>,
  },
  {
    id: 'held',
    head: 'Held by',
    min: 120,
    priority: 4,
    value: (b) => b.heldBy?.length ?? 0,
    cell: (b) =>
      b.heldBy?.length ? (
        <span className="text-meta text-ink-muted" data-testid="branch-held" title={b.heldBy.join('\n')}>
          {plural(b.heldBy.length, 'checkout')}
        </span>
      ) : (
        <span className="text-meta text-ink-faint">Free</span>
      ),
  },
  {
    id: 'at',
    head: 'Last commit',
    min: 128,
    priority: 2,
    card: 'meta',
    value: (b) => b.at,
    cell: (b) => <RelativeTime at={b.at} live={false} className="text-meta text-ink-muted" />,
  },
  {
    id: 'upstream',
    head: 'Upstream',
    min: 176,
    everything: true,
    value: (b) => b.upstream,
    cell: (b) =>
      b.upstream ? (
        <Mono value={b.upstream} />
      ) : (
        <span className="text-meta text-ink-faint">Not tracked</span>
      ),
  },
  {
    id: 'head',
    head: 'Head',
    min: 104,
    everything: true,
    value: (b) => b.short,
    cell: (b) => <Mono value={b.short || b.head.slice(0, 7)} title={b.head} />,
  },
  {
    id: 'author',
    head: 'Author',
    min: 144,
    everything: true,
    value: (b) => b.author,
    cell: (b) => <span className="break-words text-meta text-ink-muted">{b.author ?? NOT_MEASURED}</span>,
  },
];

/* ---------------- the section ---------------- */

export default function BranchesSection({ route }: { route: Route }) {
  const repo = repoTargetOf(route.query);
  const openName = route.query.branch || undefined;
  const { data: state } = useConsoleState();
  const home = state?.home;
  const { data, isPending, error, refetch } = useRepoBranches(repo);
  const targets = useTargets();
  const everything = useEverything('repo-branches');
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<BranchShow>('all');
  const [order, setOrder] = useState<BranchOrder>('recent');
  const section: RepoSectionId = 'branches';

  const trunk = data?.trunk;
  const all = data?.branches;
  const open = useMemo(() => (openName ? all?.find((b) => b.name === openName) : undefined), [all, openName]);
  const subject = useMemo<BranchSubject | undefined>(
    () => (open ? { branch: open, repo, trunk, home } : undefined),
    [open, repo, trunk, home],
  );
  useAddressed(open ? branchKey(repo, open.name) : undefined, subject, inspectBranch);
  const inspected = useInspected()?.key;

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const kept = (all ?? []).filter(
      (b) =>
        keeps(show, b) &&
        (!q ||
          b.name.toLowerCase().includes(q) ||
          (b.subject ?? '').toLowerCase().includes(q) ||
          (runWords(b.run) ?? '').toLowerCase().includes(q)),
    );
    return ordered(kept, order);
  }, [all, show, q, order]);
  const narrowed = Boolean(q) || show !== 'all';
  const clear = () => {
    setQuery('');
    setShow('all');
  };

  const toolbar = (
    <Toolbar
      label="Branches"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find a branch',
        label: 'Find a branch by name, subject or run',
      }}
      filter={{
        active: (repo ? 1 : 0) + (show === 'all' ? 0 : 1),
        ...(show !== 'all' ? { value: SHOWS.find((s) => s.id === show)?.label ?? show } : {}),
        panel: (
          <div className="flex min-w-0 flex-col gap-4">
            {targets.length > 1 && <TargetPanel section={section} current={repo} targets={targets} />}
            <PanelChoices
              name="Which branches"
              value={show}
              options={SHOWS}
              onChange={setShow}
              testId="branches-show"
            />
          </div>
        ),
      }}
      sort={{
        value: ORDERS.find((o) => o.id === order)?.label ?? order,
        panel: <PanelChoices name="Order the branches" value={order} options={ORDERS} onChange={setOrder} />,
      }}
      everything={everything}
      note={
        data ? (
          <>
            {repo && <span>In {targetLabel(targets, repo)}.</span>}
            {narrowed && (
              <>
                <span className="tnum" aria-live="polite" data-testid="branches-filtered">
                  {rows.length} of {plural(data.branches.length, 'branch', 'branches')} shown.
                </span>
                <Button size="sm" variant="ghost" onClick={clear}>
                  Clear the filters
                </Button>
              </>
            )}
          </>
        ) : undefined
      }
    />
  );

  if (isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <RowsLoading label="Reading the branches" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <ReadError error={error} retry={() => void refetch()} />
      </div>
    );
  }
  if (!data) return null;

  // The trunk is asked of git directly, so a repository with more branches
  // than the list's cap can name a trunk whose row fell outside the window.
  const trunkMissing = Boolean(trunk) && !data.branches.some((b) => b.name === trunk);
  const hrefOf = (b: RepoBranch) => repoSectionHref(section, { repo, branch: b.name });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {toolbar}
      <Grid
        label="Branches"
        columns={BRANCH_COLUMNS}
        rows={rows}
        getRowKey={(b) => b.name}
        rowHref={hrefOf}
        rowProps={(b) => ({
          'data-testid': 'branch-row',
          'data-name': b.name,
          ...(inspected === branchKey(repo, b.name) ? { 'aria-current': 'true' } : {}),
          ...reopens(hrefOf(b), () => inspectBranch({ branch: b, repo, trunk, home })),
        })}
        rowClassName={(b) => (inspected === branchKey(repo, b.name) ? 'bg-surface-raised' : undefined)}
        toolbar={false}
        everything={everything}
        tableId="repo-branches"
        empty={
          data.branches.length ? (
            <Empty
              title="No branch matches the filters."
              action={
                <Button size="sm" onClick={clear}>
                  Clear the filters
                </Button>
              }
            />
          ) : (
            <Empty title="No branches here: a fresh clone that has not checked one out, or one that only ever ran detached." />
          )
        }
      />
      {(data.truncated || data.divergenceTruncated || trunkMissing) && (
        <div className="flex min-w-0 max-w-(--measure) flex-col gap-1 text-meta text-ink-muted">
          {data.truncated && (
            <p data-testid="branches-truncated">
              More branches exist than this list holds. What is shown is the most recently committed.
            </p>
          )}
          {data.divergenceTruncated && (
            <p data-testid="divergence-truncated">
              Ahead and behind were measured for the first rows only: a dash means not measured, which is not
              zero.
            </p>
          )}
          {trunkMissing && (
            <p data-testid="trunk-missing">
              The trunk is <code className="font-mono">{trunk}</code>, which has no row here: git named it,
              and it fell outside this list&rsquo;s window.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
