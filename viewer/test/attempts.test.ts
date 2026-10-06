/**
 * An attempt is a BOARDING, and it ends when its session does (control-tower
 * phase 89, #130 — and #62's SIZ-7).
 *
 * `GET /api/run/<slug>/attempts` read a boarding as running until a terminal
 * line it knew — `phase.done`, `phase.failed` and five more — or until the NEXT
 * `phase.start` settled it `superseded` at the new boarding's time. A session
 * that declared `partial` (the context wrap-up) or `blocked` wrote neither, so
 * hub's run `24fcba33` reported P43's 57-minute first attempt as 5 h 43 min —
 * the queue wait counted as work — and P50, P41 and P64 as still `open` hours
 * after their sessions had exited. The attempt number was a second defect: the
 * runner journalled the boarding's retry index, which restarted at 1, so P41's
 * second boarding said `attempt: 1` beside `record.attempts` 2.
 *
 *   AT-1  a declared `partial`, `blocked`, `needs-human` or `waiting-external`,
 *         and a `phase.halted`, end the boarding at its session's end, named
 *         for what happened — never `open`, never `superseded`. A declared
 *         `complete` does not: the console's §Verification runs inside the
 *         boarding, and `phase.done` / `phase.verification-failed` end it;
 *   AT-2  `durationMs` never counts time the phase spent queued — between two
 *         boardings or inside one;
 *   AT-3  ONE attempt number: `/attempts` numbers a boarding by its
 *         `phase.start`'s `attempt`, which is the number `phase.session`,
 *         `phase.tokens` and `record.attempts` carry;
 *   PT-1  a session keeps the largest one prompt's `num_turns` beside the
 *         summed total — the CLI's `--max-turns` binds per prompt — and
 *         `phase.session` and the run's ledger carry both.
 *
 * PT-2, calibration reading the per-prompt figure, is in `resume-caps.test.ts`.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptsOf, compareConsecutive } from '../server/analysis/timeline.ts';
import { projectLedger } from '../server/analysis/ledger.ts';
import { Journal, type JournalEntry } from '../server/runner/journal.ts';
import { Runner } from '../server/runner/runner.ts';
import { sessionRecordOf } from '../server/runner/session-record.ts';
import { spawnClaude, type SpawnOutcome, type SpawnRequest } from '../server/runner/spawn.ts';
import type { TokenCounters } from '../server/runner/usage.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-25T05:50:47.000Z');
const MIN = 60_000;

let seq = 0;
/** One journal line, `min` minutes after the first. */
const at = (min: number, event: string, phase?: number, data?: Record<string, unknown>): JournalEntry => ({
  seq: ++seq,
  time: new Date(T0 + min * MIN).toISOString(),
  event,
  ...(phase === undefined ? {} : { phase }),
  ...(data ? { data } : {}),
});
const iso = (min: number): string => new Date(T0 + min * MIN).toISOString();

/* ------------------------------------------------------------------ *
 * AT-1 — the boarding ends when its session does
 * ------------------------------------------------------------------ */

/**
 * P43 on run `24fcba33`: a 57-minute session handed off at the console's
 * wrap-up, queued behind its scope for four and three-quarter hours, and
 * boarded again. `/attempts` said attempt 1 was `superseded` at the second
 * boarding — 5 h 43 min.
 */
const P43: JournalEntry[] = [
  at(0, 'phase.start', 43, { attempt: 1, model: 'claude-opus-5' }),
  at(57.5, 'phase.session', 43, { attempt: 1, mode: 'phase', ms: 57.5 * MIN, costUsd: 11, turns: 210, said: 'handing off at the wrap-up' }),
  at(57.75, 'phase.outcome', 43, { status: 'partial', reason: 'context' }),
  at(57.75, 'phase.outcome-partial', 43, { reason: 'context', climbed: false, wrapup: true }),
  at(57.75, 'phase.resume-automatic', 43, { trigger: 'outcome', path: 'wrapup', by: 'console' }),
  at(58, 'phase.queued', 43, { headClass: 'scope', head: 'phase 41' }),
  at(343, 'phase.queue-closed', 43, { outcome: 'admitted', ms: 285 * MIN }),
  at(343.5, 'phase.start', 43, { attempt: 2, model: 'claude-opus-5' }),
  at(400, 'phase.session', 43, { attempt: 2, mode: 'phase', ms: 56 * MIN, costUsd: 9, turns: 150 }),
  at(404, 'phase.verify', 43, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 4 * MIN }] }),
  at(404, 'phase.done', 43, { attempts: 2 }),
];

