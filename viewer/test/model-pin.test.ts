/**
 * The model a run names is the model it runs (control-tower phase 54, #91).
 *
 * Measured: one unchanged `opus[1m]` ran phases 3, 4, 7 and 8 of this very
 * plan on Opus 5 and every later phase on Opus 5.5, and nothing said so; every
 * phase argv carried `--fallback-model <everything below it>`; a per-model wall
 * restarted a phase one model down; and the ladder's two `escalate: model`
 * rungs moved a phase up. An operator who chose a model had no way to say
 * "this model, or wait". `**Model policy:** pinned` and the `modelPolicy` run
 * setting are that way; `ladder` stays the default.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { newRun, phaseRecord, saveRun, type RunState } from '../server/runner/state.ts';
import { sessionRecordOf } from '../server/runner/session-record.ts';
import { parsePlan } from '../server/parse/plan.ts';
import { modelPolicyFor } from '../server/parse/plan.ts';
import { DEFAULT_MODEL_POLICY, MODEL_POLICIES } from '../shared/run-lifecycle.js';
import { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } from '../shared/run-settings.js';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';

const PINNED = 'claude-opus-5-5[1m]';

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-model-pin-'));
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

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: [], ...partial,
  };
}

function leaveStub(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', throttleUntilMs: null, ...(leaving.kind === 'usage' ? {} : {}) };
}

function runner(r: Repo, spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

/** A session that reports its init frame's model, then finishes the phase. */
function reporting(r: Repo, resolved: (request: SpawnRequest) => string, seen: SpawnRequest[]): SpawnFn {
  return async (request) => {
    seen.push(request);
    request.onEvent?.({ kind: 'init', sessionId: `sess-${seen.length}`, model: resolved(request), tools: 0 } as StreamEvent);
    r.markDone(1);
    return ok({ sessionId: `sess-${seen.length}` });
  };
}

/* ------------------------------------------------------------------ *
 * MP-1 — no `--fallback-model` under `pinned`
 * ------------------------------------------------------------------ */

test('MP-1: a pinned phase is handed no fallback chain; a ladder phase still is', async () => {
  for (const policy of ['pinned', 'ladder'] as const) {
    const r = repo();
    const seen: SpawnRequest[] = [];
    const { instance } = runner(r, reporting(r, () => PINNED, seen));
    try {
      await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: policy });
      await instance.wait();
      assert.equal(seen[0].model, PINNED);
      if (policy === 'pinned') assert.deepEqual(seen[0].fallbackModels ?? [], [], 'no --fallback-model: the CLI cannot demote it in-process');
      else assert.deepEqual(seen[0].fallbackModels, ['sonnet', 'haiku'], 'ladder keeps today\'s behaviour');
    } finally { r.cleanup(); }
  }
});

test('MP-1: the plan\'s `**Model policy:**` pins a run that named none — the plan outranks the run', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance } = runner(r, reporting(r, () => PINNED, seen), {
    phaseDefaults: () => ({ model: PINNED, modelPolicy: 'pinned' }),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, modelPolicy: 'ladder' });
    await instance.wait();
    assert.deepEqual(seen[0].fallbackModels ?? [], []);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * MP-2 — a per-model wall never steps down under `pinned`
 * ------------------------------------------------------------------ */

const OPUS_WALL = ['You\'ve hit your Opus li', 'mit · resets 3pm'].join('');

test('MP-2: a per-model wall under `pinned` switches account on the SAME model and never calls nextModel', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    seen.push(request);
    if (seen.length === 1) return ok({ signal: { subtype: 'error_during_execution', code: 1, text: OPUS_WALL }, costUsd: 0, turns: 1 });
    r.markDone(1);
    return ok();
  };
  const { instance, events } = runner(r, spawn, {
    pickAccount: () => 'spare',
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned', onLimit: 'switch' });
    await instance.wait();
    assert.equal(seen.length, 2);
    assert.equal(seen[1].model, PINNED, 'the same model, on the account that can pay');
    assert.equal(seen[1].env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-spare');
    assert.equal(journalled(events, 'phase.model-switch').length, 0, 'never a step down');
    assert.equal(journalled(events, 'phase.model-held').at(-1)?.why, 'wall');
    assert.equal(instance.current()!.phases['1'].model, PINNED);
  } finally { r.cleanup(); }
});

test('MP-2: with nowhere to switch and no reset to wait for, a pinned wall parks for a person — it never runs a weaker model', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    seen.push(request);
    return ok({ signal: { subtype: 'error_during_execution', code: 1, text: ['You\'ve hit your Opus li', 'mit'].join('') }, costUsd: 0, turns: 1 });
  };
  const { instance, events } = runner(r, spawn, { pickAccount: () => null, leaveAccount: (a, l) => leaveStub(a, l) });
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned', onLimit: 'switch' });
    await instance.wait();
    assert.ok(seen.every((request) => request.model === PINNED), 'every attempt on the pinned model');
    assert.equal(journalled(events, 'phase.model-switch').length, 0);
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'parked');
    assert.match(record.note ?? '', /pinned/);
  } finally { r.cleanup(); }
});

