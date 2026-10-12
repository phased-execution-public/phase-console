/**
 * A phase in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 10; design.md principle 3).
 *
 * The run record carries far more than a row can say: how the phase boarded,
 * how full its sessions' context ran, what verification proved, what it waited
 * on, where it queued, which walls it met, which trees it holds and what it
 * cost. Overview says all of it in words, in eight sections — each one press
 * from the inspector, all of them open with the page's Everything on — above
 * the phase's own prose and the notes earlier phases left it. Actions is the
 * row's own verb set (`PhaseVerbs`), so the panel and the row cannot disagree,
 * then every verb the registry knows for a phase — its place in the queue among
 * them; History is the record's sessions and waits on one axis; Raw is the
 * record whole, exactly as the server sent it.
 *
 * The grid re-publishes the inspected phase on every tick it draws
 * (`useLiveInspection` in `table.tsx`), so a phase being watched moves in the
 * panel as it moves on the board.
 */

import type { ReactNode } from 'react';
import { PHASE_CLOCK_LABELS } from '@shared/phase-clocks.js';
import type { LaneLiveness, PhaseRecord } from '@/data/api';
import { usePlan } from '@/data/plans';
import { countdown, duration, pad2, plural } from '@/lib/format';
import { KeyValue, Money, Mono, RelativeTime, SectionHeading, type KeyValueItem } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { useEverything } from '@/ui/everything';
import { plainText } from '@/ui/markdown';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { phaseHref } from '@/shell/routes';
import { PROSE_INCLUDES } from '../tabs';
import { PhaseProse, mergedPhase } from './drawer';
import { displayState, mcpCallWords, runningOf, spendOf, type PhaseTableRow } from './model';
import { NotesSection } from './notes';
import { PhaseMark } from './row';
import { PhaseVerbs } from './table';

/** The panel's name for a phase — what the grid compares to mark the row on show. */
export const phaseInspectKey = (slug: string, phase: number): string => `phase:${slug}:${phase}`;

/* ------------------------------------------------------------------------- *
 * Words for the record's values
 * ------------------------------------------------------------------------- */

const when = (iso: string | undefined | null): ReactNode =>
  iso ? <RelativeTime at={iso} live={false} /> : null;

/**
 * A moment still to come — its clock time and how long until it. `RelativeTime`
 * speaks of the past, and would call a resume an hour away "just now".
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

const ms = (value: number | undefined | null): string | null => (value && value > 0 ? duration(value) : null);

const count = (value: number | undefined | null): string | null => (value ? String(value) : null);

const list = (values: readonly string[] | undefined | null): string | null =>
  values?.length ? values.join(', ') : null;

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const usd = (value: number | undefined | null): ReactNode =>
  value && value > 0 ? <Money usd={value} /> : null;

/** A value the record holds as a structure nobody reads often — said compactly, never dropped. */
function Structure({ value }: { value: unknown }) {
  if (value == null) return null;
  return <code className="font-mono text-meta wrap-anywhere text-ink">{JSON.stringify(value)}</code>;
}

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
  value == null || value === '' ? null : [label, value];

/* ------------------------------------------------------------------------- *
 * The eight sections
 * ------------------------------------------------------------------------- */

export interface PhaseRecordSection {
  id: string;
  label: string;
  facts: (record: PhaseRecord, liveness?: LaneLiveness) => KeyValueItem[];
}

