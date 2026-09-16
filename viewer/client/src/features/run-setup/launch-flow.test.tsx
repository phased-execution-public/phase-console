/**
 * The launch flow, end to end on a desk: four stages, the review that lists
 * every non-default value with its source and every boarding warning, the
 * ticket beside the stages, the honest states, the memory — and the one
 * assertion the redesign exists to keep: the default launch posts BYTE FOR
 * BYTE what the old dialog posted.
 *
 * The plan, the preflight, the policy and the accounts are fixtures: the
 * review is about what the console already knows, and a test that mocked
 * none of it would prove only that empty sections render.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/** A prelude with nothing open — the Decisions stage answers, and Launch is not held. */
const EMPTY_PRELUDE = {
  slug: 'alpha',
  rows: [],
  blocking: [],
  waived: [],
  acknowledged: [],
  manifestPresent: false,
  probes: {
    accounts: { status: 'ok', ok: true, reason: '1 of 1 declared account usable: the machine login' },
    mcp: { status: 'skip', ok: true, reason: 'no MCP server named' },
    credentials: { status: 'skip', ok: true, reason: 'no credential named' },
    delivery: { status: 'ok', ok: true, reason: '1 subscribed device' },
  },
  accounts: [{ id: 'default', minHeadroomPct: 0 }],
  credentials: { policy: 'continue', ids: [], held: [], missing: [] },
  delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
  at: '2026-09-14T00:00:00.000Z',
};

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const SOON = new Date(Date.now() + 2 * 3_600_000).toISOString();

const DETAIL = {
  summary: {
    slug: 'alpha',
    title: 'Alpha plan',
    kind: 'plan',
    phases: 4,
    done: 1,
    ready: [2, 3],
    waiting: 1,
    inProgress: [],
    stuck: [],
    percent: 25,
    remainingWeight: 300_000,
    remainingSessions: 2,
    criticalPath: [2, 4],
    criticalWeight: 0,
    minimumSessions: 2,
    budget: 200_000,
    skills: [],
    mcpServers: [],
    qaMode: 'off',
    qaFailures: [],
    locks: [],
    repos: ['api', 'web'],
    handoffCount: 1,
    issues: [],
    issueCounts: { error: 0, warning: 0, info: 0 },
    hasHandoffs: true,
    activity: 0,
  },
  plan: null,
  phases: [
    { phase: 1, title: 'the schema', state: 'done', size: 'S', weight: 1, gated: false },
    {
      phase: 2,
      title: 'the api',
      state: 'ready',
      size: 'M',
      weight: 100_000,
      gated: false,
      row: { phase: 2, title: 'the api', dependsOn: [1], parallelSafe: '', repos: 'api', exitCriteria: '' },
    },
    {
      phase: 3,
      title: 'the web',
      state: 'ready',
      size: 'M',
      weight: 100_000,
      gated: true,
      gateKind: 'human',
      gates: 'the operator signs the release',
      lock: { owner: 'someone/else', expired: false, leaseUntil: Date.now() + 600_000 },
      row: { phase: 3, title: 'the web', dependsOn: [1], parallelSafe: '', repos: 'web', exitCriteria: '' },
    },
    {
      phase: 4,
      title: 'the docs',
      state: 'waiting',
      size: 'S',
      weight: 100_000,
      gated: true,
      gateKind: 'ai',
    },
  ],
  route: { nodes: [], edges: [], layers: 0, rows: 0 },
  batches: {
    groups: [
      { index: 1, kind: 'batch', weight: '180K', phases: [2, 3], gated: true },
      { index: 2, kind: 'single', weight: '100K', phases: [4], gated: true },
    ],
    raw: '',
    budget: '200K',
  },
  boardText: '',
  lint: null,
  handoffs: [],
  index: [],
};

const PREFLIGHT = {
  phases: [
    { phase: 2, warnings: [{ kind: 'nothing-runnable', message: 'no runnable §Verification' }] },
    { phase: 4, warnings: [{ kind: 'missing-lead', message: 'rg is not on this PATH', lead: 'rg' }] },
  ],
  computedAt: '2026-09-05T10:00:00Z',
};

async function mount(props: Record<string, unknown> = {}, consoleState: Record<string, unknown> = {}) {
  mocks.state.mockResolvedValue({
    prefs: {},
    defaultSkills: [],
    allowAgent: true,
    allowRun: true,
    ...consoleState,
  });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  const Setup = RunSetup as unknown as (p: Record<string, unknown>) => React.ReactElement;
  const view = render(
    <QueryClientProvider client={client}>
      <Setup
        mode="start"
        context={{ slug: 'alpha', run: null }}
        planPhases={DETAIL.phases}
        qaMode="off"
        allowWrites
        overlay={{ open: true, onOpenChange: () => {}, title: 'Start a run', description: 'A test.' }}
        {...props}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: /Start|Run phase/ });
  return view;
}

