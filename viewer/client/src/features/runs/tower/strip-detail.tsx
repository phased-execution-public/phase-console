/**
 * The strip, expanded in place (control-tower phase 19, §Architecture 5):
 * the halt card · lanes · Now · clocks · cost · every verb · Inspect · Open run.
 *
 * Every fact the old board card showed lives here or on the glance — one press
 * from the board, never a navigation (`strip.datums.test.tsx` is the ledger).
 * Nothing here is a new primitive: the stop is `HaltCard`, the lanes are the C2
 * atoms (`components/lane-facts.tsx`) with the lane's clock LABELLED rather than
 * bare, the console's own checks are `VerifyingLaneRow`, the holder facts are
 * the queued pane's words, the live lanes carry phase 95's Now panel, and every
 * lifecycle verb goes through the strip's ONE `useRunLifecycle`.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ExternalLink, Hand, Pause, Play, Snowflake, Square, Unplug } from 'lucide-react';

import { planHref } from '@shared/routes.js';
import {
  PRIORITY_LABELS,
  RUN_PRIORITIES,
  runPriority,
  type RunPriority,
} from '@shared/orchestration-model.js';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  Badge,
  KeyValue,
  field,
  toast,
} from '@/components/ui';
import { LoadMeter, RunStrip } from '@/components/charts';
import { HaltCard } from '@/components/halt-card';
import { LazyHumanStepCard } from '@/components/human-step-lazy';
import { LaneBeat, LaneCost, LaneEta, LaneFrozen, LaneModel, laneFacts } from '@/components/lane-facts';
import { RecoveryActions } from '@/components/recovery-actions';
import { api, type QueueEntry, type RunState, type VerifyingLane } from '@/lib/api';
import { cn } from '@/lib/cn';
import { clockWords, holderEtaText, money, plural } from '@/lib/format';
import { keys } from '@/lib/queries';
import type { LifecycleVerb, RunLifecycle } from '@/lib/run-lifecycle';
import type { NowLane } from '@/features/runs/lanes-model';
import { BranchChip } from '../git-card';
import { LastActivity, LiveNow } from '../now-panel';
import { holderLabel, waitingLabel } from '../session-panes';
import { VerifyingLaneRow, withChecks } from '../verifying-lane';
import { WaitNoteLine } from '../wait-note-line';
import { laneClock, phaseClockList } from './clocks';
import type { StripModel } from './strip-model';

export interface StripDetailProps {
  model: StripModel;
  run: RunState;
  lanes: readonly NowLane[];
  checks?: readonly VerifyingLane[];
  entry?: QueueEntry;
  allowRun: boolean;
  /** The strip's own lifecycle hook — one busy word for the glance's action and these verbs. */
  lifecycle: RunLifecycle;
  now: number;
  onInspect: () => void;
}

