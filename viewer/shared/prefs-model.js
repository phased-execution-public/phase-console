/**
 * The settings schema (quiet-console phase 25, §Architecture 5): what every
 * preference this console stores IS — its group, its type, its words, its unit,
 * what it does, and whether `POST /api/prefs` can write it.
 *
 * `server/config.ts` `Prefs` is the stored shape and `savePreferences` the one
 * writer; this table is what a page reads to draw a key it has never heard of.
 * `GET /api/prefs/schema` answers one row per key from it, with the key's
 * shipped default, the value the console runs with and where that value came
 * from, and Settings ▸ Everything draws those rows. `PROFILE_META` does the same
 * for the machine profile's fields (`fleet.json`), which no page writes.
 *
 * `viewer/test/prefs-schema.test.ts` holds both tables to the server: the keys
 * with a shipped default are exactly `DEFAULT_PREFS`' — each map spread into its
 * members, `notify.<category>` and `retention.<key>` — the keys without one are
 * exactly the rest of `Prefs`, `writable` is exactly what `savePreferences`
 * reads, and `PROFILE_META` is exactly `PROFILE_MACHINE_KEYS` and `autostart`.
 *
 * Dependency-free ESM, like every `shared/` module, so a page can import it. A
 * word list is the owner's own array, imported by identity
 * (`vocab-owners.test.ts`), never a second copy of its members.
 */

import { RESUME_AT_BOOT_MODES } from './automation-model.js';
import { ISSUE_MODES } from './issue-modes.js';
import { CONFLICT_POLICIES, LAND_POLICIES } from './landing-model.js';
import { MESSAGING_WORDS } from './message-model.js';
import { SCHEDULING_POLICIES } from './orchestration-model.js';
import { GIT_MODES, MCP_POLICIES, REVIEWER_POLICIES } from './run-lifecycle.js';
import { EFFORT_LEVELS } from './run-settings.js';
import {
  ISOLATION_MODES,
  ISOLATION_RECLAIM,
  SETTLE_STRATEGIES,
  WORKTREE_RETENTION,
  WORKTREE_ROOTS,
} from './worktree-model.js';

/** The colour schemes a console offers; `system` follows the device. */
export const THEMES = Object.freeze(/** @type {const} */ (['system', 'light', 'dark']));

/** How much room a row takes. */
export const DENSITIES = Object.freeze(/** @type {const} */ (['comfortable', 'compact']));

/**
 * The room the page is drawn in, independent of light and dark (#362): `quiet`
 * is 7.0's (the default), `departures` the 6.x room (`styles/departures.css`).
 */
export const PALETTES = Object.freeze(/** @type {const} */ (['quiet', 'departures']));

/** What `autostart` holds for one console in the machine profile, as words: `once` starts the next boot and is spent. */
export const AUTOSTART_WORDS = Object.freeze(/** @type {const} */ (['true', 'false', 'once']));

/**
 * Where a key's value came from, worst-hidden first:
 *
 *   - `default` — nothing stores it: the value is the shipped default;
 *   - `config` — the person's file, `config.json` (the default console's only
 *     file; for every console the person-wide keys — theme, density, palette,
 *     sort, model; and a console that has not saved yet reads it whole);
 *   - `instance` — this console's own file, `instances/<id>.json`;
 *   - `migrated` — derived from another key or an older spelling the loader
 *     still reads (a boolean `resumeAtBoot`, `settle` from
 *     `openPrOnComplete: false`, `isolation` from the new-branch strategy);
 *   - `profile` — set outside this console's settings: the machine profile
 *     (`fleet.json`). Read-only here; the row names the line that changes it.
 */
export const PREF_SOURCES = Object.freeze(
  /** @type {const} */ (['default', 'config', 'instance', 'migrated', 'profile']),
);

/** What a key holds: one of its `words`, a list, or a small object (`map`). */
export const PREF_TYPES = Object.freeze(
  /** @type {const} */ (['boolean', 'number', 'string', 'word', 'list', 'map']),
);

/** The unit a number is in. */
export const PREF_UNITS = Object.freeze(
  /** @type {const} */ (['ms', 'hours', 'days', 'bytes', 'megabytes', 'usd', 'percent', 'count', 'factor']),
);

/** The group a key is drawn under — the Settings section that owns it. */
export const PREF_GROUPS = Object.freeze(
  /** @type {const} */ ([
    'essentials',
    'appearance',
    'automation',
    'notifications',
    'issues',
    'retention',
    'profile',
  ]),
);

