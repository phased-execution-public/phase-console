/**
 * Retention — every sink this console writes, and what bounds it.
 *
 * The bug this module closes is not that any one file grew: it is that the
 * POLICY was scattered. `log.ts` rotated its own file, `sessions/registry.ts`
 * swept its own records, `state.ts` pruned run records, and everything else —
 * transcripts, task ledgers, outcomes, the ignored pile, folded git traces,
 * the supervisor's stdio, the message ledger — grew forever with nobody
 * owning the question. An operator asking "what is using my disk" had no
 * answer to read, and "how long is this kept" had a different answer per sink,
 * none of them written down.
 *
 * So the planner is PURE and the executor is separate. That split is the point
 * of the design and the reason this file can assert every row of the table on a
 * fake clock in milliseconds: an inventory in, a list of actions out, no disk
 * between them. Anything that needs real I/O to be believed — the copy-truncate
 * in particular — gets a real file and a real writer.
 *
 * **The copy-truncate is the one row worth reading twice.** The supervisor's
 * stdout is opened by launchd, held open for the life of the process, and
 * appended to. Rotating it with `rename` leaves launchd writing to an unlinked
 * inode: the console keeps logging, the log file stays empty forever, and
 * nothing anywhere reports an error. Only `ftruncate` on the same inode keeps
 * the writer's next line. That is why the test below writes through a real
 * `O_APPEND` descriptor across the truncation rather than trusting the call.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RETENTION_DEFAULTS,
  type RetentionAction,
  applyRetention,
  collectRetention,
  planRetention,
  sanitiseRetention,
} from '../server/retention.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-18T12:00:00.000Z');

let seq = 0;
function fixture(): string {
  seq += 1;
  const dir = mkdtempSync(join(tmpdir(), `phase-console-retention-${seq}-`));
  return dir;
}

/** Write a file with a chosen size and a chosen age. */
function plant(path: string, bytes: number, ageMs = 0): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x'.repeat(Math.max(0, bytes)));
  // utimesSync takes seconds; the planner reads mtime, never ctime.
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

function actionsFor(actions: RetentionAction[], sink: string): RetentionAction[] {
  return actions.filter((one) => one.sink === sink);
}

// ------------------------------------------------------------------ the policy

test('RET-1 — the shipped defaults are the table the docs promise', () => {
  assert.deepEqual(RETENTION_DEFAULTS, {
    consoleLogMaxBytes: 16 * 1024 * 1024,
    supervisorLogMaxBytes: 32 * 1024 * 1024,
    supervisorLogKeepBytes: 8 * 1024 * 1024,
    runRetainDays: 30,
    runRetainMin: 20,
    runsMaxBytes: 2 * 1024 * 1024 * 1024,
    taskInboxDays: 30,
    rulingsOversizedBytes: 16 * 1024 * 1024,
    outcomeInboxDays: 30,
    outcomeInboxMax: 200,
    sessionEventsMaxBytes: 1024 * 1024,
    gitTraceLeftoverHours: 24,
    gitTraceDirMaxBytes: 64 * 1024 * 1024,
    messagesRotateBytes: 8 * 1024 * 1024,
    messagesRetainDays: 90,
  });
});

test('RET-2 — a nonsense policy value falls back rather than unbounding a sink', () => {
  const policy = sanitiseRetention({
    runRetainDays: -5,
    runsMaxBytes: 'lots',
    outcomeInboxMax: 0,
    supervisorLogKeepBytes: 4 * 1024 * 1024,
  } as never);
  assert.equal(policy.runRetainDays, RETENTION_DEFAULTS.runRetainDays, 'a negative age is the default');
  assert.equal(policy.runsMaxBytes, RETENTION_DEFAULTS.runsMaxBytes, 'a string cap is the default');
  assert.equal(policy.outcomeInboxMax, RETENTION_DEFAULTS.outcomeInboxMax, 'a zero count would delete everything');
  assert.equal(policy.supervisorLogKeepBytes, 4 * 1024 * 1024, 'a sane value is kept');
});

