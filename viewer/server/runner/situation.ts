/**
 * The situation classifier: evidence about ONE phase in, ONE named situation
 * out — pure, deterministic, and the only thing the remediation ladder reads.
 *
 * Two halves, deliberately separate:
 *
 *   - `collectEvidence()` gathers facts that already exist — the board line
 *     (`phase-graph.sh --memory-block`, read by the caller), the handoff's
 *     status and Outstanding text (the store), the run's record and halt, the
 *     lock (`phase-lock.sh status` or the store's parsed file), the working
 *     tree (`git status` / `git log --since`, the same two questions the
 *     runner's `producedWork` asks), the gate, QA, MCP, health, and the
 *     session registry when one exists. It shells only what exists and never
 *     invents a fact it could not read: an unreadable tree is `did: null`,
 *     not `false`.
 *   - `classifySituation()` walks `SITUATIONS` in precedence order and returns
 *     the first whose evidence holds, with the sentences that decided it. No
 *     I/O, no clock, no dependency on the halt site's opinion beyond the halt
 *     kind as one witness among others.
 *
 * Why this exists: the healer used to pick its remedy from the halt kind
 * (`autoRecoveryClass`) — a word about where the runner stopped. The three
 * measured dead ends were all a phase mis-named by that word: a never-started
 * phase read as `interrupted` (settled, parked, "no phase to anchor"), an
 * in-progress handoff read as missing paperwork (two closeout loops), a
 * declared blocker read as "no handoff" (closeouts re-confirming the blocker
 * for $68). `test/situation.test.ts` pins each of those specimens, built from
 * the journal facts, to the situation it really was.
 */

import { execFile } from 'node:child_process';

import {
  SITUATIONS, SITUATION_ACTOR, SITUATION_BLURBS, SITUATION_LABELS, SUB_KINDS,
  actorFor, classifyExitSaid, isSituation, parseSituationKey, refusalCauseOf, situationKey, situationLabel,
} from '../../shared/situation-model.js';
import { subKindOfNeed } from '../../shared/decisions-model.js';
import type { PhaseRecord, RunState } from './state.ts';

export {
  SITUATIONS, SITUATION_ACTOR, SITUATION_BLURBS, SITUATION_LABELS, SUB_KINDS,
  isSituation, parseSituationKey, situationKey, situationLabel,
};

export type SituationId = (typeof SITUATIONS)[number];
export type SituationActor = 'machine' | 'person' | 'wait' | 'none';

export type Situation = {
  id: SituationId;
  sub?: string;
  /** `id:sub` — the key the journal, the rung history and the errand carry. */
  key: string;
  label: string;
  blurb: string;
  actor: SituationActor;
  /** The evidence that decided it, as short sentences in the order it was weighed. */
  why: string[];
  /**
   * The arm read the session's own words — `record.said`, or the cause the
   * runner stamped from them — to decide (phase 10, RCV-7). The errand then
   * quotes `said` verbatim (`errandSaid`); a situation decided from the board,
   * the handoff or a halt kind quotes nothing, because a sign-off that decided
   * nothing is not evidence of anything.
   */
  fromSaid?: boolean;
};

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

export type WorkEvidence = {
  /** True: something landed. False: provably nothing. Null: could not read the tree. */
  did: boolean | null;
  why: string;
  dirty?: number;
  commits?: number;
};

export type LockEvidence = {
  holder: string;
  /** The holder is this console's own run (or this console's recovery owner). */
  ours: boolean;
  expired: boolean;
  leaseUntil?: number;
  scope?: string[];
  /** The holder's session id when the lock carries one (Phase 5 `session=`). */
  session?: string;
  /** The registry's answer about that session, when it has one. */
  live?: boolean;
};

/**
 * Everything the classifier may weigh. Every field is a FACT read from
 * somewhere real; `collectEvidence` names where. Nullable means "not
 * available here", which the classifier treats differently from "no".
 */
export type PhaseEvidence = {
  slug: string;
  phase: number;
  /** The engine's word: done | in-progress | stuck | ready | waiting | unknown. */
  board: string;
  handoff: { exists: boolean; status?: string; outstanding?: string };
  record: {
    status?: string;
    attempts?: number;
    sessionId?: string | null;
    resumable?: boolean;
    startedAt?: string | null;
    endedAt?: string | null;
    verification?: { ok: boolean; failed?: number; ran?: number; skipped?: number } | null;
    closeout?: { at: string; ok: boolean; note?: string } | null;
    note?: string | null;
    said?: string | null;
    gate?: { clear: boolean; kind: string; detail?: string } | null;
    parkedUntil?: string | null;
    parkReason?: string | null;
    watch?: string[];
    waits?: number;
    /** The outcome the session declared, as the record persists it (`PhaseRecord.declared`). */
    declared?: { status: string; reason?: string; watch?: string[]; needs?: string; at?: string } | null;
    costUsd?: number;
    turns?: number;
    /** A lane of THIS console is driving the phase right now. */
    live?: boolean;
    mcpDegraded?: string[];
    /**
     * How this PHASE stopped, when it stopped for a phase-level reason
     * (`PhaseRecord.halt`). Read in preference to the run's halt: since the
     * halt-kind split a verification failure settles the phase and leaves the
     * RUN running, so `state.halt` is empty for exactly the endings the
     * classifier most needs to read.
     */
    halt?: { kind?: string; reason?: string; phase?: number } | null;
    /**
     * The wall the runner's own classifier stamped on the record when it
     * halted (`PhaseRecord.cause`, phase 9) — read BEFORE any prose, and
     * carried across re-boards so the result of a later rung cannot mask it.
     */
    cause?: { kind: string; class?: string; reason?: string; at?: string; account?: string } | null;
    /**
     * The last tool call THIS console refused for the phase
     * (`PhaseRecord.toolDenied`, phase 9): `rule` is the deny-list line, or
     * `in-turn-wait` for the wait guard — which is not a permission block.
     */
    toolDenied?: { tool: string; rule: string; command?: string; matched?: string; at: string } | null;
  } | null;
  run: {
    status?: string;
    halt?: { kind?: string; reason?: string; phase?: number } | null;
    waitUntil?: string | null;
    resolved?: boolean;
    onLimit?: string;
    limits?: { status?: string; utilization?: number; resetsAt?: number } | null;
  } | null;
  lock: LockEvidence | null;
  work: WorkEvidence;
  /**
   * The outcome the session declared (`phase-outcome.sh`), when one is known.
   * `needs` is the decision key a `blocked`/`needs-human` named with
   * `--needs` — read BEFORE the prose by `blockerSubKind`'s caller (ZTD-3).
   */
  declared: { status: string; reason?: string; watch?: string[]; needs?: string; writtenAt?: string } | null;
  /** The gate as the engine answers it (`--gate-status`): kind `clear|manual|ai|blocked|OVERDUE|…`. */
  gate: { clear: boolean; kind: string; detail?: string } | null;
  /**
   * Has the operator delegated human gates on this console
   * (`Prefs.delegateHumanGates`)? A delegated gate is not a person's to clear:
   * the boot prompt briefs the session to verify each condition against evidence
   * it can cite, so the phase is boardable and the ladder owns it.
   *
   * The pref reached the RUNNER (a gated phase boots like an `ai` one) and not
   * the classifier, so a phase already recorded `gated` before delegation was
   * switched on kept classifying `gated-manual` — actor `person`, no rungs, an
   * errand at once. Delegation silently did nothing for exactly the phases that
   * were already stuck, which are the ones it gets turned on for.
   */
  gateDelegated?: boolean;
  mcp: { unreachable: string[]; policy?: string } | null;
  health: Array<{ kind: string; severity: string; phase?: number; detail?: string }>;
  /**
   * A registry hit for this phase: the session the phase's lock names (Phase
   * 5), or — with NO lock at all — a live session in the repository that could
   * be about to work it (`peer: true`, REG-3), so `foreign-live` is reachable
   * from presence alone. Null when the registry knows nothing either way.
   */
  registry: { live: boolean; sessionId?: string; owner?: string; peer?: true; pid?: number; cwd?: string } | null;
  qa: { mode: string; result?: string } | null;
  auth: { signedIn: boolean | null; note?: string } | null;
  /** When the evidence was gathered (ISO). */
  at: string;
};

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

