/**
 * Settings ▸ This instance (quiet-console phase 23): which console is serving
 * this page, how to replace or stop it, how it was started and reached, what
 * it keeps — and the machine profile every console on the machine reads.
 *
 * The section reads `/api/state` before it says anything, then draws its
 * groups in the order the questions arrive, the off switch last. What stands
 * in front of the process — a server older than its files, a held boot, a
 * crash loop, a skill at another commit — is said above them all, each with
 * the one press or the one line that moves it. The machine profile is read
 * here and written nowhere: every field is a reading with its command line.
 *
 * Every group's route is fixtured: the section opens on reads alone, and a
 * route a server does not have leaves its own group saying so.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_WORDS } from '@shared/capability-model.js';
import { PROFILE_META } from '@shared/prefs-model.js';
import type {
  ConsoleState,
  FleetProfileView,
  RestartReadiness,
  RetentionReport,
  ShutdownReadiness,
  SkillCopyView,
} from '@/data/api';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { InstanceSection, profileTakeWords } from './instance';
import { ProcessBanners, ProcessGroup, interfaceWords } from './process';
import { UnitGroup } from './unit';

/** The clock every case reads — "2 hours ago" is a fact about it. */
const NOW = '2026-10-12T10:00:00.000Z';

const STATE: ConsoleState = {
  instance: { id: 'aaaaaaaa-alpha', name: 'alpha', pinned: false },
  port: 4123,
  home: '/home/x',
  allowRun: true,
  allowWrites: true,
  allowMcp: true,
  serverStale: false,
  bootedAt: '2026-10-12T08:00:00.000Z',
  staticRoot: 'dist',
  supervisor: {
    kind: 'launchd',
    detail: 'launchd, KeepAlive: a clean exit comes straight back',
    supervised: true,
  },
  execArgv: ['--max-old-space-size=6144'],
  remoteHosts: [],
  remoteUsers: [],
};

const SESSIONS = { live: 0, agent: 0, terminal: 0, ended: 0, sessions: [], survives: true };

const RESTART: RestartReadiness = {
  ok: true,
  supervisor: { kind: 'launchd', detail: 'launchd (com.phase-console)', supervised: true },
  busy: false,
  run: null,
  sessions: SESSIONS,
};

const SHUTDOWN: ShutdownReadiness = {
  supervisor: { kind: 'launchd', detail: 'launchd (com.phase-console)', supervised: true },
  stop: { via: 'exit', mode: 'exit', durability: 'returns', detail: 'It exits and launchd starts it again' },
  modes: {
    exit: {
      via: 'exit',
      mode: 'exit',
      durability: 'returns',
      detail: 'It exits and launchd starts it again',
    },
    unload: null,
  },
  inventory: {
    lanes: [],
    clocks: [],
    runs: [],
    liveSessions: [],
    pendingApprovals: [],
    inboxDepth: { sessions: 0, outcomes: 0 },
  },
  busy: false,
  run: null,
  sessions: SESSIONS,
  restartHint: 'bash start --root /home/x/repo',
};

const RETENTION: RetentionReport = {
  at: NOW,
  policy: {},
  sinks: [{ sink: 'run-records', files: 3, bytes: 2048, due: 0 }],
  bytes: 2048,
  actions: [],
};

/** What this console takes from the machine profile: it starts at the next login only, and keeps its own maxSessions. */
const PROFILE: FleetProfileView = {
  profile: { maxSessions: 8, remoteHost: 'alpha.example.ts.net' },
  console: {
    id: 'aaaaaaaa-alpha',
    name: 'alpha',
    remoteHosts: [],
    remoteUsers: [],
    notifyCommand: false,
    maxSessions: 6,
    machineMaxSessions: 8,
    autostart: 'once',
    overridden: ['maxSessions'],
  },
};

const SCHEMA = schemaAnswer({
  'profile.maxSessions': { value: 6, source: 'profile' },
  'profile.remoteHost': { value: 'alpha.example.ts.net', source: 'profile' },
});

