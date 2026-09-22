/**
 * The carriers — how a child process learns which trace it belongs to.
 *
 * The console's evidence is only half the story. The other half is written by
 * things the console starts and then lets go of: a `claude -p` session that
 * runs for two hours and writes its own task list, outcome and lock; the bash
 * engine; the `sh -c` a worktree's setup command is. None of them can be
 * correlated after the fact — a lock file and a journal line have nothing in
 * common but a timestamp — so the id has to travel WITH them, in the
 * environment, at the moment they are started.
 *
 * Four keys, and the same four everywhere: `TRACEPARENT` (the w3c header, for
 * anything that already speaks it), `PE_TRACE_ID` and `PE_SPAN_ID` (what the
 * bash scripts read, because parsing a traceparent in bash 3.2 is not a thing
 * anyone should have to do), and `GIT_TRACE2_PARENT_SID` (git's own).
 *
 * The test that matters most here is the NEGATIVE one. A console started from
 * a shell exporting `TRACEPARENT` — a CI runner, another tracing tool, a
 * developer who ran something else first — must not hand that stranger's id to
 * its children, because the evidence would then join a trace that has nothing
 * to do with this run and the join would look perfectly valid.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { scriptEnv } from '../server/engine.ts';
import { childEnv } from '../server/runner/errors.ts';
import { enter, parseTraceparent, runTraceId } from '../server/trace.ts';

const KEYS = ['TRACEPARENT', 'PE_TRACE_ID', 'PE_SPAN_ID', 'GIT_TRACE2_PARENT_SID'] as const;

/** Really spawn a child and ask it what it can see. */
function readEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string | undefined>> {
  return new Promise((resolve) => {
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(
      Object.fromEntries(KEYS.map((k) => [k, k])),
    ).replace(/"(\w+)":"(\w+)"/g, '"$1":process.env.$2 ?? null')}))`;
    const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(out) as Record<string, string | undefined>); } catch { resolve({}); }
    });
  });
}

test('childEnv inside a span hands a REAL child all four keys', async () => {
  const traceId = runTraceId('inst', 'slug', 'run-child');

  const { seen, spanId } = await enter({ traceId, name: 'phase.spawn', phase: 5 }, async () => {
    const env = childEnv();
    // Read the span the same way the carrier did, so the assertion below is
    // about the child rather than about our own bookkeeping.
    const spanId = parseTraceparent(String(env.TRACEPARENT))?.spanId;
    return { seen: await readEnv(env), spanId };
  });

  assert.equal(seen.PE_TRACE_ID, traceId, 'the session can read the run it belongs to');
  assert.equal(seen.PE_SPAN_ID, spanId);
  assert.equal(seen.TRACEPARENT, `00-${traceId}-${spanId}-01`);
  assert.equal(seen.GIT_TRACE2_PARENT_SID, `pc-${traceId}-${spanId}`);
});

test('childEnv keeps every decision it already carried', () => {
  const env = enter({ traceId: runTraceId('i', 's', 'r'), name: 'x' }, () => childEnv());
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, '1', 'the watchdog is not a casualty of the carrier');
  assert.ok('CLAUDE_CODE_MAX_RETRIES' in env);
});

test('OUTSIDE a span, childEnv DELETES an inherited TRACEPARENT rather than passing it on', async () => {
  const stranger = { ...process.env, TRACEPARENT: `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01` };
  const seen = await readEnv(childEnv(stranger));

  assert.equal(seen.TRACEPARENT, null, "a stranger's trace must not become this console's children's");
  assert.equal(seen.PE_TRACE_ID, null);
});

test('scriptEnv carries the four keys THROUGH the denial filter', () => {
  const opts = { root: '/tmp/root', scriptsDir: '/tmp/scripts' };
  const traceId = runTraceId('inst', 'slug', 'run-script');

  const inside = enter({ traceId, name: 'engine.call' }, () => scriptEnv(opts));

  // `NEVER_INHERIT` drops every inherited `PE_*`, which is exactly right for an
  // inherited one — and exactly wrong for the two this console is deliberately
  // stating. They are spread AFTER the filter for that reason.
  assert.equal(inside.PE_TRACE_ID, traceId);
  assert.match(String(inside.PE_SPAN_ID), /^[0-9a-f]{16}$/);
  assert.equal(inside.TRACEPARENT, `00-${traceId}-${inside.PE_SPAN_ID}-01`);
  assert.equal(inside.DOCS_ROOT, opts.root, 'and everything the engine already needed is untouched');

  const outside = scriptEnv(opts);
  for (const key of KEYS) assert.equal(outside[key], undefined, `${key} is stated-as-undefined outside a span`);
});

test('an inherited PE_TRACE_ID is still dropped — the filter is not weakened, only followed', () => {
  const opts = { root: '/tmp/root', scriptsDir: '/tmp/scripts' };
  const before = process.env.PE_TRACE_ID;
  process.env.PE_TRACE_ID = 'inherited-from-somewhere-else';
  try {
    assert.equal(scriptEnv(opts).PE_TRACE_ID, undefined,
      'outside a span the console states no trace, whatever its own environment says');
  } finally {
    if (before === undefined) delete process.env.PE_TRACE_ID; else process.env.PE_TRACE_ID = before;
  }
});

test('the engine cache key does not see the carrier, so two spans share one cached answer', async () => {
  const engine = await import('../server/engine.ts');
  const opts = { root: '/tmp/root', scriptsDir: '/tmp/scripts' };

  // The key is built in `run()` from script, slug, revision, args and root —
  // never from the env — which is what lets the SAME engine answer serve two
  // phases of one drive. A carrier folded into the key would make every call a
  // cache miss, and the engine is the console's hottest subprocess by far.
  const source = (await import('node:fs')).readFileSync(
    new URL('../server/engine.ts', import.meta.url), 'utf8',
  );
  const keyBlock = source.slice(source.indexOf('const key ='), source.indexOf('const key =') + 600);
  for (const key of KEYS) {
    assert.doesNotMatch(keyBlock, new RegExp(key), `${key} must not enter the cache key`);
  }
  assert.equal(typeof engine.scriptEnv, 'function');
});
