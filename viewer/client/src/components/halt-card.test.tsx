/**
 * The halt card: ONE rendering of why a run stopped (control-tower phase 17).
 *
 * What is pinned, criterion by criterion:
 *   2. the recommended button IS `recoveryActionsFor(ctx)[0]`, for a stop in
 *      every seeded family; a disabled one carries the server's sentence;
 *   5. the fix controls call their endpoints — the budget raise (+30m, +60m,
 *      any amount, dollars) and Clear the streak; the streak reads n/max; the
 *      cap errand shows its arithmetic and setting; Retry says it replenishes
 *      BEFORE the press;
 *   6. a `nothing-ready` card lists its holders, each with its own action;
 *   8. the cards that had no criterion, each drawn through this family —
 *      table-driven over the seeded families;
 *   9. the same block charged once is drawn as that block, never as fresh
 *      failures; 10. a retirement's evidence; 11. the blocker behind a gate.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/media', () => ({
  usePhone: () => false,
  useNarrow: () => false,
  useTouch: () => true,
  isPhone: () => true,
}));

const api = vi.hoisted(() => ({
  runRaiseBudget: vi.fn(),
  runClearStreak: vi.fn(),
  runPlanText: vi.fn(),
  runPlanDecision: vi.fn(),
  releaseBootHold: vi.fn(),
  runRetry: vi.fn(async () => ({ run: null })),
  runRecover: vi.fn(async () => ({ outcome: 'resumed', detail: 'ok', steps: [], run: null })),
  runMcpContinue: vi.fn(async () => ({ run: null })),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...api } };
});

import { budgetFact, budgetHeadline } from '@shared/budget-model.js';
import { CAUSE_SENTENCE, HALT_CATEGORY_LABELS } from '@shared/halt-categories.js';
import { haltCtx, haltView } from '@shared/halt-view.js';
import { FLAG_OFF, recoveryActionsFor } from '@shared/recovery-model.js';
import { TooltipProvider } from '@/components/ui';
import { keys, queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';
import { HaltCard } from './halt-card';
import { CrashLoopCard } from './halt-mark';
import { ErrandCard } from './errand';

const run = (over: Partial<RunState> & Record<string, unknown>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'halted',
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
    maxConsecutiveFailures: 4,
    consecutiveFailures: 0,
    ...over,
  }) as unknown as RunState;

function mount(node: React.ReactElement, flags: { allowRun?: boolean; allowWrites?: boolean } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: flags.allowRun ?? true,
    allowAgent: true,
    allowWrites: flags.allowWrites ?? true,
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

const h = (kind: string, reason: string, phase?: number, extra: Record<string, unknown> = {}) => ({
  at: '2026-09-29T09:00:00.000Z',
  kind,
  reason,
  ...(phase != null ? { phase } : {}),
  ...extra,
});

/** One stop per seeded family — the e2e seed's shapes (`e2e/fixture/seed.ts`). */
const SEEDED: Array<[string, RunState]> = [
  [
    'decision',
    run({
      slug: 'decide',
      status: 'parked',
      halt: h('needs-human', 'phase 2 needs a person: the deploy is signed by hand', 2),
      phases: { '2': { phase: 2, status: 'parked', attempts: 1, costUsd: 1, sessionId: 's2' } },
    } as never),
  ],
  [
    'credentials',
    run({ slug: 'signin', halt: h('credential-refused', 'the default account was refused at sign-in') }),
  ],
  ['limits', run({ slug: 'limits', halt: h('budget', 'the run spent its $25.00 budget') })],
  [
    'environment',
    run({
      slug: 'network',
      status: 'parked',
      halt: h('mcp-preflight', 'phase 1 needs the MCP server docs, which could not connect', 1),
      phases: { '1': { phase: 1, status: 'parked', attempts: 0, costUsd: 0 } },
    } as never),
  ],
  ['plan', run({ slug: 'repair', halt: h('plan-lint', 'the plan fails lint: F2 phase 4 depends on 9') })],
  [
    'verification',
    run({
      slug: 'verify',
      status: 'parked',
      halt: h('verify-failed', '§Verification was red: 3 of 41 tests failed', 2),
      phases: { '2': { phase: 2, status: 'failed', attempts: 1, costUsd: 3, sessionId: 's-v' } },
    } as never),
  ],
  [
    'external',
    run({
      slug: 'external',
      status: 'parked',
      halt: h('waiting-external-timeout', 'the deploy window closed before gh:acme/app#run/42 landed', 3),
      phases: { '3': { phase: 3, status: 'parked', attempts: 1, costUsd: 1, sessionId: 's-x' } },
    } as never),
  ],
  [
    'conflict',
    run({
      slug: 'restart',
      status: 'interrupted',
      halt: h('interrupted-by-restart', 'the console restarted while phase 2 was running', 2),
      phases: { '2': { phase: 2, status: 'interrupted', attempts: 1, costUsd: 1, sessionId: 's-r' } },
    } as never),
  ],
  [
    'operator',
    run({ slug: 'stopped', status: 'interrupted', halt: h('operator-stop', 'stopped by the operator') }),
  ],
];