const stage = async (name: RegExp) => fireEvent.click(await screen.findByRole('tab', { name }));
/** The panel on screen — hidden panels are inaccessible, so the role query answers one. */
const panel = () => screen.getByRole('tabpanel');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.skills.mockResolvedValue([]);
  mocks.runStart.mockResolvedValue({ run: { id: 'r-new', slug: 'alpha' } });
  mocks.plan.mockResolvedValue(DETAIL);
  mocks.verifyPreflight.mockResolvedValue(PREFLIGHT);
  mocks.policy.mockResolvedValue({
    defaults: { deny: [], ask: [], allow: [] },
    extra: { deny: [], ask: [], allow: [] },
    plan: null,
    effective: { deny: ['Bash(git push*)', 'Bash(rm -rf*)'], ask: [], allow: [] },
    file: '',
    profiles: [],
    inert: [],
    support: [],
    hookTools: [],
    wrappersNotStripped: [],
  });
  mocks.accounts.mockResolvedValue({
    allowAccounts: false,
    accounts: [
      {
        id: 'default',
        kind: 'default',
        builtIn: true,
        email: 'me@example.com',
        usage: {
          buckets: {
            five_hour: { utilization: 37, resetsAt: SOON },
            seven_day: { utilization: 78, resetsAt: SOON },
          },
          fetchedAt: new Date().toISOString(),
        },
      },
    ],
  });
  mocks.mcp.mockResolvedValue({ servers: [], allowMcp: false });
  mocks.isolationPreflight.mockResolvedValue({ available: true, kind: 'checkout', multiRepo: false });
  mocks.runPrelude.mockResolvedValue({ prelude: EMPTY_PRELUDE });
});

describe('the five stages', () => {
  it('open on Decisions, then What runs: the plan, the phases ready now, the sessions, and what will hold', async () => {
    await mount();
    // Decisions first (phase 11): the prelude's questions before the run's shape.
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(within(panel()).getByText('What the door requires')).toBeTruthy();
    await stage(/What runs/);
    const what = panel();
    expect(await within(what).findByText('Alpha plan')).toBeTruthy();
    expect(within(what).getByText(/4 phases · 1 done · 2 phases ready now/)).toBeTruthy();
    // The ready set, each with its state, its scope, its gate and its claim.
    expect(within(what).getByText('the api')).toBeTruthy();
    expect(within(what).getByText('the web')).toBeTruthy();
    expect(within(what).getByText('gate · a person approves it')).toBeTruthy();
    expect(within(what).getByText('claimed')).toBeTruthy();
    // The engine's batches.
    expect(within(what).getByText('Session 1')).toBeTruthy();
    expect(within(what).getByText('P2, P3')).toBeTruthy();
    // Who clears each gate, and what the run queues behind.
    expect(within(what).getByText(/claimed by/)).toBeTruthy();
    expect(within(what).getByText(/the session clears it at boarding/)).toBeTruthy();
    // The controls come last.
    expect(within(what).getByLabelText('Only these phases')).toBeTruthy();
  });

  it('carry the permissions with the deny wall under them, and the account with its meters', async () => {
    await mount();
    await stage(/How it runs/);
    const how = panel();
    // The option is the profile's name; the qualifier and the wall are under it.
    const select = within(how).getByLabelText('Permissions') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Guarded', 'Trusted', 'Bypass']);
    expect(
      await within(how).findByText(/The deny list is the same under every profile — 2 rules/),
    ).toBeTruthy();
    // The account option is who it is; the headroom is a real meter, worst window first.
    const account = within(how).getByLabelText('Account') as HTMLSelectElement;
    expect([...account.options].map((o) => o.text)).toContain('machine login');
    const meters = await within(how).findAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Weekly (all models)',
      '5-hour session',
    ]);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('78');
  });

  it('put the ceilings and the stop conditions on Money and stops, as sentences', async () => {
    await mount();
    await stage(/Money and stops/);
    const money = panel();
    expect(within(money).getByText(/no spending ceiling/)).toBeTruthy();
    fireEvent.change(within(money).getByLabelText(/Budget for the run/), { target: { value: '40' } });
    expect(within(money).getByText('the run has spent $40.00')).toBeTruthy();
    expect(within(money).getByText('$40.00 for the whole run')).toBeTruthy();
  });
});

