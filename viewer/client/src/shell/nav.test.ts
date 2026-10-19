/**
 * The navigation is **seven destinations**, the same seven in both editions
 * (7.0, quiet-console phase 3) — and that is the whole point.
 *
 * 2.x had thirteen entries, a gate on two of them, and three lists that each
 * kept their own copy — which is how the phone once ended up unable to reach
 * Settings at all: the rail's footer held it, and the phone layout set that
 * footer to `display: none`. Nothing announced it; the links simply were not
 * there.
 *
 * So the properties worth pinning are the ones that failure would break: how
 * many destinations there are and that the shared vocabulary agrees, that the
 * phone can reach every one of them (tab bar ∪ More sheet ⊇ all of them), and
 * that exactly one is capability-gated — on EITHER flag, because Sessions
 * covers both kinds of process. A band is only worth having while it
 * partitions: every destination in exactly one, none left over, none empty.
 *
 * 7.0 renamed Debug to Logs and took Pro's two places out of the list — the
 * Supervisor is the right panel's second mode and, on a phone, the tab bar's
 * fourth slot (`CHAT_ITEM`); Fleet opens from the instance switcher.
 */

import { describe, expect, it, vi } from 'vitest';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { ConsoleState } from '@/data/api';
import {
  BANDS,
  NAV,
  TAB_BAR,
  navBands,
  navItem,
  sheetItems,
  tabItems,
  visibleNav,
} from './nav';

/**
 * The fourth tab slot (one-pool phase 14: Runs, Your turn and Plans hold the
 * first three). Sessions in the Free tree. In the Pro tree it is the
 * Supervisor's (`chat`, declared ahead of Sessions in `TAB_BAR`): taken when
 * the server offers the chat (`state.chat`), and left EMPTY when it does not —
 * a gated item takes its slot with it rather than promoting Sessions.
 */
const FOURTH: string[] = ['sessions'];
const FOURTH_WITHOUT_CHAT: string[] = ['sessions'];
/** What a server that offers the Supervisor adds to `/api/state` — nothing in the Free tree. */
const CHAT: Partial<ConsoleState> = {};
/** Heads the tab bar may draw that are not destinations — the Supervisor's page, in Pro. */
const DRAWN_HEADS: string[] = [];

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

const BOTH = { allowTerminal: true, allowAgent: true } as const;
const NEITHER = { allowTerminal: false, allowAgent: false } as const;

const ids = (state?: ConsoleState) => visibleNav(state).map((item) => item.id);
const idsOf = (items: readonly { id: string }[]) => items.map((item) => item.id);
const isDestination = (id: string) => (DESTINATIONS as readonly string[]).includes(id);

describe('the eight destinations', () => {
  it('is exactly eight, in the documented order — Runs first, the home, then Your turn — in both editions', () => {
    expect(NAV.map((item) => item.id)).toEqual([
      'runs',
      'turn',
      'plans',
      'sessions',
      'repo',
      'insights',
      'logs',
      'settings',
    ]);
  });

  it('is the same list the shared vocabulary declares', () => {
    // `route-meta.js` is imported by the server's own tests; a nav that grew an
    // eighth entry without going through that file is a destination the route
    // table has never heard of.
    expect(NAV.map((item) => item.id)).toEqual([...DESTINATIONS]);
  });

  it('refuses to load at all when it and the shared vocabulary disagree', async () => {
    // The module-load assert, shown an offender: a guard that has never failed
    // is a claim. The shared list grows a destination the nav does not draw,
    // and importing the nav must throw rather than render a rail that is
    // silently one place short.
    vi.resetModules();
    vi.doMock('@shared/route-meta.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@shared/route-meta.js')>();
      return { ...actual, DESTINATIONS: Object.freeze([...actual.DESTINATIONS, 'debug']) };
    });
    try {
      await expect(import('./nav')).rejects.toThrow(/DESTINATIONS disagree/);
    } finally {
      vi.doUnmock('@shared/route-meta.js');
      vi.resetModules();
    }
  });

  it('gives every destination a label, a note and a glyph, and no two the same label', () => {
    for (const item of NAV) {
      expect(item.label, item.id).toBeTruthy();
      // The note is what the More sheet renders under the name, so an empty one
      // is a blank line on the phone rather than a missing string somewhere.
      expect(item.note, item.id).toBeTruthy();
      expect(item.icon, item.id).toBeTruthy();
    }
    expect(new Set(NAV.map((item) => item.label)).size).toBe(NAV.length);
  });

  it('calls the record’s third place Logs — Debug is a redirect now, never a place (7.0)', () => {
    expect(navItem('logs')?.label).toBe('Logs');
    expect(NAV.map((item) => item.id)).not.toContain('debug');
    expect(NAV.map((item) => item.label)).not.toContain('Debug');
    // A redirect head is not drawn anywhere: it lights the place it lands on.
    expect(navItem('debug')).toBeUndefined();
  });

  it('badges only what a person can act on, and never the same number twice', () => {
    const badges = NAV.map((item) => item.badge).filter(Boolean);
    // `needsYou` answers "does anything need me?" — on Your turn since 8.0,
    // where it is acted on (one-pool phase 14) — and it is still ONE entry's
    // number, never two. The record stays unbadged: none of it has a number
    // that is a call to action, and a count that is never zero stops being read.
    expect(badges).toEqual(['needsYou', 'ready', 'sessions']);
    expect(navItem('turn')?.badge).toBe('needsYou');
    expect(navItem('runs')?.badge).toBeUndefined();
    for (const id of ['repo', 'insights', 'logs', 'settings']) {
      expect(navItem(id)?.badge, id).toBeUndefined();
    }
  });
});

