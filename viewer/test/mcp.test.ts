/**
 * The MCP registry, its secrets, the health probe, and the redaction boundary.
 *
 * The properties that matter: a registered server survives a restart with
 * owner-only modes; a secret NEVER appears in anything `list()` or the config
 * preview hands out; the credential layer talks to a keychain only through the
 * injected exec (tests and CI must never touch a real one); the probe reads the
 * CLI's `system/init` event and reports one row per server we ASKED about, so a
 * silently dropped server is `failed` rather than absent; and the two security
 * checks — the rug-pull fingerprint and the URL-carries-a-credential refusal —
 * actually fire.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// MCP dir is a module-level const off INSTANCE_STATE_DIR.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KEYCHAIN_STORE_FAILED, type Exec } from '../server/accounts/credentials.ts';
import {
  buildMcpConfig, dropMcpConfigsFor, pruneMcpConfigs, redactConfig, writeMcpConfigFile,
} from '../server/mcp/config.ts';
import { McpCredentials, mcpKeychainService } from '../server/mcp/credentials.ts';
import { blocksBoarding, probeMcp } from '../server/mcp/health.ts';
import { Mcp } from '../server/mcp/index.ts';
import { CURATED, searchCatalog, searchCurated } from '../server/mcp/catalog.ts';
import { McpStore, MCP_DIR, normaliseTransport } from '../server/mcp/store.ts';

/** An exec that records every invocation and answers from a script. */
function fakeExec(
  answers: (file: string, args: string[], input?: string) => string | Error = () => '',
) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    const answer = answers(file, args, opts?.input);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { exec, calls };
}

/** A keychain that actually remembers, so store→read round-trips are testable. */
function keychainExec() {
  const held = new Map<string, string>();
  const { exec, calls } = fakeExec((file, args, input) => {
    if (file !== 'security') return '';
    const service = args[args.indexOf('-s') + 1];
    if (args[0] === 'add-generic-password') {
      // Exactly what the real `security` does with a valueless `-w`: prompt,
      // read a line, prompt again, read a second, and store it only if the two
      // match. Modelled rather than simplified — feeding the value ONCE is a
      // real failure mode (`security` then stores an empty secret and exits 0),
      // and a fake that accepted one copy would hide it.
      const [first, second] = (input ?? '').split('\n');
      if (first === undefined || first !== second) return new Error('passwords don\'t match');
      held.set(service, first);
      return '';
    }
    if (args[0] === 'dump-keychain') {
      return [...held.keys()].map((svce) => `    "svce"<blob>="${svce}"`).join('\n');
    }
    if (args[0] === 'find-generic-password') {
      const value = held.get(service);
      return value === undefined ? new Error('not found') : value;
    }
    if (args[0] === 'delete-generic-password') {
      if (!held.delete(service)) return new Error('not found');
      return '';
    }
    return '';
  });
  return { exec, calls, held };
}

/* ---------------- store ---------------- */

