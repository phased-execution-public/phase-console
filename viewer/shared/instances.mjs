/**
 * Which console is this, and where does it keep its things — the FREE tree.
 *
 * This file replaces `viewer/shared/instances.mjs` when
 * `scripts/build-free-tree.mjs` materializes the public repository. It is not
 * a smaller module: it exports the SAME 58 names, with the same signatures and
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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { HEARTBEAT_STALE_MS } from './fleet-model.js';

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

/* ------------------------------------------------------------------ *
 * The stop marker and the machine profile (zero-touch phase 16)
 * ------------------------------------------------------------------ */

/**
 * The file a `mode: 'unload'` Shut down leaves in the instance's state
 * directory (SHD-5). While it stands the console boots holding its automation:
 * nothing is re-adopted and nothing converges until an operator clears it —
 * `phase-console start` removes it, and so does Settings. Named here because
 * three readers need it and one is bash: the server, the bin, and
 * `deploy/agent.sh` through the `shell` op's `stop_marker=` line.
 */
export const STOP_MARKER_NAME = 'stopped-by-console.json';

export function stopMarkerPath(id, isDefault, env = process.env) {
  return join(instanceStateDir(id, isDefault, env), STOP_MARKER_NAME);
}

/**
 * The machine profile — `~/.config/phase-console/fleet.json` (FLT-3, FLT-7,
 * FLT-9). Everything the phone path and the machine's limits need is a property
 * of the machine and the person, not of one console, so it is written once here
 * and read by every console:
 *
 *   { version, remoteHost, remoteUsers[], notifyCommand, webhooks[{url, name?, categories?}],
 *     categories{<id>: bool}, quietHours{start, end, allowUrgent}, maxSessions, hookScript,
 *     instances: { <id>: { autostart: true|false|'once', overrides: {…} } } }
 *
 * `maxSessions` is the MACHINE lane ceiling (every console's live lanes summed);
 * each console's own `--max-sessions` stays its per-console ceiling. `overrides`
 * replaces the six per-console fields (`OVERRIDABLE_PROFILE_KEYS`) for one
 * instance, and a console reports which ones it took from there on `state()`.
 */
export function fleetProfilePath(env = process.env) {
  return join(configDir(env), 'fleet.json');
}

