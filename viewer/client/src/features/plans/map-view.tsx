/**
 * The Phases tab's `map` view, and the plan's own cards (control-tower phase 23).
 *
 * This was the Route tab: a health panel, the route map, a departures board of
 * every phase, the boot prompts, the board as the terminal prints it, the
 * landing card and the end-of-phase banner. The departures board is the phase
 * TABLE now — the one table both pages draw (`features/runs/phase-table.tsx`)
 * — so what is left here is the map itself (`MapView`, the one view that draws
 * the plan as a network — hand-rolled, which phase 30's spike kept over React
 * Flow, and hardened for seventy stations and more) and the cards that are
 * about the plan rather than about one phase (`PlanCards`), which the Phases
 * tab shows under every view. The health panel moved up to the tab itself.
 */

import { memo, useCallback, useMemo } from 'react';
import { Card, CardBody, CardHeader, CardTitle, CopyButton } from '@/components/ui';
import { RouteMap, type PhaseDriver } from '@/components/dag';
import { PromptCard } from '@/components/prompt-card';
import { LandingCard } from './landing-card';
import { api } from '@/lib/api';
import { isClosed } from '@/lib/closure';
import { keys } from '@/lib/queries';
import { navigate, phaseHref } from '@shared/routes.js';
import type { PlanDetail, RunState } from '@/lib/api';

/**
 * The map, drawn only when what it draws has changed.
 *
 * Memoised HERE rather than at its definition because this is the caller that
 * can hold its props still: `route`, `batches` and `budget` come from a query
 * with structural sharing, and `focus` and `onSelect` are stabilised in
 * `MapView` below. A `memo` around a component whose caller mints a new
 * `onSelect` every render is a lie that costs a comparison.
 */
const MemoRouteMap = memo(RouteMap);

/**
 * The station the map should open looking at.
 *
 * Needs-you first, then a failure, then whatever is moving, then the first
 * thing that COULD move — in that order, because they are in that order of
 * urgency and because a map of forty phases is drawn small enough that the one
 * node worth seeing was as likely to be off in a corner as anywhere.
 *
 * `null` on a plan where nothing wants anything: a map that always snapped
 * somewhere would teach the operator that the snap means nothing.
 */
export function focusPhase(detail: PlanDetail): number | null {
  const by = (...states: string[]) => detail.phases.find((p) => states.includes(p.state))?.phase ?? null;
  // `stuck` is a handoff that reads blocked — a person is being asked for.
  return by('stuck') ?? by('in-progress') ?? by('ready');
}

/**
 * The phases a run is verifying right now — its records reading `verifying`
 * and not yet ended. The board has no such word, so the map learns it here.
 */
export function verifyingPhases(run: Pick<RunState, 'phases'> | null | undefined): Set<number> {
  const set = new Set<number>();
  for (const record of Object.values(run?.phases ?? {})) {
    if (record.status === 'verifying' && !record.endedAt) set.add(record.phase);
  }
  return set;
}

export function MapView({ detail, run }: { detail: PlanDetail; run?: Pick<RunState, 'phases'> | null }) {
  const slug = detail.summary.slug;
  const focus = useMemo(() => focusPhase(detail), [detail]);
  const verifying = useMemo(() => verifyingPhases(run), [run]);

  /*
   * The two things the map draws that the ROUTE payload does not carry.
   *
   * `RouteView` is the engine's own projection and stays it — adding fields
   * there would put analysis and process facts inside the topology. Both are
   * already on `detail.phases` for the table, so they are joined by phase
   * number here and handed to the map beside the route, memoised on the phase
   * list so the SSE stream does not mint a new Map on every tick.
   */
  const critical = useMemo(() => {
    const set = new Set<number>();
    for (const phase of detail.phases) if (phase.analysis?.onCriticalPath) set.add(phase.phase);
    return set.size ? set : null;
  }, [detail.phases]);

  const drivers = useMemo(() => {
    const map = new Map<number, PhaseDriver>();
    for (const phase of detail.phases) {
      const checking = verifying.has(phase.phase);
      if (phase.live || phase.lock || checking) {
        map.set(phase.phase, {
          live: phase.live,
          lock: phase.lock,
          ...(checking ? { verifying: true } : {}),
        });
      }
    }
    return map.size ? map : null;
  }, [detail.phases, verifying]);

  // `RouteMap` is memoised above, and a new arrow every render would defeat
  // that on its own — the map is an SVG of every station and every edge, which
  // is the most expensive thing on this page to draw twice for no reason.
  const onSelect = useCallback((phase: number) => navigate(phaseHref(slug, phase)), [slug]);
  const hrefFor = useCallback((phase: number) => phaseHref(slug, phase), [slug]);

  return (
    <div className="flex flex-col gap-3">
      <MemoRouteMap
        route={detail.route}
        batches={detail.batches}
        budget={detail.summary.budget}
        focus={focus}
        /* The station the map opened on keeps a ring: a map that centred
           somewhere and then said nothing about why has moved for no reason
           the reader can see. Ring only — `focus` never dims the network. */
        selected={focus}
        critical={critical}
        drivers={drivers}
        onSelect={onSelect}
        hrefFor={hrefFor}
      />
    </div>
  );
}

