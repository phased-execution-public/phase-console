/**
 * A checkpoint is honest about the session's own jobs (control-tower phase 89,
 * #121, #52 ask 3).
 *
 * P27 waited — as the wait procedure prescribes — on two verify jobs it had
 * started itself; the console classed the wait external, checkpointed the
 * session, and its process-group signal killed both jobs. It then parked the
 * phase on a watch of their output files: files nothing would ever write.
 * vca P10's park minted `grep … '$L'`, the session's own variable, which could
 * never land; vca P11's killed an Android sweep at route 27 of 68.
 *
 * CK-3  a checkpoint that ends the session's own job records `reverify
 *       {cause: 'checkpoint'}` and arms no watch on the job's output — even
 *       where minted refs run — and the next boarding's brief asks for the job
 *       again, consuming the debt; it never sends the phase into the console's
 *       session-less re-verification
 * CK-4  a watchdog park whose condition cannot succeed as a watch (an
 *       unexpanded `$L`) parks with NO ref and says why
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { owesVerification } from '../server/runner/state.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');

const call = (id: string, command: string): StreamEvent => ({ kind: 'tool', id, name: 'Bash', summary: command });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'pc-ck-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const script = (name: string, body: string) => { writeFileSync(join(scripts, name), body, 'utf8'); chmodSync(join(scripts, name), 0o755); };
  script('phase-graph.sh', `#!/usr/bin/env bash
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  script('phase-lock.sh', '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}1\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One session held open, its event sink reachable. */
function heldSession(r: ReturnType<typeof repo>) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    request.onHandle?.({ pid: undefined, open: () => true, send: () => true, setFrozen: () => {} });
    request.onEvent?.({ kind: 'init', sessionId: 'sess-own', model: 'stub-1', tools: 0 });
    entered();
    await held;
    r.markDone();
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-own', costUsd: 0.02, turns: 3, resultText: 'done',
      durationMs: 10, argv: ['-p', '<prompt>'],
    } as SpawnOutcome;
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

function clock() {
  const at = { now: T0 };
  return { now: () => new Date(at.now), wind: (ms: number) => { at.now += ms; } };
}

test('CK-3: a checkpoint that ends the session\'s own job owes it a re-run, arms no watch on its output even where minted refs run, and the next brief asks for it', async () => {
  const r = repo();
  const held = heldSession(r);
  const c = clock();
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: held.spawn, now: c.now,
    verificationText: () => '`true`',
    mintedCmdRefs: () => true,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    // Its own Android job, waited on in-turn past the 45-minute local budget.
    held.say(call('own', 'until grep -q ANDROID_JOB_DONE /tmp/vca/e2e/android-final.log 2>/dev/null; do sleep 10; done'));
    c.wind(46 * MINUTE);
    await instance.tickLiveness();
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'parked');
    assert.deepEqual(record.watch ?? [], [], 'no watch on the output of a job that ended with the session');
    assert.equal(record.declared?.minted, undefined);
    assert.match(record.parkReason ?? '', /ends that job with the session \(the whole process group\)/);
    assert.equal(record.reverify?.cause, 'checkpoint');
    assert.deepEqual(record.reverify?.jobs, ['/tmp/vca/e2e/android-final.log']);
    assert.equal(owesVerification(record), false, 'the SESSION owes it — never the console\'s session-less re-verification');

    // The next boarding's brief names the job and asks for it detached, and the debt is spent.
    const handle = instance as never as { boardingWipBlock: (phase: number, lane: unknown) => Promise<string> };
    const brief = await handle.boardingWipBlock.call(instance, 1, { phase: 1 });
    assert.match(brief, /checkpoint at .* ended your previous session while it waited on a job of its own \(\/tmp\/vca\/e2e\/android-final\.log\)/);
    assert.match(brief, /re-run what is missing DETACHED/);
    assert.equal(instance.current()!.phases['1'].reverify, undefined, 'consumed by the brief that named it');
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('CK-4: a watchdog park whose condition cannot succeed as a watch — the session\'s own `$L` — parks with no ref and says why', async () => {
  const r = repo();
  const held = heldSession(r);
  const c = clock();
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: held.spawn, now: c.now,
    verificationText: () => '`true`',
    mintedCmdRefs: () => true,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    held.say(call('var', 'until grep -q "ios done" "$L" 2>/dev/null; do sleep 2; done'));
    c.wind(46 * MINUTE);
    await instance.tickLiveness();
    const record = instance.current()!.phases['1'];
    assert.deepEqual(record.watch ?? [], [], 'no ref armed that could never land');
    assert.match(record.parkReason ?? '', /cannot succeed as a watch \(it carries a shell variable or substitution \(\$\)/);
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});
