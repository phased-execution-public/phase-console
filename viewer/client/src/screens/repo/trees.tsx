/**
 * Working trees — where the console's parallel work physically is, and what
 * is left over from work that ended (7.0, quiet-console phase 17).
 *
 * The row this surface exists for is **debris**: a tree under the console's
 * own state directory that no surviving run record claims. Attribution is
 * the whole point and it never folds away: a `record` row is the console's
 * written evidence (it names the run, its status, whether it lives), a
 * `by name` row is a guess from a directory or branch name that anybody could
 * have written — the two rows a person chooses between before reclaiming.
 *
 * Nothing here deletes anything. This place reads; pruning is somebody's
 * deliberate act elsewhere, and a reading surface that grew a delete button
 * would be the one place where reading and destroying share a screen.
 *
 * One registry, one object database: the list spans every repository, so
 * `?repo=` is carried through links and never narrows it — the Repository
 * column (drawn once more than one answered) and the filter do.
 */

import { useMemo, useState } from 'react';
import { CHECKOUT_ROLES } from '@shared/worktree-model.js';
import type { CheckoutRole, RepoCheckout } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useRepoCheckouts } from '@/data/repo';
import { plural } from '@/lib/format';
import { useInspected } from '@/shell/panel/inspector-host';
import type { Route } from '@/shell/routes';
import { Button, Empty, Mono, useEverything } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus } from '@/ui/status';
import { Toolbar } from '@/ui/toolbar';
import { inspectTree, treeKey, useAddressed, type TreeSubject } from './inspector';
import { ROLE_BLURB, attributionSentence, attributionWord, runWords, treeName } from './model';
import { PanelChoices, PathWords, ReadError, RowsLoading, reopens } from './parts';
import { repoSectionHref, repoTargetOf } from './routes';

/**
 * The role words in the order a reclaim reads them — what asks to be read
 * first, first. A rank over the owner's roles rather than a second list of
 * them (`vocab-owners.test.ts`): the compiler holds the record total, so a
 * seventh role is a type error here instead of a word the filter never offers.
 */
const RECLAIM_RANK: Readonly<Record<CheckoutRole, number>> = {
  debris: 0,
  lane: 1,
  run: 2,
  staging: 3,
  operator: 4,
  root: 5,
};
const ROLE_ORDER: readonly CheckoutRole[] = [...CHECKOUT_ROLES].sort(
  (a, b) => RECLAIM_RANK[a] - RECLAIM_RANK[b],
);

type Attribution = ReturnType<typeof attributionWord>;
const ATTRIBUTIONS: readonly { id: Attribution | 'any'; label: string; blurb: string }[] = [
  { id: 'any', label: 'However attributed', blurb: 'Every tree, whatever claims it.' },
  {
    id: 'record',
    label: 'By a run record',
    blurb: 'Written evidence: the run, its status, whether it lives.',
  },
  { id: 'by name', label: 'By name only', blurb: 'A guess from a directory or branch name.' },
  { id: 'unattributed', label: 'Unattributed', blurb: 'Nothing claims it.' },
];

