/**
 * The ladder re-arms, and its caps tell the truth (#36, #14).
 *
 * Two measured latches, one shape: a count that could only go up, over
 * records that could not say why they were written.
 *
 *  - #36: a half-hour outage retired every account on the machine, the one
 *    `resource-wall:auth` rung (`switch-account`) failed because there was
 *    nowhere to switch to, and the ladder recorded it TRIED — for the life of
 *    the phase. Two and a half hours later, with a signed-in account sitting
 *    right there, Recover answered the same errand quoting a timestamp from
 *    before the fix. A rung defeated by the environment is not a remedy that
 *    was wrong; it comes back when the environment changes.
 *  - #14: nineteen zero-turn `interrupted` rungs on a phase the board had
 *    read `done` for two weeks were charged against every later phase, so the
 *    `partial --reason context` the console's OWN wrap-up steer asked for was
 *    refused as a spent run budget, Retry could not clear it, and the errand
 *    said the ladder's sessions had failed — with `tried: []`.
 *
 * So: a rung records its CAUSE; `environment` records leave the tried set and
 * the rung caps (dollars still count, and a rung may re-arm five times); the
 * run-rung cap counts only phases the board does not read done, through ONE
 * helper; a clearance is evidence to the healer; the console's own wrap-up
 * resume is not a rung; an operator's Retry forgives what the environment and
 * the console's restarts cost; and a cap errand names its setting and its
 * arithmetic.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { pressActor } = await import('../server/actor.ts');
const model = await import('../shared/ladder-model.js');
const ladder = await import('../server/runner/ladder.ts');
const { FIXTURE_DIR } = await import('./journal-fixture.ts');
type RunState = import('../server/runner/state.ts').RunState;
type RungRecord = import('../server/runner/state.ts').RungRecord;

const {
  RUNG_FAILURE_CAUSES, MAX_ENV_RETRIES_PER_RUNG, countedRungs, triedRungKeys, endedOnEnvironment,
} = model;
const {
  nextRung, openRunRungs, settleRungRecord, capErrand, forgiveRungs, retryForgives, runLadderCaps,
} = ladder;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const T0 = '2026-09-21T10:00:00.000Z';

const rung = (over: Partial<RungRecord> = {}): RungRecord => ({
  situation: 'work-in-progress', rung: 'resume-own-session', params: { mode: 'continue' },
  at: T0, outcome: 'failed', ...over,
});

/* ------------------------------------------------------------------ *
 * LR-1 — a rung records WHY it ended
 * ------------------------------------------------------------------ */

test('LR-1: the cause vocabulary is three words, owned by the shared model and re-exported by identity', () => {
  assert.deepEqual([...RUNG_FAILURE_CAUSES], ['merit', 'environment', 'never-ran']);
  assert.equal(ladder.RUNG_FAILURE_CAUSES, RUNG_FAILURE_CAUSES, 'the server reads the owner, not a copy');
});

test('LR-1: an attempt the machine defeated is environment — a refused credential, no network, a zero-turn transient', () => {
  assert.equal(endedOnEnvironment({ disposition: 'credential-refused', turns: 1, costUsd: 0 }), true);
  assert.equal(endedOnEnvironment({ disposition: 'connectivity', turns: 0, costUsd: 0 }), true);
  assert.equal(endedOnEnvironment({ disposition: 'retry', turns: 0, costUsd: 0 }), true,
    'a transient stop before the first turn never reached the work');
  assert.equal(endedOnEnvironment({ disposition: 'retry', turns: 4, costUsd: 0.8 }), false,
    'a session that worked and then hit a blip is judged on what it did');
  assert.equal(endedOnEnvironment({ disposition: 'phase-failed', turns: 0, costUsd: 0 }), false,
    'the phase failing is a verdict about the phase, whatever it cost');
  assert.equal(endedOnEnvironment({ disposition: 'ok', turns: 0, costUsd: 0 }), false);
});

test('LR-1: settlement stamps a cause on every rung — merit by default, never-ran for a void one, a stamped cause kept', () => {
  const slot = { attempts: 3, lastAt: T0, rungs: [rung({ outcome: 'running' }), rung({ outcome: 'running', cause: 'environment' }), rung({ outcome: 'running' })] };
  const [plain, blamed, voided] = slot.rungs;
  settleRungRecord(slot, plain, 'failed', undefined, 'the record reads failed');
  settleRungRecord(slot, blamed, 'failed', undefined, 'the API refused the credential');
  settleRungRecord(slot, voided, 'withdrawn', undefined, 'the lane never spawned');
  assert.equal(plain.cause, 'merit');
  assert.equal(blamed.cause, 'environment', 'the arm that knew why stamped it first, and settling keeps it');
  assert.equal(voided.cause, 'never-ran');
});

test('LR-1: the runner door reads the credential wall off the record — the rung it ended settles environment', () => {
  const instance = new Runner({ scriptsDir: SCRIPTS, spawn: async () => { throw new Error('no spawn'); } });
  const state = newRun({ slug: 'alpha', root: '/tmp/none', autoRecover: true });
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.attemptStartedAt = '2026-09-21T10:05:00.000Z';
  record.cause = { kind: 'credential-refused', class: 'certificate', reason: 'refused', at: '2026-09-21T10:06:00.000Z' };
  state.recoveries = { 2: { attempts: 1, lastAt: T0, rungs: [rung({ situation: 'resource-wall:auth', rung: 'switch-account', params: undefined, outcome: 'running' })] } } as never;
  (instance as never as { state: RunState }).state = state;
  (instance as never as { record: () => void }).record = () => {};
  (instance as never as { settleRungsAfterAttempt: (p: number, since: string) => void })
    .settleRungsAfterAttempt(2, '2026-09-21T10:04:00.000Z');
  const settled = state.recoveries!['2']!.rungs![0];
  assert.notEqual(settled.outcome, 'running');
  assert.equal(settled.cause, 'environment', `got ${settled.cause ?? 'none'} (${settled.note ?? ''})`);
});

