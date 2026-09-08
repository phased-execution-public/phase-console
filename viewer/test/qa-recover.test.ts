/**
 * QA recovery — the loop an operator asks for by name (issue #11).
 *
 * A recorded `fail` — and a `pending` — holds every dependent phase, and until
 * this existed there was nothing to press: the ladder's `qa-fix` rung climbed
 * until its attempt and dollar caps were spent and then parked with an errand
 * naming no action, and a hand-driven plan had no rung at all.
 *
 * Two halves, tested two ways. The PURE half (`server/runner/qa-recover.ts`) is
 * the loop's words and arithmetic and is asserted directly — a prompt is easier
 * to get wrong than a spawn and far cheaper to pin. The LOOP half is driven
 * against a stub `claude` and a stub engine whose `--qa-result` / `--qa-history`
 * answer off a file the stub session writes, which is the only honest way to
 * test "the verdict is re-read off the file every round".
 *
 * The harness is `git-strategy.test.ts`'s, narrowed: one plan, one phase, and
 * an engine that answers the five commands this path actually asks.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-qarecover-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';
// The console exports `PE_*` into every session it spawns, this suite included
// when it runs under an autopilot. `sessionEnv` spreads `process.env`, so a
// leaked claim variable is the third harness this has reached.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER']) delete process.env[key];

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord, saveRun, journalFile } = await import('../server/runner/state.ts');
const {
  QA_FINDINGS_MAX, qaExhaustedErrand, qaFixInstruction, readQaFindings, releasesGate,
  overRoundBudget, roundBudgetUsd,
} = await import('../server/runner/qa-recover.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

/* ------------------------------------------------------------------ *
 * The pure half — words and arithmetic, no process
 * ------------------------------------------------------------------ */

