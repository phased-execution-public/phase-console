/**
 * The route under the departure line (quiet-console phase 13): the phases a
 * launch boards, each its own labelled station, with the done ones and the
 * ones after folded — never a station that is colour alone.
 */

import { describe, expect, it } from 'vitest';
import type { PhaseView } from '@/data/api';
import { routeStations } from './departure';

const phase = (n: number, state: string, more: Partial<PhaseView> = {}) =>
  ({ phase: n, title: `p${n}`, state, size: 'M', weight: 1, gated: false, ...more }) as PhaseView;

describe('the route', () => {
  it('folds the done and the after, and draws each phase it boards with its word', () => {
    const phases = [
      phase(1, 'done'),
      phase(2, 'ready'),
      phase(3, 'ready', { gated: true }),
      phase(4, 'waiting'),
    ];
    const stations = routeStations({ phases, willRun: [phases[1]!, phases[2]!] });
    expect(stations.map((s) => s.label)).toEqual(['1 done', 'P2', 'P3 gated', '1 after']);
    expect(stations.map((s) => s.paint)).toEqual(['done', 'queued', 'queued', 'queued']);
    // The folds are settled (hollow); what boards is not.
    expect(stations.map((s) => s.settled)).toEqual([true, false, false, true]);
  });

  it('says a live claim in the word of the phase it holds', () => {
    const claimed = phase(2, 'ready', {
      lock: { owner: 'someone/else', expired: false } as PhaseView['lock'],
    });
    expect(routeStations({ phases: [claimed], willRun: [claimed] }).map((s) => s.label)).toEqual([
      'P2 claimed',
    ]);
  });

  it('draws at most three boarding stations, folding the rest into one', () => {
    const phases = [1, 2, 3, 4, 5].map((n) => phase(n, 'ready'));
    const stations = routeStations({ phases, willRun: phases });
    expect(stations.map((s) => s.label)).toEqual(['P1', 'P2', '3 more']);
    expect(stations.at(-1)!.count).toBe(3);
  });

  it('draws nothing before the plan is known, and still a route when nothing is ready', () => {
    expect(routeStations({ phases: [], willRun: [] })).toEqual([]);
    const phases = [phase(1, 'done'), phase(2, 'waiting')];
    expect(routeStations({ phases, willRun: [] }).map((s) => s.label)).toEqual(['1 done', '1 after']);
  });
});