/* ------------------------------------------------------------------ *
 * LR-2 — environment records leave the tried set and the rung caps
 * ------------------------------------------------------------------ */

test('LR-2: an environment record is not TRIED — the rung comes back, up to five times on one phase', () => {
  assert.equal(MAX_ENV_RETRIES_PER_RUNG, 5);
  const env = (n: number) => Array.from({ length: n }, (_, i) => rung({ at: `2026-09-21T10:0${i}:00.000Z`, cause: 'environment' }));
  for (let n = 1; n < MAX_ENV_RETRIES_PER_RUNG; n += 1) {
    assert.deepEqual(countedRungs(env(n)), [], `${n} environment record(s) count for nothing`);
    assert.equal(triedRungKeys(env(n)).size, 0);
    const next = nextRung({ situation: 'work-in-progress', history: env(n) });
    assert.ok(next.ok && next.rung.vehicle === 'resume-own-session', `after ${n} the same rung is offered again`);
  }
  // The bound: the fifth makes the rung a rung that cannot run here, and it is tried.
  assert.equal(countedRungs(env(MAX_ENV_RETRIES_PER_RUNG)).length, MAX_ENV_RETRIES_PER_RUNG);
  const after = nextRung({ situation: 'work-in-progress', history: env(MAX_ENV_RETRIES_PER_RUNG), caps: { perPhaseRungs: 10 } });
  assert.ok(after.ok && after.rung.vehicle === 'reboard-resume-brief', 'the climb moves on to the next rung');
});

test('LR-2: the bound is per rung — two rungs do not pool their environment records', () => {
  const history = [
    ...Array.from({ length: 4 }, () => rung({ cause: 'environment' })),
    ...Array.from({ length: 4 }, () => rung({ rung: 'reboard-resume-brief', params: undefined, cause: 'environment' })),
  ];
  assert.deepEqual(countedRungs(history), []);
});

test('LR-2: dollars still count — money spent on the weather was spent', () => {
  const history = [rung({ cause: 'environment', costUsd: 60 }), rung({ cause: 'environment', costUsd: 45 })];
  assert.deepEqual(countedRungs(history), [], 'no rung is counted…');
  const next = nextRung({ situation: 'work-in-progress', history });
  assert.equal(next.ok, false, '…and yet the phase dollar cap refuses');
  assert.equal(!next.ok && next.cap, 'phase-usd');
});

test('LR-2: a merit record between environment records does not reset the bound — it is a count, not a streak', () => {
  const history = [
    rung({ cause: 'environment' }), rung({ cause: 'environment' }), rung({ rung: 'reboard-resume-brief', params: undefined, cause: 'merit' }),
    rung({ cause: 'environment' }), rung({ cause: 'environment' }), rung({ cause: 'environment' }),
  ];
  assert.equal(countedRungs(history).length, 6, 'five environment records of one rung, plus the merit one');
});

/* ------------------------------------------------------------------ *
 * LR-4 — a standing resource-wall errand dissolves when accounts change
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-21
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api endpoint
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

const OPEN: InstanceType<typeof Service>[] = [];
test.after(() => { for (const svc of OPEN) svc.close(); });

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-rearm-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    allowAccounts: true, scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return svc;
}

type Drive = { started: Record<string, unknown>[]; retried: number[]; switched: string[] };
function stubDrive(svc: InstanceType<typeof Service>): Drive {
  const drive: Drive = { started: [], retried: [], switched: [] };
  const s = svc as never as Record<string, unknown>;
  s.retryPhase = async (_slug: string, phase: number) => { drive.retried.push(phase); return null; };
  s.startRun = async (_slug: string, opts: Record<string, unknown> = {}) => { drive.started.push(opts); return { ok: true, runId: 'stub' }; };
  s.switchAccountRun = (_slug: string, accountId: string) => { drive.switched.push(accountId); return { ok: true }; };
  return drive;
}

/** The accounts the healer asks about, as a test sets them. */
function stubAccounts(svc: InstanceType<typeof Service>, now: { usable: { unusable: number; total: number }; pick: string | null; own: boolean }) {
  (svc as never as { accountsUsable: () => { unusable: number; total: number } }).accountsUsable = () => now.usable;
  const accounts = svc.accounts as never as Record<string, unknown>;
  accounts.pickAccount = () => now.pick;
  accounts.headroom = (id: string | undefined) => (now.own
    ? { ok: true, accountId: id ?? 'default' }
    : { ok: false, accountId: id ?? 'default', kind: 'retired', reason: 'retired' });
  accounts.accountIds = () => ['default', 'backup'];
  // The two the `switch-account` vehicle reads since control-tower phase 78
  // (#100, #106): the horizon-aware picker, and each account's room now.
  accounts.switchCandidates = () => ({ ranked: now.pick ? [now.pick] : [], declined: [], wake: null });
  accounts.roomOf = (id: string | undefined) => (now.own || (id ?? 'default') === now.pick
    ? { ok: true, headroomPct: null, resetsAt: null }
    : { ok: false, headroomPct: 0, resetsAt: null, why: 'retired' });
}

