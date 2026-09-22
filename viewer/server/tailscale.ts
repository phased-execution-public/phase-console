/**
 * What this machine's tailnet looks like, for the Settings card that turns a
 * loopback console into one you can open from your phone.
 *
 * `--remote` (see `server/api/access.ts`) is the half of that story this repo
 * already had: it says which hostnames the console answers to and who may
 * arrive through them. What it could never say is whether any of it is
 * actually *set up* — whether Tailscale is installed, signed in, serving 443
 * at this port, and which of your devices could reach it. Those answers live
 * outside the process, so the card that explains the feature has to go and
 * look. Everything here is that lookup.
 *
 * Three rules the rest of the file exists to keep:
 *
 *   Never throw. This is decoration on a settings page. A machine without
 *   Tailscale, with a half-installed Tailscale, or with a daemon that hangs is
 *   the *normal* case for most people running this console, and none of it may
 *   turn into a 500 next to the buttons that restart the server.
 *
 *   Never pass the CLI's JSON through. `status --json` carries public keys, an
 *   `AuthURL` that would let a stranger join the tailnet, and a per-node
 *   capability map. The card needs a hostname and an online dot. So every
 *   field is copied out by name and nothing else survives — a whitelist, not a
 *   redaction pass, because redaction has to be re-checked every time upstream
 *   adds a field and a whitelist does not.
 *
 *   Cache on time, not on anything this repo watches. Tailnet state changes
 *   when a phone wakes up, which corresponds to no file and no generation
 *   counter — so a plain 30-second memo is the honest expiry, and it also
 *   keeps an open Settings page from shelling out twice a second.
 */


import { DEFAULT_PORT, listInstances, liveness } from '../shared/instances.mjs';
import type { Liveness } from '../shared/fleet-model.js';
import { shell } from './shell.ts';

/** Where macOS puts the CLI when Tailscale came from the App Store build. */
const APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * How long one `tailscale` invocation may take before it reads as "no answer".
 *
 * Three seconds is right for the product: this is a local CLI on the same
 * machine, the answer feeds a status chip, and a hung probe must not hold a page
 * load. It is NOT right for a test suite — the fixtures fork a bash script, and
 * under a full parallel run that alone has been measured at 2.2s of the 3s
 * budget, so the suite flaked on whichever tailscale test happened to run while
 * the machine was busiest. Overridable rather than widened: production keeps
 * three seconds, and the suite stops depending on how loaded the host is.
 */