describe('the review', () => {
  it('lists every non-default value with its source, every warning, what will hold, and the money', async () => {
    await mount();
    await stage(/How it runs/);
    fireEvent.change(within(panel()).getByLabelText('Model'), { target: { value: 'sonnet' } });
    await stage(/Money and stops/);
    fireEvent.change(within(panel()).getByLabelText(/Budget for the run/), { target: { value: '40' } });
    await stage(/Review/);
    const review = panel();

    // The departure line reads the values and the board.
    expect(
      within(review).getByText(
        'Runs alpha from phases 2 and 3, on sonnet at max effort, trusted, on the current branch.',
      ),
    ).toBeTruthy();

    // Exactly the two changed rows, with their sources and a way back.
    const list = within(review).getByText('Every choice that is not the default').nextElementSibling!;
    const items = within(list as HTMLElement).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Modelsonnetchanged hereChange',
      'Budget for the run$40.00changed hereChange',
    ]);
    expect(within(review).getByRole('button', { name: 'Change Model' })).toBeTruthy();

    // Every warning boarding will find, weighted.
    expect(
      within(review).getByText('1 phase will park at boarding — nothing runnable in its §Verification.'),
    ).toBeTruthy();
    expect(within(review).getByText('will park')).toBeTruthy();
    expect(within(review).getByText('no runnable §Verification')).toBeTruthy();
    expect(within(review).getByText('missing lead')).toBeTruthy();

    // What will hold.
    expect(within(review).getByText(/gate — a person approves it/)).toBeTruthy();
    expect(within(review).getByText(/claimed by/)).toBeTruthy();

    // The money and the stops.
    expect(within(review).getByText('$40.00 for the whole run')).toBeTruthy();
    expect(within(review).getByText('At most $40.00 before it halts and asks.')).toBeTruthy();
    expect(within(review).getByText('the run has spent $40.00')).toBeTruthy();
  });

  it('says "nothing" rather than listing defaults, and folds every value behind one disclosure', async () => {
    await mount();
    await stage(/Review/);
    const review = panel();
    expect(
      within(review).getByText('Nothing — every value is what a fresh console ships with.'),
    ).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: /Every value this launch sends/ }));
    expect(within(review).getByText('Queue priority')).toBeTruthy();
  });

  it('keeps the ticket beside every other stage, and its Change link goes to the field’s stage', async () => {
    await mount();
    await stage(/Money and stops/);
    fireEvent.change(within(panel()).getByLabelText(/Budget per phase/), { target: { value: '5' } });
    const ticket = screen.getByRole('complementary', { name: 'Launch summary' });
    expect(within(ticket).getByText(/Runs alpha from phases 2 and 3/)).toBeTruthy();
    expect(within(ticket).getByText('$5.00')).toBeTruthy();
    expect(within(ticket).getByText('1 phase will park at boarding')).toBeTruthy();
    // A row's Change link goes to its stage — and on the review the pane folds away.
    await stage(/How it runs/);
    fireEvent.click(
      within(screen.getByRole('complementary', { name: 'Launch summary' })).getByRole('button', {
        name: 'Change Budget per phase',
      }),
    );
    expect(screen.getByRole('tab', { name: /Money and stops/ }).getAttribute('aria-selected')).toBe('true');
    await stage(/Review/);
    expect(screen.queryByRole('complementary', { name: 'Launch summary' })).toBeNull();
  });
});