test('AT-1: a declared partial ends its boarding at the session\'s end — `partial`, 57 minutes, not `superseded` at 5 h 43', () => {
  const [first, second] = attemptsOf(P43, 43);
  assert.equal(first!.outcome, 'partial', 'the declared status is the outcome');
  assert.equal(first!.endedAt, iso(57.5), 'it ended when its session did — the phase.session line');
  assert.equal(first!.durationMs, 57.5 * MIN, 'the queue wait after it is not the attempt\'s');
  assert.equal(first!.costUsd, 11);
  assert.equal(second!.outcome, 'done');
  assert.equal(second!.durationMs, 60.5 * MIN);
});

test('AT-1: a partial whose next boarding has not come yet is `partial` — not `open` once its session has exited', () => {
  // P64: the journal ends at the resume the wrap-up armed; nothing re-boarded yet.
  const [only, ...rest] = attemptsOf(P43.slice(0, 7), 43);
  assert.equal(rest.length, 0);
  assert.equal(only!.outcome, 'partial');
  assert.equal(only!.endedAt, iso(57.5));
  assert.equal(only!.durationMs, 57.5 * MIN, 'the queue episode after the session is not counted either');
});

/** P50: a declared `blocked` the ladder could not answer, which then halted the phase. */
const P50: JournalEntry[] = [
  at(0, 'phase.start', 50, { attempt: 1 }),
  at(94.5, 'phase.session', 50, { attempt: 1, mode: 'phase', ms: 94.5 * MIN, costUsd: 14, turns: 240 }),
  at(94.75, 'phase.outcome', 50, { status: 'blocked', reason: 'the staging key is missing', watch: [] }),
  at(94.75, 'phase.situation', 50, { situation: 'blocked-declared:credential' }),
  at(94.75, 'phase.ladder-deferred', 50, {}),
  at(94.75, 'run.failure-charged', 50, { cause: 'declared-blocked' }),
  at(95, 'phase.halted', 50, { reason: 'phase 50 declared itself blocked', kind: 'phase-blocked' }),
  // What P41's comment saw: a later line the console writes about the phase
  // between boardings once named the ENDED attempt `not-started`.
  at(120, 'phase.not-started', 50, { reason: 'a person holds it' }),
];

test('AT-1: a declared blocked that halts is `blocked` — the declaration wins over the halt that follows it, at the session\'s end', () => {
  const attempts = attemptsOf(P50, 50);
  assert.equal(attempts.length, 1);
  // Both lines speak for the same ending. The declared status is what the
  // session said happened; `phase.halted` is the console's act on it — the
  // first to land settles the boarding and the second finds nothing open.
  assert.equal(attempts[0]!.outcome, 'blocked');
  assert.equal(attempts[0]!.endedAt, iso(94.5), 'the session\'s end, not the halt\'s or anything later');
  assert.equal(attempts[0]!.durationMs, 94.5 * MIN);
});

