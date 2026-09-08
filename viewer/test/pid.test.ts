/**
 * The one probe — `server/pid.ts`.
 *
 * These tests pin the three answers the tree used to be unable to give, and
 * the identity check that stops a recycled pid from pinning a run forever.
 * The `ps` reader is a seam, so none of this needs a real stopped process.
 */

// `registry.ts` reaches config through its import graph; the sandbox has to
// redirect XDG_STATE_HOME before anything resolves it. See state-sandbox.ts.
import './state-sandbox.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_COMM, forgetPid, pidAlive, processState, setPsReader, type PsReader,
} from '../server/pid.ts';
import { presenceOf } from '../server/sessions/registry.ts';

/** `ps -o stat=,comm=,lstart=` output for a pid, as one row. */
function ps(rows: Record<number, { stat: string; comm?: string; lstart?: string }>): PsReader {
  return (pid) => {
    const row = rows[pid];
    if (!row) return null;
    return { stat: row.stat, comm: row.comm ?? 'claude', lstart: row.lstart ?? 'Sat Aug 22 20:30:07 2026' };
  };
}

/** Every probe question is about THIS process, which certainly exists. */
const SELF = process.pid;

test('processState: the four answers, and the flags after the state letter', () => {
  const restore = setPsReader(ps({
    [SELF]: { stat: 'S+' },
  }));
  try {
    assert.equal(processState(SELF), 'running', 'S is running; the + is a flag, not the state');

    for (const [stat, expected] of [
      ['R', 'running'], ['S', 'running'], ['I', 'running'], ['D', 'running'], ['U', 'running'],
      ['Ss', 'running'], ['SN', 'running'], ['R<', 'running'],
      ['T', 'stopped'], ['t', 'stopped'], ['T+', 'stopped'],
      ['Z', 'zombie'], ['Z+', 'zombie'],
    ] as const) {
      forgetPid();
      setPsReader(ps({ [SELF]: { stat } }));
      assert.equal(processState(SELF), expected, `${stat} should read ${expected}`);
    }
  } finally { setPsReader(restore); forgetPid(); }
});

test('processState: a pid nobody has is gone, and so is a nonsense pid', () => {
  // No seam needed — `kill(0)` alone settles these, which is the point: the
  // cheap answer comes first and `ps` is never spawned for a dead pid.
  assert.equal(processState(0), 'gone');
  assert.equal(processState(-1), 'gone');
  assert.equal(processState(1.5), 'gone');
  assert.equal(processState(2_147_483_646), 'gone', 'a pid this high is not in use');
});

test('processState: a `ps` that cannot answer degrades to what kill(0) proves, never to gone', () => {
  const restore = setPsReader(() => null);
  try {
    assert.equal(processState(SELF), 'running',
      'could-not-read is not could-not-find; the safe direction for a probe that takes things away');
  } finally { setPsReader(restore); forgetPid(); }
});

test('processState: identity — a recycled pid is gone, by comm and by start time', () => {
  // `ps` prints lstart in the MACHINE's zone and production parses it with the
  // machine's zone, so the pair always agrees. The expectations below must be
  // derived the same way — a hardcoded UTC instant bakes in the author's
  // offset and fails on any runner whose TZ differs (it did, on CI's UTC).
  const LSTART = 'Sat Aug 22 20:30:07 2026';
  const LSTART_MS = Date.parse(LSTART);
  const restore = setPsReader(ps({ [SELF]: { stat: 'S', comm: 'zsh', lstart: LSTART } }));
  try {
    assert.equal(processState(SELF), 'running', 'with no expectation, whatever is there is there');
    assert.equal(processState(SELF, { expect: CLAUDE_COMM }), 'gone',
      'we started a claude; this pid is a zsh, so our process is gone');

    forgetPid();
    setPsReader(ps({ [SELF]: { stat: 'S', comm: 'claude', lstart: LSTART } }));
    assert.equal(processState(SELF, { expect: CLAUDE_COMM }), 'running');
    assert.equal(processState(SELF, { startedAt: new Date(LSTART_MS).toISOString() }), 'running',
      'the same instant expressed in UTC — equal in every timezone');
    assert.equal(processState(SELF, { startedAt: '2020-01-01T00:00:00Z' }), 'gone',
      'a start time six years off is a different process wearing the same pid');
    assert.equal(processState(SELF, { startedAt: LSTART_MS + 30_000 }), 'running',
      'half a minute of slack is within tolerance — lstart has one-second resolution');
  } finally { setPsReader(restore); forgetPid(); }
});

