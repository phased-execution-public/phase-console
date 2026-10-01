/**
 * A sibling's stop never drops a waiting phase's clock (#53, control-tower
 * phase 50).
 *
 * The measured shape, on another plan's run: phase 9 parked `waiting-external`
 * on a CD window with a clock; phase 11 then boarded and ended `needs-human`
 * (a credential errand). The loop wrote the run `parked`, nothing drives a
 * parked run, phase 9 settled `clock-unarmed` — three times — and waited 65
 * minutes past its clock for a person's Start. The two stops were unrelated.
 *
 *   SK-1  a lane ending needs-human while another lane holds an external-wait
 *         clock leaves the run `waiting` on the earliest un-fired clock, the
 *         errand standing beside it — and that clock resumes the waiting phase;
 *   SK-2  a park that must happen (a RUN's stop) carries that clock as
 *         `waitUntil` instead of dropping it;
 *   SK-3  one settlement per clock — in `the-clock-is-evidence.test.ts`.
 *
 * Driven through a real `Runner` over a stub plan, the way `scope-fence.test.ts`
 * drives the fence: the loop's own endings are what is under test.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunState } from '../server/runner/state.ts';
import type { SpawnFn, SpawnRequest } from '../server/runner/spawn.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { journalFile, newRun, phaseRecord, saveRun, carryWaitClock } = await import('../server/runner/state.ts');
const { waitClockVerdict } = await import('../server/converge.ts');

type Line = { event: string; phase?: number; data?: Record<string, unknown> };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A stub repository whose board reads every unfinished phase of 1–2 ready. */
function stubRepo(): { root: string; scripts: string; stub: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-sibling-park-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${stub}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, stub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function journalOf(root: string, runId: string): Line[] {
  const file = journalFile(root, 'demo', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
}

function declare(request: SpawnRequest, body: Record<string, unknown>): void {
  const path = request.env?.PE_OUTCOME_FILE;
  assert.ok(typeof path === 'string' && path, 'the runner must inject PE_OUTCOME_FILE');
  writeFileSync(path as string, JSON.stringify({
    version: 1, slug: 'demo', written_at: new Date().toISOString(), watch: [], ...body,
  }));
}

const ERRAND = 'A person must sign the deploy key in before the release can be cut.';

/**
 * A stored run whose phase 1 is parked `waiting-external` on a clock thirty
 * minutes out; resuming it boards phase 2, whose session does `onPhase2`.
 */
async function siblingEnds(
  onPhase2: (request: SpawnRequest, instance: InstanceType<typeof Runner>, stub: string) => void,
): Promise<{ state: RunState; lines: Line[]; clock: string; spawned: number[] }> {
  const r = stubRepo();
  const scheduler = new Scheduler({ max: 3, locks: () => [] });
  const spawned: number[] = [];
  let instance: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    spawned.push(phase);
    if (phase === 2) onPhase2(request, instance, r.stub);
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: `sess-${phase}`, costUsd: 0, turns: 1,
      resultText: 'done', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  instance = new Runner({
    scriptsDir: r.scripts, spawn, scheduler, maxParallel: 3,
    verificationText: () => '`true`',
    // Disjoint scopes, so no fence stands between the two phases.
    phaseScope: (_slug: string, phase: number) => (phase === 1 ? ['deploy'] : ['app']),
  } as never);
  try {
    const at = new Date().toISOString();
    const clock = new Date(Date.now() + 30 * 60_000).toISOString();
    const stored = newRun({ slug: 'demo', root: r.root });
    stored.status = 'parked';
    stored.stoppedBy = 'system';
    const waiting = phaseRecord(stored, 1);
    waiting.status = 'waiting';
    waiting.attempts = 1;
    waiting.sessionId = 'sess-1';
    waiting.parkedUntil = clock;
    waiting.parkReason = 'the CD window';
    waiting.declared = { status: 'waiting-external', reason: 'the CD window', watch: ['gh:acme/app#run/4101'], at };
    saveRun(stored);

    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going' } as never);
    await instance.wait();
    return { state: instance.current()!, lines: journalOf(r.root, stored.id), clock, spawned };
  } finally {
    scheduler.close();
    instance.close();
    r.cleanup();
  }
}

test('SK-1: a sibling ending needs-human leaves the run WAITING on the waiting phase\'s clock, its errand beside it', async () => {
  const { state, lines, clock, spawned } = await siblingEnds((request) => {
    declare(request, { phase: 2, status: 'needs-human', reason: ERRAND, needs: 'credential' });
  });
  assert.deepEqual(spawned, [2], 'phase 1 is waiting on its clock; phase 2 boarded');
  assert.equal(state.status, 'waiting', `not parked (${state.finishedReason ?? ''})`);
  assert.equal(state.waitUntil, clock, 'the run waits on the earliest un-fired clock');
  assert.equal(state.halt ?? null, null, 'no run-level stop: the run is waiting');
  assert.equal(state.phases['1'].status, 'waiting');
  assert.equal(state.phases['1'].parkedUntil, clock, 'the waiting phase keeps its clock');
  // The errand stands beside the wait, on its own phase.
  assert.equal(state.phases['2'].status, 'parked');
  assert.equal(state.phases['2'].declared?.status, 'needs-human');
  assert.ok(state.recoveries?.['2']?.errand, 'phase 2 carries its errand');
  assert.match(state.finishedReason ?? '', /Meanwhile phase 2 stopped/);
  const waitingLines = lines.filter((l) => l.event === 'run.waiting-external');
  const last = waitingLines[waitingLines.length - 1];
  assert.ok(last, 'the wait is journalled');
  assert.equal(last.data?.waitUntil, clock);
  assert.equal((last.data?.beside as { phase?: number } | undefined)?.phase, 2, 'and names the stop beside it');
  // …and the clock it waits on is the one that resumes the waiting phase.
  const verdict = waitClockVerdict({ ...state, resumeOnRestart: true } as RunState, { now: Date.parse(clock) + 5 * 60_000, prefs: {} });
  assert.equal(verdict.verdict, 'resume');
  assert.deepEqual(verdict.verdict === 'resume' ? verdict.phases : [], [1]);
  assert.equal(lines.filter((l) => l.event === 'phase.wait-settled').length, 0, 'nothing settled a clock nothing dropped');
});

test('SK-2: a RUN\'s stop still parks — and the park carries the waiting phase\'s clock as waitUntil', async () => {
  const { state, clock, spawned } = await siblingEnds((_request, instance, stub) => {
    // A stop about the RUN, raised while phase 2's lane is live; the phase
    // itself finishes (its handoff is on the board).
    instance.park('the run\'s preflight stopped it', null, 'run-preflight');
    appendFileSync(join(stub, 'done'), '2\n');
  });
  assert.deepEqual(spawned, [2]);
  assert.equal(state.status, 'parked', 'a run-level stop is not converted into a wait');
  assert.equal(state.halt?.kind, 'run-preflight');
  assert.equal(state.waitUntil, clock, 'the park carries the clock rather than dropping it');
  assert.equal(state.phases['1'].status, 'waiting');
  assert.equal(state.phases['1'].parkedUntil, clock);
});

test('SK-2: carryWaitClock writes the soonest waiting record\'s clock, and never over a clock the run has', () => {
  const run = newRun({ slug: 'demo', root: tmpdir() });
  run.status = 'parked';
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const late = new Date(Date.now() + 50 * 60_000).toISOString();
  Object.assign(phaseRecord(run, 1), { status: 'waiting', parkedUntil: late });
  Object.assign(phaseRecord(run, 2), { status: 'waiting', parkedUntil: soon });
  Object.assign(phaseRecord(run, 3), { status: 'parked', parkedUntil: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(carryWaitClock(run), soon, 'the earliest WAITING record — a parked one holds no wait clock');
  assert.equal(run.waitUntil, soon);
  assert.equal(run.waitReason, 'external');
  run.waitUntil = late;
  assert.equal(carryWaitClock(run), null, 'a clock the run already has is its own');
  assert.equal(run.waitUntil, late);
});