function boarding(r: PhaseRecord, live?: LaneLiveness): KeyValueItem[] {
  const tasks = r.tasks ?? [];
  const tasksDone = tasks.filter((t) => t.status === 'completed').length;
  const liveness = live ?? r.liveness;
  return [
    fact('Attempts', count(r.attempts)),
    fact('Idle attempts', count(r.idleAttempts)),
    fact('Started', when(r.startedAt)),
    fact('Ended', when(r.endedAt)),
    fact('This attempt started', when(r.attemptStartedAt)),
    fact('This attempt ended', when(r.attemptEndedAt)),
    fact('Session', r.sessionId ? <Mono value={r.sessionId} copyable /> : null),
    fact('Resumes session', r.resumeSessionId ? <Mono value={r.resumeSessionId} copyable /> : null),
    fact(
      'Resume refused',
      r.resumeRefused ? (
        <>
          {r.resumeRefused.why}, <RelativeTime at={r.resumeRefused.at} live={false} />
        </>
      ) : null,
    ),
    fact(
      'Last session',
      r.lastSession ? (
        <>
          {r.lastSession.mode}, ended by {r.lastSession.endedBy}
          {r.lastSession.subtype ? ` (${r.lastSession.subtype})` : ''}
          {r.lastSession.terminalReason ? `, ${r.lastSession.terminalReason}` : ''}
          {r.lastSession.maxTurns ? `, at most ${r.lastSession.maxTurns.value} turns` : ''}
          {r.lastSession.maxBudgetUsd ? `, at most $${r.lastSession.maxBudgetUsd.value}` : ''}
          , <RelativeTime at={r.lastSession.at} live={false} />
        </>
      ) : null,
    ),
    fact('Account', r.sessionAccountId ? <Mono value={r.sessionAccountId} /> : null),
    fact(
      'Session gone',
      r.sessionGone ? (
        <>
          {r.sessionGone.reason}, <RelativeTime at={r.sessionGone.at} live={false} />
        </>
      ) : null,
    ),
    fact('Model asked', r.model ? <Mono value={r.model} /> : null),
    fact(
      'Model that answered',
      r.actualModel && r.actualModel !== r.model ? <Mono value={r.actualModel} /> : null,
    ),
    fact('Effort', r.effort),
    fact(
      'Model mismatch',
      r.modelMismatch ? `${r.modelMismatch.requested} was resolved as ${r.modelMismatch.resolved}` : null,
    ),
    fact(
      'Boarding hint',
      r.boardingHint
        ? `${r.boardingHint.situation}, rung ${r.boardingHint.rung}${r.boardingHint.instruction ? `: ${r.boardingHint.instruction}` : ''}`
        : null,
    ),
    fact(
      'Retry edits',
      r.retryOverride ? (
        <>
          {r.retryOverride.addendum ? 'an addendum to the prompt' : 'new options'}
          {r.retryOverride.by ? `, by ${r.retryOverride.by}` : ''},{' '}
          <RelativeTime at={r.retryOverride.at} live={false} />
          {r.retryOverride.options && (
            <span className="block">
              <Structure value={r.retryOverride.options} />
            </span>
          )}
        </>
      ) : null,
    ),
    fact('Gate', r.gate ? `${r.gate.clear ? 'clear' : 'held'}, ${r.gate.kind}: ${r.gate.detail}` : null),
    fact('Preflight', list(r.preflight)),
    fact(
      'Preflight findings',
      r.preflightDetail?.length ? <Lines lines={r.preflightDetail.map((w) => w.message)} /> : null,
    ),
    fact(
      'Tasks',
      tasks.length
        ? `${tasksDone} of ${tasks.length} done${r.live?.tasks?.active ? `, now ${r.live.tasks.active}` : ''}`
        : null,
    ),
    fact('Progress', r.progress ? `${r.progress.label}, ${r.progress.done} of ${r.progress.of}` : null),
    fact(
      'Last output',
      liveness ? (
        <>
          <RelativeTime at={liveness.lastOutputAt} />, {plural(liveness.turnsSinceLastTool, 'turn')} since a
          tool, {plural(liveness.commitsSinceStart, 'commit')}
          {liveness.treeDirty ? ', uncommitted changes' : ''}
        </>
      ) : null,
    ),
    fact('Stalled', r.stall ? `${r.stall.signal}: ${r.stall.detail}` : null),
    fact(
      'Stall remedies',
      r.stallRemedy
        ? `${plural(r.stallRemedy.nudges, 'nudge')}, ${plural(r.stallRemedy.recycles, 'recycle')}${
            r.stallRemedy.retryRecycles ? `, ${plural(r.stallRemedy.retryRecycles, 'retry recycle')}` : ''
          }`
        : null,
    ),
    fact('Suspected loop', r.suspect ? `${r.suspect.detail} (${r.suspect.evidence.tool})` : null),
    fact('Situation', r.situation ? [r.situation.key, ...(r.situation.why ?? [])].join('; ') : null),
    // The halt's sentence is the halt card's to say (the Run view); here, which stop and when.
    fact(
      'Halt',
      r.halt ? (
        <>
          {r.halt.kind ?? 'stopped'}, {when(r.halt.at)}
        </>
      ) : null,
    ),
    fact('The session said', r.said),
    fact('Runner note', r.note),
    fact(
      'Closeout',
      r.closeout ? (
        <>
          {r.closeout.ok ? 'closed cleanly' : 'closed with a problem'}
          {r.closeout.note ? `: ${r.closeout.note}` : ''}, <RelativeTime at={r.closeout.at} live={false} />
        </>
      ) : null,
    ),
    fact(
      'Transcript replay',
      r.replay
        ? `${r.replay.state === 'full' ? 'full' : 'nearly full'}, ${tokens(r.replay.bytes)} of ${tokens(r.replay.cap)} bytes`
        : null,
    ),
    fact('MCP calls', r.mcpCalls && Object.keys(r.mcpCalls).length ? mcpCallWords(r.mcpCalls) : null),
    fact('Not driven', r.undriven ? <Structure value={r.undriven} /> : null),
  ];
}

