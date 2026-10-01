// `phase-console doctor [instance] [--json]` — the verb, shared by the Pro bin
// (`bin/phase-console.mjs`) and the free tree's override, which import it by
// path so neither carries a second copy.
//
// Two modes, one report. With a console answering on the instance's port the
// verb asks IT (`GET /api/doctor`): the running console holds the accounts'
// meters, the MCP registry and its own health, and its answer is the truth.
// With none, the same rows are read from the state directory and the machine
// — the machine `claude` login, `gh auth status`, the CLI version against the
// relay floor, the session-presence hooks, the environment doctor, the unit —
// and the rows that need a live console say so (`skip`), never `ok`.
//
// Exit 1 names the first failing row that blocks; `--json` prints the report
// as the route serves it; `--help` prints this usage. Imports only leaves:
// `viewer/server/doctor.ts` and what it reads resolve no console identity at
// module load, so asking about any instance from any directory is safe.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

import { listStrayConsoles, stopStrayConsoles } from './stray-consoles.mjs';

// A list rather than one template, so the free build can drop the one row the
// free tree has no machinery for (the marker pair strips whole lines).
const USAGE = [
  'phase-console doctor [instance] [--json]',
  '',
  "  Runs the run-start prelude's probes with no plan in front of them, and the",
  '  machine checks a console needs to be worth starting: accounts, MCP servers,',
  '  the machine claude login, a delivery channel, the session-presence hooks,',
  "  the node arguments the console runs with, node-pty's spawn helper,",
  '  the Claude CLI version against the relay floor, gh auth status, the',
  "  environment doctor, and whether a console answers on the instance's port.",
  '',
  '  [instance]   an id, a name, or a project directory; default: the console for',
  '               the directory you are standing in',
  '  --json       print the report as GET /api/doctor serves it',
  '  --stop-strays  stop every stray console process this scan finds (#155):',
  '               a server whose own package root no longer exists, process',
  '               group, TERM then KILL, each one named',
  '  --help       this text',
  '',
  '  Exit 0 when every blocking row passes; exit 1 naming the first that does not.',
  '',
].join('\n');

/** `execFile` with stdout kept and a timeout the runtime enforces. */
function run(file, args, timeoutMs = 10_000, cwd) {
  return new Promise((done) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
        if (!error) { done({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }); return; }
        const code = typeof error.code === 'number' ? error.code : null;
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message ?? '') });
      });
    } catch (error) {
      done({ code: null, stdout: '', stderr: String(error?.message ?? error) });
    }
  });
}

