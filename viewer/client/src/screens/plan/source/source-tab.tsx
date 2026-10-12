/**
 * The plan as written — one file, read two ways (7.0, quiet-console phase 10).
 *
 * **Reading** is the file's own words in the order the file keeps them: where
 * it came from, its context and approach, the session budget, the decision
 * manifest as it holds, the phase graph exactly as the engine parsed it, the
 * end-to-end check. Then what the console knows beside the file — the plan's
 * memory entry and the claims held on its phases — and at the foot the
 * engine's own words (`EngineFold`).
 *
 * **Markdown** is the file byte for byte (`?view=raw`): what every reading is a
 * reading of, and the only place a malformed graph cell can be seen. The
 * reading is an ADDRESS, never component state: `#/plan/x/source?view=raw` is
 * in bookmarks and in handoff prose, and a link that opened on the prose would
 * keep working and lose what it meant. Flipping it replaces the address rather
 * than pushing one — a switch is not a place you go.
 *
 * One column: prose at the measure, tables at the width.
 */

import { DECISION_STATES } from '@shared/decisions-model.js';
import type { DecisionRowView, PhaseRow, PhaseView, PlanDetail } from '@/data/api';
import { usePlanRaw } from '@/data/plans';
import { hrefOf, navigate, phaseHref, planHref, planViewHref } from '@/shell/routes';
import { Button, ButtonGroup, Empty, Mono, SectionHeading, Skeleton } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { Markdown, MarkdownInline } from '@/ui/markdown';
import { OpsStatus, type WordOf } from '@/ui/status';
import { DepsCell, LockCell, LockWords } from '../phases/cells';
import type { SourceView } from '../tabs';
import { EngineFold } from './engine-fold';

/** The raw reading's address — the Source view with `?view=raw`. */
const rawHref = (slug: string): string => hrefOf(planHref(slug, 'source'), { view: 'raw' });

export function SourceTab({ detail, view, slug }: { detail: PlanDetail; view: SourceView; slug: string }) {
  const plan = detail.plan;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="source-view" data-reading={view}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Mono value={`docs/plans/${slug}.md`} className="min-w-0 wrap-anywhere" />
        <ReadingSwitch slug={slug} view={view} />
      </div>
      {view === 'raw' ? <RawSource slug={slug} /> : <Reading detail={detail} slug={slug} />}
      {plan && <EngineFold slug={slug} targetModel={plan.sessionBudget?.targetModel} />}
    </div>
  );
}

function ReadingSwitch({ slug, view }: { slug: string; view: SourceView }) {
  return (
    <ButtonGroup aria-label="Read the plan file as">
      <Button
        size="sm"
        aria-pressed={view === 'reading'}
        onClick={() => navigate(planHref(slug, 'source'), { replace: true })}
      >
        Reading
      </Button>
      <Button
        size="sm"
        aria-pressed={view === 'raw'}
        onClick={() => navigate(rawHref(slug), { replace: true })}
      >
        Markdown
      </Button>
    </ButtonGroup>
  );
}

/* ---------------- the bytes ---------------- */

/** The plan file exactly as it is on disk. */
function RawSource({ slug }: { slug: string }) {
  const { data, error, isPending, refetch } = usePlanRaw(slug);
  if (error) {
    return (
      <Empty
        title={error.message || 'The plan file could not be read, and the server said nothing.'}
        action={
          <Button size="sm" onClick={() => void refetch()}>
            Read it again
          </Button>
        }
      />
    );
  }
  if (isPending || data == null) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2" data-testid="source-raw">
      <CopyButton text={data} label="Copy markdown" />
      {/* Sideways it scrolls in its own box — a plan's lines are as long as
          their author wrote them, and `<main>` clips. On a wide desk it also
          stops at seven tenths of `--app-height` (never `vh`, which ignores the
          iOS keyboard), so the switch above stays in reach; below that the
          page's one scroller carries it, because a nested vertical scroller on
          a phone eats the page's flick. */}
      <pre className="m-0 w-full overflow-x-auto rounded-(--radius) bg-ground-deep p-3 font-mono text-meta leading-relaxed whitespace-pre lg:max-h-[calc(var(--app-height,100%)*0.7)] lg:overflow-y-auto lg:overscroll-contain">
        {data}
      </pre>
    </div>
  );
}

