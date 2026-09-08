/**
 * The console's end of the pty broker.
 *
 * `Terminals` used to hold `node-pty` objects. It now holds these, which look
 * exactly like them — `pid`, `onData`, `onExit`, `write`, `resize`, `kill`,
 * `pause`, `resume` — and forward every one of those verbs over a unix socket
 * to the process that really owns the pty (`broker.ts`). That shape is the
 * whole reason the registry barely changed: the ticket wall, the frame
 * protocol, the resize clamping and the backpressure are untouched, and only
 * *ownership* moved.
 *
 * Two things this module owns that the broker cannot:
 *
 *  - **Starting one.** The broker exists on demand. The first thing that wants
 *    a pty spawns it `detached`, with no stdio, `unref`'d, and then waits for
 *    its socket to appear. A console that never opens a terminal never starts
 *    one.
 *  - **Deciding a dropped socket is a death.** A broker that goes away takes
 *    its ptys with it, and a handle that kept reporting "running" would be the
 *    exact class of lie the invariants file is named for — a record outliving
 *    the process it claims. Every live handle is told it exited.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  Lines, PRIVATE_MODE, brokerPaths, frame, parseFrame,
  type BrokerSession, type FromBroker, type ToBroker,
} from './protocol.ts';

/** The `node-pty` surface `terminal.ts` uses, which a handle must satisfy. */
export type PtyLike = {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
};

export type BrokerHandle = PtyLike & {
  /** The broker's id for this session — what `attach`, `signal` and `kill` name. */
  readonly sessionId: string;
};

/** What a successful connection told us. */
export type BrokerHello = {
  pty: 'yes' | 'no';
  reason?: string;
  /** Everything the broker is still holding — the sessions a restart did not kill. */
  sessions: BrokerSession[];
};

/**
 * How long to wait for a freshly spawned broker's socket. The work in between
 * is one `listen()` on a unix socket, so this is generous by an order of
 * magnitude; the cost of it being too short is a terminal that refuses to open
 * on a loaded machine.
 */
const START_TIMEOUT_MS = 5_000;
const RETRY_MS = 50;

/**
 * `broker.ts` when this file is `client.ts`, `broker.js` when it is
 * `client.js`.
 *
 * The packed install runs the emitted `.js` beside each `.ts` (Node refuses to
 * strip types under `node_modules`), so a hard-coded extension would give a
 * console that works from a clone and cannot open a terminal from npm. Deriving
 * it from this module's own URL is the only form that is right in both.
 */
function brokerEntry(): string {
  const here = import.meta.url;
  return fileURLToPath(new URL(here.endsWith('.js') ? './broker.js' : './broker.ts', here));
}

export class BrokerClient {
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly pidPath: string;
  private readonly stateDir: string;
  private readonly entry: string;
  private socket: Socket | null = null;
  private lines = new Lines();
  private hello: BrokerHello | null = null;
  private connecting: Promise<BrokerHello | null> | null = null;
  private readonly handles = new Map<string, Handle>();
  private readonly pendingSpawns = new Map<string, (result: { session: BrokerSession } | { error: string }) => void>();
  /** Set once `detach()` or a broker death has retired this client. */
  private closed = false;

  constructor(stateDir: string, entry = brokerEntry()) {
    this.stateDir = stateDir;
    const paths = brokerPaths(stateDir);
    this.socketPath = paths.socket;
    this.tokenPath = paths.token;
    this.pidPath = paths.pid;
    this.entry = entry;
  }

  /** Where this client is talking — the restart dialog and a test both ask. */
  get address(): string {
    return this.socketPath;
  }

