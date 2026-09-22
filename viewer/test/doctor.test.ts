/**
 * `phase-console doctor` (phase 11, exit criterion 5): every row answers
 * `ok|fail|skip` with a reason; a failing BLOCKING row fails the report and
 * names itself first; the report the route serves is the report the CLI
 * prints (one `doctorReport`, two deps builders); `--help` exits 0.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_CLI_FLOOR } from '../shared/run-settings.js';
import { PROBE_STATUSES } from '../shared/ops-vocab.js';
import {
  atLeast, cliVerdict, consoleVerdict, doctorExitCode, doctorReport, environmentVerdict, formatDoctor, gitVerdict, hooksVerdict,
  skipped,
  type DoctorDeps, type DoctorRow,
} from '../server/doctor.ts';
import type { HooksStatus } from '../server/hooks-install.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const NOW = '2026-09-14T12:00:00.000Z';

const okv = (reason: string) => ({ status: 'ok' as const, ok: true, reason });
const failv = (reason: string) => ({ status: 'fail' as const, ok: false, reason });

const hooks = (over: Partial<HooksStatus> = {}): HooksStatus => ({
  path: '/home/someone/.claude/settings.json', exists: true, installed: true, partial: false,
  events: { SessionStart: true, SessionEnd: true, Stop: true, Notification: true },
  command: 'bash /x/scripts/session-hook.sh', stale: false, ...over,
});

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    instance: { id: 'abcd1234-demo', name: 'demo', root: '/home/someone/demo', port: 4130, default: false },
    mode: 'console',
    accounts: async () => okv('1 of 1 declared account usable: the machine login'),
    mcp: async () => skipped('no MCP server registered'),
    credentials: async () => okv('1 of 1 credential held'),
    delivery: async () => okv('1 subscribed device'),
    hooks: async () => hooks(),
    unit: async () => ({ installed: true, disabled: false, runAtLoad: true, stoppedMarker: false, label: 'com.phase-console.abcd1234-demo' }),
    cliVersion: async () => '2.1.270',
    gh: async () => okv('gh auth status: signed in'),
    git: async () => ({ version: 'git version 2.50.0', code: 0, insideWorkTree: true, path: '/opt/homebrew/bin/git', root: '/home/someone/demo' }),
    environment: () => [],
    console: async () => ({ healthy: true, serverStale: false, version: 'built at deadbeef' }),
    now: () => NOW,
    ...over,
  };
}

test('every row answers ok|fail|skip with a reason, in the documented order; a clean machine is ok', async () => {
  const report = await doctorReport(deps());
  const order = ['accounts', 'mcp', 'credentials', 'delivery', 'hooks', 'cli', 'gh', 'publish', 'git', 'environment', 'console'];
  assert.deepEqual(report.rows.map((r) => r.id), order);
  for (const row of report.rows) {
    assert.ok((PROBE_STATUSES as readonly string[]).includes(row.status), `${row.id}: ${row.status}`);
    assert.ok(row.reason.length > 8, `${row.id} carries a reason`);
    assert.equal(typeof row.blocking, 'boolean');
  }
  assert.deepEqual(
    report.rows.filter((r) => r.blocking).map((r) => r.id),
    ['accounts', 'credentials', 'hooks', 'git', 'environment', 'console'],
  );
  assert.equal(report.ok, true);
  assert.equal(report.firstFailing, null);
  assert.equal(doctorExitCode(report), 0);
  assert.equal(report.cliFloor, RELAY_CLI_FLOOR);
  assert.equal(report.mode, 'console');
  assert.equal(report.at, NOW);
  assert.match(formatDoctor(report), /^phase-console doctor — demo \(abcd1234-demo, :4130\) — answered by the running console/);
  assert.match(formatDoctor(report), /\ndoctor: ok$/);
});

test('a failing blocking row fails the report and is named first; a failing non-blocking row only reports', async () => {
  const blocked = await doctorReport(deps({
    delivery: async () => failv('no delivery channel'),
    hooks: async () => hooks({ installed: false, partial: true }),
    environment: () => [{ kind: 'path-missing-dir', detail: 'PATH entry does not exist: /nope', fix: 'remove it' }],
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.firstFailing?.id, 'hooks', 'the first BLOCKING failure, not the first failure');
  const environment = blocked.rows.find((r) => r.id === 'environment')!;
  assert.equal(environment.status, 'ok', 'a PATH advisory is a warning on an ok row, never a failure');
  assert.deepEqual(environment.warnings, ['path-missing-dir ×1: /nope — remove it']);
  assert.equal(doctorExitCode(blocked), 1);
  const text = formatDoctor(blocked);
  assert.match(text, /✗ Delivery channel {2,}no delivery channel\n/, 'a non-blocking fail prints without the tag');
  assert.match(text, /✗ Session-presence hooks .* \[blocking\]/);
  assert.match(text, /\ndoctor: hooks — partially installed in .* — run phase-console install-hooks$/);
  const advisory = await doctorReport(deps({ delivery: async () => failv('no delivery channel'), cliVersion: async () => '2.1.200' }));
  assert.equal(advisory.ok, true, 'delivery and the CLI floor report, they do not block');
  assert.equal(advisory.rows.find((r) => r.id === 'cli')?.status, 'fail');
  // A probe that throws is a skip with the error in its reason — never a crash, never a fail.
  const thrown = await doctorReport(deps({ accounts: async () => { throw new Error('registry unreadable'); } }));
  const accounts = thrown.rows.find((r) => r.id === 'accounts')!;
  assert.equal(accounts.status, 'skip');
  assert.match(accounts.reason, /the accounts probe could not be asked — registry unreadable/);
  assert.equal(thrown.ok, true);
});

test('the per-row verdicts: hooks, unit, CLI floor, environment, console', () => {
  assert.equal(hooksVerdict(null).status, 'skip');
  assert.equal(hooksVerdict(hooks()).status, 'ok');
  assert.match(hooksVerdict(hooks({ stale: true })).reason, /points at another checkout/);
  assert.match(hooksVerdict(hooks({ installed: false })).reason, /not installed in .* — run phase-console install-hooks/);
  assert.match(hooksVerdict(hooks({ parseError: 'Unexpected token' })).reason, /does not parse/);


  assert.equal(atLeast('2.1.270', RELAY_CLI_FLOOR), true);
  assert.equal(atLeast('2.1.268', RELAY_CLI_FLOOR), true);
  assert.equal(atLeast('2.1.267', RELAY_CLI_FLOOR), false);
  assert.equal(atLeast('2.2.0', RELAY_CLI_FLOOR), true);
  assert.equal(atLeast('v3.0', RELAY_CLI_FLOOR), true);
  assert.equal(atLeast(undefined, RELAY_CLI_FLOOR), null);
  assert.equal(cliVerdict(undefined).status, 'skip');
  assert.match(cliVerdict('2.1.100').reason, /below 2\.1\.268 — the relay will not arm/);
  assert.match(cliVerdict('2.1.270').reason, /the relay can arm/);

  assert.equal(environmentVerdict([]).status, 'ok');
  const env = environmentVerdict([{ kind: 'push-broken', detail: 'VAPID key unreadable', fix: 'x' }]);
  assert.equal(env.status, 'fail');
  assert.match(env.reason, /1 issue: push-broken — VAPID key unreadable/);
  const paths = environmentVerdict([
    { kind: 'path-missing-dir', detail: 'PATH entry does not exist: /a', fix: 'remove it' },
    { kind: 'path-missing-dir', detail: 'PATH entry does not exist: /b', fix: 'remove it' },
    { kind: 'path-foreign-home', detail: 'PATH entry under a different user\'s home: /home/x/bin', fix: 'remove it' },
  ]);
  assert.equal(paths.status, 'ok');
  assert.match(paths.reason, /3 PATH advisories \(not fatal/);
  assert.deepEqual(paths.warnings, ['path-missing-dir ×2: /a, /b — remove it', 'path-foreign-home ×1: /home/x/bin — remove it']);

  assert.equal(consoleVerdict(null, 4130).status, 'skip');
  assert.match(consoleVerdict(null, 4130).reason, /no console is answering on :4130/);
  assert.equal(consoleVerdict({ healthy: false }, 4130).status, 'fail');
  const stale = consoleVerdict({ healthy: true, serverStale: true }, 4130);
  assert.equal(stale.status, 'ok');
  assert.deepEqual(stale.warnings, ['server code is stale — restart the console']);
});


test('the offline report says so, and formatDoctor prints warnings under their row', async () => {
  const report = await doctorReport(deps({
    instance: null, mode: 'offline',
    mcp: async () => skipped('MCP probes need a running console'),
    accounts: async () => ({ status: 'ok', ok: true, reason: '1 of 2 declared accounts usable: a', warnings: ['b — retired by the breaker'] }),
    console: async () => null,
  }));
  assert.equal(report.mode, 'offline');
  assert.equal(report.instance, null);
  const text = formatDoctor(report);
  assert.match(text, /^phase-console doctor — no instance resolved; machine rows only/);
  assert.match(text, /↳ b — retired by the breaker/);
  assert.match(text, /– MCP servers .* need a running console/);
  const rows: DoctorRow[] = report.rows;
  assert.equal(rows.find((r) => r.id === 'console')?.status, 'skip');
});

test('`phase-console doctor --help` exits 0 with the usage, from both bins', () => {
  // In the free tree `bin/phase-console.mjs` IS the free bin, and `free/` is not there to name.
  const bins = [join(REPO, 'bin', 'phase-console.mjs')];
  for (const bin of bins) {
    const run = spawnSync(process.execPath, [bin, 'doctor', '--help'], {
      encoding: 'utf8', env: { ...process.env, PHASE_CONSOLE_HOME: REPO },
    });
    assert.equal(run.status, 0, `${bin}: ${run.stderr}`);
    assert.match(run.stdout, /^phase-console doctor \[instance\] \[--json\]/);
    assert.match(run.stdout, /Exit 0 when every blocking row passes/);
  }
  const bad = spawnSync(process.execPath, [join(REPO, 'bin', 'phase-console.mjs'), 'doctor', '--bogus'], {
    encoding: 'utf8', env: { ...process.env, PHASE_CONSOLE_HOME: REPO },
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument --bogus/);
});

/* ------------------------------------------------------------------ *
 * The `git` row (5.1.0, errand E7)
 * ------------------------------------------------------------------ */

