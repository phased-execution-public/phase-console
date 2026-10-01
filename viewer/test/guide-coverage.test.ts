/**
 * The guide, asserted against the code it describes.
 *
 * `client/src/app/help/sheet.test.tsx` already pins the registry's totality
 * in both directions — a section with no content, or content with no route.
 * What it cannot see is whether the prose still matches the machine, and that is
 * the failure mode that actually happened: the permissions page said an agent
 * session is built "never with the bypass mode" for as long as it took someone
 * to add a QA review that uses exactly that.
 *
 * So the properties here are the ones a code change can silently falsify:
 * every notification category a person can be sent is a category the guide
 * names, and every section id in the frozen vocabulary is a file that exists on
 * disk with something in it. Prose is not asserted — only the identifiers that
 * would have to change anyway.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CATEGORIES } from '../server/push/catalogue.ts';
import { DESTINATIONS, GUIDE_SECTIONS } from '../shared/route-meta.js';

const guideDir = fileURLToPath(new URL('../client/src/content/guide/', import.meta.url));
const read = (name: string) => readFileSync(`${guideDir}${name}.md`, 'utf8');
const viewerFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** The `## ` headings of a guide body, fences stripped — the cards `app/help/split.ts` cuts. */
const cards = (body: string): string[] =>
  body
    .replace(/^```[\s\S]*?^```/gm, '')
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());

test('every frozen guide section is a markdown file with real content', () => {
  for (const id of GUIDE_SECTIONS) {
    assert.ok(existsSync(`${guideDir}${id}.md`), `${id}.md is missing`);
    const body = read(id);
    // `?raw` on a deleted file is '' and renders a blank tab rather than failing.
    assert.ok(body.length > 400, `${id}.md is a stub (${body.length} bytes)`);
    assert.match(body, /^##? /m, `${id}.md has no heading`);
  }
});

test('the guide names every notification category a person can be sent', () => {
  const body = read('notifications');
  for (const category of CATEGORIES) {
    assert.ok(
      body.includes(category.label),
      `the guide never mentions "${category.label}" — adding a category is two edits, and this is the second`,
    );
  }
});

test('the guide documents the off switch, recovery and reviews by the names they really have', () => {
  const body = read('sessions');
  // Identifiers, not phrasing: each is a thing that would have to be renamed in
  // the code before this assertion could become wrong for a good reason.
  const needles = ['claude --resume', 'qa-record.sh', 'Restart'];
  for (const needle of needles) {
    assert.ok(body.includes(needle), `the sessions guide never mentions ${needle}`);
  }
});

test('nothing claims an agent session can never bypass — QA reviews can', () => {
  // The exact rot this file exists to catch, pinned as a regression.
  const permissions = read('permissions');
  assert.ok(
    !/never the bypass mode/.test(permissions),
    'permissions.md still carries the pre-QA claim that bypass is unreachable from an agent session',
  );
  assert.match(permissions, /permissionProfile/);
});

/* ------------------------------------------------------------------ *
 * The Persian dimension (control-tower phase 32)
 *
 * Every section has a twin, `<id>.fa.md`, beside its English body. The console does not render
 * them — there is no language switch — so nothing but this file notices a twin that is missing,
 * empty, or not Persian at all. `docs-parity.test.ts` holds each pair section for section.
 * ------------------------------------------------------------------ */

test('every guide section has a Persian twin with real content', () => {
  for (const id of GUIDE_SECTIONS) {
    const file = `${guideDir}${id}.fa.md`;
    assert.ok(existsSync(file), `${id}.fa.md is missing — a section added in English is added in Persian too`);
    const body = readFileSync(file, 'utf8');
    assert.ok(body.length > 400, `${id}.fa.md is a stub (${body.length} bytes)`);
    assert.match(body, /^##? /m, `${id}.fa.md has no heading`);
    assert.match(body, /[؀-ۿ]{3}/, `${id}.fa.md has no Persian in it`);
    // The house frame (viewer/README.fa.md): the whole body right-to-left — after the header comment a
    // Pro-only file opens with, which is a comment line like any other.
    const lines = body.split('\n').filter((l) => l.trim() !== '' && !/^<!--.*-->$/.test(l.trim()));
    assert.equal(lines[0], '<div dir="rtl">', `${id}.fa.md does not open with <div dir="rtl">`);
    assert.equal(lines.at(-1), '</div>', `${id}.fa.md does not close its rtl <div>`);
  }
});


test('no guide file, in either language, is outside the section list', () => {
  const ids = new Set<string>(GUIDE_SECTIONS);
  for (const file of readdirSync(guideDir).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/(\.fa)?\.md$/, '');
    assert.ok(ids.has(id), `${file} belongs to no GUIDE_SECTIONS id — register it or delete it`);
  }
});

/* ------------------------------------------------------------------ *
 * Every 6.0 destination and overlay has a guide body
 * ------------------------------------------------------------------ */

/** The rail's labels, read from the one list the rail, the tab bar and the palette all draw. */
const NAV_LABELS: ReadonlyMap<string, string> = new Map(
  [...viewerFile('client/src/app/shell/nav.ts').matchAll(/id: '([a-z-]+)',(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*label: '([^']+)'/g)].map(
    (m) => [m[1], m[2]] as const,
  ),
);

test('every destination has its card in Getting around, headed by its rail label', () => {
  const headings = cards(read('destinations'));
  for (const id of DESTINATIONS) {
    const label = NAV_LABELS.get(id);
    assert.ok(label, `no rail label for destination '${id}' in client/src/app/shell/nav.ts`);
    assert.ok(
      headings.some((h) => h.startsWith(`${label} `) || h === label),
      `destinations.md has no card headed "${label} — …" — a page a person can reach is a page the guide explains`,
    );
  }
});

test('every overlay the real-browser tour opens has its card in Getting around', () => {
  // The tour's own list (`e2e/lib/shots.ts`) — an overlay added to the tour is an overlay a person meets.
  const tour = [...viewerFile('e2e/lib/shots.ts').matchAll(/overlay: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(tour.length >= 3, `expected the tour's overlays, found [${tour}]`);
  const LABEL: Record<string, string> = { palette: 'Palette', help: 'Help', bell: 'Bell' };
  const headings = cards(read('destinations'));
  const needles = tour.map((o) => {
    assert.ok(LABEL[o], `overlay '${o}' has no guide label here — name it, and give it a card`);
    return LABEL[o];
  });
  for (const needle of needles) {
    assert.ok(headings.some((h) => h.startsWith(needle)), `destinations.md has no card for the ${needle} overlay`);
  }
});

test('the Tower, halts, quick start and a person\'s turn each have a section of their own', () => {
  // The four things 6.0 asks a person to understand first (control-tower phase 32's exit criterion 2).
  const own = ['quick-start', 'tower', 'halts', 'your-turn'];
  for (const id of own) assert.ok(GUIDE_SECTIONS.includes(id), `GUIDE_SECTIONS has no '${id}'`);
});
