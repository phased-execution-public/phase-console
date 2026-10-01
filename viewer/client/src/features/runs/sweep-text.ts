import type { ConvergeStatusView } from '@/lib/api';
import { plural } from '@/lib/format';

/**
 * When the loop next looks at all this by itself — said under the Tower's empty
 * Needs-you bay (`tower/bays.tsx`), as Now's empty inbox said it until 6.0
 * (control-tower phase 21). "Nothing is waiting on you" alone reads as "and
 * nothing ever will"; an operator who has watched the console park a run wants
 * to know whether anything is coming back round, and a console whose loop is
 * manual says THAT.
 *
 * Its own module, outside `tower/`, because the figure in it is the loop's
 * configured PERIOD ("every 15 min"), not a clock: the Tower's files print a
 * duration only through `clockWords`, and `lib/format.test.ts` scans them for it.
 */
export function nextSweepText(converge: ConvergeStatusView | undefined): string {
  if (!converge) return 'The convergence loop re-reads the board whenever anything changes.';
  if (!converge.automatic) {
    return 'Convergence is manual on this console (runs are off, or --no-converge) — Recover & continue runs a pass.';
  }
  const every = converge.everyMs > 0 ? ` and every ${Math.round(converge.everyMs / 60_000)} min` : '';
  const queued = converge.pending.length ? ` ${plural(converge.pending.length, 'pass')} queued.` : '';
  return `The loop sweeps at boot, on a docs change, a minute after a stop${every}.${queued}`;
}
