/**
 * **Needs you** — the section, and the row every surface shares.
 *
 * The server decides WHICH item exists and WHAT its remedies are
 * (`viewer/test/inbox.test.ts` pins that against the builder). These are the
 * client's own promises:
 *
 *  - a row says the server's words back — the ask, the how, what was tried —
 *    and presses the server's own endpoint with the server's own body;
 *  - a remedy this console cannot perform is offered, disabled, with the flag
 *    named — never hidden;
 *  - the whole list can be triaged from the keyboard, and never steals a key
 *    from a field;
 *  - the empty state says when the loop next looks at all this by itself,
 *    because "nothing needs you" alone reads as "and nothing ever will".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ConvergeStatusView, InboxItem } from '@/lib/api';
import { NeedsYou, nextSweepText } from './needs-you';

const { inboxAct, inboxAck, inboxAckMany, inboxUnackMany, toast } = vi.hoisted(() => ({
  inboxAct: vi.fn(),
  inboxAck: vi.fn(),
  inboxAckMany: vi.fn(),
  inboxUnackMany: vi.fn(),
  toast: vi.fn(),
}));

// The toast is the whole observable result of pressing a remedy, so it is what
// these assert on rather than a rendered Toaster the harness does not mount.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, inboxAct, inboxAck, inboxAckMany, inboxUnackMany } };
});

const item = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'errand:demo:4::verify-red',
    kind: 'errand',
    severity: 'needs-you',
    slug: 'demo',
    phase: 4,
    title: 'demo — phase 4 needs you',
    need: 'The SSH key the session named.',
    how: 'Provide it where the handoff says, then recover.',
    tried: ['re-ran the phase', 'read the handoff'],
    since: new Date(Date.now() - 3 * 60_000).toISOString(),
    href: '#/plan/demo/run',
    actions: [
      {
        verb: 'recover',
        label: 'Recover & continue',
        endpoint: '/api/run/demo/recover',
        method: 'POST',
        body: { runId: 'r1' },
      },
      { verb: 'dismiss', label: 'Dismiss', endpoint: '/api/run/demo/resolve', method: 'POST' },
    ],
    ...over,
  }) as InboxItem;

function mount(props: Partial<React.ComponentProps<typeof NeedsYou>> = {}) {
  const onNavigate = vi.fn();
  const client = new QueryClient(queryClientConfig);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/now" onNavigate={onNavigate}>
        <NeedsYou items={[item()]} loading={false} showAcked={false} onShowAcked={() => {}} {...props} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  inboxAct.mockResolvedValue({ ok: true });
  inboxAck.mockResolvedValue({ ok: true });
  inboxAckMany.mockResolvedValue({ results: [], acked: 0 });
  inboxUnackMany.mockResolvedValue({ results: [], unacked: 0 });
});

describe('a row says what the server said', () => {
  it('leads with the ask, and folds the how and what was tried behind one control', () => {
    mount();
    expect(screen.getByText('demo — phase 4 needs you')).toBeTruthy();
    expect(screen.getByText('The SSH key the session named.')).toBeTruthy();
    // Not on screen until asked for: five asks unfolded is the whole first
    // screen of a phone spent on what the row already named.
    expect(screen.queryByText(/Provide it where the handoff says/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /How/ }));
    expect(screen.getByText(/Provide it where the handoff says/)).toBeTruthy();
    expect(screen.getByText('· re-ran the phase')).toBeTruthy();
  });

  it('presses the server’s own endpoint, method and body — never a verb mapped here', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Recover & continue/ }));
    await waitFor(() =>
      expect(inboxAct).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/api/run/demo/recover',
          method: 'POST',
          body: { runId: 'r1' },
        }),
        // The second argument is the operator's own words, and THIS section
        // offers no box to type them in — `#/approve` is the surface that
        // does. Pinned rather than loosened: a row that started sending a
        // stray note would be changing a request the server spelled.
        undefined,
      ),
    );
  });

  it('offers a flagged remedy, disabled, naming the flag — and never leads with it', () => {
    mount({
      items: [
        item({
          actions: [
            {
              verb: 'recover',
              label: 'Recover & continue',
              endpoint: '/api/run/demo/recover',
              method: 'POST',
              flag: 'run',
            },
            { verb: 'dismiss', label: 'Dismiss', endpoint: '/api/run/demo/resolve', method: 'POST' },
          ],
        }),
      ],
    });
    const blocked = screen.getByRole('button', { name: /Recover & continue/ });
    expect(blocked).toBeDisabled();
    expect(blocked.getAttribute('title')).toContain('--allow-run');
    // Said once per row, where a screen reader reaches it.
    expect(screen.getByText(/Runs are off\. Restart the console with --allow-run\./)).toBeTruthy();
    // Dismiss is the one that can be pressed, so it is the one that leads.
    expect(screen.getByRole('button', { name: /Dismiss/ })).not.toBeDisabled();
  });

  it('acknowledges without pretending anything was fixed', async () => {
    mount();
    const ack = screen.getByRole('button', { name: 'Acknowledge' });
    expect(ack.getAttribute('title')).toContain('Seen, not cleared');
    fireEvent.click(ack);
    await waitFor(() => expect(inboxAck).toHaveBeenCalledWith('errand:demo:4::verify-red'));
  });

  it('says nothing about a clock it does not have', () => {
    // An empty `since` is a fact with no start (an account is signed out;
    // nothing records WHEN). Rendering it as "just now" would be a lie that
    // also makes every acknowledgement of it look stale.
    mount({ items: [item({ since: '' })] });
    expect(screen.queryByText(/ago/)).toBeNull();
  });
});

describe('triage from the keyboard', () => {
  const three = [
    item({ id: 'a', title: 'first' }),
    item({ id: 'b', title: 'second' }),
    item({ id: 'c', title: 'third' }),
  ];

  it('j and k move the cursor, and it starts on the first row', () => {
    mount({ items: three });
    const list = screen.getByRole('list', { name: 'Things that need you' });
    const rows = () => screen.getAllByTestId('inbox-row');
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
    fireEvent.keyDown(list, { key: 'j' });
    expect(rows()[1].getAttribute('data-selected')).toBe('true');
    fireEvent.keyDown(list, { key: 'k' });
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
    // And never past the ends.
    fireEvent.keyDown(list, { key: 'k' });
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
  });

  it('1 presses the selected row’s first remedy', async () => {
    mount({ items: three });
    const list = screen.getByRole('list', { name: 'Things that need you' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: '1' });
    await waitFor(() => expect(inboxAct).toHaveBeenCalledTimes(1));
    expect(inboxAct.mock.calls[0][0].verb).toBe('recover');
  });

  it('a numbered key does nothing when that remedy is flagged — same nothing as a click', () => {
    mount({
      items: [
        item({
          actions: [{ verb: 'recover', label: 'Recover', endpoint: '/api/x', method: 'POST', flag: 'run' }],
        }),
      ],
    });
    fireEvent.keyDown(screen.getByRole('list', { name: 'Things that need you' }), { key: '1' });
    expect(inboxAct).not.toHaveBeenCalled();
  });

  it('Enter opens where the item lives', () => {
    const { onNavigate } = mount({ items: three });
    fireEvent.keyDown(screen.getByRole('list', { name: 'Things that need you' }), { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('#/plan/demo/run');
  });

  it('never steals a key from a field', () => {
    mount({ items: three });
    const list = screen.getByRole('list', { name: 'Things that need you' });
    // A real input INSIDE the list, so the keydown genuinely bubbles to the
    // handler with the field as its target — which is the only shape of this
    // test that could ever fail if the guard were removed.
    const field = document.createElement('input');
    list.append(field);
    fireEvent.keyDown(field, { key: 'j' });
    expect(screen.getAllByTestId('inbox-row')[0].getAttribute('data-selected')).toBe('true');
    field.remove();
  });
});

describe('the empty states', () => {
  it('names the next sweep rather than implying nothing will ever come back', () => {
    mount({
      items: [],
      converge: {
        automatic: true,
        everyMs: 900_000,
        pending: [],
        running: [],
        reports: [],
      } as ConvergeStatusView,
    });
    expect(screen.getByText(/every 15 min/)).toBeTruthy();
  });

  it('says convergence is manual when it is, which is a different and more useful fact', () => {
    expect(
      nextSweepText({
        automatic: false,
        everyMs: 0,
        pending: [],
        running: [],
        reports: [],
      } as ConvergeStatusView),
    ).toContain('manual');
  });

  it('distinguishes "nothing is waiting" from "this server cannot tell you"', () => {
    const { unmount } = mount({ items: [], unavailable: true });
    expect(screen.getByText('This server has no inbox')).toBeTruthy();
    unmount();
    mount({ items: [] });
    expect(screen.getByText('Nothing needs you')).toBeTruthy();
  });
});

describe('a refusal must not read as success', () => {
  // `POST /api/run/<slug>/recover` answers 200 for EVERY outcome, including
  // `errand` ("nothing was launched, a person is needed") and `nothing-to-do`.
  // `perform` toasted "<label> — done." on any 2xx, so pressing Recover &
  // continue on a run nothing could move reported success and changed nothing.
  // The operator pressed it three times and believed it three times.
  const press = async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Recover & continue/ }));
    await waitFor(() => expect(inboxAct).toHaveBeenCalledTimes(1));
  };

  it('says what actually happened when nothing was launched', async () => {
    inboxAct.mockResolvedValue({
      outcome: 'errand',
      detail: 'phase 1 reads QA failed. Needed: a verdict of pass or waived.',
      steps: [],
    });
    await press();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, kind] = toast.mock.calls.at(-1)!;
    expect(message).toMatch(/Needed: a verdict of pass or waived/);
    expect(kind).toBe('warn');
    expect(message).not.toMatch(/— done\./);
  });

  it('says so for nothing-to-do too', async () => {
    inboxAct.mockResolvedValue({ outcome: 'nothing-to-do', detail: 'Nothing was wrong.' });
    await press();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls.at(-1)![1]).toBe('warn');
  });

  it('still reports success when something really was launched', async () => {
    inboxAct.mockResolvedValue({ outcome: 'recovering', detail: 'A bounded recovery is running.' });
    await press();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, kind] = toast.mock.calls.at(-1)!;
    expect(kind).toBe('ok');
    expect(message).toMatch(/A bounded recovery is running/);
  });

  it('an action with no outcome shape is unchanged', async () => {
    inboxAct.mockResolvedValue({ ok: true });
    await press();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, kind] = toast.mock.calls.at(-1)!;
    expect(kind).toBe('ok');
    expect(message).toMatch(/— done\./);
  });
});

/**
 * Bulk triage.
 *
 * Seventeen asks used to be seventeen presses, and the server took one ack per
 * request. What these hold: the bar is not there until something is picked; it
 * offers only the verbs EVERY picked item can do; a remedy is confirmed before
 * it runs, because a bulk remedy starts sessions and spends money where a bulk
 * acknowledge only annotates; and the whole thing works from the keyboard.
 */
