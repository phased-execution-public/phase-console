/**
 * A session's controls (7.0, quiet-console phase 15): what a freeze is and
 * when it ends, said; and every verb on one session, pressed through the one
 * press door.
 *
 * `frozenTitle` names both halves of a freeze. A freeze is held, not ended, so
 * the sentence says what it is ("continues mid-token, in the same process")
 * AND what ends the holding — `escalateAt`, off the wire from `terminal.ts`, on
 * the clock and through the verdict a lane freeze uses. Only the first half
 * once shipped, so the operator could read the promise and not the deadline.
 * A record written before deadlines existed keeps the old sentence rather than
 * an invented time.
 *
 * The verbs go through `useSessionActs` (`data/sessions.ts`) against a stubbed
 * server. Pinned: each verb is its own route; one verb in flight holds every
 * control; the answer carries the list as it now is and goes straight into the
 * cache; Stop and Close are asked before they are taken; what each verb does
 * is said under the controls, never only in a hover title (a finger cannot
 * hover); and the page is left (`onGone`) only once a Close or a Dismiss went
 * through — never on a request the owner has still to confirm, nor on a
 * refusal, which says the server's own reason.
 *
 * No JSX here (a `.ts` file): the components are created with `createElement`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession, TerminalState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/toast')>()),
  toast,
}));

import { SessionActions, SessionControls, frozenTitle } from './controls';

const AT = Date.UTC(2026, 7, 26, 10, 0);
const NOW = AT + 4 * 60_000;

describe('frozenTitle', () => {
  it('names what a freeze is AND when it converts', () => {
    const title = frozenTitle(
      { at: AT, by: 'the tab strip', escalateAt: new Date(NOW + 11 * 60_000).toISOString() },
      NOW,
    );
    expect(title).toContain('Frozen by the tab strip');
    expect(title).toContain('continues mid-token, in the same process');
    // The half that was missing: a deadline, and how long is left on it.
    expect(title).toMatch(/Left frozen past /);
    expect(title).toMatch(/it is stopped gracefully\.$/);
  });

  it('says a passed deadline is being acted on, not still pending', () => {
    const title = frozenTitle(
      { at: AT, by: 'console', escalateAt: new Date(NOW - 1_000).toISOString() },
      NOW,
    );
    expect(title).toContain('Past its deadline');
    expect(title).not.toMatch(/Left frozen past /);
  });

  it('keeps the old sentence for a record written before deadlines existed', () => {
    // An unreadable or absent `escalateAt` must not become an invented time.
    // A card that guesses a deadline is worse than one that does not show it.
    const title = frozenTitle({ at: AT, by: 'console', escalateAt: 'not a date' } as never, NOW);
    expect(title).toContain('continues mid-token');
    expect(title).not.toContain('Left frozen past');
    expect(title).not.toContain('Past its deadline');
  });
});

/* ------------------------------------------------------------------ *
 * The verbs, against a stubbed server
 * ------------------------------------------------------------------ */

const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 't1',
  label: 'a session',
  kind: 'claude',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 4242,
  clients: 1,
  createdAt: Date.now() - 2 * 60_000,
  ...over,
});

const frozenBy = (by: string): NonNullable<TerminalSession['frozen']> => ({
  at: Date.now() - 4 * 60_000,
  by,
  escalateAt: new Date(Date.now() + 11 * 60_000).toISOString(),
});

const ENDED = { exited: { code: 0 }, exitedAt: Date.now() } satisfies Partial<TerminalSession>;

const listOf = (...sessions: TerminalSession[]): TerminalState => ({
  allowed: true,
  agentAllowed: true,
  available: 'yes',
  limit: 8,
  live: sessions.filter((one) => !one.exited).length,
  sessions,
});

/** Every request made, as `METHOD path`. */
let sent: string[] = [];
/** What the server answers a request — `[status, body]`. */
let answerFor: (call: string) => [number, unknown] = () => [404, { error: 'not here' }];
/** Held until released, when a test reads the moment a verb is in flight. */
let hold: Promise<void> = Promise.resolve();

