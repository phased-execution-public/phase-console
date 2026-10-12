/**
 * Settings ▸ This instance ▸ Shut down (quiet-console phase 23): the off
 * switch at the strength asked for — ported from the 6.x dialogs' tests.
 *
 * What the Restart and Shut-down dialogs claim, and whether it is true. The
 * original defect was silence: a restart killed every pty and no dialog said
 * so. Then the ptys moved to a broker that outlives the console, and a dialog
 * still promising to stop them would be the same defect with the sign flipped
 * — so the split is asserted from both sides, and the flag is read rather than
 * assumed in either direction.
 *
 * Two presses, because one verb was doing two jobs: **Shut down** exits (and
 * under KeepAlive comes straight back, which the dialog says), and **Stay
 * off…** unloads and disables the unit, naming the line that undoes it. Each
 * dialog renders the server's inventory read again as it opens, and confirming
 * acknowledges it — so the wire carries `acknowledge: true` beside the mode.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInventory, ShutdownInventory, ShutdownReadiness, StopPlanView } from '@/data/api';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { __resetShutdownForTests, getConsoleStopped } from '@/lib/shutdown';
import {
  ShutdownGroup,
  StopInventory,
  durabilitySentence,
  inventoryItems,
  keepList,
  stopList,
} from './shutdown';

const sessions = (over: Partial<SessionInventory> = {}): SessionInventory => ({
  live: 3,
  agent: 2,
  terminal: 1,
  ended: 0,
  sessions: [],
  ...over,
});

const RUN = { slug: 'alpha', status: 'running' };

/** How to start it again after a plain exit — the last thing the console will say. */
const HINT = 'bash start --root /home/x/repo';
/** The line that undoes a stay-off. */
const RESURRECT = 'launchctl enable gui/501/com.phase-console';

/** A plain exit nothing brings back. */
const EXIT: StopPlanView = { via: 'exit', mode: 'exit', durability: 'stays-off', detail: 'It exits' };
/** The same exit under KeepAlive: it comes straight back. */
const EXIT_RETURNS: StopPlanView = {
  via: 'exit',
  mode: 'exit',
  durability: 'returns',
  label: 'com.phase-console',
  detail: 'It exits and launchd starts it again',
};
/** Stay off: unloaded and disabled, with the line that undoes it. */
const UNLOAD: StopPlanView = {
  via: 'launchctl',
  mode: 'unload',
  durability: 'disabled',
  label: 'com.phase-console',
  resurrect: RESURRECT,
  detail: 'launchctl unloads and disables com.phase-console',
};

const EMPTY: ShutdownInventory = {
  lanes: [],
  clocks: [],
  runs: [],
  liveSessions: [],
  pendingApprovals: [],
  inboxDepth: { sessions: 0, outcomes: 0 },
};

/** A console with both strengths and nothing in flight, its sessions held by the broker. */
function readiness(over: Partial<ShutdownReadiness> = {}): ShutdownReadiness {
  return {
    supervisor: { kind: 'launchd', detail: 'launchd (com.phase-console)', supervised: true },
    mode: 'exit',
    stop: EXIT,
    modes: { exit: EXIT, unload: UNLOAD },
    inventory: EMPTY,
    empty: true,
    busy: false,
    run: null,
    sessions: sessions({ live: 0, agent: 0, terminal: 0, survives: true }),
    restartHint: HINT,
    unloadHint: null,
    ...over,
  };
}

const shutdowns = () => sent(server, 'POST', '/api/shutdown');
const readsOfShutdown = () => sent(server, 'GET', '/api/shutdown').length;
const group = () => screen.getByRole('region', { name: 'Shut down' });
const mount = () => renderWithClient(<ShutdownGroup />);
/** The listed lines of a dialog, as drawn. */
const items = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('listitem')
    .map((item) => item.textContent);

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/shutdown': readiness(),
    'POST /api/shutdown': { ok: true },
  };
  toast.mockClear();
  __resetShutdownForTests();
});

