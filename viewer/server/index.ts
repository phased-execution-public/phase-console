/**
 * Phase Console — the server.
 *
 * Serves the built single-page client from `client/dist` and the API from
 * `server/api`. Binds to localhost only. A clone that has not built the client
 * yet still gets an answer — a page naming the two commands — never a blank one.
 *
 * It is also expected to stay up for hours while it supervises agent sessions,
 * so nothing here is allowed to end the process by accident: faults are
 * recorded as degraded state (`lifecycle.ts`), every exit writes down its
 * reason (`log.ts`), and shutdown waits for registered work to checkpoint.
 */

import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile, spawn as spawnChild } from 'node:child_process';

import { instanceForPort, instanceUrl } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, claimInstance, electInstance, flagsRefusal, flagsWarning, parseFlags,
  probeConsole, resolvePort,
  staticRoot, staticRootDir, VIEWER_DIR,
} from './config.ts';
import {
  configureLog, installExitLogging, isClientDisconnect, log, noteExit, previousRunEndedCleanly,
} from './log.ts';
import {
  bootout, markDegraded, onRestartRequest, onShutdownRequest, reexec, runShutdownHandlers,
  selfRestartPlan, stopPlan, supervisor, type SelfRestartPlan,
} from './lifecycle.ts';
import { openerCandidates } from './platform.ts';
import { Service } from './service.ts';
import { handleApi } from './api/routes.ts';
import { classify } from './api/access.ts';
import { sendFile } from './http/static.ts';
import { refuse } from './terminal.ts';
import { HOOK_TIMEOUT_SECONDS } from './runner/approvals.ts';

const flags = parseFlags(process.argv.slice(2));
const portWasNamed = process.argv.includes('--port') || process.argv.includes('-p')
  || Boolean(process.env.PHASE_CONSOLE_PORT);

// Before anything opens a port: incoherent access flags are a refusal to start,
// never a warning. See `flagsRefusal` for why.
const refusal = flagsRefusal(flags);
if (refusal) {
  process.stderr.write(`\n  phase-console: ${refusal}\n\n`);
  process.exit(1);
}

// Coherent but not private. Printed here, beside the refusal, because logging
// is not configured yet and the operator is looking at this terminal now.
const wideBind = flagsWarning(flags);
if (wideBind) process.stderr.write(`\n  phase-console: ${wideBind}\n\n`);

// And still before anything opens a port OR touches the state directory —
// `configureLog` below is the first thing that does. Which instance we are is
// decided HERE because this is the last moment it is actionable: every path
// under INSTANCE_STATE_DIR (the log, the push keys, the approvals queue, the
// accounts and MCP stores) is a module-level const resolved at import, so a
// console that discovers after `listen` that it lost is a console that can
// only narrate the collision. A loss is therefore a refusal to start, exactly
// as an incoherent access flag is — and it is not sticky: the next start reads
// the registry, finds itself non-default, and comes up on its own derived port
// and its own `instances/<id>` directory.
const election = electInstance();
if (election.lost) {
  const winner = election.winner ?? 'another console';
  process.stderr.write(
    `\n  phase-console: ${winner} is this machine's default instance.\n`
    + `  This console resolved itself as the default before that was settled, so it is pointed at\n`
    + `  ${INSTANCE_STATE_DIR} — one log, one set of push keys, one approvals queue, two consoles.\n`
    + '  Nothing was written. Start it again: it will come up on its own port and its own state\n'
    + '  directory.\n\n',
  );
  process.exit(1);
}

// Logging comes up before anything else can fail, so the first fault is on record.
configureLog(flags.logFile);
const cleanLastTime = previousRunEndedCleanly();
installExitLogging();
log.info('start', {
  pid: process.pid,
  node: process.version,
  port: flags.port,
  allowWrites: flags.allowWrites,
  // false here means the last run was killed or died hard — the single most
  // useful fact when someone reports "it just stopped".
  ...(cleanLastTime === false ? { previousRunCrashed: true } : {}),
});
if (cleanLastTime === false) {
  log.warn('previous-run-crashed', {
    note: 'the last run wrote no exit record — SIGKILL, OOM or a hard stop',
  });
}

