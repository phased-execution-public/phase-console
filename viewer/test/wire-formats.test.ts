/**
 * The bash↔TS wire formats, as a CONFORMANCE suite (xcut-9).
 *
 * Six of this system's seams are a shell script that writes bytes and a
 * TypeScript module that reads them. Nothing types them, nothing shares a
 * schema, and the two halves live in different languages in different
 * directories — the contract is entirely convention. Each seam already has a
 * test somewhere, written from the reader's side with a hand-authored fixture,
 * and that is exactly the shape that cannot catch the failure that matters: a
 * fixture is a HAND COPY of the format, so when the writer changes, the fixture
 * does not, and the test goes on passing against bytes nothing produces any
 * more. (P21 found one that had been drifting for months.)
 *
 * So this file never writes a fixture. Every case RUNS THE REAL SCRIPT, takes
 * the bytes it actually produced, and feeds them to the real reader.
 *
 * ## The sensitivity proof
 *
 * A conformance suite that only asserts "the reader understood the writer" can
 * pass while asserting almost nothing — if the reader is lenient enough,
 * anything parses. So every seam here also proves it can FAIL: `mutate()`
 * changes exactly ONE BYTE of the bytes the script produced (it asserts the
 * one-byte property itself, so the proof cannot rot into a rewrite) and the
 * case asserts the reader's answer changes. A seam that survives a one-byte
 * corruption is not being checked by its reader.
 *
 * ## The maintenance contract
 *
 * **A phase that adds a bash↔TS seam adds a case here.** The list of writers
 * this file covers is the list in plan §Phase 12, and it is the inventory the
 * handoff records:
 *
 *   scripts/phase-outcome.sh          → server/runner/outcome.ts   readOutcome
 *   scripts/phase-outcome.sh ruling   → server/runner/rulings.ts   readRulings
 *   scripts/phase-lock.sh             → server/parse/folder.ts     parseLock
 *   scripts/qa-record.sh              → server/parse/folder.ts     parseTestStatus
 *   scripts/qa-record.sh (## QA rounds) → server/parse/folder.ts   parseQaRounds
 *   scripts/gate-approve.sh           → server/engine.ts           readGateStatus
 *   scripts/phase-tasks.sh            → server/runner/tasks.ts     readTaskEvents
 *   scripts/phase-graph.sh            → server/engine.ts           readMemoryBlock
 *   scripts/phase-graph.sh --decisions → server/engine.ts          readDecisions
 *   PE_MCP_SERVERS (env, both ways)   → server/engine.ts           scriptEnv
 *
 * Needs bash, a writable tmpdir and no client build.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { readOutcome } = await import('../server/runner/outcome.ts');
const { readRulings } = await import('../server/runner/rulings.ts');
const { parseLock, parseQaRounds, parseTestStatus } = await import('../server/parse/folder.ts');
const { readTaskEvents, foldTasks } = await import('../server/runner/tasks.ts');
const { readMemoryBlock, readGateStatus, scriptEnv } = await import('../server/engine.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SLUG = 'wirefmt';

const TRASH: string[] = [];
process.on('exit', () => { for (const d of TRASH) rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** Run one of the real scripts under `/bin/bash` — the runtime they ship for. */
function sh(script: string, args: string[], env: Record<string, string> = {}): string {
  return String(execFileSync('/bin/bash', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The suite must not pick up the ambient supervised session's PE_* —
      // a lock claimed here would otherwise inherit its scope and owner.
      //
      // `PE_WORKTREE` and `PE_BRANCH` joined the list on 2026-08-30: they were
      // added to `phase-lock.sh` after this guard was written, and the D11
      // refresh below states no `--worktree` ON PURPOSE — so under a session
      // Phase Console spawned (which exports `PE_WORKTREE=<run root>`) the
      // refresh wrote the CONSOLE's tree over the fixture's, and the test failed
      // for the one reason it is not about. A wire test must read what the
      // script writes for ITS arguments, not for the environment it happens to
      // run in.
      PE_SCOPE: '', PE_OWNER: '', PE_SESSION_ID: '', PE_WORKTREE: '', PE_BRANCH: '',
      NO_COLOR: '1', TERM: 'dumb',
      ...env,
    },
  }));
}

