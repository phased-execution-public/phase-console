/**
 * A progress event on the active task (control-tower phase 95, #163 PR-1).
 *
 * "Vendor is at 45 of 68" lived only in a session's prose, so the console could
 * say a phase was on its heaviest task and never how far into it. A session
 * now says it in one line — `phase-outcome.sh <slug> <N> progress --label
 * <text> --done <n> --of <m>` — which rides the task channel the runner
 * already tails while the session works (`PE_TASKS_FILE`), so it is journalled
 * as `phase.progress` on the ACTIVE task at the next tool result, not at exit.
 * A malformed call is refused whole: exit 2, nothing written, nothing
 * journalled.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTaskEvents } from '../server/runner/tasks.ts';
import { boardHarness, journalled } from './lane-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outcome = join(repoRoot, 'scripts', 'phase-outcome.sh');
const tasks = join(repoRoot, 'scripts', 'phase-tasks.sh');

function run(script: string, args: string[], env: Record<string, string | undefined>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PE_')));
  return spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { ...clean, ...env } as NodeJS.ProcessEnv });
}

test('PR-1: `progress` appends ONE line to the task channel — label, done, of, the time', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'p95-progress-')), 'tasks.ndjson');
  const r = run(outcome, ['demo', '3', 'progress', '--label', 'iOS sweep vendor', '--done', '45', '--of', '68'], {
    PE_TASKS_FILE: file, PE_NOW: '2026-09-26T11:30:00Z', PE_SESSION_ID: 'sess-abc',
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!);
  assert.deepEqual(line, {
    version: 1, type: 'progress', slug: 'demo', phase: 3, label: 'iOS sweep vendor', done: 45, of: 68,
    written_at: '2026-09-26T11:30:00Z', session_id: 'sess-abc',
  });
  // …and the reader the runner tails hands it back, apart from the task list.
  const read = readTaskEvents(file, { slug: 'demo', phase: 3 });
  assert.deepEqual(read.events, [], 'a progress line is not a task transition');
  assert.deepEqual(read.progress, [{ label: 'iOS sweep vendor', done: 45, of: 68, at: '2026-09-26T11:30:00Z', after: 0 }]);
});

test('PR-1: a malformed call exits 2 and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p95-malformed-'));
  const cases: string[][] = [
    ['progress', '--done', '4', '--of', '9'],
    ['progress', '--label', '', '--done', '4', '--of', '9'],
    ['progress', '--label', 'sweep', '--done', 'four', '--of', '9'],
    ['progress', '--label', 'sweep', '--done', '4'],
    ['progress', '--label', 'sweep', '--done', '4', '--of', '0'],
    ['progress', '--label', 'sweep', '--done', '10', '--of', '9'],
    ['progress', '--label', 'sweep', '--done', '4', '--of', '9', '--reason', 'an outcome flag'],
    ['partial', '--label', 'sweep', '--reason', 'context'],
  ];
  cases.forEach((args, i) => {
    const file = join(dir, `t${i}.ndjson`);
    const r = run(outcome, ['demo', '3', ...args], { PE_TASKS_FILE: file, PE_OUTCOME_FILE: join(dir, `o${i}.json`) });
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(file), false, `${args.join(' ')} wrote the task channel`);
    assert.equal(existsSync(join(dir, `o${i}.json`)), false, `${args.join(' ')} wrote an outcome`);
  });
});

test('PR-1: a hand-written line the script would refuse is refused by the reader too', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'p95-forged-')), 'tasks.ndjson');
  const at = '2026-09-26T11:30:00Z';
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({ version: 1, type: 'progress', slug: 'demo', phase: 3, label: 'x', done: 1, of: 2, written_at: at, ...over });
  const body = [line({ done: 3, of: 2 }), line({ of: 0 }), line({ label: '' }), line({ done: -1 }), line({ slug: 'other' }), line({})].join('\n') + '\n';
  writeFileSync(file, body);
  const read = readTaskEvents(file, { slug: 'demo', phase: 3 });
  assert.equal(read.progress.length, 1);
  assert.equal(read.progress[0]!.label, 'x');
});

test('PR-1: a supervised session\'s progress is journalled as `phase.progress` on its ACTIVE task, and kept on the record', async () => {
  const h = boardHarness({
    states: { 1: 'ready' },
    onSpawn: (_phase, request) => {
      const env = { PE_TASKS_FILE: (request as { env?: Record<string, string> }).env?.PE_TASKS_FILE };
      assert.ok(env.PE_TASKS_FILE, 'the runner arms the task channel for the session');
      for (const args of [
        ['create', '--subject', 'p1.task1 — run the iOS sweep'],
        ['update', '--id', 'p1.task1', '--status', 'in_progress'],
      ]) assert.equal(run(tasks, ['demo', '1', ...args], env).status, 0);
      assert.equal(run(outcome, ['demo', '1', 'progress', '--label', 'iOS sweep vendor', '--done', '45', '--of', '68'], env).status, 0);
      return undefined;
    },
  });
  await h.runner.start({ slug: 'demo', root: h.root, maxParallel: 1 } as never);
  await h.runner.wait();

  const rows = journalled(h, 'phase.progress');
  assert.equal(rows.length, 1, JSON.stringify(h.events.map((e) => (e.data as { event?: string }).event)));
  assert.equal(rows[0]!.phase, 1);
  assert.equal(rows[0]!.label, 'iOS sweep vendor');
  assert.equal(rows[0]!.done, 45);
  assert.equal(rows[0]!.of, 68);
  assert.equal(rows[0]!.task, 'p1.task1');
  assert.ok(Date.parse(String(rows[0]!.at)), 'the time the session said it');

  const record = (h.runner.current() as { phases: Record<string, { progress?: Record<string, unknown> }> }).phases['1']!;
  assert.deepEqual({ ...record.progress, at: undefined }, { label: 'iOS sweep vendor', done: 45, of: 68, task: 'p1.task1', at: undefined });
});

test('PR-1: the event has its row in docs/journal-events.md, and the verb is documented for sessions', () => {
  const events = readFileSync(join(repoRoot, 'docs', 'journal-events.md'), 'utf8');
  assert.match(events, /^\| `phase\.progress` \| journal \| `runner\/runner\.ts` \|/m);
  const surface = readFileSync(join(repoRoot, 'references', 'console-surface.md'), 'utf8');
  assert.match(surface, /phase-outcome\.sh <slug> <N> progress --label/);
});