beforeEach(() => {
  sent = [];
  hold = Promise.resolve();
  toast.mockReset();
  answerFor = () => [200, { ok: true, state: listOf(session()) }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      sent.push(call);
      await hold;
      const [status, body] = answerFor(call);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Mount over a client of the app's own config, its list seeded with `seeded`. */
function mount(node: ReactElement, seeded: TerminalState = listOf(session())) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.terminal(), seeded);
  render(createElement(QueryClientProvider, { client }, node));
  return client;
}

/** Open a confirm by its trigger, and hand back the question it asks. */
async function ask(trigger: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  return screen.findByRole('alertdialog');
}

describe('SessionControls', () => {
  it('Freeze is its own route; while it is in flight every control holds; the answer is the list', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frozen = session({ frozen: frozenBy('you') });
    answerFor = () => [200, { ok: true, state: listOf(frozen) }];
    const client = mount(createElement(SessionControls, { session: session() }));

    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    // One verb in flight, one word — so one rule for every button.
    expect(await screen.findByRole('button', { name: 'Freezing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();

    release();
    await waitFor(() => expect(toast).toHaveBeenCalledWith('a session frozen where it stood', 'ok'));
    expect(sent).toEqual(['POST /api/terminal/t1/freeze']);
    // The answer carries the list as it now is, and that is what the cache holds.
    expect(client.getQueryData(keys.terminal())).toEqual(listOf(frozen));
    expect(await screen.findByRole('button', { name: 'Freeze' })).toBeEnabled();
  });

  it('a frozen session offers Continue, titled with what the freeze is and when it ends', async () => {
    mount(createElement(SessionControls, { session: session({ frozen: frozenBy('the tab strip') }) }));
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    const resume = screen.getByRole('button', { name: 'Continue' });
    expect(resume.title).toMatch(
      /^Frozen by the tab strip, .+ ago — continues mid-token, in the same process\. Left frozen past /,
    );
    fireEvent.click(resume);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('a session continued — it picks up mid-token', 'ok'),
    );
    expect(sent).toEqual(['POST /api/terminal/t1/thaw']);
  });

  it('Stop is asked first: keeping it running stops nothing, and the confirm stops it', async () => {
    mount(createElement(SessionControls, { session: session() }));
    const question = await ask('Stop');
    expect(within(question).getByText('Stop a session?')).toBeInTheDocument();
    // Unlike Close the record stays — and the question says so before anything happens.
    expect(question.textContent).toMatch(/SIGTERM first/);
    expect(question.textContent).toMatch(/the record stays in the list/);
    fireEvent.click(within(question).getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).toEqual([]);

    fireEvent.click(within(await ask('Stop')).getByRole('button', { name: 'Stop the session' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'a session asked to stop — force-ended only if it ignores the grace',
        'ok',
      ),
    );
    expect(sent).toEqual(['POST /api/terminal/t1/stop']);
  });

  it('a stop already in flight holds Freeze and says Stopping…', () => {
    mount(createElement(SessionControls, { session: session({ stopping: { at: Date.now(), by: 'you' } }) }));
    const freeze = screen.getByRole('button', { name: 'Freeze' });
    expect(freeze).toBeDisabled();
    expect(freeze).toHaveAttribute('title', 'A stop is already in flight');
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('an ended session has no controls at all', () => {
    mount(createElement(SessionControls, { session: session(ENDED) }));
    expect(screen.queryByTestId('session-controls')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('SessionActions', () => {
  it('says what each verb does under the controls — a finger cannot hover', () => {
    mount(createElement(SessionActions, { session: session(), atCap: false, onGone: vi.fn() }));
    const actions = screen.getByTestId('session-actions');
    expect(within(actions).getByTestId('session-controls')).toBeInTheDocument();
    expect(actions.textContent).toMatch(
      /Freeze stops the session’s processes where they stand \(SIGSTOP\), losing nothing/,
    );
    expect(actions.textContent).toMatch(/Stop sends SIGTERM and force-ends only after a 15-second grace/);
    expect(actions.textContent).toMatch(/Kills the process and removes the record\./);
  });

  it('once frozen, says the freeze and its deadline in words, not only in a title', () => {
    mount(
      createElement(SessionActions, {
        session: session({ frozen: frozenBy('the tab strip') }),
        atCap: false,
        onGone: vi.fn(),
      }),
    );
    expect(
      screen.getByText(
        /^Frozen by the tab strip, .+ ago — continues mid-token, in the same process\. Left frozen past /,
      ),
    ).toBeInTheDocument();
  });

  it('Close is asked first, and leaves the page only once the close went through', async () => {
    const onGone = vi.fn();
    answerFor = () => [200, { closed: true, state: listOf() }];
    mount(createElement(SessionActions, { session: session(), atCap: false, onGone }));
    const question = await ask('Close');
    expect(within(question).getByText('Close a session?')).toBeInTheDocument();
    expect(sent).toEqual([]);
    expect(onGone).not.toHaveBeenCalled();

    fireEvent.click(within(question).getByRole('button', { name: 'Close the session' }));
    await waitFor(() => expect(onGone).toHaveBeenCalledWith('t1'));
    expect(sent).toEqual(['DELETE /api/terminal?id=t1']);
    // A verb that moves the page away says nothing about itself.
    expect(toast).not.toHaveBeenCalled();
  });

  it('a Close the owner has still to confirm is not a close: it says so, and the page stays', async () => {
    const onGone = vi.fn();
    answerFor = () => [
      202,
      {
        requested: true,
        request: {
          id: 'req-1',
          method: 'DELETE',
          path: '/api/terminal?id=t1',
          body: {},
          ask: 'asked by this browser through device — close a session — confirm?',
        },
        error: 'Asked of the owner — it waits on Your turn.',
      },
    ];
    mount(createElement(SessionActions, { session: session(), atCap: false, onGone }));
    fireEvent.click(within(await ask('Close')).getByRole('button', { name: 'Close the session' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner — it waits on Your turn.', 'info'),
    );
    expect(onGone).not.toHaveBeenCalled();
  });

  it('an ended conversation offers Resume here and its command, and Dismiss drops the record', async () => {
    const onGone = vi.fn();
    const onResume = vi.fn();
    answerFor = () => [200, { ok: true, state: listOf() }];
    const ended = session({ ...ENDED, meta: { claudeSessionId: 'conv-1' } });
    mount(createElement(SessionActions, { session: ended, atCap: false, onGone, onResume }));
    // An ended process has nothing left to freeze or stop.
    expect(screen.queryByTestId('session-controls')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy resume command' })).toBeInTheDocument();
    expect(
      screen.getByText('Starts a new session that continues this conversation, with its history.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume here' }));
    expect(onResume).toHaveBeenCalledWith('conv-1');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(onGone).toHaveBeenCalledWith('t1'));
    expect(sent).toEqual(['DELETE /api/terminal?id=t1&action=dismiss']);
  });

  it('at the cap Resume waits and says why; a shell has no conversation to resume', () => {
    const ended = session({ ...ENDED, meta: { claudeSessionId: 'conv-1' } });
    mount(createElement(SessionActions, { session: ended, atCap: true, onGone: vi.fn(), onResume: vi.fn() }));
    expect(screen.getByRole('button', { name: 'Resume here' })).toBeDisabled();
    expect(screen.getByText(/^Close a live session first/)).toBeInTheDocument();

    cleanup();
    mount(
      createElement(SessionActions, {
        session: session({ ...ENDED, kind: 'shell' }),
        atCap: false,
        onGone: vi.fn(),
        onResume: vi.fn(),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Resume here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('a refused verb says the server’s own reason, keeps the list it answered, and stays on the page', async () => {
    // What the route answers a Dismiss on a record whose process still runs
    // (`server/api/routes.ts`): 409, the reason `terminal.ts` gives, and the
    // list as it now is — the same shape a refused Freeze, Continue or Stop gets.
    const live = session({ label: 'still going' });
    answerFor = () => [
      409,
      { ok: false, reason: 'that session is still running — close it instead', state: listOf(live) },
    ];
    const onGone = vi.fn();
    const client = mount(
      createElement(SessionActions, { session: session(ENDED), atCap: false, onGone }),
      listOf(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(sent).toEqual(['DELETE /api/terminal?id=t1&action=dismiss']);
    expect(onGone).not.toHaveBeenCalled();
    // A refusal is an answered request: its words are the server's, never a status code.
    expect(toast).toHaveBeenCalledWith('that session is still running — close it instead', 'error');
    expect(client.getQueryData(keys.terminal())).toEqual(listOf(live));
  });
});
