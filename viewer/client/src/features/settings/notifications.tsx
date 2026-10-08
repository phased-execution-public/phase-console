/**
 * Reminders for a person's turn (control-tower phase 42; ONE quiet-hours
 * setting since phase 138, #215).
 *
 * A human step that waits on somebody is said again — +15 m, +1 h, +6 h, then
 * daily — until it is proven, handed back or its window closes (phase 43's
 * clock, `REMINDER_SERIES_MS`). The series is the console's own and not a
 * setting.
 *
 * Neither are the quiet hours, any more. This card used to hold a window of
 * its own (`reminderQuiet`), beside every device's on the Devices card — two
 * answers to "may it buzz now?" that could disagree. There is one setting now,
 * each device's, edited on the Devices card below: a reminder that falls due
 * while every device that hears a person's turn is inside its window waits for
 * the first one to wake (deferred, never dropped), and a reminder is never
 * urgent, so it never breaks through one. This card says which devices those
 * are and what each one's window is — read off the push register, never a
 * copy of it. The old window was moved onto the devices once, by the server.
 */

import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import type { PushDevice, PushQuietHours } from '@/lib/api';
import { usePush } from '@/lib/queries';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';

/** The category a person's turn — and every reminder of it — is pushed under. */
const TURN_CATEGORY = 'needs-you';

/** One gap of the series, in words. */
export function gapWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  return hours === 24 ? 'a day' : `${hours / 24} days`;
}

/** A device that hears a person's turn, and the quiet window it keeps — null when it keeps none. */
export type ReminderDevice = { id: string; label: string; quiet: PushQuietHours | null };

/** The devices a reminder is pushed to: every one that takes the turn's category. */
export function reminderDevices(devices: readonly PushDevice[] | undefined): ReminderDevice[] {
  return (devices ?? [])
    .filter((device) => device.categories?.[TURN_CATEGORY] !== false)
    .map((device) => ({ id: device.id, label: device.label, quiet: device.quiet ?? null }));
}

/** What the devices' windows mean for the next reminder, in one sentence. */
export function quietSentence(devices: readonly ReminderDevice[]): string {
  if (!devices.length) {
    return 'No device hears a person’s turn, so a reminder goes to the inbox when it is due — there is nothing to be quiet on.';
  }
  const awake = devices.filter((device) => !device.quiet);
  if (awake.length) {
    const names = awake.map((device) => device.label).join(', ');
    return `${names} ${awake.length === 1 ? 'keeps' : 'keep'} no quiet hours, so a reminder goes out when it is due.`;
  }
  return 'A reminder that falls due while every one of them is quiet waits for the first to wake — deferred, never dropped.';
}

export function RemindersCard() {
  const { data: push } = usePush();
  const devices = reminderDevices(push?.devices);
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

        <section className="flex flex-col gap-2" data-testid="reminder-quiet" aria-label="Quiet hours">
          <h3 className="text-sm font-medium text-ink">Quiet hours</h3>
          <p className="max-w-prose text-ink-muted">
            Reminders keep each device&rsquo;s own quiet hours &mdash; the one quiet-hours setting there is,
            set per device under <strong className="text-ink">Devices</strong> below. A reminder is never
            urgent, so it never breaks through a quiet window.
          </p>
          {devices.length > 0 && (
            <ul data-testid="reminder-devices" className="flex flex-col gap-0.5 text-ink">
              {devices.map((device) => (
                <li key={device.id} data-testid="reminder-device">
                  <span className="font-medium">{device.label}</span>
                  {' — '}
                  {device.quiet ? `quiet ${device.quiet.start} to ${device.quiet.end}` : 'no quiet hours'}
                </li>
              ))}
            </ul>
          )}
          <p className="max-w-prose text-ink-muted" data-testid="reminder-quiet-rule">
            {quietSentence(devices)}
          </p>
        </section>
      </CardBody>
    </Card>
  );
}
