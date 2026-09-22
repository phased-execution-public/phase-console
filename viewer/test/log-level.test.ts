/**
 * Log volume, and the envelope every line now carries.
 *
 * Two jobs meet in `log.ts` and this file pins the seam between them.
 *
 * **Volume is controllable.** A phase that shells three hundred git commands
 * writes three hundred lines nobody wants until the day they do. `debug` is the
 * level those live at, `PHASE_CONSOLE_DEBUG=git,engine,…` is the per-channel
 * opt-in that admits one family without lowering the level for everything, and
 * `PHASE_CONSOLE_LOG_LEVEL` is the floor. The channel opt-in deliberately
 * OUTRANKS the floor: "turn on git debugging" that also required lowering the
 * global level would flood the very log you are reading.
 *
 * **The envelope carries the ids.** They are read from the ambient span at
 * WRITE time rather than passed by every caller, because the call sites are
 * hundreds of lines spread over thirty files and a parameter every one of them
 * had to remember is a parameter most of them would forget.
 *
 * The runtime override has no timer on purpose. A `setTimeout` to revert would
 * hold the event loop open, die with the process that set it, and be untestable
 * without real sleeping; a deadline compared against the clock on each write is
 * none of those things.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LOG_MAX_BYTES,
  type Entry,
  configureLog,
  levelState,
  log,
  revertLevel,
  setLevel,
} from '../server/log.ts';
import { enter, runTraceId } from '../server/trace.ts';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-log-level-'));

/** Point the log at a fresh file, clear every override, and return a reader. */
function fresh(env: { level?: string; debug?: string } = {}): () => Entry[] {
  const file = join(dir, `log-${Math.random().toString(36).slice(2)}.ndjson`);
  revertLevel();
  if (env.level === undefined) delete process.env.PHASE_CONSOLE_LOG_LEVEL;
  else process.env.PHASE_CONSOLE_LOG_LEVEL = env.level;
  if (env.debug === undefined) delete process.env.PHASE_CONSOLE_DEBUG;
  else process.env.PHASE_CONSOLE_DEBUG = env.debug;
  configureLog(file);
  return () => {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { return []; }
    return raw.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry);
  };
}

test.after(() => {
  revertLevel();
  delete process.env.PHASE_CONSOLE_LOG_LEVEL;
  delete process.env.PHASE_CONSOLE_DEBUG;
  configureLog(null);
  rmSync(dir, { recursive: true, force: true });
});

test('the default level is info, so debug lines cost nothing until asked for', () => {
  const read = fresh();

  log.debug('git.command', { argv: ['status'] });
  log.info('start', {});
  log.warn('journal.full', {});
  log.error('exit', {});

  assert.deepEqual(read().map((e) => e.event), ['start', 'journal.full', 'exit']);
  assert.equal(levelState().level, 'info');
});

test('PHASE_CONSOLE_LOG_LEVEL=warn drops info (and debug with it)', () => {
  const read = fresh({ level: 'warn' });

  log.debug('git.command', {});
  log.info('start', {});
  log.warn('journal.full', {});
  log.error('exit', {});

  assert.deepEqual(read().map((e) => e.event), ['journal.full', 'exit']);
});

test('PHASE_CONSOLE_DEBUG=git admits git.* at debug — and nothing else', () => {
  const read = fresh({ debug: 'git' });

  log.debug('git.command', { argv: ['status'] });
  log.debug('engine.command', {});
  log.debug('http.request', {});

  assert.deepEqual(read().map((e) => e.event), ['git.command']);
  assert.equal(log.enabled('git'), true);
  assert.equal(log.enabled('engine'), false);
});

test('the channel opt-in outranks the level floor, which is the point of having both', () => {
  const read = fresh({ level: 'warn', debug: 'git' });

  log.debug('git.command', {});
  log.info('start', {});

  assert.deepEqual(
    read().map((e) => e.event),
    ['git.command'],
    'the git channel was asked for explicitly; info was not',
  );
});

