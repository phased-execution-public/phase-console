import { LEGACY_PLAN_TABS, PLAN_PHASE_VIEWS, PLAN_RUN_VIEWS, PLAN_TABS } from '@shared/route-meta.js';

/**
 * The plan page's vocabulary (7.0, quiet-console phase 10): its three views
 * — Phases, Run, Source — and the readings of each. The ids come from
 * `shared/route-meta.js` (the server builds notification deep links from the
 * same lists); only the WORDS live here, and an id with no label falls back to
 * itself, so a view can never exist in the address and nowhere on the page.
 *
 * ⚠️ Nothing here may import a view's body: `index.tsx` calls these helpers to
 * build a body's props, and a helper imported from a lazy body's module is a
 * static import OF that module — the chunk quietly stops being lazy.
 */

export const PLAN_VIEW_LABELS: Record<string, string> = {
  phases: 'Phases',
  run: 'Run',
  source: 'Source',
  // Retired tab ids keep a word: a bookmarked `#/plan/x/raw` renders for the
  // instant before its redirect lands, and should name what it becomes.
  route: 'Map',
  qa: 'QA',
  handoffs: 'Handoffs',
  analysis: 'Analysis',
  overview: 'Overview',
  raw: 'Raw',
};

export const TAB_IDS = PLAN_TABS as readonly string[];

export const tabLabel = (id: string): string => PLAN_VIEW_LABELS[id] ?? id;

/** A retired tab id → the view of THIS page it became, if it is one. */
export const legacyTabTarget = (id: string): string | undefined =>
  (LEGACY_PLAN_TABS as Record<string, { tab?: string; head?: string } | undefined>)[id]?.tab;

/** True for an id this page used to register and no longer does. */
export const isLegacyTab = (id: string): boolean => id in LEGACY_PLAN_TABS;

/**
 * The two detail sub-routes are pages of their own — `#/plan/:slug/phase/3`,
 * `#/plan/:slug/handoff/3` — and the view navigation still marks the list they
 * were reached from: both are facts about a phase.
 */
export const DETAIL_TABS: Record<string, string> = { phase: 'phases', handoff: 'phases' };

export const isDetailRoute = (tab: string | undefined): tab is 'phase' | 'handoff' =>
  tab === 'phase' || tab === 'handoff';

/**
 * The view for any second segment, valid or not. A retired id resolves to what
 * it became — the redirect moves the address, and for the render before it
 * lands this is the view the reader asked for.
 */
export function resolveTab(segment: string | undefined): string {
  if (!segment) return 'phases';
  if (isDetailRoute(segment)) return DETAIL_TABS[segment]!;
  if (TAB_IDS.includes(segment)) return segment;
  return legacyTabTarget(segment) ?? 'phases';
}

/* ---------------- Phases: the one grid's readings, and the map ---------------- */

export type PhasesViewId = 'table' | 'map' | 'qa' | 'handoffs';

export const PHASES_VIEW_IDS = PLAN_PHASE_VIEWS as readonly PhasesViewId[];

export const PHASES_VIEW_LABELS: Record<PhasesViewId, string> = {
  table: 'Table',
  map: 'Map',
  qa: 'QA',
  handoffs: 'Handoffs',
};

/** Which reading `?view=` asks for. Anything unknown is the table — it answers every question the others ask, a column away. */
export const phasesViewOf = (value: string | undefined): PhasesViewId =>
  (PHASES_VIEW_IDS as readonly string[]).includes(value ?? '') ? (value as PhasesViewId) : 'table';

/* ---------------- Run: the live run, and every run before it ---------------- */

export type RunViewId = 'live' | 'history';

export const RUN_VIEW_IDS = PLAN_RUN_VIEWS as readonly RunViewId[];

/** Which reading of the Run view `?view=` asks for — the live run unless it says history (phase 11 draws both). */
export const runViewOf = (value: string | undefined): RunViewId => (value === 'history' ? 'history' : 'live');

/* ---------------- Source: the plan as written ---------------- */

export type SourceView = 'reading' | 'raw';

/** Which reading `?view=` asks for. Anything unknown is the prose one. */
export const sourceViewOf = (value: string | undefined): SourceView => (value === 'raw' ? 'raw' : 'reading');

/* ---------------- what each view renders ---------------- */

/**
 * The projection groups a view needs, keyed by what the page switches on — so
 * the list that decides WHAT IS FETCHED sits beside the list that decides WHAT
 * IS RENDERED. The failure is silent: a view that draws a projected field it
 * did not ask for shows nothing, with no error anywhere.
 *
 * Module-level constants on purpose: `usePlan` puts the include set in its
 * query key, and a fresh literal per render is a fresh key per render.
 * `tabs.test.ts` walks the render tree from each view's entry and fails when a
 * mounted component reads a field its view did not ask for — follow the JSX,
 * not a file's own source.
 *
 * - **phases** · **handoff** — the board projection: the grid draws `title`,
 *   `goal`, `proof`, `row`, `analysis`, `blockedBy`, the QA fields, the lock and
 *   the handoff reference; a row's prose is fetched on open by the drawer and
 *   the inspector (`PROSE_INCLUDES` below), and the handoff page asks
 *   `/api/plans/<slug>/handoff/<n>` itself.
 * - **phase** — the phase page renders every prose field and the handoff's
 *   Outstanding section.
 * - **run** — the old run page draws `PhaseDetails` through the phase grid.
 * - **source** — the only reader of `detail.memory` and every plan-level
 *   document field (`context`, `architecture`, `endToEnd`, `provenance`,
 *   `callouts`, `graph`, `sections`).
 */
export const TAB_INCLUDES: Record<string, readonly string[]> = {
  phases: [],
  handoff: [],
  phase: ['prose', 'handoffs'],
  run: ['prose', 'handoffs'],
  source: ['document', 'memory'],
};

/**
 * What a phase's drawer and its inspector fetch FOR THEMSELVES, rather than
 * making the Phases view pay for prose nobody asked to read. On the phase page
 * and the Run view the key is already warm (they ask for exactly this set).
 */
export const PROSE_INCLUDES: readonly string[] = TAB_INCLUDES.phase!;

const NO_INCLUDE: readonly string[] = [];

/** What to ask the server for, given the view (or detail route) being shown. */
export const includesForTab = (tab: string): readonly string[] => TAB_INCLUDES[tab] ?? NO_INCLUDE;
