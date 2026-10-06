/**
 * `unit:<host>/<unit>` — a wait on a job running on another machine
 * (control-tower phase 121, #181).
 *
 * issues-sweep P7 slept ~1.5 h past its box job behind a worst-case `date:`,
 * because nothing the console could watch saw the job end. A systemd unit is
 * the job's own record of that, so the scheme reads it over ssh:
 *
 *   WU-1  the grammar — a host NAME and a unit name, no shell character and no
 *         leading dash (ssh hands its command to a remote shell), the same
 *         answer in bash and in the console; polled every five minutes;
 *   WU-2  the probe — pending while the unit is `activating`/`active`, landed
 *         the first time it is not, with `Result=` and the exit time kept in
 *         the wait history; every probe of one host over ONE multiplexed ssh
 *         master, one probe of a host at a time;
 *   WU-3  the machine profile — the host name maps to an address, a user, a
 *         key and a port read at probe time; a name the profile does not hold
 *         is refused; the user and the key are never written into a run
 *         record, a verdict or a wait history.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WATCH_SCHEMES, WATCH_POLL_MS, nextDueFor, parseWatchRef, probeWatchRef } = await import('../server/watch-refs.ts');
const {
  UNIT_POLL_MS, UNIT_SOCKET_PATH_MAX, UnitProber, controlDirFits, parseUnitShow, recordUnitExit, sshFailureWords,
  unitControlDir, unitHostOf,
} = await import('../server/watch-unit.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
type ShellRun = import('../server/shell.ts').ShellRun;
type UnitTarget = import('../server/watch-unit.ts').UnitTarget;

// `train@7` is a template instance — systemctl adds the service suffix itself,
// and the name WITH that suffix is a spelling the leak scrub takes for an email.
const GOOD = ['unit:build-box/nightly-build.service', 'unit:gpu.lan/train@7', 'unit:box/backup', 'unit:a/b:c-d_e.timer'];
const BAD = [
  'unit:-oProxyCommand=sh/x.service', 'unit:build-box/x;reboot', 'unit:build-box/', 'unit:/x.service',
  'unit:build box/x', 'unit:build-box/$(id)', 'unit:build-box/a b', 'unit:build-box/`id`', 'unit:build-box/a\\x',
  'unit:build-box/x|sh', 'unit:build-box/-x',
];

function run(stdout: string, extra: Partial<ShellRun> = {}): ShellRun {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', ms: 1, truncatedBytes: 0, timedOut: false, ...extra } as ShellRun;
}

const RUNNING = 'LoadState=loaded\nActiveState=activating\nSubState=start\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\n';
const DONE = 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n'
  + 'ExecMainExitTimestamp=Mon 2026-10-05 10:00:00 UTC\nInactiveEnterTimestamp=Mon 2026-10-05 10:00:00 UTC\n';
const FAILED = 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainStatus=2\n'
  + 'ExecMainExitTimestamp=Mon 2026-10-05 11:30:05 UTC\n';

const PROFILE = { 'build-box': { address: '10.0.0.5', user: 'deploy', key: '/home/x/.ssh/box_ed25519', port: 2222 } };

/* ------------------------------------------------------------------ *
 * WU-1 — the grammar
 * ------------------------------------------------------------------ */

test('WU-1 — unit:<host>/<unit> is a scheme: a host name and a unit name, nothing a remote shell would read; every five minutes', () => {
  assert.ok((WATCH_SCHEMES as readonly string[]).includes('unit'));
  assert.equal(WATCH_POLL_MS.unit, 5 * 60_000);
  assert.equal(UNIT_POLL_MS, 5 * 60_000);
  for (const ref of GOOD) {
    const target = parseWatchRef(ref) as UnitTarget | null;
    assert.equal(target?.kind, 'unit', ref);
  }
  assert.deepEqual(parseWatchRef('unit:build-box/nightly-build.service'), {
    kind: 'unit', host: 'build-box', unit: 'nightly-build.service', ref: 'unit:build-box/nightly-build.service',
  });
  for (const ref of BAD) assert.equal(parseWatchRef(ref), null, `${ref} must not parse`);
  const target = parseWatchRef(GOOD[0]!)!;
  const now = Date.parse('2026-10-05T10:00:00Z');
  assert.equal(nextDueFor(target, 'pending', now), now + 5 * 60_000, 'polled every five minutes, no back-off');
});