const PROBE_TIMEOUT_MS = 3000;
const probeTimeoutMs = (): number => {
  const override = Number(process.env.PHASE_CONSOLE_TAILSCALE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : PROBE_TIMEOUT_MS;
};
const CACHE_MS = 30_000;

export type TailscaleDevice = {
  hostName: string;
  dnsName: string;
  ips: string[];
  os?: string;
  online: boolean;
  /** ISO timestamp, only interesting for a device that is currently offline. */
  lastSeen?: string;
};

/**
 * The console a Serve handler forwards to, named the way this machine's
 * registry names it.
 *
 * One tailnet name has one Serve table, and every console on the machine
 * publishes into it — so a handler that is not ours is usually a SIBLING, and
 * "not this console's port" was true and useless: it could not say whose phone
 * a fresh `serve` command would take away. The port is the whole of what the
 * table says; the registry turns it into a name. `id`, `name` and `liveness`
 * are absent when no registered console claims the port — a program none of
 * this machine's consoles knows.
 */
export type ServeOccupant = {
  port: number;
  id?: string;
  name?: string;
  /** That console's own heartbeat reading — `liveness()` in `shared/instances.mjs`. */
  liveness?: Liveness;
};

/**
 * One row of the Serve table: `Web["<host>:<httpsPort>"].Handlers["<path>"]`.
 *
 * `targetPort` is the loopback port the handler proxies to, and `null` for
 * anything else — a proxy to another machine, a static path, a text reply —
 * which no console on this machine can be behind.
 */
export type ServeHandler = {
  host: string;
  httpsPort: number;
  path: string;
  targetPort: number | null;
  /** Proxies to this console's own port. */
  ours: boolean;
  /** Only on a loopback handler that is not ours. */
  occupant?: ServeOccupant;
};

/**
 * The `serve` command the card may print, decided against the whole table.
 *
 * `displaces` is set when the natural https port is held by a sibling that is
 * RUNNING. Printing the natural command there hands the operator the one line
 * that takes the phone away from a live console, so it is refused: the command
 * names a port no handler holds instead, and `displaces` carries the refused
 * port and its occupant so the card can say why.
 */
export type ServeCommand = {
  httpsPort: number;
  text: string;
  displaces: { httpsPort: number; occupant: ServeOccupant } | null;
};

/**
 * Whether `tailscale serve` is publishing anything, and whether what it
 * publishes is *this* console.
 *
 * The two are deliberately separate. Serving something else on 443 is a real
 * state with a specific fix (you pointed it at another port), and collapsing
 * it into "not serving" would send someone to re-run a command that is already
 * running. And "something else" is named: `targetPort` and `occupant` say which
 * console — or which port nobody registered — holds it.
 */
export type TailscaleServe = {
  active: boolean;
  forOurPort: boolean;
  /** The https URL that reaches this console, only when `forOurPort`. */
  url?: string;
  /**
   * The loopback port behind the handler that answers the phone: the `/`
   * handler on 443 if there is one, else the first (ours, when `forOurPort`).
   * Absent when nothing is served or that handler is not a loopback proxy.
   */
  targetPort?: number;
  /** That handler's occupant, when it is not this console. */
  occupant?: ServeOccupant;
  /** The whole table, in the order the CLI wrote it. */
  handlers: ServeHandler[];
  /** `null` once a handler serves this console — there is nothing to run. */
  command: ServeCommand | null;
};

export type TailscaleStatus =
  | { state: 'not-installed' }
  | { state: 'installed-not-running'; detail?: string }
  | {
      state: 'running';
      /** The tailnet's name as the CLI reports it. */
      tailnet?: string;
      magicDns: boolean;
      /** e.g. `example.ts.net` — the suffix device names resolve under. */
      magicDnsSuffix?: string;
      self: TailscaleDevice;
      peers: TailscaleDevice[];
      serve: TailscaleServe;
    };

type Cached = { at: number; port: number; value: TailscaleStatus };
let cache: Cached | null = null;

/** Test seam: drop the memo so a probe runs again. */
export function resetTailscaleCache(): void {
  cache = null;
}

type Run = { ok: boolean; stdout: string; code?: string };

/**
 * Run the CLI and come back with something, always.
 *
 * `execFile` reports a missing binary as `ENOENT` on the error rather than a
 * non-zero exit, which is the difference between "not installed" and "installed
 * and unhappy" — so the code is carried out rather than flattened into `ok`.
 *
 * `TERM` is load-bearing and was found the hard way. The macOS app's CLI is a
 * shim in front of the GUI, and with no `TERM` in the environment it concludes
 * it was double-clicked rather than run from a shell — so instead of answering
 * it tries to *open the app*, and prints "The Tailscale GUI failed to start"
 * where the JSON should be. Every shell has `TERM`; launchd hands a job an
 * almost-empty environment, so this worked in every test and on every developer
 * machine and reported `installed-not-running` on the one console that runs
 * supervised, with Tailscale plainly running.
 */
async function run(binary: string, args: string[]): Promise<Run> {
  const result = await shell(binary, args, {
    channel: 'shell',
    intent: 'tailscale',
    timeout: probeTimeoutMs(),
    capture: { keep: 4 * 1024 * 1024, mode: 'head' },
    env: { ...process.env, TERM: process.env.TERM || 'dumb' },
    // Tailscale not being installed, or not running, is one of the answers
    // this probe exists to give.
    expectFailure: true,
  });
  if (result.ok) return { ok: true, stdout: result.stdout };
  const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // A non-zero exit still prints usable JSON in some states, so stdout is
  // kept even on failure.
  return { ok: false, stdout: result.stdout, ...(typeof errno === 'string' ? { code: errno } : {}) };
}

function parse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * The first CLI that answers.
 *
 * PATH first, because someone who installed the standalone package has it
 * there and it is the one they would type. The app path second, because on
 * macOS the App Store build ships the CLI *inside* the bundle and shells
 * usually reach it through an alias — an alias being a shell construct, it does
 * not exist for `execFile`, so a machine with a perfectly working `tailscale`
 * at the prompt looks uninstalled to this process without the fallback.
 *
 * `PHASE_CONSOLE_TAILSCALE_BIN` replaces the search rather than extending it.
 * Someone who names a path has told us where it is, and quietly carrying on to
 * a different binary when that one is missing would report on an installation
 * they did not ask about.
 */
async function locate(args: string[]): Promise<{ binary: string; result: Run } | null> {
  const override = process.env.PHASE_CONSOLE_TAILSCALE_BIN;
  for (const binary of override ? [override] : ['tailscale', APP_BINARY]) {
    const result = await run(binary, args);
    if (result.code !== 'ENOENT') return { binary, result };
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function ips(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((ip): ip is string => typeof ip === 'string') : [];
}

/** A node, reduced to the fields the card renders. Nothing else is copied. */
function device(node: Record<string, unknown>): TailscaleDevice {
  const dnsName = (str(node.DNSName) ?? '').replace(/\.$/, '');
  const online = node.Online === true;
  return {
    hostName: str(node.HostName) ?? dnsName ?? '',
    dnsName,
    ips: ips(node.TailscaleIPs),
    ...(str(node.OS) ? { os: str(node.OS) } : {}),
    online,
    // Only when it adds something: "last seen" on a device that is online now
    // is a timestamp from a second ago, and reads as staleness that isn't there.
    ...(!online && str(node.LastSeen) ? { lastSeen: str(node.LastSeen) } : {}),
  };
}

/**
 * The HTTPS port a console is published on when nothing stands in the way.
 *
 * One machine runs one console per project, and `tailscale serve` has one 443.
 * The default console port keeps 443 — the URL every earlier install already
 * has; any other console takes 4000 + its own port, which is unique on the
 * machine for the same reason the port is. `serveCommandFor` is what decides
 * the port actually printed, because a sibling can already hold this one.
 *
 * The client keeps an import-free copy (`features/settings/tailscale.tsx`) for
 * a server that predates `serve.command`; the two suites pin the same table.
 */
export function httpsPortFor(port: number): number {
  return port === DEFAULT_PORT ? 443 : port + 4000;
}

function serveText(httpsPort: number, port: number): string {
  return `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`;
}

/**
 * The command that publishes `port`, or `null` when a handler already does.
 *
 * Pure — the handlers carry their occupants — so the rule is testable without a
 * CLI. The natural port is refused only for a sibling that is RUNNING, because
 * only then does the command take a phone away from anything: a stopped,
 * orphaned or never-heartbeated console, and a port no console claims, answer
 * nobody, and the natural URL is the one the docs and the operator's bookmarks
 * assume. A refusal offers 4000 + the port, or the first port above it that no
 * handler holds at all.
 */
export function serveCommandFor(port: number, handlers: readonly ServeHandler[]): ServeCommand | null {
  if (handlers.some((handler) => handler.targetPort === port)) return null;
  const natural = httpsPortFor(port);
  const live = handlers.find(
    (handler) => handler.httpsPort === natural && handler.occupant?.liveness === 'running',
  )?.occupant;
  if (!live) return { httpsPort: natural, text: serveText(natural, port), displaces: null };

  const held = new Set(handlers.map((handler) => handler.httpsPort));
  let offered = port + 4000;
  while (held.has(offered)) offered += 1;
  return {
    httpsPort: offered,
    text: serveText(offered, port),
    displaces: { httpsPort: natural, occupant: live },
  };
}

/**
 * Every spelling of a loopback target the CLI accepts: a scheme or none
 * (`http`, `https+insecure`), `127.0.0.1` / `localhost` / `[::1]`, a port, and
 * an optional trailing slash or path.
 */
const LOOPBACK_PROXY = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:\/.*)?$/i;

/**
 * The loopback port a handler's `Proxy` forwards to, or `null`.
 *
 * Matched on the port rather than one exact string — a bare `4123` is accepted
 * by the CLI too, and means loopback — or a working setup reads as a mismatch
 * and the card tells someone to fix what is already right. Anything that is not
 * loopback cannot be a console on this machine.
 */
function loopbackPort(proxy: string | undefined): number | null {
  const text = proxy?.trim() ?? '';
  const digits = /^\d{1,5}$/.test(text) ? text : LOOPBACK_PROXY.exec(text)?.[1];
  const port = Number(digits);
  return digits && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** `"host:8130"` → its two halves; a key the CLI wrote without a port is 443. */
function hostPortOf(key: string): { host: string; httpsPort: number } {
  const match = /^(.+):(\d{1,5})$/.exec(key);
  return match ? { host: match[1], httpsPort: Number(match[2]) } : { host: key, httpsPort: 443 };
}

/** The fields of a registry row this file reads. Nothing else of the row is copied. */
type RegistryRow = { id?: unknown; name?: unknown; port?: unknown };

/**
 * Who claims `port` in the registry, with that console's liveness.
 *
 * Two rows can claim one port — a stale row beside the console that took the
 * port over (`port-taken`) — and the running one is the one listening, so it is
 * the one named.
 */
function occupantOf(port: number, rows: RegistryRow[], now: number): ServeOccupant {
  try {
    const claims = rows
      .filter((row) => Number(row.port) === port)
      .map((row): { row: RegistryRow; word: Liveness } => ({ row, word: liveness(row, now, rows) }));
    const claim = claims.find((each) => each.word === 'running') ?? claims[0];
    if (!claim) return { port };
    return {
      port,
      ...(typeof claim.row.id === 'string' ? { id: claim.row.id } : {}),
      ...(typeof claim.row.name === 'string' && claim.row.name ? { name: claim.row.name } : {}),
      liveness: claim.word,
    };
  } catch {
    // A registry that cannot be judged still leaves the port worth reporting.
    return { port };
  }
}

/**
 * Every handler in the table, each loopback target that is not ours named.
 *
 * The registry is read once, and only when some handler needs a name — the
 * common case (nothing served, or only this console) never touches it.
 */
function handlersFrom(json: Record<string, unknown> | null, port: number): ServeHandler[] {
  const web = json?.Web;
  if (!web || typeof web !== 'object') return [];

  const handlers: ServeHandler[] = [];
  for (const [hostPort, config] of Object.entries(web as Record<string, unknown>)) {
    const table = (config as Record<string, unknown> | null)?.Handlers;
    if (!table || typeof table !== 'object') continue;
    const { host, httpsPort } = hostPortOf(hostPort);
    for (const [path, handler] of Object.entries(table as Record<string, unknown>)) {
      const targetPort = loopbackPort(str((handler as Record<string, unknown> | null)?.Proxy));
      handlers.push({ host, httpsPort, path, targetPort, ours: targetPort === port });
    }
  }

  if (!handlers.some((handler) => !handler.ours && handler.targetPort !== null)) return handlers;

  let rows: RegistryRow[] = [];
  try {
    rows = listInstances();
  } catch {
    rows = [];
  }
  const now = Date.now();
  const named = new Map<number, ServeOccupant>();
  return handlers.map((handler) => {
    if (handler.ours || handler.targetPort === null) return handler;
    const occupant = named.get(handler.targetPort) ?? occupantOf(handler.targetPort, rows, now);
    named.set(handler.targetPort, occupant);
    return { ...handler, occupant };
  });
}

/** The handler a phone opening the bare URL reaches: `/` on 443, else the first. */
function frontOf(handlers: readonly ServeHandler[]): ServeHandler | undefined {
  return handlers.find((handler) => handler.httpsPort === 443 && handler.path === '/') ?? handlers[0];
}

/**
 * Read `serve status --json` — the whole table, every handler named.
 *
 * The shape is `{TCP: {443: {HTTPS: true}}, Web: {"host:443": {Handlers:
 * {"/": {Proxy: "http://127.0.0.1:4123"}}}}}`. Parsing the JSON rather than the
 * human output matters because the text form is laid out for reading and has
 * changed between releases, while these keys are what the API returns.
 *
 * This used to look only for a handler at this console's own port and throw
 * every other target away. With two consoles on a machine that is the wrong
 * question: the table is shared, so the card could say "something else" and
 * nothing more — and printed the command that took the phone from whichever
 * live sibling held the port. Every handler is kept now, each loopback target
 * is named from the registry, and the command is decided against all of it.
 *
 * The whitelist rule holds here too: a handler's host, https port, path and the
 * PORT parsed out of its proxy survive; the proxy string and every other field
 * the CLI writes do not.
 */
function serveFrom(json: Record<string, unknown> | null, port: number): TailscaleServe {
  const handlers = handlersFrom(json, port);
  const command = serveCommandFor(port, handlers);
  const ours = handlers.filter((handler) => handler.ours);
  const front = frontOf(ours.length ? ours : handlers);

  if (!front) return { active: false, forOurPort: false, handlers, command };

  if (front.ours) {
    const url = front.httpsPort === 443 ? `https://${front.host}` : `https://${front.host}:${front.httpsPort}`;
    return { active: true, forOurPort: true, url, targetPort: port, handlers, command };
  }

  // Something is served, but not us — and which something is said.
  return {
    active: true,
    forOurPort: false,
    ...(front.targetPort !== null ? { targetPort: front.targetPort } : {}),
    ...(front.occupant ? { occupant: front.occupant } : {}),
    handlers,
    command,
  };
}

async function probe(port: number): Promise<TailscaleStatus> {
  const found = await locate(['status', '--json']);
  if (!found) return { state: 'not-installed' };

  const json = parse(found.result.stdout);
  if (!json) {
    // Installed, but it could not tell us anything — almost always a daemon
    // that is not running. The CLI's stderr is not repeated: it names local
    // socket paths, and this string goes on a page.
    return { state: 'installed-not-running', detail: 'the Tailscale daemon is not responding' };
  }

  const backend = str(json.BackendState);
  if (backend !== 'Running') {
    return {
      state: 'installed-not-running',
      // `NeedsLogin`, `Stopped`, `NoState` — the CLI's own vocabulary, which is
      // also what its documentation and error messages use.
      ...(backend ? { detail: backend } : {}),
    };
  }

  const tailnet = json.CurrentTailnet as Record<string, unknown> | undefined;
  const self = json.Self as Record<string, unknown> | undefined;

  const peers = Object.values((json.Peer as Record<string, unknown> | undefined) ?? {})
    .filter((peer): peer is Record<string, unknown> => !!peer && typeof peer === 'object')
    .map(device)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));

  const serveResult = await run(found.binary, ['serve', 'status', '--json']);

  return {
    state: 'running',
    ...(str(tailnet?.Name) ? { tailnet: str(tailnet?.Name) } : {}),
    magicDns: tailnet?.MagicDNSEnabled === true,
    ...(str(json.MagicDNSSuffix) ? { magicDnsSuffix: str(json.MagicDNSSuffix) } : {}),
    self: device(self ?? {}),
    peers,
    serve: serveFrom(parse(serveResult.stdout), port),
  };
}

/**
 * The tailnet as it looks right now, memoised for 30 seconds.
 *
 * Keyed on the port as well as the clock: the console's port is fixed for a
 * process, but a test that asks about two ports in the same second is asking
 * two different questions and must not get one answer.
 */
export async function tailscaleStatus(port: number): Promise<TailscaleStatus> {
  const now = Date.now();
  if (cache && cache.port === port && now - cache.at < CACHE_MS) return cache.value;

  let value: TailscaleStatus;
  try {
    value = await probe(port);
  } catch {
    // Belt and braces: `probe` is written not to throw, and if it ever does,
    // the settings page still renders.
    value = { state: 'not-installed' };
  }

  cache = { at: now, port, value };
  return value;
}