describe('picking more than one', () => {
  const two = [item(), item({ id: 'errand:demo:5::verify-red', title: 'demo — phase 5 needs you' })];
  const box = (n: number) => screen.getAllByRole('checkbox')[n] as HTMLElement;

  it('shows no bar until something is picked', () => {
    mount({ items: two });
    expect(screen.queryByTestId('selection-bar')).toBeNull();
    fireEvent.click(box(0));
    expect(screen.getByTestId('selection-bar')).toBeTruthy();
  });

  it('counts what is picked, and clears back to nothing', () => {
    mount({ items: two });
    fireEvent.click(box(0));
    fireEvent.click(box(1));
    expect(screen.getByTestId('selection-bar').textContent).toContain('2 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('selection-bar')).toBeNull();
  });

  it('acknowledges the whole selection in ONE request', async () => {
    mount({ items: two });
    fireEvent.click(box(0));
    fireEvent.click(box(1));
    const bar = screen.getByTestId('selection-bar');
    fireEvent.click(within(bar).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(inboxAckMany).toHaveBeenCalledTimes(1));
    expect(inboxAckMany).toHaveBeenCalledWith([two[0].id, two[1].id]);
    // …and never the single-item endpoint seventeen times.
    expect(inboxAck).not.toHaveBeenCalled();
  });

  it('offers a remedy only when every picked item has it', () => {
    mount({
      items: [item(), item({ id: 'gate:demo:9::x', actions: [item().actions[1]] })],
    });
    fireEvent.click(box(0));
    fireEvent.click(box(1));
    // Both can Dismiss; only one can Recover.
    const bar = screen.getByTestId('selection-bar');
    expect(bar.textContent).toContain('Dismiss');
    expect(bar.textContent).not.toContain('Recover & continue');
  });

  it('confirms a bulk remedy before running it, and names what it will touch', async () => {
    mount({ items: two });
    fireEvent.click(box(0));
    fireEvent.click(box(1));
    fireEvent.click(
      within(screen.getByTestId('selection-bar')).getByRole('button', { name: 'Recover & continue' }),
    );

    // Nothing has been pressed yet — a toolbar button is too small a gesture
    // for starting two sessions.
    expect(inboxAct).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('demo — phase 4 needs you');
    expect(dialog.textContent).toContain('demo — phase 5 needs you');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Recover & continue' }));
    await waitFor(() => expect(inboxAct).toHaveBeenCalledTimes(2));
  });

  it('picks with x and clears with escape, without leaving the keyboard', () => {
    mount({ items: two });
    const list = screen.getByRole('list', { name: 'Things that need you' });
    fireEvent.keyDown(list, { key: 'x' });
    expect(screen.getByTestId('selection-bar').textContent).toContain('1 selected');
    fireEvent.keyDown(list, { key: 'x' });
    expect(screen.getByTestId('selection-bar').textContent).toContain('2 selected');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByTestId('selection-bar')).toBeNull();
  });

  it('a picks everything shown', () => {
    mount({ items: two });
    fireEvent.keyDown(screen.getByRole('list', { name: 'Things that need you' }), { key: 'a' });
    expect(screen.getByTestId('selection-bar').textContent).toContain('2 selected');
  });

  it('never steals x or a from a field', () => {
    mount({ items: two });
    const list = screen.getByRole('list', { name: 'Things that need you' });
    // Inside the list, so the keydown genuinely bubbles to the handler with
    // the field as its target — the only shape of this test that could fail if
    // the guard went. Typing "ax" in a search box must not pick two rows.
    const field = document.createElement('input');
    list.append(field);
    fireEvent.keyDown(field, { key: 'x' });
    fireEvent.keyDown(field, { key: 'a' });
    expect(screen.queryByTestId('selection-bar')).toBeNull();
    field.remove();
  });
});
