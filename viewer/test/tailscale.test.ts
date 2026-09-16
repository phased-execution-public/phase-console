/**
 * Reading the tailnet.
 *
 * This module's whole job is to be wrong safely. It shells out to a binary
 * that may not exist, to a daemon that may not be running, and hands the
 * result to a settings page — so what is pinned here is mostly the degenerate
 * paths, plus the one hard rule the happy path has to keep: that the CLI's
 * JSON, which contains an `AuthURL` a stranger could join the tailnet with,
 * never reaches the browser.
 *
 * Every fixture is invented. Hostnames, tailnet names and DNS suffixes here
 * are `alpha`/`beta`/`example.ts.net` and nothing from the machine that ran
 * this — writing the real ones down in order to assert about them would BE the
 * leak the scrub looks for.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  tailscaleStatus, resetTailscaleCache, serveCommandFor, httpsPortFor,
  type ServeHandler, type ServeOccupant,
} from '../server/tailscale.ts';
import { beatInstance, markInstanceStopped, registerInstance, removeInstance } from '../shared/instances.mjs';

const PORT = 4123;

/** A status payload shaped like the CLI's, including the parts that must not escape. */
const RUNNING = {
  Version: '1.80.0',
  BackendState: 'Running',
  // Three secrets, one per class: a join URL, a key, and a capability map.
  AuthURL: 'https://login.example.com/a/SUPERSECRETJOINTOKEN',
  HaveNodeKey: true,
  MagicDNSSuffix: 'example.ts.net',
  CurrentTailnet: { Name: 'alpha@example.com', MagicDNSSuffix: 'example.ts.net', MagicDNSEnabled: true },
  Self: {
    HostName: 'alpha',
    DNSName: 'alpha.example.ts.net.',
    OS: 'macOS',
    TailscaleIPs: ['100.64.0.1'],
    Online: true,
    PublicKey: 'nodekey:SUPERSECRETPUBLICKEY',
    CapMap: { 'https://example.com/cap/admin': null },
  },
  Peer: {
    'nodekey:aaa': {
      HostName: 'beta',
      DNSName: 'beta.example.ts.net.',
      OS: 'iOS',
      TailscaleIPs: ['100.64.0.2'],
      Online: true,
      PublicKey: 'nodekey:SUPERSECRETPUBLICKEY',
    },
    'nodekey:bbb': {
      HostName: 'gamma',
      DNSName: 'gamma.example.ts.net.',
      OS: 'windows',
      TailscaleIPs: ['100.64.0.3'],
      Online: false,
      LastSeen: '2026-06-01T10:00:00Z',
    },
  },
};

const SERVED = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } },
};

/**
 * A stand-in `tailscale` that answers the two subcommands this module calls.
 *
 * It also appends a line per invocation, which is how the cache is proved: the
 * only honest evidence that a second call did not shell out is that the binary
 * did not run.
 */
