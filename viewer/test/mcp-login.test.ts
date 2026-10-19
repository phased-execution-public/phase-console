/**
 * Signing in a server this console registered — issue #8's two branches.
 *
 * The bug was a button that could not work: `claude mcp login <name>` takes a
 * name and no config flag, so a server only the console knew about resolved
 * against the CLI's own registry and answered `No MCP server named "<id>"`.
 * The fix bridges the definition into the config dir the flow runs in, and the
 * properties worth pinning are the ones that make that safe rather than merely
 * effective:
 *
 *  - the definition carries NO secret, and is removed again when it was ours;
 *  - a definition the operator already had is used as it stands and survives;
 *  - a server with no path — `ws`, no URL, a CLI that refuses — produces the
 *    exact commands and NO terminal, because a second unusable button would be
 *    the same bug with a different message;
 *  - the flow runs under a named `CLAUDE_CONFIG_DIR`, so the token lands where
 *    a session under that dir will look for it;
 *  - and after a completed sign-in the registry reports `connected`.
 *
 * Every `claude` here is a stub. Two kinds, deliberately: an injected `Exec`
 * for the argv and lifecycle assertions, and a REAL executable for the one
 * assertion argv cannot make — that the file left on disk holds no secret and
 * is owner-only. Nothing in this file spawns the real CLI.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// MCP dir is a module-level const off INSTANCE_STATE_DIR.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Exec } from '../server/accounts/credentials.ts';
import {
  authUrlOf, bridgeDefinition, consoleConfigDir, endingOf, isLoginBlock, lastLineOf, liveStep, loginEnv,
  pastedCallbackError, planMcpLogin, unbridgeDefinition,
  type McpLoginPlan,
} from '../server/mcp/login.ts';
import { Mcp } from '../server/mcp/index.ts';
import type { McpServerMeta } from '../server/mcp/store.ts';
import { MCP_TRANSPORTS } from '../shared/ops-vocab.js';
import type { McpConfigDoc } from '../server/mcp/config.ts';
import type { McpProbe } from '../server/mcp/health.ts';
import { Service } from '../server/service.ts';

const HTTP: McpServerMeta = {
  id: 'grafana',
  transport: 'http',
  label: 'Grafana',
  url: 'https://mcp.grafana.com/mcp',
  createdAt: '2026-09-02T00:00:00.000Z',
};

/** An exec that records every call and answers (or throws) from a script. */
function fakeExec(answers: (file: string, args: string[]) => string | Error = () => '') {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
    const answer = answers(file, args);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { exec, calls };
}

/** The verb of a `claude mcp …` call — `get`, `add`, `remove`, `login`. */
function verbs(calls: { args: string[] }[]): string[] {
  return calls.map((call) => call.args[1] ?? '');
}

const plan = (meta = HTTP, configDir?: string): McpLoginPlan => {
  const made = planMcpLogin(meta, configDir ? { configDir } : {});
  assert.equal(isLoginBlock(made), false, 'expected a runnable plan');
  return made as McpLoginPlan;
};

/* ------------------------------------------------------------------ *
 * planMcpLogin — what would run, and when nothing would
 * ------------------------------------------------------------------ */

test('the plan bridges the definition, signs in, and puts the registry back', () => {
  const made = plan();
  assert.deepEqual(made.add, [
    'mcp', 'add', '--transport', 'http', '--scope', 'user', 'grafana', 'https://mcp.grafana.com/mcp',
  ]);
  // At this machine the CLI opens the browser and takes the callback itself:
  // no `--no-browser`, so nobody is asked to paste (one-pool phase 19, #372).
  assert.deepEqual(made.login, ['mcp', 'login', 'grafana']);
  assert.equal(made.remote, false);
  assert.deepEqual(made.remove, ['mcp', 'remove', 'grafana', '--scope', 'user']);
});

test('`--no-browser` only for a person who is not at this machine (#372)', () => {
  const made = planMcpLogin(HTTP, { remote: true });
  assert.equal(isLoginBlock(made), false);
  const ok = made as Exclude<typeof made, { reason: string }>;
  assert.deepEqual(ok.login, ['mcp', 'login', 'grafana', '--no-browser']);
  assert.equal(ok.remote, true);
  assert.match(ok.loginCommand, /'--no-browser'$/);
});

