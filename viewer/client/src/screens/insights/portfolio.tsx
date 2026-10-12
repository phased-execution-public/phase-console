/**
 * What shape the work is in — what exists, and what is wrong with it.
 *
 * The census half of Insights: how the phases fall across states and sizes,
 * which plans are busiest, what is claimed, what the engine flagged, and which
 * plans have ready work nobody has touched. The trend, the money, the
 * estimate and the mix are their own questions; this one answers only "what
 * is the shape of the work, and is any of it broken".
 *
 * Every navigable thing is a link — a page whose purpose is "which of these
 * should I look at next" must open in a second tab — and every status is the
 * status model's word: a phase state's label and paint come from
 * `describeWord('board', …)`, a health issue's severity from the health
 * words, so a stuck phase reads here exactly as it does on its plan.
 */

import { useMemo, useState } from 'react';
import { BOARD_ORDER } from '@shared/phase-model.js';
import { describeWord } from '@shared/status-model.js';
import { RecoveryActions } from '@/cards/recovery-actions';
import type { HealthIssue, Portfolio, Sizing } from '@/data/api';
import { releaseRefusal, useLockRelease } from '@/data/plans';
import { countdown, plural, weight } from '@/lib/format';
import { classifyIssue } from '@/lib/recovery';
import { phaseHref, planHref, plansHref } from '@/shell/routes';
import { Button, ButtonGroup, Empty, Mono, SectionHeading } from '@/ui';
import { BarList, StackBar } from '@/ui/figures/lazy';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus } from '@/ui/status';
import { FigureBlock, InsightNote, PROSE_LINK } from './parts';

type Lock = Portfolio['activeLocks'][number];
type BoardWord = (typeof BOARD_ORDER)[number];
type Severity = 'all' | HealthIssue['severity'];

const SEVERITY_RANK: Readonly<Record<HealthIssue['severity'], number>> = { error: 0, warning: 1, info: 2 };

/**
 * A claim's state in a word. Three readings, not two: a lapsed lease on a
 * CLOSED plan is debris — `phase-lock.sh conflicts` skips it, so it blocks
 * nobody, and calling it expired would invent a chore. Still listed and still
 * releasable: this is the lock inventory.
 */
function lockWord(lock: Lock): { word: string; title: string } {
  if (lock.closed) {
    return {
      word: 'debris',
      title:
        'The plan is closed, so the lock is leftover debris: phase-lock.sh skips it and it blocks no session. Releasing it is tidying, not a fix.',
    };
  }
  if (lock.expired) {
    return {
      word: 'expired',
      title:
        'The lease ran out and nobody renewed it; the session is gone. Safe to release, and a takeover recovery may claim the phase.',
    };
  }
  return {
    word: countdown(lock.leaseUntil) || 'held',
    title:
      'A live lease: a session is, or very recently was, working this phase. Never release a live lease.',
  };
}

function lockColumns(
  release: (lock: Lock) => void,
  refusal: string | undefined,
  busy: boolean,
): Column<Lock>[] {
  return [
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 168,
      flex: true,
      identity: true,
      card: 'title',
      value: (lock) => `${lock.slug} P${lock.phase}`,
      cell: (lock) => (
        <span className="break-words text-ink">
          {lock.slug} P{lock.phase}
        </span>
      ),
    },
    {
      id: 'state',
      head: 'State',
      priority: 1,
      min: 104,
      card: 'meta',
      value: (lock) => lockWord(lock).word,
      cell: (lock) => {
        const { word, title } = lockWord(lock);
        return (
          <span
            title={title}
            className={lock.expired && !lock.closed ? 'font-medium text-ink' : 'text-ink-muted'}
          >
            {word}
          </span>
        );
      },
    },
    {
      id: 'holder',
      head: 'Holder',
      priority: 2,
      // A holder is `pe-<host>-<pid>-<epoch>`: the half naming the machine is the half a cut would lose.
      min: 224,
      value: (lock) => lock.owner,
      cell: (lock) => <Mono value={lock.owner} className="wrap-anywhere" />,
    },
    {
      id: 'release',
      head: 'Release',
      priority: 1,
      min: 104,
      align: 'end',
      card: 'action',
      value: () => null,
      cell: (lock) =>
        lock.expired ? (
          <Button
            size="sm"
            disabled={Boolean(refusal) || busy}
            title={refusal ?? `Release the lapsed claim on ${lock.slug} P${lock.phase}`}
            onClick={() => release(lock)}
          >
            Release
          </Button>
        ) : null,
    },
    {
      id: 'session',
      head: 'Session',
      min: 176,
      everything: true,
      value: (lock) => lock.session ?? null,
      cell: (lock) =>
        lock.session ? (
          <Mono value={lock.session} chars={12} copyable />
        ) : (
          <span className="text-ink-muted">none named</span>
        ),
    },
  ];
}

