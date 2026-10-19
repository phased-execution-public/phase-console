/**
 * Every backend option has a front-end answer — or a written reason it has
 * none, or the phase that draws it (quiet-console phase 2, exit criterion 6;
 * §Architecture 5).
 *
 * `client/src/data/surface.ts` lists everything the server exposes — each HTTP
 * route by method, each SSE event, each settings key, each operator verb — and
 * where a person meets it. A list like that is a claim, so this file derives
 * the truth from the SERVER and holds the claim to it in both directions:
 *
 *   - ROUTES. Every route the dispatcher branches on (`./route-parse.ts`, the
 *     parse `route-coverage.test.ts` reads), and every one that parse cannot
 *     see — the hooks and the stream (`path === '…'`), a step's verbs, the
 *     queue and lane verbs, the owner key's presses — has a row. Every row is a
 *     route the router itself SERVES (`./route-probe.ts`, through `handleApi`),
 *     and on a row's path every other method the router serves has a row too.
 *   - VERBS and AUTHORITY. Every `OPERATOR_VERBS` row has a verb row whose route
 *     has a route row; every `AUTHORITY_ROUTES` row is pressed by a route row,
 *     and a row carries an authority exactly where the door table gives one.
 *   - EVENTS. What the server emits, `SSE_EVENTS` and the event rows are one set.
 *   - SETTINGS. Every key of the server's `Prefs`, its retention policy, a run's
 *     fields, the browser's `Prefs`, the machine profile and the capability
 *     flags has a row.
 *   - THE FLEET SUPERVISOR (Pro). Every route the supervisor's own dispatcher
 *     answers (`viewer/fleet/index.ts`) has a `server: 'supervisor'` row, and
 *     every such row is one of them — a console's `#/fleet` reaches them
 *     through its relay, and this console's router is never asked.
 *   - EVERY ROW. One id; exactly one of a door and a reason — nothing is left
 *     for a later phase since phase 26 completed the registry, so an
 *     `unassigned` row fails by name; a door under a route head whose data is
 *     an export a page really reaches — no phantom door; a reason that is TRUE:
 *     its `caller` is a repository file that exists and names the thing; the
 *     flag the router names when it refuses; an edition its source's `!pro:`
 *     regions agree with; and the ratchet at zero.
 *
 * `auditSurface` is one function returning sentences — empty is the only pass —
 * and it proves its teeth on a fixture at the bottom.
 */

// Before anything reaches `server/`: the router's module graph resolves the
// console's state directory at load.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DISPATCHER, VIEWER, readRepo, routeLinesOf } from './route-parse.ts';
import { FLAGS_OFF, FLAGS_ON, fill, noRoute, probe, type ProbeAnswer } from './route-probe.ts';
import { AUTHORITY_ROUTES, authorityRouteOf } from '../shared/door-model.js';
import { CAPABILITY_WORDS } from '../shared/capability-model.js';
import { OVERRIDABLE_PROFILE_KEYS } from '../shared/instances.mjs';
import { LANE_VERBS, QUEUE_VERBS } from '../shared/orchestration-model.js';
import { ROUTE_HEADS } from '../shared/route-meta.js';
import { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } from '../shared/run-settings.js';
import { OPERATOR_VERBS } from '../shared/verb-model.js';
import { RETENTION_DEFAULTS } from '../server/retention-policy.ts';
import { SURFACE, SURFACE_PLACES, type SurfaceRow } from '../client/src/data/surface.ts';

const SRC = join(VIEWER, 'client', 'src');
/** The Pro tree has its own server folder; the free tree is built without it. */
const PRO_TREE = existsSync(join(VIEWER, 'server', 'pro'));
/** The places only the Pro tree has (§Architecture 3). */
const PRO_PLACES: ReadonlySet<string> = new Set(['Fleet', 'Supervisor']);
/** What the router is asked besides the five methods: a method no route reads, so whatever answers it answers every method. */
const ANY_METHOD = 'BREW';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Rows the router is never asked about, each with why. (A row marked `stream`
 * is never asked either: an event stream answers by staying open.)
 */
const NEVER_PROBED: ReadonlyMap<string, string> = new Map([
  [
    'GET /api/tailscale',
    'it shells out to the `tailscale` CLI — a process an empty service cannot hold back',
  ],
]);

/* ------------------------------------------------------------------ *
 * Reading a tree
 * ------------------------------------------------------------------ */

/** The free build's marker rule (`scripts/build-free-tree.mjs` `isMarkerLine`): a line's first token, after an optional comment opener. */
function markerOf(line: string): string | null {
  const m = /^\s*\{?\s*(?:\/\/+|#+|<!--|\/\*+|\*+|-{2,}|;+)?\s*(\S+)/.exec(line);
  return m ? m[1]!.replace(/(?:-->|\*\/\}?)$/, '') : null;
}

/** The 1-based lines a `!pro:` region covers, markers included. */
function proLines(text: string): Set<number> {
  const out = new Set<number>();
  let depth = 0;
  text.split('\n').forEach((line, i) => {
    const token = markerOf(line);
    if (token === '!pro:start') depth += 1;
    if (depth > 0) out.add(i + 1);
    if (token === '!pro:end') depth -= 1;
  });
  return out;
}

/** A text as the free build leaves it: every `!pro:` region dropped, markers and all. */
function freeText(text: string): string {
  const pro = proLines(text);
  return text
    .split('\n')
    .filter((_, i) => !pro.has(i + 1))
    .join('\n');
}

/** The 1-based line `at` (an offset) sits on. */
const lineAt = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/** A route the dispatcher branches on: the first line naming it, and whether a line outside a `!pro:` region names it too. */
type RouteKey = { line: number; free: boolean };

/** The head-and-verb routes of the dispatcher, each with whether the free tree keeps it. */
export function dispatcherRoutes(source: string): Map<string, RouteKey> {
  const pro = proLines(source);
  return new Map(
    [...routeLinesOf(source)].map(([key, lines]) => [
      key,
      { line: lines[0]!, free: lines.some((line) => !pro.has(line)) },
    ]),
  );
}

/** `path === '/…'`: the routes the head parse cannot see — the hooks and the stream. */
export function pathRoutes(source: string): { path: string; line: number; free: boolean }[] {
  const pro = proLines(source);
  const out: { path: string; line: number; free: boolean }[] = [];
  source.split('\n').forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/\bpath === '(\/[\w/-]+)'/g)) {
      if (!out.some((seen) => seen.path === m[1]))
        out.push({ path: m[1]!, line: i + 1, free: !pro.has(i + 1) });
    }
  });
  return out;
}

/** A step's verbs — read off a destructured `verb` the head parse does not follow (`route-coverage.test.ts` reads them the same way). */
export function stepVerbs(source: string): string[] {
  const at = source.indexOf("if (head === 'human-steps')");
  if (at < 0) return [];
  const branch = source.slice(at, source.indexOf("json(res, 405, { error: 'GET /api/human-steps", at));
  return [...new Set([...branch.matchAll(/\bverb === '([a-z-]+)'/g)].map((m) => m[1]!))];
}

