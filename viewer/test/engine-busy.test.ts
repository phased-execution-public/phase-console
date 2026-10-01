/**
 * An engine timeout is the MACHINE, not the plan (control-tower phase 81, #104).
 *
 * Measured on hub 4123, 2026-09-24 16:56–17:34Z, load average 35–42: a
 * `start {resumeRunId}` of a 72-phase run (`24fcba33`) came back halted
 * `plan-unreadable` — "the engine timed out reading this plan" — over a plan
 * `validate.sh` called `VALIDATE OK … 72 phases` in the same minute. The healer
 * classified the halt `plan-broken:unreadable` and climbed `plan-repair-script`
 * four times in four minutes (three `withdrawn · never-ran`, one `failed ·
 * merit`), each needing the very engine read that was timing out; then a
 * repair AGENT session ($3.89) closed a phase nothing was wrong with.
 *
 * EB-1: a board read that TIMES OUT is waited out — the run reads `waiting`
 * (`engine-busy`) on a back-off clock, journalled with the machine's load, no
 * failure charged, no halt, no rung — and the first read that answers carries
 * on. Only a timeout that outlasts the whole back-off stops the run, and it
 * says how long it waited.
 * EB-2: a stored `plan-unreadable` stop is not a broken plan: converge
 * relaunches it once the plan reads and lints clean, and climbs no ladder.
 * EB-3: `plan-repair-script` (any plan-repair rung for a lint or read stop)
 * climbs only after a lint that RAN shows a real defect — never over a clean
 * lint, never over one that could not run.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { SpawnFn, SpawnOutcome } from '../server/runner/spawn.ts';

const core = await import('../server/runner/runner-core.ts') as Record<string, unknown>;
const MAX_WAITS = (core.ENGINE_BUSY_MAX_WAITS as number | undefined) ?? 8;
const { planConvergence } = await import('../server/converge.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;
type LintResult = import('../server/engine.ts').LintResult;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;

/** The engine's own words for a read it had to kill. */
const TIMED_OUT = 'the engine timed out reading this plan';

/* ------------------------------------------------------------------ *
 * EB-1 — the drive loop waits out a busy engine
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-engine-busy-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"; mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done"; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(stub, 'done'), `${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-A', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: [], injected: 0,
  };
}

/** What `readMemoryBlock` answers for a read the engine had to kill. */
const TIMED_OUT_BOARD = {
  phased: false, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
  blockedBy: {}, qa: {}, error: TIMED_OUT, timedOut: true,
};

type Frame = { event: string; data: Record<string, unknown>; status?: string; waitReason?: string | null };

/**
 * A runner whose first `timeouts` board reads time out (every one, when
 * `timeouts` is Infinity) — the drive loop's own read is the first a start makes.
 */
function harness(r: Repo, spawn: SpawnFn, timeouts: number, backoff: readonly number[] = [5, 5, 5]) {
  const frames: Frame[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    engineBusyBackoffMs: backoff,
    onEvent: (event, data) => {
      const state = (data as { state?: RunState }).state;
      frames.push({ event, data, ...(state ? { status: state.status, waitReason: state.waitReason ?? null } : {}) });
    },
  } as never);
  const real = (instance as unknown as { board: () => Promise<unknown> }).board.bind(instance);
  let left = timeouts;
  (instance as unknown as { board: () => Promise<unknown> }).board = async () => {
    if (left > 0) { left -= 1; return TIMED_OUT_BOARD; }
    return real();
  };
  return { instance, frames };
}

const journalled = (frames: Frame[], name: string) => frames
  .filter((f) => f.event === 'run:journal' && f.data.event === name)
  .map((f) => (f.data.data ?? {}) as Record<string, unknown>);