/** The skill each config dir's sessions load: one at the console's commit, one behind it. */
const OWN_COMMIT = 'af1cadb343f7aaaabbbbccccddddeeeeffff0000';
const SKILL_DRIFT: SkillCopyView = {
  plugin: 'phased-execution',
  consoleRev: OWN_COMMIT,
  copies: [
    {
      configDir: '/home/x/.claude',
      install: {
        id: 'phased-execution@market',
        scope: 'user',
        installPath: '/home/x/p',
        version: '6.2.1',
        commit: OWN_COMMIT,
      },
      skillDir: null,
    },
    {
      configDir: '/home/x/.claude-b',
      install: {
        id: 'phased-execution@market',
        scope: 'user',
        installPath: '/home/x/q',
        version: '6.2.0',
        commit: 'cfafc8cc11112222333344445555666677778888',
      },
      skillDir: null,
    },
  ],
  drift: [],
  update: 'claude plugin update phased-execution@market',
};
SKILL_DRIFT.drift = [SKILL_DRIFT.copies[1]!];

const releases = () => sent(server, 'POST', '/api/automation/hold/release');
const region = (name: string) => screen.getByRole('region', { name });
/** A fact of This process, by its label — the `<dd>` beside its `<dt>`. */
const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  server.calls = [];
  server.reads = {
    '/api/state': STATE,
    '/api/restart': RESTART,
    '/api/tailscale': { state: 'not-installed' },
    '/api/debug/retention': RETENTION,
    '/api/prefs/schema': SCHEMA,
    '/api/fleet/profile': PROFILE,
    '/api/shutdown': SHUTDOWN,
    'POST /api/automation/hold/release': { ok: true, bootHold: null },
  };
  toast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the section', () => {
  it('reads this console first — a placeholder marked busy, never a guess', () => {
    server.reads['/api/state'] = () => new Promise(() => {});
    const { container } = renderWithClient(<InstanceSection />);
    expect(container.querySelector('[aria-label="Reading this console"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByTestId('instance-settings')).toBeNull();
    expect(screen.queryAllByRole('heading')).toEqual([]);
  });

  it('draws its groups in the order the questions arrive, the off switch last, and opens on reads alone', async () => {
    renderWithClient(<InstanceSection />);
    await screen.findByRole('button', { name: 'Shut down' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'This process',
      'Restart',
      'What this console was started with',
      'Reach this console from your phone',
      'Logs and retention',
      'The machine profile',
      'Shut down',
    ]);
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-settings-group]')].map(
        (node) => node.dataset.settingsGroup,
      ),
    ).toEqual(['process', 'restart', 'launch-unit', 'reach', 'retention', 'machine-profile', 'shutdown']);
    // Each group answered from its own route — and nothing was written to open them.
    expect(await within(region('Logs and retention')).findByRole('status')).toHaveTextContent(
      '2.0 KB across 1 sink. Nothing is due for the next sweep.',
    );
    expect(await screen.findByTestId('tailscale-missing')).toBeInTheDocument();
    expect(new Set(server.calls.map((call) => `${call.method} ${call.path}`))).toEqual(
      new Set([
        'GET /api/state',
        'GET /api/restart',
        'GET /api/tailscale',
        'GET /api/debug/retention',
        'GET /api/prefs/schema',
        'GET /api/fleet/profile',
        'GET /api/shutdown',
      ]),
    );
  });

  it('a route this server does not have leaves its own group saying so, and every group still stands', async () => {
    delete server.reads['/api/fleet/profile'];
    server.reads['/api/debug/retention'] = new ApiError('Not found', 404, '/api/debug/retention');
    renderWithClient(<InstanceSection />);
    expect(await screen.findByTestId('retention-report')).toHaveTextContent(
      'The console did not say what it keeps: Not found. The keys below still save.',
    );
    await screen.findByRole('button', { name: 'Shut down' });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(7);
    // No profile answer: the rows are the schema's, and the sentence about this console is not guessed.
    const profile = await screen.findByTestId('machine-profile');
    expect(profile.querySelectorAll('[data-key]')).toHaveLength(Object.keys(PROFILE_META).length);
    expect(screen.queryByTestId('profile-take')).toBeNull();
  });
});

