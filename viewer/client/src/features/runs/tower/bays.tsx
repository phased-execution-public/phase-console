/**
 * The bays — the Tower's runs, most urgent first (control-tower phase 20,
 * §Architecture 5).
 *
 * Six places a thing can be, in the order it costs to ignore them: Needs you,
 * Live, Waiting, Queued, Ready to start, Settled (`BAYS`, the status model's
 * own list). Every run is a STRIP (`strip.tsx`, phase 19) handed the context
 * its bay was computed with, so the strip and the bay cannot disagree; the
 * one action on each is the strip's, chosen by that bay.
 *
 * - **Needs you** is runs (control-tower phase 139, #216): a strip is a run, and
 *   each strip's ONE action is its oldest item's primary. The asks no strip
 *   draws — a plan's gate, a sign-in, the acts coming up — are items of Your
 *   turn, and the bay links to the page with the page's own counts.
 * - **Waiting** and **Queued** say what each run waits on, on the strip
 *   itself (`waits.ts`): a hold, a scope fence and its refs, a folded errand,
 *   the queue's holder — a sibling run's branch included.
 * - **Ready to start** is plans, not runs: Now's Next-up set (`ready-bay.tsx`).
 * - **Settled** is quiet — folded until asked, newest first.
 *
 * An empty bay stays as one line saying so: the order is the thing a glance
 * learns, and a bay that vanished when empty would move every bay below it.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { BAYS } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { useFocusBand } from './focus-band';
import { turnHref } from '@/app/routes';
import type { ConvergeStatusView } from '@/lib/api';
import { nextSweepText } from '../sweep-text';
import { ReadyBay } from './ready-bay';
import { Strip } from './strip';
import type { Bay, TowerModel, TowerRun } from './tower-model';

export const BAY_LABELS: Record<Bay, string> = {
  'needs-you': 'Needs you',
  live: 'Live',
  waiting: 'Waiting',
  queued: 'Queued',
  ready: 'Ready to start',
  settled: 'Settled',
};

/** What an empty bay says — a fact about the console, not a mood. */
const EMPTY: Record<Bay, string> = {
  'needs-you': 'No run is waiting on you.',
  live: 'No session is working right now.',
  waiting: 'Nothing is parked on a clock, a wall or a hold.',
  queued: 'Nothing is waiting for a scope or a slot.',
  ready: 'No phase of an open plan is ready to start.',
  settled: 'Nothing has finished yet.',
};

/** How many settled strips are drawn before "Show every one". */
const SETTLED_SHOWN = 20;

export interface TowerBaysProps {
  /** The Tower, already filtered. */
  model: TowerModel;
  allowRun: boolean;
  /** `?bay=` — the bay an address names: scrolled to, and opened when folded. */
  focus?: Bay | undefined;
  /** The Queued bay's head — the suggested order, when the queue has one. */
  queuedHead?: ReactNode;
  /** The Ready bay's plans are still being read; its rows upgrade in place. */
  readyLoading?: boolean;
  /** Every run there has been — the ledger, where this edition has one. */
  onShowAll?: (() => void) | undefined;
  /** How many runs the ledger holds, for the button that opens it. */
  totalRuns?: number;
  /** A filter narrows the bays — an empty one then says so, not that the console is idle. */
  filtered?: boolean;
  /** The convergence loop's clock, for what an empty Needs-you bay says (`nextSweepText`). */
  converge?: ConvergeStatusView | undefined;
}

export function TowerBays({
  model,
  allowRun,
  focus,
  queuedHead,
  readyLoading = false,
  onShowAll,
  totalRuns,
  filtered = false,
  converge,
}: TowerBaysProps) {
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="tower-bays">
      {BAYS.map((bay) => (
        <BaySection
          key={bay}
          bay={bay}
          count={model.counts[bay]}
          focused={focus === bay}
          aside={asideOf(bay)}
          empty={
            filtered
              ? 'Nothing here matches the filter.'
              : bay === 'needs-you'
                ? `${EMPTY[bay]} ${nextSweepText(converge)}`
                : EMPTY[bay]
          }
        >
          {bodyOf(bay)}
        </BaySection>
      ))}
    </div>
  );

  function asideOf(bay: Bay): ReactNode {
    if (bay !== 'settled') return null;
    return <SettledSummary model={model} onShowAll={onShowAll} totalRuns={totalRuns} />;
  }

  function bodyOf(bay: Bay): ReactNode {
    if (bay === 'ready') {
      return model.ready.length ? (
        <ReadyBay
          departures={model.ready}
          runs={model.runs.map((t) => t.run)}
          allowRun={allowRun}
          loading={readyLoading}
        />
      ) : null;
    }
    if (bay === 'settled')
      return <SettledBody runs={model.bays.settled} allowRun={allowRun} focused={focus === bay} />;
    const runs = model.bays[bay];
    const turn = bay === 'needs-you' ? { now: model.items.length, upcoming: model.upcoming.length } : null;
    const asks = Boolean(turn && (turn.now || turn.upcoming));
    if (!runs.length && !asks && !(bay === 'queued' && queuedHead)) return null;
    return (
      <>
        {bay === 'queued' && queuedHead}
        {runs.length > 0 && <Strips runs={runs} allowRun={allowRun} />}
        {turn && asks && <TurnLine now={turn.now} upcoming={turn.upcoming} />}
      </>
    );
  }
}

