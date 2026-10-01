/**
 * Verification must not fail because launchd's environment is thin.
 *
 * The plist bakes the PATH of whatever shell ran the installer. A real run
 * halted on `"python": executable file not found in $PATH` — a red that blamed
 * the phase when only the environment had failed. The fix appends the standard
 * directories (only the ones that exist, only when missing) to the END of the
 * verification PATH: the configured toolchain keeps winning, otherwise-invisible
 * binaries are rescued, and the amendment is logged so the plist defect stays
 * visible. The durable fix remains starting the console from a shell with a
 * complete PATH — this is the difference between that being a chore and a
 * 3 a.m. halt.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hardenedPath, verifyPhase } from '../server/runner/verify.ts';

test('hardenedPath appends only missing-and-existing standard dirs, never prepends', () => {
  const thin = hardenedPath('/nonexistent-toolchain/bin');
  assert.ok(
    thin.path.startsWith('/nonexistent-toolchain/bin:'),
    'the configured PATH still decides which toolchain wins',
  );
  assert.ok(thin.added.includes('/bin'), '/bin exists on every machine this runs on');

  const complete = hardenedPath(thin.path);
  assert.equal(complete.path, thin.path, 'a PATH that already sees everything is left byte-identical');
  assert.deepEqual(complete.added, []);
});

test('hardenedPath treats an empty PATH as "append what exists"', () => {
  const bare = hardenedPath(undefined);
  assert.ok(bare.path.split(':').includes('/bin'));
  assert.ok(!bare.path.startsWith(':'), 'no empty leading segment');
});

test('a verification survives a PATH that forgot the standard dirs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pc-verify-env-'));
  const summary = await verifyPhase('- **Verification:** `ls`', {
    cwd,
    env: { PATH: '/nonexistent' } as NodeJS.ProcessEnv,
  });
  assert.equal(summary.ok, true, summary.reason);
  assert.equal(summary.ran.length, 1);
  assert.equal(summary.ran[0].ok, true, summary.ran[0].output);
});

/* ------------------------------------------------------------------ *
 * scripts/verify.env — one vocabulary, three readers, zero drift
 * ------------------------------------------------------------------ */

