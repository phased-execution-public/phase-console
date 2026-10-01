/**
 * A usage wall has a rung the runner drives (control-tower phase 79, #98).
 *
 * A phase that hit a usage limit mid-session is checkpointed back to
 * `pending`, its session kept for the next attempt, and the board goes on
 * reading it `in-progress` — so only the drive loop's ladder pass can ever
 * board it again. `resource-wall:usage`'s three rungs (`switch-account`,
 * `switch-model`, `wait-window`) were all the HEALER's, and the healer climbs
 * only a stopped run: on a run that kept driving other phases the pass wrote
 * `phase.ladder-deferred` and left the phase pending — measured, for hours
 * after the window had reset, with lanes free.
 *
 *   UW-1  a wall that still stands, with no account to move to, parks the
 *         phase on the wall's reset through the runner's own `wait-window` —
 *         never a deferral — and the phase re-boards at the reset, resuming
 *         the session it was checkpointed from;
 *   UW-2  an account with more room takes the run and the phase resumes there
 *         (`switch-account`, the runner's own vehicle); an account with no more
 *         room than the walled one is never taken; and a wall that has LIFTED
 *         is no wall — the classifier re-judges it on the run's live account
 *         (#106) and the phase resumes in place, on the account it is on;
 *   UW-3  a ladder that still defers — a rung only the healer drives — raises
 *         a visible card at once: `undriven.deferred` on the record, the
 *         deferral journalled once rather than on every re-check, and an inbox
 *         row that names the rung and offers Retry;
 *   UW-4  the card over the runner's own `wait-window` park is re-derived at
 *         every reading (`withWallReadings`, control-tower phase 86, #78): a
 *         live wall before its reset, the reset and the CURRENT holder after
 *         it, and the newest re-read's `lastReading` — never the park's
 *         frozen words.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { newRun, phaseRecord, saveRun, waitClockOf } from '../server/runner/state.ts';
import type { RunState } from '../server/runner/state.ts';
import { withWallReadings } from '../shared/situation-model.js';
import type { HeadroomVerdict } from '../server/accounts/index.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

process.env.PHASE_CONSOLE_LOG = '';

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Events = { event: string; data: Record<string, unknown> }[];

const journalled = (events: Events, name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * The note a checkpoint at a live wall leaves (`checkpointLane`). Built from
 * parts: the classifier reads it, and a test file is not the place to spell a
 * sentence the classifier matches in one piece.
 */
const WALL_NOTE = `checkpointed (${'rate'} limited mid-session (rate_limit) — 3 ${'rate'}-limit events in 30s `
  + 'with no work between them) — the next attempt resumes session sess-walled';

/** A run whose phase 1 was checkpointed at a usage wall and left pending. */
function walledRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'demo', root, autoRecover: true });
  Object.assign(state, over);
  const record = phaseRecord(state, 1);
  record.status = 'pending';
  record.attempts = 1;
  record.startedAt = new Date(Date.now() - HOUR).toISOString();
  record.sessionId = 'sess-walled';
  record.resumeSessionId = 'sess-walled';
  record.note = WALL_NOTE;
  return state;
}

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

/** A runner with a state installed and no loop — the ladder pass, run for real. */
class Loop extends Runner {
  install(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
  }

  async pass(b: BoardShape): Promise<void> {
    await (this as unknown as { climbLadder(b: unknown, asked: Set<number> | null): Promise<void> }).climbLadder(b, null);
  }
}

/**
 * The accounts facade as the runner sees it, per account: a wall is a reset in
 * the future, and the quota door reads it — exactly as the learned store does.
 * `room` is what `Accounts.roomOf` answers, a percent left or null unread.
 */
function accounts(walls: Record<string, string | null>, room: Record<string, number | null> = {}) {
  const headroom = (accountId: string | undefined): HeadroomVerdict => {
    const id = accountId ?? 'default';
    const until = walls[id];
    return until && Date.parse(until) > Date.now()
      ? { ok: false, accountId: id, kind: 'wall', resetsAt: until, reason: `${id} hit its usage limit` }
      : { ok: true, accountId: id };
  };
  return {
    walls,
    headroom,
    roomOf: (accountId: string | undefined) => {
      const id = accountId ?? 'default';
      const verdict = headroom(id);
      return {
        ok: verdict.ok, headroomPct: verdict.ok ? (room[id] ?? null) : 0,
        resetsAt: verdict.ok ? null : (verdict as { resetsAt?: string }).resetsAt ?? null, why: verdict.ok ? 'room' : 'walled',
      };
    },
    candidates: (excluding: string | undefined) => ({
      ranked: Object.keys(walls).filter((id) => id !== (excluding ?? 'default') && headroom(id).ok),
      declined: [], wake: null,
    }),
  };
}