test('WU-1 — the bash door holds the same line: a good unit: ref is recorded, a bad one refused with nothing written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-watch-unit-door-'));
  try {
    const out = join(dir, 'outcome.json');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, 'state'), DOCS_ROOT: dir,
      PE_OUTCOME_FILE: out, PE_NOW: '2026-10-05T10:00:00Z', PHASE_OUTCOME_PROBE: '0',
    };
    const disagree: string[] = [];
    for (const ref of [...GOOD, ...BAD]) {
      rmSync(out, { force: true });
      const r = spawnSync('bash', [join(SKILL_DIR, 'scripts', 'phase-outcome.sh'), 'demo', '3', 'waiting-external',
        '--reason', 'box job', '--watch', ref], { env, encoding: 'utf8' });
      const accepted = r.status === 0;
      if (accepted !== (parseWatchRef(ref) !== null)) disagree.push(`${ref}: bash ${accepted ? 'accepted' : 'refused'}`);
    }
    assert.deepEqual(disagree, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * WU-2 — the probe
 * ------------------------------------------------------------------ */

test('WU-2 — pending while it runs, landed once it is not, with Result= and the exit time; a unit that does not exist is refused', async () => {
  const replies = [RUNNING, DONE, FAILED, 'LoadState=not-found\nActiveState=inactive\nResult=success\n'];
  const prober = new UnitProber({
    profile: (name) => (PROFILE as Record<string, { address: string }>)[name] ?? null,
    exec: async () => run(replies.shift() ?? ''),
    controlDir: '/tmp/pc-ssh-test',
  });
  const target = parseWatchRef('unit:build-box/nightly-build.service') as UnitTarget;
  const running = await prober.probe(target);
  assert.equal(running.state, 'pending');
  assert.match(running.detail ?? '', /activating/);
  const done = await prober.probe(target);
  assert.equal(done.state, 'landed');
  assert.equal(done.detail, 'Result=success · exited 2026-10-05T10:00:00.000Z');
  assert.deepEqual(done.unit, { result: 'success', exitedAt: '2026-10-05T10:00:00.000Z' });
  const failed = await prober.probe(target);
  assert.equal(failed.state, 'landed', 'a failed job has ended too — the session reads how');
  assert.equal(failed.detail, 'Result=exit-code · exited 2026-10-05T11:30:05.000Z');
  const missing = await prober.probe(target);
  assert.equal(missing.state, 'refused');
  assert.match(missing.detail ?? '', /no unit nightly-build\.service on build-box/);
  // The parse alone: a timestamp in another zone is kept as written.
  assert.deepEqual(parseUnitShow('ActiveState=inactive\nResult=timeout\nExecMainExitTimestamp=Mon 2026-10-05 12:00:00 CEST\n'), {
    activeState: 'inactive', result: 'timeout', exitedAt: 'Mon 2026-10-05 12:00:00 CEST',
  });
  // An ssh that cannot connect is a wait, never a landing: asked again.
  const down = new UnitProber({
    profile: () => PROFILE['build-box'], controlDir: '/tmp/pc-ssh-test',
    exec: async () => run('', { ok: false, code: 255, stderr: 'ssh: connect to host 10.0.0.5 port 2222: Operation timed out' }),
  });
  const unknown = await down.probe(target);
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.detail ?? '', /timed out/);
  // Through the one dispatch every scheme goes through.
  const via = await probeWatchRef(target, { unitProbe: async () => ({ ref: target.ref, state: 'landed', detail: 'x' }) });
  assert.equal(via.state, 'landed');
  assert.equal((await probeWatchRef(target, {})).state, 'unknown', 'no prober wired is unknown, never refused');
});

