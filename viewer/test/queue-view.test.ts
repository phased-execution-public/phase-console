/**
 * The queue, SEEN — the whole queue of one console on one page and one API
 * answer (control-tower phase 99, #135 A and J, #67's last ask).
 *
 * `GET /api/queue` said what an entry waited on and nothing about why it sat
 * where it did; the holder of a lane polling its own job for an hour read as a
 * working lane (#67); a hinted phase was a list with nothing to press.
 *
 *   QV-1  every entry with its plan, phase, title, class, seniority clocks,
 *         holder, account and the REASON it sits where it does — the scan's
 *         own keys in words — in scan order;
 *   QV-2  who holds what: a holder lane in a wait chain is named as such
 *         ("polling its own job, N min" — #67), on the entry and on the lane;
 *         a BRANCH hold names the holder run, its phases left and its ETA, and
 *         carries the two escapes (#150's ask 3);
 *   QV-3  hinted-not-queued phases appear with their hint time and can be
 *         queued from the view — the row carries the press, and the press
 *         takes the run's next lane;
 *   QV-7  the API answers everything the view shows, and the verbs are
 *         routes: `POST /api/queue/{bump,hold,release,defer,withdraw,requeue,reorder}`,
 *         each naming an entry or `{slug, phase}`, each journalled on the run.
 * (QV-4..6 are in `queue-order.test.ts`.)
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boardHarness } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler } = await import('../server/runner/scheduler.ts');
const { queueView } = await import('../server/queue-view.ts');
const { newRun, phaseRecord, saveRun, loadRun } = await import('../server/runner/state.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { QUEUE_ORDER_KEYS } = await import('../shared/orchestration-model.js');
import type { LockView } from '../server/runner/scheduler.ts';
import type { RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const RA = 'aaaaaaaaaaaa';
const RB = 'bbbbbbbbbbbb';
const RC = 'cccccccccccc';

const lockOnApp: LockView = {
  slug: 'other', phase: 9, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: Date.now() + 60 * MIN,
};

async function settle(scheduler: InstanceType<typeof Scheduler>, n: number): Promise<void> {
  for (let i = 0; i < 40 && scheduler.snapshot().entries.length < n; i++) await tick();
  await tick();
}

/* ================================================================== *
 * QV-1 — every entry, and why it sits where it does
 * ================================================================== */

