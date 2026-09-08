/**
 * Reaching this console from a phone.
 *
 * The console binds to loopback and stays there. The way it reaches a phone is
 * `tailscale serve`, which terminates TLS on the tailnet and forwards to
 * 127.0.0.1 with the caller's login in a header — so the feature is really two
 * settings in two different places agreeing with each other: what Tailscale is
 * publishing, and what `--remote` says this console will answer to. Either one
 * alone looks fine from this machine and fails from the phone, which is exactly
 * the failure this card exists to name.
 *
 * So it is arranged as: what is true now, then what disagrees, then the two
 * commands that fix it, then what to do on each device. The prompt at the top
 * is the whole thing handed to Claude instead, for a reader who would rather
 * not run any of it by hand.
 *
 * It sits between *This process* and *Source* because it belongs to the same
 * question as its neighbours — how this console is reached and by whom — not to
 * the repository it happens to be reading.
 */

import { Wifi, WifiOff } from 'lucide-react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { useTailscale } from '@/lib/queries';
import type { TailscaleDevice, TailscaleStatus } from '@/lib/api';
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyButton,
  DataTable,
  Empty,
  KeyValue,
  RelativeTime,
  Skeleton,
} from '@/components/ui';

/**
 * The HTTPS port Tailscale should publish THIS console on.
 *
 * One machine can run one console per project, and `tailscale serve` has one
 * 443. The card used to suggest 443 for every console, so the second console
 * an operator published took the first one's URL over — the phone then reached
 * whichever ran the command last, and the other refused with a 421. The
 * default console port keeps 443 (the URL every earlier install already has);
 * any other console publishes on 4000 + its own port, which is unique on the
 * machine for the same reason the port is.
 */
export const DEFAULT_CONSOLE_PORT = 4123;
export function httpsPortFor(port: number): number {
  return port === DEFAULT_CONSOLE_PORT ? 443 : port + 4000;
}

/** The port Tailscale actually publishes a URL on — `443` when the URL carries none. */
export function servedPort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : 443;
  } catch {
    return undefined;
  }
}

/** The port the console is served on, for the commands this card prints. */
function serveCommand(port: number): string {
  return `tailscale serve --bg --https=${httpsPortFor(port)} http://127.0.0.1:${port}`;
}

function Devices({ self, peers }: { self: TailscaleDevice; peers: TailscaleDevice[] }) {
  const all = [{ ...self, isSelf: true }, ...peers.map((p) => ({ ...p, isSelf: false }))];
  /*
   * This table used to roll its own `<table>` beside the shared one — its own
   * overflow wrapper, its own padding (`py-1` against the primitive's), no
   * border, no `overscroll-x-contain`. Two table implementations in one app is
   * two sets of answers to every question the primitive exists to settle.
   */
  return (
    <DataTable
      label="Devices on this tailnet"
      columns={[
        {
          id: 'device',
          head: 'Device',
          priority: 1,
          min: 180,
          flex: true,
          identity: true,
          card: 'title',
          cell: (device) => (
            <span className="flex min-w-0 items-baseline gap-1">
              {/* A tailnet hostname is data and can be long; the column is
                  `flex` and would grow to whatever the longest one is. */}
              <span className="min-w-0 truncate font-mono text-ink" title={device.dnsName || device.hostName}>
                {device.hostName}
              </span>
              {device.isSelf && <span className="shrink-0 text-2xs text-ink-faint">this machine</span>}
            </span>
          ),
        },
        {
          id: 'system',
          head: 'System',
          priority: 2,
          min: 108,
          card: 'meta',
          cell: (device) => <span className="font-mono text-ink-muted">{device.os ?? '—'}</span>,
        },
        {
          id: 'state',
          head: 'State',
          priority: 1,
          min: 200,
          card: 'meta',
          // A badge, not two colours of the same mono text: hue was the only
          // thing separating `online` from `offline` at a glance, and hue is
          // the one carrier a reader may not have (WCAG 1.4.1). The tone, the
          // icon and the word all say it now.
          cell: (device) => (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge tone={device.online ? 'live' : 'neutral'}>
                {device.online ? <Wifi size={11} aria-hidden /> : <WifiOff size={11} aria-hidden />}
                {device.online ? 'online' : 'offline'}
              </Badge>
              {!device.online && device.lastSeen && (
                <span className="text-2xs text-ink-faint">
                  last seen <RelativeTime at={device.lastSeen} live={false} />
                </span>
              )}
            </span>
          ),
        },
      ]}
      rows={all}
      getRowKey={(device) => device.dnsName || device.hostName}
      empty={
        <Empty
          title="No device but this one"
          body="Nothing else is signed into this tailnet yet. Install Tailscale on the phone or laptop you want to read the console from and sign it into the same tailnet."
        />
      }
    />
  );
}

