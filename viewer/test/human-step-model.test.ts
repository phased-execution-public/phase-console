/**
 * The human-step vocabulary (control-tower phase 41) — what a person may be
 * asked to do, where a step has got to, and the redaction floor.
 *
 * `KIND_META` is the ONE place a kind's icon, label, default `where` and proof
 * hint are read (phase 42 draws them), so it must be TOTAL over the sixteen
 * kinds. The state machine must never let a step leave a settled state. And
 * the secret screen exists twice — `looksLikeSecret` here, `_looks_like_secret`
 * in `phase-outcome.sh` — over ONE list of shapes; the last test holds the two
 * to the same verdict on the same values, so a pattern that one dialect reads
 * differently cannot ship.
 *
 * Needs no environment: it runs on a bare clone.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import {
  HUMAN_STEP_KINDS, HUMAN_STEP_STATES, HUMAN_STEP_OPEN_STATES, HUMAN_STEP_SETTLED_STATES, HUMAN_STEP_TRANSITIONS,
  HUMAN_STEP_WHERE, HUMAN_STEP_AUTO_OPEN, HUMAN_STEP_BIRTHS, HUMAN_STEP_BULLET_KEYS, KIND_META, REMINDER_SERIES_MS,
  SECRET_PATTERNS, REDACTED, canTransition, humanStepKindOf, isOpenableUrl, looksLikeSecret, redactSecrets,
  secretRegExp, DEVICE_CODE_RE, CREDENTIAL_ID_RE,
} from '../shared/human-step-model.js';

/** Secret-shaped values, assembled at run time so no literal sits in the tree. */
const TOKEN = `gh${'p'}_${'k'.repeat(36)}`;
const PLANTED = [
  `sign in with ${TOKEN}`,
  `sk-${'ant'}-api03-${'x'.repeat(40)}`,
  `npm_${'n'.repeat(36)}`,
  `${'AKIA'}${'Q'.repeat(16)}`,
  `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`,
  'Authorization: Bearer ' + 'z'.repeat(32),
  'password=Tr0ub4dor-3',
  'Password: correct-horse',
  'security unlock-keychain --password hunter22',
  'type 493817 at the prompt',
  'https://example.com/callback?code=Zq81xk2mP0&state=abc',
  'https://example.com/cb#access_token=Zq81xk2mP0',
  'https://bucket.example.com/f?X-Amz-Signature=Zq81xk2mP0',
];

const ORDINARY = [
  'Sign the gh CLI in to the acme org',
  'gh auth login --web',
  'https://github.com/login/device',
  'https://github.com/acme/app/pull/123456?tab=files',
  'cmd:"gh auth status"',
  'gh:acme/app#pr/123456',
  'gh:acme/app#run/12345678901',
  'date:2026-09-30T10:00:00Z',
  'phase 41 needs the org owner to approve the app',
  'Enter the code ABCD-1234 on the device page',
  'the password prompt at the machine',
  'v6.0.0',
];

test('sixteen kinds and eight states, frozen, each word once', () => {
  assert.equal(HUMAN_STEP_KINDS.length, 16);
  assert.equal(new Set(HUMAN_STEP_KINDS).size, 16);
  assert.deepEqual([...HUMAN_STEP_STATES], ['declared', 'notified', 'opened', 'checking', 'proven', 'expired', 'cannot', 'dismissed']);
  for (const list of [HUMAN_STEP_KINDS, HUMAN_STEP_STATES, HUMAN_STEP_WHERE, HUMAN_STEP_AUTO_OPEN, HUMAN_STEP_BIRTHS, HUMAN_STEP_BULLET_KEYS]) {
    assert.ok(Object.isFrozen(list), 'a vocabulary is frozen');
  }
  assert.deepEqual([...HUMAN_STEP_WHERE], ['host', 'any']);
  assert.deepEqual([...HUMAN_STEP_AUTO_OPEN], ['host']);
  assert.deepEqual([...HUMAN_STEP_BIRTHS], ['plan', 'session', 'console']);
});

