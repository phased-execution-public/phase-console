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
 * It reads the dispatcher (`server/api/routes.ts`) as TEXT and derives its
 * routes the way the dispatcher itself branches:
 *
 *   - a head is every `head === '<word>'` comparison;
 *   - a verb is a word compared against a URL segment inside that head's
 *     branch — `rest[N] === '<word>'`, `['a', 'b'].includes(rest[N])`, a
 *     local declared from `rest[N]` (`sub`, `verb`, `act`, `surface`, …)
 *     compared with `===`, or a `case '<word>':` of a `switch` over one.
 *
 * A route `<head>` is reached by a client caller whose path is `/api/<head>…`;
 * a route `<head>/<verb>` by one whose path is `/api/<head>/…` and carries
 * `<verb>` as a later segment. Callers are the string and template literals
 * under `client/src/lib/api/` — the one place a view's requests are written —
 * with every `${…}` read as a parameter.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(VIEWER, '..');

/** Who reaches a route that no `lib/api/` caller does. */
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
 * The routes with no `lib/api/` caller, and why. Keep it short: every row is a
 * capability a person cannot reach from a page.
 */
const NON_UI_ROUTES: NonUiRoute[] = [
  {
    route: 'run/remember',
    via: 'inbox',
    caller: 'viewer/server/inbox.ts',
    reason: 'a ruling is an inbox item; "Remember for this plan" and "for this console" post the endpoint the server mints',
  },
  {
    route: 'run/wait',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'a long poll for a script (`phase-console run wait`); a page has the live event stream instead',
  },
  {
    route: 'run/triggers',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'triggers are armed and listed from the command line (`phase-console run trigger|triggers`)',
  },
  {
    route: 'run/board-at-boundary',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'a scripted verb (`phase-console run board-at-boundary`); the queue page is phase 99',
  },
  {
    route: 'run/repair-checkout',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'the recovery a parked checkout names in its errand, typed where the errand says',
  },
  {
    route: 'run/isolate',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: 'the explicit escape a refused isolation names; lanes and policies are phase 100',
  },
  { route: 'run/isolate-phase', via: 'cli', caller: 'viewer/shared/verb-model.js', reason: 'as `run/isolate`' },
  {
    route: 'run/errand-tree',
    via: 'cli',
    caller: 'viewer/shared/verb-model.js',
    reason: "a parked phase's errand prints the command that opens the tree",
  },
  {
    route: 'metrics',
    via: 'page',
    caller: 'viewer/client/src/features/debug/runtime.ts',
    reason:
      "a Prometheus exposition; the runtime strip and the header's heap chip parse its gauges in runtime.ts, " +
      'which stays out of lib/api because lib/api is first-paint code',
  },
];

/* ------------------------------------------------------------------ */
/* The parse                                                            */
/* ------------------------------------------------------------------ */