describe('what a restart or a shut down claims about sessions', () => {
  it('lists sessions as stopped only while they really stop, and moves them to the keep list once the broker owns them', () => {
    expect(stopList(sessions({ survives: false }), null)).toEqual(['2 agent sessions', '1 terminal']);
    expect(keepList(sessions({ survives: false }))).toEqual([]);
    expect(stopList(sessions({ survives: true }), null)).toEqual([]);
    expect(keepList(sessions({ survives: true }))).toEqual(['2 agent sessions', '1 terminal']);
  });

  it('still stops the run whichever side the sessions fall on, and assumes nothing of a server that predates the flag', () => {
    expect(stopList(sessions({ survives: true }), RUN)[0]).toMatch(/^the alpha run \(running\)/);
    expect(stopList(sessions({ survives: false }), RUN)[0]).toMatch(/^the alpha run \(running\)/);
    // No `survives`: the safe reading is that they stop — calling a session
    // safe when it is about to die is the worse of the two errors.
    expect(stopList(sessions(), null)).toEqual(['2 agent sessions', '1 terminal']);
    expect(keepList(sessions())).toEqual([]);
  });

  it('renders both halves, and says why the kept ones are kept', () => {
    render(
      <StopInventory
        items={stopList(sessions({ survives: true }), RUN)}
        keeps={keepList(sessions({ survives: true }))}
      />,
    );
    expect(screen.getByText('This stops:')).toBeInTheDocument();
    expect(screen.getByText('This keeps running:')).toBeInTheDocument();
    expect(screen.getByText(/^Terminals are held by a separate process/)).toBeInTheDocument();
  });

  it('says nothing is running only when nothing is — never beside a keep list', () => {
    const { unmount } = render(<StopInventory items={[]} keeps={keepList(sessions({ survives: true }))} />);
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    expect(screen.getByText('This keeps running:')).toBeInTheDocument();
    unmount();
    render(<StopInventory items={[]} keeps={[]} />);
    expect(screen.getByText('Nothing is running — no session, no run.')).toBeInTheDocument();
  });
});

describe('the inventory, and what each strength achieves', () => {
  it('names every lane, the soonest WORK clock, the runs on disk, the live sessions, the cards and the unread inboxes', () => {
    const held: ShutdownInventory = {
      ...EMPTY,
      lanes: [{ slug: 'alpha', runId: 'r-1', phase: 3, pid: 4242, sessionId: 's-1' }],
      clocks: [
        // An inbox debounce a moment out is counted, never named ahead of the work clock.
        { source: 'session-inbox', at: '2026-10-12T10:00:00.100Z' },
        { source: 'wait-resume', at: '2026-10-12T10:36:48.000Z', slug: 'beta' },
      ],
      runs: [
        {
          slug: 'beta',
          id: 'r-2',
          status: 'paused',
          waitUntil: '2026-10-12T10:36:48.000Z',
          live: false,
          clock: null,
        },
      ],
      liveSessions: [
        { sessionId: '9d8b45ec-aaaa', kind: 'foreign', pid: 66601, cwd: '/home/x/beta', plan: null },
      ],
      pendingApprovals: [
        { id: 'a-1', slug: 'alpha', phase: 3, kind: 'tool', expiresAt: '2026-10-12T11:00:00.000Z' },
      ],
      inboxDepth: { sessions: 3, outcomes: 1 },
    };
    const said = inventoryItems(held);
    expect(said[0]).toBe('alpha phase 3 (pid 4242) — its session is ended and the phase checkpoints');
    expect(said[1]).toMatch(
      /^the wait-resume clock for beta due .+ and 1 more clock — nothing fires while the console is off/,
    );
    expect(
      said.some((item) => /^the beta run \(paused, until .+\) — picked back up at the next boot$/.test(item)),
    ).toBe(true);
    expect(said).toContain(
      '1 live Claude session this console is watching (9d8b45ec) — they keep running, unwatched',
    );
    expect(said).toContain('1 pending approval — answerable again after the restart, or said to be not');
    expect(said).toContain('3 presence events and 1 declaration not yet read');
    expect(inventoryItems(EMPTY)).toEqual([]);
    expect(inventoryItems(undefined)).toEqual([]);
  });

  it('says “nothing” only when the measured inventory is empty, and what confirming acknowledges otherwise', () => {
    const { unmount } = render(<StopInventory items={[]} keeps={[]} acknowledging />);
    expect(
      screen.getByText(
        'Nothing is running, armed, waiting or unread — no lane, no clock, no run, no session, no card.',
      ),
    ).toBeInTheDocument();
    unmount();
    render(<StopInventory items={['alpha phase 3 (pid 4242)']} acknowledging />);
    expect(screen.getByText('This console is holding — confirming stops all of it:')).toBeInTheDocument();
  });

  it('makes each strength’s promise the one it keeps', () => {
    expect(durabilitySentence(EXIT_RETURNS)).toBe(
      'Its supervisor starts it again within seconds: every run checkpoints and resumes.',
    );
    expect(durabilitySentence({ ...EXIT, durability: 'until-login' })).toBe(
      'Nothing brings it back now; the next login starts the unit again.',
    );
    expect(durabilitySentence(EXIT, 'bash start')).toBe(
      'Nothing brings it back. To start it again: bash start',
    );
    expect(durabilitySentence(UNLOAD)).toBe(
      `The unit is unloaded and disabled and a stop marker holds its automation, so it stays off — a login does not bring it back. To start it again: ${RESURRECT}`,
    );
    expect(durabilitySentence(null)).toBe('');
  });
});