test('the open and settled states partition the eight', () => {
  assert.deepEqual([...HUMAN_STEP_OPEN_STATES, ...HUMAN_STEP_SETTLED_STATES], [...HUMAN_STEP_STATES]);
  assert.deepEqual([...HUMAN_STEP_OPEN_STATES], ['declared', 'notified', 'opened', 'checking']);
});

test('KIND_META is total over the sixteen kinds — icon, label, default where, proof hint', () => {
  assert.deepEqual(Object.keys(KIND_META).sort(), [...HUMAN_STEP_KINDS].sort());
  const labels = new Set<string>();
  for (const kind of HUMAN_STEP_KINDS) {
    const meta = KIND_META[kind];
    assert.ok(Object.isFrozen(meta), `${kind}: its meta is frozen`);
    assert.match(meta.icon, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${kind}: the icon is a lucide name`);
    assert.match(meta.label, /^[A-Z][^.]*[a-z]$/, `${kind}: the label is a sentence-case phrase with no full stop`);
    assert.ok(!labels.has(meta.label), `${kind}: two kinds share the label "${meta.label}"`);
    labels.add(meta.label);
    assert.ok((HUMAN_STEP_WHERE as readonly string[]).includes(meta.where), `${kind}: where "${meta.where}"`);
    assert.ok(meta.proof.length > 8, `${kind}: a proof hint a person can act on`);
  }
  // The catalogue's own column: the machine-bound kinds are `host`.
  for (const kind of ['browser-login', 'one-time-code', 'claude-login', 'mcp-login', 'os-prompt', 'os-permission', 'protected-path', 'interactive-prompt'] as const) {
    assert.equal(KIND_META[kind].where, 'host', kind);
  }
  for (const kind of ['device-code', 'secret-entry', 'third-party-approval', 'person-check', 'decision', 'captcha', 'email-link'] as const) {
    assert.equal(KIND_META[kind].where, 'any', kind);
  }
});

test('the state machine: open states reach every settled one, and nothing leaves a settled state', () => {
  assert.deepEqual(Object.keys(HUMAN_STEP_TRANSITIONS), [...HUMAN_STEP_STATES]);
  for (const from of HUMAN_STEP_OPEN_STATES) {
    for (const to of HUMAN_STEP_SETTLED_STATES) assert.ok(canTransition(from, to), `${from} → ${to}`);
    assert.ok(!canTransition(from, 'declared'), `${from} → declared: a step is declared once`);
  }
  for (const from of HUMAN_STEP_SETTLED_STATES) {
    for (const to of HUMAN_STEP_STATES) assert.ok(!canTransition(from, to), `${from} → ${to} must be refused`);
  }
  // Open again as often as the person needs; remind again; check again.
  assert.ok(canTransition('opened', 'opened'));
  assert.ok(canTransition('notified', 'notified'));
  assert.ok(canTransition('checking', 'checking'));
  for (const targets of Object.values(HUMAN_STEP_TRANSITIONS)) {
    for (const to of targets) assert.ok((HUMAN_STEP_STATES as readonly string[]).includes(to), `${to} is a state`);
  }
  assert.equal(canTransition('bogus', 'proven'), false);
  assert.equal(canTransition('declared', 'bogus'), false);
});

test('humanStepKindOf coerces case, backticks and space — and never invents a kind', () => {
  assert.equal(humanStepKindOf('Browser-Login'), 'browser-login');
  assert.equal(humanStepKindOf(' `device-code` '), 'device-code');
  for (const nonsense of ['credential', '', 'browser login', null, undefined, 42]) {
    assert.equal(humanStepKindOf(nonsense), null, `${String(nonsense)} is not a kind`);
  }
});

test('the reminder series is +15 m, +1 h, +6 h, then daily', () => {
  assert.deepEqual([...REMINDER_SERIES_MS], [15 * 60_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000]);
});

test('every secret pattern compiles in JavaScript, and none holds a literal space (the bash twin splits on spaces)', () => {
  for (const ere of SECRET_PATTERNS) {
    assert.doesNotThrow(() => secretRegExp(ere), ere);
    assert.ok(!ere.includes(' '), `${ere} holds a space`);
  }
});

test('looksLikeSecret: every planted shape is caught, and ordinary words, links and refs are not', () => {
  for (const value of PLANTED) assert.ok(looksLikeSecret(value), `missed: ${value.slice(0, 40)}`);
  for (const value of ORDINARY) assert.ok(!looksLikeSecret(value), `false alarm: ${value}`);
  assert.equal(looksLikeSecret(''), false);
  assert.equal(looksLikeSecret(undefined), false);
});

test('redactSecrets removes each planted value and keeps the words around it', () => {
  for (const value of PLANTED) {
    const out = redactSecrets(`before ${value} after`);
    assert.ok(out.includes(REDACTED), `nothing redacted in: ${value.slice(0, 40)}`);
    assert.ok(!looksLikeSecret(out) || /\[redacted\]/.test(out), out);
    for (const secret of ['k'.repeat(36), 'Tr0ub4dor-3', 'correct-horse', 'hunter22', '493817', 'Zq81xk2mP0', 'z'.repeat(32)]) {
      assert.ok(!out.includes(secret), `${secret} survived in: ${out}`);
    }
    assert.ok(out.startsWith('before '), out);
  }
  // A URL keeps its parameter NAME, so the link still says what it was.
  assert.equal(
    redactSecrets('https://example.com/callback?code=Zq81xk2mP0&state=abc'),
    `https://example.com/callback?code=${REDACTED}&state=abc`,
  );
  assert.equal(redactSecrets('type 493817 at the prompt'), `type ${REDACTED} at the prompt`);
  for (const value of ORDINARY) assert.equal(redactSecrets(value), value, `changed: ${value}`);
});

test('only http and https links open', () => {
  assert.ok(isOpenableUrl('https://github.com/login/device'));
  assert.ok(isOpenableUrl('http://localhost:8080/callback'));
  for (const bad of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', 'vscode://open', 'https://', '', 'github.com']) {
    assert.ok(!isOpenableUrl(bad), bad);
  }
});

test('the device code and credential id shapes', () => {
  for (const code of ['ABCD-1234', 'FJ4ZK7QXC', 'WDJB-MJHT']) assert.match(code, DEVICE_CODE_RE);
  for (const code of ['abcd-1234', 'ABC', 'ABCDEFGHIJKLMNOP', 'AB CD']) assert.doesNotMatch(code, DEVICE_CODE_RE);
  for (const id of ['npm-token', 'license.signing_key', 'a']) assert.match(id, CREDENTIAL_ID_RE);
  for (const id of ['NPM', '-x', 'a/b', '', 'x'.repeat(65)]) assert.doesNotMatch(id, CREDENTIAL_ID_RE);
});

test('phase-outcome.sh refuses exactly what looksLikeSecret calls a secret — one list, two dialects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-hs-screen-'));
  try {
    const script = join(SKILL_DIR, 'scripts', 'phase-outcome.sh');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, 'state'), DOCS_ROOT: dir,
      PE_OUTCOME_FILE: join(dir, 'outcome.json'), PE_NOW: '2026-09-30T10:00:00Z', PHASE_OUTCOME_PROBE: '0',
    };
    const disagreements: string[] = [];
    for (const value of [...PLANTED, ...ORDINARY]) {
      const run = spawnSync('bash', [script, 'demo', '8', 'needs-human', '--needs', 'credential',
        '--step', 'browser-login', '--title', 'sign in', '--step-line', value], { env, encoding: 'utf8' });
      rmSync(join(dir, 'outcome.json'), { force: true });
      const refused = run.status === 2 && /shaped like a secret/.test(run.stderr);
      if (refused !== looksLikeSecret(value)) {
        disagreements.push(`${value.slice(0, 50)}: bash ${refused ? 'refused' : 'accepted'}, JS ${looksLikeSecret(value) ? 'secret' : 'ordinary'}`);
      }
    }
    assert.deepEqual(disagreements, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
