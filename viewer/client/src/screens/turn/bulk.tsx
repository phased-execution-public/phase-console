/**
 * Acting on more than one item (one-pool phase 14, #377): pick rows in the
 * list, then *Not doing these*, *Hand them back* or *Snooze* — each the card's
 * own verb, pressed once per item through the owner door (`data/press.ts`).
 *
 * Only a ledger item can take them: a projected item (a gate, an approval
 * card, a relayed question) is answered on its own card, and the bar says how
 * many of the picked it will skip and why. *Not doing* also needs the raiser
 * to allow it (`allowDecline`). *Not doing* ends an item, so it waits out the
 * undo window on the page like the card's own press (design.md §Your turn);
 * Snooze and Hand back are sent at once, as on the card. Nothing leaves the
 * list on the press: an item goes when the server's `turn` event says so
 * (#270), held meanwhile in its section saying what was pressed.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HUMAN_STEP_SETTLED_STATES } from '@shared/human-step-model.js';
import { errorWords } from '@/cards/turn/step-words';
import { humanStepsApi, type StepVerbAnswer } from '@/data/human-steps';
import { keys } from '@/data/keys';
import { press, type Pressed } from '@/data/press';
import type { TurnItem } from '@/data/turn';
import { useHeldPress } from '@/data/undo-window';
import type { Selection } from '@/shell/bell/selection';
import { Button, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/** Can a person press a ledger verb on this item from the list? */
export function bulkable(item: TurnItem): boolean {
  const state = item.step?.state ?? item.humanStep?.state ?? 'notified';
  return item.record === 'ledger' && !SETTLED.has(state);
}

/** May the person say *Not doing this*? The raiser has to allow it. */
export function declinable(item: TurnItem): boolean {
  return bulkable(item) && item.step?.allowDecline === true;
}

/** The snooze lengths on offer, in minutes — the card's own three. */
const SNOOZES: readonly { minutes: number; label: string }[] = [
  { minutes: 60, label: 'An hour' },
  { minutes: 240, label: 'Four hours' },
  { minutes: 24 * 60, label: 'Until tomorrow' },
];

