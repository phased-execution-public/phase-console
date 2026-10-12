/**
 * One phase, as its own page — `#/plan/:slug/phase/:n` (7.0, quiet-console
 * phase 10).
 *
 * One column, in the order a person reads a phase they came to act on: what it
 * is and where it stands (the title, its mark and its facts in words), then
 * what it is for (the goal), what stands in its way (the gate, a review's hold,
 * a stuck handoff's own words with the way forward), what is happening on it
 * now (the steer box), the plan's words for it, the prompts a session boards
 * with, the review of what it changed, its quality, its handoff, its place in
 * the graph, its claim — and last, the writes a person can make to it.
 *
 * The plan around it was read with the phase's projection (`TAB_INCLUDES.phase`
 * — the prose and the handoffs' Outstanding sections), so every field here is
 * on the wire already; what costs a subprocess (a prompt, the diff, the gate's
 * live reading) is asked for only by the fold or card that draws it.
 */

import { useId, type ReactNode } from 'react';
import type { PhaseLiveVia, PhaseView, PlanDetail } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useSessions } from '@/data/sessions';
import { cn } from '@/lib/cn';
import { countdown, plural, weight } from '@/lib/format';
import { canQa, liveQa, phaseQaMode, qaReportHref } from '@/lib/qa';
import { boardStateTitle } from '@/lib/status-vocab';
import { Banner, Button, Empty, KeyValue, Mono, RelativeTime, SectionHeading, type Severity } from '@/ui';
import { Markdown, MarkdownInline } from '@/ui/markdown';
import { OpsStatus, PhaseStatus, type WordOf } from '@/ui/status';
import { RecoveryActions } from '@/cards/recovery-actions';
import { WriteMenu } from '@/screens/plans/write-menu';
import { handoffHref, planHref } from '@/shell/routes';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { AskBox } from '../run/ask';
import { PhaseLink } from './cells';
import { PhaseGate } from './gate-card';
import { PromptFold } from './prompt';
import { QaButton, QaRecoveryActions, QaVerdict, type QaTarget } from './qa-launcher';
import { QaModeControl } from './qa-mode';
import { ReviewCard, ReviewHoldBanner, ReviewVerdictWord } from './review';
import { PhaseMark } from './row';

/** A card: a thing acted on as a unit — a tone and a hairline, never a shadow. */
const CARD = 'rounded-lg border border-rule bg-surface p-4 sm:p-5';

/** How much of a stuck handoff's Outstanding the card quotes before the handoff page takes over. */
const OUTSTANDING_QUOTED = 900;

/** One section of the page: an `h2` naming it, and what it holds. */
function Section({
  title,
  aside,
  card = false,
  testId,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  card?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-testid={testId}
      className={cn('flex min-w-0 flex-col gap-2', card && CARD)}
    >
      <SectionHeading id={heading} aside={aside}>
        {title}
      </SectionHeading>
      {children}
    </section>
  );
}

/* ---------------- steering ---------------- */

/** How the console sees the session working the phase — the witness, in words. */
const VIA_WORDS: Record<PhaseLiveVia, string> = {
  run: 'a lane this console drives',
  lock: 'a phase lock',
  registry: 'the session registry',
};

/**
 * Say something to the session working THIS phase, from the plan.
 *
 * **Offered on `PhaseView.live`, the observed fact, never on `view.state`.**
 * The board word `in-progress` is a line grepped out of a handoff: it says a
 * session once wrote "in-progress", not that anything is running now, and a
 * box over it takes an instruction and drops it. Nothing renders without it.
 *
 * And `via` matters as much as presence: only `via: 'run'` is a lane THIS
 * console drives, which is the only case a message can reach. A phase held by
 * a lock or seen in the session registry is being worked by a session this
 * console cannot write to, so the card says where to go instead of offering a
 * box that would answer 409.
 */
