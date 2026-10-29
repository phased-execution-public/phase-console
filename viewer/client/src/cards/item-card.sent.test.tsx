/**
 * After a press (2026-10-20, hub: an approved gate's card stayed open, with
 * nothing to say it had been sent, so it was pressed four times):
 *
 *   IS-1 a yes on its way says so — the primary reads Sending… and nothing
 *        else can be pressed while it travels;
 *   IS-2 a press that went through holds the card as SENT — what was sent and
 *        when, nothing to press again — until the server moves the item, with
 *        one way to show the choices again; a press that failed leaves the
 *        choices where they were;
 *   IS-3 a bound option that went through is held the same way;
 *   IS-4 a ledger decision the server bound to its GATE presses the gate — its
 *        own options would be refused, since only the gate's Approve opens it;
 *   IS-5 *I can't do this* is on every open ledger card — a Task's, a
 *        Decision's and an Approval's — one press from the card, with the
 *        person's reason, never folded under another press.
 *   IS-7 a decision the AI can take ends with *Hand it to the AI* (2026-10-20):
 *        it is pressed through the turn's verb with the person's note, in
 *        place of *I can't do this*; and a note typed beside an option that
 *        takes no words goes to the AI before the option is pressed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import type { InboxAction, TurnItem, TurnOption } from '@/data/api';
import type { HumanStepRecord } from '@/data/human-steps';
import { keys, queryClientConfig } from '@/data/keys';
import { UNDO_WINDOW_MS } from '@/data/undo-window';
import { MemoryRouterProvider } from '@/shell/router';
import { ItemCard } from './item-card';

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: [number, unknown] = [200, { ok: true }];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  answer = [200, { ok: true }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url);
      if (path.includes('/api/state')) return json(200, { chat: { available: false } });
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return json(answer[0], answer[1]);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function wrap(node: ReactNode) {
  const client = new QueryClient(queryClientConfig);
  client.setQueryData(keys.state(), { chat: { available: false } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    redraw: (next: ReactNode) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <MemoryRouterProvider initial="#/turn">{next}</MemoryRouterProvider>
        </QueryClientProvider>,
      ),
  };
}

/* ------------------------------------------------------------------ *
 * The items
 * ------------------------------------------------------------------ */

const APPROVE_GATE: InboxAction = {
  verb: 'approve',
  label: 'Approve the gate',
  endpoint: '/api/plans/alpha/gate/3',
  method: 'POST',
  body: { approve: true, continueRun: true },
};

function gate(over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 'gate:alpha:3::',
    record: 'projected',
    source: 'gate',
    kind: 'decision',
    why: 'decision',
    proofType: 'answer',
    type: 'approve',
    group: 'approve',
    readiness: 'now',
    personStatus: 'todo',
    rows: ['gate:alpha:3::'],
    title: 'Clear the gate on alpha phase 3',
    need: 'The owner approves the release.',
    how: 'Approve it.',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '',
    href: '/plan/alpha/phase/3',
    actions: [APPROVE_GATE],
    options: [],
    route: 'gate',
    checkedBy: 'Your answer is the result',
    ...over,
  } as TurnItem;
}

const LEAVE: TurnOption = {
  id: 'leave',
  label: 'Leave them, and resolve the conflict when the branches meet',
  verb: { method: 'POST', endpoint: '/api/inbox/ack', body: { id: 'conflict::::a × b', answer: 'leave' } },
};

function conflict(over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 'conflict::::a × b',
    record: 'projected',
    source: 'conflict',
    kind: 'decision',
    why: 'decision',
    proofType: 'answer',
    type: 'decide',
    group: 'decide',
    readiness: 'now',
    personStatus: 'todo',
    rows: ['conflict::::a × b'],
    title: 'a × b — these branches would not merge',
    need: 'Two branches touch the same lines.',
    how: 'Choose one way on.',
    severity: 'needs-you',
    since: '',
    href: '/repo/branches',
    actions: [],
    options: [LEAVE],
    route: 'supervisor',
    checkedBy: 'Your answer is the result',
    ...over,
  } as TurnItem;
}

function ledger(kind: HumanStepKind, state: HumanStepState, over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 's1',
    record: 'ledger',
    source: 'plan',
    kind,
    why: kind === 'decision' ? 'decision' : 'physical',
    proofType: 'probe',
    group: 'now',
    readiness: 'now',
    personStatus: 'todo',
    rows: ['human-step:alpha:3:s1'],
    title: 'Approve the release train on Phase 14’s Gate card',
    need: 'The train ships three phases.',
    how: 'Read the note, then choose.',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '2026-10-20T00:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: [],
    humanStep: humanStepView({ kind, title: 'Approve the release train', state, stepId: 's1' }),
    route: 'phase',
    checkedBy: 'The console runs a check',
    ...over,
  } as TurnItem;
}

