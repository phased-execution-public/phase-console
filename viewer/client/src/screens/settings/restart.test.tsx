/**
 * Settings ▸ This instance ▸ Restart (quiet-console phase 23): replacing the
 * process from the page — ported from the 6.x Restart card's tests, the
 * update's included.
 *
 * A browser cannot relaunch a process, so the group asks the server first
 * (`GET /api/restart`) and draws exactly the presses that answer allows. What
 * is pinned is the wire — the body each press sends to `POST /api/restart` —
 * and the words: how the process comes back, what keeps running, why a press
 * is refused and the one command that moves the refusal. A run in flight is
 * never forced; any other refusal offers *Restart anyway*, which is `force`.
 *
 * And the page comes back when the CONSOLE does: it reloads once a different
 * process answers `/api/state` (`bootedAt`), never while the old one still
 * does.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, RestartReadiness } from '@/data/api';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { RestartGroup, cameBack, exitSentence, restartDescription } from './restart';

/** The process this page was loaded against. */
const BOOTED = '2026-10-12T09:00:00.000Z';
const STATE: ConsoleState = { allowRun: true, bootedAt: BOOTED };

/** A console with nothing in flight, under launchd, its sessions held by the broker. */
function ready(over: Partial<RestartReadiness> = {}): RestartReadiness {
  return {
    ok: true,
    supervisor: { kind: 'launchd', detail: 'launchd (com.phase-console)', supervised: true },
    busy: false,
    run: null,
    sessions: { live: 3, agent: 2, terminal: 1, ended: 0, sessions: [], survives: true },
    ...over,
  };
}

/** Mid-run: a restart would abort the session the run is driving. */
const MID_RUN: Partial<RestartReadiness> = {
  ok: false,
  busy: true,
  reason: 'alpha is mid-run (running) — restarting would abort the session it is driving',
  run: { slug: 'alpha', status: 'running', phase: 3 },
};

const SUPERVISED_EXIT =
  'It exits and its supervisor starts it again — a few seconds with no server. This page reloads itself afterwards.';
const SELF_EXIT =
  'Nothing is supervising this console, so it starts itself again with the arguments it was started with — every capability included — and then exits. A few seconds with no server; this page reloads itself afterwards.';

const restarts = () => sent(server, 'POST', '/api/restart');
const reads = (path: string) => sent(server, 'GET', path).length;
const group = () => screen.getByRole('region', { name: 'Restart' });
const mount = () => renderWithClient(<RestartGroup />);

/** Press a confirm button and answer the question it asks. */
async function confirm(button: string, title: string, answer: string) {
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('alertdialog', { name: title });
  fireEvent.click(within(dialog).getByRole('button', { name: answer }));
}

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/state': STATE,
    '/api/restart': ready(),
    'POST /api/restart': { ok: true },
  };
  toast.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when a restart is over', () => {
  it('is over once a different process answers, and a server too old to name itself is judged by going and coming back', () => {
    expect(cameBack(BOOTED, { bootedAt: '2026-10-12T09:02:13.000Z' }, false)).toBe(true);
    // A drain can hold the old process up for a while after the press.
    expect(cameBack(BOOTED, { bootedAt: BOOTED }, true)).toBe(false);
    expect(cameBack(undefined, {}, false)).toBe(false);
    expect(cameBack(undefined, {}, true)).toBe(true);
    // Nothing answering at all is not back.
    expect(cameBack(BOOTED, undefined, true)).toBe(false);
  });

  it('reloads the page once the console answers as a new process, and not while the old one still does', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mount();
    await confirm('Restart the console', 'Restart the console?', 'Restart');
    await waitFor(() => expect(reads('/api/state')).toBeGreaterThanOrEqual(2));
    expect(reload).not.toHaveBeenCalled();
    server.reads['/api/state'] = { ...STATE, bootedAt: '2026-10-12T09:00:41.000Z' };
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('the press', () => {
  it('asks first — how the process comes back and what keeps running — and sends the bare press', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart the console' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart the console?' });
    expect(dialog).toHaveTextContent(SUPERVISED_EXIT);
    expect(within(dialog).getByText('This keeps running:')).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['2 agent sessions', '1 terminal']);
    expect(within(dialog).queryByText('This stops:')).toBeNull();
    // Asked, not done.
    expect(restarts()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(restarts()).toEqual([{}]));
    expect(toast).toHaveBeenCalledWith(
      'Restarting — this page reloads by itself once the console is back.',
      'ok',
    );
    expect(
      await within(group()).findByText('Restarting — this page reloads once the console is back…'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart the console' })).toBeNull();
  });

  it('says a console nothing watches starts itself again with its own arguments, and lists the sessions it ends', async () => {
    const alone = ready({
      selfRestart: true,
      sessions: { live: 3, agent: 2, terminal: 1, ended: 0, sessions: [] },
    });
    expect(exitSentence(alone)).toBe(SELF_EXIT);
    expect(exitSentence(ready())).toBe(SUPERVISED_EXIT);
    // A server that cannot update itself promises nothing but the exit.
    expect(restartDescription(alone)).toBe(SELF_EXIT);
    server.reads['/api/restart'] = alone;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart the console' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart the console?' });
    expect(dialog).toHaveTextContent(SELF_EXIT);
    // A server that does not say its sessions survive is believed to end them.
    expect(within(dialog).getByText('This stops:')).toBeInTheDocument();
    expect(within(dialog).queryByText('This keeps running:')).toBeNull();
  });

  it('is not offered without --allow-run, and names Shut down as the press that needs nothing', async () => {
    server.reads['/api/state'] = { ...STATE, allowRun: false };
    mount();
    expect(await within(group()).findByText(/^Restarting needs/)).toHaveTextContent(
      'Restarting needs --allow-run: it ends a process that may be driving sessions. Shut down, below, needs nothing.',
    );
    expect(within(group()).queryByRole('button')).toBeNull();
    expect(restarts()).toEqual([]);
  });

  it('holds a placeholder while the server is asked, never a press', () => {
    server.reads['/api/restart'] = () => new Promise(() => {});
    mount();
    expect(screen.getByTestId('restart-acts').querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart the console' })).toBeNull();
  });

  it('says nothing about --allow-run until the console’s own flags are read', async () => {
    let answer: (state: ConsoleState) => void = () => {};
    server.reads['/api/state'] = () => new Promise<ConsoleState>((resolve) => (answer = resolve));
    mount();
    await waitFor(() => expect(reads('/api/restart')).toBe(1));
    expect(screen.getByTestId('restart-acts').querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(group()).queryByText(/^Restarting needs/)).toBeNull();
    answer(STATE);
    expect(await screen.findByRole('button', { name: 'Restart the console' })).toBeEnabled();
  });

  it('a readiness the server could not give is said, with the way to ask again — never an empty group', async () => {
    server.reads['/api/restart'] = new ApiError('The console is busy starting up', 503, '/api/restart');
    mount();
    const unread = await screen.findByTestId('restart-unread');
    expect(unread).toHaveTextContent(
      'The console did not say whether it can restart from here: The console is busy starting up.',
    );
    expect(group().querySelector('[aria-busy="true"]')).toBeNull();
    server.reads['/api/restart'] = ready();
    fireEvent.click(within(unread).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Restart the console' })).toBeEnabled();
    expect(restarts()).toEqual([]);
  });
});