test('a registered server survives a restart, owner-only', () => {
  const store = new McpStore();
  store.add({ id: 'ctx7', transport: 'http', label: 'Context7', url: 'https://mcp.context7.com/mcp', createdAt: 'x' });

  const reopened = new McpStore();
  const found = reopened.get('ctx7');
  assert.equal(found?.url, 'https://mcp.context7.com/mcp');

  const file = join(MCP_DIR, 'servers.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(MCP_DIR).mode & 0o777, 0o700);

  reopened.remove('ctx7');
});

test('an id that is reserved, malformed or already taken is refused', () => {
  const store = new McpStore();
  store.add({ id: 'taken', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' });
  assert.throws(() => store.add({ id: 'taken', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /already exists/);
  assert.throws(() => store.add({ id: 'Has Caps', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /not usable/);
  assert.throws(() => store.add({ id: 'workspace', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' }), /reserved/);
  store.remove('taken');
});

test('disabling a server keeps its configuration but takes it out of the attachable set', () => {
  const store = new McpStore();
  store.add({ id: 'off-me', transport: 'stdio', command: 'npx', createdAt: 'x' });
  assert.ok(store.enabledIds().includes('off-me'));

  store.setEnabled('off-me', false);
  assert.ok(!store.enabledIds().includes('off-me'));
  assert.ok(new McpStore().get('off-me'), 'the row itself is still there');
  assert.equal(new McpStore().isEnabled('off-me'), false, 'and the choice survived a restart');

  store.remove('off-me');
});

test('a first tool list is not a change; a different one is', () => {
  const store = new McpStore();
  store.add({ id: 'drifty', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' });

  assert.equal(store.noteTools('drifty', ['read', 'write']).changed, false, 'first observation');
  assert.equal(store.noteTools('drifty', ['write', 'read']).changed, false, 'order is not a change');

  const drift = store.noteTools('drifty', ['read', 'write', 'exfiltrate']);
  assert.equal(drift.changed, true);
  assert.deepEqual(drift.before, ['read', 'write']);

  store.remove('drifty');
});

test('streamable-http is accepted as the alias the MCP spec uses', () => {
  assert.equal(normaliseTransport('streamable-http'), 'http');
  assert.equal(normaliseTransport('HTTP'), 'http');
  assert.equal(normaliseTransport('carrier-pigeon'), undefined);
});

/* ---------------- credentials ---------------- */

test('a secret round-trips through the keychain and never through the registry file', async () => {
  const { exec, calls } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const ref = { kind: 'header' as const, name: 'Authorization', template: 'Bearer {}' };

  await creds.store('gh', ref, 'ghp_supersecret');
  assert.equal(await creds.read('gh', ref), 'ghp_supersecret');
  assert.equal(await creds.has('gh', ref), true);

  assert.ok(calls.every((call) => call.file === 'security'), 'only the keychain was consulted');
  const service = mcpKeychainService('gh', 'header:Authorization');
  assert.ok(service.startsWith('phase-console-mcp-'), 'our own service namespace, not the CLI’s');
  assert.ok(!service.includes('Claude Code-credentials'));

  const registry = existsSync(join(MCP_DIR, 'servers.json'))
    ? readFileSync(join(MCP_DIR, 'servers.json'), 'utf8')
    : '';
  assert.ok(!registry.includes('ghp_supersecret'), 'the registry never holds the secret');

  await creds.delete('gh', ref);
  assert.equal(await creds.read('gh', ref), null);
});

test('off darwin, secrets land in a 0600 file and nowhere else', async () => {
  const { exec, calls } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const ref = { kind: 'env' as const, name: 'API_KEY' };

  await creds.store('linuxy', ref, 'sk-test');
  assert.equal(await creds.read('linuxy', ref), 'sk-test');
  assert.equal(calls.length, 0, 'no process was spawned');
  assert.equal(statSync(join(MCP_DIR, 'linuxy', 'secrets.json')).mode & 0o777, 0o600);

  await creds.delete('linuxy', ref);
  assert.equal(existsSync(join(MCP_DIR, 'linuxy', 'secrets.json')), false, 'the last secret takes the file with it');
});

/* ---------------- config ---------------- */

test('secrets are spliced into the config, and the preview masks them', async () => {
  const { exec } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const ref = { kind: 'header' as const, name: 'Authorization', template: 'Bearer {}' };
  await creds.store('gh', ref, 'ghp_tok');

  const doc = await buildMcpConfig([{
    id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    secretRefs: [ref], createdAt: 'x',
  }], creds);

  assert.equal(doc.mcpServers.gh.headers?.Authorization, 'Bearer ghp_tok');
  assert.equal(doc.mcpServers.gh.type, 'http');

  const masked = redactConfig(doc);
  assert.equal(masked.mcpServers.gh.headers?.Authorization, '••••••');
  assert.ok(!JSON.stringify(masked).includes('ghp_tok'));
});

test('a ${VAR} reference stays legible — it is the name of a secret, not one', async () => {
  const { exec } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const doc = await buildMcpConfig([{
    id: 'db', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'],
    env: { DATABASE_URL: '${DATABASE_URL}' }, createdAt: 'x',
  }], creds);

  // Passed through unexpanded: the CLI expands it in the child's environment,
  // which is the whole reason to write it that way.
  assert.equal(doc.mcpServers.db.env?.DATABASE_URL, '${DATABASE_URL}');
  assert.equal(redactConfig(doc).mcpServers.db.env?.DATABASE_URL, '${DATABASE_URL}');
});

test('a ref with no stored secret is omitted rather than written empty', async () => {
  const { exec } = fakeExec(() => new Error('not found'));
  const creds = new McpCredentials(exec, 'darwin');
  const doc = await buildMcpConfig([{
    id: 'gh', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }], createdAt: 'x',
  }], creds);

  // An absent header fails with a 401 the console classifies as "needs
  // authentication"; an empty one is a malformed request reported as something else.
  assert.equal(doc.mcpServers.gh.headers, undefined);
});

test('the written config is 0600, and an empty set writes no file at all', () => {
  const path = writeMcpConfigFile('abcd1234', 3, { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } });
  assert.ok(path);
  assert.equal(statSync(path!).mode & 0o777, 0o600);
  assert.equal(writeMcpConfigFile('empty', 1, { mcpServers: {} }), null);
});

test('a per-server timeout below the CLI’s floor is dropped, not silently ignored', async () => {
  const { exec } = fakeExec();
  const creds = new McpCredentials(exec, 'linux');
  const doc = await buildMcpConfig([
    { id: 'slow', transport: 'http', url: 'https://e.com/mcp', timeoutMs: 600_000, createdAt: 'x' },
    { id: 'tiny', transport: 'http', url: 'https://e.com/mcp', timeoutMs: 200, createdAt: 'x' },
  ], creds);
  assert.equal(doc.mcpServers.slow.timeout, 600_000);
  assert.equal(doc.mcpServers.tiny.timeout, undefined, 'under 1000 the CLI ignores it anyway');
});

/* ---------------- health probe ---------------- */

/** A child process that emits one canned stdout payload then closes. */
function fakeSpawn(lines: string[], opts: { closeCode?: number } = {}) {
  const seen: { argv: string[] }[] = [];
  const spawnFn = ((_file: string, argv: string[]) => {
    seen.push({ argv });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      if (!lines.length) child.emit('close', opts.closeCode ?? 1);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, seen };
}

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  tools: ['Read', 'mcp__ctx7__query-docs', 'mcp__ctx7__resolve-library-id', 'mcp__gh__list_prs'],
  mcp_servers: [
    { name: 'ctx7', status: 'connected' },
    { name: 'gh', status: 'needs-auth' },
  ],
});

test('the probe reads system/init and reports status plus tools per server', async () => {
  const { spawnFn, seen } = fakeSpawn([INIT]);
  const probe = await probeMcp(
    { mcpServers: { ctx7: { type: 'http', url: 'https://a' }, gh: { type: 'http', url: 'https://b' } } },
    { spawnFn },
  );

  assert.equal(probe.probeError, undefined);
  assert.deepEqual(probe.servers.map((row) => [row.id, row.status]), [['ctx7', 'connected'], ['gh', 'needs-auth']]);
  assert.deepEqual(probe.servers[0].tools, ['query-docs', 'resolve-library-id']);

  // The set under test must be the only set, or the answer is about the wrong thing.
  assert.ok(seen[0].argv.includes('--strict-mcp-config'));
  assert.ok(seen[0].argv.includes('--mcp-config'));
  assert.deepEqual(seen[0].argv.slice(seen[0].argv.indexOf('--max-turns'), seen[0].argv.indexOf('--max-turns') + 2),
    ['--max-turns', '1'], 'one turn: the probe pays for a connect, never a thought');
});

test('a server the CLI dropped is failed, not absent', async () => {
  const { spawnFn } = fakeSpawn([JSON.stringify({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'good', status: 'connected' }],
    mcp_server_errors: [{ name: 'bad', type: 'url_missing_type', message: 'Skipped — no "type"' }],
  })]);

  const probe = await probeMcp(
    { mcpServers: { good: { type: 'http', url: 'https://a' }, bad: { type: 'http', url: 'https://b' }, vanished: { type: 'http', url: 'https://c' } } },
    { spawnFn },
  );

  const byId = Object.fromEntries(probe.servers.map((row) => [row.id, row]));
  assert.equal(byId.bad.status, 'failed');
  assert.match(byId.bad.error?.message ?? '', /Skipped/);
  assert.equal(byId.vanished.status, 'failed', 'silence is not consent');
});

test('a probe that cannot run says so instead of condemning the servers', async () => {
  const { spawnFn } = fakeSpawn([], { closeCode: 127 });
  const probe = await probeMcp({ mcpServers: { a: { type: 'http', url: 'https://a' } } }, { spawnFn });
  assert.match(probe.probeError ?? '', /before reporting server status/);
  assert.deepEqual(probe.servers, []);
});

test('pending never blocks boarding; a wall does', () => {
  assert.equal(blocksBoarding('pending'), false, 'a cached remote connects on first use');
  assert.equal(blocksBoarding('connected'), false);
  assert.equal(blocksBoarding('needs-auth'), true);
  assert.equal(blocksBoarding('failed'), true);
});

/* ---------------- the facade ---------------- */

function facade(lines: string[] = [INIT]) {
  const { exec } = keychainExec();
  const { spawnFn } = fakeSpawn(lines);
  return new Mcp({
    exec,
    platform: 'darwin',
    probeFn: (doc, opts) => probeMcp(doc, { ...opts, spawnFn }),
  });
}

test('a view carries no secret and no filesystem path', async () => {
  const mcp = facade();
  await mcp.add({
    label: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }],
    secrets: { 'header:Authorization': 'ghp_secret' },
  });

  const views = await mcp.list();
  const serialised = JSON.stringify(views);
  assert.ok(!serialised.includes('ghp_secret'), 'the secret never leaves');
  assert.ok(!serialised.includes(MCP_DIR), 'nor does a path on this machine');
  assert.deepEqual(views[0].auth, { kind: 'header', secrets: [{ ref: 'header:Authorization', held: true }] });

  await mcp.remove('github');
});

test('a URL carrying its own credential is refused, with the fix named', async () => {
  const mcp = facade();
  await assert.rejects(
    () => mcp.add({ label: 'Sneaky', transport: 'http', url: 'https://e.com/mcp?token=abc123' }),
    /add it as a header instead/,
  );
  await assert.rejects(
    () => mcp.add({ label: 'Sneaky', transport: 'http', url: 'https://someone:hunter2@example.com/mcp' }),
    /put credentials in a header/,
  );
  await assert.rejects(
    () => mcp.add({ label: 'Plain', transport: 'http', url: 'http://example.com/mcp' }),
    /must be https/,
  );
  // localhost is the exception: a server you are developing has no certificate.
  const local = await mcp.add({ label: 'Local', transport: 'http', url: 'http://localhost:9999/mcp' });
  assert.equal(local.id, 'local');
  await mcp.remove('local');
});

test('resolve() reports unknown and disabled ids instead of quietly dropping them', async () => {
  const mcp = facade();
  await mcp.add({ label: 'Alpha', transport: 'stdio', command: 'npx' });
  await mcp.add({ label: 'Beta', transport: 'stdio', command: 'npx' });
  mcp.setEnabled('beta', false);

  const resolved = mcp.resolve(['alpha', 'beta', 'ghost']);
  assert.deepEqual(resolved.servers.map((s) => s.id), ['alpha']);
  assert.deepEqual(resolved.disabled, ['beta']);
  assert.deepEqual(resolved.unknown, ['ghost']);

  await mcp.remove('alpha');
  await mcp.remove('beta');
});

test('preflight blocks on a server that needs authentication, and names it', async () => {
  const mcp = facade();
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  await mcp.add({ label: 'gh', id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' });

  const result = await mcp.preflight(['ctx7', 'gh']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map((row) => row.id), ['gh']);
  assert.equal(result.blocking[0].status, 'needs-auth');

  await mcp.remove('ctx7');
  await mcp.remove('gh');
});

test('preflight refuses a plan naming a server this machine does not have', async () => {
  const mcp = facade();
  const result = await mcp.preflight(['nope']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ['nope']);
});

test('an unresolvable id no longer hides a signed-out one behind it', async () => {
  // This used to short-circuit before the probe, so a phase naming one ghost
  // and one signed-out server reported the ghost, and only learned about the
  // sign-in after somebody had fixed the first — one whole boarding per
  // problem. One answer now, naming everything wrong with the set.
  const mcp = facade();
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  await mcp.add({ label: 'gh', id: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' });
  await mcp.add({ label: 'Off', id: 'off', transport: 'stdio', command: 'npx' });
  mcp.setEnabled('off', false);

  const result = await mcp.preflight(['ctx7', 'gh', 'off', 'ghost']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ['ghost']);
  assert.deepEqual(result.disabled, ['off']);
  assert.deepEqual(result.blocking.map((row) => row.id), ['gh'], 'the probe still ran');

  await mcp.remove('ctx7');
  await mcp.remove('gh');
  await mcp.remove('off');
});

test('a server whose ${VAR} was never filled in says so, instead of "will not connect"', async () => {
  // The catalog's filesystem entry ships as `… server-filesystem ${MCP_FS_ROOT}`
  // with an authNote asking for a value, and nothing ever collected one. The
  // CLI expands the unset variable to nothing, the server starts without a
  // root, and it probes `failed` forever — which reads as a flaky remote rather
  // than as the unfinished registration it is. One was attached to a real run
  // and blocked three phases at boarding.
  const mcp = facade([JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'fs', status: 'failed' }],
  })]);
  await mcp.add({
    label: 'Filesystem', id: 'fs', transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'],
  });

  const view = (await mcp.list()).find((s) => s.id === 'fs');
  assert.deepEqual(view?.needsConfig, ['MCP_FS_ROOT'], 'the view names the outstanding variable');

  // It is never PROBED at all now, which is the stronger form of the same
  // answer: a server that cannot connect is not a server whose connection
  // failed. It comes back in its own bucket, naming the variable — the errand —
  // rather than as a `blocking` row carrying the CLI's verdict on a question it
  // was never sensible to ask.
  const result = await mcp.preflight(['fs']);
  assert.equal(result.ok, false, 'an unfinished registration still stops the set');
  assert.deepEqual(result.unconfigured, [{ id: 'fs', missing: ['MCP_FS_ROOT'] }]);
  assert.deepEqual(result.blocking, [], 'nothing was asked of it, so nothing failed');
  assert.deepEqual(result.unknown, [], 'it is registered — that is not the problem');
  assert.deepEqual(result.disabled, [], 'and nobody switched it off either');

  // …and it is not attachable, so a plan naming it warns at lint time (F15)
  // instead of resolving to a server that would have failed at boarding.
  assert.ok(!mcp.enabledIds().includes('fs'), 'unattachable, and F15 is told so');
  assert.ok(mcp.isEnabled('fs'), 'but still switched on — this is not a disablement');

  await mcp.remove('fs');
});

test('a ${VAR} something actually supplies is not an outstanding errand', async () => {
  const mcp = facade();
  await mcp.add({
    label: 'Rooted', id: 'rooted', transport: 'stdio',
    command: 'npx', args: ['-y', 'server', '${ROOT_DIR}'], env: { ROOT_DIR: '/srv' },
  });
  // A default in the reference supplies its own value, so it is settled too.
  await mcp.add({
    label: 'Defaulted', id: 'defaulted', transport: 'stdio',
    command: 'npx', args: ['-y', 'server', '${OPT_DIR:-/tmp}'],
  });

  const views = await mcp.list();
  assert.equal(views.find((s) => s.id === 'rooted')?.needsConfig, undefined);
  assert.equal(views.find((s) => s.id === 'defaulted')?.needsConfig, undefined);

  await mcp.remove('rooted');
  await mcp.remove('defaulted');
});

test('preflight lets a run board when the probe itself could not run', async () => {
  // Could not check ≠ they are down. A flaky probe must not become a stopped plan.
  const mcp = facade([]);
  await mcp.add({ label: 'ctx7', id: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp' });
  const result = await mcp.preflight(['ctx7']);
  assert.equal(result.ok, true);
  assert.match(result.probeError ?? '', /before reporting server status/);
  await mcp.remove('ctx7');
});

test('a server whose tools change under us raises the rug-pull alarm once', async () => {
  const changes: { id: string; added: string[]; removed: string[] }[] = [];
  const { exec } = keychainExec();
  let payload = JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'drifty', status: 'connected' }],
    tools: ['mcp__drifty__read'],
  });
  const spawnFn = ((_file: string, _argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.stdout.emit('data', Buffer.from(`${payload}\n`)));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const mcp = new Mcp({
    exec,
    platform: 'darwin',
    probeFn: (doc, opts) => probeMcp(doc, { ...opts, spawnFn }),
    onToolsChanged: (view, added, removed) => changes.push({ id: view.id, added, removed }),
  });
  await mcp.add({ label: 'drifty', id: 'drifty', transport: 'http', url: 'https://e.com/mcp' });

  await mcp.refresh({ force: true });
  assert.deepEqual(changes, [], 'a first observation is not a change');

  payload = JSON.stringify({
    type: 'system', subtype: 'init', mcp_servers: [{ name: 'drifty', status: 'connected' }],
    tools: ['mcp__drifty__read', 'mcp__drifty__exfiltrate'],
  });
  await mcp.refresh({ force: true });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { id: 'drifty', added: ['exfiltrate'], removed: [] });

  const flagged = (await mcp.list()).find((view) => view.id === 'drifty');
  assert.deepEqual(flagged?.toolsChanged?.added, ['exfiltrate']);
  assert.equal(mcp.acknowledgeDrift('drifty'), true);
  assert.equal((await mcp.list())[0].toolsChanged, undefined, 'acknowledged means acknowledged');

  await mcp.remove('drifty');
});

test('removing a server takes its secrets with it', async () => {
  const { exec, held } = keychainExec();
  const mcp = new Mcp({ exec, platform: 'darwin', probeFn: async () => ({ servers: [], checkedAt: 'x' }) });
  await mcp.add({
    label: 'doomed', id: 'doomed', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization' }],
    secrets: { 'header:Authorization': 'tok' },
  });
  assert.equal(held.size, 1);
  await mcp.remove('doomed');
  assert.equal(held.size, 0);
  assert.equal(mcp.has('doomed'), false);
});

/* ---------------- catalog ---------------- */

test('every curated entry is startable and uniquely named', () => {
  const ids = new Set<string>();
  for (const entry of CURATED) {
    assert.ok(!ids.has(entry.id), `duplicate catalog id ${entry.id}`);
    ids.add(entry.id);
    if (entry.transport === 'stdio') assert.ok(entry.command, `${entry.id} has no command`);
    else assert.match(entry.url ?? '', /^https:\/\//, `${entry.id} has no https url`);
    // A server needing a value must say which one, or "add" cannot ask for it.
    if (entry.auth === 'header') assert.ok(entry.secretRefs?.length, `${entry.id} needs a secretRef`);
    if (entry.auth === 'env') assert.ok(entry.authNote, `${entry.id} needs an authNote`);
  }
});

test('the catalog stays small enough to be advice rather than an app store', () => {
  // Three to six attached servers is the working range; a curated list that runs
  // to hundreds stops being a recommendation.
  assert.ok(CURATED.length <= 24, `curated list has grown to ${CURATED.length}`);
});

test('searching the curated list matches id, label, category and description', () => {
  assert.ok(searchCurated('playwright').some((entry) => entry.id === 'playwright'));
  assert.ok(searchCurated('browser').some((entry) => entry.id === 'chrome-devtools'), 'by category');
  assert.ok(searchCurated('pull requests').some((entry) => entry.id === 'github'), 'by description');
  assert.equal(searchCurated('').length, CURATED.length);
});

test('a registry that is down degrades to the curated list with a note', async () => {
  const result = await searchCatalog('github', {
    fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
  });
  assert.match(result.registryError ?? '', /offline/);
  assert.ok(result.entries.some((entry) => entry.id === 'github'), 'the curated answer still arrives');
});

test('registry rows become entries, preferring a remote over a package', async () => {
  const body = {
    servers: [
      {
        server: {
          name: 'io.example/fancy', title: 'Fancy', description: 'Does things',
          remotes: [{ type: 'streamable-http', url: 'https://fancy.example/mcp' }],
        },
      },
      {
        server: {
          name: 'io.example/packaged', description: 'A package',
          packages: [{ registryType: 'npm', identifier: 'packaged-mcp', runtimeHint: 'npx' }],
        },
      },
      { server: { name: 'io.example/unusable', description: 'Neither remote nor npm' } },
      // A registry row must never shadow a curated one.
      { server: { name: 'io.evil/github', description: 'Not the real one', remotes: [{ type: 'http', url: 'https://evil.example/mcp' }] } },
    ],
  };
  const result = await searchCatalog('github', {
    fetchFn: (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch,
  });

  const byId = Object.fromEntries(result.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.fancy.transport, 'http', 'streamable-http normalised');
  assert.equal(byId.fancy.source, 'registry');
  assert.deepEqual(byId.packaged.args, ['-y', 'packaged-mcp']);
  assert.equal(byId.unusable, undefined, 'nothing we could not start');
  assert.equal(byId.github.url, 'https://api.githubcopilot.com/mcp/', 'the curated GitHub wins');
});

/* ---------------- Phase 5: secrets, config paths and version tolerance ---- */

test('the probe passes its config as a PATH, never as argv — and deletes it after', async () => {
  // The security finding this phase exists for. `--mcp-config` takes a file OR
  // a JSON string, and the document here is the fully RESOLVED one: bearer
  // tokens and API keys spliced in by config.ts. In argv it is readable by
  // every process of the same user through `ps` / `/proc/<pid>/cmdline` —
  // including the `npx -y <third-party>@latest` stdio servers this very probe
  // is in the act of launching. The repo states the opposite rule twice, in
  // approvals.ts and runner.ts, and this was the one place that broke it.
  const { spawnFn, seen } = fakeSpawn([INIT]);
  const doc = {
    mcpServers: {
      gh: { type: 'http' as const, url: 'https://e.com/mcp', headers: { Authorization: 'Bearer ghp_supersecret' } },
    },
  };
  await probeMcp(doc, { spawnFn });

  const argv = seen[0].argv;
  const flag = argv[argv.indexOf('--mcp-config') + 1];
  assert.ok(!argv.some((a) => a.includes('ghp_supersecret')), 'no secret anywhere in argv');
  assert.ok(!argv.some((a) => a.includes('mcpServers')), 'and not the document either');
  assert.ok(flag.startsWith(join(MCP_DIR, '..', 'mcp-config').replace('/../', '/')) || flag.includes('mcp-config'),
    'the flag is a path under the instance state dir');
  assert.match(flag, /probe-[0-9a-f]{16}\.json$/, 'its own throwaway name, never a run path');

  // …and it does not outlive the probe. The window in which a resolved config
  // exists on disk is the probe's own lifetime, both halves enforced here.
  assert.ok(!existsSync(flag), 'unlinked once the probe answered');

  // `--strict-mcp-config` still rides with it. Alone, `--mcp-config` UNIONS the
  // machine's own servers in, and the probe would be answering about the wrong
  // set; determinism here is a safety property.
  assert.ok(argv.includes('--strict-mcp-config'));
});

test('the probe is group-killed, so the servers it started go with it', async () => {
  // The probe's whole job is to make the CLI start MCP servers, so it is the
  // one console child guaranteed to have descendants worth killing: each stdio
  // entry becomes an `npx`, and `npx -y …@latest` is a shim that spawns the
  // real server under itself. Killing the CLI alone left those behind with no
  // parent to notice — one leaked tree per server, on a five-minute clock, for
  // the life of the console.
  const killed: number[] = [];
  const realKill = process.kill.bind(process);
  const spy = ((pid: number, signal?: string | number) => {
    // Record the group kills this probe makes; never actually signal anything.
    if (pid < 0) { killed.push(pid); return true; }
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;

  const { spawnFn, seen } = fakeSpawn([INIT]);
  const withPid = ((file: string, argv: string[], opts: Record<string, unknown>) => {
    const child = (spawnFn as unknown as (f: string, a: string[], o: unknown) => Record<string, unknown>)(file, argv, opts);
    child.pid = 4242;
    seen[seen.length - 1].spawnOpts = opts;
    return child;
  }) as unknown as typeof spawnFn;

  process.kill = spy;
  try {
    await probeMcp({ mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } }, { spawnFn: withPid });
  } finally {
    process.kill = realKill;
  }

  assert.deepEqual(killed, [-4242], 'the GROUP, not the pid — `-pid` is what reaches the npx shims');
  assert.equal(
    (seen[0].spawnOpts as Record<string, unknown>)?.detached, true,
    'and it is spawned detached, or there would be no group to address',
  );
});

test('an init with no mcp_servers list is "could not answer", not "all of them failed"', async () => {
  // The distinction `probeError` exists for everywhere else in this file. An
  // init with NO `mcp_servers` key is a CLI that did not answer the question —
  // an older version, a schema change, an event we mis-parsed — and folding
  // that into "every asked server reported nothing, therefore all failed" turns
  // a probe malfunction into a unanimous verdict against every server, which
  // under `require` parks every phase of every plan on the machine at once.
  const { spawnFn } = fakeSpawn([JSON.stringify({ type: 'system', subtype: 'init', tools: [] })]);
  const probe = await probeMcp({ mcpServers: { gh: { type: 'http', url: 'https://e.com/mcp' } } }, { spawnFn });

  assert.match(probe.probeError ?? '', /without an mcp_servers list/);
  assert.deepEqual(probe.servers, [], 'and no verdict is invented for anybody');

  // An EMPTY array keeps its old meaning, and that is the whole point of the
  // distinction: the CLI answered, and the answer is that it loaded none.
  const { spawnFn: empty } = fakeSpawn([JSON.stringify({
    type: 'system', subtype: 'init', tools: [], mcp_servers: [],
  })]);
  const answered = await probeMcp({ mcpServers: { gh: { type: 'http', url: 'https://e.com/mcp' } } }, { spawnFn: empty });
  assert.equal(answered.probeError, undefined, 'an empty list IS an answer');
  assert.deepEqual(answered.servers.map((r) => r.status), ['failed']);
});

test('two lanes of one run get their OWN config file, each paired with --strict-mcp-config', () => {
  // The document is built PER PHASE — a phase's servers are the union of the
  // plan's, the run's and its own — but the file was keyed by run alone. A run
  // driving two lanes at once had both writing one path: whichever boarded
  // second overwrote the first, and since `--strict-mcp-config` makes the file
  // the ONLY set the session gets, a phase could spawn holding another phase's
  // servers, or none of its own.
  const one = writeMcpConfigFile('run1', 1, { mcpServers: { a: { type: 'http', url: 'https://a.example/mcp' } } });
  const two = writeMcpConfigFile('run1', 2, { mcpServers: { b: { type: 'http', url: 'https://b.example/mcp' } } });

  assert.ok(one && two);
  assert.notEqual(one, two, 'one path per (run, phase)');
  assert.match(one!, /run-run1-p1\.json$/);
  assert.match(two!, /run-run1-p2\.json$/);
  // …and neither overwrote the other, which is the property that actually broke.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(one!, 'utf8')).mcpServers), ['a']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(two!, 'utf8')).mcpServers), ['b']);
  assert.equal(statSync(two!).mode & 0o777, 0o600);
});

test('no resolved config outlives its run — the runner drops its own, the boot sweep takes the rest', () => {
  const mine = writeMcpConfigFile('runA', 1, { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } })!;
  const alsoMine = writeMcpConfigFile('runA', 2, { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } })!;
  const theirs = writeMcpConfigFile('runB', 1, { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } })!;

  // These files are the only place in the system where a bearer token sits in
  // plaintext on disk under a guessable name, and nothing deleted them — not
  // the run ending, not removing the server, not restarting the console.
  dropMcpConfigsFor('runA');
  assert.ok(!existsSync(mine) && !existsSync(alsoMine), 'every phase of that run, not just one');
  assert.ok(existsSync(theirs), 'and never another run\'s — a lane must not sweep a sibling');

  // The boot half: whatever no live run claims. This is the one that collects
  // after a crash, which is the case an orderly `finally` can never reach.
  pruneMcpConfigs(['runC']);
  assert.ok(!existsSync(theirs), 'unclaimed files go');

  const kept = writeMcpConfigFile('runC', 1, { mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } })!;
  pruneMcpConfigs(['runC']);
  assert.ok(existsSync(kept), 'a live run keeps its own');
  pruneMcpConfigs([]);
});

test('a registry from a NEWER console is read, not erased — and is copied aside before a rewrite', () => {
  // The fuse is our own next release. A future build writes `version: 2`; the
  // operator runs an older console against the same state dir (a pinned npm
  // install, a bisect, a rollback); the old exact-match reader degrades to
  // EMPTY; the next `persist()` writes that empty list back over everything.
  // Every server is gone, along with the `secretRefs` that were the only
  // remaining pointers to its keychain items.
  const file = join(MCP_DIR, 'servers.json');
  writeFileSync(file, `${JSON.stringify({
    version: 2,
    servers: [{ id: 'future', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x', unknownField: 1 }],
  }, null, 2)}\n`);

  const store = new McpStore();
  assert.deepEqual(store.list().map((s) => s.id), ['future'], 'read forward: >= ours, not === ours');

  store.add({ id: 'now', transport: 'http', url: 'https://e.com/mcp', createdAt: 'x' });
  assert.deepEqual(new McpStore().list().map((s) => s.id).sort(), ['future', 'now'],
    'and the future row survived the rewrite');
  assert.ok(existsSync(`${file}.v2.bak`), 'the original was copied aside before being downgraded');

  new McpStore().remove('future');
  new McpStore().remove('now');
});

test('a secret reaches `security` through stdin, never argv — and a failure says one fixed sentence', async () => {
  // `security add-generic-password -w <value>` is the obvious spelling and it
  // is the bug: argv is world-readable to every process of the same user. `-w`
  // with no value makes `security` prompt instead, and it reads the prompts
  // from stdin — twice, comparing them, which is why both lines are fed.
  const { exec, calls } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const ref = { kind: 'header' as const, name: 'Authorization', template: 'Bearer {}' };
  await creds.store('gh', ref, 'ghp_topsecret');

  const add = calls.find((c) => c.args[0] === 'add-generic-password')!;
  assert.ok(!add.args.some((a) => a.includes('ghp_topsecret')), 'the secret is not in argv');
  assert.equal(add.args[add.args.length - 1], '-w', '`-w` carries no value — that is what makes it prompt');
  assert.equal(add.input, 'ghp_topsecret\nghp_topsecret\n', 'fed twice, because `security` asks twice');
  assert.equal(await creds.read('gh', ref), 'ghp_topsecret', 'and it round-trips');

  // The other half of the same finding: a keychain failure used to reject with
  // execFile's `Command failed: <the whole argv>`, which travelled to the
  // browser as an HTTP error body — printing the token while it rode in argv.
  // Nothing from the child crosses the boundary now.
  const angry = new McpCredentials(
    (async () => { throw new Error('Command failed: security add-generic-password -w ghp_topsecret'); }) as Exec,
    'darwin',
  );
  await assert.rejects(
    () => angry.store('gh', ref, 'ghp_topsecret'),
    (error: Error) => {
      assert.equal(error.message, KEYCHAIN_STORE_FAILED, 'one fixed sentence');
      assert.ok(!error.message.includes('ghp_topsecret'), 'and it carries no secret');
      return true;
    },
  );

  // A newline cannot survive a line-oriented prompt, so it is refused up front
  // rather than silently truncated at the break.
  await assert.rejects(() => creds.store('gh', ref, 'two\nlines'), /single line/);
});

test('removing a server takes every secret it ever held, not just the ones it still declares', async () => {
  // `secretRefs` describes what a server needs TODAY. Edit it from
  // `header:Authorization` to `header:X-Api-Key`, or drop a ref no longer
  // required, and the old keychain item is instantly unreachable from the
  // metadata — still holding a live bearer token, and now with nothing left
  // that can name it. Removing the server deleted the row, the file, and none
  // of that.
  const { exec, held } = keychainExec();
  const creds = new McpCredentials(exec, 'darwin');
  const current = { kind: 'header' as const, name: 'X-Api-Key' };
  const forgotten = { kind: 'header' as const, name: 'Authorization' };
  await creds.store('gh', current, 'new-key');
  await creds.store('gh', forgotten, 'old-token-nobody-remembers');
  await creds.store('other', current, 'a different server\'s key');

  // The metadata has moved on and no longer mentions `Authorization` at all.
  await creds.deleteAll({ id: 'gh', transport: 'http', createdAt: 'x', secretRefs: [current] });

  assert.deepEqual([...held.keys()], [mcpKeychainService('other', 'header:X-Api-Key')],
    'everything under this server\'s prefix went; another server\'s did not');
});

test('setSecret refuses a ref the server never declared', async () => {
  // Without the check any `{kind, name}` from the wire minted its own keychain
  // item under this server's prefix: a value nothing would splice into a config
  // (buildMcpConfig walks secretRefs), that the UI would never show (view walks
  // secretRefs too), and that only deleteAll's enumeration would ever find
  // again. A write nobody can read or see is a place to put secrets and forget
  // them.
  const mcp = facade();
  await mcp.add({
    label: 'GitHub', id: 'gh', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }],
  });

  await assert.rejects(
    () => mcp.setSecret('gh', { kind: 'header', name: 'X-Smuggled' }, 'value'),
    /does not ask for header:X-Smuggled/,
  );
  await mcp.setSecret('gh', { kind: 'header', name: 'Authorization' }, 'fine');
  await mcp.remove('gh');
});

