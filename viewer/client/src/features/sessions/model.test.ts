/**
 * The sessions list's own vocabulary — the orders, the chips, the search.
 *
 * Sessions was the last list with no controls, so these are the promises the
 * controls now make, asserted without a DOM:
 *
 *  - **a session waiting on a person is first in EVERY order**, which is the
 *    pin, and the reason the pin is not "live" (an order over the ended
 *    records is exactly what `created` is for);
 *  - **the two clocks are two questions.** `activity` reads the last thing that
 *    happened; `created` reads when the session began. A fixture where those
 *    disagree is the only kind that can tell them apart;
 *  - **the kind order is the section order.** One list owns both
 *    (`SESSION_GROUPS`), so a fifth kind cannot be first in one and last in
 *    the other;
 *  - **search reaches the directory and both ids**, because eight shells
 *    labelled `zsh` are distinguishable by nothing else.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_GROUPS, type SessionRow } from './list';
import { NO_FILTERS, SORTS, activeCount, applyFilters, isSortId, kindCounts, sortRows } from './model';

const NOW = Date.parse('2026-08-26T12:00:00Z');
const ago = (minutes: number) => NOW - minutes * 60_000;

const row = (over: Partial<SessionRow> & { key: string; kind: SessionRow['kind'] }): SessionRow => ({
  label: over.key,
  href: '#/sessions/x',
  live: true,
  ...over,
});

describe('the orders', () => {
  it('offers three, and the first one declared is what an unknown preference falls back to', () => {
    expect(SORTS.map((s) => s.id)).toEqual(['activity', 'created', 'kind']);
    expect(isSortId('activity')).toBe(true);
    expect(isSortId('whatever-a-later-build-called-it')).toBe(false);
    const rows = [row({ key: 'a', kind: 'shell', startedAt: ago(1) })];
    // A stored id this build no longer offers must not empty the list.
    expect(sortRows(rows, 'retired-order')).toHaveLength(1);
  });

  it('puts a session waiting on a person first, in every order', () => {
    const rows = [
      row({ key: 'busy', kind: 'lane', startedAt: ago(1), createdAt: ago(1) }),
      row({
        key: 'asking',
        kind: 'foreign',
        startedAt: ago(90),
        createdAt: ago(600),
        attention: { kind: 'permission' },
      }),
    ];
    for (const sort of SORTS) expect(sortRows(rows, sort.id)[0]!.key).toBe('asking');
  });

  it('reads two different clocks — the quietest is not the oldest', () => {
    const rows = [
      // Opened this morning, silent since.
      row({ key: 'old-shell', kind: 'shell', startedAt: ago(120), createdAt: ago(480) }),
      // Opened a minute ago and still printing.
      row({ key: 'new-shell', kind: 'shell', startedAt: ago(1), createdAt: ago(5) }),
    ];
    expect(sortRows(rows, 'activity').map((r) => r.key)).toEqual(['new-shell', 'old-shell']);
    expect(sortRows(rows, 'created').map((r) => r.key)).toEqual(['new-shell', 'old-shell']);
    // …and the oldest is at the bottom of `created`, which is the whole point.
    expect(sortRows(rows, 'created').at(-1)!.key).toBe('old-shell');
  });

  it('sinks what has ended below what is live, without making that the pin', () => {
    const rows = [
      row({ key: 'ended', kind: 'shell', live: false, startedAt: ago(1), createdAt: ago(2) }),
      row({ key: 'live', kind: 'shell', live: true, startedAt: ago(60), createdAt: ago(90) }),
    ];
    expect(sortRows(rows, 'activity').map((r) => r.key)).toEqual(['live', 'ended']);
    // `kind` leads with the kind, so two shells fall back to live-first too.
    expect(sortRows(rows, 'kind').map((r) => r.key)).toEqual(['live', 'ended']);
  });

  it('orders kinds the way the sections do — one list owns both', () => {
    const rows = [...SESSION_GROUPS]
      .reverse()
      .map((group) => row({ key: group.kind, kind: group.kind, startedAt: ago(1) }));
    expect(sortRows(rows, 'kind').map((r) => r.kind)).toEqual(SESSION_GROUPS.map((g) => g.kind));
  });
});

describe('the filters', () => {
  const rows = [
    row({ key: 'lane', kind: 'lane', label: 'Alpha · P3', detail: '/repo/alpha' }),
    row({ key: 'shell', kind: 'shell', label: 'zsh', detail: '/repo/beta', id: 'pty-771' }),
    row({ key: 'other', kind: 'foreign', label: 'someone', detail: '/elsewhere', sessionId: 'c0ffee' }),
  ];

  it('narrows nothing at rest', () => {
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(3);
    expect(activeCount(NO_FILTERS)).toBe(0);
  });

  it('finds a shell by the only thing that distinguishes it — its directory', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'beta' }).map((r) => r.key)).toEqual(['shell']);
  });

  it('finds a session by the pty id and by the conversation id', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'pty-771' }).map((r) => r.key)).toEqual(['shell']);
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'c0ffee' }).map((r) => r.key)).toEqual(['other']);
  });

  it('matches words in any order, so a half-remembered name still lands', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'p3 alpha' }).map((r) => r.key)).toEqual(['lane']);
  });

  it('keeps one kind, and counts as one filter set', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, kind: 'foreign' }).map((r) => r.key)).toEqual(['other']);
    expect(activeCount({ query: 'x', kind: 'lane' })).toBe(2);
  });

  it('counts every kind, including the ones with nothing in them', () => {
    const counts = kindCounts(rows);
    expect(counts).toEqual({ lane: 1, agent: 0, shell: 1, foreign: 1 });
    // Total, so a chip row can never claim more than the list holds.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });
});
