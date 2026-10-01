/**
 * A stop ends the wait it interrupts (#50, control-tower phase 52).
 *
 * Run 006df40b was queued on scope when the operator stopped it, and from then
 * until it was resumed a day later its record said two things at once:
 * `status: paused`, `stoppedBy: operator`, "stopped by the operator" — and
 * `waitReason: 'scope'`. Every reader keying on the reason saw a run waiting
 * for a scope nothing would ever free, which is how an operator's Stop came to
 * be reported as "paused with waitReason scope".
 *
 * The queue's wait is written through `setRunState(state, 'queued', {kind:
 * 'scope'})`; the stop ended the loop with a RAW `state.status = …`, which
 * wrote the word and left the reason behind. Every run-status write now goes
 * through `setRunState` (`invariants.test.ts` refuses a raw one outside
 * `runner/state.ts`), and the writer drops a reason whose wait is over.
 *
 *   SW-1  a live runner queued on scope, stopped by the operator, leaves
 *         `waitReason` null and no `lifecycle.wait` — in memory and on disk.
 *   SW-2  the rule is the WRITER's, for every status word: a word that is not
 *         a wait drops the reason; a wait word keeps it; and a run still
 *         holding a wait clock keeps the clock's reason (a usage window
 *         reconciled to `paused` is still a usage window).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { Scheduler } from '../server/runner/scheduler.ts';
import { loadRun, newRun, setRunState, type RunState, type RunStatus } from '../server/runner/state.ts';
import type { SpawnFn } from '../server/runner/spawn.ts';
import { RUN_STATUSES, runLifecycle } from '../shared/run-lifecycle.js';

process.env.PHASE_CONSOLE_LOG = '';

/** A repo with the three scripts a runner shells: a one-phase board, a free lock, a clean lint. */
function repo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-stop-wait-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const script = (name: string, body: string): void => {
    writeFileSync(join(scripts, name), body, 'utf8');
    chmodSync(join(scripts, name), 0o755);
  };
  script('phase-graph.sh', `#!/usr/bin/env bash
set -u
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) printf 'done: \\nin-progress: \\nstuck: \\nready: 1\\nwaiting: \\n' ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  script('phase-lock.sh', `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const until = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

test('SW-1: stopping a run while its phase is queued on scope leaves waitReason null and no lifecycle.wait — in memory and on disk', async () => {
  const r = repo();
  // Another session's claim on the phase's scope, leased for half an hour: the
  // phase queues behind it, and nothing in this test's time frees it.
  const scheduler = new Scheduler({
    locks: () => [{
      slug: 'tamagui-upgrade', phase: 4, owner: 'mo@hand', expired: false,
      scope: ['vendor-commissioner-app'], leaseUntil: Date.now() + 30 * 60_000,
    }],
  });
  const spawned: string[] = [];
  const spawn: SpawnFn = async (request) => { spawned.push(request.prompt); throw new Error('nothing may board behind a live claim'); };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const runner = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    scheduler,
    phaseScope: () => ['vendor-commissioner-app'],
  });
  try {
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1] });

    // The precondition #50 needs, stated rather than assumed: the run is
    // waiting on scope, through the named writer, with the reason recorded.
    assert.ok(await until(() => runner.current()?.status === 'queued'), 'the phase queues behind the claim');
    const queued = runner.current()!;
    assert.equal(queued.waitReason, 'scope');
    assert.equal(queued.lifecycle?.wait?.kind, 'scope');

    await runner.stop({ by: 'operator', via: 'api', origin: 'local', remoteUser: null });
    await runner.wait();

    const state = runner.current()!;
    assert.deepEqual(spawned, [], 'nothing boarded');
    assert.equal(state.status, 'paused', 'an operator stop with no halt is paused');
    assert.equal(state.stoppedBy, 'operator');
    assert.equal(state.waitReason, null, 'the wait ended with the stop, and so did its reason');
    assert.equal(state.lifecycle?.state, 'paused');
    assert.equal(state.lifecycle?.wait, undefined, 'no wait axis on a run nothing is waiting for');
    const notStarted = events.filter((e) => e.event === 'run:journal' && e.data.event === 'phase.not-started');
    assert.equal(notStarted.length, 1, 'the phase says why it never started');
    assert.match(String((notStarted[0].data.data as Record<string, unknown>).reason), /stopped while this phase waited for its scope/);

    // …and the record a later reader loads says the same, not the stale half.
    const stored = loadRun(r.root, 'demo', state.id)!;
    assert.equal(stored.status, 'paused');
    assert.equal(stored.waitReason, null);
    assert.equal(stored.lifecycle?.wait, undefined);
  } finally {
    scheduler.close();
    r.cleanup();
  }
});

test('SW-2: the writer drops a reason whose wait is over — for every status word — and keeps one a wait or a wait clock still stands on', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-stop-wait-writer-'));
  try {
    const waiting = (status: RunStatus) => runLifecycle({ status }).state === 'waiting';
    const words = RUN_STATUSES as readonly RunStatus[];
    // Both halves of the table are populated, or the loop below proves nothing.
    assert.ok(words.some(waiting) && words.some((w) => !waiting(w)), 'the vocabulary holds waits and non-waits');

    for (const status of words) {
      const state: RunState = newRun({ slug: 'demo', root, model: 'opus' });
      setRunState(state, 'queued', { kind: 'scope', on: 'tamagui-upgrade phase 4' });
      assert.equal(state.waitReason, 'scope');

      setRunState(state, status);
      if (waiting(status)) {
        assert.equal(state.waitReason, 'scope', `${status} is a wait: its reason stands`);
      } else {
        assert.equal(state.waitReason, null, `${status} is not a wait: the reason goes with the wait`);
        assert.equal(state.lifecycle?.wait, undefined, `${status} carries no wait axis`);
      }
    }

    // A wait CLOCK outlives the word: a usage window the boot reconciled to
    // `paused` keeps its clock, and its reason is how the re-arm tells a usage
    // wall from a park on external work.
    const window = newRun({ slug: 'demo', root, model: 'opus' });
    window.waitUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    setRunState(window, 'waiting', { kind: 'usage-limit', until: window.waitUntil });
    setRunState(window, 'paused');
    assert.equal(window.waitReason, 'usage-limit', 'a run holding a wait clock keeps the clock\'s reason');

    // …and the moment the clock is gone, the next word drops it like any other.
    window.waitUntil = null;
    setRunState(window, 'interrupted');
    assert.equal(window.waitReason, null);

    // An explicit wait always wins, whatever the previous reason was.
    setRunState(window, 'queued', { kind: 'schedule' });
    assert.equal(window.waitReason, 'schedule');
    assert.equal(window.lifecycle?.wait?.kind, 'schedule');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