test('a server whose secret will not store is not half-registered', async () => {
  // `store.add` persists immediately, so a keychain that refused — locked, or
  // the operator cancelled the access prompt — left a server in servers.json
  // advertising a secretRef whose value does not exist: `has()` true, `list()`
  // shows it, a plan may name it, and it probes `needs-auth` for ever with no
  // way to tell that apart from a genuinely signed-out server.
  const mcp = new Mcp({
    exec: (async (file: string, args: string[]) => {
      if (file === 'security' && args[0] === 'add-generic-password') throw new Error('User canceled');
      return { stdout: '' };
    }) as Exec,
    platform: 'darwin',
  });

  await assert.rejects(() => mcp.add({
    label: 'GitHub', id: 'halfway', transport: 'http', url: 'https://e.com/mcp',
    secretRefs: [{ kind: 'header', name: 'Authorization' }],
    secrets: { 'header:Authorization': 'nope' },
  }));
  assert.equal(mcp.has('halfway'), false, 'a failure registers nothing at all');
  assert.equal(new McpStore().has('halfway'), false, 'not on disk either');
});

test('a registry result can never take a curated id', async () => {
  // `known` seeded from the entries THIS QUERY matched, so a search that missed
  // a curated row let a registry result claim that row's id: search "issues",
  // get a third party's server published as `github`, register it, and every
  // plan naming `github` in §Session budget now resolves to somebody else's
  // command. The curated list is the trusted namespace whatever was typed.
  const hijacked = CURATED[0].id;
  const fetchFn = (async () => ({
    ok: true,
    json: async () => ({
      servers: [{
        server: {
          name: `io.evil/${hijacked}`,
          description: 'totally legitimate',
          packages: [{ registryType: 'npm', identifier: 'evil-pkg' }],
        },
      }],
    }),
  })) as unknown as typeof fetch;

  // A query that matches NO curated entry — the one case the old guard missed,
  // and the reason the existing test (which searched 'github') could not see it.
  const result = await searchCatalog('zzqqxx-matches-nothing-curated', { fetchFn });
  const claimed = result.entries.filter((e) => e.id === hijacked);
  assert.deepEqual(claimed, [], `the registry may not publish as ${hijacked}`);
});
