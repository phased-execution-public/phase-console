/**
 * Every route the dispatcher answers has a caller in the client — or a
 * written reason why it has none (control-tower phase 25).
 *
 * The audit behind this file found fourteen things the server could do that
 * no page could ask for: a doctor nobody drew, a review verb no button
 * pressed, filters the log route parsed and the log page never sent. Each was
 * built, tested and shipped; each was invisible. Nothing failed, because
 * nothing compared the two sides — so this file does.
 *
 * It reads the dispatcher (`server/api/routes.ts`) and the client's requests
 * as TEXT, through the parse in `./route-parse.ts` (which `surface-parity`
 * shares): a route is a head or a head and a verb, and a caller is a literal
 * under `client/src/data/` — the one place a view's requests are written.
 *
 * A route no caller reaches needs a row in `NON_UI_ROUTES`, and the row has
 * to be TRUE: it names the file that does call the route (the CLI's verb
 * table, the inbox's server-minted endpoints, a page's own stream), and that
 * file must mention the route; or it names the later phase that draws it. A
 * row for a route that no longer exists, or that a client caller now reaches,
 * fails too — an excuse outliving its reason is how a table like this rots.
 *
 * The guard proves its own teeth below, on a fixture dispatcher: a route with
 * no caller and no row makes it fail. §Decisions rules out a hand proof.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISPATCHER,
  VIEWER,
  callersOf,
  clientCallerFiles,
  mentions,
  reaches,
  readRepo,
  routesOf,
  type Caller,
} from './route-parse.ts';

/** Who reaches a route that no `data/` caller does. */
type Via =
  /** a command line — the file named speaks it */
  | 'cli'
  /** the inbox posts an action's `endpoint`, which the server mints in the file named */
  | 'inbox'
  /** a page opens it itself (a stream, a download link) — the file named */
  | 'page'
  /** something that is not a person's page — a scraper, a worker */
  | 'machine'
  /** a later phase of the plan draws it; `phase` names which */
  | 'later';

interface NonUiRoute {
  route: string;
  via: Via;
  /** Repository-relative; must exist and mention the route. Absent only for `later`. */
  caller?: string;
  /** The phase that draws it — `later` only. */
  phase?: number;
  reason: string;
}

/**
 * The routes with no `data/` caller, and why. Keep it short: every row is a
 * capability a person cannot reach from a page.
 */
const NON_UI_ROUTES: NonUiRoute[] = [
  // `metrics` left with quiet-console phase 26: `data/logs.ts` reads the
  // scrape (`readMetricsScrape`) and Logs ▸ Health parses it.
  {
    route: 'run/wait',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'a long poll for a script (`phase-console run wait`); a page has the live event stream instead',
  },
];


interface Audit {
  routes: Map<string, number>;
  callers: Caller[];
  nonUi: NonUiRoute[];
  read: (rel: string) => string | null;
}

/** Everything wrong, as sentences — empty is the only pass. */
export function audit({ routes, callers, nonUi, read }: Audit): string[] {
  const failures: string[] = [];
  const rows = new Map(nonUi.map((row) => [row.route, row]));
  for (const [route, line] of routes) {
    if (reaches(callers, route) || rows.has(route)) continue;
    failures.push(
      `routes.ts:${line} answers \`${route}\`, and no caller under client/src/data/ reaches it — ` +
        'give it a caller, or a NON_UI_ROUTES row saying who does',
    );
  }
  for (const row of nonUi) {
    if (!routes.has(row.route)) {
      failures.push(`NON_UI_ROUTES names \`${row.route}\`, which the dispatcher no longer answers — delete the row`);
      continue;
    }
    if (reaches(callers, row.route)) {
      failures.push(`NON_UI_ROUTES excuses \`${row.route}\`, which a data/ caller now reaches — delete the row`);
    }
    if (!row.reason.trim()) failures.push(`NON_UI_ROUTES \`${row.route}\` gives no reason`);
    if (row.via === 'later') {
      if (!row.phase) failures.push(`NON_UI_ROUTES \`${row.route}\` is left for later without naming the phase`);
      continue;
    }
    if (!row.caller) {
      failures.push(`NON_UI_ROUTES \`${row.route}\` says ${row.via} calls it without naming the file`);
      continue;
    }
    const text = read(row.caller);
    if (text === null) failures.push(`NON_UI_ROUTES \`${row.route}\` names ${row.caller}, which does not exist`);
    else if (!mentions(text, row.route)) {
      failures.push(`NON_UI_ROUTES \`${row.route}\` names ${row.caller}, which never mentions it`);
    }
  }
  return failures;
}


test('the parse finds the dispatcher: its heads, its run verbs and its plan subroutes', () => {
  const routes = routesOf(DISPATCHER);
  for (const route of ['state', 'doctor', 'locks', 'run/start', 'run/switch-account', 'plans/lint', 'plans/work', 'write']) {
    assert.ok(routes.has(route), `the parse lost \`${route}\` — the dispatcher changed shape; teach routesOf`);
  }
  assert.ok(routes.size > 100, `only ${routes.size} routes parsed — the parse is not reading the dispatcher`);
});

test('every route the dispatcher answers has a data/ caller or a NON_UI_ROUTES row that is true', () => {
  const failures = audit({
    routes: routesOf(DISPATCHER),
    callers: callersOf(clientCallerFiles()),
    nonUi: NON_UI_ROUTES,
    read: readRepo,
  });
  assert.deepEqual(failures, []);
});

