#!/usr/bin/env node
// Phase Console, as a bin on PATH — the FREE tree.
//
//   phase-console                        pick the plan directory in the browser
//   phase-console ~/code/your-repo       open that directory straight away
//   phase-console --allow-writes         also enable the guarded write verbs
//   phase-console install-skill          copy the skill where Claude Code reads it
//   phase-console uninstall-skill        take that copy away again
//   phase-console install-hooks          add the session-presence hook to ~/.claude/settings.json
//   phase-console uninstall-hooks        take it out again · hooks-status: is it there?
//   phase-console doctor [instance]      the prelude's probes and the machine checks; exit 1 names the first failing row
//   phase-console sessions ingest [instance]  drain the session-presence inbox with no console up
//
// This file replaces `bin/phase-console.mjs`, which is Pro: it is the
// multi-instance CLI (`list`, `open`, `start`, `stop`, `restart`, `status`,
// `logs`, `remove`, `update`, `autostart`, `profile`, `fleet` and the
// `--agent-*` flags), and every one of those verbs drives the registry's second
// slot, the machine profile, `viewer/deploy/` or `viewer/fleet/`, none of which
// exists here. What could not simply vanish with it is the rest of this
// file: npm's `bin` target, the node floor, the package-root resolver, and the
// five skill/hook verbs, which the free tier needs most of all — installing the
// skill is how anyone uses this at all.
//
// The bash `bin/phase-console` next to this file serves the plugin route, where
// Claude Code puts the real bin/ directory on PATH. npm instead exposes the
// command through a SYMLINK, and bash's $BASH_SOURCE resolves to the symlink's
// directory — the wrong place. This shim resolves the package root itself.

import {
  cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- node version gate -----------------------------------------------------
// First, before anything imports server code: the server is TypeScript run
// directly, which needs node >= 22.18 (or >= 23.6 — 23.0-23.5 still kept type
// stripping behind a flag). This file itself stays plain JS so an old node can
// parse far enough to print the refusal instead of a syntax-error stack.
const parts = process.versions.node.split('.').map(Number);
const ok = parts[0] >= 24
  || (parts[0] === 23 && parts[1] >= 6)
  || (parts[0] === 22 && parts[1] >= 18);
if (!ok) {
  process.stderr.write(
    `phase-console: node ${process.version} is too old — needs >=22.18 or >=23.6 (runs TypeScript directly)\n`,
  );
  process.exit(1);
}

// ---- package root ----------------------------------------------------------
// Candidates, in order: an explicit PHASE_CONSOLE_HOME always wins; then
// argv[1] un-realpathed; then argv[1] realpathed, because npm's global bin is a
// symlink into node_modules and only its target sits inside the package.
const isRoot = (dir) => Boolean(dir) && existsSync(join(dir, 'viewer', 'server', 'index.ts'));
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
let root = null;
for (const candidate of [
  process.env.PHASE_CONSOLE_HOME,
  invoked && dirname(dirname(invoked)),
  invoked && dirname(dirname(safeRealpath(invoked))),
]) {
  if (isRoot(candidate)) { root = candidate; break; }
}
function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}
if (!root) {
  process.stderr.write(
    'phase-console: could not locate the package root (looked for viewer/server/index.ts).\n'
    + 'Set PHASE_CONSOLE_HOME to the phase-console install directory.\n',
  );
  process.exit(1);
}

// Node refuses to type-strip .ts under any node_modules directory — which is
// where npm global installs and the npx cache live. The tarball ships a
// pre-stripped .js beside each of those entry points for exactly that case;
// everywhere else the .ts is the truth. Resolved HERE rather than beside the
// server spawn at the bottom, because the hook installer is imported from a
// verb that exits long before that line is ever evaluated.
const underNodeModules = root.split('/').includes('node_modules');
/** The shipped pair for one module: the .js only where a .ts cannot be read. */
function preferBuilt(dir, base) {
  const js = join(dir, `${base}.js`);
  const ts = join(dir, `${base}.ts`);
  const first = underNodeModules ? js : ts;
  const second = underNodeModules ? ts : js;
  return existsSync(first) ? first : second;
}

// ---- the skill, where Claude Code reads it ---------------------------------
// A packaged copy puts the console on PATH but Claude Code discovers SKILLS
// from ~/.claude/skills (or CLAUDE_CONFIG_DIR). `install-skill` closes that
// gap: it copies the skill's files — never the viewer — into place, and stamps
// the copy so only its own copies are ever overwritten or removed.
const args = process.argv.slice(2);
const SKILL_STAMP = '.installed-by-phase-console';
const SKILL_FILES = ['SKILL.md', 'USAGE.md', 'scripts', 'templates', 'references', 'assets'];