export function StripDetail({
  model,
  run,
  lanes,
  checks = [],
  entry,
  allowRun,
  lifecycle,
  now,
  onInspect,
}: StripDetailProps) {
  // The clocks of the phase the glance is about: a live lane's, else the one
  // the run stopped on, else its active phase.
  const clockPhase = model.livePhases[0] ?? run.halt?.phase ?? run.activePhase;
  const active = clockPhase != null ? run.phases?.[String(clockPhase)] : undefined;
  const liveActive = active != null && model.livePhases.includes(active.phase);

  return (
    <div className="flex min-w-0 flex-col gap-3 px-3 py-3" data-testid="strip-detail">
      {/* A person's turn, whole — the strip's one action is its primary (phase 42). */}
      {model.action.kind === 'step' && <LazyHumanStepCard item={model.action.item} />}
      {run.halt && <HaltCard run={run} live={model.view.tense === 'live'} />}
      {model.row.waitNote ? <WaitNoteLine note={model.row.waitNote} /> : null}

      {(lanes.length > 0 || checks.length > 0) && (
        <ul className="flex flex-col gap-1" aria-label="Lanes">
          {/* The lanes, with the console's own checks placed against them — in
              place of a lane with no session, beside one with a session (#68). */}
          {withChecks(lanes, checks).map((item) => {
            if (item.kind === 'check') {
              return <VerifyingLaneRow key={`${run.id}~check#${item.check.phase}`} check={item.check} />;
            }
            const { lane } = item;
            const facts = laneFacts(lane);
            const moving = !lane.frozen && (lane.status === 'running' || lane.status === 'verifying');
            return (
              <li
                key={lane.key}
                data-testid="board-lane"
                className={cn(
                  'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-4 bg-ground-deep/50 px-2 py-1.5',
                  lane.frozen ? 'border-needs-you' : 'border-running',
                )}
              >
                <span className="font-mono text-2xs text-ink tabular-nums">P{lane.phase}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted">
                  {lane.title ?? lane.status}
                </span>
                <BranchChip branch={lane.child?.branch} />
                {/* Wraps under the title on a narrow strip rather than running
                    past its edge — the expand region clips what escapes it. */}
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <LaneBeat facts={facts} live={moving} />
                  <span className="text-2xs text-ink-muted tabular-nums" data-testid="lane-clock">
                    {clockWords(laneClock(lane, run.phases?.[String(lane.phase)], now))}
                  </span>
                  <LaneCost facts={facts} />
                  <LaneEta facts={facts} />
                  <LaneModel facts={facts} />
                  <LaneFrozen facts={facts} />
                </span>
                {moving && <LastActivity slug={run.slug} phase={lane.phase} />}
              </li>
            );
          })}
        </ul>
      )}

      <QueueFacts column={model.bay} entry={entry} lanes={lanes} now={now} />

      {/* Phase 95's Now panel for each live lane — the task timeline, the
          active operation and the summary line (#163). Fetched only while open. */}
      {model.livePhases.length > 0 && <LiveNow slug={run.slug} phases={model.livePhases} />}

      {active && (
        <section aria-label={`Clocks for phase ${active.phase}`} className="flex flex-col gap-1">
          <h4 className="text-2xs font-medium text-ink">Phase {active.phase} clocks</h4>
          <KeyValue
            items={phaseClockList(active, now, liveActive).map(
              (clock) => [sentence(clock.label), clockWords(clock)] as const,
            )}
          />
        </section>
      )}

      <StripFacts run={run} entry={entry} />

      {model.track.length > 0 && <RunStrip phases={model.track} className="max-w-md" />}

      <div className="flex flex-wrap items-center gap-2">
        <LoadMeter
          className="max-w-40 min-w-24 flex-1"
          fraction={model.cost.fraction}
          label={money(model.cost.spentUsd)}
          description={
            model.cost.budgetUsd
              ? `${money(model.cost.spentUsd)} of a ${money(model.cost.budgetUsd)} run budget`
              : `${money(model.cost.spentUsd)}, no run budget set`
          }
          tone={model.cost.over ? 'failed' : 'running'}
        />
        <span className="font-mono text-2xs text-ink-faint tabular-nums">
          {model.done}/{model.total} phases
        </span>
        {model.cost.liveUsd > 0 && (
          <span className="text-2xs text-ink-faint">
            {money(model.cost.liveUsd)} in flight, booked when it ends
          </span>
        )}
      </div>

      {allowRun && <StripVerbs model={model} run={run} entry={entry} lifecycle={lifecycle} />}

      {/* The repair verbs for a run that waits without a halt card to carry
          them — `RecoveryActions` decides which apply and draws nothing when
          none does. A stop's own card above already carries its ways forward. */}
      {!run.halt && (model.bay === 'waiting' || model.bay === 'needs-you') && (
        <RecoveryActions target={{ slug: run.slug, runId: run.id }} ctx={{ run }} max={2} />
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-2">
        <button
          type="button"
          onClick={onInspect}
          className="text-2xs text-ink-muted hover:text-action [@media(hover:none)]:min-h-(--tap-min)"
          title="Everything this console knows about this run"
        >
          Inspect
        </button>
        <a
          href={planHref(run.slug, 'run')}
          className="inline-flex items-center gap-1 text-2xs text-ink-muted hover:text-action [@media(hover:none)]:min-h-(--tap-min)"
        >
          <ExternalLink size={13} aria-hidden /> Open run
        </a>
      </div>
    </div>
  );
}

const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

/** Why it is not moving, in the queue's own words — the ones the queued pane reads. */
function QueueFacts({
  column,
  entry,
  lanes,
  now,
}: {
  column: string;
  entry: QueueEntry | undefined;
  lanes: readonly NowLane[];
  now: number;
}) {
  if (column !== 'queued' && !entry) return null;
  const queuedLane = lanes.some((lane) => lane.status === 'queued');
  const holder = entry?.waitingOn?.[0];
  return (
    <div className="flex flex-col gap-1">
      {(column === 'queued' || queuedLane) && (
        <p className="text-2xs text-ink-faint" data-testid="board-holder">
          {waitingLabel(entry)}
          {entry ? ` · ${clockWords({ verb: 'queued', ms: now - entry.since, tense: 'for' })}` : ''}
          {entry?.branch && holder?.branch
            ? ` · you ${entry.branch} · them ${holder.branch}`
            : holder?.branch
              ? ` · on ${holder.branch}`
              : ''}
          {holder?.eta?.label ? ` · ${holderEtaText(holder.eta, holder.phase)}` : ''}
        </p>
      )}
      {entry && entry.waitingOn.length > 1 && (
        <p className="text-2xs text-ink-faint">
          Also behind{' '}
          {entry.waitingOn
            .slice(1)
            .map((h) => holderLabel(h.kind, h.slug, h.phase))
            .join(', ')}
          .
        </p>
      )}
      {entry?.held && (
        <p className="text-2xs text-ink-faint" data-testid="board-held-note">
          {clockWords({ verb: 'Held', ms: now - Date.parse(entry.held.at), tense: 'ago' })}
          {entry.held.by ? ` by ${entry.held.by}` : ''} — release it to let this line move.
        </p>
      )}
      {entry?.after && (
        <p className="text-2xs text-ink-faint">Chained behind {entry.after}, which has not settled.</p>
      )}
    </div>
  );
}

/** The run's standing facts — what the old card's header carried as chips. */
function StripFacts({ run, entry }: { run: RunState; entry: QueueEntry | undefined }) {
  const priority = runPriority(run.priority);
  const chips = [
    priority !== 'normal' && (
      <Badge key="priority" tone={priority === 'high' ? 'live' : 'neutral'} data-testid="priority-chip">
        {priority} priority
      </Badge>
    ),
    entry?.bumped && (
      <Badge key="bumped" tone="live" data-testid="bumped-chip">
        bumped
      </Badge>
    ),
    run.startAfter && (
      <Badge
        key="after"
        tone="neutral"
        data-testid="after-chip"
        title={`This run boards after ${run.startAfter} settles`}
      >
        after {run.startAfter}
      </Badge>
    ),
    // What it GOT, never what it asked for: the path is `workRoot`, and the
    // branch is a lane's fact, drawn on the lane row where it is true.
    run.checkout === 'worktree' && (
      <Badge
        key="checkout"
        tone="neutral"
        data-testid="checkout-chip"
        title={
          run.mountedRepos?.length
            ? `${run.workRoot ?? 'a console-managed mirror'} — ${run.mountedRepos.join(', ')}`
            : (run.workRoot ?? 'a console-managed checkout')
        }
      >
        {run.mountedRepos?.length
          ? `own checkout, ${plural(run.mountedRepos.length, 'repo')}`
          : 'own checkout'}
      </Badge>
    ),
    run.checkout === 'refused' && (
      <Badge
        key="refused"
        tone="accent"
        data-testid="refused-chip"
        title={run.isolationRefusal ?? 'isolation was refused'}
      >
        shared checkout
      </Badge>
    ),
  ].filter(Boolean);
  if (!chips.length) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>;
}

/** A lifecycle verb's button, so the verbs are one shape. */
function VerbButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  title,
}: {
  label: string;
  icon: typeof Snowflake;
  onClick: () => void;
  disabled: boolean;
  title: string;
}) {
  return (
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onClick} title={title}>
      <Icon size={13} aria-hidden /> {label}
    </Button>
  );
}

