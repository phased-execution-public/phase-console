/**
 * *I've done this — check*, and what it came to (7.0, quiet-console phase 8,
 * #266).
 *
 * A check used to say nothing unless the proof landed: a decision step's
 * button re-ran its `cmd:` proof and the person learned nothing. Now the
 * outcome is said in the verdict's own words — proven; being checked, with
 * the verdict to land on the item; or not yet, with exactly what the proof
 * read, the exit it saw and what to redo — drawn in the verdict's place on
 * the card (`cards/item-card.tsx` lends it the slot as `parts.CheckOutcome`),
 * before the guide, because it changes what the guide is for.
 *
 * Pure words first (`checkOutcomeOf`), so `check.test.tsx` proves them
 * without a card.
 */

import type { HumanStepRecord, StepVerbAnswer } from '@/data/human-steps';
import { cn } from '@/lib/cn';

export type CheckTone = 'passed' | 'checking' | 'back';

export interface CheckOutcomeWords {
  tone: CheckTone;
  /** The first words — Proven. · Being checked. · Not yet. · One detail is missing. */
  lead: string;
  /** The sentence after them, the verdict's own. */
  words: string;
  redo: readonly string[];
  /** What the check read, verbatim — the proof's ref and its exit among them. */
  read: readonly string[];
  attempt?: number | undefined;
}

/** The exit a probe saw, as the verdict spells it — "exited 1", "exit 0". Null when it names none. */
export function exitOf(words: readonly string[]): number | null {
  for (const line of words) {
    const m = /\bexit(?:ed)?(?: code)?\s+(\d+)\b/i.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The words of a check's answer — null when the answer was not a check's at all. */
export function checkOutcomeOf(answer: StepVerbAnswer): CheckOutcomeWords | null {
  const { check, verdict } = answer;
  if (!check && !verdict) return null;
  const read = verdict?.read ?? (check?.read ? [`${check.ref ? `${check.ref} — ` : ''}${check.read}`] : []);
  const attempt = verdict?.attempt ?? check?.attempt;
  if (check?.landed || verdict?.state === 'passed') {
    return {
      tone: 'passed',
      lead: 'Proven.',
      words: verdict?.note ?? 'The proof holds — the phase carries on.',
      redo: [],
      read,
      attempt,
    };
  }
  if (check?.state === 'checking' || (!verdict && check && !check.read && !check.why)) {
    return {
      tone: 'checking',
      lead: 'Being checked.',
      words: 'An AI checker reads what you did against the proof’s words; the verdict lands on this item.',
      redo: [],
      read: [],
      attempt,
    };
  }
  const exit = exitOf(read);
  const words = verdict?.note ?? check?.why ?? 'The proof did not hold.';
  return {
    tone: 'back',
    lead: verdict?.state === 'needs-info' ? 'One detail is missing.' : 'Not yet.',
    words: exit !== null && !/\bexit/i.test(words) ? `${words} The proof exited ${exit}.` : words,
    redo: verdict?.redo ?? [],
    read,
    attempt,
  };
}

/** The outcome, drawn where the card draws a verdict: a rule in the summons hue when it is back with the person, quiet when it passed. */
export function CheckOutcome({ answer }: { answer: StepVerbAnswer; record?: HumanStepRecord | undefined }) {
  const outcome = checkOutcomeOf(answer);
  if (!outcome) return null;
  const back = outcome.tone === 'back';
  return (
    <div
      data-testid="turn-check-outcome"
      data-tone={outcome.tone}
      role="status"
      className={cn(
        'flex min-w-0 max-w-(--measure) flex-col gap-2 border-s-2 ps-3 text-body text-ink',
        back ? 'state-needs-you border-state' : 'border-rule-strong',
      )}
    >
      <p>
        <span className="font-medium">
          {outcome.lead}
          {outcome.attempt != null ? ` Attempt ${outcome.attempt}.` : ''}{' '}
        </span>
        {outcome.words}
      </p>
      {outcome.redo.length > 0 && (
        <div>
          <p className="font-medium">Redo</p>
          <ol className="list-decimal ps-5" data-testid="turn-check-redo">
            {outcome.redo.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        </div>
      )}
      {outcome.read.length > 0 && (
        <p className="text-meta text-ink-muted" data-testid="turn-check-read">
          The check read: {outcome.read.join('; ')}
        </p>
      )}
    </div>
  );
}