describe('navItem — the item for a drawn id', () => {
  it('answers every destination with the nav’s own item', () => {
    for (const item of NAV) expect(navItem(item.id), item.id).toBe(item);
  });

  it('answers nothing for an id no surface draws', () => {
    expect(navItem(undefined)).toBeUndefined();
    expect(navItem('')).toBeUndefined();
    expect(navItem('now')).toBeUndefined();
    expect(navItem('nope')).toBeUndefined();
  });
});

describe('the one gate', () => {
  it('offers Sessions when the console has EITHER kind of process', () => {
    expect(ids({ ...BASE, allowTerminal: true, allowAgent: false })).toContain('sessions');
    expect(ids({ ...BASE, allowTerminal: false, allowAgent: true })).toContain('sessions');
    expect(ids({ ...BASE, ...BOTH })).toContain('sessions');
  });

  it('hides it when the console has neither — absent counts as off', () => {
    expect(ids({ ...BASE, ...NEITHER })).not.toContain('sessions');
    // An older server does not report the fields at all.
    expect(ids({ ...BASE, allowTerminal: undefined, allowAgent: undefined })).not.toContain('sessions');
    expect(ids(undefined)).not.toContain('sessions');
  });

  it('gates nothing else', () => {
    expect(ids({ ...BASE, ...NEITHER })).toEqual([
      'runs',
      'turn',
      'plans',
      'repo',
      'insights',
      'logs',
      'settings',
    ]);
  });

  it('lists the eight whatever else the server offers — the Supervisor is never a destination', () => {
    // The rail is the same eight in both editions. A server with the chat
    // changes the tab bar's fourth slot, never the list of places.
    expect(ids({ ...BASE, ...CHAT, ...BOTH })).toEqual([...DESTINATIONS]);
  });
});

