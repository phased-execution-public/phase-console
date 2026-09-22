/**
 * Parity with the engine.
 *
 * The console parses plans in JavaScript for everything it draws, but takes
 * every status claim from `scripts/phase-graph.sh`. That split is only safe
 * while the two readings of a plan agree, so this file re-derives what the JS
 * parser believes and asserts it matches what the engine reports.
 *
 * **It runs everywhere.** Until now every board-parity assertion was guarded by
 * `PHASE_CONSOLE_TEST_ROOT`, which nothing exports — not the local `npm test`,
 * not either CI job — so the invariant CLAUDE.md names first ("run it after
 * touching *either* parser") had never once executed on this repository
 * (coverage-1). The shipped fixture plans under `tests/fixtures/plans/` are now
 * the default corpus: they are copied into a throwaway DOCS_ROOT, given
 * synthesized handoffs so the board has every state, and every parity test runs
 * against them with no environment at all.
 *
 * `PHASE_CONSOLE_TEST_ROOT` is still honoured, and still valuable — a real plan
 * library is far messier than any fixture — but it is an ADDITIONAL corpus now,
 * never the precondition.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkRoot, safeList, SKILL_DIR } from '../server/config.ts';
import { Store, type PlanRecord } from '../server/store.ts';
import { run, readMemoryBlock, readSessionPlan, type EngineResult, type PhaseState } from '../server/engine.ts';
import { loadGateVocab, gateKindOf } from '../server/analysis/gates.ts';
import { parseQaRounds, parseTestStatus } from '../server/parse/folder.ts';
import { nextQaRound } from '../server/qa-round.ts';
import {
  parsePlan, mcpServersFor, credentialsFor, credentialPolicyFor, personCheckFor, waitBudgetFor, waitsOnFor,
  landFor, gitlinkFor, issuesFor, isolationFor, baseBranchOf, conflictPolicyOf, messagingOf, clashZonesOf,
  type Plan,
} from '../server/parse/plan.ts';
import { mergeDecisions, formatDecisionsTsv, parseDecisionsTsv } from '../shared/decisions-model.js';
import { readDecisions, readCredentials, readWaitBudget, readWaitsOn } from '../server/engine.ts';
import { extractCommands } from '../server/runner/verify.ts';
import { scopeOfRow, formatScope } from '../shared/scope.js';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIXTURES = join(SKILL_DIR, 'tests', 'fixtures', 'plans');

/** An additional corpus: a real plan library, when the operator points at one. */
const LIVE_ROOT = process.env.PHASE_CONSOLE_TEST_ROOT ?? '';
const liveAvailable = Boolean(LIVE_ROOT)
  && existsSync(join(LIVE_ROOT, 'docs', 'plans'))
  && existsSync(join(SCRIPTS, 'phase-graph.sh'));

/**
 * An engine call that was KILLED never answered — assert that before reading it.
 *
 * `run()` kills at `TIMEOUT_MS` (45 s) and resolves with EMPTY stdout, and every
 * comparison in this file treats stdout as a real answer. So a slow machine
 * reports as `engine returned an empty scope` — a PARITY message for what is
 * actually "nobody answered". That misdiagnosis has cost a session hours, and
 * it is precisely the class this suite exists to catch one layer up: an
 * unreadable answer must never pass as a real one.
 */
function answered(result: EngineResult, what: string): EngineResult {
  assert.equal(
    result.timedOut,
    false,
    `${what}: the engine call was KILLED at 45 s — a busy machine, NOT a parity failure. `
      + 'Re-run this suite alone, and clear leaked `pc-*` scratch dirs first.',
  );
  return result;
}

/* ------------------------------------------------------------------ *
 * The corpora
 * ------------------------------------------------------------------ */

type Corpus = {
  name: string;
  root: string;
  /** Real libraries are big enough to assert scale on; fixtures are not. */
  live: boolean;
};

/**
 * Handoffs synthesized over the fixture plans, so the board has every state.
 *
 * The fixtures ship without handoffs, which would leave every phase `ready` or
 * `waiting` — a real parity test (it catches the dependency-cell divergence
 * coverage-1 describes) but a narrow one. These three files add `done`,
 * `in-progress` and `stuck` to the corpus, so `deriveBoard`'s status reading and
 * the engine's `phase_status` are compared on all five words rather than two.
 */
const SYNTHETIC_HANDOFFS: { slug: string; phase: number; status: string }[] = [
  { slug: 'linear', phase: 1, status: 'complete' },
  { slug: 'diamond', phase: 1, status: 'complete' },
  { slug: 'diamond', phase: 2, status: 'in-progress' },
  { slug: 'outoforder', phase: 1, status: 'complete' },
  { slug: 'outoforder', phase: 4, status: 'blocked' },
];

function handoffBody(slug: string, phase: number, status: string): string {
  return [
    '---',
    `plan: docs/plans/${slug}.md`,
    `phase: ${phase}`,
    'title: synthesized',
    `status: ${status}`,
    '---',
    '',
    `# Phase ${phase} — synthesized for engine-parity`,
    '',
    'Written by `viewer/test/engine-parity.test.ts` into a throwaway DOCS_ROOT so',
    'the fixture corpus exercises every board state. Never committed.',
    '',
  ].join('\n');
}

/**
 * The fixtures, laid out the way the engine expects to find plans.
 *
 * `phase-graph.sh` reads `<root>/docs/plans/<slug>.md`, so the fixture
 * directory cannot be handed to it directly — the bats helper does the same
 * copy for the same reason.
 */
