/**
 * A real shell — or an interactive `claude` session — in the browser. Off
 * unless someone asked for it.
 *
 * The console already spawns `claude` sessions that edit repositories for
 * hours; a terminal is not a new class of power on this machine. What it *is*
 * is a new way in, so it gets its own flag (`--allow-terminal`), its own
 * handshake, and a gate that runs on the upgrade request itself.
 *
 * Sessions come in two kinds. A `shell` is exactly what it always was:
 * `$SHELL -l`, no policy but the person typing. A `claude` session runs the
 * interactive CLI from a `LaunchSpec` composed and validated in `agent.ts` —
 * this registry never builds claude argv itself, it only spawns what that
 * module resolved. The two kinds are gated separately (`--allow-terminal` vs
 * `--allow-agent`), and a reattach is gated by the kind of the session it
 * names, not by whichever flag let the caller in.
 *
 * ## Why the token exists
 *
 * A WebSocket upgrade is not a fetch. **CORS does not apply to it**, and the
 * `Origin` header a browser sends on one is not enforced by anything — any
 * other page in the browser, and any local program, can open a socket to
 * 127.0.0.1 and send whatever Origin it likes. So the same-origin check that
 * protects every POST in `api/routes.ts` is worth exactly nothing here.
 *
 * The wall is instead:
 *
 *   1. `POST /api/terminal` — a normal mutation, so it carries the console
 *      header and the same-origin check, needs `--allow-terminal`, and passes
 *      the access gate. It mints a short-lived, single-use token.
 *   2. `GET /ws/terminal?token=…` — the access gate runs **again** on the
 *      upgrade request (so a tailscale identity is enforced on the socket, not
 *      merely on the page that opened it), and only then is the token consumed.
 *
 * A page that cannot make the POST cannot get a token, and a token is spent the
 * moment it is used. Origin is never consulted.
 *
 * ## Why node-pty is imported lazily
 *
 * `node-pty` is a native module. A clone on a machine with no toolchain, or an
 * `npm ci` that skipped optional builds, must still get a working console —
 * losing the terminal is acceptable, losing the board is not. So the import
 * happens on demand and its failure is a reported capability, never a crash.
 *
 * Since Phase 7 that import happens in the **broker** (`pty/broker.ts`), a
 * detached process that owns every pty so a console restart stops killing them.
 * This class is its client. Nothing else about it moved: the two-step token
 * wall, the frame protocol, the resize clamp, the backpressure rule and the
 * retention policy are all still here, because none of them were ever about
 * who held the file descriptor.
 *
 * The one seam that decides which world we are in is `options.spawn`. Injected
 * — every registry test does — the ptys are made in *this* process and are
 * this process's children, so `close()` must still end them. Absent, they
 * belong to the broker and `close()` lets go instead.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { BrokerClient } from './pty/client.ts';
import { SCROLLBACK_BYTES, Scrollback } from './pty/scrollback.ts';
import { healSpawnHelper } from './pty/spawn-helper.ts';
import type { BrokerSession } from './pty/protocol.ts';
import { groupSignal } from './runner/signals.ts';
import { FREEZE_ESCALATE_MS, freezeVerdict } from './runner/freeze.ts';

// Both moved under `pty/` when the broker took ownership — the ring because
// the broker needs the SAME one (a reattach after a restart must render
// identically to one without), the heal because it has to run in whichever
// process will actually `spawn`. Re-exported so every existing import still
// resolves.
export { SCROLLBACK_BYTES, Scrollback, healSpawnHelper };

/** Where the browser opens its socket. One path, no versioning in the URL. */
export const TERMINAL_PATH = '/ws/terminal';

/**
 * Long enough to survive a slow page and a phone waking its radio, short
 * enough that a token found in a log or a screenshot is already dead.
 */
const TOKEN_TTL_MS = 60_000;

/**
 * How long an **ended** session's record is kept when nobody dismisses it.
 *
 * There used to be an idle rule instead, and it was the wrong rule: a detached
 * session — shell or claude — was killed 30 minutes after the last client went
 * away. Closing a laptop lid for lunch was enough to lose a session that was
 * running perfectly well, and the record of one that had finished vanished ~30
 * seconds after it exited, taking its `claude --resume` id with it. A session
 * now stops for exactly two reasons: someone killed it, or the console did.
 *
 * What is left for the sweeper is a ceiling on *records of dead processes*, so
 * a console left running for a month does not hold every shell it ever opened.
 * A day is long enough that "until you dismiss it" is true in every session a
 * person actually comes back to, and short enough to bound the memory.
 */
const EXITED_RETAIN_MS = 24 * 60 * 60_000;

const SWEEP_MS = 30_000;

/**
 * A person has one pair of hands. The cap is not about resources — it is so a
 * bug that mints a session per render cannot fork-bomb the machine.
 *
 * Counted over **live** processes only. An ended session that is still listed
 * so you can read what it said is not holding a pty, and letting it occupy a
 * slot would mean the console refused to open a shell because of eight
 * terminals that all exited yesterday.
 */
const MAX_SESSIONS = 8;

/**
 * How many ended-but-undismissed records are kept at once, oldest evicted
 * first. The retention window above bounds them in time; this bounds them in
 * count, because each carries up to `SCROLLBACK_BYTES` of text.
 */
const MAX_EXITED = 16;

/**
 * Above this much unflushed output the pty is paused until the socket drains.
 * Without it, `cat` on a large file buffers the whole thing in this process
 * because the pty produces far faster than a phone on cellular consumes.
 */
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * The shapes we need from `node-pty` and `ws`
 * ------------------------------------------------------------------ */

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
}

export interface PtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

export type PtySpawn = (file: string, args: string[], options: PtyOptions) => PtyProcess;

/**
 * The socket, as this module uses it. Typing the real `ws` class here would
 * make a type-only import decide whether the module can be loaded at all; this
 * is the whole surface, and `ws`'s WebSocket satisfies it.
 */