const PLAN = `---
slug: ${SLUG}
created: 2026-08-01
status: active
phases: 3
handoffs: docs/handoffs/${SLUG}/
memory: project_${SLUG}
---

# ${SLUG}

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | gated | — | — | app | it works |
| 2 | open | 1 | — | app | it works |
| 3 | later | 2 | — | app | it works |

## Phases

### Phase 1 — gated *(GATED)*
- **Gates (must clear first):** the operator exports the fixture keys
- **Gate-check:** manual operator keys exported
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — open
- **Size:** S
- **Verification:** \`true\`

### Phase 3 — later
- **Size:** S
- **Verification:** \`true\`
`;

/** A docs library the engine scripts can actually read. */
function library(): string {
  const root = scratch('pc-wire-');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', SLUG), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${SLUG}.md`), PLAN);
  return root;
}

/**
 * Change EXACTLY ONE BYTE of `text`, replacing `find` with `replacement`.
 *
 * The one-byte property is asserted rather than assumed: this is the whole
 * sensitivity proof, and a "mutation" that quietly became a rewrite would make
 * every case below weaker without failing.
 */
function mutate(text: string, find: string, replacement: string): string {
  const a = Buffer.from(find);
  const b = Buffer.from(replacement);
  assert.equal(a.length, b.length, `mutation must not change length: "${find}" → "${replacement}"`);
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differing += 1;
  assert.equal(differing, 1, `mutation must change exactly one byte: "${find}" → "${replacement}"`);

  const at = text.indexOf(find);
  assert.ok(at >= 0, `the bytes to mutate are not in what the script wrote: "${find}"`);
  assert.equal(text.indexOf(find, at + 1), -1, `"${find}" is ambiguous — it occurs more than once`);
  return text.slice(0, at) + replacement + text.slice(at + find.length);
}

/** An `EngineResult` around stdout a script really produced. */
function asResult(stdout: string, over: Record<string, unknown> = {}) {
  return { code: 0, stdout, stderr: '', ms: 1, timedOut: false, overflow: false, ...over } as never;
}

/* ------------------------------------------------------------------ *
 * 1. phase-outcome.sh → readOutcome
 * ------------------------------------------------------------------ */

test('phase-outcome.sh writes what readOutcome reads', () => {
  const dir = scratch('pc-wire-outcome-');
  const file = join(dir, 'outcome.json');

  sh('phase-outcome.sh', [SLUG, '2', 'waiting-external',
    '--wait-minutes', '30', '--reason', 'the image build is still running',
    '--watch', 'ci:build', '--watch', 'pr:41'], { PE_OUTCOME_FILE: file });

  const raw = readFileSync(file, 'utf8');
  const parsed = readOutcome(file, { slug: SLUG, phase: 2 });
  assert.ok(parsed, `readOutcome refused the bytes phase-outcome.sh wrote:\n${raw}`);
  assert.equal(parsed.status, 'waiting-external');
  assert.equal(parsed.reason, 'the image build is still running');
  assert.deepEqual(parsed.watch, ['ci:build', 'pr:41']);
  assert.ok(parsed.resume_after, '--wait-minutes must reach the reader as resume_after');
  // The staleness guard compares timestamps as DATES, not strings: bash writes
  // whole seconds and JavaScript writes milliseconds.
  assert.match(parsed.written_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // …and one byte is enough to break it.
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, mutate(raw, '"version": 1', '"version": 2'));
  assert.equal(readOutcome(broken, { slug: SLUG, phase: 2 }), null,
    'a version the reader does not speak must be refused, not half-read');

  const wrongSlug = join(dir, 'slug.json');
  writeFileSync(wrongSlug, mutate(raw, `"${SLUG}"`, `"${SLUG.replace('w', 'v')}"`));
  assert.equal(readOutcome(wrongSlug, { slug: SLUG, phase: 2 }), null,
    'an outcome belonging to another plan must never be adopted');
});

