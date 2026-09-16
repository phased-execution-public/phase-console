/**
 * Runtime configuration: CLI flags, the persisted preferences file, and root
 * validation.
 *
 * Preferences live in `~/.config/phase-console/config.json` — never inside the
 * skill repo, which stays free of machine-local state.
 */

import { DEFAULT_STARTS_PER_HOUR, DEFAULT_USD_PER_HOUR } from './start-ceiling.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT, PORT_RANGE_SIZE, PORT_RANGE_START,
  configDir, defaultInstance, getInstance, instanceId, instancePrefsPath,
  instanceStateDir as sharedStateDir, isDefaultRoot,
  listInstances, preferredPort, profileFor, readProjectFile, registerInstance, reservedPorts,
  stateHome, unitName,
} from '../shared/instances.mjs';
import { STALL_DEFAULTS, STALL_ESCALATE_MS, STALL_LOCAL_JOB_MS } from '../shared/attention-model.js';
import {
  AUTOMATION_MAP, AUTOMATION_KEYS, toAutomation, fromAutomation, resumeAtBootMode,
  type ResumeAtBootMode,
} from '../shared/automation-model.js';
import { sanitisePolicyPrefs } from '../shared/policy-model.js';
import { sanitiseRelayRules, type RelayRule } from '../shared/relay-model.js';
import type { DecisionKey } from '../shared/decisions-model.js';
import { sanitiseSchedule, type SchedulePolicy } from '../shared/schedule-policy.js';
import {
  DEFAULT_SETTLE, isolationMode, settleOf, WORKTREE_DEFAULTS, reclaimModeOf,
  type IsolationReclaim,
  type IsolationMode, type SettleStrategy,
  worktreeRootOf,
  type WorktreeRoot,
} from '../shared/worktree-model.js';
import { sanitiseCategories, type CategoryId } from './push/catalogue.ts';
// Type-only, and it must stay that way: `runner/state.ts` imports `STATE_DIR`
// from here at runtime, so a value import would close the cycle. Node erases
// `import type` before it ever resolves the specifier.
import type { McpPolicy } from './runner/state.ts';
import type { GitMode, ReviewerPolicy } from '../shared/run-lifecycle.js';

export const VIEWER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = dirname(VIEWER_DIR);

/**
 * Lanes allowed live at once, before anyone says otherwise. See `Flags.maxSessions`.
 *
 * Lives here rather than in `scheduler.ts` only because of the import graph —
 * `log.ts` reads this module, so a config that reached back into the scheduler
 * would close a cycle. The scheduler imports it from here instead.
 */
export const DEFAULT_MAX_SESSIONS = 3;

export type Flags = {
  root?: string;
  port: number;
  host: string;
  open: boolean;
  allowWrites: boolean;
  /**
   * Separate from `allowWrites` on purpose. A write scaffolds a file; a run
   * spawns agent sessions that edit a repo for hours. Same server, very
   * different blast radius, so they are two decisions.
   */
  allowRun: boolean;
  /**
   * The convergence loop's AUTOMATIC triggers — boot, docs change, the
   * periodic sweep, the minute after a halt (`server/converge.ts`). On by
   * default from the command line (`--no-converge` turns it off); read as off
   * when absent, which is what a bare harness constructs — so a test that
   * drives the healer by hand is never raced by a boot pass it did not ask
   * for. The operator's own Recover & continue press converges regardless.
   * Needs `--allow-run` to do anything: the loop only ever acts through runs.
   */
  converge?: boolean;
  /**
   * A third decision again, not a wider reading of the other two. `--allow-run`
   * spawns a supervised agent inside a policy this console enforces;
   * `--allow-terminal` hands over an unsupervised shell, where the policy is
   * whatever the person typing knows. Same machine, different promise.
   */
  allowTerminal: boolean;
  /**
   * A fourth decision. An agent session is an interactive `claude` in the
   * browser terminal: supervised by the person watching it, not by this
   * console's policy. It is less than `--allow-terminal` (the argv is built
   * server-side from allowlisted fields, and the CLI asks before it acts) but
   * more than `--allow-run` (no deny-list settings file, no approval hook in
   * front of it) — so it is its own flag, not a reading of either.
   */
  allowAgent: boolean;
  /**
   * A fifth decision. Accounts are stored Claude credentials — profile config
   * dirs a person signs into and long-lived tokens they paste — that runs and
   * sessions can then be started under. Registering one is a credential-holding
   * act, distinct from spawning anything, so it gets its own flag. Reading the
   * list and the usage meters is not gated: watching your own quota is display,
   * not capability.
   */
  allowAccounts: boolean;
  /**
   * A sixth decision. Registering an MCP server tells this console's sessions
   * to connect to somebody else's tools — a database, an issue tracker, a
   * remote endpoint that returns text a model will act on. That is a distinct
   * act from spawning a session (`--allow-run`) and from holding a Claude login
   * (`--allow-accounts`): an MCP server is a *supply chain*, whose tool
   * descriptions enter the prompt and whose results are attacker-controllable
   * if the server is. So it gets its own flag.
   *
   * Reading the list, the catalog and the connection status is not gated:
   * seeing what your own sessions connect to is display, not capability.
   */
  allowMcp: boolean;
  /**
   * A seventh decision. A webhook is this console making an unattended outbound
   * POST to a URL somebody typed, on every matching event, for as long as the
   * row lives — from a laptop that sits inside a private network. That is a
   * different act from anything the other six license: they all widen what may
   * happen *here*, and this one sends what happened here somewhere else.
   *
   * So it is a flag, it is off, and it is read at DELIVERY time rather than only
   * at registration — a console started without it makes no outbound request
   * even with rows already on disk from a day it was started with it. Reading
   * the registered list is not gated: seeing where your own console would speak
   * is display, and the URLs are never served back anyway.
   */
  allowWebhooks: boolean;
  /**
   * Hostnames this console answers to besides localhost, reached through an
   * authenticating proxy that puts the caller's identity in a header.
   *
   * Empty — the default — means the console is local-only and every Host is
   * treated exactly as it was before this existed. Naming even one turns on
   * strict Host validation, so an unknown Host is refused rather than served.
   */
  remoteHosts: string[];
  /** Logins allowed to arrive through `remoteHosts`. See `server/api/access.ts`. */
  remoteUsers: string[];
  scriptsDir: string;
  /**
   * How many phase sessions may be live across THIS console at once.
   *
   * A ceiling on the console, not on the scheduler's judgement: scope decides
   * whether two phases *may* overlap, and this decides how many this console
   * starts. Three is a deliberate default — each lane is a full `claude`
   * process with its own context, and the account's usage window is shared
   * between them, so the fourth lane usually buys throttling rather than
   * throughput. `--max-sessions`, or `PHASE_CONSOLE_MAX_SESSIONS`.
   *
   * It is per console, and it used to be documented as a ceiling on the
   * machine (FLT-7) — two consoles each admitted up to their own. The MACHINE
   * ceiling is `fleet.json` `maxSessions`, held across every console through
   * one lane token per live lane (`server/fleet.ts MachineLanes`).
   */
  maxSessions: number;
  /**
   * Skills every run of every plan starts with, unless the operator says
   * otherwise when starting it.
   *
   * A MACHINE-level default, which is the level the need actually lives at: a
   * skill that maintains state about the repositories on this machine (a
   * knowledge graph, an index) is wanted by every phase of every plan, and
   * saying so once in the launch environment beats naming it in eighty-six
   * plans. It seeds `RunState.skills` at start and then stops mattering — the
   * run's own list is the single truth from that moment, so unchecking one in
   * the console is a real "off" and not a preference the next tick overrides.
   * `--default-skills a,b`, or `PHASE_CONSOLE_DEFAULT_SKILLS`.
   */
  defaultSkills: string[];
  /** Where the structured log goes. `null` disables file logging entirely. */
  logFile: string | null;
  /**
   * What this console took from the machine profile (`fleet.json`, zero-touch
   * phase 17, FLT-3) and where each setting it runs with came from — a flag or
   * the environment beats this console's own `overrides`, which beat the
   * machine-wide value. On `state().profile`, so an inherited or overridden
   * setting is visible rather than a surprise. Absent on a hand-built `Flags`.
   */
  profile?: ProfileInheritance;
};

/** Where one setting a console runs with came from. */
export type ProfileSource = 'flag' | 'env' | 'override' | 'profile';

export type ProfileInheritance = {
  /** The profile file read at boot, and whether it exists. */
  path: string;
  present: boolean;
  /** Each setting the profile could supply, with the source of the value in force. */
  sources: Partial<Record<'remoteHosts' | 'remoteUsers' | 'notifyCommand' | 'webhooks' | 'categories' | 'quietHours' | 'maxSessions', ProfileSource>>;
  /** Profile fields this console overrides for itself (`instances.<id>.overrides`). */
  overridden: string[];
};

/**
 * The operator's out-of-band notifier: `PHASE_CONSOLE_NOTIFY`, else the machine
 * profile's `notifyCommand` (this console's override first). Still never a
 * browser-settable preference — it runs a command on this machine, and the
 * profile is a file only a shell writes.
 */
export function notifyCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PHASE_CONSOLE_NOTIFY) return env.PHASE_CONSOLE_NOTIFY;
  try {
    return profileFor(INSTANCE.id, env).notifyCommand ?? null;
  } catch {
    return null;
  }
}

/**
 * Machine-local state that is neither preference nor repo content: the log,
 * and (once the runner lands) run journals and checkpoints. XDG puts this under
 * `~/.local/state`, which is exactly the "survives a reboot, means nothing on
 * another machine" category these files belong to.
 */
export const STATE_DIR = stateHome();

/* ------------------------------------------------------------------ *
 * Which console is this?
 * ------------------------------------------------------------------ */

