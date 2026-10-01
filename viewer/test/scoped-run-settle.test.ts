/**
 * A scoped run is finished only when its scope is (control-tower phase 39,
 * #43) — criteria SR-1 … SR-6.
 *
 * The measured shape: run `74f06fcc` was scoped to phases 10 and 11. Phase 10
 * had declared a permission block and held an open errand; phase 11 had never
 * boarded. Both records read `pending`, the scoped finish asked only whether an
 * asked phase was `parked`, `gated` or `failed`, and the run said "those are
 * settled" twice — while the errand nobody had answered sat under it.
 *
 * Runner tests drive a real `Runner` over a stub repository; service tests
 * follow `scope-fence.test.ts` — a real `Service` over a real plan and the real
 * engine, with the healer's drives and the announcement door recorded.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const {
  journalFile, loadRun, newRun, phaseRecord, saveRun, scopeLeftOpen, scopeNotDoneSentence, retireSettledErrands,
  phaseSettledWell: settledWellFromState,
} = await import('../server/runner/state.ts');
const { PHASE_STATUSES, SETTLED_WELL, phaseSettledWell } = await import('../shared/run-lifecycle.js');
const { errandFor } = await import('../server/runner/ladder.ts');
const { declaredSubKind } = await import('../server/runner/situation.ts');
const { SITUATION_SUB_ACTOR, SUB_KINDS, actorFor, protectedPathOf } = await import('../shared/situation-model.js');
const { rungsFor } = await import('../shared/ladder-model.js');
const { decisionKeyOfSituation } = await import('../shared/policy-model.js');
const { NEED_CLASSES } = await import('../shared/decisions-model.js');
type RunState = import('../server/runner/state.ts').RunState;
type Errand = import('../server/runner/state.ts').Errand;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;

const SCRIPTS = join(SKILL_DIR, 'scripts');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// A wall the session declared. Its words are nothing the runner's own
// credential, limit or outage classifier (`runner/errors.ts`) knows.
const WALL = 'The CLI refused two rule edits in this unattended session; a person has to make them.';

function errand(phase: number, at: string, situation = 'blocked-declared:permission'): Errand {
  return {
    phase, situation, at, tried: [],
    need: 'The two rule edits the session named, made by a person.',
    how: 'Make them by hand, then Retry.',
  } as Errand;
}

type Line = { event: string; data: Record<string, unknown>; phase?: number };

function journalLines(root: string, slug: string, runId: string): Line[] {
  let text = '';
  try { text = readFileSync(journalFile(root, slug, runId), 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A stub repository whose board is whatever `setBoard` last wrote. */
function stubRepo(board: string): { root: string; scripts: string; setBoard: (b: string) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-scoped-settle-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const setBoard = (b: string) => writeFileSync(join(stub, 'board'), b);
  setBoard(board);
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${stub}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) cat "$S/board" ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  --qa-history) exit 0 ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, setBoard, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const BOARD_74F = 'done: 1,2\nin-progress: 10\nstuck: \nready: \nwaiting: 11\n';

/** Run `74f06fcc`'s shape: scoped to 10 and 11 — 10 pending with an open errand, 11 never boarded. */
function shape74f(root: string, status: RunState['status']): RunState {
  const at = new Date(Date.now() - 60_000).toISOString();
  const state = newRun({ slug: 'demo', root, onlyPhases: [10, 11] });
  state.status = status;
  const p10 = phaseRecord(state, 10);
  p10.status = 'pending';
  p10.attempts = 1;
  p10.startedAt = at;
  p10.sessionId = 'sess-p10';
  p10.declared = { status: 'blocked', reason: WALL, needs: 'permission', at };
  (state.recoveries ??= {})['10'] = { attempts: 0, lastAt: at, errand: errand(10, at) };
  phaseRecord(state, 11);
  return state;
}

/* ------------------------------------------------------------------ *
 * SR-1 — the predicate
 * ------------------------------------------------------------------ */

