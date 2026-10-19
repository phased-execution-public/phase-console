/**
 * The run's notes, its asks, its budgets and its two cards (7.0, quiet-console
 * phase 11; the cases carried from the 6.2 strip's suite,
 * `features/runs/status-strip.test.tsx`, and its neighbours').
 *
 * The property the notes exist to give, kept from 6.2: each condition lights
 * exactly ONE note, and several stand in the declared order — never in
 * severity or source order. Then: the scoped and profile notes press their
 * one-field patch; a halt over a live run is history with no remedy; the
 * identity park's two ways on; a budget's raise before the park; the asks
 * drawn as their items; the expired login's sign-in and recheck; the stale
 * server's note.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { post, request, toastSpy } = vi.hoisted(() => ({
  post: vi.fn(),
  request: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => request(path),
    post: (path: string, body?: unknown) => post(path, body),
  };
});
vi.mock('@/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui')>();
  return { ...actual, toast: (...args: unknown[]) => toastSpy(...args) };
});
// The lent part, the account row; nothing here opens the launch form.
vi.mock('@/screens/settings/account-row', () => ({
  ACCOUNT_RECOVERY_PARTS: {},
  RunAccountRow: () => null,
}));

import { budgetHeadline, type BudgetFact } from '@shared/budget-model.js';
import { SHUTDOWN_CONTINUES } from '@shared/orchestration-model.js';
import type { AccountView } from '@/data/api/accounts';
import type { InboxAction, InboxItem } from '@/data/api/inbox';
import type { RunGitView, RunState } from '@/data/api/runs';
import { runStopOf } from '@/data/run-stop';
import { keys, queryClientConfig } from '@/data/keys';
import type { TurnView } from '@/data/turn';
import { TooltipProvider } from '@/ui/tooltip';
import {
  AuthCard,
  RUN_NOTE_ORDER,
  RunAsks,
  RunBudgetBanners,
  RunNotes,
  StaleServerNote,
  budgetApproaches,
  type RunNoteId,
} from './halt';

const AT = '2026-08-03T10:00:00.000Z';

function mount(node: ReactNode, opts: { allowRun?: boolean; inbox?: InboxItem[] } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: opts.allowRun ?? true,
    allowAgent: true,
    allowWrites: true,
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
    client.setQueryData(keys.inbox(all), { items: opts.inbox ?? [], generatedAt: AT });
  }
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const RUN = {
  id: 'abc1234',
  slug: 'demo',
  root: '/repo',
  status: 'running',
  autonomy: 'keep-going',
  model: 'opus',
  effort: 'max',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 1.5,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: AT,
  updatedAt: '2026-08-03T10:20:00Z',
  activePhase: 2,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: {},
} as unknown as RunState;

const run = (patch: Record<string, unknown>): RunState => ({ ...RUN, ...patch }) as RunState;

type NoteOpts = {
  live?: boolean;
  allowRun?: boolean;
  git?: RunGitView | null;
  fleetHold?: { at: string | null; by: string | null; scope?: 'machine' | 'restart' } | null;
};

const notes = (state: RunState | null, opts: NoteOpts = {}) => (
  <RunNotes
    slug="demo"
    run={state}
    live={opts.live ?? true}
    allowRun={opts.allowRun ?? true}
    git={opts.git ?? null}
    fleetHold={opts.fleetHold ?? null}
    authFailure={false}
    target={{ slug: 'demo', ...(state?.halt?.phase != null ? { phase: state.halt.phase } : {}) }}
  />
);

/** Every note this run raises, in the order the stack draws them. */
function ids(state: RunState | null, opts: NoteOpts = {}): string[] {
  const { container, unmount } = mount(notes(state, opts), { allowRun: opts.allowRun ?? true });
  const out = [...container.querySelectorAll('[data-note]')].map((el) => el.getAttribute('data-note')!);
  unmount();
  return out;
}

