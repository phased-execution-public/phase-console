/**
 * The server's answers to Insights' two diagnostics questions, as the tests
 * serve them: `GET /api/sizing` and `GET /api/report`, each in the shape the
 * server sends (`server/analysis/sizing-model.ts`, `report-view.ts`).
 *
 * One copy for the panel, page and ledger tests alike, so a figure a test
 * looks for is the figure every other test serves. Types only from `@/data/`:
 * a test mocks `@/data/http`, and a value import from here would reach it.
 */

import type { SessionSizing, WeekReportAnswer } from '@/data/runs';

/** A console that has measured its phase sessions' turns, not yet their dollars. */
export function sizingAnswer(): SessionSizing {
  const shipped = {
    modes: {
      phase: {
        turns: {
          value: 490,
          source: 'measured',
          basis: 'p99 322 turns + 50 % — 321 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
        },
        usd: {
          value: 120,
          source: 'measured',
          basis: 'p99 $77.81 + 50 % — 274 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
        },
      },
      resume: {
        turns: {
          value: 120,
          source: 'measured',
          basis: 'p99 74 turns + 50 % — 27 resume sessions, 2026-09-18 → 2026-09-25 (shipped)',
        },
      },
    },
    derivedAt: null,
  };
  const ownTurns = {
    value: 510,
    source: 'measured',
    basis: 'p99 337 turns + 50 % — 44 phase sessions on this console, 2026-09-28 → 2026-10-11',
  };
  return {
    derivedAt: '2026-10-11T09:00:00.000Z',
    caps: {
      measured: {
        modes: {
          phase: { turns: ownTurns },
          closeout: {
            turns: {
              ...ownTurns,
              value: 70,
              basis: 'p99 46 turns + 50 % — 22 closeout sessions on this console',
            },
          },
        },
        derivedAt: '2026-10-11T09:00:00.000Z',
      },
      shipped,
      phase: { turns: ownTurns, usd: shipped.modes.phase.usd },
    },
    context: {
      basis: 'measured',
      boot: 31_000,
      bootMeasured: { tokens: 31_000, samples: 120, min: 24_000, max: 40_000 },
      work: 22_000,
      floor: 53_000,
      slope: 0.42,
      samples: 120,
      sizes: [{ size: 'M', weight: 160_000, medianPeak: 118_000, samples: 61, ratio: 0.98 }],
    },
    bootLine:
      'Boot floor: 31K per session — the first call’s context on this repository, measured over 120 sessions (24K–40K)',
    sessions: {
      S: { noWrap: 1.05, wraps: 2.1, wrapRate: 0.05, expected: 1.1, phases: 14, basis: 'measured' },
      M: { noWrap: 1.2, wraps: 2.4, wrapRate: 0.25, expected: 1.5, phases: 31, basis: 'measured' },
      L: { noWrap: 1.5, wraps: 3, wrapRate: 0.4, expected: 2.1, phases: 0, basis: 'shipped' },
    },
  };
}

/** One week read from the journals: a target met, one missed, one with nothing to judge. */
export function weekAnswer(over: { replay?: string[]; cached?: boolean } = {}): WeekReportAnswer {
  const score = { n: 40, male: 0.62, within2: 0.71, medianRatio: 1.1, over2: 4, under2: 7 };
  return {
    report: {
      instance: 'repo',
      since: '2026-10-04T09:00:00.000Z',
      until: '2026-10-11T09:00:00.000Z',
      replay: over.replay ?? [],
      metrics: {
        down: {
          runs: [],
          lifeHours: 140,
          downHours: 21,
          share: 0.15,
          endedBy: { person: 12.5, console: 6, 'wait-clock': 2, open: 0.5 },
        },
        avoidable: { hours: 3.25, byCause: { streak: 2, 'lint-crash': 1, 'credential-latch': 0.25 } },
        streakHalts: {
          total: 4,
          flagged: 1,
          byCause: { 'rescued-command': 1, 'repeated-phase': 0, 'wait-budget': 0 },
        },
        verifyFailed: { halts: 6, fromRescued: 2 },
        spend: {
          sessions: 88,
          bookedUsd: 412.5,
          finalUsd: 410.25,
          phantomUsd: 2.25,
          phantomShare: 0.005,
          mismatched: 3,
        },
        queue: {
          episodes: 9,
          episodeHours: 4.5,
          recordedHours: 4.5,
          recordedShare: 1,
          ownRunHours: 0,
          ownRunShare: 0,
          serialHours: 1.25,
        },
        holderEta: {
          waits: 7,
          medianRealisedOverLabel: 1.3,
          errorAtMedian: 1.3,
          medianLowOverRealised: 0.8,
          lowCoverage: 0.57,
          bandCoverage: 0.43,
        },
        phaseEta: { records: 40, estimator: null, baseline: score, ships: null },
        stallsOnFinished: { count: 0, bySignal: {} },
        closeoutCapResumes: { maxTurnsEndings: 5, underCloseoutCap: 0 },
        unrunVerification: { count: 1, phases: [{ slug: 'alpha', run: 'r1', phase: 3 }] },
        modelNamed: { starts: 50, differs: 2 },
        context: {
          sessions: 88,
          calls: 9_400,
          cacheReadMTokens: 610.5,
          meanContextK: 65,
          bootShare: 0.48,
          bootMeasured: 70,
        },
      },
      targets: [
        {
          id: 'streak',
          target:
            'no streak halt from a rescued command, a repeated ending of one phase or a wait-budget refusal',
          value: '1 of 4 halts; 2 verify-failed from a rescued command',
          met: false,
        },
        {
          id: 'own-run',
          target: 'no own-run lane wait reported as contention',
          value: '0 % of queued time (0 h)',
          met: true,
        },
        {
          id: 'phase-eta',
          target: 'phase ETA: within-2x share at or above the naive baseline, MALE at or below it',
          value: 'not journalled; the baseline scores within 2x 71 %, MALE 0.62 — pass --replay',
          met: null,
        },
      ],
    },
    readAt: '2026-10-11T09:00:00.000Z',
    cached: over.cached ?? false,
  };
}
