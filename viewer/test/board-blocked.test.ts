/**
 * The `blocked:` line — why the board is empty.
 *
 * An empty `ready` set is four unrelated situations (the plan is finished; every
 * remaining phase is in flight; the plan is closed; nothing can ever move again)
 * collapsed into one silence, and `--memory-block` is the ONLY engine command the
 * runner reads. Without this line the runner could report "6 phases are waiting"
 * and nothing more — which is what a real run did while a recorded QA failure held
 * its whole plan for ever.
 */
// First, and before anything under `server/`: `config.ts` resolves STATE_DIR at
// module load, and it is reached transitively from most of that tree. Without
// this the suite reads the operator's real push subscriptions.
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMemoryBlock } from '../server/engine.ts';
import { blockedByView, qaHeldBy } from '../server/service-core.ts';

const ok = (stdout: string) => readMemoryBlock({ code: 0, stdout, stderr: '', ms: 1, timedOut: false });

test('a board with no blocked line parses as before', () => {
  const board = ok('done: 1\nready: 2, 3\nwaiting: 4\n');
  assert.deepEqual(board.ready, [2, 3]);
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
});

test('blocked names each waiting phase, its unmet deps, and why', () => {
  const board = ok([
    'done: 1, 3',
    'ready: ',
    'waiting: 2, 4',
    'blocked: 2<-1(qa:fail) 4<-2(not-done),3(qa:pending)',
  ].join('\n'));
  assert.deepEqual(board.blockedBy, { 2: [1], 4: [2, 3] });
  // Only the QA verdicts land in `qa` — "not-done" is a board word, not a verdict.
  assert.deepEqual(board.qa, { 1: 'fail', 3: 'pending' });
});

test('the QA map is keyed by the BLOCKING phase, not the blocked one', () => {
  const board = ok('done: 1\nready: \nwaiting: 2\nblocked: 2<-1(qa:fail)\n');
  assert.equal(board.qa[1], 'fail');
  assert.equal(board.qa[2], undefined);
});

test('a malformed blocked line degrades to empty, never throws', () => {
  const board = ok('done: 1\nready: \nwaiting: 2\nblocked: nonsense<-\n');
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
  assert.deepEqual(board.waiting, [2]); // the rest of the board still parses
});

test('an engine error still yields an empty, non-throwing board', () => {
  const board = readMemoryBlock({ code: 1, stdout: '', stderr: 'ERROR: no such plan', ms: 1, timedOut: false });
  assert.equal(board.phased, false);
  assert.deepEqual(board.blockedBy, {});
  assert.deepEqual(board.qa, {});
});

/* ------------------------------------------------------------------ *
 * PhaseView.blockedBy / qaHeld — the same line, projected per phase
 * ------------------------------------------------------------------ */

test('PhaseView.blockedBy is {phase, why}[] in the engine\'s own reason words', () => {
  const board = ok([
    'done: 1, 3',
    'ready: ',
    'waiting: 2, 4',
    'blocked: 2<-1(qa:fail) 4<-2(not-done),3(qa:pending)',
  ].join('\n'));
  assert.deepEqual(blockedByView(board, 4), [{ phase: 2, why: 'not-done' }, { phase: 3, why: 'qa:pending' }]);
  assert.deepEqual(blockedByView(board, 2), [{ phase: 1, why: 'qa:fail' }]);
  assert.deepEqual(blockedByView(board, 1), [], 'a phase nothing holds has an empty list, never undefined');
  // The HELD state is the other end of the same fact: which phases a verdict holds.
  assert.deepEqual(qaHeldBy(board), { 1: [2], 3: [4] });
});

test('detail() puts blockedBy and qaHeld on the phase view itself', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-blocked-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo.md'), [
      '---', 'slug: demo', 'created: 2026-09-21', 'status: active', 'phases: 3', '---', '', '# demo', '',
      '## Session budget', '', '> **QA gate:** on', '',
      '## Phase graph', '',
      '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
      '|------:|-------|-----------|--------------------|-------|---------------|',
      '| 1 | first | — | — | app | it works |',
      '| 2 | second | 1 | — | app | it still works |',
      '| 3 | third | 2 | — | app | it works again |', '',
      '## Phases', '',
      '### Phase 1 — first', '- **Size:** S', '- **Verification:** `true`', '',
      '### Phase 2 — second', '- **Size:** S', '- **Verification:** `true`', '',
      '### Phase 3 — third', '- **Size:** S', '- **Verification:** `true`', '',
    ].join('\n'), 'utf8');
    const env = { ...process.env, DOCS_ROOT: root };
    const script = (name: string, ...args: string[]) => execFileSync('bash', [join(SKILL_DIR, 'scripts', name), ...args], {
      cwd: root, env, stdio: 'pipe',
    });
    script('new-handoff.sh', 'demo', '1', 'first', 'complete');
    // Written, as a finishing session writes it: a `complete` scaffold whose
    // "What this phase did" is still the template reads in-progress (#46).
    const handoff = join(root, 'docs', 'handoffs', 'demo', 'phase-01-first.md');
    writeFileSync(handoff, readFileSync(handoff, 'utf8').replace('## What this phase did\n', '## What this phase did\nThe first phase shipped.\n'));
    script('qa-record.sh', 'demo', '1', 'fail', '--report', 'docs/handoffs/demo/reports/p1.md');
    const svc = new Service({ port: 0, host: '127.0.0.1', open: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null } as never);
    assert.equal(svc.open(root).ok, true);
    const detail = await svc.detail('demo') as unknown as {
      phases: { phase: number; blockedBy?: { phase: number; why: string }[]; qaHeld?: number[] }[];
    };
    const view = (n: number) => detail.phases.find((p) => p.phase === n)!;
    assert.deepEqual(view(2).blockedBy, [{ phase: 1, why: 'qa:fail' }]);
    assert.deepEqual(view(3).blockedBy, [{ phase: 2, why: 'not-done' }]);
    assert.deepEqual(view(1).blockedBy, []);
    assert.deepEqual(view(1).qaHeld, [2], 'phase 1\'s failed verdict holds phase 2');
    assert.equal(view(2).qaHeld, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
