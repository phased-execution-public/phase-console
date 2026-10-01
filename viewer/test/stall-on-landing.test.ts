/**
 * A finished lane never raises a stall (control-tower phase 47, #80).
 *
 * The lane outlives its phase: after §Verification it is kept through the
 * landing, and the liveness tick went on judging it with the record reading
 * `done`. The verifying suppression had lifted, so the verification's minutes
 * read as session silence — a "silent" stall raised 4 to 27 seconds after
 * `phase.done`, in all 5 of the week's silent stalls. Removing the lane never
 * cleared it, and the escalation timer found it still set 45 minutes later and
 * pushed an URGENT card about a phase that had finished.
 *
 *   SL-1  only a `running` record is judged
 *   SL-2  ending a lane clears its stall and retracts its card
 *   SL-3  escalation re-checks the phase still runs, in the episode it armed for
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import type { SpawnFn, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-23T11:00:00.000Z');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'pc-stall-landing-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const script = (name: string, body: string) => {
    writeFileSync(join(scripts, name), body, 'utf8');
    chmodSync(join(scripts, name), 0o755);
  };
  script('phase-graph.sh', `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
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

/** A lane held open by the test, then let finish with the board reading done. */
function lane() {
  const r = repo();
  const at = { now: T0 };
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    request.onHandle?.({ pid: undefined, open: () => true, send: () => true, setFrozen: () => {} });
    request.onEvent?.({ kind: 'init', sessionId: 'sess-landing', model: 'stub-1', tools: 0 } as StreamEvent);
    entered();
    await held;
    r.markDone();
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: 'sess-landing', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p'],
    };
  };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, now: () => new Date(at.now),
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { r, instance, events, inSession, release: () => release(), wind: (ms: number) => { at.now += ms; } };
}

const liveness = (events: { event: string; data: Record<string, unknown> }[]) => events
  .filter((e) => e.event === 'run:liveness')
  .map((e) => e.data as { stall?: { signal?: string } | null; ended?: boolean });

test('SL-1 — a lane whose record is not running is never judged; the same silence on a running one is a stall', async () => {
  const l = lane();
  try {
    const state = await l.instance.start({ slug: 'demo', root: l.r.root, onlyPhases: [1] });
    await l.inSession;
    // The landing window: the record reads `done` while the lane lives on.
    state.phases['1'].status = 'done';
    l.wind(20 * MINUTE);
    await l.instance.tickLiveness();
    assert.equal(state.phases['1'].stall, undefined, 'a finished phase is not silent — it is finished');
    assert.deepEqual(liveness(l.events), []);

    state.phases['1'].status = 'running';
    await l.instance.tickLiveness();
    assert.equal(state.phases['1'].stall?.signal, 'silent', 'the control: running and quiet is a stall');

    // …and back to done: the episode ENDS rather than lingering.
    state.phases['1'].status = 'done';
    await l.instance.tickLiveness();
    assert.equal(state.phases['1'].stall, undefined);
    assert.equal(liveness(l.events).at(-1)?.stall, null, 'the clear is emitted, so the card is retracted');
    state.phases['1'].status = 'running';
    l.release();
    await l.instance.wait();
  } finally { l.r.cleanup(); }
});

test('SL-2 — ending a lane clears record.stall and says so, so the card comes down', async () => {
  const l = lane();
  try {
    const state = await l.instance.start({ slug: 'demo', root: l.r.root, onlyPhases: [1] });
    await l.inSession;
    l.wind(11 * MINUTE);
    await l.instance.tickLiveness();
    assert.equal(state.phases['1'].stall?.signal, 'silent', 'precondition: a stall stands');

    l.release();
    await l.instance.wait();
    const record = l.instance.current()!.phases['1'];
    assert.equal(record.status, 'done');
    assert.equal(record.stall, undefined, 'the lane is gone, and its stall with it');
    const last = liveness(l.events).at(-1);
    assert.equal(last?.stall, null);
    assert.equal(last?.ended, true, 'the clear names the lane ending, not the lane recovering');
  } finally { l.r.cleanup(); }
});

test('SL-3 — escalation re-checks that the phase still runs, in the episode it was armed for', () => {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const urgent: string[] = [];
  sv.push.announce = ((_category: string, message: { title: string }, _now: number, _cb: unknown, opts?: { urgent?: boolean }) => {
    if (opts?.urgent) urgent.push(message.title);
  }) as typeof sv.push.announce;
  sv.webhooks.announce = (() => {}) as typeof sv.webhooks.announce;
  const inner = sv as unknown as {
    notifications: { clear(what: 'all'): number };
    prefs: { notify: Record<string, boolean> };
    runners: Map<string, unknown>;
    stallEscalations: Map<string, { timer: NodeJS.Timeout }>;
    announceStall: (data: unknown) => void;
    escalateStall: (key: string) => void;
  };
  inner.notifications.clear('all');
  inner.prefs.notify = { ...inner.prefs.notify, stalled: true };
  const S1 = new Date(T0).toISOString();
  const S2 = new Date(T0 + 50 * MINUTE).toISOString();
  // `isSpending` because the usage poller asks every runner in the pool on its
  // own clock, and a stub without it fails whichever test that clock lands in.
  const run = (status: string, stall: unknown) => ({
    current: () => ({ id: 'run-1', slug: 'demo', status: 'running', phases: { 2: { status, stall } } }),
    isSpending: () => false,
  });
  const arm = () => {
    inner.announceStall({
      slug: 'demo', runId: 'run-1', phase: 2, attempt: 1,
      stall: { signal: 'silent', since: S1, detail: 'no output for 10 min; no tool call is open' },
    });
    const key = [...inner.stallEscalations.keys()].at(-1)!;
    clearTimeout(inner.stallEscalations.get(key)!.timer);
    return key;
  };
  try {
    // The phase finished; its leftover stall is not the lane's state.
    inner.runners.set('demo', run('done', { signal: 'silent', since: S1 }));
    inner.escalateStall(arm());
    assert.deepEqual(urgent, [], 'a finished phase is never escalated');

    // Still running, but a LATER episode: not the stall this timer is about.
    (sv as unknown as { retractStall: (scope: unknown, reason: string) => void })
      .retractStall({ runId: 'run-1', slug: 'demo', phase: 2 }, 'reset');
    inner.runners.set('demo', run('running', { signal: 'silent', since: S2 }));
    inner.escalateStall(arm());
    assert.deepEqual(urgent, [], 'another episode is not this one');

    // Running, the same episode: that is what escalation is for.
    (sv as unknown as { retractStall: (scope: unknown, reason: string) => void })
      .retractStall({ runId: 'run-1', slug: 'demo', phase: 2 }, 'reset');
    inner.runners.set('demo', run('running', { signal: 'silent', since: S1 }));
    inner.escalateStall(arm());
    assert.equal(urgent.length, 1, 'the same stall, still running: escalated once');
  } finally {
    for (const entry of inner.stallEscalations.values()) clearTimeout(entry.timer);
  }
});