test('WU-2 — ONE multiplexed ssh master per host, and one probe of a host at a time; two hosts run side by side', async () => {
  const calls: { host: string; argv: string[] }[] = [];
  const inFlight = new Map<string, number>();
  let maxSameHost = 0;
  let maxAcrossHosts = 0;
  const prober = new UnitProber({
    profile: (name) => ({ address: name === 'a' ? '10.0.0.1' : '10.0.0.2' }),
    controlDir: '/tmp/pc-ssh-test',
    exec: async (_file, argv) => {
      const host = argv.includes('10.0.0.1') ? 'a' : 'b';
      calls.push({ host, argv: [...argv] });
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      maxSameHost = Math.max(maxSameHost, inFlight.get(host)!);
      maxAcrossHosts = Math.max(maxAcrossHosts, [...inFlight.values()].reduce((x, y) => x + y, 0));
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight.set(host, inFlight.get(host)! - 1);
      return run(RUNNING);
    },
  });
  const t = (ref: string) => parseWatchRef(ref) as UnitTarget;
  await Promise.all([
    prober.probe(t('unit:a/one.service')), prober.probe(t('unit:a/two.service')), prober.probe(t('unit:a/three.service')),
    prober.probe(t('unit:b/one.service')),
  ]);
  assert.equal(maxSameHost, 1, 'probes of one host queue — they never race to become its master');
  assert.equal(maxAcrossHosts, 2, 'two hosts are probed side by side');
  const opt = (argv: string[], name: string) => argv.find((a, i) => argv[i - 1] === '-o' && a.startsWith(`${name}=`));
  const pathsA = new Set(calls.filter((c) => c.host === 'a').map((c) => opt(c.argv, 'ControlPath')));
  const pathsB = new Set(calls.filter((c) => c.host === 'b').map((c) => opt(c.argv, 'ControlPath')));
  assert.equal(pathsA.size, 1, 'one master per host');
  assert.notDeepEqual([...pathsA], [...pathsB], 'and a different one for another host');
  for (const { argv } of calls) {
    assert.equal(opt(argv, 'ControlMaster'), 'ControlMaster=auto');
    assert.match(opt(argv, 'ControlPersist') ?? '', /^ControlPersist=\d+m$/, 'the master outlives the five-minute cadence');
    assert.equal(opt(argv, 'BatchMode'), 'BatchMode=yes', 'never a password prompt nobody sees');
    // Fixed argv: the destination after `--`, then systemctl show, then the unit after its own `--`.
    const dash = argv.indexOf('--');
    assert.ok(dash > 0, 'options end before the destination');
    assert.deepEqual(argv.slice(dash + 2, dash + 4), ['systemctl', 'show']);
    assert.equal(argv[argv.length - 2], '--');
  }
});

test('WU-2 — the landing goes into the wait history: Result= and the exit time on the open entry, nothing else', () => {
  const state = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [3] } as never);
  const record = phaseRecord(state, 3);
  record.waitHistory = [{ parkedFrom: '2026-10-05T09:00:00.000Z', parkedUntil: '2026-10-05T21:00:00.000Z', by: 'session' }];
  const wrote = recordUnitExit(record, {
    ref: 'unit:build-box/nightly-build.service', state: 'landed', detail: 'Result=success · exited 2026-10-05T10:00:00.000Z',
    unit: { result: 'success', exitedAt: '2026-10-05T10:00:00.000Z' },
  });
  assert.equal(wrote, true);
  assert.deepEqual(record.waitHistory[0]!.unit, {
    ref: 'unit:build-box/nightly-build.service', result: 'success', exitedAt: '2026-10-05T10:00:00.000Z',
  });
  // A pending verdict, or no open entry, writes nothing.
  assert.equal(recordUnitExit(record, { ref: 'unit:build-box/x', state: 'pending' }), false);
});

/* ------------------------------------------------------------------ *
 * WU-3 — the machine profile, never the record
 * ------------------------------------------------------------------ */

