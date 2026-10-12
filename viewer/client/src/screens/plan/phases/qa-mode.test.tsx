/**
 * The QA switch (7.0, quiet-console phase 10; ported from
 * `components/qa-mode-control.test.tsx`) — what it says, what it posts, and
 * how it degrades.
 *
 * The word is the engine's regime through the status model (a dot and a word:
 * "QA on", "QA off", "QA released"), the reason beside it is the engine's own,
 * and the switch posts a directive from `QA_DIRECTIVES` — never the word read
 * back. Without `--allow-writes` the switch is disabled and the hand command is
 * printed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QA_DIRECTIVES } from '@shared/plan-vocab.js';
import { queryClientConfig } from '@/data/keys';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { QaModeControl } from './qa-mode';

const { qaModeSet } = vi.hoisted(() => ({ qaModeSet: vi.fn() }));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, qaModeSet } };
});

function mount(node: ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {node}
      <Toaster />
    </QueryClientProvider>,
  );
}

/** The drawn word: its status attribute and its label. */
const wordOf = (scope: HTMLElement) => {
  const word = scope.querySelector('[data-vocab="qa-mode"]');
  return { status: word?.getAttribute('data-status'), label: word?.textContent };
};

beforeEach(() => {
  qaModeSet.mockReset();
});

afterEach(() => {
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

describe('the plan-level switch', () => {
  it("reads the engine's word with its reason, marks the current choice, and posts the other", async () => {
    qaModeSet.mockResolvedValue({
      ok: true,
      plan: { mode: 'waived' },
      detail: 'QA now reads waived for alpha.',
    });
    mount(<QaModeControl slug="alpha" mode="on" reason="plan directive: QA gate: on" allowWrites />);
    const control = screen.getByTestId('qa-mode-plan');
    expect(wordOf(control)).toEqual({ status: 'on', label: 'QA on' });
    // The engine's reason, verbatim, beside the word.
    expect(within(control).getByText('plan directive: QA gate: on')).toBeInTheDocument();
    const on = screen.getByRole('button', { name: 'On' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    // The current choice is a mark, not a press: pressing it writes nothing.
    fireEvent.click(on);
    expect(qaModeSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'off' }));
    // The server's own sentence: it read the regime back from the engine.
    expect(await screen.findByText('QA now reads waived for alpha.')).toBeInTheDocument();
  });

  it('shows a gate written off as the engine reads it — released — with Off current', () => {
    mount(<QaModeControl slug="alpha" mode="waived" reason="plan directive: QA gate: off" allowWrites />);
    expect(wordOf(screen.getByTestId('qa-mode-plan'))).toEqual({ status: 'waived', label: 'QA released' });
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'On' })).not.toBeDisabled();
  });

  it('offers the plan exactly on and off — a plan has nothing to inherit from', () => {
    mount(<QaModeControl slug="alpha" mode="off" allowWrites />);
    const group = screen.getByRole('group', { name: 'QA gate' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['On', 'Off']);
    expect(wordOf(screen.getByTestId('qa-mode-plan'))).toEqual({ status: 'off', label: 'QA off' });
  });

  it('degrades to the hand command without --allow-writes, never to nothing', () => {
    mount(<QaModeControl slug="alpha" mode="on" allowWrites={false} scriptsDir="/opt/pe/scripts" />);
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('title')).toMatch(/--allow-writes/);
    expect(screen.getByText(/By hand:/).textContent).toContain(
      'bash /opt/pe/scripts/qa-mode.sh alpha <on|off>',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(qaModeSet).not.toHaveBeenCalled();
  });

  it('says a refusal in the server’s words, and a press the owner must confirm as asked', async () => {
    qaModeSet.mockResolvedValueOnce({
      ok: false,
      detail: 'qa-mode.sh: the plan has no Session budget section.',
    });
    mount(<QaModeControl slug="alpha" mode="on" allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(
      await screen.findByText('qa-mode.sh: the plan has no Session budget section.'),
    ).toBeInTheDocument();

    qaModeSet.mockResolvedValueOnce({
      requested: true,
      error: 'Asked of the owner: confirm it on Your turn.',
      request: { ask: 'Asked of the owner: confirm it on Your turn.' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Off' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(await screen.findByText('Asked of the owner: confirm it on Your turn.')).toBeInTheDocument();
    // Asked is not done: the word still reads the regime the engine reported.
    expect(wordOf(screen.getByTestId('qa-mode-plan')).status).toBe('on');
  });

  it('takes no second press while one is in flight', async () => {
    let settle: (value: unknown) => void = () => {};
    qaModeSet.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mount(<QaModeControl slug="alpha" mode="on" allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(qaModeSet).toHaveBeenCalledTimes(1);
    await act(async () => settle({ ok: true, detail: 'ok' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Off' })).not.toBeDisabled());
  });
});

describe('the per-phase switch', () => {
  it('says the phase follows the plan, with Inherit current, and posts the phase with a directive', async () => {
    qaModeSet.mockResolvedValue({
      ok: true,
      plan: { mode: 'on' },
      phase: { phase: 3, regime: { mode: 'off' } },
      detail: 'ok',
    });
    mount(
      <QaModeControl
        slug="alpha"
        mode="on"
        phase={3}
        phaseMode={{ mode: 'on', source: 'plan' }}
        allowWrites
      />,
    );
    const control = screen.getByTestId('qa-mode-phase-3');
    expect(wordOf(control)).toEqual({ status: 'on', label: 'QA on' });
    expect(control).toHaveTextContent('from the plan');
    expect(screen.getByRole('button', { name: 'Inherit' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'off', phase: 3 }));
  });

  it("names the phase's own directive, and Inherit removes it", async () => {
    qaModeSet.mockResolvedValue({ ok: true, detail: 'ok' });
    mount(
      <QaModeControl
        slug="alpha"
        mode="on"
        phase={2}
        phaseMode={{ mode: 'off', source: 'phase' }}
        allowWrites
      />,
    );
    const control = screen.getByTestId('qa-mode-phase-2');
    expect(wordOf(control)).toEqual({ status: 'off', label: 'QA off' });
    expect(control).toHaveTextContent('set by this phase');
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Inherit' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'inherit', phase: 2 }));
    // A console that may write prints no hand command.
    expect(screen.queryByText(/By hand/)).toBeNull();
  });

  it('offers every directive the writer takes, in the owner’s order', () => {
    mount(<QaModeControl slug="alpha" mode="on" phase={4} allowWrites />);
    const group = screen.getByRole('group', { name: 'QA for phase 4' });
    const captions = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent?.toLowerCase());
    expect(captions).toEqual([...QA_DIRECTIVES]);
  });

  it('falls back to the plan’s word when the server sends no phase regime', () => {
    mount(<QaModeControl slug="alpha" mode="waived" phase={4} allowWrites />);
    const control = screen.getByTestId('qa-mode-phase-4');
    expect(wordOf(control)).toEqual({ status: 'waived', label: 'QA released' });
    expect(control).toHaveTextContent('from the plan');
    expect(screen.getByRole('button', { name: 'Inherit' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('prints the phase’s hand command — its number and every directive — without --allow-writes', () => {
    mount(
      <QaModeControl
        slug="alpha"
        mode="on"
        phase={5}
        phaseMode={{ mode: 'on', source: 'plan' }}
        allowWrites={false}
      />,
    );
    expect(screen.getByText(/By hand:/).textContent).toContain(
      'bash scripts/qa-mode.sh alpha --phase 5 <on|off|inherit>',
    );
    for (const button of within(screen.getByRole('group')).getAllByRole('button'))
      expect(button).toBeDisabled();
  });
});
