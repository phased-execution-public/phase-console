/**
 * "At the next boundary, board phase N with this instruction" — ONE verb
 * (control-tower phase 98, #137 item 3; the `when: 'boundary'` shape of phase
 * 78's switch, applied to a re-board).
 *
 * `resume-phase` refused a live run (`reboardForPerson` threw `RunBusyError`
 * while a runner lived; `recoverPhase` the same) and `steer` refused a run
 * with nothing live, so "board P66 next, with this note" meant pausing the
 * whole run, polling until it read `paused`, then pressing — an hour of
 * polling on a run with a live lane, and a window at the pause in which
 * another phase could take the lane (#134).
 *
 * BB-1: on a live run with its one lane busy, the phase boards at the NEXT
 *       boundary, AHEAD of every candidate that was there first, carrying the
 *       operator's words; the press answers `queued` (the lane is not free)
 *       and is journalled with who pressed it and why.
 * BB-1: through the routes, `board-at-boundary` and `resume-phase` on a LIVE
 *       run both reach the runner's boundary board instead of a 409 "busy";
 *       a phase in a lane is refused by name.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { call, scratch, service, tempDir } from './verb-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { pressActor } = await import('../server/actor.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;

/** A plan library whose engine is a stub: three phases, one scope, all ready until done. */
function stubEngine() {
  const root = tempDir('boundary-root');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '---\nslug: demo\n---\n# demo\n');
  const scripts = tempDir('boundary-scripts');
  const doneFile = join(root, 'done.txt');
  writeFileSync(doneFile, '');
  const script = (name: string, body: string) => {
    writeFileSync(join(scripts, name), body, 'utf8');
    chmodSync(join(scripts, name), 0o755);
  };
  // Every phase not in done.txt is ready — the board's own order is 1, 2, 3,
  // written as the engine writes a bucket: comma-separated.
  script('phase-graph.sh', `#!/usr/bin/env bash
set -u
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    done=""; ready=""
    for p in 1 2 3; do
      if grep -qx "$p" "${doneFile}"; then done="$done,$p"; else ready="$ready,$p"; fi
    done
    echo "done: \${done#,}"; echo "ready: \${ready#,}"; echo "waiting:" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  for (const name of ['phase-lock.sh', 'next-phase-prompt.sh', 'new-handoff.sh']) script(name, '#!/usr/bin/env bash\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, doneFile };
}

test('BB-1: the phase boards at the next boundary, ahead of the candidate that was there first, with the operator\'s words', async () => {
  const { root, scripts, doneFile } = stubEngine();
  const order: number[] = [];
  const prompts = new Map<number, string>();
  let releaseFirst: () => void = () => {};
  let runner!: InstanceType<typeof Runner>;
  const firstRunning = new Promise<void>((started) => {
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? 0);
      order.push(phase);
      prompts.set(phase, request.prompt);
      if (phase === 1) {
        started();
        await new Promise<void>((release) => { releaseFirst = release; });
      }
      writeFileSync(doneFile, `${phase}\n`, { flag: 'a' });
      return {
        signal: { subtype: 'success', code: 0, text: '' },
        sessionId: `sess-${phase}`, costUsd: 0, turns: 1, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
      };
    };
    runner = new Runner({ scriptsDir: scripts, spawn, verificationText: () => '`true`' });
  });
  const state = await runner.start({ slug: 'demo', root } as Parameters<typeof runner.start>[0]);
  await firstRunning;
  assert.deepEqual(order, [1], 'phase 1 holds the one lane; 2 and 3 wait behind it');

  const actor = { ...pressActor({ by: 'mobin', via: 'cli', origin: 'local', remoteUser: null }), reason: 'P3 carries the migration' };
  const out = runner.boardAtBoundary(3, { instruction: 'read the lock file before the migration', actor });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.ok && out.brief, 'resume', 'no session of its own yet: a fresh boarding with the resume brief');

  const refused = runner.boardAtBoundary(1, { actor });
  assert.equal(refused.ok, false, 'a phase in a lane is not re-boarded under itself');
  assert.match(!refused.ok ? refused.reason : '', /running now — steer it, or leave a note for its next attempt/);

  releaseFirst();
  await runner.wait();
  assert.deepEqual(order, [1, 3, 2], 'at the boundary phase 3 took the lane — ahead of phase 2, which was there first');
  assert.match(prompts.get(3) ?? '', /read the lock file before the migration/, 'the operator\'s words reached phase 3\'s session');

  const lines = readFileSync(journalFile(root, 'demo', state.id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const pressed = lines.find((line) => line.event === 'phase.board-at-boundary');
  assert.ok(pressed, 'the press is journalled');
  assert.equal(pressed.phase, 3);
  assert.equal(pressed.data.by, 'mobin');
  assert.equal(pressed.data.via, 'cli');
  assert.equal(pressed.data.reason, 'P3 carries the migration');
  assert.equal(pressed.data.instruction, 'read the lock file before the migration');
  assert.equal(existsSync(doneFile), true);
});

/* ------------------------------------------------------------------ *
 * The routes reach the boundary board on a live run
 * ------------------------------------------------------------------ */

/** A live runner as the service sees one: driving, and recording what it is asked. */
function liveRunnerStub(run: { id: string; slug: string; status: string; phases: Record<string, unknown> }) {
  const asked: { phase: number; instruction?: string; actor: Record<string, unknown> }[] = [];
  return {
    asked,
    runner: {
      busy: () => true,
      current: () => run,
      boardAtBoundary: (phase: number, opts: { instruction?: string; actor: Record<string, unknown> }) => {
        if (phase === 2) return { ok: false, reason: 'phase 2 is running now — steer it, or leave a note for its next attempt (deliver: next-attempt)' };
        asked.push({ phase, ...opts });
        return { ok: true, brief: 'resume', sessionId: null };
      },
      boardingVerdict: async () => ({ queued: { position: 1 } }),
      recoveryQueuedFor: () => null,
      liveness: () => [],
    },
  };
}

test('BB-1: board-at-boundary and resume-phase on a LIVE run reach the boundary board — not a 409 "busy"', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    const run = newRun({ slug: 'alpha', root });
    run.status = 'running';
    phaseRecord(run, 1).status = 'parked';
    phaseRecord(run, 2).status = 'running';
    saveRun(run);
    const stub = liveRunnerStub(run as never);
    (svc as unknown as { runners: Map<string, unknown> }).runners.set('alpha', stub.runner);

    const board = await call(svc, 'POST', '/api/run/alpha/board-at-boundary', {
      phase: 3, instruction: 'start from the new schema', reason: 'the cart waits on it', by: 'mobin',
    });
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.deepEqual(board.body.queued, { runId: run.id, phase: 3, session: null, brief: 'resume', position: 1 },
      'the lane is busy, so the press says QUEUED and where — never launched');
    assert.equal(stub.asked[0]?.instruction, 'start from the new schema');
    assert.equal(stub.asked[0]?.actor.door, 'operator', 'a person\'s press');
    assert.equal(stub.asked[0]?.actor.reason, 'the cart waits on it');

    const resume = await call(svc, 'POST', '/api/run/alpha/resume-phase', { phase: 1, instruction: 'finish the handoff' });
    assert.equal(resume.status, 200, `resume-phase on a live run: ${JSON.stringify(resume.body)}`);
    assert.equal(stub.asked[1]?.phase, 1, 'resume-phase took the same boundary path');
    assert.equal(stub.asked[1]?.instruction, 'finish the handoff');

    const running = await call(svc, 'POST', '/api/run/alpha/board-at-boundary', { phase: 2 });
    assert.equal(running.status, 409);
    assert.match(running.body.error, /running now/);

    const bad = await call(svc, 'POST', '/api/run/alpha/board-at-boundary', { phase: 'x' });
    assert.equal(bad.status, 400);
  } finally {
    (svc as unknown as { runners: Map<string, unknown> }).runners.delete('alpha');
    svc.close();
  }
});
