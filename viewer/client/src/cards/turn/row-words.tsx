/**
 * An item's card words on a ROW (turn-by-turn phase 10) — NOW, or NOT YET with
 * its *when*, and the type's mark — drawn exactly as the card's head draws
 * them (`cards/turn/head.tsx`), from the words the server put on the row's
 * `turn` view (`withRowWords`). The Runs home's Your turn rows and the bell's
 * needs-you rows lead with it, so every surface says what the card says.
 * Readiness is drawn only while the act is still the person's: an item being
 * checked or done says its type alone.
 */

import type { TurnView } from '@/data/turn';
import { cn } from '@/lib/cn';
import { TurnReadiness } from '@/ui/status';
import { TypeMark } from './type-mark';

export function TurnRowWords({ turn, className }: { turn: TurnView | undefined; className?: string }) {
  if (!turn?.type) return null;
  const due = turn.group !== 'checking' && turn.group !== 'done' && turn.readiness != null;
  return (
    <div
      data-testid="turn-row-words"
      data-type={turn.type}
      data-readiness={due ? turn.readiness : ''}
      className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1', className)}
    >
      {due && (
        <TurnReadiness
          readiness={turn.readiness}
          when={turn.readiness === 'not-yet' ? turn.startWhen : undefined}
        />
      )}
      <TypeMark type={turn.type} />
    </div>
  );
}