function fixtureCorpus(): Corpus & { slugs: string[]; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-parity-fixtures-'));
  const plans = join(root, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const slugs: string[] = [];
  for (const file of safeList(FIXTURES)) {
    // `bad-*` fixtures are deliberately malformed; the lint suites own those.
    if (!file.endsWith('.md') || file.startsWith('bad-')) continue;
    copyFileSync(join(FIXTURES, file), join(plans, file));
    slugs.push(file.replace(/\.md$/, ''));
  }
  for (const { slug, phase, status } of SYNTHETIC_HANDOFFS) {
    if (!slugs.includes(slug)) continue;
    const dir = join(root, 'docs', 'handoffs', slug);
    mkdirSync(dir, { recursive: true });
    const name = `phase-${String(phase).padStart(2, '0')}-synthesized.md`;
    writeFileSync(join(dir, name), handoffBody(slug, phase, status));
  }
  // The decision manifest's mutable twin, in the exact shape decisions.sh
  // writes, for the one fixture that carries a `## Decisions` table: a
  // plan-wide row that REPLACES the plan's, a phase-scoped row, and a row the
  // plan does not have — so the merge, not just the parse, is what parity
  // compares.
  if (slugs.includes('decisions')) {
    const dir = join(root, 'docs', 'handoffs', 'decisions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'decisions.md'), [
      '# Decisions — decisions', '',
      '<!-- written by scripts/decisions.sh; the plan\'s `## Decisions` table is the base -->', '',
      '## Decisions', '',
      '| key | value | owner | state | blocking | source | evidence | phase |',
      '|---|---|---|---|---|---|---|---|',
      '| `credentials` | `gh` only — `npm-token` retired | operator | answered | yes | run | decisions.sh | — |',
      '| `waits` | bounded at 30m | dev-lead | answered | yes | run | decisions.sh | 2 |',
      '| `stop` | halt-on-everything | operator | answered | no | ruling | ruling r-17 | — |',
      '',
    ].join('\n'));
  }
  return {
    name: 'fixtures', root, live: false, slugs,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run `body` against every corpus available: the shipped fixtures always, plus
 * a real plan library when `PHASE_CONSOLE_TEST_ROOT` names one.
 */
async function forEachCorpus(body: (corpus: Corpus) => Promise<void> | void): Promise<void> {
  const fixtures = fixtureCorpus();
  try {
    await body(fixtures);
  } finally {
    fixtures.cleanup();
  }
  if (liveAvailable) await body({ name: 'live', root: LIVE_ROOT, live: true });
}

const optsFor = (corpus: Corpus) => ({ scriptsDir: SCRIPTS, root: corpus.root });

async function engine(corpus: Corpus, args: string[], what: string): Promise<string> {
  return answered(await run(optsFor(corpus), 'phase-graph.sh', args), `${corpus.name}: ${what}`)
    .stdout.trim();
}

/**
 * Every phase of every phased plan in a corpus, as a flat list.
 *
 * Flat and BATCHED because these checks are one subprocess per phase and a real
 * plan library is hundreds of phases: run serially, a single directive test
 * took over five minutes against hub and the whole file blew past twenty. The
 * batch width is the same 24 the scope test uses, bounded so the engine's own
 * 8-way semaphore is the limit rather than the process table.
 */
type PhaseRef = { slug: string; plan: NonNullable<PlanRecord['plan']>; phase: number };

function everyPhase(corpus: Corpus): PhaseRef[] {
  const store = new Store(checkRoot(corpus.root));
  store.scan();
  return store.list()
    .filter((r) => r.plan?.phased)
    .flatMap((r) => r.plan!.graph.map((row) => ({ slug: r.slug, plan: r.plan!, phase: row.phase })));
}

const BATCH = 24;

async function forEachPhase(
  refs: PhaseRef[],
  body: (ref: PhaseRef) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < refs.length; i += BATCH) {
    await Promise.all(refs.slice(i, i + BATCH).map(body));
  }
}

/**
 * Every phased plan in a corpus — all of the fixtures, a spread of a real one.
 *
 * The whole-plan modes (`--lint`, `--session-plan`, `--boot-prompt`) each walk
 * the entire graph inside the script, so one call is worth many phase calls.
 * Running them over sixty real plans is minutes of wall clock for coverage the
 * fixtures already give exactly; the live corpus contributes messiness, and a
 * spread of it is enough to find that.
 */
function samplePlans(corpus: Corpus, limit = 10): PlanRecord[] {
  const store = new Store(checkRoot(corpus.root));
  store.scan();
  const all = store.list().filter((r) => r.plan?.phased);
  if (!corpus.live) return all;
  return all
    .sort((a, b) => (b.plan!.graph.length) - (a.plan!.graph.length))
    .filter((_, i) => i % 3 === 0)
    .slice(0, limit);
}

async function forEachPlan(
  records: PlanRecord[],
  body: (record: PlanRecord) => Promise<void>,
): Promise<void> {
  const width = 8;
  for (let i = 0; i < records.length; i += width) {
    await Promise.all(records.slice(i, i + width).map(body));
  }
}

/* ------------------------------------------------------------------ *
 * Board parity
 * ------------------------------------------------------------------ */

/** The engine's own status reading: handoff front matter, first match wins. */
function handoffState(record: PlanRecord, phase: number): 'done' | 'in-progress' | 'stuck' | 'not-started' {
  const handoff = record.handoffs.find((h) => h.phase === phase);
  if (!handoff) return 'not-started';
  if (handoff.status === 'complete') return 'done';
  if (handoff.status === 'in-progress') return 'in-progress';
  if (handoff.status === 'blocked') return 'stuck';
  return 'not-started';
}

/** Re-derive the board the way phase-graph.sh does — deliberately duplicated. */
function deriveBoard(record: PlanRecord): Record<number, PhaseState> {
  const rows = record.plan?.graph ?? [];
  const qaFile = record.handoffDir ? join(record.handoffDir, 'test-status.md') : undefined;
  const gating = Boolean(qaFile && existsSync(qaFile));
  const qaRows = gating ? parseTestStatus(readFileSync(qaFile!, 'utf8')) : [];

  const isDone = (phase: number) => handoffState(record, phase) === 'done';
  const isVerified = (phase: number) => {
    if (!isDone(phase)) return false;
    if (!gating) return true;
    const result = qaRows.find((q) => q.phase === phase)?.result;
    return result === 'pass' || result === 'waived';
  };

  const states: Record<number, PhaseState> = {};
  for (const row of rows) {
    const own = handoffState(record, row.phase);
    if (own === 'done') { states[row.phase] = 'done'; continue; }
    if (own === 'in-progress' || own === 'stuck') { states[row.phase] = own; continue; }
    states[row.phase] = row.dependsOn.every(isVerified) ? 'ready' : 'waiting';
  }
  return states;
}

test('every plan classifies the same way as the engine', async () => {
  await forEachCorpus(async (corpus) => {
    const store = new Store(checkRoot(corpus.root));
    store.scan();

    const records = store.list().filter((r) => r.planPath);
    assert.ok(records.length > 0, `${corpus.name}: expected plans`);
    if (corpus.live) assert.ok(records.length > 10, 'expected a real plan library');

    const mismatches: string[] = [];
    const seen = new Set<PhaseState>();
    let phasedCount = 0;

    await Promise.all(records.map(async (record) => {
      const board = readMemoryBlock(answered(
        await run(optsFor(corpus), 'phase-graph.sh', [record.slug, '--memory-block']),
        `${corpus.name}: ${record.slug} --memory-block`,
      ));

      if (!record.plan?.phased) {
        if (board.phased) mismatches.push(`${record.slug}: JS says document, engine parsed a graph`);
        return;
      }

      phasedCount++;
      if (!board.phased) {
        mismatches.push(`${record.slug}: JS parsed a graph, engine reported "${board.error}"`);
        return;
      }

      const jsPhases = record.plan.graph.map((r) => r.phase).sort((a, b) => a - b);
      const enginePhases = Object.keys(board.states).map(Number).sort((a, b) => a - b);
      if (jsPhases.join(',') !== enginePhases.join(',')) {
        mismatches.push(`${record.slug}: roster JS [${jsPhases}] vs engine [${enginePhases}]`);
        return;
      }

      const derived = deriveBoard(record);
      for (const phase of jsPhases) {
        seen.add(board.states[phase]);
        if (derived[phase] !== board.states[phase]) {
          mismatches.push(`${record.slug} p${phase}: JS "${derived[phase]}" vs engine "${board.states[phase]}"`);
        }
      }
    }));

    assert.deepEqual(mismatches, [], `${corpus.name} parity mismatches:\n  ${mismatches.join('\n  ')}`);
    assert.ok(phasedCount > 0, `${corpus.name}: expected phased plans, saw ${phasedCount}`);
    if (corpus.live) assert.ok(phasedCount > 40, `expected many phased plans, saw ${phasedCount}`);
    else {
      // The synthesized handoffs exist to make this true: a corpus that only
      // ever produces `ready` and `waiting` is not comparing status readings.
      for (const state of ['done', 'in-progress', 'stuck', 'ready', 'waiting'] as const) {
        assert.ok(seen.has(state), `fixtures: no phase was ever "${state}" — the corpus stopped covering it`);
      }
    }
  });
});

test('deps, size and gated flags match the engine phase by phase', async () => {
  const vocab = loadGateVocab(SCRIPTS);
  await forEachCorpus(async (corpus) => {
    const store = new Store(checkRoot(corpus.root));
    store.scan();

    const all = store.list().filter((r) => r.plan?.phased);
    // Every fixture, every phase. On a real library that would be thousands of
    // subprocesses, so there it stays a spread of shapes: small and large
    // plans, gated phases, QA-gated plans.
    const sample = corpus.live
      ? all.sort((a, b) => (b.plan!.graph.length) - (a.plan!.graph.length))
        .filter((_, i) => i % 5 === 0).slice(0, 8)
      : all;
    assert.ok(sample.length > 3, `${corpus.name}: expected a usable sample`);

    const problems: string[] = [];
    for (const record of sample) {
      const plan = record.plan!;
      await Promise.all(plan.graph.map(async (row) => {
        const [deps, size, gated, repos, gateKind] = await Promise.all([
          engine(corpus, [record.slug, '--deps', String(row.phase)], `${record.slug} p${row.phase} --deps`),
          engine(corpus, [record.slug, '--size', String(row.phase)], `${record.slug} p${row.phase} --size`),
          engine(corpus, [record.slug, '--gated', String(row.phase)], `${record.slug} p${row.phase} --gated`),
          engine(corpus, [record.slug, '--repos', String(row.phase)], `${record.slug} p${row.phase} --repos`),
          engine(corpus, [record.slug, '--gate-kind', String(row.phase)], `${record.slug} p${row.phase} --gate-kind`),
        ]);
        const jsScope = formatScope(scopeOfRow(row.repos));
        if (repos !== jsScope) {
          problems.push(`${record.slug} p${row.phase}: scope JS "${jsScope}" vs engine "${repos}"`);
        }
        const engineDeps = deps.split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
        const jsDeps = [...row.dependsOn].sort((a, b) => a - b);
        if (engineDeps.join(',') !== jsDeps.join(',')) {
          problems.push(`${record.slug} p${row.phase}: deps JS [${jsDeps}] vs engine [${engineDeps}]`);
        }
        const jsSize = plan.phases[row.phase]?.size ?? 'M';
        if (size !== jsSize) {
          problems.push(`${record.slug} p${row.phase}: size JS ${jsSize} vs engine ${size}`);
        }
        const jsGated = plan.phases[row.phase]?.gated ? 'yes' : 'no';
        if (gated !== jsGated) {
          problems.push(`${record.slug} p${row.phase}: gated JS ${jsGated} vs engine ${gated}`);
        }
        // The gate CATEGORY (human / ai / auto / none) decides whether the runner
        // parks or lets the session clear the gate itself — a drift here is one
        // side booting a session the other would have stopped.
        const jsKind = gateKindOf(plan.phases[row.phase]?.gateCheck, plan.phases[row.phase]?.gated ?? false, vocab);
        if (gateKind !== jsKind) {
          problems.push(`${record.slug} p${row.phase}: gate-kind JS ${jsKind} vs engine ${gateKind}`);
        }
      }));
    }

    assert.deepEqual(problems, [], `${corpus.name} graph mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * Scope is the one parity that has teeth: it decides whether two sessions are
 * allowed to run at the same time. `phase-lock.sh` answers that in bash (via
 * `scripts/scope.sh`, which nothing else tests directly — coverage-20) and the
 * console answers it in JavaScript, so a disagreement is not a cosmetic drift —
 * it is one side admitting a session the other would have refused. Every phase
 * of every plan in the corpus, not a sample.
 */
test('every phase scopes the same way as the engine', async () => {
  await forEachCorpus(async (corpus) => {
    const store = new Store(checkRoot(corpus.root));
    store.scan();

    const rows = store.list()
      .filter((r) => r.plan?.phased)
      .flatMap((r) => r.plan!.graph.map((row) => ({ slug: r.slug, row })));
    assert.ok(rows.length > 0, `${corpus.name}: expected phases`);
    if (corpus.live) assert.ok(rows.length > 100, `expected a real plan library, saw ${rows.length} phases`);

    const problems: string[] = [];
    const BATCH = 24;   // bounded: one subprocess per phase, hundreds of phases
    for (let i = 0; i < rows.length; i += BATCH) {
      await Promise.all(rows.slice(i, i + BATCH).map(async ({ slug, row }) => {
        const engineScope = await engine(corpus, [slug, '--repos', String(row.phase)], `${slug} p${row.phase} --repos`);
        const js = formatScope(scopeOfRow(row.repos));
        if (engineScope !== js) {
          problems.push(`${slug} p${row.phase} (${JSON.stringify(row.repos)}): JS "${js}" vs engine "${engineScope}"`);
        }
        // Never empty on either side: an undeclared phase must read as `all`.
        if (!engineScope) problems.push(`${slug} p${row.phase}: engine returned an empty scope`);
      }));
    }

    assert.deepEqual(problems, [], `${corpus.name} scope mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/* ------------------------------------------------------------------ *
 * The directives
 * ------------------------------------------------------------------ */

test('the two parsers agree about a phase\'s MCP servers', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const fromEngine = await engine(corpus, [slug, '--mcp', String(phase)], `${slug} p${phase} --mcp`);
      const fromJs = mcpServersFor(plan, phase).join(', ');
      if (fromEngine !== fromJs) {
        problems.push(`${slug} p${phase}: MCP servers JS "${fromJs}" vs engine "${fromEngine}"`);
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} MCP server mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/* ------------------------------------------------------------------ *
 * The decision manifest (zero-touch-console P3, chapter 13 §1.1): the plan's
 * `## Decisions` table with the `decisions.md` twin merged over it. Compared
 * as the TSV BYTES the engine prints against what the shared merge formats —
 * the same line phase 11's prelude and the boot prompt read.
 * ------------------------------------------------------------------ */

test('the two engines agree about the decision manifest — plan-wide, and resolved per phase', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    let carrying = 0;
    for (const record of samplePlans(corpus)) {
      const plan = record.plan!;
      const twin = record.decisionsTwin;
      const planWide = await engine(corpus, [record.slug, '--decisions'], `${record.slug} --decisions`);
      const fromJs = formatDecisionsTsv(mergeDecisions(plan.decisions, twin));
      if (planWide !== fromJs) problems.push(`${record.slug}: decisions JS\n${fromJs}\n  vs engine\n${planWide}`);
      if (planWide) carrying++;
      // The engine's TSV read back through readDecisions is the merge, row for row.
      const parsed = readDecisions({ code: 0, stdout: planWide, stderr: '', ms: 0, timedOut: false }).rows;
      const expected = mergeDecisions(plan.decisions, twin).map((r) => ({ ...r, evidence: '', phase: null }));
      assert.deepEqual(parsed, expected, `${record.slug}: readDecisions() is not the merge`);
      assert.deepEqual(parseDecisionsTsv(planWide), parsed);
      await forEachPhase(plan.graph.map((row) => ({ slug: record.slug, plan, phase: row.phase })), async ({ slug, phase }) => {
        const perPhase = await engine(corpus, [slug, '--decisions', String(phase)], `${slug} --decisions ${phase}`);
        const js = formatDecisionsTsv(mergeDecisions(plan.decisions, twin, phase));
        if (perPhase !== js) problems.push(`${slug} p${phase}: decisions JS\n${js}\n  vs engine\n${perPhase}`);
      });
    }
    assert.deepEqual(problems, [], `${corpus.name} decision-manifest mismatches:\n  ${problems.join('\n  ')}`);
    if (!corpus.live) assert.ok(carrying >= 1, 'the fixture corpus must carry at least one manifest, or this proves nothing');
  });
});

test('the two engines agree about a phase\'s credentials, credential policy and the accounts line', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const [creds, policy] = await Promise.all([
        engine(corpus, [slug, '--credentials', String(phase)], `${slug} p${phase} --credentials`),
        engine(corpus, [slug, '--credential-policy', String(phase)], `${slug} p${phase} --credential-policy`),
      ]);
      const jsCreds = credentialsFor(plan, phase).join(', ');
      if (creds !== jsCreds) problems.push(`${slug} p${phase}: credentials JS "${jsCreds}" vs engine "${creds}"`);
      assert.deepEqual(readCredentials({ code: 0, stdout: creds, stderr: '', ms: 0, timedOut: false }), credentialsFor(plan, phase));
      const jsPolicy = credentialPolicyFor(plan, phase) ?? '';
      if (policy !== jsPolicy) problems.push(`${slug} p${phase}: credential policy JS "${jsPolicy}" vs engine "${policy}"`);
      // …and the phase's `Person-check:` word (phase 11, ZTD-6).
      const check = await engine(corpus, [slug, '--person-check', String(phase)], `${slug} p${phase} --person-check`);
      const jsCheck = personCheckFor(plan, phase) ?? '';
      if (check !== jsCheck) problems.push(`${slug} p${phase}: person-check JS "${jsCheck}" vs engine "${check}"`);
    });
    for (const record of samplePlans(corpus)) {
      const plan = record.plan!;
      // The plan's `QA exhausted:` word (phase 11, ZTD-9).
      const exhausted = await engine(corpus, [record.slug, '--qa-exhausted'], `${record.slug} --qa-exhausted`);
      const jsExhausted = plan.sessionBudget.qaExhausted ?? '';
      if (exhausted !== jsExhausted) problems.push(`${record.slug}: QA exhausted JS "${jsExhausted}" vs engine "${exhausted}"`);
      const accounts = await engine(corpus, [record.slug, '--accounts'], `${record.slug} --accounts`);
      // `engine()` trims the whole stdout, which eats the tab after an id
      // with no minimum on the LAST line; compare line by line, each trimmed.
      const norm = (t: string) => t.split('\n').map((l) => l.trimEnd()).join('\n');
      const js = plan.sessionBudget.accounts
        .map((a) => `${a.id}\t${a.minHeadroom === undefined ? '' : a.minHeadroom}`).join('\n');
      if (norm(accounts) !== norm(js)) problems.push(`${record.slug}: accounts JS "${js}" vs engine "${accounts}"`);
    }
    assert.deepEqual(problems, [], `${corpus.name} credential mismatches:\n  ${problems.join('\n  ')}`);
    // The fixture spells all three words and an owner, so the agreement above is not vacuous.
    if (!corpus.live) {
      const store = new Store(checkRoot(corpus.root));
      store.scan();
      const plan = store.get('credentials')!.plan!;
      assert.equal(plan.sessionBudget.qaExhausted, 'waive');
      assert.equal(personCheckFor(plan, 1), undefined);
      assert.equal(personCheckFor(plan, 2), 'allow');
      assert.equal(personCheckFor(plan, 3), 'dev-lead');
      assert.equal(personCheckFor(plan, 4), 'halt');
    }
  });
});

