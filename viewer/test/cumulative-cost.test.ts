/**
 * Every dollar booked exactly once (control-tower phase 46, #62).
 *
 * From CLI 2.1.278 a `--resume` spawn's `total_cost_usd` is the CONVERSATION's
 * running total, not what that spawn cost, and eight booking sites added it as
 * fresh spend every time. In the audit week $531–631 (9–11 %) of the ledger was
 * re-reported spend: observability-plane P9 booked $44.51, $58.98, $62.89 and
 * $67.31 for spawns that spent $14.48, $3.91 and $4.42, and the inflated figure
 * reached the $/hour start ceiling, the run budget and the rung charges.
 *
 *   CC-1  a spawn books `max(0, total − highWater[sessionId])`;
 *   CC-2  three resumes of one session book exactly the CLI's final total;
 *   CC-3  ONE `bookSpend()` is the only writer of the run's and the phase's dollars;
 *   CC-4  the start ceiling reads booked deltas (`start-ceiling.test.ts`);
 *   CC-5  the booked figure is corroborated against priced per-message usage —
 *         a mismatch journals `phase.cost-mismatch` and never blocks;
 *   CC-6  a stored run is re-priced once at boot (`costModel: 2`, `run.cost-repriced`);
 *   CC-7  and never twice.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COST_MODEL, bookedDelta, repriceFromLedger } from '../server/runner/session-record.ts';
import { COST_MISMATCH_FLOOR_USD, COST_MISMATCH_TOLERANCE, costMismatch, priceUsage } from '../server/runner/usage.ts';
import type { SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';
import type { PhaseRecord } from '../server/runner/state.ts';
import type { TokenCounters } from '../server/runner/usage.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, saveRun, runDir, loadRun } = await import('../server/runner/state.ts');
const { Service } = await import('../server/service.ts');
const { SKILL_DIR } = await import('../server/config.ts');

const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} ≠ ${b}`);

/* ------------------------------------------------------------------ *
 * CC-1: the arithmetic
 * ------------------------------------------------------------------ */

test('CC-1: a spawn books its total minus the session\'s high-water mark, never below zero', () => {
  assert.deepEqual(bookedDelta(undefined, 9.96, true), { booked: 9.96, mark: 9.96, restarted: false }, 'a new session books its whole total');
  const resumed = bookedDelta(9.96, 16.11, true);
  near(resumed.booked, 6.15, 'a resume books only what it added');
  assert.equal(resumed.mark, 16.11);
  // The 4.8 s shutdown-ended resume that re-reported exactly the previous total.
  assert.deepEqual(bookedDelta(26.01, 26.01, true), { booked: 0, mark: 26.01, restarted: false });
  // No total ever arrived: nothing is booked, and the mark stays where it was —
  // a zero must not reset it, or the next resume re-books the whole conversation.
  assert.deepEqual(bookedDelta(26.01, 0, false), { booked: 0, mark: 26.01, restarted: false });
  // A running total never falls. One that did is a counter that restarted (or a
  // CLI that reports each spawn's own cost): it is booked whole and becomes the mark.
  assert.deepEqual(bookedDelta(26.01, 0.5, true), { booked: 0.5, mark: 0.5, restarted: true });
  assert.deepEqual(bookedDelta(undefined, Number.NaN, true), { booked: 0, mark: 0, restarted: false });
});

/* ------------------------------------------------------------------ *
 * A one-phase harness (CC-2, CC-3, CC-5)
 * ------------------------------------------------------------------ */

type Harness = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

function executable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-cumulative-cost-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  executable(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"
mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if [ -f "$S/done" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-mode) echo off ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of demo" ;;
  --size) echo L ;;
  *) exit 0 ;;