test('the guard has teeth: a fixture route no caller reaches and no row excuses makes it fail', () => {
  const fixture = [
    "  const [head, ...rest] = segments;",
    "    if (head === 'state' && req.method === 'GET') {",
    "    if (head === 'widgets') {",
    "      if (req.method === 'GET' && rest.length === 0) {",
    "      const sub = rest[0];",
    "      if (sub === 'spin') {",
    "    if (head === 'orphan' && req.method === 'GET') {",
    "    if (head === 'run' && rest.length >= 1) {",
    "      const verb = rest[1];",
    "        switch (verb) {",
    "          case 'start': {",
    "          case 'polish': {",
  ].join('\n');
  const routes = routesOf(fixture);
  assert.deepEqual([...routes.keys()].sort(), ['orphan', 'run', 'run/polish', 'run/start', 'state', 'widgets', 'widgets/spin']);

  const callers = callersOf([
    {
      name: 'fixture.ts',
      text: [
        "state: () => request('/api/state'),",
        'spin: (id) => post(`/api/widgets/${q(id)}/spin`),',
        'widgets: () => request(`/api/widgets`),',
        'start: (slug) => post(`/api/run/${q(slug)}/start`),',
      ].join('\n'),
    },
  ]);
  // `run` itself is reached — a caller under it — so two routes fail, by name.
  const failures = audit({ routes, callers, nonUi: [], read: () => null });
  assert.equal(failures.length, 2, failures.join('\n'));
  assert.match(failures[0]!, /answers `orphan`, and no caller/);
  assert.match(failures[1]!, /answers `run\/polish`, and no caller/);

  // A row that names who calls it, truthfully, clears the route…
  const excused = audit({
    routes,
    callers,
    nonUi: [
      { route: 'orphan', via: 'cli', caller: 'bin/orphan.mjs', reason: 'a script reads it' },
      { route: 'run/polish', via: 'later', phase: 99, reason: 'a later phase draws the button' },
    ],
    read: (rel) => (rel === 'bin/orphan.mjs' ? "get('/api/orphan')" : null),
  });
  assert.deepEqual(excused, []);

  // …and an untrue one does not: a missing file, a later with no phase, a
  // stale row, a redundant row — and a caller that never mentions the route.
  const lies = audit({
    routes,
    callers,
    nonUi: [
      { route: 'orphan', via: 'cli', caller: 'bin/missing.mjs', reason: 'claimed' },
      { route: 'run/polish', via: 'later', reason: 'someday' },
      { route: 'gone', via: 'machine', caller: 'bin/elsewhere.mjs', reason: 'retired' },
      { route: 'state', via: 'machine', caller: 'bin/elsewhere.mjs', reason: 'redundant' },
    ],
    read: (rel) => (rel === 'bin/elsewhere.mjs' ? "get('/api/state')" : null),
  });
  const said = lies.join('\n');
  assert.match(said, /`orphan` names bin\/missing\.mjs, which does not exist/);
  assert.match(said, /`run\/polish` is left for later without naming the phase/);
  assert.match(said, /`gone`, which the dispatcher no longer answers/);
  assert.match(said, /excuses `state`, which a data\/ caller now reaches/);
  const silent = audit({
    routes,
    callers,
    nonUi: [
      { route: 'orphan', via: 'cli', caller: 'bin/elsewhere.mjs', reason: 'claimed' },
      { route: 'run/polish', via: 'later', phase: 99, reason: 'a later phase' },
    ],
    read: (rel) => (rel === 'bin/elsewhere.mjs' ? "get('/api/state')" : null),
  });
  assert.deepEqual(silent, ['NON_UI_ROUTES `orphan` names bin/elsewhere.mjs, which never mentions it']);
});

test('every verb a person presses on a step has a data/ caller — a permission item\'s deny and convert among them (control-tower phase 135)', () => {
  // The step verbs are read off a destructured `verb` (`const [id, verb] = rest`),
  // which the head/verb parse above does not follow — so they are held here.
  const head = DISPATCHER.slice(DISPATCHER.indexOf("if (head === 'human-steps')"));
  const branch = head.slice(0, head.indexOf("json(res, 405, { error: 'GET /api/human-steps"));
  const verbs = [...branch.matchAll(/verb === '([a-z-]+)'/g)].map((m) => m[1]!);
  for (const verb of ['deny', 'convert']) assert.ok(verbs.includes(verb), `the dispatcher answers ${verb}`);
  const callers = readFileSync(join(VIEWER, 'client', 'src', 'data', 'human-steps.ts'), 'utf8');
  const missing = [...new Set(verbs)].filter((verb) => !callers.includes(`at(id, '${verb}')`));
  assert.deepEqual(missing, [], 'a step verb no page can press');
  // `dismiss` is the console's withdrawal — "Withdrawn", what it does to an item
  // nobody needs any more (§Architecture 19). Control-tower phase 139 retired the
  // person's Dismiss (a person declines, with a reason the session reads); 7.0
  // (quiet-console phase 8) gives the OWNER a *Withdraw* on Your turn, through
  // the owner door — one caller, `humanStepWithdraw`, pressed by `data/turn.ts`
  // `withdrawItem` and by nothing else (`turn-surfaces-scan.test.ts` holds it).
  assert.ok(callers.includes("at(id, 'dismiss')"), "the owner's Withdraw presses the console's dismiss");
  assert.ok(!callers.includes('humanStepDismiss'), 'the dead Dismiss fetcher stays gone');
  const turn = readFileSync(join(VIEWER, 'client', 'src', 'data', 'turn.ts'), 'utf8');
  assert.ok(turn.includes('export function withdrawItem'), 'Withdraw goes through data/turn, through the owner door');
});
