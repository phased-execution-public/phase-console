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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytes,
  clockWords,
  duration,
  elapsed,
  elapsedWords,
  etaLabel,
  etaPoint,
  etaTitle,
  formatInterval as oneFormatter,
  holderEtaText,
  homePath,
  plural,
} from './format';
import { formatInterval } from '../../../shared/interval-format.js';
import type { EtaEstimate } from './api';

const MIN = 60_000;
const HOUR = 3_600_000;

function estimate(over: Partial<EtaEstimate> = {}): EtaEstimate {
  return {
    ratePerWeight: 60,
    floorMs: 34 * MIN,
    slopeMsPerWeight: 26,
    samples: 4,
    missing: 0,
    basis: 'plan',
    remainingWeight: 120_000,
    remainingPhases: 3,
    lowMs: HOUR,
    highMs: 3 * HOUR,
    clock: 'working',
    label: '~1 h–3 h of work left',
    ...over,
  };
}

describe('etaLabel', () => {
  it('names its clock — working time, never a calendar date', () => {
    expect(etaLabel(HOUR, 3 * HOUR, 'plan')).toContain('of work left');
  });

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
    expect(etaLabel(5 * MIN, 5 * MIN, 'plan')).toBe('~5 min of work left (estimate)');
  });

  it('never renders to the second', () => {
    expect(etaLabel(90_000, 150_000, 'plan')).not.toMatch(/\ds\b/);
  });

  it('reads in the units a person would say out loud', () => {
    expect(etaLabel(20 * MIN, 40 * MIN, 'plan')).toBe('~20 min–40 min of work left (estimate)');
    expect(etaLabel(2 * HOUR, 5 * HOUR, 'plan')).toBe('~2 h–5 h of work left (estimate)');
    expect(etaLabel(90 * MIN, 90 * MIN, 'plan')).toBe('~1.5 h of work left (estimate)');
    expect(etaLabel(2 * 86_400_000, 3 * 86_400_000, 'plan')).toBe('~2.0 d–3.0 d of work left (estimate)');
  });

  it('falls back to the weakest hedge rather than none for an unknown basis', () => {
    // A server that grows a fourth basis must not silently render unhedged.
    expect(etaLabel(HOUR, HOUR, 'made-up' as never)).toContain('(rough guess)');
  });
});

