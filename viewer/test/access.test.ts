/**
 * Who may talk to the console.
 *
 * Two halves. The first is `classify` on its own, because the interesting
 * cases are combinations of two headers and there are more of them than a
 * round-trip test would be pleasant to write. The second boots the real server
 * and speaks HTTP to it, because the decision being correct is worth nothing if
 * it is not actually consulted — and it has to be consulted ahead of the API,
 * the event stream and the static files alike.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';

import { VIEWER_DIR, flagsRefusal, flagsWarning, parseFlags } from '../server/config.ts';
import { AccessLedger, classify, hostnameOf, loginHash } from '../server/api/access.ts';
import { sandbox, spawnConsole } from './spawn-console.ts';

const HOST = 'console.example.ts.net';
const USER = 'operator@example.com';

function req(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const remote = parseFlags(['--remote', HOST, '--remote-user', USER]);
const local = parseFlags([]);

/* ------------------------------------------------------------------ *
 * hostnameOf
 * ------------------------------------------------------------------ */

test('hostnameOf strips the port without mangling IPv6', () => {
  assert.equal(hostnameOf('127.0.0.1:4123'), '127.0.0.1');
  assert.equal(hostnameOf('localhost'), 'localhost');
  assert.equal(hostnameOf('[::1]:4123'), '[::1]');
  // A bare IPv6 has colons but no port; splitting on the last one would leave
  // `::` and quietly stop matching loopback.
  assert.equal(hostnameOf('::1'), '::1');
  assert.equal(hostnameOf('Console.Example.TS.net.'), 'console.example.ts.net');
  assert.equal(hostnameOf(undefined), '');
});

/* ------------------------------------------------------------------ *
 * classify — local-only, which is the default and the common case
 * ------------------------------------------------------------------ */

test('without --remote nothing is refused, whatever the Host', () => {
  for (const host of ['127.0.0.1:4123', 'anything.example', '192.168.1.4:4123', undefined]) {
    const verdict = classify(req(host ? { host } : {}), local);
    assert.equal(verdict.ok, true, `${host} should be served`);
    assert.equal(verdict.ok && verdict.scope, 'local');
  }
});

test('without --remote a stray identity header changes nothing', () => {
  const verdict = classify(req({ host: 'anything.example', 'tailscale-user-login': USER }), local);
  assert.equal(verdict.ok, true);
});

/* ------------------------------------------------------------------ *
 * classify — with --remote
 * ------------------------------------------------------------------ */

test('loopback with no identity is still the local console', () => {
  for (const host of ['127.0.0.1:4123', 'localhost:4123', '[::1]:4123', '::1']) {
    const verdict = classify(req({ host }), remote);
    assert.equal(verdict.ok, true, `${host} should be local`);
    assert.equal(verdict.ok && verdict.scope, 'local');
  }
});

test('a request with no Host header at all is local', () => {
  // HTTP/1.0 and some scripted clients send none. Only loopback can reach the
  // socket in the first place, so this is the same trust as any other loopback.
  const verdict = classify(req({}), remote);
  assert.equal(verdict.ok, true);
});

test('the remote hostname with an allowed login is admitted, case-insensitively', () => {
  const verdict = classify(req({ host: 'Console.Example.TS.net', 'tailscale-user-login': 'Operator@Example.com' }), remote);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.scope, 'remote');
  assert.equal(verdict.ok && verdict.login, USER);
});

