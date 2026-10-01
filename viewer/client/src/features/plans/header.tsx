import { Lock } from 'lucide-react';
import { Badge, Banner, KeyValue, Progress, RelativeTime } from '@/components/ui';
import { PhaseStatusBadge, PlanStatusBadge, type WordOf } from '@/components/ui/status';
import { MarkdownInline } from '@/components/markdown';
import { WriteMenu } from '@/components/write-menu';
import { QaModeControl } from '@/components/qa-mode-control';
import { useConsoleState } from '@/lib/queries';
import { closedTitle, isClosed } from '@/lib/closure';
import { cn } from '@/lib/cn';
import { duration, etaLabel, etaTitle, money, plural, weight } from '@/lib/format';
import { insightsHref, plansHref } from '@/app/routes';
import { phaseHref, planViewHref } from '@shared/routes.js';
import { QA_DISPLAY_WORDS, progressReading } from '@shared/plan-vocab.js';
import type { PlanDetail } from '@/lib/api';

/**
 * Who this plan is, how far along it is, and what is actionable right now.
 *
 * The ready chips are links, not decoration: "P3 ready" is the single most
 * clicked thing in the console, and in the old client it was a `<button>` that
 * called `navigate()` — invisible to a middle click, a long press, or anything
 * that wanted to open a phase in a second tab.
 */
/** A verdict word, as the roll-up says it — "2 failing, 1 pending" (#27). */
const rollupWord = (word: string): string =>
  word === 'fail' ? 'failing' : word === 'pass' ? 'passed' : word;

/**
 * The QA header card (control-tower phase 23, #27): the plan's switch with the
 * reason the engine gave, the roll-up of every verdict on file, what those
 * verdicts are holding, and the way to the QA view of the table. It was one
 * line of the key-value list — a bare word, and a link to a tab that is now a
 * view.
 */