// Said once on stderr above, and once here so it is in the record too: a
// console reachable from the network is a fact worth finding in a log later.
if (wideBind) log.warn('wide-bind', { host: flags.host });

const service = new Service(flags);

// The client is the built Vite output (`client/dist`), and the check is made PER
// REQUEST, not at startup, so `npm run build` cuts a live console over without a
// restart — the server lives for hours under launchd. One extra `existsSync` per
// navigation is nothing at this traffic. Until a build exists the console still
// answers rather than hanging: navigations get a page naming the two commands,
// and `/sw.js` gets a real worker (see `sendNotBuilt` for why that one matters).
//
// `staticRoot`/`staticRootDir` live in `config.ts` so this pick has exactly one
// implementation: `/api/state` reports the same answer this handler acts on.
const webRoot = staticRootDir;
log.info('client-root', { serving: staticRoot(), dir: webRoot() ?? 'not built yet' });

/**
 * The console outliving its faults is the whole point: a watcher that throws,
 * a socket that resets under a write, a rejected promise in a background
 * refresh — none of those are worth taking the server down for, and a
 * supervisor that dies mid-run is worse than no supervisor. Record and carry on.
 */
process.on('uncaughtException', (error) => { markDegraded('uncaughtException', error); });
process.on('unhandledRejection', (reason) => { markDegraded('unhandledRejection', reason); });

const startRoot = flags.root ?? (process.env.PHASE_CONSOLE_ROOT || undefined);
if (startRoot) {
  const check = service.open(startRoot);
  if (!check.ok) process.stderr.write(`phase-console: ${startRoot} — ${check.reason}\n`);
}