/** The owner key's presses (`server/owner/presses.ts`), which the router hands its whole head to. */
export function ownerPresses(text: string): { method: string; path: string; line: number }[] {
  const out: { method: string; path: string; line: number }[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /input\.method === '([A-Z]+)' && sub === '([\w-]+)'/.exec(line);
    if (!m) return;
    const base = `/api/owner/${m[2]}`;
    const verbs = [...line.matchAll(/\bverb === '([\w-]+)'/g)].map((v) => `${base}/${v[1]}`);
    const paths = verbs.length ? verbs : /rest\.length === 2/.test(line) ? [`${base}/:id`] : [base];
    for (const path of paths) out.push({ method: m[1]!, path, line: i + 1 });
  });
  return out;
}

/** A route the fleet supervisor answers, and the line of its dispatcher that branches on it. */
export type SupervisorRoute = { method: string; path: string; line: number };

/**
 * The fleet supervisor's own routes (`viewer/fleet/index.ts`, Pro): every
 * `if (…) {` condition of its dispatcher that names a `method` and a path —
 * `path === '/api/…'`, the one regex it tests a path with
 * (`/^\/api\/approvals\/[^/]+$/`, read as `:id`), the instance verbs it
 * reads off `parts` (`/api/fleet/instances/:id/:verb`), and the reach routes
 * its `reachApi` reads off `rest` under `/api/fleet/reach` (a code after
 * `pair-code`, an id anywhere else). A condition never spans a statement
 * (`[^;{}]`), so `if (refuseWrite()) return;` lends nothing to the next one.
 */
export function supervisorRoutes(source: string): SupervisorRoute[] {
  const out: SupervisorRoute[] = [];
  const add = (method: string, path: string, line: number): void => {
    if (!out.some((seen) => seen.method === method && seen.path === path)) out.push({ method, path, line });
  };
  for (const m of source.matchAll(/\bif \(([^;{}]*?)\)\s*\{/g)) {
    const condition = m[1]!;
    const methods = [...condition.matchAll(/(?<![.\w])method === '([A-Z]+)'/g)].map((x) => x[1]!);
    if (!methods.length) continue;
    const line = lineAt(source, m.index);
    const paths = [...condition.matchAll(/(?<![.\w])path === '(\/api\/[\w/-]+)'/g)].map((x) => x[1]!);
    for (const x of condition.matchAll(/\/\^((?:\\\/[\w-]+)+)\\\/\[\^\/\]\+\$\/\.test\(path\)/g)) {
      paths.push(`${x[1]!.replace(/\\\//g, '/')}/:id`);
    }
    const parts = [...condition.matchAll(/(?<![.\w])parts\[(\d)\] === '([\w-]+)'/g)];
    const partsLength = /(?<![.\w])parts\.length === (\d+)/.exec(condition);
    if (parts.length && partsLength) {
      const known = parts.sort((a, b) => Number(a[1]) - Number(b[1])).map((x) => x[2]!);
      const params = [':id', ':verb'].slice(0, Number(partsLength[1]) - known.length);
      paths.push(`/${[...known, ...params].join('/')}`);
    }
    const restLength = /(?<![.\w])rest\.length === (\d+)/.exec(condition);
    if (restLength) {
      const length = Number(restLength[1]);
      const first = /(?<![.\w])rest\[0\] === '([\w-]+)'/.exec(condition)?.[1];
      const ends = [...condition.matchAll(/(?<![.\w])rest\[([1-9])\] === '([\w-]+)'/g)];
      const segments = first ? [first] : [];
      while (segments.length < length - (ends.length ? 1 : 0)) {
        segments.push(segments.at(-1) === 'pair-code' ? ':code' : ':id');
      }
      const tails = ends.length ? ends.map((x) => [...segments, x[2]!]) : [segments];
      for (const tail of tails) paths.push(['/api/fleet/reach', ...tail].join('/'));
    }
    for (const method of methods) for (const path of paths) add(method, path, line);
  }
  return out;
}

/**
 * The events the server emits, each with whether free code emits it: every
 * `<receiver>.emit('<name>'` under `server/` — the runner's own `this.emit` is
 * prefixed `run:` (`runner.ts` `emit()` → `onEvent(\`run:${event}\`)`).
 */
export function emittedEvents(
  files: readonly { rel: string; text: string }[],
  isProPath: (rel: string) => boolean,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const { rel, text } of files) {
    const runner = /^viewer\/server\/runner\/runner[\w-]*\.ts$/.test(rel);
    const pro = proLines(text);
    text.split('\n').forEach((raw, i) => {
      if (/^\s*(?:\/\/|\*)/.test(raw)) return;
      for (const m of raw.matchAll(/([\w.]+)\.emit\(\s*'([a-z][\w:-]*)'/g)) {
        const name = runner && m[1] === 'this' ? `run:${m[2]}` : m[2]!;
        const free = !isProPath(rel) && !pro.has(i + 1);
        out.set(name, (out.get(name) ?? false) || free);
      }
    });
  }
  return out;
}

/** `SSE_EVENTS` (`data/live.ts`), each with whether it sits outside the `!pro:` region. */
export function declaredEvents(text: string): Map<string, boolean> {
  const start = text.indexOf('export const SSE_EVENTS = [');
  const end = text.indexOf('] as const;', start);
  const pro = proLines(text);
  const first = lineAt(text, start);
  const out = new Map<string, boolean>();
  text
    .slice(start, end)
    .split('\n')
    .forEach((line, i) => {
      const m = /^\s*'([^']+)',/.exec(line);
      if (m) out.set(m[1]!, !pro.has(first + i));
    });
  return out;
}

/** The keys of a type or interface block — `  key:` at its own indent — each with whether the free tree keeps it. */
export function blockKeys(text: string, opener: string): Map<string, boolean> {
  const start = text.indexOf(opener);
  const out = new Map<string, boolean>();
  if (start < 0) return out;
  const pro = proLines(text);
  const first = lineAt(text, start);
  const lines = text.slice(start).split('\n');
  for (let i = 1; i < lines.length && !/^\};?\s*$/.test(lines[i]!); i += 1) {
    const m = /^ {2}(\w+)\??:/.exec(lines[i]!);
    if (m) out.set(m[1]!, !pro.has(first + i));
  }
  return out;
}

/** The machine profile's own fields: what `sanitizeProfileFields` keeps, plus each instance's `autostart`. */
export function profileKeys(text: string): Map<string, boolean> {
  const start = text.indexOf('function sanitizeProfileFields');
  const out = new Map<string, boolean>();
  if (start < 0) return out;
  const pro = proLines(text);
  const first = lineAt(text, start);
  text
    .slice(start, text.indexOf('\n}', start))
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/\bout\.(\w+)\s*=/g))
        if (!out.has(m[1]!)) out.set(m[1]!, !pro.has(first + i));
    });
  for (const key of OVERRIDABLE_PROFILE_KEYS) if (!out.has(key)) out.set(key, true);
  if (/\bentry\.autostart\b/.test(text)) out.set('autostart', true);
  return out;
}

/** Whether the line that writes `needle` in a vocabulary file sits outside its `!pro:` region. */
function freeLine(text: string, needle: string): boolean {
  const at = text.indexOf(needle);
  return at >= 0 && !proLines(text).has(lineAt(text, at));
}

/* ------------------------------------------------------------------ *
 * The audit
 * ------------------------------------------------------------------ */

/** A UI file: a non-test module under `client/src` outside `data/` and `lib/sse.ts`, its whole text and the free tree's. */
export interface UiFile {
  name: string;
  text: string;
  /** Empty for a Pro-only file. */
  free: string;
}

