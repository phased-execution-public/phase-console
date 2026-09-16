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

import {
  INT_GRACE_MS, groupSignal, interruptOnce, interruptedAt, killLadder, stopWhereItStands, wake, wakeAndTerm,
} from '../server/runner/signals.ts';

const SERVER = new URL('../server/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SERVER), 'utf8');

/** Records what was sent, in order, so "wake first" is an assertion and not a hope. */
function recorder() {
  const sent: Array<{ pid: number; signal: string }> = [];
  return { sent, signal: (pid: number, signal: NodeJS.Signals) => { sent.push({ pid, signal }); } };
}

const noSleep = async (): Promise<void> => {};

test('killLadder: wake, ask the turn to close, ask, then insist — and the wake comes first', async () => {
  const r = recorder();
  // Alive throughout: the child ignores SIGINT and SIGTERM, so the ladder must escalate.
  const how = await killLadder(99, { signal: r.signal, alive: () => true, sleep: noSleep });

  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGINT', 'SIGTERM', 'SIGKILL'],
    'SIGINT before SIGTERM: the CLI closes its turn (and writes the `result` that books its '
    + 'turns and dollars) on SIGINT, and leaves it unfinished on SIGTERM — chapter 09 row 57');
  assert.equal(r.sent[0].signal, 'SIGCONT',
    'the wake is FIRST — a stopped process cannot act on anything else');
  assert.equal(how, 'killed');
});

test('killLadder: a child that closes its turn on SIGINT is never termed', async () => {
  const r = recorder();
  let alive = true;
  const how = await killLadder(98, {
    signal: r.signal,
    alive: () => alive,
    sleep: async () => { alive = false; },   // it exits during the interrupt's grace
  });
  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGINT']);
  assert.equal(how, 'interrupted');
});

test('killLadder: a child that ignores SIGINT but goes on SIGTERM is never killed', async () => {
  const r = recorder();
  let alive = true;
  const how = await killLadder(97, {
    signal: r.signal,
    alive: () => alive,
    // Stays through the whole interrupt grace, leaves in the SIGTERM grace.
    sleep: async () => { if (r.sent.some((s) => s.signal === 'SIGTERM')) alive = false; },
    interruptAfterMs: 300,
  });
  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGINT', 'SIGTERM']);
  assert.equal(how, 'exited');
});

test('killLadder: the SIGKILL backstop is awaited — the promise settles after the kill, not before', async () => {
  const order: string[] = [];
  const how = killLadder(96, {
    signal: (_pid, signal) => { order.push(`sent ${signal}`); },
    alive: () => true,
    sleep: async () => { order.push('slept'); },
    interruptAfterMs: 100,
    killAfterMs: 100,
  });
  order.push('called');
  assert.equal(await how, 'killed');
  order.push('settled');
  assert.equal(order.at(-2), 'sent SIGKILL', 'the kill is the last thing the ladder does before it settles');
  assert.equal(order.at(-1), 'settled');
});

test('killLadder: both graces are polled — a child that leaves early releases the caller early', async () => {
  const r = recorder();
  let sleeps = 0;
  let alive = true;
  const how = await killLadder(95, {
    signal: r.signal,
    alive: () => alive,
    sleep: async () => { sleeps += 1; if (sleeps === 3) alive = false; },
    interruptAfterMs: 5_000,
  });
  assert.equal(how, 'interrupted');
  assert.equal(sleeps, 3, 'the wait asked every 100 ms and stopped at the first answer, not after the grace');
});

test('killLadder: interrupt:false keeps the old ladder for a child with no turn to close', async () => {
  const r = recorder();
  const how = await killLadder(94, { signal: r.signal, alive: () => true, sleep: noSleep, interrupt: false });
  assert.deepEqual(r.sent.map((s) => s.signal), ['SIGCONT', 'SIGTERM', 'SIGKILL']);
  assert.equal(how, 'killed');
});

