/**
 * One wire (measured-console phase 32, §Architecture 10): `shared/wire/` is
 * the ONE source of the HTTP surface's types, imported by server and client.
 *
 *   WP-1 every route `client/src/data/surface.ts` lists has a wire type, and
 *        every route a wire family names is a route there — one family each;
 *   WP-2 every name a family's `WIRE_ROUTES` gives is a typedef in
 *        `shared/wire/`, a typedef's name is unique there, and every typedef
 *        is reached from some route's response or body — no orphan shape;
 *   WP-3 `client/src/data/api/` declares no type of its own: each file there
 *        imports its shapes from `@shared/wire/` and keeps only its fetches;
 *   WP-4 the server's handlers are typed by them: every family is imported
 *        (`import type`) by the server module that answers its routes, and
 *        each name it imports is used there;
 *   WP-5 the reader has teeth — a fixture with an orphan, a missing route and
 *        a hand-written client type fails on each.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SURFACE } from '../client/src/data/surface.ts';

const VIEWER = join(import.meta.dirname, '..');
const WIRE = join(VIEWER, 'shared', 'wire');
const CLIENT_API = join(VIEWER, 'client', 'src', 'data', 'api');
// The fleet supervisor is Pro's: a free tree has no viewer/fleet/ to read.
const SERVER_ROOTS = [join(VIEWER, 'server'), join(VIEWER, 'fleet')].filter((dir) => existsSync(dir));

interface WireRoute {
  response: string;
  body?: string;
}

/** Every `@typedef {…} Name` in a source, with the text of its declaration (to the next typedef or the comment's end). */
export function typedefsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of src.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const text = block[1].replace(/^[ \t]*\* ?/gm, '');
    let at = text.indexOf('@typedef');
    while (at >= 0) {
      const open = text.indexOf('{', at);
      let depth = 0;
      let close = open;
      for (; close < text.length; close += 1) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}' && --depth === 0) break;
      }
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(text.slice(close + 1))?.[1];
      const next = text.indexOf('@typedef', close);
      if (name) out.set(name, text.slice(open, next < 0 ? text.length : next));
      at = next;
    }
  }
  return out;
}

/** The sentences that say where the wire and its two sides disagree — empty is the only pass. */
export function auditWire(input: {
  routes: readonly string[];
  families: ReadonlyMap<string, { src: string; routes: Readonly<Record<string, WireRoute>> }>;
  clientFiles: ReadonlyMap<string, string>;
  serverFiles: ReadonlyMap<string, string>;
}): string[] {
  const say: string[] = [];
  const owner = new Map<string, string>();
  const declared = new Map<string, { family: string; body: string }>();
  for (const [family, { src, routes }] of input.families) {
    for (const [name, body] of typedefsOf(src)) {
      const twin = declared.get(name);
      if (twin) say.push(`typedef ${name} is declared in both ${twin.family}.js and ${family}.js — one name, one place`);
      else declared.set(name, { family, body });
    }
    if (family !== 'common' && Object.keys(routes).length === 0) say.push(`${family}.js names no route — a family is the routes it owns`);
    if (family === 'common' && Object.keys(routes).length) say.push('common.js owns no route: its shapes are the families\'');
    for (const id of Object.keys(routes)) {
      const first = owner.get(id);
      if (first) say.push(`route \`${id}\` is in both ${first}.js and ${family}.js`);
      else owner.set(id, family);
    }
  }
  const surface = new Set(input.routes);
  for (const id of surface) if (!owner.has(id)) say.push(`route \`${id}\` has no wire type — name it in its family's WIRE_ROUTES`);
  for (const [id, family] of owner) if (!surface.has(id)) say.push(`${family}.js names \`${id}\`, which data/surface.ts does not list`);

  // WP-2: every name a route gives is declared, and every declaration is reached.
  const reached = new Set<string>();
  const visit = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const token of declared.get(name)?.body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (declared.has(token)) visit(token);
    }
  };
  for (const [family, { routes }] of input.families) {
    for (const [id, wire] of Object.entries(routes)) {
      for (const name of [wire.response, wire.body]) {
        if (name === undefined) continue;
        if (!declared.has(name)) say.push(`${family}.js gives \`${id}\` the type ${name}, which no typedef in shared/wire declares`);
        else visit(name);
      }
    }
  }
  for (const [name, { family }] of declared) {
    if (!reached.has(name)) say.push(`typedef ${name} (${family}.js) is no route's — reach it from a response or a body, or delete it`);
  }

  // WP-3: the client's fetches declare nothing of their own.
  for (const [file, src] of input.clientFiles) {
    const own = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+[A-Za-z_$]|type\s+[A-Za-z_$][\w$]*\s*[<=])/m.exec(src);
    if (own) say.push(`client/src/data/api/${file} declares \`${own[0].trim()}\` — its shapes live in shared/wire/`);
    if (!/from '@shared\/wire\/[\w-]+\.js'/.test(src)) say.push(`client/src/data/api/${file} imports nothing from @shared/wire/`);
  }

  // WP-4: each family is imported by the server, and what it imports is used.
  for (const family of input.families.keys()) {
    if (family === 'common') continue;
    let typed = false;
    for (const [file, src] of input.serverFiles) {
      const re = new RegExp(String.raw`import\s+type\s*\{([^}]*)\}\s*from\s*'[./]*(?:\.\./)*shared/wire/${family}\.js'`, 'g');
      for (const m of src.matchAll(re)) {
        typed = true;
        const rest = src.slice(0, m.index) + src.slice(m.index + m[0].length);
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/).pop();
          if (name && !new RegExp(String.raw`\b${name}\b`).test(rest)) say.push(`${file} imports ${name} from wire/${family}.js and types nothing with it`);
        }
      }
    }
    if (!typed) say.push(`no server module imports a type from shared/wire/${family}.js — type the handlers that answer its routes`);
  }
  return say;
}

