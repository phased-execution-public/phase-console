/**
 * A live phase's progress report, composed by RULES (control-tower phase 95,
 * #163 PR-2..4).
 *
 * Answering "why is vca P11 taking so long?" took six sources the console held
 * and never showed together: the task list, the session's own log, a sweep's
 * progress, liveness, the machine and the run's history. The report is one
 * payload of six fields — doing, done, left, waiting on, why slow, when — each
 * figure carrying the id of the event, session line or lane field it came
 * from, and an ETA grounded in the phase's OWN rate with a confidence word.
 * The plan-weight forecast (`forecastFrom`, #66) is not used.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi } from '../server/api/routes.ts';
import { LOAD_GUARD_PER_CPU, composePhaseReport, type PhaseReportFacts, type ReportJournalRow } from '../server/analysis/phase-report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const T0 = Date.parse('2026-09-26T10:00:00Z');
const at = (min: number): string => new Date(T0 + min * MIN).toISOString();

const TASKS = [
  { id: 'p11.task1', content: 'p11.task1 — re-shoot the iOS routes', status: 'completed' },
  { id: 'p11.task2', content: 'p11.task2 — fix the tickets gutter', status: 'completed' },
  { id: 'p11.task3', content: 'p11.task3 — design review: classify every visual diff', status: 'in_progress' },
  { id: 'p11.task4', content: 'p11.task4 — commit and push', status: 'pending' },
  { id: 'p11.task5', content: 'p11.task5 — handoff', status: 'pending' },
];

function vca(over: Partial<PhaseReportFacts> = {}, record: Record<string, unknown> = {}): PhaseReportFacts {
  let seq = 100;
  const row = (min: number, event: string, data: Record<string, unknown>, phase = 11): ReportJournalRow =>
    ({ seq: ++seq, time: at(min), event, phase, data });
  return {
    slug: 'vca-refactor', runId: 'r1', phase: 11, now: T0 + 56 * MIN,
    record: {
      status: 'running', attemptStartedAt: at(0), tasks: TASKS,
      progress: { label: 'iOS sweep vendor', done: 45, of: 68, task: 'p11.task3', at: at(50) },
      liveness: {
        lastOutputAt: at(55),
        openTool: { id: 'toolu_9', name: 'Bash', since: at(44), summary: 'npm run e2e:ios' },
        tokens: { context: 551_000, window: 1_000_000, stage: 'wrap-up' },
      },
      ...record,
    },
    journal: [
      row(-120, 'phase.verify', { ok: false, ran: [{ command: 'npm run e2e:ios', code: 124, ms: 64 * MIN }] }, 10),
      row(0, 'phase.tasks', { total: 5, done: 0, active: TASKS[0]!.content }),
      row(10, 'phase.tasks', { total: 5, done: 1, active: TASKS[1]!.content }),
      row(22, 'phase.tasks', { total: 5, done: 2, active: TASKS[2]!.content }),
      row(40, 'phase.progress', { label: 'iOS sweep vendor', done: 30, of: 68, task: 'p11.task3', at: at(40) }),
      row(50, 'phase.progress', { label: 'iOS sweep vendor', done: 45, of: 68, task: 'p11.task3', at: at(50) }),
    ],
    activity: [{ kind: 'text', at: at(55), text: 'Vendor is at 45 of 68.', line: 'line-77' }],
    load: { one: 46, cpus: 12 },
    ...over,
  };
}

const journalSeq = (facts: PhaseReportFacts, event: string, min: number): number =>
  facts.journal.find((r) => r.event === event && r.time === at(min))!.seq;

test('PR-2: doing, done and left — the active task, its measured operation, each figure with its source', () => {
  const facts = vca();
  const report = composePhaseReport(facts);
  assert.equal(report.live, true);

  assert.equal(report.doing.task?.id, 'p11.task3');
  assert.equal(report.doing.task?.since, at(22), 'when it became the active task');
  assert.deepEqual(report.doing.task?.source, [
    { kind: 'task', id: 'p11.task3' }, { kind: 'journal', seq: journalSeq(facts, 'phase.tasks', 22), event: 'phase.tasks' },
  ]);
  assert.deepEqual(report.doing.operation, {
    label: 'iOS sweep vendor', done: 45, of: 68, pct: 66, at: at(50),
    source: [{ kind: 'journal', seq: journalSeq(facts, 'phase.progress', 50), event: 'phase.progress' }],
  });
  assert.deepEqual(report.doing.last, { text: 'Vendor is at 45 of 68.', at: at(55), source: [{ kind: 'session-line', line: 'line-77' }] });

  assert.equal(report.done.count, 2);
  assert.equal(report.done.total, 5);
  assert.deepEqual(report.done.items.map((t) => [t.id, t.durationMs]), [['p11.task1', 10 * MIN], ['p11.task2', 12 * MIN]]);
  assert.deepEqual(report.left.items.map((t) => t.id), ['p11.task3', 'p11.task4', 'p11.task5']);

  // The timeline: each task's start and duration, the active one still running.
  const three = report.timeline.find((t) => t.id === 'p11.task3')!;
  assert.equal(three.startedAt, at(22));
  assert.equal(three.durationMs, 34 * MIN);
  assert.equal(three.status, 'in_progress');
  assert.equal(report.timeline.find((t) => t.id === 'p11.task5')!.startedAt, undefined);
});

test('PR-2: waiting on — the open tool, a declared wait, a queue hold — each naming what', () => {
  const tool = composePhaseReport(vca());
  assert.equal(tool.waitingOn.length, 1);
  assert.equal(tool.waitingOn[0]!.kind, 'tool');
  assert.match(tool.waitingOn[0]!.text, /Bash `npm run e2e:ios`, open 12 min/);
  assert.deepEqual(tool.waitingOn[0]!.source, [{ kind: 'lane', field: 'openTool' }]);

  const parked = composePhaseReport(vca({}, { status: 'waiting', liveness: undefined, parkedUntil: at(90), parkReason: 'the image build' }));
  assert.equal(parked.waitingOn[0]!.kind, 'wait');
  assert.match(parked.waitingOn[0]!.text, /the image build/);
  assert.equal(parked.waitingOn[0]!.until, at(90));

  const queued = composePhaseReport(vca({}, {
    status: 'queued', liveness: undefined, lockWaitSince: at(40),
    waitingOn: [{ slug: 'trade', phase: 68, owner: 'autopilot/abc', kind: 'lock' }],
  }));
  assert.equal(queued.waitingOn[0]!.kind, 'queue');
  assert.match(queued.waitingOn[0]!.text, /trade P68/);
  assert.deepEqual(queued.waitingOn[0]!.source, [{ kind: 'record', field: 'waitingOn' }]);
});

test('PR-3: why slow — each cause named by its own rule over its own fact', () => {
  const facts = vca();
  const report = composePhaseReport(facts);
  const rules = Object.fromEntries(report.whySlow.map((w) => [w.rule, w]));
  assert.deepEqual(Object.keys(rules).sort(), ['context-wrap-up', 'machine-load', 'repeat-verification']);

  assert.match(rules['repeat-verification']!.text, /npm run e2e:ios/);
  assert.match(rules['repeat-verification']!.text, /P10/);
  assert.deepEqual(rules['repeat-verification']!.source, [
    { kind: 'lane', field: 'openTool' }, { kind: 'journal', seq: journalSeq(facts, 'phase.verify', -120), event: 'phase.verify' },
  ]);
  assert.match(rules['machine-load']!.text, /load 46 on 12 CPUs/);
  assert.deepEqual(rules['machine-load']!.source, [{ kind: 'machine', sample: 'loadavg' }]);
  assert.match(rules['context-wrap-up']!.text, /551k of 1M/);
  assert.deepEqual(rules['context-wrap-up']!.source, [{ kind: 'lane', field: 'tokens' }]);

  const wait = composePhaseReport(vca({ load: { one: 2, cpus: 12 } }, {
    liveness: {
      lastOutputAt: at(16), openTool: { id: 't', name: 'Bash', since: at(16), summary: 'until [ -f out.json ]; do sleep 10; done' },
      silence: { kind: 'own-job', sinceMs: T0 + 16 * MIN, thresholdMs: 45 * MIN },
    },
  }));
  const inTurn = wait.whySlow.find((w) => w.rule === 'in-turn-wait');
  assert.ok(inTurn, JSON.stringify(wait.whySlow));
  assert.match(inTurn!.text, /40 min/);
  assert.match(inTurn!.text, /45/);

  const queued = composePhaseReport(vca({ load: { one: 2, cpus: 12 } }, {
    status: 'queued', liveness: undefined, lockWaitSince: at(40),
    waitingOn: [{ slug: 'trade', phase: 68, owner: 'autopilot/abc', kind: 'lock' }],
  }));
  const hold = queued.whySlow.find((w) => w.rule === 'queue-hold');
  assert.match(String(hold?.text), /queued behind trade P68 for 16 min/);

  const calm = composePhaseReport(vca({ load: { one: 3, cpus: 12 }, journal: [] }, {
    liveness: { lastOutputAt: at(55), openTool: { id: 't', name: 'Read', since: at(55), summary: '/a.ts' } },
  }));
  assert.deepEqual(calm.whySlow, [], 'nothing slow is reported for a calm lane');
  assert.ok(LOAD_GUARD_PER_CPU > 1, 'the guard is a load per CPU above saturation');
});

test('PR-4: the ETA is the phase\'s OWN rate — finished tasks and the measured operation — with a confidence word', () => {
  const report = composePhaseReport(vca());
  // The operation: 15 more of 68 in 10 min → 23 left ≈ 15 min. The tasks: two
  // finished in 10 and 12 min → 11 each for the two after the active one.
  assert.equal(report.eta.confidence, 'medium');
  assert.ok(report.eta.minutes, 'an estimate is given');
  assert.ok(report.eta.minutes!.low <= 37 && report.eta.minutes!.high >= 37, JSON.stringify(report.eta));
  assert.match(report.eta.basis, /2 finished tasks averaged 11 min/);
  assert.match(report.eta.basis, /iOS sweep vendor: 1\.5 a minute, 23 left/);
  assert.ok(report.eta.source.some((s) => s.kind === 'journal' && s.event === 'phase.progress'));

  const blind = composePhaseReport(vca({ journal: [] }, {
    tasks: TASKS.map((t) => ({ ...t, status: t.id === 'p11.task1' ? 'in_progress' : 'pending' })), progress: undefined,
  }));
  assert.equal(blind.eta.confidence, 'none');
  assert.equal(blind.eta.minutes, null);
  assert.match(blind.eta.basis, /no task has finished and no operation reports progress/);

  const src = readFileSync(join(here, '..', 'server', 'analysis', 'phase-report.ts'), 'utf8');
  assert.doesNotMatch(src, /forecastFrom|analysis\/stats|stats\.ts/, 'the plan-weight forecast is not this ETA');
});

test('PR-2: the summary says it in plain words, from the same six fields', () => {
  const report = composePhaseReport(vca());
  for (const bit of [
    /design review: classify every visual diff/, /2 of 5 tasks done/, /iOS sweep vendor 45\/68/, /npm run e2e:ios/,
    /load 46/, /551k of 1M/, /medium confidence/,
  ]) assert.match(report.summary, bit);
  const done = composePhaseReport(vca({}, { status: 'done', liveness: undefined }));
  assert.equal(done.live, false);
  assert.deepEqual(done.waitingOn, []);
  assert.deepEqual(done.whySlow, []);
  assert.match(done.summary, /not running/);
});

test('PR-2: the route hands the service the phase and the run', async () => {
  const asked: unknown[] = [];
  const service = {
    root: { ok: true, path: "/tmp" }, store: {},
    phaseReport: (slug: string, phase: number, opts: unknown) => { asked.push({ slug, phase, opts }); return { phase, live: true }; },
  };
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return this; }, setHeader() { return this; },
    end(text: string) { payload = JSON.parse(text); }, on() { return this; }, writableEnded: false, destroyed: false,
  };
  const req = { method: 'GET', headers: { host: '127.0.0.1:4123' }, socket: { remoteAddress: '127.0.0.1' }, on() { return this; } };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1:4123/api/run/demo/phase/11/report?run=abc'));
  assert.equal(status, 200);
  assert.equal(payload.live, true);
  assert.deepEqual(asked, [{ slug: 'demo', phase: 11, opts: { run: 'abc' } }]);
});