/** One note's element, mounted. */
function noteOf(id: RunNoteId, state: RunState, opts: NoteOpts = {}): HTMLElement {
  const { container } = mount(notes(state, opts), { allowRun: opts.allowRun ?? true });
  const el = container.querySelector<HTMLElement>(`[data-note="${id}"]`);
  if (!el) throw new Error(`no ${id} note`);
  return el;
}

const gitWith = (radar: RunGitView['radar']): RunGitView => ({
  at: AT,
  base: 'main',
  branch: 'pe/demo',
  files: [],
  filesTruncated: false,
  checkouts: [],
  radar,
});

const WAIT = '2026-08-25T02:40:42.850Z';

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ run: null });
  request.mockImplementation((path: string) => Promise.reject(new Error(`unmocked ${path}`)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunNotes — one note per condition', () => {
  it('raises nothing for an ordinary running run on a console that can act', () => {
    expect(ids(RUN)).toEqual([]);
    const { container } = mount(notes(RUN));
    expect(container.querySelector('[data-testid="run-notes"]')).toBeNull();
  });

  const cases: [RunNoteId, RunState, NoteOpts][] = [
    ['halt', run({ halt: { at: AT, reason: 'no handoff', phase: 2 } }), {}],
    ['ended', run({ status: 'finished', finishedReason: 'every phase is done' }), { live: false }],
    ['pause', run({ status: 'pausing', pause: { requestedAt: AT, afterPhase: 2, by: 'me' } }), {}],
    ['pause', run({ status: 'paused' }), { live: false }],
    [
      'frozen',
      run({
        status: 'frozen',
        freeze: { at: AT, phase: 2, pid: 1, by: 'me', escalateAt: '2026-08-03T12:00:00Z' },
      }),
      {},
    ],
    // The radar's own note: nothing about the RUN has changed, and two
    // branches it can see would not merge.
    [
      'conflict',
      RUN,
      { git: gitWith([{ a: 'pe/demo', b: 'pe/other', state: 'conflicted', files: ['a.ts'] }]) },
    ],
    ['waiting-window', run({ status: 'waiting', waitUntil: '2026-08-03T12:00:00Z' }), {}],
    // Paused ON the limit: the reset time is what separates it from `pause`.
    [
      'limit-paused',
      run({ status: 'paused', waitUntil: '2026-08-03T12:00:00Z', onLimit: 'pause' }),
      { live: false },
    ],
    ['budget', run({ limits: { status: 'limited', window: 'five_hour', utilization: 0.82, at: 'x' } }), {}],
    ['scoped', run({ onlyPhases: [3] }), {}],
    ['profile', run({ permissionProfile: 'bypass' }), {}],
    ['read-only', RUN, { allowRun: false }],
  ];

  for (const [id, state, opts] of cases) {
    it(`raises \`${id}\` and only \`${id}\` (${state.status})`, () => {
      expect(ids(state, opts)).toEqual([id]);
    });
  }

  it('covers every declared note across the cases above', () => {
    expect([...new Set(cases.map(([id]) => id))].sort()).toEqual([...RUN_NOTE_ORDER].sort());
  });

  it('stays quiet below its thresholds — an allowed or a three-quarters window, a guarded profile, an empty scope', () => {
    expect(ids(run({ limits: { status: 'allowed', utilization: 0.99, at: 'x' } }))).toEqual([]);
    expect(ids(run({ limits: { status: 'limited', utilization: 0.74, at: 'x' } }))).toEqual([]);
    expect(ids(run({ permissionProfile: 'guarded' }))).toEqual([]);
    expect(ids(run({ onlyPhases: [] }))).toEqual([]);
  });

  it('does not explain the ending of a run still going, and leaves a halted run’s ending to the halt', () => {
    expect(ids(run({ finishedReason: 'budget spent' }), { live: true })).toEqual([]);
    const halted = run({
      status: 'halted',
      halt: { at: AT, reason: 'a person is needed' },
      finishedReason: 'halted',
    });
    expect(ids(halted, { live: false })).toEqual(['halt']);
  });
});

