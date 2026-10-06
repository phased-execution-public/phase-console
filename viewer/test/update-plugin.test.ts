/**
 * One update moves both halves (control-tower phase 98, exit criterion 7, #151).
 *
 * The console updated itself and the skill every session reads did not: the
 * plugin sat on a marketplace clone 49 commits behind the console that launched
 * the sessions, which ran the console's newer scripts from a SKILL.md that did
 * not know them, and wrote the clone's script paths into their handoffs.
 *
 *   UP-1 `scripts/update-plugin.sh` — the hand-run marketplace step, in the repo:
 *        the clone fast-forwards, every config dir's plugin moves to it and says
 *        its commit, and the cache loses only versions OLDER than a registered one.
 *   UP-2 `phase-console update-plugin` runs it; `self-update.sh` runs it after a
 *        fast-forward, and its failure is a warning, never the update's.
 *   UP-3 ONE reader of the copy each config dir carries (`installed_plugins.json`),
 *        against the console's `distRev`: the doctor's row, `/api/state`'s field
 *        and the inbox's health row all say it.
 *   UP-4 `$PE_SCRIPTS` is in every session's environment and is how the
 *        console's prompts name a script; the boot prompt carries the console's
 *        commit and says when the session's skill is at another one.
 *   UP-5 `install-skill` refuses a second copy while the plugin is installed.
 *   UP-6 `skill-api.env`: a console and a skill whose interfaces do not meet
 *        refuse a start, saying which half to update.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCRIPTS_REF, SKILL_PLUGIN_ID, claudeConfigDirs, readSkillApi, readSkillCopy, sameCommit, skillApiVerdict,
  skillCopyReport, skillCopyVerdict,
} from '../server/skill-copy.ts';
import { doctorReport, skipped, type DoctorDeps } from '../server/doctor.ts';
import { preludeFor, type PreludeDeps } from '../server/prelude.ts';
import { buildInbox } from '../server/inbox.ts';
import { closeoutPrompt, consoleSkillDirective } from '../server/runner/runner-core.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OLD = '77e57a59b79b1f2c3d4e5f60718293a4b5c6d7e8';
const NEW = '8bd2f800320d9ca5519a791a83affb65bd4de561';

const temps: string[] = [];
function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pc-update-plugin-${label}-`));
  temps.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

/** A Claude Code config dir that registered the plugin at `commit` (user scope), as Claude Code writes it. */
function configDir(root: string, name: string, commit: string | null, extra: Record<string, unknown[]> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  const plugins: Record<string, unknown[]> = { ...extra };
  if (commit) {
    const version = commit.slice(0, 12);
    const installPath = join(dir, 'plugins', 'cache', 'phased-execution-public', 'phased-execution', version);
    mkdirSync(installPath, { recursive: true });
    plugins[SKILL_PLUGIN_ID] = [{
      scope: 'user', installPath, version, installedAt: '2026-09-26T10:20:36.306Z',
      lastUpdated: '2026-09-26T10:20:36.306Z', gitCommitSha: commit,
    }];
  }
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
  return dir;
}

/* ------------------------------------------------------------------ *
 * UP-3 — the one reader
 * ------------------------------------------------------------------ */

test('UP-3: the reader names the ONE copy each config dir carries — the user-scope plugin install, its path and its commit', () => {
  const root = temp('reader');
  const a = configDir(root, '.claude', NEW);
  const b = configDir(root, '.claude-a', OLD, {
    // A project-scope install of an older copy is not the one a session under this dir reads by default.
    'phased-execution@phased-execution-public': [],
    'skill-creator@claude-plugins-official': [{ scope: 'user', installPath: '/x', version: 'fa59bc903774' }],
  });
  const copyA = readSkillCopy(a);
  assert.equal(copyA.install?.commit, NEW);
  assert.equal(copyA.install?.version, NEW.slice(0, 12));
  assert.equal(copyA.install?.installPath, join(a, 'plugins', 'cache', 'phased-execution-public', 'phased-execution', NEW.slice(0, 12)));
  assert.equal(copyA.skillDir, null, 'no second copy under skills/');
  assert.equal(readSkillCopy(b).install?.commit, OLD);

  const none = readSkillCopy(configDir(root, '.claude-b', null));
  assert.equal(none.install, null, 'a dir that registered no plugin carries no copy');
  const broken = join(root, 'broken');
  mkdirSync(join(broken, 'plugins'), { recursive: true });
  writeFileSync(join(broken, 'plugins', 'installed_plugins.json'), '{ not json');
  assert.match(readSkillCopy(broken).parseError ?? '', /./, 'a file that does not parse is said, never a crash');

  // A stamped install-skill copy beside the plugin is the second copy #151 counted.
  mkdirSync(join(a, 'skills', 'phased-execution'), { recursive: true });
  assert.equal(readSkillCopy(a).skillDir, join(a, 'skills', 'phased-execution'));
});