const FLAGS = { allowRun: true, allowWrites: true, allowAgent: true };

beforeEach(() => vi.clearAllMocks());

describe('the card names the family, one sentence, and the ONE recommended recovery', () => {
  it.each(SEEDED)('%s: family, sentence and the recovery model’s first verb', (category, stopped) => {
    mount(<HaltCard run={stopped} />);
    const card = screen.getByTestId('halt-card');
    expect(card.getAttribute('data-halt-category')).toBe(category);
    expect(
      within(card).getAllByText(HALT_CATEGORY_LABELS[category as keyof typeof HALT_CATEGORY_LABELS])[0],
    ).toBeTruthy();
    const view = haltView(stopped, { flags: FLAGS })!;
    const sentence = within(card).getAllByTestId('halt-sentence')[0]!;
    expect(sentence.textContent).toBe(
      view.budget ? sentence.textContent : CAUSE_SENTENCE[stopped.halt!.kind!],
    );
    // Criterion 2: the button the card recommends IS the model's first verb.
    const first = recoveryActionsFor({
      ...haltCtx(stopped),
      flags: FLAGS,
      live: { recoverySessionId: null },
    })[0]!;
    const recommended = within(card).getByTestId('halt-recommended');
    expect(recommended.getAttribute('aria-label')).toBe(first.label);
    expect(recommended.getAttribute('data-recommended')).toBe(first.id);
    expect(view.recommended?.id).toBe(first.id);
    // The runner's own words are NOT the headline — they are one press away.
    expect(within(card).queryByTestId('halt-reason')).toBeNull();
  });

  it('a disabled recommendation carries the server’s sentence, never hides', () => {
    mount(<HaltCard run={SEEDED[5]![1]} />, { allowRun: false });
    const recommended = screen.getByTestId('halt-recommended');
    expect(recommended).toBeDisabled();
    fireEvent.click(screen.getByText(/More ways forward/));
    expect(screen.getAllByText(FLAG_OFF.run).length).toBeGreaterThan(0);
  });

  it('a live run shows the stop as history and offers nothing', () => {
    mount(<HaltCard run={SEEDED[5]![1]} live />);
    expect(screen.getByText(/picked this run back up/)).toBeTruthy();
    expect(screen.queryByTestId('halt-recommended')).toBeNull();
  });

  it('a declared external wall is the external family before any classifier names it', () => {
    // `needs-human --needs external`: the kind is a person's, the errand says
    // what kind of wall (control-tower phase 33, the tower rehearsal).
    const walled = run({
      slug: 'external-api',
      status: 'parked',
      halt: h('needs-human', 'phase 1 needs a person: the upstream service is down', 1),
      phases: { '1': { phase: 1, status: 'parked', attempts: 1, costUsd: 0, sessionId: 's-w' } },
      recoveries: {
        '1': {
          attempts: 0,
          lastAt: '',
          errand: {
            phase: 1,
            situation: 'blocked-declared:external',
            need: 'the upstream service is down',
            how: 'Retry once it is back.',
            tried: [],
            at: '',
          },
        },
      },
    } as never);
    mount(<HaltCard run={walled} />);
    const card = screen.getByTestId('halt-card');
    expect(card.getAttribute('data-halt-category')).toBe('external');
    expect(within(card).getAllByText(HALT_CATEGORY_LABELS.external)[0]).toBeTruthy();
  });

  it('the row variant folds to family, sentence and the recommended button', () => {
    mount(<HaltCard run={SEEDED[1]![1]} variant="row" />);
    const row = screen.getByTestId('halt-row');
    expect(row.getAttribute('data-halt-category')).toBe('credentials');
    expect(within(row).getByTestId('halt-sentence').textContent).toContain(
      CAUSE_SENTENCE['credential-refused'],
    );
    expect(within(row).getByTestId('halt-recommended')).toBeTruthy();
  });
});

