/**
 * The SKILL's documents, asserted against the console's code.
 *
 * `docs-parity.test.ts` pins the *product* docs — `docs/`, the in-app guide, the
 * three EN/FA pairs' structure. It deliberately stops at prose meaning, and it
 * never reads `SKILL.md` for anything but backticked paths. But `SKILL.md` and
 * `references/*.md` are the documents a SESSION is booted with: they are not
 * marketing about the console, they are the instructions a model follows, and a
 * false sentence there is executed rather than merely read.
 *
 * Phase 10 of phase-console-commerce inventoried every mechanical claim those
 * documents make and found the drift had the shape it always has — a count that
 * outlived the thing counted, a list that was complete on the day it was
 * written, a behaviour that was reversed in code and left standing in prose:
 *
 *   - the worktree paragraph still said linked worktrees "refuse on a
 *     superproject … so a monorepo-of-submodules plan gains nothing", six months
 *     after `runner/worktree.ts` grew the MIRROR that mounts the sub-repositories
 *     a scope names. A session reading it would not ask for lanes it can have.
 *   - `--lint` was documented as gating on three things when it gates on five
 *     (F20's table shape and F21's unbelievable cells arrived later, and both
 *     are explicitly "F1 tier").
 *   - `phase-outcome.sh` grew a sixth status (`no-defect`) and the documents —
 *     and the script's own header comment — went on saying five.
 *   - `phase-lane.sh` shipped, was used in Mode 2, and never reached the
 *     §Helper scripts list that is supposed to be the complete one.
 *
 * WHAT THIS DOES NOT CHECK, so a later phase knows what stays hand-maintained:
 * prose meaning, whether an explanation is a GOOD explanation, the Persian
 * translations' fluency (only that they carry the same untranslatable tokens —
 * `docs-parity.test.ts` owns their structure), and any claim about behaviour
 * that nothing in code names. The rule for extending this file is the rule that
 * produced it: assert only what the code can be asked, and derive the expected
 * value from the code rather than restating it here — a guard that hardcodes the
 * number it is guarding is a second copy of the drift.
 */

// Sandbox first: the directive below is read from the runner itself.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { unattendedDirective } from '../server/runner/runner-core.ts';
import { DEFAULT_WAIT_BUDGET_MS, WAIT_MAX_PER_PHASE } from '../server/runner/wait-budget.ts';
import { fileURLToPath } from 'node:url';

import { SITUATIONS, EXIT_SUB_KINDS } from '../shared/situation-model.js';
import { RUNG_VEHICLES } from '../shared/ladder-model.js';
import { MECHANISMS, HALT_KINDS, RECOVERY_CLASSES, ACTION_VOCAB } from '../shared/recovery-model.js';
import { BOARD_BUCKETS, WAIT_REASONS } from '../shared/status-vocab.js';
import { HANDOFF_STATUSES, QA_RESULTS, QA_MODES, GATE_KINDS } from '../shared/plan-vocab.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, 'utf8');

/** Number words the documents actually use when they state a count in prose. */
const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Fenced blocks stripped — a sample plan's `--allow-x` is an example, not a claim. */
const stripFences = (body: string): string => body.replace(/^```[\s\S]*?^```/gm, '');

