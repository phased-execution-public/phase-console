/**
 * UI preferences that outlive a reload: theme, list density, sort, filters.
 *
 * A module-level store rather than context, because the theme has to be applied
 * before React renders (see `main.tsx`) and a context cannot reach that far up.
 * The shape and the storage key are unchanged from `web/store.js`, so a browser
 * that has been using the old client keeps its settings across the cutover.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'phase-console.ui';

export type Theme = 'system' | 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  density: 'comfortable' | 'compact';
  /** How the plan list is ordered — see `views/plans/model.ts` `SORTS`. */
  sort: string;
  /** Plan list: include the documents and orphan handoffs, not only plans. */
  showDocuments: boolean;
  /**
   * Plan list: keep closed plans — complete, abandoned, superseded — in view.
   *
   * Off by default. Deliberately a NEW key rather than the old `showComplete`
   * with a flipped default: `setPrefs()` writes the whole object, so every
   * browser that has ever changed any preference already carries
   * `showComplete: true`, and a new default would have reached none of them.
   * The stale key is harmless — `load()` spreads storage over `DEFAULTS`, and
   * nothing reads it any more.
   */
  showClosed: boolean;
  /**
   * Plan list: the operator has read the "N closed plans are not listed" banner
   * and does not need it again.
   *
   * Persisted rather than component state, because a banner that returns on
   * every navigation is the one being explained away rather than read. Nothing
   * is lost by dismissing it: the counts stay on the toggles themselves
   * (`Show closed +71`) and in the line under the controls, so the compact form
   * of the same fact is always on screen. This only silences the loud one.
   */
  plansHiddenBannerOff: boolean;
  model: string;
  /** Plan list: rich cards, or the dense comparison table. */
  plansLayout: 'board' | 'table';
  /** The Runs fleet's shape — `auto` follows the viewport (resolved in
   * `features/runs/layout.ts`). */
  runsLayout: 'auto' | 'table' | 'cards';
  /** Plan list: one flat list, or sectioned by status or by repo. */
  plansGroup: 'none' | 'status' | 'repo';
  /** How Next up is ordered — see `features/now/model.ts` `RANKS`. */
  readyRank: string;
  /**
   * Ready board: one flat queue, or grouped under each plan.
   *
   * ⚠️ Read by nothing since Phase 8 absorbed `#/ready` into Now, whose Next up
   * section has one shape. Kept rather than deleted: `setPrefs()` writes the
   * whole object, so every browser that has ever changed a preference already
   * carries this key, and removing it from `Prefs` would not remove it from
   * their storage — it would only stop TypeScript describing what is there.
   */
  readyGroup: boolean;
  /**
   * Now's inbox shows acknowledged rows too.
   *
   * Persisted rather than component state because Now remounts on every
   * navigation, and an operator who turned acknowledged rows on to look for
   * one would have to turn them on again after every click.
   */
  nowShowAcked: boolean;
  /** How the fleet is ordered — see `views/runs/model.ts` `SORTS`. */
  runsSort: string;
  /** Which outcome the fleet is filtered to; empty is every outcome. */
  runsOutcome: string;
  /**
   * Fleet: keep runs of CLOSED plans in the table. Off by default — a run of a
   * complete or abandoned plan is history, not fleet — and the toolbar names
   * how many are hidden so the cut is never silent.
   */
  runsShowClosed: boolean;
  /** Fleet: one flat table, or a section per plan. */
  runsGroup: boolean;
  /**
   * Which shape the fleet section takes: the orchestration BOARD (every live
   * run in its column, with its controls) or the TABLE (every run there has
   * ever been, filtered and sorted).
   *
   * One or the other, never both: they are two readings of the same fleet, and
   * drawing them beside each other is how a page comes to say two things about
   * one run. The board is the default because it is the only one of the two
   * that can be acted on — the table answers "what has happened", the board
   * answers "what is happening, and what do I do about it" — and the board's
   * empty state points at the table when nothing is live.
   */
  runsView: 'board' | 'table';
  /**
   * Which sections of the run page's phase table are collapsed
   * (`features/runs/phase-table.tsx` `PHASE_GROUPS`).
   *
   * Persisted rather than component state for one reason: the run page
   * remounts on every navigation, and a Done section that re-opens each time
   * is a section being re-collapsed rather than read. Stored as the collapsed
   * ids, not the open ones, so a group added later opens by default.
   */
  runPhasesCollapsed: string[];
  /**
   * The same, for the PLAN page's Phases tab — deliberately its own key.
   *
   * The two lists group by the same five states and answer different
   * questions: the run page is "what is this run doing", where Done is the
   * receipts, and the plan page is "where does this plan stand", where Done is
   * most of the plan. Collapsing one has never meant collapsing the other.
   */
  planPhasesCollapsed: string[];
  /** Keep the session console open on the runs page while nothing is running. */
  runsConsole: boolean;
  /** How the sessions list is ordered — see `features/sessions/model.ts` `SORTS`. */
  sessionsSort: string;
  /**
   * Which kind the sessions list is filtered to; empty is every kind.
   *
   * A `SessionGroupKind` (`features/sessions/list.tsx`), stored as a plain
   * string for the same reason `runsOutcome` is: a value the vocabulary has
   * since stopped offering must read as "every kind" rather than as an empty
   * list, and a browser carrying a retired word cannot be migrated.
   */
  sessionsKind: string;
  /**
   * Sessions: a section per kind, or one flat list in the chosen order.
   *
   * On by default — the page has always been grouped, and the four kinds are
   * genuinely different objects (a lane the console drives, a pty it owns, a
   * `claude` it can only see). Turning it off is what makes an order over the
   * whole list mean anything.
   */
  sessionsGroup: boolean;
  /**
   * Route map: pan, wheel-zoom and pinch are live. Off by default — a locked
   * map scrolls with the page instead of swallowing the gesture — and
   * persisted per browser because the route tab unmounts on every tab switch,
   * so component state would re-lock the map on the person actually using it.
   */
  mapPanZoom: boolean;
  /**
   * Terminal font, as steps off the base (16px on a phone, 14px on a desktop)
   * — the key bar's A−/A+. Steps rather than a size, so one preference is
   * right on both kinds of screen.
   */
  terminalFontStep: number;
  /**
   * xterm's accessibility tree (a live region per row). A preference, not a
   * detection: no web API says a screen reader is in use, and the tree is not
   * free on a chatty TUI.
   */
  terminalScreenReader: boolean;
  /**
   * Render the terminal with `@xterm/addon-webgl` (DOM renderer otherwise, and
   * on any context loss). Off by default on purpose: under a CDP-driven
   * Chromium the addon painted NOTHING at devicePixelRatio ≥ 2 — every
   * retina Mac and every phone — and a blank terminal shipped live is worse
   * than a slower one. Flip it once a real retina device has shown text.
   */
  terminalWebgl: boolean;
}