/**
 * @typedef {(typeof PREF_SOURCES)[number]} PrefSource
 * @typedef {(typeof PREF_TYPES)[number]} PrefType
 * @typedef {(typeof PREF_UNITS)[number]} PrefUnit
 * @typedef {(typeof PREF_GROUPS)[number]} PrefGroup
 * @typedef {{
 *   group: PrefGroup,
 *   type: PrefType,
 *   description: string,
 *   writable: boolean,
 *   words?: readonly string[],
 *   unit?: PrefUnit,
 *   cli?: string,
 *   secret?: boolean,
 * }} PrefMeta
 */

/**
 * One row. `writable` is whether `POST /api/prefs` stores it; `cli` is the
 * command line that changes a key from a terminal, where one exists; `secret`
 * marks a value that is a credential or may carry one — the schema says
 * whether it is set and never serves it (`server/prefs-schema.ts`).
 * @param {PrefGroup} group
 * @param {PrefType} type
 * @param {string} description
 * @param {Partial<PrefMeta>} [extra]
 * @returns {PrefMeta}
 */
const row = (group, type, description, extra = {}) =>
  Object.freeze({ group, type, description, writable: true, ...extra });

/** @param {readonly string[]} words @param {PrefGroup} group @param {string} description @param {Partial<PrefMeta>} [extra] */
const word = (words, group, description, extra = {}) => row(group, 'word', description, { words, ...extra });

/** @param {PrefUnit} unit @param {string} description @param {Partial<PrefMeta>} [extra] */
const number = (unit, description, extra = {}) =>
  row('automation', 'number', description, { unit, ...extra });

/** @param {string} description */
const toggle = (description) => row('automation', 'boolean', description);

