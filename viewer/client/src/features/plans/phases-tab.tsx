/**
 * Every phase of a plan, grouped by what it wants from you.
 *
 * It used to be one flat list in plan order, which is the order a plan is
 * WRITTEN in and never the order it is read in: the phase that is blocked on a
 * person sat wherever its number put it, under thirty finished ones. The five
 * groups are `features/runs`' — the same `PHASE_GROUPS`, the same `groupRows`,
 * so "Needs you" cannot come to mean two different things on two pages — with
 * Done collapsed by default and the choice remembered.
 *
 * Three things are shared with the run page rather than rebuilt:
 *
 *   - **`PhaseDrawer`** — the same panel against the same endpoint. It fetches
 *     its own diagnosis and rulings when opened; nothing is threaded in.
 *   - **`EvidenceLine`** — claimed versus evidenced. A `done` row that nothing
 *     on disk backs is the single most useful thing this list can say, and on
 *     the plan page it was not said at all.
 *   - **`ScopeChips` / `DepsCell` / `LockChip` / `FlagsCell`** — what it
 *     touches, what it waits on, who holds it, what is unusual about it.
 *
 * A row is a CARD, not a table row: this is the phone rendering of the route
 * tab as well as the tab in its own right, and the departures board's eight
 * columns cannot all be true at 390 px.
 */

import { memo, useMemo, useState } from 'react';
import { SectionHeading } from '@/components/ui';
import { MarkdownInline, plainText } from '@/components/markdown';
import { EvidenceLine, PhaseStateChip } from '@/features/runs/phase-row';
import { PhaseDrawer } from '@/features/runs/phase-drawer';
import { groupRows } from '@/features/runs/phase-groups';
import { usePrefs } from '@/lib/prefs';
import { pad2 } from '@/lib/format';
import { phaseHref } from '@shared/routes.js';
import { cn } from '@/lib/cn';
import type { PhaseEta, PhaseView, PlanDetail } from '@/lib/api';
import { DepsCell, FlagsCell, LockChip, ScopeCell, SizeCell } from './phase-cells';
import { InspectButton, PhaseInspector } from './phase-inspector';

/**
 * One phase, with everything that decides whether it can move.
 *
 * The card is a link and the drawer is a `<details>` INSIDE it, which needs
 * saying because it looks like a mistake: the anchor covers the card's head
 * only (`::after` on the number), never the whole card, so opening the drawer
 * is not also a navigation. The old phone list stretched one anchor over
 * everything, which is why there was nowhere to put a control.
 *
 * Memoised for the same reason the cells are (`phase-cells.tsx`): the stream
 * redraws this list on news about one phase, and a card is a `MarkdownInline`,
 * a `ScopeChips`, a `DepsCell`, a `FlagsCell` and a `<details>` drawer. `phase`
 * and `slug` are both stable across such a render, so every card except the one
 * that actually changed does nothing.
 */
