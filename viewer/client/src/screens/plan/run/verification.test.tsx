/**
 * The Run view's Verification fold (7.0, quiet-console phase 26).
 *
 * What is pinned, in the order it would bite:
 *
 *   - **a phase at a time, the newest news first** — what its session proved
 *     (the exit as a word, the tree and HEAD short, when), the console's
 *     verdicts newest first and its baseline at boarding, each as the
 *     ledgers answered;
 *   - **what a phase still owes is the server's word**: the reds its newest
 *     verdict on each line charged it with (`own`, `*` the whole command) —
 *     not a line whose newest verdict is green, not one its session proved
 *     green since, and a run its clock cut says nothing either way — and the
 *     reds another phase's verification named it the owner of (`owed`);
 *   - a red verdict says which of its reds are its own and which its baseline
 *     already had;
 *   - **the phase filter asks both routes for that phase**, and *Show older*
 *     asks the ledger for the next page, up to the server's 2,000;
 *   - nothing on file says so in one line; a ledger that cannot be read says
 *     why.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, posted } = vi.hoisted(() => ({ request: vi.fn(), posted: vi.fn() }));
vi.mock('@/data/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/http')>()),
  request: (path: string) => request(path),
  post: (path: string, body?: unknown) => posted(path, body),
}));

import type { RunState } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import type { RunProof, VerificationRow } from '@/data/verification';
import { RunVerificationFold } from './verification';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const TREE = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const HEAD = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f';

const PROOFS: RunProof[] = [
  { phase: 2, command: 'npm test', code: 0, tree: TREE, head: HEAD, at: ago(70), session: 's-2' },
  { phase: 3, command: 'npm test', code: 1, tree: TREE, at: ago(130) },
  // After phase 5's red verdict: the console honours it, and ledgers no row.
  { phase: 5, command: 'npm test', code: 0, tree: TREE, at: ago(300) },
];

const row = (over: Partial<VerificationRow> & Pick<VerificationRow, 'phase' | 'command' | 'at'>) =>
  ({ run: 'run-7f3a9c21', kind: 'verify', code: 0, ms: 12_000, ok: true, ...over }) as VerificationRow;

/** Newest first, as the ledger answers. */
const ROWS: VerificationRow[] = [
  row({ phase: 4, command: 'bats tests', at: ago(30), code: 124, ok: false, timedOut: true, ms: 1_800_000 }),
  row({ phase: 2, command: 'npm test', at: ago(60), head: HEAD, own: [] }),
  row({
    phase: 2,
    command: 'npm run lint',
    at: ago(60),
    code: 1,
    ok: false,
    own: ['*'],
    tail: 'lint: 3 problems',
  }),
  row({
    phase: 3,
    command: 'npm test',
    at: ago(120),
    code: 1,
    ok: false,
    failures: ['suite › a', 'suite › b'],
    own: ['suite › a'],
  }),
  row({ phase: 2, command: 'npm test', at: ago(180), kind: 'baseline', run: 'run-old00001' }),
  row({
    phase: 3,
    command: 'npm test',
    at: ago(240),
    kind: 'baseline',
    code: 1,
    ok: false,
    failures: ['suite › b'],
    tail: 'not ok 2 suite › b',
  }),
  row({ phase: 4, command: 'bats tests', at: ago(290), code: 1, ok: false, own: ['*'] }),
  row({ phase: 5, command: 'npm test', at: ago(360), code: 1, ok: false, own: ['x'] }),
];

const RUN = {
  id: 'run-7f3a9c21',
  slug: 'demo',
  phases: {
    6: {
      phase: 6,
      status: 'done',
      owed: [{ command: 'npm test', failures: ['suite › c'], by: 7, at: ago(90), how: 'commit' }],
    },
  },
} as unknown as RunState;

const PHASES = [2, 3, 4, 5, 6].map((phase) => ({ phase, title: `the part ${phase}` }));

/** What the fixture ledgers hold this test — the server narrows and cuts them as the route does. */
let held: { rows: VerificationRow[]; proofs: RunProof[]; total?: number; fail?: boolean };

