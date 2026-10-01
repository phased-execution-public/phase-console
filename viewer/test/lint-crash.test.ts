/**
 * A lint that proved nothing stops nothing.
 *
 * `--lint` and `validate.sh` are read through ONE function, `readLint`, and it
 * had two answers where the world has three. A run that exits 0 is clean; one
 * that exits 1 named its issues on stderr; and one that DIED — on a signal, at
 * an exit code in the signal range, or without ever printing a verdict line —
 * proved nothing at all, which is a different fact from either.
 *
 * `readLint` folded the third into the second. The measured cost (#17): the
 * bash 3.2 allocator killed `validate.sh` mid-pass on a 71-phase plan, and the
 * console then halted the run after EVERY completed phase with
 * `"phase N left the plan failing validate.sh: "` — the reason blank, because
 * the crash had printed nothing to quote. Each halt counted a consecutive
 * failure and withdrew the queue, and withdrawing the queue dequeued the
 * scoped siblings waiting behind it, which is how a zero-touch run ended up
 * parked by a lint that proved nothing.
 *
 * So: a killed engine is `ok: true, crashed: true` with a summary that says so,
 * the runner journals it and carries on, and the lint reads — the only engine
 * calls that walk every phase of a plan — get a ceiling that fits them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './state-sandbox.ts';

const {
  run: engineRun, readLint, timeoutFor, ENGINE_TIMEOUT_MS, LINT_TIMEOUT_MS,
} = await import('../server/engine.ts');
const { Runner } = await import('../server/runner/runner.ts');
type EngineResult = import('../server/engine.ts').EngineResult;
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

/** An engine result with only the fields a reading actually looks at. */
function result(partial: Partial<EngineResult> = {}): EngineResult {
  return { code: 0, stdout: '', stderr: '', ms: 5, timedOut: false, ...partial };
}

/* ------------------------------------------------------------------ *
 * LC-1..3 — the third answer
 * ------------------------------------------------------------------ */

test('LC-1: a lint killed by a signal could not run, and says so', () => {
  // What the allocator death actually looked like on the wire: no stdout, no
  // stderr, `code` in the signal range and a signal to name it.
  const lint = readLint(result({ code: 133, signal: 'SIGTRAP', crashed: true }));

  assert.equal(lint.ok, true, 'a killed run is never a failing plan');
  assert.equal(lint.crashed, true);
  assert.equal(lint.timedOut, false, 'a crash is not a timeout — they are different facts');
  assert.match(lint.summary, /^validation could not run/);
  assert.match(lint.summary, /SIGTRAP/, 'the summary names what killed it');
  assert.deepEqual(lint.issues, [], 'a run that proved nothing reports no issues');
});

test('LC-2: an exit of 128 or above could not run, signal or no signal', () => {
  const lint = readLint(result({ code: 133, crashed: true }));

  assert.equal(lint.ok, true);
  assert.equal(lint.crashed, true);
  assert.match(lint.summary, /^validation could not run/);
  assert.notEqual(lint.summary.trim(), '', 'the summary is never empty — the blank halt is the bug');
});

test('LC-3: a run with no verdict line could not run, whatever its exit code', () => {
  // The shape that reached the runner as `ok: false` with `summary: ''`. An
  // exit of 0 with nothing to show for it is the same claim as an exit of 1:
  // no `LINT`/`VALIDATE` line was printed, so nothing was decided.
  for (const code of [0, 1]) {
    const lint = readLint(result({ code, stderr: 'some stray warning\n' }));
    assert.equal(lint.crashed, true, `exit ${code} with no verdict line`);
    assert.equal(lint.ok, true, `exit ${code} proves nothing about the plan`);
    assert.match(lint.summary, /^validation could not run/);
  }
});

test('LC-3: a real verdict still decides — a crash reading must not swallow one', () => {
  const okLint = readLint(result({ code: 0, stdout: 'LINT OK: alpha — 36 phases\n' }));
  assert.equal(okLint.ok, true);
  assert.equal(okLint.crashed, false);
  assert.equal(okLint.summary, 'LINT OK: alpha — 36 phases');

  const failLint = readLint(result({
    code: 1,
    stderr: 'phase 3: undefined dependency 9\nLINT FAIL: alpha (1 issue[s])\n',
  }));
  assert.equal(failLint.ok, false, 'a named failure is still a failure');
  assert.equal(failLint.crashed, false);
  assert.deepEqual(failLint.issues, ['phase 3: undefined dependency 9']);
});

test('LC-3: a timeout keeps its own word — it is not a crash', () => {
  const lint = readLint(result({ code: 1, timedOut: true }));
  assert.equal(lint.ok, true);
  assert.equal(lint.timedOut, true);
  assert.equal(lint.crashed, false, 'killed at the ceiling is a fact of its own');
  assert.match(lint.summary, /timed out/);
});

test('LC-1: a real subprocess killed by a real signal is reported as crashed', async () => {
  // The seam end to end, with no hand-built EngineResult: `crashed` and
  // `signal` have to survive the shell, or the readings above are theatre.
  const scripts = mkdtempSync(join(tmpdir(), 'pc-lintcrash-scripts-'));
  const script = join(scripts, 'validate.sh');
  writeFileSync(script, '#!/usr/bin/env bash\nkill -TRAP $$\n', 'utf8');
  chmodSync(script, 0o755);

  const res = await engineRun({ scriptsDir: scripts, root: scripts }, 'validate.sh', ['alpha']);

  assert.equal(res.signal, 'SIGTRAP', 'the signal reaches the reader');
  assert.equal(res.crashed, true);
  assert.equal(res.timedOut, false);
  assert.equal(readLint(res).ok, true, 'and the plan is not blamed for it');
});

