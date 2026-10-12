/**
 * History — the commit graph, its walk, and a commit in the panel (7.0,
 * quiet-console phase 17).
 *
 * ```
 * [Find a commit…]  Filter                                        Everything
 * Walking main and 3 run branches.
 * │ ●  Settle the lane on the trunk          pe/quiet-console   2 hours ago   1f44624
 * ●─╯  The grid, the toolbar, Everything                        5 hours ago   49a9627
 * ```
 *
 * The walk is the server's: the trunk and the run branches by default,
 * `?all=1` every branch, `?ref=` one branch alone — the Filter slot offers all
 * three and the repository. Two truncations are told apart and both drawn:
 * `truncated` means older commits exist past this page, `tipsTruncated` that
 * the walk does not cover every branch it should — a graph missing branches
 * read as whole is worse than a short one. A search keeps the matching
 * commits and draws each as its dot alone: a line between two rows that are
 * no longer neighbours would say something false.
 */

import { useMemo, useState } from 'react';
import { useRepoGraph } from '@/data/repo';
import { plural } from '@/lib/format';
import { useInspected } from '@/shell/panel/inspector-host';
import { navigate, type Route } from '@/shell/routes';
import { Banner, Button, Empty, useEverything } from '@/ui';
import { useTableFit } from '@/ui/grid/layout';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Table, TableWrap, TBody, TH, THead, TR, stickyHeadCell } from '@/ui/table';
import { Toolbar } from '@/ui/toolbar';
import {
  CommitRow,
  GRAPH_LIMIT_MAX,
  GRAPH_TRACK,
  graphColumns,
  graphMinWidth,
  graphRows,
  gutterTrack,
  type GraphColumnId,
} from './graph';
import { commitKey, inspectCommit, useAddressed, type CommitSubject } from './inspector';
import type { GraphRow } from './lanes';
import { ReadError, RowsLoading, TargetPanel, statusOf, targetLabel, useTargets } from './parts';
import { repoSectionHref, repoTargetOf } from './routes';

/** One page of history — the server's own default; Show more asks for another. */
const PAGE = 120;

const HEADS: Readonly<Record<GraphColumnId, string>> = {
  refs: 'Refs',
  author: 'Author',
  at: 'When',
  commit: 'Commit',
};

/** A commit a search names: its subject, its author, its sha or a ref it carries. */
function matches(row: GraphRow, q: string): boolean {
  const { commit } = row;
  return (
    commit.subject.toLowerCase().includes(q) ||
    commit.author.toLowerCase().includes(q) ||
    commit.sha.startsWith(q) ||
    commit.refs.some((ref) => ref.toLowerCase().includes(q))
  );
}

type Walk = 'default' | 'all' | `ref:${string}`;