test('EB-1: a board read that times out is waited out on a back-off clock — no halt, no failure, and the run carries on when the engine answers', async () => {
  const r = repo();
  try {
    let calls = 0;
    const { instance, frames } = harness(r, async () => { calls += 1; r.markDone(1); return ok(); }, 2);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    await instance.wait();
    const state = instance.current()!;

    assert.deepEqual(journalled(frames, 'run.halt'), [], 'a timeout says nothing about the plan — nothing halts');
    assert.equal(calls, 1, 'once the engine answered, the phase boarded');
    assert.equal(state.phases['1']?.status, 'done');
    assert.equal(state.consecutiveFailures, 0, 'no failure is charged for a busy machine');

    const waits = journalled(frames, 'run.engine-busy');
    assert.deepEqual(waits.map((w) => w.attempt), [1, 2], 'each wait journalled, counted');
    for (const wait of waits) {
      assert.equal(wait.delayMs, 5, 'on the back-off series');
      assert.equal(typeof wait.load, 'number', 'with the machine\'s load beside it');
      assert.equal(typeof wait.cpus, 'number');
      assert.match(String(wait.error ?? ''), /timed out/);
    }
    assert.equal(journalled(frames, 'run.engine-busy-cleared').length, 1, 'and the answer that ended it');
    assert.ok(frames.some((f) => f.event === 'run:run' && f.status === 'waiting' && f.waitReason === 'engine-busy'),
      'while it waited the run said so — `waiting` on `engine-busy`, never a stop');
  } finally { r.cleanup(); }
});

test('EB-1: a timeout that outlasts the whole back-off stops the run once — `plan-unreadable`, saying how many reads timed out — and still charges nothing', async () => {
  const r = repo();
  try {
    const { instance, frames } = harness(r, async () => ok(), Number.POSITIVE_INFINITY);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    await instance.wait();
    const state = instance.current()!;

    assert.equal(journalled(frames, 'run.engine-busy').length, MAX_WAITS, 'every wait of the series was spent first');
    assert.equal(state.status, 'halted');
    assert.equal(state.halt?.kind, 'plan-unreadable');
    assert.match(state.halt?.reason ?? '', new RegExp(`timed out .*${MAX_WAITS + 1} times`),
      'the stop says the machine was busy for the whole back-off, not that the plan is broken');
    assert.equal(state.consecutiveFailures, 0);
  } finally { r.cleanup(); }
});

