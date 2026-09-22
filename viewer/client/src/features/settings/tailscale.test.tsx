/**
 * The card that turns a loopback console into a phone-reachable one.
 *
 * What is worth pinning here is not the layout — it is the *diagnosis*. This
 * feature is two settings in two different systems agreeing with each other,
 * and both halves look correct from the machine you are sitting at. So the
 * cases below are mostly the disagreements: served-but-not-flagged (every
 * request 421s), flagged-but-not-served (the URL never resolves), and the two
 * naming different hosts. Each has to be named, because each reads on the phone
 * as "the console is broken" and none of them is.
 *
 * Every hostname here is invented — `alpha`, `example.ts.net`. Writing the real
 * ones down in order to assert about them would be the leak the scrub hunts.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { ServeOccupant, TailscaleStatus } from '@/lib/api';
import { TailscaleCard, httpsPortFor, servedPort } from './tailscale';

// `vi.hoisted`, because the mock factory is lifted above every top-level const.
const { tailscale } = vi.hoisted(() => ({ tailscale: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, tailscale } };
});

const SELF = {
  hostName: 'alpha',
  dnsName: 'alpha.example.ts.net',
  ips: ['100.64.0.1'],
  os: 'macOS',
  online: true,
};

const PEERS = [
  { hostName: 'beta', dnsName: 'beta.example.ts.net', ips: ['100.64.0.2'], os: 'iOS', online: true },
  {
    hostName: 'gamma',
    dnsName: 'gamma.example.ts.net',
    ips: ['100.64.0.3'],
    os: 'windows',
    online: false,
    lastSeen: '2026-06-01T10:00:00Z',
  },
];

/** The `serve` shape, pulled off the one union member that has one. */
type Serve = Extract<TailscaleStatus, { state: 'running' }>['serve'];

function running(serve: Serve): TailscaleStatus {
  return {
    state: 'running',
    tailnet: 'alpha@example.com',
    magicDns: true,
    magicDnsSuffix: 'example.ts.net',
    self: SELF,
    peers: PEERS,
    serve,
  };
}

/** Serve pointed at this console, as a server that read the whole table reports it. */
const SERVING_US: Serve = {
  active: true,
  forOurPort: true,
  url: 'https://alpha.example.ts.net',
  targetPort: 4123,
  handlers: [{ host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: 4123, ours: true }],
  command: null,
};

/** A sibling console on this machine, named the way the server names a handler's occupant. */
const DELTA: ServeOccupant = { port: 4130, id: 'aaaaaaaa-delta', name: 'delta', liveness: 'running' };

/** The default console's own command, when nothing live stands in its way. */
const NATURAL = {
  httpsPort: 443,
  text: 'tailscale serve --bg --https=443 http://127.0.0.1:4123',
  displaces: null,
};

/** 443 held by `occupant`, as the server reports it to the console on 4123. */
function heldBy(occupant: ServeOccupant, command: Serve['command']): Serve {
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

/**
 * The banners, as text.
 *
 * Scoped to `role="status"` on purpose: the copyable prompt at the bottom of
 * the card explains the same failure modes in prose, so a whole-card text match
 * finds the explanation and reads it as a live warning.
 */
function warnings(): string[] {
  return screen.queryAllByRole('status').map((n) => n.textContent ?? '');
}

/** The command blocks, not the prompt that also contains those commands. */
function commands() {
  return within(screen.getByRole('group', { name: 'Setup commands' }));
}

function mount(props: Partial<Parameters<typeof TailscaleCard>[0]> = {}) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <TailscaleCard port={4123} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tailscale.mockResolvedValue(running(SERVING_US));
});

describe('what is true now', () => {
  it('names the tailnet and reports serving once the probe answers', async () => {
    // A login distinct from the tailnet name: in real life they are often the
    // same string, and a fixture that reuses it cannot tell the two rows apart.
    mount({ remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    expect(await screen.findByText('alpha@example.com')).toBeTruthy();
    expect(screen.getByText('owner@example.com')).toBeTruthy();
    expect(screen.getByText(/this console, on 443/)).toBeTruthy();
  });

  it('lists every device, marking this machine and dating an offline one', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('this machine')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // The offline device is the one where "last seen" earns its place. State
    // is a badge now — the word, an icon and a tone — so the word and the date
    // are two elements rather than one string.
    expect(screen.getByText('offline')).toBeTruthy();
    expect(screen.getByText(/last seen/)).toBeTruthy();
  });

  it('never leaves online and offline separated by colour alone', async () => {
    // WCAG 1.4.1: the two states used to be the same mono text in two hues.
    // Both are badges now, each carrying its own icon beside its own word.
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const offline = await screen.findByText('offline');
    const online = screen.getAllByText('online')[0]!;
    expect(offline.closest('span')?.querySelector('svg')).toBeTruthy();
    expect(online.closest('span')?.querySelector('svg')).toBeTruthy();
  });

  it('offers the reachable URL only when both halves agree', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const link = await screen.findByRole('link', { name: 'https://alpha.example.ts.net' });
    expect(link.getAttribute('href')).toBe('https://alpha.example.ts.net');
  });
});

