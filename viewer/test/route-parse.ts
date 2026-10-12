/**
 * The dispatcher read as text, and the client's requests read as text — the
 * parse `route-coverage.test.ts` and `surface-parity.test.ts` share.
 *
 * It derives the routes the way the dispatcher itself branches:
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
 * under `client/src/data/` — the one place a view's requests are written —
 * with every `${…}` read as a parameter.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = join(VIEWER, '..');

/** Every route the dispatcher text branches on, with the line that first names it. */
export function routesOf(source: string): Map<string, number> {
  const found = new Map<string, number>();
  walkRoutes(source, (key, line) => {
    if (!found.has(key)) found.set(key, line);
  });
  return found;
}

/**
 * The same routes with EVERY line that names each — a head opened in a Pro
 * region and again outside one is a route of both trees, which the first line
 * alone cannot say.
 */
export function routeLinesOf(source: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  walkRoutes(source, (key, line) => {
    const lines = found.get(key) ?? [];
    if (!lines.includes(line)) lines.push(line);
    found.set(key, lines);
  });
  return found;
}

/** The parse itself: every (route, line) the dispatcher text branches on, in order. */
function walkRoutes(source: string, add: (key: string, line: number) => void): void {
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
}

export interface Caller {
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
export function mentions(text: string, route: string): boolean {
  const [head, verb] = route.split('/');
  if (!text.includes(`/api/${head}`) && !text.includes(`'${head}'`)) return false;
  return !verb || new RegExp(`[/'"\`]${verb}[/'"\`]`).test(text);
}


/** Every non-test module under a directory, recursively, as `{name, text}` with a path relative to `client/src`. */
function modulesUnder(dir: string, out: { name: string; text: string }[] = []): { name: string; text: string }[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) modulesUnder(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
      out.push({ name: relative(join(VIEWER, 'client', 'src'), path), text: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

/**
 * Where the client writes its requests: `data/`, and nowhere else. Not
 * `data/surface.ts`: the registry spells every route the server has, which is
 * a claim ABOUT callers and never a caller itself — read as one, it would make
 * every route reached.
 */
export function clientCallerFiles(): { name: string; text: string }[] {
  return modulesUnder(join(VIEWER, 'client', 'src', 'data')).filter(
    (file) => file.name !== join('data', 'surface.ts'),
  );
}

/** A repository-relative file's text, or `null` when there is none. */
export function readRepo(rel: string): string | null {
  const path = join(REPO, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** The dispatcher's source. */
export const DISPATCHER = readFileSync(join(VIEWER, 'server', 'api', 'routes.ts'), 'utf8');
