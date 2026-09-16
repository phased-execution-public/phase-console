/**
 * One phase, one `claude -p` process.
 *
 * This is where "clear the session between phases" is implemented, and the
 * implementation is that there is nothing to implement: the process exits, and
 * with it the context. There is no `/clear` to send and no session to reset —
 * each phase starts from a boot prompt and the files on disk, which is exactly
 * the contract `phased-execution` already assumes.
 *
 * ## Why the prompt goes down stdin rather than argv
 *
 * The phase is driven in **streaming-input mode** (`--input-format stream-json`),
 * which keeps stdin open for the life of the session. That is the only way to
 * say anything to a session once it has started — which is what the console's
 * `/btw` box does — and it costs nothing when nobody says anything.
 *
 * Measured, because the behaviour is not obvious: in that mode a positional
 * prompt (`-p "…"`) is **silently ignored** and only stdin is read. So the boot
 * prompt is written as the first NDJSON message, and passing it positionally
 * would look right and run the wrong thing. Each further message becomes a new
 * turn in the *same* session, with the context and the prompt cache intact, and
 * each turn ends with its own `result` message — so a `result` here means "a
 * turn finished", never "the process is finished".
 *
 * Three flags are never passed, whatever the caller asks for, plus one value:
 *
 *   --bare                         skips settings, and with them the repo's
 *                                  PreToolUse hooks — including the destructive
 *                                  -operation guard this monorepo relies on.
 *   --safe-mode                    disables hooks, skills and plugins wholesale.
 *   --setting-sources              can drop the repository's own settings.
 *   --permission-mode bypassPermissions   everything, unreviewed.
 *
 * They are stripped in one place, `sanitize()`, so no future caller can
 * reintroduce them by passing extra arguments.
 *
 * One flag is passed on the RUN's behalf rather than stripped: `--permission-prompts
 * none` rides every session no relay answers (`permissionPrompts`, decided by
 * `permissionPromptsFor` at the one spawn door), so anything that would prompt
 * is refused and the session is told nobody can approve. Its opposite rides a
 * session the relay IS armed for (phase 14): `--permission-prompt-tool` naming
 * the console's presence-only host (`permissionPromptTool`), which is what makes
 * the CLI offer `AskUserQuestion` in `-p`. Never both.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { SPAWN_FIRST_EVENT_MS, SPAWN_INIT_IDLE_MS } from '../../shared/attention-model.js';
import { isProductiveEvent } from './liveness.ts';
import { MAX_TASKS, MAX_TASK_TEXT } from '../../shared/task-model.js';
import { ENDED_BY, type EndedBy } from '../../shared/run-lifecycle.js';
import { log } from '../log.ts';
import { API_RETRY_ERRORS, childEnv, type PermissionDenial, type StopSignal } from './errors.ts';
import { DEFAULT_KILL_AFTER_MS, INT_GRACE_MS, forgetInterrupt, groupSignal, interruptOnce, wakeAndTerm } from './signals.ts';
import { resolveCaps, type SessionCaps } from './session-record.ts';
import { PERMISSION_MODES, type PERMISSION_PROFILES } from '../../shared/run-settings.js';

type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

/** Boolean flags that take the guard rails off, regardless of who asked. */
const FORBIDDEN = [
  '--bare',
  '--safe-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-allow-browser-tool-in-non-sandboxed-mode',
];

/**
 * Forbidden flags that consume the next argument. Dropping the flag alone
 * would leave its value loose in argv, where it becomes a positional prompt.
 */
const FORBIDDEN_WITH_VALUE = ['--setting-sources'];

/**
 * Values that must never be given to an otherwise legitimate flag. Rewritten
 * rather than dropped: removing `--permission-mode` entirely would fall back to
 * the interactive default, which in headless mode is a silent refusal of every
 * edit — a fix that quietly breaks every run is not a fix.
 *
 * `bypassPermissions` is the one entry that a caller may now unlock, and only
 * by choosing the `bypass` profile for the run — see `SanitizeOptions`. It is
 * still listed here rather than special-cased at the call site, so `sanitize()`
 * remains the one place to audit.
 */
const FORBIDDEN_VALUES: Record<string, { values: string[]; safe: string; unlockedBy?: keyof SanitizeOptions }> = {
  '--permission-mode': { values: ['bypassPermissions'], safe: 'acceptEdits', unlockedBy: 'allowBypass' },
};

/**
 * The CLI's own words when it refuses the bypass mode it was handed.
 *
 * Measured, and it matters more than it looks: `bypassPermissions` requires a
 * disclaimer that can only be accepted **interactively**, once, on this
 * machine. Without it the CLI does not error and does not fall back to what we
 * asked for — it silently downgrades to `default`, and `default` in `-p` mode
 * means prompting a terminal that is not there, which is a refusal of every
 * edit. So the Bypass profile, on a machine where nobody ever accepted the
 * disclaimer, produces a run that can do **less** than Guarded and gives no
 * obvious reason why. Detecting the CLI's own line is the only honest signal
 * available: the flag is accepted, the argv looks right, and the run just
 * quietly cannot work.
 */
const BYPASS_DOWNGRADED = /Permission mode downgraded to default/i;

/** Did the CLI just tell us it refused the bypass mode we asked for? */
export function isBypassDowngrade(text: string): boolean {
  return BYPASS_DOWNGRADED.test(text);
}

/**
 * The retry category the CLI did not name, read out of what it DID say.
 *
 * The CLI reports `api_retry` with a category most of the time and without one
 * often enough to matter — measured across this console's own runs, a lane can
 * emit hundreds of uncategorised retries — and every consumer downstream keys
 * on the category. `liveWall` only acts on `rate_limit`; `evaluateStall`'s
 * `retrying` detail is the operator's only clue what the storm IS. An
 * uncategorised retry therefore read as "something transient", which is the one
 * answer that is never actionable.
 *
 * Inference is deliberately conservative and deliberately visible: three
 * patterns, each unambiguous in the CLI's own error text, and the event carries
 * `inferred: true` so nothing downstream can mistake a guess for the CLI's own
 * verdict. Anything else stays uncategorised, because a wrong category is worse
 * than none — it would send `liveWall` after an account switch for a capacity
 * problem another account has too.
 */
/**
 * The CLI's own permission refusal, as a tool result: "Claude requested
 * permissions to use Bash, but you haven't granted it yet", "…to write to
 * <path>…", "…to edit <path> which is a sensitive file". Anchored at the start
 * and kept to the CLI's framing on purpose — an INTERRUPTED call's result says
 * "The user doesn't want to proceed with this tool use. The tool use was
 * rejected" (measured, `test/fixtures/spikes/sigint.md`), and reading that as a
 * refusal would file every console stop as a permission wall.
 */
const REFUSAL_RE = /^Claude requested permissions to (?:use|write to|edit|read)\b/;

export function inferRetryCategory(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const text = detail.toLowerCase();
  // Order matters only here: a 429 body often says "overloaded" too, and the
  // quota reading is the one with a remedy (another account pays), so it wins.
  if (/rate.?limit|\b429\b|too many requests/.test(text)) return 'rate_limit';
  if (/overloaded|\b529\b|capacity/.test(text)) return 'overloaded';
  if (/\bauth|unauthor|forbidden|\b401\b|\b403\b|invalid.{0,10}(api.?key|token|credential)/.test(text)) {
    return 'authentication_failed';
  }
  return undefined;
}

function noteBypassDowngrade(emit: (event: StreamEvent) => void): void {
  log.warn('spawn.bypass-downgraded', {
    note: 'the CLI refused bypassPermissions and fell back to `default`, which in -p mode refuses '
      + 'every edit. The bypass disclaimer has to be accepted once, interactively, in a normal '
      + '`claude` session on this machine. Until then, use the Trusted profile.',
  });
  emit({
    kind: 'idle',
    afterMs: 0,
    reason: 'the CLI refused bypassPermissions (its disclaimer has never been accepted on this '
      + 'machine) and downgraded to `default`, which refuses every edit in headless mode — '
      + 'switch this run to Trusted',
  });
}

/**
 * The deliberate exceptions, named rather than implied.
 *
 * This reverses a safety choice — the whole reason the rewrite existed was that
 * nothing should be able to ask for `bypassPermissions`. It is unlocked only by
 * an operator picking the `bypass` profile, it is journaled where it happens,
 * and the run's own header says so for as long as it is in force. Everything
 * else in `FORBIDDEN` and `FORBIDDEN_WITH_VALUE` stays unconditional: those
 * flags disable the repository's hooks, which is not a preference anyone gets.
 */
export type SanitizeOptions = {
  /** Let `--permission-mode bypassPermissions` through. `bypass` profile only. */
  allowBypass?: boolean;
};

/** What the CLI accepts; anything else is only a warning there, so check here. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export { PERMISSION_MODES };
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The tag every operator message carries into the session, and carries back out.
 *
 * Two problems it solves at once. Going in, the CLI's `--replay-user-messages`
 * echo is the only proof a message landed — but the echo used to be recognised
 * by *position* ("the first one is the boot prompt"), which is wrong the moment
 * a session is resumed or restarted on another model and the CLI replays a
 * history rather than one message. A tag is positional-independent: an echo is
 * ours if and only if it carries a tag we are still waiting on.
 *
 * Coming back, the session is asked to repeat the tag at the head of its reply,
 * which is what turns "some text somewhere in the phase's output" into an
 * answer the console can attribute to the question that caused it.
 */
export const OPERATOR_MARK = /\[\[(ask|steer|relay):([0-9a-z]{4,16})\]\]/i;

/** The tag in a piece of text, normalised, or null. */
export function operatorMark(text: string): string | null {
  const found = OPERATOR_MARK.exec(text);
  return found ? `${found[1].toLowerCase()}:${found[2].toLowerCase()}` : null;
}

/**
 * Build the tag for one operator message. `relay` is the console's own notice
 * after the relay answered a question nobody did (phase 14) — tagged like the
 * others so its echo is recognised, never an answer the console waits for.
 */
export function markFor(kind: 'ask' | 'steer' | 'relay', id: string): string {
  return `[[${kind}:${id}]]`;
}

