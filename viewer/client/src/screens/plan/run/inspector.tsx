/**
 * The run in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 11; design.md principle 3).
 *
 * The run record is the longest thing the console keeps about a plan: how it
 * boards its phases and as whom, what every session is handed, what
 * verification and QA may do, what it waits on, where it stands in the queue,
 * which walls and permissions bound it, where its work stands on disk and what
 * it cost. Overview says all of it in words, in the eight sections the phase
 * inspector uses — each one press away, every one open with the page's
 * Everything on — including the fields the 6.x run page never drew. Actions is
 * the run's own tab (`RunActions`, the six acts and every other verb); History
 * is its story newest first; Raw is the record whole, exactly as the server
 * sent it.
 */

import type { ReactNode } from 'react';
import { BLOCKED_BY_ORDER, type HolderClass } from '@shared/run-lifecycle.js';
import { ISOLATED, settleOf } from '@shared/worktree-model.js';
import type { ConsoleState } from '@/data/api';
import type { PhaseOptions, RunState } from '@/data/api/runs';
import { countdown, duration, money, plural } from '@/lib/format';
import { KeyValue, Money, Mono, RelativeTime, type KeyValueItem } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { useEverything } from '@/ui/everything';
import { RunStatus } from '@/ui/status';
import { HistoryTab, type HistoryEntry } from '@/shell/panel/history-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { RunActions } from './actions';

/* ------------------------------------------------------------------------- *
 * Words for the record's values
 * ------------------------------------------------------------------------- */

const when = (iso: string | undefined | null): ReactNode =>
  iso ? <RelativeTime at={iso} live={false} /> : null;

/**
 * A moment still to come — its clock time and how long until it. `RelativeTime`
 * speaks of the past, and would call a wait's end an hour away "just now".
 */
const ahead = (iso: string | undefined | null): ReactNode => {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  if (at <= Date.now()) return when(iso);
  const clock = new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <time dateTime={iso} title={iso}>
      {clock}, {countdown(at)}
    </time>
  );
};

const count = (value: number | undefined | null): string | null => (value ? String(value) : null);

const list = (values: readonly string[] | undefined | null): string | null =>
  values?.length ? values.join(', ') : null;

const usd = (value: number | undefined | null): ReactNode =>
  value && value > 0 ? <Money usd={value} /> : null;

/** Several lines under one label — each its own line, never joined with dots. */
function Lines({ lines }: { lines: readonly ReactNode[] }) {
  if (!lines.length) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {lines.map((line, i) => (
        <li key={i} className="min-w-0 break-words">
          {line}
        </li>
      ))}
    </ul>
  );
}

const fact = (label: string, value: ReactNode): KeyValueItem =>
  value == null || value === '' || value === false ? null : [label, value];

/** Whose claim held the run in the queue, as the queue's split names it. */
const HOLDER_WORDS: Readonly<Record<HolderClass, string>> = {
  'own-run': 'its own lanes',
  'other-run': 'another run',
  hand: 'a person',
  clock: 'a clock or a cap',
};

/** One phase's own choices, as one line: only what it says. */
function choicesOf(options: PhaseOptions): string {
  return [
    options.model && `model ${options.model}`,
    options.effort && `effort ${options.effort}`,
    options.permissionMode && `mode ${options.permissionMode}`,
    options.tools?.length && `tools ${options.tools.join(', ')}`,
    options.skills?.length && `skills ${options.skills.join(', ')}`,
    options.skillsOff && 'without the run’s skills',
    options.mcpServers?.length && `MCP ${options.mcpServers.join(', ')}`,
    options.mcpOff && 'without the run’s MCP servers',
    options.mcpPolicy && `an unreachable server: ${options.mcpPolicy}`,
    options.autoApprove != null &&
      (options.autoApprove ? 'the console answers its asks' : 'a person answers its asks'),
  ]
    .filter(Boolean)
    .join(', ');
}

/* ------------------------------------------------------------------------- *
 * The eight sections
 * ------------------------------------------------------------------------- */

export interface RunRecordSection {
  id: string;
  label: string;
  facts: (run: RunState, state?: ConsoleState) => KeyValueItem[];
}