test('readQaFindings answers the report VERBATIM, and empty when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-qa-findings-'));
  try {
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'reports', 'phase-01-qa.md'), '# QA\n\nF1 (High) — the gate is inverted.\n');
    assert.match(readQaFindings(dir, 'reports/phase-01-qa.md'), /F1 \(High\) — the gate is inverted\./);
    // The three absences, which are all real states and none of them an error:
    // a report nobody wrote, a `-` cell (the roundless waiver), and no dir.
    assert.equal(readQaFindings(dir, 'reports/phase-01-qa-round9.md'), '');
    assert.equal(readQaFindings(dir, '-'), '');
    assert.equal(readQaFindings(undefined, 'reports/phase-01-qa.md'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a report longer than the cap keeps its HEAD and its TAIL, and says what it cut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-qa-findings-long-'));
  try {
    mkdirSync(join(dir, 'reports'), { recursive: true });
    // A QA report leads with its findings and ends with its verdict and
    // follow-ups; dropping either end loses a different half of what a fix
    // session needs, which is why this is not a plain truncation.
    const body = `FIRST-FINDING\n${'x'.repeat(QA_FINDINGS_MAX * 3)}\nLAST-VERDICT`;
    writeFileSync(join(dir, 'reports', 'phase-01-qa.md'), body);
    const out = readQaFindings(dir, 'reports/phase-01-qa.md');
    assert.match(out, /^FIRST-FINDING/);
    assert.match(out, /LAST-VERDICT$/);
    assert.match(out, /characters of this report omitted/);
    assert.ok(out.length < body.length, 'a long report is cut');
    // Bounded by the cap plus the one line that says what was cut — and NOT by
    // the cap alone: for a report a few characters over, the notice makes the
    // answer marginally longer than the input, which is the honest trade for
    // never silently dropping a finding.
    assert.ok(out.length < QA_FINDINGS_MAX + 120, 'and bounded by the cap plus its notice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the fix instruction carries the findings, the round it must record, and the honest out', () => {
  const text = qaFixInstruction({
    slug: 'demo', phase: 4, round: 3, report: 'reports/phase-04-qa-round3.md',
    priorReport: 'reports/phase-04-qa-round2.md',
    findings: 'F1 (High) — the gate is inverted.',
  });
  assert.match(text, /F1 \(High\) — the gate is inverted\./);
  // The exact record line, with the round the ONE chooser picked — never a
  // literal. Four QA rounds of Phase 4 were four different ways of getting
  // this wrong.
  assert.match(text, /qa-record\.sh demo 4 <pass\|fail\|waived> --report reports\/phase-04-qa-round3\.md --round 3/);
  assert.match(text, /reports\/phase-04-qa-round2\.md/);
  // The honest out, and the thing it must NOT license.
  assert.match(text, /waived --reason/);
  assert.match(text, /do not record `pass` over a finding you did not clear/);
});

test('a fix session with no readable report is TOLD so rather than handed a fiction', () => {
  // A session told "the findings are below" and handed nothing will invent
  // some, which is the one failure mode worse than having no findings.
  const text = qaFixInstruction({ slug: 'demo', phase: 4, round: 2, report: 'r.md', findings: '' });
  assert.match(text, /could not be read/);
  assert.doesNotMatch(text, /--- the QA report, verbatim ---/);
});

test('a FRESH fix session is told it did not build the phase; a resumed one is not', () => {
  const fresh = qaFixInstruction({ slug: 'demo', phase: 4, round: 2, report: 'r.md', fresh: true });
  const resumed = qaFixInstruction({ slug: 'demo', phase: 4, round: 2, report: 'r.md' });
  assert.match(fresh, /You did not build this phase/);
  assert.doesNotMatch(resumed, /You did not build this phase/);
});

test('only pass and waived release the gate — the two words _is_verified accepts', () => {
  for (const word of ['pass', 'waived']) assert.equal(releasesGate(word), true, word);
  for (const word of ['fail', 'pending', 'none', '', undefined, null]) {
    assert.equal(releasesGate(word), false, String(word));
  }
});

test('a round budget is a stop for the ROUND, and falls back to the phase budget', () => {
  assert.equal(roundBudgetUsd(20, 100), 20, 'the round cap wins when it says something');
  assert.equal(roundBudgetUsd(null, 100), 100, 'else the phase budget bounds it');
  assert.equal(roundBudgetUsd(undefined, null), null, 'and absent both means no ceiling');
  // Zero is not a budget, it is a run that could never spend — it falls through
  // to the phase budget rather than making every round a no-op.
  assert.equal(roundBudgetUsd(0, 50), 50);
  // `>=`, and no cap at all when the cap is null — `overDayCap`'s reading.
  assert.equal(overRoundBudget(20, 20), true);
  assert.equal(overRoundBudget(19.99, 20), false);
  assert.equal(overRoundBudget(1_000, null), false);
});

test('the exhausted errand names the LAST report, the rounds and the verbs', () => {
  const errand = qaExhaustedErrand({
    phase: 4, rounds: 3, maxRounds: 3, report: 'reports/phase-04-qa-round4.md', spentUsd: 12.5,
  });
  // The report describing the code AS IT STANDS, never the one that started the
  // loop — an errand that says "fix what the QA report names" after three
  // rounds has named nothing a person can open.
  assert.match(errand.how, /reports\/phase-04-qa-round4\.md/);
  assert.match(errand.how, /as it stands/);
  assert.match(errand.need, /3 of the 3 rounds/);
  assert.match(errand.need, /\$12\.50/);
  // The verbs BY NAME — the whole point of issue #11's errand.
  for (const verb of ['Fix & re-QA', 'Waive with a reason', 'Re-run QA']) {
    assert.ok(errand.how.includes(verb), `the errand names ${verb}`);
  }
  assert.deepEqual(errand.tried, ['qa round 1 → fail', 'qa round 2 → fail', 'qa round 3 → fail']);
  assert.equal(errand.situation, 'qa-failed');
});

/* ------------------------------------------------------------------ *
 * The loop — driven against a stub session and a stub engine
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; state: string; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * A plan with one phase and a QA verdict the stub session can move.
 *
 * `$S/verdict` is the CURRENT verdict and `$S/history` the ledger, both plain
 * files the stub engine reads — so "the verdict is re-read off the file at the
 * top of every round" is a property this harness can actually observe, rather
 * than one the test asserts about its own bookkeeping.
 */
function repo(verdict = 'fail', qaMode = 'on (plan directive)'): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-qarecover-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  const handoffs = join(root, 'docs', 'handoffs', 'demo', 'reports');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(handoffs, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  // A REAL phased plan, not a stub heading: `Service.qaMode` short-circuits to
  // `off` for a plan whose `## Phase graph` table it cannot parse, so a fixture
  // without one makes the gate guard untestable by making it always true.
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), [
    '# demo',
    '',
    '## Session budget',
    '',
    `> **QA gate:** ${qaMode.startsWith('on') ? 'on' : 'off'}`,
    '',
    '## Phase graph',
    '',
    '| Phase | Title | Depends on | Repos |',
    '|---|---|---|---|',
    '| 1 | one | — | demo-repo |',
    '',
    '## Phases',
    '',
    '### Phase 1 — one',
    '- **Verification:** `true`',
    '',
  ].join('\n'));
  writeFileSync(join(state, 'verdict'), `${verdict}\n`);
  writeFileSync(join(state, 'qamode'), `${qaMode}\n`);
  // Round 1 already recorded and its report on disk — the shape a recovery
  // always starts from, and what makes `nextQaRound` answer round 2.
  writeFileSync(join(state, 'history'), '1\tfail\treports/phase-01-qa.md\t2026-09-05\n');
  writeFileSync(join(handoffs, 'phase-01-qa.md'), '# QA round 1\n\nF1 (High) — SENTINEL-FINDING.\n');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
case "\${1:-}" in
  --memory-block) echo "done: 1"; echo "ready:"; echo "waiting:" ;;
  --boot-prompt)  echo "BOOT phase \${2:-}" ;;
  --qa-mode)      cat "$S/qamode" ;;
  --qa-result)    cat "$S/verdict" ;;
  --qa-history)   cat "$S/history" ;;
  --gate-status)  echo "clear" ;;
  --repos)        echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');

  return { root, scripts, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function outcome(sessionId = 'sess-0001'): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId, costUsd: 1.25, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/** The stored run a recovery acts on — `qaRecover` never invents one here. */
function seedRun(r: Repo, extra: Record<string, unknown> = {}): string {
  const state = newRun({ slug: 'demo', root: r.root, onlyPhases: [1], ...extra } as never);
  state.status = 'paused';
  const record = phaseRecord(state, 1);
  record.status = 'done';
  record.sessionId = 'sess-built';
  saveRun(state);
  return state.id;
}

/**
 * Drive `qaRecover` and hand back every prompt, plus the journal.
 *
 * `record` is what the stub session DOES to the verdict file each round — the
 * stand-in for a real session running `qa-record.sh`. It is given the round
 * number so a test can say "fail twice, then pass".
 */
async function drive(
  r: Repo,
  options: Record<string, unknown>,
  record: (round: number) => string | null,
): Promise<{ prompts: SpawnRequest[]; journal: string }> {
  const prompts: SpawnRequest[] = [];
  let round = 0;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    prompts.push(request);
    round += 1;
    const verdict = record(round);
    if (verdict) {
      // Everything a session running `qa-record.sh` does, and all three parts
      // matter: move the current verdict, append the round to the ledger, and
      // WRITE THE REPORT. The third is what makes `nextQaRound` advance — a
      // harness that skipped it would brief round 2 forever and the "records
      // round N+1" assertion would be testing its own bookkeeping.
      const n = round + 1;
      writeFileSync(join(r.state, 'verdict'), `${verdict}\n`);
      writeFileSync(
        join(r.state, 'history'),
        `${n}\t${verdict}\treports/phase-01-qa-round${n}.md\t2026-09-05\n`,
        { flag: 'a' },
      );
      writeFileSync(
        join(r.root, 'docs', 'handoffs', 'demo', 'reports', `phase-01-qa-round${n}.md`),
        `# QA round ${n}\n\n${verdict}\n`,
      );
    }
    return outcome(`sess-round-${round}`);
  };
  const runId = seedRun(r, options.seed as Record<string, unknown> ?? {});
  const runner = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
  } as never);
  await runner.qaRecover({
    slug: 'demo', root: r.root, runId, phase: 1,
    verb: 'qa-recover', maxRounds: 3,
    ...options,
  } as never);
  await runner.wait();
  const journalPath = journalFile(r.root, 'demo', runId);
  let journal = '';
  try { journal = readFileSync(journalPath, 'utf8'); } catch { journal = ''; }
  return { prompts, journal };
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

