/**
 * The Tower's machinery that is not a bay — how full the console is, the
 * suggested order, and the board/table switch.
 *
 * ## What this file was
 *
 * The orchestration board (control-tower phase 18): four columns — running,
 * queued, waiting, frozen — a card per live run. Phase 19 made each card a
 * STRIP and phase 20 replaced the columns with the Tower's BAYS
 * (`tower/tower.tsx`), ordered by urgency and read off the status model, so a
 * column list of this file's own no longer exists to disagree with it. What
 * stays here is what the bays do not decide:
 *
 *  - `BoardHeader` — lanes in use against the cap, the boarding schedule and
 *    the usage window, and Freeze all. (What is queued is the Queued bay's
 *    own count; a second figure here read "queued 0" beside "2 queued".) `state.concurrency`
 *    had been on `/api/state` since the pool existed and nothing drew it.
 *  - `suggestedOrder` and `SuggestedOrder` — which queued plan it would cost
 *    least to let go first, and the one-tap apply (the head of the Queued bay).
 *  - `BoardToggle` — the Tower or the ledger, one switch in both shapes.
 *
 * **Every** lifecycle verb still goes through `lib/run-lifecycle.ts`; the
 * advisory's apply is the one settings patch this file makes, and
 * `run-setup/single-source.test.ts` pins it here by path.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Snowflake } from 'lucide-react';

import { api, type ConsoleState, type QueueAdvice, type QueueEntry } from '@/lib/api';
import { keys } from '@/lib/queries';
import { FleetFreezeControl } from '@/components/fleet-freeze';
import { plural, relativeTime, weight } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Button, toast } from '@/components/ui';
import { queueHref } from '@/app/routes';

/* ================================================================== *
 * The advisory
 * ================================================================== */

/**
 * Which queued plan it would cost least to let go first — advice, never an act.
 *
 * The scheduler does not reorder itself and this does not ask it to. It reads
 * `/api/queue`'s own `advice[]` (remaining weight per queued plan, measured
 * from what that plan has already spent) and names the LIGHTEST one, because
 * finishing the short plan first is the ordering that leaves every other plan
 * waiting the least. Applying it is the operator raising that plan's priority
 * class, which is an input to the same first-fit scan as ever.
 *
 * Three ways it declines to say anything, all deliberate:
 *  - fewer than two queued plans — there is no order to suggest;
 *  - no measured weight for the leader — an estimate exists only once
 *    something of that plan has finished, and a made-up number on this line
 *    would be indistinguishable from a measured one;
 *  - the lightest plan is ALREADY at the head of the scan — suggesting the
 *    order that already holds is how an advisory becomes noise.
 */
export interface OrderAdvice {
  /** The plan to let go first. */
  slug: string;
  /** Its measured remaining weight, in tokens. */
  remainingWeight: number;
  /** The plan currently at the head of the scan, which this would move behind. */
  ahead: string;
  /** Every other queued plan — the ones an apply would put back to `normal`. */
  demote: string[];
}

export function suggestedOrder(
  entries: readonly QueueEntry[] | undefined,
  advice: readonly QueueAdvice[] | undefined,
): OrderAdvice | null {
  const order: string[] = [];
  for (const entry of entries ?? []) if (!order.includes(entry.slug)) order.push(entry.slug);
  if (order.length < 2) return null;

  const weights = new Map<string, number>();
  for (const row of advice ?? []) {
    if (row.remainingWeight != null && row.remainingWeight > 0) weights.set(row.slug, row.remainingWeight);
  }

  // Ties keep the scan's own order, so a suggestion is never a coin toss the
  // operator cannot see the reason for.
  const ranked = order.filter((slug) => weights.has(slug));
  if (ranked.length < 2) return null;
  const lightest = ranked.reduce((best, slug) => (weights.get(slug)! < weights.get(best)! ? slug : best));
  if (lightest === order[0]) return null;

  return {
    slug: lightest,
    remainingWeight: weights.get(lightest)!,
    ahead: order[0],
    demote: order.filter((slug) => slug !== lightest),
  };
}

/* ================================================================== *
 * The header
 * ================================================================== */

/**
 * How full the console is, whether it is switched off, and the switch.
 *
 * `state.concurrency` has been on `/api/state` since the pool existed and
 * NOTHING has ever drawn it: the one figure that says whether a queue is a
 * queue or a cap. It is here because this is the surface where the answer
 * changes what you do — three of three lanes in use and four queued is a
 * different day from one of three.
 */
