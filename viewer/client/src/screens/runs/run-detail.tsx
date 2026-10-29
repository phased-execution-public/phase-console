/**
 * The run row, expanded in place (7.0, quiet-console phase 7; the strip's
 * expansion since control-tower phase 19): a person's turn whole · the halt
 * card · the lanes · the queue's facts · Now · the clocks · the standing facts ·
 * the full track · the cost · every verb · Inspect · Open run.
 *
 * Every fact the 6.2 strip showed lives here or on the glance — one press from
 * the home, never a navigation (`strip.datums.test.tsx` is the ledger). The
 * row folds from a SLIM run (#234) and draws what it knows the moment it
 * opens; the whole record — the lanes' cost and tasks, the fences, the clocks,
 * the queue marks — is read for the opened row alone (`useRun`) and lands in
 * place. A caller that already holds the record hands it over and nothing is
 * fetched.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ExternalLink, Hand, Pause, Play, Snowflake, Square, Unplug } from 'lucide-react';
import {
  PRIORITY_LABELS,
  RUN_PRIORITIES,
  runPriority,
  type RunPriority,
} from '@shared/orchestration-model.js';
import { waitNote } from '@shared/status-model.js';
import { HaltCard } from '@/cards/halt-card';
import { LazyStepCard } from '@/cards/lazy-step-card';
import { RecoveryActions, type RecoveryCtx } from '@/cards/recovery-actions';
import type { QueueEntry } from '@/data/api';
import { runsApi, type RunState } from '@/data/api/runs';
import { stateApi } from '@/data/api/state';
import { keys } from '@/data/keys';
import { asRunLike, glanceOf, laneSilent, type NowLane, type RunLike } from '@/data/lanes';
import type { Lifecycle, LifecycleVerb } from '@/data/lifecycle';
import { press } from '@/data/press';
import { holderLabel, waitingLabel } from '@/data/queue-words';
import type { PlacedRun } from '@/data/run-groups';
import { runStopOf } from '@/data/run-stop';
import { useRun } from '@/data/runs';
import { cn } from '@/lib/cn';
import { clockWords, holderEtaText, money, plural } from '@/lib/format';
import { Button, KeyValue, Money, Mono, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { NativeSelect } from '@/ui/native-select';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { runHref } from '@/shell/routes';
import { VerifyingLaneRow, withChecks } from '@/screens/plan/run/verifying';
import { LastActivity, LiveNow } from '@/screens/plan/run/activity';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { fullTrack, laneClock, phaseClockList, recordOfId, type RunRowModel } from './model';

export interface RunDetailProps {
  placed: PlacedRun;
  model: RunRowModel;
  /** The whole record, when the caller holds it — nothing is fetched then. */
  record?: RunState | undefined;
  allowRun: boolean;
  /** The row's own lifecycle — one busy word for the glance's action and these verbs. */
  lifecycle: Lifecycle;
  now: number;
  /** Inspect — hands the panel the record the row holds by then. */
  onInspect: (record: RunState | undefined) => void;
}

