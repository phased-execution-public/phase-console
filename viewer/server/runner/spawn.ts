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
 * reintroduce them by passing extra arguments. One value of one of them is let
 * through, for one caller: `--setting-sources project,local` on an autopilot
 * session under `autopilotLoads: console-set` (measured-console phase 11) —
 * it keeps the repository's settings and the run's `--settings` and drops only
 * the operator's user-level ones, so their hooks and plugins do not load
 * unattended. Every other value stays forbidden.
 *
 * One flag is passed on the RUN's behalf rather than stripped: `--permission-prompts
 * none` rides every session no relay answers (`permissionPrompts`, decided by
 * `permissionPromptsFor` at the one spawn door), so anything that would prompt
 * is refused and the session is told nobody can approve. Its opposite rides a
 * session the relay IS armed for (phase 14): `--permission-prompt-tool` naming
 * the console's presence-only host (`permissionPromptTool`), which is what makes
 * the CLI offer `AskUserQuestion` in `-p`. Never both.
 */

import type { PlantedConfig } from '../git-guard.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { SPAWN_FIRST_EVENT_MS, SPAWN_INIT_IDLE_MS } from '../../shared/attention-model.js';
import { isProductiveEvent, suspectedStepOf, wakesTheSession, type SuspectedStep } from './liveness.ts';
import { MAX_TASKS, MAX_TASK_TEXT } from '../../shared/task-model.js';
import { ENDED_BY, type EndedBy } from '../../shared/run-lifecycle.js';
import { CHAT_TOOL_SERVER } from '../../shared/supervisor-model.js';
import { log } from '../log.ts';
import { parkedOutcome, sessionReaper } from './reap.ts';
import { API_RETRY_ERRORS, BG_WAIT_CEILING_MS, childEnv, type PermissionDenial, type StopSignal } from './errors.ts';
import { DEFAULT_KILL_AFTER_MS, INT_GRACE_MS, forgetInterrupt, groupSignal, interruptOnce, wakeAndTerm } from './signals.ts';
import { resolveCaps, type SessionCaps } from './session-record.ts';
import { printedCommits } from './scope-drift.ts';
import { foldUsage, newUsageTracker, usageOf, type CallUsage, type TokenCounters } from './usage.ts';
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
  /**
   * Let `--setting-sources project,local` through — that value and no other
   * (measured-console phase 11, D2): an autopilot session under
   * `autopilotLoads: console-set`, which loads the repository's settings and
   * the run's own and leaves out only the operator's user-level hooks and
   * plugins. `user` is never in it, and nothing else unlocks the flag.
   */
  allowSettingSources?: boolean;
};

/** The ONE `--setting-sources` value `sanitize()` can be told to pass (`loads.ts` names it too). */
export const ALLOWED_SETTING_SOURCES = 'project,local';

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
export const OPERATOR_MARK = /\[\[(ask|steer|relay|msg):([0-9a-z]{4,16})\]\]/i;

/** The tag in a piece of text, normalised, or null. */
export function operatorMark(text: string): string | null {
  const found = OPERATOR_MARK.exec(text);
  return found ? `${found[1].toLowerCase()}:${found[2].toLowerCase()}` : null;
}

/**
 * Build the tag for one operator message. `relay` is the console's own notice
 * after the relay answered a question nobody did (phase 14) — tagged like the
 * others so its echo is recognised, never an answer the console waits for.
 * `msg` is a PEER's message (5.1.0): tagged for the same reason and one more —
 * the same message can legitimately arrive twice (a restart sweep re-sending a
 * row a dead console left `delivering`, a boot prompt carrying a note a live
 * send already delivered), and the mark is the only thing that lets the
 * recipient tell.
 */
export function markFor(kind: 'ask' | 'steer' | 'relay' | 'msg', id: string): string {
  return `[[${kind}:${id}]]`;
}

/**
 * The mark on a PEER's message, as the receiving session replays it — or null.
 *
 * The socket transport learns nothing from the connection: the CLI's inbox
 * writes zero bytes back on every outcome, accepted or refused (phase 1, arm
 * S-B). The receiver's own stream is therefore the only evidence a message
 * landed, and arm S-E measured its exact shape — a `user` line with
 * `origin.kind === "peer"`, under `--replay-user-messages`, which `buildArgv`
 * already passes on every console-spawned session.
 *
 * It needs its own reader because `message.content` on that line is a **string**
 * while the echo path below reads `content` as an array of blocks: a peer
 * message therefore produced `[]`, then an empty text, then no mark, and was
 * invisible. Two readers over one line would be worse — a message recorded as
 * delivered twice — so this one is keyed on `origin.kind` and the echo path on
 * `unecho`, and neither can claim the other's line.
 */
export function peerMark(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const line = message as { type?: unknown; origin?: { kind?: unknown }; message?: { content?: unknown } };
  if (line.type !== 'user') return null;
  if (line.origin?.kind !== 'peer') return null;
  const content = line.message?.content;
  if (typeof content !== 'string' || !content) return null;
  return operatorMark(content);
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

/**
 * Why a session's input closed (control-tower phase 109, #170): its turn ended
 * with nothing outstanding and nothing of its own in the background
 * (`turn-end`), the idle closer (`idle`), a broken pipe (`epipe`), the console
 * ending it (`abort`), or its background work outliving the CLI's ceiling with
 * no new turn (`background-ceiling`). `adopted` is never a spawn's: it is a
 * live child a later console adopted from the run record with no pipe at all.
 */
export const INPUT_CLOSE_CAUSES = ['turn-end', 'idle', 'epipe', 'abort', 'background-ceiling', 'adopted'] as const;
export type InputCloseCause = typeof INPUT_CLOSE_CAUSES[number];

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
    /**
     * `system/init.plugins` — what LOADED, by name and source (`phased-execution@inline`
     * for a `--plugin-dir` tree, `<name>@<marketplace>`, `@builtin`), never a path
     * (measured-console phase 11, `phase.plugins`).
     */
    plugins?: { name: string; source: string; version?: string }[];
    /** `system/init.skills` — the skills the model may invoke, as the Skill tool names them. */
    skills?: string[];
    /** `system/init.slash_commands` — every command a person could type, the skills among them. */
    slashCommands?: string[];
  }
  /**
   * The model an assistant frame of the session's OWN conversation names
   * (`message.model`; one-pool phase 4, #281) — emitted when it differs from the
   * last frame's, never for a subagent's frame (a subagent may run on another
   * model by design) and never for the CLI's `<synthetic>` API-error lines. The
   * init frame says what the session started on; this is what each turn ran on,
   * which a mid-session fallback changes without a new init.
   */
  | { kind: 'model'; model: string; messageId?: string }
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
    /**
     * The call's scalar arguments — ONLY for the supervisor chat's own tools
     * (`mcp__pcchat__*`, control-tower phase 28), whose arguments are a slug,
     * a phase and a handful of words, and which the chat's action card names
     * as its target. Never for any other tool: an MCP server's arguments can
     * be a credential, and a stream event is written to transcripts.
     */
    args?: Record<string, string | number | boolean>;
    /** A `Skill` call's `skill` — the name it asked for (measured-console phase 11). */
    skill?: string;
  }
  /**
   * The result of one, paired back by `id`. See above.
   *
   * `refused` marks a result that is the CLI's permission system saying no —
   * paired by id to a `system/permission_denied`, or in the CLI's own refusal
   * sentence (`REFUSAL_RE`) — and `tool` then names the call. The words the
   * session READ, distinct from the denial the CLI recorded (`permission-denied`).
   */
  | {
    kind: 'tool-result'; id: string; ok: boolean; ms?: number; detail?: string; parent?: string; refused?: boolean;
    tool?: string; target?: string; commits?: string[];
    /**
     * The stall reading over the result's WHOLE text (control-tower phase 44,
     * `liveness.ts` `suspectedStepOf`) — a link and waiting words, redacted and
     * without a code — because `detail` is the first 200 characters and a
     * waiting CLI's link and words come last. Only the reading rides the event:
     * a stream event is written to transcripts, and the text itself is not.
     */
    suspected?: SuspectedStep;
  }
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
  /**
   * One API call of the PHASE's own conversation and what it cost in context
   * (autopilot-token-drain phase 3, `runner/usage.ts`).
   *
   * One event per call, not per line: the CLI emits a line per content block,
   * every one carrying the call's usage, so they are folded by `message.id`
   * (`id`) and a repeat is emitted only if it reported more. `totals` is the
   * session's fold after this call — what a lane keeps and shows, and what the
   * outcome carries as `tokens`. Emitted before the turn's `step`. A subagent's
   * calls are its own context and are not counted here, nor is the CLI's
   * synthetic zero-usage message.
   */
  | { kind: 'usage'; id?: string; call: CallUsage; rebuild: boolean; totals: TokenCounters }
  /**
   * A background task the CLI started, or reported finished, for this session
   * — `system/task_started` and `system/task_notification` (autopilot-token-drain
   * phase 1).
   *
   * Carried because a turn that ends while the session's own agent or monitor
   * works is a WAIT, not an exit: that task keeps the `-p` process alive and its
   * completion starts a new turn, where a background shell dies with the turn
   * (`liveness.ts` `wakesTheSession`). `tool` is the tool call that started the
   * task, paired by `tool_use_id` — a Monitor reaches the stream as
   * `task_type: local_bash`, like a background Bash, and only its tool tells
   * them apart.
   */
  | {
    kind: 'background'; op: 'started'; taskId: string;
    taskType?: string; tool?: string; description?: string; ownedBySubagent?: boolean;
    /** The starting call's id — a background agent's words carry it as `parent` (control-tower phase 109, #188). */
    toolUseId?: string;
  }
  | { kind: 'background'; op: 'ended'; taskId: string; status?: string }
  /**
   * The session's input closed, and why (control-tower phase 109, #170) — once
   * per spawn. Past it nothing can be written to the session: a steer, an
   * ask, a peer's message and the wrap-up notice are refused with this cause.
   */
  | { kind: 'input-closed'; cause: InputCloseCause; at: string }
  | { kind: 'hook'; name: string; event: string; outcome?: string }
  /**
   * A message the operator sent into a running session. Emitted twice for one
   * message and rendered once: the runner emits it undelivered the instant it
   * is written, and this emits it again — same `mark` — when the CLI echoes it
   * back, which is the only evidence it arrived.
   */
  | {
    kind: 'injected'; text: string; mark?: string; delivered?: boolean; steer?: boolean; relay?: boolean;
    /** A PEER's message, arriving over the CLI's own inbox rather than our stdin. */
    peer?: boolean;
  }
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
  | {
    kind: 'limits'; status: string; window?: string; utilization?: number; utilizationPct?: number; resetsAt?: number;
    /**
     * The CLI's overage fields (control-tower phase 93, #146), kept as the
     * CLI sends them: `isUsingOverage` (the window is spent and the session is
     * running on credit), `overageStatus` (`allowed`, `allowed_warning`,
     * `rejected`), `overageResetsAt` (epoch seconds) and
     * `overageDisabledReason` (`out_of_credits`, `org_spend_cap_reached`, …).
     */
    usingOverage?: boolean; overageStatus?: string; overageResetsAt?: number; overageDisabledReason?: string;
  }
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
  /**
   * `queuedTurns` is the result line's `queued_turn_count` (measured on CLI
   * 2.1.270, `test/fixtures/spikes/sigint.md`): how many turns the CLI still
   * holds queued behind this one — a message written mid-turn that it did not
   * fold into the turn. Absent on a CLI that does not say.
   */
  | {
    kind: 'result'; subtype?: string; costUsd?: number; turns?: number; isError?: boolean; terminalReason?: string;
    queuedTurns?: number;
    /**
     * The result line's own `usage` — the turn's totals as the CLI summed them (one-pool
     * phase 5). An endpoint that is not Anthropic's can leave a stream frame's output count at
     * 0 and report it only here, so the provider smoke reads this beside the stream's fold.
     */
    usage?: CallUsage;
  }
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
   * A permission card holds this session's hook open (one-pool phase 24, #220):
   * while one does, the session waits on a PERSON, not on itself, so neither
   * silence clock — the init→result bound (`SPAWN_INIT_IDLE_MS`, 55 min) nor the
   * idle closer — may end it; the card's own auto-deny (59 min 40 s) is the
   * clock that ends that wait. Keyed by the card's id, so two cards are two
   * holds; the last release re-stamps the silence clocks, as a thaw does.
   */
  holdForCard?(cardId: string, open: boolean): void;
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
  /**
   * With `resume`: continue it under a NEW session id (`--fork-session`), so
   * the resumed conversation is a branch and the original stays as it was.
   */
  forkSession?: boolean;
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
  /**
   * Tools served from THIS process (measured-console phase 21, B1): the SDK
   * door hands them to `query()` as an in-process MCP server
   * (`createSdkMcpServer`), so they reach the session as
   * `mcp__<server>__<tool>`, exactly as a stdio server of that name would.
   * The subprocess door has no such channel and ignores the field; a caller
   * that may take either door gives that one its stdio server in `mcpConfig`.
   */
  inProcessTools?: InProcessTools;
  /** Ignore every MCP server not passed explicitly. */
  strictMcp?: boolean;
  /** JSON passed to `--settings`: the per-run hook and its ask-rules (W3). */
  settings?: string;
  /**
   * `--plugin-dir`, one per entry (measured-console phase 11): the console's
   * own skill tree for its revision, loaded in place for this session only.
   */
  pluginDirs?: string[];
  /**
   * `--setting-sources project,local` — set by the runner's spawn door alone,
   * for a session under `autopilotLoads: console-set`, and the one value
   * `sanitize()` lets through (`ALLOWED_SETTING_SOURCES`).
   */
  settingSources?: typeof ALLOWED_SETTING_SOURCES;
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
   * How long the input is held open past a turn for the session's own
   * background agents with no new turn (control-tower phase 109, #170) —
   * `BG_WAIT_CEILING_MS`, the CLI's own ceiling, unless a test says otherwise.
   */
  bgWaitCeilingMs?: number;
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
  /**
   * A CONVERSATION rather than a phase (the supervisor chat, control-tower
   * phase 27): stdin stays open across results and closes only on abort, and
   * the idle watchdog never arms — silence between an operator's messages is
   * the conversation, not a wedged session. Every other watchdog still holds.
   */
  conversation?: boolean;
  /** Text appended to the CLI's own system prompt (`--append-system-prompt`) — the supervisor chat's rules. */
  appendSystemPrompt?: string;
  /** The `--agents` JSON — the side-work agents on the subagent model (`sideAgents`, measured-console phase 6). */
  agents?: string;
  /**
   * The `--json-schema` value (measured-console phase 12, B4): the outcome's
   * session schema (`shared/outcome-schema.js`), given to every session that
   * can declare one — the result frame then carries it as `structured_output`.
   */
  jsonSchema?: string;
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
  /**
   * Git configuration the session planted in the trees it could reach (one-pool
   * phase 2, #272), found by the spawn door when it ended — the door has
   * already halted the lane `run-tree-config`, so a caller stops here.
   */
  plantedConfig?: PlantedConfig[];
  /**
   * Why the spawn door refused the session's model before it started (one-pool phase 5) —
   * nothing on the run's account serves it. The door has already halted the run
   * `models-exhausted`, so a caller stops here.
   */
  modelRefused?: string;
  /**
   * The orphaned `index.lock`s the spawn door found in the session's trees
   * before it started (one-pool phase 20, #328). The door has already halted
   * the lane `run-tree-locked`, so a caller stops here.
   */
  treeLocked?: { tree: string; path: string; mtime: string; ageMs: number }[];
  /**
   * The model the session's own `system/init` frame reported (control-tower
   * phase 54, #91) — what the request RESOLVED to, beside `request.model`,
   * which is only what was asked. Absent when the child never got that far.
   */
  resolvedModel?: string;
  costUsd: number;
  /** Every prompt's `num_turns`, summed — the session's total, never a figure to read against `--max-turns`. */
  turns: number;
  /**
   * The largest turn count of any ONE prompt of the session (control-tower
   * phase 89, #62's SIZ-7): the CLI's `--max-turns` binds per prompt, so a
   * session woken more than once — by its own background subagent, by an
   * operator's message — can pass its cap in sum and never near it in any one
   * prompt. This is the figure a turn cap is read against, and the one cap
   * calibration samples. A prompt still open at the end counts the assistant
   * turns the stream showed since the last `result`; a session that never
   * reported one was one prompt, so it is the session's whole count. Optional
   * in the type like the ledger's other fields; `spawnClaude` always sets it.
   */
  promptTurns?: number;
  resultText: string;
  /**
   * The last result frame's `structured_output` (measured-console phase 12,
   * B4): the outcome a session started with `--json-schema` returned, as the
   * CLI validated it. Absent when no result carried one. The runner reads it
   * BEFORE the outcome file (`outcome.ts` `reconcileOutcome`).
   */
  structuredOutput?: unknown;
  /**
   * The last prose the phase's OWN conversation wrote — no subagent's, and no
   * assistant line the CLI flagged as an API error (control-tower phase 80,
   * #108). When the result is the CLI reporting it could not reach the API,
   * this is what the session actually said last (`session-record.ts`
   * `lastWords`). Absent when it wrote none.
   */
  lastText?: string;
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
  /**
   * The conversation's running `total_cost_usd` when the session first ran on
   * credit (`isUsingOverage`, control-tower phase 93, #146) — what it spent
   * past this mark it spent from the account's credits. Absent: no turn of
   * this spawn ran on credit.
   */
  creditFromUsd?: number;
  /**
   * What the console BOOKED for this spawn — `costUsd` less the session's
   * high-water mark, because a `--resume` re-reports the conversation's running
   * total (control-tower phase 46, #62). Set by the runner's spawn door
   * (`RunnerBase.bookSpend`), never by `spawnClaude`; every figure a caller books
   * or journals as "what this session cost" reads this one.
   */
  bookedUsd?: number;
  /** The caps that reached argv, with their sources. */
  caps?: SessionCaps;
  /** The session's API calls folded (`runner/usage.ts`): context, caching, rebuilds. Zero calls when none streamed. */
  tokens?: TokenCounters;
};

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;

/** One argument of an in-process tool — the supervisor chat's `ChatToolArg` shape. */
export type InProcessToolArg = {
  name: string; type: 'string' | 'integer' | 'number' | 'boolean'; required: boolean; summary: string; values?: readonly string[];
};
/** An in-process MCP server: its tools, and the one function every call of theirs goes to. */
export type InProcessTools = {
  server: string;
  tools: readonly { name: string; description: string; args: readonly InProcessToolArg[] }[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
};

/**
 * The backends behind the one door (measured-console phase 20, B1): the
 * `claude` subprocess, and the Agent SDK's `query()` (`server/pro/spawn-sdk/`).
 */
export const SPAWN_BACKENDS = ['subprocess', 'sdk'] as const;
export type SpawnBackend = (typeof SPAWN_BACKENDS)[number];

/** The SDK door, loaded — or why not: `absent` is the optional dependency not installed. */
export type SdkDoorAnswer =
  | { ok: true; spawn: SpawnFn; version: string }
  | { ok: false; reason: 'absent' | 'load-failed' | 'fallback'; detail?: string };

/**
 * A session's usage meter (one-pool phase 6 — Pro's ledger, `pro/accounts/meter.ts`): fed every
 * event the session emits and ended once, with its outcome or with nothing when the spawn threw.
 * The console's own sessions that are nobody's run (the supervisor's chat, the checker, the plan
 * author) take one from their host; absent, nothing is metered.
 */
export type SessionMeterHandle = { onEvent(event: StreamEvent): void; end(outcome: SpawnOutcome | null): void };

/** argv is bounded by the OS; a boot prompt is kilobytes, so this is a sanity bound. */
const MAX_PROMPT_BYTES = 512 * 1024;
/** Keep the last of stderr for classification — not a whole build log. */
const KEEP_STDERR = 16_000;
/**
 * The API-error channel's own pieces, kept newest last (control-tower phase 54,
 * #57): an API error is one sentence, and a session that met eight of them has
 * said everything the classifier needs.
 */
const KEEP_API_PARTS = 8;
/** One API-error message's words, bounded — the CLI's sentence, never a transcript. */
const MAX_API_PART = 2_000;
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
 * How long before a turn's `result` an operator message must have been written
 * for that result to vouch for it (one-pool phase 24, #259). A completed result
 * reporting `queued_turn_count: 0` says the CLI holds nothing queued, so every
 * tagged message written before the turn ended was READ — folded into the turn,
 * mid-turn, without the echo the close rule waits on (the console's own 60 %
 * wrap-up steer, three sightings at 10 idle minutes a lane). The grace keeps a
 * message written in the milliseconds after the CLI printed that result, which
 * the CLI will read as its NEXT turn, out of the drain.
 */
export const FOLDED_MARK_GRACE_MS = 500;
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

/** A bounded list of short names out of a frame — strings only, each cut to 120. */
function names(list: unknown[], max: number): string[] {
  return list.filter((name): name is string => typeof name === 'string' && Boolean(name)).slice(0, max).map((name) => name.slice(0, 120));
}

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
  if (request.resume) {
    argv.push('--resume', request.resume);
    if (request.forkSession) argv.push('--fork-session');
  } else argv.push('--session-id', request.sessionId ?? randomUUID());
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
  // What loads (measured-console phase 11): the console's tree, then the one
  // allowed value of the one allowed source list. Blanks are dropped, as
  // `--add-dir`'s are, so an unresolved path never swallows the next flag.
  for (const dir of (request.pluginDirs ?? []).filter((d) => Boolean(d?.trim()))) argv.push('--plugin-dir', dir);
  const settingSources = request.settingSources === ALLOWED_SETTING_SOURCES;
  if (settingSources) argv.push('--setting-sources', ALLOWED_SETTING_SOURCES);
  if (request.appendSystemPrompt?.trim()) argv.push('--append-system-prompt', request.appendSystemPrompt);
  if (request.agents) argv.push('--agents', request.agents);
  if (request.jsonSchema) argv.push('--json-schema', request.jsonSchema);
  return sanitize(argv, { allowBypass: bypass, allowSettingSources: settingSources });
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
      // The one allowance (measured-console phase 11): this flag, this value,
      // asked for by the caller. Anything else under it is dropped as before.
      if (arg === '--setting-sources' && opts.allowSettingSources && argv[i + 1] === ALLOWED_SETTING_SOURCES) {
        out.push(arg, argv[i + 1]);
        i++;
        continue;
      }
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

/**
 * The read-only agents a session hands side work to, on the plan's subagent
 * model (measured-console phase 6, A5): `Explore` — named so it overrides the
 * built-in, which `CLAUDE_CODE_SUBAGENT_MODEL` alone does not move — a log
 * reader and a docs reader. Read-only tools only: side work reads and reports,
 * and the session that asked does every edit on its own model. Nothing here
 * switches the session's own model mid-run.
 */
export const SIDE_AGENT_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob']);

export function sideAgents(model: string): Record<string, { description: string; prompt: string; tools: string[]; model: string }> {
  const tools = [...SIDE_AGENT_TOOLS];
  return {
    Explore: {
      description: 'Read-only search across many files: finds where something is and returns the conclusion with paths, not file dumps.',
      prompt: 'You search a codebase read-only. Answer the question with file paths and line numbers and a short conclusion. Never edit a file.',
      tools, model,
    },
    'log-reader': {
      description: 'Reads a long log or test output and returns only what failed, with the ids and the lines that say why.',
      prompt: 'You read logs read-only. Return the failing test ids, the error lines that explain each, and the log path. Never edit a file.',
      tools, model,
    },
    'docs-reader': {
      description: 'Reads documentation pages or reference files and returns the exact facts asked for, quoted, with where they came from.',
      prompt: 'You read documentation read-only. Quote the exact sentences that answer the question and say which file or page each came from. Never edit a file.',
      tools, model,
    },
  };
}

/** One NDJSON user message, the shape the CLI reads in streaming-input mode. */
export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * What the session core drives: the `claude` child itself, or a backend's
 * stand-in for one (measured-console phase 20, B1). The core writes stream-json
 * user lines to `stdin`, reads the CLI's stream-json frames from `stdout`, and
 * signals `pid`'s group — so a stand-in hands it the frames of the session it
 * runs and the pid of the `claude` it started. A stand-in whose process starts
 * a moment later announces the pid with `'spawn'`, as a `ChildProcess` does.
 */
export type SessionChild = {
  readonly pid?: number;
  stdin: NodeJS.WritableStream & { writable: boolean } | null;
  stdout: NodeJS.ReadableStream & { setEncoding(encoding: BufferEncoding): unknown } | null;
  stderr: NodeJS.ReadableStream & { setEncoding(encoding: BufferEncoding): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
};

/**
 * A backend: how a session's process is started, given the argv and the
 * environment the door decided. The one interpreter above it reads whatever
 * it starts — which is what makes two backends indistinguishable to everything
 * above the door (`invariants.test.ts` clause 1).
 */
export type SessionOpener = (request: SpawnRequest, argv: string[], env: NodeJS.ProcessEnv) => SessionChild;

/** The subprocess backend: `claude` on PATH, piped, in its own process group. */
const openSubprocess: SessionOpener = (request, argv, env) => spawn('claude', argv, {
  cwd: request.cwd,
  env,
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

export const spawnClaude: SpawnFn = (request) => spawnVia(request, openSubprocess);

/**
 * The session core, over any backend (measured-console phase 20): the argv and
 * environment are decided here for both, the opener starts the process, and
 * every event, watchdog, signal and outcome below is the same code whichever
 * started it.
 */
export const spawnVia = (request: SpawnRequest, open: SessionOpener): Promise<SpawnOutcome> => new Promise<SpawnOutcome>((resolve) => {
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

  const child = open(request, argv, childEnv({ ...request.env, PE_SESSION_ID: sessionIdForChild }));
  // Its descendants are recorded while it lives, and the test runners among
  // them that outlive it are ended with it (one-pool phase 26, #222). A
  // backend whose `claude` starts a moment later says so with `'spawn'`.
  const noteChildPid = (pid: number): void => {
    sessionReaper.begin(pid, { sessionId: sessionIdForChild });
    request.onPid?.(pid);
  };
  if (child.pid) noteChildPid(child.pid);
  else child.once('spawn', () => { if (child.pid) noteChildPid(child.pid); });

  let sessionId = request.resume ?? undefined;
  let costUsd = 0;
  let creditFromUsd: number | undefined;
  let turns = 0;
  let resultText = '';
  let structuredOutput: unknown;
  // The phase's own last prose (#108) — never a subagent's, never an assistant
  // line the CLI flagged as the API speaking.
  let lastText = '';
  // The last model an assistant frame of the session's own conversation named (#281).
  let lastFrameModel: string | undefined;
  let subtype: string | undefined;
  let stopReason: string | null | undefined;
  let stderr = '';
  const retryCategories: string[] = [];
  // What the init frame said the request resolved to (#91).
  let resolvedModel: string | undefined;
  // The CLI's API-ERROR channel, apart from everything the model wrote (#57):
  // the kinds and the words of the assistant messages it flags as API errors,
  // and the result's own `errors`. stderr joins them at the close.
  const apiErrors: string[] = [];
  const apiParts: string[] = [];
  const noteApiPart = (text: string): void => {
    apiParts.push(text.slice(0, MAX_API_PART));
    if (apiParts.length > KEEP_API_PARTS) apiParts.shift();
  };
  let settled = false;

  /* ---- the session ledger ---- *
   *
   * What the stream already says, kept so a session that never reaches its
   * `result` is still booked (SES-1). The CLI books turns and dollars on the
   * `result` alone; SIGINT now makes an interrupted turn write one, and these
   * cover the endings where nothing does.
   *
   *   `costSource`       where the last `total_cost_usd` came from, or `none`.
   *   `reportedTurns`    the CLI's own `num_turns`, summed over the session's
   *                      turns — the CLI counts each turn from one (see the
   *                      `result` handler).
   *   `largestPrompt`    the largest of those counts, one prompt's: what the
   *                      CLI's per-prompt `--max-turns` binds (#62's SIZ-7).
   *   `stepsAtResult`    the stream's count when the last `result` came, so a
   *                      prompt still open at the end has a count of its own.
   *   `turnIds`          distinct `message.id`s of the phase's own assistant
   *                      messages. One API turn arrives as SEVERAL assistant
   *                      lines — its thinking and its tool call share one id
   *                      (measured, `test/fixtures/spikes/sigint.md`) — so a
   *                      count of lines would over-book it.
   *   `turnOpen`         a user message went in and no completed `result` has
   *                      come back for it. A `result` whose `terminal_reason`
   *                      is `aborted_*` closed the turn without finishing it.
   *   `ending`           who ended the session, first writer wins.
   *   `usage`            the phase's own API calls folded by `message.id` —
   *                      context, caching, rebuilds (`runner/usage.ts`). A
   *                      resumed session's first call can rebuild; a fresh
   *                      one's builds.
   */
  let costSource: 'result' | 'stream' | 'none' = 'none';
  let reportedTurns: number | null = null;
  let largestPrompt = 0;
  let stepsAtResult = 0;
  const turnIds = new Set<string>();
  let anonymousTurns = 0;
  const usage = newUsageTracker({ resumed: Boolean(request.resume) });
  let turnOpen = true;                 // the boot prompt is the first open turn
  let isError = false;
  let terminalReason: string | undefined;
  let permissionDenials: PermissionDenial[] = [];
  /** `tool_use` ids the stream said were denied, so a result entry is not a second event. */
  const deniedIds = new Set<string>();
  /** A tool call's name and aim, by id — what a `permission_denied` line does not repeat. Bounded like `toolStartedAt`. */
  const toolInfo = new Map<string, { name: string; summary: string }>();
  /**
   * Background tasks the CLI started and has not reported finished
   * (`system/task_started`), with the CLI's `task_type` and the tool call that
   * started each — see the `background` event.
   */
  const backgroundTasks = new Map<string, { description: string; taskType?: string; tool?: string; ownedBySubagent?: boolean }>();
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
   *   `lastResultTurns`      the previous `result`'s `num_turns`, and
   *   `movedSinceResult`     whether the conversation moved after it — the two
   *                          facts that tell an extra `result` for a turn
   *                          already counted from a genuine new turn. Only a
   *                          new turn may close stdin, so a duplicate cannot
   *                          close the door on a question not yet answered.
   */
  /** The boot-prompt turn has produced its result: the phase's work is done. */
  let phaseTurnDone = false;
  /** An UNTAGGED message written since the previous result. See above. */
  let sentSinceLastResult = false;
  /** Tags of operator messages written but not yet echoed back by the CLI. */
  const unecho = new Set<string>();
  /** When each tag in `unecho` was written — what `FOLDED_MARK_GRACE_MS` reads. */
  const unechoAt = new Map<string, number>();
  /** The previous result's `num_turns`; `undefined` until a result arrives. */
  let lastResultTurns: number | null | undefined;
  /** A user, assistant, delta or task-notification line arrived after the previous result. */
  let movedSinceResult = false;
  /** The same, of the session's OWN conversation — never a subagent's line (#170's background hold). */
  let turnSinceResult = false;
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

  /**
   * One sighting of an API call's usage, from whichever line carried it — the
   * `message_start` and `message_delta` stream events or the assistant lines —
   * folded by the call's id, so only a new call or a sighting that reported more
   * reaches the listener. The phase's own conversation only; callers check.
   *
   * All three, because none is enough alone (measured on the live CLI,
   * 2026-09-17): `message_start` is the earliest and its context is exact, but
   * its `output_tokens` is a snapshot of 2–4, and every assistant line of the
   * call repeats that snapshot; only `message_delta` carries the final count,
   * and it exists only with partial messages on.
   */
  let streamCallId: string | undefined;
  const noteUsage = (callId: string | undefined, raw: unknown): void => {
    const call = usageOf(raw);
    if (!call) return;
    const folded = foldUsage(usage, callId, call);
    if (!folded.changed) return;
    emit({
      kind: 'usage', ...(callId ? { id: callId } : {}),
      call: folded.call, rebuild: folded.rebuild, totals: { ...usage.counters },
    });
  };

  /* ---- writing to the child ---- */

  /**
   * The moment the input closes, and why — said once, as an `input-closed`
   * event (control-tower phase 109, #170): a live session whose stdin closed
   * cannot be steered, asked, told a peer's message or told to wrap up, and
   * the console used to answer that it was not running at all.
   */
  let closedFor: InputCloseCause | null = null;
  /** The background hold's clock, and whether it has run out — see `holdForBackground`. */
  let backgroundHold: NodeJS.Timeout | null = null;
  let holdExpired = false;
  const noteInputClosed = (cause: InputCloseCause): void => {
    if (closedFor) return;
    closedFor = cause;
    if (backgroundHold) { clearTimeout(backgroundHold); backgroundHold = null; }
    emit({ kind: 'input-closed', cause, at: new Date().toISOString() });
  };

  // EPIPE on a child that has already gone is normal, not a fault: it means the
  // session ended between our deciding to write and the write landing.
  child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
    stdinOpen = false;
    if (error.code !== 'EPIPE') log.warn('spawn.stdin', { error });
    noteInputClosed('epipe');
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

  const closeStdin = (cause: InputCloseCause): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    try { child.stdin?.end(); } catch { /* already gone */ }
    noteInputClosed(cause);
  };

  /*
   * The input stays open while the session's OWN agents or monitors work
   * (control-tower phase 109, #170). It closed at the first turn's result
   * whenever nothing of ours was in flight — but a session that ended its turn
   * to wait on its background agent (wait rule 4) runs on: each notification
   * starts a turn that does real work, and with its input closed the console
   * could not steer it, ask it, or reach it with the 0.6× wrap-up. Held open,
   * the next turn's result closes it once nothing is left to wake the session —
   * bounded by the idle closer, and by the CLI's own background ceiling: a
   * hold with no new turn for `bgWaitCeilingMs` closes it (`background-ceiling`),
   * which is the moment the CLI would have stopped that work anyway.
   */
  const holdingBackground = (): boolean => [...backgroundTasks.values()].some(wakesTheSession);
  const armBackgroundHold = (): void => {
    backgroundHold = setTimeout(() => {
      backgroundHold = null;
      // A frozen lane's stretch is the operator's, not the session's: the
      // clock starts again at the thaw (`setFrozen`), as the idle closer's does.
      if (frozen) return;
      holdExpired = true;
      // A turn of its OWN in progress keeps the input until its result, where
      // the close rule closes it; a background agent's chatter does not.
      if (!stdinOpen || settled || turnSinceResult) return;
      closeStdin('background-ceiling');
    }, Math.max(1, request.bgWaitCeilingMs ?? BG_WAIT_CEILING_MS));
    backgroundHold.unref?.();
  };
  const holdForBackground = (): boolean => {
    if (holdExpired || !holdingBackground()) return false;
    // One clock for the whole hold, from its first turn — never re-armed by a
    // later one, so a monitor waking the session every few minutes cannot hold
    // the input open for ever.
    if (!backgroundHold) {
      armBackgroundHold();
    }
    return true;
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
  /** The permission cards holding this session's hook open — see `SpawnHandle.holdForCard`. */
  const cardHolds = new Set<string>();
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
    if (!phaseTurnDone || !stdinOpen || settled || idleAfter <= 0 || request.conversation) return;
    // A frozen lane is silent BY CONSTRUCTION. Measuring that silence and
    // acting on it is the watchdog mistaking the operator's own act for the
    // failure it exists to catch. A card a person has not answered is the same (#220).
    if (frozen || cardHolds.size) return;
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
      closeStdin('idle');
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
      if (mark) { unecho.add(mark); unechoAt.set(mark, Date.now()); }
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
      // …and the background hold's clock starts again too (#170).
      if (stdinOpen && !settled && !holdExpired && holdingBackground()) {
        if (backgroundHold) clearTimeout(backgroundHold);
        armBackgroundHold();
      }
    },
    holdForCard: (cardId: string, open: boolean) => {
      if (open) {
        if (cardHolds.has(cardId)) return;
        cardHolds.add(cardId);
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        clearInitIdle();
        return;
      }
      if (!cardHolds.delete(cardId) || cardHolds.size) return;
      // The wait on a person was not silence the session chose (the thaw's rule).
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
    closeStdin('abort');
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
  // An abort that landed before the listener did — the door awaits its backend
  // between the run's stop and this line — is acted on now, not never.
  if (request.signal?.aborted) onAbort();

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
    if (!initWatch || settled || frozen || cardHolds.size || initIdleAfter <= 0) return;
    initIdleTimer = setTimeout(() => {
      initIdleTimer = null;
      if (!initWatch || settled || frozen || cardHolds.size) return;
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
    // The conversation moved: what separates a new turn's `result` from a
    // repeat of the last one (see the `result` handler).
    if (type === 'user' || type === 'assistant' || type === 'stream_event'
      || (type === 'system' && sub === 'task_notification')) {
      movedSinceResult = true;
      // …and whether the session's OWN conversation did: a background agent's
      // lines carry its parent call, and must not hold the input past the
      // hold's clock (control-tower phase 109, #170).
      if (!parent) turnSinceResult = true;
    }

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
      if (typeof message.model === 'string' && message.model) resolvedModel = message.model.slice(0, 120);
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
        // What loaded (measured-console phase 11): names and sources, bounded,
        // never a path — a tree's path names the state directory.
        ...(Array.isArray(message.plugins) ? {
          plugins: message.plugins.flatMap((entry) => {
            const plugin = entry as { name?: unknown; source?: unknown; version?: unknown } | null;
            return typeof plugin?.name === 'string' && plugin.name
              ? [{
                name: plugin.name.slice(0, MAX_TOOL_NAME),
                source: typeof plugin.source === 'string' ? plugin.source.slice(0, 120) : plugin.name.slice(0, MAX_TOOL_NAME),
                ...(typeof plugin.version === 'string' && plugin.version ? { version: plugin.version.slice(0, 40) } : {}),
              }]
              : [];
          }).slice(0, MAX_TOOL_NAMES),
        } : {}),
        ...(Array.isArray(message.skills) ? { skills: names(message.skills, 300) } : {}),
        ...(Array.isArray(message.slash_commands) ? { slashCommands: names(message.slash_commands, 300) } : {}),
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
    // since the CLI's own warning names only the ceiling. Each start and end is
    // also an event: the Stop hook and liveness need to know, while the session
    // lives, whether a turn ended on an agent or monitor that will wake it.
    if (type === 'system' && (sub === 'task_started' || sub === 'task_notification')) {
      const taskId = typeof message.task_id === 'string' ? message.task_id.slice(0, 80) : '';
      if (taskId && sub === 'task_started') {
        const description = (typeof message.description === 'string' ? message.description : '').slice(0, MAX_RESULT_TEXT);
        const taskType = typeof message.task_type === 'string' && message.task_type
          ? message.task_type.slice(0, 40) : undefined;
        const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : '';
        const tool = toolUseId ? toolInfo.get(toolUseId)?.name : undefined;
        backgroundTasks.set(taskId, {
          description, ...(taskType ? { taskType } : {}), ...(tool ? { tool } : {}),
          ...(message.owned_by_subagent === true ? { ownedBySubagent: true } : {}),
        });
        if (backgroundTasks.size > MAX_PENDING_TOOLS) {
          const oldest = backgroundTasks.keys().next().value;
          if (oldest !== undefined) backgroundTasks.delete(oldest);
        }
        emit({
          kind: 'background', op: 'started', taskId,
          ...(taskType ? { taskType } : {}),
          ...(tool ? { tool } : {}),
          ...(description ? { description } : {}),
          ...(message.owned_by_subagent === true ? { ownedBySubagent: true } : {}),
          ...(toolUseId ? { toolUseId: toolUseId.slice(0, 80) } : {}),
        });
      } else if (taskId) {
        backgroundTasks.delete(taskId);
        emit({
          kind: 'background', op: 'ended', taskId,
          ...(typeof message.status === 'string' && message.status ? { status: message.status.slice(0, 40) } : {}),
        });
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
      const usingOverage = typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined;
      if (usingOverage && creditFromUsd === undefined) creditFromUsd = costUsd;
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
        // The credit fields ride beside the window's, verbatim (#146).
        ...(usingOverage === undefined ? {} : { usingOverage }),
        ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
        ...(typeof info.overageResetsAt === 'number' ? { overageResetsAt: info.overageResetsAt } : {}),
        ...(typeof info.overageDisabledReason === 'string' && info.overageDisabledReason
          ? { overageDisabledReason: info.overageDisabledReason } : {}),
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
      const event = (message.event ?? {}) as {
        type?: string; delta?: Record<string, unknown>; message?: { id?: unknown; usage?: unknown }; usage?: unknown;
      };
      // The API call opening and closing: its id and exact context at the start,
      // its final output count at the delta (`noteUsage`). A delta names no id,
      // so it belongs to the call the last start opened.
      if (event.type === 'message_start' || event.type === 'message_delta') {
        if (parent) return;
        if (event.type === 'message_start') {
          const callId = event.message?.id;
          streamCallId = typeof callId === 'string' && callId ? callId : undefined;
          noteUsage(streamCallId, event.message?.usage);
        } else if (streamCallId) {
          noteUsage(streamCallId, event.usage);
        }
        return;
      }
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
      // An assistant message the CLI flags as an API ERROR — its `error` kind
      // (`SDKAssistantMessageError`), or `is_api_error_message` — is the API
      // speaking, not the model: its kind and its words go to the channel the
      // credential classes read (#57). Every other assistant line is prose.
      const apiError = typeof message.error === 'string' && message.error ? message.error.slice(0, 60) : undefined;
      const apiSpeaking = Boolean(apiError) || message.is_api_error_message === true;
      // What this turn RAN on (#281): a fallback mid-session moves it without a
      // new init frame, so the pin is checked here as well as there.
      const frame = message.message as { model?: unknown; id?: unknown } | undefined;
      if (!parent && !apiSpeaking && typeof frame?.model === 'string' && frame.model
        && frame.model !== '<synthetic>' && frame.model !== lastFrameModel) {
        lastFrameModel = frame.model;
        emit({
          kind: 'model', model: frame.model.slice(0, 120),
          ...(typeof frame.id === 'string' && frame.id ? { messageId: frame.id.slice(0, 80) } : {}),
        });
      }
      if (apiSpeaking) {
        if (apiError) apiErrors.push(apiError);
        for (const block of content?.content ?? []) {
          const item = block as { type?: string; text?: string };
          if (item.type === 'text' && item.text) noteApiPart(item.text);
        }
      }
      for (const block of content?.content ?? []) {
        const item = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
        if (item.type === 'text' && item.text) {
          // The reply to an operator's question repeats the question's tag, and
          // that is the only thing separating it from the phase's own words.
          // Without it the answer lands in the middle of a wall of build output
          // and the operator never sees that anything replied at all.
          const answering = !parent ? operatorMark(item.text.slice(0, 400)) : null;
          if (!parent && !apiSpeaking) lastText = item.text;
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
            ...(item.name.startsWith(CHAT_TOOL_PREFIX) ? { args: chatToolArgs(input) } : {}),
            // Which skill a Skill-tool call asked for (measured-console phase
            // 11, `phase.skill-invoked`): a name, never its arguments.
            ...(item.name === 'Skill' && typeof input.skill === 'string' && input.skill
              ? { skill: input.skill.slice(0, 120) } : {}),
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
        // What this API call cost in context — already known from its
        // `message_start` when partial messages are on, and the only source
        // when they are off (`noteUsage`).
        noteUsage(
          typeof turnId === 'string' && turnId ? turnId : undefined,
          (message.message as { usage?: unknown } | undefined)?.usage,
        );
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
      // A PEER's message, replayed. Read before the block path below because
      // its `message.content` is a STRING, not an array of blocks — so the
      // block path sees nothing at all and a socket delivery had no evidence
      // (phase 1, arm S-E). Keyed on `origin.kind`, never on a pending tag:
      // this message never went down our stdin and so never entered `unecho`.
      const peer = parent ? null : peerMark(message);
      if (peer) {
        emit({ kind: 'injected', text: stripMark(String((message.message as { content?: string }).content ?? '')), mark: peer, delivered: true, peer: true });
        return;
      }
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
        // The commits this call's git printed, from the UNCLIPPED text — the
        // scope-drift credit's "by its session" (control-tower phase 63, #88).
        // A subagent's count: delegated work is the phase's work.
        const full = resultFullText(item.content);
        const commits = printedCommits(full);
        // A subagent's output is its own; the lane's reading is its own conversation's.
        const suspected = parent ? null : suspectedStepOf(full);
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
          ...(commits.length ? { commits } : {}),
          ...(suspected ? { suspected } : {}),
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
      unechoAt.delete(mark);
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
      // One `result` per turn, and `num_turns` counts the API calls of THAT turn
      // only: across one session it restarts (measured 2 → 1, CLI 2.1.273,
      // autopilot-token-drain §Context) while `total_cost_usd` stays
      // cumulative. Reading "not above the highest count seen" as a duplicate
      // dropped every later turn of a session that turned more than once — the
      // session woken by its own subagent running in the background is exactly that session. A
      // duplicate is a result that repeats the previous one's count with nothing
      // of the conversation between them; every other result is a new turn,
      // and the turns it reports are added.
      const reported = typeof message.num_turns === 'number' ? message.num_turns : null;
      const newTurn = lastResultTurns === undefined || reported !== lastResultTurns || movedSinceResult;
      lastResultTurns = reported;
      movedSinceResult = false;
      turnSinceResult = false;
      if (newTurn && reported !== null) {
        turns += reported;
        reportedTurns = (reportedTurns ?? 0) + reported;
        // …and the sum is not what the cap binds. `--max-turns` is enforced per
        // PROMPT (#62's SIZ-7: 338 turns "over" a 300 cap, finished), so the
        // largest one prompt is kept beside it — `SpawnOutcome.promptTurns`.
        largestPrompt = Math.max(largestPrompt, reported);
      }
      stepsAtResult = turnIds.size + anonymousTurns;
      const text = message.result ?? message.error;
      if (typeof text === 'string') resultText = text;
      // The outcome a `--json-schema` session returned (B4) — the newest wins,
      // as the newest result's words do.
      if (message.structured_output !== undefined && message.structured_output !== null) structuredOutput = message.structured_output;
      // The error subtypes' own `errors` are the CLI's words, not the model's.
      if (Array.isArray(message.errors)) {
        for (const entry of message.errors) if (typeof entry === 'string' && entry) noteApiPart(entry);
      }
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
        ...(typeof message.queued_turn_count === 'number' && Number.isFinite(message.queued_turn_count)
          ? { queuedTurns: Math.max(0, message.queued_turn_count) } : {}),
        ...((): { usage?: CallUsage } => {
          const usage = usageOf(message.usage);
          return usage ? { usage } : {};
        })(),
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
      // A completed turn with nothing queued behind it has READ every message
      // written before it ended (#259): the CLI folded it into the turn without
      // an echo. Left in `unecho`, that tag held stdin open until the idle
      // closer, ten minutes later, on every wrap-up steer the console sends.
      if (message.queued_turn_count === 0 && !terminalReason?.startsWith('aborted') && unecho.size) {
        const before = Date.now() - FOLDED_MARK_GRACE_MS;
        const folded = [...unecho].filter((mark) => (unechoAt.get(mark) ?? 0) <= before);
        for (const mark of folded) { unecho.delete(mark); unechoAt.delete(mark); }
        if (folded.length) log.info('spawn.folded-unechoed', { marks: folded, pid: child.pid });
      }
      if (!newTurn) { armIdle(); return; }
      phaseTurnDone = true;
      const wroteUntagged = sentSinceLastResult;
      sentSinceLastResult = false;
      // A conversation's stdin is the operator's, and only an abort closes it.
      if (request.conversation) return;
      // …and not while the session's own agents or monitors still work: their
      // notification starts its next turn (#170, `holdForBackground`).
      if (!wroteUntagged && !unecho.size && !holdForBackground()) {
        closeStdin(holdExpired && holdingBackground() ? 'background-ceiling' : 'turn-end');
      } else armIdle();
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
    // What it left behind: its group, and its orphaned test runners — unless it
    // parked on a wait, the shape of a job it detached on purpose (#222).
    if (child.pid) {
      const leader = child.pid;
      void sessionReaper.ended(leader, { spare: parkedOutcome(request.env?.PE_OUTCOME_FILE) })
        .catch((error) => log.warn('session.reap-failed', { error: String(error) }));
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    stdoutLines.flush();
    flushPartials();

    // Result text first: it is the CLI's own account of why it stopped. stderr
    // follows because some failures never reach a result message at all.
    const text = [resultText, stderr].filter(Boolean).join('\n');
    // …and the channel the credential classes read (#57): the API-error
    // messages, the result's `errors`, stderr — never the model's prose.
    const apiText = [...apiParts, stderr].filter(Boolean).join('\n');
    // The ledger (SES-1). A session whose turn closed is booked on the CLI's
    // own count; one that ended with a turn still open is booked on whatever
    // is larger — that count, or the assistant turns the stream showed — since
    // the last `result` (if any) does not cover the work after it.
    const steps = turnIds.size + anonymousTurns;
    const midTurn = turnOpen;
    const bookedTurns = midTurn ? Math.max(reportedTurns ?? 0, steps) : (reportedTurns ?? steps);
    const turnsSource: 'result' | 'stream' = reportedTurns !== null && bookedTurns === reportedTurns ? 'result' : 'stream';
    // The largest one prompt (SIZ-7). No result at all: the session was one
    // prompt, and its count is the booked one. A prompt still open at the end
    // is its own: the stream's turns since the last result.
    const promptTurns = reportedTurns === null
      ? bookedTurns
      : Math.min(bookedTurns, Math.max(largestPrompt, midTurn ? steps - stepsAtResult : 0));
    const endedBy: EndedBy = ending?.endedBy ?? 'exit';
    const openTasks = [...backgroundTasks].map(([id, task]) => ({
      id, description: task.description, ...(task.taskType ? { taskType: task.taskType } : {}),
    }));
    // A background task does not outlive its process, whatever the stream last
    // said about it. Announced here so a lane the runner goes on using — a
    // closeout, a resume — never counts a dead session's task as outstanding.
    for (const task of openTasks) emit({ kind: 'background', op: 'ended', taskId: task.id, status: 'process-exited' });
    finish({
      signal: {
        subtype,
        code: code ?? (sig === 'SIGTERM' ? 143 : sig === 'SIGKILL' ? 137 : sig === 'SIGINT' ? 130 : null),
        stopReason,
        text,
        retryCategories,
        ...(apiText ? { apiText } : {}),
        ...(apiErrors.length ? { apiErrors: [...apiErrors] } : {}),
        model: request.model,
        isError,
        permissionDenials,
        endedBy,
        // The CLI's own ledger, handed to the classifier rather than only to
        // the record: it is what separates a session that DID a phase from one
        // that never got past the door, and therefore what stops a completed
        // phase's own write-up of an outage from being read as its confession.
        turns: bookedTurns,
        costUsd,
        ...(ending?.reason ? { endedReason: ending.reason } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        ...(openTasks.length ? { backgroundTasks: openTasks } : {}),
      },
      sessionId,
      ...(resolvedModel ? { resolvedModel } : {}),
      costUsd,
      turns: bookedTurns,
      promptTurns,
      resultText,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(lastText ? { lastText } : {}),
      durationMs: Date.now() - started,
      argv: shown,
      injected,
      endedBy,
      ...(ending?.reason ? { endedReason: ending.reason } : {}),
      midTurn,
      steps,
      turnsSource,
      costSource,
      ...(creditFromUsd === undefined ? {} : { creditFromUsd }),
      caps: resolveCaps(request),
      tokens: { ...usage.counters },
    });
  });
});

/**
 * The ending of a session the spawn door refused before any child existed — nothing spent,
 * nothing run, the reason as its text (one-pool phase 5: a model nothing on the account serves).
 */
export function refusedOutcome(reason: string, caps: SessionCaps): SpawnOutcome {
  return fail(reason, Date.now(), [], caps);
}

function fail(reason: string, started: number, argv: string[], caps: SessionCaps): SpawnOutcome {
  return {
    signal: { subtype: 'error_during_execution', code: null, text: reason, endedBy: 'exit' },
    costUsd: 0,
    turns: 0,
    promptTurns: 0,
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

/** The supervisor chat's own tools, as the CLI names them (`mcp__<server>__<tool>`). */
const CHAT_TOOL_PREFIX = `mcp__${CHAT_TOOL_SERVER}__`;

/**
 * A chat tool call's arguments for its action card: scalars only, eight at
 * most, each string cut to 120 characters. The tools take a slug, a phase and
 * a few words (`shared/supervisor-model.js` `CHAT_TOOLS[].args`); anything
 * else is dropped rather than carried.
 */
export function chatToolArgs(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input).slice(0, 8)) {
    if (typeof value === 'string') out[key] = value.slice(0, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function summarise(input: unknown): string {
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

/** A tool result's whole text, lines intact — what `printedCommits` reads. */
function resultFullText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b as { text?: string })?.text).filter((t) => typeof t === 'string' && t).join('\n');
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