function fakeCli(options: {
  status?: unknown; serve?: unknown; exit?: number; stderr?: string;
  /** Refuse to answer without a TERM, exactly as the macOS app's shim does. */
  requireTerm?: boolean;
}): {
  bin: string; calls: () => string[]; cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tailscale-'));
  const bin = join(dir, 'tailscale');
  const calls = join(dir, 'calls.log');

  const emit = (value: unknown) => (value === undefined ? '' : JSON.stringify(value));

  writeFileSync(bin, `#!/usr/bin/env bash
echo "$1 $2" >> ${JSON.stringify(calls)}
${options.requireTerm
    ? 'if [ -z "${TERM:-}" ]; then echo "The Tailscale GUI failed to start"; exit 0; fi'
    : ''}
if [ "$1" = "serve" ]; then
  cat <<'SERVE_EOF'
${emit(options.serve)}
SERVE_EOF
  exit 0
fi
${options.stderr ? `echo ${JSON.stringify(options.stderr)} >&2` : ''}
cat <<'STATUS_EOF'
${emit(options.status)}
STATUS_EOF
exit ${options.exit ?? 0}
`, 'utf8');
  chmodSync(bin, 0o755);

  return {
    bin,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Point the module at a binary for one probe, with the memo cleared either side. */
// The fixtures fork a bash script per probe, and under a full parallel run that
// has been measured at 2.2s of the product's 3s budget — so whichever tailscale
// test ran while the machine was busiest failed on a timeout that says nothing
// about the code. Production keeps three seconds; this suite stops depending on
// how loaded the host is.
process.env.PHASE_CONSOLE_TAILSCALE_TIMEOUT_MS = '30000';

async function probeWith(bin: string, port = PORT) {
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = bin;
  resetTailscaleCache();
  try {
    return await tailscaleStatus(port);
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
  }
}

test('no binary at all reads as not-installed, not as an error', async () => {
  const status = await probeWith(join(tmpdir(), 'pc-tailscale-does-not-exist', 'tailscale'));
  assert.deepEqual(status, { state: 'not-installed' });
});

test('signed out is installed-not-running, and says which state in the CLI\'s own words', async () => {
  const cli = fakeCli({ status: { BackendState: 'NeedsLogin' } });
  try {
    const status = await probeWith(cli.bin);
    assert.deepEqual(status, { state: 'installed-not-running', detail: 'NeedsLogin' });
  } finally { cli.cleanup(); }
});

test('a daemon that answers nothing is installed-not-running, and its stderr is not repeated', async () => {
  // The real message names a local socket path; this asserts we say our own
  // sentence rather than passing the CLI's through to a web page.
  const cli = fakeCli({ exit: 1, stderr: 'failed to connect to local tailscaled at /var/run/tailscale/x.sock' });
  try {
    const status = await probeWith(cli.bin);
    assert.equal(status.state, 'installed-not-running');
    const detail = 'detail' in status ? status.detail ?? '' : '';
    assert.match(detail, /daemon is not responding/);
    assert.doesNotMatch(detail, /sock|tailscaled/);
  } finally { cli.cleanup(); }
});

test('a running tailnet reports its devices, newest facts first', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    assert.equal(status.state, 'running');
    if (status.state !== 'running') return;

    assert.equal(status.tailnet, 'alpha@example.com');
    assert.equal(status.magicDns, true);
    assert.equal(status.magicDnsSuffix, 'example.ts.net');

    // The trailing dot on a DNSName is a wire detail, not something to render.
    assert.equal(status.self.dnsName, 'alpha.example.ts.net');
    assert.deepEqual(status.self.ips, ['100.64.0.1']);

    // Online first, so the devices you could actually open this on lead.
    assert.deepEqual(status.peers.map((p) => p.hostName), ['beta', 'gamma']);
    assert.equal(status.peers[0].online, true);
    assert.equal(status.peers[0].os, 'iOS');
  } finally { cli.cleanup(); }
});

test('last-seen is carried only for a device that is offline', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    // An online device with a "last seen" timestamp reads as staleness that is
    // not there.
    assert.equal(status.peers[0].lastSeen, undefined);
    assert.equal(status.peers[1].lastSeen, '2026-06-01T10:00:00Z');
  } finally { cli.cleanup(); }
});

test('nothing from the CLI survives that was not asked for by name', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    const wire = JSON.stringify(status);
    // The join URL is the sharp one: it is a credential in a query string.
    assert.doesNotMatch(wire, /SUPERSECRETJOINTOKEN/);
    assert.doesNotMatch(wire, /SUPERSECRETPUBLICKEY/);
    assert.doesNotMatch(wire, /AuthURL|PublicKey|CapMap|HaveNodeKey/);
  } finally { cli.cleanup(); }
});

test('serve pointed at this console yields the URL that reaches it', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, {
      active: true, forOurPort: true, url: 'https://alpha.example.ts.net', targetPort: PORT,
      handlers: [{ host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: PORT, ours: true }],
      // The command that publishes this console has already been run.
      command: null,
    });
  } finally { cli.cleanup(); }
});

test('every spelling of loopback the CLI accepts still counts as this console', async () => {
  for (const proxy of [
    `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
    `http://127.0.0.1:${PORT}/`, `https+insecure://localhost:${PORT}`, `localhost:${PORT}`,
    // The bare port the CLI itself expands to loopback.
    `${PORT}`,
  ]) {
    const cli = fakeCli({
      status: RUNNING,
      serve: { Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } },
    });
    try {
      const status = await probeWith(cli.bin);
      if (status.state !== 'running') return assert.fail('expected running');
      assert.equal(status.serve.forOurPort, true, `${proxy} should read as this console`);
    } finally { cli.cleanup(); }
  }
});

