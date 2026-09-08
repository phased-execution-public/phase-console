/**
 * NOTHING REMOVED — the payload contract, asserted field by field.
 *
 * Two read endpoints used to ship everything they knew to every caller.
 * Measured on the live hub library before this phase:
 *
 *   - `GET /api/plans/console-audit-hardening` — **286.5 KB** to render a
 *     table. `plan.sections` (64.7 KB) and every phase's `bullets` (57.1 KB)
 *     had zero readers anywhere in the client.
 *   - `GET /api/state` — one live run of a long plan is a **340 KB** record,
 *     `phases[].verification` alone 227 KB of it, and every page fetches this
 *     endpoint on every navigation.
 *
 * The fix is a projection, and a projection's whole risk is that it drops
 * something a page needed and nobody notices until that page is opened. So the
 * tests below are about REACHABILITY rather than about size:
 *
 *   1. `PRE_CHANGE_DETAIL_KEYS` / `PRE_CHANGE_PHASE_KEYS` are frozen
 *      inventories of what the response carried BEFORE this phase. Every entry
 *      must still be reachable through some documented `include`, and the test
 *      names the group that returns it. Delete a field for real and this fails,
 *      whatever the include set.
 *   2. `include=full` must be the union of every group — so an operator with
 *      `curl`, or a client older than this server, can always get the old shape
 *      back in one request.
 *   3. The board projection must be strictly smaller and must still carry
 *      everything the Route tab, the dashboard rows and the gate card read.
 *
 * The byte budgets in the exit criteria are asserted twice: on a synthetic
 * 23-phase plan here (so a plain `npm test` proves the projection), and against
 * the real corpus when `PHASE_CONSOLE_TEST_ROOT` names one.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  PLAN_INCLUDES, STATE_INCLUDES, PROSE_PHASE_FIELDS, DOCUMENT_PLAN_FIELDS, HANDOFF_PROSE_FIELDS,
  MEMORY_FIELDS, RUN_SUMMARY_DROP, RUN_SUMMARY_PHASE_DROP,
  parseInclude, wants, includeParam, omit, summarizeRun,
} = await import('../shared/projection.js');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

const KB = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null') / 1024;

/* ------------------------------------------------------------------ *
 * The inventories — what the response carried before the projection
 * ------------------------------------------------------------------ */

/**
 * Every top-level key `GET /api/plans/<slug>` returned before this phase,
 * captured from a live response, mapped to the include group that returns it
 * now (`''` = still in the board projection, no include needed).
 *
 * Adding a field to the response means adding it here. That is the point: the
 * inventory is the contract, and a field with no entry is a field nobody has
 * decided the reachability of.
 */
const PRE_CHANGE_DETAIL_KEYS: Record<string, string> = {
  summary: '', plan: '', phases: '', route: '', batches: '', boardText: '', lint: '',
  handoffs: '', index: '', eta: '', cost: '', forecast: '', qa: '', locks: '', git: '',
  memory: 'memory',
};

/**
 * Every `PhaseView` key, same rule.
 *
 * `goal` and `handoff` are BOARD fields and it matters that they are: QA found
 * both projected away in the first cut of this phase, which blanked one clamped
 * line of goal under every Route-tab row and dropped the `handoff <status>`
 * chip from the default tab of every plan. `goal` is 2.5 KB across 23 phases
 * and the handoff reference minus its Outstanding section is 4.1 KB — neither
 * was ever the payload problem. What IS projected is `handoff.outstanding`
 * (42.1 KB), asserted separately below because it is a sub-field.
 */
const PRE_CHANGE_PHASE_KEYS: Record<string, string> = {
  phase: '', title: '', state: '', proof: '', size: '', weight: '', gated: '', gates: '',
  gateCheck: '', gateKind: '', model: '', effort: '', mcpServers: '', row: '', analysis: '',
  qa: '', lock: '', live: '', review: '', reviewHold: '', goal: '', handoff: '',
  readFirst: 'prose', files: 'prose', steps: 'prose', exitCriteria: 'prose',
  verification: 'prose', handoffMustRecord: 'prose', bullets: 'prose',
};

/**
 * Every `plan.*` key. Only four stay in the board projection: the header and the
 * Autopilot tab read `sessionBudget`, and `slug`/`title`/`path` are identity.
 * The rest is the DOCUMENT, and `source-tab.tsx` is its only reader.
 */