test('the TS loader, the TS fallbacks and scripts/verify.env agree exactly', async () => {
  const { loadVerifyEnv, VERIFY_ENV_FALLBACK } = await import('../server/runner/verify-env.ts');
  const { DEFAULT_PREFLIGHT_SKIP } = await import('../server/runner/verify.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const scripts = join(SKILL_DIR, 'scripts');

  const loaded = loadVerifyEnv(scripts);
  // The loader read the real file; the fallbacks must say the same thing —
  // they are what an older scripts dir gets, and drift there is invisible.
  assert.deepEqual([...loaded.cwdSensitive].sort(), [...VERIFY_ENV_FALLBACK.cwdSensitive].sort());
  assert.deepEqual([...loaded.preflightSkip].sort(), [...VERIFY_ENV_FALLBACK.preflightSkip].sort());
  // verify.ts's own default (used when no caller passes a set) is the same list.
  assert.deepEqual([...DEFAULT_PREFLIGHT_SKIP].sort(), [...loaded.preflightSkip].sort());
  // The external-clock vocabulary, byte-for-byte. A SET comparison would not
  // do here — this one is a single regex source and a character out of place
  // changes what it matches without changing anything a set could see.
  assert.equal(loaded.externalWaitSource, VERIFY_ENV_FALLBACK.externalWaitSource);
});

test('the external-clock vocabulary is the SAME string bash reads', async () => {
  // The point of the whole exercise: lint F16 warns at plan time and the
  // runner's stall detector parks at run time, and if the two lists drift the
  // warning describes a runtime nobody watches. Proven by asking bash — not by
  // reading the file a second time in JS, which would only prove that the file
  // equals itself.
  const { loadVerifyEnv } = await import('../server/runner/verify-env.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { execFileSync } = await import('node:child_process');
  const scripts = join(SKILL_DIR, 'scripts');

  const fromBash = execFileSync('bash', [
    '-c', `. "${scripts}/verify.env"; printf '%s' "$EXTERNAL_WAIT"`,
  ], { encoding: 'utf8' });
  assert.equal(fromBash, loadVerifyEnv(scripts).externalWaitSource);
  assert.ok(fromBash.length > 0, 'a value bash reads as empty would silence F16 entirely');
});

test('every construct in the shared vocabulary is legal in BOTH dialects', async () => {
  // One string drives a POSIX ERE (`grep -oE`) and a JS `RegExp`. The two
  // agree on nearly everything, and `[[:space:]]` is the classic way to
  // discover they do not: bash matches, JS throws or — worse — matches a
  // literal bracket set. Compiling here is the cheap half of the check.
  const { loadVerifyEnv } = await import('../server/runner/verify-env.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const scripts = join(SKILL_DIR, 'scripts');
  const source = loadVerifyEnv(scripts).externalWaitSource;

  assert.doesNotThrow(() => new RegExp(source), 'the vocabulary must compile as a JS regex');
  assert.ok(!source.includes('[:'), 'POSIX character classes have no JS equivalent — use a literal');

  // And the expensive half: the same inputs, the same verdicts, on both sides.
  const { execFileSync } = await import('node:child_process');
  const js = new RegExp(source);
  const cases: [string, boolean][] = [
    ['gh run watch 123', true],
    ['until [ "$(gh run view -q .status)" = completed ]; do sleep 45; done', true],
    ['gh pr checks 7 --watch', true],
    ['sleep 600', true],
    ['tail -f /var/log/app.log', true],
    ['kubectl rollout status deploy/api', true],
    ['npm test', false],
    ['sleep 30', false],
    ['git push origin main', false],
    // A loop is a wait only when it holds a clock (control-tower phase 47,
    // #52): a counter that waits on nothing is not one, the same loop with a
    // sleep, a timed read, a `wait` or a network verb is.
    ['while [ $i -lt 20 ]; do printf "%s\\n" "$line"; i=$((i+1)); done', false],
    ['until [ $n -ge 3 ]; do n=$((n+1)); done', false],
    ['until test -f /tmp/x; do :; done', false],
    ['while [ $i -lt 20 ]; do sleep 1; done', true],
    ['while true; do sleep 5; done', true],
    ['while ! grep -q DONE build.log; do sleep 5; done', true],
    ['until [ $n -ge 30 ]; do curl -fsS http://api.example.invalid/state; n=$((n+1)); done', true],
    ['until gh run view 1 -q .status | grep -q completed; do :; done', true],
    ['while [ $i -lt 9 ]; do read -t 5 line; i=$((i+1)); done', true],
  ];
  for (const [input, want] of cases) {
    assert.equal(js.test(input), want, `JS disagrees about: ${input}`);
    const code = execFileSync('bash', [
      '-c',
      `. "${scripts}/verify.env"; printf '%s' ${JSON.stringify(input)} | grep -qE "$EXTERNAL_WAIT" && echo 1 || echo 0`,
    ], { encoding: 'utf8' }).trim();
    assert.equal(code === '1', want, `bash disagrees about: ${input}`);
  }
});

/**
 * The AUD-34 corpus: the fifteen commands the in-turn-wait guard refused in the
 * autopilot week, twelve of them the session's own local work
 * (`fixtures/wait-corpus/aud-34.json`). This half asks the SHARED question —
 * does the command wait at all — of both readers: bash through
 * `external_wait_hit` (the function lint F16 calls, sourced from
 * scripts/verify.env) and JS through `externalWaitMatch`. Whose clock a wait
 * is on is the guard's second question, answered in `liveness.test.ts`.
 */
test('the AUD-34 corpus: bash and JS agree, command by command, on which ones wait', async () => {
  const { externalWaitMatch, loadVerifyEnv } = await import('../server/runner/verify-env.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const scripts = join(SKILL_DIR, 'scripts');
  const env = loadVerifyEnv(scripts);
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/wait-corpus/aud-34.json', import.meta.url), 'utf8')) as {
    items: { id: string; wait: boolean; command: string }[];
  };
  assert.equal(corpus.items.length, 15);
  for (const item of corpus.items) {
    const js = externalWaitMatch(env, item.command);
    assert.equal(js !== null, item.wait, `JS: #${item.id} read ${js === null ? 'no wait' : `\`${js}\``}`);
    const bash = execFileSync('bash', ['-c', `. "${scripts}/verify.env"; external_wait_hit`], {
      input: item.command, encoding: 'utf8',
    }).trim();
    assert.equal(bash !== '', item.wait, `bash: #${item.id} read ${bash === '' ? 'no wait' : `\`${bash}\``}`);
  }
});

test('a backslash-continued line is one statement to both readers, and a quoted ; stays inside a declaration', async () => {
  const { externalWaitMatch, foldWhitespace, loadVerifyEnv } = await import('../server/runner/verify-env.ts');
  const { SKILL_DIR } = await import('../server/config.ts');
  const env = loadVerifyEnv(join(SKILL_DIR, 'scripts'));
  // A continuation joins; a newline separates.
  assert.equal(foldWhitespace('a \\\n  --b c\nd'), 'a --b c; d');
  // The `--watch` of a continued declaration used to become a statement of its
  // own, and the carve-out stopped at the `;` the fold had put there (AUD-34).
  assert.equal(externalWaitMatch(env, 'bash scripts/phase-outcome.sh p 8 waiting-external \\\n  --watch "cmd:test -f x"'), null);
  assert.equal(externalWaitMatch(env, 'bash scripts/phase-outcome.sh p 7 ruling --what "a; until x; do sleep 9; done"'), null);
  // …while a real wait after the declaration is still a wait.
  assert.ok(externalWaitMatch(env, 'bash scripts/phase-outcome.sh p 7 ruling --what "x"; gh run watch 9'));
});

test('a malformed vocabulary degrades to the fallback instead of throwing on a tick', async () => {
  // This regex is compiled once per scripts dir and then asked on every
  // liveness tick of every lane. An edit that makes it invalid must cost a
  // fallback, not an exception caught and logged once a minute forever.
  const { loadVerifyEnv, VERIFY_ENV_FALLBACK } = await import('../server/runner/verify-env.ts');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'pc-verify-env-bad-'));
  writeFileSync(join(dir, 'verify.env'), "EXTERNAL_WAIT='gh run watch|([unclosed'\n");
  const loaded = loadVerifyEnv(dir);
  assert.equal(loaded.externalWait.source, VERIFY_ENV_FALLBACK.externalWait.source);
});

test('a scripts dir without the file falls back rather than failing', async () => {
  const { loadVerifyEnv, VERIFY_ENV_FALLBACK } = await import('../server/runner/verify-env.ts');
  const empty = mkdtempSync(join(tmpdir(), 'pc-verify-env-'));
  const loaded = loadVerifyEnv(empty);
  assert.equal(loaded.cwdSensitive, VERIFY_ENV_FALLBACK.cwdSensitive);
});

/* ------------------------------------------------------------------ *
 * The environment doctor
 * ------------------------------------------------------------------ */

test('the doctor names foreign homes and dead directories, and blesses a clean PATH', async () => {
  const { environmentReport } = await import('../server/env-doctor.ts');
  const home = '/home/me';
  const report = environmentReport(
    { PATH: `/home/somebody-else/.tools/bin:/usr/bin:/definitely/absent-xyz:${home}/bin` },
    home,
  );
  const kinds = report.map((issue) => issue.kind).sort();
  // /usr/bin exists and is not under any home; ${home}/bin does not exist but
  // IS the user's own — reported as missing, never as foreign.
  assert.deepEqual(kinds, ['path-foreign-home', 'path-missing-dir', 'path-missing-dir']);
  const foreign = report.find((issue) => issue.kind === 'path-foreign-home')!;
  assert.match(foreign.detail, /somebody-else/);
  assert.match(foreign.fix, /complete PATH/);

  assert.deepEqual(environmentReport({ PATH: '/usr/bin:/bin' }, home), []);
});