test('serving a different port is its own state, not "not serving"', async () => {
  // Collapsing this into inactive would tell someone to run a serve command
  // that is already running.
  const cli = fakeCli({
    status: RUNNING,
    serve: { Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
  });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, {
      active: true,
      forOurPort: false,
      targetPort: 9999,
      // No registered console claims 9999: the port is named and nothing is invented for it.
      occupant: { port: 9999 },
      handlers: [{
        host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: 9999, ours: false,
        occupant: { port: 9999 },
      }],
      // Nobody LIVE holds 443, so the natural command stands.
      command: { httpsPort: 443, text: `tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`, displaces: null },
    });
  } finally { cli.cleanup(); }
});

test('no serve configured is inactive, with no URL invented for it', async () => {
  const cli = fakeCli({ status: RUNNING, serve: {} });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve, {
      active: false, forOurPort: false, handlers: [],
      command: { httpsPort: 443, text: `tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`, displaces: null },
    });
  } finally { cli.cleanup(); }
});

/* ---------------- one tailnet name, one Serve table ----------------
 * Every console on a machine publishes into the same table. A handler that is
 * not ours is usually a sibling, and the card used to be able to say only
 * "something else" — while printing the command that took the phone away from
 * whichever live sibling held the port. */

const SIBLING_PORT = 4999;

const SERVED_SIBLING = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${SIBLING_PORT}` } } } },
};

/**
 * A registered console named `beta` on `SIBLING_PORT`, heartbeating now.
 *
 * Its root is a real directory: a row whose root is gone is `orphaned`, which
 * is a different answer. The registry is the sandbox's (`state-sandbox.ts`
 * points `XDG_CONFIG_HOME` at a temp dir), and `cleanup` takes the row out again
 * so no other case meets a console it did not register.
 */
function sibling(): { id: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-tailscale-sibling-'));
  const row = registerInstance(root, { name: 'beta', port: SIBLING_PORT });
  assert.ok(row?.id, 'the sandbox registry must accept the row');
  beatInstance(row.id, {});
  return {
    id: row.id,
    cleanup: () => {
      removeInstance(row.id);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a handler pointing at a different loopback port carries that port', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED_SIBLING });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.equal(status.serve.forOurPort, false);
    assert.equal(status.serve.targetPort, SIBLING_PORT, 'the target used to be thrown away');
    assert.equal(status.serve.handlers[0].targetPort, SIBLING_PORT);
    assert.equal(status.serve.url, undefined, "a URL is only ever this console's");
  } finally { cli.cleanup(); }
});

test('a registered sibling is named, and a command that would displace it while it runs is refused', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED_SIBLING });
  const beta = sibling();
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    const occupant = { port: SIBLING_PORT, id: beta.id, name: 'beta', liveness: 'running' };
    assert.deepEqual(status.serve.occupant, occupant);
    assert.deepEqual(status.serve.handlers[0].occupant, occupant);
    // 443 is this default console's natural port, and beta is live on it:
    // printing that line would take the phone from beta. 8123 is offered, and
    // the refusal names what it protects.
    assert.deepEqual(status.serve.command, {
      httpsPort: 8123,
      text: `tailscale serve --bg --https=8123 http://127.0.0.1:${PORT}`,
      displaces: { httpsPort: 443, occupant },
    });
  } finally {
    beta.cleanup();
    cli.cleanup();
  }
});

test('a sibling that is not running is still named, but not protected — the natural command stands', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED_SIBLING });
  const beta = sibling();
  try {
    // A clean exit after the beat: the console said itself that it stopped.
    markInstanceStopped(beta.id);
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.equal(status.serve.occupant?.name, 'beta');
    assert.equal(status.serve.occupant?.liveness, 'stopped');
    assert.equal(status.serve.command?.displaces, null);
    assert.equal(status.serve.command?.httpsPort, 443);
    assert.equal(status.serve.command?.text, `tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`);
  } finally {
    beta.cleanup();
    cli.cleanup();
  }
});