test('MP-2 (control): under `ladder` the same wall steps down one model, as it always did', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    seen.push(request);
    if (seen.length === 1) return ok({ signal: { subtype: 'error_during_execution', code: 1, text: OPUS_WALL }, costUsd: 0, turns: 1 });
    r.markDone(1);
    return ok();
  };
  const { instance, events } = runner(r, spawn, { pickAccount: () => null, leaveAccount: (a, l) => leaveStub(a, l) });
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, onLimit: 'switch' });
    await instance.wait();
    assert.equal(seen[1].model, 'sonnet');
    assert.equal(journalled(events, 'phase.model-switch').length, 1);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * MP-3 — both `escalate: model` rungs board at the SAME model
 * ------------------------------------------------------------------ */

function strandedRun(root: string, policy: 'pinned' | 'ladder'): RunState {
  const state = newRun({ slug: 'demo', root, model: PINNED, effort: 'high', modelPolicy: policy });
  state.status = 'halted';
  state.halt = { at: '2026-09-24T09:00:00.000Z', reason: 'the phase stopped with work in the tree', phase: 1, kind: 'needs-human' };
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.model = PINNED;
  record.effort = 'high';
  record.attempts = 1;
  saveRun(state);
  return state;
}

test('MP-3: "Board fresh, stronger" under `pinned` keeps the model and raises only the effort', async () => {
  for (const policy of ['pinned', 'ladder'] as const) {
    const r = repo();
    const seen: SpawnRequest[] = [];
    const stored = strandedRun(r.root, policy);
    const { instance, events } = runner(r, reporting(r, (request) => request.model ?? '', seen));
    try {
      await instance.start({
        slug: 'demo', root: r.root, resumeRunId: stored.id,
        reboard: [{ phase: 1, situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', escalate: 'model' }],
      });
      await instance.wait();
      if (policy === 'pinned') {
        assert.equal(seen[0].model, PINNED, 'the rung boards at the pinned model');
        assert.equal(seen[0].effort, 'xhigh', 'effort may rise — one step');
        assert.equal(journalled(events, 'phase.model-escalated').length, 0);
        const held = journalled(events, 'phase.model-held').at(-1);
        assert.equal(held?.why, 'rung');
        assert.equal(held?.model, PINNED);
      } else {
        assert.equal(seen[0].model, 'fable', 'ladder: the rung steps up, as it always did');
        assert.equal(journalled(events, 'phase.model-escalated').length, 1);
      }
    } finally { r.cleanup(); }
  }
});

test('MP-3: the other rung, "Fix with a stronger new agent", is a repair session at the phase\'s own model', async () => {
  // It never escalated in code — the repair session spawns at `record.model ??
  // state.model` — and #91 is that it must not start to. Read the call site.
  const source = readFileSync(new URL('../server/runner/runner-control.ts', import.meta.url), 'utf8');
  const repair = source.slice(source.indexOf("this.spawnSession(phase, 'repair'"));
  assert.match(repair.slice(0, 900), /model: record\.model \?\? state\.model,/);
  assert.doesNotMatch(repair.slice(0, 900), /escalateModel|fallbackModels/);
});

/* ------------------------------------------------------------------ *
 * MP-4 — a session the CLI starts on another model is parked, not spent
 * ------------------------------------------------------------------ */

test('MP-4: an init frame that reports another model journals phase.model-mismatch and parks the phase with an errand', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, reporting(r, () => 'claude-opus-6[1m]', seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned' });
    await instance.wait();
    assert.equal(seen.length, 1, 'no second session spends on the wrong model');
    assert.deepEqual(journalled(events, 'phase.model-mismatch').map((line) => [line.requested, line.resolved]),
      [[PINNED, 'claude-opus-6[1m]']]);
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'parked');
    const errand = instance.current()!.recoveries?.['1']?.errand;
    assert.ok(errand, 'the park carries the one ask');
    assert.match(errand!.need, /claude-opus-6\[1m\]/);
  } finally { r.cleanup(); }
});

test('MP-4: a dated id and an alias that resolves to its canonical id are the SAME model — no park', async () => {
  for (const [asked, reported] of [
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    ['opus[1m]', PINNED],
    [PINNED, PINNED],
    // Measured: the CLI reports Fable's 1M session without the suffix.
    ['claude-fable-5-1[1m]', 'claude-fable-5-1'],
    ['fable[1m]', 'claude-fable-5-1'],
  ] as const) {
    const r = repo();
    const seen: SpawnRequest[] = [];
    const { instance, events } = runner(r, reporting(r, () => reported, seen));
    try {
      await instance.start({ slug: 'demo', root: r.root, model: asked, modelPolicy: 'pinned' });
      await instance.wait();
      assert.equal(journalled(events, 'phase.model-mismatch').length, 0, `${asked} → ${reported}`);
      assert.equal(instance.current()!.status, 'finished', `${asked} → ${reported}`);
    } finally { r.cleanup(); }
  }
});

