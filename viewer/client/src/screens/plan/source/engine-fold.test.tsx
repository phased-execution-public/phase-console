/**
 * The engine fold (7.0, quiet-console phase 10): the board as the terminal
 * prints it, the machine block the runner parses and the session plan — each
 * the engine's answer to one question, with the command that asks it.
 *
 * What is pinned: NOTHING is asked until a fold is opened (each is a
 * `phase-graph.sh` shell-out on the server, and opening a plan must spend no
 * engine call); each fold names its command before it is opened; the session
 * plan with no model names the plan's target model and asks the server's
 * default, and a picked model is asked for by name; a failed read is the
 * server's words and a way to ask again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import { EngineFold } from './engine-fold';

const { boardText, memoryBlock, sessionPlan, state } = vi.hoisted(() => ({
  boardText: vi.fn(),
  memoryBlock: vi.fn(),
  sessionPlan: vi.fn(),
  state: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, boardText, memoryBlock, sessionPlan, state } };
});

const BOARD = 'demo — 3 phases\n  done   P1 Foundations\n  ready  P2 Surface\n  wait   P3 Cutover';
const MEMORY = 'done: 1\nin-progress:\nstuck:\nready: 2\nwaiting: 3\nblocked: 3<-2(not-done)';
const PLAN = { raw: 'S1  P2 + P3  120K', groups: [], budget: '200K' };

beforeEach(() => {
  boardText.mockReset().mockResolvedValue(BOARD);
  memoryBlock.mockReset().mockResolvedValue(MEMORY);
  sessionPlan.mockReset().mockResolvedValue(PLAN);
  state.mockReset().mockResolvedValue({ models: ['opus', 'sonnet'] });
});

/** A plan whose target model is `opus` unless the case says otherwise. */
function mount({ targetModel }: { targetModel?: string | undefined } = { targetModel: 'opus' }) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <EngineFold slug="demo" targetModel={targetModel} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const fold = (testId: string) => within(screen.getByTestId(testId));

/** A real window, not one tick: a read that fired on mount would have done so by now. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe('the engine fold', () => {
  it('asks the engine nothing until a fold is opened', async () => {
    mount();
    await settle();
    expect(boardText).not.toHaveBeenCalled();
    expect(memoryBlock).not.toHaveBeenCalled();
    expect(sessionPlan).not.toHaveBeenCalled();
  });

  it('names the command each fold answers before it is opened', () => {
    mount();
    expect(fold('engine-board').getByRole('button', { name: /Board text/ })).toHaveTextContent(
      'phase-graph.sh demo',
    );
    expect(fold('engine-memory').getByRole('button', { name: /Memory block/ })).toHaveTextContent(
      'phase-graph.sh demo --memory-block',
    );
    // No model picked: the plan's own target model is what the server asks.
    expect(fold('engine-session-plan').getByRole('button', { name: /Session plan/ })).toHaveTextContent(
      'phase-graph.sh demo --session-plan opus',
    );
  });

  it('reads the board text once opened, and only that', async () => {
    mount();
    fireEvent.click(fold('engine-board').getByRole('button', { name: /Board text/ }));
    expect(await fold('engine-board').findByText(/ready P2 Surface/)).toBeInTheDocument();
    expect(boardText).toHaveBeenCalledWith('demo');
    expect(memoryBlock).not.toHaveBeenCalled();
    expect(sessionPlan).not.toHaveBeenCalled();
    // The command, copyable, and the output, copyable.
    expect(fold('engine-board').getByRole('button', { name: /Copy the output/ })).toBeInTheDocument();
    expect(fold('engine-board').getByTitle('phase-graph.sh demo — press to copy')).toBeInTheDocument();
  });

  it('reads the machine block the runner parses', async () => {
    mount();
    fireEvent.click(fold('engine-memory').getByRole('button', { name: /Memory block/ }));
    expect(await fold('engine-memory').findByText(/blocked: 3<-2\(not-done\)/)).toBeInTheDocument();
    expect(memoryBlock).toHaveBeenCalledWith('demo');
    expect(boardText).not.toHaveBeenCalled();
  });

  it('plans the sessions at the plan’s model, then at the model picked from the server’s list', async () => {
    mount();
    fireEvent.click(fold('engine-session-plan').getByRole('button', { name: /Session plan/ }));
    expect(await fold('engine-session-plan').findByText('S1 P2 + P3 120K')).toBeInTheDocument();
    // Unnamed: the server's default, which is the plan's target model.
    expect(sessionPlan).toHaveBeenCalledWith('demo', undefined);

    const picker = await fold('engine-session-plan').findByLabelText('Model');
    // The SERVER's list of models, never a copy of one.
    await fold('engine-session-plan').findByRole('option', { name: 'sonnet' });
    expect(within(picker).getByRole('option', { name: 'The plan’s target model, opus' })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'sonnet' } });
    await vi.waitFor(() => expect(sessionPlan).toHaveBeenCalledWith('demo', 'sonnet'));
    expect(
      fold('engine-session-plan').getByTitle('phase-graph.sh demo --session-plan sonnet — press to copy'),
    ).toBeInTheDocument();
  });

  it('names no model in the command when the plan names none', () => {
    mount({ targetModel: undefined });
    expect(fold('engine-session-plan').getByRole('button', { name: /Session plan/ })).toHaveTextContent(
      /phase-graph\.sh demo --session-plan$/,
    );
  });

  it('says so in words when a plan has no phase graph to batch', async () => {
    sessionPlan.mockResolvedValue(null);
    mount();
    fireEvent.click(fold('engine-session-plan').getByRole('button', { name: /Session plan/ }));
    expect(
      await fold('engine-session-plan').findByText(/no phase graph, so there are no sessions to plan/),
    ).toBeInTheDocument();
  });

  it('a failed read is the server’s words, and a way to ask again', async () => {
    boardText
      .mockRejectedValueOnce(new Error('phase-graph.sh exited 2: no such plan'))
      .mockResolvedValue(BOARD);
    mount();
    fireEvent.click(fold('engine-board').getByRole('button', { name: /Board text/ }));
    expect(
      await fold('engine-board').findByText('phase-graph.sh exited 2: no such plan'),
    ).toBeInTheDocument();
    fireEvent.click(fold('engine-board').getByRole('button', { name: 'Read it again' }));
    expect(await fold('engine-board').findByText(/ready P2 Surface/)).toBeInTheDocument();
    expect(boardText).toHaveBeenCalledTimes(2);
  });

  it('has no axe violations, folded and open', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
    fireEvent.click(fold('engine-board').getByRole('button', { name: /Board text/ }));
    await fold('engine-board').findByText(/ready P2 Surface/);
    await expectNoAxeViolations(container);
  });
});