test('EC2: a fix session is boarded carrying the last report’s findings verbatim', async () => {
  const r = repo('fail');
  try {
    const { prompts, journal } = await drive(r, {}, () => 'pass');
    assert.equal(prompts.length, 1, 'one round, because the first one passed');
    // The findings, VERBATIM — the requirement, not a nicety: a summary of a QA
    // report is a second opinion by something that has not read the diff.
    assert.match(prompts[0]!.prompt, /SENTINEL-FINDING/);
    // …and the round it must record, from the ONE chooser: round 1 is on file,
    // so this is round 2 and its own report name.
    assert.match(prompts[0]!.prompt, /--report reports\/phase-01-qa-round2\.md --round 2/);
    assert.match(journal, /"event":"phase\.qa-recover"/);
    assert.match(journal, /"event":"phase\.qa-round"/);
  } finally { r.cleanup(); }
});

test('EC2: three failed rounds journal phase.qa-exhausted with ONE errand naming the last report', async () => {
  const r = repo('fail');
  try {
    const { prompts, journal } = await drive(r, { maxRounds: 3 }, () => 'fail');
    assert.equal(prompts.length, 3, 'exactly the budget, never a fourth');
    const line = journal.split('\n').find((l) => l.includes('"phase.qa-exhausted"'));
    assert.ok(line, 'the exhausted line is journalled');
    const event = JSON.parse(line!).data;
    assert.equal(event.rounds, 3);
    assert.equal(event.maxRounds, 3);
    // The LAST report — round 4's, which round 3's session wrote — never the
    // one the loop started from.
    assert.equal(event.report, 'reports/phase-01-qa-round4.md');
    assert.match(event.errand.how, /reports\/phase-01-qa-round4\.md/);
    assert.match(event.errand.how, /Fix & re-QA/);
    // The money is booked, so the errand can say what it cost.
    assert.ok(event.costUsd > 0, 'the loop reports what it spent');
    // Exactly one errand for three rounds — the rule the whole ladder keeps.
    assert.equal(journal.split('\n').filter((l) => l.includes('"phase.qa-exhausted"')).length, 1);
  } finally { r.cleanup(); }
});