function boarding(run: RunState): KeyValueItem[] {
  const records = Object.values(run.phases ?? {});
  const byStatus = new Map<string, number>();
  for (const record of records) byStatus.set(record.status, (byStatus.get(record.status) ?? 0) + 1);
  const lanes =
    run.children && Object.keys(run.children).length
      ? Object.values(run.children)
      : run.child
        ? [run.child]
        : [];
  const recoveries = Object.entries(run.recoveries ?? {});
  const models = Object.entries(run.resolvedModels ?? {});
  const manifest = run.manifest;
  return [
    fact('Started', when(run.createdAt)),
    fact('Last written', when(run.updatedAt)),
    fact(
      'Phases on record',
      records.length
        ? `${records.length} (${[...byStatus].map(([status, n]) => `${n} ${status}`).join(', ')})`
        : null,
    ),
    fact('Active phase', run.activePhase != null ? `phase ${run.activePhase}` : null),
    fact('Only these phases', run.onlyPhases?.length ? run.onlyPhases.join(', ') : null),
    fact('Autonomy', run.autonomy),
    fact(
      'Model',
      run.model ? (
        <>
          <Mono value={run.model} />
          {run.effort ? ` at ${run.effort}` : ''}
        </>
      ) : null,
    ),
    fact('Model policy', run.modelPolicy),
    fact(
      'Models resolved',
      models.length ? (
        <Lines
          lines={models.map(([asked, seen]) => (
            <>
              <Mono value={asked} /> as <Mono value={seen.resolved} />
              {seen.from ? (
                <>
                  , moved from <Mono value={seen.from} />
                </>
              ) : null}
              , {when(seen.at)}
            </>
          ))}
        />
      ) : null,
    ),
    fact('Account', run.accountId ? <Mono value={run.accountId} /> : null),
    fact(
      'Bound to',
      run.identity ? (
        <>
          {run.identity.email ?? run.identity.account}
          {run.identity.org ? `, ${run.identity.org}` : ''}, {when(run.identity.at)}
        </>
      ) : null,
    ),
    fact(
      'Last switch by a person',
      run.accountChoice ? (
        <>
          to <Mono value={run.accountChoice.accountId} /> from <Mono value={run.accountChoice.from} />, by{' '}
          {run.accountChoice.by}, {when(run.accountChoice.at)}
        </>
      ) : null,
    ),
    fact(
      'Switched away from',
      run.switchedFrom ? (
        <>
          <Mono value={run.switchedFrom.accountId} />, {run.switchedFrom.reason}, {when(run.switchedFrom.at)};
          back after its reset, {ahead(run.switchedFrom.resetsAt)}
        </>
      ) : null,
    ),
    fact(
      'Accounts it may spend',
      run.accounts?.length
        ? run.accounts.map((a) => `${a.id} at ${a.minHeadroomPct} % headroom or more`).join(', ')
        : null,
    ),
    fact(
      'After a console restart',
      run.resumeOnRestart == null ? null : run.resumeOnRestart ? 'it resumes by itself' : 'it asks a person',
    ),
    fact('Waivers acknowledged', list(run.acknowledgedWaivers)),
    fact(
      'Start door',
      manifest ? (
        <>
          {plural(manifest.decisions.length, 'decision')} resolved
          {manifest.overridden
            ? `, ${plural(manifest.overridden.rows.length, 'row')} overridden by ${manifest.overridden.by}`
            : ''}
          , {when(manifest.at)}
        </>
      ) : null,
    ),
    fact(
      'Live lanes',
      lanes.length ? (
        <Lines
          lines={lanes.map((lane) => (
            <>
              phase {lane.phase}, pid {lane.pid}, session <Mono value={lane.sessionId} chars={8} />
              {lane.frozen ? `, frozen by ${lane.frozen.by}` : ''}
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Lane beat',
      run.laneBeat ? (
        <>
          {when(run.laneBeat.at)}, from the console at pid {run.laneBeat.pid}
        </>
      ) : null,
    ),
    fact(
      'Recoveries',
      recoveries.length ? (
        <Lines
          lines={recoveries.map(
            ([key, slot]) =>
              `${key === 'plan' ? 'the plan' : `phase ${key}`}: ${plural(slot.attempts, 'attempt')}${
                slot.lastOutcome ? `, last ${slot.lastOutcome}` : ''
              }${slot.rungs?.length ? `, ${plural(slot.rungs.length, 'rung')} climbed` : ''}${
                slot.errand ? ', an errand open' : ''
              }`,
          )}
        />
      ) : null,
    ),
    fact('Heals its own halts', run.autoRecover ? 'yes' : null),
  ];
}

function context(run: RunState): KeyValueItem[] {
  const notes = run.notes ?? [];
  const pinned = notes.filter((note) => note.pinned);
  const options = Object.entries(run.phaseOptions ?? {})
    .map(([phase, choice]) => [phase, choicesOf(choice)] as const)
    .filter(([, words]) => words);
  return [
    fact('Skills', list(run.skills)),
    fact('MCP servers', list(run.mcpServers)),
    fact(
      'An unreachable server',
      run.mcpPolicy === 'require' ? 'parks the phase' : run.mcpPolicy ? 'boards without it' : null,
    ),
    fact(
      'Per-phase choices',
      options.length ? <Lines lines={options.map(([phase, words]) => `phase ${phase}: ${words}`)} /> : null,
    ),
    fact('Ultracode licence', run.ultracode ? 'in every prompt' : null),
    fact('Messaging', run.messaging),
    fact(
      'Pinned notes',
      pinned.length ? (
        <Lines
          lines={pinned.map((note) => `${note.text}${note.phase != null ? ` (phase ${note.phase})` : ''}`)}
        />
      ) : null,
    ),
    fact('Notes', notes.length ? plural(notes.length, 'note') : null),
    fact('Rulings this run', run.rulings?.length ? plural(run.rulings.length, 'ruling') : null),
  ];
}

function verification(run: RunState): KeyValueItem[] {
  const lanes = Object.values(run.verifying ?? {});
  const answers = run.verifyApprovals;
  return [
    fact(
      'Verifying now',
      lanes.length ? (
        <Lines
          lines={lanes.map((lane) => (
            <>
              phase {lane.phase}, {lane.stage === 'setup' ? 'its setup' : lane.purpose}, command {lane.index}{' '}
              of {lane.total}: <Mono value={lane.command} />
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Start-door answers',
      answers ? (
        <>
          {plural(answers.approve.length, 'command')} approved, {plural(answers.waive.length, 'fragment')} set
          aside{answers.by ? `, by ${answers.by}` : ''}
          {answers.at ? <>, {when(answers.at)}</> : null}
        </>
      ) : null,
    ),
    fact(
      'Approved commands',
      answers?.approve.length ? (
        <Lines
          lines={answers.approve.map((a) => (
            <Mono value={a.text} />
          ))}
        />
      ) : null,
    ),
    fact(
      'Set aside',
      answers?.waive.length ? (
        <Lines
          lines={answers.waive.map((w) => (
            <>
              phase {w.phase}: <Mono value={w.text} />
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Halts after',
      run.maxConsecutiveFailures > 0 ? `${plural(run.maxConsecutiveFailures, 'failure')} in a row` : null,
    ),
    fact(
      'Failure streak',
      run.consecutiveFailures
        ? `${run.consecutiveFailures} of ${run.maxConsecutiveFailures}${
            run.failureStreak?.length ? `, phases ${run.failureStreak.join(', ')}` : ''
          }`
        : null,
    ),
    fact(
      'Charged on',
      run.failureRoots?.length ? (
        <Lines lines={run.failureRoots.map((root) => `phase ${root.phase}: ${root.label}`)} />
      ) : null,
    ),
    fact(
      'QA model',
      run.qaModel ? (
        <>
          <Mono value={run.qaModel} />
          {run.qaEffort ? ` at ${run.qaEffort}` : ''}
        </>
      ) : run.qaEffort ? (
        `the phase’s, at ${run.qaEffort}`
      ) : null,
    ),
    fact('QA rounds before a person', count(run.qaMaxRounds)),
    fact('QA fix sessions', run.qaFixStrategy),
    fact('QA round budget', usd(run.qaRoundBudgetUsd)),
    fact(
      'Reviewer each phase',
      run.reviewEachPhase ? `on${run.reviewerPolicy ? `, ${run.reviewerPolicy}` : ''}` : null,
    ),
    fact('Ultrareview', run.ultraReview && run.ultraReview !== 'off' ? run.ultraReview : null),
  ];
}

function waits(run: RunState): KeyValueItem[] {
  const lifecycle = run.lifecycle;
  return [
    fact(
      'Waiting until',
      run.waitUntil ? (
        <>
          {ahead(run.waitUntil)}
          {run.waitReason ? `, on ${run.waitReason}` : ''}
        </>
      ) : null,
    ),
    fact('Waiting on', !run.waitUntil ? run.waitReason : null),
    fact(
      'Lifecycle',
      lifecycle
        ? `${lifecycle.state}${lifecycle.wait ? `, a ${lifecycle.wait.kind} wait` : ''}${
            lifecycle.pending ? `, ${lifecycle.pending} landing` : ''
          }${lifecycle.frozen ? ', frozen' : ''}`
        : null,
    ),
    fact(
      'Pause asked',
      run.pause ? (
        <>
          by {run.pause.by}
          {run.pause.afterPhase != null ? `, after phase ${run.pause.afterPhase}` : ''},{' '}
          {when(run.pause.requestedAt)}
        </>
      ) : null,
    ),
    fact(
      'Frozen',
      run.freeze ? (
        <>
          by {run.freeze.by}
          {run.freeze.phase != null ? `, phase ${run.freeze.phase}` : ''}, {when(run.freeze.at)}
          {run.freeze.escalateAt ? <>, a checkpoint at {ahead(run.freeze.escalateAt)}</> : ', standing'}
        </>
      ) : null,
    ),
    // The halt's sentence is the halt card's to say (the Run view); here, which stop and when.
    fact(
      'Halt',
      run.halt ? (
        <>
          {run.halt.kind ?? 'stopped'}
          {run.halt.phase != null ? `, phase ${run.halt.phase}` : ''}, {when(run.halt.at)}
        </>
      ) : null,
    ),
    fact('Raised by the card', run.halt?.approvalId ? <Mono value={run.halt.approvalId} /> : null),
    fact('Errand', run.errand ? `phase ${run.errand.phase}: ${run.errand.need}` : null),
    fact('Stopped by', run.stoppedBy),
    fact('Finished', run.finishedReason),
    fact(
      'Resolved',
      run.resolved ? (
        <>
          {run.resolved.auto ? 'by the board' : `by ${run.resolved.by ?? 'a person'}`}: {run.resolved.reason}
          {run.resolved.note ? `, ${run.resolved.note}` : ''}, {when(run.resolved.at)}
        </>
      ) : null,
    ),
    fact('Put back by a person', when(run.reopenedAt)),
    fact('Issue drafts waiting', count(run.pendingDrafts)),
    fact(
      'Nothing changed since',
      run.converge ? (
        <>
          {when(run.converge.at)}, the evidence <Mono value={run.converge.lastNoop} chars={12} />
        </>
      ) : null,
    ),
  ];
}

function queue(run: RunState, state?: ConsoleState): KeyValueItem[] {
  const blocked = BLOCKED_BY_ORDER.map((klass) => [klass, run.blockedMs?.[klass] ?? 0] as const).filter(
    ([, ms]) => ms > 0,
  );
  const cap = state?.concurrency?.max;
  return [
    fact('Priority', run.priority),
    fact('Chained after', run.startAfter ? <Mono value={run.startAfter} /> : null),
    fact(
      'Held',
      run.hold ? (
        <>
          {run.hold.by ? `by ${run.hold.by}, ` : ''}
          {when(run.hold.at)}
        </>
      ) : null,
    ),
    fact(
      'Lanes at once',
      run.maxParallel ? `${run.maxParallel}${cap ? ` of the console’s ${cap}` : ''}` : null,
    ),
    fact(
      'Blocked in the queue',
      blocked.length ? (
        <Lines lines={blocked.map(([klass, ms]) => `by ${HOLDER_WORDS[klass]}, ${duration(ms)}`)} />
      ) : null,
    ),
    fact(
      'Blocked now',
      run.blockedOpen ? (
        <>
          by {HOLDER_WORDS[run.blockedOpen.class]}, since {when(run.blockedOpen.since)}
        </>
      ) : null,
    ),
    fact(
      'Not driven',
      run.undriven?.length ? (
        <Lines
          lines={run.undriven.map((u) => (
            <>
              phase {u.phase}, {u.board}: {u.why}, since {when(u.since)}
            </>
          ))}
        />
      ) : null,
    ),
  ];
}

function walls(run: RunState): KeyValueItem[] {
  const limits = run.limits;
  const used =
    limits?.utilizationPct ?? (limits?.utilization != null ? Math.round(limits.utilization * 100) : null);
  const arming = run.relayArming;
  return [
    fact('Permission profile', run.permissionProfile),
    fact('Permission mode', run.permissionMode),
    fact(
      'A card waits',
      run.approvalTimeoutMinutes ? `${plural(run.approvalTimeoutMinutes, 'minute')} for a person` : null,
    ),
    fact('Relay', run.relay),
    fact(
      'Relay armed',
      arming ? (
        <>
          {arming.armed
            ? 'armed'
            : arming.reason === 'below-floor'
              ? 'not armed: the CLI is below the floor'
              : 'not armed: the CLI’s version is unknown'}
          , CLI {arming.version ?? 'unknown'} against {arming.floor}, {when(arming.at)}
        </>
      ) : null,
    ),
    fact('At the usage window', run.onLimit),
    fact(
      'Usage window',
      limits ? (
        <>
          {limits.status}
          {limits.window ? `, ${limits.window.replace(/_/g, ' ')}` : ''}
          {used != null ? `, ${used} % used` : ''}
          {limits.resetsAt ? <>, resets {ahead(new Date(limits.resetsAt * 1000).toISOString())}</> : null}
          {limits.usingOverage ? ', on credit past it' : ''}
          {limits.overageStatus ? `, credit ${limits.overageStatus}` : ''}
          {limits.overageDisabledReason ? ` (${limits.overageDisabledReason})` : ''}, read {when(limits.at)}
        </>
      ) : null,
    ),
    fact('Issues', run.issuesMode),
  ];
}

function isolation(run: RunState, state?: ConsoleState): KeyValueItem[] {
  const branch = run.gitMode === 'new-branch';
  const refusal = run.isolationRefusal;
  const found = Object.entries(run.treesFound ?? {});
  const override = run.gitStrategyOverride;
  return [
    fact('Root', run.root ? <Mono value={run.root} copyable /> : null),
    fact('Branch', branch ? 'a branch of its own' : null),
    fact('When it ends', branch ? settleOf(run) : null),
    fact('Opens a pull request', branch && run.openPr != null ? (run.openPr ? 'yes' : 'no') : null),
    fact(
      'Asked for',
      run.isolation
        ? run.isolation === ISOLATED
          ? 'a checkout of its own'
          : 'the shared checkout, queued'
        : null,
    ),
    fact(
      'Got',
      run.checkout === 'worktree'
        ? 'a checkout of its own'
        : run.checkout === 'refused'
          ? 'the shared checkout: its own was refused'
          : run.checkout
            ? 'the shared checkout'
            : null,
    ),
    fact('Works in', run.workRoot ? <Mono value={run.workRoot} copyable /> : null),
    fact(
      'Mounted repositories',
      run.mountedRepos?.length ? (
        <Lines
          lines={run.mountedRepos.map((repo) => (
            <Mono value={repo} />
          ))}
        />
      ) : null,
    ),
    fact('Refused because', refusal ? (state?.refusalReasons?.[refusal] ?? refusal) : null),
    fact('What the refusal said', run.isolationRefusalDetail),
    fact('What fixes it', refusal ? state?.refusalFixes?.[refusal] : null),
    fact(
      'Repair asked',
      run.repairCheckout ? (
        <>
          by {run.repairCheckout.by}, {when(run.repairCheckout.at)}
        </>
      ) : null,
    ),
    fact(
      'Own checkout at the next boundary',
      run.isolateAtBoundary ? (
        <>
          asked by {run.isolateAtBoundary.by}, {when(run.isolateAtBoundary.at)}
        </>
      ) : null,
    ),
    fact(
      'Phases with a worktree of their own',
      run.isolatePhases?.length ? run.isolatePhases.map((n) => `phase ${n}`).join(', ') : null,
    ),
    fact('Base branch asked', run.baseBranch ? <Mono value={run.baseBranch} /> : null),
    fact(
      'Cut from',
      run.base ? (
        <>
          <Mono value={run.base.ref} /> at <Mono value={run.base.sha} chars={12} />, by {run.base.source},
          declared by {run.base.declaredBy}
        </>
      ) : null,
    ),
    fact('Detached at', run.detachAt ? <Mono value={run.detachAt} chars={12} /> : null),
    fact('Its branch settled', when(run.settledAt)),
    fact(
      'Trees it found',
      found.length ? (
        <Lines
          lines={found.map(([dir, on]) => (
            <>
              <Mono value={dir} /> on <Mono value={on} />
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Trees it holds',
      run.treeHolds?.length ? (
        <Lines
          lines={run.treeHolds.map((hold) => (
            <>
              <Mono value={hold.repo} /> on <Mono value={hold.branch} />
              {hold.foundOn ? `, found on ${hold.foundOn}` : ''}, {when(hold.at)}
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Mounts settled before the last check',
      run.mirrorSettled ? (
        <>
          phase {run.mirrorSettled.phase}, {list(run.mirrorSettled.mounts)}, {when(run.mirrorSettled.at)}
        </>
      ) : null,
    ),
    fact(
      'Not landed',
      run.unlanded ? (
        <Lines
          lines={run.unlanded.repos.map((proof) => (
            <>
              <Mono value={proof.mount || 'the root'} /> <Mono value={proof.branch} />: {proof.state} into{' '}
              {proof.into}
              {proof.files.length ? `, ${plural(proof.files.length, 'file')}` : ''}
              {proof.detail ? `, ${proof.detail}` : ''}
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Plan git lines overridden',
      override ? (
        <>
          <Lines
            lines={override.lines.map(
              (line) => `${line.kind}: the plan says ${line.plan}, the run ${line.run}`,
            )}
          />
          <span className="block text-meta text-ink-muted">
            {override.ack === 'automatic' ? 'answered automatically' : 'overridden'}
            {override.by ? ` by ${override.by}` : ''}
            {override.at ? <>, {when(override.at)}</> : null}
          </span>
        </>
      ) : null,
    ),
    fact('Isolated runs beside it', count(run.maxConcurrentPerRepo)),
    fact('Its trees after the settle', run.worktreeRetention),
    fact('Landing', run.landing),
    fact('Conflicts', run.conflictPolicy),
    fact(
      'Left behind',
      run.artefacts?.length ? (
        <Lines
          lines={run.artefacts.map((left) => (
            <>
              {left.kind} <Mono value={left.name} />
              {left.branch ? (
                <>
                  {' '}
                  on <Mono value={left.branch} />
                </>
              ) : null}
              {left.maker === 'unknown'
                ? `, appeared while phase ${left.phase} ran (maker unknown)`
                : `, phase ${left.phase}`}
              , {when(left.at)}
            </>
          ))}
        />
      ) : null,
    ),
  ];
}

function cost(run: RunState): KeyValueItem[] {
  const approaching = Object.values(run.budgetApproaching ?? {});
  const amount = (n: number, unit: string) => (unit === 'usd' ? money(n) : `${n} ${unit}`);
  const caps =
    run.ladderPerRunRungs != null || run.ladderPerPhaseRungs != null
      ? `${run.ladderPerRunRungs ?? 'the console’s'} for the run, ${run.ladderPerPhaseRungs ?? 'the console’s'} for a phase`
      : null;
  return [
    fact('Spent', run.spentUsd > 0 ? <Money usd={run.spentUsd} against={run.runBudgetUsd} /> : null),
    fact('On credit', usd(run.creditUsd)),
    fact('Run budget', usd(run.runBudgetUsd)),
    fact('Phase budget', usd(run.phaseBudgetUsd)),
    fact(
      'Budget raised',
      run.budgetRaise ? (
        <>
          from <Money usd={run.budgetRaise.from} /> to <Money usd={run.budgetRaise.to} />,{' '}
          {run.budgetRaise.pct} %, {when(run.budgetRaise.at)}
        </>
      ) : null,
    ),
    fact('Budgets warned', list(Object.keys(run.budgetWarned ?? {}))),
    fact(
      'Budgets nearly spent',
      approaching.length ? (
        <Lines
          lines={approaching.map(
            (f) =>
              `${f.budget}: ${amount(f.spent, f.unit)} of ${amount(f.limit, f.unit)}${f.phase != null ? `, phase ${f.phase}` : ''}`,
          )}
        />
      ) : null,
    ),
    fact('Rung caps', caps),
    fact(
      'Cost model',
      run.costModel != null
        ? `${run.costModel}${run.costModel >= 2 ? ', each spawn’s rise over its session’s mark' : ', each spawn’s total, whole'}`
        : null,
    ),
    fact(
      'Clock model',
      run.clockModel != null
        ? `${run.clockModel}${run.clockModel >= 2 ? ', every session that worked a phase' : ', a phase’s own attempts'}`
        : null,
    ),
  ];
}

/** The record, in eight sections — the phase inspector's, in its order. */
export const RUN_RECORD_SECTIONS: readonly RunRecordSection[] = [
  { id: 'boarding', label: 'Boarding', facts: boarding },
  { id: 'context', label: 'Context', facts: context },
  { id: 'verification', label: 'Verification', facts: verification },
  { id: 'waits', label: 'Waits and watches', facts: waits },
  { id: 'queue', label: 'Queue', facts: queue },
  { id: 'walls', label: 'Walls and permissions', facts: walls },
  { id: 'isolation', label: 'Isolation and trees', facts: isolation },
  { id: 'cost', label: 'Cost', facts: cost },
];

const present = (items: KeyValueItem[]) =>
  items.filter((item): item is readonly [string, ReactNode] => Boolean(item));

/**
 * The eight sections. One with something to say folds behind its name and how
 * many facts it holds; one with nothing says so on its line and offers no fold.
 */
export function RunRecordSections({ run, state }: { run: RunState; state?: ConsoleState | undefined }) {
  const everything = useEverything('plan');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="run-record-sections">
      {RUN_RECORD_SECTIONS.map((section) => {
        const items = present(section.facts(run, state));
        if (!items.length) {
          return (
            <p key={section.id} className="text-meta text-ink-muted" data-section={section.id}>
              {section.label}: nothing recorded.
            </p>
          );
        }
        return (
          <section key={section.id} data-section={section.id} className="min-w-0">
            <Disclosure
              label={section.label}
              openLabel={section.label}
              count={items.length}
              testId={`run-section-${section.id}`}
              {...(everything.on ? { open: true } : {})}
              bodyClassName="pt-1.5 ps-4"
            >
              <KeyValue items={items} />
            </Disclosure>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * The tabs
 * ------------------------------------------------------------------------- */

/** The run's own story, newest first: its start, notes, rulings, halt, and a resolve or a reopen. */
function storyOf(run: RunState): HistoryEntry[] {
  const story: HistoryEntry[] = [{ at: run.createdAt, text: 'Started' }];
  for (const note of run.notes ?? []) {
    story.push({
      at: note.at,
      text: `${note.pinned ? 'Pinned a note' : 'Noted'}${note.phase != null ? ` on phase ${note.phase}` : ''}: ${note.text}`,
      by: note.by,
    });
  }
  for (const ruling of run.rulings ?? []) {
    story.push({ at: ruling.at, text: `A ${ruling.kind} ruling on phase ${ruling.phase}: ${ruling.what}` });
  }
  if (run.halt) {
    story.push({
      at: run.halt.at,
      text: `Halted${run.halt.kind ? `, ${run.halt.kind}` : ''}${run.halt.phase != null ? ` on phase ${run.halt.phase}` : ''}`,
    });
  }
  if (run.resolved) {
    story.push({
      at: run.resolved.at,
      text: `${run.resolved.auto ? 'Resolved by the board' : 'Dismissed'}: ${run.resolved.reason}`,
      ...(run.resolved.by ? { by: run.resolved.by } : {}),
    });
  }
  if (run.reopenedAt) story.push({ at: run.reopenedAt, text: 'Put back by a person' });
  return story.filter((entry) => Boolean(entry.at)).sort((a, b) => b.at.localeCompare(a.at));
}

/** Put a run in the panel. `open: false` refreshes it in place without opening the panel. */
export function inspectRunView(
  {
    run,
    slug,
    state,
    allowRun,
  }: { run: RunState; slug: string; state: ConsoleState | undefined; allowRun: boolean },
  options: { open?: boolean } = {},
): void {
  const total = Object.keys(run.phases ?? {}).length;
  inspect(
    {
      key: run.id,
      title: slug,
      description: `Run ${run.id}, ${plural(total, 'phase')} on record`,
      meta: (
        <>
          <RunStatus run={run as Parameters<typeof RunStatus>[0]['run']} />
          <Mono value={run.id} chars={12} copyable />
          {run.model && <span className="text-meta text-ink-muted">{run.model}</span>}
        </>
      ),
      overview: <RunRecordSections run={run} state={state} />,
      actions: <RunActions run={run} slug={slug} allowRun={allowRun} />,
      history: (
        <div data-testid="run-history">
          <HistoryTab entries={storyOf(run)} />
        </div>
      ),
      raw: JSON.stringify(run, null, 2),
    },
    options,
  );
}
