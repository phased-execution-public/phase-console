import { describeWord } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * Your turn's two words (turn-by-turn phase 8) — where an item stands for the
 * PERSON (`PERSON_STATUSES`: To do, Checking, Passed, Redo, Not doing, Closed,
 * Waiting for the owner) and whether it is due (`READINESS`: Now, Not yet).
 * Members of the typed family like every other status: a dot and a word, the
 * summons painting the word for To do, Redo and Now alone.
 */
export function TurnStatus({ status, ...chrome }: { status: WordOf<'turn'> | null | undefined } & Chrome) {
  return <DotWord view={describeWord('turn', status)} {...chrome} />;
}

/**
 * NOW, or NOT YET with its *when* — the word as a dot and a word, and the when
 * after a thin rule, in words that wrap: "when Phase 13 of demo is done" is a
 * sentence, never a clipped label. A NOT YET with no when says only the word.
 */
export function TurnReadiness({
  readiness,
  when,
  className,
  ...chrome
}: { readiness: WordOf<'readiness'> | null | undefined; when?: string | undefined } & Chrome) {
  return (
    <span
      data-testid="turn-readiness"
      data-readiness={readiness ?? ''}
      className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}
    >
      <DotWord view={describeWord('readiness', readiness)} {...chrome} />
      {when && (
        <>
          <span className="sr-only">, </span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-ink-faint" />
          <span data-testid="turn-readiness-when" className="min-w-0 text-meta break-words text-ink-muted">
            {when}
          </span>
        </>
      )}
    </span>
  );
}