/**
 * The commands, in the order that never leaves a live-but-broken URL.
 *
 * Labelled as a group because the same words appear again inside the copyable
 * prompt below — a reader can tell the two apart by where they are on the page,
 * and anything asserting about "the command this card shows" needs the same
 * distinction to be real in the accessibility tree rather than visual only.
 */
function Commands({ port, serving }: { port: number; serving: boolean }) {
  return (
    <div role="group" aria-label="Setup commands" className="flex flex-col gap-2">
      {!serving && (
        <div>
          <p className="mb-1 text-2xs text-ink-faint">
            Publish it on the tailnet. It stays bound to loopback — Tailscale does the listening.
          </p>
          <Block text={serveCommand(port)} />
        </div>
      )}
      <div>
        <p className="mb-1 text-2xs text-ink-faint">
          Then restart the console so it answers to that hostname, keeping the flags it already has.
        </p>
        <Block
          text={
            'bash <skill>/start --root <repo> [existing flags] \\\n  --remote <name>.<tailnet>.ts.net --remote-user <your login>'
          }
        />
      </div>
    </div>
  );
}

function Block({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="m-0 flex-1 overflow-x-auto rounded bg-ground-deep p-2 font-mono text-2xs leading-relaxed">
        {text}
      </pre>
      <CopyButton text={text} label="Copy" />
    </div>
  );
}

/**
 * The mismatches, each with the symptom it produces.
 *
 * Naming the symptom is the point: both of these look like a working setup from
 * this machine, and both read on the phone as "the console is broken".
 */