const PhaseCard = memo(function PhaseCard({
  slug,
  phase,
  eta,
  onInspect,
}: {
  slug: string;
  phase: PhaseView;
  /** The board's Size column carries the estimate beside the letter; so does this. */
  eta: PhaseEta | undefined;
  /** L2. Takes the number, so one callback serves every card — see the board. */
  onInspect: (phase: number) => void;
}) {
  const goal = phase.goal ? plainText(phase.goal) : (phase.row?.exitCriteria ?? '');
  return (
    <div
      className={cn(
        'relative rounded-lg border bg-surface px-(--pad-x) py-(--pad-y) transition-colors hover:border-rule-strong',
        phase.state === 'ready' ? 'border-action/45' : 'border-rule',
      )}
    >
      {/* Two columns on a phone, three above it — and the meta cluster takes a
          row of its own below the title rather than a track beside it.
          `auto` sizes that third track to its content, which is four chips:
          measured at 360 it took 221px of a 336px row, the phase number 24, and
          the `truncate` title was left 33px — `Se…` for `Setup`. The one thing
          on the row that names the phase was the only thing giving way, so that
          four chips could stay whole. Below `sm` they wrap under it instead. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <a
          href={phaseHref(slug, phase.phase)}
          className="tap-area rounded-sm font-mono text-xl text-ink-faint"
        >
          {pad2(phase.phase)}
        </a>
        <div className="min-w-0">
          {/* The clip is on the INNER span. `tap-line`'s 44px hit area is an
              `::before` whose containing block is this anchor, so `truncate`
              here — `overflow: hidden` — clipped the floor back to the drawn
              box: measured 276×23 with a 44px `::before`, and all four corners
              of the intended square missed the link. The anchor keeps its
              visible overflow; the span it wraps takes the ellipsis. */}
          <a href={phaseHref(slug, phase.phase)} className="tap-line block font-medium text-ink">
            <span className="block truncate">
              <MarkdownInline text={phase.title} />
            </span>
          </a>
          {/* Clamped by the box, not by a character count, and the whole line
              is on hover — a goal cut at 110 characters used to end mid-word
              with no way to read the rest. */}
          <span className="block truncate text-2xs text-ink-faint" title={goal}>
            {goal}
          </span>
          {/* What the phase touches — the fact that decides what may run
              beside it, same chips as the run table. */}
          {/* `<div>`, not `<span>`: three of the cells below are flex columns. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ScopeCell phase={phase} />
            {/* Unlinked: the deps are named, not navigated — the row's own
                anchors are the number and the title. */}
            <DepsCell slug={slug} phase={phase} linked={false} />
          </div>
          {/* Claimed versus evidenced. Renders nothing at all on a console
              whose server does not send `proof`, which is the honest answer:
              a tick there would be a claim this build cannot make. */}
          {phase.proof && <EvidenceLine proof={phase.proof} />}
        </div>
        <div className="col-span-2 col-start-1 flex flex-wrap items-center gap-1 sm:col-span-1 sm:col-start-3 sm:justify-end">
          {/* Pulses and links only when something is actually working the
              phase — never on the board word, which is a line in a markdown
              file. A dead phase's chip is not an anchor. */}
          <PhaseStateChip slug={slug} phase={phase.phase} state={phase.state} live={phase.live} />
          {/* The board's own Size cell, estimate and all — this list is the
              phone rendering of that board, and the one fact it used to drop
              was how long the phase has been taking. */}
          <SizeCell phase={phase} eta={eta} />
          <LockChip lock={phase.lock} compact />
          <FlagsCell slug={slug} phase={phase} linked={false} />
          {/* L2 beside L1, and the two answer different questions. The drawer
              below expands the card in place with a DIAGNOSIS — "Why is this
              not done?", its gate, its evidence, its working tree — and fetches
              only that. The `?include=prose` fields (read-first, files, steps,
              exit criteria, verification, handoff-must-record) are on neither
              the card nor the drawer, because this tab asks for the board
              projection; the sheet is the only place they appear, and it
              fetches them itself. `goal` is NOT one of them — it rides in the
              board projection and the card clamps it above. Same sheet the
              departures board opens, so the two cannot come to disagree. */}
          <InspectButton onClick={() => onInspect(phase.phase)} label={`Inspect phase ${phase.phase}`} />
        </div>
      </div>
      {/* The drawer, unchanged from the run page. It costs a `git status` and
          two script runs, so it asks for nothing until it is opened. */}
      <PhaseDrawer slug={slug} phase={phase.phase} />
    </div>
  );
});

export function PhasesTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const [prefs, setPrefs] = usePrefs();
  // The COLLAPSED ids, not the open ones — the run page's rule, for the same
  // reason: a group added later opens by default rather than hiding itself.
  const collapsed = prefs.planPhasesCollapsed ?? ['done'];
  // Grouping walks every phase and sorts each bucket. It was doing that again
  // on every keystroke into a filter, every stream tick and every prefs write —
  // the last of which is a render this component causes itself.
  const groups = useMemo(() => groupRows(detail.phases), [detail.phases]);
  // By number, re-read live: a stream tick replaces every `PhaseView`, and a
  // sheet holding the old object would keep showing pre-tick state.
  const [inspecting, setInspecting] = useState<number | null>(null);
  const inspected = inspecting == null ? null : (detail.phases.find((p) => p.phase === inspecting) ?? null);

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const shut = collapsed.includes(group.id);
        return (
          <section key={group.id}>
            <button
              type="button"
              aria-expanded={!shut}
              className="mb-1.5 flex w-full cursor-pointer items-baseline gap-2 text-left [@media(hover:none)]:min-h-(--tap-min)"
              onClick={() =>
                setPrefs({
                  planPhasesCollapsed: shut
                    ? collapsed.filter((id) => id !== group.id)
                    : [...collapsed, group.id],
                })
              }
            >
              <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">
                {shut ? '▸' : '▾'}
              </span>
              <SectionHeading as="h3" tone="ink">
                {group.label}
              </SectionHeading>
              <span className="font-mono text-2xs tabular-nums text-ink-faint">{group.rows.length}</span>
              <span className="truncate text-2xs text-ink-faint">{group.hint}</span>
            </button>
            {!shut && (
              <div className="flex flex-col gap-2">
                {group.rows.map((phase) => (
                  <PhaseCard
                    key={phase.phase}
                    slug={slug}
                    phase={phase}
                    eta={detail.eta?.perPhase.find((e) => e.phase === phase.phase)}
                    onInspect={setInspecting}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {/* One sheet for the whole list, for the same reason the board keeps one:
          a collapsed group unmounts its cards, and a sheet mounted inside one
          would vanish with it. */}
      {inspected && (
        <PhaseInspector
          slug={slug}
          phase={inspected}
          eta={detail.eta?.perPhase.find((e) => e.phase === inspected.phase)}
          open
          onOpenChange={(next) => !next && setInspecting(null)}
        />
      )}
    </div>
  );
}
