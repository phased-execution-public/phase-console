/**
 * The timing grid (turn-by-turn phase 8) — an item's clocks, on one page clock.
 *
 *   Assigned     when it became the person's, and how long ago
 *   Do it        Now · a time with its countdown · or the condition, in words
 *   Deadline     when it must be done, what is left (or how overdue), and a bar
 *                from assigned to deadline — or "None set"
 *   Open until   when the act stops being open — never called a deadline
 *   You sent it  when the person pressed the check
 *   Checked      when the verdict landed
 *
 * The first three are always drawn — a missing deadline is a fact, said; the
 * rest when the item has them. The cells read `usePageNow()` (`ui/clock.ts`)
 * and the grid asks for the fine tick while it is on screen, so a countdown
 * moves every second without re-rendering the card or the page around it.
 */

import { useRef, type ReactNode } from 'react';
import type { HumanStepRecord } from '@/data/human-steps';
import type { TurnItem } from '@/data/turn';
import { cn } from '@/lib/cn';
import { reducedMotion } from '@/lib/media';
import { PAGE_CLOCK, useFineClock, usePageNow } from '@/ui/clock';
import { LoadMeter } from '@/ui/track/meter';
import { span, stamp } from './step-words';

export type Timing = NonNullable<TurnItem['timing']>;

const parse = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN);

/**
 * The item's clocks — the composer's (`item.timing`, turn-by-turn phase 3), else
 * read from what a 7.0 answer and the ledger record still carry, so an item
 * from an older console draws the same grid.
 */
export function timingOf(item: TurnItem, record?: HumanStepRecord): Timing {
  if (item.timing) return item.timing;
  const open = record?.windowEnd ?? record?.until ?? item.openUntil ?? item.step?.until ?? item.expiresAt;
  const verdictAt = record?.verdict?.at ?? item.verdict?.at;
  return {
    assignedAt: record?.dueAt ?? record?.declaredAt ?? item.step?.declaredAt ?? item.since,
    ...(open ? { openUntil: open } : {}),
    ...(record?.checkedAt ? { submittedAt: record.checkedAt } : {}),
    ...(verdictAt ? { checkedAt: verdictAt } : {}),
  };
}

/**
 * A span to or from now, said as the clock allows: seconds while the fine
 * tick runs and less than an hour is left, minutes otherwise.
 */
export function clockSpan(ms: number, fine: boolean): string {
  const abs = Math.abs(ms);
  if (fine && abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    const seconds = Math.floor((abs % 60_000) / 1000);
    return minutes ? `${minutes} m ${seconds} s` : `${seconds} s`;
  }
  return span(abs);
}

/** "now" a clock reads, as a fact of the clock: a figure says seconds only while seconds tick. */
function useClock(): { now: number; fine: boolean } {
  const now = usePageNow();
  return { now, fine: !reducedMotion() };
}

function Cell({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-meta text-ink-muted">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-body break-words text-ink">{children}</dd>
    </div>
  );
}

/** A moment and how long ago it was — ticking on the page clock. */
function Ago({ at }: { at: string }) {
  const { now } = useClock();
  const ms = parse(at);
  if (!Number.isFinite(ms)) return <span>{at}</span>;
  return (
    <>
      <span className="tabular-nums">{stamp(at)}</span>
      <span className="text-meta text-ink-muted tabular-nums" data-clock>
        {now - ms < 60_000 ? 'just now' : `${span(now - ms)} ago`}
      </span>
    </>
  );
}

/** *Do it*: Now, a start ahead with its clockSpan, or the condition it waits on. */
function DoIt({ timing, notYet }: { timing: Timing; notYet: boolean }) {
  const { now, fine } = useClock();
  const start = parse(timing.startAt);
  if (!notYet) return <span className="font-medium">Now</span>;
  if (Number.isFinite(start)) {
    return (
      <>
        <span className="tabular-nums">{stamp(timing.startAt)}</span>
        <span className="text-meta text-ink-muted tabular-nums" data-clock>
          {start > now ? `in ${clockSpan(start - now, fine)}` : 'due now'}
        </span>
      </>
    );
  }
  return <span>{timing.startWhen ? sentence(timing.startWhen) : 'When it is due'}</span>;
}