test('phase-outcome.sh ruling writes what readRulings reads', () => {
  const dir = scratch('pc-wire-ruling-');
  const file = join(dir, 'rulings.ndjson');

  sh('phase-outcome.sh', [SLUG, '2', 'ruling', '--kind', 'deviation',
    '--what', 'stopped although the guard said the tree was free',
    '--why', 'a foreign test run was in flight',
    '--cost-if-wrong', 'one wasted boarding'], { PE_RULINGS_FILE: file });

  const raw = readFileSync(file, 'utf8');
  const rulings = readRulings(file);
  assert.equal(rulings.length, 1, `readRulings found nothing in:\n${raw}`);
  assert.equal(rulings[0].kind, 'deviation');
  assert.equal(rulings[0].phase, 2);
  assert.equal(rulings[0].slug, SLUG);
  assert.equal(rulings[0].what, 'stopped although the guard said the tree was free');
  assert.equal(rulings[0].why, 'a foreign test run was in flight');
  assert.equal(rulings[0].costIfWrong, 'one wasted boarding');
  assert.ok(rulings[0].id, 'the content-derived id is the ack key — it must survive the round trip');

  // A ruling is NDJSON: one broken byte costs that line, and only that line.
  // `{` → `<` is a single byte and makes the line unparseable JSON.
  const broken = join(dir, 'broken.ndjson');
  writeFileSync(broken, `${mutate(raw.trimEnd(), '{"version"', '<"version"')}\n${raw}`);
  assert.equal(readRulings(broken).length, 1, 'the unparseable line is dropped, the good one survives');
});

/* ------------------------------------------------------------------ *
 * 2. phase-lock.sh → parseLock
 * ------------------------------------------------------------------ */

test('phase-lock.sh writes what parseLock reads', () => {
  const root = library();
  sh('phase-lock.sh', [SLUG, 'claim', '2', '--scope', 'app,docs',
    '--owner', 'tester@box', '--session', 'sess-abc123', '--lease', '900'],
  { DOCS_ROOT: root });

  const file = join(root, 'docs', 'handoffs', SLUG, '.locks', 'phase-02.lock');
  const raw = readFileSync(file, 'utf8');
  const lock = parseLock(raw, 'phase-02.lock');
  assert.ok(lock, `parseLock refused the bytes phase-lock.sh wrote:\n${raw}`);
  assert.equal(lock.phase, 2);
  assert.equal(lock.slug, SLUG);
  assert.equal(lock.owner, 'tester@box');
  assert.equal(lock.session, 'sess-abc123');
  assert.deepEqual(lock.scope, ['app', 'docs'], 'the scope csv is what decides concurrency');
  assert.equal(lock.expired, false);
  assert.ok(lock.leaseUntil && lock.leaseUntil > Date.now(), 'the lease is seconds in bash, ms in TS');

  // The key, not the value: `parseInt('1X')` is 1, so corrupting a digit would
  // be read as a DIFFERENT phase rather than as damage — the more dangerous
  // failure, and the reason the key is what this mutates.
  const noPhase = parseLock(mutate(raw, '\nphase=', '\nphasf='), 'phase-02.lock');
  assert.equal(noPhase, null, 'a lock whose phase cannot be read is no lock at all');

  // FIRST wins on a repeated key — bash reads it with `grep -m1`, and the two
  // halves must resolve one file identically.
  const doubled = parseLock(`${raw}\nowner=someone-else\n`, 'phase-02.lock');
  assert.equal(doubled?.owner, 'tester@box', 'a second owner= line must not rename the holder');
});

test('D11: phase-lock.sh --worktree round-trips through parseLock', () => {
  // `--worktree` is RECORDED and never acted on — two worktrees of one repo are
  // still one scope — so nothing in the console fails when it goes missing. That
  // is exactly why it needs a wire test: the value's only job is to be read back
  // and shown to a person looking at a busy repo with a clean `git status`, and
  // a field whose loss is silent is a field that rots.
  const root = library();
  const tree = '/home/someone/work/.pe-wt/lane-4';
  sh('phase-lock.sh', [SLUG, 'claim', '4', '--scope', 'app',
    '--owner', 'tester@box', '--session', 'sess-wt', '--worktree', tree],
  { DOCS_ROOT: root });

  const file = join(root, 'docs', 'handoffs', SLUG, '.locks', 'phase-04.lock');
  const raw = readFileSync(file, 'utf8');
  const lock = parseLock(raw, 'phase-04.lock');
  assert.ok(lock, `parseLock refused the bytes phase-lock.sh wrote:\n${raw}`);
  assert.equal(lock.worktree, tree, 'the path the session is actually working in');

  // The sensitivity proof this suite requires: one byte in the KEY and the
  // field is gone — which must not take the rest of the lock with it, because
  // an older phase-lock.sh writes no `worktree=` line at all and its locks stay
  // perfectly valid.
  const renamed = parseLock(mutate(raw, '\nworktree=', '\nworktref='), 'phase-04.lock');
  assert.ok(renamed, 'a lock with no worktree= line is still a lock');
  assert.equal(renamed.worktree, undefined, 'and the field is absent rather than wrong');
  assert.equal(renamed.owner, 'tester@box', 'nothing else moved');

  // A same-owner refresh that states no --worktree keeps the line the claim
  // wrote: the console's own Claim-lock action passes no --worktree at all, and
  // a refresh that dropped it would blank the one thing the field is for.
  sh('phase-lock.sh', [SLUG, 'claim', '4', '--owner', 'tester@box'], { DOCS_ROOT: root });
  const refreshed = parseLock(readFileSync(file, 'utf8'), 'phase-04.lock');
  assert.equal(refreshed?.worktree, tree, 'a refresh must not blank the worktree');
});

