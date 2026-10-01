import { LEGACY_PLAN_TABS, PLAN_PHASE_VIEWS, PLAN_TABS } from '@shared/route-meta.js';

/**
 * The tab ids come from `shared/route-meta.js` — the server builds notification
 * deep links from the same list — and only the *words* live here.
 *
 * A label map keyed off the frozen array (rather than its own list of tabs) is
 * what stops a tab from existing in the URL vocabulary and nowhere in the
 * interface: an id with no entry falls back to the id itself, and a client test
 * asserts every id has a real label and a real panel.
 *
 * The retired ids keep their labels. `resolveTab` still has to answer for one —
 * a bookmarked `#/plan/x/raw` renders for the instant before the redirect lands
 * — and a strip that flashed "raw" as its own missing tab would be a worse
 * answer than the tab it is about to become.
 */
export const PLAN_TAB_LABELS: Record<string, string> = {
  phases: 'Phases',
  run: 'Autopilot',
  source: 'Source',
  // retired — see LEGACY_PLAN_TABS. `route`, `qa` and `handoffs` are views of
  // the Phases tab since 6.0 (control-tower phase 23).
  route: 'Route',
  qa: 'QA',
  handoffs: 'Handoffs',
  analysis: 'Analysis',
  overview: 'Overview',
  raw: 'Raw',
};

export const TAB_IDS = PLAN_TABS as readonly string[];

export const tabLabel = (id: string): string => PLAN_TAB_LABELS[id] ?? id;

/** A retired tab id → the tab of THIS page it became, if it is one. */
export const legacyTabTarget = (id: string): string | undefined =>
  (LEGACY_PLAN_TABS as Record<string, { tab?: string; head?: string } | undefined>)[id]?.tab;

/** True for an id this page used to register and no longer does. */
export const isLegacyTab = (id: string): boolean => id in LEGACY_PLAN_TABS;

/**
 * The two detail sub-routes are not tabs — `#/plan/:slug/phase/3` is a page of
 * its own — but the tab strip still has to show *something* as current, and the
 * honest answer is the list the detail was reached from.
 */
export const DETAIL_TABS: Record<string, string> = {
  phase: 'phases',
  // A handoff is a fact about a phase, and its list is a view of the phase
  // table since 6.0 — so the strip shows the one tab that lists phases.
  handoff: 'phases',
};

export const isDetailRoute = (tab: string | undefined): tab is 'phase' | 'handoff' =>
  tab === 'phase' || tab === 'handoff';

/**
 * The tab strip's current value for any second segment, valid or not.
 *
 * A retired id resolves to what it became rather than falling back to
 * `phases`: the redirect is what actually moves the address, and for the
 * render before it lands this is the tab the reader asked for.
 */
export function resolveTab(segment: string | undefined): string {
  if (!segment) return 'phases';
  if (isDetailRoute(segment)) return DETAIL_TABS[segment];
  if (TAB_IDS.includes(segment)) return segment;
  return legacyTabTarget(segment) ?? 'phases';
}

/* ---------------- the Phases tab's four views ---------------- */

/** One view of the phase table — `PLAN_PHASE_VIEWS` in `shared/route-meta.js`. */
export type PhasesViewId = 'table' | 'map' | 'qa' | 'handoffs';

export const PHASES_VIEW_IDS = PLAN_PHASE_VIEWS as readonly PhasesViewId[];

/** The words on the view switch. The ids are the URL's; only these are ours. */
export const PHASES_VIEW_LABELS: Record<PhasesViewId, string> = {
  table: 'Table',
  map: 'Map',
  qa: 'QA',
  handoffs: 'Handoffs',
};

/**
 * Which view `?view=` asks for. Anything unknown is the table — the one view
 * that can answer every question the others ask, a column away.
 *
 * Here, beside `sourceViewOf`, for the same chunk reason: `detail.tsx` calls it
 * to build the props of a tab body, and a helper imported from that body's
 * module would make the module a static import of the page.
 */