function skillDest() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude');
  return join(base, 'skills', 'phased-execution');
}

function installSkill(force) {
  const dest = skillDest();
  if (safeRealpath(dest) === safeRealpath(root)) {
    process.stdout.write(`phase-console: the skill already lives where Claude Code reads it (${dest}).\n`);
    return 0;
  }
  if (existsSync(join(dest, '.git'))) {
    process.stderr.write(
      `phase-console: ${dest} is a git clone — update it with git pull, not by overwriting it.\n`,
    );
    return 1;
  }
  if (existsSync(dest) && !existsSync(join(dest, SKILL_STAMP)) && !force) {
    process.stderr.write(
      `phase-console: ${dest} exists and was not put there by this command.\n`
      + 'Re-run with --force to replace it.\n',
    );
    return 1;
  }
  mkdirSync(dest, { recursive: true });
  for (const f of SKILL_FILES) {
    cpSync(join(root, f), join(dest, f), { recursive: true, force: true });
  }
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? version; } catch { /* stamp still written */ }
  writeFileSync(join(dest, SKILL_STAMP), `${version}\n`);
  process.stdout.write(
    `installed the skill at ${dest} (from phase-console ${version}).\n`
    + 'Restart Claude Code (or /reload-plugins) and it appears as /phased-execution.\n'
    + 'Re-run install-skill after a package update to refresh it.\n',
  );
  return 0;
}

function uninstallSkill() {
  const dest = skillDest();
  if (!existsSync(dest)) { process.stdout.write('phase-console: no skill copy to remove.\n'); return 0; }
  if (!existsSync(join(dest, SKILL_STAMP))) {
    process.stderr.write(
      `phase-console: ${dest} was not installed by this command — refusing to delete it.\n`,
    );
    return 1;
  }
  rmSync(dest, { recursive: true, force: true });
  process.stdout.write(`removed ${dest}.\n`);
  return 0;
}

if (['install-skill', '--install-skill'].includes(args[0])) {
  process.exit(installSkill(args.includes('--force')));
}
if (['uninstall-skill', '--uninstall-skill'].includes(args[0])) {
  process.exit(uninstallSkill());
}

