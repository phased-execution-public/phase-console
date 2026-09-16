/**
 * `RunnerLoop` — link 3 of the `Runner` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Runner` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `runner.ts` holds the concrete class.
 */
import { doorActor } from '../actor.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { FOLLOW_UP_RUNG, reviewHoldNote } from '../review.ts';
import {
  DEFAULT_REVIEWER_POLICY, parseReviewerReport, reviewerLabel, reviewerPrompt,
  type ReviewerVerdictPolicy,
} from '../reviewer.ts';
import { credentialsDirective, mcpDirective, skillDirective, ultracodeDirective } from '../skills.ts';
import { policyForKey } from './policy.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import { capsFor, CLOSEOUT_MAX_TURNS as SESSION_CLOSEOUT_TURNS, type Cap } from './session-record.ts';
import { closeWaitEntry, evaluateWait, parkedMsOf } from './wait-budget.ts';
import {
  lastFinishedPhase, ultraReviewJob, ULTRAREVIEW_EVENTS,
} from './ultrareview.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './verify.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  acquireLane, checkAvailable, copyEnvFiles, discardFreshMounts, discardFreshTree,
  ensureIntegration, ensureDetachedIntegration, ensureMirror, landLane, holdsBranch, landIntegration, pruneRun, reclaimBranch, defaultBranchOf, sweepUnmanaged, deleteMergedBranches,
  checkedOutIn, commitOf, runBranches, holdsDetached, type Reclaim,
  pruneRunTree, resolveMounts, runSetup, scopeConfined, sweepStale, validateMirror,
  REFUSAL_REASON, UNUSABLE_TREE, heldElsewhere,
  type LandResult, type LaneNames, type MirrorMount, type WorktreeRefusal,
} from './worktree.ts';
import {
  classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord } from './state.ts';
import {
  childrenOf, latestEnding, loadRun, newRun, phaseRecord, procIdentity, retirePhaseHalt, saveRun, pidAlive, pidHoldsWork, processState, IN_FLIGHT, SETTLED,
  setPhaseState, consumeDeclaration, DECLARATION_CONSUMED_EVENT, endLockWait, isSessionGone,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords, consoleRunsDir, type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
  syncWaitClock,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, AdmissionCapped, autopilotOwner, type Scheduler, type ScopeGrant, type SessionPeerView,
} from './scheduler.ts';
import { formatScope } from '../../shared/scope.js';
import {
  ISOLATED, SETTLE_UNSUPPORTED_MULTI, settleOf, WORKTREE_DEFAULTS,
  reclaimModeOf, detachedRef,
} from '../../shared/worktree-model.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_BY_CAP, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, lockStatusHolder, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, mergeQueuePrompt, prBlockText, preflight, reasonOf, retryAddendumBlock, survivingChildren, ultracodeOn, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import type { Runner } from './runner.ts';
import { RunnerControl } from './runner-control.ts';

/** A wait-resume's turn cap: a continuation, capped like a closeout. */
const WAIT_RESUME_TURNS: Cap = { value: SESSION_CLOSEOUT_TURNS, source: 'closeout', basis: 'a wait-resume' };

/** A closeout brief's turn cap, as the brief composed it. */
const closeoutBriefTurns = (value: number): Cap => ({ value, source: 'closeout', basis: 'a closeout brief' });

/**
 * "Something asked this run to stop admitting" — as a function, and the
 * function is the load-bearing part.
 *
 * Both callers sit after an `await` and re-test a status the loop top has
 * already tested. TypeScript's flow analysis strips `pausing` and `halting`
 * from `state.status` at those two guards and never re-widens the property
 * across an `await`, so testing them inline is a TS2367 "no overlap" error
 * against a type that is simply wrong: `pause()` (runner-control.ts),
 * `halt()` (runner.ts) and `park()` (runner-control.ts — the approval-timeout
 * hook, from outside this loop while a lane is live) all write that field
 * during exactly those awaits. Passing the value through a parameter restores
 * its declared type, so the check stays the check it was and a misspelled
 * status word is still a compile error.
 *
 * `frozen` belongs here for the same reason and was missing: `freeze()` stops
 * the sessions that EXIST, and said nothing about the next one. A run frozen
 * while the loop sat in an await — or woken afterwards by a docs change — went
 * on to admit a fresh lane and spawn a fresh session underneath a run the
 * console, the card and the badge all called frozen. "Frozen" has to mean the
 * run admits nothing, or it means very little.
 */
function stopAdmitting(status: RunStatus): boolean {
  return status === 'pausing' || status === 'halting' || status === 'frozen';
}

/**
 * Why a boarding stopped, in the operator's words.
 *
 * One table for all three gates, because they had three copies of the same
 * ternary and only two of them read the verdict they were handed — the last
 * re-derived it from `state`, so a stop that arrived as an abort signal was
 * reported as "the run was stopped" while a freeze would have been reported the
 * same way, which is how a fourth reason had nowhere to appear.
 */
function notStartedReason(
  blocked: 'stopped' | 'halted' | 'pause' | 'frozen', when: string,
): string {
  switch (blocked) {
    case 'pause': return `a pause was armed ${when}`;
    case 'halted': return `the run halted ${when}`;
    case 'frozen': return `the run was frozen ${when}`;
    case 'stopped': return `the run was stopped ${when}`;
  }
}

export abstract class RunnerLoop extends RunnerControl {
  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  /**
   * Clear away a DEAD run's worktrees before this one asks for any.
   *
   * The boot sweep (`service-base.ts`) covers the console that comes back after
   * a crash; this covers the one that never went away — a run killed mid-phase
   * inside a console that kept running leaves the same wedged `integration/`,
   * and the next run of that plan would degrade to a shared checkout with
   * nothing but a `phase.worktree-failed` line to say why. Runs the sweep
   * against THIS plan only, and only for runs this console is not driving.
   *
   * Cheap enough to be unconditional: with no `worktrees/` directory it returns
   * before touching git at all, which is every run of every plan that never
   * opted in.
   */
  private async sweepStaleWorktrees(): Promise<void> {
    const state = this.state!;
    try {
      const result = await sweepStale(state.root, {
        homes: this.worktreeHomes().all,
        slug: state.slug,
        // This run and no other: a Runner drives one plan, so the only run of
        // it that is live by definition is this one — and its own trees are not
        // stale, they are about to be created.
        liveRunIds: [state.id],
        children: (runId) => childrenOf(
          loadRun(state.root, state.slug, runId) ?? ({ phases: {} } as RunState),
        ).map((child) => child.pid),
        probe: (pid) => pidHoldsWork(pid),
      });
      if (result.removed.length || result.kept.length) {
        this.record('run.worktrees-swept', {
          removed: result.removed.length, kept: result.kept, runs: result.runs,
        });
      }
      // The registrations the sweep above cannot see, because they were never
      // ours: a prunable one (whose directory is gone and which is still
      // holding a branch) is repaired, and a hand-made checkout on a `pe/*`
      // branch is REPORTED and never removed — it may hold work, and the
      // whole discipline of these sweeps is that a checkout holding work is
      // kept and named.
      // 🔴 EVERY plan's managed directory, not this one's. `managed` is what
      // "the console did not make this" is decided against, so passing one
      // plan's dir made every OTHER plan's lane read as hand-made — reported,
      // on every drive, for trees this console minted itself.
      // `consoleRunsDir` is the parent of all of them.
      const stray = await sweepUnmanaged(state.root, {
        managed: this.managedDirs(),
      });
      if (stray.pruned.length) {
        this.record('run.worktrees-pruned', { unmanaged: stray.pruned });
      }
      // Once per DECISION, not once per drive — the rule every other line in
      // this preamble follows. The set of hand-made trees does not change
      // between drives, and a line an operator learns to scroll past has
      // stopped working.
      const trees = stray.unmanaged.map((tree) => `${tree.dir} (${tree.branch})`);
      const mark = trees.sort().join('|');
      if (trees.length && this.unmanagedNoted !== mark) {
        this.unmanagedNoted = mark;
        this.record('run.worktrees-unmanaged', {
          trees,
          reason: 'a working tree this console did not make is holding a run branch — '
            + 'it is left exactly as it is; switch or remove it if the branch is wanted',
        });
      }
      // …and the branches of this plan's FINISHED runs, once their work is
      // provably on the trunk. Not the live run's own — see `pruneRunBranches`.
      await this.pruneRunBranches(state);
    } catch (error) {
      // A sweep that fails must never stop a run: the worst case is the state
      // the repository was already in.
      log.warn('run.worktree-sweep-failed', { slug: state.slug, error });
    }
  }

  /**
   * Give this RUN its own checkout, or leave it in the console's — and say
   * which, once, in the journal.
   *
   * The per-run counterpart of `acquireWorktree`, and it answers a different
   * question. A LANE exists so two phases of one plan do not fight over one
   * tree; a run CHECKOUT exists so two *runs* whose repository scopes overlap
   * can be admitted at the same time instead of queueing (phase 8 reads
   * `state.checkout` to decide that). Same machinery, same refusal vocabulary,
   * different unit.
   *
   * Every impossibility DEGRADES, none fails the run — a refused run works in
   * the shared checkout with queue semantics, which is exactly what every run
   * did before isolation existed. The one thing that must never happen is a
   * silent degrade: an operator who turned isolation on and got queueing anyway
   * with nothing saying why.
   *
   * The order is not arbitrary. The cheap questions come first, and the two
   * that CREATE something come last, so a refusal leaves nothing on disk:
   *
   *   1. `checkAvailable` — opted in, new-branch, a repo, no submodules.
   *   2. the cap — `worktreeMaxConcurrent` across this console's live isolated
   *      runs. A full checkout per run is the cost the cap exists to bound.
   *   3. scope confinement — every phase's Repos token inside the root, or the
   *      tree would not contain the work (`worktree.ts` §`scopeConfined`).
   *   4. `ensureIntegration` — the tree itself. Its "already checked out at …"
   *      refusal is this feature's `branch-in-use`.
   *   5. the operator's setup command, in a tree this call CREATED. On failure
   *      that fresh tree is discarded: a half-prepared checkout fails a session
   *      somewhere far from the cause.
   *   6. the `.env*` copy, which cannot fail the checkout at all.
   *
   * 🔴 IDEMPOTENT, never memoized, and the difference is a shipped defect.
   * This ran once per run id, because "the tree is a fact about this run,
   * decided once". It is not: `Service.runnerFor` pools ONE `Runner` per plan
   * for the console's lifetime, `drive()` is re-entered by every resume, and
   * the state it would have skipped re-deciding has moved underneath it —
   * a clean settle deleted `workRoot`, or an operator dropped isolation. The
   * memo made a resumed run keep spawning in a tree that no longer existed and
   * claim a carve-out it no longer had. So every step re-runs, and the two
   * that COST something guard themselves instead: `ensureIntegration` adopts a
   * registered tree without touching git, and the setup command runs only for
   * a tree this call minted (`created`).
   */
  private async ensureRunCheckout(): Promise<void> {
    // Before ANY decision about a tree: the previous drive of this plan may
    // still be sweeping the last one away. See `prunePending`.
    if (this.prunePending) { try { await this.prunePending; } catch { /* journalled by the sweep */ } }
    const state = this.state!;

    /**
     * The ONE way this preamble records a refusal.
     *
     * 🔴 One way, because the two times it had two, both defects were in the
     * copy. `ensureIntegration`'s failure branch used to set the three fields
     * inline "so it could report git's own words", and in doing so it omitted
     * `delete state.workRoot` — so a resume that met `branch-in-use` (its tree
     * removed by hand, its branch checked out elsewhere) read `refused` while
     * still pointing at the vanished directory, spawned its session into a cwd
     * that does not exist, and handed it `PE_BRANCH=pe/<slug>`: the carve-out
     * phase 8 admits on, claimed by a run that had just been refused. `reason`
     * is a parameter precisely so that branch has nothing left to justify a
     * second copy.
     */
    const refuse = (refusal: WorktreeRefusal, detail?: string): void => {
      // Gated on the DECISION, not the drive — the mirror of the success path's
      // `!already`, and the same reason. This preamble re-runs on every resume
      // by design, so a permanently-refused run (`scope-outside-root` is what
      // every hub-rooted plan gets, for ever) appended one more identical line
      // each time. That is not news, and a journal an operator learns to scroll
      // past is a journal that has stopped working.
      const changed = state.checkout !== 'refused' || state.isolationRefusal !== refusal;
      state.checkout = 'refused';
      state.isolationRefusal = refusal;
      // 🔴 …and the detached decision goes with the tree, for exactly the
      // reason `workRoot` does one line below. `branchFor` reads `detachAt`,
      // so a refused run that kept it wrote `PE_BRANCH=detached@<sha>` and a
      // lock qualified by a commit its session is not standing at — the
      // shared root is on a branch. Reachable precisely because a detached
      // run's `holding` probe is the one that had no answer at all.
      delete state.detachAt;
      // 🔴 CLEARED, not merely left unset. This is re-evaluated on every drive,
      // so it also runs on a RESUME — and a resume that dropped isolation, or
      // one that meets a refusal the first drive did not, would otherwise keep
      // the tree the first drive minted: `laneRoot` reads `workRoot` before
      // `root`, so the run would report `refused` in the operator's face while
      // every session carried on in the worktree.
      //
      // 🔴 And that is ALL it does. Round 5 made this release the tree too —
      // `pruneRunTree` — on the reasoning that forgetting a path is not giving
      // a resource back. The reasoning was right and the remedy was a
      // catastrophe: `pruneRunTree` calls `pruneRun` with NO phases, so the
      // lane loop that fills `kept` never runs, `kept` is empty however much
      // lane work is on disk, and the terminal `rm -rf <stateDir>/worktrees/
      // <runId>` took every lane checkout of the run with it — including one
      // the settle had deliberately KEPT because it was dirty. A refusal is not
      // allowed to delete a session's uncommitted work.
      //
      // Nothing needs releasing here any more, because nothing that HOLDS a
      // tree reaches this function: `ensureRunCheckout` exempts a run already
      // standing on its checkout from every refusal, which is the other remedy
      // round 5's report offered and the one that cannot lose work. The settle
      // still prunes the tree the ordinary way, with the run's real phases.
      delete state.workRoot;
      delete state.mountedRepos;

      if (!changed) return;
      this.record('run.isolation', {
        checkout: 'refused', refusal,
        reason: detail ?? REFUSAL_REASON[refusal],
        ...(detail ? { detail } : {}),
      });
    };

    const names = this.laneNamesFor(0);

    /**
     * Does this run ALREADY stand on its checkout?
     *
     * 🔴 Every refusal below is about TAKING a checkout, and none of them is a
     * question about a run that has already taken one. The preamble re-runs on
     * every drive by design, so without this a resume re-asked them all and a
     * later `yes` — the cap now full, a scope that moved, a plan that gained
     * submodules — took a tree away from a run that had been using it perfectly
     * well. Rounds 1-5 all fixed what that left BEHIND (a record pointing at a
     * vanished tree, then a tree nobody pointed at, then a release that deleted
     * lane work). This asks the question that stops it arising: the slot is
     * spent, so it is not re-competed for, and the refusal takes effect at the
     * NEXT run, where it costs nothing.
     *
     * All three clauses earn their place. `existsSync` because a registration
     * whose directory an operator deleted must fall through to
     * `ensureIntegration`'s rebuild, not be adopted; `holdsBranch` rather than
     * `isRegistered` because a tree switched to another branch is not this
     * run's checkout however registered it is, and adopting it would hand a
     * session `PE_BRANCH=pe/<slug>` for a tree standing elsewhere.
     */
    // Mirror-aware: a mirror is N checkouts, so the question `holdsBranch`
    // answers for a single tree is asked of every mount the manifest names.
    // A mirror whose state file lost `mountedRepos` fails the single-tree
    // probe (the integration dir is not a worktree of the root), falls
    // through to the build, and is re-adopted mount by mount — self-healing.
    // 🔴 …and DETACHED-aware, which the first cut was not. `holdsBranch` can
    // never be true of a tree that owns no branch, so a detached run concluded
    // on EVERY drive that it held nothing, fell through to the build, and met
    // a rebuild path that force-removed the tree the moment the trunk moved.
    // The mirror half was already safe because `validateMirror` learned
    // `manifest.detached`; the single-tree probe had no equivalent until now.
    let holding = state.checkout === 'worktree'
      && Boolean(state.workRoot)
      && existsSync(names.integration)
      && (state.mountedRepos?.length
        ? await validateMirror(names.integration, names.runBranch)
        : state.detachAt
          ? await holdsDetached(state.root, names.integration)
          : await holdsBranch(state.root, names.integration, names.runBranch));

    /**
     * Give the tree back, for the paths that MUST degrade.
     *
     * 🔴 The invariant this preamble owes: a run is never degraded to the
     * shared root while a console-managed tree still holds `pe/<slug>`. Two
     * ways to honour it — don't degrade, or free the branch — and which one
     * applies is not a matter of taste. A refusal about POLICY (the cap, a
     * scope that moved) can simply not apply to a run that already has its
     * tree. A refusal that says the tree itself is UNUSABLE — the repository
     * gained submodules, so the worktree's submodule directories are empty —
     * cannot be waved away, and neither can the operator deliberately turning
     * isolation off. Those degrade, and so they must release.
     *
     * When the tree cannot go — it is dirty, or a lane still has to land in it
     * — it is KEPT, because uncommitted work outranks a tidy branch. Nothing is
     * recorded about that here: the boot prompt asks git who holds the branch
     * at the moment it is written (`heldElsewhere`), which is the only form of
     * the answer that is right for a NEW run meeting this tree, and still right
     * after an operator removes it.
     */
    const release = async (why: string): Promise<void> => {
      try {
        const { removed, kept } = await pruneRunTree(state.root, {
          home: this.worktreeHomes().active, runId: state.id, slug: state.slug,
        });
        if (removed.length || kept.length) {
          this.record('run.worktree-released', { why, removed, kept });
        }
      } catch (error) {
        // Never fails the run: the worst case is the state it was already in.
        log.warn('run.worktree-release-failed', { slug: state.slug, error });
      }
    };

    /** Keep the checkout this run already has, and say so at most once. */
    const keep = (overridden?: WorktreeRefusal): void => {
      state.workRoot = names.integration;
      state.checkout = 'worktree';
      delete state.isolationRefusal;
      if (!overridden) return;
      // Gated per run+reason, like every other line this preamble writes: a
      // permanently-out-of-scope run drives more than once, and a journal an
      // operator learns to scroll past has stopped working.
      const mark = `${state.id}:${overridden}`;
      if (this.keptRefusalFor === mark) return;
      this.keptRefusalFor = mark;
      this.record('run.isolation-kept', {
        checkout: 'worktree', refusal: overridden, dir: names.integration,
        reason: `${REFUSAL_REASON[overridden]} — but this run already has its checkout, `
          + 'so it keeps it; the refusal applies to the next run',
      });
    };

    // `checkAvailable` speaks the plan-directive dialect (`'on' | 'off'`); the
    // run's own request is translated into it rather than the check being
    // forked, so "this repository has submodules" has exactly one spelling.
    const refusal = await checkAvailable({
      root: state.root,
      gitMode: state.gitMode,
      directive: state.isolation === ISOLATED ? 'on' : 'off',
    });
    if (refusal === 'not-opted-in') {
      // The default, true of essentially every run. Not a refusal and not
      // journalled: nobody asked for anything.
      //
      // `workRoot` goes for the same reason it goes on a refusal, and this is
      // the path a mid-run DROP arrives on: isolation is one-way DOWN
      // (`RunSettingsPatch.isolation`), so the resume that turned it off lands
      // here, and leaving the field would move nothing at all — the run would
      // read `shared` and keep spawning in the tree.
      //
      // 🔴 And the TREE goes with the pointer. A drop after a dirty settle used
      // to leave the console's own worktree standing on `pe/<slug>` while the
      // run degraded to the shared root — where the boot prompt tells the
      // session to check `pe/<slug>` out, and git answers `fatal: … is already
      // used by worktree at …`. The exemption above makes this the ONLY way to
      // degrade a run that holds a tree, so it is the one path that must get
      // the release right.
      if (holding) await release('isolation was turned off');
      state.checkout = 'shared';
      delete state.workRoot;
      delete state.mountedRepos;
      delete state.isolationRefusal;
      // …and the detach decision goes with the shape, exactly as in `refuse()`:
      // this is the SECOND door out of the worktree checkout, and a dropped run
      // that kept `detachAt` wrote `PE_BRANCH=detached@<sha>` for a session
      // working in the shared root — a commit it is not standing at.
      delete state.detachAt;
      return;
    }
    const mirrorable = refusal === 'has-submodules';
    if (refusal && !mirrorable) {
      // A tree that is unusable, or a run that never had a branch to stand on,
      // is not a policy question — see `release`.
      if (holding && !UNUSABLE_TREE.has(refusal)) return keep(refusal);
      if (holding) await release(`the checkout became unusable: ${refusal}`);
      return refuse(refusal);
    }
    if (mirrorable && holding && !state.mountedRepos?.length) {
      // The repository gained submodules under a run holding a ROOT worktree.
      // That tree's submodule directories are empty — the unusable shape — so
      // it is released exactly as before, and the run takes a MIRROR below.
      await release('the checkout became unusable: has-submodules');
      holding = false;
    }

    const prefs = this.deps.worktreePrefs?.() ?? {};
    const cap = prefs.maxConcurrent ?? WORKTREE_DEFAULTS.worktreeMaxConcurrent;
    // Asked of the console, not counted here: this Runner drives one plan and
    // the cap is about the machine's disk. Absent — a harness with no service
    // behind it — means nothing else holds one, which is true of a harness.
    const capped = (this.deps.isolatedCheckouts?.(state.id) ?? 0) >= cap;
    // 🔴 Asked HERE rather than inside `buildRunCheckout`, where it lived, for
    // two reasons. A run that already holds its checkout never reaches the
    // build half at all, so a scope that moved would have overridden a refusal
    // the operator was never told about — silent, which is the one thing this
    // preamble may not be. And it shortens the reserved window below: the check
    // stats the disk, and it creates nothing that a cap slot needs holding for.
    // The documented order is unchanged for a run that is taking a tree:
    // available → cap → scope → create.
    const outOfScope = !scopeConfined(state.root, this.deps.planScope?.(state.slug) ?? []);
    // For a superproject, WHICH repositories the scope lives in — resolved even
    // for a holding run, because a scope that moved to the root (or grew a
    // mount) is news the keep-with-override path has to be able to tell.
    let mounts: MirrorMount[] = [];
    let mountsSkipped: string[] = [];
    let mountRefusal: { refusal: WorktreeRefusal; detail: string } | null = null;
    if (mirrorable && !outOfScope) {
      const resolved = await resolveMounts(state.root, this.deps.planScope?.(state.slug) ?? []);
      if (resolved.ok) {
        mounts = resolved.mounts;
        mountsSkipped = resolved.skipped;
      } else {
        mountRefusal = resolved;
      }
    }
    if (holding) {
      const grows = mirrorable && mounts.length
        ? mounts.some((mount) => !(state.mountedRepos ?? []).includes(mount.rel))
        : false;
      if (capped || outOfScope || mountRefusal || !grows) {
        return keep(capped ? 'cap-reached'
          : outOfScope ? 'scope-outside-root'
            : mountRefusal ? mountRefusal.refusal : undefined);
      }
      // The scope grew: fall through to the build, which adopts every mount
      // that stands and mounts what the plan now names.
    }
    if (capped) return refuse('cap-reached');
    if (outOfScope) return refuse('scope-outside-root');
    if (mountRefusal) return refuse(mountRefusal.refusal, mountRefusal.detail);
    // The repositories this run's checkout will be built out of — one for a
    // single tree, one per mount for a mirror. Both halves below need exactly
    // this list: the reclaim may move only trees of these repositories, and the
    // detached shape resolves each one's own trunk.
    const repos = mirrorable && mounts.length
      ? mounts.map((mount) => ({ rel: mount.rel, source: mount.source }))
      : [{ rel: '', source: state.root }];

    // 🔴 BEFORE anything tries to take the branch, and after every refusal
    // above has had its say. A checkout sitting on `pe/<slug>` is what
    // `ensureIntegration` refuses `branch-in-use` for — and the checkout
    // sitting on it is, overwhelmingly, the operator's own root, because the
    // new-branch strategy told the last session to check it out there. A tree
    // with nothing in it to lose can simply be moved aside; a tree holding
    // work is not touched and its paths ride the refusal.
    const dirty = await this.reclaimRunBranch(state, names.runBranch, repos);

    // …and only now can the run know whether it needs the DETACHED shape: the
    // reclaim may just have freed the branch, so asking before it would detach
    // a run that could perfectly well have stood on its own ref.
    await this.decideDetach(state, names.runBranch);

    // 🔴 RESERVED from here, released in the `finally`. Everything past this
    // point AWAITS — a scope check that stats the disk, `git worktree add`, a
    // setup command that may run for ten minutes — while the count above reads
    // `checkout: 'worktree'`, which is not written until the very end. Two runs
    // starting together therefore both saw the pre-count and both passed a cap
    // of one. The reservation is what makes the check mean anything, and it has
    // to be visible to the SERVICE, which is the only thing that can see both.
    this.reservingCheckout = true;
    try {
      if (mirrorable) {
        await this.buildRunMirror(state, names, prefs, refuse, mounts, mountsSkipped, dirty);
      } else {
        await this.buildRunCheckout(state, names, prefs, refuse, dirty);
      }
    } finally {
      this.reservingCheckout = false;
    }
  }

