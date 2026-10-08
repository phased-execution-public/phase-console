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

/* ------------------------------------------------------------------ *
 * Your turn, and the permissions it answers (control-tower phase 140)
 *
 * The seventh amendment's words a person reads, held to the code that draws them: the page's
 * groups, the reasons, the check's label, the scopes a grant is given at, the never list and the
 * owner key's honest sentence. Identifiers only — the prose around them is free to change.
 * ------------------------------------------------------------------ */

/** One `## ` section of a guide body, heading to the next heading. */
const sectionOf = (body: string, heading: string): string => {
  const start = body.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `the guide has a section "## ${heading}"`);
  const next = body.indexOf('\n## ', start + 4);
  return body.slice(start, next < 0 ? undefined : next);
};

/** Prose with its emphasis and line breaks folded away, so a sentence reads the same wrapped or not. */
const flat = (text: string): string => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

test('the Your turn guide names the page, its groups, every reason, and the check by the words the page draws', async () => {
  const { TURN_GROUP_LABEL, REASON_META, WHY_PERSON } = await import('../shared/turn-model.js');
  const body = read('your-turn');
  const text = flat(body);
  assert.ok(body.includes('`#/turn`'), 'your-turn.md names the page by its address');
  for (const label of Object.values(TURN_GROUP_LABEL)) assert.ok(text.includes(label), `your-turn.md names the group "${label}"`);
  const handled = /handled: '([^']+)'/.exec(viewerFile('client/src/features/turn/page-model.ts'))?.[1];
  assert.equal(handled, 'Handled by the AI', "the page's sixth section is the handled log");
  assert.ok(text.includes(handled), 'your-turn.md names the handled log');
  for (const why of WHY_PERSON) {
    const label = REASON_META[why].label;
    assert.ok(text.includes(label), `your-turn.md names the reason "${label}" (${why})`);
  }
  const check = /CHECK_LABEL = "([^"]+)"/.exec(viewerFile('client/src/components/human-step-words.ts'))?.[1];
  assert.ok(check, 'the check has one label');
  assert.ok(text.includes(check), `your-turn.md names the check as "${check}"`);
  for (const words of ['Back to you', 'Accept anyway', 'Not doing this']) {
    assert.ok(text.includes(words), `your-turn.md names "${words}"`);
  }
  // Phase 133: the console never takes a secret — the card says where the value goes.
  assert.doesNotMatch(text, /typed once into the card's form/, 'your-turn.md still says a secret is typed into the card');
});

test('the permissions guide says what a grant is — its scopes, its tiers, the never list and the three publishing asks', async () => {
  const { RISK_TIERS, HOST_COMMANDS, GRANT_SCOPES } = await import('../shared/turn-model.js');
  const { OPEN_PR_ASK, PUBLISH_ASK } = await import('../server/runner/approvals.ts');
  const body = read('permissions');
  // OD-16: the wall a person CAN lower, by a grant — never "nothing can approve past these".
  assert.doesNotMatch(body, /Nothing can approve past these/, 'permissions.md still promises a wall the product offers to lower');
  const wall = flat(sectionOf(body, 'The deny list holds'));
  assert.match(wall, /grant/, '§The deny list holds says what a grant is');
  assert.match(wall, /never list/, '§The deny list holds says the never list has no grant');
  // The publishing asks auto-grant never answers: every rule the code holds back, by its command.
  const asks = [...new Set([...OPEN_PR_ASK, ...PUBLISH_ASK])].map((rule) => /^Bash\((.+):\*\)$/.exec(rule)![1]);
  assert.equal(asks.length, 3, `the code holds back three publishing asks, found [${asks}]`);
  const auto = sectionOf(body, 'Auto-grant approvals');
  for (const command of asks) assert.ok(auto.includes(`\`${command}\``), `§Auto-grant approvals names \`${command}\``);
  assert.match(flat(auto), /three publishing asks/, '§Auto-grant approvals counts the publishing asks');
  // The scopes, by the labels the permission card draws, and the tiers.
  const card = viewerFile('client/src/features/turn/permission-card.tsx');
  const grants = flat(sectionOf(body, 'Grants'));
  for (const scope of GRANT_SCOPES) {
    const label = new RegExp(`\\b${scope}: '([^']+)'`).exec(card)?.[1];
    assert.ok(label, `permission-card.tsx labels the scope ${scope}`);
    assert.ok(grants.includes(label), `§Grants names the scope "${label}"`);
  }
  for (const tier of RISK_TIERS) assert.match(grants, new RegExp(`\\b${tier}\\b`), `§Grants names the risk tier ${tier}`);
  const never = sectionOf(body, 'The never list');
  for (const command of HOST_COMMANDS) assert.ok(never.includes(`\`${command}\``), `§The never list names \`${command}\``);
});

test("the owner key's section ends with the residual risk, in §Architecture 19's words", () => {
  const sentence =
    "a process running as you that deliberately rewrites the console's own files can forge anything below the owner key, " +
    'and can replace the key registry itself; the console walls the paths a session takes and makes every grant visible, ' +
    'and it is not a boundary against your own account.';
  const owner = sectionOf(read('permissions'), 'The owner key');
  const paragraphs = owner.split(/\n\s*\n/).map(flat).filter(Boolean);
  assert.ok(paragraphs.at(-1)!.includes(sentence), `§The owner key's last paragraph is the residual-risk sentence:\n  ${paragraphs.at(-1)}`);
});

test('the Tower, halts, quick start and a person\'s turn each have a section of their own', () => {
  // The four things 6.0 asks a person to understand first (control-tower phase 32's exit criterion 2).
  const own = ['quick-start', 'tower', 'halts', 'your-turn'];
  for (const id of own) assert.ok(GUIDE_SECTIONS.includes(id), `GUIDE_SECTIONS has no '${id}'`);
});
