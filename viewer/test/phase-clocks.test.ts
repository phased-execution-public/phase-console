/**
 * PC — the labelled clocks of a phase and of a plan (#28 §1, §2, §5).
 *
 * A phase had five start/end stamps and every surface subtracted the pair of
 * its choosing: 47 seconds apart on a finished phase, 11.7 minutes apart on a
 * running one. `phaseClocks` names each difference once, on the wire, and
 * `durationMs` stops being a sixth answer: it IS `workedMs`, the sum of the
 * attempt windows minus the time the operator held the phase frozen.
 *
 * Both measured fixtures below are the issue's own numbers, verbatim.
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_CLOCK_FIELDS, PHASE_CLOCK_LABELS, PHASE_ROW_CLOCK, PHASE_TOTAL_CLOCK,
  addSessionWindow, closeAttemptWindow, clocksDigest, noteFirstTool, openAttemptWindow, openSessionWindow, phaseClocks,
  planSpan, withPhaseClocks,
} from '../shared/phase-clocks.js';
import { RUN_PROGRESS_FIELDS } from '../shared/run-lifecycle.js';
import { progressDigest, progressFrame } from '../server/runner/runner-base.ts';
import type { LaneLiveness } from '../server/runner/liveness.ts';
import type { PhaseRecord } from '../server/runner/state.ts';

const MIN = 60_000;
const at = (iso: string): number => Date.parse(iso);

/** The issue's measured finished phase (its plan's p1) — the 47-second one. */
const FINISHED = {
  phase: 1,
  status: 'done',
  attempts: 1,
  costUsd: 0,
  startedAt: '2026-09-20T10:10:57.347Z',
  endedAt: '2026-09-20T11:02:18.257Z',
  attemptStartedAt: '2026-09-20T10:10:57.347Z',
  attemptEndedAt: '2026-09-20T11:01:32.888Z',
  durationMs: 3_033_808,
} as unknown as PhaseRecord;

/** The same plan's p13, re-boarded after a console restart — the 11.7-minute one. */
const REBOARDED = {
  phase: 13,
  status: 'running',
  attempts: 2,
  costUsd: 0,
  startedAt: '2026-09-21T04:44:44.738Z',
  attemptStartedAt: '2026-09-21T04:56:26.116Z',
} as unknown as PhaseRecord;

test('PC-1 — the 47 s fixture: three answers become three LABELLED clocks, and durationMs is one of them', () => {
  assert.deepEqual([...PHASE_CLOCK_FIELDS], [
    'sinceFirstBoardedMs', 'sinceThisAttemptMs', 'workedMs', 'queuedMs', 'attemptWindows', 'timeToFirstToolMs',
  ]);
  const clocks = phaseClocks(FINISHED, at('2026-09-23T00:00:00.000Z'));
  assert.deepEqual(Object.keys(clocks), [...PHASE_CLOCK_FIELDS]);
  // endedAt − startedAt: the phase, from first boarding to its end.
  assert.equal(clocks.sinceFirstBoardedMs, 3_080_910);
  // attemptEndedAt − attemptStartedAt: the attempt, which is what a row prints.
  assert.equal(clocks.sinceThisAttemptMs, 3_035_541);
  // One attempt, never frozen: worked is exactly the attempt's window.
  assert.equal(clocks.workedMs, 3_035_541);
  assert.deepEqual(clocks.attemptWindows, [
    { attempt: 1, startedAt: FINISHED.startedAt, endedAt: FINISHED.attemptEndedAt },
  ]);
  // The 45 s between the two is the stretch after the session ended — the
  // phase's own §Verification — and it is now a difference a reader can name.
  assert.equal(clocks.sinceFirstBoardedMs! - clocks.workedMs!, 45_369);
  // A finished phase's clocks do not move with the reader's clock.
  assert.deepEqual(phaseClocks(FINISHED, at('2027-01-01T00:00:00.000Z')), clocks);

  // On the wire `durationMs` IS `workedMs` — the stored 3,033,808 (a
  // process-lifetime figure matching neither subtraction) is not a sixth answer.
  const run = { id: 'r1', slug: 'demo', phases: { 1: FINISHED } };
  const projected = withPhaseClocks(run, at('2026-09-23T00:00:00.000Z')) as typeof run & {
    phases: Record<string, PhaseRecord & { phaseClocks: typeof clocks }>;
  };
  assert.equal(projected.phases['1'].durationMs, projected.phases['1'].phaseClocks.workedMs);
  assert.equal(projected.phases['1'].durationMs, 3_035_541);
  // A projection, never a write: the stored record is untouched.
  assert.equal(FINISHED.durationMs, 3_033_808);
  assert.equal((FINISHED as unknown as Record<string, unknown>).phaseClocks, undefined);
});