  /**
   * Take the run branch back from a CLEAN checkout that is sitting on it.
   *
   * The wedge this ends is one the console itself creates: the new-branch
   * strategy tells every session to check `pe/<slug>` out, so the operator's
   * own root ends up standing on it — and from then on every run of that plan
   * meets `branch-in-use` and silently degrades to sharing that very checkout,
   * for ever, because nothing ever switches it back.
   *
   * 🔴 Every precondition lives in `reclaimBranch`, not here, and that is
   * deliberate: `previewIsolation` asks the same function with `dryRun` so the
   * preflight and the decide cannot answer differently — the exact dishonesty
   * ("mirror, three mounts" against a decide that always refused) the
   * preflight was built to end.
   *
   * Returns the sentence a refusal should carry when a tree holds work — the
   * `branch-in-use` detail then names the paths, which is the one fact that
   * makes the situation fixable — or null when nothing is in the way.
   */
  private async reclaimRunBranch(
    state: RunState,
    runBranch: string,
    repos: { rel: string; source: string }[],
  ): Promise<string | null> {
    if (reclaimModeOf(this.deps.worktreePrefs?.().reclaim) === 'never') return null;
    // Precondition 4: the live claims on this plan's scope, from the Service's
    // lock files — the same list `previewIsolation` is handed, so the preflight
    // cannot promise a reclaim this decide would refuse. The whole plan's scope
    // (the union `scopeConfined` was just asked about), never one phase's: the
    // preamble decides one tree for every phase of the drive. This run's OWN
    // claims are dropped — its lock is never a reason to refuse it a checkout.
    const own = autopilotOwner(state.id);
    const occupied = (this.deps.occupiedTrees?.(this.deps.planScope?.(state.slug) ?? ['all']) ?? [])
      .filter((claim) => claim.owner !== own);
    for (const repo of repos) {
      const held = await checkedOutIn(repo.source, runBranch);
      if (!held) continue;
      let result: Reclaim;
      try {
        result = await reclaimBranch({
          root: repo.source, held, branch: runBranch, allowed: [repo.source], occupied,
        });
      } catch (error) {
        // Never fails the run: without the reclaim the build simply refuses
        // `branch-in-use`, which is the state the repository was already in.
        log.warn('run.isolation-reclaim-failed', { slug: state.slug, held, error });
        continue;
      }
      if (result.kind === 'reclaimed') {
        this.record('run.isolation-reclaimed', {
          tree: result.tree, from: result.from, to: result.to,
          ...(repo.rel ? { repo: repo.rel } : {}),
        });
        continue;
      }
      if (result.kind === 'dirty') {
        return `${result.tree} holds uncommitted work (${result.paths.join(', ')})`;
      }
      // A LIVE session's tree, clean at this instant. The refusal names the
      // holder rather than the files, because "switch that checkout" is
      // advice about somebody else's terminal (QA round 1's F9).
      if (result.kind === 'held') {
        return `${result.tree} is held by a live session (${result.by})`;
      }
      // `foreign` and `skipped` are not news: the branch stays taken, the
      // build refuses `branch-in-use` naming the tree, and that sentence
      // already says everything an operator can act on.
    }
    return null;
  }

  /**
   * Decide whether this run's checkout must own no branch at all.
   *
   * Two ways in, and they answer the same question from opposite ends:
   *
   *  - the plan SAYS so (`- **Checkout:** main` on a phase of this run) — a
   *    plan that knows its work continues after the pull request merges;
   *  - the branch is GONE. A run whose `pe/<slug>` has been merged and deleted
   *    still has phases to drive, and the ordinary shape would cheerfully
   *    re-create the branch from HEAD — re-opening work the merge just closed
   *    and taking a ref the next run of the plan would then queue behind.
   *
   * A detached tree at the default branch's head is a real checkout of the
   * right code that claims no ref, so any number of them can stand beside each
   * other. `undefined` — the ordinary case — leaves every other decision in
   * this preamble exactly as it was.
   *
   * 🔴 Re-decided on every drive like the rest of the preamble, and CLEARED
   * when it no longer applies. A run that detached because its branch was gone
   * and then had the branch re-created (a person, a revert) must go back to
   * standing on it, or `branchFor` would keep qualifying its locks with a
   * commit nothing is at any more.
   */
  private async decideDetach(state: RunState, runBranch: string): Promise<void> {
    // 🔴 A missing ref is NOT on its own a reason to detach. A brand-new run's
    // `pe/<slug>` does not exist either — it is minted by `worktree add -b` a
    // moment later — so "the branch is gone" only means anything about a run
    // that has already had its branch settled. Without `settledAt` here every
    // first drive detached, which is the whole concurrency suite red.
    const gone = Boolean(state.settledAt)
      && !(await commitOf(state.root, `${runBranch}^{commit}`));
    const asked = state.gitMode === 'new-branch' && (this.planWantsDetach(state) || gone);
    if (!asked) { delete state.detachAt; return; }
    const trunk = await defaultBranchOf(state.root);
    const sha = trunk ? await commitOf(state.root, trunk) : '';
    // No trunk, or a repository that cannot resolve it: NOT detached. The
    // ordinary shape then runs and either finds the branch or mints it, which
    // is what this console has always done — a degrade, never a failure.
    if (!sha) { delete state.detachAt; return; }
    if (state.detachAt !== sha) {
      state.detachAt = sha;
      this.record('run.isolation-detached', { at: sha, branch: detachedRef(sha), trunk });
    }
  }

  /**
   * Does any phase this run may drive ask to leave the run branch?
   *
   * Scoped to `onlyPhases` for a scoped run, and to the whole plan otherwise —
   * asked of the PARSED PLAN, never of `state.phases`, which `phaseRecord`
   * fills lazily and which is therefore empty on the drive that matters most:
   * the first one, before anything has boarded.
   */
  private planWantsDetach(state: RunState): boolean {
    return Boolean(this.deps.detachRequested?.(
      state.slug,
      state.onlyPhases?.length ? state.onlyPhases : undefined,
    ));
  }

  /**
   * The half of the preamble that creates things, split out so the cap
   * reservation is released on exactly one path however this returns.
   */
  private async buildRunCheckout(
    state: RunState,
    names: LaneNames,
    prefs: { maxConcurrent?: number; setup?: string; copyEnv?: boolean },
    refuse: (refusal: WorktreeRefusal, detail?: string) => void,
    /** A tree the reclaim could not move, and why — see `reclaimRunBranch`. */
    dirty?: string | null,
  ): Promise<void> {
    const made = state.detachAt
      ? await ensureDetachedIntegration(state.root, names.integration, state.detachAt)
      : await ensureIntegration(state.root, names);
    if (!made.ok) {
      // `ensureIntegration` refuses for exactly one reason that is not a git
      // failure — the branch is checked out somewhere else — and it says so in
      // words. Anything else is git declining for a reason worth reporting
      // verbatim rather than folding into a category.
      //
      // Through `refuse()` like every other refusal. This branch used to write
      // the three fields by hand in order to carry git's own words, and forgot
      // the one line that matters (`delete state.workRoot`) — see `refuse`.
      const held = /already checked out at/.test(made.detail ?? '');
      // git's own words either way. Parameterising `refuse()` had dropped them
      // for `branch-in-use` — and the sentence that replaced them, the generic
      // constant, happens to CONTAIN "already checked out", so the test guarding
      // it stayed green while the one fact an operator needs (WHICH tree holds
      // the branch) vanished. With F5-1 that holder is often the console's own
      // orphan, so the path is the whole remedy.
      return refuse(
        held ? 'branch-in-use' : 'worktree-failed',
        // …and, when the reclaim met a tree it could not move, WHICH FILES
        // stopped it. "Switch that checkout to another branch" is advice an
        // operator cannot act on until they know why the console would not do
        // it for them, which it otherwise would have.
        `${made.detail ?? 'git worktree add failed'}${dirty ? ` — ${dirty}` : ''}`,
      );
    }

    // Only for a tree this call MINTED. An adopted one — a resume, a second
    // drive — was prepared when it was made, and re-running `npm ci` over a
    // checkout a session has been working in is somewhere between wasteful and
    // destructive.
    const setup = (prefs.setup ?? '').trim();
    if (setup && made.created) {
      const ran = await runSetup(names.integration, setup);
      this.record('run.worktree-setup', {
        dir: names.integration, command: setup, ok: ran.ok, output: ran.output,
      });
      if (!ran.ok) {
        // 🔴 `discardFreshTree`, NOT `pruneRunTree`, and the distinction was a
        // wedge. `pruneRunTree` refuses a DIRTY tree — rightly — and a setup
        // command that fails is exactly what leaves files behind, so the
        // refusal fired every time: the half-prepared tree stayed registered
        // holding `pe/<slug>`, `workRoot` was cleared so nothing pointed at it,
        // `sweepStale` kept it forever because it was dirty, and every LATER
        // run of the plan refused `branch-in-use`. Force-removing is safe here
        // and nowhere else: this call created the tree seconds ago and no
        // session has been near it.
        const gone = await discardFreshTree(state.root, names);
        if (!gone.removed) {
          log.warn('run.worktree-discard-failed', {
            slug: state.slug, dir: names.integration, detail: gone.detail,
          });
        }
        this.record('run.worktree-setup-discarded', {
          dir: names.integration, removed: gone.removed,
          ...(gone.detail ? { detail: gone.detail } : {}),
        });
        return refuse('setup-failed');
      }
    }

    // 🔴 Also only for a tree this call MINTED, and for a sharper reason than
    // the setup command's: `copyFile` OVERWRITES. This preamble re-runs on
    // every drive, so a resume re-copied the root's `.env` over one an operator
    // had edited inside the tree — silently, as the price of the idempotence
    // that fixed the resume in the first place. A seeding step seeds once.
    let envFiles: string[] = [];
    if (prefs.copyEnv && made.created) envFiles = await copyEnvFiles(state.root, names.integration);

    // Both, together, or neither — the rule `Lane.worktree`/`branch` follow: a
    // run that degraded must never claim a tree it does not have.
    const already = state.checkout === 'worktree' && state.workRoot === names.integration
      && !state.mountedRepos;
    state.workRoot = names.integration;
    state.checkout = 'worktree';
    // A repository that LOST its submodules takes a single tree again; a mount
    // list left over from its superproject days would misdescribe it.
    delete state.mountedRepos;
    delete state.isolationRefusal;
    // Once per DECISION, not once per drive. The preamble re-runs on every
    // resume by design, and journalling an unchanged answer each time turns
    // "this run got its checkout" into a line an operator learns to scroll
    // past. The plan asks for one line; a repeated one is not news.
    if (!already) {
      this.record('run.isolation', {
        checkout: 'worktree', mode: ISOLATED, dir: names.integration, branch: names.runBranch,
        ...(envFiles.length ? { envFiles } : {}),
      });
    }
  }

  /**
   * The mirror's spelling of `buildRunCheckout`: N mounts instead of one tree,
   * the same all-or-nothing discipline per step, the same one door out
   * (`refuse`). `ensureMirror` inherits every single-repo lesson per mount —
   * adoption, prunable registrations, `branch-in-use` by name — and the setup
   * command and `.env` copy run once per mount THIS call minted.
   */
  private async buildRunMirror(
    state: RunState,
    names: LaneNames,
    prefs: { maxConcurrent?: number; setup?: string; copyEnv?: boolean },
    refuse: (refusal: WorktreeRefusal, detail?: string) => void,
    mounts: MirrorMount[],
    skipped: string[],
    /** A tree the reclaim could not move, and why — see `reclaimRunBranch`. */
    dirty?: string | null,
  ): Promise<void> {
    const made = await ensureMirror({
      names, runId: state.id, slug: state.slug, mounts,
      // Per MOUNT, resolved inside `ensureMirror`: a mirror's repositories are
      // unrelated object databases, so each detaches at its OWN trunk's head
      // rather than at the sha the run-level decision happens to hold.
      ...(state.detachAt ? { detach: true } : {}),
    });
    if (!made.ok) {
      return refuse(
        made.refusal ?? 'worktree-failed',
        `${made.detail ?? 'git worktree add failed'}${dirty ? ` — ${dirty}` : ''}`,
      );
    }

    const setup = (prefs.setup ?? '').trim();
    if (setup && made.created.length) {
      for (const rel of made.created) {
        const dir = join(names.integration, rel);
        const ran = await runSetup(dir, setup);
        this.record('run.worktree-setup', { dir, command: setup, ok: ran.ok, output: ran.output });
        if (ran.ok) continue;
        // All-or-nothing, the single-repo rule applied per mount: a mirror
        // with one half-prepared mount boards a session into a tree that
        // fails far from the cause, so every mount this call minted goes.
        const fresh = mounts.filter((mount) => made.created.includes(mount.rel));
        const gone = await discardFreshMounts(names, fresh, { integration: !made.adopted.length });
        if (!gone.removed) {
          log.warn('run.worktree-discard-failed', {
            slug: state.slug, dir: names.integration, detail: gone.detail,
          });
        }
        this.record('run.worktree-setup-discarded', {
          dir, removed: gone.removed,
          ...(gone.detail ? { detail: gone.detail } : {}),
        });
        return refuse('setup-failed');
      }
    }

    const envFiles: string[] = [];
    if (prefs.copyEnv && made.created.length) {
      for (const rel of made.created) {
        const source = mounts.find((mount) => mount.rel === rel)?.source ?? join(state.root, rel);
        const copied = await copyEnvFiles(source, join(names.integration, rel));
        envFiles.push(...copied.map((name) => join(rel, name)));
      }
    }

    const rels = mounts.map((mount) => mount.rel);
    const already = state.checkout === 'worktree' && state.workRoot === names.integration
      && JSON.stringify(state.mountedRepos ?? []) === JSON.stringify(rels);
    state.workRoot = names.integration;
    state.checkout = 'worktree';
    state.mountedRepos = rels;
    delete state.isolationRefusal;
    if (!already) {
      this.record('run.isolation', {
        checkout: 'worktree', mode: ISOLATED, dir: names.integration, branch: names.runBranch,
        mounts: rels,
        ...(skipped.length ? { skipped } : {}),
        ...(envFiles.length ? { envFiles } : {}),
      });
    }
  }

  /**
   * Delete this plan's own `pe/*` branches once their work is on the trunk.
   *
   * A console that drives thirty runs otherwise leaves thirty `pe/<slug>` refs
   * and every lane branch beside them, for ever. After the pull request merges
   * the commits are on the target and the branch is a name for something that
   * already happened.
   *
   * 🔴 Evidence, not assumption, and git is the only witness this process has:
   * nothing records the PR number (the SESSION opens it), so "merged" is asked
   * of the object database — is this branch reachable from the trunk — and
   * `git branch -d` asks the same question again on its own account. A
   * squash-merge whose commits the local trunk has not fetched simply reads as
   * unmerged, and the branch survives; that is the safe direction, and the
   * next drive after somebody fetches will delete it. `-D` is not reachable
   * from here at all (`never-push.test.ts`).
   *
   * 🔴 NEVER the live run's own branches. Called from the drive preamble,
   * where this run is about to stand on `pe/<slug>` — deleting it under the
   * run that is using it would be this function undoing the preamble two lines
   * later. `checkedOutIn` inside `deleteMergedBranches` is a second guard for
   * the same thing, and the settle's own call reaches here after the run has
   * finished with the branch.
   */
  private async pruneRunBranches(state: RunState, opts?: { includeOwn?: boolean }): Promise<void> {
    if (this.deps.worktreePrefs?.().deleteMergedBranches === false) return;
    const repos = state.mountedRepos?.length
      ? state.mountedRepos.map((rel) => ({ rel, source: join(state.root, rel) }))
      : [{ rel: '', source: state.root }];
    const own = `pe/${state.slug}`;
    const swept: string[] = [];
    for (const repo of repos) {
      const trunk = await defaultBranchOf(repo.source);
      if (!trunk) continue;
      const branches = (await runBranches(repo.source, state.slug))
        .filter((branch) => opts?.includeOwn || branch !== own);
      if (!branches.length) continue;
      const result = await deleteMergedBranches({ repos: [repo], branches, target: trunk });
      swept.push(...result.deleted);
    }
    if (swept.length) this.record('run.branches-pruned', { deleted: swept });
  }