const server = createServer(async (req, res) => {
  // A client that disappears mid-response surfaces as an 'error' on the
  // request or response stream; unhandled, that is an uncaught exception per
  // request. Handling is mandatory, logging the routine ones is not.
  const noteStreamError = (where: string) => (error: unknown) => {
    if (isClientDisconnect(error)) return;
    log.warn(where, { url: req.url, error });
  };
  res.on('error', noteStreamError('response.error'));
  req.on('error', noteStreamError('request.error'));

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Ahead of the API and the static files alike: a refused caller should not be
  // able to tell which routes exist, and `/events` is as worth guarding as any
  // of them. A no-op unless --remote is set.
  const verdict = classify(req, flags);
  if (!verdict.ok) {
    // A silent refusal on a phone is unfixable, so every one of these is on
    // record with the two facts that explain it.
    log.warn('access.refused', {
      reason: verdict.reason,
      host: req.headers.host,
      login: req.headers['tailscale-user-login'],
      url: req.url,
    });
    res.writeHead(verdict.status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`${verdict.message}\n`);
    return;
  }

  try {
    if (await handleApi({ service }, req, res, url)) return;
  } catch (error) {
    log.error('api.unhandled', { url: req.url, error });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String((error as Error)?.message ?? error));
    return;
  }

  // Static: everything under `client/dist`, with index.html as the SPA entry.
  // `webRoot()` is re-checked per request so a fresh build takes effect live.
  const root = webRoot();
  if (root === null) { sendNotBuilt(res, url.pathname); return; }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = resolve(join(root, normalize(requested).replace(/^(\.\.[/\\])+/, '')));
  if (!target.startsWith(root) || !existsSync(target) || !statSync(target).isFile()) {
    if (!extname(requested)) { sendFile(res, join(root, 'index.html'), securityHeaders()); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  sendFile(res, target, securityHeaders());
});

/**
 * The terminal's socket.
 *
 * A WebSocket upgrade never reaches the request handler above, so the access
 * gate has to be applied here as well — and it is the *first* thing that runs.
 * The reason is specific: **CORS does not apply to WebSockets**. A browser will
 * happily open one cross-origin and send whatever `Origin` the page has, and no
 * preflight ever happens, so the same-origin check that guards every POST is
 * worth nothing on this path. What is worth something is `classify` (the
 * tailscale identity, on the upgrade request rather than on the page that
 * opened it) followed by a single-use token minted through a guarded POST.
 *
 * With `--allow-terminal` unset, `handleUpgrade` refuses before it looks at the
 * token at all, so an off switch cannot be probed.
 */
server.on('upgrade', (req, socket, head) => {
  // An upgrade socket has no response object to attach errors to; unhandled,
  // a client that vanishes mid-handshake is an uncaught exception.
  socket.on('error', (error) => {
    if (!isClientDisconnect(error)) log.warn('upgrade.error', { url: req.url, error });
  });

  const verdict = classify(req, flags);
  if (!verdict.ok) {
    log.warn('access.refused', {
      reason: verdict.reason, host: req.headers.host, upgrade: true,
      // The path only — the query carries the terminal token, and a refused
      // handshake is not a reason to write a credential to disk.
      url: (req.url ?? '').split('?')[0],
    });
    refuse(socket, verdict.status === 421 ? 400 : verdict.status, verdict.message);
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  service.terminals.handleUpgrade(req, socket, head, url).then((handled) => {
    if (!handled) refuse(socket, 404, 'no such socket');
  }).catch((error) => {
    log.error('upgrade.unhandled', { url: url.pathname, error });
    socket.destroy();
  });
});

/** Served for any navigation until `client/dist` exists. */
const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phase Console — not built yet</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; background: #16181d; color: #e8e6e1;
         display: grid; place-items: center; min-height: 100dvh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; }
  code, pre { font-family: ui-monospace, monospace; background: #23262d; border-radius: 4px; }
  code { padding: 0.1em 0.35em; }
  pre { padding: 0.75rem 1rem; overflow-x: auto; }
  a { color: #eab308; }
</style>
<main>
  <h1>The console is running — the client is not built yet</h1>
  <p>The server serves built output from <code>client/dist</code>, and there is none here.
  In <code>${VIEWER_DIR}</code>:</p>
  <pre>npm ci
npm run build</pre>
  <p>Then reload this page.`
  // The region boundary sits OUTSIDE the template literal, as a JS comment
  // either side of a concatenation. Written as HTML comments inside the string
  // it stripped correctly — and served both marker lines to the browser in the
  // Pro tree, in the body of a page whose whole job is to be read by a person.
  + `
  </p>
</main>
</html>`;

/**
 * The WebSocket origins, named rather than left to `'self'`.
 *
 * By CSP3 `'self'` covers a same-origin `ws:` from an `http:` page, and Chrome
 * and Firefox agree — Safari has historically not, and the phone terminal is
 * the one surface that would break silently and late. These come from
 * VALIDATED CONFIG, never from the Host header: `parseFlags` lowercases every
 * `--remote` host and `flagsRefusal` refuses one that fails its hostname
 * regex, so nothing a caller sends can reach this string. The Host header is
 * not validated at all on a local-only console (`classify` answers ok before
 * it is read), which is exactly why it is not used here.
 *
 * Loopback and `--remote` are the whole list because they are the only origins
 * this console can be reached on: `flagsRefusal` refuses to start on a
 * non-loopback `--host` with any capability flag, and the terminal — the one
 * surface that opens a socket — needs `--allow-terminal`. A wide bind with no
 * capability flag gets `flagsWarning` and has no terminal to serve. If that
 * refusal is ever relaxed, `flags.host` belongs in this list.
 *
 * `flags.port` is read per request on purpose: `resolvePort` may move it after
 * this module is evaluated, so a module-level const would bake the wrong port
 * into every header.
 */
function connectSources(): string {
  const local = [`ws://127.0.0.1:${flags.port}`, `ws://localhost:${flags.port}`];
  const remote = flags.remoteHosts.flatMap((host) => [`wss://${host}:*`, `ws://${host}:*`]);
  return ["'self'", ...local, ...remote].join(' ');
}

/**
 * The headers every document and every static file carries.
 *
 * ⚠️ A HEADER, never a `<meta http-equiv>` in `client/index.html`: the meta
 * would apply on the Vite dev server too, and `@vitejs/plugin-react` injects
 * React Refresh as an INLINE `<script type="module">` (its transformIndexHtml
 * hook), so `npm run dev` would refuse its own preamble. The built page is the
 * one this policy has to satisfy, and it carries no inline script at all —
 * `scripts/check-dist.mjs` holds that end.
 *
 * `script-src 'self'` with no hash and no nonce is affordable because of that.
 * `style-src` KEEPS `'unsafe-inline'` and cannot drop it: xterm's DOM renderer
 * writes its scrollbar, cell-metric and theme CSS into `<style>` elements it
 * creates (no nonce option exists), react-remove-scroll does the same behind
 * every Radix dialog, and NOT_BUILT_PAGE above is one inline `<style>`. That
 * costs little: `components/markdown.tsx` already deletes `<style>`, `<link>`
 * and every `style=` attribute out of agent-written text.
 * `img-src` keeps `data:` for the SVG favicon in index.html.
 *
 * This rides `/sw.js` as well, which is deliberate: a worker executes under the
 * policy served with its own script, and both workers fetch same-origin only.
 */
function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src ${connectSources()}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

/**
 * What a console with no build answers with.
 *
 * `/sw.js` is the one path that must NOT fall through to the page or to a 404:
 * a registered service worker whose script URL returns 404 on update is
 * UNREGISTERED by the browser, and the push subscriptions bound to it die
 * silently with it. So it gets a real worker — `fallback-sw.js`, the retired
 * legacy client's worker, verbatim — which installs over the built one, keeps
 * the push handlers alive, and has no fetch handler, so the next navigation
 * reaches the network again. The moment a build exists, the boot-time
 * `registration.update()` swaps registered devices back onto the real worker.
 * That covers the deliberate "deleted dist" state and the few seconds mid-build
 * when `dist/` has been emptied and not yet rewritten.
 *
 * Navigations get a 200 page naming the two commands (the old SPA fallback
 * would stream a file that does not exist and hang up); asset paths stay 404s.
 */
function sendNotBuilt(res: import('node:http').ServerResponse, pathname: string): void {
  if (pathname === '/sw.js') {
    sendFile(res, join(VIEWER_DIR, 'server', 'fallback-sw.js'), securityHeaders());
    return;
  }
  if (extname(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders(),
  });
  res.end(NOT_BUILT_PAGE);
}

/**
 * A parked approval holds its hook request open for the whole answer window,
 * and that window is now an hour.
 *
 * Node's defaults would kill it long before: `requestTimeout` is five minutes
 * and destroys the socket when it fires. A destroyed hook request is not a
 * denial — it is silence, and **this hook fails open**, so the tool call the
 * console was holding for a person would simply proceed unsupervised. That is
 * the exact failure the approval queue exists to prevent, arriving through the
 * back door.
 *
 * Bounded rather than disabled (`0`), so a stuck client still cannot hold a
 * socket forever: the window, plus a minute for the answer to be written.
 */
server.requestTimeout = (HOOK_TIMEOUT_SECONDS + 60) * 1000;
server.headersTimeout = 60_000;

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    noteExit('port-in-use', { port: flags.port });
    // Say WHOSE console is on that port. "A console may already be running" was
    // true and useless: with one console per project, the question is never
    // whether one is running — it is which project it is serving, and whether
    // the answer is "the one you just asked for" (open it) or "a different one"
    // (this is a collision, move).
    //
    // Asked twice, because either source alone can lie. The registry names a
    // project but may be stale; the live probe is ground truth but only if the
    // thing holding the socket is a console at all. Whichever answers, the
    // message names a root — and when neither does, it says so plainly rather
    // than implying a console is there.
    void (async () => {
      const registered = instanceForPort(flags.port);
      const live = await probeConsole(flags.port, flags.host);
      const root = live?.root ?? registered?.root ?? null;
      const name = live?.instance?.name ?? registered?.name ?? null;
      // The flags are ASSEMBLED, not two spellings of the sentence: a region can
      // only remove, so a marked alternative ending leaves the Pro tree printing
      // both. One list, joined — and never a `+` chain, which prettier can lift
      // an operator out of.
      const elsewhere = ['--port <n>'];
      const lines = root
        ? [
          `  port ${flags.port} already serves ${root}`,
          `  ${name ? `(instance ${name}) — ` : ''}open ${instanceUrl(flags.port, flags.host)}`,
          `  or start this one elsewhere with ${elsewhere.join(' or ')}.`,
        ]
        : [
          `  something else is listening there — no console this machine knows of.`,
          '  Start this one elsewhere with --port <n>.',
        ];
      process.stderr.write(`\n  phase-console: port ${flags.port} is already in use.\n${lines.join('\n')}\n\n`);
      process.exit(1);
    })();
    return;
  }
  markDegraded('server', error);
});