/**
 * One entry of the session's own task list.
 *
 * Kept to the three fields the CLI actually writes, and bounded at this end
 * rather than the reader's: the list goes into the transcript, which is
 * replayed into a browser, and a producer that trusts its consumer to cope is
 * how a console line becomes a log file.
 */
export type TodoItem = { content: string; status: string; activeForm?: string };

export type StreamEvent =
  | {
    kind: 'init';
    sessionId: string;
    model?: string;
    tools?: number;
    toolNames?: string[];
    /**
     * `system/init.claude_code_version` — the ONE field the relay's CLI floor is
     * read from (phase 14; chapter 13 §1.4, DOC-7). Never `capabilities`, which
     * names nothing about hooks (phase 1 measured three members, none of them).
     */
    version?: string;
    /** `system/init.mcp_servers`, name and status — how a failed connection is known, since `--strict-mcp-config` does not exit on one (DOC-5). */
    mcpServers?: { name: string; status: string }[];
  }
  | { kind: 'text'; text: string }
  /** Coalesced `text_delta`s — the same words, arriving as they are written. */
  | { kind: 'partial'; text: string }
  /** Coalesced `thinking_delta`s. Separate because it is not the answer. */
  | { kind: 'thinking'; text: string }
  /** Text from a subagent, identified by `parent_tool_use_id`. */
  | { kind: 'subagent'; text: string; parent: string }
  /**
   * A tool call, going out.
   *
   * `id` is the CLI's own `tool_use` id and it is the only thing that can pair
   * this with the result that comes back — without it a call has a name and
   * nothing else: no duration, no outcome, and no way to tell which of four
   * concurrent `Read`s the failure belonged to. `agent` is a `Task`'s
   * `subagent_type`, which is what turns "a subagent said something" into
   * "the Explore agent said something".
   */
  | {
    kind: 'tool';
    name: string;
    summary: string;
    id?: string;
    /** This call starts a subagent, whose output will name this call as its parent. */
    delegates?: boolean;
    /** Which agent, when the call said. It is optional on the tool itself. */
    agent?: string;
    parent?: string;
  }
  /**
   * The result of one, paired back by `id`. See above.
   *
   * `refused` marks a result that is the CLI's permission system saying no —
   * paired by id to a `system/permission_denied`, or in the CLI's own refusal
   * sentence (`REFUSAL_RE`) — and `tool` then names the call. The words the
   * session READ, distinct from the denial the CLI recorded (`permission-denied`).
   */
  | { kind: 'tool-result'; id: string; ok: boolean; ms?: number; detail?: string; parent?: string; refused?: boolean; tool?: string; target?: string }
  /**
   * A tool call the CLI's permission system denied. `stream` is the CLI's
   * best-effort `system/permission_denied` message, which carries the reason;
   * `result` is an entry of the final `result.permission_denials` — the
   * authoritative record, which carries the input but no reason — emitted only
   * for a denial the stream never announced, so one denial is one event.
   */
  | {
    kind: 'permission-denied';
    tool: string;
    toolUseId?: string;
    /** What the call was aimed at: its command, path or pattern. */
    target?: string;
    reason?: string;
    /** The CLI's `decision_reason_type` — `hook`, `rule`, `mode`… */
    reasonType?: string;
    source: 'stream' | 'result';
  }
  /** The session's own task list, as `TodoWrite` last wrote it. */
  | { kind: 'todos'; items: TodoItem[] }
  /**
   * One transition of a task list kept *incrementally* rather than rewritten.
   *
   * Measured against a real run rather than assumed: the current CLI does not
   * call `TodoWrite` at all — it calls `TaskCreate` and `TaskUpdate`, one task
   * per call, and the id an update names comes back in the **result** of the
   * create rather than in its input. So the whole list only exists as the sum
   * of these, which is why they are carried rather than summarised.
   */
  | {
    kind: 'task';
    /**
     * `reset` is not the CLI's — it is `scripts/phase-tasks.sh`'s, replayed
     * onto this same event by the runner's tail (`runner/tasks.ts`), so the
     * browser folds a script-written list and a tool-written one through one
     * `case`. A whole-list clear has no `TaskCreate` spelling.
     */
    op: 'create' | 'update' | 'reset';
    /** The `tool_use` id of a create, so its result can hand back the task id. */
    call?: string;
    taskId?: string;
    content?: string;
    status?: string;
    activeForm?: string;
  }
  /**
   * One assistant turn of the PHASE's own conversation, and how many tool
   * calls it carried.
   *
   * The stream already says everything a turn contains; what it never said is
   * that a turn happened at all. That is the difference between "this session
   * is working" and "this session is talking": six turns in a row carrying
   * `tools: 0` is a session reasoning in circles, and no other event in this
   * union can be counted to discover it (`text` is coalesced, `partial` is a
   * delta, `result` fires once per turn but only after stdin work, and a turn
   * that calls three tools emits three `tool` events).
   *
   * Deliberately NOT emitted for a subagent's turns. A delegating phase spends
   * whole minutes with its own conversation stopped while an `Explore` agent
   * works, and counting the subagent's turns as the phase's would make the
   * lane look busy at exactly the moment it is worth asking whether the
   * delegation is coming back. `runner/liveness.ts` counts these; a subagent's
   * own output still arrives as `subagent`.
   */
  | { kind: 'step'; tools: number }
  | { kind: 'hook'; name: string; event: string; outcome?: string }
  /**
   * A message the operator sent into a running session. Emitted twice for one
   * message and rendered once: the runner emits it undelivered the instant it
   * is written, and this emits it again — same `mark` — when the CLI echoes it
   * back, which is the only evidence it arrived.
   */
  | { kind: 'injected'; text: string; mark?: string; delivered?: boolean; steer?: boolean; relay?: boolean }
  /** The session's reply to one of those, recognised by the tag it repeats. */
  | { kind: 'answer'; text: string; mark: string }
  /** stdin was closed by the watchdog rather than by the conversation ending. */
  | { kind: 'idle'; afterMs: number; reason: string }
  /**
   * The account's usage window, as the CLI reports it mid-session.
   *
   * Two units, both named: `utilization` is the wire's FRACTION (0–1, what
   * every journal row and client read has always held), `utilizationPct` the
   * same reading as a PERCENT (0–100, the account meters' unit), which is the
   * one a threshold is compared against.
   */
  | { kind: 'limits'; status: string; window?: string; utilization?: number; utilizationPct?: number; resetsAt?: number }
  | {
    kind: 'retry';
    /** The CLI's `error` — one of `API_RETRY_ERRORS` — or, marked `inferred`, a guess from its text. */
    category?: string;
    /** The category was READ OUT of the text, not reported by the CLI in its documented field. */
    inferred?: boolean;
    attempt?: number;
    /** The CLI's own ceiling for this retry sequence (`max_retries`). */
    maxRetries?: number;
    /** How long the CLI waits before this attempt (`retry_delay_ms`). */
    retryDelayMs?: number;
    /** The HTTP status behind the retry; null when no response arrived at all. */
    errorStatus?: number | null;
    detail?: string;
  }
  /**
   * A `control_request` line (TRS-2): the CLI asking its host something over the
   * stream — the envelope the SDK documents for a permission request. The
   * console is no SDK host and answers none of them; it records each, so a run
   * that ever receives one is not a run whose question went nowhere unnoticed.
   */
  | { kind: 'control-request'; requestId?: string; subtype?: string; tool?: string }
  /** The turn ended on a `defer` (phase 14, spike S3): the call kept as `deferred_tool_use`, resumable with `--resume`. */
  | { kind: 'deferred'; toolUseId?: string; tool?: string }
  | { kind: 'result'; subtype?: string; costUsd?: number; turns?: number; isError?: boolean; terminalReason?: string }
  | { kind: 'stderr'; text: string };

/**
 * A live session, for as long as it is live.
 *
 * Handed to the caller the moment the child exists so an operator question can
 * reach a phase that is already running.
 */
export type SpawnHandle = {
  pid?: number;
  /** True when the message was written. False when the session will not take it. */
  send(text: string): boolean;
  /** Are we still able to send? */
  open(): boolean;
  /**
   * Suspend (or resume) the idle watchdog because the operator froze this lane.
   *
   * A `SIGSTOP`ped child emits nothing, so to the watchdog a freeze is
   * indistinguishable from a session that stopped streaming — and at
   * `IDLE_CLOSE_MS` it would close stdin under a session the console has
   * promised is merely paused. That promise is the lane card's words: "continues
   * mid-token, in the same process". Ten minutes of freeze silently retracted
   * it, five minutes before the 15-minute escalation that is supposed to be the
   * ONLY clock allowed to end a freeze.
   *
   * Resuming does not merely re-arm: it re-stamps the silence clock, because the
   * frozen interval is not quiet time. Without that a lane thawed at T+12 closes
   * its stdin on the very next tick, which is the same bug wearing a hat.
   */
  setFrozen(frozen: boolean): void;
  /**
   * Say who is about to end this session, before signalling it.
   *
   * The spawn can see that its child died, but not who killed it: a lane
   * checkpointed for an account switch, stopped by an operator or recycled by
   * the liveness watchdog all arrive as the same signal. The runner names the
   * ending here first, and the outcome carries it as `endedBy` — the first word
   * written wins, so a watchdog's own teardown is not re-attributed by a stop
   * that lands a moment later. Optional in the type because a test's fake
   * handle need not implement it; every real handle does.
   */
  markEnding?(endedBy: EndedBy, reason?: string): void;
};

