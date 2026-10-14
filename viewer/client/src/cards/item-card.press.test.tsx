/**
 * The item card's new doors (turn-by-turn phase 5): every route the phase adds
 * has a press a page reaches.
 *
 *   IP-1 a projected decision draws its bound options — none picked, the
 *        recommended one named "(Recommended)", a flagged one disabled with
 *        its flag — and their Send is the one primary; the row buttons derived
 *        from them are not drawn twice;
 *   IP-2 Send waits out the undo window, then presses the option's own verb
 *        with what the person typed in the field it names;
 *   IP-3 Undo inside the window sends nothing, ever;
 *   IP-4 a stale run's 409 is said on the item, in the server's sentence;
 *   IP-5 Approve and Not doing this are held too;
 *   IP-6 an item being checked offers Undo, which takes the check back;
 *   IP-7 a ledger item of a phase offers Give back to Phase N — and nothing
 *        else does;
 *   IP-8 Goes to and Checked by, how a Done item settled, and the latest note;
 *   IP-9 (Pro) Ask the supervisor about this opens the chat with the item itself as its chip.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import type { InboxAction, TurnItem, TurnOption } from '@/data/api';
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
      if (path.includes('/api/state')) return json(200, { chat: { available: true } });
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
  client.setQueryData(keys.state(), { chat: { available: true } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ *
 * The items
 * ------------------------------------------------------------------ */

const OPTIONS: TurnOption[] = [
  {
    id: 'qa-recover',
    label: 'Fix what QA found',
    consequence: 'The phase is resumed with the findings.',
    verb: { method: 'POST', endpoint: '/api/run/alpha/qa-recover', body: { phase: 3, expectRunId: 'r-1' } },
  },
  {
    id: 'qa-rerun',
    label: 'Run QA again',
    recommended: true,
    consequence: 'A fresh reviewer reads the phase.',
    verb: { method: 'POST', endpoint: '/api/run/alpha/qa-rerun', body: { phase: 3, expectRunId: 'r-1' } },
    says: { field: 'note', label: 'What changed since', placeholder: 'What the reviewer should know' },
  },
  {
    id: 'qa-waive',
    label: 'Waive QA',
    verb: { method: 'POST', endpoint: '/api/run/alpha/qa-waive', body: { phase: 3, expectRunId: 'r-1' } },
    flag: 'run',
  },
];

const actionOf = (option: TurnOption): InboxAction => ({
  verb: option.id,
  label: option.label,
  endpoint: option.verb.endpoint,
  method: option.verb.method,
  ...(option.verb.body !== undefined ? { body: option.verb.body } : {}),
  ...(option.flag ? { flag: option.flag } : {}),
});

const OPEN_PLAN: InboxAction = { verb: 'open', label: 'Open the plan', endpoint: '/api/y', method: 'POST' };

function projected(over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 'qa:alpha:3',
    record: 'projected',
    source: 'qa',
    kind: 'decision',
    why: 'decision',
    proofType: 'answer',
    group: 'decide',
    rows: ['qa:alpha:3'],
    title: 'Choose how QA’s findings are handled',
    need: 'QA failed phase 3.',
    how: 'Pick one way on.',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r-1',
    since: '2026-10-13T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: [...OPTIONS.map(actionOf), OPEN_PLAN],
    options: OPTIONS,
    route: 'phase',
    checkedBy: 'Your answer is the result',
    ...over,
  } as TurnItem;
}

function ledger(kind: HumanStepKind, state: HumanStepState, over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 's1',
    record: 'ledger',
    source: 'session',
    kind,
    why: 'identity',
    proofType: 'probe',
    group: state === 'checking' ? 'checking' : 'now',
    rows: ['human-step:alpha:3:s1'],
    title: 'Sign the gh CLI in',
    need: 'The phase pushes its branch.',
    how: 'Open the sign-in, then check.',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '2026-10-13T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: [],
    humanStep: humanStepView({ kind, title: 'Sign the gh CLI in', state, stepId: 's1' }),
    route: 'phase',
    checkedBy: 'The console runs a check',
    personStatus: state === 'checking' ? 'checking' : 'todo',
    ...over,
  } as TurnItem;
}

const pick = (id: string) =>
  fireEvent.click(within(screen.getByTestId(`turn-option-${id}`)).getByRole('radio'));

/* ------------------------------------------------------------------ */

