/**
 * The automation defaults card.
 *
 * What matters here mirrors the notifications card next to it: the card
 * renders the SERVER's values with the documented fallbacks (a config from
 * before the keys existed must read skills-off, QA-off, current-branch,
 * PR-on, guard-on), each toggle sends exactly its own key as a delta, and the
 * PR row exists only where it means anything — under the work-branch mode.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs } = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs } };
});

function mount(prefs: Record<string, unknown> = {}, defaultSkills: string[] = ['graph-tool']) {
  state.mockResolvedValue({ prefs, defaultSkills });
  const client = new QueryClient(queryClientConfig);
  return import('./automation-card').then(({ AutomationCard }) =>
    render(
      <QueryClientProvider client={client}>
        <AutomationCard />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  savePrefs.mockResolvedValue({});
});

/** By id, not by position: this card has more than one select in it now. */
async function branchSelect(): Promise<HTMLSelectElement> {
  await screen.findByLabelText('Branch');
  return screen.getByLabelText('Branch') as HTMLSelectElement;
}

describe('the automation defaults card', () => {
  it('a config from before the keys existed reads as the documented defaults', async () => {
    await mount({});
    // Skills, QA and the per-phase reviewer open Off; the guard, the two
    // recovery-automation knobs and `cmd:` watch refs open On; the PR row is
    // hidden under the default branch mode, and so is the reviewer's own
    // policy row — it is only meaningful with the reviewer on. Exactly seven
    // toggles render.
    //
    // The fourth On is `watchCmdRefs`, added with the watch clock; the fifth is
    // `deleteMergedRunBranches`, added with the branch hygiene sweep. This
    // count was three until the first of those landed, and it has now gone red
    // three separate times for the same reason: `test:client` is not in every
    // phase's Verification list, so a phase adds a row and nothing says so
    // until somebody runs the client suite.
    //
    // 🔑 The counted-toggles shape is exactly the assertion that cannot survive
    // a row being added silently, and that is what it is for — so it stays. But
    // a bare count answers "expected 5 to be 4", which tells the next person
    // nothing about WHICH row appeared. Naming them costs nothing and turns the
    // same failure into its own explanation. The `data-pref` markers are the
    // same ones the coverage test walks.
    // The counts cover the WHOLE card, including the rows `<RunSetup>` renders
    // (skills, QA, the per-phase reviewer, auto-recovery) — those are the same
    // controls the launch form shows, so they carry no `data-pref` of their own.
    // The fourth Off is `watchMintedCmdRefs` (zero-touch-console phase 6,
    // SLF-8): a `cmd:` ref the console minted itself is never run by default.
    // The fifth Off is `radarSerialize` (many-plans-one-repo phase 9): a
    // conflicted radar pair stays advisory until an operator says otherwise.
    // The sixth On is `messaging` (many-plans-one-repo phase 15): sessions may
    // message each other unless a plan or an operator says otherwise — a Pro
    // row, so the free client suite (which `verify-free` runs on the stripped
    // tree) counts it only where it renders: `5 + PRO_ON`, never a bare 6.
    const PRO_ON = [
    ].length;
    const off = await screen.findAllByRole('button', { name: 'Off' });
    expect(off.length).toBe(5);
    expect(screen.getAllByRole('button', { name: 'On' }).length).toBe(5 + PRO_ON);
    // …and the card's OWN toggles are named, so the next addition says which.
    const toggles = Object.fromEntries(
      [...document.querySelectorAll('button[data-pref]')].map((el) => [
        el.getAttribute('data-pref'),
        el.textContent,
      ]),
    );
    expect(toggles).toEqual({
      repoGuard: 'On',
      radarSerialize: 'Off',
      autoContinueRecovery: 'On',
      watchCmdRefs: 'On',
      watchMintedCmdRefs: 'Off',
      deleteMergedRunBranches: 'On',
      // The sixth row is the worktree root, added with the project-local lane
      // folder: a config from before the key reads as the project.
      worktreeRoot: 'Inside the project',
    });
    // By label, not by position: phase 15 put four more selects on this card.
    const branch = screen.getByLabelText('Branch') as HTMLSelectElement;
    const mcp = screen.getByLabelText('When an MCP server is unavailable') as HTMLSelectElement;
    expect(branch.value).toBe('default-branch');
    // The behaviour change this release is a default moving, so the upgrade
    // path is what matters most: a console whose config predates the key gets
    // `continue`, without a migration and without opening this page.
    expect(mcp.value).toBe('continue');
  });

  it('the MCP policy is a choice, and sends only its own key', async () => {
    await mount({ mcpPolicy: 'require' });
    const mcp = (await screen.findByLabelText('When an MCP server is unavailable')) as HTMLSelectElement;
    expect(mcp.value).toBe('require');
    fireEvent.change(mcp, { target: { value: 'continue' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ mcpPolicy: 'continue' }));
  });

  it('lists the machine default skills as data, never as copy', async () => {
    await mount({}, ['graph-tool', 'indexer']);
    expect(await screen.findByText('graph-tool')).toBeTruthy();
    expect(screen.getByText('indexer')).toBeTruthy();
  });

  it('each toggle sends exactly its own key', async () => {
    await mount({});
    const rows = await screen.findByText('Repository guard');
    expect(rows).toBeTruthy();
    // By its own key, not by position. "The last pressed button" meant the
    // repository guard until the branch-hygiene toggle was added after it, and
    // then it silently meant something else — the test still clicked a toggle
    // and still asserted `repoGuard`, so it failed for a reason that had
    // nothing to do with what it was checking.
    const guard = document.querySelector<HTMLButtonElement>('button[data-pref="repoGuard"]');
    expect(guard).toBeTruthy();
    fireEvent.click(guard!);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ repoGuard: false }));
  });

  it('the settle row appears only under the work-branch mode', async () => {
    await mount({});
    const branch = await branchSelect();
    expect(screen.queryByText('When the plan completes')).toBeNull();
    expect(screen.getByText(/applies to work-branch runs/)).toBeTruthy();

    fireEvent.change(branch, { target: { value: 'new-branch' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ gitMode: 'new-branch' }));
  });

  it('renders the stored choices, not the defaults, when the server has them', async () => {
    await mount({ gitMode: 'new-branch', repoGuard: false, attachDefaultSkills: true });
    expect((await branchSelect()).value).toBe('new-branch');
    expect(await screen.findByText('When the plan completes')).toBeTruthy();
  });
});

describe('phase 15 — the launch defaults and the eighth flag', () => {
  it('renders the three checkout defaults phase 7 stored with no control', async () => {
    await mount({});
    expect(await screen.findByLabelText('Base branch')).toBeInTheDocument();
    expect(screen.getByLabelText('Runs beside it in the repository')).toBeInTheDocument();
    expect(screen.getByLabelText('When the run settles, its checkouts')).toBeInTheDocument();
  });


  it('states whether --allow-publish is on — a start flag, never a preference', async () => {
    state.mockResolvedValue({ prefs: {}, defaultSkills: [], allowPublish: false });
    const client = new QueryClient(queryClientConfig);
    const { AutomationCard } = await import('./automation-card');
    render(
      <QueryClientProvider client={client}>
        <AutomationCard />
      </QueryClientProvider>,
    );
    const line = await screen.findByTestId('publish-flag');
    expect(line).toHaveTextContent(/--allow-publish/);
    expect(line).toHaveTextContent(/off/);
    // There is no control: a start flag is changed at the start command.
    expect(screen.queryByRole('button', { name: /allow-publish/ })).toBeNull();
  });
});