test('AT-1: `phase.halted` alone ends a boarding `halted` — at its session\'s end, or at the verdict the console ran after it', () => {
  const noHandoff = attemptsOf([
    at(0, 'phase.start', 7, { attempt: 1 }),
    at(30, 'phase.session', 7, { attempt: 1, mode: 'phase', ms: 30 * MIN }),
    at(30.2, 'phase.halted', 7, { reason: 'no handoff was written', kind: 'no-handoff' }),
  ], 7);
  assert.deepEqual(noHandoff.map((a) => [a.outcome, a.endedAt, a.durationMs]), [['halted', iso(30), 30 * MIN]]);

  // A red verdict over work the board does not vouch for halts `verify-failed`
  // — no `phase.failed` line. The §Verification ran inside the boarding, as it
  // does before a `phase.done`, so the attempt ends at its verdict.
  const red = attemptsOf([
    at(0, 'phase.start', 7, { attempt: 1 }),
    at(20, 'phase.session', 7, { attempt: 1, mode: 'phase', ms: 20 * MIN }),
    at(27, 'phase.verify', 7, {
      ok: false,
      ran: [{ command: 'npm test', code: 1, ms: 7 * MIN }],
      trees: [{ repo: 'phased-execution', branch: 'pe/control-tower', head: '1d1911ee4c', role: 'verify-in' }],
    }),
    at(27, 'phase.halted', 7, { reason: 'phase 7 did not verify', kind: 'verify-failed' }),
  ], 7);
  assert.deepEqual(red.map((a) => [a.outcome, a.endedAt, a.durationMs]), [['halted', iso(27), 27 * MIN]]);
  assert.equal(red[0]!.verification?.ok, false);
  // The verdict keeps the tree it ran against, so its line can be drawn (#41, phase 24).
  assert.deepEqual(red[0]!.verification?.trees, [
    { repo: 'phased-execution', branch: 'pe/control-tower', head: '1d1911ee4c', role: 'verify-in' },
  ]);

  // Halted at boarding, before any session: the halt's own time, and no figure.
  const preflight = attemptsOf([
    at(0, 'phase.start', 7, { attempt: 1 }),
    at(2, 'phase.halted', 7, { reason: 'the MCP preflight', kind: 'mcp-preflight' }),
  ], 7);
  assert.deepEqual(preflight.map((a) => [a.outcome, a.endedAt, a.costUsd]), [['halted', iso(2), null]]);
});

test('AT-1: a declared wait and a person\'s ask name themselves — the park line after the declaration is no second ending', () => {
  const [wait, resumed] = attemptsOf([
    at(0, 'phase.start', 8, { attempt: 1 }),
    at(10, 'phase.session', 8, { attempt: 1, mode: 'phase', ms: 10 * MIN }),
    at(10.1, 'phase.outcome', 8, { status: 'waiting-external', reason: 'the image build', watch: ['ci:build'] }),
    at(10.2, 'phase.waiting', 8, { until: iso(60), reason: 'the image build' }),
    at(60, 'phase.wait-resume', 8, { waits: 1 }),
    at(60, 'phase.start', 8, { attempt: 2, waitResume: true }),
    at(70, 'phase.session', 8, { attempt: 2, mode: 'phase', ms: 10 * MIN }),
    at(71, 'phase.done', 8, {}),
  ], 8);
  assert.deepEqual([wait!.outcome, wait!.endedAt, wait!.durationMs], ['waiting-external', iso(10), 10 * MIN],
    'waiting-external, not `parked`: the declaration came first');
  assert.equal(resumed!.outcome, 'done');

  const [ask] = attemptsOf([
    at(0, 'phase.start', 9, { attempt: 1 }),
    at(12, 'phase.session', 9, { attempt: 1, mode: 'phase', ms: 12 * MIN }),
    at(12.1, 'phase.outcome', 9, { status: 'needs-human', reason: 'which tenant?' }),
    at(12.2, 'phase.errand', 9, { need: 'a person' }),
    at(12.3, 'phase.halted', 9, { reason: 'phase 9 needs a person', kind: 'needs-human' }),
  ], 9);
  assert.deepEqual([ask!.outcome, ask!.endedAt], ['needs-human', iso(12)]);
});