test('QV-1: every entry names its plan, phase, class, clocks, holder, account and the reason it sits where it does', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [lockOnApp] });
  const now = Date.now();
  const admit = (request: Parameters<typeof scheduler.admit>[0]): void => { scheduler.admit(request).catch(() => {}); };
  admit({ slug: 'alpha', phase: 1, runId: RA, scope: ['app'], since: now - 8 * MIN });
  admit({ slug: 'beta', phase: 2, runId: RB, scope: ['app'], priority: 'high' });
  admit({ slug: 'alpha', phase: 3, runId: RA, scope: ['app'], control: { bump: { at: ago(MIN), by: 'operator', reason: 'unblocks P4', stamp: now - MIN } } });
  admit({ slug: 'gamma', phase: 4, runId: RC, scope: ['app'], aged: true, accountId: 'work' });
  admit({ slug: 'alpha', phase: 5, runId: RA, scope: ['app'], awaiting: () => [1] });
  await settle(scheduler, 5);

  const alpha = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  alpha.id = RA;
  phaseRecord(alpha, 3).queueControl = { bump: { at: ago(MIN), by: 'operator', reason: 'unblocks P4', stamp: now - MIN } };
  const view = queueView({
    snapshot: scheduler.snapshot(), hinted: [], runs: [alpha], now: Date.now(),
    title: (slug, phase) => `${slug} phase ${phase} title`,
  });

  const byPhase = new Map(view.entries.map((entry) => [entry.phase, entry]));
  assert.equal(byPhase.get(4)!.reason.key, 'reserved');
  assert.equal(byPhase.get(2)!.reason.key, 'class');
  assert.equal(byPhase.get(3)!.reason.key, 'bumped');
  assert.match(byPhase.get(3)!.reason.text, /moved ahead by operator — unblocks P4/, 'who moved it and why, on the entry');
  assert.equal(byPhase.get(1)!.reason.key, 'seniority');
  assert.match(byPhase.get(1)!.reason.text, /first come, first served — waiting since .*, 8 min/);
  assert.equal(byPhase.get(5)!.reason.key, 'dependency');
  for (const entry of view.entries) {
    assert.ok((QUEUE_ORDER_KEYS as readonly string[]).includes(entry.reason.key));
    assert.equal(entry.title, `${entry.slug} phase ${entry.phase} title`);
    assert.ok(entry.class === 'high' || entry.class === 'normal', 'the class is always named, `normal` included');
    assert.equal(entry.clocks.since, new Date(entry.since).toISOString());
    assert.equal(typeof entry.clocks.waitedMs, 'number');
    assert.ok(entry.account, 'the account it will board on');
    assert.ok(entry.waits.length > 0, 'what it waits on, in words');
    assert.equal(typeof entry.position, 'number');
  }
  assert.equal(byPhase.get(4)!.account, 'work');
  assert.equal(byPhase.get(1)!.account, 'default');
  assert.match(byPhase.get(1)!.waits, /other P9 — a lock, lease ends/);
  assert.deepEqual(view.entries.map((entry) => entry.position), [1, 2, 3, 4, 5], 'the page reads them in the order they will board');
  assert.deepEqual(view.entries.map((entry) => entry.phase).slice(0, 3), [4, 2, 3], 'reserved, then class, then the bump');
  scheduler.close();
});

/* ================================================================== *
 * QV-2 — who holds what
 * ================================================================== */

test('QV-2: a holder lane polling its own job is named as such — on the entry behind it and on the lane (#67)', async () => {
  const scheduler = new Scheduler({ max: 4 });
  const lane = await scheduler.admit({ slug: 'alpha', phase: 1, runId: RA, scope: ['app'] });
  scheduler.admit({ slug: 'beta', phase: 2, runId: RB, scope: ['app'] }).catch(() => {});
  await settle(scheduler, 1);
  const alpha = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  alpha.id = RA;
  phaseRecord(alpha, 1).stall = {
    signal: 'external-wait', since: ago(12 * MIN), detail: '…', scope: 'local', source: 'open',
    chain: { key: 'grep -q GATE-EXIT /tmp/p9.log', calls: 3 },
  } as never;
  const view = queueView({ snapshot: scheduler.snapshot(), hinted: [], runs: [alpha], now: Date.now() });

  const [entry] = view.entries;
  assert.equal(entry!.waitingOn[0]!.kind, 'grant');
  assert.equal(entry!.waitingOn[0]!.laneWait?.text, 'polling its own job, 12 min');
  assert.match(entry!.waits, /alpha P1 — a live lane, polling its own job, 12 min/);
  const [row] = view.lanes;
  assert.equal(row!.slug, 'alpha');
  assert.equal(row!.phase, 1);
  assert.equal(row!.wait?.text, 'polling its own job, 12 min');
  assert.equal(row!.wait?.calls, 3);
  assert.deepEqual(row!.behind, [{ slug: 'beta', phase: 2 }], 'the lane says who it is holding up');

  // On somebody else's clock instead: said as that.
  phaseRecord(alpha, 1).stall = { signal: 'external-wait', since: ago(7 * MIN), detail: '…', scope: 'external' } as never;
  const outside = queueView({ snapshot: scheduler.snapshot(), hinted: [], runs: [alpha], now: Date.now() });
  assert.equal(outside.lanes[0]!.wait?.text, 'waiting on an outside clock, 7 min');
  // A lane that is working needs no excuse.
  delete phaseRecord(alpha, 1).stall;
  assert.equal(queueView({ snapshot: scheduler.snapshot(), hinted: [], runs: [alpha], now: Date.now() }).lanes[0]!.wait, undefined);
  scheduler.release(lane);
  scheduler.close();
});