// The port the OS actually gave us, which is the only one worth recording: a
// probe may have walked past a busy neighbour, and a registry holding the port
// we *asked* for would send the next `open` to nothing.
const boundPort = await resolvePort(flags.port, flags.host, INSTANCE, portWasNamed);
flags.port = boundPort;

server.listen(flags.port, flags.host, () => {
  claimInstance(flags.port);
  const address = `http://${flags.host}:${flags.port}`;
  process.stdout.write(`\n  Phase Console  ${address}\n`);
  process.stdout.write(`  instance      ${INSTANCE.name}${INSTANCE.default ? ' (default)' : ''}  ${INSTANCE.id}\n`);
  process.stdout.write(`  source        ${service.root?.path ?? 'not chosen yet — pick one in the browser'}\n`);
  process.stdout.write(`  scripts       ${flags.scriptsDir}\n`);
  process.stdout.write(`  writes        ${flags.allowWrites ? 'enabled (--allow-writes)' : 'read-only'}\n`);
  process.stdout.write(`  autopilot     ${flags.allowRun ? 'enabled (--allow-run) — this console can spawn agent sessions' : 'off'}\n`);
  process.stdout.write(`  terminal      ${flags.allowTerminal ? 'enabled (--allow-terminal) — this console can open a shell' : 'off'}\n`);
  process.stdout.write(`  agent         ${flags.allowAgent ? 'enabled (--allow-agent) — interactive claude sessions in the terminal' : 'off'}\n`);
  if (flags.remoteHosts.length) {
    process.stdout.write(`  remote        ${flags.remoteHosts.join(', ')} — only ${flags.remoteUsers.join(', ')}\n`);
  }
  process.stdout.write(`  log           ${flags.logFile ?? 'stderr only'}\n\n`);
  if (flags.open) {
    // Best-effort and platform-aware: on WSL the browser lives on the Windows
    // side, so `wslview` goes first. A candidate that is missing falls through
    // to the next; running out prints the URL instead of erroring — opening is
    // a convenience, never a requirement.
    const candidates = openerCandidates();
    const tryNext = (i: number): void => {
      if (i >= candidates.length) {
        process.stdout.write(`  (no way to open a browser from here — open ${address} yourself)\n`);
        return;
      }
      execFile(candidates[i], [address], (error) => {
        if (!error) return;
        // explorer.exe answers 1 even when it worked; only its outright
        // absence means "try the next one".
        if (candidates[i] === 'explorer.exe' && (error as NodeJS.ErrnoException).code !== 'ENOENT') return;
        tryNext(i + 1);
      });
    };
    tryNext(0);
  }
});

