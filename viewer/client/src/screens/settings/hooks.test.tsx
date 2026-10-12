/**
 * The session-presence hook (quiet-console phase 21; the 6.x card's cases) —
 * what it says, what it offers, what it refuses.
 *
 * Pinned: the words for each answer of `GET /api/hooks-install`; Install posts
 * `{action: 'install'}` and the group draws the status the write answered;
 * Remove shows only when installed and pointing at this checkout; every
 * disabled state names its fix (writes off, a settings file that does not
 * parse); the path renders as `~/…`; a press the owner door holds is said in
 * the server's words and changes nothing.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import type { HooksStatusView } from '@/data/api';
import { renderWithClient, sent } from './test-kit';
import { HooksGroup } from './hooks';

const HOME = '/home/sam';
const NOT_INSTALLED: HooksStatusView = {
  path: `${HOME}/.claude/settings.json`,
  exists: true,
  installed: false,
  partial: false,
  events: { SessionStart: false, SessionEnd: false, Stop: false },
  command: 'bash "/opt/skill/scripts/session-hook.sh"',
  stale: false,
};
const INSTALLED: HooksStatusView = {
  ...NOT_INSTALLED,
  installed: true,
  events: { SessionStart: true, SessionEnd: true, Stop: true },
};

function serve(status: HooksStatusView, state: Record<string, unknown> = {}) {
  server.reads['/api/state'] = { allowWrites: true, home: HOME, ...state };
  server.reads['/api/hooks-install'] = status;
}

const words = () => screen.getByTestId('hook-status');

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  toast.mockClear();
});

describe('<HooksGroup>', () => {
  it('says "Not installed", offers Install, and draws the status the write answers', async () => {
    serve(NOT_INSTALLED);
    server.reads['POST /api/hooks-install'] = {
      ok: true,
      path: NOT_INSTALLED.path,
      changed: true,
      status: INSTALLED,
    };
    renderWithClient(<HooksGroup />);
    await waitFor(() => expect(words()).toHaveTextContent('Not installed'));
    expect(await screen.findByText('~/.claude/settings.json', { selector: 'code' })).toBeTruthy();
    const install = await screen.findByRole('button', { name: 'Install the hook' });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await waitFor(() => expect(sent(server, 'POST', '/api/hooks-install')).toEqual([{ action: 'install' }]));
    await waitFor(() => expect(words()).toHaveTextContent(/^Installed$/));
    expect(await screen.findByRole('button', { name: 'Remove the hook' })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(
      'Session hook installed. Sessions started from now on report to this console.',
      'ok',
    );
  });

  it('installed: offers Remove, which posts uninstall and reads "Not installed" again', async () => {
    serve(INSTALLED);
    server.reads['POST /api/hooks-install'] = {
      ok: true,
      path: INSTALLED.path,
      changed: true,
      status: NOT_INSTALLED,
    };
    renderWithClient(<HooksGroup />);
    await waitFor(() => expect(words()).toHaveTextContent(/^Installed$/));
    const remove = await screen.findByRole('button', { name: 'Remove the hook' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/hooks-install')).toEqual([{ action: 'uninstall' }]),
    );
    await waitFor(() => expect(words()).toHaveTextContent('Not installed'));
    expect(toast).toHaveBeenCalledWith('Session hook removed.', 'ok');
  });

  it('a stale or partial install says so, and the button repairs it', async () => {
    serve({ ...INSTALLED, installed: false, partial: true, stale: true });
    renderWithClient(<HooksGroup />);
    await waitFor(() => expect(words()).toHaveTextContent('Points at another checkout'));
    expect(await screen.findByRole('button', { name: 'Repair the hook' })).toBeTruthy();
  });

  it('writes off: the button is off and the group names the flag', async () => {
    serve(NOT_INSTALLED, { allowWrites: false });
    renderWithClient(<HooksGroup />);
    expect(await screen.findByTestId('hook-writes-off')).toHaveTextContent('--allow-writes');
    expect(screen.getByRole('button', { name: 'Install the hook' })).toBeDisabled();
  });

  it('a settings file that does not parse turns Install off and says why', async () => {
    serve({ ...NOT_INSTALLED, parseError: 'Unexpected token' });
    renderWithClient(<HooksGroup />);
    await waitFor(() => expect(words()).toHaveTextContent('The settings file does not parse'));
    expect(screen.getByRole('button', { name: 'Install the hook' })).toBeDisabled();
    expect(await screen.findByText(/will not write to a settings file it\s+cannot read back/)).toBeTruthy();
  });

  it('a press the owner door holds is said in the server’s words, and nothing reads as installed', async () => {
    serve(NOT_INSTALLED);
    server.reads['POST /api/hooks-install'] = {
      requested: true,
      request: { id: 'r1', ask: 'asked by this device' },
      error: 'Asked of the owner: confirm it on Your turn.',
    };
    renderWithClient(<HooksGroup />);
    const install = await screen.findByRole('button', { name: 'Install the hook' });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner: confirm it on Your turn.', 'info', 6000),
    );
    expect(words()).toHaveTextContent('Not installed');
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/installed/), 'ok');
  });
});
