/**
 * A phase's QA controls (7.0, quiet-console phase 10; ported from
 * `components/qa-launcher.test.tsx` and `components/qa-recovery.test.tsx`).
 *
 * The properties that keep them honest, each pinned below:
 *
 *  - **A capability that exists and cannot be used says which flag turns it
 *    on** — a greyed button with no reason is a dead end in another colour.
 *  - **"Already running" is somewhere to go**: a live review is a link to it.
 *  - **The review is the launch form in QA mode**, reached through its lazy
 *    door; the activation box is the form's own.
 *  - **The console never shows a verdict nobody recorded**: `pending` is not a
 *    verdict beside `pass` and `fail` — but in a history it is a fact.
 *  - **The three QA-recovery verbs appear exactly when the gate holds**
 *    (issue #11), Fix & re-QA only on a `fail`, and without `--allow-run` the
 *    card prints the hand command and posts nothing.
 *  - **Every press goes through the owner door**: a refusal is the server's
 *    words, a press the owner must confirm is said as asked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_VOCAB } from '@shared/recovery-model.js';
import { queryClientConfig } from '@/data/keys';
import { canQa, isVerdict, liveQa, qaKey } from '@/lib/qa';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { TooltipProvider } from '@/ui/tooltip';
import { QaButton, QaEnableButton, QaRecoveryActions, QaRounds, QaVerdict } from './qa-launcher';

vi.setConfig({ testTimeout: 30_000 });

const { qaActivate, qaRerun, qaWaive } = vi.hoisted(() => ({
  qaActivate: vi.fn(),
  qaRerun: vi.fn(),
  qaWaive: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, qaActivate, qaRerun, qaWaive } };
});

// The launch form's skill picker needs a server; nothing here is about the picker.
vi.mock('@/data/machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/machine')>()),
  useSkills: () => ({ data: [] }),
}));

/** The launch form is a lazy chunk: its first load in a cold suite takes a while. */
const FORM = { timeout: 20_000 };

const target = { slug: 'alpha', phase: 2, title: 'cart api endpoint' };

/** A press the owner must confirm: the 202 `{requested}` the owner door answers. */
const ASKED = {
  requested: true,
  error: 'Asked of the owner: confirm it on Your turn.',
  request: { ask: 'Asked of the owner: confirm it on Your turn.' },
};

function mount(node: ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {node}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  qaRerun.mockResolvedValue({ run: { id: 'r1' } });
  qaWaive.mockResolvedValue({ ok: true, verdict: 'waived', detail: 'Phase 2 is waived.' });
});

afterEach(() => {
  // The tray's store is the module's own and outlives a render.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

describe('the review button', () => {
  it('offers a review when the console may mint agent sessions', () => {
    mount(<QaButton target={target} allowAgent />);
    expect(screen.getByRole('button', { name: /QA this phase/ })).not.toBeDisabled();
  });

  it('names the missing flag rather than vanishing', () => {
    mount(<QaButton target={target} allowAgent={false} />);
    const button = screen.getByRole('button', { name: /QA this phase/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/--allow-agent/);
  });

  it('becomes a link to the review already running, never a dead button', () => {
    mount(<QaButton target={target} allowAgent runningSessionId="sess-9" />);
    const link = screen.getByRole('link', { name: /QA running/ });
    expect(link.getAttribute('href')).toBe('#/sessions/sess-9');
    // Not a disabled control: what the operator wants next is that session.
    expect(screen.queryByRole('button', { name: /QA this phase/ })).toBeNull();
  });

  it('is still a link when agent sessions are disabled — the flag gates STARTING one', () => {
    mount(<QaButton target={target} allowAgent={false} runningSessionId="sess-9" />);
    expect(screen.getByRole('link', { name: /QA running/ })).toBeTruthy();
  });

  it('takes the label its row gives it', () => {
    mount(<QaButton label="Run QA" target={target} allowAgent />);
    expect(screen.getByRole('button', { name: /Run QA/ })).toBeInTheDocument();
  });
});

describe('the review is the launch form in QA mode, through its door', () => {
  const off = { ...target, qaMode: 'off' };

  it('opens nothing until pressed, then the form as a review — the session records the verdict', async () => {
    mount(<QaButton target={{ ...target, qaMode: 'on' }} allowAgent allowWrites />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /QA this phase/ }));
    expect(
      await screen.findByText('The session records the verdict, not the console.', undefined, FORM),
    ).toBeInTheDocument();
  });

  it('offers turning QA on, ticked, when the plan has QA off and the console may write', async () => {
    mount(<QaButton target={off} allowAgent allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: /QA this phase/ }));
    const box = await screen.findByRole('checkbox', undefined, FORM);
    expect(box).not.toBeDisabled();
    expect(box).toBeChecked();
  });

  it('names the missing flag rather than failing on submit', async () => {
    mount(<QaButton target={off} allowAgent allowWrites={false} />);
    fireEvent.click(screen.getByRole('button', { name: /QA this phase/ }));
    const box = await screen.findByRole('checkbox', undefined, FORM);
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box.getAttribute('title')).toMatch(/--allow-writes/);
    // …and it still says the review is worth running, which is the true part.
    expect(screen.getByText(/its verdict just gates nothing until then/i)).toBeTruthy();
  });

  it('is not asked about at all when the plan already runs QA', async () => {
    mount(<QaButton target={{ ...target, qaMode: 'on' }} allowAgent allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: /QA this phase/ }));
    await screen.findByText('The session records the verdict, not the console.', undefined, FORM);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('warns that a recorded verdict is being re-judged, not overwritten', async () => {
    mount(
      <QaButton
        target={{ ...target, qaMode: 'on', qa: { result: 'fail', report: 'reports/phase-02-qa.md' } }}
        allowAgent
        allowWrites
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /QA this phase/ }));
    expect(await screen.findByText(/read that report first/i, undefined, FORM)).toBeTruthy();
  });
});