test('PC-2 — the 11.7 min fixture: the phase clock and the attempt clock, both live, both labelled', () => {
  // 81 minutes after the first boarding, as measured.
  const now = at(REBOARDED.startedAt!) + 81 * MIN;
  const clocks = phaseClocks(REBOARDED, now);
  assert.equal(clocks.sinceFirstBoardedMs, 81 * MIN);
  assert.equal(clocks.sinceThisAttemptMs, now - at(REBOARDED.attemptStartedAt!));
  // The disagreement, exactly — now a difference between two named clocks.
  assert.equal(clocks.sinceFirstBoardedMs! - clocks.sinceThisAttemptMs!, 701_378);
  // Both tick with the reader's clock while the attempt runs.
  const later = phaseClocks(REBOARDED, now + MIN);
  assert.equal(later.sinceFirstBoardedMs, clocks.sinceFirstBoardedMs! + MIN);
  assert.equal(later.sinceThisAttemptMs, clocks.sinceThisAttemptMs! + MIN);
  // The row prints the attempt — the thing an operator can act on — and the
  // drawer the phase total. Both surfaces say which by the same words.
  assert.equal(PHASE_ROW_CLOCK, 'sinceThisAttemptMs');
  assert.equal(PHASE_TOTAL_CLOCK, 'sinceFirstBoardedMs');
  for (const field of PHASE_CLOCK_FIELDS) {
    assert.equal(typeof PHASE_CLOCK_LABELS[field], 'string', `${field} has a label`);
  }
  assert.notEqual(PHASE_CLOCK_LABELS[PHASE_ROW_CLOCK], PHASE_CLOCK_LABELS[PHASE_TOTAL_CLOCK]);
  // A record from before the windows existed, with an earlier attempt: its one
  // known window is the one running now, and nothing is invented for the first.
  assert.deepEqual(clocks.attemptWindows, [{ attempt: 2, startedAt: REBOARDED.attemptStartedAt }]);
});

