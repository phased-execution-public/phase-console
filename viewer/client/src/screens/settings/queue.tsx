/**
 * The queue — how this console orders the phases waiting to start, and when
 * the machine is too loaded to start more (7.0, quiet-console phase 21; the
 * policies and the guard are control-tower phase 100's, which no 6.x page
 * could change).
 *
 * ```
 * The queue                                               Open the queue
 * Scheduling policy                                      [ Seniority     ▾ ]
 * First come, first served.
 * Plans with a policy of their own
 *   shop                                [ Critical path ▾ ]  Follow the console
 *   The longest remaining chain first.
 *   Plan [ trade ▾ ]  Policy [ Blocker first ▾ ]  Give the plan its own policy
 * Load guard                                             [ 1.5 ] times the cores
 * New work waits while the machine's 5-minute load is above this many times its cores; …
 * The 5-minute load is 8.1; new work waits above 21 (1.5 times 14 cores).
 * ```
 *
 * The three keys are written through the queue's own door, `POST
 * /api/queue/policy` (`useQueuePolicyWrite`) — never `POST /api/prefs`, which
 * the schema marks them unwritable for — and read from the queue's answer
 * (`GET /api/queue`: `policy` and `load`), so the page shows what the
 * scheduler runs with. The door is run-class: a console without `--allow-run`
 * refuses it, so every control here is off and says why. A press the owner
 * door turns into a request is said in the server's words, never as a save.
 *
 * A policy's label is one string with its explanation after a dash
 * (`SCHEDULING_POLICY_LABELS`); it is drawn as two things — the name in the
 * choice, the explanation under it.
 */

import { useEffect, useId, useState } from 'react';
import { SCHEDULING_POLICIES, SCHEDULING_POLICY_LABELS } from '@shared/orchestration-model.js';
import type { QueueLoad, QueueView } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { usePlans } from '@/data/plans';
import { useQueue, useQueuePolicyWrite, type QueuePolicyChange } from '@/data/queue';
import { isClosed } from '@/lib/closure';
import { plural } from '@/lib/format';
import { queueHref } from '@/shell/routes';
import { Banner, Button, Input, Label, Skeleton, toast } from '@/ui';
import { NativeSelect } from '@/ui/native-select';
import { Origin, SettingRow, SettingsGroup, failureWords, useSchemaRow } from './setting';

/** Why every control here is off on a console that may not start work. */
export const RUN_OFF_WORDS = 'Start the console with --allow-run to change what starts.';

