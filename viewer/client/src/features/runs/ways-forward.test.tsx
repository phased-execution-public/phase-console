/**
 * The "way forward" card: every stopped phase's cause in its own words, next
 * to the one action that moves it. What is pinned is the honesty contract —
 * the handoff's Outstanding text speaks for a blocked phase, the gate's own
 * conditions speak for a gated one (and nothing offers to bypass it), and a
 * failed record gets the recovery class its evidence supports.
 *
 * Two more, added after a plan that had never run was told it was stopped: a
 * gate speaks only where it is the PROXIMATE blocker (ready, or a record that
 * stopped on it — never a waiting phase eleven dependencies down), and a card
 * with no run behind it is titled as a checklist rather than an incident.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { keys, queryClientConfig } from '@/lib/queries';
import { TooltipProvider } from '@/components/ui';
import type { PhaseView, RunState } from '@/lib/api';
import { budgetFact, budgetHeadline } from '@shared/budget-model.js';
import { NextSteps, nextStepRows } from './ways-forward';

const { runRecheck, runClearStreak, runRaiseBudget } = vi.hoisted(() => ({
  runRecheck: vi.fn(),
  runClearStreak: vi.fn(),
  runRaiseBudget: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runRecheck, runClearStreak, runRaiseBudget } };
});

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

describe('nextStepRows', () => {
  it('lets a blocked handoff speak for itself, and routes it to plan-repair', () => {
    const rows = nextStepRows(
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
    expect(rows[0].why).toContain('One exit criterion is unmet');
    expect(rows[0].stuck).toBe(true);
    expect(rows[0].retry).toBeUndefined();
  });

  it('quotes the gate for a gated phase and offers only a re-check, never a bypass', () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true, gates: 'operator confirms the auth-off rail' })],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain('operator confirms the auth-off rail');
    expect(rows[0].retry).toBe('rechecks-gate');
    expect(rows[0].record).toBeUndefined();
  });

  it('says nothing about a gate on a phase whose turn has not come', () => {
    // `gated` is orthogonal to the bucket, so a WAITING phase carries the flag
    // while its dependencies are what hold it. Naming the gate there answers a
    // question nobody asked and hides the one that matters.
    const rows = nextStepRows(
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
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 12, state: 'waiting', gated: true, gates: 'operator signs the release off' })],
      run({
        phases: {
          12: { phase: 12, status: 'gated', attempts: 0, costUsd: 0, note: 'gate not clear: manual' },
        },
      } as never),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].retry).toBe('rechecks-gate');
  });

  it("an ai gate says the session clears it itself — it is not a person's job", () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 2, state: 'ready', gated: true, gateKind: 'ai', gates: 'staging deployed' })],
      null,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain('verifies and clears it itself');
    expect(rows[0].why).toContain('staging deployed');
  });

  it('a record the runner held as gated still surfaces, quoting its note', () => {
    const rows = nextStepRows(
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

    expect(rows[0].why).toContain('mint the fixture keys');
    expect(rows[0].retry).toBe('rechecks-gate');
  });

  it("prefers the runner's own parked note when the record has one", () => {
    const rows = nextStepRows(
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

    expect(rows[0].why).toContain('confirm the rollout window');
  });

  it('gives a failed record its recovery class and a Retry that restarts', () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 3, state: 'ready', title: 'Ship' })],
      run({
        halt: { at: '', reason: 'phase 3 did not verify: 1 of 1 command(s) failed — false', phase: 3 },
        phases: { 3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0 } },
      } as never),
    );

    expect(rows[0].record).toEqual({ status: 'failed', resumable: false });
    expect(rows[0].retry).toBe('restarts');
    expect(rows[0].why).toContain('did not verify');
  });

  it('says nothing about phases that are done or genuinely in flight', () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 1, state: 'done' }), phase({ phase: 2, state: 'ready' })],
      null,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('NextSteps', () => {
  function mount(node: React.ReactElement) {
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(keys.state(), {
      allowRun: true,
      allowAgent: true,
      allowWrites: false,
      autopilot: true,
      root: { ok: true, path: '/repo' },
    });
    client.setQueryData(keys.terminal(), {
      allowed: false,
      agentAllowed: true,
      available: 'yes',
      sessions: [],
    });
    return render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('renders a stuck phase with Repair the plan with a new agent, and a gated one with its confirmation chip', async () => {
    runRecheck.mockResolvedValue({});
    mount(
      <NextSteps
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
      />,
    );

    // No run has ever existed here, so nothing has stopped — the same rows,
    // under the heading that says what they are.
    expect(screen.getByText(/Before this plan can run/)).toBeInTheDocument();
    expect(screen.queryByText(/Why this is stopped/)).not.toBeInTheDocument();
    expect(screen.getByText(/shutdown acceptance test needs a human/)).toBeInTheDocument();
    // The button now opens the launch dialog rather than firing on one click —
    // the operator gets to shape the session before it exists.
    fireEvent.click(screen.getByRole('button', { name: /Repair the plan with a new agent/i }));
    // `findBy`, not `getBy`: the dialog is the run-setup surface and it is
    // `lazy()` since Phase 4 — 77.6 KB that used to be downloaded by everyone
    // who opened a plan, to render on a press. It arrives a microtask after the
    // click rather than in the same frame.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText(/Repair the plan with a new agent/i).length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(screen.getByText(/confirm the window/)).toBeInTheDocument();
    expect(screen.getByText(/needs your confirmation/)).toBeInTheDocument();
    // The gated row's own Retry button is gone: every remedy is rendered by
    // `RecoveryActions` now, and a gate is RE-CHECKED rather than retried —
    // which is also the verb the server has always had for it.
    fireEvent.click(screen.getByRole('button', { name: /Re-check/i }));
    expect(runRecheck).toHaveBeenCalledWith('demo', 2);
  });

  it('keeps the incident heading once a run exists', () => {
    mount(
      <NextSteps
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'ready', title: 'Ship' })]}
        run={run({
          halt: { at: '', reason: 'phase 3 did not verify', phase: 3 },
          phases: { 3: { phase: 3, status: 'failed', attempts: 1, costUsd: 0 } },
        } as never)}
        live={false}
        authFailure={false}
      />,
    );
    expect(screen.getByText(/Why this is stopped/)).toBeInTheDocument();
  });

  it('renders no card at all for a plan that has never run and has nothing to answer', () => {
    // The reported shape (`aug-create-order-filters-remediation`): eleven
    // waiting phases and a twelfth that is waiting AND gated. Nothing has
    // stopped, nothing is held by a person — the card must not exist.
    const waiting = Array.from({ length: 11 }, (_, i) =>
      phase({ phase: i + 1, state: 'waiting', title: `Phase ${i + 1}` }),
    );
    const { container } = mount(
      <NextSteps
        slug="demo"
        planPhases={[
          ...waiting,
          phase({ phase: 12, state: 'waiting', gated: true, gates: 'the operator signs the release off' }),
        ]}
        run={null}
        live={false}
        authFailure={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the run is live — the tabs are the truth then', () => {
    const { container } = mount(
      <NextSteps
        slug="demo"
        planPhases={[phase({ phase: 5, state: 'stuck' })]}
        run={null}
        live
        authFailure={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('failed here, finished elsewhere', () => {
  it('explains a red record on a green phase instead of offering to fix it', () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 1, state: 'done', title: 'Editor truth' })],
      run({
        phases: {
          1: { phase: 1, status: 'failed', attempts: 1, costUsd: 0, note: 'no configuration file provided' },
        },
      } as never),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].why).toContain("this run's own attempt stopped");
    expect(rows[0].why).toContain('no configuration file provided');
    expect(rows[0].why).toContain('nothing needs fixing');
    expect(rows[0].why).toContain('reconciles to done');
    expect(rows[0].record).toBeUndefined();
    expect(rows[0].retry).toBeUndefined();
  });

  it('stays quiet about done phases whose record is clean', () => {
    const rows = nextStepRows(
      'demo',
      [phase({ phase: 1, state: 'done' })],
      run({ phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 } } } as never),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("nextStepRows — the ladder's errand", () => {
  it("leads a row with the errand's ask, and carries the record's situation for the strip", () => {
    const errand = {
      phase: 4,
      situation: 'blocked-declared:unknown',
      tried: ['unblock-session → failed'],
      need: "A reading of the session's Outstanding section.",
      how: 'Clear what it names, then Resume or Retry.',
      at: '',
    };
    const rows = nextStepRows(
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
    expect(rows[0].why).toBe(errand.need);
    expect(rows[0].errand).toEqual(errand);
    expect(rows[0].record).toEqual({
      status: 'pending',
      resumable: false,
      situation: { key: 'blocked-declared:unknown' },
    });
    expect(rows[0].retry).toBe('restarts');
  });
});

describe('a plan wedged by a QA verdict', () => {
  // The measured shape. Phase 1 finished, its QA verdict is `fail`, and that
  // holds every dependent — so the board has nothing ready and the plan is
  // dead. `nextStepRows` walked the plan's phases and matched NONE of it:
  // phase 1 `continue`d out at the `state === 'done'` branch (its record reads
  // done too, so the red-record-on-green-phase branch did not fire either), and
  // the waiting phases have no record. The single row it produced was for a
  // DOWNSTREAM gated phase — already approved, six dependencies away — so the
  // card titled "Why this is stopped" named a cause that was not the cause.
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
    const rows = nextStepRows('demo', wedged, parked);
    const qaRow = rows.find((r) => r.phase === 1);
    expect(qaRow, 'the phase holding the plan must have a row').toBeTruthy();
    expect(qaRow!.why).toMatch(/QA/);
    expect(qaRow!.why).toMatch(/fail/);
  });

  it('does not lead with a downstream gate that is not the blocker', () => {
    const rows = nextStepRows('demo', wedged, parked);
    expect(rows[0]?.phase, 'the real blocker comes first').toBe(1);
  });

  it('leaves a genuinely done phase alone when its QA has passed', () => {
    const clean: PhaseView[] = [
      phase({ phase: 1, state: 'done', title: 'backend', qa: { result: 'pass' } } as never),
      phase({ phase: 2, state: 'ready', title: 'contracts' }),
    ];
    expect(nextStepRows('demo', clean, parked).some((r) => r.phase === 1)).toBe(false);
  });

  it('says nothing about QA when the plan does not gate on it', () => {
    const noQa: PhaseView[] = [phase({ phase: 1, state: 'done', title: 'backend' })];
    expect(nextStepRows('demo', noQa, parked).some((r) => r.phase === 1)).toBe(false);
  });
});

/**
 * The run-level facts a stopped run could not say about itself (#37, #35).
 *
 * Both were measured on 2026-09-21. A run sat at 3 of a maximum 2 with nothing
 * anywhere that zeroed the number, and four runs read "halted — the API
 * refused this credential" while the fact that EVERY account on the machine
 * was unusable — so there was nothing to switch to — lived on another page.
 */
