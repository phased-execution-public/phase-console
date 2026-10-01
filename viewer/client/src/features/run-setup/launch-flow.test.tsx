/**
 * The launch flow, end to end on a desk — the quick view (control-tower
 * phase 22): what runs, the findings, a preset, nine category tiles that say
 * their state and expand in place onto the existing controls, how many values
 * differ, and the one Launch — with the honest states, the memory, and the
 * one assertion every redesign of this form exists to keep: the default
 * launch posts BYTE FOR BYTE what the old dialog posted.
 *
 * The plan, the preflight, the policy and the accounts are fixtures: the
 * quick view is about what the console already knows, and a test that mocked
 * none of it would prove only that empty tiles render.
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

/**
 * The default fixture's bytes BEFORE the fields commit (control-tower phase
 * 22) — what every dialog since Phase 8 posted, held through the quick view.
 */
const GOLDEN_BEFORE =
  '{"model":"opus","effort":"max","onLimit":"switch","autonomy":"keep-going","phaseBudgetUsd":null,"runBudgetUsd":null,"permissionProfile":"trusted","skills":[],"mcpPolicy":"continue","gitMode":"default-branch","ultraReview":"off","priority":"normal","startAfter":"","landing":"hold","conflictPolicy":"halt","messaging":"on","issuesMode":"off","worktreeRetention":"keep-on-failure","autoRecover":true,"resumeOnRestart":true,"relay":"off","accounts":[{"id":"default","minHeadroomPct":0}]}';

/**
 * …and AFTER it, deliberately: `RUN_FIELDS` gained `qaFixStrategy` and
 * `qaRoundBudgetUsd` (`permissionMode` had joined it in phase 11). At their
 * defaults only the round budget speaks — the dollar rule's explicit `null`,
 * "no per-round stop" — while the strategy and the permission mode keep their
 * silence, so the bytes gain exactly that one key.
 */
const GOLDEN =
  '{"model":"opus","effort":"max","onLimit":"switch","autonomy":"keep-going","phaseBudgetUsd":null,"runBudgetUsd":null,"permissionProfile":"trusted","skills":[],"mcpPolicy":"continue","gitMode":"default-branch","ultraReview":"off","priority":"normal","startAfter":"","landing":"hold","conflictPolicy":"halt","messaging":"on","issuesMode":"off","worktreeRetention":"keep-on-failure","qaRoundBudgetUsd":null,"autoRecover":true,"resumeOnRestart":true,"relay":"off","accounts":[{"id":"default","minHeadroomPct":0}]}';

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

