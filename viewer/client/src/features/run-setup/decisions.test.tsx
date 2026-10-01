/**
 * The Decisions tile (phase 11 — ZTD-2, gate ACC-1.2; a quick-view tile since
 * control-tower phase 22): an outstanding blocking row disables Launch, names
 * itself and makes the tile the summons; the answers the door requires are in
 * the tile, and the account pool beside the account, in Accounts;
 * acknowledging a waived row (or the missing channel) clears its block; a
 * signed override re-enables Launch and rides the payload; the manifest and
 * the probes render as the console resolved them; and the door's advice that
 * this run take a checkout of its own (probe 6) is a banner with its action.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISOLATED } from '@shared/worktree-model.js';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  plan: vi.fn(),
  verifyPreflight: vi.fn(),
  policy: vi.fn(),
  accounts: vi.fn(),
  mcp: vi.fn(),
  isolationPreflight: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  value: '',
  owner: 'operator',
  state: 'answered',
  blocking: 'no',
  source: 'plan',
  origin: 'plan',
  ...over,
});

const PROBES_OK = {
  accounts: { status: 'ok', ok: true, reason: '1 of 1 declared account usable: the machine login' },
  mcp: { status: 'skip', ok: true, reason: 'no MCP server named' },
  credentials: { status: 'ok', ok: true, reason: '1 of 1 credential held' },
  delivery: { status: 'ok', ok: true, reason: '1 subscribed device' },
};

function prelude(over: Record<string, unknown> = {}) {
  return {
    slug: 'alpha',
    rows: [
      row('credentials', { value: '`gh`; credential policy: require', blocking: 'yes' }),
      row('gates', { value: 'delegated', origin: 'default', source: 'default' }),
    ],
    probes: PROBES_OK,
    blocking: [],
    waived: [],
    acknowledged: [],
    manifestPresent: true,
    accounts: [{ id: 'default', minHeadroomPct: 20 }],
    credentials: { policy: 'require', ids: ['gh'], held: ['gh'], missing: [] },
    delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
    at: '2026-09-14T00:00:00.000Z',
    ...over,
  };
}

async function mount() {
  mocks.state.mockResolvedValue({ prefs: {}, defaultSkills: [], allowAgent: true, allowRun: true });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  const Setup = RunSetup as unknown as (p: Record<string, unknown>) => React.ReactElement;
  const view = render(
    <QueryClientProvider client={client}>
      <Setup
        mode="start"
        context={{ slug: 'alpha', run: null }}
        planPhases={[]}
        qaMode="off"
        allowWrites
        overlay={{ open: true, onOpenChange: () => {}, title: 'Start a run', description: 'A test.' }}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Start' });
  return view;
}

/** Press a tile's verb — Edit, or Answer while the tile is the summons. */
const tile = async (label: string) =>
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^(Edit|Answer) ${label}$`) }));
/** An expanded tile's controls. */
const region = (label: string) => screen.getByRole('region', { name: label });
/** The one Launch, in the dialog's fixed footer. */
const launch = () => screen.getByTestId('launch-submit');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.skills.mockResolvedValue([]);
  mocks.runStart.mockResolvedValue({ run: { id: 'r-new', slug: 'alpha' } });
  mocks.plan.mockResolvedValue({
    summary: {
      slug: 'alpha',
      title: 'Alpha plan',
      kind: 'plan',
      phases: 1,
      done: 0,
      ready: [1],
      waiting: 0,
      inProgress: [],
      stuck: [],
      percent: 0,
      remainingWeight: 100_000,
      remainingSessions: 1,
      criticalPath: [1],
      criticalWeight: 0,
      minimumSessions: 1,
      budget: 200_000,
      skills: [],
      mcpServers: [],
      qaMode: 'off',
      qaFailures: [],
      locks: [],
      repos: ['api'],
      handoffCount: 0,
      issues: [],
      issueCounts: { error: 0, warning: 0, info: 0 },
      hasHandoffs: false,
      activity: 0,
    },
    plan: null,
    phases: [{ phase: 1, title: 'the schema', state: 'ready', size: 'S', weight: 100_000, gated: false }],
    route: { nodes: [], edges: [], layers: 0, rows: 0 },
    batches: { groups: [], raw: '', budget: '200K' },
    boardText: '',
    lint: null,
    handoffs: [],
    index: [],
  });
  mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '2026-09-14T00:00:00Z' });
  mocks.policy.mockResolvedValue({
    defaults: { deny: [], ask: [], allow: [] },
    extra: { deny: [], ask: [], allow: [] },
    plan: null,
    effective: { deny: [], ask: [], allow: [] },
    file: '',
    profiles: [],
    inert: [],
    support: [],
    hookTools: [],
    wrappersNotStripped: [],
  });
  mocks.accounts.mockResolvedValue({ accounts: [], allowAccounts: false });
  mocks.mcp.mockResolvedValue({ servers: [], allowMcp: false });
  mocks.isolationPreflight.mockResolvedValue({ available: true, kind: 'checkout', multiRepo: false });
});

describe('the Decisions tile', () => {
  it('holds the answers the door requires, the manifest and the probes — and the pool sits beside the account', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [
          row('credentials', { value: '`gh`; credential policy: require', blocking: 'yes' }),
          // The plan's own `**Accounts:**` clause — what the pool is seeded from.
          row('accounts', { value: '`default:20`' }),
          row('gates', { value: 'delegated', origin: 'default', source: 'default' }),
        ],
      }),
    });
    await mount();
    // Nothing is open, so the tile is not the summons: its verb is Edit.
    await tile('Decisions');
    const decisions = region('Decisions');
    expect(within(decisions).getByText('What the door requires')).toBeTruthy();
    expect(
      within(decisions).getByRole('checkbox', { name: /If the console restarts, continue this run/ }),
    ).toBeTruthy();
    expect(within(decisions).getByLabelText('Relay questions to a person')).toBeTruthy();
    // The manifest, row by row, with its state and where it came from.
    const manifest = await within(decisions).findByRole('list', { name: 'Decision manifest' });
    expect(within(manifest).getByText('credentials')).toBeTruthy();
    expect(within(manifest).getByText('blocks a start')).toBeTruthy();
    expect(within(manifest).getAllByText('from the plan').length).toBeGreaterThan(0);
    expect(within(manifest).getByText('the shipped default')).toBeTruthy();
    // The probes.
    const probes = within(decisions).getByRole('list', { name: 'Probe verdicts' });
    expect(within(probes).getByText(/1 of 1 credential held/)).toBeTruthy();
    expect(within(probes).getByText(/no MCP server named/)).toBeTruthy();
    // The account pool is asked beside the account since control-tower phase
    // 22, not here. It is seeded from the prelude's resolved clause — the
    // plan's `default:20` — and reads as the plan's word, not a change.
    expect(within(decisions).queryByLabelText(/Accounts it may spend/)).toBeNull();
    await tile('Accounts');
    const pool = await within(region('Accounts')).findByDisplayValue('default:20');
    expect(pool).toHaveAccessibleName('Accounts it may spend (id:minimum headroom %)');
    expect(pool).toHaveAccessibleDescription(/from the plan$/);
    // Nothing is open: Launch is live, and the payload carries the answers.
    const start = launch();
    expect(start).toHaveAccessibleName('Start');
    expect(start.hasAttribute('disabled')).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const body = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.resumeOnRestart).toBe(true);
    expect(body.relay).toBe('off');
    expect(body.accounts).toEqual([{ id: 'default', minHeadroomPct: 20 }]);
    expect('manifestOverride' in body).toBe(false);
  });

  it('Launch waits for the prelude’s first answer — a fresh start sends the account list it resolves', async () => {
    // Pressed before the prelude answered, the start door refused the launch
    // with a 400 — "accounts is required" — because the button was live while
    // the field it fills was still empty (control-tower phase 33, the tower
    // rehearsal's quick start).
    let answer: (value: unknown) => void = () => {};
    mocks.runPrelude.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await mount();
    expect(launch()).toBeDisabled();
    expect(launch().getAttribute('title')).toMatch(/decisions/i);
    fireEvent.click(launch());
    expect(mocks.runStart).not.toHaveBeenCalled();
    answer({ prelude: prelude() });
    await waitFor(() => expect(launch()).not.toBeDisabled());
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const body = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.accounts).toEqual([{ id: 'default', minHeadroomPct: 20 }]);
  });

  it('a prelude that could not be read holds nothing — the door then says what is missing', async () => {
    mocks.runPrelude.mockRejectedValue(new Error('the prelude could not be read'));
    await mount();
    await waitFor(() => expect(launch()).not.toBeDisabled());
  });

  it('a blocking decision turns the Decisions tile into the summons and disables Launch with its reason', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [row('credentials', { state: 'outstanding', blocking: 'yes', owner: 'the operator' })],
        blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
      }),
    });
    await mount();
    // The tile is the summons: its verb is Answer, its row says so, and it is the only one.
    const answer = await screen.findByRole('button', { name: 'Answer Decisions' });
    const summons = answer.closest('li[data-category]')!;
    expect(summons.getAttribute('data-category')).toBe('decisions');
    expect(summons.getAttribute('data-summons')).toBe('true');
    expect(within(summons as HTMLElement).getByText('1 open')).toBeTruthy();
    expect(document.querySelectorAll('li[data-summons]')).toHaveLength(1);
    // The finding is a banner above the tiles, naming the row.
    const banner = (await screen.findByText('Launch waits for a decision.')).closest('[role="status"]')!;
    expect(banner.textContent).toMatch(/credentials — outstanding — owed by the operator/);
    // Launch is held, and its title says why.
    const start = launch();
    expect(start).toBeDisabled();
    expect(start.getAttribute('title')).toContain('Decision outstanding: credentials');
    // The banner's own action opens the summons.
    fireEvent.click(within(banner as HTMLElement).getByRole('button', { name: 'Answer' }));
    expect(within(region('Decisions')).getByTestId('decisions-blocking')).toBeTruthy();
  });

  it('an outstanding blocking row disables Launch and names it — whichever tile is open', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [row('credentials', { state: 'outstanding', blocking: 'yes', owner: 'the operator' })],
        blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
      }),
    });
    await mount();
    const start = launch();
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true));
    expect(start.getAttribute('title')).toMatch(
      /Decision outstanding: credentials — outstanding — owed by the operator/,
    );
    await tile('Decisions');
    const banner = await within(region('Decisions')).findByTestId('decisions-blocking');
    expect(banner.textContent).toMatch(
      /One decision is still open — Launch is disabled until each is answered/,
    );
    expect(banner.textContent).toMatch(/credentials — outstanding — owed by the operator/);
    // The footer names it with another tile open too, and nothing is posted.
    await tile('Engine');
    expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
    expect(
      screen.getByText('Decision outstanding: credentials — outstanding — owed by the operator'),
    ).toBeTruthy();
    expect(launch().hasAttribute('disabled')).toBe(true);
    fireEvent.click(launch());
    expect(mocks.runStart).not.toHaveBeenCalled();
  });

  it('a signed override re-enables Launch and rides the payload as who signed it', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [row('credentials', { state: 'outstanding', blocking: 'yes', owner: 'the operator' })],
        blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
      }),
    });
    await mount();
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(true));
    await tile('Decisions');
    fireEvent.change(within(region('Decisions')).getByLabelText('Start anyway, recorded as'), {
      target: { value: 'the operator' },
    });
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(false));
    expect(within(region('Decisions')).getByTestId('decisions-blocking').textContent).toMatch(
      /recorded as an override/,
    );
    // Signed, nothing is waiting any more: the banner above the tiles is gone.
    expect(screen.queryByText('Launch waits for a decision.')).toBeNull();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).manifestOverride).toEqual({
      by: 'the operator',
    });
  });

  it('a waived row and a missing delivery channel each need an acknowledgement, which rides the payload', async () => {
    // The first draft has a waived row and no channel; once the boxes are
    // ticked the (re-asked) prelude answers with nothing open.
    mocks.runPrelude.mockImplementation((_slug: string, draft: { acknowledgedWaivers?: string[] }) => {
      const acked = new Set(draft.acknowledgedWaivers ?? []);
      const blocking = [
        ...(acked.has('relay')
          ? []
          : [{ key: 'relay', why: 'waived row not acknowledged — every phase is hand-driven' }]),
        ...(acked.has('announce')
          ? []
          : [{ key: 'announce', why: 'no delivery channel — acknowledge to start anyway' }]),
      ];
      return Promise.resolve({
        prelude: prelude({
          rows: [row('relay', { state: 'waived', value: 'every phase is hand-driven', blocking: 'yes' })],
          probes: {
            ...PROBES_OK,
            delivery: {
              status: 'fail',
              ok: false,
              reason:
                'no delivery channel: no subscribed device, no PHASE_CONSOLE_NOTIFY command, no webhook',
            },
          },
          waived: ['relay'],
          acknowledged: [...acked],
          blocking,
          delivery: { ok: false, channels: [], acknowledged: acked.has('announce') },
        }),
      });
    });
    await mount();
    const start = launch();
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true));
    expect(start.getAttribute('title')).toMatch(/Decision outstanding: relay/);
    await tile('Decisions');
    fireEvent.click(await within(region('Decisions')).findByRole('checkbox', { name: /relay — waived/ }));
    await waitFor(() => expect(launch().getAttribute('title')).toMatch(/announce/));
    fireEvent.click(
      within(region('Decisions')).getByRole('checkbox', { name: /Start anyway with no delivery channel/ }),
    );
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(false));
    // Acknowledged, the silent run is no longer a finding above the tiles.
    expect(screen.queryByText('Nobody will hear this run.')).toBeNull();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).acknowledgedWaivers).toEqual([
      'relay',
      'announce',
    ]);
  });

  it('a command the runner will not run is answered here: approve it, Launch opens, the fingerprint rides the payload', async () => {
    // Run f0da619a (2026-09-18): a `bats` line halted an autopilot mid-run. The
    // door now asks about it before anything starts — by exact command.
    const FP = 'f'.repeat(64);
    const review = (approved: boolean) => ({
      phase: 2,
      verdict: approved ? 'clear' : 'parks',
      park: approved ? undefined : 'phase 2 would park',
      runs: approved ? ['npm test', 'frob --check tests/'] : ['npm test'],
      items: approved
        ? []
        : [
            {
              text: 'frob --check tests/',
              reason: '`frob` is not a recognised command',
              fp: FP,
              approvable: true,
            },
          ],
      waived: [],
      setup: [],
      missing: [],
    });
    mocks.runPrelude.mockImplementation(
      (_slug: string, draft: { verifyAnswers?: { approve?: string[] } }) => {
        const approved = (draft.verifyAnswers?.approve ?? []).includes(FP);
        return Promise.resolve({
          prelude: prelude({
            rows: [row('verification.person-check', { value: 'halt', probe: 'verification' })],
            probes: {
              ...PROBES_OK,
              verification: approved
                ? {
                    status: 'ok',
                    ok: true,
                    reason: '2 commands in 1 open phase run on their own, 1 by your approval',
                    detail: {
                      scope: null,
                      reviews: [review(true)],
                      answers: { approve: [{ fp: FP, text: 'frob --check tests/' }], waive: [] },
                    },
                  }
                : {
                    status: 'fail',
                    ok: false,
                    reason: '1 phase would stop for a person — phase 2: frob --check tests/',
                    detail: { scope: null, reviews: [review(false)] },
                  },
            },
            blocking: approved
              ? []
              : [
                  {
                    key: 'verification.person-check',
                    why: '1 phase would stop for a person — phase 2: frob --check tests/',
                  },
                ],
          }),
        });
      },
    );
    await mount();
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(true));
    await tile('Decisions');
    fireEvent.click(
      await within(region('Decisions')).findByRole('checkbox', { name: /Approve .*frob --check tests\// }),
    );
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(false));
    // Once approved it is still shown — checked — so it can be taken back.
    expect(
      within(region('Decisions')).getByRole('checkbox', { name: /Approve .*frob --check tests\// }),
    ).toBeChecked();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).verifyAnswers).toEqual({
      approve: [FP],
      waive: [],
    });
  });

  it('a check no approval can carve is waived for this run instead — per phase', async () => {
    const FP = 'e'.repeat(64);
    mocks.runPrelude.mockImplementation((_slug: string, draft: { verifyAnswers?: { waive?: string[] } }) => {
      const waived = (draft.verifyAnswers?.waive ?? []).includes(`3:${FP}`);
      const item = {
        text: 'git push origin main',
        reason: 'looks like it mutates something',
        fp: FP,
        approvable: false,
      };
      return Promise.resolve({
        prelude: prelude({
          probes: {
            ...PROBES_OK,
            verification: {
              status: waived ? 'ok' : 'fail',
              ok: waived,
              reason: waived
                ? '1 command in 1 open phase run on their own, 1 set aside'
                : '1 phase would stop',
              detail: {
                scope: null,
                reviews: [
                  {
                    phase: 3,
                    verdict: waived ? 'clear' : 'parks',
                    runs: ['npm test'],
                    items: waived ? [] : [item],
                    waived: waived ? [item] : [],
                    setup: [],
                    missing: [],
                  },
                ],
              },
            },
          },
          blocking: waived ? [] : [{ key: 'verification.person-check', why: '1 phase would stop' }],
        }),
      });
    });
    await mount();
    await tile('Decisions');
    const waive = await within(region('Decisions')).findByRole('checkbox', {
      name: /Waive for this run.*git push origin main/,
    });
    // No approval can carve it, so none is offered beside the waiver.
    expect(within(region('Decisions')).queryByRole('checkbox', { name: /Approve .*git push/ })).toBeNull();
    fireEvent.click(waive);
    await waitFor(() => expect(launch().hasAttribute('disabled')).toBe(false));
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).verifyAnswers).toEqual({
      approve: [],
      waive: [`3:${FP}`],
    });
  });

  it('a plan with no manifest says so, and axe finds nothing', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        manifestPresent: false,
        rows: [row('gates', { value: 'delegated', origin: 'default', source: 'default' })],
      }),
    });
    await mount();
    await tile('Decisions');
    // The prelude is asked after mount; wait for its note (the text is split
    // around the `<code>` span, so match on the paragraph).
    await waitFor(() =>
      expect(
        within(region('Decisions')).getAllByText(
          (_, node) => node?.tagName === 'P' && /This plan writes no/.test(node.textContent ?? ''),
        ).length,
      ).toBeGreaterThan(0),
    );
    await expectNoAxeViolations(document.body);
  }, 30_000);

  it('the launch door’s isolation recommendation is a banner with its action', async () => {
    // Probe 6 (control-tower phase 40): another run holds a tree this plan
    // needs, and the console could give this run trees of its own.
    const trees = (grantable: boolean) => ({
      status: 'ok',
      ok: true,
      reason:
        'another run holds `api` on `pe/other` (run r9 of other) — start this run isolated and both drive at once',
      detail: {
        held: [{ repo: 'api', branch: 'pe/other', run: 'r9', slug: 'other' }],
        isolated: false,
        grantable,
      },
    });
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({ probes: { ...PROBES_OK, trees: trees(true) } }),
    });
    const view = await mount();
    const banner = (await screen.findByText('Another run holds a tree this plan needs.')).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(banner.textContent).toMatch(/another run holds `api` on `pe\/other` \(run r9 of other\)/);
    // It advises; it does not hold Launch.
    expect(launch()).not.toBeDisabled();
    fireEvent.click(within(banner).getByRole('button', { name: 'Give this run its own checkout' }));
    // The press is the answer, shown where it lives: a work branch, in a checkout of its own.
    const git = region('Git');
    expect((within(git).getByLabelText('Branch') as HTMLSelectElement).value).toBe('new-branch');
    expect(within(git).getByRole('checkbox', { name: /Give this run its own checkout/ })).toBeChecked();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const body = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.gitMode).toBe('new-branch');
    expect(body.isolation).toBe(ISOLATED);
    view.unmount();

    // A plan the console cannot isolate still hears the finding — with no
    // button that would ask for what the door refuses.
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({ probes: { ...PROBES_OK, trees: trees(false) } }),
    });
    await mount();
    const refused = (await screen.findByText('Another run holds a tree this plan needs.')).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(within(refused).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Give this run its own checkout' })).toBeNull();
  });

  it('a checkout changed on the form is judged again by the door, so the advice clears once taken', async () => {
    // Probes 6 and 7 judge THIS draft's checkout — `preludeDraft` sends
    // `gitMode` and `isolation` for exactly that — so moving either has to
    // re-ask the prelude. Here the console answers an isolated draft as isolated.
    mocks.runPrelude.mockImplementation((_slug: string, draft: { gitMode?: string; isolation?: string }) => {
      const isolated = draft.gitMode === 'new-branch' && draft.isolation === ISOLATED;
      return Promise.resolve({
        prelude: prelude({
          probes: {
            ...PROBES_OK,
            trees: {
              status: 'ok',
              ok: true,
              reason: isolated
                ? 'this run takes checkouts of its own'
                : 'another run holds `api` on `pe/other` (run r9 of other)',
              detail: {
                held: [{ repo: 'api', branch: 'pe/other', run: 'r9', slug: 'other' }],
                isolated,
                grantable: true,
              },
            },
          },
        }),
      });
    });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Give this run its own checkout' }));
    await waitFor(() =>
      expect(mocks.runPrelude).toHaveBeenLastCalledWith(
        'alpha',
        expect.objectContaining({ gitMode: 'new-branch', isolation: ISOLATED }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Another run holds a tree this plan needs.')).toBeNull());
  });
});
