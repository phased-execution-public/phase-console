/**
 * The run's Actions tab (7.0, quiet-console phase 11; control-tower phases 90,
 * 97 and 98).
 *
 * Six acts on a run that the 6.x page reached only by a hand-written request:
 * give the run a checkout of its own, give one phase a worktree of its own,
 * board a phase at the next boundary, repair a refused checkout, prepare an
 * errand tree, and give a waiting permission card more time. Each is offered
 * whether or not it applies NOW — a verb that vanishes is a verb nobody knows
 * exists — and one that does not apply says, in one sentence, which of its
 * conditions does not hold. The conditions are the server's own
 * (`server/service-runs.ts`, `runner/runner-control.ts`, the approvals
 * broker), read here as a pure model so the tab and its test agree on them.
 *
 * Every act asks once — press, then Confirm — goes through `press()`, and
 * re-reads the run. Under the six sits the registry's own list, every other
 * verb this run can be pressed with, the panel's shared Actions tab.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PHASE_IN_FLIGHT } from '@shared/run-lifecycle.js';
import { describeWord } from '@shared/status-model.js';
import { ISOLATED } from '@shared/worktree-model.js';
import { runsApi, type Approval, type PhaseRecord, type RunEnvelope, type RunState } from '@/data/api/runs';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { useApprovals } from '@/data/runs';
import { Button, Label, toast } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { ActionsTab } from '@/shell/panel/actions-tab';

/** The six, in the order the tab lists them. */
export type RunActionId =
  'isolate' | 'isolate-phase' | 'board-at-boundary' | 'repair-checkout' | 'errand-tree' | 'extend';

/** One act as the tab offers it: what it is, what it does, and whether it can be pressed now. */
export interface RunActionOffer {
  id: RunActionId;
  label: string;
  /** What pressing it does, in one sentence. */
  summary: string;
  enabled: boolean;
  /** Why it cannot be pressed now — present exactly when `enabled` is false. */
  why?: string;
  /** What it acts on: the picked phase, or the waiting card. */
  target?: { phase?: number; approvalId?: string };
}

/** How much later Extend moves a waiting card — the broker's shorter choice. */
const EXTEND_MINUTES = 30;

const NEEDS_RUN = 'Needs --allow-run on this console.';
const PICK = 'Pick a phase first.';
const OVER = 'The run is over.';

/**
 * Is the run's own loop moving it? A repair is refused then, because its next
 * boundary asks for the checkout again by itself — the server's own four
 * words (`Service.repairCheckout`), compared one by one rather than kept as a
 * second list of the live-run vocabulary.
 */
const driving = (run: RunState): boolean =>
  run.status === 'running' || run.status === 'queued' || run.status === 'halting' || run.status === 'pausing';

/** Over: nothing, not even a press, will drive it again (`runIsOver`). */
const runOver = (run: RunState): boolean => run.status === 'finished' || Boolean(run.resolved);

function offer(
  id: RunActionId,
  label: string,
  summary: string,
  blockers: readonly (string | false | null | undefined)[],
  allowRun: boolean,
  target?: RunActionOffer['target'],
): RunActionOffer {
  const why = allowRun ? blockers.find((b): b is string => typeof b === 'string' && b.length > 0) : NEEDS_RUN;
  return { id, label, summary, enabled: !why, ...(why ? { why } : {}), ...(target ? { target } : {}) };
}

/** The pending cards of THIS run — by its id, or by its plan when a card names no run. */
const cardsOf = (run: RunState, approvals: readonly Approval[]) =>
  approvals.filter(
    (card) => card.status === 'pending' && (card.runId ? card.runId === run.id : card.slug === run.slug),
  );

/**
 * What the six offer for this run, at this phase, on this console — in the
 * tab's order, Extend once per waiting card of the run.
 */