describe('the machine profile', () => {
  it('says what this console takes from it, in one sentence', () => {
    const view = (autostart: boolean | 'once', overridden: string[]) => ({
      ...PROFILE.console,
      autostart,
      overridden,
    });
    expect(profileTakeWords(view(true, []))).toBe(
      'This console starts at login, and takes every other field from the profile.',
    );
    expect(profileTakeWords(view('once', ['maxSessions']))).toBe(
      'This console starts at the next login only, and overrides the profile’s maxSessions with its own.',
    );
    expect(profileTakeWords(view(false, ['remoteHosts', 'remoteUsers', 'maxSessions']))).toBe(
      'This console does not start at login, and overrides the profile’s remoteHosts, remoteUsers and maxSessions with its own.',
    );
  });

  it('draws every field read-only, its value and source, each with the line that changes it', async () => {
    renderWithClient(<InstanceSection />);
    const group = await screen.findByTestId('machine-profile');
    expect(await within(group).findByTestId('profile-take')).toHaveTextContent(
      'This console starts at the next login only, and overrides the profile’s maxSessions with its own.',
    );
    const rows = [...group.querySelectorAll<HTMLElement>('[data-key]')];
    expect(rows.map((row) => row.dataset.key)).toEqual(
      Object.keys(PROFILE_META).map((key) => `profile.${key}`),
    );
    for (const row of rows) {
      const key = row.dataset.key!.slice('profile.'.length);
      expect(
        within(row).getByRole('button', { name: `phase-console profile set ${key} <json>` }),
      ).toBeInTheDocument();
    }
    const of = (key: string) => group.querySelector<HTMLElement>(`[data-key="profile.${key}"]`)!;
    expect(of('maxSessions')).toHaveTextContent('6');
    expect(of('maxSessions')).toHaveTextContent('Set by the machine profile');
    expect(of('remoteHost')).toHaveTextContent('alpha.example.ts.net');
    expect(of('heapMb')).toHaveTextContent('Not set');
    expect(of('heapMb')).not.toHaveTextContent('Set by the machine profile');
    // No page writes a field: nothing to type in, tick, pick or reset.
    for (const role of ['textbox', 'spinbutton', 'checkbox', 'combobox'] as const) {
      expect(within(group).queryAllByRole(role)).toEqual([]);
    }
    expect(within(group).queryByRole('button', { name: /^Reset/ })).toBeNull();
    expect(
      within(region('The machine profile')).getByRole('link', {
        name: 'Everything lists them with every other key',
      }),
    ).toHaveAttribute('href', '#/settings/everything?q=profile');
    expect(sent(server, 'POST', '/api/prefs')).toEqual([]);
  });
});

describe('what stands in front of this process', () => {
  it('a server older than its files is said above every group, and This process says restart it', async () => {
    server.reads['/api/state'] = { ...STATE, serverStale: true };
    renderWithClient(<InstanceSection />);
    const banner = await screen.findByText(
      'The server files on disk are newer than this process. Restart it, below, to run them.',
    );
    expect(banner.closest('[role="status"]')).toHaveAttribute('data-severity', 'warn');
    expect(
      banner.compareDocumentPosition(region('This process')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(fact('Server code')).toHaveTextContent('Older than what is on disk — restart it');
  });

  it('a boot held on purpose says why, and its one press releases it — or names the flag that would', async () => {
    const hold = {
      kind: 'stopped' as const,
      at: NOW,
      by: 'operator',
      why: 'Shut down with Stay off on 12 October.',
    };
    const { unmount } = renderWithClient(<ProcessBanners state={{ ...STATE, bootHold: hold }} />);
    const banner = screen.getByTestId('boot-hold');
    expect(banner).toHaveTextContent(
      'Stopped on purpose — automation is held. Shut down with Stay off on 12 October.',
    );
    fireEvent.click(within(banner).getByRole('button', { name: 'Clear the stop and resume' }));
    await waitFor(() => expect(releases()).toEqual([{}]));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Released — this console re-adopts and converges its runs now.',
        'ok',
      ),
    );
    unmount();

    renderWithClient(
      <ProcessBanners
        state={{
          ...STATE,
          allowRun: false,
          bootHold: {
            ...hold,
            kind: 'autostart-off',
            why: 'The machine profile says this console starts its work by hand.',
          },
        }}
      />,
    );
    const held = screen.getByTestId('boot-hold');
    expect(held).toHaveTextContent(
      'Automation is held at boot. The machine profile says this console starts its work by hand.',
    );
    expect(held).toHaveTextContent('Releasing it starts work, which needs --allow-run.');
    expect(within(held).queryByRole('button')).toBeNull();
  });

  it('a crash loop is drawn as a stop, with the release that lifts it', async () => {
    renderWithClient(
      <ProcessBanners
        state={{
          ...STATE,
          bootHold: {
            kind: 'crash-loop',
            at: NOW,
            by: 'console',
            why: 'It ended hard 4 times in 10 minutes.',
          },
        }}
      />,
    );
    const card = screen.getByTestId('crash-loop');
    expect(card).toHaveTextContent('This console keeps ending hard, so it holds its automation.');
    expect(card).toHaveTextContent('It ended hard 4 times in 10 minutes.');
    expect(screen.queryByTestId('boot-hold')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Release it for this boot' }));
    await waitFor(() => expect(releases()).toEqual([{}]));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Released — this console re-adopts and converges its runs now.',
        'ok',
      ),
    );
  });

  it('a skill at another commit is named, with the line that moves it, and the Skill row says which copy', () => {
    const state = { ...STATE, skillCopy: SKILL_DRIFT };
    renderWithClient(
      <>
        <ProcessBanners state={state} />
        <ProcessGroup state={state} />
      </>,
    );
    expect(screen.getByTestId('skill-drift')).toHaveTextContent(
      'The skill sessions read is at another commit than this console, so they follow a procedure its scripts no longer match: ~/.claude-b. Move it to this console with claude plugin update phased-execution@market — open sessions pick it up on /reload-plugins or a restart.',
    );
    expect(fact('Skill')).toHaveTextContent(
      'phased-execution at af1cadb343f7 in ~/.claude — the console’s own commit',
    );
    expect(fact('Skill')).toHaveTextContent(
      'phased-execution at cfafc8cc1111 in ~/.claude-b — another commit than this console',
    );
  });

  it('nothing in front of a current process: no banner at all', () => {
    renderWithClient(
      <ProcessBanners state={{ ...STATE, bootHold: null, skillCopy: { ...SKILL_DRIFT, drift: [] } }} />,
    );
    expect(screen.queryAllByRole('status')).toEqual([]);
  });
});