export type SpawnRequest = {
  prompt: string;
  cwd: string;
  /**
   * Directories the session may also write, beyond `cwd` (`--add-dir`).
   *
   * The console's own reason for it is work-state: a lane session's cwd is its
   * worktree, but its handoff, locks and QA row belong to the run's root, and
   * a session that is told where they go (`DOCS_ROOT`) but not allowed to
   * write there fails on the last step of the phase instead of the first.
   */
  addDirs?: string[];
  model?: string;
  /** Effort level for this session (`--effort`). */
  effort?: string;
  /** Fixed id so a deferred approval or a cap raise can resume this exact session. */
  sessionId?: string;
  /** Continue an existing session instead of starting one. */
  resume?: string;
  budgetUsd?: number | null;
  maxTurns?: number | null;
  /**
   * Both caps with the policy that set each (`session-record.ts`). When
   * present they are what reaches argv; the two bare numbers above are for a
   * caller with no source to name, and are recorded as `caller`. With neither,
   * `spawn.ts` applies its floor (`spawn-default`) — no session goes uncapped.
   */
  caps?: SessionCaps;
  /** Models to fail over to in-place, in order, without losing the session. */
  fallbackModels?: string[];
  /** Shown in `/resume` and `claude agents` — worth having on an unattended run. */
  name?: string;
  /** Restrict the built-in tool set for this phase (`--tools`). */
  tools?: string[];
  /**
   * Path to the resolved `--mcp-config` for this run, from `mcp/config.ts`.
   *
   * A file rather than the inline JSON the flag also accepts: the document
   * carries secrets, and argv is world-readable in `ps`.
   */
  mcpConfig?: string;
  /** Ignore every MCP server not passed explicitly. */
  strictMcp?: boolean;
  /** JSON passed to `--settings`: the per-run hook and its ask-rules (W3). */
  settings?: string;
  permissionMode?: PermissionMode;
  /**
   * How much this run may do unasked. Only `bypass` changes argv — the other
   * two differ in the ask list inside `--settings`, not out here.
   */
  permissionProfile?: PermissionProfile;
  /**
   * `none` passes `--permission-prompts none` (CLI 2.1.259+): the floor for a
   * run no relay answers. Decided per session by `permissionPromptsFor`.
   */
  permissionPrompts?: 'none';
  /**
   * `--permission-prompt-tool <mcp tool>` — the relay's presence-only host
   * (phase 14, spike S1): with one attached the CLI offers `AskUserQuestion`
   * in `-p`. Set only on a session the relay is armed for, never beside
   * `permissionPrompts`.
   */
  permissionPromptTool?: string;
  /** Stream assistant text as it is written rather than per finished block. */
  partialMessages?: boolean;
  /** Forward subagent text, so a phase that delegates is not a silent gap. */
  subagentText?: boolean;
  /** Put hook lifecycle in the stream, so approvals are visible as they fire. */
  hookEvents?: boolean;
  /** Silence after the phase's turn that means wedged rather than working. */
  idleCloseMs?: number;
  /**
   * How long this session may produce NOTHING AT ALL before it is ended.
   *
   * The bound `idleCloseMs` cannot express: that one refuses to arm until the
   * phase's turn has produced a result, so a session hung BEFORE its first
   * result had no timer of any kind. Measured on the incident this exists for:
   * 7 of 8 boarding gaps over fifteen minutes, none of them bounded.
   *
   * Defaults to `SPAWN_FIRST_EVENT_MS`; 0 switches it off (a test that wants
   * the old unbounded behaviour, or a caller that supervises its own child).
   */
  firstEventMs?: number;
  /**
   * How long a session may be silent between its `init` and its first
   * `result` — the clock over the gap where the phase's work happens.
   *
   * The first-event backstop above is cleared by the `init` every session
   * emits in its first second, and the idle close refuses to arm until the
   * first `result`, so a session that initialised and then wedged had no clock
   * inside this file at all (SES-10). Armed at `init`, cleared by the first
   * `result`, stretched by every productive event. Defaults to
   * `SPAWN_INIT_IDLE_MS`; 0 switches it off.
   */
  initIdleMs?: number;
  /** How long an aborted child gets to close its turn after SIGINT before SIGTERM. Test seam; defaults to `INT_GRACE_MS`. */
  interruptGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Told the pid as soon as there is one, so a checkpoint can record it. */
  onPid?: (pid: number) => void;
  /** Handed the live session, so something can talk to it while it runs. */
  onHandle?: (handle: SpawnHandle) => void;
};

export type SpawnOutcome = {
  signal: StopSignal;
  sessionId?: string;
  costUsd: number;
  turns: number;
  resultText: string;
  durationMs: number;
  /** Exactly what ran, for the journal. The prompt is not repeated here. */
  argv: string[];
  /** Messages the operator injected mid-session, for the record. */
  injected: number;
  /*
   * The session ledger (zero-touch-console phase 4). Optional in the type so a
   * test's fake outcome still runs; `spawnClaude` always sets every one, and
   * `session-record.ts` reads a missing one as its honest default.
   */
  /** Who ended the session — `exit` when nothing in the console did. */
  endedBy?: EndedBy;
  /** The ender's own words, when it had some (the spawn watchdogs always do). */
  endedReason?: string;
  /** A turn was still open when the process ended: the last `result` does not cover all the work. */
  midTurn?: boolean;
  /** Distinct assistant turns of the phase's own conversation the stream showed. */
  steps?: number;
  /** Where `turns` came from: the CLI's `num_turns`, or the stream for a turn that never closed. */
  turnsSource?: 'result' | 'stream';
  /** Where `costUsd` came from; `none` means no `total_cost_usd` ever arrived. */
  costSource?: 'result' | 'stream' | 'none';
  /** The caps that reached argv, with their sources. */
  caps?: SessionCaps;
};

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;

/** argv is bounded by the OS; a boot prompt is kilobytes, so this is a sanity bound. */
const MAX_PROMPT_BYTES = 512 * 1024;
/** Keep the last of stderr for classification — not a whole build log. */
const KEEP_STDERR = 16_000;
/** A single NDJSON line past this is a runaway, not a message. */
const MAX_LINE = 8 * 1024 * 1024;
/**
 * Deltas arrive per token. Forwarding each one puts thousands of SSE frames in
 * front of a browser that can only paint sixty times a second, so they are
 * gathered and released on a fixed beat instead.
 */
const PARTIAL_FLUSH_MS = 120;
/**
 * How long a session may say nothing at all, after its phase turn has produced
 * a result and with stdin still open, before stdin is closed for it.
 *
 * This is the backstop under the close rule below, and it exists because the
 * close rule depends on evidence the CLI provides — an echo, a result — and a
 * rule that waits for evidence waits forever when the evidence never comes. The
 * failure it catches was real: a phase that had emitted its result and printed
 * its completion report sat blocked on stdin for eighty minutes at 0.1% CPU,
 * with the run showing `running` the whole time.
 *
 * Generous on purpose. After the phase's own turn the only legitimate reason
 * for silence is a long tool call inside a turn the operator started, so this
 * has to outlast a test suite; ten minutes of *total* stream silence is not a
 * session that is working.
 */
const IDLE_CLOSE_MS = 10 * 60 * 1_000;
/**
 * How many unparseable NDJSON lines are logged in full before the rest are
 * only counted. A CLI writing malformed output writes a lot of it.
 */
const MAX_PARSE_ERROR_LOGS = 3;
/**
 * `setTimeout` silently fires IMMEDIATELY above 2^31-1 ms, which for a backstop
 * that ends a live process is the exact inverse of what a large number means.
 */
const MAX_SPAWN_TIMER_MS = 2_147_483_647;
/** Tool calls awaiting a result. A phase makes hundreds; none of them leak. */
const MAX_PENDING_TOOLS = 500;
/**
 * Names of the tools this session was given, at most.
 *
 * Recorded because their ABSENCE was invisible for ten days: the init event
 * carried a count, so the CLI silently ceasing to provision TodoWrite /
 * TaskCreate / TaskUpdate to `-p` sessions looked like 84 tools instead of 87
 * and nothing anywhere said which three had gone. A count answers "how many";
 * only the names answer "which".
 */
const MAX_TOOL_NAMES = 100;
const MAX_TOOL_NAME = 60;
/** Enough of a result to say what happened; never enough to be a build log. */
const MAX_RESULT_TEXT = 200;
/**
 * The tools that start a subagent.
 *
 * Both spellings, because only one of them fires on any given CLI and matching
 * the wrong one is silent: the subagent's text still arrives carrying a
 * `parent_tool_use_id`, so the lane simply never opens and its words go into
 * the log unattributed. Measured against a real session — the current CLI calls
 * this `Agent`; `Task` is the older name and other harnesses still use it.
 */
const DELEGATING_TOOLS = new Set(['Agent', 'Task']);

export function buildArgv(request: SpawnRequest): string[] {
  // Only the `bypass` profile reaches for it, and `sanitize()` is still what
  // decides — passing the string alone gets it rewritten, as it always has.
  const bypass = request.permissionProfile === 'bypass';
  const argv = [
    // No positional prompt: in streaming-input mode it is ignored, and a prompt
    // that looks passed but is not is the worst of both.
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    // Echoes each message we send back on stdout, which is how the console
    // knows an operator's question actually reached the session.
    '--replay-user-messages',
    // stream-json in print mode requires it; it is also what makes tool calls
    // visible to the console instead of only the final answer.
    '--verbose',
    '--permission-mode', bypass ? 'bypassPermissions' : (request.permissionMode ?? 'acceptEdits'),
  ];
  // Who answers a prompt in print mode: nobody, on a run no relay answers —
  // and the relay's presence-only host on a session it is armed for. Never both.
  if (request.permissionPrompts === 'none') argv.push('--permission-prompts', 'none');
  else if (request.permissionPromptTool) argv.push('--permission-prompt-tool', request.permissionPromptTool);
  if (request.resume) argv.push('--resume', request.resume);
  else argv.push('--session-id', request.sessionId ?? randomUUID());
  if (request.model) argv.push('--model', request.model);
  if (request.effort) {
    // The CLI only warns on an unknown value and carries on at its default, so
    // a typo would silently run the whole plan at the wrong effort.
    if (isEffort(request.effort)) argv.push('--effort', request.effort);
    else log.warn('spawn.bad-effort', { effort: request.effort, allowed: EFFORTS });
  }
  const fallbacks = (request.fallbackModels ?? []).filter(Boolean);
  if (fallbacks.length) argv.push('--fallback-model', fallbacks.join(','));
  if (request.name) argv.push('--name', request.name.slice(0, 80));
  // Always both, and never a bare absence (SES-8): 0 of 507 lifetime argvs
  // carried a dollar cap, because both conditions read values that defaulted
  // to null. The caps come named (`request.caps`), bare (`caller`), or — for a
  // caller that passed nothing — as the floor, so no session goes uncapped.
  const caps = resolveCaps(request);
  argv.push('--max-budget-usd', String(caps.maxBudgetUsd.value));
  argv.push('--max-turns', String(caps.maxTurns.value));
  if (request.tools?.length) argv.push('--tools', request.tools.join(','));
  // One variadic flag rather than a repeated one: `--add-dir <directories...>`
  // collects until the next option, and a second occurrence would replace the
  // first rather than add to it. Blanks are dropped so an unresolved path can
  // never become a bare `--add-dir` that swallows the flag after it.
  const addDirs = (request.addDirs ?? []).filter((dir) => Boolean(dir?.trim()));
  if (addDirs.length) argv.push('--add-dir', ...addDirs);
  // The two go together on purpose. `--mcp-config` alone would ADD this run's
  // servers to whatever `~/.claude.json` and the project's `.mcp.json` happen
  // to hold, and an unattended session would be talking to servers nobody chose
  // for it; `--strict-mcp-config` makes the resolved set the whole set. A run
  // that attaches nothing passes neither and inherits the machine's own, which
  // is what every run did before this existed.
  if (request.mcpConfig) argv.push('--mcp-config', request.mcpConfig, '--strict-mcp-config');
  else if (request.strictMcp) argv.push('--strict-mcp-config');
  if (request.partialMessages) argv.push('--include-partial-messages');
  if (request.subagentText) argv.push('--forward-subagent-text');
  if (request.hookEvents) argv.push('--include-hook-events');
  if (request.settings) argv.push('--settings', request.settings);
  return sanitize(argv, { allowBypass: bypass });
}

