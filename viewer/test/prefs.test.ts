/**
 * The automation preferences — the opening values for every launch surface.
 *
 * Two properties carry the feature. A config written before these keys existed
 * must read as the documented defaults (skills off, QA off, default branch, PR
 * on, guard on) — silence is never a behaviour change. And the save path takes
 * its patch straight off an HTTP body, so it must be an allowlist: a client can
 * flip the knobs this type has, and nothing else, with a mistyped value dropped
 * rather than stored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-prefs-state-'));
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-prefs-config-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { loadPrefs, sanitiseAutomation, SKILL_DIR } = await import('../server/config.ts');
const { STALL_DEFAULTS } = await import('../shared/attention-model.js');
const { Service } = await import('../server/service.ts');

const CONFIG_FILE = join(CONFIG_HOME, 'phase-console', 'config.json');

function writeConfig(body: unknown): void {
  mkdirSync(join(CONFIG_HOME, 'phase-console'), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

test.after(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
  rmSync(CONFIG_HOME, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Loading: a config from before the feature, and a config with typos
 * ------------------------------------------------------------------ */

test('a config written before the automation keys existed reads as the defaults', () => {
  writeConfig({ theme: 'dark', sort: 'name' });
  const prefs = loadPrefs();
  assert.equal(prefs.attachDefaultSkills, false, 'attaching extra skills is opt-in');
  assert.equal(prefs.qaByDefault, false, 'QA is opt-in');
  assert.equal(prefs.gitMode, 'default-branch');
  assert.equal(prefs.openPrOnComplete, true);
  assert.equal(prefs.repoGuard, true, 'the guard is the safe state and must be the silent one');
  // Isolation reads as today's behaviour, and its knobs as the shipped ones.
  assert.equal(prefs.isolation, 'queue', 'the shared checkout is the silent state');
  assert.equal(prefs.worktreeMaxConcurrent, 3);
  assert.equal(prefs.worktreeSetup, '');
  assert.equal(prefs.worktreeCopyEnv, false, 'copying .env files is never a default');
  assert.equal(prefs.worktreeRoot, 'project', 'trees live inside the project unless asked otherwise');
  // And the keys it did have survive.
  assert.equal(prefs.theme, 'dark');
  assert.equal(prefs.sort, 'name');
});

test('a typo in the isolation setting can never mint a worktree', () => {
  // The `gitMode` rule applied to the other feature that touches a repository.
  // Each of these is a plausible hand-edit; none of them may isolate a run.
  for (const wrong of ['Worktree', 'worktrees', 'true', true, 1, ['worktree'], null]) {
    writeConfig({ isolation: wrong });
    assert.equal(loadPrefs().isolation, 'queue', `\`${JSON.stringify(wrong)}\` must not isolate`);
  }
  // And the knobs refuse values that would break the feature quietly: a cap of
  // zero would refuse every isolated run while the setting still read as on,
  // and a non-string setup command must never reach a shell half-coerced.
  writeConfig({ worktreeMaxConcurrent: 0, worktreeSetup: { cmd: 'rm -rf /' }, worktreeCopyEnv: 'yes', worktreeRoot: 'State' });
  const prefs = loadPrefs();
  assert.equal(prefs.worktreeMaxConcurrent, 3, 'a zero cap is not a cap, it is the feature off');
  assert.equal(prefs.worktreeSetup, '', 'a non-string setup command is NO command');
  assert.equal(prefs.worktreeCopyEnv, false);
  assert.equal(prefs.worktreeRoot, 'project', 'only the exact word moves the trees out of the project');
});

test('a stored isolation choice loads back as stored', () => {
  writeConfig({ isolation: 'worktree', worktreeMaxConcurrent: 8, worktreeSetup: 'npm ci', worktreeCopyEnv: true, worktreeRoot: 'state' });
  const prefs = loadPrefs();
  assert.equal(prefs.isolation, 'worktree');
  assert.equal(prefs.worktreeMaxConcurrent, 8);
  assert.equal(prefs.worktreeSetup, 'npm ci');
  assert.equal(prefs.worktreeCopyEnv, true);
  assert.equal(prefs.worktreeRoot, 'state');
});

