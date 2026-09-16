/**
 * The unified inbox — the one list of everything that needs a person, decided
 * by a pure function from facts somebody else gathered.
 *
 * Before this file the console had eight separate answers to "is anything
 * waiting on me?": the dashboard's `demands()`, the push catalogue's
 * `needs-you` category, the ladder's errands, the approval cards, the accounts
 * page's signed-out banner, the MCP status chips, the per-plan health issues
 * and the lock table. Each was right about its own corner and none of them
 * could be counted, because nothing could say whether a halted-run card, the
 * errand under it and the push that announced it were three asks or one. A
 * badge cannot be built out of eight opinions, and an ask nobody can name is an
 * ask nobody can dismiss.
 *
 * So: one builder, one identity, one order.
 *
 * ------------------------------------------------------------------
 * Why this file is pure, and what that buys
 * ------------------------------------------------------------------
 *
 * `buildInbox(facts, now)` touches no filesystem, spawns no subprocess, reads
 * no clock of its own and imports no `Service`. Every fact it needs arrives in
 * the argument, already fetched. Three reasons, each a real cost avoided:
 *
 *   - **the engine may not be reached from here.** `gateStatus` and `qaMode`
 *     shell out to `scripts/phase-graph.sh`; layer 1 is authoritative and JS
 *     never recomputes it (CLAUDE.md). A builder that could reach the engine
 *     would put a `spawn` on the SSE path — one per gated phase, per poll;
 *   - **the whole inbox is testable with a hand-built object.** The pure/
 *     performer split is exactly `views/dashboard/now.tsx`: `demands()` decides
 *     WHICH remedies exist and why one is unavailable, `actions.tsx` performs
 *     them. That is what lets "a halted run offers Recover & continue and
 *     Dismiss, and Recover is flagged without --allow-run" be a fact a test
 *     asserts with no server, no fetch mock and no click;
 *   - **a snapshot stays a snapshot.** `lockPresence` arrives as a resolved map
 *     rather than a callback for the same reason `SchedulerDeps.locks` is
 *     synchronous: an answer that could change between two questions inside one
 *     build produces a list that contradicts itself.
 *
 * The acks half below is the one thing here that does touch disk, and it is
 * kept in this file rather than in `store.ts` because an acknowledgement is
 * meaningless without the identity that keys it.
 *
 * ------------------------------------------------------------------
 * The four rules this file is built around
 * ------------------------------------------------------------------
 *
 * **1. Identity comes from `shared/attention-model.js` and is never
 * re-derived.** `inboxItemId` and `sortInbox` are imported by identity, not
 * copied. An id minted a second way is an ack key that drifts, and a drifting
 * ack key asks the operator the same question again after a restart — the
 * failure the shared module's header sets out at length.
 *
 * **2. An ack older than the item's own `since` is not an ack.** The thing came
 * back. A wall that was signed in and fell over again, a QA row that went
 * pending → fail, a lock released and retaken: all of them keep their id (they
 * are the same ask, about the same thing) and move their clock, and the clock
 * is what says "this is new". Where a fact carries no stable start clock at all
 * (an account is signed out; a server needs auth; neither records WHEN) the
 * item's `since` is empty and the ack stands — un-acking those is `pruneAcks`'
 * job, called by the route with the ids the build produced, so an item that
 * goes away and comes back loses its ack by having been absent.
 *
 * **3. A capability flag never hides an item — it only disables the action, and
 * names the flag.** A console started without `--allow-run` still has to be
 * told its run is parked on a permission card; hiding the card because the
 * button would not work is the dead end these cards were built to end. So the
 * item is always raised, and `InboxAction.flag` is set on the actions that
 * cannot be taken. See `gatedBy` for the one place that decision lives.
 *
 * **4. Every `href` is built by a `shared/routes.js` helper or by `routeFor`,
 * never by concatenation.** `#/plan/<slug>/autopilot` was written by hand at
 * two call sites, the tab is registered as `run`, and an unknown tab is not an
 * error the router reports — it falls back silently. Every approval
 * notification for the life of that feature opened the wrong tab with nothing
 * saying so. `test/route-contract.test.ts` holds the server to the client's own
 * route table; `test/inbox.test.ts` holds this builder to the same assertion.
 *
 * ------------------------------------------------------------------
 * What is NOT here
 * ------------------------------------------------------------------
 *
 * `stall` and `ruling` were declared in the shared vocabulary and PRODUCED BY
 * NOBODY in Phase 4; both landed later — the stall from the run records' own
 * clocks against `STALL_META`, the ruling from the plans' ledgers. Since
 * zero-touch phase 12 a ruling that names its decision key is a row of its
 * own carrying `remember: plan|global` (the feedback loop chapter 10 ZTD-7
 * found missing: 2 315 rulings that reached no plan and no default); an
 * un-keyed one stays folded into its phase's fyi row. They were in the kind
 * list, the labels and the ack file's key space from the first day precisely
 * so that landing their detector changed no type, no route and no stored ack.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RULING_KIND_LABELS, SESSION_ASK_WAIT_KINDS, STALL_META, deriveAttention, inboxItemId,
  situationRaises, sortInbox, type InboxKind, type InboxSeverity,
} from '../shared/attention-model.js';
import { DECISION_KEYS, type DecisionKey } from '../shared/decisions-model.js';
import { POLICY_DEFAULTS, isAnswerWord } from '../shared/policy-model.js';
import { recommendedOption } from '../shared/relay-model.js';
import { phaseHref, planHref, toHash } from '../shared/routes.js';
import { parseSituationKey, situationLabel } from '../shared/situation-model.js';
import { isLiveStatus } from '../shared/status-vocab.js';
import { ISOLATED, pairKey } from '../shared/worktree-model.js';
import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import { routeFor } from './push/catalogue.ts';
import type { Presence } from '../shared/run-lifecycle.js';

/* ------------------------------------------------------------------ *
 * The wire shapes
 *
 * These mirror `client/src/lib/api/inbox.ts` field for field — that file was
 * agreed in Phase 3 and is already exported from the client's api barrel, so
 * it is the frozen contract and this is the implementation of it. TypeScript
 * types erase at runtime and cannot be imported across the client/server
 * boundary here, so the pair is held together by `test/inbox.test.ts` (every
 * kind and severity this file emits must be a member of the shared vocabulary,
 * which `test/attention-model.test.ts` in turn holds equal to the client's
 * unions, word for word and in order) — and, since Phase 6, by the type
 * checker too: the unions are IMPORTED above rather than only forwarded, so
 * every `kind:` and `severity:` literal below is checked against them. The
 * bare re-export this line used to be created no local binding, which is why
 * both names were silently `any` here for as long as they have existed.
 * ------------------------------------------------------------------ */

export type { InboxKind, InboxSeverity };

/** One thing a person can do about an item, as the server spells it. */
export type InboxAction = {
  verb: string;
  label: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /**
   * Set when — and only when — the capability that gates this action is OFF on
   * this console, so `flag` reads as "this cannot be pressed; restart with
   * `--allow-<flag>`". `InboxAction` has no `disabled` field, so this is the
   * only channel the reason has; making it present-only-when-off means a
   * client renders the disabled state from one fact rather than joining two,
   * which is where a second implementation of the rule would start.
   */
  flag?: string;
  /**
   * This action can carry words, and THIS is the body key they go in.
   *
   * A client performs an action verbatim — endpoint, method and body come off
   * the server and nothing maps a verb to a URL. A note breaks that the moment
   * the client has to know that a gate wants `note` and a permission card
   * wants `reason`, so the server says which. Absent means the action takes no
   * words, and a surface offering a box for it would be offering to send
   * something nowhere.
   *
   * Optional by construction: the field is merged in only when the operator
   * actually typed something, so an empty box is the same request as no box.
   */
  says?: { field: string; label: string; placeholder?: string };
};

export type InboxAck = { at: string; by?: string };

export type InboxItem = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  slug?: string;
  phase?: number;
  runId?: string;
  title: string;
  /** What is needed. */
  need: string;
  /** How to give it. */
  how: string;
  /** What was already tried, so nobody tries it again by hand. */
  tried?: string[];
  /**
   * ISO 8601 — since when it has been waiting. EMPTY when the fact carries no
   * stable start clock (see rule 2 in the header): an empty `since` sorts last
   * within its severity rather than first, and an ack on it never goes stale.
   * It is deliberately not "now" — a `since` that moved every poll would make
   * every ack stale on the next request, which is the same as having no acks.
   */
  since: string;
  /**
   * ISO 8601 — when the ask stops being a person's to answer. A relayed
   * question's window (phase 14): the console answers it by rule then, so a
   * surface can count down to it. Absent on every ask that waits for a person
   * however long it takes.
   */
  expiresAt?: string;
  actions: InboxAction[];
  /** Where in the console it lives. */
  href: string;
  /** Acknowledged — seen, not cleared. Absent when it is not. */
  ack?: InboxAck | null;
};

export type InboxView = {
  items: InboxItem[];
  generatedAt: string;
};

/* ------------------------------------------------------------------ *
 * The facts
 * ------------------------------------------------------------------ */

/** The ladder's one ask, as `runner/state.ts` writes it. */
export type InboxErrand = {
  /** `0` means "no phase" — a run-level wall with nothing to hang it on. */
  phase: number;
  situation: string;
  tried: readonly string[];
  need: string;
  how: string;
  at: string;
};

/**
 * A run, narrowed to what the inbox reads.
 *
 * Structural rather than an `import type { RunState }`: a real `RunState` is
 * assignable to this (every field here is a widening of the real one), and
 * declaring it locally means a test can hand-build one in six lines instead of
 * forty, which is the whole point of the pure/performer split.
 */
/**
 * One phase's run record, narrowed to what a stall row is decided from.
 *
 * Every clock here is a timestamp the runner already writes for its own
 * reasons — `liveness.lastOutputAt` from the stream, `lockWaitSince` from
 * admission, `parkedUntil` from the outcome protocol, `verifyingSince` from
 * the confirm pass. A stall is not a new fact; it is the observation that one
 * of those has stopped moving.
 */
export type InboxRunPhase = {
  phase: number;
  /** `PhaseStatus`. */
  status?: string;
  /** `runner/liveness.ts` `LaneLiveness`, narrowed. */
  liveness?: {
    lastOutputAt?: string;
    turnsSinceLastTool?: number;
    openTool?: { name?: string; since?: string };
  };
  /** The live signal, when the runner has one. */
  stall?: { signal?: string; since?: string; detail?: string };
  lockWaitSince?: string;
  /** Who admission said the wait is behind — `autopilot/<runId>` owners. */
  waitingOn?: { slug: string; phase?: number; owner: string }[];
  parkedUntil?: string;
  parkReason?: string;
  verifyingSince?: string;
};

export type InboxRun = {
  id: string;
  slug: string;
  /** `RunStatus`. */
  status: string;
  updatedAt?: string;
  /** Keyed by phase number as a string, as `RunState.phases` is. */
  phases?: Readonly<Record<string, InboxRunPhase | undefined>>;
  activePhase?: number | null;
  /** `RunResolution | null` — truthy means someone (or the board) closed it. */
  resolved?: unknown;
  stoppedBy?: 'operator' | 'system';
  /** `{ attempts }` on a real record — read for truthiness only, never shape. */
  autoRecover?: unknown;
  halt?: { at?: string; reason?: string; phase?: number; kind?: string } | null;
  /** The run-level errand — a wall with no phase to hang it on. */
  errand?: InboxErrand | null;
  /**
   * Keyed by phase number as a string; `plan` is a plan-wide repair slot.
   *
   * Narrowed to the three fields this file reads, all optional so a hand-built
   * fixture stays short. `errand` is the ask; `rungs` and `attempts` are how
   * `errandDrafts` tells "the ladder has engaged with this stop" from "nothing
   * has touched it" — `runner/state.ts` types `attempts` as REQUIRED and
   * `service-recovery.ts` seeds every slot it creates with `{ attempts: 0 }`,
   * so on a real record both are always there. `rungs` is read for its length
   * and nothing else, hence `unknown[]`: importing `RungRecord` would pull a
   * runner type across the boundary this structural block exists to keep.
   */
  recoveries?: Readonly<Record<string, {
    errand?: InboxErrand;
    rungs?: readonly unknown[];
    attempts?: number;
  } | undefined>>;
  /**
   * The run-level freeze slot — the LOWEST frozen phase, or null. A mirror of
   * one of `children`, kept for readers that predate lanes.
   */
  freeze?: { phase?: number | null } | null;
  /**
   * Keyed by phase number as a string. Only `frozen` is read here, for
   * truthiness: several lanes can be frozen at once and the single slot above
   * can name only one of them.
   */
  children?: Readonly<Record<string, { phase?: number; frozen?: unknown } | undefined>>;
};

/**
 * The phases this run currently holds under SIGSTOP.
 *
 * Every silence row below is triggered by a session producing nothing, and a
 * frozen session produces nothing by construction — so freezing a lane raised
 * the very `needs-you` row the operator had just made unnecessary, telling them
 * something was wrong with the thing they had deliberately just done. Both
 * places a freeze is recorded are read, for the same reason `frozenEntries`
 * reads both: the slot names one lane, the children name all of them.
 */
function frozenPhases(run: InboxRun): Set<number> {
  const out = new Set<number>();
  const slot = run.freeze?.phase;
  if (typeof slot === 'number') out.add(slot);
  for (const [key, child] of Object.entries(run.children ?? {})) {
    if (!child?.frozen) continue;
    const phase = typeof child.phase === 'number' ? child.phase : Number(key);
    if (Number.isFinite(phase)) out.add(phase);
  }
  return out;
}

