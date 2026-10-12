/**
 * Is this plan healthy, and if not, what moves it? (7.0, quiet-console
 * phase 10.) Five pieces, each drawn where its question is asked:
 *
 *   - `PlanTrouble` — what is wrong now: a stopped run (its halt row, which
 *     carries the run's recommended verb), stuck phases, a failing lint with
 *     the press that lints again, and every other way forward, one per
 *     target. Nothing at all for a healthy plan.
 *   - `BeforeItBoards` — what boarding will find wrong with each open phase's
 *     §Verification on THIS machine, before a run exists or a dollar is spent.
 *   - `WorkLeft` — the shape of what is left: its weight, the critical path,
 *     the bottleneck, what is ready and how a person would batch it.
 *   - `LintAgain` — the engine's lint, asked again on a press.
 *   - `WorkForecast` — what is left in sessions, the unit the console runs.
 *
 * Composed from the shared vocabulary — `classifyRun`, the recovery model, the
 * halt family, the preflight words — never restated.
 */

import type { PlanDetail } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useAuth } from '@/data/machine';
import { usePlanLint, usePlanWork, useVerifyPreflight } from '@/data/plans';
import { useRun } from '@/data/runs';
import { isClosed } from '@/lib/closure';
import { looksLikeAuthFailure } from '@/lib/failures';
import { plural, weight } from '@/lib/format';
import { PREFLIGHT_LABEL, PREFLIGHT_TONE, willPark } from '@/lib/preflight';
import { WAYS_FORWARD, classifyRun, recoveryKey } from '@/lib/recovery';
import { phaseHref } from '@/shell/routes';
import { Banner, Button, KeyValue, Mono, SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { RunStatus } from '@/ui/status';
import { HaltRow } from '@/cards/halt-card';
import { RecoveryActions, type RecoveryCtx } from '@/cards/recovery-actions';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';

/** A long note, cut to what a line can carry. */
function excerpt(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* ------------------------------------------------------------------ *
 * Something's wrong
 * ------------------------------------------------------------------ */

type Offer = {
  key: string;
  target: { slug: string; phase?: number; runId?: string };
  ctx: RecoveryCtx;
};

export function PlanTrouble({
  detail,
  withRun = true,
}: {
  detail: PlanDetail;
  /** The run's own trouble — off on the Run view, whose halt card and notices own it. */
  withRun?: boolean;
}) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  // A server from before the autopilot has no run endpoints.
  const { data: runDetail } = useRun(slug, state?.autopilot !== false);
  const { data: auth } = useAuth(Boolean(state?.autopilot));
  const run = runDetail?.run ?? null;

  // A stuck phase is plan progress, and progress is what closing a plan
  // silences. The RUN is deliberately not gated on it: a halted run is a
  // process that stopped and may still want a person, whatever the plan's
  // `status:` line says.
  const closed = isClosed(detail.summary);
  const stuck = closed ? [] : detail.phases.filter((p) => p.state === 'stuck');
  // `--lint` answers `LINT OK (closed)` on a closed plan, and a lint that could
  // not RUN reads ok — neither is a failure here.
  const lintFailed = Boolean(detail.lint && !detail.lint.ok);
  const authFailure = looksLikeAuthFailure(run, auth);
  const runClass = classifyRun(run, { authFailure });
  // Parked is trouble even when no agent class fits it (an MCP park has a
  // console remedy, not an agent): the card used to vanish exactly then.
  const parked = Boolean(run && run.status === 'parked' && !run.resolved);
  const runTrouble = withRun && Boolean(run && (runClass || parked));
  const halted = runTrouble && Boolean(run?.halt);

  // Every way forward, once per target: each stuck phase and the lint all want
  // a plan repair, and one row per identical ask is noise, not help.
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const offer = (key: string, target: Offer['target'], ctx: RecoveryCtx) => {
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({ key, target, ctx });
  };
  // A halted run's verbs are the halt row's own; offering them here as well
  // would draw the same buttons twice.
  if (run && runTrouble && !halted) {
    offer(
      `run:${recoveryKey({ slug })}`,
      { slug, runId: run.id },
      { run, ...(authFailure ? { authFailure: true } : {}) },
    );
  }
  for (const phase of stuck) {
    offer(
      `stuck:${recoveryKey({ slug, phase: phase.phase })}`,
      { slug, phase: phase.phase },
      { boardState: 'stuck' },
    );
  }
  if (lintFailed) offer('lint', { slug }, { planIssues: true });

  if (!runTrouble && !stuck.length && !lintFailed) return null;

  return (
    <section
      aria-label="Something's wrong"
      data-testid="plan-trouble"
      className="flex min-w-0 flex-col gap-3"
    >
      <SectionHeading>Something&apos;s wrong</SectionHeading>
      {run && runTrouble && (
        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5" data-testid="trouble-run">
          <RunStatus
            run={run as Parameters<typeof RunStatus>[0]['run']}
            ctx={{ planClosed: closed }}
            size="md"
          />
          {halted ? (
            <HaltRow
              run={run}
              authFailure={authFailure}
              parts={ACCOUNT_RECOVERY_PARTS}
              className="min-w-0 flex-1 basis-64"
            />
          ) : (
            <span className="min-w-0 flex-1 basis-64 break-words text-body text-ink-muted">
              {excerpt(run.finishedReason) ?? 'It stopped without a note.'}
            </span>
          )}
        </div>
      )}
      {stuck.length > 0 && (
        <Banner severity="warn" data-testid="trouble-stuck">
          <span className="flex min-w-0 flex-col gap-1">
            <span>
              {stuck.length === 1
                ? `Phase ${stuck[0]!.phase} is stuck: its handoff reads blocked.`
                : `${stuck.length} phases are stuck: their handoffs read blocked.`}
            </span>
            <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
              {stuck.map((phase) => (
                <a
                  key={phase.phase}
                  href={phaseHref(slug, phase.phase)}
                  className="tap-line text-meta text-ink underline-offset-2 hover:underline"
                >
                  Open phase {phase.phase}
                </a>
              ))}
            </span>
          </span>
        </Banner>
      )}
      {lintFailed && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="trouble-lint">
          <p className="text-body text-ink">The plan fails its lint.</p>
          <LintAgain slug={slug} />
        </div>
      )}
      {offers.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2" data-testid="ways-forward">
          <SectionHeading as="h3">{WAYS_FORWARD}</SectionHeading>
          <ul className="flex min-w-0 flex-col gap-3">
            {offers.map(({ key, target, ctx }) => (
              <li key={key} className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-ink-muted">
                  {target.phase != null ? `Phase ${target.phase}` : target.runId ? 'The run' : 'The plan'}
                </span>
                <RecoveryActions target={target} ctx={ctx} max={2} parts={ACCOUNT_RECOVERY_PARTS} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Will a run board?
 * ------------------------------------------------------------------ */

/**
 * What boarding will find, per open phase — computed by the extractor boarding
 * uses, against this machine's PATH, and readable off the plan file the whole
 * time: a run no longer has to be created, boarded and parked to say it.
 *
 * Draws NOTHING when the answer holds no findings and nothing when there was
 * no answer: this console cannot say a plan is clean, only what it found.
 */
export function BeforeItBoards({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const { data } = useVerifyPreflight(slug);
  const phases = data?.phases ?? [];
  if (!phases.length) return null;
  const parking = willPark(phases).length;
  return (
    <section
      aria-label="Before it boards"
      data-testid="before-it-boards"
      className="flex min-w-0 flex-col gap-2"
    >
      <SectionHeading as="h3" count={phases.length}>
        Before it boards
      </SectionHeading>
      <p className="text-body text-ink">
        {parking > 0
          ? `${plural(parking, 'phase')} will park at boarding`
          : `${plural(phases.length, 'phase')} with something to know`}
      </p>
      <ul className="flex min-w-0 flex-col gap-2.5">
        {phases.map(({ phase, warnings }) => (
          <li key={phase} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <a
              href={phaseHref(slug, phase)}
              className="tap-line text-body text-ink tabular-nums underline-offset-2 hover:underline"
            >
              Phase {phase}
            </a>
            <ul className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
              {warnings.map((warning, i) => {
                // The one certainty — nothing runnable WILL park — reads in
                // ink and weight; the three predictions about this machine
                // stay muted, or the certain one stops standing out.
                const certain = PREFLIGHT_TONE[warning.kind] === 'bad';
                return (
                  <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body">
                    <span
                      data-preflight={warning.kind}
                      data-certain={certain ? '' : undefined}
                      className={certain ? 'font-medium text-ink' : 'text-ink-muted'}
                    >
                      {PREFLIGHT_LABEL[warning.kind]}
                    </span>
                    {/* `break-words` is load-bearing: a held-back command is
                        quoted verbatim, and `bash -c '! grep -rnE "A|B" path/'`
                        has no space to wrap at for eighty characters — without
                        it the line sets the track and a phone scrolls sideways. */}
                    <span className="min-w-0 break-words text-ink-muted">{warning.message}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Computed the way boarding computes it, against this machine’s PATH. A command it cannot run is skipped
        and recorded, never failed.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Where the work is
 * ------------------------------------------------------------------ */

/**
 * The shape of what is LEFT: the weight, the critical path, the bottleneck,
 * what is ready — and how a person would batch the rest, because the autopilot
 * never batches. A closed plan has stopped claiming work, and a finished one
 * has none to describe; both draw nothing.
 */
export function WorkLeft({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const groups = detail.batches?.groups ?? [];
  // Optional on the wire whatever the type says: the server is whatever Node
  // loaded at startup, the client is read from disk, and a new page talking to
  // an old API must read "not said", never crash.
  const criticalPath = s.criticalPath ?? [];
  const ready = s.ready ?? [];
  if (isClosed(s) || (!s.remainingWeight && !criticalPath.length && !groups.length)) return null;
  return (
    <section aria-label="What is left" data-testid="work-left" className="flex min-w-0 flex-col gap-3">
      {/* The unit first (#83): every count below is in it. */}
      <p className="text-meta text-ink-muted" data-testid="work-unit">
        {detail.sizing?.unit ?? '1 phase ≥ 1 session'}
      </p>
      <KeyValue
        items={[
          [
            'Work left',
            `${weight(s.remainingWeight)}, about ${plural(s.remainingSessions ?? 0, 'session')}, measured per phase`,
          ],
          [
            'Critical path',
            criticalPath.length
              ? `P${criticalPath.join(' → P')}, at least ${plural(s.minimumSessions ?? 0, 'session')}`
              : 'Nothing left',
          ],
          [
            'Bottleneck',
            s.bottleneck
              ? `P${s.bottleneck.phase}, holds up ${plural(s.bottleneck.blocks, 'phase')}`
              : 'Nothing is blocking',
          ],
          [
            'Ready now',
            ready.length
              ? `${ready.length}${s.nextBest ? `, best next P${s.nextBest.phase} (unblocks ${s.nextBest.unblocks})` : ''}`
              : 'None',
          ],
          detail.sizing?.bootLine ? ['Boot', detail.sizing.bootLine] : null,
        ]}
      />
      {groups.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="work-batches">
          <p className="text-meta text-ink-muted">
            Batched by hand at {weight(s.budget)} a session (<Mono value="--session-plan" />
            ). The autopilot never batches; these are a person’s.
          </p>
          <ul className="flex min-w-0 flex-col gap-1">
            {groups.map((group) => (
              <li key={group.index} className="min-w-0 break-words text-body text-ink">
                Session {group.index}: {group.phases.map((p) => `P${p}`).join(' + ')}
                <span className="text-ink-muted">
                  , {group.weight}
                  {group.gated ? ', gated' : ''}
                  {group.note ? `, ${group.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The lint, run again on a person's press — never on mount: the page draws the
 * verdict cached with the plan, and a plan edited a minute ago deserves the
 * engine's word now, not a reload.
 */
export function LintAgain({ slug }: { slug: string }) {
  const lint = usePlanLint(slug);
  const verdict = lint.data;
  const answered = lint.isFetched && !lint.isFetching;
  const issues = verdict && !verdict.ok ? verdict.issues : [];
  const SHOWN = 8;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5" data-testid="lint-again">
      <Button size="sm" variant="ghost" disabled={lint.isFetching} onClick={() => void lint.refetch()}>
        {lint.isFetching ? 'Linting…' : 'Lint the plan again'}
      </Button>
      {/* Always mounted, so the answer is spoken when it lands. */}
      <p className="text-meta text-ink-muted" role="status">
        {!answered
          ? null
          : lint.error
            ? `The lint could not run: ${lint.error.message}`
            : !verdict
              ? 'This plan has no phase graph to lint.'
              : verdict.crashed
                ? 'The engine could not run the lint, so this proves nothing about the plan.'
                : verdict.ok
                  ? 'The lint passes now.'
                  : `Still failing: ${verdict.summary || plural(verdict.issues.length, 'issue')}`}
      </p>
      {issues.length > 0 && (
        <ul className="flex min-w-0 list-disc flex-col gap-0.5 ps-5 text-meta text-ink-muted">
          {issues.slice(0, SHOWN).map((issue) => (
            <li key={issue} className="break-words">
              {issue}
            </li>
          ))}
        </ul>
      )}
      {issues.length > SHOWN && (
        <Disclosure label="The rest of the lint" openLabel="Hide the rest" count={issues.length - SHOWN}>
          <ul className="flex min-w-0 list-disc flex-col gap-0.5 ps-5 text-meta text-ink-muted">
            {issues.slice(SHOWN).map((issue) => (
              <li key={issue} className="break-words">
                {issue}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** What is left, in sessions at this plan's measured size (`GET /api/plans/<slug>/work`). */
export function WorkForecast({ slug }: { slug: string }) {
  const { data: left } = usePlanWork(slug);
  if (!left || !left.phases) return null;
  const sessions = Math.max(1, Math.round(left.sessions));
  return (
    <p className="text-body text-ink-muted" data-testid="work-forecast">
      {`${plural(left.phases, 'phase')} left, about ${plural(sessions, 'session')} at this plan’s measured size.`}
    </p>
  );
}