describe('turning QA on without a review — the option a plan with QA off did not have', () => {
  /*
   * The plainer claim about the plan ("hold dependents behind a verdict from
   * here on"), uncoupled from spending a session on one phase — write-class,
   * so gated on `--allow-writes` rather than on the agent flag beside it.
   */
  const off = { ...target, qaMode: 'off' };

  it('appears beside the review button only while the plan has QA off', () => {
    mount(<QaButton target={off} allowAgent allowWrites />);
    expect(screen.getByRole('button', { name: /Turn QA on/ })).toBeTruthy();
  });

  it('is absent for a plan already under QA — there is nothing to turn on', () => {
    mount(<QaButton target={{ ...target, qaMode: 'on' }} allowAgent allowWrites />);
    expect(screen.queryByRole('button', { name: /Turn QA on/ })).toBeNull();
  });

  it('names the missing flag rather than vanishing', () => {
    mount(<QaEnableButton slug="alpha" phase={2} allowWrites={false} />);
    const button = screen.getByRole('button', { name: /Turn QA on/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('asks first, then turns the gate on for the plan and says so in the server’s words', async () => {
    qaActivate.mockResolvedValue({ ok: true, mode: 'on', detail: 'QA is on for alpha.' });
    mount(<QaEnableButton slug="alpha" phase={2} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: /Turn QA on/ }));
    // The question says what it writes and what it does NOT open again.
    const ask = await screen.findByRole('alertdialog', { name: 'Turn QA on for alpha?' });
    expect(within(ask).getByText(/marks the phases that are already complete as/)).toBeTruthy();
    expect(qaActivate).not.toHaveBeenCalled();

    // The confirm keeps the button's own words through the flow.
    fireEvent.click(within(ask).getByRole('button', { name: 'Turn QA on' }));
    await waitFor(() => expect(qaActivate).toHaveBeenCalledWith('alpha', 2));
    expect(await screen.findByText('QA is on for alpha.')).toBeInTheDocument();
  });

  it('says a refusal in the server’s words, and a press the owner must confirm as asked', async () => {
    qaActivate.mockResolvedValueOnce({ ok: false, mode: 'off', detail: 'The plan file is not writable.' });
    mount(<QaEnableButton slug="alpha" phase={2} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: /Turn QA on/ }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn QA on' }),
    );
    expect(await screen.findByText('The plan file is not writable.')).toBeInTheDocument();

    qaActivate.mockResolvedValueOnce(ASKED);
    // In flight the trigger says "Turning QA on" and is disabled; it is pressable again once settled.
    await waitFor(() => expect(screen.getByRole('button', { name: /Turn QA on/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Turn QA on/ }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn QA on' }),
    );
    expect(await screen.findByText('Asked of the owner: confirm it on Your turn.')).toBeInTheDocument();
    expect(qaActivate).toHaveBeenCalledTimes(2);
  });
});

describe('the recorded verdict', () => {
  it('renders a real verdict, and links it to its report when there is one', () => {
    const { container } = render(
      <QaVerdict qa={{ result: 'fail', report: 'reports/phase-02-qa.md' }} href="#/plan/alpha/handoff/2" />,
    );
    expect(screen.getByText(/QA fail/)).toBeTruthy();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/plan/alpha/handoff/2');
  });

  it('shows nothing for a review that was asked for and never answered', () => {
    const { container } = render(<QaVerdict qa={{ result: 'pending' }} />);
    expect(container.textContent).toBe('');
    expect(render(<QaVerdict />).container.textContent).toBe('');
  });

  it('is a dot and the status model’s word — never a chip', () => {
    const { container } = render(<QaVerdict qa={{ result: 'pass' }} />);
    const word = container.querySelector('[data-status]');
    expect(word).toHaveAttribute('data-status', 'pass');
    expect(word).toHaveAttribute('data-vocab', 'qa-result');
    expect(word?.querySelector('[data-dot]')).not.toBeNull();
    // No link without a report to go to.
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('the offer rules', () => {
  it('is not offered for a phase nobody has started — there is no diff to read', () => {
    expect(canQa('waiting')).toBe(false);
    expect(canQa('done')).toBe(true);
    expect(canQa('ready')).toBe(true);
  });

  it('matches a live review by (slug, phase) and by nothing else', () => {
    const sessions = [
      { id: 'a', meta: { qa: { slug: 'alpha', phase: 2 } } },
      { id: 'b', exited: { code: 0 }, meta: { qa: { slug: 'alpha', phase: 5 } } },
    ];
    expect(liveQa(sessions, { slug: 'alpha', phase: 2 })?.id).toBe('a');
    // An ended session must let the link turn back into a button.
    expect(liveQa(sessions, { slug: 'alpha', phase: 5 })).toBeUndefined();
    expect(liveQa(sessions, { slug: 'beta', phase: 2 })).toBeUndefined();
    expect(qaKey({ slug: 'alpha', phase: 2 })).not.toBe(qaKey({ slug: 'alpha', phase: 3 }));
  });

  it('counts only the three results that answer the question', () => {
    expect(['pass', 'fail', 'waived'].every(isVerdict)).toBe(true);
    expect(['pending', 'unknown', undefined].some(isVerdict)).toBe(false);
  });
});

describe('QaRounds — the history a run surface could never show', () => {
  const rounds = [
    { round: 1, verdict: 'fail', reportPath: 'reports/phase-02-qa.md', costUsd: 2.5, turns: 11 },
    { round: 2, verdict: 'pass', reportPath: 'reports/phase-02-qa-round2.md', costUsd: 1.25, turns: 6 },
  ];

  it('renders every round with its verdict, its own report and what it spent', () => {
    render(<QaRounds rounds={rounds} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);

    // Round 1 kept the plain report name; round 2 has its own — which is the
    // whole fix for reviews that used to overwrite each other's reports.
    expect(items[0]!.textContent).toContain('Round 1');
    expect(items[0]!.textContent).toContain('fail');
    expect(items[0]!.textContent).toContain('reports/phase-02-qa.md');
    expect(items[1]!.textContent).toContain('reports/phase-02-qa-round2.md');

    // The spend, per round: the cost belongs to a verdict and a report you
    // can open, never a cost line on its own (issue #7).
    expect(items[0]!.textContent).toContain('$2.50');
    expect(items[0]!.textContent).toContain('11 turns');
    expect(items[1]!.textContent).toContain('$1.25');
  });

  it('links the report when the caller knows where reports live, and never invents one', () => {
    const { unmount } = render(<QaRounds rounds={rounds} reportHref={(path) => `plans/alpha/${path}`} />);
    const link = screen.getByRole('link', { name: 'reports/phase-02-qa.md' });
    expect(link).toHaveAttribute('href', 'plans/alpha/reports/phase-02-qa.md');
    unmount();

    render(<QaRounds rounds={rounds} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('links the session that produced a round, when the caller knows where sessions live', () => {
    render(
      <QaRounds
        rounds={[{ round: 1, verdict: 'fail', reportPath: 'reports/phase-02-qa.md', sessionId: 'sess-abc' }]}
        sessionHref={(id) => `#/sessions/${id}`}
      />,
    );
    const link = screen.getByRole('link', { name: /session/i });
    expect(link).toHaveAttribute('href', '#/sessions/sess-abc');
  });

  it('shows a pending round, unlike the verdict', () => {
    // In a HISTORY a round asked for and never answered is a fact about what
    // happened; beside `pass` and `fail` on a row it would read as a verdict.
    render(<QaRounds rounds={[{ round: 1, verdict: 'pending' }]} />);
    expect(screen.getByRole('listitem').textContent).toContain('pending');
  });

  it('renders nothing for a phase with no rounds — most of them, and all of them on a QA-off plan', () => {
    expect(render(<QaRounds rounds={[]} />).container.textContent).toBe('');
    expect(render(<QaRounds />).container.textContent).toBe('');
  });

  it('draws each verdict as the status model’s word, and a round with none says so', () => {
    const { container } = render(
      <QaRounds
        rounds={[
          { round: 1, verdict: 'fail' },
          { round: 2, verdict: '' },
        ]}
      />,
    );
    const words = [...container.querySelectorAll('[data-vocab="qa-result"]')].map((el) =>
      el.getAttribute('data-status'),
    );
    expect(words).toEqual(['fail']);
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('No verdict');
  });
});

/* ------------------------------------------------------------------ *
 * The three verbs behind a verdict that HOLDS a phase (issue #11)
 * ------------------------------------------------------------------ */

function mountRecovery(props: Partial<Parameters<typeof QaRecoveryActions>[0]> = {}) {
  return mount(
    <QaRecoveryActions
      slug="alpha"
      phase={2}
      target={target}
      qaMode="on"
      qa={{ result: 'fail', report: 'reports/phase-02-qa.md' }}
      allowRun
      allowWrites
      {...props}
    />,
  );
}

const verbs = () => ({
  fix: screen.queryByRole('button', { name: /Fix & re-QA/ }),
  rerun: screen.queryByRole('button', { name: /Re-run QA/ }),
  waive: screen.queryByRole('button', { name: /Waive with a reason/ }),
});

describe('EC1 — the three verbs appear exactly when the gate holds', () => {
  it('renders all three on a recorded fail, and says why they are there', () => {
    mountRecovery();
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeTruthy();
    expect(rerun).toBeTruthy();
    expect(waive).toBeTruthy();
    expect(screen.getByText(/holding every phase that depends on it/)).toBeTruthy();
  });

  it('renders none of the three with no recorded verdict', () => {
    mountRecovery({ qa: undefined });
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeNull();
    expect(rerun).toBeNull();
    expect(waive).toBeNull();
    expect(screen.queryByTestId('qa-recovery')).toBeNull();
  });

  it('renders none of the three on a verdict that releases the gate', () => {
    for (const result of ['pass', 'waived']) {
      const { unmount } = mountRecovery({ qa: { result } });
      expect(screen.queryByTestId('qa-recovery'), result).toBeNull();
      unmount();
    }
  });

  it('renders none of the three when the plan does not gate on QA', () => {
    // `off` is no gate at all and `waived` is `**QA gate:** off` in writing —
    // the verdicts stay recorded and stop holding anyone.
    for (const mode of ['off', 'waived', undefined]) {
      const { unmount } = mountRecovery({ qaMode: mode, qa: { result: 'fail' } });
      expect(screen.queryByTestId('qa-recovery'), String(mode)).toBeNull();
      unmount();
    }
  });

  it('offers Re-run and Waive on a PENDING row, but not Fix & re-QA', () => {
    // A pending row holds dependents exactly as a failure does — but it names
    // no findings, so there is nothing for a fix session to read.
    mountRecovery({ qa: { result: 'pending' } });
    const { fix, rerun, waive } = verbs();
    expect(fix).toBeNull();
    expect(rerun).toBeTruthy();
    expect(waive).toBeTruthy();
    expect(screen.getByText(/holds dependents exactly as a failure does/)).toBeTruthy();
  });

  it('wears the recovery model’s words — each label and blurb read off its owner', () => {
    mountRecovery();
    const { fix, rerun, waive } = verbs();
    expect(fix).toHaveTextContent(ACTION_VOCAB['qa-recover'].label);
    expect(fix).toHaveAttribute('title', ACTION_VOCAB['qa-recover'].blurb);
    expect(rerun).toHaveTextContent(ACTION_VOCAB['qa-rerun'].label);
    expect(rerun).toHaveAttribute('title', ACTION_VOCAB['qa-rerun'].blurb);
    expect(waive).toHaveTextContent(ACTION_VOCAB['qa-waive'].label);
    expect(waive).toHaveAttribute('title', ACTION_VOCAB['qa-waive'].blurb);
  });
});

describe('what each verb actually does', () => {
  it('Re-run QA posts the rerun verb and nothing else, and says what it started', async () => {
    mountRecovery();
    fireEvent.click(screen.getByRole('button', { name: /Re-run QA/ }));
    await waitFor(() => expect(qaRerun).toHaveBeenCalledWith('alpha', 2));
    expect(qaWaive).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Re-running QA on phase 2. The round is recorded when it lands.'),
    ).toBeInTheDocument();
  });

  it('Waive needs a reason before it will post one', async () => {
    mountRecovery();
    fireEvent.click(screen.getByRole('button', { name: /Waive with a reason/ }));
    const record = screen.getByRole('button', { name: /Record the waiver/ });
    // Disabled until there are words: a waiver with no reason is a plan
    // forgetting what it decided not to fix, and the server refuses one too.
    expect(record).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Why this is waived/), {
      target: { value: 'the finding is phase 3’s schema' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record the waiver/ }));
    await waitFor(() => expect(qaWaive).toHaveBeenCalledWith('alpha', 2, 'the finding is phase 3’s schema'));
    // Recorded: the server's sentence, and the form folds away.
    expect(await screen.findByText('Phase 2 is waived.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText(/Why this is waived/)).toBeNull());
  });

  it('a waiver the owner must confirm is said as asked, and the reason stays on screen', async () => {
    qaWaive.mockResolvedValueOnce(ASKED);
    mountRecovery();
    fireEvent.click(screen.getByRole('button', { name: /Waive with a reason/ }));
    fireEvent.change(screen.getByLabelText(/Why this is waived/), { target: { value: 'flaky runner' } });
    fireEvent.click(screen.getByRole('button', { name: /Record the waiver/ }));
    expect(await screen.findByText('Asked of the owner: confirm it on Your turn.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Why this is waived/)).toHaveValue('flaky runner');
  });

  it('Fix & re-QA opens the fix loop’s launch form, not a review', async () => {
    mountRecovery();
    fireEvent.click(screen.getByRole('button', { name: /Fix & re-QA/ }));
    expect(
      await screen.findByText(
        'Each round is one session: it fixes what the report named and dispatches the reviewer itself.',
        undefined,
        FORM,
      ),
    ).toBeInTheDocument();
    expect(qaRerun).not.toHaveBeenCalled();
  });
});

describe('EC6 — without --allow-run the card explains instead of acting', () => {
  it('disables the two loop verbs, naming the flag, and posts nothing', () => {
    mountRecovery({ allowRun: false });
    const { fix, rerun } = verbs();
    // Disabled and SAYING SO rather than absent.
    expect(fix).toBeDisabled();
    expect(rerun).toBeDisabled();
    expect(fix!.getAttribute('title')).toMatch(/--allow-run/);
    expect(rerun!.getAttribute('title')).toMatch(/--allow-run/);
    fireEvent.click(rerun!);
    expect(qaRerun).not.toHaveBeenCalled();
  });

  it('prints the hand command, naming the report the verdict actually wrote', () => {
    mountRecovery({ allowRun: false, scriptsDir: '/opt/pe/scripts' });
    const line = screen.getByText(/qa-record\.sh alpha 2/);
    expect(line.textContent).toMatch(/^bash \/opt\/pe\/scripts\/qa-record\.sh/);
    expect(line.textContent).toMatch(/reports\/phase-02-qa\.md/);
    expect(line.textContent).toMatch(/--round/);
    expect(screen.getByText(/--qa-prompt 2/)).toBeTruthy();
  });

  it('falls back to the conventional report name when no verdict named one', () => {
    // A `pending` row has no report, and a dead path in a copyable command is
    // worse than the conventional one — round 1's plain name.
    mountRecovery({ allowRun: false, qa: { result: 'pending' } });
    expect(screen.getByText(/reports\/phase-02-qa\.md/)).toBeTruthy();
  });

  it('still allows a waiver — writing a row is not running a session', () => {
    mountRecovery({ allowRun: false, allowWrites: true });
    expect(verbs().waive).not.toBeDisabled();
  });

  it('and disables the waiver — naming ITS flag — when writes are off', () => {
    mountRecovery({ allowRun: true, allowWrites: false });
    const { waive } = verbs();
    expect(waive).toBeDisabled();
    expect(waive!.getAttribute('title')).toMatch(/--allow-writes/);
    // A console that may run prints no hand command.
    expect(screen.queryByText(/qa-record\.sh/)).toBeNull();
  });
});