export function PortfolioPanel({
  stats,
  allowWrites,
  closedSlugs,
  sizing,
  plan,
  everything = false,
}: {
  stats: Portfolio;
  allowWrites: boolean;
  closedSlugs: ReadonlySet<string>;
  /** The engine's own `sizing.env`, as the server read it. */
  sizing?: Sizing;
  /** The plan the page is scoped to, if any — these figures stay portfolio-wide, and say so. */
  plan?: string;
  everything?: boolean;
}) {
  const t = stats.totals;
  const [severity, setSeverity] = useState<Severity>('all');
  const { release, releaseLapsed, busy } = useLockRelease();
  const refusal = releaseRefusal(allowWrites);
  // Debris does not count: a lapsed lease on a closed plan blocks nothing, so
  // it earns no "release them all" for a chore that does not exist.
  const lapsed = stats.activeLocks.filter((lock) => lock.expired && !lock.closed).length;

  const columns = useMemo(
    () => lockColumns((lock) => void release(lock.slug, lock.phase), refusal, busy),
    [release, refusal, busy],
  );

  const counts = useMemo(() => {
    const out = { error: 0, warning: 0, info: 0 };
    for (const issue of stats.issues) out[issue.severity]++;
    return out;
  }, [stats.issues]);

  const issues = useMemo(
    () =>
      [...stats.issues]
        .filter((issue) => severity === 'all' || issue.severity === severity)
        .sort(
          (a, b) =>
            (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
            a.slug.localeCompare(b.slug),
        ),
    [stats.issues, severity],
  );

  // A phase state's count, keyed by the board's own words — the record the
  // compiler holds total, so a sixth bucket is a type error here.
  const byWord: Readonly<Record<BoardWord, number>> = {
    'in-progress': t.inProgress,
    ready: t.ready,
    stuck: t.stuck,
    waiting: t.waiting,
    done: t.done,
  };

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="insights-shape">
      {plan && (
        <InsightNote>
          Across every plan: the portfolio read does not break these down per plan.{' '}
          <a href={planHref(plan, 'phases')} className={PROSE_LINK}>
            {plan}’s own phases
          </a>{' '}
          are on its page.
        </InsightNote>
      )}

      <div className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <FigureBlock caption="Phase states">
          <StackBar
            label="phase states"
            segments={BOARD_ORDER.map((word) => {
              const view = describeWord('board', word);
              return { label: view.label, value: byWord[word], tone: view.paint };
            })}
          />
        </FigureBlock>
        <FigureBlock caption="Plan status">
          <BarList
            label="statuses"
            items={stats.byStatus.map((row) => ({ name: row.status, value: row.count }))}
          />
          {/* The split every forward-looking figure on this page is gated on, said
              outright: it is why "ready now" is so much smaller than "phases". */}
          <p className="text-meta text-ink-muted">
            {typeof t.open === 'number' ? `${t.open} open, ${t.closed} closed` : `${t.closed} closed`}
          </p>
        </FigureBlock>
        {/* A size is not a status, so it wears no state's hue: one hue, and the
            bar's length is the only encoding. */}
        <FigureBlock caption="Phase sizes">
          <BarList
            label="phase sizes"
            items={stats.sizeMix.map((row) => ({ name: row.size, value: row.count }))}
          />
          <p className="text-meta text-ink-muted">
            S {weight(sizing?.S)}, M {weight(sizing?.M)} and L {weight(sizing?.L)} of working-set weight, from
            the skill’s sizing.env.
          </p>
        </FigureBlock>
      </div>

      {t.orphans > 0 && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          {plural(t.orphans, 'orphan folder')}: handoff folders with no plan beside them. Nothing waits on
          them, and nothing reads them.
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading
          as="h3"
          count={stats.activeLocks.length}
          aside={
            lapsed > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(refusal) || busy}
                title={refusal ?? 'Release every claim whose lease ran out'}
                onClick={() => void releaseLapsed()}
              >
                Release all {lapsed} lapsed
              </Button>
            ) : null
          }
        >
          Locks
        </SectionHeading>
        {stats.activeLocks.length ? (
          <Grid
            columns={columns}
            rows={stats.activeLocks}
            getRowKey={(lock) => `${lock.slug}/${lock.phase}`}
            label="Phase claims"
            tableId="insights-locks"
            everything={everything}
            rowHref={(lock) => phaseHref(lock.slug, lock.phase)}
          />
        ) : (
          <p className="text-body text-ink-muted">No phase is claimed.</p>
        )}
        {everything && (
          <InsightNote>A claimed phase belongs to one session until its lease runs out.</InsightNote>
        )}
      </div>

      <FigureBlock caption="Busiest plans, phases completed" className="max-w-(--measure)">
        <BarList
          label="plans"
          tone="done"
          items={stats.busiest.map((row) => ({ name: row.slug, value: row.completions }))}
          empty="No plan has completed a phase yet."
        />
      </FigureBlock>

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading
          as="h3"
          count={stats.issues.length}
          aside={
            <ButtonGroup aria-label="Which issues to show">
              {(
                [
                  ['all', `All ${stats.issues.length}`],
                  ['error', `Errors ${counts.error}`],
                  ['warning', `Warnings ${counts.warning}`],
                  ['info', `Info ${counts.info}`],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  size="sm"
                  variant="ghost"
                  aria-pressed={severity === id}
                  onClick={() => setSeverity(id)}
                >
                  {label}
                </Button>
              ))}
            </ButtonGroup>
          }
        >
          Health
        </SectionHeading>
        {issues.length ? (
          <ul className="flex min-w-0 flex-col divide-y divide-rule" data-testid="insights-health">
            {issues.map((issue, index) => (
              <HealthRow
                key={`${issue.slug}-${issue.kind}-${index}`}
                issue={issue}
                closed={closedSlugs.has(issue.slug)}
              />
            ))}
          </ul>
        ) : severity === 'all' ? (
          <Empty
            title="Nothing flagged: plans, handoffs, indexes and locks all agree."
            action={
              <Button size="sm" asChild>
                <a href={plansHref()}>Browse the plans</a>
              </Button>
            }
          />
        ) : (
          <Empty
            title={`No ${severity}-level issues; other severities may still have some.`}
            action={
              <Button size="sm" onClick={() => setSeverity('all')}>
                Show every issue
              </Button>
            }
          />
        )}
      </div>

      {stats.stalled.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h3" count={stats.stalled.length}>
            Stalled plans
          </SectionHeading>
          <ul className="flex min-w-0 flex-col">
            {stats.stalled.map((item) => (
              <li key={item.slug} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                <a
                  href={planHref(item.slug)}
                  className="tap-row min-w-0 break-words text-body text-ink hover:underline"
                >
                  {item.slug}
                </a>
                <span className="text-meta text-ink-muted">
                  P{item.ready.join(', P')} ready, idle {plural(item.days, 'day')}
                </span>
              </li>
            ))}
          </ul>
          {everything && <InsightNote>Ready work nobody has touched for a week or more.</InsightNote>}
        </div>
      )}
    </div>
  );
}

