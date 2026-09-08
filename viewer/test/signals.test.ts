/**
 * The one signal ladder — `server/runner/signals.ts`.
 *
 * The rule these pin is short: **wake before you ask, talk to the group, and
 * always leave a backstop.** It is short because it used to be written out six
 * times, in six slightly different ways, and two of the copies left the wake
 * out. One of those two was the console's own shutdown, which is how a frozen
 * phase-9 child came to sit in state `T` for three hours after the console that
 * stopped it had exited: a stopped process queues SIGTERM and never runs its
 * handler, so `await this.driving` waited for an exit that could not happen.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { groupSignal, killLadder, stopWhereItStands, wake, wakeAndTerm } from '../server/runner/signals.ts';

const SERVER = new URL('../server/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SERVER), 'utf8');

/** Records what was sent, in order, so "wake first" is an assertion and not a hope. */
function recorder() {
  const sent: Array<{ pid: number; signal: string }> = [];
  return { sent, signal: (pid: number, signal: NodeJS.Signals) => { sent.push({ pid, signal }); } };
}

const noSleep = async (): Promise<void> => {};

test('killLadder: wake, ask, then insist — and the wake comes first', async () => {
  const r = recorder();
  // Alive throughout: the child ignores SIGTERM, so the ladder must escalate.
  const how = await killLadder(99, { signal: r.signal, alive: () => true, sleep: noSleep });

  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGTERM', 'SIGKILL']);
  assert.equal(r.sent[0].signal, 'SIGCONT',
    'the wake is FIRST — a stopped process cannot act on anything else');
  assert.equal(how, 'killed');
});

test('killLadder: a child that goes on SIGTERM is never killed', async () => {
  const r = recorder();
  let alive = true;
  const how = await killLadder(99, {
    signal: r.signal,
    alive: () => alive,
    sleep: async () => { alive = false; },   // it exits during the grace
  });
  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGTERM']);
  assert.equal(how, 'exited');
});

test('killLadder: a pid already gone is signalled not at all', async () => {
  const r = recorder();
  const how = await killLadder(99, { signal: r.signal, alive: () => false, sleep: noSleep });
  assert.deepEqual(r.sent, []);
  assert.equal(how, 'gone');
});

test('killLadder: every ladder addresses the pid it was given', async () => {
  const r = recorder();
  await killLadder(4242, { signal: r.signal, alive: () => true, sleep: noSleep });
  assert.deepEqual([...new Set(r.sent.map((s) => s.pid))], [4242]);
});

test('the one-shot verbs each keep the rule they are named for', () => {
  const t = recorder();
  wakeAndTerm(7, { signal: t.signal });
  assert.deepEqual(t.sent.map((s) => s.signal), ['SIGCONT', 'SIGTERM'],
    'the abort path wakes too — it is the one that shipped without it');

  const w = recorder();
  wake(7, { signal: w.signal });
  assert.deepEqual(w.sent.map((s) => s.signal), ['SIGCONT']);

  const f = recorder();
  stopWhereItStands(7, { signal: f.signal });
  assert.deepEqual(f.sent.map((s) => s.signal), ['SIGSTOP']);
});

test('groupSignal: the group first, the bare pid as a fallback', () => {
  const seen: number[] = [];
  const realKill = process.kill.bind(process);
  // @ts-expect-error — deliberately swapping the platform call for one test
  process.kill = (pid: number) => {
    seen.push(pid);
    if (pid < 0) { const e = new Error('ESRCH') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
  };
  try {
    groupSignal(4242, 'SIGTERM');
    assert.deepEqual(seen, [-4242, 4242],
      'the group is tried first so the CLI\'s bash and MCP children go with it; '
      + 'the bare pid covers a child that is not a group leader');
  } finally { process.kill = realKill; }
});

test('groupSignal: never pid 0 or 1 — that is "every process" and init', () => {
  const seen: number[] = [];
  const realKill = process.kill.bind(process);
  // @ts-expect-error — see above
  process.kill = (pid: number) => { seen.push(pid); };
  try {
    for (const pid of [0, 1, -1, 1.5, Number.NaN]) groupSignal(pid, 'SIGKILL');
    assert.deepEqual(seen, [], 'a bad pid is refused before it reaches the platform');
  } finally { process.kill = realKill; }
});

/* ------------------------------------------------------------------ *
 * The choke point
 * ------------------------------------------------------------------ */

test('signals.ts is the ONLY place in server/ that signals a process', () => {
  // The same shape as the `sizing.env` single-source rule. Six copies of this
  // ladder is how two of them came to be missing the wake; one copy cannot
  // disagree with itself.
  const offenders: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const rel = child.href.slice(SERVER.href.length);
      if (rel === 'pid.ts' || rel === 'runner/signals.ts') continue;   // the probe, and the ladder itself
      if (/process\.kill\(/.test(readFileSync(child, 'utf8'))) offenders.push(rel);
    }
  };
  walk(SERVER);
  assert.deepEqual(offenders, [],
    'these files signal a process directly — route them through server/runner/signals.ts');
});

test('every teardown path was actually rewired, not just the ones with tests', () => {
  const runner = read('runner/runner.ts');
  const spawnSrc = read('runner/spawn.ts');
  const terminal = read('terminal.ts');

  // The two that shipped without a wake.
  assert.match(spawnSrc, /wakeAndTerm\(child\.pid\)/, 'the abort handler must wake before it terms');
  assert.match(runner, /const ladders = \[\.\.\.this\.lanes\.values\(\)\]/,
    'checkpointForShutdown must run the ladder itself — a setTimeout backstop dies with the process that set it');

  // The child must have a group to address.
  assert.match(spawnSrc, /detached: true/, 'without its own group, `-pid` reaches nothing');

  // And the rest go through the shared module.
  for (const [what, src] of [['runner', runner], ['terminal', terminal]] as const) {
    assert.match(src, /from '\.\/signals\.ts'|from '\.\/runner\/signals\.ts'/,
      `${what} must import the shared ladder`);
  }
});

test('the shutdown ladder is awaited, and inside the console\'s drain budget', () => {
  const runner = read('runner/runner.ts');
  assert.match(runner, /await Promise\.allSettled\(ladders\);\s*\n\s*await this\.driving;/,
    'the children must be settled BEFORE the drain is awaited — the drain is what used to hang on them');
  // The constant moved to `runner/runner-core.ts` with the rest of the prologue
  // when P10 split the class across an `extends` chain. `checkpointForShutdown`
  // itself stayed in `runner.ts` (it is in the last link), which is why the
  // adjacency assertion above still reads `runner`.
  const budget = /SHUTDOWN_LADDER_MS = ([\d_]+)/.exec(read('runner/runner-core.ts'));
  assert.ok(budget, 'the shutdown grace must be a named constant');
  assert.ok(Number(budget[1].replace(/_/g, '')) <= 120_000,
    'it has to fit inside index.ts\'s 120s shutdown budget, with room for the rest of the drain');
});