describe('RunNotes — the declared order', () => {
  it('puts several notes in the declared priority, not in severity or source order', () => {
    // A halted, scoped, bypass run on a read-only console: four at once.
    const state = run({
      status: 'halted',
      halt: { at: AT, reason: 'stopped', phase: 1 },
      onlyPhases: [1],
      permissionProfile: 'bypass',
    });
    expect(ids(state, { live: false, allowRun: false })).toEqual(['halt', 'scoped', 'profile', 'read-only']);
  });

  it('sits the radar below a freeze and above the usage window — cheap to fix now, not urgent', () => {
    const state = run({
      status: 'frozen',
      freeze: { at: AT, phase: 2, pid: 1, by: 'me' },
      waitUntil: '2026-08-03T12:00:00Z',
    });
    expect(
      ids(state, { git: gitWith([{ a: 'pe/demo', b: 'pe/other', state: 'conflicted', files: [] }]) }),
    ).toEqual(['frozen', 'conflict', 'waiting-window']);
  });

  it('draws them as one stack — every note a child of the one wrapper', () => {
    const state = run({ status: 'halted', halt: { at: AT, reason: 'x', phase: 1 }, onlyPhases: [1] });
    const { getByTestId } = mount(notes(state, { live: false, allowRun: false }), { allowRun: false });
    const stack = getByTestId('run-notes');
    expect([...stack.children].map((child) => child.getAttribute('data-note'))).toEqual([
      'halt',
      'scoped',
      'read-only',
    ]);
  });
});

describe('RunNotes — the conflict radar', () => {
  it('raises nothing for clean, overlapping or unknown pairs', () => {
    for (const state of ['clean', 'overlap', 'unknown'] as const) {
      expect(ids(RUN, { git: gitWith([{ a: 'x', b: 'y', state, files: ['a.ts'] }]) })).toEqual([]);
    }
  });

  it('names the pairs and the files once each, as a caution — a merge that has not happened is no failure', () => {
    const note = noteOf('conflict', RUN, {
      git: gitWith([
        { a: 'pe/demo', b: 'pe/other', state: 'conflicted', files: ['viewer/server/a.ts'] },
        { a: 'pe/demo', b: 'pe/third', state: 'conflicted', files: ['viewer/server/a.ts'] },
        { a: 'pe/demo', b: 'main', state: 'clean', files: [] },
      ]),
    });
    expect(note).toHaveAttribute('data-severity', 'warn');
    expect(note.textContent).toContain('2 branch pairs would not merge.');
    expect(note.textContent).toContain('pe/demo ↔ pe/other');
    expect(note.textContent).toContain('pe/demo ↔ pe/third');
    expect(note.textContent!.match(/viewer\/server\/a\.ts/g)).toHaveLength(1);
    expect(note.textContent).not.toContain('main');
  });
});

