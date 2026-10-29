/**
 * A person's step in words and clocks — who raised it, what each move was
 * called, whether it still waits, and its moments as a person reads them.
 *
 * Pure: no React, no glyph, no press. The one card (`cards/item-card.tsx`)
 * reads these, as do its parts and the Your turn screens (measured-console
 * phase 32 folded the old human-step card into the item card; these are the
 * words it carried that were never the card itself).
 */

import { HUMAN_STEP_OPEN_STATES } from '@shared/human-step-model.js';
import type { HumanStepRecord } from '@/data/human-steps';

/** Who raised a step, by its birth. */
export const BIRTH_WORDS: Readonly<Record<string, string>> = {
  plan: 'the plan',
  session: 'the phase’s session',
  console: 'the console, on a person’s word',
};

/** Each move of a step, as a past-tense word. */
export const MOVE_WORDS: Readonly<Record<string, string>> = {
  due: 'came due',
  notify: 'announced',
  remind: 'reminded',
  open: 'opened',
  check: 'checked',
  prove: 'proven',
  snooze: 'snoozed',
  cannot: 'handed back',
  dismiss: 'withdrawn',
  expire: 'expired',
};

/** Is a step still waiting on a person — every state short of settled. */
export function isOpenState(state: string): boolean {
  return (HUMAN_STEP_OPEN_STATES as readonly string[]).includes(state);
}

/** What went wrong, in the server's own words. */
export function errorWords(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* ------------------------------------------------------------------ *
 * Clocks, in words
 * ------------------------------------------------------------------ */

/** A span of time in the console's words: `5 m`, `3 h 20 m`, `2 d 4 h`. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} m` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** A moment's time of day: `10:30`. */
export function hourMinute(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** A moment, as a person reads it: `Oct 7, 10:30`. */
export function stamp(iso: string | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** The status line's parts — separate words, never a dotted string. */
export function statusParts(
  record: Pick<
    HumanStepRecord,
    'opened' | 'checkedAt' | 'nextReminderAt' | 'windowEnd' | 'until' | 'snoozeUntil'
  >,
  opened: number,
  now: number,
): { key: string; text: string }[] {
  const parts: { key: string; text: string }[] = [];
  parts.push({ key: 'opened', text: opened ? `opened ${opened}×` : 'not opened yet' });
  const checked = record.checkedAt ? Date.parse(record.checkedAt) : NaN;
  if (Number.isFinite(checked))
    parts.push({ key: 'checked', text: `last checked ${span(now - checked)} ago` });
  const snoozed = record.snoozeUntil ? Date.parse(record.snoozeUntil) : NaN;
  if (Number.isFinite(snoozed) && snoozed > now)
    parts.push({ key: 'snoozed', text: `snoozed until ${hourMinute(record.snoozeUntil!)}` });
  else if (record.nextReminderAt)
    parts.push({ key: 'reminder', text: `next reminder ${hourMinute(record.nextReminderAt)}` });
  const end = Date.parse(record.windowEnd ?? record.until ?? '');
  if (Number.isFinite(end))
    parts.push({
      key: 'expires',
      text: end > now ? `expires in ${span(end - now)}` : 'the window has closed',
    });
  return parts;
}