/** The one place a forbidden flag can be removed, so it is the only place to audit. */
export function sanitize(argv: string[], opts: SanitizeOptions = {}): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (FORBIDDEN.includes(arg)) {
      log.warn('spawn.refused-flag', { flag: arg });
      continue;
    }

    if (FORBIDDEN_WITH_VALUE.includes(arg)) {
      // Drop the value with it. Left behind, it becomes a loose positional.
      log.warn('spawn.refused-flag', { flag: arg, droppedValue: argv[i + 1] });
      i++;
      continue;
    }

    const rule = FORBIDDEN_VALUES[arg];
    if (rule && rule.values.includes(argv[i + 1])) {
      if (rule.unlockedBy && opts[rule.unlockedBy]) {
        // Loud on purpose: this is the line that hands a session the keys.
        log.warn('spawn.bypass-permitted', {
          flag: arg, value: argv[i + 1], note: 'the operator chose the bypass profile for this run',
        });
        out.push(arg, argv[i + 1]);
        i++;
        continue;
      }
      log.warn('spawn.refused-value', { flag: arg, value: argv[i + 1], replacedWith: rule.safe });
      out.push(arg, rule.safe);
      i++;
      continue;
    }

    out.push(arg);
  }
  return out;
}

/** One NDJSON user message, the shape the CLI reads in streaming-input mode. */
export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

