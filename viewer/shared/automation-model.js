/**
 * THE AUTOMATION PREFERENCES, and the shape they group into.
 *
 * Thirty-nine flat keys accreted over fifteen releases into a namespace with no
 * structure: five attempt budgets in three units (one of which its own comment
 * called vestigial), four separate auto-continue switches, seven `stall*`
 * numbers, and five git knobs whose invalid combinations degraded in silence.
 * That is R32/R38 in the design register, and 3.5.0's answer is one nested
 * `automation` object — written beside the flat keys for one release, read in
 * preference to them, and the only shape after 3.6.0.
 *
 * ------------------------------------------------------------------
 * The rules this file is built around
 * ------------------------------------------------------------------
 *
 * **1. The grouping is DATA, declared once.** `toAutomation` and
 * `fromAutomation` are both loops over `AUTOMATION_MAP`. Two functions that
 * each knew the layout would agree until the day a key was added to one of
 * them, and the failure would be a preference that saves and never loads.
 *
 * **2. It lives in `shared/` because three consumers ask.** The server's
 * loader coerces through it, the server's writer emits both shapes from it, and
 * the client's Settings coverage test walks it to demand a control per key. A
 * client test cannot import `server/config.ts` — the state-directory guard
 * refuses it, correctly — so a copy of the list on the client would be a third
 * spelling of the thing this file exists to have one of.
 *
 * **3. The nested names drop the prefixes the flat names carried.**
 * `ladderPerPhaseRungs` is `caps.perPhaseRungs` and `stallSilentMs` is
 * `stall.silentMs`, because the group now says what the prefix said.
 *
 * `settleOf()` in `worktree-model.js` is the precedent: a two-key fold written
 * once and used by both the server's loader and the client's reader. This is
 * the same idea over thirty-nine keys instead of two.
 *
 * Pure data and two total functions. Imports nothing.
 */

/**
 * Where each flat automation key lives in the nested object.
 * @type {Readonly<Record<string, readonly [string, string]>>}
 */
export const AUTOMATION_MAP = Object.freeze({
  // What a run is launched WITH, when the operator names nothing.
  attachDefaultSkills: ['defaults', 'attachSkills'],
  qaByDefault: ['defaults', 'qa'],
  reviewEachPhaseByDefault: ['defaults', 'reviewEachPhase'],
  reviewerPolicy: ['defaults', 'reviewerPolicy'],
  // The launch form's opening values for four of many-plans-one-repo phase
  // 15's run fields — what a run gets when its plan is silent and the
  // operator names nothing. Rendered by `RunSetup` in `defaults` mode, beside
  // the git and QA defaults they belong with.
  landing: ['defaults', 'landing'],
  conflictPolicy: ['defaults', 'conflictPolicy'],
  messaging: ['defaults', 'messaging'],
  issuesMode: ['defaults', 'issuesMode'],

  // What the console may do about a stopped run, by itself.
  autoRecoverByDefault: ['recover', 'enabled'],
  autoContinueRecovery: ['recover', 'continue'],
  resumeAtBoot: ['recover', 'resumeAtBoot'],
  convergeEveryMs: ['recover', 'convergeEveryMs'],
  delegateHumanGates: ['recover', 'delegateHumanGates'],
  // The policy table's console half (phase 11): `policy.<decisionKey>` — an
  // object keyed by decision key, one answer word each.
  policy: ['policy', 'answers'],
  // …and Tier 2's (phase 14): the relay's rule table, a LIST of rules that
  // answer a question nobody else did. Beside the answers because it is the
  // same card's to edit and the same kind of decision, one tier down.
  relayRules: ['policy', 'relayRules'],
  allowUnverifiedPhases: ['recover', 'allowUnverifiedPhases'],
  staleClaimTakeover: ['recover', 'staleClaimTakeover'],
  unblockAttempts: ['recover', 'unblockSessions'],

  // How far it may go before it must ask — rungs and dollars.
  ladderPerPhaseRungs: ['caps', 'perPhaseRungs'],
  ladderPerPhaseUsd: ['caps', 'perPhaseUsd'],
  ladderPerRunRungs: ['caps', 'perRunRungs'],
  ladderPerRunUsd: ['caps', 'perRunUsd'],
  ladderPerDayUsd: ['caps', 'perDayUsd'],
  // The per-instance start ceiling (zero-touch-console phase 7, SLF-1).
  ceilingStartsPerHour: ['caps', 'startsPerHour'],
  ceilingUsdPerHour: ['caps', 'usdPerHour'],
  budgetAutoRaisePct: ['caps', 'budgetAutoRaisePct'],
  ladderExtendOnProgress: ['caps', 'extendOnProgress'],

  autoAccountSwitch: ['accounts', 'autoSwitch'],
  mcpPolicy: ['mcp', 'policy'],
  mcpRequireTimeoutMs: ['mcp', 'requireTimeoutMs'],
  watchCmdRefs: ['watch', 'cmdRefs'],
  watchMintedCmdRefs: ['watch', 'mintedCmdRefs'],

  // When a lane stops being work.
  stallSilentMs: ['stall', 'silentMs'],
  stallSpinTurns: ['stall', 'spinTurns'],
  stallStalemateAttempts: ['stall', 'stalemateAttempts'],
  stallRetryBurst: ['stall', 'retryBurst'],
  stallExternalWaitMs: ['stall', 'externalWaitMs'],
  stallAutomaticPark: ['stall', 'automaticPark'],
  stallLocalJobMs: ['stall', 'localJobMs'],
  stallEscalateMs: ['stall', 'escalateMs'],
  // The sixth signal (many-plans-one-repo phase 13): identical failing tool
  // calls in a row before a lane reads as `looping`. Noticing only — no rung.
  stallLoopRun: ['stall', 'loopRun'],

  // The five whose combinations used to fail silently, plus the worktree three.
  gitMode: ['git', 'mode'],
  isolation: ['git', 'isolation'],
  isolationReclaim: ['git', 'reclaim'],
  settle: ['git', 'settle'],
  openPrOnComplete: ['git', 'openPr'],
  repoGuard: ['git', 'guard'],
  deleteMergedRunBranches: ['git', 'deleteMergedBranches'],
  worktreeMaxConcurrent: ['git', 'worktreeMaxConcurrent'],
  worktreeSetup: ['git', 'worktreeSetup'],
  worktreeCopyEnv: ['git', 'worktreeCopyEnv'],
  worktreeRoot: ['git', 'worktreeRoot'],
  // The radar hold (many-plans-one-repo phase 9): serialise a conflicted pair
  // by landing order, off by default. Beside the guard it resembles.
  radarSerialize: ['git', 'radarSerialize'],
  // Phase 7's three, homed here by phase 15 with their controls (the
  // launch form's `defaults` mode renders them beside isolation): the
  // per-repository cap, what becomes of a settled run's tree, and the base a
  // run branch is cut from when the plan does not say.
  maxConcurrentPerRepo: ['git', 'maxPerRepo'],
  worktreeRetention: ['git', 'retention'],
  baseBranch: ['git', 'baseBranch'],
});