describe('a refusal', () => {
  it('that is not a run in flight says why, and Restart anyway sends force', async () => {
    server.reads['/api/restart'] = ready({
      ok: false,
      reason: 'its launch unit’s node arguments drift from what the machine profile asks',
    });
    mount();
    expect(
      await within(group()).findByText(
        'Not from here: its launch unit’s node arguments drift from what the machine profile asks',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart the console' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart anyway' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart the console anyway?' });
    expect(dialog).toHaveTextContent(
      'its launch unit’s node arguments drift from what the machine profile asks. It restarts as it is, and this page reloads once it is back — or says it did not come back.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart anyway' }));
    await waitFor(() => expect(restarts()).toEqual([{ force: true }]));
  });

  it('for a run in flight is never forced: Not now, and Check again asks the server again', async () => {
    server.reads['/api/restart'] = ready(MID_RUN);
    mount();
    expect(
      await within(group()).findByText(
        'Not now: alpha is mid-run (running) — restarting would abort the session it is driving',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart anyway' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart the console' })).toBeNull();

    // The run settles; asking again offers the press.
    server.reads['/api/restart'] = ready();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Restart the console' })).toBeEnabled();
    expect(reads('/api/restart')).toBe(2);
    expect(restarts()).toEqual([]);
  });

  it('the press came back with (409) is shown with its one command, and only then is Restart anyway offered', async () => {
    const reason = 'the launch unit holds older node arguments than the machine profile asks';
    const command = 'launchctl kickstart -k gui/501/com.phase-console';
    server.reads['POST /api/restart'] = (body: unknown) => {
      if ((body as { force?: boolean }).force) return { ok: true };
      throw new ApiError(reason, 409, '/api/restart', { ok: false, reason, command });
    };
    mount();
    await screen.findByRole('button', { name: 'Restart the console' });
    expect(screen.queryByRole('button', { name: 'Restart anyway' })).toBeNull();

    await confirm('Restart the console', 'Restart the console?', 'Restart');
    const refusal = await within(group()).findByText(`Refused: ${reason}`);
    expect(refusal.closest('[role="status"]')).not.toBeNull();
    // The command is drawn whole, and a press copies it.
    expect(within(group()).getByRole('button', { name: command })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), 'error');

    fireEvent.click(within(group()).getByRole('button', { name: 'Restart anyway' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart the console anyway?' });
    expect(dialog).toHaveTextContent('The refusal above stands until its command runs. It restarts as it is');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart anyway' }));
    await waitFor(() => expect(restarts()).toEqual([{}, { force: true }]));
    expect(
      await within(group()).findByText('Restarting — this page reloads once the console is back…'),
    ).toBeInTheDocument();
  });

  it('Check again after a refusal asks the server afresh: the refusal goes, and its answer is what is drawn', async () => {
    const reason = 'the launch unit holds older node arguments than the machine profile asks';
    server.reads['POST /api/restart'] = new ApiError(reason, 409, '/api/restart', { ok: false, reason });
    mount();
    await confirm('Restart the console', 'Restart the console?', 'Restart');
    expect(await within(group()).findByText(`Refused: ${reason}`)).toBeInTheDocument();
    fireEvent.click(within(group()).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Restart the console' })).toBeEnabled();
    expect(within(group()).queryByText(/^Refused:/)).toBeNull();
    // Read at mount, again once the press settled, and a third time for Check again.
    expect(reads('/api/restart')).toBe(3);
    expect(restarts()).toEqual([{}]);
  });

  it('a failure that is not a refusal is said in its own words, and the press stays offered', async () => {
    server.reads['POST /api/restart'] = new ApiError(
      'The console could not start its successor: spawn EACCES',
      500,
      '/api/restart',
    );
    mount();
    await confirm('Restart the console', 'Restart the console?', 'Restart');
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('The console could not start its successor: spawn EACCES', 'error'),
    );
    expect(within(group()).queryByText(/^Refused:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart anyway' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Restart the console' })).toBeEnabled();
  });
});