test('phase-lock.sh --branch round-trips through parseLock', () => {
  // Like `--worktree` next door, this field is ACTED ON: `conflicts` reads
  // the PAIR and lets two claims on one repository through only when both
  // name a branch AND a tree and both differ. So a byte that goes missing
  // here does not merely rot a display string — it silently re-qualifies a
  // lock as unqualified, which is the fail-safe direction, or worse, reads a
  // branch that is not there.
  const root = library();
  sh('phase-lock.sh', [SLUG, 'claim', '5', '--scope', 'app',
    '--owner', 'tester@box', '--session', 'sess-br', '--branch', 'pe/lane-5'],
  { DOCS_ROOT: root });

  const file = join(root, 'docs', 'handoffs', SLUG, '.locks', 'phase-05.lock');
  const raw = readFileSync(file, 'utf8');
  const lock = parseLock(raw, 'phase-05.lock');
  assert.ok(lock, `parseLock refused the bytes phase-lock.sh wrote:\n${raw}`);
  assert.equal(lock.branch, 'pe/lane-5', 'the branch this session’s work rides');
  assert.deepEqual(lock.scope, ['app'], 'and the scope is still the whole repository');

  // The sensitivity proof: one byte in the KEY and the field is gone — which
  // must leave the rest of the lock intact, because a lock written before this
  // field existed has no `branch=` line and stays perfectly valid (and, being
  // unqualified, goes on colliding with everything).
  const renamed = parseLock(mutate(raw, '\nbranch=', '\nbranck='), 'phase-05.lock');
  assert.ok(renamed, 'a lock with no branch= line is still a lock');
  assert.equal(renamed.branch, undefined, 'and the field is absent rather than wrong');
  assert.equal(renamed.owner, 'tester@box', 'nothing else moved');

  // The keepalive case, and the one that actually bites: the runner re-claims
  // under the same owner every third of a lease. A refresh that dropped
  // `branch=` would un-qualify a live lane's lock mid-run.
  sh('phase-lock.sh', [SLUG, 'claim', '5', '--owner', 'tester@box'], { DOCS_ROOT: root });
  const refreshed = parseLock(readFileSync(file, 'utf8'), 'phase-05.lock');
  assert.equal(refreshed?.branch, 'pe/lane-5', 'a refresh must not blank the branch');
  assert.deepEqual(refreshed?.scope, ['app'], 'nor the scope it rides beside');
});

/* ------------------------------------------------------------------ *
 * 3. qa-record.sh → parseTestStatus
 * ------------------------------------------------------------------ */

