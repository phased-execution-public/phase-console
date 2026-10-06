/**
 * The Tower — `#/runs` as the live management page (control-tower phase 20,
 * §Architecture 5).
 *
 * ```
 * Runs   3 need you   2 live   1 waiting   $41 today        ← the situation line (the page's)
 * [Filter by plan…]  lanes 2/3  queued 1  boarding open   [Freeze all]
 * [Decision 2] [Accounts 1] [Limits 0] [Environment 0] …    ← the annunciator
 * Needs you 3 ─────────────────────────────────────────
 *   ▌strip  ▌strip  + the inbox rows no strip draws
 * Live 2 ───  Waiting 1 ───  Queued 1 ───  Ready to start 4 ───  Settled 12
 * ```
 *
 * One question, answered in two seconds: does anything need me? The bays
 * (`bays.tsx`) are ordered by the cost of ignoring them; the annunciator
 * (`annunciator.tsx`) says which families of stop are standing and narrows
 * the bays to one; the filters are remembered (`prefs.towerCategory`,
 * `prefs.towerQuery`) because a question a person set is one they are still
 * asking the next time they look. Everything the Now page showed is here —
 * its inbox in Needs you, its lanes on the Live strips, its Next up as Ready
 * to start — composed from the same pieces, never copied.
 *
 * `useTower` (`use-tower.ts`) is the ONE fold: `features/runs/index.tsx` calls
 * it for the bays below, and the shell's header calls it for the situation
 * line it shows on every page (control-tower phase 21) — the same model, so the
 * line and the bays cannot disagree.
 */

import { useMemo, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';

import { isHaltCategory, HALT_CATEGORY_LABELS } from '@shared/halt-categories.js';
import type { ConsoleState, ConvergeStatusView, QueueAdvice, QueueEntry } from '@/lib/api';
import { usePrefs } from '@/lib/prefs';
import { BoardHeader, SuggestedOrder } from '../board';
import { Annunciator } from './annunciator';
import { CiRefusedLines } from './ci-refused';
import { TowerBays } from './bays';
import { filterTower, type Bay, type TowerModel } from './tower-model';

export interface TowerProps {
  /** `useTower`'s model, unfiltered — the filters are applied here. */
  model: TowerModel;
  state: ConsoleState | undefined;
  entries?: readonly QueueEntry[] | undefined;
  advice?: readonly QueueAdvice[] | undefined;
  allowRun: boolean;
  /** `?bay=` — the bay an address names. */
  focus?: Bay | undefined;
  readyLoading?: boolean;
  /** Every run there has been — the ledger, where this edition has one. */
  onShowTable?: (() => void) | undefined;
  totalRuns: number;
  /** The Tower/ledger switch, drawn at the end of the toolbar row. */
  switcher?: ReactNode;
  /** The convergence loop's clock — what an empty Needs-you bay says about the next sweep. */
  converge?: ConvergeStatusView | undefined;
}

export function Tower({
  model,
  state,
  entries,
  advice,
  allowRun,
  focus,
  readyLoading = false,
  onShowTable,
  totalRuns,
  switcher,
  converge,
}: TowerProps) {
  const [prefs, setPrefs] = usePrefs();
  const category = isHaltCategory(prefs.towerCategory) ? prefs.towerCategory : null;
  const query = prefs.towerQuery ?? '';
  const shown = useMemo(
    () =>
      filterTower(model, {
        category,
        query,
      }),
    [
      model,
      category,
      query,
    ],
  );
  const filtered = [
    category,
    query.trim(),
  ].some(Boolean);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="tower">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="relative flex min-w-0 flex-1 basis-48 items-center">
          <span className="sr-only">Filter the Tower by plan</span>
          <Search size={13} aria-hidden className="pointer-events-none absolute left-2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => setPrefs({ towerQuery: event.target.value })}
            placeholder="Filter by plan"
            data-testid="tower-query"
            className="h-8 w-full min-w-0 rounded-md border border-rule bg-surface pr-2 pl-7 text-sm text-ink placeholder:text-ink-faint focus-visible:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)"
          />
        </label>
        {switcher}
        <div className="min-w-0 basis-full md:basis-auto">
          <BoardHeader state={state} />
        </div>
      </div>

      <Annunciator
        lamps={shown.annunciator}
        pressed={category}
        onPress={(next) => setPrefs({ towerCategory: next ?? '' })}
      />
      <CiRefusedLines items={shown.ciRefused} />

      {filtered && (
        <p
          className="flex min-w-0 flex-wrap items-center gap-2 text-2xs text-ink-muted"
          data-testid="tower-filtered"
        >
          <span className="min-w-0">
            Showing only {category ? HALT_CATEGORY_LABELS[category].toLowerCase() : 'what matches'}
            {query.trim() ? ` in plans matching “${query.trim()}”` : ''}.
          </span>
          <button
            type="button"
            onClick={() => {
              setPrefs({ towerCategory: '', towerQuery: '' });
            }}
            className="tap-line inline-flex items-center gap-1 text-ink hover:underline"
          >
            <X size={11} aria-hidden /> Clear the filter
          </button>
        </p>
      )}

      <TowerBays
        model={shown}
        allowRun={allowRun}
        focus={focus}
        queuedHead={<SuggestedOrder entries={entries} advice={advice} allowRun={allowRun} />}
        readyLoading={readyLoading}
        onShowAll={onShowTable}
        totalRuns={totalRuns}
        filtered={filtered}
        converge={converge}
      />
    </div>
  );
}