test('the whole table is read — every handler, whatever it points at — and only the named fields survive', async () => {
  const cli = fakeCli({
    status: RUNNING,
    serve: {
      TCP: { 443: { HTTPS: true }, 8130: { HTTPS: true } },
      Web: {
        'alpha.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://192.0.2.10:8080' } } },
        'alpha.example.ts.net:8130': {
          Handlers: { '/': { Proxy: '4130' }, '/files': { Path: '/srv/SUPERSECRETSERVEPATH' } },
        },
      },
      AllowFunnel: { 'alpha.example.ts.net:443': true },
    },
  });
  try {
    const status = await probeWith(cli.bin);
    if (status.state !== 'running') return assert.fail('expected running');
    assert.deepEqual(status.serve.handlers, [
      // Off the machine: no console here can be behind it, so nobody is named.
      { host: 'alpha.example.ts.net', httpsPort: 443, path: '/', targetPort: null, ours: false },
      { host: 'alpha.example.ts.net', httpsPort: 8130, path: '/', targetPort: 4130, ours: false, occupant: { port: 4130 } },
      { host: 'alpha.example.ts.net', httpsPort: 8130, path: '/files', targetPort: null, ours: false },
    ]);
    // The phone opening the bare URL reaches `/` on 443, which has no loopback port to carry.
    assert.equal(status.serve.active, true);
    assert.equal(status.serve.targetPort, undefined);
    assert.equal(status.serve.occupant, undefined);
    // The proxy strings, the file path and the funnel map are the CLI's, not the card's.
    assert.doesNotMatch(JSON.stringify(status), /192\.0\.2\.10|SUPERSECRETSERVEPATH|AllowFunnel|Proxy/);
  } finally { cli.cleanup(); }
});

test('httpsPortFor: 443 for the default console port, 4000 + the port for every other', () => {
  // The same rows `client/src/features/settings/tailscale.test.tsx` pins on the
  // card's import-free fallback copy — one behaviour, held from both sides.
  assert.equal(httpsPortFor(4123), 443);
  assert.equal(httpsPortFor(4130), 8130);
  assert.equal(httpsPortFor(5000), 9000);
});

test('serveCommandFor: the natural port unless a LIVE sibling holds it, and nothing once this console is served', () => {
  const at = (httpsPort: number, targetPort: number | null, occupant?: ServeOccupant): ServeHandler => ({
    host: 'alpha.example.ts.net', httpsPort, path: '/', targetPort, ours: targetPort === PORT,
    ...(occupant ? { occupant } : {}),
  });
  const beta: ServeOccupant = { port: 4130, id: 'aaaaaaaa-beta', name: 'beta', liveness: 'running' };

  // Nothing served: the default console keeps 443, every other takes 4000 + its port.
  assert.deepEqual(serveCommandFor(4123, []), {
    httpsPort: 443, text: 'tailscale serve --bg --https=443 http://127.0.0.1:4123', displaces: null,
  });
  assert.deepEqual(serveCommandFor(4130, []), {
    httpsPort: 8130, text: 'tailscale serve --bg --https=8130 http://127.0.0.1:4130', displaces: null,
  });

  // Already served — on whatever https port — leaves nothing to run.
  assert.equal(serveCommandFor(PORT, [at(443, PORT)]), null);
  assert.equal(serveCommandFor(PORT, [at(443, 4130, beta), at(8123, PORT)]), null);

  // A live sibling on the natural port: refused, 4000 + the port offered, the occupant named.
  assert.deepEqual(serveCommandFor(PORT, [at(443, 4130, beta)]), {
    httpsPort: 8123,
    text: 'tailscale serve --bg --https=8123 http://127.0.0.1:4123',
    displaces: { httpsPort: 443, occupant: beta },
  });
  // ...or the first port above it that no handler holds, whatever holds it.
  assert.equal(serveCommandFor(PORT, [at(443, 4130, beta), at(8123, 9999, { port: 9999 }), at(8124, null)])?.httpsPort, 8125);

  // A non-default console whose own derived port a live sibling took: the next one up.
  const taken = serveCommandFor(4130, [at(8130, 4131, { ...beta, port: 4131 })]);
  assert.equal(taken?.httpsPort, 8131);
  assert.equal(taken?.displaces?.httpsPort, 8130);

  // Not live is not displaced: a stopped, orphaned or never-heartbeated console, or no console at all.
  const notLive: ServeOccupant[] = [
    { ...beta, liveness: 'stopped' }, { ...beta, liveness: 'orphaned' }, { ...beta, liveness: 'unknown' }, { port: 4130 },
  ];
  for (const occupant of notLive) {
    assert.deepEqual(serveCommandFor(PORT, [at(443, 4130, occupant)]), {
      httpsPort: 443, text: 'tailscale serve --bg --https=443 http://127.0.0.1:4123', displaces: null,
    }, `${occupant.liveness ?? 'no console'} is not protected`);
  }
  // A handler that is not a loopback proxy has no console behind it to protect.
  assert.equal(serveCommandFor(PORT, [at(443, null)])?.displaces, null);
});