test('PC-3 — worked is the sum of the attempt windows minus frozenMs; queued and time-to-first-tool are exposed', () => {
  const T = (m: number): string => new Date(at('2026-09-22T10:00:00.000Z') + m * MIN).toISOString();
  const record = { phase: 4, status: 'queued', attempts: 0, costUsd: 0 } as unknown as PhaseRecord;
  // Queued 7 minutes, then boarded: the runner's own stamps.
  (record as unknown as Record<string, unknown>).queuedAt = T(-7);
  let clocks = phaseClocks(record, at(T(-2)));
  assert.equal(clocks.queuedMs, 5 * MIN, 'an open queue interval counts while it is open');
  assert.equal(clocks.workedMs, null, 'a phase that never boarded has worked nothing measurable');
  assert.equal(clocks.sinceFirstBoardedMs, null);

  const recordQueue = record as unknown as { queuedMs?: number; queuedAt?: string };
  recordQueue.queuedMs = 7 * MIN;
  delete recordQueue.queuedAt;
  record.status = 'running';
  record.startedAt = T(0);
  record.attemptStartedAt = T(0);
  record.attempts = 1;
  openAttemptWindow(record, 1, T(0));
  noteFirstTool(record, T(0.5));
  noteFirstTool(record, T(3)); // only the FIRST tool of a window counts
  closeAttemptWindow(record, T(20));
  record.attempts = 2;
  openAttemptWindow(record, 2, T(30));
  closeAttemptWindow(record, T(50));
  record.attemptStartedAt = T(60);
  record.attempts = 3;
  openAttemptWindow(record, 3, T(61));
  noteFirstTool(record, T(62));
  record.frozenMs = 5 * MIN;

  clocks = phaseClocks(record, at(T(70)));
  // The third window starts at the boarding stamp, not the spawn a minute later:
  // the first session of a boarding owns the stretch its boarding began.
  assert.deepEqual(clocks.attemptWindows, [
    { attempt: 1, startedAt: T(0), endedAt: T(20), firstToolAt: T(0.5) },
    { attempt: 2, startedAt: T(30), endedAt: T(50) },
    { attempt: 3, startedAt: T(60), firstToolAt: T(62) },
  ]);
  assert.equal(clocks.workedMs, (20 + 20 + 10 - 5) * MIN);
  assert.equal(clocks.sinceThisAttemptMs, 10 * MIN);
  assert.equal(clocks.sinceFirstBoardedMs, 70 * MIN);
  assert.equal(clocks.queuedMs, 7 * MIN);
  assert.equal(clocks.timeToFirstToolMs, 2 * MIN);

  // A window left open by a console that died is closed at the last evidence
  // of work, never at the next boarding — downtime is not work.
  const orphan = { phase: 5, status: 'running', attempts: 1, costUsd: 0 } as unknown as PhaseRecord;
  orphan.startedAt = T(0);
  orphan.attemptStartedAt = T(0);
  openAttemptWindow(orphan, 1, T(0));
  (orphan as unknown as { liveness: unknown }).liveness = { lastOutputAt: T(12) };
  orphan.attemptStartedAt = T(300);
  orphan.attempts = 2;
  openAttemptWindow(orphan, 2, T(300));
  const orphanClocks = phaseClocks(orphan, at(T(310)));
  assert.deepEqual(orphanClocks.attemptWindows[0], { attempt: 1, startedAt: T(0), endedAt: T(12) });
  assert.equal(orphanClocks.workedMs, (12 + 10) * MIN);

  // A phase already running when windows arrived: its earlier attempts' worked
  // time is carried in a seed window whose LENGTH is the old figure, so the
  // sum stays exact across the upgrade.
  const straddler = {
    phase: 6, status: 'running', attempts: 2, costUsd: 0, durationMs: 9 * MIN, frozenMs: MIN,
    startedAt: T(0), attemptStartedAt: T(40),
  } as unknown as PhaseRecord;
  straddler.attempts = 3;
  openAttemptWindow(straddler, 3, T(40));
  closeAttemptWindow(straddler, T(46));
  const straddled = phaseClocks(straddler, at(T(50)));
  assert.equal(straddled.workedMs, 9 * MIN + 6 * MIN);
  assert.equal(straddled.attemptWindows[0].legacy, true);
});

test('PC-4 — phaseClocks rides run:progress, and a ticking clock never re-sends a frame', () => {
  assert.ok(RUN_PROGRESS_FIELDS.includes('phaseClocks' as never), 'the clocks are a run:progress field');
  const live: LaneLiveness = {
    phase: 13, lastOutputAt: '2026-09-21T06:00:00.000Z', turnsSinceLastTool: 0, commitsSinceStart: 0, treeDirty: false,
  };
  const now = at(REBOARDED.startedAt!) + 81 * MIN;
  const frame = progressFrame(live, REBOARDED, now);
  assert.deepEqual(frame.phaseClocks, phaseClocks(REBOARDED, now));
  // Three seconds later every running clock has moved and nothing else has:
  // the digest is the frame's STABLE half, so the lane stays quiet.
  const next = progressFrame(live, REBOARDED, now + 3_000);
  assert.notEqual(next.phaseClocks!.sinceThisAttemptMs, frame.phaseClocks!.sinceThisAttemptMs);
  assert.equal(progressDigest(next), progressDigest(frame));
  assert.equal(clocksDigest(next.phaseClocks!), clocksDigest(frame.phaseClocks!));
  // A boundary is news: the first tool of the attempt changes the digest.
  const record = structuredClone(REBOARDED) as PhaseRecord;
  openAttemptWindow(record, 2, record.attemptStartedAt!);
  const before = progressFrame(live, record, now);
  noteFirstTool(record, new Date(now - MIN).toISOString());
  const after = progressFrame(live, record, now);
  assert.notEqual(progressDigest(after), progressDigest(before));
});