/** What the service's healer answers for a usage wall's table on a stopped run. */
const healerDrives = (vehicles: string[]) => (_slug: string, rung: { vehicle: string }) => vehicles.includes(rung.vehicle);

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-wall-rung-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ *
 * UW-1 — a wall that still stands: the runner parks on its reset
 * ------------------------------------------------------------------ */

test('UW-1: a phase left pending on a usage wall that still stands is parked on the reset by the runner\'s own rung — never deferred to a healer that only climbs a stopped run', async () => {
  const { root, cleanup } = tempRoot();
  const reset = new Date(Date.now() + 2 * HOUR).toISOString();
  const account = accounts({ default: reset });
  const events: Events = [];
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    accountHeadroom: account.headroom,
    accountRoom: account.roomOf,
    switchCandidates: account.candidates,
    rungDrivable: healerDrives(['switch-account', 'wait-window']),
    wallReprobeBackoffMs: [HOUR],
  } as never);
  try {
    const state = walledRun(root);
    loop.install(state);
    await loop.pass(board({ 1: 'in-progress', 2: 'waiting' }));
    const record = state.phases['1'];

    assert.deepEqual(journalled(events, 'phase.ladder-deferred'), [], 'the runner drives this table itself — nothing is left for a stop that never comes');
    assert.equal(journalled(events, 'phase.situation')[0]?.situation, 'resource-wall:usage');
    assert.equal(record.status, 'waiting', 'parked on the window, not left pending');
    assert.equal(record.parkedUntil, reset, 'until the reset the account reports');
    assert.equal(record.usageWall?.account, 'default');
    assert.equal(record.usageWall?.latest, reset, 'a wall the re-reads can lift early (phase 54)');
    assert.equal(record.resumeSessionId, 'sess-walled', 'the session it resumes at the reset is kept');
    const rung = journalled(events, 'phase.rung').at(-1)!;
    assert.deepEqual({ rung: rung.rung, vehicle: rung.vehicle }, { rung: 'wait-window', vehicle: 'runner' });
    assert.equal(rung.until, reset);
    assert.equal(state.recoveries?.['1']?.rungs?.at(-1)?.rung, 'wait-window', 'accounted like any climb');
    assert.equal(state.phases['1'].undriven, undefined, 'a parked phase has a clock — it is not undriven');
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * UW-4 — the card over that park is read now, never at the park
 * ------------------------------------------------------------------ */

test('UW-4: the card over the runner\'s own wait-window park is re-derived at every reading — the wall before its reset, the reset and the current holder after it, the newest re-read beside it', async () => {
  const { root, cleanup } = tempRoot();
  const reset = new Date(Date.now() + 2 * HOUR).toISOString();
  const account = accounts({ default: reset });
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: () => {},
    accountHeadroom: account.headroom,
    accountRoom: account.roomOf,
    switchCandidates: account.candidates,
    rungDrivable: healerDrives(['switch-account', 'wait-window']),
    wallReprobeBackoffMs: [HOUR],
  } as never);
  try {
    const state = walledRun(root);
    loop.install(state);
    await loop.pass(board({ 1: 'in-progress', 2: 'waiting' }));
    const record = state.phases['1'];
    assert.equal(record.status, 'waiting');
    assert.equal(record.situation?.key, 'resource-wall:usage', 'the park is the ladder\'s own, over its own situation');
    const parkedWhy = record.situation?.why?.[0];

    // A reading while the wall stands: kept on the record, answered on the card.
    assert.equal(loop.rereadWalls('reading'), 0, 'the wall still stands — nothing moved');
    const reading = record.usageWall?.lastReading;
    assert.equal(reading?.by, 'reading');
    assert.equal(reading?.ok, false);
    assert.equal(reading?.resetsAt, reset);

    const before = withWallReadings(state, Date.now()).phases['1'];
    assert.equal(before.wall?.reset, false);
    assert.equal(before.wall?.latest, reset, 'the absolute reset, not a span measured at the park');
    assert.match(before.wall?.sentence ?? '', /a live wall with no account to move to — the window resets in .+ at the latest/);
    assert.deepEqual(before.wall?.lastReading, { at: reading!.at, by: 'reading', ok: false, resetsAt: reset }, 'the newest re-read rides beside the "at the latest" time (#78)');
    assert.equal(before.situation?.why?.[0], before.wall?.sentence, 'situation.why leads with the live sentence');
    assert.equal(state.phases['1'].wall, undefined, 'a copy — the runner\'s own state is never written by a reader');
    assert.equal(state.phases['1'].situation?.why?.[0], parkedWhy);

    // Past the reset, the same record reads differently — with nobody ahead of it…
    const after = withWallReadings(state, Date.parse(reset) + 60_000).phases['1'];
    assert.equal(after.wall?.reset, true);
    assert.match(after.wall?.sentence ?? '', /the usage window reset at .+ — boarding at the next free lane, ahead of phases that never started/);
    assert.equal(after.situation?.why?.[0], after.wall?.sentence);
    assert.doesNotMatch(after.situation?.why?.[0] ?? '', /resets in/, 'never the park\'s frozen "resets in"');

    // …and naming whoever holds its scope at the moment it is read.
    record.waitingOn = [{ slug: 'other', phase: 4, owner: 'autopilot/0123456789ab' }];
    const held = withWallReadings(state, Date.parse(reset) + 60_000).phases['1'];
    assert.match(held.wall?.sentence ?? '', /the usage window reset at .+ — waiting for autopilot\/0123456789ab/);
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});

