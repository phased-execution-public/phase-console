/**
 * One phase's boardings, side by side (7.0, quiet-console phase 12) — every
 * case of the 6.x comparison drawer's suite. The sheet's whole reason to exist
 * is the sentence "attempt 2 differed from attempt 1 in exactly these ways", so
 * the tests are about the ways it can quietly lie:
 *
 *   A-1 the facts, side by side: each attempt's window, how long it took, its
 *       outcome, model, spend and rungs, the verdict and the tree it ran on;
 *   A-2 a figure never recorded reads "not recorded", never `$0.00`, and no
 *       delta is reported between a number and an absence;
 *   A-3 every command that flipped, by command, with both exit codes — and a
 *       plain line when none did;
 *   A-4 it opens on the NEWEST pair, and the reader can step back;
 *   A-5 one boarding says what it did; none says so; the phase is a link away;
 *       a closed sheet draws nothing.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

// The sheet's one read meets the one http door under `data/`.
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, request: (path: string) => request(path) };
});

import type { AttemptComparison, AttemptSummary, PhaseAttempts } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { phaseHref } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import { RunAttempts } from './attempts';

const MIN = 60_000;

function attempt(over: Partial<AttemptSummary> & { attempt: number }): AttemptSummary {
  return {
    phase: 9,
    startedAt: '2026-08-24T10:00:00.000Z',
    endedAt: '2026-08-24T10:10:00.000Z',
    durationMs: 10 * MIN,
    outcome: 'failed',
    model: 'claude-sonnet-5',
    effort: null,
    costUsd: 1,
    turns: 20,
    sessions: 1,
    rungs: [],
    verification: null,
    said: null,
    ...over,
  };
}

function comparison(over: Partial<AttemptComparison> = {}): AttemptComparison {
  return {
    phase: 9,
    from: 1,
    to: 2,
    outcome: { from: 'failed', to: 'done', changed: true },
    model: { from: 'claude-sonnet-5', to: 'claude-opus-5', changed: true },
    verification: { from: false, to: true, flips: [], unchanged: 2 },
    rungs: { from: [], to: ['escalate'] },
    durationMs: { from: 10 * MIN, to: 14 * MIN, deltaMs: 4 * MIN },
    costUsd: { from: 0.75, to: 2.5, deltaUsd: 1.75 },
    turns: { from: 30, to: 50 },
    ...over,
  };
}

let answer: PhaseAttempts;
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (/^\/api\/run\/demo\/attempts\/9/.test(path)) return answer;
    throw new Error(`unexpected read: ${path}`);
  });
});

const open = (over: Partial<PhaseAttempts>) => {
  answer = { runId: 'r1', attempts: [], comparisons: [], ...over };
};

function mount(phase: number | null = 9) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunAttempts slug="demo" phase={phase} onClose={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The sheet, once its read has answered. */
const sheet = async () => {
  const found = await screen.findByTestId('run-attempts');
  await waitFor(() => expect(within(found).queryByRole('status')).toBeNull());
  return found;
};

/** A fact's row, found by its own header — never by a value that repeats. */
const row = (label: string): HTMLElement => screen.getByRole('rowheader', { name: label }).closest('tr')!;
const cells = (label: string) => [...row(label).querySelectorAll('td')].map((cell) => cell.textContent);

describe('A-1 the facts, side by side', () => {
  it('names the outcome, the rung, the duration and the spend of each attempt, in its own column', async () => {
    open({
      attempts: [
        attempt({ attempt: 1 }),
        attempt({ attempt: 2, startedAt: '2026-08-24T10:20:00.000Z', endedAt: '2026-08-24T10:34:00.000Z' }),
      ],
      comparisons: [comparison()],
    });
    mount();
    await sheet();

    expect(screen.getByRole('columnheader', { name: 'Attempt 1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Attempt 2' })).toBeInTheDocument();
    // Row-scoped, not `getByText`: "done" and "failed" appear in several places.
    expect(cells('Outcome')).toEqual(['failed', 'done']);
    expect(cells('Ladder rungs')).toEqual(['none', 'escalate']);
    expect(cells('Took')[0]).toBe('10m');
    expect(cells('Took')[1]).toMatch(/^14m \(▲up 4m\)$/);
    expect(cells('Spend')[0]).toBe('$0.75');
    expect(cells('Spend')[1]).toContain('$2.50');
    expect(cells('Model')).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    expect(cells('Window')[1]).toMatch(/→/);
  });

  it('draws each verdict as the console’s verification word, beside the tree it ran against', async () => {
    const tree = { repo: 'api', branch: 'pe/demo', head: '1d1911ee0000', role: 'verify-in' as const };
    open({
      attempts: [
        attempt({
          attempt: 1,
          verification: { ok: false, reason: null, cwd: null, ran: [], notRun: 0, skipped: 0, trees: [tree] },
        }),
        attempt({
          attempt: 2,
          verification: { ok: true, reason: null, cwd: null, ran: [], notRun: 0, skipped: 0 },
        }),
      ],
      comparisons: [comparison()],
    });
    mount();
    await sheet();
    const verdicts = row('Verification').querySelectorAll('[data-status]');
    expect([...verdicts].map((word) => word.getAttribute('data-status'))).toEqual(['red', 'green']);
    expect(within(row('Verification')).getByTestId('verify-tree')).toHaveTextContent(
      'on api · pe/demo · 1d1911ee',
    );
    expect(within(row('Verification')).getByTestId('verify-tree-unknown')).toBeInTheDocument();
  });
});