export function SteerCard({ slug, view, allowRun }: { slug: string; view: PhaseView; allowRun: boolean }) {
  const heading = useId();
  const live = view.live;
  if (!live) return null;
  return (
    <section
      aria-labelledby={heading}
      data-testid="phase-steer"
      className={cn('flex min-w-0 flex-col gap-2', CARD)}
    >
      <SectionHeading id={heading}>This phase is running</SectionHeading>
      <p className="text-meta text-ink-muted">Seen through {VIA_WORDS[live.via] ?? live.via}.</p>
      {live.via === 'run' ? (
        <AskBox slug={slug} enabled={allowRun} allowRun={allowRun} phase={view.phase} />
      ) : (
        <p className="max-w-(--measure) text-body text-ink-muted">
          {live.via === 'lock'
            ? 'A phase lock says a session holds this phase, but it is not a lane this console is driving: there is no input here to write to. Ask that session directly.'
            : 'This is a terminal session in the console’s registry, not an autopilot lane. Open it from Sessions to type into it.'}
        </p>
      )}
    </section>
  );
}

/* ---------------- the boot prompt's caution ---------------- */

/**
 * What to say above a boot prompt for a phase that is not `ready`.
 *
 * The prompt itself is the engine's, byte for byte, whatever state the phase
 * is in — so this is the console's one addition: what booting a session on it
 * right now would run into. Each line names the wall rather than the rule (a
 * lock, the board, a gate), because the walls are real and checkable. `ready`
 * says nothing: a caution on every card trains people to stop reading them.
 */
export function promptBanner(view: {
  state: string;
  gated?: boolean;
  gateKind?: string;
}): { severity: Severity; text: string } | undefined {
  // Before the state: a gated phase can read `ready` while the gate holds it.
  if (view.gated && view.state !== 'done') {
    if (view.gateKind === 'ai') {
      return {
        severity: 'info',
        text:
          'This phase has a gate the AI clears: a booted session verifies and clears it before implementing, ' +
          'so booting is the way through.',
      };
    }
    return {
      severity: 'warn',
      text: 'This phase is gated: a session booted now stops at the gate check until it clears.',
    };
  }
  switch (view.state) {
    case 'ready':
      return undefined;
    case 'in-progress':
      return {
        severity: 'warn',
        text:
          'A session is already on this phase, and phase-lock will refuse a second one. ' +
          'Take it over deliberately (--force) or pick another phase.',
      };
    case 'done':
      return {
        severity: 'info',
        text: 'This phase is done. The prompt is kept for reference, and for re-running it on purpose.',
      };
    case 'stuck':
    case 'blocked':
      return {
        severity: 'warn',
        text:
          'This phase is blocked. Prefer the ways forward, which brief a session on what went wrong, ' +
          'over booting a fresh one that will not know.',
      };
    default:
      return {
        severity: 'warn',
        text:
          'Its dependencies are not met: a session booted now stops at the lock and board checks its own ' +
          'boot prompt tells it to run.',
      };
  }
}

/* ---------------- the sections ---------------- */

/** The phase's facts beside its mark, each its own words. */
function PhaseFacts({ slug, view }: { slug: string; view: PhaseView }) {
  const gateKind = view.gateKind && view.gateKind !== 'none' ? view.gateKind : null;
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-meta text-ink-muted">
      <PhaseMark slug={slug} phase={view.phase} state={view.state} live={view.live} size="md" />
      {view.gated && (
        <span className="text-ink" title={boardStateTitle('gated')}>
          gated{gateKind ? ` (${gateKind})` : ''}
        </span>
      )}
      <span>
        {view.size}, weight {weight(view.weight)}
      </span>
      {view.model && (
        <span>
          model <Mono value={view.model} />
        </span>
      )}
      {view.effort && <span>effort {view.effort}</span>}
      {view.mcpServers?.length ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          MCP
          {view.mcpServers.map((id) => (
            <Mono key={id} value={id} />
          ))}
        </span>
      ) : null}
      {view.analysis?.onCriticalPath && <span>on the critical path</span>}
      <QaVerdict qa={view.qa} href={qaReportHref(slug, view.phase, view.qaRounds?.latest.round)} />
      <ReviewVerdictWord review={view.review} />
    </p>
  );
}