export function RunDetail({
  placed,
  model,
  record,
  allowRun,
  lifecycle,
  now,
  onInspect,
}: RunDetailProps) {
  const { run: row, lanes, checks, entry } = placed;
  // The whole record, for the opened row alone — unless the caller holds it.
  const { data: detail } = useRun(row.slug, record == null);
  const whole = record ?? recordOfId(detail, row.id);
  const run: RunLike = whole ?? row;
  const folded = asRunLike(run) as RunState;
  const glance = glanceOf(run);
  const live = model.view.tense === 'live';
  // The clocks of the phase the glance is about: a live lane's, else the one
  // the run stopped on, else its active phase — the whole record's.
  const clockPhase = model.livePhases[0] ?? run.halt?.phase ?? run.activePhase;
  const active = clockPhase != null && whole ? whole.phases?.[String(clockPhase)] : undefined;
  const liveActive = active != null && model.livePhases.includes(active.phase);
  const note = waitNote(folded as Parameters<typeof waitNote>[0]);
  // A run that parked with its stop on a PHASE's record (a red verification, a
  // spent wait) carries no halt of its own, and still has a card (#305) — the
  // Run view's reader, so the two pages agree.
  const stop = runStopOf(folded, live);

  return (
    <div className="flex min-w-0 flex-col gap-3 py-3" data-testid="strip-detail">
      {/* A person's turn, whole — the row's one action is its primary (phase 42). */}
      {model.action.kind === 'step' && <LazyStepCard item={model.action.item} />}
      {stop && (
        <HaltCard
          run={stop === folded.halt ? folded : { ...folded, halt: stop }}
          live={live}
          parts={ACCOUNT_RECOVERY_PARTS}
        />
      )}
      {note && (
        <p className="text-meta text-ink-muted" data-testid="wait-note">
          {note}
        </p>
      )}

      {(lanes.length > 0 || checks.length > 0) && (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="Lanes">
          {/* The lanes, with the console's own checks placed against them — in
              place of a lane with no session, beside one with a session (#68). */}
          {withChecks(lanes, checks).map((item) =>
            item.kind === 'check' ? (
              <VerifyingLaneRow key={`${row.id}~check#${item.check.phase}`} check={item.check} />
            ) : (
              <LaneRow key={item.lane.key} lane={item.lane} record={whole} slug={row.slug} now={now} />
            ),
          )}
        </ul>
      )}

      <QueueFacts group={model.bay} entry={entry} lanes={lanes} now={now} />

      {/* Phase 95's Now panel for each live lane — the task timeline, the
          active operation and the summary line (#163). Fetched only while open. */}
      {model.livePhases.length > 0 && <LiveNow slug={row.slug} phases={model.livePhases} />}

      {active && (
        <section aria-label={`Clocks for phase ${active.phase}`} className="flex min-w-0 flex-col gap-1">
          <h4 className="text-meta font-medium text-ink">Phase {active.phase} clocks</h4>
          <KeyValue
            items={phaseClockList(active, now, liveActive).map(
              (clock) => [sentence(clock.label), clockWords(clock)] as const,
            )}
          />
        </section>
      )}

      <StandingFacts run={run} record={whole} entry={entry} />

      {glance.phases.length > 0 && (
        <Track orientation="vertical" label="Phases" className="max-w-(--measure)">
          {fullTrack(glance.phases, model.observed).map((station) => (
            <Station
              key={station.key}
              paint={station.paint}
              settled={station.settled}
              live={station.live}
              data-phase={station.phase}
            >
              {station.label}
            </Station>
          ))}
        </Track>
      )}

      <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
        <Money usd={model.cost.spentUsd} against={model.cost.budgetUsd} className="text-body" />
        <span className="tnum" data-testid="detail-phases">
          {model.done}/{model.total} phases
        </span>
        {model.cost.liveUsd > 0 && <span>{money(model.cost.liveUsd)} in flight, booked when it ends</span>}
      </p>

      {allowRun && (
        <Verbs model={model} run={run} record={whole} lanes={lanes} entry={entry} lifecycle={lifecycle} />
      )}

      {/* The repair verbs for a run that waits without a halt card to carry
          them — `RecoveryActions` decides which apply and draws nothing when
          none does. A stop's own card above already carries its ways forward. */}
      {!run.halt && (model.bay === 'waiting' || model.bay === 'needs-you') && (
        <RecoveryActions
          target={{ slug: row.slug, runId: row.id }}
          ctx={{ run: folded } as RecoveryCtx}
          max={2}
          parts={ACCOUNT_RECOVERY_PARTS}
        />
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-rule pt-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onInspect(whole)}
          title="Everything this console knows about this run"
        >
          Inspect
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={runHref(row.slug)}>
            <ExternalLink size={13} aria-hidden /> Open run
          </a>
        </Button>
      </div>
    </div>
  );
}

const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

/**
 * One lane: its phase, its title or status, its branch as a machine value,
 * when it was last heard from, its clock LABELLED rather than bare, and —
 * once the whole record lands — what it cost. A slim lane says what the slim
 * row knows (`lane.slim`); the rest fills in.
 */
function LaneRow({
  lane,
  record,
  slug,
  now,
}: {
  lane: NowLane;
  record: RunState | undefined;
  slug: string;
  now: number;
}) {
  const phase = record?.phases?.[String(lane.phase)];
  const moving = !lane.frozen && (lane.status === 'running' || lane.status === 'verifying');
  const beat = lane.liveness?.lastOutputAt;
  const silent = laneSilent(lane, now);
  const spoken = lane.frozen ? 'frozen' : lane.status;
  return (
    <li
      data-testid="board-lane"
      data-phase={lane.phase}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-s-2 ps-3 text-meta',
        lane.frozen ? 'border-needs-you' : moving ? 'border-running' : 'border-rule',
      )}
    >
      <span className="text-ink tnum">P{lane.phase}</span>
      <span className="min-w-0 flex-1 truncate text-ink-muted">{lane.title ?? spoken}</span>
      {lane.child?.branch && <Mono value={lane.child.branch} chars={32} />}
      <span className="flex min-w-0 flex-wrap items-center gap-x-3">
        {beat && (
          <span data-testid="lane-beat" className={silent ? 'text-failed' : 'text-ink-muted'}>
            {clockWords({ verb: 'heard', ms: now - new Date(beat).getTime(), tense: 'ago' })}
          </span>
        )}
        <span className="text-ink-muted tnum" data-testid="lane-clock">
          {clockWords(laneClock(lane, phase, now))}
        </span>
        {!lane.slim && lane.costUsd > 0 && <Money usd={lane.costUsd} />}
        {(lane.model || lane.effort) && (
          <span className="text-ink-muted">
            {lane.model ?? 'the run’s model'}
            {lane.effort ? ` at ${lane.effort}` : ''}
          </span>
        )}
        {lane.frozen && <span className="text-needs-you">frozen</span>}
      </span>
      {moving && <LastActivity slug={slug} phase={lane.phase} />}
    </li>
  );
}