describe('the fix controls call their endpoints (criterion 5)', () => {
  const waitFact = budgetFact({
    budget: 'wait',
    phase: 3,
    limit: 60,
    spent: 60,
    asked: 90,
    spentOn: [{ what: 'parked 09:00–10:00 UTC (session)', amount: 60 }],
    at: '2026-09-29T10:00:00.000Z',
  });
  const usdFact = budgetFact({
    budget: 'run-usd',
    limit: 20,
    spent: 20.4,
    spentOn: [{ what: 'phase 2', amount: 20.4 }],
    at: '2026-09-29T10:00:00.000Z',
  });

  it('a spent run budget leads with its arithmetic and raises by dollars, or any amount', async () => {
    api.runRaiseBudget.mockResolvedValue({
      budget: 'run-usd',
      phase: null,
      was: 20,
      now: 30,
      retried: true,
      run: null,
    });
    mount(
      <HaltCard
        run={run({
          slug: 'limits',
          halt: h('budget', 'the run budget of $20 is spent', undefined, { budget: usdFact }),
        })}
      />,
    );
    expect(screen.getByTestId('halt-sentence').textContent).toBe(budgetHeadline(usdFact, 'spent'));
    fireEvent.click(screen.getByRole('button', { name: '+$10.00' }));
    expect(api.runRaiseBudget).toHaveBeenCalledWith('limits', { budget: 'run-usd', add: 10 });
    expect(await screen.findByText(/Raised \$20\.00 → \$30\.00 and retried\./)).toBeTruthy();
  });

  it('a wait budget offers +30m, +60m and any amount typed', async () => {
    api.runRaiseBudget.mockResolvedValue({
      budget: 'wait',
      phase: 3,
      was: 60,
      now: 90,
      retried: true,
      run: null,
    });
    const stopped = run({
      slug: 'external',
      halt: h('budget', 'the wait budget of phase 3 is spent', 3, { budget: waitFact }),
    });
    mount(<HaltCard run={stopped} />);
    expect(screen.getByRole('button', { name: '+30m' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+60m' }));
    expect(api.runRaiseBudget).toHaveBeenCalledWith('external', { budget: 'wait', phase: 3, add: 60 });
    await screen.findByText(/and retried\./);
  });

  it('a typed amount raises by exactly that', () => {
    api.runRaiseBudget.mockResolvedValue({
      budget: 'wait',
      phase: 3,
      was: 60,
      now: 105,
      retried: false,
      run: null,
    });
    mount(<HaltCard run={run({ slug: 'external', halt: h('budget', 'spent', 3, { budget: waitFact }) })} />);
    fireEvent.change(screen.getByLabelText('Raise by, in minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise and retry' }));
    expect(api.runRaiseBudget).toHaveBeenCalledWith('external', { budget: 'wait', phase: 3, add: 45 });
  });

  it('a wait on a console without --allow-writes says why it cannot raise', () => {
    mount(<HaltCard run={run({ halt: h('budget', 'spent', 3, { budget: waitFact }) })} />, {
      allowWrites: false,
    });
    expect(screen.getByRole('button', { name: '+30m' })).toBeDisabled();
    expect(screen.getByText(/start the console with --allow-writes to raise it here/)).toBeTruthy();
  });

  it('the streak reads n/max and Clear the streak calls its endpoint', async () => {
    api.runClearStreak.mockResolvedValue({ was: 3 });
    mount(
      <HaltCard
        run={run({
          slug: 'demo',
          consecutiveFailures: 3,
          maxConsecutiveFailures: 4,
          halt: h('failure-streak', '3 phases failed in a row'),
        })}
      />,
    );
    const streak = screen.getByTestId('halt-streak');
    expect(streak.textContent).toContain('3/4');
    expect(streak.textContent).not.toContain('3/2');
    fireEvent.click(within(streak).getByRole('button', { name: 'Clear the streak' }));
    expect(api.runClearStreak).toHaveBeenCalledWith('demo');
    expect(await screen.findByText(/Cleared — the count was 3\./)).toBeTruthy();
  });

  it('the cap errand shows its arithmetic and setting, and Retry says it replenishes BEFORE the press', () => {
    mount(
      <ErrandCard
        errand={{
          phase: 4,
          situation: 'resource-wall:budget',
          tried: ['reboard-fresh', 'continue'],
          need: "This phase's ladder budget is spent — 20 of 20 rungs.",
          how: 'Raise the run rung cap, or Retry the phase.',
          at: '2026-09-29T09:00:00.000Z',
          cap: 'run-rungs',
          spent: 20,
          limit: 20,
          onDonePhases: 19,
          setting: 'ladderMaxRunRungs',
          replenishes: true,
        }}
      />,
    );
    expect(screen.getByTestId('errand-cap').textContent).toBe(
      '20 of 20 rungs spent — 19 of them on phases already done; raised by ladderMaxRunRungs',
    );
    expect(screen.getByTestId('errand-replenishes').textContent).toMatch(
      /A Retry of this phase gives the cap back/,
    );
  });
});

describe('a nothing-ready card lists its holders, each with its own single action (criterion 6)', () => {
  const holders = [
    {
      phase: 2,
      kind: 'gate',
      verb: 'approve-gate',
      why: 'phase 2 is gated (manual: sign-off)',
      gateKind: 'manual',
    },
    {
      phase: 3,
      kind: 'gate',
      verb: 'approve-gate',
      why: 'phase 3 waits on plan vca:11',
      gateKind: 'blocked',
    },
    { phase: 4, kind: 'mcp', verb: 'mcp-continue', why: 'phase 4 waits on the docs server' },
    { phase: 5, kind: 'retry', verb: 'retry', why: 'phase 5 is failed' },
  ];
  it('one row per holder, one action per row', async () => {
    mount(
      <HaltCard
        run={run({
          slug: 'held',
          status: 'parked',
          halt: h('nothing-ready', 'nothing left to run: …', undefined, { holders }),
        })}
      />,
    );
    const rows = screen.getAllByTestId('halt-holder');
    expect(rows.map((row) => row.getAttribute('data-holder-kind'))).toEqual(['gate', 'gate', 'mcp', 'retry']);
    for (const row of rows) expect(within(row).getAllByTestId('halt-holder-action')).toHaveLength(1);
    expect(within(rows[0]!).getByText('Open the gate')).toBeTruthy();
    // A machine's gate is looked at again, never "approved".
    expect(within(rows[1]!).getByText('Look again')).toBeTruthy();
    expect(within(rows[1]!).getByText('Automatic gate')).toBeTruthy();
    fireEvent.click(within(rows[3]!).getByText('Retry'));
    await waitFor(() => expect(api.runRetry).toHaveBeenCalledWith('held', 5));
  });

  it('#150 ask 4: a cross-plan gate names the blocker behind the blocker, with phases left and ETA', () => {
    const chained = [
      {
        phase: 4,
        kind: 'gate',
        verb: 'approve-gate',
        why: 'phase 4 waits on plan vca:11',
        gateKind: 'blocked',
        chain: [
          { label: 'tamagui P4' },
          { label: 'vca P11' },
          { label: 'storefront run', phasesLeft: 13, eta: '18:40' },
        ],
      },
    ];
    mount(
      <HaltCard
        run={run({
          slug: 'tamagui',
          status: 'parked',
          halt: h('nothing-ready', 'x', undefined, { holders: chained }),
        })}
      />,
    );
    expect(screen.getByTestId('halt-chain').textContent).toBe(
      'tamagui P4 → vca P11 → storefront run (13 phases left, ETA 18:40)',
    );
  });
});

/** Criterion 8 — the cards that had no criterion, each drawn through this family. */
describe('the cards that had no criterion, each through the family (criterion 8)', () => {
  const CASES: Array<{
    name: string;
    issue: string;
    stopped: RunState;
    expect: (card: HTMLElement) => void;
  }> = [
    {
      name: 'every account unusable',
      issue: '#35',
      stopped: run({
        slug: 'signin',
        halt: h('credential-refused', 'refused', undefined, { accounts: { unusable: 2, total: 2 } }),
      }),
      expect: (card) =>
        expect(within(card).getByTestId('halt-accounts').textContent).toMatch(
          /Every Claude account registered here is unusable \(2 of 2\)/,
        ),
    },
    {
      name: 'the protected-path act and path',
      issue: '#43',
      stopped: run({
        slug: 'decide',
        status: 'parked',
        halt: h('phase-blocked', 'phase 2 blocked: the CLI refused an edit to .claude/settings.json', 2),
        phases: {
          '2': {
            phase: 2,
            status: 'parked',
            attempts: 1,
            costUsd: 0,
            situation: { key: 'blocked-declared:protected-path', at: '' },
          },
        },
      } as never),
      expect: (card) =>
        expect(within(card).getByTestId('halt-protected').textContent).toMatch(/\.claude\/settings\.json/),
    },
    {
      name: 'the {repo, branch, head} line on a verify-failed stop',
      issue: '#41',
      stopped: run({
        slug: 'verify',
        status: 'parked',
        halt: h('verify-failed', 'red', 2),
        phases: {
          '2': {
            phase: 2,
            status: 'failed',
            attempts: 1,
            costUsd: 1,
            verification: {
              ok: false,
              reason: 'red',
              notRun: [],
              ran: [
                {
                  command: 'npm test',
                  ok: false,
                  code: 1,
                  tree: { repo: 'phased-execution', branch: 'pe/control-tower', head: '6664294d1234' },
                },
              ],
            },
          },
        },
      } as never),
      expect: (card) =>
        expect(within(card).getAllByTestId('halt-tree')[0]!.textContent).toBe(
          'on phased-execution · pe/control-tower · 6664294d',
        ),
    },
    {
      name: 'the own-lock watch refusal, and every ref refused',
      issue: '#42 #19',
      stopped: run({
        slug: 'external',
        status: 'parked',
        halt: h('phase-blocked', 'blocked on its own lock', 3),
        phases: {
          '3': {
            phase: 3,
            status: 'parked',
            attempts: 1,
            costUsd: 0,
            watch: ['lock:external/3'],
            watchState: {
              at: '',
              refs: [
                {
                  ref: 'lock:external/3',
                  scheme: 'lock',
                  state: 'refused',
                  detail: "names phase 3's own lock — a lock: watch is for a lock held by someone else",
                  checkedAt: '',
                },
              ],
            },
          },
        },
      } as never),
      expect: (card) =>
        expect(within(card).getByTestId('halt-refused-watch').textContent).toMatch(/every one was refused/),
    },
    {
      name: 'a retirement’s evidence',
      issue: '#57',
      stopped: run({
        slug: 'signin',
        halt: h('credential-refused', 'refused', undefined, {
          evidence: {
            source: 'api',
            matched: 'authentication_failed',
            session: 'abcdef1234',
            phase: 3,
            slug: 'signin',
          },
        }),
      }),
      expect: (card) =>
        expect(within(card).getByTestId('halt-evidence').textContent).toBe(
          'The API returned “authentication_failed” — signin · phase 3 · session abcdef12.',
        ),
    },
    {
      name: 'the same block charged once is that block',
      issue: '#42 (phase 87)',
      stopped: run({
        slug: 'verify',
        consecutiveFailures: 1,
        maxConsecutiveFailures: 4,
        failureRoots: [
          { phase: 4, key: 'wip:abc', label: 'phase 3’s red WIP abc1234' },
          { phase: 5, key: 'wip:abc', label: 'phase 3’s red WIP abc1234' },
        ],
        halt: h('failure-streak', 'phases 4 and 5 failed'),
      } as never),
      expect: (card) => {
        const roots = within(card).getByTestId('halt-roots');
        expect(roots.querySelectorAll('li')).toHaveLength(1);
        expect(roots.textContent).toMatch(/one cause, charged once, which stopped phases 4, 5/);
      },
    },
  ];
  it.each(CASES)('$issue — $name', ({ stopped, expect: check }) => {
    mount(<HaltCard run={stopped} />);
    check(screen.getByTestId('halt-card'));
  });

  it('#34 — the plan-approval card reads the captured plan, not a byte count, and approves it', async () => {
    api.runPlanText.mockResolvedValue({
      ok: true,
      phase: 2,
      sha: 'abc',
      bytes: 2048,
      at: '',
      state: 'pending',
      truncated: false,
      text: '# The plan\n\n1. Split the parser from the writer.',
    });
    api.runPlanDecision.mockResolvedValue({ ok: true, decision: 'approve', sha: 'abc' });
    mount(
      <HaltCard
        run={run({
          slug: 'decide',
          status: 'parked',
          halt: h('plan-approval', 'phase 2 presented a plan (2048 bytes)', 2),
          phases: { '2': { phase: 2, status: 'parked', attempts: 1, costUsd: 0 } },
        } as never)}
      />,
    );
    expect(await screen.findByText('Split the parser from the writer.')).toBeTruthy();
    expect(api.runPlanText).toHaveBeenCalledWith('decide', 2);
    expect(screen.getByTestId('plan-reader').textContent).not.toMatch(/2048 bytes/);
    fireEvent.click(screen.getByRole('button', { name: 'Approve the plan' }));
    await waitFor(() =>
      expect(api.runPlanDecision).toHaveBeenCalledWith('decide', { phase: 2, decision: 'approve' }),
    );
  });

  it('#20 — the crash-loop card is the family’s, with its one recovery', async () => {
    api.releaseBootHold.mockResolvedValue({ ok: true, bootHold: null });
    mount(
      <CrashLoopCard
        hold={{ kind: 'crash-loop', why: 'this console ended hard 3 times since 09:00' }}
        allowRun
      />,
    );
    const card = screen.getByTestId('halt-card');
    expect(card.getAttribute('data-halt-category')).toBe('environment');
    expect(screen.getByText(/ended hard 3 times/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('halt-recommended'));
    await waitFor(() => expect(api.releaseBootHold).toHaveBeenCalled());
  });
});
