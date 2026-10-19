/**
 * A pinned model is checked on every assistant frame, not only at init (one-pool phase 4, #281).
 *
 * Measured: control-tower phase 107's third attempt was spawned on
 * `claude-opus-5-5[1m]` with no fallback chain; its transcript holds 156
 * assistant messages on claude-opus-5-5 and then 130 on claude-opus-4-8, and the
 * pinned policy only noticed 34 minutes later, when a steer opened a new turn and
 * with it a fresh init frame. The init frame says what a session STARTED on; each
 * assistant frame's `message.model` says what that turn RAN on. The same rule now
 * reads both: under `pinned` the first frame on another model checkpoints the
 * session and parks the phase with the frame quoted, under `ladder` it is recorded.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

import { Runner } from '../server/runner/runner.ts';
import { spawnClaude, type SpawnFn, type SpawnOutcome, type SpawnRequest, type StreamEvent } from '../server/runner/spawn.ts';

const PINNED = 'claude-opus-5-5[1m]';

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-frame-pin-'));
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

function runner(r: Repo, spawn: SpawnFn) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

/** A session that starts on the pinned model, then names `frames` on its assistant turns. */
function framing(r: Repo, frames: { model: string; messageId?: string }[], seen: SpawnRequest[]): SpawnFn {
  return async (request) => {
    seen.push(request);
    request.onEvent?.({ kind: 'init', sessionId: `sess-${seen.length}`, model: PINNED, tools: 0 } as StreamEvent);
    for (const frame of frames) request.onEvent?.({ kind: 'model', ...frame } as StreamEvent);
    r.markDone(1);
    return ok({ sessionId: `sess-${seen.length}` });
  };
}

test('#281: a pinned session whose assistant frame runs on another model is parked, the frame quoted', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, framing(r, [
    { model: 'claude-opus-5-5', messageId: 'msg_0001' },
    { model: 'claude-opus-4-8', messageId: 'msg_0157' },
  ], seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned' });
    await instance.wait();
    assert.equal(seen.length, 1, 'no second session spends on the wrong model');
    const mismatch = journalled(events, 'phase.model-mismatch');
    assert.equal(mismatch.length, 1, 'the frame on its own base model is the same model; the fallback is the one finding');
    assert.equal(mismatch[0].requested, PINNED);
    assert.equal(mismatch[0].resolved, 'claude-opus-4-8');
    assert.deepEqual(mismatch[0].frame, { kind: 'assistant', model: 'claude-opus-4-8', messageId: 'msg_0157' });
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'parked');
    assert.equal(record.modelMismatch?.frame?.messageId, 'msg_0157');
    assert.match(record.note ?? '', /assistant message msg_0157 ran on "claude-opus-4-8"/);
    const errand = instance.current()!.recoveries?.['1']?.errand;
    assert.ok(errand, 'the park carries the one ask');
    assert.match(errand!.need, /msg_0157.*claude-opus-4-8.*fallback inside the session/);
  } finally { r.cleanup(); }
});

test('#281: frames on the pinned model — its base id, an alias the init named — never park', async () => {
  for (const frames of [
    [{ model: 'claude-opus-5-5', messageId: 'a' }],
    [{ model: 'claude-opus-5-5[1m]' }, { model: 'claude-opus-5-5' }],
  ]) {
    const r = repo();
    const seen: SpawnRequest[] = [];
    const { instance, events } = runner(r, framing(r, frames, seen));
    try {
      await instance.start({ slug: 'demo', root: r.root, model: 'opus[1m]', modelPolicy: 'pinned' });
      await instance.wait();
      assert.equal(journalled(events, 'phase.model-mismatch').length, 0, JSON.stringify(frames));
      assert.equal(journalled(events, 'phase.model-differs').length, 0, JSON.stringify(frames));
      assert.equal(instance.current()!.status, 'finished');
    } finally { r.cleanup(); }
  }
});

test('#281 (control): under `ladder` a fallback frame is recorded with the frame, never parked', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, framing(r, [{ model: 'claude-opus-4-8', messageId: 'msg_9' }], seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED });
    await instance.wait();
    assert.equal(journalled(events, 'phase.model-mismatch').length, 0);
    const differs = journalled(events, 'phase.model-differs');
    assert.equal(differs.length, 1);
    assert.deepEqual(differs[0].frame, { kind: 'assistant', model: 'claude-opus-4-8', messageId: 'msg_9' });
    assert.equal(instance.current()!.phases['1'].actualModel, 'claude-opus-4-8');
    assert.equal(instance.current()!.status, 'finished');
  } finally { r.cleanup(); }
});

/* The stream half: the REAL parser against a `claude` that is not claude. */

const STUB = `#!/usr/bin/env node
'use strict';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';
say({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5[1m]', tools: [] });
const turn = (id, model, extra) => say(Object.assign({ type: 'assistant', session_id: sid,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'working' }] } }, extra || {}));
turn('msg_1', 'claude-opus-5-5');
turn('msg_2', 'claude-opus-5-5');
turn('msg_3', 'claude-haiku-4-5', { parent_tool_use_id: 'toolu_1' });
turn('msg_4', '<synthetic>', { is_api_error_message: true });
turn('msg_5', 'claude-opus-4-8');
say({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0.01, num_turns: 1, result: 'done', is_error: false });
process.exit(0);
`;

test('#281: the stream names each new model of the session\'s OWN frames — never a subagent\'s, never a synthetic line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-frame-stub-'));
  try {
    const bin = join(dir, 'claude');
    writeFileSync(bin, STUB, 'utf8');
    chmodSync(bin, 0o755);
    const models: { model: string; messageId?: string }[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      onEvent: (event) => { if (event.kind === 'model') models.push({ model: event.model, messageId: event.messageId }); },
    });
    assert.deepEqual(models, [
      { model: 'claude-opus-5-5', messageId: 'msg_1' },
      { model: 'claude-opus-4-8', messageId: 'msg_5' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