/** GET one path on a port as JSON; `{status, body}`, or null when nothing answers. */
function fetchJson(port, path, timeoutMs = 4000) {
  return new Promise((done) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { done({ status: res.statusCode ?? 0, body: JSON.parse(body) }); } catch { done({ status: res.statusCode ?? 0, body: null }); }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

/**
 * The running console's own report, or what could be learned about the
 * console instead: `{ report }` when it answered `GET /api/doctor`;
 * `{ state }` when a console answered `/api/state` but has no doctor route (a
 * build from before phase 11 — it can still be judged reachable and healthy);
 * `{}` when nothing answered at all.
 */
async function askConsole(port) {
  const doctor = await fetchJson(port, '/api/doctor');
  if (doctor?.status === 200 && Array.isArray(doctor.body?.rows)) return { report: doctor.body };
  const state = await fetchJson(port, '/api/state');
  if (state?.status === 200 && state.body && typeof state.body === 'object') {
    return {
      state: {
        healthy: state.body.health?.healthy !== false,
        serverStale: Boolean(state.body.serverStale),
        version: 'a build from before doctor existed — restart it onto this checkout for the live rows',
      },
      // The console's own node arguments when its state carries them (#71) —
      // this process is a person's shell, and its execArgv would answer nothing.
      execArgv: Array.isArray(state.body.execArgv) ? state.body.execArgv : null,
    };
  }
  return {};
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readText(path) {
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

/** The machine `claude` login, read the way the console's own probe reads it, without the console. */
async function claudeLogin() {
  const { code, stdout, stderr } = await run('claude', ['auth', 'status'], 20_000);
  if (code === null) throw new Error(stderr.trim() || 'the claude CLI is not on PATH for this process');
  try {
    const parsed = JSON.parse(stdout);
    return { loggedIn: parsed?.loggedIn !== false, ...(parsed?.email ? { detail: parsed.email } : {}) };
  } catch {
    // An unparseable answer with exit 0 is the CLI's older prose form: signed in.
    return { loggedIn: code === 0, ...(code !== 0 ? { detail: (stderr || stdout).trim().split('\n')[0] } : {}) };
  }
}

async function claudeVersion() {
  const { code, stdout } = await run('claude', ['--version']);
  if (code === null) return undefined;
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0];
}

/**
 * The verb. `ctx.root` is the package root the bin resolved; `ctx.preferBuilt`
 * picks the shipped `.js` twin under node_modules and the `.ts` elsewhere.
 */
export async function doctorVerb(argv, ctx) {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const stopStrays = args.includes('--stop-strays');
  let selector;
  let rootArg;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--stop-strays') continue;
    if (arg === '--instance') { selector = args[++i]; continue; }
    if (arg === '--root' || arg === '-r') { rootArg = args[++i]; continue; }
    if (!arg.startsWith('-') && selector === undefined && rootArg === undefined) {
      const looksLikePath = arg.includes('/') || arg.startsWith('.') || arg.startsWith('~') || existsSync(resolve(arg));
      if (looksLikePath) rootArg = arg; else selector = arg;
      continue;
    }
    process.stderr.write(`phase-console doctor: unknown argument ${arg}\n${USAGE}`);
    return 2;
  }

  const serverDir = join(ctx.root, 'viewer', 'server');
  const load = (base) => import(pathToFileURL(ctx.preferBuilt(serverDir, base)).href);
  const instances = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'instances.mjs')).href);

  // Which console. A miss is not fatal: the machine rows still answer, and
  // the report says no instance resolved.
  let instance = null;
  try {
    const home = process.env.HOME ?? '';
    const found = rootArg
      ? instances.selectRoot(resolve(rootArg.startsWith('~') ? join(home, rootArg.slice(1)) : rootArg))
      : instances.selectInstance(selector, process.cwd());
    if (found && (found.kind === 'registered' || found.kind === 'candidate')) {
      const isDefault = found.default === true || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
      instance = {
        id: found.id, name: found.name ?? found.id, root: found.root ?? null,
        port: found.port ?? instances.preferredPort(found.root, { isDefault }),
        default: isDefault,
      };
    } else if (selector || rootArg) {
      process.stderr.write(`phase-console doctor: ${instances.selectionError(found)}\n`);
    }
  } catch (error) {
    process.stderr.write(`phase-console doctor: could not resolve an instance (${error.message}); machine rows only\n`);
  }

  const doctor = await load('doctor');
  const asked = instance ? await askConsole(instance.port) : {};
  let report = asked.report ?? null;
  if (!report) {
    const { hooksStatus } = await load('hooks-install');
    const { environmentReport, probeGit } = await load('env-doctor');
    const { probeAccounts, probeCredentials, probeDelivery } = await load('prelude');
    const { probeCredential } = await load('credentials-probe');
    const skillCopies = await load('skill-copy');
    const stateDir = instance ? instances.instanceStateDir(instance.id, instance.default) : null;
    const probeDeps = { claudeLogin, cwd: instance?.root ?? process.cwd() };
    const deps = {
      instance,
      mode: 'offline',
      accounts: async () => {
        const login = await probeCredential('claude', probeDeps);
        const verdict = probeAccounts([{
          id: 'default', minHeadroomPct: 0, registered: true, label: 'the machine login',
          authState: login.status === 'ok' ? 'ok' : login.status === 'fail' ? 'signed-out' : undefined,
          entitlement: { state: 'unknown' },
          headroom: { ok: true, accountId: 'default' },
        }]);
        return {
          ...verdict,
          reason: `${verdict.reason}; the meters, the other accounts and the breaker need a running console`,
        };
      },
      mcp: async () => doctor.skipped('MCP probes need a running console'),
      credentials: async () => probeCredentials(['claude'], 'require', [await probeCredential('claude', probeDeps)]),
      delivery: async () => {
        const devices = stateDir ? readJson(join(stateDir, 'push', 'subscriptions.json')) : null;
        const webhooks = stateDir ? readJson(join(stateDir, 'webhooks.json')) : null;
        const verdict = probeDelivery({
          devices: Array.isArray(devices) ? devices.length : 0,
          notifyCommand: Boolean(process.env.PHASE_CONSOLE_NOTIFY),
          webhooks: Array.isArray(webhooks) ? webhooks.length : 0,
          remote: false,
        });
        return {
          status: verdict.status, ok: verdict.ok,
          reason: stateDir ? `${verdict.reason} (read from ${stateDir}; --remote and Tailscale are the console's to judge)` : `${verdict.reason} (no instance resolved, so no state directory was read)`,
        };
      },
      hooks: async () => hooksStatus({ skillDir: ctx.root }),
      // The skill copy each config dir loads, against the commit THIS copy's
      // client was built from — the console's own `distRev`, read off disk (#151).
      skillCopy: () => skillCopies.skillCopyReport({
        configDirs: skillCopies.claudeConfigDirs(),
        consoleRev: readText(join(ctx.root, 'viewer', 'client', 'dist', '.build-rev')),
      }),
      unit: async () => {
        return null;
      },
      cliVersion: () => claudeVersion(),
      gh: async () => {
        const verdict = await probeCredential('gh', probeDeps);
        return { status: verdict.status, ok: verdict.status !== 'fail', reason: verdict.reason };
      },
      // A console that answered `/api/doctor` reported its own flags in its
      // own rows above; this offline path has no process holding the flag, so
      // off is the truth here.
      publish: () => false,
      // Under THIS process's PATH, which is a person's shell rather than the
      // launch agent's — so a `doctor` run by hand and one asked of the console
      // can legitimately disagree, and that disagreement is itself errand E7's
      // signature. `run()` resolves `code: null` when a binary is absent, which
      // is the shape the probe reads as "not on PATH".
      git: () => probeGit((file, args, opts) => run(file, args, 10_000, opts?.cwd), instance?.root ?? null),
      environment: () => environmentReport(),
      console: async () => asked.state ?? null,
      // No console process is at hand offline: its own answer, when its state
      // gave one, else unknown — never this shell's execArgv.
      execArgv: () => asked.execArgv ?? null,
    };
    report = await doctor.doctorReport(deps);
  }

  // Stray console processes (#155, PS-3) — a machine-wide fact, asked and
  // named the same way whether or not an instance resolved above and whether
  // or not a live console answered for it, so appended to `report.rows` here
  // rather than built into either deps path. Never blocking: a stray costs
  // memory and a port, not the health of THIS instance.
  const strays = await listStrayConsoles();
  const stopped = stopStrays && strays.length ? await stopStrayConsoles(strays) : [];
  report.rows.push(strayRow(strays, stopped));
  for (const one of stopped) {
    process.stderr.write(`phase-console doctor: stray pid ${one.pid} (root gone: ${one.root}) — ${one.stopped ? 'stopped' : 'still running; stop it by hand'}\n`);
  }

  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${doctor.formatDoctor(report)}\n`);
  return doctor.doctorExitCode(report);
}

/** The `strays` row — shaped like `doctor.ts`'s `DoctorRow`, built by hand: this fact is never asked of `doctorReport()`, see the module header. */
function strayRow(strays, stopped) {
  if (!strays.length) {
    return {
      id: 'strays', label: 'Stray console processes', blocking: false, status: 'ok',
      reason: 'none — every phase-console server this scan can see still has its package root',
    };
  }
  const named = strays.map((s) => `pid ${s.pid} (root gone: ${s.root})`).join('; ');
  const tail = stopped.length
    ? ` — ${stopped.filter((s) => s.stopped).length}/${stopped.length} stopped just now`
    : ' — rerun with --stop-strays to stop them';
  return {
    id: 'strays', label: 'Stray console processes', blocking: false, status: 'fail',
    reason: `${strays.length} stray process${strays.length === 1 ? '' : 'es'}: ${named}${tail}`,
    detail: strays,
  };
}