/**
 * The identity of this process, resolved once — before anything computes a path.
 *
 * It has to be this early, and that is the whole reason this block sits above
 * everything else rather than beside the preferences it feels related to. The
 * log file, the notification inbox, the push keys and the approvals queue are
 * all module-level constants in their own files, computed the moment those
 * modules load. Resolving the instance any later would mean those constants had
 * already been computed from the shared directory, and a second console would
 * be writing into the first one's state while reporting its own id — the exact
 * failure this phase exists to remove, made invisible.
 *
 * So the argv is pre-scanned here rather than waiting for `parseFlags()`. The
 * duplication with `parseFlags` is deliberate and small: two readings of
 * `--root` that could disagree would be a bug, so this one reads the same two
 * spellings and the same environment variable, and `parseFlags` remains the
 * only reading anything else uses.
 */
export type Instance = {
  id: string;
  name: string;
  /** The project this console serves — `null` until someone picks one. */
  root: string | null;
  /**
   * The instance that keeps the legacy footprint: flat `STATE_DIR`, port 4123,
   * the bare unit label. Exactly one machine-wide, and on a machine that has
   * only ever run one console it is that console — which is what makes the
   * upgrade to a multi-instance build a no-op for a single-project user.
   */
  default: boolean;
  /**
   * A non-default console serves one project and refuses to be repointed. The
   * default keeps the picker, because it is also the console someone opens with
   * no root at all to go looking for one.
   */
  pinned: boolean;
};

/** `--root`/`-r`, `--instance`, and the environment — read before flags exist. */
function preScanIdentity(argv: string[], env: NodeJS.ProcessEnv): { root: string | null; selector: string | null } {
  let root: string | null = null;
  let selector: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--root' || arg === '-r') && argv[i + 1]) root = resolve(expandHome(argv[++i]));
    else if (arg === '--instance' && argv[i + 1]) selector = argv[++i];
  }
  if (!root && env.PHASE_CONSOLE_ROOT) root = resolve(expandHome(env.PHASE_CONSOLE_ROOT));
  if (!selector && env.PHASE_CONSOLE_INSTANCE) selector = env.PHASE_CONSOLE_INSTANCE;
  return { root, selector };
}

/**
 * Work out who we are from argv, the environment and the registry.
 *
 * Exported and parameterised so a test can ask the question without spawning a
 * console; `INSTANCE` below is this function applied to the real process.
 *
 * A console started with no root is the default one. That is not a fallback so
 * much as the honest reading: with no project named there is nothing to derive
 * an identity from, and the thing an operator is looking at is the picker — the
 * single-console experience that predates instances entirely.
 */
export function resolveInstance(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Instance {
  const { root: argRoot, selector } = preScanIdentity(argv, env);

  // `--instance <id-or-name>` names a console that has been registered before,
  // and supplies its root. `--root` still wins if both are given: naming a path
  // is more specific than naming a bookmark.
  let root = argRoot;
  let named: ReturnType<typeof getInstance> = null;
  if (selector) {
    const entries = listInstances(env);
    named = entries.find((entry) => entry.id === selector)
      ?? entries.find((entry) => entry.name === selector)
      ?? null;
    if (named && !root) root = named.root;
  }

  if (!root) {
    const fallback = named ?? defaultInstance(env);
    return {
      id: fallback?.id ?? 'default',
      name: fallback?.name ?? 'default',
      root: fallback?.root ?? null,
      default: true,
      pinned: false,
    };
  }

  const id = instanceId(root);
  const registered = getInstance(id, env);
  const isDefault = isDefaultRoot(root, env);
  return {
    id,
    name: registered?.name ?? readProjectFile(root, env).name ?? (basename(root) || id),
    root,
    default: isDefault,
    pinned: !isDefault,
  };
}

/**
 * This process's instance.
 *
 * A read, never a write. Persisting the entry is `claimInstance()`, called once
 * the server knows what port it actually bound — writing at import time would
 * mean every tool that merely reads this module minted a registry entry.
 *
 * The one race that leaves: two consoles starting within the same instant on a
 * machine whose registry is completely empty would both read "no default yet"
 * and both claim it. It survives exactly one start — from the second onward the
 * registry answers — and the cost is two consoles sharing a log, which is what
 * they did in every version before this one.
 */
export const INSTANCE: Instance = resolveInstance();

/**
 * Where this instance's machine-local state lives.
 *
 * The default instance returns the flat legacy directory unchanged — no moves,
 * no renames, no migration step. That is the promise the whole design is built
 * around: an operator upgrading into a multi-instance console keeps their
 * running agent, their log path and, most importantly, their existing phone
 * push subscriptions, because the files those live in never moved.
 */
export function instanceStateDir(instance: Instance = INSTANCE): string {
  return sharedStateDir(instance.id, instance.default);
}

/** This instance's state directory, resolved once for the module-level consts. */
export const INSTANCE_STATE_DIR = instanceStateDir(INSTANCE);

export function defaultLogFile(): string {
  return join(INSTANCE_STATE_DIR, 'console.log');
}

/**
 * The unit labels a console installed before instances existed answers to.
 *
 * The unit's name is baked at install time, and the default instance
 * keeps them — P6 generates `com.phase-console.<id>` for the others. An adopted
 * entry records the bare label so the lifecycle verbs can find the agent that
 * is already loaded rather than installing a second one beside it.
 */
export const LEGACY_UNIT = unitName({ id: 'default', default: true });

/**
 * Has this machine been running a console since before instances existed?
 *
 * Any one of these is proof: a preferences file, a log where the flat layout
 * put it, or a loaded agent announcing itself through the environment. The
 * question is worth asking because the answer decides whether the first
 * registry entry is an *adoption* — inheriting a footprint, a port and a unit
 * that already exist — or simply the first instance on a clean machine. Both
 * become the default; only the first has anything to inherit.
 */
export function legacyFootprint(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(CONFIG_FILE)
    || existsSync(join(STATE_DIR, 'console.log'))
    || Boolean(env.PHASE_CONSOLE_UNIT);
}

/**
 * Settle whether this console is the machine's default, inside the registry lock.
 *
 * Separate from `claimInstance` and called far earlier, because the answer
 * decides which state directory this process is already pointed at, and there
 * is exactly one moment when that is still actionable: before anything writes.
 * `INSTANCE.default` was read at module load, OUTSIDE the lock — writing it
 * back as a literal `true` demotes whichever console won the race in between
 * and leaves two processes on one log, one set of push keys, one approvals
 * queue, which is the failure `test/instances.test.ts` opens by calling "worth
 * testing for, because it is silent".
 *
 * `'auto'` resolves the election inside `withRegistry`'s lock and never demotes
 * an incumbent. Losing is not fixable in-process — `INSTANCE_STATE_DIR` and the
 * notification, push, approvals, accounts and MCP paths built on it are
 * module-level consts — so `index.ts` treats a loss the way it treats
 * incoherent access flags: a refusal to start, before the port opens.
 */
export function electInstance(
  instance: Instance = INSTANCE,
): { default: boolean; lost: boolean; winner: string | null } {
  if (!instance.root) return { default: instance.default, lost: false, winner: null };
  const elected = registerInstance(instance.root, {
    name: instance.name,
    default: instance.default ? 'auto' : undefined,
  });
  const isDefault = elected?.default === true;
  const lost = instance.default && !isDefault;
  return { default: isDefault, lost, winner: lost ? (defaultInstance()?.name ?? null) : null };
}

/**
 * Record this instance in the registry, now that its port is a fact.
 *
 * Called from `index.ts` on `listen`, with the port the OS actually gave us
 * rather than the one we asked for. Those differ whenever a probe walked past a
 * busy port, and the registry is only useful if it holds the port that would
 * actually answer.
 *
 * The default is NOT decided here — `electInstance` settled it at startup,
 * before anything wrote. This reads the settled answer back rather than
 * restating the guess this process made at module load: writing `default: true`
 * from here demoted whichever console had won in between and left two processes
 * on one state directory.
 *
 * This is also where adoption happens, and it is deliberately not a migration
 * step: nothing moves, nothing is renamed, nothing is copied. A machine that
 * has been running one console simply gains a registry entry *describing* the
 * console it already had — same paths, same port, same unit label. The
 * subscriptions on the operator's phone keep working because the files behind
 * them were never touched. Re-running it is a no-op beyond the pid and clock.
 */
export function claimInstance(port: number, extra: { unit?: string } = {}): void {
  if (!INSTANCE.root) return;
  // The registry's answer, not ours. `electInstance` ran at startup; if it is
  // somehow absent (a caller that never elected) an unregistered root reads as
  // the default exactly as it always did.
  const isDefault = getInstance(INSTANCE.id)?.default === true || (INSTANCE.default && !listInstances().length);
  // The unit label depends on that answer: the bare legacy label belongs to the
  // default instance, and handing it to a loser would put two units under one name.
  const adopting = isDefault && legacyFootprint();
  registerInstance(INSTANCE.root, {
    name: INSTANCE.name,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unit: extra.unit ?? process.env.PHASE_CONSOLE_UNIT ?? (adopting ? LEGACY_UNIT : undefined),
  });
}

export function parseFlags(argv: string[], instance: Instance = INSTANCE): Flags {
  // Sentinel rather than a default, because "the operator did not say" and "the
  // operator said 4123" are different answers: the first defers to the project
  // file and the registry, the second beats both.
  let explicitPort: number | undefined;
  let usersFromFlag = false;
  const flags: Flags = {
    port: 0,
    host: '127.0.0.1',
    // Starting the console should show you the console. Opt out with --no-open
    // (or PHASE_CONSOLE_NO_OPEN=1, which scripts and tests use).
    open: process.env.PHASE_CONSOLE_NO_OPEN !== '1',
    allowWrites: false,
    allowRun: false,
    converge: true,
    allowTerminal: false,
    allowAgent: false,
    allowAccounts: false,
    allowMcp: false,
    allowWebhooks: false,
    remoteHosts: [],
    remoteUsers: splitList(process.env.PHASE_CONSOLE_REMOTE_USERS),
    scriptsDir: join(SKILL_DIR, 'scripts'),
    maxSessions: positive(process.env.PHASE_CONSOLE_MAX_SESSIONS) ?? DEFAULT_MAX_SESSIONS,
    defaultSkills: splitList(process.env.PHASE_CONSOLE_DEFAULT_SKILLS),
    logFile: process.env.PHASE_CONSOLE_LOG === '' ? null : (process.env.PHASE_CONSOLE_LOG ?? defaultLogFile()),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--root' || arg === '-r') flags.root = resolve(expandHome(next() ?? ''));
    else if (arg === '--port' || arg === '-p') explicitPort = Number(next());
    else if (arg === '--instance') next();   // read by resolveInstance() before flags exist
    // `||`, not `??`: `--host ''` is not "bind to nothing", it is
    // `listen(port, '')`, which Node reads as unspecified and binds every
    // interface. An empty value means the operator did not say.
    else if (arg === '--host') flags.host = next() || flags.host;
    else if (arg === '--open') flags.open = true;
    else if (arg === '--no-open') flags.open = false;
    else if (arg === '--allow-writes') flags.allowWrites = true;
    else if (arg === '--allow-run') flags.allowRun = true;
    else if (arg === '--no-converge') flags.converge = false;
    else if (arg === '--allow-terminal') flags.allowTerminal = true;
    else if (arg === '--allow-agent') flags.allowAgent = true;
    else if (arg === '--allow-accounts') flags.allowAccounts = true;
    else if (arg === '--allow-mcp') flags.allowMcp = true;
    else if (arg === '--allow-webhooks') flags.allowWebhooks = true;
    else if (arg === '--remote') flags.remoteHosts.push(...splitList(next()));
    else if (arg === '--remote-user') { usersFromFlag = true; flags.remoteUsers.push(...splitList(next())); }
    else if (arg === '--scripts') flags.scriptsDir = resolve(expandHome(next() ?? ''));
    else if (arg === '--max-sessions') flags.maxSessions = positive(next()) ?? flags.maxSessions;
    // Repeatable and additive to the environment, like --remote: an operator
    // adding one for a session should not have to restate what the plist bakes in.
    else if (arg === '--default-skills') flags.defaultSkills.push(...splitList(next()));
    else if (arg === '--log-file') flags.logFile = resolve(expandHome(next() ?? ''));
    else if (arg === '--no-log-file') flags.logFile = null;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  flags.profile = inheritProfile(flags, instance, usersFromFlag);
  // Hostnames and logins are compared, never displayed, so they are folded once
  // here rather than at every comparison site.
  flags.remoteHosts = unique(flags.remoteHosts.map((h) => h.toLowerCase().replace(/\.$/, '')));
  flags.remoteUsers = unique(flags.remoteUsers.map((u) => u.toLowerCase()));
  // A skill id is what `/name` or `/plugin:name` accepts and nothing else: these
  // go straight into a child's boot prompt, so anything shaped wrong is dropped
  // here rather than named at a session that cannot invoke it.
  flags.defaultSkills = unique(flags.defaultSkills.filter((id) => SKILL_ID.test(id))).slice(0, 40);
  // Last, because the whole chain below `--port` depends on which project this
  // is, and `--root` may have been anywhere in the argv.
  flags.port = preferredPort(instance.root ?? flags.root ?? '.', {
    flagPort: explicitPort,
    isDefault: instance.default,
  });
  return flags;
}

/**
 * Fill what the operator did not say from the machine profile (FLT-3).
 *
 * Per field, flags and the environment first — an operator who types
 * `--remote` wins an argument with a file — then this console's `overrides`,
 * then the machine-wide value. Remote access is inherited as a PAIR where it
 * has to be: a profile host with no login anywhere, or logins with no host,
 * would make `flagsRefusal` stop a console from booting over a half-written
 * file, so a half is left alone and the console boots local-only.
 */
function inheritProfile(flags: Flags, instance: Instance, usersFromFlag: boolean): ProfileInheritance {
  let inherited: ReturnType<typeof profileFor>;
  try {
    inherited = profileFor(instance.id);
  } catch {
    return { path: '', present: false, sources: {}, overridden: [] };
  }
  const sources: ProfileInheritance['sources'] = {};
  if (flags.remoteHosts.length) sources.remoteHosts = 'flag';
  if (flags.remoteUsers.length) sources.remoteUsers = usersFromFlag ? 'flag' : 'env';
  const profileUsers: string[] = inherited.remoteUsers ?? [];
  if (!flags.remoteHosts.length && inherited.remoteHost && (flags.remoteUsers.length || profileUsers.length)) {
    flags.remoteHosts = [inherited.remoteHost];
    sources.remoteHosts = inherited.sources.remoteHost;
  }
  if (flags.remoteHosts.length && !flags.remoteUsers.length && profileUsers.length) {
    flags.remoteUsers = [...profileUsers];
    sources.remoteUsers = inherited.sources.remoteUsers;
  }
  if (process.env.PHASE_CONSOLE_NOTIFY) sources.notifyCommand = 'env';
  else if (inherited.notifyCommand) sources.notifyCommand = inherited.sources.notifyCommand;
  for (const key of ['webhooks', 'categories', 'quietHours'] as const) {
    if (inherited[key] !== undefined) sources[key] = inherited.sources[key];
  }
  if (inherited.maxSessions != null) sources.maxSessions = 'profile';
  return { path: inherited.path, present: inherited.present, sources, overridden: inherited.overridden };
}

/**
 * A port that is actually free, starting from the one we would prefer.
 *
 * Two different reasons to walk past a port, and both matter: it is *bound*
 * (something is listening, ours or not), or it is *spoken for* (another
 * instance registered it and merely is not running this second). Skipping only
 * the first would let a stopped console lose its port to a sibling and come
 * back to an EADDRINUSE it did nothing to deserve.
 *
 * An explicit `--port` is never probed past. Someone who names a port wants
 * that port, and silently serving a different one is how you spend twenty
 * minutes reloading a URL that was answering all along.
 */
export async function resolvePort(
  preferred: number, host: string, instance: Instance = INSTANCE, explicit = false,
): Promise<number> {
  if (explicit || preferred === DEFAULT_PORT) return preferred;
  const taken = reservedPorts(instance.root ?? undefined);
  const limit = PORT_RANGE_START + PORT_RANGE_SIZE;
  for (let port = preferred; port < limit; port++) {
    if (taken.has(port)) continue;
    if (await portIsFree(port, host)) return port;
  }
  return preferred;   // nothing free in the range: fail loudly on bind, not here
}

function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.listen(port, host, () => probe.close(() => resolveFree(true)));
  });
}

