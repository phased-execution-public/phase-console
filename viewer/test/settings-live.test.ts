/**
 * Mid-run settings tell the truth (control-tower phase 13, #31) — SL-1..8.
 *
 * `POST /api/run/<slug>/settings` was a real mid-run patch with five gaps: the
 * plan's QA gate was start-only beside three live QA fields; one sentence —
 * "applies from the next phase" — covered a form where it was true of half the
 * fields, and two of those (`maxParallel`, `autoRecover`) were read at the door
 * and then dropped by `applySettings`; the sheet was shut while a lane was
 * wedged; a patch to a stored run was journalled with no `before` and a bare
 * `by`; and the one setting it omits, the account, was omitted in silence.
 *
 * A real Service over a scratch root, the real scripts, the real route.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';
import { readStoredRun } from '../server/runner/state.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LIVE_LANE_LOCKED_FIELDS, QA_CONFIRM, RUN_SETTINGS_FIELDS, SETTING_EFFECT_LABELS, SETTING_EFFECT_WORDS,
  SETTING_EFFECTS, SETTING_VERBS, START_ONLY_FIELDS,
} from '../shared/run-settings.js';
import { RUN_SWITCH_WORDS } from '../shared/verb-model.js';
import type { RunnerDeps } from '../server/runner/runner-core.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { applySettings } = await import('../server/runner/runner-core.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { warmPids } = await import('../server/pid.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-09-22
status: active
phases: 2
---

# alpha

## Session budget

> **Target model:** \`opus\` · **Budget:** ~200K

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — cart api
- **Size:** S
- **Verification:** \`true\`
`;

const OPEN: InstanceType<typeof Service>[] = [];

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-settings-live-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  // Phase 1 finished before QA was ever on: turning the gate on must record it
  // `waived`, never retroactively hold the board.
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# Phase 1 — schema\n', 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.splice(0)) svc.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string, over: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    maxSessions: 4, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return svc;
}

/**
 * A run with no loop behind it — paused, or halted over a lane still in flight.
 * A wedged lane is a record in flight over a process that is ALIVE (the read
 * path settles one whose process is gone): this test's own pid, with its own
 * start time as the identity half, and never signalled.
 */
function storedRun(root: string, shape: Partial<RunState> = {}, lane?: number): RunState {
  const state = newRun({ slug: 'alpha', root, maxParallel: 3, gitMode: 'new-branch' });
  Object.assign(state, { status: 'paused' }, shape);
  if (lane != null) {
    const record = phaseRecord(state, lane);
    record.status = 'running';
    record.sessionId = `sess-${lane}`;
    record.startedAt = new Date().toISOString();
    record.attemptStartedAt = record.startedAt;
    state.children = {
      [lane]: {
        pid: process.pid, phase: lane, sessionId: `sess-${lane}`, startedAt: record.startedAt,
        procStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      },
    };
  }
  saveRun(state);
  return state;
}

const readRun = (root: string, id: string): RunState =>
  readStoredRun(root, 'alpha', id)!;

const journal = (root: string, id: string) =>
  readFileSync(journalFile(root, 'alpha', id), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });

type Captured = { status: number; body: Record<string, unknown> };

/** One request through the real dispatcher, as a browser sends it. */
async function post(svc: unknown, path: string, body: Record<string, unknown>): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', 'user-agent': 'Mozilla/5.0 (Macintosh)', host: '127.0.0.1:4130' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

type Refused = { field: string; why: string; verb?: string };
const refusedOf = (out: Captured): Refused[] => (out.body.refused as Refused[] | undefined) ?? [];

/* ------------------------------------------------------------------ *
 * SL-1..3 — the plan's QA gate, mid-run
 * ------------------------------------------------------------------ */

test('SL-1: `qa: true` without the confirmation is refused by name, and nothing is written', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    storedRun(root);
    assert.equal((await svc.qaMode('alpha')).mode, 'off');
    assert.ok(!START_ONLY_FIELDS.includes('qa'), '`qa` is a live field now');
    assert.ok(RUN_SETTINGS_FIELDS.includes('qa'));

    const out = await post(svc, '/api/run/alpha/settings', { qa: true });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    const qa = refusedOf(out).find((row) => row.field === 'qa');
    assert.ok(qa, 'the refusal names the field');
    assert.match(qa!.why, new RegExp(QA_CONFIRM), 'and the confirmation it needs');
    assert.equal(existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')), false,
      'no test-status.md was created without the confirmation');
    assert.equal((await svc.qaMode('alpha')).mode, 'off');
  } finally { cleanup(); }
});