/** The trees' columns — the Repository column only when the registry spans more than one. */
export function treeColumns(home: string | undefined, showRepo: boolean): Column<RepoCheckout>[] {
  const columns: Column<RepoCheckout>[] = [
    {
      id: 'dir',
      head: 'Directory',
      identity: true,
      flex: true,
      card: 'title',
      min: 240,
      priority: 1,
      value: (c) => treeName(c, home),
      cell: (c) => <PathWords path={treeName(c, home)} title={c.dir} className="text-body text-ink" />,
    },
  ];
  if (showRepo) {
    columns.push({
      id: 'repo',
      head: 'Repository',
      // `phased-execution` whole, in mono: a submodule key broken mid-word reads as two.
      min: 176,
      priority: 3,
      value: (c) => c.repo,
      cell: (c) => (
        <Mono
          value={c.repo}
          title={c.repo === 'root' ? 'The repository root' : `Submodule ${c.repo}`}
          data-testid="checkout-repo"
          className="wrap-anywhere"
        />
      ),
    });
  }
  columns.push(
    {
      id: 'role',
      head: 'Role',
      min: 128,
      priority: 1,
      card: 'meta',
      value: (c) => c.role,
      cell: (c) => <OpsStatus vocab="checkout-role" word={c.role} title={ROLE_BLURB[c.role]} />,
    },
    {
      id: 'via',
      head: 'Attributed',
      // The evidence column: what a person reads before reclaiming anything.
      min: 120,
      priority: 1,
      card: 'meta',
      value: (c) => attributionWord(c),
      cell: (c) => (
        <span
          data-testid="via"
          data-via={c.via ?? 'none'}
          title={attributionSentence(c)}
          className={
            attributionWord(c) === 'unattributed' ? 'text-meta text-ink-faint' : 'text-meta text-ink'
          }
        >
          {attributionWord(c)}
        </span>
      ),
    },
    {
      id: 'branch',
      head: 'Branch',
      min: 176,
      priority: 3,
      value: (c) => c.branch ?? c.detached,
      cell: (c) =>
        c.branch ? (
          <Mono value={c.branch} className="wrap-anywhere" />
        ) : c.detached ? (
          <Mono
            value={c.detached}
            className="wrap-anywhere text-ink-faint"
            title={`${c.detached}: this tree stands on no branch, so it names where it stands, as its lock does.`}
          />
        ) : (
          <span className="text-meta text-ink-faint">—</span>
        ),
    },
    {
      id: 'state',
      head: 'State',
      min: 176,
      priority: 2,
      value: (c) =>
        [
          c.via === 'record' ? (c.run.live ? 'live' : 'ended') : '',
          c.prunable ? 'prunable' : '',
          c.managed ? 'managed' : '',
        ]
          .filter(Boolean)
          .join(' '),
      cell: (c) => (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {c.via === 'record' && (
            <OpsStatus
              vocab="presence"
              word={c.run.live ? 'live' : 'ended'}
              title={c.run.live ? 'A runner is driving this checkout now.' : 'The run has stopped.'}
            />
          )}
          {c.prunable && (
            <span
              className="text-meta text-ink"
              title="git still lists this checkout and its directory is gone."
            >
              Prunable
            </span>
          )}
          {c.managed && (
            <span
              className="text-meta text-ink-muted"
              title="Under the console's own state directory: something it created."
            >
              Managed
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'run',
      head: 'Run',
      min: 200,
      everything: true,
      value: (c) => (c.run ? runWords(c.run) : undefined),
      cell: (c) =>
        c.via === 'record' ? (
          <span className="flex min-w-0 flex-col">
            <span className="break-words text-meta text-ink">{runWords(c.run)}</span>
            <Mono value={c.run.runId} />
          </span>
        ) : c.via === 'branch' ? (
          <span className="break-words text-meta text-ink-muted">{runWords(c.run)}, from the name</span>
        ) : (
          <span className="text-meta text-ink-faint">—</span>
        ),
    },
  );
  return columns;
}

export default function TreesSection({ route }: { route: Route }) {
  const repo = repoTargetOf(route.query);
  const openDir = route.query.tree || undefined;
  const { data: state } = useConsoleState();
  const home = state?.home;
  const { data, isPending, error, refetch } = useRepoCheckouts();
  const everything = useEverything('repo-trees');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<CheckoutRole | 'any'>('any');
  const [attribution, setAttribution] = useState<Attribution | 'any'>('any');
  const [inRepo, setInRepo] = useState<string>('any');

  const all = data?.checkouts;
  const open = useMemo(() => (openDir ? all?.find((c) => c.dir === openDir) : undefined), [all, openDir]);
  const subject = useMemo<TreeSubject | undefined>(
    () => (open ? { checkout: open, repo, home } : undefined),
    [open, repo, home],
  );
  useAddressed(open ? treeKey(open.dir) : undefined, subject, inspectTree);
  const inspected = useInspected()?.key;

  const repos = useMemo(() => [...new Set((all ?? []).map((c) => c.repo))], [all]);
  const showRepo = repos.length > 1;
  const columns = useMemo(() => treeColumns(home, showRepo), [home, showRepo]);
  const roles = useMemo(() => {
    const counts = new Map<CheckoutRole, number>();
    for (const c of all ?? []) counts.set(c.role, (counts.get(c.role) ?? 0) + 1);
    return ROLE_ORDER.filter((r) => counts.has(r) || r === role).map((r) => ({
      id: r,
      label: `${r === 'operator' ? 'By hand' : r[0]!.toUpperCase() + r.slice(1)} ${counts.get(r) ?? 0}`,
      blurb: ROLE_BLURB[r],
    }));
  }, [all, role]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (all ?? []).filter(
        (c) =>
          (role === 'any' || c.role === role) &&
          (attribution === 'any' || attributionWord(c) === attribution) &&
          (inRepo === 'any' || c.repo === inRepo) &&
          (!q ||
            c.dir.toLowerCase().includes(q) ||
            (c.branch ?? '').toLowerCase().includes(q) ||
            (c.run ? (runWords(c.run) ?? '') : '').toLowerCase().includes(q)),
      ),
    [all, role, attribution, inRepo, q],
  );
  const narrowed = Boolean(q) || role !== 'any' || attribution !== 'any' || inRepo !== 'any';
  const clear = () => {
    setQuery('');
    setRole('any');
    setAttribution('any');
    setInRepo('any');
  };

  const toolbar = (
    <Toolbar
      label="Working trees"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find a tree',
        label: 'Find a working tree by directory, branch or run',
      }}
      filter={{
        active: (role === 'any' ? 0 : 1) + (attribution === 'any' ? 0 : 1) + (inRepo === 'any' ? 0 : 1),
        panel: (
          <div className="flex min-w-0 flex-col gap-4">
            <PanelChoices
              name="Role"
              value={role}
              options={[
                { id: 'any', label: `Every role ${all?.length ?? 0}`, blurb: 'Every tree git lists.' },
                ...roles,
              ]}
              onChange={setRole}
              testId="trees-role"
            />
            <PanelChoices
              name="Attribution"
              value={attribution}
              options={ATTRIBUTIONS}
              onChange={setAttribution}
            />
            {showRepo && (
              <PanelChoices
                name="Repository"
                value={inRepo}
                options={[
                  { id: 'any', label: 'Every repository' },
                  ...repos.map((r) => ({ id: r, label: r === 'root' ? 'The root' : r })),
                ]}
                onChange={setInRepo}
              />
            )}
          </div>
        ),
      }}
      everything={everything}
      note={
        narrowed && data ? (
          <>
            <span className="tnum" aria-live="polite">
              {rows.length} of {plural(data.checkouts.length, 'tree')} shown.
            </span>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear the filters
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <RowsLoading label="Reading the working trees" />
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

  const debris = data.checkouts.filter((c) => c.role === 'debris').length;
  const hrefOf = (c: RepoCheckout) => repoSectionHref('trees', { repo, tree: c.dir });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {toolbar}
      {debris > 0 && (
        <p className="max-w-(--measure) text-body text-ink-muted" data-testid="debris-note">
          {debris === 1 ? 'One tree is' : `${debris} trees are`} under this console&rsquo;s state directory
          with no surviving run record. Read Attributed before reclaiming any of them: a{' '}
          <span className="text-ink">by name</span> row is a guess from a name, and somebody may still be
          working in it.
        </p>
      )}
      <Grid
        label="Working trees"
        columns={columns}
        rows={rows}
        getRowKey={(c) => c.dir}
        rowHref={hrefOf}
        rowProps={(c) => ({
          'data-testid': 'checkout-row',
          'data-role': c.role,
          ...(inspected === treeKey(c.dir) ? { 'aria-current': 'true' } : {}),
          ...reopens(hrefOf(c), () => inspectTree({ checkout: c, repo, home })),
        })}
        rowClassName={(c) => (inspected === treeKey(c.dir) ? 'bg-surface-raised' : undefined)}
        toolbar={false}
        everything={everything}
        tableId="repo-trees"
        empty={
          data.checkouts.length ? (
            <Empty
              title="No tree matches the filters."
              action={
                <Button size="sm" onClick={clear}>
                  Clear the filters
                </Button>
              }
            />
          ) : (
            <Empty title="No working trees listed, not even the root: git could not be asked, rather than nothing being here." />
          )
        }
      />
    </div>
  );
}