test('WU-3 — the profile names the host: address, user, key and port read at probe time; a name it does not hold is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-watch-unit-profile-'));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), HOME: join(dir, 'home') };
    mkdirSync(join(dir, 'config', 'phase-console'), { recursive: true });
    writeFileSync(join(dir, 'config', 'phase-console', 'fleet.json'), JSON.stringify({
      remoteHost: 'mac.tailnet', hosts: { 'build-box': { address: '10.0.0.5', user: 'deploy', key: '~/.ssh/box_ed25519', port: 2222 } },
    }));
    assert.deepEqual(unitHostOf('build-box', env), {
      address: '10.0.0.5', user: 'deploy', key: join(dir, 'home', '.ssh', 'box_ed25519'), port: 2222,
    });
    assert.equal(unitHostOf('elsewhere', env), null);

    const argvs: string[][] = [];
    const prober = new UnitProber({ env, controlDir: '/tmp/pc-ssh-test', exec: async (_f, argv) => { argvs.push([...argv]); return run(DONE); } });
    const target = parseWatchRef('unit:build-box/nightly-build.service') as UnitTarget;
    const verdict = await prober.probe(target);
    assert.equal(verdict.state, 'landed');
    const argv = argvs[0]!;
    assert.deepEqual(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2), ['-l', 'deploy']);
    assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2), ['-i', join(dir, 'home', '.ssh', 'box_ed25519')]);
    assert.deepEqual(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2), ['-p', '2222']);
    assert.equal(argv[argv.indexOf('--') + 1], '10.0.0.5', 'the address, never the bare name, is what ssh dials');

    const stranger = await prober.probe(parseWatchRef('unit:elsewhere/x.service') as UnitTarget);
    assert.equal(stranger.state, 'refused');
    assert.match(stranger.detail ?? '', /the machine profile names no host "elsewhere"/);
    assert.equal(argvs.length, 1, 'a host the operator never named is never dialled');

    // What is KEPT — the verdict, the record, the wait history — carries the
    // ref and the result, and never the user, the key or the address.
    const state = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [3] } as never);
    const record = phaseRecord(state, 3);
    record.waitHistory = [{ parkedFrom: '2026-10-05T09:00:00.000Z', parkedUntil: '2026-10-05T21:00:00.000Z', by: 'session' }];
    record.watch = [target.ref];
    record.watchState = { refs: [{ ref: target.ref, scheme: 'unit', state: verdict.state, detail: verdict.detail, checkedAt: '2026-10-05T10:05:00.000Z' }] } as never;
    recordUnitExit(record, verdict);
    const kept = JSON.stringify([verdict, record, stranger]);
    for (const secret of ['deploy', 'box_ed25519', '10.0.0.5', '2222']) {
      assert.ok(!kept.includes(secret), `"${secret}" reached what the console keeps`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-2 — the master socket always fits a Unix socket path, ssh\'s own bind suffix included', () => {
  // A named instance's state directory is over seventy bytes — the same length
  // as this one — and a socket under it overran macOS's 104 by four, so ssh
  // exited 255 on every probe before the remote command ran.
  const named = '/home/someone-longer/.local/state/phase-console/instances/f922d743-pe-hub';
  assert.equal(controlDirFits(join(named, 'ssh')), false, 'the instance\'s own directory has no room');
  const temp = '/var/folders/q7/vn9l8tw57238n0kgthswx6mc0000gn/T';
  const dir = unitControlDir(named, temp, 501);
  assert.equal(dir, join(temp, 'pc-ssh-501'), 'a directory of this user\'s own under the temp one');
  const path = new UnitProber({ controlDir: dir, profile: () => null }).controlPathFor('build-box');
  assert.ok(Buffer.byteLength(path) + 17 <= UNIT_SOCKET_PATH_MAX, `${path} leaves ssh its 17 bytes`);
  // The default instance's directory fits, and keeps its sockets with its state.
  assert.equal(unitControlDir('/home/someone/.local/state/phase-console', temp, 501), '/home/someone/.local/state/phase-console/ssh');
});

test('WU-3 — ssh\'s failure is told in words of its class, never in its own text', async () => {
  const words = (stderr: string, code = 255) => sshFailureWords({ stderr, code, timedOut: false }, 'build-box');
  for (const [stderr, said] of [
    ['ssh: connect to host 100.101.102.103 port 2222: Connection refused', 'refused the connection'],
    ['Connection closed by 100.101.102.103 port 22', 'lost the connection'],
    ['ssh: Could not resolve hostname nightly.tailnet.example: nodename nor servname provided', 'could not resolve the host'],
    ['deploy@100.101.102.103: Permission denied (publickey).', 'refused the login'],
    ['unix_listener: path "/x/u-1.abcdefghijklmnop" too long for Unix domain socket', 'could not use its control socket'],
  ] as const) {
    const told = words(stderr);
    assert.match(told, new RegExp(`^ssh to build-box ${said.replace(/[()]/g, '\\$&')}`), told);
    for (const secret of ['100.101.102.103', '2222', 'port 22', 'deploy', 'tailnet', '/x/u-1']) {
      assert.ok(!told.includes(secret), `${told} names ${secret}`);
    }
  }
  assert.equal(words('something nobody wrote down', 1), 'ssh to build-box failed (exit 1)');
  assert.equal(sshFailureWords({ stderr: '', code: null, timedOut: true }, 'build-box'), 'ssh to build-box timed out');
  // Through the prober: the verdict carries the class, not the line.
  const prober = new UnitProber({
    profile: () => ({ address: 'nightly.tailnet.example', user: 'deploy' }), controlDir: '/tmp/pc-ssh-test',
    exec: async () => run('', { ok: false, code: 255, stderr: 'Connection closed by 100.101.102.103 port 22' }),
  });
  const verdict = await prober.probe({ kind: 'unit', host: 'build-box', unit: 'nightly-build.service', ref: 'unit:build-box/nightly-build.service' });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.detail, 'ssh to build-box lost the connection (exit 255)');
});
