import {
  Bug,
  FileText,
  Gauge,
  GitBranch,
  LineChart,
  Play,
  Settings,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { ConsoleState } from '@/lib/api';

/**
 * Where you can go, defined once — and in 4.0 that is **eight places**.
 *
 * The 2.x nav had thirteen entries and still could not answer "does anything
 * need me?" without visiting three of them. The eight below are the questions an
 * operator actually has, in the order they have them; everything else in the
 * URL space is either a page one of these has absorbed (`#/ready` and
 * `#/pulse` became Now's Next up and Running now in Phase 8; `#/mcp` became a
 * Settings section in Phase 11) or an overlay that rides on top of whatever is
 * on screen (the palette, the help sheet, the announcements drawer).
 * `app/routes.ts` `destinationFor` is what keeps those older heads lighting the
 * right entry.
 *
 * **Three bands, and the band is the meaning.** *The work* is what is moving
 * right now; *the record* is what it did — the tree it changed, the numbers it
 * made, the trace it left; *the console* is the machine itself. The rail draws a
 * hairline between them and the More sheet heads them, because a list of eight
 * flat entries is a list you re-read every time. 4.0 adds `repo` and `debug`,
 * both to the middle band.
 *
 * `tab: true` marks the four that get a bottom-bar slot on a phone — and that is
 * exactly the WORK band, which is why the split needs no second rule. The record
 * and the console live in the More sheet, so every destination is one or two
 * taps away from anywhere.
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
  /** In the phone tab bar. */
  tab?: boolean;
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
    id: 'now',
    label: 'Now',
    icon: Gauge,
    band: 'work',
    note: 'What needs you, what is running, what is next',
    // The one count that is a call to action rather than a census. It is the
    // accent hue everywhere else in the app, for the same reason.
    badge: 'needsYou',
    tab: true,
  },
  {
    id: 'plans',
    label: 'Plans',
    icon: FileText,
    band: 'work',
    note: 'Every plan in this source, and where each one is',
    badge: 'ready',
    tab: true,
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: Play,
    band: 'work',
    note: 'Every run on this console — its status and its cost',
    // Deliberately unbadged. The approvals count is exactly what `needsYou`
    // counts, and painting one number on two entries is the "same state on
    // four surfaces" this redesign exists to end. Runs answers *what is
    // running and what did it cost*; *does anything need me* is Now's.
    tab: true,
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
    tab: true,
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
  return NAV.filter(
    (item) =>
      (!item.requires || item.requires.some((flag) => state?.[flag] === true)) &&
      (!item.requiresReach || state?.fleet?.reachable === true),
  );
}

/**
 * The phone tab bar: whichever of the four this console offers, plus More.
 *
 * Sessions is the only gated one, and it is gated here too — a tab that opens a
 * page saying "this console has no terminal and no agent" is a slot spent on
 * nothing, and the bar has four of them.
 */
export function tabItems(state: ConsoleState | undefined): NavItem[] {
  return visibleNav(state).filter((item) => item.tab);
}

/** Everything the tab bar does not show — the More sheet's list. */
export function sheetItems(state: ConsoleState | undefined): NavItem[] {
  return visibleNav(state).filter((item) => !item.tab);
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
