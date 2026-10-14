/**
 * The check and the decision (7.0, quiet-console phase 8, #266; exit criterion 2).
 *
 *   CK-1 a decision item's primary is its options — *Send my answer*, disabled
 *        until one is chosen, never a check;
 *   CK-2 a proof re-run reports what it read, in words, with the exit it saw —
 *        drawn on the card in the verdict's place, and the ledger's verdict of
 *        the same attempt is not drawn twice;
 *   CK-3 the words, pure: proven · being checked · not yet · one detail missing.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post, request } = vi.hoisted(() => ({ post: vi.fn(), request: vi.fn() }));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => request(path),
    post: (path: string, body?: unknown) => post(path, body),
  };
});

import { humanStepView } from '@shared/human-step-model.js';
import type { StepVerbAnswer, TurnItem } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { checkOutcomeOf, exitOf } from './check';
import { TurnItemCard } from './parts';

const AT = '2026-10-07T12:00:00.000Z';

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const DECISION: TurnItem = {
  item: 'd-1',
  record: 'ledger',
  source: 'declared',
  kind: 'decision',
  why: 'decision',
  proofType: 'answer',
  group: 'decide',
  rows: ['human-step:alpha:3:d-1'],
  title: 'Choose when the release ships',
  need: '',
  how: '',
  severity: 'needs-you',
  slug: 'alpha',
  phase: 3,
  since: AT,
  href: '/plan/alpha/phase/3',
  actions: [],
  humanStep: humanStepView({
    kind: 'decision',
    title: 'Choose when the release ships',
    state: 'notified',
    stepId: 'd-1',
  }),
  step: {
    id: 'd-1',
    kind: 'decision',
    title: 'Choose when the release ships',
    state: 'notified',
    why: 'decision',
    whySource: 'declared',
    // A decision that also names a cmd: proof — #266's case: the options are still the primary.
    proofType: 'answer',
    proof: 'cmd:"test -f /tmp/shipped"',
    attempts: 0,
    waiters: [],
    declaredAt: AT,
    birth: 'session',
    options: [
      { id: 'monday', label: 'Ship it on Monday', consequence: 'The notes get a review.', recommended: true },
      { id: 'today', label: 'Ship it today' },
    ],
  },
};

const PROBE: TurnItem = {
  ...DECISION,
  item: 'p-1',
  kind: 'browser-login',
  why: 'identity',
  proofType: 'probe',
  group: 'now',
  rows: ['human-step:alpha:3:p-1'],
  title: 'Sign the gh CLI in',
  humanStep: humanStepView({
    kind: 'browser-login',
    title: 'Sign the gh CLI in',
    state: 'opened',
    stepId: 'p-1',
    openUrl: 'https://github.com/login/device',
  }),
  step: {
    ...DECISION.step!,
    id: 'p-1',
    kind: 'browser-login',
    title: 'Sign the gh CLI in',
    state: 'opened',
    why: 'identity',
    proofType: 'probe',
    proof: 'cmd:"gh auth status"',
    options: undefined,
  },
};

const REJECTED: StepVerbAnswer = {
  ok: true,
  step: { ...(PROBE.step as object), state: 'returned' } as StepVerbAnswer['step'],
  check: {
    landed: false,
    read: 'missed — gh exited 1',
    ref: 'cmd:"gh auth status"',
    state: 'rejected',
    by: 'probe',
    attempt: 1,
  },
  verdict: {
    state: 'rejected',
    note: 'The proof did not hold — cmd:"gh auth status" read: missed — gh exited 1.',
    redo: ['Finish Sign the gh CLI in, then check again — the console reads cmd:"gh auth status".'],
    read: ['cmd:"gh auth status" — missed — gh exited 1'],
    at: AT,
    by: 'probe',
    attempt: 1,
  },
};

beforeEach(() => {
  post.mockReset();
  request.mockReset();
  request.mockResolvedValue({
    state: 'unenrolled',
    mode: 'unenrolled',
    keys: [],
    session: null,
    requests: [],
    relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  });
});

describe('CK-1 a decision item’s primary is its options', () => {
  it('draws the options and Send my decision, disabled until one is chosen — never a check', async () => {
    post.mockResolvedValue({ ok: true, answered: { option: 'monday', at: AT }, resumes: [] });
    wrap(<TurnItemCard item={DECISION} perform={vi.fn()} />);
    const card = screen.getByTestId('turn-item');
    const primary = within(card).getByTestId('turn-primary') as HTMLButtonElement;
    expect(primary.getAttribute('data-move')).toBe('decide');
    expect(primary.textContent).toBe('Send my decision');
    expect(primary.disabled).toBe(true);
    expect(within(card).queryByRole('button', { name: /check/i })).toBeNull();
    const options = within(card).getAllByRole('radio');
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['monday', 'today']);
    expect(within(card).getByTestId('decision-option-monday').textContent).toContain('Recommended');
    fireEvent.click(options[0]!);
    await waitFor(() => expect(primary.disabled).toBe(false));
    fireEvent.click(primary);
    // A decision ends the item: it waits out the undo window first (turn-by-turn phase 5).
    const held = within(card).getByTestId('turn-held');
    expect(held.textContent).toContain('Your decision');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(held).getByTestId('turn-held-send'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/human-steps/d-1/answer', { option: 'monday' }),
    );
  });
});

describe('CK-2 a proof re-run reports what it read, with the exit it saw', () => {
  it('says Not yet, the verdict’s words, the exit code and what to redo — once, in the verdict’s place', async () => {
    post.mockResolvedValue(REJECTED);
    wrap(<TurnItemCard item={PROBE} perform={vi.fn()} />);
    const card = screen.getByTestId('turn-item');
    const primary = within(card).getByTestId('turn-primary');
    expect(primary.textContent).toBe("I've done this — check");
    fireEvent.click(primary);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/human-steps/p-1/check', {}));
    const outcome = await within(card).findByTestId('turn-check-outcome');
    expect(outcome.getAttribute('data-tone')).toBe('back');
    expect(outcome.textContent).toContain('Not yet.');
    expect(outcome.textContent).toContain('Attempt 1.');
    expect(outcome.textContent).toContain('gh exited 1');
    expect(within(outcome).getByTestId('turn-check-redo').textContent).toContain('check again');
    expect(within(outcome).getByTestId('turn-check-read').textContent).toContain('cmd:"gh auth status"');
    // The ledger's own verdict of this attempt is the same words: not drawn twice.
    expect(within(card).queryByTestId('turn-verdict')).toBeNull();
  });

  it('says Proven when the proof landed', async () => {
    post.mockResolvedValue({
      ok: true,
      check: {
        landed: true,
        read: 'landed — exit 0',
        ref: 'cmd:"gh auth status"',
        state: 'passed',
        attempt: 1,
      },
      verdict: {
        state: 'passed',
        note: 'The proof holds: cmd:"gh auth status".',
        redo: [],
        read: [],
        at: AT,
        by: 'probe',
        attempt: 1,
      },
    });
    wrap(<TurnItemCard item={PROBE} perform={vi.fn()} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    const outcome = await screen.findByTestId('turn-check-outcome');
    expect(outcome.getAttribute('data-tone')).toBe('passed');
    expect(outcome.textContent).toContain('Proven.');
    expect(outcome.textContent).toContain('The proof holds');
  });
});

describe('CK-3 the words, pure', () => {
  it('reads the exit a probe saw', () => {
    expect(exitOf(['cmd:"gh auth status" — missed — gh exited 1'])).toBe(1);
    expect(exitOf(['the command exited 0'])).toBe(0);
    expect(exitOf(['exit code 127 from the shell'])).toBe(127);
    expect(exitOf(['landed'])).toBeNull();
  });

  it('is null for an answer that was no check', () => {
    expect(checkOutcomeOf({ ok: true })).toBeNull();
  });

  it('proven · being checked · not yet · one detail missing', () => {
    expect(checkOutcomeOf({ ok: true, check: { landed: true, read: 'landed' } })).toMatchObject({
      tone: 'passed',
      lead: 'Proven.',
    });
    expect(
      checkOutcomeOf({ ok: true, check: { state: 'checking', by: 'checker', attempt: 2 } }),
    ).toMatchObject({
      tone: 'checking',
      lead: 'Being checked.',
      attempt: 2,
    });
    const back = checkOutcomeOf(REJECTED)!;
    expect(back).toMatchObject({ tone: 'back', lead: 'Not yet.', attempt: 1 });
    expect(back.words).toContain('gh exited 1');
    expect(back.redo).toHaveLength(1);
    // A verdict whose note names no exit gets the exit the read saw, said.
    const quiet = checkOutcomeOf({
      ...REJECTED,
      verdict: { ...REJECTED.verdict!, note: 'The proof did not hold.', read: ['the command exited 2'] },
    })!;
    expect(quiet.words).toBe('The proof did not hold. The proof exited 2.');
    expect(
      checkOutcomeOf({
        ok: true,
        verdict: {
          state: 'needs-info',
          note: 'A decision is proven by its answer, and this one has none yet.',
          redo: ['Answer it.'],
          read: ['the item'],
          at: AT,
          by: 'probe',
          attempt: 1,
        },
      }),
    ).toMatchObject({ tone: 'back', lead: 'One detail is missing.' });
  });
});
