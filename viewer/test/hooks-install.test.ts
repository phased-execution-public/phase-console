/**
 * The session-presence hook installer — merge, never clobber.
 *
 * The file it edits is the operator's `~/.claude/settings.json`: every key that
 * is not ours survives byte-for-byte (its order, its indentation, its line
 * ending), a second install changes nothing, uninstall gives back what was
 * there, an entry pointing at another checkout is refreshed rather than
 * duplicated, and a file that does not parse is refused. Everything runs
 * against a temp directory — no real `~/.claude` is touched.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  HOOK_EVENTS, HOOK_TIMEOUT_SECONDS, defaultSettingsPath, hookCommand, hooksStatus, installHooks, uninstallHooks,
} = await import('../server/hooks-install.ts');

const SKILL = '/opt/skills/phased-execution';
const OTHER = '/home/someone/.claude-b/skills/phased-execution';

function scratch(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-hooks-'));
  return { dir, path: join(dir, 'settings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A settings file like a real operator's: unrelated keys, other tools' hooks, 2-space indent. */
const EXISTING = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(git status)"],
    "deny": []
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/skills/other/bin/other-session-update"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/hooks/notify.sh \\"Claude finished\\" \\"Glass\\""
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/hooks/notify.sh \\"Attention\\" \\"Ping\\""
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "phased-execution@local": true
  }
}
`;

test('a fresh install creates the file with exactly the four entries, 2-space indent, trailing newline', () => {
  const { path, cleanup } = scratch();
  try {
    const status0 = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status0.exists, false);
    assert.equal(status0.installed, false);
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    const raw = readFileSync(path, 'utf8');
    assert.ok(raw.endsWith('\n'));
    const json = JSON.parse(raw) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
    assert.deepEqual(Object.keys(json), ['hooks']);
    assert.deepEqual(Object.keys(json.hooks), [...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      assert.equal(json.hooks[event].length, 1);
      assert.deepEqual(json.hooks[event][0], {
        hooks: [{ type: 'command', command: `bash "${SKILL}/scripts/session-hook.sh"`, timeout: HOOK_TIMEOUT_SECONDS }],
      });
    }
    assert.equal(hookCommand(SKILL), `bash "${SKILL}/scripts/session-hook.sh"`);
    assert.match(raw, /^ {2}"hooks": \{/m);
  } finally { cleanup(); }
});

test('an existing file keeps every unrelated key, every other tool\'s hook and their order; uninstall restores the bytes', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, EXISTING, 'utf8');
    const before = JSON.parse(EXISTING) as Record<string, unknown>;
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    const after = JSON.parse(readFileSync(path, 'utf8')) as typeof before & { hooks: Record<string, unknown[]> };
    // Unrelated keys: identical, same order.
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const key of Object.keys(before)) if (key !== 'hooks') assert.deepEqual(after[key], before[key]);
    // Other tools' hook groups: identical, first, untouched; ours appended.
    const beforeHooks = before.hooks as Record<string, unknown[]>;
    assert.deepEqual(after.hooks.SessionStart[0], beforeHooks.SessionStart[0]);
    assert.deepEqual(after.hooks.Stop[0], beforeHooks.Stop[0]);
    // Notification is one of ours since 2026-08-23: the operator's own group
    // stays first and untouched, ours is appended beside it.
    assert.deepEqual(after.hooks.Notification[0], beforeHooks.Notification[0]);
    assert.equal(after.hooks.SessionStart.length, 2);
    assert.equal(after.hooks.Stop.length, 2);
    assert.equal(after.hooks.Notification.length, 2);
    assert.equal(after.hooks.SessionEnd.length, 1);
    // Event order: the file's own events first, the new one after.
    assert.deepEqual(Object.keys(after.hooks), ['SessionStart', 'Stop', 'Notification', 'SessionEnd']);
    // Uninstall: byte-identical to what was there.
    const back = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(back.changed, true);
    assert.equal(readFileSync(path, 'utf8'), EXISTING);
    assert.equal(back.status.installed, false);
    assert.equal(back.status.partial, false);
  } finally { cleanup(); }
});

test('install is idempotent: the second run writes nothing and the bytes are unchanged', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, EXISTING, 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const once = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const again = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(again.changed, false);
    assert.equal(readFileSync(path, 'utf8'), once);
    assert.equal(statSync(path).mtimeMs, mtime);
  } finally { cleanup(); }
});

test('an entry pointing at another checkout reads stale and is refreshed in place, never duplicated', () => {
  const { path, cleanup } = scratch();
  try {
    installHooks({ settingsPath: path, skillDir: OTHER });
    const stale = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(stale.installed, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.partial, true);
    assert.deepEqual(stale.events, { SessionStart: true, SessionEnd: true, Stop: true, Notification: true });
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    assert.equal(out.status.stale, false);
    const json = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    for (const event of HOOK_EVENTS) {
      assert.equal(json.hooks[event].length, 1, `${event}: one group, not two`);
      assert.equal(json.hooks[event][0].hooks[0].command, hookCommand(SKILL));
    }
  } finally { cleanup(); }
});

test('a partial install (one event missing) reads partial and install completes it', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand(SKILL), timeout: 3 }] }] },
    }, null, 2) + '\n', 'utf8');
    const status = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status.installed, false);
    assert.equal(status.partial, true);
    assert.deepEqual(status.events, { SessionStart: true, SessionEnd: false, Stop: false, Notification: false });
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.status.installed, true);
  } finally { cleanup(); }
});

test('the file\'s own indentation (tabs, 4 spaces) and CRLF line endings are kept', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, '{\n\t"model": "opus",\n\t"permissions": {\n\t\t"allow": []\n\t}\n}\n', 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const tabbed = readFileSync(path, 'utf8');
    assert.match(tabbed, /^\t"model": "opus",\n/m);
    assert.match(tabbed, /^\t"hooks": \{\n\t\t"SessionStart"/m);
    uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(readFileSync(path, 'utf8'), '{\n\t"model": "opus",\n\t"permissions": {\n\t\t"allow": []\n\t}\n}\n');

    writeFileSync(path, '{\r\n    "model": "opus"\r\n}\r\n', 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const crlf = readFileSync(path, 'utf8');
    assert.ok(crlf.includes('\r\n    "hooks": {\r\n        "SessionStart"'));
    assert.ok(!/[^\r]\n/.test(crlf), 'no bare LF');
    uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(readFileSync(path, 'utf8'), '{\r\n    "model": "opus"\r\n}\r\n');
  } finally { cleanup(); }
});

test('a settings file that does not parse is refused untouched, by install and by uninstall', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, '{ "model": "opus", ', 'utf8');
    const status = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status.installed, false);
    assert.ok(status.parseError);
    assert.throws(() => installHooks({ settingsPath: path, skillDir: SKILL }), /does not parse/);
    assert.throws(() => uninstallHooks({ settingsPath: path, skillDir: SKILL }), /does not parse/);
    assert.equal(readFileSync(path, 'utf8'), '{ "model": "opus", ');
    assert.ok(!existsSync(`${path}.tmp.${process.pid}`));
  } finally { cleanup(); }
});

test('uninstall on a file that never had our entries (or does not exist) changes nothing', () => {
  const { path, dir, cleanup } = scratch();
  try {
    const none = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(none.changed, false);
    assert.ok(!existsSync(path));
    writeFileSync(path, EXISTING, 'utf8');
    const out = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, false);
    assert.equal(readFileSync(path, 'utf8'), EXISTING);
    // And the default path follows CLAUDE_CONFIG_DIR like the CLI does.
    const conf = join(dir, 'conf'); mkdirSync(conf);
    assert.equal(defaultSettingsPath({ CLAUDE_CONFIG_DIR: conf }), join(conf, 'settings.json'));
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The hook itself, with no console to answer (zero-touch phase 16)
 * ------------------------------------------------------------------ */

/**
 * REG-2 and REG-3 (iv), end to end through the real script. With no console
 * the hook used to write a drop and stop — nothing drained it until a console
 * booted, and a starting session learned nothing about who else was in its
 * repository. Now it drains the inbox itself (`phase-console sessions ingest`,
 * through the registry's own code) and, at SessionStart, names the live peers.
 */
test('REG-2 / REG-3 (iv): with no console answering, the hook drains its own inbox and tells a starting session who else is live in the repository', async () => {
  const { spawnSync } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { realpathSync } = await import('node:fs');
  const { SKILL_DIR } = await import('../server/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-hook-e2e-'));
  try {
    const root = join(dir, 'project');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    const real = realpathSync(root);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as { port: number };
        probe.close(() => resolve(address.port));
      });
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'),
      CLAUDE_PID: String(process.pid),
    };
    for (const key of ['DOCS_ROOT', 'PE_SESSION_ID', 'PE_OWNER', 'PE_SCOPE', 'PE_OUTCOME_FILE', 'PHASE_CONSOLE_URL', 'PHASE_CONSOLE_HOOK_OFF', 'PHASE_CONSOLE_HOOK_INGEST', 'PHASE_CONSOLE_PROBE', 'CLAUDE_CODE_SESSION_ID']) {
      delete env[key];
    }
    // The instance, on a port nothing listens on — so the POST is refused.
    const registered = spawnSync(process.execPath, [join(SKILL_DIR, 'viewer', 'shared', 'instances.mjs'), 'register', real, '--name', 'hook-e2e', '--port', String(port), '--default'], { env, encoding: 'utf8' });
    assert.equal(registered.status, 0, registered.stderr);
    const shell = spawnSync(process.execPath, [join(SKILL_DIR, 'viewer', 'shared', 'instances.mjs'), 'shell', '--root', real], { env, encoding: 'utf8' });
    const stateDir = /^state_dir=(.*)$/m.exec(shell.stdout)![1];
    const hook = (event: string, sessionId: string) => spawnSync('/bin/bash', [join(SKILL_DIR, 'scripts', 'session-hook.sh')], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: real, transcript_path: `/t/${sessionId}.jsonl`, source: 'startup' }),
      env, encoding: 'utf8', cwd: real, timeout: 20_000,
    });

    const first = hook('SessionStart', 's-hook-first');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /this Claude session's id is s-hook-first/);
    assert.doesNotMatch(first.stdout, /other live Claude session/, 'alone in its repository, it is told nothing new');
    const firstRecord = JSON.parse(readFileSync(join(stateDir, 'sessions', 's-hook-first.json'), 'utf8'));
    assert.equal(firstRecord.lastEvent.via, 'cli', 'drained by the hook\'s own ingest, with no console');

    const second = hook('SessionStart', 's-hook-second');
    assert.equal(second.status, 0, second.stderr);
    const context = JSON.parse(second.stdout.trim()).hookSpecificOutput.additionalContext as string;
    assert.match(context, /this Claude session's id is s-hook-second/);
    assert.match(context, /The session registry shows one other live Claude session in this repository: s-hook-f/);

    // Any other event drains in the background and returns at once.
    const stop = hook('Stop', 's-hook-second');
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '', 'a Stop says nothing to the session');
    let turns = 0;
    for (let i = 0; i < 200 && turns !== 1; i++) {
      try { turns = JSON.parse(readFileSync(join(stateDir, 'sessions', 's-hook-second.json'), 'utf8')).turns; } catch { turns = 0; }
      if (turns !== 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(turns, 1, 'the background drain applied the Stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