/**
 * The #36 run: phase 2 stopped on the credential wall during the outage, its
 * one `resource-wall:auth` rung failed because every account was unusable,
 * and the errand has stood since 10:55. The shape an older build wrote: the
 * rung carries no cause.
 */
function wallRun(root: string): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'halted';
  state.halt = { at: '2026-09-21T10:52:00.000Z', reason: 'the API refused the run\'s credential', phase: 2, kind: 'credential-refused' };
  state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.note = 'the API refused the credential';
  record.attempts = 1;
  record.cause = { kind: 'credential-refused', reason: 'refused', at: '2026-09-21T10:52:00.000Z' };
  state.recoveries = {
    2: {
      attempts: 1,
      lastAt: '2026-09-21T10:54:00.000Z',
      rungs: [{ situation: 'resource-wall:auth', rung: 'switch-account', at: '2026-09-21T10:54:00.000Z', outcome: 'failed', note: 'no other account had headroom' }],
      errand: {
        phase: 2, situation: 'resource-wall:auth', tried: ['switch-account → failed'], at: '2026-09-21T10:55:14.407Z',
        need: 'A signed-in Claude account for this run.', how: 'Run claude login …, then Continue.',
      },
    },
  } as never;
  saveRun(state);
  return state;
}

function journalled(root: string, runId: string, name: string): Record<string, unknown>[] {
  return readFileSync(journalFile(root, 'alpha', runId), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === name)
    .map((entry) => ({ ...(entry.data as Record<string, unknown> ?? {}), phase: entry.phase }));
}

test('LR-4: the errand stands while nothing is usable, dissolves once an account is, and Recover launches (#36)', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const drive = stubDrive(svc);
    const accounts = { usable: { unusable: 2, total: 2 }, pick: null as string | null, own: false };
    stubAccounts(svc, accounts);
    const run = wallRun(root);

    // Still unusable: nothing changed, so nothing is retracted and nothing starts.
    const held = await svc.maybeAutoRecover('alpha');
    assert.equal(held.launched, false, held.reason);
    assert.ok(loadRun(root, 'alpha', run.id, null)!.recoveries!['2']!.errand, 'the ask is still true');
    assert.equal(journalled(root, run.id, 'phase.errand-cleared').length, 0);

    // The operator clears the accounts; another one reads usable.
    accounts.usable = { unusable: 1, total: 2 };
    accounts.pick = 'backup';
    const out = await svc.maybeAutoRecover('alpha');

    const cleared = journalled(root, run.id, 'phase.errand-cleared');
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].reason, 'accounts-changed');
    assert.equal(cleared[0].phase, 2);
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'switch-account', 'the one rung for the wall is climbable again');
    assert.deepEqual(drive.switched, ['backup']);
    const slot = loadRun(root, 'alpha', run.id, null)!.recoveries!['2']!;
    assert.ok(slot.rungs!.some((r) => r.forgiven?.by === 'accounts-changed'),
      'the rung the outage defeated is forgiven, and says who forgave it');
  } finally { cleanup(); }
});

test('LR-4: with the run\'s OWN account usable again, switch-account continues under it rather than refusing', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const drive = stubDrive(svc);
    stubAccounts(svc, { usable: { unusable: 1, total: 2 }, pick: null, own: true });
    // The operator's clearance, written after the wall (10:52).
    (svc.accounts as never as Record<string, unknown>).entitlementOf = () => ({ state: 'unknown', at: '2026-09-21T13:20:00.000Z', via: 'credential' });
    wallRun(root);
    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.deepEqual(drive.switched, [], 'there is nothing to switch to, and nothing needs switching');
    assert.equal(drive.started.length, 1, 'the run relaunches under the account it already has');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * LR-5 — the run-rung cap counts open phases, through ONE helper
 * ------------------------------------------------------------------ */

function fixture31285928(): RunState {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'customer-app-ios-release', 'run-31285928.json'), 'utf8')) as RunState;
}

test('LR-5: run 31285928 — nineteen counted rungs sit on a done phase, and phase 9 climbs (#14)', () => {
  const raw = fixture31285928();
  const board: Record<number, string> = { 3: 'done', 4: 'stuck', 6: 'done', 7: 'done', 8: 'done', 9: 'in-progress' };
  const all = Object.values(raw.recoveries ?? {}).flatMap((slot) => slot.rungs ?? []);
  assert.equal(countedRungs(all).length, 20, 'the fixture reproduces #14: twenty counted rungs across the run');
  const run = openRunRungs(raw.recoveries, (phase) => board[phase] === 'done');
  assert.equal(run.open, 1, 'phase 4\'s one rung is the only open one');
  assert.equal(run.onDonePhases, 19, 'phase 3\'s nineteen closed with their phase');
  const next = nextRung({ situation: 'work-in-progress', history: [], run, caps: { perRunRungs: 20 } });
  assert.ok(next.ok, !next.ok ? next.reason : '');
  assert.equal(next.ok && next.rung.vehicle, 'resume-own-session');
  // The dollar cap counts every record, done phases included.
  const spent = all.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  assert.equal(run.usd, spent);
});

