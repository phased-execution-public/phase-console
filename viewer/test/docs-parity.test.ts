/**
 * The docs, asserted against the code and against each other.
 *
 * Phase 11 of console-audit-hardening closed seventeen doc-drift findings. Every
 * one of them was the same failure with a different subject: a sentence that was
 * true when it was written, about a thing that later changed, on a surface no
 * gate reads. `guide-coverage.test.ts` already pins the guide's identifiers
 * against the vocabularies; this file pins the four classes it does not reach.
 *
 *   1. EN <-> FA sibling parity. Three docs ship a Persian mirror, and all three
 *      had silently fallen behind — four missing subsections, two missing flags,
 *      a missing lead image. Titles are translated, so the assertion is on
 *      STRUCTURE (heading counts per level) and on the tokens that must survive
 *      translation verbatim: flags and image URLs.
 *   2. Catalogue row-counts. docs/phone.md presented nine push categories as the
 *      complete set while fourteen shipped.
 *   3. Guide claims vs the machine. "All five capability switches" outlived the
 *      sixth by months, in the one file an operator reads to decide what to turn
 *      on.
 *   4. Repo paths that no longer resolve. The 3.0 redesign deleted
 *      `client/src/views/**` and four docs kept citing it.
 *
 * WHAT THIS DOES NOT CHECK, so feature phases know what stays hand-maintained:
 * prose meaning (only identifiers and counts), whether a translation is a GOOD
 * translation (only that the structure and the untranslatable tokens match),
 * whether a doc's claim about behaviour is true when nothing names the behaviour
 * in code, and any doc outside `docs/`, `references/`, the three EN/FA pairs and
 * the guide.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them. This
// file imports `server/push/catalogue.ts`, and `state-isolation.test.ts` holds
// every such file to redirecting FIRST — static imports evaluate in source
// order, so a redirect below a server import runs after the damage.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES } from '../server/push/catalogue.ts';
import { PUSH_ACTION_VERBS } from '../server/push/actions.ts';
import { REVIEW_VERDICTS, isReviewVerdict } from '../server/review.ts';
import { METRIC_FAMILIES, PHASE_STATES } from '../server/analysis/metrics.ts';
import { BAR_KINDS, MARK_KINDS } from '../server/analysis/timeline.ts';
import { MANIFEST, PATCH_DIR } from '../server/landing.ts';
import { sanitiseSchedule } from '../shared/schedule-policy.js';
import {
  WEBHOOK_PAYLOAD_FIELDS, WEBHOOK_BACKOFF_BASE_MS, WEBHOOK_BACKOFF_MAX_MS, WEBHOOK_TIMEOUT_MS,
} from '../server/webhooks.ts';
import { runFile, journalFile } from '../server/runner/state.ts';
import { transcriptFile } from '../server/runner/transcript.ts';
import { inboxOutcomeFile } from '../server/runner/outcome.ts';
import { rulingsFile } from '../server/runner/rulings.ts';
import { DEBUG_SOURCES } from '../server/debug/sources.ts';
import { BUNDLE_SCHEMA, BUNDLE_VERSION } from '../server/debug/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, 'utf8');

/** Headings at one level, e.g. '##' -> the '## ' lines. Fenced blocks stripped first. */
const headings = (body: string, hashes: string): string[] => {
  const out: string[] = [];
  let fenced = false;
  for (const line of stripFences(body).split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (line.startsWith(`${hashes} `)) out.push(line.slice(hashes.length + 1).trim());
  }
  return out;
};

/** Drop fenced code blocks — a `## ` inside a sample plan is not a heading. */
const stripFences = (body: string): string => body.replace(/^```[\s\S]*?^```/gm, '');

const flagsIn = (body: string): Set<string> =>
  new Set((body.match(/--allow-[a-z-]+/g) ?? []).map((f) => f.replace(/[^a-z-]+$/, '')));

const imagesIn = (body: string): Set<string> =>
  new Set((body.match(/!\[[^\]]*\]\(([^)]+)\)/g) ?? []).map((m) => m.replace(/^.*\(|\)$/g, '')));

/* ------------------------------------------------------------------ *
 * 1. EN <-> FA sibling parity
 * ------------------------------------------------------------------ */

const SIBLINGS: ReadonlyArray<readonly [string, string]> = [
  ['README.md', 'README.fa.md'],
  ['USAGE.md', 'USAGE.fa.md'],
  ['viewer/README.md', 'viewer/README.fa.md'],
];

test('every FA sibling mirrors its English original section for section', () => {
  for (const [en, fa] of SIBLINGS) {
    const enBody = read(en);
    const faBody = read(fa);
    for (const level of ['##', '###']) {
      const a = headings(enBody, level);
      const b = headings(faBody, level);
      assert.equal(
        b.length,
        a.length,
        `${fa} has ${b.length} '${level}' sections, ${en} has ${a.length} — a translation that drops `
          + `a section is invisible to a Persian reader.\n  EN: ${a.join(' | ')}\n  FA: ${b.join(' | ')}`,
      );
    }
  }
});

test('every FA sibling names the same capability flags as its original', () => {
  for (const [en, fa] of SIBLINGS) {
    const a = [...flagsIn(read(en))].sort();
    const b = [...flagsIn(read(fa))].sort();
    // A flag name is not translated, so a missing one is a real omission — this
    // is exactly how USAGE.fa.md lost --allow-agent and --allow-terminal.
    assert.deepEqual(b, a, `${fa} names different flags than ${en}`);
  }
});

