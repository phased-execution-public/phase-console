/**
 * The verdict box (turn-by-turn phase 8) — drawn BEFORE the steps, because a
 * verdict changes what the steps are for:
 *
 *   Redo        "Not done yet — please redo", attempt N, what the check found,
 *               and exactly what to fix as numbered steps;
 *   Needs more  the one detail the check needs;
 *   Checking    the check is running — the verdict lands here;
 *   Passed      quiet: who passed it and what it read;
 *   Not doing / Closed — how it ended, by whom, and when.
 *
 * Back with the person, the box wears the summons on its leading edge — a rule
 * in the hue, never a filled band; settled, it goes quiet.
 */

import type { StepVerdictRecord } from '@/data/human-steps';
import type { TurnSettled } from '@/data/turn';
import { cn } from '@/lib/cn';
import { stamp } from '../human-step-card';

export function Verdict({ verdict }: { verdict: StepVerdictRecord }) {
  const passed = verdict.state === 'passed';
  return (
    <div
      data-testid="turn-verdict"
      data-verdict={verdict.state}
      className={cn(
        'flex min-w-0 max-w-prose flex-col gap-2 border-s-2 ps-3 text-body text-ink',
        passed ? 'border-rule-strong' : 'state-needs-you border-state',
      )}
    >
      <p>
        <span className="font-medium">
          {passed
            ? verdict.unverified
              ? 'Passed on your word, unverified: '
              : 'Passed: '
            : verdict.state === 'needs-info'
              ? `Back to you — attempt ${verdict.attempt} needs one detail: `
              : `Back to you — attempt ${verdict.attempt}: `}
        </span>
        {verdict.note}
      </p>
      {!passed && verdict.redo.length > 0 && (
        <div>
          <p className="font-medium">Redo</p>
          <ol className="list-decimal ps-5" data-testid="turn-redo">
            {verdict.redo.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        </div>
      )}
      {verdict.read.length > 0 && (
        <p className="text-meta text-ink-muted">The check read: {verdict.read.join('; ')}</p>
      )}
    </div>
  );
}

/** A check running: what it is and where the answer lands. */
export function CheckingLine({ attempts, ledger }: { attempts: number; ledger: boolean }) {
  return (
    <p
      data-testid="turn-checking"
      className="flex max-w-prose flex-col gap-0.5 border-s-2 border-rule-strong ps-3 text-body text-ink"
    >
      <span className="font-medium">Waiting for the check{attempts ? ` — attempt ${attempts}` : ''}.</span>
      <span className="text-ink-muted">
        {ledger
          ? 'The verdict lands here: Passed, or Redo with exactly what to fix.'
          : 'Nothing to press until it does.'}
      </span>
    </p>
  );
}

/** How a pressed projected item ended: passed or closed, by whom, when, and what was pressed. */
export function SettledLine({ settled }: { settled: TurnSettled }) {
  return (
    <p
      data-testid="turn-settled"
      data-outcome={settled.outcome}
      className="max-w-prose border-s-2 border-rule-strong ps-3 text-body text-ink"
    >
      <span className="font-medium">
        {settled.outcome === 'passed' ? 'Passed' : 'Closed'} — by {settled.by}, at {stamp(settled.at)}.
      </span>{' '}
      {settled.what}
    </p>
  );
}