test('AT-1: a declared complete (or no-defect) does not end the boarding — its §Verification is inside it', () => {
  for (const status of ['complete', 'no-defect']) {
    const [attempt] = attemptsOf([
      at(0, 'phase.start', 3, { attempt: 1 }),
      at(20, 'phase.session', 3, { attempt: 1, mode: 'phase', ms: 20 * MIN }),
      at(20.1, 'phase.outcome', 3, { status }),
      at(26, 'phase.verify', 3, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 6 * MIN }] }),
      at(26, 'phase.done', 3, {}),
    ], 3);
    assert.deepEqual([attempt!.outcome, attempt!.endedAt], ['done', iso(26)], status);
  }
});

test('AT-1: an outcome read from the ARMED file speaks for an earlier session — inside the next boarding, it ends nothing', () => {
  // `takeArmedOutcome` reads what an orphan left in the outcome file when the
  // NEXT spawn arms it, after that boarding's `phase.start`.
  const [attempt] = attemptsOf([
    at(0, 'phase.start', 4, { attempt: 2 }),
    at(0.1, 'phase.outcome', 4, { via: 'armed-file', status: 'partial', reason: 'other' }),
    at(20, 'phase.session', 4, { attempt: 2, mode: 'resume', ms: 20 * MIN }),
    at(21, 'phase.done', 4, {}),
  ], 4);
  assert.deepEqual([attempt!.outcome, attempt!.endedAt, attempt!.sessions], ['done', iso(21), 1]);
});

test('AT-1: a settled attempt stays settled — the next boarding does not re-settle it, and lines between boardings are not placed', () => {
  const attempts = attemptsOf([
    ...P50,
    at(130, 'phase.rung', 50, { rung: 'unblock-session', situation: 'blocked-declared:unknown' }),
    at(131, 'phase.start', 50, { attempt: 2 }),
    at(150, 'phase.session', 50, { attempt: 2, mode: 'phase', ms: 19 * MIN }),
    at(151, 'phase.done', 50, {}),
  ], 50);
  assert.deepEqual(attempts.map((a) => a.outcome), ['blocked', 'done'], 'never `not-started`, never `superseded`');
  assert.equal(attempts[0]!.endedAt, iso(94.5));
  assert.deepEqual(attempts[1]!.rungs, ['unblock-session'], 'the rung that caused the boarding is still its own');
});

/* ------------------------------------------------------------------ *
 * AT-2 — an attempt's clock never counts the queue
 * ------------------------------------------------------------------ */

test('AT-2: a queued span INSIDE a boarding is not the attempt\'s time — nor is a queue between two boardings', () => {
  const [inside] = attemptsOf([
    at(0, 'phase.start', 5, { attempt: 1 }),
    at(10, 'phase.session', 5, { attempt: 1, mode: 'phase', ms: 10 * MIN }),
    at(10, 'phase.queued', 5, { headClass: 'other-run', head: 'hand' }),
    at(40, 'phase.queue-closed', 5, { outcome: 'admitted', ms: 30 * MIN }),
    at(55, 'phase.session', 5, { attempt: 2, mode: 'phase', ms: 15 * MIN }),
    at(55, 'phase.done', 5, {}),
  ], 5);
  assert.equal(inside!.durationMs, 25 * MIN, '55 minutes on the wall, 30 of them queued');

  // A boarding nothing ended — a journal from before the session-end rule, a
  // console that died — is still `superseded` by the next one; the queue in
  // between comes off its clock all the same.
  const [displaced, next] = attemptsOf([
    at(0, 'phase.start', 5, {}),
    at(40, 'phase.queued', 5, { headClass: 'scope' }),
    at(100, 'phase.admitted', 5, {}),
    at(100, 'phase.start', 5, {}),
    at(120, 'phase.done', 5, {}),
  ], 5);
  assert.deepEqual([displaced!.outcome, displaced!.durationMs], ['superseded', 40 * MIN]);
  assert.equal(next!.durationMs, 20 * MIN);
});