test('QV-2: a branch hold names the holder run, its phases left and its ETA, and offers the two escapes (#150)', async () => {
  const scheduler = new Scheduler({
    max: 4,
    etaFor: (slug: string, phase: number | null) => (slug === 'beta' && phase === null
      ? { label: 'plan remaining ~2–4 h of work', of: 'plan', remainingWeight: 300, remainingPhases: 3 } : undefined),
  } as never);
  scheduler.admit({
    slug: 'alpha', phase: 7, runId: RA, scope: ['app'],
    branchHold: () => ({ slug: 'beta', run: RB, repo: 'app', branch: 'pe/beta' }) as never,
  }).catch(() => {});
  await settle(scheduler, 1);
  const view = queueView({ snapshot: scheduler.snapshot(), hinted: [], runs: [], now: Date.now() });
  const [entry] = view.entries;
  assert.match(entry!.waits, /beta's branch pe\/beta on app — held by run bbbbbbbbbbbb until it finishes, 3 phases left, plan remaining ~2–4 h of work/);
  assert.deepEqual(entry!.waitingOn[0]!.escapes?.map((escape) => escape.verb), ['isolate-phase', 'isolate']);
  assert.equal(entry!.waitingOn[0]!.escapes?.[0]!.endpoint, '/api/run/alpha/isolate-phase');
  scheduler.close();
});

/* ================================================================== *
 * QV-3 — hinted-not-queued phases, and queueing one from the view
 * ================================================================== */

test('QV-3: a hinted-not-queued phase appears with its hint time, and the row carries the press that queues it', () => {
  const hintAt = ago(90 * MIN);
  const view = queueView({
    snapshot: new Scheduler({ max: 4 }).snapshot(),
    hinted: [{ slug: 'alpha', runId: RA, phase: 59, since: hintAt, rung: 'reboard-resume-brief', brief: 'resume', by: 'console', serialBehind: 58 }],
    runs: [], now: Date.now(),
  });
  const [row] = view.hinted;
  assert.equal(row!.since, hintAt);
  assert.equal(row!.waitedMs >= 90 * MIN - 1_000, true);
  assert.match(row!.why, /behind its own run's P58/);
  assert.deepEqual(row!.queue, { verb: 'bump', method: 'POST', endpoint: '/api/queue/bump', body: { slug: 'alpha', phase: 59 } });
});

test('QV-3: queueing a hinted phase from the view takes its run\'s next lane', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress', 3: 'ready', 4: 'ready' } });
  const run = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  run.status = 'parked';
  phaseRecord(run, 1).status = 'done';
  // A wrap-up hinted P2 an hour ago; P3 has waited in a queue for three.
  Object.assign(phaseRecord(run, 2), {
    status: 'pending', attempts: 1,
    boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: ago(60 * MIN), by: 'console' },
  });
  Object.assign(phaseRecord(run, 3), { status: 'pending', queueSince: ago(3 * 60 * MIN) });
  // What the hinted row's press writes on the phase's record (QV-7 proves the
  // route writes exactly this on a stored run).
  phaseRecord(run, 2).queueControl = { bump: { at: ago(MIN), by: 'operator', reason: 'resume it first', stamp: Date.now() - MIN } };
  saveRun(run);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.equal(h.spawned[0], 2, 'the phase queued from the view boards first, ahead of an older queue age');
});