describe('IP-1 a projected decision’s bound options', () => {
  it('draws every option, none picked, the recommended one named, a flagged one off with its flag', () => {
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    const radios = within(screen.getByTestId('turn-options')).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(0);
    // The recommended one is named in words beside its label (turn-by-turn phase 8), never chosen.
    expect(screen.getByTestId('turn-option-qa-rerun').textContent).toContain('Run QA again');
    expect(screen.getByTestId('turn-option-qa-rerun').textContent).toContain('Recommended');
    expect(screen.getByTestId('turn-option-qa-recover').textContent).not.toContain('Recommended');
    const waive = screen.getByTestId('turn-option-qa-waive');
    expect((within(waive).getByRole('radio') as HTMLButtonElement).disabled).toBe(true);
    expect(waive.textContent).toContain('--allow-run');
  });

  it('their Send is the one primary, disabled until one is picked; the derived row buttons are not drawn twice', () => {
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    const primaries = screen.getAllByTestId('turn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.getAttribute('data-move')).toBe('decide');
    expect((primaries[0] as HTMLButtonElement).disabled).toBe(true);
    const moves = screen.getByTestId('turn-moves');
    expect(within(moves).queryByRole('button', { name: 'Fix what QA found' })).toBeNull();
    // A row action no option stands for stays a button of its own.
    expect(within(moves).getByRole('button', { name: 'Open the plan' })).toBeTruthy();
    pick('qa-recover');
    expect((screen.getByTestId('turn-primary') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('IP-2 IP-3 Send waits out the undo window', () => {
  it('nothing is sent inside the window; after it, the option’s own verb with what was typed', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    pick('qa-rerun');
    fireEvent.change(screen.getByLabelText('What changed since'), { target: { value: ' A fix landed. ' } });
    fireEvent.click(screen.getByTestId('turn-primary'));
    expect(screen.getByTestId('turn-held').textContent).toContain('Run QA again');
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    expect(calls).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toEqual([
      {
        path: '/api/run/alpha/qa-rerun',
        method: 'POST',
        body: { phase: 3, expectRunId: 'r-1', note: 'A fix landed.' },
      },
    ]);
  });

  it('Undo inside the window sends nothing, ever', async () => {
    vi.useFakeTimers();
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    pick('qa-recover');
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-held-undo'));
    });
    expect(screen.queryByTestId('turn-held')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 4);
    });
    expect(calls).toHaveLength(0);
  });
});

describe('IP-4 a stale run is said on the item', () => {
  it('the 409’s sentence, where the press was made', async () => {
    const words =
      'This was asked of run r-1 of alpha, and the plan’s run is r-2 now — nothing was pressed. Read the item again: it says what the new run needs.';
    answer = [409, { error: words, stale: { expected: 'r-1', current: 'r-2' } }];
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    pick('qa-recover');
    fireEvent.click(screen.getByTestId('turn-primary'));
    fireEvent.click(screen.getByTestId('turn-held-send'));
    const refusal = await screen.findByTestId('turn-option-refusal');
    expect(refusal.textContent).toBe(words);
    expect(calls).toHaveLength(1);
  });
});

describe('IP-5 the other terminal presses are held too', () => {
  const APPROVE: InboxAction = {
    verb: 'approve',
    label: 'Approve the gate',
    endpoint: '/api/plans/alpha/gate/3',
    method: 'POST',
  };
  const gate = () =>
    projected({
      item: 'gate:alpha:3',
      source: 'gate',
      rows: ['gate:alpha:3'],
      options: [],
      actions: [APPROVE],
    });

  it('Approve waits for the window, and Undo keeps it from ever reaching the row', async () => {
    vi.useFakeTimers();
    const perform = vi.fn();
    wrap(<ItemCard item={gate()} perform={perform} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    expect(perform).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-held-undo'));
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    });
    expect(perform).not.toHaveBeenCalled();
  });

  it('sent once the window ends — the row’s own action, verbatim', async () => {
    vi.useFakeTimers();
    const perform = vi.fn();
    wrap(<ItemCard item={gate()} perform={perform} />);
    fireEvent.click(screen.getByTestId('turn-primary'));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0]![1]).toBe(APPROVE);
  });

  it('Not doing this is held, then declines with the reason', async () => {
    const item = ledger('operator-act', 'notified', { step: { allowDecline: true } as TurnItem['step'] });
    wrap(<ItemCard item={item} perform={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not doing this' }));
    fireEvent.change(screen.getByPlaceholderText('What should happen instead'), {
      target: { value: 'Use the staging key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send my reason' }));
    expect(screen.getByTestId('turn-held').textContent).toContain('Not doing this');
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId('turn-held-send'));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: '/api/human-steps/s1/decline',
        method: 'POST',
        body: { reason: 'Use the staging key' },
      }),
    );
  });
});