/**
 * The flat automation keys the map covers, in the order it declares them.
 * @type {readonly string[]}
 */
export const AUTOMATION_KEYS = Object.freeze(Object.keys(AUTOMATION_MAP));

/**
 * The boarding schedule is its own group and IS its value.
 *
 * It is coerced by `sanitiseSchedule` beside the rules it has to agree with,
 * and it is replaced wholesale on every write rather than merged. Splitting it
 * into `schedule.enabled` / `schedule.windows` here would put its shape in two
 * places, which is the thing this file exists to stop.
 */
const SCHEDULE_KEY = 'boardingSchedule';

/**
 * What a console does about the runs its own restart stopped.
 *
 * Three answers, because there were only ever two and the missing one was the
 * one an operator wanted. `auto` is 3.4's behaviour: every interrupted run
 * starts spending again the moment the console is back — right for an
 * unattended fleet, startling for a person who restarted the console to change
 * a setting and found it boarding sessions they had not asked for. `off` writes
 * an errand and waits for a person to press something. Neither is "ask me",
 * which is what a person restarting their own console actually wants.
 *
 * `ask` is the shipped default. It launches nothing and writes no errand — an
 * errand is a job, and this is a question — and the app puts it in front of
 * whoever opens it next. The answer lives for one console boot: a restart is
 * the event the question is about, so the next restart asks again.
 */
export const RESUME_AT_BOOT_MODES = Object.freeze(/** @type {const} */ (['ask', 'auto', 'off']));

/** @typedef {(typeof RESUME_AT_BOOT_MODES)[number]} ResumeAtBootMode */

/**
 * Read the preference, in either the word form or the boolean it used to be.
 *
 * 🔑 **A stored `true` reads as `ask`, not as `auto`**, and that is the
 * behaviour change 3.5.0 is making deliberately. `true` never meant "I have
 * considered this and I want it silent" — it was the only value that resumed at
 * all, so every console that wanted resuming at all has it. Migrating it to
 * `auto` would keep the surprise for exactly the installs that reported it.
 * An operator who wants the old behaviour says `auto`, once.
 *
 * A stored `false` is unambiguous and keeps its meaning.
 * @param {unknown} value
 * @returns {ResumeAtBootMode}
 */
export function resumeAtBootMode(value) {
  if (value === false || value === 'off') return 'off';
  if (value === 'auto') return 'auto';
  return 'ask';
}

/**
 * The nested `automation` object built from a coerced flat shape.
 * @param {Record<string, unknown>} flat
 * @returns {Record<string, Record<string, unknown>>}
 */
export function toAutomation(flat) {
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const key of AUTOMATION_KEYS) {
    if (flat?.[key] === undefined) continue;
    const [group, name] = AUTOMATION_MAP[key];
    (out[group] ??= {})[name] = flat[key];
  }
  if (flat?.[SCHEDULE_KEY] !== undefined) {
    out.schedule = /** @type {Record<string, unknown>} */ (flat[SCHEDULE_KEY]);
  }
  return out;
}

/**
 * The flat shape recovered from a nested `automation` object.
 *
 * Total over every malformed shape `config.json` can hold, because it is a
 * hand-editable file: a null, a number, an array and a group whose value is a
 * string all read as "says nothing" rather than throwing.
 * @param {unknown} automation
 * @returns {Record<string, unknown>}
 */
export function fromAutomation(automation) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!automation || typeof automation !== 'object' || Array.isArray(automation)) return out;
  const groups = /** @type {Record<string, unknown>} */ (automation);
  for (const key of AUTOMATION_KEYS) {
    const [group, name] = AUTOMATION_MAP[key];
    const bag = groups[group];
    if (!bag || typeof bag !== 'object') continue;
    const value = /** @type {Record<string, unknown>} */ (bag)[name];
    if (value !== undefined) out[key] = value;
  }
  if (groups.schedule !== undefined) out[SCHEDULE_KEY] = groups.schedule;
  return out;
}
