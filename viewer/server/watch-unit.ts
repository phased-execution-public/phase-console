/**
 * `unit:<host>/<unit>` — a wait on a job running on another machine
 * (control-tower phase 121, #181).
 *
 * issues-sweep P7 slept about an hour and a half past its box job behind a
 * worst-case `date:`, because nothing the console could watch saw the job end.
 * A systemd unit is the job's own record of that: it is `activating` (a oneshot
 * at work) or `active` while it runs and leaves both when it ends, with
 * `Result=` saying how. So the ref lands the first time the unit is seen out
 * of both, and the phase's wait history keeps the `Result=` and the exit time.
 *
 * Three rules hold it safe and cheap:
 *
 *  - THE SHAPE IS THE SAFETY. ssh hands its command to the REMOTE shell as one
 *    string, so the host and the unit are held to a grammar with no shell
 *    character and no leading dash (`UNIT_REF_RE`; `phase-outcome.sh`
 *    `_watch_problem` is its bash twin), the argv is fixed, and the options end
 *    with `--` before the destination.
 *  - ONE ssh PER HOST. Every probe of a host rides one multiplexed master
 *    (`ControlMaster=auto`, a `ControlPath` per host, `ControlPersist` past
 *    the five-minute cadence), and the probes of one host queue behind each
 *    other, so two never race to become its master.
 *  - THE PROFILE, NEVER THE RECORD. The host is a NAME the machine profile
 *    (`~/.config/phase-console/fleet.json`, `hosts.<name>`) maps to an
 *    address, a user, a key and a port, read at probe time. None of them is
 *    written into a run record, a verdict or a wait history — the record
 *    carries the ref, and the ref carries the name. A name the profile does not
 *    hold is refused: a session cannot point the console's ssh at a machine
 *    the operator never named.
 */

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { fleetProfilePath } from '../shared/instances.mjs';
import type { WatchStateWord } from '../shared/run-lifecycle.js';
import { INSTANCE_STATE_DIR } from './config.ts';
import { shell, type ShellRun } from './shell.ts';

/** How often a `unit:` ref is asked — a fixed cadence, no back-off: a read is one `systemctl show`. */
export const UNIT_POLL_MS = 5 * 60_000;

/** How long the per-host master outlives its last probe — past the cadence, so the next probe finds it. */
export const UNIT_CONTROL_PERSIST = '10m';

/** One probe's ceiling: the connect is bounded at 15 s by ssh itself, and `systemctl show` is instant. */
export const UNIT_SSH_TIMEOUT_MS = 30_000;

/**
 * `unit:<host>/<unit>` — a host name (an ssh-safe hostname or alias) and a
 * systemd unit name (letters, digits and `@ . _ : -`, the escape `\` left
 * out). Both start with a letter or a digit, never a dash.
 */
export const UNIT_REF_RE = /^unit:([A-Za-z0-9][A-Za-z0-9._-]{0,62})\/([A-Za-z0-9][A-Za-z0-9@._:-]{0,254})$/;

/** The states a unit is still at work in — the ref lands the first time it is in none of them. */
export const UNIT_RUNNING_STATES = Object.freeze(['activating', 'active', 'reloading', 'deactivating', 'refreshing'] as const);

/** What `systemctl show` is asked for — fixed, so the remote command is too. */
export const UNIT_SHOW_PROPERTIES = Object.freeze([
  'LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainExitTimestamp', 'InactiveEnterTimestamp',
] as const);

export type UnitTarget = { kind: 'unit'; host: string; unit: string; ref: string };

/** A `unit:` ref, parsed — or null for anything the grammar refuses. */
export function parseUnitRef(ref: string): UnitTarget | null {
  const m = UNIT_REF_RE.exec(String(ref ?? ''));
  return m ? { kind: 'unit', host: m[1]!, unit: m[2]!, ref } : null;
}

/** Where a host name leads: the machine profile's `hosts.<name>`, the key's `~` expanded. */
export type UnitHost = { address: string; user?: string; key?: string; port?: number };

/**
 * The profile's answer for one host name, or null when it names none. Read
 * fresh every probe — an operator adding a host is heard at the next pass.
 */
export function unitHostOf(name: string, env: NodeJS.ProcessEnv = process.env): UnitHost | null {
  let profile: unknown;
  try {
    profile = JSON.parse(readFileSync(fleetProfilePath(env), 'utf8'));
  } catch {
    return null;
  }
  const hosts = (profile as { hosts?: unknown } | null)?.hosts;
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return null;
  const entry = (hosts as Record<string, unknown>)[name];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : name;
  // The same shape as the name: whatever reaches ssh's argv is never an option.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(address)) return null;
  const user = typeof raw.user === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(raw.user) ? raw.user : undefined;
  const home = env.HOME || homedir();
  const key = typeof raw.key === 'string' && raw.key.trim()
    ? raw.key.trim().replace(/^~(?=\/)/, home)
    : undefined;
  const port = Number.isInteger(raw.port) && (raw.port as number) > 0 && (raw.port as number) < 65536 ? (raw.port as number) : undefined;
  return {
    address,
    ...(user ? { user } : {}),
    ...(key && key.startsWith('/') ? { key } : {}),
    ...(port ? { port } : {}),
  };
}