test('the console tells the engine which credentials it holds and which accounts it registered, and F15 advises without failing (ACT-9, phase 11)', async () => {
  const fixtures = fixtureCorpus();
  try {
    // The fixture names `gh` and `claude-login`, and `default:20`, `work:10`, `spare`.
    const told = await run({ ...optsFor(fixtures), credentials: ['gh'], accounts: ['default'] }, 'phase-graph.sh', ['credentials', '--lint']);
    assert.equal(told.code, 0, `lint must stay OK: ${told.stderr}`);
    assert.match(told.stdout, /LINT OK/);
    assert.match(told.stderr, /F15 plan: credential\(s\) the console does not hold: claude-login/);
    assert.match(told.stderr, /F15 plan: account `work` is not registered on this console/);
    assert.match(told.stderr, /F15 plan: account `spare` is not registered on this console/);
    // Everything held and registered: nothing to advise.
    const held = await run({ ...optsFor(fixtures), credentials: ['gh', 'claude-login'], accounts: ['default', 'work', 'spare'] }, 'phase-graph.sh', ['credentials', '--lint']);
    assert.equal(held.code, 0);
    assert.doesNotMatch(held.stderr, /F15 plan: (credential|account)/);
    // Nothing said (a bare install): the check is off, exactly as `PE_MCP_SERVERS` absent turns its half off.
    const bare = await run(optsFor(fixtures), 'phase-graph.sh', ['credentials', '--lint']);
    assert.equal(bare.code, 0);
    assert.doesNotMatch(bare.stderr, /F15 plan: (credential|account)/);
    // Set-but-empty is a real answer: a console holding nothing advises on everything named.
    const empty = await run({ ...optsFor(fixtures), credentials: [], accounts: [] }, 'phase-graph.sh', ['credentials', '--lint']);
    assert.equal(empty.code, 0);
    assert.match(empty.stderr, /F15 plan: credential\(s\) the console does not hold: gh, claude-login/);
    assert.match(empty.stderr, /account `default` is not registered/);
  } finally {
    fixtures.cleanup();
  }
});