const PRE_CHANGE_PLAN_KEYS: Record<string, string> = {
  slug: '', title: '', sessionBudget: '', path: '',
  provenance: 'document', context: 'document', architecture: 'document', endToEnd: 'document',
  graph: 'document', callouts: 'document', sections: 'document',
};

/* ------------------------------------------------------------------ *
 * A synthetic 23-phase plan, sized like a real one
 * ------------------------------------------------------------------ */

/** Prose of a realistic length — a real phase's Steps block runs to a page. */
const paragraph = (seed: string): string =>
  Array.from({ length: 6 }, (_, i) => `  - ${seed} ${i}: ${'why this matters, at the length a real plan writes it. '.repeat(3)}`)
    .join('\n');

function planDocument(slug: string, phases: number): string {
  const rows = Array.from({ length: phases }, (_, i) =>
    `| ${i + 1} | phase ${i + 1} | ${i === 0 ? '—' : i} | — | app | it works |`).join('\n');
  const bodies = Array.from({ length: phases }, (_, i) => `
### Phase ${i + 1} — phase ${i + 1}
- **Size:** M
- **Goal:** ${'the goal, stated at the length a real plan states it. '.repeat(4)}
- **Read first:** this plan §Phase ${i + 1}.
- **Files to create/modify:** \`src/one.ts\`, \`src/two.ts\`, \`src/three.ts\`.
- **Steps:**
${paragraph(`step for phase ${i + 1}`)}
- **Exit criteria:**
${paragraph(`criterion for phase ${i + 1}`)}
- **Verification:**
  \`\`\`
  npm test
  \`\`\`
- **Handoff must record:** ${'what the next session needs. '.repeat(6)}
`).join('\n');

  return `---
slug: ${slug}
created: 2026-08-01
status: active
phases: ${phases}
handoffs: docs/handoffs/${slug}/
memory: project_${slug}
---

# ${slug}

## Context

${'Provenance, at the length a real plan carries it. '.repeat(20)}

## Architecture / approach

${'How it hangs together. '.repeat(30)}

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
${rows}

## Phases
${bodies}

## End-to-end verification

\`\`\`
npm test
\`\`\`
`;
}

function handoffDocument(slug: string, phase: number): string {
  return `---
plan: docs/plans/${slug}.md
phase: ${phase}
title: phase-${phase}
status: complete
completed: 2026-08-01
next_phase: ${phase + 1}
depends_on: [${phase > 1 ? phase - 1 : ''}]
blocks: [${phase + 1}]
parallel_safe: []
skills_used: []
key_files: []
memory: project_${slug}
---

# Phase ${phase} → next handoff: phase-${phase}

## What this phase did
${'What it did, at handoff length. '.repeat(12)}

## State now (verified)
Committed.

## Files changed
None worth naming.

## Key decisions / gotchas
${'A decision the next session needs. '.repeat(12)}

## ▶ Start next phase(s) (paste into fresh sessions)
See the plan.

## Outstanding / blockers
${'Something left over, described at the length these are described. '.repeat(10)}
`;
}