describe('RunNotes — the one-field patches', () => {
  it('Run the whole plan clears the scope, saying so while it works', async () => {
    let settle: (value: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    mount(notes(run({ onlyPhases: [3] })));
    fireEvent.click(screen.getByRole('button', { name: 'Run the whole plan' }));
    expect(post).toHaveBeenCalledWith('/api/run/demo/settings', { onlyPhases: [] });
    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
    settle({ run: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run the whole plan' })).toBeEnabled());
    expect(toastSpy).toHaveBeenCalledWith('Scope cleared — this run continues through the whole plan', 'ok');
  });

  it('a press the owner must confirm is said as asked, never as done', async () => {
    post.mockResolvedValue({
      requested: true,
      request: { ask: 'Clear the scope of demo' },
      error: 'This waits for the owner to confirm it.',
    });
    mount(notes(run({ onlyPhases: [3] })));
    fireEvent.click(screen.getByRole('button', { name: 'Run the whole plan' }));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith('This waits for the owner to confirm it.', 'info'),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(expect.stringMatching(/^Scope cleared/), 'ok');
  });

  it('Go back to Guarded puts a live run on the guarded profile — and is offered only while it is live', async () => {
    mount(notes(run({ permissionProfile: 'trusted' })));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to Guarded' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/settings', { permissionProfile: 'guarded' }),
    );
    const stopped = noteOf('profile', run({ status: 'halted', permissionProfile: 'trusted' }), {
      live: false,
    });
    expect(within(stopped).queryByRole('button')).toBeNull();
  });

  it('a console that may not act offers neither', () => {
    const scoped = noteOf('scoped', run({ onlyPhases: [3], permissionProfile: 'bypass' }), {
      allowRun: false,
    });
    expect(within(scoped).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go back to Guarded' })).toBeNull();
  });
});

describe('RunNotes — the halt is the halt card', () => {
  const halt = {
    at: AT,
    reason: 'nothing left to run on its own — phase 8 is done but its QA verdict is fail',
    phase: 8,
    kind: 'plan-deadlocked',
  };

  it('a stopped run’s card offers the recommended way forward', () => {
    const note = noteOf('halt', run({ status: 'halted', halt }), { live: false });
    expect(note.querySelector('[data-halt-category]')).not.toBeNull();
    expect(within(note).getByTestId('halt-recommended')).toBeInTheDocument();
  });

  it('a halt over a live run is history: the stop as it was, and no remedy', () => {
    // Every remedy boards a session onto a phase that already holds one.
    const note = noteOf('halt', run({ status: 'running', halt }), { live: true });
    expect(note).toHaveTextContent('The console picked this run back up');
    expect(within(note).queryByTestId('halt-recommended')).toBeNull();
  });

  it('a budget halt says the autopilot already raised the budget once', () => {
    const note = noteOf(
      'halt',
      run({
        status: 'halted',
        halt: { at: AT, reason: 'the run budget of $50.00 is spent', kind: 'budget' },
        budgetRaise: { from: 40, to: 50, pct: 25, at: AT },
      }),
      { live: false },
    );
    expect(note.textContent).toMatch(
      /already raised the run budget once, from \$40\.00 to \$50\.00 \(\+25%\)/,
    );
  });

  describe('a stop written on a phase, not on the run', () => {
    // How the runner parks a run on a red verification or a wait that ran out:
    // the run carries no halt, and its phase's record carries the stop.
    const red = {
      at: AT,
      reason: '§Verification was red: 3 of 41 tests failed',
      phase: 2,
      kind: 'verify-failed',
    };
    const parked = run({
      status: 'parked',
      halt: null,
      phases: {
        1: { phase: 1, status: 'done', attempts: 1, costUsd: 1 },
        2: { phase: 2, status: 'failed', attempts: 2, costUsd: 2, halt: red },
        3: {
          phase: 3,
          status: 'parked',
          attempts: 1,
          costUsd: 0,
          halt: { at: AT, reason: 'the wait on the pull request ran out', kind: 'waiting-external-timeout' },
        },
      },
    });

    it('a parked run draws its lowest stopped phase’s card, with the way forward', () => {
      const note = noteOf('halt', parked, { live: false });
      const card = within(note).getByTestId('halt-card');
      expect(card).toHaveAttribute('data-halt-category', 'verification');
      expect(card).toHaveTextContent('demo, phase 2');
      expect(within(note).getByTestId('halt-recommended')).toBeInTheDocument();
    });

    it('reads the run’s own stop first, and the phase’s number from its record when the stop omits it', () => {
      const own = { at: AT, reason: 'the run budget of $50.00 is spent', kind: 'budget' };
      expect(runStopOf(run({ status: 'halted', halt: own, phases: parked.phases }), false)).toBe(own);
      expect(runStopOf(parked, false)).toMatchObject({ kind: 'verify-failed', phase: 2 });
      const third = run({ status: 'parked', halt: null, phases: { 3: parked.phases['3'] } });
      expect(runStopOf(third, false)).toMatchObject({ kind: 'waiting-external-timeout', phase: 3 });
      expect(runStopOf(null, false)).toBeNull();
    });

    it('draws no phase’s card once the run is live again, or the stop is resolved', () => {
      expect(ids({ ...parked, status: 'running' } as RunState, { live: true })).not.toContain('halt');
      const resolved = { ...parked, resolved: { at: AT, auto: true, reason: 'the board moved past it' } };
      expect(ids(resolved as RunState, { live: false })).not.toContain('halt');
    });
  });

  describe('an identity park (control-tower phase 91, #131)', () => {
    const parked = run({
      status: 'halted',
      halt: { at: AT, reason: 'the machine login changed identity', phase: 2, kind: 'identity-changed' },
      identity: { account: 'default', key: 'k-admin', email: 'admin@example.com', at: AT },
    });

    it('offers both ways on, and answers through the identity verb', async () => {
      const note = noteOf('halt', parked, { live: false });
      expect(within(note).getByRole('button', { name: 'Move to admin@example.com’s profile' })).toBeEnabled();
      fireEvent.click(within(note).getByRole('button', { name: 'Continue on the new login' }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/api/run/demo/identity', { choice: 'continue' }),
      );
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Continuing on the new login.', 'ok'));
    });

    it('is shown, disabled, on a console that may not resume runs — and not at all once the run is live', () => {
      const note = noteOf('halt', parked, { live: false, allowRun: false });
      expect(within(note).getByRole('button', { name: 'Continue on the new login' })).toBeDisabled();
      const live = noteOf('halt', { ...parked, status: 'running' } as RunState, { live: true });
      expect(within(live).queryByTestId('identity-choice')).toBeNull();
    });
  });
});

describe('RunNotes — why the loop stopped', () => {
  const ERRAND = {
    phase: 4,
    situation: 'gated-manual',
    tried: [],
    need: 'A person to clear the manual gate — its numbered steps are on the Gate card.',
    how: "Do the steps, then press Approve on the phase's Gate card; the run retries the phase.",
    at: '',
  };

  it('a parked run lists its errands in full, as a caution', () => {
    const note = noteOf(
      'ended',
      run({
        status: 'parked',
        finishedReason: 'nothing left to run on its own — phase 4 is parked',
        recoveries: { '4': { attempts: 0, lastAt: '', errand: ERRAND } },
      }),
      { live: false },
    );
    expect(note).toHaveAttribute('data-severity', 'warn');
    expect(note).toHaveTextContent('Parked until you act.');
    const errand = within(note).getByTestId('errand');
    expect(errand).toHaveTextContent('Needs you — phase 4');
    expect(errand).toHaveTextContent(ERRAND.need);
    // The situation in the table's words, never its id.
    expect(errand).toHaveTextContent('Gate needs a person');
  });

  it('a resolved stop says so, quietly, and lists no errand', () => {
    const note = noteOf(
      'ended',
      run({
        status: 'parked',
        finishedReason: 'parked',
        resolved: { at: AT, auto: true, reason: 'superseded — the board shows phase 4 done' },
        recoveries: { '4': { attempts: 0, lastAt: '', errand: ERRAND } },
      }),
      { live: false },
    );
    expect(note).toHaveAttribute('data-severity', 'info');
    expect(note).toHaveTextContent('Stopped and resolved on its own.');
    expect(note).toHaveTextContent('superseded');
    expect(within(note).queryByTestId('errand')).toBeNull();
  });

  describe('a stop the console’s shutdown wrote, under a hold that outlived it (#93)', () => {
    const STOPPED = run({
      status: 'paused',
      stoppedBy: 'system',
      finishedReason: `the console shut down while this run was working — ${SHUTDOWN_CONTINUES}`,
    });
    const FROZE_AT = '2026-09-24T09:57:43.000Z';

    it('names the freeze — who, when, and the thaw — instead of the promise, and wears a caution', () => {
      const note = noteOf('ended', STOPPED, { live: false, fleetHold: { at: FROZE_AT, by: 'operator' } });
      expect(note.textContent).toContain(`frozen console-wide by operator at ${FROZE_AT} — thaw to continue`);
      expect(note.textContent).not.toMatch(/continues by itself/);
      expect(note).toHaveAttribute('data-severity', 'warn');
    });

    it('keeps the promise once the hold lifts, and under a restart’s own hold', () => {
      for (const fleetHold of [null, { at: FROZE_AT, by: 'a restart by mo', scope: 'restart' as const }]) {
        const { container, unmount } = mount(notes(STOPPED, { live: false, fleetHold }));
        const note = container.querySelector('[data-note="ended"]')!;
        expect(note.textContent).toMatch(/continues by itself once the console is back/);
        expect(note).toHaveAttribute('data-severity', 'info');
        unmount();
      }
    });

    it('names a machine hold as the supervisor’s, released there', () => {
      const note = noteOf('ended', STOPPED, {
        live: false,
        fleetHold: { at: FROZE_AT, by: 'the supervisor', scope: 'machine' },
      });
      expect(note.textContent).toMatch(
        /held machine-wide by the supervisor at .* — release the hold to continue/,
      );
      expect(note.textContent).not.toMatch(/continues by itself/);
      expect(note).toHaveAttribute('data-severity', 'warn');
    });
  });
});

describe('RunNotes — which wait this is', () => {
  const text = (state: RunState, opts: NoteOpts = {}) => {
    const { container, unmount } = mount(notes(state, opts));
    const said = container.querySelector('[data-testid="run-notes"]')?.textContent ?? '';
    unmount();
    return said;
  };

  it('does not call an external-work park a usage limit', () => {
    const state = run({ status: 'paused', waitUntil: WAIT, waitReason: 'external' });
    expect(ids(state, { live: false })).toEqual(['limit-paused']);
    const said = text(state, { live: false });
    expect(said).toMatch(/external work/i);
    expect(said).not.toMatch(/usage limit/i);
    expect(said).not.toMatch(/another account/i);
  });

  it('does not call an external-work park a usage window while it sleeps', () => {
    const state = run({ status: 'waiting', waitUntil: WAIT, waitReason: 'external' });
    expect(ids(state)).toEqual(['waiting-window']);
    expect(text(state)).toMatch(/external work/i);
    expect(text(state)).not.toMatch(/usage (limit|window)/i);
  });

  it('still says usage limit when the wall is what stopped it, and offers the other account', () => {
    const state = run({ status: 'paused', waitUntil: WAIT, waitReason: 'usage-limit', onLimit: 'pause' });
    expect(text(state, { live: false })).toMatch(/usage limit/i);
    expect(text(state, { live: false })).toMatch(/another account/i);
  });

  it('reads a wait the console stopped under as the wait it is — never "Stopped" (#148)', () => {
    const state = run({
      status: 'paused',
      stoppedBy: 'system',
      pause: null,
      waitUntil: WAIT,
      waitReason: 'external',
      phases: {
        '28': { phase: 28, status: 'waiting', parkedUntil: WAIT, watch: ['gh:acme/web#run/17843290511'] },
      },
    });
    expect(ids(state, { live: false })).toEqual(['limit-paused']);
    const said = text(state, { live: false });
    expect(said).toMatch(/^Waiting on phase 28 · gh:acme\/web#run\/17843290511 · resumes/);
    expect(said).toMatch(/resumes by itself/i);
    expect(said).not.toMatch(/Stopped/);
    expect(said).not.toMatch(/another account/i);

    // A usage window the console stopped under still offers the other account.
    const window = run({
      status: 'paused',
      stoppedBy: 'system',
      pause: null,
      waitUntil: WAIT,
      waitReason: 'usage-limit',
      accountId: 'max-2',
    });
    expect(text(window, { live: false })).toMatch(/^Waiting on max-2's usage window/);
    expect(text(window, { live: false })).toMatch(/another account/i);
  });

  it('keeps the usage-limit reading for a record written before the reason was', () => {
    // A clock with no reason on it: a limit is what the clock nearly always was.
    const state = run({ status: 'paused', waitUntil: WAIT });
    expect(text(state, { live: false })).toMatch(/usage limit/i);
  });

  it('a card only a person can answer is a wait on them, not on an account', () => {
    const state = run({ status: 'waiting', waitUntil: WAIT, waitReason: 'person' });
    expect(ids(state)).toEqual(['waiting-window']);
    expect(text(state)).toMatch(/for a person to answer a card/);
    expect(text(state)).not.toMatch(/usage/i);
  });
});

describe('RunBudgetBanners — a budget near its end, before the park', () => {
  const FACT = {
    budget: 'phase-usd',
    phase: 4,
    limit: 10,
    spent: 8.5,
    left: 1.5,
    unit: 'usd',
    spentOn: [],
    at: AT,
  } as unknown as BudgetFact;
  const APPROACHING = run({
    phases: {
      '4': { phase: 4, status: 'running', budgetApproaching: { 'phase-usd': FACT } },
      '2': { phase: 2, status: 'done', budgetApproaching: { 'phase-usd': { ...FACT, phase: 2 } } },
    },
  });

  it('is drawn with its headline and its raise — a done phase’s is not', async () => {
    expect(budgetApproaches(APPROACHING)).toHaveLength(1);
    mount(<RunBudgetBanners slug="demo" run={APPROACHING} />);
    const card = screen.getByTestId('budget-approaching');
    expect(card).toHaveTextContent(`Phase 4: ${budgetHeadline(FACT, 'approaching')}`);
    fireEvent.click(within(within(card).getByTestId('budget-raise')).getAllByRole('button')[0]!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/raise-budget', {
        budget: 'phase-usd',
        phase: 4,
        add: 10,
      }),
    );
  });

  it('draws nothing when no budget approaches', () => {
    const { container } = mount(<RunBudgetBanners slug="demo" run={RUN} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RunAsks — the run’s asks, each its item', () => {
  const action = (verb: string, label: string): InboxAction => ({
    verb,
    label,
    endpoint: `/api/x/${verb}`,
    method: 'POST',
  });
  /** A row's fields, its turn view by part — merged over the defaults below. */
  type RowOver = Omit<Partial<InboxItem>, 'turn'> & { turn?: Partial<TurnView> };
  const row = (id: string, over: RowOver = {}): InboxItem => {
    const { turn, ...rest } = over;
    return {
      id,
      kind: 'approval',
      severity: 'urgent',
      slug: 'demo',
      phase: 3,
      runId: 'r1',
      title: `Row ${id}`,
      need: '',
      how: '',
      since: AT,
      href: '/plan/demo/run',
      actions: [action('allow', 'Allow'), action('deny', 'Deny')],
      turn: {
        item: id,
        record: 'projected',
        source: 'approval',
        kind: 'permission',
        why: 'permission',
        proofType: 'grant',
        group: 'now',
        ...turn,
      },
      ...rest,
    } as InboxItem;
  };
  const question = row('q1', {
    kind: 'question',
    title: 'Which colour should the banner be?',
    actions: [action('answer', 'Red'), action('answer', 'Blue (Recommended)')],
    turn: { source: 'question', kind: 'decision', why: 'decision', proofType: 'answer', group: 'decide' },
  });

  it('draws a broker card and a relayed question of this run as their rows, in a summons frame', async () => {
    mount(<RunAsks runId="r1" slug="demo" />, { inbox: [row('b1'), question, row('b2', { runId: 'r2' })] });
    const drawn = await screen.findAllByTestId('item-row');
    expect(drawn.map((el) => el.getAttribute('data-item'))).toEqual(['b1', 'q1']);
    const queue = screen.getByTestId('approval-queue');
    expect(queue).toHaveClass('state-needs-you');
    expect(within(queue).getByRole('heading', { name: /Waiting on you/ })).toHaveTextContent(
      'Waiting on you2',
    );
    expect(within(drawn[0]!).getByTestId('item-link')).toHaveAttribute('href', '#/turn/b1');
    // A question's options are the page's, never a second shape here.
    expect(screen.queryByRole('button', { name: 'Red' })).toBeNull();
  });

  it('draws nothing when no ask of this run waits', () => {
    const { container } = mount(<RunAsks runId="r1" />, { inbox: [row('b2', { runId: 'r2' })] });
    expect(container).toBeEmptyDOMElement();
  });

  it('offers to notify where the value is on screen, and says what the browser answered', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    mount(<RunAsks runId="r1" />, { inbox: [row('b1')] });
    fireEvent.click(screen.getByRole('button', { name: 'Notify me next time' }));
    expect(await screen.findByText('You will be notified when this happens again.')).toBeInTheDocument();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('AuthCard — an expired login, and the fix one press away', () => {
  const AUTH = { loggedIn: false, checkedAt: AT };

  it('the machine login: opens a terminal on the sign-in, offers the command, and checks again on request', async () => {
    post.mockResolvedValue({ opened: true });
    const onRecheck = vi.fn();
    mount(<AuthCard auth={AUTH} allowRun onRecheck={onRecheck} />);
    expect(screen.getByRole('heading', { name: 'Claude Code is signed out' })).toBeInTheDocument();
    expect(screen.getByText('claude auth login')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal and sign in' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/auth/login', undefined));
    expect(await screen.findByText(/Finish signing in over there/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('the run’s own profile: signs THAT account in, and shows the command the server composed', async () => {
    post.mockResolvedValue({
      accountId: 'info',
      command: 'CLAUDE_CONFIG_DIR=/x claude auth login',
      mode: 'external',
    });
    const account = { id: 'info', kind: 'profile', builtIn: false, name: 'info' } as AccountView;
    mount(<AuthCard auth={AUTH} allowRun onRecheck={() => {}} account={account} />);
    expect(screen.getByRole('heading', { name: 'info is signed out' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign info in again' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/accounts/login', { accountId: 'info' }));
    expect(await screen.findByText('CLAUDE_CONFIG_DIR=/x claude auth login')).toBeInTheDocument();
  });

  it('a token account is pasted afresh in Settings, never signed in', () => {
    const account = { id: 'tok', kind: 'token', builtIn: false, name: 'ci' } as AccountView;
    mount(<AuthCard auth={AUTH} allowRun onRecheck={() => {}} account={account} />);
    expect(screen.getByRole('link', { name: 'Paste a fresh setup-token in Settings' })).toHaveAttribute(
      'href',
      '#/settings/accounts',
    );
    expect(screen.queryByRole('button', { name: /sign/i })).toBeNull();
  });

  it('a console without --allow-run shows the sign-in disabled, and names the flag', () => {
    mount(<AuthCard auth={AUTH} allowRun={false} onRecheck={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open a terminal and sign in' })).toBeDisabled();
    expect(screen.getByText(/Opening a sign-in needs/)).toHaveTextContent(
      'Opening a sign-in needs --allow-run; the command above works regardless.',
    );
  });
});

describe('StaleServerNote', () => {
  it('says the server is older than the page, and what turns the autopilot on', () => {
    mount(<StaleServerNote />);
    const note = screen.getByTestId('stale-server-note');
    expect(note).toHaveTextContent('This console is running an older build.');
    expect(note).toHaveTextContent('--allow-run is what turns the autopilot on');
  });
});