test('LR-5: the open count is still a cap — open phases alone can spend it', () => {
  const recoveries = { 1: { rungs: [rung(), rung({ rung: 'reboard-resume-brief', params: undefined })] }, 2: { rungs: [rung()] } };
  const run = openRunRungs(recoveries, () => false);
  assert.equal(run.open, 3);
  const next = nextRung({ situation: 'never-started', history: [], run, caps: { perRunRungs: 3 } });
  assert.equal(!next.ok && next.cap, 'run-rungs');
});

test('LR-5: ONE counter — the heal gate and the climb read openRunRungs, and totalAttempts is gone', () => {
  const server = join(SKILL_DIR, 'viewer', 'server');
  const recovery = readFileSync(join(server, 'service-recovery.ts'), 'utf8');
  const climb = readFileSync(join(server, 'runner', 'runner.ts'), 'utf8');
  assert.doesNotMatch(recovery, /totalAttempts/, 'the raw Σ attempts counter is gone');
  assert.match(recovery, /openRunRungs\(/, 'the heal gate counts through the helper');
  assert.match(climb, /openRunRungs\(/, 'and so does the runner\'s climb');
  const src = readFileSync(join(server, 'runner', 'ladder.ts'), 'utf8');
  assert.doesNotMatch(src, /countedRungs\(input\.runHistory/, 'nextRung no longer counts a flat run history itself');
});

/* ------------------------------------------------------------------ *
 * LR-6 — the console's own wrap-up resume spends no rung
 * ------------------------------------------------------------------ */

function partialRunner(opts: { wrapup: boolean; reason?: string }) {
  const instance = new Runner({ scriptsDir: SCRIPTS, spawn: async () => { throw new Error('no spawn'); } });
  const state = newRun({ slug: 'alpha', root: '/tmp/none', autoRecover: true });
  const record = phaseRecord(state, 9);
  record.status = 'running';
  record.sessionId = 'sess-9';
  record.attemptStartedAt = '2026-09-20T09:00:00.000Z';
  if (opts.wrapup) {
    record.contextWrapup = { sessionId: 'sess-9', at: '2026-09-20T11:49:12.000Z', context: 606_000, window: 1_000_000, delivered: true };
  }
  // Twenty counted rungs on an OPEN phase, so the cap WOULD refuse a rung.
  state.recoveries = { 4: { attempts: 20, lastAt: T0, rungs: Array.from({ length: 20 }, (_, i) => rung({ at: `2026-09-06T05:${String(i).padStart(2, '0')}:00.000Z`, rung: `r${i}`, params: undefined })) } } as never;
  const events: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const handle = instance as never as Record<string, unknown>;
  handle.state = state;
  handle.record = (event: string, data: Record<string, unknown> = {}, phase?: number) => { events.push({ event, data, phase }); };
  handle.persist = () => {};
  handle.persistNow = () => {};
  handle.emit = () => {};
  const board = { phased: true, states: { 4: 'stuck', 9: 'in-progress' }, done: [], inProgress: [9], stuck: [4], ready: [], waiting: [], blockedBy: {} };
  const route = () => (handle.routeOutcome as (p: number, d: unknown, b: unknown) => Promise<string | null>).call(
    instance, 9, { status: 'partial', reason: opts.reason ?? 'context', watch: [], written_at: '2026-09-20T11:56:32.000Z' }, board,
  );
  return { state, record, events, route };
}

test('LR-6: partial --reason context after the same attempt\'s wrap-up re-boards fresh with the brief, and spends no rung (#14)', async () => {
  const { state, record, events, route } = partialRunner({ wrapup: true });
  const verdict = await route();
  assert.equal(verdict, 'waiting');
  assert.equal(state.recoveries?.['9']?.rungs?.length ?? 0, 0, 'no rung was accounted for the console\'s own resume');
  assert.equal(record.status, 'pending');
  assert.equal(record.boardingHint?.brief, 'resume', 'fresh, with the resume brief');
  assert.equal(record.boardingHint?.sessionId, undefined, 'never a --resume of the session whose context was the bill');
  const resumed = events.filter((e) => e.event === 'phase.resume-automatic');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].data.path, 'wrapup');
  assert.equal(events.filter((e) => e.event === 'phase.ladder-refused' || e.event === 'phase.errand').length, 0,
    'the spent run cap was never asked');
});

test('LR-6: budget is the other wrap-up reason; a partial with no wrap-up steer is still a rung', async () => {
  const budget = partialRunner({ wrapup: true, reason: 'budget' });
  await budget.route();
  assert.equal(budget.events.filter((e) => e.event === 'phase.resume-automatic' && e.data.path === 'wrapup').length, 1);

  const plain = partialRunner({ wrapup: false });
  await plain.route();
  assert.equal(plain.events.filter((e) => e.event === 'phase.resume-automatic').length, 0,
    'a session that chose to stop was not steered to — its resume is the ladder\'s to price');
  assert.ok(plain.events.some((e) => e.event === 'phase.ladder-refused' || e.event === 'phase.rung'),
    'the ordinary climb ran');
});

/* ------------------------------------------------------------------ *
 * LR-7 — an operator's Retry replenishes the phase's ladder
 * ------------------------------------------------------------------ */

function spentSlot(): { attempts: number; lastAt: string; rungs: RungRecord[] } {
  return {
    attempts: 6,
    lastAt: T0,
    rungs: [
      rung({ outcome: 'interrupted', costUsd: 0 }),
      rung({ outcome: 'interrupted', costUsd: 0 }),
      rung({ outcome: 'interrupted', costUsd: 0 }),
      rung({ rung: 'reboard-resume-brief', params: undefined, cause: 'environment', costUsd: 4 }),
      rung({ rung: 'reboard-resume-brief', params: undefined, cause: 'environment', costUsd: 4 }),
      rung({ rung: 'reboard-resume-brief', params: { escalate: 'model' }, cause: 'merit', costUsd: 10 }),
    ],
  };
}

test('LR-7: what a Retry forgives — interruptions and environment records, never a verdict', () => {
  const slot = spentSlot();
  assert.equal(countedRungs(slot.rungs).length, 4, 'three interruptions in a row count, and the merit record');
  const forgiven = forgiveRungs(slot, retryForgives, '2026-09-21T12:00:00.000Z', 'operator');
  assert.equal(forgiven.length, 5);
  assert.deepEqual(countedRungs(slot.rungs).map((r) => r.cause), ['merit'], 'the one real verdict stands');
  assert.ok(slot.rungs.slice(0, 5).every((r) => r.forgiven?.by === 'operator' && r.forgiven.at === '2026-09-21T12:00:00.000Z'));
  assert.equal(slot.rungs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0), 18, 'dollars are untouched');
  assert.equal(forgiveRungs(slot, retryForgives, '2026-09-21T13:00:00.000Z', 'operator').length, 0, 'forgiving is once');
});