test('interruptOnce: one SIGINT per process, and a later ladder shares the first grace instead of asking again', async () => {
  const first = recorder();
  let clock = 1_000_000;
  assert.equal(interruptOnce(93, { signal: first.signal, now: () => clock }), true);
  assert.deepEqual(first.sent.map((s) => s.signal), ['SIGCONT', 'SIGINT']);
  assert.equal(interruptedAt(93, clock), clock);

  // The spawn's abort asked 4 s ago; a runner's ladder arrives now.
  clock += 4_000;
  const second = recorder();
  assert.equal(interruptOnce(93, { signal: second.signal, now: () => clock }), false,
    'asked already — a second interrupt is insistence, not a question');
  let slept = 0;
  const how = await killLadder(93, {
    signal: second.signal, alive: () => true, now: () => clock, killAfterMs: 0,
    sleep: async (ms) => { slept += ms; },
  });
  assert.equal(how, 'killed');
  assert.deepEqual(second.sent.map((s) => s.signal), ['SIGCONT', 'SIGTERM', 'SIGKILL'],
    'no second SIGINT from the ladder');
  assert.ok(slept >= 1_000 && slept <= 1_100, `the ladder waited out only the first grace's remainder (${slept} ms)`);
  assert.equal(interruptedAt(93, clock), undefined, 'a settled ladder forgets the pid — it may be reused');
});

test('killLadder: when only `signal` is given, the interrupt goes through it too — a test seam never reaches a real pid', async () => {
  const r = recorder();
  const realKill = process.kill.bind(process);
  let reached = false;
  // @ts-expect-error — deliberately swapping the platform call for one test
  process.kill = () => { reached = true; };
  try {
    await killLadder(92, { signal: r.signal, alive: () => true, sleep: noSleep });
  } finally { process.kill = realKill; }
  assert.equal(reached, false, 'the seam carried every signal, the interrupt included');
  assert.ok(r.sent.some((s) => s.signal === 'SIGINT'));
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

  // The two that shipped without a wake. The abort handler now asks the turn
  // to close first (`interruptOnce` wakes, then interrupts), and escalates to
  // the wake-and-term on its own clock when the child does not go.
  assert.match(spawnSrc, /interruptOnce\(child\.pid/, 'the abort handler must wake and interrupt before it terms');
  assert.match(spawnSrc, /wakeAndTerm\(child\.pid\)/, 'the abort handler must still wake before it terms');
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
  // The ladder asks the turn to close first, so the whole wait is the
  // interrupt's grace plus the SIGTERM grace — both have to fit.
  assert.ok(INT_GRACE_MS + Number(budget[1].replace(/_/g, '')) <= 120_000,
    'it has to fit inside index.ts\'s 120s shutdown budget, with room for the rest of the drain');

  // SHD-8: the record a killed child leaves says WHICH phase and session, the
  // grace it was given, why it went and the tool call that was open — `{pid,
  // how}` alone could not say which side of a `gh pr merge` it fell on. And
  // the checkpoint is handed the drain's intent rather than guessing it.
  assert.match(runner, /protected async checkpointForShutdown\(context\?: ShutdownContext\)/,
    'the checkpoint takes the drain\'s context');
  const child = /this\.record\('run\.shutdown-child', \{([\s\S]*?)\}, lane\.phase\)/.exec(runner);
  assert.ok(child, 'run.shutdown-child is recorded against the lane\'s phase');
  for (const field of ['pid', 'phase: lane.phase', 'sessionId', 'how', 'graceMs', 'interruptGraceMs', 'why', 'intent', 'reason', 'openTool']) {
    assert.ok(child[1].includes(field), `run.shutdown-child carries ${field}`);
  }
  assert.match(read('runner/runner-control.ts'), /onShutdown\(this\.shutdownKey\(runId\), \(context\) => this\.checkpointForShutdown\(context\)\)/,
    'the drive loop\'s handler forwards the context');
});