test('a named config dir rides every step, so the token lands where runs look', () => {
  const made = plan(HTTP, '/tmp/profile-config');
  assert.equal(made.configDir, '/tmp/profile-config');
  assert.deepEqual(loginEnv(made), { CLAUDE_CONFIG_DIR: '/tmp/profile-config' });
  // Every line the operator could be handed carries it — a pasted command that
  // signs the server into the console's own dir instead is the second half of
  // issue #8 arriving through the copy button.
  for (const line of made.command.split(' && ')) {
    assert.match(line, /^CLAUDE_CONFIG_DIR='\/tmp\/profile-config' claude /);
  }
  assert.match(made.loginCommand, /^CLAUDE_CONFIG_DIR='\/tmp\/profile-config' claude 'mcp' 'login'/);
});

test('no config dir means inherit, and nothing is prefixed', () => {
  const made = plan(HTTP);
  assert.equal(made.configDir, undefined);
  assert.equal(loginEnv(made), undefined);
  assert.match(made.loginCommand, /^claude /);
});

test('a stdio server has no OAuth flow and no commands to offer', () => {
  const made = planMcpLogin({ ...HTTP, transport: 'stdio', url: undefined, command: 'npx' });
  assert.equal(isLoginBlock(made), true);
  assert.match((made as { reason: string }).reason, /stdio/);
  assert.deepEqual((made as { commands: string[] }).commands, []);
});

test('a ws server is refused: `claude mcp add` has no spelling for it', () => {
  const made = planMcpLogin({ ...HTTP, transport: 'ws' });
  assert.equal(isLoginBlock(made), true);
  // No commands, because there are none that would work — an empty list is the
  // honest answer and the card renders it as such.
  assert.deepEqual((made as { commands: string[] }).commands, []);
});