test('UP-3: the config dirs are PE_CLAUDE_CONFIG_DIRS when set, else CLAUDE_CONFIG_DIR and ~/.claude{,-a,-b} — only those that exist', () => {
  const home = temp('home');
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.claude-b'));
  const custom = temp('custom');
  assert.deepEqual(claudeConfigDirs({ HOME: home }, home), [join(home, '.claude'), join(home, '.claude-b')]);
  assert.deepEqual(claudeConfigDirs({ HOME: home, CLAUDE_CONFIG_DIR: custom }, home), [custom, join(home, '.claude'), join(home, '.claude-b')]);
  assert.deepEqual(claudeConfigDirs({ HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, home), [join(home, '.claude'), join(home, '.claude-b')],
    'one dir named twice is read once');
  assert.deepEqual(claudeConfigDirs({ HOME: home, PE_CLAUDE_CONFIG_DIRS: `${custom} ${join(home, 'nope')}` }, home), [custom]);
});

test('UP-3: against the console’s distRev — the same commit is ok, another commit fails the row (never blocking), no plugin skips', async () => {
  const root = temp('verdict');
  const same = configDir(root, '.claude', NEW);
  const behind = configDir(root, '.claude-a', OLD);
  assert.equal(sameCommit(NEW, NEW.slice(0, 12)), true, 'a 12-character version names its commit');
  assert.equal(sameCommit(OLD, NEW), false);
  assert.equal(sameCommit(null, NEW), null, 'an unknown side is no verdict');

  const ok = skillCopyReport({ configDirs: [same], consoleRev: NEW });
  assert.deepEqual(ok.drift, []);
  const okRow = skillCopyVerdict(ok);
  assert.equal(okRow.status, 'ok');
  assert.ok(okRow.reason.includes(NEW.slice(0, 12)), okRow.reason);

  const drifted = skillCopyReport({ configDirs: [same, behind], consoleRev: NEW });
  assert.deepEqual(drifted.drift.map((copy) => copy.configDir), [behind]);
  const red = skillCopyVerdict(drifted);
  assert.equal(red.status, 'fail');
  assert.ok(red.reason.includes(behind) && red.reason.includes(OLD.slice(0, 12)) && red.reason.includes(NEW.slice(0, 12)), red.reason);
  assert.match(red.reason, /update/);

  const nothing = skillCopyVerdict(skillCopyReport({ configDirs: [configDir(root, '.claude-b', null)], consoleRev: NEW }));
  assert.equal(nothing.status, 'skip');
  assert.match(nothing.reason, /no plugin copy/);

  const unbuilt = skillCopyVerdict(skillCopyReport({ configDirs: [behind], consoleRev: null }));
  assert.equal(unbuilt.status, 'ok', 'a console that cannot say its own commit judges nothing');

  // In the report: a row of its own, after the hooks, never blocking.
  const deps = doctorDeps({ skillCopy: () => drifted });
  const report = await doctorReport(deps);
  const row = report.rows.find((r) => r.id === 'skill');
  assert.ok(row, `there is no skill row: ${report.rows.map((r) => r.id).join(', ')}`);
  assert.equal(row.label, 'Skill copy');
  assert.equal(row.blocking, false, 'a drifted skill still runs a console — it is told, not stopped');
  assert.equal(row.status, 'fail');
  assert.equal(report.ok, true);
  const ids = report.rows.map((r) => r.id);
  // Beside the other half of the Claude Code wiring: the hooks, then the hooks'
  // reach on every account (`presence`, control-tower phase 108, #194), then
  // the skill copy.
  const hooks = ids.indexOf('hooks');
  assert.deepEqual(ids.slice(hooks, hooks + 3), ['hooks', 'presence', 'skill'], 'beside the other half of the Claude Code wiring');
  assert.equal((await doctorReport(doctorDeps())).rows.find((r) => r.id === 'skill')?.status, 'skip',
    'a deps builder that cannot read the copies says so');
});

function doctorDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const okv = (reason: string) => ({ status: 'ok' as const, ok: true, reason });
  return {
    instance: null, mode: 'offline',
    accounts: async () => okv('the machine login'),
    mcp: async () => skipped('no MCP server registered'),
    credentials: async () => okv('held'),
    delivery: async () => okv('1 subscribed device'),
    hooks: async () => null,
    unit: async () => null,
    cliVersion: async () => '2.1.280',
    gh: async () => okv('signed in'),
    git: async () => ({ version: 'git version 2.50.0', code: 0, insideWorkTree: null }),
    environment: () => [],
    console: async () => null,
    ...over,
  };
}