export type EvidenceDeps = {
  root: string;
  /** The store's parsed handoff for the phase, when one exists. */
  handoff?: (slug: string, phase: number) => { status?: string; outstanding?: string } | null | undefined;
  /** The lock, parsed — from the store's lock file or `parseLockStatus(phase-lock.sh status)`. */
  lock?: (slug: string, phase: number) => Promise<LockEvidence | null> | LockEvidence | null;
  qa?: (slug: string, phase: number) => Promise<PhaseEvidence['qa']> | PhaseEvidence['qa'];
  health?: (slug: string) => Promise<PhaseEvidence['health']> | PhaseEvidence['health'];
  /** `Prefs.delegateHumanGates` — see `PhaseEvidence.gateDelegated`. */
  gateDelegated?: () => boolean;
  gate?: (slug: string, phase: number) => Promise<PhaseEvidence['gate']> | PhaseEvidence['gate'];
  /**
   * The phase's resolved MCP policy. Without it `PhaseEvidence.mcp.policy` was
   * never populated by anything, so the `mcp-unavailable` test's `policy ===
   * 'require'` disjunct could not fire and `summariseEvidence`'s `(policy …)`
   * never printed — a field declared, documented and dead.
   */
  mcpPolicy?: (slug: string, phase: number) => string | undefined;
  /** Handed the run too, so the phase's OWN sessions are never read as its peers. */
  registry?: (slug: string, phase: number, run?: RunState | null) => PhaseEvidence['registry'];
  auth?: () => Promise<PhaseEvidence['auth']> | PhaseEvidence['auth'];
  declared?: (slug: string, phase: number) => PhaseEvidence['declared'];
  /**
   * The directories (relative to `root`) the phase's SCOPE names and that exist
   * on disk — where `workEvidence` looks. Absent or empty means the root itself.
   */
  repos?: (slug: string, phase: number) => Promise<string[]> | string[];
  /** `git <args>` in `root`; stdout, or null when git could not answer. Defaults to a real git. */
  git?: (args: string[]) => Promise<string | null>;
  now?: () => Date;
};