describe('the disagreements, each named with its symptom', () => {
  it('serving with no --remote flag is called out as a 421', async () => {
    // The URL resolves and every request is refused. From this machine
    // everything looks configured.
    mount({ remoteHosts: [] });
    expect(await screen.findByText(/421/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /https:/ })).toBeNull();
  });

  it('flagged but not served is called out as a URL that will not resolve', async () => {
    tailscale.mockResolvedValue(running({ active: false, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText(/will not resolve/)).toBeTruthy();
  });

  it('serving another console is not reported as "not serving" — and that console is named', async () => {
    // Distinct states with distinct fixes; collapsing them would tell someone
    // to re-run a serve command that is already running. "Something else" was
    // the old answer, and it could not say whose phone the fix would take.
    tailscale.mockResolvedValue(running(heldBy({ ...DELTA, liveness: 'stopped' }, NATURAL)));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText('delta (port 4130)')).toBeTruthy();
    expect(screen.queryByText(/something else/)).toBeNull();
  });

  it('a port no registered console claims is named by its port', async () => {
    tailscale.mockResolvedValue(running(heldBy({ port: 9999 }, NATURAL)));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText('port 9999 — a program no console on this machine knows')).toBeTruthy();
  });

  it('a server too old to name the occupant still never says "something else"', async () => {
    tailscale.mockResolvedValue(running({ active: true, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText('another port — this server is too old to say which')).toBeTruthy();
    expect(screen.queryByText(/something else/)).toBeNull();
  });

  it('two halves naming different hosts is its own warning', async () => {
    mount({ remoteHosts: ['beta.example.ts.net'] });
    expect(await screen.findByText(/only answers to/)).toBeTruthy();
  });

  it('says nothing about flags a server too old to report them cannot answer for', async () => {
    // `remoteHosts` undefined means "this server cannot say" — guessing "none"
    // would accuse a correctly configured console of being misconfigured.
    mount({});
    await screen.findByText('alpha@example.com');
    // Asserted over the banners only: the copyable prompt explains the 421 too,
    // and matching the whole card would find that and call it a warning.
    expect(warnings()).toEqual([]);
  });
});

describe('the degenerate machines', () => {
  it('explains what Tailscale is for when it is not installed', async () => {
    tailscale.mockResolvedValue({ state: 'not-installed' });
    mount({});
    expect(await screen.findByText(/not installed on this machine/)).toBeTruthy();
    // No device table to render, and none invented.
    expect(screen.queryByText('this machine')).toBeNull();
  });

  it("repeats the CLI's own word for a daemon that is not running", async () => {
    tailscale.mockResolvedValue({ state: 'installed-not-running', detail: 'NeedsLogin' });
    mount({});
    expect(await screen.findByText('NeedsLogin')).toBeTruthy();
  });

  it('a server that cannot report at all says so instead of rendering blanks', async () => {
    // An older server 404s this route. The query retries once before it
    // settles, so this waits longer than the default second.
    tailscale.mockRejectedValue(new Error('404'));
    mount({});
    await waitFor(() => expect(screen.getByText(/started before this feature existed/)).toBeTruthy(), {
      timeout: 4000,
    });
  });
});

describe('the commands it prints', () => {
  it("embeds the console's real port, not a hard-coded 4123", async () => {
    tailscale.mockResolvedValue(running({ active: false, forOurPort: false }));
    mount({ port: 5000, remoteHosts: [] });
    // Publishing the wrong port produces a 502 that reads as a Tailscale fault.
    expect(await screen.findByText(/http:\/\/127\.0\.0\.1:5000/)).toBeTruthy();
  });

  it('drops the serve command once serve is already pointed here', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await screen.findByText('alpha@example.com');
    expect(commands().queryByText(/tailscale serve --bg/)).toBeNull();
    // The line that re-points the console at the hostname stays: flags change
    // more often than the serve does. Matched on `--remote-user`, which both
    // trees carry — the free tree restarts the console, Pro also offers to
    // re-install the agent, so this is one block there and two here.
    expect(commands().getAllByText(/--remote-user/).length).toBeGreaterThan(0);
  });
});