test('every FA sibling carries the same images as its original', () => {
  for (const [en, fa] of SIBLINGS) {
    const a = [...imagesIn(read(en))].sort();
    const b = [...imagesIn(read(fa))].sort();
    assert.deepEqual(b, a, `${fa} does not show the same images as ${en}`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Catalogue row-counts
 * ------------------------------------------------------------------ */

/** Spelled-out counts, both documents' habit. Shared so the two cannot disagree. */
const CATEGORY_COUNT_WORDS: Record<string, number> = {
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18,
};

test('docs/phone.md documents every push category, and the right number of them', () => {
  const body = read('docs/phone.md');
  for (const c of CATEGORIES) {
    assert.ok(body.includes(`**${c.label}**`), `docs/phone.md never names the '${c.label}' category`);
  }
  const claimed = body.match(/\*\*(\w+) categories, per device\*\*/);
  assert.ok(claimed, 'docs/phone.md no longer states how many categories there are');
  assert.equal(
    CATEGORY_COUNT_WORDS[claimed[1].toLowerCase()],
    CATEGORIES.length,
    `docs/phone.md says '${claimed[1]}' categories; the catalogue ships ${CATEGORIES.length}`,
  );
});

test("the guide's own category table documents every push category, and the right number", () => {
  // `docs/phone.md` and the in-app guide are two audiences for one catalogue,
  // and only one of them was tested. The guide's heading said FOURTEEN while
  // the table listed fifteen and the catalogue shipped fifteen — a count
  // nobody could have trusted, in the document a new operator reads first.
  const body = read('viewer/client/src/content/guide/notifications.md');
  for (const c of CATEGORIES) {
    assert.ok(body.includes(`**${c.label}**`), `guide/notifications.md never names the '${c.label}' category`);
  }
  const claimed = /## The ([a-z-]+) categories/.exec(body);
  assert.ok(claimed, 'guide/notifications.md no longer states how many categories there are');
  assert.equal(
    CATEGORY_COUNT_WORDS[claimed![1].toLowerCase()],
    CATEGORIES.length,
    `guide/notifications.md says '${claimed![1]}' categories; the catalogue ships ${CATEGORIES.length}`,
  );
  // And the table has exactly that many rows — a named category with no row is
  // a category the guide mentions in prose and never explains.
  const rows = body.split('\n').filter((line) => /^\| \*\*/.test(line));
  assert.equal(rows.length, CATEGORIES.length, 'the guide table must have one row per category');
});

test('docs/phone.md names exactly the urgent categories the catalogue marks urgent', () => {
  const body = read('docs/phone.md');
  const urgent = CATEGORIES.filter((c) => c.urgent);
  const para = body.slice(body.indexOf('sent **urgent**'));
  for (const c of urgent) {
    assert.ok(
      para.slice(0, 600).includes(c.label),
      `'${c.label}' is urgent in the catalogue but docs/phone.md does not list it as one`,
    );
  }
  for (const c of CATEGORIES.filter((x) => !x.urgent)) {
    assert.ok(
      !para.slice(0, 600).includes(`*${c.label}*`),
      `'${c.label}' is NOT urgent but docs/phone.md lists it among the urgent ones`,
    );
  }
});

/**
 * The verbs a notification button may carry.
 *
 * A doc that promised a button the console does not offer would send an
 * operator to a lock screen looking for it; a doc that omitted one would leave
 * a capability nobody knew existed. Both are structure, not prose — the labels
 * are `PUSH_ACTION_VERBS`' own values, so the table is checked against them
 * rather than against a sentence.
 *
 * The negative half matters more than the positive one. The restraint this
 * feature rests on is that a notification button ANSWERS and never STARTS or
 * KILLS — so a doc naming Recover, Nudge, Freeze or Stop as a button is a doc
 * describing a product this is deliberately not.
 */
test('docs/phone.md names exactly the buttons a notification can carry', () => {
  const body = read('docs/phone.md');
  // Anchored to the END of the heading line, and located by a regex rather
  // than `indexOf`. Both halves are load-bearing: an unanchored heading match
  // also matches `### Answering from the notification itself (removed)`, and
  // `body.slice(indexOf(...))` on a miss returns the last character — a
  // non-empty string that `assert.ok` is perfectly happy with. Together those
  // two make a gate whose whole subject can be renamed away in silence.
  const start = /^### Answering from the notification itself$/m.exec(body);
  assert.ok(start, 'docs/phone.md no longer documents notification buttons');
  const rest = body.slice(start.index);
  const end = /^### /m.exec(rest.slice(start[0].length));
  assert.ok(end, 'the notification-buttons section runs to the end of the file — the next heading went away');
  const section = rest.slice(0, start[0].length + end.index);

  for (const label of Object.values(PUSH_ACTION_VERBS)) {
    assert.ok(
      section.includes(`| **${label}** |`),
      `docs/phone.md never lists the '${label}' button, which the console does offer`,
    );
  }
  const rows = section.split('\n').filter((line) => /^\| \*\*\w+\*\* \|/.test(line));
  assert.equal(
    rows.length,
    Object.keys(PUSH_ACTION_VERBS).length,
    `docs/phone.md lists ${rows.length} buttons; the console offers ${Object.keys(PUSH_ACTION_VERBS).length}`,
  );

  for (const forbidden of ['Recover', 'Nudge', 'Freeze', 'Stop', 'Release', 'Restart']) {
    assert.ok(
      !section.includes(`| **${forbidden}** |`),
      `docs/phone.md offers '${forbidden}' as a notification button — a button may answer, never start or kill work`,
    );
  }
});

test('docs/metrics.md lists every metric family, with the right type and count', () => {
  const body = read('docs/metrics.md');
  for (const [name, type] of METRIC_FAMILIES) {
    // The name, in a table row that also states its type. A doc that named the
    // family but called a counter a gauge would send somebody to `rate()` over
    // a number that moves both ways.
    // The TABLE row, not the first prose mention — several families are also
    // named in the notes above and below it.
    const row = body.split('\n').find((line) => line.startsWith(`| \`${name}\` |`));
    assert.ok(row, `docs/metrics.md never names ${name}`);
    assert.ok(row.includes(`| ${type} |`), `docs/metrics.md calls ${name} something other than a ${type}`);
  }
  const claimed = body.match(/\*\*(\d+) families/);
  assert.ok(claimed, 'docs/metrics.md no longer states how many families there are');
  assert.equal(
    Number(claimed[1]),
    METRIC_FAMILIES.length,
    `docs/metrics.md says ${claimed[1]} families; the endpoint emits ${METRIC_FAMILIES.length}`,
  );
});

test('docs/metrics.md documents every board state a phase count is labelled with', () => {
  const body = read('docs/metrics.md');
  const para = body.slice(body.indexOf('**Labels.**'));
  for (const state of PHASE_STATES) {
    assert.ok(
      para.slice(0, 800).includes(`\`${state}\``),
      `'${state}' is a phase_console_phases label value but docs/metrics.md does not list it`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 3. Guide claims vs the machine
 * ------------------------------------------------------------------ */

/** The capability flags, lifted out of config.ts's own CAPABILITY_FLAGS table. */
const capabilityFlags = (): string[] => {
  const src = read('viewer/server/config.ts');
  const block = src.slice(src.indexOf('const CAPABILITY_FLAGS'));
  return [...new Set(block.slice(0, block.indexOf('];')).match(/--allow-[a-z-]+/g) ?? [])].sort();
};

test('the guide documents every capability flag, and states the right count', () => {
  const flags = capabilityFlags();
  assert.ok(flags.length >= 5, 'CAPABILITY_FLAGS did not parse out of config.ts');

  const reference = read('viewer/client/src/content/guide/reference.md');
  const running = read('viewer/client/src/content/guide/running.md');
  for (const flag of flags) {
    assert.ok(reference.includes(`\`${flag}\``), `guide/reference.md never documents ${flag}`);
    assert.ok(running.includes(`\`${flag}\``), `guide/running.md never documents ${flag}`);
  }

  // The written-out count, wherever the guide states one. This is the assertion
  // that was false for months: six flags, "All five ... are off unless named".
  const WORDS: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const surfaces = [
    ['guide/reference.md', reference],
    ['guide/running.md', running],
    ['guide/troubleshooting.md', read('viewer/client/src/content/guide/troubleshooting.md')],
    ['help/sections.ts', read('viewer/client/src/app/help/sections.ts')],
  ] as const;
  // Two shapes, because the guide states the count both ways and only one of
  // them mentions the word "switches": "All six capability switches are off"
  // and "**All six are off unless you name them.**". A pattern that caught only
  // the first left the second free to say five for as long as nobody read it.
  const COUNT_PATTERNS = [
    /\b(four|five|six|seven|eight)\s+(?:capability\s+)?switches\b/gi,
    /\bAll\s+(four|five|six|seven|eight)\s+(?:are|of them are)\s+off\b/gi,
  ];
  let stated = 0;
  for (const [name, body] of surfaces) {
    for (const pattern of COUNT_PATTERNS) {
      for (const [, word] of body.matchAll(pattern)) {
        stated++;
        assert.equal(
          WORDS[word.toLowerCase()],
          flags.length,
          `${name} says '${word}'; there are ${flags.length} capability flags`,
        );
      }
    }
  }
  assert.ok(stated >= 4, `expected the switch count to be stated on several surfaces, found ${stated}`);
});

test('the guide sends readers only to settings sections that exist', () => {
  const nav = read('viewer/client/src/features/settings/nav.tsx');
  const titles = [...nav.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(titles.length, 8, `expected 8 settings sections, nav.tsx has ${titles.length}`);

  const guideDir = `${root}viewer/client/src/content/guide/`;
  const docs = [
    ...readdirSync(guideDir).filter((f) => f.endsWith('.md')).map((f) => [`guide/${f}`, readFileSync(`${guideDir}${f}`, 'utf8')] as const),
    ...readdirSync(`${root}docs/`).filter((f) => f.endsWith('.md')).map((f) => [`docs/${f}`, read(`docs/${f}`)] as const),
  ];
  for (const [name, body] of docs) {
    for (const [, section] of body.matchAll(/(?<!System )Settings ▸ ([A-Za-z][A-Za-z ]*?)(?= ▸ |\*\*|\b[,.)]|$)/gm)) {
      const head = section.trim();
      assert.ok(
        titles.some((t) => head === t || head.startsWith(`${t} `)),
        `${name} addresses "Settings ▸ ${head}", which is not one of the eight sections `
          + `(${titles.join(' · ')}). A card inside one is addressed "Settings ▸ <section> ▸ <card>".`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4. Repo paths that no longer resolve
 * ------------------------------------------------------------------ */

/**
 * A backticked token that looks like a repo path. Deliberately narrow: it must
 * start with a known top-level directory, so prose like `--allow-run` and
 * `phase.rung` are never mistaken for files. Brace groups (`a/{b,c}.ts`) are
 * expanded; a trailing `/` means a directory; `*` means glob, checked as its
 * parent directory existing.
 */
const PATH_ROOTS = ['viewer/', 'scripts/', 'docs/', 'references/', 'tests/', 'assets/', 'bin/', '.github/'];

/**
 * Paths under these prefixes are WORK-STATE in the reader's own repository, not
 * files in this one — `docs/first-plan.md` walks through creating
 * `docs/plans/checkout-rewrite.md`, which must not exist here.
 */
const READER_REPO = ['docs/plans/', 'docs/handoffs/'];

/**
 * Docs also cite client and server paths RELATIVE to a base they name in the
 * surrounding prose — `features/now/index.tsx`, `components/pulse.tsx`. These
 * are the ones the 3.0 redesign broke (`views/` became `features/`), and a
 * detector anchored only on top-level directories never looked at them. A token
 * starting with one of these resolves against any BASE below; if it resolves
 * under none, it is drift.
 */
const RELATIVE_ROOTS = ['features/', 'components/', 'views/', 'app/', 'lib/', 'content/', 'styles/', 'server/', 'shared/', 'client/', 'runner/'];
const BASES = ['', 'viewer/', 'viewer/client/src/', 'viewer/server/'];

/**
 * Bare script names, as the helper tables in docs/controls.md and SKILL.md
 * spell them — `new-plan.sh`, `qa-record.sh`, `phase-console.mjs`. They carry no
 * directory, so the detector above never saw them, and renaming or deleting one
 * would leave every table that lists it silently wrong.
 *
 * SCRIPT_PATH is the same name WITH a directory, and it is here because that is
 * how SKILL.md's own helper list spells every entry — `scripts/new-plan.sh
 * <slug>`. A path-qualified script followed by arguments fell through BOTH
 * halves of this detector: the bare-name branch below rejected it for
 * containing a `/`, and the repo-path branch above skips any span that is not a
 * single token, which a signature with arguments never is. So the one shape the
 * most-read file in the repository uses was the one shape nothing checked.
 */
const SCRIPT_NAME = /^[a-z0-9][a-z0-9._-]*\.(?:sh|mjs|bats)$/;
const SCRIPT_PATH = /^(?:[a-z0-9._-]+\/)+[a-z0-9][a-z0-9._-]*\.(?:sh|mjs|bats)$/;
const SCRIPT_BASES = [
  'scripts/', '', 'bin/', 'viewer/', 'viewer/deploy/', 'viewer/scripts/',
  '.github/scripts/', 'tests/', 'tests/unit/', 'tests/integration/',
];

/**
 * Named exceptions, each with the reason it is not drift. Keep this list
 * *shrinking*: an entry is a promise, and the doc beside it says so out loud.
 */
const NOT_YET_WRITTEN = new Set([
  // docs/loop.md's ladder table cites it and says "not yet written; the rung is
  // skipped" in the same cell. The rung exists in RUNGS_BY_SITUATION and is
  // deliberately a no-op until someone writes the script.
  'scripts/repair-artefacts.sh',
  // Build output, not drift: docs/releasing.md is right to name the dist the
  // live console serves, and a fresh checkout is right not to have it —
  // `client/dist` is gitignored and exists only after `npm run build`.
  'viewer/client/dist',
  'client/dist',
]);

const expandBraces = (spec: string): string[] => {
  const m = spec.match(/^(.*?)\{([^}]*)\}(.*)$/);
  if (!m) return [spec];
  return m[2].split(',').flatMap((part) => expandBraces(`${m[1]}${part.trim()}${m[3]}`));
};

test('every backticked repo path in docs/, references/ and SKILL.md still resolves', () => {
  const files = [
    ...readdirSync(`${root}docs/`).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
    ...readdirSync(`${root}references/`).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`),
    // SKILL.md too — the comment above SCRIPT_NAME has always named its helper
    // table as a reason this detector exists, and for as long as the file was
    // not in this list that was a claim rather than a check. It is the one doc
    // every session loads, so a script it names and the repo does not have is
    // the most expensive stale path in the repository.
    'SKILL.md',
  ];
  const missing: string[] = [];
  for (const rel of files) {
    // The whole backticked span, spaces included, because a helper table spells
    // a script with its arguments (`new-plan.sh <slug>`) and a no-space pattern
    // skips the span entirely — which is how a renamed script stayed invisible.
    for (const [, span] of read(rel).matchAll(/`([^`\n]+)`/g)) {
      const token = span.split(/\s+/)[0];
      if (SCRIPT_NAME.test(token)) {
        if (!SCRIPT_BASES.some((base) => existsSync(`${root}${base}${token}`))) {
          missing.push(`${rel}: ${token} (no such script)`);
        }
        continue;
      }
      if (SCRIPT_PATH.test(token)) {
        // Directory-qualified, but not necessarily FROM THE ROOT: a doc may name
        // a script under `deploy/` or `scripts/` with the parent established in
        // the surrounding prose, the same relative-to-a-named-base habit
        // RELATIVE_ROOTS exists for. So it resolves against the same bases a
        // bare name does.
        if (!NOT_YET_WRITTEN.has(token)
          && !SCRIPT_BASES.some((base) => existsSync(`${root}${base}${token}`))) {
          missing.push(`${rel}: ${token} (no such script)`);
        }
        continue;
      }
      // Path checks only look at a span that IS a path — one bare token.
      if (span !== token) continue;
      const absolute = PATH_ROOTS.some((p) => token.startsWith(p));
      const relative = RELATIVE_ROOTS.some((p) => token.startsWith(p));
      if (!absolute && !relative) continue;
      if (READER_REPO.some((p) => token.startsWith(p))) continue;
      if (NOT_YET_WRITTEN.has(token)) continue;
      if (token.includes('<') || token.includes('$')) continue; // a template, not a path
      const bases = absolute ? [''] : BASES;
      for (const candidate of expandBraces(token)) {
        const path = candidate.replace(/\*.*$/, '').replace(/[),.:]+$/, '');
        if (!path) continue;
        const resolves = bases.some((base) => {
          if (existsSync(`${root}${base}${path}`)) return true;
          // A glob was trimmed to its parent directory; the parent must exist.
          if (!candidate.includes('*')) return false;
          return existsSync(`${root}${base}${path.slice(0, path.lastIndexOf('/') + 1)}`);
        });
        if (!resolves) missing.push(`${rel}: ${candidate}`);
      }
    }
  }
  assert.deepEqual(missing, [], `docs cite paths that do not exist:\n  ${missing.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * 5. The review surface's vocabulary, and the names it promises
 * ------------------------------------------------------------------ */

test('the guide names every review verdict a person can record, and no invented one', () => {
  const body = read('viewer/client/src/content/guide/reference.md');
  const table = /## Review holds([\s\S]*?)\n## /.exec(body);
  assert.ok(table, 'reference.md no longer has a Review holds section');
  const listed = [...table[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  for (const verdict of REVIEW_VERDICTS) {
    assert.ok(
      listed.includes(verdict),
      `the reference never lists the "${verdict}" verdict — adding one is two edits, and this is the second`,
    );
  }
  // …and the reverse: a word the reference offers that the code will refuse.
  for (const word of listed) {
    if (!/^(approved|requested-changes|commented)$/.test(word)) continue;
    assert.ok(isReviewVerdict(word), `the reference offers "${word}", which the server rejects`);
  }
});

test('the guide names every bar and mark the timeline can draw, and no invented one', () => {
  // Same shape as the review-verdict check above, for the same reason: the
  // reference documents a vocabulary the server owns, and a table listing
  // three of four bar kinds is worse than one listing none — a reader trusts
  // it and then cannot account for the fourth colour on their screen.
  const body = read('viewer/client/src/content/guide/reference.md');
  const section = /## Run timeline([\s\S]*?)\n## /.exec(body);
  assert.ok(section, 'reference.md no longer has a Run timeline section');
  const listed = new Set([...section[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  for (const kind of BAR_KINDS) {
    assert.ok(listed.has(kind), `the reference never names the "${kind}" bar the projection emits`);
  }
  for (const kind of MARK_KINDS) {
    assert.ok(listed.has(kind), `the reference never names the "${kind}" mark the projection emits`);
  }
  // …and the reverse: a bar-shaped word the reference offers that cannot appear.
  for (const word of listed) {
    if (!/^(working|verifying|waiting|frozen)$/.test(word)) continue;
    assert.ok(
      (BAR_KINDS as readonly string[]).includes(word),
      `the reference offers a "${word}" bar, which the projection never emits`,
    );
  }
});

test('the guide names the two journal lines the verifying bar is bracketed by', () => {
  // The identifiers, not the phrasing. The bar's edges ARE these two events;
  // renaming either in the runner without renaming it here leaves a doc that
  // explains a bar the reader can no longer find in their journal.
  const body = read('viewer/client/src/content/guide/reference.md');
  for (const event of ['phase.awaiting-verification', 'phase.verify']) {
    assert.ok(body.includes(event), `reference.md never names ${event}`);
  }
  const runner = read('viewer/server/runner/runner.ts');
  assert.ok(runner.includes("'phase.awaiting-verification'"), 'the runner no longer writes phase.awaiting-verification');
});

test('the guide names the journal line a review hold really writes', () => {
  // The identifier, not the phrasing: an operator reading a run's journal for
  // "why did this not board" needs the exact string, and it is written in one
  // place in the runner. Renaming it there without renaming it here is exactly
  // the drift this file exists to catch.
  const loop = read('viewer/server/runner/runner-loop.ts');
  for (const doc of ['viewer/client/src/content/guide/run.md', 'viewer/client/src/content/guide/reference.md']) {
    const body = read(doc);
    assert.ok(body.includes('phase.review-held'), `${doc} never names the review-hold journal line`);
  }
  assert.ok(loop.includes("'phase.review-held'"), 'the runner no longer writes phase.review-held');
});

test('the guide names the journal lines a review follow-up and an auto reviewer really write', () => {
  // Structure, not prose (the P11 rule): these are identifiers an operator
  // greps a run journal for. Every one of them is written in exactly one
  // place, and a rename there that misses the docs leaves a guide explaining
  // lines nobody can find.
  const loop = read('viewer/server/runner/runner-loop.ts');
  const control = read('viewer/server/runner/runner-control.ts');
  const reference = read('viewer/client/src/content/guide/reference.md');
  for (const event of [
    'phase.review-follow-up',
    'phase.review-session',
    'phase.review-session-done',
    'phase.review-session-skipped',
    'phase.review-session-failed',
  ]) {
    assert.ok(reference.includes(event), `reference.md never names ${event}`);
  }
  assert.ok(control.includes("'phase.review-follow-up'"), 'the runner no longer writes phase.review-follow-up');
  for (const event of ['phase.review-session', 'phase.review-session-done', 'phase.review-session-skipped']) {
    assert.ok(loop.includes(`'${event}'`), `the runner no longer writes ${event}`);
  }
});

test('the reviewer really is given only the read-only tools the guide promises', () => {
  // The promise is a SAFETY claim — "it cannot edit or commit the code it is
  // reading" — so it is held to the actual tool list, not to the sentence. A
  // `Bash` added here would make the guide a lie in the one direction that
  // matters.
  const loop = read('viewer/server/runner/runner-loop.ts');
  const tools = /REVIEWER_TOOLS = \[([^\]]*)\]/.exec(loop);
  assert.ok(tools, 'the reviewer tool list moved or was renamed');
  const named = [...tools![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(named, ['Read', 'Grep', 'Glob']);
  for (const forbidden of ['Bash', 'Edit', 'Write']) {
    assert.equal(named.includes(forbidden), false, `the reviewer must never be given ${forbidden}`);
  }
  for (const doc of ['viewer/client/src/content/guide/run.md', 'viewer/client/src/content/guide/reference.md']) {
    const body = read(doc);
    for (const tool of named) assert.ok(body.includes(tool), `${doc} never names the ${tool} tool`);
  }
});

test('the guide names the reviewer policies the server will actually accept', () => {
  // Read from the OWNER (`shared/run-lifecycle.js`) since the vocabulary moved
  // there: `reviewer.ts` now re-exports the same object rather than declaring a
  // second copy, which is what `vocab-owners.test.ts` holds it to.
  const owner = read('viewer/shared/run-lifecycle.js');
  const reviewer = read('viewer/server/reviewer.ts');
  const policies = /export const REVIEWER_POLICIES = [\s\S]*?\(\[([^\]]*)\]/.exec(owner);
  // And `reviewer.ts` re-exports the owner rather than re-listing it — the
  // half `vocab-owners.test.ts` asserts by identity, asserted here by shape so
  // this test fails loudly if the copy ever comes back.
  assert.match(reviewer, /REVIEWER_VERDICT_POLICIES = REVIEWER_POLICIES/);
  assert.ok(policies, 'the policy vocabulary moved or was renamed');
  const named = [...policies![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(named, ['comment-only', 'may-hold']);
  const reference = read('viewer/client/src/content/guide/reference.md');
  for (const policy of named) {
    assert.ok(reference.includes(policy), `reference.md never names the ${policy} policy`);
  }
  // And the default is the cautious one, in the code as well as the sentence.
  assert.ok(
    /DEFAULT_REVIEWER_POLICY: ReviewerVerdictPolicy = 'comment-only'/.test(reviewer),
    'the default reviewer policy is no longer comment-only — the guide says it is',
  );
});

/* ------------------------------------------------------------------ *
 * 6. Each reference's Contents line names its own sections
 * ------------------------------------------------------------------ */

test("every references/*.md Contents line names every one of that file's sections", () => {
  for (const file of readdirSync(`${root}references/`).filter((f) => f.endsWith('.md'))) {
    const body = read(`references/${file}`);
    const m = body.match(/^Contents:([\s\S]*?)\n\n/m);
    if (!m) continue; // not every reference carries one; only the ones that do are held to it
    const contents = m[1];
    for (const head of headings(body, '##')) {
      // The Contents line abbreviates — "Task ids" for "Task list — scripts/…".
      // So the assertion is that its first two words appear, not the whole title.
      const key = head.split(/[—(]/)[0].trim().split(/\s+/).slice(0, 2).join(' ');
      assert.ok(
        contents.includes(key),
        `references/${file}: the Contents line never mentions '${head}' (looked for '${key}')`,
      );
    }
  }
});

test('the reference names the real landing artefacts, not remembered ones', () => {
  // The P11 duty: a doc CLAIM gets an assertion or nothing reads it. This one
  // is structural on purpose — it holds the two NAMES the code writes to disk,
  // so renaming either without touching the reference is a red test rather
  // than an operator looking in a directory for a file that is not there.
  const body = read('viewer/client/src/content/guide/reference.md');
  // Anchored to the END of the heading line: `/## Landing packet(…)/` also
  // matches `## Landing packet (removed)`, so a renamed section passed a
  // gate whose whole job is to notice the section going away.
  const section = /\n## Landing packet\n([\s\S]*?)\n## /.exec(body);
  assert.ok(section, 'reference.md no longer has a Landing packet section');

  assert.ok(section[1].includes(MANIFEST), `the reference never names the manifest file (${MANIFEST})`);
  assert.ok(section[1].includes(PATCH_DIR), `the reference never names the patch directory (${PATCH_DIR})`);
  assert.match(section[1], /runs\/<instance>\/<slug>\/landing\//,
    'the reference must name where the packet is written — an operator looks there by hand');

  // And the run guide, which is where a reader meets the feature first.
  const guide = read('viewer/client/src/content/guide/run.md');
  const landing = /\n## Landing what it built \u{1F7E2}\n[\s\S]*$/u.exec(guide);
  assert.ok(landing, 'run.md no longer has a Landing section');
  assert.ok(landing[0].includes(MANIFEST) && landing[0].includes(PATCH_DIR));
});

test('the reference states the flag composing a packet really needs', () => {
  // A doc that names the wrong flag is worse than one that names none: the
  // operator restarts the console with it and the button still refuses. The
  // route is the truth, so both are read.
  const body = read('viewer/client/src/content/guide/reference.md');
  // Anchored to the END of the heading line: `/## Landing packet(…)/` also
  // matches `## Landing packet (removed)`, so a renamed section passed a
  // gate whose whole job is to notice the section going away.
  const section = /\n## Landing packet\n([\s\S]*?)\n## /.exec(body);
  assert.ok(section);
  assert.match(section[1], /--allow-writes/, 'composing is a write and the reference must say so');

  const routes = read('viewer/server/api/routes.ts');
  const block = /if \(sub === 'landing'\)([\s\S]*?)\n      if \(sub === 'gate'/.exec(routes);
  assert.ok(block, 'the landing route moved — this assertion is now checking nothing');
  assert.match(block[1], /guardMutation\(req, guardWrite\(req, service\)\)/,
    'the reference promises --allow-writes; the route must be the one that enforces it');
  assert.ok(!/guardRun\(/.test(block[1]), 'composing must not have quietly become a run-class act');
});

test('the guide names the journal line a retry-with-edits really writes', () => {
  // The identifier, not the phrasing (the P11 rule). An operator asking "why
  // did phase 7 run on Opus that once" greps the run journal for exactly this
  // string, and the override is DELETED from the record at the boarding it
  // causes — so the journal line is the only surviving account of it. A rename
  // in the runner that misses the guide leaves a promise nobody can check.
  const loop = read('viewer/server/runner/runner-loop.ts');
  assert.ok(loop.includes("'phase.retry-override'"), 'the runner no longer writes phase.retry-override');
  const guide = read('viewer/client/src/content/guide/autopilot.md');
  assert.ok(guide.includes('phase.retry-override'), 'the guide never names the retry-override journal line');
});

test('the docs name every rule of the boarding policy the module actually has', () => {
  // Structure, not prose: the field names an operator meets in `config.json`
  // and in this repository's own vocabulary. `sanitiseSchedule(undefined)` IS
  // the shape — asking it rather than retyping the list is what makes a field
  // added tomorrow fail here instead of going undocumented.
  const shape = Object.keys(sanitiseSchedule(undefined));
  assert.deepEqual(shape.sort(), ['cron', 'cronMinutes', 'enabled', 'quiet', 'windows'],
    'the policy grew a rule — document it and widen this list in the same commit');
  const controls = read('docs/controls.md');
  for (const key of shape) {
    if (key === 'enabled') continue; // The on/off switch is the card, not a rule.
    assert.ok(
      controls.includes(key),
      `docs/controls.md never names the boarding policy's \`${key}\``,
    );
  }
  assert.ok(controls.includes('boardingSchedule'), 'the preference key itself is what a config.json reader greps for');
});

test('docs/webhooks.md documents every field a payload carries, and no field it does not', () => {
  // The standing duty this file exists for: a phase that adds a doc CLAIM adds
  // its own assertion. The claim here is a wire contract — a relay parses these
  // names — so the doc's table is held to the exported list in both directions.
  // A field added without a row fails; a row for a field that was removed fails
  // too, which is the half a one-way check misses.
  const doc = read('docs/webhooks.md');
  const table = doc.slice(doc.indexOf('| Field | What it is |'));
  assert.ok(table.length > 200, 'docs/webhooks.md lost its field table');

  const documented = new Set(
    [...table.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((match) => match[1]),
  );
  for (const field of WEBHOOK_PAYLOAD_FIELDS) {
    assert.ok(documented.has(field), `docs/webhooks.md never documents the payload's \`${field}\``);
  }
  assert.deepEqual(
    [...documented].sort(), [...WEBHOOK_PAYLOAD_FIELDS].sort(),
    'docs/webhooks.md documents a field the payload does not carry',
  );

  // The two vendor field names are the whole reason there is no vendor code.
  assert.match(doc, /Slack and Telegram render this/);
  assert.match(doc, /Discord renders this/);
  // And the flag's failure policy, which is the claim an operator bets on.
  // Whitespace-tolerant: these docs are hard-wrapped, so a claim can straddle a
  // newline and a literal-space regex silently stops testing it.
  assert.match(doc, /no\s+outbound request is ever made/);
});

test('the webhook backoff the docs promise is the backoff the code applies', () => {
  // A number in prose is the classic drifting claim. These three are the ones an
  // operator plans around — how long a dead relay costs them, and how long a
  // hung request stalls nothing.
  const doc = read('docs/webhooks.md');
  assert.equal(WEBHOOK_BACKOFF_BASE_MS, 30_000);
  assert.equal(WEBHOOK_BACKOFF_MAX_MS, 30 * 60_000);
  assert.equal(WEBHOOK_TIMEOUT_MS, 10_000);
  assert.match(doc, /30 seconds/, 'the first backoff step is not the one documented');
  assert.match(doc, /half an\s+hour/, 'the backoff ceiling is not the one documented');
  assert.match(doc, /abandoned after 10 seconds/, 'the request timeout is not the one documented');
  // 24 hours at the ceiling. Stated because "48 requests a day and nothing
  // else" is the sentence that makes keeping a dead row defensible.
  assert.equal((24 * 60 * 60_000) / WEBHOOK_BACKOFF_MAX_MS, 48);
  assert.match(doc, /48 requests a day/);
});

/* ------------------------------------------------------------------ *
 * 7. SKILL.md's helper signatures vs the flags the scripts implement
 * ------------------------------------------------------------------ */

/**
 * SKILL.md is the one document every phased-execution session loads before it
 * touches anything, and its `## Helper scripts` list is where a session learns
 * what it is allowed to ask the engine for. Nothing read it.
 *
 * That is the STRUCTURAL reason `console-speed-and-sync`'s Phase 9 had a
 * vocabulary drift to reconcile at all: four board-bucket lists lost `stuck`,
 * two plan-status lists lost three words, the QA list lost `pending`, and every
 * one of those sentences sat in a file whose only gate was a human reading it.
 * The same hole hides flags: three engine flags shipped, were used by the
 * console, and were named in no helper table anywhere.
 *
 * Two directions, because a signature drifts both ways:
 *
 *   1. INVENTED — SKILL.md names a `--flag` that nothing implements. A session
 *      that types it gets a usage error at best, and at worst a silent no-op.
 *   2. UNDOCUMENTED — a script implements a `--flag` SKILL.md never mentions.
 *      A capability that exists and is invisible is a capability nobody uses.
 *
 * Direction 1 is checked against EVERY flag the repo implements rather than
 * per-bullet, because helper entries legitimately cross-reference each other
 * (`close-plan.sh`'s bullet ends "ask with `phase-graph.sh <slug> --closed`").
 * "Documented under the wrong heading" is a style question; "documented and
 * does not exist" is a defect, and only the second is worth a red gate.
 */

/** Flags a shell script implements, read from its `--flag)` / `--a|--b)` case arms. */
const scriptFlags = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/^[ \t]*((?:--[a-z][a-z0-9-]*\|)*--[a-z][a-z0-9-]*)\)/gm)) {
    for (const flag of m[1].split('|')) out.add(flag);
  }
  return out;
};

/**
 * Flags implemented but deliberately absent from SKILL.md. Every entry is a
 * promise, exactly like `NOT_YET_WRITTEN` above: keep this list SHRINKING.
 *
 * **It is empty, and that is the point.** It landed in Phase 9 of
 * console-speed-and-sync holding five entries — `phase-graph.sh --mcp`,
 * `--mcp-policy` and `--plan-status`, `phase-outcome.sh --until`,
 * `phase-lock.sh --worktree` — precisely so Phase 10 got a checklist it could
 * not half-finish; Phase 10 documented all five and emptied it. What the list
 * buys from here on is flag six: the day someone adds a case arm to a script
 * and does not say so in SKILL.md, this test names it.
 *
 * Never add a flag here to silence a red gate. Document it instead; that is
 * three minutes and it is the entire reason this test exists. An entry that
 * ever does earn its place must carry the reason on the line beside it.
 */
const UNDOCUMENTED_FLAGS = new Set<string>([]);

test('SKILL.md never names a flag no script implements', () => {
  const skill = read('SKILL.md');
  const universe = new Set<string>();
  for (const file of readdirSync(`${root}scripts/`).filter((f) => f.endsWith('.sh'))) {
    for (const flag of scriptFlags(read(`scripts/${file}`))) universe.add(flag);
  }
  // The console's own CLI flags (`--allow-run`, `--port`, …) are implemented in
  // config.ts, not a script, and SKILL.md documents them in the `start` entry.
  for (const m of read('viewer/server/config.ts').matchAll(/arg === '(--[a-z][a-z0-9-]*)'/g)) {
    universe.add(m[1]);
  }

  const invented = [...new Set(skill.match(/--[a-z][a-z0-9-]*/g) ?? [])]
    .filter((flag) => !universe.has(flag))
    .sort();

  assert.deepEqual(
    invented,
    [],
    'SKILL.md offers flags nothing implements — a session that types one gets an error:\n  '
      + `${invented.join('\n  ')}`,
  );
});

test('every flag the helper scripts implement is named in SKILL.md', () => {
  const skill = read('SKILL.md');
  const named = new Set(skill.match(/--[a-z][a-z0-9-]*/g) ?? []);

  const undocumented: string[] = [];
  for (const file of readdirSync(`${root}scripts/`).filter((f) => f.endsWith('.sh'))) {
    for (const flag of scriptFlags(read(`scripts/${file}`))) {
      if (named.has(flag)) continue;
      if (UNDOCUMENTED_FLAGS.has(`${file} ${flag}`)) continue;
      undocumented.push(`${file} ${flag}`);
    }
  }

  assert.deepEqual(
    undocumented.sort(),
    [],
    'these flags ship and SKILL.md never mentions them — document them, or add them to '
      + `UNDOCUMENTED_FLAGS with the reason:\n  ${undocumented.join('\n  ')}`,
  );
});

test('the UNDOCUMENTED_FLAGS allowance never outlives the flags it excuses', () => {
  // A stale allowance is worse than none: it silently excuses a flag that no
  // longer exists, and the next reader trusts the list. Same discipline the
  // vocabulary owners get — an exception must keep earning its place.
  const stale: string[] = [];
  for (const entry of UNDOCUMENTED_FLAGS) {
    const [file, flag] = entry.split(' ');
    if (!existsSync(`${root}scripts/${file}`)) { stale.push(`${entry} (no such script)`); continue; }
    if (!scriptFlags(read(`scripts/${file}`)).has(flag)) stale.push(`${entry} (no longer implemented)`);
  }
  assert.deepEqual(stale, [], `UNDOCUMENTED_FLAGS excuses flags that are gone:\n  ${stale.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * docs/journal-events.md — the whole inventory, both directions
 * ------------------------------------------------------------------ */

/**
 * 226 event kinds are emitted and the five doc surfaces between them named 27
 * (register R36). A journal is only evidence if a reader can tell what a line
 * means, and a list this size is true only for as long as something checks it.
 *
 * The rule is deliberately mechanical: EVERY `'<phase|run|policy>.<name>'`
 * string literal under `viewer/server/` is an event name, and every one must
 * have a row. That covers emitters written in any shape — `this.record(…)`,
 * `.note(…)`, `journal.append(…)`, `deps.journal(slug, id, …)`, a ternary
 * between two names, a `…_EVENT` const — without this test having to know a
 * list of call shapes, which is exactly the kind of list that goes stale.
 *
 * It also covers READERS (`analysis/timeline.ts` keys its bars off these
 * names), and that is a feature: a reader naming an event nothing documents is
 * as much a defect as an emitter that nothing does.
 */
const EVENT_LITERAL = /'((?:phase|run|policy)\.[a-z0-9][a-z0-9.-]*)'/g;

function emittedEvents(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(EVENT_LITERAL)) out.add(m[1]);
    }
  };
  walk(join(root, 'viewer/server'));
  return out;
}

function documentedEvents(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of read('docs/journal-events.md').split('\n')) {
    const row = /^\|\s*`([^`]+)`\s*\|\s*(journal|log|both)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (row) out.set(row[1], row[4]);
  }
  return out;
}

test('every journal event the server emits has a row in docs/journal-events.md', () => {
  const undocumented = [...emittedEvents()].filter((ev) => !documentedEvents().has(ev)).sort();
  assert.deepEqual(undocumented, [],
    'these event kinds are emitted and documented nowhere — add a row to docs/journal-events.md');
});

test('and every row in docs/journal-events.md names an event that exists', () => {
  const emitted = emittedEvents();
  const stale = [...documentedEvents().keys()].filter((ev) => !emitted.has(ev)).sort();
  assert.deepEqual(stale, [],
    'these rows describe events nothing emits any more — delete them');
});

test('no row is documented with an empty meaning', () => {
  // The direction a generated table fails in: 226 rows, all present, half of
  // them saying nothing. A row whose meaning is the event name re-spelled is
  // not a row.
  for (const [event, meaning] of documentedEvents()) {
    assert.ok(meaning.length > 20, `\`${event}\` has no real meaning column`);
    assert.ok(!meaning.includes(event), `\`${event}\`'s meaning just repeats its name`);
  }
});

/* ------------------------------------------------------------------ *
 * 10. The run directory's file names, and the debug guide's vocabulary
 * ------------------------------------------------------------------ */

/**
 * A run-directory path in the docs, with its placeholders normalised.
 *
 * The docs spell the run id `<runId>` in one file and `<id>` in another and
 * both are fine — what must not vary is the SHAPE around it.
 */
const normaliseRunPath = (path: string): string => path
  .replace(/<runId>|<id>/g, '<id>')
  .replace(/\bNN\b|<phase>|<n>/gi, 'NN')
  .replace(/<slug>/g, '<slug>')
  .replace(/<instance>/g, '<instance>');

test('every run-directory path the docs cite is one the code actually writes', () => {
  // Built from the helpers rather than typed here, which is the whole point:
  // rename `journalFile`'s suffix and this list moves with it, so the docs go
  // red in the same commit rather than two releases later.
  // NOT named `root`: this file's module-level `root` is the repository, and
  // shadowing it here would make the readdir below look in `/tmp/rootdocs/`.
  const fakeRoot = '/tmp/root';
  const slug = '<slug>';
  const id = '<id>';
  const base = (full: string) => full.slice(full.lastIndexOf('/') + 1);

  const legal = new Set([
    '',
    base(runFile(fakeRoot, slug, id)),
    base(journalFile(fakeRoot, slug, id)),
    base(transcriptFile(fakeRoot, slug, id)),
    `outcomes/${base(inboxOutcomeFile(fakeRoot, slug, 7)).replace(/\d+/, 'NN')}`,
    base(rulingsFile(fakeRoot, slug)),
    // The phase task lists (`phase-tasks.sh` -> `$PE_TASKS_FILE`), whose name
    // is composed by the runner rather than by a helper this file can call.
    `run-${id}-pNN-tasks.ndjson`,
    // The supervised per-attempt outcome, likewise.
    `run-${id}-pNN-outcome.json`,
    'outcomes',
  ]);

  const files = readdirSync(`${root}docs/`)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`);

  const wrong: string[] = [];
  for (const rel of files) {
    for (const [, span] of read(rel).matchAll(/`([^`\n]+)`/g)) {
      const token = span.split(/\s+/)[0];
      const m = /^runs\/<instance>\/<slug>\/?(.*)$/.exec(token);
      if (!m) continue;
      const tail = normaliseRunPath(m[1]).replace(/[),.:]+$/, '');
      if (!legal.has(tail)) wrong.push(`${rel}: runs/<instance>/<slug>/${m[1]}`);
    }
  }

  assert.deepEqual(
    wrong, [],
    `docs name run files this console does not write:\n  ${wrong.join('\n  ')}\n`
    + `legal tails: ${[...legal].filter(Boolean).join(', ')}`,
  );
});

test('docs/debugging.md documents every debug source, and no invented one', () => {
  const body = read('docs/debugging.md');
  // Scoped to the section that IS the inventory. The file has a second table
  // of backticked words one heading down (the delivery outcomes), and a
  // whole-file scan swept those in as sources — caught by this test's own
  // "no invented one" half on its first run.
  const section = body.slice(body.indexOf('## Where the evidence is'));
  const table = section.slice(0, section.indexOf('\n## ', 1));
  // The table's first column is a backticked source id; a source with no row
  // is a filter chip a reader has no way to understand.
  const documented = new Set(
    [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]),
  );
  for (const source of DEBUG_SOURCES) {
    assert.ok(documented.has(source), `docs/debugging.md has no row for the '${source}' source`);
  }
  for (const named of documented) {
    assert.ok(
      (DEBUG_SOURCES as readonly string[]).includes(named),
      `docs/debugging.md documents a '${named}' source the console does not have`,
    );
  }
  assert.equal(
    documented.size, DEBUG_SOURCES.length,
    `docs/debugging.md lists ${documented.size} sources; the console has ${DEBUG_SOURCES.length}`,
  );
});

test('the debug guide states the bundle schema the server actually emits', () => {
  const body = read('docs/debugging.md');
  assert.ok(
    body.includes(`"${BUNDLE_SCHEMA}"`),
    `docs/debugging.md does not name the bundle schema '${BUNDLE_SCHEMA}'`,
  );
  // The version is load-bearing: a reader keyed on it is promised these keys.
  assert.match(
    body, new RegExp(`^version\\s+${BUNDLE_VERSION}$`, 'm'),
    `docs/debugging.md does not state bundle version ${BUNDLE_VERSION}`,
  );
});