test('a typo in config.json can never mint branches or drop the guard', () => {
  writeConfig({
    gitMode: 'new-brunch', attachDefaultSkills: 'yes', qaByDefault: 1,
    openPrOnComplete: 'no', repoGuard: 0,
  });
  const prefs = loadPrefs();
  assert.equal(prefs.gitMode, 'default-branch', 'only the exact literal means new-branch');
  assert.equal(prefs.attachDefaultSkills, false);
  assert.equal(prefs.qaByDefault, false);
  assert.equal(prefs.openPrOnComplete, true);
  assert.equal(prefs.repoGuard, true);
});

test('stored choices load back as stored', () => {
  writeConfig({ gitMode: 'new-branch', attachDefaultSkills: true, repoGuard: false });
  const prefs = loadPrefs();
  assert.equal(prefs.gitMode, 'new-branch');
  assert.equal(prefs.attachDefaultSkills, true);
  assert.equal(prefs.repoGuard, false);
});

test('sanitiseAutomation is the single coercion table', () => {
  assert.deepEqual(sanitiseAutomation({}), {
    attachDefaultSkills: false, qaByDefault: false, gitMode: 'default-branch',
    openPrOnComplete: true, repoGuard: true,
    // Isolation ships OFF, like every other behaviour change in this plan:
    // `queue` is exactly what the console did before the setting existed. The
    // three knobs beside it default from `shared/worktree-model.js`, and
    // `worktreeCopyEnv` is false because copying `.env` files into a second
    // directory is a decision an operator makes, never one they discover.
    isolation: 'queue', worktreeMaxConcurrent: 3, worktreeSetup: '', worktreeCopyEnv: false,
    // The trees the console makes live inside the project, where a person
    // finds them; the state directory is the older placement, on request.
    worktreeRoot: 'project',
    // Phase 7's three: a per-REPOSITORY cap beside the machine-wide one (a
    // repository nobody can read is a different cost from a full disk), the
    // retention word that decides what a settled run's tree becomes, and the
    // base a run branch is cut from when the plan does not say.
    maxConcurrentPerRepo: 3, worktreeRetention: 'keep-on-failure', baseBranch: 'origin/HEAD',
    // The radar hold (phase 9) ships OFF — the radar stays advisory.
    radarSerialize: false,
    // Phase 15's four launch defaults, each the shared owner's own default:
    // a phase's commits are held for a person, a conflict halts, sessions may
    // message each other, and an outward write is never a default.
    landing: 'hold', conflictPolicy: 'halt', messaging: 'on', issuesMode: 'off',
    // The two that ship ON, and both are exceptions with the same reason: they
    // undo damage this console itself does. The work-branch strategy tells
    // every session to check `pe/<slug>` out, so the operator's own tree ends
    // up holding it and every later run of that plan silently shares that
    // checkout — and thirty driven runs leave thirty dead branches behind.
    // Neither can destroy anything: a dirty tree is never moved, and the
    // deletion is `git branch -d`, which git refuses for an unmerged branch.
    isolationReclaim: 'clean-only', deleteMergedRunBranches: true,
    // Settle ships as `pr` — and here the shipped default is the one that DOES
    // something, which is the exception in this table and deliberate: `pr` is
    // what every new-branch run has always ended with, so a console that gains
    // this setting keeps opening the pull requests it was already opening.
    settle: 'pr',
    reviewEachPhaseByDefault: false, reviewerPolicy: 'comment-only',
    autoRecoverByDefault: true, autoContinueRecovery: true,
    // On, and gated a second time by `--allow-run`: a console that may not spawn
    // a session must not run a session's recorded command either.
    watchCmdRefs: true,
    // OFF: a `cmd:` ref the console MINTED (the watchdog's park) is never run
    // unless an operator says so — the console's own inference must not
    // execute a writing command against a repository nobody is watching (SLF-8).
    watchMintedCmdRefs: false,
    mcpPolicy: 'continue',
    ladderPerPhaseRungs: 3, ladderPerPhaseUsd: 100, ladderPerRunRungs: 10, ladderPerRunUsd: 400, ladderPerDayUsd: 600,
    // The start ceiling (phase 7): forty automatic starts and $250 per sliding hour.
    ceilingStartsPerHour: 40, ceilingUsdPerHour: 250,
    // `delegateHumanGates` is ON since 5.0.0 (phase 11, operator decision 11:
    // `gates: delegated`) — this console's word for the manifest's `gates` row.
    unblockAttempts: true, delegateHumanGates: true, staleClaimTakeover: true,
    // The policy table's console half (phase 11): empty means "the plan's row,
    // else the shipped default, answers every key".
    policy: {},
    // The posture sweep's two opt-ins (P12) ship OFF: one lowers the proof bar
    // to the handoff, the other spends one more session's money.
    allowUnverifiedPhases: false, ladderExtendOnProgress: false,
    // Three-valued since 3.5.0, and shipped on the middle one: a console
    // restart ASKS which interrupted runs to pick back up rather than silently
    // resuming them all. A stored `true` reads as `ask` too — see
    // `resumeAtBootMode`.
    resumeAtBoot: 'ask',
    autoAccountSwitch: true,
    convergeEveryMs: 300_000,
    budgetAutoRaisePct: 25, mcpRequireTimeoutMs: 1_800_000,
    stallSilentMs: 600_000, stallSpinTurns: 6, stallStalemateAttempts: 3, stallRetryBurst: 5,
    stallExternalWaitMs: 300_000,
    // The SECOND clock on `external-wait` — a wait on the session's own
    // background job. Nine times the number above, and beside
    // `STALL_DEFAULTS` rather than in it, because that object is a bijection
    // with the signals and this is a second clock on one of them.
    stallLocalJobMs: 2_700_000,
    // Whether the watchdog may park a lane by itself — SLF-9's off switch.
    // ON, which is what the console did before the switch existed.
    stallAutomaticPark: true,
    // The clock on the ANNOUNCEMENT rather than on a detector — 45 minutes,
    // and one of the two stall numbers that take `cap`: see below.
    stallEscalateMs: 2_700_000,
    // The sixth signal (phase 13): three identical failing tool calls in a row.
    stallLoopRun: 3,
    // The boarding schedule is the one OBJECT here, coerced by its own
    // `sanitiseSchedule` beside the rules it has to agree with. Off, with
    // nothing in it: a console that has never set one boards at every hour,
    // which is what this console has always done.
    boardingSchedule: { enabled: false, windows: [], quiet: [], cron: [], cronMinutes: 60 },
    // The relay's rule table (phase 14): a LIST, coerced by `sanitiseRelayRules`
    // beside the matcher that reads it. Empty: no rule ships, so a console that
    // has never written one answers a question by its recommendation.
    relayRules: [],
  });
  // …and a rule missing its key or its answer is dropped, never repaired.
  assert.deepEqual(
    sanitiseAutomation({ relayRules: [{ key: 'colour:*' }, { key: 'colour:*', answer: 'Blue' }] } as never).relayRules,
    [{ id: 'AskUserQuestion:colour:*:*', tool: 'AskUserQuestion', key: 'colour:*', profile: '*', answer: 'Blue' }],
  );
  // …and it is not a toggle: `enabled` needs the exact boolean, and a policy
  // that cannot be read is DROPPED rather than defaulted open.
  assert.equal(sanitiseAutomation({ boardingSchedule: { enabled: 'yes' } } as never).boardingSchedule.enabled, false);
  assert.deepEqual(
    sanitiseAutomation({ boardingSchedule: { enabled: true, windows: [{ from: '9:00', to: 'noon' }] } } as never)
      .boardingSchedule.windows,
    [], 'an unreadable window is not a window that admits everything',
  );
  // Ladder caps: a finite non-negative number or the default — a string, a
  // negative or NaN must never make the ladder unbounded (or zero).
  assert.equal(sanitiseAutomation({ ladderPerPhaseUsd: 25 }).ladderPerPhaseUsd, 25);
  // The resource ladder's two numbers follow the same rule; zero is a valid
  // "off" for both (no raise; wait on `require` indefinitely).
  assert.equal(sanitiseAutomation({ budgetAutoRaisePct: 0 }).budgetAutoRaisePct, 0, 'zero is a valid "no raise"');
  assert.equal(sanitiseAutomation({ budgetAutoRaisePct: '50' } as never).budgetAutoRaisePct, 25);
  assert.equal(sanitiseAutomation({ mcpRequireTimeoutMs: 60_000 }).mcpRequireTimeoutMs, 60_000);
  assert.equal(sanitiseAutomation({ mcpRequireTimeoutMs: -5 }).mcpRequireTimeoutMs, 1_800_000);
  assert.equal(sanitiseAutomation({ ladderPerPhaseUsd: '25' } as never).ladderPerPhaseUsd, 100);
  assert.equal(sanitiseAutomation({ ladderPerRunRungs: -1 }).ladderPerRunRungs, 10);
  assert.equal(sanitiseAutomation({ ladderPerDayUsd: Number.NaN }).ladderPerDayUsd, 600);
  assert.equal(sanitiseAutomation({ convergeEveryMs: 0 }).convergeEveryMs, 0, 'zero is a valid "timer off"');
  assert.equal(sanitiseAutomation({ unblockAttempts: false }).unblockAttempts, false);
  assert.equal(sanitiseAutomation({ staleClaimTakeover: 'no' } as never).staleClaimTakeover, true);
  assert.equal(sanitiseAutomation({ gitMode: 'new-branch' }).gitMode, 'new-branch');
  // The auto reviewer is off by default and a typo cannot turn it on; the
  // policy takes only its one exact word, so nothing but `may-hold` can make a
  // reviewer able to park the phases behind the one it read.
  assert.equal(sanitiseAutomation({ reviewEachPhaseByDefault: 'yes' } as never).reviewEachPhaseByDefault, false);
  assert.equal(sanitiseAutomation({ reviewEachPhaseByDefault: true }).reviewEachPhaseByDefault, true);
  assert.equal(sanitiseAutomation({ reviewerPolicy: 'may-hold' }).reviewerPolicy, 'may-hold');
  for (const bad of ['MAY-HOLD', 'hold', '', true, 1]) {
    assert.equal(sanitiseAutomation({ reviewerPolicy: bad } as never).reviewerPolicy, 'comment-only');
  }
  // The recovery automation defaults are ON, and a typo cannot turn them off.
  assert.equal(sanitiseAutomation({ autoRecoverByDefault: 'no' } as never).autoRecoverByDefault, true);
  assert.equal(sanitiseAutomation({ autoContinueRecovery: false }).autoContinueRecovery, false);
  assert.equal(sanitiseAutomation({ watchCmdRefs: false }).watchCmdRefs, false);
  assert.equal(sanitiseAutomation({ watchCmdRefs: 'no' } as never).watchCmdRefs, true,
    'the one pref that governs an execution surface still cannot be turned ON by a typo — '
    + 'it defaults on, so a garbage value must read as the default, not as off');
  // The stall thresholds take `positive`, not `cap`: unlike a ladder cap
  // there is no meaning to give a zero here — it would flag every lane on its
  // first tick — so zero and every other unusable value take the shipped one.
  assert.equal(sanitiseAutomation({ stallSilentMs: 90_000 }).stallSilentMs, 90_000);
  assert.equal(sanitiseAutomation({ stallSilentMs: 0 }).stallSilentMs, 600_000, 'zero is not "off", it is nonsense');
  // …with two exceptions. The first is not a detector: a zero escalation
  // clock means "never say a stall twice", which is what this console did
  // before the escalation existed and is a setting an operator can want — so
  // this one takes `cap`, and nonsense still takes the shipped 45 minutes.
  assert.equal(sanitiseAutomation({ stallEscalateMs: 0 }).stallEscalateMs, 0, 'zero IS "never re-say it"');
  assert.equal(sanitiseAutomation({ stallEscalateMs: 90_000 }).stallEscalateMs, 90_000);
  assert.equal(sanitiseAutomation({ stallEscalateMs: -1 }).stallEscalateMs, 2_700_000);
  assert.equal(sanitiseAutomation({ stallEscalateMs: '45' } as never).stallEscalateMs, 2_700_000);
  assert.equal(sanitiseAutomation({ stallSpinTurns: -3 }).stallSpinTurns, 6);
  assert.equal(sanitiseAutomation({ stallStalemateAttempts: '4' } as never).stallStalemateAttempts, 3);
  assert.equal(sanitiseAutomation({ stallRetryBurst: 2 }).stallRetryBurst, 2);
  assert.equal(sanitiseAutomation({ stallRetryBurst: 0 }).stallRetryBurst, 5);
  assert.equal(sanitiseAutomation({ stallExternalWaitMs: 120_000 }).stallExternalWaitMs, 120_000);
  // The second is: a zero external-wait threshold means "never call a lane
  // waiting", which Settings always promised ("0 never parks a lane for
  // waiting") while `positive` quietly turned it back into five minutes (SLF-9).
  assert.equal(sanitiseAutomation({ stallExternalWaitMs: 0 }).stallExternalWaitMs, 0, 'zero IS "never call it waiting"');
  assert.equal(sanitiseAutomation({ stallExternalWaitMs: -1 }).stallExternalWaitMs, 300_000);
  assert.equal(sanitiseAutomation({ stallAutomaticPark: false }).stallAutomaticPark, false);
  // The minted-ref switch ships OFF and only an explicit true turns it on (SLF-8).
  assert.equal(sanitiseAutomation({}).watchMintedCmdRefs, false);
  assert.equal(sanitiseAutomation({ watchMintedCmdRefs: true }).watchMintedCmdRefs, true);
  assert.equal(sanitiseAutomation({ watchMintedCmdRefs: 'yes' } as never).watchMintedCmdRefs, false,
    'a typo cannot switch the minted refs on');
  assert.equal(sanitiseAutomation({ stallAutomaticPark: 'no' } as never).stallAutomaticPark, true,
    'a typo cannot switch the automatic park off');
  // ...and the shipped numbers are the shared ones, not a second copy.
  assert.deepEqual(
    {
      stallSilentMs: sanitiseAutomation({}).stallSilentMs,
      stallSpinTurns: sanitiseAutomation({}).stallSpinTurns,
      stallStalemateAttempts: sanitiseAutomation({}).stallStalemateAttempts,
      stallRetryBurst: sanitiseAutomation({}).stallRetryBurst,
      stallExternalWaitMs: sanitiseAutomation({}).stallExternalWaitMs,
      stallLoopRun: sanitiseAutomation({}).stallLoopRun,
    },
    { ...STALL_DEFAULTS },
  );
});