export const spawnClaude: SpawnFn = (request) => new Promise<SpawnOutcome>((resolve) => {
  const started = Date.now();
  if (Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES) {
    resolve(fail(`the boot prompt is over ${MAX_PROMPT_BYTES / 1024}KB — the plan is malformed`, started, [], resolveCaps(request)));
    return;
  }

  // The session's id is decided HERE, before the child exists — minted for a
  // fresh session, the resumed one otherwise — so it can ride into the child's
  // environment as PE_SESSION_ID. `phase-lock.sh claim` writes it as the lock's
  // `session=` line and `phase-outcome.sh` as the outcome's `session_id`, which
  // is how the console's session registry ties a lock and a declared outcome
  // to the Claude session that wrote them.
  const sessionIdForChild = request.resume ?? request.sessionId ?? randomUUID();
  if (!request.resume && !request.sessionId) request = { ...request, sessionId: sessionIdForChild };
  const argv = buildArgv(request);
  const shown = [...argv];

  const child = spawn('claude', argv, {
    cwd: request.cwd,
    env: childEnv({ ...request.env, PE_SESSION_ID: sessionIdForChild }),
    // stdin is a pipe now: it carries the boot prompt, and it stays open so an
    // operator can put a question to a phase that is already running.
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so a teardown can address `-pid` and reach what
    // the CLI started — bash, MCP servers, subagents — instead of leaving them
    // behind. Without it the child joins the CONSOLE's group: an orphan was
    // found sitting in the group of a console that had already died, by which
    // point nothing could address it as a group at all.
    //
    // `detached` sets the group and nothing else here; the child is still
    // waited on, still piped, and still ends with this process by way of the
    // teardown paths in `signals.ts`.
    detached: true,
  });

  let sessionId = request.resume ?? undefined;
  let costUsd = 0;
  let turns = 0;
  let resultText = '';
  let subtype: string | undefined;
  let stopReason: string | null | undefined;
  let stderr = '';
  const retryCategories: string[] = [];
  let settled = false;

  /* ---- the session ledger ---- *
   *
   * What the stream already says, kept so a session that never reaches its
   * `result` is still booked (SES-1). The CLI books turns and dollars on the
   * `result` alone; SIGINT now makes an interrupted turn write one, and these
   * cover the endings where nothing does.
   *
   *   `costSource`       where the last `total_cost_usd` came from, or `none`.
   *   `reportedTurns`    the CLI's own `num_turns`, the highest seen.
   *   `turnIds`          distinct `message.id`s of the phase's own assistant
   *                      messages. One API turn arrives as SEVERAL assistant
   *                      lines — its thinking and its tool call share one id
   *                      (measured, `test/fixtures/spikes/sigint.md`) — so a
   *                      count of lines would over-book it.
   *   `turnOpen`         a user message went in and no completed `result` has
   *                      come back for it. A `result` whose `terminal_reason`
   *                      is `aborted_*` closed the turn without finishing it.
   *   `ending`           who ended the session, first writer wins.
   */
  let costSource: 'result' | 'stream' | 'none' = 'none';
  let reportedTurns: number | null = null;
  const turnIds = new Set<string>();
  let anonymousTurns = 0;
  let turnOpen = true;                 // the boot prompt is the first open turn
  let isError = false;
  let terminalReason: string | undefined;
  let permissionDenials: PermissionDenial[] = [];
  /** `tool_use` ids the stream said were denied, so a result entry is not a second event. */
  const deniedIds = new Set<string>();
  /** A tool call's name and aim, by id — what a `permission_denied` line does not repeat. Bounded like `toolStartedAt`. */
  const toolInfo = new Map<string, { name: string; summary: string }>();
  /** Background tasks the CLI started and has not reported finished (`system/task_started`). */
  const backgroundTasks = new Map<string, string>();
  let ending: { endedBy: EndedBy; reason?: string } | null = null;
  const noteEnding = (endedBy: EndedBy, reason?: string): void => {
    if (ending) return;
    ending = { endedBy, ...(reason ? { reason } : {}) };
  };
  /** SIGTERM and SIGKILL behind an interrupt, armed once by the teardown. */
  const escalation: NodeJS.Timeout[] = [];

  /* ---- the conversation's own state ---- *
   *
   * ## Why none of this is a counter any more
   *
   * It used to be: `outstanding` went up on every operator message and down on
   * every `result`, and stdin closed at zero. That is a subtraction across two
   * streams nobody correlates — the CLI is free to fold two injected messages
   * into one turn, and a client is free to POST the same question twice — so
   * the counter drifts above zero, `closeStdin()` never fires, the child never
   * exits, and the phase reads `running` forever. Measured: a session that had
   * emitted its result and printed a completion report, still alive 80 minutes
   * later blocked on stdin.
   *
   * What replaces it is two things that cannot drift:
   *
   *   `unecho`               the tags of messages written and not yet echoed
   *                          back, keyed by tag rather than counted. A repeat
   *                          of the same message is one entry, and two messages
   *                          folded into one turn both drain, so folding is no
   *                          longer a leak.
   *   `sentSinceLastResult`  a flag, not a tally, and only for an *untagged*
   *                          caller — one whose messages `unecho` cannot track.
   *                          Setting it twice is the same as setting it once.
   *   `turnsSeen`            the CLI's own `num_turns`, which is what tells an
   *                          extra `result` for a turn already counted from a
   *                          genuine new turn. Only a new turn may close stdin,
   *                          so a duplicate cannot close the door on a question
   *                          that has not been answered yet.
   */
  /** The boot-prompt turn has produced its result: the phase's work is done. */
  let phaseTurnDone = false;
  /** An UNTAGGED message written since the previous result. See above. */
  let sentSinceLastResult = false;
  /** Tags of operator messages written but not yet echoed back by the CLI. */
  const unecho = new Set<string>();
  /** The highest turn number any result has reported. */
  let turnsSeen = 0;
  let injected = 0;
  let stdinOpen = true;

  /* ---- pairing a tool call with its result ---- *
   *
   * The CLI reports a call and its result as two separate messages, minutes
   * apart on a long one, and the only thing joining them is the `tool_use` id.
   * Keeping the moment each call was announced is therefore the whole of the
   * duration measurement: `Bash  npm test` with no time beside it cannot be
   * told from `Bash  npm test` that has been hanging for six minutes, which is
   * exactly the question someone watching an unattended run is asking.
   *
   * A call whose result never arrives — the session was killed mid-tool —
   * leaves an entry behind, so the map is bounded and forgets its oldest
   * rather than growing for the life of the phase.
   */
  const toolStartedAt = new Map<string, number>();

  const noteToolStart = (id: string): void => {
    toolStartedAt.set(id, Date.now());
    if (toolStartedAt.size <= MAX_PENDING_TOOLS) return;
    // Map iteration is insertion-ordered, so this is the oldest unanswered call.
    const oldest = toolStartedAt.keys().next().value;
    if (oldest !== undefined) toolStartedAt.delete(oldest);
  };

  const toolDuration = (id: string): number | undefined => {
    const started = toolStartedAt.get(id);
    if (started === undefined) return undefined;
    toolStartedAt.delete(id);
    return Date.now() - started;
  };

  const finish = (outcome: SpawnOutcome) => {
    if (settled) return;
    settled = true;
    clearFirstEventTimer();
    clearInitIdle();
    for (const timer of escalation) clearTimeout(timer);
    // The child is over; its pid may be reused by a process that must be
    // asked afresh (`signals.ts` remembers one interrupt per pid).
    forgetInterrupt(child.pid);
    if (parseErrors) log.warn('spawn.parse-errors', { pid: child.pid, count: parseErrors });
    resolve(outcome);
  };

  if (child.pid) request.onPid?.(child.pid);

  const emit = (event: StreamEvent) => {
    lastEventAt = Date.now();
    sawEvent = true;
    // The init→result bound measures silence in PRODUCTIVE events, by the same
    // one definition the backstop below uses.
    if (isProductiveEvent(event)) lastProductiveAt = lastEventAt;
    // The backstop's question is not "did anything arrive" — it is "did this
    // session ever WORK". Those were the same thing until the CLI started
    // absorbing failures on our behalf: a lane that emits nothing but
    // `api_retry` is producing a stream, and the old `sawEvent` clear on the
    // first of them disarmed the one clock that would ever have ended it.
    // Measured: a lane retried for eleven hours having never once opened a tool
    // call, with every watchdog satisfied by the retries themselves.
    //
    // `isProductiveEvent` is the codebase's single definition of the
    // distinction (`runner/liveness.ts`), the same one the live wall clears its
    // rate-limit evidence by, so this cannot drift from it.
    if (!sawProductive && isProductiveEvent(event)) {
      sawProductive = true;
      // Cleared here rather than left to `finish()`, so a healthy session
      // carries no timer for its life.
      if (firstEventTimer) { clearTimeout(firstEventTimer); firstEventTimer = null; }
    }
    try { request.onEvent?.(event); } catch { /* a listener must not kill the run */ }
  };

  /* ---- writing to the child ---- */

  // EPIPE on a child that has already gone is normal, not a fault: it means the
  // session ended between our deciding to write and the write landing.
  child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
    stdinOpen = false;
    if (error.code !== 'EPIPE') log.warn('spawn.stdin', { error });
  });

  const write = (text: string): boolean => {
    if (!stdinOpen || !child.stdin?.writable) return false;
    try {
      child.stdin.write(userMessage(text));
      return true;
    } catch (error) {
      log.warn('spawn.stdin-write', { error });
      return false;
    }
  };

  const closeStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    try { child.stdin?.end(); } catch { /* already gone */ }
  };

  /* ---- the idle watchdog ---- */

  const idleAfter = request.idleCloseMs ?? IDLE_CLOSE_MS;
  let idleTimer: NodeJS.Timeout | null = null;
  let lastEventAt = Date.now();
  /**
   * Has ANY stream event ever left this spawn — including a line of stderr?
   *
   * Deliberately the widest possible reading of "it said something". The
   * backstop below ends a live process, so the bar for not firing is low on
   * purpose: one warning on stderr is enough to make "zero output" untrue, and
   * a session that is talking at all is one the runner's own watchdog and the
   * ordinary idle close can see.
   */
  let sawEvent = false;
  /** NDJSON lines that would not parse. See `spawn.parse-error`. */
  let parseErrors = 0;
  /**
   * The first-event backstop's timer — declared here, beside the flag it reads,
   * so `emit` can clear it at the first event. Armed further down, once the
   * teardown it uses exists.
   */
  let firstEventTimer: NodeJS.Timeout | null = null;
  /**
   * Has this session done anything that is not the CLI's own retry machinery?
   *
   * Distinct from `sawEvent`, which is "did any byte arrive" and is what the
   * idle/teardown paths want. This one is what the first-event backstop wants:
   * see `emit`.
   */
  let sawProductive = false;
  /** Set by `setFrozen` — see `SpawnHandle.setFrozen` for why the watchdog must not run. */
  let frozen = false;
  /** When the session last produced a productive event — the init→result bound's clock. */
  let lastProductiveAt = Date.now();
  const initIdleAfter = request.initIdleMs ?? SPAWN_INIT_IDLE_MS;
  let initIdleTimer: NodeJS.Timeout | null = null;
  /** Between the session's `init` and its first `result`: the stretch that bound watches. */
  let initWatch = false;
  const clearInitIdle = (): void => {
    if (!initIdleTimer) return;
    clearTimeout(initIdleTimer);
    initIdleTimer = null;
  };

  /**
   * Armed only once the phase's own turn has produced a result: before that,
   * silence is a session thinking, and cutting it off would be the bug rather
   * than the fix.
   *
   * It measures *silence*, not elapsed time, but it is not re-armed per event —
   * a streaming session emits thousands of deltas and rescheduling a timer on
   * each is real work for nothing. Instead every event stamps `lastEventAt` and
   * the timer, on waking, either fires or sleeps out the remainder.
   */
  const armIdle = (delay = idleAfter): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!phaseTurnDone || !stdinOpen || settled || idleAfter <= 0) return;
    // A frozen lane is silent BY CONSTRUCTION. Measuring that silence and
    // acting on it is the watchdog mistaking the operator's own act for the
    // failure it exists to catch.
    if (frozen) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!stdinOpen || settled) return;
      const quiet = Date.now() - lastEventAt;
      if (quiet < idleAfter) { armIdle(idleAfter - quiet); return; }
      const reason = unecho.size
        ? `${unecho.size} operator message(s) were never echoed back`
        : 'the session stopped streaming with stdin still open';
      log.warn('spawn.idle-close', { afterMs: quiet, reason, pid: child.pid });
      emit({ kind: 'idle', afterMs: quiet, reason });
      closeStdin();
    }, Math.max(1, delay));
    idleTimer.unref?.();
  };

  // The boot prompt, as the session's first turn. Deliberately not marked as
  // "sent": it IS the phase turn, and `phaseTurnDone` is what tracks that.
  write(request.prompt);

  request.onHandle?.({
    pid: child.pid ?? undefined,
    open: () => stdinOpen && !settled,
    send: (text: string) => {
      if (!text.trim()) return false;
      if (!write(text)) return false;
      // Untagged callers still work — they simply get no delivery confirmation
      // and no attributed answer, which is the old behaviour rather than a new
      // failure. Everything the console sends is tagged.
      const mark = operatorMark(text);
      if (mark) unecho.add(mark);
      else sentSinceLastResult = true;
      injected++;
      // A message opens a turn; only its completed `result` closes it.
      turnOpen = true;
      armIdle();
      return true;
    },
    setFrozen: (next: boolean) => {
      if (next === frozen) return;
      frozen = next;
      if (frozen) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        clearInitIdle();
        return;
      }
      // The frozen stretch was not silence the session chose. Forgiving it is
      // what makes a thaw at T+12 a resume rather than a delayed idle-close.
      lastEventAt = Date.now();
      lastProductiveAt = lastEventAt;
      armIdle();
      armInitIdle();
    },
    markEnding: (endedBy: EndedBy, reason?: string) => { noteEnding(endedBy, reason); },
  });

  /* ---- coalescing the delta firehose ---- */

  let pendingText = '';
  let pendingThinking = '';
  let flushTimer: NodeJS.Timeout | null = null;

  const flushPartials = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingText) { const text = pendingText; pendingText = ''; emit({ kind: 'partial', text }); }
    if (pendingThinking) { const text = pendingThinking; pendingThinking = ''; emit({ kind: 'thinking', text }); }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(flushPartials, PARTIAL_FLUSH_MS);
    flushTimer.unref?.();
  };

  const onAbort = () => {
    // Who asked, when the abort said: `stop()` and `checkpointForShutdown()`
    // abort the run's controller with their `ENDED_BY` word as the reason.
    const why = request.signal?.aborted ? request.signal.reason : undefined;
    if (typeof why === 'string' && (ENDED_BY as readonly string[]).includes(why)) noteEnding(why as EndedBy);
    closeStdin();
    if (!child.pid) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
    // Ask the turn to close first — SIGINT, once per process (`signals.ts`).
    // The CLI then writes the `result` that books the session's turns and
    // dollars, which a SIGTERM never lets it write: measured on 2.1.270, the
    // `result` 10 ms after the signal and a clean exit half a second later.
    // The wake rides inside `interruptOnce`, and it is still the point: a
    // frozen lane aborted here — exactly what a console shutdown does — cannot
    // act on any signal until it is continued. That is how a phase-9 child
    // outlived its console by three hours in state `T`.
    interruptOnce(child.pid);
    if (escalation.length) return;
    // …then insist, on this spawn's own clock, so a child with no runner ladder
    // behind it — a lane-less QA round, a PR session — still has a SIGTERM and
    // a SIGKILL coming. Both are cleared the moment the child is gone.
    const grace = request.interruptGraceMs ?? INT_GRACE_MS;
    const term = setTimeout(() => { if (!settled && child.pid) wakeAndTerm(child.pid); }, grace);
    const kill = setTimeout(() => {
      if (!settled && child.pid) groupSignal(child.pid, 'SIGKILL');
    }, grace + DEFAULT_KILL_AFTER_MS);
    term.unref?.();
    kill.unref?.();
    escalation.push(term, kill);
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  /* ---- the first-event backstop ---- *
   *
   * One coarse timer from `started`, and the ONLY clock in this file that does
   * not depend on the session having spoken first. `armIdle` refuses to arm
   * until `phaseTurnDone`, which is set exactly once inside the `result`
   * handler, so a child that hangs before its first result — a fresh attempt,
   * a retry, a recovery, a resume — had nothing bounding it at all.
   *
   * It ends the child through the SAME teardown an abort uses — `onAbort`:
   * close stdin, wake, SIGTERM — rather than a bespoke kill path. That is what
   * makes the attempt settle as an ordinary session exit, which the normal
   * attempt machinery already knows how to read; a second way to end a child is
   * a second set of endings for every caller to classify. There is no
   * escalation behind it: a child that ignores SIGTERM here is the console's
   * own shutdown ladder's problem, not this timer's.
   *
   * It fires only on TOTAL silence — the first event clears it in `emit` — so on
   * a healthy session it costs one `clearTimeout`. And it is by construction the
   * last of the three clocks (`SPAWN_FIRST_EVENT_MS`): the runner nudges, then
   * recycles, and only a lane with no runner behind it ever reaches this.
   */
  const firstEventAfter = request.firstEventMs ?? SPAWN_FIRST_EVENT_MS;
  const clearFirstEventTimer = (): void => {
    if (!firstEventTimer) return;
    clearTimeout(firstEventTimer);
    firstEventTimer = null;
  };
  if (firstEventAfter > 0) {
    firstEventTimer = setTimeout(() => {
      firstEventTimer = null;
      if (settled || sawProductive) return;
      const afterMs = Date.now() - started;
      const reason = parseErrors
        ? `the session produced ${parseErrors} line(s) this build could not parse and nothing else`
        : sawEvent
          // The whole point of the split. Saying "no output at all" about a
          // lane that emitted four hundred retries would send the operator
          // looking for a dead process.
          ? 'the session produced nothing but API retries after it started — no turn, no tool call, no result'
          : 'the session produced no output at all after it started';
      log.warn('spawn.no-first-event', { afterMs, reason, parseErrors, sawEvent, pid: child.pid });
      // Named before the teardown, so the outcome says the spawn's own clock
      // ended this child (SES-11) — not an external SIGTERM a person must
      // explain, which is how `classify()` used to read the exit.
      noteEnding('spawn-watchdog', reason);
      // Emitted BEFORE the teardown, so the journal holds the evidence that
      // produced the kill even though the kill is what ends the stream. Note
      // this sets `sawEvent`; nothing reads it after this point.
      emit({ kind: 'idle', afterMs, reason });
      onAbort();
    }, Math.min(firstEventAfter, MAX_SPAWN_TIMER_MS));
    firstEventTimer.unref?.();
  }

  /* ---- the init→result bound ---- *
   *
   * The clock over the stretch where a phase's work happens (SES-10): after
   * the session's `init`, before its first `result`. The first-event backstop
   * above cannot see it — the `init` every session emits in its first second
   * clears that one — and the idle close refuses to arm until a `result`, so a
   * session that initialised and then wedged had no clock in this file at all.
   * Only the runner's nudge-then-recycle bounded it, and that needs a lane, a
   * liveness ticker and a console still driving: the things absent in exactly
   * the cases the audit is about.
   *
   * It measures silence in productive events and re-arms for the remainder on
   * each wake, like `armIdle`, rather than rescheduling per event; a frozen
   * lane suspends it. By construction the last clock (`SPAWN_INIT_IDLE_MS`):
   * a long local job the runner parks at `STALL_LOCAL_JOB_MS` never reaches it.
   */
  const armInitIdle = (delay = initIdleAfter): void => {
    clearInitIdle();
    if (!initWatch || settled || frozen || initIdleAfter <= 0) return;
    initIdleTimer = setTimeout(() => {
      initIdleTimer = null;
      if (!initWatch || settled || frozen) return;
      const quiet = Date.now() - lastProductiveAt;
      if (quiet < initIdleAfter) { armInitIdle(initIdleAfter - quiet); return; }
      initWatch = false;
      const spoken = quiet < 120_000 ? `${Math.round(quiet / 1_000)} s` : `${Math.round(quiet / 60_000)} min`;
      const reason = `no result after init — the session went silent for ${spoken} after it started and before its first result`;
      log.warn('spawn.init-idle', { afterMs: quiet, pid: child.pid });
      noteEnding('spawn-watchdog', reason);
      emit({ kind: 'idle', afterMs: quiet, reason });
      onAbort();
    }, Math.min(Math.max(1, delay), MAX_SPAWN_TIMER_MS));
    initIdleTimer.unref?.();
  };

  const handleLine = (line: string) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch (error) {
      // It used to be `catch { return; }` — no log, no count — which meant
      // "the session produced nothing" and "the session produced output this
      // build could not read" were the same observation. They call for
      // opposite remedies, and the watchdogs above act on the first.
      //
      // The first few in full, then counted only: a CLI writing malformed
      // output writes a lot of it, and a log that repeats it megabyte by
      // megabyte is its own outage.
      parseErrors++;
      if (parseErrors <= MAX_PARSE_ERROR_LOGS) {
        log.warn('spawn.parse-error', {
          pid: child.pid, n: parseErrors,
          error: (error as Error)?.message ?? String(error),
          line: line.slice(0, 200),
        });
      }
      return;
    }

    const id = message.session_id;
    if (typeof id === 'string' && id) sessionId = id;

    const type = message.type;
    const sub = typeof message.subtype === 'string' ? message.subtype : undefined;
    const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;

    // The running total, whichever message carried it, the last one winning
    // (SES-1). `result` is the documented carrier; reading it wherever it
    // appears means a session that never reached one is not booked at $0 when
    // the stream did say what it had cost.
    if (typeof message.total_cost_usd === 'number') {
      costUsd = message.total_cost_usd;
      costSource = type === 'result' ? 'result' : 'stream';
    }

    if (type === 'system' && sub === 'init') {
      // The init→result bound starts here: from now until the first `result`
      // is the stretch where the phase's work happens.
      initWatch = true;
      lastProductiveAt = Date.now();
      armInitIdle();
      const servers = Array.isArray(message.mcp_servers)
        ? message.mcp_servers.flatMap((entry) => {
          const server = entry as { name?: unknown; status?: unknown } | null;
          return typeof server?.name === 'string' && server.name
            ? [{ name: server.name.slice(0, MAX_TOOL_NAME), status: typeof server.status === 'string' ? server.status.slice(0, 40) : 'unknown' }]
            : [];
        }).slice(0, MAX_TOOL_NAMES)
        : undefined;
      emit({
        kind: 'init',
        sessionId: sessionId ?? '',
        model: typeof message.model === 'string' ? message.model : undefined,
        tools: Array.isArray(message.tools) ? message.tools.length : undefined,
        // …and WHICH, not just how many. See `MAX_TOOL_NAMES`.
        toolNames: Array.isArray(message.tools)
          ? message.tools
              .filter((name): name is string => typeof name === 'string' && Boolean(name))
              .slice(0, MAX_TOOL_NAMES)
              .map((name) => name.slice(0, MAX_TOOL_NAME))
          : undefined,
        // The field and nothing else: `capabilities` is an open set that names
        // no hook behaviour, and a version parsed out of any other string is a
        // guess about which binary answered.
        ...(typeof message.claude_code_version === 'string' && message.claude_code_version
          ? { version: message.claude_code_version.slice(0, 40) } : {}),
        ...(servers ? { mcpServers: servers } : {}),
      });
      return;
    }

    // The CLI asking its host over the stream (TRS-2). Recorded, never
    // answered: the console is not an SDK host, passes no stdio prompt tool,
    // and a `control_response` it invented would be a decision nobody made.
    if (type === 'control_request') {
      const request = (message.request ?? {}) as { subtype?: unknown; tool_name?: unknown };
      emit({
        kind: 'control-request',
        ...(typeof message.request_id === 'string' ? { requestId: message.request_id.slice(0, 80) } : {}),
        ...(typeof request.subtype === 'string' ? { subtype: request.subtype.slice(0, 60) } : {}),
        ...(typeof request.tool_name === 'string' ? { tool: request.tool_name.slice(0, MAX_TOOL_NAME) } : {}),
      });
      return;
    }

    // A denial as the CLI announces it — best-effort, and the only form that
    // carries the reason. The `result`'s `permission_denials` is the
    // authoritative ledger and is read there, for the denials this missed.
    // Measured shape (CLI 2.1.270, `test/fixtures/spikes/permissionrequest.md`):
    // `tool_name`, `tool_use_id`, `decision_reason_type`, `decision_reason`,
    // `message` — and no input, so the aim comes from the call's own `tool_use`.
    if (type === 'system' && sub === 'permission_denied') {
      const toolUseId = typeof message.tool_use_id === 'string' && message.tool_use_id ? message.tool_use_id : undefined;
      const known = toolUseId ? toolInfo.get(toolUseId) : undefined;
      if (toolUseId) deniedIds.add(toolUseId);
      const reason = firstString(message, ['decision_reason', 'message']);
      emit({
        kind: 'permission-denied',
        tool: typeof message.tool_name === 'string' && message.tool_name ? message.tool_name : (known?.name ?? 'tool'),
        ...(toolUseId ? { toolUseId } : {}),
        ...(known?.summary ? { target: known.summary } : {}),
        ...(reason ? { reason: reason.slice(0, MAX_RESULT_TEXT) } : {}),
        ...(typeof message.decision_reason_type === 'string' ? { reasonType: message.decision_reason_type } : {}),
        source: 'stream',
      });
      return;
    }

    // Background work the CLI is holding open for this session. Whatever is
    // still open when the process ends is what the CLI's background-task
    // ceiling terminated (SES-12) — the one list that can name those tasks,
    // since the CLI's own warning names only the ceiling.
    if (type === 'system' && (sub === 'task_started' || sub === 'task_notification')) {
      const taskId = typeof message.task_id === 'string' ? message.task_id : '';
      if (taskId && sub === 'task_started') {
        const description = typeof message.description === 'string' ? message.description : '';
        backgroundTasks.set(taskId, description.slice(0, MAX_RESULT_TEXT));
        if (backgroundTasks.size > MAX_PENDING_TOOLS) {
          const oldest = backgroundTasks.keys().next().value;
          if (oldest !== undefined) backgroundTasks.delete(oldest);
        }
      } else if (taskId) {
        backgroundTasks.delete(taskId);
      }
      return;
    }

    // Hook lifecycle, when asked for. Only the settled ones are worth a line:
    // started/progress would treble the volume and say nothing new.
    if (type === 'system' && sub === 'hook_response') {
      emit({
        kind: 'hook',
        name: String(message.hook_name ?? 'hook'),
        event: String(message.hook_event ?? ''),
        outcome: typeof message.outcome === 'string' ? message.outcome : undefined,
      });
      return;
    }

    // How much of the account's window is left, straight from the CLI. An
    // unattended run that is about to walk into a wall should say so first.
    if (type === 'rate_limit_event') {
      const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
      const utilization = typeof info.utilization === 'number' ? info.utilization : undefined;
      emit({
        kind: 'limits',
        status: String(info.status ?? 'unknown'),
        window: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
        utilization,
        // The same reading in the meters' unit, named, so a threshold is never
        // compared across units (SES-9): the wire's is a fraction (0.29–0.99 in
        // the audit's 1 062 rows), the account meters' a percent.
        ...(utilization === undefined ? {} : { utilizationPct: percentOf(utilization) }),
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
      });
      return;
    }

    // The retry stream is how the CLI reports what it is absorbing on our
    // behalf. The category is the documented `error` field, one of twelve
    // values (`API_RETRY_ERRORS`, chapter 09 row 31); it used to be read from
    // four names the CLI has never sent — `error_category` belongs to a
    // different message, `tool_progress.subagent_retry` — so every retry was
    // filed as free text and the one arm that acts on `server_error` could not
    // be reached (SES-7). Inference survives only for a value outside the
    // documented set, and says it is a guess.
    if (type === 'system' && sub === 'api_retry') {
      const error = typeof message.error === 'string' && message.error ? message.error : undefined;
      const documented = error && (API_RETRY_ERRORS as readonly string[]).includes(error) ? error : undefined;
      const detail = firstString(message, ['message', 'detail']) ?? error;
      const category = documented ?? inferRetryCategory(detail);
      if (category) retryCategories.push(category);
      const count = (key: string): number | undefined =>
        (typeof message[key] === 'number' ? message[key] as number : undefined);
      const maxRetries = count('max_retries');
      const retryDelayMs = count('retry_delay_ms');
      emit({
        kind: 'retry',
        category,
        ...(documented || !category ? {} : { inferred: true }),
        attempt: count('attempt'),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        // Null, not absent, when the CLI says no response arrived at all.
        ...('error_status' in message
          ? { errorStatus: typeof message.error_status === 'number' ? message.error_status : null }
          : {}),
        detail,
      });
      return;
    }

    if (type === 'stream_event') {
      const event = (message.event ?? {}) as { type?: string; delta?: Record<string, unknown> };
      if (event.type !== 'content_block_delta') return;
      const delta = event.delta ?? {};
      if (typeof delta.text === 'string' && delta.text) {
        // A subagent's words are not the phase's words; do not interleave them
        // into the same buffer, or a delegated stretch reads as one voice.
        if (parent) emit({ kind: 'subagent', text: delta.text, parent });
        else { pendingText += delta.text; scheduleFlush(); }
      } else if (typeof delta.thinking === 'string' && delta.thinking) {
        pendingThinking += delta.thinking;
        scheduleFlush();
      }
      return;
    }

    if (type === 'assistant') {
      // Whatever streamed as deltas is about to arrive again, whole.
      flushPartials();
      const content = (message.message as { content?: unknown[]; stop_reason?: string } | undefined);
      if (content?.stop_reason) stopReason = content.stop_reason;
      for (const block of content?.content ?? []) {
        const item = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
        if (item.type === 'text' && item.text) {
          // The reply to an operator's question repeats the question's tag, and
          // that is the only thing separating it from the phase's own words.
          // Without it the answer lands in the middle of a wall of build output
          // and the operator never sees that anything replied at all.
          const answering = !parent ? operatorMark(item.text.slice(0, 400)) : null;
          if (answering) emit({ kind: 'answer', text: stripMark(item.text), mark: answering });
          else if (parent) emit({ kind: 'subagent', text: item.text, parent });
          else emit({ kind: 'text', text: item.text });
        }
        if (item.type === 'tool_use' && item.name) {
          const id = typeof item.id === 'string' && item.id ? item.id : undefined;
          if (id) noteToolStart(id);
          const input = (item.input ?? {}) as Record<string, unknown>;
          // Kept by id for a denial that names the call but not its aim.
          if (id) {
            toolInfo.set(id, { name: item.name, summary: summarise(item.input) });
            if (toolInfo.size > MAX_PENDING_TOOLS) {
              const oldest = toolInfo.keys().next().value;
              if (oldest !== undefined) toolInfo.delete(oldest);
            }
          }
          // A delegation, and which agent it hands to — taken here rather than
          // guessed from its prose, because the console pairs subagent output
          // back to this call by id and "agent" as a label says nothing when
          // three of them are running.
          //
          // Two facts, not one, and measured rather than assumed: `subagent_type`
          // is **optional** on the tool, so a delegation with no type stated is
          // still a delegation and still needs a lane. Both are recorded so the
          // lane can open without a name rather than not open at all.
          const delegates = DELEGATING_TOOLS.has(item.name);
          const agent = delegates && typeof input.subagent_type === 'string' && input.subagent_type
            ? input.subagent_type.slice(0, 60) : undefined;
          emit({
            kind: 'tool',
            name: item.name,
            summary: summarise(item.input),
            ...(id ? { id } : {}),
            ...(delegates ? { delegates } : {}),
            ...(agent ? { agent } : {}),
            ...(parent ? { parent } : {}),
          });
          // The task list is in the stream and was being thrown away one
          // function call before it would have been kept: `summarise` reduces
          // the whole array to a sentence, and the array itself is the only
          // thing that can render as a task list.
          const todos = todoList(input);
          if (todos) emit({ kind: 'todos', items: todos });
          // …and the incremental spelling of the same thing, which is the one
          // the CLI actually uses.
          const task = taskOp(item.name, id, input);
          if (task) emit(task);
        }
      }
      // The turn itself, last: everything it contained has been emitted, so a
      // listener that counts steps and reacts to tools sees them in the order
      // they happened. A subagent's turn is not the phase's — see `step`.
      if (!parent) {
        // One API turn arrives as several assistant lines sharing a
        // `message.id` (its thinking, then its tool call), so the ledger
        // counts ids, not lines. The `step` below stays per line: the liveness
        // detectors were calibrated on it.
        const turnId = (message.message as { id?: unknown } | undefined)?.id;
        if (typeof turnId === 'string' && turnId) turnIds.add(turnId);
        else anonymousTurns++;
        emit({
          kind: 'step',
          tools: (content?.content ?? []).filter(
            (block) => (block as { type?: string }).type === 'tool_use',
          ).length,
        });
      }
      return;
    }

    // A `user` message is one of two quite different things: the results of the
    // tool calls the assistant just made, or the CLI replaying something we
    // wrote (`--replay-user-messages`). Both used to arrive at the same
    // `.text`-joining filter below — and a `tool_result` block has no `.text`
    // at all, which is why every result a session ever produced was dropped
    // here without a trace.
    if (type === 'user') {
      const blocks = (message.message as { content?: unknown[] } | undefined)?.content;
      const content = Array.isArray(blocks) ? blocks : [];

      // A result closes the loop on a call already announced, and carries the
      // id it was announced with. That pairing is what gives a tool call a
      // duration and an ok/error outcome instead of only a name.
      let results = 0;
      for (const block of content) {
        const item = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (item.type !== 'tool_result' || typeof item.tool_use_id !== 'string' || !item.tool_use_id) continue;
        results++;
        const ms = toolDuration(item.tool_use_id);
        const detail = resultDetail(item.content);
        // The words the session READ when the CLI said no: paired to a denial
        // by id, or in the CLI's own refusal sentence. Never an interrupted
        // call's "the tool use was rejected" (see `REFUSAL_RE`).
        const refused = item.is_error === true && (deniedIds.has(item.tool_use_id) || REFUSAL_RE.test(detail));
        emit({
          kind: 'tool-result',
          id: item.tool_use_id,
          ok: item.is_error !== true,
          ...(ms === undefined ? {} : { ms }),
          detail,
          ...(refused ? {
            refused: true,
            tool: toolInfo.get(item.tool_use_id)?.name ?? 'tool',
            // What was refused, so the journal line names a target as the
            // denial ledger's does (TRS-8) — not only the sentence the session read.
            ...(toolInfo.get(item.tool_use_id)?.summary ? { target: toolInfo.get(item.tool_use_id)!.summary } : {}),
          } : {}),
          // A subagent's tool calls are its own; attributing them to the phase
          // is how a delegated `rm -rf` reads as something the phase did.
          ...(parent ? { parent } : {}),
        });
      }
      if (results) return;

      // Everything below is the echo path, and a subagent's turns are never
      // ours to echo.
      if (parent) return;
      const text = content.map((b) => (b as { text?: string }).text).filter(Boolean).join(' ');
      // An echo is ours if and only if it carries a tag we are still waiting
      // on. This used to be positional — "the first echo is the boot prompt" —
      // which is right exactly once: a session started with `--resume`, or
      // restarted on another model, replays a history and every count is off by
      // however long that history was. The boot prompt and any replayed turn
      // carry no pending tag, so both are correctly ignored here.
      const mark = text ? operatorMark(text) : null;
      if (!mark || !unecho.delete(mark)) return;
      emit({ kind: 'injected', text: stripMark(text), mark, delivered: true });
      return;
    }

    if (type === 'result') {
      flushPartials();
      subtype = sub;
      // `total_cost_usd` is the running total for the whole session, not this
      // turn's share — so the last one wins and they are never summed. It is
      // taken above, for every message that carries one.
      //
      // The CLI's own error bit, and the finer reason for the ending. Both used
      // to reach the browser and stop there, so `classify()` believed
      // `subtype: success` for every failure text outside its patterns (SES-5).
      isError = message.is_error === true;
      terminalReason = typeof message.terminal_reason === 'string' && message.terminal_reason
        ? message.terminal_reason : undefined;
      // A result that reports a turn number already seen is a duplicate, not a
      // turn boundary — and telling those apart is the CLI's job, not ours.
      const reported = typeof message.num_turns === 'number' ? message.num_turns : null;
      const newTurn = reported === null || reported > turnsSeen;
      if (reported !== null) turnsSeen = Math.max(turnsSeen, reported);
      if (reported !== null) turns = Math.max(turns, reported);
      if (reported !== null) reportedTurns = Math.max(reportedTurns ?? 0, reported);
      const text = message.result ?? message.error;
      if (typeof text === 'string') resultText = text;
      // The authoritative denial ledger. A denial the stream already announced
      // is not announced twice; one it missed is announced now, with the input
      // this record carries and the reason it does not.
      if (Array.isArray(message.permission_denials)) {
        permissionDenials = message.permission_denials.slice(0, MAX_PENDING_TOOLS).flatMap((entry): PermissionDenial[] => {
          if (!entry || typeof entry !== 'object') return [];
          const denial = entry as { tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown };
          const toolUseId = typeof denial.tool_use_id === 'string' && denial.tool_use_id ? denial.tool_use_id : undefined;
          const target = summarise(denial.tool_input);
          return [{
            tool: typeof denial.tool_name === 'string' && denial.tool_name ? denial.tool_name : 'tool',
            ...(toolUseId ? { toolUseId } : {}),
            ...(target ? { target } : {}),
          }];
        });
        for (const denial of permissionDenials) {
          if (denial.toolUseId && deniedIds.has(denial.toolUseId)) continue;
          if (denial.toolUseId) deniedIds.add(denial.toolUseId);
          emit({ kind: 'permission-denied', ...denial, source: 'result' });
        }
      }
      // A `defer` (phase 14, spike S3): the call is kept on the result for a
      // `--resume` to run, and the console says so before anything reads the
      // ending as a turn that simply finished.
      const deferred = message.deferred_tool_use as { id?: unknown; name?: unknown } | undefined;
      if (deferred && typeof deferred === 'object') {
        emit({
          kind: 'deferred',
          ...(typeof deferred.id === 'string' ? { toolUseId: deferred.id.slice(0, 80) } : {}),
          ...(typeof deferred.name === 'string' ? { tool: deferred.name.slice(0, MAX_TOOL_NAME) } : {}),
        });
      }
      // A completed turn is closed; an aborted one (`aborted_streaming`,
      // `aborted_tools`) only stopped, and the stream's count covers its tail.
      if (!terminalReason?.startsWith('aborted')) turnOpen = false;
      // The first result ends the init→result stretch.
      if (initWatch) { initWatch = false; clearInitIdle(); }
      emit({
        kind: 'result',
        subtype,
        costUsd,
        turns,
        isError,
        ...(terminalReason ? { terminalReason } : {}),
      });

      // One result per TURN. The first belongs to the boot prompt, so the phase
      // has done its work; any after that answer an operator's message.
      //
      // The close rule, stated once: stdin closes on a result that ends a NEW
      // turn, when every message written has been echoed back. Reading it as
      // two questions rather than one subtraction makes both failure modes fall
      // out —
      //
      //   two messages folded into ONE turn: both drain from `unecho` as they
      //   are echoed, so the single result that follows closes (the counter
      //   needed a result each, and waited forever for the second — this is the
      //   wedge that left a finished phase reading `running` for 80 minutes);
      //
      //   an EXTRA result beyond the session's own turns: it is not a new turn,
      //   so it is not a close decision at all (the counter would have
      //   decremented to zero and closed the door on an unanswered question).
      if (!newTurn) { armIdle(); return; }
      phaseTurnDone = true;
      const wroteUntagged = sentSinceLastResult;
      sentSinceLastResult = false;
      if (!wroteUntagged && !unecho.size) closeStdin();
      else armIdle();
    }
  };

  const stdoutLines = lineReader(handleLine);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdoutLines.push(chunk));
  child.stdout?.on('error', (error) => log.warn('spawn.stdout', { error }));

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-KEEP_STDERR);
    if (BYPASS_DOWNGRADED.test(chunk)) noteBypassDowngrade(emit);
    emit({ kind: 'stderr', text: chunk });
  });
  child.stderr?.on('error', (error) => log.warn('spawn.stderr', { error }));

  child.on('error', (error: NodeJS.ErrnoException) => {
    request.signal?.removeEventListener('abort', onAbort);
    flushPartials();
    const reason = error.code === 'ENOENT'
      ? 'the `claude` CLI is not on PATH for this process'
      : `could not start claude: ${error.message}`;
    finish(fail(reason, started, shown, resolveCaps(request)));
  });

  child.on('close', (code, sig) => {
    request.signal?.removeEventListener('abort', onAbort);
    stdinOpen = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    stdoutLines.flush();
    flushPartials();

    // Result text first: it is the CLI's own account of why it stopped. stderr
    // follows because some failures never reach a result message at all.
    const text = [resultText, stderr].filter(Boolean).join('\n');
    // The ledger (SES-1). A session whose turn closed is booked on the CLI's
    // own count; one that ended with a turn still open is booked on whatever
    // is larger — that count, or the assistant turns the stream showed — since
    // the last `result` (if any) does not cover the work after it.
    const steps = turnIds.size + anonymousTurns;
    const midTurn = turnOpen;
    const bookedTurns = midTurn ? Math.max(reportedTurns ?? 0, steps) : (reportedTurns ?? steps);
    const turnsSource: 'result' | 'stream' = reportedTurns !== null && bookedTurns === reportedTurns ? 'result' : 'stream';
    const endedBy: EndedBy = ending?.endedBy ?? 'exit';
    const openTasks = [...backgroundTasks].map(([id, description]) => ({ id, description }));
    finish({
      signal: {
        subtype,
        code: code ?? (sig === 'SIGTERM' ? 143 : sig === 'SIGKILL' ? 137 : sig === 'SIGINT' ? 130 : null),
        stopReason,
        text,
        retryCategories,
        model: request.model,
        isError,
        permissionDenials,
        endedBy,
        ...(ending?.reason ? { endedReason: ending.reason } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        ...(openTasks.length ? { backgroundTasks: openTasks } : {}),
      },
      sessionId,
      costUsd,
      turns: bookedTurns,
      resultText,
      durationMs: Date.now() - started,
      argv: shown,
      injected,
      endedBy,
      ...(ending?.reason ? { endedReason: ending.reason } : {}),
      midTurn,
      steps,
      turnsSource,
      costSource,
      caps: resolveCaps(request),
    });
  });
});

