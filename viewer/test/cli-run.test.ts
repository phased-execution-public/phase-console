/**
 * `phase-console run <verb>` — the CLI (control-tower phase 98, EC6, #144;
 * contributes to #135's queue verbs and #163's `run explain`).
 *
 * `bin/run-verb.mjs` reads `viewer/shared/verb-model.js`'s `OPERATOR_VERBS`
 * for everything: the words, the positional arguments, which `--flag` becomes
 * which field, the route, and `CLI_EXIT`'s exit codes. This file presses it
 * the way an operator's shell would — as a CHILD PROCESS, in a sandboxed
 * `HOME`/`XDG_STATE_HOME`, never against a real console.
 *
 *   CL-1: headers, route filling, flags→body/query, exit codes and `--json`
 *         against a bare stub HTTP server on an ephemeral port — the server
 *         answers whatever this file scripts, so what matters is what the
 *         CLI SENT.
 *   CL-2: an act pressed through the CLI against the REAL routes (an actual
 *         `Service` over a scratch plan, `handleApi` wired to a real
 *         `http.Server` on an ephemeral port — the same handler
 *         `verb-harness.ts`'s in-process `call()` uses, just reachable from a
 *         child process) is attributed `via: 'cli'` and lands in the run's
 *         journal — the same attribution a browser's press gets, because
 *         nothing here derives an actor itself; the header and User-Agent
 *         this CLI always sends are the whole of it.
 *   CL-3: the free CLI refuses every act row (and `wait`) by edition, before
 *         any request leaves this machine; the Pro CLI asks the SAME license
 *         gate every other Pro-only verb consults.
 *
 * The stub server is a real `http.Server`, so every spawn below is
 * asynchronous (`spawn`, never `spawnSync`) — a synchronous child would hold
 * this process's event loop shut while the stub is waiting to answer it
 * (`license-cli.test.ts` notes the same trap).
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { scratch, service } from './verb-harness.ts';
import { OPERATOR_VERBS, verbNamed } from '../shared/verb-model.js';
import { runStatusWord } from '../shared/status-vocab.js';
import { buildRequest, exitCodeFor, parseRowArgs, renderAnswer } from '../../bin/run-verb.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * The two bins. In the FREE tree `free/` is a proPath and gone, but the
 * override has been applied — `bin/phase-console.mjs` IS the free CLI there —
 * so the free cases below run against the real free bin in both trees, and
 * every case that needs the Pro bin (an act, `wait`, the license gate) is
 * inside a `!pro:` region.
 */
const PRO_CLI = join(REPO, 'bin', 'phase-console.mjs');
let FREE_CLI = join(REPO, 'bin', 'phase-console.mjs');
const CLI_EXIT = { ok: 0, refused: 1, usage: 2, 'not-found': 3, 'console-down': 4, 'timed-out': 5 };

type Recorded = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };

/** A bare HTTP server on an ephemeral loopback port: records every request, answers a scripted reply. */
function stubServer() {
  const requests: Recorded[] = [];
  let status = 200;
  let body: unknown = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '', url: req.url ?? '', headers: req.headers as Recorded['headers'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const text = Buffer.from(JSON.stringify(body), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  const ready = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return {
    requests,
    ready,
    reply: (nextStatus: number, nextBody: unknown) => { status = nextStatus; body = nextBody; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type StubView = { port: number; requests: Recorded[]; reply: (status: number, body: unknown) => void };

async function withStub(run: (stub: StubView) => Promise<void>): Promise<void> {
  const stub = stubServer();
  const port = await stub.ready;
  try {
    await run({ port, requests: stub.requests, reply: stub.reply });
  } finally {
    await stub.close();
  }
}

/** The CLI, spawned — never blocking, always in a throwaway HOME/state. */
function runCli(bin: string, args: string[], extraEnv: Record<string, string> = {}) {
  const box = mkdtempSync(join(tmpdir(), 'cli-run-'));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        HOME: join(box, 'home'),
        XDG_STATE_HOME: join(box, 'state'),
        XDG_CONFIG_HOME: join(box, 'config'),
        PHASE_CONSOLE_HOME: REPO,
        PHASE_CONSOLE_SELF_UPDATE: '0',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (status) => {
      rmSync(box, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Pure helpers — the row → request shape, with no process involved
 * ------------------------------------------------------------------ */

describe('buildRequest / parseRowArgs — the table applied to argv, no network', () => {
  test('a placeholder positional fills the path; an unplaced one rides the body under its own name', () => {
    const bump = verbNamed('bump')!;
    const parsed = parseRowArgs(bump, ['alpha', '3']);
    assert.deepEqual(parsed.positionals, { slug: 'alpha', phase: '3' });
    const built = buildRequest(bump, parsed);
    assert.equal(built.method, 'POST');
    // bump's route (`POST /queue/bump`) has no `:slug`/`:phase` of its own — so
    // the path is the route's own path verbatim, and BOTH positionals ride the
    // body under their own names, which is what the real route reads.
    assert.equal(built.path, bump.route.split(' ')[1]);
    assert.deepEqual(built.body, { slug: 'alpha', phase: '3' });
  });

  test('both :slug and :id fill the path; nothing is left for the body', () => {
    const row = verbNamed('cancel-trigger')!;
    const parsed = parseRowArgs(row, ['alpha', 'trg1', '--reason', 'not needed']);
    const built = buildRequest(row, parsed);
    assert.equal(built.path, row.route.split(' ')[1]!.replace(':slug', 'alpha').replace(':id', 'trg1'));
    assert.deepEqual(built.body, { reason: 'not needed' });
  });

  test('a GET row sends its extras and flags on the query string, not a body', () => {
    const row = verbNamed('journal')!;
    const parsed = parseRowArgs(row, ['alpha', '--limit', '5']);
    const built = buildRequest(row, parsed);
    assert.equal(built.body, undefined);
    assert.match(built.path, /\?limit=5$/);
  });

  test('`status` and `runs` share one bare route: both get latest=1, only status adds slug', () => {
    const runsBuilt = buildRequest(verbNamed('runs')!, { positionals: {}, flags: {} });
    assert.equal(runsBuilt.path, `${verbNamed('runs')!.route.split(' ')[1]}?latest=1`);
    const statusParsed = parseRowArgs(verbNamed('status')!, ['alpha']);
    const statusBuilt = buildRequest(verbNamed('status')!, statusParsed);
    const q = new URLSearchParams(statusBuilt.path.split('?')[1]);
    assert.equal(q.get('latest'), '1');
    assert.equal(q.get('slug'), 'alpha');
  });

  test('approve and deny press the identical route and differ only in the decision the CLI injects', () => {
    const approve = buildRequest(verbNamed('approve')!, parseRowArgs(verbNamed('approve')!, ['card1']));
    const deny = buildRequest(verbNamed('deny')!, parseRowArgs(verbNamed('deny')!, ['card1']));
    assert.equal(approve.path, deny.path);
    assert.deepEqual(approve.body, { decision: 'allow' });
    assert.deepEqual(deny.body, { decision: 'deny' });
  });

  test('a boolean-typed field reads true/false as real JSON booleans, never the string', () => {
    const row = verbNamed('trigger')!;
    const parsed = parseRowArgs(row, ['alpha', '--when', 'run-paused', '--then', 'resume', '--every', 'true']);
    assert.equal(parsed.flags.every, true);
    assert.notEqual(parsed.flags.every, 'true');
  });

  test('`--body` is JSON — a trigger presses its verb with an object, not a string', () => {
    const row = verbNamed('trigger')!;
    const parsed = parseRowArgs(row, ['alpha', '--when', 'run-paused', '--then', 'resume', '--body', '{"reason":"x"}']);
    assert.deepEqual(parsed.flags.body, { reason: 'x' });
  });

  test('free text that happens to look numeric stays a string — no blanket JSON coercion', () => {
    const row = verbNamed('note')!;
    const parsed = parseRowArgs(row, ['alpha', '--text', '42']);
    assert.equal(parsed.flags.text, '42');
    assert.equal(typeof parsed.flags.text, 'string');
  });

  test('too few or too many positionals, or an unknown flag, throws a usage message', () => {
    assert.throws(() => parseRowArgs(verbNamed('pause')!, []), /needs slug/);
    assert.throws(() => parseRowArgs(verbNamed('pause')!, ['a', 'b']), /got a b/);
    assert.throws(() => parseRowArgs(verbNamed('pause')!, ['a', '--nope']), /unknown flag --nope/);
  });

  test('exitCodeFor: 2xx ok, 404 not-found, any other 4xx/409 refused, and wait’s 200-but-not-held is timed-out', () => {
    const pause = verbNamed('pause')!;
    assert.equal(exitCodeFor(CLI_EXIT, pause, 200, {}), CLI_EXIT.ok);
    assert.equal(exitCodeFor(CLI_EXIT, pause, 404, {}), CLI_EXIT['not-found']);
    assert.equal(exitCodeFor(CLI_EXIT, pause, 409, {}), CLI_EXIT.refused);
    assert.equal(exitCodeFor(CLI_EXIT, pause, 403, {}), CLI_EXIT.refused);
    const wait = verbNamed('wait')!;
    assert.equal(exitCodeFor(CLI_EXIT, wait, 200, { held: true }), CLI_EXIT.ok);
    assert.equal(exitCodeFor(CLI_EXIT, wait, 200, { held: false, timedOut: true }), CLI_EXIT['timed-out']);
  });

  test('run status and run wait print the status word every surface prints — runStatusWord, never the raw word (phase 88, #148)', async () => {
    const { newRun } = await import('../server/runner/state.ts');
    const { slimRun } = await import('../server/runs-projection.ts');
    const asleep = newRun({ slug: 'alpha', root: scratch() });
    asleep.status = 'paused';
    asleep.stoppedBy = 'system';
    asleep.waitReason = 'usage-limit';
    asleep.waitUntil = new Date(Date.now() + 3_600_000).toISOString();
    const held = newRun({ slug: 'beta', root: scratch() });
    held.status = 'paused';
    held.stoppedBy = 'operator';

    const status = verbNamed('status')!;
    assert.match(renderAnswer(runStatusWord, status, [slimRun(asleep, [])]), /^alpha {2}status=waiting /, 'asleep on a clock nobody paused');
    assert.match(renderAnswer(runStatusWord, status, [slimRun(held, [])]), /^beta {2}status=paused /, "a person's pause");
    const wait = verbNamed('wait')!;
    const waited = { for: 'run-paused', held: true, timedOut: false, waitedMs: 0, run: slimRun(asleep, []) };
    assert.match(renderAnswer(runStatusWord, wait, waited), /\nalpha {2}status=waiting /);
  });
});

/* ------------------------------------------------------------------ *
 * CL-1 — the child process, against a bare stub
 * ------------------------------------------------------------------ */

describe('CL-1 — headers, route filling, flags→body, exit codes, --json', () => {

  test('a GET row with two placeholders and a query flag: tail <slug> <phase> --limit', async () => {
    await withStub(async (stub) => {
      stub.reply(200, { phase: 3, live: false, source: 'session-log', untrusted: true, events: [], bytesRead: 0 });
      const out = await runCli(PRO_CLI, ['run', 'tail', 'alpha', '3', '--limit', '10', '--console', String(stub.port)]);
      assert.equal(out.status, 0, out.stderr);
      const req = stub.requests[0]!;
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/api/run/alpha/phase/3/activity?limit=10');
      assert.equal(req.body, '');
    });
  });


  test('--json prints exactly the raw answer', async () => {
    await withStub(async (stub) => {
      const answer = { run: { id: 'r9', slug: 'alpha', status: 'running', activePhase: 2, phases: { '1': 'done', '2': 'running' } } };
      stub.reply(200, answer);
      const out = await runCli(PRO_CLI, ['run', 'status', 'alpha', '--json', '--console', String(stub.port)]);
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout), answer);
    });
  });


  test('exit 4 when nothing answers the console at all', async () => {
    const out = await runCli(PRO_CLI, ['run', 'status', 'alpha', '--console', '1']);
    assert.equal(out.status, CLI_EXIT['console-down']);
  });

  test('exit 2 on an unknown verb, and on a verb with no CLI shape', async () => {
    const unknown = await runCli(PRO_CLI, ['run', 'not-a-verb', '--console', '1']);
    assert.equal(unknown.status, CLI_EXIT.usage);
    assert.match(unknown.stderr, /unknown verb/);
    const noShape = await runCli(PRO_CLI, ['run', 'stop', 'alpha', '--console', '1']);
    assert.equal(noShape.status, CLI_EXIT.usage);
  });

  test('bare `run` and `run --help` both list every CLI verb; only the bare form is exit 2', async () => {
    const bare = await runCli(PRO_CLI, ['run']);
    assert.equal(bare.status, CLI_EXIT.usage);
    assert.match(bare.stderr, /status <slug>/);
    const help = await runCli(PRO_CLI, ['run', '--help']);
    assert.equal(help.status, CLI_EXIT.ok);
    assert.match(help.stdout, /status <slug>/);
  });

});

/* ------------------------------------------------------------------ *
 * CL-2 — a real act, through the real routes, attributed and journalled
 * ------------------------------------------------------------------ */

describe('CL-2 — an act pressed through the CLI is via: cli, journalled the same as any other route caller', () => {

  test('the free CLI never even opens the connection for an act — reads still reach the real route', async () => {
    const root = scratch();
    const svc = await service(root);
    const { handleApi } = await import('../server/api/routes.ts');
    const server = createServer((req, res) => {
      void handleApi({ service: svc } as never, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const read = await runCli(FREE_CLI, ['run', 'status', 'alpha', '--console', String(port)]);
      assert.equal(read.status, 0, read.stderr);
      const act = await runCli(FREE_CLI, ['run', 'pause', 'alpha', '--console', String(port)]);
      assert.equal(act.status, CLI_EXIT.usage);
      assert.match(act.stderr, /Phase Console Pro/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      svc.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * CL-3 — editions
 * ------------------------------------------------------------------ */

describe('CL-3 — the free CLI refuses acts by edition; Pro asks the license gate', () => {
  const actRows = OPERATOR_VERBS.filter((row) => row.cli !== null && row.edition === 'pro');

  test('the table actually has act rows to test (not a vacuous pass)', () => {
    assert.ok(actRows.length >= 19, `only ${actRows.length} pro act rows found`);
  });

  test('every act row (and wait) is refused by the free CLI, exit 2, naming Pro — and nothing was ever dialled', async () => {
    // A port nothing listens on: if the free build ever tried the network for
    // one of these, the answer would be exit 4 (console-down), not 2 — so this
    // loop also proves the refusal happens before any connection is attempted.
    const DEAD_PORT = '1';
    for (const row of actRows) {
      const args = row.cli!.args.map((name) => (name === 'phase' ? '1' : name === 'id' ? 'abc123456789' : 'demo'));
      // eslint-disable-next-line no-await-in-loop -- one child process at a time, deliberately
      const out = await runCli(FREE_CLI, ['run', row.name, ...args, '--console', DEAD_PORT]);
      assert.equal(out.status, CLI_EXIT.usage, `${row.name}: ${out.stderr || out.stdout}`);
      assert.match(out.stderr, /Phase Console Pro/, row.name);
    }
  });


  test('every read row is free in both editions — the table itself says so, which is what the CLI’s gate reads', () => {
    const reads = OPERATOR_VERBS.filter((row) => row.cli !== null && row.kind === 'read');
    for (const row of reads) {
      if (row.name === 'wait') { assert.equal(row.edition, 'pro', 'wait is the one read the table marks Pro'); continue; }
      assert.equal(row.edition, 'free', row.name);
    }
  });
});
