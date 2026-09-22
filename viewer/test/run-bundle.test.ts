/**
 * The run export bundle — one run, redacted, as a tar.gz.
 *
 * Two properties are worth a test and the rest is bookkeeping around them.
 *
 * **The archive must be a real ustar archive**, because the promise made to an
 * operator is `tar -xzf` and to a model is "attach this". A hand-written tar is
 * a header of fixed-width octal fields and one checksum, and every one of those
 * fields is a place to be silently wrong: a bad checksum, a name written past
 * its 100 bytes, or a member not padded to 512 all produce a file that *looks*
 * written and that GNU tar refuses. So the assertions here run the real `tar`
 * over the real output, not a reader of our own that would agree with our own
 * mistakes.
 *
 * **A secret must not survive the redaction**, because this bundle exists to be
 * SHARED — pasted into an issue, handed to a model. A redaction that works on
 * the paths we thought of and not on the one we forgot is worse than none,
 * since the manifest tells the reader it was redacted. The three planted
 * secrets here are the three shapes that actually reach a console's disk: a
 * vendor key in a journal line, an `Authorization` header in a log line, and
 * the operator's home path in every path the bundle names.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TAR_BLOCK, tarGz, ustar } from '../server/debug/tar.ts';

const work = mkdtempSync(join(tmpdir(), 'phase-console-bundle-'));
// The repository, from this file rather than the cwd: `scripts/gates.sh` runs the
// suite from `viewer/`, a hand run from the root, and the CLI tests below spawn
// the real bin and the real `instances.mjs` — both of which are paths.
const REPO = fileURLToPath(new URL('../..', import.meta.url));

test.after(() => {
  rmSync(work, { recursive: true, force: true });
});

/** `tar -tzf`, run for real — the only reader whose agreement means anything. */
function listWithTar(bytes: Buffer, name: string): string[] {
  const file = join(work, name);
  writeFileSync(file, bytes);
  const out = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => line.replace(/\/$/, ''));
}

/** `tar -xzf` into a fresh directory, so content is read back the way a person reads it. */
function extractWithTar(bytes: Buffer, name: string): string {
  const file = join(work, `${name}.tgz`);
  const out = join(work, name);
  writeFileSync(file, bytes);
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', out]);
  return out;
}

// ---------------------------------------------------------------- the tar writer

test('TAR-1 — a member is a 512-byte header plus content padded to 512', () => {
  const bytes = ustar([{ name: 'a.txt', body: Buffer.from('hello') }]);
  // header + one padded content block + two zero blocks of end-of-archive
  assert.equal(bytes.length, TAR_BLOCK * 4);
  assert.equal(bytes.subarray(0, 5).toString('utf8'), 'a.txt');
  assert.equal(bytes.subarray(TAR_BLOCK, TAR_BLOCK + 5).toString('utf8'), 'hello');
  // the padding, and then the two terminating blocks, are all NUL
  assert.ok(bytes.subarray(TAR_BLOCK + 5).every((byte) => byte === 0));
});

