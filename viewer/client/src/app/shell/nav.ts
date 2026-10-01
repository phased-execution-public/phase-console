import {
  Bug,
  FileText,
  GitBranch,
  LineChart,
  Settings,
  TerminalSquare,
  TowerControl,
  type LucideIcon,
} from 'lucide-react';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { ConsoleState } from '@/lib/api';

/**
 * Where you can go, defined once — and in 6.0 that is **seven places**.
 *
 * The 2.x nav had thirteen entries and still could not answer "does anything
 * need me?" without visiting three of them. The seven below are the questions
 * an operator actually has, in the order they have them; everything else in the
 * URL space is either a page one of these has absorbed (Now's four bands are
 * the Tower's bays since 6.0 and `#/now` a redirect onto it; `#/mcp` became a
 * Settings section in Phase 11) or an overlay that rides on top of whatever is
 * on screen (the palette, the help sheet, the announcements drawer).
 * `app/routes.ts` `destinationFor` is what keeps those older heads lighting the
 * right entry.
 *
 * **Three bands, and the band is the meaning.** *The work* is what is moving
 * right now; *the record* is what it did — the tree it changed, the numbers it
 * made, the trace it left; *the console* is the machine itself. The rail draws a
 * hairline between them and the More sheet heads them, because a list of seven
 * flat entries is a list you re-read every time.
 *
 * The phone's tab bar is its own list, `TAB_BAR`: the work band, and in the
 * slot Now freed, Insights. Everything else lives in the More sheet, so every
 * destination is one or two taps away from anywhere.
 */

/**
 * The bands, in order, with the eyebrow the More sheet prints over each.
 *
 * The rail shows no labels — a hairline is enough once the order is learned, and
 * three headings in a 200px column is the chrome this redesign exists to cut.
 * The sheet does show them: on a phone the list arrives without the rail's
 * spatial memory, so the words are what make the grouping legible.
 */
export const BANDS = [
  { id: 'work', label: 'The work' },
  { id: 'record', label: 'The record' },
  { id: 'console', label: 'The console' },
] as const;

export type BandId = (typeof BANDS)[number]['id'];

export interface NavItem {
  /** A `DESTINATIONS` member — the router resolves it. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Which of the three groups it reads under. See `BANDS`. */
  band: BandId;
  /** What it is, shown in the More sheet. */
  note: string;
  /** Which count decorates it, if any. Must be a `ShellCounts` key. */
  badge?: 'needsYou' | 'ready' | 'approvals' | 'sessions';
  /**
   * A server capability this destination needs before it is worth offering.
   *
   * The route always exists and always explains itself — what this hides is the
   * *nav entry*, because a permanent dead link is noise on every machine that
   * never turns the feature on. `requires` is a list because Sessions covers
   * both kinds of process: either flag is enough to make it worth a slot.
   */
  requires?: readonly ('allowTerminal' | 'allowAgent')[];
  /**
   * Offered only while this console can reach a machine-wide supervisor
   * (`state.fleet.reachable`) — the same "no permanent dead link" rule as
   * `requires`, over a fact that arrives with `/api/state` and moves with a beat.
   */
  requiresReach?: true;
}

export const NAV: readonly NavItem[] = [
  {
    id: 'runs',
    label: 'Runs',
    // The Tower (§Architecture 5's codename), drawn as one: the home since 6.0.
    icon: TowerControl,
    band: 'work',
    note: 'What needs you, what is running, what is next — and every run there has been',
    // The one count that is a call to action rather than a census — Now's
    // until 6.0, the Tower's since it answers "does anything need me?". It is
    // the attention hue everywhere else in the app, for the same reason.
    badge: 'needsYou',
  },
  {
    id: 'plans',
    label: 'Plans',
    icon: FileText,
    band: 'work',
    note: 'Every plan in this source, and where each one is',
    badge: 'ready',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: TerminalSquare,
    band: 'work',
    note: 'Every process the console owns or sees, with its terminal',
    // Sessions outlive the tab that opened them, so "is one still running?" is
    // no longer answerable by remembering. It is not the accent hue — a session
    // working away is not an alarm.
    badge: 'sessions',
    requires: ['allowTerminal', 'allowAgent'],
  },
  {
    id: 'repo',
    label: 'Repo',
    icon: GitBranch,
    band: 'record',
    // What the work actually did to the tree. Until 4.0 this was answerable
    // only by leaving the console for a terminal, which is why a run's diff
    // was the one part of a phase nobody read.
    note: 'Branches, commits and what changed in this source',
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: LineChart,
    band: 'record',
    note: 'Velocity, cost over time against the caps, ETA, the shape of the portfolio',
  },
  {
    id: 'debug',
    label: 'Debug',
    icon: Bug,
    band: 'record',
    // Deliberately unbadged, and deliberately not amber. A journal filling up
    // is not a call to action — it is where you go when something already went
    // wrong, and a permanent count on it would make it noise on every machine.
    note: 'Logs, journals and diagnostics — what the console saw',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    band: 'console',
    note: 'Essentials, automation, notifications, accounts, MCP, permissions',
  },
];

