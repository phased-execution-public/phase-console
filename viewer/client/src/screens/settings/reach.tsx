/**
 * Reach — this console from a phone (7.0, quiet-console phase 22; the
 * Tailscale card of 6.x). Drawn inside Settings ▸ This instance.
 *
 * ```
 * Reach this console from your phone                  [Copy the setup prompt]
 * Tailnet         example.ts.net
 * MagicDNS        On, .example.ts.net
 * Serving         This console, on 443
 * Answers to      mac.example.ts.net             (--remote)
 * Allowed logins  me@github                      (--remote-user)
 * Open https://mac.example.ts.net on any device signed in to this tailnet.
 * Publish it   tailscale serve --bg --https=443 http://127.0.0.1:4123      [Copy]
 * ```
 *
 * The console binds to loopback and stays there. It reaches a phone through
 * `tailscale serve`, which terminates TLS on the tailnet and forwards to
 * 127.0.0.1 with the caller's login in a header — so reach is two settings in
 * two places agreeing: what Tailscale publishes, and what `--remote` and
 * `--remote-user` say this console answers to and for whom. Either alone looks
 * fine from this machine and fails from the phone, which is the failure this
 * group exists to name. So: what is true now, then what disagrees, then the
 * commands that fix it, then what to do on each device. The two flags are the
 * launch unit's, read-only here; the restart line is how they change.
 */

import { Wifi, WifiOff } from 'lucide-react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import type { ServeCommand, TailscaleDevice, TailscaleServe, TailscaleStatus } from '@/data/api';
import { useTailscale } from '@/data/machine';
import { Banner, KeyValue, Mono, RelativeTime, Skeleton } from '@/ui';
import { CodeBlock } from '@/ui/code-block';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { SettingsGroup } from './setting';

/**
 * The HTTPS port Tailscale should publish THIS console on, when nothing stands
 * in the way: the default console keeps 443, any other publishes on 4000 + its
 * own port — unique on the machine for the reason its port is. The server owns
 * the real answer (`serve.command`, which reads the whole Serve table); this is
 * the fallback for a server that predates it, and both suites pin one table.
 */
export const DEFAULT_CONSOLE_PORT = 4123;
export function httpsPortFor(port: number): number {
  return port === DEFAULT_CONSOLE_PORT ? 443 : port + 4000;
}

/** The port Tailscale actually publishes a URL on — `443` when the URL names none. */
export function servedPort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : 443;
  } catch {
    return undefined;
  }
}

/** The serve command to show, or `null` when nothing needs running: the server's whenever it sent one. */
export function serveCommandFor(serve: TailscaleServe, port: number): ServeCommand | null {
  if (serve.command !== undefined) return serve.command;
  return serve.forOurPort
    ? null
    : {
        httpsPort: httpsPortFor(port),
        text: `tailscale serve --bg --https=${httpsPortFor(port)} http://127.0.0.1:${port}`,
        displaces: null,
      };
}

/** Who Tailscale publishes instead of this console — by name, when a console on this machine claims it. */
export function occupantWords(serve: TailscaleServe): string {
  if (serve.occupant?.name) return `${serve.occupant.name}, on port ${serve.occupant.port}`;
  if (serve.targetPort !== undefined)
    return `port ${serve.targetPort} — a program no console on this machine knows`;
  if (serve.handlers) return 'a handler that does not forward to a port on this machine';
  return 'another port — this server is too old to say which';
}

/**
 * What disagrees, with the symptom it produces — both look like a working
 * setup from this machine, and both read on the phone as "the console is
 * broken". Null when the halves agree, or the server is too old to say.
 */