export const phasesViewOf = (value: string | undefined): PhasesViewId =>
  (PHASES_VIEW_IDS as readonly string[]).includes(value ?? '') ? (value as PhasesViewId) : 'table';

/* ---------------- what each tab actually renders ---------------- */

/**
 * The projection groups a tab needs, keyed by the thing `TabBody` switches on
 * — so the list that decides WHAT IS FETCHED sits beside the list that decides
 * WHAT IS RENDERED. The failure mode is silent: a tab that renders a projected
 * field it did not ask for shows nothing at all, with no error anywhere.
 *
 * Every array is a module-level constant on purpose: `usePlan` puts the include
 * set in its query key, and a fresh literal per render is a fresh key per
 * render. `tabs.test.ts` walks the RENDER tree from each tab's entry component
 * and fails when a mounted component reads a field its tab did not ask for.
 *
 * ⚠️ **This table was wrong when it first shipped, and the way it was wrong is
 * the thing to remember.** It was written from each tab's OWN source, which
 * missed that `route-tab.tsx` mounts `TitleCell` (one clamped line of
 * `phase.goal`) and `FlagsCell` (a `handoff <status>` chip) out of
 * `phase-cells.tsx`, and that the Autopilot tab reaches `PhaseDetails` through
 * `phase-table.tsx` and renders the whole prose block. Both tabs asked for
 * nothing and rendered blanks. The fix was in two halves: the cheap fields the
 * board genuinely uses (`goal`, the handoff REFERENCE) moved back into the
 * board projection, and the tabs that render the expensive prose now ask for
 * it. A tab's own file is not its render tree — follow the JSX.
 *
 * - **phases** · **handoff** — the board projection. The phase table renders
 *   `title`, `goal`, `proof`, `row`, `analysis`, `blockedBy`, the QA fields,
 *   the lock and the handoff status chip; all of those are board fields. Its
 *   row detail reaches the prose through `PhaseProse`, which fetches it for
 *   itself on open (`phase-inspector.tsx`), so the table's four views cost the
 *   board and nothing more. The handoff page fetches the handoff itself from
 *   `/api/plans/<slug>/handoff/<n>` (`useHandoff`), not from this payload.
 * - **phase** — `phase-panel.tsx` renders every prose field and the handoff's
 *   Outstanding section in full.
 * - **run** — `phase-table.tsx` mounts `PhaseDetails`, which renders Goal /
 *   Read first / Files / Steps / Exit criteria / Verification / Handoff must
 *   record, and `ways-forward.tsx` quotes the handoff's Outstanding section.
 * - **source** — `source-tab.tsx` is the only reader of `detail.memory` and of
 *   every plan-level document field (`context`, `architecture`, `endToEnd`,
 *   `provenance`, `callouts`, `graph`, `sections`).
 */
export const TAB_INCLUDES: Record<string, readonly string[]> = {
  // The QA view reads `qa`, `qaMode`, `qaRounds`, `qaHeld`, `state`, `title` —
  // all board fields — and fetches a report itself from `/api/plans/<slug>/qa-report`.
  phases: [],
  handoff: [],
  phase: ['prose', 'handoffs'],
  run: ['prose', 'handoffs'],
  source: ['document', 'memory'],
};

const NO_INCLUDE: readonly string[] = [];

/** What to ask the server for, given the tab (or detail route) being shown. */
export const includesForTab = (tab: string): readonly string[] => TAB_INCLUDES[tab] ?? NO_INCLUDE;

/* ---------------- the Source tab's two readings ---------------- */

export type SourceView = 'reading' | 'raw';

/**
 * Which reading `?view=` asks for. Anything unknown is the prose one.
 *
 * Here rather than in `source-tab.tsx` because `detail.tsx` calls it to build
 * the props it hands that tab, and the tab is now `lazy()`. A one-line helper
 * imported from a lazy module is a static import OF that module: the chunk
 * quietly stops being lazy and nothing in the source says so.
 */
export const sourceViewOf = (value: string | undefined): SourceView => (value === 'raw' ? 'raw' : 'reading');