const OWN_OPTIONS = [
  {
    id: 'approve',
    label: 'Approve the train',
    consequence: 'Phases 14–16 merge and deploy',
    recommended: true,
  },
  { id: 'hold', label: 'Hold', consequence: 'the plan waits' },
];

const GATE_OPTION: TurnOption = {
  id: 'approve-gate',
  label: 'Approve the gate on Phase 14',
  consequence: 'The gate opens, Phase 14 of alpha starts and the run carries on.',
  recommended: true,
  verb: { method: 'POST', endpoint: '/api/plans/alpha/gate/14', body: { approve: true, continueRun: true } },
};

const pick = (id: string) =>
  fireEvent.click(within(screen.getByTestId(`turn-option-${id}`)).getByRole('radio'));

/* ------------------------------------------------------------------ */

describe('IS-1 a yes on its way says so', () => {
  it('while the gate’s Approve travels, the primary reads Sending… and is off', () => {
    wrap(<ItemCard item={gate()} perform={vi.fn()} busy="gate:alpha:3:::approve" />);
    const primary = screen.getByTestId('turn-primary') as HTMLButtonElement;
    expect(primary.textContent).toBe('Sending…');
    expect(primary.disabled).toBe(true);
  });
});

describe('IS-2 a press that went through holds the card as sent', () => {
  it('the gate’s Approve, once the row says done: what was sent, and nothing to press again', async () => {
    vi.useFakeTimers();
    const perform = vi.fn(() => Promise.resolve(true));
    wrap(<ItemCard item={gate()} perform={perform} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(perform).toHaveBeenCalledTimes(1);
    const sent = screen.getByTestId('turn-sent');
    expect(sent.textContent).toContain('Approve the gate');
    expect(sent.textContent).toContain('sent');
    expect(screen.queryByTestId('turn-primary')).toBeNull();
    // The head says it is being checked, not that it is still to do.
    expect(screen.getByTestId('turn-item').getAttribute('data-person-status')).toBe('checking');
  });

  it('one press shows the choices again', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={gate()} perform={vi.fn(() => Promise.resolve(true))} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    fireEvent.click(within(screen.getByTestId('turn-sent')).getByRole('button'));
    expect(screen.queryByTestId('turn-sent')).toBeNull();
    expect(screen.getByTestId('turn-primary').textContent).toBe('Approve the gate');
  });

  it('a press that failed leaves the choices where they were', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={gate()} perform={vi.fn(() => Promise.resolve(false))} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.queryByTestId('turn-sent')).toBeNull();
    expect(screen.getByTestId('turn-primary').textContent).toBe('Approve the gate');
  });

  it('the server moving the item ends the hold — Done says how it settled', async () => {
    vi.useFakeTimers();
    const view = wrap(<ItemCard item={gate()} perform={vi.fn(() => Promise.resolve(true))} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.getByTestId('turn-sent')).toBeTruthy();
    view.redraw(
      <ItemCard
        item={gate({
          group: 'done',
          personStatus: 'passed',
          settled: {
            outcome: 'passed',
            by: 'operator',
            at: '2026-10-20T01:37:18.983Z',
            what: 'Approved the gate',
          },
        })}
        perform={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('turn-sent')).toBeNull();
    expect(screen.getByTestId('turn-settled').getAttribute('data-outcome')).toBe('passed');
  });
});

describe('IS-3 a bound option that went through is held the same way', () => {
  it('Send my decision on a conflict: sent, and its options are gone until the server moves it', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={conflict()} perform={vi.fn()} />);
    pick('leave');
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(calls).toContainEqual({
      path: '/api/inbox/ack',
      method: 'POST',
      body: { id: 'conflict::::a × b', answer: 'leave' },
    });
    expect(screen.getByTestId('turn-sent').textContent).toContain('Leave them');
    expect(screen.queryByTestId('turn-options')).toBeNull();
  });
});