export function BoardHeader({ state }: { state: ConsoleState | undefined }) {
  // No `allowRun` prop: the only thing it gated here was the freeze pair, and
  // that now lives in `FleetFreezeControl`, which reads the flag off the state
  // itself. Passing it in as well would be a second copy of one fact — and the
  // copy is the half that goes stale.
  const fleet = state?.fleet ?? { frozen: false, at: null, by: null };
  const concurrency = state?.concurrency;
  const live = concurrency?.live ?? 0;
  const max = concurrency?.max ?? 0;
  const schedule = concurrency?.schedule;
  const at = fleet.at ? Date.parse(fleet.at) : NaN;

  return (
    <div
      data-testid="board-header"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5"
    >
      <span className="flex items-center gap-1.5 text-2xs text-ink-muted">
        {/* The lanes' hue, beside the word it colours; it breathes only while a
            lane is live and the fleet is not frozen. */}
        <span
          aria-hidden
          className={cn(
            'inline-block size-[7px] shrink-0 rounded-full bg-running',
            live > 0 && !fleet.frozen && 'animate-pulse-soft',
          )}
        />
        <span>lanes</span>
        <span className="font-mono tabular-nums text-ink" data-testid="board-lanes">
          {max ? `${live}/${max}` : String(live)}
        </span>
      </span>
      {/* The whole queue — every entry, why it sits there, who holds what, and
          the verbs that move it (control-tower phase 99, #135). */}
      <a
        href={queueHref()}
        className="text-2xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        data-testid="board-queue-link"
      >
        {concurrency?.queued ? `${concurrency.queued} queued — see why` : 'Queue'}
      </a>
      {/* The boarding schedule, reported even when OPEN — a header that only
          speaks up once a phase has failed to start is a header that tells you
          after it mattered. */}
      {schedule && (
        <span className="text-2xs text-ink-muted" data-testid="board-schedule">
          {schedule.open
            ? 'boarding open'
            : `boarding closed${
                schedule.opensAt ? ` — opens ${relativeTime(schedule.opensAt)}` : ''
              }${schedule.reason ? ` (${schedule.reason})` : ''}`}
        </span>
      )}
      {concurrency?.throttledUntil != null && (
        <span className="text-2xs text-attention" data-testid="board-throttle">
          usage window until {relativeTime(concurrency.throttledUntil)}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        {fleet.frozen && (
          // A freeze is a wait somebody chose, not a summons: the quiet waiting tone.
          <Badge tone="wait" dot data-testid="board-frozen-chip">
            <Snowflake size={11} aria-hidden /> frozen
            {Number.isFinite(at) ? ` ${relativeTime(at)}` : ''}
            {fleet.by ? ` by ${fleet.by}` : ''}
          </Badge>
        )}
        {/* The shared control, not a second implementation of the act.
            `components/fleet-freeze.tsx` named this header as its real home and
            this header then grew its own copy over the same hook — three render
            sites, two behaviours, and a comment promising one. `confirm` is the
            only thing the two ever disagreed about. `allowRun` is checked
            inside it, so the guard is not duplicated either. */}
        <FleetFreezeControl confirm />
      </span>
    </div>
  );
}

/* ================================================================== *
 * The advisory, drawn
 * ================================================================== */

/**
 * The suggested order as a line with its one button — the head of the Tower's
 * Queued bay (control-tower phase 20), where the plans it would reorder sit.
 *
 * Applying it raises the suggested plan and puts the other queued plans back
 * to `normal`. Three classes cannot express an N-way ordering, and pretending
 * otherwise is the failure this avoids — it raises ONE plan and levels the
 * rest, which is exactly what the sentence beside the button says it does.
 * Nothing is reordered by the console: the scan runs as it always did, with
 * one class changed.
 */
export function SuggestedOrder({
  entries,
  advice,
  allowRun,
}: {
  entries?: readonly QueueEntry[] | undefined;
  advice?: readonly QueueAdvice[] | undefined;
  allowRun: boolean;
}) {
  const client = useQueryClient();
  const [applying, setApplying] = useState(false);
  const order = useMemo(() => suggestedOrder(entries, advice), [entries, advice]);

  const apply = useCallback(async () => {
    if (!order) return;
    setApplying(true);
    try {
      await api.runSettings(order.slug, { priority: 'high' });
      for (const slug of order.demote) await api.runSettings(slug, { priority: 'normal' });
      toast(`${order.slug} raised to high — the other queued plans are normal`, 'ok');
    } catch (error) {
      toast(String((error as Error)?.message ?? error), 'error');
    } finally {
      setApplying(false);
      void client.invalidateQueries({ queryKey: keys.runs() });
      void client.invalidateQueries({ queryKey: keys.queue() });
      void client.invalidateQueries({ queryKey: keys.state() });
    }
  }, [client, order]);

  if (!order) return null;
  return (
    <div
      data-testid="board-advice"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface-raised px-3 py-2 text-2xs text-ink-muted"
    >
      <span className="min-w-0 flex-1">
        Suggested order: let <b className="font-mono">{order.slug}</b> go first —{' '}
        {weight(order.remainingWeight)} of work left, against <b className="font-mono">{order.ahead}</b> at
        the head of the scan. Applying raises it to <b>high</b> and puts the other{' '}
        {plural(order.demote.length, 'queued plan')} back to <b>normal</b>; nothing is reordered.
      </span>
      {allowRun && (
        <Button size="sm" variant="ghost" disabled={applying} onClick={() => void apply()}>
          Apply
        </Button>
      )}
    </div>
  );
}

/** The board / table switch, shown in both shapes so neither is a dead end. */
export function BoardToggle({
  view,
  onView,
}: {
  view: 'board' | 'table';
  onView: (next: 'board' | 'table') => void;
}) {
  // The table compares many runs side by side, which IS the fleet — Pro. With
  // one destination there is nothing to switch to, so this draws nothing rather
  // than a control that cannot move.
  const VIEWS: Array<'board' | 'table'> = [
    'board',
  ];
  if (VIEWS.length < 2) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Runs view">
      {VIEWS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onView(value)}
          className={cn(
            'rounded-md px-2 py-1 text-2xs [@media(hover:none)]:min-h-(--tap-min)',
            // Muted, not faint: at 12 px on the page's ground faint reads 3.4:1 (axe).
            view === value ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink',
          )}
        >
          {value === 'board' ? 'Board' : 'Table'}
        </button>
      ))}
    </div>
  );
}