  /**
   * Connect, optionally starting a broker if none answers.
   *
   * `start: false` is the console-boot case: adopt whatever is already there,
   * but never bring a broker into being merely by looking. `start: true` is
   * the first mint.
   */
  connect(options: { start: boolean }): Promise<BrokerHello | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.hello) return Promise.resolve(this.hello);
    this.connecting ??= this.doConnect(options).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(options: { start: boolean }): Promise<BrokerHello | null> {
    // Adopting is looking, and looking costs nothing when there is nothing to
    // look at. Every Service ever constructed calls `resume()`, so the answer
    // for "no broker has ever run here" is one `stat`, not a socket.
    if (!options.start && !existsSync(this.socketPath)) return null;
    let socket = await this.dial();
    if (!socket && options.start) {
      this.startBroker();
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (!socket && Date.now() < deadline) {
        await sleep(RETRY_MS);
        socket = await this.dial();
      }
    }
    if (!socket) return null;
    return this.greet(socket);
  }

  /**
   * One connection attempt.
   *
   * The deadline is CLEARED on success, and that is not tidiness — leaving it
   * armed meant a `socket.destroy()` fired two seconds after a perfectly good
   * connection, on the socket the console was by then using for every
   * terminal it had open. Measured: a shell answered for two seconds and then
   * went silent forever, which reads exactly like a broken pty and is not one.
   */
  private dial(): Promise<Socket | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (answer: Socket | null): void => { if (!settled) { settled = true; resolve(answer); } };
      let socket: Socket;
      try { socket = createConnection(this.socketPath); } catch { done(null); return; }
      const timer = setTimeout(() => { socket.destroy(); done(null); }, 2_000);
      timer.unref?.();
      socket.on('connect', () => { clearTimeout(timer); done(socket); });
      socket.on('error', () => { clearTimeout(timer); socket.destroy(); done(null); });
    });
  }

  private greet(socket: Socket): Promise<BrokerHello | null> {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    this.socket = socket;
    this.lines = new Lines();

    return new Promise<BrokerHello | null>((resolve) => {
      let answered = false;
      let deadline: NodeJS.Timeout | undefined;
      const settle = (answer: BrokerHello | null): void => {
        if (answered) return;
        answered = true;
        // Disarmed the moment the welcome lands. Same defect as `dial`'s, and
        // worse: this one destroys the socket FIVE seconds in, so a console
        // would work, then silently stop hearing from every terminal it owns.
        if (deadline) clearTimeout(deadline);
        // Unref'd only once the handshake is DONE. Doing it on connect meant
        // nothing held the event loop while we waited for the welcome, so a
        // process with no other work exited mid-start with the promise
        // unsettled — measured, and invisible in the console because its HTTP
        // server holds the loop. After the welcome an idle socket must not
        // keep a console alive, which is what this line is for.
        socket.unref();
        resolve(answer);
      };

      socket.on('data', (chunk: string) => {
        const lines = this.lines.push(chunk);
        if (!lines) { socket.destroy(); return; }
        for (const line of lines) {
          const message = parseFrame<FromBroker>(line);
          if (!message) continue;
          if (message.t === 'welcome') {
            this.hello = { pty: message.pty, ...(message.reason ? { reason: message.reason } : {}), sessions: message.sessions };
            settle(this.hello);
            continue;
          }
          this.onMessage(message);
        }
      });
      socket.on('error', () => { /* close does the work */ });
      socket.on('close', () => { this.onSocketGone(); settle(null); });

      deadline = setTimeout(() => { socket.destroy(); settle(null); }, START_TIMEOUT_MS);
      deadline.unref?.();

      this.write({ t: 'hello', cred: this.credential() });
    });
  }

  /**
   * The broker went away, and everything it owned went with it.
   *
   * Reporting the truth loudly is the point: a handle that kept saying
   * "running" over a process that is gone is a record outliving its fact, and
   * the console settles real decisions on these.
   */
  private onSocketGone(): void {
    this.socket = null;
    this.hello = null;
    for (const handle of [...this.handles.values()]) handle.died();
    this.handles.clear();
    for (const [ref, settle] of this.pendingSpawns) {
      settle({ error: 'the pty broker went away before the session started' });
      this.pendingSpawns.delete(ref);
    }
  }

  private onMessage(message: FromBroker): void {
    switch (message.t) {
      case 'output': this.handles.get(message.id)?.feed(message.d); return;
      case 'exit': this.handles.get(message.id)?.finish(message.code, message.signal); return;
      case 'spawned': {
        const settle = this.pendingSpawns.get(message.ref);
        if (!settle) return;
        this.pendingSpawns.delete(message.ref);
        settle({ session: message.session });
        return;
      }
      case 'spawn-failed': {
        const settle = this.pendingSpawns.get(message.ref);
        if (!settle) return;
        this.pendingSpawns.delete(message.ref);
        settle({ error: message.error });
        return;
      }
      default: return;
    }
  }

  /**
   * Start a session in the broker and get a handle that looks like a pty.
   *
   * Rejects rather than returning null on failure, because the caller
   * (`Terminals.create`) already turns a throw into the operator-facing "could
   * not start claude — is it on this console's PATH?" message, and losing that
   * sentence to a null would be a worse console.
   */
  async spawn(request: {
    file: string; args: string[]; cwd: string; cols: number; rows: number;
    env: Record<string, string | undefined>; meta?: unknown;
  }): Promise<BrokerHandle> {
    const hello = await this.connect({ start: true });
    if (!hello) throw new Error('the pty broker could not be started');
    const ref = randomBytes(6).toString('hex');
    // Held open for the round trip. The socket is otherwise `unref`'d — an
    // idle broker connection must not keep a console alive — but a request in
    // flight is real work, and a process whose only outstanding work was this
    // await would exit with the promise unsettled.
    this.socket?.ref();
    const answer = await new Promise<{ session: BrokerSession } | { error: string }>((resolve) => {
      this.pendingSpawns.set(ref, resolve);
      this.write({
        t: 'spawn', ref,
        file: request.file, args: request.args, cwd: request.cwd,
        cols: request.cols, rows: request.rows,
        env: pruneEnv(request.env),
        ...(request.meta === undefined ? {} : { meta: request.meta }),
      });
      const timer = setTimeout(() => {
        if (!this.pendingSpawns.delete(ref)) return;
        resolve({ error: 'the pty broker did not answer' });
      }, START_TIMEOUT_MS);
      timer.unref?.();
    });
    if (!this.pendingSpawns.size) this.socket?.unref();
    if ('error' in answer) throw new Error(answer.error);
    return this.handleFor(answer.session.id, answer.session.pid, { replay: false });
  }

  /** A handle onto a session the broker was already holding — the restart case. */
  adopt(session: BrokerSession): BrokerHandle {
    return this.handleFor(session.id, session.pid, { replay: true });
  }

  private handleFor(id: string, pid: number, options: { replay: boolean }): Handle {
    const existing = this.handles.get(id);
    if (existing) return existing;
    const handle = new Handle(id, pid, (message) => this.write(message));
    this.handles.set(id, handle);
    // A spawn is already attached (the broker adds the spawning client as a
    // watcher), so re-attaching would replay bytes the caller is about to
    // receive live. An adoption must ask.
    if (options.replay) this.write({ t: 'attach', id, replay: true });
    return handle;
  }

  /**
   * Let go without killing anything — the console shutting down.
   *
   * This is the line the whole phase turns on: `Terminals.close()` used to
   * reach every pty and end it, and now it reaches this, which ends nothing.
   */
  detach(): void {
    this.closed = true;
    this.handles.clear();
    this.pendingSpawns.clear();
    const socket = this.socket;
    this.socket = null;
    this.hello = null;
    if (!socket) return;
    socket.removeAllListeners('close');
    try { socket.end(); } catch { /* already gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
  }

  /** Ask the broker to stop and take its sessions with it. Deliberate, and rare. */
  shutdownBroker(): void {
    if (this.socket) this.write({ t: 'shutdown' });
  }

  private write(message: ToBroker): void {
    try { this.socket?.write(frame(message)); } catch { /* the close handler cleans up */ }
  }

  /**
   * The instance's secret, minted once and kept `0600` beside the socket.
   *
   * Read-then-write rather than write-always: a broker already running was
   * started with the value in this file, and replacing it would lock the
   * console out of its own sessions.
   */
  private credential(): string {
    try {
      const existing = readFileSync(this.tokenPath, 'utf8').trim();
      if (existing) return existing;
    } catch { /* mint one below */ }
    const minted = randomBytes(32).toString('hex');
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.tokenPath, `${minted}\n`, { mode: PRIVATE_MODE });
    return minted;
  }

  /**
   * Detached, no stdio, `unref`'d — the three words that make a child outlive
   * its parent, and the same ones `lifecycle.ts` uses for `launchctl bootout`.
   * Without all three the broker would die with the console it was started by,
   * which is precisely the defect.
   */
  private startBroker(): void {
    // Minting before the spawn, not after: the broker reads the credential
    // file at start-up and exits if it is not there.
    const credential = this.credential();
    if (!credential) return;
    try {
      const child = spawnProcess(
        process.execPath,
        [this.entry, '--socket', this.socketPath, '--token', this.tokenPath, '--pid', this.pidPath],
        { detached: true, stdio: 'ignore', env: process.env },
      );
      child.unref();
    } catch { /* the dial loop below reports the failure in the operator's words */ }
  }
}