test('RET-3 — keeping more than the cap is refused: a truncation that keeps everything is no truncation', () => {
  const policy = sanitiseRetention({ supervisorLogMaxBytes: 1024, supervisorLogKeepBytes: 4096 } as never);
  assert.ok(
    policy.supervisorLogKeepBytes < policy.supervisorLogMaxBytes,
    'the kept tail must be smaller than the cap that triggers the trim',
  );
});

// ------------------------------------------------------------------ the planner

test('RET-4 — the supervisor stdio is trimmed past its cap and left alone below it', () => {
  const dir = fixture();
  const instance = join(dir, 'state');
  mkdirSync(instance, { recursive: true });
  plant(join(instance, 'console.out.log'), 200);
  plant(join(instance, 'console.err.log'), 20);

  const inventory = collectRetention({ instanceDir: instance, runsDir: null });
  const policy = sanitiseRetention({ supervisorLogMaxBytes: 100, supervisorLogKeepBytes: 40 } as never);
  const actions = planRetention(inventory, policy, NOW);

  const trims = actionsFor(actions, 'supervisor-stdio');
  assert.equal(trims.length, 1, 'only the file past the cap is acted on');
  assert.equal(trims[0].kind, 'truncate');
  assert.match(trims[0].path, /console\.out\.log$/);
  assert.equal(trims[0].keepBytes, 40);
});

test('RET-5 — the console log past its cap is reported oversized, never deleted', () => {
  const dir = fixture();
  const instance = join(dir, 'state');
  mkdirSync(instance, { recursive: true });
  plant(join(instance, 'console.log'), 500);

  const actions = planRetention(
    collectRetention({ instanceDir: instance, runsDir: null }),
    sanitiseRetention({ consoleLogMaxBytes: 100 } as never),
    NOW,
  );
  const rows = actionsFor(actions, 'console-log');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'oversized', 'only the writer that owns the file may rotate it');
});

test('RET-6 — rulings are never pruned; past the cap they are reported and left', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(plan, { recursive: true });
  plant(join(plan, 'rulings.ndjson'), 500, 400 * DAY);

  const actions = planRetention(
    collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs }),
    sanitiseRetention({ rulingsOversizedBytes: 100 } as never),
    NOW,
  );
  const rows = actionsFor(actions, 'rulings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'oversized');
  assert.ok(
    !actions.some((one) => one.kind === 'delete' && one.path.endsWith('rulings.ndjson')),
    'the ruling ledger is the record — nothing deletes it',
  );
});

test('RET-7 — the task inbox and the outcome inbox go by age, and the ignored pile with them', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(join(plan, 'tasks'), { recursive: true });
  mkdirSync(join(plan, 'outcomes', 'ignored'), { recursive: true });
  plant(join(plan, 'tasks', 'phase-01.ndjson'), 10, 40 * DAY);
  plant(join(plan, 'tasks', 'phase-02.ndjson'), 10, 2 * DAY);
  plant(join(plan, 'outcomes', 'phase-03.json'), 10, 40 * DAY);
  plant(join(plan, 'outcomes', 'ignored', 'phase-04.json.stale'), 10, 40 * DAY);
  plant(join(plan, 'outcomes', 'ignored', 'phase-05.json.stale'), 10, 1 * DAY);

  const actions = planRetention(
    collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs }),
    RETENTION_DEFAULTS,
    NOW,
  );
  const gone = actions.filter((one) => one.kind === 'delete').map((one) => one.path);
  assert.ok(gone.some((p) => p.endsWith('phase-01.ndjson')), 'a 40-day task ledger goes');
  assert.ok(!gone.some((p) => p.endsWith('phase-02.ndjson')), 'a 2-day one stays');
  assert.ok(gone.some((p) => p.endsWith('phase-03.json')), 'a 40-day outcome goes');
  assert.ok(gone.some((p) => p.endsWith('phase-04.json.stale')), 'the ignored pile ages too');
  assert.ok(!gone.some((p) => p.endsWith('phase-05.json.stale')), 'a fresh ignored outcome stays');
});