test('TAR-2 — the header carries the ustar magic, the size and a correct checksum', () => {
  const bytes = ustar([{ name: 'b.txt', body: Buffer.from('0123456789') }]);
  const header = bytes.subarray(0, TAR_BLOCK);
  assert.equal(header.subarray(257, 263).toString('utf8'), 'ustar\0');
  assert.equal(header.subarray(263, 265).toString('utf8'), '00');
  // size is octal, NUL-terminated, in bytes 124..136
  assert.equal(header.subarray(124, 135).toString('utf8'), '00000000012');

  // The checksum is the sum of every header byte with the checksum field itself
  // read as eight spaces. Recomputed here rather than copied, because a constant
  // copied from the implementation would agree with the implementation's bug.
  const stated = parseInt(header.subarray(148, 154).toString('utf8'), 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  assert.equal(stated, sum);
});

test('TAR-3 — GNU tar reads back every member, including a nested path', () => {
  const bytes = tarGz([
    { name: 'MANIFEST.json', body: Buffer.from('{}') },
    { name: 'journal/run-abc.jsonl', body: Buffer.from('{"seq":1}\n') },
    { name: 'console/console.log.slice.ndjson', body: Buffer.from('') },
  ]);
  assert.deepEqual(listWithTar(bytes, 'three.tgz').sort(), [
    'MANIFEST.json',
    'console/console.log.slice.ndjson',
    'journal/run-abc.jsonl',
  ]);
  const root = extractWithTar(bytes, 'three');
  assert.equal(readFileSync(join(root, 'journal', 'run-abc.jsonl'), 'utf8'), '{"seq":1}\n');
  assert.ok(existsSync(join(root, 'console', 'console.log.slice.ndjson')));
});

test('TAR-4 — a name longer than 100 bytes is refused, not silently truncated', () => {
  const long = `${'d'.repeat(60)}/${'n'.repeat(60)}.json`;
  assert.throws(() => ustar([{ name: long, body: Buffer.from('x') }]), /100 bytes/);
});

test('TAR-5 — tarGz output is a gzip stream whose inflation is the tar', () => {
  const members = [{ name: 'only.txt', body: Buffer.from('one') }];
  const packed = tarGz(members);
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.deepEqual(gunzipSync(packed), ustar(members));
});

// ---------------------------------------------------------------- redaction

test('RED-1 — a high-entropy run is masked even when no pattern names it', async () => {
  const { redact } = await import('../server/webhooks.ts');
  // Not an `sk-`, not a `gh?_`, no `token=` in front of it: a credential shaped
  // like nothing we thought of. This is the whole point of the entropy rule.
  const secret = 'Zq7Z1vK9pLx4Wm2Nb8Ct6Yr3Hs5Jd0Fg1Aa';
  assert.ok(redact(`the key is ${secret}`).includes('[high-entropy]'));
  assert.ok(!redact(`the key is ${secret}`).includes(secret));
});

test('RED-2 — a hex digest is NOT masked: 16 symbols cannot reach the threshold', async () => {
  const { redact } = await import('../server/webhooks.ts');
  // A sha256, a git sha and a trace id are all hex, all long, and all things a
  // log line exists to carry. Masking them would make the bundle useless for
  // the one thing it is for — and there is no arithmetic by which a 16-symbol
  // alphabet exceeds 4.0 bits, so the 4.5 threshold excludes them by design.
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(redact(`commit ${sha}`), `commit ${sha}`);
});

test('RED-3 — ordinary English prose is untouched, however long', async () => {
  const { redact } = await import('../server/webhooks.ts');
  const prose = 'the phase parked because the lock was held by another session for eleven minutes';
  assert.equal(redact(prose), prose);
});

test('RED-4 — a short mixed token is left alone: 32 characters is the floor', async () => {
  const { redact } = await import('../server/webhooks.ts');
  const short = 'Zq7Z1vK9pLx4Wm2Nb8Ct';
  assert.equal(redact(`id ${short}`), `id ${short}`);
});

// ---------------------------------------------------------------- the bundle

/**
 * A run's directory as the console really writes it, with three secrets
 * planted in the three places secrets actually reach disk.
 */
function plantRun(): { deps: Record<string, unknown>; home: string } {
  const root = mkdtempSync(join(work, 'run-'));
  const runDir = join(root, 'runs', 'demo');
  const instanceDir = join(root, 'state');
  const locksDir = join(root, 'locks');
  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(join(runDir, 'outcomes'), { recursive: true });
  mkdirSync(join(instanceDir, 'sessions'), { recursive: true });
  mkdirSync(locksDir, { recursive: true });

  const home = homedir();
  writeFileSync(
    join(runDir, 'run-aaaaaaaa.json'),
    JSON.stringify({ id: 'aaaaaaaa', slug: 'demo', status: 'finished', phases: { 3: { status: 'done' } } }),
  );
  // 1. a vendor key in a journal line
  writeFileSync(
    join(runDir, 'run-aaaaaaaa.jsonl'),
    [
      JSON.stringify({ seq: 1, time: '2026-09-18T10:00:00.000Z', event: 'run.started', data: {} }),
      JSON.stringify({ seq: 2, time: '2026-09-18T11:00:00.000Z', event: 'phase.session', data: { key: 'sk-live-AAAAAAAAAAAAAAAAAAAA' } }),
    ].join('\n') + '\n',
  );
  // 2. an Authorization header in a console log line, 3. the operator's home path
  writeFileSync(
    join(instanceDir, 'console.log'),
    [
      JSON.stringify({ v: 2, time: '2026-09-18T10:30:00.000Z', level: 'info', event: 'http.request', traceId: 'a'.repeat(32), data: { headers: 'Authorization: Bearer abcdefghijklmnop' } }),
      JSON.stringify({ v: 2, time: '2026-09-18T10:31:00.000Z', level: 'error', event: 'git.command', data: { cwd: `${home}/work/secret-project` } }),
      JSON.stringify({ v: 2, time: '2026-09-18T09:00:00.000Z', level: 'info', event: 'run.other', traceId: 'b'.repeat(32), data: {} }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(runDir, 'run-aaaaaaaa.log.jsonl'), `${JSON.stringify({ at: '2026-09-18T10:05:00.000Z', kind: 'text', text: 'working' })}\n`);
  writeFileSync(join(runDir, 'run-aaaaaaaa-p3-tasks.ndjson'), `${JSON.stringify({ id: 'p3.task1', subject: 'do it' })}\n`);
  writeFileSync(join(runDir, 'run-aaaaaaaa-p3-outcome.json'), JSON.stringify({ status: 'complete' }));
  writeFileSync(join(runDir, 'rulings.ndjson'), `${JSON.stringify({ kind: 'ambiguity', what: 'chose A' })}\n`);
  writeFileSync(join(runDir, 'messages.ndjson'), `${JSON.stringify({ id: 'm1', kind: 'note' })}\n`);
  writeFileSync(join(runDir, 'run-aaaaaaaa.git.ndjson'), `${JSON.stringify({ sid: 'pc-x', argv: ['git', 'status'] })}\n`);
  writeFileSync(join(runDir, 'tasks', 'phase-03.ndjson'), `${JSON.stringify({ id: 'p3.task1' })}\n`);
  writeFileSync(join(runDir, 'outcomes', 'phase-03.json'), JSON.stringify({ status: 'complete' }));
  writeFileSync(join(instanceDir, 'sessions', 'sess-1.events.ndjson'), `${JSON.stringify({ v: 1, at: '2026-09-18T10:10:00.000Z', event: 'SessionStart', payload: {} })}\n`);
  writeFileSync(join(locksDir, 'phase-03.lock'), 'owner=autopilot/abc\nphase=3\n');

  return {
    home,
    deps: {
      runDir,
      instanceDir,
      locksDir,
      traceId: 'a'.repeat(32),
      console: () => ({ version: '5.1.0', instance: 'pe-hub', port: 4130 }),
      worktrees: () => [{ slug: 'demo', branch: 'pe/demo', view: 'clean' }],
      diagnosis: (phase: number) => ({ phase, blockedOn: null, boardState: 'done' }),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        PHASE_CONSOLE_LOG_LEVEL: 'info',
        MY_TOKEN: 'sk-live-BBBBBBBBBBBBBBBBBBBB',
        AWS_SECRET_ACCESS_KEY: 'nope',
        SOMETHING_UNLISTED: 'also not carried',
      },
      now: () => Date.parse('2026-09-18T12:00:00.000Z'),
    },
  };
}

test('BUN-1 — the manifest names every artefact, and every name is in the archive', async () => {
  const { runBundle, RUN_BUNDLE_SCHEMA, RUN_BUNDLE_VERSION } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);

  assert.equal(out.manifest.schema, RUN_BUNDLE_SCHEMA);
  assert.equal(out.manifest.version, RUN_BUNDLE_VERSION);
  assert.equal(RUN_BUNDLE_VERSION, 2, 'the v1 bundle is the whole-console one; this is the run one');

  const listed = listWithTar(out.body, 'bundle-1.tgz').sort();
  const named = out.manifest.files.map((one: { name: string }) => one.name).sort();
  assert.deepEqual(listed, named, 'the manifest and the archive must not be able to disagree');

  for (const expected of [
    'MANIFEST.json',
    'record.json',
    'journal.ndjson',
    'transcript.ndjson',
    'rulings.ndjson',
    'messages.ndjson',
    'git-trace.ndjson',
    'worktrees.json',
    'env.json',
    'versions.json',
    'SUMMARY.json',
    'console/console.log.slice.ndjson',
    'tasks/run-p3.ndjson',
    'outcomes/run-p3.json',
    'tasks/inbox-phase-03.ndjson',
    'outcomes/inbox-phase-03.json',
    'sessions/sess-1.events.ndjson',
    'locks/phase-03.lock',
    'diagnosis/phase-03.json',
  ]) {
    assert.ok(listed.includes(expected), `${expected} is not in the bundle: ${listed.join(', ')}`);
  }
});

test('BUN-2 — the three planted secrets are absent from every member', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps, home } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);
  const whole = gunzipSync(out.body).toString('utf8');

  assert.ok(!whole.includes('sk-live-AAAAAAAAAAAAAAAAAAAA'), 'a vendor key in a journal line');
  assert.ok(!whole.includes('Bearer abcdefghijklmnop'), 'an Authorization header in a log line');
  assert.ok(!whole.includes(`${home}/work/secret-project`), 'the operator’s home path');
  assert.ok(whole.includes('~/work/secret-project'), 'the path is MASKED, not deleted — it is still evidence');
});

