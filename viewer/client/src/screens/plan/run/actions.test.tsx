/**
 * The run's Actions tab (7.0, quiet-console phase 11; control-tower phases 90,
 * 97 and 98).
 *
 * For each of the six acts, three facts are pinned:
 *
 *   - **where its condition holds it can be pressed**, asking once (press,
 *     then Confirm), and the press is the route the server answers it on, with
 *     exactly the body that route reads;
 *   - **where it does not, it is still offered, disabled, saying which
 *     condition does not hold** — a verb that vanishes is a verb nobody knows
 *     exists;
 *   - **on a console without `--allow-run` every one is disabled, naming the
 *     flag**, whatever the run.
 *
 * The conditions are a pure model (`runActionsModel`), so most cases are read
 * off it; the presses go through the rendered tab, the way a person makes them.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post, cards, toast } = vi.hoisted(() => ({
  post: vi.fn(),
  cards: { list: [] as unknown[] },
  toast: vi.fn(),
}));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) =>
      path === '/api/approvals'
        ? Promise.resolve(cards.list)
        : path === '/api/state'
          ? Promise.resolve({ allowRun: true })
          : Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path)),
    post: (path: string, body?: unknown) => post(path, body),
  };
});
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import type { Approval, RunState } from '@/data/api/runs';
import { queryClientConfig } from '@/data/keys';
import { RunActions, runActionsModel, type RunActionId, type RunActionOffer } from './actions';

const AT = '2026-10-10T09:00:00.000Z';

/** A paused run on a branch of its own, in the shared checkout: phase 1 done, 2 parked, 3 pending. */
const RUN = {
  id: 'r1',
  slug: 'demo',
  root: '/repo',
  status: 'paused',
  autonomy: 'guarded',
  model: 'claude-opus-5-5',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 0,
  maxConsecutiveFailures: 3,
  consecutiveFailures: 0,
  createdAt: AT,
  updatedAt: AT,
  activePhase: null,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  gitMode: 'new-branch',
  checkout: 'shared',
  phases: {
    '1': { phase: 1, status: 'done' },
    '2': { phase: 2, status: 'parked' },
    '3': { phase: 3, status: 'pending' },
  },
} as unknown as RunState;

const run = (over: Record<string, unknown> = {}) => ({ ...RUN, ...over }) as RunState;

/** A permission card waiting on a person, raised by phase 2 of this run. */
const CARD = {
  id: 'a1',
  runId: 'r1',
  slug: 'demo',
  phase: 2,
  kind: 'tool',
  title: 'Bash(git push origin pe/demo)',
  detail: '',
  evidence: [],
  createdAt: AT,
  expiresAt: '2026-10-10T10:00:00.000Z',
  status: 'pending',
} as Approval;

const NEEDS_RUN = 'Needs --allow-run on this console.';

const model = (
  r: RunState,
  ctx: { allowRun?: boolean; phase?: number | null; approvals?: Approval[] } = {},
) =>
  runActionsModel(r, {
    allowRun: ctx.allowRun ?? true,
    phase: ctx.phase ?? null,
    approvals: ctx.approvals ?? [],
  });

const offerOf = (offers: readonly RunActionOffer[], id: RunActionId) => {
  const found = offers.find((o) => o.id === id);
  if (!found) throw new Error(`no ${id} offer`);
  return found;
};

function mount(r: RunState, allowRun = true) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunActions run={r} slug="demo" allowRun={allowRun} />
    </QueryClientProvider>,
  );
}

const row = (id: RunActionId) => screen.getAllByTestId('run-action').find((li) => li.dataset.action === id)!;

/** Press, then Confirm — an act asks once. */
async function pressRow(id: RunActionId) {
  const button = within(row(id)).getByRole('button');
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(button).toHaveTextContent('Confirm');
  // Asking is not doing.
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  cards.list = [];
  post.mockResolvedValue({ run: RUN });
});

