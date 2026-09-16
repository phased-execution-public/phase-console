/**
 * Every halt kind a WRITER under `server/` names — the scan LFC-1 asked the
 * two parity walks to run over, instead of over `HALT_KINDS` itself.
 *
 * Iterating the vocabulary proves the vocabulary is consistent with itself and
 * nothing more: `plan-deadlocked` was written by the drive loop for weeks
 * while both walks passed, because both walks read the list the word was
 * missing from. Reading the WRITERS closes that hole — a kind the source
 * writes and the list lacks is the finding, and it fails here by name.
 *
 * Two shapes are read, which between them are every writer the census found:
 *
 *   1. a call — `this.halt(reason, phase, 'kind')`, `park(…, 'kind')`,
 *      `settlePhase(phase, reason, 'kind')` — whose LAST argument is a
 *      single-quoted literal (a variable there is a kind decided elsewhere,
 *      and the compiler holds it to `HaltKind`);
 *   2. an object — `state.halt = { … kind: 'kind' … }`, `??=` included — read
 *      to its matching brace, spread ternaries and all, which is exactly the
 *      shape the loop's park used to build with `{}` on one arm.
 *
 * The derived `HaltKind` type now makes an unlisted literal a compile error
 * as well; this scan is the belt to that brace, and the one that names the
 * file and line.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

export type HaltKindSite = { file: string; line: number; shape: 'call' | 'object' };

/** Skip a string literal starting at `i` (which points at its opening quote); returns the index after it. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  if (quote === '`') {
    // A template literal may nest `${ … }` with strings of its own inside.
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '`') return j + 1;
      if (text[j] === '$' && text[j + 1] === '{') {
        j = skipBalanced(text, j + 1, '{', '}');
        continue;
      }
      j++;
    }
    return j;
  }
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote || text[j] === '\n') return j + 1;
    j++;
  }
  return j;
}

/** From `i` (pointing at `open`), the index just past the matching `close`, strings and nested brackets honoured. */
function skipBalanced(text: string, i: number, open: string, close: string): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\'' || ch === '"' || ch === '`') { j = skipString(text, j); continue; }
    if (ch === '/' && text[j + 1] === '/') { j = text.indexOf('\n', j); if (j < 0) return text.length; continue; }
    if (ch === '/' && text[j + 1] === '*') { j = text.indexOf('*/', j); if (j < 0) return text.length; j += 2; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return j;
}

/** The top-level, comma-separated arguments of the call whose `(` is at `open`. */
function callArgs(text: string, open: number): { args: string[]; end: number } {
  const end = skipBalanced(text, open, '(', ')');
  const inner = text.slice(open + 1, end - 1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (ch === '\'' || ch === '"' || ch === '`') { j = skipString(inner, j) - 1; continue; }
    if (ch === '/' && inner[j + 1] === '/') { const nl = inner.indexOf('\n', j); j = nl < 0 ? inner.length : nl; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { args.push(inner.slice(start, j)); start = j + 1; }
  }
  const tail = inner.slice(start);
  if (tail.trim()) args.push(tail);
  return { args, end };
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));

/** The value expression that starts at `from` — up to the next `,` or `}` at depth 0, strings honoured. */
export function kindExpression(text: string, from: number): string {
  let depth = 0;
  let j = from;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\'' || ch === '"' || ch === '`') { j = skipString(text, j); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
    else if (ch === ',' && depth === 0) break;
    j++;
  }
  return text.slice(from, j);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

/** kind → every place under `server/` that writes it as a literal. */
export function haltKindLiterals(): Map<string, HaltKindSite[]> {
  const out = new Map<string, HaltKindSite[]>();
  const add = (kind: string, site: HaltKindSite): void => {
    const sites = out.get(kind) ?? [];
    sites.push(site);
    out.set(kind, sites);
  };
  for (const full of tsFiles(SERVER)) {
    const file = relative(SERVER, full).split('\\').join('/');
    const text = stripComments(readFileSync(full, 'utf8'));

    // Shape 1 — the call. `\b` keeps `this.halt(` and `?.park(` and refuses
    // `haltSignal(`; a declaration (`halt(reason: string, …)`) has no literal
    // last argument and falls out by itself.
    for (const m of text.matchAll(/\b(?:halt|park|settlePhase)\(/g)) {
      const open = m.index! + m[0].length - 1;
      const { args } = callArgs(text, open);
      const last = args[args.length - 1]?.trim() ?? '';
      const lit = /^'([a-z][a-z0-9-]*)'$/.exec(last);
      if (lit) add(lit[1], { file, line: lineOf(text, m.index!), shape: 'call' });
    }

    // Shape 2 — the object. Every literal in a `kind:` EXPRESSION inside the
    // braces counts — a bare literal, or every arm of a ternary
    // (`kind: phase === undefined ? 'interrupted-by-restart' : 'orphaned-session'`),
    // however many spreads build the object.
    for (const m of text.matchAll(/\b(?:state|record|this\.state)\.halt\s*(?:\?\?)?=\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const end = skipBalanced(text, open, '{', '}');
      const body = text.slice(open, end);
      for (const k of body.matchAll(/\bkind:\s*/g)) {
        for (const lit of kindExpression(body, k.index! + k[0].length).matchAll(/'([a-z][a-z0-9-]*)'/g)) {
          add(lit[1], { file, line: lineOf(text, open + k.index!), shape: 'object' });
        }
      }
    }
  }
  return out;
}