test('BUN-3 — env.json carries the allow-listed names and no secret’s value', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);
  const root = extractWithTar(out.body, 'bundle-3');
  const env = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8')) as Record<string, unknown>;

  assert.equal(env.PATH, '/usr/bin:/bin', 'PATH is the single most useful variable here — E7 is a PATH bug');
  assert.equal(env.PHASE_CONSOLE_LOG_LEVEL, 'info');
  assert.ok(!('MY_TOKEN' in env), 'a name matching /TOKEN|SECRET|KEY|PASS|AUTH/i is dropped whole');
  assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
  assert.ok(!('SOMETHING_UNLISTED' in env), 'the list is an allow-list: an unknown name is not carried');
  assert.ok(!JSON.stringify(env).includes('sk-live-BBBBBBBBBBBBBBBBBBBB'), 'and certainly not its value');
});

test('BUN-4 — tar -tzf succeeds and the content type is a real gzip', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);
  assert.equal(out.body[0], 0x1f);
  assert.equal(out.body[1], 0x8b);
  assert.ok(listWithTar(out.body, 'bundle-4.tgz').length > 10);
  assert.match(out.filename, /^phase-console-run-demo-aaaaaaaa-[0-9TZ-]+\.tar\.gz$/);
});

test('BUN-5 — `since` narrows the time-stamped members and leaves the rest whole', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const since = Date.parse('2026-09-18T10:45:00.000Z');
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa', since }, deps as never);
  const root = extractWithTar(out.body, 'bundle-5');

  const journal = readFileSync(join(root, 'journal.ndjson'), 'utf8').trim().split('\n');
  assert.equal(journal.length, 1, 'only the 11:00 line survives a 10:45 floor');
  assert.ok(journal[0].includes('phase.session'));

  assert.equal(
    readFileSync(join(root, 'transcript.ndjson'), 'utf8').trim(),
    '',
    'the 10:05 transcript line is before the floor',
  );
  // A ruling has no timestamp of its own in this fixture: an undated line is
  // never dropped, because "I could not date it" must not read as "it is old".
  assert.ok(readFileSync(join(root, 'rulings.ndjson'), 'utf8').includes('chose A'));
  assert.equal(new Date(out.manifest.since as string).getTime(), since);
});