/* ---------------- the prose ---------------- */

/** One of the file's own sections, at the measure — absent when the file has none. */
function Prose({ title, text, testId }: { title: string; text: string | undefined; testId: string }) {
  if (!text) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <SectionHeading>{title}</SectionHeading>
      <div className="min-w-0 max-w-(--measure)">
        <Markdown text={text} />
      </div>
    </section>
  );
}

function Reading({ detail, slug }: { detail: PlanDetail; slug: string }) {
  const plan = detail.plan;
  if (!plan) {
    return (
      <Empty
        title="This slug has handoffs but no plan file, so there is no phase graph, budget or prose to read."
        action={
          <Button asChild size="sm">
            <a href={planViewHref(slug, 'handoffs')}>Read the handoffs</a>
          </Button>
        }
      />
    );
  }
  const decisions = plan.decisions ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {plan.provenance && (
        <div className="min-w-0 max-w-(--measure)" data-testid="source-provenance">
          <Markdown text={`> ${plan.provenance.replace(/\n/g, '\n> ')}`} />
        </div>
      )}
      <Prose title="Context" text={plan.context} testId="source-context" />
      <Prose title="Architecture" text={plan.architecture} testId="source-architecture" />
      <Prose title="Session budget" text={plan.sessionBudget?.raw} testId="source-budget" />
      {/* The `## Decisions` manifest as it HOLDS — the plan's rows with
          `decisions.md` merged over them, the same rows `--decisions` prints.
          Absent when the plan carries none: an older plan is not nagged here. */}
      {decisions.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2" data-testid="source-decisions">
          <SectionHeading count={decisions.length}>Decisions</SectionHeading>
          <Grid
            label="Decisions"
            columns={decisionColumns(decisions)}
            rows={decisions}
            getRowKey={(row) => `${row.key}@${row.phase ?? 'plan'}`}
            detail={(row) => <DecisionWords row={row} />}
          />
        </section>
      )}
      <section className="flex min-w-0 flex-col gap-2" data-testid="source-graph">
        <SectionHeading count={plan.graph?.length ?? 0}>Phase graph</SectionHeading>
        <p className="text-meta text-ink-muted">The table as the engine read it.</p>
        <Grid
          label="Phase graph"
          columns={graphColumns(slug, detail.phases)}
          rows={plan.graph ?? []}
          getRowKey={(row) => String(row.phase)}
          rowHref={(row) => phaseHref(slug, row.phase)}
          detail={(row) => <GraphRowWords row={row} />}
          // Headers over nothing is the one reading this table must never
          // have: no rows means `phase-graph.sh` could not parse the plan's own
          // table — a defect in the file, which only the markdown shows.
          empty={
            <Empty
              title="No machine-readable phase graph: the engine parsed no rows from this plan’s table."
              action={
                <Button asChild size="sm">
                  <a href={rawHref(slug)}>Read the markdown</a>
                </Button>
              }
            />
          }
        />
        {(plan.callouts?.length ?? 0) > 0 && (
          <div className="flex min-w-0 max-w-(--measure) flex-col gap-2" data-testid="source-callouts">
            {plan.callouts!.map((line, i) => (
              <Markdown key={i} text={line} />
            ))}
          </div>
        )}
      </section>
      <Prose title="End-to-end verification" text={plan.endToEnd} testId="source-end-to-end" />
      <Memory detail={detail} slug={slug} />
      {detail.locks.length > 0 && <Locks detail={detail} />}
    </div>
  );
}

/* ---------------- the phase graph ---------------- */

/**
 * The graph table's columns. The cells that print the plan's own words are cut
 * against their track and carry the whole value on hover AND in the row's
 * fold — a phone has no hover, and exit criteria is a sentence that, uncut,
 * set the height of every row in the table.
 */