test('the client\'s SIGNABLE_TRANSPORTS is exactly what the server will bridge', () => {
  // `client/src/screens/settings/mcp.tsx` keeps its own copy so the Sign in
  // button can be ABSENT rather than present-and-refusing, and its comment says
  // this test holds the two together. It has to actually do that: every
  // transport the registry knows is asked of the server, and the answer must
  // match the client's list member-for-member.
  const client = readFileSync(
    new URL('../client/src/screens/settings/mcp.tsx', import.meta.url), 'utf8',
  );
  const declared = client.match(/const SIGNABLE_TRANSPORTS[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(declared, 'SIGNABLE_TRANSPORTS is gone from the card — this test is now a lie');
  const clientList = [...declared[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();

  const serverList = MCP_TRANSPORTS
    .filter((transport) => !isLoginBlock(planMcpLogin({ ...HTTP, transport })))
    .slice()
    .sort();

  assert.deepEqual(clientList, serverList);
});

test('a server that authenticates by a header has no OAuth flow to start', () => {
  // It already has its credential — ours, in the keychain — so `mcp login` would
  // have nothing to do. Refused here as well as hidden on the card, because the
  // route is reachable without the card.
  const made = planMcpLogin({
    ...HTTP,
    secretRefs: [{ kind: 'header', name: 'Authorization', template: 'Bearer {}' }],
  });
  assert.equal(isLoginBlock(made), true);
  assert.match((made as { reason: string }).reason, /header value/);
});

test('an Authorization header on the meta is a header server, not an OAuth one', () => {
  const made = planMcpLogin({ ...HTTP, headers: { Authorization: 'Bearer x' } });
  assert.equal(isLoginBlock(made), true);
  // And nothing that looks like a credential can reach a command line, because
  // no command line is produced at all.
  assert.deepEqual((made as { commands: string[] }).commands, []);
});

test('a remote server with no URL has nothing to authorize against', () => {
  const made = planMcpLogin({ ...HTTP, url: '   ' });
  assert.equal(isLoginBlock(made), true);
});

test('non-secret headers are carried, because a definition that cannot connect is useless', () => {
  const made = plan({ ...HTTP, headers: { 'X-Org': 'acme' } });
  assert.ok(made.add.includes('--header'));
  assert.ok(made.add.includes('X-Org: acme'));
});

/* ------------------------------------------------------------------ *
 * bridgeDefinition — the lifecycle the ruling named
 * ------------------------------------------------------------------ */

test('an absent definition is written, and reported as ours to remove', async () => {
  const { exec, calls } = fakeExec((_file, args) =>
    args[1] === 'get' ? new Error('No MCP server named "grafana".') : '');
  const result = await bridgeDefinition(plan(), exec);
  assert.deepEqual(result, { ok: true, wrote: true });
  assert.deepEqual(verbs(calls), ['get', 'add']);
});

test("a definition the operator already had is used as it stands and never removed", async () => {
  const { exec, calls } = fakeExec(() => 'grafana:\n  Scope: User config\n');
  const result = await bridgeDefinition(plan(), exec);
  assert.deepEqual(result, { ok: true, wrote: false });
  // Asked, and then stopped. Registering over somebody's own entry — or
  // removing it afterwards — is the tidiness that costs an afternoon.
  assert.deepEqual(verbs(calls), ['get']);
});

test('a CLI that refuses the registration is a refusal, not a terminal', async () => {
  const { exec } = fakeExec((_file, args) => new Error(args[1] === 'get' ? 'absent' : 'unknown option'));
  const result = await bridgeDefinition(plan(), exec);
  assert.equal(result.ok, false);
  assert.match((result as { detail: string }).detail, /unknown option/);
});

test('every bridge step runs under the plan config dir', async () => {
  const { exec, calls } = fakeExec((_file, args) => (args[1] === 'get' ? new Error('absent') : ''));
  const made = plan(HTTP, '/tmp/profile-config');
  await bridgeDefinition(made, exec);
  await unbridgeDefinition(made, exec);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.env?.CLAUDE_CONFIG_DIR, '/tmp/profile-config');
  }
});

test('unbridging survives a CLI that will not remove it — best effort, never a throw', async () => {
  const { exec } = fakeExec(() => new Error('nope'));
  assert.equal(await unbridgeDefinition(plan(), exec), false);
});

/* ------------------------------------------------------------------ *
 * The one assertion argv cannot make: what lands on disk
 * ------------------------------------------------------------------ */

/**
 * A real executable that behaves like `claude mcp add/get/remove` does where
 * it matters: it materialises argv into `$CLAUDE_CONFIG_DIR/.claude.json` at
 * 0600, and `get` exits 1 for a name it does not hold.
 *
 * A stub rather than the CLI because a hermetic suite must never spawn one —
 * and a stub is enough, because what is under test is OUR argv. The real CLI's
 * own 0600 was measured against 2.1.258 by hand and is recorded in the phase
 * handoff; what this pins is that we hand it nothing that should not be there.
 */
function stubClaude(dir: string): { exec: Exec; path: string } {
  const path = join(dir, 'claude-stub');
  writeFileSync(path, `#!/usr/bin/env node
const { readFileSync, writeFileSync, chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const file = join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { mcpServers: {} };
const verb = argv[1];
const id = verb === 'add' ? argv[argv.length - 2] : argv[2];
if (verb === 'get') { process.exit(doc.mcpServers[id] ? 0 : 1); }
if (verb === 'add') {
  const headers = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--header') {
      const cut = argv[i + 1].indexOf(': ');
      headers[argv[i + 1].slice(0, cut)] = argv[i + 1].slice(cut + 2);
    }
  }
  const transport = argv[argv.indexOf('--transport') + 1];
  doc.mcpServers[id] = { type: transport, url: argv[argv.length - 1] };
  if (Object.keys(headers).length) doc.mcpServers[id].headers = headers;
}
if (verb === 'remove') { delete doc.mcpServers[id]; }
writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
chmodSync(file, 0o600);
`, { mode: 0o755 });
  chmodSync(path, 0o755);

  const exec: Exec = (file, args, opts) => new Promise((resolve, reject) => {
    execFile(
      file === 'claude' ? path : file, args,
      { env: { ...process.env, ...opts?.env } },
      (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) })),
    );
  });
  return { exec, path };
}

