/**
 * The question card (zero-touch phase 14) — a relayed question on the queue.
 *
 * A question is answered by CHOOSING, so the card is options, not Allow/Deny:
 * one button per option, a countdown to the moment the console answers by
 * rule, a question already answered shown as answered, and a deferred one
 * that nobody here can answer. The permission card beside it is untouched.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval } from '@/lib/api';
import { ApprovalQueue } from './approvals';

const card = (over: Partial<Approval> = {}): Approval => ({
  id: 'q1',
  runId: 'r1',
  slug: 'demo',
  phase: 3,
  kind: 'question',
  title: 'Which colour should the banner be?',
  detail: 'Phase 3 of demo asks. Answer within 60 s, or the console answers "Blue (Recommended)" by rule.',
  evidence: [],
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 42_000).toISOString(),
  status: 'pending',
  question: {
    mechanism: 'pre-tool-use',
    tool: 'AskUserQuestion',
    items: [
      {
        key: 'colour:which-colour',
        question: 'Which colour should the banner be?',
        header: 'Colour',
        options: [{ label: 'Red' }, { label: 'Blue (Recommended)' }],
        multiSelect: false,
      },
      {
        key: 'port:which-port',
        question: 'Which port?',
        options: [{ label: '8080' }, { label: '9090' }],
        multiSelect: false,
      },
    ],
    answers: {
      'port:which-port': { label: '9090', by: 'human', who: 'phone', at: new Date().toISOString() },
    },
  },
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<ApprovalQueue> question card', () => {
  it('offers each option as a button, counts down, and sends the pick', () => {
    const onAnswer = vi.fn();
    const onDecide = vi.fn();
    render(<ApprovalQueue approvals={[card()]} allowRun onDecide={onDecide} onAnswer={onAnswer} />);
    expect(screen.getByText('A session asks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.getByText(/\d+ s to answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][1]).toBe('colour:which-colour');
    expect(onAnswer.mock.calls[0][2]).toBe('Red');
    expect(onDecide).not.toHaveBeenCalled();
    // The question a person on another device already answered is shown answered, and closed.
    expect(screen.getByText(/Answered “9090” by phone/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '8080' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says it is answering by rule once the window is spent, and nothing is pressable', () => {
    vi.useFakeTimers();
    const onAnswer = vi.fn();
    render(
      <ApprovalQueue
        approvals={[card({ expiresAt: new Date(Date.now() + 1_500).toISOString() })]}
        allowRun
        onDecide={vi.fn()}
        onAnswer={onAnswer}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText(/answering by rule/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Red' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a deferred question is for its resume, and a console without --allow-run cannot answer', () => {
    const deferred = card({
      question: {
        ...card().question!,
        deferred: { toolUseId: 't1', at: new Date().toISOString(), why: 'shutdown' },
      },
    });
    const { unmount } = render(
      <ApprovalQueue approvals={[deferred]} allowRun onDecide={vi.fn()} onAnswer={vi.fn()} />,
    );
    expect(screen.getByText(/deferred — answered when its session resumes/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Red' }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<ApprovalQueue approvals={[card()]} allowRun={false} onDecide={vi.fn()} onAnswer={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Red' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/--allow-run/)).toBeTruthy();
  });

  it('leaves a permission card as it was — Allow and Deny', () => {
    render(
      <ApprovalQueue
        approvals={[card({ kind: 'tool', question: undefined, title: 'Bash: psql' })]}
        allowRun
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.queryByText('A session asks')).toBeNull();
  });
});
