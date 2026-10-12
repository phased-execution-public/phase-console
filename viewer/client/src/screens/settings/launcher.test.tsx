/**
 * Settings ▸ Essentials ▸ Desktop launcher (quiet-console phase 21), ported
 * from the 6.x card's test — and now in both editions, because the group
 * renders in Free too: it draws whatever the server answers about a launcher
 * on this platform, and the free server's answer is that it has none and how
 * to start a console instead.
 *
 * What is worth pinning is the GATING, not the layout. The button mints a 0755
 * file that starts a console with every capability on, so each state it can be
 * in names its own fix: writes off (restart with the flag), a platform with no
 * launcher (no button, the server's sentence instead). A button greyed out with
 * no reason is the failure this group was written to avoid — and so is one that
 * refuses for a reason that is no longer true: since launcher rev 12 nothing
 * about a source directory is baked in, so an open one is not a precondition.
 * Every path shown is `~/…`: a screenshot of Settings carries no username.
 */

import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import type { ConsoleState, LauncherPlanView } from '@/data/api';
import { ApiError } from '@/data/http';
import { expectNoAxeViolations } from '@/test/axe';
import { LauncherGroup } from './launcher';
import { renderWithClient } from './test-kit';

const HOME = '/home/testperson';

const STATE: ConsoleState = {
  platform: 'darwin',
  home: HOME,
  port: 4123,
  root: { path: `${HOME}/code/my-repo`, ok: true },
  allowWrites: true,
  supervisor: { supervised: true, kind: 'launchd' },
};

/** What a server with no launcher for this platform answers — every platform, in the free edition. */
const NONE: LauncherPlanView = {
  platform: 'darwin',
  supported: false,
  note: 'Start this console from a shell with `./start`, or keep a terminal tab on it.',
  rootOpen: true,
  fullFlags: ['--allow-writes', '--allow-run'],
};

const mount = () => renderWithClient(<LauncherGroup />);

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/state': STATE, '/api/launcher': NONE };
});

describe('a platform with no launcher', () => {
  it('draws the group with the server’s sentence, its command in the machine face, and no button', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Desktop launcher' })).toBeInTheDocument();
    const note = await screen.findByTestId('launcher-unsupported');
    expect(note).toHaveTextContent(
      'Start this console from a shell with ./start, or keep a terminal tab on it.',
    );
    expect(screen.getByText('./start').tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: /Create the Desktop launcher/ })).toBeNull();
  });

  it('tells Windows the WSL story rather than offering a shortcut that cannot work', async () => {
    server.reads['/api/launcher'] = {
      ...NONE,
      platform: 'win32',
      note: 'Phase Console runs on macOS and Linux. On Windows, install it inside WSL.',
    };
    mount();
    expect(await screen.findByText(/inside WSL/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create the Desktop launcher/ })).toBeNull();
  });

  it('says so when where a launcher would go could not be read', async () => {
    server.reads['/api/launcher'] = new ApiError('the launcher plan is not answering', 503, '/api/launcher');
    mount();
    expect(
      await screen.findByText(
        'Where a launcher would go could not be read: the launcher plan is not answering',
      ),
    ).toBeInTheDocument();
  });

  it('is busy, and says so, until the server answers', () => {
    server.reads['/api/launcher'] = () => new Promise(() => {});
    mount();
    expect(screen.getByTestId('launcher-loading')).toHaveAttribute('aria-busy', 'true');
  });

  it('has no axe violation', async () => {
    const { container } = mount();
    await screen.findByTestId('launcher-unsupported');
    await expectNoAxeViolations(container);
  });
});