// A key added here is safe for a browser carrying the old client's settings:
// `load()` spreads these under whatever was stored, so an absent key takes the
// default rather than reading `undefined`.
const DEFAULTS: Prefs = {
  theme: 'system',
  density: 'comfortable',
  sort: 'activity',
  showDocuments: false,
  showClosed: false,
  plansHiddenBannerOff: false,
  model: '',
  plansLayout: 'board',
  runsLayout: 'auto',
  plansGroup: 'none',
  readyRank: 'leverage',
  // Off: acknowledged is "seen, not cleared", and a list that shows everything
  // by default is a list where acknowledging changes nothing.
  nowShowAcked: false,
  // Grouped by PLAN by default: operators think "which plan boards next", not
  // in individual phases across plans (the flat board remains one toggle away).
  readyGroup: true,
  runsSort: 'updated',
  // Empty rather than an outcome: the fleet opens showing everything it has,
  // and a filter is something the operator turned on.
  runsOutcome: '',
  runsShowClosed: false,
  runsGroup: false,
  runsView: 'board',
  // Only `done` — the one group that is usually the longest and least read.
  runPhasesCollapsed: ['done'],
  planPhasesCollapsed: ['done'],
  runsConsole: false,
  // Most recently active first, everything live above everything ended — the
  // order the page has always shipped, now nameable.
  sessionsSort: 'activity',
  sessionsKind: '',
  sessionsGroup: true,
  mapPanZoom: false,
  terminalFontStep: 0,
  terminalScreenReader: false,
  terminalWebgl: false,
};

/** Read-only view of the shipped defaults, so a test can pin one without
 * fighting the module-level cache a sibling test already wrote through. */
export const PREF_DEFAULTS: Readonly<Prefs> = DEFAULTS;

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as Prefs;
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return state;
}

export function setPrefs(patch: Partial<Prefs>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
  if (patch.theme) applyTheme(state.theme);
  if (patch.density) applyDensity(state.density);
  for (const notify of listeners) notify();
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const value = useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => state,
    () => state,
  );
  return [value, setPrefs];
}

/**
 * The whole theme switch. `theme.css` declares every colour once with
 * `light-dark(paper, night)`, so flipping `color-scheme` — which is what these
 * three attribute states do — repaints the app. `system` is the absence of the
 * attribute.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * The density switch — the twin of `applyTheme`, and for the same reason.
 *
 * `theme.css` declares the four padding tokens once and every card, tile and
 * section stack reads them, so one attribute on the root repaints the spacing
 * of the whole app. `comfortable` is the absence of the attribute, which keeps
 * the shipped look free of a rule that has to win a specificity fight.
 *
 * Only PADDING moves. The type floor (12 px) and the tap-target minimum
 * (`--tap-min`) are contracts the phone bar tests assert, so a density that
 * bought its space out of either would be a preference that silently breaks
 * accessibility on the surface it is most useful on.
 */
export function applyDensity(density: Prefs['density']): void {
  const root = document.documentElement;
  if (density === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
}