function graphColumns(slug: string, phases: readonly PhaseView[]): Column<PhaseRow>[] {
  const viewOf = (phase: number) => phases.find((p) => p.phase === phase);
  return [
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 72,
      identity: true,
      value: (row) => row.phase,
      // The row's own link wraps this cell; an anchor inside it would be an
      // anchor inside an anchor.
      cell: (row) => <span className="tabular-nums">{row.phase}</span>,
    },
    {
      id: 'title',
      head: 'Title',
      priority: 1,
      min: 200,
      flex: true,
      card: 'title',
      value: (row) => row.title,
      cell: (row) => (
        <span className="text-ink">
          <MarkdownInline text={row.title} />
        </span>
      ),
    },
    {
      id: 'depends',
      head: 'Depends on',
      priority: 2,
      min: 140,
      // Joined in from the board: the graph is what the engine reads, and who
      // waits on a row is the one fact about it the plan file does not hold.
      cell: (row) => {
        const view = viewOf(row.phase);
        return view ? (
          <DepsCell slug={slug} phase={view} max={4} />
        ) : (
          <span className="text-meta tabular-nums">
            {row.dependsOn.length ? row.dependsOn.map((dep) => `P${dep}`).join(', ') : '—'}
          </span>
        );
      },
    },
    {
      id: 'lock',
      head: 'Lock',
      priority: 4,
      min: 132,
      cell: (row) => <LockCell lock={viewOf(row.phase)?.lock} />,
    },
    {
      id: 'parallel',
      head: 'Parallel-safe',
      priority: 4,
      min: 124,
      cell: (row) => (
        <span className="block truncate font-mono text-meta" title={row.parallelSafe}>
          {row.parallelSafe || '—'}
        </span>
      ),
    },
    {
      id: 'repos',
      head: 'Repos',
      priority: 3,
      min: 128,
      cell: (row) => (
        <span className="block truncate font-mono text-meta" title={row.repos}>
          {row.repos || '—'}
        </span>
      ),
    },
    {
      id: 'exit',
      head: 'Exit criteria',
      priority: 2,
      min: 200,
      cell: (row) => (
        <span className="line-clamp-2 text-meta" title={row.exitCriteria}>
          <MarkdownInline text={row.exitCriteria} />
        </span>
      ),
    },
  ];
}

/** A graph row's cut cells, whole — what opening the row shows. */
function GraphRowWords({ row }: { row: PhaseRow }) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {row.exitCriteria && (
        <>
          <dt className="text-meta text-ink-muted">Exit criteria, whole</dt>
          <dd className="min-w-0 max-w-(--measure) break-words text-body text-ink">
            <MarkdownInline text={row.exitCriteria} />
          </dd>
        </>
      )}
      {row.parallelSafe && (
        <>
          <dt className="text-meta text-ink-muted">Parallel-safe, as written</dt>
          <dd className="min-w-0 wrap-anywhere font-mono text-meta text-ink">{row.parallelSafe}</dd>
        </>
      )}
      {row.repos && (
        <>
          <dt className="text-meta text-ink-muted">Repos, as written</dt>
          <dd className="min-w-0 wrap-anywhere font-mono text-meta text-ink">{row.repos}</dd>
        </>
      )}
    </dl>
  );
}

/* ---------------- the decision manifest ---------------- */

const isDecisionState = (word: string): word is WordOf<'decision'> =>
  (DECISION_STATES as readonly string[]).includes(word);