describe('IP-6 Undo on a running check', () => {
  it('an item being checked offers Undo, which takes the check back', async () => {
    answer = [200, { ok: true, undo: { to: 'opened', attempt: 2 } }];
    wrap(<ItemCard item={ledger('physical', 'checking')} perform={vi.fn()} />);
    const undo = screen.getByTestId('turn-primary');
    expect(undo.getAttribute('data-move')).toBe('undo');
    expect(undo.textContent).toBe("Undo: I'm not finished");
    fireEvent.click(undo);
    await waitFor(() =>
      expect(calls).toEqual([{ path: '/api/human-steps/s1/undo', method: 'POST', body: {} }]),
    );
  });

  it('an item not being checked offers none', () => {
    wrap(<ItemCard item={ledger('physical', 'opened')} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-primary').getAttribute('data-move')).not.toBe('undo');
  });
});

describe('IP-7 Give back to Phase N', () => {
  it('a ledger item of a phase is handed back to it', async () => {
    wrap(<ItemCard item={ledger('physical', 'notified')} perform={vi.fn()} />);
    // Folded under *Hand it back* (turn-by-turn phase 8), with a question and "I can't" beside it.
    fireEvent.click(screen.getByTestId('turn-hand-back'));
    const back = screen.getByTestId('turn-give-back');
    expect(back.textContent).toBe('Give back to Phase 3');
    fireEvent.click(back);
    await waitFor(() =>
      expect(calls).toEqual([{ path: '/api/human-steps/s1/rewrite', method: 'POST', body: {} }]),
    );
  });

  it('the console’s item, the plan’s own act and a projected item offer none', () => {
    const { unmount } = wrap(
      <ItemCard item={ledger('physical', 'notified', { route: 'console' })} perform={vi.fn()} />,
    );
    expect(screen.queryByTestId('turn-give-back')).toBeNull();
    unmount();
    const second = wrap(<ItemCard item={ledger('physical', 'notified', { phase: 0 })} perform={vi.fn()} />);
    expect(screen.queryByTestId('turn-give-back')).toBeNull();
    second.unmount();
    wrap(<ItemCard item={projected()} perform={vi.fn()} />);
    expect(screen.queryByTestId('turn-give-back')).toBeNull();
  });
});

describe('IP-8 the routing words, the settlement and the note', () => {
  it('says where a press goes and who checks it', () => {
    wrap(<ItemCard item={ledger('physical', 'notified')} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-goes-to').textContent).toContain(
      'The phase — its session picks up where it stopped.',
    );
    expect(screen.getByTestId('turn-checked-by').textContent).toContain('The console runs a check');
  });

  it('a Done item says how it settled, and the latest note the person wrote', () => {
    const item = ledger('physical', 'proven', {
      group: 'done',
      personStatus: 'passed',
      settled: {
        outcome: 'passed',
        by: 'the owner',
        at: '2026-10-13T11:00:00.000Z',
        what: 'Approved the gate.',
      },
      step: {
        notes: [
          { attempt: 1, text: 'Plugged it in.', at: '2026-10-13T10:30:00.000Z' },
          { attempt: 2, text: 'Swapped the cable.', at: '2026-10-13T10:50:00.000Z' },
        ],
      } as TurnItem['step'],
    });
    wrap(<ItemCard item={item} perform={vi.fn()} />);
    const settled = screen.getByTestId('turn-settled');
    expect(settled.getAttribute('data-outcome')).toBe('passed');
    expect(settled.textContent).toMatch(/^Passed — by the owner, at .+\. Approved the gate\.$/);
    expect(screen.getByTestId('turn-check-note').textContent).toBe(
      'Your note with attempt 2: Swapped the cable.',
    );
  });

  it('a closed one says Closed', () => {
    const item = ledger('physical', 'dismissed', {
      group: 'done',
      settled: {
        outcome: 'closed',
        by: 'the console',
        at: '2026-10-13T11:00:00.000Z',
        what: 'The run moved on.',
      },
    });
    wrap(<ItemCard item={item} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-settled').textContent).toMatch(/^Closed — by the console/);
  });
});

