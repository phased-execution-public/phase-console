/**
 * Git's own Trace2 event stream, folded into one line per process.
 *
 * `git.command` (the seam) says what the console asked git to do. Trace2 says
 * what git then DID — which children it forked, which worktree it decided it
 * was in, how long each phase took, and the errors it printed to nobody. The
 * two answer different questions and the second is off by default, because git
 * writes a file per process and a drive runs hundreds.
 *
 * The join between them is the SID. Git forms its session id as
 * `<GIT_TRACE2_PARENT_SID>/<its own>`, and the seam sets that parent to
 * `pc-<traceId>-<spanId>` — so a raw Trace2 file, found on its own with no
 * other record, still says which span ran it. That is the property this file
 * exists to hold: everything else here is bookkeeping around it.
 *
 * The raw file is DELETED once folded. A directory of unbounded per-process
 * JSON in the state directory is the failure mode this feature would otherwise
 * be, and the folded line is strictly more useful than the file it replaces.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type GitTrace, drainGitTraces, foldTrace2, gitTraceMode, setGitTraceDir } from '../server/git-trace.ts';
import { shell } from '../server/shell.ts';
import { current, envCarrier, enter, parseGitSid, runTraceId } from '../server/trace.ts';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-git-trace-'));

test.after(() => {
  delete process.env.PHASE_CONSOLE_GIT_TRACE2;
  rmSync(dir, { recursive: true, force: true });
});

/** A Trace2 event file as git 2.39+ actually writes one. */
function trace2File(sid: string): string {
  return [
    { event: 'version', sid, thread: 'main', time: '2026-09-18T10:00:00.000000Z', evt: '3', exe: '2.39.3' },
    { event: 'start', sid, thread: 'main', t_abs: 0.001, argv: ['git', 'merge', '--no-ff', 'pe/x'] },
    { event: 'cmd_name', sid, thread: 'main', name: 'merge', hierarchy: 'merge' },
    { event: 'worktree', sid, thread: 'main', path: '/tmp/repo' },
    { event: 'child_start', sid, thread: 'main', child_id: 0, argv: ['git', 'read-tree'] },
    { event: 'child_exit', sid, thread: 'main', child_id: 0, code: 0, t_rel: 0.004 },
    { event: 'child_start', sid, thread: 'main', child_id: 1, argv: ['git', 'merge-recursive'] },
    { event: 'child_exit', sid, thread: 'main', child_id: 1, code: 1, t_rel: 0.021 },
    { event: 'error', sid, thread: 'main', msg: 'CONFLICT (content): Merge conflict in a.txt' },
    { event: 'exit', sid, thread: 'main', t_abs: 0.042, code: 1 },
    { event: 'atexit', sid, thread: 'main', t_abs: 0.043, code: 1 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('the mode is off unless asked for, and says which kind of asking', () => {
  assert.equal(gitTraceMode({}), 'off');
  assert.equal(gitTraceMode({ PHASE_CONSOLE_GIT_TRACE2: '' }), 'off');
  assert.equal(gitTraceMode({ PHASE_CONSOLE_GIT_TRACE2: '0' }), 'off');
  assert.equal(gitTraceMode({ PHASE_CONSOLE_GIT_TRACE2: '1' }), 'console');
  assert.equal(gitTraceMode({ PHASE_CONSOLE_GIT_TRACE2: 'sessions' }), 'sessions');
  assert.equal(gitTraceMode({ PHASE_CONSOLE_GIT_TRACE2: 'nonsense' }), 'off',
    'a word nobody defined is OFF — a tracer that turns itself on by accident fills a disk');
});

test('one process folds to one line, with what git decided rather than what it was asked', () => {
  const folded = foldTrace2(trace2File('pc-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '/20260918T100000.1-P00001'));

  assert.ok(folded);
  assert.equal(folded.cmd, 'merge');
  assert.deepEqual(folded.argv, ['git', 'merge', '--no-ff', 'pe/x']);
  assert.equal(folded.worktree, '/tmp/repo', 'the tree GIT concluded it was in, which is the interesting one');
  assert.equal(folded.code, 1);
  assert.equal(folded.children, 2);
  assert.deepEqual(folded.errors, ['CONFLICT (content): Merge conflict in a.txt']);
  assert.ok(folded.ms !== undefined && folded.ms >= 42, `t_abs 0.042s should read as ms, got ${folded.ms}`);
});

test('the SID carries the span, so a raw file on its own says which span ran it', () => {
  const traceId = runTraceId('inst', 'slug', 'run-gt');
  const carrier = enter({ traceId, name: 'phase.attempt' }, () => envCarrier());
  const parent = String(carrier.GIT_TRACE2_PARENT_SID);

  // Exactly what git does with a parent sid: its own, appended after a slash.
  const folded = foldTrace2(trace2File(`${parent}/20260918T100000.1-P00001`));

  assert.ok(folded);
  assert.equal(folded.parentSid, parent, 'the parent half is recovered verbatim');
  assert.equal(folded.traceId, traceId, 'and resolved back to the trace…');
  assert.equal(folded.spanId, carrier.PE_SPAN_ID, '…and the span');
  assert.deepEqual(parseGitSid(folded.sid), { traceId, spanId: String(carrier.PE_SPAN_ID) });
});

test('a git run with no parent sid still folds — it just joins nothing', () => {
  const folded = foldTrace2(trace2File('20260918T100000.1-P00001'));

  assert.ok(folded);
  assert.equal(folded.parentSid, undefined);
  assert.equal(folded.traceId, undefined);
  assert.equal(folded.cmd, 'merge', 'and everything that does not depend on the join is still there');
});

test('a file that is not Trace2, or is half-written, folds to nothing rather than throwing', () => {
  assert.equal(foldTrace2(''), null);
  assert.equal(foldTrace2('not json at all\n'), null);
  assert.equal(foldTrace2('{"event":"version"'), null, 'a truncated first line');
  // A file cut off mid-run has a start and no exit: that IS a fold, and the
  // missing exit code is the fact worth keeping.
  const partial = foldTrace2('{"event":"start","sid":"s","argv":["git","status"]}\n{"event":"cmd_n');
  assert.ok(partial);
  assert.equal(partial.code, undefined, 'a process whose exit was never written has no code, not code 0');
});

test('draining folds every file, writes one ndjson line each, and DELETES the raw', () => {
  const traceDir = join(dir, 'drain');
  mkdirSync(traceDir, { recursive: true });
  const sink = join(dir, 'run-abc.git.ndjson');
  for (let i = 0; i < 3; i++) writeFileSync(join(traceDir, `trace-${i}`), trace2File(`sid-${i}`));

  const report = drainGitTraces(traceDir, { sink });

  assert.equal(report.folded, 3);
  assert.equal(report.capped, false);
  assert.deepEqual(readdirSync(traceDir), [], 'the raw files are gone — this directory must not grow');

  const lines = readFileSync(sink, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { sid: string }).sid).sort(), ['sid-0', 'sid-1', 'sid-2']);
});

test('draining is bounded, says so ONCE, and still clears what it will not fold', () => {
  const traceDir = join(dir, 'capped');
  mkdirSync(traceDir, { recursive: true });
  const sink = join(dir, 'run-capped.git.ndjson');
  for (let i = 0; i < 10; i++) writeFileSync(join(traceDir, `trace-${i}`), trace2File(`sid-${i}`));

  const report = drainGitTraces(traceDir, { sink, cap: 4 });

  assert.equal(report.folded, 4);
  assert.equal(report.capped, true);
  assert.deepEqual(readdirSync(traceDir), [],
    'the files past the cap are removed too — the cap bounds the RECORD, not the cleanup');
  assert.equal(readFileSync(sink, 'utf8').trimEnd().split('\n').length, 4);
});

test('end to end: a REAL git run under the seam folds to a line naming the span that ran it', async () => {
  process.env.PHASE_CONSOLE_GIT_TRACE2 = '1';
  const traceDir = join(dir, 'live');
  const sink = join(dir, 'run-live.git.ndjson');
  setGitTraceDir(traceDir);
  try {
    const traceId = runTraceId('inst', 'slug', 'run-live');
    const spanId = await enter({ traceId, name: 'phase.attempt' }, async () => {
      const seen = current()!.spanId;
      await shell('git', ['--version'], { channel: 'git', intent: 'version', cwd: dir });
      return seen;
    });

    const report = drainGitTraces(traceDir, { sink });
    assert.ok(report.folded >= 1, `git wrote no Trace2 file — folded ${report.folded}`);

    const traces = readFileSync(sink, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as GitTrace);
    const ours = traces.find((t) => t.spanId === spanId);
    assert.ok(ours, 'the folded line must name the span the seam was inside');
    assert.equal(ours.traceId, traceId);
    assert.equal(parseGitSid(ours.sid)?.spanId, spanId, 'and the sid itself carries it, with no other record needed');
  } finally {
    setGitTraceDir(null);
    delete process.env.PHASE_CONSOLE_GIT_TRACE2;
  }
});

test('with tracing OFF the seam sets no GIT_TRACE2_EVENT, even if the shell exported one', async () => {
  delete process.env.PHASE_CONSOLE_GIT_TRACE2;
  setGitTraceDir(join(dir, 'should-not-be-used'));
  process.env.GIT_TRACE2_EVENT = join(dir, 'operators-own');
  try {
    const run = await shell('node', ['-e', 'process.stdout.write(String(process.env.GIT_TRACE2_EVENT))'], {
      channel: 'git',
      intent: 'probe',
    });
    assert.equal(run.stdout, 'undefined', 'an inherited GIT_TRACE2_EVENT is DELETED, not passed on');
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    setGitTraceDir(null);
  }
});

test('draining a directory that does not exist is a no-op, not a throw', () => {
  const report = drainGitTraces(join(dir, 'never-made'), { sink: join(dir, 'x.ndjson') });
  assert.equal(report.folded, 0);
  assert.equal(report.capped, false);
  assert.equal(existsSync(join(dir, 'x.ndjson')), false, 'and writes nothing');
});
