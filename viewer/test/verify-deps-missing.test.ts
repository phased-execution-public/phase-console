/**
 * A dependency that is not installed is a fact about the machine (control-tower
 * phase 106, #185 ask 2).
 *
 * A superproject mirror mounts every scoped repository as a fresh linked
 * worktree, so its `node_modules` and `.venv` are absent until a `Setup:` line
 * installs them. ai-builder-v7 P15's `cd hetzner && npm run verify:local` read
 * red in 1.7 s at its baseline — recorded as an ordinary pre-existing red with
 * no tail, so neither the session nor the supervisor could tell "the tree is
 * red" from "nothing is installed" without going to look; at a verdict the
 * same red re-opens a phase whose code is green.
 *
 * VE-3  a line that fails within the first seconds with a missing-dependency
 *       signature — and whose dependency directory really is absent — is
 *       `environment`, with its output tail, never retried; the session's
 *       baseline note says "install the dependencies". The same words after
 *       the first seconds, or with the dependencies present, stay a red.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { environmentOf, verifyPhase, MISSING_DEPS_FAST_MS } from '../server/runner/verify.ts';
import { frameBaselineNote } from '../server/runner/runner-attempt.ts';
import { baselineLineWords } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix = 'pc-ve3-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** A node project whose dependencies were never installed. */
function uninstalled(dir: string, scripts: Record<string, string>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mirror-pkg', private: true, scripts }, null, 2));
}

test('VE-3: a package that is not installed fails fast — `environment`, with its tail, and never retried', async () => {
  const dir = scratch();
  uninstalled(dir, { verify: 'node check.js' });
  writeFileSync(join(dir, 'check.js'), "require('left-pad-not-installed-here');\n");
  const summary = await verifyPhase('`node check.js`', { cwd: dir, timeoutMs: 60_000 });
  assert.equal(summary.ran.length, 1, 'not retried: the dependency will not appear between attempts');
  const row = summary.ran[0]!;
  assert.equal(row.ok, false);
  assert.match(row.environment ?? '', /install the dependencies/, `got: ${row.environment ?? 'a red'}`);
  assert.match(row.environment ?? '', /node_modules/, 'it names what is absent');
  assert.match(row.output, /Cannot find module/, 'the stderr tail is kept on the row');
  assert.deepEqual(summary.unproven?.map((entry) => entry.command), ['node check.js'], 'unproven, not a red');
});

test('VE-3: a package script whose binary was never installed names the dependencies — not "a command it was given"', async () => {
  const dir = scratch();
  uninstalled(dir, { verify: 'vitest-not-installed-here run' });
  const summary = await verifyPhase('`npm run verify`', { cwd: dir, timeoutMs: 60_000 });
  const row = summary.ran[0]!;
  assert.equal(summary.ran.length, 1);
  assert.match(row.environment ?? '', /install the dependencies/, `got: ${row.environment ?? 'a red'}`);
});

test('VE-3: an absent .venv is a missing dependency too', async () => {
  const dir = scratch();
  const summary = await verifyPhase('`.venv/bin/pytest -q`', { cwd: dir, timeoutMs: 60_000 });
  const row = summary.ran[0]!;
  assert.match(row.environment ?? '', /install the dependencies/, `got: ${row.environment ?? 'a red'}`);
  assert.match(row.environment ?? '', /\.venv/);
});

test('VE-3: only a FAST failure with the dependencies really absent — the same words late, or with them present, stay a red', () => {
  const dir = scratch();
  uninstalled(dir, {});
  const output = "Error: Cannot find module 'left-pad'\nRequire stack:\n- /x/check.js";
  const fast = environmentOf({ command: 'node check.js', ok: false, code: 1, ms: 1_700, output }, [], dir);
  assert.match(fast ?? '', /install the dependencies/);
  assert.ok(MISSING_DEPS_FAST_MS >= 4_000 && MISSING_DEPS_FAST_MS <= 10_000, 'about five seconds');

  const late = environmentOf({ command: 'node check.js', ok: false, code: 1, ms: MISSING_DEPS_FAST_MS + 40_000, output }, [], dir);
  assert.equal(late, null, 'a suite that ran for minutes and then named a module is a red');

  mkdirSync(join(dir, 'node_modules'));
  const installed = environmentOf({ command: 'node check.js', ok: false, code: 1, ms: 1_700, output }, [], dir);
  assert.equal(installed, null, 'with node_modules present the missing module is the work\'s');

  const relative = environmentOf({
    command: 'node check.js', ok: false, code: 1, ms: 1_700, output: "Error: Cannot find module './utils'",
  }, [], scratch());
  assert.equal(relative, null, 'a broken relative import is the work\'s, installed or not');
});

test('VE-3: the session\'s baseline note says "install the dependencies" for such a line, never "already red"', () => {
  const line = {
    command: 'cd hetzner && npm run verify:local', ok: false, code: 1, from: 'measured' as const,
    environment: 'the dependencies are not installed here — node_modules is absent; install the dependencies',
    tail: "npm error Missing script dependencies\nError: Cannot find module 'tsx'",
  };
  assert.match(baselineLineWords(line), /could not run here/);
  const note = frameBaselineNote({
    at: '2026-10-03T12:00:00.000Z', tree: 'a'.repeat(40), head: 'b'.repeat(40), concurrent: true, commands: [line],
  }, '[[baseline:abc]]');
  assert.match(note, /install the dependencies/);
  assert.doesNotMatch(note, /1 of 1 line\(s\) were already red/, 'a line that could not run is not a red the session inherits');
});