/* ------------------------------------------------------------------ *
 * Shutdown
 * ------------------------------------------------------------------ */

/**
 * Long enough for a runner to checkpoint and let a child settle. Idle shutdown
 * is still instant: with nothing registered there is nothing to await.
 */
const SHUTDOWN_BUDGET_MS = 120_000;

let shuttingDown = false;

async function shutdown(reason: string, successor: SelfRestartPlan | null = null): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  noteExit(reason);
  log.info('shutdown.begin', { reason, successor: successor?.command ?? null });

  // Stop taking new work first, so nothing starts while handlers are draining.
  server.close();
  service.close();

  await runShutdownHandlers(SHUTDOWN_BUDGET_MS);

  // A self-restart: the listener is closed and the drain is done, so the
  // successor can bind the port the moment it boots. Spawned last so a drain
  // that overran its budget never leaves two consoles contending for it.
  if (successor) reexec(successor, spawnChild as never);

  log.info('shutdown.end', { reason });
  process.exit(0);
}

/**
 * The Restart button's other half.
 *
 * Registered rather than exported because `shutdown` closes over the server
 * handle and the drain budget, both of which live here. The API decides
 * *whether* a restart is allowed (a run in flight refuses it, and so does an
 * unsupervised process); this is only how it is carried out.
 *
 * The delay is not decoration: the HTTP response has to reach the browser
 * before the socket it arrived on is closed, or the page sees a network error
 * for a restart that is working exactly as asked.
 */