test('EB-1: a Stop pressed during an engine-busy wait cuts it short — it does not sit out the back-off, and the run never reads running on the way out', async () => {
  const r = repo();
  try {
    const { instance, frames } = harness(r, async () => ok(), Number.POSITIVE_INFINITY, [60_000]);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    for (let i = 0; i < 200 && !journalled(frames, 'run.engine-busy').length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(journalled(frames, 'run.engine-busy').length, 1, 'the loop is waiting out the engine');
    const waitedAt = frames.length;
    const pressed = Date.now();
    // The wait is a minute long; the Stop must end it now, not after it.
    await instance.stop('operator');
    await instance.wait();
    assert.ok(Date.now() - pressed < 10_000, `the wait was cut short, not sat out (${Date.now() - pressed} ms)`);

    const after = frames.slice(waitedAt).filter((f) => f.event === 'run:run').map((f) => f.status);
    assert.ok(!after.includes('running'), `the stop is not dressed as a resume first: ${after.join(' → ')}`);
    assert.notEqual(instance.current()?.status, 'waiting');
    assert.equal(instance.current()?.consecutiveFailures, 0);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * EB-2 — converge answers a stored plan-unreadable stop without a ladder
 * ------------------------------------------------------------------ */

function lint(okay: boolean, extra: Partial<LintResult> = {}): LintResult {
  return {
    ok: okay, issues: [], summary: okay ? 'VALIDATE OK: alpha' : 'VALIDATE FAIL: alpha — 1 handoff problem(s)',
    timedOut: false, crashed: false, ...extra,
  };
}

function unreadable(over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root: '/nowhere' });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.halt = { at: new Date().toISOString(), reason: `the engine could not read the plan: ${TIMED_OUT}`, kind: 'plan-unreadable' };
  phaseRecord(state, 1).status = 'done';
  // The #104 run had boarded its open phase before the read timed out — so no
  // "never boarded" branch relaunches it, and the stop is what decides.
  const two = phaseRecord(state, 2);
  two.status = 'interrupted';
  two.attempts = 1;
  Object.assign(state, over);
  return state;
}

function facts(run: RunState, over: Partial<ConvergeFacts> = {}): ConvergeFacts {
  return {
    slug: 'alpha', now: Date.now(), trigger: 'halt',
    board: { 1: 'done', 2: 'ready', 3: 'waiting' },
    runs: [run], live: new Set(), locks: [], prefs: {},
    ...over,
  };
}

test('EB-2: a stored plan-unreadable stop over a plan that now reads and lints clean is RELAUNCHED — no heal, no rung', () => {
  const run = unreadable();
  const plan = planConvergence({ ...facts(run), lint: lint(true) } as ConvergeFacts);
  assert.ok(!plan.actions.some((action) => action.kind === 'heal'), `no ladder is climbed: ${JSON.stringify(plan.actions)}`);
  const relaunch = plan.actions.find((action) => action.kind === 'relaunch');
  assert.ok(relaunch, JSON.stringify(plan.actions));
  assert.equal(relaunch.kind === 'relaunch' && relaunch.runId, run.id);
});

test('EB-2: while the board cannot be read the stop waits — converge never decides on an empty board', () => {
  const plan = planConvergence({ ...facts(unreadable(), { board: null }), lint: lint(true) } as ConvergeFacts);
  assert.ok(!plan.actions.some((action) => action.kind === 'relaunch' || action.kind === 'heal'), JSON.stringify(plan.actions));
});

/* ------------------------------------------------------------------ *
 * EB-3 — the repair rung climbs only over a lint that shows a defect
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-engine-busy-heal-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n', 'utf8');
  return root;
}

function healer(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const scripts: number[] = [];
  (svc as never as Record<string, unknown>).runRepairScript = async (_slug: string, phase: number) => { scripts.push(phase); };
  // Nothing here may spawn a session: a paid rung would be recorded, not run.
  (svc as never as Record<string, unknown>).recoverPhase = async () => null;
  return { svc, scripts };
}

/** The #104 run: halted `plan-unreadable` by a timed-out read, phase 2 left mid-flight. */
function unreadableRun(root: string): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.halt = { at: new Date().toISOString(), reason: `the engine could not read the plan: ${TIMED_OUT}`, kind: 'plan-unreadable' };
  state.finishedReason = state.halt.reason;
  phaseRecord(state, 1).status = 'done';
  const two = phaseRecord(state, 2);
  two.status = 'interrupted';
  two.attempts = 1;
  saveRun(state);
  return state;
}

for (const [label, answer] of [
  ['clean', lint(true)],
  ['timed out', lint(false, { timedOut: true, summary: '' })],
  ['crashed', lint(false, { crashed: true, summary: '' })],
] as const) {
  test(`EB-3: over a lint that ${label === 'clean' ? 'reads clean' : `${label}`}, no plan-repair rung is climbed — nothing is spent on a plan with nothing proven wrong`, async () => {
    const root = scratch();
    const { svc, scripts } = healer(root);
    try {
      const state = unreadableRun(root);
      (svc as never as Record<string, unknown>).lint = async () => answer;
      const result = await svc.maybeAutoRecover('alpha');
      assert.equal(result.launched, false, JSON.stringify(result));
      assert.match(result.reason ?? '', label === 'clean' ? /lints clean/ : /lint could not run/);
      assert.deepEqual(scripts, [], 'the deterministic repair never ran');
      const after = loadRun(root, 'alpha', state.id)!;
      assert.deepEqual(after.recoveries?.['2']?.rungs ?? [], [], 'no rung is recorded against the phase');
    } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('EB-3: a lint that RAN and failed is a real defect — then, and only then, the deterministic repair climbs', async () => {
  const root = scratch();
  const { svc, scripts } = healer(root);
  try {
    unreadableRun(root);
    (svc as never as Record<string, unknown>).lint = async () => lint(false);
    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true, JSON.stringify(result));
    assert.equal(result.rung, 'plan-repair-script');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(scripts, [2]);
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});