test('RET-8 — the outcome inbox has a count cap as well as an age, oldest first', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(join(plan, 'outcomes'), { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    plant(join(plan, 'outcomes', `phase-${String(i).padStart(2, '0')}.json`), 10, i * 60_000);
  }

  const actions = planRetention(
    collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs }),
    sanitiseRetention({ outcomeInboxMax: 4 } as never),
    NOW,
  );
  const gone = actionsFor(actions, 'outcome-inbox')
    .filter((one) => one.kind === 'delete')
    .map((one) => one.path);
  assert.equal(gone.length, 2, 'six files, a cap of four');
  assert.ok(gone.every((p) => /phase-0[45]\.json$/.test(p)), `the two OLDEST go, not the two newest: ${gone}`);
});

test('RET-9 — git-trace leftovers go by age and the console directory by size', () => {
  const dir = fixture();
  const instance = join(dir, 'state');
  mkdirSync(join(instance, 'git-trace', 'console'), { recursive: true });
  plant(join(instance, 'git-trace', 'console', 'old.json'), 10, 30 * 60 * 60_000);
  plant(join(instance, 'git-trace', 'console', 'new.json'), 10, 60_000);

  const actions = planRetention(
    collectRetention({ instanceDir: instance, runsDir: null }),
    RETENTION_DEFAULTS,
    NOW,
  );
  const gone = actionsFor(actions, 'git-trace').map((one) => one.path);
  assert.ok(gone.some((p) => p.endsWith('old.json')), 'a raw trace file older than a day is a leftover');
  assert.ok(!gone.some((p) => p.endsWith('new.json')), 'a fresh one may still be drained');
});

test('RET-10 — the message ledger rotates at its cap and the rotated copy ages out', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(plan, { recursive: true });
  plant(join(plan, 'messages.ndjson'), 500);
  plant(join(plan, 'messages.ndjson.1'), 10, 200 * DAY);

  const actions = planRetention(
    collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs }),
    sanitiseRetention({ messagesRotateBytes: 100 } as never),
    NOW,
  );
  const rows = actionsFor(actions, 'messages');
  assert.ok(
    rows.some((one) => one.kind === 'rotate' && one.path.endsWith('messages.ndjson')),
    'the live ledger is rotated, never rewritten under a session that is appending to it',
  );
  assert.ok(
    rows.some((one) => one.kind === 'delete' && one.path.endsWith('messages.ndjson.1')),
    'the rotated copy is what ages out',
  );
});

test('RET-11 — a session events log with no record left is swept', () => {
  const dir = fixture();
  const instance = join(dir, 'state');
  mkdirSync(join(instance, 'sessions'), { recursive: true });
  writeFileSync(join(instance, 'sessions', 'kept.json'), '{"sessionId":"kept"}');
  plant(join(instance, 'sessions', 'kept.events.ndjson'), 10);
  plant(join(instance, 'sessions', 'gone.events.ndjson'), 10);

  const actions = planRetention(
    collectRetention({ instanceDir: instance, runsDir: null }),
    RETENTION_DEFAULTS,
    NOW,
  );
  const gone = actionsFor(actions, 'session-events').map((one) => one.path);
  assert.deepEqual(
    gone.map((p) => p.split('/').pop()),
    ['gone.events.ndjson'],
    'an events log is pruned WITH its record, never before it',
  );
});