/** The walk as a choice, and its panel: the default pair, every branch, or one branch alone. */
function WalkPanel({ repo, walk, tips }: { repo: string | undefined; walk: Walk; tips: readonly string[] }) {
  const alone = [...new Set([...(walk.startsWith('ref:') ? [walk.slice(4)] : []), ...tips.slice(0, 8)])];
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-meta text-ink-muted">Walk</legend>
      <RadioGroup
        aria-label="Which branches to walk"
        value={walk}
        data-testid="graph-walk"
        onValueChange={(next) =>
          navigate(
            repoSectionHref('history', {
              repo,
              all: next === 'all' ? 1 : undefined,
              ref: next.startsWith('ref:') ? next.slice(4) : undefined,
            }),
          )
        }
      >
        <RadioItem
          id="walk-default"
          value="default"
          label="The trunk and the run branches"
          description="Where the console's work is."
        />
        <RadioItem
          id="walk-all"
          value="all"
          label="Every branch"
          description="Every local branch, to the server's cap."
        />
        {alone.map((tip) => (
          <RadioItem key={tip} id={`walk-${tip}`} value={`ref:${tip}`} label={`Only ${tip}`} />
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/** What this walk covers, in words — the line under the toolbar. */
function walkWords(
  walk: Walk,
  tips: readonly string[],
  trunk: string | undefined,
  where: string | undefined,
) {
  const inWhere = where ? ` in ${where}` : '';
  if (walk.startsWith('ref:')) return `Walking ${walk.slice(4)} alone${inWhere}.`;
  if (walk === 'all') return `Walking every branch${inWhere}: ${plural(tips.length, 'tip')}.`;
  const runs = tips.filter((tip) => tip !== trunk).length;
  const lead = trunk ?? 'the trunk';
  return runs
    ? `Walking ${lead} and ${plural(runs, 'run branch', 'run branches')}${inWhere}.`
    : `Walking ${lead}${inWhere}.`;
}

export default function HistorySection({ route }: { route: Route }) {
  const repo = repoTargetOf(route.query);
  const ref = route.query.ref || undefined;
  const all = route.query.all === '1';
  const openSha = route.query.commit || undefined;
  const walk: Walk = ref ? `ref:${ref}` : all ? 'all' : 'default';

  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState('');
  const everything = useEverything('repo-history');
  const targets = useTargets();
  const fit = useTableFit();

  const params = useMemo(
    () => ({
      ...(repo ? { repo } : {}),
      ...(ref ? { ref: [ref] } : {}),
      ...(all ? { all: true } : {}),
      limit,
    }),
    [repo, ref, all, limit],
  );
  const { data, isPending, error, refetch } = useRepoGraph(params);
  const graph = useMemo(() => graphRows(data), [data]);
  const trunk = data?.trunk;

  const open = useMemo(
    () =>
      openSha ? graph.rows.find((r) => r.commit.sha === openSha || r.commit.short === openSha) : undefined,
    [graph, openSha],
  );
  const subject = useMemo<CommitSubject | undefined>(
    () => (open ? { row: open, repo, ref, all, trunk } : undefined),
    [open, repo, ref, all, trunk],
  );
  useAddressed(open ? commitKey(open.commit.sha) : undefined, subject, inspectCommit);
  const inspected = useInspected()?.key;

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? graph.rows.filter((row) => matches(row, q)) : graph.rows), [graph, q]);
  const columns = graphColumns(fit.measured ? fit.width : undefined, everything.on, graph.lanes);
  // The heads start where their cells do, as the grid's; and not measured yet
  // is not "it fits": the wrapper scrolls and sticky stands down.
  const head = fit.overflows || !fit.measured ? 'text-start' : `text-start ${stickyHeadCell}`;
  const where = repo ? targetLabel(targets, repo) : undefined;

  const toolbar = (
    <Toolbar
      label="History"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find a commit',
        label: 'Find a commit by subject, author, sha or ref',
      }}
      filter={{
        active: (repo ? 1 : 0) + (walk === 'default' ? 0 : 1),
        panel: (
          <div className="flex min-w-0 flex-col gap-4">
            {targets.length > 1 && <TargetPanel section="history" current={repo} targets={targets} />}
            <WalkPanel repo={repo} walk={walk} tips={data?.tips ?? []} />
          </div>
        ),
      }}
      everything={everything}
      note={
        data ? (
          <>
            <span data-testid="graph-walk-words">{walkWords(walk, data.tips, trunk, where)}</span>
            {q && (
              <>
                <span className="tnum" aria-live="polite">
                  {shown.length} of {plural(graph.rows.length, 'commit')} match.
                </span>
                <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
                  Clear the search
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
        <RowsLoading label="Reading the history" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <ReadError error={error} retry={() => void refetch()}>
          {/* Only a 400 is the walk refusing its ref; a 404 is an unknown
              repository, where "the branch is fine" would answer a question
              nobody asked. */}
          {ref && statusOf(error) === 400 && (
            <p className="text-body text-ink-muted" data-testid="ref-walk-hint">
              That was a walk of <code className="font-mono text-meta">{ref}</code> alone. A branch whose name
              is ambiguous with a tag, or holds <code className="font-mono text-meta">%</code>,{' '}
              <code className="font-mono text-meta">(</code> or <code className="font-mono text-meta">)</code>
              , is listed under Branches but is not a name this walk accepts: the branch is fine, the request
              is not.{' '}
              <a
                className="tap-line whitespace-nowrap text-ink underline underline-offset-2"
                href={repoSectionHref('history', { repo })}
              >
                Walk every branch instead
              </a>
            </p>
          )}
        </ReadError>
      </div>
    );
  }
  if (!data) return null;

  if (graph.rows.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <Empty
          title={
            ref
              ? 'This walk has no commits: the branch points at nothing it reached, or the repository is empty.'
              : 'This repository has no commits yet.'
          }
          action={
            ref ? (
              <Button size="sm" asChild>
                <a href={repoSectionHref('history', { repo })}>Walk every branch</a>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const missing = Boolean(openSha) && !open;
  const minWidth = everything.on ? graphMinWidth(columns, graph.lanes) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {toolbar}

      {missing && (
        <Banner data-testid="commit-off-page">
          Commit <code className="font-mono text-meta">{openSha}</code> is not in this walk. It may be further
          back than this page reaches, or on a branch this walk does not cover: show more, or walk that branch
          by name.
        </Banner>
      )}
      {data.tipsTruncated && (
        <Banner severity="warn" data-testid="tips-truncated">
          This walk does not cover every branch it should: there are more refs than its cap. What is drawn is
          real; read it as a sample of the repository, not the whole of it.
        </Banner>
      )}
      {graph.lanesClipped && (
        <Banner data-testid="lanes-clipped">
          {graph.laneCount} lanes were packed and the gutter draws the first {graph.lanes}. Every commit still
          has its row; the lines past the cut are not drawn.
        </Banner>
      )}

      {shown.length === 0 ? (
        <Empty
          title={`No commit in this walk matches “${query.trim()}”.`}
          action={
            <Button size="sm" onClick={() => setQuery('')}>
              Clear the search
            </Button>
          }
        />
      ) : (
        <TableWrap ref={fit.wrapRef} scrolls={fit.overflows || !fit.measured}>
          {/* hand-rolled because: the lane gutter is one drawing across row
              boundaries, not a cell. Every row must be exactly ROW_H tall for
              the lines to join, and the grid composes the identity cell with a
              fold control and opens a detail row between two commits; its
              phone records would drop the gutter, which is the graph. The
              declared tracks under `fixed` layout and the measured fit are the
              grid's own, taken by hand. */}
          <Table
            ref={fit.tableRef}
            fixed
            aria-label="Commit history"
            style={minWidth ? { minWidth } : undefined}
            data-testid="commit-graph"
          >
            <THead>
              <TR>
                <TH className={head} style={{ width: gutterTrack(graph.lanes) }}>
                  <span className="sr-only">Lanes</span>
                </TH>
                <TH className={head}>Subject</TH>
                {columns.map((id) => (
                  <TH key={id} className={head} style={{ width: GRAPH_TRACK[id] }}>
                    {HEADS[id]}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {shown.map((row, i) => (
                <CommitRow
                  key={row.commit.sha}
                  row={row}
                  incoming={i === 0 || q ? [] : (shown[i - 1]?.links ?? [])}
                  lanes={graph.lanes}
                  columns={columns}
                  {...(trunk !== undefined ? { trunk } : {})}
                  href={repoSectionHref('history', {
                    repo,
                    ref,
                    all: all ? 1 : undefined,
                    commit: row.commit.sha,
                  })}
                  active={inspected === commitKey(row.commit.sha)}
                  bare={Boolean(q)}
                  onOpen={() => inspectCommit({ row, repo, ref, all, trunk })}
                />
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      {data.truncated && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted"
          data-testid="graph-more"
        >
          {limit < GRAPH_LIMIT_MAX && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit((n) => Math.min(n + PAGE, GRAPH_LIMIT_MAX))}
            >
              Show more
            </Button>
          )}
          <span className="min-w-0">
            {plural(graph.rows.length, 'commit')} shown: the walk stopped at its limit, not at the end of
            history.
            {limit >= GRAPH_LIMIT_MAX
              ? ' That limit is the server’s own ceiling: walk one branch to see further back along it.'
              : ''}
          </span>
        </div>
      )}
    </div>
  );
}
