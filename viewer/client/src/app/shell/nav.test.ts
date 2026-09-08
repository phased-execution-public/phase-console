/**
 * The navigation is **eight destinations**, and that is the whole point.
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
import { BANDS, NAV, navBands, sheetItems, tabItems, visibleNav } from './nav';

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

describe('the eight destinations', () => {
  it('is exactly eight, in the documented order', () => {
    expect(NAV.map((item) => item.id)).toEqual([
      'now',
      'plans',
      'runs',
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
    // `needsYou` is Now's and nothing else's; Runs is deliberately unbadged,
    // because its approvals count IS `needsYou` and one number on two entries
    // is the duplication this redesign exists to end. Repo and Debug are
    // unbadged for a different reason: neither has a number that is a call to
    // action, and a count that is never zero stops being read.
    expect(badges).toEqual(['needsYou', 'ready', 'sessions']);
    for (const id of ['runs', 'repo', 'debug']) {
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
      'now',
      'plans',
      'runs',
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

  it('keeps the tab bar to four slots plus More', () => {
    // Five buttons is what a 390px bar fits with a thumb-sized target each.
    expect(tabItems({ ...BASE, allowTerminal: true, allowAgent: true })).toHaveLength(4);
    // The gated one takes its slot with it rather than promoting a sheet item —
    // a bar whose contents change between machines is worse than a shorter bar.
    expect(tabItems({ ...BASE, allowTerminal: false, allowAgent: false }).map((i) => i.id)).toEqual([
      'now',
      'plans',
      'runs',
    ]);
  });

  it('puts the record and the console in the sheet, where 2.x lost them', () => {
    expect(sheetItems(BASE).map((item) => item.id)).toEqual(['repo', 'insights', 'debug', 'settings']);
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

  it('is the phone tab bar, exactly — the work band and nothing else', () => {
    // The bar and the band are one idea stated twice, which is the shape that
    // drifts. If a fifth work destination ever arrives, the four-slot bar and
    // this assertion have to be reconciled deliberately.
    const state = { ...BASE, allowTerminal: true, allowAgent: true };
    expect(tabItems(state).map((item) => item.id)).toEqual(
      NAV.filter((item) => item.band === 'work').map((item) => item.id),
    );
  });
});