test('only the exact word require can make an MCP server able to stop a plan', () => {
  // The same fail-safe direction as `gitMode`, pointing the other way: there,
  // only the exact literal may mint a branch; here, only the exact literal may
  // park a run. A config nobody edited, and a config somebody fat-fingered,
  // both keep plans moving.
  assert.equal(sanitiseAutomation({}).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'require' }).mcpPolicy, 'require');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'Require' } as never).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: 'required' } as never).mcpPolicy, 'continue');
  assert.equal(sanitiseAutomation({ mcpPolicy: true } as never).mcpPolicy, 'continue');
});

test('a config written before the MCP policy existed reads as continue', () => {
  // The behaviour change this release is a DEFAULT moving, so the upgrade path
  // is the thing most worth pinning: an operator who never opens Settings gets
  // the new behaviour, and gets it without a migration.
  writeConfig({ theme: 'dark', repoGuard: true });
  assert.equal(loadPrefs().mcpPolicy, 'continue');
});

/* ------------------------------------------------------------------ *
 * Saving: the patch is an HTTP body, so the merge is an allowlist
 * ------------------------------------------------------------------ */

function makeService() {
  return new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
}

test('savePreferences flips the knobs it knows and drops everything else', () => {
  writeConfig({});
  const service = makeService();
  try {
    const saved = service.savePreferences({
      qaByDefault: true,
      gitMode: 'new-branch',
      repoGuard: false,
      // None of these may land: wrong type, wrong value, unknown key.
      attachDefaultSkills: 'yes',
      openPrOnComplete: 'sure',
      somethingElse: { nested: true },
    } as never);
    assert.equal(saved.qaByDefault, true);
    assert.equal(saved.gitMode, 'new-branch');
    assert.equal(saved.repoGuard, false);
    assert.equal(saved.attachDefaultSkills, false, 'a mistyped value is dropped, not stored');
    assert.equal(saved.openPrOnComplete, true);
    assert.ok(!('somethingElse' in saved), 'unknown keys never reach config.json');
    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    assert.ok(!('somethingElse' in onDisk));
    assert.equal(onDisk.gitMode, 'new-branch');
  } finally {
    service.close();
  }
});

