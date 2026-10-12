/**
 * Ways forward (7.0, quiet-console phase 12; every case carried from the 6.x
 * card's suite): every stopped phase's cause in its own words, next to the
 * action that moves it. What is pinned is the honesty contract — the handoff's
 * Outstanding text speaks for a blocked phase, the gate's own conditions speak
 * for a gated one (and nothing offers to bypass it), and a failed record gets
 * the recovery its evidence supports, the recommended verb first.
 *
 * Two more, from a plan that had never run being told it was stopped: a gate
 * speaks only where it is the PROXIMATE blocker (ready, or a record that
 * stopped on it — never a waiting phase eleven dependencies down), and a list
 * with no run behind it says it is a checklist rather than an incident.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { post, request } = vi.hoisted(() => ({ post: vi.fn(), request: vi.fn() }));

/** The launch form a recovery opens through its door — here a stand-in that says what it was asked to open. */
const launched = vi.hoisted(() => vi.fn());
vi.mock('@/screens/launch/door', () => ({
  LaunchDoor: ({ request: asked, onClose }: { request: { recoveryClass: string }; onClose: () => void }) => {
    launched(asked);
    return (
      <div role="dialog" aria-label="Launch a recovery">
        <p>{asked.recoveryClass}</p>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    );
  },
}));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => request(path),
    post: (path: string, body?: unknown) => post(path, body),
  };
});

import { budgetFact, budgetHeadline } from '@shared/budget-model.js';
import type { RecoveryParts } from '@/cards/recovery-actions';
import type { PhaseView, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { Button } from '@/ui';
import { TooltipProvider } from '@/ui/tooltip';
import { RunWaysForward, waysForwardRows } from './ways-forward';

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({
    phase: 1,
    title: 'A phase',
    state: 'ready',
    size: 'S',
    weight: 1,
    gated: false,
    bullets: [],
    ...over,
  }) as PhaseView;

const run = (over: Partial<RunState>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'parked',
    autonomy: 'keep-going',
    model: 'opus',
    createdAt: '',
    updatedAt: '',
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    spentUsd: 0,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    ...over,
  }) as unknown as RunState;

const PARTS: RecoveryParts = {};

function mount(node: ReactElement, flags: { allowWrites?: boolean } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: true,
    allowAgent: true,
    allowWrites: flags.allowWrites ?? false,
    autopilot: true,
    root: { ok: true, path: '/repo' },
  });
  client.setQueryData(keys.terminal(), {
    allowed: false,
    agentAllowed: true,
    available: 'yes',
    sessions: [],
  });
  for (const all of [true, false]) {
    client.setQueryData(keys.inbox(all), { items: [], generatedAt: '2026-09-29T10:00:00.000Z' });
  }
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  post.mockReset();
  request.mockReset();
  launched.mockReset();
});