test('the remote hostname without an identity is refused', () => {
  const verdict = classify(req({ host: HOST }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 403);
  assert.equal(!verdict.ok && verdict.reason, 'no-identity');
});

test('a login that is not on the list is refused', () => {
  const verdict = classify(req({ host: HOST, 'tailscale-user-login': 'mallory@example.com' }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 403);
  assert.equal(!verdict.ok && verdict.reason, 'not-allowed');
});

test('an unknown Host is refused rather than served', () => {
  // This is the DNS-rebinding case: a page on another origin resolving its own
  // name to 127.0.0.1 arrives with its own Host, and same-origin policy then
  // treats it as this app.
  const verdict = classify(req({ host: 'attacker.example:4123' }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 421);
  assert.equal(!verdict.ok && verdict.reason, 'unknown-host');
});

test('a proxied request asking for a loopback Host is refused', () => {
  // The one that makes the pair a pair. A caller on the tailnet can put any
  // Host they like in the request; if a loopback Host alone meant "local", it
  // would skip the identity check entirely. The proxy sets the identity header
  // on everything it forwards, so this combination cannot be honest.
  const verdict = classify(req({ host: '127.0.0.1:4123', 'tailscale-user-login': USER }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.status, 421);
  assert.equal(!verdict.ok && verdict.reason, 'proxied-as-local');
});

test('a duplicated identity header is no identity', () => {
  // Node hands repeated headers over as an array. Taking the first would let a
  // caller bury the proxy's value behind one of their own.
  const verdict = classify(req({ host: HOST, 'tailscale-user-login': [USER, 'mallory@example.com'] }), remote);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, 'no-identity');
});

/* ------------------------------------------------------------------ *
 * The flags themselves
 * ------------------------------------------------------------------ */

test('--remote and --remote-user fold to lower case and dedupe', () => {
  const flags = parseFlags(['--remote', 'A.Example.Ts.Net.', '--remote', 'a.example.ts.net',
    '--remote-user', 'Me@X.com', '--remote-user', 'me@x.com']);
  assert.deepEqual(flags.remoteHosts, ['a.example.ts.net']);
  assert.deepEqual(flags.remoteUsers, ['me@x.com']);
});

test('a comma-separated list is the same as repeating the flag', () => {
  const flags = parseFlags(['--remote-user', 'a@x.com, b@x.com']);
  assert.deepEqual(flags.remoteUsers, ['a@x.com', 'b@x.com']);
});

test('--remote without --remote-user is a refusal to start', () => {
  const refusal = flagsRefusal(parseFlags(['--remote', HOST]));
  assert.match(String(refusal), /needs at least one --remote-user/);
});

test('--remote-user without --remote is a refusal to start', () => {
  assert.match(String(flagsRefusal(parseFlags(['--remote-user', USER]))), /does nothing without/);
});

test('a URL where a hostname belongs is a refusal to start', () => {
  assert.match(String(flagsRefusal(parseFlags(['--remote', 'https://a.example', '--remote-user', USER]))),
    /is not a hostname/);
});

test('coherent flags start', () => {
  assert.equal(flagsRefusal(remote), null);
  assert.equal(flagsRefusal(local), null);
});

/* ------------------------------------------------------------------ *
 * The bind
 *
 * "The console binds to 127.0.0.1, always" is one of this repo's stated
 * invariants, and until now nothing held it: no test in the suite read
 * `flags.host` or passed `--host`, so a merge that changed the default — or
 * that made `--remote` widen the bind "for convenience" — shipped green.
 * ------------------------------------------------------------------ */

const CAPABILITIES = [
  '--allow-run', '--allow-terminal', '--allow-agent',
  '--allow-accounts', '--allow-mcp', '--allow-writes',
];

test('the bind is loopback by default, and --remote does not widen it', () => {
  assert.equal(parseFlags([]).host, '127.0.0.1');
  // The whole point of --remote: an authenticating proxy in FRONT of a console
  // that stays on loopback. If it ever set `host` itself, the identity header
  // would stop being worth anything and this line is what says so.
  assert.equal(parseFlags(['--remote', HOST, '--remote-user', USER]).host, '127.0.0.1');
});

test('a non-loopback --host with a capability flag is a refusal naming --remote', () => {
  for (const flag of CAPABILITIES) {
    const refusal = String(flagsRefusal(parseFlags(['--host', '0.0.0.0', flag])));
    assert.match(refusal, /--host 0\.0\.0\.0/, flag);
    assert.match(refusal, /--remote/, flag);
    assert.match(refusal, new RegExp(flag.replace(/-/g, '\\-')), flag);
  }
});

test('a correctly configured --remote does not excuse a wide bind', () => {
  // --remote's security model IS the narrow bind. Getting the allowlist right
  // does not buy back what binding every interface gave away.
  const refusal = flagsRefusal(parseFlags(['--host', '0.0.0.0', '--remote', HOST, '--remote-user', USER]));
  assert.notEqual(refusal, null);
  assert.match(String(refusal), /--remote/);
});

test('loopback spellings pass, wildcards and real addresses do not', () => {
  // This is the test that catches someone "deduplicating" `isLoopbackHost`
  // against `api/access.ts`'s LOOPBACK set — that one contains '0.0.0.0' and
  // '' for correct Host-HEADER reasons, and as bind addresses both mean every
  // interface, so sharing it would disable the check in the only case it is for.
  for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(flagsRefusal(parseFlags(['--host', host, '--allow-run'])), null, host);
    assert.equal(flagsWarning(parseFlags(['--host', host])), null, host);
  }
  for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.4', 'console.local']) {
    assert.notEqual(flagsRefusal(parseFlags(['--host', host, '--allow-run'])), null, host);
  }
});

test('a wide bind with no capability flag warns rather than refusing', () => {
  // A read-only console in a container has to bind 0.0.0.0 for a published
  // port to reach it. That is legitimate and stays possible — but it is not
  // private, and the operator hears so once at start.
  assert.equal(flagsRefusal(parseFlags(['--host', '0.0.0.0'])), null);
  assert.match(String(flagsWarning(parseFlags(['--host', '0.0.0.0']))), /--remote/);
});

test('--host with an empty value means the operator did not say', () => {
  // `listen(port, '')` binds every interface, so an empty value must not be
  // stored as one — `??` would have kept it, `||` falls back to the default.
  assert.equal(parseFlags(['--host', '']).host, '127.0.0.1');
});

/* ------------------------------------------------------------------ *
 * The wiring: a real server, over HTTP
 * ------------------------------------------------------------------ */

/**
 * `fetch` cannot do this. `Host` is a forbidden header name, so undici drops it
 * without a word — which would make every Host case below silently pass as
 * loopback. The raw client is the only way to say what this test needs to say.
 */
type Reply = { status: number; type: string; body: string };

function http(
  port: number, path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; read?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req_ = request({
      host: '127.0.0.1', port, path,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
    }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '');
      // `/events` never ends. Take the status line and hang up.
      if (!opts.read) { res.destroy(); resolve({ status, type, body: '' }); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, type, body }));
      res.on('error', () => resolve({ status, type, body }));
    });
    req_.on('error', reject);
    req_.end(opts.body);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