test('SR-1 — phaseSettledWell is an allow-list: only done and skipped settle, and an unknown word never does', () => {
  assert.deepEqual([...SETTLED_WELL], ['skipped', 'done']);
  for (const status of PHASE_STATUSES) {
    assert.equal(phaseSettledWell({ status }, undefined), status === 'done' || status === 'skipped', status);
  }
  for (const word of ['', 'complete', 'settled', 'finished', 'abandoned']) {
    assert.equal(phaseSettledWell({ status: word }), false, `"${word}" — a word the list does not know is not settled`);
  }
  assert.equal(phaseSettledWell(null), false, 'no record at all: the phase never boarded');
  assert.equal(phaseSettledWell(undefined), false);
  assert.equal(settledWellFromState, phaseSettledWell, 'runner/state.ts re-exports the ONE predicate, by identity');
});

test('SR-1 — scopeLeftOpen replays 74f06fcc: the pending phase with an errand and the one that never boarded are both open', () => {
  const state = shape74f('/nowhere', 'finished');
  assert.deepEqual(scopeLeftOpen(state), [10, 11]);
  delete state.phases['11'];
  assert.deepEqual(scopeLeftOpen(state), [10, 11], 'an asked phase with no record at all is open too');
  assert.deepEqual(scopeLeftOpen(newRun({ slug: 'demo', root: '/nowhere' })), [], 'an unscoped run has no scope to leave open');
  assert.equal(scopeNotDoneSentence([10, 11]), 'scope not done: phases 10, 11');
  assert.equal(scopeNotDoneSentence([4]), 'scope not done: phase 4');
});

/* ------------------------------------------------------------------ *
 * SR-2 — the drive loop
 * ------------------------------------------------------------------ */

test('SR-2 — the live loop replaying 74f06fcc parks, names the scope and the errand, and never says "settled"', async () => {
  const r = stubRepo(BOARD_74F);
  const spawned: string[] = [];
  const spawn: SpawnFn = async (request) => { spawned.push(request.prompt); throw new Error('nothing may board'); };
  const instance = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' });
  try {
    const stored = shape74f(r.root, 'parked');
    saveRun(stored);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, onlyPhases: [10, 11], autonomy: 'keep-going' } as never);
    await instance.wait();
    const state = instance.current()!;
    assert.deepEqual(spawned, [], 'nothing on the board could board');
    assert.equal(state.status, 'parked', `not finished (${state.finishedReason ?? ''})`);
    assert.doesNotMatch(state.finishedReason ?? '', /settled/);
    const reason = state.halt?.reason ?? '';
    assert.match(reason, /^scope not done: phases 10, 11 — /, reason);
    assert.match(reason, /phase 10 needs you — The two rule edits the session named, made by a person\./,
      'the pending phase\'s errand is named, not only parked ones');
    const lines = journalLines(r.root, 'demo', stored.id);
    assert.equal(lines.filter((l) => l.event === 'run.finished').length, 0);
  } finally {
    instance.close();
    r.cleanup();
  }
});