test('the two engines agree about a phase\'s wait budget, its source, and the refs it waits on', async () => {
  // The console reads both through the engine (`RunnerBase.waitBudgetOf`), and
  // the page reads the plan through the JS parser: a phase that the engine
  // allows 45 minutes and the page says may wait 12 hours is the silent-clamp
  // defect again, one layer up.
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    let carrying = 0;
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const [budget, refs] = await Promise.all([
        engine(corpus, [slug, '--wait-budget', String(phase)], `${slug} p${phase} --wait-budget`),
        engine(corpus, [slug, '--waits-on', String(phase)], `${slug} p${phase} --waits-on`),
      ]);
      const js = waitBudgetFor(plan, phase);
      const jsLine = js ? `${js.minutes}\t${js.source}` : '';
      if (budget !== jsLine) problems.push(`${slug} p${phase}: wait budget JS "${jsLine}" vs engine "${budget}"`);
      assert.deepEqual(readWaitBudget({ code: 0, stdout: budget, stderr: '', ms: 0, timedOut: false }), js);
      const jsRefs = waitsOnFor(plan, phase);
      if (refs !== jsRefs.join('\n')) problems.push(`${slug} p${phase}: waits-on JS ${JSON.stringify(jsRefs)} vs engine ${JSON.stringify(refs)}`);
      assert.deepEqual(readWaitsOn({ code: 0, stdout: refs, stderr: '', ms: 0, timedOut: false }), jsRefs);
      if (js || jsRefs.length) carrying += 1;
    });
    for (const record of samplePlans(corpus)) {
      const planWide = await engine(corpus, [record.slug, '--wait-budget'], `${record.slug} --wait-budget`);
      const js = waitBudgetFor(record.plan!);
      const jsLine = js ? `${js.minutes}\t${js.source}` : '';
      if (planWide !== jsLine) problems.push(`${record.slug}: plan wait budget JS "${jsLine}" vs engine "${planWide}"`);
    }
    assert.deepEqual(problems, [], `${corpus.name} wait-budget mismatches:\n  ${problems.join('\n  ')}`);
    if (!corpus.live) assert.ok(carrying >= 4, 'the fixture corpus must carry the waits fixture, or this proves nothing');
  });
});

