/**
 * The owner door — the presses a supervised session never makes of its own
 * console. ONE table (control-tower phase 129, #218; §Architecture 19).
 *
 * A session runs as the operator's own OS user, so it reaches every route a
 * person's browser reaches: the write guard is a capability flag, the console's
 * header and a same-origin test (`api/routes.ts` `guardMutation`), and `by` is
 * the request body's own label. #218 read what one `curl` could do with that —
 * answer its own approval card, strike a deny rule, raise its run to `bypass`,
 * approve a manual gate, prove a person's step — and `gate-forge` walled only
 * the gate file. This table names those presses, and it is read by:
 *
 *   - the hook guard `console-forge` (`server/runner/approvals.ts`
 *     `consoleForgeCall`, enforced in `Service.decideToolUse` after
 *     `gate-forge`): a supervised session's call that would press a row — an
 *     HTTP client against a console's loopback address, the row's CLI twin, or
 *     a wrapper whose text carries a console address and the row's path — is
 *     denied before it runs, on every profile;
 *   - `test/console-forge.test.ts`, which holds every row to a route the router
 *     serves and every CLI form to a verb the CLI dispatches.
 *
 * Phase 131 extends this file: the door each request came through, the door ×
 * verb × risk table, and the rule held the other way round (every route whose
 * press is an authority verb is a row).
 *
 * A row:
 *
 *   - `verb` — the press, as `phase.tool-denied {rule: 'console-forge', verb}`
 *     journals it.
 *   - `method` — the HTTP method that presses it.
 *   - `path` — the route under the console's origin; `:name` is one segment. A
 *     request path is the row's when it STARTS with the row's segments, read
 *     the way the router reads them (`authorityRouteOf`).
 *   - `cli` — the `phase-console` verbs that press the same route, as
 *     `<group> <verb>` (`run approve`); none for a route the CLI does not press.
 *   - `declare` — what a session declares instead: the outcome and its
 *     `--needs` key.
 *   - `summary` — what the press does, in a person's words.
 *
 * ⚠️ Data only, like every `shared/` vocabulary: the client may bundle it and
 * `node --test` imports it directly. Free-safe — a Pro row is a `!pro:` region,
 * like verb-model.js's `message`.
 */

/**
 * @typedef {{
 *   verb: string, method: string, path: string, cli: readonly string[],
 *   declare: { status: 'blocked' | 'needs-human', needs: string },
 *   summary: string,
 * }} AuthorityRoute
 */

/** What a session declares when it needs a person's permission. */
const PERMISSION = Object.freeze({ status: /** @type {const} */ ('blocked'), needs: 'permission' });
/** …a person's gate. */
const GATES = Object.freeze({ status: /** @type {const} */ ('needs-human'), needs: 'gates' });
/** …a person's act. */
const HUMAN = Object.freeze({ status: /** @type {const} */ ('needs-human'), needs: 'human-acts' });

/**
 * @param {string} verb
 * @param {string} route `METHOD /path`
 * @param {{ cli?: string[], declare: AuthorityRoute['declare'], summary: string }} rest
 * @returns {Readonly<AuthorityRoute>}
 */
function press(verb, route, { cli = [], declare, summary }) {
  const [method = '', path = ''] = route.split(' ');
  return Object.freeze({ verb, method, path, cli: Object.freeze(cli), declare, summary });
}

/**
 * Every press this guard fences.
 * @type {readonly Readonly<AuthorityRoute>[]}
 */