function library(slug: string, phases: number): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-projection-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), planDocument(slug, phases));
  // Every phase but the last has a handoff, so `phases[].handoff` is populated
  // across the response — that field is 46.5 KB on the real plan.
  for (let phase = 1; phase < phases; phase++) {
    writeFileSync(join(dir, `phase-${String(phase).padStart(2, '0')}-phase-${phase}.md`), handoffDocument(slug, phase));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function service(t: { after(fn: () => void): void }, root: string) {
  const svc = new Service({ ...flags } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

const SLUG = 'projection-demo';
const PHASES = 23;

/* ------------------------------------------------------------------ *
 * ONE library, ONE service, ONE projection of each shape
 * ------------------------------------------------------------------ *
 *
 * Built once at module scope rather than per test, and that is not merely
 * tidiness. Each `Service.open()` here spawns the engine over a 23-phase plan
 * with 22 handoffs; seven of them cost ~13 s of subprocess contention, and with
 * this file present the WHOLE node suite began reporting one failure per run
 * from a rotating set of timing-sensitive neighbours (`pty-broker`,
 * `reliability`, the lane tests) that are green without it. Removing the file
 * restored 2207/2202/0 — so the load was the cause and the neighbours were the
 * symptom. A test that makes the rest of the suite flake is a bad test, however
 * green it is itself.
 *
 * Node's runner executes a file's tests sequentially, so a shared fixture is
 * safe here; nothing below mutates the library or the service.
 */

const LIB = library(SLUG, PHASES);
const SVC = new Service({ ...flags } as never);
{
  const check = SVC.open(LIB.root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
}
after(() => { SVC.close(); LIB.cleanup(); });

/** The five shapes every assertion below reads, each computed exactly once. */
const BOARD = (await SVC.detail(SLUG))!;
const FULL = (await SVC.detail(SLUG, undefined, new Set(['full'])))!;
const PROSE = (await SVC.detail(SLUG, undefined, new Set(['prose'])))!;
const DOCUMENT = (await SVC.detail(SLUG, undefined, new Set(['document'])))!;
const HANDOFFS = (await SVC.detail(SLUG, undefined, new Set(['handoffs'])))!;
const MEMORY = (await SVC.detail(SLUG, undefined, new Set(['memory'])))!;
const UNION = (await SVC.detail(
  SLUG, undefined, new Set(PLAN_INCLUDES.filter((g: string) => g !== 'full')),
))!;

/** One group's projection, by name — so a table-driven test needs no fetch. */
const BY_GROUP: Record<string, typeof BOARD> = {
  prose: PROSE, document: DOCUMENT, handoffs: HANDOFFS, memory: MEMORY,
};

/** A key is "carried" if ANY phase has it: `live`, `review` and `reviewHold`
 *  are absent on a phase they do not apply to, and asserting per phase would
 *  fail on a fixture rather than on a regression. */
const carried = (phases: readonly Record<string, unknown>[]): Set<string> => {
  const out = new Set<string>();
  for (const phase of phases) for (const key of Object.keys(phase)) out.add(key);
  return out;
};

/* ------------------------------------------------------------------ *
 * 1. Every pre-change key is still reachable
 * ------------------------------------------------------------------ */

test('every top-level key the plan detail used to carry is reachable through a documented include', () => {
  for (const [key, group] of Object.entries(PRE_CHANGE_DETAIL_KEYS)) {
    if (!group) {
      assert.ok(key in BOARD, `'${key}' claims to be in the board projection and is not`);
      continue;
    }
    assert.ok(
      !(key in BOARD),
      `'${key}' is documented behind ?include=${group} but rides in the board projection — either the`
      + ' inventory or the projection is wrong, and a payload budget written against the other one is a lie',
    );
    assert.ok(
      key in BY_GROUP[group],
      `?include=${group} must return '${key}' — it is the documented way to reach it`,
    );
  }
});

test('every PhaseView key the response used to carry is reachable through a documented include', () => {
  const inBoard = carried(BOARD.phases as never);
  const inFull = carried(FULL.phases as never);

  for (const [key, group] of Object.entries(PRE_CHANGE_PHASE_KEYS)) {
    if (!group) continue; // optional-on-this-fixture board fields; the union check below covers them
    assert.ok(
      !inBoard.has(key),
      `phase field '${key}' is documented behind ?include=${group} but rides in the board projection`,
    );
    assert.ok(
      carried(BY_GROUP[group].phases as never).has(key),
      `?include=${group} must return phase field '${key}'`,
    );
  }

  // Nothing was deleted outright: every projected field is present under `full`.
  for (const key of Object.keys(PRE_CHANGE_PHASE_KEYS)) {
    if (!PRE_CHANGE_PHASE_KEYS[key]) continue;
    assert.ok(inFull.has(key), `?include=full dropped phase field '${key}' — that is a removal, not a projection`);
  }
});

test('the handoff REFERENCE stays on the board; only its Outstanding section moves', () => {
  // The sub-field group, and the finding that produced it. Projecting the whole
  // `handoff` object away is what the first cut of this phase did, and it took
  // the `handoff <status>` chip off the Route tab and off every phase card with
  // it. 42.1 KB of the 46.5 KB is `outstanding`; the reference is 4.1 KB.
  const withHandoff = (BOARD.phases as Record<string, unknown>[]).filter((p) => p.handoff);
  assert.ok(withHandoff.length > 0, 'the fixture must have phases with handoffs');

  for (const phase of withHandoff) {
    const ref = phase.handoff as Record<string, unknown>;
    for (const kept of ['file', 'status', 'title', 'skillsUsed', 'prompts']) {
      assert.ok(kept in ref, `the board projection must keep handoff.${kept} — a chip renders it`);
    }
    for (const moved of HANDOFF_PROSE_FIELDS) {
      assert.ok(!(moved in ref), `handoff.${moved} is ?include=handoffs and must not ride in the board`);
    }
  }

  // …and it comes back, on the phases that have one.
  const asked = (HANDOFFS.phases as Record<string, unknown>[])
    .map((p) => p.handoff as Record<string, unknown> | undefined)
    .filter((h): h is Record<string, unknown> => Boolean(h));
  assert.ok(
    asked.some((h) => 'outstanding' in h),
    '?include=handoffs must return handoff.outstanding',
  );

  // A phase with NO handoff keeps `undefined` — it must not gain an empty
  // object from being projected.
  const noHandoff = (BOARD.phases as Record<string, unknown>[]).filter((p) => !p.handoff);
  for (const phase of noHandoff) {
    assert.equal(phase.handoff, undefined, 'a phase with no handoff must not gain an empty one');
  }
});

test('every plan.* key is reachable — the board keeps identity, the document moves', () => {
  for (const [key, group] of Object.entries(PRE_CHANGE_PLAN_KEYS)) {
    if (group) {
      assert.ok(!(key in BOARD.plan!), `plan.${key} is documented behind ?include=${group} but rides in the board`);
      assert.ok(key in BY_GROUP[group].plan!, `?include=${group} must return plan.${key}`);
    } else {
      assert.ok(key in BOARD.plan!, `plan.${key} claims to be in the board projection and is not`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. `full` is the union — the escape hatch has to actually work
 * ------------------------------------------------------------------ */

test('?include=full is the union of every group, key for key', () => {
  assert.deepEqual(
    Object.keys(FULL).sort(),
    Object.keys(UNION).sort(),
    '`full` must carry exactly what asking for every group carries — otherwise `full` is a third shape',
  );
  assert.deepEqual(
    [...carried(FULL.phases as never)].sort(),
    [...carried(UNION.phases as never)].sort(),
    '`full` and the union must agree on phase fields too',
  );
  assert.deepEqual(
    Object.keys(FULL.plan!).sort(),
    Object.keys(UNION.plan!).sort(),
    '…and on plan fields',
  );
});

/* ------------------------------------------------------------------ *
 * 3. The budgets in the exit criteria
 * ------------------------------------------------------------------ */

test('the board projection of a 23-phase plan is under 60 KB, and full is far bigger', () => {
  const board = BOARD;
  const full = FULL;

  const boardKb = KB(board);
  const fullKb = KB(full);
  assert.equal((board.phases as unknown[]).length, PHASES, 'the fixture must really have 23 phases');
  assert.ok(boardKb < 60, `board projection is ${boardKb.toFixed(1)} KB — the exit criterion is under 60 KB`);
  // Not a size assertion for its own sake: if the projection ever became a
  // no-op (an include-set that defaults to everything, say), the reachability
  // tests above would still pass and only this would notice.
  assert.ok(fullKb > boardKb * 1.5, `full (${fullKb.toFixed(1)} KB) must be materially bigger than the board (${boardKb.toFixed(1)} KB)`);
});

/* ------------------------------------------------------------------ *
 * 4. `/api/state` — run summaries, and the full records one param away
 * ------------------------------------------------------------------ */

/** A run record shaped like the real 340 KB one, transcripts and all. */
function runFixture(): Record<string, unknown> {
  const phases: Record<string, unknown> = {};
  for (let phase = 1; phase <= 16; phase++) {
    phases[String(phase)] = {
      phase, status: 'done', attempts: 1, costUsd: 1.5, turns: 40, durationMs: 900_000,
      model: 'claude-opus-5', actualModel: 'claude-opus-5', sessionId: `s-${phase}`,
      startedAt: '2026-08-01T00:00:00Z', endedAt: '2026-08-01T00:15:00Z',
      liveness: { at: 1, via: 'run' },
      // The transcripts — 227 KB of the real record was this one field.
      verification: { ran: Array.from({ length: 8 }, (_, i) => ({ cmd: `npm test ${i}`, ok: true, out: 'x'.repeat(2000) })) },
      said: 'y'.repeat(4000),
      tasks: Array.from({ length: 20 }, (_, i) => ({ id: `p${phase}.task${i}`, subject: 'z'.repeat(200) })),
      closeout: 'w'.repeat(1000),
      situation: { kind: 'none', why: 'v'.repeat(500) },
    };
  }
  return {
    id: 'run-1', slug: SLUG, root: '/tmp', status: 'finished', autonomy: 'auto',
    model: 'claude-opus-5', spentUsd: 24, createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T04:00:00Z', activePhase: null, child: null,
    waitUntil: null, halt: null, pause: null, freeze: null,
    rulings: Array.from({ length: 40 }, (_, i) => ({ kind: 'deferral', what: 'q'.repeat(600), at: `${i}` })),
    recoveries: Array.from({ length: 6 }, () => ({ mode: 'retry', at: '2026-08-01T01:00:00Z' })),
    phases,
  };
}

test('/api/state carries run summaries, and ?include=runs carries the records themselves', (t) => {
  // The seam: `state()` reads `runStates()`, and standing a real runner up to
  // produce one would test the runner, not the projection. An instance property
  // shadows the prototype method, so both code paths below are the real ones —
  // and it is put back afterwards, because the service is shared.
  const svc = SVC as unknown as { runStates(): unknown[]; state(i?: Set<string>): unknown };
  const real = svc.runStates;
  t.after(() => { svc.runStates = real; });
  const fixture = runFixture();
  svc.runStates = () => [fixture];

  const board = svc.state() as { runs: Record<string, unknown>[] };
  const withRuns = svc.state(new Set(['runs'])) as { runs: unknown[] };
  const withFull = svc.state(new Set(['full'])) as { runs: unknown[] };

  assert.deepEqual(withRuns.runs, [fixture], '?include=runs must be the record, untouched');
  assert.deepEqual(withFull.runs, [fixture], '?include=full must be the record, untouched');

  const summary = board.runs[0];
  for (const dropped of RUN_SUMMARY_DROP) {
    assert.ok(!(dropped in summary), `a run summary must not carry '${dropped}'`);
  }
  const phase = (summary.phases as Record<string, Record<string, unknown>>)['1'];
  for (const dropped of RUN_SUMMARY_PHASE_DROP) {
    assert.ok(!(dropped in phase), `a run summary's phase record must not carry '${dropped}'`);
  }
  // What a summary is FOR. `liveness` is deliberately kept — it is the per-lane
  // "is this alive" sample, which is exactly the question a summary answers.
  for (const kept of ['phase', 'status', 'attempts', 'costUsd', 'model', 'sessionId', 'startedAt', 'endedAt', 'liveness']) {
    assert.ok(kept in phase, `a run summary's phase record must still carry '${kept}'`);
  }
  for (const kept of ['id', 'slug', 'status', 'model', 'spentUsd', 'createdAt', 'activePhase', 'child']) {
    assert.ok(kept in summary, `a run summary must still carry '${kept}'`);
  }

  const fullKb = KB(withRuns);
  const boardKb = KB(board);
  assert.ok(boardKb < 30, `/api/state is ${boardKb.toFixed(1)} KB with one live run — the exit criterion is under 30 KB`);
  assert.ok(fullKb > boardKb * 2, `?include=runs (${fullKb.toFixed(1)} KB) must be materially bigger than the default (${boardKb.toFixed(1)} KB)`);
});

test('a run summary drops transcripts by OMISSION, so a new RunState field rides along', () => {
  // The drop lists name what goes, never what stays. A field added to
  // `RunState` tomorrow must appear in the summary without anyone remembering
  // this file exists — the alternative is a keep-list that silently swallows
  // every future field.
  const run = { ...runFixture(), somethingAddedLater: 'kept', phases: { 1: { phase: 1, brandNew: 'kept' } } };
  const summary = summarizeRun(run) as Record<string, unknown>;
  assert.equal(summary.somethingAddedLater, 'kept');
  assert.equal((summary.phases as Record<string, Record<string, unknown>>)['1'].brandNew, 'kept');
  assert.ok(!('rulings' in summary));
});

/* ------------------------------------------------------------------ *
 * 5. The vocabulary itself
 * ------------------------------------------------------------------ */

test('parseInclude accepts what it documents and silently ignores what it does not', () => {
  assert.deepEqual([...parseInclude('prose,handoffs', PLAN_INCLUDES)].sort(), ['handoffs', 'prose']);
  assert.deepEqual([...parseInclude('prose handoffs', PLAN_INCLUDES)].sort(), ['handoffs', 'prose']);
  assert.deepEqual([...parseInclude('PROSE', PLAN_INCLUDES)], ['prose']);
  // Not a 400: an unknown group is a caller asking for something this server
  // does not have, which is a SMALLER response — never an error page.
  assert.deepEqual([...parseInclude('nonsense', PLAN_INCLUDES)], []);
  assert.deepEqual([...parseInclude('', PLAN_INCLUDES)], []);
  assert.deepEqual([...parseInclude(null, PLAN_INCLUDES)], []);
  // `runs` is not a plan group and `prose` is not a state group — each endpoint
  // is parsed against its own vocabulary.
  assert.deepEqual([...parseInclude('runs', PLAN_INCLUDES)], []);
  assert.deepEqual([...parseInclude('prose', STATE_INCLUDES)], []);
});

test('`full` wants every group, and an empty set wants none', () => {
  for (const group of PLAN_INCLUDES) assert.equal(wants(new Set(['full']), group), true);
  for (const group of PLAN_INCLUDES) assert.equal(wants(new Set(), group), false);
  assert.equal(wants(undefined, 'prose'), false);
  assert.equal(wants(new Set(['prose']), 'handoffs'), false);
});

test('includeParam is stable-ordered, so two callers asking for the same groups share one cache entry', () => {
  assert.equal(includeParam(['handoffs', 'prose'], PLAN_INCLUDES), includeParam(['prose', 'handoffs'], PLAN_INCLUDES));
  assert.equal(includeParam(['prose', 'prose'], PLAN_INCLUDES), 'prose');
  assert.equal(includeParam(['nonsense'], PLAN_INCLUDES), '');
  assert.equal(includeParam([], PLAN_INCLUDES), '');
});

test('the field groups are disjoint — no field is reachable two ways', () => {
  const groups = [PROSE_PHASE_FIELDS, DOCUMENT_PLAN_FIELDS, HANDOFF_PROSE_FIELDS, MEMORY_FIELDS];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const field of group) {
      assert.ok(!seen.has(field), `'${field}' is in two include groups — which one returns it is then luck`);
      seen.add(field);
    }
  }
  // `omit` is the one primitive all of this stands on.
  assert.deepEqual(omit({ a: 1, b: 2, c: 3 }, ['b']), { a: 1, c: 3 });
  assert.deepEqual(omit({ a: 1 }, []), { a: 1 });
});

/* ------------------------------------------------------------------ *
 * 6. The real corpus, when there is one
 * ------------------------------------------------------------------ */

const CORPUS = process.env.PHASE_CONSOLE_TEST_ROOT;

test('the real library: the board projection is a fraction of the full response', { skip: !CORPUS }, async (t) => {
  const svc = service(t, CORPUS!);
  const plans = await svc.summaries();
  // The biggest phased plan in the library — the case the budget is written for.
  const biggest = plans
    .filter((p) => (p as { phases?: number }).phases)
    .sort((a, b) => ((b as { phases: number }).phases) - ((a as { phases: number }).phases))[0] as { slug: string; phases: number };
  assert.ok(biggest, 'the corpus must contain at least one phased plan');

  const board = await svc.detail(biggest.slug);
  const full = await svc.detail(biggest.slug, undefined, new Set(['full']));
  const boardKb = KB(board);
  const fullKb = KB(full);

  assert.ok(
    boardKb < fullKb / 2,
    `${biggest.slug} (${biggest.phases} phases): board ${boardKb.toFixed(1)} KB vs full ${fullKb.toFixed(1)} KB`,
  );
  // The exit criterion names a 23-phase plan. A library can hold a bigger one,
  // and the budget scales with the phase count, so the assertion is scaled the
  // same way rather than left to fail on somebody's 40-phase plan.
  const budgetKb = 60 * Math.max(1, biggest.phases / 23);
  assert.ok(
    boardKb < budgetKb,
    `${biggest.slug}: board projection ${boardKb.toFixed(1)} KB exceeds the ${budgetKb.toFixed(0)} KB budget for ${biggest.phases} phases`,
  );
});