export interface Wire {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

/** What a session is running. The wire protocol is identical for both. */
export type SessionKind = 'shell' | 'claude';

/**
 * What a recovery session was launched to put right.
 *
 * Composed by the server (`agent.ts`) and never accepted from a browser, like
 * every other field on `SessionMeta` — this is what links a session back to the
 * thing on the board that needed it, so its exit can be checked against that
 * thing rather than merely reported.
 */
export type RecoveryLink = {
  /** The failure class the action was offered for — `runner/errors.ts` names these. */
  kind: string;
  slug?: string;
  phase?: number;
  runId?: string;
};

/**
 * What a QA session was launched to review, and what was already on file.
 *
 * The snapshot is the reason this link carries more than the target. Without it
 * a phase that already read `pass` would be reported as a pass again by a
 * session that recorded nothing at all — precisely the lie the exit check
 * exists to prevent. Result AND report are both kept, because a re-review that
 * lands the same verdict still writes a new report, and that is the difference
 * between "reviewed again" and "never ran".
 */
export type QaLink = {
  slug: string;
  phase: number;
  /** The recorded result before the session started; absent when there was none. */
  before?: string;
  /** The report path recorded with it — the other half of "did this change?". */
  beforeReport?: string;
  /** Which round this session is producing — absent on a session minted before rounds existed. */
  round?: number;
  /** The report this session was told to write, relative to the handoff folder. */
  report?: string;
};

/** Facts about a claude session the UI needs back, none of them secret. */
export type SessionMeta = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** The uuid handed to `--session-id` — what `claude --resume <id>` takes later. */
  claudeSessionId?: string;
  /**
   * `plan` marks a session booted by the New-plan wizard; `login` marks one
   * minted to sign a Claude account in (`claude auth login` under a profile's
   * `CLAUDE_CONFIG_DIR`) — its exit is what tells the accounts registry to
   * read back who the operator became.
   */
  intent?: 'plan' | 'recovery' | 'qa' | 'login';
  /** The account this session runs as — display + the login exit hook. */
  accountId?: string;
  /**
   * The MCP server a `login` session is signing in — set instead of
   * `accountId` when the thing being authenticated is a server rather than a
   * Claude identity. Its exit is what tells the registry to re-probe.
   */
  mcpServer?: string;
  /**
   * This console wrote the server's definition into the CLI's registry so
   * `claude mcp login <id>` could resolve the name, and owes it back when the
   * flow ends (`mcp/login.ts`). Carried here rather than in service memory
   * because the exit may be the far side of a console restart, and an entry
   * nobody remembers writing is one nobody removes. Absent means the
   * definition was already the operator's, and is never ours to delete.
   */
  mcpBridged?: boolean;
  /** The `CLAUDE_CONFIG_DIR` that sign-in runs in — where the token lands, and
   *  which registry the bridged definition has to be removed from. */
  mcpConfigDir?: string;
  /** Set on a session minted by a recovery action; absent on every other session. */
  recovery?: RecoveryLink;
  /** Set on a session minted to QA one phase; absent on every other session. */
  qa?: QaLink;
  /**
   * Set on a session minted to re-run ONE recorded §Verification command in
   * the operator's own shell. Its exit code is reflected back onto the run
   * record — the whole point of the mint.
   */
  verify?: { slug: string; phase: number; runId?: string; command: string };
};

/**
 * A fully resolved thing to spawn. Composed outside this module (`agent.ts`
 * for claude sessions), so the registry stays what it was: a lifecycle for
 * ptys, never a place that decides argv.
 */
export type LaunchSpec = {
  kind: SessionKind;
  file: string;
  args: string[];
  label?: string;
  meta?: SessionMeta;
  /**
   * Extra environment for the child, merged over the console's own. Composed
   * ONLY on the server (`agent.ts`, the accounts login mint) — a browser never
   * supplies env, the same way it never supplies argv. This is how a session
   * runs as a different Claude account: `CLAUDE_CONFIG_DIR` for a profile,
   * `CLAUDE_CODE_OAUTH_TOKEN` for a token.
   */
  /**
   * `string | undefined` on purpose: the merge below is
   * `{...process.env, ...launch.env}`, so an `undefined` value DELETES an
   * inherited key rather than being absent from the spread. That is how the
   * trace carrier removes a `TRACEPARENT` the operator's own shell exported
   * (`server/trace.ts` `envCarrier`).
   */
  env?: Record<string, string | undefined>;
  /**
   * Where the child starts, overriding the open root. Server-composed only —
   * the verify mint runs a command in the phase's own `Verify in:` directory,
   * and a browser never supplies paths any more than it supplies argv.
   */
  cwd?: string;
};

export interface SessionInfo {
  id: string;
  label: string;
  kind: SessionKind;
  cwd: string;
  /** The spawned file — `$SHELL` for shells, `claude` for agent sessions. */
  shell: string;
  cols: number;
  rows: number;
  pid: number;
  clients: number;
  createdAt: number;
  /**
   * When the pty last produced output. Now that nothing is reaped for being
   * quiet this is no longer a policy input — it is what a list of sessions
   * shows to tell "working" from "waiting at a prompt".
   */
  lastOutputAt: number;
  /** When the last client detached, while none is attached. */
  detachedSince?: number;
  meta?: SessionMeta;
  /**
   * Set once the process is gone. The record OUTLIVES the process until it is
   * dismissed, so the page can say what happened — and, for a claude session,
   * still offer the `--resume` id that is otherwise lost with it.
   */
  exited?: { code: number; signal?: number; closedByOperator?: boolean };
  /** When it ended, so the UI can age it and the sweeper can retire it. */
  exitedAt?: number;
  /**
   * Set while the process group sits under SIGSTOP — who asked and when, so a
   * list can say "frozen · 4m" instead of drawing a spinner over a stopped
   * process. The per-agent twin of the lane's `ChildRef.frozen`.
   */
  frozen?: {
    at: number;
    by: string;
    /**
     * ISO — when this freeze converts to a stop, in the SAME vocabulary and on
     * the same clock as a lane's (`freeze.ts` `FREEZE_ESCALATE_MS`, read by the
     * same `freezeVerdict`).
     *
     * Until this existed a frozen pty session had no owner at all: `freeze()`
     * sent SIGSTOP and wrote a record, and nothing anywhere ever came back to
     * it. A session frozen and forgotten stayed stopped for as long as the
     * console lived, holding its memory and its working tree — the exact
     * incident shape the lane escalation was built to prevent, still open one
     * layer down. The card can now say what happens and when, because there is
     * an answer to both.
     */
    escalateAt: string;
  };
  /** A graceful stop is in flight: SIGTERM sent, SIGKILL armed on a grace. */
  stopping?: { at: number; by: string };
}

