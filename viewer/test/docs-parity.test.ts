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
import { ENTITLEMENT_STATES } from '../shared/ops-vocab.js';
import {
  WEBHOOK_PAYLOAD_FIELDS, WEBHOOK_BACKOFF_BASE_MS, WEBHOOK_BACKOFF_MAX_MS, WEBHOOK_TIMEOUT_MS,
} from '../server/webhooks.ts';
import { runFile, journalFile } from '../server/runner/state.ts';
import { HALT_KINDS, PHASE_HALT_KINDS, RUN_HALT_KINDS } from '../shared/recovery-model.js';
import { DECLARED_SITUATION } from '../shared/fact-map.js';
import { CLOSED_PLAN_STATUSES, HANDOFF_STATUSES, PLAN_STATUSES, QA_RESULTS } from '../shared/plan-vocab.js';
import {
  PHASE_LIFECYCLE_STATES, PHASE_STATUSES, RUNG_OUTCOMES, RUN_LIFECYCLE_STATES, RUN_PENDING_ACTS,
  RUN_STATUSES, START_DOORS, ULTRA_REVIEW_MODES, WATCH_STATES,
} from '../shared/run-lifecycle.js';
import { RUNGS_BY_SITUATION, RUNG_DRIVERS } from '../shared/ladder-model.js';
import { BOARD_BUCKETS, BOARD_OVERLAY_STATES, BOARD_STATE_UI, PHASE_ACTORS, UI_STATES } from '../shared/status-vocab.js';
import { TASK_STATUSES } from '../shared/task-model.js';
import { RUN_PRIORITIES } from '../shared/orchestration-model.js';
import { SITUATIONS } from '../shared/situation-model.js';
import { RULING_KINDS } from '../shared/attention-model.js';
import { ISSUE_STATES } from '../shared/issues-model.js';
import { MESSAGE_KINDS, MESSAGE_PRIORITIES, MESSAGING_WORDS } from '../shared/message-model.js';
import { DECISION_KEYS } from '../shared/decisions-model.js';
import { QA_WORDS, VERIFICATION_WORDS } from '../shared/evidence-model.js';
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

/** For each Pro region, the `##` section it opens in (0-based, fences stripped) — a shape translation keeps. */
const proRegionSections = (body: string): number[] => {
  const out: number[] = [];
  let section = -1;
  for (const line of stripFences(body).split('\n')) {
    if (line.startsWith('## ')) section += 1;
    if (line.includes('!pro:start')) out.push(section);
  }
  return out;
};