function fail(reason: string, started: number, argv: string[], caps: SessionCaps): SpawnOutcome {
  return {
    signal: { subtype: 'error_during_execution', code: null, text: reason, endedBy: 'exit' },
    costUsd: 0,
    turns: 0,
    resultText: reason,
    durationMs: Date.now() - started,
    argv,
    injected: 0,
    // A child that never started ended itself, before any turn: nothing open,
    // nothing reported, nothing seen.
    endedBy: 'exit',
    midTurn: false,
    steps: 0,
    turnsSource: 'result',
    costSource: 'none',
    caps,
  };
}

/** A usage fraction from the wire (0–1) as the meters' percent (0–100), one decimal. */
export function percentOf(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 1_000) / 10;
}

/** The tag is plumbing; it belongs in the correlation, not on the screen. */
export function stripMark(text: string): string {
  return text.replace(OPERATOR_MARK, '').replace(/^\s+/, '');
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  // A todo write has none of the keys below, so it used to summarise as the
  // empty string — a bare `TodoWrite` in the console, at the one moment the
  // session is saying what it thinks it is doing.
  const todos = todoList(record);
  if (todos) {
    const done = todos.filter((t) => t.status === 'completed').length;
    const active = todos.find((t) => t.status === 'in_progress');
    return `${done}/${todos.length} done${active ? ` · ${active.activeForm || active.content}` : ''}`.slice(0, 240);
  }
  // A `TaskUpdate` carries `{ taskId, status }` and nothing else, so it used to
  // summarise as the empty string — a bare `TaskUpdate` in the console at the
  // exact moment the session is saying it finished something.
  if (typeof record.taskId === 'string' && record.taskId) {
    const status = typeof record.status === 'string' ? record.status : 'updated';
    return `#${record.taskId} → ${status}`;
  }
  for (const key of ['subject', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    // Long enough for a `git add … && git commit -m "…"` to keep its message:
    // truncating exactly the part a person reads made the old cap worse than
    // no summary at all.
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 240);
  }
  return '';
}

