/**
 * Every session the console spawns reports presence, on every account
 * (control-tower phase 108, #194).
 *
 * Measured on hub 4123 on 2026-10-03 at 01:45Z: run `a84ae470d859` switched
 * `default → account-4e86` at a boundary, and the 13 phase sessions it spawned
 * afterwards produced ZERO registry rows. The presence hook lives in the
 * login's `~/.claude/settings.json`; a profile workspace deliberately inherits
 * only `enabledPlugins` and `extraKnownMarketplaces`, and the run's policy
 * settings carry no `SessionStart`. So `#/sessions`, the Pulse and every
 * correlation of a session to its phase were blind on a profile.
 *
 *  - PP-1 the workspace: the presence entries — and only they, never the
 *    login's other hooks — are installed into a profile's `settings.json`,
 *    idempotently, refreshed when stale, a person's own hooks kept, a file that
 *    does not parse left alone;
 *  - PP-2 the account: `envFor` provisions it on the way out, the same moment
 *    it links skills and trusts the root;
 *  - PP-3 end to end: a phase session spawned with the profile's
 *    `CLAUDE_CONFIG_DIR` runs the hook its config dir names and appears in
 *    `GET /api/sessions/registry` correlated to its `{slug, phase, runId}`.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { ensureProfileWorkspace } = await import('../server/accounts/workspace.ts');
const { HOOK_EVENTS, hookCommand, hooksStatus, installHooks } = await import('../server/hooks-install.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { profileConfigDir } = await import('../server/accounts/store.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { spawnClaude } = await import('../server/runner/spawn.ts');
const { registerInstance } = await import('../shared/instances.mjs');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const OURS = hookCommand(SKILL_DIR);

type Settings = { hooks?: Record<string, { matcher?: string; hooks?: { type: string; command: string }[] }[]>; [key: string]: unknown };
const settingsOf = (dir: string): Settings => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings;
const commands = (settings: Settings): string[] =>
  Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)));

/** A stand-in for `~/.claude`: plugins on, the presence hook installed, and hooks of the person's own. */
function login(scratch: string): string {
  const dir = join(scratch, 'login');
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'superpowers@claude-plugins-official': true },
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'say "good morning"' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/my-guard.sh' }] }],
    },
  }, null, 2));
  installHooks({ skillDir: SKILL_DIR, settingsPath: join(dir, 'settings.json') });
  return dir;
}

/* ------------------------------------------------------------------ PP-1 */