test('qa-record.sh writes what parseTestStatus reads', () => {
  const root = library();
  sh('qa-record.sh', [SLUG, '2', 'pass', '--report', `docs/handoffs/${SLUG}/reports/phase-02-qa.md`],
    { DOCS_ROOT: root });
  sh('qa-record.sh', [SLUG, '3', 'fail', '--report', `docs/handoffs/${SLUG}/reports/phase-03-qa.md`],
    { DOCS_ROOT: root });

  const file = join(root, 'docs', 'handoffs', SLUG, 'test-status.md');
  const raw = readFileSync(file, 'utf8');
  const rows = parseTestStatus(raw);
  const byPhase = new Map(rows.map((r) => [r.phase, r]));

  assert.equal(byPhase.get(2)?.result, 'pass', `parseTestStatus disagreed with qa-record.sh:\n${raw}`);
  assert.equal(byPhase.get(3)?.result, 'fail');
  assert.match(byPhase.get(2)?.report ?? '', /phase-02-qa\.md$/, 'the link target, not the link text');

  // The fourth column, which the writer added and this reader must not ignore.
  assert.equal(byPhase.get(2)?.round, 1, 'the Round cell reaches the parser');

  // `unknown` is a real fourth answer and it must not read as a verdict: a row
  // the reader cannot classify has to hold dependents, never release them.
  //
  // The phase number rides the needle now: since rounds landed, `| pass ` also
  // appears in the `## QA rounds` ledger, and corrupting an unspecified one of
  // the two would be testing whichever row `mutate` happened to find first.
  const corrupt = parseTestStatus(mutate(raw, '| 2 | pass ', '| 2 | pasp '));
  assert.equal(corrupt.find((r) => r.phase === 2)?.result, 'unknown',
    'a verdict one byte off is unknown — never silently `pass`');
});

test('a legacy three-column row carries its round in its FILENAME, in both readers', () => {
  // QA round 2, H1. `Service.resolveQa` numbers the interactive launcher's round
  // from `QaRow.round`, and `parseTestStatus` left that `undefined` on every
  // three-column row while the bash engine inferred it from the report path. So
  // the console's QA launcher answered round 2 where the engine answered round 4
  // — and briefed a reviewer to write over a report already on disk, which is
  // the one defect rounds exist to prevent.
  const root = library();
  const file = join(root, 'docs', 'handoffs', SLUG, 'test-status.md');
  writeFileSync(file, [
    '# QA / test status', '', '## QA status', '',
    '| Phase | Result | Report |', '|------:|--------|--------|',
    '| 1 | pass | reports/phase-01-qa-round3.md |',
    '| 2 | fail | reports/phase-02-qa.md |',
    '| 3 | pending | reports/phase-03-qa-round2.md |',
    '',
  ].join('\n'));

  const rows = parseTestStatus(readFileSync(file, 'utf8'));
  const by = new Map(rows.map((r) => [r.phase, r]));
  assert.equal(by.get(1)?.round, 3, 'the filename is the only record that row keeps');
  assert.equal(by.get(2)?.round, undefined, 'a plain name asserts nothing — the writer decides');
  // `pending` is the ABSENCE of a review, so it is roundless whatever its report
  // cell says. The bash side agrees.
  assert.equal(by.get(3)?.round, undefined);

  // …and the engine, on the same bytes, says the same thing.
  const history = sh('phase-graph.sh', [SLUG, '--qa-history', '1'], { DOCS_ROOT: root });
  assert.equal(history.split('\t')[0], '3', `engine disagreed:\n${history}`);
  assert.equal(sh('phase-graph.sh', [SLUG, '--qa-history', '3'], { DOCS_ROOT: root }).trim(), '');
});

test('qa-record.sh writes rounds that parseQaRounds reads, and they are not the gating table', () => {
  const root = library();
  const rec = (phase: string, verdict: string, report: string, round?: string) =>
    sh('qa-record.sh', [SLUG, phase, verdict, '--report', report, ...(round ? ['--round', round] : [])],
      { DOCS_ROOT: root });

  rec('2', 'fail', `reports/phase-02-qa.md`, '1');
  rec('2', 'pass', `reports/phase-02-qa-round2.md`, '2');

  const raw = readFileSync(join(root, 'docs', 'handoffs', SLUG, 'test-status.md'), 'utf8');

  // The gating table keeps ONE row per phase — the current verdict. That is the
  // whole reason rounds went into a second table: a second row here would have
  // made "the verdict" ambiguous in four readers at once.
  const gating = parseTestStatus(raw).filter((r) => r.phase === 2);
  assert.equal(gating.length, 1, `one gating row per phase:\n${raw}`);
  assert.equal(gating[0].result, 'pass');
  assert.equal(gating[0].round, 2, 'and it says which round produced it');

  // …while the ledger keeps every round, oldest first, each with its own report.
  const rounds = parseQaRounds(raw).filter((r) => r.phase === 2);
  assert.deepEqual(rounds.map((r) => [r.round, r.result]), [[1, 'fail'], [2, 'pass']]);
  assert.match(rounds[0].report ?? '', /phase-02-qa\.md$/);
  assert.match(rounds[1].report ?? '', /phase-02-qa-round2\.md$/);

  // A file with no ledger at all yields nothing rather than guessing — "no
  // rounds recorded" and "no QA ran" are the status table's question, not this
  // one's.
  assert.deepEqual(parseQaRounds('# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--|--|--|\n| 1 | pass | - |\n'), []);
});