function QaHeaderCard({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const { data: state } = useConsoleState();
  const counts = new Map<string, number>();
  for (const row of detail.qa) counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
  // In the display order the plan vocabulary keeps — worst first.
  const rollup = (QA_DISPLAY_WORDS as readonly string[])
    .filter((word) => counts.get(word))
    .map((word) => `${counts.get(word)} ${rollupWord(word)}`);
  const holding = Object.entries(detail.qaHeld ?? {}).filter(([, held]) => held.length);
  return (
    <section
      aria-label="QA gate"
      data-testid="qa-header-card"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-rule bg-surface px-3 py-2 text-xs"
    >
      <QaModeControl
        slug={s.slug}
        mode={s.qaMode}
        {...(s.qaModeReason ? { reason: s.qaModeReason } : {})}
        allowWrites={Boolean(state?.allowWrites)}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
      />
      <span className="text-ink-muted" data-testid="qa-rollup">
        {rollup.length ? rollup.join(', ') : 'no verdict recorded yet'}
      </span>
      {holding.length > 0 && (
        <span className="text-warn">
          holding {holding.map(([by, held]) => `P${held.join(', P')} (by P${by})`).join('; ')}
        </span>
      )}
      <a href={planViewHref(s.slug, 'qa')} className="text-action hover:underline">
        QA by phase
      </a>
    </section>
  );
}

/**
 * When work on the plan began, to the minute, and how long it has been going
 * (#28) — `created` is a bare date, and a span of "0 days" said nothing.
 * UTC, marked as such: two operators in two zones read one instant.
 */
function Started({ startedAt, spanMs }: { startedAt: string; spanMs?: number | undefined }) {
  return (
    <span data-testid="plan-started">
      <time dateTime={startedAt}>
        {startedAt.slice(0, 10)} {startedAt.slice(11, 16)}Z
      </time>
      {typeof spanMs === 'number' && spanMs > 0 && (
        <span className="text-ink-muted"> · over {duration(spanMs)}</span>
      )}
    </span>
  );
}

export function PlanHeader({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const reading = progressReading(s);
  const budget = detail.plan?.sessionBudget;
  const closed = isClosed(s);
  const { data: state } = useConsoleState();
  // The detail's own estimate, not the summary's: they are computed from the
  // same rate, but the detail's `remaining` respects a scoped run and this page
  // is where that difference would be visible.
  const eta = detail.eta?.plan ?? s.eta ?? null;

  return (
    <div className="mb-4 flex flex-col gap-3">
      {/* The way out, and it is not optional.
          A plan is reachable from a push notification, a handoff link and the
          palette, so the page is routinely the FIRST thing a session sees —
          and until now its only exits were the tab bar and the browser's Back,
          neither of which says where "up" is. Always shown rather than
          `lg:hidden`: the rail highlights *Plans* but does not go to the list,
          and a destination is not a breadcrumb. */}
      <a
        href={plansHref()}
        className="-mb-1 inline-flex items-center self-start text-sm text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
      >
        ← All plans
      </a>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className={cn('font-display text-3xl leading-none', closed && 'text-ink-muted')}>{s.title}</h1>
          {/* A closed plan gets a BADGE, not a chip.
              It used to be the status word wearing a small padlock, on the
              reasoning that `abandoned` says more than `CLOSED` and two chips
              for one fact stop a header being scannable. That reasoning was
              sound and still landed wrong: at chip size, beside a heading, next
              to the `document`/`orphan` chips, it read as one more piece of
              metadata — and closure is not metadata, it is the fact that
              changes how everything below it should be read. So: one badge,
              both words (`CLOSED · abandoned`), at a size that is seen before
              it is looked for. Non-terminal statuses keep the plain chip. */}
          {closed ? (
            <span
              title={closedTitle(s)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded border border-rule-strong bg-surface-raised px-2 py-1 text-xs font-medium uppercase tracking-[0.12em] text-ink-muted"
            >
              <Lock size={13} className="shrink-0" aria-hidden />
              Closed
              {s.status && (
                <span className="font-normal normal-case tracking-normal text-ink-faint">· {s.status}</span>
              )}
            </span>
          ) : (
            // Painted, not printed (control-tower phase 23): a plan's status is
            // a word of the plan vocabulary, and a word nobody knows draws as
            // Unknown rather than as grey text that looks like one.
            s.status && <PlanStatusBadge status={s.status as WordOf<'plan'>} />
          )}
          {s.kind !== 'plan' && <Badge>{s.kind === 'document' ? 'document' : 'orphan handoffs'}</Badge>}
        </div>
        {/* Renders nothing at all on a read-only console — the rail already
            says the session cannot write, and repeating it here is noise. */}
        <WriteMenu detail={detail} allowWrites={Boolean(state?.allowWrites)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-2xs text-ink-faint">{s.slug}</span>
        {s.phases > 0 && (
          <>
            {/* Only `done` is painted on a closed plan — the rest is grey.
                An amber ready notch means "this could move today", which is
                the one claim closure withdraws. Same rule as `plans/row.tsx`. */}
            {/* An unreadable board is UNKNOWN (#96): no bar — a bar is a
                claim about what is done — and the words say what was last
                read, and when. Never the 0 % an empty board would draw. */}
            {reading.known && (
              <span className="w-[min(20rem,40vw)]">
                <Progress
                  total={s.phases}
                  done={s.done ?? 0}
                  inProgress={closed ? 0 : s.inProgress.length}
                  ready={closed ? 0 : s.ready.length}
                  stuck={closed ? 0 : s.stuck.length}
                />
              </span>
            )}
            <span
              className={cn('font-mono text-2xs', reading.known ? 'text-ink-faint' : 'text-warn')}
              title={reading.title}
            >
              {reading.text}
              {reading.known &&
                closed &&
                (s.done ?? 0) < s.phases &&
                ` · ${s.phases - (s.done ?? 0)} never ran`}
            </span>
            {s.boardStale && (
              <span
                className="text-2xs text-warn"
                title="The engine timed out reading this plan; this is the last board it did read."
              >
                Stale board, read <RelativeTime at={s.boardStale.at} />
              </span>
            )}
          </>
        )}
        {/* `summary.ready` stays populated on a closed plan (the engine reports
            what never got done), and these are action-coloured links straight
            into a phase. Suppressed here for the same reason the ready board
            drops the plan outright. */}
        {!closed &&
          s.ready.map((phase) => (
            <a
              key={phase}
              href={phaseHref(s.slug, phase)}
              className="inline-flex items-center gap-1.5 rounded-sm border border-action/60 bg-action/12 px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap text-action hover:bg-action/20"
            >
              P{phase} ready
            </a>
          ))}
        {/* The board's own word for each phase in flight, as the status model
            draws it — `In progress`, never a word folded here. */}
        {!closed &&
          s.inProgress.map((phase) => (
            <span key={phase} className="inline-flex items-center gap-1">
              <span className="font-mono text-2xs text-ink-muted">P{phase}</span>
              <PhaseStatusBadge board="in-progress" />
            </span>
          ))}
      </div>

      <KeyValue
        // `clamp`, because every value in this list came out of a FILE. A plan
        // is prose an operator writes, so `Branch:` is whatever they wrote —
        // one word on most plans, an 1,100-character paragraph on this one,
        // which made the header taller than the viewport and pushed the tab
        // strip below the fold on all five tabs and the phase page.
        clamp
        className="sm:grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),auto))] sm:gap-x-6"
        items={[
          budget?.targetModel ? ['Model', <span className="font-mono">{budget.targetModel}</span>] : null,
          s.budget ? ['Budget', `${weight(s.budget)}/session`] : null,
          // The branch cell is prose from the plan's §Session budget line and
          // routinely contains backticks. The old client printed them raw
          // (`current branch \`main\` in both repos`); rendering it inline is
          // the same treatment the phase titles get.
          budget?.branch ? ['Branch', <MarkdownInline text={budget.branch} />] : null,
          s.startedAt ? ['Started', <Started startedAt={s.startedAt} spanMs={s.spanMs} />] : null,
          // Weight and sessions are what is left to DO; the estimate beside them
          // is how long that has actually been taking. The two answer the
          // question people ask as one — "how much further" — and the page could
          // only ever say the first half of it.
          s.remainingWeight
            ? [
                'Left',
                <span>
                  {weight(s.remainingWeight)} ≈ {plural(s.remainingSessions, 'session')}
                  {eta && (
                    <span className="text-ink-muted" title={etaTitle(eta)}>
                      {' · '}
                      {etaLabel(eta.lowMs, eta.highMs, eta.basis)}
                    </span>
                  )}
                </span>,
              ]
            : null,
          // Money and the finish date on the page somebody is already looking
          // at. The FULL answer — per phase, by model, by day, and the
          // forecast's assumptions — is one link away rather than crammed into
          // a header row; what belongs here is the headline and a way in.
          detail.cost && detail.cost.totalUsd > 0
            ? [
                'Cost',
                <span>
                  {/* `relative`: a positioned link hit-tests above the inline
                      text after it. Unpositioned, the finish-date span took the
                      link's last pixel — both right corners lost, the e2e
                      register's touch-wins at 360 and at 768. */}
                  <a href={insightsHref(s.slug)} className="relative text-action hover:underline">
                    {money(detail.cost.totalUsd)}
                  </a>
                  {detail.cost.partialPhases.length > 0 && (
                    <span
                      className="text-ink-muted"
                      title={`P${detail.cost.partialPhases.join(', P')} recorded no cost for a session that ran`}
                    >
                      {' '}
                      (at least)
                    </span>
                  )}
                  {detail.forecast && (
                    // The assumptions live on the Insights card; the title is
                    // the pointer to them, never a substitute — a date with its
                    // caveats only on hover is a date quoted without them. No
                    // measurable duty cycle means no date at all, not a guess.
                    <span className="text-ink-muted" title={detail.forecast.assumptions.join('\n\n')}>
                      {detail.forecast.calendar === 'known' && detail.forecast.expected ? (
                        <>
                          {' · finishes ~'}
                          {new Date(detail.forecast.expected).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </>
                      ) : (
                        ' · finish date unknown'
                      )}
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
                  {detail.git.relativeDate ? ` · ${detail.git.relativeDate}` : ''}
                  {detail.git.dirty ? <Badge className="ml-2">uncommitted</Badge> : null}
                </span>,
              ]
            : null,
          budget?.skills?.length
            ? [
                'Skills',
                // A chip may break here, where almost nowhere else may. The
                // badge vocabulary is `whitespace-nowrap` because its words are
                // a fixed list and a `needs-you` split across two lines reads as
                // two states — but a skill id is whatever a plan wrote, and
                // `frontend-design:frontend-design` ran 6px past `<main>`'s clip
                // edge at 360. Arbitrary content wraps; a vocabulary does not.
                budget.skills.map((skill) => (
                  <Badge key={skill} mono className="mr-1 max-w-full break-all whitespace-normal">
                    {skill}
                  </Badge>
                )),
              ]
            : null,
        ]}
      />

      {/* First banner, and `info` rather than `warn`: closure is not a problem
          to be fixed, it is the answer to "why is this plan quiet". Stating the
          reason here is the whole point of storing one — a closed plan with no
          explanation tells the next reader nothing, which is why the write verb
          refuses to close without it. */}
      {closed && (
        <Banner severity="info">
          <div className="min-w-0">
            <strong>
              Closed{s.status ? ` — ${s.status}` : ''}
              {s.closedOn ? ` on ${s.closedOn}` : ''}
            </strong>
            {s.closedReason ? <> — {s.closedReason}</> : null}
            <div className="mt-1 text-ink-faint">
              This plan reports no ready work, no warnings and no boot prompts, and it is left out of every
              portfolio total. Its board below is kept in full. Reopen it to undo all of that.
            </div>
          </div>
        </Banner>
      )}

      <QaHeaderCard detail={detail} />

      {s.engineError && <Banner severity="warn">Engine: {s.engineError}</Banner>}
      {detail.lint?.timedOut && <Banner severity="info">{detail.lint.summary}</Banner>}
      {/* COULD NOT RUN (#17): a reading that proves nothing about the plan,
          either way — said as that, and never painted as a failure. */}
      {detail.lint?.crashed && (
        <Banner severity="info">
          <span data-testid="lint-could-not-run">Plan health could not run — {detail.lint.summary}</span>
        </Banner>
      )}
      {detail.lint && !detail.lint.ok && !detail.lint.crashed && (
        <Banner severity="error">
          <div className="min-w-0">
            <strong>{detail.lint.summary}</strong>
            {detail.lint.stale && (
              <p className="text-2xs">
                From the last check that finished, <RelativeTime at={detail.lint.stale.at} />.
              </p>
            )}
            <ul className="mt-1 list-disc pl-5">
              {detail.lint.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </div>
        </Banner>
      )}
    </div>
  );
}
