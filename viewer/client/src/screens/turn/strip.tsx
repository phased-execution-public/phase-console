/**
 * Your turn's strip (turn-by-turn phase 9, §Architecture 7): the page's three
 * numbers — to do, checking, passed today — the live line (the round, its
 * clock and when it last changed the turn) and *Next deadline*.
 *
 * ```
 * 3 to do   1 checking   2 passed today
 * Round 14, read at 12:00. It last changed at 11:50.
 * Next deadline: Sign gh in, in 3 h.
 * ```
 *
 * Words with figures on one line, never tiles (design.md §1, principle 1).
 * The numbers are the server's (`TurnAnswer.strip`, `stripOf`), counted from
 * the same groups the page draws. *Next deadline* reads the ONE page clock
 * (`ui/clock.ts`, `usePageNow`), so its "in 3 h" moves with every other figure
 * and re-renders nothing else; past due it says how overdue, in the failed hue.
 */

import { type TurnAnswer } from '@/data/turn';
import { cn } from '@/lib/cn';
import { turnHref } from '@/shell/routes';
import { usePageNow } from '@/ui/clock';
import { clockSpan } from '@/cards/turn/timing';
import { stripOf } from './page-model';

function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** The live line: the round, its time, and when it last changed the turn. */
export function RoundLine({ round }: { round: TurnAnswer['round'] }) {
  return (
    <span data-testid="turn-round">
      {/* Round 0 is a console no round has changed the turn on yet: no number to give. */}
      {round.n > 0 ? `Round ${round.n}, read` : 'Read'} at{' '}
      <time dateTime={round.at}>{clockTime(round.at)}</time>.
      {round.changedAt ? (
        <>
          {' '}
          It last changed at <time dateTime={round.changedAt}>{clockTime(round.changedAt)}</time>.
        </>
      ) : null}
    </span>
  );
}

/** *Next deadline* — the nearest an open item carries, on the page clock. */
function NextDeadline({ next }: { next: NonNullable<ReturnType<typeof stripOf>['nextDeadline']> }) {
  const now = usePageNow();
  const at = Date.parse(next.at);
  const overdue = now > at;
  const span = clockSpan(at - now, false);
  return (
    <span data-testid="turn-next-deadline" data-overdue={overdue ? 'true' : undefined}>
      Next deadline:{' '}
      <a
        href={turnHref(next.item)}
        className="tap-row text-ink underline decoration-rule-strong underline-offset-2"
      >
        {next.title}
      </a>
      ,{' '}
      <time dateTime={next.at} className={cn(overdue ? 'state-failed text-state' : 'text-ink')}>
        {overdue ? `overdue by ${span}` : `in ${span}`}
      </time>
      .
    </span>
  );
}

/** One figure and its word: the number in tabular figures, the word after it. */
function Figure({ id, n, word }: { id: string; n: number; word: string }) {
  return (
    <span data-testid={`turn-strip-${id}`} data-value={n} className="flex items-baseline gap-1.5">
      <span className="text-section font-semibold text-ink tabular-nums">{n}</span>
      <span className="text-body text-ink-muted">{word}</span>
    </span>
  );
}

export function TurnStrip({ answer }: { answer: Pick<TurnAnswer, 'groups' | 'strip' | 'round'> }) {
  const strip = stripOf(answer);
  return (
    <div data-testid="turn-strip" className="flex min-w-0 flex-col gap-1">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1">
        <Figure id="todo" n={strip.todo} word="to do" />
        <Figure id="checking" n={strip.checking} word="checking" />
        <Figure id="passed" n={strip.passedToday} word="passed today" />
      </p>
      <p className="text-meta text-ink-muted">
        <RoundLine round={answer.round} />{' '}
        {strip.nextDeadline ? (
          <NextDeadline next={strip.nextDeadline} />
        ) : (
          <span data-testid="turn-next-deadline">Next deadline: none set.</span>
        )}
      </p>
    </div>
  );
}