export function reachMismatch(
  status: TailscaleStatus,
  remoteHosts: readonly string[] | undefined,
  port: number,
): string | null {
  if (status.state !== 'running' || !remoteHosts) return null;
  const serving = status.serve.forOurPort;
  const flagged = remoteHosts.length > 0;
  if (serving && !flagged) {
    return 'Tailscale publishes this console, but it was started without --remote, so every request through that address is refused with a 421. Restart it with the host name below.';
  }
  if (!serving && flagged) {
    const at = serveCommandFor(status.serve, port)?.httpsPort ?? httpsPortFor(port);
    return `This console answers to ${remoteHosts.join(', ')}, but nothing is served on ${at} for it — the address will not resolve. Run the serve command below.`;
  }
  if (serving && flagged && status.serve.url) {
    // The HOST is what `--remote` matches (the server drops the port), so an address on 8130 is not another host.
    let host = status.serve.url.replace(/^https:\/\//, '');
    try {
      host = new URL(status.serve.url).hostname;
    } catch {
      /* an address that does not parse keeps its raw spelling, and the sentence names it */
    }
    if (!remoteHosts.includes(host)) {
      return `Tailscale serves ${host}, but this console answers only to ${remoteHosts.join(', ')}, so a request that arrives as ${host} is refused. Restart it with that host name.`;
    }
  }
  return null;
}

/** A setup line, in the one command block (`ui/code-block.tsx`): a template says what to fill in first. */
function CommandBlock({ text, label }: { text: string; label: string }) {
  return <CodeBlock code={text} copyLabel={label} claudeCode={false} testId="reach-command" />;
}

/** The commands, in the order that never leaves a live-but-broken address. */
function Commands({ command }: { command: ServeCommand | null }) {
  return (
    <div role="group" aria-label="Setup commands" className="flex min-w-0 flex-col gap-3">
      {command?.displaces && (
        <Banner severity="warn" data-testid="serve-displaces">
          {command.displaces.httpsPort} is held by the live console{' '}
          {command.displaces.occupant.name
            ? `${command.displaces.occupant.name} (port ${command.displaces.occupant.port})`
            : `on port ${command.displaces.occupant.port}`}{' '}
          — publishing this console there would take the phone away from it. The command below publishes on{' '}
          {command.httpsPort} instead, which leaves it alone.
        </Banner>
      )}
      {command && (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-meta text-ink-muted">
            Publish it on the tailnet. It stays bound to loopback — Tailscale does the listening.
          </p>
          <CommandBlock text={command.text} label="Copy the serve command" />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-meta text-ink-muted">
          Then restart the console so it answers to that host name, keeping the flags it already has.
        </p>
        <CommandBlock
          label="Copy the restart line"
          text={
            'bash <skill>/start --root <repo> [existing flags] \\\n  --remote <name>.<tailnet>.ts.net --remote-user <your login>'
          }
        />
      </div>
    </div>
  );
}

function Devices({ self, peers }: { self: TailscaleDevice; peers: readonly TailscaleDevice[] }) {
  const all = [{ ...self, isSelf: true }, ...peers.map((peer) => ({ ...peer, isSelf: false }))];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-body font-medium text-ink">Devices on this tailnet</p>
      {all.length === 1 && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          Nothing else is signed in to this tailnet yet. Install Tailscale on the phone or laptop you want to
          read the console from, and sign it in to the same tailnet.
        </p>
      )}
      <ul
        className="flex min-w-0 flex-col gap-1.5"
        aria-label="Devices on this tailnet"
        data-testid="tailnet-devices"
      >
        {all.map((device) => (
          <li
            key={device.dnsName || device.hostName}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
          >
            <Mono
              value={device.hostName}
              className="min-w-0 wrap-anywhere text-ink"
              title={device.dnsName || device.hostName}
            />
            {device.isSelf && <span className="text-meta text-ink-muted">this machine</span>}
            {device.os && <span className="text-meta text-ink-muted">{device.os}</span>}
            <span className="inline-flex items-center gap-1 text-meta text-ink">
              {device.online ? <Wifi size={12} aria-hidden /> : <WifiOff size={12} aria-hidden />}
              {device.online ? 'Online' : 'Offline'}
            </span>
            {!device.online && device.lastSeen && (
              <span className="text-meta text-ink-muted">
                last seen <RelativeTime at={device.lastSeen} live={false} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Running({
  status,
  port,
  remoteHosts,
  remoteUsers,
}: {
  status: Extract<TailscaleStatus, { state: 'running' }>;
  port: number;
  remoteHosts: readonly string[] | undefined;
  remoteUsers: readonly string[] | undefined;
}) {
  const reachable = status.serve.forOurPort ? status.serve.url : undefined;
  const mismatch = reachMismatch(status, remoteHosts, port);
  return (
    <>
      <KeyValue
        items={[
          ['Tailnet', status.tailnet ?? 'Unknown'],
          [
            'MagicDNS',
            status.magicDns ? (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                On{status.magicDnsSuffix ? <Mono value={status.magicDnsSuffix} /> : null}
              </span>
            ) : (
              'Off — device names will not resolve'
            ),
          ],
          [
            'Serving',
            status.serve.forOurPort
              ? `This console, on ${servedPort(status.serve.url) ?? httpsPortFor(port)}`
              : status.serve.active
                ? occupantWords(status.serve)
                : 'Nothing',
          ],
          [
            'Answers to',
            remoteHosts === undefined ? (
              'This server is too old to say'
            ) : remoteHosts.length ? (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid="remote-hosts">
                {remoteHosts.map((host) => (
                  <Mono key={host} value={host} className="wrap-anywhere" />
                ))}
                <span className="text-meta text-ink-muted">from --remote</span>
              </span>
            ) : (
              'Only this machine — started without --remote'
            ),
          ],
          [
            'Allowed logins',
            // Absent is "this server cannot say" (`ConsoleState`), never "none" — the row above reads it so too.
            remoteUsers === undefined ? (
              'This server is too old to say'
            ) : remoteUsers.length ? (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid="remote-users">
                {remoteUsers.map((user) => (
                  <Mono key={user} value={user} className="wrap-anywhere" />
                ))}
                <span className="text-meta text-ink-muted">from --remote-user</span>
              </span>
            ) : (
              'None — the console is local-only'
            ),
          ],
        ]}
      />
      {mismatch && (
        <Banner severity="warn" data-testid="reach-mismatch">
          {mismatch}
        </Banner>
      )}
      {/* Offered only while nothing disagrees: a host this console does not answer to is refused there. */}
      {reachable && remoteHosts?.length && !mismatch ? (
        <Banner severity="ok" data-testid="reach-open">
          Open{' '}
          <a
            className="tap-line font-mono underline decoration-ink-faint underline-offset-2"
            href={reachable}
          >
            {reachable}
          </a>{' '}
          on any device signed in to this tailnet.
        </Banner>
      ) : null}
      <Commands command={serveCommandFor(status.serve, port)} />
      <Disclosure label="First time on a tailnet" openLabel="Hide the first-time steps">
        <div className="flex min-w-0 max-w-(--measure) flex-col gap-2 pt-1 text-body text-ink-muted">
          <p>
            Two tailnet-wide settings must be on before serving works, and neither can be set from this
            machine — turn them on once in the Tailscale admin console:
          </p>
          <ul className="flex list-disc flex-col gap-1 ps-5">
            <li>DNS, then MagicDNS, so devices resolve each other by name.</li>
            <li>DNS, then HTTPS Certificates, so serve can get a certificate.</li>
          </ul>
        </div>
      </Disclosure>
      <Disclosure label="Setting up a device" openLabel="Hide the device steps">
        <div className="flex min-w-0 max-w-(--measure) flex-col gap-2 pt-1 text-body text-ink-muted">
          <ol className="flex list-decimal flex-col gap-1 ps-5">
            <li>Install Tailscale and sign in to the same tailnet.</li>
            <li>Turn MagicDNS on — on iOS and Android it is called Use Tailscale DNS.</li>
            <li>Open {reachable ? <Mono value={reachable} /> : 'the address above'}.</li>
            <li>
              On iOS, add it to the Home Screen: notifications arrive only for a Home Screen app, never in a
              browser tab.
            </li>
          </ol>
          <p className="text-meta">
            Only devices on this tailnet, signed in as an allowed login, can reach it. Everyone else is
            refused by Tailscale before the console is involved at all.
          </p>
        </div>
      </Disclosure>
      <Devices self={status.self} peers={status.peers} />
    </>
  );
}


export function ReachGroup({
  port,
  remoteHosts,
  remoteUsers,
}: {
  port: number;
  remoteHosts?: readonly string[] | undefined;
  remoteUsers?: readonly string[] | undefined;
}) {
  const { data: status, isPending } = useTailscale();
  const setup = SETUP_PROMPTS.find((prompt) => prompt.id === 'tailscale');

  return (
    <SettingsGroup
      id="reach"
      title="Reach this console from your phone"
      aside={setup ? <CopyButton text={setup.prompt} label="Copy the setup prompt" /> : undefined}
    >
      {isPending && !status ? (
        <Skeleton className="h-24" aria-busy="true" aria-label="Asking Tailscale" />
      ) : !status ? (
        <p className="max-w-(--measure) text-body text-ink-muted">
          This server cannot report on Tailscale — it started before reach existed. Restart it to ask.
        </p>
      ) : status.state === 'not-installed' ? (
        <div
          className="flex min-w-0 max-w-(--measure) flex-col gap-2 text-body text-ink-muted"
          data-testid="tailscale-missing"
        >
          <p>
            Tailscale is not installed on this machine. It is the supported way to reach this console from
            another device: an authenticating proxy in front of a server that never leaves loopback, so
            nothing is ever exposed to a network.
          </p>
          <p>
            Install it from <Mono value="tailscale.com/download" />, sign in, then come back here.
          </p>
        </div>
      ) : status.state === 'installed-not-running' ? (
        <>
          <Banner severity="warn" data-testid="tailscale-stopped">
            Tailscale is installed but not running{status.detail ? `: ${status.detail}` : ''}.
          </Banner>
          <p className="text-body text-ink-muted">
            Open the Tailscale app and sign in; this group fills in then.
          </p>
        </>
      ) : (
        <Running status={status} port={port} remoteHosts={remoteHosts} remoteUsers={remoteUsers} />
      )}
      {setup && (
        <Disclosure label="Have Claude set this up instead" openLabel="Hide the prompt">
          <pre className="m-0 mt-2 max-h-96 overflow-auto overscroll-contain whitespace-pre-wrap rounded-sm bg-ground-deep p-3 font-mono text-meta leading-relaxed text-ink">
            {setup.prompt}
          </pre>
        </Disclosure>
      )}
    </SettingsGroup>
  );
}