describe('the six, in order', () => {
  it('offers all six whether or not they apply, in the tab’s order', () => {
    expect(model(RUN, { phase: 2 }).map((o) => o.id)).toEqual([
      'isolate',
      'isolate-phase',
      'board-at-boundary',
      'repair-checkout',
      'errand-tree',
      'extend',
    ]);
  });

  it('without --allow-run, every one is disabled, naming the flag — whatever the run', () => {
    const offers = model(run({ isolation: 'worktree' }), { allowRun: false, phase: 2, approvals: [CARD] });
    expect(offers.length).toBeGreaterThanOrEqual(6);
    for (const o of offers) {
      expect(o.enabled, o.id).toBe(false);
      expect(o.why, o.id).toBe(NEEDS_RUN);
    }
  });

  it('draws that refusal on every row of the tab, and no button can be pressed', async () => {
    cards.list = [CARD];
    mount(run({ isolation: 'worktree' }), false);
    await waitFor(() => expect(screen.getAllByTestId('run-action')).toHaveLength(6));
    for (const li of screen.getAllByTestId('run-action')) {
      expect(li).toHaveAttribute('data-enabled', 'false');
      expect(within(li).getByTestId('run-action-words')).toHaveTextContent(NEEDS_RUN);
      expect(within(li).getByRole('button')).toBeDisabled();
    }
  });
});

describe('isolate — give this run its own checkout', () => {
  it('holds on a shared checkout of a branch-mode run, and posts the isolate route', async () => {
    expect(offerOf(model(RUN), 'isolate').enabled).toBe(true);
    mount(RUN);
    await pressRow('isolate');
    expect(post).toHaveBeenCalledWith('/api/run/demo/isolate', {});
    expect(toast).toHaveBeenCalledWith('demo moves to a checkout of its own at its next boundary.', 'ok');
  });

  it('does not hold, and says which condition fails', () => {
    expect(offerOf(model(run({ checkout: 'worktree' })), 'isolate').why).toBe(
      'Only a run on a shared checkout can take one of its own.',
    );
    expect(offerOf(model(run({ gitMode: undefined })), 'isolate').why).toBe(
      'Only a run on a branch of its own can move to a checkout of its own.',
    );
    expect(offerOf(model(run({ isolateAtBoundary: { at: AT, by: 'mobin' } })), 'isolate').why).toBe(
      'Already asked by mobin: the run moves at its next boundary.',
    );
    expect(offerOf(model(run({ status: 'finished' })), 'isolate').why).toBe('The run is over.');
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(RUN, { allowRun: false }), 'isolate')).toMatchObject({
      enabled: false,
      why: NEEDS_RUN,
    });
  });
});

describe('isolate-phase — give phase N its own worktree', () => {
  it('holds for a phase not done on a shared checkout, and posts the phase', async () => {
    expect(offerOf(model(RUN, { phase: 2 }), 'isolate-phase')).toMatchObject({
      enabled: true,
      label: 'Give phase 2 its own worktree',
      target: { phase: 2 },
    });
    mount(RUN);
    // The picker opens on the first phase not done — phase 2.
    expect(screen.getByLabelText('Phase')).toHaveValue('2');
    await pressRow('isolate-phase');
    expect(post).toHaveBeenCalledWith('/api/run/demo/isolate-phase', { phase: 2 });
  });

  it('does not hold, and says which condition fails', () => {
    expect(offerOf(model(RUN, { phase: null }), 'isolate-phase').why).toBe('Pick a phase first.');
    expect(offerOf(model(RUN, { phase: 1 }), 'isolate-phase').why).toBe('Phase 1 is done.');
    expect(offerOf(model(run({ isolatePhases: [2] }), { phase: 2 }), 'isolate-phase').why).toBe(
      'Phase 2 already has a worktree of its own.',
    );
    expect(offerOf(model(run({ checkout: 'worktree' }), { phase: 2 }), 'isolate-phase').why).toBe(
      'The run already works in a checkout of its own.',
    );
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(RUN, { allowRun: false, phase: 2 }), 'isolate-phase').why).toBe(NEEDS_RUN);
  });
});

