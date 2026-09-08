/**
 * How an estimate reads, and the two clocks a feature file kept re-declaring.
 *
 * The arithmetic is the server's and is tested there. What is pinned here is the
 * half that is easy to get wrong and impossible to notice: the HEDGE. Five
 * surfaces render the same estimate, and a plan that has never run borrows a
 * number from other plans or falls back to a constant — so the difference
 * between "we measured this" and "we guessed this" exists only in these words.
 * Drop the suffix and the console states a guess as a measurement.
 *
 * The `elapsedWords` and `plural` cases at the foot hold the call shapes two
 * local copies were covering (`components/pulse.tsx`'s `fmtElapsed`,
 * `features/plans/model.ts`'s two-argument `plural`), so those can be deleted
 * against a test rather than against a reading.
 */

import { describe, expect, it } from 'vitest';
import { bytes, elapsed, elapsedWords, etaLabel, etaPoint, etaTitle, homePath, plural } from './format';
import type { EtaEstimate } from './api';

const MIN = 60_000;
const HOUR = 3_600_000;

function estimate(over: Partial<EtaEstimate> = {}): EtaEstimate {
  return {
    ratePerWeight: 60,
    samples: 4,
    basis: 'plan',
    remainingWeight: 120_000,
    remainingPhases: 3,
    lowMs: HOUR,
    highMs: 3 * HOUR,
    label: '~1 h–3 h left',
    ...over,
  };
}

describe('etaLabel', () => {
  it('says where the number came from, every time', () => {
    expect(etaLabel(HOUR, 3 * HOUR, 'plan')).toContain('(estimate)');
    expect(etaLabel(HOUR, 3 * HOUR, 'portfolio')).toContain('(from other plans)');
    expect(etaLabel(HOUR, 3 * HOUR, 'heuristic')).toContain('(rough guess)');
  });

  it('hedges even its strongest reading', () => {
    // The best evidence available is still a model's throughput on work nobody
    // has looked at yet. There is no basis that renders bare.
    for (const basis of ['plan', 'portfolio', 'heuristic'] as const) {
      expect(etaLabel(HOUR, 3 * HOUR, basis)).toMatch(/\(.+\)$/);
    }
  });

  it('prints a collapsed range once rather than as a repeated bound', () => {
    expect(etaLabel(5 * MIN, 5 * MIN, 'plan')).toBe('~5 min (estimate)');
  });

  it('never renders to the second', () => {
    expect(etaLabel(90_000, 150_000, 'plan')).not.toMatch(/\ds\b/);
  });

  it('reads in the units a person would say out loud', () => {
    expect(etaLabel(20 * MIN, 40 * MIN, 'plan')).toBe('~20 min–40 min (estimate)');
    expect(etaLabel(2 * HOUR, 5 * HOUR, 'plan')).toBe('~2 h–5 h (estimate)');
    expect(etaLabel(90 * MIN, 90 * MIN, 'plan')).toBe('~1.5 h (estimate)');
    expect(etaLabel(2 * 86_400_000, 3 * 86_400_000, 'plan')).toBe('~2.0 d–3.0 d (estimate)');
  });

  it('falls back to the weakest hedge rather than none for an unknown basis', () => {
    // A server that grows a fourth basis must not silently render unhedged.
    expect(etaLabel(HOUR, HOUR, 'made-up' as never)).toContain('(rough guess)');
  });
});

