/**
 * Reconcile reopens what the board regressed, and closes only on committed
 * content (control-tower phase 79, #113).
 *
 * The reconcile pass flips a record the board has overtaken to `done` — "closed
 * while checkpointed — the board reads done; not verified by this run" — and it
 * was one-way: measured, an unfinished handoff scaffold, untracked and reading
 * `complete`, turned a phase done on the board; reconcile closed the run's
 * record against it while the phase's own session was checkpointed; the
 * scaffold was moved aside, the board went back to `in-progress`, and the
 * record stayed `done`. Nothing drove the phase for fourteen hours, and its
 * checkpointed session was abandoned rather than resumed.
 *
 *   RC-1  a record reconcile closed is reopened `pending` when the board no
 *         longer reads it done — `phase.reopened`, `resumeSessionId` kept — so
 *         the next boarding resumes the checkpointed session; a record THIS run
 *         verified is never reopened, and an unreadable board reopens nothing;
 *   RC-2  it is re-read on every drive tick, not once: the reopen lands on the
 *         tick after the regression, before that tick's ladder pass, and a
 *         record can close and reopen as often as the board moves;
 *   RC-3  only committed handoff content closes a record: an untracked or
 *         uncommitted `complete` handoff holds the close (`phase.reconcile-held`)
 *         until it is committed.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const state_ = await import('../server/runner/state.ts');
const { newRun, phaseRecord, reconcileRecordsAgainstBoard, RECONCILED_ATTEMPTED_NOTE } = state_;
type RunState = import('../server/runner/state.ts').RunState;

type Events = { event: string; data: Record<string, unknown> }[];

const journalled = (events: Events, name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number | undefined }));

type BoardShape = {
  phased: true; states: Record<number, string>; done: number[]; inProgress: number[]; stuck: number[];
  ready: number[]; waiting: number[]; blockedBy: Record<number, number[]>; qa: Record<number, string>;
};

function board(words: Record<number, string>): BoardShape {
  const of = (word: string) => Object.entries(words).filter(([, w]) => w === word).map(([p]) => Number(p));
  return {
    phased: true, states: words, done: of('done'), inProgress: of('in-progress'), stuck: of('stuck'),
    ready: of('ready'), waiting: of('waiting'), blockedBy: {}, qa: {},
  };
}

/** A runner with a state installed and no loop: the drive tick's record passes, run for real. */
class Tick extends Runner {
  install(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
  }

  /** The tick's record-truth pass (`applyReconcile`). */
  async reconcile(b: BoardShape): Promise<void> {
    await (this as unknown as { applyReconcile(b: unknown): Promise<void> | void }).applyReconcile(b);
  }

  /** The tick's ladder pass, after it. */
  async ladder(b: BoardShape): Promise<void> {
    await (this as unknown as { climbLadder(b: unknown, asked: Set<number> | null): Promise<void> }).climbLadder(b, null);
  }
}

function tick(events: Events, extra: Record<string, unknown> = {}): Tick {
  return new Tick({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    ...extra,
  } as never);
}

/** Phase 1 as a live wall left it: checkpointed, its session kept for the next attempt. */
function checkpointedRun(root: string): RunState {
  const state = newRun({ slug: 'demo', root, autoRecover: true });
  const record = phaseRecord(state, 1);
  record.status = 'pending';
  record.attempts = 1;
  record.startedAt = new Date(Date.now() - 3_600_000).toISOString();
  record.sessionId = 'sess-ck';
  record.resumeSessionId = 'sess-ck';
  record.note = 'checkpointed (account switch by operator) — the next attempt resumes session sess-ck';
  return state;
}

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reopen-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ *
 * RC-1 — a record reconcile closed is reopened when the board regresses
 * ------------------------------------------------------------------ */

test('RC-1: the pure pass — a record reconcile closed reopens pending when the board no longer reads it done, keeping its session', () => {
  const { reopenRegressedRecords } = state_ as unknown as {
    reopenRegressedRecords: (s: RunState, b: Record<number, string>) => { changed: boolean; reopened: { phase: number; board: string; closedAt: string | null }[] };
  };
  assert.equal(typeof reopenRegressedRecords, 'function', 'state.ts exports the reverse of the close');
  const state = checkpointedRun('/nowhere');
  const closed = reconcileRecordsAgainstBoard(state, { 1: 'done' });
  assert.deepEqual(closed.closed, [1]);
  const record = state.phases['1'];
  assert.equal(record.status, 'done');
  assert.equal(record.note, RECONCILED_ATTEMPTED_NOTE);
  assert.ok(record.reconciled, 'the close says it was the board\'s, not this run\'s verification');

  const back = reopenRegressedRecords(state, { 1: 'in-progress' });
  assert.equal(back.changed, true);
  assert.deepEqual(back.reopened.map((r) => [r.phase, r.board]), [[1, 'in-progress']]);
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'sess-ck', 'the checkpointed session is what the next boarding resumes');
  assert.equal(record.reconciled, undefined, 'the close it undid is gone');
  assert.match(record.note ?? '', /reopened/i);
});

test('RC-1: the drive tick journals phase.reopened, and the next boarding resumes the checkpointed session', async () => {
  const { root, cleanup } = tempRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    const state = checkpointedRun(root);
    runner.install(state);
    await runner.reconcile(board({ 1: 'done', 2: 'waiting' }));
    assert.equal(state.phases['1'].status, 'done', 'closed on the board\'s word');
    assert.equal(journalled(events, 'phase.reconciled').length, 1);

    await runner.reconcile(board({ 1: 'in-progress', 2: 'waiting' }));
    const record = state.phases['1'];
    assert.equal(record.status, 'pending', 'reopened');
    const reopened = journalled(events, 'phase.reopened');
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].phase, 1);
    assert.equal(reopened[0].board, 'in-progress');
    assert.equal(reopened[0].resumeSessionId, 'sess-ck');
    assert.ok(reopened[0].closedAt, 'names when the close it undid happened');

    // The same tick's ladder pass takes it: its own session, resumed.
    await runner.ladder(board({ 1: 'in-progress', 2: 'waiting' }));
    assert.equal(record.boardingHint?.sessionId, 'sess-ck');
    assert.equal(record.boardingHint?.brief, 'continue');
  } finally {
    cleanup();
  }
});