export function runActionsModel(
  run: RunState,
  ctx: { allowRun: boolean; phase: number | null; approvals: readonly Approval[] },
): RunActionOffer[] {
  const { allowRun } = ctx;
  const n = ctx.phase;
  const record: PhaseRecord | undefined = n == null ? undefined : run.phases?.[String(n)];
  const status = record?.status;
  const over = runOver(run);
  const own = run.checkout === 'worktree';
  const pick = n == null && PICK;
  const target = n == null ? undefined : { phase: n };
  const named = n == null ? 'The phase' : `Phase ${n}`;

  const offers: RunActionOffer[] = [
    offer(
      'isolate',
      'Give this run its own checkout',
      'At its next boundary, with none of its lanes live, the run moves to a checkout of its own, out of reach of any other run’s branch.',
      [
        run.gitMode !== 'new-branch' &&
          'Only a run on a branch of its own can move to a checkout of its own.',
        own && 'Only a run on a shared checkout can take one of its own.',
        run.isolateAtBoundary &&
          `Already asked by ${run.isolateAtBoundary.by}: the run moves at its next boundary.`,
        over && OVER,
      ],
      allowRun,
    ),
    offer(
      'isolate-phase',
      n == null ? 'Give a phase its own worktree' : `Give phase ${n} its own worktree`,
      `${named} boards in a worktree of its own${n == null ? '' : ` on pe/${run.slug}-p${n}`} and merges back when it settles.`,
      [
        pick,
        own && 'The run already works in a checkout of its own.',
        status === 'done' && `${named} is done.`,
        status === 'skipped' && `${named} was skipped.`,
        n != null && run.isolatePhases?.includes(n) && `${named} already has a worktree of its own.`,
      ],
      allowRun,
      target,
    ),
    offer(
      'board-at-boundary',
      n == null ? 'Board a phase at the next boundary' : `Board phase ${n} at the next boundary`,
      `${named} boards next, ahead of every other candidate, with the instruction below; its own session is resumed when it has one.`,
      [
        pick,
        status != null &&
          (PHASE_IN_FLIGHT as readonly string[]).includes(status) &&
          `${named} is running now: steer it, or leave a note for its next attempt.`,
        status === 'done' && `${named} is done: there is nothing to board.`,
        over && OVER,
      ],
      allowRun,
      target,
    ),
    offer(
      'repair-checkout',
      'Repair the checkout',
      'Dirty or unpushed work at the run’s mounts is moved aside, never deleted; the mounts are rebuilt and the run resumes.',
      [
        run.isolation !== ISOLATED && 'Only a run that asked for a checkout of its own has one to repair.',
        driving(run) && 'The run is driving: its next boundary asks for the checkout again by itself.',
      ],
      allowRun,
    ),
    offer(
      'errand-tree',
      n == null ? 'Prepare an errand tree' : `Prepare an errand tree for phase ${n}`,
      `A stable checkout of the pushed run branch for ${n == null ? 'the phase' : `phase ${n}`}’s errand, which no prune takes.`,
      [
        pick,
        n != null && !record && `${named} has no record in this run.`,
        status === 'done' && `${named} is done.`,
      ],
      allowRun,
      target,
    ),
  ];

  const label = `Give the waiting card ${EXTEND_MINUTES} more minutes`;
  const cards = cardsOf(run, ctx.approvals);
  if (!cards.length) {
    offers.push(
      offer(
        'extend',
        label,
        `A waiting card’s deadline moves ${EXTEND_MINUTES} minutes later.`,
        ['No card of this run is waiting.'],
        allowRun,
      ),
    );
  }
  for (const card of cards) {
    offers.push(
      offer(
        'extend',
        label,
        `${card.title}${card.phase != null ? `, phase ${card.phase}` : ''}: its deadline moves ${EXTEND_MINUTES} minutes later.`,
        [card.kind === 'question' && 'A relayed question closes on its own clock: Extend does not apply.'],
        allowRun,
        { approvalId: card.id },
      ),
    );
  }
  return offers;
}

/* ------------------------------------------------------------------------- *
 * The tab
 * ------------------------------------------------------------------------- */

/** What each act's button says before it is armed. */
const PRESS_WORDS: Readonly<Record<RunActionId, string>> = {
  isolate: 'Isolate the run',
  'isolate-phase': 'Isolate the phase',
  'board-at-boundary': 'Board next',
  'repair-checkout': 'Repair',
  'errand-tree': 'Prepare the tree',
  extend: `Extend ${EXTEND_MINUTES} min`,
};

/** The run's phase records, by number. */
const recordsOf = (run: RunState): PhaseRecord[] =>
  Object.values(run.phases ?? {}).sort((a, b) => a.phase - b.phase);

/** The phase the picker opens on: the halt's, else the active one, else the first not done. */
function defaultPhase(run: RunState, records: readonly PhaseRecord[]): number | null {
  const held = (n: number | null | undefined): n is number => n != null && records.some((r) => r.phase === n);
  const halted = run.halt?.phase;
  if (held(halted)) return halted;
  if (held(run.activePhase)) return run.activePhase;
  return records.find((r) => r.status !== 'done')?.phase ?? records[0]?.phase ?? null;
}

const lower = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** The request each act makes. */
function requestOf(slug: string, offer: RunActionOffer, instruction: string): Promise<unknown> {
  const phase = offer.target?.phase;
  const card = offer.target?.approvalId;
  switch (offer.id) {
    case 'isolate':
      return runsApi.runIsolate(slug);
    case 'repair-checkout':
      return runsApi.runRepairCheckout(slug);
    case 'extend':
      return card
        ? runsApi.extend(card, EXTEND_MINUTES)
        : Promise.reject(new Error('No card of this run is waiting.'));
  }
  if (phase == null) return Promise.reject(new Error(PICK));
  switch (offer.id) {
    case 'isolate-phase':
      return runsApi.runIsolatePhase(slug, phase);
    case 'board-at-boundary':
      return runsApi.runBoardAtBoundary(slug, phase, instruction.trim() || undefined);
    case 'errand-tree':
      return runsApi.runErrandTree(slug, phase);
  }
}

