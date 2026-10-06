/**
 * `RunnerAttempt` — link 4 of the `Runner` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Runner` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `runner.ts` holds the concrete class.
 */
import { parkOnStep, stepJournalFields } from '../human-steps.ts';
import { KIND_META } from '../../shared/human-step-model.js';
import { comparedClause, stampTrees, type TreeStamp } from './tree-state.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, readVerifyTimeout, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import {
  classify, connectivityBackoffMs, fallbackChain, limitBucket, nextModel, resetWaitUntil, structuredRefusal,
  MAX_AUTO_WAIT_MS, MODEL_FALLBACK, type Disposition, type RetirementEvidence, lostResume,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type SpawnOutcome, type StreamEvent } from './spawn.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import {
  CASCADE_SKIP_REASON, STOPPED_SKIP_REASON, chainMembers, extractCommands, foldCommand, limitWords, resolveLead,
  verificationVerdict, verifyEnvDigest, verifyPhase,
} from './verify.ts';
import {
  appendLedger, BASELINE_NICE, baselineLineWords, cleanTrees, committers, fastGateLines, FAST_GATE_BUDGET_MS, lastCleanHead,
  outputTail, ownerByCommits, ownerFromLedger, readConsoleLedgers, readLedger, resolveVerifyLimit, reusableRun, splitReds,
  verificationsFile, wipAttribution, wipOwners, WHOLE_COMMAND,
  type LedgerRow, type RedRow, type RedShare, type SessionWindow, type WipOwner,
} from './verify-ledger.ts';
import { qaVerdictInstruction } from '../qa-session.ts';
import type { QueueKind } from '../../shared/run-lifecycle.js';
import { closeAttemptWindow, openAttemptWindow, phaseClocks } from '../../shared/phase-clocks.js';
import { OWN_LOCK_WATCH_REFUSAL } from '../../shared/run-lifecycle.js';
import { nextQaRound, qaReportPath, parseQaHistory } from '../qa-round.ts';
import {
  DEFAULT_QA_ROUND_BUDGET_USD, qaExhaustedErrand, qaFixInstruction, readQaFindings, releasesGate,
  roundBudgetUsd, type QaFixStrategy, type QaRecoverVerb,
} from './qa-recover.ts';
import { policyForKey } from './policy.ts';
import { capsFor, lastWords, phaseCaps, raiseCap, type Cap, type SessionCaps } from './session-record.ts';
import { CONNECTIVITY_PROBE_MS } from '../connectivity-probe.ts';
import {
  evaluateWait, openWaitEntry, parkedMsOf, spendsWaitBudget, WAIT_FLOOR_MS, waitApproaching, waitBudgetFact,
  type WaitAuthor, type WaitBudget,
} from './wait-budget.ts';
import { backstopOf, pollableRefs, unpollableRefs } from '../watch-refs.ts';
import { RESUME_REFUSED_RECHECK_MS, declaredClock, ordinalSuffix, type DeclaredClock } from './wait-budget.ts';
import { closeoutSkipNote, outageResumePrompt, reboardResumeBrief, resumePolicyInstruction, resumePolicyWhy, type VettedResume, LOCK_MIRROR_ENV } from './runner-core.ts';
import type { ResumePolicy } from './usage.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, attemptSignals, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds, mintWatchRef,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import { isPaperwork, judgeProofs, proofsFile, type ProofJudgement } from './proofs.ts';
import {
  BORROWED_DEPS, commitOf, commitsBetween, exportCheckout, filesCommittedBetween, filesCommittedSince, inHistory,
  settleIdleMirrorBranches, treeChanges, uncommittedPaths, workingTreeOf, type ExportCheckout,
} from './worktree.ts';
import {
  classifySituation, collectEvidence, declaredSubKind, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, endedOnEnvironment, errandFor, nextRung, rungKey, rungsFor, settleRung, DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type {
  InheritedRed, OwedRed, RungRecord, VerifyBaseline, VerifyExport, VerifyingLane, VerifyLimitSource, VerifyRun, WipRed,
} from './state.ts';
import {
  childrenOf, consumeDeclaration, DECLARATION_CONSUMED_EVENT, endLockWait,
  loadRun, newRun, phaseRecord, procIdentity, saveRun, pidAlive, processState, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, resetStreak, streakSentence, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type QaRoundRecord, type RunStatus, type VerifySummary, clearWatchBookkeeping, isSessionGone,
  syncWaitClock, chargeDeclaration, DECLARATION_REFUSED_EVENT, type DeclarationCharge, prepareReboard,
  setRunState, failureRootOf, THIS_CONSOLE,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome, needsOf } from './outcome.ts';
import { PLAN_APPROVAL_NEED } from './plan-approval.ts';
import {
  AdmissionAborted, autopilotOwner, errandFoldTarget, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope } from '../../shared/scope.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, PINNED_CAPACITY_RETRY_MS, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TAIL_CHARS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import type { Runner } from './runner.ts';
import { RunnerLoop } from './runner-loop.ts';
import { allLeadsMissingPark, approvalsForPhase, reviewPhase } from './verify-review.ts';
import type { VerifyApprovals } from './verify.ts';
import { withSpan } from '../trace.ts';


/**
 * How many times one boarding may swap its brief in place before the old
 * re-board takes over (control-tower phase 86, #134) — a swap is a fresh
 * session each time, and three in one lane is a loop, not a change of brief.
 */
const MAX_REBRIEFS = 3;

/**
 * The flag that asks a person (control-tower phase 111, #177): the first two
 * are answered by a fresh session, or the next model where the policy lets the
 * phase step down; the third is a person's.
 */
export const SAFEGUARD_FLAGS_BEFORE_PERSON = 3;

/** The resume brief's words for a phase boarded fresh after a safeguard flag. */
function safeguardInstruction(flag: { classifier?: string; requestId?: string }, flags: number): string {
  return `The API's safeguards flagged the last session's message${flag.classifier ? ` (classifier ${flag.classifier})` : ''}`
    + `${flag.requestId ? `, request ${flag.requestId}` : ''} — a false positive is likely, and resuming that conversation `
    + 'would re-send it, so this is a FRESH session. Read the handoff, the working tree and the journal, then carry the '
    + `phase on from where it stopped${flags > 1 ? '. It has happened twice: if one step keeps tripping it, take that step another way' : ''}.`;
}

/** "two fresh sessions were tried" · "a fresh session and sonnet were tried" — what a person is told. */
export function triedSentence(tried: readonly string[]): string {
  if (!tried.length) return 'nothing was tried';
  if (tried.every((t) => t === 'a fresh session')) {
    return tried.length === 1 ? 'a fresh session was tried' : `${tried.length === 2 ? 'two' : tried.length} fresh sessions were tried`;
  }
  return `${tried.length === 1 ? tried[0] : `${tried.slice(0, -1).join(', ')} and ${tried[tried.length - 1]}`} `
    + `${tried.length === 1 ? 'was' : 'were'} tried`;
}

/** What an attempt is handed beside its prompt (see `attempt`). */
export type AttemptOptions = {
  maxTurns?: Cap;
  mcp?: McpResolution;
  /** The resume the boarding's gate already vetted for this session — asked once, never again (#134). */
  vetted?: VettedResume;
  /**
   * The boarding's composer, for a brief swapped IN PLACE: given the resume
   * hint, it answers the whole prompt (brief + directives) this lane spawns
   * next. Absent, a not-worth-resuming session re-boards the phase as before.
   */
  rebrief?: (hint: BoardingHint, why: { sessionId: string; why: string; unspawned: boolean }) => Promise<string>;
};

/** An attempt's ending; `rebrief` asks `attempt` to swap the brief and go on in the same lane. */
type AttemptResult = {
  carryOn: boolean; completed: boolean;
  rebrief?: { policy?: ResumePolicy; instruction?: string; why?: string; sessionId: string; unspawned: boolean };
};

/**
 * Where `dir` sits inside the repository whose toplevel git named as `top` —
 * both resolved first: git answers with the REAL path, a caller may hold a
 * symlinked one (`/var/…` for `/private/var/…` on macOS), and the relative
 * path between the two spellings climbs out of any checkout it is joined to.
 */
/**
 * How often a baseline command asks the machine-load guard again while it
 * holds new work back, and the most it will wait for one command
 * (control-tower phase 105).
 */
const BASELINE_LOAD_POLL_MS = 30_000;
const BASELINE_LOAD_WAIT_MAX_MS = 30 * 60_000;

/** One baseline as it is planned and measured (control-tower phase 105) — see `takeBaseline`. */
type BaselineJob = {
  phase: number;
  text: string;
  commands: string[];
  setupText?: string;
  approvals?: VerifyApprovals;
  /** Where its commands run: a clean checkout of the boarding head, or the tree in place. */
  cwd: string;
  exported: boolean;
  /** The working-tree directory an export stands in for (`VerifyOptions.inPlace`, control-tower phase 106). */
  inPlace?: string;
  base: { top: string; tree: string; head: string | null } | null;
  /** The reuse key's other two halves: the environment digest and the directory within the repository. */
  env: string;
  dir: string;
  /** Every ledger row of this console, read once. */
  rows: LedgerRow[];
  at: string;
  lines: VerifyBaseline['commands'];
};

/**
 * The baseline's result as the session's next turn (control-tower phase 105,
 * BL-3) — information from the console, explicitly not an instruction: it
 * changes nothing the phase must do, and says so, as a peer's message does.
 */
export function frameBaselineNote(baseline: VerifyBaseline, mark: string): string {
  // A line the machine stopped (a dependency not installed, a sibling the
  // export lacks) is not a red the session inherits (control-tower phase 106).
  const red = baseline.commands.filter((line) => !line.ok && !line.environment);
  const stopped = baseline.commands.filter((line) => !line.ok && line.environment);
  const lines = baseline.commands.map((line) => {
    const failing = !line.ok && line.failures?.length ? ` — ${line.failures.slice(0, 5).join('; ')}` : '';
    const name = line.chain ? `\`${line.command}\` (member of \`${line.chain}\`)` : `\`${line.command}\``;
    // What a red line SAID (#195): the end of its output, as the verdict's red carries it.
    const tail = !line.ok && line.tail
      ? `\n  ${line.tail.split('\n').slice(-BASELINE_NOTE_TAIL_LINES).join('\n  ')}`
      : '';
    return `- ${name}: ${baselineLineWords(line)}${failing}${tail}`;
  });
  return `${mark} A note from the console, not an instruction: your phase's §Verification BASELINE is in — `
    + `what its lines read on the tree you boarded on, before your work, measured beside you in a clean checkout. `
    + (red.length
      ? `${red.length} of ${baseline.commands.length} line(s) were already red there. A red that was there first is inherited: `
        + 'it is not charged to you, and your verification is compared against this when you finish. '
      : stopped.length ? ''
        : `All ${baseline.commands.length} line(s) were green there, so a red at your finish is yours. `)
    + (stopped.length
      ? `${stopped.length} line(s) could not run there at all — the machine, not the work; each says why below `
        + '(for a dependency that is not installed: install the dependencies — that is a `- **Setup:**` line\'s job). '
      : '')
    + `No reply is needed; carry on with your phase.\n\n${lines.join('\n')}`;
}

/** How many of a red line's last output lines the session's baseline note quotes. */
const BASELINE_NOTE_TAIL_LINES = 6;

/**
 * Is this uncommitted path WORK that is not the verifying phase's own — a
 * reason to verify on a clean export rather than in place (control-tower phase
 * 89) — or the machine's own litter (control-tower phase 106, #191)? Never
 * foreign: the phase's own writes, anything inside a dependency directory
 * (`node_modules`, `.venv`, `venv`), an untracked path no phase's session wrote
 * (a test run's compile cache, an installer's output), and an untracked path
 * whose first component the phase's own `Setup:` names (its `data` symlink).
 * ai-builder-v7's app-backend was exported — and its cross-repo gate made red
 * — by exactly those last two. A tracked change, or an untracked file another
 * phase's session wrote that no Setup names, still is.
 */
export function isForeignWip(path: string, owner: WipOwner, untracked: boolean, setupText?: string): boolean {
  if (owner === 'self') return false;
  if (path.split('/').some((part) => BORROWED_DEPS.has(part))) return false;
  if (!untracked) return true;
  if (owner === null) return false;
  const head = path.split('/')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !(setupText && new RegExp(`(?:^|[^\\w.-])${head}(?:$|[^\\w.-])`).test(setupText));
}

function withinRepo(top: string, dir: string): string {
  const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const rel = relative(real(top), real(dir));
  return rel.startsWith('..') ? '' : rel;
}

export abstract class RunnerAttempt extends RunnerLoop {

  /**
   * Run the phase until it either finishes or the error policy says to stop.
   * Every disposition from `classify` is handled here and nowhere else.
   */
  /**
   * The phase's session, with a before/after artefact scan around it.
   *
   * A thin wrapper rather than a scan at each of the inner function's many
   * exits: the register must be written however the attempt ends — a clean
   * finish, a halt, a throw — because the worktree a session made outlives all
   * three, and it was the CRASHED ones that left the trees nobody could find.
   * One scan per attempt cycle, not per retry.
   */
  protected async attempt(
    phase: number, prompt: string, model: string, owner: string, lane: Lane,
    chosen: PhaseOptions = {}, opts: AttemptOptions = {},
  ): Promise<{ carryOn: boolean; completed: boolean }> {
    const before = await this.artefactScan(phase);
    try {
      // A change of brief under the grant this lane holds (control-tower phase
      // 86, #134): the session the attempt would continue is not worth
      // resuming — a resume-checkpoint verdict, an account switch, an outage —
      // so the boarding's own composer builds the resume brief and the attempt
      // goes on HERE, in the same lane. It used to re-board the phase, which
      // released the grant; a sibling queued seconds earlier took the lane.
      let current = prompt;
      let vetted = opts.vetted;
      for (let swaps = 0; ; swaps++) {
        const swappable = Boolean(opts.rebrief) && swaps < MAX_REBRIEFS;
        if (swappable) this.rebriefing.add(phase);
        let settled: AttemptResult;
        try {
          // The phase's own span, inside the run's. Everything below it — the
          // session spawned, the git it runs, the bash scripts that session
          // calls — inherits the phase number and the attempt, so a line found
          // on its own says which retry of which phase produced it. The attempt
          // is stated here and nowhere else: a retry is a new attempt inside one
          // run, and that distinction is exactly what a reader of a failed
          // phase needs.
          settled = await withSpan(
            'phase.attempt',
            { phase, attempt: (this.state?.phases?.[phase]?.attempts ?? 0) + 1 },
            () => this.attemptSession(phase, current, model, owner, lane, chosen, { ...opts, vetted }),
          );
        } finally {
          this.rebriefing.delete(phase);
        }
        if (!settled.rebrief) return settled;
        const { policy, instruction, why, sessionId, unspawned } = settled.rebrief;
        current = await opts.rebrief!(reboardResumeBrief(instruction ?? resumePolicyInstruction(policy!, sessionId)), {
          sessionId, why: why ?? resumePolicyWhy(policy!), unspawned,
        });
        vetted = undefined;
      }
    } finally {
      await this.noteArtefacts(before, phase);
    }
  }

  /** The phases whose attempt can swap its brief in place right now — see `attempt`. */
  private readonly rebriefing = new Set<number>();

  /**
   * The attempt's own session again, for an attempt that carries on in place —
   * an account switch, a model's window, a spent cap — through the one gate, as
   * every `--resume` goes. Without `port`, a transcript under another account is
   * not carried over (a fresh boot is what those paths always chose); a session
   * that is gone is never offered again. `notWorth` is the gate's `fresh`: the
   * session is there and resuming it would write its whole context again, and
   * the caller hands the phase to `reboardNotWorth` rather than going on here.
   */
  private resumeAgain(record: PhaseRecord, opts: { port?: boolean } = {}): { resume?: VettedResume; notWorth?: ResumePolicy } {
    if (!record.sessionId) return {};
    if (!opts.port && !this.transcriptFollows(record)) return {};
    const gate = this.resumableSession(record, record.sessionId);
    if (gate.ok) return { resume: gate.resume };
    return gate.why === 'fresh' && gate.policy ? { notWorth: gate.policy } : {};
  }

  /**
   * End this attempt and have the phase boarded fresh with the resume brief,
   * because the session it would continue in place is not worth resuming
   * (autopilot-token-drain phase 4). Not a fresh spawn here: this attempt's
   * prompt may be a continuation — a `continue` brief, a wait-resume — that
   * means nothing to a session with no context, and only the drive loop's
   * boarding composes the boot prompt with the brief. The same re-board the
   * context checkpoint makes (`Runner.noteContext`).
   */
  private reboardNotWorth(
    phase: number, record: PhaseRecord, policy: ResumePolicy, sessionId = record.sessionId ?? 'unknown',
    opts: { unspawned?: boolean } = {},
  ): AttemptResult {
    // The lane holds its grant and its boarding can compose the resume brief
    // (control-tower phase 86, #134): the brief is swapped in place by
    // `attempt`, and nothing here gives the lane back.
    if (this.rebriefing.has(phase)) {
      record.resumeSessionId = undefined;
      return { carryOn: true, completed: false, rebrief: { policy, sessionId, unspawned: Boolean(opts.unspawned) } };
    }
    prepareReboard(record);
    record.resumeSessionId = undefined;
    const hint: BoardingHint = reboardResumeBrief(resumePolicyInstruction(policy, sessionId));
    record.boardingHint = hint;
    record.note = `session ${sessionId} is not worth resuming — ${resumePolicyWhy(policy)} — `
      + 'the next attempt boards fresh with the resume brief';
    this.record('phase.reboard-requested', {
      situation: hint.situation, rung: hint.rung, brief: hint.brief, by: 'console',
    }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status, note: record.note });
    return { carryOn: true, completed: false };
  }

  /**
   * End this attempt and have the phase boarded FRESH with the resume brief
   * carrying `instruction` — never `--resume` of the session that just ended
   * (control-tower phase 111, #177: a flagged conversation re-sends the
   * flagged message). In place when the lane can swap its brief, else through
   * the boarding hint, exactly as `reboardNotWorth` does.
   */
  private reboardFresh(phase: number, record: PhaseRecord, instruction: string, why: string): AttemptResult {
    const sessionId = record.sessionId ?? 'unknown';
    record.resumeSessionId = undefined;
    if (this.rebriefing.has(phase)) {
      return { carryOn: true, completed: false, rebrief: { instruction, why, sessionId, unspawned: false } };
    }
    prepareReboard(record);
    const hint: BoardingHint = reboardResumeBrief(instruction);
    record.boardingHint = hint;
    record.note = `session ${sessionId} ${why} — the next attempt boards fresh with the resume brief`;
    this.record('phase.reboard-requested', {
      situation: hint.situation, rung: hint.rung, brief: hint.brief, by: 'console',
    }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status, note: record.note });
    return { carryOn: true, completed: false };
  }

  /**
   * The session this phase would resume is still running (REG-1): board nothing.
   * The phase waits on a short re-check clock with the session to resume and its
   * declaration intact, the lane gives its lock back, and the next boarding asks
   * the gate again — so the resume happens once that session ends, and never on
   * top of it. The refusal itself was recorded and announced by the gate.
   */
  private holdForLiveSession(phase: number, sessionId: string): { carryOn: boolean; completed: boolean } {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    record.resumeSessionId = sessionId;
    record.status = 'waiting';
    const until = new Date(Date.now() + RESUME_REFUSED_RECHECK_MS).toISOString();
    record.parkedUntil = until;
    syncWaitClock(state);
    record.note = `session ${sessionId} is still running — the console resumes it once that session ends`;
    this.armParkPoke(phase, until);
    this.emit('phase', { phase, status: 'waiting', note: record.note, parkedUntil: until });
    this.persist();
    return { carryOn: true, completed: false };
  }

  /**
   * Start this attempt's liveness (control-tower phase 80, #99): a fresh
   * accumulator stamped with the attempt, and the record's snapshot moved with
   * it — the snapshot is what a checkpoint and every watchdog read, and it kept
   * the dead session's clocks until the new one wrote. A stall the dead session
   * left ends here, the way `endLaneStall` ends one with its lane: the episode
   * was that process's, and the one about to start has said nothing yet.
   * `stalemate` stays, as it does there — it is about the phase.
   */
  private freshAttemptLiveness(phase: number, lane: Lane, record: PhaseRecord): void {
    const previous = lane.signals;
    const was = previous.stall ?? record.stall ?? null;
    const ended = was && was.signal !== 'stalemate' ? was : null;
    lane.signals = attemptSignals(previous, this.now().getTime(), record.attempts);
    // The git evidence is this attempt's too: the next tick reads it afresh.
    lane.gitAt = undefined;
    record.liveness = livenessOf(phase, lane.signals, stallThresholds(this.deps.stallThresholds?.()));
    if (!ended) return;
    delete record.stall;
    delete lane.localNudgeRefused;
    delete lane.automaticParkDeclined;
    this.record('phase.liveness', { cleared: ended.signal, reason: 'new-attempt', attempt: record.attempts }, phase);
    this.emit('liveness', { phase, liveness: record.liveness, stall: null, attempt: record.attempts });
  }

  /**
   * Where a lane goes once the API answers again (control-tower phase 80, #108)
   * — decided BEFORE anything boards. The board first: a phase whose handoff
   * went in complete before the network went is closed out through the same
   * `completed` path a clean ending takes (§Verification, the landing, the
   * lock), and no session boots over it — measured, a full "start Phase 21"
   * boot re-claimed a finished phase's lock and reset its task list. Otherwise
   * the session that lost the API is resumed through the one gate when it has a
   * conversation to go back to; one that never reached the API boards fresh
   * from its self-contained boot prompt, as it always did. An unreadable board
   * is no evidence that a phase finished, so it reads as "not done".
   */
  private async afterOutage(
    phase: number, record: PhaseRecord, conversation: boolean,
  ): Promise<
    | { next: 'closeout' } | { next: 'resume'; resume: VettedResume }
    | { next: 'reboard'; policy: ResumePolicy } | { next: 'fresh' }
  > {
    let done = false;
    try {
      const board = await this.board();
      done = board.phased && !board.timedOut && !board.error && board.done.includes(phase);
    } catch {
      done = false;
    }
    if (done) return { next: 'closeout' };
    if (!conversation) return { next: 'fresh' };
    const again = this.resumeAgain(record);
    if (again.notWorth) return { next: 'reboard', policy: again.notWorth };
    return again.resume ? { next: 'resume', resume: again.resume } : { next: 'fresh' };
  }

  private async attemptSession(
    phase: number, prompt: string, model: string, owner: string, lane: Lane,
    chosen: PhaseOptions = {}, opts: AttemptOptions = {},
  ): Promise<AttemptResult> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    let currentModel = model;
    // A freeze that was checkpointed left a session behind. Picking it up costs
    // one flag here and saves however long the phase had already been working;
    // cleared immediately, because offering the same id to a second attempt is
    // the "Session ID … is already in use" refusal.
    let resume: VettedResume | undefined;
    const asked = record.resumeSessionId;
    if (asked && opts.vetted?.sessionId === asked) {
      // The boarding asked the gate for exactly this session and was told yes
      // (control-tower phase 86, #134): that verdict is this attempt's. Asking
      // again a second later once answered differently, and the second answer
      // re-boarded a phase that already held its lane.
      record.resumeSessionId = undefined;
      resume = opts.vetted;
    } else if (asked) {
      record.resumeSessionId = undefined;
      this.record('phase.resume-checkpoint', { sessionId: asked }, phase);
      // The one gate (`resumableSession`), BEFORE anything spawns — this site
      // kept its own copy of half of it, and that copy never read the gone
      // stamp, so a refused id was spawned again on the busiest path (SLF-10).
      // Gone or unported boards fresh: the boot prompt is self-contained by
      // design. A session still RUNNING is not boarded at all (REG-1).
      const gate = this.resumableSession(record, asked);
      if (gate.ok) resume = gate.resume;
      else if (gate.why === 'session-live') return this.holdForLiveSession(phase, asked);
      // Not worth resuming — the boarding asks first and composes the brief, so
      // this is the backstop: this prompt may be a continuation, so re-board.
      else if (gate.why === 'fresh' && gate.policy) return this.reboardNotWorth(phase, record, gate.policy, asked, { unspawned: true });
    }
    // The two caps this phase's sessions run under, each with the policy that
    // set it (SES-8): the run's own budget or the plan's size for the dollars,
    // the size for the turns — or, for a wait-resume and a closeout brief, the
    // closeout's turn cap the boarding chose. A cap the CLI reports spent is
    // doubled below for the resume that carries on.
    let caps = capsFor({
      mode: 'phase', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd,
      ...(opts.maxTurns ? { turns: opts.maxTurns } : {}),
    });
    // The per-model walls this phase met, first first: when the whole chain
    // is limited, the FIRST model's reset is the one worth waiting for. Once
    // per phase — a second exhaustion after that wait halts as it always did.
    const modelWalls: { model: string; at: Date }[] = [];
    let modelWindowWaited = false;
    // Outages met on this phase, and the time already spent waiting them out.
    // Neither is an attempt — a session that never reached the API did not try
    // the work — so the arm gives the attempt back and the budget is what
    // bounds the loop instead.
    let outages = 0;
    let outageWaitedMs = 0;
    // What the NEXT spawn is told instead of `prompt`, once: a session resumed
    // after an outage is mid-phase and gets a continuation, not a start boot.
    let promptOnce: string | undefined;
    // Set when the attempts ran out on the WEATHER — half a day unreachable, or
    // every retry dying before its first turn — so the ending below is offered
    // to the streak as `connectivity`, which it does not count (phase 45).
    let environmental = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A per-lane stop can land between attempts — during a retry backoff, a
      // usage-window sleep, or before the first spawn. Consume it here or the
      // next iteration starts a session for a phase the operator already ended.
      if (lane.stopped) return this.settleStoppedLane(lane, phase, 'spawn');
      record.attempts++;
      // #28: this session's own window — what `workedMs` (= `durationMs`) sums.
      openAttemptWindow(record, record.attempts, this.now().toISOString());
      // #99: and its own liveness. The lane outlives its attempts; the clocks
      // the stall detector judges belong to the process about to start.
      this.freshAttemptLiveness(phase, lane, record);
      const scope = lane.grant?.scope ?? await this.scopeFor(phase);
      // The claim this session makes about where its work rides — both
      // dimensions, or neither when the scope lives outside the run root
      // (`RunnerBase.qualificationFor`); the same answer admission weighed.
      const claim = this.qualificationFor(phase, scope);
      const sessionPrompt = promptOnce ?? prompt;
      promptOnce = undefined;
      // The account this session will spend, stamped as it is asked for
      // (control-tower phase 92): a later boundary switch moves the run, not it.
      lane.accountId = state.accountId ?? 'default';
      const outcome = await this.spawnSession(phase, 'phase', {
        prompt: sessionPrompt,
        // The lane's own worktree when this plan opted into them, the shared root
        // otherwise. One line, because a lane worktree IS just a different cwd —
        // the branch, the merge-back and the prune are the runner's business
        // (`runner/worktree.ts`), and nothing about spawning changes.
        cwd: this.laneRoot(phase),
        addDirs: this.addDirsFor(phase),
        model: currentModel,
        effort: record.effort ?? state.effort,
        // Fail over in-place, keeping the session. The `switch-model`
        // disposition below can only restart the phase from its boot prompt,
        // discarding however long it had been working — so it is the second
        // line of defence, not the first.
        // …unless the run's model is PINNED (#91): then nothing below it is
        // offered, and a wall is an account's or a clock's problem, never a
        // reason to run a weaker model.
        fallbackModels: this.modelPolicyOf(phase) === 'pinned' ? [] : fallbackChain(currentModel),
        // Legible in `/resume` and `claude agents`, which matters when the
        // question is "what is this hours-old session on my machine?".
        name: `${state.slug} p${phase}`,
        // Deliberately not `record.sessionId`. That is the id of a session that
        // has already run; handing it back as `--session-id` asks the CLI to
        // create a session that exists, and it refuses — "Session ID … is
        // already in use", which is what killed two real retries. A new attempt
        // gets a new id; continuing an existing one goes through `resume`.
        resumeFrom: resume,
        settings: this.settingsPath ?? undefined,
        // A mechanical phase can run with a small tool set and no MCP servers:
        // less blast radius, and a smaller system prompt to pay for every turn.
        tools: chosen.tools?.length ? chosen.tools : undefined,
        // Rewritten per attempt, not per run: a credential changed between
        // attempts has to reach the retry, and the file costs a JSON write.
        // Absent means "attach nothing", which leaves the machine's own MCP
        // configuration in place — what every run did before this existed.
        //
        // WHICH servers, though, is the boarding's answer and not re-derived
        // here: the set was probed once, named to the model once, and a second
        // resolution could silently hand the session a server its prompt says
        // is unavailable.
        mcpConfig: (await this.armMcp(phase, chosen, opts.mcp)) ?? undefined,
        // Only when the phase asked for servers and got none of them. See
        // `resolveMcp`: an emptied set still has to be a CLOSED set.
        ...(opts.mcp?.strict ? { strictMcp: true } : {}),
        permissionMode: chosen.permissionMode as never,
        // Read fresh each attempt, so a profile changed mid-run is in force for
        // the next phase rather than for the next run.
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => {
          lane.handle = handle;
          // A new process, a new pipe (control-tower phase 109, #170).
          delete lane.inputClosed;
          this.syncMirror();
          // A baseline that landed before this session could hear it is told now.
          this.flushBaselineNote(lane.phase);
        },
        // The child must know it IS the lock holder. Without this the runner
        // claims the phase as `autopilot/<runId>`, the session it spawns reads
        // a lock owned by a stranger, and — correctly, per the skill's own
        // guardrail — refuses to touch the phase rather than force it. The
        // supervisor deadlocks against its own worker. Sharing PE_OWNER makes
        // phase-lock.sh report the lock as the session's own, so it refreshes
        // instead of stopping, while everyone else still sees it held.
        //
        // PE_SCOPE rides along for the same reason one level up: the session
        // claims its own lock, and a claim that names no scope writes a lock
        // every other reader has to treat as colliding with everything.
        // All four claim fields, from the one helper every spawn site uses
        // (LCK-6). The owner is this attempt's, which is not always the run's:
        // `phase-lock.sh` reports the lock as the session's own so it refreshes
        // rather than stopping, while every other reader still sees it held.
        // The tree and the branch are `qualificationFor`'s answer — both, or
        // NEITHER for a scope the run root does not contain, because a pair
        // describing a tree the session never edits is worse than no pair.
        env: await this.sessionEnv({
          ...(await this.claimEnv(phase, { owner, scope })),
          // How this session reaches a PEER (5.1.0): the plan's mailbox and this
          // run's bearer, from the one helper, so a site cannot state the
          // ledger and forget the token.
          ...this.messagingEnv(),
          // …and where it records a finding outside its phase (phase 12), from the
          // sibling helper, so a site cannot state the mailbox and forget the ledger.
          ...this.issuesEnv(),
          // Where `phase-outcome.sh` writes the session's declared outcome —
          // the machine-readable record the runner reads on exit instead of
          // guessing from prose.
          // Armed, not merely named: `armOutcomeFile` deletes whatever is
          // there, so a stale file from a previous attempt can never speak for
          // this one. `written_at` is the second guard, on read.
          PE_OUTCOME_FILE: this.armOutcomeFile(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
          // Where `phase-outcome.sh … verified` records what this session proved (control-tower phase 62),
          // and where its lines are judged — the proof is keyed there (phase 106, `proofEnv`).
          ...(await this.proofEnv(phase)),
          // Where the session publishes its TASK LIST. A clone of the outcome
          // channel next door, for the same reason: the CLI stopped
          // provisioning TodoWrite/TaskCreate to `-p` sessions in August 2026,
          // so the panel that says what a run is doing went blank. A shell
          // script cannot be un-provisioned. Armed, not merely named.
          PE_TASKS_FILE: this.armTasksFile(phase),
        }),
        signal: this.abort?.signal,
        onPid: (pid) => {
          lane.pid = pid;
          // Stamped here and nowhere else: this is the only moment the console
          // knows the process is new. `syncMirror` carries it forward, and the
          // lane's liveness carries the same instant (#99), so a snapshot names
          // the process it describes.
          lane.procStartedAt = new Date().toISOString();
          lane.signals.procStartedAt = Date.parse(lane.procStartedAt);
          // …and the console that launched it, this one (control-tower phase
          // 110, #175): the one fact a later reader judges an orphan by.
          lane.launcher = { ...THIS_CONSOLE };
          record.liveness = livenessOf(phase, lane.signals, stallThresholds(this.deps.stallThresholds?.()));
          // A live, un-frozen child has just appeared, so if the run still
          // reads `frozen` that word is now false. This is the ONLY moment it
          // becomes false, which is why the re-derivation belongs here and not
          // at lane creation: a lane with no pid spends nothing, and clearing
          // the status there would erase the very word `boardingBlocked` reads
          // to refuse this spawn. Invariant: `frozen` implies no live
          // un-frozen lane.
          this.syncFrozenStatus();
          // Writes `children[phase]` AND the single-lane `state.child` mirror.
          // Both, always: see `syncMirror`.
          this.syncMirror();
          // `persistNow`, not `persist`: this is the one moment the console
          // learns the pid and stamps `procStartedAt`, and that entry is the
          // DURABLE handle on a session that outlives the console which made
          // it — what `reconcileRun`'s orphan branch, `adopt` and
          // `converge.runIsDead` all read. Through the debounce, a console
          // killed inside the window leaves a live session with no child record
          // at all, which is the orphan class the merged mirror rule exists to
          // prevent. It costs one fsync per lane per run.
          this.persistNow();
        },
        onEvent: (event) => this.onStream(phase, event),
        // The phase's attempt number, not this boarding's retry index
        // (control-tower phase 89, #130): the loop restarts at 1 on every
        // boarding, so a second boarding's `phase.session` and `phase.tokens`
        // read `attempt: 1` beside `record.attempts` 2. ONE number, the one
        // `openAttemptWindow` above stamped.
      }, { caps, attempt: record.attempts });
      // When this attempt's session ended — its own field. `endedAt` also meant
      // "the park began" and "a session ran", and parked time was measured from
      // whichever of the three wrote it last (WAI-4).
      record.attemptEndedAt = new Date().toISOString();
      closeAttemptWindow(record, record.attemptEndedAt);
      // The loopback ports this session served on (control-tower phase 89): a
      // refusal on one of them, once it has gone, is the machine's, not a red.
      const served = lane.signals.ownPorts;
      if (served?.length) record.ownPorts = [...new Set([...(record.ownPorts ?? []), ...served])].slice(-16);

      lane.pid = null;
      lane.handle = null;
      // The session's input went with it (#170): a lane between sessions is not
      // a live session whose input closed.
      delete lane.inputClosed;
      this.syncMirror();
      // The dollars — the run's, the phase's and the rung's — were booked by the
      // spawn door (`bookSpend`), as this spawn's rise over its session's mark.
      record.turns = (record.turns ?? 0) + outcome.turns;
      // Wall-clock minus whatever the operator held it for. A phase frozen over
      // lunch did not take an extra hour to think. Read off THIS lane: with
      // several running, `state.freeze` may be describing a different phase,
      // and subtracting its held time here would credit one phase with a pause
      // that happened to another.
      const frozenNow = lane.frozen ? Math.max(0, this.now().getTime() - Date.parse(lane.frozen.at)) : 0;
      if (frozenNow) record.frozenMs = (record.frozenMs ?? 0) + frozenNow;
      // ONE definition (#28): the sum of the attempt windows minus the frozen
      // time — `phaseClocks.workedMs`. The session's own process lifetime
      // (`outcome.durationMs`) was a sixth answer that matched no subtraction.
      record.durationMs = phaseClocks(record, this.now().getTime()).workedMs
        ?? (record.durationMs ?? 0) + Math.max(0, outcome.durationMs - frozenNow);
      if (outcome.sessionId) record.sessionId = outcome.sessionId;
      // Kept on the record, not only in the journal. When a phase exits clean
      // and changes nothing this is the only account of why, and the halt that
      // reports it needs to be able to quote it without re-reading NDJSON.
      // The session's words, not the network's (#108): a result that is the
      // CLI saying it could not reach the API gives way to the session's own
      // last prose, and when it wrote none the words an earlier attempt said
      // stand.
      const words = lastWords(outcome);
      if (words.said || !words.transportError) record.said = words.said;
      // `phase.session` — attempt, caps, ending, the session's own closing
      // words — was written by `spawnSession` the moment the child exited.

      // A `--resume` the CLI could not find: the conversation is not under
      // this account (or this cwd's project folder). Nothing ran, so this is
      // not an attempt that failed and not an attempt that produced nothing —
      // it is no attempt. Board the phase fresh in the same breath: the boot
      // prompt is self-contained by design, and a 60 s retry of the same
      // `--resume` is the loop this exists to end.
      if (resume && !outcome.turns && lostResume(outcome.signal)) {
        this.markSessionGone(record, resume.sessionId, 'the CLI holds no conversation under that id here');
        resume = undefined;
        record.attempts -= 1;
        continue;
      }

      // The session has exited, so nothing it started is still OPEN.
      //
      // `signals.openTools` holds every tool call whose `tool_result` never
      // arrived, and `spawn.ts` removes an entry only when the result comes
      // back — so a session killed or exiting mid-tool leaves its calls there
      // by construction. `evaluateStall` reads exactly that list to decide a
      // phase is squatting on an external clock, and `settleIdleAttempt` below
      // evaluates the lane one last time on this post-exit path. A lane that
      // died with a `gh run watch` open could therefore be PARKED for it,
      // minutes after the process was gone, on the evidence of a call nobody
      // was waiting for any more. A call whose result never came is not open;
      // it is abandoned.
      lane.signals.openTools = [];

      // Did this attempt change anything? The answer is the `stalemate`
      // counter, and this is the one moment it can be asked: the session has
      // exited and nothing has re-boarded yet.
      //
      // Only for an attempt that actually RAN, though. This used to be
      // unconditional, ahead of all three branches below, so an attempt we
      // ended on purpose — a checkpoint for an account switch, a per-lane
      // stop, an operator stop, a console shutdown — was scored as an attempt
      // that produced nothing. `idleAttempts` is the `stalemate` counter, so
      // three account switches (whose whole point is that the work continues
      // on the account that can pay) raised "3 attempts in a row ended with
      // nothing committed" about a phase that had never been given a chance to
      // commit anything. We caused those endings; they are not evidence about
      // the phase.
      if (!lane.checkpointed && !lane.stopped && !this.stopRequested && !this.abort?.signal.aborted) {
        await this.settleIdleAttempt(phase, lane);
      }

      // A checkpoint ended this child on purpose. The phase record is already
      // `pending` with a session to resume, and reading exit 143 as a crash
      // here would overwrite both. Two kinds: the freeze escalation pauses the
      // run for a person; an account switch carries on driving, because the
      // whole point was to keep going on the account that can pay.
      if (lane.checkpointed) {
        lane.checkpointed = false;
        lane.frozen = null;
        state.freeze = null;
        const note = lane.checkpointNote;
        lane.checkpointNote = null;
        if (note) return { carryOn: note.carryOn, completed: false };
        state.finishedReason = record.resumeSessionId
          ? `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue resumes the same session.'
          : `phase ${phase} was frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes and `
            + 'checkpointed. Continue starts it again from its boot prompt.';
        return { carryOn: false, completed: false };
      }

      // A per-lane stop ended this child on purpose. Settle it and hand the
      // loop back — the whole point of the verb is that the rest of the run
      // does not stop with it. Before the run-level check below: that one
      // pauses the whole run, which is exactly what this stop is not.
      if (lane.stopped) return this.settleStoppedLane(lane, phase);

      // An operator stop is not a failure to diagnose — we caused it. A
      // console SHUTDOWN lands here too (`checkpointForShutdown` aborts the
      // lanes), and must not be written as the operator's: the note takes the
      // killed-lane shape the convergence loop resumes at boot, the session
      // id is kept for the `--resume`, and `stoppedBy` says which it was.
      if (this.stopRequested || this.abort?.signal.aborted) {
        record.status = 'interrupted';
        if (this.shuttingDown) {
          record.note = consoleStoppedNote(phase);
          record.resumeSessionId ??= record.sessionId;
          state.stoppedBy = 'system';
        } else {
          const stamp = this.stopStamp();
          record.note = stamp.note;
          state.stoppedBy = stamp.stoppedBy;
        }
        // The word `runRecovery` already settled on: a halt that stands keeps
        // its run `halted` with its own reason. `paused` beside a live halt
        // painted one screen as waiting and the strip as an error (hub run
        // e44c15da); `stoppedBy` is what pins the stop as the operator's.
        setRunState(state, state.halt ? 'halted' : 'paused');
        return { carryOn: false, completed: false };
      }

      // A background agent the session left running, stopped with its process
      // (control-tower phase 109, #188): named for the next boarding.
      await this.noteAgentsKilled(phase, lane, outcome).catch(() => {});
      const disposition = classify(outcome.signal, this.now());
      this.record('phase.disposition', { attempt, kind: disposition.kind, reason: reasonOf(disposition) }, phase);
      this.emit('phase', { phase, disposition: disposition.kind, reason: reasonOf(disposition) });

      switch (disposition.kind) {
        case 'ok':
          return { carryOn: true, completed: true };

        case 'retry': {
          // A transient stop before the session's first turn never reached
          // the work: the rung it ends is the environment's, not the remedy's
          // (control-tower phase 5, #36 — sessions that died on a TLS blip
          // before turn one were charged as remedies that failed).
          const weather = endedOnEnvironment({ disposition: 'retry', turns: outcome.turns, costUsd: outcome.bookedUsd ?? outcome.costUsd });
          if (attempt === MAX_ATTEMPTS) { if (weather) { this.blameEnvironment(phase); environmental = true; } break; }
          await this.sleep(disposition.afterMs);
          // Same stand-down as the usage-window wake: a halt from another lane
          // during the backoff means no attempt N+1.
          if (state.halt) {
            record.status = 'interrupted';
            record.note = 'the run halted while this phase waited to retry';
            if (weather) this.blameEnvironment(phase);
            return { carryOn: false, completed: false };
          }
          continue;
        }

        case 'wait-until': {
          // The usage window belongs to the ACCOUNT, not to this run. The one
          // helper marks it machine-wide under the window's own name, holds
          // this account's other admissions in the scheduler, and journals it
          // — whatever the policy does next, and BEFORE any switch (ACT-5).
          const window = limitBucket(outcome.signal.text ?? '');
          this.leaveAccount(phase, {
            kind: 'usage', bucket: window, resetsAt: disposition.at, reason: disposition.reason, by: 'classifier',
          });

          // The SAME rule as the long-window wall below, and it has to be the
          // same one: `switch` always moves; under `wait` — the stored default,
          // and the policy a run started by anything but the launch form gets —
          // `autoAccountSwitch` (on by default) moves it rather than sleeping
          // on a clock while another registered account sits idle; `pause`
          // keeps its word. These two sites used to disagree, so whether a wall
          // auto-switched depended on which of them happened to notice it.
          const policy = state.onLimit ?? 'wait';
          const wantSwitch =
            policy === 'switch' || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);
          if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel, disposition.at)) {
            // Continue NOW, on the account that can pay — same session when
            // its transcript came along, a fresh boot prompt when it did not,
            // and a fresh boarding with the resume brief when it is too large
            // to rewrite into the new account's cache.
            const again = this.resumeAgain(record);
            if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
            resume = again.resume;
            this.persist();
            continue;
          }
          // `pause` checkpoints for a person; `wait` sleeps on the clock —
          // one helper, shared with the walls below — until the SOONEST reset
          // (#100): a pool member that frees up before this account's own
          // wall wakes it early, and the switch is tried again before any
          // attempt is spent proving this account is still walled.
          const wake = this.soonestReset(phase, disposition.at);
          if (await this.waitOutWindow(phase, record, wake, disposition.reason) === 'continue') {
            if (wake < disposition.at && wantSwitch
              && this.trySwitchAccount(phase, record, disposition.reason, currentModel, disposition.at)) {
              const again = this.resumeAgain(record);
              if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
              resume = again.resume;
              this.persist();
            }
            continue;
          }
          return { carryOn: false, completed: false };
        }

        case 'switch-model': {
          // A QUOTA hit (as opposed to a 529 capacity blip) names its bucket —
          // file the per-model wall against the account, so the meters agree
          // with what just happened and `pickAccount` steers a same-model run
          // elsewhere. No scheduler throttle: every other model is still fine.
          if (disposition.bucket && disposition.at) {
            this.leaveAccount(phase, {
              kind: 'usage', bucket: disposition.bucket, resetsAt: disposition.at, reason: disposition.reason,
              by: 'classifier', perModel: true,
            });
          }
          // Remember the wall per model. A capacity blip (529) names no reset
          // and is not remembered: there is nothing to wait for.
          if (disposition.at && !modelWalls.some((wall) => wall.model === currentModel)) {
            modelWalls.push({ model: currentModel, at: disposition.at });
          }
          // A PINNED model never steps down (control-tower phase 54, #91): the
          // run's `onLimit` may move it to an account that can pay for THIS
          // model, or it waits for the window; with neither, a person is asked.
          if (this.modelPolicyOf(phase) === 'pinned') {
            this.record('phase.model-held', { model: currentModel, why: 'wall', reason: disposition.reason }, phase);
            const policy = state.onLimit ?? 'wait';
            const wantSwitch = policy === 'switch' || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);
            if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel, disposition.at ?? null)) {
              const again = this.resumeAgain(record);
              if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
              resume = again.resume;
              this.persist();
              continue;
            }
            // A capacity blip names no window: the same model, a little later.
            if (!disposition.bucket && !disposition.at && attempt < MAX_ATTEMPTS) {
              await this.sleep(PINNED_CAPACITY_RETRY_MS);
              if (state.halt) return { carryOn: false, completed: false };
              continue;
            }
            const until = disposition.at && !modelWindowWaited ? resetWaitUntil(disposition.at, this.now()) : null;
            if (until) {
              modelWindowWaited = true;
              const verdict = await this.waitOutWindow(
                phase, record, until, `${currentModel} is pinned; its window reopens ${until.toLocaleString()}`,
                { policy: policy === 'pause' ? 'pause' : 'wait' },
              );
              if (verdict !== 'continue') return { carryOn: false, completed: false };
              const again = this.resumeAgain(record);
              if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
              resume = again.resume;
              continue;
            }
            const reason = `${currentModel} is pinned (Model policy: pinned) and walled, with no other account to run it `
              + `and no reset near enough to wait for — ${disposition.reason}`;
            record.status = 'parked';
            record.note = reason;
            this.record('phase.needs-human', { reason }, phase);
            this.halt(reason, phase, 'needs-human');
            return { carryOn: false, completed: false };
          }
          const next = nextModel(currentModel);
          if (!next) {
            // Every model is limited. The model wall's one rung: when the
            // FIRST model's reset is known and near enough to sleep on, wait
            // for it and retry the same session on that model — the strongest
            // one the phase was given, not the weakest it fell to. Once per
            // phase; without a reset (or past the ceiling) this halts as it
            // always did.
            const first = modelWalls[0];
            const until = first && !modelWindowWaited ? resetWaitUntil(first.at, this.now()) : null;
            if (first && until) {
              modelWindowWaited = true;
              this.record('phase.model-window-wait', {
                model: first.model, until: until.toISOString(), reason: disposition.reason,
              }, phase);
              const verdict = await this.waitOutWindow(
                phase, record, until,
                `every model is limited; ${first.model}'s window reopens ${until.toLocaleString()}`,
                { policy: 'wait' },
              );
              if (verdict !== 'continue') return { carryOn: false, completed: false };
              currentModel = first.model;
              record.model = first.model;
              modelWalls.length = 0;
              // The same session, when its transcript is where this account
              // looks — the phase keeps whatever it had done — unless the wait
              // left it too large and too cold to be worth resuming.
              const again = this.resumeAgain(record);
              if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
              resume = again.resume;
              this.record('phase.model-window-retry', { model: first.model, resume: resume?.sessionId ?? null }, phase);
              continue;
            }
            this.halt(`every model is exhausted or at capacity (${disposition.reason})`, phase, 'models-exhausted');
            return { carryOn: false, completed: false };
          }
          this.record('phase.model-switch', { from: currentModel, to: next, reason: disposition.reason }, phase);
          currentModel = next;
          record.model = next;
          // Fresh start on the new model: the prompt is self-contained, which is
          // the whole point of a boot prompt.
          resume = undefined;
          continue;
        }

        case 'safeguard-flag': {
          // The API's safeguards flagged a message (control-tower phase 111,
          // #177). A false positive is likely, and the banner names its own
          // remedy: a NEW session — `--resume` would re-send the flagged
          // message — or another model. First a fresh session with the resume
          // brief; then a fresh session again, or the next model where the
          // model policy lets the phase step down (`pinned` never does); only
          // the third flag asks a person, saying what was tried.
          const guard = (record.safeguard ??= { flags: 0, tried: [] });
          guard.flags += 1;
          const next = guard.flags === 2 && this.modelPolicyOf(phase) !== 'pinned' ? nextModel(currentModel) : null;
          const remedy = guard.flags >= SAFEGUARD_FLAGS_BEFORE_PERSON ? 'needs-human' : next ? 'switch-model' : 'fresh-session';
          this.record('phase.safeguard-flag', {
            attempt, flags: guard.flags, remedy, model: currentModel,
            classifier: disposition.classifier ?? null,
            requestId: disposition.requestId ?? null,
            messageId: disposition.messageId ?? null,
          }, phase);
          if (remedy === 'switch-model' && next) {
            guard.tried.push(next);
            this.record('phase.model-switch', { from: currentModel, to: next, reason: disposition.reason }, phase);
            currentModel = next;
            record.model = next;
            resume = undefined;
            this.persist();
            continue;
          }
          if (remedy === 'fresh-session') {
            guard.tried.push('a fresh session');
            return this.reboardFresh(phase, record, safeguardInstruction(disposition, guard.flags),
              'was flagged by the API\'s safeguards');
          }
          const reason = `the API's safeguards flagged the session (a false positive is likely); ${triedSentence(guard.tried)}`
            + `${disposition.requestId ? ` — report request ${disposition.requestId}` : ''}`;
          record.status = 'parked';
          record.note = reason;
          this.record('phase.needs-human', { reason }, phase);
          this.halt(reason, phase, 'needs-human');
          return { carryOn: false, completed: false };
        }

        case 'resume': {
          if (!record.sessionId) { this.halt('the session hit a cap but reported no session id to resume', phase, 'phase-crashed'); return { carryOn: false, completed: false }; }
          const again = this.resumeAgain(record, { port: true });
          if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
          resume = again.resume;
          // The CLI enforced the cap the console set, so the resume carries on
          // under double that cap — attributed as a raise, so a second spent
          // cap reads as the phase outgrowing it rather than as a crash.
          caps = disposition.raise === 'budget'
            ? { ...caps, maxBudgetUsd: raiseCap(caps.maxBudgetUsd, 'the session spent its dollar cap') }
            : { ...caps, maxTurns: raiseCap(caps.maxTurns, 'the session spent its turn cap') };
          this.record('phase.resume', {
            raise: disposition.raise,
            budget: caps.maxBudgetUsd.value, budgetSource: caps.maxBudgetUsd.source,
            maxTurns: caps.maxTurns.value, maxTurnsSource: caps.maxTurns.source,
          }, phase);
          continue;
        }

        case 'needs-human':
          // One park IS automatable: a usage reset too far away to sleep on,
          // held by a console that has another account. The discriminant makes
          // that decidable without string-matching the reason.
          if (disposition.cause === 'usage-window') {
            const window = limitBucket(outcome.signal.text ?? '');
            // Marked, held and journalled through the one helper — with the
            // reset when it parsed, the cool-down when it did not.
            this.leaveAccount(phase, {
              kind: 'usage', bucket: window, resetsAt: disposition.at ?? null, reason: disposition.reason, by: 'classifier',
            });
            // The usage wall's first rung. `switch` always could; under
            // `wait` — which cannot wait this long — `autoAccountSwitch` (on
            // by default) moves the run to an account that can pay instead of
            // stopping for a person. `pause` keeps its word and pauses.
            const policy = state.onLimit ?? 'wait';
            const wantSwitch = policy === 'switch' || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);
            if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel, disposition.at ?? null)) {
              const again = this.resumeAgain(record);
              if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
              resume = again.resume;
              this.persist();
              continue;
            }
            if (disposition.at) {
              // No account can pay: the run waits on the window ITSELF —
              // restart-safe, the clock settles it — with the one ask that
              // would end the wait sooner left on it. Not a person's halt.
              const base = errandFor('resource-wall:usage', ['switch-account → no other account has headroom'], phase);
              const errand: Errand = {
                ...base,
                how: `The run waits by itself until ${disposition.at.toLocaleString()}. To continue sooner, `
                  + 'register or sign in another Claude account under Settings ▸ Accounts and switch the run to it.',
              };
              // Until the SOONEST reset (#100), as above.
              const wake = this.soonestReset(phase, disposition.at);
              const verdict = await this.waitOutWindow(phase, record, wake, disposition.reason, { errand });
              if (verdict === 'continue') {
                if (wake < disposition.at && wantSwitch
                  && this.trySwitchAccount(phase, record, disposition.reason, currentModel, disposition.at)) {
                  const again = this.resumeAgain(record);
                  if (again.notWorth) return this.reboardNotWorth(phase, record, again.notWorth);
                  resume = again.resume;
                  this.persist();
                }
                continue;
              }
              return { carryOn: false, completed: false };
            }
          }
          {
            const reason = disposition.reason;
            record.status = 'parked';
            record.note = reason;
            this.record('phase.needs-human', { reason }, phase);
            // A person's park, on this phase. The credential family used to
            // land here too and it is the one case this word was wrong for —
            // `needs-human` is PHASE-level, so a refused credential settled the
            // phase and the loop boarded the next one into the same wall
            // (RCV-1). It has its own run-level arm below since phase 9.
            this.halt(reason, phase, 'needs-human');
            return { carryOn: false, completed: false };
          }

        case 'credential-refused': {
          // The API refused the run's OWN credential — an organisation policy,
          // an expired or signed-out login, a billing hold, a certificate it
          // will not trust. Measured (RCV-1): `halt(…, 'needs-human')` found the
          // kind in PHASE_HALT_KINDS, settled the phase and handed the run its
          // next candidate — ten boardings of one plan inside 157 s, $223.69,
          // every record reading `success`, and the streak never saw one of
          // them because the branch returned before `consecutiveFailures++`.
          //
          // Four things, in this order, and each is load-bearing:
          //   1. the account is marked RETIRED for its organisation in the
          //      machine-wide breaker (phase 8's `leaveAccount`) — `rankAccounts`
          //      never answers it again and the preflight refuses it by name;
          //   2. the CAUSE is stamped on the record, so the situation classifier
          //      reads `resource-wall:auth` from the console's own evidence
          //      whatever a later rung's result looks like (RCV-2, SES-3);
          //   3. the streak is NOT charged. It was, until 5.2.0, and the
          //      argument ("a wall that stops the run is a failed attempt")
          //      reads well and is wrong: the counter means "this PLAN keeps
          //      failing", and being refused entry says nothing about the
          //      plan. Measured: one transient event charged three failures
          //      in 39 s and left a run at 3 of a maximum 2 — over its own
          //      ceiling, its signal destroyed, and converted into a second,
          //      independent press-only halt on top of the one it already had;
          //   4. the RUN halts (`credential-refused` is run-level), with the one
          //      errand on it: nothing downstream can spend under a credential
          //      the API refuses, and the errand — not the halt card — is what
          //      reaches a person who is not looking.
          // A credential complaint names WHOSE credential: the classifier is
          // deliberately account-blind, and "sign that account in again" is
          // only actionable when the reason says which one.
          // A refusal met AFTER the login changed identity is not a lapse and not
          // this credential's fault (control-tower phase 91, #131): the halt says
          // what happened, and nothing is retired — the new login did nothing.
          if (disposition.class === 'auth' && this.identityDrifted(phase)) {
            record.status = 'parked';
            record.note = state.halt?.reason ?? 'the login changed identity';
            this.blameEnvironment(phase);
            return { carryOn: false, completed: false };
          }
          const paying = state.accountId ?? 'the machine login';
          const reason = `${disposition.reason} (account: ${paying})`;
          const at = this.now().toISOString();
          // A SECOND lane arriving at the same wall is the same event reaching
          // a second reader. It marks its own record so the phase table is
          // honest, and does nothing else: no second retirement of an already
          // retired credential, no second errand over the first, no re-halt.
          const alreadyStopped = state.halt?.kind === 'credential-refused';
          // What the verdict stood on, and whose stop it was (#57): kept on the
          // retirement, the cause and the halt, so a person reads WHY — the kind
          // the API returned, or the sentence on its error channel.
          const evidence: RetirementEvidence | undefined = disposition.evidence
            ? {
              ...disposition.evidence,
              ...(record.sessionId ? { session: record.sessionId } : {}),
              phase, slug: state.slug, runId: state.id,
            }
            : undefined;
          if (!alreadyStopped) {
            this.leaveAccount(phase, {
              kind: 'credential', reason: disposition.reason, by: 'classifier', class: disposition.class,
              // A sentence, not a verdict the API returned — so this refusal
              // reaches ONE credential and never its organisation. `classify`
              // answers the structured kinds before it ever reads text, and
              // those arrive here through `signal.retryCategories` and
              // `signal.apiErrors`.
              structured: structuredRefusal(outcome.signal),
              ...(record.sessionId ? { session: record.sessionId } : {}),
              ...(evidence ? { evidence } : {}),
            });
          }
          record.status = 'parked';
          record.note = reason;
          record.cause = {
            kind: 'credential-refused', class: disposition.class, reason: disposition.reason, at,
            ...(state.accountId ? { account: state.accountId } : {}),
            ...(evidence ? { evidence } : {}),
          };
          // …and the rung this attempt was climbing did not fail on its merits
          // (control-tower phase 5, #36): it comes back when an account does.
          this.blameEnvironment(phase);
          if (alreadyStopped) {
            this.record('phase.credential-wall-seen', {
              class: disposition.class, account: state.accountId ?? null, reason: disposition.reason,
            }, phase);
            return { carryOn: false, completed: false };
          }
          // The wall's errand: the situation's fixed sentences, with the
          // account, the class and the session's own last words on it — the
          // words ARE the evidence for a policy refusal (RCV-7).
          const base = errandFor('resource-wall:auth', [], phase, at, record.said ?? null);
          // Is there anything to switch TO? The measured incident had four runs
          // parked on this exact errand while every account on the machine was
          // unusable — so "switch the run to another account" was advice nobody
          // could take, and the fact that said so lived on another page.
          const usable = this.deps.accountsUsable?.();
          const allGone = Boolean(usable && usable.total > 0 && usable.unusable >= usable.total);
          const errand: Errand = {
            ...base,
            need: `A Claude account this run may spend under — the API refused ${paying}'s credential `
              + `(${disposition.class}): ${disposition.reason}.`
              + (allGone
                ? ` Every account registered here is unusable (${usable!.unusable} of ${usable!.total}), `
                  + 'so there is nothing to switch to: one has to be cleared or a new one signed in.'
                : ''),
            how: disposition.class === 'certificate'
              ? 'Fix the certificate trust between this machine and the API (the proxy, or the trust '
                + 'store), then Continue the run; or switch it to an account that reaches the API from '
                + 'elsewhere under Settings ▸ Accounts.'
              : `Sign in or register a Claude account under an organisation that allows it (Settings ▸ Accounts) `
                + `and switch the run to it, or clear ${paying} there once its organisation allows it again — `
                + 'then Continue. The account stays retired for every run until a person clears it.',
          };
          state.errand = errand;
          this.record('run.errand', { ...errand, reason: 'the API refused the run\'s credential', by: 'runner' });
          // The errand rides the phase event, which is the one channel
          // `announceErrand` listens on (`needs-you`, deduped by `errand.at`).
          this.emit('phase', { phase, status: 'parked', note: record.note, errand });
          this.halt(reason, phase, 'credential-refused', evidence ? { evidence } : {});
          return { carryOn: false, completed: false };
        }

        case 'connectivity': {
          // Nobody's fault. This machine could not reach the API, so there is
          // nothing to diagnose, nothing to retire and nothing to charge — the
          // lane waits and comes back, and the attempt it did not get is not
          // spent. Everything else in this switch answers "what does this say
          // about the credential, the phase or the plan?"; the answer here is
          // "nothing", and saying so is the whole fix.
          //
          // A certificate-SHAPED stop files a strike on its way through. Three
          // of them, from two sessions, over ten minutes, with nothing
          // succeeding in between, is a standing interception rather than the
          // weather — and even then it cools ONE credential.
          if (disposition.class) {
            this.leaveAccount(phase, {
              kind: 'credential', reason: disposition.reason, by: 'classifier', class: disposition.class,
              structured: false,
              ...(record.sessionId ? { session: record.sessionId } : {}),
            });
          }
          const waitMs = connectivityBackoffMs(outages);
          if (outageWaitedMs + waitMs > MAX_AUTO_WAIT_MS) {
            // Past half a day of no network, stop waiting. Fall through to the
            // ordinary failure path, which fails the phase and leaves it for the
            // ladder and a person — the one thing that IS worth doing now.
            record.note = `${disposition.reason} — and it has been unreachable for `
              + `${Math.round(outageWaitedMs / 60_000)} minutes`;
            // The phase fails now; the REMEDY it was climbing is not charged,
            // and nor is the run's streak — the weather is no claim about the
            // plan (phase 3), however long it lasts (phase 45).
            this.blameEnvironment(phase);
            environmental = true;
            break;
          }
          outages += 1;
          outageWaitedMs += waitMs;
          // `waitMs` is the backstop: the probe looks every `probeEveryMs` and
          // wakes the lane at the first answer (#108).
          const until = new Date(this.now().getTime() + waitMs);
          this.record('phase.connectivity-wait', {
            attempt, outage: outages, waitMs, probeEveryMs: CONNECTIVITY_PROBE_MS, until: until.toISOString(),
            reason: disposition.reason, ...(disposition.class ? { class: disposition.class } : {}),
          }, phase);
          const waitBegan = this.now().getTime();
          const woke = await this.waitOutOutage(phase, record, until, disposition.reason);
          if (woke === 'stop') {
            this.blameEnvironment(phase);
            return { carryOn: false, completed: false };
          }
          // Read the board before boarding again — and resume the session that
          // lost the API rather than replacing it (#108). A session that worked
          // has a conversation to go back to; so does one this attempt already
          // resumed, whatever it managed before the network went again.
          const waitedMs = Math.max(0, this.now().getTime() - waitBegan);
          const after = await this.afterOutage(phase, record, outcome.turns > 0 || Boolean(resume));
          this.record('phase.connectivity-restored', {
            outage: outages, by: woke === 'recovered' ? 'probe' : 'clock', waitedMs, next: after.next,
            ...(after.next === 'resume' ? { session: after.resume.sessionId } : {}),
          }, phase);
          // The phase finished before the network went: its closeout — the
          // §Verification, the landing, the lock — is what a clean ending gets.
          if (after.next === 'closeout') return { carryOn: true, completed: true };
          // The attempt is given back, both counters: an outage is not an
          // attempt at the work, and three dropouts must not exhaust a phase's
          // three tries.
          attempt -= 1;
          record.attempts -= 1;
          if (after.next === 'reboard') return this.reboardNotWorth(phase, record, after.policy);
          if (after.next === 'resume') {
            resume = after.resume;
            promptOnce = outageResumePrompt(state.slug, phase, waitedMs);
          } else {
            resume = undefined;
          }
          continue;
        }

        case 'phase-failed': {
          record.note = disposition.reason;
          if (attempt < MAX_ATTEMPTS) {
            // The retry's prompt was composed before the agents it lost were
            // known (control-tower phase 109, #188): told once, here.
            const killed = this.agentsKilledLines(record);
            if (killed.length) {
              promptOnce = `${prompt}\n\nWHAT THE CONSOLE KNOWS ABOUT THIS TREE (read as this attempt restarted — control-tower phase 109):\n${killed.join('\n')}\n`;
            }
            await this.sleep(15_000);
            continue;
          }
          break;
        }
      }
      break;
    }

    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    this.chargeFailure(phase, environmental ? 'connectivity' : 'crash', record.note ?? 'the phase failed');
    this.record('phase.failed', { attempts: record.attempts, note: record.note }, phase);
    // The last session spent its dollar cap: a budget stopped it (phase 14, #40).
    if (record.lastSession && spentCapOf(record.lastSession) === 'budget') this.notePhaseBudgetSpent(phase);
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      this.halt(streakSentence(state), phase, 'failure-streak');
      return { carryOn: false, completed: false };
    }
    return { carryOn: state.autonomy === 'keep-going', completed: false };
  }

  /**
   * Score the attempt that just ended, and re-evaluate the lane.
   *
   * `stalemate` is the one signal that cannot be seen from the stream: an
   * attempt that produces nothing looks, second by second, exactly like an
   * attempt that is about to. It is only knowable at the end, and only by
   * asking the tree — which is why the counter lives on the RECORD (it spans
   * attempts, each with its own lane) and why the window is `attemptStartedAt`
   * rather than the phase's first start: once attempt 1 has committed
   * anything, a window anchored at the phase start would call every later
   * attempt productive whatever it did.
   *
   * "I could not read the tree" is not "nothing happened". An unreadable
   * working tree leaves the counter exactly where it was — three attempts
   * against a repository the console cannot see is a console problem, and
   * announcing it as a stalemate would send a person to look at the wrong
   * thing.
   */
  private async settleIdleAttempt(phase: number, lane: Lane): Promise<void> {
    const record = phaseRecord(this.state!, phase);
    const work = await workEvidence(
      (args) => this.gitOrNull(args),
      record.attemptStartedAt ?? record.startedAt ?? null,
      await this.scopeDirs(phase),
    ).catch(() => null);
    if (!work || work.did === null) return;
    record.idleAttempts = work.did ? 0 : (record.idleAttempts ?? 0) + 1;
    lane.signals.idleAttempts = record.idleAttempts;
    // `dirty` has no time component, so this reading is as good as the
    // ticker's. `commitsSinceStart` is deliberately still left to the ticker —
    // not because the window differs (both count from `attemptStartedAt` since
    // the silent watchdog needed a per-attempt answer) but because this call
    // runs at an attempt's END, where the ticker's own reading is about to be
    // discarded with the lane anyway.
    lane.signals.treeDirty = (work.dirty ?? 0) > 0;
    await this.evaluateLane(lane, stallThresholds(this.deps.stallThresholds?.()), this.now().getTime());
  }

  /**
   * `confirm`, with the verifying clock retired however it returns.
   *
   * A wrapper rather than a `try/finally` inside `confirm` itself: that method
   * returns from a dozen places across several hundred lines, and a clock left
   * set by one of them would suppress the stall detector for the rest of the
   * run.
   */
  protected async confirmed(phase: number): Promise<boolean> {
    const record = phaseRecord(this.state!, phase);
    try {
      return await this.confirm(phase);
    } finally {
      delete record.verifyingSince;
    }
  }

  /**
   * The three independent checks. All must agree before a phase counts as done.
   * Nothing here asks the session what happened.
   */
  /** `{repo, branch, head}` of every repository a verification can read; empty when none can be read. */
  private async stampVerification(phase: number, cwd: string, text: string | undefined): Promise<TreeStamp[]> {
    try {
      return await stampTrees({ root: this.laneRoot(phase), cwd, scope: await this.scopeFor(phase), text });
    } catch {
      return [];
    }
  }

  /**
   * Settle the run's idle mirror branches before the LAST phase's §Verification
   * (control-tower phase 62, #47). The mirror mints `pe/<slug>` in every
   * repository it mounts, and where no phase committed, that branch sits 0
   * ahead of the trunk, checked out by the mirror — so a ship phase's check of
   * the checkout's hygiene could never pass while its own run was live, and the
   * phase shipped, then declared `blocked` for a person to rule the line away.
   * Only a mirror run, only its final phase (`isFinalPhase`, the rule the
   * pull-request block uses), and only branches holding nothing
   * (`settleIdleMirrorBranches`); every session spawned afterwards gets them
   * back first (`restoreIdleMirror`). Nothing here can fail the phase.
   */
  private async settleIdleMirror(phase: number): Promise<void> {
    const state = this.state!;
    if (state.checkout !== 'worktree' || !state.mountedRepos?.length || state.mirrorSettled) return;
    const names = this.laneNamesFor(0);
    if (state.workRoot !== names.integration) return;
    let board: Board;
    try { board = await this.board(); } catch { return; }
    if (!board.phased || board.timedOut || !this.isFinalPhase(board, phase)) return;
    const out = await settleIdleMirrorBranches(names.integration, names.runBranch).catch(() => null);
    if (!out || (!out.settled.length && !out.kept.length)) return;
    if (out.settled.length) {
      state.mirrorSettled = { phase, at: this.now().toISOString(), mounts: out.settled };
    }
    this.record('run.mirror-branches-settled', {
      phase, branch: names.runBranch, settled: out.settled,
      // Why each branch could go, and the tip it named (phase 89, #47): a
      // squash-merged branch is on no trunk by identity, so this line is where
      // it can be named and re-created from.
      ...(out.proofs.length ? { proofs: out.proofs } : {}),
      ...(out.kept.length ? { kept: out.kept } : {}),
    }, phase);
    this.persist();
  }

  /** Which of the session's recorded proofs hold for the tree about to be verified — null on any failure to ask. */
  private async sessionProofs(phase: number, cwd: string): Promise<ProofJudgement | null> {
    const state = this.state!;
    try {
      return await judgeProofs({ file: proofsFile(state.root, state.slug), slug: state.slug, phase, cwd });
    } catch {
      return null;
    }
  }

  /**
   * The proofs' two journal lines (control-tower phase 62, #68): what was
   * honoured and what was not, and — for every command the console ran that
   * the session had also recorded — any disagreement between the two verdicts.
   * A disagreement was the audit's one unexplained number (a mirror's suite red
   * in 15 of 17 console runs while the sessions reported it green); from here on
   * each one is a line naming both trees.
   */
  private recordProofVerdicts(phase: number, judged: ProofJudgement, ran: readonly VerifyRun[]): void {
    if (!judged.recorded.size) return;
    this.record('phase.verify-proven', {
      tree: judged.tree,
      proven: [...judged.proven].map(([command, by]) => ({
        command, tree: by.tree, at: by.at,
        ...(by.session ? { session: by.session } : {}),
        ...(by.paperwork.length ? { paperwork: by.paperwork.slice(0, 20) } : {}),
      })),
      refused: judged.refused,
    }, phase);
    for (const [command, proof] of judged.recorded) {
      // The command's verdict is its LAST attempt, and a proven row is the
      // proof itself rather than a run of anything.
      const rows = ran.filter((row) => !row.proven && foldCommand(row.command) === command);
      const last = rows[rows.length - 1];
      if (!last || (proof.code === 0) === last.ok) continue;
      const refusal = judged.refused.find((entry) => entry.command === command);
      this.record('phase.verify-disagreed', {
        command,
        session: { code: proof.code, tree: proof.tree, at: proof.at, ...(proof.session ? { session: proof.session } : {}) },
        console: { code: last.code, ...(judged.tree ? { tree: judged.tree } : {}) },
        ...(refusal?.why ? { why: refusal.why } : {}),
        ...(refusal?.changed?.length ? { changed: refusal.changed } : {}),
      }, phase);
    }
  }

  /* ---- the verification's clock and ledger (control-tower phase 83, #95 #103) ---- */

  /** The plan's `Verify timeout:` for this phase, as the engine reads it — undefined is silence. */
  private async verifyTimeoutDirective(phase: number): Promise<{ minutes: number; source: 'phase' | 'plan' } | undefined> {
    try {
      return readVerifyTimeout(await this.engine(['--verify-timeout', String(phase)]));
    } catch {
      return undefined;
    }
  }

  /**
   * The clock each of this phase's §Verification commands runs under (#95):
   * the plan's `Verify timeout:` when it states one, else each line's own
   * measured history in the plan's ledger, else the default — and the record
   * the restart drain reads for a verifying lane (their sum).
   */
  protected async verifyLimitsFor(
    phase: number, text: string | undefined, approvals?: VerifyApprovals,
  ): Promise<{ timeoutFor: (command: string) => number; limit: NonNullable<PhaseRecord['verifyLimit']> }> {
    const state = this.state!;
    const directive = await this.verifyTimeoutDirective(phase);
    const rows = directive ? [] : readLedger(verificationsFile(state.root, state.slug), state.slug);
    const commands = extractCommands(text, 'verify', approvals).commands;
    const each = commands.map((command) => {
      const resolved = resolveVerifyLimit({ command, rows, ...(directive ? { directive } : {}) });
      return { command, ms: resolved.ms, source: resolved.source };
    });
    const byLine = new Map(each.map((entry) => [foldCommand(entry.command), entry.ms]));
    const fallback = directive ? directive.minutes * 60_000 : VERIFY_TIMEOUT_MS;
    const source: VerifyLimitSource = directive?.source
      ?? (each.some((entry) => entry.source === 'history') ? 'history' : 'default');
    return {
      timeoutFor: (command) => byLine.get(foldCommand(command)) ?? fallback,
      limit: {
        ms: each.length ? each.reduce((sum, entry) => sum + entry.ms, 0) : fallback,
        source,
        ...(each.length ? { commands: each } : {}),
      },
    };
  }

  /** Each command's LAST attempt — the row its verdict is — in the order the commands ran. */
  private static finalRows(ran: readonly VerifyRun[]): VerifyRun[] {
    const last = new Map<string, VerifyRun>();
    for (const row of ran) last.set(row.command, row);
    return [...last.values()];
  }

  /** One ledger row per command the console ran — a proof it honoured is not a run, and is not ledgered. */
  private ledgerRows(
    phase: number, kind: LedgerRow['kind'], ran: readonly VerifyRun[],
    tree: { tree: string; head: string | null } | null, own: readonly RedShare[] = [], chain?: string,
    /** The environment digest and directory it ran under — what a later baseline reuses it by (control-tower phase 105). */
    where?: { env: string; dir: string },
  ): LedgerRow[] {
    const state = this.state!;
    const at = this.now().toISOString();
    return RunnerAttempt.finalRows(ran).filter((row) => !row.proven).map((row) => {
      const mine = own.find((share) => share.command === row.command && (share.chain ?? '') === (chain ?? ''));
      return {
        type: 'verification', slug: state.slug, phase, run: state.id, at, kind,
        command: foldCommand(row.command), ...(chain ? { chain: foldCommand(chain) } : {}), code: row.code, ms: row.ms, ok: row.ok,
        ...(row.timedOut ? { timedOut: true } : {}),
        tree: tree?.tree ?? null, head: tree?.head ?? null,
        ...(where ? { env: where.env, dir: where.dir } : {}),
        ...(row.failures?.length ? { failures: row.failures } : {}),
        // What a red SAID, for a baseline as for a verdict (control-tower phase 106, #195).
        ...(!row.ok && row.output?.trim() ? { tail: outputTail(row.output) } : {}),
        ...(row.environment ? { environment: row.environment } : {}),
        ...(kind === 'verify' ? { own: mine ? (mine.failures.length ? [...mine.failures] : [WHOLE_COMMAND]) : [] } : {}),
      };
    });
  }

  /** Every session window this run's phases opened — what a commit's author is read from. */
  private sessionWindows(): SessionWindow[] {
    const out: SessionWindow[] = [];
    for (const record of Object.values(this.state!.phases)) {
      for (const window of record.attemptWindows ?? []) {
        out.push({ phase: record.phase, startedAt: window.startedAt, ...(window.endedAt ? { endedAt: window.endedAt } : {}) });
      }
    }
    return out;
  }

  /**
   * Whose each red is (control-tower phase 83, #103) — the reds the baseline
   * already had (inherited) and, since the fifth amendment, the ones it did not
   * (the phase's own until shown otherwise). In order, for each failing test:
   *  1. the ledger — another phase was charged with it, and no run since was
   *     clean of it;
   *  2. uncommitted work — a tree the line was clean of it on (the session's
   *     own proof, or a run in the ledger) differs from the tree it is red on
   *     ONLY in paths another phase's session wrote and never committed
   *     (`wip`): P61's red was P62's 17 uncommitted files, never P61's;
   *  3. the commits — between the last run clean of it and the head it was
   *     first seen red on (the baseline's, for an inherited red; the verified
   *     one, for a new red), read against this run's session windows. A new
   *     red leaves the phase only when the phase itself made none of those
   *     commits: its own could be the one, and the rule never guesses.
   * A red nothing names stays where the split put it.
   */
  private async attribute(
    phase: number, split: { own: RedShare[]; inherited: RedShare[] }, rows: readonly LedgerRow[],
    verified: { top: string; tree: string; head: string | null } | null, proofs: ProofJudgement | null,
  ): Promise<{ own: RedShare[]; inherited: InheritedRed[] }> {
    const baseline = phaseRecord(this.state!, phase).baseline;
    const base = baseline?.head ?? null;
    // A new red is attributed only on a line the baseline read: without one,
    // nothing says the red was absent when the phase boarded, and every red is
    // the phase's, as it always was.
    const baselined = (share: RedShare): boolean => Boolean(baseline?.commands.some((line) => line.command === foldCommand(share.command)
      || (share.chain !== undefined && !line.chain && line.command === foldCommand(share.chain))));
    const windows = this.sessionWindows();
    // Read once, and only when a red gets as far as asking.
    let wipRead: Promise<Map<string, WipOwner> | null> | undefined;
    const wipNow = () => (wipRead ??= verified ? this.wipOf(phase, verified.top, windows) : Promise.resolve(null));
    const diffs = new Map<string, Promise<string[] | null>>();
    const changedSince = (tree: string): Promise<string[] | null> => {
      if (!diffs.has(tree)) diffs.set(tree, treeChanges(verified!.top, tree, verified!.tree).catch(() => null));
      return diffs.get(tree)!;
    };
    // One read per range, however many failing tests share it.
    const ranges = new Map<string, Promise<{ sha: string; at: string }[] | null>>();
    const commitsIn = (from: string, to: string) => {
      const key = `${from}..${to}`;
      if (!ranges.has(key)) ranges.set(key, commitsBetween(verified!.top, from, to).catch(() => null));
      return ranges.get(key)!;
    };
    type Found = Pick<InheritedRed, 'owner' | 'how' | 'candidates' | 'paths'>;
    const lookup = async (share: RedShare, id: string, isNew: boolean): Promise<Found> => {
      const charged = ownerFromLedger(rows, share.command, id, phase);
      if (charged !== undefined) return { owner: charged, how: 'charged' };
      // A sibling's wrap-up WIP already failed this line with this test, on a
      // commit this head carries (control-tower phase 89, #127): its red.
      const wipOwner = verified ? await this.wipRedOwner(phase, share, id, verified) : undefined;
      if (wipOwner !== undefined) return { owner: wipOwner, how: 'wip-red' };
      const wip = verified ? await wipNow() : null;
      if (wip && verified) {
        for (const tree of this.cleanRefs(share, id, rows, proofs)) {
          const changed = await changedSince(tree);
          const found = changed ? wipAttribution(changed.filter((path) => !isPaperwork(path)), wip) : null;
          if (found) {
            return { ...(found.owner !== undefined ? { owner: found.owner } : { candidates: found.candidates }), how: 'wip', paths: found.paths };
          }
        }
      }
      const clean = lastCleanHead(rows, share.command, id);
      const until = isNew ? verified?.head ?? null : base;
      if (!clean || !until || !verified || clean === until) return {};
      const commits = await commitsIn(clean, until);
      if (!commits || (isNew && committers(commits, windows).includes(phase))) return {};
      const byCommit = ownerByCommits(commits, windows, phase);
      if (byCommit.owner !== undefined) return { owner: byCommit.owner, how: 'commit' };
      return byCommit.candidates ? { candidates: byCommit.candidates, how: 'commit' } : {};
    };
    const own: RedShare[] = [];
    const inherited: InheritedRed[] = [];
    for (const [shares, isNew] of [[split.inherited, false], [split.own, true]] as const) {
      for (const share of shares) {
        if (isNew && !baselined(share)) { own.push(share); continue; }
        const groups = new Map<string, InheritedRed>();
        const mine: string[] = [];
        let whole = false;
        for (const id of share.failures.length ? share.failures : [WHOLE_COMMAND]) {
          const found = await lookup(share, id, isNew);
          // A new red nothing names is the phase's own, as it always was.
          if (isNew && found.owner === undefined && !found.candidates) {
            if (id === WHOLE_COMMAND) whole = true; else mine.push(id);
            continue;
          }
          const key = JSON.stringify(found);
          const group = groups.get(key)
            ?? { command: share.command, ...(share.chain ? { chain: share.chain } : {}), failures: [], ...found };
          if (id !== WHOLE_COMMAND) group.failures.push(id);
          groups.set(key, group);
        }
        if (mine.length || whole) own.push({ ...share, failures: mine });
        inherited.push(...groups.values());
      }
    }
    return { own, inherited };
  }

  /**
   * The sibling whose recorded `wipRed` names this red (control-tower phase 89):
   * the same line (or the chain it is a member of), the same failing test or
   * the whole line, on a WIP commit the verified head carries.
   */
  private async wipRedOwner(
    phase: number, share: RedShare, id: string, verified: { top: string; head: string | null },
  ): Promise<number | undefined> {
    const lines = new Set([foldCommand(share.command), ...(share.chain ? [foldCommand(share.chain)] : [])]);
    for (const other of Object.values(this.state!.phases)) {
      const wip = other.wipRed;
      if (other.phase === phase || !wip?.lines?.length || !verified.head) continue;
      const hit = wip.lines.find((line) => lines.has(line.command)
        && (id === WHOLE_COMMAND || !line.failures?.length || line.failures.includes(id)));
      if (hit && await inHistory(verified.top, wip.sha, verified.head)) return other.phase;
    }
    return undefined;
  }

  /** Who wrote each uncommitted path of the verified repository — null when there is none, or git cannot say. */
  private async wipOf(phase: number, top: string, windows: readonly SessionWindow[]): Promise<Map<string, WipOwner> | null> {
    const dirty = await uncommittedPaths(top).catch(() => null);
    return dirty?.paths.length ? wipOwners(dirty.paths, windows, phase) : null;
  }

  /**
   * The trees this line was clean of this red on, latest first: the session's
   * own proof of it (a green chain proves each of its members), then the
   * ledger's runs of it — and, for a chain's member, the chain's green runs.
   */
  private cleanRefs(share: RedShare, id: string, rows: readonly LedgerRow[], proofs: ProofJudgement | null): string[] {
    const out: string[] = [];
    const proof = proofs?.recorded.get(foldCommand(share.chain ?? share.command));
    if (proof && proof.code === 0) out.push(proof.tree);
    out.push(...cleanTrees(rows, share.command, id));
    if (share.chain) out.push(...cleanTrees(rows, share.chain, WHOLE_COMMAND));
    return [...new Set(out)].slice(0, 4);
  }

  /**
   * Each inherited red with ONE owner is OWED on that owner's record (#103, the
   * fifth amendment) — where its own work is read — and journalled against it.
   * An owner this run keeps no record for (a phase of an earlier run, charged
   * in the ledger) has the ledger and this phase's `phase.verify-inherited`
   * line; several candidates owe nothing, since naming one would be a guess.
   */
  private recordOwed(phase: number, inherited: readonly InheritedRed[]): void {
    const state = this.state!;
    const at = this.now().toISOString();
    const byOwner = new Map<number, InheritedRed[]>();
    for (const red of inherited) {
      if (red.owner === undefined || red.owner === phase || !red.how) continue;
      if (!Object.values(state.phases).some((record) => record.phase === red.owner)) continue;
      byOwner.set(red.owner, [...(byOwner.get(red.owner) ?? []), red]);
    }
    for (const [owner, reds] of byOwner) {
      const record = phaseRecord(state, owner);
      const owed: OwedRed[] = [...(record.owed ?? [])];
      for (const red of reds) {
        const same = (entry: OwedRed) => entry.command === red.command && (entry.chain ?? '') === (red.chain ?? '');
        const before = owed.find(same);
        const failures = [...new Set([...(before?.failures ?? []), ...red.failures])];
        const paths = [...new Set([...(before?.paths ?? []), ...(red.paths ?? [])])].slice(0, 20);
        const entry: OwedRed = {
          command: red.command, ...(red.chain ? { chain: red.chain } : {}), failures, by: phase, at, how: red.how!,
          ...(paths.length ? { paths } : {}),
        };
        if (before) owed[owed.indexOf(before)] = entry; else owed.push(entry);
      }
      record.owed = owed;
      this.record('phase.verify-owed', {
        by: phase,
        reds: reds.map((red) => ({
          command: red.command, ...(red.chain ? { chain: red.chain } : {}), failures: red.failures, how: red.how,
          ...(red.paths?.length ? { paths: red.paths } : {}),
        })),
      }, owner);
    }
  }

  /**
   * A red `&&` chain, member by member (#103's chained-gate comment): each run
   * ALONE, with no cascade, under the chain's own clock. What the members read
   * — every final row the console ran; a member it could not run is simply not
   * among them.
   */
  private async runMembers(
    chain: string, purpose: 'baseline' | 'attribution',
    opts: { cwd: string; inPlace?: string; approvals?: VerifyApprovals; timeoutFor?: (command: string) => number },
  ): Promise<VerifyRun[]> {
    const members = chainMembers(chain);
    if (!members || this.abort?.signal.aborted || this.stopRequested) return [];
    const verify = this.deps.verify ?? verifyPhase;
    const limit = opts.timeoutFor?.(chain) ?? VERIFY_TIMEOUT_MS;
    const ran = await verify(members.map((member) => `- \`${member}\``).join('\n'), {
      cwd: opts.cwd, purpose, cascade: false,
      ...(opts.inPlace ? { inPlace: opts.inPlace } : {}),
      ...(opts.approvals ? { approvals: opts.approvals } : {}),
      preflightSkip: this.verifyEnv().preflightSkip,
      timeoutMs: limit, timeoutFor: () => limit,
      signal: this.abort?.signal ?? undefined,
    }).then((summary) => summary.ran, () => [] as VerifyRun[]);
    return RunnerAttempt.finalRows(ran).filter((row) => !row.proven);
  }

  /** Baselines measuring BESIDE their phase's session (control-tower phase 105, BL-3), by phase. */
  private readonly baselines = new Map<number, Promise<void>>();
  /** Phases whose verdict waits on its baseline — the load guard holds it no longer. */
  private readonly baselineAwaited = new Set<number>();

  /**
   * The phase's §Verification BASELINE (control-tower phase 83, #103): what
   * its lines read on the tree it boards on, before its session touches it.
   * Taken once per phase per run — a phase boarded again keeps its first, so
   * its own half-done work can never become its baseline.
   *
   * Since control-tower phase 105 (#190) it no longer holds the boarding:
   *  - a line is measured ONCE — a red baseline line is never retried, the
   *    retry being the verdict's alone (BL-1);
   *  - a line already measured on the same tree, command, environment digest
   *    and directory by ANY plan, phase or run of this console within
   *    `BASELINE_REUSE_MAX_AGE_MS` stands in, named with its source and age
   *    (BL-2);
   *  - the rest runs BESIDE the session, in a clean checkout of the boarding
   *    head the session never touches, niced and under the machine-load guard;
   *    the session hears the result as a next-turn note, and the verdict
   *    awaits a baseline still running (`awaitBaseline`) — never drops it
   *    (BL-3). A repository git will not export (a superproject) is measured
   *    here, before boarding, under phase 89's tree rule, as it always was.
   * A red `&&` chain is broken into its members, each measured alone (the
   * fifth amendment), so a member the chain's first red hid has a baseline.
   */
  protected async takeBaseline(phase: number): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    if (record.baseline || this.baselines.has(phase) || this.abort?.signal.aborted) return;
    const text = await this.deps.verificationText(state.slug, phase);
    if (!text?.trim()) return;
    const approvals = this.verifyApprovalsFor(phase);
    const commands = extractCommands(text, 'verify', approvals).commands;
    if (!commands.length) return;
    const setupText = await this.deps.setupText?.(state.slug, phase);
    const inPlace = await this.verifyCwd(phase);
    const beside = await this.exportBoardingHead(phase, inPlace);
    // The same tree rule as the verdict's (control-tower phase 89) where git
    // would not export: a tree holding changes that are not this phase's is
    // measured on a clean checkout of its HEAD, so the baseline and the verdict
    // read alike.
    const exported = beside ? null : await this.exportForVerify(phase, inPlace);
    const cwd = beside?.cwd ?? exported?.cwd ?? inPlace;
    const base = await workingTreeOf(cwd).catch(() => null);
    const job: BaselineJob = {
      phase, text, commands, cwd, base, at: this.now().toISOString(), lines: [],
      ...(setupText ? { setupText } : {}), ...(approvals ? { approvals } : {}),
      exported: Boolean(beside || exported),
      ...(beside || exported ? { inPlace } : {}),
      env: verifyEnvDigest({ ...(setupText ? { setupText } : {}) }),
      dir: base ? withinRepo(base.top, cwd) : '',
      rows: readConsoleLedgers(state.root),
    };
    const missing = commands.filter((command) => !this.reuseBaselineLine(job, command));
    if (beside && missing.length) {
      // BESIDE the session: the boarding goes on at once.
      const measuring = this.measureBaseline(job, missing, beside.made)
        .catch((error: unknown) => {
          this.record('phase.verify-baseline', { failed: String(error).slice(0, 300), concurrent: true }, phase);
        })
        .finally(() => {
          this.baselines.delete(phase);
          this.baselineAwaited.delete(phase);
          void beside.made.remove().catch(() => {});
          this.noteVerifying(phase, null, undefined, { only: 'baseline' });
        });
      this.baselines.set(phase, measuring);
      return;
    }
    try {
      await this.measureBaseline(job, missing, null);
    } finally {
      if (beside) await beside.made.remove().catch(() => {});
    }
  }

  /**
   * A clean checkout of the phase's boarding HEAD for its baseline to run in
   * beside the session (control-tower phase 105, BL-3) — always, not only
   * when a sibling's WIP is in the tree, because the session is about to edit
   * this one. Null where git will not make one (no repository, a superproject).
   */
  private async exportBoardingHead(phase: number, cwd: string): Promise<{ cwd: string; made: ExportCheckout } | null> {
    const tree = await workingTreeOf(cwd).catch(() => null);
    if (!tree?.head) return null;
    const made = await exportCheckout(tree.top, tree.head).catch((error: unknown) => ({ refused: String(error) }));
    if ('refused' in made) {
      this.record('phase.verify-in-place', { reason: 'the baseline is measured before boarding', refused: made.refused, head: tree.head }, phase);
      return null;
    }
    return { cwd: join(made.dir, withinRepo(tree.top, cwd)), made };
  }

  /** A baseline line reused from the console's ledgers, when one stands in (BL-2). */
  private reuseBaselineLine(job: BaselineJob, command: string, chain?: string): boolean {
    if (!job.base) return false;
    const now = Date.now();
    const prior = reusableRun(job.rows, { command, tree: job.base.tree, env: job.env, dir: job.dir, now });
    if (!prior) return false;
    job.lines.push({
      command: prior.command, ...(chain ? { chain: foldCommand(chain) } : {}), ok: prior.ok, code: prior.code,
      ...(prior.failures?.length ? { failures: prior.failures } : {}),
      ...(prior.tail ? { tail: prior.tail } : {}),
      ...(prior.environment ? { environment: prior.environment } : {}),
      from: 'reused',
      by: { phase: prior.phase, run: prior.run, at: prior.at, slug: prior.slug, ageMs: Math.max(0, now - Date.parse(prior.at)) },
    });
    return true;
  }

  /**
   * Measure what could not be reused, record the baseline, journal it — and,
   * when it ran beside the session (`made`), tell the session. The lines are
   * run once each, niced, every command waiting while the machine-load guard
   * holds new work back.
   */
  private async measureBaseline(job: BaselineJob, missing: readonly string[], made: ExportCheckout | null): Promise<void> {
    const state = this.state!;
    const { phase } = job;
    const record = phaseRecord(state, phase);
    const concurrent = made !== null;
    const file = verificationsFile(state.root, state.slug);
    let loadWaitMs = 0;
    let limits: { timeoutFor: (command: string) => number; limit: NonNullable<PhaseRecord['verifyLimit']> } | null = null;
    const limitsFor = async () => (limits ??= await this.verifyLimitsFor(phase, job.text, job.approvals));
    // Before boarding the commands own the lane: the stall detector stands
    // down and the restart drain waits on their limit, as for a verification.
    // Beside a session they own nothing — the session's silence still counts.
    const owning = async (): Promise<void> => {
      if (concurrent || record.baselineSince) return;
      record.baselineSince = job.at;
      record.verifyLimit = (await limitsFor()).limit;
      this.persist();
    };
    const where = { env: job.env, dir: job.dir };
    const measure = (ran: readonly VerifyRun[], chain?: string): void => {
      for (const row of RunnerAttempt.finalRows(ran).filter((entry) => !entry.proven)) {
        job.lines.push({
          command: foldCommand(row.command), ...(chain ? { chain: foldCommand(chain) } : {}), ok: row.ok, code: row.code,
          ...(row.failures?.length ? { failures: row.failures } : {}), from: 'measured',
          // What it said and why the machine stopped it — a baseline's red is
          // read as closely as a verdict's (control-tower phase 106, #195/#185).
          ...(!row.ok && row.output?.trim() ? { tail: outputTail(row.output) } : {}),
          ...(row.environment ? { environment: row.environment } : {}),
          ...(!row.ok && !row.timedOut && !row.environment ? { once: true as const } : {}),
        });
      }
    };
    const seat = {
      purpose: 'baseline' as const, cascade: false, nice: BASELINE_NICE,
      gate: async () => { loadWaitMs += await this.baselineLoadGate(phase); },
      onChild: (pid: number) => this.noteVerifyingChild(phase, pid),
      ...(job.inPlace ? { inPlace: job.inPlace } : {}),
      ...(job.approvals ? { approvals: job.approvals } : {}),
      preflightSkip: this.verifyEnv().preflightSkip,
      signal: this.abort?.signal ?? undefined,
    };
    try {
      if (missing.length) {
        const { timeoutFor } = await limitsFor();
        const verify = this.deps.verify ?? verifyPhase;
        await owning();
        const measured = await verify(job.text, {
          ...seat, cwd: job.cwd, only: new Set(missing.map(foldCommand)),
          onStart: (command, index, total) => this.noteVerifying(phase, 'baseline', { command, index, total }, { startedAt: job.at, exported: job.exported }),
          onSetupStart: (command, index, total) => this.noteVerifying(phase, 'baseline', { command, index, total }, { startedAt: job.at, exported: job.exported, stage: 'setup' }),
          ...(job.setupText ? { setupText: job.setupText } : {}),
          timeoutMs: VERIFY_TIMEOUT_MS, timeoutFor,
        });
        // A stop cut it: nothing was learned, and the next boarding asks again.
        if (this.abort?.signal.aborted || this.stopRequested) return;
        measure(measured.ran);
        appendLedger(file, this.ledgerRows(phase, 'baseline', measured.ran, job.base, [], undefined, where));
      }
      // Each red chain's members, alone — reused where every one already ran
      // on this tree, measured otherwise.
      for (const line of job.lines.filter((entry) => !entry.ok && !entry.chain)) {
        const members = chainMembers(line.command);
        if (!members) continue;
        const chain = job.commands.find((command) => foldCommand(command) === line.command) ?? line.command;
        const reusable = (member: string) => Boolean(job.base && reusableRun(job.rows, {
          command: member, tree: job.base.tree, env: job.env, dir: job.dir,
        }));
        if (members.every(reusable)) {
          for (const member of members) this.reuseBaselineLine(job, member, chain);
          continue;
        }
        await owning();
        const ran = await this.runMembers(chain, 'baseline', {
          cwd: job.cwd, ...(job.inPlace ? { inPlace: job.inPlace } : {}),
          ...(job.approvals ? { approvals: job.approvals } : {}), timeoutFor: (await limitsFor()).timeoutFor,
        });
        if (this.abort?.signal.aborted || this.stopRequested) return;
        measure(ran, chain);
        appendLedger(file, this.ledgerRows(phase, 'baseline', ran, job.base, [], chain, where));
      }
    } finally {
      delete record.baselineSince;
      if (!concurrent) await this.endVerifyPass(phase);
    }
    const lines = job.lines;
    record.baseline = {
      at: job.at, tree: job.base?.tree ?? null, head: job.base?.head ?? null, commands: lines, concurrent,
      ...(loadWaitMs ? { loadWaitMs } : {}),
    };
    const reused = lines.filter((line) => line.from === 'reused');
    const redOnce = lines.filter((line) => line.once).map((line) => line.command);
    const told = concurrent ? this.tellBaseline(phase, record.baseline) : false;
    this.record('phase.verify-baseline', {
      tree: record.baseline.tree, head: record.baseline.head,
      reused: reused.length,
      measured: lines.filter((line) => line.from === 'measured').length,
      red: lines.filter((line) => !line.ok).map((line) => line.command),
      concurrent,
      ...(reused.length ? {
        reusedFrom: reused.map((line) => ({
          command: line.command, slug: line.by?.slug, run: line.by?.run, phase: line.by?.phase, ageMs: line.by?.ageMs,
        })),
      } : {}),
      ...(redOnce.length ? { redOnce } : {}),
      ...(loadWaitMs ? { loadWaitMs } : {}),
      ...(concurrent ? { told } : {}),
    }, phase);
    this.persist();
  }

  /**
   * One baseline command's seat under the machine-load guard (control-tower
   * phase 105; phase 100's guard): while the machine is loaded, new work
   * waits — and a baseline beside a working session is new work. Never once
   * the phase's verdict is waiting on it (that wait would only lengthen the
   * lane), never past `BASELINE_LOAD_WAIT_MAX_MS`, never through a stop.
   * Returns how long it waited.
   */
  private async baselineLoadGate(phase: number): Promise<number> {
    const started = Date.now();
    const poll = this.deps.baselineLoadPollMs ?? BASELINE_LOAD_POLL_MS;
    while (this.deps.machineLoad?.()?.holding === true) {
      if (this.baselineAwaited.has(phase) || this.abort?.signal.aborted || this.stopRequested) break;
      if (Date.now() - started >= BASELINE_LOAD_WAIT_MAX_MS) break;
      await new Promise((done) => setTimeout(done, poll));
    }
    return Date.now() - started;
  }

  /**
   * The baseline is in: the session hears it as its next turn, framed as
   * information and never an instruction (control-tower phase 105, BL-3).
   * False when no session is there to tell — its record and the verdict still
   * have it.
   */
  private tellBaseline(phase: number, baseline: VerifyBaseline): boolean | 'queued' {
    const mark = `[[baseline:${randomUUID().replace(/-/g, '').slice(0, 8)}]]`;
    const note = frameBaselineNote(baseline, mark);
    const handle = this.lanes.get(phase)?.handle;
    if (handle?.open()) {
      try { if (handle.send(note)) return true; } catch { /* the session stopped taking input */ }
      return false;
    }
    // Landed before the session could hear it (a quick baseline, a slow
    // spawn): held for the session's first handle, never lost.
    if (!this.lanes.has(phase)) return false;
    this.baselineNotes.set(phase, note);
    return 'queued';
  }

  /** Notes held for a session that had no handle yet when its baseline landed. */
  private readonly baselineNotes = new Map<number, string>();

  private flushBaselineNote(phase: number): void {
    const note = this.baselineNotes.get(phase);
    const handle = this.lanes.get(phase)?.handle;
    if (!note || !handle?.open()) return;
    this.baselineNotes.delete(phase);
    try { handle.send(note); } catch { /* the session stopped taking input */ }
  }

  /**
   * Wait for a baseline still measuring beside the phase's session before
   * anything is judged against it (control-tower phase 105, BL-3): the verdict
   * compares against it exactly as it always did, so it is awaited — never
   * dropped. The load guard stops holding it the moment this is asked.
   */
  protected async awaitBaseline(phase: number): Promise<void> {
    const pending = this.baselines.get(phase);
    if (!pending) return;
    this.baselineAwaited.add(phase);
    await pending;
  }

  protected async settleBaselines(): Promise<void> {
    for (const phase of this.baselines.keys()) this.baselineAwaited.add(phase);
    await Promise.allSettled([...this.baselines.values()]);
  }

  /**
   * The `verify-timeout` outcome (control-tower phase 83, #95): a command its
   * clock cut on its LAST attempt — the second at twice the limit, run by the
   * console with no session. Not a red verdict: nothing is re-opened, nothing
   * is charged to the streak. The phase parks for a person, and so does the
   * run — the board already reads done (the handoff is complete), so a parked
   * record in a driving loop would be reconciled to done on the next tick, an
   * unverified phase passing silently (the `verification-preflight` park's
   * reason, and its shape).
   */
  private verifyTimedOut(phase: number, verification: VerifySummary, cut: readonly VerifyRun[], stamps: readonly TreeStamp[]): boolean {
    const record = phaseRecord(this.state!, phase);
    const commands = cut.map((row) => row.command);
    const limits = verification.ran
      .filter((row) => commands.includes(row.command) && row.timedOut && row.limitMs)
      .map((row) => row.limitMs!);
    const clock = limits.length ? ` (cut at ${limits.map(limitWords).join(', then ')})` : '';
    record.status = 'parked';
    record.endedAt = new Date().toISOString();
    record.note = `§Verification timed out${comparedClause(stamps)}: ${commands.map((c) => `\`${c}\``).join(', ')} ran past `
      + `its clock twice${clock} — not a red, and not charged. Raise the phase's \`- **Verify timeout:**\` `
      + '(or the plan\'s `**Verify timeout:**`), or look for a hang, then Re-check.';
    this.record('phase.verify-timeout', {
      commands, limits, retried: true, reason: verification.reason,
      ...(stamps.length ? { trees: stamps } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'parked', note: record.note });
    this.park(`phase ${phase}'s §Verification timed out: ${commands.join(', ')} ran past its clock twice`, phase, 'verify-timeout');
    return false;
  }

  /**
   * `confirmPass`, with its clean checkout and its lane always given back
   * (control-tower phase 89): the pass ends them itself once the last command
   * has run; this is the backstop for one that returns early or throws.
   */
  private async confirm(phase: number): Promise<boolean> {
    try {
      return await this.confirmPass(phase);
    } finally {
      await this.endVerifyPass(phase);
    }
  }

  /** The clean checkouts a verification pass is running in, by phase — see `exportForVerify`. */
  private readonly verifyExports = new Map<number, ExportCheckout>();

  /**
   * Where phase N's §Verification must run (control-tower phase 89, #103,
   * #41): null — in place — when the verified repository's working tree holds
   * nothing but the phase's own changes (phase 83's ownership: each
   * uncommitted path's last write against the run's session windows) and
   * paperwork; otherwise a clean checkout of its HEAD (`exportCheckout`), and
   * the verdict says why. The trigger is exact: ONE uncommitted, non-paperwork
   * path whose writer is not this phase's session — another phase's, or
   * nobody's for sure. A checkout git refuses is journalled and the pass runs
   * in place, as before.
   */
  private async exportForVerify(phase: number, cwd: string): Promise<{ cwd: string; export: VerifyExport } | null> {
    const dirty = await uncommittedPaths(cwd).catch(() => null);
    const paths = (dirty?.paths ?? []).filter((entry) => !isPaperwork(entry.path));
    if (!dirty || !paths.length) return null;
    const owners = wipOwners(paths, this.sessionWindows(), phase);
    const untracked = new Set(paths.filter((entry) => entry.untracked).map((entry) => entry.path));
    const setupText = await this.deps.setupText?.(this.state!.slug, phase);
    const foreign = [...owners].filter(([path, owner]) => isForeignWip(path, owner, untracked.has(path), setupText));
    if (!foreign.length) return null;
    const head = await commitOf(dirty.top, 'HEAD');
    if (!head) return null;
    const whose = [...new Set(foreign.map(([, owner]) => (typeof owner === 'number' ? owner : null)))];
    const named = whose.map((owner) => (owner === null ? 'nobody\'s for sure' : `phase ${owner}'s`)).join(' and ');
    const reason = `the working tree held ${foreign.length} uncommitted path(s) that are not this phase's own (${named})`;
    const made = await exportCheckout(dirty.top, head).catch((error: unknown) => ({ refused: String(error) }));
    const summary: VerifyExport = {
      head, repo: dirty.top, reason, paths: foreign.map(([path]) => path).sort().slice(0, 20), owners: whose,
    };
    if ('refused' in made) {
      this.record('phase.verify-in-place', { reason, refused: made.refused, head }, phase);
      return null;
    }
    this.verifyExports.set(phase, made);
    return { cwd: join(made.dir, withinRepo(dirty.top, cwd)), export: summary };
  }

  /** The pass is over: its clean checkout goes, and the console's lane with it. */
  private async endVerifyPass(phase: number): Promise<void> {
    const made = this.verifyExports.get(phase);
    this.verifyExports.delete(phase);
    if (made) await made.remove().catch(() => {});
    // A baseline still measuring beside the session keeps its own lane entry
    // and its own checkout (control-tower phase 105): it ends them itself.
    this.noteVerifying(phase, null, undefined, this.baselines.has(phase) ? { only: 'verify' } : {});
  }

  /**
   * The loopback ports the phase's session served on — what makes a refused
   * connection an `environment` outcome rather than a red (control-tower phase
   * 89): read off the lane while it stands, else the record.
   */
  private ownPortsOf(phase: number): number[] {
    return this.lanes.get(phase)?.signals.ownPorts ?? phaseRecord(this.state!, phase).ownPorts ?? [];
  }

  private async confirmPass(phase: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    record.status = 'verifying';
    // Two readers, one clock. The live detector suppresses every stall signal
    // while this is set, because the session has exited and the §Verification
    // commands own the next several minutes; the inbox's `verify-hanging` row
    // measures the wait from it. `confirmed` is the only writer, and it clears
    // it however this returns.
    record.verifyingSince = this.now().toISOString();
    this.emit('phase', { phase, status: 'verifying' });

    /* The session's declared outcome, read once and journalled. The board
     * outranks it — a done board with a waiting outcome means the wait was
     * about nothing — so `closed()` consults it only when the board is not
     * done. Its absence means what it always meant: the session declared
     * nothing, and every legacy path below is unchanged. */
    const declared = this.takeOutcome(phase);

    /* …and the last of the task list, on the way past. The stream triggers
     * (`tool-result`, `step`) cannot cover the final write: a session that
     * marks its last task complete and stops emits nothing afterwards, so the
     * tail that never ran would leave the panel one row short of the truth for
     * ever. One read, and the record is closed with the list the session
     * actually ended on. */
    if (this.drainTasks(phase)) this.persist();

    /* 0. the board, re-read from disk — never the session's word for it.
     *
     * First, because it is free and it is decisive. It used to run last, after
     * the verification commands and after up to twelve hours of waiting for a
     * person to hand-confirm the fragments the runner would not execute — and
     * then threw their answer away, because the phase had never written a
     * handoff at all. Nobody should be asked to vouch for a phase that produced
     * nothing, and no test suite should be run to prove one. */
    const closed = await this.closed(phase, declared);
    if (closed === 'waiting') return true; // parked or re-queued; the run carries on
    // The console was frozen mid-settle. `carryOn` so the lane resolves and the
    // loop returns to its top, where the `frozen` branch owns the run — and
    // NOT into the verification below, which would run a full suite under a
    // freeze the operator pressed to stop exactly that kind of work.
    if (closed === 'frozen') return true;
    // 🔴 `confirm()` answers "is this phase DONE", not "should the loop carry
    // on" — the two were briefly conflated here, which made a recovery treat a
    // halted phase as a success. The carry-on decision for a phase-level ending
    // lives at the ONE place that computes it, in `runAttempt` below.
    if (closed === 'halted') return false;
    // Cut by the console (a shutdown, a stop): settled `interrupted`, not done.
    if (closed === 'interrupted') return false;

    /* 1. the plan's own verification commands — compared against the
     * baseline, so one still measuring beside the session is awaited first
     * (control-tower phase 105, BL-3): never dropped, never raced. */
    await this.awaitBaseline(phase);
    const text = await this.deps.verificationText(state.slug, phase);
    // Read beside the verification text and handed straight through: the
    // preamble is the phase's, not the run's, and `verifyPhase` owns the rule
    // that it can never colour the verdict.
    const setupText = await this.deps.setupText?.(state.slug, phase);
    const verify = this.deps.verify ?? verifyPhase;
    const cwd = await this.verifyCwd(phase);
    // A phase that squash-merged the run branch (a release) is checked against
    // what LANDED, not the pre-squash tip its checkout still stands on
    // (control-tower phase 112, #183) — only with no other lane live, so no
    // tree moves under a working session.
    if (text?.trim() && [...this.lanes.keys()].every((other) => other === phase)) await this.reseatLanded(state);
    // The LAST phase's checks run over a mirror without the run's own idle
    // branches (control-tower phase 62, #47) — before the stamps, so they
    // name what the commands really read.
    if (text?.trim()) await this.settleIdleMirror(phase);
    // What the commands are about to compare against — `{repo, branch, head}`
    // of every repository they could read (control-tower phase 40, #41).
    const stamps = await this.stampVerification(phase, cwd, text);
    const approvals = this.verifyApprovalsFor(phase);
    // The opt-in the preflight honoured, honoured here too: a phase that
    // states no verification passes on its handoff, and the record says
    // WAIVED rather than "0 commands green" (`allowUnverifiedPhases`).
    const waived = !text?.trim() && this.deps.allowUnverifiedPhases?.() === true;
    if (waived) {
      this.record('phase.verify-waived', {
        stage: 'verify', reason: 'the plan states no verification', by: 'allowUnverifiedPhases',
      }, phase);
    }
    // And the operator's answer at the start door: every check this phase's
    // plan wrote was set aside, so it passes on its handoff — the same shape,
    // signed `launch` rather than by a preference.
    const setAside = !waived && approvals?.waive?.size ? extractCommands(text, 'verify', approvals) : null;
    const allWaived = Boolean(setAside && !setAside.commands.length && !setAside.notRun.length && setAside.waived.length);
    if (allWaived) {
      this.record('phase.verify-waived', {
        stage: 'verify', reason: 'every check was waived at the run\'s start', by: 'launch', notRun: setAside!.waived,
      }, phase);
    }
    // What the session proved itself (control-tower phase 62, #68): a command
    // it recorded green at an equivalent tree is not run again. Nothing on file
    // costs nothing — git is asked only when a proof exists.
    const proofs = waived || allWaived ? null : await this.sessionProofs(phase, cwd);
    // Each command's own clock (control-tower phase 83, #95), stored where the
    // restart drain reads it, and the tree the commands are about to read —
    // what the ledger files this run under, for the next phase's baseline.
    const measuring = !waived && !allWaived;
    const limits = measuring ? await this.verifyLimitsFor(phase, text, approvals) : null;
    if (limits) record.verifyLimit = limits.limit;
    // The tree the commands read must be the PHASE's (control-tower phase 89,
    // #103, #41): a working tree carrying changes that are not its own — a
    // sibling's uncommitted WIP, anything no session of the phase wrote — is
    // set aside by running in a clean checkout of the phase's HEAD. A clean
    // tree, or one holding only the phase's own changes, verifies in place.
    const exported = measuring ? await this.exportForVerify(phase, cwd) : null;
    const runCwd = exported?.cwd ?? cwd;
    const startedAt = this.now().toISOString();
    const verifiedTree = measuring ? await workingTreeOf(runCwd).catch(() => null) : null;
    const verification: VerifySummary = waived ? {
      ok: true, ran: [], notRun: [],
      reason: 'the plan states no verification for this phase — passed on the handoff (allowUnverifiedPhases)',
    } : allWaived ? {
      ok: true, ran: [], notRun: [], waived: setAside!.waived,
      reason: 'every check in this phase\'s §Verification was waived at the run\'s start — passed on the handoff',
    } : await verify(text, {
      cwd: runCwd,
      // An export stands in for the working tree: what it cannot provide is
      // the machine's, never a red (control-tower phase 106, #191).
      ...(exported ? { inPlace: cwd } : {}),
      ...(setupText ? { setupText } : {}),
      ...(approvals ? { approvals } : {}),
      ...(proofs?.proven.size ? { proven: proofs.proven } : {}),
      ...(this.ownPortsOf(phase).length ? { ownPorts: this.ownPortsOf(phase) } : {}),
      preflightSkip: this.verifyEnv().preflightSkip,
      // Explicit, and longer than the 15-minute default: a real phase's
      // verification is a full suite, sometimes a container build, and the
      // default turned a slow-but-passing check into a red one that proved
      // nothing. Still bounded — a wedged command must end. Each line's own
      // limit wins over it (#95): the plan's word, else its measured history.
      timeoutMs: VERIFY_TIMEOUT_MS,
      ...(limits ? { timeoutFor: limits.timeoutFor } : {}),
      signal: this.abort?.signal ?? undefined,
      onStart: (command, index, total) => {
        this.noteVerifying(phase, 'verify', { command, index, total }, { startedAt, exported: Boolean(exported) });
        this.emit('verify', { phase, command, index, total });
      },
      // The pairing event. Everything below reaches the client only AFTER the
      // whole verification returns (`phase.verify`, then the attempt-comparison
      // view), so before this a running suite was one `[1/2]` line and then
      // nothing: no exit code, no elapsed time, no `[2/2]`.
      onDone: (result, index, total) => {
        this.emit('verify', {
          phase, command: result.command, index, total,
          ok: result.ok, code: result.code, ms: result.ms,
          ...(result.retry ? { retry: true } : {}),
          // Only when it is red. A green suite's log is not what anyone is
          // watching for, and it is the one that is megabytes.
          ...(result.ok ? {} : { tail: result.output.slice(-VERIFY_TAIL_CHARS) }),
        });
      },
      // F17's skips, while they happen rather than as a park with no history.
      onSkip: (skipped) => {
        this.emit('verify', { phase, skipped: skipped.map((s) => ({ ...s })) });
      },
    });
    record.verification = withStamps(verification, stamps);
    if (exported) record.verification.export = exported.export;
    // The ONE verdict (control-tower phase 45) — and only the phase's OWN reds
    // are its verdict (control-tower phase 83, #103). A red its baseline
    // already had — the tree it boarded on — came with that tree: it is
    // recorded inherited, with its owner, and charged to nobody here. With no
    // baseline every red is the phase's, as it always was. A command its clock
    // cut (#95) is neither: `verdict.timedOut`, the `verify-timeout` outcome.
    const verdict = verificationVerdict(verification.ran);
    // Since the fifth amendment (#103's 2026-09-25 comments) a red `&&` chain
    // is judged member by member, each run alone — the red its first member
    // hid is seen — and EVERY red is attributed before it counts: a new red
    // another phase's commit or uncommitted work introduced is that phase's,
    // and OWED on its record, never this one's.
    const members: { chain: string; ran: VerifyRun[] }[] = [];
    const reds: RedRow[] = [];
    for (const row of verdict.broke) {
      const ran = measuring && chainMembers(row.command)
        ? await this.runMembers(row.command, 'attribution', {
          cwd: runCwd, ...(exported ? { inPlace: cwd } : {}),
          ...(approvals ? { approvals } : {}), ...(limits ? { timeoutFor: limits.timeoutFor } : {}),
        })
        : [];
      if (ran.length) members.push({ chain: row.command, ran });
      const red = ran.filter((entry) => !entry.ok && !entry.timedOut);
      if (red.length) reds.push(...red.map((entry) => ({ command: entry.command, failures: entry.failures, chain: row.command })));
      else reds.push(row);
    }
    const split = splitReds(reds, record.baseline?.commands);
    const ledgerRowsNow = measuring ? readLedger(verificationsFile(state.root, state.slug), state.slug) : [];
    const attributed = measuring && reds.length && !this.abort?.signal.aborted && !this.stopRequested
      ? await this.attribute(phase, split, ledgerRowsNow, verifiedTree, proofs)
      : { own: split.own, inherited: split.inherited.map((share): InheritedRed => ({ ...share })) };
    // Nothing below runs a command: the clean checkout and the console's lane
    // end here (`confirm`'s wrapper is the backstop for a pass that throws).
    await this.endVerifyPass(phase);
    const broke = verdict.broke.filter((row) => attributed.own.some((share) => (share.chain ?? share.command) === row.command));
    // Every red inherited, nothing cut: the phase's own work verified.
    const inheritedOnly = !verification.ok && verdict.broke.length > 0 && !broke.length && !verdict.timedOut.length;
    // …and a line the MACHINE failed (control-tower phase 89, #41): an exit
    // 127, a named precondition, the session's own server gone. Unproven — never
    // red, never charged, never a re-open — and said on the record.
    const unprovenOnly = !verification.ok && !broke.length && !verdict.timedOut.length && verdict.unproven.length > 0;
    const passed = verification.ok || inheritedOnly || unprovenOnly;
    // A partial set-aside rides the same line, so the record names the checks
    // the operator answered at the door rather than letting them vanish.
    if (!allWaived && verification.waived?.length) {
      this.record('phase.verify-waived', {
        stage: 'verify', reason: `${verification.waived.length} check(s) waived at the run's start`,
        by: 'launch', notRun: verification.waived,
      }, phase);
    }
    // The verdict, on the same channel — so a reader who watched the checklist
    // fill in also sees it close, and one who arrived late sees only this.
    this.emit('verify', {
      phase,
      summary: {
        ok: verification.ok,
        reason: verification.reason,
        ran: verification.ran.length,
        notRun: verification.notRun.length,
        skipped: verification.skipped?.length ?? 0,
      },
    });
    // Against the RESOLVED root, the same base `verifyCwd` measured from.
    // `state.root` can be a symlinked path (`/var/…` → `/private/var/…` on
    // macOS), and relating a resolved path to an unresolved one yields a string
    // of `../..` that names the right directory and reads as an escape.
    // Against the lane's own root, which is `state.root` on every run that did
    // not opt into worktrees — so this string keeps meaning "where under the
    // tree the phase worked in", rather than becoming a path full of `../..`
    // the moment a lane has its own checkout somewhere else entirely.
    record.verifiedIn = relative(resolve(this.laneRoot(phase)), cwd) || '.';
    this.record('phase.verify', {
      ok: verification.ok, reason: verification.reason,
      // Where they ran. A verification that passed in the wrong directory and
      // one that passed in the right one are indistinguishable without this.
      cwd: record.verifiedIn,
      // `retry` rides the row: without it the journal could not tell a rescued
      // command's two attempts from two commands (control-tower phase 45).
      ran: verification.ran.map((r) => ({
        command: r.command, code: r.code, ms: r.ms,
        ...(r.retry ? { retry: true } : {}),
        // Not run by the console: the session proved it (control-tower phase 62).
        ...(r.proven ? { proven: true } : {}),
        // Cut by its clock, not exited 124 (control-tower phase 83, #95).
        ...(r.timedOut ? { timedOut: true } : {}),
        // The machine, not the work (control-tower phase 89).
        ...(r.environment ? { environment: r.environment } : {}),
      })),
      notRun: verification.notRun,
      ...(verification.skipped?.length ? { skipped: verification.skipped } : {}),
      ...(stamps.length ? { trees: stamps } : {}),
      // Run on a clean checkout, and why (control-tower phase 89) — the verdict says so.
      ...(exported ? { export: exported.export } : {}),
      ...(verification.unproven?.length ? { unproven: verification.unproven } : {}),
    }, phase);
    if (proofs) this.recordProofVerdicts(phase, proofs, verification.ran);
    // A settle holds only for a verdict that closes the phase: anything else
    // brings sessions back into the mirror, so its branches come back now.
    if (!passed) await this.restoreIdleMirror('not-green');

    // The console is stopping: whatever the summary claims, nothing more can
    // be proven or settled in this pass. The record keeps its in-flight
    // status — teardown writes `interrupted`, and reconcile owns it from
    // there — because a shutdown once produced `ok: true "0 commands green"`
    // over three commands that never ran, and the phase settled done on it.
    if (this.abort?.signal.aborted || this.stopRequested) {
      this.record('phase.verify-stopped', { ran: verification.ran.length, notRun: verification.notRun.length }, phase);
      // …and the proof is OWED, not waived (control-tower phase 48, #69): the
      // next drive re-runs it before reconcile may close the record on the
      // board's word, which is how a phase once settled done with none of its
      // commands run.
      record.reverify = {
        at: this.now().toISOString(),
        cause: this.stopRequested && !this.shuttingDown ? 'stop' : 'shutdown',
        ran: verification.ran.length,
        notRun: verification.notRun.length,
      };
      this.persist();
      return false;
    }

    // Every command's lead is missing from this machine: nothing ran, nothing
    // was proven either way. Boarding parks on exactly this fact before a
    // session is spent (`preflightVerification`); when it is only discovered
    // here — a harness-injected verifier, a PATH that changed mid-phase — the
    // disposition is the SAME park, with the same sentence, not a twelve-hour
    // card asking a person to vouch for checks a machine simply lacks.
    if (!verification.ran.length && verification.skipped?.length) {
      const leads = [...new Set(verification.skipped.map((entry) => entry.lead))];
      record.status = 'parked';
      record.note = allLeadsMissingPark(phase, leads);
      record.endedAt = new Date().toISOString();
      this.record('phase.verify-unrunnable', { leads, skipped: verification.skipped.length }, phase);
      this.emit('phase', { phase, status: 'parked', note: record.note });
      // The RUN parks too, as the card's timeout does: the board already reads
      // done (the session wrote its handoff), so a parked record left in a
      // driving loop would be reconciled to done on the very next tick — an
      // unverified phase passing silently. A person (or a PATH fix and a
      // Retry) settles it; Continue afterwards lets the board's word stand.
      this.park(record.note, phase, 'verification-preflight');
      return false;
    }

    // A command that ran and failed is a verdict. A verification that could not
    // be run is not — it is an unanswered question, and answering it with
    // "failed" is how this run ended up stopped on a phase nothing had actually
    // found fault with, showing a Retry button that could only ever reproduce
    // the same non-result. The two are now told apart.
    //
    // And a command's verdict is its LAST attempt (control-tower phase 45,
    // #45). This read `ran.filter(!ok)`, which counted the rescued first row of
    // a command green on its retry — so `verification.ok` said true, the board
    // check below was skipped, and the phase halted `verify-failed` in the same
    // second. Every verify-failed halt of the measured week was that shape.
    if (measuring) {
      const ledger = verificationsFile(state.root, state.slug);
      if (attributed.inherited.length) {
        record.verification.inherited = attributed.inherited;
        this.record('phase.verify-inherited', {
          inherited: attributed.inherited, own: attributed.own,
          ...(record.baseline ? { baseline: { tree: record.baseline.tree, head: record.baseline.head, at: record.baseline.at } } : {}),
        }, phase);
        this.recordOwed(phase, attributed.inherited);
      }
      // Under the key a later baseline reuses it by (control-tower phase 105):
      // the environment digest and the directory within the repository.
      const where = verifiedTree
        ? { env: verifyEnvDigest({ ...(setupText ? { setupText } : {}) }), dir: withinRepo(verifiedTree.top, runCwd) }
        : undefined;
      appendLedger(ledger, this.ledgerRows(phase, 'verify', verification.ran, verifiedTree, attributed.own, undefined, where));
      for (const { chain, ran } of members) {
        appendLedger(ledger, this.ledgerRows(phase, 'verify', ran, verifiedTree, attributed.own, chain, where));
      }
      // What this phase OWED is paid by its own line running green here — or,
      // for a chain's member, by that member green alone while the chain is
      // red for another.
      if (record.owed?.length) {
        const green = new Set(RunnerAttempt.finalRows(verification.ran).filter((row) => row.ok).map((row) => foldCommand(row.command)));
        for (const { chain, ran } of members) {
          for (const row of ran) if (row.ok) green.add(`${foldCommand(chain)}\u0000${foldCommand(row.command)}`);
        }
        record.owed = record.owed.filter((entry) => !green.has(foldCommand(entry.chain ?? entry.command))
          && !(entry.chain && green.has(`${foldCommand(entry.chain)}\u0000${foldCommand(entry.command)}`)));
        if (!record.owed.length) delete record.owed;
      }
    }
    // The halt the board retracts. Measured in one night: state-path-hardening
    // raised SEVEN verify-failed halts and console-concurrent-plans an eighth —
    // in every one the session had finished its work and written a COMPLETE
    // handoff, the halt fired an urgent push and stopped the run, and sixty
    // seconds later reconcile read the board (the one authority on done) and
    // dissolved the halt as if nothing had happened. A stop the system itself
    // retracts a minute later is not a safety net; it is an alarm wired to a
    // self-closing door. So ask the board FIRST — the same read reconcile
    // would make — and when it says done, let its word stand NOW: the phase
    // settles, the red verdict stays on the record (`verification.ok` is
    // false; QA gating and people read it), and the run keeps driving. The
    // halts below survive for the case they were written for: a red
    // verification over work the board does NOT vouch for.
    const overtaken = !passed && await this.boardOvertookVerification(phase);
    // …and since control-tower phase 62 (#68) the board's word no longer stands
    // over a red FINAL verdict. Letting it stand made §Verification a record
    // rather than a gate: the verdict travelled on a record that read `done`,
    // the dependents boarded on it, and nothing the red said could change any
    // outcome — while its retries held the lock and the scope grant (2.0 h of
    // still-red retry rows in one week). The phase is RE-OPENED instead: one
    // fix rung, its dependents held, and the halt-that-reconcile-dissolves the
    // board-first rule was written against cannot come back, because the
    // re-opened record is exactly what reconcile now leaves alone.
    if (broke.length && overtaken) return this.reopen(phase, verification, broke, stamps);
    if (broke.length && !overtaken) {
      record.status = 'failed';
      this.chargeFailure(phase, 'verify-red', 'verification failed');
      this.halt(
        `phase ${phase} did not verify${comparedClause(stamps)}: ${broke.length} of ${verification.ran.length} command(s) failed `
        + `— ${broke.map((r) => r.command).join(', ')}`
        + await this.verifyHint(phase),
        phase,
        'verify-failed',
      );
      return false;
    }
    // Cut by its clock, twice (#95): not a red, never charged — a person's.
    if (verdict.timedOut.length) return this.verifyTimedOut(phase, verification, verdict.timedOut, stamps);

    /* 2. the plan still lints */
    const lint = readLint(await this.script('validate.sh', [state.slug]));
    record.lint = { ok: lint.ok, summary: lint.summary, ...(lint.crashed ? { crashed: true } : {}) };
    // A reading that PROVED NOTHING is not a verdict, and acting on one is how
    // a run with nothing wrong with it ended up parked (#17). The engine died
    // in the allocator, `readLint` called that a failing plan, and this halt
    // fired after every completed phase of a 71-phase run — each time counting
    // a consecutive failure and withdrawing the queue, which dequeued the
    // scoped siblings waiting behind it. Say so in the journal, where it can be
    // read later, and carry on: the streak, the queue and the phase are
    // untouched, because nothing has been learned about any of them.
    if (lint.crashed || lint.timedOut) {
      this.record('phase.lint-unrun', {
        why: lint.crashed ? 'crashed' : 'timeout', summary: lint.summary,
      }, phase);
    } else if (!lint.ok) {
      record.status = 'failed';
      this.chargeFailure(phase, 'plan-lint', 'the plan stopped linting');
      this.halt(`phase ${phase} left the plan failing validate.sh: ${lint.summary}`, phase, 'plan-lint');
      return false;
    }

    /* 3. and only now, a person — for whatever no machine could settle.
     *
     * Last on purpose. Every check above is free or cheap and answers on its
     * own; a question to a human costs the one resource that does not scale, and
     * an operator asked to confirm things the runner could have checked itself
     * learns to answer without reading. Under `keep-going` a verification that
     * otherwise passed does not stop for this; under the cautious default it
     * always does, which is what that setting means. */
    // Not every `notRun` entry is a question. A command skipped BECAUSE an
    // earlier one exited red, or because the console stopped, is the machine
    // describing its own behaviour — and a card built from those parked a run
    // for 3h52m awaiting a person, over a phase the board had already vouched
    // for, with the red verdict (the actual fact) sitting right beside it.
    // Those entries stay on the record; they just never ask.
    const askable = verification.notRun.filter(
      (n) => n.reason !== CASCADE_SKIP_REASON && n.reason !== STOPPED_SKIP_REASON,
    );
    // And under `keep-going`, a question the board has already answered is not
    // asked again. `overtaken` used to bypass only the HALTS, never the card —
    // so a phase whose commands RAN (red travelling on the record, handoff
    // complete) still parked up to twelve hours on "2 checks only you can
    // make" that were the plan's docker/sleep PREAMBLE, not checks. Measured:
    // a trusted overnight run held ~6 hours for a person to vouch for
    // `sleep 8`. The board's word now stands for the fragments exactly as it
    // stands for the red — but only where a machine measured SOMETHING
    // (`ran` non-empty): a verification that is pure prose has no evidence
    // for the board to overtake, and that card stays, deliberately, whatever
    // the autonomy. `halt-on-everything` keeps asking about everything —
    // that is what the setting means.
    const vouched = overtaken && verification.ran.length > 0;
    if (askable.length && ((!passed && !vouched) || state.autonomy === 'halt-on-everything')) {
      if (!await this.askHuman(phase, verification, askable)) return false;
    } else if (!overtaken && !passed) {
      record.status = 'failed';
      this.chargeFailure(phase, 'verify-red', 'verification failed');
      this.halt(`phase ${phase} did not verify${comparedClause(stamps)}: ${verification.reason}`, phase, 'verify-failed');
      return false;
    }

    record.status = 'done';
    record.endedAt = new Date().toISOString();
    this.lastDonePhase = phase;
    // A re-opened phase that verifies green is closed by that verdict — the only
    // thing that closes it (control-tower phase 62).
    const reopened = record.reopened;
    delete record.reopened;
    // The honest verdict travels with the record: a phase that passed with
    // checks skipped is not the same fact as one whose every check ran.
    if (verification.skipped?.length) {
      record.note = `verified with ${verification.skipped.length} check(s) skipped — unrunnable `
        + `on this machine (${[...new Set(verification.skipped.map((s) => s.lead))].join(', ')})`;
    }
    // Verified on its own work, with reds that are another phase's — its base
    // tree's, a sibling's commit or uncommitted work (control-tower phase 83,
    // #103): said on the record, never charged here.
    if (inheritedOnly) {
      const inherited = record.verification?.inherited ?? [];
      const owners = [...new Set(inherited.flatMap((red) => (red.owner !== undefined ? [red.owner] : red.candidates ?? [])))];
      const count = inherited.reduce((n, red) => n + Math.max(1, red.failures.length), 0);
      record.note = `verified on its own work — ${count} red(s) inherited, not its own`
        + `${owners.length ? `, owned by phase ${owners.join(', phase ')}` : ', owner unknown'}; not charged to this phase`
        + (record.note ? `; ${record.note}` : '');
    }
    // Lines the MACHINE failed (control-tower phase 89): the verdict is not
    // green, and the record says so — unproven, never charged.
    if (unprovenOnly && verification.unproven?.length) {
      record.note = `verified with ${verification.unproven.length} line(s) UNPROVEN — ${verification.unproven[0]!.why}`
        + '; not charged to this phase' + (record.note ? `; ${record.note}` : '');
    }
    // Its own §Verification is green on the lines its wrap-up WIP failed: the WIP is not red any more.
    if (record.wipRed && passed && !broke.length) delete record.wipRed;
    if (overtaken) {
      // The Repos-column hint used to ride the verify-failed halt; with the
      // board's word standing there is no halt to carry it, and losing it
      // would cost exactly the plan edit it exists to prompt. It travels on
      // the record instead, next to the verdict it qualifies.
      record.note = `§Verification is red (${verification.reason})${comparedClause(stamps)} but the handoff already reads `
        + "complete — the board's word stands; the red verdict travels on this record"
        + await this.verifyHint(phase);
      this.record('phase.verify-overtaken', {
        by: 'the board',
        reason: verification.reason,
        ...(broke.length ? { failed: broke.map((r) => r.command) } : {}),
      }, phase);
    }
    resetStreak(state);
    // Not a flat `null`: with another lane still running, clearing the pointer
    // here would tell the console the run was between phases while a session
    // was mid-edit. `syncMirror` moves it to whatever is still live, and only
    // clears it when nothing is.
    if (this.lanes.size > 1) this.syncMirror();
    else state.activePhase = null;
    this.record('phase.done', {
      costUsd: record.costUsd, attempts: record.attempts,
      ...(verification.skipped?.length ? { skippedChecks: verification.skipped.length } : {}),
      ...(reopened ? { reopened: reopened.times } : {}),
      ...(inheritedOnly ? { inherited: record.verification?.inherited?.length ?? 0 } : {}),
      ...(verification.unproven?.length ? { unproven: verification.unproven.length } : {}),
      ...(record.verification?.export ? { exported: true } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'done' });
    // AFTER the phase reads done and its `phase.done` line is journalled, and
    // deliberately: the reviewer reads the diff bracketed by the handoff this
    // phase just wrote, so it cannot run before the phase has finished landing
    // it. It never changes the return value either — a reviewer that fails,
    // times out or is not wired must not turn a phase that passed its own
    // verification into a phase that failed.
    await this.autoReview(phase);
    // After the session reviewer, before the QA verdict, and in the lane this
    // phase worked in. Same contract as both neighbours: bounded, journalled
    // whichever way it goes, and never able to turn a phase that passed its own
    // verification into a phase that failed.
    await this.maybeUltraReview(phase, 'each-phase');
    const qaVerdict = await this.maybeQaVerdict(phase);
    // "Stop and ask me" stops on a QA fail. The eager mode carries on — the
    // ladder owns the fix and the engine holds the dependents — but the
    // cautious mode's whole promise is that nothing moves past a failure a
    // person has not seen, and a recorded `fail` is one. A PHASE-level halt
    // (the record stays `done`: the work happened), and `false` here is what
    // actually stops the lane: `carryOn` reads `confirmed()` before it reads
    // the autonomy.
    if (qaVerdict === 'fail' && state.autonomy === 'halt-on-everything') {
      const rounds = record.qa ?? [];
      const handoffDir = join(state.root, 'docs', 'handoffs', state.slug);
      const report = rounds[rounds.length - 1]?.reportPath
        ?? qaReportPath(phase, Math.max(1, nextQaRound(handoffDir, phase).round - 1));
      this.halt(
        `phase ${phase} recorded a QA fail (${report}) and this run is set to stop and ask — fix what the `
        + 'report names and re-run QA, or waive it with a reason',
        phase, 'needs-human',
      );
      return false;
    }
    return true;
  }

  /**
   * The owed QA verdict, chased at phase finish — warm, inside the lane.
   *
   * A QA-on phase whose session ends without dispatching its verdict used to
   * wait for the qa-pending LADDER rung, which lives in the healer, which
   * refuses live runs — so the verdict was chased only when the whole run
   * parked. Measured: a phase built at 02:42 got its verdict at 10:59, its
   * dependents waiting the entire eight hours. This is the boot prompt's own
   * duty, enforced where the omission is first knowable, on the session that
   * still holds the context (the fresh-context SUBAGENT it dispatches is the
   * independence — SKILL.md §QA).
   *
   * Sited after `phase.done`, like `autoReview`, and with the same contract:
   * bounded (a quarter of the phase budget, the closeout turn cap), journalled
   * either way, and never changes `confirm()`'s verdict. NOT
   * `resumeWithInstruction`: that vehicle flips the just-settled record back
   * to `running` and appends the full closeout procedure — the wrong ask for
   * a verdict-only resume. The ladder stays the capped backstop for anything
   * that escapes this (no session to resume, a resume that records nothing).
   */
  protected async maybeQaVerdict(phase: number): Promise<string | null> {
    const state = this.state;
    if (!state) return null;
    if (this.abort?.signal.aborted || this.stopRequested) return null;
    const record = phaseRecord(state, phase);

    // The phase's OWN regime — plan-wide `off` with a per-phase `- **QA:** on`
    // is the measured shape the plan-wide read missed. Anything unreadable is
    // a no: this path spends money.
    let mode = '';
    try { mode = (await this.engine(['--qa-mode', String(phase)])).stdout.trim(); } catch { return null; }
    if (!/^on\b/.test(mode)) return null;
    let verdict = '';
    try { verdict = (await this.engine(['--qa-result', String(phase)])).stdout.trim().toLowerCase(); } catch { return null; }
    if (verdict && verdict !== 'pending') return verdict; // a verdict exists — nothing owed, and it is the answer

    if (!record.sessionId || isSessionGone(record)) {
      this.record('phase.qa-session-skipped', {
        reason: record.sessionId
          ? `the session ${record.sessionId} is gone (its transcript is not under this account) — the ladder owns it`
          : 'no session left to resume — the ladder owns it',
      }, phase);
      return 'pending';
    }

    // The third session the loop spawns from inside itself, and so the third
    // that no gate above it can see: this passes through neither `startRun` nor
    // `Scheduler.admit`, exactly like the closeout below. Freeze all means
    // nothing starts, and a verdict chased warm is still a session started.
    //
    // A DEFER, not a skip: the verdict is still owed, `record.sessionId` still
    // names the session that holds the context, and the qa-pending ladder rung
    // is the capped backstop that reaches it after the thaw — which is what it
    // has always been for anything that escapes this path.
    const frozen = this.fleetFrozen();
    if (frozen) {
      this.record('phase.qa-session-skipped', {
        reason: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''}, so no verdict session was started`
          + ' — the verdict is still owed and the ladder chases it after the thaw',
        frozen: true,
      }, phase);
      return 'pending';
    }

    const round = await this.qaRound(phase, {
      // The reviewer's slice — reading and dispatching, not rebuilding — is the
      // QA mode's own caps: a quarter of the phase's dollars, a closeout's turns.
      name: `${state.slug} p${phase} qa-verdict`,
    });
    return round?.verdict ?? 'pending';
  }

  /**
   * ONE round: brief a session, let it record a verdict, settle what landed.
   *
   * Extracted from `maybeQaVerdict` when `qaRecover` below needed the same
   * ninety lines with four things different (the instruction, resume vs a fresh
   * boot, the budget, the turn cap). Every hard-won rule in it is a QA round of
   * Phase 4's own review and none of them is obvious:
   *
   *   - the round and its report come from the ONE chooser, never a literal
   *     here (four rounds, four different ways of getting that wrong);
   *   - what landed is taken by DIFFERENCE against a pre-spawn snapshot, keyed
   *     on everything a row says — not "rows at or above the number we briefed",
   *     which dropped a reviewer that recorded under a different one and put a
   *     phantom round on the record;
   *   - nothing gained but a verdict on file is a re-record, and its round is
   *     the newest ROW MATCHING that verdict, never the briefed number.
   *
   * Answers the verdict the file now holds (`''` when the spawn threw), so a
   * loop can decide whether to go round again without re-reading anything.
   */
  protected async qaRound(phase: number, opts: {
    /**
     * The brief. Given the round and report the chooser picked, plus the report
     * the round BEHIND this one wrote — which is the one a fix must read.
     * Absent is the plain verdict instruction.
     */
    instruction?: (ctx: { round: number; report: string; priorReport: string }) => string;
    /** Board fresh from the engine's boot prompt instead of resuming the session. */
    fresh?: boolean;
    /** A dollar cap the caller decided; absent, the QA mode's own (`capsFor`). */
    usd?: Cap;
    /** A turn cap the caller decided; absent, the QA mode's own. */
    turns?: Cap;
    name: string;
    /** Rides the `phase.qa-session` line so a reader can tell the two loops apart. */
    verb?: string;
    /**
     * The verdict already on file, when there is one — so the default brief can
     * stop telling a `qa-rerun`'s fresh reviewer that no verdict exists when the
     * whole premise of that verb is that one does (QA round 2, L5).
     */
    recordedVerdict?: string;
  }): Promise<{ verdict: string; round: number; report: string; costUsd: number; turns: number } | null> {
    const state = this.state;
    if (!state) return null;
    const record = phaseRecord(state, phase);
    const handoffDir = join(state.root, 'docs', 'handoffs', state.slug);
    const { round, report } = nextQaRound(handoffDir, phase);
    const priorReport = qaReportPath(phase, Math.max(1, round - 1));
    const brief = opts.instruction
      ? opts.instruction({ round, report, priorReport })
      : qaVerdictInstruction(state.slug, phase, round, report, opts.recordedVerdict);

    // What the file holds BEFORE the reviewer runs, keyed by everything a row
    // says, so that what it holds afterwards can be taken by DIFFERENCE. The
    // previous shape filtered the re-read by `round >= briefed`, and the disk
    // probe inside the chooser is exactly what makes "briefed" and "settled"
    // different numbers: a reviewer told round 2 (a report on disk no row
    // mentioned) who recorded at round 1 was dropped by that filter, and the
    // synthetic entry below then put a round on the record the ledger does not
    // hold, pointing at a file nobody wrote — and the budget counted it
    // (QA round 5, F1).
    const qaKey = (entry: QaRoundRecord) => `${entry.round}\t${entry.verdict}\t${entry.reportPath ?? ''}`;
    const before = new Set((await this.qaHistory(phase)).map(qaKey));

    // A fresh boarding needs the phase's own boot prompt under the instruction:
    // it has no conversation to continue and knows nothing about the plan.
    let prompt = brief;
    const boardFresh = async (): Promise<boolean> => {
      let boot = '';
      try { boot = (await this.engine(['--boot-prompt', String(phase)], { ...LOCK_MIRROR_ENV, ...this.issuePolicyEnv() })).stdout; } catch { boot = ''; }
      if (!boot.trim()) {
        this.record('phase.qa-session-skipped', {
          reason: `the engine produced no boot prompt for phase ${phase}, so no fresh session could be boarded`,
        }, phase);
        return false;
      }
      prompt = `${boot.trim()}\n\n---\n\n${brief}`;
      return true;
    };
    if (opts.fresh) {
      if (!await boardFresh()) return null;
    } else if (!record.sessionId || isSessionGone(record)) {
      this.record('phase.qa-session-skipped', {
        reason: record.sessionId
          ? `the session ${record.sessionId} is gone (its transcript is not under this account)`
          : 'no session left to resume',
      }, phase);
      return null;
    }

    // The one resumability check every `--resume` takes (`resumableSession`):
    // the transcript is carried to the account paying, and the session is not
    // still running — or the round is not spawned at all. A review that cannot
    // start is not a round that failed. A session not worth resuming
    // (`resumePolicy`, autopilot-token-drain phase 4) is reviewed FRESH instead:
    // the independence comes from the reviewer subagent either way, and one
    // verdict is not worth writing the whole conversation into the cache again.
    const gate = opts.fresh ? null : this.resumableSession(record, record.sessionId);
    const fresh = opts.fresh === true || (gate !== null && !gate.ok && gate.why === 'fresh');
    if (gate && !gate.ok && gate.why === 'fresh') {
      if (!await boardFresh()) return null;
    } else if (gate && !gate.ok) {
      if (gate.why === 'unported') {
        this.markSessionGone(record, record.sessionId!, 'its transcript is not under the account this run pays with');
      }
      this.record('phase.qa-session-skipped', {
        reason: gate.why === 'session-live'
          ? `the session ${record.sessionId} is still running — a review round is not resumed on top of it`
          : `the session ${record.sessionId} cannot be resumed under this account — its transcript is not there`,
      }, phase);
      return null;
    }
    const resume = gate?.ok ? gate.resume : undefined;

    // A review's caps: the QA mode's defaults (a quarter of the phase's dollars,
    // a closeout's turns) unless the caller decided either — a `qa-recover`
    // round's own budget, a fix round's phase-sized turn allowance.
    const caps = capsFor({
      mode: 'qa', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd,
      ...(opts.turns ? { turns: opts.turns } : {}),
      ...(opts.usd ? { usd: opts.usd } : {}),
    });
    // The brief and the report path ride the journal line, because "the brief
    // that was sent" and "the report it was told to write" were exactly what a
    // reader could never recover: this event carried a session id and nothing
    // else, and the report the QA method requires was never linked anywhere.
    this.record('phase.qa-session', {
      ...(fresh ? { fresh: true } : { sessionId: record.sessionId }),
      round, report, brief,
      ...(opts.verb ? { verb: opts.verb } : {}),
    }, phase);
    // The marker every pane reads: a review is in flight on a phase the board
    // reads done. Cleared in the `finally` below, and by the read-path settle
    // should this console die under it.
    record.qaSession = {
      round, report, startedAt: this.now().toISOString(),
      ...(opts.verb ? { verb: opts.verb } : {}),
      ...(resume ? { sessionId: resume.sessionId } : {}),
    };
    // A reviewer reads for a long time and says little; the lane's stall
    // watchdog must judge it from a fresh clock, not from the phase's.
    const lane = this.lanes.get(phase);
    if (lane) lane.signals = newLaneSignals(this.now().getTime());
    this.persist();
    this.emit('phase', { phase, qaSession: true });
    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'qa', {
        prompt,
        // The tree the phase worked in — its lane when it had one — and the
        // run root for the work-state it writes (D6/D7, as `resumeWithInstruction`).
        cwd: this.laneRoot(phase),
        addDirs: this.addDirsFor(phase),
        // QA's own tier, then the phase's, then the run's. The review is a
        // different job from the build and is regularly worth a different model
        // in either direction; until `qaModel`/`qaEffort` existed there was no
        // line anyone could write that would say so. Absent means exactly what
        // it always meant — the builder's settings.
        model: state.qaModel ?? record.model ?? state.model,
        effort: state.qaEffort ?? record.effort ?? state.effort,
        name: opts.name,
        ...(resume ? { resumeFrom: resume } : {}),
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        // The same channels every other spawn gets (`resumeWithInstruction`,
        // `attempt`): the owner every hook reads, the scope, the rulings
        // ledger, and the TASK channel — armed, so the panel that says what a
        // session is doing fills for a review too. Deliberately NO
        // `PE_OUTCOME_FILE`: a reviewer declares no phase outcome; its verdict
        // is read back from `test-status.md`, which is the only channel that
        // can gate anything.
        env: await this.sessionEnv({
          // All four claim fields, never two (LCK-6): a reviewer that claimed
          // unqualified collided with every isolated run beside it.
          ...(await this.claimEnv(phase)),
          // A reviewer is a peer too: it may leave a note for the phase it
          // reviewed, and reading its own mail costs nothing.
          ...this.messagingEnv(),
          // …and where it records a finding outside its phase (phase 12), from the
          // sibling helper, so a site cannot state the mailbox and forget the ledger.
          ...this.issuesEnv(),
          PE_RULINGS_FILE: rulingsFile(state.root, state.slug),
          // Where `phase-outcome.sh … verified` records what this session proved (control-tower phase 62),
          // and where its lines are judged — the proof is keyed there (phase 106, `proofEnv`).
          ...(await this.proofEnv(phase)),
          PE_TASKS_FILE: this.armTasksFile(phase),
        }),
        signal: this.abort?.signal,
        // The child is attached like any other, so Stop and Freeze reach the
        // reviewer, the console shows a live child, and its stream lands in
        // the run log and on the wire.
        onPid: (pid) => { this.attachPid(phase, pid); this.persist(); this.emit('run', { state }); },
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        onEvent: (event) => this.onStream(phase, event),
      }, { caps });
    } catch (error) {
      this.record('phase.qa-session-skipped', { reason: (error as Error)?.message ?? String(error) }, phase);
      return null;
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
      delete record.qaSession;
      this.persist();
    }

    // The CLI refused the `--resume`: the conversation is not where this
    // account (or this cwd) looks. Nothing ran, so this is not a round —
    // not a `pending` on the record, not a strike against the budget. The
    // session is marked gone and the loop boards fresh next.
    if (resume && !outcome.turns && lostResume(outcome.signal)) {
      this.markSessionGone(record, resume.sessionId, 'the CLI holds no conversation under that id here');
      this.emit('phase', { phase, qaSession: false });
      return null;
    }

    // A fresh boarding mints a session of its own, and the phase must remember
    // it — the next round's `resume` strategy, the Sessions page and the lock's
    // `session=` all read `record.sessionId`. Nothing is lost: the session it
    // replaces has already been superseded by the one that just did the work.
    if (opts.fresh && outcome.sessionId) record.sessionId = outcome.sessionId;

    // The money was booked by the spawn door like every session's (`bookSpend`),
    // so it shows up in the cost panels without those panels knowing this
    // feature exists; what this round spent is `booked`.
    const booked = outcome.bookedUsd ?? outcome.costUsd;
    record.turns = (record.turns ?? 0) + outcome.turns;

    let after = '';
    try { after = (await this.engine(['--qa-result', String(phase)])).stdout.trim().toLowerCase(); } catch { /* recorded below as owed */ }

    // Re-read the ledger rather than trusting the round we briefed: the reviewer
    // may have recorded under a different number (a hand-run round from another
    // clone landing first, a writer with no `--round`), and the file is the
    // shared truth. What landed is every row the file did not hold before —
    // new rounds and re-recorded ones alike — never "rows at or above a number
    // the file never promised". Nothing gained means the reviewer recorded
    // nothing, and that is recorded as exactly that: the briefed round, pending.
    const now = await this.qaHistory(phase);
    const settled = now.filter((entry) => !before.has(qaKey(entry)));
    // Nothing gained but a verdict on file is a re-record of a row the ledger
    // already held (a `pending` status row flipped over an unchanged ledger):
    // the round is the newest row WHOSE VERDICT MATCHES, never simply the newest
    // (QA round 7, Low 2 — a ledger whose last row is an older `fail` under a
    // status row now reading `pass` put the wrong round on the record), and the
    // newest of all only when nothing matches.
    const flipped = after === 'pass' || after === 'fail' || after === 'waived';
    const matching = flipped ? now.filter((entry) => entry.verdict === after) : [];
    const landed = settled.length ? settled
      : flipped && now.length ? [matching[matching.length - 1] ?? now[now.length - 1]]
        : [{ round, verdict: after || 'pending', reportPath: report }];
    const at = new Date().toISOString();
    (record.qa ??= []).push(...landed.map((entry) => ({
      ...entry,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      brief,
      // The spend belongs to the session, so it is booked against the FIRST
      // round it produced; a session that recorded two rounds spent its money
      // once, and charging both would double it in every cost panel.
      ...(entry === settled[0] || !settled.length
        ? { costUsd: booked, turns: outcome.turns }
        : {}),
      at,
    })));

    const landedRound = landed[landed.length - 1]?.round ?? round;
    const landedReport = landed[landed.length - 1]?.reportPath ?? report;
    this.record('phase.qa-session-done', {
      costUsd: booked, turns: outcome.turns, verdict: after || 'pending',
      round: landedRound,
      report: landedReport,
      rounds: (record.qa ?? []).length,
    }, phase);
    this.emit('phase', { phase, qaSession: false, qaVerdict: after || 'pending' });
    this.persist();
    return {
      verdict: after || 'pending',
      round: landedRound,
      report: landedReport,
      costUsd: booked,
      turns: outcome.turns,
    };
  }

  /* ------------------------------------------------------------------ *
   * QA recovery — issue #11
   * ------------------------------------------------------------------ */

  /**
   * Fix & re-QA, or Re-run QA: the round loop an operator asks for by name.
   *
   * Arms like a recovery (`armRecovery` — same orphan refusal, journal,
   * transcript, abort, settings and shutdown checkpoint) and then goes round:
   * one session per round, which fixes what the report named AND dispatches the
   * fresh-context reviewer, and the ledger read back by difference. `pass` or
   * `waived` releases the gate and the run continues; a spent budget parks the
   * phase with ONE errand naming the LAST report.
   *
   * Two things it deliberately does not do. It never re-reviews a verdict that
   * already releases the gate — a loop that "fixes" a passing phase is how a
   * green plan turns red at 3am — and it never launches itself: this is only
   * ever reached from the `qa-recover`/`qa-rerun` verbs, because re-arming a
   * budget an earlier loop spent is a decision with a price.
   */
  async qaRecover(options: {
    slug: string; root: string; runId: string; phase: number;
    verb: QaRecoverVerb;
    strategy?: QaFixStrategy;
    /** How many rounds may FAIL before it stops asking. Resolved by the caller. */
    maxRounds: number;
    /** A hard stop for ONE ROUND, never for the run. */
    roundBudgetUsd?: number | null;
    by?: string;
  }): Promise<RunState> {
    const { phase, verb } = options;
    const armed = this.armRecovery({
      ...options,
      kind: 'phase.qa-recover',
      payload: {
        verb,
        strategy: options.strategy ?? 'resume',
        maxRounds: options.maxRounds,
        roundBudgetUsd: options.roundBudgetUsd ?? DEFAULT_QA_ROUND_BUDGET_USD,
      },
    });
    if ('refused' in armed) return armed.refused;
    const { state } = armed;

    this.driving = this.runQaRecovery(options).catch((error) => {
      log.error('runner.qa-recover.unhandled', { error });
      this.halt(
        `the QA recovery of phase ${phase} could not run: ${(error as Error)?.message ?? String(error)}`,
        phase, 'recovery-failed',
      );
    }).finally(() => this.disarmRecovery(state));
    return state;
  }

  private async runQaRecovery(options: {
    phase: number; verb: QaRecoverVerb; strategy?: QaFixStrategy;
    maxRounds: number; roundBudgetUsd?: number | null; by?: string;
  }): Promise<void> {
    const state = this.state!;
    const { phase, verb } = options;
    const record = phaseRecord(state, phase);
    const handoffDir = join(state.root, 'docs', 'handoffs', state.slug);
    const owner = autopilotOwner(state.id);

    // A QA round spawns a session that edits the working tree exactly as a
    // phase does, so it queues behind whatever holds the scope — the same
    // admission `runRecovery` takes, and for the same reason.
    let grant: ScopeGrant | null = null;
    try {
      // Named rather than inline for `runRecovery`'s reason: `admit(phase,
      // 'recovery')` reads to `vocab-owners.test.ts`'s scan as the two-member
      // queue-kind vocabulary spelled out again.
      const kind: QueueKind = 'recovery';
      grant = await this.admit(phase, kind);
    } catch (error) {
      if (this.abort?.signal.aborted || this.stopRequested) return;
      this.halt(
        `the QA recovery of phase ${phase} was not admitted: ${(error as Error)?.message ?? String(error)}`,
        phase, 'recovery-failed');
      return;
    }

    let failures = 0;
    let spentUsd = 0;
    let lastReport = '';
    try {
      for (let attempt = 0; attempt < options.maxRounds; attempt += 1) {
        if (this.abort?.signal.aborted || this.stopRequested) return;

        // Asked EVERY round off the file rather than trusted from the last
        // one's return: a verdict recorded by hand, or from another clone, in
        // the minutes a round takes is exactly as real as one this loop
        // produced, and re-reviewing a phase somebody has just passed is the
        // one outcome this loop must never have.
        let verdict = '';
        try {
          verdict = (await this.engine(['--qa-result', String(phase)])).stdout.trim().toLowerCase();
        } catch { /* unreadable: treated as owed, and the round below says so */ }
        if (releasesGate(verdict)) break;

        // A FIX session only exists for `qa-recover`. `qa-rerun` is the review
        // alone, which is the whole distinction between the two verbs — but
        // "no fix" is not "no boarding": with no session to resume a review
        // still has to be boarded from somewhere, and forcing `fresh: false`
        // made `qa-rerun` exhaust after ZERO rounds on exactly the hand-driven
        // plan this verb exists for, with a self-contradictory errand ("spent 0
        // of 3 rounds… and every one of them failed"). Both verbs fall back to
        // a fresh boarding by the same rule now; only the INSTRUCTION differs
        // (QA round 1, M4). The `fresh` STRATEGY still moves only the fix
        // session — a review-only verb goes on resuming the session that holds
        // the context whatever an operator picked for a fix it is not running.
        const gone = !record.sessionId || isSessionGone(record);
        const fresh = options.strategy === 'fresh' || gone;
        const roundUsd = roundBudgetUsd(options.roundBudgetUsd, state.phaseBudgetUsd);
        const roundCaps = phaseCaps(this.capTable());
        const round = await this.qaRound(phase, {
          verb,
          fresh: verb === 'qa-rerun' ? gone : fresh,
          // The round's own budget when the run set one, else the phase's
          // whole budget, else the phase's size — a round is bounded either way.
          usd: roundUsd !== null && roundUsd > 0
            ? {
              value: roundUsd,
              source: typeof options.roundBudgetUsd === 'number' && options.roundBudgetUsd > 0 ? 'qa-round' : 'run',
            }
            : roundCaps.usd,
          // A fix may legitimately have to run a suite, so it gets a phase's
          // turn allowance rather than a closeout's. A review-only round keeps
          // the closeout cap it has always had (the QA mode's own).
          ...(verb === 'qa-rerun' ? {} : { turns: roundCaps.turns }),
          name: `${state.slug} p${phase} ${verb}`,
          // What the file says right now, read at the top of this round — so a
          // re-review's brief opens with a true sentence.
          ...(verdict ? { recordedVerdict: verdict } : {}),
          ...(verb === 'qa-recover'
            ? {
              instruction: ({ round: n, report, priorReport }) => qaFixInstruction({
                slug: state.slug, phase, round: n, report, priorReport,
                findings: readQaFindings(handoffDir, priorReport),
                ...(fresh ? { fresh: true } : {}),
              }),
            }
            : {}),
        });

        // A round that could not run at all is not a round that failed: it
        // spent nothing and reviewed nothing, so counting it against the budget
        // would let a broken spawn exhaust a phase's allowance in seconds.
        if (!round) {
          // A resume the CLI refused is not a round that happened: the
          // session is now marked gone, so the next pass boards FRESH — and
          // it gets the iteration back, because this one reviewed nothing.
          if (!fresh && isSessionGone(record)) { attempt -= 1; continue; }
          break;
        }
        spentUsd += round.costUsd;
        lastReport = round.report || lastReport;
        this.record('phase.qa-round', {
          verb, round: round.round, verdict: round.verdict, report: round.report,
          costUsd: round.costUsd, turns: round.turns,
          strategy: verb === 'qa-recover' ? (fresh ? 'fresh' : 'resume') : 'review-only',
          failures: round.verdict === 'fail' ? failures + 1 : failures,
        }, phase);
        if (releasesGate(round.verdict)) break;
        // `pending` — the session recorded nothing — spends a round exactly as a
        // `fail` does. It is not a verdict, but it IS an attempt that produced
        // none, and a loop that did not count it would go round for ever on a
        // session that cannot record.
        failures += 1;
      }

      let verdict = '';
      try {
        verdict = (await this.engine(['--qa-result', String(phase)])).stdout.trim().toLowerCase();
      } catch { /* unreadable — reported as exhausted below, which is what it is */ }
      if (releasesGate(verdict)) {
        // The gate is open. Nothing else to settle: the record already carries
        // the rounds, the board releases the dependents on its next read, and
        // the run continues under normal admission. The halt this recovery was
        // asked about is retired here and only here — the success path, exactly
        // as `runRecovery` does it.
        this.record('phase.qa-recovered', { verb, verdict, rounds: failures, costUsd: spentUsd }, phase);
        if (state.halt?.phase === phase) state.halt = null;
        setRunState(state, 'parked');
        state.finishedReason = `phase ${phase} passed QA after ${failures} round${failures === 1 ? '' : 's'}. `
          + 'Continue to carry on through the rest of the plan.';
        return;
      }

      const errand = qaExhaustedErrand({
        phase, rounds: failures, maxRounds: options.maxRounds,
        ...(lastReport && lastReport !== '-' ? { report: lastReport } : {}),
        spentUsd,
      });
      // The plan's answer to "and if the rounds run out?" (phase 11, ZTD-9):
      // the `**QA exhausted:**` line, else this console's `policy.qa.exhausted`,
      // else the shipped `waive`. Resolved before the errand is written, so a
      // spent budget under `waive` records the waiver through the operator's
      // own door and releases the dependents — no errand, no park; `halt`
      // halts the run with the errand; an owner's name parks with the errand
      // addressed to them.
      const policy = this.deps.planQaExhausted?.(state.slug)
        ?? policyForKey('qa.exhausted', state, this.deps.policyPrefs?.() ?? null)?.answer
        ?? 'waive';
      const policySource = this.deps.planQaExhausted?.(state.slug) ? 'plan'
        : policyForKey('qa.exhausted', state, this.deps.policyPrefs?.() ?? null)?.source ?? 'default';
      this.record('phase.qa-exhausted', {
        verb, rounds: failures, maxRounds: options.maxRounds,
        ...(lastReport && lastReport !== '-' ? { report: lastReport } : {}),
        costUsd: spentUsd, errand, policy, policySource,
      }, phase);
      if (policy === 'waive' && this.deps.qaWaive) {
        const waived = await this.deps.qaWaive(state.slug, phase, {
          reason: `QA exhausted after ${failures} failed round${failures === 1 ? '' : 's'} — waived by policy `
            + `(qa.exhausted: waive, from the ${policySource})`,
          by: 'policy',
        }).catch((error: unknown) => ({ ok: false, detail: String((error as Error)?.message ?? error) }));
        if (waived && typeof waived === 'object' && 'ok' in waived && waived.ok !== false) {
          this.record('phase.policy-answered', {
            situation: 'qa-failed', decisionKey: 'qa.exhausted', answer: 'waive', source: policySource,
            label: 'QA failed', reason: `the round budget (${options.maxRounds}) is spent`, by: 'qa-recover',
          }, phase);
          this.record('phase.qa-waived', { by: 'policy', decisionKey: 'qa.exhausted', source: policySource, rounds: failures }, phase);
          // The gate is open, the way the success path opens it: the halt this
          // recovery was asked about is retired, the run parks with its reason,
          // and the board releases the dependents on its next read.
          record.note = `QA failed ${failures} of ${options.maxRounds} rounds — waived by policy (qa.exhausted: waive); dependents release on the next board read`;
          if (state.halt?.phase === phase) state.halt = null;
          setRunState(state, 'parked');
          state.finishedReason = `phase ${phase}'s QA was waived by policy after ${failures} failed round${failures === 1 ? '' : 's'} `
            + '(qa.exhausted: waive). Continue to carry on through the rest of the plan.';
          return;
        }
        errand.how = `${errand.how} (The policy says waive, but the waiver could not be recorded: `
          + `${String((waived as { detail?: unknown } | null)?.detail ?? 'refused')}.)`;
      }
      // The phase's own errand slot, where the ladder writes its own — one ask
      // per phase, whoever wrote it, so the inbox and the phase card do not have
      // to know which loop parked it.
      const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: errand.at });
      if (policy !== 'waive' && policy !== 'halt') {
        errand.need = `${errand.need} The plan hands this verdict to ${policy} (QA exhausted: ${policy}).`;
      }
      slot.errand = errand;
      record.status = 'parked';
      record.note = `QA failed ${failures} of ${options.maxRounds} rounds — ${errand.need}`;
      if (policy === 'halt') {
        // Run-level, deliberately: the plan said a spent budget stops the run,
        // not merely the phase — and a fail verdict nobody may waive holds the
        // dependents exactly as a deadlock does, which is the kind the
        // classifier already reads as the QA situation.
        this.halt(`QA exhausted on phase ${phase}: its QA verdict is fail after ${failures} round${failures === 1 ? '' : 's'} `
          + `and the plan says halt (QA exhausted: halt) — ${errand.need}`, phase, 'plan-deadlocked');
        return;
      }
      this.park(errand.need, phase, 'needs-human');
    } finally {
      await this.release(phase, owner).catch(() => {});
      this.deps.scheduler?.release(grant);
      this.persist();
    }
  }

  /**
   * The rounds `test-status.md` records for a phase, oldest first — the engine's
   * `--qa-history`, which is tab-separated `round result report recorded`.
   *
   * Empty on every failure mode there is: no engine, no plan, no `test-status.md`,
   * a phase nobody reviewed. That is deliberate and safe — every caller here uses
   * the length to NUMBER the next round, and under-counting names a report file
   * that may already exist, which the reviewer can see, while over-counting
   * invents a gap nobody can explain.
   */
  protected async qaHistory(phase: number): Promise<QaRoundRecord[]> {
    let out = '';
    try { out = (await this.engine(['--qa-history', String(phase)])).stdout; } catch { return []; }
    return parseQaHistory(out);
  }

  /** The verification-command vocabulary — scripts/verify.env, the same file
   * the bash engine sources (F5 single-source discipline), with a hardcoded
   * fallback for older scripts dirs. Cached by the loader. */
  protected verifyEnv(): VerifyEnv {
    return loadVerifyEnv(this.deps.scriptsDir);
  }


  /** The program a command starts with — the shared extractor in verify.ts,
   * so the boarding preflight and the verify-time skip can never disagree. */
  private leadToken(command: string): string | null {
    return resolveLead(command);
  }

  /**
   * Read the phase's §Verification BEFORE a session is paid for.
   *
   * A real phase spent $45 and 68 minutes, then failed in 92 ms: its
   * §Verification named a compose file two directories away and test paths
   * that never existed. Every one of those facts was readable before the
   * spawn. So this reads them — with the same extractor the real verification
   * will use — and:
   *
   *  · returns a PARK reason when nothing would run at all (today that
   *    "passes" vacuously into person-checks, after the expensive part);
   *  · journals warnings for everything else — refused fragments, cwd-
   *    sensitive commands with no `Verify in:`, leads missing from the
   *    verification PATH — because a warning that blocked would make every
   *    plan author fight the runner, and one that stays silent repeats the
   *    $45 lesson.
   *
   * A custom `verify` dep owns the question entirely: predicting the default
   * extractor against a substitute verifier would judge a different machine.
   */
  /**
   * Can this phase's MCP servers actually be reached, BEFORE a session is paid for?
   *
   * The same lesson as the verification preflight, from the other direction. An
   * unattended `-p` run cannot fix a server that needs signing in: there is no
   * `/mcp` panel, `claude mcp login` wants a browser, and what the CLI does
   * instead is tell the MODEL that the tools are unavailable — so the session
   * improvises around a missing server for an hour and hands back work that
   * used none of what the plan chose it for.
   *
   * Three outcomes, three sentences, each naming what a person would do:
   *
   *  · an id nobody registered → the plan and the machine disagree; register it
   *    or drop it from the plan (this is F15's advisory, arriving as a fact);
   *  · a registered server switched off → the operator already said no, so say
   *    that rather than reconnecting it behind their back;
   *  · a server that will not connect → sign it in, or fix its credential.
   *
   * A probe that could not RUN never parks. "I could not check" and "they are
   * down" are different facts, and turning a flaky subprocess into a stopped
   * plan would be the worse of the two failures.
   */
  protected async resolveMcp(phase: number, chosen: PhaseOptions): Promise<McpResolution> {
    const state = this.state!;
    const ids = this.tokenScoped(phase, this.mcpFor(phase, chosen));
    const clean = (): McpResolution => ({ usable: ids, degraded: [], park: null, strict: false });
    if (!ids.length) return { usable: [], degraded: [], park: null, strict: false };
    if (!this.deps.mcp) {
      // No registry wired in (a harness, or a console built before this): the
      // phase runs on whatever MCP configuration the machine already has, which
      // is exactly what every run did before this existed.
      this.record('phase.mcp-unmanaged', { servers: ids }, phase);
      return clean();
    }

    const result = await this.deps.mcp.preflight(ids, state.root);
    // How many `claude` processes boarding THIS phase started (SLF-3): the
    // preflight answers from the health clock's cache when it can, so the
    // honest number is usually 0 — and when it is not, the journal says so.
    const probes = result.probes ?? 0;

    if (result.probeError) {
      // Could not check ≠ they are down — for the servers the probe was ABOUT.
      // Turning a flaky subprocess into a stopped plan, or into a session told
      // its tools are missing when they are not, is the worse of the two
      // failures, and that was true before the policy existed.
      //
      // An id the registry does not hold is a different fact: nothing was
      // probed to learn it and the probe failing does not put it back in doubt.
      this.record('phase.mcp-preflight-skipped', { reason: result.probeError, servers: ids, probes }, phase);
      if (!result.unknown.length && !result.disabled.length) return clean();
    }

    const degraded: McpDegradation[] = [
      ...result.unknown.map((id): McpDegradation => ({ id, reason: 'unregistered' })),
      ...result.disabled.map((id): McpDegradation => ({ id, reason: 'switched-off' })),
      ...result.blocking.map((row): McpDegradation => ({
        id: row.id,
        reason: row.status === 'needs-auth' ? 'needs-auth' : 'failed',
        ...(row.error?.message ? { detail: row.error.message } : {}),
      })),
    ];

    if (!degraded.length) {
      this.record('phase.mcp', { servers: ids, probes }, phase);
      return clean();
    }

    const policy = this.mcpPolicyFor(phase, chosen);
    // The park carries what it parked on: the clock that times it out names
    // those servers to the session and in the errand.
    if (policy === 'require') return { usable: [], degraded, park: this.mcpParkNote(phase, degraded), strict: false };

    const lost = new Set(degraded.map((row) => row.id));
    const usable = ids.filter((id) => !lost.has(id));
    // Every server this phase asked for is unreachable, so there is no config
    // file to pass — but the set must still be closed. `--mcp-config` is what
    // normally carries `--strict-mcp-config`, and without it the CLI unions in
    // whatever `~/.claude.json` and the project's `.mcp.json` hold. A degraded
    // phase silently gaining the machine's own servers is not a degradation
    // anyone asked for, and determinism here is a safety property.
    return { usable, degraded, park: null, strict: usable.length === 0 };
  }

  /**
   * A TOKEN account's secret rides the whole child process tree (ACT-12): the
   * CLI is handed `CLAUDE_CODE_OAUTH_TOKEN` in its environment, and every
   * stdio MCP server it launches — `npx -y <third-party>@latest` among them —
   * inherits that environment and can read a long-lived credential. There is
   * no route to the CLI its grandchildren cannot read, so the rule is the
   * other half of the requirement: a run paying as a token account attaches
   * only the stdio servers the PLAN declares (a versioned, reviewed statement
   * about the work). The run's and the phase's own picks are dropped when they
   * are stdio and kept when remote — `http`/`sse`/`ws` is a URL, and a URL
   * inherits no environment. A transport nobody can name reads as stdio.
   * Journalled `run.token-scope` once per boarding, so the session's missing
   * tools have a line explaining them; the drop is also a console log line.
   */
  private tokenScoped(phase: number, ids: string[]): string[] {
    const state = this.state!;
    if (!ids.length || this.deps.accountKind?.(state.accountId) !== 'token') return ids;
    const declared = new Set(this.deps.planMcp?.(state.slug, phase) ?? []);
    const transportOf = this.deps.mcp?.transportOf;
    const dropped = ids.filter((id) => !declared.has(id) && (transportOf?.(id) ?? 'stdio') === 'stdio');
    const kept = ids.filter((id) => !dropped.includes(id));
    this.record('run.token-scope', {
      account: state.accountId ?? 'default', reach: 'child-tree', servers: ids, kept, dropped,
      declaredByPlan: ids.filter((id) => declared.has(id)),
    }, phase);
    if (dropped.length) {
      log.warn('accounts.token-scope', { slug: state.slug, phase, account: state.accountId ?? 'default', dropped });
    }
    return kept;
  }

  /**
   * The park sentence, under `require`. Three shapes, each naming the errand.
   *
   * Unchanged wording from when this was the only outcome, because
   * `MCP_PARK_NOTE` and `MCP_AUTH_PARK_NOTE` match against it and the service's
   * heal path reads it. Change one, change all three.
   */
  private mcpParkNote(phase: number, degraded: McpDegradation[]): string {
    const only = (reason: McpDegradation['reason']) =>
      degraded.filter((row) => row.reason === reason).map((row) => row.id);

    const unregistered = only('unregistered');
    if (unregistered.length === degraded.length) {
      return `phase ${phase} names MCP server${unregistered.length === 1 ? '' : 's'} this console has `
        + `not registered: ${unregistered.join(', ')}. Register ${unregistered.length === 1 ? 'it' : 'them'} `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    const off = only('switched-off');
    if (off.length === degraded.length) {
      return `phase ${phase} needs MCP server${off.length === 1 ? '' : 's'} that ${off.length === 1 ? 'is' : 'are'} `
        + `switched off here: ${off.join(', ')}. Turn ${off.length === 1 ? 'it' : 'them'} back on `
        + 'in Phase Console → MCP, or drop the name from the plan, then Retry.';
    }
    const named = degraded.map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`);
    return `phase ${phase} cannot start: MCP server${named.length === 1 ? '' : 's'} ${named.join(', ')}. `
      + 'An unattended session cannot sign a server in — do it from Phase Console → MCP '
      + '(or `claude mcp login <name>`), then Retry.';
  }

  /**
   * What this phase does when a server will not connect, from the four places
   * that may say — most specific first.
   *
   * The plan outranks the RUN on purpose, and this is the one resolution in the
   * runner where it does. `model` and `effort` let the operator's choice for a
   * run win because they are preferences about how to spend money. This is not
   * that: a phase whose plan says `require` is making a claim about the work
   * itself, and an operator's run-wide "carry on regardless" — usually clicked
   * for an unrelated reason — must not quietly overrule it. They can still say
   * so for that ONE phase, which is the level where they know what they mean.
   */
  private mcpPolicyFor(phase: number, chosen: PhaseOptions): McpPolicy {
    const state = this.state!;
    return chosen.mcpPolicy
      ?? this.deps.planMcpPolicy?.(state.slug, phase)
      ?? state.mcpPolicy
      ?? 'continue';
  }

  /**
   * Write this phase's `--mcp-config`, or null when it attaches nothing.
   *
   * Per attempt rather than per run, unlike the settings file: a server the
   * operator signed in between two attempts must be usable by the second, and
   * the file costs a JSON write. It carries secrets, so it is 0600 and passed
   * as a path — argv is world-readable in `ps`.
   */
  private async armMcp(
    phase: number, chosen: PhaseOptions, resolved?: McpResolution,
  ): Promise<string | null> {
    if (!this.deps.mcp) return null;
    const state = this.state!;
    // The boarding's answer when there is one — see the call site. The fallback
    // is for the paths that arm without boarding (and for older tests).
    const ids = resolved ? resolved.usable : this.mcpFor(phase, chosen);
    if (!ids.length) return null;
    try {
      return await this.deps.mcp.configFor(state.id, phase, ids);
    } catch (error) {
      // Never fatal. The preflight has already said the servers are reachable;
      // failing to WRITE the file is our problem, and a phase that runs without
      // its servers is worse only than one that runs with them — not worse than
      // one that never runs at all.
      log.error('runner.mcp-config', { error, servers: ids });
      this.record('phase.mcp-config-failed', { error: (error as Error).message, servers: ids }, phase);
      return null;
    }
  }

  protected async preflightVerification(phase: number): Promise<string | null> {
    const state = this.state!;
    if (this.deps.verify) return null;
    const text = await this.deps.verificationText(state.slug, phase);
    // One prediction (`verify-review.ts`), asked by every reader — the launch
    // door, the plan page, plan health, the repair gate and this boarding —
    // so none of them can promise what boarding will not do. It decides the
    // park and writes its sentence; the warnings below are this record's.
    const review = reviewPhase({
      phase,
      verification: text,
      // The parser handed over nothing — a plan that DECLARES the bullet sends
      // the author to their formatting, one that omits it to their keyboard.
      declared: text?.trim() ? true : Boolean(await this.deps.verificationDeclared?.(state.slug, phase)),
      personCheck: this.personCheckFor(phase).answer,
      autonomy: state.autonomy,
      approvals: this.verifyApprovalsFor(phase),
      // The one opt-in that lowers the bar, for a plan that OMITS the bullet.
      allowUnverified: this.deps.allowUnverifiedPhases?.() === true,
      pathEnv: process.env.PATH,
      preflightSkip: this.verifyEnv().preflightSkip,
    });
    if (review.verdict === 'parks') return review.park ?? null;
    if (review.unverified) {
      this.record('phase.verify-waived', review.waived.length
        ? { stage: 'preflight', reason: 'every check was waived at the run\'s start', by: 'launch', notRun: review.waived }
        : { stage: 'preflight', reason: 'the plan states no verification', by: 'allowUnverifiedPhases' }, phase);
      return null;
    }

    const warnings: string[] = [];
    const detail: PreflightWarning[] = [];
    // Worded by what will actually happen. "a person will be asked" was
    // printed regardless of autonomy, and under `keep-going` the runner
    // deliberately does NOT ask when the board vouches for measured work —
    // so every phase of a real plan promised a question the run never posed,
    // and the run page read as a wall of pending permission asks.
    const asks = review.verdict === 'asks';
    for (const held of review.items) {
      const message = asks
        ? `a person will be asked: ${held.text} — ${held.reason}`
        : `left for a person on the record: ${held.text} — ${held.reason} `
          + '(asks only if nothing else proves the phase)';
      warnings.push(message);
      detail.push({ kind: 'human-check', command: held.text, message });
    }

    const declared = (await this.deps.verifyIn?.(state.slug, phase))?.trim();
    if (!declared) {
      const sensitive = review.runs.filter((command) => {
        if (/^cd\s/.test(command.trim())) return false; // names its own directory
        const lead = this.leadToken(command);
        return lead ? this.verifyEnv().cwdSensitive.has(lead) : false;
      });
      if (sensitive.length) {
        const message = `${sensitive.length} command(s) are cwd-sensitive and the plan declares no `
          + '**Verify in:** — they will run at the repository root';
        warnings.push(message);
        detail.push({ kind: 'cwd-unpinned', message });
      }
    }

    for (const lead of review.missing) {
      // The consequence named matches what the runner will actually DO now:
      // skip and record, never run to a 127 halt. `python` gets its errand.
      const hint = lead === 'python' && !review.missing.includes('python3')
        ? ' — this machine has python3; write python3' : '';
      const message = `\`${lead}\` is not on the verification PATH — its command will be `
        + `SKIPPED at verification (recorded, not failed)${hint}`;
      warnings.push(message);
      detail.push({ kind: 'missing-lead', lead, message });
    }

    // On the record too, not just the journal: the journal is rendered by
    // nothing, and these warnings' first visible symptom used to be the
    // verification failing after the money was spent.
    const record = phaseRecord(state, phase);
    if (warnings.length) {
      record.preflight = warnings;
      record.preflightDetail = detail;
      this.record('phase.verify-preflight', { warnings, detail }, phase);
      this.emit('phase', { phase, preflight: warnings, preflightDetail: detail });
    } else {
      delete record.preflight;
      delete record.preflightDetail;
    }
    return null;
  }

  /**
   * This phase's answers from the start door (`RunState.verifyApprovals`), as
   * the extractor reads them — undefined when the run has none.
   */
  protected verifyApprovalsFor(phase: number): VerifyApprovals | undefined {
    return approvalsForPhase(this.state?.verifyApprovals, phase);
  }

  /**
   * Where this phase's verification commands mean to be run.
   *
   * The root unless the plan says otherwise. `**Verify in:**` exists because
   * verification runs `bash -c` with the cwd the console was opened on, and in
   * a monorepo that is the superproject: a plan whose phase lives in one
   * submodule had its suite run against the whole tree, and one real plan's
   * `docker compose run … -v "$PWD:/app"` mounted the entire monorepo into a
   * container and hung there.
   *
   * Two ways to be refused, both falling back to the root rather than failing
   * the phase — a plan with a typo in one bullet should still get verified:
   *
   *  · It escapes the root. `../../etc` is not a directory this console gets to
   *    run commands in, whatever the plan says. The plan file is editable by
   *    anyone who can open the repo, so this is a boundary, not a typo check.
   *  · It is not there. A path that named a directory when the plan was written
   *    and does not now is exactly the case where running in it silently would
   *    be worst — bash would inherit the parent's cwd and nobody would be told.
   *
   * Both journal `phase.verify-in-missing`, because a verification that ran
   * somewhere other than where the plan said must never be silent.
   */
  private async verifyCwd(phase: number): Promise<string> {
    // The LANE's root, so a worktree phase verifies the tree it just wrote. A
    // verification that ran in the shared checkout would grade the run branch
    // as it stood before this lane's commits — green for work it never saw.
    // One resolution (`verifyDirOf`), shared with the session's `PE_VERIFY_DIR`
    // (control-tower phase 106), so where a proof is keyed and where it is
    // judged cannot drift apart.
    const { dir, declared, refused } = await this.verifyDirOf(phase);
    if (refused) this.record('phase.verify-in-missing', { declared, reason: refused, usedRoot: true }, phase);
    return dir;
  }

  /**
   * A sentence to add to a verification halt when the plan looks like it meant
   * a different directory — or `''`, which is the usual answer.
   *
   * Deliberately a HINT and never an automatic cwd. A silently-chosen directory
   * that happens to be wrong verifies the wrong tree and reports green, which is
   * strictly worse than the failure it would be papering over: the phase would
   * be marked done on the strength of a suite that never looked at its code.
   * So the console says what it noticed and lets a person write it into the
   * plan, where it is reviewable and where the next run will read it too.
   *
   * All three conditions have to hold, and each one is a way of not guessing:
   *  · the plan does not already say (otherwise this is contradicting it);
   *  · the Repos cell names exactly ONE repo (with two, the plan must choose);
   *  · exactly one directory near the root has that name (with two, so is this).
   */
  /**
   * Would the board retract a verify-failed halt the moment converge looks?
   *
   * `true` exactly when the phase's handoff already reads complete — the same
   * fact `reconcileAgainstBoard` settles records with a minute later. A board
   * that cannot be read answers `false`: when in doubt the loud stop stands,
   * because a silent pass is the one trade this question must never make.
   */
  /**
   * Re-open a phase the board reads done whose §Verification's FINAL verdict
   * is red (control-tower phase 62, #68). Never a halt: the run keeps driving
   * whatever does not depend on the phase. The record reads `failed` with
   * `reopened` set, which is what the ladder's pass admits despite the board
   * (`verify-red:reopened` — one fix rung, the phase's own session resumed with
   * the failure, then an errand), what reconcile and the finished-run checks
   * leave alone, and what holds the phase's dependents. A verdict red on its
   * last attempt is a merit failure (#45's rule), so the streak is charged — a
   * second ending of the same phase is not.
   */
  private async reopen(
    phase: number, verification: VerifySummary, broke: readonly VerifyRun[], stamps: readonly TreeStamp[],
  ): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const failed = broke.map((row) => row.command);
    record.reopened = { at: this.now().toISOString(), failed, times: (record.reopened?.times ?? 0) + 1 };
    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    record.note = `§Verification is red (${verification.reason})${comparedClause(stamps)} although the handoff reads `
      + 'complete — re-opened: the phase is not done until it verifies green, and its dependents wait'
      + await this.verifyHint(phase);
    this.record('phase.verification-failed', {
      reopened: true, times: record.reopened.times, failed, reason: verification.reason,
      ...(stamps.length ? { trees: stamps } : {}),
    }, phase);
    this.emit('phase', { phase, status: record.status, note: record.note });
    if (this.lanes.size > 1) this.syncMirror();
    else state.activePhase = null;
    this.chargeFailure(phase, 'verify-red', 'verification failed');
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      this.halt(streakSentence(state), phase, 'failure-streak');
    }
    this.persist();
    return false;
  }

  private async boardOvertookVerification(phase: number): Promise<boolean> {
    try {
      const board = await this.board();
      return board.states[phase] === 'done';
    } catch {
      return false;
    }
  }

  private async verifyHint(phase: number): Promise<string> {
    const state = this.state!;
    if ((await this.deps.verifyIn?.(state.slug, phase))?.trim()) return '';

    const repos = (await this.deps.phaseRepos?.(state.slug, phase)) ?? [];
    if (repos.length !== 1) return '';

    const matches = this.subdirsNamed(basename(repos[0]));
    if (matches.length !== 1) return '';

    return `. This phase's Repos column names \`${repos[0]}\`, and the commands ran in `
      + `\`${relative(resolve(this.laneRoot(phase)), await this.verifyCwd(phase)) || '.'}\` — if they should run `
      + `in \`${matches[0]}\`, add \`- **Verify in:** ${matches[0]}\` to the plan's §Phase ${phase}`;
  }

  /**
   * Directories at most two levels below the root with this name, relative to
   * the root. Two levels because that is where a submodule of a monorepo lives
   * (`packages/cart-api`) — deeper is a `node_modules` crawl, and a match found
   * six levels down would not be what a Repos column meant anyway.
   */
  private subdirsNamed(name: string): string[] {
    const root = resolve(this.state!.root);
    const found: string[] = [];
    const scan = (dir: string, depth: number): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.name === name) found.push(relative(root, full));
        if (depth > 0) scan(full, depth - 1);
      }
    };
    scan(root, 1);
    return found;
  }

  /**
   * Is this phase closed on disk — and if not, can the session that ran it be
   * made to close it?
   *
   * `phase-graph.sh` reads one thing: `status:` in the phase's handoff. So "the
   * board still reads ready" always means the same thing — the handoff was never
   * written, or not marked complete. That is a fact about paperwork, and a
   * session that did the work and stopped one step short of recording it should
   * be asked to finish rather than have the run halted under it.
   */
  private async closed(
    phase: number, declared: PhaseOutcome | null, raises = 0,
  ): Promise<'done' | 'waiting' | 'halted' | 'frozen' | 'interrupted'> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    let board = await this.board();
    if (board.states[phase] === 'done') {
      if (declared && declared.status !== 'complete') {
        // The board wins: whatever the session thought it was waiting on, the
        // handoff exists and reads complete. Journalled, never acted on.
        this.record('phase.outcome-superseded', { declared: declared.status }, phase);
      }
      // …and a declaration still standing from an earlier attempt (a wait this
      // session was resumed from, a blocker it cleared) is spent under the
      // licence this IS: the board reads the phase done, so there is no phase
      // left for it to be about (WAI-9). It used to outlive the record's `done`.
      const closed = consumeDeclaration(record, 'board-closed');
      if (closed) this.record(DECLARATION_CONSUMED_EVENT, { ...closed }, phase);
      return 'done';
    }

    // The declared outcome routes BEFORE the closeout nudge. A session that
    // said "waiting on CI" must not be nudged to finish paperwork the external
    // clock still blocks — on the live run this replaces, the nudge was
    // answered in the same holding pattern, thirty seconds later, and halted.
    if (declared) {
      const routed = await this.routeOutcome(phase, declared, board);
      if (routed) return routed;
    }

    // A board that reads `stuck` is a handoff that EXISTS and says `blocked` —
    // a fact, not missing paperwork. Twelve real halts called this "no handoff
    // was written" while sessions wrote three-paragraph rebuttals into the
    // reason, and four closeout resumes looped on phases whose brief forbade
    // the work that would unblock them. It is not an immediate halt either:
    // the situation decides (`blocked-declared` and its sub-kind) — a lock
    // queues, a credential or a gate parks with an errand at once, an unknown
    // blocker gets ONE bounded unblock session, and only a ladder with nothing
    // left for this runner halts the old way.
    if (board.states[phase] === 'stuck') {
      return this.closedBlocked(phase, board, null);
    }

    // How the newest session ENDED, before a missing handoff is called anything
    // (control-tower phase 46, #61). A resume that the console cut or that spent
    // its cap was halted `no-handoff` — "ended cleanly" — because this method
    // read neither `endedBy` nor `terminalReason`, and the resume vehicle had
    // stamped a closeout that never ran. A recheck re-reads an old ending and
    // acts on none of it.
    const last = this.rechecking === phase ? undefined : record.lastSession;
    // RC-6: the console ended it — a shutdown, a stop. Not a failure and not a
    // closeout's cue: the phase keeps its session for the `--resume`.
    if (this.stopRequested || this.shuttingDown || this.abort?.signal.aborted
      || last?.endedBy === 'shutdown' || last?.endedBy === 'stop') {
      return this.settleCut(phase);
    }
    // RC-5: a resume that spent its cap mid-work is the ending `errors.ts` has
    // always classed "resume, raise" — the attempt loop's own path, which the
    // resume vehicle never took. The same session carries on under double the
    // cap, a bounded number of times, and this method asks again.
    const spent = last?.mode === 'resume' ? spentCapOf(last) : null;
    if (spent && last && raises < MAX_ATTEMPTS - 1 && await this.raiseResume(phase, last, spent)) {
      return this.closed(phase, this.takeOutcome(phase), raises + 1);
    }

    const attempt = await this.closeout(phase, board.states[phase] ?? 'unknown');
    // The console was frozen, so no closeout session was started — and this
    // phase must NOT be convicted for it. The fall-through below reads "no
    // handoff was written" as `failed`, charges `consecutiveFailures` and halts
    // the run on `no-handoff`: a Freeze-all landing between a child's exit and
    // its closeout would have marked the phase failed, spent the streak budget
    // and halted, while the banner said nothing was lost.
    //
    // So the record goes back to `pending` with its session id kept — the exact
    // shape an escalated freeze writes, and the one Continue resumes rather
    // than re-runs. `record.closeout` is untouched (it is stamped only by an
    // attempt that ran), so the thawed run reaches the closeout again.
    if (attempt.frozen) {
      record.status = 'pending';
      record.resumeSessionId = record.sessionId;
      record.note = attempt.note;
      // …and the RUN stops here too. This is not optional.
      //
      // `pending` puts the phase back on the ladder, and the ladder is a loop:
      // without this the drive loop returns to its top, re-reads a board that
      // still says `ready`, boards the phase again, runs a session, declines
      // the closeout again — for ever, spawning a session per turn under a
      // console the operator switched off. Found by this branch's own test,
      // which HUNG rather than failed, which is the signature of exactly this.
      //
      // `frozen` is the right word and not an invention: `stopAdmitting`
      // already knows it, `boardingBlocked` already refuses on it, and the
      // loop's own `frozen` branch drains and parks with an honest ending. In
      // the ordinary case `freezeFleet` has already set it — this covers the
      // window where a lane resolved between the marker landing and the
      // signal, which is precisely the window this gate exists for.
      if (state.status === 'running') setRunState(state, 'frozen');
      this.record('phase.closeout-frozen', {
        note: attempt.note, sessionId: record.sessionId ?? null,
      }, phase);
      return 'frozen';
    }
    if (attempt.ran) {
      // The closeout session may have filed an outcome instead of a handoff —
      // the phase-8 shape exactly: "still waiting on the image build". Honor
      // it the same way.
      const late = this.takeOutcome(phase);
      // The closeout is a session too, and it publishes to the same file.
      if (this.drainTasks(phase)) this.persist();
      if (late) {
        const routed = await this.routeOutcome(phase, late, board);
        if (routed) return routed;
      }
      board = await this.board();
      if (board.states[phase] === 'done') return 'done';
      if (board.states[phase] === 'stuck') return this.closedBlocked(phase, board, null);
    }

    // "The session ended cleanly" presumes there WAS a session. `recheck`
    // spawns nothing, and `closeout` may decline to, so this fall-through is
    // reachable with `attempts: 0` — a phase this console has never once
    // boarded. Calling that `failed` blames a session that never existed, and
    // the streak charge is worse than the word: two rechecks on two
    // never-boarded phases halt the whole run on `failure-streak` for failures
    // nothing performed. `interrupted` is the honest status (it is what every
    // other never-finished record reads) and it keeps the phase on the
    // ladder's own `LADDER_STATES` fold rather than settling it as a verdict.
    const attempted = record.attempts > 0;
    record.status = attempted ? 'failed' : 'interrupted';
    // A recheck that meets the SAME ending again charges nothing: it spawned
    // no attempt, and the failure it re-reads was counted when it was first
    // written (RCV-4). A recheck that RECORDS a failure for the first time — a
    // phase whose console died before its ending was written — still counts
    // it, because the failure is real and this is its first record.
    //
    // And only a session that left NOTHING is a merit failure (control-tower
    // phase 45, #60): work on disk with no handoff is unfinished paperwork, which
    // the ladder's `work-in-progress` rungs answer — not a claim that the plan
    // is broken. The closeout already asked the tree when it got that far; a
    // closeout that stopped earlier (one already spent, a recheck) asks here.
    if (attempted && !(this.rechecking === phase && record.halt?.kind === 'no-handoff')) {
      const worked = attempt.worked ?? (await this.producedWork(phase, board.states[phase] ?? 'unknown')).did;
      this.chargeFailure(phase, worked ? 'no-handoff-worked' : 'no-handoff', 'the session ended with no complete handoff');
    }
    // Said as it happened: "ended cleanly" only about a session that did.
    const ended = record.lastSession ? spentCapOf(record.lastSession) : null;
    if (ended === 'budget') this.notePhaseBudgetSpent(phase);
    const how = ended === 'turns'
      ? `spent its turn cap (${record.lastSession?.maxTurns?.value ?? '?'} turns)`
      : ended === 'budget'
        ? `spent its dollar cap ($${record.lastSession?.maxBudgetUsd?.value ?? '?'})`
        : 'ended cleanly';
    this.halt(
      (attempted
        ? `the session for phase ${phase} ${how} but the board still reads `
        : `nothing has been run for phase ${phase} and the board still reads `)
      + `"${board.states[phase] ?? 'unknown'}" — no handoff was written, or it is not marked complete`
      + (attempt.note ? `. ${attempt.note}` : '')
      // The session's own account of why. Without it the halt names the symptom
      // and buries the cause in NDJSON: the run this was written for died on a
      // refusal to write into its own config directory, and said so, and the
      // console repeated only "no handoff was written".
      + (record.said ? `. It signed off: "${condenseSaid(record.said)}"` : ''),
      phase,
      'no-handoff',
    );
    return 'halted';
  }

  /**
   * RC-6 (control-tower phase 46, #61): the console ended the phase's session —
   * it shut down, or a person stopped it. That is not a failure to diagnose and
   * not a missing handoff: the phase settles `interrupted` with its session
   * kept for the `--resume`, exactly as the attempt loop settles the same
   * ending, and nothing charges the streak. It used to fall through to the
   * closeout — "already attempted", because the resume vehicle had stamped one —
   * and halt `no-handoff` over a resume the shutdown cut 4.8 s in.
   */
  private settleCut(phase: number): 'interrupted' {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const lane = this.lanes.get(phase);
    if (lane?.stopped) {
      this.settleStoppedLane(lane, phase);
      return 'interrupted';
    }
    record.status = 'interrupted';
    record.endedAt = new Date().toISOString();
    record.resumeSessionId ??= record.sessionId;
    if (this.shuttingDown || record.lastSession?.endedBy === 'shutdown') {
      record.note = consoleStoppedNote(phase);
      state.stoppedBy = 'system';
    } else {
      const stamp = this.stopStamp();
      record.note = stamp.note;
      state.stoppedBy = stamp.stoppedBy;
    }
    // The word the attempt loop writes for the same ending: a halt that stands
    // keeps its run `halted`, anything else is `paused` for Continue.
    setRunState(state, state.halt ? 'halted' : 'paused');
    this.emit('phase', { phase, status: record.status });
    this.persist();
    return 'interrupted';
  }

  /**
   * RC-5 (control-tower phase 46, #61): resume the phase's session that spent
   * its cap mid-work, under double the cap it spent (`raiseCap`) — the path
   * `classify()` has always named for `error_max_turns` and
   * `error_max_budget_usd`, which the phase attempt takes and the resume
   * vehicle never did. True when the session ran; false when it could not be
   * resumed, and the caller carries on to the closeout and the verdict.
   */
  private async raiseResume(
    phase: number, last: NonNullable<PhaseRecord['lastSession']>, spent: 'turns' | 'budget',
  ): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const base = capsFor({
      mode: 'resume', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd, spentTurns: record.turns ?? 0,
    });
    const turns = last.maxTurns ?? base.maxTurns;
    const usd = last.maxBudgetUsd ?? base.maxBudgetUsd;
    const caps: SessionCaps = spent === 'budget'
      ? { maxTurns: turns, maxBudgetUsd: raiseCap(usd, 'the session spent its dollar cap') }
      : { maxTurns: raiseCap(turns, 'the session spent its turn cap'), maxBudgetUsd: usd };
    this.record('phase.resume', {
      raise: spent, vehicle: 'resume',
      budget: caps.maxBudgetUsd.value, budgetSource: caps.maxBudgetUsd.source,
      maxTurns: caps.maxTurns.value, maxTurnsSource: caps.maxTurns.source,
    }, phase);
    const words = spent === 'budget'
      ? `The console raised your dollar cap to $${caps.maxBudgetUsd.value}: you spent the $${usd.value} it gave you mid-work.`
      : `The console raised your turn cap to ${caps.maxTurns.value}: you spent the ${turns.value} turns it gave you mid-work.`;
    const said = await this.resumeWithInstruction(phase,
      `${words} Nothing is wrong with the work — carry on from exactly where you stopped, then close the phase out.`,
      null, { caps, name: `${state.slug} p${phase} resume` });
    if (this.drainTasks(phase)) this.persist();
    return said === null;
  }

  /**
   * Act on a session's declared outcome when the board does not read done.
   * Returns the disposition `closed()` should report, or null to fall through
   * (a `complete` declaration is advisory — the board decides).
   */
  /**
   * Settle the phase's open ladder rung from what its session DECLARED.
   *
   * The rule the ladder was missing. Nine of ten `plan-repair-agent` rungs used
   * to settle `failed` by construction: the only settle path asked
   * `record.status === 'done'`, which a plan-wide repair can never satisfy — so
   * a rung that did exactly what it was sent to do was recorded as a failure,
   * the ladder escalated to the more expensive remedy, and the ledger lied
   * about both. A session's own declaration is the honest evidence, and it is
   * the ONE thing the rung's own session is in a position to know.
   *
   *   complete                          → fixed
   *   no-defect | blocked | needs-human → no-defect   (it looked; nothing it could do)
   *   waiting-external                  → no-defect   (the world has not moved yet)
   *   partial                           → work-in-progress
   *   nothing declared                  → failed, quoting its last words
   *
   * A no-op when nothing is open — an ordinary first boarding is not a rung —
   * and a no-op when something already settled it: `settleRung` takes the
   * NEWEST OPEN rung, so the first writer wins and the healer's later sweep
   * cannot overwrite the session's own account with a guess made from outside.
   */
  protected settleRungFromOutcome(
    phase: number, declared: PhaseOutcome | null, said?: string,
  ): void {
    const state = this.state;
    if (!state) return;
    if (!state.recoveries?.[String(phase)]) return;
    if (!declared) {
      this.settleOpenRung(phase, 'failed',
        said ? `the session declared nothing; it signed off: "${condenseSaid(said)}"` : 'the session declared nothing');
      return;
    }
    const detail = declared.reason ? `: ${declared.reason.replace(/\s+/g, ' ').slice(0, 120)}` : '';
    switch (declared.status) {
      case 'complete':
        this.settleOpenRung(phase, 'fixed', `the session declared complete${detail}`);
        return;
      case 'partial':
        this.settleOpenRung(phase, 'work-in-progress', `the session declared partial${detail}`);
        return;
      default:
        // `no-defect`, `blocked`, `needs-human`, `waiting-external`. Each is a
        // rung reporting honestly on a thing it could not or need not change,
        // which is not the same as a rung that failed — the distinction the
        // errand and the next rung both read.
        this.settleOpenRung(phase, 'no-defect', `the session declared ${declared.status}${detail}`);
    }
  }

  protected async routeOutcome(
    phase: number, declared: PhaseOutcome, board: Board,
  ): Promise<'waiting' | 'halted' | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // The plan's word on how long this phase may stay parked, read before
    // anything is spent — the only awaits on this path, so nothing it decides
    // below can be interleaved with another lane's writes. A declared WALL
    // (`needs-human`, `blocked`) reads it too, and the scopes of this run's
    // phases: the budget is stamped on the declaration (`declared.budget`, the
    // fence and the `cmd:` clock end with it) and the scopes decide whether
    // the wall folds into one already standing (control-tower phase 6, #19).
    const walled = declared.status === 'needs-human' || declared.status === 'blocked';
    const budget = declared.status === 'waiting-external' || walled ? await this.waitBudgetOf(phase) : undefined;
    const scopes = new Map<number, string[]>();
    if (walled) for (const p of Object.keys(state.phases).map(Number)) scopes.set(p, await this.scopeFor(p));
    const budgetStamp = budget
      ? {
        budget: {
          ms: budget.budgetMs, source: budget.source,
          ...(budget.waitsMax !== undefined ? { waits: budget.waitsMax, waitsSource: budget.waitsSource ?? 'default' } : {}),
        },
      }
      : {};
    // Before anything routes: the ladder's own bookkeeping, from the session's
    // own words. A no-op unless the ladder is what boarded this attempt.
    this.settleRungFromOutcome(phase, declared, record.said);
    // The declarations ledger (WAI-8): every word counted, a word past its cap
    // recorded and not acted on — the rule `phase.wait-budget-spent` states for
    // one word, for all six. No cooldown here: the supervised path reads one
    // file per attempt by construction. The refusal is a person's: the count is
    // the operator's Retry to clear, and nothing automatic clears it.
    const charge = chargeDeclaration(record, declared.status, { now: Date.now() });
    if (charge.verdict !== 'act') {
      this.record(DECLARATION_REFUSED_EVENT, {
        status: charge.status, why: 'cap', count: charge.count, max: charge.max, refused: charge.refused,
        reason: declared.reason ?? null, by: 'session',
      }, phase);
      return this.refuseDeclaredWord(phase, record, state, charge);
    }
    // A NEW declaration supersedes the last one — the first of
    // `consumeDeclaration`'s licences, and the only one that is about the
    // session changing its mind rather than the world changing around it.
    const spent = consumeDeclaration(record, 'new-outcome');
    if (spent) this.record(DECLARATION_CONSUMED_EVENT, { ...spent, next: declared.status }, phase);
    // …and ANY declaration ends the lock wait. `lockWaitSince` is cumulative by
    // design so that a re-arm of the same wait keeps measuring it; a phase that
    // stops waiting and declares something is not a re-arm. Left standing, the
    // stamp made the next admission compute `max(0, 2h − 25.4h) = 0` and fire
    // its cap 1 ms after `phase.queued` (R8, filters p12). The `blocked`+`lock:`
    // arm below re-stamps a fresh one, which is what "from zero" means.
    endLockWait(record);
    switch (declared.status) {
      case 'waiting-external':
        return this.parkWaiting(phase, declared, { budget }) ? 'waiting' : 'halted';
      case 'blocked': {
        record.declared = {
          status: 'blocked',
          ...(declared.reason ? { reason: declared.reason } : {}),
          ...(declared.watch.length ? { watch: declared.watch } : {}),
          ...needsOf(declared),
          ...budgetStamp,
          at: new Date().toISOString(),
        };
        clearWatchBookkeeping(record);
        const clock = this.armDeclaredClock(phase, record, declared);
        // What was asked, on the testimony — the instant a `poll-park` of this
        // block is judged against (control-tower phase 87), as a wait's is.
        if (clock) record.declared.requested = clock.requested;
        const lockRef = declared.watch.find((ref) => ref.startsWith('lock:'));
        // A lock block whose ONLY lock was the phase's own (#42): the screen
        // refused the ref, and there is no holder to queue behind — the lock
        // ladder's one rung would re-board the phase the moment its own
        // closeout released that lock. What it is blocked on is a person's to
        // read, so it parks with the errand, like the needs-human it is.
        if (!lockRef && declared.refused?.length
          && declaredSubKind(declared, { refs: declared.watch }) === 'lock') {
          return this.parkOwnLockBlock(phase, declared);
        }
        if (lockRef) {
          // Not a defect: a foreign lock the session correctly refused to
          // force. Back to the queue — admission waits on the holder with the
          // same wake sources as any lock conflict.
          record.status = 'pending';
          record.note = declared.reason ?? `blocked on ${lockRef}`;
          record.lockWaitSince ??= new Date().toISOString();
          this.record('phase.outcome-lock-blocked', {
            reason: declared.reason ?? null, watch: declared.watch,
            ...(clock ? { resumeAfter: clock.until, requested: clock.requested, capped: clock.capped } : {}),
          }, phase);
          this.emit('phase', { phase, status: 'pending', note: record.note });
          return 'waiting';
        }
        // The declaration is evidence for the situation — its reason and
        // watch refs decide the sub-kind — and the ladder decides what
        // happens: one unblock session, a queue, or an errand.
        return this.closedBlocked(phase, board, declared);
      }
      // "I looked, and there was nothing to fix." The rung is already settled
      // `no-defect` above; for the PHASE this claims nothing, so it falls
      // through to the board exactly as a `complete` declaration does — the
      // board decides whether the phase is done, and a session that found
      // nothing wrong and left no handoff still gets the honest no-handoff
      // account rather than a fabricated success.
      case 'no-defect': {
        record.declared = {
          status: 'no-defect',
          ...(declared.reason ? { reason: declared.reason } : {}),
          ...(declared.watch.length ? { watch: declared.watch } : {}),
          at: new Date().toISOString(),
        };
        this.record('phase.outcome-no-defect', { reason: declared.reason ?? null }, phase);
        return null;
      }
      case 'needs-human': {
        record.status = 'parked';
        record.note = declared.reason ?? 'the session asked for a person';
        record.endedAt = new Date().toISOString();
        // Persisted verbatim: the classifier reads THIS, not a regex over the
        // note. A reason that happened to mention §Verification used to
        // re-classify the park as "the plan is broken" and overwrite the
        // errand below with a plan-repair prescription.
        record.declared = {
          status: 'needs-human',
          ...(declared.reason ? { reason: declared.reason } : {}),
          ...(declared.watch.length ? { watch: declared.watch } : {}),
          ...needsOf(declared),
          // A person's turn is not somebody else's clock: no wait budget is
          // stamped, so nothing about a human step ends with it.
          ...(declared.step ? {} : budgetStamp),
          at: record.endedAt,
        };
        // A HUMAN STEP (control-tower phase 41): the ledger, the one inbox row
        // and the one push are the service's (`deps.humanStep`); the park here
        // waits on a PERSON and charges no external-wait budget (`parkOnStep`).
        const step = declared.step
          ? this.deps.humanStep?.({
            slug: state.slug, phase, birth: 'session', step: declared.step, runId: state.id,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          }) ?? null
          : null;
        if (step) {
          parkOnStep(record, step, 'session', record.endedAt);
          this.record('phase.human-step', stepJournalFields(step), phase);
        }
        // The refs ride the record like a wait's do: when they are
        // machine-checkable (`gh:…`), the healer polls them and resumes this
        // session the moment the world changes — the person is asked AND the
        // machine keeps watch.
        if (declared.watch.length) record.watch = declared.watch;
        clearWatchBookkeeping(record);
        // A person was asked AND a moment was named — "not before 09:00", "give
        // the release an hour". Until now `--until` was refused for anything but
        // `waiting-external`, so a session with a clock and a question had to
        // pick one, and picking the question threw the clock away: the park then
        // sat until a human happened to look, which is the failure this whole
        // plan is about. The ask stands either way; the clock only decides when
        // the console next brings it up.
        const clock = this.armDeclaredClock(phase, record, declared);
        this.record('phase.outcome-needs-human', {
          reason: declared.reason ?? null, watch: declared.watch,
          resumeAfter: record.parkedUntil ?? null,
          ...(clock ? { requested: clock.requested, granted: clock.until, capped: clock.capped } : {}),
        }, phase);
        // The one card: the session named the errand itself, so it is
        // recorded as one — what is needed, in its words, and how to move on.
        // The sub-kind is read from the reason and the refs (a `gh:` ref is
        // `external`), never hardcoded `unknown`: the ladder's table per
        // sub-kind is what keeps a person's park from spending sessions.
        const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: record.endedAt });
        // `need` is the session's own words; `how` is the sub-kind's — a
        // permission wall names the policy, a credential names the sign-in, an
        // external wait names its refs — instead of one sentence for all of
        // them, which was the errand nobody could act on.
        // The session's `--needs` word first, exactly as the classifier reads
        // it (control-tower phase 6): `needs-human --needs external` with no
        // `gh:` ref and no telltale wording used to file `:unknown` here while
        // the classifier called the same park `:external`.
        // `declaredSubKind` — the classifier's own reading, so the card and the
        // situation line name one wall; it is what tells the CLI's protected
        // path from this console's rule (#43).
        const deniedRule = record.toolDenied && record.toolDenied.rule !== 'in-turn-wait';
        const declaredKey = `blocked-declared:${declaredSubKind(record.declared, { denied: Boolean(deniedRule), text: record.note, refs: declared.watch })}`;
        // The SAME external wall a sibling already declared folds into its
        // errand (#19 ask 2): no second errand, no second announcement, and no
        // second park of the run — the first one already told a person.
        const fold = declaredKey === 'blocked-declared:external'
          ? errandFoldTarget(state, phase, (p) => scopes.get(p) ?? ['all'])
          : null;
        if (fold !== null) {
          const target = state.recoveries![String(fold)]!.errand!;
          target.alsoPhases = [...new Set([...(target.alsoPhases ?? []), phase])].sort((a, b) => a - b);
          slot.foldedInto = fold;
          delete slot.errand;
          this.record('phase.errand-folded', { into: fold, situation: declaredKey, need: record.note }, phase);
          this.emit('phase', { phase, status: 'parked', note: record.note, foldedInto: fold });
          this.persist();
          return 'waiting';
        }
        delete slot.foldedInto;
        // `need` is the session's own words; `how` is the sub-kind's. What the
        // watch clock does with the refs (#19 ask 4) is NOT written here: this
        // runs before the scheduler's first probe, and a clause frozen now said
        // "watching … resumes the session" for 69 minutes about a ref refused
        // three seconds later (#125). `watching` marks it; every reader derives
        // the clause from the record as it stands (`liveErrandHow`).
        const watching = pollableRefs(declared.watch).length > 0;
        // A permission wall this console holds no rule for names the act and
        // the path the session declared, not "a tool" (#43).
        const plain = errandFor(declaredKey, [], phase, record.endedAt);
        const composed = deniedRule
          ? plain
          : errandFor(declaredKey, [], phase, record.endedAt, null, null, null, null, null, record.declared);
        const namesAct = composed.need !== plain.need;
        slot.errand = {
          phase,
          situation: declaredKey,
          at: record.endedAt,
          tried: (slot.rungs ?? []).map((r) => `${r.rung}${r.outcome ? ` → ${r.outcome}` : ''}`),
          need: namesAct ? `${composed.need}${declared.reason ? ` The session said: ${declared.reason}` : ''}` : record.note,
          how: composed.how,
          ...(watching ? { watching: true } : {}),
        };
        // A plan the console held for a person (control-tower phase 11, #34):
        // the errand names the plan and the two answers, not a generic gate.
        if (step) {
          // The errand names the act in the step's own words — what, where,
          // and what proves it — rather than the generic `human-acts` ask.
          const meta = KIND_META[step.kind];
          slot.errand.need = `Your turn — ${meta.label.toLowerCase()}: ${step.title}`;
          slot.errand.how = `${step.where === 'host' ? 'At the machine this console runs on' : 'From any device'}`
            + `${step.openUrl ? `, open ${step.openUrl}` : step.openCommand ? `, run \`${step.openCommand}\`` : ''}`
            + `${step.proof ? `; ${step.proof} proves it` : ''}. When it is done, Retry the phase — the same session resumes.`;
          // Not due yet (control-tower phase 121): nobody is summoned until its
          // due-when ref lands — then the step's own push says NOW.
          if (step.state === 'upcoming') {
            slot.errand.need = `Coming up — ${meta.label.toLowerCase()}: ${step.title}`;
            slot.errand.upcoming = true;
          }
        }
        const planHeld = declared.needs === PLAN_APPROVAL_NEED;
        const held = planHeld ? record.planApproval : undefined;
        if (planHeld) {
          slot.errand.need = `A decision on the plan phase ${phase}'s session presented`
            + (held ? ` (${held.bytes} bytes, sha ${held.sha.slice(0, 12)}; the text is kept at ${held.path}).` : '.');
          slot.errand.how = 'Read the plan, then Approve — the same session resumes in acceptEdits and carries it '
            + 'out — or Reject, saying why; the phase stays parked until one of them is pressed.';
        }
        this.record('phase.errand', { ...slot.errand }, phase);
        this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
        // The approvals-timeout vocabulary: nothing is wrong with the work,
        // the question is open, and the phase retries the moment someone
        // answers. Not counted against the failure budget. The KIND is what
        // lets the classifier read this park for what it is even on a record
        // written before `declared` existed.
        // A held plan parks under its own kind, so the classifier, the inbox and
        // the halt card read it as a plan to decide rather than an unnamed ask.
        this.park(`phase ${phase} needs a person: ${record.note}`, phase, planHeld ? 'plan-approval' : 'needs-human');
        return 'halted';
      }
      case 'partial': {
        // "Work remains; resume me." The session said so in the one channel
        // the supervisor reads, so the situation is `work-in-progress` AT
        // ONCE — no evidence gathering, no closeout nudge, no halt — and the
        // ladder's first rung for it is the phase's own session, continued.
        // Bounded like every climb: the caps turn a session that declares
        // partial forever into an errand, never an infinite loop.
        const why = [
          `the session declared partial${declared.reason ? ` (${declared.reason})` : ''} — work remains, resume it`,
        ];
        // Before the climb: the gate reads it at boarding, and a `budget` or
        // `context` reason boards the next attempt fresh (`resumePolicy`).
        record.lastPartial = { sessionId: record.sessionId ?? null, reason: declared.reason ?? null, at: new Date().toISOString() };
        // The console's OWN steer is not a remedy (control-tower phase 5, #14
        // ask 2). A `partial --reason context|budget` from the session the
        // wrap-up notice reached is what that notice told it to declare — so
        // its resume is the console's park, boarded fresh with the resume brief
        // under the phase's own budget, and priced as no rung. Measured on run
        // 31285928: the obedient declaration was refused as a spent run cap one
        // second later, and parked a session's work one merge from done.
        if (this.wrapupAsked(record, declared.reason)) return await this.resumeAfterWrapup(phase, record, declared.reason!);
        const climbed = await this.climb(record, board, 'outcome', {
          situation: situationOf('work-in-progress', why),
          sessionId: record.sessionId,
        });
        this.record('phase.outcome-partial', { reason: declared.reason ?? null, climbed }, phase);
        // Climbed: pending + hint, boards next tick. Not climbed: the ladder
        // parked it with an errand (or deferred it as failed); either way the
        // run carries on with its other candidates.
        if (!climbed && record.status !== 'parked') {
          record.status = 'failed';
          record.note = `declared partial${declared.reason ? ` (${declared.reason})` : ''}, and the ladder has nothing left for this runner`;
          record.endedAt = new Date().toISOString();
        }
        return 'waiting';
      }
      case 'complete':
        return null;
    }
  }

  /**
   * The wrap-up's FAST gate (control-tower phase 89, #127): P43's wrap-up
   * commit said itself that the suite had not run, and on a shared run branch
   * it was at once every sibling's base — red for 15 files, every push
   * blocked, a sibling's own red masked under it. After a `partial --reason
   * context|budget` the console runs the plan's fast gate (`fastGateLines`:
   * this phase's §Verification lines measured fast, within a ten-minute
   * budget) on the COMMITTED work — a clean checkout of HEAD when the tree
   * holds anything uncommitted — and records the answer: red writes `wipRed
   * {sha, files, lines}` on this phase (the boarding order puts the WIP's owner
   * first, every sibling's brief names the files, attribution gives their reds
   * to it); green clears it. Journalled `phase.wip-gate` either way, and when
   * no line is measured fast, that too — nothing was checked, and the record
   * must not read as if something had been.
   */
  protected async wipGate(phase: number): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    if (this.abort?.signal.aborted || this.stopRequested) return;
    // One console pass per phase at a time: a baseline still measuring beside
    // the session that just wrapped up finishes first (control-tower phase 105).
    await this.awaitBaseline(phase);
    const text = await this.deps.verificationText(state.slug, phase);
    const approvals = this.verifyApprovalsFor(phase);
    const commands = extractCommands(text, 'verify', approvals).commands;
    const gate = fastGateLines(commands, readLedger(verificationsFile(state.root, state.slug), state.slug));
    const cwd = await this.verifyCwd(phase);
    const tree = await workingTreeOf(cwd).catch(() => null);
    const sha = tree?.head ?? null;
    if (!gate.lines.length || !sha) {
      this.record('phase.wip-gate', {
        sha, skipped: !sha ? 'git could not name the commit' : 'no line of this phase\'s §Verification is measured fast',
        lines: 0,
      }, phase);
      return;
    }
    // The COMMITTED WIP is what siblings build on; anything uncommitted is set aside.
    const dirty = await uncommittedPaths(cwd).catch(() => null);
    const made = dirty?.paths.some((entry) => !isPaperwork(entry.path)) ? await exportCheckout(dirty.top, sha).catch(() => null) : null;
    const checkout = made && !('refused' in made) ? made : null;
    const runCwd = checkout ? join(checkout.dir, withinRepo(dirty!.top, cwd)) : cwd;
    const startedAt = this.now().toISOString();
    const verify = this.deps.verify ?? verifyPhase;
    let ran: VerifyRun[] = [];
    try {
      const summary = await verify(gate.lines.map((line) => `- \`${line}\``).join('\n'), {
        cwd: runCwd, purpose: 'wip-gate', cascade: false,
        ...(checkout ? { inPlace: cwd } : {}),
        ...(approvals ? { approvals } : {}),
        preflightSkip: this.verifyEnv().preflightSkip,
        timeoutMs: FAST_GATE_BUDGET_MS, timeoutFor: (command) => gate.limitMs[foldCommand(command)] ?? FAST_GATE_BUDGET_MS,
        signal: this.abort?.signal ?? undefined,
        onStart: (command, index, total) => this.noteVerifying(phase, 'wip-gate', { command, index, total }, { startedAt, exported: Boolean(checkout) }),
      });
      ran = RunnerAttempt.finalRows(summary.ran).filter((row) => !row.proven);
    } finally {
      this.noteVerifying(phase, null);
      await checkout?.remove().catch(() => {});
    }
    if (this.abort?.signal.aborted || this.stopRequested) return;
    const red = ran.filter((row) => !row.ok && !row.timedOut && !row.environment);
    const ms = ran.reduce((sum, row) => sum + row.ms, 0);
    if (!red.length) {
      const was = record.wipRed?.sha;
      delete record.wipRed;
      this.record('phase.wip-gate', {
        sha, ok: true, lines: ran.length, ms, ...(checkout ? { exported: true } : {}), ...(was ? { cleared: was } : {}),
      }, phase);
      return;
    }
    // The WIP's files: what was committed on top of the head the phase's first
    // boarding stood on (its baseline's), exactly; by the clock only without
    // one — git dates are whole seconds, so the clock also counts a commit made
    // in the second the phase boarded (WU-1 flaked on it, phase 89).
    const repo = dirty?.top ?? cwd;
    const baseHead = record.baseline?.head;
    const since = record.attemptWindows?.[0]?.startedAt ?? record.attemptStartedAt ?? record.startedAt;
    const files = (baseHead ? await filesCommittedBetween(repo, baseHead, sha).catch(() => null) : null)
      ?? (since ? await filesCommittedSince(repo, since, sha).catch(() => null) : null);
    const wip: WipRed = {
      sha, at: this.now().toISOString(),
      ...(files?.length ? { files } : {}),
      lines: red.map((row) => ({ command: foldCommand(row.command), ...(row.failures?.length ? { failures: row.failures.slice(0, 20) } : {}) })),
    };
    record.wipRed = wip;
    this.record('phase.wip-gate', {
      sha, ok: false, lines: ran.length, ms, red: wip.lines, ...(wip.files ? { files: wip.files } : {}),
      ...(checkout ? { exported: true } : {}),
    }, phase);
  }

  /**
   * What a booting lane must be told about its tree (control-tower phase 89):
   *  - a sibling's committed WIP that its wrap-up gate found RED (`wipRed`,
   *    #127) — the lines, the failing tests, the files, and whose they are;
   *  - a sibling's UNCOMMITTED work in the shared tree, whatever made it stop
   *    (a wrap-up, a `scope-cap` partial — #103's 2026-09-25 10:53Z ask 3),
   *    by file and owner, so it is neither committed nor debugged here;
   *  - the reds other phases' verifications attributed to THIS phase (`owed`,
   *    phase 83's deferral);
   *  - a job of its own that the console's checkpoint ended (`reverify`
   *    `checkpoint`, #121) — consumed here, its brief being the debt's reader.
   * It also reads the plan's fast gate for the lane (`Lane.fastGate`), which the
   * wrap-up notice names. Empty when there is nothing to say.
   */
  protected async boardingWipBlock(phase: number, lane: Lane): Promise<string> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    try {
      const text = await this.deps.verificationText(state.slug, phase);
      const commands = extractCommands(text, 'verify', this.verifyApprovalsFor(phase)).commands;
      lane.fastGate = fastGateLines(commands, readLedger(verificationsFile(state.root, state.slug), state.slug)).lines;
    } catch {
      lane.fastGate = [];
    }
    const some = (items: readonly string[], shown = 12): string => items.slice(0, shown).join(', ')
      + (items.length > shown ? ` and ${items.length - shown} more` : '');
    const lines: string[] = [];
    for (const other of Object.values(state.phases).sort((a, b) => a.phase - b.phase)) {
      const wip = other.wipRed;
      if (other.phase === phase || !wip) continue;
      const red = (wip.lines ?? []).map((line) => `\`${line.command}\`${line.failures?.length ? ` (${some(line.failures, 3)})` : ''}`);
      lines.push(`- Phase ${other.phase}'s work-in-progress is COMMITTED and RED (commit ${wip.sha.slice(0, 12)}): its fast gate `
        + `failed on ${red.length ? red.join(', ') : 'its lines'}.${wip.files?.length ? ` Its files: ${some(wip.files)}.` : ''} `
        + `Those reds are phase ${other.phase}'s — do not debug, revert or fix them here; your §Verification attributes them to phase ${other.phase}.`);
    }
    if (!lane.worktree) {
      const dirty = await uncommittedPaths(await this.verifyCwd(phase)).catch(() => null);
      const paths = (dirty?.paths ?? []).filter((entry) => !isPaperwork(entry.path));
      const byOwner = new Map<number, string[]>();
      if (paths.length) {
        for (const [path, owner] of wipOwners(paths, this.sessionWindows(), phase)) {
          if (typeof owner === 'number') byOwner.set(owner, [...(byOwner.get(owner) ?? []), path]);
        }
      }
      for (const [owner, files] of [...byOwner].sort((a, b) => a[0] - b[0])) {
        const why = state.phases[String(owner)]?.lastPartial?.reason;
        lines.push(`- This tree holds phase ${owner}'s UNCOMMITTED work${why ? ` (it stopped with \`partial --reason ${why}\`)` : ''}: `
          + `${files.length} file(s) — ${some(files.sort())}. They are phase ${owner}'s: do not commit, stash, reset or debug them; `
          + 'stage only your own paths (`git add <path>`, never `git add -A`).');
      }
    }
    for (const owed of record.owed ?? []) {
      lines.push(`- Phase ${owed.by}'s §Verification found \`${owed.command}\`${owed.chain ? ` (a member of \`${owed.chain}\`)` : ''} red`
        + `${owed.failures.length ? ` (${some(owed.failures, 3)})` : ''} and attributed it to THIS phase (${owed.how}`
        + `${owed.paths?.length ? `: ${some(owed.paths, 5)}` : ''}). It stays owed on your record until this line runs green here.`);
    }
    if (record.reverify?.cause === 'checkpoint') {
      const jobs = record.reverify.jobs?.length ? ` (${record.reverify.jobs.join(', ')})` : '';
      lines.push(`- The console's checkpoint at ${record.reverify.at} ended your previous session while it waited on a job of its own${jobs}. `
        + 'A checkpoint signals the session\'s whole process group, so that job ended with it unless it was started detached: check its '
        + 'output, re-run what is missing DETACHED (`nohup setsid <command> > /tmp/<name>.log 2>&1 &`), and declare `waiting-external` '
        + 'on a marker it writes rather than waiting inside the turn.');
      delete record.reverify;
      this.persist();
    }
    // A background subagent the previous session left running past its handoff,
    // stopped by the CLI's ceiling mid-work (control-tower phase 109, #188,
    // BG-3) — consumed here, the brief being its reader.
    lines.push(...this.agentsKilledLines(record));
    if (!lines.length) return '';
    return `\n\nWHAT THE CONSOLE KNOWS ABOUT THIS TREE (read as this phase boarded — control-tower phase 89):\n${lines.join('\n')}\n`;
  }

  /** The brief's lines for `record.agentsKilled`, which they consume (control-tower phase 109, #188). */
  protected agentsKilledLines(record: PhaseRecord): string[] {
    const killed = record.agentsKilled;
    if (!killed) return [];
    const lines = killed.agents.map((agent) => `- Your previous session's background subagent `
      + `${agent.description ? `"${agent.description}"` : `(task ${agent.id})`} was still running when that session ended`
      + `${killed.handedOffAt ? ` — after it handed off at ${killed.handedOffAt}` : ''} — and the CLI's ten-minute ceiling stopped it `
      + `mid-work.${agent.lastText ? ` Its last words: "${agent.lastText.replace(/\s+/g, ' ').trim()}".` : ''}`);
    if (killed.paths.length) {
      const shown = killed.paths.slice(0, 12).join(', ') + (killed.paths.length > 12 ? ` and ${killed.paths.length - 12} more` : '');
      lines.push(`- Paths written ${killed.handedOffAt ? 'after that handoff' : 'as that session ended'} and never committed — that agent's `
        + `half-finished work, not the WIP the handoff describes: ${shown}. Read each before you keep, finish or discard it.`);
    }
    delete record.agentsKilled;
    this.persist();
    return lines;
  }

  /**
   * The agents a session's process ended with still running (control-tower
   * phase 109, #188, BG-3): the CLI stops them at its ceiling, ten minutes
   * after the turn ends, mid-edit. Kept on the record for the next boarding's
   * brief — each one's description and newest words, and the uncommitted
   * paths written after the session handed off (its declaration's time), so
   * the next attempt never mistakes them for its predecessor's own WIP.
   */
  protected async noteAgentsKilled(phase: number, lane: Lane, outcome: SpawnOutcome): Promise<void> {
    const open = new Set((outcome.signal.backgroundTasks ?? []).map((task) => task.id));
    const agents = (lane.signals.endedWithProcess ?? []).filter((task) => open.has(task.id));
    lane.signals.endedWithProcess = [];
    if (!agents.length) return;
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const declared = readOutcome(outcomeFileFor(state.root, state.slug, state.id, phase), {
      slug: state.slug, phase, notBefore: record.attemptStartedAt ?? record.startedAt,
    });
    const handedOffAt = declared?.written_at ?? null;
    const after = handedOffAt ? Date.parse(handedOffAt) : Math.min(...agents.map((task) => task.lastAt ?? task.since));
    const dirty = await uncommittedPaths(await this.verifyCwd(phase)).catch(() => null);
    const paths = (dirty?.paths ?? [])
      .filter((entry) => !isPaperwork(entry.path) && entry.mtimeMs !== null && entry.mtimeMs > after)
      .map((entry) => entry.path).sort().slice(0, 40);
    record.agentsKilled = {
      at: this.now().toISOString(), handedOffAt, paths,
      agents: agents.map((task) => ({
        id: task.id, ...(task.description ? { description: task.description } : {}),
        ...(task.lastText ? { lastText: task.lastText } : {}), ...(task.tool ? { tool: task.tool } : {}),
      })),
    };
    this.record('phase.agents-killed', {
      agents: record.agentsKilled.agents.map((agent) => ({ id: agent.id, description: agent.description ?? null })),
      handedOffAt, paths,
    }, phase);
    this.persist();
  }

  /**
   * The console's own lane (control-tower phase 89, #68's 2026-09-25 05:44Z
   * comment): which command of which pass the runner is running for a phase —
   * under its grant, with no session — written as each command starts and gone
   * when the pass ends (`purpose` null). `/api/runs` and the Runs page read it
   * as `state.verifying`; `children` holds only sessions, so a run
   * mid-verification used to read `running` with nothing in it.
   */
  protected noteVerifying(
    phase: number, purpose: VerifyingLane['purpose'] | null,
    at?: { command: string; index: number; total: number },
    opts: { startedAt?: string; exported?: boolean; stage?: 'setup'; only?: VerifyingLane['purpose'] } = {},
  ): void {
    const state = this.state;
    if (!state) return;
    const key = String(phase);
    if (!purpose || !at) {
      if (!state.verifying?.[key]) return;
      // A pass ends only its OWN entry: a baseline measured beside the session
      // (control-tower phase 105) is not ended by another pass's cleanup.
      if (opts.only && state.verifying[key]!.purpose !== opts.only) return;
      delete state.verifying[key];
      if (!Object.keys(state.verifying).length) delete state.verifying;
    } else {
      const now = this.now().toISOString();
      (state.verifying ??= {})[key] = {
        phase, purpose, command: at.command.replace(/\s+/g, ' ').trim().slice(0, 200), index: at.index + 1, total: at.total,
        startedAt: opts.startedAt ?? state.verifying[key]?.startedAt ?? now, commandStartedAt: now,
        ...(opts.exported ? { exported: true } : {}), pid: process.pid,
        ...(opts.stage ? { stage: opts.stage } : {}),
      };
    }
    this.persist();
    this.emit('run', { state });
  }

  /**
   * The command a pass is running has its process (control-tower phase 105,
   * #173): recorded on the lane's entry as `(pid, procStartedAt)`, so a reader
   * that does not know this run is live reads a lane in its Setup or its
   * baseline as the work in flight it is (`laneInFlight`).
   */
  protected noteVerifyingChild(phase: number, pid: number): void {
    const check = this.state?.verifying?.[String(phase)];
    if (!check) return;
    // The WALL clock, never the runner's (a test's) — it is compared with the
    // kernel's start time for the pid, exactly as a session's is.
    check.child = { pid, procStartedAt: new Date().toISOString() };
    this.persist();
  }

  /**
   * Did the console's wrap-up notice reach THIS attempt's session, and is the
   * declaration the one it asked for? The notice is spent once per session id
   * (`record.contextWrapup`, `Runner.noteContext`) — so a stamp for the
   * session that just declared, written after this attempt began, is the proof.
   */
  /**
   * How many uncommitted, non-paperwork paths of a SHARED tree are this
   * phase's own — written inside its sessions' windows (`wipOwners` 'self')
   * — or 0, and always 0 for a lane with its own worktree: nothing a sibling
   * boards into holds them (control-tower phase 109, #192).
   */
  private async ownUncommittedShared(phase: number): Promise<number> {
    if (this.lanes.get(phase)?.worktree) return 0;
    const dirty = await uncommittedPaths(await this.verifyCwd(phase));
    const paths = (dirty?.paths ?? []).filter((entry) => !isPaperwork(entry.path));
    if (!paths.length) return 0;
    return [...wipOwners(paths, this.sessionWindows(), phase).values()].filter((owner) => owner === 'self').length;
  }

  private wrapupAsked(record: PhaseRecord, reason: string | null | undefined): boolean {
    if (reason !== 'context' && reason !== 'budget') return false;
    const told = record.contextWrapup;
    if (!told || told.sessionId !== (record.sessionId ?? null)) return false;
    return !record.attemptStartedAt || told.at >= record.attemptStartedAt;
  }

  /**
   * The wrap-up's resume: fresh, with the resume brief, spending no rung — the
   * checkpoint's own re-board (`Runner.noteContext`), for the session that
   * obeyed before the checkpoint had to act. Bounded by the declarations
   * ledger (`DECLARATIONS_MAX_PER_PHASE`), which counted this `partial` above.
   */
  private async resumeAfterWrapup(phase: number, record: PhaseRecord, reason: string): Promise<'waiting'> {
    const sessionId = record.sessionId ?? null;
    const told = record.contextWrapup!;
    // What the wrap-up left on the branch is checked before anything builds on
    // it (control-tower phase 89, #127): the plan's fast gate, on the commit.
    await this.wipGate(phase).catch((error: unknown) => {
      this.record('phase.wip-gate', { skipped: `the gate could not run: ${error instanceof Error ? error.message : String(error)}`, lines: 0 }, phase);
    });
    prepareReboard(record);
    record.resumeSessionId = undefined;
    const hint: BoardingHint = reboardResumeBrief(
      `The previous session of this phase handed off at the console's wrap-up notice (${reason}: `
      + `${Math.round(told.context / 1000)}k of a ${Math.round(told.window / 1000)}k context window). This is the `
      + 'fresh session that notice asked for: read the handoff\'s Outstanding section, git status and git diff first, '
      + 'then carry the phase to its exit criteria.',
    );
    record.boardingHint = hint;
    record.wrapupResumes = (record.wrapupResumes ?? 0) + 1;
    record.note = `handed off at the console's wrap-up notice (${reason}) — the next attempt boards fresh with the resume brief`;
    this.record('phase.resume-automatic', {
      trigger: 'outcome', path: 'wrapup', count: record.wrapupResumes, sessionId, reason, by: 'console',
    }, phase);
    // Its lane is kept while its own WIP sits uncommitted in a shared tree
    // (control-tower phase 109, #192): it re-boards before any sibling whose
    // scope meets it, in the very pass that released it.
    const paths = await this.ownUncommittedShared(phase).catch(() => 0);
    if (paths) {
      record.keepsLane = { at: hint.at, reason, sessionId, paths };
      this.record('phase.lane-kept', { reason, paths, sessionId }, phase);
    }
    this.record('phase.outcome-partial', { reason, climbed: false, wrapup: true }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status, note: record.note });
    return 'waiting';
  }

  /**
   * A phase whose handoff (or declared outcome) says it is blocked. The
   * situation classifier reads the blocker STATEMENT — the Outstanding text,
   * the declared reason, the watch refs, the session's words — and the ladder
   * answers: `blocked-declared:lock` re-queues, `:credential`/`:gate` park
   * with an errand at once (no session spent), `:unknown` gets ONE bounded
   * unblock session, and a ladder with nothing left for this runner falls to
   * the old `phase-blocked` halt, which the service's healer can still act on
   * with a vehicle this loop does not have.
   */
  /**
   * Park a `blocked` declaration whose only lock ref named the phase's own
   * lock (#42): refused at ingest, so there is no holder to wait for, and a
   * queue rung would re-board the phase the moment its own closeout released
   * that lock. It is a person's to read — the errand says what was declared
   * and why the watch was refused.
   */
  private parkOwnLockBlock(phase: number, declared: PhaseOutcome): 'waiting' {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const at = new Date().toISOString();
    record.status = 'parked';
    record.note = declared.reason ?? `blocked on its own lock (${declared.refused!.join(', ')})`;
    record.endedAt = at;
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: at });
    delete slot.foldedInto;
    const key = 'blocked-declared:unknown';
    const base = errandFor(key, slot.rungs ?? [], phase, at);
    slot.errand = {
      ...base,
      need: record.note,
      how: `The watch it declared (${declared.refused!.join(', ')}) was refused — ${OWN_LOCK_WATCH_REFUSAL} ${base.how}`,
    };
    this.record('phase.errand', { ...slot.errand, label: 'Declared blocked', reason: 'its only lock ref was its own', by: 'closed' }, phase);
    this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
    this.persist();
    return 'waiting';
  }

  private async closedBlocked(
    phase: number, board: Board, declared: PhaseOutcome | null,
  ): Promise<'waiting' | 'halted'> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const climbed = await this.climb(record, board, 'closed', {
      declared: declared
        ? { status: declared.status, reason: declared.reason, watch: declared.watch, ...(declared.needs ? { needs: declared.needs } : {}), writtenAt: declared.written_at }
        : null,
    });
    if (climbed) return 'waiting';
    // Parked with an errand, re-queued behind a lock, or waiting on the refs it
    // declared (the runner's `poll-park`, control-tower phase 87): the run
    // carries on.
    if (['parked', 'pending', 'queued', 'waiting'].includes(record.status)) return 'waiting';

    record.status = 'failed';
    record.note = declared?.reason ?? (record.said ? condenseSaid(record.said) : 'the handoff declares this phase blocked');
    record.endedAt = new Date().toISOString();
    // Paperwork, not an attempt: a recheck that re-reads the same blocked
    // handoff charges no failure (RCV-4); the first record of it still counts.
    // A block that named refs the watch clock can poll is a WAIT (#122) — the
    // loop parks it before it gets here, so one that arrives anyway is held as
    // `declared-wait`; one naming none is the phase's `declared-blocked`. Either
    // is charged on its ROOT CAUSE: the blamed commit, else the refs it watched.
    const refs = declared?.watch ?? (record.declared?.status === 'blocked' ? record.declared.watch ?? [] : []);
    const retired = new Set(record.watchRetired ?? []);
    // A ref that already landed was waited out — blocked again, it is no wait.
    const waitedOut = !declared && Boolean(record.declared?.landed);
    const watched = !waitedOut && pollableRefs(refs).some((target) => !retired.has(target.ref));
    if (!(this.rechecking === phase && record.halt?.kind === 'phase-blocked')) {
      this.chargeFailure(phase, watched ? 'declared-wait' : 'declared-blocked', 'the handoff declares the phase blocked',
        failureRootOf({ refs, state }));
    }
    this.halt(
      declared
        ? `phase ${phase} declared itself blocked: ${declared.reason ?? 'no reason recorded'}`
          + (declared.watch.length ? ` (watching ${declared.watch.join(', ')})` : '')
        : `phase ${phase}'s handoff declares it blocked`
          + (record.said ? ` — it signed off: "${condenseSaid(record.said)}"` : '')
          + '. Its Outstanding section says what is missing; clear that, then Retry '
          + '(or resume the session with an instruction once the blocker is gone).',
      phase,
      'phase-blocked',
    );
    return 'halted';
  }

  /**
   * A declared park's own resume clock, for the two statuses that are not
   * `waiting-external`.
   *
   * `--wait-minutes`/`--until` used to belong to `waiting-external` alone, and
   * the refusal was defensible — those two words mean "a machine will settle
   * this" and the others mean "a person must". But a session can know BOTH: a
   * person has to look, *and* there is no point looking before the release
   * lands at 09:00. Forced to choose, a session chose the question, and the
   * clock — the one fact that could have moved the phase without anybody — was
   * discarded at the parser.
   *
   * So the clock is now honoured for `blocked` and `needs-human` too, and it
   * changes nothing about the ask: the errand is still written, the situation
   * is still `blocked-declared`, and a person is still the one who settles it.
   * All this decides is when the console next brings the phase up on its own.
   *
   * Floored exactly as `parkWaiting` floors it: a moment already past means "as
   * soon as sensible", never a resume that chases its own tail.
   */
  private armDeclaredClock(
    phase: number, record: PhaseRecord, declared: { resume_after?: string },
  ): DeclaredClock | null {
    // One arithmetic for the three paths that arm this clock (`declaredClock`):
    // floored as `parkWaiting` floors, and CAPPED at `DECLARED_CLOCK_MAX_MS` —
    // `needs-human --until <a month out>` used to park for a month while
    // `waiting-external --until <nine hours out>` was cut to eight (WAI-8). The
    // caller journals `capped`, so the ceiling is never applied in silence.
    const clock = declaredClock(declared.resume_after, { floorMs: this.deps.waitFloorMs });
    if (!clock) return null;
    record.parkedUntil = clock.until;
    this.armParkPoke(phase, clock.until);
    return clock;
  }

  /**
   * A declared word past its cap (WAI-8): recorded, not acted on. The phase
   * parks for a PERSON — the count is the operator's Retry to clear — with an
   * errand that says what was declared, how often, and what to do; the record
   * keeps the earlier declaration, which is the one that stands.
   */
  private refuseDeclaredWord(
    phase: number, record: PhaseRecord, state: RunState, charge: DeclarationCharge,
  ): 'halted' {
    const at = new Date().toISOString();
    record.status = 'parked';
    record.note = `declared ${charge.status} for the ${charge.count + charge.refused}${ordinalSuffix(charge.count + charge.refused)} time — `
      + `${charge.max} were acted on; recorded, not acted on. Retry the phase to clear the count.`;
    record.endedAt = at;
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: at });
    slot.errand = {
      phase,
      // `unknown`'s family: a session that keeps declaring one word is a defect
      // report, and `unknown` is the situation whose every rung is an errand.
      situation: 'unknown:declaration-cap',
      at,
      tried: (slot.rungs ?? []).map((r) => `${r.rung}${r.outcome ? ` → ${r.outcome}` : ''}`),
      need: `a person to decide about phase ${phase}: its sessions keep declaring ${charge.status} `
        + `(${charge.count} acted on, ${charge.refused} refused)`,
      how: `Read the phase's journal for why each attempt ended ${charge.status}, then Retry the phase — `
        + 'an operator\'s Retry clears the declarations ledger — or close the phase by hand.',
    };
    this.record('phase.errand', { ...slot.errand }, phase);
    this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
    this.park(`phase ${phase} declared ${charge.status} past its cap: ${record.note}`, phase, 'needs-human');
    return 'halted';
  }

  /**
   * A ref-less wait the console could neither adopt nor read off the plan
   * (TRS-3): parked for a person, with the one errand that says what the
   * session waited on and which plan line would have let the console watch it.
   * Rare by construction — every poll loop, `--watch`, `sleep` and `gh` watch
   * mints — so the ask is a plan-authoring defect surfaced once, never the
   * console asking mid-run about work it could have watched.
   */
  private refuseRefless(phase: number, record: PhaseRecord, state: RunState, command: string, reason: string | null): false {
    const at = new Date().toISOString();
    record.status = 'parked';
    record.note = `declared waiting-external with no --watch ref after the console refused \`${command.slice(0, 120)}\` — `
      + 'nothing can watch that wait, so it is a person\'s. Name the ref (or a `- **Waits on:**` line in the plan), then Retry.';
    record.endedAt = at;
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: at });
    slot.errand = {
      ...errandFor('blocked-declared:external', slot.rungs ?? [], phase, at, null),
      need: `a watch ref for phase ${phase}: the session waited on \`${command.slice(0, 200)}\` inside a turn, was refused, `
        + `and declared waiting-external with no ref${reason ? ` (${reason.slice(0, 160)})` : ''} — the console cannot watch a wait nobody named.`,
      how: 'Give the plan a `- **Waits on:** <ref> · <max>` line for this phase (a `cmd:`, `gh:` or `date:` ref the console '
        + 'can poll) and Retry; or resume the session with the ref to declare. A poll loop, a `--watch` runner, a `sleep` '
        + 'and a `gh run watch` would have been adopted by themselves — this command was none of those.',
    };
    this.record('phase.errand', { ...slot.errand }, phase);
    this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
    this.park(`phase ${phase} declared a wait the console cannot watch: ${record.note}`, phase, 'needs-human');
    return false;
  }


  /**
   * Park a phase on an external clock. True when the phase now waits — on a
   * clock, or, when the allowance is spent, on its refs alone with a `budgets`
   * errand (`parkOnSpentBudget`, control-tower phase 45); false only when the
   * declaration was refused outright (a wait nobody named a ref for).
   *
   * Every park is answered by `evaluateWait` — the one expression, shared with
   * the resume — and says what it granted against what was asked. A declared
   * window past the budget is never cut short in SILENCE (WAI-1): one naming a
   * ref the clock can poll is granted what is left, journalled `capped`, and
   * the ref's landing ends it; one nothing can end sooner is refused with the
   * arithmetic, naming the one line that would have allowed it.
   *
   * `by` is who parked it (SLF-9): the session, a hand session through the
   * inbox, or the console's own watchdog — whose parks spend a ledger of their
   * own and never the session's allowance (WAI-5). `budget` is the plan's word
   * for this phase (`waitBudgetOf`); a synchronous caller passes nothing and
   * gets what was already read.
   *
   * `blocked` (control-tower phase 87, #122, #126) is the runner's `poll-park`:
   * a `blocked` declaration naming refs the watch clock can poll parks HERE,
   * through the same budget and window as a `waiting-external` one, and keeps
   * its own word — `status: 'blocked'`, its `--needs`, `parked: 'poll-park'`.
   * It used to have no vehicle but the healer's, which only acts on a stopped
   * run, so on a live run it was settled `failed` and charged to the streak.
   */
  protected parkWaiting(
    phase: number, declared: PhaseOutcome,
    opts: { by?: WaitAuthor; budget?: WaitBudget; minted?: string[]; blocked?: boolean } = {},
  ): boolean {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const by: WaitAuthor = opts.by ?? 'session';
    const ledger = by === 'watchdog' ? 'watchdog' : 'session';
    // The session's own word and what the park adds to it — the same stamps
    // on a clock park and on a spent-budget park.
    const testimony = opts.blocked
      ? { status: 'blocked' as const, ...needsOf(declared), parked: 'poll-park' as const }
      : { status: 'waiting-external' as const };
    const now = Date.now();
    const at = new Date(now).toISOString();
    const waits = ledger === 'watchdog' ? (record.watchdogParks ?? 0) : (record.waits ?? 0);
    // A wait declared with no ref, right after the console refused the session
    // its own way of watching (TRS-3, RCV-5): the guard's denial hands the
    // session a recipe ending in `--watch <ref>`, and the measured session
    // declared 37 s later with `watch: []` — a blind clock, resumed 581 minutes
    // late. The console follows its own recipe: it mints the ref from the
    // command it refused and ADOPTS the job (the ref is marked minted, so it
    // runs only under `watchMintedCmdRefs`); failing that, the plan's own
    // `Waits on:` refs; failing both, the declaration is REFUSED and the phase
    // parks for a person with an errand naming the command and the plan line
    // that would have allowed it. The denial is read from the record, not the
    // lane: `applyEvent` drops the lane's episode on the very
    // `phase-outcome.sh` call that declares, and a restart between the two
    // would lose it entirely.
    let watchList = declared.watch;
    let minted = opts.minted;
    if (by === 'session' && !watchList.length) {
      const denied = record.toolDenied?.rule === 'in-turn-wait' && record.toolDenied.command ? record.toolDenied : null;
      const sinceBoarding = record.attemptStartedAt ? Date.parse(record.attemptStartedAt) : 0;
      if (denied && Date.parse(denied.at) >= sinceBoarding) {
        const budget = opts.budget ?? this.knownWaitBudget(phase);
        const ref = mintWatchRef(denied.command!, now);
        if (ref) {
          watchList = [ref];
          minted = [...(minted ?? []), ref];
          this.record('phase.watch-missing', {
            command: denied.command, matched: denied.matched ?? null, deniedAt: denied.at,
            adopted: [ref], from: 'denial', source: 'declaration', by,
          }, phase);
        } else if (budget.refs.length) {
          watchList = [...budget.refs];
          this.record('phase.watch-missing', {
            command: denied.command, matched: denied.matched ?? null, deniedAt: denied.at,
            adopted: watchList, from: 'plan', source: 'declaration', by,
          }, phase);
        } else {
          this.record('phase.watch-missing', {
            command: denied.command, matched: denied.matched ?? null, deniedAt: denied.at,
            adopted: null, from: null, source: 'declaration', by,
          }, phase);
          this.record(DECLARATION_REFUSED_EVENT, {
            status: 'waiting-external', why: 'watch-missing', command: denied.command,
            reason: declared.reason ?? null, by,
          }, phase);
          return this.refuseRefless(phase, record, state, denied.command!, declared.reason ?? null);
        }
      }
    }
    declared = { ...declared, watch: watchList };
    // Refs nothing will ever probe are named, not dropped (WAI-11): the session
    // said how to know its wait was over, and a silent clock is not that.
    const unpollable = unpollableRefs(declared.watch);
    for (const { ref, reason } of unpollable) this.record('phase.watch-unpollable', { ref, reason, by }, phase);
    // A wait on this console's own state alone spends no budget (#126, rule 0).
    const unbudgeted = !spendsWaitBudget(declared.watch);
    const verdict = evaluateWait({
      now,
      requestedUntil: declared.resume_after ? Date.parse(declared.resume_after) : undefined,
      parkedMs: parkedMsOf(record, now),
      waits,
      budget: opts.budget ?? this.knownWaitBudget(phase),
      ledger,
      floorMs: this.deps.waitFloorMs ?? WAIT_FLOOR_MS,
      dates: pollableRefs(declared.watch).flatMap((target) => (target.kind === 'date' ? [[target.ref, target.at] as const] : [])),
      // Rule 7 (control-tower phase 45, #59): a window past the budget that
      // names a ref the clock can poll is granted what is left.
      pollable: pollableRefs(declared.watch).length > 0,
      unbudgeted,
    });
    if (verdict.verdict !== 'park') {
      // A spent budget is a BUDGET event (#59): the phase parks on its refs
      // with a `budgets` errand — never `failed`, never a streak charge, never
      // a rung — and a landing still resumes it. This arm used to consume the
      // declaration with its refs, charge the streak and halt
      // `waiting-external-timeout`: nothing watched the build it waited on
      // from then on, and the same phase's two refusals read "2 phases failed
      // in a row".
      const budget = opts.budget ?? this.knownWaitBudget(phase);
      const requested = declared.resume_after && Number.isFinite(Date.parse(declared.resume_after))
        ? new Date(Date.parse(declared.resume_after)).toISOString()
        : undefined;
      clearWatchBookkeeping(record);
      if (unpollable.length) record.watchUnpollable = unpollable; else delete record.watchUnpollable;
      this.parkOnSpentBudget(phase, {
        ledger: verdict.ledger, refusal: verdict.reason, budget,
        declared: {
          ...testimony,
          ...(declared.reason ? { reason: declared.reason } : {}),
          ...(declared.watch.length ? { watch: declared.watch } : {}),
          by,
          ...(requested ? { requested } : {}),
          ...(minted?.length ? { minted } : {}),
          budget: { ms: budget.budgetMs, source: budget.source },
          at,
        },
      });
      return true;
    }
    const until = new Date(verdict.until).toISOString();
    const requested = verdict.requestedSource === 'declared' || verdict.extendedBy
      ? new Date(verdict.requested).toISOString()
      : undefined;
    // Approaching (control-tower phase 14, #40): a grant that carries the phase
    // past BUDGET_WARN_PCT of its wait budget says so NOW, while there is still
    // time to raise it — once per attempt, and again after a raise.
    const near = unbudgeted ? null : waitApproaching({ parkedMs: verdict.parkedMs, grantedMs: verdict.granted, budget: verdict });
    if (near) {
      const fact = waitBudgetFact(record, { budgetMs: verdict.budgetMs, source: verdict.budgetSource }, {
        now, askedMs: verdict.requested - now,
      });
      this.noteBudgetApproaching('phase', phase, fact, `${record.attempts ?? 0}:${verdict.budgetMs}`, {
        crossesAt: new Date(now + near.crossesInMs).toISOString(),
      });
    }
    record.status = 'waiting';
    record.parkedUntil = until;
    // Every park writes BOTH clocks (WAI-6): the run's follows the soonest waiter,
    // so a loop killed before `enterRunWaiting` leaves a run a reader can re-arm.
    syncWaitClock(state);
    record.parkReason = declared.reason;
    record.watch = declared.watch.length ? declared.watch : undefined;
    if (unpollable.length) record.watchUnpollable = unpollable; else delete record.watchUnpollable;
    // The declaration itself, persisted: the classifier reads it after a
    // restart or a stop clobbers `status`, which is what kept this park from
    // being re-read as work-in-progress and re-boarded at $10 a pass. `by`
    // says whose testimony it is.
    const stamped = opts.budget ?? this.knownWaitBudget(phase);
    record.declared = {
      ...testimony,
      ...(declared.reason ? { reason: declared.reason } : {}),
      ...(declared.watch.length ? { watch: declared.watch } : {}),
      by,
      ...(requested ? { requested } : {}),
      ...(minted?.length ? { minted } : {}),
      // What the park was judged against — the `cmd:` clock stops at its end
      // without asking the engine again (`waitBudgetEndOf`, control-tower phase 6).
      budget: { ms: stamped.budgetMs, source: stamped.source },
      at,
    };
    clearWatchBookkeeping(record);
    if (ledger === 'watchdog') record.watchdogParks = waits + 1; else record.waits = waits + 1;
    // When the park began — on its own field, and in the history the budget is
    // summed from. `endedAt` is no longer rewritten: it meant three things.
    record.parkedFrom = at;
    openWaitEntry(record, {
      parkedFrom: at, parkedUntil: until, ...(requested ? { requested } : {}), by, ...(unbudgeted ? { unbudgeted: true as const } : {}),
    }, now);
    record.parkedMs = parkedMsOf(record, now);
    if (!isSessionGone(record, record.sessionId)) record.resumeSessionId ??= record.sessionId;
    this.record('phase.waiting', {
      until, reason: declared.reason ?? null, watch: declared.watch, waits: record.waits ?? 0,
      requested: new Date(verdict.requested).toISOString(), requestedSource: verdict.requestedSource,
      granted: verdict.granted, capped: verdict.capped,
      budgetMs: verdict.budgetMs, budgetSource: verdict.budgetSource, budgetRemainingMs: verdict.budgetRemainingMs,
      parkedMs: verdict.parkedMs, by,
      ...(verdict.extendedBy ? { extendedBy: verdict.extendedBy } : {}),
      ...(ledger === 'watchdog' ? { watchdogParks: record.watchdogParks } : {}),
      ...(unpollable.length ? { unpollable: unpollable.map((entry) => entry.ref) } : {}),
      // The runner's own `poll-park` of a declared block (#122) — the rung the
      // healer's table names, driven here and accounted on no ladder.
      ...(opts.blocked ? { declared: 'blocked', rung: 'poll-park', vehicle: 'runner' } : {}),
      ...(unbudgeted ? { unbudgeted: true } : {}),
      // A date beside a live ref is a BACKSTOP (control-tower phase 121, #181).
      ...(backstopOf(declared.watch) ? { backstop: backstopOf(declared.watch)!.backstop } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: until });
    this.armParkPoke(phase, until);
    return true;
  }

  /**
   * The one continuation a phase gets when it did the work and did not record it.
   *
   * Deliberately narrow. It resumes the phase's OWN session — the console never
   * writes the repo itself (`engine.ts` and `writes.ts` both refuse `--git`), and
   * a handoff invented by the supervisor would be a document nobody wrote
   * describing work it did not do. And it only runs when there is something to
   * record: a session that produced nothing is a session that failed, and
   * spending another one on it buys a second identical failure. That is the case
   * this was written for — a phase blocked before its first edit, which no amount
   * of resuming would have closed.
   */
  private async closeout(
    phase: number, boardState: string,
  ): Promise<{ ran: boolean; frozen?: true; note?: string; worked?: boolean }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    if (record.closeout) return { ran: false, note: 'a closeout was already attempted for this phase' };
    // A recheck spawns nothing — the operator asked for a look, not a session
    // (RCV-4). `closeout` and `resume` are the recoveries that spend.
    if (this.rechecking === phase) return { ran: false, note: 'a recheck starts no session' };
    if (!record.sessionId) {
      return { ran: false, note: 'there is no session left to resume, so the runner could not ask it to finish' };
    }
    // A closeout is a whole `claude` session and it never passes through
    // `admit()`, so the scheduler's fleet holder cannot see it. Worse than a
    // reviewer: the phase's own lane has already resolved by now and its pid is
    // nulled, so a Freeze-all landing in this window marked the lane frozen and
    // started a fresh session anyway.
    //
    // Deliberately NOT stamped on `record.closeout` — the one-shot marker above
    // is set only by an attempt that actually ran, so this is a genuine DEFER:
    // the phase is still owed its closeout, and a thawed run reaches this again.
    const frozen = this.fleetFrozen();
    if (frozen) {
      return {
        ran: false,
        frozen: true,
        note: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''}, so no closeout session was started`
          + ' — this phase keeps its session and is closed out when the console thaws',
      };
    }

    const worked = await this.producedWork(phase, boardState);
    if (!worked.did) {
      return { ran: false, worked: false, note: `${worked.why}, so there was nothing to close out` };
    }

    // The one gate, as every `--resume` takes it — this site never asked, so a
    // closeout could resume a session stamped gone or one still running.
    const gate = this.resumableSession(record, record.sessionId);
    if (!gate.ok) {
      return { ran: false, worked: true, note: closeoutSkipNote(gate, record.sessionId) };
    }
    const started = new Date().toISOString();
    this.record('phase.closeout', { sessionId: record.sessionId, boardState, because: worked.why }, phase);
    this.emit('phase', { phase, status: 'verifying', closeout: true });

    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'closeout', {
        prompt: closeoutPrompt(state.slug, phase, boardState,
          state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
        // The same tree the phase ran in. A closeout that wrote its handoff in
        // the shared root while the work sat in a lane worktree would commit the
        // paperwork to a different branch from the code it describes.
        cwd: this.laneRoot(phase),
        addDirs: this.addDirsFor(phase),
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} closeout`,
        resumeFrom: gate.resume,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          ...(await this.claimEnv(phase)),   // all four claim fields (LCK-6)
          ...this.messagingEnv(),
          // …and where it records a finding outside its phase (phase 12), from the
          // sibling helper, so a site cannot state the mailbox and forget the ledger.
          ...this.issuesEnv(),
          // Armed, not merely named: `armOutcomeFile` deletes whatever is
          // there, so a stale file from a previous attempt can never speak for
          // this one. `written_at` is the second guard, on read.
          PE_OUTCOME_FILE: this.armOutcomeFile(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
          // Where `phase-outcome.sh … verified` records what this session proved (control-tower phase 62),
          // and where its lines are judged — the proof is keyed there (phase 106, `proofEnv`).
          ...(await this.proofEnv(phase)),
          // Where the session publishes its TASK LIST. A clone of the outcome
          // channel next door, for the same reason: the CLI stopped
          // provisioning TodoWrite/TaskCreate to `-p` sessions in August 2026,
          // so the panel that says what a run is doing went blank. A shell
          // script cannot be un-provisioned. Armed, not merely named.
          PE_TASKS_FILE: this.armTasksFile(phase),
        }),
        signal: this.abort?.signal,
        // As in `attempt` and `resumeWithInstruction`: a closeout is a live
        // session like any other, and one the console could not freeze or stop
        // because nothing recorded its child.
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      }, {
        // A closeout is paperwork, not the phase. Capping it — a quarter of the
        // phase's dollars, a closeout's turns — keeps a confused session from
        // re-opening the work it was asked only to record.
        caps: capsFor({ mode: 'closeout', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd }),
      });
    } catch (error) {
      return { ran: false, worked: true, note: `the closeout session could not be started: ${(error as Error)?.message ?? error}` };
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    // The dollars were booked by the spawn door (`bookSpend`): a closeout
    // resumes the phase's own conversation, so what it cost is the rise.
    record.turns = (record.turns ?? 0) + outcome.turns;
    // The closeout's words live on the closeout, never over `record.said`: the
    // halt that follows a failed closeout quotes the PHASE session — the words
    // that explain why no handoff was written — and the closeout's "I could
    // not" used to overwrite them before the halt read them.
    const closeoutSaid = outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200) : undefined;
    record.closeout = {
      at: started,
      ok: classify(outcome.signal).kind === 'ok',
      sessionId: record.sessionId,
      note: worked.why,
      ...(closeoutSaid ? { said: closeoutSaid } : {}),
    };
    this.record('phase.closeout-done', {
      ok: record.closeout.ok, costUsd: outcome.bookedUsd ?? outcome.costUsd, turns: outcome.turns,
      said: closeoutSaid,
    }, phase);

    return { ran: true, worked: true, note: 'the runner asked its session to finish the closeout' };
  }

  /**
   * Did this session leave anything worth recording?
   *
   * Two signals, either of which is enough: the board says a handoff exists but
   * is not complete, or the working tree moved. Neither is a guess about intent —
   * both are things on disk that were not there when the phase started.
   */
  private async producedWork(phase: number, boardState: string): Promise<{ did: boolean; why: string }> {
    const state = this.state!;

    // `in-progress` and `stuck` both mean a handoff file is there, saying
    // something other than complete.
    if (boardState === 'in-progress' || boardState === 'stuck') {
      return { did: true, why: `a handoff exists for phase ${phase} but reads "${boardState}"` };
    }

    // The tree's answer, asked per directory in the phase's SCOPE and with
    // submodule pointers ignored (`situation.ts` `workEvidence`). The root's
    // own `git status` was a false witness on a docs hub: permanently dirty
    // with submodule pointers, its log full of other phases' handoff commits
    // — a never-started phase read as "uncommitted changes" and bought a
    // $3.32 closeout for work that did not exist (measured, P12).
    const record = phaseRecord(state, phase);
    const work = await workEvidence(
      (args) => this.gitOrNull(args), record.startedAt ?? null, await this.scopeDirs(phase));
    if (work.did === true) return { did: true, why: work.why };
    if (work.did === false) return { did: false, why: `the session changed nothing on disk (${work.why})` };
    // Unreadable is not "nothing": but a closeout only runs on POSITIVE
    // evidence — a session resumed to record work that may not exist is the
    // loop this guard was written against. The ladder reads the same fact as
    // `work-in-progress` / `done-unrecorded` and decides with more context.
    return { did: false, why: work.why };
  }

}

/**
 * A verification summary with what it compared against: the stamps on the
 * record, and the repository each command ran in on every command. A COPY —
 * the summary the verifier returned is never mutated.
 */
function withStamps(verification: VerifySummary, stamps: readonly TreeStamp[]): VerifySummary {
  if (!stamps.length) return verification;
  const at = stamps.find((stamp) => stamp.role === 'verify-in');
  return {
    ...verification,
    trees: [...stamps],
    ran: verification.ran.map((run) => (at ? { ...run, tree: { repo: at.repo, branch: at.branch, head: at.head } } : { ...run })),
  };
}

/**
 * Which cap a session spent, from how the CLI said it ended — `turns` for
 * `error_max_turns` (or a `max_turns` terminal reason), `budget` for
 * `error_max_budget_usd`, else null. The structured fields `classify()` reads
 * for the same verdict, never the prose (control-tower phase 46, #61).
 */
function spentCapOf(ending: { subtype?: string; terminalReason?: string }): 'turns' | 'budget' | null {
  if (ending.subtype === 'error_max_budget_usd') return 'budget';
  if (ending.subtype === 'error_max_turns' || ending.terminalReason === 'max_turns') return 'turns';
  return null;
}