/** Every route the dispatcher text branches on, with the line that first names it. */
export function routesOf(source: string): Map<string, number> {
  const found = new Map<string, number>();
  const add = (key: string, line: number) => {
    if (!found.has(key)) found.set(key, line);
  };
  let head: string | null = null;
  let urlLocals = new Set<string>();
  let inSwitch = false;
  source.split('\n').forEach((raw, index) => {
    const line = index + 1;
    // A comment may quote a route it does not branch on.
    const code = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    const opened = /\bhead === '([a-z][\w-]*)'/.exec(code);
    if (opened) {
      head = opened[1]!;
      urlLocals = new Set();
      inSwitch = false;
      add(head, line);
    }
    if (!head) return;
    for (const local of code.matchAll(/\bconst (\w+) = (?:String\()?rest\[\d\]/g)) urlLocals.add(local[1]!);
    for (const verb of code.matchAll(/\brest\[\d\] === '([\w-]+)'/g)) add(`${head}/${verb[1]}`, line);
    for (const list of code.matchAll(/\[((?:\s*'[\w-]+',?)+)\s*\]\.includes\(rest\[\d\]\)/g)) {
      for (const verb of list[1]!.matchAll(/'([\w-]+)'/g)) add(`${head}/${verb[1]}`, line);
    }
    for (const local of urlLocals) {
      for (const verb of code.matchAll(new RegExp(`(?<![.\\w])${local} === '([\\w-]+)'`, 'g'))) {
        add(`${head}/${verb[1]}`, line);
      }
      if (new RegExp(`\\bswitch \\(${local}\\)`).test(code)) inSwitch = true;
    }
    if (inSwitch) for (const verb of code.matchAll(/^\s*case '([\w-]+)':/g)) add(`${head}/${verb[1]}`, line);
  });
  return found;
}

interface Caller {
  file: string;
  segments: string[];
}

/** The `/api/…` literals a set of client modules writes, as path segments. */
export function callersOf(files: { name: string; text: string }[]): Caller[] {
  const callers: Caller[] = [];
  for (const { name, text } of files) {
    for (const literal of text.matchAll(/[`'"](\/api\/[^`'"\s]*)/g)) {
      const path = literal[1]!
        .replace(/\$\{[^{}]*\}/g, ':p') // a closed interpolation is a parameter
        .replace(/\$\{.*$/, '') // an open one (a nested template) ends the path
        .replace(/[?#].*$/, '');
      const segments = path
        .replace(/^\/api\//, '')
        .split('/')
        .filter(Boolean)
        // `journal${id ? … : ''}` — the word before an interpolation is still the word
        .map((segment) => (segment === ':p' ? segment : segment.replace(/(?::p)+$/, '')));
      callers.push({ file: name, segments });
    }
  }
  return callers;
}

export function reaches(callers: Caller[], route: string): boolean {
  const [head, verb] = route.split('/');
  return callers.some((c) => c.segments[0] === head && (!verb || c.segments.slice(1).includes(verb)));
}

/** Does a caller's text mention the route — its head as `/api/<head>`, and its verb as a word? */
function mentions(text: string, route: string): boolean {
  const [head, verb] = route.split('/');
  if (!text.includes(`/api/${head}`) && !text.includes(`'${head}'`)) return false;
  return !verb || new RegExp(`[/'"\`]${verb}[/'"\`]`).test(text);
}

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
      `routes.ts:${line} answers \`${route}\`, and no caller under client/src/lib/api/ reaches it — ` +
        'give it a caller, or a NON_UI_ROUTES row saying who does',
    );
  }
  for (const row of nonUi) {
    if (!routes.has(row.route)) {
      failures.push(`NON_UI_ROUTES names \`${row.route}\`, which the dispatcher no longer answers — delete the row`);
      continue;
    }
    if (reaches(callers, row.route)) {
      failures.push(`NON_UI_ROUTES excuses \`${row.route}\`, which a lib/api caller now reaches — delete the row`);
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

/* ------------------------------------------------------------------ */
/* The real tree                                                        */
/* ------------------------------------------------------------------ */

function clientApiFiles(): { name: string; text: string }[] {
  const dir = join(VIEWER, 'client', 'src', 'lib', 'api');
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

function readRepo(rel: string): string | null {
  const path = join(REPO, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const DISPATCHER = readFileSync(join(VIEWER, 'server', 'api', 'routes.ts'), 'utf8');

test('the parse finds the dispatcher: its heads, its run verbs and its plan subroutes', () => {
  const routes = routesOf(DISPATCHER);
  for (const route of ['state', 'doctor', 'locks', 'run/start', 'run/switch-account', 'plans/lint', 'plans/work', 'write']) {
    assert.ok(routes.has(route), `the parse lost \`${route}\` — the dispatcher changed shape; teach routesOf`);
  }
  assert.ok(routes.size > 100, `only ${routes.size} routes parsed — the parse is not reading the dispatcher`);
});

test('every route the dispatcher answers has a lib/api caller or a NON_UI_ROUTES row that is true', () => {
  const failures = audit({
    routes: routesOf(DISPATCHER),
    callers: callersOf(clientApiFiles()),
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
  assert.match(said, /excuses `state`, which a lib\/api caller now reaches/);
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

test('every verb a person presses on a step has a lib/api caller — a permission item\'s deny and convert among them (control-tower phase 135)', () => {
  // The step verbs are read off a destructured `verb` (`const [id, verb] = rest`),
  // which the head/verb parse above does not follow — so they are held here.
  const head = DISPATCHER.slice(DISPATCHER.indexOf("if (head === 'human-steps')"));
  const branch = head.slice(0, head.indexOf("json(res, 405, { error: 'GET /api/human-steps"));
  const verbs = [...branch.matchAll(/verb === '([a-z-]+)'/g)].map((m) => m[1]!);
  for (const verb of ['deny', 'convert']) assert.ok(verbs.includes(verb), `the dispatcher answers ${verb}`);
  const callers = readFileSync(join(VIEWER, 'client', 'src', 'lib', 'api', 'human-steps.ts'), 'utf8');
  // `dismiss` is the CONSOLE's withdrawal — "Withdrawn", what it does to an item
  // nobody needs any more (§Architecture 19); a person declines or says they
  // can't, so no page presses it. Control-tower phase 139 retired its dead fetcher.
  const CONSOLE_ONLY: ReadonlySet<string> = new Set(['dismiss']);
  for (const verb of CONSOLE_ONLY) assert.ok(verbs.includes(verb), `the dispatcher still answers ${verb}`);
  const missing = [...new Set(verbs)].filter(
    (verb) => !CONSOLE_ONLY.has(verb) && !callers.includes(`at(id, '${verb}')`),
  );
  assert.deepEqual(missing, [], 'a step verb no page can press');
  assert.ok(!callers.includes("at(id, 'dismiss')"), 'a person never dismisses a step — they decline it');
});