/** What the toast says once the server took the act. */
function saidOf(slug: string, offer: RunActionOffer, result: unknown): string {
  const n = offer.target?.phase;
  switch (offer.id) {
    case 'isolate':
      return `${slug} moves to a checkout of its own at its next boundary.`;
    case 'isolate-phase':
      return `Phase ${n} boards in a worktree of its own.`;
    case 'board-at-boundary': {
      const answer = result as RunEnvelope | undefined;
      if (answer?.launched)
        return `Phase ${n} boarded${answer.launched.session ? `, resuming session ${answer.launched.session.slice(0, 8)}` : ', fresh'}.`;
      if (answer?.queued?.position)
        return `Phase ${n} boards at the next boundary, place ${answer.queued.position} in line.`;
      return `Phase ${n} boards at the next boundary.`;
    }
    case 'repair-checkout':
      return `${slug} resumes with its checkout rebuilt.`;
    case 'errand-tree': {
      const answer = result as { tree?: { dir?: string }; adopted?: boolean } | undefined;
      const dir = answer?.tree?.dir ?? 'its place';
      return answer?.adopted ? `The errand tree stands at ${dir}.` : `Errand tree ready at ${dir}.`;
    }
    case 'extend': {
      const answer = result as { standing?: boolean } | undefined;
      return answer?.standing
        ? 'The card now stands: it stays answerable after its call ends.'
        : `The card waits ${EXTEND_MINUTES} more minutes.`;
    }
  }
}

export function RunActions({ run, slug, allowRun }: { run: RunState; slug: string; allowRun: boolean }) {
  const client = useQueryClient();
  const pickerId = useId();
  const records = useMemo(() => recordsOf(run), [run]);
  const [picked, setPicked] = useState<number | null>(null);
  const phase =
    picked != null && records.some((r) => r.phase === picked) ? picked : defaultPhase(run, records);
  const [instruction, setInstruction] = useState('');
  const { data: approvals } = useApprovals(true);
  const { data: state } = useConsoleState();
  const offers = runActionsModel(run, { allowRun, phase, approvals: approvals ?? [] });

  const fire = useCallback(
    async (offer: RunActionOffer) => {
      try {
        const pressed = await press(() => requestOf(slug, offer, instruction));
        if (pressed.state === 'asked') toast(pressed.words, 'info');
        else toast(saidOf(slug, offer, pressed.result), 'ok');
        if (offer.id === 'board-at-boundary') setInstruction('');
      } catch (error) {
        toast(String((error as Error)?.message || 'The request failed and said nothing.'), 'error');
      } finally {
        for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
      }
    },
    [client, slug, instruction],
  );

  return (
    <div data-testid="run-actions" className="flex min-w-0 flex-col gap-3">
      {records.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Label htmlFor={pickerId}>Phase</Label>
          <NativeSelect
            id={pickerId}
            value={phase ?? ''}
            onChange={(event) => setPicked(Number(event.target.value))}
          >
            {records.map((record) => (
              <option key={record.phase} value={record.phase}>
                Phase {record.phase}, {lower(describeWord('phase', record.status).label)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : (
        <p className="text-meta text-ink-muted">This run has no phase on record yet.</p>
      )}
      <ul className="flex min-w-0 flex-col gap-1" aria-label="Acts on this run">
        {offers.map((item) => (
          <ActionRow
            key={`${item.id}:${item.target?.approvalId ?? item.target?.phase ?? ''}`}
            offer={item}
            onPress={fire}
          >
            {item.id === 'board-at-boundary' && item.enabled && (
              <Textarea
                aria-label="Instruction"
                placeholder="Optional: what the phase should do when it boards"
                block
                rows={2}
                maxLength={8000}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
            )}
          </ActionRow>
        ))}
      </ul>
      <Disclosure label="Every other verb" openLabel="Every other verb" testId="run-actions-other">
        <ActionsTab
          kind="run"
          args={{ slug, runId: run.id }}
          capabilities={state as Parameters<typeof ActionsTab>[0]['capabilities']}
        />
      </Disclosure>
    </div>
  );
}

/** One act: its name, what it does or why it cannot, and the button that asks once. */
function ActionRow({
  offer,
  onPress,
  children,
}: {
  offer: RunActionOffer;
  onPress: (offer: RunActionOffer) => Promise<void>;
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const click = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await onPress(offer);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <li
      data-testid="run-action"
      data-action={offer.id}
      data-enabled={offer.enabled ? 'true' : 'false'}
      className="flex min-w-0 flex-col gap-1.5 py-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-60">
          <p className="break-words text-body text-ink">{offer.label}</p>
          <p className="break-words text-meta text-ink-muted" data-testid="run-action-words">
            {offer.enabled ? offer.summary : offer.why}
          </p>
        </div>
        <Button
          size="sm"
          variant={armed ? 'primary' : 'default'}
          disabled={!offer.enabled || busy}
          onClick={() => void click()}
          onBlur={() => {
            if (!busy) setArmed(false);
          }}
        >
          {busy ? 'Pressing…' : armed ? 'Confirm' : PRESS_WORDS[offer.id]}
        </Button>
      </div>
      {children}
    </li>
  );
}