test('RC-1: a record this run verified is never reopened, and a board that could not be read reopens nothing', async () => {
  const { root, cleanup } = tempRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    const state = checkpointedRun(root);
    // Phase 2: done by this run's own lane — verified, no reconcile stamp.
    const verified = phaseRecord(state, 2);
    verified.status = 'done';
    verified.endedAt = new Date().toISOString();
    verified.verification = { ok: true, ran: [], reason: 'green' } as never;
    runner.install(state);
    await runner.reconcile(board({ 1: 'done', 2: 'done' }));
    assert.equal(state.phases['1'].status, 'done');

    // The engine answered nothing for either phase.
    await runner.reconcile(board({}));
    assert.equal(state.phases['1'].status, 'done', 'no word from the board is not a regression');
    await runner.reconcile(board({ 1: 'unknown', 2: 'unknown' }));
    assert.equal(state.phases['1'].status, 'done');

    // The board regresses on both: only the one reconcile closed reopens.
    await runner.reconcile(board({ 1: 'in-progress', 2: 'in-progress' }));
    assert.equal(state.phases['1'].status, 'pending');
    assert.equal(state.phases['2'].status, 'done', 'this run verified it — the board does not outrank that');
    assert.deepEqual(journalled(events, 'phase.reopened').map((e) => e.phase), [1]);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * RC-2 — every tick, as often as the board moves
 * ------------------------------------------------------------------ */

test('RC-2: re-read on every tick — a record closes and reopens as often as the board moves, and an unchanged board changes nothing', async () => {
  const { root, cleanup } = tempRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    const state = checkpointedRun(root);
    runner.install(state);
    const words = ['done', 'done', 'in-progress', 'in-progress', 'done', 'stuck'];
    const seen: string[] = [];
    for (const word of words) {
      await runner.reconcile(board({ 1: word }));
      seen.push(state.phases['1'].status);
    }
    assert.deepEqual(seen, ['done', 'done', 'pending', 'pending', 'done', 'pending']);
    assert.equal(journalled(events, 'phase.reconciled').length, 2, 'closed twice');
    assert.equal(journalled(events, 'phase.reopened').length, 2, 'reopened twice');
    assert.equal(state.phases['1'].resumeSessionId, 'sess-ck', 'the session survives every round trip');
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * RC-3 — only committed handoff content closes a record
 * ------------------------------------------------------------------ */

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

function gitRoot(): { root: string; handoff: (status: string) => string; cleanup: () => void } {
  const { root, cleanup } = tempRoot();
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  writeFileSync(join(root, 'docs', 'handoffs', 'demo', 'INDEX.md'), '# demo\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'plan');
  const path = join(root, 'docs', 'handoffs', 'demo', 'phase-01-the-work.md');
  return {
    root,
    handoff: (status) => {
      writeFileSync(path, `---\nphase: 1\nstatus: ${status}\n---\n\n## What this phase did\n\nThe work.\n`);
      return path;
    },
    cleanup,
  };
}

test('RC-3: an untracked complete handoff never closes a record — the close waits until it is committed', async () => {
  const { root, handoff, cleanup } = gitRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    const state = checkpointedRun(root);
    runner.install(state);
    handoff('complete');
    await runner.reconcile(board({ 1: 'done' }));
    assert.equal(state.phases['1'].status, 'pending', 'the board reads an untracked file — not closed');
    const held = journalled(events, 'phase.reconcile-held');
    assert.equal(held.length, 1);
    assert.equal(held[0].phase, 1);
    assert.match(String(held[0].reason), /not committed|uncommitted|untracked/);
    // Held once per content, not once per tick.
    await runner.reconcile(board({ 1: 'done' }));
    assert.equal(journalled(events, 'phase.reconcile-held').length, 1);

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'phase 1 handoff');
    await runner.reconcile(board({ 1: 'done' }));
    assert.equal(state.phases['1'].status, 'done', 'committed: the board\'s word closes it');
    assert.equal(journalled(events, 'phase.reconciled').length, 1);
  } finally {
    cleanup();
  }
});

test('RC-3: a committed handoff flipped to complete in the working tree does not close the record either', async () => {
  const { root, handoff, cleanup } = gitRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    handoff('in-progress');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'phase 1 in progress');
    const state = checkpointedRun(root);
    runner.install(state);
    handoff('complete');
    await runner.reconcile(board({ 1: 'done' }));
    assert.equal(state.phases['1'].status, 'pending');
    assert.equal(journalled(events, 'phase.reconcile-held').length, 1);
  } finally {
    cleanup();
  }
});

test('RC-3: a docs root git cannot answer for keeps the old rule — the board\'s word closes the record', async () => {
  const { root, cleanup } = tempRoot();
  const events: Events = [];
  const runner = tick(events);
  try {
    const state = checkpointedRun(root);
    runner.install(state);
    await runner.reconcile(board({ 1: 'done' }));
    assert.equal(state.phases['1'].status, 'done', '"I could not ask" is not "uncommitted"');
    assert.deepEqual(journalled(events, 'phase.reconcile-held'), []);
  } finally {
    cleanup();
  }
});