describe('IS-4 a gate-bound ledger decision presses its gate', () => {
  const item = () =>
    ledger('decision', 'notified', {
      type: 'decide',
      group: 'decide',
      step: { options: OWN_OPTIONS } as unknown as TurnItem['step'],
      options: [GATE_OPTION],
    });

  it('draws the gate’s Approve, never the options its answer would be refused for', () => {
    wrap(<ItemCard item={item()} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-option-approve-gate').textContent).toContain(
      'Approve the gate on Phase 14',
    );
    expect(screen.queryByText('Approve the train')).toBeNull();
  });

  it('Send my decision presses the gate, and no answer is sent', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={item()} perform={vi.fn()} />);
    pick('approve-gate');
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(calls).toContainEqual({
      path: '/api/plans/alpha/gate/14',
      method: 'POST',
      body: { approve: true, continueRun: true },
    });
    expect(calls.some((call) => call.path.endsWith('/answer'))).toBe(false);
  });

  it('a ledger decision bound to its own answer keeps its own options', () => {
    const own: TurnOption[] = OWN_OPTIONS.map((option) => ({
      ...option,
      verb: { method: 'POST', endpoint: '/api/human-steps/s1/answer', body: { option: option.id } },
    }));
    wrap(
      <ItemCard
        item={ledger('decision', 'notified', {
          type: 'decide',
          group: 'decide',
          step: { options: OWN_OPTIONS } as unknown as TurnItem['step'],
          options: own,
        })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('decision-option-approve').textContent).toContain('Approve the train');
  });
});