describe('Shut down', () => {
  it('reads the inventory again as its dialog opens, sends the exit with the acknowledgement, and records that this tab turned it off', async () => {
    mount();
    const press = await screen.findByRole('button', { name: 'Shut down' });
    expect(group()).toHaveTextContent(
      'Shut down stops this process and the work it is driving. Every session it owns goes with it. Stay off unloads and disables the unit and leaves a stop marker, so not even a login brings the work back until it is started again.',
    );
    expect(readsOfShutdown()).toBe(1);

    // A lane boards between the page's read and the press: the dialog says so.
    server.reads['/api/shutdown'] = readiness({
      inventory: {
        ...EMPTY,
        lanes: [{ slug: 'alpha', runId: 'r-1', phase: 3, pid: 4242, sessionId: 's-1' }],
      },
      empty: false,
      busy: true,
    });
    fireEvent.click(press);
    const dialog = await screen.findByRole('alertdialog', { name: 'Shut the console down?' });
    expect(dialog).toHaveTextContent(`It exits. Nothing brings it back. To start it again: ${HINT}`);
    expect(
      await within(dialog).findByText('This console is holding — confirming stops all of it:'),
    ).toBeInTheDocument();
    expect(items(dialog)).toEqual([
      'alpha phase 3 (pid 4242) — its session is ended and the phase checkpoints',
    ]);
    expect(within(dialog).getByText(HINT).tagName).toBe('CODE');
    expect(readsOfShutdown()).toBe(2);
    expect(shutdowns()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    await waitFor(() => expect(shutdowns()).toEqual([{ confirm: true, mode: 'exit', acknowledge: true }]));
    expect(toast).toHaveBeenCalledWith('Shutting down — this is the last thing this console will say.', 'ok');
    expect(getConsoleStopped()).toEqual({ hint: HINT, via: 'exit' });
  });

  it('under KeepAlive says it comes straight back, and the tab waits for it rather than calling it off', async () => {
    server.reads['/api/shutdown'] = readiness({
      stop: EXIT_RETURNS,
      modes: { exit: EXIT_RETURNS, unload: UNLOAD },
      sessions: sessions({ survives: true }),
    });
    mount();
    const press = await screen.findByRole('button', { name: 'Shut down' });
    expect(group()).toHaveTextContent(
      'Shut down stops this process and its work checkpoints; its supervisor brings it straight back. Terminals and agent sessions are held by a separate process and keep running.',
    );
    fireEvent.click(press);
    const dialog = await screen.findByRole('alertdialog', { name: 'Shut the console down?' });
    expect(dialog).toHaveTextContent(
      'It exits and launchd starts it again. Its supervisor starts it again within seconds: every run checkpoints and resumes.',
    );
    expect(await within(dialog).findByText('This keeps running:')).toBeInTheDocument();
    expect(items(dialog)).toEqual(['2 agent sessions', '1 terminal']);
    expect(within(dialog).queryByText(/^Nothing is running/)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    await waitFor(() => expect(shutdowns()).toEqual([{ confirm: true, mode: 'exit', acknowledge: true }]));
    expect(toast).toHaveBeenCalledWith('Shutting down — this is the last thing this console will say.', 'ok');
    // It is coming back: the shell says "Reconnecting…", not "stopped".
    expect(getConsoleStopped()).toBeNull();
  });

  it('a refused press is said in its own words, and both presses are offered again', async () => {
    server.reads['POST /api/shutdown'] = new ApiError(
      'The inventory moved since the dialog read it — read it again and confirm what it holds now',
      409,
      '/api/shutdown',
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Shut the console down?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'The inventory moved since the dialog read it — read it again and confirm what it holds now',
        'error',
      ),
    );
    expect(shutdowns()).toEqual([{ confirm: true, mode: 'exit', acknowledge: true }]);
    expect(getConsoleStopped()).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Shut down' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Stay off…' })).toBeEnabled();
  });

  it('holds a placeholder while it reads, never a press', () => {
    server.reads['/api/shutdown'] = () => new Promise(() => {});
    mount();
    expect(group().querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Shut down' })).toBeNull();
  });

  it('never vanishes: a read that failed is said, with the way to ask again', async () => {
    server.reads['/api/shutdown'] = new ApiError('The console did not answer.', 502, '/api/shutdown');
    mount();
    const unread = await screen.findByTestId('shutdown-unread');
    // The server's own full stop is not doubled.
    expect(unread).toHaveTextContent(
      /^The console did not say what a shut down would stop: The console did not answer\.Check again$/,
    );
    expect(group().querySelector('[aria-busy="true"]')).toBeNull();
    server.reads['/api/shutdown'] = readiness();
    fireEvent.click(within(unread).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Shut down' })).toBeEnabled();
    expect(readsOfShutdown()).toBe(2);
    expect(shutdowns()).toEqual([]);
  });

  it('on a server with no inventory, falls back to the run and the sessions it can name', async () => {
    // Before 5.0.0: one strength, no inventory, no word on whether sessions survive.
    server.reads['/api/shutdown'] = {
      supervisor: { kind: 'none', detail: 'nothing supervises it' },
      stop: EXIT,
      busy: true,
      run: RUN,
      sessions: sessions(),
      restartHint: HINT,
    } satisfies ShutdownReadiness;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));
    expect(screen.queryByRole('button', { name: 'Stay off…' })).toBeNull();
    const dialog = await screen.findByRole('alertdialog', { name: 'Shut the console down?' });
    expect(await within(dialog).findByText('This stops:')).toBeInTheDocument();
    expect(items(dialog)).toEqual([
      'the alpha run (running) — checkpointed first, and it resumes when the console comes back',
      '2 agent sessions',
      '1 terminal',
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    await waitFor(() => expect(shutdowns()).toEqual([{ confirm: true, mode: 'exit', acknowledge: true }]));
    expect(getConsoleStopped()).toEqual({ hint: HINT, via: 'exit' });
  });
});