/* ------------------------------------------------------------------ *
 * 4. gate-approve.sh → phase-graph.sh --gate-status → readGateStatus
 * ------------------------------------------------------------------ */

test('gate-approve.sh writes what --gate-status reads back through readGateStatus', () => {
  const root = library();

  // Before: phase 1 carries a `manual` gate and is not clear.
  let out = '';
  let code = 0;
  try {
    out = sh('phase-graph.sh', [SLUG, '--gate-status', '1'], { DOCS_ROOT: root });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1; out = String(e.stdout ?? '') || String(e.stderr ?? '');
  }
  const before = readGateStatus(asResult(out, { code }));
  assert.equal(before.clear, false, `expected a blocked gate, got: ${JSON.stringify(before)}`);
  assert.equal(before.kind, 'manual');

  sh('gate-approve.sh', [SLUG, '1', '--by', 'operator', '--note', 'keys minted'], { DOCS_ROOT: root });

  const file = join(root, 'docs', 'handoffs', SLUG, 'gate-status.md');
  const raw = readFileSync(file, 'utf8');
  const after = readGateStatus(asResult(sh('phase-graph.sh', [SLUG, '--gate-status', '1'], { DOCS_ROOT: root })));
  assert.equal(after.clear, true, `the approval did not reach the engine:\n${raw}`);
  assert.match(after.detail, /operator/, 'who approved it is part of the answer');

  // One byte — the phase the row is ABOUT — and phase 1 is gated again. This is
  // the seam where a silent misread would let a session past a human gate.
  writeFileSync(file, mutate(raw, '\n| 1 ', '\n| 3 '));
  let reOut = ''; let reCode = 0;
  try {
    reOut = sh('phase-graph.sh', [SLUG, '--gate-status', '1'], { DOCS_ROOT: root });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    reCode = e.status ?? 1; reOut = String(e.stdout ?? '') || String(e.stderr ?? '');
  }
  assert.equal(readGateStatus(asResult(reOut, { code: reCode })).clear, false,
    'an approval recorded against another phase must not clear this one');
});

/* ------------------------------------------------------------------ *
 * 5. phase-tasks.sh → readTaskEvents / foldTasks
 * ------------------------------------------------------------------ */

test('phase-tasks.sh writes what readTaskEvents reads, and folds to the panel', () => {
  const dir = scratch('pc-wire-tasks-');
  const file = join(dir, 'tasks.ndjson');
  const env = { PE_TASKS_FILE: file };

  sh('phase-tasks.sh', [SLUG, '2', 'reset'], env);
  sh('phase-tasks.sh', [SLUG, '2', 'create', '--subject', 'p2.task1 — wire the endpoint'], env);
  sh('phase-tasks.sh', [SLUG, '2', 'create', '--subject', 'p2.task2 — test it'], env);
  sh('phase-tasks.sh', [SLUG, '2', 'update', '--id', 'p2.task1', '--status', 'completed'], env);
  sh('phase-tasks.sh', [SLUG, '2', 'update', '--id', 'p2.task2', '--status', 'in_progress'], env);

  const raw = readFileSync(file, 'utf8');
  const { events } = readTaskEvents(file, { slug: SLUG, phase: 2 }, 0);
  assert.equal(events.length, 5, `readTaskEvents disagreed with phase-tasks.sh:\n${raw}`);

  const tasks = foldTasks(undefined, events);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, 'p2.task1', 'the script chooses the id, so no read-back is needed');
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[1].id, 'p2.task2');
  assert.equal(tasks[1].status, 'in_progress');
  assert.match(tasks[0].content, /wire the endpoint/);

  // Field order is fixed on purpose — `op` before any free text — so the script
  // can count its own creates with an anchored match no subject can forge.
  assert.match(raw.split('\n')[1] ?? '', /"op":"create"/);

  // The incremental reader must not adopt a partial trailing line: a writer
  // mid-append is the ordinary case, not corruption.
  const partial = join(dir, 'partial.ndjson');
  writeFileSync(partial, `${raw}{"version":1,"type":"task","slug":"${SLUG}","pha`);
  assert.equal(readTaskEvents(partial, { slug: SLUG, phase: 2 }, 0).events.length, 5,
    'a half-written line is left for the next read, never parsed as garbage');

  // One byte in ONE line's phase, and that line stops speaking for this phase.
  // The mutation is applied to the first line alone — `"phase":2` appears on
  // every line, and mutate() refuses an ambiguous anchor, which is the guard
  // working rather than an obstacle.
  const lines = raw.split('\n');
  const wrongPhase = join(dir, 'wrong.ndjson');
  writeFileSync(wrongPhase, [mutate(lines[0], '"phase":2', '"phase":3'), ...lines.slice(1)].join('\n'));
  assert.equal(readTaskEvents(wrongPhase, { slug: SLUG, phase: 2 }, 0).events.length, 4,
    'another phase\'s event must never speak for this one — and only that event is lost');
});