test('AT-2: a queue closed by the NEXT console ended where it was last seen, and an open boarding\'s open queue is not work either', () => {
  const [restarted] = attemptsOf([
    at(0, 'phase.start', 6, { attempt: 1 }),
    at(10, 'phase.queued', 6, { headClass: 'other-run' }),
    // The console holding the queue went away at 15; the next one says so at 100.
    at(100, 'phase.queue-closed', 6, { outcome: 'restarted', since: iso(10), ms: 5 * MIN }),
    at(130, 'phase.session', 6, { attempt: 1, mode: 'phase', ms: 30 * MIN }),
    at(130, 'phase.done', 6, {}),
  ], 6);
  assert.equal(restarted!.durationMs, 125 * MIN, 'five queued minutes, not ninety');

  const [open] = attemptsOf([
    at(0, 'phase.start', 6, { attempt: 1 }),
    at(5, 'phase.queued', 6, { headClass: 'other-run' }),
    at(25, 'phase.resources', 6, { rssMb: 300 }),
  ], 6);
  assert.deepEqual([open!.outcome, open!.durationMs], ['open', 5 * MIN]);
});

/* ------------------------------------------------------------------ *
 * AT-3 — one attempt number
 * ------------------------------------------------------------------ */

test('AT-3: a boarding is numbered by its phase.start\'s attempt — the number its sessions and the record carry', () => {
  // The P41 shape, as the runner journals it now: the second boarding's
  // sessions say 2, and so does `/attempts`.
  const attempts = attemptsOf([
    at(0, 'phase.start', 41, { attempt: 1 }),
    at(59, 'phase.session', 41, { attempt: 1, mode: 'phase', ms: 59 * MIN }),
    at(59.1, 'phase.outcome', 41, { status: 'partial', reason: 'other' }),
    at(700, 'phase.start', 41, { attempt: 2 }),
    at(759, 'phase.session', 41, { attempt: 2, mode: 'resume', ms: 59 * MIN }),
    at(760, 'phase.done', 41, { attempts: 2 }),
  ], 41);
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);

  // A boarding whose first session died on the weather and was re-spawned by
  // the inner loop spent TWO of the phase's numbers; it keeps its first, and
  // the next boarding is 3 — as `record.attempts` and its sessions say.
  const retried = attemptsOf([
    at(0, 'phase.start', 12, { attempt: 1 }),
    at(1, 'phase.session', 12, { attempt: 1, mode: 'phase', ms: MIN, isError: true }),
    at(9, 'phase.session', 12, { attempt: 2, mode: 'phase', ms: 7 * MIN }),
    at(10, 'phase.failed', 12, { attempts: 2 }),
    at(20, 'phase.start', 12, { attempt: 3 }),
    at(30, 'phase.session', 12, { attempt: 3, mode: 'phase', ms: 10 * MIN }),
    at(31, 'phase.done', 12, { attempts: 3 }),
  ], 12);
  assert.deepEqual(retried.map((a) => [a.attempt, a.sessions]), [[1, 2], [3, 1]]);
  assert.deepEqual(compareConsecutive(retried).map((pair) => [pair.from, pair.to]), [[1, 3]]);
});

test('AT-3: a journal written before phase.start carried the number keeps the 1-based boarding index', () => {
  const attempts = attemptsOf([
    at(0, 'phase.start', 2, {}),
    at(5, 'phase.failed', 2, {}),
    at(10, 'phase.start', 2, {}),
    at(15, 'phase.done', 2, {}),
  ], 2);
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
});

/* ------------------------------------------------------------------ *
 * AT-3 and PT-1 through a real Runner — the journal the console writes
 * ------------------------------------------------------------------ */

type Harness = { root: string; scripts: string; markDone: () => void };

function executable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** One phase, whose board reads `done` once the fake session "writes its handoff". */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-attempts-'));
  TRASH.push(root);
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
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  executable(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  executable(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, markDone: () => writeFileSync(join(stub, 'done'), '1\n') };
}

/** A session's API calls, enough for the door to write its `phase.tokens` line. */
const CALLS: TokenCounters = {
  calls: 4, firstContext: 90_000, lastContext: 120_000, peakContext: 120_000,
  input: 400, cacheWrite: 0, cacheRead: 0, output: 200, rebuilds: 0,
};

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-at', costUsd: 0.5, turns: 4, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