type AuthorityRow = { verb: string; authority: string; method: string; path: string };

export interface SurfaceTruth {
  rows: readonly SurfaceRow[];
  /** Is this the Pro tree? (The free tree carries no Pro row and no Pro count.) */
  pro: boolean;
  /** The dispatcher's head-and-verb routes. */
  routes: ReadonlyMap<string, RouteKey>;
  /** The routes outside `/api/` the router compares a path to. */
  outside: readonly { path: string; line: number; free: boolean }[];
  /** The fleet supervisor's own routes — none in the free tree, which has no supervisor. */
  supervisor: readonly SupervisorRoute[];
  /** Routes read off a word list, each id with where it was read. */
  required: readonly { id: string; from: string }[];
  verbs: readonly { name: string; route: string; free: boolean }[];
  authority: readonly AuthorityRow[];
  authorityOf: (method: string, path: string) => AuthorityRow | null;
  emitted: ReadonlyMap<string, boolean>;
  declared: ReadonlyMap<string, boolean>;
  /** Setting id → whether the free tree keeps it, and which store it is read from. */
  settings: ReadonlyMap<string, { free: boolean; from: string }>;
  flags: readonly string[];
  heads: readonly string[];
  proHeads: ReadonlySet<string>;
  places: readonly string[];
  ratchet: { free: number; pro?: number };
  /** A repository-relative file's text, or null. */
  read: (rel: string) => string | null;
  isProPath: (rel: string) => boolean;
  ui: readonly UiFile[];
  /** The router itself — absent, the route checks the text can make are all that run. */
  ask?: (method: string, path: string, flags: 'on' | 'off') => Promise<ProbeAnswer>;
}

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean);
/** A path's segments after `/api/`, or null for a path outside it. */
const apiSegments = (path: string): string[] | null =>
  path.startsWith('/api/') ? segmentsOf(path.slice(5)) : null;
const clip = (body: string): string => (body.length > 120 ? `${body.slice(0, 117)}…` : body);
const same = (a: ProbeAnswer, b: ProbeAnswer): boolean => a.status === b.status && a.body === b.body;

/** Why a door's `data` (or `caller`) is no door, or null. */
function dataProblem(row: SurfaceRow, truth: SurfaceTruth): string | null {
  const free = row.edition === 'free';
  const visible = (file: UiFile): string => (free ? file.free : file.text);
  if (row.data === undefined) {
    if (row.caller !== undefined) {
      const rel = `viewer/client/src/${row.caller}`;
      const text = truth.read(rel);
      if (text === null) return `names the caller ${row.caller}, which does not exist`;
      if (free && truth.isProPath(rel)) return `is a free row, and its caller ${row.caller} is Pro-only`;
      if (!row.path || !text.includes(row.path))
        return `names the caller ${row.caller}, which never asks for ${row.path}`;
      return null;
    }
    return row.kind === 'setting'
      ? null
      : 'has a door and no data — name the export under data/ a page reaches it through';
  }
  const m = /^([\w/-]+)#(\w+)(?:\.(\w+))?$/.exec(row.data);
  if (!m) return `names the data \`${row.data}\`, which is not \`<file>#<export>[.<member>]\``;
  const [, file, name, member] = m as unknown as [string, string, string, string | undefined];
  const rel = `viewer/client/src/data/${file}.ts`;
  const whole = truth.read(rel);
  if (whole === null) return `names data/${file}.ts, which does not exist`;
  if (free && truth.isProPath(rel)) return `is a free row, and data/${file}.ts is Pro-only`;
  const text = free ? freeText(whole) : whole;
  const declared = new RegExp(`^export (?:async )?(?:function|const|let) ${name}\\b`, 'm').exec(text);
  if (!declared)
    return `names \`${name}\`, which data/${file}.ts does not export${free ? ' in the free tree' : ''}`;
  if (member !== undefined) {
    const rest = text.slice(declared.index + 1);
    const next = rest.search(/^export /m);
    const body = next < 0 ? rest : rest.slice(0, next);
    if (!new RegExp(`^\\s+(?:async\\s+)?${member}\\s*[:(<]`, 'm').test(body)) {
      return `names \`${name}.${member}\`, which \`${name}\` does not hold`;
    }
  }
  const needle = member === undefined ? new RegExp(`\\b${name}\\b`) : new RegExp(`\\.${member}\\b`);
  if (truth.ui.some((page) => needle.test(visible(page)))) return null;
  const spelled = member === undefined ? `\`${name}\`` : `\`.${member}\``;
  return `is a PHANTOM door: no page under client/src${free ? ' in the free tree' : ''} reaches ${spelled} — name the export a page really uses, or the phase that draws it`;
}

/** What a caller must spell to name a row: a route's path up to its first placeholder, an event, a verb, a key's last word. */
function mentionOf(row: SurfaceRow): string {
  if (row.kind === 'route') return (row.path ?? '').split('/:')[0]!;
  if (row.kind === 'sse') return row.event ?? '';
  if (row.kind === 'verb') return row.verb ?? '';
  return (row.key ?? '').split(/[. ]/).pop() ?? '';
}

/**
 * Why an exempt row's reason is no fact, or null. A reason says no page should
 * draw a thing; it is true only when something else really reaches it — the
 * `caller`, a repository file that exists, that the row's edition has, and
 * that names the thing.
 */
function exemptProblem(row: SurfaceRow, truth: SurfaceTruth): string | null {
  if (row.caller === undefined) {
    return 'is exempt and names no caller — name the file that reaches it instead of a page (a hook script, the CLI, the server, the supervisor, the doc a script reads)';
  }
  const whole = truth.read(row.caller);
  if (whole === null) return `is exempt by ${row.caller}, which does not exist`;
  const free = row.edition === 'free';
  if (free && truth.isProPath(row.caller)) return `is a free row exempt by ${row.caller}, which is Pro-only`;
  const needle = mentionOf(row);
  if (!needle || !(free ? freeText(whole) : whole).includes(needle)) {
    return `is exempt by ${row.caller}, which never names ${needle}${free ? ' in the free tree' : ''}`;
  }
  return null;
}