esac
`);
  executable(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  executable(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(stub, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-A', costUsd: 1, turns: 4, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

const capped = (costUsd: number, partial: Partial<SpawnOutcome> = {}) => ok({
  signal: { subtype: 'error_max_turns', terminalReason: 'max_turns', isError: true, code: 1, text: '' },
  costUsd, turns: 600, resultText: 'Reached the maximum number of turns', ...partial,
});

type Events = { event: string; data: Record<string, unknown> }[];

function runnerFor(h: Harness, spawn: (request: SpawnRequest) => Promise<SpawnOutcome>, extra: Record<string, unknown> = {}) {
  const events: Events = [];
  const instance = new Runner({
    scriptsDir: h.scripts,
    spawn,
    verificationText: () => '`true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    phaseDefaults: () => ({ model: 'opus' }),
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  } as never);
  return { instance, events };
}

const journalled = (events: Events, name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/* ------------------------------------------------------------------ *
 * CC-2: three resumes book the final total
 * ------------------------------------------------------------------ */

test('CC-2: a session resumed three times books exactly the CLI\'s final total — ai-builder-v5 P14\'s chain, booked once', async () => {
  const h = harness();
  try {
    // The CLI's running totals for one conversation: the attempt, then three
    // resumes after spent caps — each report carrying everything before it.
    const totals = [9.96, 16.11, 21.53, 25.23];
    let n = 0;
    const { instance, events } = runnerFor(h, async () => {
      const total = totals[n++];
      if (n < totals.length) return capped(total);
      h.markDone();
      return ok({ costUsd: total });
    });
    await instance.start({ slug: 'demo', root: h.root, onlyPhases: [1] });
    await instance.wait();
    const state = instance.current()!;
    const record = state.phases['1'];
    assert.equal(record.status, 'done');
    near(state.spentUsd, 25.23, 'the run books the final total');
    near(record.costUsd, 25.23, 'and so does the phase');
    assert.deepEqual(record.costHighWater, { 'sess-A': 25.23 }, 'the mark it booked against, on the record');
    const sessions = journalled(events, 'phase.session');
    assert.deepEqual(sessions.map((line) => line.costUsd), totals, 'phase.session still says what the CLI reported');
    const booked = sessions.map((line) => Number(line.bookedUsd));
    [9.96, 6.15, 5.42, 3.7].forEach((want, i) => near(booked[i], want, `session ${i + 1} booked`));
    // The pre-fix ledger for the same four reports: $72.83 for $25.23 of work.
    near(totals.reduce((a, b) => a + b, 0), 72.83, 'what the eight sites used to book');
  } finally { h.cleanup(); }
});

test('CC-2: every vehicle books through the same mark — a phase attempt, then its closeout resuming the same conversation', async () => {
  const h = harness();
  try {
    // A repository with dirt in it: work on disk and no paperwork, the shape
    // that sends a phase to its closeout.
    execFileSync('git', ['init', '-q'], { cwd: h.root });
    writeFileSync(join(h.root, 'half-finished.txt'), 'work in flight\n');
    let n = 0;
    const { instance, events } = runnerFor(h, async () => {
      n += 1;
      if (n === 1) return ok({ costUsd: 8.04, resultText: 'ended without paperwork' });
      h.markDone();
      return ok({ costUsd: 46.62 });
    });
    await instance.start({ slug: 'demo', root: h.root, onlyPhases: [1] });
    await instance.wait();
    const state = instance.current()!;
    assert.deepEqual(journalled(events, 'phase.session').map((line) => line.mode), ['phase', 'closeout']);
    near(state.spentUsd, 46.62, 'the closeout added $38.58, not $46.62');
    near(state.phases['1'].costUsd, 46.62, 'the phase');
    near(Number(journalled(events, 'phase.closeout-done')[0]?.costUsd), 38.58, 'the closeout\'s own line says what it booked');
  } finally { h.cleanup(); }
});

test('CC-2: the live lane shows what the RESUMED spawn has cost so far, never the conversation\'s booked history', async () => {
  const h = harness();
  try {
    const seen: (number | undefined)[] = [];
    let live: () => number | undefined = () => undefined;
    let n = 0;
    const { instance } = runnerFor(h, async (request) => {
      n += 1;
      if (n === 1) return capped(10);
      // The resumed spawn's running total arrives carrying the $10 already booked.
      request.onEvent?.({ kind: 'result', subtype: 'success', costUsd: 13.5, turns: 5 } as StreamEvent);
      seen.push(live());
      h.markDone();
      return ok({ costUsd: 14 });
    });
    live = () => instance.liveness().find((lane) => lane.phase === 1)?.spentUsd;
    await instance.start({ slug: 'demo', root: h.root, onlyPhases: [1] });
    await instance.wait();
    near(seen[0] ?? Number.NaN, 3.5, 'the live half is this spawn\'s own $3.50');
    near(instance.current()!.spentUsd, 14, 'and the booked half the final total');
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * CC-3: one writer
 * ------------------------------------------------------------------ */

test('CC-3: bookSpend() is the only writer of state.spentUsd, record.costUsd and the start ceiling\'s dollars', () => {
  const dir = new URL('../server/runner/', import.meta.url);
  const hits: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\bstate!?\.spentUsd\s*\+=|\brecord\.costUsd\s*\+=|startCeiling\?*\.spendUsd\(/.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  const base = readFileSync(new URL('runner-base.ts', dir), 'utf8');
  const start = base.indexOf('protected bookSpend(');
  assert.ok(start > 0, 'RunnerBase.bookSpend exists');
  const end = base.indexOf('\n  }\n', start);
  const [first, last] = [base.slice(0, start).split('\n').length, base.slice(0, end).split('\n').length];
  const outside = hits.filter((hit) => {
    const [file, line] = hit.split(':');
    return file !== 'runner-base.ts' || Number(line) < first || Number(line) > last;
  });
  assert.deepEqual(outside, [], 'a session\'s dollars are booked in bookSpend and nowhere else');
  assert.ok(hits.length >= 3, `bookSpend books the run, the phase and the ceiling (${hits.join(', ')})`);
});

/* ------------------------------------------------------------------ *
 * CC-5: corroboration
 * ------------------------------------------------------------------ */

const tokensOf = (partial: Partial<TokenCounters>): TokenCounters => ({
  calls: 7, lastContext: 450_000, peakContext: 450_000, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, rebuilds: 0, ...partial,
});

test('CC-5: per-message usage is priced by the model\'s family — the week\'s measured Opus rates — and nothing is guessed', () => {
  near(priceUsage('claude-opus-5-5[1m]', tokensOf({ input: 1_000_000 }))!, 5, 'input');
  near(priceUsage('opus', tokensOf({ cacheWrite: 1_000_000 }))!, 10, 'a cache write');
  near(priceUsage('opus[1m]', tokensOf({ cacheRead: 1_000_000 }))!, 0.5, 'a cache read');
  near(priceUsage('claude-opus-5', tokensOf({ output: 1_000_000 }))!, 25, 'output');
  assert.equal(priceUsage('some-future-model', tokensOf({ output: 1_000 })), null, 'an unpriced family is not priced');
  assert.equal(priceUsage(null, tokensOf({ output: 1_000 })), null);
  // P14's 7-call resume: 3,025,226 cached tokens read, 4,666 written out.
  near(priceUsage('opus', tokensOf({ cacheRead: 3_025_226, output: 4_666, cacheWrite: 2_000, input: 20 }))!, 1.649363, 'P14');
});

test('CC-5: a mismatch is a booked figure past tolerance of the priced one — subagents explain an excess, never a shortfall', () => {
  assert.equal(COST_MISMATCH_TOLERANCE, 0.25);
  assert.equal(COST_MISMATCH_FLOOR_USD, 0.5);
  assert.equal(costMismatch({ booked: 10, priced: 9, delegated: false }), null, 'inside tolerance');
  assert.equal(costMismatch({ booked: 0.3, priced: 0.05, delegated: false }), null, 'inside the absolute floor');
  assert.deepEqual(costMismatch({ booked: 26.01, priced: 1.649, delegated: false }), { direction: 'over', ratio: 15.77 });
  assert.equal(costMismatch({ booked: 26.01, priced: 1.649, delegated: true }), null, 'a delegating session pays for calls the stream never prices');
  assert.deepEqual(costMismatch({ booked: 0, priced: 5.2, delegated: true }), { direction: 'under', ratio: 0 });
  assert.equal(costMismatch({ booked: 5, priced: null, delegated: false }), null, 'nothing to compare with');
});

test('CC-5: a booked figure the tokens cannot explain journals phase.cost-mismatch — and the phase finishes as if nothing were said', async () => {
  const h = harness();
  try {
    const { instance, events } = runnerFor(h, async () => {
      h.markDone();
      return ok({
        sessionId: 'sess-fresh', costUsd: 26.01,
        tokens: tokensOf({ cacheRead: 3_025_226, output: 4_666, cacheWrite: 2_000, input: 20 }),
      });
    });
    await instance.start({ slug: 'demo', root: h.root, onlyPhases: [1] });
    await instance.wait();
    assert.equal(instance.current()!.phases['1'].status, 'done', 'never blocks');
    near(instance.current()!.spentUsd, 26.01, 'and books what the CLI reported — corroboration corrects nothing');
    const lines = journalled(events, 'phase.cost-mismatch');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].sessionId, 'sess-fresh');
    assert.equal(lines[0].mode, 'phase');
    assert.equal(lines[0].direction, 'over');
    near(Number(lines[0].bookedUsd), 26.01, 'booked');
    near(Number(lines[0].pricedUsd), 1.6494, 'priced, to four places', 1e-9);
    near(Number(lines[0].reportedUsd), 26.01, 'reported');
    assert.equal(lines[0].delegated, false);
  } finally { h.cleanup(); }
});

test('CC-5: a session whose booking agrees with its tokens writes nothing', async () => {
  const h = harness();
  try {
    const { instance, events } = runnerFor(h, async () => {
      h.markDone();
      return ok({ costUsd: 1.7, tokens: tokensOf({ cacheRead: 3_025_226, output: 4_666, cacheWrite: 2_000, input: 20 }) });
    });
    await instance.start({ slug: 'demo', root: h.root, onlyPhases: [1] });
    await instance.wait();
    assert.deepEqual(journalled(events, 'phase.cost-mismatch'), []);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * CC-6 / CC-7: the stored ledger, re-priced once
 * ------------------------------------------------------------------ */

type Line = { seq: number; time: string; event: string; phase?: number; data: Record<string, unknown> };
const session = (seq: number, phase: number, sessionId: string, costUsd: number, extra: Record<string, unknown> = {}): Line => ({
  seq, time: new Date(Date.parse('2026-09-22T15:00:00Z') + seq * 60_000).toISOString(), event: 'phase.session', phase,
  data: { mode: 'resume', sessionId, costUsd, costSource: 'result', ...extra },
});

function storedLedger() {
  const state = newRun({ slug: 'demo', root: '/nowhere' });
  delete (state as { costModel?: number }).costModel;
  // observability-plane P9's chain: one conversation reported four times.
  state.phases['1'] = { phase: 1, status: 'done', attempts: 1, costUsd: 44.51 + 58.98 + 62.89 + 67.31 } as PhaseRecord;
  // A fresh session on phase 2 — nothing to correct.
  state.phases['2'] = { phase: 2, status: 'done', attempts: 1, costUsd: 5 } as PhaseRecord;
  // Money no journal line explains (a run older than the session ledger): kept.
  state.phases['3'] = { phase: 3, status: 'done', attempts: 1, costUsd: 100 } as PhaseRecord;
  state.spentUsd = 44.51 + 58.98 + 62.89 + 67.31 + 5 + 100;
  const lines = [
    session(1, 1, 'sess-1504', 44.51, { mode: 'phase' }),
    session(2, 1, 'sess-1504', 58.98),
    session(3, 1, 'sess-1504', 62.89),
    session(4, 1, 'sess-1504', 67.31),
    session(5, 2, 'sess-b', 5, { mode: 'phase' }),
    session(6, 1, 'sess-none', 0, { costSource: 'none' }),
  ];
  return { state, lines };
}

test('CC-6: a stored run is re-priced from its own journal — the re-reported part removed, the marks seeded, the model stamped', () => {
  const { state, lines } = storedLedger();
  const result = repriceFromLedger(state, lines);
  assert.ok(result, 'a run with no cost model is re-priced');
  near(result!.before, 338.69, 'before');
  near(result!.after, 172.31, 'after — $166.38 was the same conversation booked again');
  near(state.spentUsd, 172.31, 'the run');
  near(state.phases['1'].costUsd, 67.31, 'phase 1 is the conversation\'s final total');
  near(state.phases['2'].costUsd, 5, 'a fresh session is untouched');
  near(state.phases['3'].costUsd, 100, 'money the journal does not explain is never taken away');
  assert.deepEqual(state.phases['1'].costHighWater, { 'sess-1504': 67.31 }, 'a later resume books against the mark');
  assert.deepEqual(state.phases['2'].costHighWater, { 'sess-b': 5 });
  assert.equal(state.costModel, COST_MODEL);
  assert.equal(COST_MODEL, 2);
  assert.deepEqual(Object.keys(result!.phases), ['1'], 'the phases whose figure moved');
});

test('CC-7: never twice — a re-priced run, and a run born under the new model, are left alone', () => {
  const { state, lines } = storedLedger();
  repriceFromLedger(state, lines);
  const once = JSON.stringify(state);
  assert.equal(repriceFromLedger(state, lines), null, 'the second pass does nothing');
  assert.equal(JSON.stringify(state), once);
  const born = newRun({ slug: 'demo', root: '/nowhere' });
  assert.equal(born.costModel, COST_MODEL, 'a new run is booked under the new model from its first spawn');
  born.phases['1'] = { phase: 1, status: 'done', attempts: 1, costUsd: 16.11 } as PhaseRecord;
  born.spentUsd = 16.11;
  assert.equal(repriceFromLedger(born, [session(1, 1, 'x', 9.96), session(2, 1, 'x', 16.11)]), null);
  near(born.spentUsd, 16.11, 'booked deltas are never "corrected" again');
});

const PLAN = `---
slug: alpha
created: 2026-09-23
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |

## Phases

### Phase 1 — one
- **Size:** S
`;

test('CC-6/CC-7: the console re-prices stored runs ONCE at boot, journalling run.cost-repriced {before, after}', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-reprice-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const { state, lines } = storedLedger();
  state.slug = 'alpha';
  state.root = root;
  state.status = 'finished';
  saveRun(state);
  const journal = join(runDir(root, 'alpha'), `run-${state.id}.jsonl`);
  writeFileSync(journal, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const boot = () => {
    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: false,
      scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
    } as never);
    try { assert.equal(svc.open(root).ok, true); } finally { svc.close(); }
  };
  try {
    boot();
    const after = loadRun(root, 'alpha', state.id)!;
    assert.equal(after.costModel, COST_MODEL);
    near(after.spentUsd, 172.31, 'the stored run');
    near(after.phases['1'].costUsd, 67.31, 'its phase');
    const repriced = () => readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line)
      .filter((l) => l.event === 'run.cost-repriced');
    assert.equal(repriced().length, 1);
    near(Number(repriced()[0].data.before), 338.69, 'before');
    near(Number(repriced()[0].data.after), 172.31, 'after');
    boot();
    assert.equal(repriced().length, 1, 'a second boot touches nothing');
    near(loadRun(root, 'alpha', state.id)!.spentUsd, 172.31, 'and corrects nothing twice');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