/* The live half: the park ends at the reset and the phase boards itself. */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** Phase 1's handoff reads in-progress; 2 and 3 wait on it. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-wall-rung-live-'));
  const scripts = join(root, 'scripts');
  const S = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(S, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(S, 'done'), '');
  writeFileSync(join(S, 'inprog'), '1\n');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${S}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""; w=""; i=""; found=0
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif grep -qx "$p" "$S/inprog" 2>/dev/null; then i="$i$p,"; found=1
      elif [ "$found" -eq 0 ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: \${i%,}"; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => {
      writeFileSync(join(S, 'done'), `${readFileSync(join(S, 'done'), 'utf8')}${phase}\n`);
      writeFileSync(join(S, 'inprog'), '');
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-walled', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

test('UW-1: at the reset the parked phase boards by itself, resuming the session it was checkpointed from', async () => {
  const r = repo();
  // The wall has to still stand when the runner's first ladder pass reads it,
  // or the phase is rightly resumed in place (UW-2's lifted wall) and no
  // `wait-window` rung is ever climbed. That pass lands ~0.6–0.8 s in on a busy
  // machine running this file alone, and past 1.5 s under a loaded full suite —
  // the window is sized for that, not for an idle laptop.
  const reset = new Date(Date.now() + 5_000).toISOString();
  // The run is DRIVING when the wall arrives — mid-session, as #98 measured —
  // so its start's own quota door passed. A start made while the wall stands
  // is the run preflight's to refuse (ACT-2), a different path.
  const account = accounts({ default: null });
  const events: Events = [];
  const learnWall = (event: string, data: Record<string, unknown>) => {
    if (event === 'run:journal' && data.event === 'run.start' && account.walls.default === null) account.walls.default = reset;
  };
  const asked: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    asked.push(request);
    r.markDone(1);
    return ok();
  };
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => { events.push({ event, data }); learnWall(event, data); },
    accountHeadroom: account.headroom,
    switchCandidates: account.candidates as never,
    wallReprobeBackoffMs: [HOUR],
  });
  const seeded = walledRun(r.root, { status: 'parked' } as Partial<RunState>);
  saveRun(seeded);
  try {
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: seeded.id, onlyPhases: [1], autonomy: 'keep-going', autoRecover: true });
    // The service's half of a settled wait: resume the run from its clock.
    const end = Date.now() + 15_000;
    while (instance.current()?.phases['1']?.status !== 'done') {
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(instance.current()?.phases['1'])} (run ${instance.current()?.status})`);
      const state = instance.current();
      const clock = state ? waitClockOf(state) : null;
      if (state && !instance.busy() && state.status === 'waiting' && clock && Date.parse(clock) <= Date.now()) {
        await instance.start({ slug: 'demo', root: r.root, resumeRunId: state.id, onlyPhases: [1], autonomy: 'keep-going' });
      }
      await sleep(10);
    }
    await instance.wait();

    assert.deepEqual(journalled(events, 'phase.ladder-deferred'), [], 'never deferred');
    assert.equal(asked.length, 1, 'one session: the resume at the reset');
    assert.equal(asked[0].resume, 'sess-walled', 'the checkpointed session is resumed, not boarded fresh');
    const wait = journalled(events, 'phase.rung').find((rung) => rung.rung === 'wait-window');
    assert.ok(wait, 'the wait was the runner\'s own rung');
    assert.equal(instance.current()!.phases['1'].status, 'done');
  } finally {
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * UW-2 — a switch when an account has more room; in place when the wall lifted
 * ------------------------------------------------------------------ */

test('UW-2: an account with more room takes the run and the phase resumes there, through the runner\'s own switch', async () => {
  const { root, cleanup } = tempRoot();
  const reset = new Date(Date.now() + 2 * HOUR).toISOString();
  const account = accounts({ default: reset, 'acct-b': null }, { 'acct-b': 80 });
  const events: Events = [];
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    accountHeadroom: account.headroom,
    accountRoom: account.roomOf,
    switchCandidates: account.candidates,
    rungDrivable: healerDrives(['switch-account', 'wait-window']),
    wallReprobeBackoffMs: [HOUR],
  } as never);
  try {
    const state = walledRun(root);
    loop.install(state);
    await loop.pass(board({ 1: 'in-progress' }));
    const record = state.phases['1'];

    assert.deepEqual(journalled(events, 'phase.ladder-deferred'), []);
    assert.equal(state.accountId, 'acct-b', 'the run moved to the account with room');
    const moved = journalled(events, 'phase.account-switch').at(-1)!;
    assert.deepEqual({ from: moved.from, to: moved.to }, { from: 'default', to: 'acct-b' });
    const rung = journalled(events, 'phase.rung').at(-1)!;
    assert.deepEqual({ rung: rung.rung, vehicle: rung.vehicle }, { rung: 'switch-account', vehicle: 'runner' });
    assert.equal(record.status, 'pending');
    assert.equal(record.boardingHint?.rung, 'switch-account');
    assert.equal(record.boardingHint?.sessionId, 'sess-walled', 'it resumes the session it was checkpointed from');
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});

test('UW-2: an account with no more room than the walled one is never taken — the phase parks on the reset instead', async () => {
  const { root, cleanup } = tempRoot();
  const reset = new Date(Date.now() + 2 * HOUR).toISOString();
  // Readable and open, but at 0 % left: a switch would only move the wall closer.
  const account = accounts({ default: reset, 'acct-b': null }, { 'acct-b': 0 });
  const events: Events = [];
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    accountHeadroom: account.headroom,
    accountRoom: account.roomOf,
    switchCandidates: account.candidates,
    rungDrivable: healerDrives(['switch-account', 'wait-window']),
    wallReprobeBackoffMs: [HOUR],
  } as never);
  try {
    const state = walledRun(root);
    loop.install(state);
    await loop.pass(board({ 1: 'in-progress' }));
    assert.equal(state.accountId ?? 'default', 'default', 'not moved onto less headroom');
    assert.deepEqual(journalled(events, 'phase.account-switch'), []);
    assert.equal(state.phases['1'].status, 'waiting');
    assert.equal(state.phases['1'].parkedUntil, reset);
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});

test('UW-2 (#106): a wall that has lifted is no wall — the run\'s own account has room, so the phase resumes in place, with no switch and no park', async () => {
  const { root, cleanup } = tempRoot();
  // The run was moved to acct-b by a person; acct-b walled earlier and has since reset.
  const account = accounts({ default: null, 'acct-b': new Date(Date.now() - 60_000).toISOString() }, { default: 90, 'acct-b': 40 });
  const events: Events = [];
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    accountHeadroom: account.headroom,
    accountRoom: account.roomOf,
    switchCandidates: account.candidates,
    rungDrivable: healerDrives(['switch-account', 'wait-window']),
    wallReprobeBackoffMs: [HOUR],
  } as never);
  try {
    const state = walledRun(root, { accountId: 'acct-b' } as Partial<RunState>);
    state.accountChoice = { accountId: 'acct-b', from: 'default', at: new Date().toISOString(), by: 'operator' };
    loop.install(state);
    await loop.pass(board({ 1: 'in-progress' }));
    const record = state.phases['1'];

    const situation = journalled(events, 'phase.situation').at(-1)!;
    assert.equal(situation.situation, 'work-in-progress', 're-judged on the live meters of the run\'s own account');
    assert.match(String((situation.why as string[]).join(' ')), /acct-b/, 'the why names the account that has room');
    assert.equal(state.accountId, 'acct-b', 'a person\'s switch is not reverted on a stale wall');
    assert.deepEqual(journalled(events, 'phase.account-switch'), []);
    assert.equal(record.status, 'pending');
    assert.equal(record.boardingHint?.rung, 'resume-own-session');
    assert.equal(record.boardingHint?.sessionId, 'sess-walled', 'resumed in place, in its own session');
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * UW-3 — a deferral raises a card
 * ------------------------------------------------------------------ */

/** A phase whose session declared itself blocked on the outside world, with no ref to poll. */
function blockedRun(root: string): RunState {
  const state = newRun({ slug: 'demo', root, autoRecover: true });
  const record = phaseRecord(state, 1);
  record.status = 'pending';
  record.attempts = 1;
  record.startedAt = new Date(Date.now() - HOUR).toISOString();
  record.sessionId = 'sess-blocked';
  record.declared = {
    status: 'blocked', reason: 'the deploy window opens tonight', needs: 'external', at: new Date().toISOString(),
  } as never;
  return state;
}

test('UW-3: a ladder that defers to the healer raises a visible card at once — undriven.deferred on the record, one journal line, an inbox row with Retry', async () => {
  const { root, cleanup } = tempRoot();
  const events: Events = [];
  const loop = new Loop({
    scriptsDir: '/nonexistent',
    verificationText: () => undefined,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    rungDrivable: healerDrives(['timed-park']),
    ladderSeenTtlMs: () => 0,
  } as never);
  try {
    const state = blockedRun(root);
    loop.install(state);
    await loop.pass(board({ 1: 'stuck' }));
    const record = state.phases['1'];

    const deferred = journalled(events, 'phase.ladder-deferred');
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].next, 'timed-park');
    assert.equal(record.status, 'pending', 'nothing this run drives picked it up');
    assert.ok(record.undriven, 'the record says it is undriven');
    assert.equal(record.undriven!.board, 'stuck');
    assert.equal(record.undriven!.situation, 'blocked-declared:external');
    assert.equal(record.undriven!.deferred?.next, 'timed-park');
    assert.match(record.undriven!.why, /healer|stopped run/i, 'and why nothing drives it');
    const since = record.undriven!.since;

    // The fingerprint has expired (TTL 0): the phase is looked at again, and the
    // SAME deferral is not journalled twice, nor does its clock restart.
    await loop.pass(board({ 1: 'stuck' }));
    assert.equal(journalled(events, 'phase.ladder-deferred').length, 1, 'one line per deferral, not per look');
    assert.equal(state.phases['1'].undriven?.since, since, 'the episode keeps its start');

    // The card: raised at once for a deferral, with the verb that boards it now.
    const { buildInbox } = await import('../server/inbox.ts');
    state.status = 'running';
    const { items } = buildInbox({ runs: [state as never], flags: { allowRun: true } } as never, Date.now());
    const row = items.find((item) => item.kind === 'stall' && item.id.endsWith(':undriven'));
    assert.ok(row, `an undriven row: ${JSON.stringify(items.map((i) => i.id))}`);
    assert.equal(row!.phase, 1);
    assert.match(row!.title, /phase 1/);
    assert.match(row!.need, /timed-park|Park for a while/, 'names the rung the healer would climb');
    const retry = row!.actions.find((action) => action.verb === 'retry');
    assert.ok(retry, 'Retry boards it now');
    assert.equal(retry!.endpoint, '/api/run/demo/retry');
    assert.deepEqual(retry!.body, { phase: 1 });
  } finally {
    await loop.stop().catch(() => undefined);
    cleanup();
  }
});