test('PC-5 — a plan carries startedAt (ISO, with time) and spanMs, from the first boarding of its runs', () => {
  const runs = [
    // newest first, as listRuns returns them
    { id: 'b', status: 'running', phases: { 3: { phase: 3, status: 'running', startedAt: '2026-09-21T09:00:00.000Z' } } },
    { id: 'a', status: 'finished', phases: {
      1: { phase: 1, status: 'done', startedAt: '2026-09-21T02:56:10.000Z', endedAt: '2026-09-21T04:00:00.000Z' },
      2: { phase: 2, status: 'done', startedAt: '2026-09-21T04:10:00.000Z', endedAt: '2026-09-21T05:00:00.000Z' },
    } },
  ];
  const now = at('2026-09-21T09:12:10.000Z');
  const live = planSpan(runs, now);
  assert.equal(live.startedAt, '2026-09-21T02:56:10.000Z');
  assert.match(live.startedAt!, /T\d\d:\d\d:\d\d/);
  // A run in flight: the span runs to now — "running 6 h 16 m", to the minute.
  assert.equal(live.spanMs, 6 * 60 * MIN + 16 * MIN);
  // Nothing in flight: the span ends at the last recorded end.
  const settled = planSpan([{ ...runs[0], status: 'finished', phases: {
    3: { phase: 3, status: 'done', startedAt: '2026-09-21T09:00:00.000Z', endedAt: '2026-09-21T09:30:00.000Z' },
  } }, runs[1]], now);
  assert.equal(settled.spanMs, at('2026-09-21T09:30:00.000Z') - at('2026-09-21T02:56:10.000Z'));
  // A plan no run ever boarded has no start to report.
  assert.deepEqual(planSpan([], now), {});
  assert.deepEqual(planSpan([{ id: 'c', status: 'finished', phases: { 1: { phase: 1, status: 'pending' } } }], now), {});
});

/** A minimal `handleApi` caller — the fake needs `res.req`, as `debug-routes.test.ts` explains. */
async function call(service: unknown, path: string): Promise<{ status: number; body: any }> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, body: null as any };
  const req = {
    method: 'GET',
    headers: { 'x-phase-console': '1' } as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* no body */ },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('PC-6 — the run payloads carry phaseClocks, with durationMs equal to workedMs', async () => {
  const run = { id: 'r1', slug: 'demo', status: 'finished', phases: { 1: FINISHED } };
  const service = {
    root: null,
    store: { list: () => [] },
    runFor: async () => run,
    runsFor: async () => [run],
    runEta: async () => null,
    runPhaseEta: () => ({}),
    runLiveness: () => [],
    runGit: () => null,
    allRuns: async () => [run],
  };
  const detail = await call(service, '/api/run/demo');
  assert.equal(detail.status, 200, JSON.stringify(detail.body).slice(0, 300));
  for (const payload of [detail.body.run, detail.body.history[0]]) {
    const phase = payload.phases['1'];
    assert.deepEqual(Object.keys(phase.phaseClocks), [...PHASE_CLOCK_FIELDS]);
    assert.equal(phase.durationMs, phase.phaseClocks.workedMs);
    assert.equal(phase.phaseClocks.sinceFirstBoardedMs, 3_080_910);
  }
  const list = await call(service, '/api/runs');
  assert.equal(list.status, 200);
  assert.equal(list.body[0].phases['1'].durationMs, 3_035_541);
  // The live object the service handed out was never written to.
  assert.equal((run.phases[1] as unknown as Record<string, unknown>).phaseClocks, undefined);
});