onRestartRequest((reason) => {
  // Under launchd or systemd the supervisor brings the console back; where
  // nothing does, the process starts its own successor with the arguments it
  // was started with — every capability included — right before it exits.
  const successor = supervisor().kind === 'none' ? selfRestartPlan() : null;
  setTimeout(() => void shutdown(reason, successor), 250).unref();
});

/**
 * How long to wait for `launchctl bootout` to land before stopping anyway.
 *
 * Bootout ends the job by sending this process SIGTERM, which the handler below
 * turns into the ordinary graceful shutdown — so on the happy path this timer
 * never fires. It exists for the unhappy one: a `launchctl` that is missing, or
 * refuses, or names a job that is not there. A Shut-down button that leaves the
 * console running because a supervisor did not answer is the same broken
 * promise as no button at all.
 */
const BOOTOUT_GRACE_MS = 8_000;

/**
 * The Shut-down button's other half — stop, and stay stopped.
 *
 * The asymmetry with Restart is the whole point. Under launchd `KeepAlive` an
 * exit is a *restart*, so a console that stopped by exiting would be back
 * within seconds; the job has to be unloaded instead. Where nothing is
 * supervising, exiting IS stopping and the same drain applies — the runner
 * checkpoints, the pty broker is let go of rather than killed
 * (`service.close()` → `Terminals.close()`, since Phase 7: the ptys are the
 * broker's children, so the terminals are still there when a console comes
 * back), and the process ends 0.
 */
onShutdownRequest((reason) => {
  setTimeout(() => {
    const plan = stopPlan();
    if (plan.via === 'exit' || !bootout(plan, spawnChild as never)) {
      void shutdown(reason);
      return;
    }
    setTimeout(() => void shutdown(`${reason} (bootout did not land)`), BOOTOUT_GRACE_MS).unref();
  }, 250).unref();
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Closing the terminal must not kill a run in progress. Under launchd the
// process is detached and never sees this; in the foreground it now survives,
// and Ctrl-C or `launchctl` remains the way to stop it deliberately.
process.on('SIGHUP', () => log.warn('sighup.ignored', { note: 'terminal closed; still running' }));

// A hard second interrupt is an explicit "I mean it" — skip the drain.
process.on('SIGQUIT', () => { noteExit('SIGQUIT'); process.exit(131); });
