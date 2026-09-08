/**
 * The control that asks for a review — and the three states it is allowed to be in.
 *
 * The console could always record a QA result by hand; the thing it could not
 * do was get one. So the button is the whole feature from where an operator
 * stands, and the two properties that keep it honest are the ones P3 and P4
 * established for every other remedy on this console:
 *
 *  - **A capability that exists and cannot be used says which flag turns it on.**
 *    A greyed button with no explanation is a dead end in a different colour.
 *  - **"Already running" is somewhere to go, not a missing capability.** A live
 *    review is a link to it, never a disabled button — the operator pressing it
 *    a second time wants the session, not a refusal.
 *
 * And one this phase adds: **the console never shows a verdict nobody recorded.**
 * `pending` is a review that was asked for and never answered, so it is not a
 * chip beside `pass` and `fail`.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QaButton, QaEnableButton, QaRounds, QaVerdict } from './qa-launcher';
import { LaunchDialog } from '@/features/run-setup/launch-dialog';
import { canQa, isVerdict, liveQa, qaKey } from '@/lib/qa';

const { qaActivate } = vi.hoisted(() => ({ qaActivate: vi.fn() }));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, qaActivate } };
});

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The picker's own list needs a server; nothing here is about the picker.
  useSkills: () => ({ data: [] }),
}));

const target = { slug: 'alpha', phase: 2, title: 'cart api endpoint' };

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('the review button', () => {
  it('offers a review when the console may mint agent sessions', () => {
    render(<QaButton target={target} allowAgent />);
    const button = screen.getByRole('button', { name: /QA this phase/i });
    expect(button).not.toBeDisabled();
  });

  it('names the missing flag rather than vanishing', () => {
    render(<QaButton target={target} allowAgent={false} />);
    const button = screen.getByRole('button', { name: /QA this phase/i });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/--allow-agent/);
  });

  it('becomes a link to the review already running, never a dead button', () => {
    render(<QaButton target={target} allowAgent runningSessionId="sess-9" />);
    const link = screen.getByRole('link', { name: /QA running/i });
    expect(link.getAttribute('href')).toBe('#/sessions/sess-9');
    // Not a disabled control: what the operator wants next is that session.
    expect(screen.queryByRole('button', { name: /QA this phase/i })).toBeNull();
  });

  it('is still a link when agent sessions are disabled — the flag gates STARTING one', () => {
    render(<QaButton target={target} allowAgent={false} runningSessionId="sess-9" />);
    expect(screen.getByRole('link', { name: /QA running/i })).toBeTruthy();
  });
});

describe('turning QA on for the plan', () => {
  const off = { ...target, qaMode: 'off' };

  it('is offered, ticked, when the plan has QA off and the console may write', () => {
    mount(<LaunchDialog request={{ kind: 'qa', target: off, allowWrites: true }} onClose={() => {}} />);
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeDisabled();
    expect(box).toBeChecked();
  });

  it('names the missing flag rather than failing on submit', () => {
    mount(<LaunchDialog request={{ kind: 'qa', target: off, allowWrites: false }} onClose={() => {}} />);
    const box = screen.getByRole('checkbox');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box.getAttribute('title')).toMatch(/--allow-writes/);
    // …and it still says the review is worth running, which is the true part.
    expect(screen.getByText(/its verdict just gates nothing until then/i)).toBeTruthy();
  });

  it('is not asked about at all when the plan already runs QA', () => {
    mount(
      <LaunchDialog
        request={{ kind: 'qa', target: { ...target, qaMode: 'on' }, allowWrites: true }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('warns that a recorded verdict is being re-judged, not overwritten', () => {
    mount(
      <LaunchDialog
        request={{
          kind: 'qa',
          target: {
            ...target,
            qaMode: 'on',
            qa: { result: 'fail', report: 'reports/phase-02-qa.md' },
          },
          allowWrites: true,
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/read that report first/i)).toBeTruthy();
  });
});

describe('the option a plan with QA off did not have', () => {
  /*
   * `api.qaActivate` shipped with no UI at all: the only way to turn the gate
   * on was to start a REVIEW with the dialog's activation box ticked, which
   * couples a claim about the plan ("hold dependents behind a verdict from
   * here on") to spending a session on one phase. This is that claim on its
   * own — write-class, so it is gated on `--allow-writes` rather than on the
   * agent flag the button beside it uses.
   */
  const off = { ...target, qaMode: 'off' };

  it('appears beside the review button only while the plan has QA off', () => {
    mount(<QaButton target={off} allowAgent allowWrites />);
    expect(screen.getByRole('button', { name: /Enable QA/i })).toBeTruthy();
  });

  it('is absent for a plan already under QA — there is nothing to turn on', () => {
    mount(<QaButton target={{ ...target, qaMode: 'on' }} allowAgent allowWrites />);
    expect(screen.queryByRole('button', { name: /Enable QA/i })).toBeNull();
  });

  it('names the missing flag rather than vanishing', () => {
    mount(<QaEnableButton slug="alpha" phase={2} allowWrites={false} />);
    const button = screen.getByRole('button', { name: /Enable QA/i });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('asks first, then turns the gate on for the plan', async () => {
    qaActivate.mockResolvedValue({ ok: true, mode: 'on', detail: 'QA is on for alpha.' });
    mount(<QaEnableButton slug="alpha" phase={2} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: /Enable QA/i }));
    // The confirm says what it writes and what it does NOT re-open.
    expect(await screen.findByText(/Turn QA on for alpha\?/)).toBeTruthy();
    expect(screen.getByText(/marks the phases that are already complete as/)).toBeTruthy();
    expect(qaActivate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Turn QA on' }));
    await waitFor(() => expect(qaActivate).toHaveBeenCalledWith('alpha', 2));
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
    // An ended session must let the chip turn back into a button.
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
    expect(items[0].textContent).toContain('round 1');
    expect(items[0].textContent).toContain('fail');
    expect(items[0].textContent).toContain('reports/phase-02-qa.md');
    expect(items[1].textContent).toContain('reports/phase-02-qa-round2.md');

    // The spend, per round. Issue #7's whole complaint about the run surfaces
    // was that a QA pass appeared as a cost line and nothing else; here the
    // cost belongs to a verdict and a report you can open.
    expect(items[0].textContent).toContain('$2.50');
    expect(items[0].textContent).toContain('11 turns');
    expect(items[1].textContent).toContain('$1.25');
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
    // The record carried `sessionId` all along and nothing drew it — so a
    // round's log was one click away from nowhere.
    render(
      <QaRounds
        rounds={[{ round: 1, verdict: 'fail', reportPath: 'reports/phase-02-qa.md', sessionId: 'sess-abc' }]}
        sessionHref={(id) => `#/sessions/${id}`}
      />,
    );
    const link = screen.getByRole('link', { name: /session/i });
    expect(link).toHaveAttribute('href', '#/sessions/sess-abc');
  });

  it('shows a pending round, unlike the verdict chip', () => {
    // In a HISTORY a round that was asked for and never answered is a fact
    // about what happened. Beside `pass` and `fail` on a row it would read as a
    // third verdict, which is why `QaVerdict` drops it and this does not.
    render(<QaRounds rounds={[{ round: 1, verdict: 'pending' }]} />);
    expect(screen.getByRole('listitem').textContent).toContain('pending');
  });

  it('renders nothing for a phase with no rounds — most of them, and all of them on a QA-off plan', () => {
    expect(render(<QaRounds rounds={[]} />).container.textContent).toBe('');
    expect(render(<QaRounds />).container.textContent).toBe('');
  });
});