/** The profile as JSON, or null for a missing or unreadable file — never a throw. */
function readFleetProfile(env) {
  try {
    const parsed = JSON.parse(readFileSync(fleetProfilePath(env), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Does this instance start its work unattended? `true` (the default, and the
 * answer for a missing or unreadable profile — a console that wrongly believes
 * it may not start is a console that silently does nothing), `false`, or
 * `'once'` — the next boot starts it and spends the word.
 */
export function readAutostart(id, env = process.env) {
  const value = readFleetProfile(env)?.instances?.[id]?.autostart;
  return value === false || value === 'once' ? value : true;
}

/**
 * Spend a `once`: the instance's entry becomes `autostart: false`, every other
 * key of the profile carried through. Atomic (temp file + rename). Returns
 * whether it changed anything.
 */
export function consumeAutostartOnce(id, env = process.env) {
  const profile = readFleetProfile(env);
  if (profile?.instances?.[id]?.autostart !== 'once') return false;
  const next = {
    ...profile,
    instances: { ...profile.instances, [id]: { ...profile.instances[id], autostart: false } },
  };
  const file = fleetProfilePath(env);
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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

/** The six profile fields one console may override for itself. */
export const OVERRIDABLE_PROFILE_KEYS = Object.freeze([
  'remoteHost',
  'remoteUsers',
  'notifyCommand',
  'webhooks',
  'categories',
  'quietHours',
]);

const QUIET_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * One profile's fields, each kept only in the shape a console can act on.
 *
 * A hand-edited profile is the normal case, and a field a console cannot read
 * must not turn into a console that cannot boot: `remoteUsers` that are not
 * strings, a quiet window with no end, a ceiling of zero — each is dropped
 * rather than half-honoured, exactly as the per-device quiet hours are.
 */
function sanitizeProfileFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.remoteHost === 'string' && raw.remoteHost.trim()) {
    out.remoteHost = stripControl(raw.remoteHost).trim().toLowerCase().replace(/\.$/, '');
  }
  if (Array.isArray(raw.remoteUsers)) {
    const users = [
      ...new Set(
        raw.remoteUsers
          .filter((user) => typeof user === 'string' && user.trim())
          .map((user) => stripControl(user).trim().toLowerCase()),
      ),
    ];
    if (users.length) out.remoteUsers = users;
  }
  if (typeof raw.notifyCommand === 'string' && raw.notifyCommand.trim())
    out.notifyCommand = raw.notifyCommand;
  if (Array.isArray(raw.webhooks)) {
    const hooks = raw.webhooks
      .filter((hook) => hook && typeof hook.url === 'string' && /^https?:\/\//.test(hook.url))
      .map((hook) => ({
        url: hook.url,
        ...(typeof hook.name === 'string' && hook.name.trim()
          ? { name: stripControl(hook.name).trim() }
          : {}),
        ...(Array.isArray(hook.categories)
          ? { categories: hook.categories.filter((c) => typeof c === 'string') }
          : {}),
      }));
    if (hooks.length) out.webhooks = hooks;
  }
  if (raw.categories && typeof raw.categories === 'object' && !Array.isArray(raw.categories)) {
    const categories = Object.fromEntries(
      Object.entries(raw.categories).filter(([, on]) => typeof on === 'boolean'),
    );
    if (Object.keys(categories).length) out.categories = categories;
  }
  const quiet = raw.quietHours;
  if (
    quiet &&
    typeof quiet === 'object' &&
    QUIET_TIME.test(String(quiet.start ?? '')) &&
    QUIET_TIME.test(String(quiet.end ?? '')) &&
    quiet.start !== quiet.end
  ) {
    out.quietHours = { start: quiet.start, end: quiet.end, allowUrgent: quiet.allowUrgent !== false };
  }
  if (Number.isInteger(raw.maxSessions) && raw.maxSessions > 0) out.maxSessions = raw.maxSessions;
  if (typeof raw.hookScript === 'string' && raw.hookScript.startsWith('/')) out.hookScript = raw.hookScript;
  return out;
}

/**
 * The direct door (many-plans-one-repo phases 21–22) is Pro: it is the fleet
 * supervisor's second listener, and this tree has no supervisor to open one, so
 * a profile's `reach` block is never read here — `sanitizeProfileFields` above
 * drops it with every other field it does not know. The two readers keep their
 * names and shapes because `free-tree-shape.test.ts` holds this file to the Pro
 * export set, and they answer what "no block" answers there: no door, and the
 * default mode. The rule id is this tree's own — the Pro table it would name
 * lives in `reach-model.js`, which is a Pro path. Both take what the Pro
 * readers take (a raw block; an environment) and read none of it, which is why
 * neither names a parameter — the free tree's lint would call it unused.
 *
 * @returns {{ reach: null, rule: string }}
 */
export function explainReach() {
  return { reach: null, rule: 'not-in-this-tree' };
}

/**
 * @returns {{ mode: 'tailscale', reach: null, rule: null }}
 */
export function readReach() {
  return { mode: 'tailscale', reach: null, rule: null };
}

/**
 * @typedef {{
 *   remoteHost?: string,
 *   remoteUsers?: string[],
 *   notifyCommand?: string,
 *   webhooks?: { url: string, name?: string, categories?: string[] }[],
 *   categories?: Record<string, boolean>,
 *   quietHours?: { start: string, end: string, allowUrgent: boolean },
 *   maxSessions?: number,
 *   hookScript?: string,
 * }} ProfileFields
 */

/**
 * The machine profile as every console reads it: the sanitised fields, each
 * instance's `autostart` and `overrides`, and whether a file exists at all.
 * A missing or unreadable file is `present: false` with nothing set — never a throw.
 */
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ProfileFields & { present: boolean, path: string, instances: Record<string, { autostart?: boolean | 'once', overrides?: ProfileFields }> }}
 */
export function fleetProfile(env = process.env) {
  const raw = readFleetProfile(env);
  const fields = sanitizeProfileFields(raw);
  const instances = {};
  for (const [id, entry] of Object.entries(raw?.instances ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry.autostart;
    const overrides = Object.fromEntries(
      Object.entries(sanitizeProfileFields(entry.overrides)).filter(([key]) =>
        OVERRIDABLE_PROFILE_KEYS.includes(key),
      ),
    );
    instances[id] = {
      ...(value === true || value === false || value === 'once' ? { autostart: value } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
    };
  }
  return { present: raw !== null, path: fleetProfilePath(env), ...fields, instances };
}

/**
 * What ONE console takes from the profile: each overridable field from its
 * own `overrides` when set there, else from the machine-wide value, with the
 * source of each named — so `state()` can say which settings are this
 * console's own and which it inherited.
 */
/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Omit<ProfileFields, 'maxSessions' | 'hookScript'> & {
 *   present: boolean, path: string, maxSessions: number | null, hookScript: string | null,
 *   autostart: boolean | 'once',
 *   sources: Partial<Record<'remoteHost' | 'remoteUsers' | 'notifyCommand' | 'webhooks' | 'categories' | 'quietHours', 'profile' | 'override'>>,
 *   overridden: string[],
 * }}
 */
export function profileFor(id, env = process.env) {
  const profile = fleetProfile(env);
  const overrides = profile.instances[id]?.overrides ?? {};
  const effective = {};
  const sources = {};
  for (const key of OVERRIDABLE_PROFILE_KEYS) {
    if (overrides[key] !== undefined) {
      effective[key] = overrides[key];
      sources[key] = 'override';
    } else if (profile[key] !== undefined) {
      effective[key] = profile[key];
      sources[key] = 'profile';
    }
  }
  return {
    present: profile.present,
    path: profile.path,
    ...effective,
    maxSessions: profile.maxSessions ?? null,
    hookScript: profile.hookScript ?? null,
    autostart: readAutostart(id, env),
    sources,
    overridden: Object.keys(overrides),
  };
}

/**
 * Rewrite the profile under its lock: `mutate` receives the file as it is on
 * disk (unknown keys kept — a newer console's fields survive an older one's
 * write) and returns the next object, or null for "nothing to write". Atomic
 * (temp file + rename). Returns the profile as read back, or null when the
 * write failed.
 */
export function updateFleetProfile(mutate, env = process.env) {
  const file = fleetProfilePath(env);
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return null;
  }
  return withLockFile(`${file}.lock`, () => {
    const current = readFleetProfile(env) ?? { version: 1 };
    const next = mutate(structuredClone(current));
    if (next === null || next === undefined) return fleetProfile(env);
    const tmp = `${file}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is not the point */
      }
      return null;
    }
    return fleetProfile(env);
  });
}

/** Set one instance's start policy — `true`, `false` or `'once'`. False on a bad value or a failed write. */
export function setAutostart(id, value, env = process.env) {
  if (value !== true && value !== false && value !== 'once') return false;
  const written = updateFleetProfile((profile) => {
    const instances = profile.instances && typeof profile.instances === 'object' ? profile.instances : {};
    return { ...profile, instances: { ...instances, [id]: { ...instances[id], autostart: value } } };
  }, env);
  return written?.instances[id]?.autostart === value;
}

/**
 * Hold `lock` (an `O_EXCL` file) while `fn` runs — the registry's discipline,
 * for the other machine files two consoles write: the profile and the lane
 * tokens. A lock older than `LOCK_STALE_MS` is reclaimed and a live one waited
 * for up to `LOCK_WAIT_MS`; then `fn` runs anyway, because a pathological
 * holder must not be able to stop a console.
 */
function withLockFile(lock, fn) {
  let held = false;
  try {
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
    return fn();
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
    // An ORPHANED row — its root is gone — speaks for nobody (FLT-5): a
    // deleted `/tmp` project must not hold a port against a live one forever.
    if (!rootExists(entry.root)) continue;
    if (Number.isInteger(entry.port) && entry.port > 0) taken.add(entry.port);
  }
  return taken;
}

function rootExists(root) {
  try {
    return typeof root === 'string' && root !== '' && existsSync(root);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * The heartbeat and the census (zero-touch phase 17, FLT-5 / FLT-6)
 * ------------------------------------------------------------------ */

/**
 * A console's own beat: `lastSeenAt` now, `stoppedAt` cleared, and whatever
 * else it reports about itself (`pid`, `port`, `build`, `supervisor`, `lanes`,
 * `needsYou`, `lastRemoteAt`) patched into its registry row. Written by the
 * console every `HEARTBEAT_MS`, so liveness is read, never probed. A row that
 * is not there is not invented — `phase-console remove` refuses a live row, and
 * a console whose row was removed anyway re-registers on its next boot.
 */
export function beatInstance(id, patch = {}, env = process.env) {
  return updateInstance(id, { ...patch, lastSeenAt: new Date().toISOString(), stoppedAt: null }, env);
}

/** A clean exit, said by the console itself — the other half of liveness. */
export function markInstanceStopped(id, env = process.env) {
  return updateInstance(id, { stoppedAt: new Date().toISOString() }, env);
}

/** A beat inside the window, with no clean exit recorded after it. */
function beating(row, now) {
  const seen = Date.parse(String(row?.lastSeenAt ?? ''));
  if (!Number.isFinite(seen) || now - seen > HEARTBEAT_STALE_MS) return false;
  const stopped = Date.parse(String(row?.stoppedAt ?? ''));
  return !(Number.isFinite(stopped) && stopped >= seen);
}

/**
 * Is the console behind this REGISTRY row up — the one implementation every
 * reader shares (`LIVENESS` in `shared/fleet-model.js` says what each word
 * means). Decided from the row and the filesystem alone: the census never
 * probes a port, so `list`, `status`, `agent.sh status` and `GET /api/instances`
 * cannot disagree about the same row at the same moment. `siblings` are the
 * other registry rows, which is how `port-taken` is known without a probe.
 */
export function liveness(row, now = Date.now(), siblings = []) {
  if (!rootExists(row?.root)) return 'orphaned';
  if (beating(row, now)) return 'running';
  const port = Number(row?.port);
  if (
    Number.isInteger(port) &&
    port > 0 &&
    siblings.some(
      (other) =>
        other?.id !== row?.id &&
        Number(other?.port) === port &&
        rootExists(other?.root) &&
        beating(other, now),
    )
  ) {
    return 'port-taken';
  }
  const seen = Date.parse(String(row?.lastSeenAt ?? ''));
  const stopped = Date.parse(String(row?.stoppedAt ?? ''));
  return Number.isFinite(seen) || Number.isFinite(stopped) ? 'stopped' : 'unknown';
}

function listNames(dir, predicate) {
  try {
    return readdirSync(dir).filter(predicate).sort();
  } catch {
    return [];
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The supervisor units on disk, each with the instance id its label names (null for the bare default label). */
function unitsOnDisk(platform, home, env) {
  if (platform === 'darwin') {
    return listNames(join(home, 'Library', 'LaunchAgents'), (name) =>
      /^com\.phase-console(\..+)?\.plist$/.test(name),
    ).map((name) => {
      const label = name.slice(0, -'.plist'.length);
      return { label, id: label === 'com.phase-console' ? null : label.slice('com.phase-console.'.length) };
    });
  }
  return listNames(join(configHome(env), 'systemd', 'user'), (name) =>
    /^phase-console(-.+)?\.service$/.test(name),
  ).map((name) => ({
    label: name,
    id: name === 'phase-console.service' ? null : name.slice('phase-console-'.length, -'.service'.length),
  }));
}

/** The desktop launchers on disk, each with the instance NAME its filename carries (null for the bare one). */
function launchersOnDisk(platform, home) {
  const desktop = join(home, 'Desktop');
  if (platform === 'darwin') {
    return listNames(desktop, (name) => /^Phase Console( — .+)?\.command$/.test(name)).map((name) => ({
      file: name,
      name:
        name === 'Phase Console.command' ? null : name.slice('Phase Console — '.length, -'.command'.length),
    }));
  }
  return listNames(desktop, (name) => /^phase-console(-.+)?\.desktop$/.test(name)).map((name) => ({
    file: name,
    name: name === 'phase-console.desktop' ? null : name.slice('phase-console-'.length, -'.desktop'.length),
  }));
}

/**
 * Every console this machine knows of, from all five places that record one —
 * the registry, the state directories, the prefs files, the supervisor units and
 * the desktop launchers — reconciled into one row per instance id (FLT-5).
 *
 * Each row names its `provenance` (`CENSUS_PROVENANCES`), its `liveness`
 * (`liveness()` for a registry row; a row with no registry entry has nothing
 * registered to be running and reads `stopped`), which sources hold it, and its
 * `discrepancies` (`CENSUS_DISCREPANCIES`). `counts` are the raw source sizes —
 * the numbers an audit compares — and `unowned` the presence drops no console
 * claimed (FLT-8). Never probes and never writes.
 */
export function census(env = process.env, opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const registry = readRegistry(env).instances;
  const registryRows = Object.entries(registry).map(([id, entry]) => ({ id, ...entry }));
  const defaultId = registryRows.find((row) => row.default === true)?.id ?? null;

  const stateDirs = listNames(join(stateHome(env), 'instances'), (name) =>
    isDirectory(join(stateHome(env), 'instances', name)),
  );
  const prefs = listNames(join(configDir(env), 'instances'), (name) => name.endsWith('.json')).map((name) =>
    name.slice(0, -'.json'.length),
  );
  const units = unitsOnDisk(platform, home, env);
  const launchers = launchersOnDisk(platform, home);
  const profile = fleetProfile(env);

  const rows = new Map();
  const blank = (id) => ({
    id,
    name: id.replace(/^[0-9a-f]{8}-/, ''),
    root: null,
    port: null,
    default: false,
    provenance: 'state-only',
    liveness: 'stopped',
    unit: null,
    pid: null,
    startedAt: null,
    lastSeenAt: null,
    stoppedAt: null,
    lastRemoteAt: null,
    build: null,
    supervisor: null,
    lanes: null,
    needsYou: null,
    autostart: readAutostart(id, env),
    stopMarker: false,
    sources: { registry: false, stateDir: false, prefs: false, unit: false, launcher: false },
    discrepancies: [],
  });
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, blank(id));
    return rows.get(id);
  };

  for (const entry of registryRows) {
    const out = row(entry.id);
    Object.assign(out, {
      name: entry.name ?? out.name,
      root: entry.root,
      port: Number.isInteger(entry.port) ? entry.port : null,
      default: entry.default === true,
      unit: entry.unit || null,
      pid: Number.isInteger(entry.pid) ? entry.pid : null,
      startedAt: entry.startedAt ?? null,
      lastSeenAt: entry.lastSeenAt ?? null,
      stoppedAt: entry.stoppedAt ?? null,
      lastRemoteAt: entry.lastRemoteAt ?? null,
      build: entry.build ?? null,
      supervisor: entry.supervisor ?? null,
      lanes: entry.lanes ?? null,
      needsYou: Number.isInteger(entry.needsYou) ? entry.needsYou : null,
      stopMarker: existsSync(stopMarkerPath(entry.id, entry.default === true, env)),
    });
    out.sources.registry = true;
    out.liveness = liveness(entry, now, registryRows);
    if (out.liveness === 'orphaned') {
      out.provenance = 'orphaned';
      out.discrepancies.push('root-missing');
    } else {
      out.provenance = 'registry';
    }
    if (!entry.lastSeenAt && !entry.stoppedAt) out.discrepancies.push('no-heartbeat');
    else if (out.liveness === 'stopped' && !entry.stoppedAt && entry.lastSeenAt) {
      out.discrepancies.push('stale-heartbeat');
    }
    if (
      out.port !== null &&
      registryRows.some((other) => other.id !== entry.id && other.port === out.port && rootExists(other.root))
    ) {
      out.discrepancies.push('port-shared');
    }
  }
  // The default instance keeps the flat state and config directories, so its
  // presence in those two sources is its registry row, not a listing.
  if (defaultId) {
    rows.get(defaultId).sources.stateDir = true;
    rows.get(defaultId).sources.prefs = true;
  }
  for (const id of stateDirs) row(id).sources.stateDir = true;
  for (const id of prefs) row(id).sources.prefs = true;

  const machineDiscrepancies = [];
  for (const unit of units) {
    const id = unit.id ?? defaultId;
    if (!id || !rows.has(id)) {
      machineDiscrepancies.push({ kind: 'unit-without-row', detail: unit.label });
      continue;
    }
    rows.get(id).sources.unit = true;
  }
  for (const launcher of launchers) {
    if (launcher.name === null) continue;
    const match = [...rows.values()].find(
      (candidate) => candidate.name === launcher.name || candidate.id === launcher.name,
    );
    if (match) match.sources.launcher = true;
  }
  for (const out of rows.values()) {
    if (!out.sources.registry) out.discrepancies.push('no-registry-row');
  }

  const order = { registry: 0, orphaned: 1, 'state-only': 2 };
  return {
    version: 1,
    at: new Date(now).toISOString(),
    rows: [...rows.values()].sort(
      (a, b) =>
        order[a.provenance] - order[b.provenance] ||
        Number(b.default) - Number(a.default) ||
        a.id.localeCompare(b.id),
    ),
    counts: {
      registry: registryRows.length,
      stateDirs: stateDirs.length,
      prefs: prefs.length,
      units: units.length,
      launchers: launchers.length,
    },
    unowned: unownedCount(env),
    machine: { maxSessions: profile.maxSessions ?? null, lanes: liveLaneTokens(env).length },
    discrepancies: machineDiscrepancies,
  };
}

/* ------------------------------------------------------------------ *
 * The machine: lane tokens and the unowned presence sink (FLT-7, FLT-8)
 * ------------------------------------------------------------------ */

/** Where every console's live lanes are recorded, one file each: `<stateHome>/fleet/lanes/`. */
export function laneTokensDir(env = process.env) {
  return join(stateHome(env), 'fleet', 'lanes');
}

/** `<id>-<slug>-<phase>` — or `-g<grant>` for an admission that is not about one phase. */
function laneTokenName(token) {
  const unit = Number.isInteger(token?.phase) ? String(token.phase) : `g${safeId(token?.grant)}`;
  return `${safeId(token?.instance)}-${safeId(token?.slug)}-${unit}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * The lanes live on this machine right now, every console's: each token file
 * whose console process is still alive. A token whose console died is not a
 * lane — `acquireLaneToken` reclaims it under the lock; a plain read skips it.
 */
export function liveLaneTokens(env = process.env) {
  const dir = laneTokensDir(env);
  const out = [];
  for (const name of listNames(dir, (entry) => !entry.startsWith('.') && !entry.includes('.tmp.'))) {
    try {
      const token = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (token && typeof token === 'object' && pidAlive(token.pid)) out.push({ ...token, file: name });
    } catch {
      /* a half-written or foreign file is not a lane */
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Take one lane on the machine, or be told who holds them all.
 *
 * `token` is `{instance, name, port, slug, phase, runId, grant}`; the file
 * records it with this process's pid and the moment. `max` is the machine
 * ceiling (`fleet.json` `maxSessions`), or null for none — a token is written
 * either way, so the census counts machine lanes with no ceiling set. Under a
 * lock, so two consoles admitting in the same instant cannot both take the last
 * lane. Returns `{ok: true, file}` or `{ok: false, holders}`.
 */
export function acquireLaneToken(token, max, env = process.env) {
  const dir = laneTokensDir(env);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: true, file: null, holders: [] };
  }
  return withLockFile(join(dir, '.lock'), () => {
    const name = laneTokenName(token);
    for (const entry of listNames(dir, (file) => !file.startsWith('.') && !file.includes('.tmp.'))) {
      try {
        const held = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
        if (!pidAlive(held?.pid)) rmSync(join(dir, entry), { force: true });
      } catch {
        rmSync(join(dir, entry), { force: true });
      }
    }
    const holders = liveLaneTokens(env).filter((held) => held.file !== name);
    if (Number.isInteger(max) && max > 0 && holders.length >= max) return { ok: false, holders };
    const file = join(dir, name);
    const tmp = `${file}.tmp.${process.pid}`;
    try {
      writeFileSync(
        tmp,
        `${JSON.stringify({ ...token, pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      );
      renameSync(tmp, file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is not the point */
      }
      return { ok: true, file: null, holders };
    }
    return { ok: true, file: name, holders };
  });
}

/** Give a lane back. Only this process's own token is removed. */
export function releaseLaneToken(token, env = process.env) {
  const file = join(laneTokensDir(env), laneTokenName(token));
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'));
    if (held?.pid !== process.pid || (token?.grant && held?.grant && held.grant !== token.grant))
      return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Where a presence event no registered console claims is recorded: `<stateHome>/fleet/sessions/inbox/`. */
export function unownedInboxDir(env = process.env) {
  return join(stateHome(env), 'fleet', 'sessions', 'inbox');
}

function unownedCount(env) {
  const dir = unownedInboxDir(env);
  const names = listNames(dir, (name) => name.endsWith('.json'));
  let oldestAt = null;
  for (const name of names) {
    const stamp = Number(name.split('-')[0]);
    if (Number.isFinite(stamp) && stamp > 0) {
      const at = new Date(stamp).toISOString();
      if (!oldestAt || at < oldestAt) oldestAt = at;
    }
  }
  return { count: names.length, oldestAt, dir };
}

/**
 * Which REGISTERED console owns a session standing here — with no sole-instance
 * fallback (FLT-8): "the only console" is not evidence a directory belongs to
 * it. `root` (the console-minted `$DOCS_ROOT`) is an exact statement; `cwd`
 * walks up. Anything no registered console claims answers `unowned`, with the
 * project root it would have been (`candidate`) or none.
 */
export function resolveOwner({ root, cwd } = {}, env = process.env) {
  if (root) {
    const path = resolve(String(root));
    const entry = getInstance(instanceId(path), env);
    if (entry) return { kind: 'registered', how: 'root', ...entry };
    return { kind: 'unowned', how: looksLikeProject(path, env) ? 'candidate' : 'none', root: path };
  }
  const here = resolveInstance(cwd ?? process.cwd(), env);
  if (here.kind === 'registered') return { how: 'cwd', ...here };
  if (here.kind === 'candidate') return { kind: 'unowned', how: 'candidate', root: here.root };
  return { kind: 'unowned', how: 'none', root: '' };
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
        // The machine profile's start policy and the stop marker's path (phase
        // 16): `agent.sh install` writes RunAtLoad and enables or disables the
        // unit from the first; `agent.sh start` clears the second.
        ['autostart', String(readAutostart(found.id, env))],
        ['stop_marker', stopMarkerPath(found.id, isDefault, env)],
      ];
      return { out: pairs.map(([key, value]) => `${key}=${stripControl(value)}`).join('\n'), code: 0 };
    }

    // The census (FLT-5): `--json` is the whole report `GET /api/instances`
    // serves; the bare form is one line per row — id, liveness, provenance,
    // name, port, root — TAB-separated with `-` for an empty field, because
    // bash's `read` collapses runs of TAB and silently drops an empty one.
    case 'census': {
      const report = census(env, { home: flag('home'), platform: flag('platform') });
      if (rest.includes('--json')) return { out: JSON.stringify(report), code: 0 };
      return {
        out: report.rows
          .map((row) =>
            [row.id, row.liveness, row.provenance, row.name || '-', row.port ?? '-', row.root || '-']
              .map((value) => stripControl(value))
              .join('\t'),
          )
          .join('\n'),
        code: 0,
      };
    }

    // Who owns a session standing here — the presence hook's question, with
    // no sole-instance fallback (FLT-8). `kind=unowned` names the fleet's sink.
    case 'owner': {
      const found = resolveOwner({ root: flag('root'), cwd: flag('cwd') }, env);
      const pairs =
        found.kind === 'registered'
          ? [
              ['kind', 'registered'],
              ['how', found.how],
              ['id', found.id],
              ['name', found.name ?? ''],
              ['root', found.root ?? ''],
              [
                'url',
                instanceUrl(
                  found.port ?? preferredPort(found.root, { isDefault: found.default === true }, env),
                ),
              ],
              ['state_dir', instanceStateDir(found.id, found.default === true, env)],
            ]
          : [
              ['kind', 'unowned'],
              ['how', found.how],
              ['root', found.root ?? ''],
              ['inbox', unownedInboxDir(env)],
            ];
      return { out: pairs.map(([key, value]) => `${key}=${stripControl(value)}`).join('\n'), code: 0 };
    }

    // The machine profile: the whole file sanitised, or — with `--instance` —
    // what that one console takes from it, each field's source named.
    case 'profile': {
      const id = flag('instance');
      return { out: JSON.stringify(id ? profileFor(id, env) : fleetProfile(env), null, 2), code: 0 };
    }

    // `profile-set <key> <json>` writes one machine-wide field (`null` clears
    // it); with `--instance <id>` it writes that console's override instead.
    // A value the profile cannot act on is refused rather than written.
    case 'profile-set': {
      const [key, raw] = positional;
      const instance = flag('instance');
      const keys = instance
        ? OVERRIDABLE_PROFILE_KEYS
        : [...OVERRIDABLE_PROFILE_KEYS, 'maxSessions', 'hookScript'];
      if (!key || raw === undefined || !keys.includes(key)) {
        return {
          err: `usage: instances.mjs profile-set <${keys.join('|')}> <json>`,
          code: 2,
        };
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        return { err: `not JSON: ${raw}`, code: 2 };
      }
      if (value !== null && sanitizeProfileFields({ [key]: value })[key] === undefined) {
        return { err: `${key}: ${raw} is not a value the profile can use`, code: 1 };
      }
      const written = updateFleetProfile((profile) => {
        if (!instance) {
          const next = { ...profile };
          if (value === null) delete next[key];
          else next[key] = value;
          return next;
        }
        const instances = profile.instances && typeof profile.instances === 'object' ? profile.instances : {};
        const overrides = { ...instances[instance]?.overrides };
        if (value === null) delete overrides[key];
        else overrides[key] = value;
        return { ...profile, instances: { ...instances, [instance]: { ...instances[instance], overrides } } };
      }, env);
      return written
        ? { out: JSON.stringify(instance ? profileFor(instance, env) : written, null, 2), code: 0 }
        : { err: `could not write ${fleetProfilePath(env)}`, code: 1 };
    }

    case 'autostart': {
      const [id, word] = positional;
      const value = word === 'true' ? true : word === 'false' ? false : word === 'once' ? 'once' : undefined;
      if (!id || value === undefined)
        return { err: 'usage: instances.mjs autostart <id> true|false|once', code: 2 };
      return setAutostart(id, value, env)
        ? { out: `${id} autostart=${word}`, code: 0 }
        : { err: `could not write ${fleetProfilePath(env)}`, code: 1 };
    }

    case 'port':
      return { out: String(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    case 'url':
      return { out: instanceUrl(preferredPort(positional[0] ?? '.', {}, env)), code: 0 };

    default:
      return {
        err:
          'usage: instances.mjs id|register|update|remove|list|census|resolve|select|shell|owner|profile|profile-set|autostart|port|url' +
          ' [<path-or-selector>] [--name n] [--port p] [--unit u] [--pid n] [--started-at s] [--cwd d] [--root d]' +
          ' [--platform p] [--default] [--json]',
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
