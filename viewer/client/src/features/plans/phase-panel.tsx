import type { ReactNode } from 'react';
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
  StateChip,
  type Severity,
} from '@/components/ui';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { PromptCard } from '@/components/prompt-card';
import { WriteMenu } from '@/components/write-menu';
import { QaButton, QaRecoveryActions, QaVerdict } from '@/components/qa-launcher';
import { api } from '@/lib/api';
import { keys, useConsoleState, useGateStatus, useSessions } from '@/lib/queries';
import { canQa, liveQa, phaseQaMode } from '@/lib/qa';
import { QaModeControl } from '@/components/qa-mode-control';
import { countdown, pad2, plural, weight } from '@/lib/format';
import { handoffHref, phaseHref, planHref } from '@shared/routes.js';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { PhaseStateChip } from '@/features/runs/phase-row';
import { AskBox } from '@/features/runs/ask-box';
import { RecoveryActions } from '@/components/recovery-actions';
import { GateCard } from './gate-card';
import { ReviewCard, ReviewHoldBanner, ReviewVerdictChip } from './review-panel';

/** One labelled block of the plan's own prose. Absent fields render nothing. */
function Field({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <div>
      <h4 className="mb-1 font-display text-2xs uppercase tracking-wider text-ink-faint">{label}</h4>
      <Markdown text={text} />
    </div>
  );
}

/**
 * Say something to the session working THIS phase, from the plan.
 *
 * The run page has had Ask and Steer for a while; the plan surface — where an
 * operator actually reads what a phase is supposed to be doing, and therefore
 * where they first notice it going somewhere else — could only link away to it.
 * The deep link is on the state chip above; this is the other half of it.
 *
 * **The gate is `PhaseView.live`, the observed fact, never `view.state`.** The
 * board word `in-progress` is a line `phase_status()` grepped out of a markdown
 * file: it says a session once wrote "in-progress" in a handoff, not that
 * anything is running now. Offering a steer box over that is the same lie as
 * pulsing a chip over it (B2(a)), one keystroke louder — the operator types an
 * instruction, presses Steer, and it goes nowhere.
 *
 * And `via` matters as much as presence. Only `via: 'run'` is a lane THIS
 * console drives, which is the only case `steerRun` can serve — it resolves a
 * live runner by slug and refuses otherwise. A phase held by a lock file or
 * seen in the terminal registry is genuinely being worked, by a session this
 * console cannot write to, so it is told plainly rather than handed a box that
 * would answer 409.
 */
export function SteerCard({ slug, view, allowRun }: { slug: string; view: PhaseView; allowRun: boolean }) {
  const live = view.live;
  if (!live) return null;

  const driven = live.via === 'run';
  return (
    <Card data-testid="phase-steer">
      <CardHeader>
        <CardTitle className="text-sm normal-case">This phase is running</CardTitle>
        <Chip mono>via {live.via}</Chip>
      </CardHeader>
      {driven ? (
        <AskBox slug={slug} enabled={allowRun} allowRun={allowRun} phase={view.phase} />
      ) : (
        <CardBody>
          <p className="text-2xs text-ink-faint">
            {live.via === 'lock'
              ? 'A phase lock says a session holds this phase, but it is not a lane this console is driving — there is no stdin here to write to. Ask that session directly.'
              : 'This is a terminal session in the console’s registry, not an autopilot lane. Open it from Sessions to type into it.'}
          </p>
        </CardBody>
      )}
    </Card>
  );
}

/** A phase number as a chip-sized link — used for every dependency edge. */
function PhaseLink({ slug, phase, suffix }: { slug: string; phase: number; suffix?: ReactNode }) {
  return (
    <a
      href={phaseHref(slug, phase)}
      className="inline-flex items-center gap-1.5 rounded-sm border border-rule px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-muted hover:border-rule-strong hover:text-ink"
    >
      P{phase}
      {suffix}
    </a>
  );
}

