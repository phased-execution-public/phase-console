/**
 * Which console is this, and where does it keep its things — the FREE tree.
 *
 * This file replaces `viewer/shared/instances.mjs` when
 * `scripts/build-free-tree.mjs` materializes the public repository. It is not
 * a smaller module: it exports the SAME 36 names, with the same signatures and
 * the same return shapes, because eleven other modules import from here and a
 * missing export is a crash at load rather than a feature that is absent.
 * `viewer/test/free-tree-shape.test.ts` diffs the two export sets and fails on
 * any difference in either direction.
 *
 * ## The one behavioural difference: the registry holds ONE slot
 *
 * Pro is the fleet — many projects at once, each with its own port, state
 * directory, unit and log. Free is one console for one repository. That whole
 * distinction lives in this file, as a property of the registry rather than a
 * check anyone can delete:
 *
 *   - the identity half is **verbatim** — `instanceId`, `derivePort`, the XDG
 *     resolvers, `unitName`, `readProjectFile`, `preferredPort`, `runCli`. A
 *     free console has to key its state exactly the way a Pro one does, or an
 *     operator who upgrades finds their log, push subscriptions and approvals
 *     queue under a path nothing reads any more.
 *   - the registry half keeps **at most one entry, and it is always the
 *     default**. Registering a root replaces the slot rather than joining it,
 *     so `listInstances()` can never return two, `derivePort` is never reached
 *     for a second project, and the 4124–4223 range this file still describes
 *     stays empty in practice.
 *
 * Enforcement is code absence, not a runtime check (`free/README.md`). The one
 * refusal below is not a licence gate — it is the honest answer to a caller
 * asking for a NON-default instance, which is a thing only a fleet wants and a
 * thing this module cannot represent.
 *
 * Everything else about the Pro file's reasoning still holds and is not
 * repeated here: resolution is lexical rather than `realpath`, nothing throws
 * on bad input, and the registry is a convenience that must never be able to
 * stop a console from booting.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** The port a single-console machine has always used. The default keeps it. */
export const DEFAULT_PORT = 4123;

/**
 * Where derived ports live: 100 slots immediately above the default.
 *
 * Kept identical to Pro, and kept EXPORTED, because `config.ts` and the tests
 * read them and because `derivePort` must answer the same number in both trees:
 * an operator who upgrades from free to Pro keeps the port they bookmarked.
 * With one slot nothing in this tree reaches the range — but it is the same
 * range, and that is the point.
 */
export const PORT_RANGE_START = 4124;
export const PORT_RANGE_SIZE = 100;

/** Project-local, committed, shareable: `{name?, port?}` and nothing else. */
export const PROJECT_FILE = '.phase-console.json';

const REGISTRY_VERSION = 1;

/** A lock older than this belonged to a process that is not coming back. */
const LOCK_STALE_MS = 10_000;

const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;

/* ------------------------------------------------------------------ *
 * Identity — verbatim from the Pro module
 * ------------------------------------------------------------------ */

/**
 * The id of the console that serves this project root.
 *
 * `sha256(root)[:8]-basename(root)` — the hash keeps two checkouts of the same
 * repository apart, the basename keeps the directory name readable to whoever
 * is reading `~/.local/state/phase-console/instances/` at 2am.
 *
 * The path is resolved first so `/p/repo`, `/p/repo/` and `/p/sub/../repo` are
 * one instance rather than three. Resolution is lexical (never `realpath`), so
 * a symlinked path stays its own identity.
 */
export function instanceId(root) {
  const path = resolve(String(root ?? '.'));
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return `${hash}-${basename(path) || 'root'}`;
}

/** The port a non-default instance lands on before any probing. */
export function derivePort(id) {
  const hash = String(id ?? '').slice(0, 8);
  const n = parseInt(hash, 16);
  const offset = Number.isFinite(n) ? Math.abs(n) % PORT_RANGE_SIZE : 0;
  return PORT_RANGE_START + offset;
}

/** `http://127.0.0.1:<port>` — the one form every message prints. */
export function instanceUrl(port, host = '127.0.0.1') {
  return `http://${host}:${port}`;
}

/* ------------------------------------------------------------------ *
 * Where the registry lives — verbatim
 * ------------------------------------------------------------------ */