describe('etaPoint', () => {
  it('names its clock and has no hedge and no "left" — a phase not started has none', () => {
    expect(etaPoint(40 * MIN)).toBe('~40 min of work');
    expect(etaPoint(40 * MIN)).not.toMatch(/left|–|\(/);
  });
});

describe('etaTitle', () => {
  it('names this plan when the evidence is this plan, as measured phases', () => {
    expect(etaTitle(estimate({ basis: 'plan', samples: 4 }))).toContain('4 measured phases of this plan');
  });

  it('says out loud that it borrowed the number', () => {
    const title = etaTitle(estimate({ basis: 'portfolio', samples: 9 }));
    expect(title).toContain('other plans');
    expect(title).toContain('this one has none yet');
  });

  it('admits outright when there is no evidence at all', () => {
    const title = etaTitle(estimate({ basis: 'heuristic', samples: 0 }));
    expect(title).toContain('no measured phase anywhere');
    expect(title).not.toContain('0 measured phases');
  });

  it('names the clock as working time, nothing parked or overnight', () => {
    expect(etaTitle(estimate())).toContain('Working time');
    expect(etaTitle(estimate())).toContain('nothing parked or overnight');
  });

  it('says how many finished phases had no usable measurement and were left out', () => {
    expect(etaTitle(estimate({ missing: 0 }))).not.toContain('left out');
    const one = etaTitle(estimate({ missing: 1 }));
    expect(one).toContain('1 finished phase had no usable measurement and was left out');
    const many = etaTitle(estimate({ missing: 3 }));
    expect(many).toContain('3 finished phases had no usable measurement and were left out');
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

describe('the interval helpers are one formatter in three registers (#28)', () => {
  it('119,000 ms renders 1:59, 1m 59s and 1m 59s — floor everywhere, never 2m', () => {
    expect(elapsed(119_000)).toBe('1:59');
    expect(elapsedWords(119_000)).toBe('1m 59s');
    expect(duration(119_000)).toBe('1m 59s');
  });

  it('each helper delegates to the shared formatter', () => {
    for (const ms of [0, 47_000, 89_600, 119_999, 12 * 60_000 + 3_000, 3_600_000 + 4 * 60_000, Number.NaN]) {
      expect(elapsed(ms)).toBe(formatInterval(ms, 'clock'));
      expect(duration(ms)).toBe(formatInterval(ms, 'table'));
      expect(elapsedWords(ms)).toBe(formatInterval(ms, 'prose'));
    }
  });
});

describe('holderEtaText — how long a queue holder has (control-tower phase 60, #63)', () => {
  it('says a holder PHASE’s remaining time as that phase’s own sentence', () => {
    expect(holderEtaText({ of: 'phase', label: '~25–50 min of work left' }, 3)).toBe(
      'P3 has ~25–50 min of work left',
    );
    expect(holderEtaText({ of: 'phase', label: '~5 min of work left' }, null)).toBe(
      'that phase has ~5 min of work left',
    );
  });

  it('never lets a whole-plan figure read as the wait', () => {
    expect(holderEtaText({ of: 'plan', label: 'plan remaining ~2–4 d of work' }, 3)).toBe(
      'plan remaining ~2–4 d of work',
    );
    // A figure written before 6.0 had no `of`, and was always the plan's.
    expect(holderEtaText({ label: '~5.5 d–11 d left' }, 3)).toBe('plan remaining ~5.5 d–11 d');
  });

  it('says nothing when nothing is known', () => {
    expect(holderEtaText(undefined, 3)).toBe('');
    expect(holderEtaText({ of: 'phase' }, 3)).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * One formatter, and every duration with its verb (control-tower phase 19, #28)
 * ------------------------------------------------------------------ */

describe('clockWords — a duration always carries the verb it measures', () => {
  it('reads a span as the verb and the stopwatch read out loud', () => {
    expect(clockWords({ verb: 'ran', ms: HOUR + 4 * MIN, tense: 'for' })).toBe('ran 1h 04m');
    expect(clockWords({ verb: 'running', ms: 12 * MIN + 3_000, tense: 'for' })).toBe('running 12m 03s');
    expect(clockWords({ verb: 'queued', ms: 47_000, tense: 'for' })).toBe('queued 47s');
  });

  it('reads a moment as the verb, a settled figure and "ago"', () => {
    expect(clockWords({ verb: 'halted', ms: 12 * MIN + 3_000, tense: 'ago' })).toBe('halted 12m 3s ago');
    expect(clockWords({ verb: 'frozen', ms: 2 * HOUR, tense: 'ago' })).toBe('frozen 2h ago');
  });

  it('keeps the verb and says "—" for an interval nobody measured, never 0', () => {
    expect(clockWords({ verb: 'ran', ms: null, tense: 'for' })).toBe('ran —');
    expect(clockWords({ verb: 'halted', ms: Number.NaN, tense: 'ago' })).toBe('halted —');
    expect(clockWords({ verb: 'waiting', ms: -5, tense: 'for' })).toBe('waiting —');
  });

  it('floors like every register — a labelled clock never reads ahead of the stopwatch', () => {
    expect(clockWords({ verb: 'running', ms: 119_999, tense: 'for' })).toBe(
      `running ${elapsedWords(119_999)}`,
    );
    expect(clockWords({ verb: 'halted', ms: 119_999, tense: 'ago' })).toBe(`halted ${duration(119_999)} ago`);
  });

  it('is the shared formatter, re-exported — lib/format holds the one door to it', () => {
    expect(oneFormatter).toBe(formatInterval);
  });
});

describe('the source holds one interval formatter and verb-carrying clocks', () => {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const SRC = here('../');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  const rel = (path: string) => relative(SRC, path).split('\\').join('/');
  const code = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');

  it('no client file but lib/format.ts imports the shared interval formatter', () => {
    const importers = files(SRC)
      .filter((path) => /interval-format(\.js)?['"]/.test(code(path)))
      .map(rel);
    expect(importers).toEqual(['lib/format.ts']);
  });

  it('the strip prints a duration only through clockWords — never a bare figure', () => {
    const tower = files(join(SRC, 'features/runs/tower'));
    expect(tower.length, 'the scan must see the strip').toBeGreaterThan(2);
    const BARE = [
      /\b(?:elapsed|elapsedWords|duration|toolTime|formatInterval|relativeTime|countdown)\(/,
      /\/\s*(?:60_?000|3_?600_?000|1000)\b/,
      /<(?:Duration|RelativeTime)\b/,
    ];
    const offenders = tower.filter((path) => BARE.some((re) => re.test(code(path)))).map(rel);
    expect(offenders).toEqual([]);
    // …and the scan can see: the strip does print its clock, through the one door.
    expect(tower.some((path) => /\bclockWords\(/.test(code(path)))).toBe(true);
  });
});
