/**
 * The process that owns every pty, so that restarting the console stops
 * killing the terminals it is showing.
 *
 * ## The defect this removes
 *
 * `node-pty` ptys were children of the console. `service.close()` killed them
 * all — with a comment that admitted it — so pressing **Restart** ended every
 * shell and every interactive `claude` session on the machine, including the
 * ones doing hours of work. The restart dialog did not say so, because until
 * Phase 6 nothing had counted them.
 *
 * A process cannot be re-parented after the fact, so the fix is to have it
 * start somewhere else: this file. The broker is spawned `detached` with no
 * stdio and `unref`'d — the same three words `lifecycle.ts` uses to let
 * `launchctl bootout` outlive the console it is unloading, which is the one
 * precedent in the tree for a process that must survive its parent. It owns
 * the ptys, the scrollback and nothing else; the console connects, drives, and
 * disconnects.
 *
 * ## What it deliberately does not know
 *
 * Labels, session kinds, `--resume` ids, QA links, whether a session is an
 * agent or a shell. All of that is the console's, and it travels through here
 * as an opaque `meta` blob that is stored and handed straight back on the next
 * welcome. That split is what lets a console that has never seen a session
 * rebuild its full record after a restart, and it is what keeps this file from
 * growing a second copy of the console's vocabulary.
 *
 * ## Its own lifetime
 *
 * Start on demand (the console spawns it at the first mint), refuse anything
 * that cannot present the instance's credential, and exit once it has neither
 * a client nor a live session for `BROKER_IDLE_MS`. A broker that is holding
 * sessions never exits on idle — nobody watching is the normal state while the
 * console is being restarted, and it is precisely the state it exists for.
 *
 * Run as: `node broker.<ts|js> --socket <path> --token <path>`.
 */

import { appendFileSync, statSync, readFileSync, unlinkSync, chmodSync, truncateSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { groupSignal } from '../runner/signals.ts';
import { Scrollback } from './scrollback.ts';
import { healSpawnHelper } from './spawn-helper.ts';
import {
  BROKER_EXIT_RETAIN_MS, BROKER_IDLE_MS, Lines, PRIVATE_MODE,
  frame, parseFrame, type BrokerSession, type FromBroker, type ToBroker,
} from './protocol.ts';

/* ------------------------------------------------------------------ *
 * The shapes we need from `node-pty` — the same ones `terminal.ts` names
 * ------------------------------------------------------------------ */

type PtyProcess = {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
};

type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> },
) => PtyProcess;

/**
 * Above this much unflushed output on a client socket the pty is paused until
 * it drains. The console has the same rule toward the browser; this is the leg
 * before it, and without it a `cat` on a large file buffers the whole thing in
 * *this* process, which is the one nobody is watching.
 */
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/** A connection that has not said `hello` by then is not a console. */
const HANDSHAKE_MS = 5_000;

const IDLE_CHECK_MS = 15_000;

/** The broker's own log, bounded — nothing else writes to it. */
const LOG_CAP_BYTES = 512 * 1024;

type Live = {
  record: BrokerSession;
  pty: PtyProcess | null;
  scrollback: Scrollback;
  /** Clients receiving this session's output. A set, because a reconnecting console may overlap. */
  watchers: Set<Socket>;
  paused: boolean;
  exitedAt?: number;
};

type Client = {
  socket: Socket;
  lines: Lines;
  greeted: boolean;
};

/* ------------------------------------------------------------------ *
 * The broker
 * ------------------------------------------------------------------ */

export class Broker {
  private readonly sessions = new Map<string, Live>();
  private readonly clients = new Set<Client>();
  private readonly socketPath: string;
  private readonly pidPath: string | undefined;
  private readonly logPath: string;
  private readonly credential: string;
  private readonly idleMs: number;
  private server: Server | null = null;
  private ptyModule: Promise<PtySpawn | null> | undefined;
  private ptyState: 'yes' | 'no' | 'unknown' = 'unknown';
  private ptyReason = '';
  private idleSince: number = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly injectedSpawn: PtySpawn | undefined;