test('EC3: a pass recorded in round k stops the loop and journals the recovery', async () => {
  const r = repo('fail');
  try {
    // Fail, fail, pass — the shape the budget exists to allow.
    const { prompts, journal } = await drive(r, { maxRounds: 3 }, (n) => (n < 3 ? 'fail' : 'pass'));
    assert.equal(prompts.length, 3);
    assert.match(journal, /"event":"phase\.qa-recovered"/);
    assert.doesNotMatch(journal, /"event":"phase\.qa-exhausted"/);
    // The verdict on file is what released it, and the loop says which.
    const line = journal.split('\n').find((l) => l.includes('"phase.qa-recovered"'))!;
    assert.equal(JSON.parse(line).data.verdict, 'pass');
  } finally { r.cleanup(); }
});

test('a verdict that already releases the gate is never re-reviewed', async () => {
  // The one outcome this loop must never have: "fixing" a passing phase. The
  // verdict is re-read off the FILE at the top of every round, so a pass
  // recorded by hand or from another clone mid-loop stops it too.
  const r = repo('pass');
  try {
    const { prompts } = await drive(r, {}, () => null);
    assert.equal(prompts.length, 0, 'nothing was spawned over a passing phase');
  } finally { r.cleanup(); }
});

test('EC4: qa-rerun boards the REVIEW alone — no fix session, no findings', async () => {
  const r = repo('fail');
  try {
    const { prompts } = await drive(r, { verb: 'qa-rerun', maxRounds: 1 }, () => 'pass');
    assert.equal(prompts.length, 1);
    // The verdict brief, which asks for a review and never for a fix.
    assert.doesNotMatch(prompts[0]!.prompt, /SENTINEL-FINDING/);
    assert.doesNotMatch(prompts[0]!.prompt, /Fix what it found/);
    assert.match(prompts[0]!.prompt, /qa-record\.sh/);
  } finally { r.cleanup(); }
});

test('EC5: the reviewer runs at the run’s own qaModel/qaEffort, not the builder’s', async () => {
  const r = repo('fail');
  try {
    const { prompts } = await drive(
      r,
      { maxRounds: 1, seed: { model: 'opus', effort: 'max', qaModel: 'sonnet', qaEffort: 'low' } },
      () => 'pass',
    );
    assert.equal(prompts[0]!.model, 'sonnet');
    assert.equal(prompts[0]!.effort, 'low');
  } finally { r.cleanup(); }
});