const referenceDocs = (): string[] =>
  readdirSync(`${root}references`).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`);

/**
 * The documents a SESSION is booted with, as opposed to the ones an operator
 * browses. This is the set whose falsehoods get executed.
 */
const SESSION_DOCS = (): string[] => ['SKILL.md', ...referenceDocs()];

/* ------------------------------------------------------------------ *
 * 1. Capability flags
 * ------------------------------------------------------------------ */

/**
 * Lifted from config.ts's own CAPABILITY_FLAGS table — the same source
 * `docs-parity.test.ts` reads, on purpose. That file asks whether the GUIDE is
 * right; this one asks whether the SKILL is, and they must not disagree about
 * where the truth lives.
 */
const capabilityFlags = (): string[] => {
  const src = read('viewer/server/config.ts');
  const block = src.slice(src.indexOf('const CAPABILITY_FLAGS'));
  return [...new Set(block.slice(0, block.indexOf('];')).match(/--allow-[a-z-]+/g) ?? [])].sort();
};

test('SKILL.md names every capability flag and states the right count', () => {
  const flags = capabilityFlags();
  assert.ok(flags.length >= 5, 'CAPABILITY_FLAGS did not parse out of config.ts');

  const skill = read('SKILL.md');
  for (const flag of flags) {
    assert.ok(skill.includes(`\`${flag}\``), `SKILL.md never names ${flag}`);
  }

  // "Seven flags each unlock one act, and all seven default off." The count is
  // stated twice in that one sentence, which is why the pattern takes both.
  const patterns = [
    /\b(two|three|four|five|six|seven|eight|nine|ten)\s+flags\b/gi,
    /\ball\s+(two|three|four|five|six|seven|eight|nine|ten)\s+default\s+off\b/gi,
  ];
  let stated = 0;
  for (const pattern of patterns) {
    for (const [, word] of skill.matchAll(pattern)) {
      stated++;
      assert.equal(
        WORDS[word.toLowerCase()], flags.length,
        `SKILL.md says '${word} flags'; config.ts has ${flags.length}`,
      );
    }
  }
  assert.ok(stated >= 2, `SKILL.md should state the flag count; found ${stated} statements`);
});

test('the flag that switches something OFF is never counted among the ones that switch things on', () => {
  // `--no-converge` is a real flag and is NOT a capability flag: it turns the
  // convergence loop's automatic triggers off. Counting it would make seven
  // eight, which is exactly the arithmetic that produced the "six"/"seven"
  // disagreement between SKILL.md and CLAUDE.md this phase closed.
  const flags = capabilityFlags();
  assert.ok(!flags.includes('--no-converge'), '--no-converge must not be a CAPABILITY_FLAG');
  assert.ok(
    read('viewer/server/config.ts').includes("'--no-converge'"),
    'config.ts must still parse --no-converge',
  );
  // Asserted as the arithmetic rather than as a phrasing: a document may
  // describe the flag however it likes, but it may not present it as one of the
  // capability flags — that is what would make the count wrong.
  for (const doc of ['SKILL.md', 'CLAUDE.md']) {
    const body = read(doc);
    assert.doesNotMatch(
      body, /--no-converge[^.\n]{0,80}\b(unlocks?|enables?|allows?) /i,
      `${doc} describes --no-converge as if it unlocked an act; it only switches one off`,
    );
  }
});

