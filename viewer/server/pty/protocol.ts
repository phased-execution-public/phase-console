/**
 * The wire between the console and the pty broker.
 *
 * Two processes, one socket, and a protocol small enough to read in one go.
 * Everything here is shared by both ends — the framing, the envelope shapes,
 * and where the socket and its credential live — so the broker and its client
 * cannot drift apart.
 *
 * ## Why NDJSON and not a binary framing
 *
 * Terminal output arrives from `node-pty` as a **string**, and every consumer
 * downstream of this socket (the scrollback ring, the WebSocket frame the
 * browser gets) wants a string too. A binary framing would buy one fewer copy
 * and cost a length-prefix state machine on both sides; one JSON string per
 * chunk is bounded by the same backpressure that already bounds the socket, and
 * it is inspectable with `nc` when something is wrong at 2am. The one rule the
 * framing must keep is that a chunk is never split, because a half-written
 * escape sequence colours the rest of the session wrong — and a line-delimited
 * frame keeps chunks whole by construction.
 *
 * ## Why there is a credential at all
 *
 * A unix socket is protected by its file mode, and the broker's is `0600`. That
 * is the real wall. The credential is the second one, for the cases the mode
 * does not cover: a `root` process, an NFS-backed state directory whose modes
 * are advisory, and — the one that actually happens — a stale socket file from
 * a *different* console instance that this one would otherwise talk to and
 * take over. A connection that does not present the instance's own secret is
 * closed before it can name a session.
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the console tells the broker to do. */
export type ToBroker =
  /** Always the first line. Anything else on a fresh connection is a hang-up. */
  | { t: 'hello'; cred: string }
  | { t: 'spawn'; ref: string; file: string; args: string[]; cwd: string; cols: number; rows: number; env?: Record<string, string>; meta?: unknown }
  /** Subscribe to a session's output; `replay` asks for its scrollback first. */
  | { t: 'attach'; id: string; replay?: boolean }
  | { t: 'input'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** node-pty's own hang-up, and the record goes with it. */
  | { t: 'kill'; id: string }
  /** A signal to the session's process GROUP — freeze, thaw, the stop ladder. */
  | { t: 'signal'; id: string; sig: string }
  | { t: 'pause'; id: string }
  | { t: 'resume'; id: string }
  | { t: 'ping' }
  /** Stop the broker on purpose — killing every session it owns. Tests, and nothing else yet. */
  | { t: 'shutdown' };

/** What the broker says back. */
export type FromBroker =
  /** The answer to `hello`: whether ptys work here, and what is already running. */
  | { t: 'welcome'; pty: 'yes' | 'no'; reason?: string; sessions: BrokerSession[] }
  | { t: 'spawned'; ref: string; session: BrokerSession }
  | { t: 'spawn-failed'; ref: string; error: string }
  | { t: 'attached'; id: string; scrollbackBytes: number }
  | { t: 'output'; id: string; d: string }
  | { t: 'exit'; id: string; code: number; signal?: number }
  | { t: 'pong' };

/**
 * A session as the broker knows it: a process, a size, and an opaque blob the
 * console handed over at spawn time.
 *
 * `meta` is deliberately `unknown`. The broker owns processes and bytes; it
 * owns no opinion about labels, session kinds, QA links or `--resume` ids. It
 * stores what it was given and hands it back on the next welcome, which is
 * exactly what lets a restarted console rebuild a record it never wrote down.
 */
export type BrokerSession = {
  id: string;
  pid: number;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastOutputAt: number;
  meta?: unknown;
  exited?: { code: number; signal?: number };
};

/** The socket's file mode, and the token file's. Owner only, both. */
export const PRIVATE_MODE = 0o600;

/**
 * How long a broker with no sessions AND no client stays up before exiting.
 *
 * Generous on purpose: the window it has to survive is a console restart, and
 * under launchd that is seconds — but a console being *upgraded* by hand, or a
 * laptop that slept between the stop and the start, is minutes. An idle broker
 * costs one Node process and no work; exiting a second too early costs the
 * operator every terminal they had open, which is the whole defect this
 * removes.
 */
export const BROKER_IDLE_MS = 5 * 60_000;

/**
 * How long an ended session's record is kept so its exit can be delivered.
 *
 * Short, because the console owns retention of dead sessions (it keeps them
 * for a day so `claude --resume <id>` stays reachable) and the broker owns
 * only enough to get the news across a reconnect.
 */
export const BROKER_EXIT_RETAIN_MS = 60_000;

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and a temp-dir sandbox
 * plus an instance id gets close enough to matter. 92 leaves room for the
 * NUL and a margin.
 */
const MAX_SOCKET_PATH = 92;

/**
 * Where the broker listens, where its credential is kept, and where it writes
 * down which process it is.
 *
 * All three belong under the instance's own state directory — one broker per
 * console instance, never one shared by two. The socket falls back to a hashed
 * name in the temp directory when the state directory's path would overrun
 * `sun_path`; the other two never need to, being ordinary files.
 *
 * The pid file is not how anything talks to the broker — that is the socket.
 * It is how a *disposable* instance takes its broker with it. A broker holding
 * a live session deliberately never retires, which is right for an operator's
 * work and wrong for a test sandbox that is about to be deleted, and there is
 * no message that means "you are about to become unreachable".
 */
export function brokerPaths(stateDir: string): {
  socket: string; token: string; pid: string; fellBack: boolean;
} {
  const token = join(stateDir, 'pty.token');
  const pid = join(stateDir, 'pty.pid');
  const preferred = join(stateDir, 'pty.sock');
  if (preferred.length <= MAX_SOCKET_PATH) return { socket: preferred, token, pid, fellBack: false };
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 12);
  return { socket: join(tmpdir(), `pc-pty-${digest}.sock`), token, pid, fellBack: true };
}

/**
 * Split a stream into whole lines, keeping the remainder for the next chunk.
 *
 * A method rather than a generator so the caller's `data` handler stays a plain
 * loop, and stateful because a socket read boundary lands mid-line constantly
 * — that is the entire reason this class exists rather than a `split('\n')`.
 */
export class Lines {
  private buffer = '';
  private readonly limit: number;

  constructor(limit = 8 * 1024 * 1024) {
    this.limit = limit;
  }

  /** Feed bytes, get whole lines. Returns `null` when a single line ran away. */
  push(chunk: string): string[] | null {
    this.buffer += chunk;
    if (this.buffer.length > this.limit) { this.buffer = ''; return null; }
    const out: string[] = [];
    let at = this.buffer.indexOf('\n');
    while (at >= 0) {
      out.push(this.buffer.slice(0, at));
      this.buffer = this.buffer.slice(at + 1);
      at = this.buffer.indexOf('\n');
    }
    return out;
  }
}

/** One envelope, one line. The only encoder either side uses. */
export function frame(message: ToBroker | FromBroker): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parse one line, or `null` if it is not an envelope. Never throws. */
export function parseFrame<T>(line: string): T | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as T;
  } catch {
    return null;
  }
}