describe('board-at-boundary — board phase N at the next boundary', () => {
  it('holds for a phase not in flight and not done, and posts the phase with the instruction typed', async () => {
    expect(offerOf(model(RUN, { phase: 2 }), 'board-at-boundary').enabled).toBe(true);
    post.mockResolvedValue({
      run: RUN,
      queued: { runId: 'r1', phase: 2, session: null, brief: 'resume', position: 1 },
    });
    mount(RUN);
    fireEvent.change(within(row('board-at-boundary')).getByLabelText('Instruction'), {
      target: { value: 'Read the api handoff first.' },
    });
    await pressRow('board-at-boundary');
    expect(post).toHaveBeenCalledWith('/api/run/demo/board-at-boundary', {
      phase: 2,
      instruction: 'Read the api handoff first.',
    });
    expect(toast).toHaveBeenCalledWith('Phase 2 boards at the next boundary, place 1 in line.', 'ok');
  });

  it('sends no instruction when none was typed', async () => {
    mount(RUN);
    await pressRow('board-at-boundary');
    expect(post).toHaveBeenCalledWith('/api/run/demo/board-at-boundary', { phase: 2 });
  });

  it('does not hold, and says which condition fails', () => {
    const running = run({ phases: { ...RUN.phases, '2': { phase: 2, status: 'running' } } });
    expect(offerOf(model(running, { phase: 2 }), 'board-at-boundary').why).toBe(
      'Phase 2 is running now: steer it, or leave a note for its next attempt.',
    );
    expect(offerOf(model(RUN, { phase: 1 }), 'board-at-boundary').why).toBe(
      'Phase 1 is done: there is nothing to board.',
    );
    expect(offerOf(model(run({ status: 'finished' }), { phase: 2 }), 'board-at-boundary').why).toBe(
      'The run is over.',
    );
    expect(offerOf(model(RUN, { phase: null }), 'board-at-boundary').why).toBe('Pick a phase first.');
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(RUN, { allowRun: false, phase: 2 }), 'board-at-boundary').why).toBe(NEEDS_RUN);
  });
});

describe('repair-checkout — repair the checkout', () => {
  /** The refused-isolation park: asked for its own checkout, refused, parked. */
  const REFUSED = run({ status: 'parked', isolation: 'worktree', checkout: 'refused' });

  it('holds for a run that asked for its own checkout and is not driving, and posts the repair route', async () => {
    expect(offerOf(model(REFUSED), 'repair-checkout').enabled).toBe(true);
    mount(REFUSED);
    await pressRow('repair-checkout');
    expect(post).toHaveBeenCalledWith('/api/run/demo/repair-checkout', {});
    expect(toast).toHaveBeenCalledWith('demo resumes with its checkout rebuilt.', 'ok');
  });

  it('does not hold, and says which condition fails', () => {
    expect(offerOf(model(RUN), 'repair-checkout').why).toBe(
      'Only a run that asked for a checkout of its own has one to repair.',
    );
    for (const status of ['running', 'queued', 'halting', 'pausing']) {
      expect(offerOf(model(run({ isolation: 'worktree', status })), 'repair-checkout').why, status).toBe(
        'The run is driving: its next boundary asks for the checkout again by itself.',
      );
    }
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(REFUSED, { allowRun: false }), 'repair-checkout').why).toBe(NEEDS_RUN);
  });
});

describe('errand-tree — prepare an errand tree for phase N', () => {
  it('holds for a phase on record and not done, posts the phase, and toasts where the tree is', async () => {
    expect(offerOf(model(RUN, { phase: 2 }), 'errand-tree').enabled).toBe(true);
    post.mockResolvedValue({
      tree: { dir: '/repo/.worktrees/hand/demo/p2', at: AT, by: 'mobin', mounts: [] },
      adopted: false,
    });
    mount(RUN);
    await pressRow('errand-tree');
    expect(post).toHaveBeenCalledWith('/api/run/demo/errand-tree', { phase: 2 });
    expect(toast).toHaveBeenCalledWith('Errand tree ready at /repo/.worktrees/hand/demo/p2.', 'ok');
  });

  it('does not hold, and says which condition fails', () => {
    expect(offerOf(model(RUN, { phase: 7 }), 'errand-tree').why).toBe('Phase 7 has no record in this run.');
    expect(offerOf(model(RUN, { phase: 1 }), 'errand-tree').why).toBe('Phase 1 is done.');
    expect(offerOf(model(RUN, { phase: null }), 'errand-tree').why).toBe('Pick a phase first.');
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(RUN, { allowRun: false, phase: 2 }), 'errand-tree').why).toBe(NEEDS_RUN);
  });
});