/** The plan's own words for the phase, each field under its name — or the plain fact that it wrote none. */
function PhaseWords({ view }: { view: PhaseView }) {
  if (!view.goal && !view.exitCriteria) {
    return (
      <Banner severity="info">
        This phase has a graph row but no <code className="font-mono">### Phase {view.phase}</code> section in
        the plan.
      </Banner>
    );
  }
  const fields: [label: string, text: string | undefined][] = [
    ['Read first', view.readFirst],
    ['Files', view.files],
    ['Steps', view.steps],
    ['Exit criteria', view.exitCriteria],
    ['Verification', view.verification],
    ['Handoff must record', view.handoffMustRecord],
  ];
  const written = fields.filter(([, text]) => Boolean(text));
  if (!written.length) return null;
  return (
    <Section title="The phase as written">
      <div className="flex min-w-0 flex-col gap-4">
        {written.map(([label, text]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1">
            <SectionHeading as="h3">{label}</SectionHeading>
            <Markdown text={text} className="min-w-0 max-w-(--measure)" />
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Why a stuck phase stopped, in its handoff's words, and the way forward the model recommends. */
function StuckCard({ slug, view }: { slug: string; view: PhaseView }) {
  const outstanding = view.handoff?.outstanding;
  if (view.state !== 'stuck' || !outstanding) return null;
  return (
    <Section title="Why it is blocked" card testId="phase-stuck">
      <p className="text-meta text-ink-muted">In its handoff’s words:</p>
      <p className="max-w-(--measure) whitespace-pre-wrap break-words text-body text-ink">
        {outstanding.slice(0, OUTSTANDING_QUOTED)}
        {outstanding.length > OUTSTANDING_QUOTED ? '…' : ''}
      </p>
      <RecoveryActions
        target={{ slug, phase: view.phase }}
        ctx={{ boardState: 'stuck' }}
        max={1}
        parts={ACCOUNT_RECOVERY_PARTS}
      />
    </Section>
  );
}

/** The phase's quality: start a review, the regime it is judged by, and the verbs when a verdict holds. */
function Quality({ detail, view }: { detail: PlanDetail; view: PhaseView }) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  const { data: terminals } = useSessions(state);
  // THIS phase's regime, never the plan's word alone: a phase carrying its own
  // `- **QA:** off` under a plan-wide `on` is held by nothing.
  const qaMode = phaseQaMode(view, detail.summary.qaMode);
  const running = liveQa(terminals?.sessions, { slug, phase: view.phase });
  const allowWrites = Boolean(state?.allowWrites);
  const target: QaTarget = {
    slug,
    phase: view.phase,
    title: view.title,
    ...(view.model ? { model: view.model } : {}),
    ...(view.effort ? { effort: view.effort } : {}),
    ...(qaMode ? { qaMode } : {}),
    ...(view.qa ? { qa: view.qa } : {}),
    planSkills: detail.plan?.sessionBudget?.skills ?? [],
    planMcp: [...new Set([...(detail.plan?.sessionBudget?.mcpServers ?? []), ...(view.mcpServers ?? [])])],
  };
  return (
    <Section title="Quality" testId="phase-quality">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <QaButton
          target={target}
          allowAgent={Boolean(state?.allowAgent)}
          allowWrites={allowWrites}
          {...(running ? { runningSessionId: running.id } : {})}
        />
      </span>
      <p className="max-w-(--measure) text-meta text-ink-muted">
        {view.qa?.report ? (
          <>
            The last verdict is recorded in <Mono value={view.qa.report} />.
          </>
        ) : qaMode === 'off' ? (
          'QA is off for this phase. The switch below turns it on, or the review form can.'
        ) : (
          'A fresh session reviews the phase and records the verdict itself.'
        )}
      </p>
      <QaModeControl
        slug={slug}
        mode={detail.summary.qaMode}
        phase={view.phase}
        {...(view.qaMode ? { phaseMode: view.qaMode } : {})}
        allowWrites={allowWrites}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
      />
      {/* Drawn only while the gate HOLDS this phase: a recorded `fail` (or a
          `pending`) holds every dependent, and "review it again" is the wrong
          answer to a red verdict. */}
      <QaRecoveryActions
        slug={slug}
        phase={view.phase}
        {...(qaMode ? { qaMode } : {})}
        {...(view.qa ? { qa: view.qa } : {})}
        allowRun={Boolean(state?.allowRun)}
        allowWrites={allowWrites}
        {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
        target={target}
      />
    </Section>
  );
}

/** The handoff's facts and what it left outstanding — the page itself is one press away. */
function HandoffSection({ slug, view }: { slug: string; view: PhaseView }) {
  const h = view.handoff;
  if (!h) return null;
  const outstanding = h.outstanding && h.outstanding.trim().toLowerCase() !== 'none' ? h.outstanding : null;
  return (
    <Section
      title="Handoff"
      testId="phase-handoff"
      aside={
        <Button asChild size="sm">
          <a href={handoffHref(slug, view.phase)}>Read the handoff</a>
        </Button>
      }
    >
      <KeyValue
        items={[
          ['Status', <OpsStatus vocab="handoff" word={h.status as WordOf<'handoff'>} />],
          ['Completed', h.completed],
          [
            'Skills used',
            h.skillsUsed.length ? (
              <span className="flex min-w-0 flex-wrap gap-x-2">
                {h.skillsUsed.map((skill) => (
                  <Mono key={skill} value={skill} />
                ))}
              </span>
            ) : null,
          ],
          ['Prompts', h.prompts ? plural(h.prompts, 'boot prompt') : null],
        ]}
      />
      {outstanding && (
        <div className="flex min-w-0 flex-col gap-1">
          <SectionHeading as="h3">Outstanding</SectionHeading>
          <Markdown text={outstanding} className="min-w-0 max-w-(--measure)" />
        </div>
      )}
    </Section>
  );
}

/** Phases as links, each with its board word beside it when the plan knows it. */
function PhaseEdges({
  slug,
  phases,
  stateOf,
}: {
  slug: string;
  phases: readonly number[];
  stateOf?: (n: number) => string | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
      {phases.map((n) => {
        const state = stateOf?.(n);
        return (
          <span key={n} className="inline-flex items-baseline gap-x-2">
            <PhaseLink slug={slug} phase={n} />
            {state && <PhaseStatus board={state as WordOf<'board'>} title={boardStateTitle(state)} />}
          </span>
        );
      })}
    </span>
  );
}

/** Where the phase sits in the graph: what it waits on, what waits on it, and what it may run beside. */
function Dependencies({ detail, view }: { detail: PlanDetail; view: PhaseView }) {
  const slug = detail.summary.slug;
  const a = view.analysis;
  const stateOf = (n: number) => detail.phases.find((p) => p.phase === n)?.state;
  const parallel = view.row?.parallelSafe && view.row.parallelSafe !== '—' ? view.row.parallelSafe : null;
  return (
    <Section title="Dependencies" testId="phase-dependencies">
      <KeyValue
        items={[
          [
            'Depends on',
            a?.dependsOn.length ? (
              <PhaseEdges slug={slug} phases={a.dependsOn} stateOf={stateOf} />
            ) : (
              <span className="text-ink-muted">nothing, it is a root phase</span>
            ),
          ],
          [
            'Unblocks',
            a?.dependents.length ? (
              <PhaseEdges slug={slug} phases={a.dependents} />
            ) : (
              <span className="text-ink-muted">nothing downstream</span>
            ),
          ],
          [
            'Downstream in all',
            a?.transitiveDependents.length
              ? `${plural(a.transitiveDependents.length, 'phase')}, ${a.unblocks} still open`
              : null,
          ],
          ['Parallel-safe with', parallel],
          ['Repos', view.row?.repos ? <Mono value={view.row.repos} /> : null],
          ['Exit criteria in the graph', view.row?.exitCriteria],
        ]}
      />
    </Section>
  );
}

/** Who holds the phase, from where, and for how much longer — a lapsed lease only warns. */
function Claim({ view }: { view: PhaseView }) {
  const lock = view.lock;
  if (!lock) return null;
  return (
    <Section title="Claim" testId="phase-claim">
      <KeyValue
        items={[
          ['Claimed by', <Mono value={lock.owner} className="wrap-anywhere" />],
          ['Host', lock.host ? <Mono value={lock.host} /> : null],
          ['Claimed', lock.claimedAt ? <RelativeTime at={lock.claimedAt} /> : null],
          [
            'Lease',
            lock.expired ? 'lapsed, another session may take it over' : countdown(lock.leaseUntil) || null,
          ],
          [
            'Scope',
            lock.scope?.length ? (
              <Mono value={lock.scope.join(', ')} />
            ) : (
              'unstated, so it collides with everything'
            ),
          ],
        ]}
      />
    </Section>
  );
}

/* ---------------- the page ---------------- */

export function PhasePanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const view = detail.phases.find((p) => p.phase === Number(phase));
  const { data: state } = useConsoleState();
  const title = useId();

  if (!view) {
    return (
      <Empty
        title={`The plan has no phase ${phase ?? ''}: the link is older than the plan file, or the number was mistyped.`}
        action={
          <Button asChild size="sm">
            <a href={planHref(slug, 'phases')}>See every phase</a>
          </Button>
        }
      />
    );
  }

  const qaMode = phaseQaMode(view, detail.summary.qaMode);
  const allowWrites = Boolean(state?.allowWrites);
  const allowRun = Boolean(state?.allowRun);

  return (
    <article aria-labelledby={title} className="flex min-w-0 flex-col gap-6" data-testid="phase-page">
      <header className="flex min-w-0 flex-col gap-2">
        <h1 id={title} className="min-w-0 max-w-(--measure) break-words text-title font-semibold text-ink">
          <span className="text-ink-muted">Phase {view.phase}</span> <MarkdownInline text={view.title} />
        </h1>
        <PhaseFacts slug={slug} view={view} />
      </header>

      {view.goal && (
        <Section title="Goal">
          <Markdown text={view.goal} className="min-w-0 max-w-(--measure)" />
        </Section>
      )}

      {/* A phase with no gate never shells out for one. */}
      {(view.gated || view.gates) && <PhaseGate slug={slug} phase={view.phase} />}

      {/* Before the rest: a phase a review holds is not going to board however
          its gate reads, so the reader meets that first. */}
      <ReviewHoldBanner slug={slug} view={view} />

      <SteerCard slug={slug} view={view} allowRun={allowRun} />

      <StuckCard slug={slug} view={view} />

      <PhaseWords view={view} />

      {/* Every state, not only the two that can start — re-running a phase,
          reading what a finished session was told, preparing the next one —
          but open by default only where booting is the move. */}
      <Section title="Prompts">
        <PromptFold
          slug={slug}
          phase={view.phase}
          title={`Boot prompt for phase ${view.phase}`}
          banner={promptBanner(view)}
          defaultOpen={view.state === 'ready'}
        />
        {qaMode === 'on' && view.state === 'done' && (
          <PromptFold slug={slug} phase={view.phase} kind="qa" title={`QA brief for phase ${view.phase}`} />
        )}
      </Section>

      <ReviewCard slug={slug} view={view} allowWrites={allowWrites} allowRun={allowRun} />

      {/* A phase nobody has started has no diff to review, so the section is
          absent rather than disabled there. */}
      {canQa(view.state) && <Quality detail={detail} view={view} />}

      <HandoffSection slug={slug} view={view} />

      <Dependencies detail={detail} view={view} />

      <Claim view={view} />

      {/* Inline, so a read-only console says what turning writes on would give. */}
      <WriteMenu detail={detail} phase={view} allowWrites={allowWrites} inline />
    </article>
  );
}