/**
 * Where this machine keeps console configuration.
 *
 * `XDG_CONFIG_HOME` falls through to the real process environment when the
 * caller's `env` does not define it, and that fallback is load-bearing: callers
 * pass a partial environment all the time, and taking those objects literally
 * would answer `$HOME/.config` for every one of them — the operator's REAL
 * registry, read by a process that believed it was sandboxed.
 */
export function configHome(env = process.env) {
  const home = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  guardTestState(home, join(homedir(), '.config'), 'XDG_CONFIG_HOME');
  return home;
}

export function configDir(env = process.env) {
  return join(configHome(env), 'phase-console');
}

/** Machine-local state, by the same rule as `configHome`. */
export function stateHome(env = process.env) {
  const home = env.XDG_STATE_HOME ?? process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  guardTestState(home, join(homedir(), '.local', 'state'), 'XDG_STATE_HOME');
  return join(home, 'phase-console');
}

/**
 * A TEST process that resolves the operator's real state/config directories is
 * a leak in the making. It throws rather than warns, with the fix in the
 * message; production never sets the test markers.
 */
function guardTestState(resolved, real, envName) {
  const env = process.env;
  const testing =
    env.NODE_TEST_CONTEXT ||
    env.VITEST ||
    process.argv.includes('--test') ||
    process.argv.some((a) => a.startsWith('--test-'));
  if (!testing || env.PHASE_CONSOLE_ALLOW_REAL_STATE) return;
  if (resolved === real) {
    throw new Error(
      `a test process resolved the REAL ${envName === 'XDG_STATE_HOME' ? 'state' : 'config'} ` +
        `directory (${join(real, 'phase-console')}) — import viewer/test/state-sandbox.ts before ` +
        `any server import, or set ${envName}. Deliberate real reads: PHASE_CONSOLE_ALLOW_REAL_STATE=1.`,
    );
  }
}

/**
 * Where an instance keeps its log, inbox, push keys and approvals queue.
 *
 * The branch is kept even though this tree's only instance is the default one:
 * the paths must be the same function of the same inputs in both trees, or an
 * upgrade to Pro would silently move an operator's state.
 */
export function instanceStateDir(id, isDefault, env = process.env) {
  const base = stateHome(env);
  return isDefault ? base : join(base, 'instances', safeId(id));
}

export function registryPath(env = process.env) {
  return join(configDir(env), 'instances.json');
}

/** Per-instance preferences: `~/.config/phase-console/instances/<id>.json`. */
export function instancePrefsPath(id, env = process.env) {
  return join(configDir(env), 'instances', `${safeId(id)}.json`);
}

/** Anything that could add a line to output someone parses line by line. */
function stripControl(value) {
  // eslint-disable-next-line no-control-regex -- stripping C0 controls and DEL is the point
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function safeId(id) {
  return (
    String(id ?? '')
      .replace(/[^\w.-]/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+/, '')
      .slice(0, 80) || 'unnamed'
  );
}

/* ------------------------------------------------------------------ *
 * The registry — one slot
 * ------------------------------------------------------------------ */

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No SharedArrayBuffer: fall back to not waiting, as the Pro file does.
  }
}

/** An empty registry — the shape every reader can rely on getting. */
function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: {} };
}

/**
 * The single entry, whatever the file holds.
 *
 * Prefers the one marked `default` over the first written, so a file left by a
 * Pro console (an operator who downgraded, or two trees sharing one `$HOME`)
 * resolves to the console that owns the legacy paths rather than to whichever
 * project happened to be registered first.
 *
 * A READ hides the other rows and never deletes them, so merely starting a free
 * console — or shelling `runCli shell`, which every script in the tree does —
 * leaves a Pro fleet's registry intact. A WRITE is a different matter and is
 * deliberately not softened: `registerInstance` narrows the FILE to the one
 * slot, because a registry this tree can only half-read is worse than one it
 * agrees with. So the honest statement is: reading is safe beside a Pro
 * console, registering takes the file over. Pinned by `free-tree-shape.test.ts`.
 */
function soleEntry(instances) {
  const rows = Object.entries(instances ?? {});
  if (!rows.length) return null;
  const [id, entry] = rows.find(([, value]) => value?.default === true) ?? rows[0];
  return [id, { ...entry, default: true }];
}

/**
 * The registry as this tree sees it: at most one instance, and it is default.
 *
 * The FILE is read exactly as Pro reads it — same path, same tolerance for a
 * missing, truncated or future-shaped file — and then narrowed. Reading the
 * real file rather than answering empty is what lets a restarted free console
 * find the port and pid it recorded, and what lets `bin/btw` and
 * `scripts/instance.sh` shell `runCli shell` and get a real answer.
 */
