/**
 * Reminders for a person's turn (7.0, quiet-console phase 22; control-tower
 * phase 42, and ONE quiet-hours setting since phase 138, #215).
 *
 * ```
 * Reminders for your turns
 * 1. after 15 minutes
 * 2. after an hour            …then every day
 * iPhone   quiet 22:00 to 07:00
 * Mac      no quiet hours
 * Mac keeps no quiet hours, so a reminder goes out when it is due.
 * ```
 *
 * A step that waits on a person is said again — the series is the console's
 * own clock (`REMINDER_SERIES_MS`), not a setting — until it is proven, handed
 * back or its window closes. Neither are its quiet hours a setting of their
 * own: there is one, each device's, edited under Devices, and a reminder that
 * falls due while every device that hears a person's turn is quiet waits for
 * the first to wake — deferred, never dropped. This group names those devices
 * and each one's window, read off the push register, never a copy of it.
 */

import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import type { PushDevice, PushQuietHours } from '@/data/api';
import { usePush } from '@/data/inbox';
import { Skeleton } from '@/ui';
import { SettingsGroup } from './setting';

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

export function RemindersGroup() {
  const { data: push, isPending } = usePush();
  const devices = reminderDevices(push?.devices);
  const last = REMINDER_SERIES_MS[REMINDER_SERIES_MS.length - 1]!;

  return (
    <SettingsGroup
      id="reminders"
      title="Reminders for your turns"
      lead="When a step waits on you, the console says so again after each gap below, until it is done, handed back or its window closes. A snooze holds the next one back."
    >
      <ol data-testid="reminder-series" className="flex list-decimal flex-col gap-1 ps-5 text-body text-ink">
        {REMINDER_SERIES_MS.map((gap, index) => (
          <li key={`${index}-${gap}`}>
            after {gapWords(gap)}
            {index === REMINDER_SERIES_MS.length - 1
              ? `, then every ${gapWords(last).replace(/^an? /, '')}`
              : ''}
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-col gap-2" data-testid="reminder-quiet">
        <p className="max-w-(--measure) text-meta text-ink-muted">
          Reminders keep each device’s own quiet hours — the one quiet-hours setting there is, set per device
          under Devices below. A reminder is never urgent, so it never breaks through a quiet window.
        </p>
        {isPending && !push ? (
          <Skeleton className="h-10" aria-busy="true" aria-label="Reading the devices" />
        ) : (
          <>
            {devices.length > 0 && (
              <ul data-testid="reminder-devices" className="flex min-w-0 flex-col gap-1">
                {devices.map((device) => (
                  <li
                    key={device.id}
                    data-testid="reminder-device"
                    className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-body"
                  >
                    <span className="min-w-0 break-words text-ink">{device.label}</span>
                    <span className="text-meta text-ink-muted">
                      {device.quiet ? `quiet ${device.quiet.start} to ${device.quiet.end}` : 'no quiet hours'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="reminder-quiet-rule">
              {quietSentence(devices)}
            </p>
          </>
        )}
      </div>
    </SettingsGroup>
  );
}