beforeEach(() => {
  held = { rows: ROWS, proofs: PROOFS };
  request.mockReset().mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://console');
    const phase = url.searchParams.has('phase') ? Number(url.searchParams.get('phase')) : undefined;
    if (url.pathname === '/api/run/demo/proofs') {
      return {
        slug: 'demo',
        phase: phase ?? null,
        proofs: held.proofs.filter((p) => !phase || p.phase === phase),
      };
    }
    if (url.pathname === '/api/run/demo/verifications') {
      if (held.fail) throw new ApiError('the ledger is locked', 500, path);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      const matched = held.rows.filter((r) => !phase || r.phase === phase);
      return { slug: 'demo', rows: matched.slice(0, limit), total: held.total ?? matched.length, limit };
    }
    throw new ApiError(`unmocked ${path}`, 404, path);
  });
});
afterEach(cleanup);

function mount(run: RunState | null = RUN) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunVerificationFold slug="demo" run={run} planPhases={PHASES} />
    </QueryClientProvider>,
  );
}

const phaseOf = (n: number) => {
  const found = screen
    .getAllByTestId('verification-phase')
    .find((section) => section.getAttribute('data-phase') === String(n));
  if (!found) throw new Error(`no phase ${n} drawn`);
  return found;
};
const owedIn = (n: number) =>
  within(phaseOf(n))
    .queryAllByTestId('verification-owed')
    .map((li) => li.textContent);