function BaySection({
  bay,
  count,
  focused,
  aside,
  empty,
  children,
}: {
  bay: Bay;
  count: number;
  focused: boolean;
  aside?: ReactNode;
  /** What the bay says when it holds nothing. */
  empty: string;
  children?: ReactNode;
}) {
  const ref = useFocusBand<HTMLElement>(focused);
  return (
    <section
      ref={ref}
      aria-label={`${BAY_LABELS[bay]}, ${count}`}
      data-testid="bay"
      data-bay={bay}
      data-count={count}
      {...(focused ? { 'data-focused': 'true' } : {})}
      className="flex min-w-0 scroll-mt-4 flex-col gap-2"
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule pb-1">
        <h2 className={cn('text-sm font-medium', count ? 'text-ink' : 'text-ink-faint')}>
          {BAY_LABELS[bay]}
        </h2>
        <span
          className={cn(
            'font-display text-lg leading-none tabular-nums',
            count ? 'text-ink' : 'text-ink-faint',
          )}
          data-testid="bay-count"
        >
          {count}
        </span>
        {count === 0 && <span className="min-w-0 text-2xs text-ink-faint">{empty}</span>}
        {aside && <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Strips({ runs, allowRun }: { runs: readonly TowerRun[]; allowRun: boolean }) {
  return (
    <div className="grid min-w-0 gap-2 xl:grid-cols-2">
      {runs.map((t) => (
        <Strip
          key={t.key}
          run={t.run}
          lanes={t.lanes}
          checks={t.checks}
          {...(t.entry ? { entry: t.entry } : {})}
          allowRun={allowRun}
          ctx={t.ctx}
        />
      ))}
    </div>
  );
}

/**
 * Where the asks went (control-tower phase 139): ONE line, the page's own
 * counts, one press to the page — every item there, whichever run it is of,
 * the ones of no run and the ones coming up included.
 */
function TurnLine({ now, upcoming }: { now: number; upcoming: number }) {
  const parts = [
    now ? `${now} need${now === 1 ? 's' : ''} you` : null,
    upcoming ? `${upcoming} coming up` : null,
  ].filter(Boolean);
  return (
    <a
      href={turnHref()}
      data-testid="bay-turn"
      className="tap-line self-start text-xs text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
    >
      Your turn: {parts.join(', ')} — open the page
    </a>
  );
}

function SettledSummary({
  model,
  onShowAll,
  totalRuns,
}: {
  model: TowerModel;
  onShowAll?: (() => void) | undefined;
  totalRuns?: number | undefined;
}) {
  const { today, dormant } = model.settled;
  return (
    <>
      {(today > 0 || dormant > 0) && (
        <span className="text-2xs text-ink-muted" data-testid="settled-summary">
          {today} today, {dormant} dormant
        </span>
      )}
      {onShowAll && (totalRuns ?? 0) > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="tap-line text-2xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          All {plural(totalRuns ?? 0, 'run')}
        </button>
      )}
    </>
  );
}

function SettledBody({
  runs,
  allowRun,
  focused,
}: {
  runs: readonly TowerRun[];
  allowRun: boolean;
  focused: boolean;
}) {
  const [prefs, setPrefs] = usePrefs();
  const [every, setEvery] = useState(false);
  const open = prefs.towerSettledOpen || focused;
  if (!runs.length) return null;
  const shown = every ? runs : runs.slice(0, SETTLED_SHOWN);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPrefs({ towerSettledOpen: !open })}
        className="tap-line flex items-center gap-1 self-start text-2xs text-ink-muted hover:text-ink"
      >
        <ChevronDown
          size={12}
          aria-hidden
          className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
        />
        {open ? 'Hide the settled runs' : `Show ${plural(runs.length, 'settled run')}`}
      </button>
      {open && (
        <div className="expand-region">
          <div className="flex min-w-0 flex-col gap-2">
            <Strips runs={shown} allowRun={allowRun} />
            {runs.length > shown.length && (
              <button
                type="button"
                onClick={() => setEvery(true)}
                className="tap-line self-start text-2xs text-ink-muted hover:text-ink"
              >
                Show every one of the {runs.length}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