export const AUTHORITY_ROUTES = Object.freeze([
  press('answer-card', 'POST /api/approvals/:id', {
    cli: ['run approve', 'run deny'],
    declare: PERMISSION,
    summary: 'answer a permission card — allow it, deny it, or remember the answer as a rule',
  }),
  press('edit-policy', 'POST /api/policy', {
    declare: PERMISSION,
    summary: 'edit the permission policy — add a rule, or strike a shipped one',
  }),
  press('run-settings', 'POST /api/run/:slug/settings', {
    declare: PERMISSION,
    summary: "change a run's settings — its permission profile, carve-out and auto-grant among them",
  }),
  press('approve-gate', 'POST /api/plans/:slug/gate/:phase', {
    declare: GATES,
    summary: "approve or revoke a phase's gate",
  }),
  press('console-write', 'POST /api/write', {
    declare: GATES,
    summary: "write through the console's own door — a gate approval among its actions",
  }),
  press('check-step', 'POST /api/human-steps/:id/check', {
    declare: HUMAN,
    summary: "mark a person's step done — by a person's word when it has no proof",
  }),
  press('dismiss-step', 'POST /api/human-steps/:id/dismiss', {
    declare: HUMAN,
    summary: "withdraw a person's step",
  }),
]);

/** The presses, by name — the words `phase.tool-denied`'s `verb` takes for a route. */
export const AUTHORITY_VERBS = Object.freeze(AUTHORITY_ROUTES.map((row) => row.verb));

/**
 * The `verb` a write into the console's own files is journalled under: its
 * state and config directories, which no route fronts (`consoleForgeCall`).
 */
export const CONSOLE_FILES_VERB = 'console-files';

/** A row's path as segments, `:name` kept. */
const SEGMENTS = new Map(AUTHORITY_ROUTES.map((row) => [row, row.path.split('/').filter(Boolean)]));

/** One segment as the router reads it (`decodeURIComponent`), or as written when it does not decode. */
function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A request path's segments as the router reads them — split on `/`, empties
 * dropped, each percent-decoded — with the fleet supervisor's mount
 * (`/c/<id>/…`) taken off, since the supervisor hands the rest to that console.
 * @param {string} path
 * @returns {string[]}
 */
export function routeSegments(path) {
  const segments = String(path ?? '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map(decoded);
  return segments[0] === 'c' && segments[2] === 'api' ? segments.slice(2) : segments;
}

/**
 * The row a request presses, or null. `method` null means a method nobody can
 * read (a wrapper's, a `$METHOD`): every row's then. A path is the row's when
 * it starts with the row's segments — the router dispatches on its leading
 * segments and ignores what follows them, so a trailing segment hides nothing.
 * @param {string | null} method
 * @param {string} path
 * @returns {Readonly<AuthorityRoute> | null}
 */
export function authorityRouteOf(method, path) {
  const segments = routeSegments(path);
  const wanted = typeof method === 'string' ? method.toUpperCase() : null;
  return (
    AUTHORITY_ROUTES.find((row) => {
      if (wanted !== null && row.method !== wanted) return false;
      const own = SEGMENTS.get(row) ?? [];
      return (
        segments.length >= own.length &&
        own.every((part, i) => (part.startsWith(':') ? Boolean(segments[i]) : part === segments[i]))
      );
    }) ?? null
  );
}

/**
 * The CLI form an argv presses (`run approve`), read as the CLI reads it, or
 * null. `args` are the words after the program (`phase-console`). `run` takes
 * its global flags out first — `--json`, `--help`/`-h` (help presses nothing)
 * and `--console <name>` — and its first other word is the verb
 * (`bin/run-verb.mjs` `extractGlobalFlags`); `supervisor`'s verb is its first
 * word, and `--replay` anywhere reads (`bin/supervisor-verb.mjs`).
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function cliFormOf(args) {
  const [group, ...rest] = args;
  if (group === 'run') {
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i];
      if (word === '--help' || word === '-h') return null;
      if (word === '--json') continue;
      if (word === '--console') {
        i += 1;
        continue;
      }
      return `run ${word}`;
    }
    return null;
  }
  if (group === 'supervisor') {
    if (rest.includes('--replay') || rest.includes('--help') || rest.includes('-h') || !rest[0]) return null;
    return `supervisor ${rest[0]}`;
  }
  return null;
}

/**
 * The row whose CLI twin an argv presses, or null.
 * @param {readonly string[]} args
 * @returns {Readonly<AuthorityRoute> | null}
 */
export function authorityCliOf(args) {
  const form = cliFormOf(args);
  return form ? (AUTHORITY_ROUTES.find((row) => row.cli.includes(form)) ?? null) : null;
}