describe('IS-5 I can’t do this, on every open ledger card', () => {
  async function cannot(reason: string) {
    fireEvent.click(screen.getByTestId('turn-cannot'));
    fireEvent.change(screen.getByPlaceholderText('Who can do it, or what is in the way'), {
      target: { value: reason },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send my reason' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: '/api/turn/s1/cannot',
        method: 'POST',
        body: { reason },
      }),
    );
  }

  it('a Decision’s', async () => {
    wrap(
      <ItemCard
        item={ledger('decision', 'notified', {
          type: 'decide',
          group: 'decide',
          step: { options: OWN_OPTIONS } as unknown as TurnItem['step'],
        })}
        perform={vi.fn()}
      />,
    );
    await cannot('I do not own the release budget');
  });

  it('an Approval’s', async () => {
    wrap(
      <ItemCard
        item={ledger('person-check', 'notified', { type: 'approve', group: 'approve', why: 'decision' })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('turn-primary').getAttribute('data-move')).toBe('approve');
    await cannot('I cannot judge this design');
  });

  it('a Task’s — one press from the card, never folded under Hand it back', async () => {
    wrap(<ItemCard item={ledger('physical', 'notified', { type: 'do' })} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-cannot')).toBeTruthy();
    await cannot('The device is in the other office');
  });

  it('an escalated Task offers it once — in the escalation’s own box', () => {
    const record = { escalatedAt: '2026-10-20T00:00:00.000Z', attempts: 3 } as HumanStepRecord;
    wrap(
      <ItemCard item={ledger('physical', 'notified', { type: 'do' })} record={record} perform={vi.fn()} />,
    );
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
    expect(
      within(screen.getByTestId('turn-escalation')).getByRole('button', { name: 'I can’t do this' }),
    ).toBeTruthy();
  });

  it('nothing settled or not yet due offers it', () => {
    const { unmount } = wrap(
      <ItemCard
        item={ledger('decision', 'upcoming', { type: 'decide', readiness: 'not-yet', group: 'upcoming' })}
        perform={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
    unmount();
    wrap(
      <ItemCard
        item={ledger('decision', 'proven', { type: 'decide', personStatus: 'passed', group: 'done' })}
        perform={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
  });
});

describe('IS-6 I can’t do this, on the cards the console projects', () => {
  async function cannot(id: string, reason: string) {
    fireEvent.click(screen.getByTestId('turn-cannot'));
    fireEvent.change(screen.getByPlaceholderText('Who can do it, or what is in the way'), {
      target: { value: reason },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send my reason' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: `/api/turn/${encodeURIComponent(id)}/cannot`,
        method: 'POST',
        body: { reason },
      }),
    );
  }

  it('a gate’s: the reason goes to the turn’s verb, and the card holds as sent', async () => {
    answer = [200, { ok: true, item: 'gate:alpha:3::', settled: null, told: { note: 'n1', chat: null } }];
    wrap(<ItemCard item={gate()} perform={vi.fn()} />);
    await cannot('gate:alpha:3::', 'I cannot reach box #2 from here');
    expect((await screen.findByTestId('turn-sent')).textContent).toContain("I can't do this");
    expect(screen.queryByTestId('turn-primary')).toBeNull();
  });

  it('a conflict’s', async () => {
    answer = [200, { ok: true, item: 'conflict::::a × b', settled: null, told: { note: null, chat: null } }];
    wrap(<ItemCard item={conflict()} perform={vi.fn()} />);
    await cannot('conflict::::a × b', 'neither branch is mine');
  });

  it('a refusal leaves the card as it was', async () => {
    answer = [409, { error: 'This item is settled already — there is nothing left to hand back.' }];
    wrap(<ItemCard item={gate()} perform={vi.fn()} />);
    await cannot('gate:alpha:3::', 'no');
    await waitFor(() => expect(screen.getByTestId('turn-primary').textContent).toBe('Approve the gate'));
    expect(screen.queryByTestId('turn-sent')).toBeNull();
  });

  it('never on the owner’s request, which ends by its own press', () => {
    wrap(<ItemCard item={gate({ record: 'request', personStatus: 'owner' })} perform={vi.fn()} />);
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
  });
});

const HAND_OFF: TurnOption = {
  id: 'hand-to-ai',
  label: 'Hand it to the AI',
  consequence: 'The AI decides it, with your note; the item moves to Done.',
  verb: { method: 'POST', endpoint: '/api/turn/s1/hand-off', body: {} },
  says: { field: 'note', label: 'Your note for the AI', placeholder: 'What it should know or weigh' },
};

describe('IS-7 Hand it to the AI, and a note for the AI', () => {
  const pickOwn = (id: string) =>
    fireEvent.click(within(screen.getByTestId(`decision-option-${id}`)).getByRole('radio'));

  async function sendAfterWindow() {
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it('a ledger decision ends with the hand-off, pressed through the turn with the note — and no I can’t do this', async () => {
    vi.useFakeTimers();
    wrap(
      <ItemCard
        item={ledger('decision', 'notified', {
          type: 'decide',
          group: 'decide',
          step: { options: OWN_OPTIONS } as unknown as TurnItem['step'],
          options: [HAND_OFF],
        })}
        perform={vi.fn()}
      />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByTestId('decision-option-hand-to-ai').textContent).toContain('Hand it to the AI');
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
    pickOwn('hand-to-ai');
    fireEvent.change(screen.getByLabelText('Your note for the AI'), {
      target: { value: 'you know the load best' },
    });
    await sendAfterWindow();
    expect(calls).toContainEqual({
      path: '/api/turn/s1/hand-off',
      method: 'POST',
      body: { note: 'you know the load best' },
    });
    expect(calls.some((call) => call.path.endsWith('/answer'))).toBe(false);
  });

  it('a ledger decision’s own option still answers through its step, the note with it', async () => {
    vi.useFakeTimers();
    wrap(
      <ItemCard
        item={ledger('decision', 'notified', {
          type: 'decide',
          group: 'decide',
          step: { options: OWN_OPTIONS } as unknown as TurnItem['step'],
          options: [HAND_OFF],
        })}
        perform={vi.fn()}
      />,
    );
    pickOwn('hold');
    fireEvent.change(screen.getByTestId('decision-note'), { target: { value: 'after the audit' } });
    await sendAfterWindow();
    expect(calls).toContainEqual({
      path: '/api/human-steps/s1/answer',
      method: 'POST',
      body: { option: 'hold', note: 'after the audit' },
    });
  });

  it('a conflict: the note goes to the AI first, then the option that takes no words is pressed', async () => {
    vi.useFakeTimers();
    answer = [200, { ok: true, item: 'conflict::::a × b', told: { note: 'n1', chat: null } }];
    wrap(
      <ItemCard
        item={conflict({
          options: [
            LEAVE,
            {
              ...HAND_OFF,
              verb: { ...HAND_OFF.verb, endpoint: '/api/turn/conflict%3A%3A%3A%3Aa%20%C3%97%20b/hand-off' },
            },
          ],
        })}
        perform={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('turn-cannot')).toBeNull();
    pick('leave');
    fireEvent.change(screen.getByLabelText('A note for the AI (optional)'), {
      target: { value: 'merge x first' },
    });
    await sendAfterWindow();
    const note = calls.findIndex((call) => call.path.endsWith('/note'));
    const ack = calls.findIndex((call) => call.path === '/api/inbox/ack');
    expect(calls[note]).toEqual({
      path: `/api/turn/${encodeURIComponent('conflict::::a × b')}/note`,
      method: 'POST',
      body: { text: 'merge x first' },
    });
    expect(ack).toBeGreaterThan(note);
  });
});