describe('a phone can reach everything', () => {
  it('splits the destinations between the tab bar and the More sheet, losing none', () => {
    for (const state of [
      { ...BASE, ...BOTH },
      { ...BASE, ...NEITHER },
      { ...BASE, ...CHAT, ...BOTH },
      { ...BASE, ...CHAT, ...NEITHER },
    ]) {
      const reachable = [...idsOf(tabItems(state)), ...idsOf(sheetItems(state))];
      const label = JSON.stringify(state);
      // Every place the rail offers, reachable from a phone.
      expect(reachable.filter(isDestination).sort(), label).toEqual([...ids(state)].sort());
      // And nothing is in both, which would be two ways to the same page with
      // two different "current" markers.
      expect(new Set(reachable).size, label).toBe(reachable.length);
      // Beyond the places, only a head the tab bar is allowed to draw.
      for (const id of reachable.filter((item) => !isDestination(item))) {
        expect(DRAWN_HEADS, `${id} in ${label}`).toContain(id);
      }
    }
  });

  it('keeps the tab bar to four slots plus More — Runs, Your turn, Plans, then the fourth', () => {
    // Five buttons is what a 360 px bar fits with a thumb-sized target each.
    // Your turn is second: a push lands there (one-pool phase 14, #366).
    expect(TAB_BAR.slice(0, 3)).toEqual(['runs', 'turn', 'plans']);
    expect(idsOf(tabItems({ ...BASE, ...CHAT, ...BOTH }))).toEqual(['runs', 'turn', 'plans', ...FOURTH]);
    // The gated one takes its slot with it rather than promoting a sheet item —
    // a bar whose contents change between machines is worse than a shorter bar.
    expect(idsOf(tabItems({ ...BASE, ...CHAT, ...NEITHER }))).toEqual(
      ['runs', 'turn', 'plans', ...FOURTH].filter((id) => id !== 'sessions'),
    );
  });

  it('takes the first four DECLARED, so an entry the server does not offer leaves a gap', () => {
    // The rule the Supervisor's slot rides on: in the Pro tree a server without
    // the chat shows three tabs and More, and Sessions stays in the sheet.
    expect(idsOf(tabItems({ ...BASE, ...BOTH }))).toEqual(['runs', 'turn', 'plans', ...FOURTH_WITHOUT_CHAT]);
    expect(idsOf(sheetItems({ ...BASE, ...BOTH }))).toEqual(
      ['sessions', 'repo', 'insights', 'logs', 'settings'].filter((id) => !FOURTH_WITHOUT_CHAT.includes(id)),
    );
  });

  it('declares each tab once, and only a place or a head the bar draws', () => {
    expect(new Set(TAB_BAR).size).toBe(TAB_BAR.length);
    for (const id of TAB_BAR) {
      expect(navItem(id), id).toBeDefined();
      if (!isDestination(id)) expect(DRAWN_HEADS, id).toContain(id);
    }
  });

  it('puts the rest of the record and the console in the sheet, where 2.x lost them', () => {
    // Sessions is gated off here (no terminal, no agent), so it is in neither list.
    expect(idsOf(sheetItems({ ...BASE, ...CHAT }))).toEqual(['repo', 'insights', 'logs', 'settings']);
  });
});

describe('the three bands', () => {
  it('names them the work, the record and the console, in that order', () => {
    expect(BANDS.map((band) => band.id)).toEqual(['work', 'record', 'console']);
    expect(BANDS.map((band) => band.label)).toEqual(['The work', 'The record', 'The console']);
  });

  it('puts every destination in exactly one band, and leaves none empty', () => {
    const known = new Set(BANDS.map((band) => band.id));
    for (const item of NAV) expect(known, item.id).toContain(item.band);
    // Not a re-statement of the line above: this is the other direction — a
    // band declared and then assigned to nothing would head an empty list.
    for (const band of BANDS) {
      expect(NAV.filter((item) => item.band === band.id).length, band.id).toBeGreaterThan(0);
    }
  });

  it('reads as the meaning: what is moving, what it did, the machine itself', () => {
    const band = (id: string) => NAV.filter((item) => item.band === id).map((item) => item.id);
    expect(band('work')).toEqual(['runs', 'turn', 'plans', 'sessions']);
    // Logs sits in the record with Repo and Insights: all three answer *what happened*.
    expect(band('record')).toEqual(['repo', 'insights', 'logs']);
    expect(band('console')).toEqual(['settings']);
  });

  it('groups in BANDS order and loses nobody', () => {
    const grouped = navBands(NAV);
    expect(grouped.map((band) => band.id)).toEqual(BANDS.map((band) => band.id));
    expect(grouped.map((band) => band.label)).toEqual(BANDS.map((band) => band.label));
    expect(grouped.flatMap((band) => band.items.map((item) => item.id))).toEqual(NAV.map((item) => item.id));
  });

  it('drops a band the caller left nothing in', () => {
    // The More sheet's list on a console with no terminal and no agent: the
    // work band is empty there, and a heading over nothing is a lie about what
    // is below it.
    const sheet = sheetItems({ ...BASE, ...NEITHER });
    expect(navBands(sheet).map((band) => band.id)).toEqual(['record', 'console']);
    expect(navBands([])).toEqual([]);
  });

  it('puts the work band on the phone tab bar — Sessions yields its slot to the Supervisor — and none of the record', () => {
    // The bar is its own list (`TAB_BAR`), so the work band is asserted to be
    // IN it rather than to BE it. Four places of work and four slots: in the
    // Pro tree the Supervisor holds the fourth, and Sessions — a terminal, the
    // least of a phone's jobs — waits in More.
    const tabs = idsOf(tabItems({ ...BASE, ...CHAT, ...BOTH }));
    for (const item of NAV.filter(
      (entry) => entry.band === 'work' && (entry.id !== 'sessions' || FOURTH.includes('sessions')),
    ))
      expect(tabs, item.id).toContain(item.id);
    expect(tabs.filter((id) => navItem(id)?.band === 'record' && isDestination(id))).toEqual([]);
  });
});