/**
 * Ask whatever is on this port whether it is a console, and whose.
 *
 * The registry can only say who *registered* a port; a stale entry and a
 * process that never released it look identical from there. `/api/state`
 * answers from the process actually holding the socket, which turns "port 4123
 * is in use" from a guess into a fact — and distinguishes the two cases an
 * operator cares about: their own other console (open it) versus something
 * unrelated squatting the port (move).
 *
 * One second, then give up: this runs on the failure path of a start, and a
 * hung probe would turn a clear error into a hang.
 */
export async function probeConsole(
  port: number, host: string,
): Promise<{ root: string | null; instance?: { id: string; name: string } } | null> {
  try {
    const response = await fetch(`http://${host}:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const state = await response.json() as { root?: { path?: string }; instance?: { id: string; name: string } };
    return { root: state.root?.path ?? null, instance: state.instance };
  } catch {
    return null;   // not a console, not answering, or not ours to read
  }
}

/**
 * Whether agent sessions are enabled.
 *
 * Every consumer (the Terminals registry, `/api/state`, the route guard) asks
 * this function rather than reading the flag, so folding the capability into
 * `--allow-terminal` — if an operator ever prefers three flags to four — is
 * this one return expression: `flags.allowAgent || flags.allowTerminal`.
 */
export function agentEnabled(flags: Flags): boolean {
  return flags.allowAgent;
}

/**
 * A whole number of lanes, or nothing.
 *
 * `--max-sessions 0` and `--max-sessions banana` both mean the caller wanted
 * something this cannot give them, and the safe reading of both is "you did not
 * say" rather than "run nothing at all" — a console that silently admits no
 * phases looks exactly like a console whose scheduler is broken.
 */
function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A skill id: what `/name` or `/plugin:name` accepts, and nothing else.
 *
 * The same expression `api/routes.ts` checks a browser's list against — kept
 * separately rather than imported because routes reads config and not the other
 * way round, and one shared constant here would close an import cycle for a
 * regular literal.
 */
const SKILL_ID = /^[a-z0-9][\w.-]{0,63}(:[a-z0-9][\w.-]{0,63})?$/i;

/** `a,b, c` and `a` both mean the same thing, and neither may contain blanks. */
function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * A loopback bind address, and nothing else.
 *
 * An allowlist, and deliberately NOT `api/access.ts`'s `LOOPBACK`: that set
 * answers a question about the *Host header* a local browser sends, so it
 * contains `0.0.0.0` — which as a BIND address means the exact opposite, every
 * interface on the machine. One shared set would turn this check off in the
 * single case it exists for. Everything unrecognised is non-loopback, the empty
 * string included: `listen(port, '')` binds every interface too.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice('::ffff:'.length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The capability flags, worst blast radius first — the order a refusal names
 * them in. One list, so an eighth flag cannot be added without appearing here.
 *
 * `--allow-webhooks` sits below the session-spawning flags and above writes: it
 * cannot run anything, but unlike a write it leaves the machine, and on a wide
 * bind it is the one that turns an open port into somebody else's outbound
 * request generator.
 */
const CAPABILITY_FLAGS: ReadonlyArray<readonly [string, (flags: Flags) => boolean]> = [
  ['--allow-run', (f) => f.allowRun],
  ['--allow-terminal', (f) => f.allowTerminal],
  ['--allow-agent', (f) => f.allowAgent],
  ['--allow-accounts', (f) => f.allowAccounts],
  ['--allow-mcp', (f) => f.allowMcp],
  ['--allow-webhooks', (f) => f.allowWebhooks],
  ['--allow-writes', (f) => f.allowWrites],
];

/**
 * Refuse to start rather than start wrong.
 *
 * `--remote` widens who can reach a console that may be able to spawn agent
 * sessions. Doing that with no allowlist is never what anyone meant, and the
 * failure would be silent — the console would come up looking correct and let
 * the whole tailnet in. So it is a startup error, not a warning.
 *
 * Returns the message to print, or `null` when the flags are coherent.
 */
export function flagsRefusal(flags: Flags): string | null {
  // The bind comes first, because it is the only one of these that another flag
  // cannot make safe. `--remote` puts an authenticating proxy in front of a
  // console that STAYS on loopback; the identity header it sets is worth
  // something only because nothing else can reach the port. A wide bind voids
  // that, and it voids the approval hook with it — `service-base.ts` addresses
  // the child sessions' callback from this same value, and that hook fails open.
  if (!isLoopbackHost(flags.host)) {
    const capability = CAPABILITY_FLAGS.find(([, on]) => on(flags));
    if (capability) {
      return `--host ${flags.host || '(empty)'} binds this console to every network interface, and ${capability[0]} is on.\n`
        + '  Nothing in front of that port authenticates anyone. The supported way to reach a\n'
        + '  console from another machine keeps the bind on 127.0.0.1 and puts an authenticating\n'
        + `  proxy in front of it:  --remote <hostname> --remote-user <login>\n`
        + `  ${DOCS_URL}/phone.md`;
    }
    if (flags.remoteHosts.length) {
      return `--host ${flags.host || '(empty)'} cannot be combined with --remote.\n`
        + '  --remote trusts the Tailscale-User-Login header, and that header is only worth\n'
        + '  anything because nothing but the proxy can reach the port. On a wide bind any\n'
        + '  caller sends it themselves. Drop --host: --remote deliberately does not widen it.';
    }
  }
  if (flags.remoteHosts.length && !flags.remoteUsers.length) {
    return '--remote needs at least one --remote-user (or PHASE_CONSOLE_REMOTE_USERS).\n'
      + '  Without one, every request arriving at that hostname would be accepted.';
  }
  if (!flags.remoteHosts.length && flags.remoteUsers.length) {
    return '--remote-user does nothing without --remote <hostname>.';
  }
  const bad = flags.remoteHosts.find((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h));
  if (bad) return `--remote ${bad} is not a hostname. Give the name the proxy serves, with no scheme or port.`;
  return null;
}

/**
 * Coherent, but worth saying out loud once.
 *
 * A wide bind with no capability flag and no `--remote` is not a refusal: a
 * read-only console inside a container has to bind `0.0.0.0` for a published
 * port to reach it, and that is a real thing people do. It is still not
 * private — `classify()` admits every caller when `--remote` is unset, so the
 * plan library, every run journal and session transcript, the account list and
 * the `POST /api/prefs` and `/api/root` verbs are all reachable from whatever
 * network that interface is on. Said at start rather than discovered.
 */
export function flagsWarning(flags: Flags): string | null {
  if (isLoopbackHost(flags.host)) return null;
  return `--host ${flags.host || '(empty)'} is not loopback. Anyone who can reach this port can read\n`
    + '  every plan, run journal and session transcript, and can repoint the source directory.\n'
    + '  To reach a console from elsewhere, keep the bind and use --remote <hostname>\n'
    + '  --remote-user <login> behind a proxy that authenticates the caller.';
}

/**
 * Where the long-form docs are, for anything a user reads at runtime.
 *
 * `docs/` is on the never-ship list (`.github/scripts/assert-tarball.sh`), so an
 * packaged copy has no `docs/` directory at all — a message that says
 * "see docs/webhooks.md" is a pointer to a file a packaged copy does not
 * have. Cite this instead of a repo-relative path in anything that reaches a
 * user: `--help`, a refusal, the in-app guide. Repo-relative paths are still
 * right in `docs/`, `references/` and `viewer/README.md`, which are read from a
 * clone and gated on resolving by `docs-parity.test.ts`.
 */
export const DOCS_URL = 'https://github.com/phased-execution-public/phase-console/blob/main/docs';

function printHelp(): void {
  process.stdout.write(`Phase Console — local viewer for phased-execution plans

  node server/index.ts [options]

  --root <dir>      open this source directory immediately (skips the picker)
  --port <n>        port to listen on (default 4123)
  --host <addr>     interface to bind (default 127.0.0.1 — localhost only)
`
    // The help text is PRINTED, so a marker inside the literal would be printed
    // too — the heredoc trap, in the one place a user is guaranteed to look.
    // The region is a concatenation instead, and the markers are real code.
    + `  --open            open the browser (the default; overrides PHASE_CONSOLE_NO_OPEN)
  --no-open         do not open the browser
  --allow-writes    enable the guarded write verbs (scaffold, QA record, locks)
  --allow-run       enable the autopilot: spawn \`claude -p\` sessions per phase
  --no-converge     keep the autopilot's convergence loop (boot / change / timer /
                    after-halt passes over stopped runs) off; Recover & continue still works
  --allow-terminal  enable the Terminal page: a real shell over a WebSocket,
                    running as you, with no policy in front of it
  --allow-agent     enable the Agent page: interactive \`claude\` sessions in the
                    browser terminal, and the "New plan with AI" wizard
  --allow-accounts  enable Claude account registration for this instance: sign
                    additional accounts in, paste setup-tokens, pick an account
                    per run. Usage meters are shown regardless.
  --allow-mcp       enable MCP server registration for this instance: add
                    servers, hold their credentials, attach them to plans and
                    phases. Connection status and the catalog are shown regardless.
  --allow-webhooks  enable outbound webhooks: POST the same announcements this
                    console already makes to URLs you register (Slack, Discord,
                    Telegram, your own relay). Off means no outbound request is
                    made at all, whatever is registered.
                    See ${DOCS_URL}/webhooks.md
  --remote <host>   also answer to this hostname, fronted by an authenticating
                    proxy (e.g. \`tailscale serve\`). Repeatable. Turns on strict
                    Host checking, so any other Host is refused.
  --remote-user <l> a login allowed to arrive via --remote. Repeatable; also
                    PHASE_CONSOLE_REMOTE_USERS. Required by --remote.
  --default-skills <csv>
                    skills every new run starts with, on top of anything the
                    plan names. Repeatable; also PHASE_CONSOLE_DEFAULT_SKILLS.
                    Seeds the run at start — unchecking one in the console is
                    then a real "off" for that run.
  --max-sessions <n>
                    how many sessions may run at once, across every plan
                    (default ${DEFAULT_MAX_SESSIONS}; also PHASE_CONSOLE_MAX_SESSIONS)
  --scripts <dir>   phased-execution scripts dir (default: the skill this lives in)
  --log-file <p>    structured log (default ${defaultLogFile()})
  --no-log-file     log to stderr only
`);
}

/* ------------------------------------------------------------------ *
 * Which client is being served
 * ------------------------------------------------------------------ */

export const DIST_DIR = join(VIEWER_DIR, 'client', 'dist');

let distRevCache: { at: number; value: string | null } | null = null;

/**
 * The commit `client/dist` was built from — `dist/.build-rev`, cached briefly.
 *
 * `null` means no readable stamp (no build, or one old enough to predate
 * stamping); the literal `unknown` (a tarball build) passes through, because
 * "built from an unknowable commit" and "not built" are different answers.
 * Cached like `serverIsStale`'s probe: `/api/state` is polled and the disk is
 * not the interesting part of that poll.
 */
export function distRev(): string | null {
  const now = Date.now();
  if (distRevCache && now - distRevCache.at < 5_000) return distRevCache.value;
  let value: string | null = null;
  try { value = readFileSync(join(DIST_DIR, '.build-rev'), 'utf8').trim() || null; }
  catch { /* not built, or unstamped */ }
  distRevCache = { at: now, value };
  return value;
}

/**
 * Which client this console can serve, as a live fact rather than a startup one.
 *
 * The built client (`client/dist/`) is the only client — the legacy `web/`
 * retired with the rewrite. `dist` is gitignored, so every machine builds its
 * own copy (`npm ci && npm run build`).
 * The check stays per request, so a build cuts a running console over
 * without a restart — which is exactly why it has to be reportable: with the
 * answer moving underneath a long-lived process, "which client am I actually
 * looking at" was otherwise only answerable by reading the startup log, and the
 * startup log records the answer from hours ago.
 */
export function staticRoot(): 'dist' | 'not-built' {
  return existsSync(join(DIST_DIR, 'index.html')) ? 'dist' : 'not-built';
}

/** The directory `staticRoot()` names — `null` until a build exists. */
export function staticRootDir(): string | null {
  return staticRoot() === 'dist' ? DIST_DIR : null;
}

/* ------------------------------------------------------------------ *
 * Is the code on disk newer than the code we are running?
 * ------------------------------------------------------------------ */

const BOOTED_AT = Date.now();
let mtimeCache: { at: number; newest: number } | null = null;

/**
 * Node reads the server once, at startup. Pulling the skill — or editing it —
 * under a running console leaves a process executing code that no longer exists
 * on disk, while the browser happily loads the new client from the same
 * directory. Every symptom of that is misleading: a route that 404s, a fix that
 * "did not work", an error that was corrected twenty minutes ago.
 *
 * So the console checks its own freshness and says so, because the alternative
 * is the operator debugging a version they are not running.
 */
export function serverIsStale(): boolean {
  const now = Date.now();
  if (mtimeCache && now - mtimeCache.at < 5_000) return mtimeCache.newest > BOOTED_AT;

  let newest = 0;
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    for (const name of safeList(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        const info = statSync(full);
        if (info.isDirectory()) walk(full, depth + 1);
        else if (name.endsWith('.ts')) newest = Math.max(newest, info.mtimeMs);
      } catch { /* a file that vanished mid-walk is not a signal */ }
    }
  };
  walk(join(VIEWER_DIR, 'server'));

  mtimeCache = { at: now, newest };
  return newest > BOOTED_AT;
}

