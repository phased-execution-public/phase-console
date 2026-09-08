/**
 * The three verbs behind a verdict that is HOLDING a phase (issue #11).
 *
 * The console could always record a QA result and always start a review; what
 * it could not do was answer a verdict that had already failed. The ladder's
 * `qa-fix` rung climbed until its attempt and dollar caps were spent and then
 * parked with an errand naming no action, and a hand-driven plan had no rung at
 * all — so the phase page and the inbox both showed the word "QA failed" and
 * nothing to press.
 *
 * Three properties, and the third is the one this component adds:
 *
 *  - **Offered exactly when the gate HOLDS** — on `fail` and on `pending`,
 *    because a pending row holds dependents exactly as hard as a failure, and
 *    NEVER on a verdict that releases or a plan whose gate is off. These are
 *    not a capability that exists and is unavailable (which `QaButton`'s
 *    three-state contract says must announce itself); they are three answers to
 *    a question nobody has asked.
 *  - **Fix & re-QA only on a `fail`** — a pending verdict names no findings for
 *    a fix session to read.
 *  - **Without `--allow-run` the card prints the hand command and posts
 *    nothing.** A console that may not run can still do all of this in a
 *    terminal, and the exact line is the difference between "you cannot" and
 *    "here".
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QaRecoveryActions } from './qa-launcher';

const { qaRerun, qaWaive } = vi.hoisted(() => ({ qaRerun: vi.fn(), qaWaive: vi.fn() }));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, qaRerun, qaWaive } };
});

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useSkills: () => ({ data: [] }),
}));

const target = { slug: 'alpha', phase: 2, title: 'cart api endpoint' };

function mount(props: Partial<Parameters<typeof QaRecoveryActions>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QaRecoveryActions
        slug="alpha"
        phase={2}
        target={target}
        qaMode="on"
        qa={{ result: 'fail', report: 'reports/phase-02-qa.md' }}
        allowRun
        allowWrites
        {...props}
      />
    </QueryClientProvider>,
  );
}

const verbs = () => ({
  fix: screen.queryByRole('button', { name: /Fix & re-QA/ }),
  rerun: screen.queryByRole('button', { name: /Re-run QA/ }),
  waive: screen.queryByRole('button', { name: /Waive with a reason/ }),
});

beforeEach(() => {
  vi.clearAllMocks();
  qaRerun.mockResolvedValue({ run: { id: 'r1' } });
  qaWaive.mockResolvedValue({ ok: true, verdict: 'waived', detail: 'Phase 2 is waived.' });
});

describe('EC1 — the three verbs appear exactly when the gate holds', () => {
  it('renders all three on a recorded fail', () => {
    mount();
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeTruthy();
    expect(rerun).toBeTruthy();
    expect(waive).toBeTruthy();
    // And says WHY they are there — the hold is the whole reason.
    expect(screen.getByText(/holding every phase that depends on it/)).toBeTruthy();
  });

  it('renders none of the three with no recorded verdict', () => {
    mount({ qa: undefined });
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeNull();
    expect(rerun).toBeNull();
    expect(waive).toBeNull();
    expect(screen.queryByTestId('qa-recovery')).toBeNull();
  });

  it('renders none of the three on a verdict that releases the gate', () => {
    for (const result of ['pass', 'waived']) {
      const { unmount } = mount({ qa: { result } });
      expect(screen.queryByTestId('qa-recovery'), result).toBeNull();
      unmount();
    }
  });

  it('renders none of the three when the plan does not gate on QA', () => {
    // `off` is no gate at all and `waived` is `**QA gate:** off` in writing —
    // the verdicts stay recorded and stop holding anyone, so there is nothing
    // for these three to release.
    for (const mode of ['off', 'waived', undefined]) {
      const { unmount } = mount({ qaMode: mode, qa: { result: 'fail' } });
      expect(screen.queryByTestId('qa-recovery'), String(mode)).toBeNull();
      unmount();
    }
  });

  it('offers Re-run and Waive on a PENDING row, but not Fix & re-QA', () => {
    // A pending row holds dependents exactly as a failure does — but it names
    // no findings, so there is nothing for a fix session to read.
    mount({ qa: { result: 'pending' } });
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeNull();
    expect(rerun).toBeTruthy();
    expect(waive).toBeTruthy();
    expect(screen.getByText(/holds dependents exactly as a failure does/)).toBeTruthy();
  });
});

describe('what each verb actually does', () => {
  it('Re-run QA posts the rerun verb and nothing else', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Re-run QA/ }));
    await waitFor(() => expect(qaRerun).toHaveBeenCalledWith('alpha', 2));
    expect(qaWaive).not.toHaveBeenCalled();
  });

  it('Waive needs a reason before it will post one', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Waive with a reason/ }));
    const record = screen.getByRole('button', { name: /Record the waiver/ });
    // Disabled until there are words: a waiver with no reason is a plan
    // forgetting what it decided not to fix, and the server refuses one too.
    expect((record as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why this is waived/), {
      target: { value: 'the finding is phase 3’s schema' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record the waiver/ }));
    await waitFor(() => expect(qaWaive).toHaveBeenCalledWith('alpha', 2, 'the finding is phase 3’s schema'));
  });
});

describe('EC6 — without --allow-run the card explains instead of acting', () => {
  it('disables the two loop verbs, naming the flag, and posts nothing', () => {
    mount({ allowRun: false });
    const { fix, rerun } = verbs();
    // Disabled and SAYING SO rather than absent — `QaButton`'s contract.
    expect((fix as HTMLButtonElement).disabled).toBe(true);
    expect((rerun as HTMLButtonElement).disabled).toBe(true);
    expect(fix!.getAttribute('title')).toMatch(/--allow-run/);
    fireEvent.click(rerun!);
    expect(qaRerun).not.toHaveBeenCalled();
  });

  it('prints the hand command, naming the report the verdict actually wrote', () => {
    mount({ allowRun: false });
    const line = screen.getByText(/qa-record\.sh alpha 2/);
    expect(line.textContent).toMatch(/reports\/phase-02-qa\.md/);
    expect(line.textContent).toMatch(/--round/);
    expect(screen.getByText(/--qa-prompt 2/)).toBeTruthy();
  });

  it('falls back to the conventional report name when no verdict named one', () => {
    // A `pending` row has no report, and a dead path in a copyable command is
    // worse than a conventional one — round 1's plain name is what the brief
    // would hand out anyway.
    mount({ allowRun: false, qa: { result: 'pending' } });
    expect(screen.getByText(/reports\/phase-02-qa\.md/)).toBeTruthy();
  });

  it('still allows a waiver — writing a row is not running a session', () => {
    // The flag split is the point: `--allow-writes` writes `test-status.md`,
    // `--allow-run` spawns sessions. A console that may write but may not run
    // must still be able to release a gate.
    mount({ allowRun: false, allowWrites: true });
    expect((verbs().waive as HTMLButtonElement).disabled).toBe(false);
  });

  it('and disables the waiver — naming ITS flag — when writes are off', () => {
    mount({ allowRun: true, allowWrites: false });
    const { waive } = verbs();
    expect((waive as HTMLButtonElement).disabled).toBe(true);
    expect(waive!.getAttribute('title')).toMatch(/--allow-writes/);
  });
});