/** A policy as two words: its name, and what it does as a sentence — never one dashed label. */
export function schedulingWords(policy: string): { name: string; explanation: string | null } {
  const label = (SCHEDULING_POLICY_LABELS as Readonly<Record<string, string>>)[policy];
  if (!label) return { name: policy, explanation: null };
  const [name = policy, ...rest] = label.split(' — ');
  const said = rest.join(' — ').trim();
  return {
    name: name.trim(),
    explanation: said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}.` : null,
  };
}

/** The load guard's reading now, in words: off, holding new work, or what it would hold at. */
export function loadGuardWords(load: QueueLoad): string {
  if (load.factor === null || load.threshold === null) {
    return 'The guard is off: new work starts however loaded the machine is.';
  }
  const basis = `${load.factor} times ${plural(load.cores, 'core')}`;
  return load.holding
    ? `Holding new work now: the 5-minute load is ${load.avg5}, over ${load.threshold} (${basis}). Live lanes carry on.`
    : `The 5-minute load is ${load.avg5}; new work waits above ${load.threshold} (${basis}).`;
}

const LINK =
  'tap-line text-meta text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink';

export function QueueGroup() {
  const state = useConsoleState();
  const queue = useQueue();
  const plans = usePlans();
  const write = useQueuePolicyWrite();
  const view = queue.data;

  // Unknown until the state answers: off, but not yet said to be refused.
  const known = state.data !== undefined;
  const off = state.data?.allowRun !== true;
  const why = known && off ? RUN_OFF_WORDS : undefined;

  /** Press the door; a request the owner confirms is said as one, and a refusal in the server's words. */
  const send = async (change: QueuePolicyChange): Promise<boolean> => {
    try {
      const pressed = await write.mutateAsync(change);
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 6000);
        return false;
      }
      return true;
    } catch (error) {
      toast(failureWords(error), 'error');
      return false;
    }
  };
  // The change in flight stands on screen until the server answers; an asked
  // or refused one then gives way to what the server still holds.
  const pending = write.isPending ? write.variables : undefined;

  return (
    <SettingsGroup
      id="queue"
      title="The queue"
      lead="How the queue orders the phases waiting in it, and when the machine is too loaded to start more. The next scan uses a change."
      aside={
        <a href={queueHref()} className={LINK}>
          Open the queue
        </a>
      }
    >
      {why && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="queue-run-off">
          {why}
        </p>
      )}
      {!view ? (
        queue.error ? (
          <Banner
            severity="error"
            action={
              <Button size="sm" variant="ghost" onClick={() => void queue.refetch()}>
                Try again
              </Button>
            }
          >
            The queue could not be read: {queue.error.message || 'the read failed and said nothing.'}
          </Banner>
        ) : (
          <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Reading the queue">
            <Skeleton className="h-9 max-w-md" />
            <Skeleton className="h-9 max-w-md" />
          </div>
        )
      ) : (
        <>
          {view.policy ? (
            <PolicyRows
              policy={view.policy}
              plans={(plans.data ?? []).filter((plan) => !isClosed(plan)).map((plan) => plan.slug)}
              pending={pending}
              off={off}
              why={why}
              send={send}
            />
          ) : (
            <p className="text-meta text-ink-muted">This console does not say how its queue is ordered.</p>
          )}
          {view.load ? (
            <LoadRow load={view.load} pending={pending} off={off} why={why} send={send} />
          ) : (
            <p className="text-meta text-ink-muted">This console does not report a load guard.</p>
          )}
        </>
      )}
    </SettingsGroup>
  );
}

interface RowProps {
  pending: QueuePolicyChange | undefined;
  off: boolean;
  why: string | undefined;
  send: (change: QueuePolicyChange) => Promise<boolean>;
}

/** The choices of one policy select: each policy by its name alone. */
function PolicyOptions() {
  return (
    <>
      {SCHEDULING_POLICIES.map((word) => (
        <option key={word} value={word}>
          {schedulingWords(word).name}
        </option>
      ))}
    </>
  );
}

function PolicyRows({
  policy,
  plans,
  pending,
  off,
  why,
  send,
}: RowProps & { policy: NonNullable<QueueView['policy']>; plans: string[] }) {
  const id = useId();
  const own = useSchemaRow('schedulingPolicies');
  const consoleWord =
    pending && pending.slug === undefined && typeof pending.policy === 'string'
      ? pending.policy
      : policy.console;
  const owned = Object.entries(policy.plans).sort(([a], [b]) => a.localeCompare(b));
  const addable = plans.filter((slug) => !(slug in policy.plans));

  return (
    <>
      <SettingRow
        pref="schedulingPolicy"
        label="Scheduling policy"
        hint={schedulingWords(consoleWord).explanation}
      >
        {({ id: control, describedBy }) => (
          <NativeSelect
            id={control}
            aria-describedby={describedBy}
            className="w-full sm:w-auto sm:max-w-72"
            value={consoleWord}
            disabled={off}
            {...(why ? { title: why } : {})}
            onChange={(event) => void send({ policy: event.target.value })}
          >
            <PolicyOptions />
          </NativeSelect>
        )}
      </SettingRow>

      <div
        data-pref="schedulingPolicies"
        role="group"
        aria-labelledby={`${id}-plans`}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${id}-plans`} className="text-body font-medium text-ink">
            Plans with a policy of their own
          </h3>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            A plan’s own policy orders its phases instead of the console’s, until it is given back.
          </p>
        </div>
        {owned.length ? (
          owned.map(([slug, word]) => {
            const shown =
              pending && pending.slug === slug && typeof pending.policy === 'string' ? pending.policy : word;
            return (
              <div key={slug} data-plan-policy={slug} className="min-w-0">
                <SettingRow label={slug} hint={schedulingWords(shown).explanation}>
                  {({ id: control, describedBy }) => (
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <NativeSelect
                        id={control}
                        aria-describedby={describedBy}
                        className="w-full sm:w-auto sm:max-w-56"
                        value={shown}
                        disabled={off}
                        {...(why ? { title: why } : {})}
                        onChange={(event) => void send({ slug, policy: event.target.value })}
                      >
                        <PolicyOptions />
                      </NativeSelect>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={off}
                        aria-label={`Make ${slug} follow the console’s policy`}
                        onClick={() => void send({ slug, policy: null })}
                      >
                        Follow the console
                      </Button>
                    </span>
                  )}
                </SettingRow>
              </div>
            );
          })
        ) : (
          <p className="text-meta text-ink-muted">Every plan follows the console’s policy.</p>
        )}
        {addable.length > 0 && (
          <GiveOwn plans={addable} consoleWord={policy.console} off={off} why={why} send={send} />
        )}
        <Origin pref="schedulingPolicies" row={own.row} files={own.files} />
      </div>
    </>
  );
}