export function expandHome(input: string): string {
  return input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
}

/* ------------------------------------------------------------------ *
 * Persisted preferences
 * ------------------------------------------------------------------ */

export type Prefs = {
  recentRoots: string[];
  lastRoot?: string;
  theme?: 'dark' | 'light' | 'system';
  density?: 'comfortable' | 'compact';
  model?: string;
  sort?: string;
  /**
   * Automation defaults — the opening values for every launch surface. Each
   * launch can override them for itself; these are what the dialogs open on.
   *
   * - `attachDefaultSkills`: seed the machine's default skills (the
   *   `--default-skills` / `PHASE_CONSOLE_DEFAULT_SKILLS` list) into new runs
   *   and pre-check them in launch dialogs. Off by default: attaching extra
   *   skills to every session is an opt-in, not a side effect of installing.
   * - `qaByDefault`: open launch surfaces with the QA gate ticked, so starting
   *   a run turns QA on for the plan unless the operator unticks it.
   * - `gitMode`: 'new-branch' puts each run on one plan-wide work branch
   *   (`pe/<slug>`); 'default-branch' keeps today's behaviour — sessions work
   *   on whatever is checked out and never create branches.
   * - `openPrOnComplete`: when a new-branch run finishes its last phase, the
   *   final session is instructed to push the branch and open a PR. Meaningful
   *   only with `gitMode: 'new-branch'`.
   * - `repoGuard`: queue runs whose repository scopes overlap (the scheduler's
   *   cross-run serialization). Turning it off admits overlapping runs; a
   *   new-branch run that overlaps a live one is steered into a git worktree.
   * - `isolation`: what a new run ASKS for. `queue` is today's behaviour — the
   *   shared checkout, and `repoGuard` serializing overlapping runs. `worktree`
   *   asks for a console-managed linked checkout on the run's own branch, which
   *   is what lets two overlapping runs drive at once. Meaningful only with
   *   `gitMode: 'new-branch'` (a run with no branch of its own has nothing to
   *   check out), and a run that asks and cannot be given one degrades to the
   *   shared checkout with its reason named rather than failing.
   * - `settle`: what happens to a finished run's work branch. `pr` is the
   *   default and what every run did before this existed — push it and open a
   *   pull request. `keep` leaves the branch alone; `integration` merges it
   *   into the console's own staging checkout (`pe/integration`) and stops
   *   there, touching no remote; `merge-queue` boards one more session that
   *   rebases on whatever landed while this run drove, re-runs the plan's
   *   end-to-end verification, and pushes only if that passes. Meaningful only
   *   with `gitMode: 'new-branch'` — a run with no branch of its own has
   *   nothing to settle.
   * - `worktreeMaxConcurrent` / `worktreeSetup` / `worktreeCopyEnv`: the
   *   lifecycle knobs — how many managed trees may exist at once, what to run
   *   once inside a fresh one, and whether the source checkout's ignored `.env`
   *   files are copied in. Their defaults live beside the vocabulary in
   *   `shared/worktree-model.js`; `worktreeCopyEnv` is off because copying
   *   secrets into a second directory is a decision, not a default.
   * - `autoRecoverByDefault`: new runs heal themselves — an auto-recoverable
   *   halt (failed verification, lint, missing handoff, crash) launches the fix
   *   agent, bounded per phase and per run. Each launch dialog can turn it off
   *   for one run.
   * - `autoContinueRecovery`: when a recovery session ends and the board reads
   *   fixed, the run resumes by itself instead of waiting for Continue. Governs
   *   manual recoveries too — a fixed run is a run to carry on.
   * - `mcpPolicy`: what a phase does when one of its MCP servers cannot be
   *   reached. `continue` runs it anyway without that server and says so;
   *   `require` parks at boarding. A plan or a phase can still demand `require`
   *   for itself — this is only where every run starts.
   */
  attachDefaultSkills?: boolean;
  qaByDefault?: boolean;
  gitMode?: GitMode;
  openPrOnComplete?: boolean;
  /**
   * Start every run with the per-phase auto reviewer on (`server/reviewer.ts`).
   * Default FALSE — it spends money per phase and can hold dependent phases,
   * and neither may arrive switched on in a console somebody upgraded.
   */
  reviewEachPhaseByDefault?: boolean;
  /** What that reviewer may record. Default `comment-only`: nothing is held. */
  reviewerPolicy?: ReviewerPolicy;
  repoGuard?: boolean;
  isolation?: IsolationMode;
  settle?: SettleStrategy;
  worktreeMaxConcurrent?: number;
  worktreeSetup?: string;
  worktreeCopyEnv?: boolean;
  /**
   * Where every tree the console makes for this instance lives: inside the
   * project (`<root>/.worktrees/`, the default) or the console's state
   * directory. `shared/worktree-model.js` §`WORKTREE_ROOTS`.
   */
  worktreeRoot?: WorktreeRoot;
  /**
   * May a run TAKE its branch back from a checkout that is sitting on it?
   *
   * `clean-only` (the default) switches a checkout standing on `pe/<slug>`
   * with nothing uncommitted in it onto the default branch, so the run can
   * have its own tree. It is on by default because the wedge it ends is one
   * the console CREATES: the new-branch strategy tells sessions to check
   * `pe/<slug>` out, so the operator's own root ends up holding it, and every
   * later run of that plan then degrades to sharing that checkout for ever
   * with nothing but a journal line to say why.
   *
   * Nothing is deleted, no ref moves, and a DIRTY tree is never touched —
   * which is why on-by-default is defensible. `never` is for an operator who
   * would rather be asked.
   */
  isolationReclaim?: IsolationReclaim;
  /**
   * Delete the run's own `pe/*` branches once their pull request has MERGED.
   *
   * On by default: after a merge the commits are on the target and the branch
   * is a name for something that already happened, and a console that drives
   * thirty runs otherwise leaves thirty of them behind. Always `git branch -d`
   * — git's own refusal to delete an unmerged branch is the safety, and the
   * force form appears nowhere in this repository (`never-push.test.ts`).
   */
  deleteMergedRunBranches?: boolean;
  autoRecoverByDefault?: boolean;
  autoContinueRecovery?: boolean;
  /**
   * May the console RUN a `cmd:` watch ref? Default on, and gated a second time
   * by `--allow-run`.
   *
   * The one switch on this list that governs an execution surface rather than a
   * policy. A `cmd:` ref is a command a SESSION wrote into its own declaration,
   * which the console then runs on a timer with nobody watching — so even
   * though it goes through `verify.ts`'s read-only policy (the same denylist,
   * the same inverted allowlist for verbs that reach off this machine, the same
   * process-group kill) and can therefore do nothing a §Verification bullet in
   * the same plan could not already do, an operator must be able to say no
   * without giving up the rest of the autopilot. Off means a `cmd:` ref reads
   * `unknown`, never `refused`: the console has not judged the command, it
   * simply did not ask.
   */
  watchCmdRefs?: boolean;
  /**
   * May the watch clock RUN a `cmd:` ref the CONSOLE minted — the watchdog's
   * automatic park lifts the command a session was polling with out of a Bash
   * tool summary and files it as a watch ref (`declared.minted`). Off (shipped):
   * a minted ref is written once as `unknown` and never run, because the
   * console's own inference must not execute a writing command against a
   * repository nobody is watching (SLF-8); the park still resumes on its clock.
   * On: minted refs run under exactly the policy `watchCmdRefs` gives declared ones.
   */
  watchMintedCmdRefs?: boolean;
  mcpPolicy?: McpPolicy;
  /**
   * The remediation ladder (`runner/ladder.ts`) — what the autopilot may try
   * by itself before it asks a person, and how much it may spend doing so.
   *
   * - `ladderPerPhaseRungs` / `ladderPerPhaseUsd`: rungs and dollars per phase
   *   (defaults 3 and $100); `ladderPerRunRungs` / `ladderPerRunUsd` per run
   *   (10 and $400); `ladderPerDayUsd` per console per day ($600). A cap that
   *   is reached parks the phase with an Errand — one card, one ask.
   * - `unblockAttempts`: a handoff or outcome that declares a blocker of no
   *   machine-checkable kind may get ONE bounded session explicitly allowed
   *   to do the work (the measured "closeout-only passes have looped" shape).
   * - `staleClaimTakeover`: an expired foreign lock over unfinished work is
   *   taken over rather than parked on.
   * - `resumeAtBoot`: lanes a console restart killed resume their own session
   *   when the console comes back.
   * - `autoAccountSwitch`: an auth or usage wall switches to a registered
   *   account with headroom instead of halting.
   * - `delegateHumanGates`: a `human` gate is briefed to the phase's own
   *   session to VERIFY and clear, instead of stopping the run for a person.
   *   **On by default since 5.0.0** (phase 11 of zero-touch-console, operator
   *   decision 11: `gates: delegated`) — it is this console's word for the
   *   manifest's `gates` row, below a plan's own `## Decisions` row and
   *   `policy.gates`, and a gate whose conditions are not written stays a
   *   person's whatever the switch says. What makes delegation safe is not
   *   trust: the brief requires cited evidence per condition and STOPS with
   *   the condition named when it has none (`phase-outcome.sh … blocked`);
   *   `gate-status.md` records such approvals as `by: ai-session-delegated`.
   * - `policy`: this console's answers to the decision manifest's rows
   *   (`shared/policy-model.js` `DECISION_ANSWERS`), keyed by decision key —
   *   `{ "qa.exhausted": "halt", "ambiguity": "ask" }`. Read below a plan's
   *   `## Decisions` row and above the shipped defaults; an unknown key or word
   *   is dropped. Phase 12's policy editor writes it; until then a hand edit of
   *   `config.json` or `POST /api/prefs`.
   * - `convergeEveryMs`: how often the convergence loop re-reads every open
   *   plan even when nothing happened (default 5 min). 0 disables the timer;
   *   boot, change and post-halt passes still run.
   */
  ladderPerPhaseRungs?: number;
  ladderPerPhaseUsd?: number;
  ladderPerRunRungs?: number;
  ladderPerRunUsd?: number;
  ladderPerDayUsd?: number;
  /**
   * The start ceiling (`start-ceiling.ts`, SLF-1): how many AUTOMATIC
   * `claude` starts this instance may make per sliding hour, and how many
   * session dollars the last hour may hold before the next automatic start is
   * refused. A person's press is never counted. 0 switches a limit off.
   */
  ceilingStartsPerHour?: number;
  ceilingUsdPerHour?: number;
  unblockAttempts?: boolean;
  staleClaimTakeover?: boolean;
  delegateHumanGates?: boolean;
  policy?: Partial<Record<DecisionKey, string>>;
  /**
   * Two opt-ins from the automation posture sweep (console-parallel-repaint
   * P12), both off by default:
   *
   * - `allowUnverifiedPhases`: a phase whose plan states NO §Verification
   *   boards anyway and passes on its handoff alone, instead of parking at
   *   boarding with "add a §Verification command, then Retry" (measured: ten
   *   errands and three parks in the corpus). The proof bar drops to the
   *   handoff for exactly those phases — `phase.verify-waived` says so on the
   *   record — and a phase that DECLARES a bullet the runner cannot read
   *   still parks: that is a formatting fault the author should hear about.
   * - `ladderExtendOnProgress`: when a phase's ladder is spent on its RUNG
   *   count but the newest settled rung landed commits, one more rung is
   *   granted, once per phase (`ladder.ts` `progressExtension`, journalled
   *   `phase.ladder-extended`). The dollar caps stand.
   */
  allowUnverifiedPhases?: boolean;
  ladderExtendOnProgress?: boolean;
  /**
   * `ask` (shipped) · `auto` · `off` — see `RESUME_AT_BOOT_MODES`. Stored as
   * a boolean before 3.5.0, and `resumeAtBootMode` reads both.
   */
  resumeAtBoot?: ResumeAtBootMode;
  autoAccountSwitch?: boolean;
  convergeEveryMs?: number;
  /**
   * The resource ladder — walls the run climbs past by itself before a person
   * hears about them (`runner.ts`, the `resource-wall:*` rungs).
   *
   * - `budgetAutoRaisePct`: a spent run budget is raised ONCE by this
   *   percentage (default 25), never above `ladderPerRunUsd`; the second
   *   exhaustion halts with an errand. 0 turns the raise off.
   * - `mcpRequireTimeoutMs`: how long a phase parked under MCP policy
   *   `require` waits for its servers before it continues without them — the
   *   errand is recorded and the operator told once (default 30 min). 0 means
   *   wait indefinitely, which is what every console did before this existed.
   */
  budgetAutoRaisePct?: number;
  mcpRequireTimeoutMs?: number;
  /**
   * When this console is willing to START phases — boarding windows, quiet
   * hours and cron openings (`shared/schedule-policy.js`).
   *
   * Not a toggle like everything above it, so it is not in the automation
   * card's switch list: it is a small object, coerced by `sanitiseSchedule`
   * rather than by the `bool`/`cap` helpers, and consulted by the scheduler's
   * admit path. `enabled: false` — the default — means every hour boards, which
   * is what this console did before the policy existed. Recoveries are exempt
   * by design (`AdmitRequest.kind`): the schedule governs what the autopilot
   * STARTS, never what an operator asks for.
   */
  boardingSchedule?: SchedulePolicy;
  /**
   * This console's relay rules (zero-touch-console phase 14): for a question
   * whose key matches, the option the console answers when nobody else did —
   * ahead of the `(Recommended)` option and the first. A small list, coerced by
   * `sanitiseRelayRules` beside the matcher that reads it, replaced wholesale on
   * every write like `boardingSchedule`, and edited in the policy card.
   */
  relayRules?: RelayRule[];
  /**
   * When a lane that is still alive stops being work (`runner/liveness.ts`).
   *
   * - `stallSilentMs`: no PRODUCTIVE output for this long is `silent` (default
   *   10 min). Suppressed while the phase is inside its own §Verification.
   * - `stallSpinTurns`: this many consecutive turns with no tool call in any
   *   of them is `spinning` (default 6).
   * - `stallStalemateAttempts`: this many attempts in a row that committed
   *   nothing and left a clean tree is `stalemate` (default 3).
   * - `stallRetryBurst`: this many API retries in a row with nothing
   *   productive between them is `retrying` (default 5). Detection only — the
   *   run's `onLimit` policy acts on its OWN, shorter debounce
   *   (`LIMIT_RETRY_BURST` in `runner/runner.ts`), because noticing is cheap
   *   and killing a live child to move it is not.
   * - `stallExternalWaitMs`: a Bash call matching the shared external-clock
   *   vocabulary (`EXTERNAL_WAIT` in `scripts/verify.env`, the same list lint
   *   F16 warns from) open this long is `external-wait` (default 5 min).
   *   **The one stall knob that is not detection-only** — see below.
   * - `stallLocalJobMs`: the same call, when what it waits on is the session's
   *   OWN background job, may stay open this long before the park applies
   *   (default 45 min). The scope is read off the command
   *   (`liveness.ts` `waitScope`); before it, one clock governed both and a
   *   session watching its own 40-minute suite was parked at five.
   *
   * Detection only — v1 announces and offers verbs, and deliberately does not
   * climb the ladder (`docs/loop.md`). The single exception is
   * `external-wait`, which parks the phase and releases its lock: a lane
   * waiting on somebody else's clock is holding an exclusive claim that blocks
   * every other session whose scope intersects it, so leaving it as a card
   * would announce the harm while letting it continue.
   *
   * The shipped numbers live in `shared/attention-model.js` `STALL_DEFAULTS`,
   * imported rather than repeated, so the card, the Settings row and the
   * detector agree.
   */
  stallSilentMs?: number;
  stallSpinTurns?: number;
  stallStalemateAttempts?: number;
  stallRetryBurst?: number;
  stallExternalWaitMs?: number;
  stallLocalJobMs?: number;
  /**
   * Whether the stall watchdog may PARK a lane by itself — the automatic park
   * `external-wait` makes (default on). The KNOWN-SINCE off switch (SLF-9): the
   * signal still raises its card and the local job's nudge still goes, but no
   * lane is checkpointed and parked in the session's place. `stallExternalWaitMs:
   * 0` is the stronger word — no `external-wait` signal at all.
   */
  stallAutomaticPark?: boolean;
  /**
   * How long an unresolved stall waits before it is said once more, urgently.
   *
   * Not a detector threshold and so not a member of `STALL_DEFAULTS` (which is
   * a bijection with the stall signals); the shipped number is
   * `STALL_ESCALATE_MS` in the same file, for the same reason — one owner.
   */
  stallEscalateMs?: number;
  /**
   * Which categories the console is allowed to announce **at all** — the switch
   * an operator actually means when they turn a notification off.
   *
   * This lives here, in the console's own config, rather than on a push device,
   * because the previous home for it was wrong in a way that made the toggles
   * lie: categories were stored per subscribed device, so they filtered the push
   * leg and nothing else. Turning "Plans changed on disk" off still wrote an
   * inbox record, still emitted over SSE, still ran `PHASE_CONSOLE_NOTIFY` — and
   * a console with no device subscribed had nowhere to store the preference at
   * all. One global map, consulted at the top of `Service.announce()`, is what
   * makes a disabled category mean silence on every leg.
   *
   * Never partial: `loadPrefs` sanitises it to a complete map so a category
   * added in a later version takes its catalogue default instead of reading
   * `undefined` (and being suppressed by accident).
   */
  notify: Record<CategoryId, boolean>;
};

