/**
 * Quiet hours — the ONE window a device is not woken in (control-tower phase
 * 138, #215).
 *
 * A device's quiet hours were always its own (parallel-repaint P2); the
 * reminders of a person's turn had a second window beside them
 * (`reminderQuiet`, phase 43) that could disagree with every device. Since
 * phase 138 there is one setting, the device's: a reminder waits while every
 * device that would hear it is inside its window, and never breaks through one
 * (`Push.announce` holds a not-urgent push back from a quiet device). The old
 * preference is migrated onto the devices (`config.ts` `migrateReminderQuiet`).
 *
 * Import-free on purpose: `config.ts` parses a migrating window with the
 * register's own parser, and `push/index.ts` imports `config.ts` — so the
 * parser lives where neither import can make a cycle.
 */

/**
 * A daily do-not-disturb window for one device. `start`/`end` are 'HH:MM' on a
 * 24-hour clock; a window may cross midnight (23:00–08:00 is the normal case).
 * `allowUrgent` keeps the "nothing proceeds without you" categories — and the
 * one escalated stall — breaking through. It defaults ON, because an approval
 * suppressed at 3am still stops the fleet dead until morning. A reminder is
 * never urgent: it is a repeat, not news.
 */
export type QuietHours = { start: string; end: string; allowUrgent: boolean };

const QUIET_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A client may send anything. `null` clears the window; a malformed shape is
 * refused rather than coerced, because quiet hours the operator did not ask
 * for is the one misconfiguration this feature must never produce.
 */
export function parseQuietHours(value: unknown): QuietHours | null | { error: string } {
  if (value == null) return null;
  if (typeof value !== 'object') return { error: 'quiet hours must be an object or null' };
  const raw = value as { start?: unknown; end?: unknown; allowUrgent?: unknown };
  const start = String(raw.start ?? '');
  const end = String(raw.end ?? '');
  if (!QUIET_TIME_RE.test(start) || !QUIET_TIME_RE.test(end)) {
    return { error: 'quiet hours need start and end as HH:MM' };
  }
  if (start === end) return { error: 'quiet hours cannot start and end at the same minute' };
  return { start, end, allowUrgent: raw.allowUrgent !== false };
}

/**
 * Is `at` inside the window, on this process's local clock? Half-open
 * [start, end) so a window ending 08:00 hands over cleanly to one starting
 * 08:00 — and a window that crosses midnight is the union of [start, 24:00)
 * and [00:00, end).
 */
export function inQuietHours(quiet: QuietHours | undefined, at: number): boolean {
  if (!quiet) return false;
  const startM = quietMinutes(quiet.start);
  const endM = quietMinutes(quiet.end);
  if (startM == null || endM == null || startM === endM) return false;
  const t = new Date(at);
  const nowM = t.getHours() * 60 + t.getMinutes();
  return startM < endM ? nowM >= startM && nowM < endM : nowM >= startM || nowM < endM;
}

/** `HH:MM` → minutes past midnight, or null when it is not a time. */
export function quietMinutes(text: string): number | null {
  const m = QUIET_TIME_RE.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