test('the two parsers agree about a phase\'s MCP policy — including silence', async () => {
  // Silence is the case worth pinning. Three states (`require`, `continue`,
  // nothing) collapse to two the moment one parser decides absence means
  // `continue`, and the console's resolution order depends on being able to
  // tell "the plan said carry on" from "the plan said nothing" — only the
  // second lets the run's own setting answer.
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const fromEngine = await engine(
        corpus, [slug, '--mcp-policy', String(phase)], `${slug} p${phase} --mcp-policy`);
      const fromJs = plan.phases[phase]?.mcpPolicy ?? plan.sessionBudget.mcpPolicy ?? '';
      if (fromEngine !== fromJs) {
        problems.push(`${slug} p${phase}: MCP policy JS "${fromJs}" vs engine "${fromEngine}"`);
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} MCP policy mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * The per-phase QA regime, which decides whether a recorded verdict HOLDS
 * dependents. The engine has resolved it per phase since `qa_mode_for_phase`
 * landed; the console asked the plan-wide question and applied the answer to
 * every phase (parse-recovery-5), so a phase that had opted out was told its
 * verdict gated — and a phase that had opted IN was told the opposite.
 */
test('the two parsers agree about which commands a phase brings up with', async () => {
  // Two readers of one new bullet, and they answer at different moments: the
  // engine's `--setup` is what a person and a boot prompt see, the parser's
  // `phases[N].setup` is what the runner actually executes. A plan-wide
  // `**Setup (every phase):**` line is unioned into both, plan first, and an
  // ordering difference here would mean the preamble a session is TOLD about
  // is not the preamble that runs.
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const fromEngine = (await engine(
        corpus, [slug, '--setup', String(phase)], `${slug} p${phase} --setup`))
        .split('\n').map((line) => line.trim()).filter(Boolean);
      // The JS side keeps the bullet's raw text; the commands it will run come
      // out of the same extractor §Verification uses, which is the comparable
      // thing — the engine emits backticked spans, and `extractCommands` is
      // what turns those into commands on the runtime side.
      const fromJs = extractCommands(plan.phases[phase]?.setup, 'setup').commands;
      if (fromEngine.join(' | ') !== fromJs.join(' | ')) {
        problems.push(`${slug} p${phase}: setup JS [${fromJs.join(', ')}] vs engine [${fromEngine.join(', ')}]`);
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} setup mismatches:\n  ${problems.join('\n  ')}`);
  });
});

test('the two parsers agree about a phase\'s QA regime', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      const line = await engine(corpus, [slug, '--qa-mode', String(phase)], `${slug} p${phase} --qa-mode`);
      const stated = plan.phases[phase]?.qa;
      // The engine names the level that answered in its parenthetical. When the
      // JS side says the phase stated a word, the engine must agree that the
      // PHASE answered — and with the same word.
      const enginePhaseLevel = /phase directive/.test(line);
      if (stated && !line.startsWith(stated)) {
        problems.push(`${slug} p${phase}: JS read phase directive "${stated}", engine said "${line}"`);
      }
      if (stated && !enginePhaseLevel) {
        problems.push(`${slug} p${phase}: JS read a phase directive, engine answered at plan level ("${line}")`);
      }
      if (!stated && enginePhaseLevel) {
        problems.push(`${slug} p${phase}: engine read a phase directive the JS parser missed ("${line}")`);
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} QA regime mismatches:\n  ${problems.join('\n  ')}`);
  });
});

