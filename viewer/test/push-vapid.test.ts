/**
 * The VAPID key file, and the one rule that matters about it.
 *
 * A push subscription is bound to the public half of this keypair. Mint a new
 * one and every device the operator ever subscribed is talking to a key this
 * console no longer holds: `deliver` gets BadJwtToken, and after fifteen
 * rejections the register drops the device for good. Silently.
 *
 * So `read()` distinguishes "there is no file" from "I could not read the
 * file", and only the first may mint. A truncated, unreadable or unparseable
 * key file turns push OFF — loudly, on the environment card — and is left
 * exactly where it is for a person to look at. That is the whole of this file.
 */

// STATE_DIR is resolved when config.ts is first imported, so the redirect has
// to happen before anything pulls it in. A private mkdtemp rather than the
// shared `state-sandbox.ts`, because these tests deliberately write a BROKEN
// key file and must not hand one to another suite in the same process.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'phase-vapid-'));
process.env.XDG_CONFIG_HOME = join(process.env.XDG_STATE_HOME, 'config');

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let vapid: typeof import('../server/push/vapid.ts');

before(async () => { vapid = await import('../server/push/vapid.ts'); });

beforeEach(() => {
  rmSync(vapid.PUSH_DIR, { recursive: true, force: true });
  mkdirSync(vapid.PUSH_DIR, { recursive: true, mode: 0o700 });
});

const SUBJECT = 'mailto:you@example.com';

test('no key file yet mints one, atomically, at 0600', () => {
  const loaded = vapid.loadVapid(SUBJECT);
  assert.ok(!('error' in loaded), 'an empty push dir is a first run');
  assert.equal(statSync(vapid.VAPID_FILE).mode & 0o777, 0o600, 'a private key wears private bits');
  // temp + rename, and the temp file is gone: a reader sees the old file or
  // the new one, never the half-written one this module now refuses to mint over.
  assert.deepEqual(readdirSync(vapid.PUSH_DIR).filter((f) => f.endsWith('.tmp')), []);
});

test('a truncated key file disables push and is left byte-for-byte where it is', () => {
  // THE regression. A power cut mid-write used to read as "first run".
  for (const broken of ['{"publicKey":"AB', '', 'null', '{"publicKey":"x"}']) {
    rmSync(vapid.PUSH_DIR, { recursive: true, force: true });
    mkdirSync(vapid.PUSH_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(vapid.VAPID_FILE, broken, 'utf8');
    const before = readFileSync(vapid.VAPID_FILE);
    const listing = readdirSync(vapid.PUSH_DIR).sort();

    const loaded = vapid.loadVapid(SUBJECT);

    assert.ok('error' in loaded, `a broken key file must not mint: ${JSON.stringify(broken)}`);
    if ('error' in loaded) {
      assert.match(loaded.error, /damaged/);
      assert.ok(loaded.fix.length > 0, 'and it must say what to do about it');
      assert.match(loaded.fix, /vapid\.json/, 'naming the file');
    }
    // Nothing rotated, nothing moved aside, nothing left over.
    assert.deepEqual(readFileSync(vapid.VAPID_FILE), before, 'the key file is untouched');
    assert.deepEqual(readdirSync(vapid.PUSH_DIR).sort(), listing, 'no new key, no .bak, no .tmp');
  }
});

test('a key file that cannot be read at all is not a first run', () => {
  // A directory where the file belongs makes readFileSync throw EISDIR — the
  // root-proof way to get a non-ENOENT error (chmod 0000 does nothing as root).
  mkdirSync(vapid.VAPID_FILE, { recursive: true });
  const loaded = vapid.loadVapid(SUBJECT);
  assert.ok('error' in loaded, 'EISDIR is not ENOENT');
  assert.ok(statSync(vapid.VAPID_FILE).isDirectory(), 'and it is left alone');
});

test('a damaged file and an unreadable file give DIFFERENT errands', () => {
  // The clause that stops a false alarm from becoming a rotation instruction.
  // We READ a damaged file and know its content is wrong, so naming the repair
  // is fair. An unreadable one we did not read at all — EMFILE under fd
  // pressure, EIO — and the file is probably intact. Telling an operator to
  // move THAT aside is the incident this module exists to prevent, performed
  // by hand and on our advice.
  writeFileSync(vapid.VAPID_FILE, '{"publicKey":"AB', 'utf8');
  const damaged = vapid.loadVapid(SUBJECT);
  assert.ok('error' in damaged);
  if ('error' in damaged) assert.match(damaged.fix, /move it aside/);

  rmSync(vapid.VAPID_FILE, { force: true });
  mkdirSync(vapid.VAPID_FILE, { recursive: true });   // EISDIR, root-proof
  const unreadable = vapid.loadVapid(SUBJECT);
  assert.ok('error' in unreadable);
  if ('error' in unreadable) {
    assert.doesNotMatch(unreadable.fix, /move it aside/, 'never tell them to rotate an intact key');
    assert.match(unreadable.fix, /untouched/);
    assert.match(unreadable.fix, /do NOT delete or move it/);
  }
});

test('a key file that is already there is never renamed and never overwritten', () => {
  // The write path has no move-aside branch at all: it publishes with linkSync,
  // which fails EEXIST rather than clobbering. A key that appears between the
  // read and the write therefore survives byte for byte — and a rotation "with
  // a receipt" (rename to .bak, mint beside it) is still a rotation.
  const first = vapid.loadVapid(SUBJECT);
  assert.ok(!('error' in first));
  const bytes = readFileSync(vapid.VAPID_FILE);

  const second = vapid.loadVapid(SUBJECT);
  assert.ok(!('error' in second));
  assert.deepEqual(readFileSync(vapid.VAPID_FILE), bytes, 'the key file is byte-identical');
  const stray = readdirSync(vapid.PUSH_DIR).filter((f) => /\.bak$|\.tmp$/.test(f));
  assert.deepEqual(stray, [], 'no .bak (a rotation) and no .tmp (a leak)');
});

test('a good key file is read back, and reading it twice is the same key', () => {
  const first = vapid.loadVapid(SUBJECT);
  assert.ok(!('error' in first));
  const second = vapid.loadVapid(SUBJECT);
  assert.ok(!('error' in second));
  if (!('error' in first) && !('error' in second)) {
    // The point of the whole module: the key survives a restart.
    assert.equal(first.publicKey, second.publicKey);
  }
});