  constructor(options: {
    socketPath: string; credential: string; pidPath?: string;
    logPath?: string; idleMs?: number; spawn?: PtySpawn;
  }) {
    this.socketPath = options.socketPath;
    this.pidPath = options.pidPath;
    this.credential = options.credential;
    this.logPath = options.logPath ?? join(dirname(options.socketPath), 'pty-broker.log');
    this.idleMs = options.idleMs ?? BROKER_IDLE_MS;
    this.injectedSpawn = options.spawn;
    if (options.spawn) this.ptyState = 'yes';
  }

  /**
   * Take the socket, or discover that somebody else already has it.
   *
   * `EADDRINUSE` on a unix socket says nothing about whether the owner is
   * alive — a killed broker leaves the file behind — so the file is *probed*
   * with a connection rather than trusted or deleted on sight. Deleting a
   * live broker's socket would leave every session it holds unreachable, with
   * the processes still running and nothing able to address them.
   */
  async listen(): Promise<'listening' | 'incumbent'> {
    const taken = await this.probe();
    if (taken) return 'incumbent';
    try { unlinkSync(this.socketPath); } catch { /* nothing to clear */ }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      server.on('error', reject);
      server.listen(this.socketPath, () => { this.server = server; resolve(); });
    });
    // The real wall. The credential is the second one — see protocol.ts.
    try { chmodSync(this.socketPath, PRIVATE_MODE); } catch { /* a platform without modes */ }
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    // Written only once the socket is OURS, so the file never names a process
    // that lost the race. It is how a disposable instance — every test
    // sandbox — takes its broker with it: a broker holding a live session
    // deliberately never retires, which is right for an operator's work and
    // wrong for a temp directory that is about to be deleted.
    if (this.pidPath) {
      try { writeFileSync(this.pidPath, `${process.pid}\n`, { mode: PRIVATE_MODE }); } catch { /* advisory */ }
    }
    this.say('broker.listening', { socket: this.socketPath, pid: process.pid });
    return 'listening';
  }

  /** Is a LIVE broker already on this socket? A refused connection means no. */
  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (answer: boolean): void => { if (!settled) { settled = true; resolve(answer); } };
      let socket: Socket;
      try { socket = createConnection(this.socketPath); } catch { done(false); return; }
      const timer = setTimeout(() => { socket.destroy(); done(false); }, 1_000);
      timer.unref?.();
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); done(true); });
      socket.on('error', () => { clearTimeout(timer); socket.destroy(); done(false); });
    });
  }

  /* ---------------- clients ---------------- */

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    const client: Client = { socket, lines: new Lines(), greeted: false };
    this.clients.add(client);
    this.idleSince = 0;

    // A connection that never identifies itself holds a slot and nothing else;
    // it is dropped rather than waited on.
    const handshake = setTimeout(() => {
      if (!client.greeted) { this.say('broker.handshake-timeout', {}); socket.destroy(); }
    }, HANDSHAKE_MS);
    handshake.unref?.();

    socket.on('data', (chunk: string) => {
      const lines = client.lines.push(chunk);
      if (!lines) { this.say('broker.oversized-frame', {}); socket.destroy(); return; }
      for (const line of lines) this.onLine(client, line);
    });
    socket.on('error', () => { /* the close handler cleans up */ });
    socket.on('close', () => {
      clearTimeout(handshake);
      this.clients.delete(client);
      for (const live of this.sessions.values()) live.watchers.delete(socket);
      if (!this.clients.size) this.idleSince = Date.now();
    });
  }

  private onLine(client: Client, line: string): void {
    const message = parseFrame<ToBroker>(line);
    if (!message || typeof message.t !== 'string') return;

    if (!client.greeted) {
      // Constant-time, and the ONLY verb admitted before the handshake: an
      // unauthenticated peer must not be able to name a session, not even to
      // learn whether it exists.
      if (message.t !== 'hello' || !equalSecret(this.credential, String((message as { cred?: unknown }).cred ?? ''))) {
        this.say('broker.refused', { reason: message.t === 'hello' ? 'bad-credential' : 'no-hello' });
        client.socket.destroy();
        return;
      }
      client.greeted = true;
      void this.welcome(client);
      return;
    }

    switch (message.t) {
      case 'ping': this.send(client.socket, { t: 'pong' }); return;
      case 'spawn': void this.spawn(client, message); return;
      case 'attach': this.attach(client, message.id, message.replay !== false); return;
      case 'input': {
        const live = this.sessions.get(message.id);
        if (!live?.pty || live.record.exited) return;
        try { live.pty.write(message.d); } catch { /* the pty is going away */ }
        return;
      }
      case 'resize': {
        const live = this.sessions.get(message.id);
        if (!live) return;
        live.record.cols = message.cols;
        live.record.rows = message.rows;
        if (!live.pty || live.record.exited) return;
        try { live.pty.resize(message.cols, message.rows); } catch { /* already gone */ }
        return;
      }
      case 'kill': this.kill(message.id); return;
      case 'signal': {
        const live = this.sessions.get(message.id);
        if (!live || live.record.exited) return;
        // `signals.ts` is the only signaller in `server/`, here as everywhere.
        groupSignal(live.record.pid, message.sig as NodeJS.Signals);
        return;
      }
      case 'pause': {
        const live = this.sessions.get(message.id);
        if (live?.pty && !live.paused) { live.paused = true; live.pty.pause?.(); }
        return;
      }
      case 'resume': {
        const live = this.sessions.get(message.id);
        if (live?.pty && live.paused) { live.paused = false; live.pty.resume?.(); }
        return;
      }
      case 'shutdown': this.close('asked'); return;
      default: return;
    }
  }

  private async welcome(client: Client): Promise<void> {
    // Probing node-pty here rather than at start-up keeps the answer a fact
    // about *this* machine at the moment it is asked, and it is the answer the
    // console turns into `availability()`.
    await this.loadPty();
    this.send(client.socket, {
      t: 'welcome',
      pty: this.ptyState === 'yes' ? 'yes' : 'no',
      ...(this.ptyReason ? { reason: this.ptyReason } : {}),
      sessions: [...this.sessions.values()].map((live) => ({ ...live.record })),
    });
  }

  /* ---------------- sessions ---------------- */

  private async spawn(client: Client, message: Extract<ToBroker, { t: 'spawn' }>): Promise<void> {
    const spawn = await this.loadPty();
    if (!spawn) {
      this.send(client.socket, { t: 'spawn-failed', ref: message.ref, error: this.ptyReason || 'node-pty is not available' });
      return;
    }
    let pty: PtyProcess;
    try {
      pty = spawn(message.file, message.args, {
        name: 'xterm-256color',
        cols: message.cols,
        rows: message.rows,
        cwd: message.cwd,
        // The console resolves the whole environment and sends it whole, so a
        // session spawned after a restart runs under the NEW console's answer
        // rather than whatever the broker was started with months ago.
        env: message.env ?? {},
      });
    } catch (error) {
      this.send(client.socket, { t: 'spawn-failed', ref: message.ref, error: describe(error) });
      return;
    }

    const id = randomBytes(6).toString('hex');
    const now = Date.now();
    const live: Live = {
      record: {
        id, pid: pty.pid, file: message.file, args: message.args, cwd: message.cwd,
        cols: message.cols, rows: message.rows, createdAt: now, lastOutputAt: now,
        ...(message.meta === undefined ? {} : { meta: message.meta }),
      },
      pty,
      scrollback: new Scrollback(),
      watchers: new Set([client.socket]),
      paused: false,
    };
    this.sessions.set(id, live);
    this.idleSince = 0;

    pty.onData((data) => {
      live.record.lastOutputAt = Date.now();
      live.scrollback.push(data);
      let queued = 0;
      for (const watcher of live.watchers) {
        this.send(watcher, { t: 'output', id, d: data });
        queued = Math.max(queued, watcher.writableLength ?? 0);
      }
      // Only worth pausing while somebody is reading: a detached session's
      // output goes straight to the ring, which is already bounded.
      if (live.watchers.size && !live.paused && queued > BACKPRESSURE_BYTES) {
        live.paused = true;
        live.pty?.pause?.();
        const resume = setTimeout(() => { live.paused = false; live.pty?.resume?.(); }, 250);
        resume.unref?.();
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      live.record.exited = { code: exitCode, ...(signal === undefined ? {} : { signal }) };
      live.exitedAt = Date.now();
      live.pty = null;
      for (const watcher of live.watchers) {
        this.send(watcher, { t: 'exit', id, code: exitCode, ...(signal === undefined ? {} : { signal }) });
      }
      if (!this.liveCount() && !this.clients.size) this.idleSince = Date.now();
      this.say('broker.exited', { id, code: exitCode });
    });

    this.say('broker.spawned', { id, pid: pty.pid, file: message.file });
    this.send(client.socket, { t: 'spawned', ref: message.ref, session: { ...live.record } });
  }

  private attach(client: Client, id: string, replay: boolean): void {
    const live = this.sessions.get(id);
    if (!live) return;
    live.watchers.add(client.socket);
    this.send(client.socket, { t: 'attached', id, scrollbackBytes: live.scrollback.bytes });
    if (replay) {
      const text = live.scrollback.text();
      // One frame, not many: the reconnecting console rebuilds its own mirror
      // from this and a split here would be a split escape sequence there.
      if (text) this.send(client.socket, { t: 'output', id, d: text });
    }
    if (live.record.exited) {
      this.send(client.socket, {
        t: 'exit', id, code: live.record.exited.code,
        ...(live.record.exited.signal === undefined ? {} : { signal: live.record.exited.signal }),
      });
    }
  }

  /**
   * End a session and drop its record — the console's own `kill()`, which is
   * the operator saying so.
   *
   * The hang-up goes through node-pty's own `kill()` rather than the ladder:
   * a pty is not a child this process `spawn`ed with a pipe, it is a terminal,
   * and closing the master is how a terminal ends. A frozen session is woken
   * first, because a stopped process cannot act on a hangup.
   */
  private kill(id: string): void {
    const live = this.sessions.get(id);
    if (!live) return;
    if (live.pty) {
      groupSignal(live.record.pid, 'SIGCONT');
      try { live.pty.kill(); } catch { /* already gone */ }
      // The hangup is a request; this is the promise. A shell adopted across
      // console restarts has outlived its SIGHUP on Linux (CI, ubuntu): if the
      // pty has not reported its own exit shortly, end the whole group. The
      // guard is the pty's OWN exit record — never a pid probe — so a pid
      // recycled into the same number is never signalled by mistake.
      const backstop = setTimeout(() => {
        if (live.record.exited) return;
        groupSignal(live.record.pid, 'SIGKILL');
      }, 1_500);
      backstop.unref();
    }
    this.sessions.delete(id);
    if (!this.liveCount() && !this.clients.size) this.idleSince = Date.now();
    this.say('broker.killed', { id });
  }

  private liveCount(): number {
    let n = 0;
    for (const live of this.sessions.values()) if (!live.record.exited) n++;
    return n;
  }

  /* ---------------- lifetime ---------------- */

  private checkIdle(): void {
    const now = Date.now();
    for (const [id, live] of this.sessions) {
      if (live.exitedAt && now - live.exitedAt > BROKER_EXIT_RETAIN_MS) this.sessions.delete(id);
    }
    // A broker holding sessions never exits on idle. Nobody watching is the
    // NORMAL state while the console is being restarted — it is the state this
    // process exists for.
    if (this.clients.size || this.liveCount()) { this.idleSince = 0; return; }
    if (!this.idleSince) { this.idleSince = now; return; }
    if (now - this.idleSince < this.idleMs) return;
    this.close('idle');
  }

  /** Stop for good: every session goes, because nothing will be left to own them. */
  close(reason: string): void {
    this.say('broker.closing', { reason, sessions: this.sessions.size });
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
    for (const id of [...this.sessions.keys()]) this.kill(id);
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    try { unlinkSync(this.socketPath); } catch { /* already unlinked */ }
    if (this.pidPath) { try { unlinkSync(this.pidPath); } catch { /* already gone */ } }
  }

  /* ---------------- plumbing ---------------- */

  private send(socket: Socket, message: FromBroker): void {
    // A socket that closed between the check and the write throws
    // synchronously; one dead console must not stop a session being served.
    try { socket.write(frame(message)); } catch { /* the close handler cleans up */ }
  }

  private loadPty(): Promise<PtySpawn | null> {
    if (this.injectedSpawn) return Promise.resolve(this.injectedSpawn);
    this.ptyModule ??= import('node-pty')
      .then((module_) => {
        const spawn = (module_ as unknown as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } }).spawn
          ?? (module_ as unknown as { default?: { spawn?: PtySpawn } }).default?.spawn
          ?? null;
        if (spawn) {
          // The heal belongs in whichever process will actually spawn, and
          // that is this one now — see `pty/spawn-helper.ts`.
          const healed = healSpawnHelper();
          if (healed) this.say('broker.healed-spawn-helper', { path: healed });
          this.ptyState = 'yes';
        } else {
          this.ptyState = 'no';
          this.ptyReason = 'node-pty exports no spawn';
        }
        return spawn;
      })
      .catch((error) => {
        this.ptyState = 'no';
        this.ptyReason = describe(error);
        return null;
      });
    return this.ptyModule;
  }

  /**
   * The broker's own log — deliberately not `log.ts`, which reaches
   * `config.ts` and would have this process re-resolve (and possibly claim)
   * a console instance it is not.
   */
  private say(event: string, fields: Record<string, unknown>): void {
    try {
      if (statSync(this.logPath).size > LOG_CAP_BYTES) truncateSync(this.logPath, 0);
    } catch { /* no log yet */ }
    try {
      appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: PRIVATE_MODE });
    } catch { /* a log that cannot be written is not worth a crash */ }
  }
}

function equalSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function describe(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/**
 * `import.meta.main` is Node 24+; this is the portable form, and it keeps the
 * class importable by a test without the module trying to bind a socket.
 */
const invokedDirectly = process.argv[1] !== undefined
  && (process.argv[1].endsWith('broker.ts') || process.argv[1].endsWith('broker.js'));

if (invokedDirectly) {
  const socketPath = flag('socket');
  const tokenPath = flag('token');
  if (!socketPath || !tokenPath) {
    process.stderr.write('pty broker: --socket and --token are required\n');
    process.exit(2);
  }
  let credential = '';
  try { credential = readFileSync(tokenPath, 'utf8').trim(); } catch { /* handled below */ }
  if (!credential) {
    process.stderr.write('pty broker: the credential file is missing or empty\n');
    process.exit(2);
  }
  const idle = Number(process.env.PHASE_CONSOLE_PTY_IDLE_MS);
  const broker = new Broker({
    socketPath,
    credential,
    ...(flag('pid') ? { pidPath: flag('pid') as string } : {}),
    ...(Number.isFinite(idle) && idle > 0 ? { idleMs: idle } : {}),
  });
  // A broker that loses the race is not an error: the console asked for one to
  // exist, and one does.
  broker.listen().then((outcome) => {
    if (outcome === 'incumbent') process.exit(0);
  }).catch((error) => {
    process.stderr.write(`pty broker: ${describe(error)}\n`);
    process.exit(1);
  });
  // Ending on purpose is `shutdown`; a signal from outside kills the sessions
  // too, because nothing would be left to own them.
  process.on('SIGTERM', () => { broker.close('SIGTERM'); process.exit(0); });
  process.on('SIGINT', () => { broker.close('SIGINT'); process.exit(0); });
}
