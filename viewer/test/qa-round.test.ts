/**
 * ONE chooser for "which QA round is next, and which report does it write?"
 *
 * This file exists because that question was answered in six places and QA
 * failed Phase 4 of `phase-console-commerce` FOUR TIMES on it — each round
 * finding the sites the previous round had named corrected, and one more still
 * saying `round 1`. The cost is not cosmetic: a reviewer handed a filename that
 * already exists overwrites a committed report and can flip a recorded `fail`
 * to `pass`, releasing every dependent phase.
 *
 * So there are exactly two implementations — `server/qa-round.ts` and
 * `qa_next_round()` in `scripts/phase-graph.sh` — and this file holds both
 * halves of that:
 *
 *   1. **Nobody else builds a report path.** A source scan, in the shape
 *      `docs-parity.test.ts` uses: any file under `server/` that spells a
 *      `reports/phase-NN-qa…` literal is a seventh chooser waiting to drift.
 *   2. **The two halves agree**, over a corpus of every table shape that exists
 *      in the wild — legacy three-column, a ledger, `pending`, a markdown link,
 *      the activation backfill's waiver, and a report on disk with no row.
 *
 * The corpus is the point. Every one of the four failed rounds was a shape the
 * tests did not carry: a green suite said nothing about the launcher because
 * the fixture had a ledger and the live file did not.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { nextQaRound, qaReportPath, highestQaRound } = await import('../server/qa-round.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SERVER = join(SKILL_DIR, 'viewer', 'server');

const TRASH: string[] = [];
process.on('exit', () => { for (const d of TRASH) rmSync(d, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ *
 * 1. Nobody else builds a report path
 * ------------------------------------------------------------------ */

const SHARED = join(SKILL_DIR, 'viewer', 'shared');

