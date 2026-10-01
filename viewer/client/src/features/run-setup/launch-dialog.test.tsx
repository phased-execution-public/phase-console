/**
 * The unified launch dialog — the field matrix and what each submit sends.
 *
 * The matrix is the contract: permissions are run-profiles on run launches and
 * QA-profiles on reviews and absent on recoveries; the git section exists only
 * where a run is being minted, with the PR checkbox alive only under the
 * work-branch mode; and the Automation preferences are the OPENING values,
 * overridable per launch. The submit payloads are asserted verbatim because
 * they are what the server validates — a field that quietly stopped being sent
 * would degrade to the preference without anyone seeing it.
 *
 * Since control-tower phase 22 a `phase` launch is the QUICK VIEW: one screen
 * of category tiles, each expanding in place onto its controls, one at a time.
 * A folded tile's controls are not in the document at all, so a test that asks
 * for the branch select opens the Git tile first (`tile()`), exactly as a
 * person would — the `tile()` calls are what prove each control is reachable.
 * A QA review and a recovery are flat, and their tests are unchanged.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';

const { state, skills, runStart, agentTicket, runPrelude } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  agentTicket: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runStart, agentTicket, runPrelude } };
});

/** A prelude with nothing open — the Decisions tile answers, and Launch is not held. */
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

const RUN = {
  id: 'run-1',
  slug: 'alpha',
  status: 'halted',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'keep-going',
  permissionProfile: 'trusted',
  skills: ['design-review'],
  phaseBudgetUsd: 5,
  runBudgetUsd: 40,
  phases: {},
} as unknown as RunState;