test('the round budget bounds ONE round and never the run', async () => {
  const r = repo('fail');
  try {
    const { prompts } = await drive(r, { maxRounds: 2, roundBudgetUsd: 7 }, () => 'fail');
    assert.equal(prompts.length, 2, 'both rounds ran');
    // Each round got the ROUND's ceiling — not a share of it, and not the
    // phase's whole allowance spent on round one.
    for (const request of prompts) assert.equal(request.budgetUsd, 7);
  } finally { r.cleanup(); }
});

test('the `fresh` strategy boards from the boot prompt; `resume` continues the session', async () => {
  const r = repo('fail');
  try {
    const fresh = await drive(r, { maxRounds: 1, strategy: 'fresh' }, () => 'pass');
    assert.match(fresh.prompts[0]!.prompt, /BOOT phase 1/, 'a fresh session gets the plan first');
    assert.equal(fresh.prompts[0]!.resume, undefined);
    assert.match(fresh.prompts[0]!.prompt, /SENTINEL-FINDING/, 'and the findings under it');
  } finally { r.cleanup(); }

  const r2 = repo('fail');
  try {
    const resumed = await drive(r2, { maxRounds: 1, strategy: 'resume' }, () => 'pass');
    assert.equal(resumed.prompts[0]!.resume, 'sess-built');
    assert.doesNotMatch(resumed.prompts[0]!.prompt, /BOOT phase 1/);
  } finally { r2.cleanup(); }
});

test('with no session to resume, `resume` falls back to a fresh boarding by itself', async () => {
  // The strategy is a PREFERENCE, never a promise the machine can always keep:
  // a run from another console, a hand-driven plan, a transcript that is gone.
  const r = repo('fail');
  try {
    const prompts: SpawnRequest[] = [];
    const spawn: SpawnFn = async (request) => {
      prompts.push(request);
      writeFileSync(join(r.state, 'verdict'), 'pass\n');
      return outcome('sess-fresh');
    };
    const state = newRun({ slug: 'demo', root: r.root, onlyPhases: [1] } as never);
    state.status = 'paused';
    phaseRecord(state, 1).status = 'done';   // …and deliberately NO sessionId
    saveRun(state);
    const runner = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' } as never);
    await runner.qaRecover({
      slug: 'demo', root: r.root, runId: state.id, phase: 1,
      verb: 'qa-recover', strategy: 'resume', maxRounds: 1,
    } as never);
    await runner.wait();
    assert.equal(prompts.length, 1, 'it boarded rather than giving up');
    assert.equal(prompts[0]!.resume, undefined);
    assert.match(prompts[0]!.prompt, /BOOT phase 1/);
  } finally { r.cleanup(); }
});

test('QA round 1 (M4): qa-rerun with no session to resume boards FRESH, not zero rounds', () => {
  // The hand-driven case this verb exists for. `qa-rerun` forced `fresh: false`
  // regardless, so `qaRound` found no session, recorded a skip and answered
  // null — and the loop "exhausted" after ZERO rounds with a self-contradictory
  // errand ("spent 0 of 3 rounds… and every one of them failed").
  const r = repo('fail');
  return (async () => {
    try {
      const prompts: SpawnRequest[] = [];
      const spawn: SpawnFn = async (request) => {
        prompts.push(request);
        writeFileSync(join(r.state, 'verdict'), 'pass\n');
        return outcome('sess-fresh');
      };
      const state = newRun({ slug: 'demo', root: r.root, onlyPhases: [1] } as never);
      state.status = 'paused';
      phaseRecord(state, 1).status = 'done';   // …and deliberately NO sessionId
      saveRun(state);
      const runner = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' } as never);
      await runner.qaRecover({
        slug: 'demo', root: r.root, runId: state.id, phase: 1,
        verb: 'qa-rerun', maxRounds: 3,
      } as never);
      await runner.wait();
      assert.equal(prompts.length, 1, 'the review was boarded rather than skipped');
      assert.equal(prompts[0]!.resume, undefined);
      assert.match(prompts[0]!.prompt, /BOOT phase 1/, 'a fresh review gets the plan first');
      // …and it is still the REVIEW, never a fix: `fresh` is about how a fix
      // session boards, and this verb has none.
      assert.doesNotMatch(prompts[0]!.prompt, /SENTINEL-FINDING/);
    } finally { r.cleanup(); }
  })();
});