test('PC-7 — GET /api/plans carries startedAt and spanMs from the runs on disk, and an integer activity', async () => {
  const { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const { runFile } = await import('../server/runner/run-paths.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-plans-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    const plan = join(root, 'docs', 'plans', 'demo.md');
    writeFileSync(plan, [
      '---', 'slug: demo', 'created: 2026-09-21', 'status: active', 'phases: 1', '---', '', '# demo', '',
      '## Phase graph', '',
      '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
      '|------:|-------|-----------|--------------------|-------|---------------|',
      '| 1 | first | — | — | app | it works |', '',
      '## Phases', '', '### Phase 1 — first', '- **Size:** S', '',
    ].join('\n'), 'utf8');
    // A fractional mtime — the `…472.177` the issue measured.
    utimesSync(plan, 1_790_000_000.123456, 1_790_000_000.123456);
    const file = runFile(root, 'demo', 'abcdef12');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      id: 'abcdef12', slug: 'demo', status: 'finished', createdAt: '2026-09-21T02:50:00.000Z',
      updatedAt: '2026-09-21T05:00:00.000Z', phases: {
        1: { phase: 1, status: 'done', attempts: 1, costUsd: 0,
          startedAt: '2026-09-21T02:56:10.000Z', endedAt: '2026-09-21T05:00:00.000Z' },
      },
    }), 'utf8');
    const svc = new Service({ port: 0, host: '127.0.0.1', open: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null } as never);
    assert.equal(svc.open(root).ok, true);
    const summary = (await svc.summaries()).find((one: { slug: string }) => one.slug === 'demo') as Record<string, unknown>;
    assert.ok(summary, 'the plan is listed');
    assert.equal(summary.created, '2026-09-21', 'created stays the authoring date');
    assert.equal(summary.startedAt, '2026-09-21T02:56:10.000Z');
    assert.equal(summary.spanMs, at('2026-09-21T05:00:00.000Z') - at('2026-09-21T02:56:10.000Z'));
    assert.ok(Number.isInteger(summary.activity), `activity ${summary.activity} is an integer`);
    svc.close?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PC-8 — a window per SESSION: a non-attempt session carries its mode, counts as worked, and is the row clock while it runs', () => {
  const t0 = Date.parse('2026-09-20T10:00:00Z');
  const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
  const record: Record<string, unknown> = { phase: 8, status: 'running', attempts: 1, startedAt: at(0), attemptStartedAt: at(0) };
  openAttemptWindow(record, 1, at(0));
  closeAttemptWindow(record, at(30));
  openSessionWindow(record, 'qa', at(40));
  // The QA round is still running: the row clock is ITS window, and worked time grows with it.
  const live = phaseClocks(record, t0 + 45 * 60_000);
  assert.equal(live.sinceThisAttemptMs, 5 * 60_000);
  assert.equal(live.workedMs, 35 * 60_000);
  assert.equal(live.attemptWindows.at(-1)?.mode, 'qa');
  closeAttemptWindow(record, at(50));
  assert.equal(phaseClocks(record, t0 + 99 * 60_000).workedMs, 40 * 60_000);
  // A window from the journal is placed in time order, and the same session twice is one window.
  assert.equal(addSessionWindow(record, 'review', t0 + 32 * 60_000, t0 + 38 * 60_000), true);
  assert.equal(addSessionWindow(record, 'review', t0 + 32 * 60_000, t0 + 38 * 60_000 + 5_000), false);
  assert.deepEqual((record.attemptWindows as { mode?: string }[]).map((w) => w.mode ?? 'attempt'), ['attempt', 'review', 'qa']);
  assert.equal(phaseClocks(record, t0 + 99 * 60_000).workedMs, 46 * 60_000);
});
