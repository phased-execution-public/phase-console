/**
 * Is this plan healthy, and if not, what moves it?
 *
 * 3.0 folded four separate answers into one panel. They were spread across the
 * route tab's three cards (what the run is doing, what is wrong, the ways
 * forward) and the Analysis tab (the lint summary, the critical path, the
 * bottleneck), and the one an operator most needed — **what boarding will find
 * wrong before any money is spent** — was on neither, because nothing rendered
 * `/verify-preflight` at all.
 *
 * Four questions, in the order they are asked:
 *
 * 1. **Something's wrong** — a halt, stuck phases, a failing lint, in the run's
 *    own words (the header's banner stays the detailed listing).
 * 2. **Will a run board?** — the preflight, per open phase. This is the section
 *    that is new: a badge per phase saying which of its §Verification commands
 *    cannot run HERE, on this machine, with this PATH.
 * 3. **Where the work is** — the critical path, the bottleneck, and how the
 *    engine would batch what is left.
 * 4. **Ways forward** — each button opens the launch dialog, deduplicated by
 *    target so lint and a stuck phase do not mint two plan-repair buttons.
 *
 * Everything here is the existing vocabulary — `classifyRun`,
 * `classifyBoardPhase`, `RECOVERY_BLURBS`, the status tones — composed, not
 * restated.
 */

import { HaltRow } from '@/components/halt-card';
import { haltSentence } from '@shared/halt-categories.js';
import { Bot, TriangleAlert } from 'lucide-react';
import { Badge, Banner, Button, Card, CardBody, CardHeader, CardTitle, Tile } from '@/components/ui';
import { RunStatusBadge } from '@/components/ui/status';
import { keys, useAuth, useConsoleState, useConverge, useRun, useVerifyPreflight } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { money, plural, weight } from '@/lib/format';
import { isClosed } from '@/lib/closure';
import { PREFLIGHT_LABEL, PREFLIGHT_TONE } from '@/lib/preflight';
import { looksLikeAuthFailure } from '@/lib/failures';
import { WAYS_FORWARD, classifyRun, recoveryKey } from '@/lib/recovery';
import { isLiveStatus, runStatusTitle } from '@/lib/status-vocab';
import { PlanPulse } from '@/components/pulse';
import { RecoveryActions, type RecoveryCtx } from '@/components/recovery-actions';
import { phaseHref, planHref } from '@shared/routes.js';
import type { PlanDetail, PreflightWarning, RunState } from '@/lib/api';

