// `phase-console sessions ingest [instance] [--root DIR] [--json] [--quiet] [--peers-of <session>]`
// — the verb, shared by the Pro bin (`bin/phase-console.mjs`) and the free
// tree's override, which import it by path so neither carries a second copy.
//
// The session inbox had one reader: a running console (REG-2). The hook writes
// a presence drop there whenever its POST finds nobody, and for the whole of an
// outage nothing drained it — 62 drops in four hours on the measured machine,
// two live sessions the console had no record of, four permission prompts that
// reached nobody — and a boot then replayed them all as if they were news. This
// drains the inbox through the registry's OWN code with no console up: the same
// validation, the same order, the same records, each event stamped with its
// lateness, one past the history horizon applied as history, one past the age
// watermark refused. `scripts/session-hook.sh` runs it when its POST fails.
//
// It never drains under a console: when THIS instance answers on its port (or
// the port answers too slowly to tell), it says so and does nothing — the
// console holds the records in memory and drains its own inbox, and two
// writers of one record is how a record is lost. One drain at a time across
// processes is the registry's drain lock.
//
// `--peers-of <session>` adds one `peers=<sentence>` line: the live sessions
// the registry shows in the instance's root, that session excluded — what the
// SessionStart hook puts in a new session's context when no console could.
//
// Imports only leaves: `viewer/shared/instances.mjs` and
// `viewer/server/sessions/registry.ts` (which reads `server/pid.ts` and nothing
// else), so no console identity is resolved at module load.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = [
  'phase-console sessions ingest [instance] [--root DIR] [--json] [--quiet] [--peers-of <session>]',
  '',
  "  Drains an instance's session-presence inbox — the drops the hook writes when",
  '  no console answers — through the registry, with no console running. Every',
  '  event is applied with its lateness; one older than the history horizon is',
  '  applied as history, one older than a week is refused. Does nothing when the',
  "  instance's own console is answering: it drains its own inbox.",
  '',
  '  [instance]         an id, a name, or a project directory; default: the console',
  '                     for the directory you are standing in',
  '  --root DIR         the project root instead of a selector',
  '  --json             print the result as JSON',
  '  --quiet            print nothing but the --peers-of line',
  '  --peers-of <id>    also print `peers=<sentence>`: the live sessions in the root,',
  '                     that session excluded',
  '',
].join('\n');

/**
 * Who answers on the port: `this` — the instance's own console; `other` —
 * something else (another console, another program); `none` — nothing
 * listens; `unknown` — it did not answer in time, which is not "nothing".
 */
function whoAnswers(port, id, timeoutMs = 700) {
  return new Promise((done) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/state', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const state = JSON.parse(body);
          done(state?.instance?.id === id ? 'this' : 'other');
        } catch { done('other'); }
      });
    });
    req.on('error', (error) => done(error?.code === 'ECONNREFUSED' ? 'none' : 'unknown'));
    req.on('timeout', () => { req.destroy(); done('unknown'); });
    req.end();
  });
}

/**
 * The verb. `ctx.root` is the package root the bin resolved; `ctx.preferBuilt`
 * picks the shipped `.js` twin under node_modules and the `.ts` elsewhere.
 */
export async function sessionsVerb(argv, ctx) {
  const args = [...argv];
  const sub = args.shift();
  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'ingest') {
    process.stderr.write(`phase-console sessions: unknown verb ${sub}\n${USAGE}`);
    return 2;
  }
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  let selector;
  let rootArg;
  let peersOf;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--quiet') continue;
    if (arg === '--instance') { selector = args[++i]; continue; }
    if (arg === '--root' || arg === '-r') { rootArg = args[++i]; continue; }
    if (arg === '--peers-of') { peersOf = args[++i]; continue; }
    if (!arg.startsWith('-') && selector === undefined && rootArg === undefined) {
      const looksLikePath = arg.includes('/') || arg.startsWith('.') || arg.startsWith('~') || existsSync(resolve(arg));
      if (looksLikePath) rootArg = arg; else selector = arg;
      continue;
    }
    process.stderr.write(`phase-console sessions: unknown argument ${arg}\n${USAGE}`);
    return 2;
  }

  const instances = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'instances.mjs')).href);
  const home = process.env.HOME ?? '';
  const found = rootArg
    ? instances.selectRoot(resolve(rootArg.startsWith('~') ? join(home, rootArg.slice(1)) : rootArg))
    : instances.selectInstance(selector, process.cwd());
  if (!found || (found.kind !== 'registered' && found.kind !== 'candidate')) {
    process.stderr.write(`phase-console sessions: ${instances.selectionError(found)}\n`);
    return 1;
  }
  const isDefault = found.default === true || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
  const stateDir = instances.instanceStateDir(found.id, isDefault);
  const port = found.port ?? instances.preferredPort(found.root, { isDefault });
  const say = (result) => {
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (!quiet) {
      process.stdout.write(result.drained
        ? `drained ${found.name ?? found.id}: ${result.applied} applied (${result.history} as history), ${result.refused} refused, ${result.depth} left\n`
        : `not drained — ${result.reason}\n`);
    }
  };

  const answer = await whoAnswers(port, found.id);
  if (answer === 'this' || answer === 'unknown') {
    say({
      instance: found.id, drained: false,
      reason: answer === 'this'
        ? `its console is answering on ${port} and drains its own inbox`
        : `something holds ${port} and did not answer in time — a console that is up drains its own inbox`,
    });
    return 0;
  }

  const serverDir = join(ctx.root, 'viewer', 'server', 'sessions');
  const { SessionRegistry, peersSentence } = await import(pathToFileURL(ctx.preferBuilt(serverDir, 'registry')).href);
  // The instance's own log, in the console's line shape, so the Debug page's
  // timeline shows a drain nobody's console made.
  const logFile = join(stateDir, 'console.log');
  const line = (level, event, data) => {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), level, event, data: { ...data, by: 'phase-console sessions ingest' } })}\n`);
    } catch { /* a log that cannot be written must not stop the drain */ }
  };
  const registry = new SessionRegistry({
    dir: join(stateDir, 'sessions'),
    onWarn: (what, detail) => line('warn', what, detail),
    onInfo: (what, detail) => line('info', what, detail),
  });
  let result;
  try {
    registry.load({ via: 'cli' });
    result = { instance: found.id, drained: true, ...registry.lastDrain(), depth: registry.depth() };
    if (peersOf) {
      const present = registry.inRoot(found.root, { excluding: [peersOf] }).filter((peer) => peer.presence === 'live');
      result.peers = peersSentence(found.root, present);
    }
  } finally {
    registry.close();
  }
  say(result);
  if (peersOf && result.peers && !json) process.stdout.write(`peers=${String(result.peers).replace(/[\r\n]+/g, ' ')}\n`);
  return 0;
}