export function readRegistry(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.instances !== 'object' || !parsed.instances) {
      return emptyRegistry();
    }
    const valid = {};
    for (const [id, entry] of Object.entries(parsed.instances)) {
      if (entry && typeof entry === 'object' && typeof entry.root === 'string') valid[id] = entry;
    }
    const sole = soleEntry(valid);
    return { version: REGISTRY_VERSION, instances: sole ? { [sole[0]]: sole[1] } : {} };
  } catch {
    return emptyRegistry();
  }
}

/**
 * Replace the registry atomically — temp file plus rename, so a reader never
 * sees half a file.
 *
 * Narrowed to the single slot on the way out as well as on the way in. A writer
 * that handed this two entries would otherwise leave a file this tree's own
 * reader then silently halves, which is a disagreement between what was written
 * and what is read — the failure mode a one-slot registry exists to remove.
 */
export function writeRegistry(registry, env = process.env) {
  const file = registryPath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  const sole = soleEntry(registry?.instances);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      tmp,
      `${JSON.stringify(
        { version: REGISTRY_VERSION, instances: sole ? { [sole[0]]: sole[1] } : {} },
        null,
        2,
      )}\n`,
      'utf8',
    );
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is not the point */
    }
    return false;
  }
}

/**
 * Run `mutate` with the registry held, and write back what it returns.
 *
 * Verbatim from Pro, lock and all. Two free consoles on one machine is not a
 * fleet — it is two people starting `./start` in the same second, and the write
 * they race for is the one holding the pid that stops them.
 */
