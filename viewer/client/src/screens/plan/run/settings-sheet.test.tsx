/**
 * The run's verbs and the door to its settings (7.0, quiet-console phase 11;
 * the cases carried from `features/runs/lane-setup.test.tsx`,
 * `settings-sheet.test.tsx` and `review-now.test.tsx`).
 *
 * Pinned: the opener's three names by state, and that it opens the sheet on a
 * console without `--allow-run`, with the form told so; the sheet's mode, its
 * title and the fields a working lane holds; Continue is never offered over a
 * session that has not stopped; the lifecycle verbs press their doors and Stop
 * asks first; the review is one billed press after a question; the two
 * one-tap patches' payloads; and the per-field note, read off the table.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post, request, setupProps, accountProps } = vi.hoisted(() => ({
  post: vi.fn(),
  request: vi.fn(),
  setupProps: [] as Record<string, unknown>[],
  accountProps: [] as Record<string, unknown>[],
}));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => request(path),
    post: (path: string, body?: unknown) => post(path, body),
  };
});
// The launch form (through its door) and the account row: stubs
// that record what the sheet hands them, and draw the description it composed.
vi.mock('@/screens/launch/door', () => ({
  LaunchForm: (props: Record<string, unknown>) => {
    setupProps.push(props);
    const overlay = props.overlay as { title: string; description?: ReactNode };
    return (
      <div role="dialog" aria-label={overlay.title} data-testid="run-setup">
        {overlay.description}
      </div>
    );
  },
}));
vi.mock('@/screens/settings/account-row', () => ({
  ACCOUNT_RECOVERY_PARTS: {},
  RunAccountRow: (props: Record<string, unknown>) => {
    accountProps.push(props);
    return null;
  },
}));

import {
  LIVE_LANE_LOCKED_FIELDS,
  SETTING_EFFECTS,
  SETTING_EFFECT_LABELS,
  SETTING_VERBS,
} from '@shared/run-settings.js';
import type { PhaseView } from '@/data/api/plans';
import type { RunState } from '@/data/api/runs';
import { keys, queryClientConfig } from '@/data/keys';
import { Button } from '@/ui';
import { RunSettingsNote, RunVerbs, useRunPatch, type RunVerbsProps } from './settings-sheet';

function client() {
  return new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function mount(node: ReactNode, queryClient = client()) {
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

const BASE = {
  id: 'run-1',
  slug: 'alpha',
  status: 'running',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'keep-going',
  activePhase: 2,
  pause: null,
  freeze: null,
  halt: null,
  phases: {},
} as unknown as RunState;
const run = (patch: Record<string, unknown>): RunState => ({ ...BASE, ...patch }) as RunState;

const RUNNING = run({ phases: { '2': { phase: 2, status: 'running' } } });
const HALTED = run({ status: 'halted', activePhase: null });

function verbs(props: Partial<RunVerbsProps> = {}) {
  return (
    <RunVerbs
      slug="alpha"
      run={RUNNING}
      live
      stillWorking={false}
      allowRun
      allowWrites
      planPhases={[] as PhaseView[]}
      planSkills={[]}
      qaMode="off"
      {...props}
    />
  );
}

const row = () => screen.getByTestId('run-verbs');
const lastSetup = () => setupProps.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  setupProps.length = 0;
  accountProps.length = 0;
  post.mockResolvedValue({ run: null });
  request.mockImplementation((path: string) => Promise.reject(new Error(`unmocked ${path}`)));
});

describe('the settings opener — one name per state', () => {
  const cases: [string, Partial<RunVerbsProps>, string][] = [
    ['a live run', { run: RUNNING, live: true }, 'Settings'],
    ['a stopped run whose lane still works', { run: HALTED, live: false, stillWorking: true }, 'Settings'],
    ['a stopped run', { run: HALTED, live: false }, 'Continue this run'],
    ['no run yet', { run: null, live: false }, 'Start a run'],
    ['a finished run', { run: run({ status: 'finished' }), live: false }, 'Start a run'],
  ];
  for (const [what, props, name] of cases) {
    it(`${what} reads "${name}"`, () => {
      mount(verbs(props));
      expect(within(row()).getByRole('button', { name })).toBeEnabled();
    });
  }

  it('never offers Continue over a session that has not stopped — and says why', () => {
    // A halted run whose session still edits the tree: Continue would be a
    // second agent on one working tree, which the server refuses.
    mount(verbs({ run: HALTED, live: false, stillWorking: true }));
    expect(screen.queryByRole('button', { name: /Continue this run/ })).toBeNull();
    expect(screen.getByText(/second agent on the same working tree/)).toBeInTheDocument();
  });
});

describe('the sheet', () => {
  it('is mounted only while open, and closes when the form is done', () => {
    mount(verbs({ run: HALTED, live: false }));
    expect(screen.queryByTestId('run-setup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue this run' }));
    expect(screen.getByRole('dialog', { name: 'Continue this run' })).toBeInTheDocument();
    expect(lastSetup()).toMatchObject({
      mode: 'continue',
      context: { slug: 'alpha', run: HALTED },
      laneWorking: false,
    });
    act(() => (lastSetup().onDone as () => void)());
    expect(screen.queryByTestId('run-setup')).toBeNull();
  });

  it('opens as a settings PATCH while a lane still works, naming what the lane holds', () => {
    mount(verbs({ run: HALTED, live: false, stillWorking: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(lastSetup()).toMatchObject({
      mode: 'live',
      laneWorking: true,
      blocked: false,
      allowWrites: true,
      qaMode: 'off',
      overlay: { open: true, title: 'Run settings' },
    });
    expect(lastSetup()).not.toHaveProperty('blockedReason');
    const sheet = screen.getByRole('dialog', { name: 'Run settings' });
    expect(within(sheet).getByText(/refused by\s+name, and everything else is applied/)).toBeInTheDocument();
  });

  it('a live run with a lane in flight holds its checkout; one whose lanes are only queued does not', () => {
    const { unmount } = mount(verbs({ run: RUNNING }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(lastSetup()).toMatchObject({ mode: 'live', laneWorking: true });
    // Live, so nothing is still working behind a stopped word: no held sentence.
    expect(screen.queryByText(/refused by\s+name/)).toBeNull();
    unmount();

    mount(verbs({ run: run({ phases: { '3': { phase: 3, status: 'queued' } } }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(lastSetup()).toMatchObject({ mode: 'live', laneWorking: false });
  });

  it('starts a run when there is none', () => {
    mount(verbs({ run: null, live: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Start a run' }));
    expect(lastSetup()).toMatchObject({ mode: 'start', context: { slug: 'alpha', run: null } });
    expect(screen.getByRole('dialog', { name: 'Start a run' })).toBeInTheDocument();
  });

  it('opens without --allow-run, and the form is told what this console cannot do', () => {
    mount(verbs({ run: HALTED, live: false, allowRun: false }));
    const opener = screen.getByRole('button', { name: 'Continue this run' });
    expect(opener).toBeEnabled();
    fireEvent.click(opener);
    expect(lastSetup()).toMatchObject({
      mode: 'continue',
      blocked: true,
      blockedReason: 'Controls need --allow-run.',
    });
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Controls need --allow-run.'),
    ).toBeInTheDocument();
    // The account row is drawn, and stands disabled with the rest.
    expect(accountProps.at(-1)).toMatchObject({ slug: 'alpha', run: HALTED, disabled: true });
  });
});

describe('the lifecycle verbs', () => {
  it('a live run pauses after its phase and freezes now, each through its own door', async () => {
    mount(verbs());
    fireEvent.click(within(row()).getByRole('button', { name: 'Pause after this phase' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/pause', undefined));
    await waitFor(() => expect(within(row()).getByRole('button', { name: 'Freeze now' })).toBeEnabled());
    fireEvent.click(within(row()).getByRole('button', { name: 'Freeze now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/freeze', undefined));
  });

  it('says what it is doing while the door answers, and holds the other verbs', () => {
    post.mockImplementation(() => new Promise(() => {}));
    mount(verbs());
    fireEvent.click(within(row()).getByRole('button', { name: 'Pause after this phase' }));
    expect(within(row()).getByRole('button', { name: 'Arming…' })).toBeDisabled();
    expect(within(row()).getByRole('button', { name: 'Freeze now' })).toBeDisabled();
  });

  it('a pausing run cancels the pause; a frozen one continues its session', async () => {
    const { unmount } = mount(verbs({ run: run({ status: 'pausing' }) }));
    fireEvent.click(within(row()).getByRole('button', { name: 'Cancel pause — keep going' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/resume', undefined));
    unmount();

    mount(verbs({ run: run({ status: 'frozen', freeze: { at: 'x', phase: 2, pid: 1, by: 'me' } }) }));
    fireEvent.click(within(row()).getByRole('button', { name: 'Continue the frozen session' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/thaw', undefined));
  });

  it('Stop asks first, saying what stopping costs, and only then stops', async () => {
    mount(verbs());
    fireEvent.click(within(row()).getByRole('button', { name: 'Stop now' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByText('Stop the run now?')).toBeInTheDocument();
    expect(ask).toHaveTextContent(/SIGTERM/);
    expect(ask).toHaveTextContent(/recorded as interrupted, not failed/);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Stop now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/stop', undefined));
  });

  it('a stopped run offers none of them; a console without --allow-run shows them disabled', () => {
    const { unmount } = mount(verbs({ run: HALTED, live: false }));
    for (const name of ['Pause after this phase', 'Freeze now', 'Stop now']) {
      expect(within(row()).queryByRole('button', { name })).toBeNull();
    }
    unmount();
    mount(verbs({ allowRun: false }));
    for (const name of ['Pause after this phase', 'Freeze now', 'Stop now']) {
      expect(within(row()).getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('Review the branch now', () => {
  it('asks first — it is billed — then runs one review and says what it found', async () => {
    post.mockResolvedValue({
      slug: 'alpha',
      phase: 7,
      state: 'landed',
      verdict: 'approve',
      findings: 2,
      ms: 1000,
    });
    mount(verbs());
    fireEvent.click(within(row()).getByRole('button', { name: 'Review the branch now' }));
    const ask = await screen.findByRole('alertdialog');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Review the branch now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/alpha/ultrareview', undefined));
    expect(await screen.findByTestId('review-now-answer')).toHaveTextContent(
      'Reviewed phase 7: approve, 2 findings.',
    );
  });

  it('never words a review that could not run as one that found nothing', async () => {
    post.mockResolvedValue({ slug: 'alpha', phase: 7, state: 'unknown', reason: 'no branch pushed', ms: 5 });
    mount(verbs());
    fireEvent.click(within(row()).getByRole('button', { name: 'Review the branch now' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Review the branch now' }),
    );
    expect(await screen.findByTestId('review-now-answer')).toHaveTextContent(
      'The review could not run: no branch pushed.',
    );
  });

  it('is disabled without --allow-run, and absent with no run to review', () => {
    const { unmount } = mount(verbs({ allowRun: false }));
    expect(within(row()).getByRole('button', { name: 'Review the branch now' })).toBeDisabled();
    unmount();
    mount(verbs({ run: null, live: false }));
    expect(within(row()).queryByRole('button', { name: 'Review the branch now' })).toBeNull();
  });
});

describe('useRunPatch — the two one-tap patches', () => {
  function Probe() {
    const patch = useRunPatch('alpha');
    return (
      <>
        <Button onClick={patch.clearScope}>Clear</Button>
        <Button onClick={patch.guard}>Guard</Button>
        <span data-testid="busy">{patch.busy ?? 'idle'}</span>
      </>
    );
  }

  it('each writes exactly one field to the settings door, and re-reads what a run act moves', async () => {
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mount(<Probe />, queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByTestId('busy')).toHaveTextContent('scope');
    await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('idle'));
    expect(post).toHaveBeenLastCalledWith('/api/run/alpha/settings', { onlyPhases: [] });
    for (const key of keys.afterRunAct('alpha')) expect(invalidate).toHaveBeenCalledWith({ queryKey: key });

    fireEvent.click(screen.getByRole('button', { name: 'Guard' }));
    expect(screen.getByTestId('busy')).toHaveTextContent('profile');
    await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('idle'));
    expect(post).toHaveBeenLastCalledWith('/api/run/alpha/settings', { permissionProfile: 'guarded' });
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('RunSettingsNote — what a patch does, and when', () => {
  const landing = (word: string) =>
    Object.keys(SETTING_EFFECTS).filter((field) => SETTING_EFFECTS[field] === word);

  it('says what lands now and what from the next phase, each list read off SETTING_EFFECTS', () => {
    const { container } = render(<RunSettingsNote stillWorking={false} />);
    for (const word of ['now', 'next-phase'] as const) {
      const group = container.querySelector(`[data-effect-group="${word}"]`)!;
      expect(group.textContent!.startsWith(`${SETTING_EFFECT_LABELS[word]}: `)).toBe(true);
      // The whole list, on hover — the table's fields, in the table's order.
      expect(group.getAttribute('title')).toBe(landing(word).join(', '));
    }
    expect(container.querySelector('[data-effect-group="now"]')).toHaveTextContent(/the lane cap/);
    expect(container.querySelector('[data-effect-group="next-phase"]')).toHaveTextContent(/model, effort/);
    expect(screen.queryByText(/refused by\s+name/)).toBeNull();
  });

  it('names who pays — the verb that moves it, and where a login is repaired', () => {
    render(<RunSettingsNote stillWorking={false} />);
    expect(screen.getByText(SETTING_VERBS.accountId)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings ▸ Accounts/ })).toHaveAttribute(
      'href',
      '#/settings/accounts',
    );
  });

  it('while a lane still works, names what it holds as refused', () => {
    render(<RunSettingsNote stillWorking />);
    expect(LIVE_LANE_LOCKED_FIELDS.length).toBe(2);
    expect(screen.getByText(/refused by\s+name, and everything else is applied/)).toHaveTextContent(
      'the branch strategy and the checkout',
    );
  });
});
