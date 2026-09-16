/**
 * Why this run started (zero-touch phase 19): the latest start in one sentence —
 * its door, what fired it, who asked — every other start listed, and the start
 * door's report with the override a person signed.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import type { LedgerStart, ResolvedManifest, RunLedger } from '@/lib/api';
import { WhyStarted, startLine } from './why-started';

const start = (over: Partial<LedgerStart>): LedgerStart => ({
  at: '2026-09-15T10:00:00.000Z',
  event: 'run.start',
  phase: null,
  resumed: false,
  door: 'operator',
  trigger: null,
  guard: null,
  counter: null,
  by: 'operator',
  via: 'api',
  origin: 'local',
  remoteUser: null,
  account: 'default',
  mode: null,
  said: 'asked for by operator over api from local',
  reason: null,
  ...over,
});

const ledger = (starts: LedgerStart[]): RunLedger => ({
  runId: 'r1',
  starts,
  sessions: [],
  rungs: [],
  totals: {
    sessions: 0,
    sessionsUsd: 0,
    unknownCost: 0,
    turns: 0,
    ms: 0,
    rungsUsd: 0,
    spentUsd: 0,
    gapUsd: 0,
    reconciled: true,
    truncated: false,
  },
});

const MANIFEST = {
  decisions: [
    { key: 'gates', state: 'answered', source: 'plan', value: 'delegated', blocking: 'no', origin: 'plan' },
  ],
  accounts: [],
  credentials: { policy: 'require', ids: ['gh'], held: ['gh'], missing: [] },
  delivery: { ok: false, channels: [], acknowledged: true },
  probes: { accounts: { status: 'ok', reason: 'default has headroom' } },
  overridden: { rows: ['announce'], by: 'operator', at: '2026-09-15T09:59:00.000Z' },
  at: '2026-09-15T10:00:00.000Z',
} as unknown as ResolvedManifest;

describe('why this run started', () => {
  it('says the latest start in one sentence: door, what fired it, and who', () => {
    const relaunch = start({
      at: '2026-09-15T11:00:00.000Z',
      resumed: true,
      door: 'converge-relaunch',
      trigger: 'timer',
      guard: 'converge',
      counter: 2,
      by: 'console',
      via: 'timer',
      said: 'asked for by console over timer from local',
    });
    render(
      <MemoryRouterProvider initial="#/plan/demo/run">
        <WhyStarted ledger={ledger([start({}), relaunch])} manifest={MANIFEST} />
      </MemoryRouterProvider>,
    );
    expect(screen.getByTestId('why-started-latest').textContent).toBe(
      'Resumed through converge-relaunch (fired by timer, past converge, start 2 of that door) — asked for by console over timer from local · account default',
    );
    expect(
      screen.getByText(/Started through operator — asked for by operator over api from local/),
    ).toBeTruthy();
    expect(screen.getByTestId('why-started-override').textContent).toMatch(
      /Overridden by operator: announce/,
    );
    expect(screen.getByText('gates')).toBeTruthy();
    expect(screen.getByText(/accounts/)).toBeTruthy();
  });

  it('a refused start names its reason; a run whose journal holds no start says so', () => {
    expect(
      startLine(
        start({ event: 'run.start-refused', door: 'converge', reason: 'the start ceiling is spent' }),
      ),
    ).toMatch(/^Refused at converge — .* · the start ceiling is spent$/);
    render(<WhyStarted ledger={ledger([])} compact />);
    expect(screen.getByText('No start of this run is on its journal.')).toBeTruthy();
  });
});
