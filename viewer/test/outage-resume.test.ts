/**
 * After an outage the attempt loop waits on a probe, reads the board, and
 * resumes the session it had (control-tower phase 80, #108).
 *
 * Measured on hub 4123, 2026-09-24 22:56Z → 2026-09-25 00:08Z: observability-plane
 * P21 committed its handoff `complete`, and a minute later the machine lost the
 * API. The lane waited out a clock (1 · 2 · 5 · 10 · 15 · 15 · 15 minutes) with
 * no probe, so the API was back long before anything noticed; then it booted a
 * brand-new session with the full "start Phase 21" prompt over a finished
 * phase, which re-claimed the lock and reset the task list. The attempt record
 * kept the transport error as the phase's last word.
 *
 * OR-1: a connectivity ending waits on phase 76's probe (`ConnectivityProbe`),
 * a look a minute, and boards again at the first look that finds the API
 * answering; the old series is only the backstop.
 * OR-2: before boarding again the loop reads the board — a phase whose handoff
 * is complete is closed out (its §Verification runs), and no session boots.
 * OR-3: otherwise the SAME session is resumed, with a continuation rather than
 * a start boot; a session that never reached the API boards fresh as before.
 * OR-4: the record keeps the session's last words, not the transport error.
 *
 * ⚠️ Matched strings are built by CONCATENATION. This file's own text reaches
 * the classifier when a session reads it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { ConnectivityProbe, CONNECTIVITY_PROBE_MS } from '../server/connectivity-probe.ts';
import { CONNECTIVITY_BACKOFF_MS } from '../server/runner/errors.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-outage-resume-'));
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

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** The CLI's line for a connection it could not make, assembled. */
const CANNOT_REACH = `API Err${'or'}: Unable to conn${'ect'} to API: getaddrinfo `
  + `${['ENOT', 'FOUND'].join('')} api.anthropic.com`;

/** What the session wrote last, before the network went. */
const LAST_WORDS = 'The parser is in and its tests pass; running the full suite next.';

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-A', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: [], injected: 0, ...partial,
  };
}

/** A session that worked, then lost the API: the CLI's error is its result, its prose came before. */
function lostApi(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return ok({
    signal: { subtype: 'error_during_execution', code: 1, isError: true, text: CANNOT_REACH, turns: 12, costUsd: 1.4 },
    resultText: CANNOT_REACH, costUsd: 1.4, turns: 12, lastText: LAST_WORDS, ...partial,
  });
}

/** A probe whose looks answer from a script, each armed after the interval it was given. */
function scriptedProbe(answers: boolean[]): { probe: ConnectivityProbe; looks: number[]; asked: () => number } {
  const looks: number[] = [];
  let asked = 0;
  const probe = new ConnectivityProbe({
    probe: async () => { asked += 1; return answers.shift() ?? true; },
    schedule: (fn, ms) => { looks.push(ms); const timer = setTimeout(fn, 5); return () => clearTimeout(timer); },
  });
  return { probe, looks, asked: () => asked };
}

function harness(r: Repo, spawn: SpawnFn, probe: ConnectivityProbe) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    connectivity: probe,
  });
  return { instance, events };
}

test('OR-1: an outage is waited on the probe, not the clock — the lane boards again at the first look that finds the API answering', async () => {
  const r = repo();
  const { probe, looks, asked } = scriptedProbe([false, false, true]);
  let calls = 0;
  const { instance, events } = harness(r, async () => {
    calls += 1;
    if (calls === 1) return lostApi();
    r.markDone(1);
    return ok();
  }, probe);
  const began = Date.now();
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();
  const elapsed = Date.now() - began;

  assert.equal(calls, 2, 'it came back and finished the phase');
  assert.equal(instance.current()!.phases['1'].status, 'done');
  assert.equal(asked(), 3, 'three looks: down, down, answering');
  assert.deepEqual(looks, [CONNECTIVITY_PROBE_MS, CONNECTIVITY_PROBE_MS, CONNECTIVITY_PROBE_MS],
    'a look a minute — so the lane is back within about a minute of the API');
  assert.ok(elapsed < 30_000, `the backstop clock was not waited out (${elapsed} ms)`);
  const waits = journalled(events, 'phase.connectivity-wait');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].probeEveryMs, CONNECTIVITY_PROBE_MS, 'the wait names the probe cadence it runs on');
  assert.equal(waits[0].waitMs, CONNECTIVITY_BACKOFF_MS[0], 'the old series stays, as the latest the lane waits');
  const restored = journalled(events, 'phase.connectivity-restored');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].by, 'probe', 'the probe ended the wait, not the clock');
  assert.equal(instance.current()!.consecutiveFailures, 0, 'the weather is still not a failed plan');
  probe.stop();
  r.cleanup();
});