  protected async drive(): Promise<void> {
    const state = this.state!;
    // Before anything asks for a lane — a previous run's wedged `integration/`
    // is why the whole feature silently stops working (D10).
    await this.sweepStaleWorktrees();
    // …and before the first phase boards, because `laneRoot` reads `workRoot`
    // and a session spawned before this settled would run in the shared tree
    // while the run's own record said otherwise.
    await this.ensureRunCheckout();
    this.persist();
    // …and only now, because the preamble is what decides whether this run has
    // a checkout of its own at all. Armed here rather than at `start()` so a
    // run that was REFUSED one — or that dropped isolation on a resume — never
    // arms a probe with nothing to probe.
    this.syncGitProbe();
    /**
     * The lanes this loop is waiting on, keyed by phase.
     *
     * Never rejects — `laneOf` converts a throw into a settled lane, because
     * `Promise.race` rejecting on one lane would abandon every other lane
     * still holding a live session.
     */
    const inFlight = new Map<number, Promise<{ phase: number; carryOn: boolean }>>();
    /** Something said stop. Admit nothing more; let what is running finish. */
    let stopping = false;

    /**
     * Wait for the next lane to settle. The only place the loop advances.
     *
     * The empty guard is not defensive clutter: `Promise.race([])` returns a
     * promise that never settles, so one wrong path into here would hang the
     * loop forever with no error, no log line and a run that reads `running`
     * for as long as the console lives.
     */
    const settleOne = async (): Promise<void> => {
      if (!inFlight.size) return;
      // The race includes the wake signal: a handoff written by an OUTSIDE
      // session (a manual terminal, another console) used to be invisible
      // until a lane settled — on a one-lane run, hours. The docs watcher
      // resolves the signal; the loop top re-reads the board. `docsDirty` is
      // the truth and the promise only ends the sleep, so a poke landing
      // between the race settling and the re-arm is still seen.
      const done = await Promise.race([
        ...inFlight.values(),
        this.wake.promise.then(() => null),
      ]);
      this.wake = wakeSignal();
      if (done === null) { this.docsDirty = false; return; }
      inFlight.delete(done.phase);
      this.persist();
      // A phase settling is the moment the run branch moved — its session
      // committed, or its lane landed. Fire-and-forget for the reason
      // `pruneWorktrees` is: the loop must not wait on git to admit the next
      // phase, and a probe that arrives a second late is a probe.
      void this.refreshGit();
      if (!done.carryOn) stopping = true;
    };

    /**
     * Drain before concluding anything.
     *
     * Every ending below — paused, halted, finished, out of budget — is a
     * statement about the whole run, and making it while a lane is still
     * editing a repository would be false. So each one waits its turn: with a
     * single lane this is exactly the old `break`, and with several it is the
     * difference between "the run stopped" and "the run stopped, and two
     * sessions carried on writing without a supervisor".
     */
    const draining = async (): Promise<boolean> => {
      if (!inFlight.size) return false;
      await settleOne();
      return true;
    };

    try {
      while (true) {
        if (this.abort?.signal.aborted) {
          if (await draining()) continue;
          // A halt that stands keeps its word (`runRecovery`'s rule, now the
          // loop's too): `paused` beside a live halt is two stories at once.
          state.status = state.halt ? 'halted' : 'paused';
          state.pause = null;
          if (this.shuttingDown) {
            // The console is going away under a run that was working. Said
            // so, and stamped as the system's stop: the convergence loop picks
            // it up at the next boot (`resumeAtBoot`), which it would never do
            // for a stop the operator asked for.
            state.stoppedBy = 'system';
            state.finishedReason ??= 'the console shut down while this run was working — it continues by itself once the console is back';
          } else {
            const stamp = this.stopStamp();
            state.stoppedBy = stamp.stoppedBy;
            state.finishedReason ??= stamp.note;
          }
          break;
        }
        if (state.status === 'frozen') {
          // A freeze stops ADMITTING, and `stopAdmitting` alone was not enough:
          // it `continue`s, and the loop top had no branch for `frozen`, so the
          // run fell through to the board read and came straight back — a tight
          // loop spawning a `phase-graph.sh` per iteration, forever.
          //
          // Draining IS the wait while lanes are frozen: they settle when their
          // own 15-minute escalation converts them, which is the only clock
          // allowed to end a freeze.
          if (await draining()) continue;
          // Nothing is left to drive. That state is reachable without any lane
          // ever having been stopped: a lane frozen between admission and spawn
          // is refused at boarding and deleted by `runPhase`'s `finally`, which
          // left the run reading `frozen` with no lane in it — unthawable
          // (`thaw()` had nothing to thaw) and escapable only by Stop.
          //
          // Reached only with `draining()` exhausted, so nothing is running and
          // no child survives — which is exactly the condition under which this
          // loop's own `finally` clears `state.freeze`. So the slot does NOT
          // survive this exit, and the operator must not be told it will: the
          // freeze stopped nothing that is still stopped, and Continue simply
          // picks the run up from the next ready phase. (A freeze that DID stop
          // a live child leaves that child surviving, the `finally` keeps the
          // slot, and the halt built from it carries the `kill -CONT` remedy.)
          state.status = 'paused';
          state.stoppedBy = 'operator';
          state.pause = null;
          state.finishedReason ??= `frozen by ${state.freeze?.by ?? 'the operator'} with nothing left running `
            + '— Continue picks this run up from the next ready phase';
          this.record('run.frozen-idle', { phase: state.freeze?.phase ?? null });
          break;
        }
        if (state.status === 'pausing') {
          // A pause stops ADMITTING. What is already running is left to finish
          // — that is what "after this phase" has always meant, and with lanes
          // it means after all of them.
          if (await draining()) continue;
          state.status = 'paused';
          state.stoppedBy = 'operator';
          this.record('run.paused', { afterPhase: state.pause?.afterPhase ?? null });
          state.finishedReason = state.pause?.afterPhase != null
            ? `paused by ${state.pause.by} after phase ${state.pause.afterPhase} finished`
            : `paused by ${state.pause?.by ?? 'the operator'} at a phase boundary`;
          state.pause = null;
          break;
        }
        if (state.status === 'halting') {
          // The reconcile pass below can CLEAR a halt whose anchor phase the
          // board has overtaken (someone finished it by hand mid-drain). A
          // halting run whose halt is gone is not halting any more — it goes
          // back to driving instead of finalizing a stop about nothing.
          if (!state.halt) {
            state.status = this.resumedStatus();
            this.record('run.halt-superseded', { note: 'the board overtook the halt while lanes drained' });
            continue;
          }
          // A halt in one lane stops ADMITTING; what is already running drains
          // — the same shape as a pause, with a worse reason. Only when the
          // last lane settles may the run read `halted`: "halted" with live
          // sessions still editing trees is a lie, and one reconcile would
          // compound (halted is not IN_FLIGHT, so a dead console mid-drain
          // would never pid-check those children).
          if (await draining()) continue;
          state.status = this.parkPending ? 'parked' : 'halted';
          this.parkPending = false;
          break;
        }
        // An out-of-band park — the approval-timeout hook is the one that
        // matters — sets `state.halt` and `parked` from OUTSIDE this loop, and
        // the loop had no branch for it. So it fell through, re-read the board
        // and admitted candidates: `runPhase` then read the gate, took a lock
        // and boarded a phase on a run the console had already stopped, two
        // bash subprocesses and a journal line per turn, indefinitely. Fires at
        // the default single lane too, as soon as the parked phase's own
        // session finishes.
        if (state.status === 'parked' && state.halt) {
          if (await draining()) continue;
          break;
        }
        if (stopping) {
          if (await draining()) continue;
          // A terminal word, because nothing else writes one here any more.
          // Until the halt-kind split, "a phase settled and told the loop not
          // to carry on" was ALWAYS accompanied by a run-level halt, and
          // `halt()` wrote the status; a phase-level ending writes
          // `record.halt` and deliberately leaves the run alone — which left it
          // reading `running` for ever, with nothing running. The run is
          // `parked`: work remains, and the reason is the phase's own words
          // rather than a sentence invented here.
          // `queued` as well as `running` (QA F5): a lane can settle while the
          // run reads `queued` because another lane is waiting on its scope, and
          // falling through in that word is the same "reads live for ever with
          // nothing running" shape this branch exists to fix.
          //
          // 🔴 `waiting` is deliberately NOT in the list. It is not a live word
          // that leaked — it is the word an external-wait park DELIBERATELY
          // wrote, with `waitUntil` beside it, and overwriting it with `parked`
          // loses the clock the run resumes on (caught by
          // `runner.test.ts` "a lane inside a poll loop is parked"). `frozen`,
          // `pausing`, `halting` and every settled word are owned by branches
          // above, for the same reason.
          if (!state.halt && (state.status === 'running' || state.status === 'queued')) {
            // The ending that happened LAST, not the highest phase number —
            // `Object.values(state.phases)` is integer-keyed. Shared with the
            // end-of-plan headline below so the two cannot drift.
            const last = latestEnding(Object.values(state.phases));
            state.status = 'parked';
            state.stoppedBy = 'system';
            // Assigned, not `??=`: the newest stop is the headline. A sentence
            // left from an earlier phase's stop would describe a phase this run
            // has since moved past.
            state.finishedReason = last?.halt
              ? `phase ${last.phase}: ${last.halt.reason}`
              : 'a phase settled and this run was not told to carry on.';
            this.record('run.parked', { reason: state.finishedReason });
          }
          break;
        }
        if (state.runBudgetUsd && state.spentUsd >= state.runBudgetUsd) {
          if (await draining()) continue;
          // The budget wall's one rung — raise once within the policy cap —
          // then the errand. `continue` re-enters the loop top with the new cap.
          if (this.raiseBudgetOnce()) continue;
          this.haltOnBudget();
          break;
        }

        const board = await this.board();
        // Re-read, because `board()` is a `phase-graph.sh` subprocess and the
        // whole gap between the check at the top of this loop and here is time
        // an operator can press Pause in. They did, repeatedly, and watched the
        // next phase start anyway: the flag was set a few hundred milliseconds
        // after the only line that read it. Going back to the top rather than
        // breaking here keeps ONE piece of pause bookkeeping, up there.
        // `halting` for the same reason: a lane can halt the run while the
        // board subprocess is in flight, and the loop top owns that bookkeeping.
        if (stopAdmitting(state.status)) continue;
        if (board.error) {
          if (await draining()) continue;
          this.halt(`the engine could not read the plan: ${board.error}`, undefined, 'plan-unreadable');
          break;
        }

        // Records first: resolutions queued by recoveries, then anything the
        // board has overtaken — a phase finished outside this run flips to
        // done HERE, halts anchored to it clear, and the loop never spends a
        // session on work somebody already did.
        this.applyReconcile(board);
        // A lock-cap park re-arms the moment the lock it waited on is gone —
        // the docs watcher wakes this tick on the release. See `rearmLockCapParks`.
        await this.rearmLockCapParks(board);

        const outstanding = [...board.ready, ...board.waiting, ...board.inProgress, ...board.stuck];
        // A run asked for specific phases is finished when THOSE are settled —
        // not when the plan is. Restricting the candidate list here rather than
        // in the caller keeps one definition of "ready" (the engine's).
        const asked = state.onlyPhases?.length ? new Set(state.onlyPhases) : null;
        const nowIso = new Date().toISOString();

        // The ladder's own pass, after reconcile and before the candidate set:
        // records the last boarding settled badly (`interrupted`, `failed`) and
        // phases whose handoff exists but is not complete are CLASSIFIED
        // (runner/situation.ts) and, when a rung this runner can drive exists,
        // reset to `pending` with a boarding hint — so a resumed run whose only
        // open record is an interrupted never-started phase boards it fresh on
        // this very tick, and a failed phase with unfinished work on disk
        // resumes its own session, with nobody pressing anything.
        await this.climbLadder(board, asked);

        // A waiting-external phase whose window has elapsed re-boards through
        // the normal lanes — but from the board's point of view it may read
        // `in-progress` (the session wrote the durable pause marker before
        // parking), which `board.ready` never lists. So expired waits join the
        // candidate set explicitly, and unexpired ones are filtered out below.
        // `stuck` is in the list too: a session that wrote a `blocked` handoff
        // AND declared a wait used to be a phase that was never a candidate
        // yet always "waiting" — the run re-entered `waiting` with a past
        // clock forever (the measured livelock). Its own session is resumed
        // exactly like the in-progress shape.
        const expiredWaits = Object.values(state.phases)
          .filter((r) => r.status === 'waiting' && r.parkedUntil && r.parkedUntil <= nowIso)
          .map((r) => r.phase)
          .filter((p) => board.states[p] === 'ready' || board.states[p] === 'in-progress' || board.states[p] === 'stuck');
        // Phases the ladder (or a `start({reboard})`) asked to board: `pending`
        // with a hint, on a board that does not read done — `in-progress` and
        // `stuck` included, which `board.ready` never lists.
        const hinted = Object.values(state.phases)
          .filter((r) => r.status === 'pending' && r.boardingHint)
          .map((r) => r.phase)
          .filter((p) => {
            const at = board.states[p] ?? '';
            if (['ready', 'in-progress', 'stuck'].includes(at)) return true;
            // The ONE boarding that deliberately targets a phase the board
            // reads `done`: a review follow-up. The phase finished and wrote a
            // `complete` handoff — that is WHY there was a diff to review —
            // so the board will go on reading it done until the next handoff
            // lands, and every other hint must keep being filtered out here.
            // Widening this to `done` in general would let the ladder re-board
            // finished work on a stale record.
            //
            // The SECOND boarding that targets a done phase on purpose: a QA
            // rung. `qa-failed` and `qa-pending` are DEFINED by the board
            // reading done — the phase finished, then the verdict came back —
            // so `climbLadder` admits the holder and `climb` hints it, and
            // this filter dropped the hint every time: a rung spent, no
            // session run (RC4, measured on phase-console-commerce).
            const hint = phaseRecord(state, p).boardingHint;
            return at === 'done'
              && (hint?.rung === FOLLOW_UP_RUNG || String(hint?.situation ?? '').startsWith('qa-'));
          });
        const candidates = [...new Set([...board.ready, ...expiredWaits, ...hinted])]
          .filter((p) => !asked || asked.has(p))
          .filter((p) => !SETTLED.includes(phaseRecord(state, p).status))
          .filter((p) => {
            const record = phaseRecord(state, p);
            if (record.status !== 'waiting') return true;
            return !!record.parkedUntil && record.parkedUntil <= nowIso;
          })
          // A phase this loop is already driving is not a candidate to start
          // again. The board cannot know — it reads handoffs, and a phase in
          // flight has not written one yet.
          .filter((p) => !inFlight.has(p));

        // Nothing to start, but something is running: it may be about to make
        // more phases ready. Concluding "finished" here is the fastest way to
        // stop a plan one phase in.
        if (!candidates.length && await draining()) continue;

        // Everything startable is parked on an external clock: the RUN waits —
        // restart-safe (`waiting`→`paused` keeps the clock on reconcile, and
        // the service re-arms the resume at boot, exactly like a usage-window
        // sleep) — instead of halting a plan that is merely early. Checked
        // before the scoped-run ending, or a run scoped to a waiting phase
        // would declare itself finished mid-wait.
        // Only waits whose clock is still AHEAD: an expired one is either a
        // candidate above, or — when its board state cannot board (`waiting`,
        // `done`) — not a reason to hold the run on a clock that has passed.
        // Counting expired waits here was the other half of the livelock: the
        // run went back to `waiting` with a `waitUntil` in the past.
        if (!candidates.length && this.enterRunWaiting(nowIso, asked)) break;

        // "Settled" here has to mean settled WELL. `SETTLED` includes `parked`,
        // `gated` and `failed`, so a scoped run whose one phase parked used to
        // report itself finished — "this run was scoped to phase 1, and it is
        // settled" — which is true of the status field and false about the
        // world, and it hid the park's own explanation entirely. A scoped run
        // that ends on a phase needing a person falls through to the halt
        // below, which names the blocker and its remedy like any other run.
        const unsettled = asked
          ? [...asked].filter((p) => ['parked', 'gated', 'failed'].includes(phaseRecord(state, p).status))
          : [];
        if (asked && !candidates.length && !unsettled.length) {
          // A scoped run finishes HERE and never reaches the settle below, so
          // the at-settle review has to be asked for in both places or an
          // operator who ran two phases and asked for one cloud review would
          // silently get none. Settled-well is the condition either way:
          // `unsettled` is empty, so nothing on this tree is still owed.
          await this.ultraReviewAtSettle();
          state.status = 'finished';
          // The single most-reported "it doesn't go to the next phase". The run
          // was scoped — usually from a per-row "Run only this" control — did
          // exactly what it was asked, and then said nothing about why it
          // stopped one phase in. It says so now, and the console offers the
          // one-click widening beside it.
          const list = [...asked].join(', ');
          state.finishedReason = `this run was scoped to phase ${list}, and ${asked.size === 1 ? 'it is' : 'those are'} `
            + 'settled. Continue with the scope cleared to carry on through the rest of the plan.';
          this.record('run.finished', {
            onlyPhases: [...asked],
            note: 'the phases this run was asked for are settled',
          });
          break;
        }

        if (!candidates.length) {
          // What happens to the finished branch is a CHOICE now (P12), and
          // `settleRun` is where the four words become four behaviours. Only a
          // run that finished everything settles: a parked run still has work
          // on that branch, and folding it anywhere — or asking a person to
          // read it — would be claiming it is done.
          // A phase that ENDED BADLY keeps the run out of `finished`, even when
          // the board has nothing left to offer. Since the halt-kind split a
          // phase-level ending settles its own phase and the loop carries on —
          // which is the point — but "every phase of X is done" must not be the
          // sentence a run gets when one of them failed its verification and the
          // board happens to read that phase done from a handoff it wrote
          // anyway. `record.halt` is exactly the marker for it.
          const badly = Object.values(state.phases)
            .filter((r) => r.halt).sort((x, y) => x.phase - y.phase);
          const endedBadly = badly.length > 0;
          // The at-settle cloud review, on the SAME condition the settle runs
          // on minus the git mode: a run that parked or ended badly still has
          // work outstanding on that tree, and billing a review of unfinished
          // work is the one way this tier could waste an operator's money
          // without them ever asking for anything. The git mode is deliberately
          // not part of it — a default-branch run has no branch to settle and
          // still has a finished body of work the operator asked to have read.
          if (!outstanding.length && !endedBadly) await this.ultraReviewAtSettle();
          const settled = !outstanding.length && !endedBadly && state.gitMode === 'new-branch'
            ? await this.settleRun()
            : null;
          state.status = outstanding.length || endedBadly ? 'parked' : 'finished';
          if (outstanding.length || endedBadly) state.stoppedBy = 'system'; else delete state.stoppedBy;
          // Name the phases AND attribute the sentence. Quoting one unlabelled
          // reason under "3 phases did not finish cleanly" sends a person to the
          // wrong phase page, which is the one thing this line exists to prevent.
          // The quote is the ending that happened LAST — the one an operator
          // reading this the moment the run parks is asking about.
          const latest = latestEnding(badly);
          state.finishedReason = outstanding.length
            ? undefined
            : endedBadly
              ? `${badly.length === 1 ? 'phase' : 'phases'} ${badly.map((r) => r.phase).join(', ')} `
                + `did not finish cleanly — phase ${latest!.phase}: ${latest!.halt!.reason}`
              : `every phase of ${state.slug} is done.`;
          if (settled) state.finishedReason = settled;
          if (outstanding.length) {
            // Parking with work left is not self-explanatory: every phase this
            // loop will not pick up again needs its ACTUAL blocker named — a
            // gated phase parked with "is parked", and a blocked-handoff phase
            // hid behind "waiting on a gate or an earlier phase", and both
            // read as dead ends (reported twice, with two real plans).
            const readyRecords = board.ready.map((p) => ({ p, record: phaseRecord(state, p) }));
            // Phases the ladder parked with an ERRAND — one named ask for a
            // person, written after every automatic rung was tried or when the
            // situation was a person's from the start. Named first: they are
            // the doors that exist, whatever the board reads for them.
            const errands = Object.entries(state.recoveries ?? {})
              .filter(([key, slot]) => slot.errand && /^\d+$/.test(key)
                && state.phases[key]?.status === 'parked' && (!asked || asked.has(Number(key))))
              .map(([key, slot]) => ({ p: Number(key), errand: slot.errand! }));
            const errandPhases = new Set(errands.map((e) => e.p));
            // The phases whose QA verdict is holding the DAG, read from the
            // board rather than from this run's records — the blocker is a
            // phase the board reads DONE, so it has no open record to find it
            // by. Everything below used to derive from `readyRecords`, which is
            // empty in exactly the case that most needs explaining: a plan
            // wedged with nothing ready at all.
            const qaHolders = Object.entries(board.qa ?? {})
              .filter(([, verdict]) => verdict !== 'pass' && verdict !== 'waived')
              .map(([phase, verdict]) => ({ p: Number(phase), verdict }))
              .filter(({ p }) => Number.isFinite(p))
              .sort((x, y) => x.p - y.p);
            const heldByQa = (p: number): number[] => Object.entries(board.blockedBy ?? {})
              .filter(([, deps]) => deps.includes(p)).map(([blocked]) => Number(blocked)).sort((x, y) => x - y);
            const held = [
              ...errands.map(({ p, errand }) => `phase ${p} needs you — ${errand.need} (${errand.how})`),
              ...readyRecords.filter(({ p }) => !errandPhases.has(p)).map(({ p, record }) =>
                `phase ${p} is ${record.status}${record.note ? ` (${record.note})` : ''}`),
              ...board.stuck.filter((p) => !errandPhases.has(p)).map((p) =>
                `phase ${p}'s handoff is marked blocked — its Outstanding section says why`),
              ...qaHolders.filter(({ p }) => !errandPhases.has(p)).map(({ p, verdict }) => {
                const blocks = heldByQa(p);
                return `phase ${p} is done but its QA verdict is ${verdict}`
                  + (blocks.length ? `, which holds phase${blocks.length === 1 ? '' : 's'} ${blocks.join(', ')}` : '');
              }),
            ].join('; ');

            // The remedy tail names only doors that exist. It used to be one
            // fixed sentence advertising gate confirmation and Repair with AI
            // to runs with no gate and no blocked handoff — an operator did
            // nothing on that advice, correctly, and the run stayed down.
            const verificationParked = readyRecords.filter(({ record }) =>
              record.status === 'parked' && VERIFICATION_PARK_NOTE.test(record.note ?? ''));
            const remedies: string[] = [];
            if (errands.length) remedies.push('a phase parked with an errand takes that errand, then Retry');
            if (readyRecords.some(({ record }) => record.status === 'gated')) {
              remedies.push('Gates need your confirmation (then Retry re-checks them)');
            }
            if (board.stuck.length) remedies.push('a blocked handoff has Repair with AI');
            if (readyRecords.some(({ record }) => record.status === 'failed')) {
              remedies.push('failed phases take Retry or Skip');
            }
            if (verificationParked.length) {
              remedies.push('an unrunnable §Verification takes a plan edit or Repair with AI, then Retry');
            }
            // Two doors, because there genuinely are two — and neither was ever
            // named. A recorded verdict is not a defect the autopilot can clear:
            // somebody has to give a verdict, or say the gate does not apply.
            if (qaHolders.length) {
              remedies.push('a QA verdict that holds the plan takes Record a verdict on that phase '
                + '(pass or waived), or a fresh QA session — or "**QA gate:** off" in the plan\'s '
                + '§Session budget if this plan should not gate on QA at all');
            }
            // The MCP park had NO remedy string at all, which is how a run
            // parked on three signed-out servers ended with a halt sentence
            // that named the problem and then stopped talking. Two doors,
            // because there genuinely are two: fix the server, or decide the
            // phase does not need it. The second is one button.
            const mcpParked = readyRecords.filter(({ record }) =>
              record.status === 'parked' && MCP_PARK_NOTE.test(record.note ?? ''));
            if (mcpParked.length) {
              const signIn = mcpParked.some(({ record }) => MCP_AUTH_PARK_NOTE.test(record.note ?? ''));
              remedies.push(signIn
                ? 'a signed-out MCP server takes Settings ▸ MCP (the parked phase requeues itself once it '
                  + 'connects), or Continue without these servers'
                : 'an MCP server this console cannot reach takes Settings ▸ MCP, or Continue without these servers');
            }
            // A lock-cap park is the same shape of dead end and had the same
            // silence: the holder is named in the note, but nothing said the
            // wait can simply be restarted.
            //
            // Two sentences, because since D28 there are two causes and the
            // wrong one sends a person looking for a lock file that does not
            // exist. Two INDEPENDENT `if`s, like every other remedy in this
            // block: a halt can hold one of each, and an `else if` here made a
            // single cap-parked phase swallow the lock sentence for every other
            // parked phase in the same halt — one wrong sentence traded for one
            // missing one. Each predicate is asked about its own records:
            // `BY_CAP` is the specific case and `NOTE` is the broad one that
            // matches it too, so the lock arm excludes what the cap arm claimed.
            const parkedRecords = readyRecords.filter(({ record }) => record.status === 'parked');
            if (parkedRecords.some(({ record }) => LOCK_CAP_PARK_BY_CAP.test(record.note ?? ''))) {
              remedies.push('a phase that waited two hours for a free lane takes Retry (or raise the '
                + 'session cap in Settings) — it re-arms by itself when a lane frees');
            }
            if (parkedRecords.some(({ record }) => LOCK_CAP_PARK_NOTE.test(record.note ?? '')
              && !LOCK_CAP_PARK_BY_CAP.test(record.note ?? ''))) {
              remedies.push('a phase that waited out another plan\'s lock takes Retry once the holder releases');
            }
            const tail = remedies.length ? ` ${remedies.join('; ')}.` : '';

            // When the ONLY thing in the way is verification parks, the halt
            // carries a machine-readable kind (and a phase to anchor on) so
            // auto-recovery can pick it up instead of a person. MCP parks get
            // the same treatment for the console's sake rather than a repair
            // agent's — no agent can sign a server in, but the run page can
            // offer the one button that releases the run, and it needs to know
            // that is what it is looking at.
            const allVerification = verificationParked.length > 0
              && verificationParked.length === readyRecords.length && !board.stuck.length;
            const allMcp = mcpParked.length > 0
              && mcpParked.length === readyRecords.length && !board.stuck.length;
            // A plan nothing can move: no ready phase, no lane in flight, and a
            // QA verdict holding the rest. It is anchored on the HOLDING phase
            // — the one a person can actually act on — which is a phase the
            // board reads done, and therefore one no record-derived anchor
            // could ever have found.
            const deadlocked = qaHolders.length > 0 && !board.ready.length && !board.inProgress.length;
            state.halt ??= {
              at: new Date().toISOString(),
              reason: held
                ? `nothing left to run on its own — ${held}.${tail}`
                : `nothing is ready to run: ${outstanding.length} phase(s) are still waiting on a gate or an earlier phase.`,
              ...(deadlocked
                ? { kind: 'plan-deadlocked', phase: qaHolders[0].p }
                : allVerification
                  ? { kind: 'verification-preflight', phase: verificationParked[0].p }
                  : allMcp
                    ? { kind: 'mcp-preflight', phase: mcpParked[0].p }
                    // The rest — gates, errands, failed phases awaiting Retry,
                    // blocked handoffs, lock-cap parks, in any mixture — used
                    // to park with NO kind at all, which is how 4 of the hub's
                    // 53 run files came to carry a halt nothing could classify
                    // (LFC-1). `held` above names every holder; the kind names
                    // the shape.
                    : { kind: 'nothing-ready' }),
            };
            state.finishedReason = state.halt.reason;
          }
          this.record(outstanding.length ? 'run.parked' : 'run.finished', {
            outstanding, done: board.done,
          });
          break;
        }

        // Fill every free lane this run is allowed, then wait for the first to
        // settle. One lane makes this exactly what it was: start a phase, wait
        // for it, go round again.
        for (const phase of candidates) {
          if (inFlight.size >= this.maxLanes()) break;
          // The same re-check as the one above the board read, and for the
          // same reason: `rearmLockCapParks` and `climbLadder` both await
          // between there and here, so a pause or a halt can land in the gap —
          // and it must stop the SECOND lane of a burst as well as the first.
          if (stopAdmitting(state.status)) break;
          inFlight.set(phase, this.laneOf(phase, board));
        }
        await settleOne();
      }
    } catch (error) {
      // A throw in here would otherwise be an unhandled rejection, which is one
      // of the ways this console used to disappear.
      log.error('runner.crashed', { error });
      this.halt(`the runner itself failed: ${(error as Error)?.message ?? error}`, undefined, 'runner-crashed');
    } finally {
      // A drain the loop never finished — a `break` that bypassed the loop top,
      // or the `catch` above halting with lanes still recorded — must still
      // land on the final word: nothing is running past this line. A park that
      // was draining lands on `parked`; only a halt lands on `halted`.
      if (state.status === 'halting') {
        state.status = this.parkPending ? 'parked' : 'halted';
        this.parkPending = false;
      }
      // Park pokes die with the loop: a stopped run's resume is the service's
      // boot/timer decision, made from `waitUntil` on the record — not a
      // callback into a loop that no longer exists.
      for (const timer of this.parkPokes.values()) clearTimeout(timer);
      this.parkPokes.clear();
      // Whatever is left is not running any more, whichever way the loop left.
      for (const lane of this.lanes.values()) this.clearFreezeTimer(lane);
      this.lanes.clear();
      this.disarmLivenessTicker();
      // The branch probe dies with the loop for the liveness ticker's reason:
      // nothing is committing any more, so a five-minute re-read of a
      // repository would be a subprocess spent to learn the same thing for as
      // long as the console lives. The CACHE stays — the last answer is still
      // the true one, and it is what the run's page renders after it stops.
      this.disarmGitProbe();
      // The worktrees this run created, removed unless they still hold commits
      // the run branch does not have. Deliberately fire-and-forget: the loop's
      // `finally` is not a place to await minutes of git, and a worktree left
      // behind is a directory, not a lost commit. Whatever survives is named in
      // the journal and `git worktree prune` collects it next time.
      // Held, not awaited: the next drive of this plan waits on it in
      // `ensureRunCheckout`, and nothing else does.
      this.prunePending = this.pruneWorktrees().finally(() => { this.prunePending = null; });
      void this.prunePending;
      // The lane table is gone, so `syncMirror` now has only the persisted
      // entries to work from — and it keeps the ones the probe still finds.
      // The comment above this block used to read "whatever is left is not
      // running any more, whichever way the loop left", and that is exactly
      // the assertion that was false: a loop aborted while a child was frozen
      // leaves a child that is very much still there. Erasing `children` and
      // `freeze` here destroyed the only two facts `reconcileRun`'s orphan
      // branch needed, which is why a stopped child was never found again.
      this.syncMirror();
      const survivors = survivingChildren(state);
      const live = Object.keys(survivors).length;
      if (live) {
        state.children = survivors;
        state.child = survivors[String(Math.min(...Object.keys(survivors).map(Number)))] ?? null;
      } else {
        state.child = null;
        delete state.children;
      }
      this.childPid = null;
      this.handle = null;
      // A freeze cannot outlive the loop that would have thawed it — UNLESS its
      // process is still there, in which case the freeze is the fact that
      // explains why, and the halt built from it is what tells the operator to
      // `kill -CONT`. Cleared only once nothing survives.
      if (!live) state.freeze = null;
      // The token dies with the loop. Anything still waiting on a decision is
      // answered rather than left holding a socket nobody is watching — this
      // run's cards only, because another run's are still answerable.
      this.deps.approvals?.disarm(state.id);
      // …and neither does the question it was asking. A phase left reading
      // `awaiting-verification` on a run that has stopped goes on presenting as
      // "Waiting on you" — a card whose broker is disarmed, whose run is over,
      // and which no answer can reach. The state file for the halted 02:55 run
      // still said this hours later.
      this.settleAwaitingVerification();
      // …and the records that still claim to be running. This block reaches
      // here holding ZERO lanes, which is the strongest evidence this process
      // will ever have that a `running` record is stale — and until now it
      // touched no record at all, so a run that parked here kept its in-flight
      // phases exactly as they were and only `reconcileRun` could ever close
      // them, which it refuses to do for a `parked` run. Settled BEFORE
      // `persist()`, so the terminal status and the records it implies reach
      // disk together rather than one restart apart.
      for (const phase of settleInFlightRecords(
        state, this.now().toISOString(), TEARDOWN_SETTLES,
      )) {
        this.emit('phase', { phase, status: 'interrupted' });
      }
      // `persistNow`, not `persist`: this is the run's TERMINAL checkpoint and
      // the loop is about to unwind, so there is no later save to fold into.
      // A debounced write here is the one a process exits before paying.
      this.persistNow();
      this.emit('run', { state });
    }
  }

