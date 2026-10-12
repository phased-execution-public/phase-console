/**
 * Settings ▸ Essentials ▸ Start command (quiet-console phase 21): portable,
 * per platform, and free of the operator's name — ported from the 6.x card's
 * test, with the composer's own cases kept here beside the card that prints it.
 *
 * The pinned properties: the composed line renders every path under the
 * server's home as `"$HOME/…"` — an absolute home path in the card is the
 * privacy leak this test exists to catch — every switch the console state
 * exposes is composed, the Windows answer is WSL rather than a `cmd.exe` form
 * that does not exist, the switches the running console lacks are named, and
 * Copy hands over exactly the line on screen.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import type { ConsoleState } from '@/data/api';
import { CAPABILITIES, composeStartCommand, portablePath } from '@/lib/start-command';
import { StartCommandGroup } from './start-command';
import { renderWithClient } from './test-kit';

const STATE: ConsoleState = {
  platform: 'darwin',
  home: '/home/testperson',
  port: 4123,
  scriptsDir: '/home/testperson/.claude/skills/phased-execution/scripts',
  root: { path: '/home/testperson/code/my-repo', ok: true },
  allowWrites: true,
  allowRun: true,
  allowTerminal: false,
  allowAgent: false,
  allowAccounts: false,
  allowMcp: false,
  allowWebhooks: false,
};

/**
 * The switches past the free seven: `--allow-issues` in Pro (control-tower phase 115), none in the free
 * tree. A list the Pro region adds to, never a `let` it reassigns: with the region stripped, a `let`
 * nothing reassigns fails the free tree's `prefer-const` (control-tower phase 117).
 */
const PRO_SWITCHES: string[] = [];
const PRO_TAIL = PRO_SWITCHES.map((flag) => ` ${flag}`).join('');
const SWITCHES = 7 + PRO_SWITCHES.length;

describe('composeStartCommand', () => {
  it('renders every home path as "$HOME/…" and carries every switch it composes', () => {
    const command = composeStartCommand(STATE);
    expect(command).toBe(
      '"$HOME/.claude/skills/phased-execution/start" "$HOME/code/my-repo" --port 4123 ' +
        '--allow-writes --allow-run --allow-terminal --allow-agent --allow-accounts --allow-mcp ' +
        '--allow-webhooks' +
        PRO_TAIL,
    );
    expect(command).not.toContain('/home/testperson');
  });

  it('leaves a root outside home absolute, and degrades with no server facts', () => {
    expect(composeStartCommand({ ...STATE, root: { path: '/srv/repo' } })).toContain(' /srv/repo ');
    expect(composeStartCommand({})).toBe(
      'phase-console start --allow-writes --allow-run --allow-terminal --allow-agent ' +
        '--allow-accounts --allow-mcp --allow-webhooks' +
        PRO_TAIL,
    );
  });

  /**
   * The card composes the line from CAPABILITIES, and the switches it says the
   * console lacks come from the same array — so one absent entry both drops a
   * flag from a line advertised as "the exact line for this console" AND
   * removes it from what the console lacks. Pinned against the flag surface
   * itself rather than a hand-copied list: an eighth switch parsed by the
   * server fails here until the composer carries it.
   */
  it('carries every --allow-* switch the console state exposes', () => {
    const command = composeStartCommand(STATE);
    const composed = [...command.matchAll(/--allow-[a-z-]+/g)].map(([flag]) => flag).sort();
    const exposed = Object.keys(STATE)
      .filter((key) => /^allow[A-Z]/.test(key))
      .map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
      .sort();
    expect(exposed.length).toBe(SWITCHES);
    expect(composed).toEqual(exposed);
  });

  it('carries every setting the console was started with — remote, ceiling, skills', () => {
    const command = composeStartCommand({
      ...STATE,
      remoteHosts: ['console.tail1234.ts.net'],
      remoteUsers: ['op@github'],
      concurrency: { max: 5 },
      defaultSkills: ['qa', 'design-review'],
    });
    expect(command).toContain('--remote console.tail1234.ts.net');
    expect(command).toContain('--remote-user op@github');
    expect(command).toContain('--max-sessions 5');
    expect(command).toContain('--default-skills qa,design-review');
    // The default ceiling stays unspoken — a plain console composes the plain line.
    expect(composeStartCommand({ ...STATE, concurrency: { max: 3 } })).not.toContain('--max-sessions');
  });
});