// ---- the session-presence hook ---------------------------------------------
// `install-hooks` writes four entries (SessionStart, SessionEnd, Stop, Notification)
// into the user's ~/.claude/settings.json — merge, never clobber; idempotent — so
// every Claude session on this machine reports itself to the console that owns
// its directory; `uninstall-hooks` takes exactly those out; `hooks-status` says
// which is true (exit 0 installed, 1 not).
async function hooksVerb(verb, rest) {
  let mod;
  try {
    mod = await import(pathToFileURL(preferBuilt(join(root, 'viewer', 'server'), 'hooks-install')).href);
  } catch (error) {
    process.stderr.write(`phase-console: could not load the hook installer (${error.message})\n`);
    return 1;
  }
  const at = rest.indexOf('--settings');
  const settingsPath = at >= 0 ? rest[at + 1] : undefined;
  const opts = { skillDir: root, ...(settingsPath ? { settingsPath } : {}) };
  const describe = (status) => {
    const events = Object.entries(status.events).map(([event, has]) => `${event} ${has ? 'yes' : 'no'}`).join(', ');
    return `${status.path}: ${status.installed ? 'installed' : status.partial ? 'partially installed' : 'not installed'}`
      + `${status.stale ? ' (points at another checkout)' : ''}${status.parseError ? ` (file does not parse: ${status.parseError})` : ''}`
      + ` — ${events}`;
  };
  try {
    if (verb === 'hooks-status') {
      const status = mod.hooksStatus(opts);
      process.stdout.write(`${describe(status)}\n`);
      return status.installed ? 0 : 1;
    }
    const out = verb === 'install-hooks' ? mod.installHooks(opts) : mod.uninstallHooks(opts);
    process.stdout.write(`${out.changed ? (verb === 'install-hooks' ? 'installed' : 'removed') : 'nothing to change'} — ${describe(out.status)}\n`);
    if (verb === 'install-hooks' && out.changed) {
      process.stdout.write('Sessions started from now on report to the console that owns their directory; open ones do not until they restart.\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`phase-console: ${error.message}\n`);
    return 1;
  }
}
if (['install-hooks', 'uninstall-hooks', 'hooks-status'].includes(args[0])) {
  process.exit(await hooksVerb(args[0], args.slice(1)));
}

// ---- doctor ------------------------------------------------------------------
// The run-start prelude's probes with no plan in front of them, plus the
// machine checks (phase 11): asks a running console when one answers on the
// instance's port, reads the state directory and the machine when none does.
// The verb itself lives in `bin/doctor-verb.mjs`, shared with the free tree's
// bin, so neither copy of this file carries it twice.
if (['doctor', '--doctor'].includes(args[0])) {
  // `doctor fleet` asks after every console of the machine at once. Refused by
  // name here, because the shared verb would otherwise read `fleet` as the name
  // of an instance and answer that no such console exists.
  if (args[1] === 'fleet') {
    process.stderr.write(
      "phase-console: 'doctor fleet' checks a fleet of consoles, which is Phase Console Pro.\n"
      + 'This build checks one console:  phase-console doctor [<instance>]\n',
    );
    process.exit(2);
  }
  const { doctorVerb } = await import(pathToFileURL(join(root, 'bin', 'doctor-verb.mjs')).href);
  process.exit(await doctorVerb(args.slice(1), { root, preferBuilt }));
}

// ---- the session inbox, drained with no console ----------------------------
// `phase-console sessions ingest` (zero-touch phase 16, REG-2): the hook's
// drops applied through the registry's own code when no console is up — the
// hook itself runs it when its POST finds nobody. The verb lives in
// `bin/sessions-verb.mjs`, shared with the free tree's bin.
if (args[0] === 'sessions') {
  const { sessionsVerb } = await import(pathToFileURL(join(root, 'bin', 'sessions-verb.mjs')).href);
  process.exit(await sessionsVerb(args.slice(1), { root, preferBuilt }));
}

// ---- one run, exported ---------------------------------------------------
// `phase-console diagnostics --run <id>`: the run bundle from the command
// line, streamed from a live console and built from the state directory when
// none answers — because the moment somebody most needs one is the moment the
// console will not start. The verb lives in `bin/diagnostics-verb.mjs`, shared
// with the free tree's bin, so neither copy of this file carries it twice.
if (args[0] === 'diagnostics') {
  const { diagnosticsVerb } = await import(pathToFileURL(join(root, 'bin', 'diagnostics-verb.mjs')).href);
  process.exit(await diagnosticsVerb(args.slice(1), { root, preferBuilt }));
}

// ---- the fleet verbs, named rather than mistaken for a directory -----------
// Without this, a bare `list` reached the block below, which turns a bare first
// argument into `--root list` — so a verb that manages consoles would BOOT one,
// on a repository that does not exist. The same defect the Pro file's header
// records for `stop`. `start` is the exception: with one console it is not a
// fleet verb at all, so the word is dropped and the console runs.
//
// The agent flags are matched by SHAPE rather than spelled out. This file IS the
// free tree, so writing their names here would put the verbs the tree refuses
// back into the tree.
//
// The shape is `(un)install-agent` and `agent-<verb>`, NOT a loose `<word>-agent`:
// the loose one also matches `--allow-agent`, one of the seven capability
// switches, and refused it as a fleet verb. `viewer/test/fleet-refusal.test.ts`
// runs this predicate against every agent flag and every capability flag.
const FLEET_VERBS = new Set([
  'list', 'open', 'stop', 'restart', 'status', 'log', 'logs', 'update', 'remove',
  'autostart', 'profile', 'fleet',
]);
const isAgentFlag = (arg) => /^--(?:un)?install-agent$|^--agent-[a-z][a-z-]*$/.test(arg ?? '');
if (args[0] === 'start') args.shift();
if (FLEET_VERBS.has(args[0]) || isAgentFlag(args[0])) {
  process.stderr.write(
    `phase-console: '${args[0]}' manages a fleet of consoles, which is Phase Console Pro.\n`
    + 'This build runs one console for one repository:  phase-console [<repo>]\n',
  );
  process.exit(2);
}

// ---- bare first argument is the directory to open (mirror ../start) --------
if (args.length > 0 && !args[0].startsWith('-')) {
  args.splice(0, 1, '--root', args[0]);
}

// ---- run the server, forwarding exit faithfully ----------------------------
// Same rule as the hook installer above, and the same resolver: a `.js` left in
// a dev checkout by a packaging `tsc` run must never shadow the `.ts` that is
// the truth there.
const entry = preferBuilt(join(root, 'viewer', 'server'), 'index');

// stdio inherit puts the child in our foreground group, so Ctrl-C reaches it
// directly; the handlers below cover kills aimed at this process alone.
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('close', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