describe('the honest states', () => {
  it('without --allow-run it says so on every stage, offers the start command, and keeps Launch off', async () => {
    await mount(
      { blocked: true, blockedReason: 'Controls need --allow-run.' },
      {
        allowRun: false,
        scriptsDir: '/home/me/skill/scripts',
        home: '/home/me',
        port: 4130,
        root: { path: '/home/me/work/repo' },
      },
    );
    expect(await screen.findByText('This console cannot start runs.')).toBeTruthy();
    const command = screen.getByText(/--allow-writes --allow-run/, { selector: 'code' });
    expect(command.textContent).toBe(
      '"$HOME/skill/start" "$HOME/work/repo" --port 4130 --allow-writes --allow-run --allow-terminal --allow-agent --allow-accounts --allow-mcp --allow-webhooks',
    );
    expect(screen.getByRole('button', { name: 'Copy the command' })).toBeTruthy();
    const launch = screen.getByRole('button', { name: 'Start' });
    expect(launch).toBeDisabled();
    expect(launch.getAttribute('title')).toBe('Controls need --allow-run.');
    await stage(/Review/);
    expect(screen.getByText('This console cannot start runs.')).toBeTruthy();
  });

  it('says a value came from Settings, and a value from the last launch says so too', async () => {
    await mount({}, { prefs: { gitMode: 'new-branch' } });
    await stage(/How it runs/);
    expect(await within(panel()).findAllByText('from Settings')).toBeTruthy();
    fireEvent.change(within(panel()).getByLabelText('Model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));

    // Next time, the plan opens on what it was launched with — and says so.
    await mount({}, { prefs: { gitMode: 'new-branch' } });
    await stage(/How it runs/);
    const model = within(panel()).getByLabelText('Model') as HTMLSelectElement;
    expect(model.value).toBe('sonnet');
    expect(within(panel()).getAllByText('from your last launch').length).toBeGreaterThan(0);
    await stage(/Review/);
    const row = within(panel()).getByRole('button', { name: 'Change Model' }).closest('li')!;
    expect(row.textContent).toBe('Modelsonnetfrom your last launchChange');
  });
});

describe('the contract', () => {
  it('posts, for the default fixture, byte for byte what the old dialog posted', async () => {
    await mount();
    // The account list is filled from the prelude once it answers; wait for it
    // so the bytes below are the whole form, not a race.
    await screen.findByDisplayValue('default:0');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect(mocks.runStart.mock.calls[0]![0]).toBe('alpha');
    // Captured from the pre-Phase-8 dialog with the same fixture. `modes.ts`
    // is untouched, so this is the redesign's promise stated as bytes.
    // …plus, since 5.0.0 (phase 11), the Decisions stage's three required
    // answers at the end: the run's own words for `resume.on-restart` and
    // `relay`, and the account list the prelude resolved for it.
    expect(JSON.stringify(mocks.runStart.mock.calls[0]![1])).toBe(
      '{"model":"opus","effort":"max","onLimit":"switch","autonomy":"keep-going","phaseBudgetUsd":null,"runBudgetUsd":null,"permissionProfile":"trusted","skills":[],"mcpPolicy":"continue","gitMode":"default-branch","ultraReview":"off","priority":"normal","startAfter":"","autoRecover":true,"resumeOnRestart":true,"relay":"off","accounts":[{"id":"default","minHeadroomPct":0}]}',
    );
  });

  /**
   * QA round 1, H1 — the review described a decision the run would not carry.
   *
   * Reproduced exactly as the report sequenced it, and asserted on BOTH halves
   * in one run: the row is gone from the review, and the payload has no
   * `settle` key. Either half alone would pass over the defect — a review that
   * hides a value the run sends is the same fault in the other direction.
   */
  it('drops a row whose control the operator switched off, and posts no such key', async () => {
    await mount();
    await stage(/How it runs/);
    const branch = within(panel()).getByLabelText('Branch') as HTMLSelectElement;
    fireEvent.change(branch, { target: { value: 'new-branch' } });

    const settle = await within(panel()).findByLabelText('When the plan completes');
    fireEvent.change(settle, { target: { value: 'keep' } });
    // It reads as a decision while the branch is a work branch…
    await stage(/Review/);
    expect(within(panel()).queryByText(/Keep — leave the branch/)).toBeTruthy();

    // …and the branch goes back, which takes the control off the stage.
    await stage(/How it runs/);
    fireEvent.change(within(panel()).getByLabelText('Branch') as HTMLSelectElement, {
      target: { value: 'default-branch' },
    });
    expect(within(panel()).queryByLabelText('When the plan completes')).toBeNull();

    await stage(/Review/);
    expect(within(panel()).queryByText(/Keep — leave the branch/)).toBeNull();
    expect(
      within(panel()).queryByRole('button', { name: 'Change When the plan completes' }),
      'a Change link into a stage that no longer draws the control',
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const payload = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect('settle' in payload, 'the review was right to drop it').toBe(false);
    expect('isolation' in payload).toBe(false);
    expect(payload.gitMode).toBe('default-branch');
  });

  it('marks the stations it has passed', async () => {
    await mount();
    await stage(/How it runs/);
    await stage(/Review/);
    const visited = screen.getAllByRole('tab').map((t) => t.hasAttribute('data-visited'));
    expect(visited).toEqual([true, false, true, false, true]);
  });
});

describe('accessibility', () => {
  it('axe finds nothing on any of the five stages', async () => {
    await mount();
    for (const name of [/Decisions/, /What runs/, /How it runs/, /Money and stops/, /Review/]) {
      await stage(name);
      await screen.findByRole('tabpanel');
      await expectNoAxeViolations(document.body);
    }
  }, 30_000);
});