describe('waysForwardRows', () => {
  it('lets a blocked handoff speak for itself, and routes it to plan-repair', () => {
    const rows = waysForwardRows(
      'demo',
      [
        phase({
          phase: 5,
          state: 'stuck',
          title: 'Rollout',
          handoff: {
            file: 'phase-05-x.md',
            status: 'blocked',
            title: 'x',
            skillsUsed: [],
            prompts: 0,
            outstanding: '**One exit criterion is unmet**, and it needs a human.',
          },
        }),
      ],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.why).toContain('One exit criterion is unmet');
    // The handoff's own emphasis is stripped: an excerpt, not markdown.
    expect(rows[0]!.why).not.toContain('**');
    expect(rows[0]!.stuck).toBe(true);
    expect(rows[0]!.retry).toBeUndefined();
  });

  it('quotes the gate for a gated phase and offers only a re-check, never a bypass', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true, gates: 'operator confirms the auth-off rail' })],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.why).toContain('operator confirms the auth-off rail');
    expect(rows[0]!.retry).toBe('rechecks-gate');
    expect(rows[0]!.record).toBeUndefined();
  });

  it('says nothing about a gate on a phase whose turn has not come', () => {
    // `gated` is orthogonal to the bucket, so a WAITING phase carries the flag
    // while its dependencies are what hold it. Naming the gate there answers a
    // question nobody asked and hides the one that matters.
    const rows = waysForwardRows(
      'demo',
      [
        phase({ phase: 1, state: 'in-progress' }),
        phase({ phase: 12, state: 'waiting', gated: true, gates: 'operator signs the release off' }),
      ],
      null,
    );
    expect(rows).toHaveLength(0);
  });

  it('still names a gate the run itself stopped on, whatever the board bucket says', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 12, state: 'waiting', gated: true, gates: 'operator signs the release off' })],
      run({
        phases: {
          12: { phase: 12, status: 'gated', attempts: 0, costUsd: 0, note: 'gate not clear: manual' },
        },
      } as never),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retry).toBe('rechecks-gate');
  });

  it("an ai gate says the session clears it itself — it is not a person's job", () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true, gateKind: 'ai', gates: 'staging deployed' })],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.why).toContain('verifies and clears this gate itself');
    expect(rows[0]!.why).toContain('staging deployed');
    expect(rows[0]!.gateKind).toBe('ai');
  });

  it('says a gate in words, never as a `WORD — fragment` label', () => {
    const rows = waysForwardRows(
      'demo',
      [
        phase({ phase: 2, state: 'ready', gated: true, gates: 'confirm the window' }),
        phase({ phase: 3, state: 'ready', gated: true }),
      ],
      null,
    );
    expect(rows.map((row) => row.why)).toEqual([
      'the plan asks a person to confirm first: confirm the window',
      'the plan names a condition a person must confirm before this phase runs.',
    ]);
  });

  it('a record the runner held as gated still surfaces, quoting its note', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true })],
      run({
        phases: {
          2: {
            phase: 2,
            status: 'gated',
            attempts: 0,
            costUsd: 0,
            note: 'gate not clear: manual — mint the fixture keys',
          },
        },
      } as never),
    );

    expect(rows[0]!.why).toContain('mint the fixture keys');
    expect(rows[0]!.retry).toBe('rechecks-gate');
  });

  it("prefers the runner's own parked note when the record has one", () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true })],
      run({
        phases: {
          2: {
            phase: 2,
            status: 'parked',
            attempts: 0,
            costUsd: 0,
            note: 'gate not clear: manual — confirm the rollout window',
          },
        },
      } as never),
    );

    expect(rows[0]!.why).toContain('confirm the rollout window');
  });

  it('gives a failed record its recovery class and a Retry that restarts', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 3, state: 'ready', title: 'Ship' })],
      run({
        halt: { at: '', reason: 'phase 3 did not verify: 1 of 1 command(s) failed — false', phase: 3 },
        phases: { 3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0 } },
      } as never),
    );

    expect(rows[0]!.record).toEqual({ status: 'failed', resumable: false });
    expect(rows[0]!.retry).toBe('restarts');
    expect(rows[0]!.why).toContain('did not verify');
  });

  it('says the stop in the halt card’s sentence when the run’s halt is this phase’s and has a kind', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 3, state: 'ready' })],
      run({
        halt: { at: '', reason: 'raw runner words', phase: 3, kind: 'verify-failed' },
        phases: {
          3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0, halt: { kind: 'verify-failed' } },
        },
      } as never),
    );
    expect(rows[0]!.why).not.toContain('raw runner words');
    expect(rows[0]!.haltKind).toBe('verify-failed');
  });

  it('says nothing about phases that are done or genuinely in flight', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 1, state: 'done' }), phase({ phase: 2, state: 'ready' })],
      null,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('<RunWaysForward>', () => {
  it('renders a stuck phase with Repair the plan with a new agent, and a gated one with its confirmation', async () => {
    post.mockResolvedValue({});
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[
          phase({
            phase: 5,
            state: 'stuck',
            title: 'Rollout',
            handoff: {
              file: 'phase-05-x.md',
              status: 'blocked',
              title: 'x',
              skillsUsed: [],
              prompts: 0,
              outstanding: 'the shutdown acceptance test needs a human',
            },
          }),
          phase({ phase: 2, state: 'ready', gated: true, gates: 'confirm the window' }),
        ]}
        run={null}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );

    // No run has ever existed here, so nothing has stopped — the same rows,
    // under the line that says what they are.
    expect(screen.getByTestId('ways-forward-lead').textContent).toMatch(/Before this plan can run/);
    expect(screen.queryByText(/stopped/i)).not.toBeInTheDocument();
    expect(screen.getByText(/shutdown acceptance test needs a human/)).toBeInTheDocument();
    // The repair opens the launch form, so the operator shapes the session before it exists.
    fireEvent.click(screen.getByRole('button', { name: /Repair the plan with a new agent/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(launched).toHaveBeenLastCalledWith({
      kind: 'recovery',
      recoveryClass: 'plan-repair',
      slug: 'demo',
      phase: 5,
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(screen.getByText(/confirm the window/)).toBeInTheDocument();
    expect(screen.getByTestId('ways-forward-gate').textContent).toBe('Needs your confirmation');
    // A gate is RE-CHECKED rather than retried — the verb the server has
    // always had for it, rendered by the one recovery renderer.
    fireEvent.click(screen.getByRole('button', { name: /Re-check/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/recheck', { phase: 2 }));
  });

  it('asks no person to confirm a gate a session clears itself', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[
          phase({ phase: 2, state: 'ready', gated: true, gateKind: 'ai', gates: 'staging deployed' }),
        ]}
        run={null}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect(screen.getByTestId('ways-forward-why').textContent).toBe(
      'A booted session verifies and clears this gate itself: staging deployed. Read the gate in the plan',
    );
    expect(screen.queryByTestId('ways-forward-gate')).toBeNull();
    expect(screen.getByRole('button', { name: /Re-check/i })).toBeInTheDocument();
  });

  it('offers a new agent whatever the view lends — the form is the launch door’s, not a lent part', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 5, state: 'stuck', title: 'Rollout' })]}
        run={null}
        live={false}
        authFailure={false}
        parts={{}}
      />,
    );
    expect(screen.getByText('Rollout')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /Repair the plan with a new agent/i }).length,
    ).toBeGreaterThan(0);
  });

  it('once a run exists the rows are why it stopped — no checklist line', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'ready', title: 'Ship' })]}
        run={run({
          halt: { at: '', reason: 'phase 3 did not verify', phase: 3 },
          phases: { 3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0 } },
        } as never)}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect(screen.queryByTestId('ways-forward-lead')).toBeNull();
    expect(screen.getByRole('list', { name: 'Stopped phases' })).toBeInTheDocument();
    // The cause stands alone on its line, so it reads as a sentence.
    expect(screen.getByTestId('ways-forward-why').textContent).toBe('Phase 3 did not verify.');
  });

  it('draws each row in the halt card’s grammar: the phase as a link, its board word, its family, the recommended verb first', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'ready', title: 'Ship' })]}
        run={run({
          halt: { at: '', reason: 'raw', phase: 3, kind: 'verify-failed' },
          phases: {
            3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0, halt: { kind: 'verify-failed' } },
          },
        } as never)}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    const row = screen.getByTestId('ways-forward-row');
    expect(row.getAttribute('data-phase')).toBe('3');
    expect(within(row).getByRole('link', { name: /Ship/ })).toHaveAttribute('href', '#/plan/demo/phase/3');
    const word = row.querySelector('[data-vocab="board"]')!;
    expect(word.getAttribute('data-status')).toBe('ready');
    expect(within(row).getByTestId('halt-category').getAttribute('data-halt-category')).toBe('verification');
    // One verb inline, solid; every other way forward one press behind it.
    expect(within(row).getAllByTestId('halt-recommended')).toHaveLength(1);
    expect(within(row).getByRole('button', { name: /More ways forward/ })).toBeInTheDocument();
  });

  it('names the family the ladder’s errand reads as, and offers to read what a row only excerpts', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[
          phase({
            phase: 5,
            state: 'stuck',
            title: 'Rollout',
            handoff: { file: 'phase-05-x.md', status: 'blocked', title: 'x', skillsUsed: [], prompts: 0 },
          }),
          phase({ phase: 4, state: 'in-progress', title: 'Cart' }),
        ]}
        run={run({
          phases: {
            '4': { phase: 4, status: 'parked', attempts: 1, costUsd: 0 },
          },
          recoveries: {
            '4': {
              attempts: 1,
              lastAt: '',
              errand: {
                phase: 4,
                situation: 'resource-wall:auth',
                tried: [],
                need: 'Sign the account in again.',
                how: 'Run claude auth login.',
                at: '',
              },
            },
          },
        } as unknown as Partial<RunState>)}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    const [stuck, parked] = screen.getAllByTestId('ways-forward-row');
    expect(within(stuck!).getByRole('link', { name: 'Read the full handoff' })).toHaveAttribute(
      'href',
      '#/plan/demo/phase/5',
    );
    expect(within(stuck!).getByTestId('ways-forward-why').textContent).toBe(
      'Its handoff is marked blocked. Read the full handoff',
    );
    const mark = parked!.querySelector('[data-testid="halt-category"]')!;
    expect(mark.getAttribute('data-halt-category')).toBe('credentials');
    expect(within(parked!).getByTestId('ways-forward-why').textContent).toBe('Sign the account in again.');
    // The errand itself is drawn as the one ask, by the recovery renderer.
    expect(within(parked!).getByTestId('errand')).toBeInTheDocument();
  });

  it('says one line for a plan that has never run and has nothing holding it', () => {
    // The reported shape (`aug-create-order-filters-remediation`): eleven
    // waiting phases and a twelfth that is waiting AND gated. Nothing has
    // stopped, nothing is held by a person — no row, no checklist, no gate.
    const waiting = Array.from({ length: 11 }, (_, i) =>
      phase({ phase: i + 1, state: 'waiting', title: `Phase ${i + 1}` }),
    );
    const { container } = mount(
      <RunWaysForward
        slug="demo"
        planPhases={[
          ...waiting,
          phase({ phase: 12, state: 'waiting', gated: true, gates: 'the operator signs the release off' }),
        ]}
        run={null}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect(container.textContent).toBe('No phase is stopped.');
    expect(screen.queryByTestId('ways-forward-row')).toBeNull();
  });

  it('renders nothing while the run is live — the lanes are the truth then', () => {
    const { container } = mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 5, state: 'stuck' })]}
        run={null}
        live
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('failed here, finished elsewhere', () => {
  it('explains a red record on a green phase instead of offering to fix it', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 1, state: 'done', title: 'Editor truth' })],
      run({
        phases: {
          1: { phase: 1, status: 'failed', attempts: 1, costUsd: 0, note: 'no configuration file provided' },
        },
      } as never),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.why).toContain("this run's own attempt stopped");
    expect(rows[0]!.why).toContain('no configuration file provided');
    expect(rows[0]!.why).toContain('nothing needs fixing');
    expect(rows[0]!.why).toContain('reconciles to done');
    expect(rows[0]!.record).toBeUndefined();
    expect(rows[0]!.retry).toBeUndefined();
  });

  it('draws no remedy for it, only the way to the phase', () => {
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 1, state: 'done', title: 'Editor truth' })]}
        run={run({
          phases: { 1: { phase: 1, status: 'failed', attempts: 1, costUsd: 0, note: 'no config' } },
        } as never)}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    const row = screen.getByTestId('ways-forward-row');
    expect(within(row).queryByTestId('halt-recommended')).toBeNull();
    expect(within(row).getByRole('link', { name: 'Open the phase' })).toHaveAttribute(
      'href',
      '#/plan/demo/phase/1',
    );
  });

  it('stays quiet about done phases whose record is clean', () => {
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 1, state: 'done' })],
      run({ phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 } } } as never),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("waysForwardRows — the ladder's errand", () => {
  it("leads a row with the errand's ask, and carries the record's situation for the strip", () => {
    const errand = {
      phase: 4,
      situation: 'blocked-declared:unknown',
      tried: ['unblock-session → failed'],
      need: "A reading of the session's Outstanding section.",
      how: 'Clear what it names, then Resume or Retry.',
      at: '',
    };
    const rows = waysForwardRows(
      'demo',
      [phase({ phase: 4, state: 'in-progress', title: 'Rollout' })],
      run({
        phases: {
          '4': {
            phase: 4,
            status: 'pending',
            attempts: 2,
            costUsd: 0,
            situation: { key: 'blocked-declared:unknown', at: '' },
          },
        },
        recoveries: { '4': { attempts: 1, lastAt: '', errand } },
      } as unknown as Partial<RunState>),
    );
    expect(rows).toHaveLength(1);
    // A pending record with an errand is still a stopped phase to explain.
    expect(rows[0]!.why).toBe(errand.need);
    expect(rows[0]!.errand).toEqual(errand);
    expect(rows[0]!.record).toEqual({
      status: 'pending',
      resumable: false,
      situation: { key: 'blocked-declared:unknown' },
    });
    expect(rows[0]!.retry).toBe('restarts');
  });
});