/** Why it is not moving, in the queue's own words — the ones the queued pane reads. */
function QueueFacts({
  group,
  entry,
  lanes,
  now,
}: {
  group: string;
  entry: QueueEntry | undefined;
  lanes: readonly NowLane[];
  now: number;
}) {
  if (group !== 'queued' && !entry) return null;
  const queuedLane = lanes.some((lane) => lane.status === 'queued');
  const holder = entry?.waitingOn?.[0];
  return (
    <div className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
      {(group === 'queued' || queuedLane) && (
        <p data-testid="board-holder">
          {waitingLabel(entry)}
          {entry ? `, ${clockWords({ verb: 'queued', ms: now - entry.since, tense: 'for' })}` : ''}
          {entry?.branch && holder?.branch
            ? `, you ${entry.branch}, them ${holder.branch}`
            : holder?.branch
              ? `, on ${holder.branch}`
              : ''}
          {holder?.eta?.label ? `, ${holderEtaText(holder.eta, holder.phase)}` : ''}
        </p>
      )}
      {entry && entry.waitingOn.length > 1 && (
        <p>
          Also behind{' '}
          {entry.waitingOn
            .slice(1)
            .map((h) => holderLabel(h.kind, h.slug, h.phase))
            .join(', ')}
          .
        </p>
      )}
      {entry?.held && (
        <p data-testid="board-held-note">
          {clockWords({ verb: 'Held', ms: now - Date.parse(entry.held.at), tense: 'ago' })}
          {entry.held.by ? ` by ${entry.held.by}` : ''} — release it to let this line move.
        </p>
      )}
      {entry?.after && <p>Chained behind {entry.after}, which has not settled.</p>}
    </div>
  );
}

/** The run's standing facts, as words — what the old card's header carried as chips. */
function StandingFacts({
  run,
  record,
  entry,
}: {
  run: RunLike;
  record: RunState | undefined;
  entry: QueueEntry | undefined;
}) {
  const priority = record ? runPriority(record.priority) : 'normal';
  const facts: { key: string; text: string; title?: string; loud?: boolean }[] = [];
  if (priority !== 'normal')
    facts.push({ key: 'priority-chip', text: `${priority} priority`, loud: priority === 'high' });
  if (entry?.bumped) facts.push({ key: 'bumped-chip', text: 'bumped', loud: true });
  if (record?.startAfter)
    facts.push({
      key: 'after-chip',
      text: `after ${record.startAfter}`,
      title: `This run boards after ${record.startAfter} settles`,
    });
  // What it GOT, never what it asked for: the path is `workRoot`, and the
  // branch is a lane's fact, drawn on the lane row where it is true.
  if (record?.checkout === 'worktree')
    facts.push({
      key: 'checkout-chip',
      text: record.mountedRepos?.length
        ? `own checkout, ${plural(record.mountedRepos.length, 'repo')}`
        : 'own checkout',
      title: record.mountedRepos?.length
        ? `${record.workRoot ?? 'a console-managed mirror'} — ${record.mountedRepos.join(', ')}`
        : (record.workRoot ?? 'a console-managed checkout'),
    });
  if (record?.checkout === 'refused')
    facts.push({
      key: 'refused-chip',
      text: 'shared checkout',
      title: record.isolationRefusal ?? 'isolation was refused',
    });
  if (run.hold) facts.push({ key: 'hold-chip', text: `held${run.hold.by ? ` by ${run.hold.by}` : ''}` });
  if (!facts.length) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
      {facts.map((fact) => (
        <span
          key={fact.key}
          data-testid={fact.key}
          title={fact.title}
          className={cn(fact.loud && 'text-ink')}
        >
          {fact.text}
        </span>
      ))}
    </p>
  );
}