test('SR-2 — a scoped run whose asked phases are done still finishes, with the sentence it always had', async () => {
  const r = stubRepo('done: 1,2,10,11\nin-progress: \nstuck: \nready: \nwaiting: \n');
  const instance = new Runner({ scriptsDir: r.scripts, spawn: async () => { throw new Error('no'); }, verificationText: () => '`true`' });
  try {
    const stored = newRun({ slug: 'demo', root: r.root, onlyPhases: [10, 11] });
    stored.status = 'parked';
    for (const phase of [10, 11]) phaseRecord(stored, phase).status = 'done';
    saveRun(stored);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, onlyPhases: [10, 11], autonomy: 'keep-going' } as never);
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'finished');
    assert.match(state.finishedReason ?? '', /scoped to phase 10, 11, and those are settled/);
  } finally {
    instance.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SR-3 — the read path
 * ------------------------------------------------------------------ */

test('SR-3 — a stored run an older console called finished reads back with its open scope named, and keeps its status word', () => {
  const r = stubRepo(BOARD_74F);
  try {
    const stored = shape74f(r.root, 'finished');
    stored.finishedReason = 'this run was scoped to phase 10, 11, and those are settled. '
      + 'Continue with the scope cleared to carry on through the rest of the plan.';
    saveRun(stored);
    const read = loadRun(r.root, 'demo', stored.id)!;
    assert.equal(read.status, 'finished', 'never flipped: a months-old run must not come back to the healer as its plan\'s open run');
    assert.match(read.finishedReason ?? '', /^scope not done: phases 10, 11 — this run stopped with them unsettled/);
    assert.doesNotMatch(read.finishedReason ?? '', /settled\. Continue with the scope cleared/);
    const again = loadRun(r.root, 'demo', stored.id)!;
    assert.equal(again.finishedReason, read.finishedReason, 'idempotent');

    // A scoped run whose scope IS settled keeps the sentence it was written with.
    const fine = newRun({ slug: 'demo', root: r.root, onlyPhases: [10] });
    fine.status = 'finished';
    fine.finishedReason = 'this run was scoped to phase 10, and it is settled.';
    phaseRecord(fine, 10).status = 'done';
    saveRun(fine);
    assert.equal(loadRun(r.root, 'demo', fine.id)!.finishedReason, 'this run was scoped to phase 10, and it is settled.');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SR-4 — an unconsumed errand is never settled
 * ------------------------------------------------------------------ */

test('SR-4 — a standing errand keeps a phase unsettled whatever its status says; retiring it is what settles a done phase', () => {
  const at = new Date().toISOString();
  for (const status of PHASE_STATUSES) {
    assert.equal(phaseSettledWell({ status }, errand(1, at)), false, `${status} with an errand`);
  }
  const state = newRun({ slug: 'demo', root: '/nowhere', onlyPhases: [1, 2, 3] });
  phaseRecord(state, 1).status = 'done';
  phaseRecord(state, 2).status = 'skipped';
  phaseRecord(state, 3).status = 'pending';
  for (const phase of [1, 2, 3]) (state.recoveries ??= {})[String(phase)] = { attempts: 0, lastAt: at, errand: errand(phase, at) };
  assert.deepEqual(scopeLeftOpen(state), [1, 2, 3], 'done and skipped with a standing errand are still owed');

  const lines: Array<{ event: string; data: Record<string, unknown>; phase?: number }> = [];
  const retired = retireSettledErrands(state, (event, data, phase) => { lines.push({ event, data, phase }); });
  assert.deepEqual(retired, [1, 2]);
  assert.deepEqual(lines.map((l) => [l.event, l.data.reason, l.phase]), [
    ['phase.errand-cleared', 'done', 1], ['phase.errand-cleared', 'skipped', 2],
  ]);
  assert.equal(state.recoveries!['3'].errand?.phase, 3, 'a pending phase\'s errand is the ask that stands');
  assert.deepEqual(scopeLeftOpen(state), [3]);
});

/* ---- the service: the operator's Skip, and the healer ---- */

const PLAN = `---
slug: alpha
created: 2026-09-23
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | 2, 3 | app | it works |
| 2 | two | — | 1, 3 | app | it works |
| 3 | three | — | 1, 2 | docs | it works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S

### Phase 3 — three
- **Size:** S
`;

const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-scoped-settle-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}
type Svc = ReturnType<typeof service>;
type Loose = Record<string, unknown>;

function announcements(svc: Svc): Array<{ category: string; title: string; phase: number | null }> {
  const out: Array<{ category: string; title: string; phase: number | null }> = [];
  (svc as never as Loose).announce = (category: string, message: { title: string }, context: { phase?: number | null } = {}) => {
    if (category === 'changed') return;
    out.push({ category, title: message.title, phase: context.phase ?? null });
  };
  return out;
}

function stubDrives(svc: Svc): Array<{ via: string; phase?: number }> {
  const drives: Array<{ via: string; phase?: number }> = [];
  const s = svc as never as Loose;
  s.retryPhase = async (_slug: string, phase: number) => { drives.push({ via: 'retry', phase }); return null; };
  s.recoverPhase = async (_slug: string, phase: number) => { drives.push({ via: 'recover', phase }); return null; };
  s.startRun = async () => { drives.push({ via: 'start' }); return null; };
  return drives;
}

test('SR-4 — the operator\'s Skip on a stored run retires the phase\'s errand, so the skipped phase reads settled', () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const at = new Date().toISOString();
    const stored = newRun({ slug: 'alpha', root: s.root, onlyPhases: [2] });
    stored.status = 'parked';
    stored.stoppedBy = 'system';
    phaseRecord(stored, 2).status = 'parked';
    (stored.recoveries ??= {})['2'] = { attempts: 0, lastAt: at, errand: errand(2, at) };
    saveRun(stored);

    svc.skipPhase('alpha', 2);
    const disk = loadRun(s.root, 'alpha', stored.id)!;
    assert.equal(disk.phases['2'].status, 'skipped');
    assert.equal(disk.recoveries?.['2']?.errand, undefined, 'the ask went with the phase');
    assert.deepEqual(scopeLeftOpen(disk), [], 'skipped by the operator, with nothing owed: settled');
    const cleared = journalLines(s.root, 'alpha', stored.id).filter((l) => l.event === 'phase.errand-cleared');
    assert.deepEqual(cleared.map((l) => [l.data.reason, l.phase]), [['skipped', 2]]);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SR-5 — a declared block parks, even with no drivable rung
 * ------------------------------------------------------------------ */

test('SR-5 — runner: blocked --needs permission with no rule to widen parks the phase with its errand, and the scoped run reads parked', async () => {
  const r = stubRepo('done: \nin-progress: \nstuck: \nready: 1\nwaiting: 2\n');
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let calls = 0;
  const spawn: SpawnFn = async (request) => {
    calls++;
    writeFileSync(request.env!.PE_OUTCOME_FILE as string, JSON.stringify({
      version: 1, slug: 'demo', phase: 1, status: 'blocked', needs: 'permission', reason: WALL,
      watch: [], written_at: new Date().toISOString(),
    }));
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-sr5', costUsd: 0, turns: 1,
      resultText: 'blocked', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true } as never);
    await instance.wait();
    const state = instance.current()!;
    assert.equal(calls, 1, 'one session — nothing re-boarded into the wall');
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.recoveries?.['1']?.errand?.situation, 'blocked-declared:permission');
    assert.match(state.recoveries?.['1']?.errand?.how ?? '', /widen|by hand/);
    const pushed = events.filter((e) => e.event === 'run:phase' && (e.data as { errand?: unknown }).errand);
    assert.ok(pushed.length >= 1, 'the errand rides a phase event — the one the service pushes as needs-you');
    assert.equal(state.status, 'parked', `never "finished" (${state.finishedReason ?? ''})`);
    assert.equal(journalLines(r.root, 'demo', state.id).filter((l) => l.event === 'run.finished').length, 0);
  } finally {
    instance.close();
    r.cleanup();
  }
});

test('SR-5 — healer: the errand written for a pending declared block with no drivable rung PARKS the phase, and is pushed needs-you', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    const said = announcements(svc);
    const at = new Date(Date.now() - 60_000).toISOString();
    // The handoff the session left: blocked — the board reads it `stuck`.
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(join(s.root, 'docs', 'handoffs', 'alpha', 'phase-02-two.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 2\ntitle: two\nstatus: blocked\n---\n\n# Phase 2\n\n## Outstanding / blockers\n\n'
      + `${WALL}\n`, 'utf8');
    const stored = newRun({ slug: 'alpha', root: s.root, onlyPhases: [2], autoRecover: true });
    stored.status = 'parked';
    stored.stoppedBy = 'system';
    stored.halt = { at, reason: `phase 2 declared itself blocked: ${WALL}`, phase: 2, kind: 'phase-blocked' };
    const p2 = phaseRecord(stored, 2);
    p2.status = 'pending';
    p2.attempts = 1;
    p2.startedAt = at;
    p2.declared = { status: 'blocked', reason: WALL, needs: 'permission', at };
    saveRun(stored);

    await svc.maybeAutoRecover('alpha', { trigger: 'timer' });
    const disk = loadRun(s.root, 'alpha', stored.id)!;
    assert.deepEqual(drives, [], 'nothing was driven: no rung of the ladder can be');
    const slot = disk.recoveries?.['2'];
    assert.equal(slot?.errand?.situation, 'blocked-declared:permission', JSON.stringify(slot?.errand));
    assert.match(slot?.errand?.how ?? '', /No rung of blocked-declared:permission's ladder can be driven here/);
    assert.equal(disk.phases['2'].status, 'parked', 'the errand\'s phase reads parked, never pending under an open ask');
    assert.ok(said.some((a) => a.category === 'needs-you' && a.phase === 2), JSON.stringify(said));
    assert.deepEqual(scopeLeftOpen(disk), [2]);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SR-6 — a permission wall this console recorded no rule for
 * ------------------------------------------------------------------ */

test('SR-6 — the protected-path sub-kind: a member of blocked-declared, a person\'s, no rung, answered by human-acts — and never a --needs word', () => {
  assert.ok(SUB_KINDS['blocked-declared'].includes('protected-path'));
  assert.ok(!NEED_CLASSES.includes('protected-path' as never), 'the classifier says it; a session never declares it');
  assert.deepEqual([...rungsFor('blocked-declared:protected-path')], []);
  assert.equal(SITUATION_SUB_ACTOR['blocked-declared:protected-path'], 'person');
  assert.equal(actorFor('blocked-declared', 'protected-path'), 'person');
  assert.equal(decisionKeyOfSituation('blocked-declared:protected-path'), 'human-acts');
});

test('SR-6 — protectedPathOf reads a path under .claude from the rule, the command or the reason, and nothing else', () => {
  assert.equal(protectedPathOf('Edit(.claude/rules/code.md)'), '.claude/rules/code.md');
  assert.equal(protectedPathOf(undefined, 'Edit /repo/hub/.claude/settings.json'), '/repo/hub/.claude/settings.json');
  assert.equal(protectedPathOf(null, null, 'the edit to ~/.claude/settings.json was refused'), '~/.claude/settings.json');
  assert.equal(protectedPathOf('Edit(src/app.ts)', 'git push', 'the .claude directory'), undefined);
  assert.equal(protectedPathOf('notes.claude/x'), undefined, 'a whole segment only');
});

test('SR-6 — a permission block with no recorded rule names the act and the path, and is protected-path when the wall is the CLI\'s own', () => {
  const declared = {
    needs: 'permission', reason: WALL,
    rule: 'Edit(.claude/rules/code-intelligence-mcp.md)', command: 'Edit .claude/rules/code-intelligence-mcp.md',
  };
  // The console recorded NO rule: the CLI's own wall.
  assert.equal(declaredSubKind(declared), 'protected-path');
  // The console's own deny rule refused it: this console's wall, and it can be widened.
  assert.equal(declaredSubKind(declared, { denied: true }), 'permission');
  // A permission wall on an ordinary path with no rule recorded stays `permission`.
  const plain = { needs: 'permission', reason: WALL, command: 'Bash(docker compose up)' };
  assert.equal(declaredSubKind(plain), 'permission');

  const guarded = errandFor('blocked-declared:protected-path', [], 10, undefined, null, null, null, null, null, declared);
  assert.match(guarded.need, /Edit \.claude\/rules\/code-intelligence-mcp\.md/, guarded.need);
  assert.match(guarded.need, /on `\.claude\/rules\/code-intelligence-mcp\.md`/);
  assert.match(guarded.how, /interactive session/);
  assert.equal(guarded.decisionKey, 'human-acts');

  const permission = errandFor('blocked-declared:permission', [], 10, undefined, null, null, null, null, null, plain);
  assert.match(permission.need, /refused `Bash\(docker compose up\)`/, permission.need);
  assert.match(permission.need, /recorded no deny rule of its own/);
  // A rule the console DID record still wins: the widen card names that line.
  const denied = errandFor('blocked-declared:permission', [], 10, undefined, null, null, null,
    { tool: 'Bash', rule: 'Bash(docker:*)', command: 'docker compose up' }, null, plain);
  assert.match(denied.need, /under the rule `Bash\(docker:\*\)`/);
});

test('SR-6 — runner: needs-human --needs permission on a .claude path files a protected-path errand naming the act and the path', async () => {
  const r = stubRepo('done: \nin-progress: \nstuck: \nready: 1\nwaiting: \n');
  const spawn: SpawnFn = async (request) => {
    writeFileSync(request.env!.PE_OUTCOME_FILE as string, JSON.stringify({
      version: 1, slug: 'demo', phase: 1, status: 'needs-human', needs: 'permission', reason: WALL,
      rule: 'Edit(.claude/rules/a.md)', command: 'Edit .claude/rules/a.md',
      watch: [], written_at: new Date().toISOString(),
    }));
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-sr6', costUsd: 0, turns: 1,
      resultText: 'asked', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  const instance = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true } as never);
    await instance.wait();
    const state = instance.current()!;
    const filed = state.recoveries?.['1']?.errand;
    assert.equal(filed?.situation, 'blocked-declared:protected-path', JSON.stringify(filed));
    assert.match(filed?.need ?? '', /Edit \.claude\/rules\/a\.md/);
    assert.match(filed?.need ?? '', /The session said: /);
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.status, 'parked');
  } finally {
    instance.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SR-7 — a pin never breaks the honest finish (control-tower phase 100)
 * ------------------------------------------------------------------ */

test('SR-7 — a pinned phase is open until it settles, a pin outside the scope is refused, and the scope is never widened', async () => {
  const { applyQueueControl, laneMarkRefusal } = await import('../server/runner/queue-control.ts');
  const r = stubRepo(BOARD_74F);
  try {
    const stored = newRun({ slug: 'demo', root: r.root, onlyPhases: [10, 11] });
    stored.status = 'finished';
    stored.finishedReason = 'this run was scoped to phase 10, 11, and those are settled.';
    phaseRecord(stored, 10).status = 'done';
    const actor = { by: 'operator', via: 'api', origin: 'local', remoteUser: null } as never;
    assert.equal(laneMarkRefusal(stored, 11, 'pin'), null, 'inside the scope');
    assert.equal(applyQueueControl(phaseRecord(stored, 11), 'pin', actor).ok, true);
    assert.match(laneMarkRefusal(stored, 12, 'pin') ?? '', /outside this run's scope \(P10, P11\)/, 'a pin never widens it');
    saveRun(stored);
    const read = loadRun(r.root, 'demo', stored.id)!;
    assert.match(read.finishedReason ?? '', /^scope not done: phase 11 — this run stopped with it unsettled/,
      'the pinned phase never settled, so the honest sentence names it');
    assert.deepEqual(read.onlyPhases, [10, 11], 'the scope is what the run was started with');
    assert.ok(read.phases['11']!.queueControl?.pin, 'and the pin is still there for the run that continues it');
  } finally { r.cleanup(); }
});
