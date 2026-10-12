/**
 * The Run view's Triggers fold (7.0, quiet-console phase 11; control-tower
 * phase 98, #137).
 *
 * A stored trigger is a correction kept where the console can see it — "when
 * phase 4 is done, resume the run" — instead of a shell script polling the
 * console for six hours. It is stored per PLAN (`server/triggers.ts`), so this
 * fold lists every one the plan holds: the armed ones first, oldest first,
 * because they are what will still happen; then the ended ones, newest end
 * first, because they are what just did. Each line says what it waits for in
 * words, the verb it presses, once or every time, when it expires, who armed
 * it and what its firings came to.
 *
 * Arming is one small form under its own fold. The `when` it composes is
 * judged by `parseWhen` — the one grammar the server, the CLI and the long poll
 * share — BEFORE anything is posted, so a phase number that is not one is
 * refused here in the grammar's own words. The server still has the last word:
 * its refusal is toasted as it said it.
 */

import { useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  OPERATOR_VERBS,
  PHASE_TRIGGER_EVENTS,
  TRIGGER_EVENTS,
  TRIGGERS_PER_PLAN,
  parseWhen,
  whenGrammar,
} from '@shared/verb-model.js';
import { runsApi, type StoredTrigger } from '@/data/api/runs';
import { press } from '@/data/press';
import { triggersKey, useTriggers } from '@/data/runs';
import { pad2, plural } from '@/lib/format';
import { Button, Input, Label, Mono, RelativeTime, Spinner, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';

type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** The verbs a trigger may press — the table's `trigger` rows, in its order. */
const TRIGGER_VERBS = OPERATOR_VERBS.filter((row) => row.trigger);

/** Does this verb act on a phase — is `phase` among its positional words? */
const takesPhase = (name: string): boolean =>
  TRIGGER_VERBS.find((row) => row.name === name)?.cli?.args.includes('phase') ?? false;

/** Each event as the arming form offers it — before it has a phase. */
const EVENT_WORDS: Readonly<Record<TriggerEvent, string>> = {
  'phase-boarded': 'A phase boards',
  'phase-done': 'A phase is done',
  'phase-settled': 'A phase settles, whatever the outcome',
  'run-paused': 'The run pauses',
  'entry-queued': 'A phase waits in the queue',
  'lane-boundary': 'Any lane ends',
  at: 'A time passes',
};

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** `14:00, 10 Oct` — a moment as the fold says it, in the reader's own zone. */
function clockOf(iso: string | undefined): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return iso ?? '';
  const at = new Date(ms);
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}, ${DAY_MONTH.format(at)}`;
}

/**
 * What a trigger waits for, in words — "Phase 4 is done", "The run pauses",
 * "At 14:00, 10 Oct" — read through `parseWhen`, so the words and the grammar
 * cannot disagree. A `when` the grammar refuses is shown as written.
 */
export function whenWords(when: string): string {
  const parsed = parseWhen(when);
  if ('error' in parsed) return when;
  const n = parsed.phase;
  switch (parsed.event) {
    case 'phase-boarded':
      return `Phase ${n} boards`;
    case 'phase-done':
      return `Phase ${n} is done`;
    case 'phase-settled':
      return `Phase ${n} settles`;
    case 'entry-queued':
      return `Phase ${n} waits in the queue`;
    case 'run-paused':
      return 'The run pauses';
    case 'lane-boundary':
      return 'Any lane ends';
    case 'at':
      return `At ${clockOf(parsed.at)}`;
    default:
      return when;
  }
}

/** Armed first, oldest armed first; then the ended ones, newest end first. */
function ordered(triggers: readonly StoredTrigger[]): StoredTrigger[] {
  const armed = triggers
    .filter((t) => t.state === 'armed')
    .sort((a, b) => a.armedAt.localeCompare(b.armedAt));
  const ended = triggers
    .filter((t) => t.state !== 'armed')
    .sort((a, b) => (b.endedAt ?? b.armedAt).localeCompare(a.endedAt ?? a.armedAt));
  return [...armed, ...ended];
}

const phaseOfBody = (body: Record<string, unknown>): number | null =>
  typeof body.phase === 'number' ? body.phase : null;

const sentence = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const message = (error: unknown): string =>
  String((error as Error)?.message || 'The request failed and said nothing.');

/* ------------------------------------------------------------------------- *
 * The fold
 * ------------------------------------------------------------------------- */

export function RunTriggers({ slug, allowRun }: { slug: string; allowRun: boolean }) {
  const { data, error, isPending } = useTriggers(slug);
  const triggers = useMemo(() => ordered(data ?? []), [data]);
  const armed = triggers.filter((t) => t.state === 'armed').length;

  return (
    <div data-testid="run-triggers" className="flex min-w-0 flex-col gap-3">
      {isPending ? (
        <Spinner label="Loading the plan's triggers" />
      ) : error ? (
        <p className="text-body text-ink-muted">{message(error)}</p>
      ) : triggers.length === 0 ? (
        <p className="text-body text-ink-muted">No trigger is stored for this plan.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="Stored triggers">
          {triggers.map((trigger) => (
            <TriggerRow key={trigger.id} trigger={trigger} slug={slug} allowRun={allowRun} />
          ))}
        </ul>
      )}
      <ArmTrigger slug={slug} allowRun={allowRun} armed={armed} />
    </div>
  );
}

/** One stored trigger: its state, what it waits for, what it presses, and what came of it. */
function TriggerRow({
  trigger,
  slug,
  allowRun,
}: {
  trigger: StoredTrigger;
  slug: string;
  allowRun: boolean;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const armed = trigger.state === 'armed';
  const phase = phaseOfBody(trigger.body);
  const last = trigger.firings.at(-1);

  const cancel = async () => {
    setBusy(true);
    try {
      const pressed = await press(() => runsApi.cancelTrigger(slug, trigger.id));
      toast(
        pressed.state === 'asked' ? pressed.words : 'Trigger cancelled.',
        pressed.state === 'asked' ? 'info' : 'ok',
      );
    } catch (error) {
      toast(message(error), 'error');
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: triggersKey(slug) });
    }
  };

  return (
    <li
      data-testid="trigger-row"
      data-state={trigger.state}
      data-trigger={trigger.id}
      className="flex min-w-0 flex-col gap-0.5 py-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={armed ? 'text-meta text-ink' : 'text-meta text-ink-muted'}>
          {sentence(trigger.state)}
        </span>
        <span className="min-w-0 break-words text-body text-ink" data-testid="trigger-when">
          {whenWords(trigger.when)}
        </span>
        <span className="min-w-0 text-body text-ink-muted">
          presses <Mono value={trigger.verb} />
          {phase != null ? ` on phase ${phase}` : ''}
        </span>
        {armed && (
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
            disabled={!allowRun || busy}
            title={
              allowRun ? 'Cancel this trigger; the ledger keeps it, ended' : 'Cancelling needs --allow-run'
            }
            onClick={() => void cancel()}
          >
            {busy ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
      </div>
      <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink-muted">
        <span>{trigger.mode === 'every' ? 'Every time' : 'Once'}</span>
        {armed && trigger.expiresAt && (
          <span title={trigger.expiresAt}>expires {clockOf(trigger.expiresAt)}</span>
        )}
        {!armed && trigger.endedAt && (
          <span>
            ended <RelativeTime at={trigger.endedAt} live={false} />
            {trigger.endedBy ? ` by ${trigger.endedBy}` : ''}
          </span>
        )}
        <span>
          armed by {trigger.armedBy.by} <RelativeTime at={trigger.armedAt} live={false} />
        </span>
        <span data-testid="trigger-firings">
          {last ? (
            <>
              {trigger.firings.length === 1
                ? 'fired once, on '
                : `fired ${plural(trigger.firings.length, 'time')}, the last on `}
              <Mono value={last.cause} />
              {last.ok
                ? ', answered ok'
                : `, refused${last.status ? ` with ${last.status}` : ''}${last.error ? `: ${last.error}` : ''}`}
            </>
          ) : armed ? (
            'not fired yet'
          ) : (
            'never fired'
          )}
        </span>
      </p>
      {trigger.note && <p className="min-w-0 break-words text-meta text-ink">{trigger.note}</p>}
    </li>
  );
}

/* ------------------------------------------------------------------------- *
 * Arming
 * ------------------------------------------------------------------------- */

/** The arm fold — or why there is none: no `--allow-run`, or the plan's limit reached. */
function ArmTrigger({ slug, allowRun, armed }: { slug: string; allowRun: boolean; armed: number }) {
  const [open, setOpen] = useState(false);
  const reason = useId();
  if (!allowRun) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Button size="sm" variant="ghost" disabled aria-describedby={reason}>
          Arm a trigger
        </Button>
        <p id={reason} className="text-meta text-ink-muted" data-testid="trigger-arm-refused">
          Arming needs <Mono value="--allow-run" />.
        </p>
      </div>
    );
  }
  if (armed >= TRIGGERS_PER_PLAN) {
    return (
      <p className="text-meta text-ink-muted" data-testid="trigger-arm-full">
        This plan holds {TRIGGERS_PER_PLAN} armed triggers, the most it may. Cancel one to arm another.
      </p>
    );
  }
  return (
    <Disclosure
      label="Arm a trigger"
      openLabel="Arm a trigger"
      open={open}
      onOpenChange={setOpen}
      testId="trigger-arm"
      bodyClassName="pt-2"
    >
      <ArmForm slug={slug} onArmed={() => setOpen(false)} />
    </Disclosure>
  );
}

/** `phase-done:4`, `run-paused`, `at:<ISO>` — the form's answers as the grammar spells them. */
function composeWhen(event: string, phase: string, at: string): string {
  if (event === 'at') {
    // A datetime-local value names no zone: read it as the reader's own and send the instant.
    const ms = Date.parse(at);
    return `at:${Number.isFinite(ms) ? new Date(ms).toISOString() : at}`;
  }
  return (PHASE_TRIGGER_EVENTS as readonly string[]).includes(event) ? `${event}:${phase.trim()}` : event;
}

/** The grammar, one machine word each — `whenGrammar()` joins them for a terminal. */
const GRAMMAR = whenGrammar()
  .split('·')
  .map((word) => word.trim())
  .filter(Boolean);

function ArmForm({ slug, onArmed }: { slug: string; onArmed: () => void }) {
  const client = useQueryClient();
  const id = useId();
  const [event, setEvent] = useState<string>(TRIGGER_EVENTS[0]);
  const [phase, setPhase] = useState('');
  const [at, setAt] = useState('');
  const [verb, setVerb] = useState<string>(TRIGGER_VERBS[0]?.name ?? '');
  const [verbPhase, setVerbPhase] = useState('');
  const [every, setEvery] = useState(false);
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<{ text: string; grammar: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const phaseEvent = (PHASE_TRIGGER_EVENTS as readonly string[]).includes(event);
  const verbRow = TRIGGER_VERBS.find((row) => row.name === verb);
  const verbTakesPhase = takesPhase(verb);

  const submit = async () => {
    const when = composeWhen(event, phase, at);
    const parsed = parseWhen(when);
    if ('error' in parsed) {
      setRefusal({ text: parsed.error, grammar: true });
      return;
    }
    let body: Record<string, unknown> | undefined;
    if (verbTakesPhase) {
      const n = Number(verbPhase.trim());
      if (!/^\d+$/.test(verbPhase.trim()) || n < 1) {
        setRefusal({ text: `${verb} acts on a phase: name it.`, grammar: false });
        return;
      }
      body = { phase: n };
    }
    let expiresAt: string | undefined;
    if (expires) {
      const ms = Date.parse(expires);
      if (!Number.isFinite(ms)) {
        setRefusal({ text: 'The expiry is not a time.', grammar: false });
        return;
      }
      expiresAt = new Date(ms).toISOString();
    }
    setRefusal(null);
    setBusy(true);
    try {
      const pressed = await press(() =>
        runsApi.armTrigger(slug, {
          when,
          verb,
          ...(body ? { body } : {}),
          every,
          ...(expiresAt ? { expiresAt } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      toast(
        pressed.state === 'asked' ? pressed.words : `Armed: ${whenWords(when)}, then ${verb}.`,
        pressed.state === 'asked' ? 'info' : 'ok',
      );
      setBusy(false);
      onArmed();
    } catch (error) {
      setBusy(false);
      toast(message(error), 'error');
    } finally {
      void client.invalidateQueries({ queryKey: triggersKey(slug) });
    }
  };

  return (
    <form
      data-testid="trigger-arm-form"
      className="flex min-w-0 max-w-(--measure) flex-col gap-3"
      // The grammar judges the answers, in its own words — not the browser's bubble.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-event`}>When</Label>
        <NativeSelect id={`${id}-event`} value={event} onChange={(e) => setEvent(e.target.value)}>
          {TRIGGER_EVENTS.map((word) => (
            <option key={word} value={word}>
              {EVENT_WORDS[word]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {phaseEvent && (
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-phase`}>Phase</Label>
          <Input
            id={`${id}-phase`}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="w-28"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
          />
        </div>
      )}
      {event === 'at' && (
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-at`}>Time</Label>
          <Input id={`${id}-at`} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-verb`}>Then press</Label>
        <NativeSelect id={`${id}-verb`} value={verb} onChange={(e) => setVerb(e.target.value)}>
          {TRIGGER_VERBS.map((row) => (
            <option key={row.name} value={row.name}>
              {row.name}
            </option>
          ))}
        </NativeSelect>
        {verbRow?.summary && <p className="text-meta text-ink-muted">{sentence(verbRow.summary)}.</p>}
      </div>
      {verbTakesPhase && (
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-verb-phase`}>On phase</Label>
          <Input
            id={`${id}-verb-phase`}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="w-28"
            value={verbPhase}
            onChange={(e) => setVerbPhase(e.target.value)}
          />
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Checkbox id={`${id}-every`} checked={every} onCheckedChange={(next) => setEvery(next === true)} />
        <Label htmlFor={`${id}-every`}>Every time</Label>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label
          htmlFor={`${id}-expires`}
          hint="Empty means a week from now, the longest a trigger may stay armed."
        >
          Expires
        </Label>
        <Input
          id={`${id}-expires`}
          type="datetime-local"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-note`}>Note</Label>
        <Textarea
          id={`${id}-note`}
          block
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {refusal && (
        <div role="alert" className="flex min-w-0 flex-col gap-1 text-meta" data-testid="trigger-arm-refusal">
          <p className="state-failed text-state">{refusal.text}</p>
          {refusal.grammar && (
            <p className="text-ink-muted">
              A trigger waits for one of{' '}
              {GRAMMAR.map((word, i) => (
                <span key={word}>
                  {i > 0 ? ', ' : ''}
                  <Mono value={word} />
                </span>
              ))}
              .
            </p>
          )}
        </div>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Arming…' : 'Arm trigger'}
        </Button>
      </div>
    </form>
  );
}