function walk(dir: string, keep: (file: string) => boolean, out: Map<string, string> = new Map(), root = dir): Map<string, string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out, root);
    else if (keep(path)) out.set(relative(VIEWER, path), readFileSync(path, 'utf8'));
  }
  return out;
}

async function readWire() {
  const families = new Map<string, { src: string; routes: Record<string, WireRoute> }>();
  for (const name of readdirSync(WIRE).filter((n) => n.endsWith('.js')).sort()) {
    const path = join(WIRE, name);
    const mod = (await import(pathToFileURL(path).href)) as { WIRE_ROUTES?: Record<string, WireRoute> };
    families.set(name.replace(/\.js$/, ''), { src: readFileSync(path, 'utf8'), routes: mod.WIRE_ROUTES ?? {} });
  }
  const clientFiles = new Map<string, string>();
  for (const name of readdirSync(CLIENT_API).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    clientFiles.set(name, readFileSync(join(CLIENT_API, name), 'utf8'));
  }
  const serverFiles = new Map<string, string>();
  for (const root of SERVER_ROOTS) walk(root, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'), serverFiles);
  return { families, clientFiles, serverFiles };
}

const surfaceRoutes = () => SURFACE.filter((row) => row.kind === 'route').map((row) => row.id);

test('WP-1…WP-4 every route has one wire type both sides import, and the client declares none of its own', async () => {
  const wire = await readWire();
  assert.ok(wire.families.size > 1, 'shared/wire/ holds the families');
  const said = auditWire({ routes: surfaceRoutes(), ...wire });
  assert.deepEqual(said, [], `\n${said.join('\n')}`);
});

test('WP-5 the audit has teeth', () => {
  const families = new Map<string, { src: string; routes: Record<string, WireRoute> }>([
    ['common', { src: '/** @typedef {{ ok: true }} WireOk */', routes: {} }],
    [
      'demo',
      {
        src: '/**\n * @typedef {object} DemoBody\n * @property {WireOk} ack\n */\n/** @typedef {string} Orphan */',
        routes: { 'GET /api/demo': { response: 'DemoBody' }, 'GET /api/ghost': { response: 'Missing' } },
      },
    ],
  ]);
  const said = auditWire({
    routes: ['GET /api/demo', 'GET /api/other'],
    families,
    clientFiles: new Map([['demo.ts', 'export interface Mine { a: string }\n']]),
    serverFiles: new Map([['server/demo.ts', "import type { DemoBody } from '../shared/wire/demo.js';\n"]]),
  });
  const has = (part: string) => assert.ok(said.some((s) => s.includes(part)), `expected a sentence with ${part}:\n${said.join('\n')}`);
  has('`GET /api/other` has no wire type');
  has('names `GET /api/ghost`, which data/surface.ts does not list');
  has('the type Missing');
  has('typedef Orphan');
  has('declares `export interface M');
  has('imports nothing from @shared/wire/');
  has('imports DemoBody from wire/demo.js and types nothing with it');
  assert.ok(!said.some((s) => s.includes('typedef WireOk')), 'a shape reached through another is reached');
});