test('mcpPolicy round-trips through savePreferences, and a bad one is dropped', () => {
  writeConfig({});
  const service = makeService();
  try {
    assert.equal(service.savePreferences({ mcpPolicy: 'require' }).mcpPolicy, 'require');
    const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.mcpPolicy, 'require');
    // Dropped means dropped: the stored choice survives a patch that says
    // nothing valid, rather than silently reverting to the default.
    assert.equal(service.savePreferences({ mcpPolicy: 'always' } as never).mcpPolicy, 'require');
    assert.equal(service.savePreferences({ mcpPolicy: 'continue' }).mcpPolicy, 'continue');
  } finally {
    service.close();
  }
});

test('a bad gitMode in a patch keeps the stored one — dropped means dropped', () => {
  writeConfig({ gitMode: 'new-branch' });
  const service = makeService();
  try {
    const saved = service.savePreferences({ gitMode: 'main' } as never);
    assert.equal(saved.gitMode, 'new-branch', 'the stored value survives a bad patch');
  } finally {
    service.close();
  }
});

test('an automation patch leaves the notify map alone', () => {
  writeConfig({});
  const service = makeService();
  try {
    const before = { ...service.savePreferences({}).notify };
    const after = service.savePreferences({ repoGuard: false }).notify;
    assert.deepEqual(after, before, 'flipping a knob must not reset notification categories');
  } finally {
    service.close();
  }
});