  /**
   * One lane, as a promise that always settles.
   *
   * `Promise.race` is how the loop waits, and a race rejects the moment ANY
   * racer does — which would drop the loop out of its `while` while other
   * lanes still held live sessions, with nothing left to reap them. So a lane
   * that throws becomes a lane that finished badly.
   */
  private laneOf(phase: number, board: Board): Promise<{ phase: number; carryOn: boolean }> {
    return this.runPhase(phase, board).then(
      (carryOn) => ({ phase, carryOn }),
      (error: unknown) => {
        log.error('runner.lane.crashed', { phase, error });
        this.halt(`phase ${phase} failed inside the runner: ${(error as Error)?.message ?? error}`, phase, 'phase-crashed');
        return { phase, carryOn: false };
      },
    );
  }

  /**
   * The `gates` row's answer for this run (phase 11): `delegated` — a manual
   * gate is briefed to the phase's own session to evidence and clear — or
   * `operator`. The plan's row, else this console's word, else the shipped
   * `delegated`; the legacy `delegateHumanGates` dep is the console's word for
   * a harness that supplies nothing else.
   */
  private gatesPolicy(): { answer: string; source: string } {
    const prefs = this.deps.policyPrefs?.()
      ?? (this.deps.delegateHumanGates ? { delegateHumanGates: this.deps.delegateHumanGates() } : null);
    const resolved = policyForKey('gates', this.state, prefs);
    return resolved ? { answer: resolved.answer, source: resolved.source } : { answer: 'operator', source: 'default' };
  }