test('RET-12 — the global runs cap deletes oldest-finished-first and never a live run', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(plan, { recursive: true });
  const record = (id: string, status: string, at: string): void => {
    writeFileSync(join(plan, `run-${id}.json`), JSON.stringify({ id, status, updatedAt: at }));
  };
  record('aaaaaaaa', 'finished', '2026-09-01T00:00:00.000Z');
  record('bbbbbbbb', 'finished', '2026-09-10T00:00:00.000Z');
  record('cccccccc', 'running', '2026-09-02T00:00:00.000Z');
  plant(join(plan, 'run-aaaaaaaa.jsonl'), 400);
  plant(join(plan, 'run-bbbbbbbb.jsonl'), 400);
  plant(join(plan, 'run-cccccccc.jsonl'), 400);

  const actions = planRetention(
    collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs, live: { demo: ['cccccccc'] } }),
    sanitiseRetention({ runsMaxBytes: 700, runRetainMin: 0 } as never),
    NOW,
  );
  const gone = actionsFor(actions, 'run-records')
    .filter((one) => one.kind === 'delete')
    .map((one) => one.path);
  assert.ok(gone.some((p) => p.includes('aaaaaaaa')), 'the oldest finished run goes first');
  assert.ok(!gone.some((p) => p.includes('cccccccc')), 'a live run is never a candidate, whatever the clock says');
});

// ------------------------------------------------------------------ the executor

test('RET-13 — copy-truncate leaves an O_APPEND writer’s NEXT line intact', () => {
  const dir = fixture();
  const path = join(dir, 'console.out.log');
  writeFileSync(path, '');

  // launchd's descriptor: opened once, held for the life of the process.
  const writer = openSync(path, 'a');
  for (let i = 0; i < 200; i += 1) writeSync(writer, `line ${i}\n`);
  const before = statSync(path).size;

  const kept = 200;
  const done = applyRetention([
    { kind: 'truncate', sink: 'supervisor-stdio', path, bytes: before, keepBytes: kept, why: 'test' },
  ]);
  assert.equal(done.failed.length, 0, `the trim failed: ${JSON.stringify(done.failed)}`);

  // The same descriptor, after the trim — this is the whole point.
  writeSync(writer, 'AFTER THE TRIM\n');
  closeSync(writer);

  const text = readFileSync(path, 'utf8');
  assert.ok(text.endsWith('AFTER THE TRIM\n'), 'a rename would have sent this line to an unlinked inode');
  assert.ok(statSync(path).size <= kept + 'AFTER THE TRIM\n'.length, 'the file is bounded after the trim');
  assert.ok(text.includes('line 199'), 'the TAIL is what is kept — the newest lines, not the oldest');
  assert.ok(!text.includes('line 0\n'), 'the head is what goes');
  assert.ok(!text.startsWith('ine'), 'the kept tail starts on a whole line');
});

test('RET-14 — the executor deletes, rotates, and reports what it could not do', () => {
  const dir = fixture();
  const gone = join(dir, 'gone.json');
  const live = join(dir, 'messages.ndjson');
  writeFileSync(gone, 'x');
  writeFileSync(live, 'y');

  const done = applyRetention([
    { kind: 'delete', sink: 'task-inbox', path: gone, bytes: 1, why: 'older than 30 days' },
    { kind: 'rotate', sink: 'messages', path: live, bytes: 1, why: 'past 8 MB' },
    { kind: 'delete', sink: 'task-inbox', path: join(dir, 'never-existed.json'), bytes: 0, why: 'test' },
    { kind: 'oversized', sink: 'rulings', path: join(dir, 'rulings.ndjson'), bytes: 99, why: 'test' },
  ]);

  assert.equal(existsSync(gone), false, 'a delete deletes');
  assert.equal(existsSync(live), false, 'a rotate moves the live file aside');
  assert.equal(readFileSync(`${live}.1`, 'utf8'), 'y', 'and the content is what moved');
  assert.equal(done.swept, 2, 'the missing file is not counted as swept');
  assert.equal(done.failed.length, 0, 'a file already gone is the desired state, not a failure');
  assert.equal(done.oversized, 1, 'an oversized row is reported and nothing is touched');
});