type Form = 'decline' | 'back' | 'snooze' | null;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function TurnBulkBar({
  items,
  pick,
  shown,
  onSettled,
}: {
  /** The picked items, in the list's order. */
  items: readonly TurnItem[];
  pick: Selection;
  /** How many rows the list shows — the select-all box's other half. */
  shown: number;
  /** Hold a pressed item on the page until the server's `turn` event (#270). */
  onSettled: (item: TurnItem, words: string) => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState<Form>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { held, hold, undo } = useHeldPress();

  const open = items.filter(bulkable);
  const decline = items.filter(declinable);

  async function each(
    targets: readonly TurnItem[],
    call: (id: string) => Promise<StepVerbAnswer>,
    words: string,
    done: string,
  ) {
    setBusy(true);
    let sent = 0;
    let asked = 0;
    const failed: string[] = [];
    for (const item of targets) {
      try {
        const pressed: Pressed<StepVerbAnswer> = await press(() => call(item.item));
        if (pressed.state === 'asked') asked += 1;
        else sent += 1;
        onSettled(item, words);
      } catch (cause) {
        failed.push(`${item.title}: ${errorWords(cause)}`);
      }
    }
    setBusy(false);
    pick.clear();
    setForm(null);
    setReason('');
    void client.invalidateQueries({ queryKey: keys.inbox() });
    void client.invalidateQueries({ queryKey: keys.humanSteps() });
    const parts = [
      sent ? `${done}: ${plural(sent, 'item', 'items')}.` : '',
      asked ? `${plural(asked, 'press', 'presses')} asked of the owner.` : '',
      failed.length ? `Not sent: ${failed.join('; ')}.` : '',
    ].filter(Boolean);
    toast(parts.join(' '), failed.length ? 'warn' : 'ok', failed.length ? 10_000 : 5000);
  }

  const skipped = (n: number, why: string) =>
    n > 0 ? (
      <p className="text-meta text-ink-muted" data-testid="turn-bulk-skipped">
        {plural(n, 'picked item', 'picked items')} {why}
      </p>
    ) : null;

  const words = reason.trim();
  return (
    <div
      role="region"
      aria-label="Act on the picked items"
      data-testid="turn-bulk"
      className="sticky top-0 z-10 flex min-w-0 flex-col gap-2 rounded border border-rule bg-surface-raised p-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Checkbox
          checked={pick.state === 'all' ? true : 'indeterminate'}
          onCheckedChange={pick.toggleAll}
          aria-label={pick.state === 'all' ? 'Clear the picks' : `Pick all ${shown}`}
        />
        <span className="text-meta tabular-nums text-ink-muted">{pick.count} picked</span>
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            data-testid="turn-bulk-decline"
            disabled={busy || !decline.length || held != null}
            aria-expanded={form === 'decline'}
            onClick={() => setForm(form === 'decline' ? null : 'decline')}
          >
            Not doing
          </Button>
          <Button
            size="sm"
            data-testid="turn-bulk-back"
            disabled={busy || !open.length}
            aria-expanded={form === 'back'}
            onClick={() => setForm(form === 'back' ? null : 'back')}
          >
            Hand back
          </Button>
          <Button
            size="sm"
            data-testid="turn-bulk-snooze"
            disabled={busy || !open.length}
            aria-expanded={form === 'snooze'}
            onClick={() => setForm(form === 'snooze' ? null : 'snooze')}
          >
            Snooze
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={pick.clear}>
            Clear
          </Button>
        </span>
      </div>

      {held && (
        <p className="flex flex-wrap items-center gap-2 text-meta text-ink" data-testid="turn-bulk-held">
          {held.label}
          <Button size="sm" variant="ghost" onClick={() => undo()}>
            Undo
          </Button>
        </p>
      )}

      {form === 'decline' && (
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!words) return;
            const targets = decline;
            setForm(null);
            hold(`Not doing ${plural(targets.length, 'item', 'items')}.`, () =>
              each(
                targets,
                (id) => humanStepsApi.humanStepDecline(id, words),
                'Not doing it — its session is told why.',
                'Not doing',
              ),
            );
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            Why not — every picked item's session reads it
            <Input
              data-testid="turn-bulk-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="A reason the sessions can act on"
            />
          </label>
          {skipped(
            items.length - decline.length,
            'cannot be declined from here: its raiser does not allow it, or it is answered on its own card.',
          )}
          <span>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={!words}
              data-testid="turn-bulk-decline-send"
            >
              Not doing {plural(decline.length, 'item', 'items')}
            </Button>
          </span>
        </form>
      )}

      {form === 'back' && (
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!words) return;
            void each(
              open,
              (id) => humanStepsApi.humanStepCannot(id, words),
              'Handed back — its session takes it from here.',
              'Handed back',
            );
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            What stops you — every picked item's session reads it
            <Input
              data-testid="turn-bulk-back-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="I can't do these because…"
            />
          </label>
          {skipped(items.length - open.length, 'is answered on its own card, so it is not handed back.')}
          <span>
            <Button size="sm" variant="primary" type="submit" disabled={!words}>
              Hand back {plural(open.length, 'item', 'items')}
            </Button>
          </span>
        </form>
      )}

      {form === 'snooze' && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex flex-wrap gap-1.5" role="group" aria-label="Snooze the picked items">
            {SNOOZES.map((one) => (
              <Button
                key={one.minutes}
                size="sm"
                data-testid={`turn-bulk-snooze-${one.minutes}`}
                disabled={busy}
                onClick={() =>
                  void each(
                    open,
                    (id) => humanStepsApi.humanStepSnooze(id, one.minutes),
                    'Snoozed — it comes back when the time is up.',
                    'Snoozed',
                  )
                }
              >
                {one.label}
              </Button>
            ))}
          </span>
          {skipped(items.length - open.length, 'is answered on its own card, so it is not snoozed.')}
        </div>
      )}
    </div>
  );
}