/** Press a tile's verb — Edit, or Answer on a summons. */
const tile = async (label: string) =>
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^(Edit|Answer) ${label}$`) }));
/** The one expanded tile's controls. */
const region = (label: string) => screen.getByRole('region', { name: label });
/** The quick view's list of tiles, by label, in the order drawn. */
const tileLabels = () =>
  within(screen.getByRole('list', { name: 'Settings by category' }))
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);

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

describe('the quick view', () => {
  it('opens on what runs, the finding that matters, a preset and the nine tiles', async () => {
    await mount();
    expect(
      await screen.findByText(
        'Runs alpha from phases 2 and 3, on opus at max effort, trusted, on the current branch.',
      ),
    ).toBeTruthy();
    expect(tileLabels()).toEqual([
      'Scope',
      'Engine',
      'Safety',
      'Git',
      'Money and stops',
      'Review and QA',
      'Tools',
      'Accounts',
      'Decisions',
    ]);
    // The boarding preflight is a banner with its own action, not a stage to visit.
    expect(await screen.findByText('1 phase will park at boarding')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Narrow the scope' })).toBeTruthy();
    // A fresh console IS the Balanced preset.
    const presets = screen.getByRole('group', { name: 'Start from a preset' });
    expect(within(presets).getByRole('button', { name: 'Balanced' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // No tile is open, so no control is drawn yet.
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
    expect(screen.queryByLabelText('Model')).toBeNull();
  });

  it('keeps the plan, its phases, the sessions and what will hold one fold away', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /The plan, its phases and what will hold/ }));
    expect(await screen.findByText('Alpha plan')).toBeTruthy();
    expect(screen.getByText(/4 phases · 1 done · 2 phases ready now/)).toBeTruthy();
    expect(screen.getByText('the api')).toBeTruthy();
    expect(screen.getByText('the web')).toBeTruthy();
    expect(screen.getByText('gate · a person approves it')).toBeTruthy();
    expect(screen.getByText('claimed')).toBeTruthy();
    expect(screen.getByText('Session 1')).toBeTruthy();
    expect(screen.getByText('P2, P3')).toBeTruthy();
    expect(screen.getByText(/claimed by/)).toBeTruthy();
    expect(screen.getByText(/the session clears it at boarding/)).toBeTruthy();
    // Every boarding finding, per phase, under the same fold.
    expect(screen.getByText('no runnable §Verification')).toBeTruthy();
    expect(screen.getByText('missing lead')).toBeTruthy();
  });

  it('expands one tile at a time, in place, onto the existing controls', async () => {
    await mount();
    await tile('Safety');
    const safety = region('Safety');
    const select = within(safety).getByLabelText('Permissions') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Guarded', 'Trusted', 'Bypass']);
    expect(
      await within(safety).findByText(/The deny list is the same under every profile — 2 rules/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done Safety' }).getAttribute('aria-expanded')).toBe('true');

    await tile('Accounts');
    expect(screen.queryByRole('region', { name: 'Safety' })).toBeNull();
    const accounts = region('Accounts');
    // The option is who the account is, and the login it answers as now.
    const account = within(accounts).getByLabelText('Account') as HTMLSelectElement;
    expect([...account.options].map((o) => o.text)).toContain('machine login — me@example.com');
    const meters = await within(accounts).findAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Weekly (all models)',
      '5-hour session',
    ]);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('78');
    // The pool the run may fail over within sits beside the account now.
    expect(await within(accounts).findByDisplayValue('default:0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done Accounts' }));
    expect(screen.queryByRole('region', { name: 'Accounts' })).toBeNull();
  });

  it('says where it stops on the Money tile, and its glance names the per-run rung cap', async () => {
    await mount();
    const money = () => within(screen.getByRole('list', { name: 'Money and stops now' }));
    expect(money().getByText('No run ceiling')).toBeTruthy();
    expect(money().getByText('10 recovery rungs a run')).toBeTruthy();
    await tile('Money and stops');
    expect(within(region('Money and stops')).getByText(/no spending ceiling/)).toBeTruthy();
    fireEvent.change(within(region('Money and stops')).getByLabelText(/Budget for the run/), {
      target: { value: '40' },
    });
    expect(within(region('Money and stops')).getByText('the run has spent $40.00')).toBeTruthy();
    expect(within(region('Money and stops')).getByText('$40.00 for the whole run')).toBeTruthy();
    expect(money().getByText('$40 a run')).toBeTruthy();
    // The tile counts what changed in this dialog.
    const li = screen.getByRole('list', { name: 'Money and stops now' }).closest('li[data-category]')!;
    expect(li.querySelector('[data-changed]')?.textContent).toBe('changed 1');
  });
});

describe('the review, collapsed to what differs', () => {
  it('counts every value that differs, lists each with its source, and links back to its tile', async () => {
    await mount();
    await tile('Engine');
    fireEvent.change(within(region('Engine')).getByLabelText('Model'), { target: { value: 'sonnet' } });
    await tile('Money and stops');
    fireEvent.change(within(region('Money and stops')).getByLabelText(/Budget for the run/), {
      target: { value: '40' },
    });
    expect(
      screen.getByText(
        'Runs alpha from phases 2 and 3, on sonnet at max effort, trusted, on the current branch.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^2 values differ from a fresh console/ }));
    const differ = screen.getByRole('region', { name: 'What differs' });
    const items = within(differ).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Modelsonnetchanged hereChange',
      'Budget for the run$40.00changed hereChange',
    ]);
    // A Change link opens the field's tile.
    fireEvent.click(within(differ).getByRole('button', { name: 'Change Model' }));
    expect(within(region('Engine')).getByLabelText('Model')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Money and stops' })).toBeNull();
  });

  it('says every value is the shipped one, and folds every value behind one disclosure', async () => {
    await mount();
    expect(await screen.findByText('Every value is what a fresh console ships with.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Every value this launch sends/ }));
    expect(screen.getByText('Queue priority')).toBeTruthy();
  });
});

describe('a preset', () => {
  it('moves only its own keys, says so, and posts them', async () => {
    await mount();
    await screen.findByText(/Runs alpha/);
    fireEvent.click(screen.getByRole('button', { name: 'Careful' }));
    expect(screen.getByRole('button', { name: 'Careful' }).getAttribute('aria-pressed')).toBe('true');
    await tile('Safety');
    const safety = region('Safety');
    expect((within(safety).getByLabelText('Permissions') as HTMLSelectElement).value).toBe('guarded');
    expect(within(safety).getAllByText('from preset').length).toBeGreaterThan(0);
    // A value changed after the pick still says it was changed here.
    fireEvent.change(within(safety).getByLabelText('Permissions'), { target: { value: 'trusted' } });
    expect(within(safety).getAllByText('changed here').length).toBeGreaterThan(0);
    fireEvent.change(within(safety).getByLabelText('Permissions'), { target: { value: 'guarded' } });

    await tile('Accounts');
    await screen.findByDisplayValue('default:0');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect(mocks.runStart.mock.calls[0]![1]).toMatchObject({
      model: 'opus',
      effort: 'max',
      permissionProfile: 'guarded',
      autonomy: 'halt-on-everything',
      onLimit: 'pause',
      autoRecover: false,
      maxConsecutiveFailures: 1,
      ladderPerRunRungs: 3,
      relay: 'off',
      gitMode: 'default-branch',
    });
  });
});

describe('the honest states', () => {
  it('without --allow-run it says so above the tiles, offers the start command, and keeps Launch off', async () => {
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
    // Still said with a tile open: the banner sits above the whole screen.
    await tile('Engine');
    expect(screen.getByText('This console cannot start runs.')).toBeTruthy();
  });

  it('says a value came from Settings, and a value from the last launch says so too', async () => {
    await mount({}, { prefs: { gitMode: 'new-branch' } });
    await tile('Git');
    expect(await within(region('Git')).findAllByText('from Settings')).toBeTruthy();
    await tile('Engine');
    fireEvent.change(within(region('Engine')).getByLabelText('Model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));

    // Next time, the plan opens on what it was launched with — and says so.
    await mount({}, { prefs: { gitMode: 'new-branch' } });
    expect(screen.getAllByRole('button', { name: 'Last launch' }).length).toBeGreaterThan(0);
    await tile('Engine');
    const model = within(region('Engine')).getByLabelText('Model') as HTMLSelectElement;
    expect(model.value).toBe('sonnet');
    expect(within(region('Engine')).getAllByText('from your last launch').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /value.* from a fresh console/ }));
    const row = within(screen.getByRole('region', { name: 'What differs' }))
      .getAllByRole('button', { name: 'Change Model' })[0]!
      .closest('li')!;
    expect(row.textContent).toBe('Modelsonnetfrom your last launchChange');
    // Two whole launches in one test. The bound is a liveness bound
    // (vite.config.ts): at load average 68 this test ran past the 20 s default.
  }, 60_000);
});

describe('the contract', () => {
  it('posts, for the default fixture, byte for byte what the old dialog posted', async () => {
    await mount();
    // The account list is filled from the prelude once it answers; wait for it
    // (in the Accounts tile, where the pool is asked now) so the bytes below
    // are the whole form, not a race. Opening a tile changes no value.
    await tile('Accounts');
    await screen.findByDisplayValue('default:0');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect(mocks.runStart.mock.calls[0]![0]).toBe('alpha');
    // Captured from the pre-Phase-8 dialog with the same fixture, and held
    // through every redesign since — the stages (Phase 8) and the quick view
    // (control-tower phase 22) are arrangement, so the bytes do not move.
    // …plus, since 5.0.0 (phase 11), the Decisions stage's three required
    // answers at the end: the run's own words for `resume.on-restart` and
    // `relay`, and the account list the prelude resolved for it — and, since
    // 5.1.0 (many-plans-one-repo phase 15), the five words the form always
    // says (`landing`, `conflictPolicy`, `messaging`, `issuesMode`,
    // `worktreeRetention`), each at its owner's default. The ref and the cap
    // are omissions on a start whose form left them blank.
    expect(JSON.stringify(mocks.runStart.mock.calls[0]![1])).toBe(GOLDEN);
  });

  it('moved by the fields commit by exactly its keys, and by nothing else', () => {
    const before = JSON.parse(GOLDEN_BEFORE) as Record<string, unknown>;
    const after = JSON.parse(GOLDEN) as Record<string, unknown>;
    expect(Object.keys(after).filter((key) => !(key in before))).toEqual(['qaRoundBudgetUsd']);
    expect(Object.keys(before).filter((key) => !(key in after))).toEqual([]);
    const { qaRoundBudgetUsd: added, ...rest } = after;
    expect(added).toBeNull();
    expect(JSON.stringify(rest)).toBe(GOLDEN_BEFORE);
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
    await tile('Git');
    const branch = within(region('Git')).getByLabelText('Branch') as HTMLSelectElement;
    fireEvent.change(branch, { target: { value: 'new-branch' } });

    const settle = await within(region('Git')).findByLabelText('When the plan completes');
    fireEvent.change(settle, { target: { value: 'keep' } });
    // It reads as a decision while the branch is a work branch…
    fireEvent.click(screen.getByRole('button', { name: /value.* from a fresh console/ }));
    expect(
      within(screen.getByRole('region', { name: 'What differs' })).queryByText(/Keep — leave the branch/),
    ).toBeTruthy();

    // …and the branch goes back, which takes the control out of the tile.
    fireEvent.change(within(region('Git')).getByLabelText('Branch') as HTMLSelectElement, {
      target: { value: 'default-branch' },
    });
    expect(within(region('Git')).queryByLabelText('When the plan completes')).toBeNull();
    const differ = screen.getByRole('region', { name: 'What differs' });
    expect(within(differ).queryByText(/Keep — leave the branch/)).toBeNull();
    expect(
      within(differ).queryByRole('button', { name: 'Change When the plan completes' }),
      'a Change link into a tile that no longer draws the control',
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const payload = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect('settle' in payload, 'the review was right to drop it').toBe(false);
    expect('isolation' in payload).toBe(false);
    expect(payload.gitMode).toBe('default-branch');
  });
});

describe('accessibility', () => {
  it('axe finds nothing on the quick view, or in any tile opened', async () => {
    await mount();
    await screen.findByText(/Runs alpha/);
    await expectNoAxeViolations(document.body);
    for (const label of tileLabels()) {
      await tile(label!);
      await expectNoAxeViolations(region(label!));
    }
    // Axe over the screen and nine tiles, the heaviest test in this file. The
    // liveness bound is 90 s (vite.config.ts's default is 20 s): at load
    // average 68 five stages already ran past 30 s.
  }, 90_000);
});