/* ------------------------------------------------------------------ *
 * 6. phase-graph.sh --memory-block → readMemoryBlock
 * ------------------------------------------------------------------ */

test('phase-graph.sh --memory-block writes what readMemoryBlock reads', () => {
  const root = library();
  const raw = sh('phase-graph.sh', [SLUG, '--memory-block'], { DOCS_ROOT: root });

  const board = readMemoryBlock(asResult(raw));
  assert.equal(board.error, undefined, `readMemoryBlock could not read:\n${raw}`);
  assert.deepEqual(board.done, [], 'nothing is done in a fresh library');
  assert.deepEqual(board.ready, [1], 'phase 1 is the only root');
  assert.deepEqual(board.waiting, [2, 3]);
  assert.equal(board.states[1], 'ready');
  assert.equal(board.states[3], 'waiting');

  // The `blocked:` line is the reason each waiting phase waits — the thing the
  // board renders as "needs: N".
  assert.deepEqual(board.blockedBy[2], [1]);
  assert.deepEqual(board.blockedBy[3], [2]);

  // One byte on the label and a whole bucket stops being read. `ready` silently
  // emptying is the failure that makes a plan look finished.
  const broken = readMemoryBlock(asResult(mutate(raw, '\nready:', '\nreads:')));
  assert.deepEqual(broken.ready, [], 'an unrecognised label contributes nothing rather than guessing');
  assert.equal(broken.states[1], undefined);

  // A non-zero exit is an ERROR board, never an empty one — "no phases are
  // ready" and "the engine could not answer" must not look alike.
  const failed = readMemoryBlock(asResult('', { code: 2, stderr: 'ERROR: no such plan' }));
  assert.equal(failed.error, 'no such plan');
});

/* ------------------------------------------------------------------ *
 * 6b. phase-graph.sh --decisions → readDecisions (zero-touch-console P3)
 * ------------------------------------------------------------------ */

