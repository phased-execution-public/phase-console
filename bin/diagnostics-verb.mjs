// `phase-console diagnostics --run <id> [--slug <plan>] [--since 30m] [--out FILE]`
// — the verb, shared by the Pro bin (`bin/phase-console.mjs`) and the free
// tree's override, which import it by path so neither carries a second copy.
//
// One run, redacted, as a tar.gz: the record, the journal, the transcript, the
// task ledgers, the declared outcomes, the rulings, the messages, the folded
// git trace, the session event logs, the locks, the worktree inventory, the
// console-log slice, the versions, a redacted environment and a per-phase
// diagnosis. It is the thing to attach to an issue or hand to a model.
//
// **It works with the console down**, and that is the whole reason it exists
// as a verb rather than only a button. The moment somebody most needs a bundle
// is the moment the console will not start — and a bundle you can only get
// from a running console is a bundle you cannot get then. Every artefact it
// collects is a file on disk written by a process that has already exited, so
// nothing about building one requires the console to be alive.
//
// When a console IS answering on the instance's port, the bundle is STREAMED
// from it instead: a live console holds run state in memory that has not been
// checkpointed yet, and asking it is how that state reaches the archive.
//
// Imports only leaves at module load; the bundle itself is imported inside the
// verb, so no console identity is resolved by loading this file.

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = [
  'phase-console diagnostics --run <id> [instance] [--slug <plan>] [--since 30m] [--out FILE]',
  '',
  '  Exports ONE run as a redacted tar.gz — record, journal, transcript, tasks,',
  '  outcomes, rulings, messages, git trace, session events, locks, worktrees,',
  '  console-log slice, versions, environment and per-phase diagnosis.',
  '',
  '  Streams from the instance’s console when one is answering; builds it from',
  '  the state directory when none is, so a console that will not start is still',
  '  a console you can get a bundle out of.',
  '',
  '  --run <id>         the run id (8-32 hex). Required.',
  '  --slug <plan>      the plan. Found from the run id when omitted.',
  '  --since <window>   only lines at or after this: 30m, 2h, 7d, or an instant',
  '  --out FILE         where to write it; default: ./<the bundle’s own name>',
  '  [instance]         an id, a name, or a project directory; default: the console',
  '                     for the directory you are standing in',
  '  --root DIR         the project root instead of a selector',
  '',
  '  Redaction is best-effort (regex + home masking + entropy). Inspect before sharing.',
  '',
].join('\n');

const RUN_ID = /^[0-9a-f]{8,32}$/i;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

/**
 * Is the console on this port THIS instance's?
 *
 * Asked before anything is streamed, because a port is a guess: an instance's
 * port is derived from its root, a candidate root that was never registered
 * derives one that may already be taken, and the answer on it is then some
 * other project's console. Streaming a bundle from that one would produce an
 * archive that is internally consistent, correctly named, and about a
 * different repository — the worst shape a diagnostic artefact can have.
 *
 * `this` — its own console; `other` — somebody else's, or another program;
 * `none` — nothing listens; `unknown` — it did not answer in time, which is
 * not the same as nothing.
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

/** Ask the instance's own console for the bundle. `null` means nobody answered. */
function streamFromConsole(port, path, timeoutMs = 60_000) {
  return new Promise((done) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, timeout: timeoutMs, headers: { 'x-phase-console': '1' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done({ error: `the console answered ${res.statusCode} for ${path}` });
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done({
          body: Buffer.concat(chunks),
          name: nameFromDisposition(res.headers['content-disposition']),
        }));
        res.on('error', () => done(null));
      },
    );
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

function nameFromDisposition(header) {
  const match = /filename="([^"]+)"/.exec(String(header ?? ''));
  return match ? basename(match[1]) : null;
}

/** Which plan holds this run, by looking. A run id is unique across plans. */
function slugOfRun(runsDir, runId) {
  let plans = [];
  try { plans = readdirSync(runsDir); } catch { return null; }
  for (const slug of plans.sort()) {
    if (existsSync(join(runsDir, slug, `run-${runId}.json`))) return slug;
  }
  return null;
}

/**
 * The verb. `ctx.root` is the package root the bin resolved; `ctx.preferBuilt`
 * picks the shipped `.js` twin under node_modules and the `.ts` elsewhere.
 */