async function mount(
  request: unknown,
  prefs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  state.mockResolvedValue({ prefs, defaultSkills: ['graph-tool'], ...extra });
  runPrelude.mockResolvedValue({ prelude: EMPTY_PRELUDE });
  const client = new QueryClient(queryClientConfig);
  const { LaunchDialog } = await import('./launch-dialog');
  return render(
    <QueryClientProvider client={client}>
      <LaunchDialog request={request as never} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** Open a tile by its name — Edit, or Answer on a summons — what a person does to reach a control. */
async function tile(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^(Edit|Answer) ${label}$`) }));
}

/** An expanded tile's controls. */
const region = (label: string) => screen.getByRole('region', { name: label });

/** The tiles the quick view draws, by label, in its order. */
const tileLabels = () =>
  within(screen.getByRole('list', { name: 'Settings by category' }))
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent!);

beforeEach(() => {
  vi.clearAllMocks();
  skills.mockResolvedValue([]);
  runStart.mockResolvedValue({ run: null });
  agentTicket.mockResolvedValue({ sessionId: 'sess-new' });
});

describe('the field matrix', () => {
  it('a recovery offers model, effort and skills — and no permission select', async () => {
    await mount({ kind: 'recovery', recoveryClass: 'plan-repair', slug: 'alpha' });
    await screen.findByLabelText('Model');
    expect(screen.getByText('Effort')).toBeTruthy();
    expect(screen.queryByText('Permissions')).toBeNull();
    expect(screen.queryByText('Branch')).toBeNull();
    expect(screen.getByRole('button', { name: /Repair the plan with a new agent/ })).toBeTruthy();
    // A recovery is flat: no stage bar.
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it("a phase launch carries the plan's own reviewer, so the doubled-review advisory reaches it", async () => {
    // "Run only this one" offers Review each phase too (autopilot-token-drain
    // phase 5): a single phase reviewed twice is the same double spend.
    await mount(
      {
        kind: 'phase',
        slug: 'alpha',
        phase: 3,
        run: null,
        qaMode: 'off',
        planReviewers: [{ section: 'Adversarial review', excerpt: 'dispatch ONE fresh-context reviewer' }],
      },
      { reviewEachPhaseByDefault: true },
    );
    await tile('Review and QA');
    expect((await within(region('Review and QA')).findByTestId('review-doubled')).textContent).toContain(
      'Adversarial review',
    );
  });

  it('a phase launch is the quick view, and carries the git section in its Git tile', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null });
    // One screen since control-tower phase 22 — no stage bar — and the tiles a
    // one-phase launch has: no Scope, because it narrows nothing and chains nothing.
    await screen.findByTestId('quick-view');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(tileLabels()).toEqual([
      'Engine',
      'Safety',
      'Git',
      'Money and stops',
      'Review and QA',
      'Tools',
      'Accounts',
      'Decisions',
    ]);
    // No tile is open until a person opens one.
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);

    await tile('Git');
    const branch = (await within(region('Git')).findByLabelText('Branch')) as HTMLSelectElement;
    expect(branch.value).toBe('default-branch');
    expect(within(region('Git')).queryByText(/When the plan completes/)).toBeNull();
    fireEvent.change(branch, { target: { value: 'new-branch' } });
    expect(await within(region('Git')).findByText(/When the plan completes/)).toBeTruthy();
  });

  it('the QA toggle appears only where the gate is off and writes are allowed', async () => {
    const gated = await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'on' });
    await tile('Review and QA');
    await within(region('Review and QA')).findByLabelText('Cloud review');
    expect(screen.queryByText(/Turn the QA gate on/)).toBeNull();
    gated.unmount();

    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'off', allowWrites: false });
    await tile('Review and QA');
    const boxes = await within(region('Review and QA')).findAllByText(/Turn the QA gate on/);
    expect(boxes.length).toBe(1);
    const box = within(region('Review and QA')).getByRole('checkbox', { name: /Turn the QA gate on/ });
    expect(box).toBeDisabled();
    expect(box.getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('the auto-recovery box needs --allow-agent, and follows the preference when it has it', async () => {
    // Without the flag: rendered, disabled, and the title names the flag.
    const without = await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null });
    await tile('Money and stops');
    const off = await within(region('Money and stops')).findByRole('checkbox', {
      name: /Auto-recover halts/,
    });
    expect(off).toBeDisabled();
    expect(off.getAttribute('title')).toMatch(/--allow-agent/);
    without.unmount();

    // With it: enabled and opening on the preference default (on) — once the
    // console's state, which carries the flag, has answered.
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null }, {}, { allowAgent: true });
    await tile('Money and stops');
    await waitFor(() => {
      const on = within(region('Money and stops')).getByRole('checkbox', { name: /Auto-recover halts/ });
      expect(on).not.toBeDisabled();
      expect(on).toBeChecked();
    });
  });

  it('opens on the Automation preferences, as the footer promises', async () => {
    await mount(
      { kind: 'phase', slug: 'alpha', phase: 3, run: null },
      { attachDefaultSkills: true, gitMode: 'new-branch', openPrOnComplete: false },
    );
    await tile('Tools');
    const attach = await within(region('Tools')).findByRole('button', { name: 'Attached' });
    expect(attach.getAttribute('aria-pressed')).toBe('true');
    await tile('Git');
    const git = region('Git');
    expect((within(git).getByLabelText('Branch') as HTMLSelectElement).value).toBe('new-branch');
    // `openPrOnComplete: false` is what an operator stored BEFORE `settle`
    // existed, and it asked for exactly what `keep` means. The dialog folds the
    // two the way every other reader does, so the select opens on `keep`
    // rather than on the shipped default that would undo their preference.
    expect((within(git).getByLabelText('When the plan completes') as HTMLSelectElement).value).toBe('keep');
    // And a value that came from Settings says so — not "from defaults".
    expect(within(git).getAllByText('from Settings').length).toBeGreaterThan(0);
  });
});

describe('the submits', () => {
  it('a phase launch sends exactly what the dialog shows, scoped to its phase', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: RUN, qaMode: 'off', allowWrites: true });
    // The account list is filled from the prelude's resolved clause once it
    // answers — in the Accounts tile, beside the account; wait for it so the
    // payload below is the whole form. Opening a tile changes no value.
    await tile('Accounts');
    await within(region('Accounts')).findByDisplayValue('default:0');
    await tile('Tools');
    fireEvent.click(await within(region('Tools')).findByRole('button', { name: 'Off' })); // attach defaults on
    await tile('Review and QA');
    fireEvent.click(within(region('Review and QA')).getByRole('checkbox', { name: /Turn the QA gate on/ })); // QA gate on
    fireEvent.click(screen.getByRole('button', { name: 'Run phase 3' }));
    await waitFor(() =>
      expect(runStart).toHaveBeenCalledWith('alpha', {
        model: 'sonnet',
        effort: 'high',
        // The dialog's deliberate default: switch to the account with headroom
        // at the usage wall, degrading to `wait` when there is only one login.
        onLimit: 'switch',
        autonomy: 'keep-going',
        phaseBudgetUsd: 5,
        runBudgetUsd: 40,
        permissionProfile: 'trusted',
        skills: ['design-review'],
        // Always sent as shown, like `autoRecover` below. `continue` is the
        // shipped default: an unreachable MCP server makes a phase report what it
        // could not do, rather than stopping the plan.
        mcpPolicy: 'continue',
        attachDefaultSkills: true,
        gitMode: 'default-branch',
        qa: true,
        // Always sent as shown: this console has no --allow-agent, so the box is
        // off and the run is written without the option — never silently.
        // Always sent as shown, like `mcpPolicy` and `autoRecover`: on a live
        // run an absent field means "leave it alone", so a form that omitted
        // `off` could turn billed cloud reviews on and never take them back.
        ultraReview: 'off',
        autoRecover: false,
        // The Decisions tile's answers (phase 11): the run's own words for
        // the manifest's rows, sent as shown — a resume ignores them and a
        // fresh start is refused without them.
        resumeOnRestart: true,
        relay: 'off',
        accounts: [{ id: 'default', minHeadroomPct: 0 }],
        resumeRunId: 'run-1',
        onlyPhases: [3],
      }),
    );
  });

  it('the Launch button is under the quick view whichever tile is open, and it is the same button', async () => {
    // The departure line above the tiles has already said what will happen,
    // so the one Launch stays in the fixed footer while any tile is expanded.
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: RUN });
    const launch = await screen.findByTestId('launch-submit');
    expect(launch).toHaveAccessibleName('Run phase 3');
    for (const label of tileLabels()) {
      await tile(label);
      expect(region(label)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Run phase 3' })).toBe(launch);
    }
    fireEvent.click(launch);
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect((runStart.mock.calls[0]![1] as Record<string, unknown>).onlyPhases).toEqual([3]);
  });

  it('a continue resumes the run and never narrows it', async () => {
    await mount({ kind: 'continue', slug: 'alpha', run: RUN });
    await tile('Git');
    await within(region('Git')).findByLabelText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(runStart).toHaveBeenCalled());
    const payload = runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.resumeRunId).toBe('run-1');
    expect('onlyPhases' in payload).toBe(false);
  });

  it('a recovery submit merges the attached defaults into the skills it sends', async () => {
    await mount(
      { kind: 'recovery', recoveryClass: 'plan-repair', slug: 'alpha' },
      { attachDefaultSkills: true },
    );
    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: /Repair the plan with a new agent/ }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalled());
    const body = agentTicket.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.intent).toBe('recovery');
    expect(body.recoveryClass).toBe('plan-repair');
    expect(body.skills).toEqual(['graph-tool']);
    expect('model' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
  });
});

describe('a claimed phase', () => {
  const HELD = {
    owner: 'someone/else',
    expired: false,
    host: 'their-box',
    leaseUntil: Date.now() + 18 * 60_000,
    claimedAt: Date.now() - 12 * 60_000,
  };

  it('refuses to submit, and says who holds it — whichever tile is open', async () => {
    // The dialog agrees with the server rather than discovering the 409 after
    // the click. A dialog that submits into a refusal lied about its button.
    await mount({ kind: 'phase', slug: 'alpha', phase: 4, run: null, lock: HELD });

    await screen.findByText(/is claimed by/);
    expect(screen.getByText('someone/else')).toBeTruthy();
    expect(screen.getByText('their-box')).toBeTruthy();

    const submit = screen.getByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(runStart).not.toHaveBeenCalled();

    // The banner sits above the quick view, so a reader down in the last tile still sees it.
    await tile('Decisions');
    expect(region('Decisions')).toBeTruthy();
    expect(screen.getByText(/is claimed by/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run phase 4/ }).hasAttribute('disabled')).toBe(true);
  });

  it('a LAPSED claim warns but still launches', async () => {
    await mount({
      kind: 'phase',
      slug: 'alpha',
      phase: 4,
      run: null,
      lock: { ...HELD, expired: true },
    });

    await screen.findByText(/lapsed on this phase/);
    const submit = screen.getByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(runStart).toHaveBeenCalled());
  });

  it('an unclaimed phase shows no claim banner at all', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 4, run: null });
    await tile('Engine');
    await within(region('Engine')).findByLabelText('Model');
    expect(screen.queryByText(/is claimed by/)).toBeNull();
    expect(screen.getByRole('button', { name: /Run phase 4/ }).hasAttribute('disabled')).toBe(false);
  });
});

describe('the resolved QA gate is stated before launch', () => {
  it('says so when the PLAN turns QA on, whatever the console default is', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'on' });
    await tile('Review and QA');
    expect(await within(region('Review and QA')).findByText(/declares .*QA gate.*on/)).toBeInTheDocument();
    expect(screen.queryByText(/Turn the QA gate on/)).toBeNull();
  });

  it('says so when the plan waives it', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'waived' });
    await tile('Review and QA');
    expect(await within(region('Review and QA')).findByText(/do not hold dependents/)).toBeInTheDocument();
  });

  it('stays quiet when QA is simply off — the toggle speaks for itself', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'off', allowWrites: true });
    await tile('Review and QA');
    expect(screen.queryByText(/declares/)).toBeNull();
    expect(
      (await within(region('Review and QA')).findAllByText(/Turn the QA gate on/)).length,
    ).toBeGreaterThan(0);
  });
});
