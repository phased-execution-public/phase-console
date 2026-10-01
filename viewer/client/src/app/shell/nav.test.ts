/**
 * The navigation is **seven destinations** (six until 4.0 added two, eight
 * until 6.0 folded Now into Runs), and that is the whole point.
 *
 * 2.x had thirteen entries, a gate on two of them, and three lists that each
 * kept their own copy — which is how the phone once ended up unable to reach
 * Settings at all: the rail's footer held it, and the phone layout set that
 * footer to `display: none`. Nothing announced it; the links simply were not
 * there.
 *
 * So the properties worth pinning are the ones that failure would break:
 * how many destinations there are, that the phone can reach every one of them
 * (tab bar ∪ More sheet = all of them), and that exactly one is capability-
 * gated — on EITHER flag, because Sessions covers both kinds of process.
 *
 * 4.0 adds `repo` and `debug` and, with them, the three BANDS the rail rules
 * between and the sheet heads. A band is only worth having while it partitions:
 * every destination in exactly one, none left over, none empty — which is what
 * the last block below pins, because a band nobody assigned is a destination
 * that silently stops rendering.
 */

import { describe, expect, it } from 'vitest';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { ConsoleState } from '@/lib/api';
import { BANDS, NAV, TAB_BAR, navBands, sheetItems, tabItems, visibleNav } from './nav';

/**
 * The fourth tab slot — Insights in the Free tree for good; in the Pro tree
 * the Supervisor's (control-tower phase 28), which then sends Insights to the
 * sheet. `CHAT` is what offers it: a server with the chat says `state.chat`.
 */
const FOURTH: string[] = ['insights'];
const CHAT: Partial<ConsoleState> = {};

const BASE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

const ids = (state?: ConsoleState) => visibleNav(state).map((item) => item.id);

describe('the seven destinations', () => {
  it('is exactly seven, in the documented order — Runs first, the home', () => {
    expect(NAV.map((item) => item.id)).toEqual([
      'runs',
      'plans',
      'sessions',
      'repo',
      'insights',
      'debug',
      'settings',
    ]);
  });

  it('is the same list the shared vocabulary declares', () => {
    // `route-meta.js` is imported by the server's own tests; a nav that grew a
    // ninth entry without going through that file is a destination the route
    // table has never heard of.
    expect(NAV.map((item) => item.id)).toEqual([...DESTINATIONS]);
  });

  it('gives every destination a label and a note', () => {
    for (const item of NAV) {
      expect(item.label, item.id).toBeTruthy();
      // The note is what the More sheet renders under the name, so an empty one
      // is a blank line on the phone rather than a missing string somewhere.
      expect(item.note, item.id).toBeTruthy();
    }
  });

  it('badges only what a person can act on, and never the same number twice', () => {
    const badges = NAV.map((item) => item.badge).filter(Boolean);
    // `needsYou` was Now's; the Tower answers "does anything need me?" since
    // 6.0, so Runs wears it — and it is still ONE entry's number, never two.
    // Repo and Debug stay unbadged: neither has a number that is a call to
    // action, and a count that is never zero stops being read.
    expect(badges).toEqual(['needsYou', 'ready', 'sessions']);
    expect(NAV.find((item) => item.id === 'runs')?.badge).toBe('needsYou');
    for (const id of ['repo', 'insights', 'debug']) {
      expect(NAV.find((item) => item.id === id)?.badge, id).toBeUndefined();
    }
  });
});

describe('the one gate', () => {
  it('offers Sessions when the console has EITHER kind of process', () => {
    expect(ids({ ...BASE, allowTerminal: true, allowAgent: false })).toContain('sessions');
    expect(ids({ ...BASE, allowTerminal: false, allowAgent: true })).toContain('sessions');
    expect(ids({ ...BASE, allowTerminal: true, allowAgent: true })).toContain('sessions');
  });

  it('hides it when the console has neither — absent counts as off', () => {
    expect(ids({ ...BASE, allowTerminal: false, allowAgent: false })).not.toContain('sessions');
    // An older server does not report the fields at all.
    expect(ids({ ...BASE, allowTerminal: undefined, allowAgent: undefined })).not.toContain('sessions');
    expect(ids(undefined)).not.toContain('sessions');
  });

  it('gates nothing else', () => {
    expect(ids({ ...BASE, allowTerminal: false, allowAgent: false })).toEqual([
      'runs',
      'plans',
      'repo',
      'insights',
      'debug',
      'settings',
    ]);
  });
});