test('RET-15 — planning twice over an unchanged tree asks for the same work, and once applied asks for none', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(join(plan, 'tasks'), { recursive: true });
  plant(join(plan, 'tasks', 'phase-01.ndjson'), 10, 40 * DAY);

  const scan = { instanceDir: join(dir, 'state'), runsDir: runs };
  const first = planRetention(collectRetention(scan), RETENTION_DEFAULTS, NOW);
  const second = planRetention(collectRetention(scan), RETENTION_DEFAULTS, NOW);
  assert.deepEqual(first, second, 'the planner is pure: same tree, same clock, same plan');

  applyRetention(first);
  const third = planRetention(collectRetention(scan), RETENTION_DEFAULTS, NOW);
  assert.deepEqual(third, [], 'a swept tree asks for nothing — the sweep is idempotent');
});

test('RET-16 — an empty state directory is quiet: no sink, no action, no throw', () => {
  const dir = fixture();
  const inventory = collectRetention({ instanceDir: join(dir, 'nothing-here'), runsDir: join(dir, 'nor-here') });
  assert.deepEqual(inventory.files, []);
  assert.deepEqual(planRetention(inventory, RETENTION_DEFAULTS, NOW), []);
});

test('RET-17 — every sink the policy names is one the inventory can report', () => {
  const dir = fixture();
  const instance = join(dir, 'state');
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(join(instance, 'sessions'), { recursive: true });
  mkdirSync(join(instance, 'git-trace', 'console'), { recursive: true });
  mkdirSync(join(plan, 'tasks'), { recursive: true });
  mkdirSync(join(plan, 'outcomes', 'ignored'), { recursive: true });
  plant(join(instance, 'console.log'), 1);
  plant(join(instance, 'console.out.log'), 1);
  plant(join(instance, 'sessions', 'a.events.ndjson'), 1);
  plant(join(instance, 'git-trace', 'console', 'r.json'), 1);
  plant(join(plan, 'tasks', 'phase-01.ndjson'), 1);
  plant(join(plan, 'outcomes', 'phase-01.json'), 1);
  plant(join(plan, 'rulings.ndjson'), 1);
  plant(join(plan, 'messages.ndjson'), 1);
  plant(join(plan, 'run-aaaaaaaa.jsonl'), 1);
  writeFileSync(join(plan, 'run-aaaaaaaa.json'), '{"id":"aaaaaaaa","status":"finished"}');

  const seen = new Set(collectRetention({ instanceDir: instance, runsDir: runs }).files.map((one) => one.sink));
  for (const sink of [
    'console-log',
    'supervisor-stdio',
    'session-events',
    'git-trace',
    'task-inbox',
    'outcome-inbox',
    'rulings',
    'messages',
    'run-records',
  ]) {
    assert.ok(seen.has(sink as never), `the inventory never reported ${sink} — its policy row is unreachable`);
  }
});

test('RET-18 — a transcript, a task ledger and a folded git trace age with their run record', () => {
  const dir = fixture();
  const runs = join(dir, 'runs');
  const plan = join(runs, 'demo');
  mkdirSync(plan, { recursive: true });
  writeFileSync(
    join(plan, 'run-aaaaaaaa.json'),
    JSON.stringify({ id: 'aaaaaaaa', status: 'finished', updatedAt: '2026-09-17T12:00:00.000Z' }),
  );
  // Sidecars written long ago; the RECORD is a day old, so nothing here is due.
  plant(join(plan, 'run-aaaaaaaa.log.jsonl'), 10, 400 * DAY);
  plant(join(plan, 'run-aaaaaaaa-p1-tasks.ndjson'), 10, 400 * DAY);
  plant(join(plan, 'run-aaaaaaaa.git.ndjson'), 10, 400 * DAY);

  const inventory = collectRetention({ instanceDir: join(dir, 'state'), runsDir: runs });
  const sidecars = inventory.files.filter((one) => one.runId === 'aaaaaaaa');
  assert.equal(sidecars.length, 4, 'the record and its three sidecars');
  for (const file of sidecars) {
    assert.equal(
      file.at,
      Date.parse('2026-09-17T12:00:00.000Z'),
      `${file.path} must age with its run record, not with its own mtime`,
    );
  }
});