describe('a second console on one machine', () => {
  // One machine runs one console per project, and `tailscale serve` has one
  // 443. Suggesting 443 for every console had the second one take the first
  // one's URL over: the phone then reached whichever ran the command last, and
  // the other refused with a 421.
  it('keeps 443 for the default port and derives a port of its own for every other console', () => {
    // The fallback copy for a server that sends no `serve.command`: the same
    // rows `test/tailscale.test.ts` pins on the server's `httpsPortFor`.
    expect(httpsPortFor(4123)).toBe(443);
    expect(httpsPortFor(4130)).toBe(8130);
    expect(httpsPortFor(5000)).toBe(9000);
    expect(servedPort('https://alpha.example.ts.net')).toBe(443);
    expect(servedPort('https://alpha.example.ts.net:8130')).toBe(8130);
    expect(servedPort(undefined)).toBeUndefined();
  });

  it('suggests the derived port in the serve command', async () => {
    tailscale.mockResolvedValue(running({ active: false, forOurPort: false }));
    mount({ port: 4130, remoteHosts: [] });
    // The copyable prompt carries the same example; the command block is the
    // one that must derive the port, so look inside it once the probe answered.
    await screen.findByText('alpha@example.com');
    expect(commands().getByText(/--https=8130 http:\/\/127\.0\.0\.1:4130/)).toBeTruthy();
    expect(commands().queryByText(/--https=443 /)).toBeNull();
  });

  it('reads a URL that carries a port as served, on that port, by the right host', async () => {
    tailscale.mockResolvedValue(
      running({ active: true, forOurPort: true, url: 'https://alpha.example.ts.net:8130' }),
    );
    mount({ port: 4130, remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    expect(await screen.findByText(/this console, on 8130/)).toBeTruthy();
    // The hostname is what `--remote` matches; the port must not read as a
    // different host, which would raise a mismatch over a working setup. (The
    // "open this URL" banner is a status too, so the check is for warnings.)
    expect(warnings().join(' ')).not.toMatch(/421|will not resolve|only answers to/);
    expect(screen.getByRole('link', { name: 'https://alpha.example.ts.net:8130' })).toBeTruthy();
  });

  it('names the derived port when nothing is served for a flagged console', async () => {
    tailscale.mockResolvedValue(running({ active: true, forOurPort: false }));
    mount({ port: 4130, remoteHosts: ['alpha.example.ts.net'] });
    await screen.findByText('alpha@example.com');
    expect(warnings().join(' ')).toMatch(/nothing is being served on 8130/);
  });

  it('names the live console holding 443, refuses to print the command that would displace it, and offers the port that leaves it alone', async () => {
    // The real shape of the finding: a sibling holds 443, and the default
    // console's natural command is exactly the line that takes its phone.
    tailscale.mockResolvedValue(
      running(
        heldBy(DELTA, {
          httpsPort: 8123,
          text: 'tailscale serve --bg --https=8123 http://127.0.0.1:4123',
          displaces: { httpsPort: 443, occupant: DELTA },
        }),
      ),
    );
    mount({ port: 4123, remoteHosts: ['alpha.example.ts.net'] });
    await screen.findByText('alpha@example.com');
    // The Serving row names the occupying console and its port.
    expect(screen.getByText('delta (port 4130)')).toBeTruthy();
    // The server's command is printed as sent; the displacing one is not.
    expect(commands().getByText(/--https=8123 http:\/\/127\.0\.0\.1:4123/)).toBeTruthy();
    expect(commands().queryByText(/--https=443 /)).toBeNull();
    const said = warnings().join(' ');
    expect(said).toMatch(/443 is held by the live console delta \(port 4130\)/);
    expect(said).toMatch(/publishes on 8123 instead, which leaves delta alone/);
    // And the flagged-but-unserved warning names the port that command publishes on.
    expect(said).toMatch(/nothing is being served on 8123/);
  });

  it('prints the natural command, with no refusal, when the console holding it is not running', async () => {
    tailscale.mockResolvedValue(running(heldBy({ ...DELTA, liveness: 'stopped' }, NATURAL)));
    mount({ port: 4123, remoteHosts: [] });
    await screen.findByText('alpha@example.com');
    expect(screen.getByText('delta (port 4130)')).toBeTruthy();
    expect(commands().getByText(/--https=443 http:\/\/127\.0\.0\.1:4123/)).toBeTruthy();
    expect(warnings().join(' ')).not.toMatch(/held by the live console/);
  });
});