/**
 * The cards about the PLAN rather than about one phase — under every view of
 * the Phases tab, because none of them is an answer only the map gives.
 */
export function PlanCards({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const closed = isClosed(detail.summary);
  const ready = detail.summary.ready;
  const lastDone = useMemo(() => {
    const done = detail.phases.filter((p) => p.state === 'done').map((p) => p.phase);
    return done.length ? Math.max(...done) : null;
  }, [detail.phases]);

  return (
    <>
      {/* `--session-plan` answers a closed plan with its CLOSED banner and "No
          sessions to plan", so the health panel's batching simply vanishes. Say
          why instead: an absent card on a plan that still shows unfinished
          phases reads as the console failing to compute one. */}
      {closed && (
        <Card>
          <CardHeader>
            <CardTitle>No sessions to plan</CardTitle>
            <span className="text-xs text-ink-faint">this plan is closed</span>
          </CardHeader>
          <CardBody className="text-sm text-ink-muted">
            {detail.summary.closedReason ? <p className="mb-1">{detail.summary.closedReason}</p> : null}
            <p>
              The engine stops batching a closed plan, so there is nothing to suggest. The phases above are
              kept in full — it is the record of where the work stopped. Reopen the plan to put its remaining
              phases back on the board.
            </p>
          </CardBody>
        </Card>
      )}
      {/* `--boot-prompt` has no closure guard of its own — it will happily write
          a full prompt for an abandoned plan's phase — so the gate has to be
          here. A card headed "Boot prompt — phase 4" with a Copy button beside
          it is the single most direct invitation this console makes; offering
          one for a plan the operator has closed is the ready board's defect
          wearing a different card. */}
      {/* ⚠️ `collapsed` is what makes these free, and it is not cosmetic.
          `PromptCard` fetches on `enabled: open`, and each prompt is an ENGINE
          SHELL-OUT server-side — so an expanded card per ready phase meant
          opening a plan with four ready phases spawned four `phase-graph.sh`
          runs before anyone had asked for a prompt, on the same page load as
          everything else. The board below already says which phases are ready;
          the prompt is what you want AFTER deciding, and one press is the whole
          cost of asking. The end-of-phase banner card below has been collapsed
          for exactly this reason since it was written. */}
      {!closed && ready.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {ready.map((phase) => (
            <PromptCard
              key={phase}
              title={`Boot prompt — phase ${phase}`}
              collapsed
              queryKey={keys.prompt(slug, phase)}
              load={() => api.prompt(slug, phase)}
            />
          ))}
        </div>
      )}

      {/* The same board, as the terminal prints it.
          It was the Analysis tab's last card and Analysis is gone; the board is
          not analysis, it is this route in the other rendering — the one you
          paste into a message or diff against `phase-graph.sh` output. Collapsed,
          because the map above is the better answer to the same question for
          anyone who is looking at a screen. */}
      {detail.boardText && (
        <Card>
          <CardHeader>
            <CardTitle>What the terminal shows</CardTitle>
            <CopyButton text={detail.boardText} label="Copy board" />
          </CardHeader>
          <details>
            <summary className="cursor-pointer px-4 py-2 text-2xs text-ink-faint">
              <code className="font-mono">phase-graph.sh {slug}</code>
            </summary>
            <pre className="m-0 max-h-96 overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
              {detail.boardText}
            </pre>
          </details>
        </Card>
      )}

      {/* The last thing a plan owes its operator. Below the board and the boot
          prompts, because it is what you reach for when there is nothing left
          to board — and open by default only once every phase is done. */}
      <LandingCard detail={detail} />

      {lastDone != null && (
        <PromptCard
          title={`End-of-phase banner — after phase ${lastDone}`}
          note="board · batching advice · each ready phase’s boot"
          collapsed
          queryKey={keys.nextPrompt(slug, lastDone)}
          load={() => api.nextPrompt(slug, lastDone)}
        />
      )}
    </>
  );
}