function decisionColumns(rows: readonly DecisionRowView[]): Column<DecisionRowView>[] {
  return [
    {
      id: 'key',
      head: 'Key',
      priority: 1,
      min: 150,
      identity: true,
      card: 'title',
      value: (row) => row.key,
      cell: (row) => <span className="wrap-anywhere font-mono text-meta">{row.key}</span>,
    },
    {
      id: 'state',
      head: 'State',
      priority: 1,
      min: 120,
      card: 'meta',
      value: (row) => row.state,
      // A dot and a word for the closed vocabulary; a state the plan misspelt
      // (lint F25 already fails it) is the plan's own text, breakable, never
      // dressed as a word this console knows.
      cell: (row) =>
        isDecisionState(row.state) ? (
          <OpsStatus vocab="decision" word={row.state} />
        ) : (
          <span className="max-w-full wrap-anywhere whitespace-normal font-mono text-meta">
            {row.state || '—'}
          </span>
        ),
    },
    // A per-phase row answers for one phase only; the column appears only when
    // the manifest holds one.
    ...(rows.some((row) => row.phase != null)
      ? [
          {
            id: 'phase',
            head: 'Phase',
            priority: 2,
            min: 80,
            value: (row: DecisionRowView) => row.phase ?? '',
            cell: (row: DecisionRowView) => (
              <span className="text-meta tabular-nums">
                {row.phase != null ? `P${row.phase}` : 'Plan-wide'}
              </span>
            ),
          } satisfies Column<DecisionRowView>,
        ]
      : []),
    {
      id: 'owner',
      head: 'Owner',
      priority: 3,
      min: 110,
      value: (row) => row.owner,
      cell: (row) => <span className="break-words text-meta">{row.owner || '—'}</span>,
    },
    {
      id: 'blocking',
      head: 'Blocking',
      priority: 3,
      min: 90,
      value: (row) => row.blocking,
      cell: (row) => <span className="text-meta">{row.blocking === 'yes' ? 'Yes' : 'No'}</span>,
    },
    {
      id: 'source',
      head: 'Source',
      priority: 2,
      min: 90,
      value: (row) => row.source,
      // Where the answer came from (`DECISION_SOURCES`): the plan's own row, a
      // run, a promoted ruling or the shipped default.
      cell: (row) => <span className="break-words text-meta">{row.source || '—'}</span>,
    },
    {
      id: 'value',
      head: 'Value',
      priority: 2,
      min: 220,
      flex: true,
      cell: (row) => (
        <span className="line-clamp-2 text-meta" title={row.value}>
          {row.value ? <MarkdownInline text={row.value} /> : '—'}
        </span>
      ),
    },
    {
      id: 'evidence',
      head: 'Evidence',
      priority: 3,
      min: 160,
      cell: (row) => (
        <span className="line-clamp-2 text-meta text-ink-muted" title={row.evidence}>
          {row.evidence ? <MarkdownInline text={row.evidence} /> : '—'}
        </span>
      ),
    },
  ];
}

/** A decision's cut cells, whole. */
function DecisionWords({ row }: { row: DecisionRowView }) {
  if (!row.value && !row.evidence) return null;
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {row.value && (
        <>
          <dt className="text-meta text-ink-muted">Value, whole</dt>
          <dd className="min-w-0 max-w-(--measure) break-words text-body text-ink">
            <MarkdownInline text={row.value} />
          </dd>
        </>
      )}
      {row.evidence && (
        <>
          <dt className="text-meta text-ink-muted">Evidence, whole</dt>
          <dd className="min-w-0 max-w-(--measure) break-words text-body text-ink">
            <MarkdownInline text={row.evidence} />
          </dd>
        </>
      )}
    </dl>
  );
}

/* ---------------- beside the file ---------------- */

/** The plan's entry in the Claude memory directories — only the Source view asks for it. */
function Memory({ detail, slug }: { detail: PlanDetail; slug: string }) {
  const memory = detail.memory;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="source-memory">
      <SectionHeading aside={memory ? <Mono value={memory.key} className="wrap-anywhere" /> : undefined}>
        Memory
      </SectionHeading>
      {memory ? (
        <div className="min-w-0 max-w-(--measure)">
          <Markdown text={memory.text} />
        </div>
      ) : (
        <p className="text-body text-ink-muted">
          No memory entry for <Mono value={slug} /> was found in the Claude memory directories.
        </p>
      )}
    </section>
  );
}

/** Who holds which phase right now, and for how much longer. */
function Locks({ detail }: { detail: PlanDetail }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="source-locks">
      <SectionHeading count={detail.locks.length}>Locks</SectionHeading>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {detail.locks.map((lock, i) => (
          <li
            key={lock.phase ?? `lock-${i}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
          >
            <span className="text-body text-ink tabular-nums">
              {lock.phase != null ? `Phase ${lock.phase}` : 'The plan'}
            </span>
            <LockWords lock={lock} />
          </li>
        ))}
      </ul>
    </section>
  );
}