const CONFIG_DIR = configDir();
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_PREFS: Prefs = {
  recentRoots: [], theme: 'system', density: 'comfortable', sort: 'activity',
  attachDefaultSkills: false, qaByDefault: false, gitMode: 'default-branch', openPrOnComplete: true, repoGuard: true,
  isolation: 'queue', settle: DEFAULT_SETTLE, ...WORKTREE_DEFAULTS,
  isolationReclaim: 'clean-only', deleteMergedRunBranches: true,
  reviewEachPhaseByDefault: false, reviewerPolicy: 'comment-only',
  autoRecoverByDefault: true, autoContinueRecovery: true, watchCmdRefs: true, watchMintedCmdRefs: false, mcpPolicy: 'continue',
  ladderPerPhaseRungs: 3, ladderPerPhaseUsd: 100, ladderPerRunRungs: 10, ladderPerRunUsd: 400, ladderPerDayUsd: 600,
  ceilingStartsPerHour: DEFAULT_STARTS_PER_HOUR, ceilingUsdPerHour: DEFAULT_USD_PER_HOUR,
  unblockAttempts: true, staleClaimTakeover: true, resumeAtBoot: 'ask', autoAccountSwitch: true,
  delegateHumanGates: true, policy: {}, allowUnverifiedPhases: false, ladderExtendOnProgress: false,
  convergeEveryMs: 300_000,
  budgetAutoRaisePct: 25, mcpRequireTimeoutMs: 1_800_000,
  boardingSchedule: sanitiseSchedule(undefined),
  relayRules: [],
  ...STALL_DEFAULTS, stallEscalateMs: STALL_ESCALATE_MS, stallAutomaticPark: true,
  notify: sanitiseCategories(undefined),
};

