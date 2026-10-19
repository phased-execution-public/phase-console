/**
 * The spawn watchdog waits on a permission card, not past it (one-pool phase
 * 24, #220).
 *
 * ai-builder-v7 P26 (hub, a84ae470d859), 2026-10-04: a session blocked on one
 * of the console's own tool cards — a `git push` it raised at 09:55:45Z, due to
 * auto-deny at 10:55:25Z — was killed at 10:50:45Z as "silent for 55 min after
 * it started and before its first result". Two of the console's clocks
 * disagreed: a tool card holds the hook for up to 59 min 40 s
 * (`ANSWER_BY_MS`), the init→result bound fires at 55 min
 * (`SPAWN_INIT_IDLE_MS`). The dead session's card then timed out with nobody
 * to answer and parked the run while the phase's next attempt worked; on the
 * second sighting it halted the run.
 *
 *   SW-1  while a tool card holds the session's hook, neither silence clock
 *         ends it; the card decided, the bound measures from that moment;
 *   SW-2  two cards are two holds — the first decided does not release the second;
 *   SW-3  a session that ends takes its tool cards with it (`session ended`),
 *         and leaves a standing offer, another phase's card and another run's alone;
 *   SW-4  the bound is still the last clock: a card's own deadline is inside it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { spawnClaude } = await import('../server/runner/spawn.ts');
const { Approvals, HOOK_TIMEOUT_SECONDS } = await import('../server/runner/approvals.ts');
/** How long a tool card holds a hook (`approvals.ts`'s own `ANSWER_BY_MS`). */
const ANSWER_BY_MS = (HOOK_TIMEOUT_SECONDS - 20) * 1000;
const { SPAWN_INIT_IDLE_MS } = await import('../shared/attention-model.js');
import type { SpawnHandle, StreamEvent } from '../server/runner/spawn.ts';

/** Initialised, one tool call out, then nothing: a hook held open on a card. */
const STUB = `#!/usr/bin/env node
'use strict';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant', content: [
  { type: 'tool_use', id: 'toolu_push', name: 'Bash', input: { command: 'git push origin pe/demo' } }] } });
process.stdin.resume();
setInterval(() => {}, 1000);
`;

function bench(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-watchdog-'));
  writeFileSync(join(dir, 'claude'), STUB, 'utf8');
  chmodSync(join(dir, 'claude'), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function held(script: (handle: SpawnHandle, ended: () => boolean) => Promise<void>) {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let done = false;
  const started = Date.now();
  const spawned = spawnClaude({
    prompt: 'BOOT phase 26', cwd: b.dir, env: b.env, idleCloseMs: 0, initIdleMs: 400,
    onHandle: (h) => { handle = h; h.holdForCard?.('mutnb14q-113', true); },
    onEvent: (event) => events.push(event),
  }).then((outcome) => { done = true; return outcome; });
  try {
    await sleep(150);
    await script(handle!, () => done);
    const outcome = await spawned;
    return { outcome, events, ms: Date.now() - started };
  } finally {
    b.cleanup();
  }
}

test('SW-1: a card holds the init→result bound; decided, the bound measures from the decision (#220)', async () => {
  let releasedAt = 0;
  const { outcome, ms } = await held(async (handle, ended) => {
    await sleep(1_200); // three bounds' worth of silence, on a card
    assert.equal(ended(), false, 'the watchdog did not end a session waiting on a person');
    releasedAt = Date.now();
    handle.holdForCard?.('mutnb14q-113', false);
  });
  assert.equal(outcome.endedBy, 'spawn-watchdog', 'released, the bound ends a session that stays silent');
  assert.ok(ms >= 1_200 + 400 - 50, `ended ${ms} ms in — not before the card was decided`);
  assert.ok(Date.now() - releasedAt >= 350, 'measured from the decision, not from the session’s start');
});

test('SW-2: two cards are two holds', async () => {
  const { outcome } = await held(async (handle, ended) => {
    handle.holdForCard?.('second-card', true);
    handle.holdForCard?.('mutnb14q-113', false);
    await sleep(900);
    assert.equal(ended(), false, 'the second card still holds it');
    handle.holdForCard?.('second-card', false);
  });
  assert.equal(outcome.endedBy, 'spawn-watchdog');
});

test('SW-3: a session that ends takes its own tool cards with it — never a standing offer, another phase or another run', async () => {
  const approvals = new Approvals();
  approvals.arm('run-1');
  approvals.arm('run-2');
  const card = (over: Record<string, unknown>) => approvals.request({
    runId: 'run-1', slug: 'demo', phase: 26, kind: 'tool', title: 'Bash: git push', detail: 'd', evidence: [],
    tool: { name: 'Bash', input: { command: 'git push origin pe/demo' } }, ...over,
  } as never);
  const mine = card({});
  const sibling = card({ phase: 27 });
  const otherRun = card({ runId: 'run-2' });
  const standing = card({ standing: true });

  assert.deepEqual(approvals.retireSession('run-1', 26), [mine.approval.id]);
  const settled = await mine.decided;
  assert.equal(settled.decision, 'deny');
  assert.equal(settled.by, 'session ended', 'not `timeout`: nothing parks the run on it');
  const left = approvals.pending().map((a) => a.id).sort();
  assert.deepEqual(left, [sibling.approval.id, otherRun.approval.id, standing.approval.id].sort());
  approvals.disarm();
});

test('SW-4: the init→result bound is the last clock — a tool card’s own deadline is inside it, or the card is held', () => {
  // The card decides first by its own clock, or the hold above keeps the
  // watchdog off it: either way no session dies with a card standing.
  assert.ok(ANSWER_BY_MS > 0 && SPAWN_INIT_IDLE_MS > 0);
  assert.ok(ANSWER_BY_MS > SPAWN_INIT_IDLE_MS, 'the numbers that made #220 possible — which is why the hold exists');
});
