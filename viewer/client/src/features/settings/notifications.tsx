/**
 * Reminders for a person's turn (control-tower phase 42).
 *
 * A human step that waits on somebody is said again — +15 m, +1 h, +6 h, then
 * daily — until it is proven, handed back or its window closes (phase 43's
 * clock, `REMINDER_SERIES_MS`). The series is the console's own and not a
 * setting; what a person sets is when it may NOT speak: the quiet hours, the
 * server preference `reminderQuiet {start, end}` (`POST /api/prefs`). A
 * reminder due inside them waits for them to end — it is deferred, never
 * dropped — which is why they are a different thing from a device's own quiet
 * hours on the Devices card, which drop what arrives.
 *
 * The server drops a malformed window silently (it answers 200), so this
 * form refuses one before it is sent: two `HH:MM` times, and not the same one.
 */

import { useEffect, useState } from 'react';
import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import { api, type ReminderQuiet } from '@/lib/api';
import { keys, useApiMutation, useConsoleState } from '@/lib/queries';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Label } from '@/components/ui';

/** The window a person is offered first — the night. */
export const DEFAULT_REMINDER_QUIET: ReminderQuiet = { start: '22:00', end: '08:00' };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Is this a window the server keeps — two `HH:MM` times that differ? */
export function validQuiet(quiet: ReminderQuiet): boolean {
  return HHMM.test(quiet.start) && HHMM.test(quiet.end) && quiet.start !== quiet.end;
}

/** One gap of the series, in words. */
export function gapWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  return hours === 24 ? 'a day' : `${hours / 24} days`;
}

export function RemindersCard() {
  const { data: state } = useConsoleState();
  const held = ((state?.prefs ?? {}) as { reminderQuiet?: ReminderQuiet | null }).reminderQuiet ?? null;
  const [quiet, setQuiet] = useState<ReminderQuiet>(held ?? DEFAULT_REMINDER_QUIET);
  useEffect(() => {
    if (held) setQuiet(held);
  }, [held?.start, held?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useApiMutation<ReminderQuiet | null, unknown>({
    fn: (value) => api.savePrefs({ reminderQuiet: value }),
    invalidates: keys.afterPrefs(),
    say: (_result, value) =>
      value ? `Quiet ${value.start} to ${value.end} — reminders wait for it to end.` : 'Quiet hours off.',
  });
  const valid = validQuiet(quiet);
  const last = REMINDER_SERIES_MS[REMINDER_SERIES_MS.length - 1]!;

  return (
    <Card data-testid="reminders-card">
      <CardHeader>
        <CardTitle>Reminders for your turns</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-xs">
        <p className="max-w-prose text-ink-muted">
          When a step waits on you, the console says so again, each time after the gap below, until it is
          done, handed back, or its window closes. A snooze holds the next one back.
        </p>
        <ol data-testid="reminder-series" className="flex list-decimal flex-col gap-0.5 pl-5 text-ink">
          {REMINDER_SERIES_MS.map((gap, index) => (
            <li key={`${index}-${gap}`}>
              after {gapWords(gap)}
              {index === REMINDER_SERIES_MS.length - 1
                ? `, then every ${gapWords(last).replace(/^an? /, '')}`
                : ''}
            </li>
          ))}
        </ol>

        <fieldset className="flex flex-col gap-2" data-testid="reminder-quiet">
          <legend className="text-sm font-medium text-ink">Quiet hours</legend>
          <p className="max-w-prose text-ink-muted">
            {held
              ? `Reminders wait from ${held.start} to ${held.end}, and go out when it ends. None is dropped.`
              : 'Off — a reminder goes out whenever it is due.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Label className="flex flex-col gap-1 text-2xs text-ink-muted">
              From
              <Input
                type="time"
                data-testid="quiet-start"
                value={quiet.start}
                onChange={(event) => setQuiet({ ...quiet, start: event.target.value })}
                className="w-32"
              />
            </Label>
            <Label className="flex flex-col gap-1 text-2xs text-ink-muted">
              Until
              <Input
                type="time"
                data-testid="quiet-end"
                value={quiet.end}
                onChange={(event) => setQuiet({ ...quiet, end: event.target.value })}
                className="w-32"
              />
            </Label>
            <Button
              size="sm"
              variant="action"
              data-testid="quiet-save"
              disabled={!valid || save.isPending}
              onClick={() => save.mutate(quiet)}
            >
              {held ? 'Save quiet hours' : 'Turn quiet hours on'}
            </Button>
            {held && (
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
                Turn them off
              </Button>
            )}
          </div>
          {!valid && (
            <p className="text-2xs text-failed" data-testid="quiet-invalid">
              Two different times, each as hours and minutes — a window that starts where it ends is no
              window.
            </p>
          )}
        </fieldset>
      </CardBody>
    </Card>
  );
}