test('a second read inside the window does not shell out again', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = cli.bin;
  resetTailscaleCache();
  try {
    await tailscaleStatus(PORT);
    const afterFirst = cli.calls().length;
    assert.ok(afterFirst > 0, 'the first read must actually run the CLI');

    await tailscaleStatus(PORT);
    assert.equal(cli.calls().length, afterFirst, 'the second read must come from the memo');

    // A different port is a different question and must not be answered from
    // the memo of the first one.
    await tailscaleStatus(9999);
    assert.ok(cli.calls().length > afterFirst, 'another port must re-probe');
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
    cli.cleanup();
  }
});

test('the CLI is given a TERM even when this process has none', async () => {
  /*
   * The bug this pins cost a live console its tailnet card.
   *
   * The macOS app's `tailscale` is a shim in front of the GUI. With no `TERM`
   * it decides it was double-clicked, tries to open the app, and prints
   * "The Tailscale GUI failed to start" instead of JSON — so the probe reported
   * `installed-not-running` on a machine where Tailscale was plainly running.
   * Every shell sets `TERM`, which is why it passed everywhere except under
   * launchd, the one place the console actually runs.
   *
   * So the fixture refuses to answer without one, and the assertion is simply
   * that we still get a reading with `TERM` deleted from this process.
   */
  const cli = fakeCli({ status: RUNNING, serve: SERVED, requireTerm: true });
  const saved = process.env.TERM;
  delete process.env.TERM;
  try {
    const status = await probeWith(cli.bin);
    assert.equal(status.state, 'running', 'the probe must hand the CLI a TERM of its own');
  } finally {
    if (saved === undefined) delete process.env.TERM; else process.env.TERM = saved;
    cli.cleanup();
  }
});

test('a named binary that is missing is not silently replaced by another one', async () => {
  // The fallback search exists for the macOS app bundle; it must not run when
  // someone has said exactly which binary to use.
  const status = await probeWith('/nonexistent/tailscale');
  assert.deepEqual(status, { state: 'not-installed' });
});

/* ---------------- the route ----------------
 * Through the real `handleApi`, because the thing worth pinning is that the
 * endpoint answers at all and asks about the console's OWN port — a probe
 * against the wrong port reports a working setup as a mismatch. */

const { handleApi } = await import('../server/api/routes.ts');

async function get(path: string, port: number) {
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const req = {
    method: 'GET',
    headers: { host: `127.0.0.1:${port}` },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {},
  };
  const service = { flags: { allowWrites: false, allowRun: false, scriptsDir: '/x', port } };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:${port}${path}`));
  return { status, payload };
}

test('GET /api/tailscale answers with the status for this console\'s port', async () => {
  const cli = fakeCli({ status: RUNNING, serve: SERVED });
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = cli.bin;
  resetTailscaleCache();
  try {
    const ok = await get('/api/tailscale', PORT);
    assert.equal(ok.status, 200);
    assert.equal((ok.payload as { state: string }).state, 'running');
    assert.equal((ok.payload as { serve: { forOurPort: boolean } }).serve.forOurPort, true);

    // Same tailnet, console on another port: the serve entry is no longer ours.
    resetTailscaleCache();
    const other = await get('/api/tailscale', 9999);
    assert.equal((other.payload as { serve: { forOurPort: boolean } }).serve.forOurPort, false);
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
    cli.cleanup();
  }
});

test('a machine with no Tailscale still answers 200, so the card can say so', async () => {
  process.env.PHASE_CONSOLE_TAILSCALE_BIN = '/nonexistent/tailscale';
  resetTailscaleCache();
  try {
    const { status, payload } = await get('/api/tailscale', PORT);
    assert.equal(status, 200, 'not-installed is an answer, not an error');
    assert.deepEqual(payload, { state: 'not-installed' });
  } finally {
    delete process.env.PHASE_CONSOLE_TAILSCALE_BIN;
    resetTailscaleCache();
  }
});