test('MP-4 (control): under `ladder` a different model is recorded, never parked', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, reporting(r, () => 'claude-opus-6[1m]', seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED });
    await instance.wait();
    assert.equal(journalled(events, 'phase.model-mismatch').length, 0);
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * MP-5 — the word, at both doors and in both parsers
 * ------------------------------------------------------------------ */

test('MP-5: `modelPolicy` rides the start AND the settings doors; ladder is the default and the absent state on disk', async () => {
  assert.deepEqual([...MODEL_POLICIES], ['ladder', 'pinned']);
  assert.equal(DEFAULT_MODEL_POLICY, 'ladder');
  assert.ok(RUN_START_FIELDS.includes('modelPolicy'));
  assert.ok(RUN_SETTINGS_FIELDS.includes('modelPolicy'));
  const r = repo();
  const seen: SpawnRequest[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spawn: SpawnFn = async (request) => { seen.push(request); await held; r.markDone(1); return ok(); };
  const { instance } = runner(r, spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned' });
    assert.equal(instance.current()!.modelPolicy, 'pinned');
    instance.configure({ modelPolicy: 'ladder' });
    assert.equal(instance.current()!.modelPolicy, undefined, 'ladder is stored as its absence');
    instance.configure({ modelPolicy: 'pinned' });
    assert.equal(instance.current()!.modelPolicy, 'pinned');
    release();
    await instance.wait();
  } finally { release(); r.cleanup(); }
});

test('MP-5: the JS twin reads `**Model policy:**` as the engine does — the bullet over the line, a typo falling through', () => {
  const plan = parsePlan(readFileSync(new URL('../../tests/fixtures/plans/model-policy.md', import.meta.url), 'utf8'), 'model-policy');
  assert.deepEqual(modelPolicyFor(plan), { value: 'pinned', source: 'plan' });
  assert.deepEqual(modelPolicyFor(plan, 1), { value: 'pinned', source: 'plan' });
  assert.deepEqual(modelPolicyFor(plan, 2), { value: 'ladder', source: 'phase' });
  assert.deepEqual(modelPolicyFor(plan, 3), { value: 'pinned', source: 'plan' }, 'a word that is not a policy falls through');
  assert.deepEqual(modelPolicyFor(plan, 4), { value: 'pinned', source: 'phase' });
});

/* ------------------------------------------------------------------ *
 * MP-6 — the resolved model is a fact the run keeps
 * ------------------------------------------------------------------ */

test('MP-6: every session records the model it asked for AND the one the CLI resolved', () => {
  const record = sessionRecordOf({
    mode: 'phase', request: { prompt: 'x', cwd: '/', model: 'opus[1m]' },
    outcome: { ...ok(), resolvedModel: PINNED },
  });
  assert.equal(record.model, 'opus[1m]');
  assert.equal(record.resolvedModel, PINNED);
});

test('MP-6: the first time one request resolves to a new model within a run, run.model-resolved says so — once', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    seen.push(request);
    // The alias moves between the second and third sessions of the same
    // request — decided HERE, in the session's own order. A test that flipped
    // it from a poll raced the runner, which resumes a capped session at once.
    const answer = seen.length < 3 ? 'claude-opus-5[1m]' : PINNED;
    request.onEvent?.({ kind: 'init', sessionId: `s${seen.length}`, model: answer, tools: 0 } as StreamEvent);
    // A capped session RESUMES at once — the same request, a new session.
    if (seen.length < 3) return ok({ sessionId: `s${seen.length}`, signal: { subtype: 'error_max_turns', code: 1, text: '' } });
    r.markDone(1);
    return ok();
  };
  const { instance, events } = runner(r, spawn);
  try {
    await instance.start({ slug: 'demo', root: r.root, model: 'opus[1m]' });
    await instance.wait();
    const resolved = journalled(events, 'run.model-resolved');
    assert.deepEqual(resolved.map((line) => [line.requested, line.from, line.to]), [
      ['opus[1m]', null, 'claude-opus-5[1m]'],
      ['opus[1m]', 'claude-opus-5[1m]', PINNED],
    ], 'born once, moved once — never a line per session');
    const kept = instance.current()!.resolvedModels?.['opus[1m]'];
    assert.equal(kept?.resolved, PINNED);
    assert.equal(kept?.from, 'claude-opus-5[1m]');
  } finally { r.cleanup(); }
});