test('the two parsers agree about QA verdicts and rounds, legacy tables included', async () => {
  // A corpus of its own, because the shipped fixtures carry no `test-status.md`
  // — and a parity test that finds nothing to compare passes while asserting
  // nothing. The tables here are written by the REAL `qa-record.sh`, plus one
  // hand-written three-column table, which is the shape every file written
  // before 2026-09-02 has and the one rounds could have broken: `Result` must
  // stay the third cell on both sides.
  const root = mkdtempSync(join(tmpdir(), 'pc-parity-qa-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', 'linear'), { recursive: true });
    copyFileSync(join(FIXTURES, 'linear.md'), join(root, 'docs', 'plans', 'linear.md'));

    const corpus: Corpus = { name: 'qa-rounds', root, live: false };
    const qaFile = join(root, 'docs', 'handoffs', 'linear', 'test-status.md');

    // A legacy three-column table, then rounds recorded over it by the writer.
    // Phase 3 carries a `-roundN.md` name and NO ledger, which is the shape the
    // corpus used to omit — and omitting it is what let the launcher's round
    // numbering disagree with the engine's through a green suite (QA round 2).
    writeFileSync(qaFile, [
      '# QA / test status — linear', '', '## QA status', '',
      '| Phase | Result | Report |', '|------:|--------|--------|',
      '| 1 | pass | reports/phase-01-qa.md |',
      '| 3 | fail | reports/phase-03-qa-round4.md |', '',
    ].join('\n'));
    for (const args of [
      ['linear', '2', 'fail', '--report', 'reports/phase-02-qa.md', '--round', '1'],
      ['linear', '2', 'pass', '--report', 'reports/phase-02-qa-round2.md', '--round', '2'],
    ]) {
      answered(await run(optsFor(corpus), 'qa-record.sh', args), `qa-record ${args.join(' ')}`);
    }

    const text = readFileSync(qaFile, 'utf8');
    const rows = parseTestStatus(text);
    const ledger = parseQaRounds(text);
    assert.ok(rows.length >= 3, `the corpus has rows to compare:\n${text}`);

    const problems: string[] = [];
    for (const row of rows) {
      const verdict = await engine(corpus, ['linear', '--qa-result', String(row.phase)], `p${row.phase}`);
      if (verdict !== row.result) {
        problems.push(`p${row.phase}: engine "${verdict}" vs parseTestStatus "${row.result}"`);
      }
      // …and the NEXT round each half would hand a reviewer, on every row —
      // plain legacy, `-roundN.md` legacy and ledgered alike — in the DEFAULT
      // run: QA round 6 measured the corpus sweep below comparing zero rows
      // without a live plan library. A brief that fails or names no round is a
      // finding, never a skip.
      const next = answered(await run(optsFor(corpus), 'phase-graph.sh', ['linear', '--qa-prompt', String(row.phase)]), `p${row.phase} --qa-prompt`);
      const named = /--report (\S+) --round (\d+)/.exec(next.stdout);
      if (next.code !== 0 || !named) {
        problems.push(`p${row.phase}: --qa-prompt exited ${next.code}${named ? '' : ' and named no round'}: ${next.stderr.trim().slice(0, 200)}`);
      } else {
        const js = nextQaRound(join(root, 'docs', 'handoffs', 'linear'), row.phase);
        if (js.round !== Number(named[2]) || js.report !== named[1]) {
          problems.push(`p${row.phase}: next round differs — engine ${named[2]} ${named[1]}, JS ${js.round} ${js.report}`);
        }
      }
      const mine = ledger.filter((r) => r.phase === row.phase);
      if (!mine.length) continue;
      const out = await engine(corpus, ['linear', '--qa-history', String(row.phase)], `p${row.phase} history`);
      const bash = out.split('\n').filter(Boolean).map((line) => {
        const [round, result, report] = line.split('\t');
        return { round: Number(round), result, report: report === '-' ? undefined : report };
      });
      const js = mine.map((r) => ({ round: r.round, result: r.result, report: r.report }));
      if (JSON.stringify(bash) !== JSON.stringify(js)) {
        problems.push(`p${row.phase}: rounds differ — engine ${JSON.stringify(bash)}, JS ${JSON.stringify(js)}`);
      }
    }
    assert.deepEqual(problems, [], `QA parity mismatches:\n  ${problems.join('\n  ')}`);

    // The untouched legacy rows still gate. A plain report name asserts no round
    // — the writer decides — while a `-roundN.md` one carries its number in both
    // readers, which is the parity the launcher bug slipped through.
    assert.equal(rows.find((r) => r.phase === 1)?.result, 'pass');
    assert.equal(rows.find((r) => r.phase === 1)?.round, undefined);
    assert.equal(rows.find((r) => r.phase === 3)?.round, 4, 'the filename is the round');
    const engineRound = await engine(corpus, ['linear', '--qa-history', '3'], 'p3 legacy history');
    assert.equal(engineRound.split('\t')[0], '4', `engine disagreed: ${engineRound}`);
    assert.equal(rows.find((r) => r.phase === 2)?.round, 2, 'and a recorded row says which round');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the two parsers agree about a phase\'s QA verdict and its rounds, across every plan', async () => {
  // `--qa-result` and `parseTestStatus` are the pair that DECIDES gating, and
  // until now they were held together only indirectly, through the board. That
  // left the one shape rounds could have broken untested: a three-column table
  // (every one written before 2026-09-02) against a four-column reader, where
  // `Result` has to stay the third cell on both sides.
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPlan(samplePlans(corpus), async (record) => {
      const slug = record.slug;
      const qaFile = record.handoffDir ? join(record.handoffDir, 'test-status.md') : undefined;
      if (!qaFile || !existsSync(qaFile)) return;
      const text = readFileSync(qaFile, 'utf8');
      const rows = parseTestStatus(text);
      const ledger = parseQaRounds(text);

      for (const row of rows) {
        const verdict = await engine(
          corpus, [slug, '--qa-result', String(row.phase)], `${slug} p${row.phase} --qa-result`,
        );
        if (verdict !== row.result) {
          problems.push(`${slug} p${row.phase}: engine said "${verdict}", parseTestStatus said "${row.result}"`);
        }

        // …and the NEXT round each half would hand a reviewer for this phase:
        // the engine's `--qa-prompt` against `nextQaRound` over the same
        // directory. No ledger is needed for this comparison — it is the one the
        // corpus sweep could not make while the round was compared only where a
        // ledger existed, and this plan's own file has none (QA round 5, F5).
        // A row for a phase the plan no longer has is skipped; a brief that
        // FAILS or names no round is a finding — QA round 6 measured an `08`
        // cell killing `--qa-prompt` with exit 1 while this read it as "QA off".
        if (!record.plan?.graph.some((g) => g.phase === row.phase)) continue;
        const next = answered(await run(optsFor(corpus), 'phase-graph.sh', [slug, '--qa-prompt', String(row.phase)]), `${slug} p${row.phase} --qa-prompt`);
        const named = /--report (\S+) --round (\d+)/.exec(next.stdout);
        if (next.code !== 0 || !named) {
          problems.push(`${slug} p${row.phase}: --qa-prompt exited ${next.code}${named ? '' : ' and named no round'}: ${next.stderr.trim().slice(0, 200)}`);
        } else {
          const js = nextQaRound(record.handoffDir, row.phase);
          if (js.round !== Number(named[2]) || js.report !== named[1]) {
            problems.push(`${slug} p${row.phase}: next round differs — engine ${named[2]} ${named[1]}, JS ${js.round} ${js.report}`);
          }
        }

        // …and the history behind it, round for round. The bash side falls back
        // to the status row when there is no ledger, which the JS `parseQaRounds`
        // deliberately does not — so that case is compared only where a ledger
        // exists, which is exactly where both are answering the same question.
        const mine = ledger.filter((r) => r.phase === row.phase);
        if (!mine.length) continue;
        const out = await engine(
          corpus, [slug, '--qa-history', String(row.phase)], `${slug} p${row.phase} --qa-history`,
        );
        const bash = out.split('\n').filter(Boolean).map((line) => {
          const [round, result, report] = line.split('\t');
          return { round: Number(round), result, report: report === '-' ? undefined : report };
        });
        const js = mine.map((r) => ({ round: r.round, result: r.result, report: r.report }));
        if (JSON.stringify(bash) !== JSON.stringify(js)) {
          problems.push(`${slug} p${row.phase}: rounds differ — engine ${JSON.stringify(bash)}, JS ${JSON.stringify(js)}`);
        }
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} QA verdict/round mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * F14 and the runner's preflight must agree about whether a phase has anything
 * runnable in its §Verification.
 *
 * F14 warns from `_verification_reach`; the preflight parks from
 * `extractCommands(plan.phases[N].verification)`. When those disagree the plan
 * lints clean and the phase parks at boarding with "the console could not read
 * a runnable command out of it" — which is exactly what an un-indented sibling
 * list did (parse-recovery-2). The lint is the engine's word for "there is
 * something here", so the JS side must find something wherever F14 is quiet.
 */
test('a phase F14 accepts has commands the preflight can run', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];

    await forEachPlan(samplePlans(corpus), async (record) => {
      const plan = record.plan!;
      const lint = answered(
        await run(optsFor(corpus), 'phase-graph.sh', [record.slug, '--lint']),
        `${corpus.name}: ${record.slug} --lint`,
      );
      const warnings = `${lint.stdout}\n${lint.stderr}`;

      for (const row of plan.graph) {
        const detail = plan.phases[row.phase];
        // Only phases that DECLARE a §Verification are in scope: F14's subject
        // is a declared-but-unreadable one, and a phase with no bullet at all
        // is a different warning both sides already agree about.
        if (detail?.verification === undefined) continue;
        // F14 is a GATE since 5.0.0 and names itself in the issue line.
        const warned = new RegExp(`phase ${row.phase}: verification-empty-open`).test(warnings);
        // READ, not RUN. `extractCommands` also REFUSES what it will not
        // execute — an unbounded `gh run watch`, a mutating `task deploy` — and
        // those land in `notRun` with a reason. That is a deliberate difference
        // of policy from F14, whose question is only "is there anything
        // command-shaped here"; F16 is the warning that covers the refusals.
        // The parity question is whether the JS side saw the text AT ALL, which
        // is what an empty Verification body cost it.
        const extraction = extractCommands(detail.verification);
        const read = extraction.commands.length + extraction.notRun.length;
        if (!warned && read === 0) {
          problems.push(
            `${record.slug} p${row.phase}: F14 is quiet (the engine found something runnable) `
            + 'but the JS reading extracted nothing at all — the phase would park at boarding',
          );
        }
      }
    });

    assert.deepEqual(problems, [], `${corpus.name} verification mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * A `--session-plan` group must contain the phases of the BATCH and nothing
 * else.
 *
 * The engine appends its flags to the same line (`  ⚠ waiting on: 2`), and
 * `readSessionPlan` used to sweep the whole line for digits — so an unmet
 * dependency was returned as a member of the batch and the route map drew the
 * session line through a phase that is not in it (parse-recovery-1).
 */
test('a session-plan group never adopts the phases it is waiting on', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];

    await forEachPlan(samplePlans(corpus), async (record) => {
      const result = answered(
        await run(optsFor(corpus), 'phase-graph.sh', [record.slug, '--session-plan', 'claude-opus-5']),
        `${corpus.name}: ${record.slug} --session-plan`,
      );
      const plan = readSessionPlan(result);
      const known = new Set(record.plan!.graph.map((r) => r.phase));

      for (const group of plan.groups) {
        for (const phase of group.phases) {
          if (!known.has(phase)) {
            problems.push(`${record.slug} session ${group.index}: phase ${phase} is not in the plan at all`);
          }
        }
        // Whatever a line's flags say, the numbers inside them are not members.
        const line = plan.raw.split('\n').find((l) => new RegExp(`Session ${group.index}\\b`).test(l)) ?? '';
        const waiting = /⚠ waiting on:([^⚠🔒]*)/.exec(line)?.[1] ?? '';
        for (const dep of waiting.trim().split(/\s+/).filter(Boolean).map(Number)) {
          if (group.phases.includes(dep)) {
            problems.push(
              `${record.slug} session ${group.index}: phase ${dep} is a flagged DEPENDENCY `
              + `but was returned as a member (${JSON.stringify(group.phases)})`,
            );
          }
        }
      }
    });

    assert.deepEqual(problems, [], `${corpus.name} session-plan mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * The plan-wide skills line, as the boot prompt carries it.
 *
 * There is no `--skills` mode, so the boot prompt is the observable: the engine
 * re-injects `plan_skills()` into every one. `plan_skills` matches the PHRASE
 * (`grep -i 'skills (every session)'`) while the JS reader required the exact
 * bold span, so an unbolded budget line reached every session through the
 * engine and was missing from the console's own QA brief (parse-recovery-14).
 */
test('the skills a plan names reach the engine\'s boot prompt', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    const store = new Store(checkRoot(corpus.root));
    store.scan();
    // Only the plans that NAME skills — most name none, and a boot prompt is a
    // whole-graph walk. Not sampled: this is the assertion the fixture
    // `skilled.md` and `unbolded.md` exist for, and there are few of them.
    const withSkills = store.list()
      .filter((r) => r.plan?.phased && (r.plan.sessionBudget.skills ?? []).length > 0);

    await forEachPlan(withSkills, async (record) => {
      const skills = record.plan!.sessionBudget.skills ?? [];
      const first = record.plan!.graph[0]?.phase;
      if (first === undefined) return;
      const prompt = await engine(
        corpus, [record.slug, '--boot-prompt', String(first)], `${record.slug} --boot-prompt`);
      for (const skill of skills) {
        if (!prompt.includes(skill)) {
          problems.push(`${record.slug}: JS read skill "${skill}" that the engine's boot prompt never names`);
        }
      }
    });

    assert.deepEqual(problems, [], `${corpus.name} skills mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/* ------------------------------------------------------------------ *
 * Store behaviour over a real library
 * ------------------------------------------------------------------ */

test('handoff folders without a plan are kept as orphans', { skip: !liveAvailable && 'no live plan library' }, () => {
  const store = new Store(checkRoot(LIVE_ROOT));
  store.scan();
  const orphans = store.list().filter((r) => r.kind === 'orphan-handoffs');
  for (const orphan of orphans) {
    assert.equal(orphan.planPath, undefined);
    // Some orphans are abandoned work that left only a stale lock behind —
    // still worth surfacing, so the store keeps them either way.
    assert.ok(
      orphan.handoffs.length > 0 || orphan.locks.length > 0 || orphan.index.length > 0,
      `${orphan.slug} should carry handoffs, an index or locks`,
    );
  }
});

test('the store reads every handoff file it should', { skip: !liveAvailable && 'no live plan library' }, () => {
  const store = new Store(checkRoot(LIVE_ROOT));
  store.scan();

  const handoffsDir = checkRoot(LIVE_ROOT).handoffsDir!;
  let onDisk = 0;
  for (const dir of safeList(handoffsDir)) {
    const full = join(handoffsDir, dir);
    if (dir.startsWith('.') || !statSync(full).isDirectory()) continue;
    onDisk += safeList(full).filter((f) => /^phase-\d+-.*\.md$/.test(f)).length;
  }
  const parsed = store.list().reduce((n, r) => n + r.handoffs.length, 0);
  assert.equal(parsed, onDisk);
});

test('the live plan library validates', { skip: !liveAvailable && 'no live plan library' }, () => {
  const check = checkRoot(LIVE_ROOT);
  assert.equal(check.ok, true);
  assert.ok(check.planCount > 0, 'expected plans');
});

/* ------------------------------------------------------------------ *
 * The fixture corpus itself
 * ------------------------------------------------------------------ */

/**
 * The nine directives 5.1.0 adds, both parsers, every phase of every fixture.
 *
 * This family is the one that answers `value<TAB>source`, and the source token
 * is the part worth pinning: everything above it either answers a bare word or
 * a list, so a parser that resolved the levels in the wrong order would still
 * print something plausible. Here it would print `hold` from the plan while the
 * engine printed `hold` from the phase, and the only visible difference — the
 * word the console uses to decide whether the wizard still has to ask — is the
 * one a bare-word comparison would have thrown away.
 */
test('the two parsers agree about landing, isolation and issues — the word AND which level said it', async () => {
  const perPhase: [string, (plan: Plan, phase: number) => { value: string; source: string } | undefined][] = [
    ['--land', (plan, phase) => landFor(plan, phase)],
    ['--gitlink', (plan, phase) => gitlinkFor(plan, phase)],
    ['--issues', (plan, phase) => issuesFor(plan, phase)],
    ['--isolation', (plan, phase) => isolationFor(plan, phase)],
  ];
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    await forEachPhase(everyPhase(corpus), async ({ slug, plan, phase }) => {
      for (const [flag, read] of perPhase) {
        const fromEngine = await engine(corpus, [slug, flag, String(phase)], `${slug} p${phase} ${flag}`);
        const js = read(plan, phase);
        // `--isolation` is the one arm that legitimately prints nothing: a
        // phase that says nothing inherits the run, and the run is not in the
        // plan. Both sides must say nothing, not one of them a default.
        const fromJs = js === undefined ? '' : `${js.value}\t${js.source}`;
        if (fromEngine !== fromJs) {
          problems.push(`${slug} p${phase} ${flag}: JS ${JSON.stringify(fromJs)} vs engine ${JSON.stringify(fromEngine)}`);
        }
      }
    });
    assert.deepEqual(problems, [], `${corpus.name} directive mismatches:\n  ${problems.join('\n  ')}`);
  });
});

test('the two parsers agree about the plan-wide directives — base branch, conflicts, messaging, clash zones', async () => {
  await forEachCorpus(async (corpus) => {
    const problems: string[] = [];
    for (const record of samplePlans(corpus)) {
      const { slug } = record;
      const plan = record.plan!;
      const cases: [string, string][] = [
        ['--base-branch', `${baseBranchOf(plan).value}\t${baseBranchOf(plan).source}`],
        ['--conflict-policy', `${conflictPolicyOf(plan).value}\t${conflictPolicyOf(plan).source}`],
        ['--messaging', `${messagingOf(plan).value}\t${messagingOf(plan).source}`],
        ['--clash-zones', clashZonesOf(plan).join(', ')],
      ];
      for (const [flag, fromJs] of cases) {
        const fromEngine = await engine(corpus, [slug, flag], `${slug} ${flag}`);
        if (fromEngine !== fromJs) {
          problems.push(`${slug} ${flag}: JS ${JSON.stringify(fromJs)} vs engine ${JSON.stringify(fromEngine)}`);
        }
      }
    }
    assert.deepEqual(problems, [], `${corpus.name} plan-wide directive mismatches:\n  ${problems.join('\n  ')}`);
  });
});

test('the fixture corpus is real, and covers the divergences this suite exists for', () => {
  const files = safeList(FIXTURES).filter((f) => f.endsWith('.md') && !f.startsWith('bad-'));
  assert.ok(files.length > 15, `expected a real fixture corpus, saw ${files.length}`);
  // Named explicitly: each of these encodes a divergence that shipped, and a
  // corpus that quietly lost one would go green while the bug came back.
  for (const required of [
    'ranges.md',                  // range dependency cells (coverage-1's example)
    'scoped.md',                  // the Repos column (coverage-20)
    'sizes.md', 'size-twice.md',  // size weights, and the greedy anchor
    'gated.md', 'gatecheck.md',   // gate flags and categories
    'mcp.md', 'mcp-policy.md',    // the MCP directives, including silence
    'qa-per-phase.md',            // the per-phase QA regime
    'skilled.md', 'unbolded.md',  // the skills line, bolded and not
    'nested-verification.md', 'sibling-verification.md',  // both §Verification shapes
    'decisions.md', 'credentials.md',  // the decision manifest (with an undeclared gate) and the credential directives
    'landing.md', 'messaging.md', 'issues.md',  // the 5.1.0 directives: plan-only, phase-only, both, and silence
  ]) {
    assert.ok(files.includes(required), `fixture ${required} is missing from the parity corpus`);
  }
});

test('the fixture corpus parses without the engine reporting an error', async () => {
  const fixtures = fixtureCorpus();
  try {
    for (const slug of fixtures.slugs) {
      const result = answered(
        await run(optsFor(fixtures), 'phase-graph.sh', [slug, '--memory-block']),
        `fixtures: ${slug} --memory-block`,
      );
      const board = readMemoryBlock(result);
      assert.equal(board.error, undefined, `fixture ${slug}: engine said "${board.error}"`);
      assert.equal(board.phased, true, `fixture ${slug}: the engine parsed no graph`);
    }
  } finally {
    fixtures.cleanup();
  }
});
