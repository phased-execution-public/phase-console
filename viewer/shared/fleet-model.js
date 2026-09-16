/**
 * The FLEET vocabularies — the words for more than one console (zero-touch
 * phase 17, FLT-6 / R-F6).
 *
 * "Fleet" meant three narrower things before it meant the operator's: one
 * console's runs (the freeze marker, the runs table), the Runs destination, and
 * a hub's estate of repositories. None of them is every running console of one
 * person, which is the tier a phone and a supervisor need a word for. So the
 * tiers are named here, once, narrowest first, and the census that lists every
 * console of a machine speaks in the members below and nothing else.
 *
 * The wire keeps its older spellings where renaming would break a client in
 * the field — `state.fleet`, `/api/fleet/freeze` and `/api/fleet/thaw` are the
 * CONSOLE tier's freeze (`LEGACY_CONSOLE_TIER_NAMES`) — but no new reader may
 * use the word for anything but the fleet tier.
 *
 * Dependency-free ESM, imported by the server, the client, the tests and — through
 * `shared/instances.mjs`, which bash executes as a CLI — the shell scripts.
 * `test/vocab-owners.test.ts` holds every importer to this file by identity.
 */

/**
 * The three tiers, narrowest first: a RUN (one plan's autopilot), a CONSOLE
 * (one process, one repository, every run it drives), the FLEET (every console
 * of one person on one machine).
 * @typedef {(typeof FLEET_TIERS)[number]} FleetTier
 */
export const FLEET_TIERS = Object.freeze(/** @type {const} */ (['run', 'console', 'fleet']));

/**
 * The console-tier names the wire still carries from before the tiers were
 * named. Kept so a client in the field keeps working; documented here so a
 * reader who meets `state.fleet` knows it is ONE console's freeze.
 */
export const LEGACY_CONSOLE_TIER_NAMES = Object.freeze([
  'state.fleet',
  '/api/fleet/freeze',
  '/api/fleet/thaw',
]);

/**
 * Where a census row came from (FLT-5). `registry` — a row in
 * `instances.json` whose root exists; `orphaned` — a row whose root is gone
 * (it reserves no port); `state-only` — a state directory, a prefs file, a unit
 * or a launcher naming an instance the registry does not hold.
 * @typedef {(typeof CENSUS_PROVENANCES)[number]} CensusProvenance
 */
export const CENSUS_PROVENANCES = Object.freeze(
  /** @type {const} */ (['registry', 'state-only', 'orphaned']),
);

/**
 * Is the console behind a census row up — ONE word, from ONE implementation
 * (`instances.mjs liveness`), read by `phase-console list`, `status`,
 * `agent.sh status` and `GET /api/instances` alike. Decided from what the
 * console itself wrote (its heartbeat and its clean exit), never from a probe.
 *
 *   running     a heartbeat inside `HEARTBEAT_STALE_MS`, no clean exit after it
 *   stopped     a clean exit recorded, a heartbeat gone stale, or nothing registered
 *   orphaned    the row's root no longer exists
 *   port-taken  not running, and a running sibling's heartbeat holds its port
 *   unknown     a row no console ever heartbeated (written before 5.0.0)
 * @typedef {(typeof LIVENESS)[number]} Liveness
 */
export const LIVENESS = Object.freeze(
  /** @type {const} */ (['running', 'stopped', 'orphaned', 'port-taken', 'unknown']),
);

/**
 * What a census row can disagree with itself about. Each is a FACT about the
 * five sources, never a verdict: `root-missing` (the registry's root is gone),
 * `no-registry-row` (on disk, not registered), `no-heartbeat` (registered, never
 * beaten), `stale-heartbeat` (stopped beating without a clean exit — the process
 * died), `port-shared` (another row claims the same port), `unit-without-row` (a
 * supervisor unit for an instance the registry does not hold).
 * @typedef {(typeof CENSUS_DISCREPANCIES)[number]} CensusDiscrepancy
 */
export const CENSUS_DISCREPANCIES = Object.freeze(
  /** @type {const} */ ([
    'root-missing',
    'no-registry-row',
    'no-heartbeat',
    'stale-heartbeat',
    'port-shared',
    'unit-without-row',
  ]),
);

/**
 * How a presence event came to be recorded in the fleet's `unowned` sink
 * (FLT-8): `none` — no project above the cwd at all; `candidate` — a project
 * directory no registered console claims; `no-node` — the hook had no node to
 * ask the registry, and no console had ever run for that root.
 * @typedef {(typeof UNOWNED_HOWS)[number]} UnownedHow
 */
export const UNOWNED_HOWS = Object.freeze(/** @type {const} */ (['none', 'candidate', 'no-node']));

/**
 * The instance-health rows a console raises about itself and its siblings —
 * each one a `needs-you`, because a console nobody can reach is work.
 * @typedef {(typeof INSTANCE_HEALTH_KINDS)[number]} InstanceHealthKind
 */
export const INSTANCE_HEALTH_KINDS = Object.freeze(
  /** @type {const} */ ([
    'unread-unheard',
    'tailscale-stopped',
    'serve-elsewhere',
    'sibling-orphaned',
    'sibling-down',
  ]),
);

/** How often a console writes `lastSeenAt` into its own registry row. */
export const HEARTBEAT_MS = 30_000;

/** A heartbeat older than this is a console that stopped beating — three missed beats. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS;

/** @param {unknown} v @returns {v is Liveness} */
export function isLiveness(v) {
  return typeof v === 'string' && LIVENESS.includes(/** @type {Liveness} */ (v));
}