/** Every `.ts`/`.js` under a directory, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('only qa-round.ts builds a QA report path', () => {
  // The literal any drifting copy would have to spell. Matched loosely on
  // purpose: `phase-${pad}-qa.md`, `phase-04-qa-round2.md`, and — since QA
  // round 5 measured the narrower class stopping at a quote — an interpolation
  // with quotes and spaces inside it, `phase-${String(n).padStart(2, '0')}-qa`.
  // `server/` and `shared/` are scanned; the client only renders paths the API
  // hands it. This is a guard against a LITERAL: a caller that hard-codes a
  // round while dutifully calling `qaReportPath` is what §3 below catches.
  const LITERAL = /reports\/phase-[^\n]{0,120}?qa/;
  const offenders: string[] = [];
  for (const file of [...sourceFiles(SERVER), ...sourceFiles(SHARED)]) {
    if (file.endsWith(join('server', 'qa-round.ts'))) continue;
    const src = readFileSync(file, 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      // A path inside a COMMENT is prose, not a chooser.
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      if (LITERAL.test(line)) offenders.push(`${file.slice(SKILL_DIR.length + 1)}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], 'these build a report path themselves — call qaReportPath/nextQaRound '
    + `instead, or the seventh copy drifts like the first six did:\n  ${offenders.join('\n  ')}`);
});

test('the instruction builder cannot be called without a round', () => {
  // `qaVerdictInstruction(slug, phase)` used to default the round to 1, and
  // that default is precisely how the ladder's only qa-pending rung went on
  // briefing round 1 after three QA rounds had fixed every other caller. A
  // required parameter makes the typechecker the reviewer.
  const src = readFileSync(join(SERVER, 'qa-session.ts'), 'utf8');
  // The assertion is about `round` and `report` being REQUIRED — not about the
  // parameter list ending there. It used to demand the closing paren
  // immediately after `report`, which forbade any later parameter whatever its
  // shape; P9 added a genuinely optional fifth (the recorded verdict, so a
  // re-review's brief opens with a true sentence) and this went red for a
  // reason that has nothing to do with the defect it guards.
  //
  // Widened to exactly the original property, and no further: `round: number`
  // and `report: string` in that order, neither carrying a `?` and neither
  // carrying a default. `round?: number` and `round: number = 1` — the QA-round-4
  // Critical's two shapes — both still fail it.
  assert.match(
    src,
    /export function qaVerdictInstruction\(\s*slug: string,\s*phase: number,\s*round: number,\s*report: string\s*[,)]/,
    'qaVerdictInstruction must take round AND report, neither optional',
  );
  // …said the other way round, so a future edit cannot satisfy the shape above
  // while making either one optional somewhere else in the signature.
  assert.doesNotMatch(src, /qaVerdictInstruction\([^)]*\bround\?/s, 'round must never be optional');
  assert.doesNotMatch(src, /qaVerdictInstruction\([^)]*\bround: number\s*=/s, 'round must never be defaulted');
  assert.doesNotMatch(src, /qaVerdictInstruction\([^)]*\breport\?/s, 'report must never be optional');
});

/* ------------------------------------------------------------------ *
 * 2. The two halves agree
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
status: active
---

# alpha

## Session budget

> **Target model:** \`claude-opus-5\` · **QA gate:** on

## Phase graph

| Phase | Title | Depends on | Repos |
|------:|-------|------------|-------|
| 1 | one | — | app |
| 2 | two | 1 | app |

### Phase 1 — one
- **Verification:** \`true\`
`;

/** Every table shape that exists in the wild, and what the round should be. */
const CORPUS: { name: string; rows: string[]; ledger?: string[]; onDisk?: string[]; want: number }[] = [
  { name: 'no test-status at all', rows: [], want: 1 },
  { name: 'a legacy plain-named row', rows: ['| 1 | fail | reports/phase-01-qa.md |'], want: 2 },
  {
    name: 'a legacy row whose FILENAME carries the round',
    rows: ['| 1 | pass | reports/phase-01-qa-round3.md |'],
    want: 4,
  },
  {
    name: 'a legacy row behind a markdown link',
    rows: ['| 1 | fail | [round 2](reports/phase-01-qa-round2.md) |'],
    want: 3,
  },
  { name: 'a pending row is not a round', rows: ['| 1 | pending | - |'], want: 1 },
  {
    name: 'the activation backfill\'s waiver is not a round',
    rows: ['| 1 | waived | - |'],
    want: 1,
  },
  { name: 'a waiver that DID write a report is a round', rows: ['| 1 | waived | reports/phase-01-qa.md |'], want: 2 },
  {
    // QA round 4, F3's second shape: the bash readers used to discard this row
    // whole (round 1) while the JS parser read its cell (round 4). `ledger: []`
    // is how the fixture asks for the four-column header with no ledger table.
    name: 'an explicitly numbered waiver with no report is the round its cell says',
    rows: ['| 1 | waived | - | 3 |'],
    ledger: [],
    want: 4,
  },
  {
    name: 'a numbered verdict with no report is the round its cell says',
    rows: ['| 1 | pass | - | 2 |'],
    ledger: [],
    want: 3,
  },
  {
    // `qa-record.sh` refuses `--round` with `pending`, so this cell is a hand
    // edit; the JS parser used to honour it and the engine never did.
    name: 'a pending row with a stray round cell is still no round',
    rows: ['| 1 | pending | - | 3 |'],
    ledger: [],
    want: 1,
  },
  {
    name: 'a zero in the round cell is no round, and the verdict still counts',
    rows: ['| 1 | pass | - | 0 |'],
    ledger: [],
    want: 2,
  },
  {
    name: 'the activation backfill under a four-column header is still no round',
    rows: ['| 1 | waived | - | - |'],
    ledger: [],
    want: 1,
  },
  {
    name: 'a ledger outranks the status row, even a pending one',
    rows: ['| 1 | pending | - | - |'],
    ledger: [
      '| 1 | 1 | fail | reports/phase-01-qa.md | 2026-09-01 |',
      '| 1 | 2 | fail | reports/phase-01-qa-round2.md | 2026-09-02 |',
    ],
    want: 3,
  },
  {
    name: 'a report on disk that no row mentions is stepped over',
    rows: [],
    onDisk: ['reports/phase-01-qa.md', 'reports/phase-01-qa-round2.md'],
    want: 3,
  },
  {
    name: 'the ledger and the disk together',
    rows: ['| 1 | fail | reports/phase-01-qa.md | 1 |'],
    ledger: ['| 1 | 1 | fail | reports/phase-01-qa.md | 2026-09-01 |'],
    onDisk: ['reports/phase-01-qa.md', 'reports/phase-01-qa-round2.md', 'reports/phase-01-qa-round3.md'],
    want: 4,
  },
];