test('BUN-6 — the console slice keeps this run’s trace and the warn/error window, and nothing else', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);
  const root = extractWithTar(out.body, 'bundle-6');
  const slice = readFileSync(join(root, 'console', 'console.log.slice.ndjson'), 'utf8').trim().split('\n');

  assert.equal(slice.length, 2, `one traced line and one error; got ${slice.length}`);
  assert.ok(slice.some((line) => line.includes('http.request')), 'the line carrying this run’s trace id');
  assert.ok(slice.some((line) => line.includes('git.command')), 'an error line, whatever its trace');
  assert.ok(!slice.some((line) => line.includes('run.other')), 'another trace’s info line is not this run’s evidence');
});

test('BUN-7 — a run that does not exist is refused by name rather than half-built', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  await assert.rejects(
    () => runBundle({ slug: 'demo', runId: 'bbbbbbbb' }, deps as never),
    /bbbbbbbb/,
  );
});

test('BUN-8 — an artefact that is simply absent is named in `missing`, not an error', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  rmSync(join(deps.runDir as string, 'messages.ndjson'));
  rmSync(join(deps.runDir as string, 'run-aaaaaaaa.log.jsonl'));
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);

  assert.ok(out.manifest.missing.includes('messages.ndjson'), `missing: ${out.manifest.missing}`);
  assert.ok(out.manifest.missing.includes('transcript.ndjson'));
  assert.ok(!out.manifest.files.some((one: { name: string }) => one.name === 'messages.ndjson'));
  // …and the archive still reads, which is the point of naming rather than throwing.
  assert.ok(listWithTar(out.body, 'bundle-8.tgz').includes('MANIFEST.json'));
});

test('BUN-9 — the manifest says the redaction is best-effort, in words a person reads', async () => {
  const { runBundle } = await import('../server/debug/bundle.ts');
  const { deps } = plantRun();
  const out = await runBundle({ slug: 'demo', runId: 'aaaaaaaa' }, deps as never);
  assert.ok(
    out.manifest.notes.some((note: string) => /best-effort/i.test(note) && /inspect/i.test(note)),
    `a bundle that claims to be redacted and is not read before sharing is the failure mode: ${out.manifest.notes}`,
  );
});