/** "when Phase 13 lands" → "When Phase 13 lands" — a condition, said as a sentence's start. */
function sentence(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** *Deadline*: the moment, what is left or how overdue, and the bar from assigned to it. */
function Deadline({ timing, live }: { timing: Timing; live: boolean }) {
  const { now, fine } = useClock();
  const end = parse(timing.deadline);
  if (!Number.isFinite(end)) return <span className="text-ink-muted">None set</span>;
  const from = parse(timing.assignedAt);
  const whole = Number.isFinite(from) && end > from ? end - from : null;
  const overdue = now > end;
  const left = end - now;
  const reading = !live
    ? 'set'
    : overdue
      ? `overdue by ${clockSpan(now - end, fine)}`
      : `${clockSpan(left, fine)} left`;
  return (
    <>
      <span className="tabular-nums">{stamp(timing.deadline)}</span>
      <span
        data-clock
        data-overdue={live && overdue ? 'true' : undefined}
        className={cn(
          'text-meta tabular-nums',
          live && overdue ? 'state-failed text-state' : 'text-ink-muted',
        )}
      >
        {reading}
      </span>
      {live && whole && (
        <LoadMeter
          value={Math.min(whole, Math.max(0, now - from))}
          max={whole}
          label="Time used before the deadline"
          valueText={overdue ? 'past the deadline' : `${span(left)} left`}
          paint={overdue ? 'failed' : left < whole / 5 ? 'needs-you' : 'running'}
        />
      )}
    </>
  );
}

/** *Open until*: when the act stops being open — a window, never a deadline. */
function OpenUntil({ at, live }: { at: string; live: boolean }) {
  const { now, fine } = useClock();
  const end = parse(at);
  return (
    <>
      <span className="tabular-nums">{stamp(at)}</span>
      {live && Number.isFinite(end) && (
        <span className="text-meta text-ink-muted tabular-nums" data-clock>
          {end > now ? `closes in ${clockSpan(end - now, fine)}` : `closed ${span(now - end)} ago`}
        </span>
      )}
    </>
  );
}

export function TimingGrid({
  timing,
  notYet,
  live,
}: {
  timing: Timing;
  /** The act is not due yet — *Do it* says when. */
  notYet: boolean;
  /** The item is still the person's: the countdowns run and the bar is drawn. */
  live: boolean;
}) {
  const box = useRef<HTMLDListElement>(null);
  // A second-by-second countdown only while the grid is on screen and something counts down.
  const counting = live && Boolean(timing.deadline || timing.startAt || timing.openUntil);
  useFineClock(box, counting);
  return (
    <dl
      ref={box}
      data-testid="turn-timing"
      data-tick={counting ? String(PAGE_CLOCK.fineMs) : String(PAGE_CLOCK.coarseMs)}
      className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 rounded-md bg-ground px-3 py-2.5 @md/card:grid-cols-3"
    >
      <Cell label="Assigned" testId="turn-assigned">
        <Ago at={timing.assignedAt} />
      </Cell>
      <Cell label="Do it" testId="turn-do-it">
        <DoIt timing={timing} notYet={notYet} />
      </Cell>
      <Cell label="Deadline" testId="turn-deadline">
        <Deadline timing={timing} live={live} />
      </Cell>
      {timing.openUntil && (
        <Cell label="Open until" testId="turn-open-until">
          <OpenUntil at={timing.openUntil} live={live} />
        </Cell>
      )}
      {timing.submittedAt && (
        <Cell label="You sent it" testId="turn-sent">
          <Ago at={timing.submittedAt} />
        </Cell>
      )}
      {timing.checkedAt && (
        <Cell label="Checked" testId="turn-checked">
          <Ago at={timing.checkedAt} />
        </Cell>
      )}
    </dl>
  );
}