describe('This process', () => {
  it('names what serves the page, what supervises it, what node was started with and when', () => {
    renderWithClient(<ProcessGroup state={STATE} />);
    expect(fact('Server code')).toHaveTextContent('Current with what is on disk');
    expect(fact('Serving')).toHaveTextContent('The built client, client/dist');
    expect(fact('Supervisor')).toHaveTextContent('launchd, KeepAlive: a clean exit comes straight back');
    expect(fact('Node')).toHaveTextContent('--max-old-space-size=6144');
    expect(fact('Started')).toHaveTextContent('2 hours ago');
    expect(screen.getByRole('button', { name: 'Get the latest interface' })).toBeEnabled();
  });

  it('says whether this tab runs the build the server serves', () => {
    // Each reading in a container of its own; the tab's own rev is `__BUILD_REV__`, passed here by hand.
    const words = (distRev: string | null, mine: string) =>
      render(<p>{interfaceWords(distRev, mine)}</p>).container;
    expect(words('af1cadb343f7aaaa', 'af1cadb343f7aaaa')).toHaveTextContent(
      'Current with the server’s build af1cadb343f7',
    );
    expect(words('cfafc8cc1111aaaa', 'af1cadb343f7aaaa')).toHaveTextContent(
      'This tab was built from af1cadb343f7; the server now serves cfafc8cc1111 — get the latest interface below',
    );
    expect(words(null, 'af1cadb343f7aaaa')).toHaveTextContent(
      'Unknown — an unstamped build, or a server that predates the report',
    );
    expect(words('af1cadb343f7aaaa', 'unknown')).toHaveTextContent('Unknown — an unstamped build');
  });
});

describe('how it was started', () => {
  it('shows the capability switches this console holds, as words — no command, since no page moves one', () => {
    renderWithClient(<UnitGroup state={STATE} />);
    const group = region('What this console was started with');
    const on = new Set(['--allow-run', '--allow-mcp', '--allow-writes']);
    const switches = within(group).getByRole('list', { name: 'Capability switches' });
    expect(
      within(switches)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(CAPABILITY_WORDS.map((word) => `${on.has(word.flag) ? 'On' : 'Off'}${word.flag}${word.act}`));
    expect(within(group).queryAllByRole('button')).toEqual([]);
    expect(group).toHaveTextContent('Node --max-old-space-size=6144');
    expect(
      within(group).getByRole('link', { name: 'Essentials composes the start command' }),
    ).toHaveAttribute('href', '#/settings/essentials');
  });
});