describe('Stay off…', () => {
  it('unloads and disables the unit, names the line that undoes it, and sends the unload', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Stay off…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Shut the console down and keep it off?' });
    expect(dialog).toHaveTextContent(
      `launchctl unloads and disables com.phase-console. The unit is unloaded and disabled and a stop marker holds its automation, so it stays off — a login does not bring it back. To start it again: ${RESURRECT}`,
    );
    // The inventory names the same line, and says the measured nothing.
    expect((await within(dialog).findByText(RESURRECT)).tagName).toBe('CODE');
    expect(
      within(dialog).getByText(
        'Nothing is running, armed, waiting or unread — no lane, no clock, no run, no session, no card.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay off' }));
    await waitFor(() => expect(shutdowns()).toEqual([{ confirm: true, mode: 'unload', acknowledge: true }]));
    expect(toast).toHaveBeenCalledWith(
      'Shutting down to stay off — this is the last thing this console will say.',
      'ok',
    );
    expect(getConsoleStopped()).toEqual({ hint: RESURRECT, via: 'launchctl' });
  });

  it('is not offered where there is no unit to unload, and the lead does not promise it', async () => {
    server.reads['/api/shutdown'] = readiness({ modes: { exit: EXIT, unload: null } });
    mount();
    expect(await screen.findByRole('button', { name: 'Shut down' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Stay off…' })).toBeNull();
    expect(group()).not.toHaveTextContent(/Stay off/);
  });
});