test('QA round 1 (M4): the `fresh` STRATEGY does not make qa-rerun board fresh over a live session', () => {
  // The other half of the same fix: the strategy word is about the FIX session,
  // and a review-only verb must go on resuming the session that holds the
  // context whatever an operator picked for a fix it is not running.
  const r = repo('fail');
  return (async () => {
    try {
      const { prompts } = await drive(r, { verb: 'qa-rerun', strategy: 'fresh', maxRounds: 1 }, () => 'pass');
      assert.equal(prompts[0]!.resume, 'sess-built');
      assert.doesNotMatch(prompts[0]!.prompt, /BOOT phase 1/);
    } finally { r.cleanup(); }
  })();
});

/* ------------------------------------------------------------------ *
 * The SERVICE's own doors — the refusals that stand before any spawn
 * ------------------------------------------------------------------ */

const { Service } = await import('../server/service.ts');

/**
 * A console over the stub root, allowed to run and to write.
 *
 * ⚠️ **Close it.** A `Service` arms a `DocsWatcher` and a handful of timers at
 * `open()`, and nothing here is a process boundary — an unclosed one outlives
 * its test, then spews `ENOENT` at the temp root the `finally` has already
 * removed and can leave the runner waiting on a live handle. Round 2's reviewer
 * had to kill a process stuck exactly that way. `opened` collects them so a
 * test cannot forget.
 */
const opened: InstanceType<typeof Service>[] = [];
function service(r: Repo) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false,
    allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: r.scripts, logFile: null, converge: false,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(r.root).ok, true, 'the stub root opens');
  opened.push(svc);
  return svc;
}

/** Shut every console this file opened, whatever its test did. */
function closeConsoles(): void {
  while (opened.length) {
    try { opened.pop()!.close(); } catch { /* a console that never armed is already shut */ }
  }
}

// The belt: a test that throws before its own `finally`, or one added later
// that forgets, still cannot leak a watcher into the rest of the run.
afterEach(closeConsoles);

test('QA round 1 (M1): qa-recover refuses when the gate is NOT holding, whatever the row says', async () => {
  // The door read the raw verdict alone, so a plan whose gate had since been
  // turned off (`**QA gate:** off` → mode `waived`) but which still carried a
  // stale `fail` row would spawn a real, billable session loop for a phase the
  // engine is holding nothing behind. The refusal must stand BEFORE the spawn.
  const r = repo('fail', 'waived (plan directive: QA gate: off)');
  try {
    const svc = service(r);
    seedRun(r);
    await assert.rejects(
      () => svc.qaRecover('demo', 1, { verb: 'qa-recover' } as never),
      /gate is not holding/,
    );
    // …and the same door with the gate ON does not refuse for this reason.
    const live = repo('fail');
    try {
      const svc2 = service(live);
      seedRun(live);
      await assert.doesNotReject(async () => {
        try { await svc2.qaRecover('demo', 1, { verb: 'qa-recover' } as never); }
        catch (error) {
          if (/gate is not holding/.test((error as Error).message)) throw error;
          // Anything else (no scheduler, no real claude) is this harness, not
          // the guard under test.
        }
      });
    } finally { closeConsoles(); live.cleanup(); }
  } finally { closeConsoles(); r.cleanup(); }
});

test('QA round 1 (M1/M2): both verbs refuse a phase with no verdict, and one that already passed', async () => {
  const none = repo('none');
  try {
    const svc = service(none);
    seedRun(none);
    await assert.rejects(() => svc.qaRecover('demo', 1, {} as never), /no recorded QA verdict/);
    const waive = await svc.qaWaive('demo', 1, { reason: 'why' });
    assert.equal(waive.ok, false);
    assert.match(waive.detail, /nothing to waive/);
  } finally { none.cleanup(); }

  // The refusal `qaRecover` had and `qaWaive` did not (QA round 1, M2). A
  // waiver over a `pass` is a DOWNGRADE — it replaces a review that happened
  // with a decision that no review is needed — and a stale browser tab or a
  // repeated POST was enough to do it silently.
  for (const already of ['pass', 'waived']) {
    const r = repo(already);
    try {
      const svc = service(r);
      seedRun(r);
      await assert.rejects(() => svc.qaRecover('demo', 1, {} as never), /already reads/);
      const waive = await svc.qaWaive('demo', 1, { reason: 'why' });
      assert.equal(waive.ok, false, already);
      assert.match(waive.detail, /already reads/);
      assert.match(waive.detail, /replace a recorded review/);
    } finally { r.cleanup(); }
  }
});

