/**
 * The runner: does it advance a plan, and — more importantly — does it refuse
 * to advance one that did not actually work?
 *
 * The loop runs against a real temporary repo with real (stub) shell scripts,
 * because the parts most likely to break are the seams: exit codes, board
 * parsing, lock claims. Only the `claude` child is faked, since spending money
 * on a model is not a unit test. The stub board is driven by a `done` file that
 * the fake session appends to, which is precisely what a real session does when
 * it writes a handoff — so "the session claimed success but wrote nothing" is
 * expressible here, and it is the case that matters most.
 */

import { RETRY_STORM_PARK_MS } from '../shared/attention-model.js';
import { HALT_KINDS } from '../shared/recovery-model.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is resolved when config.ts loads, so the redirect has to happen
// before any module that reaches it is imported.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-runner-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { extractCommands, verifyPhase } = await import('../server/runner/verify.ts');
const { buildArgv, sanitize, lineReader, userMessage } = await import('../server/runner/spawn.ts');
const { nextModel, fallbackChain } = await import('../server/runner/errors.ts');
const {
  listRuns, loadRun, newRun, saveRun, journalFile, phaseRecord, resetForRetry, retryOverrideFrom,
  IN_FLIGHT,
} = await import('../server/runner/state.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { LOCK_CAP_PARK_BY_LOCK, LOCK_CAP_PARK_NOTE, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, PROVISIONAL_LEASE_S, PROVISIONAL_REFUSAL_LIMIT, RUNNER_LEASE_S } = await import('../server/runner/runner-core.ts');
const { freezeVerdict } = await import('../server/runner/freeze.ts');
const { doorActor, pressActor } = await import('../server/actor.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';
import type { PhaseRecord, RunState } from '../server/runner/state.ts';
import type { LockView } from '../server/runner/scheduler.ts';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';

/* ------------------------------------------------------------------ *
 * A repo with stub scripts
 * ------------------------------------------------------------------ */

type Repo = {
  root: string;
  scripts: string;
  state: string;
  markDone: (phase: number) => void;
  doneList: () => number[];
  setGate: (phase: number, text: string) => void;
  setStuck: (phase: number) => void;
  /** A handoff exists for the phase and reads in-progress (the board lists it so). */
  setInProgress: (phase: number) => void;
  /** Every not-done phase is ready at once — a graph with no edges. */
  setParallel: (yes: boolean) => void;
  /**
   * The board reads `phase` done, its verdict is `verdict`, and it holds every
   * remaining phase: ready is empty, waiting is everything else, and the
   * `blocked:` line names the verdict.
   */
  setQaBlocked: (phase: number | null, verdict?: string) => void;
  /**
   * The phase's own QA regime reads `on` and its verdict is `verdict` — the
   * shape `maybeQaVerdict` chases. `null` removes it, and the stub then exits
   * non-zero for both modes, which is what every other test in this file sees.
   */
  setQaOwed: (verdict: string | null) => void;
  /** What `--qa-history` answers: tab-separated `round result report recorded` lines. */
  setQaHistory: (rows: string | null) => void;
  setLockRefused: (yes: boolean) => void;
  /** The same, for ONE phase — the others read free. */
  setLockRefusedFor: (phase: number, yes: boolean) => void;
  setLockLapsed: (yes: boolean) => void;
  /** `status` names a holder whose id contains a SPACE (D4), with a session. */
  setLockSpacedOwner: (yes: boolean) => void;
  /** Make `claim` refuse as a foreign takeover — the keepalive's lock-lost case. */
  setClaimRefuse: (yes: boolean) => void;
  setLintFail: (yes: boolean) => void;
  /** Make the board read slow, so a control can be pressed while it is in flight. */
  setSlowBoard: (yes: boolean) => void;
  /** Same, for the gate subprocess — the first await of boarding a phase. */
  setSlowGate: (yes: boolean) => void;
  /** The phase's `Size:` the engine reports — what its session caps are derived from. */
  setSize: (phase: number, size: 'S' | 'M' | 'L') => void;
  cleanup: () => void;
};

const PHASES = [1, 2, 3];

/**
 * What the accounts facade answers a `leaveAccount` with — the harness's
 * stand-in (zero-touch-console phase 8). Mirrors `Accounts.leaveAccount`:
 * a window with a reset walls until it, one without cools for the fixed
 * cool-down, a credential retires, an operator's switch holds nothing.
 */
function leaveStub(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  const id = accountId ?? 'default';
  const now = Date.now();
  if (leaving.kind === 'operator') return { accountId: id, credential: 'stub', state: 'entitled', throttleUntilMs: null };
  if (leaving.kind === 'credential') {
    return { accountId: id, credential: 'stub', state: 'retired', throttleUntilMs: now + 30 * 60_000 };
  }
  // The reset as given — the facade compares it with ITS injected clock, and
  // a harness on a fake clock must not have a real `Date.now()` second-guess it.
  const resets = leaving.resetsAt ?? null;
  const until = leaving.perModel ? undefined : (resets ?? new Date(now + 30 * 60_000)).toISOString();
  return {
    accountId: id, credential: 'stub', state: leaving.perModel ? 'entitled' : 'cooling',
    ...(until ? { until } : {}),
    ...(leaving.bucket && resets ? { wall: { bucket: leaving.bucket, resetsAt: resets.toISOString() } } : {}),
    throttleUntilMs: leaving.perModel ? null : Date.parse(until!),
  };
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-runner-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  // A linear 3-phase graph: phase N is ready once every earlier phase is done.
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    # The real board is a subprocess taking a noticeable moment. Stretching it
    # on demand is what makes the gap between "the loop checked for a pause" and
    # "the loop started a phase" long enough to press a button inside.
    [ -f "$S/slow-board" ] && sleep 1
    # A QA wedge: a phase the board reads DONE whose verdict holds every
    # dependent. The ready set is empty while the plan is nowhere near
    # finished - the exact shape a real run hit, and the one this harness
    # could not express, which is why the halt branch below had no test.
    if [ -f "$S/qa-blocked" ]; then
      qp="$(cat "$S/qa-blocked")"; qv="$(cat "$S/qa-verdict" 2>/dev/null || echo fail)"
      d=""; w=""; bl=""
      for p in ${PHASES.join(' ')}; do
        if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
        else w="$w$p,"; bl="$bl $p<-$qp(qa:$qv)"; fi
      done
      echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
      echo "ready: "; echo "waiting: \${w%,}"
      echo "blocked:$bl"
      exit 0
    fi
    d=""; r=""; w=""; s=""; i=""; found=0
    for p in ${PHASES.join(' ')}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif grep -qx "$p" "$S/stuck" 2>/dev/null; then s="$s$p,"
      elif grep -qx "$p" "$S/inprog" 2>/dev/null; then i="$i$p,"; found=1
      elif [ "$found" -eq 0 ] || [ -f "$S/parallel" ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: \${i%,}"; echo "stuck: \${s%,}"
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status)
    # Stretched on demand, like the board: the gate is the FIRST subprocess of
    # boarding, and the pause-during-boarding tests need a window to press in.
    [ -f "$S/slow-gate" ] && sleep 1
    # Echoes whether the caller opted into cmd-gate execution — pins that the
    # runner really passes PHASE_EXEC_GATES=1 (it claimed to for months and did not).
    [ -f "$S/gate-echo-env" ] && { echo "manual: exec=\${PHASE_EXEC_GATES:-0}"; exit 1; }
    if [ -f "$S/gate-$arg" ]; then cat "$S/gate-$arg"; exit 1; fi
    echo "clear (no gate)"
    ;;
  --qa-mode)
    # maybeQaVerdict asks this first and treats a non-zero exit as a no.
    [ -f "$S/qa-owed" ] || { echo "unsupported stub mode: $mode" >&2; exit 2; }
    echo "on" ;;
  --qa-result)
    [ -f "$S/qa-owed" ] || { echo "unsupported stub mode: $mode" >&2; exit 2; }
    cat "$S/qa-owed" ;;
  --qa-history)
    # Absent is the honest empty answer, exactly as the real engine gives for a
    # plan with no test-status.md — the runner reads it as "no rounds on file".
    [ -f "$S/qa-history" ] && cat "$S/qa-history"
    exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  # A phase's Size, which its session caps are derived from. M — the engine's
  # own default — unless a test set one.
  --size) if [ -f "$S/size-$arg" ]; then cat "$S/size-$arg"; else echo M; fi ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);

  // Mirrors the real script's shape: `status` is informational and always
  // exits 0, so the holder has to be read out of its output.
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
echo "$*" >> "$S/locks"
if [ "\${2:-}" = "claim" ] && [ -f "$S/claim-refuse" ]; then
  echo "phase \${3:-?} is being worked by someone/else"; exit 1
fi
if [ "\${2:-}" = "status" ]; then
  # The real script prints the holder for a LAPSED claim too, and appends the
  # marker. Both halves are the fake's job, because reading only the first is
  # the bug the runner had.
  if [ -f "$S/lock-spaced" ]; then echo "phase \${3:-?}: held by Ada Lovelace/laptop since now, lease until later [session: sess-ada]"
  elif [ -f "$S/lock-lapsed" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until then (EXPIRED — free to take over)"
  elif [ -f "$S/lock-refused" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until later"
  elif [ -f "$S/lock-refused-\${3:-}" ]; then echo "phase \${3:-?}: held by someone/else since now, lease until later"
  else echo "phase \${3:-?}: free"; fi
  exit 0
fi
exit 0
`);

  write(join(scripts, 'validate.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
if [ -f "$S/lint-fail" ]; then echo "VALIDATE FAIL stub"; exit 1; fi
echo "VALIDATE OK"
`);

  return {
    root, scripts, state,
    markDone: (phase) => writeFileSync(join(state, 'done'),
      `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    doneList: () => readFileSync(join(state, 'done'), 'utf8').split('\n').filter(Boolean).map(Number),
    setGate: (phase, text) => writeFileSync(join(state, `gate-${phase}`), `${text}\n`),
    setStuck: (phase) => writeFileSync(join(state, 'stuck'), `${phase}\n`),
    setInProgress: (phase) => writeFileSync(join(state, 'inprog'), `${phase}\n`),
    setParallel: (yes) => yes ? writeFileSync(join(state, 'parallel'), '') : rmSync(join(state, 'parallel'), { force: true }),
    setQaBlocked: (phase, verdict = 'fail') => {
      if (phase === null) { rmSync(join(state, 'qa-blocked'), { force: true }); return; }
      writeFileSync(join(state, 'qa-blocked'), String(phase));
      writeFileSync(join(state, 'qa-verdict'), verdict);
    },
    setQaOwed: (verdict) => {
      if (verdict === null) { rmSync(join(state, 'qa-owed'), { force: true }); return; }
      writeFileSync(join(state, 'qa-owed'), verdict);
    },
    setQaHistory: (rows) => {
      if (rows === null) { rmSync(join(state, 'qa-history'), { force: true }); return; }
      writeFileSync(join(state, 'qa-history'), rows);
    },
    setLockRefused: (yes) => yes ? writeFileSync(join(state, 'lock-refused'), '') : rmSync(join(state, 'lock-refused'), { force: true }),
    setLockRefusedFor: (phase, yes) => yes
      ? writeFileSync(join(state, `lock-refused-${phase}`), '')
      : rmSync(join(state, `lock-refused-${phase}`), { force: true }),
    setLockLapsed: (yes) => yes ? writeFileSync(join(state, 'lock-lapsed'), '') : rmSync(join(state, 'lock-lapsed'), { force: true }),
    setLockSpacedOwner: (yes) => yes ? writeFileSync(join(state, 'lock-spaced'), '') : rmSync(join(state, 'lock-spaced'), { force: true }),
    setClaimRefuse: (yes) => yes ? writeFileSync(join(state, 'claim-refuse'), '') : rmSync(join(state, 'claim-refuse'), { force: true }),
    setLintFail: (yes) => yes ? writeFileSync(join(state, 'lint-fail'), '') : rmSync(join(state, 'lint-fail'), { force: true }),
    setSlowBoard: (yes) => yes ? writeFileSync(join(state, 'slow-board'), '') : rmSync(join(state, 'slow-board'), { force: true }),
    setSlowGate: (yes) => yes ? writeFileSync(join(state, 'slow-gate'), '') : rmSync(join(state, 'slow-gate'), { force: true }),
    setSize: (phase, size) => writeFileSync(join(state, `size-${phase}`), `${size}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

/** A session that does what it was asked: marks its phase done, then exits. */
function workingSession(r: Repo, seen: number[] = []): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    seen.push(phase);
    r.markDone(phase);
    return ok();
  };
}

function runner(
  r: Repo,
  spawn: SpawnFn,
  verification: string | undefined = '`true`',
  phaseDefaults?: (slug: string, phase: number) => { model?: string; effort?: string } | undefined,
  extra: Partial<ConstructorParameters<typeof Runner>[0]> = {},
) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    phaseDefaults,
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

/** Records what each phase was actually asked to run as. */
function recordingSession(r: Repo, seen: { phase: number; model?: string; effort?: string; tools?: string[] }[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push({ phase, model: request.model, effort: request.effort, tools: request.tools });
    r.markDone(phase);
    return ok();
  };
}

/* ------------------------------------------------------------------ *
 * Extracting commands from real plan prose
 * ------------------------------------------------------------------ */

test('a continuation fragment is reported, never executed', () => {
  // Straight out of a real plan. Running `…` is nonsense,
  // and guessing what it continues would be worse than admitting we cannot.
  const text = 'targeted pytest + full safe set `… -m "not slow and not soak" -q` + `task audit:schema`.';
  const { commands, notRun } = extractCommands(text);
  assert.deepEqual(commands, ['task audit:schema']);
  assert.equal(notRun.length, 1);
  assert.match(notRun[0].reason, /continuation fragment/);
});

test('prose with no command at all is reported, not treated as nothing to do', () => {
  const { commands, notRun } = extractCommands('targeted pytest + safe set; both green.');
  assert.equal(commands.length, 0);
  assert.equal(notRun.length, 1, 'a requirement stated in English is still a requirement');
  assert.match(notRun[0].reason, /no command/);
});

test('paths and prose spans are not mistaken for commands', () => {
  const { commands, notRun } = extractCommands('see `docs/plans/demo.md` and `**Verification:**`');
  assert.deepEqual(commands, []);
  assert.equal(notRun.length, 2);
});

test('a mutating command is refused even when it is well-formed', () => {
  for (const text of ['`task infra:update`', '`git push origin main`', '`rm -rf build`', '`terraform apply`']) {
    const { commands, notRun } = extractCommands(text);
    assert.deepEqual(commands, [], text);
    assert.match(notRun[0].reason, /mutates|not a recognised/, text);
  }
});

test('a command that reaches outside the tree must be shown read-only, not merely innocent', () => {
  // The hole this closes: MUTATION_DENY is a denylist, and every one of these
  // sails straight past it while being a perfectly ordinary thing to write in
  // a Verification bullet. The runner then executes it, unattended.
  const dangerous = [
    '`curl -X POST https://api.example.com/deploy`',
    '`curl -d "release=1" https://api.example.com/hooks`',
    "`ssh box 'systemctl restart api'`",
    '`ssh box "rm -rf /srv/cache"`',
    `\`psql -c 'DELETE FROM orders WHERE id > 0'\``,
    '`docker compose up -d`',
    '`kubectl rollout restart deploy/api`',
    '`redis-cli flushall`',
  ];
  for (const text of dangerous) {
    const { commands, notRun } = extractCommands(text);
    assert.deepEqual(commands, [], text);
    assert.equal(notRun.length, 1, text);
    assert.match(notRun[0].reason, /person should run this|mutates/, text);
  }
});

test('the read-only shapes of those same verbs still run', () => {
  const safe = [
    'curl -sS https://example.com/health',
    'curl -X GET https://example.com/health',
    "psql -c 'SELECT count(*) FROM orders'",
    'docker ps',
    'docker logs api',
    'kubectl get pods',
    'ssh box',
    "ssh box 'systemctl is-active api'",
    'redis-cli ping',
  ];
  for (const command of safe) {
    const { commands } = extractCommands(`\`${command}\``);
    assert.deepEqual(commands, [command], `${command} is read-only and should still be run`);
  }
});

test('fenced blocks contribute every command line, comments excluded', () => {
  const { commands } = extractCommands('```bash\n# check it\nnpm test\n$ task lint\n```');
  assert.deepEqual(commands, ['npm test', 'task lint']);
});

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

test('verification runs the commands and reports them green', async () => {
  const summary = await verifyPhase('`true` and `echo hello`', { cwd: process.cwd() });
  assert.equal(summary.ok, true);
  assert.equal(summary.ran.length, 2);
});

test('verification stops at the first red and says which one', async () => {
  const summary = await verifyPhase('`true` then `false` then `echo never`', { cwd: process.cwd() });
  assert.equal(summary.ok, false);
  assert.equal(summary.ran.length, 3, 'stops rather than cascading — after one recorded retry of the red');
  assert.equal(summary.ran[1].retry, undefined, 'the first attempt is not the retry');
  assert.equal(summary.ran[2].retry, true, 'the retry is marked as such');
  assert.match(summary.reason, /`false` exited 1/);
  assert.equal(summary.notRun.at(-1)?.reason, 'skipped after an earlier command failed');
});

test('a command red once and green on retry verifies green, and says so', async () => {
  // The measured flake class: full suites red under load, green alone. One
  // recorded retry absorbs it; both attempts stay on the record.
  const dir = mkdtempSync(join(tmpdir(), 'pc-verify-retry-'));
  try {
    const flake = 'node -e "const fs=require(\'fs\'); if (fs.existsSync(\'m\')) process.exit(0); fs.writeFileSync(\'m\', \'\'); process.exit(1);"';
    const summary = await verifyPhase('`' + flake + '`', { cwd: dir });
    assert.equal(summary.ok, true, 'the last attempt is the verdict');
    assert.equal(summary.ran.length, 2);
    assert.equal(summary.ran[0].ok, false);
    assert.equal(summary.ran[1].retry, true);
    assert.match(summary.reason, /green on retry \(first exited 1\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a timed-out command is not retried', async () => {
  // A command that hangs once will hang twice, at up to half an hour a try.
  const summary = await verifyPhase('`node -e "setTimeout(() => {}, 5000)"`', { cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(summary.ok, false);
  assert.equal(summary.ran.length, 1, 'no second attempt for a kill');
  assert.equal(summary.ran[0].code, 124);
});

test('an aborted verification is never vacuously green', async () => {
  // Measured: a console shutdown mid-verify returned ok:true "0 commands
  // green" over three commands that never ran, and the phase settled done.
  const controller = new AbortController();
  controller.abort();
  const summary = await verifyPhase('`true` and `echo hi`', { cwd: process.cwd(), signal: controller.signal });
  assert.equal(summary.ok, false, 'nothing ran, nothing was proven');
  assert.match(summary.reason, /stopped mid-verification/);
  assert.equal(summary.ran.length, 0);
  assert.ok(summary.notRun.length >= 1);
  assert.ok(summary.notRun.every((n) => n.reason === 'the run was stopped before this command'));
});

test('a phase with no verification text is not silently verified', async () => {
  const summary = await verifyPhase(undefined, { cwd: process.cwd() });
  assert.equal(summary.ok, false);
  assert.match(summary.reason, /no verification/);
});

test('verification with only unrunnable fragments is not success', async () => {
  const summary = await verifyPhase('`… -q` only', { cwd: process.cwd() });
  assert.equal(summary.ok, false, 'zero commands run must never read as verified');
  assert.equal(summary.ran.length, 0);
});

/* ------------------------------------------------------------------ *
 * The child invocation
 * ------------------------------------------------------------------ */

test('the argv never carries a flag that removes the guard rails', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'sonnet', budgetUsd: 2 });
  assert.ok(!argv.includes('--bare'), '--bare skips settings, and with them the repo hooks');
  assert.ok(!argv.includes('--safe-mode'), '--safe-mode disables hooks, skills and plugins wholesale');
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.deepEqual(sanitize(['--bare', '-p', 'x', '--dangerously-skip-permissions']), ['-p', 'x']);
  assert.deepEqual(sanitize(['--allow-dangerously-skip-permissions', '--verbose']), ['--verbose']);
});

test('the CLI silently refusing bypass is detected, not left to look like a broken phase', async () => {
  // Measured against the CLI: `bypassPermissions` needs a disclaimer that can
  // only be accepted interactively, once, per machine. Without it Claude Code
  // does not error and does not honour the flag — it downgrades to `default`,
  // which in `-p` mode prompts a terminal that is not there and so refuses
  // every edit. A Bypass run on such a machine does LESS than a Guarded one,
  // and this line on stderr is the only signal that says why.
  const { isBypassDowngrade } = await import('../server/runner/spawn.ts');

  assert.equal(isBypassDowngrade(
    'Permission mode downgraded to default — bypass requires accepting the disclaimer interactively first',
  ), true);
  assert.equal(isBypassDowngrade('permission mode downgraded to default'), true, 'case is not a contract');
  assert.equal(isBypassDowngrade('everything is fine'), false);
  assert.equal(isBypassDowngrade(''), false);

  // The flag really is handed over — being refused downstream is exactly why
  // it has to be watched for rather than assumed to have taken effect.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions'], { allowBypass: true }),
    ['--permission-mode', 'bypassPermissions'],
  );
});

test('a forbidden flag takes its value with it', () => {
  // Dropping the flag alone left `user` loose in argv, where the CLI reads a
  // bare word as a positional prompt — so a stripped flag became a new task.
  assert.deepEqual(
    sanitize(['--setting-sources', 'user', '--verbose']),
    ['--verbose'],
  );
});

test('a forbidden permission mode is corrected, not removed', () => {
  // Removing `--permission-mode` entirely falls back to the interactive
  // default, which headless is a silent refusal of every edit: a fix that
  // quietly breaks every run is not a fix.
  assert.deepEqual(
    sanitize(['--permission-mode', 'bypassPermissions', '--verbose']),
    ['--permission-mode', 'acceptEdits', '--verbose'],
  );
  assert.deepEqual(sanitize(['--permission-mode', 'plan']), ['--permission-mode', 'plan']);
});

test('the argv asks for a streamed, budgeted, single-session run', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'opus', budgetUsd: 3, sessionId: 'abc' });
  // The prompt is NOT in argv: in streaming-input mode a positional prompt is
  // silently ignored, so passing it there would look right and run nothing.
  assert.ok(!argv.includes('hi'), 'the prompt goes down stdin, not argv');
  assert.ok(argv.includes('--print'));
  assert.ok(argv.includes('--verbose'), 'stream-json in print mode requires it');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(argv.includes('--replay-user-messages'), 'the only confirmation a message landed');
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'abc');
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '3');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('effort reaches the argv, and a bad one never does', () => {
  const good = buildArgv({ prompt: 'hi', cwd: '/tmp', effort: 'xhigh' });
  assert.equal(good[good.indexOf('--effort') + 1], 'xhigh');

  // The CLI only warns on an unknown value and carries on at its default, so
  // an unchecked typo runs a whole plan at the wrong effort and says nothing.
  const bad = buildArgv({ prompt: 'hi', cwd: '/tmp', effort: 'maximum' });
  assert.ok(!bad.includes('--effort'), 'a value the CLI would ignore is not sent at all');
});

test('the fallback chain is handed over so a limited model fails over in place', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', model: 'opus', fallbackModels: ['sonnet', 'haiku'] });
  assert.equal(argv[argv.indexOf('--fallback-model') + 1], 'sonnet,haiku');
});

test('the model chain demotes strongest-first and knows fable', () => {
  assert.equal(nextModel('fable'), 'opus');
  assert.equal(nextModel('opus'), 'sonnet');
  assert.equal(nextModel('haiku'), null, 'nothing below the cheapest');
  // A full model id must resolve too — that is what the CLI reports back.
  assert.equal(nextModel('claude-fable-5'), 'opus');
  assert.deepEqual(fallbackChain('opus'), ['sonnet', 'haiku']);
  assert.deepEqual(fallbackChain('haiku'), []);
  assert.deepEqual(fallbackChain('something-else'), [], 'an unknown model gets no guesses');
});

test('a user message is the NDJSON shape the CLI reads', () => {
  const parsed = JSON.parse(userMessage('hello'));
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.deepEqual(parsed.message.content, [{ type: 'text', text: 'hello' }]);
  assert.ok(userMessage('hello').endsWith('\n'), 'NDJSON needs the newline to be read at all');
});

test('resuming replaces the new-session id rather than sending both', () => {
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp', resume: 'old-session' });
  assert.equal(argv[argv.indexOf('--resume') + 1], 'old-session');
  assert.ok(!argv.includes('--session-id'), 'a session cannot be both new and resumed');
});

test('extra writable directories reach argv as ONE variadic --add-dir', () => {
  // `--add-dir <directories...>` collects until the next option, so a repeated
  // flag would replace rather than accumulate. One flag, every directory.
  const argv = buildArgv({ prompt: 'hi', cwd: '/tmp/lane', addDirs: ['/tmp/root', '/tmp/other'] });
  const at = argv.indexOf('--add-dir');
  assert.ok(at >= 0, 'the directories were requested and never passed');
  assert.equal(argv.filter((a) => a === '--add-dir').length, 1);
  assert.deepEqual(argv.slice(at + 1, at + 3), ['/tmp/root', '/tmp/other']);
});

test('a session with nothing extra to write composes the argv it always composed', () => {
  // The common spawn by far. A flag that appears empty-handed would be a
  // behaviour change for every run that never asked for one.
  for (const request of [
    { prompt: 'hi', cwd: '/tmp' },
    { prompt: 'hi', cwd: '/tmp', addDirs: [] },
    // A blank must never become a bare `--add-dir` that swallows the next flag.
    { prompt: 'hi', cwd: '/tmp', addDirs: ['', '  '] },
  ]) {
    assert.ok(!buildArgv(request).includes('--add-dir'), JSON.stringify(request));
  }
});

test('NDJSON split across arbitrary chunk boundaries still parses', () => {
  const lines: string[] = [];
  const reader = lineReader((line) => lines.push(line));
  const payload = '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n';
  for (const char of payload) reader.push(char); // the worst case: one byte at a time
  reader.flush();
  assert.deepEqual(lines.map((l) => JSON.parse(l).subtype), ['init', 'success']);
});

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

test('a fresh plan runs every phase, each in its own process', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.deepEqual(seen, [1, 2, 3], 'one session per phase, in dependency order');
  assert.equal(state.status, 'finished');
  assert.deepEqual(Object.values(state.phases).map((p) => p.status), ['done', 'done', 'done']);
  assert.ok(state.spentUsd > 0, 'cost is accumulated across phases');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Permission profiles
 * ------------------------------------------------------------------ */

test('the profile a run starts under reaches every one of its children', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'trusted',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['trusted', 'trusted', 'trusted']);
  assert.equal(instance.current()!.permissionProfile, 'trusted');
  r.cleanup();
});

test('a run with no profile is trusted, and writes that out', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.deepEqual(profiles, ['trusted', 'trusted', 'trusted']);
  // Written explicitly, unlike `guarded` below — the record must say what it is
  // rather than leave a reader to apply whatever the default happens to be now.
  assert.equal(instance.current()!.permissionProfile, 'trusted');
  r.cleanup();
});

test('`guarded` is the one profile written as an omission', async () => {
  // The compatibility rule the default flip must not break: absent means
  // guarded. A run file written before profiles existed has no field, and it has
  // to keep reading as the careful option however the default moves.
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    profiles.push(request.permissionProfile);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'guarded',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['guarded', 'guarded', 'guarded']);
  assert.equal(instance.current()!.permissionProfile, undefined);
  r.cleanup();
});

test('switching profile mid-run is journaled, and the next phase runs under it', async () => {
  const r = repo();
  const profiles: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    profiles.push(request.permissionProfile);
    // Widen it from underneath the run, the way an operator does when the
    // third `git commit` card of the night arrives.
    if (phase === 1) instance.configure({ permissionProfile: 'trusted' }, 'someone@desk');
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spy);
  // Started `guarded` explicitly: the widening is the thing under test, so the
  // run has to begin somewhere narrower than the default now is.
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', permissionProfile: 'guarded',
  });
  await instance.wait();

  assert.deepEqual(profiles, ['guarded', 'trusted', 'trusted'], 'it applies from the next phase');

  // "Who widened this run, and when" has to be answerable later without
  // reading a diff of the whole settings patch.
  const journal = new Journal(r.root, 'demo', instance.current()!.id).read(200);
  const switched = journal.find((line) => line.event === 'run.permission-profile');
  assert.ok(switched, 'the switch has its own journal line');
  assert.equal(switched!.data.from, 'guarded');
  assert.equal(switched!.data.to, 'trusted');
  assert.equal(switched!.data.by, 'someone@desk');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Parking
 * ------------------------------------------------------------------ */

test('an unanswered approval parks the run rather than failing it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  // What the timeout path does: the hook was told no — silence would fail open
  // — and the run is parked so the phase is not treated as having gone wrong.
  const parked = instance.park('an approval went unanswered: Bash — git commit -m x', 2, 'awaiting-person');
  assert.equal(parked, true);

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt!.reason, /unanswered/);
  assert.equal(state.halt!.phase, 2);
  assert.equal(state.halt!.kind, 'awaiting-person', 'a person was asked and did not answer (WAI-10)');
  assert.equal(state.consecutiveFailures, 0, 'nobody being awake is not the work failing');

  const journal = new Journal(r.root, 'demo', state.id).read(200);
  assert.ok(journal.some((line) => line.event === 'run.parked'));
  r.cleanup();
});

test('every session runs under the run\'s own lock identity', async () => {
  // PE_OWNER is how a lock the session claims gets attributed to this run, so
  // the runner can release it afterwards and a second console can see who is
  // working the phase.
  const r = repo();
  const envs: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    envs.push(request.env?.PE_OWNER);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const owner = `autopilot/${instance.current()!.id}`;
  assert.deepEqual(envs, [owner, owner, owner], 'every session runs as the lock holder');

  // And the runner releases under that same identity.
  const calls = readFileSync(join(r.state, 'locks'), 'utf8');
  assert.ok(calls.includes(`release 1 --owner ${owner}`), `released as someone else:\n${calls}`);
  r.cleanup();
});

test('a half-finished plan resumes at the phase that is left', async () => {
  const r = repo();
  r.markDone(1);
  r.markDone(2);
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.deepEqual(seen, [3], 'the done-set decides; there is no cursor to get wrong');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

test('a session that claims success but writes nothing halts the run', async () => {
  const r = repo();
  // The failure this whole design exists to catch: the process exits 0, the
  // result says "done", and the board still says the phase is not done.
  const liar: SpawnFn = async () => ok({ resultText: 'Phase complete!' });
  const { instance } = runner(r, liar);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  // `no-handoff` is PHASE-level: the phase is settled with its reason and the
  // run parks with nothing left to run, instead of halting and draining every
  // sibling lane a bigger plan would have had in flight.
  assert.equal(state.status, 'parked');
  assert.match(state.phases['1'].halt!.reason, /the board still reads/);
  assert.equal(r.doneList().length, 0, 'nothing was advanced on the session\'s word');
  r.cleanup();
});

test('a red verification over a complete handoff records the verdict and does not halt', async () => {
  // The reversal of "a red verification halts before the board is even
  // consulted", and deliberate: eight production halts in one night were each
  // dissolved by reconcile sixty seconds later, because the session had
  // written a complete handoff and the board — the one authority on done —
  // had already overtaken the verdict. The board's word now stands at once;
  // the red verification travels on the record instead of stopping the run.
  const r = repo();
  const { instance, events } = runner(r, workingSession(r), '`false`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.notEqual(state.status, 'halted', 'the board vouched for the phase; no halt');
  assert.equal(state.phases['1'].status, 'done');
  assert.equal(state.phases['1'].verification?.ok, false, 'the red verdict is not erased');
  assert.match(state.phases['1'].note ?? '', /Verification is red/);
  assert.ok(
    journalled(events, 'phase.verify-overtaken').length > 0,
    'the retraction-in-advance is journalled',
  );
  assert.equal(
    journalled(events, 'run.halt').filter((h) => h.kind === 'verify-failed').length, 0,
    'no phantom verify-failed halt',
  );
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Where the verification commands run
 * ------------------------------------------------------------------ */

/** A runner that also knows the plan's `**Verify in:**` for every phase. */
function verifyInRunner(r: Repo, spawn: SpawnFn, verification: string, verifyIn: string | undefined) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => verification,
    verifyIn: () => verifyIn,
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

/** The payloads of every journal line with this name — `emit` nests them one deep. */
const journalled = (
  events: { event: string; data: Record<string, unknown> }[], name: string,
) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('verification runs where the plan says, and the run records where that was', async () => {
  // It ran with cwd = the root the console was opened on. In a monorepo that is
  // the superproject, so one real plan's `docker compose run … -v "$PWD:/app"`
  // mounted the WHOLE monorepo into the container and hung there. The plan knew
  // which directory it meant; it had no way to say so.
  const r = repo();
  mkdirSync(join(r.root, 'services', 'api'), { recursive: true });

  const { instance } = verifyInRunner(r, workingSession(r), '`pwd`', 'services/api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.verifiedIn, 'services/api', 'the run says where it verified');
  assert.match(record.verification!.ran[0].output!, /services\/api$/,
    'and the command really ran there — this is `pwd` reporting for itself');
  r.cleanup();
});

test('a Verify in: that escapes the root is refused, and the refusal is journalled', async () => {
  // The plan file is editable by anyone who can open the repo, so this is a
  // boundary rather than a typo check: `../../etc` is not a directory this
  // console gets to run commands in, whatever a plan says.
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`pwd`', '../../etc');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.verifiedIn, '.', 'it fell back to the root rather than failing the phase');
  const refusals = journalled(events, 'phase.verify-in-missing');
  assert.ok(refusals.length >= 1, 'a verification that ran somewhere else must never be silent');
  assert.match(String(refusals[0].reason), /outside the repository root/);
  r.cleanup();
});

test('a Verify in: naming a directory that is not there falls back, loudly', async () => {
  // The worst case for silence: a path that named a directory when the plan was
  // written and does not now. bash would inherit the parent's cwd and nobody
  // would be told which tree had actually been verified.
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`pwd`', 'services/api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].verifiedIn, '.');
  assert.match(
    String(journalled(events, 'phase.verify-in-missing')[0].reason),
    /no such directory/,
  );
  r.cleanup();
});

/** A runner that knows both the plan's `Verify in:` and its Repos column. */
function hintRunner(r: Repo, repos: string[] | undefined, verifyIn?: string) {
  // A session that writes its handoff: the board vouches, so under the
  // board-first rule the red verification records instead of halting — and
  // the hint these tests pin now travels on the record's note, because a
  // hint that only ever rode the retracted halt would never reach the
  // person who should add `**Verify in:**` to the plan.
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: workingSession(r),
    verificationText: () => '`false`',
    verifyIn: () => verifyIn,
    phaseRepos: () => repos,
  });
  return instance;
}

test('a failed verification suggests the Repos column\'s directory — as a hint, never a cwd', async () => {
  // A silently-chosen directory that happens to be wrong verifies the wrong tree
  // and reports GREEN, which is worse than the failure it papers over. So the
  // console says what it noticed and a person writes it into the plan.
  const r = repo();
  mkdirSync(join(r.root, 'packages', 'cart-api'), { recursive: true });

  const instance = hintRunner(r, ['cart-api']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.verification?.ok, false, 'it is still a failure, not a suggestion');
  const note = record.note ?? '';
  assert.match(note, /Verification is red/, 'the verdict travels on the record');
  assert.match(note, /Repos column names `cart-api`/);
  assert.match(note, /- \*\*Verify in:\*\* packages\/cart-api/, 'names the bullet to add, and where');
  assert.equal(record.verifiedIn, '.',
    'and it still ran at the root — the hint changed nothing about this run');
  r.cleanup();
});

test('no hint when the plan already says where to verify', async () => {
  const r = repo();
  mkdirSync(join(r.root, 'packages', 'cart-api'), { recursive: true });
  const instance = hintRunner(r, ['cart-api'], 'packages/cart-api');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.doesNotMatch(instance.current()!.phases['1'].note ?? '', /Repos column/,
    'the plan has answered — repeating the question would be contradicting it');
  r.cleanup();
});

test('no hint when the answer would be a guess', async () => {
  // Two repos: the plan must choose. Two matching directories: so must a person.
  // A repo named in the plan with no directory at all: nothing to suggest.
  for (const [repos, dirs] of [
    [['cart-api', 'cart-web'], [['packages', 'cart-api'], ['packages', 'cart-web']]],
    [['api'], [['services', 'api'], ['vendor', 'api']]],
    [['api'], []],
    [undefined, [['services', 'api']]],
  ] as [string[] | undefined, string[][]][]) {
    const r = repo();
    for (const parts of dirs) mkdirSync(join(r.root, ...parts), { recursive: true });

    const instance = hintRunner(r, repos);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();

    assert.doesNotMatch(
      instance.current()!.phases['1'].note ?? '',
      /Repos column/,
      `guessed for repos=${JSON.stringify(repos)} dirs=${JSON.stringify(dirs)}`,
    );
    r.cleanup();
  }
});

test('verification commands get half an hour, stated rather than defaulted', async () => {
  // At `verify.ts`'s 15-minute default a slow-but-green suite came back red and
  // halted a phase that had done nothing wrong. A phase's verification is a full
  // suite, often a build, sometimes a container — but still bounded, because a
  // wedged command has to end.
  const r = repo();
  const seen: (number | undefined)[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: workingSession(r),
    verificationText: () => '`true`',
    verify: async (_text, opts) => {
      seen.push(opts.timeoutMs);
      return { ok: true, reason: '1 command green', ran: [], notRun: [] };
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.ok(seen.length > 0, 'verification ran');
  for (const ms of seen) assert.equal(ms, 30 * 60_000);
  r.cleanup();
});

test('a plan that says nothing verifies at the root, and says so', async () => {
  const r = repo();
  const { instance, events } = verifyInRunner(r, workingSession(r), '`true`', undefined);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].verifiedIn, '.');
  assert.equal(journalled(events, 'phase.verify-in-missing').length, 0,
    'saying nothing is not a mistake — only a path that cannot be honoured is');
  assert.equal(String(journalled(events, 'phase.verify')[0].cwd), '.',
    'the journal line carries the effective cwd either way');
  r.cleanup();
});

test('a plan left failing validate.sh halts even when the phase verified', async () => {
  const r = repo();
  r.setLintFail(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.match(instance.current()!.halt!.reason, /validate\.sh/);
  r.cleanup();
});

test('a closed human gate holds that phase as gated and stops rather than forcing it', async () => {
  const r = repo();
  r.setGate(1, 'manual: the operator must approve the deploy');
  // The console's word for the `gates` row is `operator` here — the shipped
  // default is `delegated` since 5.0.0 (phase 11), and this case is about the
  // person's path.
  const { instance } = runner(r, workingSession(r), '`true`', undefined, { delegateHumanGates: () => false });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'gated');
  assert.equal(state.status, 'parked', 'nothing else is ready, so the run parks');
  assert.match(state.phases['1'].note!, /the operator must approve/);
  assert.equal(r.doneList().length, 0);
  r.cleanup();
});

test('an ai-clearable gate does not park — the session is booted to clear it', async () => {
  const r = repo();
  r.setGate(1, 'ai: verify staging deploy and smoke tests');
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'done',
    "the unclear ai gate is the session's first task, not a wall");
  assert.equal(state.phases['1'].gate?.kind, 'ai');
  assert.ok(r.doneList().includes(1));
  r.cleanup();
});

test('the runner opts into cmd-gate execution (PHASE_EXEC_GATES=1)', async () => {
  const r = repo();
  writeFileSync(join(r.state, 'gate-echo-env'), '');
  const { instance } = runner(r, workingSession(r), '`true`', undefined, { delegateHumanGates: () => false });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'gated');
  assert.match(state.phases['1'].note ?? '', /exec=1/,
    'the gate evaluation must see the opt-in the engine documents');
  r.cleanup();
});

test('a lock held elsewhere parks the phase instead of racing for it', async () => {
  const r = repo();
  r.setLockRefused(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].status, 'parked');
  assert.match(instance.current()!.phases['1'].note!, /locked by someone\/else/);
  r.cleanup();
});

test('a LAPSED claim does not park the phase — it just runs', async () => {
  // `phase-lock.sh status` prints `held by X` for an expired claim too and
  // appends `(EXPIRED — free to take over)`. The runner used to read only the
  // first half, so a session that died without releasing parked its phase for
  // the whole lease — and then forever after, since nothing renews a dead
  // claim. A lease running out is exactly the event that means "go".
  const r = repo();
  r.setLockLapsed(true);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.notEqual(instance.current()!.phases['1'].status, 'parked');
  assert.ok(r.doneList().length > 0, 'the phase actually ran');
  r.cleanup();
});

test('the runner reads the lock, then claims it PROVISIONALLY under its own owner (S1-a)', async () => {
  // This used to assert the runner never claimed at all. The reason was real:
  // claiming first deadlocked two live runs, because the session then read a
  // lock owned by a stranger and — correctly, per the skill's own guardrail —
  // refused the phase. What changed is the owner. The session runs as
  // `autopilot/<runId>`, the same string this claim uses, so its own claim is a
  // same-owner claim, which `phase-lock.sh` treats as a refresh.
  //
  // What the old rule cost: between the grant and the child's first claim there
  // was NO lock on disk, for a process spawn and two preflights, while
  // `phase-lock.sh conflicts` scans files — so a hand session asking in that
  // window was told "safe to start" against a lane that was booting.
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const owner = `autopilot/${instance.current()!.id}`;
  const calls = readFileSync(join(r.state, 'locks'), 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.some((c) => c.includes(' status ')), 'it must still check first');
  const claims = calls.filter((c) => c.includes(' claim '));
  assert.ok(claims.length > 0, `it must claim the window:\n${calls.join('\n')}`);
  assert.ok(claims.every((c) => c.includes(`--owner ${owner}`)),
    `and only ever as itself, so its own session refreshes rather than refusing:\n${claims.join('\n')}`);
  r.cleanup();
});

test('an expired login stops the run instead of failing every phase the same way', async () => {
  const r = repo();
  const loggedOut: SpawnFn = async () => ok({
    signal: { subtype: 'error_during_execution', code: 1, text: 'Please run /login' },
    costUsd: 0,
  });
  const { instance } = runner(r, loggedOut);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  // RUN-level since phase 9 (RCV-1): the wall is the run's credential, and a
  // phase-level park handed the loop its next candidate into the same wall.
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.kind, 'credential-refused');
  assert.match(state.halt!.reason, /authentication/);
  assert.equal(state.phases['1'].status, 'parked');
  assert.equal(state.phases['1'].cause?.kind, 'credential-refused');
  assert.equal(state.phases['1'].cause?.class, 'auth');
  assert.equal(state.phases['1'].attempts, 1, 'no point retrying a wall');
  assert.equal(state.consecutiveFailures, 1, 'the wall counts toward the streak (RCV-1)');
  assert.equal(state.errand?.situation, 'resource-wall:auth', 'the one errand is the run\'s');
  r.cleanup();
});

test('a model-only limit moves down the ladder and carries on', async () => {
  const r = repo();
  const models: string[] = [];
  const limited: SpawnFn = async (request) => {
    models.push(request.model!);
    if (request.model === 'opus') {
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text: "You've hit your Opus limit · resets 3:45pm", model: 'opus' } });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited);
  await instance.start({ slug: 'demo', root: r.root, model: 'opus', autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(models[0], 'opus');
  assert.equal(models[1], 'sonnet', 'switched rather than slept');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

/* ---------------- accounts at the usage wall ---------------- */

const PLAN_LIMIT_TEXT = "You've hit your session limit · resets 3:45pm";

test('policy `switch`: a plan limit moves to the other account and continues WITHOUT sleeping', async () => {
  const r = repo();
  const spawns: { env?: NodeJS.ProcessEnv; resume?: string }[] = [];
  const limited: SpawnFn = async (request) => {
    spawns.push({ env: request.env, resume: request.resume });
    if (spawns.length === 1) {
      // A reset an hour out: the wait path would sleep on it, so the ONLY way
      // this test finishes promptly is the switch path continuing immediately.
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${epoch}` },
        sessionId: 'sess-lim',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-lim' });
  };
  const marked: { accountId?: string; window: string }[] = [];
  const { instance } = runner(r, limited, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    pickAccount: () => 'spare',
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: (accountId, leaving) => {
      marked.push({ ...(accountId ? { accountId } : {}), window: leaving.bucket ?? 'none' });
      return leaveStub(accountId, leaving);
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });

  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished', 'the switch path must not sit out the old account’s window');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.accountId, 'spare', 'the run now names the account that paid');
  assert.equal(spawns[1].env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-spare', 'the very next spawn runs as it');
  assert.equal(spawns[1].resume, 'sess-lim', 'the ported transcript is resumed, not restarted');
  assert.deepEqual(marked, [{ window: 'five_hour' }], 'the wall is remembered against the account that hit it');
  r.cleanup();
});

test('policy `switch` without a transcript port starts fresh instead of resuming into nothing', async () => {
  const r = repo();
  const resumes: (string | undefined)[] = [];
  const limited: SpawnFn = async (request) => {
    resumes.push(request.resume);
    if (resumes.length === 1) {
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${epoch}` },
        sessionId: 'sess-lost',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',
    portTranscript: () => ({ findable: false, ported: false, why: 'not found' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished');
  assert.equal(resumes[1], undefined, 'no port means a fresh boot prompt, never --resume into a missing file');
  r.cleanup();
});

test('policy `pause`: a plan limit checkpoints the phase and stops for a person', async () => {
  const r = repo();
  let calls = 0;
  const limited: SpawnFn = async () => {
    calls++;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: PLAN_LIMIT_TEXT },
      sessionId: 'sess-paused',
    });
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',   // available, and deliberately not taken
    // Pinned before 3:45pm: against the real clock this test flipped at
    // 3:45pm local, when "resets 3:45pm" starts meaning TOMORROW — more than
    // 12h away, which classify() parks for a person instead of pausing.
    now: () => new Date('2026-01-01T13:00:00'),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(calls, 1, 'nothing is retried past the wall');
  assert.equal(state.status, 'paused');
  assert.ok(state.waitUntil, 'the reset time stays visible for the banner and the re-arm');
  assert.equal(state.waitReason, 'usage-limit', 'and the banner is told which wait this is');
  assert.match(state.finishedReason ?? '', /usage limit/i);
  const record = state.phases['1'];
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'sess-paused', 'Continue resumes the checkpointed session');
  // D17 — the POLICY stopped this run, and the record must say so. Left unset,
  // `stoppedByOperator`'s pre-field heuristic reads `paused` as somebody's
  // press, and convergence reported "the operator stopped it — pinned until
  // they continue it" about a run nobody had touched.
  assert.equal(state.stoppedBy, 'system', 'a policy stop is the system\'s, not a person\'s');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The live wall — `onLimit` applied to a child that has not exited
 * ------------------------------------------------------------------ */

/**
 * The measured failure these pin. A session hit the five-hour wall at 0.97
 * utilization and entered the CLI's own retry watchdog, which retried every
 * thirty seconds and never exited. `state.onLimit` was read in exactly one
 * place — after `await spawn(…)` resolves — so `switch`, the policy whose
 * whole purpose is that wall, was unreachable for that wall. Every assertion
 * below is made while the child is still live, which is the point.
 */
const rateLimited = (attempt: number): StreamEvent =>
  ({ kind: 'retry', category: 'rate_limit', attempt, detail: 'API Error: 429' });

test('policy `switch` fires from the STREAM, on a child that has not exited', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    pickAccount: () => 'spare',
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-walled', model: 'stub-1', tools: 0 });

  // Two is under the debounce: one unlucky 429 the watchdog absorbs must never
  // cost a live session.
  held.say(rateLimited(1));
  clock.wind(30_000);
  held.say(rateLimited(2));
  assert.equal(instance.current()!.accountId, undefined, 'two retries is a blip, not a wall');

  clock.wind(30_000);
  held.say(rateLimited(3));

  // ...and the third acts, with the child still very much alive.
  const state = instance.current()!;
  assert.equal(state.accountId, 'spare', 'the run moved to the account that can pay');
  const record = state.phases['1'];
  assert.equal(record.status, 'pending', 'the phase is checkpointed, not failed');
  assert.equal(record.resumeSessionId, 'sess-walled', 'and the next attempt resumes the same session');
  assert.match(record.note ?? '', /rate limited mid-session/);

  held.release();
  await instance.wait();
  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.live-wall"/);
  assert.match(journal, /"action":"switch"/);
  r.cleanup();
});

test('one real event between retries resets the debounce — the burst has to be consecutive', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now, pickAccount: () => 'spare', portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;

  // Nine retries, but the watchdog gets through after every second one, which
  // is what an absorbed blip looks like rather than a wall.
  for (let i = 0; i < 3; i++) {
    held.say(rateLimited(1));
    clock.wind(10_000);
    held.say(rateLimited(2));
    clock.wind(10_000);
    held.say({ kind: 'step', tools: 1 });
    clock.wind(10_000);
  }
  assert.equal(instance.current()!.accountId, undefined, 'work between retries is not a wall');

  held.release();
  await instance.wait();
  r.cleanup();
});

test('policy `pause`: a wall on a live child parks the run with the reset time on it', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    pickAccount: () => 'spare',   // available, and deliberately not taken
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-paused-live', model: 'stub-1', tools: 0 });

  // The CLI's own structured verdict arrives first and carries the reset.
  const resets = Math.floor(Date.parse('2026-08-22T15:00:00Z') / 1000);
  held.say({ kind: 'limits', status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: resets });
  clock.wind(20_000);
  held.say(rateLimited(1));
  clock.wind(20_000);
  held.say(rateLimited(2));

  const state = instance.current()!;
  assert.equal(state.status, 'paused', 'pause keeps its word, even mid-session');
  assert.equal(state.accountId, undefined, 'and it does NOT switch — that is what pause means');
  assert.equal(state.waitUntil, new Date(resets * 1000).toISOString(), 'the reset survives for the banner');
  assert.match(state.finishedReason ?? '', /usage limit hit mid-session/);
  assert.equal(state.phases['1'].resumeSessionId, 'sess-paused-live');

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.status, 'paused', 'and the loop does not carry on past it');
  r.cleanup();
});

test('a warning heartbeat is not a wall — an account at 97% is still working', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now, pickAccount: () => 'spare', portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;

  for (let i = 0; i < 5; i++) {
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.97 });
    clock.wind(10_000);
  }
  assert.equal(instance.current()!.accountId, undefined,
    '`allowed_warning` means the requests are still going through');

  held.release();
  await instance.wait();
  r.cleanup();
});

test('nowhere better to go means the session is left exactly as it was', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    // No second account. Killing a child that has nowhere to move to only
    // loses work — it may still succeed on the watchdog's next attempt.
    pickAccount: () => undefined,
  });
  const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  for (let i = 1; i <= 4; i++) { held.say(rateLimited(i)); clock.wind(20_000); }

  const state = instance.current()!;
  assert.equal(state.status, 'running', 'the run is not parked over a wall it cannot answer');
  assert.equal(state.phases['1'].status, 'running', 'and the phase is not checkpointed');

  held.release();
  await instance.wait();
  // ...but the run's own record says the console SAW it and had no move, which
  // is the difference between a policy that never fired and one that found the
  // door shut.
  const journal = readFileSync(journalFile(r.root, 'demo', started.id), 'utf8');
  assert.match(journal, /"action":"none"/);
  r.cleanup();
});

test('the run’s account env reaches every spawn', async () => {
  const r = repo();
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const watching: SpawnFn = async (request) => {
    envs.push(request.env);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, watching, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'work'
      ? { CLAUDE_CONFIG_DIR: '/tmp/work-profile' } : null),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();

  assert.ok(envs.length >= 1);
  for (const env of envs) {
    assert.equal(env?.CLAUDE_CONFIG_DIR, '/tmp/work-profile');
    assert.ok(env?.PE_OWNER, 'the run-specific facts still ride on top');
  }
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

test('a budget cap resumes the same session rather than restarting the phase', async () => {
  const r = repo();
  const resumes: (string | undefined)[] = [];
  const capped: SpawnFn = async (request) => {
    resumes.push(request.resume);
    if (resumes.length === 1) {
      return ok({ signal: { subtype: 'error_max_budget_usd', code: 1, text: '' }, sessionId: 'sess-abc' });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-abc' });
  };
  const { instance } = runner(r, capped, '`true`');
  await instance.start({ slug: 'demo', root: r.root, phaseBudgetUsd: 2, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(resumes[0], undefined, 'the first attempt is a fresh session');
  assert.equal(resumes[1], 'sess-abc', 'the second continues it, keeping the work already done');
  r.cleanup();
});

test('an incomplete verification stops the cautious run and not the eager one', async () => {
  const text = '`true` plus `… -q`'; // one runnable, one fragment
  for (const [autonomy, expected] of [['halt-on-everything', 'parked'], ['keep-going', 'finished']] as const) {
    const r = repo();
    const { instance } = runner(r, workingSession(r), text);
    await instance.start({ slug: 'demo', root: r.root, autonomy });
    await instance.wait();
    assert.equal(instance.current()!.status, expected, autonomy);
    if (autonomy === 'halt-on-everything') {
      // This used to mark the phase `done` and halt with "N steps need a
      // person" — a dead end, because nothing on the page could then tell the
      // runner that a person had looked. The fragment now becomes a question,
      // and a question with nobody to ask is a halt that says so. This harness
      // deliberately has no approval broker; the answered path lives in
      // verify-signoff.test.ts.
      assert.equal(instance.current()!.phases['1'].status, 'awaiting-verification',
        'the phase is waiting on a person, which is neither done nor failed');
      assert.match(instance.current()!.phases['1'].halt!.reason, /no way to ask/);
    }
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Surviving a console restart
 * ------------------------------------------------------------------ */

test('a run interrupted mid-phase parks instead of re-running a half-done phase', async () => {
  const r = repo();
  // A checkpoint left behind by a console that died: a child that is now gone.
  const stale = newRun({ slug: 'demo', root: r.root });
  stale.child = { pid: 999_999, phase: 1, sessionId: 'sess-x', startedAt: new Date().toISOString() };
  stale.phases['1'] = { phase: 1, status: 'running', attempts: 1, costUsd: 0.5 };
  saveRun(stale);

  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'interrupted');
  assert.match(state.phases['1'].note!, /console stopped/);
  assert.equal(state.status, 'parked', 'a phase that may have half-committed needs a person');
  r.cleanup();
});

test('a child that outlived the console blocks the run rather than doubling up', async () => {
  const r = repo();
  const stale = newRun({ slug: 'demo', root: r.root });
  // Our own pid: alive, guaranteed, and nothing to clean up afterwards.
  stale.child = { pid: process.pid, phase: 1, sessionId: 'sess-y', startedAt: new Date().toISOString() };
  saveRun(stale);

  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt!.reason, /still running \(pid/);
  assert.equal(r.doneList().length, 0, 'two agents must never edit one tree');
  r.cleanup();
});

/**
 * autopilot-5 — "let it finish" is the one thing a frozen orphan cannot do.
 *
 * `adopt` classified every recorded child as alive whenever `processState`
 * said anything but `gone` — which includes `stopped`. So a session the
 * operator had SIGSTOPped, whose console then died, was described as "still
 * running … let it finish or stop it": advice nobody can take, because nothing
 * is scheduling it and the console that would have continued it is gone. It
 * also stamped the phase `running`, a claim about a process the kernel was
 * not running. `reconcileRun` had had the frozen/running split for a release;
 * `orphanAdvice` is now the one composer both reach.
 */
test('an adopted FROZEN orphan is told how to continue it, not to wait for it (autopilot-5)', async () => {
  const r = repo();
  const stale = newRun({ slug: 'demo', root: r.root });
  // Our own pid — alive, guaranteed — flagged the way a console records a
  // freeze it performed before it died.
  stale.child = {
    pid: process.pid, phase: 1, sessionId: 'sess-frozen',
    startedAt: new Date().toISOString(), frozen: true,
  };
  saveRun(stale);

  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.halt!.kind, 'orphaned-session');
  assert.match(state.halt!.reason, /was frozen by the operator/);
  assert.match(state.halt!.reason, new RegExp(`kill -CONT ${process.pid}`),
    'the advice is a command a person can actually run');
  assert.doesNotMatch(state.halt!.reason, /Let it finish/,
    'a stopped process will never finish on its own');
  // And the phase does not claim to be working.
  assert.equal(state.phases['1'].status, 'interrupted');
  assert.match(state.phases['1'].note ?? '', /frozen by the operator/);
  assert.equal(r.doneList().length, 0, 'two agents must never edit one tree');
  r.cleanup();
});

test('the checkpoint is on disk and readable after the run', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const id = instance.current()!.id;
  const reloaded = loadRun(r.root, 'demo', id);
  assert.ok(reloaded, 'a crash must be able to find this');
  assert.equal(reloaded.status, 'finished');
  assert.equal(listRuns(r.root, 'demo').length, 1);
  r.cleanup();
});

test('the journal records the sequence a person would ask about', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const entries = new Journal(r.root, 'demo', instance.current()!.id).read();
  const events = entries.map((e) => e.event);
  for (const expected of ['run.start', 'phase.start', 'phase.session', 'phase.verify', 'phase.done', 'run.finished']) {
    assert.ok(events.includes(expected), `journal is missing ${expected}`);
  }
  assert.ok(entries.every((e, i) => e.seq === i + 1), 'the sequence has no gaps');
  r.cleanup();
});

test('a second run on the same plan is refused while one is in flight', async () => {
  const r = repo();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  const slow: SpawnFn = async (request) => {
    // Only the first phase blocks — the rest must be free to finish, or the
    // test deadlocks on phase 2 rather than on the thing it is checking.
    if (!held) {
      held = true;
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, slow);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // start() returns as soon as the loop is driving, which is before the first
  // child exists. Releasing a session that has not begun would deadlock.
  await inSession;

  await assert.rejects(
    () => instance.start({ slug: 'demo', root: r.root }),
    /already in progress/,
    'two loops in one working tree is a merge conflict with extra steps',
  );

  release();
  await instance.wait();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Pausing
 * ------------------------------------------------------------------ */

/**
 * A session that blocks on its first phase until it is released, so a test can
 * act on a run while a phase is genuinely in flight.
 */
function heldSession(r: Repo, seen: number[] = []) {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    if (!held) {
      held = true;
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  return { spawn, inSession, release: () => release(), seen };
}

test('an armed pause names the phase it is waiting for, and stops at the boundary', async () => {
  const r = repo();
  const held = heldSession(r);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.pause('tester'), true, 'a live run can be paused');
  const armed = instance.current()!;
  assert.equal(armed.status, 'pausing');
  assert.equal(armed.pause?.afterPhase, 1, 'the operator is told which phase has to finish first');
  assert.equal(armed.pause?.by, 'tester');

  held.release();
  await instance.wait();

  const after = instance.current()!;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause, null, 'a pause that has arrived is no longer pending');
  assert.equal(after.phases['1'].status, 'done', 'the phase in flight was finished, not cut off');
  assert.deepEqual(held.seen, [1], 'and phase 2 was never started');
  r.cleanup();
});

test('a cancelled pause lets the run carry on', async () => {
  const r = repo();
  const held = heldSession(r);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  instance.pause();
  assert.equal(instance.resumePause(), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.pause, null);

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.status, 'finished', 'the cancelled pause did not stop it');
  assert.deepEqual(held.seen, [1, 2, 3]);
  r.cleanup();
});

test('a pause armed while the board is being read starts no phase at all', async () => {
  // The reported defect, reproduced at its actual cause. `drive` read the pause
  // flag once at the top of the loop and then awaited `board()` — a
  // `phase-graph.sh` subprocess — before spawning. A Pause pressed inside that
  // gap was set a few hundred milliseconds after the only line that read it, so
  // the next phase started anyway and the operator watched the thing they had
  // just stopped begin new work.
  const r = repo();
  const seen: number[] = [];
  r.setSlowBoard(true);
  const { instance } = runner(r, workingSession(r, seen));

  // `start` returns as soon as the loop is driving; the first board read is
  // still in flight, which is exactly the window this is about.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(seen, [], 'the board read has not finished, so nothing has started yet');

  assert.equal(instance.pause('tester'), true);
  await instance.wait();

  assert.deepEqual(seen, [], 'no phase was spawned after the pause was armed');
  assert.equal(instance.current()!.status, 'paused');
  assert.equal(instance.current()!.pause, null, 'a pause that has arrived is no longer pending');
  r.cleanup();
});

test('thawing a frozen session does not take back a pause that was already armed', async () => {
  // Pause, then Freeze, then Continue. `thaw` wrote `running` unconditionally,
  // which silently discarded a request the operator had already made and never
  // took back — Cancel pause is the control for that, and they did not press it.
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.pause('tester'), true);
  assert.equal(instance.freeze('tester'), true, 'freezing a run that is already pausing still works');
  assert.equal(instance.current()!.pause?.by, 'tester', 'the pause request outlives the freeze');

  assert.equal(instance.thaw(), true);
  assert.equal(instance.current()!.status, 'pausing', 'still pausing — thaw is not Cancel pause');
  assert.notEqual(procState(pid), 'T', 'and the child is scheduled again');

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.status, 'paused');
  r.cleanup();
});

test('pausing a run nothing is driving reports that it did nothing', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  // The exact condition that made the Pause button answer 200 and do nothing:
  // no loop behind the run. The runner now says so instead of returning
  // silently, which is what lets the service fall through to the checkpoint.
  assert.equal(instance.pause(), false, 'no loop is driving anything to pause');
  assert.equal(instance.resumePause(), false);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.equal(instance.pause(), false, 'and a finished run has nothing to pause either');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Asking a running phase something
 * ------------------------------------------------------------------ */

test('a question reaches the session that is running, framed so it cannot redirect it', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({
        pid: 1,
        open: () => true,
        send: (text: string) => { sent.push(text); return true; },
        setFrozen: () => {},
      });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  const asked = instance.ask('why did you skip the cache?');
  assert.equal(asked.ok, true);
  // The tag is what correlates this write with the CLI's echo of it and with
  // the session's eventual reply. Without one the console can only guess which
  // sentence in an hour of output was the answer.
  assert.match(asked.mark!, /^ask:[0-9a-f]{8}$/);
  assert.equal(sent.length, 1);
  // The frame is what keeps a question a question. Dropped in bare, text from
  // the operator outranks almost everything in a phase's context and reads as
  // a change of direction.
  assert.match(sent[0], /out-of-band question/i);
  assert.match(sent[0], /continue exactly where you left off/i);
  assert.match(sent[0], /Question: why did you skip the cache\?$/);
  assert.ok(sent[0].includes(`[[${asked.mark}]]`), 'the tag travels with the question');

  release();
  await instance.wait();
  r.cleanup();
});

test('ACC-8.9 (TRS-6): an operator\'s question and the session\'s reply are a pair on the journal — phase.asked, then phase.answered {question, options, chosen, by, ms}, once', async () => {
  const r = repo();
  let onEvent: ((event: StreamEvent) => void) | undefined;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      onEvent = request.onEvent;
      request.onHandle?.({ pid: 1, open: () => true, send: () => true, setFrozen: () => {} });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;
  const runId = instance.current()!.id;

  const asked = instance.ask('why did you skip the cache?', 'someone@desk');
  assert.equal(asked.ok, true);
  // The session replies, opening with the tag it was asked to — twice, as a
  // session re-quoting its own answer would.
  onEvent?.({ kind: 'answer', text: 'because the cache was cold', mark: asked.mark! });
  onEvent?.({ kind: 'answer', text: 'because the cache was cold (again)', mark: asked.mark! });
  // A steer's acknowledgement is not an answer, and a mark nobody asked pairs with nothing.
  onEvent?.({ kind: 'answer', text: 'ack', mark: 'steer:0badc0de' });
  onEvent?.({ kind: 'answer', text: 'stray', mark: 'ask:0badc0de' });

  release();
  await instance.wait();
  const lines = new Journal(r.root, 'demo', runId).read();
  const answered = lines.filter((line) => line.event === 'phase.answered');
  assert.equal(answered.length, 1, 'one answer per question');
  const data = answered[0].data as Record<string, unknown>;
  assert.equal(data.question, 'why did you skip the cache?');
  assert.deepEqual(data.options, [], 'a free-text question offers no options');
  assert.equal(data.chosen, 'because the cache was cold');
  assert.equal(data.by, 'session');
  assert.equal(data.askedBy, 'someone@desk');
  assert.equal(data.mark, asked.mark);
  assert.equal(typeof data.ms, 'number');
  assert.equal(answered[0].phase, 1);
  const order = lines.map((line) => line.event).filter((event) => event === 'phase.asked' || event === 'phase.answered');
  assert.deepEqual(order, ['phase.asked', 'phase.answered']);
  r.cleanup();
});

test('ACC-8.11 (QRL-9): the spawn door gives every session of a relay-off run --permission-prompts none, an ARMED relay-on run none of it, and a known-old CLI a warning line instead', async () => {
  for (const [relay, version, flagged, refused] of [
    [undefined, undefined, true, false],
    ['off', '2.1.271', true, false],
    ['last-resort', '2.1.271', false, false],
    ['off', '2.1.200', false, true],
  ] as const) {
    const r = repo();
    const seen: (string | undefined)[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push(request.permissionPrompts);
      r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
      return ok();
    };
    // A relay-on run is armed only on an init version the console has READ
    // (phase 14) — so the relay-on row states one.
    const { instance } = runner(r, spawn, '`true`', undefined, {
      ...(version ? { cliVersion: async () => version } : {}),
      ...(relay === 'last-resort' ? { initVersion: () => version ?? null } : {}),
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', ...(relay ? { relay } : {}) } as never);
    await instance.wait();
    const label = `relay ${relay ?? 'absent'} on ${version ?? 'an unknown CLI'}`;
    assert.ok(seen.length >= 1, `${label}: sessions spawned`);
    assert.ok(seen.every((value) => value === (flagged ? 'none' : undefined)), `${label}: ${JSON.stringify(seen)}`);
    const lines = new Journal(r.root, 'demo', instance.current()!.id).read()
      .filter((line) => line.event === 'run.permission-prompts-skipped');
    assert.equal(lines.length, refused ? 1 : 0, `${label}: said once per run, or not at all`);
    if (refused) assert.deepEqual(lines[0].data, { version: '2.1.200', floor: '2.1.259', relay: 'off' });
    r.cleanup();
  }
});

test('ACC-8.11 (AC-13, QRL-5): the relay arms at the spawn door only on an init version read at or above the floor — the host and no floor flag when armed, the floor and run.relay-refused when not, and a session\'s own init arms the next', async () => {
  const { RELAY_HOST_TOOL } = await import('../server/relay-host.ts');
  const r = repo();
  const seen: { phase: number; prompts?: string; tool?: string; doc?: { mcpServers: Record<string, { type: string; args: string[] }> } }[] = [];
  const noted: string[] = [];
  let reported: string | null = null;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    // Read while the session lives: the run sweeps its MCP documents when its loop ends.
    seen.push({
      phase, prompts: request.permissionPrompts, tool: request.permissionPromptTool,
      ...(request.mcpConfig ? { doc: JSON.parse(readFileSync(request.mcpConfig, 'utf8')) } : {}),
    });
    // Every session prints its init; the first one teaches the console its CLI.
    request.onEvent?.({
      kind: 'init', sessionId: `s${phase}`, version: '2.1.270',
      toolNames: request.permissionPromptTool ? ['Bash', 'AskUserQuestion'] : ['Bash'],
      mcpServers: request.permissionPromptTool ? [{ name: 'pcrelay', status: 'connected' }] : [],
    });
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`', undefined, {
    cliVersion: async () => '2.1.270',
    initVersion: () => reported,
    noteCliInit: (version: string) => { noted.push(version); reported = version; },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', relay: 'last-resort' } as never);
  await instance.wait();
  assert.ok(seen.length >= 2, JSON.stringify(seen));
  assert.deepEqual({ prompts: seen[0].prompts, tool: seen[0].tool }, { prompts: 'none', tool: undefined },
    'the first session: no version read yet — the floor, never the host');
  assert.deepEqual({ prompts: seen[1].prompts, tool: seen[1].tool }, { prompts: undefined, tool: RELAY_HOST_TOOL },
    'the next: armed by what the first session\'s init said');
  const doc = seen[1].doc!;
  assert.equal(seen[0].doc, undefined, 'a session on the floor gets no document it did not ask for');
  assert.equal(doc.mcpServers.pcrelay.type, 'stdio', 'the presence-only host rides the session\'s MCP set');
  assert.match(doc.mcpServers.pcrelay.args[0], /relay-host\.(ts|js)$/);
  assert.deepEqual(noted.slice(0, 1), ['2.1.270']);
  const lines = new Journal(r.root, 'demo', instance.current()!.id).read();
  const refused = lines.filter((line) => line.event === 'run.relay-refused');
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0].data, { version: null, floor: '2.1.268', reason: 'version-unknown' });
  const armed = lines.filter((line) => line.event === 'run.relay-armed');
  assert.equal(armed.length, 1, 'once per change, not once per session');
  assert.deepEqual(armed[0].data, { version: '2.1.270', floor: '2.1.268' });
  assert.equal(instance.current()!.relayArming?.armed, true);
  assert.ok(!lines.some((line) => line.event === 'run.relay-degraded'), 'the host was connected and the tool offered');
  r.cleanup();
});

test('ACC-8.4 (TRS-2): an armed session\'s own init is read at the door — below the floor refuses the relay, a missing AskUserQuestion or a host not connected is journalled — and a control_request and a defer go on the journal', async () => {
  const r = repo();
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onEvent?.({ kind: 'init', sessionId: 's1', version: '2.1.271', toolNames: ['Bash'], mcpServers: [{ name: 'pcrelay', status: 'failed' }] });
      request.onEvent?.({ kind: 'control-request', requestId: 'req_9', subtype: 'can_use_tool', tool: 'AskUserQuestion' });
      request.onEvent?.({ kind: 'deferred', toolUseId: 'toolu_kept', tool: 'AskUserQuestion' });
    }
    if (phase === 2) request.onEvent?.({ kind: 'init', sessionId: 's2', version: '2.1.260', toolNames: ['Bash', 'AskUserQuestion'] });
    r.markDone(phase);
    return ok();
  };
  let version = '2.1.271';
  const { instance } = runner(r, spawn, '`true`', undefined, {
    initVersion: () => version,
    noteCliInit: (read: string) => { version = read; },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', relay: 'last-resort' } as never);
  await instance.wait();
  const lines = new Journal(r.root, 'demo', instance.current()!.id).read();
  const degraded = lines.filter((line) => line.event === 'run.relay-degraded');
  assert.deepEqual(degraded.map((line) => line.data?.reason).sort(), ['host-not-connected', 'tool-absent']);
  assert.equal(degraded.find((line) => line.data?.reason === 'host-not-connected')?.data?.status, 'failed', 'read from mcp_servers, not the exit code');
  const refused = lines.filter((line) => line.event === 'run.relay-refused');
  assert.equal(refused.length, 1, 'phase 2\'s own init said 2.1.260');
  assert.deepEqual(refused[0].data, { version: '2.1.260', floor: '2.1.268', reason: 'below-floor' });
  assert.equal(instance.current()!.relayArming?.armed, false);
  const control = lines.find((line) => line.event === 'phase.control-request');
  assert.deepEqual(control?.data, { requestId: 'req_9', subtype: 'can_use_tool', tool: 'AskUserQuestion' });
  assert.equal(control?.phase, 1);
  assert.deepEqual(lines.find((line) => line.event === 'phase.tool-deferred')?.data, { toolUseId: 'toolu_kept', tool: 'AskUserQuestion' });
  r.cleanup();
});

test('ACC-8.16 (QRL-6): the session is told the relay\'s answer down its own stdin, in the plan\'s exact sentence, tagged — and it writes no phase.asked', async () => {
  const { frameRelayAnswer } = await import('../server/runner/runner-core.ts');
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (text: string) => { sent.push(text); return true; }, setFrozen: () => {} });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;
  const told = instance.tellRelayAnswer(1, [
    { question: 'Which colour should the banner be?', label: 'Blue (Recommended)', by: 'recommended' },
    { question: 'Which port?', label: '8080', by: 'rule', ruleId: 'ports' },
  ]);
  assert.equal(told.ok, true);
  assert.equal(sent.length, 1, 'one message for the call');
  assert.match(sent[0], /^\[\[relay:[0-9a-z]{8}\]\] /, 'tagged, so its echo is recognised');
  const sentence = frameRelayAnswer('Blue (Recommended)', 'its (Recommended) option', 'ambiguity');
  assert.equal(sentence, 'No operator answered within 60 s. The console answered `Blue (Recommended)` by `its (Recommended) option`. '
    + 'This is NOT a change to the phase. If that answer is wrong, declare `blocked --needs ambiguity` rather than asking again.');
  assert.ok(sent[0].includes(sentence), 'the exact framing sentence');
  assert.ok(sent[0].includes(frameRelayAnswer('8080', 'relay rule ports', 'ambiguity')));
  assert.match(sent[0], /Question: Which colour should the banner be\?/);
  release();
  await instance.wait();
  const lines = new Journal(r.root, 'demo', instance.current()!.id).read();
  assert.ok(!lines.some((line) => line.event === 'phase.asked'), 'a notice is not an operator\'s question');
  r.cleanup();
});

test('the same idempotency key is one write, however many times it is posted', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; }, setFrozen: () => {} });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  // A double click, a retried fetch, a phone that reconnected mid-request —
  // the server cannot tell any of those from two real questions unless told.
  const first = instance.ask('is the cache warm?', 'console', 'dup-key-0001');
  const again = instance.ask('is the cache warm?', 'console', 'dup-key-0001');
  assert.equal(first.ok, true);
  assert.equal(again.ok, true, 'a repeat is a success — the caller did nothing wrong');
  assert.equal(again.repeated, true, 'and it says so');
  assert.equal(again.mark, first.mark, 'the same message, so the same correlation');
  assert.equal(sent.length, 1, 'exactly one write reached stdin');

  // A different key is a different question and does get through.
  assert.equal(instance.ask('and the second one?', 'console', 'dup-key-0002').ok, true);
  assert.equal(sent.length, 2);

  release();
  await instance.wait();
  r.cleanup();
});

test('Steer is an instruction, and the journal records it as one', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; }, setFrozen: () => {} });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;
  const runId = instance.current()!.id;

  const steered = instance.steer('use the existing helper rather than a new one');
  assert.equal(steered.ok, true);
  assert.match(steered.mark!, /^steer:[0-9a-f]{8}$/);
  assert.equal(sent.length, 1);
  // The opposite framing to Ask, and it has to be: a message that opens "this
  // is NOT a change to the phase" is useless for telling a phase to change.
  assert.match(sent[0], /course correction/i);
  assert.match(sent[0], /this IS an instruction/i);
  // And the honest part — steering does not talk a phase past its gate.
  assert.match(sent[0], /verification commands still decide/i);
  assert.match(sent[0], /Instruction: use the existing helper rather than a new one$/);

  release();
  await instance.wait();

  // Two event names, so a journal can explain a phase that changed direction.
  const events = new Journal(r.root, 'demo', runId).read().map((e) => e.event);
  assert.ok(events.includes('phase.steered'), 'steering has its own event name');
  assert.ok(!events.includes('phase.asked'), 'and is not recorded as a question');
  r.cleanup();
});

test('an empty or oversized question is refused before it is sent anywhere', async () => {
  const r = repo();
  const sent: string[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      request.onHandle?.({ pid: 1, open: () => true, send: (t: string) => { sent.push(t); return true; }, setFrozen: () => {} });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  assert.equal(instance.ask('   ').ok, false);
  assert.equal(instance.ask('x'.repeat(9_000)).ok, false);
  assert.equal(sent.length, 0);

  release();
  await instance.wait();
  r.cleanup();
});

test('asking when nothing is running says so rather than swallowing it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  const before = instance.ask('anyone there?');
  assert.equal(before.ok, false);
  assert.match(before.reason!, /nothing is running/);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const after = instance.ask('and now?');
  assert.equal(after.ok, false, 'a finished run has no session to ask');
  assert.match(after.reason!, /nothing is running to ask/);
  r.cleanup();
});

test('steering a settled lane is refused, and the refusal names steering', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));

  const before = instance.steer('use the existing helper');
  assert.equal(before.ok, false, 'there is no lane to steer before the run starts');
  assert.match(before.reason!, /nothing is running to steer/);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  // The case the UI has to get right: the lane SETTLED, so the console must
  // stop offering to steer it. A refusal is the server half of that; the
  // client half is `AskBox`'s `enabled`, which is driven by the same fact.
  const after = instance.steer('and now?');
  assert.equal(after.ok, false, 'a settled lane cannot be steered');
  // Worded for the act. "nothing is running to ask" — the old shared string —
  // told an operator who pressed Steer that the console had heard Ask.
  assert.match(after.reason!, /nothing is running to steer/);
  assert.doesNotMatch(after.reason!, /to ask/);

  // Refused BEFORE anything is written, so a settled lane never gets a mark
  // the console would then wait for an echo of.
  assert.equal(after.mark, undefined);
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Freezing the phase itself
 * ------------------------------------------------------------------ *
 *
 * Signals against a real process, because the claim being tested is an
 * operating-system one: is the child actually stopped? A fake that records
 * "freeze was called" would pass while the session carried on writing files,
 * which is the exact failure this control exists to prevent.
 */

/**
 * A session whose child is a real, long-lived process we can signal.
 *
 * `finishes` is what separates the two scenarios: a thawed session goes on to
 * write its handoff, and a checkpointed one was stopped before it could — so
 * the second must NOT mark its phase done, or Continue finds nothing to resume
 * and quietly runs the next phase instead.
 */
function realChildSession(r: Repo, onPid: (pid: number) => void, finishes = true): {
  spawn: SpawnFn; inSession: Promise<void>; release: () => void; pid: () => number;
} {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let child: ReturnType<typeof spawnProcess> | null = null;
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
      onPid(child.pid!);
      request.onPid?.(child.pid!);
      request.onHandle?.({ pid: child.pid!, open: () => true, send: () => true, setFrozen: () => {} });
      // A real session announces its id in the first message it sends, which is
      // the only reason anything can act on a live session at all.
      request.onEvent?.({ kind: 'init', sessionId: 'session-to-resume-0001', model: 'stub-1', tools: 0 });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (!finishes) return { ...ok(), sessionId: 'session-to-resume-0001' };
    }
    r.markDone(phase);
    return { ...ok(), sessionId: 'session-to-resume-0001' };
  };

  return { spawn, inSession, release: () => release(), pid: () => child?.pid ?? 0 };
}

/* ------------------------------------------------------------------ *
 * Liveness: is the lane that is nominally working actually working?
 * ------------------------------------------------------------------ */

/**
 * A session held open with its event sink captured, so the ticker can be
 * driven against a live lane. The clock is the runner's own `deps.now`, so
 * ten minutes of silence costs a test nothing.
 */
function streamingSession(r: Repo, markDone = true) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    entered();
    await held;
    if (markDone) r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  return {
    spawn, inSession,
    release: () => release(),
    say: (event: StreamEvent) => sink?.(event),
  };
}

/**
 * A `repo()` that is also a real git checkout, because "did this attempt change
 * anything" is a question only the tree can answer.
 *
 * The base commit is dated years ago so it can never fall inside an attempt's
 * own `--since` window, and the stub's own scratch directories are ignored so
 * a session marking its phase done does not read as work on disk.
 */
function gitRepo(): Repo {
  const r = repo();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: r.root, env });
  writeFileSync(join(r.root, '.gitignore'), 'scripts/\n.stub/\n');
  execFileSync('git', ['add', '-A'], { cwd: r.root, env });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: r.root, env });
  return r;
}

/** A fake clock the test winds by hand, shaped as `RunnerDeps.now`. */
function fakeClock(from = '2026-08-22T10:00:00Z') {
  const state = { at: Date.parse(from) };
  return {
    now: () => new Date(state.at),
    wind: (ms: number) => { state.at += ms; },
  };
}

const livenessEvents = (events: { event: string; data: Record<string, unknown> }[]) =>
  events.filter((e) => e.event === 'run:liveness')
    .map((e) => e.data as { phase: number; stall: { signal?: string; detail?: string } | null });

test('a lane that goes quiet is reported ONCE, and clears the moment it speaks again', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  held.say({ kind: 'tool', id: 'toolu_a', name: 'Bash', summary: 'npm test -- --run' });

  // One minute in. The floor is ten, and a lane that is merely thinking is not
  // a card — this is the assertion that keeps the feature from crying wolf.
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.deepEqual(livenessEvents(events), []);

  clock.wind(10 * 60_000);
  await instance.tickLiveness();
  const first = livenessEvents(events);
  assert.equal(first.length, 1);
  assert.equal(first[0].phase, 1);
  assert.equal(first[0].stall?.signal, 'silent');
  // The call open longest is usually the whole answer.
  assert.match(String(first[0].stall?.detail), /oldest open tool call is Bash/);

  // Five minutes more of the same silence. One episode, one card: the ticker
  // runs every minute and a signal that is still true is not news.
  clock.wind(5 * 60_000);
  await instance.tickLiveness();
  assert.equal(livenessEvents(events).length, 1, 'a still-true signal must not re-announce');

  // ...and then it comes back.
  held.say({ kind: 'tool-result', id: 'toolu_a', ok: true, detail: '40 tests passed' });
  await instance.tickLiveness();
  const after = livenessEvents(events);
  assert.equal(after.length, 2);
  assert.equal(after[1].stall, null, 'clearing is an event too — the card has to come down');

  held.release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.equal((journal.match(/"phase\.stall"/g) ?? []).length, 1, 'one line per episode, not per tick');
  assert.match(journal, /"phase\.liveness"/);
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The external wait — a lane squatting a lock on somebody else's clock
 * ------------------------------------------------------------------ */

/**
 * The measured failure these pin. `local-ci-fast-feedback` phase 6 sat 35+
 * minutes inside two concurrent `until … sleep` loops waiting on a GitHub
 * Actions build, while holding `scope=all` — an exclusive claim on the entire
 * hub tree. Nothing could see it from any angle the console had: no stream
 * event arrives while a Bash call is open, and the lock's own lease keepalive
 * refreshed the claim every ten minutes on a timer, so the claim looked
 * healthy. That one lock blocked two other pieces of work for the window.
 *
 * The skill already documents the answer and the session simply did not take
 * it. These prove the console now takes it on the session's behalf: **the
 * waiting is fine, the squatting is not**, and the difference is the lock.
 */
test('a lane inside a poll loop is parked, and its lock is let go', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-waiting', model: 'stub-1', tools: 0 });
  held.say({
    kind: 'tool', id: 'toolu_wait', name: 'Bash',
    summary: 'until [ "$(gh run view 42 -q .status)" = completed ]; do sleep 45; done',
  });

  // Three minutes in: a call in flight like any other. A build that takes four
  // minutes must not cost anyone their session.
  clock.wind(3 * 60_000);
  await instance.tickLiveness();
  assert.deepEqual(livenessEvents(events), [], 'a short wait is just a call in flight');
  assert.equal(state.phases['1'].status, 'running');

  // Past the threshold, it is a squat.
  clock.wind(3 * 60_000);
  await instance.tickLiveness();
  const seen = livenessEvents(events);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stall?.signal, 'external-wait');
  assert.match(String(seen[0].stall?.detail), /until .*; do/);

  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'waiting', 'the phase parks rather than failing or carrying on');
  assert.ok(record.parkedUntil, 'and it says when it will come back');
  assert.match(record.parkReason ?? '', /waiting on an external clock inside the turn/);
  // The context that knows what it was waiting for is the context that should
  // read the answer — the same rule a declared `waiting-external` follows.
  assert.equal(record.resumeSessionId, 'sess-waiting');
  assert.match(String(record.watch?.[0]), /gh run view 42/);

  held.release();
  await instance.wait();

  // The run itself, not only the record. This is the assertion whose absence
  // let the automatic park diverge from the declared one for a whole release:
  // the park wrote `waiting` on the RECORD and broke the drive loop before any
  // branch wrote a run status, so the checkpoint on disk read `running` with
  // nothing driving it — and the next read reconciled that into `interrupted`,
  // blaming a console crash that never happened. The declared-outcome park
  // test asserts exactly these two fields; the two paths end the same way or
  // one of them is lying.
  const parked = instance.current()!;
  assert.equal(parked.status, 'waiting', 'the RUN waits with the phase — it is not left claiming `running`');
  assert.equal(parked.waitUntil, record.parkedUntil, 'and the run carries the phase-s park clock');
  assert.equal(parked.halt, null, 'a park is not a halt');
  assert.equal(parked.stoppedBy, 'system', 'the system parked it, so converge may pick it up again');

  // The whole point. A park that kept the claim would fix the accounting and
  // none of the harm.
  const locks = readFileSync(join(r.state, 'locks'), 'utf8');
  assert.ok(locks.includes(`release 1 --owner autopilot/${state.id}`),
    `the squatted lock was never released:\n${locks}`);

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.external-wait"/);
  assert.match(journal, /"phase\.waiting"/);
  // The command is on the record, because "a lane was waiting" without saying
  // on what is not something anyone can act on later.
  assert.match(journal, /gh run view 42/);
  r.cleanup();
});

/**
 * The same signal, the other clock (R26).
 *
 * The park above is right for somebody else's CI and wrong for the commonest
 * case by far: a session watching its OWN suite. Measured: 26
 * checkpoint→park→`--resume` cycles at a median of 70 minutes each, every one
 * of them taking a lane away from a machine that was doing exactly what it had
 * been asked to do and then running the same 40 minutes again.
 *
 * So a local wait is nudged first — the session IS working, it has just put
 * the waiting inside the turn — and parked only once even a long local job has
 * had its time.
 */
test('a lane watching its OWN job is nudged, not parked, and only parked much later', async () => {
  const r = repo();
  const s = silentSession(r, { attempts: 1 });
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  s.say({
    kind: 'tool', id: 'toolu_local', name: 'Bash',
    summary: 'until [ -f /tmp/suite.done ]; do sleep 30; done',
  });

  // Past the external-wait clock. An external wait would already be parked.
  // O6: the signal opens at stallExternalWaitMs (5 min), but the wait
  // procedure grants this session ten — so nothing is said yet.
  clock.wind(6 * 60_000);
  await instance.tickLiveness();
  assert.equal(
    instance.current()!.phases['1'].stallRemedy?.localNudges ?? 0, 0,
    'never nudged inside the allowance the console itself gave it',
  );
  
  clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
  await instance.tickLiveness();
  const nudged = instance.current()!.phases['1'];
  assert.equal(nudged.stall?.signal, 'external-wait');
  assert.equal(nudged.stall?.scope, 'local', 'the command says whose clock this is');
  assert.equal(nudged.status, 'running', 'it is working — taking the lane away would throw that away');
  assert.equal(nudged.stallRemedy?.localNudges, 1);
  assert.ok(nudged.stallRemedy?.localNudgedAt, 'the rung is on the record, not only in the journal');
  assert.equal(s.sent.length, 1, 'one nudge, into the stdin that is already open');
  assert.match(s.sent[0], /background/);
  // The local ladder has its OWN counter: a rung spent here must not read as a
  // rung spent by the silent watchdog, or either could silence the other.
  assert.equal(nudged.stallRemedy?.nudges ?? 0, 0);

  // Still inside the local budget: told once, and left alone.
  clock.wind(10 * 60_000);
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].status, 'running');
  assert.equal(s.sent.length, 1, 'the nudge is a rung, not a heartbeat');

  // Past it. At this point the distinction has stopped paying.
  clock.wind(40 * 60_000);
  await instance.tickLiveness();
  const parked = instance.current()!.phases['1'];
  assert.equal(parked.status, 'waiting');
  // And the park carries the loop's OWN landing condition, so the lane comes
  // back when the job is genuinely done rather than at the end of a guessed
  // window.
  assert.equal(parked.watch?.[0], 'cmd:"test -f /tmp/suite.done"');

  s.gates[0].release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.auto-nudged"/);
  assert.match(journal, /"phase\.external-wait"/);
  r.cleanup();
});

/**
 * The park must not depend on the nudge having landed (QA round 2's M5), and
 * the refusal must be said once rather than every tick (its L6).
 *
 * A refused `steer()` counts no rung — correctly, because a ledger recording a
 * write that never happened is the record lying. Gating rung 2 on that ledger
 * therefore made the park unreachable for a lane whose stdin had closed, and
 * `external-wait` outranks `silent`, so the silent ladder could not rescue it
 * either. Before the local/external split existed, that lane parked at five
 * minutes; after it, it waited for ever.
 */
test('a local wait whose nudge is refused still parks, and says so once', async () => {
  const r = repo();
  const s = silentSession(r, { attempts: 1, openStdin: false });
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  s.say({
    kind: 'tool', id: 'toolu_local', name: 'Bash',
    summary: 'until [ -f /tmp/suite.done ]; do sleep 30; done',
  });

  clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
  await instance.tickLiveness();
  assert.equal(s.sent.length, 0, 'the child refused the write');
  assert.equal(instance.current()!.phases['1'].stallRemedy?.localNudges ?? 0, 0,
    'and no rung was counted for a nudge that never happened');
  assert.equal(instance.current()!.phases['1'].status, 'running');

  // Several more ticks inside the budget: the refusal is ONE journal line, not
  // one per minute for as long as the call stays open.
  clock.wind(60_000); await instance.tickLiveness();
  clock.wind(60_000); await instance.tickLiveness();

  // Past the local budget it parks anyway — the age of the CALL is the clock,
  // never the nudge ledger.
  clock.wind(45 * 60_000);
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].status, 'waiting',
    'a lane that could not be nudged must still be let go of');

  s.gates[0].release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.equal((journal.match(/"phase\.auto-nudge-refused"/g) ?? []).length, 1,
    'one line per episode, not one per tick');
  r.cleanup();
});

/**
 * "Once per episode" has to mean per EPISODE (QA round 2's L6, unpinned
 * through rounds 3 and 4): the latch is cleared when the stall clears, so a
 * lane whose wait returned and later opened another gets a second line. Two
 * episodes on one lane, two lines — and with the clearing deleted, one.
 */
test('the refusal latch is per episode — a second wait on the same lane is said again', async () => {
  const r = repo();
  const s = silentSession(r, { attempts: 1, openStdin: false });
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  s.say({ kind: 'tool', id: 'toolu_one', name: 'Bash', summary: 'until [ -f /tmp/a ]; do sleep 30; done' });
  clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].stall?.signal, 'external-wait', 'episode one');

  // The call returns: the episode is over, and the latch with it.
  s.say({ kind: 'tool-result', id: 'toolu_one', ok: true, detail: 'done' });
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].stall, undefined, 'the episode cleared');

  // A second wait, minutes later, is a second episode.
  s.say({ kind: 'tool', id: 'toolu_two', name: 'Bash', summary: 'until [ -f /tmp/b ]; do sleep 30; done' });
  clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].stall?.signal, 'external-wait', 'episode two');

  s.gates[0].release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.equal((journal.match(/"phase\.auto-nudge-refused"/g) ?? []).length, 2,
    'two episodes, two lines — the latch clears with the episode');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The silent-session watchdog — D20 / D21
 * ------------------------------------------------------------------ */

/**
 * A session that boots, prints its init frame, and then says nothing — the
 * incident this watchdog exists for, reproduced.
 *
 * Two properties the older fixtures do not have:
 *
 *   - **it reports a HANDLE**, because writing to a live session's stdin IS the
 *     nudge, and `streamingSession` never calls `onHandle` — a lane with no
 *     handle refuses every steer, which would make the whole ladder untestable;
 *   - **it reports NO pid**, deliberately. `checkpointLane` runs a real kill
 *     ladder against `lane.pid`, and the only pid a test process can honestly
 *     offer is its own. A fixture that handed one over SIGTERMed the test
 *     runner mid-file once already, and it presented as a collapsed test count
 *     rather than as a failure.
 *
 * One gate per attempt, so a recycle's re-board can be driven and settled
 * separately from the attempt it replaced.
 */
function silentSession(
  r: Repo,
  opts: {
    attempts?: number; silentPhase?: number; openStdin?: boolean; announceSession?: boolean;
  } = {},
) {
  const attempts = opts.attempts ?? 2;
  const silentPhase = opts.silentPhase ?? 1;
  // `openStdin: false` is the session that has stopped accepting input between
  // the tick and the write — the refusal path.
  const openStdin = opts.openStdin ?? true;
  // `announceSession: false` is the lane that wedges BEFORE the CLI's own init
  // frame, so the phase never learns a session id at all.
  const announceSession = opts.announceSession ?? true;
  const gates = Array.from({ length: attempts }, () => {
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    return { held, entered, release: () => release(), enter: () => enter() };
  });
  const sent: string[] = [];
  let sink: ((event: StreamEvent) => void) | undefined;
  let n = 0;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    // Every other phase is an ordinary working session, so a test can prove the
    // run keeps driving its OTHER lanes while this one is being dealt with.
    if (phase !== silentPhase) { r.markDone(phase); return ok(); }
    const gate = gates[Math.min(n, gates.length - 1)];
    n += 1;
    sink = request.onEvent;
    request.onHandle?.({
      pid: undefined,
      open: () => openStdin,
      send: (text: string) => { if (!openStdin) return false; sent.push(text); return true; },
      setFrozen: () => {},
    });
    // The init frame and nothing else — exactly what a wedged boot looks like,
    // and what gives the phase a session id to be resumed on.
    if (announceSession) {
      request.onEvent?.({ kind: 'init', sessionId: 'sess-silent', model: 'stub-1', tools: 0 });
    }
    gate.enter();
    await gate.held;
    return announceSession ? ok({ sessionId: 'sess-silent' }) : ok({ sessionId: undefined });
  };
  return { spawn, gates, sent, spawned: () => n, say: (event: StreamEvent) => sink?.(event) };
}

test('a lane silent before its first tool call is nudged, then recycled on its own session', async () => {
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  // Nine minutes of nothing is a session thinking. The floor is ten, and a
  // watchdog that killed a session for booting slowly would be the bug.
  clock.wind(9 * 60_000);
  await instance.tickLiveness();
  assert.deepEqual(s.sent, [], 'nothing acts before the silent threshold');

  // Ten. The signal fires and, for the first time, something consumes it.
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'the console writes to the session, the way an operator would');
  assert.match(s.sent[0], /Supervisor check/);
  const nudged = instance.current()!.phases['1'];
  assert.equal(nudged.status, 'running', 'a nudge does not end anything');
  assert.equal(nudged.stallRemedy?.nudges, 1);
  assert.equal(nudged.stallRemedy?.recycles, 0, 'the ledger counts RUNGS, and only one has been climbed');
  assert.ok(nudged.stallRemedy?.nudgedAt, 'the nudge is on the record, not only in the journal');
  assert.ok(!nudged.stallRemedy?.recycledAt, 'and the recycle has NOT happened yet');

  // Four more minutes of the same silence: one nudge per episode, and the
  // grace has not run out. This is the assertion that keeps the ladder from
  // becoming a stream of messages into a session that cannot read them.
  clock.wind(4 * 60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'one nudge per episode, however many ticks go by');
  assert.ok(!instance.current()!.phases['1'].stallRemedy?.recycledAt);

  // Five. The nudge did not wake it, so the session is recycled.
  clock.wind(60_000);
  await instance.tickLiveness();
  const recycled = instance.current()!.phases['1'];
  assert.ok(recycled.stallRemedy?.recycledAt, 'the second remedy fired');
  assert.equal(recycled.status, 'pending', 'the phase goes back to the queue, it does not fail');
  assert.equal(recycled.resumeSessionId, 'sess-silent', 'and the SESSION is kept — this is a resume');
  assert.equal(recycled.stall, undefined, 'the card is retracted with the session it was about');
  assert.equal(
    events.filter((e) => e.event === 'run:watchdog').map((e) => e.data.action).join(','),
    'nudged,recycled',
    'both acts are on the wire, in order',
  );

  // The lock and its lease are untouched: this is the same phase, still held by
  // the same run. A recycle that dropped the claim would hand the tree to
  // somebody else between the kill and the re-board.
  const locks = readFileSync(join(r.state, 'locks'), 'utf8');
  assert.ok(!locks.includes('release 1'), `the recycle let go of the phase lock:\n${locks}`);

  // …and the ordinary drive loop re-boards it. Nothing bespoke: the killed
  // child settles, `carryOn` is true, and the loop does what it always does.
  s.gates[0].release();
  await s.gates[1].entered;
  assert.equal(s.spawned(), 2, 'the phase was re-boarded');
  s.gates[1].release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.auto-nudged"/);
  assert.match(journal, /"phase\.auto-recycled"/);
  r.cleanup();
});

test('a session that ANSWERS the nudge and wedges again is still recycled, never parked short', async () => {
  // QA round 1, the high one. An earlier ledger counted silent EPISODES, and an
  // episode could close without a rung being spent — exactly this shape, where
  // the CLI echoes the nudge back (a stream event, so the stall clears) and then
  // hangs again. The next silence read as episode two and the phase PARKED with
  // the recycle never climbed, while the errand told the operator it had been.
  // Counting rungs is what fixes it, and this is the case that proves it.
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  clock.wind(10 * 60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'nudged');

  // The echo. Any stream event at all clears the stall: the session is reading,
  // it simply is not working.
  s.say({ kind: 'partial', text: '[[steer:deadbeef]]' });
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].stall, undefined, 'the card came down');

  // …and it wedges again.
  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  const after = instance.current()!.phases['1'];
  assert.equal(after.status, 'pending', 'the recycle fired — that rung was still owed');
  assert.equal(after.stallRemedy?.recycles, 1);
  assert.equal(after.stallRemedy?.nudges, 1, 'and the nudge was not spent twice');
  assert.equal(s.sent.length, 1, 'one nudge for this phase, ever');
  assert.equal(
    events.filter((e) => e.event === 'run:watchdog').map((e) => e.data.action).join(','),
    'nudged,recycled',
  );

  s.gates[0].release();
  await s.gates[1].entered;
  s.gates[1].release();
  await instance.wait();
  r.cleanup();
});

test('a nudge that could not be written is journalled as REFUSED, and costs no rung', async () => {
  // QA round 1. The journal line used to be written BEFORE the send, so a
  // refusal left a sentence claiming the console had nudged the session and
  // that a recycle would follow in five minutes. On this plan a false sentence
  // is the defect class, not a nit.
  const r = repo();
  const s = silentSession(r, { openStdin: false });
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  assert.deepEqual(s.sent, [], 'nothing was written');
  assert.equal(
    instance.current()!.phases['1'].stallRemedy, undefined,
    'and the rung is NOT counted — a bound spent on a write that never happened is a lie',
  );
  assert.deepEqual(
    events.filter((e) => e.event === 'run:watchdog'), [],
    'nor is an act announced that did not occur',
  );

  s.gates[0].release();
  await instance.wait();
  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.auto-nudge-refused"/, 'the refusal has a line of its own');
  assert.ok(!/"phase\.auto-nudged"/.test(journal), 'and the line that claims a write is absent');
  r.cleanup();
});

/**
 * Every clause of the envelope, one at a time — QA round 1's other high finding.
 *
 * The single envelope test below emits one `tool` event, which trips TWO clauses
 * at once and leaves the cost, task-list and dirty-tree clauses with no coverage
 * at all: each could be deleted with the suite green. That is verbatim the
 * lesson this plan's Phase 16 paid three QA rounds for — a gate is not a proof
 * that the gate does anything — so each clause gets its own row.
 *
 * `openTools` has no row on purpose: `applyEvent` pushes to it only on the same
 * branch that sets `lastToolUseAt`, so it cannot be non-empty on its own. It is
 * defence in depth against a future producer, and saying so is more honest than
 * a row that would really be testing `lastToolUseAt` a second time.
 */
const ENVELOPE_CLAUSES: {
  clause: string;
  what: string;
  arm: (s: ReturnType<typeof silentSession>, record: PhaseRecord) => void;
}[] = [
  {
    clause: 'lastToolUseAt',
    what: 'a tool call was made and CAME BACK, and then the session went quiet',
    // The result is what isolates this clause: it splices the call out of
    // `openTools`, so `lastToolUseAt` is the only thing left standing between
    // this session and a kill. With the call left OPEN the two clauses cover for
    // each other and either could be deleted with this row still green — which
    // is exactly the coverage illusion this family exists to prevent. It is also
    // the more realistic session: one that worked, finished a call, and stopped.
    arm: (s) => {
      s.say({ kind: 'tool', id: 'toolu_a', name: 'Read', summary: 'src/index.ts' });
      s.say({ kind: 'tool-result', id: 'toolu_a', ok: true, detail: '40 lines' });
    },
  },
  {
    clause: 'turnsSinceLastTool',
    what: 'a turn ended with no tool call in it',
    arm: (s) => s.say({ kind: 'step', tools: 0 }),
  },
  {
    clause: 'lane.spentUsd',
    what: 'this attempt has spent money',
    arm: (s) => s.say({ kind: 'result', costUsd: 0.42, turns: 1 }),
  },
  {
    clause: 'record.tasksAt',
    what: 'this attempt published a task list',
    arm: (_s, record) => { record.tasksAt = 128; },
  },
];

for (const { clause, what, arm } of ENVELOPE_CLAUSES) {
  test(`the envelope holds on ${clause} alone — ${what}`, async () => {
    const r = repo();
    const s = silentSession(r);
    const clock = fakeClock();
    const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    arm(s, instance.current()!.phases['1']);

    // Well past both clocks: without this clause the lane would be nudged and
    // then recycled.
    clock.wind(11 * 60_000);
    await instance.tickLiveness();
    clock.wind(6 * 60_000);
    await instance.tickLiveness();

    assert.deepEqual(s.sent, [], `${clause} did not hold the nudge back`);
    const record = instance.current()!.phases['1'];
    assert.equal(record.stallRemedy, undefined, `${clause} did not hold the ledger back`);
    assert.equal(record.status, 'running', `${clause} did not keep the session alive`);

    s.gates[0].release();
    await instance.wait();
    r.cleanup();
  });
}

test('the envelope holds on commitsSinceStart alone — THIS attempt committed something', async () => {
  // QA round 2's one real finding, and it hid inside the dirty-tree test: with
  // both signals armed by one uncommitted file, `commitsSinceStart` could be
  // deleted with the suite green. Committing rather than leaving the file dirty
  // isolates it — and it is also the case that caught the deeper bug, because
  // the window `workEvidence` measures used to be `record.startedAt` (stamped
  // once, at the phase's FIRST boarding). A phase that committed on attempt one
  // therefore reported those commits for ever, so the watchdog was permanently
  // switched off for it from attempt two onwards: the same cumulative defect as
  // `record.costUsd`, in the clause meant to be the honest one.
  const r = gitRepo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  };
  writeFileSync(join(r.root, 'work.txt'), 'the session did something\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: r.root, env });
  execFileSync('git', ['commit', '-qm', 'the session committed'], { cwd: r.root, env });

  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  clock.wind(6 * 60_000);
  await instance.tickLiveness();

  assert.equal(
    instance.current()!.phases['1'].liveness?.commitsSinceStart, 1,
    'the fixture really did commit inside this attempt — otherwise this test proves nothing',
  );
  assert.equal(
    instance.current()!.phases['1'].liveness?.treeDirty, false,
    'and it did NOT leave the tree dirty, so the other clause cannot cover for this one',
  );
  assert.deepEqual(s.sent, [], 'a session that committed is never touched');
  assert.equal(instance.current()!.phases['1'].stallRemedy, undefined);

  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

test('work evidence is measured from THIS attempt, so an earlier attempt-s commits do not switch the watchdog off', async () => {
  // The deeper half of QA round 2's finding, and the one the clause test above
  // cannot see: `workEvidence` used to be given `record.startedAt`, stamped once
  // at the phase's FIRST boarding. A phase that committed on attempt one
  // therefore reported that commit on every later attempt, so the watchdog was
  // permanently switched off for it — "fires once in a run's life and then never
  // again, silently", which is the exact defect the envelope's own comment
  // claims to have fixed for `record.costUsd`.
  //
  // The discriminator is a window that starts AFTER a commit that already
  // exists: the old reading (`startedAt`, in the past) counts it, the new one
  // (`attemptStartedAt`) does not. No fake git and no second attempt needed.
  const r = gitRepo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  };
  writeFileSync(join(r.root, 'earlier.txt'), 'an earlier attempt did this\n');
  execFileSync('git', ['add', 'earlier.txt'], { cwd: r.root, env });
  execFileSync('git', ['commit', '-qm', 'an earlier attempt'], { cwd: r.root, env });

  const record = instance.current()!.phases['1'];
  // This attempt began after that commit — which is what a re-boarded attempt
  // always looks like. `startedAt` deliberately stays where it was.
  record.attemptStartedAt = new Date(Date.now() + 60_000).toISOString();

  clock.wind(11 * 60_000);
  await instance.tickLiveness();

  assert.equal(
    instance.current()!.phases['1'].liveness?.commitsSinceStart, 0,
    'a commit from before this attempt is not this attempt-s work',
  );
  assert.equal(s.sent.length, 1, 'so the watchdog still helps a phase that has committed before');

  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

test('the envelope holds on a DIRTY TREE alone — the session has edited files', async () => {
  // The one clause that needs a real checkout: `workEvidence` shells out to git,
  // and `evaluateLane` refreshes it on its own slower cadence.
  const r = gitRepo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  writeFileSync(join(r.root, 'edited-by-the-session.txt'), 'work in progress\n');

  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  clock.wind(6 * 60_000);
  await instance.tickLiveness();

  assert.equal(
    instance.current()!.phases['1'].liveness?.treeDirty, true,
    'the fixture really did make the tree dirty — otherwise this test proves nothing',
  );
  assert.deepEqual(s.sent, [], 'a session with uncommitted work is never touched');
  assert.equal(instance.current()!.phases['1'].stallRemedy, undefined);

  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

test('a lane with ANY work in it is never nudged and never recycled', async () => {
  // The false positive that would cost the most: this kills a live session.
  // One tool call — the weakest possible evidence of work — is enough, and it
  // is the clause `turnsSinceLastTool` alone cannot express (every tool call
  // resets it to zero, so on its own it reads "not right now", never "never").
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  s.say({ kind: 'tool', id: 'toolu_a', name: 'Bash', summary: 'npm test' });

  clock.wind(30 * 60_000);
  await instance.tickLiveness();
  await instance.tickLiveness();
  assert.equal(
    livenessEvents(events)[0]?.stall?.signal, 'silent',
    'it IS silent — the card stands, which is what Phase 21 escalates',
  );
  assert.deepEqual(s.sent, [], 'but nothing was written to it');
  const record = instance.current()!.phases['1'];
  assert.equal(record.stallRemedy, undefined, 'and no rung was ever climbed');
  assert.equal(record.status, 'running', 'the session keeps running');

  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

/**
 * The owed QA verdict is a session too, and Freeze all means nothing starts.
 *
 * This one arrived by merge rather than by feature: 3.2.0 added the warm
 * verdict chase inside the lane, 3.3.0 added the fleet freeze, and neither
 * branch had both. A session spawned from inside the loop passes through
 * neither `startRun` nor `Scheduler.admit`, so no gate above it can see it —
 * `fleet-freeze.test.ts`'s spawn census is what found it, and this is the
 * behaviour behind that row.
 *
 * Two-sided on purpose: a test that only shows it NOT spawning passes just as
 * well against a verdict chase that was deleted.
 */
test('a frozen console does not chase the owed QA verdict — and still chases it after the thaw', async () => {
  const r = repo();
  r.setQaOwed('pending');
  const spawns: { name?: string; resume?: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ name: request.name, resume: request.resume });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  let fleet: { at: string; by?: string } | null = { at: new Date().toISOString(), by: 'mo' };
  const { instance, events } = runner(r, spawn, '`true`', undefined, { fleetHold: () => fleet });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const chase = () =>
    (instance as unknown as { maybeQaVerdict(phase: number): Promise<void> }).maybeQaVerdict(1);

  // Frozen: nothing starts, and the skip says why rather than passing silently.
  const before = spawns.length;
  await chase();
  assert.equal(spawns.length, before, 'a frozen console started a verdict session');
  const skipped = events.filter((e) => e.event === 'run:journal'
    && (e.data as { event?: string }).event === 'phase.qa-session-skipped');
  assert.ok(skipped.length, 'the skip is journalled, not silent');
  assert.match(
    String((skipped.at(-1)!.data as { data?: { reason?: string } }).data?.reason ?? ''),
    /frozen/,
    'and it names the freeze, so the verdict is a DEFER rather than a loss',
  );

  // Thawed: the same owed verdict, on the phase's own session.
  fleet = null;
  await chase();
  assert.equal(spawns.length, before + 1, 'the guard suppresses the chase — it does not remove it');
  assert.match(spawns.at(-1)!.name ?? '', /qa-verdict$/);
  assert.equal(spawns.at(-1)!.resume, 'sess-p1', "and it resumes the phase's own session");
  r.cleanup();
});

test('a spent QA round budget parks the phase with an errand naming the last report, and spawns no further round', async () => {
  // Issue #7 §3: nothing counted QA rounds, so a phase could fail QA for ever.
  // `qaMaxRounds: 2` means two failed rounds and then a person — and the ask
  // has to name the report that describes the code AS IT STANDS, which after
  // two rounds is round 2's, not the plain `phase-01-qa.md` the static ask
  // pointed nowhere near.
  const r = repo();
  const spawns: { name?: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ name: request.name });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`');
  const state = await instance.start({
    // `autoRecover` is the run's healing opt-in and the ladder does not climb
    // without it — a park is a healing outcome, not a plain failure.
    slug: 'demo', root: r.root, autonomy: 'keep-going', qaMaxRounds: 2, autoRecover: true,
  });
  await instance.wait();

  // Two rounds on file, both failed — the state a phase reaches by being fixed
  // once and failing again.
  const record = state.phases['1'];
  record.qa = [
    { round: 1, verdict: 'fail', reportPath: 'reports/phase-01-qa.md' },
    { round: 2, verdict: 'fail', reportPath: 'reports/phase-01-qa-round2.md' },
  ];

  const before = spawns.length;
  const climb = (instance as unknown as {
    climb(rec: unknown, board: unknown, by: string, preset: unknown): Promise<boolean>;
  }).climb.bind(instance);
  const moved = await climb(
    record,
    { states: {}, ready: [], done: [1] },
    'test',
    { situation: { id: 'qa-failed', key: 'qa-failed', label: 'QA failed', actor: 'machine', why: ['two rounds failed'] } },
  );

  assert.equal(moved, false, 'the budget is spent — the ladder does not climb');
  assert.equal(spawns.length, before, 'and no third round is spawned');
  assert.equal(record.status, 'parked');
  const errand = state.recoveries?.['1']?.errand;
  assert.ok(errand, 'a spent budget leaves the ONE ask a person answers');
  assert.match(errand!.need, /failed 2 of the 2 rounds/, errand!.need);
  assert.match(errand!.how, /reports\/phase-01-qa-round2\.md/, errand!.how);
  r.cleanup();
});

test('the QA budget counts the rounds ON FILE, not only the ones this console watched', async () => {
  // QA round 2: `record.qa` has exactly one writer — `maybeQaVerdict`, which
  // returns early the moment a verdict exists — so every round after the first
  // was invisible to it. A `qa-fix` rung resumes the session, the session
  // records a new verdict, and nothing put that round on the record; the budget
  // therefore could not bind in the fail → fix → fail loop it exists for. The
  // FILE is the shared truth, so the climb re-reads it.
  const r = repo();
  r.setQaHistory('1\tfail\treports/phase-01-qa.md\t2026-09-01\n2\tfail\treports/phase-01-qa-round2.md\t2026-09-02\n');
  const spawn: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`');
  const state = await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', qaMaxRounds: 2, autoRecover: true,
  });
  await instance.wait();

  const record = state.phases['1'];
  assert.equal(record.qa, undefined, 'the record itself knows nothing — that is the premise');

  const climb = (instance as unknown as {
    climb(rec: unknown, board: unknown, by: string, preset: unknown): Promise<boolean>;
  }).climb.bind(instance);
  await climb(
    record,
    { states: {}, ready: [], done: [1] },
    'test',
    { situation: { id: 'qa-failed', key: 'qa-failed', label: 'QA failed', actor: 'machine', why: ['two rounds failed'] } },
  );

  assert.equal((record.qa ?? []).length, 2, 'the rounds on file are adopted onto the record');
  assert.equal(record.status, 'parked', 'and the budget binds on them');
  const errand = state.recoveries?.['1']?.errand;
  assert.match(errand?.need ?? '', /failed 2 of the 2 rounds/);
  assert.match(errand?.how ?? '', /reports\/phase-01-qa-round2\.md/);
  r.cleanup();
});

test('re-reading the rounds MERGES onto the record — a round the file lacks is not dropped', async () => {
  // QA round 3, F3: the re-read REPLACED `record.qa`, so a round the file does
  // not hold vanished — and one class of round is exactly that, the entry the
  // runner writes when a reviewer records no verdict at all. With it went the
  // session, the brief and what that review cost, which is criterion 4.
  const r = repo();
  r.setQaHistory('1\tfail\treports/phase-01-qa.md\t2026-09-01\n');
  const spawn: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`');
  const state = await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', qaMaxRounds: 3, autoRecover: true,
  });
  await instance.wait();

  const record = state.phases['1'];
  record.qa = [
    // Round 1 is on file too — the run knows more about it than the file does.
    { round: 1, verdict: 'fail', reportPath: 'reports/phase-01-qa.md', sessionId: 'sid', brief: 'go', costUsd: 4, turns: 30 },
    // Round 2 is the run's alone: a session that recorded nothing.
    { round: 2, verdict: 'pending', sessionId: 'sid2', brief: 'again', costUsd: 2.5, turns: 40 },
  ];

  const climb = (instance as unknown as {
    climb(rec: unknown, board: unknown, by: string, preset: unknown): Promise<boolean>;
  }).climb.bind(instance);
  await climb(
    record,
    { states: {}, ready: [], done: [1] },
    'test',
    { situation: { id: 'qa-failed', key: 'qa-failed', label: 'QA failed', actor: 'machine', why: ['one round failed'] } },
  );

  const rounds = record.qa ?? [];
  assert.equal(rounds.length, 2, `both rounds survive: ${JSON.stringify(rounds)}`);
  assert.equal(rounds[0].costUsd, 4, "the run's own spend survives the re-read");
  assert.equal(rounds[0].brief, 'go');
  assert.equal(rounds[1].round, 2, 'and the round the FILE does not hold is not dropped');
  assert.equal(rounds[1].costUsd, 2.5);
  r.cleanup();
});

test('the QA budget is spent by FAILED rounds only — a pass on the record is not a strike', async () => {
  // QA round 1 of P4 (F3): the count was `qa[].length`, which includes passes,
  // waivers and the synthetic entry pushed when a reviewer records nothing —
  // and because `qa[]` deliberately survives `resetForRetry`, a phase could
  // park on its FIRST real fail claiming three had failed.
  const r = repo();
  const spawn: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`');
  const state = await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', qaMaxRounds: 2, autoRecover: true,
  });
  await instance.wait();

  const record = state.phases['1'];
  // Three rounds on file, only ONE of them a fail — the shape a phase reaches by
  // being reviewed, fixed, reviewed again, and then regressing once.
  record.qa = [
    { round: 1, verdict: 'pass', reportPath: 'reports/phase-01-qa.md' },
    { round: 2, verdict: 'waived', reportPath: 'reports/phase-01-qa-round2.md' },
    { round: 3, verdict: 'fail', reportPath: 'reports/phase-01-qa-round3.md' },
  ];

  const climb = (instance as unknown as {
    climb(rec: unknown, board: unknown, by: string, preset: unknown): Promise<boolean>;
  }).climb.bind(instance);
  await climb(
    record,
    { states: {}, ready: [], done: [1] },
    'test',
    { situation: { id: 'qa-failed', key: 'qa-failed', label: 'QA failed', actor: 'machine', why: ['one round failed'] } },
  );

  assert.notEqual(record.status, 'parked', 'one fail under a budget of two must still climb');
  r.cleanup();
});

test('a frozen, pausing or fleet-held lane is never touched by the watchdog', async () => {
  // Three separate rails, and a fix on one is not a fix (Phase 16). All three
  // make a lane silent BY CONSTRUCTION, so an ungated watchdog reads the
  // console's own act as the failure it exists to catch and recycles the
  // operator's pause.
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  let fleet: { at: string; by?: string } | null = null;
  const { instance } = runner(r, s.spawn, '`true`', undefined, {
    now: clock.now, fleetHold: () => fleet,
  });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  // 1. A fleet freeze.
  fleet = { at: clock.now().toISOString(), by: 'mo' };
  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  assert.deepEqual(s.sent, [], 'a fleet-held lane is not nudged');
  assert.equal(instance.current()!.phases['1'].stallRemedy, undefined);
  fleet = null;

  // 2. The run on its way to a pause.
  state.status = 'pausing';
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.deepEqual(s.sent, [], 'a pausing run is not nudged');
  assert.equal(instance.current()!.phases['1'].stallRemedy, undefined);
  state.status = 'running';

  // 3. A single frozen lane — the operator's own SIGSTOP.
  state.freeze = { at: clock.now().toISOString(), by: 'mo' };
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.deepEqual(s.sent, [], 'a frozen lane is not nudged');
  assert.equal(instance.current()!.phases['1'].stallRemedy, undefined);
  state.freeze = null;

  // …and with all three gone, the SAME lane is nudged on the very next tick.
  // Without this the test would pass just as well against a watchdog that had
  // been deleted, which is exactly how four gates were once switched off with
  // the whole suite green.
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'the guards suppress the remedy — they do not remove it');

  // Released without a recycle, so this attempt simply ends: nothing re-boards,
  // and awaiting a second spawn here would wait for ever.
  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

test('a lane that wedges again with BOTH rungs spent parks with one errand, and the others carry on', async () => {
  const r = repo();
  r.setParallel(true);
  const s = silentSession(r, { attempts: 2 });
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  // Rungs one and two: nudge, then recycle.
  clock.wind(10 * 60_000);
  await instance.tickLiveness();
  clock.wind(5 * 60_000);
  await instance.tickLiveness();
  assert.ok(instance.current()!.phases['1'].stallRemedy?.recycledAt);
  s.gates[0].release();
  await s.gates[1].entered;

  // …and it wedges again on the re-boarded attempt. The ladder is spent.
  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  const parked = instance.current()!.phases['1'];
  assert.equal(parked.status, 'parked', 'it stops rather than being recycled for ever');
  assert.equal(parked.stallRemedy?.nudges, 1, 'exactly one nudge, ever');
  assert.equal(parked.stallRemedy?.recycles, 1, 'and exactly one recycle');
  const errand = events.filter((e) => e.event === 'run:phase')
    .map((e) => e.data.errand as { need?: string; tried?: string[] } | undefined)
    .filter(Boolean).at(-1);
  assert.ok(errand, 'a park with no errand is a phase that stopped and asked nobody anything');
  assert.match(String(errand!.need), /a person/);
  assert.equal(errand!.tried?.length, 3, 'the errand names what was already tried, so nobody repeats it');
  assert.ok(errand!.tried!.some((t) => /nudged/.test(t)));
  assert.ok(errand!.tried!.some((t) => /recycled/.test(t)));

  s.gates[1].release();
  await instance.wait();

  const settled = instance.current()!;
  // The run ends the way it ends for any parked phase — "nothing left to run",
  // naming the errand. Not a failure, not a conviction of the phase, and not
  // `failed`/`interrupted`: this is the SAME ending `parkWithErrand` produces,
  // which is the point of not inventing a rung.
  assert.match(String(settled.halt?.reason), /phase 1 is parked/);
  assert.notEqual(settled.phases['1'].status, 'failed', 'a wedged boot is not a failed attempt');
  assert.equal(settled.phases['2'].status, 'done', 'and its other lanes finished their work');
  assert.equal(settled.phases['3'].status, 'done');
  const journal = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8');
  assert.match(journal, /"phase\.stall-parked"/);
  // The whole silent ladder, one record per rung and in order — production has
  // never exercised it (SLF-9 iv), so this is the only evidence the rungs climb.
  const rungs = journal.trim().split('\n').map((line) => (JSON.parse(line) as { event: string; phase?: number }))
    .filter((line) => line.phase === 1 && ['phase.auto-nudged', 'phase.auto-recycled', 'phase.stall-parked'].includes(line.event))
    .map((line) => line.event);
  assert.deepEqual(rungs, ['phase.auto-nudged', 'phase.auto-recycled', 'phase.stall-parked']);
  r.cleanup();
});

test('a park whose session never had an id does not claim it was resumed on one', async () => {
  // QA round 3. The guard was added and nothing pinned it: forcing the ternary
  // either way left the suite green, because the park test only matched
  // /recycled/, which both branch strings satisfy. The sentence next door in
  // `service-live.ts` WAS pinned — and this is the copy an operator reads on the
  // errand card, which is the one place they cannot check it against anything.
  const r = repo();
  // No `init` frame, so the phase never learns a session id — exactly a lane
  // wedged before the CLI said anything at all, which is this watchdog's whole
  // subject.
  const s = silentSession(r, { announceSession: false });
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  clock.wind(10 * 60_000);
  await instance.tickLiveness();
  clock.wind(5 * 60_000);
  await instance.tickLiveness();
  s.gates[0].release();
  await s.gates[1].entered;
  clock.wind(11 * 60_000);
  await instance.tickLiveness();

  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'parked');
  assert.equal(record.sessionId, undefined, 'the fixture really never announced one');
  const errand = events.filter((e) => e.event === 'run:phase')
    .map((e) => e.data.errand as { tried?: string[] } | undefined)
    .filter(Boolean).at(-1);
  const recycled = errand!.tried!.find((t) => /recycled/.test(t))!;
  assert.match(recycled, /no id yet/, 'it says what actually happened');
  assert.ok(
    !/on its own session id/.test(recycled),
    'and never the sentence that would be true of a different phase',
  );

  s.gates[1].release();
  await instance.wait();
  r.cleanup();
});

test('a ledger written by an OLDER build does not make the ladder unbounded', async () => {
  // QA round 2. The ledger's shape changed mid-phase (it used to count silent
  // episodes), and a checkpoint written by the older build has no `nudges` at
  // all. `undefined + 1` is `NaN`, which is never greater than zero, so every
  // rung read as unclimbed for ever: measured at four ticks, four nudges, no
  // recycle, no park. Reading through `?? 0` makes a foreign ledger mean "this
  // phase has climbed nothing", which is safe AND bounded.
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;
  // Exactly what the previous build persisted.
  instance.current()!.phases['1'].stallRemedy =
    { episodes: 1, open: true } as unknown as PhaseRecord['stallRemedy'];

  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'one nudge');
  clock.wind(6 * 60_000);
  await instance.tickLiveness();
  assert.equal(s.sent.length, 1, 'still one nudge — the rung was counted');
  const after = instance.current()!.phases['1'];
  assert.equal(after.stallRemedy?.recycles, 1, 'and the ladder reached its second rung');
  assert.equal(after.status, 'pending');

  s.gates[0].release();
  await s.gates[1].entered;
  s.gates[1].release();
  await instance.wait();
  r.cleanup();
});

test('a refused nudge writes NO ledger, so "absent means never" stays exact', async () => {
  // QA round 2. An empty `{ nudges: 0, recycles: 0 }` on the record is not the
  // same fact as no record at all — every reader of the checkpoint would see a
  // phase the watchdog had "handled". Nothing was done, so nothing is written.
  const r = repo();
  const s = silentSession(r, { openStdin: false });
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  clock.wind(11 * 60_000);
  await instance.tickLiveness();
  assert.equal(
    instance.current()!.phases['1'].stallRemedy, undefined,
    'a rung that was not climbed leaves no trace on the record',
  );

  s.gates[0].release();
  await instance.wait();
  r.cleanup();
});

test('an operator Retry clears the watchdog ledger — and nothing else does', () => {
  // The bound must survive a recycle (a recycle makes a NEW attempt, so a
  // ledger keyed on the attempt would hand every recycle a clean slate and
  // recycle for ever). It must NOT survive a person pressing Retry: they are
  // asking for the phase to be tried again from the top, and they are there to
  // watch what happens.
  const record = {
    phase: 1, status: 'failed', attempts: 2, costUsd: 0,
    stallRemedy: { nudges: 1, recycles: 1, nudgedAt: 'x', recycledAt: 'y' },
  } as unknown as Parameters<typeof resetForRetry>[0];
  resetForRetry(record, { by: 'operator', journal: () => {} });
  assert.equal(record.stallRemedy, undefined);
});

test('an ordinary long command is never parked, however long it runs', async () => {
  // The false positive that would matter most: this ends a LIVE session. A
  // twelve-minute test suite is silent, is fine, and must keep its lock.
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  held.say({ kind: 'tool', id: 'toolu_a', name: 'Bash', summary: 'npm test -- --run' });

  clock.wind(12 * 60_000);
  await instance.tickLiveness();
  const seen = livenessEvents(events);
  assert.equal(seen[0]?.stall?.signal, 'silent', 'quiet, yes — but not waiting on anyone');
  assert.equal(instance.current()!.phases['1'].status, 'running', 'and it keeps its session');

  held.release();
  await instance.wait();
  r.cleanup();
});

test('six turns without a tool call is spinning, and the count is in the words', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  for (let i = 0; i < 5; i++) { clock.wind(1_000); held.say({ kind: 'step', tools: 0 }); }
  await instance.tickLiveness();
  assert.deepEqual(livenessEvents(events), [], 'five is under the threshold, and the threshold is the threshold');

  clock.wind(1_000);
  held.say({ kind: 'step', tools: 0 });
  await instance.tickLiveness();
  const stall = livenessEvents(events)[0]?.stall;
  assert.equal(stall?.signal, 'spinning');
  assert.match(String(stall?.detail), /6 turns with no tool call/);

  // A turn that actually calls something ends it.
  clock.wind(1_000);
  held.say({ kind: 'step', tools: 2 });
  await instance.tickLiveness();
  assert.equal(livenessEvents(events).at(-1)?.stall, null);

  held.release();
  await instance.wait();
  r.cleanup();
});

test('a phase inside its own §Verification is exempt — a build is silent and fine', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  // The stretch where the session has exited and `npm test` owns the next
  // twelve minutes. Without this exemption every plan with a real suite would
  // raise a card on every phase.
  phaseRecord(instance.current()!, 1).verifyingSince = clock.now().toISOString();
  clock.wind(30 * 60_000);
  await instance.tickLiveness();
  assert.deepEqual(livenessEvents(events), []);

  // And the moment the commands are done, the same silence is a card again.
  delete phaseRecord(instance.current()!, 1).verifyingSince;
  await instance.tickLiveness();
  assert.equal(livenessEvents(events)[0]?.stall?.signal, 'silent');

  held.release();
  await instance.wait();
  r.cleanup();
});

test('an attempt that changed nothing counts up; at the threshold the lane is a stalemate', async () => {
  const r = gitRepo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  // Two earlier attempts of this phase already ended having changed nothing.
  phaseRecord(instance.current()!, 1).idleAttempts = 2;
  held.release();
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.idleAttempts, 3, 'a clean tree and no commits is an attempt that did nothing');
  assert.equal(record.stall?.signal, 'stalemate');
  assert.match(String(record.stall?.detail), /3 attempts in a row/);
  r.cleanup();
});

/**
 * autopilot-4 — we ended that attempt, so it is not evidence about the phase.
 *
 * `settleIdleAttempt` ran unconditionally the moment the spawn resolved,
 * ahead of the checkpoint, per-lane-stop and abort branches. So an attempt the
 * CONSOLE ended on purpose was scored as an attempt that produced nothing:
 * three account switches — whose entire point is that the work continues on
 * the account that can pay — raised "3 attempts in a row ended with nothing
 * committed and a clean tree" about a phase that had never been given the
 * chance to commit anything, and `stalemate` is a worst-first card that sends
 * a person looking at the wrong thing.
 */
test('an attempt the console checkpointed is not counted as an idle attempt (autopilot-4)', async () => {
  const r = gitRepo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-switch', model: 'stub-1', tools: 0 });

  // Two earlier attempts genuinely produced nothing — one more would be a
  // stalemate if this one counted.
  phaseRecord(instance.current()!, 1).idleAttempts = 2;

  // The console ends this attempt itself. A per-lane stop rather than an
  // account switch only because the switch needs a live pid the stub session
  // has not got; both land on the same guard, and both mean "we ended it".
  assert.deepEqual(instance.stopPhase(1, 'tester'), { ok: true });
  held.release();
  await instance.wait();

  const record = instance.current()!.phases['1'];
  assert.equal(record.idleAttempts, 2, 'the counter is untouched — we ended that attempt, it did not stall');
  assert.notEqual(record.stall?.signal, 'stalemate');
  r.cleanup();
});

test('an attempt that left work on disk resets the counter, whatever the board says', async () => {
  const r = gitRepo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  phaseRecord(instance.current()!, 1).idleAttempts = 2;
  // The session did something, even though it has not committed it.
  writeFileSync(join(r.root, 'work.txt'), 'half a feature\n');
  held.release();
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].idleAttempts, 0);
  assert.equal(instance.current()!.phases['1'].stall, undefined);
  r.cleanup();
});

test('a tree the console cannot read is never evidence of a stalemate', async () => {
  // "I could not check" and "nothing happened" are different facts, and three
  // attempts against a repository the console cannot see is a console problem.
  // `repo()` is not a git checkout, so `workEvidence` answers `null` here.
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;
  phaseRecord(instance.current()!, 1).idleAttempts = 2;
  held.release();
  await instance.wait();

  assert.equal(instance.current()!.phases['1'].idleAttempts, 2, 'the counter stays exactly where it was');
  r.cleanup();
});

/** What `ps` says about a process: `T` is stopped, `S`/`R` are running. */
function procState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 1);
  } catch { return ''; }
}

test('freezing stops the child where it stands, and thawing lets it carry on', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.notEqual(procState(pid), 'T', 'the child is running before anything is asked of it');

  assert.equal(instance.freeze('test'), true);
  assert.equal(instance.current()!.status, 'frozen');
  assert.equal(instance.current()!.freeze!.pid, pid);
  assert.equal(instance.current()!.freeze!.phase, 1);
  // The claim that matters, made by the kernel rather than by us.
  assert.equal(procState(pid), 'T', 'the session is stopped, not killed and not asked to wrap up');

  assert.equal(instance.thaw(), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.freeze, null);
  assert.notEqual(procState(pid), 'T', 'and it is scheduled again');
  // Time spent stopped is not time spent working, and a throughput figure built
  // on the difference would be wrong.
  assert.ok((instance.current()!.phases['1'].frozenMs ?? 0) >= 0);

  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * A freeze can OUTLIVE every lane it named, and it must still be undoable.
 *
 * D13 taught `freeze()` to mark admitted-but-pid-less lanes so their spawn is
 * deferred rather than raced. Marking one stops nothing, though — there is no
 * process yet — so that lane goes on to be refused at boarding and then DELETED
 * by `runPhase`'s `finally`. The run was left reading `frozen` with an empty
 * lane table: `thaw()` looked only at lanes, found none and answered `false`,
 * so the one verb that undoes a freeze could not, and the run was escapable
 * only by Stop. (The drive loop's half of the same defect is the `frozen`
 * branch at the top of `drive`, which now drains and settles to `paused`
 * instead of falling through to the board read forever.)
 */
test('a freeze that outlived its lane is still thawable', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test'), true);
  assert.equal(instance.current()!.status, 'frozen');
  assert.ok(instance.current()!.freeze, 'the run-level slot is set');

  // The shape D13 created, reproduced directly rather than raced: the lane the
  // freeze named is gone, and only the slot is left.
  (instance as unknown as { lanes: Map<number, unknown> }).lanes.clear();

  assert.equal(instance.thaw(), true, 'a freeze with no lane left must still be undoable');
  assert.equal(instance.current()!.freeze, null, 'the slot is released');
  assert.notEqual(instance.current()!.status, 'frozen', 'and the run is not left wedged frozen');
  // The claim that matters, and the one the first cut of this fix got wrong: the
  // slot names a real stopped child, so releasing the record without a SIGCONT
  // would abandon it stopped forever with nothing left pointing at it. Asked of
  // the kernel, not of us. No hand-`SIGCONT` here on purpose — if this needed
  // one, the fix would not be a fix.
  assert.notEqual(procState(pid), 'T', 'the child the slot named is scheduled again');

  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * D13's admission seam, pinned — a frozen run REFUSES to board.
 *
 * The whole of D13 shipped without a behavioural test: `stopAdmitting` gained
 * `frozen` and `boardingBlocked()` gained a `'frozen'` verdict, and nothing
 * asserted either. `boardingBlocked()` is the predicate ALL FOUR boarding gates
 * consult (after the gate check, on arrival from the queue, immediately before
 * the phase is marked running, and in the ladder), so pinning it pins the
 * refusal at every one of them — and the refusal is what makes the chosen
 * semantic true: a lane that arrives under a freeze is left `pending`, so the
 * THAW is what starts it, not the race.
 */
test('a frozen run refuses to board, and boards again once thawed', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  const blocked = () =>
    (instance as unknown as { boardingBlocked(): string | null }).boardingBlocked();

  assert.equal(blocked(), null, 'a working run boards');

  assert.equal(instance.freeze('test'), true);
  assert.equal(instance.current()!.status, 'frozen');
  assert.equal(blocked(), 'frozen', 'and a frozen one refuses — at every boarding gate');
  // The invariant behind exit criterion 2: the word `frozen` is only on this
  // run because the lane under it is actually stopped. Asked of the kernel.
  assert.equal(procState(pid), 'T');

  assert.equal(instance.thaw(), true);
  assert.notEqual(instance.current()!.status, 'frozen');
  assert.equal(blocked(), null, 'the thaw is what lets work start again');

  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * The F-1 regression test, end to end through `drive` — a freeze with nothing
 * behind it SETTLES instead of wedging the run.
 *
 * D13 taught `freeze()` to mark a lane that is admitted but has no pid yet.
 * Marking one stops nothing, so that lane still reached the boarding refusal
 * and was deleted by `runPhase`'s `finally`, leaving `status === 'frozen'` over
 * an empty lane table. `thaw()` had nothing to thaw and `stopAdmitting`'s
 * `continue` fell through to a loop top with no `frozen` branch, so the run
 * span on the board subprocess forever and could only be Stopped.
 *
 * This drives the real loop rather than reaching into it: the only way to know
 * the branch works is to let the loop reach it. It is the test whose absence
 * let the wedge ship — the one committed test for this fix bypassed the loop.
 */
test('a freeze over a lane that never spawned settles the run instead of wedging it', async () => {
  const r = repo();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const inSession = new Promise<void>((resolve) => { entered = resolve; });

  // Holds inside the spawn and never calls `onPid`, which is exactly the window
  // D13 widened `freeze()` to cover: admitted, lane in the table, no process.
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    r.markDone(phase);
    return ok();
  };

  const { instance } = runner(r, spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await inSession;

  assert.equal(instance.freeze('test'), true, 'a pid-less lane is freezable — that is D13');
  assert.equal(instance.current()!.status, 'frozen');

  release();
  // The wedge was an infinite loop, so the assertion has to be a RACE: at
  // `433a4ee` this never resolves.
  const settled = await Promise.race([
    instance.wait().then(() => 'settled' as const),
    new Promise<'wedged'>((resolve) => { setTimeout(() => resolve('wedged'), 10_000); }),
  ]);
  assert.equal(settled, 'settled', 'the run must end on its own, not spin on the board subprocess');

  const state = instance.current()!;
  assert.ok(!IN_FLIGHT.includes(state.status), `settled, not in flight — got ${state.status}`);
  // And the closing words have to match what actually happened: the loop's own
  // `finally` clears the slot in exactly this case (nothing survived), so a
  // sentence promising that Continue will "rule on the freeze" would name a
  // ruling that cannot happen.
  assert.equal(state.freeze, null, 'no stale slot on a run that is not IN_FLIGHT');
  assert.match(state.finishedReason ?? '', /nothing left running/);
  assert.doesNotMatch(state.finishedReason ?? '', /rules on the freeze/);
  r.cleanup();
});

/**
 * The other half, and the one that would be a disaster to get wrong: a freeze
 * holding a LIVE child must NOT be settled out from under it.
 *
 * The branch above ends a run whose freeze stopped nothing. If it fired while a
 * session were genuinely SIGSTOPped, it would mark the run `paused` and walk
 * away from a stopped process — recreating the incident the whole plan closes.
 *
 * ⚠️ What this DOES and does not prove, measured rather than assumed (QA
 * instrumented the branch and found it is never entered here): the loop is
 * parked in the bottom-of-loop `settleOne()` await, so the `frozen` branch is
 * not reached at all. So this pins the OUTCOME — a live frozen child is never
 * settled out from under, by any path — and NOT the branch's own `draining()`
 * guard. **That guard is pinned by the docs-wake test immediately below**,
 * which is the only shape that drives the loop back to the top while a lane is
 * genuinely frozen.
 */
test('a freeze holding a live child holds the loop — it is never settled out from under', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test'), true);

  const outcome = await Promise.race([
    instance.wait().then(() => 'settled' as const),
    new Promise<'held'>((resolve) => { setTimeout(() => resolve('held'), 3_000); }),
  ]);
  assert.equal(outcome, 'held', 'the loop waits out a real freeze rather than ending the run');
  assert.equal(instance.current()!.status, 'frozen');
  assert.ok(instance.current()!.freeze, 'and the slot that points at the stopped child stands');
  assert.equal(procState(pid), 'T', 'the child is still held, per the kernel');

  assert.equal(instance.thaw(), true);
  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * Q-1, closed: the `frozen` branch's own `draining()` guard, pinned.
 *
 * The test above cannot reach the branch — the loop is parked in a
 * `settleOne()` await on a lane promise that cannot settle while its child is
 * SIGSTOPped, so nothing at the loop top ever runs. `noteDocsChanged()` is the
 * one thing that resolves that await from outside: it is how the docs watcher
 * says "a handoff landed, re-read the board NOW". So this is the shape — and
 * the plan named it as D13's case, *"a docs-change wake during freeze admits
 * nothing"*, in exactly these words.
 *
 * What the guard is for: without it the wake returns the loop to the top, it
 * falls past the drain, and the run marks itself `paused` **while its child is
 * still `T`** — the console walking away from a stopped process, which is the
 * incident this whole plan closes.
 *
 * Phase 16 widens this exact loop from one run to the fleet, which is why it
 * is closed here rather than left as a note: a fleet freeze is many of these at
 * once, and a docs change during one would otherwise settle every run under it.
 */
test('a docs-change wake during a freeze admits nothing and never settles the run', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test'), true);
  assert.equal(procState(pid), 'T');

  // Three wakes, each one a handoff landing on disk. Every one returns the
  // loop to the top with a live frozen lane under it.
  for (let i = 0; i < 3; i++) {
    instance.noteDocsChanged();
    await new Promise((resolve) => { setTimeout(resolve, 120); });
  }

  assert.equal(
    instance.current()!.status, 'frozen',
    'a docs wake under a freeze must not settle the run — the child is still stopped',
  );
  assert.ok(instance.current()!.freeze, 'and the slot pointing at it still stands');
  assert.equal(procState(pid), 'T', 'per the kernel, not per the record');
  assert.equal(
    (instance as unknown as { boardingBlocked(): string | null }).boardingBlocked(), 'frozen',
    'and nothing new may board on the way past',
  );

  assert.equal(instance.thaw(), true);
  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * The STANDING form — what a fleet freeze writes, and the one property that
 * makes it a fleet freeze rather than fifteen minutes of one.
 *
 * An ordinary freeze is a promise with a deadline: "left frozen past 18:11 it
 * converts to a checkpoint". A fleet freeze is the opposite promise — the
 * operator switched the console off at the wall, and a clock that converted
 * their whole fleet into checkpoints a quarter of an hour later would undo
 * exactly what they asked for. So the record carries no `escalateAt` and no
 * timer is armed, which `freezeVerdict` already reads as "leave it standing".
 *
 * The child is still genuinely stopped — asked of the kernel, not of the
 * record — because "no deadline" must not quietly become "no freeze".
 */
test('a STANDING freeze stops the child and arms no clock at all', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('mo', undefined, { standing: true }), true);
  assert.equal(procState(pid), 'T', 'standing or not, the session is stopped where it stands');

  const slot = instance.current()!.freeze!;
  assert.equal(slot.escalateAt, undefined, 'a standing freeze names no deadline');
  assert.equal(
    freezeVerdict(slot, Date.now() + 365 * 24 * 60 * 60_000).kind, 'none',
    'and a year later it is still the operator’s to undo',
  );

  const lanes = (instance as unknown as { lanes: Map<number, { freezeTimer: unknown }> }).lanes;
  for (const lane of lanes.values()) {
    assert.equal(lane.freezeTimer, null, 'no timer either — the record and the timer are one promise');
  }

  assert.equal(instance.thaw(), true);
  assert.notEqual(procState(pid), 'T', 'and the thaw wakes it, per the kernel');
  held.release();
  await instance.wait();
  r.cleanup();
});

/**
 * A lane frozen a minute BEFORE Freeze-all is converted, not left on its clock.
 *
 * The `eligible` filter excludes an already-frozen lane, correctly — there is
 * nothing to re-signal. But it kept the ordinary form's `escalateAt` and its
 * armed timer, so that one lane was `killLadder`'d fifteen minutes into a
 * freeze the banner calls standing, and the operator lost the session they had
 * frozen first. QA found it; it is the kind of defect a registry cannot see,
 * because both freezes are perfectly well gated.
 */
test('a standing freeze converts a lane that was already frozen on a clock', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; });
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  // The operator freezes ONE lane, the ordinary way — with a deadline.
  assert.equal(instance.freeze('mo'), true);
  assert.ok(instance.current()!.freeze!.escalateAt, 'an ordinary freeze names a deadline');
  const lanes = (instance as unknown as { lanes: Map<number, { freezeTimer: unknown }> }).lanes;
  assert.notEqual([...lanes.values()][0]?.freezeTimer, null, 'and arms a clock for it');

  // …then Freeze-all lands. Nothing to signal — the lane is already stopped —
  // but the promise it carries has to change.
  assert.equal(instance.freeze('mo', undefined, { standing: true }), true,
    'a conversion is a truthful success, not "nothing to freeze"');
  assert.equal(
    instance.current()!.freeze!.escalateAt, undefined,
    'the deadline is gone from the RECORD — and the mirror is what the boot clock reads',
  );
  assert.equal(
    [...lanes.values()][0]?.freezeTimer, null,
    'and from the timer. Half a promise is the orphan this whole area exists to prevent.',
  );
  assert.equal(procState(pid), 'T', 'the child is still held, per the kernel');

  assert.equal(instance.thaw(), true);
  held.release();
  await instance.wait();
  r.cleanup();
});

test('a freeze held too long checkpoints, and Continue resumes that session', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  const { instance } = runner(r, held.spawn);
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test'), true);
  // The escalation is a timer in production; driven directly here, because a
  // test that waits fifteen real minutes is a test nobody runs.
  (instance as unknown as { escalateFreeze(): void }).escalateFreeze();

  const record = instance.current()!.phases['1'];
  // Pending rather than interrupted: this phase is meant to be picked up again,
  // and a settled status is one the loop will not look at.
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'session-to-resume-0001');
  assert.equal(instance.current()!.freeze, null);
  assert.equal(instance.current()!.status, 'paused');
  assert.notEqual(procState(pid), 'T', 'SIGCONT before SIGTERM, or the child never sees it');

  held.release();
  await instance.wait();

  // Continue: the phase runs again, and the session id goes to `--resume`
  // rather than to `--session-id`, which would be refused as already in use.
  const resumed: (string | undefined)[] = [];
  const second = runner(r, async (request) => {
    resumed.push(request.resume);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  });
  await second.instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, autonomy: 'keep-going' });
  await second.instance.wait();

  assert.equal(resumed[0], 'session-to-resume-0001', 'the checkpointed session was picked up');
  assert.equal(resumed[1], undefined, 'and offered exactly once — a reused id is refused by the CLI');
  r.cleanup();
});

test('retry and skip say so the moment they act, not at the next thing that happens', async () => {
  // Both edited the run record and then emitted only `run:journal`, which is
  // marked stream-only and invalidates no query. The row went on showing the
  // old status — a retried phase still read `failed`, under a halt banner that
  // had already been cleared — until something unrelated happened to emit. The
  // only way to see the truth was to reload the page.
  const r = repo();
  const { instance, events } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const from = events.length;
  instance.retry(1);
  const afterRetry = events.slice(from).map((e) => e.event);
  assert.ok(afterRetry.includes('run:run'), `retry must emit run:run, got ${afterRetry.join(', ')}`);
  assert.equal(instance.current()!.phases['1'].status, 'pending', 'and the state it emitted is the new one');

  const beforeSkip = events.length;
  instance.skip(2);
  assert.ok(
    events.slice(beforeSkip).map((e) => e.event).includes('run:run'),
    'skip must emit run:run too',
  );
  r.cleanup();
});

test('freezing a run nothing is driving reports that it did nothing', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  assert.equal(instance.freeze(), false, 'no loop, no child, nothing to stop');
  assert.equal(instance.thaw(), false);
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * What a phase runs as
 * ------------------------------------------------------------------ */

test('the operator wins over the plan, the plan wins over the run default', async () => {
  const r = repo();
  const seen: { phase: number; model?: string; effort?: string }[] = [];
  // The plan asks for opus/high on phase 2, and says nothing about 1 or 3.
  const { instance } = runner(r, recordingSession(r, seen), '`true`',
    (_slug, phase) => (phase === 2 ? { model: 'opus', effort: 'high' } : undefined));

  await instance.start({
    slug: 'demo', root: r.root, model: 'sonnet', effort: 'medium', autonomy: 'keep-going',
    // …and the operator overrules the plan on 2, and the default on 3.
    phaseOptions: { 2: { model: 'haiku' }, 3: { effort: 'max' } },
  });
  await instance.wait();

  assert.deepEqual(seen, [
    { phase: 1, model: 'sonnet', effort: 'medium', tools: undefined },
    // Model from the operator, effort still from the plan: an override is per
    // field, not per phase — saying "run this on haiku" must not silently
    // discard the effort the plan asked for.
    { phase: 2, model: 'haiku', effort: 'high', tools: undefined },
    { phase: 3, model: 'sonnet', effort: 'max', tools: undefined },
  ]);
  r.cleanup();
});

test('the journal says where each choice came from', async () => {
  const r = repo();
  const { instance, events } = runner(r, workingSession(r), '`true`',
    (_slug, phase) => (phase === 1 ? { model: 'opus' } : undefined));
  await instance.start({ slug: 'demo', root: r.root, effort: 'low', autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  const start = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.start');
  assert.ok(start, 'a phase that started must say so in the journal');
  assert.deepEqual((start.data.data as { source: unknown }).source, { model: 'plan', effort: 'default' });
  r.cleanup();
});

test('a restricted tool set reaches the session', async () => {
  const r = repo();
  const seen: { phase: number; tools?: string[] }[] = [];
  const { instance } = runner(r, recordingSession(r, seen));
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1],
    phaseOptions: { 1: { tools: ['Read', 'Grep'] } },
  });
  await instance.wait();
  assert.deepEqual(seen[0].tools, ['Read', 'Grep']);
  r.cleanup();
});

test('a run asked for one phase runs that phase and stops', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [1], 'the loop did not carry on into the rest of the plan');
  assert.equal(instance.current()!.status, 'finished');
  // The most-reported "it doesn't advance to the next phase" is this, and it
  // used to be invisible: the run was scoped from a per-row control, did what
  // it was asked, and said nothing about why it stopped one phase in.
  assert.match(instance.current()!.finishedReason!, /scoped to phase 1/);
  assert.match(instance.current()!.finishedReason!, /scope cleared/i);
  r.cleanup();
});

test('a run that finishes a whole plan says that is why it stopped', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.equal(instance.current()!.status, 'finished');
  assert.match(instance.current()!.finishedReason!, /every phase of demo is done/);
  r.cleanup();
});

test('settings changed mid-run apply from the next phase', async () => {
  const r = repo();
  const seen: number[] = [];
  const held = heldSession(r, seen);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, model: 'opus', autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.configure({ model: 'haiku', runBudgetUsd: 12 }), true);
  assert.equal(instance.current()!.model, 'haiku');
  assert.equal(instance.current()!.runBudgetUsd, 12);
  // The phase already running keeps the model it was started with — its argv
  // was fixed before the change, and claiming otherwise would be a lie.
  assert.equal(instance.current()!.phases['1'].model, 'opus');

  held.release();
  await instance.wait();
  assert.equal(instance.current()!.phases['2'].model, 'haiku', 'the next phase took the new one');
  r.cleanup();
});

test('nothing was written inside the repo — run state lives outside it', async () => {
  const r = repo();
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(existsSync(join(r.root, '.phase-console')), false);
  assert.ok(existsSync(join(STATE_HOME, 'phase-console', 'runs')), 'it went to XDG state instead');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The API guard
 * ------------------------------------------------------------------ */

const { handleApi } = await import('../server/api/routes.ts');

function call(
  path: string,
  opts: {
    method?: string; headers?: Record<string, string>; allowRun?: boolean; body?: unknown;
    /** Replace a service method for one call — used to test a refusal path. */
    overrides?: Record<string, unknown>;
  } = {},
) {
  let status = 0;
  let payload: unknown;
  const started: unknown[] = [];
  /** Which service methods a route reached, in order — see the pause test. */
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return { id: 'r1', status: 'pausing' };
  };
  const service = {
    flags: { allowWrites: false, allowRun: opts.allowRun ?? false, scriptsDir: '/x' },
    store: { get: () => ({}), list: () => [] },
    accounts: { has: () => false },
    // If a route reaches for the runner directly it gets a method that fails
    // the test rather than one that quietly does nothing — which is precisely
    // how Pause came to answer 200 and change nothing for so long.
    runner: {
      current: () => null,
      pause() { throw new Error('routes must go through the service, not the runner'); },
      resumePause() { throw new Error('routes must go through the service, not the runner'); },
      configure() { throw new Error('routes must go through the service, not the runner'); },
      stop: async () => {}, skip() {}, retry() {},
    },
    startRun: async (slug: string, options: unknown) => { started.push({ slug, options }); return { id: 'r1' }; },
    verificationPreflight: async () => ['phase 3 has no §Verification — it will park at boarding'],
    pauseRun: record('pauseRun'),
    resumePause: record('resumePause'),
    configureRun: record('configureRun'),
    askRun: (...args: unknown[]) => { calls.push({ method: 'askRun', args }); return { ok: true }; },
    stopRun: record('stopRun'),
    skipPhase: record('skipPhase'),
    retryPhase: record('retryPhase'),
    // Async since the board resolver joined the read path — a stopped run whose
    // phases the board has finished stops asking for a person (`state.ts`
    // `autoResolveRun`). `runIdFor` is the sync half, for the journal and
    // transcript routes, which address a run by id and do not need the board.
    runFor: async () => ({ id: 'r1', status: 'finished' }),
    runsFor: async () => [{ id: 'r1' }],
    runIdFor: () => 'r1',
    resolveRun: record('resolveRun'),
    unresolveRun: record('unresolveRun'),
    // Null is the ordinary answer: no phase of this plan has finished, so
    // there is nothing to estimate from.
    runEta: async () => null,
    // Sync, and given the run the route already read — the payload's figures
    // have to be about one run, so the route reads it once.
    runPhaseEta: () => [],
    // Same rule: a lane's liveness and the run it belongs to are one moment.
    runLiveness: () => [],
    // `null` is the ordinary answer and the honest one: a run sharing the
    // operator's checkout has no branch of its own to report on, so the Git
    // card has nothing true to say. Only a live isolated run answers a view.
    runGit: () => null,
    runRulings: () => [],
    allRuns: async () => [{ id: 'r1' }],
    runJournal: () => [{ seq: 1, event: 'run.start' }],
    markNotificationsRead: (...args: unknown[]) => {
      calls.push({ method: 'markNotificationsRead', args });
      return { changed: 9, unread: 0 };
    },
    markNotificationsReadFor: (...args: unknown[]) => {
      calls.push({ method: 'markNotificationsReadFor', args });
      return { changed: 2, unread: 7 };
    },
    ...(opts.overrides ?? {}),
  };
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  // A fresh start answers the prelude's three required fields (phase 11) —
  // merged in for every case about some OTHER field; a case that wants the
  // 400 sends `resumeRunId`-less bodies through `routes.test.ts` instead.
  const body = opts.body && typeof opts.body === 'object' && /\/start$/.test(path) && opts.method === 'POST'
    && !(opts.body as Record<string, unknown>).resumeRunId
    ? { resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 0 }], ...(opts.body as Record<string, unknown>) }
    : opts.body;
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method: opts.method ?? 'GET',
    headers: { host: '127.0.0.1:4123', ...(opts.headers ?? {}) },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield* chunks; },
  };
  return handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`))
    .then(() => ({ status, payload, started, calls }));
}

/** What an override-only service method was called with. See the cloud-review test. */
const calls0: { method: string; args: unknown[] }[] = [];

/** A console POST with one service method replaced. */
function callWith(overrides: Record<string, unknown>, path: string, body: unknown) {
  return call(path, {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body, overrides,
  });
}

test('starting a run is refused unless the console was started with --allow-run', async () => {
  const { status, payload, started } = await call('/api/run/demo/start', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: {},
  });
  assert.equal(status, 403);
  assert.match(String((payload as { error: string }).error), /--allow-run/);
  assert.equal(started.length, 0, 'nothing may spawn behind a refusal');
});

test('--allow-run alone is not enough: the request must come from the console', async () => {
  const { status, started } = await call('/api/run/demo/start', { method: 'POST', allowRun: true, body: {} });
  assert.equal(status, 403, 'a missing console header means it did not come from this app');
  assert.equal(started.length, 0);
});

test('another origin cannot drive the autopilot', async () => {
  const { status, started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, body: {},
    headers: { 'x-phase-console': '1', origin: 'http://evil.example' },
  });
  assert.equal(status, 403);
  assert.equal(started.length, 0);
});

test('a proper start request reaches the service with its options', async () => {
  const { status, payload, started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true,
    headers: { 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    body: { model: 'sonnet', effort: 'high', autonomy: 'keep-going', phaseBudgetUsd: 4 },
  });
  assert.equal(status, 200);
  // The start response carries the verification advisory so the operator hears
  // about a would-park phase at Start, not at boarding.
  assert.match(((payload as { preflight?: string[] }).preflight ?? []).join('\n'), /park at boarding/);
  assert.equal(started.length, 1);
  const { slug, options } = started[0] as { slug: string; options: Record<string, unknown> };
  assert.equal(slug, 'demo');
  // Asserted field by field rather than as one object: a deep-equal here fails
  // every time a new option is added, which teaches you to edit the expected
  // value without reading it — and then it is no longer checking anything.
  assert.equal(options.model, 'sonnet');
  assert.equal(options.effort, 'high');
  assert.equal(options.autonomy, 'keep-going');
  assert.equal(options.phaseBudgetUsd, 4);
  assert.equal(options.runBudgetUsd, null, 'an unsent budget is no budget, not zero');
  assert.equal(options.resumeRunId, undefined);
});

test('a per-phase model or effort the CLI would not take is a 400, not a silent drop', async () => {
  // This used to start the run and quietly discard the bad phase's model, so
  // the phase ran on the run's default and nothing anywhere said so. A value
  // the operator typed and the console ignored is the worst of the three
  // possible answers; refusing it is the point of the door.
  const bad = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { phaseOptions: { 2: { model: 'gpt-4' } } },
  });
  assert.equal(bad.status, 400);
  assert.match(String((bad.payload as { error?: string }).error), /phase 2 model/);
  assert.equal(bad.started.length, 0, 'and no run was created');

  const badEffort = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { phaseOptions: { 2: { effort: 'ludicrous' } } },
  });
  assert.equal(badEffort.status, 400);
  assert.match(String((badEffort.payload as { error?: string }).error), /phase 2 effort/);
});

test('per-phase choices are checked against known values, never passed through', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: {
      phaseOptions: {
        1: { model: 'fable', effort: 'max' },
        2: { model: 'claude-opus-5[1m]' },                   // a full id + the 1M window
        3: { permissionMode: 'bypassPermissions' },          // never, from here
        4: { tools: ['Read', 'Bash(rm -rf /)', 'Edit'] },    // not a tool name
        '-1': { model: 'opus' },                             // not a phase
      },
      skills: ['systematic-debugging', 'plugin:test-first', '../../etc/passwd', 'ok-name'],
    },
  });
  const options = (started[0] as { options: Record<string, unknown> }).options;
  assert.deepEqual(options.phaseOptions, {
    1: { model: 'fable', effort: 'max' },
    2: { model: 'claude-opus-5[1m]' },
    4: { tools: ['Read', 'Edit'] },
  }, 'every spelling the CLI takes survives; anything else is dropped, and a phase left with nothing goes with it');
  assert.deepEqual(options.skills, ['systematic-debugging', 'plugin:test-first', 'ok-name']);
});

test('a per-phase skills-off survives the door, and a false one leaves no trace', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: {
      phaseOptions: {
        1: { skillsOff: true },
        2: { skillsOff: false },        // the same as not saying it
        3: { skillsOff: 'yes' },        // a string is not a decision
        4: { skillsOff: true, skills: ['investigate'] },
      },
    },
  });
  const options = (started[0] as { options: Record<string, unknown> }).options;
  // Phases 2 and 3 are absent entirely: writing `skillsOff: false` would put a
  // key on a row where nothing was chosen, and the row would then read as an
  // override in the console's own "N overridden" count.
  assert.deepEqual(options.phaseOptions, {
    1: { skillsOff: true },
    4: { skills: ['investigate'], skillsOff: true },
  });
});

test('an effort the CLI would silently ignore is refused at the door', async () => {
  // Was: started the run and dropped the effort, so a typo ran a whole plan at
  // the wrong one. The CLI itself only warns, which is precisely why this has
  // to be the layer that refuses.
  const out = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { effort: 'ludicrous' },
  });
  assert.equal(out.status, 400);
  assert.match(String((out.payload as { error?: string }).error), /effort must be one of/);
  assert.equal(out.started.length, 0);
});

test('a run-level model may be an alias, a full id, or either at 1M', async () => {
  for (const model of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]']) {
    const { started } = await call('/api/run/demo/start', {
      method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
      body: { model },
    });
    assert.equal((started[0] as { options: { model?: string } }).options.model, model, model);
  }
  const bad = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { model: 'gpt-4' },
  });
  assert.equal(bad.status, 400);
  assert.match(String((bad.payload as { error?: string }).error), /must name a Claude model/);
});

test('a start request may name the only phases it wants, and they are sanitised', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    // Junk a browser could send: duplicates, a fraction, zero, a negative, a
    // numeric string, a word. Only whole positive phases survive.
    body: { onlyPhases: [3, 3, 2.5, 0, -1, '4', 'x'] },
  });
  assert.deepEqual((started[0] as { options: { onlyPhases: number[] } }).options.onlyPhases, [3, 4]);
});

test('an unknown autonomy value falls back to the run default', async () => {
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'yolo' },
  });
  assert.equal((started[0] as { options: { autonomy: string } }).options.autonomy, 'keep-going');
});

test('halting on everything is still reachable, and only by asking for it', async () => {
  // The flip moved the default, not the option. Unlike `permissionProfile` —
  // where an unrecognised value must land on the narrow choice, because getting
  // that one wrong grants trust — autonomy defaults to the wide one, so the
  // cautious side is the one worth proving still arrives when asked for.
  const { started } = await call('/api/run/demo/start', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { autonomy: 'halt-on-everything' },
  });
  assert.equal(
    (started[0] as { options: { autonomy: string } }).options.autonomy,
    'halt-on-everything',
  );
});

test('every control verb goes through the service, so it works after a restart', async () => {
  // The regression this exists for: `pause` called `runner.pause()` from the
  // route, and that method returns silently when no loop is driving the run —
  // which is true of EVERY run after a console restart. The button stayed on
  // screen, the API answered 200, and nothing happened. Stop, Skip and Retry
  // were fixed for exactly this; Pause was left behind.
  for (const [verb, method] of [
    ['pause', 'pauseRun'], ['resume', 'resumePause'], ['stop', 'stopRun'],
    ['skip', 'skipPhase'], ['retry', 'retryPhase'], ['settings', 'configureRun'],
    ['ask', 'askRun'],
  ]) {
    const { status, calls } = await call(`/api/run/demo/${verb}`, {
      method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body: { phase: 2 },
    });
    assert.equal(status, 200, verb);
    assert.deepEqual(calls.map((c) => c.method), [method], `${verb} must reach service.${method}`);
  }
});

test('a question that lands nowhere answers 409, not 200', async () => {
  // Well formed, nothing listening. A 200 here would tell the console the
  // question was delivered, and it would show it in the transcript as if a
  // session had heard it — which is exactly the lie this whole change is about.
  const { status } = await call('/api/run/demo/ask', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    body: { question: 'anyone there?' },
  });
  assert.equal(status, 200, 'the stub service says it landed');

  const refused = await callWith(
    { askRun: () => ({ ok: false, reason: 'nothing is running' }) },
    '/api/run/demo/ask',
    { question: 'anyone there?' },
  );
  assert.equal(refused.status, 409);
  assert.match(String((refused.payload as { reason: string }).reason), /nothing is running/);
});

test('pause is refused without --allow-run, like every other control', async () => {
  for (const verb of ['pause', 'resume', 'settings', 'ask', 'ultrareview']) {
    const { status, calls } = await call(`/api/run/demo/${verb}`, {
      method: 'POST', headers: { 'x-phase-console': '1' }, body: {},
    });
    assert.equal(status, 403, verb);
    assert.equal(calls.length, 0, `${verb} must not touch the run behind a refusal`);
  }
});

test('the one-click cloud review answers the REVIEW, never a run', async () => {
  const { status, payload, calls } = await callWith(
    {
      ultraReviewNow: (...args: unknown[]) => {
        calls0.push({ method: 'ultraReviewNow', args });
        return Promise.resolve({ slug: 'demo', phase: 3, state: 'landed', verdict: 'commented', findings: 2, ms: 91_000 });
      },
    },
    '/api/run/demo/ultrareview', {},
  );
  assert.equal(status, 200);
  // The whole point of the shape: a review that could not happen must not be
  // reported as a run that carried on, so the answer is the review's own
  // three-state result rather than `{ run }` like every neighbouring verb.
  assert.deepEqual(payload, {
    slug: 'demo', phase: 3, state: 'landed', verdict: 'commented', findings: 2, ms: 91_000,
  });
  assert.equal(calls.length, 0, 'and it reached no other run control');
  assert.deepEqual(calls0.map((c) => c.method), ['ultraReviewNow']);
  assert.deepEqual(calls0[0].args, ['demo']);
  calls0.length = 0;
});

test('a run with nothing to review is a 409 that says so', async () => {
  const { status, payload } = await callWith(
    { ultraReviewNow: () => Promise.reject(new Error('no phase of demo has finished, so there is nothing to review')) },
    '/api/run/demo/ultrareview', {},
  );
  assert.equal(status, 409);
  assert.match(String((payload as { error: string }).error), /nothing to review/);
});

test('a settings patch carries only the keys that were sent', async () => {
  const { calls } = await call('/api/run/demo/settings', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' },
    // `status` and `spentUsd` are records of what happened, not choices — a
    // patch endpoint that accepted them would let a browser rewrite history.
    body: { model: 'fable', status: 'finished', spentUsd: 0, runBudgetUsd: 9 },
  });
  assert.deepEqual(calls[0].args[1], { model: 'fable', runBudgetUsd: 9 });
});

test('the policy can be tightened from the console and never widened', async () => {
  const seen: unknown[] = [];
  const service = {
    policy: () => ({ defaults: {}, extra: {}, effective: {}, file: '/x' }),
    addPolicy: (rules: unknown) => { seen.push(rules); return { ok: true }; },
  };

  const read = await call('/api/policy', { overrides: service });
  assert.equal(read.status, 200);

  // Adding to allow would widen what an unattended agent may do at 3am. That
  // is a deliberate file edit, not something a click can do.
  const widened = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { allow: ['Bash(rm:*)'] },
    overrides: { ...service, flags: { allowWrites: true, allowRun: true, scriptsDir: '/x' } },
  });
  assert.equal(widened.status, 400);
  assert.equal(seen.length, 0, 'nothing was written behind the refusal');

  const tightened = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { deny: ['Bash(task deploy:*)'], junk: 1 },
    overrides: { ...service, flags: { allowWrites: true, allowRun: true, scriptsDir: '/x' } },
  });
  assert.equal(tightened.status, 200);
  assert.deepEqual(seen, [{ deny: ['Bash(task deploy:*)'], ask: [] }]);
});

test('changing the policy needs --allow-writes, and reading it does not', async () => {
  const refused = await call('/api/policy', {
    method: 'POST', headers: { 'x-phase-console': '1' }, body: { deny: ['Bash(x:*)'] },
    overrides: { policy: () => ({}), addPolicy: () => { throw new Error('must not be reached'); } },
  });
  assert.equal(refused.status, 403);
  assert.match(String((refused.payload as { error: string }).error), /--allow-writes/);
});

test('the skills a session could invoke are readable without any flag', async () => {
  const listed = await call('/api/skills', {
    overrides: { skills: () => [{ id: 'investigate', name: 'investigate', description: 'x', source: 'personal' }] },
  });
  assert.equal(listed.status, 200);
  assert.equal((listed.payload as { id: string }[])[0].id, 'investigate');
});

test('reading a run needs no flag — only changing one does', async () => {
  const listed = await call('/api/runs');
  assert.equal(listed.status, 200);
  const one = await call('/api/run/demo');
  assert.equal(one.status, 200);
  assert.equal((one.payload as { run: { id: string } }).run.id, 'r1');
  // The estimate rides on this response rather than having an endpoint of its
  // own, so that it and the board it rests on are answered from one read.
  assert.ok('eta' in (one.payload as Record<string, unknown>));
  // Per live lane: the answer to "is this lane working", beside the run it is
  // about rather than one request later.
  assert.ok('liveness' in (one.payload as Record<string, unknown>));
  // …and where the run's branch stands, for the same reason plus one: it is
  // `null` for every shared run, and an endpoint that mostly answers "nothing
  // here" teaches a client to stop asking. `in` rather than a truth check —
  // the KEY is the contract, and `null` is a real answer.
  assert.ok('git' in (one.payload as Record<string, unknown>));
  assert.equal((one.payload as { git: unknown }).git, null);
  const journal = await call('/api/run/demo/journal');
  assert.equal(journal.status, 200);
  // The plan's whole ruling ledger, which answers even for a plan with no run.
  const rulings = await call('/api/run/demo/rulings');
  assert.equal(rulings.status, 200);
  assert.deepEqual((rulings.payload as { rulings: unknown[] }).rulings, []);
});

test('dismissing a run card names the run, and refuses without one', async () => {
  const headers = { 'x-phase-console': '1' };

  // Run-class, like every other verb that edits a run record.
  const refused = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: { runId: 'r1' },
  });
  assert.equal(refused.status, 403);

  // A dismissal without a run id is a request to resolve "whichever run" —
  // which on a plan that has run since is not the one whose card was pressed.
  const vague = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: {}, allowRun: true,
  });
  assert.equal(vague.status, 400);

  const done = await call('/api/run/demo/resolve', {
    method: 'POST', headers, body: { runId: 'r1', note: 'handoff landed later' }, allowRun: true,
  });
  assert.equal(done.status, 200);
  assert.deepEqual(done.calls.map((c) => c.method), ['resolveRun']);
  assert.equal(done.calls[0].args[0], 'demo');
  assert.equal(done.calls[0].args[1], 'r1');
  assert.equal((done.calls[0].args[2] as { note: string }).note, 'handoff landed later');

  const back = await call('/api/run/demo/unresolve', {
    method: 'POST', headers, body: { runId: 'r1' }, allowRun: true,
  });
  assert.equal(back.status, 200);
  assert.deepEqual(back.calls.map((c) => c.method), ['unresolveRun']);
});

test('a scoped read never falls through to marking the whole inbox', async () => {
  const headers = { 'x-phase-console': '1' };
  const post = (body: unknown) => call('/api/notifications/read', { method: 'POST', headers, body });

  // A scope goes to the scoped verb, and only to it. If this fell through, the
  // page that fires it on load would clear an inbox it was scoped away from.
  const scoped = await post({ slug: 'alpha' });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.calls.map((c) => c.method), ['markNotificationsReadFor']);
  assert.deepEqual(scoped.calls[0].args[0], { slug: 'alpha' });

  const session = await post({ sessionId: '84c324dd3ef9', phase: 3 });
  assert.deepEqual(session.calls[0].args[0], { sessionId: '84c324dd3ef9', phase: 3 });

  // Blank strings are a route that has not parsed yet — and the branch is
  // chosen by the KEY being present, not by the value being usable. Reading
  // this as "no scope" sends it down the bulk path, where it clears the entire
  // inbox; a scratch console was observed doing exactly that. It reaches the
  // scoped verb with an empty scope instead, which matches nothing.
  const blank = await post({ slug: '', category: '' });
  assert.deepEqual(blank.calls.map((c) => c.method), ['markNotificationsReadFor']);
  assert.deepEqual(blank.calls[0].args[0], {}, 'a blank scope must clear nothing, not everything');

  // And the two long-standing shapes still mean exactly what they did.
  const all = await post({});
  assert.deepEqual(all.calls.map((c) => c.method), ['markNotificationsRead']);
  const ids = await post({ ids: ['a', 'b'] });
  assert.deepEqual(ids.calls[0].args[0], ['a', 'b']);
});

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

const { preflight } = await import('../server/runner/runner.ts');

test('an untrusted workspace no longer blocks a run', async () => {
  // This used to refuse, on the grounds that Claude Code ignores a repository's
  // own permissions and hooks until its trust prompt is accepted. Measured
  // against CLI v2.1.220 in a directory with no trust record at all: a repo
  // PreToolUse hook fired, and a repo `permissions.deny` rule blocked the
  // command. The premise had stopped being true, and the refusal was blocking
  // runs in every repo the operator had not opened interactively.
  const dir = mkdtempSync(join(tmpdir(), 'pc-trust-'));
  const config = join(dir, 'claude.json');
  writeFileSync(config, JSON.stringify({ projects: { '/repo': { hasTrustDialogAccepted: false } } }));
  assert.equal(preflight('/repo', config), null);
  assert.equal(preflight('/somewhere-else', config), null);
  assert.equal(preflight('/repo', join(dir, 'missing.json')), null);
  rmSync(dir, { recursive: true, force: true });

  // And end to end: a run in such a workspace actually runs.
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  assert.deepEqual(seen, [1], 'the phase ran rather than parking on a stale premise');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The admission endpoints
 * ------------------------------------------------------------------ */

test('the queue is readable without a flag, and says what each entry is waiting on', async () => {
  const snapshot = {
    max: 3,
    live: 1,
    queued: 1,
    throttledUntil: null,
    grants: [{ id: 'g1', slug: 'alpha', phase: 1, runId: 'r1', scope: ['api'], at: 0 }],
    entries: [{
      id: 'e1', slug: 'beta', phase: 2, runId: 'r2', scope: ['api'], since: 0,
      bypassed: 0, reserving: false,
      waitingOn: [{
        kind: 'grant', slug: 'alpha', phase: 1, owner: 'autopilot/r1',
        scope: ['api'], overlaps: ['api'],
      }],
    }],
  };
  // No `--allow-run`, no console header: reading the queue changes nothing, and
  // a queue only the console can see is one nobody checks from a phone.
  //
  // `queueAdvice` is stubbed alongside the snapshot because the door reads
  // BOTH since console-concurrent-plans P17 — the ordering advice (remaining
  // weight and an ETA per queued plan) rides this GET rather than the `state`
  // payload or the `run:queue` event, precisely so a board read per queued
  // plan is charged to the page that asked for it and to nothing else.
  const advice = [{ slug: 'beta', remainingWeight: 12, remainingPhases: 3, label: '~2–4 h left' }];
  const { status, payload } = await call('/api/queue', {
    overrides: { queueSnapshot: () => snapshot, queueAdvice: async () => advice },
  });
  assert.equal(status, 200);
  const body = payload as typeof snapshot & { advice: typeof advice };
  assert.equal(body.max, 3);
  assert.equal(body.queued, 1);
  assert.deepEqual(body.advice, advice, 'the advice rides the read, not the event');
  // The part that matters: "queued" alone is the same non-answer `pausing`
  // used to be — it names something that is not happening without naming what
  // would have to change for it to happen.
  assert.equal(body.entries[0].waitingOn[0].owner, 'autopilot/r1');
  assert.deepEqual(body.entries[0].waitingOn[0].overlaps, ['api']);
});

test("a plan's phase scopes are readable, with what each one would collide with", async () => {
  const scopes = [
    { phase: 1, scope: ['api'], conflicts: ['beta phase 3 (running)'] },
    { phase: 2, scope: ['docs'], conflicts: [] },
  ];
  const { status, payload } = await call('/api/run/demo/scopes', {
    overrides: { phaseScopes: (slug: string) => (slug === 'demo' ? scopes : []) },
  });
  assert.equal(status, 200);
  assert.deepEqual((payload as { scopes: unknown }).scopes, scopes);
});

/* ------------------------------------------------------------------ *
 * The stop's paperwork: `resolved` / `reopenedAt` across lives of a run
 * ------------------------------------------------------------------ */

test('continuing a resolved run clears the resolution, so a second halt raises a card', async () => {
  const r = repo();
  // First life: the session claims success and writes nothing — halt #1.
  const liar: SpawnFn = async () => ok({ resultText: 'Phase complete!' });
  const first = runner(r, liar);
  await first.instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await first.instance.wait();
  const stopped = first.instance.current()!;
  assert.equal(stopped.status, 'parked');

  // The stop gets annotated — as the board resolver or an operator would —
  // and the phase is reset the way Retry resets it.
  const edited = loadRun(r.root, 'demo', stopped.id, null)!;
  edited.resolved = { at: new Date().toISOString(), auto: true, reason: 'superseded — test annotation' };
  edited.phases['1'].status = 'pending';
  edited.phases['1'].note = undefined;
  saveRun(edited);

  // Second life: Continue. The session still writes nothing — halt #2 must
  // surface, which it cannot if the first stop's annotation survived.
  const second = runner(r, liar);
  await second.instance.start({ slug: 'demo', root: r.root, resumeRunId: stopped.id, autonomy: 'keep-going' });
  await second.instance.wait();

  const state = second.instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.resolved, null, 'the old annotation cannot dismiss the new stop');
  assert.equal(state.reopenedAt, null, 'the old veto was about a stop that no longer exists');
  r.cleanup();
});

test("a new halt clears a stale resolution but keeps a person's reopen-veto", async () => {
  const r = repo();
  // The annotation appears while the run is live — the one path `start` and
  // `recover` cannot have cleaned up — and then the halt fires.
  let handle: InstanceType<typeof Runner> | null = null;
  const spy: SpawnFn = async () => {
    const state = handle!.current()!;
    state.resolved = { at: new Date().toISOString(), auto: true, reason: 'stale annotation from an earlier stop' };
    state.reopenedAt = '2026-08-04T00:00:00.000Z';
    return ok({ resultText: 'wrote nothing' });
  };
  const { instance } = runner(r, spy);
  handle = instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.resolved, null, 'a new halt is a new fact — the stale annotation goes');
  assert.equal(state.reopenedAt, '2026-08-04T00:00:00.000Z',
    "a person's veto on auto-resolution is never re-inferred away");
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Boarding is not starting: the pause window and the pointer
 * ------------------------------------------------------------------ */

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a pause armed while the gate is checked starts nothing and queues nothing', async () => {
  const r = repo();
  r.setSlowGate(true);
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await sleepMs(300); // inside the 1s gate subprocess for phase 1
  assert.equal(instance.pause('test'), true);
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.deepEqual(seen, [], 'no session spawned');
  const journal = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string; data?: { reason?: string } });
  assert.ok(journal.some((j) => j.event === 'phase.not-started' && /gate was checked/.test(j.data?.reason ?? '')),
    'the abandonment wrote itself down');
  assert.ok(!journal.some((j) => j.event === 'phase.queued'), 'the phase never visibly queued');
  assert.ok(!journal.some((j) => j.event === 'phase.start'), 'the phase never started');
  r.cleanup();
});

test('the run does not claim a phase until it genuinely starts', async () => {
  const r = repo();
  r.setSlowGate(true);
  const during: (number | null | undefined)[] = [];
  let instance!: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async () => {
    during.push(instance.current()!.activePhase); // sampled at spawn time
    r.markDone(1);
    return ok();
  };
  const made = runner(r, spawn);
  instance = made.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await sleepMs(300); // mid-gate: boarding, not started
  const midBoarding = instance.current()!.activePhase;
  await instance.wait();

  assert.equal(midBoarding, null, 'boarding must not move the pointer');
  assert.deepEqual(during, [1], 'the pointer lands exactly at spawn');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Retry acts: a stopped run's Retry resets the phase AND continues the run
 * ------------------------------------------------------------------ */

test('retry on a stopped run resets the phase and starts the run again', async () => {
  const r = repo();
  const { Service } = await import('../server/service.ts');
  const { phaseRecord: recordOf } = await import('../server/runner/state.ts');
  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: r.scripts, logFile: null,
  } as never);
  try {
    assert.equal(service.open(r.root).ok, true);

    // A halted, SCOPED run with a failed phase and a sticky skills list — the
    // two fields a careless resume silently loses.
    const stopped = newRun({ slug: 'demo', root: r.root, model: 'opus', onlyPhases: [1], skills: ['alpha-skill'] });
    stopped.status = 'halted';
    stopped.halt = { at: new Date().toISOString(), reason: 'phase 1 did not verify: stub', phase: 1 };
    stopped.consecutiveFailures = 1;
    const record = recordOf(stopped, 1);
    record.status = 'failed';
    record.note = 'stub failure';
    record.endedAt = new Date().toISOString();
    saveRun(stopped);

    const calls: { slug: string; options: Record<string, unknown> }[] = [];
    (service as unknown as { startRun: unknown }).startRun =
      async (slug: string, options: Record<string, unknown>) => { calls.push({ slug, options }); return null; };

    await service.retryPhase('demo', 1);

    assert.equal(calls.length, 1, 'retry on a dead run STARTS the run — resetting the record alone was the old lie');
    assert.equal(calls[0].options.resumeRunId, stopped.id);
    assert.deepEqual(calls[0].options.onlyPhases, [1], 'a scoped run keeps its scope across the retry');
    assert.deepEqual(calls[0].options.skills, ['alpha-skill'], 'the sticky skills survive; machine defaults must not replace them');

    const onDisk = loadRun(r.root, 'demo', stopped.id, null)!;
    assert.equal(onDisk.phases['1'].status, 'pending');
    assert.equal(onDisk.halt, null);
    assert.equal(onDisk.consecutiveFailures, 0);
  } finally {
    service.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Credential preflight (phase 11, ZTD-4 / ACC-1.4): a named credential nobody
 * holds is found before the spawn, never after the spend
 * ------------------------------------------------------------------ */

test('under `credential policy: require` a phase naming an unheld credential never spawns and journals phase.credential-preflight', async () => {
  const r = repo();
  const seen: number[] = [];
  const asked: string[][] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '`true`', undefined, {
    planCredentials: () => ({ ids: ['gh', 'env:DEPLOY_KEY'], policy: 'require' }),
    credentialsHeld: async (ids) => {
      asked.push([...ids]);
      return ids.map((id) => id === 'gh'
        ? { id, status: 'ok', reason: 'gh auth status: signed in' }
        : { id, status: 'fail', reason: '$DEPLOY_KEY is not set in the console\'s environment' });
    },
  });
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1],
    manifest: {
      decisions: [{ key: 'credentials', value: '`gh`, `env:DEPLOY_KEY`', owner: 'operator', state: 'answered', source: 'plan', blocking: 'yes', origin: 'plan' }],
      accounts: [], credentials: { policy: 'require', ids: ['gh', 'env:DEPLOY_KEY'], held: ['gh'], missing: [] },
      delivery: { ok: true, channels: [], acknowledged: false }, probes: {}, at: '2026-09-14T00:00:00.000Z',
    },
  });
  await instance.wait();
  const state = instance.current()!;
  assert.deepEqual(seen, [], 'no session was spawned for a phase whose credential is not held');
  assert.deepEqual(asked, [['gh', 'env:DEPLOY_KEY']]);
  assert.equal(state.phases['1'].status, 'parked');
  assert.match(state.phases['1'].note ?? '', /credential policy is require and env:DEPLOY_KEY is not held/);
  const [preflight] = journalled(events, 'phase.credential-preflight');
  assert.deepEqual(preflight, { ids: ['gh', 'env:DEPLOY_KEY'], held: ['gh'], missing: ['env:DEPLOY_KEY'], policy: 'require' });
  // The class's errand, with the id and the reason — and the run's manifest row now reads outstanding.
  const errand = state.recoveries?.['1']?.errand;
  assert.equal(errand?.situation, 'blocked-declared:credential');
  assert.equal(errand?.decisionKey, 'credentials');
  assert.match(errand?.need ?? '', /`env:DEPLOY_KEY` \(\$DEPLOY_KEY is not set/);
  assert.equal(state.manifest?.decisions[0].state, 'outstanding');
  assert.match(state.manifest?.decisions[0].value ?? '', /not held on this console \(phase 1\); policy require/);
  assert.ok(!journalled(events, 'phase.session').length, 'nothing was spent');
  r.cleanup();
});

test('under `credential policy: continue` the phase boards, is told which credentials are missing, and the record says so', async () => {
  const r = repo();
  const prompts: string[] = [];
  const spawn: SpawnFn = async (request) => {
    prompts.push(request.prompt);
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? 0);
    r.markDone(phase);
    return ok();
  };
  const { instance, events } = runner(r, spawn, '`true`', undefined, {
    planCredentials: () => ({ ids: ['env:DEPLOY_KEY'], policy: 'continue' }),
    credentialsHeld: async (ids) => ids.map((id) => ({ id, status: 'fail', reason: '$DEPLOY_KEY is not set' })),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'done');
  assert.deepEqual(state.phases['1'].credentialsMissing, [{ id: 'env:DEPLOY_KEY', reason: '$DEPLOY_KEY is not set' }]);
  assert.match(prompts[0], /credential this console could not find before it started you: `env:DEPLOY_KEY` \(\$DEPLOY_KEY is not set\)/);
  assert.match(prompts[0], /blocked --needs credential/);
  const [preflight] = journalled(events, 'phase.credential-preflight');
  assert.deepEqual(preflight, { ids: ['env:DEPLOY_KEY'], held: [], missing: ['env:DEPLOY_KEY'], policy: 'continue' });
  // A registry that cannot answer refuses nothing.
  const r2 = repo();
  const seen: number[] = [];
  const { instance: i2, events: e2 } = runner(r2, workingSession(r2, seen), '`true`', undefined, {
    planCredentials: () => ({ ids: ['gh'], policy: 'require' }),
    credentialsHeld: async () => { throw new Error('no registry here'); },
  });
  await i2.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', onlyPhases: [1] });
  await i2.wait();
  assert.deepEqual(seen, [1], 'the phase ran');
  assert.equal(journalled(e2, 'phase.credential-preflight')[0].skipped, 'no registry here');
  r.cleanup();
  r2.cleanup();
});

/* ------------------------------------------------------------------ *
 * Verification preflight: read the plan before paying for a session
 * ------------------------------------------------------------------ */

test('a verification with nothing runnable parks the phase BEFORE a session is spent', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen),
    'targeted pytest + full safe set; both green.');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  const state = instance.current()!;
  assert.deepEqual(seen, [], 'no session was spawned for a phase that could never verify');
  assert.equal(state.phases['1'].status, 'parked');
  assert.match(state.phases['1'].note ?? '', /nothing the runner can execute/);
  assert.match(state.phases['1'].note ?? '', /then Retry/);
  const journal = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string });
  assert.ok(journal.some((j) => j.event === 'phase.verify-preflight-parked'));
  r.cleanup();
});

test('a plan with no verification at all parks the same way, saying so', async () => {
  const r = repo();
  const seen: number[] = [];
  // '' rather than undefined: the helper's parameter default would silently
  // substitute '`true`' for undefined — the exact defaulted-parameter trap
  // this repo's own history warns about.
  const { instance } = runner(r, workingSession(r, seen), '');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [], 'no session for a phase nothing would prove');
  assert.match(instance.current()!.phases['1'].note ?? '', /states no verification/);
  r.cleanup();
});

test('with allowUnverifiedPhases on, a plan with no verification boards and passes on its handoff — journalled as waived, never as "0 commands green"', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '', undefined, {
    allowUnverifiedPhases: () => true,
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [1], 'the phase boarded');
  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'done', record.note);
  assert.equal(record.verification?.ok, true);
  assert.deepEqual(record.verification?.ran, []);
  assert.match(record.verification?.reason ?? '', /passed on the handoff \(allowUnverifiedPhases\)/);
  const journal = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string; data?: Record<string, unknown> });
  assert.deepEqual(
    journal.filter((j) => j.event === 'phase.verify-waived').map((j) => j.data?.stage),
    ['preflight', 'verify'],
    'both the boarding and the verification say the bar was waived, and by which preference',
  );
  assert.ok(!journal.some((j) => j.event === 'phase.verify-preflight-parked'), 'no park');
  assert.ok(!journal.some((j) => j.event === 'phase.awaiting-verification'), 'no card — nothing was left for a person');
  r.cleanup();
});

test('allowUnverifiedPhases waives an OMITTED bullet only — a declared bullet the runner cannot read still parks', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '', undefined, {
    allowUnverifiedPhases: () => true,
    verificationDeclared: () => true,
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [], 'a formatting fault is the author\'s to hear about, whatever the preference');
  assert.match(instance.current()!.phases['1'].note ?? '', /exists in the plan but the console could not read/);
  assert.ok(!events.some((e) => e.event === 'run:journal' && (e.data as { event: string }).event === 'phase.verify-waived'));
  r.cleanup();
});

test('a declared-but-unreadable verification blames the shape, not the plan', async () => {
  const r = repo();
  const seen: number[] = [];
  // The parser handed over '' but the raw block DOES declare the bullet — the
  // real ai-builder shape. "The plan states no verification" here once sent an
  // operator hunting a bug in a plan that had none.
  const { instance } = runner(r, workingSession(r, seen), '', undefined, {
    verificationDeclared: () => true,
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, []);
  const note = instance.current()!.phases['1'].note ?? '';
  assert.match(note, /exists in the plan but the console could not read/);
  assert.match(note, /plan-format\.md/);
  assert.doesNotMatch(note, /states no verification/,
    'the omission message is reserved for plans that actually omit it');
  r.cleanup();
});

test('preflight warnings are journalled without blocking the phase', async () => {
  const r = repo();
  const seen: number[] = [];
  // One runnable command, one continuation fragment: the fragment becomes a
  // person-check later, and the preflight says so up front — but the phase runs.
  const { instance, events } = runner(r, workingSession(r, seen),
    '`true` plus the safe set `… -m "not slow" -q`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(seen, [1], 'a warning must not cost the phase');
  assert.equal(instance.current()!.phases['1'].status, 'done');
  const preflights = events.filter((e) => e.event === 'run:journal')
    .map((e) => e.data as { event: string; data?: { warnings?: string[] } })
    .filter((j) => j.event === 'phase.verify-preflight');
  assert.equal(preflights.length, 1);
  // Worded by autonomy: a keep-going run does not promise a question it will
  // (deliberately) not pose — "a person will be asked" on every phase of a
  // trusted run read as a wall of pending permission asks.
  assert.match(preflights[0].data?.warnings?.join('\n') ?? '', /left for a person on the record/);
  assert.doesNotMatch(preflights[0].data?.warnings?.join('\n') ?? '', /will be asked/,
    'keep-going must not promise a card it does not raise');
  // On the record too — the journal is rendered by nothing, and the operator's
  // first sight of these used to be the verification failing after the spend.
  assert.match(instance.current()!.phases['1'].preflight?.join('\n') ?? '', /left for a person on the record/);
  r.cleanup();
});

test('an all-verification park halts with a machine-readable kind and an anchor phase', async () => {
  const r = repo();
  const seen: number[] = [];
  // Unscoped: phase 1 parks at preflight, later phases stay waiting, so the
  // loop runs out of candidates with work outstanding — the real run's shape.
  const { instance } = runner(r, workingSession(r, seen), '');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.halt?.kind, 'verification-preflight',
    'auto-recovery keys on this — a kindless halt is invisible to it');
  assert.equal(state.halt?.phase, 1, 'recovery needs a phase to anchor on');
  assert.match(state.halt?.reason ?? '', /unrunnable §Verification takes a plan edit or Repair with AI/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Gates need your confirmation/,
    'no gate exists here — the old fixed tail advertised one anyway');
  assert.doesNotMatch(state.halt?.reason ?? '', /blocked handoff/,
    'no handoff is blocked either');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A parked run explains itself: every blocker in its own words
 * ------------------------------------------------------------------ */

test('a parked run names a gated phase with the gate note, and says what to do', async () => {
  const r = repo();
  r.setGate(1, 'manual: confirm the rollout window');
  const { instance } = runner(r, workingSession(r), '`true`', undefined, { delegateHumanGates: () => false });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt?.reason ?? '', /phase 1 is gated \(gate not clear/,
    'the gate itself is quoted, not summarised into "waiting on a gate"');
  assert.match(state.halt?.reason ?? '', /Gates need your confirmation/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Repair with AI/,
    'no blocked handoff and no verification park — the tail names only doors that exist');
  // `nothing-ready` since LFC-1: the kind names the SHAPE (nothing to run,
  // phases behind a person's door), and its profile offers no auto-recovery.
  assert.equal(state.halt?.kind, 'nothing-ready', 'a gate needs a person, never auto-recovery');
  r.cleanup();
});

test('a stuck phase is named as blocked-by-its-handoff, never "waiting on a gate"', async () => {
  const r = repo();
  r.setStuck(1);
  const { instance } = runner(r, workingSession(r));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.match(state.halt?.reason ?? '', /phase 1's handoff is marked blocked/);
  assert.match(state.halt?.reason ?? '', /Repair with AI/);
  assert.doesNotMatch(state.halt?.reason ?? '', /Gates need your confirmation/,
    'nothing here is gated — the tail names only doors that exist');
  assert.equal(state.halt?.kind, 'nothing-ready', 'a blocked handoff is not the verification kind');
  r.cleanup();
});

/* ---------------- per-lane stop, the streak, and the account preflight ---------------- */

test('continuing a run resets the failure streak, and says so in the journal', async () => {
  const r = repo();
  const held = streamingSession(r);
  const { instance } = runner(r, held.spawn);
  const stored = newRun({ slug: 'demo', root: r.root });
  stored.status = 'halted';
  stored.consecutiveFailures = 2;
  stored.halt = { at: new Date().toISOString(), reason: 'two failed in a row' };
  saveRun(stored);

  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going' });
  await held.inSession;
  // Asserted while a phase is STILL in flight: a success would reset the
  // streak anyway, and this test is about the press of Continue, not the win.
  assert.equal(instance.current()!.consecutiveFailures, 0,
    'the operator pressing Continue restores the failure budget');
  held.release();
  await instance.wait();

  const journal = readFileSync(journalFile(r.root, 'demo', stored.id), 'utf8');
  assert.match(journal, /run\.failure-streak-reset/);
  assert.match(journal, /"was":2/, 'the audit trail keeps what the counter loses');
  r.cleanup();
});

test('ACC-5.1 (RCV-3): an automatic relaunch carries the streak forward — no reset, no run.failure-streak-reset — and a person\'s press is what clears it', async () => {
  const r = repo();
  const held = streamingSession(r);
  const { instance, events } = runner(r, held.spawn);
  const stored = newRun({ slug: 'demo', root: r.root });
  stored.status = 'interrupted';
  stored.stoppedBy = 'system';
  stored.consecutiveFailures = 1;
  saveRun(stored);

  // The convergence loop's own relaunch: a door opened by a clock, no person in it.
  await instance.start({
    slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going',
    actor: doorActor('converge-relaunch', { by: 'converge', via: 'timer', origin: 'converge:timer', trigger: 'test', guard: 'automaticResumeGate', counter: 'MAX_BOOT_RESUMES:1/3' }),
  });
  await held.inSession;
  assert.equal(instance.current()!.consecutiveFailures, 1, 'the streak is carried, not zeroed');
  assert.equal(journalled(events, 'run.failure-streak-reset').length, 0, 'and nothing claims it was reset');
  const start = journalled(events, 'run.start');
  assert.equal(start.length, 1);
  assert.equal(start[0].door, 'converge-relaunch');
  held.release();
  await instance.wait();
  r.cleanup();
});

test('ACC-5.1 (RCV-3): a run whose streak is spent is refused an automatic relaunch with a named state — run.relaunch-refused, status untouched, no run.start', async () => {
  const r = repo();
  const spawns: SpawnRequest[] = [];
  const { instance, events } = runner(r, async (request) => {
    spawns.push(request);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  });
  const stored = newRun({ slug: 'demo', root: r.root });
  stored.status = 'halted';
  stored.stoppedBy = 'system';
  stored.consecutiveFailures = 2;
  stored.halt = { at: new Date().toISOString(), reason: '2 phases failed in a row', phase: 1, kind: 'failure-streak' };
  saveRun(stored);

  const refused = await instance.start({
    slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going',
    actor: doorActor('converge-relaunch', { by: 'converge', via: 'timer', origin: 'converge:timer', trigger: 'test', guard: 'automaticResumeGate', counter: 'MAX_BOOT_RESUMES:1/3' }),
  });
  await instance.wait();
  assert.equal(refused.status, 'halted', 'the state comes back untouched');
  assert.equal(refused.halt?.kind, 'failure-streak');
  assert.equal(refused.consecutiveFailures, 2);
  assert.equal(spawns.length, 0, 'nothing boarded');
  assert.equal(instance.current(), null, 'the runner holds no run it is not driving');
  const journal = readFileSync(journalFile(r.root, 'demo', stored.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = journal.find((l) => l.event === 'run.relaunch-refused');
  assert.ok(line, 'the refusal is a journalled state, not a silent no-op');
  assert.equal(line.data.reason, 'failure-streak');
  assert.equal(line.data.consecutiveFailures, 2);
  assert.equal(line.data.max, 2);
  assert.equal(line.data.door, 'converge-relaunch');
  assert.equal(line.data.via, 'timer');
  assert.ok(!journal.some((l) => l.event === 'run.start'), 'no run.start was written');
  assert.equal(journalled(events, 'run.start').length, 0);

  // …and the healer's own reboard door is NOT refused: the ladder is bounded
  // by its own caps, and the streak rides along to stop the next failure.
  const healed = await instance.start({
    slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going',
    actor: doorActor('converge-heal', { by: 'heal', via: 'timer', origin: 'converge:timer', trigger: 'verify-red', guard: 'ladder:reboard-fresh', counter: 'ladderPerPhaseRungs:1/3' }),
  });
  await instance.wait();
  assert.ok(spawns.length >= 1, 'the healer\'s door opens and the phase boards');
  assert.equal(journalled(events, 'run.start').length, 1, 'one run.start, the healer\'s');
  assert.equal(journalled(events, 'run.failure-streak-reset').length, 0, 'but it resets nothing on the way in');
  assert.equal(healed.status, 'finished', 'the streak carried in and was broken by a phase that succeeded');
  assert.equal(instance.current()?.consecutiveFailures, 0);
  r.cleanup();
});

test('a frozen lane can be stopped: woken first, credited, session id kept, streak untouched', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  const { instance } = runner(r, held.spawn);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.inSession;

  assert.equal(instance.freeze('test', 1), true);
  assert.equal(procState(pid), 'T');

  assert.deepEqual(instance.stopPhase(1, 'tester'), { ok: true });
  // SIGCONT before SIGTERM — a stopped process never sees a bare SIGTERM. The
  // sleeper dying of it is the observable proof the wake-up happened.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.notEqual(procState(pid), 'T', 'never left stopped behind a stop');

  held.release();
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'interrupted');
  assert.match(state.phases['1'].note ?? '', /stopped by tester/);
  assert.equal(state.phases['1'].resumeSessionId, 'session-to-resume-0001',
    'Retry can resume rather than restart');
  assert.equal(state.consecutiveFailures, 0, 'an operator stop is neither a failure nor a win');
  assert.equal(state.freeze, null);
  r.cleanup();
});

test('a per-phase stop carries phase and the DERIVED actor through the service, and a refusal answers 409', async () => {
  const { status, calls } = await call('/api/run/demo/stop', {
    method: 'POST', allowRun: true, headers: { 'x-phase-console': '1' }, body: { phase: 9, by: 'tester' },
  });
  assert.equal(status, 200);
  // The body's label is kept as `by`; the transport is read off the request
  // (SHD-3): a loopback Host with no User-Agent is a `script` over the `api`
  // from `local`, and no proxy vouched for anyone.
  assert.deepEqual(calls, [{
    method: 'stopRun', args: ['demo', 9, { by: 'tester', via: 'api', origin: 'local', remoteUser: null }],
  }]);

  const refused = await callWith(
    { stopRun: async () => { throw new Error('phase 9 is not one of the ones running — phases 1, 2 are'); } },
    '/api/run/demo/stop', { phase: 9 },
  );
  assert.equal(refused.status, 409);
  assert.match(String((refused.payload as { error: string }).error), /phase 9/);
});

test('a per-model limit files its wall against the account, and the run continues on the next model', async () => {
  const r = repo();
  const marked: { window: string; accountId?: string }[] = [];
  let spawns = 0;
  const limited: SpawnFn = async (request) => {
    spawns++;
    if (spawns === 1) {
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: "You've hit your Opus limit · resets 3:45pm" },
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, limited, '`true`', undefined, {
    // Pinned before 3:45pm for the same reason the pause-policy test pins it.
    now: () => new Date('2026-01-01T13:00:00'),
    leaveAccount: (accountId, leaving) => {
      marked.push({ ...(accountId ? { accountId } : {}), window: leaving.bucket ?? 'none' });
      return leaveStub(accountId, leaving);
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(marked, [{ window: 'seven_day_opus' }],
    'a model wall files under its per-model bucket, never the shared weekly');
  assert.equal(state.phases['1'].model, 'sonnet', 'and the phase moved down the ladder');
  r.cleanup();
});

test('the preflight probes the RUN’s account, and a refusal parks before any spawn', async () => {
  const r = repo();
  const probed: (string | undefined)[] = [];
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen), '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
    checkAuth: async (accountId) => { probed.push(accountId); return { loggedIn: true, checkedAt: '' }; },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();
  assert.deepEqual(probed, ['work'], 'the probe asks about the account that will pay');
  assert.ok(seen.length > 0, 'a healthy probe lets the run proceed');
  r.cleanup();

  const r2 = repo();
  const seen2: number[] = [];
  const second = runner(r2, workingSession(r2, seen2), '`true`', undefined, {
    checkAuth: async () => ({
      loggedIn: false, checkedAt: '',
      detail: 'the run is set to pay as work and that login is expired',
    }),
  });
  const parked = await second.instance.start({
    slug: 'demo', root: r2.root, autonomy: 'keep-going', accountId: 'work',
  });
  assert.equal(parked.status, 'parked');
  assert.match(parked.halt?.reason ?? '', /pay as work/,
    'the refusal names the account, not the workspace');
  assert.equal(seen2.length, 0, 'nothing spawned behind the refusal');
  r2.cleanup();
});

/* ------------------------------------------------------------------ *
 * The outcome protocol: declared waits, parks, and session-API resumes
 *
 * The incident these replay: delivery-overhaul phase 8. A session did 47
 * minutes of real work, ended its turn "waiting on the image build (34–65
 * min)" in free prose, and the runner — with no vocabulary for that — read
 * the clean exit as completion, found no handoff, nudged once (answered in
 * the same holding pattern), and halted the run. The outcome file is the
 * vocabulary; these pin what the runner does with it.
 * ------------------------------------------------------------------ */

function fileOutcome(request: SpawnRequest, body: Record<string, unknown>): void {
  const path = request.env?.PE_OUTCOME_FILE;
  assert.ok(typeof path === 'string' && path, 'the runner must inject PE_OUTCOME_FILE');
  writeFileSync(path as string, JSON.stringify({
    version: 1, slug: 'demo', written_at: new Date().toISOString(), watch: [], ...body,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a declared waiting-external parks the phase — no halt, no closeout nudge — and the resume continues the SAME session', async () => {
  const r = repo();
  try {
    const resumes: (string | undefined)[] = [];
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) {
        fileOutcome(request, {
          phase: 1, status: 'waiting-external',
          reason: 'image build 6a94a514',
          // Comfortably past the loop's own tick latency under full-suite
          // load: a window that lapses before the next board read makes the
          // loop resume IN-RUN (correct, but a different script than this
          // test narrates — the two-act version needs the run to park).
          resume_after: new Date(Date.now() + 2_000).toISOString(),
          watch: ['gh:hub#run/1234'],
        });
        return ok({ resultText: 'holding pattern' });
      }
      resumes.push(request.resume);
      assert.match(request.prompt, /wait window you declared/, 'a resume gets the elapsed-window prompt, not a fresh boot');
      r.markDone(1);
      return ok({ sessionId: 'sess-0001' });
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, { waitFloorMs: 20 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    let state = instance.current()!;
    assert.equal(state.status, 'waiting', 'the run waits with the phase — it is not halted');
    assert.equal(state.halt, null);
    assert.equal(state.phases['1'].status, 'waiting');
    assert.equal(state.phases['1'].parkReason, 'image build 6a94a514');
    assert.deepEqual(state.phases['1'].watch, ['gh:hub#run/1234']);
    assert.equal(state.phases['1'].waits, 1);
    assert.ok(state.waitUntil, 'the run carries the soonest park clock');
    // The clock says WHEN; only this says WHY. Without it every reader guesses,
    // and the console's own run card guessed "usage limit" at an account with
    // 28% of its window left — see `status-strip.test.tsx`.
    assert.equal(state.waitReason, 'external', 'and says which kind of wait it is');
    assert.ok(journalled(events, 'phase.waiting').length, 'the park is journalled');
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'no closeout nudge for a declared wait');

    // The window elapses; the service restarts the run (exactly what the boot
    // re-arm does). The loop routes the expired wait as a resume. Derived
    // from the recorded clock, not a fixed sleep — under full-suite load the
    // park lands later than this test scheduled it.
    await sleep(Math.max(0, Date.parse(state.waitUntil ?? '') - Date.now()) + 40);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1] });
    await instance.wait();

    state = instance.current()!;
    assert.deepEqual(resumes, ['sess-0001'], 'the resume continued the phase\'s own session');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('the wait budget is finite: a phase that keeps re-filing the same wait halts honestly', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'a build that never lands',
        resume_after: new Date(Date.now() + 15).toISOString(),
      });
      return ok();
    };
    const { instance } = runner(r, spawn, undefined, undefined, { waitFloorMs: 10 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    let state = instance.current()!;
    for (let round = 0; round < 6 && state.status === 'waiting'; round++) {
      await sleep(30);
      await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1] });
      await instance.wait();
      state = instance.current()!;
    }

    assert.equal(state.status, 'parked', 'the fourth re-file spends the budget');
    assert.equal(state.phases['1'].halt?.kind, 'waiting-external-timeout');
    // The sentence names WHICH ledger ran out — the declared waits, here, not
    // the hours (WAI-5: the halt must say which allowance was spent).
    assert.match(state.phases['1'].halt?.reason ?? '', /already declared 4 wait\(s\) — the most one phase may \(4\)/);
    assert.equal(state.phases['1'].status, 'failed');
  } finally { r.cleanup(); }
});

test('a closeout session that files waiting-external parks the phase instead of halting no-handoff', async () => {
  // The exact phase-8 shape: the first session ends without paperwork, the
  // nudge resumes it, and the honest answer is still "the external clock has
  // not landed" — which used to become the halt. Now it becomes the park.
  const r = repo();
  try {
    execFileSync('git', ['init', '-q'], { cwd: r.root });
    writeFileSync(join(r.root, 'half-finished.txt'), 'work in flight\n');
    let closeoutResume: string | undefined;
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) return ok({ resultText: 'ended without paperwork' });
      closeoutResume = request.resume;
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'deploys blocked on the image build',
        resume_after: new Date(Date.now() + 60_000).toISOString(),
      });
      return ok({ sessionId: 'sess-0001' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(calls, 2, 'the closeout nudge ran');
    assert.equal(closeoutResume, 'sess-0001', 'the nudge resumed the same session');
    assert.equal(state.halt, null, 'no no-handoff halt');
    assert.equal(state.status, 'waiting');
    assert.equal(state.phases['1'].status, 'waiting');
    assert.ok(journalled(events, 'phase.closeout').length, 'the closeout is on the record');
    assert.ok(journalled(events, 'phase.waiting').length);
  } finally { r.cleanup(); }
});

test('a session with no outcome and no work still halts no-handoff — the legacy pin', async () => {
  const r = repo();
  try {
    const { instance } = runner(r, async () => ok({ resultText: 'Phase complete!' }));
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.status, 'parked');
    assert.equal(state.phases['1'].halt?.kind, 'no-handoff');
    assert.match(state.phases['1'].halt?.reason ?? '', /the board still reads/);
  } finally { r.cleanup(); }
});

test('a stale outcome file from a previous attempt is ignored and the legacy path stands', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      // Written BEFORE the attempt started — a leftover from a crashed try.
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'ancient history',
        written_at: '2020-01-01T00:00:00Z',
      });
      return ok({ resultText: 'Phase complete!' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.phases['1'].halt?.kind, 'no-handoff', 'the stale declaration must not park anything');
    assert.equal(journalled(events, 'phase.outcome').length, 0, 'a rejected file is never journalled as an outcome');
    assert.equal(journalled(events, 'phase.waiting').length, 0);
  } finally { r.cleanup(); }
});

test('outcome blocked on a lock re-queues the phase without a halt; needs-human parks the run for a person', async () => {
  const r = repo();
  try {
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      if (calls === 1) {
        fileOutcome(request, {
          phase: 1, status: 'blocked', reason: 'lock held by mobinzarekar@laptop',
          watch: ['lock:demo/1'],
        });
        return ok();
      }
      r.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'done', 'the re-queued phase boarded again and finished');
    assert.equal(state.status, 'finished');
    assert.ok(journalled(events, 'phase.outcome-lock-blocked').length);
    assert.equal(journalled(events, 'run.halt').length, 0, 'a refused lock is not a defect');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, {
        phase: 1, status: 'needs-human', reason: 'the staging gate needs an operator',
        watch: ['gh:acme/app#run/123'],
      });
      return ok();
    };
    const { instance } = runner(r2, spawn);
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.status, 'parked', 'a person is needed — the approvals-park vocabulary');
    assert.match(state.halt?.reason ?? '', /needs a person: the staging gate/);
    assert.equal(state.halt?.kind, 'needs-human', 'the park carries its machine-readable class');
    assert.equal(state.phases['1'].status, 'parked');
    // The declaration is PERSISTED — the classifier reads this, not a regex
    // over the note, so a reason that mentions §Verification can never again
    // re-classify the park as "the plan is broken".
    assert.equal(state.phases['1'].declared?.status, 'needs-human');
    assert.equal(state.phases['1'].declared?.reason, 'the staging gate needs an operator');
    assert.deepEqual(state.phases['1'].declared?.watch, ['gh:acme/app#run/123']);
    assert.deepEqual(state.phases['1'].watch, ['gh:acme/app#run/123'], 'the refs ride the record for the poller');
    // The errand's sub-kind is read from the refs, never hardcoded unknown: a
    // gh ref is `external`, whose ladder is the free poll.
    assert.equal(state.recoveries?.['1']?.errand?.situation, 'blocked-declared:external');
    assert.equal(state.consecutiveFailures, 0, 'nobody being available is not the phase failing');
  } finally { r2.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Board freshness: the reconcile pass and the docs-watcher wake
 * ------------------------------------------------------------------ */

test('a failed record the board has overtaken is closed as "outside this run", never re-run', async () => {
  // The live shape: a run halts with a phase reading `failed`, somebody
  // finishes that phase by hand, the run is continued — and the stale record
  // used to stand forever ("Departed" board chip over a red row) while the
  // loop, with `failed` in SETTLED, wouldn't touch the phase either.
  const r = repo();
  try {
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'halted';
    stale.halt = { at: new Date().toISOString(), reason: 'no handoff', phase: 1, kind: 'no-handoff' };
    phaseRecord(stale, 1).status = 'failed';
    saveRun(stale);
    r.markDone(1); // …then somebody finished phase 1 by hand

    const seen: number[] = [];
    const { instance } = runner(r, workingSession(r, seen));
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: stale.id });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(seen, [2, 3], 'no session was spent on the phase somebody already did');
    assert.equal(state.phases['1'].status, 'done');
    assert.match(state.phases['1'].note ?? '', /closed outside this run/);
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('the docs watcher wakes a mid-flight loop: a newly-ready phase boards before any lane settles', async () => {
  const r = repo();
  try {
    const seen: number[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      seen.push(phase);
      if (phase === 1) {
        await held; // phase 1's session runs "for hours"
        r.markDone(1);
        return ok();
      }
      r.markDone(phase);
      return ok();
    };
    const { instance } = runner(r, spawn, undefined, undefined, { maxParallel: 2 });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxParallel: 2 });

    // Wait until phase 1's lane is live, then finish phase 1 OUTSIDE the run
    // (a manual session writing the handoff) and poke, exactly as the
    // service's onChange does.
    for (let i = 0; i < 100 && !seen.includes(1); i++) await sleep(10);
    r.markDone(1);
    instance.noteDocsChanged();

    // Phase 2 must board while lane 1 is still hanging.
    for (let i = 0; i < 200 && !seen.includes(2); i++) await sleep(10);
    assert.ok(seen.includes(2), 'the wake re-read the board mid-lane and admitted phase 2');

    releaseFirst();
    await instance.wait();
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Cross-actor locks: queue-behind, wait cap, and the lease keepalive
 * ------------------------------------------------------------------ */

test('a foreign lock at boarding queues the phase behind the holder, and boards when it frees', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    const seen: number[] = [];
    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, workingSession(r, seen), undefined, undefined, { scheduler });
    const started = instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });

    // Free the lock after the belt-check has seen it at least once.
    setTimeout(() => r.setLockRefused(false), 1_500);
    await started;
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.deepEqual(seen, [1], 'the phase boarded once the holder released');
    assert.equal(state.phases['1'].status, 'done');
    assert.ok(journalled(events, 'phase.lock-race').length, 'the wait was journalled, not parked');
    assert.equal(journalled(events, 'phase.lock-refused').length, 0, 'the terminal park is gone');
  } finally { r.cleanup(); }
});

test('a lock wait that outlives the cap parks honestly, naming the holder and the wait', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    // A run whose record says it has already queued behind this lock for
    // three hours — the cap is two.
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    const record = phaseRecord(stale, 1);
    record.lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked');
    assert.match(state.phases['1'].note ?? '', /locked by someone\/else and has waited/);
    assert.ok(journalled(events, 'phase.lock-wait-capped').length);
    // The clock stops with the wait. It used to survive the park — it is only
    // cleared after a SUCCESSFUL claim — so the next Retry measured from the
    // original timestamp, found itself still over the two-hour cap, and parked
    // again without waiting a second. Retry has to mean the wait starts over.
    assert.equal(state.phases['1'].lockWaitSince, undefined);
    // And the halt says so, rather than naming the holder and stopping.
    assert.match(state.halt?.reason ?? '', /waited out another plan's lock takes Retry/);
  } finally { r.cleanup(); }
});

test('D28/QA N-1: a halt holding BOTH park kinds carries BOTH remedies', async () => {
  // Since D28 a wait-cap park has two causes with two different remedies, and
  // the wrong one sends a person looking for a lock file that does not exist.
  // The first repair wrote them as `if` / `else if`, which traded one wrong
  // sentence for one MISSING one: a single cap-parked phase then suppressed the
  // lock sentence for every other parked phase in the same halt. They are two
  // independent `if`s now, like every other remedy in that block.
  const r = repo();
  try {
    r.setParallel(true);
    // A lock the belt-check keeps seeing, so the lock park is not re-armed out
    // from under the assertion; and no scheduler, so the cap park is not either
    // (no answer to "is a lane free?" ⇒ no re-arm — the fail-safe direction).
    r.setLockRefused(true);
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1, 2];
    const byLock = phaseRecord(stale, 1);
    byLock.status = 'parked';
    byLock.note = 'phase 1 is locked by someone/else and has waited 121 minutes for it';
    const byCap = phaseRecord(stale, 2);
    byCap.status = 'parked';
    byCap.note = 'phase 2 is held by 3 of 3 lanes (session cap) and has waited 121 minutes for it';
    saveRun(stale);

    const { instance } = runner(r, async () => ok());
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1, 2] });
    await instance.wait();

    const reason = instance.current()!.halt?.reason ?? '';
    assert.match(reason, /waited two hours for a free lane/, 'the cap remedy');
    assert.match(reason, /waited out another plan's lock/, 'AND the lock remedy — neither swallows the other');
  } finally { r.cleanup(); }
});

/**
 * autopilot-3: the same cap, on the path the phase actually takes.
 *
 * The test above reaches the cap through boarding's belt-check, which is only
 * reachable in the grant→spawn race window — the scheduler there is given an
 * EMPTY lock list, so admission never blocks. In the ordinary case admission
 * DOES block (a foreign same-phase lock is exactly what `conflictsFor` refuses
 * on), and the belt-check is never reached at all: the phase sat in the queue
 * with no cap, no park, and `lockWaitSince` never stamped, so nothing in the
 * console could say how long it had been waiting. CLAUDE.md claimed the bound
 * the whole time.
 */
test('a phase queued behind a foreign lock stamps its wait and parks at the cap (autopilot-3)', async () => {
  const r = repo();
  try {
    // The lock is real on BOTH sides — the scheduler's view below and the
    // script `rearmLockCapParks` asks. They are two different readers of one
    // fact, and a fixture that locks only one of them re-arms the park on the
    // very next tick (the rearm asks the SCRIPT whether the holder is gone),
    // which spins the loop rather than testing the cap.
    r.setLockRefused(true);
    // The wait began three hours ago; the cap is two. Seeded on the record
    // rather than slept for, exactly as the belt-check test does.
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    // A foreign lock the scheduler can see, overlapping this phase's scope —
    // so admission blocks and the belt-check is never reached.
    const scheduler = new Scheduler({
      locks: () => [{
        slug: 'other', phase: 9, owner: 'someone/else', expired: false,
        scope: ['blocked-repo'], leaseUntil: Date.now() + 30 * 60_000,
      }],
    });
    const seen: number[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
      return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      scheduler, phaseScope: () => ['blocked-repo'],
    });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.deepEqual(seen, [], 'nothing boarded into somebody else`s working tree');
    assert.equal(state.phases['1'].status, 'parked', 'the wait ended in an honest park, not a silent queue');
    assert.match(state.phases['1'].note ?? '', /locked by someone\/else and has waited/,
      'the park names the holder and the wait — LOCK_CAP_PARK_NOTE matches both paths to it');
    const capped = journalled(events, 'phase.lock-wait-capped');
    assert.ok(capped.length, 'the cap is journalled');
    assert.equal(capped[0].by, 'admission', 'and says which path capped it');
    // Retry means the two hours start over — the belt-check`s reasoning, and
    // it has to hold here too or Retry re-parks without waiting a second.
    assert.equal(state.phases['1'].lockWaitSince, undefined);
  } finally { r.cleanup(); }
});

/**
 * D28: the same cap, for the busiest configuration — and the one the bound
 * could not reach.
 *
 * `wouldBlock` returned the `session cap` pseudo-holder as an EARLY RETURN,
 * before the holder scan, and marked it `clock: true`. Both halves broke the
 * bound: the runner arms its two-hour cap only over holders that are NOT
 * clocks, so `cappable` was empty and `lockWaitSince` was never stamped. A
 * saturated fleet with one wedged lane therefore waited forever — D2's exact
 * shape, at the moment a console is under the most load, and the one wait
 * nothing in the console could even describe.
 *
 * Failing before the fix: with `clock: true` no cap is armed, the phase stays
 * queued and the run never settles, so this hangs rather than asserting.
 */
test('at the session cap a queued phase waits for a lane — it is NOT capped into a park', async () => {
  // D28 REVERSED (2026-08-30, R9). D28 made the session cap an honest holder so
  // a saturated fleet with one wedged lane could not wait without bound. The
  // cap is now narrowed to the one shape it was ever for — a foreign LOCK whose
  // session is not live — because parking the INNOCENT waiter is the wrong end
  // of the problem: the wedged lane is what the liveness watchdog exists to nudge,
  // recycle and park. A full fleet is a queue.
  //
  // ⚠️ The bound D28 added is genuinely gone. If a wedged lane ever escapes the
  // watchdog, the phases behind it queue rather than park. That trade is the
  // plan's (`console-unattended-autopilot` §Phase 1, R9) and is recorded in the
  // handoff's Outstanding section.
  const r = repo();
  try {
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    // The wait began three hours ago; the cap is two. Seeded rather than slept
    // for, exactly as the two tests above do.
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    // One lane, and a foreign run holding it — released below, because "some
    // other lane happens to finish" is exactly how this wait ends.
    const scheduler = new Scheduler({ max: 1, locks: () => [] });
    const wedged = await scheduler.admit({
      slug: 'other', phase: 1, runId: 'beefbeef', scope: ['elsewhere'],
    });
    assert.equal(scheduler.snapshot().live, 1, 'the fixture must actually saturate the fleet');

    const seen: number[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
      return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      scheduler, phaseScope: () => ['demo-repo'],
    });
    const started = instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    // A lane frees, which is how this wait was always going to end.
    setTimeout(() => scheduler.release(wedged), 150).unref?.();
    await started;
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.deepEqual(seen, [1], 'it boarded the moment a lane freed');
    assert.notEqual(state.phases['1'].status, 'parked', 'a full fleet is a queue, not a failure');
    assert.deepEqual(journalled(events, 'phase.lock-wait-capped'), [],
      'the session cap is not a foreign claim: nobody is squatting, the machine is busy');
  } finally { r.cleanup(); }
});

test('the lease keepalive refreshes the lock under the shared owner, and stands down on a foreign takeover', async () => {
  const claims = (r: Repo): string[] => {
    const path = join(r.state, 'locks');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((line) => /\bclaim\b/.test(line));
  };

  const r = repo();
  try {
    // The session holds its turn until the supervisor's keepalive has fired —
    // exactly the long-phase shape the keepalive exists for.
    const spawn: SpawnFn = async () => {
      for (let i = 0; i < 300 && !claims(r).length; i++) await sleep(10);
      r.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, { leaseRefreshMs: 40 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    // The FIRST claim is the runner's provisional one at grant (S1-a); the
    // keepalive's refreshes come after it, under the same owner.
    const refreshes = claims(r).filter((line) => !line.includes(`--lease ${PROVISIONAL_LEASE_S}`));
    assert.ok(refreshes.length >= 1, 'the keepalive fired while the session worked');
    assert.match(refreshes[0], /claim 1 --owner autopilot\/\S+ --scope /,
      'the refresh claims under the shared owner WITH the scope');
    assert.ok(journalled(events, 'phase.lock-refreshed').length, 'the refresh is on the record');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    r2.setClaimRefuse(true); // every claim answers "held by someone else"
    const spawn: SpawnFn = async () => {
      for (let i = 0; i < 300 && !claims(r2).length; i++) await sleep(10);
      await sleep(120); // long enough for a would-be second fire
      r2.markDone(1);
      return ok();
    };
    const { instance, events } = runner(r2, spawn, undefined, undefined, { leaseRefreshMs: 40 });
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1] });
    await instance.wait();

    // With every claim refused, the PROVISIONAL claim is refused too — which is
    // the TOCTOU caught one layer earlier than it used to be (S1-a): somebody
    // took the phase between the check and the claim, so no session is ever
    // spawned and there is no lane, no keepalive and no takeover to stand down
    // from. The phase PARKS, worded so `rearmLockCapParks` un-parks it when the
    // holder goes; it must not requeue, because that circuit is unbounded.
    // Bounded at `PROVISIONAL_REFUSAL_LIMIT`: this stub refuses every claim
    // while reporting the lock FREE, so each re-armable park is re-boarded and
    // refused again — until the bound makes the park stay put. That is the
    // whole reason the bound exists, and the count is the proof it holds.
    const refusals = journalled(events, 'phase.lock-provisional').length;
    assert.equal(refusals, PROVISIONAL_REFUSAL_LIMIT, 'every refusal is on the record, and it stops at the bound');
    assert.equal(journalled(events, 'phase.lock-lost').length, 0, 'nothing was ever held to lose');
    assert.equal(claims(r2).length, refusals, 'one claim per attempt, not a fight');
    const parked = instance.current()!.phases['1'];
    assert.equal(parked.status, 'parked');
    // A stub that refuses every claim while reporting the lock free is exactly
    // the disagreement the bound exists for: the first refusals park re-armably
    // (`LOCK_CAP_PARK_BY_LOCK`), and past `PROVISIONAL_REFUSAL_LIMIT` the park
    // stays put and says the two answers disagree — otherwise the re-arm
    // re-boards it for ever.
    assert.match(parked.note ?? '', /could not be claimed \d+ times running|is locked by .* and has waited/);
  } finally { r2.cleanup(); }
});

test('the keepalive states the runner OWN lease — RUNNER_LEASE_S, 5400 s — on every refresh', async () => {
  // The regression this pins: the argv was once written as
  // `3 × LEASE_REFRESH_MS` under a comment claiming 5400 seconds — which is 30
  // MINUTES, because that constant is in milliseconds. Two units in one
  // expression. The VALUE and the WIRING are pinned separately, so recomputing
  // the number from the cadence goes red here before any document goes stale.
  assert.equal(RUNNER_LEASE_S, 5400, 'the lease the documents state, in seconds');
  assert.equal(RUNNER_LEASE_S * 1000, 9 * LEASE_REFRESH_MS,
    'nine refresh cadences — eight missable ticks — the relationship the docs put in words');

  // REFRESHES, not every claim: the runner's provisional claim at grant states
  // `PROVISIONAL_LEASE_S` on purpose (S1-a — how long the world is wrong for if
  // the child never starts, not how long a phase may run).
  const claims = (r: Repo): string[] => {
    const path = join(r.state, 'locks');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n')
      .filter((line) => /\bclaim\b/.test(line) && !line.includes(`--lease ${PROVISIONAL_LEASE_S}`));
  };

  const r = repo();
  try {
    const spawn: SpawnFn = async () => {
      for (let i = 0; i < 300 && !claims(r).length; i++) await sleep(10);
      r.markDone(1);
      return ok();
    };
    const { instance } = runner(r, spawn, undefined, undefined, { leaseRefreshMs: 40 });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const refreshes = claims(r);
    assert.ok(refreshes.length >= 1, 'the keepalive fired while the session worked');
    assert.match(refreshes[0]!, /--lease 5400(?:\s|$)/,
      'the refresh states RUNNER_LEASE_S rather than inheriting the script default');
  } finally { r.cleanup(); }
});

test('sessions carry PE_MCP_SERVERS from the registry — and nothing when no registry is wired', async () => {
  // F15's MCP advisory was silently dead inside every unattended session:
  // sessions run validate.sh themselves, and launchd's env carries no
  // registry. Resolved per spawn; set-but-empty is a real answer.
  const r = repo();
  const envs: (string | undefined)[] = [];
  const spy: SpawnFn = async (request) => {
    envs.push(request.env?.PE_MCP_SERVERS);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance } = runner(r, spy, '`true`', undefined, {
    mcpIds: () => ['context7', 'sentry'],
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  assert.deepEqual(envs, ['context7 sentry', 'context7 sentry', 'context7 sentry']);
  r.cleanup();

  const bare = repo();
  const bareEnvs: (string | undefined)[] = [];
  const bareSpy: SpawnFn = async (request) => {
    bareEnvs.push(request.env?.PE_MCP_SERVERS);
    bare.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const plain = runner(bare, bareSpy);
  const hadEnv = process.env.PE_MCP_SERVERS;
  delete process.env.PE_MCP_SERVERS;
  try {
    await plain.instance.start({ slug: 'demo', root: bare.root, autonomy: 'keep-going' });
    await plain.instance.wait();
  } finally { if (hadEnv !== undefined) process.env.PE_MCP_SERVERS = hadEnv; }
  assert.deepEqual(bareEnvs, [undefined, undefined, undefined],
    'no registry wired means the advisory stays off — absent, not empty');
  bare.cleanup();
});

/* ------------------------------------------------------------------ *
 * The ladder in the loop: re-board by rung, brief by situation
 *
 * Phase 2 of console-zero-touch-autopilot. `interrupted` and `failed` records
 * stop being terminal: the loop classifies them (runner/situation.ts), climbs
 * one rung (runner/ladder.ts) through its own vehicles, and boards the phase
 * with the brief the rung names — fresh, resume, unblock, continue, closeout.
 * Every case here is one of the measured specimens or an exit criterion.
 * ------------------------------------------------------------------ */

/**
 * A git repository at the root, so the working tree can answer "clean". The
 * stub's own files (scripts, the done list, the plan) are ignored; `keep` names
 * paths that SHOULD show as work.
 */
function gitInit(root: string, keep: string[] = []): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), ['*', ...keep.map((path) => `!${path}`), ''].join('\n'));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

/** A session that works whichever brief boarded it: fresh boot, RESUMING, UNBLOCK. */
function briefedSession(
  r: Repo, log: { phase: number; brief: string; resume?: string; prompt: string }[],
  behave: (phase: number, call: number) => 'done' | 'nothing' = () => 'done',
): SpawnFn {
  let calls = 0;
  return async (request: SpawnRequest) => {
    calls++;
    const m = /(BOOT|RESUMING|UNBLOCK) phase (\d+)/.exec(request.prompt);
    const phase = Number(m?.[2]);
    log.push({ phase, brief: m?.[1] ?? '?', resume: request.resume, prompt: request.prompt });
    if (behave(phase, calls) === 'done') r.markDone(phase);
    return ok({ sessionId: `sess-${phase}` });
  };
}

const journalOrder = (events: { event: string; data: Record<string, unknown> }[], names: string[]): number[] =>
  names.map((name) => events.findIndex((e) => e.event === 'run:journal' && e.data.event === name));

test('ladder: a resumed run whose only open record is interrupted with no work boards that phase fresh — no press', async () => {
  const r = repo();
  try {
    gitInit(r.root);
    // The P12 specimen: a session that died during bootstrap, the console
    // gone with it; `interrupted`, no handoff, a clean tree.
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'parked';
    stale.phases['1'] = {
      phase: 1, status: 'interrupted', attempts: 1, costUsd: 1.44,
      note: 'the console stopped while phase 1 was running (pid 999)',
    };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going' });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(log.map((l) => l.phase), [1, 2, 3], 'phase 1 boarded on the first tick, then the rest');
    assert.equal(log[0].brief, 'BOOT', 'fresh = the engine prompt, nothing appended');
    assert.doesNotMatch(log[0].prompt, /RESUMING|What happened on the previous/, 'a never-started phase carries no history');
    assert.equal(log[0].resume, undefined, 'no dead session is resumed');
    assert.equal(state.status, 'finished');
    const situations = journalled(events, 'phase.situation');
    assert.equal(situations[0].situation, 'never-started');
    const rungs = journalled(events, 'phase.rung');
    assert.equal(rungs[0].rung, 'reboard-fresh');
    assert.equal(rungs[0].brief, 'fresh');
    const [sit, rung, start] = journalOrder(events, ['phase.situation', 'phase.rung', 'phase.start']);
    assert.ok(sit >= 0 && sit < rung && rung < start, 'journal: phase.situation → phase.rung → phase.start');
    assert.equal(journalled(events, 'phase.start')[0].brief, 'fresh');
    assert.equal(state.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-fresh', 'the climb is accounted on the run');
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'nothing was spent finding out');
  } finally { r.cleanup(); }
});

test('ladder: interrupted over a tree git cannot read is work-in-progress — no session, so it boards with the RESUMING brief', async () => {
  const r = repo(); // not a git repository: the tree is unreadable
  try {
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'parked';
    stale.phases['1'] = { phase: 1, status: 'interrupted', attempts: 1, costUsd: 2, note: 'the console stopped' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'reboard-resume-brief', 'the own session is gone; the next rung is the brief');
    assert.equal(rung.brief, 'resume');
    assert.equal(log[0].brief, 'BOOT', 'the engine prompt still leads');
    assert.match(log[0].prompt, /RESUMING phase 1/);
    assert.match(log[0].prompt, /Handoff: none has been written/);
    assert.match(log[0].prompt, /Working tree:.*could not be read/);
    assert.doesNotMatch(log[0].prompt, /do not start new work/i, 'that sentence belongs to the closeout, never to a resume');
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: a failed record with an in-progress handoff and a session left boards as `continue` — --resume plus the continue instruction', async () => {
  const r = repo();
  try {
    r.setInProgress(1);
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'halted';
    stale.phases['1'] = { phase: 1, status: 'failed', attempts: 1, costUsd: 40, sessionId: 'sess-old', said: 'handed off in-progress deliberately' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'resume-own-session');
    assert.equal(rung.brief, 'continue');
    assert.equal(rung.sessionId, 'sess-old');
    assert.equal(log[0].resume, 'sess-old', 'the phase\'s own session is continued');
    assert.equal(log[0].brief, 'RESUMING', 'no engine boot text — the session has it');
    assert.match(log[0].prompt, /a handoff exists for phase 1 and reads "in-progress"/);
    assert.match(log[0].prompt, /handed off in-progress deliberately/, 'the last words ride along');
    assert.doesNotMatch(log[0].prompt, /do not start new work/i);
    assert.equal(journalled(events, 'phase.start')[0].brief, 'continue');
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: a stuck board with an unknown blocker gets ONE unblock brief; the second time the phase parks with an errand and the run keeps driving', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setStuck(1);
    const outstanding = 'The migration renames a column and the two callers disagree about the new name; nobody decided.';
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    // Phase 1's unblock session does not unblock; 2 and 3 do their work.
    const spawn = briefedSession(r, log, (phase) => (phase === 1 ? 'nothing' : 'done'));
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1 ? { exists: true, status: 'blocked', outstanding } : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    const unblocks = log.filter((l) => l.phase === 1);
    assert.equal(unblocks.length, 1, 'exactly one unblock session, never a loop');
    assert.equal(unblocks[0].brief, 'BOOT', 'the engine prompt leads, the brief follows');
    assert.match(unblocks[0].prompt, /UNBLOCK phase 1/);
    assert.match(unblocks[0].prompt, /nobody decided/, 'the Outstanding text is in the brief');
    assert.match(unblocks[0].prompt, /needs-human --needs <key> --reason/, 'the errand escape hatch is named, by key');
    assert.doesNotMatch(unblocks[0].prompt, /do not start new work/i);
    const rungs = journalled(events, 'phase.rung').filter((entry) => entry.rung === 'unblock-session');
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0].brief, 'unblock');
    const situations = journalled(events, 'phase.situation').map((entry) => entry.situation);
    assert.ok(situations.every((key) => key === 'blocked-declared:unknown'), `classified as blocked-declared:unknown (${situations.join(', ')})`);
    const errands = journalled(events, 'phase.errand');
    assert.equal(errands.length, 1, 'the second exhaustion writes ONE errand');
    assert.equal(errands[0].situation, 'blocked-declared:unknown');
    assert.equal(state.phases['1'].status, 'parked');
    assert.ok(state.recoveries?.['1']?.errand, 'the errand is on the run, for the one card');
    assert.equal(state.phases['2'].status, 'done');
    assert.equal(state.phases['3'].status, 'done');
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'phase-blocked').length, 0, 'no immediate phase-blocked halt');
    assert.equal(state.consecutiveFailures, 0, 'a phase parked for a person did not fail twice');
    assert.match(state.halt?.reason ?? '', /phase 1 needs you/);
  } finally { r.cleanup(); }
});

test('ladder: a credential blocker parks with an errand at once — no session spent; a lock blocker goes back to the queue', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setStuck(1);
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log), undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1
        ? { exists: true, status: 'blocked', outstanding: 'Needs a credential nobody on this machine holds: the registry token for the CI mirror.' }
        : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(log.filter((l) => l.phase === 1).length, 0, 'no session was spent on a blocker only a person can settle');
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'blocked-declared:credential');
    assert.equal(journalled(events, 'phase.errand')[0].situation, 'blocked-declared:credential');
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.phases['2'].status, 'done');
  } finally { r.cleanup(); }

  const r2 = repo();
  try {
    r2.setStuck(1);
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    // The unblock session for a LOCK blocker is the queue: the phase re-boards
    // and admission waits on the holder. Here the lock is free, so it boards.
    const { instance, events } = runner(r2, briefedSession(r2, log), undefined, undefined, {
      handoffFor: (_slug, phase) => phase === 1
        ? { exists: true, status: 'blocked', outstanding: 'Phase lock held by mobin@laptop — the tree is theirs until they release it.' }
        : { exists: false },
    });
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1], autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'blocked-declared:lock');
    assert.equal(journalled(events, 'phase.rung')[0].rung, 'queue');
    assert.equal(journalled(events, 'phase.errand').length, 0, 'a lock is not a person\'s errand');
    assert.equal(log.filter((l) => l.phase === 1).length, 1, 'it boarded once the lock was free');
    assert.equal(state.phases['1'].status, 'done');
  } finally { r2.cleanup(); }
});

test('ladder: a `partial` outcome is work-in-progress at once — the phase re-boards as `continue` of its own session', async () => {
  const r = repo();
  try {
    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    let calls = 0;
    const spawn: SpawnFn = async (request) => {
      calls++;
      const m = /(BOOT|RESUMING) phase (\d+)/.exec(request.prompt);
      log.push({ phase: Number(m?.[2]), brief: m?.[1] ?? '?', resume: request.resume, prompt: request.prompt });
      if (calls === 1) {
        // "I did real work and have to stop here — resume me." Any reason but
        // `budget` or `context`: those two say the session itself is spent,
        // and the resume policy boards those fresh (autopilot-token-drain P4).
        fileOutcome(request, { phase: 1, status: 'partial', reason: 'other' });
        return ok({ sessionId: 'sess-p', resultText: 'handing off in-progress, resume me' });
      }
      r.markDone(1);
      return ok({ sessionId: 'sess-p' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autoRecover: true });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(journalled(events, 'phase.outcome').map((o) => o.status), ['partial']);
    assert.deepEqual(journalled(events, 'phase.outcome-partial'), [{ reason: 'other', climbed: true }]);
    assert.equal(journalled(events, 'phase.situation')[0].situation, 'work-in-progress');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'resume-own-session');
    assert.equal(rung.brief, 'continue');
    assert.equal(log.length, 2);
    assert.equal(log[1].resume, 'sess-p', 'the same session continues');
    assert.match(log[1].prompt, /RESUMING phase 1/);
    assert.equal(journalled(events, 'phase.closeout').length, 0, 'no closeout nudge for a declared partial');
    assert.equal(journalled(events, 'run.halt').length, 0);
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
  } finally { r.cleanup(); }
});

test('ladder: start({reboard}) boards the named brief and journals the request', async () => {
  const r = repo();
  try {
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'halted';
    stale.phases['1'] = { phase: 1, status: 'failed', attempts: 2, costUsd: 3, sessionId: 'sess-r' };
    saveRun(stale);

    const log: { phase: number; brief: string; resume?: string; prompt: string }[] = [];
    const { instance, events } = runner(r, briefedSession(r, log));
    await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1],
      reboard: [{ phase: 1, situation: 'work-in-progress', rung: 'resume-own-session', sessionId: 'sess-r', by: 'converge' }],
    });
    await instance.wait();

    const asked = journalled(events, 'phase.reboard-requested')[0];
    assert.equal(asked.brief, 'continue', 'the default brief for the rung, given a session');
    assert.equal(asked.by, 'converge');
    assert.equal(log[0].resume, 'sess-r');
    assert.match(log[0].prompt, /RESUMING phase 1/);
    assert.equal(journalled(events, 'phase.rung').length, 0, 'the caller accounts the rung; the runner only boards');
    assert.equal(instance.current()!.phases['1'].status, 'done');
  } finally { r.cleanup(); }
});

/* ---------------- the defect list ---------------- */

test('defects: an expired wait on a stuck board is no livelock — the run does not re-enter waiting on a past clock, the phase resumes', async () => {
  const r = repo();
  try {
    r.setStuck(1);
    const stale = newRun({ slug: 'demo', root: r.root });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    stale.phases['1'] = {
      phase: 1, status: 'waiting', attempts: 1, costUsd: 1, sessionId: 'sess-w',
      parkedUntil: new Date(Date.now() - 60_000).toISOString(), parkReason: 'the image build', waits: 1,
      // What every park writes: the declaration a wait-resume answers. Without
      // one the boarding still resumes the session, but not as a declared wait.
      declared: { status: 'waiting-external', reason: 'the image build', at: new Date(Date.now() - 120_000).toISOString() },
    };
    saveRun(stale);

    const resumes: (string | undefined)[] = [];
    const spawn: SpawnFn = async (request) => {
      resumes.push(request.resume);
      assert.match(request.prompt, /wait window you declared/, 'the elapsed-window prompt, in the same session');
      r.markDone(1);
      return ok({ sessionId: 'sess-w' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(resumes, ['sess-w'], 'the expired wait boarded — stuck is no longer invisible to the candidate set');
    assert.equal(journalled(events, 'run.waiting-external').length, 0, 'the run never re-entered waiting on a clock that had passed');
    assert.notEqual(state.status, 'waiting');
    assert.equal(state.phases['1'].status, 'done');
  } finally { r.cleanup(); }
});

test('defects: a verification card that goes unanswered parks the phase and the run — the streak is untouched', async () => {
  const r = repo();
  try {
    const { Approvals } = await import('../server/runner/approvals.ts');
    const notRun = { ok: false, reason: 'nothing runnable (1 fragment left for a human)', ran: [], notRun: [{ text: 'look at the dashboard', reason: 'prose' }] };
    const approvals = new Approvals();
    // A snapshot of the run WHILE the card stands: the card lives 60 ms, so a
    // read 15 ms after it is raised sees the wait the card put the run in.
    let underCard: RunState | null = null;
    const request = approvals.request.bind(approvals);
    approvals.request = ((...args: Parameters<typeof approvals.request>) => {
      const card = request(...args);
      setTimeout(() => { underCard = JSON.parse(JSON.stringify(instance.current())) as RunState; }, 15);
      return card;
    }) as typeof approvals.request;
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, {
      approvals, verify: async () => notRun, verifyAnswerMs: 60, origin: 'http://127.0.0.1:4123',
    });
    // The card's timer is unref'd (a pending approval must never keep the
    // console alive); in a test nothing else holds the loop open, so hold it.
    const keepAlive = setInterval(() => {}, 500);
    try {
      await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going' });
      await instance.wait();
    } finally { clearInterval(keepAlive); }

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked', 'parked, not failed');
    assert.match(state.phases['1'].note ?? '', /went unanswered/);
    assert.equal(state.consecutiveFailures, 0, 'nobody answering is not the phase failing');
    assert.equal(state.status, 'parked');
    assert.match(state.halt?.reason ?? '', /verification card went unanswered/);
    // WAI-10 (ACC-4.8): the park a timeout produces carries a kind from HALT_KINDS —
    // `awaiting-person`, a person was asked and did not answer.
    assert.equal(state.halt?.kind, 'awaiting-person');
    assert.ok((HALT_KINDS as readonly string[]).includes(state.halt?.kind ?? ''));
    assert.equal(journalled(events, 'phase.verify-unanswered').length, 1);
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'needs-human').length, 0, 'no needs-human halt, no streak');
    // …and while the card stood, the run WAITED on a person: `waiting`,
    // `waitReason: person`, the clock at the card's expiry (WAI-10).
    const waited = journalled(events, 'run.waiting-person');
    assert.equal(waited.length, 1);
    assert.equal(waited[0].phase, 1);
    assert.match(String(waited[0].on), /verification card/);
    const waiting = underCard!;
    assert.ok(waiting, 'the run was read while the card stood');
    assert.equal(waiting.status, 'waiting', 'the run read `waiting` under the card');
    assert.equal(waiting.waitReason, 'person');
    assert.equal(waiting.waitUntil, waited[0].until, 'the clock is the card\'s expiry');
    assert.equal(waiting.lifecycle?.wait?.kind, 'person');
    assert.equal(waiting.lifecycle?.wait?.until, waited[0].until);
    // The card down, the wait is over: the final state carries no person clock.
    assert.equal(state.waitReason ?? null, null);
    assert.equal(state.waitUntil, null);
  } finally { r.cleanup(); }
});

test('defects: every verification lead missing at verify time parks exactly as boarding would — no card, no verify-failed halt', async () => {
  const r = repo();
  try {
    const skipped = [{ command: 'rg -n TODO', lead: 'rg', reason: '`rg` is not installed on the verification PATH' }];
    const unrunnable = {
      ok: false, reason: 'all 1 command(s) are unrunnable here — leads not on the verification PATH: rg',
      ran: [], notRun: skipped.map((s) => ({ text: s.command, reason: s.reason })), skipped,
    };
    const { instance, events } = runner(r, workingSession(r), undefined, undefined, { verify: async () => unrunnable });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'halt-on-everything' });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'parked');
    assert.match(state.phases['1'].note ?? '', /§Verification cannot run on this machine/);
    assert.equal(journalled(events, 'phase.verify-unrunnable').length, 1);
    assert.notEqual(state.phases['1'].status, 'awaiting-verification', 'no card was raised');
    assert.equal(journalled(events, 'run.halt').filter((h) => h.kind === 'verify-failed').length, 0);
    // The run parks with the same sentence — the board already reads done, so
    // a parked record in a driving loop would have been reconciled to done on
    // the next tick, and an unverified phase would have passed in silence.
    assert.equal(state.status, 'parked');
    assert.match(state.halt?.reason ?? '', /§Verification cannot run on this machine/);
    assert.equal(state.consecutiveFailures, 0);
  } finally { r.cleanup(); }
});

test('defects: the belt-check backs off against a stale store — at most a handful of re-boards in five seconds, doubling', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    const seen: number[] = [];
    const scheduler = new Scheduler({ locks: () => [] }); // a store that never learns of the lock
    const { instance, events } = runner(r, workingSession(r, seen), undefined, undefined, { scheduler });
    // Every timer in the runner and the scheduler is unref'd; hold the loop open
    // for the seven seconds this takes.
    const keepAlive = setInterval(() => {}, 500);
    try {
      const started = instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
      setTimeout(() => r.setLockRefused(false), 5_500);
      await started;
      await instance.wait();
    } finally { clearInterval(keepAlive); scheduler.close(); }

    const races = journalled(events, 'phase.lock-race');
    assert.ok(races.length >= 2 && races.length <= 4, `a backoff, not a spin: ${races.length} re-boards`);
    assert.deepEqual(races.slice(0, 3).map((race) => race.backoffMs), [1000, 2000, 4000].slice(0, races.length));
    assert.deepEqual(seen, [1], 'and the phase boarded once the holder released');
    assert.equal(instance.current()!.phases['1'].lockBackoffMs, undefined, 'the backoff resets on a successful claim');
  } finally { r.cleanup(); }
});

test('defects: the no-handoff halt quotes the PHASE session, not the closeout that failed after it', async () => {
  const r = repo();
  try {
    gitInit(r.root, ['scratch.txt']);
    writeFileSync(join(r.root, 'scratch.txt'), 'work the session did');
    let calls = 0;
    const spawn: SpawnFn = async () => {
      calls++;
      return ok({ resultText: calls === 1 ? 'Phase complete! (no handoff though)' : 'I could not write the handoff either' });
    };
    const { instance } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going' });
    await instance.wait();

    const state = instance.current()!;
    assert.equal(calls, 2, 'the phase, then one closeout');
    assert.equal(state.phases['1'].halt?.kind, 'no-handoff');
    assert.match(state.phases['1'].halt?.reason ?? '', /Phase complete!/, 'the words that explain the missing handoff');
    assert.doesNotMatch(state.phases['1'].halt?.reason ?? '', /I could not write/);
    assert.match(state.phases['1'].said ?? '', /Phase complete!/);
    assert.match(state.phases['1'].closeout?.said ?? '', /I could not write/, 'the closeout\'s words are kept, separately');
  } finally { r.cleanup(); }
});

test('defects: a freeze escalation with another lane still open leaves the halt that lane wrote alone', async () => {
  const r = repo();
  let pid = 0;
  const held = realChildSession(r, (p) => { pid = p; }, false);
  let releaseTwo: () => void = () => {};
  const twoHeld = new Promise<void>((resolve) => { releaseTwo = resolve; });
  r.setParallel(true);
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    if (phase === 1) return held.spawn(request);
    // A second lane with NO pid — between admission and a session that
    // never reports one — held open while phase 1 is frozen.
    await twoHeld;
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, spawn, undefined, undefined, { maxParallel: 2 });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxParallel: 2 });
    await held.inSession;
    await sleepMs(150); // let lane 2 board too

    assert.equal(instance.freeze('test', 1), true);
    assert.ok(pid, 'the frozen lane has a real child');
    const state = instance.current()!;
    state.halt = { at: new Date().toISOString(), reason: 'another lane stopped the run', phase: 2 };
    (instance as unknown as { escalateFreeze(): void }).escalateFreeze();

    assert.equal(instance.current()!.halt?.reason, 'another lane stopped the run', 'the other lane\'s halt stands');
    assert.notEqual(instance.current()!.status, 'paused', 'a run with an open lane is not paused');
    assert.equal(instance.current()!.phases['1'].status, 'pending', 'the frozen phase itself is checkpointed');
  } finally {
    held.release();
    releaseTwo();
    await instance.wait();
    r.cleanup();
  }
});

/* ---------------- the lock-cap re-arm ---------------- */

test('a lock-cap park re-arms by itself when the lock it waited out is gone — no Retry', async () => {
  const r = repo();
  try {
    r.setParallel(true);
    r.setLockRefusedFor(1, true);
    // Phase 1 has already queued three hours behind its lock — the cap is two —
    // so its first boarding parks it honestly. Phase 2's session then releases
    // the lock (standing in for the holder finishing), and the NEXT tick has
    // to pick phase 1 back up on its own: the park used to be terminal, and
    // the only remedy a person's Retry after the holder had long released.
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const boarded: number[] = [];
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
      boarded.push(phase);
      if (phase === 2) r.setLockRefusedFor(1, false);
      r.markDone(phase);
      return ok();
    };
    const scheduler = new Scheduler({ locks: () => [] });
    const { instance, events } = runner(r, spawn, undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id });
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.ok(journalled(events, 'phase.lock-wait-capped').length, 'the cap park happened first');
    assert.ok(journalled(events, 'phase.lock-cap-rearmed').length, 'then the re-arm, by itself');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.status, 'finished');
    assert.equal(state.phases['1'].waitingOn, undefined,
      'the recorded holders die with the wait — park, grant and Retry all clear them');
    assert.ok(boarded.includes(1) && boarded.indexOf(1) > boarded.indexOf(2), `phase 1 boarded after phase 2 released the lock: ${boarded.join(',')}`);
  } finally { r.cleanup(); }
});

test('D28: a SESSION-CAP park re-arms by itself once a lane frees — no Retry', async () => {
  // The other half of D28. Making the cap an honest holder means a phase can be
  // parked for having waited two hours on a FULL FLEET rather than on anybody's
  // claim — and that park had no way back: it is not `LOCK_CAP_PARK_BY_LOCK`,
  // so neither re-arm reader would look at it, and a console running three long
  // lanes stranded every fourth phase until a person pressed Retry, for a fleet
  // that was merely busy rather than wedged.
  //
  // Its question is not `phase-lock.sh status` (there is no lock to ask about)
  // but the scheduler's own snapshot: is a lane free? Driven directly, because
  // the alternative is a test that waits for a real fleet to drain.
  const r = repo();
  try {
    const scheduler = new Scheduler({ max: 1, locks: () => [] });
    const wedged = await scheduler.admit({
      slug: 'other', phase: 1, runId: 'beefbeef', scope: ['elsewhere'],
    });
    // Every phase already done, so the drive settles at once and nothing of this
    // run ever competes for the one lane the foreign grant is holding.
    for (const phase of [1, 2, 3]) r.markDone(phase);
    const { instance, events } = runner(r, async () => ok(), undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root });
    await instance.wait();

    const state = instance.current()!;
    const record = phaseRecord(state, 1);
    record.status = 'parked';
    record.note = 'phase 1 is held by 1 of 1 lanes (session cap) and has waited 121 minutes for it';
    const board = {
      phased: true, states: { 1: 'ready' }, done: [], inProgress: [], stuck: [],
      ready: [1], waiting: [], blockedBy: {}, qa: {},
    };
    const internals = instance as unknown as {
      rearmLockCapParks(board: unknown): Promise<void>;
    };

    // The fleet is still full: the park stands. Anything else is a re-board
    // straight back into the same wait, with the clock reset.
    await internals.rearmLockCapParks(board);
    assert.equal(record.status, 'parked', 'a full fleet must not re-arm');
    assert.equal(journalled(events, 'phase.lock-cap-rearmed').length, 0);

    // A lane frees — exactly the event this park was waiting for.
    scheduler.release(wedged);
    await internals.rearmLockCapParks(board);
    assert.equal(record.status, 'pending', 'the phase is boardable again, with no Retry pressed');
    const rearmed = journalled(events, 'phase.lock-cap-rearmed');
    assert.equal(rearmed.length, 1);
    assert.match(String(rearmed[0].note), /a lane has freed up/,
      'and it says which question was answered — not "the lock it waited on is gone"');

    scheduler.close();
  } finally { r.cleanup(); }
});

test('a GRANT park re-arms by itself once nothing holds its scope — no Retry', async () => {
  // The third cause got its answer. Tree-qualified claims made a FOREIGN
  // run's grant a normal holder — seen live: two phases parked "held by
  // autopilot/<other> (<other-plan> phase 12)" stayed parked long after that
  // run released its claims, with Retry the only way back. The oracle is the
  // scheduler's own admission probe (`wouldBlock`), which sees grants AND
  // locks — so a hung sibling's standing grant still blocks the probe (D2's
  // re-park loop cannot recur), and a released foreign run reads as the
  // empty answer it is.
  const r = repo();
  try {
    const scheduler = new Scheduler({ locks: () => [] });
    const held = await scheduler.admit({
      slug: 'other-plan', phase: 12, runId: 'feedf00d', scope: ['core'],
    });
    for (const phase of [1, 2, 3]) r.markDone(phase);
    const { instance, events } = runner(r, async () => ok(), undefined, undefined, { scheduler });
    await instance.start({ slug: 'demo', root: r.root });
    await instance.wait();

    const state = instance.current()!;
    const record = phaseRecord(state, 1);
    record.status = 'parked';
    record.note = 'phase 1 is held by autopilot/feedf00d (other-plan phase 12) and has waited 120 minutes for it';
    const board = {
      phased: true, states: { 1: 'ready' }, done: [], inProgress: [], stuck: [],
      ready: [1], waiting: [], blockedBy: {}, qa: {},
    };
    const internals = instance as unknown as { rearmLockCapParks(board: unknown): Promise<void> };

    // The foreign grant still stands: the probe sees it, the park stays.
    await internals.rearmLockCapParks(board);
    assert.equal(record.status, 'parked', 'a standing foreign grant must not re-arm');
    assert.equal(journalled(events, 'phase.lock-cap-rearmed').length, 0);

    // The foreign run releases — the event the wait was actually for.
    scheduler.release(held);
    await internals.rearmLockCapParks(board);
    assert.equal(record.status, 'pending', 'the phase is boardable again, with no Retry pressed');
    const rearmed = journalled(events, 'phase.lock-cap-rearmed');
    assert.equal(rearmed.length, 1);
    assert.match(String(rearmed[0].note), /nothing holds its scope any more/,
      'and it says which question was answered');

    scheduler.close();
  } finally { r.cleanup(); }
});

test('a console shutdown stamps the run as the system\'s stop and writes the killed-lane note; an operator stop stays theirs', async () => {
  const r = repo();
  try {
    // A session that hangs until its signal is cut: the shutdown path aborts
    // it, the operator-stop path aborts it the same way — only the bookkeeping
    // must differ.
    //
    // Each stop waits for the session to be IN FLIGHT, not for 150 ms: every
    // assertion below is about stopping a running phase, and a fixed sleep let
    // a stop land before boarding had written the phase's record whenever the
    // suite was busy — `phases['1']` undefined, 2 of 2 full runs once
    // autopilot-token-drain phase 6 added a test file beside this one.
    let entered: () => void = () => {};
    const inSession = () => new Promise<void>((resolve) => { entered = resolve; });
    const hang: SpawnFn = (request) => new Promise((resolve) => {
      entered();
      request.signal?.addEventListener('abort', () => resolve(ok({ sessionId: 'sess-hang', signal: { subtype: 'error_during_execution', code: 143, text: 'terminated' } })), { once: true });
    });
    const { instance } = runner(r, hang);
    const firstIn = inSession();
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await firstIn;
    await (instance as never as { checkpointForShutdown: () => Promise<void> }).checkpointForShutdown();
    await instance.wait();
    const shut = instance.current()!;
    assert.equal(shut.status, 'paused');
    assert.equal(shut.stoppedBy, 'system', 'the console going away is not the operator');
    assert.match(shut.phases['1'].note ?? '', /^the console stopped while phase 1 was running/);
    assert.equal(shut.phases['1'].resumeSessionId, 'sess-hang', 'kept for the --resume at boot');
    assert.match(shut.finishedReason ?? '', /console shut down/);

    const second = runner(r, hang);
    const secondIn = inSession();
    await second.instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await secondIn;
    // The operator's stop, as the route derives it from a browser's request.
    await second.instance.stop({ by: 'operator', via: 'api', origin: 'local', remoteUser: null });
    await second.instance.wait();
    const stopped = second.instance.current()!;
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.stoppedBy, 'operator');
    assert.equal(stopped.phases['1'].note, 'stopped by the operator');

    // LFC-6 / SHD-3: the two stops are told apart by the record itself — the
    // shutdown's `run.stop-requested` is absent (a checkpoint, not a stop),
    // and the operator's carries the derived actor whole, matching `stoppedBy`.
    const { journalFile } = await import('../server/runner/state.ts');
    const lines = readFileSync(journalFile(r.root, 'demo', stopped.id), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
    const requested = lines.filter((l) => l.event === 'run.stop-requested');
    assert.equal(requested.length, 1);
    assert.equal(requested[0].data.by, 'operator');
    assert.equal(requested[0].data.via, 'api');
    assert.equal(requested[0].data.origin, 'local');
    assert.equal(requested[0].data.remoteUser, null);
    // …and a bare `stop()` — a harness's — is `unattributed`, never anybody's.
    const third = runner(r, hang);
    const thirdIn = inSession();
    await third.instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await thirdIn;
    await third.instance.stop();
    await third.instance.wait();
    const bare = third.instance.current()!;
    assert.equal(bare.stoppedBy, 'operator', 'a stop nobody attributed is still a person\'s — the console never stops a run unsaid');
    assert.equal(bare.phases['1'].note, 'stopped by unattributed');
  } finally { r.cleanup(); }
});

/**
 * SHD-8. `run.shutdown-child` was `{pid, how}` — 30 records across the hub's
 * journals, none of which could say which phase a killed pid was, why it died,
 * or what its half-finished tool call had been doing. A `gh pr merge` cut at
 * 28 s is exactly where "which side of the merge" is the only question left.
 */
test('SHD-8: a shutdown checkpoint names each killed child\'s phase, session, grace, why and open tool — and says its intent even with no live lane', async () => {
  const r = repo();
  // The ladder's waits are unref'd (a console exiting must not be held up by
  // them), so something has to hold this test's event loop open around them.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    let childPid = 0;
    const spawn: SpawnFn = async (request) => {
      const child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore', detached: true });
      childPid = child.pid!;
      request.onPid?.(child.pid!);
      request.onHandle?.({ pid: child.pid!, open: () => true, send: () => true, setFrozen: () => {} });
      request.onEvent?.({ kind: 'init', sessionId: 'sess-shutdown-0001', model: 'stub-1', tools: 0 });
      request.onEvent?.({ kind: 'tool', id: 'toolu_merge', name: 'Bash', summary: 'gh pr merge 131 --squash --delete-branch' });
      await new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
      return ok({ sessionId: 'sess-shutdown-0001', signal: { subtype: 'error_during_execution', code: 143, text: 'terminated' } });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    for (let i = 0; i < 200 && !childPid; i++) await sleepMs(10);
    await sleepMs(150);
    const checkpoint = instance as never as { checkpointForShutdown: (context: unknown) => Promise<void> };
    await checkpoint.checkpointForShutdown({ intent: 'shutdown', reason: 'shutdown (a test via api from local)', mode: 'exit' });
    await instance.wait();

    const [shutdown] = journalled(events, 'run.console-shutdown');
    assert.equal(shutdown.intent, 'shutdown');
    assert.equal(shutdown.reason, 'shutdown (a test via api from local)');
    assert.equal(shutdown.mode, 'exit');
    assert.equal(shutdown.live, true);
    assert.deepEqual(shutdown.lanes, [{ phase: 1, pid: childPid, sessionId: 'sess-shutdown-0001' }]);

    const children = journalled(events, 'run.shutdown-child');
    assert.equal(children.length, 1);
    const [child] = children;
    assert.equal(child.pid, childPid);
    assert.equal(child.phase, 1);
    assert.equal(child.sessionId, 'sess-shutdown-0001');
    assert.ok(['interrupted', 'exited', 'killed'].includes(String(child.how)), String(child.how));
    assert.equal(typeof child.graceMs, 'number');
    assert.equal(typeof child.interruptGraceMs, 'number');
    assert.equal(child.why, 'console-shutdown');
    assert.equal(child.intent, 'shutdown');
    assert.equal(child.reason, 'shutdown (a test via api from local)');
    assert.deepEqual(
      { name: (child.openTool as { name: string }).name, summary: (child.openTool as { summary: string }).summary },
      { name: 'Bash', summary: 'gh pr merge 131 --squash --delete-branch' },
      'the tool call that was open when the signal went',
    );

    // A restart's checkpoint over a run with nothing live still writes its row —
    // saying so, with no lane and the intent that ended it.
    await checkpoint.checkpointForShutdown({ intent: 'restart', reason: 'restart (a test)' });
    const rows = journalled(events, 'run.console-shutdown');
    const idle = rows[rows.length - 1];
    assert.equal(idle.intent, 'restart');
    assert.deepEqual(idle.lanes, []);
    assert.deepEqual(idle.phases, []);
  } finally { clearInterval(keepAlive); r.cleanup(); }
});

/**
 * REG-3, boarding's half. The lock belt-check answers "has somebody claimed
 * this phase"; a session in its first minute has not. The runner asks the peer
 * predicate in the grant→spawn window and queues — named, with the lock
 * race's backoff — never parks and never releases anything.
 */
test('REG-3: boarding finds a live session in the repository holding no lock — the phase queues behind it, named, and boards once it is gone', async () => {
  const r = repo();
  const scheduler = new Scheduler({ locks: () => [] });
  // The boarding backoff sleeps on an unref'd timer; hold the loop open.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    let peerAlive = true;
    const asked: (string | undefined)[][] = [];
    const spawned: number[] = [];
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      spawned.push(phase);
      r.markDone(phase);
      return ok();
    };
    const { instance, events } = runner(r, spawn, '`true`', undefined, {
      scheduler,
      peers: (_slug, _phase, excluding) => {
        asked.push([...excluding]);
        return peerAlive
          ? [{ sessionId: 's-hand-peer-0001', pid: 4242, cwd: r.root, presence: 'live', owner: 'sam@laptop', scope: ['all'], plan: null }]
          : [];
      },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await sleepMs(300);
    assert.deepEqual(spawned, [], 'nothing boards beside a live peer');
    const [race] = journalled(events, 'phase.peer-race');
    assert.ok(race, 'the queue is journalled');
    assert.equal(race.session, 's-hand-peer-0001');
    assert.equal(race.pid, 4242);
    assert.equal(race.cwd, r.root);
    assert.equal(race.presence, 'live');
    assert.equal(typeof race.backoffMs, 'number');
    assert.match(String(instance.current()!.phases['1'].note), /queued behind a Claude session in this repository that holds no lock — s-hand-p/);
    assert.notEqual(instance.current()!.phases['1'].status, 'parked', 'queued, never parked');

    peerAlive = false;
    await instance.wait();
    assert.ok(spawned.includes(1), 'the peer gone, the phase boards');
    assert.ok(asked.length > 0);
  } finally {
    clearInterval(keepAlive);
    scheduler.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The resource ladder — walls the run climbs by itself before anyone hears
 *
 * Auth, usage past the 12h ceiling, an exhausted model chain, a spent run
 * budget, two leaves finishing together on a work branch. Each used to stop
 * the run for a person; each climbs its first rung here, and the errand is
 * written only when the rung does not hold.
 * ------------------------------------------------------------------ */

const ladderJournal = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('auth wall: a run pinned to a signed-out account switches at preflight to one that signs in, and boards', async () => {
  const r = repo();
  const probed: (string | undefined)[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const seen: number[] = [];
  const watching: SpawnFn = async (request) => {
    envs.push(request.env);
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    r.markDone(phase);
    return ok();
  };
  const { instance, events } = runner(r, watching, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    checkAuth: async (accountId) => {
      probed.push(accountId);
      return accountId === 'spare'
        ? { loggedIn: true, checkedAt: '' }
        : { loggedIn: false, checkedAt: '', detail: `the run is set to pay as ${accountId ?? 'default'} and that login is expired — sign it in` };
    },
    rankAccounts: (excluding) => ['stale', 'spare'].filter((id) => id !== excluding),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(probed.slice(0, 3), ['work', 'stale', 'spare'], 'the run\'s account first, then each candidate in rank order');
  assert.equal(state.accountId, 'spare', 'the run now pays as the account that signed in');
  assert.ok(seen.length > 0);
  assert.ok(envs.every((env) => env?.CLAUDE_CODE_OAUTH_TOKEN === 'tok-spare'), 'every spawn runs as it');
  const switched = ladderJournal(events, 'run.account-switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].from, 'work');
  assert.equal(switched[0].to, 'spare');
  assert.deepEqual(switched[0].tried, ['switch-account → stale: not signed in']);
  assert.equal(state.errand, undefined, 'nobody is asked');
  r.cleanup();
});

test('auth wall: with no account that signs in, the run parks run-preflight with the errand naming the sign-in — and the switch is off under the preference', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '`true`', undefined, {
    checkAuth: async (accountId) => ({
      loggedIn: false, checkedAt: '',
      detail: `the run is set to pay as ${accountId ?? 'default'} and that login is expired or signed out — sign it in with claude auth login`,
    }),
    rankAccounts: () => ['spare'],
  });
  const parked = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  assert.equal(parked.status, 'parked');
  assert.equal(parked.halt?.kind, 'run-preflight');
  assert.equal(seen.length, 0, 'nothing spawned behind the refusal');
  assert.equal(parked.errand?.situation, 'resource-wall:auth');
  assert.match(parked.errand?.need ?? '', /pay as work/);
  assert.match(parked.errand?.how ?? '', /sign it in with claude auth login/);
  assert.deepEqual(parked.errand?.tried, ['switch-account → spare: not signed in']);
  assert.deepEqual(ladderJournal(events, 'run.preflight-refused')[0].tried, ['switch-account → spare: not signed in']);
  assert.equal(ladderJournal(events, 'run.errand').length, 1);
  r.cleanup();

  // The preference off: the candidate is never even probed.
  const r2 = repo();
  const probed: (string | undefined)[] = [];
  const second = runner(r2, workingSession(r2), '`true`', undefined, {
    checkAuth: async (accountId) => { probed.push(accountId); return { loggedIn: accountId === 'spare', checkedAt: '' }; },
    rankAccounts: () => ['spare'],
    autoAccountSwitch: () => false,
  });
  const stayed = await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', accountId: 'work' });
  assert.equal(stayed.status, 'parked');
  assert.deepEqual(probed, ['work'], 'the operator asked to be asked');
  assert.equal(stayed.errand?.situation, 'resource-wall:auth');
  assert.deepEqual(stayed.errand?.tried, []);
  r2.cleanup();
});

test('usage wall past the 12h ceiling: under `wait`, the run moves to an account with headroom instead of stopping for a person', async () => {
  const r = repo();
  const spawns: { env?: NodeJS.ProcessEnv; resume?: string }[] = [];
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;   // 20h out: past the auto-wait ceiling
  const limited: SpawnFn = async (request) => {
    spawns.push({ env: request.env, resume: request.resume });
    if (spawns.length === 1) {
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
        sessionId: 'sess-far',
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-far' });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    pickAccount: () => 'spare',
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  // No onLimit: the default `wait`, which cannot wait 20h — the preference
  // (on by default) upgrades it to a switch rather than a needs-human halt.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished', 'the switch path must not sit out a 20h window');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.accountId, 'spare');
  assert.equal(spawns[1].resume, 'sess-far', 'the ported transcript is resumed');
  assert.equal(ladderJournal(events, 'phase.account-switch').length, 1);
  assert.equal(ladderJournal(events, 'phase.needs-human').length, 0, 'nobody was asked');
  r.cleanup();
});

test('usage wall past the 12h ceiling with no account to pay: the run WAITS on the window — restart-safe, the errand says when — instead of halting needs-human', async () => {
  const r = repo();
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;
  let spawns = 0;
  const limited: SpawnFn = async () => {
    spawns++;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
      sessionId: 'sess-far',
    });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, { pickAccount: () => null });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // The lane is asleep on a 20h clock: observe the wait, then stop it.
  const deadline = Date.now() + 5_000;
  while (instance.current()?.status !== 'waiting' && Date.now() < deadline) await sleep(25);
  const waiting = instance.current()!;
  assert.equal(waiting.status, 'waiting');
  assert.ok(waiting.waitUntil && Date.parse(waiting.waitUntil) > Date.now() + 19 * 3_600_000, 'the clock is the reset itself');
  assert.equal(waiting.errand?.situation, 'resource-wall:usage');
  assert.match(waiting.errand?.how ?? '', /waits by itself until .*Settings ▸ Accounts/s);
  assert.deepEqual(waiting.errand?.tried, ['switch-account → no other account has headroom']);
  assert.equal(ladderJournal(events, 'phase.needs-human').length, 0);
  assert.equal(ladderJournal(events, 'run.waiting').length, 1);
  assert.equal(ladderJournal(events, 'run.errand').length, 1);
  assert.equal(spawns, 1, 'nothing retried into the wall');
  await instance.stop();
  await instance.wait();
  r.cleanup();
});

test('usage wall past the ceiling under `pause` keeps its word: checkpoint and stop for a person, with the errand on the run', async () => {
  const r = repo();
  const far = Math.floor(Date.now() / 1000) + 20 * 3600;
  const limited: SpawnFn = async () => ok({
    signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${far}` },
    sessionId: 'sess-far',
  });
  const { instance, events } = runner(r, limited, '`true`', undefined, {
    pickAccount: () => 'spare',   // available, and deliberately not taken
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.ok(state.waitUntil);
  assert.equal(state.phases['1'].status, 'pending');
  assert.equal(state.phases['1'].resumeSessionId, 'sess-far');
  assert.equal(state.errand?.situation, 'resource-wall:usage');
  assert.equal(ladderJournal(events, 'phase.account-switch').length, 0, 'pause means a person decides');
  assert.equal(ladderJournal(events, 'run.limit-paused').length, 1);
  r.cleanup();
});

test('models exhausted: the run waits for the FIRST model\'s window, then retries the same session on it', async () => {
  const r = repo();
  const T0 = Date.parse('2026-01-01T13:00:00Z');
  let clock = T0;
  const spawns: { model?: string; resume?: string }[] = [];
  const reset = Math.floor((T0 + 60_000) / 1000);   // opus reopens a minute after the start
  const limited: SpawnFn = async (request) => {
    spawns.push({ model: request.model, resume: request.resume });
    clock += 120_000;   // time passes between attempts; by the third the window is behind us
    if (spawns.length <= 3) {
      const model = request.model!;
      const named = `${model[0].toUpperCase()}${model.slice(1)}`;
      const text = spawns.length === 1
        ? `You've hit your ${named} limit · Claude AI usage limit reached|${reset}`
        : `You've hit your ${named} limit`;
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text, model }, sessionId: `sess-${spawns.length}` });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-final' });
  };
  const { instance, events } = runner(r, limited, '`true`', undefined, { now: () => new Date(clock) });
  // Scoped to the one phase, so the spawn list is exactly this phase's story.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus', onlyPhases: [1] });
  const outcome = await Promise.race([
    instance.wait().then(() => 'finished'),
    new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
  ]);
  if (outcome === 'slept') await instance.stop();
  assert.equal(outcome, 'finished');

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(spawns.map((s) => s.model), ['opus', 'sonnet', 'haiku', 'opus'], 'down the chain, then back to the first');
  assert.equal(spawns[3].resume, 'sess-3', 'the same session, not a fresh boot');
  assert.deepEqual(ladderJournal(events, 'phase.model-window-wait').map((d) => d.model), ['opus']);
  assert.equal(ladderJournal(events, 'phase.model-window-retry').length, 1);
  assert.equal(ladderJournal(events, 'run.halt').length, 0);
  assert.equal(state.phases['1'].model, 'opus');
  r.cleanup();
});

test('models exhausted with no reset on the first model halts as it always did', async () => {
  const r = repo();
  let spawns = 0;
  const limited: SpawnFn = async (request) => {
    spawns++;
    const model = request.model!;
    return ok({
      signal: { subtype: 'error_during_execution', code: 1, text: `You've hit your ${model[0].toUpperCase()}${model.slice(1)} limit`, model },
    });
  };
  const { instance, events } = runner(r, limited);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', model: 'opus' });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.kind, 'models-exhausted');
  assert.equal(spawns, 3);
  assert.equal(ladderJournal(events, 'phase.model-window-wait').length, 0);
  r.cleanup();
});

test('budget wall: a spent run budget is raised once within the cap and journalled; the second exhaustion halts with the errand; a budget at the cap cannot be raised', async () => {
  // (1) $3, $1 a phase, three phases: the third spends it exactly, the raise
  // (25% → 3.75) carries the run to finished instead of a halt over nothing.
  const costly = (r: Repo, seen: number[]): SpawnFn => async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    r.markDone(phase);
    return ok({ costUsd: 1 });
  };
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, costly(r, seen));
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', runBudgetUsd: 3 });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(
    ladderJournal(events, 'run.budget-raised').map((d) => ({ from: d.from, to: d.to, pct: d.pct })),
    [{ from: 3, to: 3.75, pct: 25 }],
  );
  assert.equal(state.runBudgetUsd, 3.75);
  assert.equal(state.budgetRaise?.from, 3);
  assert.equal(state.errand, undefined);
  r.cleanup();

  // (2) $2: spent at phase 2 → raised to 2.5 → phase 3 runs → $3 ≥ 2.5: the
  // second exhaustion is the halt, with the errand saying the raise was tried.
  const r2 = repo();
  const seen2: number[] = [];
  const second = runner(r2, costly(r2, seen2));
  await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', runBudgetUsd: 2 });
  await second.instance.wait();
  const halted = second.instance.current()!;
  assert.equal(halted.status, 'halted');
  assert.equal(halted.halt?.kind, 'budget');
  assert.match(halted.halt?.reason ?? '', /^the run budget of \$2\.5 is spent \(raised once from \$2\)/);
  assert.deepEqual(seen2, [1, 2, 3], 'the raise bought the third phase');
  assert.equal(ladderJournal(second.events, 'run.budget-raised').length, 1, 'raised ONCE');
  assert.equal(halted.errand?.situation, 'resource-wall:budget');
  assert.match(halted.errand?.tried[0] ?? '', /raised \$2 → \$2\.5 \(25%\), spent again/);
  assert.equal(ladderJournal(second.events, 'run.errand').length, 1);
  r2.cleanup();

  // (3) a budget already at the ladder's per-run USD cap has nowhere to go:
  // the halt comes at once, and the errand says why no raise happened.
  const r3 = repo();
  const seen3: number[] = [];
  const third = runner(r3, costly(r3, seen3), '`true`', undefined, { ladderCaps: () => ({ perRunUsd: 2 }) });
  await third.instance.start({ slug: 'demo', root: r3.root, autonomy: 'keep-going', runBudgetUsd: 2 });
  await third.instance.wait();
  const capped = third.instance.current()!;
  assert.equal(capped.status, 'halted');
  assert.equal(capped.halt?.kind, 'budget');
  assert.deepEqual(seen3, [1, 2]);
  assert.equal(ladderJournal(third.events, 'run.budget-raised').length, 0);
  assert.match(capped.errand?.tried[0] ?? '', /not possible within the \$2 per-run ladder cap/);
  r3.cleanup();
});

test('two DAG leaves finishing together on a work-branch run: the last leaf\'s session opens the PR — never a bare run.pr-pending ending', async () => {
  const r = repo();
  r.setParallel(true);
  const spawns: { prompt: string; resume?: string; name?: string }[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push({ prompt: request.prompt, resume: request.resume, name: request.name });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'pushed pe/demo and opened https://example.invalid/pr/7' });
  };
  const { instance, events } = runner(r, working, '`true`', undefined, { maxParallel: 3 });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', openPr: true });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  const boots = spawns.filter((s) => /BOOT phase/.test(s.prompt));
  assert.equal(boots.length, 3);
  assert.ok(boots.every((s) => !/Opening the pull request/.test(s.prompt)), 'with three leaves live at once none reads as last');
  const pr = spawns.filter((s) => /Opening the pull request/.test(s.prompt));
  assert.equal(pr.length, 1, 'exactly one session is asked to open the PR');
  assert.match(pr[0].resume ?? '', /^sess-p\d$/, 'and it is a leaf\'s own resumed session');
  assert.match(pr[0].prompt, /pull request falls to you/);
  assert.match(pr[0].name ?? '', /pull request$/);
  assert.equal(ladderJournal(events, 'run.pr-pending').length, 0);
  assert.equal(ladderJournal(events, 'phase.pr-session-done').length, 1);
  assert.match(state.finishedReason ?? '', /asked to push pe\/demo and open the pull request/);
  r.cleanup();

  // When no session can be resumed for it, the honest ending stays: the
  // branch awaits its PR and the card asks.
  const r2 = repo();
  r2.setParallel(true);
  const failing: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r2.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    throw new Error('no transcript to resume');
  };
  const second = runner(r2, failing, '`true`', undefined, { maxParallel: 3 });
  await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', gitMode: 'new-branch', openPr: true });
  await second.instance.wait();
  const pending = second.instance.current()!;
  assert.equal(pending.status, 'finished');
  assert.equal(ladderJournal(second.events, 'run.pr-pending').length, 1);
  assert.equal(ladderJournal(second.events, 'phase.pr-session-failed').length, 1);
  assert.match(pending.finishedReason ?? '', /still awaits its PR/);
  r2.cleanup();
});

/* ------------------------------------------------------------------ *
 * P12 — the other three settle strategies. `pr` is every test above; these
 * are what the same finished run does when it is asked for something else.
 * ------------------------------------------------------------------ */

test('P12 — settle `keep` spends no session at all and says the branch was left alone', async () => {
  const r = repo();
  const spawns: string[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push(request.prompt);
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'did something' });
  };
  const { instance, events } = runner(r, working, '`true`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', settle: 'keep' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.settle, 'keep');
  // The mirror: `keep` is what `openPr: false` has always meant.
  assert.equal(state.openPr, false);
  assert.equal(spawns.filter((p) => /pull request falls to you|MERGE QUEUE/.test(p)).length, 0,
    'no settle session may be spent when the answer is "do nothing"');
  assert.equal(ladderJournal(events, 'run.pr-pending').length, 0);
  // Journalled rather than silent — an unrecorded no-op is indistinguishable
  // from a settle nobody wired.
  const settled = ladderJournal(events, 'run.settled');
  assert.equal(settled.length, 1);
  assert.equal((settled[0] as { strategy?: string }).strategy, 'keep');
  assert.match(state.finishedReason ?? '', /was left as it is/);
  r.cleanup();
});

test('P12 — settle `integration` merges the run branch in-console, pushes nothing, spends no session', async () => {
  const r = repo();
  const spawns: string[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push(request.prompt);
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'did something' });
  };
  const { instance, events } = runner(r, working, '`true`');
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', settle: 'integration',
  });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.settle, 'integration');
  // The carve-out is CLOSED for this strategy: nothing it does reaches a
  // remote, so nothing it does may be handed a push.
  assert.equal(state.openPr, false);
  assert.equal(spawns.filter((p) => /pull request falls to you|MERGE QUEUE/.test(p)).length, 0,
    'an integration settle happens inside the console, not in a session');
  const settled = ladderJournal(events, 'run.settled');
  assert.equal(settled.length, 1);
  assert.equal((settled[0] as { strategy?: string }).strategy, 'integration');
  assert.equal((settled[0] as { into?: string }).into, 'pe/integration');
  // The fixture repo has no `pe/demo` branch — no phase ever created one — so
  // the honest answer is `failed` with the branch named, NOT a claimed merge.
  // What this pins is that the strategy ran, said which branch and which
  // target, and invented no success. The merge itself is proved against real
  // git in `worktree.test.ts` (`landIntegration`).
  assert.equal((settled[0] as { kind?: string }).kind, 'failed');
  assert.match(state.finishedReason ?? '', /pe\/demo could not be merged into pe\/integration/);
  r.cleanup();
});

test('P12 — a stale, UNREGISTERED directory under the other worktree root never pins the staging settle', async () => {
  // `stagingFor()` keeps `pe/integration` wherever it already IS — git allows
  // a branch one working tree — and it must ask git, not the filesystem: a
  // directory that merely exists under the other root (restored from a
  // backup, recreated by hand) is not a checkout, and pinning the settle to it
  // refused every settle for ever with nothing an operator could see. (Code
  // review of the project-root change, finding 9.)
  const { execFileSync } = await import('node:child_process');
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { consoleRunsDir } = await import('../server/runner/state.ts');
  const { isRegistered } = await import('../server/runner/worktree.ts');
  const r = repo();
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: r.root, env });
  execFileSync('git', ['add', '-A'], { cwd: r.root, env });
  execFileSync('git', ['commit', '-qm', 'seed', '--allow-empty'], { cwd: r.root, env });
  execFileSync('git', ['branch', '-f', 'pe/demo'], { cwd: r.root, env });
  // The stale directory: under the STATE root, non-empty, registered nowhere.
  const stale = join(consoleRunsDir(r.root), 'staging');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'leftover.txt'), 'not a checkout\n');

  const working: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'did something' });
  };
  const { instance, events } = runner(r, working, '`true`');
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', settle: 'integration',
  });
  await instance.wait();

  const settled = ladderJournal(events, 'run.settled');
  assert.equal(settled.length, 1);
  // `empty`, not `failed`: the staging tree was made under the PROJECT root
  // and `pe/demo` (= HEAD) holds nothing it lacks.
  assert.equal((settled[0] as { kind?: string }).kind, 'empty', JSON.stringify(settled[0]));
  const project = join(r.root, '.worktrees', 'staging');
  assert.equal(await isRegistered(r.root, project), true, 'the staging tree stands under the project root');
  assert.equal(await isRegistered(r.root, stale), false, 'the stale directory was never adopted');
  assert.ok(existsSync(join(stale, 'leftover.txt')), 'and never touched');
  r.cleanup();
});

test('P12 — settle `merge-queue` boards ONE session whose prompt rebases, re-verifies, then pushes', async () => {
  const r = repo();
  r.setParallel(true);
  const spawns: { prompt: string; resume?: string; name?: string }[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push({ prompt: request.prompt, resume: request.resume, name: request.name });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'rebased, verified and pushed pe/demo' });
  };
  const { instance, events } = runner(r, working, '`true`', undefined, { maxParallel: 3 });
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', settle: 'merge-queue',
  });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.settle, 'merge-queue');
  const queued = spawns.filter((s) => /MERGE QUEUE/.test(s.prompt));
  assert.equal(queued.length, 1, 'exactly one settle session, like the PR block');
  assert.match(queued[0].resume ?? '', /^sess-p\d$/, 'and it is a leaf\'s own resumed session');
  assert.match(queued[0].name ?? '', /merge queue$/);
  // The three instructions, IN ORDER — the order is the whole strategy.
  const prompt = queued[0].prompt;
  assert.match(prompt, /git rebase origin\/<default-branch>/);
  assert.match(prompt, /Re-run the plan's §End-to-end verification/);
  assert.match(prompt, /git push --force-with-lease\s+origin pe\/demo/);
  assert.ok(prompt.indexOf('git rebase') < prompt.indexOf('Re-run the plan'), 'rebase before verify');
  assert.ok(prompt.indexOf('Re-run the plan') < prompt.indexOf('--force-with-lease'), 'verify before push');
  assert.match(prompt, /git rebase --abort/, 'a conflict must be aborted, never resolved unattended');
  assert.equal(ladderJournal(events, 'run.settled').length, 0, 'a session settle records the session events');
  assert.match(state.finishedReason ?? '', /asked to rebase pe\/demo/);
  r.cleanup();
});

test('the start door\'s maxParallel reaches a NEW run, not only a continued one', async () => {
  // `Runner.start` builds a fresh run from a hand-copied field list, and the
  // list's own comment names the failure shape: a field the door accepts and
  // the list forgets reaches the run as silence. The fifth live rehearsal read
  // exactly that — `--max-sessions 6` on the console, nothing on the run — so
  // the value is asserted on the record the moment the run exists.
  const r = repo();
  const done: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) r.markDone(Number(boot[1]));
    return ok({ sessionId: `sess-${boot?.[1] ?? 'x'}` });
  };
  const { instance } = runner(r, done, '`true`');
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'current', maxParallel: 2,
  });
  assert.equal(instance.current()!.maxParallel, 2, 'a fresh run carries the door\'s maxParallel');
  await instance.wait();
  r.cleanup();
});

test('P12 — a run that never finished settles NOTHING, whatever strategy it was given', async () => {
  const r = repo();
  // Phase 2 never gets marked done, so the run parks with work outstanding.
  const spawns: string[] = [];
  const stalling: SpawnFn = async (request) => {
    spawns.push(request.prompt);
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot && Number(boot[1]) === 1) { r.markDone(1); return ok({ sessionId: 'sess-p1' }); }
    return ok({ sessionId: 'sess-px' });
  };
  const { instance, events } = runner(r, stalling, '`true`', undefined, { maxConsecutiveFailures: 1 });
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', settle: 'integration',
  });
  await instance.wait();

  const state = instance.current()!;
  assert.notEqual(state.status, 'finished');
  // Folding a branch that still has work into staging — or asking a person to
  // read it — would be claiming the plan is done when it is not.
  assert.equal(ladderJournal(events, 'run.settled').length, 0);
  assert.equal(ladderJournal(events, 'run.pr-pending').length, 0);
  r.cleanup();
});

/**
 * …and a frozen console opens no pull request either.
 *
 * The third of the runner's extra sessions, and it takes the same shape as the
 * other two: a `claude` spawned from inside the loop, past `admit()`, so the
 * scheduler's fleet holder never sees it. Here the run has FINISHED — every
 * phase is done — and the only thing left is the paperwork, which is exactly
 * when an operator is most likely to walk away and press Freeze all.
 *
 * The outcome is the honest ending this method already has for "no session
 * could be resumed": the branch awaits its PR. Be clear that nothing re-reaches
 * it automatically — opening it becomes an operator errand, and the journal
 * line is what makes that errand findable.
 */
/**
 * console-open-findings O2 — a PR session is not a continuation, so a session
 * the resume POLICY declines must not cancel it.
 *
 * `settleSession` puts the last phase's session to the one resume gate, which
 * refuses for five reasons. Four mean the conversation is unusable. The fifth,
 * `fresh`, means the session is there and healthy and the policy merely judged
 * that re-reading its context costs more than starting over — which says nothing
 * about whether the pull request should be opened. Skipping it there also
 * produced an errand that could never come true: "Continue this run once that
 * session has ended" named a session that had ALREADY ended, so the operator was
 * told to wait for an event in the past.
 */
test('O2: a policy-declined session starts the settle session fresh; only a LIVE one is worth waiting for', async () => {
  const { settleVehicle } = await import('../server/runner/runner-core.ts');
  assert.deepEqual(
    settleVehicle('fresh', 'pull request'), { spawn: 'fresh' },
    'the policy declined a resume, not the pull request',
  );
  // the one refusal where waiting is the honest instruction
  const live = settleVehicle('session-live', 'pull request');
  assert.ok('skip' in live && /once that session has ended/.test(live.skip));
  // …and the three where it is not: that session ended long ago
  for (const why of ['none', 'gone', 'unported'] as const) {
    const verdict = settleVehicle(why, 'pull request');
    assert.ok('skip' in verdict, `${why} cannot start a session`);
    assert.ok(
      !/once that session has ended/.test(verdict.skip),
      `${why}: never tell an operator to wait for a session that already ended`,
    );
    assert.match(verdict.skip, /by hand/, `${why}: says what the operator can actually do`);
  }
});

test('a frozen console does not open the pull request, and says the branch still awaits one', async () => {
  const r = repo();
  r.setParallel(true);
  const spawns: string[] = [];
  const working: SpawnFn = async (request) => {
    spawns.push(request.prompt);
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok({ resultText: 'pushed and opened a PR' });
  };
  const { instance, events } = runner(r, working, '`true`', undefined, {
    maxParallel: 3,
    fleetHold: () => ({ at: '2026-08-26T10:00:00Z', by: 'mo' }),
  });
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', gitMode: 'new-branch', openPr: true,
  });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(
    spawns.filter((p) => /Opening the pull request|pull request falls to you/.test(p)).length, 0,
    'no PR session was started under the freeze',
  );
  assert.equal(ladderJournal(events, 'run.pr-session-skipped').length, 1, 'and the journal says why');
  assert.equal(ladderJournal(events, 'run.pr-pending').length, 1);
  assert.match(
    state.finishedReason ?? '', /still awaits its PR/,
    'the ending is the honest one this method already had, not an invented success',
  );
  r.cleanup();
});

test('a QA-wedged plan halts with a kind, an anchor phase and the verdict named', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen), '');
  // Phase 1 runs and lands; its QA verdict then holds every remaining phase.
  // The board goes ready=[] with the plan nowhere near finished — the exact
  // shape that produced "nothing is ready to run: N phase(s) are still waiting
  // on a gate or an earlier phase", a halt with no kind and no phase, and a
  // healer that answered "no open phase of this run has a record to act on".
  r.setQaBlocked(1, 'fail');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'parked');
  assert.equal(state.halt?.kind, 'plan-deadlocked',
    'a kindless halt is invisible to auto-recovery and to the halt card');
  assert.equal(state.halt?.phase, 1, 'the anchor is the phase whose verdict holds the plan');
  assert.match(state.halt?.reason ?? '', /QA/,
    'the operator must be able to learn the cause from the halt itself');
  assert.match(state.halt?.reason ?? '', /\b1\b/, 'and which phase it is');
  assert.doesNotMatch(state.halt?.reason ?? '', /waiting on a gate or an earlier phase/,
    'the generic sentence names neither the cause nor a door');
  r.cleanup();
});

test('a plain waiting board still halts generically — no false QA claim', async () => {
  const r = repo();
  const seen: number[] = [];
  // Phase 1 parks at preflight (unscoped, no verification), so later phases
  // stay waiting with no QA involved anywhere.
  const { instance } = runner(r, workingSession(r, seen), '');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();
  const state = instance.current()!;
  assert.notEqual(state.halt?.kind, 'plan-deadlocked');
  assert.doesNotMatch(state.halt?.reason ?? '', /QA verdict/);
  r.cleanup();
});

test('park() does not claim the run is parked while its lanes are still editing trees', async () => {
  // `halt()` uses `halting` for exactly this reason, with a comment saying so:
  // "halted with live sessions still editing trees is a lie … halted is not
  // IN_FLIGHT, so a dead console mid-drain would never pid-check those
  // children". `park()` wrote `parked` unconditionally — and `park` is what the
  // approval-timeout hook calls, from OUTSIDE the loop, while a lane is live.
  // Measured on a real run: 17 minutes of sessions editing trees under a
  // `parked` status.
  const r = repo();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const session: SpawnFn = async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    await held;                       // the lane stays live until this test says otherwise
    r.markDone(phase);
    return ok();
  };
  const { instance } = runner(r, session);   // a real §Verification, so the phase boards
  try {
    const started = instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    const running = () => instance.current()?.phases?.['1']?.status;
    const deadline = Date.now() + 5_000;
    while (running() !== 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running(), 'running', 'the premise: a lane really is live');

    assert.equal(instance.park('an approval went unanswered', 1), true);
    assert.notEqual(instance.current()!.status, 'parked',
      'a run with live lanes is DRAINING; claiming it is parked is the lie halt() avoids');

    release();
    await started;
    await instance.wait();

    // And it lands on the honest terminal word once the drain finishes: a park
    // stays a park, only a halt becomes `halted`.
    const after = instance.current()!;
    assert.equal(after.status, 'parked', `a park must not finalize as ${after.status}`);
    assert.equal(after.child, null, 'nothing is running past the end of the loop');
    assert.equal(instance.busy(), false, 'and the loop itself is done');
  } finally { release(); r.cleanup(); }
});

test('a human gate stops the run — unless the operator delegated it', async () => {
  // The plan author wrote `human`, and by default that is a wall the run does
  // not cross: the phase records `gated` and the loop moves on. An operator who
  // wants a plan to run unattended can delegate the VERIFICATION to the phase's
  // own session — which `gate-status.md`'s own header already names as a
  // legitimate approver, and which real plans record as `ai-session-delegated`.
  const r = repo();
  r.setGate(1, 'manual: the owner approves the copy');
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen), '`true`', undefined, { delegateHumanGates: () => false });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    await instance.wait();
    assert.equal(instance.current()!.phases['1'].status, 'gated', "a human gate is a person's when the console says operator");
    assert.deepEqual(seen, [], 'and nothing was booted past it');
  } finally { r.cleanup(); }

  // The SHIPPED default since 5.0.0 (phase 11, operator decision 11: `gates:
  // delegated`): a harness that says nothing boards the phase to evidence the
  // gate, and the journal names the row and the source.
  const r0 = repo();
  r0.setGate(1, 'manual: the owner approves the copy');
  const seen0: number[] = [];
  const { instance: shipped, events: events0 } = runner(r0, workingSession(r0, seen0));
  try {
    await shipped.start({ slug: 'demo', root: r0.root, autonomy: 'keep-going', onlyPhases: [1] });
    await shipped.wait();
    assert.deepEqual(seen0, [1], 'delegated by default');
    const [line] = journalled(events0, 'phase.gate-delegated');
    assert.equal(line.decisionKey, 'gates');
    assert.equal(line.source, 'default');
  } finally { r0.cleanup(); }

  // A plan row outranks the console: `gates: operator` in the manifest holds
  // the phase even on a console that delegates.
  const r1 = repo();
  r1.setGate(1, 'manual: the owner approves the copy');
  const seen1: number[] = [];
  const { instance: byPlan } = runner(r1, workingSession(r1, seen1), '`true`', undefined, { delegateHumanGates: () => true });
  try {
    await byPlan.start({
      slug: 'demo', root: r1.root, autonomy: 'keep-going', onlyPhases: [1],
      manifest: {
        decisions: [{ key: 'gates', value: 'operator', owner: 'operator', state: 'answered', source: 'plan', blocking: 'no', origin: 'plan' }],
        accounts: [], credentials: { policy: 'continue', ids: [], held: [], missing: [] },
        delivery: { ok: true, channels: [], acknowledged: false }, probes: {}, at: '2026-09-14T00:00:00.000Z',
      },
    });
    await byPlan.wait();
    assert.equal(byPlan.current()!.phases['1'].status, 'gated', "the plan's row wins");
    assert.deepEqual(seen1, []);
  } finally { r1.cleanup(); }

  // A delegated gate that states NO condition cannot be evidenced: it stops at
  // boarding, before the spend, and the journal says why.
  const r3 = repo();
  r3.setGate(1, 'manual:');
  const seen3: number[] = [];
  const { instance: bare, events: events3 } = runner(r3, workingSession(r3, seen3));
  try {
    await bare.start({ slug: 'demo', root: r3.root, autonomy: 'keep-going', onlyPhases: [1] });
    await bare.wait();
    assert.equal(bare.current()!.phases['1'].status, 'gated');
    assert.deepEqual(seen3, [], 'nothing was spent on a gate nobody could evidence');
    const [gated] = journalled(events3, 'phase.gated');
    assert.match(String(gated.why), /states no condition a session could evidence/);
    assert.match(bare.current()!.phases['1'].note ?? '', /no condition a session could evidence/);
  } finally { r3.cleanup(); }

  // Delegated: the same gate boots the phase, and the journal says which kind of
  // clearance this was — a delegated human gate is not an ai-clearable one, and
  // an audit has to be able to tell them apart.
  const r2 = repo();
  r2.setGate(1, 'manual: the owner approves the copy');
  const seen2: number[] = [];
  const { instance: delegated, events } = runner(r2, workingSession(r2, seen2), '`true`', undefined, {
    delegateHumanGates: () => true,
  });
  try {
    await delegated.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', onlyPhases: [1] });
    await delegated.wait();
    assert.deepEqual(seen2, [1], 'the session is booted to verify the gate itself');
    const journal = events
      .filter((e) => e.event === 'run:journal')
      .map((e) => (e.data as { event: string }).event);
    assert.ok(journal.includes('phase.gate-delegated'), `expected a delegation line, got: ${journal.join(',')}`);
    assert.ok(!journal.includes('phase.gate-ai'), 'a delegated human gate is not an ai gate');
  } finally { r2.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Phase 8 — the session heartbeat
 * ------------------------------------------------------------------ */

test('onStream feeds the session registry: every event is liveness, only a `step` is a turn, and nothing is reported before the id is known', async () => {
  const r = repo();
  try {
    const beats: { sessionId: string; turnEnded: boolean }[] = [];
    // A session that streams a realistic turn before it finishes: some words,
    // a tool call and its result, two turn-ends, and the CLI's own retry.
    const spawn: SpawnFn = async (request: SpawnRequest) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      const sessionId = `lane-000${phase}`;
      // Before `init` there is no session id to report, so nothing may be.
      request.onEvent?.({ kind: 'text', text: 'thinking about it' });
      request.onEvent?.({ kind: 'init', sessionId, model: 'stub-1', tools: 0 });
      request.onEvent?.({ kind: 'tool', name: 'Bash', summary: 'ls', id: 't1' });
      request.onEvent?.({ kind: 'tool-result', id: 't1', ok: true });
      request.onEvent?.({ kind: 'step', tools: 1 });
      // A 429 the CLI is absorbing: the process is up, so it is liveness — but
      // it is emphatically not a turn.
      request.onEvent?.({ kind: 'retry', category: 'overloaded', attempt: 1 });
      request.onEvent?.({ kind: 'step', tools: 0 });
      r.markDone(phase);
      return ok({ sessionId });
    };

    const { instance } = runner(r, spawn, '`true`', undefined, {
      sessionHeartbeat: (sessionId, opts) => beats.push({ sessionId, turnEnded: Boolean(opts.turnEnded) }),
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    assert.equal(instance.current()?.status, 'finished');

    // Six events per phase carry an id; the `text` before `init` does not, and
    // reported nothing — there was no id to report it under.
    assert.equal(beats.length, 18, JSON.stringify(beats));
    assert.deepEqual(
      [...new Set(beats.map((b) => b.sessionId))].sort(),
      ['lane-0001', 'lane-0002', 'lane-0003'],
    );
    // Exactly the two `step`s per phase are turns. `retry`, `tool`,
    // `tool-result` and `init` are liveness and nothing more — counting a retry
    // as a turn is how a session being throttled would look like one working.
    assert.equal(beats.filter((b) => b.turnEnded).length, 6, JSON.stringify(beats));
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The task-list channel (B1)
 * ------------------------------------------------------------------ */

test('the task channel: a session publishing with phase-tasks.sh is folded into the record, journalled and streamed', async () => {
  const r = repo();
  const taskScript = join(import.meta.dirname, '..', '..', 'scripts', 'phase-tasks.sh');
  try {
    let armed: string | undefined;
    const spawn: SpawnFn = async (request: SpawnRequest) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      request.onEvent?.({
        kind: 'init', sessionId: `lane-000${phase}`, model: 'stub-1',
        tools: 2, toolNames: ['Read', 'Bash'],
      });
      // Only phase 1 publishes; the other two prove an absent list stays absent.
      if (phase === 1) {
        armed = request.env?.PE_TASKS_FILE;
        assert.ok(armed, 'every spawn arms PE_TASKS_FILE');
        // Armed, not merely named: whatever a previous attempt left is gone, so
        // a stale list can never speak for this session.
        assert.equal(existsSync(armed!), false, 'the path is deleted before every spawn');
        // The REAL script, under the real target runtime — this is the contract.
        const publish = (...args: string[]) =>
          execFileSync('/bin/bash', [taskScript, 'demo', '1', ...args], {
            env: { ...process.env, PE_TASKS_FILE: armed! }, encoding: 'utf8',
          });
        publish('reset');
        publish('create', '--subject', 'p1.task1 — one');
        publish('create', '--subject', 'p1.task2 — two');
        publish('update', '--id', 'p1.task1', '--status', 'completed');
        publish('update', '--id', 'p1.task2', '--status', 'in_progress', '--active-form', 'Doing two');
        // A finished tool call is the drain trigger: it is exactly when the
        // script has just run. No timer anywhere in this path.
        request.onEvent?.({ kind: 'tool-result', id: 't1', ok: true });
      }
      r.markDone(phase);
      return ok({ sessionId: `lane-000${phase}` });
    };

    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    assert.equal(instance.current()?.status, 'finished');

    // 1. Folded into the record — which is what survives a reload and a restart.
    const state = instance.current()!;
    assert.deepEqual(state.phases['1']!.tasks, [
      { id: 'p1.task1', content: 'p1.task1 — one', status: 'completed' },
      { id: 'p1.task2', content: 'p1.task2 — two', activeForm: 'Doing two', status: 'in_progress' },
    ]);
    assert.equal(state.phases['2']!.tasks, undefined, 'a session that published none has none');
    // …and the same list is on DISK, so a console that restarts reads it back.
    assert.deepEqual(loadRun(r.root, 'demo', state.id)!.phases['1']!.tasks, state.phases['1']!.tasks);

    // 2. Streamed, so a watching browser folds the same transitions live.
    const streamed = events
      .filter((e) => e.event === 'run:stream' && (e.data as { kind?: string }).kind === 'task')
      .map((e) => e.data as { op: string; taskId?: string; status?: string });
    assert.deepEqual(streamed.map((t) => t.op), ['reset', 'create', 'create', 'update', 'update']);
    assert.equal(streamed[3]!.taskId, 'p1.task1');

    // 3. Journalled — the shape of the list, not the list.
    const journal = events
      .filter((e) => e.event === 'run:journal')
      .map((e) => e.data as { event: string; data?: Record<string, unknown> });
    const last = journal.filter((j) => j.event === 'phase.tasks').at(-1)?.data;
    assert.deepEqual(last, { total: 2, done: 1, active: 'Doing two' });

    // 4. WHICH tools the session was given — the fact whose absence went
    //    unnoticed for ten days because the init event only counted them.
    const tools = journal.find((j) => j.event === 'phase.tools')?.data;
    assert.deepEqual(tools, { count: 2, taskTools: [] }, 'this session had none of the three — B1, recorded');
  } finally { r.cleanup(); }
});

test('a runner without the heartbeat dep behaves exactly as it did — the registry is an optional seam', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request: SpawnRequest) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      request.onEvent?.({ kind: 'init', sessionId: `lane-000${phase}`, model: 'stub-1', tools: 0 });
      request.onEvent?.({ kind: 'step', tools: 0 });
      r.markDone(phase);
      return ok({ sessionId: `lane-000${phase}` });
    };
    const { instance } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    assert.equal(instance.current()?.status, 'finished');
    assert.deepEqual(Object.values(instance.current()!.phases).map((p) => p.status), ['done', 'done', 'done']);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Retry with edits
 *
 * Retry used to be all-or-nothing: it cleared the failure and boarded the
 * phase again with byte-identical settings. These pin the third level of
 * `optionsFor` — what the operator chose for THIS ATTEMPT — and the two
 * properties that make it safe to offer: it is spent at the boarding it
 * causes, and it never writes to the plan.
 * ------------------------------------------------------------------ */

const ADDENDUM = 'The suite is fine — the golden fixture is stale. Regenerate it, do not widen the tolerance.';

/** A run stopped with phase 1 failed: the state a person presses Retry from. */
function stoppedOnFailure(r: Repo, model = 'claude-sonnet-5') {
  const state = newRun({ slug: 'demo', root: r.root, model });
  const record = phaseRecord(state, 1);
  record.status = 'failed';
  record.model = model;
  record.note = 'the parity golden did not match';
  saveRun(state);
  return state;
}

/** Every boarding the fake CLI saw, in order. */
function boardingRecorder(r: Repo, seen: { phase: number; model?: string; prompt: string }[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push({ phase, model: request.model, prompt: request.prompt });
    r.markDone(phase);
    return ok();
  };
}

test('a retry with an addendum and a model override boards ONCE with both, journalled, plan untouched', async () => {
  const r = repo();
  const planFile = join(r.root, 'docs', 'plans', 'demo.md');
  const planBefore = readFileSync(planFile, 'utf8');

  const state = stoppedOnFailure(r);
  resetForRetry(phaseRecord(state, 1), {
    by: 'operator',
    override: retryOverrideFrom({
      addendum: ADDENDUM,
      options: { model: 'claude-opus-5' },
      by: 'console',
    }),
    journal: () => {},
  });
  saveRun(state);

  const seen: { phase: number; model?: string; prompt: string }[] = [];
  const { instance } = runner(r, boardingRecorder(r, seen));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, autonomy: 'keep-going' });
  await instance.wait();

  const first = seen.filter((b) => b.phase === 1);
  assert.equal(first.length, 1, 'exactly one boarding of the retried phase');
  assert.equal(first[0].model, 'claude-opus-5', 'the attempt override beats the run default');
  assert.match(first[0].prompt, /THE OPERATOR RE-BOARDED THIS PHASE WITH AN INSTRUCTION FOR THIS ATTEMPT/);
  assert.ok(first[0].prompt.includes(ADDENDUM), 'verbatim, not paraphrased');

  // Spent: the phases after it are the run's own settings again.
  for (const later of seen.filter((b) => b.phase !== 1)) {
    assert.equal(later.model, 'claude-sonnet-5', `phase ${later.phase} kept the run default`);
    assert.doesNotMatch(later.prompt, /RE-BOARDED THIS PHASE WITH AN INSTRUCTION/,
      `phase ${later.phase} must not inherit another phase's addendum`);
  }
  assert.equal(instance.current()!.phases['1'].retryOverride, undefined, 'the record no longer carries it');

  // …but the journal does, so "why did phase 1 run on Opus that once" stays answerable.
  const entries = new Journal(r.root, 'demo', state.id).read();
  const overrides = entries.filter((e) => e.event === 'phase.retry-override');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].phase, 1);
  assert.equal((overrides[0].data as { addendum?: string }).addendum, ADDENDUM);
  assert.deepEqual((overrides[0].data as { options?: unknown }).options, { model: 'claude-opus-5' });
  assert.equal((overrides[0].data as { by?: string }).by, 'console');
  // The source line explains the surprise without a second lookup.
  const started = entries.find((e) => e.event === 'phase.start' && e.phase === 1)!;
  assert.equal((started.data as { source: Record<string, string> }).source.model, 'retry');

  assert.equal(readFileSync(planFile, 'utf8'), planBefore, 'a one-off must never edit a versioned file');
  r.cleanup();
});

test('an addendum-only retry changes nothing else — the model is still the one the phase had', async () => {
  const r = repo();
  const state = stoppedOnFailure(r);
  resetForRetry(phaseRecord(state, 1), { by: 'operator', override: retryOverrideFrom({ addendum: ADDENDUM }), journal: () => {} });
  saveRun(state);
  // The record's sticky model survives, because the override named none.
  assert.equal(phaseRecord(state, 1).model, 'claude-sonnet-5');

  const seen: { phase: number; model?: string; prompt: string }[] = [];
  const { instance } = runner(r, boardingRecorder(r, seen));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, autonomy: 'keep-going' });
  await instance.wait();

  const first = seen.find((b) => b.phase === 1)!;
  assert.equal(first.model, 'claude-sonnet-5');
  assert.ok(first.prompt.includes(ADDENDUM));
  r.cleanup();
});

test('a plain Retry after one with edits is a plain retry — an unspent override is cleared, not inherited', () => {
  const r = repo();
  const state = stoppedOnFailure(r);
  const record = phaseRecord(state, 1);

  resetForRetry(record, { by: 'operator', override: retryOverrideFrom({ addendum: ADDENDUM, options: { model: 'claude-opus-5' } }), journal: () => {} });
  assert.equal(record.retryOverride!.addendum, ADDENDUM);
  assert.equal(record.model, undefined, 'a model override clears the sticky one, or it would be ignored');

  record.status = 'failed';
  resetForRetry(record, { by: 'operator', journal: () => {} });
  assert.equal(record.retryOverride, undefined, 'pressing Retry means "again, as the plan says"');
  r.cleanup();
});

test('an override with nothing in it is not an override', () => {
  assert.equal(retryOverrideFrom(undefined), undefined);
  assert.equal(retryOverrideFrom({}), undefined);
  assert.equal(retryOverrideFrom({ addendum: '   ' }), undefined, 'whitespace is not an instruction');
  assert.equal(retryOverrideFrom({ options: {} }), undefined, 'an empty settings object is not a choice');
  // `by` alone is attribution for a decision nobody made.
  assert.equal(retryOverrideFrom({ by: 'console' }), undefined);
  const real = retryOverrideFrom({ addendum: `  ${ADDENDUM}  `, by: 'console' }, '2026-08-24T00:00:00.000Z');
  assert.deepEqual(real, { addendum: ADDENDUM, by: 'console', at: '2026-08-24T00:00:00.000Z' });
});

test('the attempt override outranks the run`s own per-phase choice, which outranks the plan', async () => {
  const r = repo();
  const state = newRun({
    slug: 'demo',
    root: r.root,
    model: 'claude-sonnet-5',
    // What the operator chose for this RUN, for every phase.
    phaseOptions: { 1: { model: 'claude-haiku-4-5-20251001' }, 2: { model: 'claude-haiku-4-5-20251001' } },
  });
  resetForRetry(phaseRecord(state, 1), { by: 'operator', override: retryOverrideFrom({ options: { model: 'claude-opus-5' } }), journal: () => {} });
  saveRun(state);

  const seen: { phase: number; model?: string; prompt: string }[] = [];
  const { instance } = runner(
    r, boardingRecorder(r, seen), '`true`',
    // …and what the PLAN says, which both of the above outrank.
    () => ({ model: 'claude-fable-5' }),
  );
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(seen.find((b) => b.phase === 1)!.model, 'claude-opus-5', 'attempt');
  assert.equal(seen.find((b) => b.phase === 2)!.model, 'claude-haiku-4-5-20251001', 'run');
  assert.equal(seen.find((b) => b.phase === 3)!.model, 'claude-fable-5', 'plan');
  r.cleanup();
});

test('an attempt override REPLACES the run`s list-valued choices rather than merging with them', async () => {
  const r = repo();
  const state = newRun({
    slug: 'demo', root: r.root, model: 'claude-sonnet-5',
    phaseOptions: { 1: { tools: ['Read', 'Grep', 'Bash'] } },
  });
  // Narrowing this attempt to two tools has to MEAN two tools — a union with
  // the run's list would quietly hand back the one being taken away.
  resetForRetry(phaseRecord(state, 1), { by: 'operator', override: retryOverrideFrom({ options: { tools: ['Read', 'Grep'] } }), journal: () => {} });
  saveRun(state);

  const seen: { phase: number; model?: string; effort?: string; tools?: string[] }[] = [];
  const { instance } = runner(r, recordingSession(r, seen));
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1], autonomy: 'keep-going' });
  await instance.wait();

  assert.deepEqual(seen.find((b) => b.phase === 1)!.tools, ['Read', 'Grep']);
  r.cleanup();
});

/* ===========================================================================
 * D1 / D2 / D4 / D25 — the admission & lock layer keeps its own promises.
 * =========================================================================== */

test('D4: a lock held by a SPACED owner whose session ended is released as debris', async () => {
  // `/held by (\S+)/` read `"Ada Lovelace/laptop"` as `Ada`. Every comparison
  // downstream is an equality against what the script wrote, so the holder
  // never matched itself: the release named a holder that does not exist, the
  // real script refuses it, and the journal recorded an attempt that freed
  // nothing. The phase then queued behind debris for the whole lease.
  const r = repo();
  try {
    r.setLockSpacedOwner(true);
    const seen: number[] = [];
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      seen.push(phase); r.markDone(phase); return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      lockPresence: () => 'ended' as const,
    });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    const released = journalled(events, 'phase.lock-debris-released');
    assert.equal(released.length, 1, 'the debris check fired');
    assert.equal(released[0].holder, 'Ada Lovelace/laptop', 'the WHOLE owner, spaces and all');
    assert.equal(released[0].session, 'sess-ada');

    const calls = readFileSync(join(r.state, 'locks'), 'utf8').split('\n').filter(Boolean);
    assert.ok(calls.some((c) => c.includes('release 1 --owner Ada Lovelace/laptop')),
      `the release names the real holder:\n${calls.join('\n')}`);
    assert.deepEqual(seen, [1], 'and boarding went on');
  } finally { r.cleanup(); }
});

test('a phase queued behind a foreign GRANT is NEVER capped — it boards when the grant releases', async () => {
  // D2 REVERSED (2026-08-30, R9). D2 brought grants under the two-hour cap so a
  // hung sibling lane could not hold a run for ever; measured across 34 runs the
  // cure cost more than the disease — a healthy sibling that simply takes three
  // hours parked its waiter at two, and the park then read as a failure and
  // climbed the ladder. Queueing behind a sibling is PIPELINING, and the hung
  // case is bounded by the wedged lane's OWN watchdog (nudge → recycle → park),
  // which acts on the lane that is wrong rather than on the one waiting behind
  // it. The wait here is seeded three hours old — past the old cap — precisely
  // to prove the cap does not fire.
  const r = repo();
  const scheduler = new Scheduler({ guard: () => true });
  try {
    // Somebody else's lane, admitted — and released once the waiter is queued.
    const foreign = await scheduler.admit({
      slug: 'other', phase: 9, runId: 'r-foreign', scope: ['blocked-repo'],
    });
    assert.ok(foreign);

    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const seen: number[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
      return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      scheduler, phaseScope: () => ['blocked-repo'],
    });
    const started = instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    // The sibling finishes, as siblings do. Under the old rule the cap had
    // already fired by now and this release changed nothing.
    setTimeout(() => scheduler.release(foreign), 150).unref?.();
    await started;
    await instance.wait();

    const state = instance.current()!;
    assert.deepEqual(seen, [1], 'the waiter boarded once the sibling let go');
    assert.notEqual(state.phases['1'].status, 'parked', 'waiting well is not a failure');
    assert.deepEqual(journalled(events, 'phase.lock-wait-capped'), [],
      'a sibling grant is pipelining — capping it punishes the wrong lane');
  } finally { scheduler.close(); r.cleanup(); }
});

test('D2: a wait on a CLOCK is never capped into a park', async () => {
  // A clock holder is a wait that ends by itself: the boarding window, the
  // operator's own hold, a chain, the fleet freeze, an account's usage wall.
  // Capping one would park a phase for doing exactly what it was told.
  //
  // The example is the operator's HOLD, and deliberately not the session cap —
  // D28 took the cap out of this family on purpose ("it ends when some other
  // lane happens to release, which in the shape that matters is never"), and
  // `D28: at the session cap a queued phase parks at the wait cap` is the test
  // that pins the opposite for it. This one used the cap as its clock and so
  // asserted the contract D28 reversed; it passed only while the release beat
  // the admission, and went red the first time the suite ran serially.
  const r = repo();
  let held: { at: string; by?: string } | null = { at: new Date().toISOString(), by: 'mo' };
  const scheduler = new Scheduler({ max: 1, guard: () => true, holdFor: () => held });
  try {
    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    // Three hours of history: with a clock holder this must NOT arm the cap.
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(stale);

    const seen: number[] = [];
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      seen.push(phase); r.markDone(phase); return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      scheduler, phaseScope: () => ['mine'],
    });
    const run = instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    // Lift the hold a moment later: the phase must admit, not park.
    setTimeout(() => { held = null; scheduler.poll(); }, 200);
    await run;
    await instance.wait();

    assert.deepEqual(seen, [1], 'it waited out the hold and then ran');
    assert.equal(journalled(events, 'phase.lock-wait-capped').length, 0,
      'a clock wait is never capped');
  } finally { scheduler.close(); r.cleanup(); }
});

test('D25: phase.admitted reports the WHOLE wait, not the age of the last write', async () => {
  // `Date.now() - Date.parse(state.updatedAt)` measured the newest write to the
  // run — which every persist() from a lane working beside the queue moves — so
  // a 653-minute queue gap reported itself as 20 seconds. The clock that means
  // something is `lockWaitSince`, stamped when the wait began and surviving
  // re-arms.
  const r = repo();
  const scheduler = new Scheduler({ guard: () => true });
  const WAITED_MS = 40 * 60_000;
  try {
    const locks: LockView[] = [{
      slug: 'other', phase: 9, owner: 'someone/else', expired: false,
      scope: ['blocked-repo'], leaseUntil: Date.now() + 30 * 60_000,
    }];
    const s = new Scheduler({ guard: () => true, locks: () => locks });

    const stale = newRun({ slug: 'demo', root: r.root, model: 'opus' });
    stale.status = 'paused';
    stale.onlyPhases = [1];
    // Forty minutes of waiting already banked — well inside the two-hour cap.
    phaseRecord(stale, 1).lockWaitSince = new Date(Date.now() - WAITED_MS).toISOString();
    saveRun(stale);

    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
      r.markDone(phase); return ok();
    };
    const { instance, events } = runner(r, spawn, undefined, undefined, {
      scheduler: s, phaseScope: () => ['blocked-repo'],
    });
    const run = instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    // Freed once the phase is genuinely QUEUED, not on a stopwatch: boarding
    // shells out to validate.sh and phase-graph.sh first, so a fixed delay
    // races the admission it is supposed to be waiting for.
    const freeIt = setInterval(() => {
      if (!journalled(events, 'phase.queued').length) return;
      locks.length = 0; s.poll(); clearInterval(freeIt);
    }, 20);
    await run;
    await instance.wait();
    clearInterval(freeIt);
    s.close();

    const admitted = journalled(events, 'phase.admitted');
    assert.ok(admitted.length, `it admitted rather than parking: ${events.map((e) => e.event).join(', ')}`);
    const waitedMs = admitted[0].waitedMs as number;
    assert.ok(waitedMs >= WAITED_MS,
      `the report covers the whole wait, not the last leg (got ${waitedMs}, banked ${WAITED_MS})`);
    assert.ok(waitedMs < WAITED_MS + 60_000, `and is not invented either (got ${waitedMs})`);
  } finally { scheduler.close(); r.cleanup(); }
});

/* --- QA extension (phase 1): the belt-check's half of D1 -------------------
 *
 * The scheduler half of D1 shipped with four tests. The belt-check half — the
 * branch that was DELETED, and `phase.lock-ignored` with it — shipped with
 * none, so nothing in the suite would notice if it came back. It is the second
 * of the two doors onto a phase: `Scheduler.blocking` decides who may join the
 * queue, this decides who may actually spawn once a grant is in hand.
 */

test('D1: guard OFF — the belt-check queues on a same-phase foreign lock instead of walking past it', async () => {
  const r = repo();
  try {
    r.setLockRefused(true);
    // The scheduler is given NO locks, so admission cannot be what stops this:
    // the only thing that can see the holder is boarding's own belt-check,
    // which asked `phase-lock.sh status` and — with the guard off — journalled
    // `phase.lock-ignored` and spawned a second session onto a phase somebody
    // else was already working.
    const scheduler = new Scheduler({ locks: () => [], guard: () => false });
    const seen: number[] = [];
    const inner = workingSession(r, seen);
    const boardedAt: number[] = [];
    const spawn: SpawnFn = async (request) => { boardedAt.push(Date.now()); return inner(request); };
    const { instance, events } = runner(r, spawn, undefined, undefined, { scheduler });
    const started = instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });

    let freedAt = 0;
    setTimeout(() => { freedAt = Date.now(); r.setLockRefused(false); }, 1_500);
    await started;
    await instance.wait();
    scheduler.close();

    assert.ok(journalled(events, 'phase.lock-race').length,
      'the guard-off belt-check queues behind the holder');
    assert.equal(journalled(events, 'phase.lock-ignored').length, 0,
      'and never journals a walk-past, because there is no longer such a thing');
    assert.deepEqual(seen, [1], 'the phase ran exactly once');
    assert.equal(boardedAt.length, 1, 'and exactly one session was ever spawned for it');
    assert.ok(freedAt > 0 && boardedAt[0] >= freedAt,
      `no session was spawned while the lock was held (spawned ${boardedAt[0]}, freed ${freedAt})`);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The retry storm — criterion 4 of console-unattended-autopilot P2
 *
 * Beside the silent watchdog because it is the same machinery on a different
 * silence, and because the fixture below (`silentSession`) is what boards a
 * lane that never produces a turn. The difference is that this lane is not
 * quiet: it emits `api_retry` and nothing else, which used to satisfy every
 * clock in the console — the first-event backstop cleared on the first retry,
 * `retrying` was a card, and `liveWall` only ever acts on `rate_limit`.
 * ------------------------------------------------------------------ */

test('a lane that does nothing but retry is recycled once, then parked on the wall it is hitting', async () => {
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  assert.equal(state.slug, 'demo');
  await s.gates[0].entered;

  // Five retries in a row with nothing between them — `stallRetryBurst`. The
  // count is the clock here, not a duration: what makes a storm a storm is that
  // nothing got between the retries, and the CLI's cadence is its own business.
  for (let i = 0; i < 5; i += 1) {
    s.say({ kind: 'retry', category: 'overloaded', attempt: i + 1, detail: 'Overloaded' });
  }
  clock.wind(60_000);
  await instance.tickLiveness();

  const recycled = instance.current()!.phases['1'];
  assert.equal(recycled.stallRemedy?.retryRecycles, 1, 'rung 1: one recycle');
  assert.equal(recycled.stallRemedy?.recycles ?? 0, 0,
    'and NOT on the silent ladder’s counter — a rung spent for a storm is not a rung spent for silence');
  assert.equal(recycled.status, 'pending', 'the phase goes back to the queue, it does not fail');
  assert.equal(recycled.resumeSessionId, 'sess-silent', 'the session is kept — this is a resume');
  assert.equal(recycled.stall, undefined, 'the card is retracted with the session it was about');
  assert.equal(
    events.filter((e) => e.event === 'run:watchdog').map((e) => e.data.action).join(','),
    'retry-recycled',
  );

  // The loop re-boards it, and the second attempt storms too.
  s.gates[0].release();
  await s.gates[1].entered;
  assert.equal(s.spawned(), 2, 'the phase was re-boarded');
  for (let i = 0; i < 5; i += 1) {
    s.say({ kind: 'retry', category: 'overloaded', attempt: i + 1, detail: 'Overloaded' });
  }
  clock.wind(60_000);
  await instance.tickLiveness();

  const parked = instance.current()!.phases['1'];
  assert.equal(parked.status, 'waiting', 'rung 2: parked, not failed and not recycled again');
  assert.ok(parked.stallRemedy?.retryParkedAt, 'the park is on the ledger');
  assert.ok(parked.parkedUntil, 'and it has a resume clock');
  // `overloaded` is CAPACITY: there is no usage window to be told about, so the
  // park gets the fixed short one rather than a meter reading it never had.
  assert.equal(
    Date.parse(parked.parkedUntil!) - clock.now().getTime(), RETRY_STORM_PARK_MS,
    'ten minutes for a capacity wall',
  );
  // What makes the classifier answer `resource-wall:usage` rather than "the
  // session went quiet" — the difference between an errand that says "wait for
  // the window" and one that says "go and look at it". It is the PHASE's note,
  // read by `situation.ts`'s `USAGE_RE`, and deliberately NOT a fabricated
  // run-level `limits.status`: nothing clears that field but a live event from
  // a running session, so it is sticky, it outranks `blocked-declared`, and it
  // relabelled every OTHER phase of the run a usage wall (QA F7).
  // This asserts the note's SHAPE. The property itself — that the real
  // classifier answers `resource-wall:usage` for this record — is proved in
  // `situation.test.ts` ("a waiting park the CONSOLE made is classified by its
  // own note"), because a regex here is a proxy and a proxy stayed green while
  // the property failed for the whole of round 1 (QA round 2, G3).
  assert.match(parked.note ?? '', /window resets/);
  assert.equal(instance.current()!.limits?.status, undefined,
    'and one phase’s wall is not the account’s — no run-level marker is invented');

  // A third tick must not re-park: re-writing `parkedUntil` forward on every
  // tick is a wait that never ends.
  const until = parked.parkedUntil;
  clock.wind(60_000);
  await instance.tickLiveness();
  assert.equal(instance.current()!.phases['1'].parkedUntil, until, 'parked once, not rewritten every tick');

  // The stub for attempt 2 is still holding its gate; let it go, then stop.
  // The journal is flushed when the run ends, exactly as the silent watchdog's
  // test reads it after `wait()`.
  // Both rungs are journalled, and under the names the docs and the journal-kind
  // parity test know them by. Read off the event stream rather than the file:
  // `record()` writes both at once, and the file's directory is created by the
  // first `saveRun`, so a run that parks before one has a journal with holes in
  // it (the silent watchdog's test reads the file only after a completed run).
  const kinds = events.filter((e) => e.event === 'run:journal').map((e) => e.data.event);
  assert.ok(kinds.includes('phase.retry-storm-recycled'), `no recycle line: ${kinds.join(',')}`);
  assert.ok(kinds.includes('phase.retry-storm-parked'), `no park line: ${kinds.join(',')}`);
  s.gates[1].release();
  await instance.stop();
  r.cleanup();
});

test('a retry storm parks on the METER’s reset time when the CLI reported one', async () => {
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  // The account's own window, out of band — reported in epoch SECONDS, which is
  // the trap this asserts: reading it as milliseconds parks the phase in 1970
  // and resumes it instantly.
  //
  // EIGHT minutes, inside `LIMIT_ACTION_COOLDOWN_MS`. This read ninety until
  // autopilot-token-drain phase 6: a reset that far off now makes the live wall
  // wait on the window at the FIRST rate-limit burst (`trigger: far-reset`,
  // `usage-brake.test.ts`), so the storm never reaches this watchdog's
  // recycle-then-park ladder and the second attempt this test awaits never
  // boards. A near reset is where the ladder still acts, and where its reading
  // of the meter's clock is still the thing to prove — eight minutes is neither
  // `RETRY_STORM_PARK_MS` (ten) nor 1970.
  const resetsAt = Math.floor((clock.now().getTime() + 8 * 60_000) / 1000);
  s.say({ kind: 'limits', status: 'rejected', resetsAt });

  const storm = () => {
    for (let i = 0; i < 5; i += 1) s.say({ kind: 'retry', category: 'rate_limit', attempt: i + 1, detail: '429' });
  };
  storm();
  clock.wind(60_000);
  await instance.tickLiveness();
  s.gates[0].release();
  await s.gates[1].entered;
  storm();
  clock.wind(60_000);
  await instance.tickLiveness();

  const parked = instance.current()!.phases['1'];
  assert.equal(parked.status, 'waiting');
  assert.equal(Date.parse(parked.parkedUntil!), resetsAt * 1000,
    'the meter’s own clock, in seconds — not ten minutes, and not 1970');
  // The `limits` event this test fed in is the CLI's own and stays as it was;
  // what must not appear is a `status` the park invented on top of it.
  assert.notEqual(instance.current()!.limits?.status, 'limited');
  s.gates[1].release();
  await instance.stop();
  r.cleanup();
});

test('a lane that retries and then WORKS is left alone', async () => {
  const r = repo();
  const s = silentSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await s.gates[0].entered;

  for (let i = 0; i < 5; i += 1) {
    s.say({ kind: 'retry', category: 'rate_limit', attempt: i + 1, detail: '429' });
  }
  // One real tool call. The burst is consecutive BY DEFINITION — one productive
  // event ends it — so the signal never fires and no rung is ever climbed. This
  // is the assertion that keeps the remedy off a session that is working
  // through a rough patch, which is the overwhelmingly common case.
  s.say({ kind: 'tool', name: 'Read', id: 't1', input: {} } as unknown as StreamEvent);
  clock.wind(60_000);
  await instance.tickLiveness();

  const record = instance.current()!.phases['1'];
  assert.equal(record.stallRemedy?.retryRecycles ?? 0, 0, 'nothing was climbed');
  assert.equal(record.status, 'running', 'and the lane is untouched');
  s.gates[0].release();
  await instance.stop();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A resume the CLI cannot find — the warm QA chase and the attempt loop
 * ------------------------------------------------------------------ */

const LOST_RESUME = (id: string): SpawnOutcome => ({
  signal: { subtype: 'error_during_execution', code: 1, text: `No conversation found with session ID: ${id}\n` },
  sessionId: undefined, costUsd: 0, turns: 0, resultText: '', durationMs: 3, argv: [], injected: 0,
});

test('the warm QA chase whose resume is gone marks the session gone and records no phantom round', async () => {
  // Measured (run 65958e6e, phase 7): `--resume` of the phase's own session
  // answered `No conversation found`, and the round was scored as a review
  // that recorded nothing — a `pending` entry on the record, a rung spent,
  // and the same `--resume` offered again two minutes later.
  const r = repo();
  r.setQaOwed('pending');
  const spawns: { name?: string; resume?: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ name: request.name, resume: request.resume });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    if (request.resume) return LOST_RESUME(request.resume);
    return ok();
  };
  const { instance, events } = runner(r, spawn, '`true`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const journal = (event: string) => events.filter((e) => e.event === 'run:journal'
    && (e.data as { event?: string }).event === event);
  const chase = () =>
    (instance as unknown as { maybeQaVerdict(phase: number): Promise<void> }).maybeQaVerdict(1);

  // The warm chase ran at phase finish, inside the run: one `--resume` of the
  // phase's own session per phase, each refused by the CLI.
  const record = instance.current()!.phases['1'];
  assert.deepEqual(spawns.filter((s) => s.resume === 'sess-p1').length, 1, 'the chase spawned the resume once');
  const lostP1 = journal('phase.resume-lost').filter((e) => (e.data as { phase?: number }).phase === 1);
  assert.equal(lostP1.length, 1, 'the lost resume is journalled by name');
  assert.equal(record.sessionGone?.sessionId, 'sess-p1');
  assert.equal(journal('phase.qa-session-done').length, 0, 'a session that never ran is not a round that happened');
  assert.equal(record.qa?.length ?? 0, 0, 'no phantom pending round on the record');

  // Asked again, the chase does not repeat a `--resume` it knows is gone.
  const before = spawns.length;
  await chase();
  assert.equal(spawns.length, before, 'a gone session is not resumed a second time');
  const skipped = journal('phase.qa-session-skipped');
  assert.ok(skipped.length >= 1);
  assert.match(String((skipped.at(-1)!.data as { data?: { reason?: string } }).data?.reason ?? ''), /gone|cannot be resumed|resume/i);
  r.cleanup();
});

test('an attempt whose checkpointed session is gone boards fresh in the same breath, and it is not a failure', async () => {
  // A checkpoint left `resumeSessionId` behind; the transcript did not follow
  // the account. The boot prompt is self-contained by design, so the right
  // answer is a fresh boarding NOW — not a 60 s retry of the same `--resume`.
  const r = repo();
  const stale = newRun({ slug: 'demo', root: r.root });
  stale.status = 'paused';
  stale.phases['1'] = { phase: 1, status: 'pending', attempts: 1, costUsd: 0, resumeSessionId: 'sess-old' };
  saveRun(stale);
  const spawns: { resume?: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ resume: request.resume });
    if (request.resume) return LOST_RESUME(request.resume);
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) r.markDone(Number(boot[1]));
    return ok();
  };
  const { instance, events } = runner(r, spawn, '`true`');
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.deepEqual(spawns.slice(0, 2).map((s) => s.resume ?? null), ['sess-old', null], 'the lost resume, then a fresh boot at once');
  assert.equal(state.phases['1'].status, 'done');
  assert.equal(state.consecutiveFailures, 0, 'a resume the CLI refused is not the phase failing');
  const lost = events.filter((e) => e.event === 'run:journal' && (e.data as { event?: string }).event === 'phase.resume-lost');
  assert.equal(lost.length, 1);
  assert.equal(state.phases['1'].sessionGone?.sessionId, 'sess-old');
  r.cleanup();
});

test('the drive loop boards its own QA rung: a done phase held by a fail resumes its session with the fix brief', async () => {
  // RC4 (measured on phase-console-commerce, 2026-09-05): `climbLadder`
  // admitted the QA holder and `climb` spent a rung on it, but the hint it
  // left carried no instruction (the generic "carry on" brief for a phase that
  // had finished) and the candidate filter admitted a board-`done` phase only
  // for a review follow-up — so the rung was spent, no session ran, and the
  // healer had to do it the long way round.
  const r = repo();
  r.markDone(1);
  r.setQaBlocked(1, 'fail');
  mkdirSync(join(r.root, 'docs', 'handoffs', 'demo'), { recursive: true });
  writeFileSync(join(r.root, 'docs', 'handoffs', 'demo', 'test-status.md'),
    '# QA\n\n## QA status\n\n| Phase | Result | Report | Round |\n|--:|--|--|--:|\n| 1 | fail | reports/phase-01-qa.md | 1 |\n');
  const seeded = newRun({ slug: 'demo', root: r.root, autoRecover: true });
  seeded.status = 'paused';
  seeded.phases['1'] = { phase: 1, status: 'done', attempts: 1, costUsd: 0, sessionId: 'sess-p1' };
  saveRun(seeded);
  const spawns: { resume?: string; prompt: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ resume: request.resume, prompt: request.prompt });
    if (request.resume === 'sess-p1') {
      // The resumed session fixes the phase and records a pass: the wedge opens.
      r.setQaBlocked(null);
      r.markDone(1);
      return ok({ sessionId: 'sess-p1' });
    }
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) r.markDone(Number(boot[1]));
    return ok();
  };
  const { instance } = runner(r, spawn, '`true`');
  await instance.start({ slug: 'demo', root: r.root, resumeRunId: seeded.id, autonomy: 'keep-going' });
  await instance.wait();

  const resumed = spawns.filter((s) => s.resume === 'sess-p1');
  assert.equal(resumed.length, 1, `the loop resumed the phase's own session once — spawns: ${JSON.stringify(spawns.map((s) => s.resume ?? 'boot'))}`);
  // The brief is the QA fix brief with the ONE chooser's round and report —
  // never the generic "you were interrupted, carry on".
  assert.match(resumed[0].prompt, /qa-record\.sh demo 1 <pass\|fail\|waived> --report reports\/phase-01-qa-round2\.md --round 2/);
  assert.match(resumed[0].prompt, /docs\/handoffs\/demo\/reports\/phase-01-qa\.md/, 'the fix reads the report that failed it');
  // And with the verdict recorded, the run carried on through the rest.
  const state = instance.current()!;
  assert.equal(state.phases['2']?.status, 'done');
  assert.equal(state.phases['3']?.status, 'done');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A QA round is a session like any other
 * ------------------------------------------------------------------ */

test('a QA round is a first-class session: task channel, stream, pid handle, and a live marker on the record', async () => {
  // RC2 (measured): `qaRound` was the one spawn with no `onEvent`, no
  // `PE_TASKS_FILE`, no `onPid` — so the reviewer's output never reached the
  // run log, its task list had nowhere to go, Stop could not see it, and the
  // record said nothing about a review being in flight.
  const r = repo();
  r.setQaOwed('pending');
  type Seen = { env?: NodeJS.ProcessEnv; cwd?: string; onEvent: boolean; onPid: boolean; marker?: unknown; name?: string };
  const seen: Seen[] = [];
  let holder: { instance: InstanceType<typeof Runner> } | null = null;
  const spawn: SpawnFn = async (request) => {
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    if (request.resume === 'sess-p1') {
      seen.push({
        env: request.env, cwd: request.cwd, name: request.name,
        onEvent: typeof request.onEvent === 'function', onPid: typeof request.onPid === 'function',
        marker: holder?.instance.current()?.phases['1']?.qaSession,
      });
      // The reviewer publishes a task, exactly as `phase-tasks.sh` does, and
      // the next tool result is what the runner tails the file on.
      if (request.env?.PE_TASKS_FILE) {
        writeFileSync(request.env.PE_TASKS_FILE, `${JSON.stringify({
          version: 1, type: 'task', slug: 'demo', phase: 1, op: 'create', id: 'qa.1',
          subject: 'read the diff cold', status: 'in_progress', written_at: new Date().toISOString(),
        })}\n`);
      }
      request.onPid?.(process.pid);
      request.onEvent?.({ kind: 'tool-result', id: 't1', ok: true });
      return ok({ sessionId: 'sess-p1', turns: 4 });
    }
    return ok();
  };
  const { instance, events } = runner(r, spawn, '`true`');
  holder = { instance };
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(seen.length, 1, 'phase 1 was chased once');
  const round = seen[0];
  assert.match(round.name ?? '', /qa-verdict$/);
  assert.match(round.env?.PE_TASKS_FILE ?? '', /run-[0-9a-f]{8,32}-p1-tasks\.ndjson$/, 'the reviewer is handed the task channel');
  assert.ok(round.env?.PE_RULINGS_FILE, 'and the rulings ledger');
  assert.ok(round.env?.PE_OWNER, 'and the owner every hook reads');
  assert.equal(round.env?.PE_OUTCOME_FILE, undefined, 'a reviewer declares no phase outcome');
  assert.equal(round.cwd, r.root, "the phase's own tree");
  assert.equal(round.onEvent, true, 'its stream reaches the runner');
  assert.equal(round.onPid, true, 'its pid is attached, so Stop and Freeze can reach it');
  assert.equal((round.marker as { round?: number } | undefined)?.round, 1, 'the record says a round is in flight while it is');
  assert.equal((round.marker as { report?: string } | undefined)?.report, 'reports/phase-01-qa.md');

  const record = instance.current()!.phases['1'];
  assert.equal(record.qaSession, undefined, 'the marker is cleared when the round ends');
  assert.equal(record.tasks?.[0]?.content, 'read the diff cold', "the reviewer's task list is on the record");
  const streamed = events.filter((e) => e.event === 'run:stream'
    && (e.data as { phase?: number; kind?: string }).phase === 1
    && (e.data as { kind?: string }).kind === 'task');
  assert.ok(streamed.length >= 1, 'and the task transition was broadcast on the run stream');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * "Stop and ask me" stops on a QA fail
 * ------------------------------------------------------------------ */

test('under halt-on-everything a recorded QA fail parks the run on the phase, naming the report; keep-going carries on', async () => {
  // RC5: `record.status = 'done'` was written before the verdict was even
  // looked at, and `carryOn` read only the halt and the autonomy — so the
  // cautious mode, whose label is "Stop and ask me", moved on past a fail
  // exactly as the eager one did.
  for (const autonomy of ['halt-on-everything', 'keep-going'] as const) {
    const r = repo();
    r.setQaOwed('fail');
    const { instance } = runner(r, workingSession(r), '`true`');
    await instance.start({ slug: 'demo', root: r.root, autonomy });
    await instance.wait();
    const state = instance.current()!;
    if (autonomy === 'halt-on-everything') {
      assert.equal(state.status, 'parked', 'the cautious run stops to ask');
      assert.equal(state.phases['1'].status, 'done', 'the phase itself did its work');
      assert.equal(state.phases['1'].halt?.kind, 'needs-human');
      assert.match(state.phases['1'].halt?.reason ?? '', /QA .*fail/i);
      assert.match(state.phases['1'].halt?.reason ?? '', /reports\/phase-01-qa\.md/, 'the report is named');
      assert.equal(state.phases['2']?.status ?? 'pending', 'pending', 'nothing after it started');
    } else {
      assert.equal(state.phases['3']?.status, 'done', 'the eager run carries on — the ladder owns the fix');
    }
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * `paused` never sits under a standing halt
 * ------------------------------------------------------------------ */

test('an operator stop under a standing run-level halt keeps the run halted, pinned as the operator\'s', async () => {
  // Measured (hub run e44c15da): `status: paused` beside a non-null `halt`,
  // so one screen painted the run as merely waiting while the strip raised
  // the halt as an error. `runRecovery` already settled this the other way
  // round (`if (!state.halt) state.status = 'paused'`); the attempt path did
  // not ask.
  const r = repo();
  // The stop must land while the lane is MID-SESSION: `start()` returns before
  // the board subprocess has even seated phase 1, so the stub signals the
  // moment the session is live instead of the test guessing a sleep.
  let live!: () => void;
  const sessionLive = new Promise<void>((resolve) => { live = resolve; });
  const spawn: SpawnFn = (request) => new Promise((resolve) => {
    live();
    request.signal?.addEventListener('abort', () => resolve(ok({
      signal: { subtype: 'error_during_execution', code: 143, text: 'terminated' }, turns: 0, costUsd: 0,
    })), { once: true });
  });
  const { instance } = runner(r, spawn, '`true`');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await sessionLive;
  // A run-level halt lands while the lane is mid-session (another lane's
  // budget, say) — then the operator presses Stop.
  const at = new Date().toISOString();
  instance.current()!.halt = { at, reason: 'the run budget of $5 is spent', kind: 'budget' };
  await instance.stop();
  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'halted', 'the halt that stands is the word, not `paused`');
  assert.equal(state.halt?.kind, 'budget', 'and it is left intact');
  assert.equal(state.stoppedBy, 'operator', 'pinned as the operator\'s stop, so nothing relaunches it');
  assert.equal(state.phases['1'].status, 'interrupted');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * The session ledger (zero-touch-console phase 4, chapter 03)
 * ------------------------------------------------------------------ */

const { CAP_SOURCES } = await import('../shared/run-lifecycle.js');
type LedgerCap = { value: number; source: string; basis?: string };

test('a run started with no budget still caps every session it spawns, each cap with the policy that set it (SES-8)', async () => {
  // 0 of 507 lifetime argvs carried a dollar cap: both conditions read values
  // that defaulted to null and only the launch form ever set them.
  const r = repo();
  r.setSize(1, 'L');
  const requests: SpawnRequest[] = [];
  const work = workingSession(r);
  const spawn: SpawnFn = async (request) => { requests.push(request); return work(request); };
  const { instance, events } = runner(r, spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    assert.equal(requests.length, 3, 'three phases, three sessions');
    for (const request of requests) {
      assert.ok((request.maxTurns ?? 0) > 0 && (request.budgetUsd ?? 0) > 0, 'both caps reach every spawn');
    }
    const sessions = journalled(events, 'phase.session');
    assert.equal(sessions.length, requests.length, 'one record per session, from the one door');
    for (const session of sessions) {
      for (const cap of [session.maxTurns, session.maxBudgetUsd] as LedgerCap[]) {
        assert.ok((CAP_SOURCES as readonly string[]).includes(cap.source), `a named source (${cap.source})`);
        assert.ok(cap.source !== 'caller' && cap.source !== 'spawn-default', 'no runner spawn leaves a cap unattributed');
      }
      assert.equal(session.mode, 'phase');
      assert.equal(session.endedBy, 'exit', 'a session that ended itself says so, rather than leaving a blank');
    }
    assert.deepEqual(sessions[0].maxBudgetUsd, { value: 120, source: 'size', basis: 'L' });
    assert.deepEqual(sessions[0].maxTurns, { value: 600, source: 'size', basis: 'L' });
    assert.deepEqual(sessions[1].maxBudgetUsd, { value: 60, source: 'size', basis: 'M' }, 'an unsized phase is M');
    // …and the CLI-side ceilings each child ran under, once per spawn.
    const ceilings = journalled(events, 'phase.retry-ceiling');
    assert.equal(ceilings.length, requests.length);
    assert.equal(ceilings[0].mode, 'phase');
    assert.ok(ceilings[0].source === 'console' || ceilings[0].source === 'env');
    assert.equal(typeof ceilings[0].bgWaitCeilingMs, 'number');
  } finally { r.cleanup(); }
});

test('a run budget is the dollar cap, and a spent cap resumes under double it — attributed as a raise', async () => {
  const r = repo();
  const requests: SpawnRequest[] = [];
  const capped: SpawnFn = async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      return ok({ signal: { subtype: 'error_max_budget_usd', code: 1, text: '' }, sessionId: 'sess-abc' });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-abc' });
  };
  const { instance, events } = runner(r, capped);
  try {
    await instance.start({ slug: 'demo', root: r.root, phaseBudgetUsd: 2, autonomy: 'keep-going' });
    await instance.wait();
    const sessions = journalled(events, 'phase.session');
    assert.deepEqual(sessions[0].maxBudgetUsd, { value: 2, source: 'run' });
    const raised = sessions[1].maxBudgetUsd as LedgerCap;
    assert.equal(raised.value, 4, 'double the cap the CLI enforced');
    assert.equal(raised.source, 'raise');
    assert.equal(requests[1].budgetUsd, 4, 'and double is what the resume was spawned with');
    const resume = journalled(events, 'phase.resume')[0];
    assert.equal(resume.budget, 4);
    assert.equal(resume.budgetSource, 'raise');
  } finally { r.cleanup(); }
});

test('a resume with an instruction is in the census — the same session record as every other session (SES-6)', async () => {
  // 50 of 138 sessions wrote `phase.resume-done {costUsd, turns, said}` and
  // nothing else: no subtype, no argv, no duration.
  const r = repo();
  let calls = 0;
  const spawn: SpawnFn = async () => {
    calls += 1;
    if (calls === 1) return ok({ sessionId: 'sess-login', signal: { subtype: 'success', code: 0, text: 'Please run /login' } });
    r.markDone(1);
    return ok({ sessionId: 'sess-login', durationMs: 42, argv: ['--print', '--resume', 'sess-login'] });
  };
  const { instance, events } = runner(r, spawn);
  try {
    const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    assert.ok(['halted', 'parked'].includes(instance.current()!.status), 'the first session stopped the run for recovery');
    await instance.recover({
      slug: 'demo', root: r.root, runId: started.id, phase: 1, mode: 'resume', instruction: 'finish it', by: 'operator',
    });
    await instance.wait();
    const resumes = journalled(events, 'phase.session').filter((session) => session.mode === 'resume');
    assert.equal(resumes.length, 1, 'the resume wrote a session record');
    assert.deepEqual(resumes[0].argv, ['--print', '--resume', 'sess-login']);
    assert.equal(resumes[0].ms, 42);
    assert.equal((resumes[0].maxTurns as LedgerCap).source, 'closeout');
    assert.equal(journalled(events, 'phase.resume-done').length, 1, 'beside the resume\'s own done line, not instead of it');
  } finally { r.cleanup(); }
});

test('a usage warning past the alert threshold is decided once per window — not only journalled (SES-9)', async () => {
  // 3 150 `run.usage-window` lines, every one `allowed_warning`, up to 0.99,
  // and nothing acted on any of them.
  const r = repo();
  const held = streamingSession(r);
  const { instance, events } = runner(r, held.spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
    await held.inSession;
    const warning: StreamEvent = {
      kind: 'limits', status: 'allowed_warning', window: 'seven_day', utilization: 0.99, utilizationPct: 99, resetsAt: 1789956000,
    };
    held.say(warning);
    held.say(warning);
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'seven_day', utilization: 0.5, utilizationPct: 50, resetsAt: 1789956000 });
    held.release();
    await instance.wait();
    const windows = journalled(events, 'run.usage-window');
    assert.equal(windows[0].utilizationPct, 99, 'the reading rides in both units');
    assert.equal(windows[0].utilization, 0.99);
    const decisions = journalled(events, 'run.usage-decision');
    assert.equal(decisions.length, 1, 'one decision per window and reset, however often the warning repeats');
    // `brake` and `nonRunSessions` since autopilot-token-drain phase 6: no
    // scheduler in this harness, so nothing is braked, and no presence
    // registry, so who else is on the window is `unknown` rather than zero.
    assert.deepEqual(decisions[0], {
      action: 'park', thresholdPct: 95, utilizationPct: 99, window: 'seven_day', resetsAt: 1789956000,
      policy: 'pause', enacted: false, brake: false, nonRunSessions: 'unknown',
    });
    assert.equal(instance.current()!.limits?.utilizationPct, 50, 'the run keeps the latest reading');
  } finally { r.cleanup(); }
});

test('whoever ends a live session names the ending on its handle first, and the session record carries it (SES-1)', async () => {
  const r = repo();
  const endings: string[] = [];
  let entered!: () => void;
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  let first = true;
  const spawn: SpawnFn = async (request) => {
    if (!first) { r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1])); return ok(); }
    first = false;
    let ended: SpawnOutcome['endedBy'];
    request.onHandle?.({
      pid: undefined, send: () => false, open: () => true, setFrozen: () => {},
      markEnding: (endedBy) => { endings.push(endedBy); ended ??= endedBy; },
    });
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
    return ok({ endedBy: ended, turns: 2, costUsd: 0 });
  };
  const { instance, events } = runner(r, spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await inSession;
    assert.deepEqual(instance.stopPhase(1, 'tester'), { ok: true });
    release();
    await instance.wait();
    assert.deepEqual(endings, ['stop'], 'the stop named itself on the session before anything signalled it');
    assert.equal(journalled(events, 'phase.session')[0].endedBy, 'stop');
  } finally { r.cleanup(); }
});

test('a denial the CLI recorded and the refusal the session read are two distinct journal lines', async () => {
  const r = repo();
  const held = streamingSession(r);
  const { instance, events } = runner(r, held.spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await held.inSession;
    held.say({
      kind: 'permission-denied', tool: 'Bash', toolUseId: 'toolu_deny', target: 'touch spike-s2-marker.txt',
      reason: 'spike listener: deny', reasonType: 'hook', source: 'stream',
    });
    held.say({ kind: 'tool-result', id: 'toolu_deny', ok: false, detail: 'spike listener: deny', refused: true, tool: 'Bash' });
    // An interrupted call's failure is not a refusal, and journals neither line.
    held.say({ kind: 'tool-result', id: 'toolu_stop', ok: false, detail: 'The user doesn\'t want to proceed with this tool use.' });
    held.release();
    await instance.wait();
    assert.deepEqual(journalled(events, 'phase.permission-denied'), [{
      tool: 'Bash', source: 'stream', toolUseId: 'toolu_deny', target: 'touch spike-s2-marker.txt',
      reason: 'spike listener: deny', reasonType: 'hook',
    }]);
    assert.deepEqual(journalled(events, 'phase.tool-refused'), [{ tool: 'Bash', toolUseId: 'toolu_deny', detail: 'spike listener: deny' }]);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 5: the wait budget told, re-read at resume,
 * and the resume that checks presence
 * ------------------------------------------------------------------ */

const P5_HOUR = 60 * 60_000;

/** A stored run whose phase 1 is parked on a wait whose clock has passed. */
function expiredWait(r: Repo, record: Partial<PhaseRecord>): RunState {
  const stale = newRun({ slug: 'demo', root: r.root });
  stale.status = 'paused';
  stale.stoppedBy = 'system';
  stale.onlyPhases = [1];
  stale.phases['1'] = {
    phase: 1, status: 'waiting', attempts: 1, costUsd: 0, waits: 1,
    parkedUntil: new Date(Date.now() - 60_000).toISOString(),
    parkReason: 'the image build',
    declared: { status: 'waiting-external', reason: 'the image build', at: new Date(Date.now() - 2 * P5_HOUR).toISOString() },
    ...record,
  } as PhaseRecord;
  saveRun(stale);
  return stale;
}

test('SLF-10: a wait never resumes onto a session already marked gone — no --resume, and phase.resume-lost once', async () => {
  const r = repo();
  try {
    const gone = { sessionId: 'sess-gone', at: new Date(Date.now() - P5_HOUR).toISOString(), reason: 'No conversation found' };
    // Both shapes the old code re-armed: the id named at park, and none named (the `??=`).
    for (const named of [true, false]) {
      const stale = expiredWait(r, { sessionId: 'sess-gone', sessionGone: gone, ...(named ? { resumeSessionId: 'sess-gone' } : {}) });
      const spawns: (string | undefined)[] = [];
      const spawn: SpawnFn = async (request) => {
        spawns.push(request.resume);
        r.markDone(1);
        return ok({ sessionId: 'sess-new' });
      };
      const { instance, events } = runner(r, spawn);
      await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
      await instance.wait();
      assert.equal(spawns[0], undefined, `${named ? 'named' : 'unnamed'}: boarded without the gone id`);
      assert.equal(spawns.length, 1, `${named ? 'named' : 'unnamed'}: one fresh boarding`);
      assert.equal(instance.current()!.phases['1'].status, 'done');
      assert.equal(journalled(events, 'phase.resume-lost').length, 1, 'the lost resume is journalled where it is met, once');
      writeFileSync(join(r.state, 'done'), '');
    }
  } finally { r.cleanup(); }
});

test('REG-1: a resume onto a session still RUNNING is refused and recorded — nothing spawns, the wait and its session are kept', async () => {
  const r = repo();
  try {
    const stale = expiredWait(r, { sessionId: 'sess-live', resumeSessionId: 'sess-live' });
    let spawned = 0;
    const spawn: SpawnFn = async () => { spawned += 1; r.markDone(1); return ok(); };
    const { instance, events } = runner(r, spawn, '`true`', undefined, {
      sessionPresence: (id: string) => ({ presence: id === 'sess-live' ? 'live' as const : 'unknown' as const, pid: 4242 }),
    });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    assert.equal(spawned, 0, 'a second claude on a running session transcript is the one act nothing undoes');
    const refused = journalled(events, 'phase.resume-refused');
    assert.equal(refused.length, 1, 'recorded once');
    assert.equal(refused[0].sessionId, 'sess-live');
    assert.equal(refused[0].pid, 4242);
    assert.equal(refused[0].why, 'session-live');
    const rec = instance.current()!.phases['1'];
    assert.equal(rec.status, 'waiting', 'still waiting — a refusal, not a halt');
    assert.equal(rec.resumeSessionId, 'sess-live', 'the session to resume is kept for when it ends');
    assert.ok(rec.declared, 'and the declaration it answers');
    assert.equal(rec.resumeRefused?.sessionId, 'sess-live');
    assert.ok(rec.parkedUntil && Date.parse(rec.parkedUntil) > Date.now(), 'on a short re-check clock');
    assert.equal(rec.halt, undefined);
    assert.equal(instance.current()!.status, 'waiting');
  } finally { r.cleanup(); }
});

test('SLF-5: a park with no declaration is not a declared wait — its own session resumes on the engine prompt, and nothing says the window elapsed', async () => {
  const r = repo();
  try {
    // A declaration some licence already spent, or a console park that never had one.
    const stale = expiredWait(r, { sessionId: 'sess-w', resumeSessionId: 'sess-w', declared: undefined });
    const seen: { prompt: string; resume?: string }[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push({ prompt: request.prompt, resume: request.resume });
      r.markDone(1);
      return ok({ sessionId: 'sess-w' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    assert.equal(seen[0].resume, 'sess-w', 'still its own session');
    assert.match(seen[0].prompt, /BOOT phase 1/, 'the engine prompt, not a wait-resume');
    assert.doesNotMatch(seen[0].prompt, /wait window you declared/);
    const start = journalled(events, 'phase.start')[0];
    assert.equal(start.waitResume, undefined, 'a boarding on a consumed declaration never says resuming');
    assert.equal(journalled(events, 'phase.wait-resume')[0].cause, 'console-park');
  } finally { r.cleanup(); }
});

test('WAI-4: a resumed wait that only LOOKS keeps its declaration — a commit or an outcome spends it, a git status does not', async () => {
  for (const [summary, spends] of [['git status', false], ['git commit -m "wip: the build landed"', true]] as const) {
    const r = repo();
    try {
      const stale = expiredWait(r, { sessionId: 'sess-w', resumeSessionId: 'sess-w' });
      let calls = 0;
      const spawn: SpawnFn = async (request) => {
        calls += 1;
        if (calls === 1) {
          request.onEvent?.({ kind: 'init', sessionId: 'sess-w', model: 'stub-1', tools: 0 });
          request.onEvent?.({ kind: 'tool', id: 'toolu_look', name: 'Bash', summary });
        }
        r.markDone(1);
        return ok({ sessionId: 'sess-w' });
      };
      const { instance, events } = runner(r, spawn);
      await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
      await instance.wait();
      const productive = journalled(events, 'phase.declaration-consumed').filter((d) => d.why === 'session-productive');
      assert.equal(productive.length, spends ? 1 : 0, `${summary}: ${spends ? 'spends' : 'keeps'} the declaration`);
    } finally { r.cleanup(); }
  }
});

test('WAI-9: a new declaration spends the old one once — new-outcome journals exactly one line, naming what came next', async () => {
  const r = repo();
  try {
    // A phase parked on a declared wait, resumed; the session now declares a
    // different word. The old testimony is spent under `new-outcome`, once.
    const stale = expiredWait(r, { sessionId: 'sess-w', resumeSessionId: 'sess-w' });
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, { phase: 1, status: 'needs-human', needs: 'credential', reason: 'the deploy token expired' });
      return ok({ sessionId: 'sess-w' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    const spent = journalled(events, 'phase.declaration-consumed');
    assert.equal(spent.length, 1, `exactly one spend (${spent.map((d) => d.why).join(', ')})`);
    assert.equal(spent[0].why, 'new-outcome');
    assert.equal(spent[0].next, 'needs-human');
    assert.equal(spent[0].status, 'waiting-external');
    assert.equal(typeof spent[0].parkedMs, 'number');
    assert.equal(instance.current()!.phases['1'].declared?.status, 'needs-human', 'the new word stands');
  } finally { r.cleanup(); }
});

/**
 * console-open-findings O3 — a wait-resume whose session is GONE must board with
 * the resume brief, like every other fresh boarding.
 *
 * The gate has two ways to refuse a resume that nothing is wrong with: `fresh`
 * (the policy would rather start over) and `gone`/`unported` (the CLI no longer
 * holds that conversation here). Only the first built a
 * `reboard-resume-brief` hint. The second fell through with `boarding`
 * undefined, so the session was boarded on the bare `waitResumePrompt` — the
 * wait's own words, with no engine boot text and no account of what it was
 * inheriting. That session wakes up mid-phase with a park notice and no idea
 * there is uncommitted work in the tree, which is exactly what the resume brief
 * exists to prevent.
 */
test('O3: a wait-resume onto a GONE session boards fresh WITH the resume brief, not the bare wait prompt', async () => {
  const r = repo();
  try {
    const gone = { sessionId: 'sess-gone', at: new Date(Date.now() - P5_HOUR).toISOString(), reason: 'No conversation found' };
    const stale = expiredWait(r, { sessionId: 'sess-gone', resumeSessionId: 'sess-gone', sessionGone: gone });
    const prompts: string[] = [];
    const resumes: (string | undefined)[] = [];
    const spawn: SpawnFn = async (request) => {
      prompts.push(request.prompt);
      resumes.push(request.resume);
      r.markDone(1);
      return ok({ sessionId: 'sess-new' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();

    const briefs = journalled(events, 'phase.brief');
    assert.equal(briefs.length, 1, 'the boarding composed a brief');
    assert.equal(briefs[0].rung, 'reboard-resume-brief', 'the same rung the policy-refused path builds');
    assert.equal(briefs[0].brief, 'resume');
    assert.deepEqual(resumes, [undefined], 'and it is a FRESH session — never --resume onto a gone one');
    // the wait's own words still ride under the brief: the park is why it woke
    assert.match(prompts[0], /the image build/, 'the wait-resume text is carried, not discarded');
  } finally { r.cleanup(); }
});

test('WAI-9: a declaration a resumed session left standing is spent under board-closed when the board reads done — not left on a done record', async () => {
  const r = repo();
  try {
    const stale = expiredWait(r, { sessionId: 'sess-w', resumeSessionId: 'sess-w' });
    const spawn: SpawnFn = async () => { r.markDone(1); return ok({ sessionId: 'sess-w' }); };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    const spent = journalled(events, 'phase.declaration-consumed');
    assert.deepEqual(spent.map((d) => d.why), ['board-closed']);
    assert.equal(instance.current()!.phases['1'].status, 'done');
    assert.equal(instance.current()!.phases['1'].declared, undefined, 'no testimony outlives the record it was about');
  } finally { r.cleanup(); }
});

test('WAI-1/WAI-11: a declared park says what it granted against what it asked, and names a ref nothing can poll', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'the image build',
        resume_after: new Date(Date.now() + 45 * 60_000).toISOString(),
        watch: ['gh:acme/app#run/1234', 'config/fleet-pin.yaml:app-prod'],
      });
      return ok({ resultText: 'holding pattern' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();
    const waiting = journalled(events, 'phase.waiting')[0];
    assert.ok(waiting.requested, 'no phase.waiting payload lacks `requested`');
    assert.equal(waiting.requestedSource, 'declared');
    assert.equal(waiting.capped, false);
    assert.equal(waiting.by, 'session');
    assert.equal(waiting.budgetMs, 8 * P5_HOUR);
    assert.equal(waiting.budgetSource, 'default');
    assert.ok(Math.abs(Number(waiting.granted) - 45 * 60_000) < 5_000);
    assert.deepEqual(waiting.unpollable, ['config/fleet-pin.yaml:app-prod']);
    const unpollable = journalled(events, 'phase.watch-unpollable');
    assert.equal(unpollable.length, 1);
    assert.equal(unpollable[0].ref, 'config/fleet-pin.yaml:app-prod');
    const rec = instance.current()!.phases['1'];
    assert.deepEqual(rec.watchUnpollable?.map((u) => u.ref), ['config/fleet-pin.yaml:app-prod']);
    assert.equal(rec.declared?.by, 'session');
    assert.ok(rec.parkedFrom, 'the park began on its own field');
    assert.equal(rec.waitHistory?.length, 1);
  } finally { r.cleanup(); }
});

test('WAI-1: a declared window past the budget halts at park with the arithmetic — never parked for a cut-down eight hours', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, {
        phase: 1, status: 'waiting-external', reason: 'a 48 h soak',
        resume_after: new Date(Date.now() + 48 * P5_HOUR).toISOString(),
      });
      return ok();
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();
    const rec = instance.current()!.phases['1'];
    assert.notEqual(rec.status, 'waiting');
    assert.equal(rec.halt?.kind, 'waiting-external-timeout');
    assert.match(rec.halt?.reason ?? '', /asked to wait until .* \(48 h from now\)/);
    assert.match(rec.halt?.reason ?? '', /does not cut a declared window short/);
    assert.equal(journalled(events, 'phase.waiting').length, 0);
  } finally { r.cleanup(); }
});

test('WAI-4: phase.wait-resume carries the lateness, the cause and the turn cap\'s source', async () => {
  const r = repo();
  try {
    const stale = expiredWait(r, {
      sessionId: 'sess-w', resumeSessionId: 'sess-w',
      parkedUntil: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const spawn: SpawnFn = async (request) => { r.markDone(1); void request; return ok({ sessionId: 'sess-w' }); };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    const resumed = journalled(events, 'phase.wait-resume')[0];
    assert.equal(resumed.cause, 'declared-window');
    assert.ok(Number(resumed.lateMs) >= 20 * 60_000 - 5_000, `lateMs ${resumed.lateMs}`);
    assert.equal(resumed.capSource, 'closeout');
    assert.equal(resumed.budgetSource, 'default');
    assert.ok(resumed.declaredBy, 'whose declaration this resume answers');
  } finally { r.cleanup(); }
});

test('WAI-5/SLF-9: the watchdog parks in its OWN name — by watchdog, its own ledger, the lifted cmd: ref marked minted', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    s.say({ kind: 'tool', id: 'toolu_local', name: 'Bash', summary: 'until [ -f /tmp/suite.done ]; do sleep 30; done' });
    clock.wind(6 * 60_000);
    await instance.tickLiveness();
    clock.wind(45 * 60_000);
    await instance.tickLiveness();
    const parked = instance.current()!.phases['1'];
    assert.equal(parked.status, 'waiting');
    assert.equal(parked.declared?.by, 'watchdog', 'the console\'s inference, never the session\'s testimony');
    assert.deepEqual(parked.declared?.minted, ['cmd:"test -f /tmp/suite.done"']);
    assert.equal(parked.watchdogParks, 1);
    assert.equal(parked.waits ?? 0, 0, 'the session\'s declared waits are untouched');
    const waiting = journalled(events, 'phase.waiting')[0];
    assert.equal(waiting.by, 'watchdog');
    assert.equal(waiting.watchdogParks, 1);
    assert.equal(journalled(events, 'phase.external-wait')[0].source, 'open');
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('SLF-9: with stallAutomaticPark off, the watchdog parks nothing — the stall is still named', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now, stallAutomaticPark: () => false });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    s.say({ kind: 'tool', id: 'toolu_wait', name: 'Bash', summary: 'until [ "$(gh run view 42 -q .status)" = completed ]; do sleep 45; done' });
    clock.wind(6 * 60_000);
    await instance.tickLiveness();
    const rec = instance.current()!.phases['1'];
    assert.equal(rec.stall?.signal, 'external-wait', 'the card still stands');
    assert.equal(rec.status, 'running', 'and the lane is not taken away');
    assert.equal(journalled(events, 'phase.waiting').length, 0);
    assert.equal(journalled(events, 'phase.external-wait').length, 0);
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('RCV-5 (firing half): a wait the console REFUSED inside the turn reaches the local-job ladder — nudged, then parked with a minted cmd: ref', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    // No call opens: the guard refused it. The only evidence is the refusal.
    instance.noteWaitDenied(1, { command: 'until [ -f /tmp/ring.done ]; do sleep 30; done', matched: 'until [^`]+; *do' });
    clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
    await instance.tickLiveness();
    const nudged = instance.current()!.phases['1'];
    assert.equal(nudged.stall?.signal, 'external-wait');
    assert.equal(nudged.stall?.source, 'denied');
    assert.equal(nudged.stall?.scope, 'local');
    assert.equal(s.sent.length, 1, 'rung 1: the nudge');
    // Land between stallLocalJobMs (45) and the denied signal's own lifetime,
    // stallLocalJobMs + stallExternalWaitMs (50) — 11 + 35 = 46. The old 40 was
    // measured from a 6-minute first tick and now overshoots the window.
    clock.wind(35 * 60_000);
    await instance.tickLiveness();
    const parked = instance.current()!.phases['1'];
    assert.equal(parked.status, 'waiting', 'rung 2: parked within stallLocalJobMs of the refusal');
    assert.equal(parked.watch?.[0], 'cmd:"test -f /tmp/ring.done"', 'with the landing condition the console minted');
    assert.deepEqual(parked.declared?.minted, ['cmd:"test -f /tmp/ring.done"']);
    assert.equal(journalled(events, 'phase.external-wait')[0].source, 'denied');
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('RCV-5 (phase 9): a refused `--watch` reaches the same local-job ladder — nudged, then parked with the one-shot form as the minted cmd: ref', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance, events } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    // The commonest refusal in the corpus, `--watch` ×16 of 37 — and the one
    // that used to read as somebody else's clock and park on the raw command.
    instance.noteWaitDenied(1, { command: 'node --test --watch viewer/test > /tmp/t.log 2>&1', matched: '--watch' });
    const denied = instance.current()!.phases['1'].toolDenied;
    assert.equal(denied?.rule, 'in-turn-wait', 'the denial is on the RECORD, where a restart cannot lose it');
    assert.equal(denied?.command, 'node --test --watch viewer/test > /tmp/t.log 2>&1');
    clock.wind(11 * 60_000);  // past LOCAL_JOB_GRACE_MS — the window rule 3 grants (O6)
    await instance.tickLiveness();
    const nudged = instance.current()!.phases['1'];
    assert.equal(nudged.stall?.signal, 'external-wait');
    assert.equal(nudged.stall?.source, 'denied');
    assert.equal(nudged.stall?.scope, 'local', 'a --watch runner is the session\'s own job');
    assert.equal(s.sent.length, 1, 'rung 1: the nudge');
    // Land between stallLocalJobMs (45) and the denied signal's own lifetime,
    // stallLocalJobMs + stallExternalWaitMs (50) — 11 + 35 = 46. The old 40 was
    // measured from a 6-minute first tick and now overshoots the window.
    clock.wind(35 * 60_000);
    await instance.tickLiveness();
    const parked = instance.current()!.phases['1'];
    assert.equal(parked.status, 'waiting', 'rung 2: parked within stallLocalJobMs of the refusal');
    assert.deepEqual(parked.watch, ['cmd:"node --test viewer/test"'], 'the one-shot form, redirections dropped');
    assert.deepEqual(parked.declared?.minted, ['cmd:"node --test viewer/test"']);
    assert.equal(parked.declared?.by, 'watchdog');
    const wait = journalled(events, 'phase.external-wait')[0];
    assert.equal(wait.source, 'denied');
    assert.equal(wait.watch, 'cmd:"node --test viewer/test"');
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P1: a lane whose turn ended on its own subagent running in the background is waiting on its own work — the Stop hook can see the agent, and the silent watchdog leaves the lane alone', async () => {
  // Measured under `-p`: an Agent running in the background keeps the process alive and its
  // completion starts a new turn, while a background Bash dies with the turn.
  // A session waiting like that is quiet by construction; nudging or recycling
  // it would throw away the agent it is waiting on.
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    s.say({ kind: 'background', op: 'started', taskId: 'a1', taskType: 'local_agent', tool: 'Agent', description: 'review' });
    s.say({ kind: 'background', op: 'started', taskId: 'b1', taskType: 'local_bash', tool: 'Bash', description: 'npm test' });
    assert.deepEqual(instance.awaitingBackground(1).map((task) => task.id), ['a1'],
      'the agent wakes the session; the shell does not');
    assert.deepEqual(instance.awaitingBackground(2), [], 'a phase with no live lane waits on nothing');

    clock.wind(12 * 60_000);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].stall, undefined, 'twelve quiet minutes on its own agent are not silence');
    assert.deepEqual(s.sent, [], 'and nothing is written into the session');

    s.say({ kind: 'background', op: 'ended', taskId: 'a1', status: 'completed' });
    assert.deepEqual(instance.awaitingBackground(1), [], 'a reported agent is no longer awaited');
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P2: a lane counts its own status checks — the hook asks it, the stream resets it, and it nudges once', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 1 });
    const clock = fakeClock();
    const { instance } = runner(r, s.spawn, '`true`', undefined, { now: clock.now });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;
    const check = () => {
      const verdict = instance.observeToolCall(1, { name: 'ListAgents', input: {} });
      clock.wind(4_000);
      return verdict?.deny;
    };
    const denials = [check(), check(), check(), check(), check()];
    s.say({ kind: 'tool', name: 'Read', id: 'r1', summary: 'notes.md' });
    denials.push(check(), check(), check(), check(), check(), check());
    assert.deepEqual(denials, [false, false, false, false, false, false, false, false, false, false, true],
      'the Read the stream saw reset the count, so the sixth check after it is the first refused');
    assert.equal(instance.observeToolCall(2, { name: 'ListAgents', input: {} }), null, 'a phase with no live lane has no tracker');

    assert.equal(instance.nudgePollLoop(1, 'Stop polling.'), true, 'the first nudge reaches the session');
    assert.equal(instance.nudgePollLoop(1, 'Stop polling.'), false, 'and a lane gets one');
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0], /Stop polling\./);
    assert.equal(instance.nudgePollLoop(2, 'Stop polling.'), false, 'no lane, no nudge');
    s.gates[0].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

/** One API call at `context` tokens, as `spawn.ts` emits it — the session's whole fold riding along. */
const usageAt = (context: number, calls = 1): StreamEvent => ({
  kind: 'usage', id: `msg_${context}`, rebuild: false,
  call: { input: 2, cacheWrite: 1_000, cacheRead: context - 1_002, output: 300, context },
  totals: {
    calls, lastContext: context, peakContext: context,
    input: 2 * calls, cacheWrite: 1_000 * calls, cacheRead: context - 1_002, output: 300 * calls, rebuilds: 0,
  },
});

const journalledFor = (
  events: { event: string; data: Record<string, unknown> }[], name: string, phase: number,
) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name && e.data.phase === phase)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('autopilot-token-drain P3: every session\'s API calls are journalled as phase.tokens and kept on the record per attempt', async () => {
  const r = repo();
  try {
    const tokens = {
      calls: 242, lastContext: 681_000, peakContext: 681_000,
      input: 500, cacheWrite: 1_300_000, cacheRead: 90_000_000, output: 200_000, rebuilds: 2,
    };
    const spawn: SpawnFn = async (request) => {
      const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
      r.markDone(phase);
      // Phase 1's session reported its calls; phase 2's is a fake with none,
      // which is every harness and every session that never started.
      return ok({ sessionId: `sess-p${phase}`, ...(phase === 1 ? { tokens } : {}) });
    };
    const { instance, events } = runner(r, spawn, '`true`', () => ({ model: 'opus' }));
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();

    const lines = journalledFor(events, 'phase.tokens', 1);
    assert.equal(lines.length, 1, 'one line per session that made calls');
    assert.deepEqual(lines[0], {
      mode: 'phase', attempt: 1, sessionId: 'sess-p1', resumed: false, model: 'opus', window: 1_000_000,
      ...tokens, pollCalls: 0, pollDenied: 0, account: 'default',
    });
    assert.deepEqual(journalledFor(events, 'phase.tokens', 2), [], 'a session that reported no calls writes no line');

    const kept = instance.current()!.phases['1'].tokens;
    assert.equal(kept?.length, 1);
    assert.equal(kept![0].attempt, 1);
    assert.equal(kept![0].sessionId, 'sess-p1');
    assert.equal(kept![0].lastContext, 681_000, 'what Phase 4\'s resume gate reads');
    assert.equal(kept![0].rebuilds, 2);
    assert.ok(kept![0].endedAt, 'and when that session ended — the idle clock starts there');
    assert.equal(instance.current()!.phases['2'].tokens, undefined);
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P3: past 0.6 × its window a phase session is told once to wrap up; past 0.8 × it is checkpointed and boards fresh', async () => {
  const r = repo();
  try {
    const s = silentSession(r, { attempts: 2 });
    const requests: SpawnRequest[] = [];
    const spawn: SpawnFn = (request) => { requests.push(request); return s.spawn(request); };
    const { instance, events } = runner(r, spawn, '`true`', () => ({ model: 'opus' }));
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await s.gates[0].entered;

    s.say(usageAt(599_000, 200));
    assert.deepEqual(s.sent, [], 'under 0.6 × a 1M window nothing is said');
    assert.equal(instance.liveness().find((lane) => lane.phase === 1)?.tokens?.window, 1_000_000,
      'the lane shows the window it is judged against');

    s.say(usageAt(612_000, 201));
    assert.equal(s.sent.length, 1, 'the wrap-up steer goes out');
    assert.match(s.sent[0], /partial --reason context/);
    assert.match(s.sent[0], /in-progress/);
    const wrapups = () => journalledFor(events, 'phase.context-wrapup', 1);
    assert.deepEqual(wrapups().map((line) => ({ stage: line.stage, context: line.context, window: line.window, delivered: line.delivered })),
      [{ stage: 'wrap-up', context: 612_000, window: 1_000_000, delivered: true }]);
    assert.equal(instance.current()!.phases['1'].contextWrapup?.sessionId, 'sess-silent');

    s.say(usageAt(700_000, 230));
    assert.equal(s.sent.length, 1, 'once per session — a wrap-up it has not finished yet is not a reason to say it again');

    s.say(usageAt(812_000, 260));
    assert.deepEqual(wrapups().map((line) => line.stage), ['wrap-up', 'checkpoint']);
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'pending', 'the lane is checkpointed, not failed');
    assert.equal(record.resumeSessionId, undefined, 'and the 812k session is NOT what the next attempt resumes');
    assert.equal(record.boardingHint?.brief, 'resume', 'it boards fresh with the resume brief');
    assert.deepEqual(
      { sessionId: record.contextCheckpoint?.sessionId, context: record.contextCheckpoint?.context, window: record.contextCheckpoint?.window },
      { sessionId: 'sess-silent', context: 812_000, window: 1_000_000 },
    );
    assert.equal(journalledFor(events, 'phase.checkpointed', 1).length, 1);

    s.say(usageAt(830_000, 261));
    assert.equal(wrapups().length, 2, 'a session already checkpointed is not checkpointed again');

    s.gates[0].release();
    await s.gates[1].entered;
    assert.equal(requests.length, 2, 'the phase was re-boarded');
    assert.equal(requests[1].resume, undefined, 'fresh — no --resume');
    assert.match(requests[1].prompt, /checkpointed this phase's previous session at 812k tokens of context/,
      'and the brief says why it is starting over');
    s.gates[1].release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P3: only the phase\'s own sessions are wrapped up — a closeout at 900k is left to finish', async () => {
  // The closeout shape the no-handoff tests use: the first session ends with
  // work in the tree and no paperwork, and the one continuation resumes it.
  const r = repo();
  try {
    execFileSync('git', ['init', '-q'], { cwd: r.root });
    writeFileSync(join(r.root, 'half-finished.txt'), 'work in flight\n');
    const sent: string[] = [];
    let calls = 0;
    let closeoutResume: string | undefined;
    const seen: { phase?: Record<string, unknown>; closeout?: Record<string, unknown> } = {};
    const live = () => ({ ...instance.liveness().find((lane) => lane.phase === 1)?.tokens });
    const spawn: SpawnFn = async (request) => {
      calls++;
      request.onHandle?.({ pid: undefined, open: () => true, send: (text) => { sent.push(text); return true; }, setFrozen: () => {} });
      request.onEvent?.({ kind: 'init', sessionId: 'sess-0001', model: 'claude-opus-5[1m]', tools: 0 });
      if (calls === 1) {
        request.onEvent?.(usageAt(400_000, 150));
        seen.phase = live();
        return ok({ resultText: 'ended without paperwork' });
      }
      closeoutResume = request.resume;
      // A resumed 900k session: past both thresholds from its first call.
      request.onEvent?.(usageAt(900_000, 151));
      seen.closeout = live();
      return ok({ sessionId: 'sess-0001' });
    };
    const { instance, events } = runner(r, spawn, '`true`', () => ({ model: 'opus' }));
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();

    assert.equal(calls, 2, 'the closeout ran');
    assert.equal(closeoutResume, 'sess-0001');
    assert.deepEqual(journalledFor(events, 'phase.session', 1).map((line) => line.mode), ['phase', 'closeout']);
    assert.deepEqual(sent, [], 'no wrap-up steer into a closeout');
    assert.deepEqual(journalledFor(events, 'phase.context-wrapup', 1), [], 'and no checkpoint of it');
    assert.deepEqual(journalledFor(events, 'phase.checkpointed', 1), []);

    // The lane shows each session's own numbers — and judges only the phase's.
    assert.deepEqual({ context: seen.phase?.context, window: seen.phase?.window, stage: seen.phase?.stage },
      { context: 400_000, window: 1_000_000, stage: undefined });
    assert.deepEqual({ context: seen.closeout?.context, window: seen.closeout?.window, stage: seen.closeout?.stage },
      { context: 900_000, window: undefined, stage: undefined },
      'a closeout borrows neither the phase session\'s window nor a stage it is exempt from');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * autopilot-token-drain phase 4: the resume policy — fresh when large and cold
 * ------------------------------------------------------------------ */

/** A session's counters as `record.tokens` keeps them, ended `endedAgoMs` ago. */
const tokenRow = (sessionId: string, lastContext: number, endedAgoMs: number, account = 'default') => ({
  mode: 'phase', attempt: 1, sessionId, resumed: false, model: 'claude-opus-5[1m]', window: 1_000_000,
  calls: 300, lastContext, peakContext: lastContext, input: 600, cacheWrite: 900_000, cacheRead: 90_000_000,
  output: 120_000, rebuilds: 0, account, endedAt: new Date(Date.now() - endedAgoMs).toISOString(),
});

test('autopilot-token-drain P4: a waiting-external resume at 600k after 70 min boards FRESH with the resume brief — the wait and the last words ride it', async () => {
  const r = repo();
  try {
    const stale = expiredWait(r, {
      sessionId: 'sess-wait', resumeSessionId: 'sess-wait', watch: ['gh:acme/app#run/42'],
      said: 'Parked on the image build — declared waiting-external.',
      tokens: [tokenRow('sess-wait', 600_000, 70 * 60_000)],
    });
    const seen: { prompt: string; resume?: string }[] = [];
    const spawn: SpawnFn = async (request) => {
      seen.push({ prompt: request.prompt, resume: request.resume });
      r.markDone(1);
      return ok({ sessionId: 'sess-fresh' });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].resume, undefined, 'no --resume of the 600k session');
    assert.match(seen[0].prompt, /BOOT phase 1 of demo/, 'the engine boot prompt — a fresh session knows nothing else');
    assert.match(seen[0].prompt, /600k tokens of context/, 'the brief says why the session is not resumed');
    assert.match(seen[0].prompt, /You were watching: gh:acme\/app#run\/42/, 'the refs it waited on');
    assert.match(seen[0].prompt, /the image build/, 'and what it waited on');
    assert.match(seen[0].prompt, /Parked on the image build — declared waiting-external\./, 'and the session\'s last words');
    const policy = journalled(events, 'phase.resume-policy');
    assert.deepEqual(policy.map((line) => [line.sessionId, line.choice, line.reason, line.contextTokens, line.accountChanged]),
      [['sess-wait', 'fresh', 'cache-cold', 600_000, false]]);
    assert.ok(Number(policy[0].idleMs) >= 70 * 60_000, 'idle from when that session ended');
    assert.equal(journalled(events, 'phase.start')[0].waitResume, true, 'it is still the wait being answered');
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'done');
    assert.equal(record.sessionGone, undefined, 'a session not worth resuming is not a gone one');
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P4: a switch to another account at 824k does not carry the conversation — the phase re-boards fresh with the resume brief', async () => {
  const r = repo();
  const spawns: { env?: NodeJS.ProcessEnv; resume?: string; prompt: string }[] = [];
  const limited: SpawnFn = async (request) => {
    spawns.push({ env: request.env, resume: request.resume, prompt: request.prompt });
    if (spawns.length === 1) {
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      return ok({
        signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${epoch}` },
        sessionId: 'sess-p3',
        tokens: {
          calls: 434, lastContext: 824_343, peakContext: 835_000, input: 900, cacheWrite: 900_000,
          cacheRead: 300_000_000, output: 90_000, rebuilds: 1,
        },
      });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok({ sessionId: 'sess-fresh' });
  };
  const { instance, events } = runner(r, limited, '`true`', () => ({ model: 'opus' }), {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    pickAccount: () => 'spare',
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', onlyPhases: [1] });
    const outcome = await Promise.race([
      instance.wait().then(() => 'finished'),
      new Promise<string>((resolve) => setTimeout(resolve, 8_000, 'slept')),
    ]);
    if (outcome === 'slept') await instance.stop();
    assert.equal(outcome, 'finished');
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].resume, undefined, 'the 824k conversation is not resumed under the new account');
    assert.equal(spawns[1].env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-spare', 'the fresh boot runs as the account that can pay');
    assert.match(spawns[1].prompt, /BOOT phase 1/);
    assert.match(spawns[1].prompt, /another account/, 'and its brief says why it starts over');
    assert.deepEqual(journalled(events, 'phase.resume-policy').map((line) => [line.choice, line.reason, line.contextTokens, line.accountChanged]),
      [['fresh', 'account-changed', 824_343, true]]);
    assert.equal(journalled(events, 'phase.reboard-requested').at(-1)?.brief, 'resume');
    const record = instance.current()!.phases['1'];
    assert.equal(record.tokens?.[0].account, 'default', 'the counters name the account that wrote the cache');
    assert.equal(record.status, 'done');
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P4: a session that declared `partial --reason budget` or `context` is not resumed, even small and warm — the phase boards fresh with the resume brief', async () => {
  for (const reason of ['budget', 'context']) {
    const r = repo();
    try {
      const log: { resume?: string; prompt: string }[] = [];
      const spawn: SpawnFn = async (request) => {
        log.push({ resume: request.resume, prompt: request.prompt });
        if (log.length === 1) {
          fileOutcome(request, { phase: 1, status: 'partial', reason });
          return ok({
            sessionId: 'sess-p', resultText: 'handing off in-progress',
            tokens: { calls: 40, lastContext: 120_000, peakContext: 120_000, input: 80, cacheWrite: 120_000, cacheRead: 2_000_000, output: 9_000, rebuilds: 0 },
          });
        }
        r.markDone(1);
        return ok({ sessionId: 'sess-q' });
      };
      const { instance, events } = runner(r, spawn);
      await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autoRecover: true });
      await instance.wait();

      assert.equal(log.length, 2, reason);
      assert.equal(log[1].resume, undefined, `${reason}: the session said itself that it is spent`);
      assert.match(log[1].prompt, /BOOT phase 1/, reason);
      assert.match(log[1].prompt, new RegExp(`partial --reason ${reason}\``), `${reason}: the brief names the declaration`);
      assert.deepEqual(journalled(events, 'phase.resume-policy').map((line) => [line.choice, line.reason]),
        [['fresh', `partial-${reason}`]]);
      assert.equal(journalled(events, 'phase.brief-degraded')[0]?.asked, 'continue',
        `${reason}: the ladder asked for the session, the gate answered fresh`);
      assert.deepEqual(instance.current()!.phases['1'].lastPartial?.reason, reason);
      assert.equal(instance.current()!.phases['1'].status, 'done');
    } finally { r.cleanup(); }
  }
});

test('autopilot-token-drain P4: an owed QA verdict on a session not worth resuming is reviewed by a FRESH session, from the boot prompt', async () => {
  const r = repo();
  r.setQaOwed('pending');
  const spawns: { name?: string; resume?: string; prompt: string }[] = [];
  const spawn: SpawnFn = async (request) => {
    spawns.push({ name: request.name, resume: request.resume, prompt: request.prompt });
    const boot = /BOOT phase (\d+)/.exec(request.prompt);
    if (boot && !/qa-verdict$/.test(request.name ?? '')) { r.markDone(Number(boot[1])); return ok({ sessionId: `sess-p${boot[1]}` }); }
    return ok();
  };
  const { instance, events } = runner(r, spawn, '`true`');
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    // The phase's session ended two hours ago at 700k: its cache is long gone.
    instance.current()!.phases['1'].tokens = [tokenRow('sess-p1', 700_000, 2 * 60 * 60_000)];
    const before = spawns.length;
    await (instance as unknown as { maybeQaVerdict(phase: number): Promise<void> }).maybeQaVerdict(1);
    assert.equal(spawns.length, before + 1, 'the review is not skipped');
    const review = spawns.at(-1)!;
    assert.match(review.name ?? '', /qa-verdict$/);
    assert.equal(review.resume, undefined, 'and it does not rewrite 700k into the cache to write one verdict');
    assert.match(review.prompt, /BOOT phase 1/, 'a fresh reviewer boards from the boot prompt');
    assert.equal(journalled(events, 'phase.qa-session').at(-1)?.fresh, true);
    const decided = journalled(events, 'phase.resume-policy').at(-1);
    assert.deepEqual([decided?.sessionId, decided?.choice, decided?.reason], ['sess-p1', 'fresh', 'cache-cold'],
      'the run\'s own verdict chases resumed their unmeasured sessions; this one was judged cold');
    assert.equal(journalled(events, 'phase.qa-session-skipped').length, 0);
  } finally { r.cleanup(); }
});

test('autopilot-token-drain P4: an instructed resume of a session not worth resuming spawns nothing, marks nothing gone, and says why', async () => {
  const r = repo();
  try {
    const stored = newRun({ slug: 'demo', root: r.root });
    stored.status = 'halted';
    stored.onlyPhases = [1];
    stored.halt = { at: new Date().toISOString(), reason: 'phase 1 verification is red', phase: 1 };
    stored.phases['1'] = {
      phase: 1, status: 'failed', attempts: 1, costUsd: 0, sessionId: 'sess-big',
      tokens: [tokenRow('sess-big', 681_000, 4 * 60 * 60_000)],
    } as PhaseRecord;
    saveRun(stored);
    let spawned = 0;
    const spawn: SpawnFn = async () => { spawned += 1; return ok(); };
    const { instance, events } = runner(r, spawn);
    await instance.recover({
      slug: 'demo', root: r.root, runId: stored.id, phase: 1, mode: 'resume', instruction: 'fix the red suite', by: 'operator',
    });
    await instance.wait();
    assert.equal(spawned, 0, 'no --resume of a 681k session four hours cold');
    const state = instance.current() ?? loadRun(r.root, 'demo', stored.id, null)!;
    assert.equal(state.phases['1'].sessionGone, undefined, 'the session is not gone — resuming it is just not worth it');
    assert.match(state.finishedReason ?? '', /not worth resuming/);
    assert.match(state.finishedReason ?? '', /fresh session/);
    assert.deepEqual(journalled(events, 'phase.resume-policy').map((line) => [line.choice, line.reason]), [['fresh', 'cache-cold']]);
  } finally { r.cleanup(); }
});

test('TRS-3 (phase 9): a waiting-external declared with NO ref after the guard refused the session\'s wait is adopted — the ref minted from the refused command, marked minted', async () => {
  const r = repo();
  try {
    const declaring: SpawnFn = async (request) => {
      // The measured shape: refused `until … sleep` at 16:11, refused `--watch`
      // at 16:21, then `waiting-external` 37 s later with `watch: []`.
      instance.noteWaitDenied(1, { command: 'until [ -f /tmp/ring.done ]; do sleep 30; done', matched: 'until [^`]+; *do' });
      fileOutcome(request, { phase: 1, status: 'waiting-external', reason: 'the ring job is still running', resume_after: new Date(Date.now() + 30 * 60_000).toISOString() });
      return ok({ resultText: 'parked on the ring job' });
    };
    const { instance, events } = runner(r, declaring, '`true`');
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'the wait stands — adopted, not refused');
    assert.deepEqual(record.watch, ['cmd:"test -f /tmp/ring.done"'], 'the console followed its own recipe');
    assert.deepEqual(record.declared?.watch, ['cmd:"test -f /tmp/ring.done"']);
    assert.deepEqual(record.declared?.minted, ['cmd:"test -f /tmp/ring.done"'], 'marked minted — it runs only under watchMintedCmdRefs');
    assert.equal(record.declared?.by, 'session', 'the session\'s own declaration, with the console\'s ref on it');
    const missing = journalled(events, 'phase.watch-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].source, 'declaration');
    assert.equal(missing[0].from, 'denial');
    assert.deepEqual(missing[0].adopted, ['cmd:"test -f /tmp/ring.done"']);
    assert.equal(missing[0].command, 'until [ -f /tmp/ring.done ]; do sleep 30; done');
    assert.deepEqual(journalled(events, 'phase.waiting')[0].watch, ['cmd:"test -f /tmp/ring.done"']);
  } finally { r.cleanup(); }
});

test('TRS-3 (phase 9): a ref-less wait after a refusal the console can neither mint nor read off the plan is REFUSED — parked for a person with the errand naming the command', async () => {
  const r = repo();
  try {
    const declaring: SpawnFn = async (request) => {
      // `tail -f` has no landing the console can name, and the plan has no
      // `Waits on:` line for this phase.
      instance.noteWaitDenied(1, { command: 'tail -f build.log', matched: 'tail -f' });
      fileOutcome(request, { phase: 1, status: 'waiting-external', reason: 'watching the build log' });
      return ok({ resultText: 'watching' });
    };
    const { instance, events } = runner(r, declaring, '`true`');
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'parked', 'a wait nobody can watch is a person\'s');
    assert.equal(instance.current()!.halt?.kind, 'needs-human');
    assert.match(record.note ?? '', /no --watch ref after the console refused `tail -f build\.log`/);
    const missing = journalled(events, 'phase.watch-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].adopted, null);
    const refused = journalled(events, 'phase.declaration-refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].status, 'waiting-external');
    assert.equal(refused[0].why, 'watch-missing');
    const errand = journalled(events, 'phase.errand')[0];
    assert.equal(errand.situation, 'blocked-declared:external');
    assert.match(String(errand.need), /`tail -f build\.log`/);
    assert.match(String(errand.how), /Waits on:/);
    assert.equal(journalled(events, 'phase.waiting').length, 0, 'nothing parked on a blind clock');
  } finally { r.cleanup(); }
});

test('ACC-8.12 (TRS-10, in the loop): a session blocked on the console\'s own deny rule parks behind a standing widen card — no streak, no session — and Allow strikes the rule and resumes its own session', async () => {
  const r = repo();
  try {
    const { Approvals } = await import('../server/runner/approvals.ts');
    const approvals = new Approvals();
    const widened: { slug: string; rule: string; by: string }[] = [];
    const resumed: { slug: string; phase: number; instruction: string; by: string }[] = [];
    const blocked: SpawnFn = async (request) => {
      // The hook refused `git push` under the deny list (stamped on the
      // record), and the session declared exactly what the recipe says.
      instance.noteToolDenied(1, { tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/demo' });
      fileOutcome(request, { phase: 1, status: 'blocked', needs: 'permission', reason: 'blocked — could not proceed' });
      return ok({ sessionId: 'sess-blocked', resultText: 'declared blocked on the push' });
    };
    const { instance, events } = runner(r, blocked, '`true`', undefined, {
      approvals,
      widenRule: (slug: string, rule: string, by: string) => { widened.push({ slug, rule, by }); },
      resumeOwnSession: (slug: string, phase: number, instruction: string, by: string) => { resumed.push({ slug, phase, instruction, by }); },
    });
    // The ladder climbs only on an auto-recovering run; with it off the old
    // shape stands (a `phase-blocked` halt for a person).
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();
    const state = instance.current()!;
    const record = state.phases['1'];
    assert.equal(record.status, 'parked', 'parked behind the card, not failed');
    assert.equal(state.consecutiveFailures, 0, 'a permission wall is not a failed attempt (the deferred-rung regression)');
    assert.equal(record.halt, undefined, 'no phase-blocked halt was written');
    const situation = journalled(events, 'phase.situation')[0];
    assert.equal(situation.situation, 'blocked-declared:permission', 'from the console\'s own denial, not the prose');
    const rung = journalled(events, 'phase.rung')[0];
    assert.equal(rung.rung, 'widen-rule');
    assert.equal(rung.vehicle, 'card');
    const card = approvals.pending().find((a) => a.phase === 1)!;
    assert.ok(card, 'the card is up');
    assert.equal(card.standing, true);
    assert.equal(card.suggestedRule, 'Bash(git push:*)');
    assert.equal(rung.cardId, card.id);
    assert.equal(state.recoveries?.['1']?.rungs?.at(-1)?.cardId, card.id);
    assert.match(record.note ?? '', /widen `Bash\(git push:\*\)`/);
    assert.equal(journalled(events, 'phase.errand').length, 0, 'no errand while the card is up');
    // The run parked around it (nothing else to drive) and its loop ended —
    // the loop-ending disarm leaves a standing card alone.
    assert.equal(approvals.pending().length, 1);

    // A person allows: the rule is struck for this plan, and — the loop having
    // ended — the phase's own session is resumed through the stopped-run door.
    approvals.settle(card.id, 'allow', 'operator');
    await sleep(20);
    assert.deepEqual(widened, [{ slug: 'demo', rule: 'Bash(git push:*)', by: 'operator' }]);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].phase, 1);
    assert.match(resumed[0].instruction, /`Bash\(git push:\*\)` was struck for this plan/);
    assert.match(resumed[0].instruction, /Re-run `git push origin pe\/demo`/);
    const decided = journalled(events, 'phase.widen-decided')[0];
    assert.equal(decided.decision, 'allow');
    assert.equal(decided.by, 'operator');
  } finally { r.cleanup(); }
});

test('ACC-8.12 (TRS-10, in the loop): a denied widen card settles the rung failed and parks the phase with the errand naming the rule and the command', async () => {
  const r = repo();
  try {
    const { Approvals } = await import('../server/runner/approvals.ts');
    const approvals = new Approvals();
    const blocked: SpawnFn = async (request) => {
      instance.noteToolDenied(1, { tool: 'Bash', rule: 'Bash(git push --force-with-lease=*)', command: 'git push --force-with-lease origin pe/demo' });
      fileOutcome(request, { phase: 1, status: 'blocked', needs: 'permission', reason: 'blocked — could not proceed' });
      return ok({ sessionId: 'sess-blocked', resultText: 'declared blocked on the push' });
    };
    const { instance, events } = runner(r, blocked, '`true`', undefined, {
      approvals, widenRule: () => {}, resumeOwnSession: () => {},
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();
    const card = approvals.pending().find((a) => a.phase === 1)!;
    approvals.settle(card.id, 'deny', 'operator', 'do it by hand');
    await sleep(20);
    const state = instance.current()!;
    assert.equal(state.recoveries?.['1']?.rungs?.at(-1)?.outcome, 'failed');
    assert.equal(journalled(events, 'phase.widen-decided')[0].decision, 'deny');
    const errand = journalled(events, 'phase.errand')[0];
    assert.ok(errand, 'the errand stands once the card is denied');
    assert.equal(errand.situation, 'blocked-declared:permission');
    assert.match(String(errand.need), /`Bash\(git push --force-with-lease=\*\)`/);
    assert.match(String(errand.need), /`git push --force-with-lease origin pe\/demo`/);
    assert.equal(state.phases['1'].status, 'parked');
    assert.equal(state.consecutiveFailures, 0);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 8 — accounts: the quota door climbs, every
 * mover marks the account it leaves, the wall escalates, the credential
 * refusal retires, the poller's probe is wired, a token's reach is scoped
 * ------------------------------------------------------------------ */

/** A `HeadroomVerdict` stub keyed by account: `spent` accounts refuse with a reset, the rest pass. */
function headroomStub(spent: Record<string, string | null>) {
  return (accountId: string | undefined, _model?: string) => {
    const id = accountId ?? 'default';
    if (id in spent) {
      const resetsAt = spent[id];
      return {
        ok: false as const, accountId: id, kind: 'spent' as const,
        reason: `${id} has 0% of its 5-hour window left${resetsAt ? ` (resets ${resetsAt})` : ''}.`,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
    return { ok: true as const, accountId: id, fiveHourPct: 10 };
  };
}

test('ACT-2: a start whose account is at 100 % with a second at 10 % starts under the second and journals run.account-switched {at: preflight, reason: quota}', async () => {
  const r = repo();
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const asked: (string | undefined)[] = [];
  const left: { accountId?: string; leaving: LeaveReason }[] = [];
  const resets = new Date(Date.now() + 3_600_000).toISOString();
  const watching: SpawnFn = async (request) => {
    envs.push(request.env);
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  const { instance, events } = runner(r, watching, '`true`', undefined, {
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    accountHeadroom: (accountId, model) => { asked.push(accountId); return headroomStub({ work: resets })(accountId, model); },
    rankAccounts: (excluding) => ['work', 'spare'].filter((id) => id !== excluding),
    leaveAccount: (accountId, leaving) => { left.push({ ...(accountId ? { accountId } : {}), leaving }); return leaveStub(accountId, leaving); },
  });
  const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  assert.equal(started.status, 'running', 'the door climbed instead of throwing');
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'finished');
  assert.equal(state.accountId, 'spare', 'the run now pays as the account with headroom');
  assert.ok(envs.every((env) => env?.CLAUDE_CODE_OAUTH_TOKEN === 'tok-spare'), 'every spawn runs as it');
  assert.deepEqual(asked.slice(0, 2), ['work', 'spare'], 'the run\'s account first, then the candidate — from cache, before any probe');
  const switched = ladderJournal(events, 'run.account-switched');
  assert.equal(switched.length, 1);
  assert.equal(switched[0].at, 'preflight');
  assert.equal(switched[0].reason, 'quota');
  assert.equal(switched[0].from, 'work');
  assert.equal(switched[0].to, 'spare');
  // The wall the run walked away from was written BEFORE the walk.
  assert.equal(left.length, 1);
  assert.equal(left[0].accountId, 'work');
  assert.equal(left[0].leaving.kind, 'usage');
  assert.equal(left[0].leaving.by, 'preflight');
  assert.equal(left[0].leaving.resetsAt?.toISOString(), resets);
  assert.equal(ladderJournal(events, 'run.account-cooling').length, 1, 'and journalled as the account\'s fact');
  assert.equal(ladderJournal(events, 'run.preflight-refused').length, 0);
  assert.equal(state.errand, undefined, 'nobody is asked');
  r.cleanup();
});

test('ACT-2: with no second account the run PARKS carrying run.errand and run.preflight-refused {wall: quota} — and throws nothing', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '`true`', undefined, {
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    accountHeadroom: headroomStub({ work: new Date(Date.now() + 3_600_000).toISOString(), spare: null }),
    rankAccounts: (excluding) => ['spare'].filter((id) => id !== excluding),
  });
  let threw: unknown = null;
  let parked: RunState | null = null;
  try {
    parked = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
  } catch (error) { threw = error; }
  assert.equal(threw, null, 'the quota door is a journalled state, never an exception a log.warn swallows');
  assert.equal(parked!.status, 'parked');
  assert.equal(parked!.halt?.kind, 'run-preflight');
  assert.match(parked!.halt?.reason ?? '', /work has 0% of its 5-hour window left/);
  assert.equal(seen.length, 0, 'nothing spawned behind the refusal');
  assert.equal(parked!.errand?.situation, 'resource-wall:usage');
  assert.match(parked!.errand?.need ?? '', /pay as work/);
  assert.match(parked!.errand?.how ?? '', /Settings ▸ Accounts/);
  assert.deepEqual(parked!.errand?.tried, ['switch-account → spare: spare has 0% of its 5-hour window left.']);
  const refused = ladderJournal(events, 'run.preflight-refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].wall, 'quota');
  assert.equal(ladderJournal(events, 'run.errand').length, 1);
  r.cleanup();
});

test('ACT-1: a stored run with accountId p, resumed with no account named, preflights p — the auth door and the quota door alike', async () => {
  const r = repo();
  const probed: (string | undefined)[] = [];
  const asked: (string | undefined)[] = [];
  const stored = newRun({ slug: 'demo', root: r.root, accountId: 'p' });
  stored.status = 'paused';
  saveRun(stored);
  const { instance } = runner(r, workingSession(r), '`true`', undefined, {
    checkAuth: async (accountId) => { probed.push(accountId); return { loggedIn: true, checkedAt: '' }; },
    accountHeadroom: (accountId) => { asked.push(accountId); return { ok: true as const, accountId: accountId ?? 'default' }; },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await instance.wait();
  assert.deepEqual(probed, ['p'], 'the login probed is the run\'s own account, never the machine login');
  // Asked at the preflight AND at every boarding since phase 9 (the admission
  // door, RCV-1) — always about the run's own account, never the machine login.
  assert.ok(asked.length >= 1, 'the window is measured');
  assert.deepEqual([...new Set(asked)], ['p'], 'and so is the window measured');
  assert.equal(instance.current()!.accountId, 'p');
  r.cleanup();
});

test('ACT-5: a live burst that switches A→B records a wall against A BEFORE the switch, and a second burst on B does not return the run to A', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const cooling = new Set<string>();
  const left: { accountId: string; leaving: LeaveReason }[] = [];
  const order: string[] = [];
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    // The picker refuses an account the helper has marked — the facade's rule,
    // stubbed: `leaveAccount` FIRST, `pickAccount` after.
    pickAccount: (excluding) => {
      order.push('pick');
      return ['default', 'spare'].find((id) => id !== (excluding ?? 'default') && !cooling.has(id)) ?? null;
    },
    leaveAccount: (accountId, leaving) => {
      order.push('leave');
      cooling.add(accountId ?? 'default');
      left.push({ accountId: accountId ?? 'default', leaving });
      return leaveStub(accountId, leaving);
    },
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-ab', model: 'stub-1', tools: 0 });
  // The CLI names the window and its reset; the wall carries both.
  const resets = Math.floor((clock.now().getTime() + 3_600_000) / 1000);
  held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.97, resetsAt: resets });
  for (let i = 1; i <= 3; i++) { held.say(rateLimited(i)); clock.wind(20_000); }

  const state = instance.current()!;
  assert.equal(state.accountId, 'spare', 'moved to B');
  assert.deepEqual(order, ['leave', 'pick'], 'the account is marked BEFORE the picker is asked');
  assert.equal(left[0].accountId, 'default');
  assert.equal(left[0].leaving.kind, 'usage');
  assert.equal(left[0].leaving.by, 'live-wall');
  assert.equal(left[0].leaving.bucket, 'five_hour', 'under the window\'s own name');
  assert.equal(left[0].leaving.resetsAt?.getTime(), resets * 1000, 'with the reset the CLI reported');
  const cooled = ladderJournal(events, 'run.account-cooling');
  assert.equal(cooled.length, 1);
  assert.equal(cooled[0].id, 'default');
  assert.deepEqual(cooled[0].wall, { bucket: 'five_hour', resetsAt: new Date(resets * 1000).toISOString() });

  held.release();
  await instance.wait();
  // A second burst on B, in the next attempt: A is cooling, so nothing to
  // switch to — the picker answers null and the run does NOT ping-pong back.
  assert.equal(cooling.has('default'), true);
  const nextPick = ['default', 'spare'].find((id) => id !== 'spare' && !cooling.has(id)) ?? null;
  assert.equal(nextPick, null, 'B → A is refused: A\'s wall is a fact the picker reads');
  r.cleanup();
});

test('ACT-6: a rate-limit burst on a single-account console produces — inside the bound — a phase.errand, a limits announcement and a parked phase, not a third phase.live-wall {action: none}', async () => {
  const r = repo();
  const held = streamingSession(r, false);
  const clock = fakeClock();
  const escalated: { action: string; until: string | null }[] = [];
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    pickAccount: () => null,   // nowhere to go
    // A wall with NO reset anywhere: the helper cools the account for the
    // fixed cool-down but the CLI reported no window, so the escalation parks.
    leaveAccount: (accountId, leaving) => ({ ...leaveStub(accountId, leaving), until: undefined }),
    onLiveWallEscalated: (_state, _phase, detail) => { escalated.push({ action: detail.action, until: detail.until }); },
  });
  const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-none', model: 'stub-1', tools: 0 });
  // Three bursts, each past the ten-minute action cooldown of the last.
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 1; i <= 3; i++) { held.say(rateLimited(i)); clock.wind(20_000); }
    clock.wind(LIMIT_ACTION_COOLDOWN_MS + 1_000);
  }
  const walls = ladderJournal(events, 'phase.live-wall');
  assert.deepEqual(walls.map((w) => w.action), ['none', 'none', 'park'], 'two nones, then the escalation — never a third none');
  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'parked');
  assert.match(record.note ?? '', /Resource wall/);
  assert.equal(ladderJournal(events, 'phase.errand').length, 1, 'the one ask');
  assert.equal(ladderJournal(events, 'phase.errand')[0].situation, 'resource-wall:usage');
  assert.deepEqual(escalated, [{ action: 'park', until: null }], 'announced under limits, through the service seam');
  // The climb is in the ladder's words, so the card exists for it.
  const situations = ladderJournal(events, 'phase.situation');
  assert.equal(situations.at(-1)?.situation, 'resource-wall:usage');
  assert.equal(situations.at(-1)?.by, 'drive');
  const slot = instance.current()!.recoveries?.['1'];
  assert.deepEqual(slot?.rungs?.map((rung) => rung.rung), ['switch-account']);
  assert.equal(slot?.rungs?.[0].outcome, 'failed');

  held.release();
  await instance.wait();
  const journal = readFileSync(journalFile(r.root, 'demo', started.id), 'utf8');
  assert.equal((journal.match(/"action":"none"/g) ?? []).length, 2);
  r.cleanup();
});

test('ACT-6 + H6: with a reset hours away, the FIRST wall WAITS on the window — the phase parked on the clock, the wait-window rung recorded, the poke armed', async () => {
  // Amended by autopilot-token-drain phase 6: this read `['none', 'none',
  // 'wait']` — two `none` decisions ten minutes apart before the same wait,
  // twenty minutes of retries on a reset four hours off. A reset past
  // `LIMIT_ACTION_COOLDOWN_MS` now waits on the first burst; the escalation it
  // reaches is unchanged, and the no-reset park above keeps its two `none`s.
  const r = repo();
  const held = streamingSession(r, false);
  const clock = fakeClock();
  const escalated: { action: string; until: string | null }[] = [];
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now,
    pickAccount: () => null,
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
    onLiveWallEscalated: (_state, _phase, detail) => { escalated.push({ action: detail.action, until: detail.until }); },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-wait', model: 'stub-1', tools: 0 });
  const resets = Math.floor((clock.now().getTime() + 4 * 3_600_000) / 1000);
  held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.98, resetsAt: resets });
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 1; i <= 3; i++) { held.say(rateLimited(i)); clock.wind(20_000); }
    clock.wind(LIMIT_ACTION_COOLDOWN_MS + 1_000);
  }
  const until = new Date(resets * 1000).toISOString();
  assert.deepEqual(ladderJournal(events, 'phase.live-wall').map((w) => w.action), ['wait']);
  assert.equal(ladderJournal(events, 'phase.live-wall')[0].trigger, 'far-reset');
  const state = instance.current()!;
  const record = state.phases['1'];
  assert.equal(record.status, 'waiting');
  assert.equal(record.parkedUntil, until, 'parked on the window\'s own reset');
  assert.match(record.note ?? '', /window resets/, 'the note the classifier reads as a usage wall');
  assert.equal(state.waitUntil, until, 'the run clock is synced for the boot re-arm');
  const rungs = ladderJournal(events, 'phase.rung');
  assert.equal(rungs.at(-1)?.rung, 'wait-window');
  assert.equal(rungs.at(-1)?.inline, true);
  assert.deepEqual(escalated, [{ action: 'wait', until }]);
  assert.equal(ladderJournal(events, 'phase.errand').length, 0, 'a wait that ends by itself asks nobody');
  held.release();
  await instance.stop();
  r.cleanup();
});

test('ACT-7: a rate_limit_event at WALL_PCT counts as a wall hit whatever its status word — 0.99 allowed_warning ×3 moves the run', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, '`true`', undefined, {
    now: clock.now, pickAccount: () => 'spare',
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
  await held.inSession;
  held.say({ kind: 'init', sessionId: 'sess-99', model: 'stub-1', tools: 0 });
  for (let i = 0; i < 3; i++) {
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.99, utilizationPct: 99 });
    clock.wind(10_000);
  }
  assert.equal(instance.current()!.accountId, 'spare', 'the meter itself says the window is spent; the word `rejected` never arrives');
  const wall = ladderJournal(events, 'phase.live-wall')[0];
  assert.equal(wall.action, 'switch');
  assert.match(String(wall.detail), /allowed_warning at 99 %/, 'the detail names the word AND the number, in percent');
  held.release();
  await instance.wait();
  r.cleanup();
});

test('RCV-1 + SES-2: an org-policy refusal halts the RUN on credential-refused — one session, one run-level halt, the account retired, the errand quoting the sign-off, no second phase.start; a second start on the retired account spawns nothing', async () => {
  const r = repo();
  // Two more phases are READY beside phase 1 — the shape the audit measured:
  // the old phase-level park handed the loop its next candidate into the same
  // wall, ten boardings inside 157 s. `maxParallel: 1` queues them behind the
  // first lane, so a second `phase.start` is exactly what the run-level halt
  // must prevent.
  r.setParallel(true);
  const spawns: SpawnRequest[] = [];
  const left: { accountId?: string; leaving: LeaveReason }[] = [];
  const retiredIds = new Set<string>();
  const signOff = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
  const refusing: SpawnFn = async (request) => {
    spawns.push(request);
    return ok({
      signal: { subtype: 'success', code: 0, text: 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Organization has been disabled"}}' },
      resultText: signOff,
    });
  };
  const { instance, events } = runner(r, refusing, '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CONFIG_DIR: '/tmp/p' }),
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    // The breaker, stubbed: a credential leave retires the id, and the quota
    // door answers `retired` for it from then on (phase 8's contract).
    accountHeadroom: (accountId) => retiredIds.has(accountId ?? 'default')
      ? { ok: false as const, accountId: accountId ?? 'default', kind: 'retired' as const, reason: `${accountId} is retired: its organisation refused the credential` }
      : { ok: true as const, accountId: accountId ?? 'default' },
    leaveAccount: (accountId, leaving) => {
      left.push({ ...(accountId ? { accountId } : {}), leaving });
      if (leaving.kind === 'credential') retiredIds.add(accountId ?? 'default');
      return leaveStub(accountId, leaving);
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'p', maxParallel: 1 });
  await instance.wait();
  const state = instance.current()!;

  // One session, one run-level halt — RUN-level, so the loop boards nothing.
  assert.equal(spawns.length, 1, 'one session, one refusal');
  assert.equal(journalled(events, 'phase.session').length, 1, 'one phase.session');
  assert.equal(journalled(events, 'phase.start').length, 1, 'no second phase.start — the run stopped');
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.kind, 'credential-refused');
  assert.equal(state.halt?.phase, 1);
  assert.match(state.halt?.reason ?? '', /organization policy blocks this credential \(account: p\)/);
  assert.equal(journalled(events, 'run.halt')[0]?.kind, 'credential-refused');
  // The phase carries the cause — what the classifier reads before any prose.
  assert.equal(state.phases['1'].status, 'parked');
  assert.equal(state.phases['1'].cause?.kind, 'credential-refused');
  assert.equal(state.phases['1'].cause?.class, 'org-policy');
  assert.equal(state.phases['1'].cause?.account, 'p');
  assert.match(state.phases['1'].note ?? '', /organization policy blocks this credential \(account: p\)/);
  // The wall counts toward the streak (the branch used to return before it).
  assert.equal(state.consecutiveFailures, 1);
  // The account is retired through the one helper, class named, journalled.
  assert.equal(left.length, 1);
  assert.equal(left[0].accountId, 'p');
  assert.equal(left[0].leaving.kind, 'credential');
  assert.equal(left[0].leaving.class, 'org-policy');
  assert.equal(left[0].leaving.by, 'classifier');
  const retired = ladderJournal(events, 'run.account-retired');
  assert.equal(retired.length, 1);
  assert.equal(retired[0].id, 'p');
  assert.equal(retired[0].class, 'org-policy');
  assert.equal(retired[0].state, 'retired');
  // ONE errand, the run's, quoting the session's own sign-off (RCV-7).
  const errands = journalled(events, 'run.errand');
  assert.equal(errands.length, 1);
  assert.equal(errands[0].situation, 'resource-wall:auth');
  assert.equal(errands[0].phase, 1);
  assert.match(String(errands[0].need), /refused p's credential \(org-policy\)/);
  assert.match(String(errands[0].said), /disabled Claude subscription access/);
  assert.equal(state.errand?.situation, 'resource-wall:auth');
  assert.equal(journalled(events, 'phase.errand').length, 0, 'one wall, one errand — not a phase-level twin');
  // …and it was pushed: the errand rides the phase event `announceErrand` reads.
  assert.ok(events.some((e) => e.event === 'run:phase' && (e.data.errand as { situation?: string } | undefined)?.situation === 'resource-wall:auth'));

  // The same reason twice never spawns a third time: a resume on the retired
  // account is refused at the quota door — parked `run-preflight` with the
  // errand, no session (phase 8's door, asked again here).
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: state.id });
  await instance.wait();
  const again = instance.current()!;
  assert.equal(spawns.length, 1, 'no third spawn on the retired account');
  assert.equal(again.status, 'parked');
  assert.equal(again.halt?.kind, 'run-preflight');
  const refusedAt = journalled(events, 'run.preflight-refused');
  assert.equal(refusedAt.length, 1);
  assert.equal(refusedAt[0].wall, 'quota');
  r.cleanup();
});

test('RCV-1 (admission): a phase boarding under an account the breaker has retired since the run started is refused at the door — no spawn, the run halts credential-refused', async () => {
  const r = repo();
  r.setParallel(true);
  const spawns: SpawnRequest[] = [];
  let retired = false;
  const { instance, events } = runner(r, async (request) => {
    spawns.push(request);
    // The first phase completes; by the time the loop admits the next one,
    // ANOTHER run of this console (or another console) has retired the
    // credential — the machine-wide breaker moved between boardings.
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    retired = true;
    return ok();
  }, '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CONFIG_DIR: '/tmp/p' }),
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    accountHeadroom: (accountId) => retired
      ? { ok: false as const, accountId: accountId ?? 'default', kind: 'retired' as const, reason: 'p is retired: its organisation refused the credential' }
      : { ok: true as const, accountId: accountId ?? 'default' },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'p', maxParallel: 1 });
  await instance.wait();
  const state = instance.current()!;
  assert.equal(spawns.length, 1, 'the second phase never spawned');
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.kind, 'credential-refused');
  const refused = journalled(events, 'run.admission-refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, 'account-retired');
  assert.equal(refused[0].account, 'p');
  assert.equal(refused[0].phase, 2);
  assert.equal(state.phases['2']?.status, 'parked');
  assert.equal(state.phases['2']?.cause?.kind, 'credential-refused', 'the cause is on the record, as the classifier\'s arm stamps it');
  assert.equal(state.phases['2']?.cause?.class, undefined, 'the breaker names no class');
  assert.equal(journalled(events, 'phase.start').length, 1, 'phase 2 wrote no phase.start');
  r.cleanup();
});

test('RCV-1 (the wall clears): a Continue whose preflight passes re-boards the phase the credential wall parked, and the cause goes with it', async () => {
  const r = repo();
  const spawns: SpawnRequest[] = [];
  let refuse = true;
  const { instance, events } = runner(r, async (request) => {
    spawns.push(request);
    if (refuse) {
      return ok({ signal: { subtype: 'success', code: 0, text: 'Please run /login' }, resultText: 'Login expired · Please run /login' });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  }, '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CONFIG_DIR: '/tmp/p' }),
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    accountHeadroom: (accountId) => ({ ok: true as const, accountId: accountId ?? 'default' }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'p' });
  await instance.wait();
  const halted = instance.current()!;
  assert.equal(halted.halt?.kind, 'credential-refused');
  assert.equal(halted.phases['1'].status, 'parked');
  assert.equal(halted.phases['1'].cause?.class, 'auth');

  // A person signed the account in and pressed Continue: the preflight passes,
  // and the parked phase — SETTLED to the loop — is re-boarded rather than
  // left as "outstanding".
  refuse = false;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: halted.id });
  await instance.wait();
  const done = instance.current()!;
  assert.ok(spawns.length >= 2, 'the phase boarded again');
  assert.match(spawns[1].prompt, /BOOT phase 1\b/, 'phase 1 first — the one the wall parked');
  assert.equal(done.phases['1'].status, 'done');
  assert.equal(done.status, 'finished', 'and the linear plan ran on to the end');
  assert.equal(done.phases['1'].cause, undefined, 'the cause is no longer true');
  const reboarded = journalled(events, 'phase.retry-requested').filter((e) => e.by === 'console');
  assert.equal(reboarded.length, 1);
  assert.match(String(reboarded[0].reason), /no longer refuses/);
  r.cleanup();
});

test('ACT-3: isSpending answers true for the run\'s account only while a child is live — the poller\'s active probe', async () => {
  const r = repo();
  const held = streamingSession(r);
  const { instance } = runner(r, held.spawn, '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CONFIG_DIR: '/tmp/p' }),
  });
  assert.equal(instance.isSpending('p'), false, 'nothing is driving');
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'p' });
  await held.inSession;
  // The stub spawn reports no pid; a lane with a child is what the probe reads.
  const lanes = (instance as unknown as { lanes: Map<number, { pid?: number | null }> }).lanes;
  for (const lane of lanes.values()) lane.pid = process.pid;
  assert.equal(instance.isSpending('p'), true, 'a live child on p is p being spent');
  assert.equal(instance.isSpending('default'), false, 'and only p');
  held.release();
  await instance.wait();
  assert.equal(instance.isSpending('p'), false, 'settled: nothing spends');
  r.cleanup();
});

test('ACT-12: a token account\'s run attaches only the stdio servers the plan declares — the rest are dropped and run.token-scope says so', async () => {
  const r = repo();
  const configured: string[][] = [];
  const { instance, events } = runner(r, workingSession(r), '`true`', undefined, {
    accountEnv: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
    accountKind: (accountId) => (accountId === 'tok' ? 'token' : 'default'),
    planMcp: () => ['plan-stdio'],
    mcp: {
      preflight: async (ids) => { return { ok: true, blocking: [], unknown: [], disabled: [], probes: 0, ids } as never; },
      configFor: async (_runId, _phase, ids) => { configured.push([...ids]); return null; },
      transportOf: (id) => (id === 'remote-http' ? 'http' : 'stdio'),
    },
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'tok', mcpServers: ['run-stdio', 'remote-http'] });
  await instance.wait();
  const scoped = ladderJournal(events, 'run.token-scope');
  assert.ok(scoped.length >= 1);
  assert.deepEqual(scoped[0].kept, ['plan-stdio', 'remote-http'], 'the plan\'s stdio server and the remote one stay');
  assert.deepEqual(scoped[0].dropped, ['run-stdio'], 'the run\'s own stdio pick is dropped — it would inherit the token');
  assert.equal(scoped[0].reach, 'child-tree');
  assert.deepEqual(configured[0], ['plan-stdio', 'remote-http'], 'and that is the set the --mcp-config carries');
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 10: the one exhaustion predicate, and no rung left running
 * ------------------------------------------------------------------ */

test('LFC-2: a table this loop cannot drive is EXHAUSTED when the healer cannot drive it either — one errand naming the rungs and why, never a deferral', async () => {
  // The audit's specimen: a session declares itself blocked on the outside
  // world with no watch ref. `blocked-declared:external`'s two rungs are the
  // healer's (a park on the clock), not the loop's, and the loop used to
  // compute exhaustion from the unfiltered table — `false` — and write
  // `phase.ladder-deferred` for a table nothing would ever climb (28 records,
  // 0 errands). With no healer answering, the loop is exhausted and asks.
  const r = repo();
  try {
    const blocked: SpawnFn = async (request) => {
      fileOutcome(request, { phase: 1, status: 'blocked', needs: 'external', reason: 'the deploy window opens tonight' });
      return ok({ sessionId: 'sess-ext', resultText: 'declared blocked on the deploy window' });
    };
    const { instance, events } = runner(r, blocked, '`true`', undefined, {
      rungUnavailable: () => 'No rung of blocked-declared:external\'s ladder can be driven here — **Park and poll the refs** (poll-park, console): the session named no machine-checkable watch ref; **Park for a while** (timed-park, console): the run is not to hand.',
    });
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true });
    await instance.wait();
    const state = instance.current()!;
    const record = state.phases['1'];
    assert.equal(record.status, 'parked');
    assert.equal(journalled(events, 'phase.ladder-deferred').length, 0, 'an undrivable table escalates, never defers');
    const errand = journalled(events, 'phase.errand')[0];
    assert.ok(errand, 'one errand');
    assert.equal(errand.situation, 'blocked-declared:external');
    assert.match(String(errand.reason), /no rung for blocked-declared:external is available on this console yet/);
    assert.match(String(errand.how), /\*\*Park and poll the refs\*\* \(poll-park, console\): the session named no machine-checkable watch ref/);
    assert.equal(state.recoveries?.['1']?.errand?.situation, 'blocked-declared:external');
  } finally { r.cleanup(); }

  // …and when the HEALER can drive a rung the loop cannot, the loop defers to
  // it — `phase.ladder-deferred` naming what remains and what comes next.
  const r2 = repo();
  try {
    const blocked: SpawnFn = async (request) => {
      fileOutcome(request, { phase: 1, status: 'blocked', needs: 'external', reason: 'the deploy window opens tonight' });
      return ok({ sessionId: 'sess-ext', resultText: 'declared blocked on the deploy window' });
    };
    const { instance, events } = runner(r2, blocked, '`true`', undefined, {
      rungDrivable: (_slug: string, rung: { vehicle: string }) => rung.vehicle === 'timed-park',
    });
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true });
    await instance.wait();
    const deferred = journalled(events, 'phase.ladder-deferred')[0];
    assert.ok(deferred, 'deferred to the healer');
    assert.equal(deferred.situation, 'blocked-declared:external');
    assert.equal(deferred.next, 'timed-park', 'the rung the healer will climb');
    assert.deepEqual(deferred.remaining, ['poll-park', 'timed-park']);
    assert.equal(journalled(events, 'phase.errand').length, 0, 'no errand while a driver remains');
  } finally { r2.cleanup(); }
});

test('RCV-6: a rung the attempt left open is settled at the lane\'s end — situation and cost on the line — so the next attempt never books onto it', async () => {
  const r = repo();
  try {
    let calls = 0;
    const spawn: SpawnFn = async () => {
      calls++;
      // Attempt 1 exits clean with no handoff and no declaration — the loop
      // reads `done-unrecorded` and climbs `closeout-own-session` (a rung);
      // the closeout session writes the handoff. Neither declares an outcome,
      // so nothing but the lane-end backstop can settle the rung.
      if (calls === 1) return ok({ costUsd: 3, resultText: 'nothing happened' });
      r.markDone(1);
      return ok({ costUsd: 7 });
    };
    const { instance, events } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'done');
    const rungs = state.recoveries?.['1']?.rungs ?? [];
    assert.equal(rungs.length, 1, `one rung climbed: ${JSON.stringify(rungs)}`);
    assert.equal(rungs[0].rung, 'closeout-own-session');
    assert.notEqual(rungs[0].outcome, 'running', 'no rung stays running past its attempt');
    assert.equal(rungs[0].outcome, 'fixed');
    assert.equal(rungs[0].costUsd, 7, 'the rung is charged its OWN attempt, not the first one\'s');
    const settled = journalled(events, 'phase.rung-settled');
    assert.equal(settled.length, 1);
    assert.deepEqual(
      { rung: settled[0].rung, outcome: settled[0].outcome, situation: settled[0].situation, costUsd: settled[0].costUsd, by: settled[0].by },
      { rung: 'closeout-own-session', outcome: 'fixed', situation: 'done-unrecorded', costUsd: 7, by: 'attempt-end' },
    );
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * 2026-09-18: boarding asks the verification REVIEW (verify-review.ts)
 *
 * Run f0da619a halted at phase 2 on `bats …` under `Person-check: halt`, and
 * its park named the fragment but never the reason — "`bats` is not a
 * recognised command" was the whole story. Boarding now parks on the review's
 * verdict with the review's sentence, and honours the operator's answers from
 * the start door (`RunState.verifyApprovals`).
 * ------------------------------------------------------------------ */

test('a Person-check: halt park names the refused command and why — before a session is bought', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance } = runner(r, workingSession(r, seen), '- `true`\n- `frobnicate --check tests/`', undefined, {
    personCheck: () => 'halt',
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  assert.deepEqual(seen, [], 'no session was bought');
  const note = instance.current()!.phases['1'].note ?? '';
  assert.match(note, /frobnicate --check tests\/ — `frobnicate` is not a recognised command/);
  assert.match(note, /Person-check: halt — approve the exact command/);
  r.cleanup();
});

test('the bats line that halted run f0da619a boards under Person-check: halt', async () => {
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '- `true`\n- `bats --version`', undefined, {
    personCheck: () => 'halt',
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  assert.deepEqual(seen, [1], 'the phase boarded');
  assert.equal(journalled(events, 'phase.verify-preflight-parked').length, 0);
  r.cleanup();
});

test('the start door\'s exact approval boards an unknown command, and the run keeps the answer', async () => {
  const { commandFingerprint } = await import('../server/runner/verify.ts');
  const r = repo();
  const seen: number[] = [];
  const { instance, events } = runner(r, workingSession(r, seen), '- `true`\n- `frobnicate --check tests/`', undefined, {
    personCheck: () => 'halt',
  });
  const approve = [{ fp: commandFingerprint('frobnicate --check tests/'), text: 'frobnicate --check tests/' }];
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1],
    verifyApprovals: { approve, waive: [], by: 'operator', at: '2026-09-18T00:00:00.000Z' },
  });
  await instance.wait();
  assert.deepEqual(seen, [1], 'approved at the door, so it boarded');
  assert.deepEqual(instance.current()!.verifyApprovals?.approve, approve, 'newRun carried the answers');
  const [line] = journalled(events, 'run.verify-approvals');
  assert.deepEqual({ approve: line?.approve, waive: line?.waive, by: line?.by }, { approve: 1, waive: 0, by: 'operator' });
  r.cleanup();
});

test('a phase whose every check was waived at the door boards and passes on its handoff, journalled as waived', async () => {
  const { commandFingerprint } = await import('../server/runner/verify.ts');
  const r = repo();
  const seen: number[] = [];
  const prose = 'eyeball the chart on a phone';
  const { instance, events } = runner(r, workingSession(r, seen), prose, undefined, { personCheck: () => 'halt' });
  await instance.start({
    slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1],
    verifyApprovals: { approve: [], waive: [{ phase: 1, fp: commandFingerprint(prose), text: prose }] },
  });
  await instance.wait();
  assert.deepEqual(seen, [1], 'the waiver was the operator\'s answer, so the phase boarded');
  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'done', record.note);
  assert.match(record.verification?.reason ?? '', /waived at the run's start/);
  assert.deepEqual(journalled(events, 'phase.verify-waived').map((line) => line.by), ['launch', 'launch']);
  r.cleanup();
});

// ── S1-a — the grant→spawn window held no lock at all ────────────────────────
// The runner CHECKED the lock and did not take it, for a good reason that has
// since stopped applying: a lock the runner took first used to be a lock its own
// session read as a stranger's, so the session refused the phase and the
// supervisor deadlocked against its own worker. The session now runs AS
// `autopilot/<runId>` (it has since the PE_OWNER fix), so a claim by the runner
// under that same owner is a claim the session REFRESHES.
//
// What the gap cost: between the scheduler's grant and the child's first
// `claim` — a process spawn, a prompt build, an MCP preflight — there was no
// lock on disk at all, and the keepalive does not fire for ten minutes. A hand
// session running `phase-lock.sh conflicts` in that window scanned files, found
// none, and was told "safe to start" against a console lane that was booting.
test('S1-a: the runner claims provisionally at grant, under its own owner, on a short lease', async () => {
  const r = repo();
  const { instance } = runner(r, async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    r.markDone(phase);
    return ok();
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const owner = `autopilot/${instance.current()!.id}`;
  const calls = readFileSync(join(r.state, 'locks'), 'utf8').split('\n').filter(Boolean);

  // One provisional claim per phase, before that phase's session exists.
  for (const phase of [1, 2, 3]) {
    const claim = calls.find((line) => line.startsWith(`demo claim ${phase} `));
    assert.ok(claim, `no provisional claim for phase ${phase}:\n${calls.join('\n')}`);
    assert.match(claim!, new RegExp(`--owner ${owner.replace('/', '\\/')}\\b`), claim!);
    // SHORT. The child refreshes it to the full lease within a minute of
    // starting; if the child never starts, this is how long the window is wrong
    // for rather than how long the phase runs.
    assert.match(claim!, /--lease 900\b/, claim!);
  }

  // And it is still asked BEFORE it claims — the belt-check has not moved.
  const firstStatus = calls.findIndex((line) => line.startsWith('demo status 1'));
  const firstClaim = calls.findIndex((line) => line.startsWith('demo claim 1 '));
  assert.ok(firstStatus >= 0 && firstStatus < firstClaim,
    `the lock is claimed before it is read:\n${calls.join('\n')}`);
  r.cleanup();
});


/* ── G-PIN12 — the seven mutation-proved pins from the phase-12 QA report ─────
 * `console-parallel-repaint` phase 12's QA round found five arms the phase had
 * changed with no test that bites: reverting each left the phase's own suites
 * green. QA wrote the pins, mutation-proved every one of them RED against the
 * committed code — and did not commit them, because a QA round's job is the
 * verdict. They have sat in an appendix ever since, which is the same as not
 * existing: the arms are unguarded and the next refactor takes them silently.
 * Adopted here verbatim in intent, adjusted only where this tree's helpers
 * have moved on. */
test('P12-QA allowUnverifiedPhases: a plan WITH a command still runs it — a red command stays a red verdict, never a waiver', async () => {
  const r = repo();
  try {
    const { instance, events } = runner(r, workingSession(r), '`false`', undefined, { allowUnverifiedPhases: () => true });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.equal(record.verification?.ok, false, 'the command ran and failed');
    // `ran` holds the command and the verifier's own single retry of a red one.
    assert.ok((record.verification?.ran.length ?? 0) >= 1, 'the command ran');
    assert.ok(record.verification?.ran.every((c) => c.command === 'false'), 'and it was the plan\'s command');
    assert.doesNotMatch(record.verification?.reason ?? '', /allowUnverifiedPhases/);
    assert.equal(journalled(events, 'phase.verify-waived').length, 0, 'nothing was waived');
  } finally { r.cleanup(); }
});

test('P12-QA the runner\'s declared errand: a permission-wall reason reads blocked-declared:permission with the policy remedy; an external one keeps the watch note', async () => {
  const WALL = "Edit/Write on .claude/** is permission-denied in this unattended session ('sensitive file'); run the edits by hand.";
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => { fileOutcome(request, { phase: 1, status: 'needs-human', reason: WALL }); return ok(); };
    const { instance } = runner(r, spawn);
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'parked');
    const errand = state.recoveries?.['1']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:permission');
    assert.equal(errand?.need, WALL, 'need is the session\'s own words');
    assert.match(errand?.how ?? '', /Settings ▸ Permissions/);
    assert.match(errand?.how ?? '', /Never strike a deny rule/);
    assert.doesNotMatch(errand?.how ?? '', /watching its refs/);
    assert.deepEqual(errand?.tried, []);
  } finally { r.cleanup(); }
  const r2 = repo();
  try {
    const spawn: SpawnFn = async (request) => {
      fileOutcome(request, { phase: 1, status: 'needs-human', reason: 'the staging gate needs an operator', watch: ['gh:acme/app#run/123'] });
      return ok();
    };
    const { instance } = runner(r2, spawn);
    await instance.start({ slug: 'demo', root: r2.root, onlyPhases: [1] });
    await instance.wait();
    const errand = instance.current()!.recoveries?.['1']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:external');
    assert.match(errand?.how ?? '', /^Check its watch refs/);
    assert.match(errand?.how ?? '', /watching its refs and resumes the session when they land/);
  } finally { r2.cleanup(); }
});