test('CLAUDE.md and SKILL.md agree with config.ts about how many flags there are', () => {
  const flags = capabilityFlags();
  for (const doc of ['CLAUDE.md', 'SKILL.md']) {
    const body = stripFences(read(doc));
    for (const [, word] of body.matchAll(
      /\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?:capability\s+)?(?:flags|switches)\b/gi,
    )) {
      assert.equal(
        WORDS[word.toLowerCase()], flags.length,
        `${doc} says '${word}' where config.ts has ${flags.length} capability flags`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. The scripts list
 * ------------------------------------------------------------------ */

const shippedScripts = (): string[] =>
  readdirSync(`${root}scripts`).filter((f) => f.endsWith('.sh')).sort();

/** SKILL.md's §Helper scripts section — the list that claims to be complete. */
const helperSection = (): string => {
  const skill = read('SKILL.md');
  const from = skill.indexOf('## Helper scripts');
  const to = skill.indexOf('## Guardrails');
  assert.ok(from > 0 && to > from, 'SKILL.md lost its §Helper scripts section');
  return skill.slice(from, to);
};

test('every script that ships is named in SKILL.md §Helper scripts', () => {
  // The section documents three classes and says so: verbs you call, the three
  // that are sourced or hooked rather than called, and the maintainer-only pair.
  // All three belong in the list — the failure this pins is `phase-lane.sh`,
  // which shipped, was cited in Mode 2, and never reached the section that is
  // supposed to be the complete one.
  const section = helperSection();
  for (const script of shippedScripts()) {
    assert.ok(
      section.includes(script),
      `scripts/${script} ships but SKILL.md §Helper scripts never names it`,
    );
  }
});

test('every script SKILL.md and references/ name actually exists', () => {
  const shipped = new Set(shippedScripts());
  // `run-tests.sh` lives in tests/, not scripts/ — the documents cite it as
  // `tests/run-tests.sh`, so it is matched by path rather than by bare name.
  const elsewhere = new Set(['run-tests.sh']);
  for (const doc of SESSION_DOCS()) {
    for (const m of read(doc).matchAll(/(?:scripts\/)([a-z0-9-]+\.sh)/g)) {
      assert.ok(
        shipped.has(m[1]) || elsewhere.has(m[1]),
        `${doc} cites scripts/${m[1]}, which does not exist`,
      );
    }
  }
});

/** SKILL.md's Mode 2 — the procedure a session follows while it is BUILDING. */
const mode2Section = (): string => {
  const skill = read('SKILL.md');
  const from = skill.indexOf('### Mode 2');
  const to = skill.indexOf('### Mode 3');
  assert.ok(from > 0 && to > from, 'SKILL.md lost its Mode 2 section');
  return skill.slice(from, to);
};


test('references/plan-format.md shows the Issues: line and the per-phase bullet as examples', () => {
  // Phase 2 wrote the directive's grammar; an author still needs to SEE the two
  // shapes — the plan-wide line and the phase's own override — to write one.
  const doc = read('references/plan-format.md');
  assert.match(doc, /\*\*Issues:\*\* (?:off|draft|file)\b/, 'no plan-wide `**Issues:** <word>` example');
  assert.match(doc, /- \*\*Issues:\*\* (?:off|draft|file)\b/, 'no per-phase `- **Issues:** <word>` example');
});

/* ------------------------------------------------------------------ *
 * 3. The CLI verbs
 * ------------------------------------------------------------------ */

/**
 * Every verb `bin/phase-console.mjs` answers to: the ones handled above the
 * tables, which never reach one and so cannot be read off one — plus, in this
 * tree, the two fleet tables themselves. The free bin is the five-verb
 * override: it has neither table, and `free-tree-shape.test.ts` (a proPath, so
 * it grades the free bin from outside) is what asserts they are gone.
 */
const consoleVerbs = (): Set<string> => {
  const bin = read('bin/phase-console.mjs');
  const early = [...bin.matchAll(/\[\s*'([a-z][a-z-]+)'\s*,\s*'--[a-z-]+'\s*\]\.includes\(args\[0\]\)/g)]
    .map((m) => m[1]);
  const trio = [...bin.matchAll(/\[\s*'(install-hooks)'\s*,\s*'(uninstall-hooks)'\s*,\s*'(hooks-status)'\s*\]/g)]
    .flatMap((m) => [m[1], m[2], m[3]]);
  // A verb with its own dispatch arm (`if (args[0] === 'sessions')` in both trees, two more in Pro) is as
  // real as a table entry. Reading only the tables sent a phase-20 doc to a spelling around a verb that exists.
  const dispatched = [...bin.matchAll(/args\[0\] === '([a-z][a-z-]+)'/g)].map((m) => m[1]);
  const verbs = new Set([...early, ...trio, ...dispatched]);
  return verbs;
};

test('the bin still answers to the verbs the documents send people to', () => {
  const verbs = consoleVerbs();
  // Sanity: the parse found what this tree's bin actually holds rather than an
  // empty slice. `install-skill` is in both trees; the fleet verbs are Pro.
  const sanity = ['install-skill'];
  for (const expected of sanity) {
    assert.ok(verbs.has(expected), `verb parse missed '${expected}' — the extractor drifted`);
  }

  const cited = new Set<string>();
  for (const doc of [...SESSION_DOCS(), 'CLAUDE.md', 'README.md', 'USAGE.md']) {
    // Two tightenings the public repository's NAME forced, since it is
    // `phased-execution-public/phase-console`: a slug is not the binary, so a
    // preceding `/` disqualifies the match, and a verb sits on the SAME line as
    // the command, so the gap is horizontal whitespace rather than `\s`. Without
    // the first, every mention of the repository read as a verb call; without
    // the second, the next line's first word did — which is how the rename made
    // `claude plugin marketplace add …/phase-console` demand a `claude` verb.
    for (const m of read(doc).matchAll(/(?<![\w/-])phase-console(?:\.mjs)?[ \t]+([a-z][a-z-]*)/g)) {
      cited.add(m[1]);
    }
  }
  // Words that follow the binary in prose rather than naming a verb.
  const prose = new Set(['is', 'and', 'or', 'to', 'the', 'a', 'can', 'runs', 'reads', 'home']);
  for (const verb of cited) {
    if (prose.has(verb)) continue;
    assert.ok(
      verbs.has(verb),
      `the documents say \`phase-console ${verb}\`, which the bin does not answer to`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 4. The lint ids
 * ------------------------------------------------------------------ */

/** The advisory ids `phase-graph.sh` actually prints — each one names itself. */
const emittedAdvisories = (): Set<string> => {
  const src = read('scripts/phase-graph.sh');
  return new Set([...src.matchAll(/printf '(F\d+) /g)].map((m) => m[1]));
};

/**
 * The GATING ids — the class that cannot be read off the output, because a
 * gating issue prints its sentence without an id.
 *
 * Derived rather than listed: `compute_issues` is the one function whose result
 * decides `--lint`'s exit code, so whatever it calls is what gates. Each of
 * those producers carries an `# Fnn:` header, and that header is the register.
 * Listing the ids here instead would make this guard a second copy of the very
 * thing it guards — which is how F20 and F21 came to be undocumented for their
 * whole existence while three older ids were recited everywhere.
 */
const documentedGating = (): Set<string> => {
  const src = read('scripts/phase-graph.sh');
  const from = src.indexOf('compute_issues() {');
  assert.ok(from > 0, 'phase-graph.sh no longer has compute_issues()');
  const body = src.slice(from, src.indexOf('\n}', from));
  const producers = [...body.matchAll(/^\s*(?:if )?([a-z_]+)\b/gm)]
    .map((m) => m[1])
    .filter((n) => !['return', 'if', 'then', 'fi', 'printf', 'while', 'read', 'done'].includes(n));

  const ids = new Set<string>();
  for (const fn of producers) {
    const at = src.indexOf(`\n${fn}() {`);
    if (at < 0) continue;
    // Walk back over the contiguous comment block that introduces it.
    const before = src.slice(0, at).split('\n');
    for (let i = before.length - 1; i >= 0 && before[i].startsWith('#'); i--) {
      for (const m of before[i].matchAll(/\bF(\d+)\b/g)) ids.add(`F${m[1]}`);
    }
  }
  return ids;
};

/**
 * Every F id the scripts know about at all — gating, advisory, and the
 * design-rule citations (`F5` single-source-of-truth, `F13` never hardcode a
 * home path) that are not lints but ARE part of the vocabulary a document may
 * legitimately cite. The point of this set is to catch an invented id.
 */
const knownFIds = (): Set<string> => {
  const ids = new Set<string>();
  for (const f of readdirSync(`${root}scripts`).filter((n) => n.endsWith('.sh'))) {
    for (const m of read(`scripts/${f}`).matchAll(/\bF(\d{1,2})\b/g)) ids.add(`F${m[1]}`);
  }
  return ids;
};

test('the advisory family the documents name is exactly the one the engine emits', () => {
  const emitted = emittedAdvisories();
  assert.ok(emitted.size >= 6, `expected several advisories, parsed ${emitted.size}`);

  const skill = read('SKILL.md');
  // SKILL.md states the family in ONE bolded span — `**advisory family F15–F19,
  // F22–F23, F28**` — of ranges and, since 5.1.0, standalone ids: F28 joined a
  // family that had been contiguous, and expanding ranges alone would have read
  // the new member as absent while it sat in the sentence being read.
  //
  // The span is what is parsed, and not the whole document, because the reverse
  // assertion below is the load-bearing one: every id NAMED must be emitted, and
  // sweeping standalone ids out of the whole file would collect F14 and F24 from
  // the gating sentence beside it and fail on lints that correctly do not warn.
  const span = /\*\*advisory family ([^*]+)\*\*/.exec(skill)?.[1] ?? '';
  const named = new Set<string>();
  for (const m of span.matchAll(/F(\d+)\s*[–-]\s*F?(\d+)/g)) {
    for (let n = Number(m[1]); n <= Number(m[2]); n++) named.add(`F${n}`);
  }
  for (const m of span.replace(/F\d+\s*[–-]\s*F?\d+/g, ' ').matchAll(/\bF(\d+)\b/g)) {
    named.add(`F${m[1]}`);
  }
  assert.ok(named.size > 0, 'SKILL.md no longer states the advisory family in one bolded span');

  for (const id of emitted) {
    assert.ok(named.has(id), `${id} is emitted as an advisory but SKILL.md's family omits it`);
  }
  for (const id of named) {
    assert.ok(emitted.has(id), `SKILL.md's advisory family claims ${id}, which nothing emits`);
  }
});

test('every F id the session documents cite is one the engine really has', () => {
  const known = knownFIds();
  assert.ok(known.has('F1') && known.has('F20'), 'the F register did not parse');
  for (const doc of SESSION_DOCS()) {
    for (const m of read(doc).matchAll(/\bF(\d{1,2})\b/g)) {
      assert.ok(
        known.has(`F${m[1]}`),
        `${doc} cites lint F${m[1]}, which phase-graph.sh neither emits nor registers`,
      );
    }
  }
});

test('SKILL.md names every GATING lint, not only the three that predate the rest', () => {
  // The claim under guard is the one `--lint`'s own description makes: what
  // makes it exit non-zero. F20 (the table's shape) and F21 (cells it could not
  // believe) are explicitly "F1 tier" in the engine and were missing from every
  // document for as long as they have existed.
  const skill = read('SKILL.md');
  for (const id of documentedGating()) {
    assert.ok(skill.includes(id), `SKILL.md never names gating lint ${id}`);
  }
});

/* ------------------------------------------------------------------ *
 * 5. phase-outcome.sh's statuses
 * ------------------------------------------------------------------ */

/** The statuses the script will actually accept, read off its own case arm. */
const outcomeStatuses = (): string[] => {
  const src = read('scripts/phase-outcome.sh');
  const m = src.match(/^\s*(complete\|[a-z|-]+)\)\s*:\s*;;/m);
  assert.ok(m, 'phase-outcome.sh no longer has a parseable status case arm');
  return m![1].split('|');
};

test('SKILL.md documents every outcome status the script accepts', () => {
  const statuses = outcomeStatuses();
  assert.ok(statuses.length >= 5, `parsed only ${statuses.length} statuses`);
  const skill = read('SKILL.md');
  for (const status of statuses) {
    assert.ok(skill.includes(status), `phase-outcome.sh accepts '${status}'; SKILL.md never says so`);
  }
});

test('nothing claims a status count the script disagrees with', () => {
  const n = outcomeStatuses().length;
  // The script's own header said "the five statuses above" while listing six —
  // a comment is a document too, and this is the one that misled the writers.
  for (const doc of [...SESSION_DOCS(), 'scripts/phase-outcome.sh']) {
    const body = read(doc);
    for (const m of body.matchAll(
      /\b(two|three|four|five|six|seven|eight)\s+(?:outcome\s+)?statuses\b(.{0,24})/gis,
    )) {
      // "the three statuses that PARK" is a true claim about a SUBSET, and the
      // documents make it deliberately. Only an unqualified count is a claim
      // about the whole vocabulary.
      if (/\b(that|which)\b/i.test(m[2])) continue;
      assert.equal(
        WORDS[m[1].toLowerCase()], n,
        `${doc} says '${m[1]} statuses'; phase-outcome.sh accepts ${n}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 6. The vocabularies
 * ------------------------------------------------------------------ */

/**
 * A vocabulary is guarded two ways, because the documents get them wrong two
 * ways: they misstate the COUNT, and they list the WORDS and miss one.
 */
const VOCABULARIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['BOARD_BUCKETS', BOARD_BUCKETS],
  ['HANDOFF_STATUSES', HANDOFF_STATUSES],
  ['QA_RESULTS', QA_RESULTS],
  ['QA_MODES', QA_MODES],
  ['GATE_KINDS', GATE_KINDS],
  ['WAIT_REASONS', WAIT_REASONS],
  ['SITUATIONS', SITUATIONS],
  ['EXIT_SUB_KINDS', EXIT_SUB_KINDS],
  ['RUNG_VEHICLES', RUNG_VEHICLES],
  ['RECOVERY_CLASSES', RECOVERY_CLASSES],
  ['MECHANISMS', Object.keys(MECHANISMS)],
  ['HALT_KINDS', HALT_KINDS],
  ['ACTION_VOCAB', Object.keys(ACTION_VOCAB)],
];

test('every vocabulary this file guards still exists and is non-empty', () => {
  for (const [name, words] of VOCABULARIES) {
    assert.ok(words.length > 0, `${name} is empty — the shared owner moved or was renamed`);
  }
});

test('the board buckets and handoff statuses SKILL.md lists are the shared owners\' own', () => {
  // These two are the load-bearing pair: the board's five buckets and the four
  // writable handoff words are different vocabularies that a reader conflates,
  // which is why SKILL.md spells both out and why both are pinned here.
  const skill = read('SKILL.md');
  for (const bucket of BOARD_BUCKETS) {
    assert.ok(
      new RegExp(`\`?${bucket}\`?`).test(skill),
      `board bucket '${bucket}' is never named in SKILL.md`,
    );
  }
  for (const status of HANDOFF_STATUSES) {
    assert.ok(skill.includes(status), `handoff status '${status}' is never named in SKILL.md`);
  }
  // Spelled as ONE backticked span with pipes inside — `complete | in-progress
  // | blocked | pending` — which is how SKILL.md writes it and how the order
  // stays visible. The order matters: it is the owner's, and `new-handoff.sh`
  // documents its default (`complete`) as the first of them.
  assert.match(
    skill, new RegExp(`\\*\\*\`${HANDOFF_STATUSES.join(' \\| ')}\`\\*\\*`),
    'SKILL.md no longer lists the writable handoff statuses in the owner\'s order',
  );
  for (const [, word] of skill.matchAll(/\b(two|three|four|five|six|seven|eight)\s+board\s+buckets?\b/gi)) {
    assert.equal(WORDS[word.toLowerCase()], BOARD_BUCKETS.length, `SKILL.md miscounts the board buckets`);
  }
});

test('the gate kinds and QA words the documents use are the ones the code has', () => {
  // Two different vocabularies that the documents (and this guard's first draft)
  // conflate: GATE_TYPES are the words a plan WRITES after `Gate-check:`, and
  // GATE_KINDS are the categories `--gate-kind` ANSWERS with. `manual` is a
  // type and never a kind; `human` is a kind and never a type. Both are read
  // from their own owner — scripts/gates.env is the single source the bash
  // engine and viewer/server/analysis/gates.ts already share.
  const types = new Set(
    (read('scripts/gates.env').match(/^GATE_TYPES="([^"]+)"/m)?.[1] ?? '').split(/\s+/).filter(Boolean),
  );
  assert.ok(types.size >= 8, 'GATE_TYPES did not parse out of scripts/gates.env');
  for (const doc of SESSION_DOCS()) {
    for (const m of read(doc).matchAll(/\bGate-check:\s*`?([a-z]+)/g)) {
      assert.ok(
        types.has(m[1]),
        `${doc} documents a Gate-check type '${m[1]}' that scripts/gates.env has no word for`,
      );
    }
  }
  for (const kind of GATE_KINDS) {
    assert.ok(read('SKILL.md').includes(kind), `gate kind '${kind}' is never named in SKILL.md`);
  }
  const skill = read('SKILL.md');
  for (const result of QA_RESULTS) {
    assert.ok(skill.includes(result), `QA result '${result}' is never named in SKILL.md`);
  }
  for (const mode of QA_MODES) {
    if (mode === 'unknown') continue; // an internal answer, never a plan directive
    assert.ok(skill.includes(mode), `QA mode '${mode}' is never named in SKILL.md`);
  }
});

/* ------------------------------------------------------------------ *
 * 7. The worktree story
 * ------------------------------------------------------------------ */

test('the worktree paragraph names the mirror, and no document still says a superproject gains nothing', () => {
  // `runner/worktree.ts` refuses a PLAIN linked worktree on a superproject and
  // then mounts the sub-repositories the scope names instead. Both halves must
  // survive an edit: a document that keeps only the refusal tells a session it
  // cannot have lanes it can have, and one that keeps only the mirror hides the
  // three refusals that are still real.
  const impl = read('viewer/server/runner/worktree.ts');
  for (const reason of ['has-submodules', 'root-scoped', 'scope-unmapped']) {
    assert.ok(impl.includes(reason), `worktree.ts no longer names the refusal '${reason}'`);
  }
  assert.match(impl, /MIRROR|mirror/, 'worktree.ts no longer implements a mirror');

  const planFormat = read('references/plan-format.md');
  assert.match(planFormat, /mirror/i, 'references/plan-format.md lost the mirror');

  const skill = read('SKILL.md');
  assert.match(
    skill, /mirror/i,
    'SKILL.md describes worktrees without naming the mirror — the stale refusal is back',
  );
  // The exact sentence the drift wore. Pinned as a phrase because the claim is
  // the *conclusion*, and a session acts on the conclusion.
  for (const doc of [...SESSION_DOCS(), 'CLAUDE.md']) {
    assert.doesNotMatch(
      read(doc), /monorepo-of-submodules plan gains nothing/i,
      `${doc} still tells a submodule plan that worktrees buy it nothing`,
    );
  }
});

test('the lane branch the documents promise is the one the code can actually create', () => {
  // `pe/<slug>/p4` is a name git cannot hold while `pe/<slug>` exists, so the
  // hyphen is load-bearing and every document that shows a lane branch shows it.
  const impl = read('viewer/server/runner/worktree.ts');
  assert.match(impl, /pe\/<slug>-p/, 'worktree.ts no longer documents the hyphenated lane branch');
  const skill = read('SKILL.md');
  assert.match(skill, /pe\/<slug>-p<N>/, 'SKILL.md no longer shows the hyphenated lane branch');
  assert.doesNotMatch(
    stripFences(skill).replace(/`pe\/<slug>\/p4` is impossible[^.]*\./g, ''),
    /`pe\/<slug>\/p\d`/,
    'SKILL.md shows a slash-separated lane branch as if it were creatable',
  );
});

test('the unattended contract states the wait ceiling beside the flag it bounds (WAI-2)', () => {
  // The session was told "the supervisor RESUMES THIS SESSION when the window
  // elapses" and nothing about a ceiling, which lived only in documents a
  // session is never given — so a correct 48-hour soak was cut to eight in silence.
  const shipped = unattendedDirective('/skill/scripts', 'soak', 16);
  assert.match(shipped, /--wait-minutes <realistic-window>/);
  assert.match(shipped, new RegExp(`at most ${WAIT_MAX_PER_PHASE} waits \\(WAIT_MAX_PER_PHASE\\)`), 'the per-phase cap, by name and value');
  assert.match(shipped, new RegExp(`${DEFAULT_WAIT_BUDGET_MS / 3_600_000}\\.0 h parked in total`), 'the budget\'s value');
  assert.match(shipped, /the console default/, 'and where it came from');
  assert.match(shipped, /REFUSED with a\s+`waiting-external-timeout` halt, never shortened/, 'and what happens past it');
  // The phase's own allowance is what the session reads when the plan set one.
  const planned = unattendedDirective('/skill/scripts', 'soak', 16, { budgetMs: 72 * 3_600_000, source: 'phase' });
  assert.match(planned, /72 h parked in total\s+\(this phase's `Waits on:` bullet\)/);
});