export function PhasePanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const view = detail.phases.find((p) => p.phase === Number(phase));
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);
  // THIS phase's regime, never the plan's word alone: a phase carrying its own
  // `- **QA:** off` under a plan-wide `on` is held by nothing (2026-09-07).
  const qaMode = phaseQaMode(view, detail.summary.qaMode);

  // Asked for every gated phase — a prose-only human gate has a live verdict
  // too now (approval flips it), not just the machine-checkable ones. Ungated
  // phases still never shell out: they would ask for nothing.
  const { data: gate } = useGateStatus(slug, view?.phase, Boolean(view?.gated));

  if (!view) {
    return (
      <Empty
        title={`No phase ${phase} in this plan`}
        body="The plan's graph has no row with that number — the link that brought you here is older than the plan file, or the number was mistyped."
        action={
          <Button asChild size="sm">
            <a href={planHref(slug, 'phases')}>See every phase</a>
          </Button>
        }
      />
    );
  }

  const stateOf = (n: number) => detail.phases.find((p) => p.phase === n)?.state ?? 'unknown';
  const banner = promptBanner(view);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <Card>
          <CardHeader className="flex-wrap">
            <div className="flex min-w-0 items-start gap-3">
              <span className="font-mono text-2xl leading-none text-ink-faint">{pad2(view.phase)}</span>
              <div className="min-w-0">
                <CardTitle className="text-lg normal-case">
                  <MarkdownInline text={view.title} />
                </CardTitle>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <PhaseStateChip slug={slug} phase={view.phase} state={view.state} live={view.live} />
                  <Chip mono>{view.size}</Chip>
                  <Chip mono>{weight(view.weight)}</Chip>
                  {view.model && <Chip mono>{view.model}</Chip>}
                  {view.effort && <Chip mono>effort {view.effort}</Chip>}
                  {view.gated && (
                    <Chip tone="gate">
                      {view.gateKind && view.gateKind !== 'none' ? `gated·${view.gateKind}` : 'gated'}
                    </Chip>
                  )}
                  {view.mcpServers?.map((id) => (
                    <Chip key={id} mono>
                      mcp {id}
                    </Chip>
                  ))}
                  {view.analysis?.onCriticalPath && <Chip>critical path</Chip>}
                  <QaVerdict qa={view.qa} />
                  <ReviewVerdictChip {...(view.review ? { review: view.review } : {})} />
                </div>
              </div>
            </div>
            {view.handoff && (
              <Button asChild size="sm">
                <a href={handoffHref(slug, view.phase)}>Handoff</a>
              </Button>
            )}
          </CardHeader>

          <CardBody className="flex flex-col gap-4">
            <Field label="Goal" text={view.goal} />

            {(view.gated || view.gates) && (
              <GateCard slug={slug} view={view} gate={gate} allowWrites={Boolean(state?.allowWrites)} />
            )}

            {/* Above the gate's siblings and below the goal: a phase held by a
                review is not going to board however its gate reads, so the
                reader should meet that first. */}
            <ReviewHoldBanner slug={slug} view={view} />

            <SteerCard slug={slug} view={view} allowRun={Boolean(state?.allowRun)} />

            <Field label="Read first" text={view.readFirst} />
            <Field label="Files" text={view.files} />
            <Field label="Steps" text={view.steps} />
            <Field label="Exit criteria" text={view.exitCriteria} />
            <Field label="Verification" text={view.verification} />
            <Field label="Handoff must record" text={view.handoffMustRecord} />

            {!view.goal && !view.exitCriteria && (
              <Banner severity="info">
                This phase has a graph row but no <code className="font-mono">### Phase {view.phase}</code>{' '}
                section in the plan.
              </Banner>
            )}
          </CardBody>
        </Card>

        {/* A stuck phase's cause, in the handoff's own words — the banner says
            "prefer the recovery actions"; this says WHY, so the person is not
            sent to a terminal to find out. */}
        {view.state === 'stuck' && view.handoff?.outstanding && (
          <div className="rounded border border-rule bg-surface px-3 py-2">
            <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
              Why it is blocked — from the handoff
            </p>
            <p className="mt-1 max-w-prose text-2xs whitespace-pre-wrap text-ink-muted">
              {view.handoff.outstanding.slice(0, 900)}
              {view.handoff.outstanding.length > 900 ? '…' : ''}
            </p>
            <div className="mt-2">
              <RecoveryActions target={{ slug, phase: view.phase }} ctx={{ boardState: 'stuck' }} max={1} />
            </div>
          </div>
        )}
        {/* Every state, not just the two that can start. The prompt was hidden
            on a done or waiting phase because booting one is usually the wrong
            move — but "usually wrong" is a thing to SAY, and hiding it instead
            sent the one reader who legitimately needed it (re-running a phase,
            reading what a finished session was told, preparing the next one) to
            the CLI to print it by hand. Collapsed everywhere but `ready`, so the
            page still leads with the phase that can actually go. */}
        {/* Every state, like the boot prompt: a phase in flight has a working
            tree to read, a done one has its landing, and a `ready` one has
            neither — which the card says for itself rather than by being
            absent. Nothing is fetched until it is opened. */}
        <ReviewCard
          slug={slug}
          view={view}
          allowWrites={Boolean(state?.allowWrites)}
          allowRun={Boolean(state?.allowRun)}
        />
        <PromptCard
          title={`Boot prompt — phase ${view.phase}`}
          collapsed={view.state !== 'ready'}
          {...(banner ? { banner } : {})}
          queryKey={keys.prompt(slug, view.phase)}
          load={() => api.prompt(slug, view.phase)}
        />
        {qaMode === 'on' && view.state === 'done' && (
          <PromptCard
            title={`QA brief — phase ${view.phase}`}
            collapsed
            queryKey={keys.qaPrompt(slug, view.phase)}
            load={() => api.qaPrompt(slug, view.phase)}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {/* Inline, so a read-only console says what turning writes on would
            give you rather than showing an empty sidebar. */}
        <WriteMenu detail={detail} phase={view} allowWrites={Boolean(state?.allowWrites)} inline />

        {/* A phase nobody has started has no diff to read, so the control is
            absent rather than disabled there — "disabled" is for a capability
            the console HAS and cannot offer, which is what allowAgent is. */}
        {canQa(view.state) && (
          <Card>
            <CardHeader>
              <CardTitle>Quality</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
              <QaButton
                target={{
                  slug,
                  phase: view.phase,
                  title: view.title,
                  model: view.model,
                  effort: view.effort,
                  qaMode,
                  ...(view.qa ? { qa: view.qa } : {}),
                  planSkills: detail.plan?.sessionBudget?.skills ?? [],
                  planMcp: [
                    ...new Set([
                      ...(detail.plan?.sessionBudget?.mcpServers ?? []),
                      ...(view.mcpServers ?? []),
                    ]),
                  ],
                }}
                allowAgent={Boolean(state?.allowAgent)}
                allowWrites={Boolean(state?.allowWrites)}
                runningSessionId={liveQa(terminals?.sessions, { slug, phase: view.phase })?.id}
              />
              <p className="text-2xs text-ink-faint">
                {view.qa?.report ? (
                  <>
                    Last verdict recorded in <code className="font-mono">{view.qa.report}</code>.
                  </>
                ) : qaMode === 'off' ? (
                  'QA is off for this phase — the switch below turns it on, or the review dialog can.'
                ) : (
                  'A fresh session reviews the phase and records the verdict itself.'
                )}
              </p>
              {/* THIS phase's regime, switchable here — and, above it, the
                  plan's. A phase that opted out under a plan-wide `on` used
                  to be shown as held by its own verdict. */}
              <QaModeControl
                slug={slug}
                mode={detail.summary.qaMode}
                phase={view.phase}
                phaseMode={view.qaMode}
                allowWrites={Boolean(state?.allowWrites)}
                scriptsDir={state?.scriptsDir}
              />
              {/* Under the launcher and only when the gate is actually HOLDING
                  this phase — the component answers nothing otherwise. Issue
                  #11: a recorded `fail` (and a `pending`) holds every dependent
                  phase, and this card's one button used to be "review it
                  again", which is the right answer to a missing verdict and the
                  wrong one to a red one. */}
              <QaRecoveryActions
                slug={slug}
                phase={view.phase}
                qaMode={qaMode}
                scriptsDir={state?.scriptsDir}
                {...(view.qa ? { qa: view.qa } : {})}
                allowRun={Boolean(state?.allowRun)}
                allowWrites={Boolean(state?.allowWrites)}
                target={{
                  slug,
                  phase: view.phase,
                  title: view.title,
                  model: view.model,
                  effort: view.effort,
                  qaMode,
                  ...(view.qa ? { qa: view.qa } : {}),
                  planSkills: detail.plan?.sessionBudget?.skills ?? [],
                  planMcp: [
                    ...new Set([
                      ...(detail.plan?.sessionBudget?.mcpServers ?? []),
                      ...(view.mcpServers ?? []),
                    ]),
                  ],
                }}
              />
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Dependencies</CardTitle>
          </CardHeader>
          <CardBody>
            <KeyValue
              items={[
                [
                  'Depends on',
                  view.analysis?.dependsOn.length ? (
                    <div className="flex flex-wrap gap-1">
                      {view.analysis.dependsOn.map((d) => (
                        <PhaseLink key={d} slug={slug} phase={d} suffix={` · ${stateOf(d)}`} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-ink-faint">nothing — a root phase</span>
                  ),
                ],
                [
                  'Unblocks',
                  view.analysis?.dependents.length ? (
                    <div className="flex flex-wrap gap-1">
                      {view.analysis.dependents.map((d) => (
                        <PhaseLink key={d} slug={slug} phase={d} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-ink-faint">nothing downstream</span>
                  ),
                ],
                [
                  'Downstream total',
                  view.analysis?.transitiveDependents.length
                    ? `${plural(view.analysis.transitiveDependents.length, 'phase')} (${view.analysis.unblocks} still open)`
                    : null,
                ],
                [
                  'Parallel-safe with',
                  view.row?.parallelSafe && view.row.parallelSafe !== '—' ? view.row.parallelSafe : null,
                ],
                ['Repos', view.row?.repos],
                ['Exit criteria (graph)', view.row?.exitCriteria],
              ]}
            />
          </CardBody>
        </Card>

        {view.lock && (
          <Card>
            <CardHeader>
              <CardTitle>Lock</CardTitle>
            </CardHeader>
            <CardBody>
              <KeyValue
                items={[
                  ['Owner', <span className="font-mono break-all">{view.lock.owner}</span>],
                  [
                    'State',
                    view.lock.expired
                      ? 'expired — another session may take it over'
                      : countdown(view.lock.leaseUntil),
                  ],
                ]}
              />
            </CardBody>
          </Card>
        )}

        {view.handoff && (
          <Card>
            <CardHeader>
              <CardTitle>Handoff</CardTitle>
              <Button asChild size="sm">
                <a href={handoffHref(slug, view.phase)}>Open</a>
              </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <KeyValue
                items={[
                  [
                    'Status',
                    <StateChip state={handoffState(view.handoff.status)} label={view.handoff.status} />,
                  ],
                  ['Completed', view.handoff.completed],
                  ['Skills used', view.handoff.skillsUsed.join(', ')],
                  ['Prompts', view.handoff.prompts ? plural(view.handoff.prompts, 'boot prompt') : null],
                ]}
              />
              {view.handoff.outstanding && view.handoff.outstanding.toLowerCase() !== 'none' && (
                <div>
                  <h4 className="mb-1 font-display text-2xs uppercase tracking-wider text-ink-faint">
                    Outstanding
                  </h4>
                  <Markdown text={view.handoff.outstanding} />
                </div>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
/**
 * What to say above a boot prompt for a phase that is not `ready`.
 *
 * The prompt itself is always the engine's, byte for byte, whatever state the
 * phase is in — so this is the console's one honest addition: what booting a
 * session on it right now would actually run into. Each line names the wall
 * rather than the rule, because the walls are real and checkable (a lock, the
 * board, a gate) and an operator who knows which one they are about to hit can
 * decide for themselves whether that is what they meant.
 *
 * `ready` returns nothing: there is nothing to warn about, and a banner on
 * every card would train people to stop reading them.
 */
export function promptBanner(view: {
  state: string;
  gated?: boolean;
  gateKind?: string;
}): { severity: Severity; text: string } | undefined {
  // Checked before the state, because a gated phase can read as `ready` on the
  // board while the thing actually holding it is the gate.
  if (view.gated && view.state !== 'done') {
    if (view.gateKind === 'ai') {
      return {
        severity: 'info',
        text:
          'This phase has an ai-clearable gate — a booted session verifies and clears it ' +
          'before implementing, so booting IS the way through.',
      };
    }
    return {
      severity: 'warn',
      text: 'This phase is gated — a session booted now stops at the gate check until it clears.',
    };
  }
  switch (view.state) {
    case 'ready':
      return undefined;
    case 'in-progress':
      return {
        severity: 'warn',
        text:
          'A session is already on this phase — phase-lock will refuse a second one. ' +
          'Take it over deliberately (--force) or pick another phase.',
      };
    case 'done':
      return {
        severity: 'info',
        text:
          'This phase has departed — the prompt is kept for reference, and for re-running it ' +
          'on purpose.',
      };
    case 'stuck':
    case 'blocked':
      return {
        severity: 'warn',
        text:
          'This phase is blocked — prefer the recovery actions, which brief a session on what ' +
          'went wrong, over booting a fresh one that will not know.',
      };
    default:
      return {
        severity: 'warn',
        text:
          'Dependencies are not met — a session booted now stops at the lock and board checks ' +
          'its own boot prompt tells it to run.',
      };
  }
}

/**
 * A handoff's own status vocabulary, mapped onto the phase palette.
 *
 * `complete`/`blocked` are handoff words; `done`/`stuck` are what the map and
 * the chips paint. Keeping the mapping in one exported function is what stops
 * the handoffs table and the phase panel from drifting into two answers.
 */
export function handoffState(status: string): string {
  if (status === 'complete') return 'done';
  if (status === 'blocked') return 'stuck';
  return status;
}
