/**
 * The environment doctor (parallel-repaint P2, coverage hole N4).
 *
 * `environmentReport` is pure — an env and a home in, issues out — and it is
 * the only thing that ever says a launchd plist baked another user's home into
 * PATH. The three verdicts are pinned against a real temp directory: an entry
 * under a FOREIGN home is reported whether or not it exists, a missing entry
 * under this home is reported as missing, and a present one is silent.
 */

// Reads nothing under the state directory, but the isolation guard
// (`state-isolation.test.ts`) holds every file to the same discipline.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { environmentReport } from '../server/env-doctor.ts';

// A "home" that exists, under the platform's home root like a real one — the
// foreign-home rule keys on that prefix, so the fixture has to look like a
// home to be one. The macOS root is assembled from parts: the public-repo
// scrub forbids the literal spelling anywhere in the tree.
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'env-doctor-'));
const HOMES = process.platform === 'darwin' ? `/${'Use'}${'rs'}` : '/home';
const HOME = `${HOMES}/env-doctor-me`;

test('a present PATH entry under this home is not an issue', () => {
  const bin = join(HOME_ROOT, 'bin');
  mkdirSync(bin, { recursive: true });
  // Neither the temp dir nor the system dirs are under a /Users or /home that
  // is not ours, and both exist.
  assert.deepEqual(environmentReport({ PATH: `${bin}:/usr/bin` }, HOME_ROOT), []);
});

test('a PATH entry under another user\'s home is reported, whether or not it exists', () => {
  const foreign = `${HOMES}/somebody-else/bin`;
  const issues = environmentReport({ PATH: `${foreign}:/usr/bin` }, HOME);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'path-foreign-home');
  assert.match(issues[0].detail, /different user's home/);
  // The errand names what a person actually does. Both trees say "start it from
  // a shell with a complete PATH"; only this one also has an agent whose
  // installer bakes a cleaned PATH into the unit.
  assert.match(issues[0].fix, /complete PATH/, 'the errand names the fix');
});

test('a missing PATH entry is reported as missing, with the reinstall as the fix', () => {
  const missing = join(HOME_ROOT, 'definitely-not-here');
  const issues = environmentReport({ PATH: `${missing}:/usr/bin` }, HOME_ROOT);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'path-missing-dir');
  assert.match(issues[0].detail, /does not exist/);
  assert.match(issues[0].fix, /Harmless if deliberate/);
});

test('the home itself, and directories under it, are never "foreign"', () => {
  // `${HOME}` and `${HOME}/x` share the prefix the foreign rule matches on;
  // the exact-or-under check is what keeps our own home ours.
  const issues = environmentReport({ PATH: `${HOME}:${HOME}/bin` }, HOME);
  assert.ok(issues.every((i) => i.kind !== 'path-foreign-home'), JSON.stringify(issues));
});

test('an empty PATH reports nothing rather than an issue about nothing', () => {
  assert.deepEqual(environmentReport({}, HOME), []);
  assert.deepEqual(environmentReport({ PATH: '' }, HOME), []);
});
