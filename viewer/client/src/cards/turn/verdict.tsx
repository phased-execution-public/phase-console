/**
 * The verdict box (turn-by-turn phase 8; structured by Tower strips,
 * 2026-10-20) — drawn right after the card's head and BEFORE the steps,
 * because a verdict changes what the steps are for. Three parts, each on its
 * own line, so the eye finds the one it needs:
 *
 *   1. the lead — "Back to you — attempt N" (or "… needs one detail", or
 *      "Passed", "Passed on your word, unverified");
 *   2. what the check found, in its own words, and what it read;
 *   3. on Redo, exactly what to fix, as numbered steps.
 *
 * A running check says the verdict lands here; a settled item says how it
 * ended, by whom and when. Back with the person, the box wears the summons on
 * its leading edge — a rule in the hue, never a filled band; settled, it goes
 * quiet.
 */

import { PERSON_STATUS_LABEL } from '@shared/turn-model.js';
import type { StepVerdictRecord } from '@/data/human-steps';
import type { TurnSettled } from '@/data/turn';
import { cn } from '@/lib/cn';
import { stamp } from './step-words';

/** The verdict's lead, in words. */
function leadOf(verdict: StepVerdictRecord): string {
  if (verdict.state === 'passed') return verdict.unverified ? 'Passed on your word, unverified' : 'Passed';
  return verdict.state === 'needs-info'
    ? `Back to you — attempt ${verdict.attempt} needs one detail`
    : `Back to you — attempt ${verdict.attempt}`;
}

export function Verdict({ verdict }: { verdict: StepVerdictRecord }) {
  const passed = verdict.state === 'passed';
  return (
    <div
      data-testid="turn-verdict"
      data-verdict={verdict.state}
      className={cn(
        'flex min-w-0 max-w-(--measure) flex-col gap-2 border-s-2 ps-3 text-body text-ink',
        passed ? 'border-rule-strong' : 'state-needs-you border-state-vivid',
      )}
    >
      <p data-testid="turn-verdict-lead" className="font-semibold">
        {leadOf(verdict)}
        {/* Heard as one sentence with what the check found; seen as a line of its own. */}
        {verdict.note ? <span className="sr-only">: </span> : null}
      </p>
      {verdict.note && <p data-testid="turn-verdict-note">{verdict.note}</p>}
      {verdict.read.length > 0 && (
        <p className="text-meta text-ink-muted">
          <span className="font-medium text-ink">The check read: </span>
          {verdict.read.join('; ')}
        </p>
      )}
      {!passed && verdict.redo.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">Redo</p>
          <ol className="flex list-decimal flex-col gap-0.5 ps-5" data-testid="turn-redo">
            {verdict.redo.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** A check running: what it is and where the answer lands. */
export function CheckingLine({ attempts, ledger }: { attempts: number; ledger: boolean }) {
  return (
    <p
      data-testid="turn-checking"
      className="flex max-w-(--measure) flex-col gap-0.5 border-s-2 border-rule-strong ps-3 text-body text-ink"
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

/** How a pressed projected item ended: passed, closed or not doing, by whom, when, and what was pressed. */
export function SettledLine({ settled }: { settled: TurnSettled }) {
  return (
    <p
      data-testid="turn-settled"
      data-outcome={settled.outcome}
      className="max-w-(--measure) border-s-2 border-rule-strong ps-3 text-body text-ink"
    >
      <span className="font-medium">
        {PERSON_STATUS_LABEL[settled.outcome]} — by {settled.by}, at {stamp(settled.at)}.
      </span>{' '}
      {settled.what}
    </p>
  );
}
