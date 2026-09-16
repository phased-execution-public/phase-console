/**
 * Carrying a session transcript between accounts' config dirs.
 *
 * What must hold: the source file is found by SESSION ID (never by re-deriving
 * the CLI's cwd escaping), the escaped-cwd directory name crosses verbatim, the
 * same-dir pair moves nothing and SAYS so (`ported: false`, `why: 'nothing to
 * carry'`) while still answering `findable` for the resume, and a missing
 * source answers `findable: false` so the caller starts fresh instead of
 * resuming into nothing. The layout itself is asserted (`assertTranscriptLayout`)
 * and the CLI version a port was made under rides the answer — the layout is
 * the CLI's and undocumented (zero-touch-console phase 8, ACT-12).
 *
 * The CLI's `todos/` sidecar is deliberately NOT carried any more (P8). It
 * stopped being written when the CLI stopped provisioning the task tools, so
 * the copy walked a directory that is never there — and a phase's task list now
 * lives in `PhaseRecord.tasks`, which belongs to the RUN rather than to
 * whichever account's config dir the session happened to be recorded in, and so
 * survives the port without being carried at all.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTranscriptLayout, cliVersion, findTranscript, forgetCliVersion, portTranscript,
} from '../server/accounts/transcripts.ts';
import type { Exec } from '../server/accounts/credentials.ts';

const SID = '11111111-2222-3333-4444-555555555555';
const ESCAPED = '-Users-someone-code-my-repo';

function configDir(withSession = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-transcript-'));
  if (withSession) {
    mkdirSync(join(dir, 'projects', ESCAPED), { recursive: true });
    writeFileSync(join(dir, 'projects', ESCAPED, `${SID}.jsonl`), '{"type":"user"}\n');
    mkdirSync(join(dir, 'todos'), { recursive: true });
    writeFileSync(join(dir, 'todos', `${SID}-agent.json`), '[]\n');
  }
  return dir;
}

test('finds a transcript by session id under any escaped-cwd directory', () => {
  const from = configDir(true);
  assert.equal(findTranscript(from, SID), join(from, 'projects', ESCAPED, `${SID}.jsonl`));
  assert.equal(findTranscript(from, '99999999-aaaa-bbbb-cccc-dddddddddddd'), null);
  assert.equal(findTranscript(from, '../../etc/passwd'), null, 'an id is an id, never a path');
  rmSync(from, { recursive: true, force: true });
});

test('ports the transcript, reusing the escaped dir name verbatim — and only the transcript', () => {
  const from = configDir(true);
  const to = configDir(false);
  assert.deepEqual(
    portTranscript(SID, from, to, { cliVersion: '2.1.270' }),
    { findable: true, ported: true, why: 'copied', cliVersion: '2.1.270' },
    'bytes moved, and the version the layout belongs to is on the answer',
  );
  const landed = join(to, 'projects', ESCAPED, `${SID}.jsonl`);
  assert.ok(existsSync(landed), 'the resumed CLI will look in the SAME escaped-cwd dir');
  assert.equal(readFileSync(landed, 'utf8'), '{"type":"user"}\n');
  // The conversation is what a resume needs; the sidecar is not carried (see
  // the header). `PhaseRecord.tasks` already holds the list, run-side.
  assert.equal(
    existsSync(join(to, 'todos', `${SID}-agent.json`)), false,
    'the dead todos/ sidecar is not copied',
  );
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

test('the same config dir moves nothing and says so — findable, never `ported` (ACT-12)', () => {
  // The machine login and a token account share one directory. The old
  // boolean answered `true` here and the switch journalled `ported: true`
  // having copied nothing; the resume was right to proceed, the record was
  // wrong to say a port happened.
  const dir = configDir(true);
  assert.deepEqual(portTranscript(SID, dir, dir), { findable: true, ported: false, why: 'nothing to carry' });
  rmSync(dir, { recursive: true, force: true });
});

test('a transcript already at the destination counts as findable, not as ported', () => {
  const from = configDir(false);   // nothing here — say, an A→B→A round trip
  const to = configDir(true);
  assert.deepEqual(portTranscript(SID, from, to), { findable: true, ported: false, why: 'already there' });
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

test('a missing source answers `findable: false` — the caller boots fresh instead', () => {
  const from = configDir(false);
  const to = configDir(false);
  assert.deepEqual(portTranscript(SID, from, to), { findable: false, ported: false, why: 'not found' });
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

test('the layout is asserted: a fresh dir is fine, the shape this file reads is fine, anything else is a mismatch', () => {
  const fresh = configDir(false);
  assert.deepEqual(assertTranscriptLayout(fresh).ok, true, 'no projects/ yet is not a mismatch');
  assert.equal(assertTranscriptLayout(fresh).projects, false);

  const good = configDir(true);
  const layout = assertTranscriptLayout(good);
  assert.equal(layout.ok, true);
  assert.equal(layout.dirs, 1);
  assert.equal(layout.withTranscripts, 1);

  // The CLI moved its files: project directories full of something that is
  // not a `<uuid>.jsonl`.
  const moved = configDir(false);
  mkdirSync(join(moved, 'projects', ESCAPED), { recursive: true });
  writeFileSync(join(moved, 'projects', ESCAPED, 'conversation.db'), 'x');
  const bad = assertTranscriptLayout(moved);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /changed its transcript layout/);

  // `projects` that is a FILE is the same verdict.
  const flat = configDir(false);
  writeFileSync(join(flat, 'projects'), 'x');
  assert.equal(assertTranscriptLayout(flat).ok, false);

  for (const dir of [fresh, good, moved, flat]) rmSync(dir, { recursive: true, force: true });
});

test('the CLI version is asked once, through the injectable exec, and a console that cannot ask records none', async () => {
  forgetCliVersion();
  let asked = 0;
  const exec: Exec = async (file, args) => {
    asked += 1;
    assert.equal(file, 'claude');
    assert.deepEqual(args, ['--version']);
    return { stdout: '2.1.270 (Claude Code)\n' };
  };
  assert.equal(await cliVersion(exec), '2.1.270');
  assert.equal(await cliVersion(exec), '2.1.270');
  assert.equal(asked, 1, 'memoised per process');

  forgetCliVersion();
  const broken: Exec = async () => { throw new Error('ENOENT'); };
  assert.equal(await cliVersion(broken), undefined, 'no CLI, no version — never a fabricated one');
  forgetCliVersion();
});