function context(r: PhaseRecord, live?: LaneLiveness): KeyValueItem[] {
  const now = (live ?? r.liveness)?.tokens;
  return [
    fact(
      'Context now',
      now
        ? `${tokens(now.context)}${now.window ? ` of ${tokens(now.window)} (${Math.round((now.context / now.window) * 100)} %)` : ''}, peak ${tokens(now.peak)}${now.stage ? `, past the ${now.stage} line` : ''}`
        : null,
    ),
    fact(
      'Sessions',
      r.tokens?.length ? (
        <Lines
          lines={r.tokens.map(
            (t) =>
              `${t.mode}${t.resumed ? ', resumed' : ''}${t.model ? `, ${t.model}` : ''}: peak ${tokens(t.peakContext)}${
                t.window ? ` of ${tokens(t.window)}` : ''
              }, ${plural(t.calls, 'call')}, ${plural(t.rebuilds, 'rebuild')}`,
          )}
        />
      ) : null,
    ),
    fact(
      'Wrap-up notice',
      r.contextWrapup
        ? `at ${tokens(r.contextWrapup.context)} of ${tokens(r.contextWrapup.window)}${r.contextWrapup.delivered === false ? ', not delivered' : ''}`
        : null,
    ),
    fact(
      'Checkpoint',
      r.contextCheckpoint
        ? `at ${tokens(r.contextCheckpoint.context)} of ${tokens(r.contextCheckpoint.window)}${r.contextCheckpoint.reason ? `, ${r.contextCheckpoint.reason}` : ''}`
        : null,
    ),
    fact('Resumed after a wrap-up', count(r.wrapupResumes)),
    fact(
      'Last partial',
      r.lastPartial ? (
        <>
          {r.lastPartial.reason ?? 'no reason given'}, <RelativeTime at={r.lastPartial.at} live={false} />
        </>
      ) : null,
    ),
  ];
}