describe('the Verification fold', () => {
  it('draws a phase at a time, the newest news first', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    const order = screen.getAllByTestId('verification-phase').map((s) => s.getAttribute('data-phase'));
    expect(order).toEqual(['4', '2', '6', '3', '5']);
    expect(within(phaseOf(2)).getByRole('heading', { level: 3 }).textContent).toBe('Phase 2 the part 2');
  });

  it('says what its session proved — the exit as a word, the tree and head short, when', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    const [proof] = within(phaseOf(2)).getAllByTestId('verification-proof');
    expect(proof!.querySelector('[data-status]')?.getAttribute('data-status')).toBe('green');
    expect(proof!.textContent).toContain('npm test');
    expect(proof!.textContent).toContain('exit 0');
    expect(proof!.textContent).toContain('tree 1a2b3c4d');
    expect(proof!.textContent).toContain('head 5e6f7a8b');
    expect(proof!.querySelector('time')).not.toBeNull();
    // A red proof is a word too, never colour alone.
    const [red] = within(phaseOf(3)).getAllByTestId('verification-proof');
    expect(red!.querySelector('[data-status]')?.getAttribute('data-status')).toBe('red');
    expect(red!.textContent).toContain('exit 1');
    // A phase whose session recorded none says so.
    expect(within(phaseOf(4)).getByTestId('verification-proofs').textContent).toContain(
      'Its session recorded no proof.',
    );
  });

  it('lists the console’s verdicts newest first, and its baseline at boarding apart', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    const verdicts = within(within(phaseOf(2)).getByTestId('verification-verdicts')).getAllByTestId(
      'verification-run',
    );
    expect(verdicts.map((li) => li.getAttribute('data-word'))).toEqual(['green', 'red']);
    expect(verdicts[0]!.textContent).toContain('exit 0');
    expect(verdicts[0]!.textContent).toContain('took 12s');
    expect(verdicts[0]!.textContent).toContain('head 5e6f7a8b');
    expect(verdicts[0]!.textContent).toContain('run-7f3a, this run');
    const baselines = within(within(phaseOf(2)).getByTestId('verification-baselines')).getAllByTestId(
      'verification-run',
    );
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.getAttribute('data-kind')).toBe('baseline');
    // Another run's row names that run, and not as this one.
    expect(baselines[0]!.textContent).toContain('run-old0');
    expect(baselines[0]!.textContent).not.toContain('this run');
  });

  it('a red verdict says which reds are its own and which its baseline already had', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    expect(within(phaseOf(3)).getByTestId('verification-charge').textContent).toBe(
      'Its own: suite › a. Already red at its baseline: suite › b.',
    );
    expect(within(phaseOf(2)).getByTestId('verification-charge').textContent).toBe(
      'Its own: the whole command.',
    );
    // The baseline's red names its failing tests, and what it printed is one press away.
    const baseline = within(within(phaseOf(3)).getByTestId('verification-baselines')).getByTestId(
      'verification-run',
    );
    expect(baseline.textContent).toContain('Failing: suite › b.');
    fireEvent.click(within(baseline).getByRole('button', { name: 'What it printed' }));
    expect(within(baseline).getByText('not ok 2 suite › b')).toBeInTheDocument();
  });

  it('a run its clock cut is not judged, and says so in words', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    const [cut] = within(within(phaseOf(4)).getByTestId('verification-verdicts')).getAllByTestId(
      'verification-run',
    );
    // Its own word, Timed out — never Skipped, which is a line this machine could not run (#331).
    expect(cut!.getAttribute('data-word')).toBe('timed-out');
    const mark = cut!.querySelector<HTMLElement>('[data-vocab="verification-line"]')!;
    expect(mark.dataset.status).toBe('timed-out');
    expect(mark.dataset.paint).not.toBe('failed');
    expect(mark.textContent).toContain('Timed out');
    expect(cut!.textContent).toContain('cut at its limit after 30m');
    expect(cut!.textContent).not.toContain('exit 124');
  });

  it('says what each phase still owes — the server’s marks, never a guess', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    // The newest verdict on the line charged the whole command; its other line is green.
    expect(owedIn(2)).toHaveLength(1);
    expect(owedIn(2)[0]).toContain('npm run lint');
    expect(owedIn(2)[0]).toContain('the whole command');
    // Its own red, not the one its baseline had.
    expect(owedIn(3)).toHaveLength(1);
    expect(owedIn(3)[0]).toContain('1 failing test: suite › a');
    // A cut run says nothing about the line: the red verdict before it stands.
    expect(owedIn(4)).toHaveLength(1);
    expect(owedIn(4)[0]).toContain('bats tests');
    // Its session proved the line green after the red: the console honours that.
    expect(within(phaseOf(5)).queryByTestId('verification-owes')).toBeNull();
    // Another phase's verification named phase 6 the owner, on this run's record.
    const found = within(phaseOf(6)).getByTestId('verification-owed-found');
    expect(found.textContent).toContain('1 failing test: suite › c');
    expect(found.textContent).toContain('Found by phase 7: its commits brought it in');
  });

  it('the phase filter asks both ledgers for that phase', async () => {
    mount();
    await screen.findAllByTestId('verification-phase');
    const filter = screen.getByTestId('verification-phase-filter');
    expect([...filter.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Every phase',
      ...PHASES.map((one) => `Phase ${one.phase} — ${one.title}`),
    ]);
    fireEvent.change(filter, { target: { value: '3' } });
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/run/demo/proofs?phase=3'));
    expect(request).toHaveBeenCalledWith('/api/run/demo/verifications?phase=3&limit=200');
    await waitFor(() =>
      expect(screen.getAllByTestId('verification-phase').map((s) => s.getAttribute('data-phase'))).toEqual([
        '3',
      ]),
    );
  });

  it('says how much the ledger cut, and Show older asks for the next page', async () => {
    held = { rows: ROWS, proofs: PROOFS, total: 450 };
    mount();
    await screen.findAllByTestId('verification-phase');
    expect(screen.getByTestId('verification-cut').textContent).toBe(
      `The newest ${ROWS.length} of 450 runs of a line.`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show 200 older' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/run/demo/verifications?limit=400'));
  });

  it('draws the independent evaluator: the dot, both judges apart, each criterion and its evidence (measured-console phase 22)', async () => {
    held = { rows: [], proofs: [] };
    const run = {
      id: 'run-1',
      phases: {
        '7': {
          phase: 7,
          status: 'done',
          evaluation: {
            attempt: 1,
            at: '2026-10-27T10:00:00.000Z',
            mode: 'advisory',
            verdict: 'not-met',
            criteria: [
              { id: '1', text: 'a' },
              { id: '2', text: 'b' },
            ],
            ran: true,
            costUsd: 0.42,
            model: 'claude-sonnet-5-5',
            account: 'anthropic-api',
            browser: { url: 'http://127.0.0.1:5123', used: true },
            dimensions: {
              spec: {
                criteria: [
                  { id: '1', verdict: 'met', evidence: 'server/widget.ts:1' },
                  { id: '2', verdict: 'not-met', evidence: 'README.md is untouched' },
                ],
                summary: '',
                words: 6,
              },
              standards: {
                criteria: [
                  { id: '1', verdict: 'met', evidence: 'CLAUDE.md rule kept' },
                  { id: '2', verdict: 'unknown', evidence: 'no rule names it' },
                ],
                summary: '',
                words: 7,
              },
            },
          },
        },
      },
    } as unknown as RunState;
    mount(run);
    const part = await screen.findByTestId('verification-evaluation');
    expect(within(part).getByTestId('evaluation-verdict')).toHaveAttribute('data-verdict', 'not-met');
    expect(within(part).getByTestId('evaluation-verdict')).toHaveTextContent('Advisory — it holds nothing');
    expect(
      within(part)
        .getAllByTestId('evaluation-judge')
        .map((j) => j.getAttribute('data-judge')),
    ).toEqual(['spec', 'standards']);
    const lines = within(part)
      .getAllByTestId('evaluation-criterion')
      .map((li) => li.textContent);
    expect(lines).toEqual([
      'MetCriterion 1server/widget.ts:1',
      'Not metCriterion 2README.md is untouched',
      'MetCriterion 1CLAUDE.md rule kept',
      'UnknownCriterion 2no rule names it',
    ]);
    expect(within(part).getByTestId('evaluation-browser')).toHaveTextContent(
      'Judged in a browser against the seeded console at http://127.0.0.1:5123.',
    );
  });

  it('nothing on file says so in one line', async () => {
    held = { rows: [], proofs: [] };
    mount(null);
    expect(await screen.findByTestId('verification-empty')).toHaveTextContent(
      'Nothing is on file yet: no session recorded a proof and the console verified nothing.',
    );
  });

  it("a red the phase still owes can be waived, with a reason, through the run's waiver route (#267)", async () => {
    posted.mockReset().mockResolvedValue({ waiver: {}, run: RUN });
    mount();
    await screen.findAllByTestId('verification-phase');
    const owed = within(phaseOf(2)).getByTestId('verification-owed');
    fireEvent.click(within(owed).getByTestId('verification-waive'));
    const confirm = within(owed).getByTestId('verification-waive-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(owed).getByTestId('verification-waive-reason'), {
      target: { value: 'another plan opened the window' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith('/api/run/demo/verify-waive', {
        phase: 2,
        line: 'npm run lint',
        reason: 'another plan opened the window',
        expectRunId: RUN.id,
      }),
    );
  });

  it('a waived line is listed with who waived it and why, and is owed no more', async () => {
    mount({
      ...RUN,
      verifyWaivers: [
        {
          phase: 2,
          fp: 'f'.repeat(64),
          text: 'npm run lint',
          reason: 'not ours',
          by: 'owner@desk',
          at: ago(5),
        },
      ],
    } as RunState);
    await screen.findAllByTestId('verification-phase');
    const waiver = within(phaseOf(2)).getByTestId('verification-waiver');
    expect(waiver.textContent).toContain('npm run lint');
    expect(waiver.textContent).toContain('owner@desk: not ours');
    expect(owedIn(2)).toHaveLength(0);
  });

  it('a ledger that cannot be read says why, and the proofs still draw', async () => {
    held = { rows: ROWS, proofs: PROOFS, fail: true };
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The verification ledger could not be read: the ledger is locked',
    );
    await waitFor(() => expect(screen.getAllByTestId('verification-proof').length).toBe(PROOFS.length));
  });
});
