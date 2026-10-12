/**
 * Why this run started (7.0, quiet-console phase 12; the cases carried from
 * the 6.x why-started card's suite).
 *
 * Pinned: each start is one sentence — its door, what fired it, who asked —
 * newest first with the latest real start marked; the row draws exactly the
 * words `startLine` says, its ids in the machine face; a refused start names
 * its reason; the sessions started beside the run stand apart; and the start
 * door's report says what it resolved and the override a person signed.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LedgerStart, ResolvedManifest, RunLedger } from '@/data/api';
import { expectNoAxeViolations } from '@/test/axe';
import { RunWhyStarted, startLine } from './why-started';

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

const ledger = (starts: LedgerStart[], truncated = false): RunLedger => ({
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
    truncated,
  },
});

const MANIFEST = {
  decisions: [
    {
      key: 'gates',
      state: 'answered',
      source: 'plan',
      value: 'delegated',
      owner: 'operator',
      blocking: 'no',
      origin: 'plan',
    },
    {
      key: 'permission.destructive',
      state: 'outstanding',
      source: 'default',
      value: '',
      owner: 'operator',
      blocking: 'yes',
      origin: 'default',
    },
  ],
  accounts: [],
  credentials: { policy: 'require', ids: ['gh'], held: ['gh'], missing: [] },
  delivery: { ok: false, channels: [], acknowledged: true },
  probes: { accounts: { status: 'ok', reason: 'default has headroom' } },
  overridden: { rows: ['announce'], by: 'operator', at: '2026-09-15T09:59:00.000Z' },
  at: '2026-09-15T10:00:00.000Z',
} as unknown as ResolvedManifest;

const RELAUNCH = start({
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

describe('startLine', () => {
  it('says a start in one sentence: door, what fired it, and who', () => {
    expect(startLine(RELAUNCH)).toBe(
      'Resumed through converge-relaunch (fired by timer, past converge, start 2 of that door) — asked for by console over timer from local, on account default.',
    );
  });

  it('a refused start names its reason', () => {
    expect(
      startLine(
        start({ event: 'run.start-refused', door: 'converge', reason: 'the start ceiling is spent' }),
      ),
    ).toMatch(/^Refused at converge — .*; the start ceiling is spent\.$/);
  });

  it('says so when a line names no door, and adds no stop of its own to words that end in one', () => {
    expect(startLine(start({ door: null, account: null, said: 'not attributed.' }))).toBe(
      'Started through a door this line does not name — not attributed.',
    );
  });

  it('names what a session started beside the run was for', () => {
    expect(
      startLine(start({ event: 'phase.session-start', phase: 4, mode: 'review', door: 'auto-reviewer' })),
    ).toMatch(/^A review session started through auto-reviewer — /);
  });

  it('glues nothing with a middle dot', () => {
    expect(startLine(start({ reason: 'rebooted after the update' }))).not.toMatch(/·/);
  });
});

describe('<RunWhyStarted>', () => {
  it('marks the latest start and says it in one sentence; every other start keeps its row', () => {
    render(<RunWhyStarted ledger={ledger([start({}), RELAUNCH])} manifest={MANIFEST} />);
    expect(screen.getByTestId('why-started-latest').textContent).toBe(startLine(RELAUNCH));
    const rows = screen.getAllByTestId('why-started-start');
    // Newest first: the relaunch, then the first start.
    expect(rows.map((row) => row.querySelector('p')!.textContent)).toEqual([
      startLine(RELAUNCH),
      'Started through operator — asked for by operator over api from local, on account default.',
    ]);
    expect(rows[0]!.hasAttribute('data-latest')).toBe(true);
    expect(rows[1]!.hasAttribute('data-latest')).toBe(false);
    // Each row says when.
    expect(rows[0]!.querySelector('time')).not.toBeNull();
  });

  it('draws the door and the account in the machine face', () => {
    render(<RunWhyStarted ledger={ledger([RELAUNCH])} />);
    const latest = screen.getByTestId('why-started-latest');
    expect(within(latest).getByText('converge-relaunch').tagName).toBe('CODE');
    expect(within(latest).getByText('default').tagName).toBe('CODE');
  });

  it('a refusal after the latest start is listed, and never taken for it', () => {
    const refused = start({
      at: '2026-09-15T12:00:00.000Z',
      event: 'run.start-refused',
      door: 'converge',
      reason: 'the start ceiling is spent',
    });
    render(<RunWhyStarted ledger={ledger([start({}), RELAUNCH, refused])} />);
    expect(screen.getByTestId('why-started-latest').textContent).toBe(startLine(RELAUNCH));
    const rows = screen.getAllByTestId('why-started-start');
    expect(rows[0]!.getAttribute('data-event')).toBe('run.start-refused');
    expect(rows[0]!.textContent).toMatch(/the start ceiling is spent\.$/);
  });

  it('keeps the sessions started beside the run apart, each with its phase', () => {
    render(
      <RunWhyStarted
        ledger={ledger([
          start({}),
          start({
            at: '2026-09-15T10:30:00.000Z',
            event: 'phase.session-start',
            phase: 4,
            mode: 'review',
            door: 'auto-reviewer',
          }),
        ])}
      />,
    );
    const beside = screen.getByRole('list', { name: 'Sessions started beside the run' });
    expect(within(beside).getByText('P4')).toBeInTheDocument();
    expect(beside.textContent).toMatch(/A review session started through auto-reviewer/);
    expect(
      within(screen.getByRole('list', { name: 'Every start of this run' })).getAllByTestId(
        'why-started-start',
      ),
    ).toHaveLength(1);
  });

  it('carries what the operator said — the actor’s own words', () => {
    render(<RunWhyStarted ledger={ledger([start({ said: 'Start the demo plan', account: null })])} />);
    expect(screen.getByTestId('why-started-latest').textContent).toBe(
      'Started through operator — Start the demo plan.',
    );
  });

  it('a run whose journal holds no start says so; a ledger not read yet says that', () => {
    const { unmount } = render(<RunWhyStarted ledger={ledger([])} />);
    expect(screen.getByText('No start of this run is on its journal.')).toBeTruthy();
    unmount();
    render(<RunWhyStarted ledger={undefined} />);
    expect(screen.getByText('Reading the journal…')).toBeTruthy();
  });

  it('says when the journal read was cut, so an earlier start may be missing', () => {
    render(<RunWhyStarted ledger={ledger([start({})], true)} />);
    expect(screen.getByTestId('why-started-truncated').textContent).toBe(
      'The journal read was cut, so an earlier start may be missing.',
    );
  });

  it('reports what the start door resolved: the override, the decisions, the probes, the credentials and delivery', () => {
    render(<RunWhyStarted ledger={ledger([start({})])} manifest={MANIFEST} />);
    const report = screen.getByTestId('why-started-manifest');
    expect(within(report).getByRole('heading', { name: 'What the start door resolved' })).toBeInTheDocument();
    expect(within(report).getByTestId('why-started-override').textContent).toMatch(
      /^Overridden by operator: announce\.$/,
    );
    // Each decision's state is a status word through the family, never bare text.
    const table = within(report).getByRole('table', { name: 'Decisions at start' });
    const gates = within(table).getByText('gates').closest('tr')!;
    const state = gates.querySelector('[data-vocab="decision"]')!;
    expect(state.getAttribute('data-status')).toBe('answered');
    expect(within(gates).getByText('delegated')).toBeInTheDocument();
    expect(within(gates).getByText('plan')).toBeInTheDocument();
    // A probe: its name, its word, its reason.
    const probe = within(report).getByTestId('why-started-probe');
    expect(probe.getAttribute('data-vocab')).toBe('probe');
    expect(probe.getAttribute('data-status')).toBe('ok');
    expect(probe.closest('li')!.textContent).toBe('accounts OK default has headroom');
    expect(within(report).getByText('Held gh (require)')).toBeInTheDocument();
    expect(within(report).getByText('No channel, acknowledged')).toBeInTheDocument();
  });

  it('draws the door and the account in the line’s own ink — muted on an earlier start', () => {
    render(<RunWhyStarted ledger={ledger([start({}), RELAUNCH])} />);
    const [latest, earlier] = screen.getAllByTestId('why-started-start');
    expect(within(latest!).getByText('converge-relaunch').className).toContain('text-ink');
    expect(within(latest!).getByText('converge-relaunch').className).not.toContain('text-ink-muted');
    expect(within(earlier!).getByText('operator').className).toContain('text-ink-muted');
  });

  it('keeps a decision’s owner, whether it blocks the start and where it was read as Everything’s columns', () => {
    const { rerender } = render(<RunWhyStarted ledger={ledger([start({})])} manifest={MANIFEST} />);
    expect(screen.queryByRole('columnheader', { name: 'Blocks the start' })).toBeNull();
    rerender(<RunWhyStarted ledger={ledger([start({})])} manifest={MANIFEST} everything />);
    for (const head of ['Owner', 'Blocks the start', 'Read from']) {
      expect(screen.getByRole('columnheader', { name: head })).toBeInTheDocument();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <RunWhyStarted ledger={ledger([start({}), RELAUNCH])} manifest={MANIFEST} />,
    );
    await expectNoAxeViolations(container);
  });
});