/**
 * Every other verb — the glance carries the one the group recommends, so it
 * is not drawn twice. The settings verbs (priority, isolation, the bump, a
 * terminal's release, the queue's order) are not lifecycle doors; they share
 * its shape through `press()`: one busy word, one toast, the same
 * invalidation.
 */
function Verbs({
  model,
  run,
  record,
  lanes,
  entry,
  lifecycle,
}: {
  model: RunRowModel;
  run: RunLike;
  record: RunState | undefined;
  lanes: readonly NowLane[];
  entry: QueueEntry | undefined;
  lifecycle: Lifecycle;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const busy = lifecycle.busy != null || pending != null;
  const primary: LifecycleVerb | null = model.action.kind === 'lifecycle' ? model.action.verb : null;
  const priority = record ? runPriority(record.priority) : 'normal';
  const slug = run.slug;

  const settings = useCallback(
    async (what: string, act: () => Promise<unknown>, said: string) => {
      setPending(what);
      try {
        const pressed = await press(act);
        toast(pressed.state === 'asked' ? pressed.words : said, pressed.state === 'asked' ? 'info' : 'ok');
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setPending(null);
        for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({ queryKey: keys.queue() });
        void client.invalidateQueries({ queryKey: keys.state() });
      }
    },
    [client, slug],
  );

  const verb = (name: LifecycleVerb, label: string, Icon: typeof Snowflake, title: string) =>
    primary === name ? null : (
      <Button
        key={name}
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void lifecycle.act(name)}
        title={title}
      >
        <Icon size={13} aria-hidden /> {label}
      </Button>
    );
  const holder = entry?.waitingOn?.[0];
  // The queued lanes beyond the first: each can be boarded first instead.
  const queued = lanes.filter((lane) => lane.status === 'queued').map((lane) => lane.phase);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2" data-testid="strip-verbs">
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
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const session = holder.session!;
            void settings(
              'release',
              () => stateApi.releaseSessionHold(session, 2),
              `Released terminal session ${session.slice(0, 8)} for 2 h`,
            );
          }}
          title="Stop waiting on this terminal session for two hours — use it when that session is not working in this repository"
        >
          <Unplug size={13} aria-hidden /> Release terminal
        </Button>
      )}
      {entry && !entry.bumped && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void settings(
              'bump',
              () => stateApi.queueBump(entry.id),
              `${slug} moved to the front of its class`,
            )
          }
          title="To the front of its own priority class — never across one"
        >
          <ArrowUp size={13} aria-hidden /> Bump
        </Button>
      )}
      {queued.slice(1).map((phase) => (
        <Button
          key={`board-${phase}`}
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid="board-first"
          data-phase={phase}
          onClick={() =>
            void settings(
              'reorder',
              () => stateApi.queueReorder(slug, [phase, ...queued.filter((p) => p !== phase)]),
              `P${phase} boards first`,
            )
          }
          title={`Board phase ${phase} before the other queued phases of this run`}
        >
          Board P{phase} first
        </Button>
      ))}
      <ConfirmButton
        size="sm"
        variant="danger"
        destructive
        disabled={busy}
        title={`Stop ${slug}?`}
        description={
          model.bay === 'queued'
            ? 'This takes it out of the line. Nothing is killed — Retry can put the phase back.'
            : 'Its sessions get SIGTERM and the run winds down. Work already committed stays committed.'
        }
        confirmLabel="Stop the run"
        onConfirm={() => void lifecycle.act('stop')}
      >
        <Square size={13} aria-hidden /> Stop
      </ConfirmButton>

      <label className="ms-auto flex items-center gap-1.5 text-meta text-ink-muted">
        <span>Priority</span>
        <NativeSelect
          aria-label={`Queue priority for ${slug}`}
          className="h-8 py-0 text-meta"
          disabled={busy || !record}
          value={priority}
          onChange={(event) => {
            const next = event.target.value as RunPriority;
            void settings(
              'priority',
              () => runsApi.runSettings(slug, { priority: next }),
              `${slug} is ${next} priority`,
            );
          }}
        >
          {RUN_PRIORITIES.map((value) => (
            <option key={value} value={value} title={PRIORITY_LABELS[value]}>
              {value}
            </option>
          ))}
        </NativeSelect>
      </label>

      {/* Isolation is ONE WAY mid-run (phase 5): the drop, never the raise. */}
      {record?.checkout === 'worktree' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          title="Give up this run's own checkout — its next phase works in the shared tree, queued"
          onClick={() =>
            void settings(
              'isolation',
              () => runsApi.runSettings(slug, { isolation: 'queue' }),
              `${slug} will use the shared checkout from its next phase`,
            )
          }
        >
          Drop isolation
        </Button>
      )}
    </div>
  );
}