test('UP-3: the inbox raises one needs-you health row per drifted copy, naming both commits and the fix', () => {
  const root = temp('inbox');
  const drifted = configDir(root, '.claude', OLD);
  const { items } = buildInbox({ skillCopy: skillCopyReport({ configDirs: [drifted], consoleRev: NEW }) });
  const rows = items.filter((item) => item.kind === 'health' && /skill/i.test(item.title));
  assert.equal(rows.length, 1, JSON.stringify(items));
  const [row] = rows;
  assert.equal(row.severity, 'needs-you');
  assert.ok(row.need.includes(OLD.slice(0, 12)) && row.need.includes(NEW.slice(0, 12)) && row.need.includes(drifted), row.need);
  assert.match(row.how, /update/);
  const current = buildInbox({ skillCopy: skillCopyReport({ configDirs: [configDir(root, '.claude-a', NEW)], consoleRev: NEW }) });
  assert.deepEqual(current.items.filter((item) => /skill/i.test(item.title)), [], 'a copy at the console’s commit raises nothing');
});

/* ------------------------------------------------------------------ *
 * UP-4 — $PE_SCRIPTS, and the boot prompt's word on the skill
 * ------------------------------------------------------------------ */

test('UP-4: every spawned session carries PE_SCRIPTS — the console’s scriptsDir — and the console’s prompts name scripts through it', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const scripts = temp('scripts');
  const runner = new Runner({ scriptsDir: scripts, verificationText: () => '`true`' });
  const env = await (runner as unknown as { sessionEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> }).sessionEnv({});
  assert.equal(env.PE_SCRIPTS, scripts);
  assert.equal(SCRIPTS_REF, '$PE_SCRIPTS');

  const closeout = closeoutPrompt('demo', 3, 'in-progress');
  assert.ok(closeout.includes('$PE_SCRIPTS/phase-outcome.sh demo 3 waiting-external'), closeout);
  assert.ok(closeout.includes('$PE_SCRIPTS/new-handoff.sh demo 3'), closeout);
  assert.doesNotMatch(closeout, /[`\s]scripts\/(phase-outcome|new-handoff)\.sh/, 'never a path relative to whatever the cwd is');
});

test('UP-4: the boot prompt carries the console’s commit, and tells a session whose skill copy is at another commit', () => {
  assert.equal(consoleSkillDirective(null), '', 'a harness that wires nothing composes the prompt it always did');
  assert.equal(consoleSkillDirective({ consoleRev: null, skill: null }), '', 'an unbuilt console with no copy has nothing to say');
  const same = consoleSkillDirective({ consoleRev: NEW, skill: { configDir: '/h/.claude', commit: NEW, installPath: '/h/.claude/plugins/cache/x' } });
  assert.ok(same.includes(NEW.slice(0, 12)), same);
  assert.ok(same.includes('$PE_SCRIPTS'), same);
  assert.doesNotMatch(same, /ANOTHER commit/);
  const drift = consoleSkillDirective({ consoleRev: NEW, skill: { configDir: '/h/.claude-a', commit: OLD, installPath: '/h/.claude-a/plugins/cache/x' } });
  assert.ok(drift.includes(OLD.slice(0, 12)) && drift.includes(NEW.slice(0, 12)), drift);
  assert.match(drift, /ANOTHER commit/);
  assert.ok(drift.includes('/h/.claude-a'), 'names the config dir whose copy it is');
});

test('UP-4: a boarding sends PE_SCRIPTS, `$PE_SCRIPTS/…` in the contract, and the console’s commit with the drift', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const root = temp('board-root');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '---\nslug: demo\n---\n# demo\n');
  const scripts = temp('board-scripts');
  const doneFile = join(root, 'done.txt');
  writeFileSync(doneFile, '');
  const script = (name: string, body: string) => { writeFileSync(join(scripts, name), body); chmodSync(join(scripts, name), 0o755); };
  script('phase-graph.sh', `#!/usr/bin/env bash
shift
case "\${1:-}" in
  --memory-block) if grep -qx 1 "${doneFile}"; then echo "done: 1"; echo "ready:"; else echo "done:"; echo "ready: 1"; fi; echo "waiting:" ;;
  --boot-prompt) echo "BOOT phase \${2:-}" ;;
  --gate-status) echo clear ;;
  *) echo "" ;;
