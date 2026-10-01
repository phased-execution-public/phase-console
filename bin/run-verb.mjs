// `phase-console run <verb> [args] [--flags] [--console <name|port>] [--json]`
// — the verb, shared by the Pro bin (`bin/phase-console.mjs`) and the free
// tree's override, which import it by path so neither carries a second copy
// (control-tower phase 98, EC6, #144; contributes to #135's queue verbs and
// #163's `run explain`).
//
// One table, one door. `viewer/shared/verb-model.js`'s `OPERATOR_VERBS` is
// read for everything a press needs — the words, the positional arguments,
// which `--flag` becomes which body or query field, the route each row is
// pressed at, and `CLI_EXIT`'s exit codes — so a verb added to the table is a
// verb this CLI speaks with no second edit here. Nothing below names a route
// path of its own; every path comes from a row's own `route` field, built at
// request time.
//
//   phase-console run                       list every verb this CLI speaks
//   phase-console run --help
//   phase-console run status <slug>         a plan's latest run, slim
//   phase-console run journal <slug> [--limit N] [--since S]
//   phase-console run tail <slug> <phase> [--limit N]        phase 95's activity
//   phase-console run explain <slug> [phase]                 phase 95's report
//   phase-console run wait <slug> --for <predicate> [--timeout <seconds>]
//   phase-console run pause <slug> [--reason <text>]
//   phase-console run resume-phase <slug> <phase> [--note <text>] [--reason <text>]
//   phase-console run trigger <slug> --when <predicate> --then <verb> [--body <json>] [--every true] [--expires <iso>] [--note <text>]
//   …and the rest of the table — `phase-console run --help` lists every row
//   that has a CLI shape (`row.cli !== null`), grouped by edition.
//
//   --console <name|port>   which console: a name the instance registry
//                            knows, or a bare loopback port to hit directly
//                            (no registry lookup at all — a stub server in a
//                            test has no instance identity to look up)
//   --json                  print the raw answer exactly as the console sent
//                            it; otherwise a short one- or few-line rendering
//
// Every request carries `x-phase-console: 1` and a `user-agent` of
// `phase-console/<package version> run`, which the server's own
// `agentClassOf` already reads as the `cli` agent class (it matches anything
// starting with `phase-console`), so every press this CLI makes is attributed
// `via: 'cli'` by the same code path a browser's press goes through — nothing
// here derives an actor itself.
//
// Editions (`row.edition`): every READ row is free in both editions; every
// ACT row plus `wait` (the one read the table marks `pro` anyway) needs Pro.
// The FREE build has no `viewer/server/license/` at all — there is nothing to
// ask — so `edition: 'free'` (set by the free override's own dispatch line)
// refuses a gated row before any request leaves this machine, naming Pro in
// one sentence. `edition: 'pro'` asks the SAME license gate every other
// Pro-only verb consults (`viewer/server/license/index.ts`'s runtime,
// `gate.ts`'s `cliRefusalText` — a source checkout always reads `open`, so
// this repository's own tests press every act row with no key at all).
//
// Exit codes are `CLI_EXIT`: 0 ok, 1 a 4xx/409 refusal the console answered,
// 2 bad usage (including an edition or license refusal — the same code
// `phase-console license gate` already answers with), 3 a 404, 4 nothing
// answered at this console at all, 5 a `wait` whose predicate never held.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `--console`/`--json`/`--help` may appear anywhere; everything else keeps its order. */
function extractGlobalFlags(argv) {
  let json = false;
  let help = false;
  let consoleSelector;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--console') { consoleSelector = argv[i + 1]; i += 1; continue; }
    rest.push(arg);
  }
  return { json, help, consoleSelector, rest };
}

