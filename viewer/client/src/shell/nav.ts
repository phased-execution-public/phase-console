import {
  ChartLine,
  GitBranch,
  Route,
  ScrollText,
  Settings,
  SquareTerminal,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { DESTINATIONS } from '@shared/route-meta.js';

/**
 * Where you can go, defined once — **seven places**, the same in both editions
 * (7.0, quiet-console phase 3).
 *
 * The seven are the questions an operator actually has, in the order they have
 * them; everything else in the URL space is a page one of these has absorbed,
 * a head one of them lights (`shell/routes.ts` `destinationFor`), or an overlay
 * that rides on top of whatever is on screen. Pro's two places are reached from
 * the shell rather than listed here: the Supervisor is the right panel's second
 * mode and the phone tab bar's fourth slot (`CHAT_ITEM`), and Fleet opens from
 * the instance switcher at the top of the rail.
 *
 * **Three bands, and the band is the meaning.** *The work* is what is moving
 * right now; *the record* is what it did — the tree it changed, the numbers it
 * made, the trace it left; *the console* is the machine itself. The rail draws
 * a hairline between them and the More sheet heads them.
 *
 * `guide-coverage.test.ts` scrapes this file for `id: 'x',` with `label:` on the
 * next line — one guide card per rail label, in both languages — so the two
 * lines stay consecutive.
 */

/** The bands, in order, with the heading the More sheet prints over each. */
export const BANDS = [
  { id: 'work', label: 'The work' },
  { id: 'record', label: 'The record' },
  { id: 'console', label: 'The console' },
] as const;

export type BandId = (typeof BANDS)[number]['id'];

/** The facts of `/api/state` the nav reads — a structural subset, so a test can hand it a stub. */
export interface NavState {
  allowTerminal?: boolean;
  allowAgent?: boolean;
}

export interface NavItem {
  /** A `DESTINATIONS` member — or, for `CHAT_ITEM`, a `ROUTE_HEADS` member the tab bar draws. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Which of the three groups it reads under. See `BANDS`. */
  band: BandId;
  /** What it is, shown in the More sheet and on hover. */
  note: string;
  /** Which count decorates it, if any. A `ShellCounts` key. */
  badge?: 'needsYou' | 'ready' | 'sessions';
  /**
   * A server capability this destination needs before it is worth offering.
   * The route always exists and always explains itself — what this hides is
   * the *nav entry*, because a permanent dead link is noise on every machine
   * that never turns the feature on. A list: either flag is enough.
   */
  requires?: readonly ('allowTerminal' | 'allowAgent')[];
}

export const NAV: readonly NavItem[] = [
  {
    id: 'runs',
    label: 'Runs',
    icon: Waypoints,
    band: 'work',
    note: 'What needs you, what is running, what is next — and every run there has been',
    // The one count that is a summons rather than a census: it answers "does
    // anything need me?", and it wears the attention hue for that reason.
    badge: 'needsYou',
  },
  {
    id: 'plans',
    label: 'Plans',
    icon: Route,
    band: 'work',
    note: 'Every plan in this source, and where each one is',
    badge: 'ready',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: SquareTerminal,
    band: 'work',
    note: 'Every process the console owns or sees, with its terminal',
    // Not the attention hue — a session working away is not an alarm.
    badge: 'sessions',
    requires: ['allowTerminal', 'allowAgent'],
  },
  {
    id: 'repo',
    label: 'Repo',
    icon: GitBranch,
    band: 'record',
    note: 'Branches, commits, trees and what changed in this source',
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: ChartLine,
    band: 'record',
    note: 'How long is left, what it costs, the caps, the velocity',
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: ScrollText,
    band: 'record',
    // Deliberately unbadged: a journal filling up is not a call to action.
    note: 'Every log this console writes, the journal, delivery and health',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    band: 'console',
    note: 'Essentials, appearance, automation, notifications, accounts, MCP, permissions',
  },
];

// The nav and the shared vocabulary are one list stated twice; this is where a
// third statement would go wrong first. Cheap enough to assert at module load.
if (NAV.map((item) => item.id).join() !== (DESTINATIONS as readonly string[]).join()) {
  throw new Error('shell/nav.ts and shared/route-meta.js DESTINATIONS disagree');
}


/** Every item the shell may draw: the seven, and the heads the tab bar adds. */
const DRAWN: readonly NavItem[] = [
  ...NAV,
];

function offered(item: NavItem, state: NavState | undefined): boolean {
  if (item.requires && !item.requires.some((flag) => state?.[flag] === true)) return false;
  return true;
}

/**
 * The destinations this console can actually offer — the rail's list.
 *
 * Filtered at render rather than at module scope: `NAV` is a constant, but
 * whether the server has a terminal is a fact that arrives with `/api/state`
 * and can change on a restart.
 */
export function visibleNav(state: NavState | undefined): NavItem[] {
  return NAV.filter((item) => offered(item, state));
}

/**
 * The phone tab bar, in order — its first `TAB_SLOTS` entries, then More.
 *
 * Runs leads: it is the home. In the Pro tree the fourth slot is the
 * Supervisor's (`chat`, named in a `!pro:` region ahead of Insights): the bar
 * is the first four DECLARED, so the Supervisor takes the slot and Insights
 * moves to More there, while the Free tree keeps Insights where it is.
 */
export const TAB_BAR: readonly string[] = [
  'runs',
  'plans',
  'sessions',
  'insights',
];

/** Five buttons is what a 360 px bar fits with a thumb-sized target each: four and More. */
const TAB_SLOTS = 4;

/**
 * The phone tab bar: whichever of `TAB_BAR`'s first four this console offers,
 * plus More. A gated item takes its slot with it rather than promoting the
 * next entry: a bar whose contents change between machines is worse than a
 * shorter bar.
 */
export function tabItems(state: NavState | undefined): NavItem[] {
  return TAB_BAR.slice(0, TAB_SLOTS).flatMap((id) =>
    DRAWN.filter((item) => item.id === id && offered(item, state)),
  );
}

/** Everything the tab bar does not show — the More sheet's list, in nav order. */
export function sheetItems(state: NavState | undefined): NavItem[] {
  const tabs = new Set(tabItems(state).map((item) => item.id));
  return visibleNav(state).filter((item) => !tabs.has(item.id));
}

/**
 * A list of destinations, grouped into its bands, in `BANDS` order. Takes the
 * items rather than the state so one function serves both the rail and the
 * More sheet. An empty band is dropped: a heading over nothing is a lie about
 * what is below it.
 */
export function navBands(items: readonly NavItem[]): { id: BandId; label: string; items: NavItem[] }[] {
  return BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    items: items.filter((item) => item.band === band.id),
  })).filter((band) => band.items.length > 0);
}

/** The item for a destination or a drawn head, for the header's title and the announcer. */
export function navItem(id: string | undefined): NavItem | undefined {
  return DRAWN.find((item) => item.id === id);
}