function corpusRoot(entry: (typeof CORPUS)[number]): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-qaround-'));
  TRASH.push(root);
  const dir = join(root, 'docs', 'handoffs', 'alpha');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
  if (entry.rows.length || entry.ledger?.length) {
    const lines = ['# QA / test status — alpha', '', '## QA status', ''];
    lines.push(entry.ledger ? '| Phase | Result | Report | Round |' : '| Phase | Result | Report |');
    lines.push(entry.ledger ? '|------:|--------|--------|------:|' : '|------:|--------|--------|');
    lines.push(...entry.rows, '');
    if (entry.ledger?.length) {
      lines.push('## QA rounds', '', '| Phase | Round | Result | Report | Recorded |',
        '|------:|------:|--------|--------|----------|', ...entry.ledger, '');
    }
    writeFileSync(join(dir, 'test-status.md'), lines.join('\n'));
  }
  for (const rel of entry.onDisk ?? []) writeFileSync(join(dir, rel), '# a report nobody recorded');
  return root;
}

/**
 * `qa_next_round` through the engine, as `{round, report}`.
 *
 * Read out of `--qa-prompt`, which is the flag that prints it — the function is
 * internal to the script and the record line it composes is the contract a
 * reviewer actually receives, so asserting on THAT is asserting on the thing
 * that can hurt somebody.
 */