/**
 * One issue: its severity in the health words, the plan (or phase) it is about,
 * the kind as the engine names it, then the engine's own sentence — and, for an
 * error or a warning, the one repair that fits.
 *
 * No closure check on the repair: `healthIssues()` demotes every issue on a
 * closed plan to `info`, and `classifyIssue()` offers a repair only for errors
 * and warnings — the severity already is the gate, the same one the server
 * enforces (`plan-repair` 409s on a closed plan).
 */
function HealthRow({ issue, closed }: { issue: HealthIssue; closed: boolean }) {
  const repair = classifyIssue(issue);
  return (
    // The words first, and the repair under them on a phone; beside them from
    // 640, and never wider than 15rem there (20rem from 1200) — a repair given
    // its own column at every width took the whole of a 360 px row and left
    // the words none.
    <li className="flex min-w-0 flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <OpsStatus vocab="health" word={issue.severity} title={issue.message} />
          {/* `tap-row`, not `tap-line`: the rows stack, and an overlay's
              overhang would reach the row above (styles/touch.test.ts BOX_FLOOR). */}
          <a
            href={issue.phase ? phaseHref(issue.slug, issue.phase) : planHref(issue.slug)}
            className="tap-row text-body text-ink hover:underline"
          >
            {issue.slug}
            {issue.phase ? ` P${issue.phase}` : ''}
          </a>
          <Mono value={issue.kind} className="text-meta text-ink-muted" />
          {closed && (
            <span
              className="text-meta text-ink-muted"
              title="The plan is closed: what is left is structural, kept and demoted, a record rather than a job."
            >
              closed plan
            </span>
          )}
        </div>
        {/* The engine's sentence quotes plan text — slugs, paths, a `bash -c '…'` —
            and a token with no space in it for forty characters has nothing to
            wrap at, so the message breaks inside words rather than widening the row. */}
        <p className="min-w-0 break-words text-meta text-ink-muted">{issue.message}</p>
      </div>
      {repair ? (
        <div className="min-w-0 sm:max-w-60 sm:shrink-0 lg:max-w-80">
          <RecoveryActions
            target={{ slug: issue.slug, ...(issue.phase != null ? { phase: issue.phase } : {}) }}
            ctx={{ planIssues: true }}
            max={1}
          />
        </div>
      ) : null}
    </li>
  );
}