/** `--flag`'s dashes and kebab-case turned into the body key a bare switch writes — no row uses this today, but the table's own type (`string|true`) allows it. */
function switchFieldName(flagToken) {
  return flagToken.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * A flag's raw argv string, typed for the body it is about to join.
 *
 * Two narrow, named exceptions rather than a blanket parse: `trigger`'s own
 * `--body` is the JSON payload the fired verb's route reads as an object
 * (`Trigger['body']`), so it is parsed; `true`/`false` become real booleans
 * because two existing rows are read with a strict `=== true` on the server
 * (`notes`' `pinned`, `triggers`' `every`) and a query-string `"true"` can
 * never satisfy that. Nothing else is coerced — a note whose text happens to
 * read `"42"` must stay the string `"42"`, not become the number 42.
 */
function coerceFlagValue(fieldName, raw) {
  if (fieldName === 'body') {
    try { return JSON.parse(raw); } catch { throw new Error(`--body needs a JSON object, got: ${raw}`); }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/**
 * One row's CLI shape applied to what is left of argv after the global flags
 * and the verb word are gone: the positional arguments in order, and
 * `--flag value` pairs turned into the row's own field names. Throws a plain
 * `Error` (its message is the whole usage refusal) on anything the shape does
 * not recognise.
 */
export function parseRowArgs(row, rest) {
  const wanted = row.cli.args ?? [];
  const flagsMap = row.cli.flags ?? {};
  const positionalValues = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (Object.prototype.hasOwnProperty.call(flagsMap, token)) {
      const fieldSpec = flagsMap[token];
      if (fieldSpec === true) { flags[switchFieldName(token)] = true; continue; }
      const value = rest[i + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      flags[fieldSpec] = coerceFlagValue(fieldSpec, value);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const known = Object.keys(flagsMap);
      throw new Error(`unknown flag ${token} — ${row.name} takes ${known.length ? known.join(', ') : 'no flags'}`);
    }
    positionalValues.push(token);
  }
  if (positionalValues.length !== wanted.length) {
    throw new Error(
      `${row.name} needs ${wanted.length ? wanted.join(' ') : 'no arguments'}`
      + `, got ${positionalValues.length ? positionalValues.join(' ') : 'none'}`,
    );
  }
  return { positionals: Object.fromEntries(wanted.map((name, i) => [name, positionalValues[i]])), flags };
}

/**
 * The method, path and body/query a row and its parsed arguments become.
 *
 * A positional that fills a `:name` segment of the row's own route goes into
 * the path; one that does not (`status`'s `slug` against the bare bounded-list
 * route, `resume-phase`'s `phase`, `switch-account`'s `accountId`, `bump`'s
 * `slug` and `phase` — none of those routes carry that segment) rides beside
 * the flags instead, under its own name, exactly where each route's own
 * handler already reads it. `GET` rows put everything left over on the query
 * string; the rest put it in the JSON body.
 */
export function buildRequest(row, parsed) {
  const [method, routePath] = row.route.split(' ');
  const usedNames = new Set();
  const path = routePath.replace(/:([a-zA-Z]+)/g, (_, name) => {
    usedNames.add(name);
    return encodeURIComponent(parsed.positionals[name] ?? '');
  });
  const extra = {};
  for (const [name, value] of Object.entries(parsed.positionals)) {
    if (!usedNames.has(name)) extra[name] = value;
  }
  // `runs` and `status` share one bare, bounded route with no path segment of
  // its own — `status`'s `slug` above already fell through to `extra` for
  // exactly that reason. Both need the route's `latest=1` switch turned on;
  // only `status` adds `&slug=`, which `extra` already carries.
  const boundedRuns = row.name === 'runs' || row.name === 'status';
  if (method === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
    for (const [key, value] of Object.entries(parsed.flags)) query.set(key, String(value));
    if (boundedRuns) query.set('latest', '1');
    const qs = query.toString();
    return { method, path: qs ? `${path}?${qs}` : path, body: undefined };
  }
  const body = { ...extra, ...parsed.flags };
  // `approve` and `deny` press the SAME route and method — a card's route
  // reads the decision from the body, not from which word was typed, so the
  // word is the one thing the table cannot hand the route by itself.
  if (row.name === 'approve') body.decision = 'allow';
  if (row.name === 'deny') body.decision = 'deny';
  return { method, path, body };
}

/** One request over loopback, or `{ok: false}` for anything that never got an answer (refused, timed out, no listener). */
async function send(base, method, path, body, userAgent, timeoutMs) {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-phase-console': '1',
        'user-agent': userAgent,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsedBody;
    try { parsedBody = text ? JSON.parse(text) : null; } catch { parsedBody = { text }; }
    return { ok: true, status: response.status, body: parsedBody };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Which console: `--console <port>` (a bare number) hits that loopback port
 * directly, no registry lookup at all — a stub server in a test is not a
 * registered instance and never needs to be. `--console <name>`, or nothing,
 * resolves the way `doctor`/`report` do — the instance registry's own
 * `selectInstance`: an exact id or name, the one whose root holds the
 * directory this process is standing in, or the machine's only console.
 */
async function resolveConsole(ctx, selector) {
  if (selector !== undefined && /^\d+$/.test(selector)) return { ok: true, port: Number(selector) };
  const instances = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'instances.mjs')).href);
  const found = instances.selectInstance(selector, process.cwd());
  if (found.kind !== 'registered' && found.kind !== 'candidate') {
    return { ok: false, message: instances.selectionError(found) };
  }
  const isDefault = found.default === true || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
  const port = found.port ?? instances.preferredPort(found.root, { isDefault });
  return { ok: true, port };
}

/**
 * `null` when this press may go ahead; otherwise the one- or two-line refusal
 * to print on stderr before exit 2 — the same exit `phase-console license
 * gate` already answers a refused word with.
 *
 * The free build carries no `viewer/server/license/` at all (it is Pro-only,
 * struck by `free/manifest.json`'s `proPaths`), so a free CLI never imports
 * it — `ctx.edition` alone decides, set once by whichever bin dispatched
 * here. Pro asks the SAME runtime every other gated verb does; a source
 * checkout's runtime always reads `open`, which is how this repository's own
 * tests press an act row with no license file on disk at all.
 */
async function editionRefusal(row, ctx) {
  if (ctx.edition === 'free') {
    return `phase-console: '${row.name}' is part of Phase Console Pro — this build's run verb reads only.\n`;
  }
  const dir = join(ctx.root, 'viewer', 'server', 'license');
  const runtimeModule = await import(pathToFileURL(ctx.preferBuilt(dir, 'index')).href);
  const gate = await import(pathToFileURL(ctx.preferBuilt(dir, 'gate')).href);
  const runtime = runtimeModule.configureLicenseRuntime({ root: ctx.root });
  const status = runtime.status();
  return status.open ? null : gate.cliRefusalText(row.name, status);
}

/** A run-shaped object (the slim projection), rendered as one line. */
function isSlimRun(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.slug === 'string' && typeof value.status === 'string'
    && value.phases !== undefined && typeof value.phases === 'object';
}
/**
 * The status word is `status-vocab.js`'s `runStatusWord`, read off the row's
 * lifecycle — a `paused` run asleep on a clock nobody paused prints `waiting`,
 * as every other surface does since control-tower phase 88 (#148). Never the
 * raw `run.status`, which the resume machinery keeps as `paused`.
 */
function runLine(statusWord, run) {
  const phases = Object.entries(run.phases ?? {}).map(([phase, status]) => `${phase}:${status}`).join(',');
  const halt = run.halt && typeof run.halt === 'object' ? (run.halt.kind ?? JSON.stringify(run.halt)) : (run.halt ?? '-');
  return `${run.slug}  status=${statusWord(run)}  activePhase=${run.activePhase ?? '-'}  halt=${halt}  phases=${phases || '-'}`;
}

function renderValue(statusWord, value) {
  if (value === null || value === undefined) return '-';
  if (isSlimRun(value)) return runLine(statusWord, value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Every act row's answer, and every read this file has no bespoke rendering for: one line per top-level field. */
function renderGeneric(statusWord, body) {
  if (body === null || body === undefined) return 'ok\n';
  if (typeof body !== 'object') return `${body}\n`;
  if (Array.isArray(body)) return body.length ? `${body.map((value) => renderValue(statusWord, value)).join('\n')}\n` : '(empty)\n';
  const lines = Object.entries(body).map(([key, value]) => `${key}: ${renderValue(statusWord, value)}`);
  return lines.length ? `${lines.join('\n')}\n` : 'ok\n';
}

function renderRuns(statusWord, body) {
  const rows = Array.isArray(body) ? body : [];
  return rows.length ? `${rows.map((run) => runLine(statusWord, run)).join('\n')}\n` : '(no run)\n';
}

function renderJournal(body) {
  const rows = Array.isArray(body) ? body : [];
  if (!rows.length) return '(empty journal)\n';
  return `${rows.map((row) => `${row.time ?? ''}  ${row.event}${Number.isFinite(row.phase) ? ` (phase ${row.phase})` : ''}`).join('\n')}\n`;
}

function truncate(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Phase 95's activity route: a session's own recent events. */
function renderTail(body) {
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!events.length) return `(no activity)${body?.why ? ` — ${body.why}` : ''}\n`;
  return `${events.map((event) => {
    if (event.kind === 'tool') {
      const state = event.exit ? `[${event.exit}]` : event.open ? '[running]' : '';
      return `${event.at}  tool  ${event.name}${event.summary ? ` — ${truncate(event.summary, 200)}` : ''} ${state}`.trimEnd();
    }
    if (event.kind === 'text') return `${event.at}  text  ${truncate(event.text, 200)}`;
    return `${event.at}  ${event.marker}  ${truncate(event.text, 200)}`;
  }).join('\n')}\n`;
}

/** Phase 95's report route: the summary first, then the fields behind it. */
function renderExplain(body) {
  if (body && typeof body === 'object' && typeof body.error === 'string') return `${body.error}\n`;
  const lines = [body.summary || '(no summary)', '', `status: ${body.status}${body.live ? ' (live)' : ''}`];
  if (body.doing?.task) lines.push(`doing: ${body.doing.task.text}`);
  else if (body.doing?.operation) lines.push(`doing: ${body.doing.operation.label} ${body.doing.operation.done}/${body.doing.operation.of}`);
  else if (body.doing?.last) lines.push(`last: ${truncate(body.doing.last.text, 200)}`);
  lines.push(`done: ${body.done?.count ?? 0}/${body.done?.total ?? 0}`);
  if (body.left?.count) lines.push(`left: ${body.left.count} — ${body.left.items.slice(0, 5).map((item) => item.text).join('; ')}`);
  for (const entry of body.waitingOn ?? []) lines.push(`waiting on: ${entry.text}`);
  for (const entry of body.whySlow ?? []) lines.push(`why slow: ${entry.text}`);
  if (body.eta?.minutes) lines.push(`eta: ${body.eta.minutes.low}-${body.eta.minutes.high} min (${body.eta.confidence})`);
  return `${lines.join('\n')}\n`;
}

function renderTriggers(body) {
  const list = Array.isArray(body?.triggers) ? body.triggers : [];
  if (!list.length) return '(no triggers armed)\n';
  return `${list.map((t) => `${t.id}  ${t.when} -> ${t.verb} [${t.mode}]${t.note ? `  # ${t.note}` : ''}`).join('\n')}\n`;
}

function renderWait(statusWord, body) {
  const head = `for=${body.for}  held=${body.held}  timedOut=${body.timedOut}  waitedMs=${body.waitedMs}`;
  return body.run ? `${head}\n${runLine(statusWord, body.run)}\n` : `${head}\n`;
}

/**
 * `--json` prints the raw answer; every other verb gets a short rendering — bespoke where the shape earns it, generic otherwise.
 * `statusWord` is `status-vocab.js`'s `runStatusWord`, loaded from the install root as `CLI_EXIT` is.
 */
export function renderAnswer(statusWord, row, body) {
  switch (row.name) {
    case 'runs':
    case 'status': return renderRuns(statusWord, body);
    case 'wait': return renderWait(statusWord, body);
    case 'explain': return renderExplain(body);
    case 'tail': return renderTail(body);
    case 'journal': return renderJournal(body);
    case 'triggers': return renderTriggers(body);
    default: return renderGeneric(statusWord, body);
  }
}

/** A body's `error`, or the bare status when the console answered with none. */
function describeError(body, status) {
  if (body && typeof body === 'object' && typeof body.error === 'string') return body.error;
  return `answered ${status}`;
}

/**
 * `CLI_EXIT` from the status and body a press or a read actually got —
 * `wait` is the one row a 200 does not mean `ok`: it answers `held: false,
 * timedOut: true` at 200 exactly as it answers `held: true`, since the
 * predicate simply not holding yet is not the route's error to raise.
 */
export function exitCodeFor(cliExit, row, status, body) {
  if (row.name === 'wait' && status === 200) return body?.held ? cliExit.ok : cliExit['timed-out'];
  if (status >= 200 && status < 300) return cliExit.ok;
  if (status === 404) return cliExit['not-found'];
  return cliExit.refused;
}

function readVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

function printHelp(operatorVerbs, edition, stream) {
  const shaped = operatorVerbs.filter((row) => row.cli !== null);
  const reads = shaped.filter((row) => row.edition === 'free');
  const acts = shaped.filter((row) => row.edition === 'pro');
  const line = (row) => `  ${[row.name, ...row.cli.args.map((a) => `<${a}>`)].join(' ').padEnd(30)} ${row.summary}`;
  const out = [
    'phase-console run <verb> [args] [--flags] [--console <name|port>] [--json]',
    '',
    '  Press or read one operator verb over loopback — the same table the',
    '  console itself presses every verb through. --json prints the raw',
    '  answer; otherwise a short rendering. --console names a registered',
    '  instance, or a bare port to hit directly.',
    '',
    '  reads (both editions):',
    ...reads.map(line),
    '',
    edition === 'free'
      ? '  acts — Phase Console Pro only; this build refuses every one of these:'
      : '  acts (Pro; the license gate is asked before any of these presses):',
    ...acts.map(line),
    '',
  ];
  stream.write(`${out.join('\n')}\n`);
}

/**
 * `wait`'s own loop: the route holds a request open for at most
 * `WAIT_MAX_S` (600s), so a `--timeout` past that is several requests, never
 * one connection held past what the route allows. Each one asks for
 * whatever is left of the OVERALL budget, capped at the route's own ceiling;
 * the loop stops the moment one answers `held`, or the overall budget runs
 * out — never on an individual request's own cap alone.
 */
async function runWait(verbModel, statusWord, row, parsed, base, userAgent, json) {
  const overallS = parsed.flags.timeout !== undefined ? Number(parsed.flags.timeout) : verbModel.WAIT_DEFAULT_S;
  if (!Number.isFinite(overallS) || overallS < 0) {
    process.stderr.write('phase-console run wait: --timeout must be a non-negative number of seconds\n');
    return verbModel.CLI_EXIT.usage;
  }
  const forText = parsed.flags.for;
  if (typeof forText !== 'string' || !forText) {
    process.stderr.write('phase-console run wait: --for <predicate> is required\n');
    return verbModel.CLI_EXIT.usage;
  }
  const { path: bare } = buildRequest(row, { positionals: parsed.positionals, flags: {} });
  let remaining = overallS;
  let outcome;
  do {
    const perRequest = Math.min(remaining, verbModel.WAIT_MAX_S);
    const query = new URLSearchParams({ for: forText, timeout: String(perRequest) });
    // eslint-disable-next-line no-await-in-loop -- each request must settle before the next is worth making
    outcome = await send(base, 'GET', `${bare}?${query}`, undefined, userAgent, (perRequest + 15) * 1000);
    // The slice just asked for is spent whether the route actually held the
    // connection that long or answered sooner — accounting by WALL-CLOCK time
    // elapsed instead would spin as fast as the network allows against
    // anything that answers `held: false` quickly (a stub server in a test,
    // or a route that can decide at once), re-asking for seconds already
    // spent forever instead of stopping at the overall budget.
    remaining -= perRequest;
  } while (outcome.ok && outcome.status === 200 && !outcome.body?.held && remaining > 0);
  return finish(verbModel.CLI_EXIT, statusWord, row, outcome, json);
}

function finish(cliExit, statusWord, row, outcome, json) {
  if (!outcome.ok) {
    process.stderr.write(`phase-console run ${row.name}: no console answered (${outcome.error?.message ?? outcome.error})\n`);
    return cliExit['console-down'];
  }
  const { status, body } = outcome;
  if (json) process.stdout.write(`${JSON.stringify(body)}\n`);
  else if (status >= 200 && status < 300) process.stdout.write(renderAnswer(statusWord, row, body));
  else process.stderr.write(`phase-console run ${row.name}: ${describeError(body, status)}\n`);
  return exitCodeFor(cliExit, row, status, body);
}

/**
 * The verb. `ctx.root` is the package root the bin resolved; `ctx.preferBuilt`
 * picks the shipped `.js` twin under node_modules and the `.ts` elsewhere;
 * `ctx.edition` (`'free'` or `'pro'`) is set once by whichever bin dispatched
 * here and is the whole of how this one shared module tells the two builds
 * apart.
 */
export async function runVerb(argv, ctx) {
  try {
    return await runVerbInner(argv, ctx);
  } catch (error) {
    // The literal `2` rather than `CLI_EXIT.usage`: this catch is what a
    // failed import of verb-model.js itself would hit, so CLI_EXIT may not be
    // in hand — and 2 is what it is worth anyway (a malformed install is a
    // usage problem for whoever is running this, not a route's refusal).
    process.stderr.write(`phase-console run: ${error?.message ?? error}\n`);
    return 2;
  }
}

async function runVerbInner(argv, ctx) {
  const verbModel = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'verb-model.js')).href);
  const { runStatusWord } = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'status-vocab.js')).href);
  const { json, help, consoleSelector, rest } = extractGlobalFlags(argv);
  if (help) { printHelp(verbModel.OPERATOR_VERBS, ctx.edition, process.stdout); return verbModel.CLI_EXIT.ok; }

  const verbWord = rest.shift();
  if (!verbWord) { printHelp(verbModel.OPERATOR_VERBS, ctx.edition, process.stderr); return verbModel.CLI_EXIT.usage; }

  const row = verbModel.verbNamed(verbWord);
  if (!row || !row.cli) {
    process.stderr.write(`phase-console run: unknown verb '${verbWord}' — see: phase-console run --help\n`);
    return verbModel.CLI_EXIT.usage;
  }

  if (row.edition === 'pro') {
    const refusal = await editionRefusal(row, ctx);
    if (refusal) { process.stderr.write(refusal); return verbModel.CLI_EXIT.usage; }
  }

  let parsed;
  try {
    parsed = parseRowArgs(row, rest);
  } catch (error) {
    process.stderr.write(`phase-console run: ${error.message}\n`);
    return verbModel.CLI_EXIT.usage;
  }

  const resolved = await resolveConsole(ctx, consoleSelector);
  if (!resolved.ok) {
    process.stderr.write(`phase-console run: ${resolved.message}\n`);
    return verbModel.CLI_EXIT.usage;
  }
  const base = `http://127.0.0.1:${resolved.port}`;
  const userAgent = `phase-console/${readVersion(ctx.root)} run`;

  if (row.name === 'wait') return runWait(verbModel, runStatusWord, row, parsed, base, userAgent, json);

  const { method, path, body } = buildRequest(row, parsed);
  const outcome = await send(base, method, path, body, userAgent, 30_000);
  return finish(verbModel.CLI_EXIT, runStatusWord, row, outcome, json);
}