test('LR-7: the live Retry press replenishes and journals it; the console\'s own retry does not', () => {
  const make = () => {
    const instance = new Runner({ scriptsDir: SCRIPTS, spawn: async () => { throw new Error('no spawn'); } });
    const state = newRun({ slug: 'alpha', root: '/tmp/none', autoRecover: true });
    phaseRecord(state, 9).status = 'parked';
    state.recoveries = { 9: spentSlot() } as never;
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const handle = instance as never as Record<string, unknown>;
    handle.state = state;
    handle.record = (event: string, data: Record<string, unknown> = {}) => { events.push({ event, data }); };
    handle.persist = () => {};
    handle.emit = () => {};
    return { instance, state, events };
  };
  const press = make();
  press.instance.retry(9, undefined, { press: true });
  const replenished = press.events.filter((e) => e.event === 'phase.ladder-replenished');
  assert.equal(replenished.length, 1);
  assert.equal(replenished[0].data.forgiven, 5);
  assert.deepEqual(countedRungs(press.state.recoveries!['9']!.rungs!).length, 1);

  const console = make();
  console.instance.retry(9, undefined, { press: false });
  assert.equal(console.events.filter((e) => e.event === 'phase.ladder-replenished').length, 0);
  assert.equal(countedRungs(console.state.recoveries!['9']!.rungs!).length, 4, 'a door that is not a person forgives nothing');
});

test('LR-7: the stored-run Retry press replenishes too', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    // A stored run nothing drives: the retry edits it on disk, then starts it —
    // the real `retryPhase`, so only the start is stubbed.
    (svc as never as Record<string, unknown>).startRun = async () => ({ ok: true, runId: 'stub' });
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
    phaseRecord(state, 2).status = 'parked';
    state.recoveries = { 2: spentSlot() } as never;
    saveRun(state);
    await svc.retryPhase('alpha', 2, undefined, pressActor({ by: 'operator', via: 'api' } as never));
    const disk = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(countedRungs(disk.recoveries!['2']!.rungs!).length, 1);
    const lines = journalled(root, state.id, 'phase.ladder-replenished');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].forgiven, 5);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * LR-8 — a cap errand tells the truth
 * ------------------------------------------------------------------ */

test('LR-8: the cap errand carries its arithmetic, its setting and the done-phase share — never budgets', () => {
  const next = nextRung({
    situation: 'work-in-progress', history: [], run: { open: 20, onDonePhases: 19, usd: 0 }, caps: { perRunRungs: 20 },
  });
  assert.equal(!next.ok && next.cap, 'run-rungs');
  const errand = capErrand(next, { phase: 9, tried: [], at: '2026-09-20T11:56:33.000Z', onDonePhases: 19, replenishes: false });
  assert.equal(errand.cap, 'run-rungs');
  assert.equal(errand.spent, 20);
  assert.equal(errand.limit, 20);
  assert.equal(errand.onDonePhases, 19);
  assert.equal(errand.setting, 'ladderPerRunRungs');
  assert.notEqual(errand.decisionKey, 'budgets', 'no manifest answer lifts a cap, so none is pointed at');
  assert.match(errand.need, /20 of 20/);
  assert.match(errand.need, /19/);
  assert.match(errand.how, /ladderPerRunRungs/);
  assert.doesNotMatch(`${errand.need} ${errand.how}`, /sessions did not carry it/,
    'with tried empty, no ladder session ran for this phase — the errand must not say one failed');
  assert.equal(errand.replenishes, false);
});

test('LR-8: each cap names its own setting', () => {
  const cases: [Parameters<typeof nextRung>[0], string][] = [
    [{ situation: 'never-started', history: [rung(), rung({ rung: 'x' }), rung({ rung: 'y' })] }, 'ladderPerPhaseRungs'],
    [{ situation: 'never-started', history: [rung({ costUsd: 100 })] }, 'ladderPerPhaseUsd'],
    [{ situation: 'never-started', history: [], run: { open: 0, onDonePhases: 0, usd: 400 } }, 'ladderPerRunUsd'],
    [{ situation: 'never-started', history: [], dayHistory: [rung({ costUsd: 600 })] }, 'ladderPerDayUsd'],
  ];
  for (const [input, setting] of cases) {
    const next = nextRung(input);
    assert.equal(next.ok, false, setting);
    assert.equal(capErrand(next, { phase: 1, tried: [], at: T0, onDonePhases: 0, replenishes: false }).setting, setting);
  }
});