test('PHASE_CONSOLE_DEBUG takes a list, and * admits every channel', () => {
  const list = fresh({ debug: 'git,engine' });
  log.debug('git.command', {});
  log.debug('engine.command', {});
  log.debug('shell.command', {});
  assert.deepEqual(list().map((e) => e.event), ['git.command', 'engine.command']);

  const all = fresh({ debug: '*' });
  log.debug('git.command', {});
  log.debug('shell.command', {});
  assert.deepEqual(all().map((e) => e.event), ['git.command', 'shell.command']);
  assert.equal(log.enabled('anything-at-all'), true);
});

test('every line is envelope v2 and carries the ambient span', () => {
  const read = fresh();
  const traceId = runTraceId('inst', 'slug', 'run-a');

  enter({ traceId, name: 'phase.attempt', phase: 5, attempt: 2, sessionId: 'sess-x', actor: 'console/autopilot' }, () => {
    log.info('run.started', { note: 'inside' });
  });
  log.info('run.finished', { note: 'outside' });

  const [inside, outside] = read();

  assert.equal(inside.v, 2);
  assert.equal(inside.traceId, traceId);
  assert.match(String(inside.spanId), /^[0-9a-f]{16}$/);
  assert.equal(inside.phase, 5);
  assert.equal(inside.attempt, 2);
  assert.equal(inside.sessionId, 'sess-x');
  assert.equal(inside.actor, 'console/autopilot');
  assert.deepEqual(inside.data, { note: 'inside' });

  assert.equal(outside.v, 2, 'v2 is the envelope, not a property of being traced');
  assert.equal(outside.traceId, undefined, 'a line outside every span claims no trace');
  assert.equal(outside.spanId, undefined);
  assert.equal(
    Object.hasOwn(outside, 'phase'),
    false,
    'and absent ids are ABSENT, not null — a reader must not have to tell those apart',
  );
});

test('the ids are read at write time, so a caller never has to pass them', () => {
  const read = fresh();
  const outer = runTraceId('i', 's', 'outer');
  const inner = runTraceId('i', 's', 'inner');

  enter({ traceId: outer, name: 'a' }, () => {
    log.info('start', {});
    enter({ traceId: inner, name: 'b' }, () => log.info('start', {}));
    log.info('start', {});
  });

  assert.deepEqual(read().map((e) => e.traceId), [outer, inner, outer]);
});

test('setLevel flips, and the deadline reverts it on a clock we control', () => {
  const read = fresh();

  const state = setLevel({ level: 'debug', ttlMs: 60_000 }, 1_000);
  assert.equal(state.level, 'debug');
  assert.equal(state.source, 'override');
  assert.equal(state.until, 61_000);

  assert.equal(levelState(30_000).level, 'debug', 'inside the window');
  assert.equal(levelState(61_001).level, 'info', 'past it, the env answers again');
  assert.equal(levelState(61_001).source, 'env');

  // And the write path honours the same deadline, not just the reader.
  setLevel({ level: 'debug', ttlMs: 0 }, 1_000);
  log.debug('git.command', {});
  assert.deepEqual(read().map((e) => e.event), [], 'an already-expired override admits nothing');
});

test('setLevel can turn a debug channel on by itself, and revertLevel puts it back', () => {
  const read = fresh();

  // The real clock here, not an injected one: the write path reads `Date.now()`,
  // so an override stamped at t=1000 would already have lapsed by the time the
  // line is written — which the previous test pins deliberately.
  setLevel({ debug: 'engine', ttlMs: 60_000 });
  log.debug('engine.command', {});
  log.debug('git.command', {});
  assert.deepEqual(read().map((e) => e.event), ['engine.command']);

  revertLevel();
  assert.equal(levelState().source, 'env');
  log.debug('engine.command', {});
  assert.deepEqual(read().map((e) => e.event), ['engine.command'], 'nothing new after the revert');
});

test('setLevel refuses a level that is not one', () => {
  fresh();
  assert.throws(() => setLevel({ level: 'chatty' as never, ttlMs: 1000 }), /chatty/);
  assert.equal(levelState().source, 'env', 'and a refused call changes nothing');
});

test('the rotation cap is 16 MB — a traced console writes more than an untraced one did', () => {
  assert.equal(LOG_MAX_BYTES, 16 * 1024 * 1024);
});