test('BUN-10 — `since` is read as a duration back from now, or as an instant', async () => {
  const { parseSince } = await import('../server/debug/bundle.ts');
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  assert.equal(parseSince('30m', now), Date.parse('2026-09-18T11:30:00.000Z'));
  assert.equal(parseSince('2h', now), Date.parse('2026-09-18T10:00:00.000Z'));
  assert.equal(parseSince('7d', now), Date.parse('2026-09-11T12:00:00.000Z'));
  assert.equal(parseSince('2026-09-18T09:00:00.000Z', now), Date.parse('2026-09-18T09:00:00.000Z'));
  assert.equal(parseSince(String(now), now), now);
  // Anything unreadable is NO floor rather than a floor of zero or of now: the
  // first would be a silent no-op and the second would return an empty bundle.
  assert.equal(parseSince('yesterday-ish', now), undefined);
  assert.equal(parseSince('', now), undefined);
  assert.equal(parseSince(null, now), undefined);
});

// ---------------------------------------------------------------- the CLI verb

/**
 * A state directory as a console really leaves one, so the offline path is
 * exercised over the real `instances.mjs` resolution rather than a stub.
 */
function plantStateDir(): { xdg: string; repo: string; runId: string } {
  const base = mkdtempSync(join(work, 'cli-'));
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'handoffs', 'demo', '.locks'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(repo, 'docs', 'handoffs', 'demo', '.locks', 'phase-03.lock'), 'owner=autopilot/x\n');

  const xdg = join(base, 'state');
  // `instanceId()` is what names the run directory; asking the real module for
  // it is the only way this fixture and the verb can agree.
  const id = execFileSync(
    process.execPath,
    ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(join(REPO, 'viewer/shared/instances.mjs')).href)});`
      + ` process.stdout.write(m.instanceId(${JSON.stringify(repo)}));`],
    { encoding: 'utf8', env: { ...process.env, PHASE_CONSOLE_ALLOW_REAL_STATE: '1' } },
  ).trim();

  const runDir = join(xdg, 'phase-console', 'runs', id, 'demo');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'run-abcdef01.json'),
    JSON.stringify({ id: 'abcdef01', slug: 'demo', status: 'finished', phases: { 3: { status: 'done' } } }),
  );
  writeFileSync(
    join(runDir, 'run-abcdef01.jsonl'),
    `${JSON.stringify({ seq: 1, time: '2026-09-18T10:00:00.000Z', event: 'run.started' })}\n`,
  );
  return { xdg, repo, runId: 'abcdef01' };
}

function runVerb(bin: string, args: string[], xdg: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [join(REPO, bin), 'diagnostics', ...args], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: xdg, PHASE_CONSOLE_ALLOW_REAL_STATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

test('CLI-1 — the verb builds a bundle offline, with no console up', () => {
  const { xdg, repo, runId } = plantStateDir();
  const target = join(work, 'cli-offline.tar.gz');
  const result = runVerb('bin/phase-console.mjs', ['--run', runId, '--root', repo, '--out', target], xdg);

  assert.equal(result.code, 0, `${result.err}${result.out}`);
  // Either wording of the offline half is correct here; what must NEVER happen
  // is a stream from a console that is not this instance's, which is what this
  // test found the first time it ran on a machine with another console up.
  assert.match(result.out, /built from the state directory/, 'and it says which half built it');
  assert.ok(!/streamed from/.test(result.out), 'a foreign console must never answer for this instance');
  assert.match(result.out, /best-effort/, 'the sharing warning reaches the terminal, not only the manifest');
  const listed = listWithTar(readFileSync(target), 'cli-offline-list.tgz');
  assert.ok(listed.includes('MANIFEST.json'));
  assert.ok(listed.includes('journal.ndjson'));
  assert.ok(listed.includes('locks/phase-03.lock'), 'the docs root’s locks are found without a console to ask');
});

test('CLI-2 — the plan is found from the run id alone', () => {
  const { xdg, repo, runId } = plantStateDir();
  const target = join(work, 'cli-noslug.tar.gz');
  const result = runVerb('bin/phase-console.mjs', ['--run', runId, '--root', repo, '--out', target], xdg);
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  const root = extractWithTar(readFileSync(target), 'cli-noslug');
  const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8')) as { slug: string };
  assert.equal(manifest.slug, 'demo');
});

test('CLI-3 — a run nobody has heard of exits non-zero and names it', () => {
  const { xdg, repo } = plantStateDir();
  const result = runVerb('bin/phase-console.mjs', ['--run', 'ffffffff', '--root', repo], xdg);
  assert.equal(result.code, 1);
  assert.match(result.err, /ffffffff/);
});

test('CLI-4 — a malformed run id is refused before anything is read', () => {
  const { xdg, repo } = plantStateDir();
  const result = runVerb('bin/phase-console.mjs', ['--run', '../../etc', '--root', repo], xdg);
  assert.equal(result.code, 2);
  assert.match(result.err, /8-32 hex/);
});
