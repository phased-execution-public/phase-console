/**
 * The plan's own facts — what the glance does not say (7.0, quiet-console
 * phase 10).
 *
 * Three parts, each where it is read:
 *
 *   - `PlanBanners` — what changes how the whole page reads, always shown: a
 *     closed plan and why, the engine's error, a lint that timed out, could
 *     not run (#17 — never painted as a failure) or failed.
 *   - `QaLine` — the plan's QA gate when QA is anything but off: the switch
 *     with the reason the engine gave, the roll-up of every verdict on file and
 *     what those verdicts hold (#27), and the way to the Handoffs & QA reading.
 *   - `PlanFacts` — the rest, one press away (Everything opens it): the model
 *     and budget, the branch as the plan wrote it, when work began and over how
 *     long (#28), what is left and at what pace, the cost and the finish date
 *     with its assumptions, the last commit, the skills, the board's reading.
 */

import { QA_DISPLAY_WORDS, progressReading } from '@shared/plan-vocab.js';
import type { PlanDetail } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { closedTitle, isClosed } from '@/lib/closure';
import { duration, etaLabel, etaTitle, plural, weight } from '@/lib/format';
import { Banner, KeyValue, Money, RelativeTime, type KeyValueItem } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { MarkdownInline } from '@/ui/markdown';
import { insightsHref, planViewHref } from '@/shell/routes';
import { QaModeControl } from './phases/qa-mode';

/** A verdict word as the roll-up says it — "2 failing, 1 pending" (#27). */
const rollupWord = (word: string): string =>
  word === 'fail' ? 'failing' : word === 'pass' ? 'passed' : word;

/** The roll-up of every verdict on file, worst first, and what the verdicts hold. */
export function qaRollup(detail: Pick<PlanDetail, 'qa' | 'qaHeld'>): {
  rollup: string;
  holding: string | null;
} {
  const counts = new Map<string, number>();
  for (const row of detail.qa) counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
  const words = (QA_DISPLAY_WORDS as readonly string[])
    .filter((word) => counts.get(word))
    .map((word) => `${counts.get(word)} ${rollupWord(word)}`);
  const held = Object.entries(detail.qaHeld ?? {}).filter(([, phases]) => phases.length);
  return {
    rollup: words.length ? words.join(', ') : 'no verdict recorded yet',
    holding: held.length
      ? `holding ${held.map(([by, phases]) => `P${phases.join(', P')} (by P${by})`).join('; ')}`
      : null,
  };
}

/**
 * The plan's QA gate, in one line — drawn only when the plan runs QA (or has
 * waived it): an off plan's gate is a fact, in `PlanFacts`.
 */
