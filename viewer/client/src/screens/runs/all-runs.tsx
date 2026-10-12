/**
 * All runs — every run there has been, as the grid (7.0, quiet-console phase
 * 7; the Pro ledger since control-tower phase 21, free in both editions now).
 *
 * The groups answer "what is happening, and what do I do about it"; this
 * answers "what has happened": one row per run, the plan, its word, the
 * folded track, what it spent and worked, why it is where it is in one
 * sentence, and when it last moved — the id and the model with Everything on.
 * Live rows are pinned to the top in every order; a closed plan's runs are
 * history, hidden until the toolbar's verb reveals them (`prefs.runsShowClosed`).
 * A row's detail carries the verbs the groups' rows do not: dismiss a stopped
 * run's card or put it back, and the whole-run freeze and stop.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { waitNote } from '@shared/status-model.js';
import { runsApi } from '@/data/api/runs';
import type { ConsoleState } from '@/data/api';
import { keys } from '@/data/keys';
import { asRunLike, glanceOf, isLiveRun } from '@/data/lanes';
import { pressLifecycle } from '@/data/lifecycle';
import { press } from '@/data/press';
import type { PlacedRun } from '@/data/run-groups';
import { usePrefs } from '@/lib/prefs';
import { Button, Duration, Money, Mono, RelativeTime, toast, type Everything } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { RunStatus } from '@/ui/status';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { runHref } from '@/shell/routes';
import { bindingHoldOf, compactTrack, stopReason, type FleetHoldView } from './model';

/** The orders the grid offers, by the preference's word. */
export const RUNS_SORTS = ['updated', 'cost', 'worked', 'plan'] as const;
export type RunsSort = (typeof RUNS_SORTS)[number];

const stamp = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const COMPARE: Record<RunsSort, (a: PlacedRun, b: PlacedRun) => number> = {
  updated: (a, b) => b.touched - a.touched,
  cost: (a, b) => glanceOf(b.run).spentUsd - glanceOf(a.run).spentUsd || b.touched - a.touched,
  worked: (a, b) =>
    (glanceOf(b.run).workedMs ?? 0) - (glanceOf(a.run).workedMs ?? 0) || b.touched - a.touched,
  plan: (a, b) => a.run.slug.localeCompare(b.run.slug) || stamp(b.run.createdAt) - stamp(a.run.createdAt),
};

/** The rows in the preference's order, live rows first in every order. */
export function orderRuns(rows: readonly PlacedRun[], sort: string): PlacedRun[] {
  const compare = COMPARE[(RUNS_SORTS as readonly string[]).includes(sort) ? (sort as RunsSort) : 'updated'];
  return [...rows].sort((a, b) => Number(isLiveRun(b.run)) - Number(isLiveRun(a.run)) || compare(a, b));
}

function columnsOf(hold: FleetHoldView | null): Column<PlacedRun>[] {
  return [
    {
      id: 'plan',
      head: 'Plan',
      identity: true,
      flex: true,
      min: 160,
      card: 'title',
      filter: 'text',
      groupable: true,
      value: (t) => t.run.slug,
      sort: { id: 'plan', dir: 'ascending' },
      cell: (t) => <span className="text-body text-ink">{t.run.slug}</span>,
    },
    {
      id: 'status',
      head: 'Status',
      min: 240,
      card: 'meta',
      value: (t) => t.view.label,
      groupable: true,
      cell: (t) => {
        const note = waitNote(asRunLike(t.run) as Parameters<typeof waitNote>[0]);
        return (
          <span className="flex min-w-0 flex-col gap-0.5">
            <RunStatus
              run={asRunLike(t.run) as Parameters<typeof RunStatus>[0]['run']}
              ctx={t.ctx}
              withNote={false}
            />
            {note && <span className="text-meta text-ink-muted">{note}</span>}
          </span>
        );
      },
    },
    {
      id: 'phases',
      head: 'Phases',
      min: 180,
      value: (t) => glanceOf(t.run).done,
      cell: (t) => {
        const stations = compactTrack(glanceOf(t.run).phases);
        return stations.length ? (
          <Track label="Phases" className="min-w-0">
            {stations.map((s) => (
              <Station key={s.key} paint={s.paint} settled={s.settled} live={s.live}>
                {s.label}
              </Station>
            ))}
          </Track>
        ) : (
          <span className="text-ink-faint">—</span>
        );
      },
    },
    {
      id: 'spent',
      head: 'Spent',
      min: 96,
      align: 'end',
      value: (t) => glanceOf(t.run).spentUsd,
      sort: { id: 'cost', dir: 'descending' },
      cell: (t) => {
        const glance = glanceOf(t.run);
        return <Money usd={glance.spentUsd + glance.liveUsd} against={glance.budgetUsd} />;
      },
    },
    {
      id: 'worked',
      head: 'Worked',
      min: 96,
      align: 'end',
      value: (t) => glanceOf(t.run).workedMs ?? 0,
      sort: { id: 'worked', dir: 'descending' },
      cell: (t) => <Duration ms={glanceOf(t.run).workedMs} />,
    },
    {
      id: 'why',
      head: 'Why',
      min: 220,
      value: (t) => stopReason(t.run, hold),
      cell: (t) => <span className="text-meta text-ink-muted">{stopReason(t.run, hold)}</span>,
    },
    {
      id: 'updated',
      head: 'Updated',
      min: 110,
      card: 'meta',
      value: (t) => t.touched,
      sort: { id: 'updated', dir: 'descending' },
      cell: (t) => <RelativeTime at={t.run.updatedAt} live={false} />,
    },
    {
      id: 'id',
      head: 'Run id',
      min: 120,
      everything: true,
      value: (t) => t.run.id,
      cell: (t) => <Mono value={t.run.id} chars={12} copyable />,
    },
    {
      id: 'model',
      head: 'Model',
      min: 140,
      everything: true,
      value: (t) => glanceOf(t.run).model ?? null,
      cell: (t) => {
        const glance = glanceOf(t.run);
        return glance.model ? `${glance.model}${glance.effort ? ` at ${glance.effort}` : ''}` : '—';
      },
    },
  ];
}