/* ------------------------------------------------------------------ *
 * LC-5 — the lint reads get a ceiling that fits them
 * ------------------------------------------------------------------ */

test('LC-5: lint reads get 180 s (#44); every other engine read keeps 45 s', () => {
  // `validate.sh` re-enters `phase-graph.sh` once per phase, so it grows with
  // the plan: ~23 s on a 72-phase plan on an idle laptop, and past 45 s under
  // console load. The old ceiling fired on exactly the plans whose `plan-health`
  // decision most needed an answer, and answered `timedOut` for ever.
  assert.equal(timeoutFor('validate.sh', ['alpha']), LINT_TIMEOUT_MS);
  assert.equal(timeoutFor('phase-graph.sh', ['alpha', '--lint']), LINT_TIMEOUT_MS);
  assert.equal(LINT_TIMEOUT_MS, 180_000);

  assert.equal(timeoutFor('phase-graph.sh', ['alpha', '--memory-block']), ENGINE_TIMEOUT_MS);
  assert.equal(timeoutFor('phase-graph.sh', ['alpha', '--boot-prompt', '4']), ENGINE_TIMEOUT_MS);
  assert.equal(timeoutFor('new-handoff.sh', ['alpha', '4', 't']), ENGINE_TIMEOUT_MS);
  assert.equal(ENGINE_TIMEOUT_MS, 45_000);
});

/* ------------------------------------------------------------------ *
 * LC-4 — and the runner carries on
 * ------------------------------------------------------------------ */

/**
 * The smallest repo a phase can actually be driven through: one phase, a board
 * that reads it done once the session says so, and a `validate.sh` that dies
 * the way the allocator killed the real one.
 */
function repo(): { root: string; scripts: string; state: string; crashLint: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-lintcrash-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n', 'utf8');
  writeFileSync(join(state, 'done'), '', 'utf8');

  const write = (path: string, body: string) => {
    writeFileSync(path, body, 'utf8');
    chmodSync(path, 0o755);
  };

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then
      echo "done: 1"; echo "in-progress: "; echo "stuck: "; echo "ready: "; echo "waiting: "
    else
      echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: "
    fi ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo S ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);

  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
[ "\${2:-}" = "status" ] && { echo "phase \${3:-?}: free"; exit 0; }
exit 0
`);

  // The crash, as a real process death: no output on either stream, and a
  // signal to name it. `crash-lint` is what turns it on, so the same harness
  // proves the ordinary green path first.
  write(join(scripts, 'validate.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
[ -f "$S/crash-lint" ] && kill -TRAP $$
echo "VALIDATE OK"
`);

  return {
    root, scripts, state,
    crashLint: () => writeFileSync(join(state, 'crash-lint'), '', 'utf8'),
  };
}

function session(r: { state: string }): SpawnFn {
  return async (_request: SpawnRequest): Promise<SpawnOutcome> => {
    writeFileSync(join(r.state, 'done'), '1\n', 'utf8');
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: 'sess-lc4', costUsd: 0.01, turns: 2, resultText: 'done',
      durationMs: 10, argv: ['-p', '<prompt>'],
    };
  };
}

/** The payloads of every journal line with this name — `emit` nests them one deep. */
const journalled = (
  events: { event: string; data: Record<string, unknown> }[], name: string,
) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('LC-4: a crashed lint after a complete phase neither halts, charges, nor withdraws', async () => {
  const r = repo();
  r.crashLint();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: session(r),
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'done', 'the phase finished — this is not a red phase');
  assert.ok(!state.halt, 'a lint that proved nothing must not halt the run');
  assert.equal(state.consecutiveFailures, 0, 'and must not count against the streak');
  assert.equal(journalled(events, 'run.halt').length, 0);
  assert.equal(journalled(events, 'run.halt-withdrew').length, 0,
    'withdrawing the queue is what dequeued the scoped siblings');

  const unrun = journalled(events, 'phase.lint-unrun');
  assert.equal(unrun.length, 1, 'the run says out loud that it could not read the plan');
  assert.equal(unrun[0].why, 'crashed');
  assert.match(String(unrun[0].summary), /^validation could not run/);

  assert.equal(state.phases['1'].lint?.crashed, true, 'and the record keeps the fact');
  assert.equal(state.phases['1'].lint?.ok, true);
});

test('LC-4: a genuinely failing lint after a complete phase still halts', async () => {
  // The guard on the guard: the halt exists for a reason, and this change must
  // not be a way to stop hearing about a plan that really is broken.
  const r = repo();
  writeFileSync(join(r.scripts, 'validate.sh'),
    '#!/usr/bin/env bash\necho "phase 3: undefined dependency 9" >&2\necho "VALIDATE FAIL: demo" >&2\nexit 1\n', 'utf8');
  chmodSync(join(r.scripts, 'validate.sh'), 0o755);

  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: session(r),
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.halt?.kind, 'plan-lint');
  assert.match(state.halt!.reason, /VALIDATE FAIL/, 'and the reason is never a blank');
  assert.equal(journalled(events, 'phase.lint-unrun').length, 0);
  assert.equal(readFileSync(join(r.state, 'done'), 'utf8').trim(), '1');
});