test('SL-2: the confirmation without --allow-writes is refused too — a write the console may not make', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root, { allowWrites: false });
    storedRun(root);
    const out = await post(svc, '/api/run/alpha/settings', { qa: true, confirm: QA_CONFIRM });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    const qa = refusedOf(out).find((row) => row.field === 'qa');
    assert.match(qa?.why ?? '', /--allow-writes/);
    assert.equal(existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')), false);
  } finally { cleanup(); }
});

test('SL-3: confirmed, `qa` turns the gate on and backfills finished phases `waived`; `qa: false` writes the line off', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = storedRun(root);
    const on = await post(svc, '/api/run/alpha/settings', { qa: true, confirm: QA_CONFIRM });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const ledger = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    assert.match(ledger, /^\|\s*1\s*\|\s*waived\b/m, 'phase 1 finished before QA and is recorded waived');
    assert.equal((await svc.qaMode('alpha')).mode, 'on');
    const line = journal(root, run.id).filter((entry) => entry.event === 'run.reconfigured').at(-1);
    assert.equal((line?.data?.patch as Record<string, unknown>)?.qa, true, 'the journal says what changed');
    assert.equal((line?.data?.before as Record<string, unknown>)?.qa, 'off', 'and what it was');

    const off = await post(svc, '/api/run/alpha/settings', { qa: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.match(readFileSync(join(root, 'docs', 'plans', 'alpha.md'), 'utf8'), /^\*\*QA gate:\*\* off$/m);
    assert.equal((await svc.qaMode('alpha')).mode, 'waived', 'the ledger stays; the gate lets go');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SL-4..5 — when each field takes effect, and that it is true
 * ------------------------------------------------------------------ */

test('SL-4: SETTING_EFFECTS is total over RUN_SETTINGS_FIELDS, in its own words, each with a label', () => {
  assert.deepEqual(Object.keys(SETTING_EFFECTS).sort(), [...RUN_SETTINGS_FIELDS].sort(),
    'every field the door reads says when it takes effect, and nothing else does');
  for (const [field, word] of Object.entries(SETTING_EFFECTS)) {
    assert.ok(SETTING_EFFECT_WORDS.includes(word), `${field}: "${word}" is not an effect word`);
  }
  for (const word of SETTING_EFFECT_WORDS) {
    assert.ok((SETTING_EFFECT_LABELS as Record<string, string>)[word], `"${word}" has no label`);
  }
  // The scheduler's and the ladder's inputs are read at the loop's next
  // decision — the sentence the sheet used to print was untrue of exactly these.
  for (const field of ['maxParallel', 'runBudgetUsd', 'maxConsecutiveFailures', 'autonomy', 'priority', 'onlyPhases']) {
    assert.equal(SETTING_EFFECTS[field as keyof typeof SETTING_EFFECTS], 'now', field);
  }
  for (const field of ['model', 'effort', 'skills', 'mcpServers', 'permissionMode']) {
    assert.equal(SETTING_EFFECTS[field as keyof typeof SETTING_EFFECTS], 'next-phase', field);
  }
  for (const field of LIVE_LANE_LOCKED_FIELDS) assert.ok(RUN_SETTINGS_FIELDS.includes(field), field);
});

test('SL-5: a lowered `maxParallel` governs the very next admission; `autoRecover` is applied, not dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-settings-lanes-'));
  try {
    const instance = new Runner({ scriptsDir: '/nonexistent', maxParallel: () => 4 } as RunnerDeps);
    const runner = instance as unknown as { state: RunState; maxLanes(): number };
    runner.state = newRun({ slug: 'alpha', root, maxParallel: 3 });
    assert.equal(runner.maxLanes(), 3);

    assert.equal(instance.configure({ maxParallel: 1 }, 'operator'), true);
    assert.equal(runner.state.maxParallel, 1, 'stored on the live run');
    assert.equal(runner.maxLanes(), 1, 'the admission reads it at once — not at the next phase');
    // An emptied cap hands the run back to the console's own.
    instance.configure({ maxParallel: 0 }, 'operator');
    assert.equal(runner.state.maxParallel, undefined);
    assert.equal(runner.maxLanes(), 4);

    const state = newRun({ slug: 'alpha', root });
    applySettings(state, { autoRecover: true });
    assert.deepEqual(state.autoRecover, {}, 'arming, the way a Continue arms it');
    applySettings(state, { autoRecover: false });
    assert.equal(state.autoRecover, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * SL-6 — the sheet opens while a lane is wedged
 * ------------------------------------------------------------------ */

test('SL-6: a patch is accepted while a lane is wedged — locked fields refused by name in one 409, the rest applied', async () => {
  const { root, cleanup } = scratch();
  try {
    // Halted, with phase 2's record still in flight: the wedged run.
    const run = storedRun(root, { status: 'halted' }, 2);
    await warmPids([process.pid]);
    const svc = service(root);
    const out = await post(svc, '/api/run/alpha/settings', {
      maxParallel: 1, autonomy: 'halt-on-everything', gitMode: 'default-branch',
    });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    const refused = refusedOf(out);
    assert.deepEqual(refused.map((row) => row.field), ['gitMode'], 'only the field that cannot move under a live lane');
    assert.match(refused[0].why, /phase 2/, 'and the lane it cannot move under');
    const disk = readRun(root, run.id);
    assert.equal(disk.maxParallel, 1, 'the rest was applied');
    assert.equal(disk.autonomy, 'halt-on-everything');
    assert.equal(disk.gitMode, 'new-branch', 'the locked field was not');
    assert.ok((out.body.run as RunState | undefined)?.id, 'the answer carries the run as it now is');

    // Re-asserting what the run already has is not a move: a form resubmits
    // every field, and must not 409 on the one it did not touch.
    const same = await post(svc, '/api/run/alpha/settings', { maxParallel: 2, gitMode: 'new-branch' });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(readRun(root, run.id).maxParallel, 2);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SL-7 — every stored-run patch is journalled, with what it replaced
 * ------------------------------------------------------------------ */

test('SL-7: a stored-run patch journals `run.reconfigured {patch, before, by, via}`; the live path gains both', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = storedRun(root);
    const out = await post(svc, '/api/run/alpha/settings', { maxParallel: 1, runBudgetUsd: 40, reason: 'fanning out too far' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const line = journal(root, run.id).filter((entry) => entry.event === 'run.reconfigured').at(-1);
    assert.ok(line, 'the stored edit left a line');
    assert.deepEqual(line!.data?.patch, { maxParallel: 1, runBudgetUsd: 40 });
    assert.deepEqual(line!.data?.before, { maxParallel: 3, runBudgetUsd: null });
    assert.equal(line!.data?.stored, true);
    assert.equal(line!.data?.by, 'operator', 'a browser is a person, derived — never the literal `console`');
    assert.equal(line!.data?.via, 'api');
    assert.equal(line!.data?.reason, 'fanning out too far', 'the verb\'s reason is kept (phase 96)');
  } finally { cleanup(); }

  // The live path: the runner's own `configure`, handed the derived actor.
  const scratchRoot = mkdtempSync(join(tmpdir(), 'pc-settings-live-path-'));
  try {
    const instance = new Runner({ scriptsDir: '/nonexistent', maxParallel: () => 4 } as RunnerDeps);
    const runner = instance as unknown as {
      state: RunState; record: (event: string, data?: Record<string, unknown>) => void;
    };
    runner.state = newRun({ slug: 'alpha', root: scratchRoot, maxParallel: 3 });
    // A bare runner has no journal open: its lines are read off `record` itself.
    const lines: { event: string; data?: Record<string, unknown> }[] = [];
    runner.record = (event, data) => { lines.push({ event, ...(data ? { data } : {}) }); };
    instance.configure({ maxParallel: 2 }, { by: 'operator', via: 'api', origin: 'local', remoteUser: null });
    const line = lines.filter((entry) => entry.event === 'run.reconfigured').at(-1);
    assert.deepEqual(line?.data?.patch, { maxParallel: 2 });
    assert.deepEqual(line?.data?.before, { maxParallel: 3 });
    assert.equal(line?.data?.by, 'operator');
    assert.equal(line?.data?.via, 'api');
  } finally { rmSync(scratchRoot, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * SL-8 — the one setting a patch does not carry says where it went
 * ------------------------------------------------------------------ */

test('SL-8: the settings door names the `switch-account` verb for `accountId`, and applies the rest', async () => {
  assert.equal(SETTING_VERBS.accountId, 'switch-account');
  assert.ok((RUN_SWITCH_WORDS as readonly string[]).includes(SETTING_VERBS.accountId), 'a verb the run table has');
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const run = storedRun(root);
    const out = await post(svc, '/api/run/alpha/settings', { accountId: 'work', maxParallel: 2 });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    const row = refusedOf(out).find((entry) => entry.field === 'accountId');
    assert.equal(row?.verb, 'switch-account');
    assert.match(row?.why ?? '', /switch-account/);
    assert.equal(readRun(root, run.id).maxParallel, 2, 'the rest of the patch landed');
    assert.equal(readRun(root, run.id).accountId, undefined, 'the account did not move through the settings door');
  } finally { cleanup(); }
});


/* ------------------------------------------------------------------ *
 * The platform's pieces (measured-console phase 12, B2 A10)
 * ------------------------------------------------------------------ */

test('SL-10: humanStepMode, compaction and compactionWindow — words and bounds held, defaults stored as no key, null clears', async () => {
  const { applySessionEnvSettings } = await import('../server/runner/runner-core.ts');
  const { humanStepModeFor, DEFER_CLI_FLOOR, SETTING_EFFECTS, RUN_SETTINGS_FIELDS, RUN_START_FIELDS } = await import('../shared/run-settings.js');
  for (const field of ['humanStepMode', 'compaction', 'compactionWindow']) {
    assert.ok(RUN_SETTINGS_FIELDS.includes(field as never) && RUN_START_FIELDS.includes(field as never), field);
    assert.equal((SETTING_EFFECTS as Record<string, string>)[field], 'next-phase');
  }
  const state = {} as RunState;
  applySessionEnvSettings(state, { humanStepMode: 'park', compaction: 'alternate', compactionWindow: 400_000 });
  assert.deepEqual([state.humanStepMode, state.compaction, state.compactionWindow], ['park', 'alternate', 400_000]);
  applySessionEnvSettings(state, { compaction: 'console', compactionWindow: 350_000 });
  assert.equal(state.compaction, undefined, '`console` is the default — stored as no key');
  assert.equal(state.compactionWindow, undefined, 'so is the shipped window');
  applySessionEnvSettings(state, { humanStepMode: 'sometimes' as never, compactionWindow: 10 });
  assert.equal(state.humanStepMode, undefined, 'a word off the list clears');
  assert.equal(state.compactionWindow, undefined, 'a window out of bounds clears');
  // Absent, the CLI decides: defer at the floor, park below it or unknown.
  assert.equal(humanStepModeFor(undefined, `${DEFER_CLI_FLOOR} (Claude Code)`), 'defer');
  assert.equal(humanStepModeFor(undefined, '2.1.305'), 'park');
  assert.equal(humanStepModeFor(undefined, undefined), 'park');
  assert.equal(humanStepModeFor('park', '2.1.400'), 'park');
});


test('SL-11: the compaction arms — native carries the window, alternate gives odd phases native, the 0.8 checkpoint is off under native', async () => {
  const { compactionArm } = await import('../shared/run-settings.js');
  const { compactionEnv } = await import('../server/runner/errors.ts');
  const { contextStageFor } = await import('../server/runner/usage.ts');
  assert.deepEqual([1, 2, 3, 4].map((phase) => compactionArm({ mode: 'alternate', phase })), ['native', 'console', 'native', 'console']);
  assert.equal(compactionArm({ mode: 'native', phase: 2 }), 'native');
  assert.equal(compactionArm({ mode: undefined, phase: 3 }), 'console');
  assert.deepEqual(compactionEnv('native', 350_000), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350000' });
  assert.ok('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in compactionEnv('console', 350_000) && compactionEnv('console', 350_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined,
    'console clears an inherited window');
  assert.equal(contextStageFor(850_000, 1_000_000, 'console'), 'checkpoint');
  assert.equal(contextStageFor(850_000, 1_000_000, 'native'), 'wrap-up', 'native: no checkpoint, the notice instead');
  assert.equal(contextStageFor(100_000, 1_000_000, 'native'), 'ok');
});

test('SL-12: the compaction hooks ride a native-capable run’s settings, and journal phase.compaction with before, after and the re-cache', async () => {
  const { buildSettings, HOOK_ON_FAILURE } = await import('../server/runner/approvals.ts');
  const off = buildSettings({ runId: 'r1', token: 't', origin: 'http://x' }).hooks as Record<string, unknown>;
  assert.ok(!('PreCompact' in off) && !('PostCompact' in off), 'a console-arm run registers neither');
  const on = buildSettings({ runId: 'r1', token: 't', origin: 'http://x', compactionHooks: true }).hooks as
    Record<string, { hooks: { type: string; url: string; onFailure: string; headers: Record<string, string> }[] }[]>;
  for (const event of ['PreCompact', 'PostCompact']) {
    const [hook] = on[event]![0]!.hooks;
    assert.deepEqual([hook.type, hook.url, hook.onFailure, hook.headers.Authorization], ['http', 'http://x/hooks/compact', HOOK_ON_FAILURE, 'Bearer t'], event);
  }
  const { contextCompactionNotice } = await import('../server/runner/runner-core.ts');
  assert.match(contextCompactionNotice(610_000, 1_000_000, 350_000, { push: { branch: 'pe/demo', allowed: true } }),
    /compaction arm is native: the CLI compacts this session at 350k tokens and the console does not checkpoint it, so carry on.*git push origin pe\/demo/);
  // The runner measures a compaction from the stream around its two hooks.
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  const runner = new Runner({
    scriptsDir: join(SKILL_DIR, 'scripts'),
    onEvent: (name: string, data: { event: string; data: Record<string, unknown> }) => { if (name === 'run:journal') lines.push(data); },
  } as never);
  const state = { id: 'r-c', slug: 'demo', root: '/nonexistent', status: 'running', compaction: 'native', phases: { 3: { status: 'running', sessionId: 's3', model: 'claude-opus-5-5[1m]' } } };
  const bag = runner as unknown as { state: unknown; lanes: Map<number, unknown>; noteContext: (phase: number, event: unknown) => void };
  bag.state = state;
  bag.lanes.set(3, { phase: 3, signals: {} });
  const usage = (context: number, cacheWrite = 0) => ({ kind: 'usage', call: { input: 1, cacheWrite, cacheRead: 0, output: 1, context }, rebuild: false, totals: { lastContext: context } });
  bag.noteContext(3, usage(340_000));
  runner.noteCompactionHook(3, 'PreCompact', 'auto');
  runner.noteCompactionHook(3, 'PostCompact', 'auto');
  bag.noteContext(3, usage(41_000, 39_500));
  const compaction = lines.find((l) => l.event === 'phase.compaction');
  assert.deepEqual(
    { ...compaction?.data, at: undefined },
    { trigger: 'auto', before: 340_000, after: 41_000, recacheTokens: 39_500, at: undefined, sessionId: 's3', arm: 'native' },
  );
});

test('SL-13: a resumed session’s own resume cost reaches its phase — record.resumeCost, phase.resume-cost, and the next brief’s words', async () => {
  const { resumeCostOf } = await import('../server/service-runs.ts');
  const { resumeCostWords } = await import('../server/runner/session-record.ts');
  const cost = resumeCostOf({ seconds_since_last_response: 5400, context_tokens: 182340, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396, extra: 'x' });
  assert.deepEqual(cost, { secondsSinceLastResponse: 5400, contextTokens: 182340, cacheLikelyExpired: true, estimatedCacheWriteUsd: 1.1396 });
  assert.equal(resumeCostOf({ context_tokens: 'many' }), null);
  assert.equal(resumeCostOf(undefined), null);
  assert.equal(resumeCostWords(cost),
    "This phase's last resume reported its own cost: 90 min after its last response, re-sending 182,340 tokens, its prompt cache likely expired, ≈ $1.14 to write the cache again.");
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  const runner = new Runner({
    scriptsDir: join(SKILL_DIR, 'scripts'),
    onEvent: (name: string, data: { event: string; data: Record<string, unknown> }) => { if (name === 'run:journal') lines.push(data); },
  } as never);
  const state = { id: 'r-rc', slug: 'demo', root: '/nonexistent', status: 'running', phases: { 5: { status: 'running', sessionId: 's5' } } } as unknown as RunState;
  (runner as unknown as { state: RunState }).state = state;
  assert.equal(runner.noteResumeCost('someone-else', cost!), false);
  assert.equal(runner.noteResumeCost('s5', cost!), true);
  assert.equal(state.phases['5'].resumeCost?.contextTokens, 182340);
  assert.deepEqual(lines.find((l) => l.event === 'phase.resume-cost')?.data, { sessionId: 's5', ...cost });
});