/**
 * Every other verb — the glance carries the one the bay recommends, so it is
 * not drawn twice. The settings verbs (priority, isolation, the bump, a
 * terminal's release) are not lifecycle doors; they share its shape: one busy
 * word, one toast, the same invalidation.
 */
function StripVerbs({
  model,
  run,
  entry,
  lifecycle,
}: {
  model: StripModel;
  run: RunState;
  entry: QueueEntry | undefined;
  lifecycle: RunLifecycle;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const busy = lifecycle.busy != null || pending != null;
  const primary: LifecycleVerb | null = model.action.kind === 'lifecycle' ? model.action.verb : null;
  const priority = runPriority(run.priority);

  const settings = useCallback(
    async (what: string, act: () => Promise<unknown>, said: string) => {
      setPending(what);
      try {
        await act();
        toast(said, 'ok');
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setPending(null);
        void client.invalidateQueries({ queryKey: keys.runs() });
        void client.invalidateQueries({ queryKey: keys.run(run.slug) });
        void client.invalidateQueries({ queryKey: keys.queue() });
        void client.invalidateQueries({ queryKey: keys.state() });
      }
    },
    [client, run.slug],
  );

  const verb = (name: LifecycleVerb, label: string, icon: typeof Snowflake, title: string) =>
    primary === name ? null : (
      <VerbButton
        key={name}
        label={label}
        icon={icon}
        disabled={busy}
        onClick={() => void lifecycle[name]()}
        title={title}
      />
    );
  const holder = entry?.waitingOn?.[0];

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="strip-verbs">
      {model.frozen
        ? verb('thaw', 'Thaw', Play, 'Continue — the session picks up mid-token')
        : verb('freeze', 'Freeze', Snowflake, 'Stop every session of this run where it stands')}
      {run.status === 'pausing'
        ? verb('resume', 'Cancel pause', Play, 'Carry on past the next phase boundary')
        : run.status === 'paused'
          ? verb('resume', 'Resume', Play, 'Carry on from where it stopped')
          : verb('pause', 'Pause', Pause, 'Stop at the next phase boundary')}
      {model.held
        ? verb('release', 'Release', Play, 'Let this run be admitted again')
        : verb('hold', 'Hold', Hand, 'The running phases finish; nothing new is admitted')}
      {holder?.kind === 'session' && holder.session && (
        // The run waits on a TERMINAL (control-tower phase 82, #119): the
        // operator's word against the console's reading, for two hours.
        <VerbButton
          label="Release terminal"
          icon={Unplug}
          disabled={busy}
          onClick={() => {
            const session = holder.session!;
            void settings(
              'release',
              () => api.releaseSessionHold(session, 2),
              `Released terminal session ${session.slice(0, 8)} for 2 h`,
            );
          }}
          title="Stop waiting on this terminal session for two hours — use it when that session is not working in this repository"
        />
      )}
      {entry && !entry.bumped && (
        <VerbButton
          label="Bump"
          icon={ArrowUp}
          disabled={busy}
          onClick={() =>
            void settings(
              'bump',
              () => api.queueBump(entry.id),
              `${run.slug} moved to the front of its class`,
            )
          }
          title="To the front of its own priority class — never across one"
        />
      )}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="danger" disabled={busy}>
            <Square size={13} aria-hidden /> Stop
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title={`Stop ${run.slug}?`}
          description={
            model.bay === 'queued'
              ? 'This takes it out of the line. Nothing is killed — Retry can put the phase back.'
              : 'Its sessions get SIGTERM and the run winds down. Work already committed stays committed.'
          }
          confirmLabel="Stop the run"
          destructive
          onConfirm={() => void lifecycle.stop()}
        />
      </AlertDialog>

      <label className="ml-auto flex items-center gap-1.5 text-2xs text-ink-faint">
        <span>Priority</span>
        <select
          aria-label={`Queue priority for ${run.slug}`}
          className={cn(field, 'h-7 py-0 text-2xs')}
          disabled={busy}
          value={priority}
          onChange={(event) => {
            const next = event.target.value as RunPriority;
            void settings(
              'priority',
              () => api.runSettings(run.slug, { priority: next }),
              `${run.slug} is ${next} priority`,
            );
          }}
        >
          {RUN_PRIORITIES.map((value) => (
            <option key={value} value={value} title={PRIORITY_LABELS[value]}>
              {value}
            </option>
          ))}
        </select>
      </label>

      {/* Isolation is ONE WAY mid-run (phase 5): the drop, never the raise. */}
      {run.checkout === 'worktree' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          title="Give up this run's own checkout — its next phase works in the shared tree, queued"
          onClick={() =>
            void settings(
              'isolation',
              () => api.runSettings(run.slug, { isolation: 'queue' }),
              `${run.slug} will use the shared checkout from its next phase`,
            )
          }
        >
          Drop isolation
        </Button>
      )}
    </div>
  );
}