function engineRound(root: string, phase: number): { round: number; report: string } {
  const brief = String(execFileSync('/bin/bash', [join(SCRIPTS, 'phase-graph.sh'), 'alpha', '--qa-prompt', String(phase)], {
    encoding: 'utf8', env: { ...process.env, DOCS_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const m = /--report (\S+) --round (\d+)/.exec(brief);
  assert.ok(m, `the brief named no report/round:\n${brief}`);
  return { round: Number(m[2]), report: m[1] };
}

test('the bash and TypeScript choosers agree on every table shape in the wild', () => {
  const problems: string[] = [];
  for (const entry of CORPUS) {
    const root = corpusRoot(entry);
    const dir = join(root, 'docs', 'handoffs', 'alpha');
    const js = nextQaRound(dir, 1);
    const sh = engineRound(root, 1);
    if (js.round !== entry.want) problems.push(`${entry.name}: JS said round ${js.round}, expected ${entry.want}`);
    if (sh.round !== entry.want) problems.push(`${entry.name}: engine said round ${sh.round}, expected ${entry.want}`);
    if (js.report !== sh.report) problems.push(`${entry.name}: JS "${js.report}" vs engine "${sh.report}"`);
  }
  assert.deepEqual(problems, [], `the two halves disagree:\n  ${problems.join('\n  ')}`);
});

test('a chosen report never already exists', () => {
  // The property the whole feature is for, asserted directly rather than
  // inferred from a round number.
  for (const entry of CORPUS) {
    const root = corpusRoot(entry);
    const dir = join(root, 'docs', 'handoffs', 'alpha');
    const { report } = nextQaRound(dir, 1);
    assert.ok(!(entry.onDisk ?? []).includes(report), `${entry.name}: chose an occupied file (${report})`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. The CALLERS ask it — enumerated, not inferred from a source scan
 * ------------------------------------------------------------------ */

/**
 * A plan whose phase 1 is finished, with a ledger of rounds 1–2 under a
 * `pending` status row and both reports on disk. The canonical shape: every
 * surface must answer ROUND 3, and none may name a file that already exists.
 */
function settledRoot(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-qacallers-'));
  TRASH.push(root);
  const dir = join(root, 'docs', 'handoffs', 'alpha');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
  writeFileSync(join(dir, 'phase-01-one.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: one\nstatus: complete\n---\n# done\n');
  writeFileSync(join(dir, 'test-status.md'), [
    '# QA / test status — alpha', '', '## QA status', '',
    '| Phase | Result | Report | Round |', '|------:|--------|--------|------:|',
    '| 1 | pending | - | - |', '',
    '## QA rounds', '', '| Phase | Round | Result | Report | Recorded |',
    '|------:|------:|--------|--------|----------|',
    '| 1 | 1 | fail | reports/phase-01-qa.md | 2026-09-01 |',
    '| 1 | 2 | fail | reports/phase-01-qa-round2.md | 2026-09-02 |', '',
  ].join('\n'));
  writeFileSync(join(dir, 'reports', 'phase-01-qa.md'), '# round 1');
  writeFileSync(join(dir, 'reports', 'phase-01-qa-round2.md'), '# round 2');
  return { root, dir };
}

test('every surface that hands out a report name asks the chooser', async () => {
  // The source scan above says "nobody spells a literal". That is NOT the same
  // claim as "every caller asks", and the difference is what QA round 4's
  // Critical was: `service-runs.ts` called `qaVerdictInstruction` with no round
  // at all — no literal anywhere — and the autopilot's only `qa-pending` rung
  // briefed ROUND 1 forever, overwriting a committed report and flipping the
  // gate open. A caller can still bypass the chooser and hard-code `1` while
  // dutifully calling `qaReportPath`, which is invisible to a source scan. So
  // the surfaces are enumerated here and asked, over the shape that hurts.
  const { root, dir } = settledRoot();
  const named: Record<string, { report: string; round: number }> = {};

  const engine = (flag: string) => String(execFileSync('/bin/bash',
    [join(SCRIPTS, 'phase-graph.sh'), 'alpha', flag, '1'],
    { encoding: 'utf8', env: { ...process.env, DOCS_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] }));
  const read = (where: string, text: string) => {
    const m = /--report (\S+) --round (\d+)/.exec(text);
    assert.ok(m, `${where} named no report/round:\n${text.slice(0, 1_200)}`);
    named[where] = { report: m[1], round: Number(m[2]) };
  };

  read('--qa-prompt', engine('--qa-prompt'));
  read('--boot-prompt', engine('--boot-prompt'));

  const { Service } = await import('../server/service.ts');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  try {
    assert.equal(svc.open(root).ok, true);

    // The interactive launcher.
    const facts = ((await (svc as unknown as { resolveQa: (r: unknown) => Promise<{ facts?: Record<string, unknown> }> })
      .resolveQa({ slug: 'alpha', phase: 1 })).facts ?? {}) as Record<string, unknown>;
    named['the QA launcher'] = { report: String(facts.reportArg), round: Number(facts.round) };

    // Both QA rungs of the ladder — the surface round 4's Critical lived on.
    const build = (svc as unknown as {
      vehicleForRung: (rung: unknown, situation: unknown, record: unknown, evidence: unknown, slug: string)
        => { instruction?: string } | null;
    }).vehicleForRung.bind(svc);
    const record = { phase: 1, status: 'done', sessionId: 'sess-p1' };
    const evidence = { phase: 1, handoff: { exists: true }, qa: { mode: 'on', result: 'pending' } };
    for (const [mode, situation] of [['qa-verdict', 'qa-pending'], ['qa-fix', 'qa-failed']] as const) {
      const vehicle = build(
        { vehicle: 'resume-own-session', params: { mode } }, { key: situation }, record, evidence, 'alpha',
      );
      const instruction = vehicle?.instruction ?? '';
      read(`the ${mode} rung`, instruction);
      if (mode !== 'qa-fix') continue;
      // …and the report it tells the session to READ is the NEWEST on file,
      // never round 1's. QA round 4's F4: after round 2 failed, the fix session
      // was handed a report describing code two commits old.
      // The brief now comes from the ONE builder (`qaRungInstruction` →
      // `qaFixInstruction`), which quotes the path in backticks rather than
      // parentheses; the claim under test is the PATH, not the punctuation.
      const reads = /docs\/handoffs\/alpha\/(reports\/\S+?\.md)[)`]/.exec(instruction);
      assert.ok(reads, `the qa-fix rung named no report to read:\n${instruction}`);
      assert.equal(reads[1], 'reports/phase-01-qa-round2.md', 'the newest verdict on file');
      assert.ok(existsSync(join(dir, reads[1])), 'and it is a report that exists');
    }

    // The Stop hook — the sixth surface asked here: it names a filename to a LIVE session
    // that is about to end with its verdict still owed. Driven the way
    // `hook-decisions.test.ts` drives it, over the REAL store this service opened,
    // so `handoffDir` is the settled directory above.
    const state = {
      id: 'r1', slug: 'alpha', root, activePhase: 1,
      phases: { 1: { phase: 1, sessionId: 'sess-p1', startedAt: '2026-01-01T00:00:00Z' } },
    };
    (svc as unknown as { runners: Map<string, unknown> }).runners
      .set('alpha', { busy: () => true, current: () => state, note: () => {} });
    (svc as unknown as { board: (slug: string) => Promise<unknown> }).board = async () => ({
      phased: true, states: { 1: 'done' }, done: [1], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {},
    });
    (svc as unknown as { qaMode: (slug: string, phase?: number) => Promise<{ mode: string }> }).qaMode
      = async () => ({ mode: 'on' });
    (svc as unknown as { qaVerdict: (slug: string, phase: number) => Promise<string> }).qaVerdict
      = async () => 'pending';
    const stop = await svc.decideStop({ session_id: 'sess-p1' }, 'r1') as {
      hookSpecificOutput?: { decision: string; reason: string };
    };
    assert.equal(stop.hookSpecificOutput?.decision, 'block', 'the Stop hook holds a session whose verdict is owed');
    read('the Stop hook', stop.hookSpecificOutput?.reason ?? '');
  } finally { svc.close(); }

  // The warm at-finish chase is the seventh, and `verify-signoff.test.ts` holds it
  // on a real `Runner`; it reads the same module these do.
  const problems: string[] = [];
  for (const [where, got] of Object.entries(named)) {
    if (got.round !== 3) problems.push(`${where}: round ${got.round}, expected 3`);
    if (got.report !== 'reports/phase-01-qa-round3.md') problems.push(`${where}: named "${got.report}"`);
    if (existsSync(join(dir, got.report))) problems.push(`${where}: named a file that EXISTS (${got.report})`);
  }
  assert.deepEqual(problems, [], `a surface stopped asking the chooser:\n  ${problems.join('\n  ')}`);
});

test('the pieces answer sanely on their own', () => {
  assert.equal(qaReportPath(4), 'reports/phase-04-qa.md');
  assert.equal(qaReportPath(4, 1), 'reports/phase-04-qa.md');
  assert.equal(qaReportPath(4, 3), 'reports/phase-04-qa-round3.md');
  assert.equal(highestQaRound('', 1), 0, 'an empty file has had no rounds');
  assert.equal(highestQaRound('# not a table at all', 1), 0);
  // No handoff directory at all — the console asking about a plan it cannot see.
  assert.deepEqual(nextQaRound(undefined, 7), { round: 1, report: 'reports/phase-07-qa.md' });
  assert.deepEqual(nextQaRound('/nonexistent/nowhere', 7), { round: 1, report: 'reports/phase-07-qa.md' });
});