function excerpt(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Which part of the panel to draw. The Phases tab draws it in two, around its
 * table (control-tower phase 23): `trouble` — what is wrong, the ways forward
 * and what boarding will find — ABOVE it, so a halted run is still the first
 * thing on the tab, and nothing at all for a healthy plan; `context` — the
 * heartbeat, the autopilot and what is left — BELOW it, because the table is
 * where the plan is up to, and the whole panel above it had put the table a
 * screen and a half down. Absent draws the whole panel.
 */
export type HealthPart = 'trouble' | 'context';

export function HealthPanel({ detail, part }: { detail: PlanDetail; part?: HealthPart }) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  const { data: detailRun } = useRun(slug, state?.autopilot !== false);
  const { data: converge } = useConverge(state?.autopilot !== false);
  const { data: auth } = useAuth(Boolean(state?.autopilot));
  const run = (detailRun?.run ?? null) as RunState | null;

  // One definition, in shared/status-vocab.js. This was a fourth copy of it —
  // the one client file that asked "is this run live?" without asking the
  // module that owns the answer.
  const live = isLiveStatus(run?.status);
  // A stuck phase is plan progress, and progress is what closure silences — the
  // server already drops `stale-handoff` for a closed plan, so leaving the
  // banner here would reintroduce the same warning from `phases[].state`.
  // The RUN cards below are deliberately NOT gated: a halted run is a process
  // that stopped and may still want a person, and a `status:` line in a
  // markdown file must not make one disappear. Same split P2 made for
  // notifications.
  const closed = isClosed(detail.summary);
  const stuck = closed ? [] : detail.phases.filter((p) => p.state === 'stuck');
  // `--lint` already answers `LINT OK (closed)` with exit 0 on a closed plan
  // (P1), so this is false for free — no second gate needed.
  const lintFailed = Boolean(detail.lint && !detail.lint.ok);
  const authFailure = looksLikeAuthFailure(run, auth);
  const runClass = classifyRun(run, { authFailure });
  // Parked counts as troubled even when no agent class fits (an MCP park has a
  // deterministic remedy, not an agent) — the card used to vanish exactly when
  // the plan was MCP-parked.
  const parkedRun = Boolean(run && run.status === 'parked' && !run.resolved);
  const troubled = Boolean(runClass) || parkedRun || stuck.length > 0 || lintFailed;

  // Advisory, and asked for on every visit to the route tab: it is a read of
  // the plan file plus a PATH lookup per lead, and it answers the question the
  // run page could only answer AFTER the run had been created and parked.
  // A console whose server predates the endpoint simply gets nothing.
  const { data: preflight } = useVerifyPreflight(slug);

  // Ways forward, deduplicated by target: every stuck phase (and the lint)
  // wants plan-repair, and one row per identical ask is noise, not help.
  type Offer = { key: string; target: { slug: string; phase?: number; runId?: string }; ctx: RecoveryCtx };
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const offer = (key: string, target: Offer['target'], ctx: RecoveryCtx) => {
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({ key, target, ctx });
  };
  if (run && (runClass || parkedRun)) {
    const phase = run.halt?.phase;
    const record = phase != null ? run.phases?.[String(phase)] : undefined;
    offer(
      `run:${recoveryKey({ slug, ...(phase != null ? { phase } : {}) })}`,
      {
        slug,
        ...(phase != null ? { phase } : {}),
        runId: run.id,
      },
      {
        run,
        ...(record
          ? {
              record: {
                status: record.status,
                resumable: Boolean(record.sessionId ?? record.resumeSessionId),
              },
            }
          : {}),
        ...(authFailure ? { authFailure: true } : {}),
      },
    );
  }
  for (const phase of stuck) {
    offer(
      `stuck:${recoveryKey({ slug, phase: phase.phase })}`,
      { slug, phase: phase.phase },
      { boardState: 'stuck' },
    );
  }
  if (lintFailed) offer('lint', { slug }, { planIssues: true } as RecoveryCtx);

  const context = part !== 'trouble';
  const trouble = part !== 'context';
  const findings = preflight?.phases ?? [];
  // Above the table a healthy plan gets nothing — not even an empty grid's gap.
  if (part === 'trouble' && !troubled && !findings.length) return null;
  // Drawn apart, each part fills its own rows: the autopilot card has nothing
  // beside it below the table, and "Something's wrong" takes the width its
  // way forward leaves above it.
  const autopilotSpan = !troubled || part === 'context' ? 'sm:col-span-2 lg:col-span-3' : undefined;
  const wrongSpan =
    part === 'trouble' ? (offers.length > 0 ? 'lg:col-span-2' : 'sm:col-span-2 lg:col-span-3') : undefined;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {/* The heartbeat first: while anything is live, queued or parked, the
          panel leads with WHICH phases, in WHAT vehicle, for HOW LONG — it
          renders nothing when the plan is idle. */}
      {context && run && (
        <PlanPulse
          className="sm:col-span-2 lg:col-span-3"
          slug={slug}
          run={run}
          converge={converge?.reports.find((report) => report.slug === slug) ?? null}
          board={detail.phases.map((p) => ({
            phase: p.phase,
            title: p.title,
            state: p.state,
            ...(p.row?.dependsOn ? { dependsOn: p.row.dependsOn } : {}),
          }))}
        />
      )}
      {context && (
        <Card className={autopilotSpan}>
          <CardHeader>
            <CardTitle>Autopilot</CardTitle>
            {run ? (
              // The run in its plan's context: a closed plan settles a run that
              // never finished, and the clock decides a stale stop is dormant.
              <RunStatusBadge
                run={run}
                ctx={{ planClosed: closed }}
                title={runStatusTitle(run.status)}
                pulse={run.status === 'running'}
              />
            ) : (
              <Badge>not running</Badge>
            )}
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {run && !live && run.halt ? (
              // The stop, in the halt card's family and one sentence (phase 17).
              <HaltRow run={run} />
            ) : (
              <p className="text-sm text-ink-muted">
                {run ? (
                  live ? (
                    <>
                      {run.activePhase != null ? `Driving phase ${run.activePhase}` : 'Between phases'}
                      {' · '}
                      {run.model}
                      {run.spentUsd ? <> · {money(run.spentUsd)} spent</> : null}
                    </>
                  ) : (
                    (excerpt(run.finishedReason) ?? 'Stopped, without a note.')
                  )
                ) : (
                  'Nothing has been run for this plan yet — the run tab starts one.'
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" asChild>
                <a href={planHref(slug, 'run')}>
                  <Bot size={13} aria-hidden /> Open autopilot
                </a>
              </Button>
              {/* The one-press plan recovery, on the plan itself: confirm against
                the board, stand down what it settled, recover or continue what
                is real. Renders only for a stopped, unresolved run. */}
              {run && !live && <RecoveryActions target={{ slug, runId: run.id }} ctx={{ run }} max={1} />}
              {run?.gitMode === 'new-branch' && (
                <Badge title="This run works on its own branch and, unless turned off, opens a PR when the plan completes.">
                  work branch{run.openPr === false ? '' : ' · PR'}
                </Badge>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {trouble && troubled && (
        <Card className={wrongSpan}>
          <CardHeader>
            <CardTitle>Something's wrong</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {(runClass || parkedRun) && run && (
              <Banner severity={parkedRun ? 'warn' : 'error'}>
                Run {run.status}. {(run.halt ? haltSentence(run.halt) : excerpt(run.finishedReason)) ?? ''}
              </Banner>
            )}
            {stuck.length > 0 && (
              <Banner severity="warn">
                {stuck.length === 1
                  ? `Phase ${stuck[0]!.phase} is stuck — its handoff reads blocked.`
                  : `${stuck.length} phases are stuck — their handoffs read blocked.`}{' '}
                The Autopilot tab explains each one.
              </Banner>
            )}
            {lintFailed && (
              <Banner severity="warn">{detail.lint!.summary || 'The plan fails validation.'}</Banner>
            )}
            {lintFailed && <LintAgain slug={slug} />}
          </CardBody>
        </Card>
      )}

      {trouble && troubled && offers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{WAYS_FORWARD}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {offers.map(({ key, target, ctx }) => (
              <div key={key} className="flex flex-col gap-1">
                {target.phase != null && (
                  <span className="font-mono text-2xs text-ink-faint">P{target.phase}</span>
                )}
                <RecoveryActions target={target} ctx={ctx} max={2} />
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {trouble && <PreflightCard slug={slug} phases={findings} />}
      {context && <WorkLeft detail={detail} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Will a run board?
 * ------------------------------------------------------------------ */

/* How loudly each finding reads lives in `lib/preflight.ts`, shared with the
   launch flow's review stage — two surfaces, one weight per kind. */

/**
 * What boarding will find, per open phase — the section that is genuinely new.
 *
 * The server has computed this since Phase 4 and written it to the journal as
 * prose, where it predicted the dominant halt class forty-four times and was
 * rendered by nothing. A run had to be created, boarded and parked before an
 * operator saw a defect that was readable off the plan file the whole time.
 *
 * Renders NOTHING when the endpoint answered with no findings *and* nothing
 * when it did not answer at all — an empty panel and a missing one look the
 * same, and both are honest: this console cannot tell you the plan is clean, it
 * can only tell you what it found.
 */
function PreflightCard({
  slug,
  phases,
}: {
  slug: string;
  phases: { phase: number; warnings: PreflightWarning[] }[];
}) {
  if (!phases.length) return null;
  const willPark = phases.filter((p) => p.warnings.some((w) => w.kind === 'nothing-runnable')).length;

  return (
    <Card className="sm:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>Before it boards</CardTitle>
        <span className="text-xs text-ink-faint">
          {willPark > 0
            ? `${plural(willPark, 'phase')} will park at boarding`
            : `${plural(phases.length, 'phase')} with something to know`}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        {phases.map(({ phase, warnings }) => (
          <div key={phase} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
            <a
              href={phaseHref(slug, phase)}
              className="shrink-0 rounded-sm border border-rule px-1.5 py-0.5 font-mono text-2xs text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              P{phase}
            </a>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {warnings.map((warning, i) => (
                <div key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <Badge tone={PREFLIGHT_TONE[warning.kind]}>{PREFLIGHT_LABEL[warning.kind]}</Badge>
                  {/* `break-words` is load-bearing, not tidiness. A `human-check`
                      message quotes the held-back command verbatim, and a
                      `bash -c '! grep -rnE "A|B|C" path/'` has no space in it
                      for eighty characters — so `min-w-0` alone leaves nothing
                      to wrap at, the card sets the track width, and the whole
                      PAGE scrolls sideways on a phone. Measured: 458/390 before
                      this line. */}
                  <span className="min-w-0 break-words text-ink-muted">{warning.message}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-2xs text-ink-faint">
          <TriangleAlert size={11} className="mr-1 inline align-[-1px]" aria-hidden />
          Advisory — computed with the extractor boarding uses, against THIS machine&rsquo;s PATH. A skipped
          command is recorded, never failed.
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Where the work is
 * ------------------------------------------------------------------ */

/**
 * The critical path, the bottleneck, and how the engine would batch the rest.
 *
 * These four numbers were the Analysis tab's top strip and the suggested-session
 * chips were a card of their own under the map. Neither is a subject: they are
 * the shape of what is LEFT, which is the same question the rest of this panel
 * answers, so they read here and nowhere else. (The estate-wide versions —
 * velocity, completions, spend over time — are Insights' subject; see the
 * handoff.)
 */
function WorkLeft({ detail }: { detail: PlanDetail }) {
  const s = detail.summary;
  const closed = isClosed(s);
  const groups = detail.batches?.groups ?? [];
  // Every one of these is optional on the wire for the same reason `detail.eta`
  // is: the server is whatever Node loaded at startup, the client is read from
  // disk per request, and upgrading the skill under a running console leaves a
  // new UI talking to an old API. A missing field must read as "not said",
  // never as a crash on a page whose whole job is to be readable.
  const criticalPath = s.criticalPath ?? [];
  const ready = s.ready ?? [];

  // A finished plan has no work left to describe, and a closed one has stopped
  // claiming it does — the engine answers `--session-plan` with "No sessions to
  // plan" for exactly that reason.
  if (closed || (!s.remainingWeight && !criticalPath.length && !groups.length)) return null;

  // Every line in this card is read, not glanced at — the unit, the path, what
  // the bottleneck holds up, the best next phase — so it is muted ink, never
  // the metadata's faint, which fails AA at these sizes in both themes (the
  // e2e register). A tile's hint is faint by default; these are its answer.
  const answer = (text: string) => <span className="text-ink-muted">{text}</span>;

  return (
    <Card className="sm:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardTitle>What is left</CardTitle>
        <span className="text-xs text-ink-muted">
          {/* The unit first (#83): the autopilot never batches, so a batch below is a person's. */}
          {detail.sizing?.unit ?? '1 phase ≥ 1 session'}
          {groups.length > 0 && (
            <>
              {' '}
              · batches by hand at {weight(s.budget)} — <code className="font-mono">--session-plan</code>
            </>
          )}
        </span>
        <WorkForecast slug={s.slug} />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Tile
            label="Work left"
            value={weight(s.remainingWeight)}
            hint={answer(`≈ ${plural(s.remainingSessions, 'session')}, measured per phase`)}
          />
          <Tile
            label="Critical path"
            value={String(criticalPath.length)}
            hint={answer(
              criticalPath.length
                ? `P${criticalPath.join(' → P')} · min ${plural(s.minimumSessions, 'session')}`
                : 'nothing left',
            )}
          />
          <Tile
            label="Bottleneck"
            value={s.bottleneck ? `P${s.bottleneck.phase}` : '—'}
            hint={answer(
              s.bottleneck ? `holds up ${plural(s.bottleneck.blocks, 'phase')}` : 'nothing is blocking',
            )}
          />
          <Tile
            label="Ready now"
            value={String(ready.length)}
            state={ready.length > 0 ? 'state-queued' : undefined}
            hint={answer(
              s.nextBest ? `best next: P${s.nextBest.phase} (unblocks ${s.nextBest.unblocks})` : 'none',
            )}
          />
        </div>

        {detail.sizing && <p className="text-2xs text-ink-muted">{detail.sizing.bootLine}</p>}

        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((group) => (
              <Badge key={group.index} title={group.note ?? ''}>
                <b>S{group.index}</b>&nbsp;{group.phases.map((p) => `P${p}`).join(' + ')}
                &nbsp;<span className="text-ink-faint">{group.weight}</span>
                {group.gated ? ' · gated' : ''}
              </Badge>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The lint, run again on a person's press (control-tower phase 25): the page
 * shows the verdict cached with the plan, and a plan edited a minute ago
 * deserves the engine's word now, not a reload. `GET /api/plans/<slug>/lint`
 * had no caller.
 */
export function LintAgain({ slug }: { slug: string }) {
  const lint = useQuery({ queryKey: keys.planLint(slug), queryFn: () => api.planLint(slug), enabled: false });
  const verdict = lint.data;
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="lint-again">
      <div>
        <Button size="sm" variant="ghost" disabled={lint.isFetching} onClick={() => void lint.refetch()}>
          {lint.isFetching ? 'Linting…' : 'Lint the plan again'}
        </Button>
      </div>
      {lint.isFetched && !lint.isFetching ? (
        <p className="text-xs text-ink-muted" role="status">
          {lint.error
            ? `The lint could not run: ${lint.error.message}`
            : !verdict
              ? 'This plan has no phase graph to lint.'
              : verdict.crashed
                ? 'The engine could not run the lint — this proves nothing about the plan.'
                : verdict.ok
                  ? 'The lint passes now.'
                  : `Still failing: ${verdict.summary || `${verdict.issues.length} issues`}`}
        </p>
      ) : null}
      {verdict && !verdict.ok && verdict.issues.length ? (
        <ul className="list-inside list-disc text-2xs text-ink-muted">
          {verdict.issues.slice(0, 8).map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * What is left, in the unit the console runs — sessions (phase 59's model),
 * from `GET /api/plans/<slug>/work`, which had no caller (control-tower phase 25).
 */
export function WorkForecast({ slug }: { slug: string }) {
  const work = useQuery({
    queryKey: keys.planWork(slug),
    queryFn: () => api.planWork(slug),
    staleTime: 60_000,
  });
  const left = work.data;
  if (!left || !left.phases) return null;
  return (
    <p className="text-xs text-ink-muted" data-testid="work-forecast">
      {`${plural(left.phases, 'phase')} left — about ${Math.max(1, Math.round(left.sessions))} session${
        Math.round(left.sessions) === 1 ? '' : 's'
      } at this plan’s measured size.`}
    </p>
  );
}