/**
 * Why this row exists, in one incident.
 *
 * Under launchd the console's `PATH` leads with `/usr/bin`, where macOS keeps
 * Apple's `git` SHIM. Until `xcodebuild -license` has been accepted that shim
 * exits 69 and prints the licence notice to stderr — for every invocation, of
 * every subcommand, forever. On 2026-09-16 this console's own run `f0da619a`
 * therefore read its repository as `not-a-repo`, was refused isolation, and
 * degraded to the shared root. `doctor` reported the environment HEALTHY
 * throughout, because nothing it probed ran git.
 *
 * So the row runs git under **this process's own `PATH`** rather than a shell's:
 * a probe that finds the Homebrew git a developer has in their interactive
 * shell answers a question nobody asked, and answers it reassuringly.
 */
test('GIT-1 — an unaccepted Xcode licence is a red row that names the command', () => {
  const verdict = gitVerdict({
    version: null,
    code: 69,
    stderr: 'You have not agreed to the Xcode license agreements. Please run sudo xcodebuild -license.',
    insideWorkTree: null,
  });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.reason, /xcodebuild -license/, 'the errand is the useful half of this row');
});

test('GIT-2 — git missing from PATH is a fail, not a skip: nothing this console does works without it', () => {
  const verdict = gitVerdict({ version: null, code: null, insideWorkTree: null });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.reason, /PATH/);
});