/**
 * The automation grouping lives in `shared/automation-model.js`, with the rest
 * of the vocabularies — three consumers ask it the same question (this loader,
 * the writer that emits both shapes, and the client's Settings coverage test),
 * and a client test cannot import this file: the state-directory guard refuses
 * it, correctly. Re-exported here so every existing server importer keeps its
 * import path.
 */
export { AUTOMATION_MAP, AUTOMATION_KEYS, toAutomation, fromAutomation };

/**
 * Read a stored config either way round, object first.
 *
 * A config file may hold the flat keys (everything written before 3.5.0), the
 * object (everything written after 3.6.0), or both (everything 3.5.0 itself
 * writes). The object wins where they overlap, because it is the shape an
 * operator's edit lands in — and the flat keys are kept where the object says
 * nothing, so a key added to the object's group later does not silently drop
 * the value a 3.4 config had for it.
 *
 * Unknown keys survive untouched: this returns a patch to merge, never a
 * replacement, so a setting this build does not know about is still on disk
 * for the build that does.
 */
export function migrateAutomation(parsed: Partial<Prefs> & { automation?: unknown }): Partial<Prefs> {
  return { ...parsed, ...fromAutomation(parsed.automation) };
}

/**
 * The preferences with their `automation` object DERIVED from the flat keys
 * beside it, rather than carried from whatever was last read off disk.
 *
 * 🔴 Without this the in-memory copy publishes two disagreeing values for one
 * setting after every write: `savePreferences` merges the flat keys it picked
 * and leaves `automation` exactly as `loadPrefs` found it, so `/api/state`
 * served `ladderPerRunUsd: 27` beside `automation.caps.perRunUsd: 25` — while
 * `config.json` correctly held 27 in both, because `savePrefs` re-derives on
 * the way out. It never self-healed, and the object is the shape everything
 * after 3.6.0 reads.
 *
 * Applied wherever a `Prefs` is built or changed, so the two cannot come apart:
 * the flat keys are the in-memory truth and the object is a view of them.
 */