interface Session extends SessionInfo {
  pty: PtyProcess;
  scrollback: Scrollback;
  wires: Set<Wire>;
  idleSince: number;
  /** Stamped on every pty chunk — "working" vs "parked", shown rather than acted on. */
  lastOutputAt: number;
  paused: boolean;
  /** The clock that keeps `frozen.escalateAt`'s promise. Cleared by thaw, stop and exit. */
  freezeTimer?: NodeJS.Timeout;
}

/** What just happened to a session. The service turns these into SSE + notifications. */
export type SessionEventType =
  | 'created' | 'attached' | 'detached' | 'exited' | 'killed' | 'dismissed'
  /** A control changed the record without ending it — frozen, thawed, stopping. */
  | 'changed';

export type SessionEvent = {
  type: SessionEventType;
  session: SessionInfo;
  /**
   * On `exited` only: whether the last client had already gone. An exit nobody
   * was watching is the one worth a notification; one you were looking at is
   * not news.
   */
  detached?: boolean;
};

interface Minted {
  token: string;
  sessionId: string;
  expiresAt: number;
}

export type Availability = 'yes' | 'no' | 'unknown';

export interface TerminalOptions {
  /** The shell gate — `--allow-terminal`. */
  allowed: boolean;
  /** The agent gate — `--allow-agent` (via `agentEnabled()`), for `claude` sessions. */
  agentAllowed?: boolean;
  /**
   * The accounts gate — `--allow-accounts`. Admits exactly one shape of claude
   * session: a login mint whose argv the accounts service composed
   * (`claude auth login`). Signing an account in should not require also
   * enabling free-form agent sessions.
   */
  loginAllowed?: boolean;
  /** Where a new session starts — the open source directory, when there is one. */
  cwd?: () => string | undefined;
  /**
   * Environment every session gets under the shell's own, resolved per spawn.
   * The one current use is `PE_MCP_SERVERS` — the registry's enabled ids — so
   * a session (or an operator's shell) running `validate.sh` by hand gets the
   * F15 MCP advisory that was silently dead under launchd's bare env.
   */
  baseEnv?: () => Record<string, string>;
  /**
   * Tests inject a fake — and injecting one also means *this* process owns the
   * ptys, so `close()` still ends them. Production leaves it unset and every
   * pty is the broker's.
   */
  spawn?: PtySpawn;
  /**
   * Where the broker's socket and credential live. One broker per console
   * INSTANCE, never one shared by two — a second console pointed at another
   * project must not find, adopt or kill this one's sessions.
   */
  stateDir?: string;
  /** The broker client, injectable so a test can drive one it started itself. */
  broker?: BrokerClient;
  /**
   * How a signal reaches a session's process — injectable for the same reason
   * `spawn` is: a test must never signal a real pid. The default signals the
   * process GROUP (`kill(-pid)`) and falls back to the pid alone; a pty child
   * is a session leader, so the group is the claude CLI *and* everything it
   * spawned — which is what "freeze this agent" has to mean.
   */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Every lifecycle moment, for the one subscriber that turns them into an SSE
   * event and — where they are worth waking someone for — a notification. A
   * callback rather than an import, so the registry still knows nothing about
   * the service.
   */
  onSession?: (event: SessionEvent) => void;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Minted>();
  private counter = 0;
  private claudeCounter = 0;
  private sweeper: NodeJS.Timeout | undefined;
  private wsModule: Promise<WsServerLike | null> | undefined;
  private probed: Availability = 'unknown';
  private readonly options: TerminalOptions;
  private brokerClient: BrokerClient | null = null;

  constructor(options: TerminalOptions) {
    this.options = options;
    if (options.spawn) this.probed = 'yes';
  }

  /**
   * Whether the ptys are this process's children.
   *
   * The single question every lifecycle decision in this file turns on, asked
   * in one place so the two worlds cannot drift: with an injected spawn they
   * are ours and `close()` must end them; without one they are the broker's
   * and `close()` must not.
   */
  private get inline(): boolean {
    return Boolean(this.options.spawn);
  }

  /** The broker client, made on first use — never merely by existing. */
  private broker(): BrokerClient {
    this.brokerClient ??= this.options.broker
      ?? new BrokerClient(this.options.stateDir ?? INSTANCE_STATE_DIR);
    return this.brokerClient;
  }

  /**
   * Sessions the broker was still holding — the ones a console restart did not
   * kill. Called once at start-up.
   *
   * Deliberately `{ start: false }`: adopting is looking, and looking must
   * never bring a broker into being. A console that has never opened a
   * terminal starts no process here, which is also what keeps every Service
   * built in a test from spawning one.
   */
  async resume(): Promise<number> {
    if (this.inline || !this.anyKindAllowed()) return 0;
    let hello;
    try {
      hello = await this.broker().connect({ start: false });
    } catch (error) {
      log.warn('terminal.resume-failed', { error: message(error) });
      return 0;
    }
    if (!hello) return 0;
    this.probed = hello.pty === 'yes' ? 'yes' : 'no';
    let adopted = 0;
    for (const record of hello.sessions) {
      if (this.sessions.has(record.id)) continue;
      // An ended session's record belongs to the console that saw it end; the
      // broker keeps one only long enough to deliver the news across a
      // reconnect, and adopting a corpse would put a dead row on the board
      // that nobody has any use for.
      if (record.exited) continue;
      this.sessions.set(record.id, this.adopt(record));
      adopted++;
    }
    if (adopted) {
      this.start();
      log.info('terminal.resumed', { adopted });
    }
    return adopted;
  }