test('pidAlive: a stopped process is still very much there', () => {
  const restore = setPsReader(ps({ [SELF]: { stat: 'T' } }));
  try {
    assert.equal(processState(SELF), 'stopped');
    assert.equal(pidAlive(SELF), true,
      'it holds its files, its session and its tree — "alive" is the honest boolean');
    assert.equal(pidAlive(2_147_483_646), false);
  } finally { setPsReader(restore); forgetPid(); }
});

test('presenceOf: a STOPPED session is never live — the line the Sessions page was missing', () => {
  const at = (min: number) => new Date(Date.parse('2026-08-22T17:30:00Z') + min * 60_000).toISOString();
  const record = {
    sessionId: 's1', kind: 'autopilot' as const, cwd: '/repo',
    startedAt: at(0), lastSeen: at(0), turns: 0, pid: 4242,
  };
  const now = Date.parse(at(30));

  assert.equal(presenceOf(record, now, () => 'running'), 'live');
  assert.equal(presenceOf(record, now, () => 'gone'), 'ended');
  assert.equal(presenceOf(record, now, () => 'stopped'), 'unknown',
    'NOT live — nothing schedules it; and NOT ended, because ending it would make its lock debris '
    + 'and releasing that lock is what anonymised the live session in the incident');
  assert.equal(presenceOf(record, now, () => 'zombie'), 'unknown');

  // The boolean seam still means what it always meant.
  assert.equal(presenceOf(record, now, () => true), 'live');
  assert.equal(presenceOf(record, now, () => false), 'ended');
  assert.equal(presenceOf(record, now, () => { throw new Error('ps broke'); }), 'live',
    'a probe that cannot answer never demotes');
});

test('`comm` is the column, because `ucomm` names the versioned binary', () => {
  // Measured on a live session: `ps -o ucomm=` answers "2.1.239" (the binary
  // the CLI execs) while `ps -o comm=` answers "claude". Asking for the
  // accounting name would make every real child fail its own identity check.
  const restore = setPsReader(ps({ [SELF]: { stat: 'S', comm: 'claude' } }));
  try {
    assert.equal(processState(SELF, { expect: CLAUDE_COMM }), 'running');

    forgetPid();
    setPsReader(ps({ [SELF]: { stat: 'S', comm: '2.1.239' } }));   // what ucomm would have given
    assert.equal(processState(SELF, { expect: CLAUDE_COMM }), 'gone',
      'the versioned binary name matches nothing — this is why the column matters');

    // And the other trap: a multi-column `comm` truncates at 16 characters, so
    // a long path arrives as a prefix. `expect` is therefore never passed by a
    // caller whose `gone` would take something away.
    forgetPid();
    setPsReader(ps({ [SELF]: { stat: 'S', comm: '/home/someone/.n' } }));
    assert.equal(processState(SELF, { expect: CLAUDE_COMM }), 'gone');
    assert.equal(processState(SELF), 'running', 'without an expectation, existence is the answer');
  } finally { setPsReader(restore); forgetPid(); }
});

test('the real reader asks ps for comm, not ucomm', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../server/pid.ts', import.meta.url), 'utf8'));
  assert.match(source, /'stat=,comm=,lstart='/, 'ucomm names the versioned binary, not the CLI');
});