/** A category of announcement: on, it is announced at all — every leg, the inbox and the phone. @param {string} label */
const notify = (label) =>
  row('notifications', 'boolean', `Announce ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);

/**
 * A retention row — set from Settings ▸ This instance since quiet-console phase
 * 23, each member held by the settings door to the floor the loader holds it to
 * (`server/retention-policy.ts` `retentionPatch`).
 * @param {PrefUnit} unit @param {string} description
 */
const retention = (unit, description) => row('retention', 'number', description, { unit });

/** The queue's words, which `POST /api/queue/policy` writes rather than the settings door. */
const QUEUE_POLICY = 'phase-console run queue-policy';

/**
 * Every preference this console stores, by key. A map is spread into its
 * members: `notify.<category>` (the catalogue's ids) and `retention.<key>`.
 * @type {Readonly<Record<string, PrefMeta>>}
 */
export const PREF_META = Object.freeze({
  /* ---- the source, and what the person sees ---- */
  recentRoots: row(
    'essentials',
    'list',
    'The source directories this console opened most recently, newest first.',
  ),
  lastRoot: row('essentials', 'string', 'The source directory the console reopens when it starts.'),
  issueRepos: row(
    'issues',
    'list',
    'Repositories outside this console the Issues desk also reads, each as owner/name.',
  ),
  theme: word(THEMES, 'appearance', 'The colour scheme: follow the device, or always light or always dark.'),
  density: word(DENSITIES, 'appearance', 'How much room a row takes.'),
  palette: word(
    PALETTES,
    'appearance',
    'The room the page is drawn in: Quiet (7.0) or Departures (the 6.x room), in either light.',
  ),
  sort: row('appearance', 'string', 'How the plans library orders its plans.'),
  model: row('appearance', 'string', 'The model a session plan is sized for.'),

  /* ---- what a launch opens on ---- */
  attachDefaultSkills: toggle("Start new runs with this machine's default skills attached."),
  qaByDefault: toggle('Open every launch with the QA gate on.'),
  gitMode: word(
    GIT_MODES,
    'automation',
    'Whether a new run works on a branch of its own or on whatever is checked out.',
  ),
  openPrOnComplete: toggle('When a run on its own branch finishes, push the branch and open a pull request.'),
  reviewEachPhaseByDefault: toggle("Start every run with a fresh reviewer over each phase's diff."),
  reviewerPolicy: word(
    REVIEWER_POLICIES,
    'automation',
    'What that reviewer may record: a comment, or a hold on the phases after it.',
  ),
  repoGuard: toggle('Queue runs whose repositories overlap rather than running them side by side.'),
  isolation: word(
    ISOLATION_MODES,
    'automation',
    'What a new run asks for: the shared checkout, or a checkout of its own.',
  ),
  settle: word(SETTLE_STRATEGIES, 'automation', "What becomes of a finished run's branch."),
  worktreeMaxConcurrent: number(
    'count',
    'How many checkouts the console may hold at once, across every repository.',
  ),
  worktreeSetup: row('automation', 'string', 'A command run once inside every fresh checkout.'),
  worktreeCopyEnv: toggle("Copy the source checkout's ignored .env files into every fresh checkout."),
  worktreeRoot: word(
    WORKTREE_ROOTS,
    'automation',
    "Where the console's checkouts live: inside the project, or in its state directory.",
  ),
  maxConcurrentPerRepo: number('count', 'How many isolated runs one repository may hold at once.'),
  worktreeRetention: word(
    WORKTREE_RETENTION,
    'automation',
    "What becomes of a run's checkout when the run settles; ttl:<hours> keeps it that long.",
  ),
  baseBranch: row('automation', 'string', 'The branch a run branch is cut from when its plan does not say.'),
  radarSerialize: toggle('Make phases whose branches would conflict wait for each other, in landing order.'),
  landing: word(
    LAND_POLICIES,
    'automation',
    "Where a finished phase's commits go when its plan does not say.",
  ),
  conflictPolicy: word(
    CONFLICT_POLICIES,
    'automation',
    'What a landing conflict does when the plan does not say.',
  ),
  messaging: word(
    MESSAGING_WORDS,
    'automation',
    'Whether sessions may message each other when the plan does not say.',
  ),
  issuesMode: word(
    ISSUE_MODES,
    'automation',
    'What becomes of a problem a session finds outside its phase when the plan does not say.',
  ),
  isolationReclaim: word(
    ISOLATION_RECLAIM,
    'automation',
    'Whether a run may take its branch back from a clean checkout standing on it.',
  ),
  deleteMergedRunBranches: toggle("Delete a run's own branches once its pull request has merged."),

  /* ---- what the autopilot may do by itself ---- */
  autoRecoverByDefault: toggle('New runs repair their own recoverable stops.'),
  autoContinueRecovery: toggle('When a repair leaves the board fixed, the run carries on by itself.'),
  watchCmdRefs: toggle('Run the cmd: watch commands sessions declare.'),
  watchMintedCmdRefs: toggle(
    "Also run the cmd: watch commands the console lifted out of a session's own polling.",
  ),
  mcpPolicy: word(
    MCP_POLICIES,
    'automation',
    'What a phase does when one of its MCP servers cannot be reached.',
  ),
  ladderPerPhaseRungs: number('count', 'Repair attempts per phase before a person is asked.'),
  ladderPerPhaseUsd: number('usd', 'Repair dollars per phase before a person is asked.'),
  ladderPerRunRungs: number('count', 'Repair attempts per run.'),
  ladderPerRunUsd: number('usd', 'Repair dollars per run.'),
  ladderPerDayUsd: number('usd', 'Repair dollars per day, across the console.'),
  ceilingStartsPerHour: number('count', 'Automatic session starts any one hour may hold; 0 is no limit.'),
  ceilingUsdPerHour: number(
    'usd',
    'Session dollars any one hour may hold before the next automatic start waits; 0 is no limit.',
  ),
  schedulingPolicy: word(
    SCHEDULING_POLICIES,
    'automation',
    'How the queue orders the phases waiting in it.',
    {
      writable: false,
      cli: `${QUEUE_POLICY} --policy <word>`,
    },
  ),
  schedulingPolicies: row('automation', 'map', "Each plan's own scheduling policy, over the console's.", {
    writable: false,
    cli: `${QUEUE_POLICY} --slug <plan> --policy <word>`,
  }),
  loadGuardFactor: number(
    'factor',
    'New work waits while the machine is busy: 1.5 holds at 85 % CPU over the last 30 s (the factor scales it) or a 5-minute load over this × cores × 2; 0 switches it off.',
    {
      writable: false,
      cli: `${QUEUE_POLICY} --load-factor <n>`,
    },
  ),
  usageForecastLeadHours: number(
    'hours',
    'How long before an account is projected to run out the console warns.',
  ),
  usageForecastHold: toggle('Also hold new work on an account projected to run out.'),
  unblockAttempts: toggle(
    'Give a phase blocked on something no machine can check one session allowed to do the work.',
  ),
  staleClaimTakeover: toggle('Take over an expired lock on unfinished work rather than wait on it.'),
  delegateHumanGates: toggle(
    "Let a phase's own session verify and clear an overdue gate the plan did not mark manual.",
  ),
  policy: row(
    'automation',
    'map',
    "This console's answers to the decision manifest's rows, below each plan's own.",
  ),
  allowUnverifiedPhases: toggle('Let a phase whose plan states no verification pass on its handoff alone.'),
  ladderExtendOnProgress: toggle('Grant one more repair attempt when the last one landed commits.'),
  resumeAtBoot: word(
    RESUME_AT_BOOT_MODES,
    'automation',
    'What happens to the runs a console restart stopped.',
  ),
  autoAccountSwitch: toggle('Switch a run to an account with room when it meets a usage or sign-in wall.'),
  convergeEveryMs: number(
    'ms',
    'How often the console re-reads every open plan when nothing happened; 0 switches the clock off.',
  ),
  budgetAutoRaisePct: number(
    'percent',
    'Raise a spent run budget once by this much; 0 switches the raise off.',
  ),
  mcpRequireTimeoutMs: number(
    'ms',
    'How long a phase parked for an MCP server it requires waits before it carries on without it; 0 waits indefinitely.',
  ),
  boardingSchedule: row(
    'automation',
    'map',
    'When this console starts phases: its boarding windows, quiet hours and openings.',
  ),
  relayRules: row(
    'automation',
    'list',
    "This console's answers to the questions a session asks, matched by question.",
  ),

  /* ---- when a live lane stops being work ---- */
  stallSilentMs: number('ms', 'No output for this long calls a lane silent.'),
  stallSpinTurns: number('count', 'This many turns in a row with no tool call call a lane spinning.'),
  stallStalemateAttempts: number(
    'count',
    'This many attempts in a row that committed nothing call a phase stalled.',
  ),
  stallRetryBurst: number(
    'count',
    'This many API retries in a row with nothing done between them call a lane retrying.',
  ),
  stallExternalWaitMs: number(
    'ms',
    "A command waiting on somebody else's clock this long parks the lane; 0 never does.",
  ),
  stallLocalJobMs: number(
    'ms',
    "A command waiting on the session's own job may stay open this long before the park applies.",
  ),
  stallLoopRun: number('count', 'This many repeats of one call in a row call a lane looping.'),
  stallAutomaticPark: toggle(
    "Let the stall watchdog park a lane waiting on somebody else's clock by itself.",
  ),
  stallEscalateMs: number(
    'ms',
    'How long an unresolved stall waits before it is said once more, urgently; 0 says it once.',
  ),

  /* ---- the check on Your turn ---- */
  checkJudgement: toggle(
    "Let a checking session read a judgement proof; off, the owner's word stands in for it.",
  ),
  checkModel: row('automation', 'string', 'The model a checking session runs as.'),
  checkEffort: word(EFFORT_LEVELS, 'automation', 'The effort a checking session runs at.'),
  turnEscalateAfter: number('count', 'Rejections of one item before it is escalated, once.'),

  /* ---- which categories are announced at all (`notify`) ---- */
  'notify.approval': notify('Permission needed'),
  'notify.session-ask': notify('A session waiting on you'),
  'notify.needs-you': notify('A phase that needs you'),
  'notify.gate': notify('A gate that needs a person'),
  'notify.qa': notify('A QA verdict owed or failed'),
  'notify.halted': notify('A halted run'),
  'notify.parked': notify('A parked or waiting run'),
  'notify.stalled': notify('A lane where nothing is happening'),
  'notify.phase': notify('A phase finished or failed'),
  'notify.finished': notify('A plan finished'),
  'notify.ready': notify('Work that became ready'),
  'notify.changed': notify('Plans changed on disk'),
  'notify.session': notify('A session that ended'),
  'notify.health': notify('Console problems'),
  'notify.limits': notify('Usage limits'),
  'notify.usage-climbing': notify('Usage climbing'),
  'notify.budget': notify('A budget spent or running low'),
  'notify.issue': notify('An issue a session drafted'),
  'notify.digest': notify('The hourly digest'),
  'notify.granted': notify('A permission granted'),

  /* ---- how long every sink is kept (`retention`) ---- */
  'retention.consoleLogMaxBytes': retention('bytes', "The console log's size before it rotates."),
  'retention.supervisorLogMaxBytes': retention(
    'bytes',
    "The size of the console's own output files before they are trimmed.",
  ),
  'retention.supervisorLogKeepBytes': retention('bytes', 'How much of their end a trim keeps.'),
  'retention.runRetainDays': retention('days', "How long a finished run's record is kept."),
  'retention.runRetainMin': retention('count', 'Runs kept per plan whatever their age.'),
  'retention.runsMaxBytes': retention(
    'bytes',
    "Every plan's runs together, oldest finished first past this.",
  ),
  'retention.taskInboxDays': retention('days', "How long a phase's task list is kept."),
  'retention.rulingsOversizedBytes': retention(
    'bytes',
    'A ruling ledger past this size is reported; rulings are never pruned.',
  ),
  'retention.outcomeInboxDays': retention('days', "How long a session's declared outcome is kept."),
  'retention.outcomeInboxMax': retention('count', 'Declared outcomes kept per plan, oldest going first.'),
  'retention.sessionEventsMaxBytes': retention('bytes', "One session's presence events before they are cut."),
  'retention.gitTraceLeftoverHours': retention('hours', 'A raw git trace nobody read goes after this long.'),
  'retention.gitTraceDirMaxBytes': retention(
    'bytes',
    "The console's git traces together, oldest first past this.",
  ),
  'retention.messagesRotateBytes': retention('bytes', "The message ledger's size before it rotates."),
  'retention.messagesRetainDays': retention('days', 'How long a rotated message ledger is kept.'),
  'retention.crashRetainDays': retention('days', 'How long crash records and their heap snapshots are kept.'),
  'retention.locksRotateBytes': retention('bytes', "The lock history's size before it rotates."),
  'retention.humanStepsRotateBytes': retention('bytes', "The human-step ledger's size before it rotates."),
  'retention.grantsRotateBytes': retention('bytes', "The grant ledger's size before it rotates."),
  'retention.handledRotateBytes': retention('bytes', "The handled log's size before it rotates."),
  'retention.turnEvidenceRetainDays': retention('days', 'How long evidence attached to an item is kept.'),
  'retention.turnEvidenceMaxBytes': retention(
    'bytes',
    'Every piece of attached evidence together, oldest first past this.',
  ),
  'retention.runWorktreeRetainDays': retention('days', 'A kept run checkout older than this is reported.'),
  'retention.runWorktreesMaxBytes': retention(
    'bytes',
    'Every kept run checkout together, reported past this.',
  ),
});

/** @param {PrefType} type @param {string} description @param {Partial<PrefMeta>} [extra] */
const machine = (type, description, extra = {}) =>
  row('profile', type, description, { writable: false, ...extra });

/**
 * The machine profile's fields (`~/.config/phase-console/fleet.json`,
 * `instances.mjs` `PROFILE_MACHINE_KEYS`) and this console's `autostart` — no
 * page writes them. In Pro each row names the line that changes it
 * (`profileCli`); the free CLI has neither verb, so there the file is edited
 * by hand.
 * @type {Readonly<Record<string, PrefMeta>>}
 */
export const PROFILE_META = Object.freeze({
  remoteHost: machine('string', "The host name another device reaches this machine's consoles at."),
  remoteUsers: machine('list', 'The sign-ins allowed to reach them from another device.'),
  // A command line may carry a token, and a webhook's URL is the whole
  // authorisation to post to its channel (`server/webhooks.ts`).
  notifyCommand: machine('string', 'A command this machine runs for every announcement.', { secret: true }),
  webhooks: machine('list', 'Addresses every announcement is posted to.', { secret: true }),
  categories: machine('map', 'Which announcement categories are on, for every console of the machine.'),
  quietHours: machine('map', 'When announcements stay quiet.'),
  maxSessions: machine('number', 'Live sessions allowed across every console of this machine.', {
    unit: 'count',
  }),
  hookScript: machine('string', 'The session-presence hook script every config dir points at.'),
  heapMb: machine('number', 'The memory a console may hold.', { unit: 'megabytes' }),
  heapSnapshotOnNearLimit: machine('boolean', 'Write a heap snapshot when a console nears its memory limit.'),
  autostart: machine('word', 'Whether this console starts its work unattended when it boots.', {
    words: AUTOSTART_WORDS,
  }),
});