describe('a plan wedged by a QA verdict', () => {
  // The measured shape. Phase 1 finished, its QA verdict is `fail`, and that
  // holds every dependent — so the board has nothing ready and the plan is
  // dead. The only row once produced was for a DOWNSTREAM gated phase, already
  // approved and six dependencies away, so the list named a cause that was
  // not the cause.
  const wedged: PhaseView[] = [
    phase({
      phase: 1,
      state: 'done',
      title: 'backend',
      qa: { result: 'fail', report: 'reports/phase-01-qa.md' },
    } as never),
    phase({
      phase: 2,
      state: 'waiting',
      title: 'contracts',
      row: { phase: 2, title: 'contracts', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
    }),
    phase({
      phase: 6,
      state: 'waiting',
      title: 'ship',
      gated: true,
      gateKind: 'auto',
      gates: 'the CD rail is armed',
    }),
  ];
  const parked = run({
    status: 'parked',
    phases: { 1: { phase: 1, status: 'done', attempts: 1 } },
    halt: { at: '', reason: 'nothing is ready to run', phase: 1, kind: 'plan-deadlocked' },
  } as never);

  it('names the QA verdict as the blocker', () => {
    const rows = waysForwardRows('demo', wedged, parked);
    const qaRow = rows.find((r) => r.phase === 1);
    expect(qaRow, 'the phase holding the plan must have a row').toBeTruthy();
    expect(qaRow!.why).toMatch(/QA/);
    expect(qaRow!.why).toMatch(/fail/);
    // What it holds, and where the report is.
    expect(qaRow!.why).toContain('which holds phase 2.');
    expect(qaRow!.why).toContain('reports/phase-01-qa.md');
  });

  it('does not lead with a downstream gate that is not the blocker', () => {
    const rows = waysForwardRows('demo', wedged, parked);
    expect(rows[0]?.phase, 'the real blocker comes first').toBe(1);
  });

  it('leaves a genuinely done phase alone when its QA has passed', () => {
    const clean: PhaseView[] = [
      phase({ phase: 1, state: 'done', title: 'backend', qa: { result: 'pass' } } as never),
      phase({ phase: 2, state: 'ready', title: 'contracts' }),
    ];
    expect(waysForwardRows('demo', clean, parked).some((r) => r.phase === 1)).toBe(false);
  });

  it('says nothing about QA when the plan does not gate on it', () => {
    const noQa: PhaseView[] = [phase({ phase: 1, state: 'done', title: 'backend' })];
    expect(waysForwardRows('demo', noQa, parked).some((r) => r.phase === 1)).toBe(false);
  });
});

/**
 * The run-level facts a stopped run could not say about itself (#37, #35),
 * measured on 2026-09-21: a run sat at 3 of a maximum 2 with nothing anywhere
 * that zeroed the number. The run-level ones are the halt card's; the raise
 * beside a phase's spent budget is this list's.
 */
describe('the raise beside the reason', () => {
  it('a live run says none of it — advice stacked on a moving run reads as alarm', () => {
    const { container } = mount(
      <RunWaysForward
        slug="demo"
        planPhases={[]}
        run={run({ status: 'running', consecutiveFailures: 1 })}
        live
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect(screen.queryByText(/failed in a row/)).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  /* ---------------------------------------------------------------- *
   * The raise beside the reason (control-tower phase 14, #40)
   * ---------------------------------------------------------------- */

  const waitFact = budgetFact({
    budget: 'wait',
    phase: 3,
    limit: 60,
    spent: 60,
    asked: 90,
    spentOn: [{ what: 'parked 09:00–10:00 UTC (session)', amount: 60 }],
    at: '2026-09-29T10:00:00.000Z',
  });
  const waitingOnBudget = run({
    status: 'waiting',
    phases: { '3': { phase: 3, status: 'waiting', attempts: 1, costUsd: 0 } },
    recoveries: {
      '3': {
        attempts: 0,
        lastAt: '',
        errand: {
          phase: 3,
          situation: 'waiting-external',
          tried: [],
          need: `${budgetHeadline(waitFact)} — it needs more wait budget for phase 3 to wait on a clock again`,
          how: 'It resumes its own session the moment gh:acme/app#run/42 lands.',
          at: waitFact.at,
          budget: waitFact,
        },
      },
    },
  } as unknown as Partial<RunState>);

  it('offers +30m, +60m and any amount for a spent wait budget, and raises in one press', async () => {
    post.mockImplementation(async (path: string) =>
      path === '/api/run/demo/raise-budget'
        ? { budget: 'wait', phase: 3, was: 60, now: 90, retried: true, run: null }
        : {},
    );
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 3, title: 'Cart API', state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
      { allowWrites: true },
    );
    // The first line says BUDGET with the arithmetic — never "waiting on CI".
    expect(
      screen.getAllByText(/^Wait budget spent — 60m wait budget · 60m accrued · 0m left · asked for 90m/)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/CI, a PR/)).toBeNull();
    expect(screen.getByRole('button', { name: '+30m' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+60m' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+30m' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/raise-budget', { budget: 'wait', phase: 3, add: 30 }),
    );
    expect(await screen.findByText(/Raised 60m → 90m and retried\./)).toBeTruthy();
  });

  it('raises a wait by any amount typed, and says why it cannot on a console without --allow-writes', async () => {
    post.mockImplementation(async (path: string) =>
      path === '/api/run/demo/raise-budget'
        ? { budget: 'wait', phase: 3, was: 60, now: 105, retried: true, run: null }
        : {},
    );
    const { unmount } = mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
      { allowWrites: true },
    );
    fireEvent.change(screen.getByLabelText('Raise by, in minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise and retry' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/raise-budget', { budget: 'wait', phase: 3, add: 45 }),
    );
    unmount();
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    expect((screen.getByRole('button', { name: '+30m' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/start the console with --allow-writes/)).toBeTruthy();
  });

  it('offers rungs for a spent recovery cap, and Clear the streak — never a raise — for the streak', async () => {
    post.mockResolvedValue({ budget: 'ladder', phase: 2, was: 12, now: 16, retried: true, run: null });
    const ladder = budgetFact({
      budget: 'ladder',
      phase: 2,
      limit: 12,
      spent: 12,
      unit: 'rungs',
      setting: 'ladderPerRunRungs',
    });
    const streak = budgetFact({ budget: 'streak', phase: 2, limit: 2, spent: 2 });
    mount(
      <RunWaysForward
        slug="demo"
        planPhases={[phase({ phase: 2, state: 'in-progress' })]}
        run={run({
          status: 'halted',
          consecutiveFailures: 2,
          maxConsecutiveFailures: 2,
          halt: { at: '', reason: '2 phases failed in a row', kind: 'failure-streak', budget: streak },
          phases: { '2': { phase: 2, status: 'parked', attempts: 1, costUsd: 0 } },
          recoveries: {
            '2': {
              attempts: 1,
              lastAt: '',
              errand: {
                phase: 2,
                situation: 'work-in-progress',
                tried: [],
                need: "The run's ladder budget is spent — 12 of 12 rungs.",
                how: 'Raise it.',
                at: '',
                budget: ladder,
              },
            },
          },
        } as unknown as Partial<RunState>)}
        live={false}
        authFailure={false}
        parts={PARTS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+4 rungs' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/raise-budget', { budget: 'ladder', phase: 2, add: 4 }),
    );
    // The streak is never raised; its Clear is the halt card's (`cards/halt-card.test.tsx`).
    expect(screen.queryByRole('button', { name: /\+2 phases/ })).toBeNull();
  });
});