export function withRegistry(mutate, env = process.env) {
  const lock = `${registryPath(env)}.lock`;
  let held = false;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    for (let waited = 0; !held; waited += LOCK_POLL_MS) {
      try {
        closeSync(openSync(lock, 'wx'));
        held = true;
      } catch {
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          age = LOCK_STALE_MS + 1;
        }
        if (age > LOCK_STALE_MS) {
          try {
            rmSync(lock, { force: true });
          } catch {
            /* raced */
          }
          continue;
        }
        if (waited >= LOCK_WAIT_MS) break;
        sleepSync(LOCK_POLL_MS);
      }
    }
    const registry = readRegistry(env);
    const next = mutate(registry);
    if (next === null || next === undefined) return registry;
    writeRegistry(next, env);
    return next;
  } catch {
    return readRegistry(env);
  } finally {
    if (held) {
      try {
        rmSync(lock, { force: true });
      } catch {
        /* released by expiry */
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

/**
 * The one registered instance, as a list — never more than one row.
 *
 * A list rather than a scalar because every caller iterates it (`config.ts`
 * resolves `--instance` by scanning it, `reservedPorts` folds it, the CLI's
 * `list` prints it), and changing the shape here would mean editing them all in
 * the free tree — the drift this override exists to avoid.
 */
export function listInstances(env = process.env) {
  const { instances } = readRegistry(env);
  return Object.entries(instances).map(([id, entry]) => ({ id, ...entry }));
}

/** One instance by id, or `null`. */
export function getInstance(id, env = process.env) {
  const entry = readRegistry(env).instances[id];
  return entry ? { id, ...entry } : null;
}

/** The instance registered for this root, or `null`. */
export function instanceForRoot(root, env = process.env) {
  return getInstance(instanceId(root), env);
}

/**
 * Which instance claims this port — the question an EADDRINUSE needs answered.
 *
 * A registry answer is a claim, not a proof. With one slot the honest answer is
 * usually `null`, and `index.ts` already says "something else is listening
 * there — no console this machine knows of" when it gets one.
 */
export function instanceForPort(port, env = process.env) {
  return listInstances(env).find((entry) => entry.port === port) ?? null;
}

/** The one instance, or `null` if this machine has never started one. */
export function defaultInstance(env = process.env) {
  return listInstances(env).find((entry) => entry.default === true) ?? null;
}

/** Said once per process, so a loop cannot turn an explanation into noise. */
let refused = false;
function refuseFleet(what) {
  if (refused) return;
  refused = true;
  process.stderr.write(
    `phase-console: ${what} needs a fleet of consoles, which is Phase Console Pro.\n`
      + 'This build runs one console for one repository.\n',
  );
}

/**
 * Add or update THE entry, and return it.
 *
 * The slot is replaced rather than joined, and `default` is forced true: with
 * one console there is no election to lose, and `config.ts`'s `electInstance`
 * reads a `false` back as "another console won the race" and refuses to start.
 * So the free answer to "am I the default?" has to be yes, always — which it
 * is, because there is nobody else.
 *
 * Replacing is deliberate, not a shortcut. Free never runs two consoles at
 * once, so the previous occupant is a console that has stopped, and its state
 * directory — the thing worth protecting — is keyed by `instanceId` and is
 * untouched by this. Pointing the slot at the project you just opened is what
 * the operator asked for by opening it.
 *
 * The single refusal: `default: false` is a caller asking for a NON-default
 * instance, and that is a fleet. Nothing in this tree passes it; it is here so
 * that the property is the module's rather than its callers'.
 */
export function registerInstance(root, patch = {}, env = process.env) {
  const path = resolve(String(root ?? '.'));
  const id = instanceId(path);
  if (patch.default === false) {
    refuseFleet('registering a non-default console');
    return getInstance(id, env);
  }
  withRegistry((registry) => {
    const previous = registry.instances[id] ?? {};
    const entry = {
      ...previous,
      ...stripUndefined(patch),
      default: true,
      root: path,
      name: patch.name ?? previous.name ?? (basename(path) || id),
    };
    return { ...registry, instances: { [id]: entry } };
  }, env);
  return getInstance(id, env);
}

/** Patch the entry in place. An id that is not the one held is a no-op. */
export function updateInstance(id, patch = {}, env = process.env) {
  withRegistry((registry) => {
    const previous = registry.instances[id];
    if (!previous) return null;
    return {
      ...registry,
      instances: { [id]: { ...previous, ...stripUndefined(patch), default: true } },
    };
  }, env);
  return getInstance(id, env);
}

/** Forget the instance. Its state directory is left alone. */
export function removeInstance(id, env = process.env) {
  let removed = false;
  withRegistry((registry) => {
    if (!registry.instances[id]) return null;
    removed = true;
    return { ...registry, instances: {} };
  }, env);
  return removed;
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object ?? {}).filter(([, value]) => value !== undefined));
}

/* ------------------------------------------------------------------ *
 * Answering "which console serves where I am standing?" — verbatim
 * ------------------------------------------------------------------ */

/**
 * The instance that owns `cwd`, walking up until something claims it.
 *
 * Unchanged: a `registered` hit is the console that exists, a `candidate` is a
 * directory that looks like a project but has never been started. With one slot
 * the walk simply has fewer ways to answer `registered`, which is correct.
 */
export function resolveInstance(cwd = process.cwd(), env = process.env) {
  const start = resolve(String(cwd ?? '.'));
  const { instances } = readRegistry(env);
  let candidate = null;

  for (let dir = start; ; dir = dirname(dir)) {
    const id = instanceId(dir);
    if (instances[id]) return { kind: 'registered', id, root: dir, ...instances[id] };
    if (!candidate && looksLikeProject(dir, env))
      candidate = { kind: 'candidate', id, root: dir, name: basename(dir) || id };
    if (dirname(dir) === dir) break;
  }
  return candidate ?? { kind: 'none', root: start };
}

/**
 * A directory the console could open: it has plans, or it says it is one.
 *
 * Except the Claude CLI's own config directory, which has a `plans/` of its own
 * and is infrastructure rather than a project. Mirrored by
 * `pe_project_root_for` in `scripts/instance.sh`.
 */
export function looksLikeProject(dir, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  if (resolve(dir) === resolve(config)) return false;
  return (
    existsSync(join(dir, 'docs', 'plans')) ||
    existsSync(join(dir, 'plans')) ||
    existsSync(join(dir, PROJECT_FILE))
  );
}

/**
 * Which console does this word mean — and, with no word, which one am I in?
 *
 * The chain is Pro's, unchanged, and it still earns its keep here: the last
 * step ("a machine running exactly one console means that one") is the normal
 * case in this tree rather than the lucky one, and `candidate` still outranks
 * it so that standing in an unregistered project and starting means THIS one.
 */
export function selectInstance(selector, cwd = process.cwd(), env = process.env) {
  const entries = listInstances(env);
  const wanted = String(selector ?? '').trim();

  if (wanted) {
    const byId = entries.find((entry) => entry.id === wanted);
    if (byId) return { kind: 'registered', ...byId };

    for (const matches of [
      entries.filter((entry) => entry.name === wanted),
      entries.filter((entry) => basename(String(entry.root ?? '')) === wanted),
    ]) {
      if (matches.length === 1) return { kind: 'registered', ...matches[0] };
      if (matches.length > 1) return { kind: 'ambiguous', selector: wanted, candidates: matches };
    }
    return { kind: 'none', selector: wanted, candidates: entries };
  }

  const here = resolveInstance(cwd, env);
  if (here.kind === 'registered' || here.kind === 'candidate') return here;
  if (entries.length === 1) return { kind: 'registered', ...entries[0] };
  return { kind: 'none', selector: null, candidates: entries };
}

/** The instance for THIS EXACT root — no walking up. */
export function selectRoot(root, env = process.env) {
  const path = resolve(String(root ?? '.'));
  const id = instanceId(path);
  const entry = getInstance(id, env);
  if (entry) return { kind: 'registered', ...entry };
  return {
    kind: 'candidate',
    id,
    root: path,
    name: readProjectFile(path, env).name ?? (basename(path) || id),
  };
}

/* ------------------------------------------------------------------ *
 * Units — verbatim
 * ------------------------------------------------------------------ */

/**
 * The launchd label / systemd unit generated for an instance.
 *
 * Kept whole, suffix branch included. There is no script in this tree that
 * installs a unit — but `runCli shell` still reports `generated_unit`
 * and `unit_file`, `config.ts` still derives `LEGACY_UNIT` from it at module
 * load, and both have to answer what Pro answers.
 */
export function unitName(instance, platform = process.platform) {
  const darwin = platform === 'darwin';
  if (instance?.default) return darwin ? 'com.phase-console' : 'phase-console.service';
  const id = safeId(instance?.id);
  return darwin ? `com.phase-console.${id}` : `phase-console-${id}.service`;
}

/** Where the supervisor reads that unit from. */
export function unitPath(name, platform = process.platform, env = process.env) {
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`)
    : join(configHome(env), 'systemd', 'user', name);
}

/* ------------------------------------------------------------------ *
 * The project file — verbatim
 * ------------------------------------------------------------------ */

/**
 * `.phase-console.json` at a project root: `{name?, port?}`, nothing else.
 *
 * Committed and shared with a team, so the allowlist is the feature: no paths,
 * no secrets, no flags that widen what the console may do. Control characters
 * are stripped before anything else looks at the name, because this file
 * arrives with a clone and the name reaches a `key=value` line a shell reads.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name?: string, port?: number }}
 */
export function readProjectFile(root, env = process.env) {
  void env;
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(String(root ?? '.')), PROJECT_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    /** @type {{ name?: string, port?: number }} */
    const out = {};
    const named = typeof parsed.name === 'string' ? stripControl(parsed.name).trim() : '';
    if (named) out.name = named.slice(0, 60);
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port;
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Ports — verbatim
 * ------------------------------------------------------------------ */

/**
 * The port this root should try, before anything checks whether it is free.
 *
 * The precedence chain is Pro's: `--port`, `PHASE_CONSOLE_PORT`, the project's
 * committed file, the port this instance last bound, then the derived slot — or
 * 4123, which is what `isDefaultRoot` answers in this tree.
 */
export function preferredPort(root, options = {}, env = process.env) {
  const { flagPort, isDefault } = options;
  if (Number.isInteger(flagPort) && flagPort > 0) return flagPort;

  const fromEnv = Number(env.PHASE_CONSOLE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;

  const project = readProjectFile(root, env);
  if (project.port) return project.port;

  const entry = instanceForRoot(root, env);
  if (entry && Number.isInteger(entry.port) && entry.port > 0) return entry.port;

  const fallbackDefault = isDefault ?? isDefaultRoot(root, env);
  return fallbackDefault ? DEFAULT_PORT : derivePort(instanceId(root));
}

/**
 * Is this root the default instance — the one that keeps the legacy footprint?
 *
 * **Always yes**, and this is the one identity function that is NOT verbatim.
 *
 * Pro's predicate reads the registry, and under a one-slot registry that answer
 * FLIPS as the slot moves: a root that is not the current occupant reads
 * `false`, and the instant it registers it reads `true`. `config.ts` derives
 * `INSTANCE_STATE_DIR` from it at module load, so pointing a free console at a
 * second repository moved its state directory between boots — and then, on the
 * boot after that, landed it on the FIRST repository's directory: its `push/`
 * subscriptions, its inbox, its approvals queue, its `accounts/` and `mcp/`
 * registries. Silent, and exactly the failure the Pro module's own header calls
 * "worse" than a loud one. `preferredPort` had the same dependency, so the
 * bookmarked port flipped 4123 ↔ derived with it.
 *
 * Registry-independence is the fix, and it is also the honest statement of what
 * this tier is: one console, on 4123, keeping the flat legacy paths — `free/README.md`
 * says so in as many words. The state directory, the unit name and the port are
 * now a pure function of nothing at all, which is what "there is only ever one
 * console" means.
 *
 * **And one console means one state directory: everything the Pro tree keys off
 * `isDefault` is shared here, whichever repository this console is pointed at.**
 * Stated as a rule rather than a list, because an enumeration of what is shared
 * is a list that goes stale — the first draft of this comment named four stores
 * and was short by six (per-instance prefs, and with them `worktreeSetup`; the
 * fleet freeze; inbox acks; the session registry; the approvals queue; the pty
 * broker socket). What stays SEPARATED is worth naming, because it is the short
 * list and the surprising one: run journals, at `runs/<instanceId(root)>/<slug>`
 * (`runner/state.ts`), which build from `STATE_DIR` rather than from this answer.
 *
 * That sharing is the unavoidable consequence of a one-slot registry, not a
 * consequence of this function: with one slot there is one console, and a
 * console's own stores are its own. It is a real trade, and it belongs in the
 * open rather than behind a reassuring sentence.
 *
 * `free-tree-shape.test.ts` pins the boot sequence this restores: A, then B,
 * then B again, all answering one stable path — READ before each register, in
 * the order `config.ts` actually does it (module load, then `electInstance`).
 */
export function isDefaultRoot(root, env = process.env) {
  void root;
  void env;
  return true;
}

/**
 * Ports already spoken for by *other* roots — always empty here.
 *
 * There is one slot, so `exceptRoot` either names it (skipped) or does not
 * exist. Kept because `config.ts` consults it before probing, and an empty set
 * is the honest answer rather than a special case.
 */
export function reservedPorts(exceptRoot, env = process.env) {
  const skip = exceptRoot === undefined ? null : instanceId(exceptRoot);
  const taken = new Set();
  for (const entry of listInstances(env)) {
    if (entry.id === skip) continue;
    if (Number.isInteger(entry.port) && entry.port > 0) taken.add(entry.port);
  }
  return taken;
}

/* ------------------------------------------------------------------ *
 * CLI — what bash shells out to
 * ------------------------------------------------------------------ */

/**
 * What to say when a selector matched nothing, or matched too much.
 *
 * Always lists what there IS — which in this tree is one console or none, and
 * the "none" arm is the one an operator actually reads.
 */
export function selectionError(found) {
  const names = (found.candidates ?? []).map((entry) => entry.name ?? entry.id);
  if (found.kind === 'ambiguous') {
    return `"${found.selector}" matches ${names.length} instances (${names.join(', ')}) — name one by id: ${(found.candidates ?? []).map((e) => e.id).join(', ')}`;
  }
  if (found.selector) {
    return names.length
      ? `no instance called "${found.selector}" — this machine has: ${names.join(', ')}`
      : `no instance called "${found.selector}", and none are registered yet — run: phase-console`;
  }
  return names.length
    ? `not inside a registered project, and this machine has ${names.length} instances (${names.join(', ')}) — name one`
    : 'no console is registered on this machine yet — cd to a project and run: phase-console';
}

/**
 * One argv, one answer on stdout, exit 0 or 1. No colour, no prose.
 *
 * The op set is Pro's, unchanged and complete, because `scripts/instance.sh`,
 * `bin/btw`, `scripts/session-hook.sh`, `scripts/phase-outcome.sh` and
 * `scripts/phase-tasks.sh` all shell this and all ship in the free tree. What
 * changes is what the registry beneath it can hold: `list` prints at most one
 * row, `register` replaces the slot. Kept deliberately dumb — every consumer is
 * a shell script capturing stdout.
 */
export function runCli(argv, env = process.env) {
  const [op, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter(
    (arg, i) => !arg.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')),
  );
  const num = (value) => (value === undefined ? undefined : Number(value));

  switch (op) {
    case 'id':
      return { out: instanceId(positional[0] ?? '.'), code: 0 };

    case 'register': {
      const entry = registerInstance(
        positional[0] ?? '.',
        {
          name: flag('name'),
          port: num(flag('port')),
          unit: flag('unit'),
          pid: num(flag('pid')),
          startedAt: flag('started-at'),
          default: rest.includes('--default') ? true : undefined,
        },
        env,
      );
      return { out: JSON.stringify(entry), code: entry ? 0 : 1 };
    }

    case 'update': {
      const entry = updateInstance(
        positional[0] ?? '',
        {
          name: flag('name'),
          root: flag('root'),
          port: num(flag('port')),
          unit: flag('unit'),
          pid: num(flag('pid')),
          startedAt: flag('started-at'),
          default: rest.includes('--default') ? true : undefined,
        },
        env,
      );
      if (!entry) return { err: `no such instance: ${positional[0] ?? ''}`, code: 1 };
      return { out: JSON.stringify(entry), code: 0 };
    }

    case 'remove':
      return removeInstance(positional[0] ?? '', env)
        ? { out: positional[0], code: 0 }
        : { err: `no such instance: ${positional[0] ?? ''}`, code: 1 };

    case 'list': {
      const entries = listInstances(env);
      if (rest.includes('--json')) return { out: JSON.stringify(entries), code: 0 };
      // Tab-separated so `cut -f` and `while read` both work without quoting.
      return {
        out: entries
          .map((e) => [e.id, e.name ?? '', e.port ?? '', e.default ? 'default' : '', e.root].join('\t'))
          .join('\n'),
        code: 0,
      };
    }

    case 'resolve':
      return { out: JSON.stringify(resolveInstance(positional[0] ?? process.cwd(), env)), code: 0 };

    case 'select': {
      const found = flag('root')
        ? selectRoot(flag('root'), env)
        : selectInstance(positional[0], flag('cwd') ?? process.cwd(), env);
      if (found.kind === 'registered' || found.kind === 'candidate') {
        return { out: JSON.stringify(found), code: 0 };
      }
      return { err: selectionError(found), code: 1 };
    }

    // The same selection, as `key=value` lines a shell reads with `while read`.
    // Values are control-stripped because a shell reading this line by line is
    // exactly what a newline in a name would exploit.
    case 'shell': {
      const found = flag('root')
        ? selectRoot(flag('root'), env)
        : selectInstance(positional[0], flag('cwd') ?? process.cwd(), env);
      if (found.kind !== 'registered' && found.kind !== 'candidate') {
        return { err: selectionError(found), code: 1 };
      }
      const isDefault =
        found.default === true || (found.kind === 'candidate' && isDefaultRoot(found.root, env));
      const instance = { id: found.id, default: isDefault };
      const unit = unitName(instance, flag('platform') ?? process.platform);
      const port = found.port ?? preferredPort(found.root, { isDefault }, env);
      const pairs = [
        ['kind', found.kind],
        ['id', found.id],
        ['name', found.name ?? ''],
        ['root', found.root ?? ''],
        ['port', String(port)],
        ['url', instanceUrl(port)],
        ['default', isDefault ? '1' : ''],
        ['unit', found.unit ?? ''],
        ['generated_unit', unit],
        ['unit_file', unitPath(unit, flag('platform') ?? process.platform, env)],
        ['state_dir', instanceStateDir(found.id, isDefault, env)],
        ['pid', String(found.pid ?? '')],
      ];
      return { out: pairs.map(([key, value]) => `${key}=${stripControl(value)}`).join('\n'), code: 0 };
    }

    case 'port':
      return { out: String(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    case 'url':
      return { out: instanceUrl(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    default:
      return {
        err:
          'usage: instances.mjs id|register|update|remove|list|resolve|select|shell|port|url [<path-or-selector>]' +
          ' [--name n] [--port p] [--unit u] [--pid n] [--started-at s] [--cwd d] [--platform p] [--default] [--json]',
        code: 2,
      };
  }
}

// Executed directly (`node viewer/shared/instances.mjs id <root>`) rather than
// imported. `process.argv[1]` is compared against this file's own URL so that
// importing the module never runs the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { out, err, code } = runCli(process.argv.slice(2));
  if (out) process.stdout.write(`${out}\n`);
  if (err) process.stderr.write(`${err}\n`);
  process.exit(code);
}