export async function diagnosticsVerb(argv, ctx) {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }

  let runId;
  let slug;
  let since;
  let out;
  let selector;
  let rootArg;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--run') { runId = args[++i]; continue; }
    if (arg === '--slug') { slug = args[++i]; continue; }
    if (arg === '--since') { since = args[++i]; continue; }
    if (arg === '--out' || arg === '-o') { out = args[++i]; continue; }
    if (arg === '--instance') { selector = args[++i]; continue; }
    if (arg === '--root' || arg === '-r') { rootArg = args[++i]; continue; }
    if (!arg.startsWith('-') && selector === undefined && rootArg === undefined) {
      const looksLikePath = arg.includes('/') || arg.startsWith('.') || arg.startsWith('~') || existsSync(resolve(arg));
      if (looksLikePath) rootArg = arg; else selector = arg;
      continue;
    }
    process.stderr.write(`phase-console diagnostics: unknown argument ${arg}\n${USAGE}`);
    return 2;
  }

  // Both reach a `join` that builds a path, so both are checked here as well as
  // in the route — this half never goes through the route at all.
  if (!runId || !RUN_ID.test(runId)) {
    process.stderr.write('phase-console diagnostics: --run <id> is required (8-32 hex)\n');
    return 2;
  }
  if (slug !== undefined && !SLUG.test(slug)) {
    process.stderr.write('phase-console diagnostics: --slug must be a plan slug\n');
    return 2;
  }

  const instances = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'instances.mjs')).href);
  const home = process.env.HOME ?? '';
  const found = rootArg
    ? instances.selectRoot(resolve(rootArg.startsWith('~') ? join(home, rootArg.slice(1)) : rootArg))
    : instances.selectInstance(selector, process.cwd());
  if (!found || (found.kind !== 'registered' && found.kind !== 'candidate')) {
    process.stderr.write(`phase-console diagnostics: ${instances.selectionError(found)}\n`);
    return 1;
  }
  const isDefault = found.default === true || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
  const stateDir = instances.instanceStateDir(found.id, isDefault);
  const port = found.port ?? instances.preferredPort(found.root, { isDefault });
  // `runs/` lives under the SHARED state home, keyed by the root's instance id
  // — not under the per-instance directory. Two consoles cannot collide there,
  // and this is the one place the CLI has to know it.
  const runsDir = join(instances.stateHome(), 'runs', instances.instanceId(found.root));

  if (!slug) {
    slug = slugOfRun(runsDir, runId);
    if (!slug) {
      process.stderr.write(`phase-console diagnostics: no run ${runId} under ${runsDir} — pass --slug if it is elsewhere\n`);
      return 1;
    }
  }

  // The live console first — but only after it has proved it is the RIGHT one:
  // it holds run state that has not been checkpointed, and that state is the
  // whole reason to prefer it.
  const query = `slug=${encodeURIComponent(slug)}&run=${encodeURIComponent(runId)}`
    + (since ? `&since=${encodeURIComponent(since)}` : '');
  const answer = await whoAnswers(port, found.id);
  const streamed = answer === 'this' ? await streamFromConsole(port, `/api/debug/bundle?${query}`) : null;
  let body;
  let name;
  let how;
  if (streamed?.body) {
    body = streamed.body;
    name = streamed.name;
    how = `streamed from the console on ${port}`;
  } else if (streamed?.error) {
    process.stderr.write(`phase-console diagnostics: ${streamed.error}\n`);
    return 1;
  } else {
    const debugDir = join(ctx.root, 'viewer', 'server', 'debug');
    const { runBundle, parseSince } = await import(pathToFileURL(ctx.preferBuilt(debugDir, 'bundle')).href);
    // A docs root keeps a plan's locks beside its handoffs. Absent is fine:
    // the bundle names what it could not find rather than failing.
    const locksDir = join(found.root ?? '', 'docs', 'handoffs', slug, '.locks');
    let built;
    try {
      built = await runBundle(
        { slug, runId, since: parseSince(since, Date.now()) },
        {
          runDir: join(runsDir, slug),
          instanceDir: stateDir,
          locksDir: existsSync(locksDir) ? locksDir : null,
          env: process.env,
          versions: () => ({ node: process.version, platform: process.platform, by: 'phase-console diagnostics' }),
        },
      );
    } catch (error) {
      process.stderr.write(`phase-console diagnostics: ${error?.message ?? error}\n`);
      return 1;
    }
    body = built.body;
    name = built.filename;
    how = answer === 'other'
      ? `built from the state directory (something else holds ${port} — not this instance's console)`
      : 'built from the state directory (no console answered)';
  }

  const target = resolve(out ?? name ?? `phase-console-run-${slug}-${runId}.tar.gz`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  } catch (error) {
    process.stderr.write(`phase-console diagnostics: could not write ${target}: ${error?.message ?? error}\n`);
    return 1;
  }
  process.stdout.write(`${target}\n${body.length} bytes, ${how}\n`);
  process.stdout.write('Redaction is best-effort (regex + home masking + entropy). Inspect before sharing.\n');
  return 0;
}