test('the gate runs ahead of the API, the event stream and the static files', async (t) => {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, ['--remote', HOST, '--remote-user', USER]);
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const status = async (path: string, headers: Record<string, string> = {}) =>
    (await http(port, path, { headers })).status;

  const allowed = { Host: HOST, 'Tailscale-User-Login': USER };

  // Every surface, not just /api.
  for (const path of ['/api/state', '/events', '/']) {
    assert.equal(await status(path), 200, `${path} from loopback`);
    assert.equal(await status(path, { Host: 'attacker.example' }), 421, `${path} with an unknown Host`);
    assert.equal(await status(path, { Host: HOST }), 403, `${path} with no identity`);
    assert.equal(await status(path, { Host: '127.0.0.1', 'Tailscale-User-Login': USER }), 421,
      `${path} proxied but asking for loopback`);
    assert.equal(await status(path, allowed), 200, `${path} with an allowed identity`);
  }

  // A refusal says why in words, because the alternative is debugging a blank
  // page on a phone.
  const refused = await http(port, '/api/state', { headers: { Host: 'attacker.example' }, read: true });
  assert.match(refused.type, /text\/plain/);
  assert.match(refused.body, /does not answer to/);
});

test('POST /api/prefs and /api/root are not drivable by another page', async (t) => {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port);
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const post = (path: string, headers: Record<string, string> = {}) =>
    http(port, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  // Neither is a capability — both have to work in a read-only console — but
  // neither may be driven from another origin either.
  for (const path of ['/api/prefs', '/api/root']) {
    assert.equal((await post(path)).status, 403, `${path} without the console header`);
    assert.equal((await post(path, { 'x-phase-console': '1', Origin: 'https://evil.example' })).status, 403,
      `${path} from another origin`);
  }
  assert.equal((await post('/api/prefs', { 'x-phase-console': '1' })).status, 200);
});