test('LR-8: the healer\'s run-wide gate writes the honest errand, never "recovery budget is spent (N launches)"', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubDrive(svc);
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.halt = { at: T0, reason: 'nothing left to run on its own', kind: 'nothing-ready' };
    state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
    const record = phaseRecord(state, 2);
    record.status = 'failed';
    record.note = 'the phase failed';
    record.endedAt = T0;
    // One counted rung on the OPEN phase 3 spends a per-run cap of one — set
    // on the RUN, which beats the console's preference (criterion 9).
    state.recoveries = { 3: { attempts: 1, lastAt: T0, rungs: [rung({ situation: 'verify-red', rung: 'fix-agent', params: { escalate: 'model' } })] } } as never;
    (state as never as { ladderPerRunRungs: number }).ladderPerRunRungs = 1;
    saveRun(state);
    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.doesNotMatch(out.reason ?? '', /launches/, 'the old sentence counted launches nobody made');
    const errand = loadRun(root, 'alpha', state.id, null)!.recoveries?.['2']?.errand;
    assert.ok(errand, `the person is told (${out.reason})`);
    assert.equal(errand!.setting, 'ladderPerRunRungs');
    assert.equal(errand!.spent, 1);
    assert.equal(errand!.limit, 1);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Criterion 9 — a per-run rung cap beats the preference
 * ------------------------------------------------------------------ */

test('criterion 9: the run\'s own rung caps beat the console\'s preferences, and silence inherits them', () => {
  const prefs = { ladderPerRunRungs: 20, ladderPerPhaseRungs: 3 };
  assert.equal(runLadderCaps({ ladderPerRunRungs: 40 }, prefs).perRunRungs, 40);
  assert.equal(runLadderCaps({ ladderPerPhaseRungs: 5 }, prefs).perPhaseRungs, 5);
  assert.equal(runLadderCaps({}, prefs).perRunRungs, 20, 'no run value: the preference speaks');
  assert.equal(runLadderCaps({ ladderPerRunRungs: null }, prefs).perRunRungs, 20, 'a cleared field is silence');
  assert.equal(runLadderCaps(null, undefined).perRunRungs, ladder.DEFAULT_LADDER_CAPS.perRunRungs);
});

test('criterion 9: a Continue applies the run\'s own rung caps — a number sets one, null hands it back, silence keeps it', async () => {
  // The start door reads both caps, and a Continue IS the start door. Only
  // `newRun` copied them, so a cap typed on Continue reached the run as
  // silence — and an emptied box could never give a cap back to Settings.
  const { root, cleanup } = scratch();
  try {
    const state = newRun({ slug: 'alpha', root, ladderPerRunRungs: 12 });
    state.status = 'halted';
    saveRun(state);
    const cont = async (over: Record<string, unknown>): Promise<RunState> => {
      const runner = new Runner({} as never);
      // Stop after the setup this test is about: `drive()` would spawn `claude`.
      (runner as never as { drive: () => Promise<void> }).drive = async () => {};
      await runner.start({ slug: 'alpha', root, resumeRunId: state.id, ...over } as never);
      const after = runner.current()!;
      runner.close?.();
      return after;
    };

    assert.equal((await cont({})).ladderPerRunRungs, 12, 'silence on a Continue keeps what the run is');
    const set = await cont({ ladderPerRunRungs: 40, ladderPerPhaseRungs: 0 });
    assert.equal(set.ladderPerRunRungs, 40);
    assert.equal(set.ladderPerPhaseRungs, 0, 'zero is a cap: nothing climbs');
    const cleared = await cont({ ladderPerRunRungs: null });
    assert.equal('ladderPerRunRungs' in cleared, false, 'null — an emptied box — hands the run back to the preference');
    assert.equal(cleared.ladderPerPhaseRungs, 0, 'the other cap is untouched');
    assert.equal(loadRun(root, 'alpha', state.id, null)?.ladderPerPhaseRungs, 0, 'and it is written down');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * UW-4 / UW-5 — the drive loop's memory of what it has seen expires (#114)
 *
 * `ladderSeen` is what stops a hot loop: an unchanged record is not climbed
 * twice in a row. It had no expiry and nothing cleared it, so a phase the
 * first climb deferred (or found no rung for) was skipped FOREVER once the
 * world changed underneath an unchanged record — a usage wall lifting, a
 * lane freeing, the handoff moving on. Measured: four phases, 13–23 hours
 * each, inside runs that kept driving everything else. The expiry is a
 * stamp BESIDE the fingerprint, never in it (phase 51's rule: a clock in a
 * fingerprint makes every pass a change).
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pass for real, with `climb` recording who it was handed and leaving the record as it was. */
class SeenProbe extends Runner {
  climbed: number[] = [];
  clock = Date.parse(T0);
  fake = true;

  install(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
  }

  async pass(board: unknown): Promise<void> {
    await (this as unknown as { climbLadder(b: unknown, asked: Set<number> | null): Promise<void> }).climbLadder(board, null);
  }

  protected override now(): Date { return this.fake ? new Date(this.clock) : new Date(); }

  protected override async climb(record: { phase: number }): Promise<boolean> {
    this.climbed.push(record.phase);
    return false;
  }
}

function seenProbe(extra: Record<string, unknown> = {}): { probe: SeenProbe; state: RunState } {
  const probe = new SeenProbe({ scriptsDir: '/nonexistent', verificationText: () => undefined, ...extra } as never);
  const state = newRun({ slug: 'alpha', root: '/nowhere', autoRecover: true });
  const record = phaseRecord(state, 1);
  record.status = 'pending';
  record.attempts = 1;
  record.resumeSessionId = 'sess-1';
  record.situation = { key: 'resource-wall:usage', at: T0, why: ['a usage limit'] };
  probe.install(state);
  return { probe, state };
}

/** Phase 1 in progress on the board, 2 waiting on it. */
const IN_PROGRESS = {
  phased: true, states: { 1: 'in-progress', 2: 'waiting' }, done: [], inProgress: [1], stuck: [],
  ready: [], waiting: [2], blockedBy: { 2: [1] }, qa: {},
};

test('UW-4: a seen fingerprint expires — an unchanged pending phase is looked at again once its time is up, and not before', async () => {
  const { probe } = seenProbe({ ladderSeenTtlMs: () => 5 * MINUTE });
  await probe.pass(IN_PROGRESS);
  probe.clock += 4 * MINUTE;
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1], 'inside the window the unchanged record is not climbed twice — the hot-loop guard stands');
  probe.clock += 2 * MINUTE;
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1, 1], 'past it, the same record is re-judged');
});