/** `TaskCreate` / `TaskUpdate` as a task-list transition, or null. */
function taskOp(name: string, call: string | undefined, input: Record<string, unknown>): StreamEvent | null {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value.slice(0, MAX_TASK_TEXT) : undefined;

  if (name === 'TaskCreate') {
    // `subject` is the one-line title; `description` is the brief. The title is
    // what a task list is a list of.
    const content = text(input.subject) ?? text(input.description);
    return content
      ? { kind: 'task', op: 'create', ...(call ? { call } : {}), content, activeForm: text(input.activeForm) }
      : null;
  }

  if (name === 'TaskUpdate') {
    const taskId = typeof input.taskId === 'string' ? input.taskId.slice(0, 32) : undefined;
    if (!taskId) return null;
    return {
      kind: 'task',
      op: 'update',
      taskId,
      status: text(input.status),
      content: text(input.subject),
      activeForm: text(input.activeForm),
    };
  }

  return null;
}

/** `TodoWrite`'s array, bounded, or null when this was not one. */
function todoList(input: Record<string, unknown>): TodoItem[] | null {
  const raw = input.todos;
  if (!Array.isArray(raw) || !raw.length) return null;
  const items: TodoItem[] = [];
  for (const entry of raw.slice(0, MAX_TASKS)) {
    if (!entry || typeof entry !== 'object') continue;
    const todo = entry as Record<string, unknown>;
    const content = typeof todo.content === 'string' ? todo.content
      : typeof todo.subject === 'string' ? todo.subject : '';
    if (!content) continue;
    items.push({
      content: content.slice(0, MAX_TASK_TEXT),
      status: typeof todo.status === 'string' ? todo.status : 'pending',
      ...(typeof todo.activeForm === 'string' && todo.activeForm
        ? { activeForm: todo.activeForm.slice(0, MAX_TASK_TEXT) } : {}),
    });
  }
  return items.length ? items : null;
}

/**
 * Enough of a tool result to say what happened.
 *
 * The content is a string on some tools and a block array on others, and on a
 * failure it is the error — which is the case this exists for. It is not a
 * transcript of the output: that is what the session's own words are for.
 */
function resultDetail(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content)
      ? content.map((b) => (b as { text?: string })?.text).filter((t) => typeof t === 'string' && t).join(' ')
      : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_RESULT_TEXT);
}

/**
 * NDJSON over a pipe arrives in chunks that split lines anywhere, including
 * mid-escape. Buffer until a newline; drop the buffer if it ever grows past
 * anything a real message could be, so a stuck stream cannot eat memory.
 */
export function lineReader(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE) {
        log.warn('spawn.line-overflow', { bytes: buffer.length });
        buffer = '';
      }
    },
    flush(): void {
      const line = buffer.trim();
      buffer = '';
      if (line) onLine(line);
    },
  };
}
