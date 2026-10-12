/**
 * Settings ▸ This instance ▸ Reach (quiet-console phase 22): this console from
 * a phone — ported from the 6.x Tailscale card’s test.
 *
 * What is worth pinning is not the layout, it is the diagnosis. Reach is two
 * settings in two systems agreeing — what Tailscale publishes, and what
 * `--remote` and `--remote-user` say this console answers to and for whom —
 * and both halves look correct from the machine you are sitting at. So the
 * cases are mostly the disagreements: served but not flagged (every request
 * 421s), flagged but not served (the address never resolves), and the two
 * naming different hosts. Each is named with its symptom, because each reads
 * on the phone as "the console is broken" and none of them is.
 *
 * And the group writes nothing. The serve and the flags are the machine’s: it
 * shows them, with the commands that change them, and its one request is the
 * read of Tailscale’s status (`GET /api/tailscale`).
 *
 * Every host name here is invented — `alpha`, `example.ts.net`. Writing the
 * real ones down in order to assert about them would be the leak the scrub
 * hunts.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import type {
  ServeCommand,
  ServeOccupant,
  TailscaleDevice,
  TailscaleServe,
  TailscaleStatus,
} from '@/data/api';
import { ApiError } from '@/data/http';
import { expectNoAxeViolations } from '@/test/axe';
import {
  DEFAULT_CONSOLE_PORT,
  ReachGroup,
  httpsPortFor,
  occupantWords,
  serveCommandFor,
  servedPort,
} from './reach';
import { renderWithClient } from './test-kit';

/** The clock an offline device is dated against. */
const NOW = new Date('2026-10-11T12:00:00Z');

const SELF: TailscaleDevice = {
  hostName: 'alpha',
  dnsName: 'alpha.example.ts.net',
  ips: ['100.64.0.1'],
  os: 'macOS',
  online: true,
};

const PEERS: TailscaleDevice[] = [
  { hostName: 'beta', dnsName: 'beta.example.ts.net', ips: ['100.64.0.2'], os: 'iOS', online: true },
  {
    hostName: 'gamma',
    dnsName: 'gamma.example.ts.net',
    ips: ['100.64.0.3'],
    os: 'windows',
    online: false,
    lastSeen: '2026-10-08T12:00:00Z',
  },
];

type Running = Extract<TailscaleStatus, { state: 'running' }>;

/** A running tailnet publishing `serve`, its other facts as the server reads them off the CLI. */
function running(serve: TailscaleServe, over: Partial<Running> = {}): Running {
  return {
    state: 'running',
    tailnet: 'alpha@example.com',
    magicDns: true,
    magicDnsSuffix: 'example.ts.net',
    self: SELF,
    peers: PEERS,
    serve,
    ...over,
  };
}

/** Serve pointed at this console, as a server that read the whole table reports it. */
const SERVING_US: TailscaleServe = {
  active: true,
  forOurPort: true,
  url: 'https://alpha.example.ts.net',
  targetPort: 4123,
  handlers: [{ host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: 4123, ours: true }],
  command: null,
};

/** A sibling console on this machine, named the way the server names a handler’s occupant. */
const DELTA: ServeOccupant = { port: 4130, id: 'aaaaaaaa-delta', name: 'delta', liveness: 'running' };

/** The default console’s own command, when nothing live stands in its way. */
const NATURAL: ServeCommand = {
  httpsPort: 443,
  text: 'tailscale serve --bg --https=443 http://127.0.0.1:4123',
  displaces: null,
};

/** The command the server offers the default console while the live `delta` holds 443. */
const AROUND_DELTA: ServeCommand = {
  httpsPort: 8123,
  text: 'tailscale serve --bg --https=8123 http://127.0.0.1:4123',
  displaces: { httpsPort: 443, occupant: DELTA },
};

/** 443 held by `occupant`, as the server reports it to the console on 4123. */
function heldBy(occupant: ServeOccupant, command: ServeCommand | null): TailscaleServe {
  return {
    active: true,
    forOurPort: false,
    targetPort: occupant.port,
    occupant,
    handlers: [
      {
        host: 'alpha.example.ts.net',
        httpsPort: 443,
        path: '/',
        targetPort: occupant.port,
        ours: false,
        occupant,
      },
    ],
    command,
  };
}