// The nav and the shared vocabulary are one list stated twice; this is where a
// third statement would go wrong first. Cheap enough to assert at module load.
if (NAV.map((item) => item.id).join() !== (DESTINATIONS as readonly string[]).join()) {
  throw new Error('app/shell/nav.ts and shared/route-meta.js DESTINATIONS disagree');
}

/**
 * The destinations this console can actually offer.
 *
 * Filtered at render rather than at module scope: `NAV` is a constant, but
 * whether the server has a terminal is a fact that arrives with `/api/state`
 * and can change on a restart.
 */
export function visibleNav(state: ConsoleState | undefined): NavItem[] {
  return NAV.filter((item) => offered(item, state));
}

function offered(item: NavItem, state: ConsoleState | undefined): boolean {
  if (item.requires && !item.requires.some((flag) => state?.[flag] === true)) return false;
  if (item.requiresReach && state?.fleet?.reachable !== true) return false;
  return true;
}

/**
 * The phone tab bar, in order — its first `TAB_SLOTS` entries, then More.
 *
 * Runs leads: it is the home since 6.0, and the slot Now held went to the one
 * destination of the record a phone reaches for, Insights. In the Pro tree that
 * fourth slot is the Supervisor's (§Architecture 8, control-tower phase 28) —
 * `#/chat`, named below in a `!pro:` region ahead of Insights: the bar is the
 * first four DECLARED, so the Supervisor takes the slot and Insights moves to
 * More there, while the Free tree keeps Insights where it is.
 */
export const TAB_BAR: readonly string[] = [
  'runs',
  'plans',
  'sessions',
  'insights',
];

/** Five buttons is what a 390px bar fits with a thumb-sized target each: four and More. */
const TAB_SLOTS = 4;

/**
 * The phone tab bar: whichever of `TAB_BAR`'s first four this console offers,
 * plus More.
 *
 * Sessions is the only gated one, and it is gated here too — a tab that opens a
 * page saying "this console has no terminal and no agent" is a slot spent on
 * nothing. It takes its slot with it rather than promoting the next entry: the
 * four are cut from the list as DECLARED, before anything is filtered out, and
 * a bar whose contents change between machines is worse than a shorter bar.
 */
export function tabItems(state: ConsoleState | undefined): NavItem[] {
  const offered = visibleNav(state);
  return TAB_BAR.slice(0, TAB_SLOTS).flatMap((id) => offered.filter((item) => item.id === id));
}

/** Everything the tab bar does not show — the More sheet's list, in nav order. */
export function sheetItems(state: ConsoleState | undefined): NavItem[] {
  const tabs = new Set(tabItems(state).map((item) => item.id));
  return visibleNav(state).filter((item) => !tabs.has(item.id));
}

/**
 * A list of destinations, grouped into its bands, in `BANDS` order.
 *
 * Takes the items rather than the state so one function serves both the rail
 * (everything) and the More sheet (whatever the tab bar left) — the grouping is
 * the same idea in both places, and a second copy of it is where the two would
 * drift. An empty band is dropped: on a console with no terminal and no agent
 * the sheet holds no work items at all, and a heading over nothing is a lie
 * about what is below it.
 */
export function navBands(items: readonly NavItem[]): { id: BandId; label: string; items: NavItem[] }[] {
  return BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    items: items.filter((item) => item.band === band.id),
  })).filter((band) => band.items.length > 0);
}
