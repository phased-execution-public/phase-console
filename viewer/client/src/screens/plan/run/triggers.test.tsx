/**
 * The Run view's Triggers fold (7.0, quiet-console phase 11; control-tower
 * phase 98, #137).
 *
 * What is pinned, in the order it would bite:
 *
 *   - **the armed ones lead, oldest first; the ended ones follow, newest end
 *     first** — what will still happen before what just did — and every `when`
 *     is said in words read through `parseWhen`, never as the grammar's token;
 *   - **arming posts exactly what the form composed**: the route's own field
 *     names, `every: false` said rather than left out, a verb's phase in its
 *     body only for a verb that takes one, and an `at:` time sent as an
 *     instant rather than a zoneless wall-clock;
 *   - **a `when` the grammar refuses is refused HERE**, in the grammar's words
 *     and with the grammar beside it, and nothing is posted;
 *   - **Cancel posts the trigger's own cancel route**;
 *   - **the `run:triggers` event re-reads the fold** — the server writes a
 *     firing to the file, emits, and the line appears without a reload;
 *   - a console without `--allow-run` says so instead of offering a form, and
 *     a plan at its limit says so instead of a form that would be refused.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIGGERS_PER_PLAN } from '@shared/verb-model.js';

const { post, stored, toast } = vi.hoisted(() => ({
  post: vi.fn(),
  stored: { triggers: [] as unknown[] },
  toast: vi.fn(),
}));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) =>
      path === '/api/run/demo/triggers'
        ? Promise.resolve({ triggers: stored.triggers })
        : Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path)),
    post: (path: string, body?: unknown) => post(path, body),
  };
});

vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import type { StoredTrigger } from '@/data/api/runs';
import { queryClientConfig } from '@/data/keys';
import { applyEffect } from '@/data/live';
import { RunTriggers, whenWords } from './triggers';

const NOW = Date.now();
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

function trigger(over: Partial<StoredTrigger> & { id: string }): StoredTrigger {
  return {
    slug: 'demo',
    when: 'phase-done:4',
    verb: 'resume',
    body: {},
    mode: 'once',
    expiresAt: minutes(60 * 24),
    note: null,
    armedAt: minutes(-60),
    armedBy: { by: 'mobin' },
    state: 'armed',
    firings: [],
    ...over,
  };
}

function mount(allowRun = true) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const out = render(
    <QueryClientProvider client={client}>
      <RunTriggers slug="demo" allowRun={allowRun} />
    </QueryClientProvider>,
  );
  return { client, ...out };
}

const rows = () => screen.getAllByTestId('trigger-row');

beforeEach(() => {
  vi.clearAllMocks();
  stored.triggers = [];
  post.mockResolvedValue({ trigger: trigger({ id: 'new' }) });
});

describe('the words of a when', () => {
  it('says every event in words, read through the grammar', () => {
    expect(whenWords('phase-done:4')).toBe('Phase 4 is done');
    expect(whenWords('run-paused')).toBe('The run pauses');
    expect(whenWords('lane-boundary')).toBe('Any lane ends');
    expect(whenWords('phase-boarded:2')).toBe('Phase 2 boards');
    expect(whenWords('phase-settled:3')).toBe('Phase 3 settles');
    expect(whenWords('entry-queued:5')).toBe('Phase 5 waits in the queue');
  });

  it('says an `at` as a clock time in the reader’s own zone, and day and month', () => {
    const at = new Date(2026, 9, 10, 14, 0);
    expect(whenWords(`at:${at.toISOString()}`)).toBe('At 14:00, 10 Oct');
  });

  it('shows a when the grammar refuses as it was written, rather than inventing words for it', () => {
    expect(whenWords('phase-done:0')).toBe('phase-done:0');
  });
});

describe('the list', () => {
  it('leads with the armed triggers, oldest first, then the ended ones, newest end first', async () => {
    stored.triggers = [
      trigger({
        id: 'fired',
        when: 'phase-boarded:2',
        state: 'fired',
        armedAt: minutes(-300),
        endedAt: minutes(-10),
      }),
      trigger({ id: 'armed-late', when: 'run-paused', armedAt: minutes(-30) }),
      trigger({
        id: 'cancelled',
        when: 'entry-queued:5',
        state: 'cancelled',
        armedAt: minutes(-400),
        endedAt: minutes(-60),
      }),
      trigger({ id: 'armed-early', when: 'phase-done:4', armedAt: minutes(-120) }),
      trigger({
        id: 'expired',
        when: 'phase-settled:3',
        state: 'expired',
        armedAt: minutes(-500),
        endedAt: minutes(-5),
      }),
      trigger({ id: 'armed-mid', when: 'lane-boundary', armedAt: minutes(-60) }),
    ];
    mount();
    await screen.findAllByTestId('trigger-row');
    expect(rows().map((row) => row.getAttribute('data-trigger'))).toEqual([
      'armed-early',
      'armed-mid',
      'armed-late',
      'expired',
      'fired',
      'cancelled',
    ]);
    expect(rows().map((row) => row.getAttribute('data-state'))).toEqual([
      'armed',
      'armed',
      'armed',
      'expired',
      'fired',
      'cancelled',
    ]);
    expect(screen.getAllByTestId('trigger-when').map((when) => when.textContent)).toEqual([
      'Phase 4 is done',
      'Any lane ends',
      'The run pauses',
      'Phase 3 settles',
      'Phase 2 boards',
      'Phase 5 waits in the queue',
    ]);
  });

  it('says what each presses, once or every time, who armed it, its note and what its firings came to', async () => {
    stored.triggers = [
      trigger({
        id: 't1',
        when: 'phase-done:4',
        verb: 'retry',
        body: { phase: 6 },
        mode: 'every',
        note: 'carry on once the api lands',
        armedBy: { by: 'mobin', via: 'press' },
        firings: [
          { at: minutes(-20), cause: 'phase.done', ok: true, status: 200 },
          { at: minutes(-5), cause: 'phase 4 done', ok: false, status: 409, error: 'phase 6 is running now' },
        ],
      }),
    ];
    mount();
    const [row] = await screen.findAllByTestId('trigger-row');
    expect(row).toHaveTextContent('Armed');
    expect(row).toHaveTextContent('presses retry on phase 6');
    expect(row).toHaveTextContent('Every time');
    expect(row).toHaveTextContent(/expires \d\d:\d\d, \d{1,2} \w{3}/);
    expect(row).toHaveTextContent('armed by mobin');
    expect(row).toHaveTextContent('carry on once the api lands');
    expect(within(row!).getByTestId('trigger-firings')).toHaveTextContent(
      'fired 2 times, the last on phase 4 done, refused with 409: phase 6 is running now',
    );
    // The verb and the cause are machine words, drawn as such.
    expect(within(row!).getByText('retry').tagName).toBe('CODE');
  });

  it('says so in one line when the plan holds none, and still offers the arm fold', async () => {
    mount();
    expect(await screen.findByText('No trigger is stored for this plan.')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-arm')).toHaveTextContent('Arm a trigger');
  });
});

describe('arming', () => {
  const openForm = async () => {
    await screen.findByText('No trigger is stored for this plan.');
    fireEvent.click(screen.getByTestId('trigger-arm'));
    return screen.getByTestId('trigger-arm-form');
  };
  const arm = () => fireEvent.click(screen.getByRole('button', { name: 'Arm trigger' }));

  it('posts exactly what the form composed, then re-reads the list and folds the form', async () => {
    const { client } = mount();
    const refetch = vi.spyOn(client, 'invalidateQueries');
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'phase-done' } });
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Then press'), { target: { value: 'resume' } });
    arm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/run/demo/triggers', {
      when: 'phase-done:4',
      verb: 'resume',
      every: false,
    });
    await waitFor(() => expect(screen.queryByTestId('trigger-arm-form')).toBeNull());
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['triggers', 'demo'] });
    expect(toast).toHaveBeenCalledWith('Armed: Phase 4 is done, then resume.', 'ok');
  });

  it('sends every time, the expiry as an instant, the note, and a verb’s phase in its body', async () => {
    mount();
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'run-paused' } });
    // An event with no phase asks for none.
    expect(screen.queryByLabelText('Phase')).toBeNull();
    fireEvent.change(screen.getByLabelText('Then press'), { target: { value: 'retry' } });
    fireEvent.change(screen.getByLabelText('On phase'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Every time' }));
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: '2026-10-12T09:30' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  retry it every pause  ' } });
    arm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/run/demo/triggers', {
      when: 'run-paused',
      verb: 'retry',
      body: { phase: 6 },
      every: true,
      expiresAt: new Date('2026-10-12T09:30').toISOString(),
      note: 'retry it every pause',
    });
  });

  it('composes `at:` from the time picked, sent as an ISO instant', async () => {
    mount();
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'at' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '2026-10-11T14:00' } });
    fireEvent.change(screen.getByLabelText('Then press'), { target: { value: 'pause' } });
    arm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, body] = post.mock.calls[0]! as [string, { when: string }];
    expect(body.when).toBe(`at:${new Date('2026-10-11T14:00').toISOString()}`);
    expect(body.when).toMatch(/^at:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('refuses a phase the grammar refuses, in its words and with the grammar beside them, and posts nothing', async () => {
    mount();
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'phase-done' } });
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: '0' } });
    arm();
    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('phase-done:<N> takes a phase number');
    // The grammar, one machine word each — never glued with dots.
    expect(within(refusal).getByText('phase-done:<N>').tagName).toBe('CODE');
    expect(within(refusal).getByText('at:<ISO time>')).toBeInTheDocument();
    expect(refusal.textContent).not.toContain('·');
    expect(post).not.toHaveBeenCalled();
    // The form stays open with the answer kept, to be corrected.
    expect(screen.getByTestId('trigger-arm-form')).toBeInTheDocument();
  });

  it('refuses a verb that acts on a phase until the phase is named', async () => {
    mount();
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'lane-boundary' } });
    fireEvent.change(screen.getByLabelText('Then press'), { target: { value: 'board-at-boundary' } });
    arm();
    expect(await screen.findByRole('alert')).toHaveTextContent('board-at-boundary acts on a phase: name it.');
    expect(post).not.toHaveBeenCalled();
  });

  it('toasts the server’s own refusal and keeps the form', async () => {
    const { ApiError } = await import('@/data/http');
    post.mockRejectedValueOnce(
      new ApiError('demo already holds 32 armed triggers — cancel one first', 409, '/api/run/demo/triggers'),
    );
    mount();
    await openForm();
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'run-paused' } });
    arm();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('demo already holds 32 armed triggers — cancel one first', 'error'),
    );
    expect(screen.getByTestId('trigger-arm-form')).toBeInTheDocument();
  });

  it('offers only the verbs a trigger may press', async () => {
    mount();
    await openForm();
    const verbs = within(screen.getByLabelText('Then press') as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(verbs).toContain('resume');
    expect(verbs).toContain('board-at-boundary');
    // Not triggerable: a start, a stop, and arming a trigger itself.
    expect(verbs).not.toContain('start');
    expect(verbs).not.toContain('stop');
    expect(verbs).not.toContain('trigger');
  });

  it('without --allow-run, says so beside a disabled control, and Cancel cannot be pressed', async () => {
    stored.triggers = [trigger({ id: 't1' })];
    mount(false);
    await screen.findAllByTestId('trigger-row');
    expect(screen.getByRole('button', { name: 'Arm a trigger' })).toBeDisabled();
    expect(screen.getByTestId('trigger-arm-refused')).toHaveTextContent('Arming needs --allow-run.');
    expect(screen.queryByTestId('trigger-arm')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('at the plan’s limit of armed triggers, says so instead of a form the server would refuse', async () => {
    stored.triggers = Array.from({ length: TRIGGERS_PER_PLAN }, (_, i) => trigger({ id: `t${i}` }));
    mount();
    await screen.findAllByTestId('trigger-row');
    expect(screen.getByTestId('trigger-arm-full')).toHaveTextContent(
      `This plan holds ${TRIGGERS_PER_PLAN} armed triggers, the most it may.`,
    );
    expect(screen.queryByTestId('trigger-arm')).toBeNull();
  });
});

describe('cancelling', () => {
  it('posts the trigger’s own cancel route, and only an armed one offers it', async () => {
    stored.triggers = [
      trigger({ id: 'a1b2c3' }),
      trigger({ id: 'gone', state: 'cancelled', endedAt: minutes(-1), endedBy: 'mobin' }),
    ];
    mount();
    await screen.findAllByTestId('trigger-row');
    const [armed, ended] = rows();
    expect(within(ended!).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(ended).toHaveTextContent('by mobin');
    fireEvent.click(within(armed!).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/triggers/a1b2c3/cancel', {}));
  });
});

describe('live', () => {
  it('the run:triggers event re-reads the fold, and the new trigger appears', async () => {
    stored.triggers = [trigger({ id: 'first', when: 'phase-done:4' })];
    const { client } = mount();
    expect(await screen.findAllByTestId('trigger-row')).toHaveLength(1);

    stored.triggers = [
      trigger({ id: 'first', when: 'phase-done:4' }),
      trigger({ id: 'second', when: 'run-paused', armedAt: minutes(-1) }),
    ];
    act(() => applyEffect(client, 'run:triggers', { slug: 'demo' }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1]).toHaveAttribute('data-trigger', 'second');
    expect(within(rows()[1]!).getByTestId('trigger-when')).toHaveTextContent('The run pauses');
  });
});