function Mismatch({
  status,
  remoteHosts,
  port,
}: {
  status: TailscaleStatus;
  remoteHosts?: string[];
  port: number;
}) {
  if (status.state !== 'running') return null;

  // The server predates these fields — say nothing rather than guess.
  if (!remoteHosts) return null;

  const serving = status.serve.forOurPort;
  const flagged = remoteHosts.length > 0;

  if (serving && !flagged) {
    return (
      <Banner severity="warn">
        Tailscale is publishing this console, but it was started without <code>--remote</code>, so every
        request through that URL is refused with a 421. Re-install with the hostname below.
      </Banner>
    );
  }

  if (!serving && flagged) {
    return (
      <Banner severity="warn">
        This console answers to <code>{remoteHosts.join(', ')}</code>, but nothing is being served on{' '}
        {httpsPortFor(port)} for it — the URL will not resolve. Run the serve command below.
      </Banner>
    );
  }

  if (serving && flagged && status.serve.url) {
    // Both halves exist; they can still name different hosts. The HOSTNAME is
    // what `--remote` matches (the server strips the port before comparing),
    // so a URL published on 8130 must not read as a different host.
    let host = status.serve.url.replace(/^https:\/\//, '');
    try {
      host = new URL(status.serve.url).hostname;
    } catch {
      /* an unparseable URL keeps the raw spelling, and the message names it */
    }
    if (!remoteHosts.includes(host)) {
      return (
        <Banner severity="warn">
          Tailscale serves <code>{host}</code>, but this console only answers to{' '}
          <code>{remoteHosts.join(', ')}</code>. Requests arriving as <code>{host}</code> are refused.
          Re-install with that hostname.
        </Banner>
      );
    }
  }

  return null;
}

export function TailscaleCard({
  port,
  remoteHosts,
  remoteUsers,
}: {
  port: number;
  remoteHosts?: string[];
  remoteUsers?: string[];
}) {
  const { data: status, isPending } = useTailscale();
  const setup = SETUP_PROMPTS.find((p) => p.id === 'tailscale');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reach this console from your phone</CardTitle>
        {setup && <CopyButton text={setup.prompt} label="Copy prompt" />}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {isPending && !status ? (
          <Skeleton className="h-24" />
        ) : (
          <Body status={status} port={port} remoteHosts={remoteHosts} remoteUsers={remoteUsers} />
        )}

        {setup && (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-muted">Have Claude set this up instead</summary>
            <pre className="m-0 mt-2 max-h-96 overflow-auto overscroll-contain rounded bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {setup.prompt}
            </pre>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

function Body({
  status,
  port,
  remoteHosts,
  remoteUsers,
}: {
  status?: TailscaleStatus;
  port: number;
  remoteHosts?: string[];
  remoteUsers?: string[];
}) {
  if (!status) {
    return (
      <p className="text-sm text-ink-muted">
        This server cannot report on Tailscale — it started before this feature existed. Restart it above to
        ask.
      </p>
    );
  }

  if (status.state === 'not-installed') {
    return (
      <>
        <p className="text-sm text-ink-muted">
          Tailscale is not installed on this machine. It is the only supported way to reach this console from
          another device: it puts an authenticating proxy in front of a server that never leaves loopback, so
          nothing is ever exposed to a network.
        </p>
        <p className="text-sm text-ink-muted">
          Install it from <code>tailscale.com/download</code>, sign in, then come back here.
        </p>
      </>
    );
  }

  if (status.state === 'installed-not-running') {
    return (
      <>
        <Banner severity="warn">
          Tailscale is installed but not running
          {status.detail ? (
            <>
              {' '}
              — <code>{status.detail}</code>
            </>
          ) : null}
          .
        </Banner>
        <p className="text-sm text-ink-muted">
          Open the Tailscale app and sign in, then this card will fill in.
        </p>
      </>
    );
  }

  const reachable = status.serve.forOurPort ? status.serve.url : undefined;

  return (
    <>
      <KeyValue
        items={[
          ['Tailnet', status.tailnet ?? 'unknown'],
          [
            'MagicDNS',
            status.magicDns ? (
              <span>
                on
                {status.magicDnsSuffix ? (
                  <>
                    {' '}
                    · <code>{status.magicDnsSuffix}</code>
                  </>
                ) : null}
              </span>
            ) : (
              <span className="text-action">off — device names will not resolve</span>
            ),
          ],
          [
            'Serving',
            status.serve.forOurPort ? (
              <span className="text-done">
                this console, on {servedPort(status.serve.url) ?? httpsPortFor(port)}
              </span>
            ) : status.serve.active ? (
              <span className="text-action">something else — not this console&apos;s port</span>
            ) : (
              'nothing'
            ),
          ],
          [
            'Allowed logins',
            remoteUsers?.length ? (
              <span className="font-mono text-2xs">{remoteUsers.join(', ')}</span>
            ) : (
              'none — the console is local-only'
            ),
          ],
        ]}
      />

      <Mismatch status={status} remoteHosts={remoteHosts} port={port} />

      {reachable && remoteHosts?.length ? (
        <Banner severity="ok">
          <span>
            Open{' '}
            <a className="font-mono underline" href={reachable}>
              {reachable}
            </a>{' '}
            on any device signed into this tailnet.
          </span>
        </Banner>
      ) : null}

      <Commands port={port} serving={status.serve.forOurPort} />

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted">First time on a tailnet</summary>
        <div className="mt-2 flex flex-col gap-2 text-sm text-ink-muted">
          <p>
            Two tailnet-wide settings have to be on before HTTPS serving works, and neither can be set from
            this machine — do them once in the Tailscale admin console:
          </p>
          <ul className="ml-4 list-disc">
            <li>
              <strong>DNS → MagicDNS</strong>, so devices resolve each other by name.
            </li>
            <li>
              <strong>DNS → HTTPS Certificates</strong>, so <code>serve</code> can get a certificate.
            </li>
          </ul>
        </div>
      </details>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted">Setting up a device</summary>
        <div className="mt-2 flex flex-col gap-2 text-sm text-ink-muted">
          <ol className="ml-4 list-decimal">
            <li>
              Install Tailscale and sign into the <em>same</em> tailnet.
            </li>
            <li>Turn on MagicDNS — on iOS and Android it is called “Use Tailscale DNS”.</li>
            <li>Open {reachable ? <code>{reachable}</code> : 'the URL above'}.</li>
            <li>
              On iOS, add it to the Home Screen. Notifications only work from a Home Screen app — in a browser
              tab they never arrive.
            </li>
          </ol>
          <p className="text-2xs text-ink-faint">
            Only devices on this tailnet, signed in as an allowed login, can reach it. Everyone else gets a
            refusal from Tailscale before the console is involved at all.
          </p>
        </div>
      </details>

      <Devices self={status.self} peers={status.peers} />
    </>
  );
}