test('OR-2: a phase whose handoff is complete when the API comes back is closed out — its §Verification runs and no session boots', async () => {
  const r = repo();
  const { probe } = scriptedProbe([true]);
  const prompts: string[] = [];
  const { instance, events } = harness(r, async (request: SpawnRequest) => {
    prompts.push(request.prompt);
    if (prompts.length === 1) {
      // P21's shape: the handoff went in complete, then the network went.
      r.markDone(1);
      return lostApi({ turns: 60 });
    }
    return ok();
  }, probe);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.equal(prompts.length, 1, 'nothing boots again — no start prompt, no resume');
  const record = instance.current()!.phases['1'];
  assert.equal(record.status, 'done', 'closed out, through the same checks a clean ending gets');
  assert.equal(journalled(events, 'phase.done').length, 1);
  const restored = journalled(events, 'phase.connectivity-restored');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].next, 'closeout', 'the board read done, so the closeout ran');
  probe.stop();
  r.cleanup();
});

test('OR-3: otherwise the SAME session is resumed — with a continuation, never the start boot', async () => {
  const r = repo();
  const { probe } = scriptedProbe([true]);
  const asked: SpawnRequest[] = [];
  const { instance, events } = harness(r, async (request) => {
    asked.push(request);
    if (asked.length === 1) return lostApi({ sessionId: 'sess-A' });
    r.markDone(1);
    return ok({ sessionId: 'sess-A' });
  }, probe);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.equal(asked.length, 2);
  assert.equal(asked[0].resume, undefined, 'the first boarding is a fresh session');
  assert.equal(asked[1].resume, 'sess-A', 'the session that lost the API is the one resumed');
  assert.doesNotMatch(asked[1].prompt, /BOOT phase/, 'no start boot into a session that was mid-phase');
  assert.match(asked[1].prompt, /same session/i, 'it is told it is resumed, and to carry on');
  assert.equal(instance.current()!.phases['1'].status, 'done');
  const restored = journalled(events, 'phase.connectivity-restored');
  assert.equal(restored[0].next, 'resume');
  assert.equal(restored[0].session, 'sess-A');
  probe.stop();
  r.cleanup();
});

test('OR-3: a session that never reached the API has nothing to resume — it boards fresh, as it always did', async () => {
  const r = repo();
  const { probe } = scriptedProbe([true]);
  const asked: SpawnRequest[] = [];
  const { instance, events } = harness(r, async (request) => {
    asked.push(request);
    if (asked.length === 1) return lostApi({ turns: 0, costUsd: 0, lastText: undefined, signal: { subtype: 'error_during_execution', code: 1, text: CANNOT_REACH } });
    r.markDone(1);
    return ok();
  }, probe);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.equal(asked.length, 2);
  assert.equal(asked[1].resume, undefined);
  assert.match(asked[1].prompt, /BOOT phase 1/, 'the boot prompt is self-contained, and nothing was lost');
  assert.equal(journalled(events, 'phase.connectivity-restored')[0].next, 'fresh');
  probe.stop();
  r.cleanup();
});

test('OR-4: the record keeps the session\'s last words, not the transport error — on the phase and on its session line', async () => {
  const r = repo();
  const { probe } = scriptedProbe([true]);
  let saidAtRelaunch: string | undefined;
  let calls = 0;
  let instance!: Runner;
  const built = harness(r, async () => {
    calls += 1;
    if (calls === 1) return lostApi();
    saidAtRelaunch = instance.current()!.phases['1'].said;
    r.markDone(1);
    return ok({ resultText: 'Phase 1 is complete.' });
  }, probe);
  instance = built.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.equal(saidAtRelaunch, LAST_WORDS, 'what the session said, not what the network did');
  const sessions = journalled(built.events, 'phase.session');
  assert.equal(sessions[0].said, LAST_WORDS, 'the attempt\'s own line is remembered by its words');
  assert.match(String(sessions[0].transportError ?? ''), /Unable to conn/, 'and the transport error is kept beside them, named');
  assert.equal(sessions[1].said, 'Phase 1 is complete.', 'a session that ended normally is remembered by its result, as before');
  assert.equal(sessions[1].transportError, undefined);
  probe.stop();
  r.cleanup();
});
