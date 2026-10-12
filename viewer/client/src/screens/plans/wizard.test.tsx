/**
 * New plan with AI — the golden (7.0, quiet-console phase 9, exit criterion 3).
 *
 * The wizard moved here from `features/sessions/wizard.tsx`, and its cases
 * moved with it from `features/sessions/sessions.test.tsx` unchanged in what
 * they pin: the ticket the 6.2 wizard posted is the ticket this one posts —
 * `intent: 'plan'`, the brief, the launch form's model and effort, the size
 * the pane will open at, and NO permission mode — and it lands on the session.
 *
 * `@/data/api` is what is mocked: the wizard and the launch form it borrows
 * both import the data door, so one mock reaches them alike. Only the calls the
 * wizard's answer depends on are stubbed; the launch form's other reads fail
 * the way they fail against no server, which it already survives.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, TerminalState } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';

vi.setConfig({ testTimeout: 20_000 });

const { state, terminal, agentTicket, skills } = vi.hoisted(() => ({
  state: vi.fn(),
  terminal: vi.fn(),
  agentTicket: vi.fn(),
  skills: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      terminal,
      agentTicket,
      skills,
      approvals: vi.fn(async () => []),
    },
  };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  allowTerminal: false,
  allowAgent: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  recentRoots: [],
  unread: 0,
};

const CLAUDE = {
  id: 'c1',
  label: 'Claude: hello',
  kind: 'claude' as const,
  cwd: '/repo',
  shell: 'claude',
  cols: 100,
  rows: 30,
  pid: 901,
  clients: 1,
  createdAt: 0,
  meta: { model: 'opus' },
};

const TERMINALS: TerminalState = {
  allowed: false,
  agentAllowed: true,
  available: 'yes',
  limit: 8,
  sessions: [],
};

let landed: string[] = [];

beforeEach(() => {
  landed = [];
  localStorage.clear();
  state.mockReset().mockResolvedValue(BASE_STATE);
  terminal.mockReset().mockResolvedValue(TERMINALS);
  skills.mockReset().mockResolvedValue([]);
  agentTicket.mockReset().mockResolvedValue({
    ok: true,
    sessionId: 'a1',
    token: 't',
    expiresAt: 0,
    path: '/ws/terminal',
    session: { ...CLAUDE, id: 'a1', label: 'Claude 1' },
  });
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plans" onNavigate={(path) => landed.push(path)}>
        {node}
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** A mint carries the size the pane will settle on, inside the server's clamps. */
function expectSized(body: { cols?: unknown; rows?: unknown } | undefined) {
  expect(body).toBeDefined();
  expect(body!.cols).toEqual(expect.any(Number));
  expect(body!.rows).toEqual(expect.any(Number));
  expect(body!.cols as number).toBeGreaterThanOrEqual(20);
  expect(body!.cols as number).toBeLessThanOrEqual(500);
  expect(body!.rows as number).toBeGreaterThanOrEqual(5);
  expect(body!.rows as number).toBeLessThanOrEqual(200);
}

/** The launch form is a lazy chunk inside the dialog; its Start button is the sign it arrived. */
const startButton = () => screen.findByRole('button', { name: /start authoring/i }, { timeout: 15_000 });

describe('the plan wizard (criterion 3)', () => {
  it('gates on the agent capability, not on writes', async () => {
    const { NewPlanWizardButton } = await import('./wizard');
    const { container } = mount(<NewPlanWizardButton allowAgent={false} />);
    expect(container).toBeEmptyDOMElement();

    mount(<NewPlanWizardButton allowAgent />);
    expect(screen.getByRole('button', { name: /new plan with ai/i })).toBeInTheDocument();
  });

  it('sends the brief as a plan intent and lands on the session', async () => {
    const { NewPlanWizard } = await import('./wizard');
    const onClose = vi.fn();
    mount(<NewPlanWizard onClose={onClose} />);

    // An empty brief cannot start a session that would have nothing to author.
    expect(await startButton()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'Ship a cart API.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start authoring/i }));

    // NO `permissionMode` in the ticket: the omission is the choice. The
    // server defaults a plan intent to plan mode, and the select this form
    // used to offer was the one hole left in that rule — `auto` here launched
    // an authoring session that could write a plan nobody approved.
    await waitFor(() =>
      expect(agentTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: 'plan',
          brief: 'Ship a cart API.',
          model: 'opus',
          effort: 'max',
        }),
      ),
    );
    expect(agentTicket).toHaveBeenCalledTimes(1);
    expectSized(agentTicket.mock.calls[0]?.[0]);
    expect(agentTicket.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
    await waitFor(() => expect(landed).toEqual(['#/sessions/a1']));
    expect(onClose).toHaveBeenCalled();
  });

  it('permissions are fixed to plan mode — shown, not selectable', async () => {
    const { NewPlanWizard } = await import('./wizard');
    mount(<NewPlanWizard onClose={() => {}} />);

    // The fact is stated where the select used to be…
    expect(await screen.findByText(/plan mode — fixed for authoring/i)).toBeInTheDocument();
    await startButton();
    // …and there is genuinely nothing to change: no permissions control exists.
    expect(screen.queryByLabelText(/permissions/i)).toBeNull();
  });

  it('needs an open source directory before it can author anywhere', async () => {
    state.mockResolvedValue({ ...BASE_STATE, root: undefined });
    const { NewPlanWizard } = await import('./wizard');
    mount(<NewPlanWizard onClose={() => {}} />);

    expect(await screen.findByText(/open a source directory first/i)).toBeInTheDocument();
    await startButton();
    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'Ship it.' },
    });
    expect(screen.getByRole('button', { name: /start authoring/i })).toBeDisabled();
    expect(agentTicket).not.toHaveBeenCalled();
  });

  it('says what went wrong and stays open when the console refuses the session', async () => {
    agentTicket.mockRejectedValue(new Error('the agent capability is off'));
    const { NewPlanWizard } = await import('./wizard');
    const onClose = vi.fn();
    mount(<NewPlanWizard onClose={onClose} />);

    await startButton();
    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'Ship a cart API.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start authoring/i }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalledTimes(1));
    // The brief is still there to retry with, and nothing navigated.
    await waitFor(() => expect(screen.getByRole('button', { name: /start authoring/i })).toBeEnabled());
    expect(screen.getByPlaceholderText(/what should this plan achieve/i)).toHaveValue('Ship a cart API.');
    expect(onClose).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
  });
});