  /**
   * The credential preflight (phase 11, ZTD-4): the ids the plan names for
   * this phase, asked of the registry by id. Answers `null` when nothing is
   * named or the harness has no registry; `{ park }` under `require` with a
   * missing id (the phase is parked with the class's errand, nothing spent);
   * otherwise records the missing ones on the record under `continue` and
   * updates the run's manifest row in place.
   */
  private async preflightCredentials(phase: number): Promise<{ park: string | null } | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    delete record.credentialsMissing;
    const named = this.deps.planCredentials?.(state.slug, phase);
    if (!named?.ids.length || !this.deps.credentialsHeld) return null;
    const policy = named.policy
      ?? policyForKey('credentials', state, this.deps.policyPrefs?.() ?? null)?.answer
      ?? 'continue';
    let verdicts: { id: string; status: string; reason: string }[];
    try {
      verdicts = await this.deps.credentialsHeld(named.ids);
    } catch (error) {
      // A registry that could not answer refuses nothing — the MCP preflight's
      // rule: "I could not check" and "it is missing" are different facts.
      this.record('phase.credential-preflight', {
        ids: named.ids, held: [], missing: [], policy, skipped: String((error as Error)?.message ?? error),
      }, phase);
      return null;
    }
    const held = verdicts.filter((v) => v.status === 'ok').map((v) => v.id);
    const missing = verdicts.filter((v) => v.status === 'fail').map((v) => ({ id: v.id, reason: v.reason }));
    this.record('phase.credential-preflight', {
      ids: named.ids, held, missing: missing.map((m) => m.id), policy,
      ...(verdicts.some((v) => v.status === 'skip') ? { unprobed: verdicts.filter((v) => v.status === 'skip').map((v) => v.id) } : {}),
    }, phase);
    if (!missing.length) return null;
    const manifestRow = state.manifest?.decisions.find((row) => row.key === 'credentials');
    if (manifestRow) {
      manifestRow.state = 'outstanding';
      manifestRow.value = `${missing.map((m) => `\`${m.id}\``).join(', ')} not held on this console (phase ${phase}); policy ${policy}`;
    }
    if (policy === 'require') {
      const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: new Date().toISOString() });
      const situation: Situation = {
        id: 'blocked-declared', sub: 'credential', key: 'blocked-declared:credential',
        label: 'Declared blocked · credential', blurb: '', actor: 'person',
        why: missing.map((m) => `${m.id}: ${m.reason}`),
      };
      const errand = errandFor(situation.key, slot.rungs ?? [], phase, undefined, null, null, null, null,
        this.policyFor(situation.key));
      errand.need = `The credential${missing.length === 1 ? '' : 's'} the plan names for phase ${phase} and this console does not hold: `
        + `${missing.map((m) => `\`${m.id}\` (${m.reason})`).join('; ')}.`;
      slot.errand = errand;
      record.endedAt ??= errand.at;
      this.record('phase.errand', { ...errand, label: situation.label, reason: 'credential policy is require', by: 'preflight' }, phase);
      return { park: `credential policy is require and ${missing.map((m) => m.id).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not held — ${errand.how}` };
    }
    record.credentialsMissing = missing;
    return { park: null };
  }

  /** Returns false when the run must stop. */
  private async runPhase(phase: number, board: Board): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // `activePhase` is set at SPAWN time by `syncMirror`, never here. The gap
    // between this line and the spawn is three subprocesses and possibly a
    // queue wait; a phase can still turn out not to start, and one that never
    // starts must not have the run claiming to be on it — the pointer feeds
    // the header chip, the "in-progress" row, the ask box and run:state emits,
    // and an early write here is what made an armed pause look ignored.

    /* ---- review hold ----
     * Checked BEFORE the gate, and before any subprocess: a phase whose
     * dependency has requested changes is not going to board whatever the gate
     * says, and the cheapest honest refusal is the one that spends nothing.
     *
     * `gated` is the right status even though no gate is involved. The reader's
     * next move is identical — somebody must answer something before this can
     * run — and inventing a status word would mean teaching the ladder, the
     * situation classifier, the run page's queued tab and every "is anything
     * ready?" summary a vocabulary they would all have to agree on. The NOTE is
     * what tells the two apart, and it says whose hold this is: the console's,
     * not the engine's. `phase.review-held` is its own journal line for the
     * same reason `phase.gate-delegated` is: an audit has to be able to tell
     * "a person's gate" from "a person's review" without parsing prose. */
    const held = this.deps.reviewHold?.(this.state!.slug, phase) ?? [];
    if (held.length) {
      record.status = 'gated';
      record.note = reviewHoldNote(held);
      this.record('phase.review-held', { held }, phase);
      this.emit('phase', { phase, status: record.status, reviewHold: held });
      // Other ready phases may still be runnable — a hold is not a halt.
      return true;
    }

    /* ---- gate ----
     * PHASE_EXEC_GATES=1 is the deliberate opt-in `cmd` gates wait for — the
     * runner is the automation the comment in phase-graph.sh names, and it was
     * the one caller that forgot to say so, leaving every cmd gate reporting
     * "not executed" forever. Page views still never execute plan-authored
     * commands: Service.gateStatus passes no env. */
    const gate = readGateStatus(await this.engine(['--gate-status', String(phase)], { PHASE_EXEC_GATES: '1' }));
    record.gate = gate;
    // A `human` gate the operator has DELEGATED behaves like an ai-clearable
    // one: the boot prompt briefs the session to verify each condition against
    // evidence it can cite and record the clearance, or stop with the condition
    // it could not verify named. Off unless asked for — see `delegateHumanGates`.
    // `--gate-status` reports the human family as `manual:` (the *kind* word
    // `human` comes from `--gate-kind`), so match the same set the classifier
    // does. An unevaluated `cmd` gate is excluded: that is a read that declined
    // to run the command, not a person's decision. Since P9 the engine says so
    // in the kind (`unevaluated:`), which does not match this regex at all; the
    // detail sniff stays for a gate read by an older engine on the same box.
    const humanFamily = /^(manual|human|OVERDUE)$/i.test(gate.kind)
      && !/\bnot executed\b/i.test(gate.detail ?? '');
    // The `gates` row's answer (phase 11, ZTD-5): the plan's `## Decisions`
    // row, else this console's `policy.gates` (the legacy `delegateHumanGates`
    // switch folds in), else the shipped `delegated` — operator decision 11.
    const gatesPolicy = this.gatesPolicy();
    const delegated = humanFamily && gatesPolicy.answer === 'delegated';
    // A delegated gate the session cannot EVIDENCE stops here, before the
    // spend: a `manual` gate whose conditions are not written cannot be
    // verified against anything a session could cite, and boarding it buys a
    // session whose first task is impossible.
    // (`readGateStatus` echoes the whole verdict as `detail` when nothing
    // follows the colon, so a bare `manual:` reads as no conditions too.)
    const detail = (gate.detail ?? '').trim();
    const conditions = detail === gate.kind || detail === `${gate.kind}:` ? '' : detail;
    const unevidenceable = delegated && !conditions;
    if (!gate.clear) {
      if (gate.kind === 'ai' || (delegated && !unevidenceable)) {
        // An ai-clearable gate is the session's FIRST task, not a wall: the
        // engine's own boot prompt orders it to verify each condition, do the
        // work to make failing ones true, and record the clearance before
        // implementing. Booting is exactly how this gate gets cleared. A
        // delegated human gate rides the same path under its own journal line,
        // because "a person's gate a session was asked to verify" is a
        // different fact from "a gate the plan marked ai-clearable" and an
        // audit has to be able to tell them apart.
        this.record(delegated ? 'phase.gate-delegated' : 'phase.gate-ai', {
          gate, ...(delegated ? { decisionKey: 'gates', source: gatesPolicy.source } : {}),
        }, phase);
      } else {
        // human or auto: nothing this run can do — a person must approve (the
        // phase page's Gate card), or the world must change. `gated`, not
        // `parked`: the reader's next move is different, and so is the label.
        const why = unevidenceable
          ? 'delegated, but the gate states no condition a session could evidence — a person approves it'
          : null;
        record.status = 'gated';
        record.note = `gate not clear: ${gate.kind}${gate.detail ? ` — ${gate.detail}` : ''}${why ? ` (${why})` : ''}`;
        this.record('phase.gated', { gate, ...(why ? { why, decisionKey: 'gates', source: gatesPolicy.source } : {}) }, phase);
        this.emit('phase', { phase, status: record.status, gate });
        // Other ready phases may still be runnable, so this is not a halt.
        return true;
      }
    }

    // A pause, halt or stop armed while the gate subprocess ran must end the
    // boarding BEFORE admission — past this point the phase visibly queues
    // (journal line, queued tab, run:state emit) for a run that has already
    // decided to stop.
    const blockedAfterGate = this.boardingBlocked();
    if (blockedAfterGate) {
      this.record('phase.not-started', {
        reason: notStartedReason(blockedAfterGate, 'while the gate was checked'),
      }, phase);
      return true;
    }

    /* ---- admission ----
     * Before the lock belt-check, and deliberately so. The lock answers "is
     * this PHASE taken"; admission answers "may anything touch these REPOS
     * right now", which is the larger question and the one that can make a
     * phase wait rather than fail. Asking it after the gate keeps a gated
     * phase from occupying a queue slot it was never going to use. */
    let grant: ScopeGrant | null = null;
    try {
      grant = await this.admit(phase, 'phase');
    } catch (error) {
      // Waited two hours behind somebody else's lock. `admit` has already
      // parked the phase and named the holder, so there is nothing to add and
      // nothing to start — the loop carries on to whatever else is ready.
      if (error instanceof AdmissionCapped) return true;
      if (!(error instanceof AdmissionAborted)) throw error;
      // Stopped while it waited. Nothing started, so nothing is owed an
      // explanation beyond the journal — and the phase stays startable.
      if (record.status === 'queued') record.status = 'pending';
      this.record('phase.not-started', {
        reason: 'the run was stopped while this phase waited for its scope',
      }, phase);
      return true;
    }

    // The lane exists from here on, so every control can find this phase even
    // before its child has a pid — and so the `finally` below has exactly one
    // place to undo all of it. Its start instant is what the ladder's
    // attempt-end settlement measures from: a rung climbed BEFORE it is this
    // lane's to settle; one climbed inside it on the way out is the next's.
    const laneStartedAt = new Date().toISOString();
    const lane: Lane = {
      phase, pid: null, handle: null, grant, frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
      // The stalemate counter is the phase's, not the lane's: three attempts
      // that changed nothing is a claim about the phase, and each of those
      // attempts had a lane of its own.
      signals: newLaneSignals(this.now().getTime(), { idleAttempts: record.idleAttempts }),
    };
    this.lanes.set(phase, lane);
    this.armLivenessTicker();

    // Its own checkout, if this plan asked for one. Before the session, because
    // the worktree IS the session's cwd; after admission, because a phase that
    // never got its scope must not leave a directory behind.
    const boardable = await this.acquireWorktree(phase, lane);

    try {
      // `false` means it halted on a resync conflict. The `finally` still runs,
      // so the grant, the lane and the mirror are released exactly as they are
      // for every other way out of this method.
      return boardable ? await this.runPhaseAdmitted(phase, board, lane) : false;
    } finally {
      this.clearLeaseTimer(lane);
      // Before the scope is released: the merge reads and moves the run branch,
      // and a sibling lane admitted the instant this one let go could otherwise
      // start its own worktree from a branch mid-merge.
      await this.landWorktree(phase, lane);
      this.deps.scheduler?.release(lane.grant);
      this.clearFreezeTimer(lane);
      this.lanes.delete(phase);
      // No rung stays `running` past its attempt (RCV-6): whatever the
      // outcome-driven settles above left open is settled here from the
      // record the attempt left, so `chargeRung` can never book the NEXT
      // attempt's spend onto this one's rung.
      this.settleRungsAfterAttempt(phase, laneStartedAt);
      this.syncMirror();
      this.persist();
    }
  }

  /**
   * Give this lane its own worktree, or leave it sharing the root — and say
   * which, once, in the journal.
   *
   * Every refusal is NAMED (`worktree.ts` §REFUSAL_REASON) and none of them is
   * fatal: a run that cannot have worktree lanes is a run that behaves exactly
   * as every run behaved before this feature, which is the correct fallback for
   * an optimisation. The one thing that must never happen is a silent one — a
   * plan that says `Worktrees: on` and gets shared checkouts anyway, with
   * nothing anywhere saying why.
   *
   * `not-opted-in` is deliberately silent. It is the default, it is true of
   * essentially every run, and journalling it would put a line in every phase
   * of every plan to report that a feature nobody asked for was not used.
   *
   * Answers whether the phase may BOARD. Only one thing says no: a resync
   * conflict (D9), which halts for the same reason a landing conflict does —
   * git declined to guess which of two edits to the same lines is right, and
   * boarding a session onto a lane in that state would have it work from a base
   * a person has already told the console is wrong.
   */
  private async acquireWorktree(phase: number, lane: Lane): Promise<boolean> {
    const state = this.state!;
    const directive = this.deps.planWorktrees?.(state.slug);
    const refusal = await checkAvailable({
      root: state.root, gitMode: state.gitMode, directive,
    });
    if (refusal) {
      if (refusal !== 'not-opted-in' && !this.worktreeRefusalNoted) {
        this.worktreeRefusalNoted = true;
        this.record('run.worktree-unavailable', {
          refusal,
          // For a run standing on a MIRROR, the stock has-submodules sentence
          // ("a scoped phase would board a session into an empty tree") is
          // false — its phases share the run's mounted checkout, and that is
          // the honest thing to say.
          reason: refusal === 'has-submodules' && this.state?.mountedRepos?.length
            ? 'the run root has submodules, so per-phase lanes are unavailable — '
              + "phases share the run's mirror checkout instead"
            : REFUSAL_REASON[refusal],
        }, phase);
      }
      return true;
    }

    const names = this.laneNamesFor(phase);
    const got = await acquireLane(state.root, names);
    if (got.resync) {
      // Every resync is journalled, including the one that changed nothing:
      // "this retry started from the same place the last one did" is exactly
      // what an operator staring at a repeated failure needs to know.
      this.record('phase.worktree-resynced', {
        branch: names.laneBranch, from: names.runBranch, ...got.resync,
      }, phase);
      if (got.resync.kind === 'conflict') {
        this.halt(
          `phase ${phase}'s worktree could not be caught up with ${names.runBranch}: `
          + `${got.resync.detail}. Conflicted: ${got.resync.files.join(', ')}. `
          + `The merge was ABORTED and nothing was lost — the lane still holds every commit `
          + `it made, at ${names.dir}. `
          + `Resolve it there (merge ${names.runBranch} in by hand), then Retry phase ${phase}.`,
          phase,
          'worktree-merge',
        );
        return false;
      }
    }
    if (!got.ok || !got.dir) {
      this.record('phase.worktree-failed', {
        dir: names.dir, branch: names.laneBranch, detail: got.detail,
      }, phase);
      return true;
    }
    lane.worktree = got.dir;
    // Both, together, or neither: `syncMirror` writes the branch only alongside
    // the directory, so a lane that shares the root never claims a branch of
    // its own. This is the one place either is decided.
    lane.branch = names.laneBranch;
    this.worktreePhases.add(phase);
    this.record('phase.worktree', {
      dir: got.dir, branch: names.laneBranch, into: names.runBranch,
    }, phase);
    return true;
  }

  /**
   * Fold a settled lane's commits into the run branch.
   *
   * A conflict HALTS with `worktree-merge`, names both lanes and lists the
   * conflicted files. It is the one halt in this file whose remedy is neither a
   * rung of the ladder nor a retry: git declined to guess which of two edits to
   * the same lines is right, and no automated rung knows either. Nothing is
   * lost — the merge was aborted, and the lane branch still holds every commit.
   */
  /**
   * Remove this run's worktrees at the end of the loop.
   *
   * Never destructive about work: `pruneRun` leaves any lane whose branch still
   * holds commits the run branch does not have — the state after a conflict
   * halt — and never deletes a branch at all. What it removes is checkouts that
   * have nothing the run branch is missing.
   */
  private async pruneWorktrees(): Promise<void> {
    const state = this.state;
    if (!state) return;
    // Gated on the DIRECTORY, not on state, and that is the load-bearing part.
    //
    // Two shapes reach here — a run that took per-phase LANES, and an isolated
    // run whose own checkout is the integration tree — and a third that is
    // neither: a run that HAD a tree and dropped isolation mid-run, whose state
    // now says `shared` while the tree it minted is still registered and still
    // holding `pe/<slug>`. Gating on `worktreePhases` left every isolated run's
    // tree standing forever; gating on `state.checkout` would leave the dropped
    // one's. Asking the filesystem covers all three and cannot go stale, and it
    // costs one `existsSync` on a path that does not exist for any run that
    // never opted into anything.
    const homes = this.worktreeHomes();
    if (!this.worktreePhases.size && !homes.all.some((home) => existsSync(join(home, state.id)))) return;
    const phases = [...this.worktreePhases];
    try {
      const { removed, kept } = await pruneRun(state.root, {
        home: homes.active, runId: state.id, slug: state.slug, phases,
      });
      this.worktreePhases.clear();
      // `workRoot` goes when the directory does — it points at a tree, and a
      // path to nothing would send the next reader (a recovery, a QA ticket,
      // the run page) somewhere that no longer exists. `checkout` STAYS
      // `worktree`: it records what this run got, which is a fact about its
      // history and does not stop being true when the tree is swept up after
      // it. Kept means DIRTY — `pruneRun`'s one refusal — so the path is still
      // real and the operator still wants it.
      // A mirror's `removed` names its MOUNTS, never the integration directory
      // itself — `pruneMirror` deletes that wholesale once nothing is kept —
      // so the pointer also goes when the directory it names no longer exists.
      if (state.workRoot && (removed.includes(state.workRoot) || !existsSync(state.workRoot))) {
        delete state.workRoot;
        delete state.mountedRepos;
        // …and the detach decision goes with the tree — the FIFTH door out of
        // the worktree shape, after `refuse()`, the `not-opted-in` arm and
        // `decideDetach`'s own re-decision. `branchFor` reads `detachAt`
        // unconditionally, so a finished detached run whose tree this just
        // removed went on answering `detached@<sha>` to the lease refresh of
        // a later recovery lane and to anything else that asked — a lock and
        // an env qualified by a commit its session, now in the shared root,
        // is not standing at. The next drive re-decides it from scratch.
        delete state.detachAt;
        // …and WRITTEN. This runs after the loop's `finally` has already
        // checkpointed — it is fired and not awaited there — so without this
        // the file on disk keeps a `workRoot` pointing at a directory this
        // function has just deleted, which is the one thing the field must
        // never say. Guarded on identity because a new run may have started on
        // this Runner while the prune's git calls were in flight; persisting
        // then would write THIS run's object over that one's.
        //
        // `persistNow`, because "WRITTEN" above is the whole point: this fires
        // AFTER the loop's `finally` has checkpointed, so there is no later
        // save to ride on. Through the debounce the run can end first and the
        // file keeps a `workRoot` naming a directory this function has just
        // deleted — the one thing the field must never say.
        if (this.state === state) this.persistNow();
      }
      this.record('run.worktrees-pruned', { removed: removed.length, kept });
    } catch (error) {
      this.record('run.worktrees-pruned', {
        removed: 0, kept: phases.map(String),
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  private async landWorktree(phase: number, lane: Lane): Promise<void> {
    if (!lane.worktree) return;
    const state = this.state!;
    const names = this.laneNamesFor(phase);
    const result = await landLane(state.root, names);
    this.record('phase.worktree-landed', {
      branch: names.laneBranch, into: names.runBranch, ...result,
    }, phase);
    // The one event that moves every number on the Git card at once: the run
    // branch gained commits, a lane branch stopped being ahead, and a pair the
    // radar was watching may have just resolved — or, on a conflict, may have
    // just been proved right. Awaited here, unlike the settle's, because this
    // is already the slow path and the halt below reads better beside a card
    // that agrees with it.
    await this.refreshGit();
    if (result.kind !== 'conflict') return;

    // Which other lanes are live right now. Naming them is the point: a
    // conflict is by definition about two pieces of work, and a message that
    // named only the lane that happened to finish second would send whoever
    // reads it to look at half the problem.
    const others = this.livePhases().filter((p) => p !== phase);
    this.halt(
      `phase ${phase}'s worktree would not merge into ${names.runBranch}: `
      + `${result.detail}. Conflicted: ${result.files.join(', ')}. `
      + `The merge was ABORTED and nothing was lost — every commit is still on `
      + `${names.laneBranch}, checked out at ${names.dir}. `
      + (others.length
        ? `The other live lane(s) writing the same branch: ${others.map((p) => `phase ${p}`).join(', ')}. `
        : '')
      + `Resolve it by hand in ${names.integration}, then Retry phase ${phase}.`,
      phase,
      'worktree-merge',
    );
  }

  /**
   * The phase itself, once its scope is held. Split out so the grant, the lane
   * and the mirror are released in exactly one place however this returns.
   */
  private async runPhaseAdmitted(
    phase: number, board: Board, lane: Lane,
  ): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // A waiting-external phase whose window elapsed boards as a RESUME of its
    // own session, never a fresh boot — its context is the whole point.
    // Decided here, before anything rewrites the status, and from the
    // DECLARATION and the clock rather than the status word alone (SLF-5): a
    // console's retry-storm park is `waiting` with nothing declared and boots
    // with the engine's own text, and a declaration a licence already spent
    // says nothing about a wait any more.
    const wasWaiting = record.status === 'waiting';
    const resuming = wasWaiting
      && record.declared?.status === 'waiting-external'
      && (!record.parkedUntil || Date.parse(record.parkedUntil) <= Date.now());
    // The ladder's instruction for this boarding, if it left one. Read here for
    // the same reason, and consumed (deleted) only when the session actually
    // spawns, so a boarding abandoned at the gate, the queue or a preflight
    // park keeps its hint for the next tick.
    const hint = resuming ? undefined : record.boardingHint;

    /* ---- arrived from the queue into a run that stopped wanting it ----
     * The wait inside `admit()` can be minutes. A halt from another lane, an
     * armed pause or a stop during it must abandon this phase on arrival —
     * before the lock read, the boot prompt and the spawn — with the record
     * restored so the phase stays startable. */
    const blockedOnArrival = this.boardingBlocked();
    if (blockedOnArrival) {
      if (record.status === 'queued') record.status = 'pending';
      this.record('phase.not-started', {
        reason: notStartedReason(blockedOnArrival, 'while this phase waited for its scope'),
      }, phase);
      return true;
    }

    // Settled while it waited — a per-phase stop or a skip landed during the
    // queue. The guard above only asks about run-level blocks, so a phase
    // skipped or stopped in the queue still spawned a session for work nobody
    // wanted. The record keeps the status the settling verb gave it.
    if (SETTLED.includes(record.status)) {
      this.record('phase.not-started', {
        reason: `this phase was settled (${record.status}) while it waited for its scope`,
      }, phase);
      return true;
    }

    /* ---- a park that is ending: is it still inside its allowance? ----
     * The budget is evaluated at RESUME too, through the same `evaluateWait`
     * the park used (WAI-4). A declared park whose parked time ran past the
     * budget — a console outage counts, it is time the phase spent parked —
     * halts here, before the lock and the prompt, instead of boarding a session
     * onto a clock hours stale: the measured case resumed 9.7 h late with
     * 11.76 h of an 8 h budget spent, and produced nothing. */
    const budget = await this.waitBudgetOf(phase);
    const resumeAt = Date.now();
    const parked = resuming
      ? evaluateWait({
        purpose: 'resume', now: resumeAt, parkedMs: parkedMsOf(record, resumeAt), waits: record.waits ?? 0, budget,
        ledger: record.declared?.by === 'watchdog' ? 'watchdog' : 'session',
      })
      : null;
    if (parked?.verdict === 'timeout') {
      record.status = 'failed';
      record.note = record.parkReason ?? record.note;
      record.parkedUntil = undefined;
      syncWaitClock(state);
      this.clearParkPoke(phase);
      const timedOut = consumeDeclaration(record, 'new-outcome');
      if (timedOut) this.record(DECLARATION_CONSUMED_EVENT, { ...timedOut, next: 'waiting-external-timeout' }, phase);
      endLockWait(record);
      state.consecutiveFailures++;
      this.halt(`phase ${phase} was not resumed — ${parked.reason}`, phase, 'waiting-external-timeout');
      return true;
    }

    /* ---- lock ----
     * Checked, not claimed. The boot prompt already tells the session to claim
     * its own phase, and a lock the runner took first is a lock the session
     * reads as a stranger's — it then refuses to touch the phase, exactly as
     * the skill's concurrency guardrail says it should, and the supervisor
     * deadlocks against its own worker. Seen in a real run twice.
     *
     * So the entity doing the work holds the lock. The runner only looks, so it
     * can park rather than start a session that would immediately stop.
     *
     * A LAPSED lease is not a holder. `phase-lock.sh status` prints `held by X`
     * for an expired claim too and appends `(EXPIRED — free to take over)`;
     * this used to read only the first half, so a session that died without
     * releasing parked every attempt at its phase — for the thirty minutes of
     * the lease, and then forever after, since nothing renews a dead claim. The
     * script is still the one deciding what a claim means; we just read the
     * whole sentence it wrote.
     *
     * **KNOWN TOCTOU, deliberately open.** This read and the spawn below are
     * not atomic, and they cannot be made so here: the CHILD claims the lock,
     * by design (see the paragraph above — a lock the runner took first is one
     * its own session refuses to touch). So between `status` answering "free"
     * and the child running `claim`, a foreign session can claim the phase, and
     * both proceed believing they hold it.
     *
     * Not closed in this phase, and the reasons are worth writing down rather
     * than rediscovering:
     *   - Closing it means the runner claiming and HANDING the claim to the
     *     child — a different ownership model for the lock, touching
     *     `phase-lock.sh`, the boot prompt and the skill's concurrency
     *     guardrail together. That is a design change, not a defect fix.
     *   - The window is small (one process spawn) and the consequence is
     *     bounded: two sessions on one phase, which the LOSER detects on its own
     *     `claim` — `phase-lock.sh claim` refuses a phase already held, and the
     *     boot prompt orders the session to stop and declare `blocked`.
     *   - Three independent narrowings already sit in front of it: the
     *     scheduler's admission (one lane per scope), the presence check above,
     *     and this belt-check itself. It is the residue after all three, not a
     *     bare race.
     * Anything that changes lock ownership should close it; until then it is a
     * known, named gap rather than an unexamined one. */
    const owner = autopilotOwner(state.id);
    const status = await this.script('phase-lock.sh', [state.slug, 'status', String(phase)]);
    const expired = status.stdout.includes('EXPIRED');
    let holder = expired ? undefined : lockStatusHolder(status.stdout);
    const heldSession = /\[session: ([A-Za-z0-9._-]+)\]/.exec(status.stdout)?.[1];
    if (holder && holder !== owner && heldSession
      && this.deps.lockPresence?.({ slug: state.slug, phase, owner: holder, session: heldSession }) === 'ended') {
      // Presence beats the lease (Phase 5): the holder's session has ended —
      // the registry saw its SessionEnd, or its process is gone — so the claim
      // is debris, released AS the holder (the runner's own release, `--git`
      // never passed), journalled, and boarding goes on. The scheduler reached
      // the same verdict one layer up (`SchedulerDeps.presence`); this is the
      // belt-check's half of it, for the lock file the session itself reads.
      const released = await this.script('phase-lock.sh', [state.slug, 'release', String(phase), '--owner', holder]);
      this.record('phase.lock-debris-released', {
        holder, session: heldSession, ok: released.code === 0, by: 'boarding',
        detail: (released.stdout + released.stderr).trim().slice(0, 160),
      }, phase);
      if (released.code === 0) holder = undefined;
    }
    if (holder && holder !== owner) {
      /* This used to park — TERMINALLY, since `parked` is settled — so a phase
       * a person was working by hand never boarded again for the life of the
       * run (observed live). The scheduler now treats a foreign same-phase
       * lock as an ordinary holder, so the right disposition is back to the
       * queue: admission waits on the lock with the holder named, wakes on
       * the docs watcher, the lease timer, and the idle poll — and this check
       * shrinks to what it always really was, the race window between grant
       * and spawn. Bounded: past the cap, the park returns, honestly worded. */
      // Without a scheduler there is no queue to wait in, so the historical
      // terminal park is the only honest disposition (harness configurations
      // only — the console always wires one).
      if (!this.deps.scheduler) {
        setPhaseState(record, 'parked', { kind: 'scope-cap' });
        record.note = `phase ${phase} is locked by ${holder} — ${status.stdout.trim().slice(0, 160)}`;
        this.record('phase.lock-refused', { holder, detail: record.note }, phase);
        return true;
      }
      /* Guard-independent since D1, and this is the belt-check's half of the
       * rule `Scheduler.blocking` now applies one layer up. Every lock this
       * check can possibly see is a lock on THIS phase — the script was asked
       * about this slug and this phase — so a foreign holder here is always
       * two actors on one unit of work, which is not something a scope policy
       * gets to license. It used to journal `phase.lock-ignored` and walk
       * straight past: a phase somebody was working by hand got a second
       * session spawned into the same checkout, on the same phase, writing the
       * same handoff. The guard's real purpose (disjoint-scope contention
       * between DIFFERENT work) is untouched — that decision is made in the
       * scheduler, over holders this check never reads. */
      {
        // The belt-check's half of `isCappableBlocker`: a lock whose session the
        // registry reports LIVE is a person (or another console) working right
        // now, and their lease is not a deadline for them. Only a claim nobody
        // is behind may be capped into a park. (The `ended` case never gets
        // here — it is released as debris above.)
        const holderIsLive = !!heldSession
          && this.deps.lockPresence?.({ slug: state.slug, phase, owner: holder, session: heldSession }) === 'live';
        record.lockWaitSince ??= new Date().toISOString();
        const waitedMs = Date.now() - Date.parse(record.lockWaitSince);
        if (waitedMs > LOCK_WAIT_CAP_MS && !holderIsLive) {
          // The reason is STATED, not left to be re-derived. `lockWaitSince` is
          // cleared a few lines below — the clock stops with the wait — so by
          // the time anything reads this record the only evidence that it is a
          // scope park has been erased, and the fold answers "parked, reason
          // unknown", which paints `needs-you`. That is the wrong half of the
          // one paint change 3.5.0 makes: nobody is being asked for anything
          // here, the lock is somebody else's and it will free on its own.
          setPhaseState(record, 'parked', { kind: 'scope-cap' });
          record.note = `phase ${phase} is locked by ${holder} and has waited `
            + `${Math.round(waitedMs / 60_000)} minutes for it — ${status.stdout.trim().slice(0, 160)}`;
          // `kind: 'lock'` explicitly — admission's twin says which sort of
          // holder capped it (D2 made that ambiguous), and a reader that has to
          // infer the field's absence as 'lock' is a reader that will get it
          // wrong the first time a third path writes this event.
          this.record('phase.lock-wait-capped', { holder, waitedMs, kind: 'lock' }, phase);
          this.emit('phase', { phase, status: 'parked', note: record.note });
          // The clock stops with the wait. It used to survive the park — it is
          // only cleared after a SUCCESSFUL claim, below — so the next Retry
          // measured from the original timestamp, found itself still over the
          // cap, and parked again without waiting a second. Retry now means the
          // two hours start over, which is the only thing it could sensibly mean.
          record.lockWaitSince = undefined;
          return true;
        }
        record.status = 'queued';
        record.note = `queued behind ${holder} — ${status.stdout.trim().slice(0, 160)}`;
        // Back off, doubling to a half-minute cap: the store's watcher-debounced
        // lock view can lag what the script just read off disk, and at a flat
        // one-second floor this re-boarded at ~1 Hz (three bash subprocesses a
        // second, measured) until the store caught up. The scheduler owns the
        // real wait — and reads this very phase's lock file live on every scan
        // (`SchedulerDeps.liveLock`), so in the console this window is one
        // refusal wide; the backoff bounds a harness or a console without it.
        const backoffMs = Math.min(LOCK_BACKOFF_MAX_MS, (record.lockBackoffMs ?? 0) * 2 || 1_000);
        record.lockBackoffMs = backoffMs;
        this.record('phase.lock-race', { holder, detail: record.note, backoffMs }, phase);
        this.emit('phase', { phase, status: 'queued', note: record.note });
        await this.sleep(backoffMs);
        return true;
      }
    }
    /* ---- the peer belt-check (REG-3) ----
     * The lock answers "has somebody claimed this phase". A session that has
     * started and not claimed yet — the first minute of every hand session,
     * exactly when two sessions collide — holds no lock, and admission read the
     * registry for it a moment ago; this asks again for the grant→spawn window.
     * A peer queues the phase, NAMED (session, pid, cwd), with the lock race's
     * backoff: it never parks it, never force-releases anything, and the
     * scheduler owns the wait. */
    if (this.deps.scheduler && this.deps.peers) {
      let peers: readonly SessionPeerView[] = [];
      // This run's own sessions are already left out by their `autopilot/<runId>`
      // owner; a session of this phase started by anyone else — a hand
      // `claude --resume` of the same id included — is exactly a peer.
      try { peers = this.deps.peers(state.slug, phase, [record.sessionId]); } catch { peers = []; }
      const peer = peers.find((p) => p.presence === 'live') ?? peers[0];
      if (peer) {
        record.status = 'queued';
        record.note = `queued behind a Claude session in this repository that holds no lock — `
          + `${peer.sessionId.slice(0, 8)}${peer.pid ? ` (pid ${peer.pid})` : ''} in ${peer.cwd}`;
        const backoffMs = Math.min(LOCK_BACKOFF_MAX_MS, (record.lockBackoffMs ?? 0) * 2 || 1_000);
        record.lockBackoffMs = backoffMs;
        this.record('phase.peer-race', {
          session: peer.sessionId, pid: peer.pid, cwd: peer.cwd, owner: peer.owner, presence: peer.presence,
          scope: formatScope([...peer.scope]), backoffMs,
        }, phase);
        this.emit('phase', { phase, status: 'queued', note: record.note });
        await this.sleep(backoffMs);
        return true;
      }
    }
    record.lockWaitSince = undefined;
    delete record.lockBackoffMs;
    // The child holds the lock; the supervisor keeps its lease alive. A live
    // 47-minute session must never silently lose its 30-minute claim mid-work.
    this.armLeaseTimer(lane, owner);

    /* ---- verification preflight ----
     * Before the prompt and the spawn: only "nothing would run at all" parks;
     * everything else is a journal warning. See `preflightVerification`. */
    const unrunnable = await this.preflightVerification(phase);
    if (unrunnable) {
      record.status = 'parked';
      record.note = unrunnable;
      this.record('phase.verify-preflight-parked', { reason: unrunnable }, phase);
      this.emit('phase', { phase, status: 'parked', note: unrunnable });
      return true;
    }

    /* ---- MCP preflight ----
     * Same place and same reasoning as the verification preflight: before the
     * prompt and before the spawn, because a phase whose GitHub server was
     * never signed in will otherwise spend an hour discovering that, and the
     * session cannot fix it — there is no `/mcp` panel in `-p`, and the CLI
     * says so to the model rather than to anyone who could act.
     *
     * What CHANGED is the verdict, not the timing. `require` still parks here.
     * `continue` — the default — boards without the servers it could not reach
     * and tells the session exactly which, because the alternative turned out
     * to be worse than the problem: a run whose ready phases all park has
     * nothing left to do, so one signed-out server halted an eleven-phase plan
     * that named no MCP servers at all.
     *
     * Resolved ONCE and carried to the spawn: the set that was probed has to be
     * the set that is passed, or the preflight answered about something else. */
    const chosenOptions = this.optionsFor(phase);
    const mcp = await this.resolveMcp(phase, chosenOptions);
    if (mcp.park) {
      record.status = 'parked';
      record.note = mcp.park;
      // The park's clock starts here: past `mcpRequireTimeoutMs` the phase
      // continues without these servers (`continueMcpPark`), with the errand.
      record.mcpPark = { at: new Date().toISOString(), degraded: mcp.degraded };
      const timeoutMs = this.deps.mcpRequireTimeoutMs?.() ?? DEFAULT_MCP_REQUIRE_TIMEOUT_MS;
      this.record('phase.mcp-preflight-parked', {
        reason: mcp.park, servers: mcp.degraded.map((row) => row.id), timeoutMs,
      }, phase);
      this.emit('phase', { phase, status: 'parked', note: mcp.park, mcpPark: record.mcpPark, timeoutMs });
      return true;
    }
    if (mcp.degraded.length) {
      record.mcpDegraded = mcp.degraded;
      const summary = mcp.degraded
        .map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`)
        .join(', ');
      this.record('phase.mcp-degraded', { degraded: mcp.degraded, attached: mcp.usable }, phase);
      this.emit('phase', { phase, mcpDegraded: mcp.degraded });
      this.deps.onMcpDegraded?.(state, phase, mcp.degraded);
      log.warn('runner.mcp-degraded', { slug: state.slug, phase, summary });
    } else {
      delete record.mcpDegraded;
    }

    /* ---- credential preflight ----
     * Same place, same reasoning (phase 11, ZTD-4): the credentials the plan
     * names for this phase are asked about by id before the spawn — the
     * operator's own plan spent three phases discovering, one at a time, that
     * three service accounts did not exist. `require` parks here with the
     * class's errand and spends nothing; `continue` boards and tells the
     * session which are missing, and the run's manifest row reads
     * `outstanding` so the run page says so too. Never a value, only a name. */
    const missingCredentials = await this.preflightCredentials(phase);
    if (missingCredentials?.park) {
      record.status = 'parked';
      record.note = missingCredentials.park;
      this.emit('phase', { phase, status: 'parked', note: missingCredentials.park });
      return true;
    }

    /* ---- prompt ---- */
    // `PE_GATE_DELEGATE` swaps the human-gate block for the delegated brief:
    // verify each condition against evidence you can cite, record the clearance,
    // or STOP naming the condition you could not verify. Passed only when the
    // operator asked for it — the default prompt still says a person must clear
    // the gate, because by default one must.
    const engineText = readText(await this.engine(
      ['--boot-prompt', String(phase)],
      this.gatesPolicy().answer === 'delegated' ? { PE_GATE_DELEGATE: '1' } : undefined,
    ));
    if (!engineText.trim()) {
      await this.release(phase, owner);
      this.halt(`the engine produced no boot prompt for phase ${phase}`, phase, 'plan-unreadable');
      return false;
    }
    // Appended, never woven in: `phase-graph.sh` stays the only thing that
    // decides what a boot prompt says about the plan — including the plan's own
    // skills line. This is the operator adding to it for one run.
    // `skillsOff` drops the RUN's list for this phase and keeps the phase's own:
    // "not the default here" and "nothing at all here" are different asks, and a
    // phase that names a skill has clearly asked for that one.
    // The RESOLVED options, not the raw `state.phaseOptions` row this used to
    // read: since Retry-with-edits there are two per-phase levels, and reading
    // the stored one directly meant an attempt override could change the model
    // (which goes through `optionsFor`) but not the skills or the MCP servers
    // (which did not) — a settings dialog that honoured half of itself.
    const own = chosenOptions;
    const extraSkills = own.skillsOff
      ? [...(own.skills ?? [])]
      : [...(state.skills ?? []), ...(own.skills ?? [])];
    // A retry used to get the SAME prompt as the first attempt, because the
    // engine's boot prompt describes the job and the job did not change. So a
    // second session opened knowing everything about what to do and nothing
    // about the eleven failures the first one left behind — and re-derived them
    // by running the suite again, or did not, and wrote the same code twice.
    //
    // Between the engine's text and the skill directive, so the plan still
    // speaks first and the directive still has the last word.
    const context = this.retryContext(record);
    // The git strategy sits between the failure context and the directive: the
    // plan still speaks first, the operator's branch rule is stated before the
    // work begins, and the skill directive keeps the last word.
    const git = await this.gitStrategy(phase, board);
    // The MCP directive names only what the CONSOLE added: the engine's own text
    // already names what the plan asked for, and repeating it would read as two
    // authorities saying the same thing slightly differently.
    //
    // The degraded ids are subtracted, because the directive's first sentence
    // says the servers were "verified connected before it started" and that has
    // to keep being true. They come back in the directive's second half, named
    // as unavailable — which the plan's own servers need too, so `degraded` is
    // passed whole rather than filtered to the console's additions.
    const dropped = new Set(mcp.degraded.map((row) => row.id));
    const ownMcp = (own.mcpOff
      ? [...(own.mcpServers ?? [])]
      : [...(state.mcpServers ?? []), ...(own.mcpServers ?? [])]).filter((id) => !dropped.has(id));
    // A wait-resume replaces the engine's boot text — the session already has
    // the whole boot context; what it needs is the elapsed-window instruction.
    // Everything appended after (git strategy, directives) applies to both.
    // A ladder hint picks one of the five briefs instead (`composeBrief`):
    // `fresh` is the engine text alone, `resume`/`unblock` append a brief to
    // it, `continue`/`closeout` resume the phase's own session and carry no
    // engine text — the session has it — unless that session cannot be
    // resumed, in which case they degrade to the self-contained `resume`.
    const requestedAt = record.declared?.requested ? Date.parse(record.declared.requested) : NaN;
    const clockAt = record.parkedUntil ? Date.parse(record.parkedUntil) : NaN;
    const waitCause = record.declared?.by === 'watchdog'
      ? 'watchdog' as const
      : Number.isFinite(requestedAt) && Number.isFinite(clockAt) && requestedAt > clockAt
        ? 'budget-elapsed' as const
        : 'declared-window' as const;
    const lateMs = Number.isFinite(clockAt) ? Math.max(0, resumeAt - clockAt) : 0;
    let base = resuming && parked
      ? waitResumePrompt({
        scriptsDir: this.deps.scriptsDir, slug: state.slug, phase, reason: record.parkReason, watch: record.watch,
        cause: waitCause, lateMs,
        externalLeftMs: Number.isFinite(requestedAt) && requestedAt > resumeAt ? requestedAt - resumeAt : null,
        budgetMs: parked.budgetMs, budgetRemainingMs: parked.budgetRemainingMs, budgetSource: parked.budgetSource,
      })
      : engineText;
    let failureInsert = context;
    let resumeId: string | undefined;
    let cappedTurns: number | undefined;
    if (hint) {
      const composed = await this.composeBrief(phase, board, hint, engineText);
      base = composed.prompt;
      resumeId = composed.resume;
      cappedTurns = composed.maxTurns;
      // The briefs carry the failure evidence themselves; a second copy of it
      // after them would be the same log quoted twice.
      failureInsert = '';
      this.record('phase.brief', {
        brief: composed.brief, asked: hint.brief, situation: hint.situation, rung: hint.rung,
        resume: resumeId ?? null, bytes: Buffer.byteLength(composed.prompt),
        ...(composed.degraded ? { degraded: composed.degraded } : {}),
      }, phase);
    }
    // The operator's words for THIS attempt, after the failure evidence and
    // before the git strategy: they are almost always a reaction to that
    // evidence ("the suite is fine, the fixture is stale — fix the fixture"),
    // so they read as a reply to it, and the directives still have the last
    // word. Carried on a `resume`/`continue` brief too, which is the case that
    // matters most: a session being resumed is the one already going wrong.
    const addendum = record.retryOverride?.addendum?.trim();
    // The ultracode licence rides with the other directives, and it rides HERE
    // and nowhere else in this runner. Every prompt this line reaches is the
    // phase's own work — the fresh boot and all five briefs, since a brief
    // replaces `base` and the directives are still appended. The bounded
    // sessions the console spawns beside a phase (the auto reviewer, the QA
    // verdict, the closeout, the PR and merge-queue sessions) each compose
    // their own prompt and get no licence to fan out, which is the point: they
    // are asked for one artefact and given the budget for one.
    const prompt = base + (failureInsert ? `\n\n${failureInsert}\n` : '')
      + (addendum ? `\n\n${retryAddendumBlock(addendum)}\n` : '') + git
      + skillDirective(extraSkills) + mcpDirective(ownMcp, mcp.degraded)
      + credentialsDirective(record.credentialsMissing ?? [])
      + ultracodeDirective(ultracodeOn(state, own))
      + unattendedDirective(this.deps.scriptsDir, state.slug, phase, { budgetMs: budget.budgetMs, source: budget.source });
    if (failureInsert) this.record('phase.retry-context', { bytes: Buffer.byteLength(failureInsert) }, phase);
    if (extraSkills.length) this.record('phase.skills', { skills: [...new Set(extraSkills)] }, phase);

    /* ---- the last chance to not start ----
     * The gate check, the lock check and the boot prompt are three subprocesses
     * — seconds, sometimes more. A pause armed during them used to be read only
     * after the session had already been spawned, which is the same defect as
     * the one at the top of `drive` and needs the same answer in the one place
     * that can still act on it: immediately before the phase is marked running.
     * `true` because the run carries on to the loop top, which owns every piece
     * of pause bookkeeping and will stop there. */
    const blockedBeforeStart = this.boardingBlocked();
    if (blockedBeforeStart) {
      await this.release(phase, owner);
      this.record('phase.not-started', {
        reason: notStartedReason(blockedBeforeStart, 'before it started'),
      }, phase);
      return true;
    }

    /* ---- what this phase runs as ---- */
    const chosen = this.optionsFor(phase);

    /* ---- the account door, asked at every boarding (RCV-1's admission half) ----
     * The breaker is machine-wide and moves between boardings: a credential
     * refused under another run of this console — or under another console —
     * is retired for its organisation, and a phase this run had queued before
     * the refusal must not board on it. The run's own preflight asked once, at
     * start; this asks at the door, and reads ONE word. `retired` IS the
     * credential wall, so the run halts on it exactly as the classifier's arm
     * would have, without a session spent finding out. Every other verdict (a
     * spent window, a wall) stays the preflight's and the live wall's. */
    const door = this.deps.accountHeadroom?.(state.accountId, record.model ?? chosen.model);
    if (door && !door.ok && door.kind === 'retired') {
      await this.release(phase, owner);
      const paying = state.accountId ?? 'the machine login';
      this.record('run.admission-refused', {
        phase, reason: 'account-retired', account: paying, detail: door.reason,
      }, phase);
      record.status = 'parked';
      record.note = `${door.reason} (account: ${paying})`;
      // The cause on the record, as the classifier's arm stamps it: the wall
      // is the same, and a Continue past it re-boards this phase by the cause.
      record.cause = {
        kind: 'credential-refused', reason: door.reason, at: new Date().toISOString(),
        ...(state.accountId ? { account: state.accountId } : {}),
      };
      this.halt(record.note, phase, 'credential-refused');
      return true;
    }
    if (wasWaiting) {
      // The park is over: close it on its own stamps (so `parkedMsOf` measures
      // the time it actually held — the console may have been down past
      // `parkedUntil`), and clear the clock so a crash mid-resume re-parks
      // cleanly rather than double-firing. The session to resume was named at
      // park time; a record that named none gets its own session — but never
      // one already stamped gone, which `??=` used to re-arm (SLF-10). A park
      // with NO declaration (the console's retry-storm park, a record from
      // before declarations) still resumes its session; only the prompt, the
      // budget and the turn cap belong to a declared wait.
      const endedAt = new Date().toISOString();
      closeWaitEntry(record, endedAt);
      record.parkedMs = parkedMsOf(record, Date.parse(endedAt));
      if (!record.resumeSessionId && record.sessionId) {
        if (isSessionGone(record, record.sessionId)) this.noteGoneResume(record, record.sessionId);
        else record.resumeSessionId = record.sessionId;
      }
      record.parkedUntil = undefined;
      // The run's clock follows the waiters that remain (WAI-6).
      syncWaitClock(state);
      this.clearParkPoke(phase);
      const declarer = record.sessionId ? this.deps.sessionPresence?.(record.sessionId) : undefined;
      this.record('phase.wait-resume', {
        waits: record.waits ?? 0, parkedMs: record.parkedMs, lateMs,
        cause: resuming ? waitCause : 'console-park',
        ...(resuming && parked ? {
          budgetMs: parked.budgetMs, budgetSource: parked.budgetSource, budgetRemainingMs: parked.budgetRemainingMs,
          capSource: WAIT_RESUME_TURNS.source,
          ...(parked.extendedBy ? { extendedBy: parked.extendedBy } : {}),
        } : {}),
        ...(record.declared?.by === 'watchdog' ? { watchdogParks: record.watchdogParks ?? 0 } : {}),
        sessionId: record.sessionId ?? null,
        // Whose declaration this resume answers, and whether that session is
        // still around — an ended author is recorded, never silently resumed
        // over (SHD-6).
        declaredBy: { by: record.declared?.by ?? (resuming ? 'session' : null), presence: declarer?.presence ?? 'unknown' },
      }, phase);
    }
    record.status = 'running';
    // The previous attempt's ending IS retired here — unlike the declaration
    // below, a halt is the console's own account of a stop that this boarding
    // supersedes, and nothing downstream wants it once a session is running
    // again. (`resetForRetry` covers the operator's Retry; this covers every
    // re-board the ladder makes without one.)
    retirePhaseHalt(record);
    // …and so are the wall and the denial it last stopped on: the door above
    // just proved the account can board, and a denial belongs to the attempt
    // it happened in (phase 9). `prepareReboard` deliberately keeps both, so a
    // console re-board that never reaches a spawn carries them forward.
    delete record.cause;
    delete record.toolDenied;
    // The last declaration is NOT deleted here. It used to be — "a new attempt
    // consumes it" — and the delete ran before the spawn, so a boarding that
    // queued, capped or failed to start threw away the session's own testimony
    // about why it stopped (R1). It is spent by the session PRODUCING something
    // instead (`consumeDeclaration(record, 'session-productive')` in
    // `onStream`), which is the first moment the claim "it is running again"
    // is true rather than hoped for.
    // `startedAt` is the PHASE's first start — the commit window `producedWork`
    // measures from, which a second boarding must not move forward past the
    // first attempt's commits. `attemptStartedAt` is THIS boarding's, and is
    // what the outcome file's staleness guard compares against.
    const boardedAt = new Date().toISOString();
    record.startedAt ??= boardedAt;
    record.attemptStartedAt = boardedAt;
    // The hint is spent: the session it asked for is about to exist.
    if (hint) delete record.boardingHint;
    // …and so is the retry override, for the same reason and at the same
    // moment. Journalled first, verbatim: the record is about to lose it, and
    // "why did phase 7 run on Opus that once" has to stay answerable from the
    // journal alone. `options` is recorded as chosen, not as resolved — what
    // the operator asked for is the interesting half; what it resolved to is
    // already in `phase.start`'s `source`.
    if (record.retryOverride) {
      const override = record.retryOverride;
      this.record('phase.retry-override', {
        ...(override.addendum ? { addendum: override.addendum } : {}),
        ...(override.options && Object.keys(override.options).length ? { options: override.options } : {}),
        by: override.by ?? null,
        at: override.at,
      }, phase);
      delete record.retryOverride;
    }
    if (resumeId) record.resumeSessionId = resumeId;
    // The phase is now genuinely starting: the active-phase pointer follows
    // the lane table (the mirror rule), written here and nowhere earlier.
    this.syncMirror();
    record.model = record.model ?? chosen.model;
    record.effort = record.effort ?? chosen.effort;
    if (hint?.escalate === 'model') {
      const stronger = escalateModel(record.model);
      if (stronger && stronger !== record.model) {
        this.record('phase.model-escalated', { from: record.model, to: stronger, rung: hint.rung }, phase);
        record.model = stronger;
      }
    }
    this.record('phase.start', {
      model: record.model, effort: record.effort ?? null,
      // Where each choice came from, so a phase that ran on an unexpected model
      // can be explained without re-reading three files.
      source: chosen.source,
      ...(chosen.tools?.length ? { tools: chosen.tools } : {}),
      ...(chosen.permissionMode ? { permissionMode: chosen.permissionMode } : {}),
      title: board.states[phase],
      ...(hint ? { brief: hint.brief, situation: hint.situation, rung: hint.rung } : {}),
      ...(resuming ? { waitResume: true, waitCause } : {}),
    }, phase);
    this.emit('phase', { phase, status: 'running', model: record.model, effort: record.effort });

    /* ---- the session, with the error policy driving retries ---- */
    const settled = await this.attempt(phase, prompt, record.model!, owner, lane, chosen, {
      // A wait-resume is a continuation, not the phase: capped like a closeout
      // so a session that misreads the ask and starts new work runs out. A
      // `closeout` brief is capped the same way, for the same reason; a
      // `continue` is the phase itself and is not.
      ...(resuming ? { maxTurns: WAIT_RESUME_TURNS } : cappedTurns ? { maxTurns: closeoutBriefTurns(cappedTurns) } : {}),
      mcp,
    });
    if (!settled.carryOn) { await this.release(phase, owner); return false; }
    if (!settled.completed) { await this.release(phase, owner); return true; }

    /* ---- independent verification ----
     * The lock is held across this, and released after. It used to be released
     * first, which meant a phase sitting in `awaiting-verification` — up to
     * twelve hours — was unlocked and read `ready` to every other session that
     * looked. Closeout needs it held too: it resumes the session that owns it. */
    try {
      // `confirmed()` answers "is this phase DONE". This function's boolean is
      // the lane's `carryOn` — a different question, and conflating them is what
      // made the halt-kind split cosmetic: a phase-level ending left `state.halt`
      // empty (so no sibling was drained with `phase.not-started`) and then
      // stopped the loop anyway, so the queued sibling the split exists to
      // protect still never boarded.
      //
      // A RUN-level halt stops the loop, exactly as it always did. A phase-level
      // ending obeys the same rule a plain phase failure does — the run's
      // autonomy: `keep-going` moves on to the other candidates (the settled
      // record is not one of them), `halt-on-everything` stops, which is what
      // asking for it means. A plan that keeps failing still halts on the
      // streak, run-level, one phase later.
      if (await this.confirmed(phase)) return true;
      return !this.state!.halt && this.state!.autonomy === 'keep-going';
    } finally {
      await this.release(phase, owner);
    }
  }

  /**
   * What the previous attempt(s) at this phase left behind, as prompt text.
   *
   * One method rather than two call sites building it, because the retry path
   * and the resume path must tell the session the same story — they differ in
   * what surrounds the context, never in the context itself.
   *
   * `halt` is passed in rather than read off the run, because by the time any
   * of this is assembled `state.halt` is always null: `retry()`, `recover()` and
   * a resumed `start()` all clear the banner first, deliberately — a run being
   * worked on must not go on looking stopped. The caller that still has the
   * reason hands it over; the callers that never had one pass nothing. Whoever
   * passes it must have checked it belongs to THIS phase: a stop recorded
   * against phase 3 would open phase 5's session with an authoritative account
   * of a failure in code it is not about to touch.
   */
  protected retryContext(record: PhaseRecord, halt?: string | null): string {
    // Nothing has run yet: no attempt, no verdict, no closing words. There is
    // no story to tell and a header promising one would be a lie.
    if (!(record.attempts > 0 || record.verification || record.said)) return '';
    return failureContext(record, halt);
  }

  /** Journalled once per run: the plan and the console disagree about branches. */
  /**
   * A worktree refusal is journalled ONCE per run, not once per phase. The
   * reason it refused — no run branch, submodules, not a repo — is a property
   * of the run, so repeating it every boarding would be noise pretending to be
   * news.
   */
  private worktreeRefusalNoted = false;

  /** Phases that got a worktree this run, so the prune at run end knows which. */
  private worktreePhases = new Set<number>();

  /**
   * The previous drive's worktree sweep, while it is still running.
   *
   * The sweep is fire-and-forget on purpose (the loop's `finally` is not a
   * place to await minutes of git), and that is fine for everything except the
   * NEXT drive of the same plan: `Service.runnerFor` pools one Runner per plan
   * for the console's lifetime, so a Continue pressed while the sweep is still
   * deleting directories reaches `ensureRunCheckout` mid-removal — and a
   * checkout adopted there is a session spawned into a cwd that stops existing
   * a moment later. That is the same ending `ensureIntegration`'s refusal
   * branch was fixed for, reached by timing instead of by a wrong word.
   */
  private prunePending: Promise<void> | null = null;

  /**
   * This run is between "the cap said yes" and "the checkout exists".
   *
   * The cap counts runs whose `checkout` reads `worktree`, and that word is not
   * written until the tree is made, prepared and journalled — minutes later, in
   * the worst case, because an operator's setup command sits in the middle.
   * Without this flag two runs starting together both read the pre-count and
   * both passed a cap of one, which is how a "maximum three checkouts" setting
   * comes to be a suggestion. `Service.isolatedCheckouts` reads it through
   * `holdsIsolatedCheckout()`.
   */
  protected reservingCheckout = false;

  /**
   * `<runId>:<refusal>` of the last refusal this run OVERRODE by keeping the
   * checkout it already had — so the line is journalled once per decision
   * rather than once per drive, the rule every other line in the preamble
   * follows.
   */
  private keptRefusalFor?: string;

  /**
   * The hand-made worktrees this run has already reported, joined.
   *
   * Same rule as `keptRefusalFor`: the sweep runs on every drive and the set of
   * trees an operator made by hand does not change between them, so an
   * unconditional line is one an operator learns to scroll past.
   */
  private unmanagedNoted?: string;


  private branchMismatchNoted = false;

  /** Whether any phase of this run was handed the PR block. See `run.pr-pending`. */
  private prBlockEmitted = false;

  /** The phase this loop most recently verified green — the last leaf, when the plan ends. */
  protected lastDonePhase: number | null = null;

  /**
   * What happens to the work branch now that every phase of the plan is done.
   *
   * Four strategies, one door (`shared/worktree-model.js` owns the words):
   *
   *  - `pr` — the behaviour every new-branch run has always had: the last leaf's
   *    own session is asked to push and open the pull request, and when none can
   *    be resumed the run ends saying the branch awaits one.
   *  - `keep` — nothing. The branch and its checkout stay exactly where they
   *    are, for a person who wants to look before anything moves.
   *  - `integration` — the console merges the branch into its own staging tree
   *    (`pe/integration`) and stops. No remote is touched at all, which is why
   *    this one runs INSIDE the console rather than in a session: merge verbs
   *    in `worktree.ts` are the console's one repository-mutating exemption,
   *    and a conflict aborts with every commit intact.
   *  - `merge-queue` — a session is boarded to rebase the branch on whatever
   *    landed while this run drove, re-run the plan's end-to-end verification,
   *    and push only if that passes. The console never rebases a branch itself;
   *    a rebase rewrites history, which is precisely the class of act the push
   *    wall exists to keep out of this process.
   *
   * Returns the run's closing sentence, or null to leave the plain one standing.
   */
  private async settleRun(): Promise<string | null> {
    const state = this.state!;
    // Stamped HERE, before any strategy runs, because the fact this records is
    // "every phase is done and the branch's fate is now being decided" — true
    // on all four paths including the ones that do nothing at all. It is what
    // lets a later drive tell a branch that was MERGED AWAY from a branch that
    // has not been created yet; to `rev-parse` those are the same missing ref.
    state.settledAt ??= new Date(this.now().getTime()).toISOString();
    const strategy = settleOf(state);
    const branch = `pe/${state.slug}`;
    // A mirror run's work lives in N repositories; the two strategies that end
    // at ONE tree — the staging merge, a single-upstream rebase — cannot
    // finish it. Refused BY NAME and degraded to keep-shaped honesty: the
    // commits are all on `pe/<slug>` in each mounted repository, and a person
    // (or the pr settle) can take them from there.
    if (state.mountedRepos?.length && SETTLE_UNSUPPORTED_MULTI.has(strategy)) {
      this.record('run.settle-unsupported', {
        strategy, branch, mounts: state.mountedRepos,
        reason: "the run holds a mirror of several repositories, and this strategy ends at one tree",
      });
      return `every phase of ${state.slug} is done. The \`${strategy}\` settle cannot span the `
        + `${state.mountedRepos.length} repositories this run's mirror mounts, so ${branch} was `
        + 'left as it stands in each of them — merge by hand, or use the pr settle.';
    }
    if (strategy === 'keep') {
      // Journalled rather than silent: "the run finished and nothing happened
      // to the branch" is a fact an operator asked for, and an unrecorded
      // no-op is indistinguishable from a settle that was never wired.
      this.record('run.settled', {
        strategy, branch,
        note: 'the branch and its checkout were left as they are',
      });
      return `every phase of ${state.slug} is done. ${branch} was left as it is — `
        + 'this run settles by keeping its branch.';
    }
    if (strategy === 'integration') return this.settleIntegration(branch);
    if (strategy === 'merge-queue') return this.settleMergeQueue(branch);

    // `pr`, and byte-for-byte what this block did before the strategies
    // existed — including the `prBlockEmitted` guard that stops a run whose
    // last phase already opened the PR from asking a second time.
    if (this.prBlockEmitted) return null;
    const prEnding = await this.openPrFromLastLeaf();
    if (prEnding) {
      // The run is finished with its branches, so its OWN `pe/<slug>` joins the
      // candidates. Ordinarily nothing happens — the pull request was opened
      // seconds ago and its commits are not on the trunk — and that is right:
      // the deletion is evidence-gated (`pruneRunBranches`), and the drive
      // sweep of the next run of this plan will take them once they land.
      // The auto-merge case, where the PR merges before this returns, is the
      // one that deletes here.
      await this.pruneRunBranches(state, { includeOwn: true });
      return prEnding;
    }
    this.record('run.pr-pending', { branch });
    return `every phase of ${state.slug} is done. The work branch `
      + `${branch} still awaits its PR — no phase ran as the plan's last and no `
      + 'session could be resumed to open it, so push it and open one by hand, or re-run the final phase.';
  }

  /**
   * Merge the finished run branch into the console's staging tree.
   *
   * Every ending here is journalled with the same `run.settled` event, because
   * the four outcomes — merged, nothing to merge, conflicted, failed — are all
   * things the operator has to be able to find later, and three of them leave
   * the branch needing a person. A conflict does NOT halt the run: every phase
   * is done, the commits are all on `pe/<slug>`, and nothing was lost — what is
   * owed is a person merging by hand, which is an errand and not a failure.
   */
  private async settleIntegration(branch: string): Promise<string | null> {
    const state = this.state!;
    const staging = await this.stagingFor();
    let result: LandResult;
    try {
      result = await landIntegration(state.root, { branch, staging });
    } catch (error) {
      result = { kind: 'failed', detail: (error as Error)?.message ?? String(error) };
    }
    this.record('run.settled', { strategy: 'integration', branch, into: staging.branch, ...result });
    const head = `every phase of ${state.slug} is done.`;
    if (result.kind === 'merged') {
      return `${head} ${branch} was merged into ${staging.branch}`
        + `${result.fastForward ? ' (fast-forward)' : ''} — ${result.commits} commit`
        + `${result.commits === 1 ? '' : 's'}. Nothing was pushed; the staging checkout is at ${staging.dir}.`;
    }
    if (result.kind === 'empty') {
      return `${head} ${staging.branch} already contains everything on ${branch}, so there was nothing to merge.`;
    }
    if (result.kind === 'conflict') {
      return `${head} ${branch} conflicts with ${staging.branch} in `
        + `${result.files.slice(0, 5).join(', ')}${result.files.length > 5 ? ` and ${result.files.length - 5} more` : ''}`
        + ` — the merge was aborted and every commit is still on ${branch}. Merge it by hand in ${staging.dir}.`;
    }
    return `${head} ${branch} could not be merged into ${staging.branch}: ${result.detail}. `
      + `Nothing was changed and every commit is still on ${branch}.`;
  }

  /**
   * Board one more session to rebase, re-verify and then push.
   *
   * The console composes the instruction and spends a session on it; it does
   * not rebase anything itself. That split is the whole design: a rebase
   * rewrites history and a push publishes, and both are on the deny wall this
   * process runs behind — so the act happens where the carve-out already
   * exists (a `claude` under `openPrCarveOut`, which `SETTLE_PUSHES` opens for
   * exactly this strategy and `pr`), with the verification standing between
   * the rebase and the push.
   */
  private async settleMergeQueue(branch: string): Promise<string | null> {
    const state = this.state!;
    if (this.prBlockEmitted) return null;
    const said = await this.settleSession(branch, mergeQueuePrompt(branch, state.slug), 'merge queue');
    if (said === null) {
      this.record('run.settle-pending', { strategy: 'merge-queue', branch });
      return `every phase of ${state.slug} is done. ${branch} is queued to merge, but no session `
        + 'could be resumed to rebase and re-verify it — do it by hand, or re-run the final phase.';
    }
    return `every phase of ${state.slug} is done. A session was asked to rebase ${branch}, re-run `
      + `the plan's verification and push it${said ? ` — it said: ${said.slice(0, 300)}` : ''}.`;
  }

  /**
   * Ask the last leaf's own session to push the work branch and open the
   * pull request — the git-strategy PR block, verbatim, as one more resumed
   * turn. Two DAG leaves finishing together is how a new-branch run used to
   * end with `run.pr-pending` and a sentence; the session that landed last
   * holds the branch, the commits and the context, and is the right one to
   * finish the job. Answers the run's ending sentence when a session was
   * spent on it (whatever it then managed — its words are journalled, the
   * branch's state lives on the remote), null when none could be resumed —
   * the honest "awaiting its PR" ending stays for that.
   */
  private async openPrFromLastLeaf(): Promise<string | null> {
    const state = this.state!;
    const branch = `pe/${state.slug}`;
    const title = this.deps.planTitle?.(state.slug) ?? state.slug;
    const mounts = state.mountedRepos ?? [];
    const prompt = `Every phase of ${state.slug} is done now, and yours was the last to land — so the pull `
      + `request falls to you. Your handoff is written; do not reopen the work.\n\n${prBlockText(branch, title)}`
      + (mounts.length
        ? `\n\nThis run worked in a MIRROR of ${mounts.length} repositories; the candidate set for `
          + `pushes and PRs is exactly: ${mounts.join(', ')} (each relative to the run root, each `
          + `checked out under ${state.workRoot ?? 'the run worktree'}). Check each for commits on `
          + `\`${branch}\`; open one PR per repository that has any.`
        : '');
    const said = await this.settleSession(branch, prompt, 'pull request');
    if (said === null) return null;
    return `every phase of ${state.slug} is done. The last phase's session was asked to push ${branch} and `
      + `open the pull request${said ? ` — it said: ${said.slice(0, 300)}` : ''}.`;
  }

  /**
   * Spend one resumed session on the settle instruction, whatever it says.
   *
   * The shared vehicle behind `pr` and `merge-queue`: find the phase that
   * landed last and still has a transcript, refuse under a fleet freeze, resume
   * it with a closeout-shaped budget, book what it spent, and answer with what
   * it said — `''` when it said nothing, and `null` when no session could be
   * spent at all. Both callers turn that into their own ending sentence, which
   * is the ONE thing that differs between them; everything above it is the same
   * spawn, and a second copy of it is a second place to forget the freeze gate,
   * the `--add-dir` for a worktree run, or the cost booking.
   */
  private async settleSession(branch: string, prompt: string, what = 'pull request'): Promise<string | null> {
    const state = this.state!;
    const done = Object.values(state.phases)
      .filter((r) => r.status === 'done' && r.sessionId)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .map((r) => r.phase);
    const candidates = [...new Set([this.lastDonePhase, ...done])].filter((p): p is number => p != null);
    const phase = candidates.find((p) => {
      const r = state.phases[String(p)];
      return Boolean(r?.sessionId) && this.transcriptFollows(r) && !isSessionGone(r, r.sessionId);
    });
    if (phase == null) return null;
    // …and not under a fleet freeze. A PR session is a `claude` that never
    // passes through `admit()`, so the scheduler's holder cannot see it.
    //
    // `null` is the shape this method already uses for "no session could be
    // resumed", and it leaves the run's own "awaiting its PR" ending standing.
    // Be exact about what that means: **nothing re-reaches this by itself.**
    // The run finishes, the branch is pushed, and opening the pull request
    // becomes an operator errand — which is the honest outcome, because the
    // only alternative is starting a `claude` under a freeze. The journal line
    // and the ending sentence are together what make the errand findable.
    const frozen = this.fleetFrozen();
    if (frozen) {
      this.record('run.pr-session-skipped', {
        reason: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''} — the ${what} did not run`,
        errand: `settle ${branch} by hand, or Continue this run once the console is thawed`,
      }, phase);
      return null;
    }
    const record = phaseRecord(state, phase);
    // The one gate every `--resume` takes. This site only asked whether the
    // transcript followed; a session still running, or one the CLI already
    // refused, was resumed for the pull request anyway (SLF-10).
    const gate = this.resumableSession(record, record.sessionId);
    if (!gate.ok) {
      this.record('run.pr-session-skipped', {
        reason: `the last phase's session ${record.sessionId} cannot be resumed (${gate.why}) — the ${what} did not run`,
        errand: `settle ${branch} by hand, or Continue this run once that session has ended`,
      }, phase);
      return null;
    }
    // The tree that phase worked in. Its lane is gone from `this.lanes` by now
    // — every phase has settled, that is what makes this the last leaf — so the
    // question has to be put to git (D7). In a worktree run the shared root is
    // on whatever branch the operator left it on, and a session told to push
    // `pe/<slug>` from there is being resumed into a checkout it has never seen.
    const prCwd = (await this.registeredLane(phase))?.dir ?? this.laneRoot(phase);
    this.record('phase.pr-session', { sessionId: record.sessionId, branch }, phase);
    this.emit('phase', { phase, prSession: true });

    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'pr', {
        prompt,
        cwd: prCwd,
        addDirs: resolve(prCwd) === resolve(state.root) ? undefined : [state.root],
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} ${what}`,
        resumeFrom: gate.resume,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          PE_OWNER: autopilotOwner(state.id),
          PE_SCOPE: formatScope(await this.scopeFor(phase)),
          PE_OUTCOME_FILE: this.outcomePath(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
        }),
        signal: this.abort?.signal,
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      }, {
        // Paperwork, like a closeout: a quarter of the phase's dollars and a
        // closeout's turns, so a confused session cannot re-open the work it
        // was asked only to publish.
        caps: capsFor({ mode: 'pr', size: await this.sizeOf(phase), phaseBudgetUsd: state.phaseBudgetUsd }),
      });
    } catch (error) {
      this.record('phase.pr-session-failed', { error: (error as Error)?.message ?? String(error) }, phase);
      return null;
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
    const said = outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200) : undefined;
    const ok = classify(outcome.signal).kind === 'ok';
    this.prBlockEmitted = true;
    this.record('phase.pr-session-done', { ok, costUsd: outcome.costUsd, turns: outcome.turns, said }, phase);
    // `''` and `null` are different answers and the callers depend on it: the
    // empty string is "a session ran and said nothing", `null` is "no session
    // ran", and only the second leaves the branch owing a person something.
    return said ?? '';
  }

  /**
   * The tools an auto reviewer gets: read the repository, and nothing else.
   *
   * The prompt already says "do not edit, do not commit, do not run the
   * build". This is the version of that sentence the session cannot decline.
   * `Bash` is absent for the reason `Edit` and `Write` are — a reviewer with a
   * shell can `git commit`, and a reviewer that changes the diff it is
   * reviewing is not a second reader, it is a second author.
   */
  protected static readonly REVIEWER_TOOLS = ['Read', 'Grep', 'Glob'] as const;

  /**
   * Review the phase that just finished, in a session that did not write it.
   *
   * Every exit here is journalled. A reviewer that was asked for and did not
   * happen is a fact an operator needs — the alternative is a run that quietly
   * stops reviewing (the surface unwired, the facts unresolvable, the spawn
   * throwing) while the setting still reads on, which is precisely how a
   * safety net becomes a belief.
   */
  protected async autoReview(phase: number): Promise<void> {
    const state = this.state;
    if (!state?.reviewEachPhase) return;
    const record = phaseRecord(state, phase);

    if (!this.deps.reviewer) {
      this.record('phase.review-session-skipped', { reason: 'no review surface is wired to this runner' }, phase);
      return;
    }
    // Before the diff is even read. A reviewer is a whole `claude` session that
    // never passes through `admit()`, so the scheduler's fleet holder cannot
    // see it — this is the gate. Skipped rather than deferred: a review is
    // advisory paperwork over a phase that is already done, and the run is
    // about to park frozen anyway; the journal says so, and Recover & continue
    // after the thaw re-reaches it.
    const frozen = this.fleetFrozen();
    if (frozen) {
      this.record('phase.review-session-skipped', {
        reason: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''} — no session is started under a freeze`,
      }, phase);
      return;
    }
    const policy: ReviewerVerdictPolicy = state.reviewerPolicy === 'may-hold' ? 'may-hold' : DEFAULT_REVIEWER_POLICY;

    let facts;
    try {
      facts = await this.deps.reviewer.facts(state.slug, phase, policy);
    } catch (error) {
      this.record('phase.review-session-skipped', { reason: (error as Error)?.message ?? String(error) }, phase);
      return;
    }
    if (!facts) {
      this.record('phase.review-session-skipped', { reason: 'the phase diff could not be resolved' }, phase);
      return;
    }
    if (facts.diff.failed || !facts.diff.files.length) {
      // Not a silent skip and not an approval: a reviewer shown nothing would
      // "approve" an empty diff, which is a clean bill of health for a phase
      // nobody read.
      this.record('phase.review-session-skipped', {
        reason: facts.diff.failed ? 'git could not produce this phase\'s diff' : 'this phase\'s window is empty',
      }, phase);
      return;
    }

    // One of the fourteen automatic starts (SLF-1): the reviewer names its
    // door, asks the instance's ceiling, and is skipped by name past it —
    // advisory paperwork is the first thing a ceiling should cost.
    const actor = doorActor('auto-reviewer', {
      by: 'runner', via: 'event', origin: 'phase-finish',
      trigger: `reviewEachPhase:${policy}`, guard: 'non-empty diff,!fleetFrozen', counter: 'one per phase',
    });
    const admitted = this.deps.startCeiling?.admit(actor) ?? { ok: true as const };
    if (!admitted.ok) {
      this.record('run.start-refused', { ...actor, ceiling: admitted.ceiling, limit: admitted.limit, count: admitted.count, until: admitted.until }, phase);
      this.record('phase.review-session-skipped', { reason: `the start ceiling refused the reviewer (${admitted.ceiling}) until ${admitted.until}` }, phase);
      return;
    }
    this.deps.startCeiling?.charge(actor, state.slug);
    this.record('phase.session-start', { ...actor, mode: 'review' }, phase);
    this.record('phase.review-session', {
      policy, files: facts.diff.files.length,
      additions: facts.diff.additions, deletions: facts.diff.deletions,
    }, phase);
    this.emit('phase', { phase, reviewSession: true });

    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'review', {
        prompt: reviewerPrompt(facts),
        cwd: state.root,
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: reviewerLabel({ slug: state.slug, phase }),
        // NEVER `resume`. A review inherited from the session that built the
        // phase is not a review — it is the author agreeing with themselves,
        // which is the entire failure this feature exists to avoid. Same rule
        // the QA intent in `agent.ts` states for the same reason.
        tools: [...RunnerLoop.REVIEWER_TOOLS],
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        // Recorded, like the closeout's — and for the reason the closeout's own
        // comment gives. A session the console holds no handle or pid for is a
        // session it can never freeze, thaw or stop: a fleet freeze pressed
        // mid-review left a reviewer running and spending, invisibly, because
        // there was nothing to signal. The gate above stops one STARTING; this
        // is what makes one already running stoppable.
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        env: await this.sessionEnv({}),
        signal: this.abort?.signal,
      }, {
        // Reading, like paperwork: a quarter of the phase's dollars and the
        // closeout's turn cap, so a confused reviewer cannot spend a phase's
        // worth of money re-deriving the work.
        caps: capsFor({ mode: 'review', size: await this.sizeOf(phase), phaseBudgetUsd: state.phaseBudgetUsd }),
      });
    } catch (error) {
      this.record('phase.review-session-failed', { error: (error as Error)?.message ?? String(error) }, phase);
      return;
    }

    // The same three lines every extra session uses, so this money appears in
    // the cost panels without those panels knowing this feature exists.
    state.spentUsd += outcome.costUsd;
    record.costUsd += outcome.costUsd;
    chargeRung(state.recoveries?.[String(record.phase)], outcome.costUsd);
    record.turns = (record.turns ?? 0) + outcome.turns;

    const report = parseReviewerReport(
      outcome.resultText, policy, facts.diff.files.map((f) => f.path),
    );
    if (!report) {
      // No fabricated verdict. "The reviewer produced nothing parseable" is a
      // fact; inventing `approved` from it would be a clean bill of health
      // manufactured by a parser bug.
      this.record('phase.review-session-done', {
        ok: false, costUsd: outcome.costUsd, turns: outcome.turns,
        reason: 'the reviewer did not answer in the required format',
        said: outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 600) : undefined,
      }, phase);
      this.persist();
      return;
    }

    try {
      this.deps.reviewer.record(state.slug, phase, report);
    } catch (error) {
      this.record('phase.review-session-done', {
        ok: false, costUsd: outcome.costUsd, turns: outcome.turns,
        reason: `the verdict could not be stored: ${(error as Error)?.message ?? String(error)}`,
      }, phase);
      this.persist();
      return;
    }

    this.record('phase.review-session-done', {
      ok: true, costUsd: outcome.costUsd, turns: outcome.turns,
      verdict: report.verdict, findings: report.findings.length,
      // Present only when the run's policy overrode what the session asked
      // for — the one line that explains a `commented` chip on a review whose
      // note plainly says the work must change.
      ...(report.askedFor ? { askedFor: report.askedFor, downgradedBy: policy } : {}),
    }, phase);
    this.emit('phase', { phase, reviewSession: false, reviewVerdict: report.verdict });
    this.persist();
  }

  /**
   * The cloud review, when the run asked for one at this moment.
   *
   * Sited beside `autoReview` and awaited the same way, with the same contract:
   * it never changes whether the phase passed, and every exit is journalled. It
   * differs from its neighbour in exactly one way that matters — this is a
   * child process the RUNNER spawns, not a session, because `claude
   * ultrareview` blocks for up to half an hour and a wait that long inside a
   * phase session's turn is precisely what the wait-denial exists to stop.
   *
   * Which checkout it reads is the whole of the `each-phase` / `at-settle`
   * distinction: a lane worktree holds the phase's own commits and nothing
   * else, and the run root at settle holds all of them.
   */
  protected async maybeUltraReview(
    phase: number, occasion: 'each-phase' | 'at-settle',
  ): Promise<void> {
    const state = this.state;
    if (!state || state.ultraReview !== occasion) return;

    // Same gate and same reasoning as the auto reviewer's: no child is started
    // under a freeze, and a skip an operator can read beats a child they cannot
    // signal. Recover & continue after the thaw reaches this again.
    const frozen = this.fleetFrozen();
    if (frozen) {
      this.record(ULTRAREVIEW_EVENTS.skipped, {
        occasion,
        reason: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''} — no review is started under a freeze`,
      }, phase);
      return;
    }

    // One of the fourteen automatic starts (SLF-1): billed cloud work, so it
    // names its door and asks the ceiling before a dollar is spent.
    const actor = doorActor('ultrareview', {
      by: 'runner', via: 'event', origin: occasion === 'each-phase' ? 'phase-finish' : 'run-settle',
      trigger: `ultraReview:${occasion}`, guard: '!fleetFrozen', counter: 'one per phase',
    });
    const admitted = this.deps.startCeiling?.admit(actor) ?? { ok: true as const };
    if (!admitted.ok) {
      this.record('run.start-refused', { ...actor, ceiling: admitted.ceiling, limit: admitted.limit, count: admitted.count, until: admitted.until }, phase);
      this.record(ULTRAREVIEW_EVENTS.skipped, {
        occasion, reason: `the start ceiling refused the cloud review (${admitted.ceiling}) until ${admitted.until}`,
      }, phase);
      return;
    }
    this.deps.startCeiling?.charge(actor, state.slug);
    this.record('phase.session-start', { ...actor, mode: 'ultrareview' }, phase);
    await ultraReviewJob({
      occasion, slug: state.slug, phase,
      cwd: occasion === 'each-phase' ? this.laneRoot(phase) : state.root,
      env: await this.sessionEnv({}),
      policy: state.reviewerPolicy === 'may-hold' ? 'may-hold' : DEFAULT_REVIEWER_POLICY,
      record: (event, data, at) => { this.record(event, data, at); },
      store: this.deps.reviewer
        ? (slug, at, report) => { this.deps.reviewer!.record(slug, at, report); }
        : undefined,
      signal: this.abort?.signal,
      ...(this.deps.ultraReviewSpawn ? { spawn: this.deps.ultraReviewSpawn } : {}),
    });
    this.persist();
  }

  /**
   * The run-wide cloud review, before the branch's fate is decided.
   *
   * Called from the drive loop when the run has nothing left and nothing ended
   * badly — BEFORE `settleRun`, so the reviewer reads the branch while it is
   * still a branch: three of the four settle strategies change what is on disk
   * (a merge into the staging checkout, a rebase, a pull request that may
   * auto-merge), and a review of a branch that has been merged away is a review
   * of nothing. It is deliberately outside `settleRun` rather than inside it,
   * because that only runs under `gitMode: 'new-branch'` and a default-branch
   * run has the same finished body of work to read.
   *
   * Its findings hang on the last phase this run finished — the closest thing a
   * DAG has to "the end of the work", and the row an operator opening the run
   * looks at first. A run that finished none is skipped rather than reviewed
   * against nothing. It never changes what the settle does: a review that could
   * stop a run from finishing its own branch would be a hold with no card to
   * clear it on.
   */
  protected async ultraReviewAtSettle(): Promise<void> {
    const state = this.state;
    if (!state || state.ultraReview !== 'at-settle') return;
    const phase = lastFinishedPhase(state.phases);
    if (phase == null) {
      this.record(ULTRAREVIEW_EVENTS.skipped, {
        occasion: 'at-settle',
        reason: 'this run finished no phase, so there is nothing to hang a review on',
      });
      return;
    }
    await this.maybeUltraReview(phase, 'at-settle');
  }

  /**
   * The operator's git strategy for this phase's session, or '' — which is the
   * only value a default-branch run ever gets, so every prompt composed before
   * this feature existed is byte-identical after it.
   *
   * The console never runs a git write itself; these are instructions to the
   * session, which is the entity that holds the lock and owns the tree. Three
   * escalations ride on the base block: a WORKTREE variant when someone else
   * is live in a shared repository right now (switching branches in a shared
   * checkout would swap files under the other session mid-edit — the skill's
   * conventions name a linked worktree as the escape hatch, and this automates
   * exactly that); a MISMATCH note when the plan's own §Session budget names a
   * different branch; and the PR block when this is the plan's last remaining
   * phase and the run was asked to open one.
   */
  private async gitStrategy(phase: number, board: Board): Promise<string> {
    const state = this.state!;
    if (state.gitMode !== 'new-branch') return '';
    const branch = `pe/${state.slug}`;
    const scope = await this.scopeFor(phase);

    // Does this phase ALREADY have a checkout of its own? `acquireWorktree`
    // runs before the prompt is composed, so the answer is settled by now —
    // and it is read from the lane rather than from the plan directive, so a
    // refusal or a git failure reads as "shared root" here exactly as it does
    // everywhere else. When it is true, every bullet below about acquiring a
    // tree is not merely unnecessary but WRONG: `pe/<slug>` is checked out in
    // the run's integration worktree, so checking it out is impossible and
    // `git worktree add`-ing it is a hard git failure.
    const laneDir = this.lanes.get(phase)?.worktree;

    // …and does the RUN have one? The second, orthogonal shape: no lane, but
    // every session of this run works in the console's managed checkout of
    // `pe/<slug>` itself. Read from `state.checkout` rather than from the
    // isolation REQUEST, so a refused run reads as shared here exactly as it
    // does everywhere else — the whole point of keeping the two words apart.
    const runDir_ = !laneDir && state.checkout === 'worktree' ? state.workRoot : undefined;
    // The third checkout shape: the run's tree is a MIRROR — a plain directory
    // of per-repository worktrees — and the single-tree bullet's every claim
    // ("a worktree of this repository", "do not switch branches in it") would
    // be false of it.
    const mirrorRepos = runDir_ ? state.mountedRepos ?? [] : [];

    // The honesty probe, guard-independent: it fires under guard-off by
    // design, and on a guard-on race where a foreign lock appeared after
    // admission. Either way the session must know it is not alone. A phase
    // with a checkout of its own — lane or run — is exempt: it already HAS the
    // isolation the probe would advise, and telling it to `git worktree add`
    // its own branch a second time is a hard git failure.
    const overlaps = (laneDir || runDir_) ? [] : (this.deps.scheduler?.overlapsFor({
      slug: state.slug, phase, runId: state.id, scope,
      // Both qualification dimensions — or neither — so the honesty probe
      // agrees with the admission that just ran: a caution about a collision
      // admission had decided does not exist would be the console arguing
      // with itself (D-F). One function answers both (`qualificationFor`).
      ...this.qualificationFor(phase, scope),
    }) ?? []);
    const worktree = overlaps.length > 0;
    if (worktree) {
      this.record('phase.shared-checkout', {
        scope,
        holders: overlaps.map((h) => `${h.slug} P${h.phase ?? '?'} (${h.owner})`),
        guard: this.deps.scheduler?.snapshot().guard === false ? 'off' : 'on(race)',
      }, phase);
    }

    // The plan's Branch prose, read only to warn. The default idioms —
    // "current branch", "no new branch", "default" — are not a named branch.
    const prose = this.deps.planBranch?.(state.slug)?.trim();
    const planNames = prose && !/current|no new branch|default/i.test(prose) ? prose : undefined;
    if (planNames && !this.branchMismatchNoted) {
      this.branchMismatchNoted = true;
      this.record('run.branch-mismatch', { plan: planNames, run: branch });
    }

    // Final ⇔ every OTHER phase on the board is done, this is the only live
    // lane, and the run is the whole plan (a scoped run finishing is not the
    // plan finishing). Two leaves finishing together therefore never both read
    // final — `run.pr-pending` at finish covers that honestly instead.
    const phases = Object.keys(board.states).map(Number);
    const final = !state.onlyPhases?.length
      && phases.filter((p) => p !== phase).every((p) => board.done.includes(p))
      && this.livePhases().every((p) => p === phase);
    const pr = final && state.openPr !== false;
    if (pr) this.prBlockEmitted = true;

    const laneBranch = laneDir
      ? this.laneNamesFor(phase).laneBranch
      : '';

    // 🔴 Asked of git, every time the prompt is written. `pe/<slug>` can be held
    // by a tree this run never owned — the PREVIOUS run's checkout, kept at
    // settle because a killed session left it dirty — and it can be freed by an
    // operator between two phases of one run. Neither is a fact a run can carry
    // in its own state, which is what the first attempt at this did: it recorded
    // the holder on `RunState` when a release could not remove a tree, so it was
    // never set for the new-run case at all, and went stale the moment the
    // operator did what the bullet asked.
    // Asked only when the answer can change what the session is told. A lane or
    // a run-tree session already HAS its checkout and is told so by the arms
    // above, so the question cannot move them — and skipping it keeps a
    // `git worktree list` off the boot path of every ISOLATED run's sessions.
    const heldAt = !laneDir && !runDir_ ? await heldElsewhere(state.root, branch) : undefined;

    const checkoutBullet = laneDir
      ? `- Your cwd is ALREADY this phase's own worktree, on its own branch\n`
        + `  \`${laneBranch}\`, taken from \`${branch}\`:\n`
        + `      ${laneDir}\n`
        + `  Do all of this phase's work here and commit here. Do NOT check out\n`
        + `  \`${branch}\` — the run holds it in another worktree, so git will refuse —\n`
        + `  and do NOT run \`git worktree add\` yourself; you already have one. The\n`
        + `  console merges \`${laneBranch}\` into \`${branch}\` when the phase settles, and\n`
        + `  removes the worktree afterwards, so leave it in place.\n`
        + `- Work-state — the handoff, INDEX, \`.locks/\`, QA rows, gate approvals — does\n`
        + `  NOT live here. It belongs to the run's primary root:\n`
        + `      ${state.root}\n`
        + `  \`$DOCS_ROOT\` is already set to it, so every skill script writes there by\n`
        + `  itself and needs no flag from you. Commit those files IN THAT CHECKOUT if\n`
        + `  the skill's rules say to — never commit code there, and never copy the\n`
        + `  handoff into this worktree.`
      : runDir_ && mirrorRepos.length
      ? `- Your cwd is a console-built MIRROR of this superproject${mirrorRepos.includes('')
          ? ' — a checkout of\n  the superproject itself, with a checkout of each scoped submodule under it'
          : ' — a plain\n  directory, NOT a repository itself'}:\n`
        + `      ${runDir_}\n`
        + `  It holds one worktree per scoped repository, each ALREADY ${state.detachAt
          ? 'DETACHED at its own default-branch head (owning NO branch)'
          : `on \`${branch}\``}:\n`
        // 🔴 The ROOT mount is `rel: ''`, and printing that renders a bare
        // slash — a path the session cannot act on and would read as a bug.
        // It is the mirror directory itself, so it says so.
        + mirrorRepos.map((rel) => `      ${rel ? `${rel}/` : './  (the superproject itself)'}\n`).join('')
        + `  Do all of this phase's work inside those repositories and commit in each\n`
        + `  one you touch. Do NOT switch branches in any of them, and do NOT run\n`
        + `  \`git worktree add\` yourself — each already has its checkout, and\n`
        + `  \`${branch}\` cannot be checked out twice. Any repository NOT listed above\n`
        + `  lives only in the shared root at ${state.root} — read it there if you need\n`
        + `  it, and do not edit it from this session${mirrorRepos.includes('')
          ? `; here it is an EMPTY\n  directory, which is what an unmounted submodule looks like, not a repo\n  whose files went missing`
          : ''}. The console made this mirror, keeps\n`
        + `  it for every phase of this run, and removes it when the run settles, so\n`
        + `  leave it in place.\n`
        + `- Work-state — the handoff, INDEX, \`.locks/\`, QA rows, gate approvals — does\n`
        + `  NOT live here. It belongs to the run's primary root:\n`
        + `      ${state.root}\n`
        + `  \`$DOCS_ROOT\` is already set to it, so every skill script writes there by\n`
        + `  itself and needs no flag from you. Commit those files IN THAT CHECKOUT if\n`
        + `  the skill's rules say to — never commit code there, and never copy the\n`
        + `  handoff into the mirror.`
      // The DETACHED single-tree shape (a `Checkout: main` phase, or the run
      // branch gone post-settle). The arm below this one would tell the session
      // it is "already on `pe/<slug>`" and, later, to commit only there — a
      // branch its tree does not own and that may not exist at all. A prompt
      // that gives a session an impossible order has told it nothing.
      : runDir_ && state.detachAt
      ? `- Your cwd IS a console-managed checkout of this repository, DETACHED at\n`
        + `  \`${detachedRef(state.detachAt)}\` — the default branch's head. It owns NO branch\n`
        + `  (\`git branch\` shows none here, and \`${branch}\` may not exist any more):\n`
        + `      ${runDir_}\n`
        + `  Do all of this phase's work here. Do NOT switch branches, do NOT create\n`
        + `  one, and do NOT run \`git worktree add\` yourself. Commits you make here\n`
        + `  ride the detached HEAD — the console preserves a tree holding work — so\n`
        + `  name every commit sha in your handoff, so an operator can land them.\n`
        + `- Work-state — the handoff, INDEX, \`.locks/\`, QA rows, gate approvals — does\n`
        + `  NOT live here. It belongs to the run's primary root:\n`
        + `      ${state.root}\n`
        + `  \`$DOCS_ROOT\` is already set to it, so every skill script writes there by\n`
        + `  itself and needs no flag from you. Commit those files IN THAT CHECKOUT if\n`
        + `  the skill's rules say to — never commit code there, and never copy the\n`
        + `  handoff into this worktree.`
      : runDir_
      ? `- Your cwd IS a console-managed worktree of this repository, already on\n`
        + `  \`${branch}\`:\n`
        + `      ${runDir_}\n`
        + `  Do all of this phase's work here and commit here. Do NOT switch branches\n`
        + `  in it, and do NOT run \`git worktree add\` yourself — you already have a\n`
        + `  checkout, and \`${branch}\` cannot be checked out twice. The console made\n`
        + `  this tree, keeps it for every phase of this run, and removes it when the\n`
        + `  run settles, so leave it in place.\n`
        + `- Work-state — the handoff, INDEX, \`.locks/\`, QA rows, gate approvals — does\n`
        + `  NOT live here. It belongs to the run's primary root:\n`
        + `      ${state.root}\n`
        + `  \`$DOCS_ROOT\` is already set to it, so every skill script writes there by\n`
        + `  itself and needs no flag from you. Commit those files IN THAT CHECKOUT if\n`
        + `  the skill's rules say to — never commit code there, and never copy the\n`
        + `  handoff into this worktree.`
      // 🔴 FIRST of the shared arms, above the neighbour CAUTION, because a
      // held branch beats every piece of advice that involves TAKING it — and
      // the CAUTION's advice is `git worktree add … ${branch}`, which is the
      // same request as `git checkout ${branch}` and refused for the same
      // reason. Below the CAUTION, one prompt told a session to worktree-add a
      // branch git would refuse AND, two bullets later, to commit on the branch
      // it was already on. When both are true the neighbour still matters, so
      // its warning rides along rather than being replaced.
      //
      // Deliberately says only what is TRUE OF ANY HOLDER. It used to claim the
      // tree was "console-managed" and "holds uncommitted work" — the case that
      // prompted it — but `heldElsewhere` asks about every worktree of the
      // repository, so the holder may be the operator's own checkout, and a
      // sentence that guesses wrong about it is worse than one that does not
      // guess.
      : heldAt
      ? `- \`${branch}\` is checked out in another working tree at\n`
        + `      ${heldAt}\n`
        + `  and git allows a branch only one, so it is NOT available in this checkout.\n`
        + `  Do NOT try to check \`${branch}\` out, and do NOT \`git worktree add\` it —\n`
        + `  those are the same request, and git refuses both.${overlaps.length
          ? `\n  A live session also shares a repository with this phase right now\n`
            + `  (${overlaps.map((h) => `${h.slug} P${h.phase ?? '?'} (${h.owner})`).join('; ')}), so do NOT switch\n`
            + `  branches in this checkout either: that would swap files under it mid-edit.`
          : ''}\n`
        + `  Work in this checkout on the branch that is already current and commit\n`
        + `  there, then say in your handoff that \`${branch}\` is held at that path, so\n`
        + `  an operator can land or discard what is in it.`
      // 🔴 This arm used to PRESCRIBE making a sibling worktree by hand.
      // It was well-meant and it was the source of the mess: nothing in the
      // console sweeps a session-made tree or branch (`pruneWorktrees` covers
      // only lane dirs and never deletes a branch), so every session that took
      // the advice left a permanent checkout behind — five under /private/tmp,
      // plus branches nobody could attribute. The console makes trees when the
      // plan asks for lanes; a session must not make its own. What is left is
      // the true half of the warning and a way OUT that costs nothing: declare
      // the block, name the lock, and let admission queue behind the holder.
      : worktree
      ? `- CAUTION — another live session shares a repository with this phase right now\n`
        + `  (${overlaps.map((h) => `${h.slug} P${h.phase ?? '?'} (${h.owner})`).join('; ')}), so you must NOT switch\n`
        + `  branches in the shared checkout: that would swap files under the other\n`
        + `  session mid-edit. Do NOT create a worktree either — nothing removes one\n`
        + `  afterwards, so it becomes permanent debris under somebody else's name.\n`
        + `  Work in this checkout, on the branch that is already current, and only in\n`
        + `  files this phase's scope names. If you genuinely cannot proceed without\n`
        + `  \`${branch}\`, do not take it — declare the block and stop:\n`
        + `      bash <scripts>/phase-outcome.sh ${state.slug} <N> blocked \\\n`
        + `        --reason "<what you need>" --watch lock:${state.slug}/<N>\n`
        + `  The console queues this phase behind the holder and resumes it when the\n`
        + `  scope frees, which is the same wait without the wreckage.`
        : `- In each scoped repository, BEFORE editing anything: if \`${branch}\` exists\n`
          + `  (locally or on the remote), check it out; otherwise create it from the\n`
          + `  repository's default branch. Later phases of this run reuse it — leave it\n`
          + `  checked out when you finish.`;

    const mismatch = planNames
      ? `\n- Note: the plan's §Session budget names the branch \`${planNames}\`. This run\n`
        + `  was started with the console's new-branch strategy, which wins for sessions\n`
        + `  the console mints: use \`${branch}\`, and record the discrepancy in your\n`
        + `  handoff so the plan can be updated.`
      : '';

    const title = this.deps.planTitle?.(state.slug) ?? state.slug;
    const prBlock = pr ? `\n\n${prBlockText(branch, title)}` : '';

    this.record('phase.git-strategy', {
      mode: 'new-branch', branch, worktree, pr,
      // Which of the three checkout bullets the session actually got. Without
      // it the journal cannot answer "was this phase told it had a tree?" —
      // which is the first question of every isolation bug report.
      checkout: laneDir ? 'lane' : mirrorRepos.length ? 'mirror'
        : runDir_ ? (state.detachAt ? 'detached' : 'run') : 'shared',
    }, phase);

    return `\n\nGit strategy for this run — set by the operator in the console. For this run\n`
      + `it overrides whatever §Session budget says about branches:\n\n`
      + `- All work for this plan lands on ONE plan-wide branch: \`${branch}\`, in every\n`
      + `  repository in this phase's scope (${scope.join(', ')}).\n`
      + `${checkoutBullet}\n`
      + (runDir_ && !laneDir && state.detachAt
        // Same agreement rule as the branch-held case below: the cwd bullet
        // above says the tree owns no branch, so the commit order may not name
        // one. This covers the detached mirror too — every mount is detached.
        ? `- This checkout is DETACHED — there is no branch to commit to here. Commit\n`
          + `  only what the phase requires (the commits ride the detached HEAD and are\n`
          + `  preserved), do not push, and name every commit sha in your handoff.\n`
        : heldAt && !laneDir && !runDir_
        // 🔴 The two bullets have to agree. The honest one above says "commit
        // on the branch this checkout is already on"; this one said "Commit
        // only to `pe/<slug>`. Never commit to the default branch" — with the
        // root standing on `main`, and `pe/<slug>` held in a tree the session
        // was just told not to touch. A prompt that gives a session two
        // incompatible orders has told it nothing.
        ? `- Because \`${branch}\` is held elsewhere, commit on the branch this checkout\n`
          + `  is already on. Do not create another branch, and do not push. Say in your\n`
          + `  handoff where your commits landed, so they can be moved onto\n`
          + `  \`${branch}\` once the held tree is dealt with.\n`
        : `- Commit only to \`${branch}\`. Never commit to the default branch, never push\n`
          + `  the default branch, and do not create any other branch.\n`)
      + `- Handoff, INDEX and lock commits in the docs repository follow the skill's\n`
      + `  usual rules — do not invent a separate branch just for docs.${mismatch}${prBlock}\n`;
  }

  /**
   * What one phase runs as, resolved from the three places that may say.
   *
   * Order is deliberate and never rearranged: what the operator chose for THIS
   * ATTEMPT wins, then what they chose for this RUN, because both are more
   * recent and more specific than the plan; then the plan, because it is the
   * durable statement of what the phase needs; then the run's defaults.
   * `source` records which of the four answered, so the journal can explain a
   * surprising model rather than merely recording it.
   *
   * The attempt level is Retry-with-edits (`RetryOverride`), and it is the one
   * level that is SPENT: it exists only until the boarding it asked for starts.
   */
  private optionsFor(phase: number): PhaseOptions & { source: Record<string, string> } {
    const state = this.state!;
    const attempt = phaseRecord(state, phase).retryOverride?.options ?? {};
    const chosen = state.phaseOptions?.[String(phase)] ?? {};
    const plan = this.deps.phaseDefaults?.(state.slug, phase) ?? {};
    const source: Record<string, string> = {};

    const pick = (key: 'model' | 'effort', fallback?: string): string | undefined => {
      if (attempt[key]) { source[key] = 'retry'; return attempt[key]; }
      if (chosen[key]) { source[key] = 'run'; return chosen[key]; }
      if (plan[key]) { source[key] = 'plan'; return plan[key]; }
      if (fallback) source[key] = 'default';
      return fallback;
    };

    return {
      model: pick('model', state.model),
      effort: pick('effort', state.effort),
      // The list-valued fields take the attempt's answer WHOLE when it has one,
      // rather than merging: an operator narrowing this attempt to two tools
      // means those two, and a union with the run's list would quietly hand
      // back exactly what they were trying to take away. Absence still
      // inherits, so an override that names only a model changes only the
      // model.
      tools: attempt.tools ?? chosen.tools,
      permissionMode: attempt.permissionMode ?? chosen.permissionMode,
      skills: attempt.skills ?? chosen.skills,
      skillsOff: attempt.skillsOff ?? chosen.skillsOff,
      mcpServers: attempt.mcpServers ?? chosen.mcpServers,
      mcpOff: attempt.mcpOff ?? chosen.mcpOff,
      // Passed through rather than resolved here: `mcpPolicyFor` consults the
      // plan BEFORE the run, which is the opposite of this function's
      // run-beats-plan rule, and folding it in would hide that reversal.
      mcpPolicy: attempt.mcpPolicy ?? chosen.mcpPolicy,
      // Absence inherits the RUN's answer rather than defaulting to off, which
      // is why this stops at the phase levels — `ultracodeOn` is the one place
      // the run is consulted, so a reader never has to ask which of two
      // resolutions won.
      ultracode: attempt.ultracode ?? chosen.ultracode,
      source,
    };
  }

  /**
   * Every MCP server this phase runs with, deduped, first-seen order.
   *
   * Three contributors, and they compose rather than override: what the PLAN
   * says the phase needs (its §Session budget line plus its own `**MCP:**`
   * bullet, from the engine), what the operator chose for this RUN, and what
   * they chose for this PHASE. `mcpOff` drops only the run's — the plan's
   * statement is versioned and survives, because a phase that says it needs
   * Playwright is describing the work, not somebody's preference for one run.
   */
  protected mcpFor(phase: number, chosen: PhaseOptions): string[] {
    const state = this.state!;
    const fromPlan = this.deps.planMcp?.(state.slug, phase) ?? [];
    const fromRun = chosen.mcpOff ? [] : (state.mcpServers ?? []);
    return [...new Set([...fromPlan, ...fromRun, ...(chosen.mcpServers ?? [])])].filter(Boolean);
  }
}