test('AT-3 + PT-1: through a real Runner, phase.start, phase.session, phase.tokens and record.attempts carry ONE number — and /attempts reads it back', async () => {
  const h = harness();
  let spawned = 0;
  const runner = new Runner({
    scriptsDir: h.scripts,
    spawn: async (request: SpawnRequest) => {
      spawned += 1;
      if (spawned === 1) {
        // "Work remains — resume me." Any reason but `budget` or `context`,
        // which the resume policy boards fresh.
        const path = request.env?.PE_OUTCOME_FILE;
        assert.ok(typeof path === 'string' && path, 'the runner injects PE_OUTCOME_FILE');
        writeFileSync(path, JSON.stringify({
          version: 1, slug: 'demo', phase: 1, status: 'partial', reason: 'other', written_at: new Date().toISOString(), watch: [],
        }));
        // Woken twice: 120 turns, then 30 — 150 in sum, 120 in its largest prompt.
        return ok({ turns: 150, promptTurns: 120, tokens: CALLS, resultText: 'handing off, resume me' });
      }
      h.markDone();
      return ok({ turns: 9, promptTurns: 9, tokens: CALLS });
    },
    verificationText: () => '`true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
  } as never);
  await runner.start({ slug: 'demo', root: h.root, onlyPhases: [1], autoRecover: true });
  await runner.wait();

  const state = runner.current()!;
  const record = state.phases['1']!;
  assert.equal(record.status, 'done');
  assert.equal(spawned, 2, 'the partial boarded a second time');
  assert.equal(record.attempts, 2);

  const lines = Journal.for(h.root, 'demo', state.id).read();
  const numbers = (event: string) => lines.filter((l) => l.event === event && l.phase === 1).map((l) => l.data?.attempt);
  assert.deepEqual(numbers('phase.start'), [1, 2], 'each boarding names the number its first session takes');
  assert.deepEqual(numbers('phase.session'), [1, 2], 'never the boarding\'s retry index, which restarts at 1');
  assert.deepEqual(numbers('phase.tokens'), [1, 2]);

  const attempts = attemptsOf(lines, 1);
  assert.deepEqual(attempts.map((a) => [a.attempt, a.outcome]), [[1, 'partial'], [2, 'done']]);
  const first = lines.find((l) => l.event === 'phase.session' && l.phase === 1)!;
  assert.equal(attempts[0]!.endedAt, first.time, 'it ended when its session did');
  // …the same instant the record's own window says (#130's "the two sources agree").
  const window = record.attemptWindows?.find((w) => w.attempt === 1);
  assert.ok(window?.endedAt, 'the record closed attempt 1\'s window');
  assert.ok(Math.abs(Date.parse(window!.endedAt!) - Date.parse(attempts[0]!.endedAt!)) < 1_000,
    `the journal's end (${attempts[0]!.endedAt}) and the record's (${window!.endedAt}) agree`);

  // PT-1's journal half: the spawn door writes both figures on the one line.
  assert.deepEqual([first.data?.turns, first.data?.promptTurns], [150, 120]);
});

/* ------------------------------------------------------------------ *
 * PT-1 — the largest prompt, beside the sum
 * ------------------------------------------------------------------ */

/**
 * A session woken twice, as the stream carries it (autopilot-token-drain E3):
 * the boot prompt dispatches an Agent in the background and ends; the runner
 * closes stdin; the agent's completion starts a second prompt — and each
 * prompt's `result` reports only its OWN `num_turns`, as the CLI does. The two
 * counts come from the environment, so the test can put the big one first or
 * last. `PT_NO_RESULT` makes a session killed mid-prompt, before any result.
 */