describe('the run-level strip', () => {
  function mountCard(node: React.ReactElement, flags: { allowWrites?: boolean } = {}) {
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
    return render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('a live run says none of it — advice stacked on a moving run reads as alarm', () => {
    mountCard(
      <NextSteps
        slug="demo"
        planPhases={[]}
        run={run({ status: 'running', consecutiveFailures: 1 })}
        live
        authFailure={false}
      />,
    );
    expect(screen.queryByText(/failed in a row/)).toBeNull();
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
    runRaiseBudget.mockResolvedValue({
      budget: 'wait',
      phase: 3,
      was: 60,
      now: 90,
      retried: true,
      run: null,
    });
    mountCard(
      <NextSteps
        slug="demo"
        planPhases={[phase({ phase: 3, title: 'Cart API', state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
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
    expect(runRaiseBudget).toHaveBeenCalledWith('demo', { budget: 'wait', phase: 3, add: 30 });
    expect(await screen.findByText(/Raised 60m → 90m and retried\./)).toBeTruthy();
  });

  it('raises a wait by any amount typed, and says why it cannot on a console without --allow-writes', () => {
    runRaiseBudget.mockClear();
    runRaiseBudget.mockResolvedValue({
      budget: 'wait',
      phase: 3,
      was: 60,
      now: 105,
      retried: true,
      run: null,
    });
    const { unmount } = mountCard(
      <NextSteps
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
      />,
      { allowWrites: true },
    );
    fireEvent.change(screen.getByLabelText('Raise by, in minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise and retry' }));
    expect(runRaiseBudget).toHaveBeenCalledWith('demo', { budget: 'wait', phase: 3, add: 45 });
    unmount();
    mountCard(
      <NextSteps
        slug="demo"
        planPhases={[phase({ phase: 3, state: 'in-progress' })]}
        run={waitingOnBudget}
        live={false}
        authFailure={false}
      />,
    );
    expect((screen.getByRole('button', { name: '+30m' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/start the console with --allow-writes/)).toBeTruthy();
  });

  it('offers rungs for a spent recovery cap, and Clear the streak — never a raise — for the streak', () => {
    runRaiseBudget.mockClear();
    const ladder = budgetFact({
      budget: 'ladder',
      phase: 2,
      limit: 12,
      spent: 12,
      unit: 'rungs',
      setting: 'ladderPerRunRungs',
    });
    const streak = budgetFact({ budget: 'streak', phase: 2, limit: 2, spent: 2 });
    mountCard(
      <NextSteps
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
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+4 rungs' }));
    expect(runRaiseBudget).toHaveBeenCalledWith('demo', { budget: 'ladder', phase: 2, add: 4 });
    // The streak is never raised; its Clear is the halt card's (control-tower
    // phase 17, `components/halt-card.test.tsx`).
    expect(screen.queryByRole('button', { name: /\+2 phases/ })).toBeNull();
  });
});