describe('etaPoint', () => {
  it('is a point with no hedge and no "left" — a phase not started has none', () => {
    expect(etaPoint(40 * MIN)).toBe('~40 min');
    expect(etaPoint(40 * MIN)).not.toMatch(/left|–|\(/);
  });
});

describe('etaTitle', () => {
  it('names this plan when the evidence is this plan', () => {
    expect(etaTitle(estimate({ basis: 'plan', samples: 4 }))).toContain('4 finished phases of this plan');
  });

  it('says out loud that it borrowed the number', () => {
    const title = etaTitle(estimate({ basis: 'portfolio', samples: 9 }));
    expect(title).toContain('other plans');
    expect(title).toContain('this one has none yet');
  });

  it('admits outright when there is no evidence at all', () => {
    const title = etaTitle(estimate({ basis: 'heuristic', samples: 0 }));
    expect(title).toContain('no finished phase anywhere');
    expect(title).not.toContain('0 finished phases');
  });
});

/**
 * Two figures the branch probe hands the page, and the one thing each must not
 * do: invent a measurement it does not have, and put a username in a screenshot.
 */
describe('bytes', () => {
  it('says a disk figure the way a disk tool does', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(900)).toBe('900 B');
    expect(bytes(1024)).toBe('1.0 KB');
    expect(bytes(412 * 1024 * 1024)).toBe('412 MB');
    expect(bytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('answers ABSENT for an unmeasured tree, which is not the same as empty', () => {
    // `du` reports nothing for a tree it could not walk. Folding that to `0 B`
    // would render a guess as a measurement — the failure the whole probe is
    // written to avoid.
    expect(bytes(undefined)).toBeUndefined();
    expect(bytes(null)).toBeUndefined();
    expect(bytes(Number.NaN)).toBeUndefined();
    expect(bytes(-1)).toBeUndefined();
    expect(bytes(0)).not.toBeUndefined();
  });
});

describe('homePath', () => {
  it('shortens a path under $HOME and leaves every other one alone', () => {
    // `/home/…` rather than the macOS spelling: this repository is public and
    // its scrub gate refuses that prefix outright, because a fixture is the
    // easiest place for a real machine's path to arrive by copy-paste.
    // `homePath` is a prefix comparison with no opinion about either
    // platform's home root, so the assertions are the same either way.
    expect(homePath('/home/a/work/repo', '/home/a')).toBe('~/work/repo');
    expect(homePath('/home/a', '/home/a')).toBe('~');
    expect(homePath('/tmp/scratch', '/home/a')).toBe('/tmp/scratch');
    expect(homePath('/home/ab/work', '/home/a')).toBe('/home/ab/work');
    expect(homePath('/home/a/work', undefined)).toBe('/home/a/work');
    expect(homePath(undefined, '/home/a')).toBeUndefined();
  });
});

describe('elapsedWords', () => {
  it('reads a stopwatch out in units, where `elapsed` reads it as a clock', () => {
    expect(elapsedWords(47_000)).toBe('47s');
    expect(elapsedWords(12 * MIN + 3_000)).toBe('12m 03s');
    expect(elapsedWords(HOUR + 4 * MIN)).toBe('1h 04m');
    // The same interval, in the register a card wants rather than a sentence.
    expect(elapsed(12 * MIN + 3_000)).toBe('12:03');
  });

  it('keeps seconds below the hour — a running figure that only moves once a minute looks stuck', () => {
    expect(elapsedWords(59_000)).toBe('59s');
    expect(elapsedWords(60_000)).toBe('1m 00s');
  });

  it('is the em-dash for an interval nobody measured, never 0', () => {
    // `elapsed` answers `0:00` on purpose — it is a clock, and a clock reads
    // zero. A phrase in a sentence must not claim a phase ran for no time.
    expect(elapsedWords(NaN)).toBe('—');
    expect(elapsedWords(-1)).toBe('—');
    expect(elapsedWords(Infinity)).toBe('—');
  });
});

describe('plural', () => {
  it('covers the two-argument shape features keep re-declaring locally', () => {
    expect(plural(1, 'phase')).toBe('1 phase');
    expect(plural(0, 'phase')).toBe('0 phases');
    expect(plural(3, 'phase')).toBe('3 phases');
  });

  it('takes the irregular plural where English has one', () => {
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(4, 'entry', 'entries')).toBe('4 entries');
  });
});