test('a real console refuses to start on a wide bind with a capability flag', async (t) => {
  // The exit criterion, end to end rather than by unit: `./start --host
  // 0.0.0.0 --allow-run` must REFUSE, and the message must name --remote.
  // `flagsRefusal` runs at module top level, before `configureLog` and before
  // anything listens, so there is no port to collide with and no flake here.
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, ['--host', '0.0.0.0', '--allow-run'], { stdio: 'pipe' });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

  assert.equal(code, 1, `the console must exit non-zero:\n${stderr}`);
  assert.match(stderr, /--host 0\.0\.0\.0/);
  assert.match(stderr, /--remote/);
  assert.match(stderr, /--allow-run/);
});

async function waitFor(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * The served-request record (zero-touch phase 17, FLT-10 / ACC-10.10)
 * ------------------------------------------------------------------ */

test('ACC-10.10: the ledger counts what was SERVED by scope, and logs each remote identity once — hashed', () => {
  const lines: { event: string; detail: Record<string, unknown> }[] = [];
  let firstRemote: string | null = null;
  const ledger = new AccessLedger({
    log: (event, detail) => { lines.push({ event, detail }); },
    onFirstRemote: (at) => { firstRemote = at; },
  });
  const two = parseFlags(['--remote', HOST, '--remote-user', USER, '--remote-user', 'second@example.com']);

  ledger.note(classify(req({ host: '127.0.0.1:4123' }), two), '127.0.0.1:4123', 500);
  ledger.note(classify(req({ host: HOST, 'tailscale-user-login': USER }), two), HOST, 1_000);
  ledger.note(classify(req({ host: HOST, 'tailscale-user-login': USER }), two), HOST, 2_000);
  ledger.note(classify(req({ host: HOST, 'tailscale-user-login': 'second@example.com' }), two), HOST, 3_000);
  // A refusal is not a served request — `access.refused` already records it.
  ledger.note(classify(req({ host: 'attacker.example' }), two), 'attacker.example', 4_000);

  assert.deepEqual(ledger.served, { local: 1, remote: 3 });
  const remoteLines = lines.filter((line) => line.event === 'access.remote');
  assert.equal(remoteLines.length, 2, 'exactly one line per identity per process');
  assert.deepEqual(remoteLines[0]!.detail, {
    host: HOST, loginHash: loginHash(USER), first: new Date(1_000).toISOString(),
    last: new Date(1_000).toISOString(), count: 1,
  });
  assert.ok(!JSON.stringify(lines).includes(USER), 'the login is never logged in clear');
  assert.ok(!JSON.stringify(ledger.snapshot()).includes(USER), 'nor carried on state()');
  assert.equal(firstRemote, new Date(1_000).toISOString(), 'the first remote request lands on the registry at once');
  assert.equal(ledger.lastRemoteAt(), new Date(3_000).toISOString());
  assert.equal(ledger.snapshot().identities.find((i) => i.loginHash === loginHash(USER))?.count, 2);
});

test('ACC-10.10: a real console counts a remote request on state().access and logs its identity exactly once', async (t) => {
  const port = await freePort();
  const box = sandbox('access-ledger');
  const log = join(box.stateHome, 'access-ledger.log');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--remote', HOST, '--remote-user', USER, '--log-file', log], { sandbox: box });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });
  if (!await waitFor(port)) assert.fail('the console did not come up');

  const allowed = { Host: HOST, 'Tailscale-User-Login': USER };
  assert.equal((await http(port, '/api/state', { headers: allowed })).status, 200);
  assert.equal((await http(port, '/api/state', { headers: allowed })).status, 200);

  const state = JSON.parse((await http(port, '/api/state', { read: true })).body) as {
    access?: { served: { local: number; remote: number }; lastRemoteAt: string | null };
  };
  assert.equal(state.access?.served.remote, 2, 'both proxied requests were counted as remote');
  assert.ok((state.access?.served.local ?? 0) >= 1, 'and the local read as local');
  assert.ok(state.access?.lastRemoteAt, 'lastRemoteAt is on the record');

  for (let i = 0; i < 40 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
  const text = readFileSync(log, 'utf8');
  const remote = text.split('\n').filter((line) => line.includes('"access.remote"'));
  assert.equal(remote.length, 1, 'one access.remote line for one identity, however many requests');
  assert.ok(!text.includes(USER), 'no raw login anywhere in the log');
});