/* ================================================================== *
 * QV-7 — the API answers everything the view shows
 * ================================================================== */

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const PLAN = `---
slug: alpha
created: 2026-09-30
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | — | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function service(root: string, allowRun = true) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

type Captured = { status: number; body: Record<string, unknown> };

async function call(svc: unknown, method: 'GET' | 'POST', path: string, body: unknown = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('QV-7: GET /api/queue answers the whole view; every verb is a route, journalled on the run with its reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-queue-view-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = service(root);
  try {
    const run: RunState = newRun({ slug: 'alpha', root });
    run.status = 'parked';
    phaseRecord(run, 1).status = 'pending';
    phaseRecord(run, 2).status = 'pending';
    saveRun(run);

    const read = await call(svc, 'GET', '/api/queue');
    assert.equal(read.status, 200);
    for (const key of ['entries', 'lanes', 'hinted', 'withdrawn', 'audit', 'advice', 'max', 'live']) {
      assert.ok(key in read.body, `GET /api/queue answers \`${key}\``);
    }

    const hold = await call(svc, 'POST', '/api/queue/hold', { slug: 'alpha', phase: 2, reason: 'waiting for the CI fix' });
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    assert.equal(loadRun(root, 'alpha', run.id)!.phases['2']!.queueControl?.hold?.reason, 'waiting for the CI fix', 'a stopped run holds too: the mark is on its record');

    assert.equal((await call(svc, 'POST', '/api/queue/defer', { slug: 'alpha', phase: 2 })).status, 400, 'a deferral needs its clock');
    const until = new Date(Date.now() + 60 * MIN).toISOString();
    assert.equal((await call(svc, 'POST', '/api/queue/defer', { slug: 'alpha', phase: 2, until })).status, 200);
    assert.equal((await call(svc, 'POST', '/api/queue/release', { slug: 'alpha', phase: 2 })).status, 200);
    assert.equal((await call(svc, 'POST', '/api/queue/withdraw', { slug: 'alpha', phase: 1, reason: 'not this week' })).status, 200);

    const listed = await call(svc, 'GET', '/api/queue');
    const withdrawn = listed.body.withdrawn as { slug: string; phase: number; by: string; reason?: string; requeue: { endpoint: string } }[];
    assert.deepEqual(withdrawn.map((row) => [row.slug, row.phase, row.reason]), [['alpha', 1, 'not this week']], 'a withdrawn phase is named on the page, with the press that brings it back');
    assert.equal(withdrawn[0]!.requeue.endpoint, '/api/queue/requeue');

    assert.equal((await call(svc, 'POST', '/api/queue/requeue', { slug: 'alpha', phase: 1 })).status, 200);
    assert.equal((await call(svc, 'POST', '/api/queue/reorder', { slug: 'alpha', phases: [2, 1], reason: '2 first' })).status, 200);
    const after = loadRun(root, 'alpha', run.id)!;
    assert.ok(after.phases['2']!.queueControl!.bump!.stamp > after.phases['1']!.queueControl!.bump!.stamp, 'the list, as bumps in its order');
    assert.equal((await call(svc, 'POST', '/api/queue/bump', { slug: 'alpha', phase: 1, reason: 'no, 1' })).status, 200);

    // What each press wrote, on the run's own journal — and the audit strip.
    const events = readFileSync(journalFile(root, 'alpha', run.id), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
    const names = events.map((line) => line.event).filter((event) => /queue-/.test(event));
    assert.deepEqual(names, [
      'phase.queue-held', 'phase.queue-deferred', 'phase.queue-released', 'phase.queue-withdrawn',
      'phase.queue-requeued', 'run.queue-reordered', 'phase.queue-bumped',
    ]);
    assert.equal(events.find((line) => line.event === 'phase.queue-held')!.data?.reason, 'waiting for the CI fix');
    const audit = (await call(svc, 'GET', '/api/queue')).body.audit as { verb: string; reason?: string }[];
    assert.deepEqual(audit.slice(0, 2).map((row) => row.verb), ['bump', 'reorder'], 'the strip reads them back, newest first');

    // The refusals are named, never a silent 200.
    assert.equal((await call(svc, 'POST', '/api/queue/bump', { slug: 'alpha', phase: 7 })).status, 404);
    assert.equal((await call(svc, 'POST', '/api/queue/hold', {})).status, 400);
    assert.equal((await call(svc, 'POST', '/api/queue/shuffle', { slug: 'alpha', phase: 1 })).status, 404);
  } finally {
    svc.close();
  }
  // Run-class authority, like start and stop: a console without the flag refuses.
  const bare = service(root, false);
  try {
    assert.equal((await call(bare, 'POST', '/api/queue/hold', { slug: 'alpha', phase: 2 })).status, 403);
  } finally {
    bare.close();
  }
});