const TWO_PROMPTS = `#!/usr/bin/env node
'use strict';
const sid = 'sess-pt';
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const first = Number(process.env.PT_FIRST);
const second = Number(process.env.PT_SECOND);
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
let booted = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  if (booted) return;
  booted = true;
  if (process.env.PT_NO_RESULT) {
    for (const id of ['msg_a', 'msg_b', 'msg_c']) {
      say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id, role: 'assistant',
        content: [{ type: 'text', text: 'working' }] } });
    }
    setTimeout(() => process.exit(1), 20);
    return;
  }
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'review', run_in_background: true } }] } });
  say({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent', description: 'review',
    task_type: 'local_agent', is_backgrounded: true, session_id: sid });
  say({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'launched in the background' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_2', role: 'assistant',
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'waiting for the reviewer' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: first, total_cost_usd: 4.5, result: 'waiting', session_id: sid });
  // The agent reports whether or not stdin closed (E3) — and since control-tower
  // phase 109 (#170) the runner holds stdin open until the turn it starts ends.
  setTimeout(notify, 50);
});
let notified = false;
function notify() {
  if (notified) return;
  notified = true;
  say({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent', status: 'completed',
    summary: 'review done', session_id: sid });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_3', role: 'assistant',
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'NOTIFIED' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: second, total_cost_usd: 5.25, result: 'NOTIFIED', session_id: sid });
}
process.stdin.on('end', () => { notify(); setTimeout(() => process.exit(0), 20); });
`;

function stubbed(env: Record<string, string>): SpawnRequest {
  const dir = mkdtempSync(join(tmpdir(), 'pc-pt-'));
  TRASH.push(dir);
  writeFileSync(join(dir, 'claude'), TWO_PROMPTS, 'utf8');
  chmodSync(join(dir, 'claude'), 0o755);
  return { prompt: 'BOOT phase 1', cwd: dir, env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH ?? ''}` } };
}

test('PT-1: a session woken twice sums its prompts\' num_turns (150) and keeps its largest one prompt (120) — through the real spawnClaude', async () => {
  // Big prompt first, then last: neither the first result nor the last may stand in for the largest.
  for (const [first, second] of [[120, 30], [30, 120]] as const) {
    const request = stubbed({ PT_FIRST: String(first), PT_SECOND: String(second) });
    const outcome = await spawnClaude(request);
    assert.equal(outcome.turns, 150, `${first}+${second}: the session total, every prompt summed`);
    assert.equal(outcome.promptTurns, 120, `${first}+${second}: the largest one prompt — what --max-turns binds`);
    assert.equal(outcome.turnsSource, 'result');

    // …and the one record every session writes carries both, side by side.
    const record = sessionRecordOf({ mode: 'phase', request, outcome });
    assert.deepEqual([record.turns, record.promptTurns], [150, 120]);
  }
});

test('PT-1: a session that never reported a result was one prompt — its largest prompt is its whole count', async () => {
  const outcome = await spawnClaude(stubbed({ PT_NO_RESULT: '1' }));
  assert.equal(outcome.turnsSource, 'stream');
  assert.equal(outcome.turns, 3, 'the stream\'s count, for a turn that never closed');
  assert.equal(outcome.promptTurns, 3);
});

test('PT-1: the run\'s ledger carries the largest prompt beside the sum — and a line from before it reads unknown, never the sum', () => {
  // many-plans-one-repo P15 in #62: 338 turns "over" a 300 cap that binds per prompt.
  const ledger = projectLedger([
    at(10, 'phase.session', 15, {
      mode: 'phase', attempt: 1, turns: 338, promptTurns: 300, turnsSource: 'result',
      maxTurns: { value: 300, source: 'measured' }, costUsd: 30, costSource: 'result',
    }),
    at(20, 'phase.session', 15, { mode: 'resume', attempt: 2, turns: 40, turnsSource: 'result', costUsd: 2, costSource: 'result' }),
  ], null);
  assert.deepEqual(ledger.sessions.map((s) => [s.turns, s.promptTurns]), [[338, 300], [40, null]]);
  assert.equal(ledger.totals.turns, 378, 'the run\'s total is still the sum — a total, never read against a cap');
});