export function gitIn(root: string): (args: string[]) => Promise<string | null> {
  return (args) => new Promise((resolve) => {
    execFile('git', args, {
      cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/**
 * The working tree's answer — the runner's `producedWork` questions, asked
 * without a runner: is the tree dirty, did anything commit since the phase
 * started. Asked per directory in the phase's SCOPE (`dirs`, default the
 * root): in a superproject whose run root is a docs hub, the root's own
 * `git status` is permanently dirty with submodule pointers and its log
 * carries every other phase's handoff commits — the measured P12 specimen
 * was read as "uncommitted changes" by exactly that false witness, while the
 * repo the phase actually touched was clean. Submodule pointer changes are
 * ignored for the same reason. `did: null` when git could not answer (not a
 * repository, no git) — "I could not look" is a different fact from
 * "nothing is there", and the classifier treats them differently.
 */
export async function workEvidence(
  git: (args: string[]) => Promise<string | null>,
  startedAt?: string | null,
  dirs: string[] = ['.'],
): Promise<WorkEvidence> {
  const where = dirs.length ? dirs : ['.'];
  let readable = 0;
  let dirty = 0;
  let commits = 0;
  const notes: string[] = [];
  for (const dir of where) {
    const prefix = dir === '.' ? [] : ['-C', dir];
    const status = await git([...prefix, 'status', '--porcelain', '--ignore-submodules=all']);
    if (status === null) { notes.push(`${dir}: unreadable`); continue; }
    readable += 1;
    const d = status.split('\n').filter((line) => line.trim()).length;
    dirty += d;
    let c = 0;
    if (startedAt) {
      const log = await git([...prefix, 'log', '--oneline', `--since=${startedAt}`]);
      c = log === null ? 0 : log.split('\n').filter((line) => line.trim()).length;
      commits += c;
    }
    notes.push(`${dir}: ${d ? `${d} uncommitted path${d === 1 ? '' : 's'}` : 'clean tree'}`
      + (startedAt ? `, ${c} commit${c === 1 ? '' : 's'} since the phase started` : ''));
  }
  if (!readable) return { did: null, why: 'the working tree could not be read' };
  if (dirty || commits) return { did: true, why: notes.join('; '), dirty, commits };
  return { did: false, why: notes.join('; ') + (startedAt ? '' : ' (no start time to count commits from)'), dirty, commits };
}

/**
 * `phase-lock.sh <slug> status N` → evidence. Output shapes (the script's
 * own, never reformatted here):
 *   `phase 3: free`
 *   `phase 3: held by OWNER since DATE, lease until DATE [scope: a, b]`
 *   `phase 3: held by OWNER since DATE, lease until DATE (EXPIRED — free to take over) [scope: a]`
 *
 * ⚠️ NO production caller since P6/D4: the runner used to shell `phase-lock.sh
 * status` per classification, and now takes the lock the console already holds.
 * Kept because the shapes above are a real contract with the script and the
 * parser is the only place they are written down — but a test is its only
 * caller, so P10 should either find it a reader or retire the pair together.
 */
export function parseLockStatus(stdout: string, ownerIsOurs: (owner: string) => boolean = () => false): LockEvidence | null {
  const line = stdout.trim().split('\n')[0] ?? '';
  if (!line || /:\s*free\b/.test(line)) return null;
  const m = /held by (\S+)(?: since [^,]*)?(?:, lease until ([^\[(]*))?/.exec(line);
  if (!m) return null;
  const holder = m[1];
  const expired = /EXPIRED/i.test(line);
  const scope = /\[scope:\s*([^\]]*)\]/.exec(line)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean);
  // `[^\]\s]+`, not `\S+`. The script prints the session as a BRACKETED
  // suffix (`[session: sess-123]`) and `\S+` is greedy over non-whitespace, so
  // it swallowed the closing bracket and answered `sess-123]` — an id that can
  // never match the registry, which is the one thing this field is for. The
  // character class also keeps the `session=<id>` shape a lock FILE line uses,
  // so both spellings read the same.
  const session = /\bsession[=:]\s*([^\]\s]+)/.exec(line)?.[1];
  // Declared on `LockEvidence`, documented, and never assigned until now: the
  // lease is already captured by the `held by` pattern above (group 2), so the
  // field readers were told to expect simply was not there.
  const leaseUntil = m[2] ? Date.parse(m[2].trim()) : NaN;
  return {
    holder, ours: ownerIsOurs(holder), expired,
    ...(Number.isFinite(leaseUntil) ? { leaseUntil } : {}),
    ...(scope?.length ? { scope } : {}),
    ...(session ? { session } : {}),
  };
}

/**
 * What one PASS over several phases shares (RCV-9): the shell-outs whose
 * answer does not depend on the phase. `git status` per scope directory and
 * the plan's health issues are the same question for every candidate; a gate
 * read is per phase but a pass may ask it twice (the candidate walk, then the
 * anchor). Keyed by the exact question, holding the promise so concurrent
 * askers share one answer. A caller that passes none gets the old behaviour —
 * every call shells out for itself.
 */
export type EvidenceCache = {
  git: Map<string, Promise<string | null>>;
  gate: Map<string, Promise<PhaseEvidence['gate']>>;
  health: Map<string, Promise<PhaseEvidence['health']>>;
  /** How many times the cache answered instead of the shell — for the pass's own record. */
  hits: number;
};

export function newEvidenceCache(): EvidenceCache {
  return { git: new Map(), gate: new Map(), health: new Map(), hits: 0 };
}

/**
 * Gather the facts for one phase. Shells and reads only what exists; a
 * dependency that is absent leaves its field null. With `cache`, the
 * phase-independent shell-outs are asked once per pass.
 */
export async function collectEvidence(
  deps: EvidenceDeps,
  slug: string,
  phase: number,
  run: RunState | null,
  board: Record<number, string>,
  cache?: EvidenceCache,
): Promise<PhaseEvidence> {
  const now = deps.now?.() ?? new Date();
  const record = run?.phases[String(phase)] ?? null;
  const handoff = deps.handoff?.(slug, phase) ?? null;
  const rawGit = deps.git ?? gitIn(deps.root);
  const git = cache
    ? (args: string[]): Promise<string | null> => {
      const key = args.join('\u0000');
      const held = cache.git.get(key);
      if (held) { cache.hits += 1; return held; }
      const asked = rawGit(args);
      cache.git.set(key, asked);
      return asked;
    }
    : rawGit;
  const memo = <T>(store: Map<string, Promise<T>> | undefined, key: string, ask: () => Promise<T>): Promise<T> => {
    if (!store) return ask();
    const held = store.get(key);
    if (held) { cache!.hits += 1; return held; }
    const asked = ask();
    store.set(key, asked);
    return asked;
  };
  const dirs = await Promise.resolve(deps.repos?.(slug, phase) ?? []).catch((): string[] => []);
  const [lock, qa, health, gate, auth, work] = await Promise.all([
    Promise.resolve(deps.lock?.(slug, phase) ?? null).catch(() => null),
    Promise.resolve(deps.qa?.(slug, phase) ?? null).catch(() => null),
    memo(cache?.health, slug, () => Promise.resolve(deps.health?.(slug) ?? []).catch(() => [])),
    memo(cache?.gate, `${slug}:${phase}`, () => Promise.resolve(deps.gate?.(slug, phase) ?? null).catch(() => null)),
    Promise.resolve(deps.auth?.() ?? null).catch(() => null),
    workEvidence(git, record?.startedAt ?? null, dirs).catch((): WorkEvidence => ({ did: null, why: 'the working tree could not be read' })),
  ]);
  // Synchronous and cheap on both builders (a plan lookup / a record read), so
  // it does not join the Promise.all above.
  let mcpPolicy: string | undefined;
  try { mcpPolicy = deps.mcpPolicy?.(slug, phase); } catch { mcpPolicy = undefined; }
  return {
    slug,
    phase,
    board: board[phase] ?? 'unknown',
    handoff: handoff
      ? { exists: true, status: handoff.status, ...(handoff.outstanding ? { outstanding: handoff.outstanding } : {}) }
      : { exists: false },
    record: record ? recordEvidence(record) : null,
    run: run ? {
      status: run.status,
      halt: run.halt ? { kind: run.halt.kind, reason: run.halt.reason, phase: run.halt.phase } : null,
      waitUntil: run.waitUntil ?? null,
      resolved: Boolean(run.resolved),
      ...(run.onLimit ? { onLimit: run.onLimit } : {}),
      limits: run.limits ? { status: run.limits.status, utilization: run.limits.utilization, resetsAt: run.limits.resetsAt } : null,
    } : null,
    lock,
    work,
    // The live map first (a session the console did not spawn), then the
    // RECORD's persisted declaration: the map dies with the process, and the
    // one park this exists for — a declared needs-human read hours later by a
    // restarted console — has only the record to speak from.
    declared: deps.declared?.(slug, phase)
      ?? (record?.declared
        ? {
          status: record.declared.status,
          ...(record.declared.reason ? { reason: record.declared.reason } : {}),
          ...(record.declared.watch?.length ? { watch: record.declared.watch } : {}),
          ...(record.declared.needs ? { needs: record.declared.needs } : {}),
          ...(record.declared.at ? { writtenAt: record.declared.at } : {}),
        }
        : null),
    gate: gate ?? (record?.gate ? { clear: record.gate.clear, kind: record.gate.kind, detail: record.gate.detail } : null),
    ...(deps.gateDelegated?.() === true ? { gateDelegated: true } : {}),
    mcp: record?.mcpDegraded?.length
      ? {
        unreachable: record.mcpDegraded.map((d) => d.id),
        ...(mcpPolicy ? { policy: mcpPolicy } : {}),
      }
      : null,
    health,
    registry: deps.registry?.(slug, phase, run) ?? null,
    qa,
    auth,
    at: now.toISOString(),
  };
}

/** The record fields the classifier reads, and nothing it should not. */
export function recordEvidence(record: PhaseRecord): NonNullable<PhaseEvidence['record']> {
  return {
    status: record.status,
    attempts: record.attempts,
    sessionId: record.sessionId ?? record.resumeSessionId ?? null,
    resumable: Boolean(record.sessionId ?? record.resumeSessionId),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    verification: record.verification
      ? {
        ok: record.verification.ok,
        failed: record.verification.ran?.filter((r) => !r.ok).length ?? 0,
        ran: record.verification.ran?.length ?? 0,
        skipped: record.verification.skipped?.length ?? 0,
      }
      : null,
    closeout: record.closeout ? { at: record.closeout.at, ok: record.closeout.ok, note: record.closeout.note } : null,
    note: record.note ?? null,
    said: record.said ?? null,
    gate: record.gate ?? null,
    parkedUntil: record.parkedUntil ?? null,
    parkReason: record.parkReason ?? null,
    ...(record.watch?.length ? { watch: record.watch } : {}),
    ...(record.waits != null ? { waits: record.waits } : {}),
    ...(record.declared ? { declared: record.declared } : {}),
    ...(record.halt ? { halt: record.halt } : {}),
    ...(record.cause ? { cause: record.cause } : {}),
    ...(record.toolDenied ? { toolDenied: record.toolDenied } : {}),
    costUsd: record.costUsd,
    ...(record.turns != null ? { turns: record.turns } : {}),
    ...(record.mcpDegraded?.length ? { mcpDegraded: record.mcpDegraded.map((d) => d.id) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** The runner's own park notes (mirrored from runner.ts; `test/situation.test.ts` pins them equal). */
export const VERIFICATION_PARK_RE = /§Verification|states no verification/;
export const MCP_PARK_RE = /MCP server/;

const AUTH_RE = /auth-expired|signed out|not signed in|sign(ed)? in|log ?in required|authentication|invalid api key|OAuth token|credentials? (expired|missing|refused)/i;
const USAGE_RE = /usage limit|rate limit|too many requests|window (reopens|resets)|limit reached|resets at/i;
// No budget pattern. A spent RUN budget is a halt of kind `budget`, written by
// exactly one site (`haltOnBudget`), and the word is the evidence. The regex
// that used to stand beside it matched the LADDER's own exhaustion sentence
// ("the phase's ladder budget is spent (3 of 3 rungs)") and the wait budget's
// ("the wait budget is spent"), so every `resource-wall:budget` the audit found
// was a different budget re-read as the run's — whose one remedy the console
// refuses (LFC-8).

/*
 * Sub-kind detection reads the BLOCKER STATEMENT — the declared reason, the
 * halt's words, and the first block of the handoff's Outstanding section — and
 * matches "blocked on X" PHRASES, never bare nouns. The measured trap: a
 * blocked handoff whose Outstanding opened "nothing external blocks it" and
 * then listed ledger items mentioning a CI token and "no credential exists
 * today" — noun matching read it as a credential blocker; it was two exit
 * criteria left unbuilt (sub-kind unknown → one unblock session).
 */
const LOCK_RE = /\b(lock(ed)?|claim(ed)?|held|owned) by\b|phase-lock|another session (holds|is in|has claimed|is working)|\block:\S+/i;
/*
 * A tool the run's permission policy refused — the console's own wall, in the
 * words a session uses when it meets it. Measured on two real plans: an
 * unattended session denied Edit/Write under `.claude/**` declared itself
 * blocked with "permission-denied … 'sensitive file' … 'not granted'", read
 * `unknown`, and spent its one unblock session walking into the same wall.
 * Case-sensitive on purpose: the CLI's tool names are capitalised, and the
 * lowercase verb "write" beside "blocked" is ordinary prose. A bare
 * "Permission denied (publickey)" is ssh talking about a key, and stays a
 * credential — the tool vocabulary has to be present.
 */
const PERMISSION_RE = new RegExp([
  String.raw`\b(?:Edit|MultiEdit|Write|Bash|NotebookEdit|WebFetch|WebSearch)\b[^\n]{0,80}?\b(?:[Pp]ermission[- ][Dd]enied|[Dd]enied|[Rr]efused|[Nn]ot (?:granted|permitted))\b`,
  String.raw`\b[Tt]ool calls?\b[^\n]{0,60}?\b(?:[Dd]enied|[Rr]efused|[Nn]ot (?:granted|permitted))\b`,
  String.raw`\b(?:[Dd]enied|[Rr]efused|[Bb]locked) by (?:the )?(?:[Dd]eny[- ]?(?:wall|list|rule)|[Pp]ermission (?:policy|profile|hook)|PreToolUse hook)\b`,
  String.raw`\b[Dd]eny[- ](?:wall|list|rule)\b`,
  String.raw`\b[Ss]ensitive file\b`,
  String.raw`\b[Tt]ool[- ]denied\b`,
  String.raw`\b[Pp]ermission[- ]denied in this (?:unattended |supervised )?session\b`,
].join('|'));
const CREDENTIAL_RE = /\b(need|needs|needed|missing|lack|lacks|lacking|require|requires|required|without|no|waiting (on|for)|blocked (on|by))\s+(a |an |the |my |its |valid |new )?(credentials?|tokens?|api[- ]?keys?|ssh[- ]?keys?|sign[- ]?in|login|password|secret|2fa|mfa|access to)\b|permission denied|not signed in|signed out|sign(ed)? ?in (is )?(required|needed|first)|authenticat(e|ion) (failed|required|needed)|credentials? (is|are) (missing|expired|invalid|required|needed)/i;
const GATE_RE = /\b(need|needs|needed|await|awaits|awaiting|pending|require|requires|required|waiting (on|for)|blocked (on|by))\s+(a |an |the )?(manual |human |operator |your )?(gate|approval|sign[- ]?off|go[- ]ahead|confirmation)\b|gate (is )?(not )?(approved|cleared|open)|operator must approve|\b(must|needs? to|has to|should) be (confirmed|approved|authori[sz]ed|signed[- ]off|cleared)\b|\bconfirm(ed|ation)? (by|from|with) (a |the )?(person|operator|human|someone)\b/i;
const EXTERNAL_RE = /\b(wait(s|ing)? (on|for)|blocked (on|by)|pending|until|after)\s+(a |an |the |its |our )?(CI|pipeline|build|deploy(ment)?|release|PR|pull request|merge|auto-?merge|window|third[- ]party|upstream|vendor|maintainer|image|run|job)\b|auto-?merge|\bci (is )?(running|pending|red|down|queued)|(build|deploy|pipeline) (is )?(running|in progress|pending|queued)/i;

/**
 * The first block of an Outstanding section — up to the next heading, capped
 * — which is where a handoff states its blocker. The rest of the section is
 * ledger: errands, follow-ups, servers that were missing. Reading all of it
 * for a sub-kind is how incidental nouns became the diagnosis.
 */
export function blockerStatement(outstanding: string | undefined | null, cap = 1_500): string {
  if (!outstanding) return '';
  const lines = outstanding.split('\n');
  const out: string[] = [];
  let seenText = false;
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s/.test(line);
    // A heading before any body text titles the block; one after it starts the next.
    if (heading && seenText) break;
    if (!heading && line.trim()) seenText = true;
    out.push(line);
    if (out.join('\n').length >= cap) break;
  }
  return out.join('\n').slice(0, cap);
}

/** Build a `Situation` from an id + sub + why — the one place the words are looked up. */
export function situation(id: SituationId, why: string[], sub?: string): Situation {
  return {
    id,
    ...(sub ? { sub } : {}),
    key: situationKey(id, sub),
    label: situationLabel(id, sub),
    blurb: SITUATION_BLURBS[id],
    // Sub-kind applied: the four empty sub-tables are a person's (LFC-3).
    actor: actorFor(id, sub),
    why,
  };
}

/** The sub-kind of a declared blocker, from what the session wrote and what it watches. */
export type BlockerSubKind = (typeof SUB_KINDS)['blocked-declared'][number];

export function blockerSubKind(text: string, refs: string[] = []): BlockerSubKind {
  const lower = text ?? '';
  if (refs.some((r) => r.startsWith('lock:')) || LOCK_RE.test(lower)) return 'lock';
  // Before the credential phrases: "permission denied" is also what ssh says
  // about a key, and only the tool vocabulary tells the two walls apart.
  if (PERMISSION_RE.test(lower)) return 'permission';
  if (CREDENTIAL_RE.test(lower)) return 'credential';
  if (GATE_RE.test(lower)) return 'gate';
  // Every scheme the watch clock polls, not only the GitHub ones: a session
  // that handed the console a `date:`, `until:` or `cmd:` ref is waiting on a
  // clock by construction, whatever its prose says about it.
  if (refs.some((r) => /^(gh|pr|ci|deploy|run|url|https?|date|until|cmd):/i.test(r)) || EXTERNAL_RE.test(lower)) return 'external';
  return 'unknown';
}

/**
 * The classifier. Pure. Walks `SITUATIONS` in order; the first situation whose
 * evidence holds wins. See the module comment for why the order is what it is.
 */
export function classifySituation(e: PhaseEvidence): Situation {
  const rec = e.record;
  const hstatus = e.handoff.exists ? (e.handoff.status ?? 'unknown') : undefined;
  // The PHASE's own halt first, then the run's — and the run's speaks for this
  // phase only when anchored to it (or to no phase at all). The record's is
  // always about this phase by construction: `settlePhase` writes it, and since
  // the halt-kind split (`PHASE_HALT_KINDS`) that is where every phase-level
  // ending lives, `state.halt` being reserved for what stopped the whole run.
  const halt = rec?.halt
    ?? (e.run?.halt && (e.run.halt.phase == null || e.run.halt.phase === e.phase) ? e.run.halt : null);
  const haltKind = halt?.kind ?? '';
  const haltReason = halt?.reason ?? '';
  const note = rec?.note ?? '';
  // What the session declared, wherever it survives: the live map first
  // (`e.declared`, a session the console did not spawn), then the RECORD's
  // persisted copy — the only witness after a restart. Park-shaped statuses
  // only; a stale `complete`/`partial` in the map says nothing about a park.
  const parkShaped = (d: { status: string; reason?: string; watch?: string[]; needs?: string } | null | undefined) =>
    (d && ['waiting-external', 'blocked', 'needs-human'].includes(d.status) ? d : null);
  const declaredNow = parkShaped(e.declared) ?? parkShaped(rec?.declared);

  /* A lane of this console is in it right now: the drive loop owns it. */
  if (rec?.live) {
    return situation('work-in-progress', ['a session of this console is running the phase right now']);
  }

  /* 1–2. QA verdicts on a phase the board reads done, then superseded. */
  if (e.board === 'done') {
    // `on`, not "anything but off". `waived` is a gate the operator RELEASED —
    // the verdicts stay recorded and reported, they simply stop holding
    // dependents — so a done phase under a waiver is settled work like any
    // other. Admitting it here made the healer write a QA errand for a plan
    // whose gate had been explicitly turned off. Same predicate as
    // `Service.qaHolds`, because there is one question here, not two.
    if (e.qa && e.qa.mode === 'on') {
      if (e.qa.result === 'fail') {
        return situation('qa-failed', ['the board reads done', `QA is ${e.qa.mode} and the recorded verdict is fail`]);
      }
      if (!e.qa.result || e.qa.result === 'pending' || e.qa.result === 'unknown') {
        return situation('qa-pending', ['the board reads done', `QA is ${e.qa.mode} and no verdict is recorded`]);
      }
    }
    return situation('superseded', ['the board reads done — whatever the record says, the work is recorded']);
  }

  /* 3–4. Somebody else's claim. */
  if (e.lock && !e.lock.ours) {
    const liveByRegistry = e.lock.live ?? e.registry?.live;
    if (!e.lock.expired && liveByRegistry !== false) {
      return situation('foreign-live', [
        `the phase lock is held by ${e.lock.holder}${e.lock.expired ? '' : ' and the lease has not expired'}`,
        ...(liveByRegistry === true ? ['the session registry says that session is live'] : []),
      ]);
    }
    const unfinished = hstatus === 'in-progress' || hstatus === 'blocked' || e.work.did === true;
    if (unfinished) {
      return situation('foreign-stale', [
        `the phase lock is held by ${e.lock.holder} but ${e.lock.expired ? 'its lease has expired' : 'its session has ended'}`,
        hstatus === 'in-progress' || hstatus === 'blocked'
          ? `a handoff exists and reads ${hstatus}`
          : e.work.why,
      ]);
    }
    // Debris over nothing: the lock is not the story; fall through.
  }

  /* 4b. Nobody has claimed it, and somebody is in the repository (REG-3): a live
   * session the registry shows here, holding no lock, uncorrelated or working
   * this very phase. The first minute of every hand session looks exactly like
   * this, and the ladder must not climb into a tree a person is standing in —
   * `foreign-live` has no rung, which is the point: wait, never fight. */
  if (!e.lock && e.registry?.peer && e.registry.live) {
    return situation('foreign-live', [
      `no lock is held, but the session registry shows a live Claude session in this repository`
        + ` (${e.registry.sessionId?.slice(0, 8) ?? 'unnamed'}${e.registry.pid ? `, pid ${e.registry.pid}` : ''}${e.registry.cwd ? `, in ${e.registry.cwd}` : ''})`,
      'it may be about to claim this phase — a lane boarded beside it would share its working tree',
    ]);
  }

  /* 5. A DECLARED external wait — the park machinery owns it. A wait whose
   * BUDGET already ran out is not one: `waiting-external-timeout` supersedes
   * the declaration (the park path also deletes it; this guard covers the
   * in-memory map, which nothing deletes), and the declared-blocked arm below
   * writes the errand for it.
   *
   * The word "declared" is load-bearing and used to be missing. This arm read
   * `rec.status === 'waiting'` ALONE and then stated, as fact, "the session
   * declared it is waiting on external work" — so any park the CONSOLE made
   * with that status was attributed to a session that had said nothing, and
   * pre-empted the arms that would have read it correctly. Arm 9 never saw a
   * `waiting` park at all, because this one always got there first (QA round 2,
   * G3: the retry-storm park measured as `waiting-external`).
   *
   * The test is `declared` OR `watch`, not `declared` alone, and the second half
   * is for RECORDS OLDER THAN `declared` — a checkpoint written before that
   * field existed carries the session's refs and its `parkReason` and nothing
   * else, and it is a genuine declared wait. That sentence is true ONLY
   * because `consumeDeclaration` deletes `record.watch` with the declaration
   * it shadows: every live writer copies the field from `declared` in the same
   * breath, so before that delete existed, any phase that had EVER declared a
   * `--watch` ref carried it for the life of the run — and a retry-storm park
   * the console later made on such a phase satisfied this disjunct and was
   * narrated as the session's testimony all over again (QA round 3, M1: G3
   * fixed for the record it was tested on, defeated by a reachable neighbour).
   * Both live writers of `waiting` (`parkWaiting`, and `service-runs`'
   * unsupervised arm) set `declared`, so the guard costs them nothing.
   *
   * ⚠️ The one shape it does not cover is a PRE-`declared` record whose session
   * declared a wait with no `--watch` refs at all. That falls through to the
   * arms that read its `parkReason` — classification from the session's own
   * prose instead of from its status, which is what the classifier does for
   * everything else and is the safe direction: a weaker claim, not a wrong one. */
  if ((declaredNow?.status === 'waiting-external'
      || (rec?.status === 'waiting' && (rec.declared || rec.watch?.length)))
    && haltKind !== 'waiting-external-timeout') {
    const reason = declaredNow?.reason ?? rec?.parkReason ?? null;
    const refs = declaredNow?.watch ?? rec?.watch ?? [];
    const elapsed = rec?.parkedUntil ? Date.parse(rec.parkedUntil) <= Date.parse(e.at) : false;
    return situation('waiting-external', [
      `the session declared it is waiting on external work${reason ? `: ${reason}` : ''}`,
      ...(refs.length ? [`watching ${refs.join(', ')}`] : []),
      ...(elapsed ? ['the declared wait has elapsed'] : []),
    ]);
  }
  /* An automatic gate that is simply not met yet (another phase, a date, a command) is a wait too. */
  if (e.gate && !e.gate.clear && (e.gate.kind === 'blocked')) {
    return situation('waiting-external', [`the gate is not met yet: ${e.gate.detail ?? e.gate.kind}`]);
  }

  /* 6. A gate only a person clears.
   *
   * `--gate-status` refuses to RUN a `cmd` gate unless PHASE_EXEC_GATES=1. The
   * read this classifier uses is the page-safe one, so every unapproved command
   * gate came back `manual` — actor `person`, no rungs, an errand written at
   * once — and the console asked somebody to clear a gate that is a COMMAND,
   * and one that would clear itself the moment the runner boarded the phase
   * (boarding does pass the flag). "I could not check" and "a person must
   * decide" are different facts; the MCP probe already draws exactly this line.
   * Falling through is safe because nothing is boarded on this verdict — the
   * runner re-reads the gate for real before it spawns anything.
   *
   * The engine now says which of the two it means, in the KIND: `unevaluated:`
   * rather than `manual:` (console-speed-and-sync P9). The detail sniff stays
   * beside it because a run RECORD persisted before that change still carries
   * the old `manual: cmd gate not executed (…)` shape on disk, and a classifier
   * that only understood the new word would re-introduce the same misrouting
   * for every one of them. */
  const gateUnevaluated = (g?: { kind?: string; detail?: string } | null): boolean =>
    g?.kind === 'unevaluated' || /\bnot executed\b/i.test(g?.detail ?? '');
  const gateIsAPersons = !e.gateDelegated;
  if (gateIsAPersons && e.gate && !e.gate.clear && !gateUnevaluated(e.gate) && /^(manual|human|OVERDUE)$/i.test(e.gate.kind)) {
    return situation('gated-manual', [`the gate is ${e.gate.kind}: ${e.gate.detail ?? ''}`.trim()]);
  }
  // The record's snapshot may only speak when the LIVE read could not run, or
  // when it agrees. It used to re-ask the same question one line after the live
  // check with no reference to it, so a gate the operator had just approved —
  // the engine answering `clear`, the board reading `ready` — still classified
  // `gated-manual`, for ever. That is the exact invariant CLAUDE.md pins ("the
  // engine is the authority on gate state, including for the healer"); the
  // fallback had quietly grown back around it.
  if (gateIsAPersons && !e.gate?.clear && !gateUnevaluated(e.gate)
    && rec?.status === 'gated' && rec.gate && !rec.gate.clear
    && !gateUnevaluated(rec.gate)
    && /^(manual|human|OVERDUE)$/i.test(rec.gate.kind)) {
    return situation('gated-manual', [`the record is gated (${rec.gate.kind}): ${rec.gate.detail ?? ''}`.trim()]);
  }

  /* Computed HERE, above the plan-health arms, because it guards them.
   *
   * A session that declared a blocker, or wrote a `blocked` handoff, is giving
   * TESTIMONY about the phase. `plan-broken` is the console's own claim about
   * the paperwork — and its commonest instance, `stale-handoff`, is raised BY
   * that very handoff. For 92 runs the console answered "the box is
   * unreachable" with "your plan is broken, run validate.sh", for plans whose
   * validate.sh was green. The arm that returns `blocked-declared` still sits
   * below the walls (an MCP outage and a usage limit are about the machine, not
   * about what the session was told); what moved is the guard. */
  const declaredBlocked = hstatus === 'blocked' || e.board === 'stuck'
    || haltKind === 'phase-blocked' || haltKind === 'needs-human' || haltKind === 'waiting-external-timeout'
    || declaredNow?.status === 'blocked' || declaredNow?.status === 'needs-human'
    || (rec?.status === 'parked' && /needs a person|asked for a person/i.test(note));
  const nothingDeclared = !declaredNow && !declaredBlocked;

  /* 7. The plan itself is broken — cheaper to repair than anything below. */
  if (nothingDeclared
    && (haltKind === 'plan-lint' || haltKind === 'plan-unreadable' || haltKind === 'verification-preflight')) {
    const sub = haltKind === 'plan-lint' ? 'lint' : haltKind === 'plan-unreadable' ? 'unreadable' : 'verification';
    return situation('plan-broken', [`the run halted with kind ${haltKind}: ${haltReason.slice(0, 160)}`.trim()], sub);
  }
  // Only when nothing DECLARED the park: the runner's own §Verification parks
  // carry no declaration (and now carry the `verification-preflight` halt
  // kind, handled above), while a session's needs-human reason is free prose —
  // the measured incident's note said "then run the 4 §Verification cmds",
  // which is a to-do list, not a broken plan, and this arm read it as one:
  // three rungs burned, then the honest errand overwritten with a plan-repair
  // prescription nobody could act on.
  if (rec?.status === 'parked' && VERIFICATION_PARK_RE.test(note) && nothingDeclared) {
    return situation('plan-broken', [`the phase is parked on its §Verification: ${note.slice(0, 160)}`], 'verification');
  }
  // …and not over testimony either: a parked phase whose session DECLARED the
  // park (needs-human for an outage, an external wait) is classified from that
  // declaration, even when the plan also carries a health error — a handoff
  // reading blocked mid-outage IS the declared state, not a second defect.
  // Measured live: the errand healed to the outage text while the phase chip
  // still read "Plan needs repair · stale-handoff" off this arm.
  const planIssue = e.health.find((i) => i.severity === 'error' && (i.phase == null || i.phase === e.phase));
  if (planIssue && nothingDeclared) {
    return situation('plan-broken', [`the plan has a ${planIssue.severity} health issue (${planIssue.kind})${planIssue.detail ? `: ${planIssue.detail.slice(0, 120)}` : ''}`], planIssue.kind || 'issue');
  }

  /* 8. MCP servers the phase needs cannot connect. */
  if (haltKind === 'mcp-preflight' || (rec?.status === 'parked' && MCP_PARK_RE.test(note))
    || (e.mcp && e.mcp.unreachable.length && e.mcp.policy === 'require')) {
    const names = e.mcp?.unreachable.length ? e.mcp.unreachable.join(', ') : undefined;
    return situation('mcp-unavailable', [
      names ? `MCP server(s) unreachable: ${names}` : (haltKind === 'mcp-preflight' ? haltReason.slice(0, 160) : note.slice(0, 160)),
    ]);
  }

  /* 9. Resource walls: money, windows, sign-in, models. */
  if (haltKind === 'budget') {
    return situation('resource-wall', [`the run stopped on its budget: ${haltReason.slice(0, 160)}`], 'budget');
  }
  if (haltKind === 'models-exhausted') {
    return situation('resource-wall', [`every model fell back: ${haltReason.slice(0, 160)}`], 'model');
  }
  // The console's OWN word first (RCV-2, SES-3): the runner's classifier read
  // the API's refusal, retired the account and halted the run on
  // `credential-refused`, and it stamped the cause on the record so that a
  // later rung's result — a `no-handoff`, a reset record — cannot re-open the
  // question. No prose is consulted for it: `AUTH_RE` never matched the
  // runner's own "organization policy blocks this credential", which is how
  // one wall came to be answered with five paid remedies.
  const wall = rec?.cause?.kind === 'credential-refused'
    ? rec.cause
    : haltKind === 'credential-refused' ? { class: undefined, reason: haltReason } : null;
  if (wall) {
    return {
      ...situation('resource-wall', [
        `the API refused the run's credential${wall.class ? ` (${wall.class})` : ''}: ${(wall.reason ?? haltReason).slice(0, 160)}`,
        rec?.cause ? 'stamped on the record by the runner when it halted' : 'the run halted with kind credential-refused',
      ], 'auth'),
      // The cause was classified from the session's sign-off, and that
      // sign-off is what a person reads to know which organisation said no.
      fromSaid: true,
    };
  }
  if (e.auth?.signedIn === false || (haltKind === 'run-preflight' && AUTH_RE.test(haltReason))
    || AUTH_RE.test(note) || (haltKind === 'needs-human' && AUTH_RE.test(haltReason))) {
    return situation('resource-wall', [
      e.auth?.signedIn === false ? 'the CLI is signed out' : `a sign-in is needed: ${(AUTH_RE.test(note) ? note : haltReason).slice(0, 160)}`,
    ], 'auth');
  }
  // `rejected` is the CLI's own word for a window that refuses requests — one
  // of the three `rate_limit_event` statuses it documents (`allowed`,
  // `allowed_warning`, `rejected`; chapter 09 row 34). This arm used to test
  // `limited`, which the CLI never sends and nothing here writes (SES-9).
  const rejected = e.run?.limits?.status === 'rejected';
  if ((e.run?.status === 'waiting' && e.run.waitUntil) || USAGE_RE.test(haltReason) || USAGE_RE.test(note) || rejected) {
    return situation('resource-wall', [
      e.run?.waitUntil
        ? `the run is waiting on the usage window until ${e.run.waitUntil}`
        : USAGE_RE.test(note) || USAGE_RE.test(haltReason)
          ? `a usage limit: ${(USAGE_RE.test(note) ? note : haltReason).slice(0, 160)}`
          : `the CLI reported the usage window rejected${typeof e.run?.limits?.utilization === 'number' ? ` at ${Math.round(e.run.limits.utilization * 100)} %` : ''}`,
    ], 'usage');
  }

  /* 10. The session itself said it is blocked (handoff, outcome or halt).
   * `declaredBlocked` is computed above, where it guards the plan-health arms. */
  if (declaredBlocked) {
    const text = [declaredNow?.reason ?? '', haltReason, note, blockerStatement(e.handoff.outstanding)].filter(Boolean).join('\n');
    const refs = [...(declaredNow?.watch ?? []), ...(rec?.watch ?? [])];
    // The session's own word first (`--needs <key>`, chapter 10 ZTD-3): a
    // declaration that names its decision key classifies by it whatever the
    // prose says. The regex cascade is what remains for a declaration that
    // named none — a 4.1.0 session's, or a key no blocker class points at.
    // …then the console's OWN denial (LFC-3): a `phase.tool-denied` the hook
    // wrote for this phase — a deny-list rule, never the wait guard — is the
    // permission wall itself, read above the prose that used to decide it
    // (`:unknown` 267 times, each an unblock session into the same wall).
    const denied = rec?.toolDenied && rec.toolDenied.rule !== 'in-turn-wait' ? rec.toolDenied : null;
    const sub = haltKind === 'waiting-external-timeout' ? 'external'
      : (subKindOfNeed(declaredNow?.needs) ?? (denied ? 'permission' : blockerSubKind(text, refs)));
    const why = [
      hstatus === 'blocked' ? 'the handoff reads blocked'
        : e.board === 'stuck' ? 'the board reads stuck (a handoff that is not complete)'
          : haltKind === 'phase-blocked' ? 'the session declared itself blocked'
            : haltKind === 'waiting-external-timeout' ? 'the external wait budget is spent'
              : haltKind === 'needs-human' || declaredNow?.status === 'needs-human' ? 'the session asked for a person'
                : 'the session declared itself blocked',
      ...(e.handoff.outstanding ? [`Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 160)}`] : []),
      ...(declaredNow?.reason ? [`reason: ${declaredNow.reason.slice(0, 160)}`] : []),
      ...(refs.length ? [`watching ${refs.join(', ')}`] : []),
      ...(denied && sub === 'permission'
        ? [`the console refused ${denied.tool}${denied.command ? ` \`${denied.command.slice(0, 120)}\`` : ''} under rule ${denied.rule}`]
        : []),
      `sub-kind ${sub}`,
    ];
    return situation('blocked-declared', why, sub);
  }

  /* 11. Red verification. */
  if ((rec?.verification && rec.verification.ok === false) || haltKind === 'verify-failed') {
    return situation('verify-red', [
      rec?.verification && rec.verification.ok === false
        ? `${rec.verification.failed ?? '?'} of ${rec.verification.ran ?? '?'} verification command(s) failed`
        : `the run halted with kind verify-failed: ${haltReason.slice(0, 160)}`,
    ]);
  }

  /* 12. The work is done; the paperwork is not. */
  const endedOnItsOwn = rec?.status !== 'interrupted' && rec?.status !== 'running' && rec?.status !== 'verifying';
  if (endedOnItsOwn && hstatus !== 'in-progress' && e.work.did !== false
    && (haltKind === 'no-handoff' || rec?.verification?.ok === true)) {
    return situation('done-unrecorded', [
      haltKind === 'no-handoff' ? 'the session ended cleanly and the board still reads not done' : 'verification is green',
      e.work.did === true ? e.work.why : 'the working tree could not be read, so the session is trusted to know what it did',
      hstatus ? `a handoff exists but reads ${hstatus}` : 'no handoff exists',
    ]);
  }

  /* 13. Unfinished work is on disk. */
  if (hstatus === 'in-progress' || e.board === 'in-progress' || e.work.did === true
    || rec?.status === 'running' || rec?.status === 'verifying') {
    return situation('work-in-progress', [
      ...(hstatus === 'in-progress' || e.board === 'in-progress' ? ['a handoff exists and reads in-progress'] : []),
      ...(e.work.did === true ? [e.work.why] : []),
      ...(rec?.status === 'running' || rec?.status === 'verifying' ? [`the record reads ${rec.status}`] : []),
      ...(e.handoff.outstanding ? [`Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 160)}`] : []),
    ]);
  }

  /* 14. Nothing ever happened — and, when the exit said why, WHICH nothing.
   *
   * 40 of 226 sessions exited `turns: 0, costUsd: 0`, and the exit text named
   * three different causes: a laptop that slept, a content-policy refusal, and
   * a skill that would not load. All three landed here, whose single rung is
   * `reboard-fresh`, so the ladder answered a lid, a filter and a broken
   * install identically — three consecutive refusals on one phase were
   * re-boarded three times. The sub-kind is read from the session's own words
   * and nothing else; an exit that names none of the three keeps the bare
   * situation and today's path exactly. */
  if (!e.handoff.exists && (e.work.did === false || !rec || rec.status === 'pending' || rec.status === 'queued')) {
    const exit = classifyExitSaid(rec?.said);
    const refusal = exit === 'refusal' ? refusalCauseOf(rec?.said) : undefined;
    const said = rec?.said ? rec.said.replace(/\s+/g, ' ').slice(0, 160) : null;
    return {
      ...situation('never-started', [
        'no handoff exists',
        e.work.did === false ? e.work.why : `the record reads ${rec?.status ?? 'absent'} and nothing shows work`,
        ...(rec?.status === 'interrupted' ? [`the session was interrupted${note ? ` (${note.slice(0, 100)})` : ''}`] : []),
        ...(rec?.closeout?.note ? [`closeout: ${rec.closeout.note.slice(0, 120)}`] : []),
        ...(exit && said ? [`the session exited without a turn and said: "${said}"`, `sub-kind ${exit}`] : []),
        // Which refusal (RCV-2): a policy, an organisation's subscription, an
        // organisation's policy, a certificate — the errand's `said` quotes the
        // words, this names the class a person acts on.
        ...(refusal ? [`refusal cause ${refusal}`] : []),
      ], exit),
      // A sub-kind is read from the exit's own words and nothing else: the
      // errand quotes them (RCV-7). A bare `never-started` read them and found
      // nothing, so it carries nothing.
      ...(exit ? { fromSaid: true } : {}),
    };
  }
  /* An interrupted session over a tree we could not read: resume it rather than guess. */
  if (rec?.status === 'interrupted' && e.work.did === null) {
    return situation('work-in-progress', [
      'the session was interrupted and the working tree could not be read — its own session is the witness',
    ]);
  }

  return situation('unknown', [
    `board ${e.board}`, `handoff ${hstatus ?? 'absent'}`, `record ${rec?.status ?? 'absent'}`,
    ...(haltKind ? [`halt ${haltKind}`] : []), e.work.why,
  ]);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

/** The evidence as short lines for a panel or a journal — every field that is known, nothing invented. */
export function summariseEvidence(e: PhaseEvidence): string[] {
  const out: string[] = [`board: ${e.board}`];
  out.push(e.handoff.exists
    ? `handoff: ${e.handoff.status ?? 'unknown'}${e.handoff.outstanding ? ` — Outstanding: ${e.handoff.outstanding.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`
    : 'handoff: none');
  if (e.record) {
    const r = e.record;
    out.push(`record: ${r.status ?? 'unknown'}${r.attempts != null ? ` · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}` : ''}`
      + `${r.resumable ? ' · session resumable' : ' · no session to resume'}`
      + `${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}${r.turns != null ? ` · ${r.turns} turns` : ''}`);
    if (r.verification) out.push(`verification: ${r.verification.ok ? 'green' : 'red'} (${(r.verification.ran ?? 0) - (r.verification.failed ?? 0)}/${r.verification.ran ?? 0} ok${r.verification.skipped ? `, ${r.verification.skipped} skipped` : ''})`);
    if (r.closeout) out.push(`closeout: ${r.closeout.ok ? 'ran' : 'did not complete'}${r.closeout.note ? ` (${r.closeout.note})` : ''}`);
    if (r.note) out.push(`note: ${r.note.slice(0, 160)}`);
    if (r.parkedUntil) out.push(`parked until ${r.parkedUntil}${r.parkReason ? ` — ${r.parkReason}` : ''}`);
    if (r.gate && !r.gate.clear) out.push(`gate: ${r.gate.kind} — ${r.gate.detail ?? ''}`.trim());
  } else {
    out.push('record: none in this run');
  }
  if (e.run?.halt) out.push(`halt: ${e.run.halt.kind ?? 'unkinded'}${e.run.halt.phase != null ? ` on phase ${e.run.halt.phase}` : ''} — ${(e.run.halt.reason ?? '').slice(0, 160)}`);
  out.push(e.lock
    ? `lock: held by ${e.lock.holder}${e.lock.ours ? ' (ours)' : ''}${e.lock.expired ? ' — expired' : ''}${e.lock.live === false ? ' — session ended' : ''}`
    : 'lock: free');
  out.push(`work: ${e.work.why}`);
  if (e.declared) out.push(`declared: ${e.declared.status}${e.declared.reason ? ` — ${e.declared.reason.slice(0, 140)}` : ''}${e.declared.watch?.length ? ` (watching ${e.declared.watch.join(', ')})` : ''}`);
  if (e.gate && !e.gate.clear) out.push(`gate: ${e.gate.kind}${e.gate.detail ? ` — ${e.gate.detail}` : ''}`);
  if (e.mcp?.unreachable.length) out.push(`mcp: unreachable ${e.mcp.unreachable.join(', ')}${e.mcp.policy ? ` (policy ${e.mcp.policy})` : ''}`);
  if (e.health.length) out.push(`health: ${e.health.map((i) => `${i.severity} ${i.kind}`).join(', ')}`);
  if (e.registry) {
    out.push(`registry: ${e.registry.live ? 'a live session' : 'no live session'}${e.registry.peer ? ' in the repository, holding no lock' : ''}${e.registry.owner ? ` (${e.registry.owner})` : ''}`);
  }
  if (e.qa && e.qa.mode !== 'off') out.push(`qa: ${e.qa.mode}${e.qa.result ? ` — ${e.qa.result}` : ' — no verdict'}`);
  if (e.auth && e.auth.signedIn === false) out.push(`auth: signed out${e.auth.note ? ` (${e.auth.note})` : ''}`);
  return out;
}