test('GIT-3 — a working git over an open repository is ok, and says which git', () => {
  const verdict = gitVerdict({
    version: 'git version 2.39.5 (Apple Git-154)',
    code: 0,
    insideWorkTree: true,
    path: '/usr/bin/git',
    root: '/home/someone/demo',
  });
  assert.equal(verdict.status, 'ok');
  assert.match(verdict.reason, /2\.39\.5/);
  assert.match(verdict.reason, /\/usr\/bin\/git/, 'WHICH git is the whole point — two are usually installed');
});

test('GIT-4 — git works but the root is not a repository: that is the symptom E7 produced', () => {
  const verdict = gitVerdict({ version: 'git version 2.50.0', code: 0, insideWorkTree: false, root: '/home/someone/demo' });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.reason, /not a git repository/);
});

test('GIT-5 — no source directory open is ok, not a fail: there is nothing to be inside', () => {
  const verdict = gitVerdict({ version: 'git version 2.50.0', code: 0, insideWorkTree: null });
  assert.equal(verdict.status, 'ok');
});

test('GIT-6 — a probe that could not run is a skip, which is not the same as a failure', () => {
  assert.equal(gitVerdict(null).status, 'skip');
});

test('GIT-7 — the row is in the report, blocking, and a red one fails the exit code', async () => {
  const green = await doctorReport(deps());
  const row = green.rows.find((one: DoctorRow) => one.id === 'git');
  assert.ok(row, `there is no git row: ${green.rows.map((one: DoctorRow) => one.id).join(', ')}`);
  assert.equal(row.blocking, true, 'a console whose git is broken cannot do anything at all');
  assert.equal(doctorExitCode(green), 0);

  const red = await doctorReport(deps({ git: async () => ({ version: null, code: 69, stderr: 'Xcode license', insideWorkTree: null }) }));
  assert.equal(doctorExitCode(red), 1, 'E7 must be an exit code, not a sentence nobody reads');
  assert.equal(red.firstFailing?.id, 'git');
});