describe('extend — give the waiting card 30 more minutes', () => {
  it('holds once a card of this run waits, and posts thirty minutes to that card', async () => {
    expect(offerOf(model(RUN, { approvals: [CARD] }), 'extend')).toMatchObject({
      enabled: true,
      target: { approvalId: 'a1' },
    });
    cards.list = [CARD];
    post.mockResolvedValue({ ok: true, standing: false, approval: CARD });
    mount(RUN);
    await waitFor(() => expect(row('extend')).toHaveAttribute('data-enabled', 'true'));
    expect(row('extend')).toHaveTextContent('Bash(git push origin pe/demo), phase 2');
    await pressRow('extend');
    expect(post).toHaveBeenCalledWith('/api/approvals/a1/extend', { minutes: 30 });
    expect(toast).toHaveBeenCalledWith('The card waits 30 more minutes.', 'ok');
  });

  it('offers one per waiting card of the run', () => {
    const second = { ...CARD, id: 'a2', phase: 3 } as Approval;
    const offers = model(RUN, { approvals: [CARD, second] }).filter((o) => o.id === 'extend');
    expect(offers.map((o) => o.target?.approvalId)).toEqual(['a1', 'a2']);
  });

  it('does not hold, and says which condition fails', () => {
    expect(offerOf(model(RUN), 'extend').why).toBe('No card of this run is waiting.');
    // Another run's card, a decided one — neither is this run's waiting card.
    expect(offerOf(model(RUN, { approvals: [{ ...CARD, runId: 'r0' } as Approval] }), 'extend').why).toBe(
      'No card of this run is waiting.',
    );
    expect(offerOf(model(RUN, { approvals: [{ ...CARD, status: 'allow' } as Approval] }), 'extend').why).toBe(
      'No card of this run is waiting.',
    );
    // A relayed question closes on its own clock: the broker refuses it.
    expect(
      offerOf(model(RUN, { approvals: [{ ...CARD, kind: 'question' } as Approval] }), 'extend').why,
    ).toBe('A relayed question closes on its own clock: Extend does not apply.');
  });

  it('with --allow-run off, names the flag', () => {
    expect(offerOf(model(RUN, { allowRun: false, approvals: [CARD] }), 'extend').why).toBe(NEEDS_RUN);
  });
});

describe('the tab around the six', () => {
  it('opens the picker on the halt’s phase, else the active one', () => {
    const { unmount } = mount(run({ halt: { at: AT, reason: 'stopped', phase: 3 }, activePhase: 2 }));
    expect(screen.getByLabelText('Phase')).toHaveValue('3');
    unmount();
    mount(run({ activePhase: 1 }));
    expect(screen.getByLabelText('Phase')).toHaveValue('1');
  });

  it('moves the phase verbs with the picker', () => {
    mount(RUN);
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: '1' } });
    expect(row('isolate-phase')).toHaveAttribute('data-enabled', 'false');
    expect(row('isolate-phase')).toHaveTextContent('Phase 1 is done.');
  });

  it('says a refusal in the server’s own words', async () => {
    const { ApiError } = await import('@/data/http');
    post.mockRejectedValue(
      new ApiError('demo is driving — its next boundary asks the checkout again by itself.', 409, '/x'),
    );
    mount(run({ status: 'parked', isolation: 'worktree' }));
    await pressRow('repair-checkout');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'demo is driving — its next boundary asks the checkout again by itself.',
        'error',
      ),
    );
  });

  it('keeps every other verb one press away, behind its own fold', () => {
    mount(RUN);
    const fold = screen.getByTestId('run-actions-other');
    expect(fold).toHaveTextContent('Every other verb');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    // The registry's own list, for this run's plan — the panel's shared tab.
    const region = document.getElementById(fold.getAttribute('aria-controls')!)!;
    expect(within(region).getByText('pause')).toBeInTheDocument();
    expect(within(region).getByText('hold')).toBeInTheDocument();
  });
});