/** The line that restarts a console onto its host name — printed whatever Tailscale serves. */
const RESTART =
  'bash <skill>/start --root <repo> [existing flags] \\\n  --remote <name>.<tailnet>.ts.net --remote-user <your login>';

/** Every line printed after the serve command: the restart, and in Pro the login agent’s too. */
const AFTER_SERVE: string[] = [RESTART];

/** What `GET /api/tailscale` answers in this case: a status, an Error to throw, or a pending read. */
function tailscale(answer: TailscaleStatus | Error | (() => Promise<unknown>)) {
  server.reads['/api/tailscale'] = answer;
}

function mount(props: Partial<Parameters<typeof ReachGroup>[0]> = {}) {
  return renderWithClient(<ReachGroup port={4123} {...props} />);
}

/** Tailscale has answered, running: the tailnet’s facts are drawn. */
const settled = () => screen.findByText('Tailnet', { selector: 'dt' });

/** One fact’s value, by its label — the `<dd>` beside its `<dt>`. */
function fact(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

/**
 * The banners, as text. Scoped to `role="status"` on purpose: a fact or a
 * command can carry the same words, and only a banner is a warning.
 */
const banners = () => screen.queryAllByRole('status').map((node) => node.textContent ?? '');

/** The command blocks, exactly as printed, in order — inside the group, never the prompt that repeats them. */
function printed(): string[] {
  const group = screen.getByRole('group', { name: 'Setup commands' });
  return [...group.querySelectorAll('pre')].map((pre) => pre.textContent ?? '');
}

beforeEach(() => {
  // Only the date is fixed — every timer stays real — so "last seen" reads the same on any day.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  server.calls = [];
  server.reads = { '/api/tailscale': running(SERVING_US) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what is true now', () => {
  it('names the tailnet, what it serves, the host this console answers to and the logins it lets in', async () => {
    // A login distinct from the tailnet name: in real life they are often the
    // same string, and a fixture that reuses it cannot tell the two rows apart.
    mount({ remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    await settled();
    expect(fact('Tailnet').textContent).toBe('alpha@example.com');
    expect(within(fact('MagicDNS')).getByText('On')).toBeInTheDocument();
    expect(within(fact('MagicDNS')).getByText('example.ts.net').tagName).toBe('CODE');
    expect(fact('Serving').textContent).toBe('This console, on 443');
    const hosts = within(screen.getByTestId('remote-hosts'));
    expect(hosts.getByText('alpha.example.ts.net').tagName).toBe('CODE');
    expect(hosts.getByText('from --remote')).toBeInTheDocument();
    const users = within(screen.getByTestId('remote-users'));
    expect(users.getByText('owner@example.com').tagName).toBe('CODE');
    expect(users.getByText('from --remote-user')).toBeInTheDocument();
  });

  it('names MagicDNS being off by its symptom', async () => {
    tailscale(running(SERVING_US, { magicDns: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('MagicDNS').textContent).toBe('Off — device names will not resolve');
  });

  it('lists every device, marking this machine and dating an offline one', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const list = await screen.findByRole('list', { name: 'Devices on this tailnet' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['alphathis machinemacOSOnline', 'betaiOSOnline', 'gammawindowsOfflinelast seen 3 days ago']);
    // A device is drawn by its short name; its whole tailnet name is a hover away.
    expect(within(list).getByText('alpha')).toHaveAttribute('title', 'alpha.example.ts.net');
  });

  it('says so when this machine is the only device on the tailnet', async () => {
    tailscale(running(SERVING_US, { peers: [] }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const list = await screen.findByRole('list', { name: 'Devices on this tailnet' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText(/^Nothing else is signed in to this tailnet yet\./)).toBeInTheDocument();
  });

  it('never leaves online and offline separated by colour alone', async () => {
    // WCAG 1.4.1: each state is a word with a glyph of its own beside it, so
    // no reader depends on a hue to tell them apart.
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const list = await screen.findByRole('list', { name: 'Devices on this tailnet' });
    const glyph = (word: string) => within(list).getAllByText(word)[0]!.querySelector('svg');
    expect(glyph('Online')).not.toBeNull();
    expect(glyph('Offline')).not.toBeNull();
    expect(glyph('Offline')!.outerHTML).not.toBe(glyph('Online')!.outerHTML);
  });

  it('offers the reachable address when both halves agree, and names it in the device steps', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const link = await screen.findByRole('link', { name: 'https://alpha.example.ts.net' });
    expect(link).toHaveAttribute('href', 'https://alpha.example.ts.net');
    expect(screen.getByTestId('reach-open')).toHaveTextContent(
      'Open https://alpha.example.ts.net on any device signed in to this tailnet.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Setting up a device' }));
    expect(screen.getByText(/^Open/, { selector: 'li' })).toHaveTextContent(
      'Open https://alpha.example.ts.net.',
    );
  });

  it('has no axe violation, with the address offered and the device steps open', async () => {
    const { container } = mount({
      remoteHosts: ['alpha.example.ts.net'],
      remoteUsers: ['owner@example.com'],
    });
    await screen.findByTestId('reach-open');
    fireEvent.click(screen.getByRole('button', { name: 'First time on a tailnet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Setting up a device' }));
    await expectNoAxeViolations(container);
  });
});

describe('the disagreements, each named with its symptom', () => {
  it('serving with no --remote flag is called out as a 421, and the facts say it answers only here', async () => {
    // The address resolves and every request is refused. From this machine
    // everything looks configured.
    mount({ remoteHosts: [], remoteUsers: [] });
    await settled();
    expect(screen.getByTestId('reach-mismatch')).toHaveTextContent(
      'Tailscale publishes this console, but it was started without --remote, so every request through that address is refused with a 421. Restart it with the host name below.',
    );
    expect(fact('Answers to').textContent).toBe('Only this machine — started without --remote');
    expect(fact('Allowed logins').textContent).toBe('None — the console is local-only');
    expect(screen.queryByRole('link', { name: /https:/ })).toBeNull();
  });

  it('flagged but not served is called out as an address that will not resolve', async () => {
    tailscale(running({ active: false, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('Serving').textContent).toBe('Nothing');
    expect(screen.getByTestId('reach-mismatch')).toHaveTextContent(
      'This console answers to alpha.example.ts.net, but nothing is served on 443 for it — the address will not resolve. Run the serve command below.',
    );
  });

  it('serving another console is not reported as “not serving” — and that console is named', async () => {
    // Distinct states with distinct fixes: collapsing them would tell someone
    // to re-run a serve command that is already running. “Something else” was
    // the old answer, and it could not say whose phone the fix would take.
    tailscale(running(heldBy({ ...DELTA, liveness: 'stopped' }, NATURAL)));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('Serving').textContent).toBe('delta, on port 4130');
    expect(screen.queryByText(/something else/)).toBeNull();
  });

  it('a port no registered console claims is named by its port', async () => {
    tailscale(running(heldBy({ port: 9999 }, NATURAL)));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('Serving').textContent).toBe('port 9999 — a program no console on this machine knows');
  });

  it('a server too old to name the occupant still never says “something else”', async () => {
    tailscale(running({ active: true, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('Serving').textContent).toBe('another port — this server is too old to say which');
    expect(screen.queryByText(/something else/)).toBeNull();
  });

  it('names whoever Tailscale publishes instead, as exactly as the server can say', () => {
    expect(occupantWords(heldBy(DELTA, NATURAL))).toBe('delta, on port 4130');
    expect(occupantWords(heldBy({ port: 9999 }, NATURAL))).toBe(
      'port 9999 — a program no console on this machine knows',
    );
    // A handler that forwards somewhere other than a port here (`targetPort: null`).
    expect(
      occupantWords({
        active: true,
        forOurPort: false,
        handlers: [
          { host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: null, ours: false },
        ],
      }),
    ).toBe('a handler that does not forward to a port on this machine');
    expect(occupantWords({ active: true, forOurPort: false })).toBe(
      'another port — this server is too old to say which',
    );
  });

  it('two halves naming different hosts is its own warning, and the refused address is not offered', async () => {
    mount({ remoteHosts: ['beta.example.ts.net'] });
    await settled();
    expect(screen.getByTestId('reach-mismatch')).toHaveTextContent(
      'Tailscale serves alpha.example.ts.net, but this console answers only to beta.example.ts.net, so a request that arrives as alpha.example.ts.net is refused. Restart it with that host name.',
    );
    // Every request to that address is refused, so an “Open it” beside the warning would contradict it.
    expect(screen.queryByTestId('reach-open')).toBeNull();
    expect(screen.queryByRole('link', { name: /https:/ })).toBeNull();
  });

  it('says nothing about flags a server too old to report them cannot answer for', async () => {
    // Absent means “this server cannot say” (`ConsoleState`) — guessing “none”
    // would accuse a correctly configured console of being misconfigured.
    mount({});
    await settled();
    expect(banners()).toEqual([]);
    expect(fact('Answers to').textContent).toBe('This server is too old to say');
    expect(fact('Allowed logins').textContent).toBe('This server is too old to say');
  });
});

describe('the degenerate machines', () => {
  it('explains what Tailscale is for when it is not installed, and invents no device or command', async () => {
    tailscale({ state: 'not-installed' });
    mount({});
    const missing = await screen.findByTestId('tailscale-missing');
    expect(missing).toHaveTextContent(
      'Tailscale is not installed on this machine. It is the supported way to reach this console from another device',
    );
    expect(within(missing).getByText('tailscale.com/download').tagName).toBe('CODE');
    expect(screen.queryByRole('list', { name: 'Devices on this tailnet' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Setup commands' })).toBeNull();
  });

  it('repeats the CLI’s own word for a daemon that is not running, and judges no flag', async () => {
    tailscale({ state: 'installed-not-running', detail: 'NeedsLogin' });
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByTestId('tailscale-stopped')).toHaveTextContent(
      'Tailscale is installed but not running: NeedsLogin.',
    );
    expect(banners()).toEqual(['Tailscale is installed but not running: NeedsLogin.']);
  });

  it('asks Tailscale before it says anything — a placeholder, never a verdict', () => {
    tailscale(() => new Promise(() => {}));
    const { container } = mount({});
    expect(container.querySelector('[aria-label="Asking Tailscale"]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/cannot report on Tailscale/)).toBeNull();
  });

  it('a server that cannot report at all says so instead of rendering blanks', async () => {
    // A server older than the route answers it 404.
    tailscale(new ApiError('Not found', 404, '/api/tailscale'));
    mount({});
    expect(
      await screen.findByText(
        'This server cannot report on Tailscale — it started before reach existed. Restart it to ask.',
      ),
    ).toBeInTheDocument();
  });
});

describe('the commands it prints', () => {
  it('embeds the console’s real port, not a hard-coded 4123', async () => {
    // Publishing the wrong port produces a 502 that reads as a Tailscale fault.
    tailscale(running({ active: false, forOurPort: false }));
    mount({ port: 5000, remoteHosts: [] });
    await settled();
    expect(printed()).toEqual(['tailscale serve --bg --https=9000 http://127.0.0.1:5000', ...AFTER_SERVE]);
  });

  it('drops the serve command once serve is already pointed here, and keeps the restart line', async () => {
    // Flags change more often than the serve does, so the line that re-points
    // the console at its host name stays.
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(printed()).toEqual(AFTER_SERVE);
  });
});

describe('a second console on one machine', () => {
  // One machine runs one console per project, and `tailscale serve` has one
  // 443. Suggesting 443 for every console had the second one take the first
  // one’s address over: the phone then reached whichever ran the command last,
  // and the other refused with a 421.
  it('keeps 443 for the default port and derives a port of its own for every other console', () => {
    // The fallback copy for a server that sends no `serve.command`: the same
    // rows `viewer/test/tailscale.test.ts` pins on the server’s `httpsPortFor`.
    expect(DEFAULT_CONSOLE_PORT).toBe(4123);
    expect(httpsPortFor(4123)).toBe(443);
    expect(httpsPortFor(4130)).toBe(8130);
    expect(httpsPortFor(5000)).toBe(9000);
  });

  it('reads the port an address is served on — 443 when it names none', () => {
    expect(servedPort('https://alpha.example.ts.net')).toBe(443);
    expect(servedPort('https://alpha.example.ts.net:8130')).toBe(8130);
    expect(servedPort(undefined)).toBeUndefined();
    expect(servedPort('not an address')).toBeUndefined();
  });

  it('prints the server’s command whenever it sent one, and derives one only for a server that sent none', () => {
    // The server read the whole Serve table: its answer stands even where the derived one would differ.
    expect(serveCommandFor(heldBy(DELTA, AROUND_DELTA), 4123)).toBe(AROUND_DELTA);
    // The derived command is the one the server’s `serveCommandFor(4130, [])` answers.
    expect(serveCommandFor({ active: false, forOurPort: false }, 4130)).toEqual({
      httpsPort: 8130,
      text: 'tailscale serve --bg --https=8130 http://127.0.0.1:4130',
      displaces: null,
    });
    expect(serveCommandFor({ active: true, forOurPort: true }, 4130)).toBeNull();
  });

  it('suggests the derived port in the serve command', async () => {
    tailscale(running({ active: false, forOurPort: false }));
    mount({ port: 4130, remoteHosts: [] });
    await settled();
    expect(printed()).toEqual(['tailscale serve --bg --https=8130 http://127.0.0.1:4130', ...AFTER_SERVE]);
  });

  it('reads an address that carries a port as served, on that port, by the right host', async () => {
    tailscale(running({ active: true, forOurPort: true, url: 'https://alpha.example.ts.net:8130' }));
    mount({ port: 4130, remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    await settled();
    expect(fact('Serving').textContent).toBe('This console, on 8130');
    // The host name is what `--remote` matches; the port must not read as a
    // different host, which would raise a mismatch over a working setup.
    expect(screen.queryByTestId('reach-mismatch')).toBeNull();
    expect(screen.getByRole('link', { name: 'https://alpha.example.ts.net:8130' })).toBeInTheDocument();
  });

  it('names the derived port when nothing is served for a flagged console', async () => {
    tailscale(running({ active: true, forOurPort: false }));
    mount({ port: 4130, remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(screen.getByTestId('reach-mismatch')).toHaveTextContent('nothing is served on 8130 for it');
  });

  it('names the live console holding 443, refuses to print the command that would displace it, and offers the port that leaves it alone', async () => {
    // The real shape of the finding: a sibling holds 443, and the default
    // console’s natural command is exactly the line that takes its phone.
    tailscale(running(heldBy(DELTA, AROUND_DELTA)));
    mount({ port: 4123, remoteHosts: ['alpha.example.ts.net'] });
    await settled();
    expect(fact('Serving').textContent).toBe('delta, on port 4130');
    // The server’s command is printed as sent; the displacing one is not.
    expect(printed()).toEqual([AROUND_DELTA.text, ...AFTER_SERVE]);
    expect(screen.getByTestId('serve-displaces')).toHaveTextContent(
      '443 is held by the live console delta (port 4130) — publishing this console there would take the phone away from it. The command below publishes on 8123 instead, which leaves it alone.',
    );
    // And the flagged-but-unserved warning names the port that command publishes on.
    expect(screen.getByTestId('reach-mismatch')).toHaveTextContent('nothing is served on 8123 for it');
  });

  it('prints the natural command, with no refusal, when the console holding 443 is not running', async () => {
    tailscale(running(heldBy({ ...DELTA, liveness: 'stopped' }, NATURAL)));
    mount({ port: 4123, remoteHosts: [] });
    await settled();
    expect(fact('Serving').textContent).toBe('delta, on port 4130');
    expect(printed()).toEqual([NATURAL.text, ...AFTER_SERVE]);
    expect(screen.queryByTestId('serve-displaces')).toBeNull();
  });
});

describe('what it sends', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reads Tailscale’s status and writes nothing — a copy hands over exactly the line on screen', async () => {
    tailscale(running(heldBy(DELTA, AROUND_DELTA)));
    mount({ remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    await settled();
    const copies = screen.getAllByRole('button', { name: /^Copy/ });
    for (const button of copies) fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(copies.length),
    );
    const prompt = SETUP_PROMPTS.find((one) => one.id === 'tailscale')!.prompt;
    expect(writeText.mock.calls.map(([text]) => text)).toEqual([prompt, AROUND_DELTA.text, ...AFTER_SERVE]);
    // Every fold opened too: the steps and the prompt are words to read, never a request.
    for (const name of [
      'First time on a tailnet',
      'Setting up a device',
      'Have Claude set this up instead',
    ]) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect([...document.querySelectorAll('pre')].map((pre) => pre.textContent)).toContain(prompt);
    expect(new Set(server.calls.map((call) => `${call.method} ${call.path}`))).toEqual(
      new Set(['GET /api/tailscale']),
    );
  });
});