// ------------------------------------------------------------------ pruneRuns

test('RET-19 — pruneRuns removes the run’s five sidecars, not just the record and journal', async () => {
  const { pruneRuns, runDir } = await import('../server/runner/state.ts');
  const slug = `retention-sidecars-${Date.now()}`;
  const plan = runDir('/tmp/retention-fixture-root', slug);
  mkdirSync(join(plan, 'git-trace', 'aaaaaaaa'), { recursive: true });
  const old = Date.parse('2026-01-01T00:00:00.000Z');
  writeFileSync(
    join(plan, 'run-aaaaaaaa.json'),
    JSON.stringify({ id: 'aaaaaaaa', status: 'finished', updatedAt: new Date(old).toISOString() }),
  );
  const sidecars = [
    join(plan, 'run-aaaaaaaa.jsonl'),
    join(plan, 'run-aaaaaaaa.log.jsonl'),
    join(plan, 'run-aaaaaaaa-p3-tasks.ndjson'),
    join(plan, 'run-aaaaaaaa.git.ndjson'),
    join(plan, 'git-trace', 'aaaaaaaa', 'raw.json'),
  ];
  for (const path of sidecars) writeFileSync(path, 'x');
  // A different run's files must survive — a prefix match would take these too.
  writeFileSync(join(plan, 'run-aaaaaaaabbbb.log.jsonl'), 'keep me');

  const removed = pruneRuns('/tmp/retention-fixture-root', slug, null, NOW, 30 * DAY, 0);
  assert.deepEqual(removed, ['aaaaaaaa']);
  for (const path of sidecars) {
    assert.equal(existsSync(path), false, `${path} outlived the run record it belongs to`);
  }
  assert.equal(existsSync(join(plan, 'git-trace', 'aaaaaaaa')), false, 'the run’s raw trace directory goes with it');
  assert.equal(readFileSync(join(plan, 'run-aaaaaaaabbbb.log.jsonl'), 'utf8'), 'keep me');
  rmSync(plan, { recursive: true, force: true });
});

test('RET-20 — an unreadable or unfinished record is still never swept', async () => {
  const { pruneRuns, runDir } = await import('../server/runner/state.ts');
  const slug = `retention-unfinished-${Date.now()}`;
  const plan = runDir('/tmp/retention-fixture-root', slug);
  mkdirSync(plan, { recursive: true });
  writeFileSync(join(plan, 'run-aaaaaaaa.json'), 'not json at all');
  writeFileSync(
    join(plan, 'run-bbbbbbbb.json'),
    JSON.stringify({ id: 'bbbbbbbb', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' }),
  );
  writeFileSync(join(plan, 'run-bbbbbbbb.log.jsonl'), 'live');

  assert.deepEqual(pruneRuns('/tmp/retention-fixture-root', slug, null, NOW, 30 * DAY, 0), []);
  assert.equal(existsSync(join(plan, 'run-bbbbbbbb.log.jsonl')), true, 'an unfinished run keeps its transcript');
  rmSync(plan, { recursive: true, force: true });
});

test('RET-21 — appendFileSync through a fresh descriptor after a trim also lands', () => {
  // The other half of RET-13: a writer that OPENS the file per line (the bash
  // scripts' shape) must also find a whole file rather than a hole.
  const dir = fixture();
  const path = join(dir, 'console.err.log');
  writeFileSync(path, `${'z'.repeat(500)}\n`);
  applyRetention([
    { kind: 'truncate', sink: 'supervisor-stdio', path, bytes: 501, keepBytes: 100, why: 'test' },
  ]);
  appendFileSync(path, 'next\n');
  assert.ok(readFileSync(path, 'utf8').endsWith('next\n'));
  assert.ok(statSync(path).size < 200);
});
