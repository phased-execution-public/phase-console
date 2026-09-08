/**
 * The History section — the commit graph, its walk controls, and a commit's L2.
 *
 * ## Two truncation flags, and they say different things
 *
 * `truncated` means *more commits exist below this page*. `tipsTruncated` means
 * *this walk does not cover every branch it should* — a different failure, with
 * a different remedy, and it can fire even on a walk that named its own refs
 * (the 300-tip cap still applies). Presenting a partial graph as complete is
 * worse than presenting a short one, so both are rendered and neither is folded
 * into the other.
 */

import { useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  KeyValue,
  PageError,
  Spinner,
  Table,
  TBody,
  TH,
  THead,
  TR,
  TableWrap,
  stickyHeadCell,
  useTableFit,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useRepoGraph } from '@/lib/queries';
import type { ApiError } from '@/lib/api';
import { GRAPH_LIMIT_MAX, GRAPH_SHOWN, GRAPH_TRACK } from './graph';
import { relativeTime } from '@/lib/format';
import { CommitRow, RefChip, graphRows } from './graph';
import { decorateRef } from './lanes';
import { repoHref } from './routes';
import { RepoInspector } from './inspector';

/** One page of history. The server's own default; the button asks for another. */
const PAGE = 120;

export default function GraphSection({ route }: { route: ViewProps['route'] }) {
  const repo = route.query.repo;
  const ref = route.query.ref;
  const all = route.query.all === '1';
  const openSha = route.query.commit;
  const [limit, setLimit] = useState(PAGE);
  // Above every early return below — a hook may not run conditionally.
  const { wrapRef, tableRef, overflows, measured } = useTableFit();
  // Sticky is the other half of `scrolls`, so it is the same decision.
  const headCell = !overflows && measured ? stickyHeadCell : undefined;

  const params = {
    ...(repo ? { repo } : {}),
    ...(ref ? { ref: [ref] } : {}),
    ...(all ? { all: true } : {}),
    limit,
  };
  const { data, isPending, error, refetch } = useRepoGraph(params);

  if (isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <PageError error={error} retry={() => void refetch()} />
        {ref && (error as ApiError | undefined)?.status === 400 && (
          // A named walk is the one request here that can be refused for a
          // reason the reader did not cause — and ONLY a 400 is that refusal.
          // A 404 is `unknown repository`, where "the branch is fine" would be
          // a confident answer to a question nobody asked. `/api/repo/branches` reports a
          // name through git's ambiguity-aware `%(refname:short)`, so a
          // repository holding both a branch and a tag called `1.0` lists the
          // branch as `heads/1.0` — and neither spelling is one the graph's
          // own validator accepts (P8 QA round 5, M1, handed forward). The
          // walk that always works is one click away, and saying so beats
          // leaving somebody to conclude their branch is gone.
          <p className="text-2xs text-ink-muted" data-testid="ref-walk-hint">
            That was a walk of <code className="font-mono">{ref}</code> alone. A branch whose name is
            ambiguous with a tag, or one containing <code className="font-mono">%</code>,{' '}
            <code className="font-mono">(</code> or <code className="font-mono">)</code>, is listed under
            Branches but is not a name this walk accepts — the branch is fine, the request is not.{' '}
            <a className="underline" href={repoHref('graph', { repo })}>
              Walk every branch instead
            </a>
            .
          </p>
        )}
      </div>
    );
  }
  if (!data) return null;

  const { rows, lanes, lanesClipped, laneCount } = graphRows(data);
  const open = openSha ? rows.find((r) => r.commit.sha === openSha || r.commit.short === openSha) : undefined;
  // A `?commit=` naming a sha this page does not hold — a link that outlived its
  // walk, or one of the parents the inspector itself offers, which are exactly
  // the commits most likely to be off the page. Opening nothing at all read as
  // a broken link.
  const missingCommit = Boolean(openSha) && !open;
  const close = () => navigate(repoHref('graph', { repo, ref, all: all ? 1 : undefined }), { replace: true });

  if (rows.length === 0) {
    return (
      <Empty
        icon={<GitCommitHorizontal size={20} aria-hidden />}
        title="No commits in this walk"
        body={
          ref
            ? 'That ref resolves here and has no history behind it — a branch pointing at a commit this walk did not reach, or an empty repository.'
            : 'This repository has no commits yet.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-ink-muted">
          {ref ? (
            <>
              Walking <code className="font-mono">{ref}</code> alone.{' '}
              <a className="underline" href={repoHref('graph', { repo })}>
                Every branch
              </a>
            </>
          ) : (
            <>
              {data.tips.length} tip{data.tips.length === 1 ? '' : 's'}
              {data.trunk ? (
                <>
                  {' '}
                  · trunk <code className="font-mono">{data.trunk}</code>
                </>
              ) : null}
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {data.tips.slice(0, 8).map((tip) => (
            <a key={tip} href={repoHref('graph', { repo, ref: tip })} title={`Walk ${tip} alone`}>
              <RefChip decorated={decorateRef(tip, data.trunk)} />
            </a>
          ))}
        </div>
      </div>

      {missingCommit && (
        <Banner severity="info" data-testid="commit-off-page">
          Commit <code className="font-mono">{openSha}</code> is not in this walk. It may be further back than
          this page reaches, or on a branch this walk does not cover — try Show more, or walk that branch by
          name.
        </Banner>
      )}
      {data.tipsTruncated && (
        <Banner severity="warn" data-testid="tips-truncated">
          This walk does not cover every branch it should — there are more refs than its cap. What is drawn is
          real; what is missing is not visible from here, so read this graph as a sample rather than the whole
          repository.
        </Banner>
      )}
      {lanesClipped && (
        <Banner severity="info" data-testid="lanes-clipped">
          {laneCount} lanes were packed and the gutter draws the first few. Every commit still has its row;
          the lines past the cut are not drawn.
        </Banner>
      )}

      <TableWrap ref={wrapRef} scrolls={overflows || !measured}>
        {/* hand-rolled because: the lane gutter is one continuous drawing across
            row boundaries, not a cell. Every row must be exactly `ROW_H` tall
            for the lines to join, and `DataTable` cannot promise that — it
            composes the identity cell with an expand button and a folded-column
            counter, and inserts a full-width detail row between two commits.
            Its `CardList` would drop the gutter altogether, which is the graph.
            What this table DOES take from the primitive is the part that
            mattered: a declared track per column (`GRAPH_TRACK`) under `fixed`
            layout, so `truncate` engages, and `useTableFit` deciding the
            wrapper and the sticky header together — which this table can now
            HAVE. It never had one, because it never fitted: 1822px of auto
            layout in a 746px box meant the wrapper always scrolled, and a
            sticky header inside an overflow-x wrapper sticks to nothing. With
            declared tracks it fits from 768 up, and a hundred and twenty
            commits keep their column names. */}
        <Table ref={tableRef} aria-label="Commit history" fixed>
          <THead>
            <TR>
              <TH className={headCell} style={{ width: GRAPH_TRACK.lanes(lanes) }}>
                <span className="sr-only">Lanes</span>
              </TH>
              <TH className={headCell}>Subject</TH>
              <TH className={cn(GRAPH_SHOWN.refs, headCell)} style={{ width: GRAPH_TRACK.refs }}>
                Refs
              </TH>
              <TH className={cn(GRAPH_SHOWN.author, headCell)} style={{ width: GRAPH_TRACK.author }}>
                Author
              </TH>
              <TH className={cn(GRAPH_SHOWN.at, headCell)} style={{ width: GRAPH_TRACK.at }}>
                When
              </TH>
              <TH className={headCell} style={{ width: GRAPH_TRACK.short }}>
                Commit
              </TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row, i) => (
              <CommitRow
                key={row.commit.sha}
                row={row}
                incoming={i === 0 ? [] : rows[i - 1].links}
                lanes={lanes}
                {...(data.trunk !== undefined ? { trunk: data.trunk } : {})}
                active={row.commit.sha === open?.commit.sha}
                onPick={(commit) =>
                  navigate(repoHref('graph', { repo, ref, all: all ? 1 : undefined, commit: commit.sha }))
                }
              />
            ))}
          </TBody>
        </Table>
      </TableWrap>

      {data.truncated && (
        <div className="flex items-center gap-2">
          {limit < GRAPH_LIMIT_MAX ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit((n) => Math.min(n + PAGE, GRAPH_LIMIT_MAX))}
            >
              Show more
            </Button>
          ) : null}
          <span className="text-2xs text-ink-faint">
            {rows.length} of more — this walk stops at its limit, it did not run out of history.
            {limit >= GRAPH_LIMIT_MAX
              ? ' That limit is the server’s own ceiling; walk one branch to see further back along it.'
              : ''}
          </span>
        </div>
      )}

      {open && (
        <RepoInspector
          open
          onClose={close}
          title={open.commit.short}
          description={open.commit.subject}
          meta={
            <>
              {open.commit.refs.map((r) => (
                <RefChip key={r} decorated={decorateRef(r, data.trunk)} />
              ))}
              {open.commit.parents.length > 1 && <Chip tone="neutral">merge</Chip>}
            </>
          }
          record={open.commit}
        >
          <Card>
            <CardHeader>
              <CardTitle>Commit</CardTitle>
            </CardHeader>
            <CardBody>
              <KeyValue
                items={[
                  ['sha', <code className="font-mono text-2xs break-all">{open.commit.sha}</code>],
                  ['author', open.commit.author],
                  [
                    'committed',
                    Number.isNaN(Date.parse(open.commit.at))
                      ? open.commit.at
                      : `${relativeTime(Date.parse(open.commit.at))} · ${new Date(open.commit.at).toLocaleString()}`,
                  ],
                  [
                    'parents',
                    open.commit.parents.length === 0 ? (
                      'none — a root commit'
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {open.commit.parents.map((p) => (
                          <a
                            key={p}
                            className="font-mono text-2xs underline"
                            href={repoHref('graph', { repo, ref, commit: p })}
                          >
                            {p.slice(0, 7)}
                          </a>
                        ))}
                      </span>
                    ),
                  ],
                  open.danglingParents.length > 0
                    ? [
                        'outside this walk',
                        // A parent the walk never reached is the window's edge,
                        // not the end of history — the row draws a dashed stub
                        // and this says why.
                        <span className="text-2xs text-ink-muted">
                          {open.danglingParents.map((p) => p.slice(0, 7)).join(', ')} — beyond this
                          walk&rsquo;s limit, not missing from the repository.
                        </span>,
                      ]
                    : null,
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(repoHref('diff', { repo, tip: open.commit.sha }))}
                >
                  What this commit changed
                </Button>
              </div>
            </CardBody>
          </Card>
        </RepoInspector>
      )}
    </div>
  );
}