  /** Rebuild a session record from what the broker kept, and re-wire its pty. */
  private adopt(record: BrokerSession): Session {
    const blob = (record.meta ?? {}) as { label?: string; kind?: SessionKind; meta?: SessionMeta };
    const kind: SessionKind = blob.kind === 'claude' ? 'claude' : 'shell';
    const handle = this.broker().adopt(record);
    const session: Session = {
      id: record.id,
      label: blob.label ?? (kind === 'claude' ? 'Claude' : 'Terminal'),
      kind,
      ...(blob.meta ? { meta: blob.meta } : {}),
      cwd: record.cwd,
      shell: record.file,
      cols: record.cols,
      rows: record.rows,
      pid: record.pid,
      clients: 0,
      createdAt: record.createdAt,
      pty: handle,
      scrollback: new Scrollback(),
      wires: new Set(),
      idleSince: Date.now(),
      lastOutputAt: record.lastOutputAt,
      paused: false,
    };
    this.wire(session);
    return session;
  }

  get allowed(): boolean {
    return this.options.allowed;
  }

  /**
   * Whether a shell could actually be started, as a fact rather than a promise
   * of one. `unknown` until something has tried — the client shows the flag
   * state until then, which is the only honest thing to show.
   */
  availability(): Availability {
    return this.probed;
  }