test('PP-1 — the presence entries, and only they, are installed into a profile workspace', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pp-workspace-'));
  try {
    const loginDir = login(scratch);
    const profile = join(scratch, 'profile', 'config');
    ensureProfileWorkspace(profile, ['/repo/a'], join(loginDir, 'skills'), loginDir, { hookSkillDir: SKILL_DIR });

    const status = hooksStatus({ skillDir: SKILL_DIR, settingsPath: join(profile, 'settings.json') });
    assert.equal(status.installed, true, `every presence event, pointing at this copy: ${JSON.stringify(status)}`);
    const written = settingsOf(profile);
    assert.deepEqual(Object.keys(written.hooks ?? {}).sort(), [...HOOK_EVENTS].sort(), 'the four presence events and nothing else');
    assert.deepEqual([...new Set(commands(written))], [OURS], 'never the login\'s other hooks');
    assert.equal(written.permissions, undefined, 'and still never its permissions');
    assert.deepEqual(written.enabledPlugins, { 'superpowers@claude-plugins-official': true }, 'the plugin keys still travel');
    assert.equal(statSync(join(profile, 'settings.json')).mode & 0o777, 0o600, 'private, like everything under the accounts dir');

    // Idempotent: a second provisioning writes nothing.
    const before = statSync(join(profile, 'settings.json'));
    const text = readFileSync(join(profile, 'settings.json'), 'utf8');
    ensureProfileWorkspace(profile, ['/repo/a'], join(loginDir, 'skills'), loginDir, { hookSkillDir: SKILL_DIR });
    assert.equal(readFileSync(join(profile, 'settings.json'), 'utf8'), text);
    assert.equal(statSync(join(profile, 'settings.json')).ino, before.ino, 'no tmp + rename happened');

    // A stale entry (another checkout's script) is refreshed in place; a
    // person's own per-profile hook is kept exactly.
    const stale = join(scratch, 'stale');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'bash "/elsewhere/scripts/session-hook.sh"', timeout: 3 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }],
      },
    }));
    ensureProfileWorkspace(stale, [], join(loginDir, 'skills'), loginDir, { hookSkillDir: SKILL_DIR });
    assert.equal(hooksStatus({ skillDir: SKILL_DIR, settingsPath: join(stale, 'settings.json') }).installed, true);
    assert.ok(commands(settingsOf(stale)).includes('mine.sh'), 'a person\'s own hook stays');
    assert.ok(!commands(settingsOf(stale)).some((command) => command.includes('/elsewhere/')), 'the stale path is gone');

    // Fail-open: a file that does not parse is a person's to fix.
    const broken = join(scratch, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'settings.json'), '{ not json');
    ensureProfileWorkspace(broken, [], join(loginDir, 'skills'), loginDir, { hookSkillDir: SKILL_DIR });
    assert.equal(readFileSync(join(broken, 'settings.json'), 'utf8'), '{ not json');

    // Not asked to: nothing installed (the provisioning without a skill to point at).
    const bare = join(scratch, 'bare');
    ensureProfileWorkspace(bare, [], join(loginDir, 'skills'), loginDir);
    assert.equal(settingsOf(bare).hooks, undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ PP-2 */

test('PP-2 — a profile account\'s env is provisioned with presence on the way out', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pp-accounts-'));
  const accounts = new Accounts({
    registryDir: join(scratch, 'registry'), accountsDir: join(scratch, 'accounts'), learnedFile: join(scratch, 'learned.json'),
    exec: async () => ({ code: 1, stdout: '', stderr: 'not here' }),
  } as never);
  try {
    (accounts as unknown as { store: { add(meta: Record<string, unknown>): void } }).store.add({
      id: 'work', kind: 'profile', name: 'work', createdAt: new Date().toISOString(),
    });
    const env = await accounts.envFor('work', ['/repo/a']);
    const dir = profileConfigDir('work', join(scratch, 'accounts'));
    assert.equal(env?.CLAUDE_CONFIG_DIR, dir);
    const status = hooksStatus({ skillDir: SKILL_DIR, settingsPath: join(dir, 'settings.json') });
    assert.equal(status.installed, true, `a session under the profile reports presence: ${JSON.stringify(status)}`);
  } finally {
    accounts.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ PP-3 */

/**
 * The CLI, as far as this needs it: it reads the `SessionStart` hooks its
 * config dir's `settings.json` names and runs each one, with the hook payload
 * on stdin and `CLAUDE_PID` set, before its first turn — then answers the
 * stream the runner reads and exits.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const sid = argv[argv.indexOf('--session-id') + 1];
let settings = {};
try { settings = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')); } catch {}
const payload = JSON.stringify({
  session_id: sid, cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'startup',
  transcript_path: join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'stub', sid + '.jsonl'),
});
for (const group of ((settings.hooks || {}).SessionStart || [])) {
  for (const hook of (group.hooks || [])) {
    if (hook.type !== 'command') continue;
    spawnSync('/bin/sh', ['-c', hook.command], { input: payload, env: { ...process.env, CLAUDE_PID: String(process.pid) }, encoding: 'utf8' });
  }
}
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
process.stdin.setEncoding('utf8');
process.stdin.once('data', () => {
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, result: 'ok', session_id: sid });
  process.exit(0);
});
`;

const PLAN = `---
slug: alpha
created: 2026-10-04
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |

## Phases

### Phase 1 — one
- **Verification:**
  - \`true\`
`;

async function call(svc: InstanceType<typeof Service>, method: string, path: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  const res = {
    writeHead() { return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; }, writableEnded: false, destroyed: false,
  };
  const req = {
    method, headers: { host: '127.0.0.1:4123', 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    socket: { remoteAddress: '127.0.0.1' }, on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* no body */ },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return payload as Record<string, unknown>;
}

test('PP-3 — a phase session on a profile account appears in /api/sessions/registry with its {slug, phase, runId}', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p108-pp-'));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv });
  execFileSync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env: gitEnv });
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), STUB);
  chmodSync(join(bin, 'claude'), 0o755);

  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false, allowAccounts: true,
    scriptsDir: SCRIPTS, logFile: null, converge: false, remoteHosts: [], remoteUsers: [],
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  // The console's own door for the hook: the presence route, on a real socket.
  const server = createServer((req, res) => {
    void handleApi({ service: svc } as never, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(svc.open(root).ok, true);
    await svc.bootSettled;
    registerInstance(root, { name: 'pp-repo' });

    const accounts = (svc as unknown as { accounts: InstanceType<typeof Accounts> & { store: { add(meta: Record<string, unknown>): void } } }).accounts;
    accounts.store.add({ id: 'work', kind: 'profile', name: 'work', createdAt: new Date().toISOString() });

    const state = newRun({ slug: 'alpha', root, autoRecover: false, accountId: 'work' } as never);
    const sessionId = '7d0c6c1e-6a4e-4d43-9b39-5d6b2f2d9a10';
    Object.assign(phaseRecord(state, 1), { status: 'running', attempts: 1, sessionId });
    saveRun(state);

    // What the runner hands a lane on this account (`accountEnv` → `envFor`), and what it adds itself.
    const accountEnv = await accounts.envFor('work', [root]);
    assert.ok(accountEnv?.CLAUDE_CONFIG_DIR, 'a profile runs under its own config dir');
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PE_|DOCS_ROOT$|CLAUDE_|PHASE_CONSOLE_URL$|PHASE_CONSOLE_HOOK)/.test(key)) continue;
      env[key] = value;
    }
    Object.assign(env, accountEnv, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PE_OWNER: `autopilot/${state.id}`, PE_SCOPE: 'app', DOCS_ROOT: root,
      PHASE_CONSOLE_URL: `http://127.0.0.1:${port}`, PHASE_CONSOLE_HOOK_INGEST: '0',
    });
    await spawnClaude({ prompt: 'BOOT phase 1', cwd: root, sessionId, env });

    const views = (await call(svc, 'GET', '/api/sessions/registry')).sessions as {
      sessionId: string; kind: string; configDir?: string; plan?: { slug: string; phase: number; runId?: string };
    }[];
    const view = views.find((one) => one.sessionId === sessionId);
    assert.ok(view, `the profile session never reported presence: ${JSON.stringify(views.map((one) => one.sessionId))}`);
    assert.equal(view.kind, 'autopilot');
    assert.equal(view.configDir, accountEnv.CLAUDE_CONFIG_DIR, 'the registry knows which account it spends');
    assert.deepEqual({ slug: view.plan?.slug, phase: view.plan?.phase, runId: view.plan?.runId }, { slug: 'alpha', phase: 1, runId: state.id });
    assert.ok(existsSync(join(accountEnv.CLAUDE_CONFIG_DIR!, 'settings.json')));

    // `doctor` reads every pooled account's config dir, the profile's among them.
    const pooled = (svc as unknown as { presenceByAccount(): { dir: string; accounts: string[]; status: { installed: boolean } | null }[] })
      .presenceByAccount();
    const work = pooled.find((one) => one.accounts.includes('work'));
    assert.equal(work?.dir, accountEnv.CLAUDE_CONFIG_DIR);
    assert.equal(work?.status?.installed, true);
    assert.ok(pooled.some((one) => one.accounts.includes('default')), 'and the login\'s, for the machine login');
  } finally {
    server.close();
    svc.close?.();
    rmSync(base, { recursive: true, force: true });
  }
});