/** The body of an export under `data/`: from its declaration to the next export. */
function exportBody(text: string, name: string): string | null {
  const declared = new RegExp(`^export (?:async )?(?:function|const|let) ${name}\\b`, 'm').exec(text);
  if (!declared) return null;
  const rest = text.slice(declared.index + 1);
  const next = rest.search(/^export /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Why a row's options are not all a person's to send, as sentences. An option
 * is a body or query field beyond the bare press; it has a door when the
 * door's data export spells it (the export can send it) AND a page that
 * reaches the export spells it too (a person can set it). The row's own
 * `data` problems are `dataProblem`'s to say.
 */
function optionProblems(row: SurfaceRow, truth: SurfaceTruth): string[] {
  if (!row.options?.length) return [];
  if (row.kind !== 'route') return ['names options, which only a route has'];
  if (!row.door || row.data === undefined) {
    return ["names options and no door that sends them — an option rides its door's data export"];
  }
  const m = /^([\w/-]+)#(\w+)(?:\.(\w+))?$/.exec(row.data);
  if (!m) return [];
  const [, file, name, member] = m as unknown as [string, string, string, string | undefined];
  const whole = truth.read(`viewer/client/src/data/${file}.ts`);
  if (whole === null) return [];
  const free = row.edition === 'free';
  const body = exportBody(free ? freeText(whole) : whole, name) ?? '';
  const visible = (page: UiFile): string => (free ? page.free : page.text);
  const needle = member === undefined ? new RegExp(`\\b${name}\\b`) : new RegExp(`\\.${member}\\b`);
  const pages = truth.ui.filter((page) => needle.test(visible(page)));
  const out: string[] = [];
  for (const option of row.options) {
    const word = new RegExp(`\\b${option}\\b`);
    if (!word.test(body)) {
      out.push(`names the option \`${option}\`, which \`${name}\` never spells — the export cannot send it`);
    } else if (!pages.some((page) => word.test(visible(page)))) {
      out.push(
        `names the option \`${option}\`, which no page that reaches \`${member ?? name}\` spells — no person can set it`,
      );
    }
  }
  return out;
}

/** Everything wrong, as sentences — empty is the only pass. */
export async function auditSurface(truth: SurfaceTruth): Promise<string[]> {
  const failures: string[] = [];
  const say = (sentence: string): void => {
    failures.push(sentence);
  };
  const { rows } = truth;
  const byId = new Map<string, SurfaceRow>();
  // This console's dispatcher's rows; the supervisor's are held to its own dispatcher below.
  const routeRows = rows.filter(
    (row) => row.kind === 'route' && row.method && row.path && row.server !== 'supervisor',
  );
  const supervisorRows = rows.filter((row) => row.kind === 'route' && row.server === 'supervisor');

  /* ---- every row ---- */
  for (const row of rows) {
    if (byId.has(row.id)) say(`data/surface.ts has two rows \`${row.id}\` — one row per thing`);
    byId.set(row.id, row);
    const answers = [row.door, row.exempt, row.unassigned].filter((answer) => answer !== undefined).length;
    if (answers === 0) {
      say(
        `\`${row.id}\` gives no answer — a door, the reason it has none (exempt), or the phase that draws it (unassigned)`,
      );
    } else if (answers > 1) {
      say(
        `\`${row.id}\` gives ${answers} answers — exactly one of a door, an exempt reason and the phase that draws it`,
      );
    }
    if (row.unassigned !== undefined) {
      say(
        `\`${row.id}\` is left for "${row.unassigned}" — nothing is left for later since phase 26 completed the registry: give it a door, or the reason no page draws it and the file that reaches it instead`,
      );
    }
    if (row.exempt !== undefined) {
      if (!row.exempt.trim()) say(`\`${row.id}\` is exempt with no reason — say why no page should ever draw it`);
      const problem = exemptProblem(row, truth);
      if (problem) say(`\`${row.id}\` ${problem}`);
    }
    const spelled =
      row.kind === 'route'
        ? `${row.server === 'supervisor' ? 'supervisor ' : ''}${row.method} ${row.path}`
        : row.kind === 'sse'
          ? `sse ${row.event}`
          : row.kind === 'verb'
            ? `verb ${row.verb}`
            : `setting ${row.key}`;
    if (row.id !== spelled)
      say(`\`${row.id}\` is spelled \`${spelled}\` by its own fields — make the two agree`);
    if (row.edition === 'pro' && !truth.pro) {
      say(`\`${row.id}\` is a Pro row the free tree kept — it belongs in a !pro: region`);
    }
    if (row.flag !== undefined && !truth.flags.includes(row.flag)) {
      say(`\`${row.id}\` names ${row.flag}, which is no capability flag (CAPABILITY_WORDS)`);
    }
    if (row.authority !== undefined && row.kind !== 'route' && row.kind !== 'verb') {
      say(`\`${row.id}\` carries an authority, which only a route or a verb presses`);
    }
    if (row.door) {
      const { place, head } = row.door;
      if (!truth.heads.includes(head)) {
        say(
          `\`${row.id}\` has its door under the head \`${head}\`, which ROUTE_HEADS does not have — name the head its page is under today`,
        );
      } else if (row.edition === 'free' && truth.proHeads.has(head)) {
        say(`\`${row.id}\` is a free row with its door under \`${head}\`, a head only the Pro tree has`);
      }
      if (!truth.places.includes(place))
        say(`\`${row.id}\` has its door in "${place}", which is no place of the map`);
      else if (row.edition === 'free' && PRO_PLACES.has(place)) {
        say(`\`${row.id}\` is a free row with its door in ${place}, a place only the Pro tree has`);
      }
      const problem = dataProblem(row, truth);
      if (problem) say(`\`${row.id}\` ${problem}`);
    } else if (row.data !== undefined || (row.caller !== undefined && row.exempt === undefined)) {
      say(`\`${row.id}\` names where a page reaches it and gives no door — a door, or no data`);
    }
    for (const issue of optionProblems(row, truth)) say(`\`${row.id}\` ${issue}`);
  }

  /* ---- routes: the parse's, and the ones read off a word list ---- */
  for (const [key, at] of truth.routes) {
    const [head, word] = key.split('/') as [string, string | undefined];
    const covered = routeRows.some((row) => {
      const segments = apiSegments(row.path!);
      return (
        segments !== null && segments[0] === head && (word === undefined || segments.slice(1).includes(word))
      );
    });
    if (!covered) {
      say(
        `routes.ts:${at.line} answers \`${key}\`, and no row of data/surface.ts covers it — give it a row: its door, the reason it has none, or the phase that draws it`,
      );
    }
  }
  for (const { path, line } of truth.outside) {
    if (!routeRows.some((row) => row.path === path)) {
      say(`routes.ts:${line} answers ${path}, and no row of data/surface.ts names it — give it a row`);
    }
  }
  for (const { id, from } of truth.required) {
    if (!byId.has(id))
      say(`${from} answers \`${id}\`, and no row of data/surface.ts names it — give it a row`);
  }
  for (const row of routeRows) {
    const segments = apiSegments(row.path!);
    let free: boolean | undefined;
    if (segments) {
      const head = truth.routes.get(segments[0]!);
      if (!head) {
        say(
          `\`${row.id}\` names the head \`${segments[0]}\`, which the dispatcher never branches on — fix the path, or delete the row`,
        );
        continue;
      }
      const verbs = [...truth.routes].filter(([key]) => {
        const [first, word] = key.split('/');
        return first === segments[0] && word !== undefined && segments.slice(1).includes(word);
      });
      free = verbs.length ? verbs.some(([, at]) => at.free) : head.free;
    } else {
      const outside = truth.outside.find((route) => route.path === row.path);
      if (!outside) {
        say(`\`${row.id}\` names a path the router never compares — fix the path, or delete the row`);
        continue;
      }
      free = outside.free;
    }
    if ((row.edition === 'pro') === free) {
      say(
        `\`${row.id}\` is ${row.edition}, and the dispatcher's branch for it is ${free ? 'in both trees' : 'Pro-only'} — make it ${free ? 'free' : 'pro'}`,
      );
    }
  }

  /* ---- the fleet supervisor's own routes ---- */
  for (const route of truth.supervisor) {
    const row = byId.get(`supervisor ${route.method} ${route.path}`);
    if (!row || row.server !== 'supervisor') {
      say(
        `fleet/index.ts:${route.line} answers \`${route.method} ${route.path}\`, and no supervisor row of data/surface.ts names it — give it a row: its door, the reason it has none, or the phase that draws it`,
      );
    }
  }
  for (const row of supervisorRows) {
    if (!truth.supervisor.some((route) => `supervisor ${route.method} ${route.path}` === row.id)) {
      say(`\`${row.id}\` is a supervisor row, and the supervisor's dispatcher never answers it — fix it, or delete the row`);
    }
    if (row.edition !== 'pro') say(`\`${row.id}\` is the supervisor's, which only the Pro tree has — make it pro`);
  }

  /* ---- operator verbs, and who presses with authority ---- */
  for (const verb of truth.verbs) {
    const row = byId.get(`verb ${verb.name}`);
    const route = byId.get(verb.route);
    if (!row)
      say(
        `OPERATOR_VERBS has \`${verb.name}\`, and no \`verb ${verb.name}\` row says where a person presses it`,
      );
    else if ((row.edition === 'pro') === verb.free) {
      say(
        `\`verb ${verb.name}\` is ${row.edition}, and its OPERATOR_VERBS row is ${verb.free ? 'in both trees' : 'Pro-only'}`,
      );
    }
    if (!route) say(`\`${verb.name}\` presses \`${verb.route}\`, which has no route row`);
    else if (row) {
      if (row.flag !== route.flag) {
        say(
          `\`verb ${verb.name}\` names ${row.flag ?? 'no flag'} and its route \`${verb.route}\` ${route.flag ?? 'no flag'} — one press, one flag`,
        );
      }
      if (row.authority !== route.authority) {
        say(
          `\`verb ${verb.name}\` carries ${row.authority ?? 'no authority'} and its route \`${verb.route}\` ${route.authority ?? 'none'} — one press, one authority`,
        );
      }
    }
  }
  for (const row of rows) {
    if (row.kind === 'verb' && !truth.verbs.some((verb) => verb.name === row.verb)) {
      say(`\`${row.id}\` names a verb OPERATOR_VERBS does not have — delete the row`);
    }
  }
  for (const row of routeRows) {
    const pressed = truth.authorityOf(row.method!, row.path!);
    if (pressed && row.authority !== pressed.authority) {
      say(
        `\`${row.id}\` presses \`${pressed.verb}\` (AUTHORITY_ROUTES), so it carries the authority \`${pressed.authority}\``,
      );
    } else if (!pressed && row.authority !== undefined) {
      say(`\`${row.id}\` claims the authority \`${row.authority}\`, which the door table does not give it`);
    }
  }
  for (const pressed of truth.authority) {
    if (!routeRows.some((row) => truth.authorityOf(row.method!, row.path!) === pressed)) {
      say(
        `AUTHORITY_ROUTES \`${pressed.verb}\` (${pressed.method} ${pressed.path}) is pressed by no route row`,
      );
    }
  }

  /* ---- events ----
   * One set in the Pro tree. The free client may declare a name only Pro code
   * emits (`restart`, `repo:radar` — `live.test.ts` holds its 35 on purpose: a
   * name nobody sends is inert), so there the server's names need only be
   * declared; what a free tree must never do is send a name its client drops. */
  for (const [name, freeEmit] of truth.emitted) {
    const declared = truth.declared.get(name);
    if (declared === undefined) {
      say(
        `the server emits \`${name}\`, which SSE_EVENTS (data/live.ts) does not declare — no page ever hears it`,
      );
    } else if (freeEmit && !declared) {
      say(
        `free code emits \`${name}\`, which SSE_EVENTS declares only in its !pro: region — the free stream would send what the free page drops`,
      );
    }
  }
  for (const [name, free] of truth.declared) {
    if (truth.pro && !truth.emitted.has(name))
      say(`SSE_EVENTS declares \`${name}\`, which nothing under server/ emits`);
    const row = byId.get(`sse ${name}`);
    if (!row) say(`the stream carries \`${name}\`, and no \`sse ${name}\` row says where a person meets it`);
    else if ((row.edition === 'pro') === free) {
      say(
        `\`sse ${name}\` is ${row.edition}, and SSE_EVENTS declares it ${free ? 'in both trees' : 'in its !pro: region'}`,
      );
    }
  }
  for (const row of rows) {
    if (row.kind === 'sse' && !truth.declared.has(row.event!)) {
      say(`\`${row.id}\` names an event SSE_EVENTS does not declare — delete the row`);
    }
  }

  /* ---- settings ---- */
  for (const [id, { free, from }] of truth.settings) {
    const row = byId.get(id);
    if (!row)
      say(
        `${from} holds \`${id.slice('setting '.length)}\`, and no \`${id}\` row says where a person sets it`,
      );
    else if ((row.edition === 'pro') === free)
      say(
        `\`${id}\` is ${row.edition}, and ${from} keeps it ${free ? 'in both trees' : 'in a !pro: region'}`,
      );
  }
  for (const row of rows) {
    if (row.kind === 'setting' && !truth.settings.has(row.id))
      say(`\`${row.id}\` names a key nothing stores — delete the row`);
  }

  /* ---- the ratchet ---- */
  const owed = (edition: 'free' | 'pro'): number =>
    rows.filter((row) => row.unassigned !== undefined && row.edition === edition).length;
  const editions: ('free' | 'pro')[] = truth.pro ? ['free', 'pro'] : ['free'];
  for (const edition of editions) {
    const counted = owed(edition);
    const held = truth.ratchet[edition];
    if (counted !== held) {
      say(
        counted > (held ?? 0)
          ? `${counted} ${edition} rows are unassigned, and surface-ratchet.json holds ${held} — the count may only fall: give the new row a door or a reason`
          : `${counted} ${edition} rows are unassigned, and surface-ratchet.json still holds ${held} — lower it to ${counted}`,
      );
    }
  }

  /* ---- the router itself ---- */
  if (truth.ask) {
    const ask = truth.ask;
    const answers = new Map<string, Promise<ProbeAnswer>>();
    const answer = (method: string, path: string, flags: 'on' | 'off'): Promise<ProbeAnswer> => {
      const key = `${method} ${fill(path)} ${flags}`;
      if (!answers.has(key)) answers.set(key, ask(method, fill(path), flags));
      return answers.get(key)!;
    };
    const silent = (method: string, path: string, got: ProbeAnswer): boolean => {
      if (got.status !== -1) return false;
      say(`the router never answered \`${method} ${path}\` — ${got.body}`);
      return true;
    };
    const probed = routeRows.filter((row) => !row.stream && !NEVER_PROBED.has(row.id));
    const streams = new Set(routeRows.filter((row) => row.stream).map((row) => row.path!));

    for (const row of probed) {
      const got = await answer(row.method!, row.path!, 'on');
      if (silent(row.method!, row.path!, got)) continue;
      if (noRoute(got)) {
        say(
          `\`${row.id}\` is a row, and the router does not serve it (${got.status} ${clip(got.body)}) — fix its method or its path, or delete the row`,
        );
      }
    }

    for (const path of new Set(probed.map((row) => row.path!))) {
      if (streams.has(path)) continue;
      const here = routeRows.filter((row) => row.path === path);
      const blind = await answer(ANY_METHOD, path, 'on');
      const blindServed = blind.status !== -1 && !noRoute(blind);
      if (blindServed) {
        let owned = false;
        for (const row of here) {
          if (row.stream || NEVER_PROBED.has(row.id)) continue;
          if (same(await answer(row.method!, path, 'on'), blind)) owned = true;
        }
        if (!owned) {
          say(
            `the router answers ${path} on any method (${blind.status} ${clip(blind.body)}), and no row is that handler — give the method a page uses a row`,
          );
        }
      }
      for (const method of METHODS) {
        if (here.some((row) => row.method === method)) continue;
        const got = await answer(method, path, 'on');
        if (silent(method, path, got) || noRoute(got)) continue;
        if (blindServed && same(got, blind)) continue;
        // Another row's handler: one whose pattern takes this path (`:id`
        // reading `catalog`) or its head (`/api/run/:slug` reading `…/start`)
        // — and answers exactly as it does on its own path.
        const filled = segmentsOf(fill(path));
        let owner = false;
        for (const row of routeRows) {
          if (row.method !== method || row.path === path || row.stream || NEVER_PROBED.has(row.id)) continue;
          const pattern = segmentsOf(row.path!);
          if (pattern.length > filled.length) continue;
          if (!pattern.every((segment, i) => segment.startsWith(':') || segment === filled[i])) continue;
          if (same(await answer(method, row.path!, 'on'), got)) owner = true;
        }
        if (!owner) {
          say(
            `the router serves \`${method} ${path}\` (${got.status} ${clip(got.body)}), and no row of data/surface.ts names it — give it a row, or make the route refuse that method`,
          );
        }
      }
    }

    for (const row of probed) {
      const got = await answer(row.method!, row.path!, 'off');
      if (got.status !== 403) continue;
      const named = /--allow-[a-z-]+/.exec(got.body)?.[0];
      if (named && row.flag !== named) {
        say(
          `with every flag off the router refuses \`${row.id}\` for ${named}, and the row names ${row.flag ?? 'no flag'} — name ${named}`,
        );
      }
    }
  }

  return failures;
}

/* ------------------------------------------------------------------ *
 * The real tree
 * ------------------------------------------------------------------ */

const MANIFEST = JSON.parse(readRepo('free/manifest.json') ?? '{"proPaths":[]}') as { proPaths: string[] };
const isProPath = (rel: string): boolean =>
  MANIFEST.proPaths.some((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix));

function modules(dir: string, keep: (rel: string) => boolean): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(join(VIEWER, '..'), path).split(sep).join('/');
        if (keep(rel)) out.push({ rel, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

/** The data layer is not a page: a page is everything else under `client/src`. */
const NOT_A_PAGE = /^viewer\/client\/src\/(?:data\/|lib\/sse\.ts$)/;

function realTruth(): SurfaceTruth {
  const read = (rel: string): string | null => readRepo(rel);
  const presses = read('viewer/server/owner/presses.ts') ?? '';
  const live = read('viewer/client/src/data/live.ts') ?? '';
  const verbModel = read('viewer/shared/verb-model.js') ?? '';
  const capabilityModel = read('viewer/shared/capability-model.js') ?? '';
  const routeMeta = read('viewer/shared/route-meta.js') ?? '';
  const ratchet = JSON.parse(read('viewer/client/src/data/surface-ratchet.json') ?? '{}') as {
    unassigned: { free: number; pro?: number };
  };

  const settings = new Map<string, { free: boolean; from: string }>();
  const add = (prefix: string, keys: ReadonlyMap<string, boolean>, from: string): void => {
    for (const [key, free] of keys) settings.set(`setting ${prefix}${key}`, { free, from });
  };
  add(
    '',
    blockKeys(read('viewer/server/config.ts') ?? '', 'export type Prefs = {'),
    'server/config.ts `Prefs`',
  );
  add(
    'retention.',
    blockKeys(read('viewer/server/retention-policy.ts') ?? '', 'export type RetentionPolicy = {'),
    'the retention policy',
  );
  // A run field is free when the free build of `shared/run-settings.js` still names it — one
  // listed only inside a `!pro:` region (one-pool phase 7's `poolPolicy`) is Pro's.
  const runSettingsFree = freeText(read('viewer/shared/run-settings.js') ?? '');
  add(
    'run.',
    new Map([...new Set([...RUN_START_FIELDS, ...RUN_SETTINGS_FIELDS])].map((field) => [field, runSettingsFree.includes(`'${field}'`)])),
    "a run's fields (`RUN_START_FIELDS`, `RUN_SETTINGS_FIELDS`)",
  );
  add(
    'browser.',
    blockKeys(read('viewer/client/src/lib/prefs.ts') ?? '', 'export interface Prefs {'),
    "the browser's `Prefs`",
  );
  add('profile.', profileKeys(read('viewer/shared/instances.mjs') ?? ''), 'the machine profile');
  add(
    'flag ',
    new Map(CAPABILITY_WORDS.map((word) => [word.flag, freeLine(capabilityModel, `word('${word.flag}'`)])),
    'CAPABILITY_WORDS',
  );

  const heads = (() => {
    const start = routeMeta.indexOf('export const ROUTE_HEADS');
    const block = routeMeta.slice(start, routeMeta.indexOf(']);', start));
    const pro = proLines(routeMeta);
    const first = lineAt(routeMeta, start);
    const inPro = new Set<string>();
    block.split('\n').forEach((line, i) => {
      if (!pro.has(first + i)) return;
      for (const m of line.matchAll(/^\s*'([\w-]+)',/g)) inPro.add(m[1]!);
    });
    return inPro;
  })();

  return {
    rows: SURFACE,
    pro: PRO_TREE,
    routes: dispatcherRoutes(DISPATCHER),
    outside: pathRoutes(DISPATCHER),
    supervisor: PRO_TREE ? supervisorRoutes(read('viewer/fleet/index.ts') ?? '') : [],
    required: [
      ...stepVerbs(DISPATCHER).map((verb) => ({
        id: `POST /api/human-steps/:id/${verb}`,
        from: "the step branch's verbs",
      })),
      ...QUEUE_VERBS.map((verb) => ({ id: `POST /api/queue/${verb}`, from: 'QUEUE_VERBS' })),
      ...LANE_VERBS.map((verb) => ({ id: `POST /api/lane/${verb}`, from: 'LANE_VERBS' })),
      ...ownerPresses(presses).map(({ method, path, line }) => ({
        id: `${method} ${path}`,
        from: `owner/presses.ts:${line}`,
      })),
    ],
    verbs: OPERATOR_VERBS.map((row) => ({
      name: row.name,
      route: row.route,
      free: freeLine(verbModel, `verb('${row.name}'`),
    })),
    authority: AUTHORITY_ROUTES,
    authorityOf: (method, path) => authorityRouteOf(method, path),
    emitted: emittedEvents(
      modules(join(VIEWER, 'server'), (rel) => rel.endsWith('.ts')),
      isProPath,
    ),
    declared: declaredEvents(live),
    settings,
    flags: CAPABILITY_WORDS.map((word) => word.flag),
    heads: ROUTE_HEADS,
    proHeads: heads,
    places: SURFACE_PLACES,
    ratchet: ratchet.unassigned,
    read,
    isProPath,
    ui: modules(
      SRC,
      (rel) => /\.tsx?$/.test(rel) && !/\.test\.|\.d\.ts$/.test(rel) && !NOT_A_PAGE.test(rel),
    ).map(({ rel, text }) => ({
      name: rel.slice('viewer/client/src/'.length),
      text,
      free: isProPath(rel) ? '' : freeText(text),
    })),
    ask: (method, path, flags) =>
      Promise.race([
        probe(method, path, { flags: flags === 'on' ? FLAGS_ON : FLAGS_OFF }),
        new Promise<ProbeAnswer>((resolve) => {
          setTimeout(() => resolve({ status: -1, body: 'no answer in 15 s' }), 15_000).unref();
        }),
      ]),
  };
}

test('the truths are read: the dispatcher, the hooks, the word lists, the events and every store of a setting', () => {
  const routes = dispatcherRoutes(DISPATCHER);
  assert.ok(routes.size > 100, `only ${routes.size} routes parsed — the parse is not reading the dispatcher`);
  assert.deepEqual(
    pathRoutes(DISPATCHER)
      .map((route) => route.path)
      .sort(),
    [
      '/events',
      '/hooks/declaration',
      '/hooks/permission-request',
      '/hooks/pre-tool-use',
      '/hooks/session',
      '/hooks/stop',
    ],
    'the routes outside /api/ are the five hooks and the stream — teach pathRoutes the new shape',
  );
  for (const verb of ['check', 'grant', 'deny', 'convert'])
    assert.ok(stepVerbs(DISPATCHER).includes(verb), `the step verbs lost ${verb}`);
  const owner = ownerPresses(readRepo('viewer/server/owner/presses.ts') ?? '').map(
    ({ method, path }) => `${method} ${path}`,
  );
  for (const press of [
    'POST /api/owner/enroll/link',
    'POST /api/owner/assert/finish',
    'POST /api/owner/lock',
    'DELETE /api/owner/keys/:id',
  ]) {
    assert.ok(
      owner.includes(press),
      `the owner presses lost ${press} — the shape of presses.ts changed; teach ownerPresses`,
    );
  }
  assert.match(
    readRepo('viewer/server/runner/runner.ts') ?? '',
    /`run:\$\{event\}`/,
    "the runner's emit no longer prefixes run: — teach emittedEvents",
  );
  const truth = realTruth();
  if (PRO_TREE) {
    const answered = truth.supervisor.map(({ method, path }) => `${method} ${path}`);
    assert.ok(answered.length >= 30, `only ${answered.length} supervisor routes parsed — teach supervisorRoutes`);
    for (const route of [
      'GET /api/fleet/turn',
      'GET /api/fleet/health',
      'POST /api/fleet/supervisor-switch',
      'POST /api/fleet/push/categories',
      'POST /api/fleet/instances/:id/:verb',
      'DELETE /api/fleet/reach/pair-code/:code',
      'POST /api/fleet/reach/devices/:id/rename',
      'POST /api/approvals/:id',
    ]) {
      assert.ok(answered.includes(route), `the supervisor parse lost ${route} — teach supervisorRoutes the new shape`);
    }
  }
  assert.ok(
    truth.emitted.size >= 30,
    `only ${truth.emitted.size} events found emitted — teach emittedEvents the new shape`,
  );
  assert.ok(truth.declared.size >= truth.emitted.size, 'the stream declares every name the server emits');
  const retention = blockKeys(
    readRepo('viewer/server/retention-policy.ts') ?? '',
    'export type RetentionPolicy = {',
  );
  assert.deepEqual(
    [...retention.keys()].sort(),
    Object.keys(RETENTION_DEFAULTS).sort(),
    'the retention type and its defaults are one set',
  );
  assert.ok(truth.settings.size > 150, `only ${truth.settings.size} settings keys found`);
  assert.ok(truth.ui.length > 100, `only ${truth.ui.length} pages found`);
});

test('every route, event, setting and verb the server exposes has a row of data/surface.ts that is true — and nothing else does', async () => {
  const failures = await auditSurface(realTruth());
  assert.deepEqual(failures, []);
});

test("the free tree's registry is exactly the free rows: every Pro row sits in a !pro: region", async (t) => {
  if (!PRO_TREE) {
    t.skip('this IS the free tree — its registry was stripped already');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'surface-free-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const file = join(dir, 'surface.ts');
    writeFileSync(file, freeText(readFileSync(join(SRC, 'data', 'surface.ts'), 'utf8')));
    const { SURFACE: free } = (await import(pathToFileURL(file).href)) as { SURFACE: SurfaceRow[] };
    assert.deepEqual(
      free,
      SURFACE.filter((row) => row.edition === 'free'),
      'the stripped registry is the free rows, row for row',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The guard's teeth
 * ------------------------------------------------------------------ */

test('the guard has teeth: an orphan route, a doorless verb and a phantom door each fail by name, and their fix passes', async () => {
  const dispatcher = [
    '  const [head, ...rest] = segments;',
    "    if (head === 'state' && req.method === 'GET') {",
    "    if (head === 'widgets') {",
    '      const sub = rest[1];',
    "      if (sub === 'spin') {",
    "    if (head === 'orphan' && req.method === 'GET') {",
  ].join('\n');
  const files: Record<string, string> = {
    'scripts/widgets.sh': 'curl -X DELETE "http://127.0.0.1:4123/api/widgets"\n',
    'scripts/scrape.sh': 'curl -s http://127.0.0.1:4123/api/orphan\n',
    'viewer/client/src/data/console.ts': 'export function useConsoleState() {}\n',
    'viewer/client/src/data/widgets.ts': [
      'export const widgetsApi = {',
      "  list: () => request('/api/widgets'),",
      '  spin: (id: string) => post(`/api/widgets/${id}/spin`),',
      '};',
      'export function useWidgets() {}',
      '',
    ].join('\n'),
  };
  const page = 'export function Widgets() { useConsoleState(); widgetsApi.list(); widgetsApi.spin(id); }';
  const served: Record<string, number> = {
    'GET /api/state': 200,
    'GET /api/widgets': 200,
    'DELETE /api/widgets': 200,
    'POST /api/widgets/demo/spin': 500,
    'GET /api/orphan': 200,
  };
  const base = {
    pro: false,
    routes: dispatcherRoutes(dispatcher),
    outside: [],
    supervisor: [],
    required: [],
    verbs: [{ name: 'spin', route: 'POST /api/widgets/:id/spin', free: true }],
    authority: [],
    authorityOf: () => null,
    emitted: new Map([['tick', true]]),
    declared: new Map([['tick', true]]),
    settings: new Map([['setting dial', { free: true, from: 'the fixture' }]]),
    flags: ['--allow-run'],
    heads: ['runs', 'plans'],
    proHeads: new Set<string>(),
    places: SURFACE_PLACES,
    read: (rel: string) => files[rel] ?? null,
    isProPath: () => false,
    ui: [{ name: 'features/widgets.tsx', text: page, free: page }],
    ask: async (method: string, path: string) =>
      served[`${method} ${path}`] !== undefined
        ? { status: served[`${method} ${path}`]!, body: `{"error":"${method} ${path}"}` }
        : { status: 404, body: `{"error":"No API route for ${path}"}` },
  };
  const shell = { place: 'Shell', head: 'runs', section: 'header' } as const;
  const plans = { place: 'Plans', head: 'plans' } as const;
  const kept: SurfaceRow[] = [
    {
      kind: 'route',
      id: 'GET /api/state',
      method: 'GET',
      path: '/api/state',
      edition: 'free',
      door: shell,
      data: 'console#useConsoleState',
    },
    {
      kind: 'route',
      id: 'POST /api/widgets/:id/spin',
      method: 'POST',
      path: '/api/widgets/:id/spin',
      edition: 'free',
      door: plans,
      data: 'widgets#widgetsApi.spin',
    },
    {
      kind: 'sse',
      id: 'sse tick',
      event: 'tick',
      edition: 'free',
      door: shell,
      data: 'console#useConsoleState',
    },
    { kind: 'setting', id: 'setting dial', key: 'dial', edition: 'free', door: plans },
  ];

  // The broken registry: `orphan` and `DELETE /api/widgets` have no row, the
  // verb answers nothing, and the list's door is under no head and reaches an
  // export no page calls.
  const failures = await auditSurface({
    ...base,
    ratchet: { free: 0 },
    rows: [
      ...kept,
      {
        kind: 'route',
        id: 'GET /api/widgets',
        method: 'GET',
        path: '/api/widgets',
        edition: 'free',
        door: { place: 'Plans', head: 'gadgets' },
        data: 'widgets#useWidgets',
      },
      { kind: 'verb', id: 'verb spin', verb: 'spin', edition: 'free' },
    ],
  });
  const said = failures.join('\n');
  assert.match(
    said,
    /routes\.ts:\d+ answers `orphan`, and no row of data\/surface\.ts covers it/,
    'the orphan head, by name',
  );
  assert.match(said, /the router serves `DELETE \/api\/widgets` \(200/, 'the orphan method, by name');
  assert.match(said, /`verb spin` gives no answer/, 'the doorless verb, by name');
  assert.match(
    said,
    /`GET \/api\/widgets` has its door under the head `gadgets`, which ROUTE_HEADS does not have/,
    'the door under no head',
  );
  assert.match(
    said,
    /`GET \/api\/widgets` is a PHANTOM door: no page under client\/src in the free tree reaches `useWidgets`/,
    'the phantom door',
  );
  assert.equal(failures.length, 5, said);

  // Every route a row and the verb a door — but one row left for a later
  // phase, and two reasons with nothing behind them: one names no caller, one
  // names a file that never asks for the route. Since phase 26 each fails.
  const widgets: SurfaceRow = {
    kind: 'route',
    id: 'GET /api/widgets',
    method: 'GET',
    path: '/api/widgets',
    edition: 'free',
    door: plans,
    data: 'widgets#widgetsApi.list',
  };
  const spin: SurfaceRow = {
    kind: 'verb',
    id: 'verb spin',
    verb: 'spin',
    edition: 'free',
    door: plans,
    data: 'widgets#widgetsApi.spin',
  };
  const deleting = { kind: 'route', id: 'DELETE /api/widgets', method: 'DELETE', path: '/api/widgets', edition: 'free' } as const;
  const orphan = { kind: 'route', id: 'GET /api/orphan', method: 'GET', path: '/api/orphan', edition: 'free' } as const;
  const owed = await auditSurface({
    ...base,
    ratchet: { free: 0 },
    rows: [
      ...kept,
      widgets,
      spin,
      { ...deleting, unassigned: 'phase 9' },
      { ...orphan, exempt: 'a script reads it' },
    ],
  });
  const owing = owed.join('\n');
  assert.match(owing, /`DELETE \/api\/widgets` is left for "phase 9" — nothing is left for later/, 'the unassigned row, by name');
  assert.match(owing, /1 free rows are unassigned, and surface-ratchet\.json holds 0/, 'the ratchet, at zero');
  assert.match(owing, /`GET \/api\/orphan` is exempt and names no caller/, 'the reason with no caller, by name');
  assert.equal(owed.length, 3, owing);

  const untrue = await auditSurface({
    ...base,
    ratchet: { free: 0 },
    rows: [
      ...kept,
      widgets,
      spin,
      { ...deleting, exempt: 'a script deletes them', caller: 'scripts/widgets.sh' },
      { ...orphan, exempt: 'a script reads it', caller: 'scripts/widgets.sh' },
    ],
  });
  assert.match(
    untrue.join('\n'),
    /`GET \/api\/orphan` is exempt by scripts\/widgets\.sh, which never names \/api\/orphan/,
    'the reason whose caller never asks for it, by name',
  );
  assert.equal(untrue.length, 1, untrue.join('\n'));

  // …and fixed: every route a row, the verb a door, the list a real page's,
  // and each reason backed by the file that really reaches the route.
  const clean = await auditSurface({
    ...base,
    ratchet: { free: 0 },
    rows: [
      ...kept,
      widgets,
      spin,
      { ...deleting, exempt: 'a script deletes them', caller: 'scripts/widgets.sh' },
      { ...orphan, exempt: 'a script reads it', caller: 'scripts/scrape.sh' },
    ],
  });
  assert.deepEqual(clean, []);
});

test("the guard has teeth: a route's option the export never spells, or no page sets, fails by name; spelled on both it passes", async () => {
  const dispatcher = ['  const [head, ...rest] = segments;', "    if (head === 'level') {"].join('\n');
  const data = (body: string): Record<string, string> => ({
    'viewer/client/src/data/level.ts': [
      'export function useLevelWrite() {',
      '  return {',
      `    setLevel: (next: { ${body} }) => post('/api/level', next),`,
      '  };',
      '}',
      '',
    ].join('\n'),
  });
  const audit = (files: Record<string, string>, page: string) =>
    auditSurface({
      rows: [
        {
          kind: 'route',
          id: 'POST /api/level',
          method: 'POST',
          path: '/api/level',
          edition: 'free',
          door: { place: 'Logs', head: 'logs', section: 'logs' },
          data: 'level#useLevelWrite.setLevel',
          options: ['level', 'debug'],
        },
      ],
      pro: false,
      routes: dispatcherRoutes(dispatcher),
      outside: [],
      supervisor: [],
      required: [],
      verbs: [],
      authority: [],
      authorityOf: () => null,
      emitted: new Map(),
      declared: new Map(),
      settings: new Map(),
      flags: [],
      heads: ['logs'],
      proHeads: new Set<string>(),
      places: SURFACE_PLACES,
      ratchet: { free: 0 },
      read: (rel: string) => files[rel] ?? null,
      isProPath: () => false,
      ui: [{ name: 'screens/logs/level.tsx', text: page, free: page }],
      });

  // The export takes no `debug`, and the page sets only the level: two partial options.
  const partial = await audit(data('level: string'), 'write.setLevel({ level });');
  const said = partial.join('\n');
  assert.match(said, /`POST \/api\/level` names the option `debug`, which `useLevelWrite` never spells/);
  assert.equal(partial.length, 1, said);
  const unset = await audit(data('level: string; debug: string'), 'write.setLevel({ level });');
  assert.match(
    unset.join('\n'),
    /`POST \/api\/level` names the option `debug`, which no page that reaches `setLevel` spells/,
  );
  assert.equal(unset.length, 1, unset.join('\n'));
  // …and fixed: the export sends it and the page sets it.
  assert.deepEqual(
    await audit(data('level: string; debug: string'), 'write.setLevel({ level, debug: channels });'),
    [],
  );
});