  /** The tail of a session's scrollback — what a verify reflection records
   * as the command's output. Empty for an unknown id. */
  outputTail(sessionId: string, bytes = 8_000): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';
    return session.scrollback.text().slice(-bytes);
  }

  /** What `/api/terminal` reports. Never includes a token. */
  state(): {
    allowed: boolean; agentAllowed: boolean; available: Availability;
    sessions: SessionInfo[]; limit: number; live: number;
  } {
    return {
      allowed: this.options.allowed,
      agentAllowed: this.options.agentAllowed === true,
      available: this.probed,
      limit: MAX_SESSIONS,
      // Reported beside the cap because the cap is now about live processes
      // only: `sessions.length` and "how many slots are taken" are different
      // numbers the moment anything has ended.
      live: this.live(),
      sessions: [...this.sessions.values()].map(describe),
    };
  }

  /** Processes still running — what `MAX_SESSIONS` is a cap on. */
  live(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (!session.exited) n++;
    return n;
  }

  /** One place to raise a lifecycle event; a bad listener never reaches a pty. */
  private say(type: SessionEventType, session: Session, detached?: boolean): void {
    try {
      this.options.onSession?.({
        type,
        session: describe(session),
        ...(detached === undefined ? {} : { detached }),
      });
    } catch (error) {
      log.warn('terminal.listener', { id: session.id, type, error: message(error) });
    }
  }

  /* ---------------- the handshake ---------------- */

  /**
   * Mint a single-use ticket for a session, creating one if no id was given.
   *
   * The session is created here rather than on connect so that its output is
   * already buffering while the browser is still loading xterm — and so that a
   * client which never manages to connect leaves something the sweeper can
   * reap, instead of a token that quietly means nothing.
   */
  async mint(sessionId?: string, size?: { cols?: number; rows?: number }, launch?: LaunchSpec): Promise<
    { ok: true; sessionId: string; token: string; expiresAt: number; session: SessionInfo }
    | { ok: false; status: number; error: string }
  > {
    // With every capability off, refuse before looking anything up — whether
    // a session id exists is not discoverable through a disabled feature.
    if (!this.anyKindAllowed()) {
      return { ok: false, status: 403, error: 'The terminal is disabled. Restart with --allow-terminal to enable it.' };
    }

    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      return { ok: false, status: 404, error: 'That terminal session has ended.' };
    }

    // A reattach is gated by what the SESSION is, not by which flag admitted
    // the caller: an agent-only console must not hand out a live shell.
    if (session) {
      const refusal = this.kindRefusal(session.kind, session.meta?.intent);
      if (refusal) return refusal;
    }

    if (!session) {
      const kind: SessionKind = launch?.kind ?? 'shell';
      const refusal = this.kindRefusal(kind, launch?.meta?.intent);
      if (refusal) return refusal;
      // Live processes only: an ended session listed for its exit status is not
      // occupying anything, and refusing a new shell because of it would be a
      // cap on the operator's memory rather than on this machine.
      if (this.live() >= MAX_SESSIONS) {
        return {
          ok: false,
          status: 409,
          error: `Too many live sessions (${MAX_SESSIONS} across shells and agents). Close one first.`,
        };
      }
      if (!(await this.ready())) {
        return {
          ok: false,
          status: 503,
          error: 'node-pty is not installed, so this console cannot open a shell. '
            + 'Run `npm install` in the viewer directory and restart.',
        };
      }
      try {
        session = await this.create(size, launch);
      } catch (error) {
        log.error('terminal.spawn-failed', { error, kind });
        // node-pty's own words here are `posix_spawnp failed.`, which says
        // nothing — for a claude session the overwhelmingly likely cause is
        // worth naming.
        const hint = kind === 'claude'
          ? `Could not start claude — is the \`claude\` CLI on this console's PATH? (${message(error)})`
          : `Could not start a shell: ${message(error)}`;
        return { ok: false, status: 500, error: hint };
      }
    }

    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { token, sessionId: session.id, expiresAt: Date.now() + TOKEN_TTL_MS });
    this.start();
    // The session record travels with the ticket so the caller never has to
    // race its own creation: a client that navigated to the new session and
    // then re-read a not-yet-refetched list would find nothing there and
    // bounce straight back off the page it just opened.
    return {
      ok: true,
      sessionId: session.id,
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      session: describe(session),
    };
  }

  /** The per-kind gate, phrased once so mint's two call sites cannot drift. */
  private kindRefusal(kind: SessionKind, intent?: SessionMeta['intent']): { ok: false; status: number; error: string } | null {
    if (kind === 'claude') {
      // A login mint is the accounts capability wearing a pty, not an agent
      // session: its argv is a fixed `claude auth login` the server composed.
      if (intent === 'login' && this.options.loginAllowed === true) return null;
      return this.options.agentAllowed === true
        ? null
        : { ok: false, status: 403, error: 'Agent sessions are disabled. Restart with --allow-agent to enable them.' };
    }
    return this.options.allowed
      ? null
      : { ok: false, status: 403, error: 'The terminal is disabled. Restart with --allow-terminal to enable it.' };
  }

  private anyKindAllowed(): boolean {
    return this.options.allowed || this.options.agentAllowed === true || this.options.loginAllowed === true;
  }

  /**
   * Spend a ticket. Single-use and constant-time: the map lookup alone would
   * leak nothing useful, but the comparison is the part an attacker controls,
   * so it is the part that is done properly.
   */
  consume(token: string | null | undefined): Session | null {
    if (!token) return null;
    const now = Date.now();
    for (const [key, minted] of this.tokens) {
      if (minted.expiresAt <= now) { this.tokens.delete(key); continue; }
    }
    for (const [key, minted] of this.tokens) {
      if (!equalSecret(key, token)) continue;
      this.tokens.delete(key);
      const session = this.sessions.get(minted.sessionId);
      return session ?? null;
    }
    return null;
  }

  /* ---------------- the socket ---------------- */

  /**
   * Take over an upgrade this console owns.
   *
   * Returns false for a path that is not ours, so the caller can refuse it as a
   * 404 rather than leaving the socket hanging. **The access gate has already
   * run in `server/index.ts` by the time this is called** — this function's job
   * is the flag and the token, in that order, because "the terminal is off"
   * must not be discoverable by guessing tokens.
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> {
    if (url.pathname !== TERMINAL_PATH) return false;

    // Any capability makes the socket path exist; the per-kind decision was
    // already made when the ticket was minted, and a ticket names its session.
    if (!this.anyKindAllowed()) {
      refuse(socket, 403, 'terminal disabled');
      log.warn('terminal.upgrade-refused', { reason: 'disabled' });
      return true;
    }

    const session = this.consume(url.searchParams.get('token'));
    if (!session) {
      refuse(socket, 401, 'bad or expired terminal token');
      // Deliberately without the token itself: a refused handshake is worth
      // recording, a credential in a log file is not.
      log.warn('terminal.upgrade-refused', { reason: 'bad-token', host: req.headers.host });
      return true;
    }

    const server = await this.loadWs();
    if (!server) {
      refuse(socket, 503, 'ws is not installed');
      return true;
    }

    server.handleUpgrade(req, socket, head, (wire: Wire) => { this.attach(session, wire); });
    return true;
  }

  /** Wire a live socket to a session: replay, then pipe both ways. */
  attach(session: Session, wire: Wire): void {
    session.wires.add(wire);
    session.idleSince = 0;

    send(wire, JSON.stringify({
      t: 'hello',
      session: describe(session),
      scrollbackBytes: session.scrollback.bytes,
    }));
    const replay = session.scrollback.text();
    if (replay) send(wire, Buffer.from(replay, 'utf8'));
    if (session.exited) send(wire, JSON.stringify({ t: 'exit', ...session.exited }));

    wire.on('message', (data: unknown, isBinary: boolean) => {
      // Everything the client says is a small JSON envelope. A binary frame
      // from a browser is not something this protocol produces, so it is
      // ignored rather than interpreted as keystrokes.
      if (isBinary) return;
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      this.onClientMessage(session, parsed, wire);
    });

    wire.on('error', (error: Error) => { log.warn('terminal.socket', { id: session.id, error }); });

    wire.on('close', () => {
      session.wires.delete(wire);
      if (!session.wires.size) session.idleSince = Date.now();
      if (session.paused && !session.wires.size) { session.paused = false; session.pty.resume?.(); }
      this.say('detached', session);
    });

    this.say('attached', session);
  }

  private onClientMessage(session: Session, parsed: unknown, wire: Wire): void {
    if (!parsed || typeof parsed !== 'object') return;
    const message_ = parsed as { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };

    // The client's heartbeat. A browser cannot see WebSocket ping/pong frames,
    // and a socket a phone carried into the background can be dead without
    // the browser noticing; this answer is how the client tells a quiet
    // session from a dead one. It touches nothing — not the pty, not the
    // session's clocks — so a client pinging every 30 s changes no record.
    if (message_.t === 'ping') { send(wire, JSON.stringify({ t: 'pong' })); return; }

    if (message_.t === 'i' && typeof message_.d === 'string') {
      if (session.exited) return;
      session.pty.write(message_.d);
      return;
    }

    if (message_.t === 'r') {
      const cols = clampSize(message_.cols, 20, 500);
      const rows = clampSize(message_.rows, 5, 200);
      if (!cols || !rows) return;
      if (cols === session.cols && rows === session.rows) return;
      session.cols = cols;
      session.rows = rows;
      if (session.exited) return;
      // A pty that has already gone rejects a resize; that is not an error
      // worth taking the console down for.
      try { session.pty.resize(cols, rows); } catch (error) { log.warn('terminal.resize', { id: session.id, error }); }
    }
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Stop a session because someone said so — the tab strip's ✕, the dashboard's
   * Kill, or the console going down.
   *
   * The record goes with it. That is the difference between this and an exit
   * the operator did not ask for: a session you closed is not news, and leaving
   * its corpse in the list would mean every deliberate close needed a second
   * click to tidy up. `closedByOperator` is stamped before the kill so the
   * `onExit` that follows a moment later knows not to announce it.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // A SIGSTOPped process cannot act on the hangup `pty.kill()` sends —
    // continue it first, or the close leaves a stopped orphan behind.
    if (session.frozen) { this.signal(session, 'SIGCONT'); this.clearFreezeTimer(session); delete session.frozen; }
    session.exited ??= { code: 0, closedByOperator: true };
    session.exited.closedByOperator = true;
    session.exitedAt ??= Date.now();
    try { session.pty.kill(); } catch { /* already gone */ }
    for (const wire of session.wires) {
      send(wire, JSON.stringify({ t: 'exit', code: 0, closedByOperator: true }));
      try { wire.close(1000, 'closed'); } catch { /* already closing */ }
    }
    this.sessions.delete(id);
    log.info('terminal.closed', { id });
    this.say('killed', session);
    return true;
  }

  /**
   * Drop the record of a session that has already ended.
   *
   * Refuses on a live one: "dismiss" is a UI verb for tidying a list, and a
   * button that quietly killed a working session because it was in the wrong
   * column would be the worst kind of surprise. Killing is `kill()`, and the
   * client asks for it by name.
   */
  dismiss(id: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'no such session' };
    if (!session.exited) return { ok: false, reason: 'that session is still running — close it instead' };
    this.sessions.delete(id);
    log.info('terminal.dismissed', { id });
    this.say('dismissed', session);
    return { ok: true };
  }

  /* ---------------- per-session controls ---------------- */

  private signal(session: Session, signal: NodeJS.Signals): void {
    (this.options.signal ?? groupSignal)(session.pid, signal);
  }

  /**
   * Stop a session's process group where it stands — SIGSTOP, the runner's
   * lane-freeze verb at session size. The record says who and since when, and
   * repeating the verb holds truthfully instead of erroring: the state asked
   * for is the state there is.
   *
   * Held past `escalateMs` it converts to a graceful stop, on the same clock and
   * through the same verdict function a lane freeze uses. `escalateMs` is a
   * parameter for the same reason `stop`'s `graceMs` is one — so a test can
   * prove the escalation without sitting out fifteen real minutes — and it is
   * the WINDOW, never the decision: `freeze.ts` owns that.
   */
  freeze(id: string, by = 'console', escalateMs = FREEZE_ESCALATE_MS): { ok: boolean; reason?: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'no such session' };
    if (session.exited) return { ok: false, reason: 'that session has already ended' };
    if (session.frozen) return { ok: true };
    this.signal(session, 'SIGSTOP');
    const at = Date.now();
    const escalateAt = new Date(at + escalateMs).toISOString();
    session.frozen = { at, by, escalateAt };
    // The promise, and the thing that keeps it. A freeze without one is a
    // process stopped until somebody happens to remember it, which is how a
    // session outlived its console by three and a half hours — the lane half of
    // this was fixed then; the pty half kept the original defect.
    this.armFreezeEscalation(session);
    log.info('terminal.frozen', { id, by, escalateAt });
    this.say('changed', session);
    return { ok: true };
  }

  /** SIGCONT — the session picks up exactly where it stopped. */
  thaw(id: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'no such session' };
    if (session.exited) return { ok: false, reason: 'that session has already ended' };
    if (!session.frozen) return { ok: true };
    this.signal(session, 'SIGCONT');
    this.clearFreezeTimer(session);
    delete session.frozen;
    log.info('terminal.thawed', { id });
    this.say('changed', session);
    return { ok: true };
  }

  /**
   * Keep `frozen.escalateAt`'s promise — the terminal's half of the lane clock.
   *
   * The DECISION is `freezeVerdict`, imported rather than restated: the lane
   * card and the session card make the operator the same promise in the same
   * words, and two implementations of "is this freeze past due" would
   * eventually be two different promises. What differs is only what escalation
   * MEANS here — a pty session has no phase record to checkpoint, so the
   * equivalent of "convert it to something resumable" is the graceful stop,
   * which already wakes before it terminates.
   */
  private armFreezeEscalation(session: Session): void {
    this.clearFreezeTimer(session);
    const verdict = freezeVerdict(session.frozen, Date.now());
    if (verdict.kind === 'none') return;
    if (verdict.kind === 'escalate') { this.escalateFreeze(session); return; }
    session.freezeTimer = setTimeout(() => this.escalateFreeze(session), verdict.inMs);
    session.freezeTimer.unref?.();
  }

  private clearFreezeTimer(session: Session): void {
    if (!session.freezeTimer) return;
    clearTimeout(session.freezeTimer);
    delete session.freezeTimer;
  }

  /** A freeze nobody came back to. `stop()` wakes it first, then ends it politely. */
  private escalateFreeze(session: Session): void {
    this.clearFreezeTimer(session);
    if (!session.frozen || session.exited || session.stopping) return;
    log.info('terminal.freeze-escalated', {
      id: session.id, by: session.frozen.by, afterMs: FREEZE_ESCALATE_MS,
    });
    // `stop()` clears `frozen` and sends SIGCONT before SIGTERM — a stopped
    // process cannot act on a signal it is never scheduled to receive.
    this.stop(session.id, 'freeze-escalation');
  }

  /**
   * End a session politely: SIGCONT first (a stopped process cannot act on
   * anything), SIGTERM, and SIGKILL only after a grace it ignored — the same
   * ladder the runner climbs for a lane.
   *
   * Unlike `kill()`, the record STAYS and the exit flows through `onExit`: a
   * recovery or QA session stopped this way still gets its outcome read
   * against the board, instead of vanishing mid-verdict with its `--resume`
   * id. The service skips the "session failed" announcement for a stop the
   * operator asked for — the exit is the outcome they requested.
   */
  stop(id: string, by = 'console', graceMs = 15_000): { ok: boolean; reason?: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'no such session' };
    if (session.exited) return { ok: false, reason: 'that session has already ended' };
    if (session.stopping) return { ok: true };
    if (session.frozen) { this.signal(session, 'SIGCONT'); this.clearFreezeTimer(session); delete session.frozen; }
    this.signal(session, 'SIGTERM');
    session.stopping = { at: Date.now(), by };
    log.info('terminal.stopping', { id, by });
    this.say('changed', session);
    const escalate = setTimeout(() => {
      if (this.sessions.get(id) !== session || session.exited) return;
      log.warn('terminal.stop-escalated', { id, graceMs });
      this.signal(session, 'SIGKILL');
    }, graceMs);
    escalate.unref?.();
    return { ok: true };
  }

  /**
   * Shutdown — and, since Phase 7, **the sessions stay**.
   *
   * This method used to kill every pty, because every pty was a child of this
   * process and orphaning a login shell holding the source directory open was
   * worse than ending it. Pressing **Restart** therefore ended every shell and
   * every interactive `claude` on the machine — including hours of work — and
   * the dialog did not say so. The broker exists to make that untrue: the
   * processes are its children, so letting go of the socket ends nothing and a
   * console coming back adopts them (`resume()`).
   *
   * With an injected spawn the old rule still holds and still must: those
   * ptys really are this process's children.
   *
   * The sessions a *deliberate* shutdown leaves running are deliberate too.
   * The broker holds them, its idle timer never retires a broker with live
   * sessions, and it exits on its own once the last one ends — so the ceiling
   * is "what the operator started", not "forever". Both dialogs say which
   * sessions survive rather than claiming to stop them.
   */
  close(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
    if (this.inline) {
      for (const id of [...this.sessions.keys()]) this.kill(id);
    } else {
      // Not a kill and not a dismiss: the record goes because THIS console is
      // going, and the process does not.
      for (const session of this.sessions.values()) {
        for (const wire of session.wires) {
          try { wire.close(1001, 'console restarting'); } catch { /* already closing */ }
        }
      }
      this.sessions.clear();
      this.brokerClient?.detach();
      this.brokerClient = null;
    }
    this.tokens.clear();
  }

  /**
   * Whether the sessions this console is showing would survive it going away.
   *
   * The honest input to both the Restart and the Shut-down dialog. It is a
   * property of *how the ptys are owned*, not of the flags, which is why it is
   * asked here rather than derived by the service.
   */
  survivesRestart(): boolean {
    return !this.inline;
  }

  private async create(size?: { cols?: number; rows?: number }, launch?: LaunchSpec): Promise<Session> {
    const kind: SessionKind = launch?.kind ?? 'shell';
    const file = launch?.file ?? (process.env.SHELL || '/bin/sh');
    const args = launch?.args ?? ['-l'];
    const cwd = firstDir([launch?.cwd, this.options.cwd?.(), process.env.HOME, homedir()]);
    const cols = clampSize(size?.cols, 20, 500) ?? 80;
    const rows = clampSize(size?.rows, 5, 200) ?? 24;
    const label = launch?.label ?? (kind === 'claude' ? `Claude ${++this.claudeCounter}` : `Terminal ${++this.counter}`);
    // A login shell that does not know it is on a terminal prints a different
    // prompt and disables colour, so TERM is set here rather than inherited
    // from whatever launchd handed the console. The claude TUI needs the same
    // answer for the same reason. By default the child runs in the home this
    // console did (which is also the home `/api/skills` enumerated); a
    // server-composed `launch.env` — an account's CLAUDE_CONFIG_DIR or token —
    // layers between the two so TERM still wins.
    //
    // Resolved HERE and sent whole, even in broker mode: the broker may have
    // been started by a console that no longer exists, so inheriting *its*
    // environment would run this session under an answer months out of date.
    const env = {
      ...process.env, ...this.options.baseEnv?.(), ...launch?.env,
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
    };

    let pty: PtyProcess;
    let id: string;
    if (this.options.spawn) {
      pty = this.options.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
      id = randomBytes(6).toString('hex');
    } else {
      // The blob is everything the broker must hand back for a restarted
      // console to rebuild this record — and nothing else. It never learns
      // what a `kind` means, only that it has one to return.
      const handle = await this.broker().spawn({
        file, args, cwd, cols, rows, env,
        meta: { label, kind, ...(launch?.meta ? { meta: launch.meta } : {}) },
      });
      pty = handle;
      // The broker's id IS the session id, so a URL that named a terminal
      // still names it after a restart.
      id = handle.sessionId;
    }

    const session: Session = {
      id,
      label,
      kind,
      ...(launch?.meta ? { meta: launch.meta } : {}),
      cwd,
      shell: file,
      cols,
      rows,
      pid: pty.pid,
      clients: 0,
      createdAt: Date.now(),
      pty,
      scrollback: new Scrollback(),
      wires: new Set(),
      idleSince: Date.now(),
      lastOutputAt: Date.now(),
      paused: false,
    };

    this.wire(session);
    this.sessions.set(id, session);
    log.info('terminal.opened', { id, kind, shell: file, cwd, pid: pty.pid, broker: !this.inline });
    this.say('created', session);
    return session;
  }

  /**
   * Pipe a pty's output and exit into a session record.
   *
   * Shared by `create` and `adopt` because an adopted session must behave
   * identically to one this console spawned — the scrollback mirror, the
   * backpressure rule and the exit announcement are the same code, or a
   * terminal would behave differently for having survived a restart.
   */
  private wire(session: Session): void {
    const pty = session.pty;

    pty.onData((data) => {
      session.lastOutputAt = Date.now();
      session.scrollback.push(data);
      const frame = Buffer.from(data, 'utf8');
      let queued = 0;
      for (const wire of session.wires) {
        send(wire, frame);
        queued = Math.max(queued, wire.bufferedAmount ?? 0);
      }
      // Only worth pausing while someone is actually reading: a detached
      // session's output goes straight to the ring, which is already bounded.
      if (session.wires.size && !session.paused && queued > BACKPRESSURE_BYTES) {
        session.paused = true;
        session.pty.pause?.();
        setTimeout(() => { session.paused = false; session.pty.resume?.(); }, 250).unref();
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      // A kill() already stamped this and removed the record; the pty telling
      // us a moment later is not a second event, and must not re-announce a
      // session the operator closed on purpose.
      const closedByOperator = session.exited?.closedByOperator === true;
      session.exited = { code: exitCode, signal, ...(closedByOperator ? { closedByOperator } : {}) };
      session.exitedAt ??= Date.now();
      // A process that has gone cannot be escalated, and a timer that outlives
      // it would `stop()` a dead session's id fifteen minutes later.
      this.clearFreezeTimer(session);
      delete session.frozen;
      for (const wire of session.wires) {
        send(wire, JSON.stringify({ t: 'exit', code: exitCode, signal }));
      }
      if (closedByOperator) return;
      // The record now OUTLIVES the process — until it is dismissed, the
      // retention window closes, or the ceiling evicts it. That is what keeps
      // `claude --resume <uuid>` reachable after the CLI has gone.
      this.retire();
      this.say('exited', session, session.wires.size === 0);
    });
  }

  /** Keep at most `MAX_EXITED` dead records, oldest first out. */
  private retire(): void {
    const dead = [...this.sessions.values()]
      .filter((session) => session.exited)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    for (const session of dead.slice(0, Math.max(0, dead.length - MAX_EXITED))) {
      this.sessions.delete(session.id);
      log.info('terminal.evicted', { id: session.id, kept: MAX_EXITED });
      this.say('dismissed', session);
    }
  }

  private start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (!shouldReap({ wires: session.wires.size, exited: session.exited, exitedAt: session.exitedAt }, now)) continue;
        this.sessions.delete(session.id);
        log.info('terminal.retired', { id: session.id });
        this.say('dismissed', session);
      }
      for (const [key, minted] of this.tokens) {
        if (minted.expiresAt <= now) this.tokens.delete(key);
      }
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  /* ---------------- the lazy natives ---------------- */

  /**
   * Can a pty actually be started? A fact, asked of whoever owns them.
   *
   * The native module is loaded in the **broker** now, so this is a round trip
   * rather than an import — and it is the round trip that starts the broker,
   * which is what "on demand" means. Its failure is still a reported
   * capability and never a crash: losing the terminal is acceptable, losing
   * the board is not.
   */
  private async ready(): Promise<boolean> {
    if (this.options.spawn) return true;
    let hello;
    try {
      hello = await this.broker().connect({ start: true });
    } catch (error) {
      this.probed = 'no';
      log.warn('terminal.no-broker', { error: message(error) });
      return false;
    }
    if (!hello) {
      this.probed = 'no';
      log.warn('terminal.no-broker', { socket: this.broker().address });
      return false;
    }
    this.probed = hello.pty === 'yes' ? 'yes' : 'no';
    if (this.probed === 'no') log.warn('terminal.no-pty', { reason: hello.reason });
    return this.probed === 'yes';
  }

  private loadWs(): Promise<WsServerLike | null> {
    this.wsModule ??= import('ws')
      .then((module_) => {
        const ctor = (module_ as unknown as { WebSocketServer?: WsServerCtor }).WebSocketServer
          ?? (module_ as unknown as { default?: { WebSocketServer?: WsServerCtor } }).default?.WebSocketServer;
        if (!ctor) return null;
        // `noServer` because the console owns the HTTP server and the access
        // gate must run before anything WebSocket-shaped touches the socket.
        return new ctor({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
      })
      .catch((error) => {
        log.warn('terminal.no-ws', { error: message(error) });
        return null;
      });
    return this.wsModule;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface WsServerLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (wire: Wire) => void): void;
}

type WsServerCtor = new (options: {
  noServer: boolean;
  maxPayload: number;
  perMessageDeflate: boolean;
}) => WsServerLike;

function describe(session: Session): SessionInfo {
  return {
    id: session.id,
    label: session.label,
    kind: session.kind,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    pid: session.pid,
    clients: session.wires.size,
    createdAt: session.createdAt,
    lastOutputAt: session.lastOutputAt,
    ...(!session.wires.size && session.idleSince ? { detachedSince: session.idleSince } : {}),
    ...(session.meta ? { meta: session.meta } : {}),
    ...(session.exited ? { exited: session.exited } : {}),
    ...(session.exitedAt ? { exitedAt: session.exitedAt } : {}),
    ...(session.frozen ? { frozen: session.frozen } : {}),
    ...(session.stopping ? { stopping: session.stopping } : {}),
  };
}

/**
 * The default `TerminalOptions.signal`: the whole process group, else the pid.
 *
 * `-pid` reaches the claude CLI *and* the tool subprocesses it spawned — a
 * freeze that stopped the CLI but left a test suite running underneath would
 * be a lie with a spinner on it. ESRCH on the group (an unusual pty backend,
 * a process that changed groups) falls back to the pid alone rather than
 * failing the verb.
 */
// The shape this file worked out for ptys, now shared: `server/runner/signals.ts`
// is the single implementation and the only place in `server/` that signals a
// child. Re-exported under the local name so every call site here is unchanged.
export { groupSignal };

/**
 * Whether the sweeper may drop a session record — pure, so the rule is
 * testable without timers.
 *
 * **A living process is never reaped.** Not a shell, not a claude session, not
 * one nobody is attached to. The old rule killed a detached session after 30
 * idle minutes with a special case that spared a claude which had printed
 * recently, and both halves were wrong for the same reason: whether anyone is
 * *watching* a session says nothing about whether it is still wanted. A phone
 * that went to sleep, a laptop lid closed over lunch, a tab closed on purpose
 * because the thing takes an hour — every one of those looked identical to
 * abandonment, and the session died for it. Sessions now end when someone kills
 * them or when the console goes down, and nothing else.
 *
 * What remains is retention of the DEAD: a record kept so the page can say what
 * happened and hand back a `--resume` id. It is kept until dismissed, and this
 * is the backstop for the ones nobody ever dismisses — with no one attached and
 * the window long past.
 */
export function shouldReap(
  session: { wires: number; exited?: unknown; exitedAt?: number },
  now: number,
  retainMs: number = EXITED_RETAIN_MS,
): boolean {
  if (!session.exited) return false;
  // Someone is reading the ended session's scrollback — the one case where a
  // dead record is actively in use.
  if (session.wires) return false;
  return now - (session.exitedAt ?? now) > retainMs;
}

function send(wire: Wire, data: string | Uint8Array): void {
  // A socket that closed between the check and the write throws synchronously;
  // one dead client must not stop the others being served.
  try { wire.send(data); } catch { /* the close handler will clean it up */ }
}

/** A refusal a browser can actually see, rather than a socket that just dies. */
export function refuse(socket: Duplex, status: number, reason: string): void {
  const text = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\n`
    + 'content-type: text/plain; charset=utf-8\r\n'
    + `content-length: ${Buffer.byteLength(text)}\r\n`
    + 'connection: close\r\n\r\n'
    + text,
  );
  socket.destroy();
}

function equalSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function clampSize(value: unknown, min: number, max: number): number | null {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function firstDir(candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* try the next */ }
  }
  return homedir();
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