describe('A-2 an absence is not a zero', () => {
  it('shows an unrecorded figure as unrecorded, never as $0.00, and reports no delta against it', async () => {
    open({
      attempts: [attempt({ attempt: 1, costUsd: null }), attempt({ attempt: 2 })],
      comparisons: [comparison({ costUsd: { from: null, to: 2.5, deltaUsd: null } })],
    });
    mount();
    await sheet();
    expect(cells('Spend')).toEqual(['not recorded', '$2.50']);
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

describe('A-3 the commands that flipped', () => {
  it('lists every command that flipped, with both exit codes', async () => {
    open({
      attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })],
      comparisons: [
        comparison({
          verification: {
            from: false,
            to: true,
            unchanged: 1,
            flips: [
              {
                command: 'npm test',
                from: 'fail',
                to: 'pass',
                fromCode: 1,
                toCode: 0,
                fromMs: 4_000,
                toMs: 5_000,
              },
              {
                command: 'npm run typecheck',
                from: 'absent',
                to: 'pass',
                fromCode: null,
                toCode: 0,
                fromMs: null,
                toMs: 2_000,
              },
            ],
          },
        }),
      ],
    });
    mount();
    await sheet();
    const flips = screen.getByRole('table', { name: 'Commands whose result changed' });
    expect(within(flips).getByText('npm test')).toBeInTheDocument();
    expect(within(flips).getByText('npm run typecheck')).toBeInTheDocument();
    expect(within(flips).getByText('1 → 0')).toBeInTheDocument();
    // A command that only appeared on one side has no exit code to show there.
    expect(within(flips).getByText('— → 0')).toBeInTheDocument();
    // Each side is a verification word through the family, "not run" for the absent one.
    const words = [...flips.querySelectorAll('[data-status]')].map((word) =>
      word.getAttribute('data-status'),
    );
    expect(words).toEqual(['red', 'green', 'none', 'green']);
    expect(screen.getByText(/1 ran the same way/)).toBeInTheDocument();
  });

  it('says plainly when nothing flipped, rather than showing an empty table', async () => {
    open({ attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })], comparisons: [comparison()] });
    mount();
    await sheet();
    expect(screen.getByText(/No command changed its result/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Commands whose result changed' })).toBeNull();
  });
});

describe('A-4 which pair', () => {
  const three = () =>
    open({
      attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 }), attempt({ attempt: 3 })],
      comparisons: [comparison({ from: 1, to: 2 }), comparison({ from: 2, to: 3 })],
    });

  it('opens on the NEWEST pair, because that is the question being asked', async () => {
    three();
    mount();
    await sheet();
    const select = screen.getByLabelText(/Which pair/) as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect(select.options[Number(select.value)]!.textContent).toContain('Attempt 2 → 3');
    expect(screen.getByRole('columnheader', { name: 'Attempt 3' })).toBeInTheDocument();
    expect(screen.getByText(/3 attempts, comparing/)).toBeInTheDocument();
  });

  it('lets the reader step back to an earlier pair', async () => {
    three();
    mount();
    await sheet();
    const select = screen.getByLabelText(/Which pair/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '0' } });
    expect(select.value).toBe('0');
    expect(screen.getByRole('columnheader', { name: 'Attempt 1' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Attempt 3' })).toBeNull();
  });
});

describe('A-5 one boarding, none, and the way to the phase', () => {
  it('a single boarding has nothing to compare, and says what it did instead', async () => {
    open({
      attempts: [
        attempt({
          attempt: 1,
          outcome: 'done',
          verification: {
            ok: true,
            reason: null,
            cwd: null,
            ran: [{ command: 'npm test', ok: true, code: 0, ms: 3_000 }],
            notRun: 0,
            skipped: 0,
          },
        }),
      ],
      comparisons: [],
    });
    mount();
    await sheet();
    expect(screen.getByText(/nothing to compare yet/)).toBeInTheDocument();
    expect(cells('Outcome')).toEqual(['done']);
    expect(row('Verification')).toHaveTextContent(/1 command ran/);
    expect(within(row('Verification')).getByTestId('verify-tree-unknown')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Which pair/)).toBeNull();
  });

  it('a phase with no boarding in this run says so rather than rendering an empty diff', async () => {
    open({ attempts: [], comparisons: [] });
    mount();
    await sheet();
    expect(screen.getByText(/No attempts recorded/)).toBeInTheDocument();
    expect(screen.queryByRole('rowheader')).toBeNull();
  });

  it('links to the phase itself, through the routes module', async () => {
    open({ attempts: [attempt({ attempt: 1 })], comparisons: [] });
    mount();
    await sheet();
    expect(screen.getByRole('link', { name: 'Open phase 9' })).toHaveAttribute('href', phaseHref('demo', 9));
  });

  it('renders nothing, and reads nothing, while closed', () => {
    open({ attempts: [attempt({ attempt: 1 })], comparisons: [] });
    mount(null);
    expect(screen.queryByTestId('run-attempts')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('is clean to axe', async () => {
    open({ attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })], comparisons: [comparison()] });
    mount();
    await sheet();
    await expectNoAxeViolations(document.body);
  });
});