export function withAutomation(prefs: Prefs): Prefs {
  return { ...prefs, automation: toAutomation(prefs) } as Prefs;
}

/**
 * The one git-shape combination that cannot work, refused at the door.
 *
 * `isolation: worktree` needs a run branch to put the lanes on, and only
 * `gitMode: new-branch` mints one. Set both and the run does not fail — it
 * DEGRADES, at runtime, inside `checkAvailable` (`runner/worktree.ts`, refusal
 * `no-run-branch`), releasing the tree and carrying on shared with the reason
 * in the journal and nothing on any screen. An operator who turned isolation on
 * has every reason to believe it is on. R38 lists this as the type specimen of
 * a knob combination that degrades silently; this is where it stops.
 *
 * ⚠️ **Only this pair, deliberately.** Phase 7's plan also named `settle ≠ pr`
 * with `default-branch`, and that rule cannot be written as stated: `pr` IS the
 * shipped default beside `default-branch`, and `keep` is what
 * `openPrOnComplete: false` folds to through `settleOf`. Refusing them would
 * 400 two configurations that work today — a strictly worse outcome than the
 * silence it was meant to fix. A settle strategy on a branchless run is a
 * no-op, not an incoherence; isolation on one is a promise the console cannot
 * keep.
 *
 * @returns the operator-facing sentence, or `null` when the shape is fine.
 */
export function gitDoorRefusal(shape: {
  isolation?: string | null;
  gitMode?: string | null;
}): string | null {
  // Both words EXACT, and that is the whole rule. `gitMode !== 'new-branch'`
  // would have been the obvious spelling and is wrong twice over: it refuses a
  // request that names isolation and leaves the git strategy to the stored
  // preference (which is most of them), and it refuses one whose `gitMode` is a
  // typo the door two lines below is about to drop. Everything on these doors
  // reads only words it knows and treats the rest as "you did not say"; a
  // refusal has to follow the same posture or it fires on silence.
  if (shape.isolation === 'worktree' && shape.gitMode === 'default-branch') {
    return 'isolation needs a run branch: worktree lanes land on the run branch, '
      + 'so the run must use the new-branch git strategy (Settings ▸ Automation).';
  }
  return null;
}

/**
 * Coerce the automation keys to values the rest of the app can trust: booleans
 * stay booleans (anything else takes the default), and `gitMode` is
 * 'new-branch' only when it says exactly that — a typo in config.json must
 * never mint branches. `mcpPolicy` follows the same rule from the other
 * direction: only the exact word `require` may stop a run.
 */
export function sanitiseAutomation(parsed: Partial<Prefs>): Pick<Prefs,
  'attachDefaultSkills' | 'qaByDefault' | 'gitMode' | 'openPrOnComplete' | 'repoGuard'
  | 'isolation' | 'settle' | 'worktreeMaxConcurrent' | 'worktreeSetup' | 'worktreeCopyEnv' | 'worktreeRoot'
  | 'isolationReclaim' | 'deleteMergedRunBranches'
  | 'reviewEachPhaseByDefault' | 'reviewerPolicy'
  | 'autoRecoverByDefault' | 'autoContinueRecovery' | 'watchCmdRefs' | 'watchMintedCmdRefs' | 'mcpPolicy'
  | 'ladderPerPhaseRungs' | 'ladderPerPhaseUsd' | 'ladderPerRunRungs' | 'ladderPerRunUsd' | 'ladderPerDayUsd'
  | 'ceilingStartsPerHour' | 'ceilingUsdPerHour'
  | 'unblockAttempts' | 'staleClaimTakeover' | 'resumeAtBoot' | 'autoAccountSwitch'
  | 'delegateHumanGates' | 'policy' | 'allowUnverifiedPhases' | 'ladderExtendOnProgress' | 'convergeEveryMs'
  | 'budgetAutoRaisePct' | 'mcpRequireTimeoutMs' | 'boardingSchedule' | 'relayRules'
  | 'stallSilentMs' | 'stallSpinTurns' | 'stallStalemateAttempts' | 'stallRetryBurst'
  | 'stallExternalWaitMs' | 'stallLocalJobMs' | 'stallEscalateMs' | 'stallAutomaticPark'> {
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  // A cap is a finite, non-negative number or it is the default — a string,
  // a negative or NaN in config.json must never turn the ladder unbounded
  // (or, the other way, into a zero that parks every phase on an errand).
  const cap = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  // The same rule with the zero excluded — see the stall thresholds below.
  const positive = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    attachDefaultSkills: bool(parsed.attachDefaultSkills, false),
    qaByDefault: bool(parsed.qaByDefault, false),
    gitMode: parsed.gitMode === 'new-branch' ? 'new-branch' : 'default-branch',
    openPrOnComplete: bool(parsed.openPrOnComplete, true),
    // The unsafe direction is the only one that needs an exact word, exactly
    // like `mcpPolicy` above: anything that is not literally `may-hold` reads
    // as the policy that holds nothing.
    reviewEachPhaseByDefault: bool(parsed.reviewEachPhaseByDefault, false),
    reviewerPolicy: parsed.reviewerPolicy === 'may-hold' ? 'may-hold' : 'comment-only',
    repoGuard: bool(parsed.repoGuard, true),
    // By the owner's coercer, not a local `===`: only the exact word isolates,
    // and the one place that rule is written is `shared/worktree-model.js`.
    isolation: isolationMode(parsed.isolation),
    // Through the SAME fold every other reader uses, and for the same reason
    // it exists: a `config.json` written before this setting shipped carries
    // `openPrOnComplete: false` and nothing else, and that operator asked for
    // precisely what `keep` means. Reading the newer key alone would silently
    // turn their console back into one that opens pull requests.
    //
    // `settleOf` also gives the safe fold in the other direction: an
    // unrecognised `settle` becomes `pr` — what this console did before the
    // setting existed — rather than quietly ending pull requests.
    settle: settleOf({ settle: parsed.settle, openPr: parsed.openPrOnComplete }),
    // A cap of zero would refuse every isolated run while claiming the feature
    // is on, so this is `positive` rather than `cap` — the shipped number is
    // the honest answer to a config.json that asks for none.
    worktreeMaxConcurrent: positive(parsed.worktreeMaxConcurrent, WORKTREE_DEFAULTS.worktreeMaxConcurrent),
    // A non-string setup command reads as NO command. The failure direction
    // that costs something is a half-coerced value reaching a shell.
    worktreeSetup: typeof parsed.worktreeSetup === 'string' ? parsed.worktreeSetup : WORKTREE_DEFAULTS.worktreeSetup,
    worktreeCopyEnv: bool(parsed.worktreeCopyEnv, WORKTREE_DEFAULTS.worktreeCopyEnv),
    // Only the exact word `state` moves the trees out of the project — the
    // fail-safe direction, and the placement a person can find.
    worktreeRoot: worktreeRootOf(parsed.worktreeRoot),
    // Only the exact word turns the reclaim off — the same fail-safe direction
    // `gitMode` and `mcpPolicy` take, applied to the setting whose two answers
    // are "move a clean tree" and "never touch anything".
    isolationReclaim: reclaimModeOf(parsed.isolationReclaim),
    deleteMergedRunBranches: bool(parsed.deleteMergedRunBranches, true),
    autoRecoverByDefault: bool(parsed.autoRecoverByDefault, true),
    autoContinueRecovery: bool(parsed.autoContinueRecovery, true),
    watchCmdRefs: bool(parsed.watchCmdRefs, true),
    watchMintedCmdRefs: bool(parsed.watchMintedCmdRefs, false),
    mcpPolicy: parsed.mcpPolicy === 'require' ? 'require' : 'continue',
    ladderPerPhaseRungs: cap(parsed.ladderPerPhaseRungs, 3),
    ladderPerPhaseUsd: cap(parsed.ladderPerPhaseUsd, 100),
    ladderPerRunRungs: cap(parsed.ladderPerRunRungs, 10),
    ladderPerRunUsd: cap(parsed.ladderPerRunUsd, 400),
    ladderPerDayUsd: cap(parsed.ladderPerDayUsd, 600),
    ceilingStartsPerHour: cap(parsed.ceilingStartsPerHour, DEFAULT_STARTS_PER_HOUR),
    ceilingUsdPerHour: cap(parsed.ceilingUsdPerHour, DEFAULT_USD_PER_HOUR),
    unblockAttempts: bool(parsed.unblockAttempts, true),
    delegateHumanGates: bool(parsed.delegateHumanGates, true),
    policy: sanitisePolicyPrefs(parsed.policy),
    allowUnverifiedPhases: bool(parsed.allowUnverifiedPhases, false),
    ladderExtendOnProgress: bool(parsed.ladderExtendOnProgress, false),
    staleClaimTakeover: bool(parsed.staleClaimTakeover, true),
    resumeAtBoot: resumeAtBootMode(parsed.resumeAtBoot),
    autoAccountSwitch: bool(parsed.autoAccountSwitch, true),
    convergeEveryMs: cap(parsed.convergeEveryMs, 300_000),
    budgetAutoRaisePct: cap(parsed.budgetAutoRaisePct, 25),
    mcpRequireTimeoutMs: cap(parsed.mcpRequireTimeoutMs, 1_800_000),
    // Its own coercer, in `shared/schedule-policy.js` beside the rules it has
    // to agree with: an unparseable window is DROPPED rather than defaulted,
    // because the failure direction that costs money is a malformed schedule
    // silently reading as "board at any hour".
    boardingSchedule: sanitiseSchedule(parsed.boardingSchedule),
    // The relay's rules: a rule missing its key or its answer is DROPPED, never
    // repaired — a repaired rule answers a question nobody wrote it for.
    relayRules: sanitiseRelayRules(parsed.relayRules),
    // A stall threshold of zero would fire on every lane on its first tick, so
    // these take `positive` rather than `cap`: unlike a ladder cap, there is no
    // meaning to give a zero here, and the shipped number is the honest answer
    // to a config.json that asks for one.
    stallSilentMs: positive(parsed.stallSilentMs, STALL_DEFAULTS.stallSilentMs),
    stallSpinTurns: positive(parsed.stallSpinTurns, STALL_DEFAULTS.stallSpinTurns),
    stallStalemateAttempts: positive(parsed.stallStalemateAttempts, STALL_DEFAULTS.stallStalemateAttempts),
    stallRetryBurst: positive(parsed.stallRetryBurst, STALL_DEFAULTS.stallRetryBurst),
    // The exception to the rule above, and the reason it is spelled out: a zero
    // here does have a meaning — "never call a lane waiting" — and Settings has
    // promised it ("0 never parks a lane for waiting") while `positive` quietly
    // turned it back into five minutes (SLF-9, KNOWN-SINCE).
    stallExternalWaitMs: cap(parsed.stallExternalWaitMs, STALL_DEFAULTS.stallExternalWaitMs),
    stallLocalJobMs: positive(parsed.stallLocalJobMs, STALL_LOCAL_JOB_MS),
    stallAutomaticPark: bool(parsed.stallAutomaticPark, true),
    // `cap`, not `positive`, for the same reason as the external-wait clock
    // above: a zero detector threshold would flag every lane on its first tick
    // (nonsense), but a zero HERE means "never say it twice" — exactly what
    // this console did before the escalation existed, and a setting an
    // operator can genuinely want.
    stallEscalateMs: cap(parsed.stallEscalateMs, STALL_ESCALATE_MS),
  };
}

