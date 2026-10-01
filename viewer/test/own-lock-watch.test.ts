/**
 * A watch never fires on its own teardown (control-tower phase 39, #42) —
 * criteria OL-1 … OL-3.
 *
 * The measured shape: `tamagui-upgrade` phase 4 declared `blocked` with a
 * `--watch lock:tamagui-upgrade/4` — the lock the console had claimed for that
 * very session. At the closeout the runner released it, the ref saw "nothing
 * holds that scope any more", and the console admitted phase 4 again: a
 * three-minute session spawned to observe its own lock release, whose second
 * `blocked` then read on the halt card as the phase failing twice.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { WatchScheduler } = await import('../server/watch-scheduler.ts');
const { PERSON_NEEDS, isOwnLockRef, screenDeclaration } = await import('../server/runner/wait-budget.ts');
const { OWN_LOCK_WATCH_REFUSAL } = await import('../shared/run-lifecycle.js');
type RunState = import('../server/runner/state.ts').RunState;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type PhaseOutcome = import('../server/runner/outcome.ts').PhaseOutcome;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const REASON = 'The rebase needs a person to pick one of two component APIs; the plan does not say which.';

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

/** A stub repository whose board reads phase 1 ready, and never anything else. */
function stubRepo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-own-lock-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) printf 'done: \\nin-progress: \\nstuck: \\nready: 1\\nwaiting: \\n' ;;
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
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A session that declares `body` every time it is boarded, counting its boardings. */
function declaring(body: Record<string, unknown>): { spawn: SpawnFn; calls: () => number } {
  let calls = 0;
  const spawn: SpawnFn = async (request) => {
    calls++;
    writeFileSync(request.env!.PE_OUTCOME_FILE as string, JSON.stringify({
      version: 1, slug: 'demo', phase: 1, written_at: new Date().toISOString(), watch: [], ...body,
    }));
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: `sess-${calls}`, costUsd: 0, turns: 1,
      resultText: 'declared', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  return { spawn, calls: () => calls };
}

async function runOnce(body: Record<string, unknown>, opts: { autoRecover?: boolean } = {}) {
  const r = stubRepo();
  const session = declaring(body);
  const instance = new Runner({ scriptsDir: r.scripts, spawn: session.spawn, verificationText: () => '`true`' });
  try {
    await instance.start({
      slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: opts.autoRecover ?? true,
    } as never);
    await instance.wait();
    const state = instance.current()!;
    return { state, lines: journalLines(r.root, 'demo', state.id), calls: session.calls() };
  } finally {
    instance.close();
    r.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * OL-1 — refused at declaration, and again at ingest
 * ------------------------------------------------------------------ */

test('OL-1 — the script refuses a watch on the declarer\'s own lock with the console\'s own sentence, word for word', () => {
  const script = readFileSync(join(SCRIPTS, 'phase-outcome.sh'), 'utf8');
  const copy = /^OWN_LOCK_WATCH_REFUSAL="(.*)"$/m.exec(script)?.[1];
  assert.equal(copy, OWN_LOCK_WATCH_REFUSAL, 'phase-outcome.sh and run-lifecycle.js say one sentence');

  const dir = mkdtempSync(join(tmpdir(), 'pc-own-lock-sh-'));
  try {
    const outcome = join(dir, 'outcome.json');
    const run = (...args: string[]) => spawnSync('/bin/bash', [join(SCRIPTS, 'phase-outcome.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: dir, PE_OUTCOME_FILE: outcome, PE_RULINGS_FILE: join(dir, 'r.ndjson') },
    });
    for (const ref of ['lock:demo/8', 'lock:demo/008', 'lock: demo/8 ']) {
      const refused = run('demo', '8', 'blocked', '--needs', 'lock', '--reason', 'x', '--watch', ref);
      assert.equal(refused.status, 2, `${ref}: ${refused.stderr}`);
      assert.ok(refused.stderr.includes(OWN_LOCK_WATCH_REFUSAL), refused.stderr);
      assert.equal(existsSync(outcome), false, 'nothing is written');
    }
    const other = run('demo', '8', 'blocked', '--needs', 'lock', '--reason', 'x', '--watch', 'lock:other-plan/8');
    assert.equal(other.status, 0, other.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outcome, 'utf8')).watch, ['lock:other-plan/8'], 'somebody else\'s lock is what a lock watch is for');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OL-1 — screenDeclaration: an own-lock ref is refused whatever its spelling; another phase\'s or plan\'s is kept', () => {
  assert.equal(isOwnLockRef('lock:demo/8', 'demo', 8), true);
  assert.equal(isOwnLockRef(' lock:demo/08 ', 'demo', 8), true);
  assert.equal(isOwnLockRef('lock:demo/9', 'demo', 8), false);
  assert.equal(isOwnLockRef('lock:other/8', 'demo', 8), false);
  assert.equal(isOwnLockRef('gh:acme/app#run/8', 'demo', 8), false);
  const declared = {
    version: 1, slug: 'demo', phase: 8, status: 'blocked', needs: 'lock', reason: 'x',
    watch: ['lock:demo/8', 'lock:demo/3', 'gh:acme/app#pr/2'], written_at: new Date().toISOString(),
  } as PhaseOutcome;
  const screened = screenDeclaration(declared, 'demo', 8);
  assert.deepEqual(screened.ownLock, ['lock:demo/8']);
  assert.deepEqual(screened.outcome.watch, ['lock:demo/3', 'gh:acme/app#pr/2']);
  assert.deepEqual(screened.outcome.refused, ['lock:demo/8']);
  assert.equal(screened.person, false);
  assert.deepEqual(declared.watch, ['lock:demo/8', 'lock:demo/3', 'gh:acme/app#pr/2'], 'the input is not mutated');
});

test('OL-1 — supervised ingest: a declaration an older script wrote is refused, and the phase parks for a person instead of queueing behind itself', async () => {
  const { state, lines, calls } = await runOnce({
    status: 'blocked', needs: 'lock', reason: 'lock held by me@laptop', watch: ['lock:demo/1'],
  });
  assert.equal(calls, 1, 'no second session: the release of its own lock is not a landing');
  const refused = lines.filter((l) => l.event === 'phase.watch-refused');
  assert.deepEqual(refused.map((l) => [l.data.ref, l.data.why, l.data.by]), [['lock:demo/1', 'own-lock', 'ingest']]);
  assert.equal(refused[0].data.reason, OWN_LOCK_WATCH_REFUSAL);
  const outcome = lines.find((l) => l.event === 'phase.outcome')!;
  assert.deepEqual(outcome.data.watch, []);
  assert.deepEqual(outcome.data.refused, ['lock:demo/1']);
  assert.equal(lines.filter((l) => l.event === 'phase.outcome-lock-blocked').length, 0, 'not a lock wait: there is no holder');
  const record = state.phases['1'];
  assert.equal(record.status, 'parked');
  assert.equal(record.declared?.watch, undefined, 'the refused ref never reaches the record');
  const errand = state.recoveries?.['1']?.errand;
  assert.equal(errand?.situation, 'blocked-declared:unknown');
  assert.ok(errand?.how.includes(OWN_LOCK_WATCH_REFUSAL), errand?.how);
});

test('OL-1 — a lock watch on another phase\'s lock is still the lock wait it always was', async () => {
  const { lines } = await runOnce({
    status: 'blocked', needs: 'lock', reason: 'lock held by someone/else', watch: ['lock:other-plan/3'],
  }, { autoRecover: false });
  assert.equal(lines.filter((l) => l.event === 'phase.watch-refused').length, 0);
  // The stub's session re-declares the same wait each time the free lock lets
  // it board again — every one of those is the lock wait, none a refusal.
  assert.ok(lines.filter((l) => l.event === 'phase.outcome-lock-blocked').length >= 1);
});

/* ---- the unsupervised door: a hand session's file through the inbox ---- */

const PLAN = `---
slug: alpha
created: 2026-09-23
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | 2 | app | it works |
| 2 | two | — | 1 | docs | it works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S
`;

test('OL-1 — unsupervised ingest refuses the same ref: journalled, dropped from the record, the rest of the declaration kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-own-lock-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  try {
    assert.equal(svc.open(root).ok, true);
    (svc as never as { announce: () => void }).announce = () => {};
    const stored = newRun({ slug: 'alpha', root });
    stored.status = 'parked';
    stored.stoppedBy = 'system';
    phaseRecord(stored, 2);
    saveRun(stored);

    await (svc as never as { applyUnsupervisedOutcome: (s: string, p: number, d: PhaseOutcome) => Promise<void> })
      .applyUnsupervisedOutcome('alpha', 2, {
        version: 1, slug: 'alpha', phase: 2, status: 'blocked', needs: 'lock', reason: 'lock held by a hand session',
        watch: ['lock:alpha/02', 'lock:beta/3'], written_at: new Date().toISOString(),
      } as PhaseOutcome);

    const disk = loadRun(root, 'alpha', stored.id)!;
    assert.deepEqual(disk.phases['2'].declared?.watch, ['lock:beta/3']);
    const lines = journalLines(root, 'alpha', stored.id);
    const refused = lines.filter((l) => l.event === 'phase.watch-refused');
    assert.deepEqual(refused.map((l) => [l.data.ref, l.data.why, l.data.by, l.phase]), [['lock:alpha/02', 'own-lock', 'unsupervised', 2]]);
    const outcome = lines.filter((l) => l.event === 'phase.outcome').at(-1)!;
    assert.deepEqual(outcome.data.refused, ['lock:alpha/02']);
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * OL-2 — never fired by the declarer's own release
 * ------------------------------------------------------------------ */

test('OL-2 — tamagui-upgrade phase 4 replayed: the closeout releases its own lock and nothing is admitted; a foreign lock still lands', async () => {
  const at = new Date(Date.now() - 180_000).toISOString();
  // As an older console armed it — before either refusal existed.
  const state = {
    id: 'run-ol2', slug: 'tamagui-upgrade', status: 'parked', model: 'claude-opus-5', startedAt: at,
    phases: {
      4: {
        phase: 4, status: 'pending', attempts: 1,
        declared: {
          status: 'blocked', needs: 'lock', reason: 'verification still red; the gate needs a person', at,
          watch: ['lock:tamagui-upgrade/4', 'lock:tamagui-upgrade/3'],
        },
      },
    },
  } as unknown as RunState;
  const landed: string[] = [];
  const journal: Array<{ kind: string; data: Record<string, unknown>; phase: number }> = [];
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'tamagui-upgrade', state }],
    // The closeout released phase 4's lock, and phase 3's holder is gone too:
    // both locks read free. Only one of those is news.
    lockFree: () => true,
    onLanded: (_slug, _state, _phase, l) => { landed.push(l.ref); return 'done' as const; },
    journal: (_slug, _state, kind, data, phase) => { journal.push({ kind, data, phase }); },
  });
  try {
    scheduler.open();
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual([...new Set(landed)], ['lock:tamagui-upgrade/3'], 'the only admission is the one another holder\'s release earned');
    const own = state.phases[4].watchState?.refs.find((r) => r.ref === 'lock:tamagui-upgrade/4');
    assert.equal(own?.state, 'refused');
    assert.ok(own?.detail?.includes("names phase 4's own lock"), own?.detail);
    assert.ok(state.phases[4].watchRetired?.includes('lock:tamagui-upgrade/4'), 'retired from the rotation');
    const refusals = journal.filter((j) => j.kind === 'phase.watch-refused');
    assert.equal(refusals.length, 1, 'said once, however many passes');
    assert.equal(refusals[0].data.ref, 'lock:tamagui-upgrade/4');
  } finally { scheduler.close(); }
});

/* ------------------------------------------------------------------ *
 * OL-3 — a person takes no watch and no clock
 * ------------------------------------------------------------------ */

test('OL-3 — blocked --needs ambiguity takes no watch and no wait clock, and its journal line says so', async () => {
  assert.ok(PERSON_NEEDS.includes('ambiguity'));
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const { state, lines } = await runOnce({
    status: 'blocked', needs: 'ambiguity', reason: REASON, watch: ['cmd:"true"'], resume_after: until,
  }, { autoRecover: false });
  const record = state.phases['1'];
  assert.equal(record.declared?.watch, undefined, 'no watch');
  assert.equal(record.parkedUntil, undefined, 'no wait clock');
  const outcome = lines.find((l) => l.event === 'phase.outcome')!;
  assert.equal(outcome.data.person, true);
  assert.deepEqual(outcome.data.watch, []);
  assert.equal(outcome.data.resumeAfter, null);
  assert.match(String(outcome.data.clock), /a person settles this; no watch, no wait clock/);
  assert.deepEqual(outcome.data.dropped, { watch: ['cmd:"true"'], resumeAfter: until });
});

test('OL-3 — needs-human --needs ambiguity: parked for the person, with no watch on the record and no clock', async () => {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const { state, lines } = await runOnce({
    status: 'needs-human', needs: 'ambiguity', reason: REASON, watch: ['date:2030-01-01T00:00:00Z'], resume_after: until,
  });
  const record = state.phases['1'];
  assert.equal(record.status, 'parked');
  assert.equal(record.watch, undefined);
  assert.equal(record.parkedUntil, undefined);
  const parked = lines.find((l) => l.event === 'phase.outcome-needs-human')!;
  assert.deepEqual(parked.data.watch, []);
  assert.equal(parked.data.resumeAfter, null);
  // A block that is NOT a person's keeps what it asked for.
  const machine = screenDeclaration({
    version: 1, slug: 'demo', phase: 1, status: 'needs-human', needs: 'external', reason: 'the deploy window',
    watch: ['date:2030-01-01T00:00:00Z'], resume_after: until, written_at: until,
  } as PhaseOutcome, 'demo', 1);
  assert.equal(machine.person, false);
  assert.deepEqual(machine.outcome.watch, ['date:2030-01-01T00:00:00Z']);
  assert.equal(machine.outcome.resume_after, until);
});