test('phase-graph.sh --decisions writes what readDecisions reads — plan rows, and the twin over them', async () => {
  const { readDecisions } = await import('../server/engine.ts');
  const root = library();
  const planPath = join(root, 'docs', 'plans', `${SLUG}.md`);
  writeFileSync(planPath, readFileSync(planPath, 'utf8').replace('## Phase graph', [
    '## Decisions', '',
    '| key | value | owner | state | blocking | source | evidence |',
    '|---|---|---|---|---|---|---|',
    '| `credentials` | `gh` | operator | answered | yes | plan | E7 |',
    '| `waits` | | dev-lead | outstanding | yes | plan | |',
    '', '## Phase graph',
  ].join('\n')));

  const raw = sh('phase-graph.sh', [SLUG, '--decisions'], { DOCS_ROOT: root });
  const read = readDecisions(asResult(raw));
  assert.equal(read.error, undefined);
  assert.deepEqual(read.rows.map((r) => [r.key, r.state, r.owner, r.blocking, r.source, r.value]), [
    ['credentials', 'answered', 'operator', 'yes', 'plan', '`gh`'],
    ['waits', 'outstanding', 'dev-lead', 'yes', 'plan', ''],
  ]);

  // The twin, in the shape decisions.sh writes: its plan-wide row replaces the
  // plan's WHOLE row (source included), its phase row shows only for that phase.
  writeFileSync(join(root, 'docs', 'handoffs', SLUG, 'decisions.md'), [
    '## Decisions', '',
    '| key | value | owner | state | blocking | source | evidence | phase |',
    '|---|---|---|---|---|---|---|---|',
    '| `waits` | `gh:acme/x#run/1` · 45m | dev-lead | answered | yes | run | decisions.sh | — |',
    '| `waits` | no wait at all in phase 3 | dev-lead | waived | no | run | decisions.sh | 3 |',
    '',
  ].join('\n'));
  const merged = readDecisions(asResult(sh('phase-graph.sh', [SLUG, '--decisions'], { DOCS_ROOT: root })));
  assert.deepEqual(merged.rows.find((r) => r.key === 'waits'), {
    key: 'waits', state: 'answered', owner: 'dev-lead', blocking: 'yes', source: 'run',
    value: '`gh:acme/x#run/1` · 45m', evidence: '', phase: null,
  });
  const p3 = readDecisions(asResult(sh('phase-graph.sh', [SLUG, '--decisions', '3'], { DOCS_ROOT: root })), 3);
  assert.deepEqual([p3.rows.find((r) => r.key === 'waits')?.state, p3.rows.find((r) => r.key === 'waits')?.phase], ['waived', 3]);

  // One byte on a tab and the row shifts a column: `state` reads the owner.
  // The reader does not guess — the parity test is what keeps the columns in
  // the order both engines agree on; this proves the wire is positional.
  const shifted = readDecisions(asResult(mutate(raw, 'credentials\tanswered', 'credentials answered')));
  assert.notEqual(shifted.rows[0].state, 'answered');

  // A non-zero exit is an ERROR, never an empty manifest — "nothing
  // outstanding" and "the engine could not answer" must not look alike.
  const failed = readDecisions(asResult('', { code: 2, stderr: 'ERROR: no such plan' }));
  assert.equal(failed.error, 'no such plan');
  assert.deepEqual(failed.rows, []);
});

/* ------------------------------------------------------------------ *
 * 7. PE_MCP_SERVERS — encoded by the console, decoded by the engine
 * ------------------------------------------------------------------ */

test('PE_MCP_SERVERS round-trips from scriptEnv into phase-graph.sh', () => {
  const root = library();
  const opts = { root, scriptsDir: SCRIPTS } as never;

  // The encode side: a space-joined list, and absent-vs-empty is a real
  // distinction — empty means "this console has nothing registered", absent
  // means "this console said nothing at all" and turns the check off.
  assert.equal(scriptEnv({ ...(opts as object), mcpServers: ['context7', 'memory'] } as never).PE_MCP_SERVERS,
    'context7 memory');
  assert.equal(scriptEnv({ ...(opts as object), mcpServers: [] } as never).PE_MCP_SERVERS, '',
    'set-but-empty is an answer');
  assert.equal(scriptEnv(opts).PE_MCP_SERVERS, undefined, 'absent is a different answer');

  // The decode side: the engine has to accept exactly what the encoder emits.
  // Running the real script with the real encoded value is the only way to know
  // the two agree — a plan naming no servers lints clean either way, and must.
  const encoded = scriptEnv({ ...(opts as object), mcpServers: ['context7', 'memory'] } as never).PE_MCP_SERVERS;
  const withRegistry = sh('phase-graph.sh', [SLUG, '--memory-block'],
    { DOCS_ROOT: root, PE_MCP_SERVERS: String(encoded) });
  const without = sh('phase-graph.sh', [SLUG, '--memory-block'], { DOCS_ROOT: root });
  assert.equal(readMemoryBlock(asResult(withRegistry)).ready.join(','),
    readMemoryBlock(asResult(without)).ready.join(','),
    'a registry the plan does not ask for must not change the board');
});

/* ------------------------------------------------------------------ *
 * The suite's own guard
 * ------------------------------------------------------------------ */

test('mutate() refuses anything that is not a single-byte change', () => {
  // The sensitivity proof above is only worth what this is worth.
  assert.throws(() => mutate('abc', 'a', 'xy'), /must not change length/);
  assert.throws(() => mutate('abc', 'ab', 'xy'), /exactly one byte/);
  assert.throws(() => mutate('abc', 'zz', 'zy'), /not in what the script wrote/);
  assert.throws(() => mutate('abab', 'ab', 'ac'), /occurs more than once/);
  assert.equal(mutate('abc', 'b', 'z'), 'azc');
});