function verification(r: PhaseRecord): KeyValueItem[] {
  const v = r.verification;
  return [
    fact('Verdict', v ? `${v.ok ? 'passed' : 'red'}: ${v.reason}` : null),
    fact(
      'Commands',
      v?.ran.length ? (
        <Lines
          lines={v.ran.map((run) => (
            <>
              <Mono value={run.command} words /> {run.ok ? 'passed' : `exit ${run.code}`}, {duration(run.ms)}
            </>
          ))}
        />
      ) : null,
    ),
    fact('Verified in', r.verifiedIn ? <Mono value={r.verifiedIn} /> : null),
    fact('Verifying since', when(r.verifyingSince)),
    fact(
      'Baseline',
      r.baseline ? (
        <>
          {r.baseline.head ? <Mono value={r.baseline.head} /> : 'no head'}, {when(r.baseline.at)}
        </>
      ) : null,
    ),
    fact('Baseline since', when(r.baselineSince)),
    fact(
      'Verified again',
      r.reverify
        ? `after a ${r.reverify.cause}${r.reverify.ran != null ? `, ${r.reverify.ran} ran` : ''}${r.reverify.notRun ? `, ${r.reverify.notRun} not run` : ''}`
        : null,
    ),
    fact(
      'Time limit',
      r.verifyLimit ? `${duration(r.verifyLimit.ms)} a command, from ${r.verifyLimit.source}` : null,
    ),
    fact(
      'Reds owed',
      r.owed?.length ? (
        <Lines
          lines={r.owed.map((o) => (
            <>
              <Mono value={o.command} />, {o.how}, {plural(o.failures.length, 'failure')}
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Uncommitted red',
      r.wipRed ? (
        <>
          <Mono value={r.wipRed.sha} />
          {r.wipRed.lines?.length ? `, ${plural(r.wipRed.lines.length, 'line')} red` : ''}
          {r.wipRed.files?.length ? `, in ${list(r.wipRed.files)}` : ''}
        </>
      ) : null,
    ),
    fact(
      'Re-opened',
      r.reopened
        ? `${plural(r.reopened.times, 'time')}, last on ${list(r.reopened.failed) ?? 'a red line'}`
        : null,
    ),
    fact('Reconciled', when(r.reconciled?.at)),
    fact('Ports it opened', r.ownPorts?.length ? r.ownPorts.join(', ') : null),
    fact('Plan lint', r.lint ? `${r.lint.ok ? 'clean' : 'findings'}: ${r.lint.summary}` : null),
    fact(
      'QA rounds',
      r.qa?.length ? (
        <Lines
          lines={r.qa.map((q) => `round ${q.round}: ${q.verdict}${q.reportPath ? `, ${q.reportPath}` : ''}`)}
        />
      ) : null,
    ),
    fact('QA session', r.qaSession ? `round ${r.qaSession.round}, report ${r.qaSession.report}` : null),
  ];
}

function waits(r: PhaseRecord): KeyValueItem[] {
  const parked = (r.parkedMs ?? 0) + (r.parkedMsCarried ?? 0);
  return [
    fact('Parked until', ahead(r.parkedUntil)),
    fact('Parked from', when(r.parkedFrom)),
    fact('Why', r.parkReason),
    fact(
      'Declared',
      r.declared ? `${r.declared.status}${r.declared.reason ? `: ${r.declared.reason}` : ''}` : null,
    ),
    fact(
      'Watching',
      r.watch?.length ? (
        <Lines
          lines={r.watch.map((ref) => (
            <Mono value={ref} />
          ))}
        />
      ) : null,
    ),
    fact(
      'Watch readings',
      r.watchState?.refs.length ? (
        <Lines
          lines={r.watchState.refs.map((w) => (
            <>
              <Mono value={w.ref} /> {w.state}
              {w.detail ? `, ${w.detail}` : ''}
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Last check',
      r.watchChecked ? (
        <>
          <Mono value={r.watchChecked.ref} /> {r.watchChecked.state},{' '}
          <RelativeTime at={r.watchChecked.at} live={false} />
        </>
      ) : null,
    ),
    fact(
      'Cannot be polled',
      r.watchUnpollable?.length ? (
        <Lines lines={r.watchUnpollable.map((w) => `${w.ref}: ${w.reason}`)} />
      ) : null,
    ),
    fact('Waits declared', count(r.waits)),
    fact('Parked by the watchdog', count(r.watchdogParks)),
    fact('Parked in all', ms(parked)),
    fact(
      'Declarations',
      r.declarations && Object.keys(r.declarations).length
        ? Object.entries(r.declarations)
            .map(
              ([status, row]) =>
                `${status} ${plural(row!.count, 'time')}${row!.refused ? `, ${row!.refused} refused` : ''}`,
            )
            .join('; ')
        : null,
    ),
    fact(
      'Wait history',
      r.waitHistory?.length ? (
        <Lines
          lines={r.waitHistory.map((w) => (
            <>
              {w.kind === 'person' ? 'a person' : w.by}, <RelativeTime at={w.parkedFrom} live={false} />
              {w.resumedAt ? (
                <>
                  , resumed <RelativeTime at={w.resumedAt} live={false} />
                </>
              ) : (
                ', not resumed yet'
              )}
              {w.unit ? `, ${w.unit.ref} ${w.unit.result}` : ''}
            </>
          ))}
        />
      ) : null,
    ),
    fact('Overdue announced', r.parkOverdueAnnouncedFor),
    fact('Resumed by a watch', count(r.watchResumes)),
    fact('Errand for a landed watch', r.watchLandedErrandFor),
    fact('Landed watches', list(r.watchLandedDone)),
    fact('Landed and journalled', list(r.watchLandedJournalledFor)),
    fact(
      'Watches refused',
      r.watchRejections
        ? `${plural(r.watchRejections.count, 'time')}, last: ${r.watchRejections.reason}`
        : null,
    ),
    fact('Watches retired', list(r.watchRetired)),
    fact(
      'Fence lifted',
      r.fenceLifted ? (
        <>
          {r.fenceLifted.why}, {when(r.fenceLifted.at)}
        </>
      ) : null,
    ),
    fact(
      'Errand answered',
      r.errandAnswered ? (
        <>
          by {r.errandAnswered.by}: {r.errandAnswered.note}, {when(r.errandAnswered.at)}
        </>
      ) : null,
    ),
  ];
}

function queue(r: PhaseRecord): KeyValueItem[] {
  const control = r.queueControl;
  const marks = control
    ? [
        control.bump && 'moved to the front',
        control.hold && 'held',
        control.defer && `deferred until ${new Date(control.defer.until).toLocaleString()}`,
        control.withdrawn && 'withdrawn',
      ].filter(Boolean)
    : [];
  return [
    fact('Queued', when(r.queuedAt)),
    fact('Queued for', ms(r.queuedMs)),
    fact('In the queue since', when(r.queueSince)),
    fact('Waited in the queue', ms(r.queueWaitedMs)),
    fact('Reserving its place', r.queueReserving ? 'yes' : null),
    fact('Last seen by the scheduler', when(r.queueSeenAt)),
    fact(
      'Head of the queue',
      r.queueHead ? (
        <>
          {r.queueHead.class}, {when(r.queueHead.since)}
        </>
      ) : null,
    ),
    fact(
      'Behind holders',
      r.queuedByClass && Object.keys(r.queuedByClass).length
        ? Object.entries(r.queuedByClass)
            .map(([cls, n]) => `${cls} ${plural(n ?? 0, 'time')}`)
            .join('; ')
        : null,
    ),
    fact('Behind', r.serialBehind ? plural(r.serialBehind, 'phase') : null),
    fact('Waiting for a lock since', when(r.lockWaitSince)),
    fact(
      'Waiting on',
      r.waitingOn?.length
        ? r.waitingOn
            .map((h) => `${h.slug}${h.phase != null ? ` phase ${h.phase}` : ''} (${h.owner})`)
            .join('; ')
        : null,
    ),
    fact('Lock back-off', ms(r.lockBackoffMs)),
    fact('Operator marks', marks.length ? marks.join('; ') : null),
  ];
}

function walls(r: PhaseRecord): KeyValueItem[] {
  return [
    fact(
      'Tool denied',
      r.toolDenied ? (
        <>
          {r.toolDenied.tool} by <Mono value={r.toolDenied.rule} />
          {r.toolDenied.command ? (
            <span className="block">
              <Mono value={r.toolDenied.command} />
            </span>
          ) : null}
        </>
      ) : null,
    ),
    fact(
      'Walls met',
      r.walls?.length ? (
        <Lines
          lines={r.walls.map(
            (w) =>
              `${w.wall} on ${w.tool}${w.rule ? ` (${w.rule})` : ''}, from the ${w.source}${w.reason ? `: ${w.reason}` : ''}`,
          )}
        />
      ) : null,
    ),
    fact('Wall now', r.wall ? <Structure value={r.wall} /> : null),
    fact(
      'Credential refused',
      r.cause
        ? `${r.cause.reason}${r.cause.account ? `, account ${r.cause.account}` : ''}${r.cause.class ? ` (${r.cause.class})` : ''}`
        : null,
    ),
    fact(
      'Credentials missing',
      r.credentialsMissing?.length ? (
        <Lines lines={r.credentialsMissing.map((c) => `${c.id}: ${c.reason}`)} />
      ) : null,
    ),
    fact(
      'Plan approval',
      r.planApproval ? (
        <>
          {r.planApproval.state}
          {r.planApproval.by ? ` by ${r.planApproval.by}` : ''}
          {r.planApproval.reason ? `: ${r.planApproval.reason}` : ''}, <Mono value={r.planApproval.path} />
        </>
      ) : null,
    ),
    fact(
      'Safeguard',
      r.safeguard
        ? `${plural(r.safeguard.flags, 'flag')}${r.safeguard.tried.length ? `, tried ${list(r.safeguard.tried)}` : ''}`
        : null,
    ),
    fact(
      'Usage wall',
      r.usageWall ? (
        <>
          {r.usageWall.account}, {r.usageWall.bucket}, until at the latest {ahead(r.usageWall.latest)}
        </>
      ) : null,
    ),
    fact(
      'MCP degraded',
      r.mcpDegraded?.length ? r.mcpDegraded.map((d) => `${d.id} (${d.reason})`).join('; ') : null,
    ),
    fact(
      'Parked for MCP',
      r.mcpPark ? (
        <>
          {r.mcpPark.degraded.map((d) => d.id).join(', ')}, {when(r.mcpPark.at)}
        </>
      ) : null,
    ),
  ];
}

function isolation(r: PhaseRecord): KeyValueItem[] {
  return [
    fact(
      'Errand tree',
      r.errandTree ? (
        <>
          <Mono value={r.errandTree.dir} copyable />
          <span className="block">
            by {r.errandTree.by}, {when(r.errandTree.at)},{' '}
            {plural(r.errandTree.mounts.length, 'repository', 'repositories')}
          </span>
        </>
      ) : null,
    ),
    fact(
      'Keeps its lane',
      r.keepsLane ? `${r.keepsLane.reason}, ${plural(r.keepsLane.paths, 'uncommitted path')}` : null,
    ),
    fact(
      'Agents stopped',
      r.agentsKilled ? (
        <>
          {plural(r.agentsKilled.agents.length, 'agent')}, {when(r.agentsKilled.at)}
          {r.agentsKilled.paths.length ? `, ${plural(r.agentsKilled.paths.length, 'path')} left` : ''}
        </>
      ) : null,
    ),
    fact(
      'Landing',
      r.landing
        ? `${r.landing.policy}, ${r.landing.state} at ${r.landing.step}, ${plural(r.landing.attempts, 'attempt')}${r.landing.note ? `: ${r.landing.note}` : ''}`
        : null,
    ),
  ];
}

function cost(r: PhaseRecord): KeyValueItem[] {
  const clocks = r.phaseClocks as Record<string, number> | undefined;
  const labels = PHASE_CLOCK_LABELS as Readonly<Record<string, string>>;
  return [
    fact('Spent', r.costUnknown ? 'not recorded' : usd(spendOf(r))),
    fact('Credit', usd(r.creditUsd)),
    fact('Turns', count(r.turns)),
    fact('Running time', ms(r.durationMs)),
    fact('Frozen', ms(r.frozenMs)),
    fact(
      'Clocks',
      clocks && Object.keys(clocks).length ? (
        <Lines
          lines={Object.entries(clocks)
            .filter(([, value]) => typeof value === 'number' && value > 0)
            .map(([id, value]) => `${labels[id] ?? id} ${duration(value)}`)}
        />
      ) : null,
    ),
    fact('Attempt windows', r.attemptWindows?.length ? plural(r.attemptWindows.length, 'window') : null),
    fact(
      'Booked per session',
      r.costHighWater && Object.keys(r.costHighWater).length ? (
        <Lines
          lines={Object.entries(r.costHighWater).map(([session, value]) => (
            <>
              <Mono value={session} /> <Money usd={value} />
            </>
          ))}
        />
      ) : null,
    ),
    fact(
      'Budgets warned',
      r.budgetWarned && Object.keys(r.budgetWarned).length ? list(Object.keys(r.budgetWarned)) : null,
    ),
    fact(
      'Budgets nearly spent',
      r.budgetApproaching && Object.keys(r.budgetApproaching).length
        ? list(Object.keys(r.budgetApproaching))
        : null,
    ),
  ];
}

/** The record, in eight sections — the order a person asks "what happened?" in. */
export const PHASE_RECORD_SECTIONS: readonly PhaseRecordSection[] = [
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
 * The eight sections. A section with something to say folds behind its name
 * and how many facts it holds; one with nothing says so on its line and offers
 * no fold — a press that opens onto nothing is a press wasted.
 */
export function PhaseRecordSections({
  record,
  liveness,
}: {
  record: PhaseRecord | undefined;
  liveness?: LaneLiveness | undefined;
}) {
  const everything = useEverything('plan');
  if (!record) {
    return (
      <p className="text-body text-ink-muted">This run has no record of the phase yet: it has not boarded.</p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="phase-record-sections">
      {PHASE_RECORD_SECTIONS.map((section) => {
        const items = present(section.facts(record, liveness));
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
              testId={`phase-section-${section.id}`}
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

function Overview({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const r = p.record;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KeyValue
        items={[
          fact('Attempts', r ? (count(r.attempts) ?? 'none yet') : 'none yet'),
          fact('Spent', usd(spendOf(r))),
          fact('Estimate', row.eta?.label ? `${row.eta.label} (${row.eta.basis})` : null),
          fact('Rulings', row.rulings ? String(row.rulings) : null),
          fact('Holds', row.holds.length ? row.holds.map((n) => `phase ${n}`).join(', ') : null),
        ]}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <SectionHeading as="h3">The run's record</SectionHeading>
        <PhaseRecordSections record={r} liveness={row.liveness} />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <SectionHeading as="h3">The phase as written</SectionHeading>
        <PhaseProse slug={scope.slug} phase={p} eta={row.eta} />
      </div>
      <NotesSection slug={scope.slug} phase={p.phase} enabled />
    </div>
  );
}

function Actions({ row }: { row: PhaseTableRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PhaseVerbs row={row} />
      <p className="text-meta text-ink-muted">
        The phase's own page holds its gate, its review and its prompt:{' '}
        <a
          className="text-ink underline-offset-2 hover:underline"
          href={phaseHref(row.scope.slug, row.p.phase)}
        >
          open phase {row.p.phase}
        </a>
        .
      </p>
      <ActionsTab kind="phase" args={{ slug: row.scope.slug, phase: row.p.phase }} />
    </div>
  );
}

/** The record's sessions and waits, newest first, on one axis. */
function History({ record }: { record: PhaseRecord | undefined }) {
  const events: { at: string; text: ReactNode }[] = [];
  for (const t of record?.tokens ?? [])
    events.push({
      at: t.endedAt,
      text: `A ${t.mode} session ended${t.model ? ` on ${t.model}` : ''}, peak context ${tokens(t.peakContext)}`,
    });
  for (const w of record?.waitHistory ?? [])
    events.push({ at: w.parkedFrom, text: `Parked by ${w.kind === 'person' ? 'a person' : w.by}` });
  for (const q of record?.qa ?? [])
    if (q.at) events.push({ at: q.at, text: `QA round ${q.round}: ${q.verdict}` });
  if (record?.reopened) events.push({ at: record.reopened.at, text: 'Re-opened by a red verification' });
  if (record?.halt)
    events.push({ at: record.halt.at, text: `Halted${record.halt.kind ? `, ${record.halt.kind}` : ''}` });
  if (!events.length)
    return <p className="text-body text-ink-muted">Nothing has happened to this phase in this run yet.</p>;
  events.sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ol className="flex min-w-0 flex-col gap-1.5" data-testid="phase-history">
      {events.map((e, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body">
          <span className="shrink-0 text-meta text-ink-muted">
            <RelativeTime at={e.at} live={false} />
          </span>
          <span className="min-w-0 break-words">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The record whole — the phase as the Overview drew it (the live row merged
 * over the fetched prose, Overview's own query, so no second request), this
 * run's record of it and its lane.
 */
function Raw({ row }: { row: PhaseTableRow }) {
  const { record, ...live } = row.p;
  const { data: full } = usePlan(row.scope.slug, PROSE_INCLUDES);
  const prose = full?.phases.find((p) => p.phase === live.phase);
  const phase = prose ? mergedPhase(prose, live) : live;
  return (
    <pre className="m-0 font-mono text-meta whitespace-pre-wrap wrap-anywhere">
      {JSON.stringify({ phase, record: record ?? null, liveness: row.liveness ?? null }, null, 2)}
    </pre>
  );
}

/** Put a phase in the panel. `open: false` refreshes it in place without opening the panel. */
export function inspectPhase(row: PhaseTableRow, options: { open?: boolean } = {}): void {
  const { p, scope } = row;
  inspect(
    {
      key: phaseInspectKey(scope.slug, p.phase),
      title: plainText(p.title),
      description: `Phase ${pad2(p.phase)} of ${scope.slug}`,
      // The row's own word: a phase a session is working reads as in progress here too.
      meta: (
        <PhaseMark
          slug={scope.slug}
          phase={p.phase}
          state={displayState(p.state, { running: runningOf(row) })}
          live={p.live}
        />
      ),
      overview: <Overview row={row} />,
      actions: <Actions row={row} />,
      history: <History record={p.record} />,
      raw: <Raw row={row} />,
    },
    options,
  );
}