test('QA round 1 (M2): a waiver with no reason is refused before anything is written', async () => {
  // The script accepts a waiver without one — it serves the hand-driven path
  // where the operator is the one typing. A console button that writes an
  // unexplained waiver into a versioned file is how a plan forgets what it
  // decided not to fix.
  const r = repo('fail');
  try {
    const svc = service(r);
    seedRun(r);
    const waive = await svc.qaWaive('demo', 1, { reason: '   ' });
    assert.equal(waive.ok, false);
    assert.match(waive.detail, /needs a reason/);
  } finally { r.cleanup(); }
});

test('QA round 2 (M1): an UNREADABLE QA mode does not become a refusal', async () => {
  // `readQaMode` never throws: it RESOLVES `{mode:'unknown'}` when the engine
  // could not be run or its answer could not be parsed. The first shipping of
  // the gate guard used the display predicate, under which `unknown` reads
  // exactly like `off` — so a plan whose mode simply could not be determined
  // got a hard refusal carrying a confidently false sentence, and
  // `Service.qaMode`'s revision-keyed cache (no TTL) made it stick.
  //
  // "I could not check" and "there is no gate" are different facts — the same
  // rule this codebase states for the MCP preflight.
  const r = repo('fail', 'something the parser has never seen');
  try {
    const svc = service(r);
    seedRun(r);
    await assert.doesNotReject(async () => {
      try { await svc.qaRecover('demo', 1, {} as never); }
      catch (error) {
        if (/gate is not holding/.test((error as Error).message)) throw error;
        // Anything else is this harness (no real claude), not the guard.
      }
    }, 'an unreadable mode must not refuse the operator’s explicit press');
    const waive = await svc.qaWaive('demo', 1, { reason: 'why' });
    assert.doesNotMatch(waive.detail, /gate is not holding/);
  } finally { r.cleanup(); }
});

test('QA round 2 (M2): qaWaive asks the gate too — the site round 1’s fix did not reach', async () => {
  // Round 1 prescribed the check for BOTH verbs; round 1's fix reached one,
  // inside a commit whose message claimed "both now ask". The "listed five
  // sites, changed four" shape, recurring one level in. Both now go through
  // ONE assertion, which is the only shape in which "both" is checkable.
  const r = repo('fail', 'waived (plan directive: QA gate: off)');
  try {
    const svc = service(r);
    seedRun(r);
    const waive = await svc.qaWaive('demo', 1, { reason: 'why' });
    assert.equal(waive.ok, false);
    assert.match(waive.detail, /gate is not holding/);
    await assert.rejects(() => svc.qaRecover('demo', 1, {} as never), /gate is not holding/);
  } finally { r.cleanup(); }
});

test('QA round 2 (L5): a re-review’s brief does not claim the verdict does not exist', async () => {
  // `qa-rerun`'s whole premise is that a verdict EXISTS and is being reviewed
  // again; the brief opened "your phase has NO recorded verdict". A zero-context
  // fresh reviewer takes an opening sentence as fact, so it must be one.
  const r = repo('fail');
  try {
    const { prompts } = await drive(r, { verb: 'qa-rerun', maxRounds: 1 }, () => 'pass');
    assert.match(prompts[0]!.prompt, /recorded verdict is `fail`/);
    assert.match(prompts[0]!.prompt, /review it AGAIN/);
    assert.doesNotMatch(prompts[0]!.prompt, /has NO recorded verdict/);
  } finally { r.cleanup(); }

  // …and the `qa-pending` chase this brief was written for still says exactly
  // what it always said: there, no verdict is the truth.
  const pending = repo('pending');
  try {
    const { prompts } = await drive(pending, { verb: 'qa-rerun', maxRounds: 1 }, () => 'pass');
    assert.match(prompts[0]!.prompt, /has NO recorded verdict/);
  } finally { pending.cleanup(); }
});

test('the fix instruction says the dispatched reviewer is work inside THIS turn', () => {
  // Same lesson as the verdict brief (P8): a fix session that dispatches the
  // reviewer and ends its turn has recorded nothing, however good the fix.
  const text = qaFixInstruction({
    slug: 'alpha', phase: 7, round: 2, report: 'reports/phase-07-qa-round2.md',
    priorReport: 'reports/phase-07-qa.md', findings: 'H1: it is broken',
  });
  assert.match(text, /inside (your|this) turn/i);
  assert.match(text, /wait for it/i);
});