/** Give an open plan a policy of its own: the plan, the word, one press. */
function GiveOwn({
  plans,
  consoleWord,
  off,
  why,
  send,
}: Omit<RowProps, 'pending'> & { plans: string[]; consoleWord: string }) {
  const id = useId();
  const [picked, setPicked] = useState('');
  const [word, setWord] = useState<string | null>(null);
  const slug = plans.includes(picked) ? picked : (plans[0] ?? '');
  const chosen = word ?? consoleWord;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-plan`}>Plan</Label>
        <NativeSelect
          id={`${id}-plan`}
          className="w-48"
          value={slug}
          disabled={off}
          {...(why ? { title: why } : {})}
          onChange={(event) => setPicked(event.target.value)}
        >
          {plans.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-word`}>Policy</Label>
        <NativeSelect
          id={`${id}-word`}
          className="w-44"
          value={chosen}
          disabled={off}
          {...(why ? { title: why } : {})}
          onChange={(event) => setWord(event.target.value)}
        >
          <PolicyOptions />
        </NativeSelect>
      </div>
      <Button
        size="sm"
        disabled={off || !slug}
        onClick={() =>
          void send({ slug, policy: chosen }).then((done) => {
            if (!done) return;
            setPicked('');
            setWord(null);
          })
        }
      >
        Give the plan its own policy
      </Button>
    </div>
  );
}

/**
 * The guard's factor, committed like every number in Settings: on leaving the
 * field or on Enter, never on each keystroke. `0` switches the guard off.
 */
function LoadRow({ load, pending, off, why, send }: RowProps & { load: QueueLoad }) {
  // A guard that is off reads as the 0 that switched it off.
  const held = typeof pending?.loadFactor === 'number' ? pending.loadFactor : (load.factor ?? 0);
  const shown = String(held);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === shown) return setError(null);
    const read = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(read)) return setError('Type a number.');
    if (read < 0) return setError('Type 0 or more; 0 switches the guard off.');
    setError(null);
    if (read === held) return setText(shown);
    void send({ loadFactor: read });
  };

  return (
    <SettingRow
      pref="loadGuardFactor"
      label="Load guard"
      hint="New work waits while the machine’s 5-minute load is above this many times its cores; 0 switches the guard off. Live lanes are never touched."
      note={error ?? undefined}
      facts={
        <span className="min-w-0 break-words text-ink" data-testid="load-reading">
          {loadGuardWords(load)}
        </span>
      }
    >
      {({ id, describedBy }) => (
        <span className="flex min-w-0 items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            step={0.1}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="w-28"
            value={text}
            disabled={off}
            {...(why ? { title: why } : {})}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                setText(shown);
                setError(null);
              }
            }}
          />
          <span className="shrink-0 text-meta text-ink-muted">times the cores</span>
        </span>
      )}
    </SettingRow>
  );
}
