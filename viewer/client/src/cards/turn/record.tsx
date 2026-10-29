/**
 * The card's RECORD, after its act (Tower strips, 2026-10-20) — what a person
 * reads to understand an item rather than to act on it, as fold strips
 * (`ui/accordion.tsx`), each head naming what it holds and saying, in one
 * line, the gist of it, so a closed fold still informs:
 *
 *   How it's checked   the check in words, and who decides it is done;
 *   Where it goes      where a press goes, and who resumes;
 *   Timing             the timing grid on the one page clock — its head says
 *                      the deadline, what is left or how overdue;
 *   Steps              a Decision's or an Approval's steps — the console's
 *                      own, short — OPEN at first (a Task's and a Heads-up's
 *                      steps are its act, drawn before its form);
 *   History            who raised it and when, every move and attempt, the
 *                      questions, the answer — and the raw record.
 *
 * Several may be open at once; a folded body unmounts, as every fold of the
 * console does. *Everything* opens them all.
 */

import type { ReactNode } from 'react';
import { Accordion, AccordionItem } from '@/ui/accordion';
import { usePageNow } from '@/ui/clock';
import { span, stamp } from './step-words';
import type { Timing } from './timing';

/** One fold of the record. */
export interface RecordFold {
  value: 'check' | 'route' | 'timing' | 'steps' | 'history';
  label: string;
  /** One line of what is inside, read while it is folded. */
  summary?: ReactNode;
  count?: number | undefined;
  testId: string;
  body: ReactNode;
}

/** Every fold, by name — what *Everything* opens. */
const EVERY_FOLD: readonly RecordFold['value'][] = ['check', 'route', 'timing', 'steps', 'history'];

/**
 * A fold head's line after its label — heard as one phrase with it ("Timing,
 * deadline in 3 h"), seen as the quiet text at the head's end.
 */
function said(words: ReactNode): ReactNode {
  return (
    <>
      <span className="sr-only">, </span>
      {words}
    </>
  );
}

export function RecordFolds({
  folds,
  everything = false,
}: {
  folds: readonly RecordFold[];
  /** *Everything* is on: every fold open. */
  everything?: boolean;
}) {
  if (!folds.length) return null;
  return (
    <div data-testid="turn-record" className="min-w-0 border-t border-rule">
      {/* Remounted when Everything flips, so each state starts from its own opening. */}
      <Accordion
        key={everything ? 'everything' : 'record'}
        defaultValue={everything ? [...EVERY_FOLD] : ['steps']}
      >
        {folds.map((fold) => (
          <AccordionItem
            key={fold.value}
            value={fold.value}
            label={fold.label}
            summary={fold.summary != null ? said(fold.summary) : undefined}
            count={fold.count}
            testId={fold.testId}
            // The card is titled at h3, so its record folds at h4.
            level={4}
            bodyClassName="flex min-w-0 flex-col gap-3 pt-1"
          >
            {fold.body}
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

const parse = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN);

/**
 * The Timing fold's line: the deadline — what is left, or how overdue in the
 * failed hue — on the page clock, in minutes (a line in a fold's head never
 * takes the second-by-second tick); "No deadline set" when there is none.
 */
export function TimingSummary({ timing, live }: { timing: Timing; live: boolean }) {
  const now = usePageNow();
  const end = parse(timing.deadline);
  if (!Number.isFinite(end)) return <span data-testid="turn-timing-summary">No deadline set</span>;
  if (!live)
    return (
      <span data-testid="turn-timing-summary" className="tabular-nums">
        Deadline {stamp(timing.deadline)}
      </span>
    );
  return now > end ? (
    <span
      data-testid="turn-timing-summary"
      data-overdue="true"
      className="state-failed text-state tabular-nums"
    >
      Overdue by {span(now - end)}
    </span>
  ) : (
    <span data-testid="turn-timing-summary" className="tabular-nums">
      Deadline in {span(end - now)}
    </span>
  );
}

/** A step's words without their Markdown, for a fold's one line — a head is a button, never a link. */
export function plainStep(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_)([^*_]+)\1/g, '$2')
    .trim();
}