test('every Pro marker region appears in both languages, opening in the same section', () => {
  for (const [en, fa] of SIBLINGS) {
    const a = proRegionSections(read(en));
    const b = proRegionSections(read(fa));
    // A region one language lacks is a Pro paragraph the other reader never gets — or, unmarked, a Pro
    // sentence the free tree ships in Persian. viewer/README.fa.md lost `## The autopilot`'s this way.
    assert.deepEqual(b, a, `${fa} opens Pro regions in sections [${b}], ${en} in [${a}]`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Catalogue row-counts
 * ------------------------------------------------------------------ */

/** Spelled-out counts, both documents' habit. Shared so the two cannot disagree. */
const CATEGORY_COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25,
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

// The one flag reader, shared with `agent.test.ts` (the wizard's coupling).
import { scriptFlags } from './script-flags.ts';

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
  // …and the `claude` flags the runner itself passes to every session it spawns (`--permission-prompts`,
  // `--max-budget-usd`, …): SKILL.md tells a supervised session which of them it is running under.
  for (const m of read('viewer/server/runner/spawn.ts').matchAll(/argv\.push\('(--[a-z][a-z0-9-]*)'/g)) {
    universe.add(m[1]);
  }
  // …and the `.mjs` helpers beside them. They ship in the same directory and a
  // session types them the same way, so a flag one of them implements is not an
  // invented one — `rehearsal-assert.mjs --reach` was the first flag no `.sh`
  // file also happened to carry, and it read as invented for that reason alone.
  // Only THIS direction widens: whether every `.mjs` flag is also documented is
  // a separate editorial question, and the test below deliberately still asks it
  // of the helper `.sh` scripts alone.
  for (const file of readdirSync(`${root}scripts/`).filter((f) => f.endsWith('.mjs'))) {
    for (const m of read(`scripts/${file}`).matchAll(/'(--[a-z][a-z0-9-]*)'/g)) universe.add(m[1]);
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
 * 226 event kinds were emitted when this began and the five doc surfaces
 * between them named 27 (register R36); the widening below then found 247
 * more names the console's own LOG writes, none with a row (sep-review LFC-4).
 * A journal is only evidence if a reader can tell what a line means, and a
 * list this size is true only for as long as something checks it.
 *
 * Three scans, because the names come in two families of different shape:
 *
 *   1. JOURNAL names carry a prefix — EVERY `'<phase|run|policy>.<name>'`
 *      string literal under `viewer/server/` is one, whatever shape emits it
 *      (`this.record(…)`, `.note(…)`, `journal.append(…)`, a ternary between
 *      two names, a `…_EVENT` const) and whatever READS it (`analysis/
 *      timeline.ts` keys its bars off these names, and a reader naming an
 *      event nothing documents is as much a defect as an emitter nothing does).
 *   2. LOG names carry no fixed prefix (`shutdown.begin`, `mcp.probe.failed`,
 *      `previous-run-crashed`), so they are read off the CALL: the first
 *      argument of `log.info/warn/error(…)`, and of the sessions registry's
 *      `onWarn?.(…)` callback, which `service-base.ts` forwards to `log.warn`.
 *   3. A name that is COMPOSED — a template literal — is one the table can
 *      never hold, so composition is banned outright rather than parsed:
 *      `run.park-withdrew` reached the hub's journal that way, undocumented.
 *
 * A RETIRED event keeps its row, with `retired <version>` in the emitter
 * column instead of a file (`run.auto-recover-skipped`: 65 lines in the hub's
 * journals, no emitter since 3.0.0). The "documented ⇒ emitted" direction
 * skips such a row; the "emitted ⇒ documented" direction treats one as a
 * contradiction, so a name that comes back has to be un-retired first.
 * Deleting the row was the old rule, and it left older logs holding words no
 * document explained.
 */
/**
 * The name prefixes this scan recognises as an event.
 *
 * `phase`, `run` and `policy` were the whole vocabulary while every event was
 * about a run. 5.1.0 adds seven more, each naming a subsystem rather than a
 * lifecycle — `git` and `shell` (the one command seam, phase 5), `http` and
 * `engine` (the two other things the console shells or serves), `msg` and
 * `issue` (phases 10 and 12), `retention` (phase 6). They are added HERE, in
 * phase 2, before any of them is emitted, so that the first line of phase 5
 * that writes `git.command` fails `docs-parity` until it also writes the row —
 * rather than the scan being widened later, by which time there are forty
 * undocumented names and widening it is a chore somebody defers.
 */
const EVENT_LITERAL = /'((?:phase|run|policy|git|http|engine|shell|msg|issue|retention)\.[a-z0-9][a-z0-9.-]*)'/g;
/**
 * `debug` joins the three levels whose first argument is a documented name.
 *
 * It is not a lesser level with lesser rules: `PHASE_CONSOLE_LOG_LEVEL=debug`
 * is exactly what an operator turns on when something has gone wrong, so a
 * debug line whose name no document explains is an undocumented name at the
 * one moment somebody is reading the log.
 */
const LOG_CALL = /\blog\.(?:info|warn|error|debug)\(\s*'([^']+)'/g;
const ONWARN_CALL = /\bon(?:Warn|Info)\??\.?\(\s*'([^']+)'/g;
/** A sink call whose first argument opens a template literal — the composed name the rule refuses. */
const COMPOSED_EVENT = /\b(?:log\.(?:info|warn|error|debug)|this\.(?:record|note)|journal\.append|deps\.journal|on(?:Warn|Info)\??\.?)\(\s*`/g;

function serverSources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      out.push({ rel: full.slice(root.length), text: readFileSync(full, 'utf8') });
    }
  };
  walk(join(root, 'viewer/server'));
  // The fleet supervisor's own entry point writes the same log (Pro; absent from the free tree).
  if (existsSync(join(root, 'viewer/fleet'))) walk(join(root, 'viewer/fleet'));
  return out;
}

function emittedEvents(): Set<string> {
  const out = new Set<string>();
  for (const { text } of serverSources()) {
    for (const re of [EVENT_LITERAL, LOG_CALL, ONWARN_CALL]) {
      for (const m of text.matchAll(re)) out.add(m[1]);
    }
  }
  return out;
}

type EventRow = { sink: string; emitter: string; meaning: string; retired: string | null };

function eventRows(): Map<string, EventRow> {
  const out = new Map<string, EventRow>();
  for (const line of read('docs/journal-events.md').split('\n')) {
    const row = /^\|\s*`([^`]+)`\s*\|\s*(journal|log|both)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!row) continue;
    const retired = /^retired\s+(\d+\.\d+\.\d+)$/.exec(row[3])?.[1] ?? null;
    out.set(row[1], { sink: row[2], emitter: row[3], meaning: row[4], retired });
  }
  return out;
}

/** The LIVE rows, name → meaning; a retired row is `retiredEvents()`'s answer instead. */
function documentedEvents(): Map<string, string> {
  return new Map([...eventRows()].filter(([, row]) => !row.retired).map(([name, row]) => [name, row.meaning]));
}

/** The retired rows, name → the version that retired the event. */
function retiredEvents(): Map<string, string> {
  return new Map([...eventRows()].filter(([, row]) => row.retired).map(([name, row]) => [name, row.retired!]));
}

test('every event the server writes — journal or log — has a row in docs/journal-events.md', () => {
  const documented = documentedEvents();
  const undocumented = [...emittedEvents()].filter((ev) => !documented.has(ev)).sort();
  assert.deepEqual(undocumented, [],
    'these event kinds are written and documented nowhere — add a row to docs/journal-events.md');
});

test('and every live row in docs/journal-events.md names an event that exists', () => {
  const emitted = emittedEvents();
  const stale = [...documentedEvents().keys()].filter((ev) => !emitted.has(ev)).sort();
  assert.deepEqual(stale, [],
    'these rows describe events nothing writes any more — mark each `retired <version>` in the emitter column; never delete a row');
});

test('a retired event stays retired: nothing under server/ writes it, and its row keeps a version', () => {
  const retired = retiredEvents();
  assert.ok(retired.has('run.auto-recover-skipped'),
    'the one retirement the audit found (65 hub journal lines, no emitter since 3.0.0) must be recorded, not deleted');
  const emitted = emittedEvents();
  const back = [...retired.keys()].filter((ev) => emitted.has(ev)).sort();
  assert.deepEqual(back, [], 'these events are documented as retired and written anyway — un-retire the row');
  for (const [name, version] of retired) assert.match(version, /^\d+\.\d+\.\d+$/, name);
});

test('no event name under server/ is composed at runtime', () => {
  const offenders: string[] = [];
  for (const { rel, text } of serverSources()) {
    for (const m of text.matchAll(COMPOSED_EVENT)) {
      offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [],
    'an event name built from a template literal can never have a row — write the literals out '
    + '(`runner-control.ts` withdrawQueued did this with `run.${why}-withdrew`, and `registry-file.ts` with `${what}.downgrade`)');
});

test("the three withdrawal records are reachable from withdrawQueued's own union", () => {
  const source = read('viewer/server/runner/runner-control.ts');
  const union = /withdrawQueued\(why:\s*((?:'[a-z]+'\s*\|\s*)+'[a-z]+')\)/.exec(source);
  assert.ok(union, 'withdrawQueued no longer declares its `why` as a union of literals');
  const whys = union[1].match(/'([a-z]+)'/g)!.map((w) => w.replace(/'/g, '')).sort();
  assert.deepEqual(whys, ['halt', 'park', 'pause']);
  const documented = documentedEvents();
  for (const why of whys) {
    const name = `run.${why}-withdrew`;
    assert.ok(source.includes(`'${name}'`), `${name} is not written as a literal in runner-control.ts`);
    assert.ok(documented.has(name), `${name} has no row in docs/journal-events.md`);
  }
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

/* ------------------------------------------------------------------ *
 * 11. Spelled-out counts, the halt-kind lists, and the axis a word belongs to (LFC-10)
 * ------------------------------------------------------------------ */

/**
 * Six sentences in the vocabulary's own prose were untrue when the audit read
 * them — "seventeen words" over an array of eighteen, "ELEVEN kinds, and for
 * the other nine" over 11 + 7, `settleRung` given four outcomes of seven, a
 * fold justified by run files the loader never loads, a status glossed as
 * signed-off that a person still owes, and a Stop promised to write a word one
 * axis holds and another folds away. Each was a count or a claim written down
 * beside the list it described and never read against it again.
 *
 * So: a spelled-out count in `shared/*.js` docblocks or in `docs/loop.md` is
 * either REGISTERED here against the list it describes — and asserted equal —
 * or named as an anecdote that counts no list. A new number word beside a
 * vocabulary noun that is neither fails by file and line.
 */
type SpelledCount = { file: string; find: RegExp; expect: readonly number[]; what: string };

/** How many vocabularies the "policy words" banner in run-lifecycle.js actually covers — the `export const` between it and the next banner. */
function policyWordLists(): number {
  const body = read('viewer/shared/run-lifecycle.js');
  // The BANNER line, not the header docblock's sentence that uses the same words.
  const start = body.search(/^ \* The \w+ policy words an operator sets$/m);
  assert.ok(start >= 0, 'run-lifecycle.js lost its "policy words an operator sets" banner');
  const next = body.indexOf('/* ----', start);
  return (body.slice(start, next < 0 ? undefined : next).match(/^export const \w+ = Object\.freeze\(/gm) ?? []).length;
}

/**
 * The rows of evidence-model.js's own V-table — the "verification states" its
 * docblock counts. Two or more spaces after the asterisk is the table's
 * indentation; the prose below it ("V5 folds into `green`…") has one. The
 * "six QA ones" in the same sentence are recorded SHAPES with no table and no
 * list, so only the verification count is pinned.
 */
function evidenceShapes(prefix: 'V'): number {
  return (read('viewer/shared/evidence-model.js').match(new RegExp(`^ \\*\\s{2,}${prefix}\\d\\s`, 'gm')) ?? []).length;
}

const SPELLED_COUNTS: SpelledCount[] = [
  { file: 'viewer/shared/issues-model.js', find: /(\w+) states because each one is a different thing/, expect: [ISSUE_STATES.length], what: 'ISSUE_STATES' },
  { file: 'viewer/shared/message-model.js', find: /(\w+) kinds and not (\w+), because a note/, expect: [MESSAGE_KINDS.length, MESSAGE_KINDS.length - 1], what: 'MESSAGE_KINDS' },
  { file: 'viewer/shared/message-model.js', find: /the same ([\w-]+)-word vocabulary a run's admission class/, expect: [MESSAGE_PRIORITIES.length], what: 'MESSAGE_PRIORITIES (= RUN_PRIORITIES)' },
  { file: 'viewer/shared/message-model.js', find: /line's (\w+) words\./, expect: [MESSAGING_WORDS.length], what: 'MESSAGING_WORDS' },
  { file: 'viewer/shared/decisions-model.js', find: /The (\w+) keys — a closed vocabulary/, expect: [DECISION_KEYS.length], what: 'DECISION_KEYS' },
  { file: 'viewer/shared/attention-model.js', find: /(\w+) kinds, because the (\w+) need different things/, expect: [RULING_KINDS.length, RULING_KINDS.length], what: 'RULING_KINDS' },
  { file: 'viewer/shared/attention-model.js', find: /`qa` rows on the (\w+) QA situations/, expect: [SITUATIONS.filter((s) => s.startsWith('qa-')).length], what: 'the qa-* SITUATIONS' },
  { file: 'viewer/shared/evidence-model.js', find: /distinguish (\w+) verification states and \w+ QA ones/, expect: [evidenceShapes('V')], what: "the V-table rows in the file's own docblock" },
  { file: 'viewer/shared/evidence-model.js', find: /FIELDS are (\w+) words each/, expect: [VERIFICATION_WORDS.length], what: 'VERIFICATION_WORDS (and QA_WORDS, asserted equal below)' },
  { file: 'viewer/shared/evidence-model.js', find: /(\w+) words wide and a surface/, expect: [VERIFICATION_WORDS.length], what: 'VERIFICATION_WORDS' },
  { file: 'viewer/shared/evidence-model.js', find: /The engine's (\w+) bucket words plus `unknown`/, expect: [BOARD_BUCKETS.length], what: 'BOARD_BUCKETS' },
  { file: 'viewer/shared/evidence-model.js', find: /folded into the (\w+) words\./, expect: [VERIFICATION_WORDS.length], what: 'VERIFICATION_WORDS' },
  { file: 'viewer/shared/run-lifecycle.js', find: /The (\w+) policy words an operator sets/, expect: [policyWordLists()], what: 'the vocabularies under that banner' },
  { file: 'viewer/shared/recovery-model.js', find: /retype the ([\w-]+) words/, expect: [HALT_KINDS.length], what: 'HALT_KINDS' },
  { file: 'viewer/shared/fact-map.js', find: /a ([\w-]+)-word table/, expect: [HALT_KINDS.length], what: 'HALT_KINDS' },
  { file: 'viewer/shared/fact-map.js', find: /(\w+) words, and `complete` is the one/, expect: [Object.keys(DECLARED_SITUATION).length], what: 'DECLARED_SITUATION' },
  {
    file: 'viewer/shared/plan-vocab.js', find: /(\w+) words: (\w+) open, (\w+) terminal/,
    expect: [PLAN_STATUSES.length, PLAN_STATUSES.length - CLOSED_PLAN_STATUSES.length, CLOSED_PLAN_STATUSES.length],
    what: 'PLAN_STATUSES / CLOSED_PLAN_STATUSES',
  },
  { file: 'viewer/shared/plan-vocab.js', find: /The (\w+) TERMINAL statuses/, expect: [CLOSED_PLAN_STATUSES.length], what: 'CLOSED_PLAN_STATUSES' },
  { file: 'viewer/shared/plan-vocab.js', find: /agrees on these (\w+) words/, expect: [HANDOFF_STATUSES.length], what: 'HANDOFF_STATUSES' },
  { file: 'viewer/shared/plan-vocab.js', find: /the (\w+) writable statuses/, expect: [HANDOFF_STATUSES.length], what: 'HANDOFF_STATUSES' },
  { file: 'viewer/shared/plan-vocab.js', find: /the (\w+) words `qa-record\.sh` will write/, expect: [QA_RESULTS.length], what: 'QA_RESULTS' },
  { file: 'viewer/shared/run-lifecycle.js', find: /(\w+) words, against `RUN_STATUSES`' (\w+)/, expect: [RUN_LIFECYCLE_STATES.length, RUN_STATUSES.length], what: 'RUN_LIFECYCLE_STATES / RUN_STATUSES' },
  { file: 'viewer/shared/run-lifecycle.js', find: /(\w+) words against `PHASE_STATUSES`' (\w+)/, expect: [PHASE_LIFECYCLE_STATES.length, PHASE_STATUSES.length], what: 'PHASE_LIFECYCLE_STATES / PHASE_STATUSES' },
  { file: 'viewer/shared/run-lifecycle.js', find: /the (\w+) transition words, as the/, expect: [RUN_PENDING_ACTS.length], what: 'RUN_PENDING_ACTS' },
  { file: 'viewer/shared/run-lifecycle.js', find: /for the (\w+) statuses that are one/, expect: [RUN_PENDING_ACTS.length], what: 'RUN_PENDING_ACTS (the three pending statuses)' },
  { file: 'viewer/shared/run-lifecycle.js', find: /the (\w+) words that are not `off`/, expect: [ULTRA_REVIEW_MODES.length - 1], what: 'ULTRA_REVIEW_MODES minus off' },
  { file: 'viewer/shared/run-lifecycle.js', find: /(\w+) doors: \w+ are\b/, expect: [START_DOORS.length], what: 'START_DOORS' },
  // The census's split: nine `startRun` callers lead the list, the rest spawn some other way.
  { file: 'viewer/shared/run-lifecycle.js', find: /the (\w+) `startRun` doors first, then the (\w+) that are not/, expect: [9, START_DOORS.length - 9], what: 'START_DOORS split' },
  { file: 'viewer/shared/status-vocab.js', find: /one of (\w+) UI states/i, expect: [UI_STATES.length], what: 'UI_STATES' },
  { file: 'viewer/shared/status-vocab.js', find: /`RunStatus`, (\w+) words/, expect: [RUN_STATUSES.length], what: 'RUN_STATUSES' },
  { file: 'viewer/shared/status-vocab.js', find: /`PhaseStatus`, (\w+) words/, expect: [PHASE_STATUSES.length], what: 'PHASE_STATUSES' },
  { file: 'viewer/shared/status-vocab.js', find: /\* (\w+) words that LOOK like board states/, expect: [BOARD_OVERLAY_STATES.length], what: 'BOARD_OVERLAY_STATES' },
  { file: 'viewer/shared/status-vocab.js', find: /The (\w+) words the CONSOLE paints as board states/, expect: [BOARD_OVERLAY_STATES.length], what: 'BOARD_OVERLAY_STATES' },
  { file: 'viewer/shared/status-vocab.js', find: /for the (\w+) PAINT keys/, expect: [Object.keys(BOARD_STATE_UI).length], what: 'BOARD_STATE_UI' },
  { file: 'viewer/shared/status-vocab.js', find: /over the (\w+) buckets/, expect: [BOARD_BUCKETS.length], what: 'BOARD_BUCKETS' },
  { file: 'viewer/shared/status-vocab.js', find: /The (\w+) vehicles a live phase/, expect: [PHASE_ACTORS.length], what: 'PHASE_ACTORS' },
  { file: 'viewer/shared/status-vocab.js', find: /The (\w+) transition words fold/, expect: [RUN_PENDING_ACTS.length], what: 'RUN_PENDING_ACTS' },
  { file: 'viewer/shared/task-model.js', find: /The (\w+) states a task is in/, expect: [TASK_STATUSES.length], what: 'TASK_STATUSES' },
  { file: 'viewer/shared/orchestration-model.js', find: /Only the (\w+) words, spelled exactly/, expect: [RUN_PRIORITIES.length], what: 'RUN_PRIORITIES' },
  { file: 'viewer/shared/ops-vocab.js', find: /(\w+) states, one machine/, expect: [ENTITLEMENT_STATES.length], what: 'ENTITLEMENT_STATES' },
  { file: 'docs/loop.md', find: /\*\*one\*\* of (\w+) words/, expect: [SITUATIONS.length], what: 'SITUATIONS' },
  { file: 'docs/loop.md', find: /\*\*(\w+) states, and one of them is not a state/, expect: [WATCH_STATES.length], what: 'WATCH_STATES' },
];

/**
 * Number words beside a vocabulary noun that describe NO list: history ("was
 * spelled out three times"), a pair of code paths, the skill's three modes.
 * Each is named so the sweep below stays exhaustive over everything else.
 */
const COUNT_ANECDOTES: { file: string; find: RegExp }[] = [
  { file: 'viewer/shared/attention-model.js', find: /holds the two identical, word for word/ },
  { file: 'viewer/shared/attention-model.js', find: /Two reasons, both measured/ },
  { file: 'viewer/shared/attention-model.js', find: /two signal\/kind pairs/ },
  { file: 'viewer/shared/evidence-model.js', find: /which of the two kinds of waiting this is/ },
  { file: 'viewer/shared/ladder-model.js', find: /two rungs on the same vehicle/ },
  { file: 'viewer/shared/ladder-model.js', find: /two situations shared a vehicle/ },
  { file: 'viewer/shared/phase-model.js', find: /the two verbs that START work/ },
  { file: 'viewer/shared/plan-vocab.js', find: /the two words\?/ },
  { file: 'viewer/shared/plan-vocab.js', find: /It has two members/ },
  { file: 'viewer/shared/plan-vocab.js', find: /the two words that definitely mean/ },
  { file: 'viewer/shared/recovery-model.js', find: /five word-books/ },
  { file: 'viewer/shared/recovery-model.js', find: /three QA(?:-recovery)? verbs/ },
  { file: 'viewer/shared/recovery-model.js', find: /The three verbs are offered/ },
  { file: 'viewer/shared/run-lifecycle.js', find: /drifted to four members/ },
  { file: 'viewer/shared/run-settings.js', find: /Two doors accept run settings/ },
  { file: 'viewer/shared/run-settings.js', find: /two-rung cap/ },
  { file: 'viewer/shared/task-model.js', find: /one of its two doors/ },
  { file: 'docs/loop.md', find: /[Tt]hree modes/ },
  { file: 'docs/loop.md', find: /The two QA rungs/ },
  { file: 'docs/loop.md', find: /evaluates three signals against it/ },
];

// `(?<![\w-])`, not `\b`, on the left: "thirty-nine keys" must not read as
// "nine keys" — a hyphenated bigger number is a different number.
const COUNT_SWEEP = new RegExp(
  `(?<![\\w-])(${Object.keys(CATEGORY_COUNT_WORDS).sort((a, b) => b.length - a.length).join('|')})\\b(?:-word)?[^.;\\n]{0,14}?\\b`
  + '(words?|kinds?|members?|statuses|situations?|outcomes?|reasons?|buckets?|verbs?|states?|keys|signals?|vehicles?|rungs?|doors?|modes?|policies|classes)\\b',
  'gi',
);

function countSweepFiles(): string[] {
  return [
    ...readdirSync(join(root, 'viewer/shared')).filter((f) => f.endsWith('.js')).map((f) => `viewer/shared/${f}`),
    'docs/loop.md',
  ];
}

test('every spelled-out count in shared/*.js and docs/loop.md is asserted against its list, or named as an anecdote', () => {
  const unregistered: string[] = [];
  for (const file of countSweepFiles()) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (!line.match(COUNT_SWEEP)) return;
      const known = [...SPELLED_COUNTS, ...COUNT_ANECDOTES].some((e) => e.file === file && e.find.test(line));
      if (!known) unregistered.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(unregistered, [],
    'a spelled-out count beside a vocabulary noun must be registered in SPELLED_COUNTS (asserted against its list) '
    + `or named in COUNT_ANECDOTES:\n  ${unregistered.join('\n  ')}`);
});

test('and every registered count reads the length of the list it describes', () => {
  for (const entry of SPELLED_COUNTS) {
    const body = read(entry.file);
    const hits = [...body.matchAll(new RegExp(entry.find.source, `gm${entry.find.flags.replace(/[gm]/g, '')}`))];
    assert.equal(hits.length, 1, `${entry.file}: expected exactly one sentence matching ${entry.find} (${entry.what}), found ${hits.length}`);
    entry.expect.forEach((expected, i) => {
      const word = hits[0][i + 1].toLowerCase();
      assert.equal(CATEGORY_COUNT_WORDS[word], expected,
        `${entry.file} says "${hits[0][0]}" — ${entry.what} has ${expected}, and "${word}" is ${CATEGORY_COUNT_WORDS[word] ?? 'not a number word this test knows'}`);
    });
  }
  for (const entry of COUNT_ANECDOTES) {
    assert.ok(entry.find.test(read(entry.file)), `${entry.file}: the anecdote ${entry.find} is gone — drop it from COUNT_ANECDOTES`);
  }
  // "five words each" is one number for two lists.
  assert.equal(QA_WORDS.length, VERIFICATION_WORDS.length, 'evidence-model.js says the two badge fields are the same width');
});

test('docs/loop.md names every rung outcome where it describes settleRung', () => {
  const body = read('docs/loop.md');
  const sentence = /settled\s+when the session ends \(`settleRung`[\s\S]*?remembers it tried\./.exec(body);
  assert.ok(sentence, 'the settleRung sentence moved — it used to give four outcomes of seven (LFC-10)');
  for (const outcome of RUNG_OUTCOMES) {
    assert.ok(sentence[0].includes(`\`${outcome}\``), `docs/loop.md's settleRung sentence omits \`${outcome}\``);
  }
});

test('RCV-11: every rung label docs/loop.md prints appears verbatim in shared/ladder-model.js, and every table row has a driver column', () => {
  // `loop.md:159` called `plan-broken`'s second rung "Repair the plan with a
  // repair session" against the built "…with a new agent", and the wait row
  // promised `recheck-watch`, a rung no driver owned. The table is read as
  // data: every bold label in the ladder table is a label the model carries.
  const body = read('docs/loop.md');
  const start = body.indexOf('| situation | rungs, in climb order');
  assert.ok(start > 0, 'the ladder table moved');
  const table = body.slice(start, body.indexOf('**Caps**', start));
  const rows = table.split('\n').filter((line) => line.startsWith('| `'));
  assert.ok(rows.length >= 20, `the table has ${rows.length} rows`);
  const labels = new Set(Object.values(RUNGS_BY_SITUATION).flatMap((rungs) => rungs.map((rung) => rung.label)));
  const printed: string[] = [];
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    assert.equal(cells.length, 5, `three columns (situation, rungs, driver): ${row.slice(0, 60)}`);
    for (const m of cells[2].matchAll(/\*\*([^*]+)\*\*/g)) printed.push(m[1]);
    // The driver column: a `·`-separated list of driver words, or `—` for an empty table.
    const drivers = cells[3];
    if (drivers !== '—') {
      for (const word of drivers.split('·').map((w) => w.trim())) {
        assert.ok((RUNG_DRIVERS as readonly string[]).includes(word), `${cells[1]}: driver ${word}`);
      }
    }
  }
  const unknown = printed.filter((label) => !labels.has(label));
  assert.deepEqual(unknown, [], `labels the model does not carry: ${unknown.join(' · ')}`);
  assert.ok(printed.includes('Repair the plan with a new agent'));
  assert.ok(printed.includes('Watched by the clock'));
  // Every table the model has with rungs prints its rows' labels.
  for (const [key, rungs] of Object.entries(RUNGS_BY_SITUATION)) {
    for (const rung of rungs) assert.ok(printed.includes(rung.label), `${key}'s "${rung.label}" is not in docs/loop.md`);
  }
});

test('docs/loop.md lists the two halt-kind sides member for member', () => {
  const body = read('docs/loop.md');
  const listed = (name: string): string[] => {
    const m = new RegExp(`\`${name}\` \\(((?:\`[a-z-]+\`(?:\\s*·\\s*)?)+)\\)`).exec(body);
    assert.ok(m, `docs/loop.md no longer lists ${name} in parentheses`);
    return m[1].match(/`([a-z-]+)`/g)!.map((w) => w.replace(/`/g, '')).sort();
  };
  assert.deepEqual(listed('PHASE_HALT_KINDS'), [...PHASE_HALT_KINDS].sort());
  assert.deepEqual(listed('RUN_HALT_KINDS'), [...RUN_HALT_KINDS].sort());
});

test('docs/controls.md names `interrupted` only beside the axis that holds it', () => {
  // `interrupted` is a STATUS word; the lifecycle STATE folds it to `failed`.
  // The sentence that promised "never `failed`" was about the other axis, and
  // a 4.1.0 record reads `lifecycle.state: 'failed'` beside `status:
  // 'interrupted'` — both true, one promise broken. A doc sentence naming the
  // word names its axis.
  const offenders = read('docs/controls.md').split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('`interrupted`') && !/\bstatus\b/i.test(line));
  assert.deepEqual(offenders.map((o) => `docs/controls.md:${o.n}`), [],
    'a sentence naming `interrupted` must say it is the STATUS axis (the lifecycle state folds it to `failed`)');
});

/* ------------------------------------------------------------------ *
 * Trust as built (zero-touch-console phase 13): the sentences that promise a
 * person a tap, and the vocabulary the CLI notifies in
 * ------------------------------------------------------------------ */

/** One `## ` section of a markdown body, heading to the next heading. */
const section = (body: string, heading: string): string => {
  const start = body.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const next = body.indexOf('\n## ', start + 4);
  return body.slice(start, next < 0 ? undefined : next);
};

test('ACC-8.7 (LFC-9, TRS-4): the carve-out\'s "one tap" sentences say what the code does — auto-grant never answers either publishing ask, and only a plan exception does', async () => {
  const { OPEN_PR_ASK, QUESTION_CLASS } = await import('../server/runner/approvals.ts');
  const { destructiveExceptions } = await import('../shared/policy-model.js');
  const guide = read('viewer/client/src/content/guide/permissions.md');
  const commands = OPEN_PR_ASK.map((rule) => /^Bash\((.+):\*\)$/.exec(rule)![1]);
  for (const name of ['The push carve-out', 'Auto-grant approvals']) {
    const body = section(guide, name);
    for (const command of commands) assert.ok(body.includes(`\`${command}\``), `permissions.md §${name} names \`${command}\``);
    assert.match(body, /[Aa]uto-grant never answers/, `permissions.md §${name} says auto-grant never answers it`);
    assert.match(body, /permission\.destructive/, `permissions.md §${name} names the one exception`);
  }
  // The exception example the guide prints is one the grammar actually reads.
  const example = /``\s*(deny; allow `[^`]+`)\s*``/.exec(section(guide, 'Auto-grant approvals'))?.[1];
  assert.ok(example, 'the guide prints an exception example');
  assert.ok(destructiveExceptions(example!).some((rule) => (OPEN_PR_ASK as readonly string[]).includes(rule)),
    `the printed example "${example}" grants a publishing rule under destructiveExceptions`);
  // …and the profile sentences: no profile silences a question.
  const profiles = section(guide, 'Permission profiles');
  for (const tool of QUESTION_CLASS) assert.ok(profiles.includes(`\`${tool}\``), `permissions.md names the question class member \`${tool}\``);
  assert.match(profiles, /No profile silences a question/);
  // safety-rails.md makes the same promise, and keeps it.
  const rails = read('docs/safety-rails.md');
  assert.match(rails, /one human tap — auto-grant never answers either card/);
});


test('ACC-7.5 (REG-8): every notification_type the CLI documents is mapped, answers a wait, or is ignored on purpose — and the hook-install help says four entries', async () => {
  const { NOTIFICATION_WAIT_KINDS, NOTIFICATION_ANSWERS, NOTIFICATION_IGNORED } = await import('../server/sessions/registry.ts');
  const { HOOK_EVENTS } = await import('../server/hooks-install.ts');
  // The hooks reference's Notification table, 2026-09 (CLI 2.1.272) — contract row 29's families:
  // permission, idle, auth, elicitation, agent and quota.
  const documented = [
    'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
    'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed',
    'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
  ];
  for (const type of documented) {
    const homes = [type in NOTIFICATION_WAIT_KINDS, type in NOTIFICATION_ANSWERS, NOTIFICATION_IGNORED.includes(type)]
      .filter(Boolean).length;
    assert.equal(homes, 1, `'${type}' is in exactly one of the wait map, the answers map and the ignored list`);
  }
  assert.equal(HOOK_EVENTS.length, 4);
  // In the free tree `bin/phase-console.mjs` IS the override, and `free/` does not ship.
  const bins = ['bin/phase-console.mjs'];
  for (const file of bins) {
    assert.match(read(file), /`install-hooks` writes four entries \(SessionStart, SessionEnd, Stop, Notification\)/, `${file} says what install-hooks writes`);
  }
  const loop = read('docs/loop.md');
  for (const word of ['`Notification`', '`notification_type`', '`waiting', '`lastWait', '`WAIT_ANSWER_CAP_MS`']) {
    assert.ok(loop.includes(word), `docs/loop.md's presence section names ${word}`);
  }
});