test('every automation preference the loader accepts can also be SET', () => {
  // `sanitiseAutomation` (the loader) and `savePreferences` (the writer) are two
  // lists of the same keys, and a key added to one and not the other is a
  // setting that survives a restart but can never be changed from the console.
  // `delegateHumanGates` shipped exactly that way: honoured on load, silently
  // dropped from every patch, so the Settings toggle would have done nothing.
  const loaded = sanitiseAutomation({}) as Record<string, unknown>;
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);

  // `notify` is a map with its own merge rule, and `lastRoot`/`recentRoots` are
  // written by opening a directory, not by a settings patch.
  const skip = new Set(['notify', 'lastRoot', 'recentRoots', 'theme', 'density', 'sort']);
  // A preference whose value is an OBJECT needs a hand-written "different"
  // value — flipping a boolean or bumping a number does not generalise — and it
  // needs a structural comparison, because its coercer necessarily returns a
  // new object and identity would report every one of them as ignored.
  const OBJECT_FLIPS: Record<string, unknown> = {
    boardingSchedule: {
      enabled: true, windows: [{ days: [1], from: '09:00', to: '18:00' }],
      quiet: [], cron: [], cronMinutes: 60,
    },
    // In the vocabulary's order (`DECISION_KEYS`), which is the order the
    // coercer writes them back in — the comparison below is by JSON text.
    // `stop` is a free-text key: one line, kept since phase 12's editor.
    policy: { gates: 'operator', 'qa.exhausted': 'halt', stop: 'keep-going; page me' },
    relayRules: [{ id: 'AskUserQuestion:colour:*:*', tool: 'AskUserQuestion', key: 'colour:*', profile: '*', answer: 'Blue' }],
  };
  // 🔴 **A string used to flip to ITSELF**, so `same(flipped[key], after[key])`
  // was trivially true for every word-valued key and this test proved nothing
  // about seven of them. That is not hypothetical: it is how `settle` came to
  // be in the loader and not in the writer — the exact drift named above —
  // and it went two releases unseen behind a green assertion. A word-valued
  // preference needs a DIFFERENT legal word, and it must be a legal one,
  // because every one of these doors drops what it cannot read rather than
  // coercing it. Same rule as OBJECT_FLIPS: a new word-valued key fails here
  // until somebody names its other value.
  const WORD_FLIPS: Record<string, string> = {
    gitMode: 'new-branch',
    reviewerPolicy: 'may-hold',
    mcpPolicy: 'require',
    isolation: 'worktree',
    isolationReclaim: 'never',
    settle: 'keep',
    worktreeSetup: 'npm ci',
    worktreeRoot: 'state',
    worktreeRetention: 'prune',
    baseBranch: 'main',
    resumeAtBoot: 'auto',
    // Phase 15's four launch defaults, each flipped to a legal other word.
    landing: 'pr',
    conflictPolicy: 'park',
    messaging: 'off',
    issuesMode: 'draft',
  };
  const flipped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(loaded)) {
    if (skip.has(key)) continue;
    if (value && typeof value === 'object') {
      assert.ok(key in OBJECT_FLIPS, `${key} is object-valued and needs an entry in OBJECT_FLIPS`);
      flipped[key] = OBJECT_FLIPS[key];
      continue;
    }
    if (typeof value === 'string') {
      assert.ok(key in WORD_FLIPS, `${key} is word-valued and needs an entry in WORD_FLIPS`);
      assert.notEqual(WORD_FLIPS[key], value, `${key}'s flip must differ from its default`);
      flipped[key] = WORD_FLIPS[key];
      continue;
    }
    flipped[key] = typeof value === 'boolean' ? !value : (value as number) + 1;
  }
  const after = svc.savePreferences(flipped as never) as unknown as Record<string, unknown>;
  const same = (a: unknown, b: unknown): boolean =>
    (a && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const ignored = Object.keys(flipped).filter((key) => !same(flipped[key], after[key]));
  assert.deepEqual(ignored, [],
    `these preferences load but cannot be set — the writer's list has drifted from the loader's:\n  ${ignored.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * Phase 7 — the option surface for many plans in one repository.
 * ------------------------------------------------------------------ */

test('P7: a console that cuts its own branch isolates by DEFAULT, and only silence is overridden', () => {
  // Decision 13. `queue` stayed the silent state for a `default-branch`
  // console — nothing there is the console's own branch to isolate — but a
  // new-branch run's `pe/<slug>` is nobody else's, and a tree of its own is
  // what lets two plans drive one repository at once.
  assert.equal(sanitiseAutomation({ gitMode: 'new-branch' }).isolation, 'worktree');
  assert.equal(sanitiseAutomation({ gitMode: 'default-branch' }).isolation, 'queue');
  assert.equal(sanitiseAutomation({}).isolation, 'queue');

  // 🔴 An operator who SAID `queue` keeps it. The default answers silence and
  // nothing else — a setting that overrode a stated choice would be a bug the
  // operator could only find by watching their runs stop serialising.
  assert.equal(
    sanitiseAutomation({ gitMode: 'new-branch', isolation: 'queue' }).isolation, 'queue',
    'a stated choice outranks the default in the direction that costs less',
  );
});

test('P7: the per-repository cap, the retention word and the base branch all have defaults', () => {
  const shipped = sanitiseAutomation({});
  assert.equal(shipped.maxConcurrentPerRepo, 3);
  assert.equal(shipped.worktreeRetention, 'keep-on-failure');
  assert.equal(shipped.baseBranch, 'origin/HEAD');

  // Coerced by the owner's own functions, never by a local `===` here.
  assert.equal(sanitiseAutomation({ worktreeRetention: 'ttl:12' }).worktreeRetention, 'ttl:12');
  assert.equal(
    sanitiseAutomation({ worktreeRetention: 'ttl:0' }).worktreeRetention, 'keep-on-failure',
    'an unreadable ttl falls back to the DEFAULT — a typo must never be why a tree was deleted',
  );
  assert.equal(sanitiseAutomation({ worktreeRetention: 'delete-it' }).worktreeRetention, 'keep-on-failure');

  // A zero cap would refuse every isolated run while claiming the feature is
  // on — the same reason `worktreeMaxConcurrent` is `positive`, not `cap`.
  assert.equal(sanitiseAutomation({ maxConcurrentPerRepo: 0 }).maxConcurrentPerRepo, 3);
  assert.equal(sanitiseAutomation({ maxConcurrentPerRepo: 5 }).maxConcurrentPerRepo, 5);

  // A non-string base branch reads as no opinion, for the reason
  // `worktreeSetup` does: a half-coerced value must never reach a git argv.
  assert.equal(sanitiseAutomation({ baseBranch: 12 } as never).baseBranch, 'origin/HEAD');
  assert.equal(sanitiseAutomation({ baseBranch: '  release/5.1  ' }).baseBranch, 'release/5.1');
});