test('UW-4: the default expiry is the convergence cadence, and the loop wakes itself when a seen phase expires', async () => {
  const core = await import('../server/runner/runner-core.ts');
  const { prefDefault } = await import('../server/config.ts');
  assert.equal((core as unknown as { LADDER_SEEN_TTL_MS: number }).LADDER_SEEN_TTL_MS, prefDefault('convergeEveryMs').value,
    'the drive loop re-examines what it skipped as often as the healer re-examines a stopped run');

  // No event would otherwise end the loop's sleep: a lane can run for hours.
  const { probe } = seenProbe({ ladderSeenTtlMs: () => 40 });
  probe.fake = false;
  await probe.pass(IN_PROGRESS);
  const wake = (probe as unknown as { wake: { promise: Promise<void> } }).wake.promise;
  const answer = await Promise.race([wake.then(() => 'woke'), sleep(2_000).then(() => 'slept')]);
  assert.equal(answer, 'woke', 'the expiry wakes the loop, so the re-check happens without an outside event');
  await probe.stop().catch(() => undefined);
});

test('UW-4: the service wires it — the expiry is the convergence cadence read live (never zero), the switch rung reads room, the healer judges the live account', async () => {
  const core = await import('../server/runner/runner-core.ts');
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const runner = (svc as never as { makeRunner(): { deps: Record<string, unknown>; close?: () => void } }).makeRunner();
    const deps = runner.deps as { ladderSeenTtlMs?: () => number; accountRoom?: unknown };
    const prefs = (svc as never as { prefs: { convergeEveryMs?: number } }).prefs;
    prefs.convergeEveryMs = 120_000;
    assert.equal(deps.ladderSeenTtlMs?.(), 120_000, 'a cadence changed in Settings applies to the next look');
    prefs.convergeEveryMs = 0;
    assert.equal(deps.ladderSeenTtlMs?.(), core.LADDER_SEEN_TTL_MS, 'zero switches converge off — it is never a zero expiry, which would re-climb every record every tick');
    assert.equal(typeof deps.accountRoom, 'function', 'the loop\'s switch-account rung weighs a target\'s room');
    runner.close?.();

    // #106 in the healer: the run's CURRENT account, judged by the quota door.
    (svc as never as { preflightAccount: (id?: string) => unknown }).preflightAccount = (id?: string) => (id === 'walled'
      ? { ok: false, accountId: id, kind: 'wall', resetsAt: '2026-09-26T15:00:00.000Z', reason: 'walled' }
      : { ok: true, accountId: id ?? 'default' });
    const asked: (string | undefined)[] = [];
    const door = (svc as never as { preflightAccount: (id?: string, model?: string) => unknown }).preflightAccount;
    (svc as never as { preflightAccount: (id?: string, model?: string) => unknown }).preflightAccount = (id?: string, model?: string) => {
      asked.push(model);
      return door(id, model);
    };
    const evidence = (svc as never as { evidenceDeps(slug: string): { account?: (run: unknown, phase: number) => unknown } }).evidenceDeps('alpha');
    const run = { accountId: 'walled', model: 'sonnet', phases: { 2: { phase: 2, model: 'opus' } } };
    assert.deepEqual(await evidence.account?.(run, 2), { id: 'walled', ok: false, resetsAt: '2026-09-26T15:00:00.000Z' });
    assert.deepEqual(await evidence.account?.({ model: 'sonnet', phases: {} }, 1), { id: 'default', ok: true }, 'the machine login, with room');
    assert.deepEqual(asked, ['opus', 'sonnet'], 'judged for the model the phase boards under');
  } finally { cleanup(); }
});

test('UW-5: walls lifting clears what was seen — a spend that lifted the account\'s walls re-arms the pass', async () => {
  let lifted: string[] = ['five_hour'];
  const { probe } = seenProbe({ ladderSeenTtlMs: () => HOUR, noteSpend: () => ({ lifted, cooled: false }) });
  const spent = () => (probe as unknown as {
    noteSpendProof(phase: number, account: string, request: unknown, outcome: unknown, booked: number): void;
  }).noteSpendProof(2, 'default', { model: 'opus' }, { signal: { subtype: 'success' }, endedBy: 'exit' }, 0.5);
  await probe.pass(IN_PROGRESS);
  lifted = [];
  spent();
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1], 'a spend that lifted nothing changes nothing');
  lifted = ['five_hour'];
  spent();
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1, 1], 'run.walls-lifted is new information');
});