describe('a phone can reach everything', () => {
  it('splits the destinations between the tab bar and the More sheet, losing none', () => {
    for (const state of [
      { ...BASE, allowTerminal: true, allowAgent: true },
      { ...BASE, allowTerminal: false, allowAgent: false },
    ]) {
      const reachable = [...tabItems(state), ...sheetItems(state)].map((item) => item.id);
      expect([...reachable].sort()).toEqual([...ids(state)].sort());
      // And nothing is in both, which would be two ways to the same page with
      // two different "current" markers.
      expect(new Set(reachable).size).toBe(reachable.length);
    }
  });

  it('keeps the tab bar to four slots plus More — Runs, Plans, Sessions, then the fourth', () => {
    // Five buttons is what a 390px bar fits with a thumb-sized target each.
    // The fourth is the slot Now freed (control-tower phase 21): Insights holds
    // it — the Free tree's for good, the Pro tree's until the Supervisor's own
    // head is registered ahead of it in `TAB_BAR`.
    expect(TAB_BAR.slice(0, 3)).toEqual(['runs', 'plans', 'sessions']);
    expect(tabItems({ ...BASE, ...CHAT, allowTerminal: true, allowAgent: true }).map((i) => i.id)).toEqual([
      'runs',
      'plans',
      'sessions',
      ...FOURTH,
    ]);
    // The gated one takes its slot with it rather than promoting a sheet item —
    // a bar whose contents change between machines is worse than a shorter bar.
    expect(tabItems({ ...BASE, ...CHAT, allowTerminal: false, allowAgent: false }).map((i) => i.id)).toEqual([
      'runs',
      'plans',
      ...FOURTH,
    ]);
  });

  it('takes the first four of TAB_BAR as declared, so a fifth pushes the last one into More', () => {
    // The rule the Supervisor's slot rides on: the bar is the first four
    // DECLARED, not the first four offered — so a gated entry leaves a gap
    // rather than promoting the next, and a fourth entry declared ahead of
    // Insights moves Insights to the sheet.
    expect(new Set(TAB_BAR).size).toBe(TAB_BAR.length);
    for (const id of TAB_BAR) expect(DESTINATIONS as readonly string[], id).toContain(id);
  });

  it('puts the rest of the record and the console in the sheet, where 2.x lost them', () => {
    expect(sheetItems({ ...BASE, ...CHAT }).map((item) => item.id)).toEqual(
      ['repo', 'insights', 'debug', 'settings'].filter((id) => !FOURTH.includes(id)),
    );
  });
});

describe('the three bands', () => {
  it('puts every destination in exactly one band, and leaves none empty', () => {
    const known = new Set(BANDS.map((band) => band.id));
    for (const item of NAV) expect(known, item.id).toContain(item.band);
    // Not a re-statement of the line above: this is the other direction — a
    // band declared and then assigned to nothing would head an empty list.
    for (const band of BANDS) {
      expect(NAV.filter((item) => item.band === band.id).length, band.id).toBeGreaterThan(0);
    }
  });

  it('groups in BANDS order and loses nobody', () => {
    const grouped = navBands(NAV);
    expect(grouped.map((band) => band.id)).toEqual(BANDS.map((band) => band.id));
    expect(grouped.flatMap((band) => band.items.map((item) => item.id))).toEqual(NAV.map((item) => item.id));
  });

  it('drops a band the caller left nothing in', () => {
    // The More sheet's list on a console with no terminal and no agent: the
    // work band is empty there, and a heading over nothing is a lie about what
    // is below it.
    const sheet = sheetItems({ ...BASE, allowTerminal: false, allowAgent: false });
    expect(navBands(sheet).map((band) => band.id)).toEqual(['record', 'console']);
  });

  it('puts the whole work band on the phone tab bar, and one of the record', () => {
    // 6.0 took Now out of the work band, and the slot it left went to Insights
    // (the Free tree's for good). The bar is its own list now (`TAB_BAR`), so
    // the work band is asserted to be IN it rather than to BE it.
    const state = { ...BASE, ...CHAT, allowTerminal: true, allowAgent: true };
    const tabs = tabItems(state).map((item) => item.id);
    for (const item of NAV.filter((entry) => entry.band === 'work')) expect(tabs, item.id).toContain(item.id);
    expect(tabs.filter((id) => NAV.find((item) => item.id === id)?.band === 'record')).toEqual(
      FOURTH.filter((id) => id === 'insights'),
    );
  });
});