test('the bridged definition holds no secret, is owner-only, and is gone afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-mcp-login-'));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  try {
    const { exec } = stubClaude(dir);
    // A server that authenticates by OAuth but also carries a routing header,
    // and whose registry entry names a secret it does NOT put in the file.
    const made = plan({ ...HTTP, headers: { 'X-Org': 'acme' } }, configDir);

    const bridged = await bridgeDefinition(made, exec);
    assert.deepEqual(bridged, { ok: true, wrote: true });

    const file = join(configDir, '.claude.json');
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'a definition must be owner-only');

    const raw = readFileSync(file, 'utf8');
    const doc = JSON.parse(raw) as { mcpServers: Record<string, { type: string; url: string }> };
    assert.equal(doc.mcpServers.grafana?.url, 'https://mcp.grafana.com/mcp');
    // The whole of exit criterion 2: nothing that could be a credential. The
    // registry holds no secret (`store.ts`) and this path never reads the
    // keychain, so an `Authorization` here could only come from a mistake.
    assert.equal(/authorization|bearer|token|secret|api[_-]?key/i.test(raw), false, raw);

    assert.equal(await unbridgeDefinition(made, exec), true);
    const after = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.equal(after.grafana, undefined);
    assert.equal(Object.keys(after.mcpServers).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The end of the path: the registry reports connected
 * ------------------------------------------------------------------ */

test('after a completed sign-in the registry reports connected', async () => {
  // `needs-auth` until the flow happens, `connected` after — the transition the
  // Sign in button exists to cause, and the one issue #8 said could never
  // happen for a console-registered server.
  let signedIn = false;
  const probeFn = async (doc: McpConfigDoc): Promise<McpProbe> => ({
    servers: Object.keys(doc.mcpServers).map((id) => ({
      id, status: signedIn ? 'connected' as const : 'needs-auth' as const, tools: signedIn ? ['query'] : [],
    })),
    checkedAt: new Date().toISOString(),
  });
  const mcp = new Mcp({ probeFn, exec: fakeExec().exec });
  await mcp.add({ id: 'grafana', label: 'Grafana', transport: 'http', url: 'https://mcp.grafana.com/mcp' });

  await mcp.refresh({ force: true });
  assert.equal((await mcp.list()).find((s) => s.id === 'grafana')?.status, 'needs-auth');

  // The flow: bridge, sign in (the stub's login is a no-op that succeeds), and
  // put the registry back — exactly the sequence the exit hook drives.
  const { exec, calls } = fakeExec((_file, args) => (args[1] === 'get' ? new Error('absent') : ''));
  const made = plan();
  const bridged = await bridgeDefinition(made, exec);
  assert.equal(bridged.ok && bridged.wrote, true);
  await exec('claude', made.login);
  signedIn = true;
  await unbridgeDefinition(made, exec);
  assert.deepEqual(verbs(calls), ['get', 'add', 'login', 'remove']);

  await mcp.refresh({ force: true });
  const view = (await mcp.list()).find((s) => s.id === 'grafana');
  assert.equal(view?.status, 'connected');
  assert.equal(view?.toolCount, 1);
});

/* ------------------------------------------------------------------ *
 * consoleConfigDir
 * ------------------------------------------------------------------ */

test('the console config dir is the CLI default unless the environment redirects it', () => {
  assert.equal(consoleConfigDir({}, '/home/x'), '/home/x/.claude');
  assert.equal(consoleConfigDir({ CLAUDE_CONFIG_DIR: '/elsewhere' }, '/home/x'), '/elsewhere');
  // A blank value is not a redirection — it is an empty variable somebody set
  // by accident, and honouring it would send every token to `/.claude`.
  assert.equal(consoleConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/home/x'), '/home/x/.claude');
});

/* ------------------------------------------------------------------ *
 * The service: what the card is told when no flow can start
 * ------------------------------------------------------------------ */

/**
 * A console that may register servers and nothing else.
 *
 * Deliberately WITHOUT `allowAccounts`, which is what gates a login pty: every
 * assertion below is on a branch that returns before any terminal is minted,
 * so no suite of this file can open Terminal.app on a developer's machine.
 */
function mcpService(): Service {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowMcp: true,
    scriptsDir: join(process.cwd(), '..', 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  return svc;
}

test('a ws server produces a reason and no terminal — never a verb that cannot succeed', async () => {
  const svc = mcpService();
  await svc.mcp.add({ id: 'wsserver', label: 'WS', transport: 'ws', url: 'wss://example.test/mcp' });
  const started = await svc.beginMcpLogin('wsserver');
  assert.equal(started.mode, 'command');
  assert.equal(started.terminal, undefined);
  assert.match(started.detail ?? '', /mcp add/);
  assert.deepEqual(started.commands, []);
});

test('a CLI that refuses the bridge hands back the exact commands, and opens nothing', async () => {
  const svc = mcpService();
  svc.mcpExec = fakeExec((_file, args) =>
    new Error(args[1] === 'get' ? 'absent' : 'error: unknown option --transport')).exec;
  await svc.mcp.add({ id: 'refused', label: 'Refused', transport: 'http', url: 'https://mcp.grafana.com/mcp' });

  const started = await svc.beginMcpLogin('refused');
  assert.equal(started.mode, 'command');
  assert.equal(started.terminal, undefined);
  // The whole of the second branch: the operator is given the real next step
  // rather than a terminal printing somebody else's server list.
  assert.equal(started.commands?.length, 1);
  assert.match(started.commands![0], /claude 'mcp' 'add'.*claude 'mcp' 'login'.*claude 'mcp' 'remove'/s);
  assert.match(started.detail ?? '', /unknown option/);
  // And it says where the token would have gone, so a sign-in run by hand
  // lands in the dir this console's own probe reads.
  assert.equal(started.configDir, consoleConfigDir());
});

test('a no-pty bridge is released once the server reports connected', async () => {
  const svc = mcpService();
  const { exec, calls } = fakeExec((_file, args) => (args[1] === 'get' ? new Error('absent') : ''));
  svc.mcpExec = exec;
  await svc.mcp.add({ id: 'nopty', label: 'No pty', transport: 'http', url: 'https://mcp.grafana.com/mcp' });

  // No `allowAccounts`, so no login pty can be minted — this IS the no-pty shape.
  // The definition is written and then owed back, with no session exit to hook.
  await svc.releaseMcpBridge('nopty');
  assert.deepEqual(verbs(calls), ['remove'], 'the release must reach the CLI');
});

test('an abandoned no-pty bridge is LEAKED across a restart — the accepted cost, pinned', async () => {
  // The pty flow carries `mcpBridged` on its session and so survives a restart;
  // this one lives in a Map that does not. The ruling accepts that: what is left
  // behind is one secret-free 0600 definition, removable by hand, and the
  // alternative was deleting entries that were never ours. Pinned so the day
  // somebody changes it, they change it deliberately.
  const svc = mcpService();
  const { calls } = fakeExec();
  svc.mcpExec = (async (file, args) => { calls.push({ file, args }); return { stdout: '' }; }) as typeof svc.mcpExec;
  await svc.mcp.add({ id: 'abandoned', label: 'Abandoned', transport: 'http', url: 'https://mcp.grafana.com/mcp' });

  // A FRESH service is the restart: its pendingMcpBridges is empty, so a refresh
  // that finds the server connected releases nothing.
  const restarted = mcpService();
  restarted.mcpExec = svc.mcpExec;
  await restarted.refreshMcp(true);
  assert.deepEqual(calls, [], 'a restarted console knows of no bridge to take back');
});

test('an unknown account is refused before anything is written', async () => {
  const svc = mcpService();
  await svc.mcp.add({ id: 'noaccount', label: 'No account', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  await assert.rejects(
    () => svc.beginMcpLogin('noaccount', { accountId: 'nobody' }),
    /no account called nobody/,
  );
});

/* ------------------------------------------------------------------ *
 * The guided sign-in (one-pool phase 19, #372)
 * ------------------------------------------------------------------ */

const AUTH = 'https://mcp.grafana.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Fcallback&code_challenge=xyz';

test('the sign-in page is read from the terminal, colour taken out — and nothing else is mistaken for it', () => {
  assert.equal(authUrlOf('Starting…\r\n'), undefined);
  assert.equal(authUrlOf('See https://docs.example.com/mcp for help\r\n'), undefined, 'a docs link is not the page');
  assert.equal(authUrlOf(`\u001b[1mOpen this URL:\u001b[0m \u001b[36m${AUTH}\u001b[39m\r\nPaste the redirect URL: `), AUTH);
});

test('a pasted address must be one the browser landed on — with a code', () => {
  assert.match(pastedCallbackError('') ?? '', /paste the address/);
  assert.match(pastedCallbackError('not a url') ?? '', /not an address/);
  assert.match(pastedCallbackError('http://localhost:51234/callback') ?? '', /carries no code/);
  assert.match(pastedCallbackError('ftp://localhost/callback?code=1') ?? '', /starts with http/);
  assert.equal(pastedCallbackError('http://localhost:51234/callback?code=abc&state=s'), null);
  assert.equal(pastedCallbackError('http://localhost:51234/callback?error=access_denied'), null, 'a refusal is the CLI\'s to report');
});

test('a flow walks starting → approve (here) or paste (elsewhere) → checking', () => {
  assert.equal(liveStep({ remote: false }), 'starting');
  assert.equal(liveStep({ remote: false, authUrl: AUTH }), 'approve');
  assert.equal(liveStep({ remote: true, authUrl: AUTH }), 'paste');
  assert.equal(liveStep({ remote: true, authUrl: AUTH, pastedAt: '2026-10-18T00:00:00Z' }), 'checking');
});

test('a CLI that gave up on its own clock is timed out, and the words name the step', () => {
  const deadline = '2026-10-18T00:05:00.000Z';
  const late = endingOf({ remote: true, authUrl: AUTH, deadline }, { code: 1, at: Date.parse(deadline), lastLine: 'Timed out' });
  assert.equal(late.step, 'timed-out');
  assert.match(late.detail, /after five minutes, waiting for the address the browser landed on to be pasted back/);
  assert.match(late.detail, /“Timed out”/);
  const early = endingOf({ remote: false, deadline }, { code: 2, at: Date.parse(deadline) - 120_000 });
  assert.equal(early.step, 'failed');
  assert.match(early.detail, /exit 2.*waiting for the Claude CLI to print the sign-in page/);
  assert.equal(lastLineOf('one\r\n\u001b[31mError: bad code\u001b[0m\r\n\r\n'), 'Error: bad code');
});

/** A service whose terminals are a stub that records what was minted, typed and dismissed. */
function guidedService(output: { text: string }, opts: { status?: string } = {}) {
  const svc = mcpService();
  const faked = fakeExec((_file, args) => (args[1] === 'get' ? new Error('absent') : ''));
  svc.mcpExec = faked.exec;
  const minted: { args: string[] }[] = [];
  const typed: string[] = [];
  const dismissed: string[] = [];
  const killed: string[] = [];
  let live = true;
  const terminals = {
    mint: async (_id: unknown, _size: unknown, launch: { args: string[] }) => {
      minted.push({ args: launch.args });
      live = true;
      return { ok: true, sessionId: `s${minted.length}`, token: 't', expiresAt: 0 };
    },
    outputTail: () => output.text,
    isLive: () => live,
    input: (_id: string, data: string) => { typed.push(data); return live; },
    dismiss: (id: string) => { dismissed.push(id); live = false; return { ok: true }; },
    kill: (id: string) => { killed.push(id); live = false; return true; },
  };
  Object.defineProperty(svc, 'terminals', { value: terminals });
  let clock = Date.parse('2026-10-18T00:00:00.000Z');
  svc.mcpLoginNow = () => clock;
  const status = opts.status ?? 'connected';
  svc.refreshMcp = (async () => svc.mcp.enabledIds().map((id) => ({ id, label: 'Guided', status }))) as never;
  return {
    svc, minted, typed, dismissed, killed, calls: faked.calls,
    tick: (ms: number) => { clock += ms; },
    end: () => { live = false; },
  };
}

test('at the machine: no --no-browser, the page is read, and an exit 0 that connects ends Connected', async () => {
  const output = { text: '' };
  const t = guidedService(output);
  await t.svc.mcp.add({ id: 'guided1', label: 'Guided', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  const started = await t.svc.beginMcpLogin('guided1', { remote: false });
  assert.equal(started.mode, 'embedded');
  assert.deepEqual(t.minted[0]!.args, ['mcp', 'login', 'guided1'], 'the CLI opens the browser itself');
  assert.equal(started.flow.step, 'starting');
  assert.equal(started.flow.remote, false);
  assert.equal(Date.parse(started.flow.deadline) - Date.parse(started.flow.startedAt), 5 * 60_000);

  output.text = `Opening ${AUTH}\r\n`;
  const reading = t.svc.mcpLoginFlow('guided1')!;
  assert.equal(reading.step, 'approve');
  assert.equal(reading.authUrl, AUTH);
  assert.throws(() => t.svc.pasteMcpLogin('guided1', 'http://localhost:1/callback?code=x'), /approve in the browser/);

  t.end();
  await t.svc.finishMcpLogin('guided1', { id: 's1', code: 0, bridged: true });
  const ended = t.svc.mcpLoginFlow('guided1')!;
  assert.equal(ended.step, 'connected');
  assert.deepEqual(t.dismissed, ['s1'], 'the exited sign-in terminal is cleared');
});

test('from elsewhere: --no-browser, the paste-back is checked and typed into the CLI', async () => {
  const output = { text: '' };
  const t = guidedService(output);
  await t.svc.mcp.add({ id: 'guided2', label: 'Guided', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  await t.svc.beginMcpLogin('guided2', { remote: true });
  assert.deepEqual(t.minted[0]!.args, ['mcp', 'login', 'guided2', '--no-browser']);
  assert.throws(() => t.svc.pasteMcpLogin('guided2', 'http://localhost:1/callback'), /carries no code/);
  assert.deepEqual(t.typed, [], 'nothing refused reaches the terminal');

  output.text = `Open this URL to sign in:\r\n${AUTH}\r\nPaste the redirect URL here: `;
  assert.equal(t.svc.mcpLoginFlow('guided2')!.step, 'paste');
  const pasted = t.svc.pasteMcpLogin('guided2', ' http://localhost:51234/callback?code=abc&state=s ');
  assert.deepEqual(t.typed, ['http://localhost:51234/callback?code=abc&state=s\r']);
  assert.equal(pasted.step, 'checking');
});

test('a sign-in left waiting runs out of time, and the sheet is told which step it stopped on', async () => {
  const output = { text: `Open this URL:\r\n${AUTH}\r\n` };
  const t = guidedService(output, { status: 'needs-auth' });
  await t.svc.mcp.add({ id: 'guided3', label: 'Guided', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  await t.svc.beginMcpLogin('guided3', { remote: true });
  t.tick(5 * 60_000 + 1_000);
  output.text += 'Error: timed out waiting for the redirect URL\r\n';
  t.end();
  await t.svc.finishMcpLogin('guided3', { id: 's1', code: 1, bridged: false });
  const ended = t.svc.mcpLoginFlow('guided3')!;
  assert.equal(ended.step, 'timed-out');
  assert.match(ended.detail ?? '', /five minutes, waiting for the address the browser landed on to be pasted back/);
  assert.match(ended.detail ?? '', /timed out waiting for the redirect URL/);
});

test('an exit 0 that does not connect is a failure with the server\'s own answer, and Try again ends the old terminal', async () => {
  const output = { text: '' };
  const t = guidedService(output, { status: 'needs-auth' });
  await t.svc.mcp.add({ id: 'guided4', label: 'Guided', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  await t.svc.beginMcpLogin('guided4', { remote: false });
  const removes = () => t.calls.filter((call) => call.args[1] === 'remove').length;
  assert.equal(removes(), 0);
  await t.svc.beginMcpLogin('guided4', { remote: false });
  assert.deepEqual(t.killed, ['s1'], 'two terminals never wait on one sign-in');
  assert.equal(removes(), 1, 'the closed terminal\'s bridged definition is taken back before the new one');
  t.end();
  await t.svc.finishMcpLogin('guided4', { id: 's2', code: 0, bridged: false });
  const ended = t.svc.mcpLoginFlow('guided4')!;
  assert.equal(ended.step, 'failed');
  assert.match(ended.detail ?? '', /still answers needs-auth/);
});

test('a flow nobody finished reads timed out a minute past the deadline, whatever the terminal does', async () => {
  const output = { text: '' };
  const t = guidedService(output);
  await t.svc.mcp.add({ id: 'guided5', label: 'Guided', transport: 'http', url: 'https://mcp.grafana.com/mcp' });
  await t.svc.beginMcpLogin('guided5', { remote: false });
  t.tick(6 * 60_000 + 1_000);
  const stale = t.svc.mcpLoginFlow('guided5')!;
  assert.equal(stale.step, 'timed-out');
  assert.match(stale.detail ?? '', /waiting for the Claude CLI to print the sign-in page/);
});