/* ------------------------------------------------------------------ *
 * The handle
 * ------------------------------------------------------------------ */

/**
 * A pty, as far as `terminal.ts` can tell.
 *
 * Output is queued until a listener is attached. That is not defensive
 * padding: an adopted session replays its whole scrollback the instant it is
 * attached, and the registry registers its `onData` a few statements later.
 * Without the queue, every reattached terminal after a restart would come back
 * blank — the exact thing this phase exists to prevent.
 */
class Handle implements BrokerHandle {
  readonly sessionId: string;
  readonly pid: number;
  private readonly send: (message: ToBroker) => void;
  private data: ((chunk: string) => void) | null = null;
  private exit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  private queued: string[] = [];
  private ended: { exitCode: number; signal?: number } | null = null;

  constructor(id: string, pid: number, send: (message: ToBroker) => void) {
    this.sessionId = id;
    this.pid = pid;
    this.send = send;
  }

  onData(listener: (data: string) => void): void {
    this.data = listener;
    const queued = this.queued;
    this.queued = [];
    for (const chunk of queued) listener(chunk);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exit = listener;
    if (this.ended) listener(this.ended);
  }

  write(data: string): void {
    this.send({ t: 'input', id: this.sessionId, d: data });
  }

  resize(cols: number, rows: number): void {
    this.send({ t: 'resize', id: this.sessionId, cols, rows });
  }