/** What `systemctl show` said, the fields this scheme reads. */
export type UnitShow = { loadState?: string; activeState?: string; subState?: string; result?: string; exitedAt?: string };

/**
 * Read `Key=Value` lines. A timestamp in UTC becomes an ISO instant; one in
 * another zone is kept as systemd wrote it — a zone name is not something to
 * guess at.
 */
export function parseUnitShow(stdout: string): UnitShow {
  const values = new Map<string, string>();
  for (const line of String(stdout ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const stamp = values.get('ExecMainExitTimestamp') || values.get('InactiveEnterTimestamp') || '';
  const show: UnitShow = {};
  if (values.get('LoadState')) show.loadState = values.get('LoadState');
  if (values.get('ActiveState')) show.activeState = values.get('ActiveState');
  if (values.get('SubState')) show.subState = values.get('SubState');
  if (values.get('Result')) show.result = values.get('Result');
  if (stamp && stamp !== 'n/a') show.exitedAt = isoOf(stamp);
  return show;
}

function isoOf(stamp: string): string {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (UTC|GMT))?$/.exec(stamp.trim());
  if (m?.[3]) {
    const at = Date.parse(`${m[1]}T${m[2]}Z`);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return stamp.trim().slice(0, 64);
}

/** A verdict on one `unit:` ref — a `WatchState` and, once landed, how the unit ended. */
export type UnitVerdict = {
  ref: string;
  state: WatchStateWord;
  detail?: string;
  unit?: { result: string; exitedAt?: string };
};

/** What `show` means for the ref. */
export function unitVerdict(target: UnitTarget, show: UnitShow): UnitVerdict {
  if (show.loadState === 'not-found') {
    return { ref: target.ref, state: 'refused', detail: `no unit ${target.unit} on ${target.host} — systemd does not know it` };
  }
  if (!show.activeState) return { ref: target.ref, state: 'unknown', detail: `${target.host} answered no ActiveState for ${target.unit}` };
  if ((UNIT_RUNNING_STATES as readonly string[]).includes(show.activeState)) {
    return { ref: target.ref, state: 'pending', detail: `${show.activeState}${show.subState ? ` (${show.subState})` : ''}` };
  }
  const result = show.result || 'unknown';
  return {
    ref: target.ref,
    state: 'landed',
    detail: `Result=${result}${show.exitedAt ? ` · exited ${show.exitedAt}` : ''}`,
    unit: { result, ...(show.exitedAt ? { exitedAt: show.exitedAt } : {}) },
  };
}

/** The ssh argv for one probe — fixed: options, `--`, the address, then `systemctl show … -- <unit>`. */
export function unitSshArgv(host: UnitHost, controlPath: string, unit: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlPersist=${UNIT_CONTROL_PERSIST}`,
    ...(host.user ? ['-l', host.user] : []),
    ...(host.key ? ['-i', host.key] : []),
    ...(host.port ? ['-p', String(host.port)] : []),
    '--', host.address,
    'systemctl', 'show', `--property=${UNIT_SHOW_PROPERTIES.join(',')}`, '--no-pager', '--', unit,
  ];
}

export type UnitExec = (file: string, argv: readonly string[]) => Promise<ShellRun>;

/**
 * The longest Unix socket path, in bytes before its NUL — macOS's `sun_path`
 * is 104 (Linux's 108). OpenSSH binds `<ControlPath>.<16 random characters>`
 * first and renames it, so a path must leave 17 bytes more; one that does not
 * makes ssh exit 255 before the remote command runs, on every probe.
 */
export const UNIT_SOCKET_PATH_MAX = 103;
const SSH_BIND_SUFFIX = 17;
const CONTROL_NAME = 'u-000000000000';

/** Would a master socket in `dir` bind on every platform the console runs on? */
export function controlDirFits(dir: string): boolean {
  return Buffer.byteLength(join(dir, CONTROL_NAME)) + SSH_BIND_SUFFIX <= UNIT_SOCKET_PATH_MAX;
}

/**
 * Where the master sockets live: the instance's own state directory while a
 * socket there fits, else a directory of this user's own under the system's
 * temporary one (per user on macOS) — a named instance's state directory is
 * over seventy bytes, which leaves a socket no room (control-tower phase 121).
 */
export function unitControlDir(
  stateDir: string = INSTANCE_STATE_DIR, temp: string = tmpdir(), uid: number = process.getuid?.() ?? 0,
): string {
  for (const dir of [join(stateDir, 'ssh'), join(temp, `pc-ssh-${uid}`), `/tmp/pc-ssh-${uid}`]) {
    if (controlDirFits(dir)) return dir;
  }
  return `/tmp/pc-ssh-${uid}`;
}

/**
 * Make the socket directory, and refuse one this user does not hold alone: a
 * master socket is a live login to the host, and a directory another account
 * could write would let it plant one.
 */
export function privateControlDir(dir: string): boolean {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* judged below */ }
  try {
    const st = lstatSync(dir);
    const uid = process.getuid?.();
    return st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * ssh's failure in words of its class — never its own text, which names the
 * addresses it resolved, an alias's HostName and the port, none of which may
 * reach a run record. `name` is the profile's host NAME, the ref's own word.
 */
export function sshFailureWords(run: Pick<ShellRun, 'stderr' | 'code' | 'timedOut'>, name: string): string {
  if (run.timedOut) return `ssh to ${name} timed out`;
  const text = String(run.stderr ?? '').toLowerCase();
  const classes: [RegExp, string][] = [
    [/permission denied|authentication fail|too many authentication/, 'refused the login (no prompt is answered in batch mode)'],
    [/host key verification failed|remote host identification has changed/, 'failed host key verification'],
    [/could not resolve|name or service not known|nodename nor servname|no address associated/, 'could not resolve the host'],
    [/connection refused/, 'refused the connection'],
    [/timed out/, 'timed out'],
    [/no route to host|network is unreachable|host is down/, 'could not reach the host'],
    [/too long for unix domain socket|control ?socket|controlpath|mux_client|muxserver/, 'could not use its control socket'],
    [/connection closed|connection reset|broken pipe/, 'lost the connection'],
    [/systemctl: (command )?not found/, 'found no systemctl on the host'],
  ];
  const exit = run.code === null || run.code === undefined ? '' : ` (exit ${run.code})`;
  for (const [pattern, words] of classes) if (pattern.test(text)) return `ssh to ${name} ${words}${exit}`;
  return `ssh to ${name} failed${exit}`;
}

/**
 * The prober: one queue and one master socket per host. The socket's name is
 * a short hash of the host NAME, in a directory chosen so the whole path fits
 * a Unix socket (`unitControlDir`), and says nothing about the address it
 * reaches.
 */
export class UnitProber {
  private readonly exec: UnitExec;
  private readonly profile: (name: string) => UnitHost | null;
  private readonly controlDir: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(deps: {
    exec?: UnitExec; profile?: (name: string) => UnitHost | null; env?: NodeJS.ProcessEnv; controlDir?: string;
  } = {}) {
    this.exec = deps.exec ?? ((file, argv) => shell(file, argv, {
      channel: 'shell', intent: 'watch-unit', timeout: UNIT_SSH_TIMEOUT_MS, env: process.env,
      capture: { keep: 64 * 1024, mode: 'head' }, expectFailure: true,
    }));
    this.profile = deps.profile ?? ((name) => unitHostOf(name, deps.env ?? process.env));
    this.controlDir = deps.controlDir ?? unitControlDir();
  }

  /** The master socket for one host name. */
  controlPathFor(name: string): string {
    return join(this.controlDir, `u-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`);
  }

  /** Ask about one target — queued behind any probe of the same host. */
  probe(target: UnitTarget): Promise<UnitVerdict> {
    const before = this.queues.get(target.host) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => this.ask(target));
    const tail = mine.catch(() => undefined);
    this.queues.set(target.host, tail);
    void tail.then(() => { if (this.queues.get(target.host) === tail) this.queues.delete(target.host); });
    return mine;
  }

  private async ask(target: UnitTarget): Promise<UnitVerdict> {
    let host: UnitHost | null;
    try { host = this.profile(target.host); } catch { host = null; }
    if (!host) {
      return {
        ref: target.ref, state: 'refused',
        detail: `the machine profile names no host "${target.host}" — add it under "hosts" in ~/.config/phase-console/fleet.json`,
      };
    }
    if (!privateControlDir(this.controlDir)) {
      return { ref: target.ref, state: 'unknown', detail: 'the ssh socket directory is not private to this user — nothing was asked' };
    }
    let run: ShellRun;
    try {
      run = await this.exec('ssh', unitSshArgv(host, this.controlPathFor(target.host), target.unit));
    } catch {
      // Never the error's own text: it can carry the argv, the address among it.
      return { ref: target.ref, state: 'unknown', detail: `ssh to ${target.host} could not be started` };
    }
    if (!run.ok) return { ref: target.ref, state: 'unknown', detail: sshFailureWords(run, target.host) };
    return unitVerdict(target, parseUnitShow(run.stdout));
  }
}

/**
 * A landed `unit:` verdict into the wait history: the open entry gains the
 * ref, `Result=` and the exit time — and nothing else, so the history says how
 * the job ended without saying where it ran. False when nothing was written.
 */
export function recordUnitExit(
  record: { waitHistory?: { resumedAt?: string; unit?: { ref: string; result: string; exitedAt?: string } }[] },
  verdict: { ref: string; state: string; unit?: { result: string; exitedAt?: string } },
): boolean {
  if (verdict.state !== 'landed' || !verdict.unit) return false;
  const open = [...(record.waitHistory ?? [])].reverse().find((entry) => !entry.resumedAt);
  if (!open) return false;
  open.unit = { ref: verdict.ref, result: verdict.unit.result, ...(verdict.unit.exitedAt ? { exitedAt: verdict.unit.exitedAt } : {}) };
  return true;
}