test('UW-5: a fresh usage reading with room clears a wall-classified phase — and a reading that still walls does not', async () => {
  let open = false;
  const { probe } = seenProbe({
    ladderSeenTtlMs: () => HOUR,
    accountHeadroom: (id?: string) => (open
      ? { ok: true, accountId: id ?? 'default' }
      : { ok: false, accountId: id ?? 'default', kind: 'wall', resetsAt: '2026-09-21T15:00:00.000Z', reason: 'walled' }),
  });
  await probe.pass(IN_PROGRESS);
  probe.rereadWalls('reading');
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1], 'still walled: nothing new');
  open = true;
  probe.rereadWalls('reading');
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1, 1], 'the wall it was classified on is gone');
});

test('UW-5: a lane freeing on the phase\'s scope clears it — one on a disjoint scope does not', async () => {
  const { probe } = seenProbe({
    ladderSeenTtlMs: () => HOUR,
    phaseScope: async (_slug: string, phase: number) => (phase === 3 ? ['web'] : ['app']),
  });
  const freed = (phase: number, scope: string[]) =>
    (probe as unknown as { noteLaneFreed(phase: number, scope: readonly string[]): void }).noteLaneFreed(phase, scope);
  await probe.pass(IN_PROGRESS);
  freed(3, ['web']);
  probe.clock += 1;
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1], 'a lane on another repository frees nothing phase 1 was waiting on');
  freed(2, ['app']);
  probe.clock += 1;
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1, 1], 'a lane on its own scope may be what it was waiting on');
});

test('UW-5: the handoff changing clears it — its Outstanding is an input, like the board word', async () => {
  let outstanding = 'finish the parser';
  const { probe } = seenProbe({
    ladderSeenTtlMs: () => HOUR,
    handoffFor: () => ({ exists: true, status: 'in-progress', outstanding }),
  });
  await probe.pass(IN_PROGRESS);
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1]);
  outstanding = 'finish the parser, then the docs';
  await probe.pass(IN_PROGRESS);
  assert.deepEqual(probe.climbed, [1, 1], 'a docs change to its handoff is new evidence');
});

/* ------------------------------------------------------------------ *
 * RS-6 — a rung the console supersedes before its first turn (control-tower
 * phase 86, #14's comment of 2026-09-22T23:49:55Z; run 86103bfe79aa seq 123–148)
 * ------------------------------------------------------------------ */

test('RS-6: a rung the console supersedes before its first turn settles withdrawn — uncounted, never in an errand\'s tried (#14)', async () => {
  const { boardHarness } = await import('./lane-harness.ts');
  const h = boardHarness({ states: { 1: 'in-progress' } });
  const at = new Date(Date.now() - 60_000).toISOString();
  const state = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  state.status = 'parked';
  // seq 123: `resume-own-session {mode: continue}` climbed; seq 140: the
  // policy says `fresh` — a 363,915-token context, cold.
  Object.assign(phaseRecord(state, 1), {
    status: 'pending', attempts: 1, sessionId: 's-cold',
    tokens: [{ sessionId: 's-cold', endedAt: new Date(Date.now() - 6_400_000).toISOString(), lastContext: 363_915, window: 1_000_000, account: 'default' }],
    boardingHint: { situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 's-cold', at, by: 'drive' },
  });
  state.recoveries = { 1: { attempts: 1, lastAt: at, rungs: [rung({ rung: 'resume-own-session', params: { mode: 'continue' } as never, at, outcome: 'running' })] } };
  saveRun(state);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: state.id, maxParallel: 1 } as never);
  await h.runner.wait();

  const rungs = h.runner.current()!.recoveries!['1'].rungs!;
  const superseded = rungs.find((r) => r.rung === 'resume-own-session')!;
  assert.equal(superseded.outcome, 'withdrawn', 'it never ran: the resume policy turned continue into fresh before its first turn');
  assert.match(String(superseded.note), /superseded before its first turn/);
  const ran = rungs.find((r) => r.rung === 'reboard-resume-brief');
  assert.ok(ran, 'what did run is accounted as itself');
  assert.equal(ran!.outcome, 'fixed', 'and settles by what that boarding did');
  assert.ok(!model.countedRungs(rungs).some((r: RungRecord) => r.rung === 'resume-own-session'), 'the cap never counts it');
  const errand = ladder.errandFor('work-in-progress', rungs, 1);
  assert.ok(!errand.tried.some((t: string) => /resume-own-session/.test(t)), `the errand does not say it was tried: ${errand.tried.join(' · ')}`);
  assert.ok(errand.tried.some((t: string) => /reboard-resume-brief/.test(t)), 'it names what did run');
});

test('RS-6: errandFor leaves every withdrawn rung out of tried — both errand paths pass the raw history', () => {
  const errand = ladder.errandFor('work-in-progress', [
    rung({ rung: 'resume-own-session', outcome: 'withdrawn' }),
    rung({ rung: 'reboard-resume-brief', outcome: 'failed' }),
  ], 1);
  assert.equal(errand.tried.length, 1);
  assert.match(errand.tried[0], /reboard-resume-brief/);
});