export function QaLine({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const { data: state } = useConsoleState();
  const { rollup, holding } = qaRollup(detail);
  return (
    <section
      aria-label="QA gate"
      data-testid="qa-header-card"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-meta"
    >
      <QaModeControl
        slug={s.slug}
        mode={s.qaMode}
        {...(s.qaModeReason ? { reason: s.qaModeReason } : {})}
        allowWrites={Boolean(state?.allowWrites)}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
      />
      <span className="text-ink-muted" data-testid="qa-rollup">
        {rollup}
      </span>
      {holding && <span className="text-ink">{holding}</span>}
      <a href={planViewHref(s.slug, 'handoffs')} className="text-ink underline-offset-2 hover:underline">
        Handoffs &amp; QA
      </a>
    </section>
  );
}

/** When work began, to the minute and in UTC — two operators in two zones read one instant — and over how long. */
function Started({ startedAt, spanMs }: { startedAt: string; spanMs?: number | undefined }) {
  return (
    <span data-testid="plan-started">
      <time dateTime={startedAt} className="tabular-nums">
        {startedAt.slice(0, 10)} {startedAt.slice(11, 16)}Z
      </time>
      {typeof spanMs === 'number' && spanMs > 0 && (
        <span className="text-ink-muted">, over {duration(spanMs)}</span>
      )}
    </span>
  );
}

/**
 * Everything the plan states about itself beyond the glance, behind one press
 * — or open, with the page's Everything on.
 */
export function PlanFacts({ detail, open }: { detail: PlanDetail; open?: boolean }) {
  const s = detail.summary;
  const reading = progressReading(s);
  const budget = detail.plan?.sessionBudget;
  const closed = isClosed(s);
  const eta = detail.eta?.plan ?? s.eta ?? null;
  const items: KeyValueItem[] = [
    ['Slug', <span className="font-mono">{s.slug}</span>],
    s.phases > 0
      ? [
          'Board',
          <span className={reading.known ? undefined : 'text-ink'} title={reading.title}>
            {reading.text}
            {reading.known && closed && (s.done ?? 0) < s.phases
              ? `, ${s.phases - (s.done ?? 0)} never ran`
              : ''}
          </span>,
        ]
      : null,
    s.boardStale
      ? [
          'Stale board',
          <>
            the engine timed out; this is the board it read <RelativeTime at={s.boardStale.at} />
          </>,
        ]
      : null,
    budget?.targetModel ? ['Model', <span className="font-mono">{budget.targetModel}</span>] : null,
    s.budget ? ['Budget', `${weight(s.budget)} a session`] : null,
    // Prose from the plan's §Session budget line, often with backticks.
    budget?.branch ? ['Branch', <MarkdownInline text={budget.branch} />] : null,
    s.startedAt ? ['Started', <Started startedAt={s.startedAt} spanMs={s.spanMs} />] : null,
    s.remainingWeight
      ? [
          'Left',
          <span>
            {weight(s.remainingWeight)}, about {plural(s.remainingSessions, 'session')}
            {eta && (
              <span className="text-ink-muted" title={etaTitle(eta)}>
                , {etaLabel(eta.lowMs, eta.highMs, eta.basis)}
              </span>
            )}
          </span>,
        ]
      : null,
    detail.cost && detail.cost.totalUsd > 0
      ? [
          'Cost',
          <span>
            <a href={insightsHref(s.slug)} className="relative text-ink underline-offset-2 hover:underline">
              <Money usd={detail.cost.totalUsd} />
            </a>
            {detail.cost.partialPhases.length > 0 && (
              <span
                className="text-ink-muted"
                title={`P${detail.cost.partialPhases.join(', P')} recorded no cost for a session that ran`}
              >
                {' '}
                at least
              </span>
            )}
            {detail.forecast && (
              // The assumptions live on Insights; the title points at them —
              // never a date with its caveats only on hover.
              <span className="text-ink-muted" title={detail.forecast.assumptions.join('\n\n')}>
                {detail.forecast.calendar === 'known' && detail.forecast.expected
                  ? `, finishing about ${new Date(detail.forecast.expected).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                  : ', finish date unknown'}
              </span>
            )}
          </span>,
        ]
      : null,
    detail.git?.sha
      ? [
          'Last commit',
          <span>
            <span className="font-mono">{detail.git.sha}</span>
            {detail.git.relativeDate ? `, ${detail.git.relativeDate}` : ''}
            {detail.git.dirty ? ', uncommitted changes' : ''}
          </span>,
        ]
      : null,
    budget?.skills?.length
      ? ['Skills', <span className="min-w-0 wrap-anywhere font-mono">{budget.skills.join(', ')}</span>]
      : null,
    s.qaMode === 'off' || !s.qaMode ? ['QA gate', s.qaModeReason ? `off (${s.qaModeReason})` : 'off'] : null,
  ];
  return (
    <Disclosure
      label="About this plan"
      openLabel="Hide the plan's facts"
      testId="plan-facts"
      {...(open !== undefined ? { open, onOpenChange: () => undefined } : {})}
    >
      <KeyValue items={items} />
    </Disclosure>
  );
}

/**
 * What changes how the whole page reads — always shown, never folded. Closure
 * is not a problem to fix but the answer to "why is this plan quiet", so it
 * leads, in the info tone; a lint that could not RUN proves nothing either way
 * and is said as that (#17).
 */
export function PlanBanners({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const closed = isClosed(s);
  return (
    <>
      {closed && (
        <Banner severity="info" data-testid="plan-closed" title={closedTitle(s)}>
          <span className="flex min-w-0 flex-col gap-1">
            <span>
              Closed{s.status ? `, ${s.status}` : ''}
              {s.closedOn ? ` on ${s.closedOn}` : ''}
              {s.closedReason ? `: ${s.closedReason}` : ''}.
            </span>
            <span className="text-ink-muted">
              It reports no ready work, no warnings and no boot prompts, and it is left out of every total.
              Its board is kept in full. Reopen it to undo all of that.
            </span>
          </span>
        </Banner>
      )}
      {s.engineError && <Banner severity="warn">The engine said: {s.engineError}</Banner>}
      {detail.lint?.timedOut && <Banner severity="info">{detail.lint.summary}</Banner>}
      {detail.lint?.crashed && (
        <Banner severity="info">
          <span data-testid="lint-could-not-run">Plan health could not run: {detail.lint.summary}</span>
        </Banner>
      )}
      {detail.lint && !detail.lint.ok && !detail.lint.crashed && (
        <Banner severity="error">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold">{detail.lint.summary}</span>
            {detail.lint.stale && (
              <span className="text-meta">
                From the last check that finished, <RelativeTime at={detail.lint.stale.at} />.
              </span>
            )}
            <ul className="list-disc ps-5">
              {detail.lint.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </span>
        </Banner>
      )}
    </>
  );
}