/** A pending permission card, narrowed. `runner/approvals.ts` `Approval`. */
export type InboxApproval = {
  id: string;
  runId?: string;
  slug?: string;
  phase?: number | null;
  kind?: string;
  /** A card no session holds a hook open for — the ladder's `widen-rule` offer (phase 9). */
  standing?: true;
  title?: string;
  detail?: string;
  createdAt?: string;
  expiresAt?: string;
  status?: string;
  /** A relayed question's own part (phase 14) — `runner/approvals.ts` `ApprovalQuestion`, narrowed. */
  question?: {
    items: { key: string; question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[];
    answers?: Record<string, { label: string; by: string }>;
    deferred?: unknown;
  };
};

/** One phase of a plan, as `Service.detail()` already projects it. */
export type InboxPhase = {
  phase: number;
  title?: string;
  /** The board word from the engine — `ctx.board.states[phase]`. */
  state?: string;
  gated?: boolean;
  gateCheck?: string;
  gateKind?: string;
  /**
   * `Service.gateStatus(slug, phase)`. Engine-authoritative and a subprocess
   * per call, so the caller fetches it ONLY for `gated && state !== 'done'`
   * phases and passes it in. Absent means "not asked", which raises nothing.
   */
  gate?: { clear: boolean; kind?: string; detail?: string; approved?: boolean } | null;
  /**
   * Declared and NOT read in Phase 4 — `locks` below is the lock source (it
   * spans plans and carries the lease), and the handoff is what the Phase 5
   * stall detector will want. Gather them if `detail()` already handed them to
   * you; omit them if not.
   */
  lock?: { owner: string; expired: boolean; leaseUntil?: number } | null;
  handoff?: { status?: string; outstanding?: string[] } | null;
};

export type InboxPlan = {
  slug: string;
  title?: string;
  /**
   * `PlanRecord.plan.closed`. A closed plan reports no PROGRESS but a live
   * process keeps its voice — exactly the split `push/catalogue.ts` already
   * draws with `PLAN_PROGRESS_CATEGORIES`, copied rather than reinvented: gate
   * and qa items are silenced on a closed plan, errands, approvals, locks and
   * health are not, because those are claims about a process, not a pulse.
   */
  closed?: boolean;
  /**
   * When the plan was last written. The `since` of a gate, a QA row or a plan
   * health issue, none of which carry a clock of their own: it is stable
   * between polls and it moves exactly when the plan does, which is the only
   * moment "this ask is new again" could be true.
   */
  updatedAt?: string;
  /**
   * `prefs.delegateHumanGates` — the operator has told the console a session
   * may clear a `human` gate itself. A delegated gate raises no row: the boot
   * prompt briefs the phase to verify each condition and record the clearance,
   * so asking a person as well is asking for an act somebody already delegated.
   */
  gatesDelegated?: boolean;
  /** `Service.qaMode(slug)` — engine `--qa-mode`. */
  qaMode?: { mode: string; reason?: string };
  /** Per-phase regimes for phases stating their own `- **QA:**` — gathered
   * only where the answer can change a row (a pending verdict on a done
   * phase under a plan whose own word would suppress it). */
  qaModes?: Readonly<Record<number, string>>;
  /** `PlanRecord.qa` — the rows of `## QA status` in `test-status.md`. */
  qa?: readonly { phase: number; result: string; report?: string }[];
  /** `healthIssues(ctx)` — already closure-filtered by the caller. */
  issues?: readonly { slug: string; severity: string; kind: string; message: string; phase?: number }[];
  phases?: readonly InboxPhase[];
};

/** `runner/scheduler.ts` `LockView`, narrowed. */
export type InboxLock = {
  slug: string;
  phase: number;
  owner: string;
  expired: boolean;
  /** `lease_until` as ms epoch — for an expired lock this is when it lapsed. */
  leaseUntil?: number;
  session?: string;
};

/** `Service.queueSnapshot()`, narrowed to what tells an item it is in the way. */
export type InboxQueue = {
  live?: number;
  queued?: number;
  entries?: readonly {
    slug?: string;
    phase?: number | null;
    since?: number;
    waitingOn?: readonly { kind?: string; slug?: string; phase?: number | null; owner?: string }[];
  }[];
};

/** `accounts/index.ts` `AccountView`, narrowed. */
export type InboxAccount = {
  id: string;
  name?: string;
  email?: string;
  kind?: string;
  /** True for the synthesized machine login — `auth` below is its real source. */
  builtIn?: boolean;
  signedIn?: boolean;
  /** `ok | expiring | expired | signed-out | unknown`. */
  authState?: string;
};

/** `mcp/index.ts` `McpServerView`, narrowed. */
export type InboxMcpServer = {
  id: string;
  label?: string;
  enabled?: boolean;
  /** `connected | needs-auth | pending | failed | unknown`. */
  status?: string;
  issue?: string;
  toolsChanged?: { added?: string[]; removed?: string[]; seenAt?: string };
  /** `${VAR}`s its own command still names and nothing supplies. */
  needsConfig?: string[];
};

/**
 * Everything "something needs a person" can be decided from.
 *
 * Every field is optional and every absent field means "nothing to say" — NOT
 * "unknown". That is deliberate: an inbox that throws because one gatherer
 * failed is strictly worse than an inbox missing one row, and the whole surface
 * is a diagnostic. Pass everything you have; the empty object is a legal call
 * and returns an empty view.
 */
/** How the phone reaches this console under `--remote` — `InboxFacts.fleet.remote`. */
export type InboxReach = {
  running: boolean;
  detail?: string;
  forOurPort: boolean;
  hosts: readonly string[];
  occupant?: { port: number; id?: string; name?: string };
};

export type InboxFacts = {
  /**
   * Every run across every plan. `Service.allRuns()` — async, and it resolves
   * records against the board (it can close one the board has overtaken), so
   * it is NOT `runStates()`. Carries `errand`, `recoveries[phase].errand`,
   * `resolved`, `stoppedBy`, `autoRecover`, `halt` and `status`.
   */
  runs?: readonly InboxRun[];
  /** `service.approvals.all()`; only `status === 'pending'` raises anything. */
  approvals?: readonly InboxApproval[];
  /** One entry per plan the store holds, assembled from `Service.detail()`. */
  plans?: readonly InboxPlan[];
  /** `Service.allLocks()` — private today; closed plans already excluded. */
  locks?: readonly InboxLock[];
  /**
   * `SessionRegistry.presenceOfLock`, resolved to a map keyed `${slug}:${phase}`
   * so the build stays synchronous and snapshot-consistent. Only `ended` makes
   * an UNEXPIRED lock debris; an owner/time match is display and releases
   * nothing.
   */
  lockPresence?: Readonly<Record<string, Presence>>;
  /** `Service.queueSnapshot()`. */
  queue?: InboxQueue;
  /** `Service.listAccounts()` — already redacted. */
  accounts?: readonly InboxAccount[];
  /**
   * `Service.authStatus()` — the MACHINE login, which no `AccountView` covers
   * and which every default-account run spends.
   */
  auth?: { loggedIn?: boolean; email?: string; checkedAt?: string; detail?: string };
  /** `Service.listMcp()`. */
  mcp?: readonly InboxMcpServer[];
  /** `state().environment.issues` — each carries its own `fix` sentence. */
  environment?: readonly { kind: string; detail: string; fix: string }[];
  /**
   * This console's reach, and the other consoles of the machine (zero-touch
   * phase 17, FLT-1 iv / FLT-6) — `ServiceBase.inboxFleetFacts()`. A console
   * nobody can reach is work, and so is a sibling that is down or orphaned:
   * each raises a `needs-you` health row (`INSTANCE_HEALTH_KINDS`).
   */
  fleet?: {
    /** The boot doctor's delivery verdict — `probeDelivery` over the live register. */
    delivery?: { ok: boolean; reason: string };
    /** `notifications.unread()`. */
    unread?: number;
    /** Only under `--remote`: whether Tailscale runs and whose port Serve fronts. */
    remote?: InboxReach | null;
    /** Every OTHER registered console, as the census reads it. */
    siblings?: readonly {
      id: string;
      name: string;
      root: string | null;
      liveness: string;
      discrepancies: readonly string[];
      unit: boolean;
      autostart: boolean | 'once';
      stopMarker: boolean;
      lastSeenAt: string | null;
      stoppedAt: string | null;
    }[];
  };
  /** `this.watcher.status()`. A deaf watcher looks fine from everywhere else. */
  watcher?: { healthy?: boolean; watching?: number; expected?: number; failures?: number };
  /** `degradedState()`. */
  degraded?: { healthy?: boolean; recent?: readonly { kind: string; message: string; at?: string }[] };
  /**
   * What a remedy costs. Absent means every capability is off, which is the
   * safe direction: an action is reported as flagged rather than pressable.
   */
  flags?: {
    allowWrites?: boolean;
    allowRun?: boolean;
    allowTerminal?: boolean;
    allowAgent?: boolean;
    allowAccounts?: boolean;
    allowMcp?: boolean;
  };
  /**
   * The plans `server/analysis/stats.ts` already calls stalled: open, with
   * ready phases, untouched for a week.
   *
   * Read rather than re-derived, deliberately. Two computations of "idle for
   * seven days" would disagree the first time one of them learned about a new
   * kind of activity, and the Insights page's list is the one an operator has
   * already seen.
   */
  stalledPlans?: readonly { slug: string; days: number; ready: readonly number[] }[];
  /**
   * The plans' ruling ledgers (`runner/rulings.ts`), any order. Only the
   * recent ones raise a row — see `rulingDrafts`.
   */
  rulings?: readonly {
    id: string; slug: string; phase: number; kind: string; what: string;
    why?: string; costIfWrong?: string; at: string;
    /** The manifest key the ruling answers — what makes it rememberable. */
    decisionKey?: string;
    /** A relayed question's answer (phase 14) — remembered as a relay rule, never as a decision row. */
    relay?: { tool: string; key: string; answer: string; answeredBy: string };
  }[];
  /**
   * What the policy table answered BY ITSELF (zero-touch phase 19) — each open
   * plan's newest run: its journal's `phase.policy-answered` lines and the
   * fingerprints the run keeps on `recoveries[phase].policyAnswered`. Only the
   * recent ones raise a row — see `policyDrafts`.
   */
  policyAnswers?: readonly InboxPolicyAnswer[];
  /** The acks file, keyed by `InboxItem.id`. `readAcks()` below reads it. */
  acks?: Readonly<Record<string, InboxAck>>;
  /**
   * The session registry — `Service.sessionViews()`: presence, kind, and the
   * waiting flag. `sessionAskDrafts` reads it; nothing else does yet.
   */
  sessions?: readonly InboxSession[];
  /**
   * One entry per LIVE run that has a checkout of its own —
   * `Service.runGit(slug)`, which is `null` for every shared run and therefore
   * contributes nothing here. `conflictDrafts` reads it.
   *
   * The radar inside each entry is repository-WIDE, not run-wide: two isolated
   * runs of the same repository both see the same pair and both would raise
   * it. That is why the card's identity is the PAIR (see `conflictDrafts`) —
   * the builder's dedupe then collapses the two into the one row an operator
   * should see.
   */
  git?: readonly InboxGit[];
};

/**
 * One run's git probe, narrowed to what a conflict row is decided from.
 *
 * A real `RunGitView` (`runner/worktree.ts`) plus the three facts about the
 * RUN that the view itself does not carry — which plan it belongs to, when it
 * started, and whether it is isolated. The first two are how a branch in a
 * pair is traced back to a run, and the third is the difference between an
 * action that can be offered and one that would 409.
 */
export type InboxGit = {
  slug: string;
  /** The run's own branch. How a radar participant is traced back to a run. */
  branch?: string;
  /** ISO — when this run started. Decides which of two runs is the YOUNGER. */
  startedAt?: string;
  /** `RunState.isolation === 'worktree'`. Only an isolated run can be serialized. */
  isolation?: string;
  /** What the ask GOT — `'worktree' | 'refused' | 'shared'`. */
  checkout?: string;
  /** Which impossibility a refused ask hit, and its sentence. */
  isolationRefusal?: string;
  refusalReason?: string;
  /** A mirror run's mounted repositories, root-relative. */
  mounts?: readonly string[];
  /** `RunGitView.radar`, worst first. Only `conflicted` pairs raise anything. */
  radar?: readonly { a: string; b: string; state: string; files?: readonly string[] }[];
};

/**
 * A registry session, narrowed to what the drafts read. `SessionView`
 * (`sessions/registry.ts`) is assignable to this — the loose strings keep this
 * file dependency-free the way every other fact type here is.
 */
export type InboxSession = {
  sessionId: string;
  /** 'autopilot' | 'agent' | 'foreign' */
  kind?: string;
  /** Presence */
  presence?: string;
  cwd?: string;
  /** The session is stopped waiting on a person — see `SessionRecord.waiting`. */
  waiting?: { since?: string; kind?: string; note?: string } | null;
  plan?: { slug?: string; phase?: number; strong?: boolean };
};

/** Request-shaped knobs, which are not facts about the world. */
export type InboxOptions = {
  /** Include acknowledged items. `GET /api/inbox?all=1`. */
  all?: boolean;
};

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

/** A phase number that is really a phase. `0` is the ladder's "no phase". */
function positivePhase(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The first candidate that parses as a date, else `''`.
 *
 * Never falls back to "now": see the note on `InboxItem.since`. A `since` that
 * moved with the clock would make every acknowledgement stale on the next
 * request, and an inbox whose acks never hold is an inbox nobody acknowledges.
 */
function stableSince(...candidates: (string | number | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const at = typeof candidate === 'number' ? candidate : Date.parse(String(candidate));
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return '';
}

/**
 * The one place a capability decision is made.
 *
 * Returns `{ flag }` when the capability is OFF and `{}` when it is on, so an
 * action is spread with `...gatedBy('run', flags.allowRun)` and never carries
 * `flag: undefined`. Flipping the contract to "always name the gate" is a
 * one-line change here rather than eleven call sites.
 */
function gatedBy(flag: string, allowed: boolean | undefined): { flag?: string } {
  return allowed ? {} : { flag };
}

const runVerb = (slug: string, verb: string): string => `/api/run/${encodeURIComponent(slug)}/${verb}`;
const planVerb = (slug: string, ...rest: (string | number)[]): string =>
  [`/api/plans/${encodeURIComponent(slug)}`, ...rest.map((part) => encodeURIComponent(String(part)))].join('/');

/**
 * The draft an item is before it has an id: everything on the wire, plus the
 * `subject` that discriminates it within its (kind, slug, phase, runId) and
 * which deliberately never leaves the server.
 */
type Draft = Omit<InboxItem, 'id' | 'ack'> & { subject?: string };

function mint(draft: Draft): InboxItem {
  const { subject, ...wire } = draft;
  return {
    id: inboxItemId({
      kind: draft.kind,
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.phase != null ? { phase: draft.phase } : {}),
      ...(draft.runId ? { runId: draft.runId } : {}),
      ...(subject ? { subject } : {}),
    }),
    ...wire,
  };
}

/**
 * The ack, if it is still one.
 *
 * An ack stamped BEFORE the item's own `since` is not an ack: the ask came
 * back. A QA row that went pending → fail keeps its slug and phase but changes
 * its clock; a lock released and retaken does the same. Where either clock is
 * unparseable the ack stands — "I could not compare" and "it is stale" are
 * different facts, and treating the first as the second would silently re-ask
 * every clockless item on every poll.
 */
function ackFor(
  acks: Readonly<Record<string, InboxAck>> | undefined,
  id: string,
  since: string,
): InboxAck | undefined {
  const ack = acks?.[id];
  if (!ack || typeof ack.at !== 'string') return undefined;
  const ackAt = Date.parse(ack.at);
  const sinceAt = Date.parse(since);
  if (Number.isFinite(ackAt) && Number.isFinite(sinceAt) && ackAt < sinceAt) return undefined;
  return ack.by ? { at: ack.at, by: ack.by } : { at: ack.at };
}

/* ------------------------------------------------------------------ *
 * errand
 * ------------------------------------------------------------------ */

/**
 * Every open errand of a run: the phase ones in phase order, then the run-level
 * one. This is `client/src/lib/ladder.ts` `errandsOf` reproduced server-side —
 * including the `/^\d+$/` key filter, without which the `plan` slot (a
 * plan-wide repair, not a phase) leaks in as `phase: NaN`.
 */
function errandsOf(run: InboxRun): InboxErrand[] {
  const phased = Object.entries(run.recoveries ?? {})
    .filter(([key, slot]) => slot?.errand && /^\d+$/.test(key))
    .map(([, slot]) => slot!.errand!)
    .sort((a, b) => a.phase - b.phase);
  return [...phased, ...(run.errand ? [run.errand] : [])];
}

/**
 * Runs that are stopped and not already dealt with.
 *
 * `resolved` is annotation, never deletion: the run keeps its record and its
 * place on the Runs page and simply stops being asked about here.
 */
function stoppedRuns(runs: readonly InboxRun[]): InboxRun[] {
  return runs.filter((run) => !run.resolved && !isLiveStatus(run.status) && run.status !== 'finished');
}

/** Dismiss — never flagged. A console that cannot even put a card down is the dead end. */
function dismissAction(run: InboxRun): InboxAction {
  return {
    verb: 'dismiss',
    label: 'Dismiss',
    endpoint: runVerb(run.slug, 'resolve'),
    method: 'POST',
    body: { runId: run.id },
  };
}

function errandDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  const closedPlans = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));
  /** The recorded verdict for a phase, from the plan facts — the QA table is the authority. */
  const qaVerdictOf = (slug: string, phase: number | undefined): string | null => {
    if (phase == null) return null;
    const plan = (facts.plans ?? []).find((p) => p.slug === slug);
    const row = plan?.qa?.find((r) => r.phase === phase);
    return row?.result ?? null;
  };

  for (const run of facts.runs ?? []) {
    if (run.resolved || run.status === 'finished') continue;
    const live = isLiveStatus(run.status);
    // A phase-level errand on a LIVE run is the ladder's park-with-errand
    // design doing its job — the run keeps driving, only the errand asks. The
    // loop used to visit stopped runs alone, so the one pointer to a QA hold
    // sat invisible for sixteen hours while its run drove on around it.
    // Run-LEVEL errands stay stopped-only: a wall with no phase to hang it on
    // is a claim about the whole run, and the run is visibly alive.
    const errands = errandsOf(run).filter((errand) => !live || positivePhase(errand.phase) != null);
    const mcpParked = run.halt?.kind === 'mcp-preflight';

    for (const errand of errands) {
      const { id, sub } = parseSituationKey(errand.situation);
      const auth = id === 'resource-wall' && sub === 'auth';
      const mcp = id === 'mcp-unavailable' || mcpParked;
      const phase = positivePhase(errand.phase);
      // A QA errand whose ask the QA table already answers is history, not an
      // ask: nothing dissolves a stored errand while its run drives, and a
      // standing "needs you" over a recorded verdict is how the needs-you
      // band gets muted. The table is the authority — a qa-pending errand is
      // answered by ANY verdict, a qa-failed one by pass/waived.
      if (id === 'qa-pending' || id === 'qa-failed') {
        const verdict = qaVerdictOf(run.slug, phase ?? undefined);
        const answered = id === 'qa-pending'
          ? verdict != null && verdict !== 'pending'
          : verdict === 'pass' || verdict === 'waived';
        if (answered) continue;
      }

      out.push({
        kind: 'errand',
        severity: 'needs-you',
        subject: errand.situation,
        slug: run.slug,
        ...(phase != null ? { phase } : {}),
        runId: run.id,
        title: `${run.slug} — ${phase != null ? `phase ${phase} needs you` : 'needs you'}`,
        need: errand.need,
        how: errand.how,
        ...(errand.tried?.length ? { tried: [...errand.tried] } : {}),
        since: stableSince(errand.at, run.halt?.at, run.updatedAt),
        href: planHref(run.slug, 'run'),
        actions: [
          // Signing in first, because continuing before it is a session that
          // reports success, spends a turn and changes nothing.
          ...(auth
            ? [
                {
                  verb: 'login',
                  label: 'Open a sign-in terminal',
                  endpoint: '/api/auth/login',
                  method: 'POST' as const,
                  ...gatedBy('run', flags.allowRun),
                },
                {
                  verb: 'recheck',
                  label: 'Check again',
                  endpoint: '/api/accounts/refresh',
                  method: 'POST' as const,
                },
              ]
            : live
              // Recover refuses a live run and Dismiss would resolve one, so
              // neither is offered — but "I did what it asked, look again" is
              // true in both states and is the only verb that is. It re-reads
              // the board and stands down what the errand settled; on a live
              // run that is exactly what a person wants after doing the thing.
              // Without it the one pointer to a QA hold sat there for sixteen
              // hours with no button at all while its run drove on around it.
              ? [
                  {
                    verb: 'recheck',
                    label: 'I did it — look again',
                    endpoint: runVerb(run.slug, 'recheck'),
                    method: 'POST' as const,
                    // `recheck` is a PHASE verb (`recoverPhase`), so the body
                    // carries the phase. A live-run errand always has one —
                    // the filter above keeps only phase-level errands while a
                    // run is live — but the fallback is explicit rather than a
                    // `!` that would send `NaN` if that ever changed.
                    body: { phase: phase ?? 0 },
                    ...gatedBy('run', flags.allowRun),
                  },
                ]
            : mcp
              ? [
                  {
                    verb: 'mcp-continue',
                    label: 'Continue without these servers',
                    endpoint: runVerb(run.slug, 'mcp-continue'),
                    method: 'POST' as const,
                    ...gatedBy('run', flags.allowRun),
                  },
                ]
              : [
                  // "I did what it asked — look again": it re-reads the board,
                  // stands down what the errand settled, and continues or
                  // climbs whatever is left.
                  {
                    verb: 'recover',
                    label: 'Recover & continue',
                    endpoint: runVerb(run.slug, 'recover'),
                    method: 'POST' as const,
                    ...gatedBy('run', flags.allowRun),
                  },
                ]),
          ...(live ? [] : [dismissAction(run)]),
        ],
      });
    }

    if (live) continue;

    if (errands.length) continue;

    // The stop nothing automatic will touch. The ladder climbs only runs that
    // opted into auto-recovery, and only from a console that may run — a stop
    // outside that pair is waiting on a person with no errand to say so, and
    // this is the read-only-console case the dashboard has raised since 2.3.0.
    // `subject: 'unattended-stop'` is a word no situation key can be, so it can
    // never collide with a real errand's id.
    if (!(run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked')) continue;
    if (run.stoppedBy === 'operator') continue;
    // A closed plan keeps its voice for errands, approvals, locks and health —
    // claims about a process, not a pulse (see `InboxPlan.closed`). This row is
    // the one errand that is explicitly a claim about a STOPPED run, and on a
    // plan somebody has closed there is nothing left to continue toward.
    // Measured live: two closed, complete plans were contributing 2 of a
    // console's 16 `needs-you` rows, months after anyone cared.
    if (closedPlans.has(run.slug)) continue;
    // Armed auto-recovery normally DOES own the stop, and saying so here too
    // would be asking twice — that is what this guard is for, and it stays.
    //
    // But it was a promise the ladder cannot always keep. `classifyOpenPhases`
    // skips every record the board reads `done`, so a run whose records ALL read
    // done has no candidate, climbs nothing, and writes no errand — while this
    // row, the one thing that would have told a person their run was waiting on
    // them, stayed suppressed against an errand that could not come. Measured on
    // a real run that sat parked for a day with six phases held behind a QA
    // verdict nobody was asked for.
    //
    // Narrow on purpose: only the shape the ladder provably cannot reach. A run
    // with no records yet, or with one still open, is still the ladder's.
    const records = Object.values(run.phases ?? {});
    const allSettled = records.length > 0
      && records.every((record) => record?.status === 'done' || record?.status === 'skipped');
    const engaged = Object.values(run.recoveries ?? {})
      .some((slot) => slot?.rungs?.length || slot?.errand || (slot?.attempts ?? 0) > 0);
    if (flags.allowRun && run.autoRecover && !(allSettled && !engaged)) continue;

    const phase = positivePhase(run.halt?.phase ?? run.activePhase);
    out.push({
      kind: 'errand',
      severity: 'needs-you',
      subject: 'unattended-stop',
      slug: run.slug,
      ...(phase != null ? { phase } : {}),
      runId: run.id,
      title: `${run.slug} ${run.status}`,
      need: flags.allowRun
        ? 'Your decision — auto-recovery is off for this run, so nothing climbs this stop by itself.'
        : 'A console that may run — this one is read-only for runs, so nothing climbs this stop by itself.',
      how: flags.allowRun
        ? 'Press Recover & continue to let the ladder climb once, or Dismiss.'
        : 'Restart the console with --allow-run, then press Recover & continue.',
      since: stableSince(run.halt?.at, run.updatedAt),
      href: planHref(run.slug, 'run'),
      actions: [
        {
          verb: 'recover',
          label: 'Recover & continue',
          endpoint: runVerb(run.slug, 'recover'),
          method: 'POST',
          ...gatedBy('run', flags.allowRun),
        },
        dismissAction(run),
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * approval
 * ------------------------------------------------------------------ */

/**
 * `urgent`, always: a permission card is a session parked dead with a hook
 * open on the far end. It is the one kind where waiting costs money.
 */
function approvalDrafts(facts: InboxFacts): Draft[] {
  const flags = facts.flags ?? {};
  return (facts.approvals ?? [])
    // A relayed question is its own kind, with its own actions (`questionDrafts`).
    .filter((approval) => approval.status === 'pending' && approval.kind !== 'question')
    .map((approval) => {
      const phase = positivePhase(approval.phase);
      const decide = (decision: 'allow' | 'deny', label: string): InboxAction => ({
        verb: decision,
        label,
        endpoint: `/api/approvals/${encodeURIComponent(approval.id)}`,
        method: 'POST',
        // `by` is deliberately absent: who pressed it is the browser's fact,
        // not the server's, and the route already defaults it to `console`.
        body: { decision },
        says: {
          field: 'reason',
          label: 'Why (optional)',
          placeholder: decision === 'deny' ? 'what the session should do instead' : 'anything the session should know',
        },
        ...gatedBy('run', flags.allowRun),
      });
      return {
        kind: 'approval' as const,
        severity: 'urgent' as const,
        subject: approval.id,
        ...(approval.slug ? { slug: approval.slug } : {}),
        ...(phase != null ? { phase } : {}),
        ...(approval.runId ? { runId: approval.runId } : {}),
        title: approval.title || (approval.standing ? 'A phase is parked on a decision' : 'A session is waiting on a decision'),
        need: approval.detail || 'A session is parked until you answer.',
        // A STANDING card (the ladder's `widen-rule` offer, phase 9) holds no
        // hook open: the phase is parked behind it and nothing spends.
        how: approval.standing
          ? 'Allow it to strike the rule for this plan and resume the phase\'s own session, or deny it and do the step by hand — the phase is parked, nothing spends, until you do.'
          : 'Allow it or deny it — the session is holding a hook open until you do.',
        since: stableSince(approval.createdAt),
        href: approval.slug ? planHref(approval.slug, 'run') : toHash(routeFor('approval')),
        actions: [decide('allow', 'Allow'), decide('deny', 'Deny')],
      };
    });
}

/* ------------------------------------------------------------------ *
 * question
 * ------------------------------------------------------------------ */

/**
 * A question a session raised on a relay-armed run (phase 14), one row per
 * question it has not had answered — a call carries 1 to 4 — with one action
 * per option. `urgent`: a session is holding a hook open for it. The row says
 * what the console will answer when the window closes, and when that is
 * (`expiresAt`), so a person deciding whether to bother knows what silence
 * chooses. A deferred card (the console went away with it open) is nobody's to
 * answer from here — its answer is the boot's — and raises nothing.
 */
function questionDrafts(facts: InboxFacts): Draft[] {
  const flags = facts.flags ?? {};
  const out: Draft[] = [];
  for (const approval of facts.approvals ?? []) {
    if (approval.status !== 'pending' || approval.kind !== 'question' || !approval.question || !approval.slug) continue;
    if (approval.question.deferred) continue;
    const phase = positivePhase(approval.phase);
    const answered = approval.question.answers ?? {};
    for (const item of approval.question.items) {
      if (answered[item.key]) continue;
      const silence = recommendedOption(item.options) ?? item.options[0]?.label;
      out.push({
        kind: 'question',
        severity: 'urgent',
        subject: `${approval.id}:${item.key}`,
        slug: approval.slug,
        ...(phase != null ? { phase } : {}),
        ...(approval.runId ? { runId: approval.runId } : {}),
        title: item.question.slice(0, 240),
        need: `${approval.slug}${phase != null ? ` phase ${phase}` : ''} asks${item.header ? ` (${item.header})` : ''} — pick one.`,
        how: `Unanswered, the console answers by its relay rules when the window closes${silence ? ` — "${silence}" unless a rule says otherwise` : ''}.`,
        since: stableSince(approval.createdAt),
        ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
        href: planHref(approval.slug, 'run'),
        actions: item.options.map((option, index) => ({
          verb: `answer-${index + 1}`,
          label: option.label.slice(0, 80),
          endpoint: runVerb(approval.slug!, 'answer'),
          method: 'POST' as const,
          body: { approvalId: approval.id, key: item.key, label: option.label },
          ...gatedBy('run', flags.allowRun),
        })),
      });
    }
  }
  return out;
}

/**
 * A Claude session stopped at its own prompt — an agent session, someone's own
 * CLI, or (since 5.0.0, REG-5/TRS-6) an autopilot lane — reported by the
 * machine-wide Notification hook. A lane is left out only while an approval
 * card for its own phase is pending, because that card IS the ask; otherwise
 * its wait is a row in its own right, carrying the question and an answer
 * action, since the console CAN write to a lane's session (`steer`). Only a
 * LIVE session asks — `ended` is over, and `unknown` is a claim nobody can
 * vouch for.
 *
 * The id's subject is the sessionId ALONE — no slug, phase or runId. The weak
 * plan correlation flaps as locks come and go, and an id that moved would shed
 * its ack; "asked again" is carried by `since` (`waiting.since`) instead,
 * which a new episode advances past the old ack by the standing `ackFor` rule.
 *
 * `severity` follows the approval test: a permission prompt is a session
 * parked dead (`urgent`); idle-waiting-for-input is a person's turn
 * (`needs-you`). A foreign or agent row has no actions: the console has no verb
 * that can answer someone else's terminal.
 */
function sessionAskDrafts(facts: InboxFacts): Draft[] {
  const carded = (slug: string | undefined, phase: number | null | undefined) =>
    Boolean(slug) && phase != null && (facts.approvals ?? []).some(
      (approval) => approval.status === 'pending' && approval.slug === slug && approval.phase === phase,
    );
  return (facts.sessions ?? [])
    // `SESSION_ASK_WAIT_KINDS`, not "any Notification": the hook fires for more
    // than a prompt, and every one of them used to become an urgent push. A
    // channel that fires for everything is a channel that gets muted, and the
    // one it gets muted for is the permission card holding a lane dead.
    .filter((session) => session.presence === 'live'
      && SESSION_ASK_WAIT_KINDS.includes(String(session.waiting?.kind ?? ''))
      && !(session.kind === 'autopilot' && carded(session.plan?.slug, positivePhase(session.plan?.phase))))
    .map((session) => {
      const permission = session.waiting?.kind === 'permission';
      const ask = permission ? 'permission' : session.waiting?.kind === 'elicitation' ? 'answer' : 'input';
      const phase = positivePhase(session.plan?.phase);
      const where = session.plan?.slug
        ? `on ${session.plan.slug}${phase != null ? ` phase ${phase}` : ''}`
        : session.cwd
          ? `in ${session.cwd}`
          : 'on this machine';
      // A lane of the autopilot the console knows the plan and phase of can be
      // answered from here: the words go into its session as an instruction.
      const lane = session.kind === 'autopilot' && session.plan?.slug && phase != null
        ? { slug: session.plan.slug, phase }
        : null;
      return {
        kind: 'session-ask' as const,
        severity: (permission ? 'urgent' : 'needs-you') as InboxSeverity,
        subject: session.sessionId,
        title: `A session is waiting on your ${ask}`,
        need: session.waiting?.note
          || `A Claude session working ${where} is stopped until you answer it.`,
        how: lane
          ? 'Answer it here — your words reach the lane’s session as an instruction for the rest of the phase.'
          : 'Go to the terminal it is running in and answer the prompt — the console cannot answer for it.',
        since: stableSince(session.waiting?.since),
        href: toHash(routeFor('session-ask')),
        actions: lane
          ? [{
            verb: 'steer',
            label: 'Answer it',
            endpoint: runVerb(lane.slug, 'steer'),
            method: 'POST' as const,
            body: { phase: lane.phase },
            says: { field: 'instruction', label: 'Your answer', placeholder: 'What the session should do' },
            ...gatedBy('run', facts.flags?.allowRun),
          }]
          : [],
      };
    });
}

/* ------------------------------------------------------------------ *
 * gate · qa · plan health
 * ------------------------------------------------------------------ */

/**
 * Health issue kinds a DEDICATED inbox kind already owns.
 *
 * `analysis/stats.ts` turns a failing QA row into `HealthIssue{kind:'qa-fail'}`
 * and an expired lock into `HealthIssue{kind:'stale-lock'}` — the same two
 * facts the `qa` and `lock` kinds raise from their own sources. Without this
 * list one failing QA row is two rows in the inbox, with two ids and two acks,
 * and acknowledging either leaves the other. Dedupe by construction beats
 * dedupe by id, because the ids genuinely differ.
 */
const ISSUE_KINDS_OWNED_ELSEWHERE = new Set(['qa-fail', 'stale-lock']);

function planDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  /**
   * `slug:phase` for every phase whose situation is NOT one the fact map lets
   * raise a health row — i.e. every phase whose session declared something.
   * Built once from the runs, because the plan's own issue list has no way to
   * know a session spoke.
   */
  const declaredPark = new Set<string>();
  for (const run of facts.runs ?? []) {
    for (const errand of errandsOf(run)) {
      if (!errand.situation || situationRaises('health', errand.situation)) continue;
      declaredPark.add(`${run.slug}:${positivePhase(errand.phase) ?? ''}`);
    }
  }

  for (const plan of facts.plans ?? []) {
    const phases = plan.phases ?? [];
    /**
     * Deliberately EMPTY, and this is the whole of rule 2 above applied.
     *
     * A gate, a QA row and a plan health issue carry no clock of their own, and
     * `plan.updatedAt` was standing in for one. But the plan file is written by
     * every phase that lands, every handoff, every lock claim — so an ack on a
     * gate row was thrown away by the NEXT PHASE COMMITTING, and the operator
     * was asked to approve the same gate again an hour after declining to.
     * An empty `since` means "no clock", which `ackFor` reads as "the ack
     * stands"; an item that genuinely goes away and comes back loses its ack by
     * having been absent, which is `pruneAcks`' job and always was.
     */
    const planSince = '';
    const stateOf = new Map(phases.map((phase) => [phase.phase, phase.state ?? '']));

    /* ---- gate ---- */
    if (!plan.closed) {
      for (const phase of phases) {
        if (!phase.gated) continue;
        if (!phase.gate) continue;
        // The whole decision is `deriveAttention`'s, and the three cases it
        // subtracts are the ones that used to raise a row nobody could act on:
        // an `ai` gate (the phase's own session clears it), a delegated one
        // (the operator already said a session may), and one on a phase the
        // board is not calling ready — an act that would change nothing today.
        // Asked here rather than re-derived, because the push category and the
        // chip must agree with this row about which gates are a person's.
        const raises = deriveAttention({
          board: phase.state,
          gate: {
            kind: phase.gateKind,
            clear: phase.gate.clear,
            delegated: plan.gatesDelegated === true,
            approved: phase.gate.approved === true,
          },
        }).some((draft) => draft.kind === 'gate');
        if (!raises) continue;
        out.push({
          kind: 'gate',
          severity: 'needs-you',
          // One gate per phase: the phase IS the subject, so there is nothing
          // left to discriminate on.
          slug: plan.slug,
          phase: phase.phase,
          title: `${plan.slug} phase ${phase.phase} — gate needs a person`,
          need: phase.gate.detail || `The gate on phase ${phase.phase} is not clear (${phase.gate.kind ?? 'none'}).`,
          how: phase.gateCheck
            ? `Do what the gate asks — \`${phase.gateCheck}\` — then approve it on the phase page.`
            : 'Do what the gate asks, then approve it on the phase page under Gate.',
          since: planSince,
          href: phaseHref(plan.slug, phase.phase),
          actions: [
            {
              verb: 'approve',
              label: 'Approve the gate',
              endpoint: planVerb(plan.slug, 'gate', phase.phase),
              method: 'POST',
              body: { approve: true, continueRun: true },
              // `gate-status.md` is read months later by someone reconstructing
              // why a phase was allowed to board. One line of evidence is the
              // difference between a record and a rubber stamp.
              says: { field: 'note', label: 'Evidence (optional)', placeholder: 'what you checked' },
              ...gatedBy('writes', flags.allowWrites),
            },
          ],
        });
      }
    }

    /* ---- qa ---- */
    if (!plan.closed) {
      const mode = plan.qaMode?.mode ?? 'off';
      for (const row of plan.qa ?? []) {
        // BOTH words are guarded by the regime, and `failed` was not (QA round
        // 1, M1). A plan whose gate has since been turned off — `**QA gate:**
        // off`, which resolves to mode `waived` — still carries every verdict
        // it recorded, and those rows gate nobody; raising a `needs-you` row
        // with a live, POST-able Fix & re-QA button over one is asking a person
        // to spend a session on a hold that does not exist.
        const gates = mode === 'on' || plan.qaModes?.[row.phase] === 'on';
        const failed = row.result === 'fail' && gates;
        // A pending verdict additionally asks only when the work it covers is
        // FINISHED — a pending row on a phase nobody has started is the table's
        // resting state, not an ask.
        const pending = row.result === 'pending' && gates && stateOf.get(row.phase) === 'done';
        if (!failed && !pending) continue;
        out.push({
          kind: 'qa',
          // `subject` is the RESULT, so pending → fail re-raises with a new id:
          // the ask genuinely changed, from "give a verdict" to "a verdict was
          // given and it was red", and an ack on the first must not silence the
          // second.
          subject: row.result,
          // Both are `needs-you`, and the owed verdict was the mistake.
          //
          // It was graded `fyi` as "a chore the operator scheduled by turning QA
          // on" — which reads right until you notice what a pending row DOES:
          // `_is_verified` accepts only `pass|waived`, so a pending verdict on a
          // FINISHED phase holds every dependent exactly as hard as a failure,
          // and nothing dispatches QA on its own, so it holds them for ever.
          // The condition above is already the narrow one (QA on, and the phase
          // actually done); only the loudness moves, because the consequence was
          // always this loud. Measured: half of why a real plan was dead sat
          // below forty stale `fyi` rulings.
          severity: 'needs-you',
          slug: plan.slug,
          phase: row.phase,
          title: failed
            ? `${plan.slug} phase ${row.phase} — QA failed`
            : `${plan.slug} phase ${row.phase} — QA verdict owed`,
          need: failed
            ? row.report || 'QA recorded a failure against this phase.'
            : 'A QA verdict — the phase is done, this plan runs QA on, and until one is '
              + 'recorded it holds every phase that depends on it.',
          how: failed
            ? 'Press Fix & re-QA to run the loop again — a fix session carrying this report\u2019s '
              + 'findings, then a fresh review that records the next round. Re-run QA reviews again '
              + 'without a fix session; Waive with a reason records `waived`. Or turn the gate off \u2014 for '
              + 'the plan or for this phase \u2014 from the plan\u2019s QA tab, which writes the directive for you.'
            : 'Press Re-run QA to dispatch the review this gate is waiting for, or Waive with a reason '
              + 'to record `waived`. Fix & re-QA does both, when the phase needs work before it is '
              + 'reviewed. Until a verdict exists, this phase holds every phase that depends on it.',
          since: planSince,
          href: phaseHref(plan.slug, row.phase),
          actions: [
            {
              verb: 'qa-session',
              label: 'Start a QA session',
              endpoint: '/api/terminal',
              method: 'POST',
              // `kind` is NOT optional here, even though the route defaults it.
              // A mint with no kind is a SHELL mint, and a shell mint never
              // reaches parseQaRequest/resolveQa/buildAgentLaunch — it drops
              // `intent` on the floor and hands back a bare `$SHELL -l` while
              // the toast says "done", so the phase goes unreviewed. It is also
              // what makes the gate below true: a claude mint is guarded by
              // `guardAgent` (--allow-agent, the flag the QA launcher names
              // too), a shell mint by --allow-terminal, which this row does not
              // claim.
              body: { kind: 'claude', intent: 'qa', slug: plan.slug, phase: row.phase },
              ...gatedBy('agent', flags.allowAgent),
            },
            // There is deliberately no one-press "Record a verdict" here. There
            // was, and it could not work: the body carried neither `result` nor
            // `report`, both of which `writes.ts` requires, so every press
            // answered with a WriteError — on the one row an operator reaches
            // for when a QA verdict has wedged their plan. It cannot be fixed by
            // filling the fields in either: pass, fail and waived are a
            // judgement, and a button that picks one for you is worse than no
            // button. The verdict form lives on the phase page, which is where
            // `href` points and what `how` now names.
            // The three QA-recovery verbs (issue #11). Before them this row
            // offered one thing — "start a QA session" — which is the right
            // answer to a PENDING verdict and the wrong one to a failed one: a
            // review of unfixed code fails again, and the ladder's own `qa-fix`
            // rung had already spent its caps proving it. `Fix & re-QA` is the
            // loop with settings of its own; `Re-run QA` is the review alone,
            // for a verdict that failed on the environment rather than the
            // work; `Waive` is the decision, and it is the one of the three
            // that carries the operator's own words.
            //
            // Ordered fix → re-review → waive, cheapest BELIEF first: "the work
            // is wrong", then "the review was wrong", then "the finding does
            // not apply". `Fix & re-QA` is offered only on a `fail`, because a
            // pending verdict names no findings for a fix session to read.
            ...(failed
              ? [
                  {
                    verb: 'qa-recover',
                    label: 'Fix & re-QA',
                    endpoint: runVerb(plan.slug, 'qa-recover'),
                    method: 'POST' as const,
                    body: { phase: row.phase },
                    ...gatedBy('run', flags.allowRun),
                  },
                ]
              : []),
            {
              verb: 'qa-rerun',
              label: 'Re-run QA',
              endpoint: runVerb(plan.slug, 'qa-rerun'),
              method: 'POST' as const,
              body: { phase: row.phase },
              ...gatedBy('run', flags.allowRun),
            },
            {
              verb: 'qa-waive',
              label: 'Waive with a reason',
              endpoint: planVerb(plan.slug, 'qa-waive'),
              method: 'POST' as const,
              body: { phase: row.phase },
              // The one action on this row that takes the operator's own words,
              // and it must: a waiver with no reason is a plan forgetting what
              // it decided not to fix. The server refuses one without it.
              says: {
                field: 'reason',
                label: 'Why this is waived',
                placeholder: 'what does not apply, and why',
              },
              ...gatedBy('writes', flags.allowWrites),
            },
            ...(mode === 'on'
              ? []
              : [
                  {
                    verb: 'qa-mode',
                    label: 'Turn QA on for this plan',
                    endpoint: planVerb(plan.slug, 'qa-mode'),
                    method: 'POST' as const,
                    body: { phase: row.phase },
                    ...gatedBy('writes', flags.allowWrites),
                  },
                ]),
          ],
        });
      }
    }

    /* ---- per-plan health ---- */
    for (const issue of plan.issues ?? []) {
      if (issue.severity !== 'error') continue;
      if (ISSUE_KINDS_OWNED_ELSEWHERE.has(issue.kind)) continue;
      // A health row is `plan-broken`'s and nothing else's. The issue list is
      // computed from the plan files alone and cannot see a declaration, so an
      // honest `waiting-external` park showed up here as `stale-handoff` — 92
      // times across 34 runs, the classifier's single most common wrong answer
      // and the reason one sample run sat parked for two days. `situationRaises`
      // asks the fact map, so this guard and the push category cannot drift.
      if (declaredPark.has(`${plan.slug}:${positivePhase(issue.phase) ?? ''}`)) continue;
      const phase = positivePhase(issue.phase);
      out.push({
        kind: 'health',
        severity: 'needs-you',
        subject: issue.kind,
        slug: plan.slug,
        ...(phase != null ? { phase } : {}),
        title: `${plan.slug} — ${issue.kind}`,
        need: issue.message,
        how: 'Fix it in the plan or the handoff, then the board re-reads it on the next change.',
        since: planSince,
        href: phase != null ? phaseHref(plan.slug, phase) : planHref(plan.slug, 'route'),
        actions: [],
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * sign-in
 * ------------------------------------------------------------------ */

/**
 * The machine login, then each console account that is signed out.
 *
 * Never on `authState: 'unknown'` — that is the permanent and CORRECT state of
 * a setup-token account, which exposes no expiry and no refresh. Raising on it
 * would put a row in the inbox that nothing can ever clear.
 *
 * `builtIn` accounts are skipped: the built-in is the synthesized machine
 * login, which `auth` above already speaks for. Raising both is one fact with
 * two ids and two acks.
 */
function signInDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  const queue = facts.queue ?? {};
  const busy =
    (facts.runs ?? []).some((run) => isLiveStatus(run.status)) || (queue.live ?? 0) > 0 || (queue.queued ?? 0) > 0;

  if (facts.auth && facts.auth.loggedIn === false) {
    out.push({
      kind: 'sign-in',
      // Urgent only while something is actually trying to move: a signed-out
      // machine on an idle console is a chore, and the same wall with four
      // lanes queued behind it is a stoppage.
      severity: busy ? 'urgent' : 'needs-you',
      subject: 'machine',
      title: 'Claude is signed out on this machine',
      need: 'A signed-in machine login — nothing starts or resumes under the default account until there is one.',
      how: 'Open a sign-in terminal and run `claude auth login`, or sign a console profile in under Settings ▸ Accounts.',
      // `auth.checkedAt` is when the PROBE ran, not when the sign-out began; it
      // moves on every poll, so using it would make every ack stale at once.
      since: '',
      href: toHash(routeFor('limits')),
      actions: [
        {
          verb: 'login',
          label: 'Open a sign-in terminal',
          endpoint: '/api/auth/login',
          method: 'POST',
          ...gatedBy('run', flags.allowRun),
        },
        { verb: 'recheck', label: 'Check again', endpoint: '/api/accounts/refresh', method: 'POST' },
      ],
    });
  }

  for (const account of facts.accounts ?? []) {
    if (account.builtIn) continue;
    if (account.authState !== 'expired' && account.authState !== 'signed-out') continue;
    const name = account.name || account.email || account.id;
    out.push({
      kind: 'sign-in',
      severity: 'needs-you',
      subject: account.id,
      title: `${name} is ${account.authState === 'expired' ? 'expired' : 'signed out'}`,
      need: 'A signed-in account — a run pinned to this one cannot spawn a session.',
      how: 'Sign it in from Settings ▸ Accounts; the console opens the login in its own config directory.',
      since: '',
      href: toHash(routeFor('limits')),
      actions: [
        {
          verb: 'login',
          label: 'Sign this account in',
          endpoint: '/api/accounts/login',
          method: 'POST',
          body: { accountId: account.id },
          ...gatedBy('accounts', flags.allowAccounts),
        },
        {
          verb: 'recheck',
          label: 'Check again',
          endpoint: '/api/accounts/refresh',
          method: 'POST',
          body: { accountId: account.id },
        },
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * mcp-auth
 * ------------------------------------------------------------------ */

/**
 * `blocksBoarding` — `mcp/health.ts`'s own predicate, reproduced over the view's
 * `status` string.
 *
 * `pending` deliberately does not block: a remote server with a cached tool
 * list reports pending and connects on its first tool call. `unknown` means the
 * probe could not RUN, and "I could not check" is not "they are down" — a probe
 * that could not run must never degrade anything.
 */
const blocksBoarding = (status: string | undefined): boolean => status === 'needs-auth' || status === 'failed';

function mcpDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  // Runs stopped at the MCP preflight — they are what turns a signed-out server
  // from a chore into a stoppage, and they are where `mcp-continue` is offered.
  const parked = stoppedRuns(facts.runs ?? []).filter((run) => run.halt?.kind === 'mcp-preflight');

  for (const server of facts.mcp ?? []) {
    if (!server.enabled) continue;
    const unconfigured = Boolean(server.needsConfig?.length);
    if (!blocksBoarding(server.status) && !unconfigured) continue;
    const label = server.label || server.id;

    out.push({
      kind: 'mcp-auth',
      severity: parked.length ? 'urgent' : 'needs-you',
      subject: server.id,
      title: unconfigured
        ? `${label} is not finished being registered`
        : `${label} ${server.status === 'needs-auth' ? 'needs signing in' : 'is failing'}`,
      need: unconfigured
        ? `Values for ${server.needsConfig!.join(', ')} — until they are set this server can never connect.`
        : server.issue || 'A signed-in MCP server — a phase that names it boards without it, or parks.',
      how: unconfigured
        ? 'Finish the registration under MCP servers: supply the missing values, then re-check it.'
        : 'Sign it in from the MCP servers page, then re-check it. Or let the parked run continue without it.',
      since: '',
      href: toHash('mcp'),
      actions: [
        // No login action when it `needsConfig`: it can never connect, so a
        // sign-in button would be a button that cannot work. A third state, not
        // a variety of `needs-auth`.
        ...(unconfigured
          ? []
          : [
              {
                verb: 'login',
                label: 'Sign this server in',
                endpoint: `/api/mcp/${encodeURIComponent(server.id)}/login`,
                method: 'POST' as const,
                ...gatedBy('mcp', flags.allowMcp),
              },
            ]),
        { verb: 'refresh', label: 'Check again', endpoint: '/api/mcp/refresh', method: 'POST' },
        ...(server.toolsChanged
          ? [
              {
                verb: 'acknowledge',
                label: 'Acknowledge the tool change',
                endpoint: `/api/mcp/${encodeURIComponent(server.id)}/acknowledge`,
                method: 'POST' as const,
              },
            ]
          : []),
        ...parked.map((run) => ({
          verb: 'mcp-continue',
          label: `Continue ${run.slug} without these servers`,
          endpoint: runVerb(run.slug, 'mcp-continue'),
          method: 'POST' as const,
          ...gatedBy('run', flags.allowRun),
        })),
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * lock
 * ------------------------------------------------------------------ */

/**
 * Debris, and only debris.
 *
 * An expired lock is debris by the clock. An UNEXPIRED lock is debris only when
 * the session registry says its own `session=` has ENDED — presence is
 * three-valued and an owner/time match is display, releasing nothing. A foreign
 * unexpired lock whose session is live or unknown is a queue to wait in, and
 * the scheduler already owns that wait; putting it in the inbox would ask a
 * person to break something that is working.
 */
function lockDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};

  // Which locks something is actually queued behind — the difference between
  // "there is debris" and "there is debris and it is in the way".
  const inTheWay = new Set<string>();
  for (const entry of facts.queue?.entries ?? []) {
    for (const holder of entry.waitingOn ?? []) {
      if (holder.kind !== 'lock') continue;
      if (holder.slug && holder.phase != null) inTheWay.add(`${holder.slug}:${holder.phase}`);
    }
  }

  for (const lock of facts.locks ?? []) {
    const key = `${lock.slug}:${lock.phase}`;
    const ended = facts.lockPresence?.[key] === 'ended';
    if (!lock.expired && !ended) continue;
    const blocking = inTheWay.has(key);

    out.push({
      kind: 'lock',
      severity: blocking ? 'needs-you' : 'fyi',
      subject: lock.expired ? 'expired' : 'ended',
      slug: lock.slug,
      phase: lock.phase,
      title: `${lock.slug} phase ${lock.phase} — ${lock.expired ? 'expired lock' : 'lock with no session'}`,
      need: lock.expired
        ? `The lock ${lock.owner} took on this phase has outlived its lease.`
        : `${lock.owner} holds this phase and the session that took it has ended.`,
      how: blocking
        ? 'Release it — a lane is queued behind it and will board as soon as it goes.'
        : 'Release it when you are sure nothing is still working in that phase.',
      // For an expired lock the lease end IS the "waiting since": it is when
      // the claim stopped meaning anything, and it does not move.
      since: lock.expired ? stableSince(lock.leaseUntil) : '',
      href: phaseHref(lock.slug, lock.phase),
      actions: [
        {
          verb: 'release',
          label: 'Release the lock',
          endpoint: '/api/locks/release',
          method: 'POST',
          body: { slug: lock.slug, phase: lock.phase },
          ...gatedBy('writes', flags.allowWrites),
        },
      ],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * stall — nominally in flight, and not moving
 * ------------------------------------------------------------------ */

/**
 * The three verbs that answer a session which has stopped being work.
 *
 * `steer` sends a canned nudge rather than opening a compose box: the row is
 * read on a phone at the top of an inbox, and the useful thing to say to a
 * session that has produced nothing for half an hour is the same sentence
 * every time. Anything more specific is a conversation, and the run page is
 * where conversations happen.
 */
function stallActions(slug: string, phase: number, allowRun: boolean | undefined): InboxAction[] {
  return [
    {
      verb: 'steer',
      label: 'Nudge the session',
      endpoint: runVerb(slug, 'steer'),
      method: 'POST',
      body: {
        phase,
        instruction:
          'You have produced nothing for a while. Say in one line what you are waiting on, then either '
          + 'continue or declare an outcome with scripts/phase-outcome.sh. If a tool call is hung, abandon '
          + 'it and take another route.',
      },
      ...gatedBy('run', allowRun),
    },
    {
      verb: 'freeze',
      label: 'Freeze it where it stands',
      endpoint: runVerb(slug, 'freeze'),
      method: 'POST',
      body: { phase },
      ...gatedBy('run', allowRun),
    },
    {
      verb: 'stop',
      label: `Stop phase ${phase}`,
      endpoint: runVerb(slug, 'stop'),
      method: 'POST',
      body: { phase },
      ...gatedBy('run', allowRun),
    },
  ];
}

/** Whole minutes or whole hours, whichever reads as a sentence. */
function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 90) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * The five ways something is nominally in flight and not moving.
 *
 * The clocks are `STALL_META`'s and are longer than the runner's own detector
 * (`shared/attention-model.js` `STALL_DEFAULTS`), deliberately: the runner
 * notices at ten minutes and announces once, because a notification is cheap
 * and dismissable; the inbox is a list of things a person still owes an
 * answer to, and half an hour is where "it is thinking" stops being the likely
 * explanation.
 *
 * Four of the five have no live session at all — a lock nothing is releasing,
 * a park nothing resumed, a plan nobody has opened, a §Verification that will
 * not finish — so each carries the verb that actually answers IT rather than
 * the three that answer a running session.
 */
function stallDrafts(facts: InboxFacts, now: number): Draft[] {
  const out: Draft[] = [];
  const flags = facts.flags ?? {};
  const after = (kind: keyof typeof STALL_META): number => STALL_META[kind].afterMs;
  const older = (at: string | undefined, ms: number): number | null => {
    if (!at) return null;
    const started = Date.parse(at);
    if (!Number.isFinite(started)) return null;
    return now - started >= ms ? started : null;
  };

  for (const run of facts.runs ?? []) {
    if (run.resolved || run.status === 'finished') continue;
    const live = isLiveStatus(run.status);
    // A frozen lane is silent because the operator stopped it. Every row below
    // is a silence detector, so none of them may speak for one.
    const frozen = frozenPhases(run);
    for (const record of Object.values(run.phases ?? {})) {
      if (!record || !positivePhase(record.phase)) continue;
      if (frozen.has(record.phase)) continue;
      const phase = record.phase;
      const common = { slug: run.slug, phase, runId: run.id, href: phaseHref(run.slug, phase) };

      // 1. Silent. The runner's own signal is the trigger and its `since` is
      //    the clock, so the row and the push cannot disagree about when the
      //    silence began; the longer floor is applied here.
      const silentSince = live && record.status === 'running'
        ? older(record.stall?.signal === 'silent' ? record.stall.since : record.liveness?.lastOutputAt,
          after('session-silent'))
        : null;
      if (silentSince !== null) {
        const open = record.liveness?.openTool?.name;
        out.push({
          kind: 'stall',
          severity: STALL_META['session-silent'].severity,
          subject: 'session-silent',
          ...common,
          title: `${run.slug} phase ${phase} — silent for ${agoText(now - silentSince)}`,
          need: `The session is still running and still spending, and it has produced nothing for ${agoText(now - silentSince)}.`
            + (open ? ` Its oldest open tool call is ${open}.` : ''),
          how: 'Nudge it, freeze it where it stands, or stop this lane. Nothing else is blocked on it — '
            + 'the rest of the run carries on either way.',
          since: new Date(silentSince).toISOString(),
          actions: stallActions(run.slug, phase, flags.allowRun),
        });
      }

      // 1b. Retrying. Same trigger shape as `silent` — the runner's own signal
      //     and its `since` — and a separate row because the remedy is not the
      //     same: nudging a session that cannot reach the API does nothing.
      //     The console's live wall has already applied the run's `onLimit` by
      //     the time this row exists, so it is here BECAUSE that found nowhere
      //     to move the run to.
      const retryingSince = live && record.status === 'running' && record.stall?.signal === 'retrying'
        ? older(record.stall.since, after('session-retrying'))
        : null;
      if (retryingSince !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['session-retrying'].severity,
          subject: 'session-retrying',
          ...common,
          title: `${run.slug} phase ${phase} — retrying for ${agoText(now - retryingSince)}`,
          need: `The session is pinned inside the CLI's own retry watchdog — alive, spending, and unable `
            + `to reach the API for ${agoText(now - retryingSince)}.`
            + (record.stall?.detail ? ` ${record.stall.detail}.` : ''),
          how: "The run's on-limit policy has already looked for an account with headroom and found "
            + 'none, so nudging it will not help — it cannot reach the API. Freeze it to hold the '
            + 'session until the window reopens, stop the lane to release its phase lock, or move the '
            + 'run onto another signed-in account from the run page (that one needs a target this row '
            + 'cannot choose for you).',
          since: new Date(retryingSince).toISOString(),
          actions: [
            {
              verb: 'freeze',
              label: 'Hold it until the window reopens',
              endpoint: runVerb(run.slug, 'freeze'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
            {
              verb: 'stop',
              label: `Stop phase ${phase}`,
              endpoint: runVerb(run.slug, 'stop'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }

      // 2. Queued behind somebody else's lock. Half the runner's own two-hour
      //    cap: past that the wait becomes a halt with a card of its own, so
      //    this one has to arrive while it is still a queue.
      const queuedSince = live ? older(record.lockWaitSince, after('queued-behind-lock')) : null;
      // Who the lane recorded it queued behind, split at the one line that
      // matters: a holder of THIS run is a sibling lane pipelining through a
      // shared scope — the design working, not a stall (seen live: phase 10
      // flagged "another owner's lock" for 88 minutes of waiting on its own
      // run's phase 9). The owner spelling is the scheduler's
      // `autopilotOwner` contract. Absent holders (a record from before the
      // field, or a restart mid-wait) keep the old anonymous row.
      const waitingOn = record.waitingOn ?? null;
      const foreignHolders = waitingOn
        ? waitingOn.filter((holder) => holder.owner !== `autopilot/${run.id}`)
        : null;
      if (queuedSince !== null && !(foreignHolders && foreignHolders.length === 0)) {
        const holder = foreignHolders?.[0] ?? null;
        out.push({
          kind: 'stall',
          severity: STALL_META['queued-behind-lock'].severity,
          subject: 'queued-behind-lock',
          ...common,
          title: holder
            ? `${run.slug} phase ${phase} — queued behind ${holder.slug}`
              + `${holder.phase == null ? '' : ` phase ${holder.phase}`} for ${agoText(now - queuedSince)}`
            : `${run.slug} phase ${phase} — queued behind a lock for ${agoText(now - queuedSince)}`,
          need: holder
            ? `This lane has been waiting on ${holder.owner}'s claim. It is not failing; it is in a queue.`
            : "This lane has been waiting on another owner's phase lock. It is not failing; it is in a queue.",
          how: 'Release the lock if the session that took it is gone, or stop this lane and let the run '
            + 'spend its parallelism somewhere else.',
          since: new Date(queuedSince).toISOString(),
          actions: [
            {
              verb: 'release',
              label: 'Release the lock',
              endpoint: '/api/locks/release',
              method: 'POST',
              // The BLOCKING claim when the lane recorded who holds it — the
              // old body released this lane's own phase, a lock nobody held.
              body: holder && holder.phase != null
                ? { slug: holder.slug, phase: holder.phase }
                : { slug: run.slug, phase },
              ...gatedBy('writes', flags.allowWrites),
            },
            {
              verb: 'stop',
              label: `Stop phase ${phase}`,
              endpoint: runVerb(run.slug, 'stop'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }

      // 3. A park whose resume never fired. The waiting was fine; the ARMING
      //    is what failed, which is why the remedy is Recover and not patience.
      const overdue = record.status === 'waiting'
        ? older(record.parkedUntil, after('park-overdue'))
        : null;
      if (overdue !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['park-overdue'].severity,
          subject: 'park-overdue',
          ...common,
          title: `${run.slug} phase ${phase} — ${agoText(now - overdue)} past its own resume time`,
          need: `This phase parked until ${new Date(overdue).toLocaleString()} and nothing resumed it.`
            + (record.parkReason ? ` It said it was waiting on: ${record.parkReason}` : ''),
          how: 'Recover & continue re-reads the board and re-arms the resume. If the external work it '
            + 'was waiting on is genuinely still going, the phase re-files its wait by itself.',
          since: new Date(overdue).toISOString(),
          actions: [
            {
              verb: 'recover',
              label: 'Recover & continue',
              endpoint: runVerb(run.slug, 'recover'),
              method: 'POST',
              body: { runId: run.id },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }

      // 5. A §Verification that will not finish — the runtime half of lint
      //    F16, which warns at plan time about a check waiting on a clock the
      //    session does not control. Runnable, unfinishable.
      // Gated on the RUN being live, like `silent` and `queued-behind-lock`
      // and unlike `park-overdue`: a halted run's record can still read
      // `verifying` — that is what it was doing when it stopped — and a card
      // saying a check has been running for three hours when nothing is
      // running is an ask nobody can answer. A park, by contrast, belongs to a
      // run that is legitimately not running.
      const hanging = live && record.status === 'verifying'
        ? older(record.verifyingSince, after('verify-hanging'))
        : null;
      if (hanging !== null) {
        out.push({
          kind: 'stall',
          severity: STALL_META['verify-hanging'].severity,
          subject: 'verify-hanging',
          ...common,
          title: `${run.slug} phase ${phase} — verifying for ${agoText(now - hanging)}`,
          need: 'A §Verification command has been running for longer than any check should take. '
            + 'Usually one that waits on an external clock — a `gh run watch`, a `--watch` flag, a long sleep.',
          how: 'Stop this lane, then split the wait out of §Verification behind a Gate-check so the phase '
            + 'can finish and the wait can be declared (F16 warns about this at plan time).',
          since: new Date(hanging).toISOString(),
          actions: [
            {
              verb: 'stop',
              label: `Stop phase ${phase}`,
              endpoint: runVerb(run.slug, 'stop'),
              method: 'POST',
              body: { phase },
              ...gatedBy('run', flags.allowRun),
            },
          ],
        });
      }
    }
  }

  // 4. A plan nobody has touched in a week that still has startable work.
  //    Taken whole from the Insights computation rather than re-derived: two
  //    definitions of "idle" would drift the first time one of them learned
  //    about a new kind of activity.
  const closed = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));
  for (const idle of facts.stalledPlans ?? []) {
    if (closed.has(idle.slug)) continue;
    const plan = (facts.plans ?? []).find((p) => p.slug === idle.slug);
    out.push({
      kind: 'stall',
      severity: STALL_META['plan-idle'].severity,
      subject: 'plan-idle',
      slug: idle.slug,
      title: `${idle.slug} — ${idle.days} days idle with ${idle.ready.length} phase${idle.ready.length === 1 ? '' : 's'} ready`,
      need: `Nothing has touched this plan for ${idle.days} days, and phase`
        + `${idle.ready.length === 1 ? ` ${idle.ready[0]} is` : `s ${idle.ready.join(', ')} are`} startable.`,
      how: 'Start a run, pick the work up by hand, or close the plan if it is not happening — a plan that '
        + 'is not being worked reports no progress, which is the honest thing for it to say.',
      // The plan's own last write. Stable between polls and it moves exactly
      // when the plan does, which is the only moment this ask is new again.
      since: stableSince(plan?.updatedAt),
      href: planHref(idle.slug, 'route'),
      actions: [],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * ruling — a decision worth remembering
 * ------------------------------------------------------------------ */

/**
 * How far back a ruling is still worth a row.
 *
 * A ruling is never resolved and never goes away — the ledger is the record —
 * so without a window every decision a plan ever made would be a row forever.
 * Two weeks is the span over which "somebody should see this happened" is
 * still true; after that it is history, and history is read on the run page.
 */
const RULING_INBOX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One `fyi` row per PHASE with recent rulings — and one row per KEYED ruling.
 *
 * `fyi` and not `needs-you`, because nothing is waiting: a ruling has already
 * been acted on by the session that recorded it. The folded row exists so the
 * decision is SEEN once — acknowledging it is the whole interaction, which is
 * why it carries no action of its own beyond the inbox's own ack.
 *
 * A ruling that names its decision key (`phase-outcome.sh … ruling --needs
 * <key>`) is different: it is an answer somebody could keep. It gets its own
 * row, keyed by the ruling id so the ledger's ack (which `--remember` and the
 * route both append) is the row's ack, with two actions — remember it for the
 * plan (a `## Decisions` row, source `ruling`) and, when its words are an
 * answer this console can hold for the key, remember it on this console
 * (`policy.<key>`). Both go through `POST /api/run/<slug>/rulings/<id>/remember`.
 */
function rulingDrafts(facts: InboxFacts, now: number): Draft[] {
  const closed = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));
  const out: Draft[] = [];
  /**
   * ONE row per phase, not one per ruling.
   *
   * A ruling is a note to a future reader, and a phase that thought carefully
   * writes several. Rendered one-per-ruling they were forty `fyi` rows on a
   * single plan — measured — and the operator's answer to forty rows is to stop
   * reading the list, which costs them the `needs-you` band underneath. The
   * phase is the unit somebody actually navigates to, so it is the unit that
   * asks: the newest ruling is the title, the rest are counted, and the phase
   * page has all of them.
   */
  const byPhase = new Map<string, { slug: string; phase: number; rulings: NonNullable<InboxFacts['rulings']>[number][] }>();

  for (const ruling of facts.rulings ?? []) {
    if (!ruling?.slug || closed.has(ruling.slug)) continue;
    const at = Date.parse(ruling.at);
    if (!Number.isFinite(at) || now - at > RULING_INBOX_WINDOW_MS) continue;
    const phase = positivePhase(ruling.phase);
    if (phase == null) continue;
    if (ruling.decisionKey && ruling.id) {
      out.push(keyedRulingDraft(ruling, phase, facts));
      continue;
    }
    const key = `${ruling.slug}:${phase}`;
    const slot = byPhase.get(key) ?? { slug: ruling.slug, phase, rulings: [] };
    slot.rulings.push(ruling);
    byPhase.set(key, slot);
  }

  for (const { slug, phase, rulings } of byPhase.values()) {
    // Newest first: the title names the most recent decision, which is the one
    // a reader is most likely to be reading about.
    const sorted = [...rulings].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const newest = sorted[0]!;
    const rest = sorted.length - 1;
    const label = RULING_KIND_LABELS[newest.kind as keyof typeof RULING_KIND_LABELS] ?? 'Ruling';
    out.push({
      kind: 'ruling',
      severity: 'fyi',
      // The phase, not a ruling id: the row IS the phase's rulings, and an id
      // that moved to the next ruling would shed the ack every time a session
      // recorded one. "There is something new here" is carried by `since`,
      // which advances past the old ack by the standing `ackFor` rule.
      subject: 'rulings',
      slug,
      phase,
      title: rest > 0
        ? `${slug} phase ${phase} — ${label} and ${rest} more ruling${rest === 1 ? '' : 's'}`
        : `${slug} phase ${phase} — ${label}`,
      need: newest.what,
      how: newest.why
        ? `Why: ${newest.why}${newest.costIfWrong ? ` · If it was wrong: ${newest.costIfWrong}` : ''}`
        : newest.costIfWrong
          ? `If it was wrong: ${newest.costIfWrong}`
          : 'Nothing is waiting on you. Acknowledge it to take it off the list; it stays in the ledger either way.',
      since: new Date(Date.parse(newest.at)).toISOString(),
      href: phaseHref(slug, phase),
      actions: [],
    });
  }
  return out;
}

/** Where a person sets a console-level answer by hand when the row cannot offer it. */
const POLICY_SETTINGS_POINTER = 'to answer it on every plan, set the key under Settings ▸ Automation ▸ Policy answers';

function keyedRulingDraft(
  ruling: NonNullable<InboxFacts['rulings']>[number],
  phase: number,
  facts: InboxFacts,
): Draft {
  const key = String(ruling.decisionKey);
  const label = RULING_KIND_LABELS[ruling.kind as keyof typeof RULING_KIND_LABELS] ?? 'Ruling';
  const endpoint = runVerb(ruling.slug, `rulings/${encodeURIComponent(ruling.id)}/remember`);
  // A relayed answer (phase 14): the one thing worth remembering is the answer
  // itself, as a relay rule — never a `## Decisions` row, whose value is a
  // policy word, and never a console policy answer.
  if (ruling.relay) {
    return {
      kind: 'ruling',
      severity: 'fyi',
      subject: ruling.id,
      slug: ruling.slug,
      phase,
      title: `${ruling.slug} phase ${phase} — a question answered by ${ruling.relay.answeredBy === 'human' ? 'a person' : 'the relay'}`,
      need: ruling.what,
      how: `${ruling.why ? `Why: ${ruling.why} · ` : ''}Remember it to answer "${ruling.relay.answer}" to this question on every run from now on.`,
      since: new Date(Date.parse(ruling.at)).toISOString(),
      href: phaseHref(ruling.slug, phase),
      actions: [{ verb: 'remember-rule', label: 'Remember as a relay rule', endpoint, method: 'POST', body: { scope: 'rule' } }],
    };
  }
  // `global` only when the ruling's own words are an answer the console can
  // hold for the key: a prose ruling on `qa.exhausted` cannot become a
  // `policy.qa.exhausted` word, and an action that would be refused on
  // arrival is a button that lies.
  const holdable = (DECISION_KEYS as readonly string[]).includes(key) && isAnswerWord(key as DecisionKey, ruling.what);
  const actions: InboxAction[] = [
    {
      verb: 'remember-plan',
      label: 'Remember for this plan',
      endpoint,
      method: 'POST',
      body: { scope: 'plan' },
      ...gatedBy('writes', facts.flags?.allowWrites),
    },
    ...(holdable ? [{
      verb: 'remember-global',
      label: 'Remember on this console',
      endpoint,
      method: 'POST',
      body: { scope: 'global' },
    } satisfies InboxAction] : []),
  ];
  const because = [
    ruling.why ? `Why: ${ruling.why}` : '',
    ruling.costIfWrong ? `If it was wrong: ${ruling.costIfWrong}` : '',
    holdable ? '' : POLICY_SETTINGS_POINTER,
  ].filter(Boolean).join(' · ');
  return {
    kind: 'ruling',
    severity: 'fyi',
    // The ruling id, not the phase: the ledger's ack line names this id, and
    // `--remember` / the route append one — so remembering it is what takes
    // the row off the list, on every clone that reads the ledger.
    subject: ruling.id,
    slug: ruling.slug,
    phase,
    title: `${ruling.slug} phase ${phase} — ${label} · ${key}`,
    need: ruling.what,
    how: because || `A ruling on \`${key}\`. Remember it for the plan, or acknowledge it — it stays in the ledger either way.`,
    since: new Date(Date.parse(ruling.at)).toISOString(),
    href: phaseHref(ruling.slug, phase),
    actions,
  };
}

/* ------------------------------------------------------------------ *
 * policy — what the console decided by itself (zero-touch phase 19)
 * ------------------------------------------------------------------ */

/** One answer the policy table gave in a run's name — a `phase.policy-answered` line, or the run's fingerprint of one. */
export type InboxPolicyAnswer = {
  slug: string;
  runId?: string;
  phase: number;
  decisionKey: string;
  answer: string;
  source: string;
  situation?: string;
  label?: string;
  at: string;
};

/** Where an answer came from, in words a row can say (`POLICY_SOURCES`). */
const POLICY_SOURCE_WORDS: Readonly<Record<string, string>> = {
  run: 'the run’s own start answer',
  plan: 'the plan’s `## Decisions` row',
  console: 'this console’s policy answers',
  default: 'the shipped default',
};

/**
 * One `fyi` row per phase and decision key: the newest answer the policy table
 * gave there, inside the same two-week window as a ruling.
 *
 * `fyi`, because nothing is waiting — the console already acted. What the row is
 * for is the other half of "zero touch": a person must be able to SEE the console
 * deciding in their name, what it decided, by whose word, and what the shipped
 * default would have said, so an answer they disagree with is one they can
 * change (Settings ▸ Automation ▸ Policy answers, or the plan's `## Decisions`).
 * One row per key rather than per line, for the rulings' reason: a phase that
 * waived QA three times is one decision, seen once.
 */
function policyDrafts(facts: InboxFacts, now: number): Draft[] {
  const closed = new Set((facts.plans ?? []).filter((plan) => plan.closed).map((plan) => plan.slug));
  const newest = new Map<string, InboxPolicyAnswer & { phase: number }>();
  for (const answer of facts.policyAnswers ?? []) {
    if (!answer?.slug || !answer.decisionKey || closed.has(answer.slug)) continue;
    const at = Date.parse(answer.at);
    if (!Number.isFinite(at) || now - at > RULING_INBOX_WINDOW_MS) continue;
    const phase = positivePhase(answer.phase);
    if (phase == null) continue;
    const key = `${answer.slug}:${phase}:${answer.decisionKey}`;
    const held = newest.get(key);
    if (!held || Date.parse(held.at) < at) newest.set(key, { ...answer, phase });
  }
  return [...newest.values()].map((answer) => {
    const shipped = (POLICY_DEFAULTS as Readonly<Record<string, unknown>>)[answer.decisionKey];
    const shippedWord = shipped == null ? 'none' : typeof shipped === 'string' ? shipped : JSON.stringify(shipped);
    const from = POLICY_SOURCE_WORDS[answer.source] ?? (answer.source || 'an unnamed source');
    return {
      kind: 'policy',
      severity: 'fyi',
      // The key, not the run: one decision per phase, whichever run met it last —
      // a newer answer moves `since`, which is what re-raises an acknowledged row.
      subject: answer.decisionKey,
      slug: answer.slug,
      phase: answer.phase,
      title: `${answer.slug} phase ${answer.phase} — Policy answered · ${answer.decisionKey}`,
      need:
        `The console answered "${answer.answer}" by ${from}${answer.label ? ` (${answer.label})` : ''}`
        + ' — nobody was asked.',
      how:
        `Shipped default for \`${answer.decisionKey}\`: ${shippedWord}. To answer differently, set it under `
        + 'Settings ▸ Automation ▸ Policy answers, or in the plan’s `## Decisions` table.',
      since: new Date(Date.parse(answer.at)).toISOString(),
      href: phaseHref(answer.slug, answer.phase),
      actions: [],
    } satisfies Draft;
  });
}

/* ------------------------------------------------------------------ *
 * health — the console's own
 * ------------------------------------------------------------------ */

/** What an environment issue is called, in words that are not its enum member. */
const ENV_TITLES: Record<string, string> = {
  'path-missing-dir': 'The console PATH names a directory that is gone',
  'path-foreign-home': 'The console PATH points into another account’s home',
  'push-broken': 'Push notifications cannot be delivered',
};

function healthDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  const settings = toHash(routeFor('health'));

  for (const issue of facts.environment ?? []) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: issue.kind,
      title: ENV_TITLES[issue.kind] ?? issue.kind,
      need: issue.detail,
      // Every EnvIssue already carries its own errand sentence. Rewriting it
      // here would be a second copy of an instruction that is version-specific.
      how: issue.fix,
      since: '',
      href: settings,
      actions: [],
    });
  }

  if (facts.watcher && facts.watcher.healthy === false) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: 'watcher',
      title: 'The console has stopped hearing file changes',
      need:
        `A working file watch — ${facts.watcher.watching ?? 0} of ${facts.watcher.expected ?? 0} directories are `
        + 'being watched, so plans and handoffs written outside the console may not appear.',
      how: 'Restart the console — the watch is rebuilt from scratch at boot.',
      since: '',
      href: settings,
      actions: [{ verb: 'restart', label: 'Restart the console', endpoint: '/api/restart', method: 'POST' }],
    });
  }

  // Only while it is still degraded. A healed degradation that stayed in the
  // list would be a row nothing could ever clear, which is precisely how an
  // inbox reaches 182 unread entries.
  if (facts.degraded && facts.degraded.healthy === false) {
    for (const entry of facts.degraded.recent ?? []) {
      out.push({
        kind: 'health',
        severity: 'fyi',
        subject: entry.kind,
        title: `The console degraded — ${entry.kind}`,
        need: entry.message,
        how: 'Check the console log; a restart clears a subsystem that did not recover by itself.',
        since: stableSince(entry.at),
        href: settings,
        actions: [],
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * instance health — a console nobody can reach, and the siblings
 * ------------------------------------------------------------------ */

/**
 * The console's reach and its siblings as work (zero-touch phase 17, FLT-1 iv,
 * FLT-6, R-F1's rule): every row is `needs-you`, because a console that cannot
 * reach a person, or a console that should be up and is not, is exactly the
 * failure an operator finds out about too late — 36 urgent cards once sat in a
 * file only their own console could read, and a second console was down for
 * thirteen hours with nothing reporting it.
 */
function instanceHealthDrafts(facts: InboxFacts): Draft[] {
  const fleet = facts.fleet;
  if (!fleet) return [];
  const out: Draft[] = [];
  const settings = toHash(routeFor('health'));

  const unread = fleet.unread ?? 0;
  if (fleet.delivery && !fleet.delivery.ok && unread > 0) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: 'unread-unheard',
      title: `${unread} notification${unread === 1 ? '' : 's'} nobody was told about`,
      need:
        `A way for this console to reach you — ${fleet.delivery.reason}. Every unread notification here `
        + 'was an announcement that arrived nowhere.',
      how:
        'Subscribe a device (Settings → Notifications, from the phone), set a notifier or register a webhook; '
        + 'then read what was missed in the bell.',
      since: '',
      href: settings,
      actions: [],
    });
  }

  const remote = fleet.remote;
  if (remote && !remote.running) {
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: 'tailscale-stopped',
      title: 'Tailscale is not running — the phone cannot reach this console',
      need:
        `This console answers to ${remote.hosts.join(', ')} only through Tailscale Serve, and Tailscale is `
        + `${remote.detail ? `\`${remote.detail}\`` : 'not running'}.`,
      how: 'Open the Tailscale app and sign in; the console needs no restart.',
      since: '',
      href: settings,
      actions: [],
    });
  } else if (remote && !remote.forOurPort && remote.occupant) {
    const holder = remote.occupant.name
      ? `the console "${remote.occupant.name}" (port ${remote.occupant.port})`
      : `port ${remote.occupant.port}, which no console on this machine claims`;
    out.push({
      kind: 'health',
      severity: 'needs-you',
      subject: 'serve-elsewhere',
      title: 'Tailscale Serve points at another console',
      need: `The phone reaches ${holder}, not this console.`,
      how: 'Settings → Reach this console from your phone names the command that publishes this console without displacing it.',
      since: '',
      href: settings,
      actions: [],
    });
  }

  for (const sibling of fleet.siblings ?? []) {
    if (sibling.liveness === 'orphaned') {
      out.push({
        kind: 'health',
        severity: 'needs-you',
        subject: `sibling-orphaned:${sibling.id}`,
        title: `The console "${sibling.name}" is registered for a directory that is gone`,
        need: `A decision about ${sibling.root ?? 'its root'} — it no longer exists, so that console can never start again.`,
        how: `Forget it: phase-console remove ${sibling.id}. Its state directories are left where they are.`,
        since: '',
        href: settings,
        actions: [],
      });
      continue;
    }
    // Down is work only where up was expected: it died without a clean exit, or
    // a unit that should have brought it back did not — and nobody chose "stay off".
    const crashed = sibling.liveness === 'stopped' && sibling.discrepancies.includes('stale-heartbeat');
    const supervisedDown = sibling.liveness === 'stopped' && sibling.unit && sibling.autostart !== false;
    if ((crashed || supervisedDown) && !sibling.stopMarker) {
      out.push({
        kind: 'health',
        severity: 'needs-you',
        subject: `sibling-down:${sibling.id}`,
        title: `The console "${sibling.name}" is down`,
        need:
          `${crashed ? 'It stopped beating without a clean exit' : 'Its unit should keep it up, and it is not running'}`
          + `${sibling.lastSeenAt ? ` — last seen ${sibling.lastSeenAt}` : ''}; nothing of ${sibling.root ?? 'its project'} is being watched or driven.`,
        how: `Start it: phase-console start ${sibling.id} — or, if it should stay down, Shut down → Stay off from its own Settings.`,
        since: stableSince(sibling.lastSeenAt ?? sibling.stoppedAt ?? undefined),
        href: settings,
        actions: [],
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * conflict — two live branches that would not merge
 * ------------------------------------------------------------------ */

/**
 * Which run owns each radar participant.
 *
 * A participant is a BRANCH NAME, and the radar's participants are every
 * branch with a live checkout — console-managed or not. So a pair can name a
 * run's branch, the operator's own base, or a worktree somebody made by hand,
 * and only the first of those has a remedy the console can offer.
 */
function runsByBranch(git: readonly InboxGit[]): Map<string, InboxGit> {
  const out = new Map<string, InboxGit>();
  for (const entry of git) {
    if (!entry?.branch || out.has(entry.branch)) continue;
    out.set(entry.branch, entry);
  }
  return out;
}

/**
 * The run to serialize: the YOUNGER of the two, and only when serializing it
 * would actually resolve anything.
 *
 * Three conditions, and each one exists because dropping it produces a button
 * that does not work:
 *
 *  1. **BOTH branches must belong to runs.** Serializing means "stop these two
 *     running at the same time", which is only a sentence about two runs. A
 *     pair of `main × pe/alpha` — the operator's own checkout against a run —
 *     conflicts because the branch has diverged, and moving the run into the
 *     shared checkout would put it on the very tree it conflicts with. There
 *     is no remedy here to offer, so none is offered.
 *  2. **The target must be ISOLATED.** `queue` is the only direction
 *     `RunSettingsPatch.isolation` travels (`api/routes.ts` 409s a raise out
 *     loud), so offering the button on a run that already queues would be a
 *     refusal dressed as a remedy. Lowering the one isolated run of the pair
 *     is enough: two `queue` runs whose scopes intersect are serialized by the
 *     scheduler, which is the whole point.
 *  3. **Younger first**, because the older run has been working in its
 *     checkout longer and has more to lose by moving.
 *
 * Deterministic on facts alone: sorted by start clock then slug, last wins. A
 * run with no clock sorts below one that has one, so an unclocked run is only
 * ever chosen when it is the only candidate — the same benefit of the doubt an
 * empty `since` gets everywhere else in this file.
 */
function serializeTarget(pair: { a: string; b: string }, byBranch: Map<string, InboxGit>): InboxGit | undefined {
  const owners = [byBranch.get(pair.a), byBranch.get(pair.b)];
  if (owners.some((run) => !run)) return undefined;
  const candidates = owners.filter((run): run is InboxGit => run!.isolation === ISOLATED);
  if (!candidates.length) return undefined;
  return candidates.sort((x, y) =>
    String(x.startedAt ?? '').localeCompare(String(y.startedAt ?? '')) || x.slug.localeCompare(y.slug),
  )[candidates.length - 1];
}

/**
 * One row per CONFLICTED pair — not per run that can see one.
 *
 * The radar is repository-wide, so two isolated runs of one repository both
 * report the same pair and both reach this function. The card's identity is
 * therefore `(kind, target slug, pairKey)`: `pairKey` is order-independent and
 * the target is a pure function of the pair, so both producers mint the same
 * id and `buildInbox`'s dedupe keeps one row. An id built from "the run that
 * noticed" would have asked the operator the same question twice, from each
 * side.
 *
 * `since` is EMPTY, and that is the honest answer rather than a shortcut: the
 * radar carries a verdict, not a clock, and `RunGitView.at` is when the probe
 * ran — it moves every five minutes, which would make every acknowledgement
 * stale on the next poll (rule 2 in this file's header). An empty `since` sorts
 * the row last inside `needs-you` and its ack never goes stale; what makes a
 * returning conflict read as new is `pruneAcks`, which drops the ack the moment
 * the pair goes `clean` and stops being produced. That is exactly the
 * arrangement `lockDrafts` uses for a lock with no session.
 *
 * There is no dismiss ACTION here on purpose: every row already carries the
 * generic acknowledge control (`client/src/features/now/inbox-row.tsx`), which
 * posts the same `/api/inbox/ack`. A second button would be the same act
 * spelled twice.
 */
/**
 * One row per run that ASKED for its own checkout and was REFUSED (G3).
 *
 * The shape that used to be invisible: the operator ticks "Give this run its
 * own checkout", the preamble refuses by name, and the only witnesses were a
 * journal line and a chip on a page nobody was looking at — while the run
 * queued on scope exactly as if nobody had asked. The row says what was asked,
 * what the console answered, and why, and its one action is the honest one:
 * drop the ask, so the record stops promising what the run does not have.
 *
 * Kind `conflict`, deliberately: the row is about this run CONTENDING for a
 * shared tree, which is the same story the radar's rows tell, and a new kind
 * would be a client-wide vocabulary change for one card style.
 */
function isolationDrafts(facts: InboxFacts): Draft[] {
  const out: Draft[] = [];
  for (const entry of facts.git ?? []) {
    if (entry?.isolation !== ISOLATED || entry.checkout !== 'refused') continue;
    const why = entry.refusalReason
      ?? 'the run root cannot hold an isolated checkout for this plan';
    const draft: Draft = {
      kind: 'conflict',
      severity: 'needs-you',
      subject: `isolation:${entry.slug}`,
      slug: entry.slug,
      href: planHref(entry.slug, 'run'),
      title: `${entry.slug} asked for its own checkout — refused: ${entry.isolationRefusal ?? 'unavailable'}`,
      need: `${why}. The run shares the console's checkout and queues on scope, exactly as `
        + 'before isolation existed.',
      how: 'Fix what the refusal names and Retry the run — or drop the ask, so the run record '
        + 'stops promising a checkout it does not have.',
      since: entry.startedAt ?? '',
      actions: [{
        verb: 'serialize',
        label: 'Drop isolation',
        endpoint: runVerb(entry.slug, 'settings'),
        method: 'POST',
        body: { isolation: 'queue' },
        ...gatedBy('run', facts.flags?.allowRun),
      }],
    };
    out.push(draft);
  }
  return out;
}

function conflictDrafts(facts: InboxFacts): Draft[] {
  const git = facts.git ?? [];
  const byBranch = runsByBranch(git);
  const seen = new Set<string>();
  const out: Draft[] = [];

  for (const entry of git) {
    for (const pair of entry?.radar ?? []) {
      if (pair?.state !== 'conflicted' || !pair.a || !pair.b) continue;
      const key = pairKey(pair.a, pair.b);
      if (seen.has(key)) continue;
      seen.add(key);

      const target = serializeTarget(pair, byBranch);
      const files = [...(pair.files ?? [])];
      const actions: InboxAction[] = target
        ? [{
          verb: 'serialize',
          label: `Serialize ${target.slug}`,
          endpoint: runVerb(target.slug, 'settings'),
          method: 'POST',
          body: { isolation: 'queue' },
          ...gatedBy('run', facts.flags?.allowRun),
        }]
        : [];

      out.push({
        kind: 'conflict',
        severity: 'needs-you',
        subject: key,
        ...(target ? { slug: target.slug } : {}),
        title: `${key} — these branches would not merge`,
        need: files.length
          ? `A real merge conflict is already sitting between them, in ${files.length === 1
            ? files[0] : `${files.length} files: ${files.join(', ')}`}.`
          : 'A real merge conflict is already sitting between them.',
        how: target
          ? `Serialize ${target.slug} — it drops its own checkout, waits its turn in the shared one, `
            + 'and the two stop editing the same files at the same time. Or leave them and resolve the '
            + 'conflict once, when the branches meet.'
          : 'There is nothing to serialize — either one of these branches belongs to no run this '
            + 'console drives, or both runs already queue. Resolve the conflict where the branches '
            + 'are, or stop one of the checkouts.',
        since: '',
        // With no run to move, the Runs page is the only honest destination:
        // it is where every checkout this console knows about is listed, and a
        // plan page would be a claim that one of these branches belongs to a
        // plan when neither does.
        href: target ? planHref(target.slug, 'run') : toHash('runs'),
        actions,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

/**
 * Everything that needs a person, in one list, sorted worst-and-oldest first.
 *
 * Pure: no filesystem, no subprocess, no clock but the `now` it is handed. The
 * caller gathers, this decides, the route performs.
 *
 * `options.all` is not a fact about the world — it is the request's own
 * `?all=1` — which is why it is a third argument rather than a field on
 * `InboxFacts`. Two-argument calls behave as the route's default: acknowledged
 * items are hidden.
 */
export function buildInbox(facts: InboxFacts = {}, now: number = Date.now(), options: InboxOptions = {}): InboxView {
  const drafts = [
    ...errandDrafts(facts),
    ...approvalDrafts(facts),
    ...questionDrafts(facts),
    ...sessionAskDrafts(facts),
    ...planDrafts(facts),
    ...signInDrafts(facts),
    ...mcpDrafts(facts),
    ...lockDrafts(facts),
    ...stallDrafts(facts, now),
    ...rulingDrafts(facts, now),
    ...policyDrafts(facts, now),
    ...conflictDrafts(facts),
    ...isolationDrafts(facts),
    ...healthDrafts(facts),
    ...instanceHealthDrafts(facts),
  ];

  // Dedupe by id, first writer wins. The builders are written so that two
  // drafts with one id cannot happen (see ISSUE_KINDS_OWNED_ELSEWHERE and the
  // `builtIn` skip); this is the belt, because a duplicate id would mean one
  // ack silencing two rows and the operator seeing the same ask twice.
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  for (const draft of drafts) {
    const item = mint(draft);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const ack = ackFor(facts.acks, item.id, item.since);
    if (ack) {
      if (!options.all) continue;
      item.ack = ack;
    }
    items.push(item);
  }

  return { items: sortInbox(items), generatedAt: new Date(now).toISOString() };
}

/**
 * Every id the current facts can produce, acknowledged or not — what
 * `pruneAcks` must be given as its keep-set.
 *
 * A separate pass rather than a flag on `buildInbox` because the route needs
 * both answers from one snapshot: the list to show, and the full id space to
 * prune against. Deriving the second from a filtered first would delete the ack
 * of every item the filter just hid, which is the opposite of what an ack does.
 */
export function inboxIds(facts: InboxFacts = {}, now: number = Date.now()): string[] {
  return buildInbox(facts, now, { all: true }).items.map((item) => item.id);
}

/* ------------------------------------------------------------------ *
 * The acks file
 *
 * Small, written rarely, read at boot: the `mcp/store.ts` shape — synchronous,
 * a `version: 1` envelope, mkdir 0700, temp-then-rename, 0600, and a read half
 * that degrades to empty and warns only on a non-ENOENT error. No debounce:
 * `notifications.ts` needs one because it rewrites a growing log on every
 * announcement; this file is touched when a person presses a button.
 *
 * Every function takes its directory as a parameter so a test never goes near
 * the operator's real state directory — the `launcher.ts` rule, for the same
 * reason. `INBOX_ACKS_DIR` is the one the console actually uses.
 * ------------------------------------------------------------------ */

/** Where the console's own acks live. Per instance, like approvals and push. */
export const INBOX_ACKS_DIR = INSTANCE_STATE_DIR;

const ACKS_FILENAME = 'inbox-acks.json';

/**
 * How many acks the file may hold.
 *
 * An ack is written per press and removed by `pruneAcks` when its item goes
 * away — but a console whose route forgets to prune would grow the file
 * forever, and a JSON file read synchronously at boot is exactly the wrong
 * place for unbounded growth. Oldest go first.
 */
const MAX_ACKS = 2000;

/** An ack this old is dropped even if its item is still asking. Six weeks. */
const DEFAULT_ACK_MAX_AGE_MS = 42 * 24 * 60 * 60 * 1000;

type AcksFile = { version: 1; acks: Record<string, InboxAck> };

export function acksFile(dir: string): string {
  return join(dir, ACKS_FILENAME);
}

/** An unreadable or absent acks file degrades to "nothing is acknowledged". */
export function readAcks(dir: string = INBOX_ACKS_DIR): Record<string, InboxAck> {
  try {
    const parsed = JSON.parse(readFileSync(acksFile(dir), 'utf8')) as AcksFile;
    if (parsed?.version === 1 && parsed.acks && typeof parsed.acks === 'object') {
      const out: Record<string, InboxAck> = {};
      for (const [id, ack] of Object.entries(parsed.acks)) {
        if (!id || !ack || typeof ack.at !== 'string') continue;
        out[id] = typeof ack.by === 'string' && ack.by ? { at: ack.at, by: ack.by } : { at: ack.at };
      }
      return out;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('inbox.acks.unreadable', { error: (error as Error).message });
    }
  }
  return {};
}

function writeAcks(dir: string, acks: Record<string, InboxAck>): void {
  const entries = Object.entries(acks);
  // Oldest first, so the slice keeps the newest MAX_ACKS.
  if (entries.length > MAX_ACKS) {
    entries.sort((a, b) => (Date.parse(a[1].at) || 0) - (Date.parse(b[1].at) || 0));
    entries.splice(0, entries.length - MAX_ACKS);
  }
  const body: AcksFile = { version: 1, acks: Object.fromEntries(entries) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = acksFile(dir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Acknowledge one item — seen, not cleared.
 *
 * `at` is a parameter so a test can stamp one, and because the staleness rule
 * compares it against the item's own `since`: an ack stamped from a clock the
 * caller controls is the only way to test "the thing came back".
 */
export function writeAck(dir: string, id: string, by?: string, at: string = new Date().toISOString()): InboxAck {
  const ack: InboxAck = by ? { at, by } : { at };
  const acks = readAcks(dir);
  acks[id] = ack;
  writeAcks(dir, acks);
  return ack;
}

/**
 * Acknowledge many at once — one read, one write.
 *
 * `writeAck` is read-modify-write-the-whole-file, which is correct for one and
 * wrong for seventeen: the file holds up to 2000 entries, so a bulk press
 * would rewrite it seventeen times and fsync-rename seventeen times to record
 * a change it could have made once.
 *
 * Returns the ack stamped against each id, in the order given, so a caller can
 * report per item instead of one boolean for the batch.
 */
export function writeAckMany(
  dir: string,
  ids: string[],
  by?: string,
  at: string = new Date().toISOString(),
): Record<string, InboxAck> {
  const ack: InboxAck = by ? { at, by } : { at };
  const acks = readAcks(dir);
  const written: Record<string, InboxAck> = {};
  for (const id of ids) {
    acks[id] = ack;
    written[id] = ack;
  }
  if (ids.length) writeAcks(dir, acks);
  return written;
}

/**
 * Un-acknowledge many at once. Answers per id, because "some of them were not
 * acked" is a different fact from "the call failed" and the undo path needs to
 * be able to tell them apart.
 */
export function removeAckMany(dir: string, ids: string[]): Record<string, boolean> {
  const acks = readAcks(dir);
  const removed: Record<string, boolean> = {};
  let touched = false;
  for (const id of ids) {
    const had = id in acks;
    removed[id] = had;
    if (had) {
      delete acks[id];
      touched = true;
    }
  }
  if (touched) writeAcks(dir, acks);
  return removed;
}

/** Un-acknowledge one item. False when there was nothing to remove. */
export function removeAck(dir: string, id: string): boolean {
  const acks = readAcks(dir);
  if (!(id in acks)) return false;
  delete acks[id];
  writeAcks(dir, acks);
  return true;
}

/**
 * Drop acks for items that are no longer asking, and acks that have gone stale
 * with age.
 *
 * This is the second half of the un-ack rule, and it is what makes an ack safe
 * on an item with no clock. An account that is signed out records no WHEN, so
 * `since` is empty and no timestamp comparison can tell a returning sign-out
 * from the one that was acknowledged. Absence can: the item vanished from the
 * build when the account was signed in, its ack was pruned then, and when the
 * account signs out again the item comes back unacknowledged.
 *
 * `keep` must therefore be EVERY id the current facts produce — `inboxIds`,
 * not the filtered list — or pruning would delete the acks of exactly the items
 * the filter hid, un-acking everything on the next request.
 *
 * Returns how many were dropped. Writes nothing when nothing changed.
 */
export function pruneAcks(
  dir: string,
  keep: Iterable<string>,
  options: { maxAgeMs?: number; now?: number } = {},
): number {
  const acks = readAcks(dir);
  const ids = keep instanceof Set ? keep : new Set(keep);
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_ACK_MAX_AGE_MS;

  let dropped = 0;
  for (const [id, ack] of Object.entries(acks)) {
    const at = Date.parse(ack.at);
    const tooOld = Number.isFinite(at) && now - at > maxAge;
    if (ids.has(id) && !tooOld) continue;
    delete acks[id];
    dropped += 1;
  }
  if (dropped) writeAcks(dir, acks);
  return dropped;
}

/** Forget every ack — the reset behind a "clear acknowledgements" control. */
export function clearAcks(dir: string): void {
  try {
    rmSync(acksFile(dir), { force: true });
  } catch (error) {
    log.warn('inbox.acks.unclearable', { error: (error as Error).message });
  }
}

/**
 * The human label of an errand's situation, for a surface that wants to say
 * WHAT kind of stop it was rather than repeat the errand's own sentence.
 * Re-exported from the shared model so a caller needs one import, not two.
 */
export function situationTitle(key: string | undefined): string {
  const { id, sub } = parseSituationKey(key ?? '');
  return situationLabel(id, sub);
}