describe('portablePath', () => {
  it('double-quotes so $HOME still expands, and quotes awkward paths', () => {
    expect(portablePath('/home/a/code', '/home/a')).toBe('"$HOME/code"');
    expect(portablePath('/home/a', '/home/a')).toBe('"$HOME"');
    expect(portablePath('/tmp/plain', undefined)).toBe('/tmp/plain');
    expect(portablePath('/tmp/with space', undefined)).toBe("'/tmp/with space'");
  });
});

describe('the group', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    server.calls = [];
    server.reads = { '/api/state': STATE };
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  /** The line, once the state has answered — before it, the group draws the degraded fallback. */
  const line = () => screen.findByText(/my-repo/, { selector: 'pre' });

  it('shows the portable command, the platform it is for, and the WSL answer for Windows', async () => {
    renderWithClient(<StartCommandGroup />);
    const pre = await line();
    expect(pre.textContent).toBe(composeStartCommand(STATE));
    expect(pre.textContent).toContain('"$HOME/code/my-repo"');
    expect(pre.textContent).toContain('--allow-accounts');
    expect(document.body.textContent).not.toContain('/home/testperson');
    expect(screen.getByText(/On macOS, run it in a terminal/)).toBeInTheDocument();
    expect(screen.getByText(/On Linux the same line works/)).toBeInTheDocument();
    expect(screen.getByText(/On Windows, Phase Console runs inside WSL/)).toHaveTextContent(/WSL shell/);
    expect(screen.getByText('cmd.exe')).toBeInTheDocument();
  });

  it('names every switch it composes, in the words the console uses for them', async () => {
    renderWithClient(<StartCommandGroup />);
    await line();
    const said = screen.getByText(/every switch it composes/);
    for (const [, , label] of CAPABILITIES) expect(said).toHaveTextContent(label);
  });

  it('names the switches the running console lacks — mcp included — and why the line matters', async () => {
    renderWithClient(<StartCommandGroup />);
    await line();
    const missing = screen.getByTestId('start-command-missing');
    // The running console lacks terminal, agent, accounts, mcp and webhooks (and, in Pro, issues).
    expect(missing).toHaveTextContent(/^This console runs without terminal, agent, accounts, mcp/);
    expect(missing).toHaveTextContent('the command changes nothing until the console restarts with it');
    expect(missing).not.toHaveTextContent('writes');
  });

  it('says so when the console already runs with every capability', async () => {
    server.reads['/api/state'] = {
      ...STATE,
      ...Object.fromEntries(CAPABILITIES.map(([key]) => [key, true])),
    };
    renderWithClient(<StartCommandGroup />);
    expect(await screen.findByTestId('start-command-missing')).toHaveTextContent(
      'This console already runs with every capability.',
    );
  });

  it('names the platform it cannot name as this machine, and Linux as Linux', async () => {
    server.reads['/api/state'] = { ...STATE, platform: 'linux' };
    renderWithClient(<StartCommandGroup />);
    await line();
    expect(screen.getByText(/On Linux, run it in a terminal/)).toBeInTheDocument();
    expect(screen.getByText(/On macOS the same line works/)).toBeInTheDocument();
  });

  it('copies exactly the line on screen', async () => {
    renderWithClient(<StartCommandGroup />);
    await line();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(composeStartCommand(STATE)));
    expect(await screen.findByRole('button', { name: 'Copied the command' })).toBeInTheDocument();
  });

  it('says which flags it leaves out on purpose, and where they are explained', async () => {
    renderWithClient(<StartCommandGroup />);
    await line();
    const leftOut = screen.getByTestId('start-command-left-out');
    expect(leftOut).toHaveTextContent('These flags are deliberately not composed: --host');
    expect(leftOut).toHaveTextContent('--scripts and --log-file');
    expect(leftOut).toHaveTextContent('the guide’s reference table covers them.');
  });

  it('writes no middle-dot string and no WORD — fragment label', async () => {
    const { container } = renderWithClient(<StartCommandGroup />);
    await line();
    expect(container.textContent).not.toContain('·');
    expect(container.textContent).not.toMatch(/macOS —|Windows:/);
  });
});