/**
 * Preferences about the PERSON, not the project.
 *
 * These follow an operator between consoles: someone who likes a compact dark
 * theme likes it in every project, and having to set it once per instance would
 * be an obvious bug rather than isolation. Everything not on this list is about
 * one project — which repositories are recent, whether QA is on, which
 * notifications matter — and belongs to the instance.
 */
const USER_GLOBAL_KEYS = ['theme', 'density', 'sort', 'model'] as const;

/**
 * Where this instance's own preferences live.
 *
 * The default instance answers `config.json` itself, exactly as
 * `instanceStateDir()` answers the flat state directory: it does not get a
 * keyed file, it keeps the one it has always had. That is not just symmetry —
 * a keyed file for the default would fragment its settings across two names
 * (`instances/default.json` when started with no root, `instances/<id>.json`
 * when started with one) and an operator would watch their preferences appear
 * to reset depending on how the console was launched. One store per instance,
 * and the default's store is the file that predates instances.
 */
export function instancePrefsFile(instance: Instance = INSTANCE): string {
  return instance.default ? CONFIG_FILE : instancePrefsPath(instance.id);
}

function readJson(file: string): Partial<Prefs> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Partial<Prefs> : {};
  } catch {
    return {};
  }
}

/**
 * The preferences this instance runs under: the person's, plus its own.
 *
 * A missing keyed file reads the shared one instead — that is the adoption
 * path, and it is what makes a second console open with the operator's existing
 * automation defaults rather than a blank slate. It stops mattering the first
 * time that instance saves anything, because writes always go to the keyed
 * file.
 */
export function loadPrefs(instance: Instance = INSTANCE): Prefs {
  const shared = readJson(CONFIG_FILE);
  const file = instancePrefsFile(instance);
  const own = file === CONFIG_FILE ? shared : readJson(file);
  // Absent, not merely empty: an instance that has deliberately emptied its
  // recent roots must not have the shared file's list handed back to it.
  const scoped = existsSync(file) ? own : shared;

  // The object wins over the flat keys where both are present, and the flat
  // keys are still read where it says nothing — see `migrateAutomation`. This
  // happens BEFORE `sanitiseAutomation`, so a value that arrived through the
  // object goes through exactly the same coercion table as one that arrived
  // flat: there is one place a `gitMode` typo is refused, not two.
  const migrated = migrateAutomation(scoped);

  // `notify` is rebuilt rather than spread: a stored map missing a key must
  // take that category's default, not inherit `undefined`. The automation
  // keys are rebuilt for the same reason, plus type coercion.
  return withAutomation({
    ...DEFAULT_PREFS,
    ...scoped,
    ...pick(shared, USER_GLOBAL_KEYS),
    recentRoots: scoped.recentRoots ?? [],
    lastRoot: scoped.lastRoot,
    ...sanitiseAutomation(migrated),
    notify: sanitiseCategories(scoped.notify),
  });
}

function pick<K extends keyof Prefs>(source: Partial<Prefs>, keys: readonly K[]): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * Persist both halves.
 *
 * Two writes for a non-default instance and one for the default, which is the
 * whole split made concrete: the person's choices land in the shared file where
 * the next console will find them, the project's land beside that project's id.
 * The shared file is read-modify-written rather than replaced, so an instance
 * saving its own preferences cannot delete another's.
 */
export function savePrefs(prefs: Prefs, instance: Instance = INSTANCE): void {
  const file = instancePrefsFile(instance);
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 3.5.0 writes BOTH shapes for one release: the flat keys so a 3.4 console
    // reading this file still finds every setting it knows, and the object as
    // the shape everything after 3.6.0 reads. The object is DERIVED from the
    // flat keys rather than carried alongside them, so the two cannot disagree
    // — there is no path by which a caller sets one and forgets the other.
    const dual: Prefs & { automation: unknown } = { ...prefs, automation: toAutomation(prefs) };
    if (file === CONFIG_FILE) {
      writeJsonAtomic(CONFIG_FILE, dual);
      return;
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
    // The shared file's read-modify-write is the one that could actually lose
    // somebody's key: two consoles saving at once both read the same base and
    // the second write drops the first's edits. Re-read INSIDE the atomic
    // write, immediately before the rename, so the window is a rename rather
    // than a whole save — and the rename itself is what makes a torn or
    // half-written config impossible, which a bare `writeFileSync` allowed.
    writeJsonAtomic(CONFIG_FILE, { ...readJson(CONFIG_FILE), ...pick(prefs, USER_GLOBAL_KEYS) });
    const own: Partial<Prefs> & { automation?: unknown } = { ...dual };
    for (const key of USER_GLOBAL_KEYS) delete own[key];
    writeJsonAtomic(file, own);
  } catch {
    /* preferences are a convenience; a read-only home must not break the app */
  }
}

/**
 * Write JSON the way every other registry in this tree does: tmp + rename.
 *
 * `savePrefs` was the one holdout on a bare `writeFileSync`, so a console
 * killed mid-write left a truncated `config.json` — and the next boot read no
 * preferences at all rather than the previous ones. Rename is atomic on every
 * platform this runs on, so a reader sees the old file or the new one.
 * Uniquely suffixed, so two writers cannot collide on the temp name itself.
 */
function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw error;
  }
}

export function rememberRoot(prefs: Prefs, root: string): Prefs {
  const recentRoots = [root, ...prefs.recentRoots.filter((r) => r !== root)].slice(0, 12);
  const next = { ...prefs, recentRoots, lastRoot: root };
  savePrefs(next);
  return next;
}

/* ------------------------------------------------------------------ *
 * Root validation
 * ------------------------------------------------------------------ */

export type RootCheck = {
  path: string;
  ok: boolean;
  reason?: string;
  docsDir?: string;
  plansDir?: string;
  handoffsDir?: string;
  planCount: number;
  handoffCount: number;
  label: string;
};

/**
 * A source directory is valid when it holds `docs/plans` (the plan store).
 * Pointing straight at a `docs/` directory works too — that is what someone
 * typing a path from muscle memory usually does.
 */
export function checkRoot(input: string): RootCheck {
  const path = resolve(expandHome(input || '.'));
  const empty: RootCheck = { path, ok: false, planCount: 0, handoffCount: 0, label: basename(path) };

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return { ...empty, reason: 'No such directory' };
  }

  const docsDir = existsSync(join(path, 'docs', 'plans')) ? join(path, 'docs')
    : existsSync(join(path, 'plans')) ? path
      : undefined;

  if (!docsDir) return { ...empty, reason: 'No docs/plans directory here' };

  const plansDir = join(docsDir, 'plans');
  const handoffsDir = join(docsDir, 'handoffs');
  const planCount = safeList(plansDir).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
  const handoffCount = existsSync(handoffsDir)
    ? safeList(handoffsDir).filter((f) => statSync(join(handoffsDir, f)).isDirectory()).length
    : 0;

  return {
    path, ok: true, docsDir, plansDir,
    handoffsDir: existsSync(handoffsDir) ? handoffsDir : undefined,
    planCount, handoffCount,
    label: basename(path) || path,
  };
}

export function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Directory listing for the source picker — directories only, dotfiles hidden. */
export function listDirs(input: string): { path: string; parent?: string; entries: { name: string; path: string; hasDocs: boolean }[] } {
  const path = resolve(expandHome(input || homedir()));
  const entries = safeList(path)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, full: join(path, name) }))
    .filter(({ full }) => { try { return statSync(full).isDirectory(); } catch { return false; } })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, full }) => ({ name, path: full, hasDocs: existsSync(join(full, 'docs', 'plans')) }));

  const parent = dirname(path);
  return { path, parent: parent === path ? undefined : parent, entries };
}