export interface AllRunsProps {
  /** Every run, already cut by the closure preference. */
  rows: readonly PlacedRun[];
  everything: Everything;
  state: ConsoleState | undefined;
  allowRun: boolean;
}

export function AllRuns({ rows, everything, state, allowRun }: AllRunsProps) {
  const [prefs, setPrefs] = usePrefs();
  const hold = bindingHoldOf(state);
  const columns = useMemo(() => columnsOf(hold), [hold]);
  const ordered = useMemo(() => orderRuns(rows, prefs.runsSort), [rows, prefs.runsSort]);
  return (
    <Grid
      columns={columns}
      rows={ordered}
      getRowKey={(t) => t.key}
      label="Every run"
      tableId="runs-all"
      toolbar={false}
      everything={everything}
      virtual
      activeSort={prefs.runsSort}
      onSort={(id) => setPrefs({ runsSort: id })}
      rowHref={(t) => runHref(t.run.slug)}
      rowProps={(t) => ({ 'data-run-row': t.run.id, 'data-slug': t.run.slug })}
      detail={(t) => <RunVerbs placed={t} allowRun={allowRun} />}
      empty="No run has been recorded yet."
    />
  );
}

/**
 * The verbs a stopped run's row carries — dismiss its card or put it back
 * (the manual half of the resolver the read path applies by itself; neither
 * deletes anything), and the whole-run freeze and stop, through the one door.
 */
function RunVerbs({ placed, allowRun }: { placed: PlacedRun; allowRun: boolean }) {
  const { run } = placed;
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const settled = placed.group === 'settled' || placed.group === 'waiting';
  const frozen = run.status === 'frozen' || Boolean(run.freeze);
  const act = useCallback(
    async (what: string, call: () => Promise<unknown>, said: string) => {
      setBusy(what);
      try {
        const pressed = await press(call);
        toast(pressed.state === 'asked' ? pressed.words : said, pressed.state === 'asked' ? 'info' : 'ok');
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setBusy(null);
        void client.invalidateQueries({ queryKey: keys.runs() });
      }
    },
    [client],
  );
  if (!allowRun) return <p className="text-meta text-ink-muted">This console cannot drive runs.</p>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="all-runs-verbs">
      {settled &&
        (run.resolved ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy != null}
            onClick={() =>
              void act('unresolve', () => runsApi.runUnresolve(run.slug, run.id), 'Back on the home')
            }
            title="Count it as waiting on someone again"
          >
            Put the card back
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy != null}
            onClick={() =>
              void act(
                'resolve',
                () => runsApi.runResolve(run.slug, run.id),
                'Dismissed — it will stop asking',
              )
            }
            title="Stop counting this run as waiting on someone — nothing is deleted"
          >
            Resolve
          </Button>
        ))}
      {isLiveRun(run) && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy != null}
          onClick={() => {
            setBusy(frozen ? 'thaw' : 'freeze');
            void pressLifecycle(client, frozen ? 'thaw' : 'freeze', run.slug).finally(() => setBusy(null));
          }}
        >
          {frozen ? 'Thaw' : 'Freeze'}
        </Button>
      )}
      {isLiveRun(run) && (
        <ConfirmButton
          size="sm"
          variant="danger"
          destructive
          disabled={busy != null}
          title={`Stop ${run.slug}?`}
          description="Its sessions get SIGTERM and the run winds down. Work already committed stays committed."
          confirmLabel="Stop the run"
          onConfirm={() => {
            setBusy('stop');
            void pressLifecycle(client, 'stop', run.slug).finally(() => setBusy(null));
          }}
        >
          Stop
        </ConfirmButton>
      )}
    </div>
  );
}
