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
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition, lostResume,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import { CASCADE_SKIP_REASON, STOPPED_SKIP_REASON, extractCommands, resolveLead, verifyPhase } from './verify.ts';
import { qaVerdictInstruction } from '../qa-session.ts';
import type { QueueKind } from '../../shared/run-lifecycle.js';
import { nextQaRound, qaReportPath, parseQaHistory } from '../qa-round.ts';
import {
  DEFAULT_QA_ROUND_BUDGET_USD, qaExhaustedErrand, qaFixInstruction, readQaFindings, releasesGate,
  roundBudgetUsd, type QaFixStrategy, type QaRecoverVerb,
} from './qa-recover.ts';
import { policyForKey } from './policy.ts';
import { capsFor, raiseCap, sizeTurns, sizeUsd, type Cap } from './session-record.ts';
import {
  evaluateWait, openWaitEntry, parkedMsOf, WAIT_FLOOR_MS, type WaitAuthor, type WaitBudget,
} from './wait-budget.ts';
import { pollableRefs, unpollableRefs } from '../watch-refs.ts';
import { RESUME_REFUSED_RECHECK_MS, declaredClock, ordinalSuffix, type DeclaredClock } from './wait-budget.ts';
import { closeoutSkipNote, reboardResumeBrief, resumePolicyInstruction, resumePolicyWhy, type VettedResume } from './runner-core.ts';
import type { ResumePolicy } from './usage.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds, mintWatchRef,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  blockerSubKind, classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, settleRung, DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord } from './state.ts';
import {
  childrenOf, consumeDeclaration, DECLARATION_CONSUMED_EVENT, endLockWait,
  loadRun, newRun, phaseRecord, procIdentity, saveRun, pidAlive, processState, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type QaRoundRecord, type RunStatus, type VerifySummary, clearWatchBookkeeping, isSessionGone,
  syncWaitClock, chargeDeclaration, DECLARATION_REFUSED_EVENT, type DeclarationCharge, prepareReboard,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome, needsOf } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
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
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TAIL_CHARS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import type { Runner } from './runner.ts';
import { RunnerLoop } from './runner-loop.ts';
import { allLeadsMissingPark, approvalsForPhase, reviewPhase } from './verify-review.ts';
import type { VerifyApprovals } from './verify.ts';
import { withSpan } from '../trace.ts';


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
    chosen: PhaseOptions = {}, opts: { maxTurns?: Cap; mcp?: McpResolution } = {},
  ): Promise<{ carryOn: boolean; completed: boolean }> {
    const before = await this.artefactScan(phase);
    try {
      // The phase's own span, inside the run's. Everything below it — the
      // session spawned, the git it runs, the bash scripts that session calls —
      // inherits the phase number and the attempt, so a line found on its own
      // says which retry of which phase produced it. The attempt is stated
      // here and nowhere else: a retry is a new attempt inside one run, and
      // that distinction is exactly what a reader of a failed phase needs.
      return await withSpan(
        'phase.attempt',
        { phase, attempt: (this.state?.phases?.[phase]?.attempts ?? 0) + 1 },
        () => this.attemptSession(phase, prompt, model, owner, lane, chosen, opts),
      );
    } finally {
      await this.noteArtefacts(before, phase);
    }
  }

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
  ): { carryOn: boolean; completed: boolean } {
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

  private async attemptSession(
    phase: number, prompt: string, model: string, owner: string, lane: Lane,
    chosen: PhaseOptions = {}, opts: { maxTurns?: Cap; mcp?: McpResolution } = {},
  ): Promise<{ carryOn: boolean; completed: boolean }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    let currentModel = model;
    // A freeze that was checkpointed left a session behind. Picking it up costs
    // one flag here and saves however long the phase had already been working;
    // cleared immediately, because offering the same id to a second attempt is
    // the "Session ID … is already in use" refusal.
    let resume: VettedResume | undefined;
    const asked = record.resumeSessionId;
    if (asked) {
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
      else if (gate.why === 'fresh' && gate.policy) return this.reboardNotWorth(phase, record, gate.policy, asked);
    }
    // The two caps this phase's sessions run under, each with the policy that
    // set it (SES-8): the run's own budget or the plan's size for the dollars,
    // the size for the turns — or, for a wait-resume and a closeout brief, the
    // closeout's turn cap the boarding chose. A cap the CLI reports spent is
    // doubled below for the resume that carries on.
    let caps = capsFor({
      mode: 'phase', size: await this.sizeOf(phase), phaseBudgetUsd: state.phaseBudgetUsd,
      ...(opts.maxTurns ? { turns: opts.maxTurns } : {}),
    });
    // The per-model walls this phase met, first first: when the whole chain
    // is limited, the FIRST model's reset is the one worth waiting for. Once
    // per phase — a second exhaustion after that wait halts as it always did.
    const modelWalls: { model: string; at: Date }[] = [];
    let modelWindowWaited = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A per-lane stop can land between attempts — during a retry backoff, a
      // usage-window sleep, or before the first spawn. Consume it here or the
      // next iteration starts a session for a phase the operator already ended.
      if (lane.stopped) return this.settleStoppedLane(lane, phase, 'spawn');
      record.attempts++;
      const scope = lane.grant?.scope ?? await this.scopeFor(phase);
      // The claim this session makes about where its work rides — both
      // dimensions, or neither when the scope lives outside the run root
      // (`RunnerBase.qualificationFor`); the same answer admission weighed.
      const claim = this.qualificationFor(phase, scope);
      const outcome = await this.spawnSession(phase, 'phase', {
        prompt,
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
        fallbackModels: fallbackChain(currentModel),
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
        onHandle: (handle) => { lane.handle = handle; this.syncMirror(); },
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
          // knows the process is new. `syncMirror` carries it forward.
          lane.procStartedAt = new Date().toISOString();
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
      }, { caps, attempt });
      // When this attempt's session ended — its own field. `endedAt` also meant
      // "the park began" and "a session ran", and parked time was measured from
      // whichever of the three wrote it last (WAI-4).
      record.attemptEndedAt = new Date().toISOString();

      lane.pid = null;
      lane.handle = null;
      this.syncMirror();
      state.spentUsd += outcome.costUsd;
      record.costUsd += outcome.costUsd;
      // See the other attempt-end sites: the rung is charged what its own
      // attempt spent, and settled later by whoever learns how it ended.
      chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
      record.turns = (record.turns ?? 0) + outcome.turns;
      // Wall-clock minus whatever the operator held it for. A phase frozen over
      // lunch did not take an extra hour to think. Read off THIS lane: with
      // several running, `state.freeze` may be describing a different phase,
      // and subtracting its held time here would credit one phase with a pause
      // that happened to another.
      const frozenNow = lane.frozen ? Math.max(0, this.now().getTime() - Date.parse(lane.frozen.at)) : 0;
      if (frozenNow) record.frozenMs = (record.frozenMs ?? 0) + frozenNow;
      record.durationMs = (record.durationMs ?? 0) + Math.max(0, outcome.durationMs - frozenNow);
      if (outcome.sessionId) record.sessionId = outcome.sessionId;
      // Kept on the record, not only in the journal. When a phase exits clean
      // and changes nothing this is the only account of why, and the halt that
      // reports it needs to be able to quote it without re-reading NDJSON.
      record.said = outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200);
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
        state.status = state.halt ? 'halted' : 'paused';
        return { carryOn: false, completed: false };
      }

      const disposition = classify(outcome.signal, this.now());
      this.record('phase.disposition', { attempt, kind: disposition.kind, reason: reasonOf(disposition) }, phase);
      this.emit('phase', { phase, disposition: disposition.kind, reason: reasonOf(disposition) });

      switch (disposition.kind) {
        case 'ok':
          return { carryOn: true, completed: true };

        case 'retry':
          if (attempt === MAX_ATTEMPTS) break;
          await this.sleep(disposition.afterMs);
          // Same stand-down as the usage-window wake: a halt from another lane
          // during the backoff means no attempt N+1.
          if (state.halt) {
            record.status = 'interrupted';
            record.note = 'the run halted while this phase waited to retry';
            return { carryOn: false, completed: false };
          }
          continue;

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
          if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
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
          // one helper, shared with the walls below.
          if (await this.waitOutWindow(phase, record, disposition.at, disposition.reason) === 'continue') continue;
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
            if (wantSwitch && this.trySwitchAccount(phase, record, disposition.reason, currentModel)) {
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
              const verdict = await this.waitOutWindow(phase, record, disposition.at, disposition.reason, { errand });
              if (verdict === 'continue') continue;
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
          //   3. the streak is charged — a wall that stops the run is a failed
          //      attempt, and the counter is the run's only "this plan is
          //      broken" bound;
          //   4. the RUN halts (`credential-refused` is run-level), with the one
          //      errand on it: nothing downstream can spend under a credential
          //      the API refuses, and the errand — not the halt card — is what
          //      reaches a person who is not looking.
          // A credential complaint names WHOSE credential: the classifier is
          // deliberately account-blind, and "sign that account in again" is
          // only actionable when the reason says which one.
          const paying = state.accountId ?? 'the machine login';
          const reason = `${disposition.reason} (account: ${paying})`;
          const at = this.now().toISOString();
          this.leaveAccount(phase, {
            kind: 'credential', reason: disposition.reason, by: 'classifier', class: disposition.class,
          });
          record.status = 'parked';
          record.note = reason;
          record.cause = {
            kind: 'credential-refused', class: disposition.class, reason: disposition.reason, at,
            ...(state.accountId ? { account: state.accountId } : {}),
          };
          state.consecutiveFailures++;
          // The wall's errand: the situation's fixed sentences, with the
          // account, the class and the session's own last words on it — the
          // words ARE the evidence for a policy refusal (RCV-7).
          const base = errandFor('resource-wall:auth', [], phase, at, record.said ?? null);
          const errand: Errand = {
            ...base,
            need: `A Claude account this run may spend under — the API refused ${paying}'s credential `
              + `(${disposition.class}): ${disposition.reason}.`,
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
          this.halt(reason, phase, 'credential-refused');
          return { carryOn: false, completed: false };
        }

        case 'phase-failed':
          record.note = disposition.reason;
          if (attempt < MAX_ATTEMPTS) { await this.sleep(15_000); continue; }
          break;
      }
      break;
    }

    record.status = 'failed';
    record.endedAt = new Date().toISOString();
    state.consecutiveFailures++;
    this.record('phase.failed', { attempts: record.attempts, note: record.note }, phase);
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      this.halt(`${state.consecutiveFailures} phases failed in a row`, phase, 'failure-streak');
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
  private async confirm(phase: number): Promise<boolean> {
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

    /* 1. the plan's own verification commands */
    const text = await this.deps.verificationText(state.slug, phase);
    // Read beside the verification text and handed straight through: the
    // preamble is the phase's, not the run's, and `verifyPhase` owns the rule
    // that it can never colour the verdict.
    const setupText = await this.deps.setupText?.(state.slug, phase);
    const verify = this.deps.verify ?? verifyPhase;
    const cwd = await this.verifyCwd(phase);
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
    const verification = waived ? {
      ok: true, ran: [], notRun: [],
      reason: 'the plan states no verification for this phase — passed on the handoff (allowUnverifiedPhases)',
    } : allWaived ? {
      ok: true, ran: [], notRun: [], waived: setAside!.waived,
      reason: 'every check in this phase\'s §Verification was waived at the run\'s start — passed on the handoff',
    } : await verify(text, {
      cwd,
      ...(setupText ? { setupText } : {}),
      ...(approvals ? { approvals } : {}),
      preflightSkip: this.verifyEnv().preflightSkip,
      // Explicit, and longer than the 15-minute default: a real phase's
      // verification is a full suite, sometimes a container build, and the
      // default turned a slow-but-passing check into a red one that proved
      // nothing. Still bounded — a wedged command must end.
      timeoutMs: VERIFY_TIMEOUT_MS,
      signal: this.abort?.signal ?? undefined,
      onStart: (command, index, total) => {
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
    record.verification = verification;
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
      ran: verification.ran.map((r) => ({ command: r.command, code: r.code, ms: r.ms })),
      notRun: verification.notRun,
      ...(verification.skipped?.length ? { skipped: verification.skipped } : {}),
    }, phase);

    // The console is stopping: whatever the summary claims, nothing more can
    // be proven or settled in this pass. The record keeps its in-flight
    // status — teardown writes `interrupted`, and reconcile owns it from
    // there — because a shutdown once produced `ok: true "0 commands green"`
    // over three commands that never ran, and the phase settled done on it.
    if (this.abort?.signal.aborted || this.stopRequested) {
      this.record('phase.verify-stopped', { ran: verification.ran.length, notRun: verification.notRun.length }, phase);
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
    const broke = verification.ran.filter((r) => !r.ok);
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
    const overtaken = !verification.ok && await this.boardOvertookVerification(phase);
    if (broke.length && !overtaken) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(
        `phase ${phase} did not verify: ${broke.length} of ${verification.ran.length} command(s) failed `
        + `— ${broke.map((r) => r.command).join(', ')}`
        + await this.verifyHint(phase),
        phase,
        'verify-failed',
      );
      return false;
    }

    /* 2. the plan still lints */
    const lint = readLint(await this.script('validate.sh', [state.slug]));
    record.lint = { ok: lint.ok, summary: lint.summary };
    if (!lint.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
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
    if (askable.length && ((!verification.ok && !vouched) || state.autonomy === 'halt-on-everything')) {
      if (!await this.askHuman(phase, verification, askable)) return false;
    } else if (!overtaken && !verification.ok) {
      record.status = 'failed';
      state.consecutiveFailures++;
      this.halt(`phase ${phase} did not verify: ${verification.reason}`, phase, 'verify-failed');
      return false;
    }

    record.status = 'done';
    record.endedAt = new Date().toISOString();
    this.lastDonePhase = phase;
    // The honest verdict travels with the record: a phase that passed with
    // checks skipped is not the same fact as one whose every check ran.
    if (verification.skipped?.length) {
      record.note = `verified with ${verification.skipped.length} check(s) skipped — unrunnable `
        + `on this machine (${[...new Set(verification.skipped.map((s) => s.lead))].join(', ')})`;
    }
    if (overtaken) {
      // The Repos-column hint used to ride the verify-failed halt; with the
      // board's word standing there is no halt to carry it, and losing it
      // would cost exactly the plan edit it exists to prompt. It travels on
      // the record instead, next to the verdict it qualifies.
      record.note = `§Verification is red (${verification.reason}) but the handoff already reads `
        + "complete — the board's word stands; the red verdict travels on this record"
        + await this.verifyHint(phase);
      this.record('phase.verify-overtaken', {
        by: 'the board',
        reason: verification.reason,
        ...(broke.length ? { failed: broke.map((r) => r.command) } : {}),
      }, phase);
    }
    state.consecutiveFailures = 0;
    // Not a flat `null`: with another lane still running, clearing the pointer
    // here would tell the console the run was between phases while a session
    // was mid-edit. `syncMirror` moves it to whatever is still live, and only
    // clears it when nothing is.
    if (this.lanes.size > 1) this.syncMirror();
    else state.activePhase = null;
    this.record('phase.done', {
      costUsd: record.costUsd, attempts: record.attempts,
      ...(verification.skipped?.length ? { skippedChecks: verification.skipped.length } : {}),
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
      try { boot = (await this.engine(['--boot-prompt', String(phase)])).stdout; } catch { boot = ''; }
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
      mode: 'qa', size: await this.sizeOf(phase), phaseBudgetUsd: state.phaseBudgetUsd,
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

    // The same three lines every extra session uses, so this money shows up in
    // the cost panels without those panels knowing this feature exists.
    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
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
        ? { costUsd: outcome.costUsd, turns: outcome.turns }
        : {}),
      at,
    })));

    const landedRound = landed[landed.length - 1]?.round ?? round;
    const landedReport = landed[landed.length - 1]?.reportPath ?? report;
    this.record('phase.qa-session-done', {
      costUsd: outcome.costUsd, turns: outcome.turns, verdict: after || 'pending',
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
      costUsd: outcome.costUsd,
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
        const roundSize = await this.sizeOf(phase);
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
            : sizeUsd(roundSize),
          // A fix may legitimately have to run a suite, so it gets a phase's
          // turn allowance rather than a closeout's. A review-only round keeps
          // the closeout cap it has always had (the QA mode's own).
          ...(verb === 'qa-rerun' ? {} : { turns: sizeTurns(roundSize) }),
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
        state.status = 'parked';
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
          state.status = 'parked';
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
    const state = this.state!;
    // The LANE's root, so a worktree phase verifies the tree it just wrote. A
    // verification that ran in the shared checkout would grade the run branch
    // as it stood before this lane's commits — green for work it never saw.
    const root = resolve(this.laneRoot(phase));
    const declared = (await this.deps.verifyIn?.(state.slug, phase))?.trim();
    if (!declared) return root;

    const target = resolve(root, declared);
    const inside = target === root || target.startsWith(`${root}/`);
    if (!inside) {
      this.record('phase.verify-in-missing', {
        declared, reason: 'it resolves outside the repository root', usedRoot: true,
      }, phase);
      return root;
    }

    try {
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
    } catch {
      this.record('phase.verify-in-missing', {
        declared, reason: 'no such directory under the repository root', usedRoot: true,
      }, phase);
      return root;
    }
    return target;
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
    phase: number, declared: PhaseOutcome | null,
  ): Promise<'done' | 'waiting' | 'halted' | 'frozen'> {
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
      if (state.status === 'running') state.status = 'frozen';
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
    if (attempted && !(this.rechecking === phase && record.halt?.kind === 'no-handoff')) state.consecutiveFailures++;
    this.halt(
      (attempted
        ? `the session for phase ${phase} ended cleanly but the board still reads `
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
    // anything is spent — the only await on this path, so nothing it decides
    // below can be interleaved with another lane's writes.
    const budget = declared.status === 'waiting-external' ? await this.waitBudgetOf(phase) : undefined;
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
          at: new Date().toISOString(),
        };
        clearWatchBookkeeping(record);
        const clock = this.armDeclaredClock(phase, record, declared);
        const lockRef = declared.watch.find((ref) => ref.startsWith('lock:'));
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
          at: record.endedAt,
        };
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
        const declaredKey = `blocked-declared:${blockerSubKind(record.note, declared.watch)}`;
        slot.errand = {
          phase,
          situation: declaredKey,
          at: record.endedAt,
          tried: (slot.rungs ?? []).map((r) => `${r.rung}${r.outcome ? ` → ${r.outcome}` : ''}`),
          need: record.note,
          how: errandFor(declaredKey, [], phase, record.endedAt).how
            + (declared.watch.length ? ' The console is also watching its refs and resumes the session when they land.' : ''),
        };
        this.record('phase.errand', { ...slot.errand }, phase);
        this.emit('phase', { phase, status: 'parked', note: record.note, errand: slot.errand });
        // The approvals-timeout vocabulary: nothing is wrong with the work,
        // the question is open, and the phase retries the moment someone
        // answers. Not counted against the failure budget. The KIND is what
        // lets the classifier read this park for what it is even on a record
        // written before `declared` existed.
        this.park(`phase ${phase} needs a person: ${record.note}`, phase, 'needs-human');
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
   * A phase whose handoff (or declared outcome) says it is blocked. The
   * situation classifier reads the blocker STATEMENT — the Outstanding text,
   * the declared reason, the watch refs, the session's words — and the ladder
   * answers: `blocked-declared:lock` re-queues, `:credential`/`:gate` park
   * with an errand at once (no session spent), `:unknown` gets ONE bounded
   * unblock session, and a ladder with nothing left for this runner falls to
   * the old `phase-blocked` halt, which the service's healer can still act on
   * with a vehicle this loop does not have.
   */
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
    // Parked with an errand, or re-queued behind a lock: the run carries on.
    if (record.status === 'parked' || record.status === 'pending' || record.status === 'queued') return 'waiting';

    record.status = 'failed';
    record.note = declared?.reason ?? (record.said ? condenseSaid(record.said) : 'the handoff declares this phase blocked');
    record.endedAt = new Date().toISOString();
    // Paperwork, not an attempt: a recheck that re-reads the same blocked
    // handoff charges no failure (RCV-4); the first record of it still counts.
    if (!(this.rechecking === phase && record.halt?.kind === 'phase-blocked')) state.consecutiveFailures++;
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
   * Park a phase on an external clock. True when parked; false when the
   * allowance is spent and the park became an honest halt instead.
   *
   * Every park is answered by `evaluateWait` — the one expression, shared with
   * the resume — and says what it granted against what was asked. A declared
   * window past the budget is refused with the arithmetic in the halt, never
   * cut short in silence (WAI-1): the 48-hour soak that was quietly parked for
   * eight and then halted with 2 377 minutes still to run is now a halt at the
   * moment it is declared, naming the one line that would have allowed it.
   *
   * `by` is who parked it (SLF-9): the session, a hand session through the
   * inbox, or the console's own watchdog — whose parks spend a ledger of their
   * own and never the session's allowance (WAI-5). `budget` is the plan's word
   * for this phase (`waitBudgetOf`); a synchronous caller passes nothing and
   * gets what was already read.
   */
  protected parkWaiting(
    phase: number, declared: PhaseOutcome, opts: { by?: WaitAuthor; budget?: WaitBudget; minted?: string[] } = {},
  ): boolean {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const by: WaitAuthor = opts.by ?? 'session';
    const ledger = by === 'watchdog' ? 'watchdog' : 'session';
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
    const verdict = evaluateWait({
      now,
      requestedUntil: declared.resume_after ? Date.parse(declared.resume_after) : undefined,
      parkedMs: parkedMsOf(record, now),
      waits,
      budget: opts.budget ?? this.knownWaitBudget(phase),
      ledger,
      floorMs: this.deps.waitFloorMs ?? WAIT_FLOOR_MS,
      dates: pollableRefs(declared.watch).flatMap((target) => (target.kind === 'date' ? [[target.ref, target.at] as const] : [])),
    });
    if (verdict.verdict !== 'park') {
      record.status = 'failed';
      record.note = declared.reason;
      // The timeout supersedes the declaration: the halt below is the fact
      // now, and a stale `declared: waiting-external` would send the
      // classifier back to "it settles itself" about a wait that ran out.
      const timedOut = consumeDeclaration(record, 'new-outcome');
      if (timedOut) this.record(DECLARATION_CONSUMED_EVENT, { ...timedOut, next: 'waiting-external-timeout' }, phase);
      endLockWait(record);
      state.consecutiveFailures++;
      this.halt(
        `phase ${phase} cannot park on external work — ${verdict.reason}`
        + ` (${declared.reason ?? 'no reason recorded'}`
        + `${declared.watch.length ? `; watching ${declared.watch.join(', ')}` : ''})`,
        phase,
        'waiting-external-timeout',
      );
      return false;
    }
    const until = new Date(verdict.until).toISOString();
    const requested = verdict.requestedSource === 'declared' || verdict.extendedBy
      ? new Date(verdict.requested).toISOString()
      : undefined;
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
    record.declared = {
      status: 'waiting-external',
      ...(declared.reason ? { reason: declared.reason } : {}),
      ...(declared.watch.length ? { watch: declared.watch } : {}),
      by,
      ...(requested ? { requested } : {}),
      ...(minted?.length ? { minted } : {}),
      at,
    };
    clearWatchBookkeeping(record);
    if (ledger === 'watchdog') record.watchdogParks = waits + 1; else record.waits = waits + 1;
    // When the park began — on its own field, and in the history the budget is
    // summed from. `endedAt` is no longer rewritten: it meant three things.
    record.parkedFrom = at;
    openWaitEntry(record, { parkedFrom: at, parkedUntil: until, ...(requested ? { requested } : {}), by }, now);
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
  ): Promise<{ ran: boolean; frozen?: true; note?: string }> {
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
      return { ran: false, note: `${worked.why}, so there was nothing to close out` };
    }

    // The one gate, as every `--resume` takes it — this site never asked, so a
    // closeout could resume a session stamped gone or one still running.
    const gate = this.resumableSession(record, record.sessionId);
    if (!gate.ok) {
      return { ran: false, note: closeoutSkipNote(gate, record.sessionId) };
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
        caps: capsFor({ mode: 'closeout', size: await this.sizeOf(phase), phaseBudgetUsd: state.phaseBudgetUsd }),
      });
    } catch (error) {
      return { ran: false, note: `the closeout session could not be started: ${(error as Error)?.message ?? error}` };
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    // The same dollars, booked a second time against the ladder rung that
    // caused this attempt — a no-op unless the ladder is what reboarded it.
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
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
      ok: record.closeout.ok, costUsd: outcome.costUsd, turns: outcome.turns,
      said: closeoutSaid,
    }, phase);

    return { ran: true, note: 'the runner asked its session to finish the closeout' };
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
