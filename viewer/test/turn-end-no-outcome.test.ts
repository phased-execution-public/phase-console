/**
 * A turn that ends with a `result` closes the session's input — even when a
 * message the console wrote mid-turn was folded into that turn without an echo
 * (one-pool phase 24, #259).
 *
 * The close rule waits for every tagged operator message to be echoed back
 * (`unecho`). Three sightings showed a message that never is: a steer written
 * while the session was mid-turn — the console's own 60 % wrap-up notice, a
 * watchdog steer — is READ, answered by the turn, and never replayed as a user
 * line. Its tag stayed in `unecho`, so no later `result` could close stdin, and
 * every such turn end cost its lane the idle closer's ten minutes:
 *
 *   ai-builder-v8 P31 (hub, 2026-10-07)          9.5 min idle after "Phase 31 is done"
 *   control-tower P134 (pe-hub, 2026-10-07)      a watchdog steer answered, never echoed
 *   quiet-console P5 / P17 (pe-hub, 2026-10-09/10)  the wrap-up steer, 10 min each
 *
 * The measured CLI says what it did with them: the turn's `result` carries
 * `queued_turn_count`, and `0` means nothing written before it is still
 * waiting. Those tags are drained, and stdin closes at the turn's end — the
 * runner's exit path then reads the outcome file, or its absence.
 *
 *   TE-1  a steer folded into the turn, then `result {queued_turn_count: 0}`:
 *         stdin closes `turn-end` at once, not at the idle closer;
 *   TE-2  `queued_turn_count: 1`: the CLI still holds the message as a turn, so
 *         its tag stays — the input waits for that turn (here, the idle close);
 *   TE-3  a message written AFTER the result was printed is not drained by it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { spawnClaude, markFor, FOLDED_MARK_GRACE_MS } = await import('../server/runner/spawn.ts');
const { frameSteer } = await import('../server/runner/runner-core.ts');
import type { SpawnHandle, StreamEvent } from '../server/runner/spawn.ts';

/**
 * A `claude` that answers its boot turn after `PC_RESULT_AFTER_MS`, reads (and
 * never echoes) whatever arrives meanwhile, and reports `PC_QUEUED` as the
 * result's `queued_turn_count`. It ends when its input does.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
let lines = 0;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    lines += 1;
    if (lines !== 1) continue;
    setTimeout(() => {
      say({ type: 'assistant', session_id: sid, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Phase 31 is done: every Verification line passed.' }] } });
      say({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 4, total_cost_usd: 0.01,
            queued_turn_count: Number(process.env.PC_QUEUED || 0), session_id: sid, result: 'done' });
    }, Number(process.env.PC_RESULT_AFTER_MS || 800));
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function bench(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-turn-end-'));
  writeFileSync(join(dir, 'claude'), STUB, 'utf8');
  chmodSync(join(dir, 'claude'), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const steer = (id: string) => frameSteer('your context is 601k tokens of a 1M window (60 %) — wrap up now', markFor('steer', id));

async function session(opts: { queued: number; idleCloseMs: number; sendAt: 'mid-turn' | 'after-result' }) {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  const started = Date.now();
  try {
    await spawnClaude({
      prompt: 'BOOT phase 31',
      cwd: b.dir,
      env: { ...b.env, PC_QUEUED: String(opts.queued), PC_RESULT_AFTER_MS: String(FOLDED_MARK_GRACE_MS + 600) },
      idleCloseMs: opts.idleCloseMs,
      onHandle: (h) => {
        handle = h;
        if (opts.sendAt === 'mid-turn') setTimeout(() => handle!.send(steer('d38ec662')), 50);
      },
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'result' && opts.sendAt === 'after-result') handle!.send(steer('bf454714'));
      },
    });
  } finally {
    b.cleanup();
  }
  const closed = events.find((e) => e.kind === 'input-closed') as { cause: string } | undefined;
  return { cause: closed?.cause ?? null, ms: Date.now() - started };
}

test('TE-1: a steer folded into the turn does not hold the input open — the result closes it at once (#259)', async () => {
  const { cause, ms } = await session({ queued: 0, idleCloseMs: 60_000, sendAt: 'mid-turn' });
  assert.equal(cause, 'turn-end', 'closed by the turn’s end, not the idle closer');
  assert.ok(ms < 20_000, `closed in ${ms} ms — the idle closer would have waited a minute`);
});

test('TE-2: a message the CLI still holds queued keeps its tag — the input waits for that turn', async () => {
  const { cause } = await session({ queued: 1, idleCloseMs: 400, sendAt: 'mid-turn' });
  assert.equal(cause, 'idle', 'nothing drained: only the idle closer ends it here');
});

test('TE-3: a message written after the result was printed is not drained by that result', async () => {
  const { cause } = await session({ queued: 0, idleCloseMs: 400, sendAt: 'after-result' });
  assert.equal(cause, 'idle');
});