  kill(): void {
    this.send({ t: 'kill', id: this.sessionId });
  }

  pause(): void {
    this.send({ t: 'pause', id: this.sessionId });
  }

  resume(): void {
    this.send({ t: 'resume', id: this.sessionId });
  }

  /** Broker → here. */
  feed(chunk: string): void {
    if (this.data) { this.data(chunk); return; }
    this.queued.push(chunk);
  }

  finish(code: number, signal?: number): void {
    if (this.ended) return;
    this.ended = { exitCode: code, ...(signal === undefined ? {} : { signal }) };
    this.exit?.(this.ended);
  }

  /**
   * The broker died. `129` is `128 + SIGHUP`, the shell convention for "the
   * terminal went away", which is exactly what happened.
   */
  died(): void {
    this.finish(129, 1);
  }
}

/**
 * Deliberately NOT `unref`'d, unlike every other timer in this file.
 *
 * The others are backstops — a deadline that fires only when something has
 * gone wrong, and one of those holding the process up would be a bug. This one
 * is the *progress* of waiting for a broker we just spawned, and a process
 * whose only outstanding work is this await would exit mid-start with the
 * promise unsettled. (Measured: a script that did nothing else printed
 * `Detected unsettled top-level await` and died.) The real console is held up
 * by its HTTP server, which is exactly why this would only ever bite
 * somewhere small and surprising.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** `undefined` is not JSON, and an env var set to nothing is not the same as unset. */
function pruneEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}