/* ================================================================== *
 * QV-8 — the view names a pin, a kept lane, a policy and a fair-share turn
 * (control-tower phase 100)
 * ================================================================== */

test('QV-8: every reason phase 100 adds is named on the entry it moved, and the audit strip reads the lane verbs back', async () => {
  const { queueAuditRows } = await import('../server/queue-view.ts');
  const scheduler = new Scheduler({ max: 8, locks: () => [lockOnApp] });
  const run = (slug: string, phase: number, runId: string, extra: Record<string, unknown> = {}) => {
    const p = scheduler.admit({ slug, phase, runId, scope: ['app'], ...extra } as never); p.catch(() => {});
  };
  run('alpha', 1, RA, { control: { pin: { at: ago(MIN), by: 'operator', reason: 'the migration first' } } });
  run('beta', 2, RB, { promotion: () => ({ policy: 'blocker-first', rank: 1, text: 'blocker-first — P7 declared itself blocked on it' }) });
  run('alpha', 3, RA);
  run('gamma', 4, RC);
  run('delta', 5, 'dddddddddddd');
  await settle(scheduler, 5);
  scheduler.reserveLane({ slug: 'gamma', runId: RC, phase: 4, by: 'operator', reason: 'the deploy keeps its window' });
  const view = queueView({ snapshot: scheduler.snapshot(), hinted: [], runs: [], now: Date.now() });
  const why = new Map(view.entries.map((entry) => [`${entry.slug}:${entry.phase}`, entry.reason]));
  assert.equal(why.get('gamma:4')!.key, 'reserved');
  assert.match(why.get('gamma:4')!.text, /a lane is reserved for it by operator — the deploy keeps its window/);
  assert.equal(why.get('alpha:1')!.key, 'pinned');
  assert.match(why.get('alpha:1')!.text, /pinned next in its plan by operator — the migration first/);
  assert.equal(why.get('beta:2')!.key, 'policy');
  assert.equal(why.get('alpha:3')!.key, 'share', 'alpha\'s second entry waits its turn behind the other plans');
  for (const reason of why.values()) assert.ok((QUEUE_ORDER_KEYS as readonly string[]).includes(reason.key));
  assert.equal(view.entries[0]!.slug, 'gamma', 'the kept lane\'s phase is first in line');

  const audit = queueAuditRows([
    { slug: 'alpha', runId: RA, at: ago(3 * MIN), event: 'phase.lane-pinned', phase: 1, data: { by: 'operator', reason: 'the migration first' } },
    { slug: 'gamma', runId: RC, at: ago(2 * MIN), event: 'phase.lane-reserved', phase: 4, data: { by: 'operator', lane: { slug: 'alpha', phase: 9 } } },
    { slug: 'alpha', runId: RA, at: ago(MIN), event: 'phase.lane-yielded', phase: 9, data: { by: 'operator', to: { slug: 'gamma', phase: 4 } } },
  ]);
  assert.deepEqual(audit.map((row) => row.text), [
    'operator asked alpha P9 to yield its lane to gamma P4',
    'operator kept the next lane for gamma P4 when alpha P9 ends',
    'operator pinned alpha P1 next in its plan — the migration first',
  ]);
  scheduler.close();
});