esac
`);
  for (const name of ['phase-lock.sh', 'next-phase-prompt.sh', 'new-handoff.sh']) script(name, '#!/usr/bin/env bash\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  const sent: { prompt: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  const runner = new Runner({
    scriptsDir: scripts,
    verificationText: () => '`true`',
    consoleSkill: () => ({ consoleRev: NEW, skill: { configDir: '/h/.claude', commit: OLD, installPath: '/h/.claude/plugins/cache/x' } }),
    spawn: async (request) => {
      sent.push({ prompt: request.prompt, env: request.env });
      writeFileSync(doneFile, '1\n');
      return {
        signal: { subtype: 'success', code: 0, text: '' },
        sessionId: 'sess-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
      };
    },
  } as ConstructorParameters<typeof Runner>[0]);
  await runner.start({ slug: 'demo', root } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  const boarding = sent.find((one) => one.prompt.startsWith('BOOT phase 1'));
  assert.ok(boarding, `phase 1 boarded: ${sent.map((one) => one.prompt.slice(0, 40)).join(' | ')}`);
  assert.equal(boarding.env?.PE_SCRIPTS, scripts);
  assert.ok(boarding.prompt.includes('bash $PE_SCRIPTS/phase-outcome.sh demo 1 waiting-external'), 'the contract names the script through the variable');
  assert.ok(!boarding.prompt.includes(`${scripts}/phase-outcome.sh`), 'never through the clone path');
  assert.ok(boarding.prompt.includes(NEW.slice(0, 12)) && boarding.prompt.includes(OLD.slice(0, 12)), 'the console’s commit and the copy’s');
});

/* ------------------------------------------------------------------ *
 * UP-5 — install-skill refuses a second copy
 * ------------------------------------------------------------------ */

test('UP-5: install-skill refuses a second copy while the plugin is installed — naming the copy — and --force still installs', () => {
  // In the free tree `bin/phase-console.mjs` IS the free bin, and `free/` is not there to name.
  const bins = [join(REPO, 'bin', 'phase-console.mjs')];
  for (const bin of bins) {
    const root = temp('install-skill');
    const withPlugin = configDir(root, '.claude', NEW);
    const run = (dir: string, ...extra: string[]) => spawnSync(process.execPath, [bin, 'install-skill', ...extra], {
      encoding: 'utf8', env: { ...process.env, PHASE_CONSOLE_HOME: REPO, CLAUDE_CONFIG_DIR: dir, HOME: root },
    });
    const refused = run(withPlugin);
    assert.equal(refused.status, 1, `${bin}: ${refused.stdout}${refused.stderr}`);
    assert.ok(refused.stderr.includes(SKILL_PLUGIN_ID), refused.stderr);
    assert.ok(refused.stderr.includes(NEW.slice(0, 12)), 'names the commit of the copy in use');
    assert.ok(refused.stderr.includes(join(withPlugin, 'plugins', 'cache')), 'and its path');
    assert.match(refused.stderr, /--force/);
    assert.equal(existsSync(join(withPlugin, 'skills', 'phased-execution')), false, 'nothing was copied');

    const forced = run(withPlugin, '--force');
    assert.equal(forced.status, 0, `${bin}: ${forced.stderr}`);
    assert.equal(existsSync(join(withPlugin, 'skills', 'phased-execution', 'SKILL.md')), true);

    const bare = configDir(root, '.claude-bare', null);
    assert.equal(run(bare).status, 0, 'no plugin registered: install-skill does what it always did');
  }
});

/* ------------------------------------------------------------------ *
 * UP-6 — the interface pair
 * ------------------------------------------------------------------ */

test('UP-6: skill-api.env ships beside the scripts, and its pair reads as numbers; an absent file is no verdict', () => {
  const shipped = readSkillApi(join(REPO, 'scripts'));
  assert.ok(shipped, 'scripts/skill-api.env ships');
  assert.ok(Number.isInteger(shipped.api) && Number.isInteger(shipped.min) && shipped.min <= shipped.api, JSON.stringify(shipped));
  assert.equal(readSkillApi(temp('no-api')), null);

  const at = (api: number, min: number) => ({ api, min, file: '/x/skill-api.env' });
  assert.equal(skillApiVerdict(at(3, 2), at(3, 2)), null, 'the same interface');
  assert.equal(skillApiVerdict(at(3, 2), at(2, 1)), null, 'an older skill the console still speaks');
  assert.equal(skillApiVerdict(null, at(1, 1)), null, 'no console stamp: no verdict');
  assert.equal(skillApiVerdict(at(3, 2), null), null, 'no skill stamp: no verdict');
  assert.equal(skillApiVerdict(at(3, 3), at(2, 1))?.update, 'skill', "the skill's scripts reject flags the console uses");
  assert.equal(skillApiVerdict(at(2, 1), at(4, 3))?.update, 'console', 'the console rejects what the skill uses');
});

test('UP-6: the prelude refuses a start across a mismatch — "update the skill" or "update the console" — and never on a missing stamp', async () => {
  const at = (api: number, min: number) => ({ api, min, file: '/x/skill-api.env' });
  // The deps builder's shape: each copy with the one comparison's verdict already reached.
  const facts = (consoleApi: ReturnType<typeof at>, api: ReturnType<typeof at> | null) => ({
    console: consoleApi,
    copies: [{ configDir: '/h/.claude', installPath: '/h/.claude/plugins/cache/p/8bd2f800320d', api, mismatch: skillApiVerdict(consoleApi, api) }],
  });
  const skillBehind = await preludeFor('alpha', {}, preludeDeps({ skillApi: () => facts(at(3, 3), at(2, 1)) }));
  assert.equal(skillBehind.probes.skill.status, 'fail');
  assert.match(skillBehind.probes.skill.reason, /update the skill/);
  assert.deepEqual(skillBehind.blocking.map((b) => b.key), ['skill']);

  const consoleBehind = await preludeFor('alpha', {}, preludeDeps({ skillApi: () => facts(at(2, 1), at(4, 3)) }));
  assert.match(consoleBehind.probes.skill.reason, /update the console/);
  assert.deepEqual(consoleBehind.blocking.map((b) => b.key), ['skill']);

  const unstamped = await preludeFor('alpha', {}, preludeDeps({ skillApi: () => facts(at(2, 1), null) }));
  assert.equal(unstamped.probes.skill.status, 'skip');
  assert.deepEqual(unstamped.blocking, []);
  const agreed = await preludeFor('alpha', {}, preludeDeps({ skillApi: () => facts(at(2, 1), at(2, 1)) }));
  assert.equal(agreed.probes.skill.status, 'ok');
  const unasked = await preludeFor('alpha', {}, preludeDeps());
  assert.equal(unasked.probes.skill.status, 'skip', 'a caller with no skill fact refuses nothing');
});

function preludeDeps(over: Partial<PreludeDeps> = {}): PreludeDeps {
  return {
    decisions: () => ({ rows: [], present: false }),
    planAccounts: () => [],
    planCredentials: () => ({ ids: [], policy: null }),
    planMcp: () => ({ ids: [], policy: null }),
    accounts: {
      defaultId: 'default', has: () => false, authStateFor: () => 'ok', entitlementOf: () => ({ state: 'entitled' }),
      headroom: (id) => ({ ok: true, accountId: id, fiveHourPct: 10 }), labelFor: () => 'the machine login',
    },
    mcp: { preflight: async () => ({ ok: true, blocking: [], unknown: [] }) },
    credentials: { held: async () => [] },
    delivery: async () => ({ devices: 1, notifyCommand: false, webhooks: 0, remote: false }),
    prefs: { policy: null },
    now: () => '2026-09-27T12:00:00.000Z',
    ...over,
  };
}

