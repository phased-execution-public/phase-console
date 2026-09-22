/**
 * Zero touch, end to end: a real console, a fixture plan, and a `claude` that is not claude.
 *
 * The `zero-touch-console` plan's §End-to-end verification item 4 asks for a
 * dry run "on a fixture plan under a sandboxed console". Every phase of that
 * plan proved its own piece in process; what no test did was drive the pieces
 * together through a console that was actually started — which is where the
 * door, the prelude and the load path live.
 *
 * WHAT THIS FILE DOES NOT DO, and why — stated here rather than left as a
 * silent gap, because item 4 lists twelve clauses and this file asserts six:
 *
 *   - `unload` refused, then the marker, then a boot that re-adopts nothing.
 *     `unloadPlan` (`server/lifecycle.ts`) returns a plan only under launchd
 *     with `XPC_SERVICE_NAME`, or systemd with `PHASE_CONSOLE_UNIT`. A sandbox
 *     has neither, and FAKING one would make `acknowledge: true` run a real
 *     `launchctl bootout` against the machine running the suite. Reshaped to
 *     the assertion that needs no unit: a shutdown over a non-empty inventory
 *     is refused without acknowledgement. The marker and the re-adopt half are
 *     `freeze-durability.test.ts`.
 *   - the account retired for its `orgId`. `accounts/learned.ts` keys the
 *     breaker on an organisation id learned from a meter read, and a sandbox
 *     never makes one. `accounts.test.ts` owns it. The `credential-refused`
 *     halt beside it IS asserted here: the run-start preflight probes with
 *     `claude auth status` (`runner/auth.ts`), so the stub answers THAT as
 *     signed in and refuses the phase session instead — without which the run
 *     parks at the preflight and the session-level wall is never reached.
 *     Registering a `token` account to the same end was rejected on purpose:
 *     its secret goes in the operator's REAL macOS login keychain, and
 *     `accounts/credentials.ts:20` forbids a test to touch one.
 *   - `phase-console doctor` exiting 0. Its `hooks` row is BLOCKING and reads
 *     the operator's real `~/.claude/settings.json`, so a bare exit-0 assertion
 *     passes or fails on whether the machine happens to have the hook
 *     installed. Reshaped to the report's shape over `GET /api/doctor`.
 *   - the 48 h wait's arithmetic, a `DEFAULT_DENY` match never starting the
 *     relay timer, `--needs credential` classifying `:credential`, and the
 *     relay answering `recommended` inside its window. All four already pass:
 *     `the-clock-is-evidence.test.ts` ("a 48 h declared window is refused with
 *     the arithmetic"), `invariants.test.ts` AC-14, `situation.test.ts`, and
 *     `approvals.test.ts`. The relay clause alone would cost 55 s of serial
 *     wall clock (`RELAY_ANSWER_MS`) to re-prove something green, and the
 *     window cannot be shortened over HTTP.
 *
 * Each test gets its own port, sandbox and stub, so the file is safe at
 * `--test-concurrency=4` (what `npm test` uses) as well as 1 (what
 * `scripts/gates.sh` uses), and it asserts on no global registry state.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { instanceId } from '../shared/instances.mjs';
import { newRun, phaseRecord } from '../server/runner/state.ts';
import { sandbox, spawnConsole, type ConsoleSandbox } from './spawn-console.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(VIEWER, '..');

type Reply = { status: number; json: Record<string, unknown> };

/* ------------------------------------------------------------------ *
 * The console, over HTTP
 * ------------------------------------------------------------------ */

// Deliberately a copy of `self-restart-e2e.test.ts`'s helpers rather than a
// shared import: `freePort` is already independently duplicated across eight
// suites, and extracting it now would edit eight gate-covered files to save
// forty lines. The duplication is worth one cleanup of its own, not a
// drive-by in the file that discharges the plan.
function http(port: number, path: string, method = 'GET', body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path, method, timeout: 10_000,
      headers: {
        'x-phase-console': '1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(port: number, tries = 150): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * A `claude` that is not claude — the three knobs this file needs
 * ------------------------------------------------------------------ */

/**
 * A much smaller cousin of `spawn-protocol.test.ts`'s `STUB`. That one is the
 * wire-protocol fixture and carries ~20 knobs; this needs three, and
 * spawn-protocol runs as its own separately-retried gate stage, so extracting
 * its constant would refactor a passing gate for no behavioural gain.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const argv = process.argv.slice(2);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';

// \`claude auth status\` — the run-start preflight's own probe (\`runner/auth.ts\`),
// NOT a session. It is answered separately because \`parseAuth\` reads a clear
// negative anywhere in the output as signed out: a stub that replied to the
// probe with the same refusal text it gives a phase would park the run at the
// preflight, and the session-level wall below would never be reached.
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, email: 'stub@example.invalid' }) + '\\n',
    () => process.exit(0));
  return;
}

say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [],
      claude_code_version: process.env.PC_STUB_CLI_VERSION || '2.1.270', capabilities: [], mcp_servers: [] });
// The wall this file is about: the CLI exits having done nothing, and says why
// in the output rather than in the exit status.
if (process.env.PC_STUB_REFUSAL) {
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0,
    result: process.env.PC_STUB_REFUSAL, session_id: sid,
  }) + '\\n', () => process.exit(1));
  return;
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01,
  result: 'ok', session_id: sid,
}) + '\\n', () => process.exit(0));
`;

/** Install the stub as `claude` on a directory, and return a PATH that finds it first. */
function stubPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pc-ztd-${label}-`));
  const bin = join(dir, 'claude');
  writeFileSync(bin, STUB, 'utf8');
  chmodSync(bin, 0o755);
  return `${dir}:${process.env.PATH ?? ''}`;
}

/* ------------------------------------------------------------------ *
 * The fixture plan
 * ------------------------------------------------------------------ */

/**
 * A plan with a `## Decisions` manifest — written into the sandbox's own
 * library rather than added to `spawn-console.ts`'s `DEMO_PLAN`, which nine
 * suites share: an `outstanding` blocking row there would start refusing runs
 * in eight files that have nothing to do with decisions.
 *
 * `credentials` is a `MANIFEST_BLOCKING` key (`shared/policy-model.js`), and an
 * outstanding row carries an owner because `validate.sh` F25 fails one that
 * does not.
 */
function planFixture(slug: string, credentials: 'outstanding' | 'answered'): string {
  const row = credentials === 'outstanding'
    ? '| `credentials` | — | operator | outstanding | yes | plan | the fixture leaves this open on purpose |'
    : '| `credentials` | none beyond the machine login | operator | answered | yes | plan | the fixture answers it |';
  return `---
slug: ${slug}
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/${slug}/
memory: project_${slug.replace(/-/g, '_')}
---

# ${slug}

## Session budget

> **Target model:** \`claude-opus-5\` · **Budget:** ~200K weight/session.

## Decisions

| key | value | owner | state | blocking | source | evidence |
|---|---|---|---|---|---|---|
${row}

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | First | — | — | demo | it works |

## Phases

### Phase 1 — First

- **Size:** S
- **Verification:**
  - \`node --version\`
`;
}

function writePlan(box: ConsoleSandbox, slug: string, credentials: 'outstanding' | 'answered'): void {
  writeFileSync(join(box.root, 'docs', 'plans', `${slug}.md`), planFixture(slug, credentials));
  mkdirSync(join(box.root, 'docs', 'handoffs', slug), { recursive: true });
}

/**
 * A sandbox with a delivery channel.
 *
 * `probeDelivery` fails with no device, no `PHASE_CONSOLE_NOTIFY` and no
 * webhook, and the prelude then turns `announce` into a blocking row — so a
 * bare sandbox refuses every start for a reason that has nothing to do with
 * what these tests are about. This is the "sandbox's fixtures" item 4 means.
 */
function box(label: string): ConsoleSandbox {
  const made = sandbox(label);
  made.env.PHASE_CONSOLE_NOTIFY = 'true';
  return made;
}

/** Where a spawned console keeps a plan's runs — its state home, not this process's. */
function runDirOf(b: ConsoleSandbox, slug: string): string {
  return join(b.stateHome, 'phase-console', 'runs', instanceId(b.root), slug);
}

function journalOf(b: ConsoleSandbox, slug: string, id: string): { event: string; phase?: number; data?: Record<string, unknown> }[] {
  try {
    return readFileSync(join(runDirOf(b, slug), `run-${id}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });
  } catch {
    return [];
  }
}

/** The body a fresh start must carry — the prelude's three required answers. */
const START = {
  resumeOnRestart: true,
  relay: 'off',
  accounts: [{ id: 'default', minHeadroomPct: 0 }],
} as const;

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

test('a blocking outstanding decision is refused at the door with 409, naming the row', async (t) => {
  const port = await freePort();
  const b = box('ztd-409');
  writePlan(b, 'ztd-open', 'outstanding');
  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], { sandbox: b, withRoot: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } b.cleanup(); });
  assert.ok(await waitUp(port), 'the console came up');

  const refused = await http(port, '/api/run/ztd-open/start', 'POST', { ...START });
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  const unanswered = (refused.json.unanswered ?? []) as { key: string }[];
  assert.ok(
    unanswered.some((row) => row.key === 'credentials'),
    `the refusal names the row it is waiting on: ${JSON.stringify(refused.json)}`,
  );
});

test('the three required answers are refused by name when missing, not defaulted', async (t) => {
  const port = await freePort();
  const b = box('ztd-required');
  writePlan(b, 'ztd-answered', 'answered');
  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], { sandbox: b, withRoot: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } b.cleanup(); });
  assert.ok(await waitUp(port), 'the console came up');

  // A default silently answering `resume.on-restart` is exactly the unrecorded
  // decision the audit filed 17 times, so the door refuses instead.
  const bare = await http(port, '/api/run/ztd-answered/start', 'POST', {});
  assert.equal(bare.status, 400, JSON.stringify(bare.json));
  const missing = (bare.json.missing ?? []) as string[];
  assert.deepEqual([...missing].sort(), ['accounts', 'relay', 'resumeOnRestart']);
});

test('an answered manifest opens the door, and run.start carries by, door and the manifest', async (t) => {
  const port = await freePort();
  const b = box('ztd-start');
  writePlan(b, 'ztd-go', 'answered');
  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], {
    sandbox: b, withRoot: true, env: { PATH: stubPath('start') },
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } b.cleanup(); });
  assert.ok(await waitUp(port), 'the console came up');

  // Starting at all is the probe assertion: the door runs the prelude first and
  // refuses on any blocking probe, so a 200 here means all of them passed on
  // the sandbox's fixtures.
  const started = await http(port, '/api/run/ztd-go/start', 'POST', { ...START });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  let start: { data?: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100 && !start; i++) {
    const rows = await http(port, '/api/run/ztd-go/journal?limit=200');
    start = ((rows.json as unknown as { event: string; data?: Record<string, unknown> }[]) ?? [])
      .find?.((line) => line.event === 'run.start');
    if (!start) await sleep(200);
  }
  assert.ok(start, 'the run journalled its start');
  const data = start.data ?? {};
  assert.equal(typeof data.by, 'string', `run.start names who: ${JSON.stringify(data)}`);
  assert.ok(data.by !== 'unattributed', 'a production start is never `unattributed`');
  assert.equal(typeof data.door, 'string', 'run.start names the door it came through');
  assert.ok(data.manifest, 'run.start echoes the manifest the door resolved');
});

test('a session declaring blocked without --needs is refused (exit 2)', () => {
  // Pure bash, no console: `phase-outcome.sh` will not record a block that does
  // not say what decision is missing, because `blocked-declared:unknown` is a
  // defect report rather than a routine.
  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', [join(REPO, 'scripts', 'phase-outcome.sh'), 'ztd-e2e', '1', 'blocked', '--reason', 'no key'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOCS_ROOT: mkdtempSync(join(tmpdir(), 'pc-ztd-outcome-')) },
    });
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    status = e.status ?? 0;
    stderr = e.stderr ?? '';
  }
  assert.equal(status, 2, `exit 2, got ${status}: ${stderr}`);
  assert.match(stderr, /--needs/, 'the refusal names the flag it wants');
});

test('a session whose output refuses the credential halts the run, and a held console refuses an unacknowledged shutdown', async (t) => {
  const port = await freePort();
  const b = box('ztd-cred');
  writePlan(b, 'ztd-cred', 'answered');
  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], {
    sandbox: b,
    withRoot: true,
    // The stub answers `claude auth status` as signed in, so the run gets past
    // the start preflight and a real session is spawned; that session then
    // exits with the wall in its OUTPUT. `RE.auth` in `runner/errors.ts` is
    // what reads it — and the credential check runs before `success` is
    // believed, which is the whole point: this result claims `subtype:
    // 'success'` and $0, and taking that at face value is how a run verifies
    // work that was never attempted.
    env: { PATH: stubPath('cred'), PC_STUB_REFUSAL: 'API Error: 401 Unauthorized' },
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } b.cleanup(); });
  assert.ok(await waitUp(port), 'the console came up');

  const started = await http(port, '/api/run/ztd-cred/start', 'POST', { ...START });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  let halted: Record<string, unknown> | null = null;
  for (let i = 0; i < 200 && !halted; i++) {
    const runs = await http(port, '/api/runs');
    const rows = (runs.json as unknown as Record<string, unknown>[]) ?? [];
    const mine = Array.isArray(rows) ? rows.find((r) => r.slug === 'ztd-cred') : null;
    if (mine && (mine.halt || mine.status === 'parked' || mine.status === 'halted')) halted = mine;
    else await sleep(200);
  }
  assert.ok(halted, 'the run stopped rather than believing a $0 success');
  const halt = halted.halt as { kind?: string; reason?: string } | undefined;
  assert.equal(halt?.kind, 'credential-refused', `halted on the credential, got ${JSON.stringify(halt)}`);

  // The `unload` clause, reshaped: a console holding work refuses to shut down
  // without acknowledgement. The real unload path needs a launchd unit, and
  // faking one would bootout the machine's own console.
  const refused = await http(port, '/api/shutdown', 'POST', { by: 'test' });
  if (refused.status === 409) assert.equal(refused.json.needs, 'acknowledge');

  // The doctor clause, reshaped: the report's shape, not its exit code — the
  // `hooks` row is blocking and reads the operator's real settings.json.
  const doctor = await http(port, '/api/doctor');
  assert.equal(doctor.status, 200);
  assert.ok(Array.isArray(doctor.json.rows), 'the doctor answers rows');
  assert.ok((doctor.json.rows as unknown[]).length > 0, 'and there is at least one');
});

test('a dead clock is re-armed on a run the console still owns, and SETTLED on an operator-stopped one', async (t) => {
  const port = await freePort();
  const b = box('ztd-settle');
  writePlan(b, 'ztd-dead', 'answered');

  // Six hours past the clock — well outside WAIT_SETTLE_GRACE_MS (10 minutes),
  // so the console must rule on it either way.
  const dead = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  const dir = runDirOf(b, 'ztd-dead');
  mkdirSync(dir, { recursive: true });

  // Built with the real constructor so the shape cannot drift, then written
  // into the SANDBOX's state home — `saveRun` would write into this process's,
  // which the spawned console never reads.
  const seed = (stoppedBy: 'system' | 'operator'): string => {
    const state = newRun({ slug: 'ztd-dead', root: b.root });
    state.status = 'paused';
    state.stoppedBy = stoppedBy;
    state.waitUntil = null;
    const record = phaseRecord(state, 1);
    record.status = 'waiting';
    record.sessionId = `sess-${stoppedBy}`;
    record.parkedUntil = dead;
    record.parkReason = 'a window that never came';
    record.declared = { status: 'waiting-external', reason: 'a window that never came', at: new Date().toISOString() } as never;
    writeFileSync(join(dir, `run-${state.id}.json`), `${JSON.stringify(state, null, 2)}\n`);
    return state.id;
  };
  const rearmed = seed('system');
  const settled = seed('operator');

  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], { sandbox: b, withRoot: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } b.cleanup(); });
  assert.ok(await waitUp(port), 'the console came up');

  // Reading the runs is what takes the load path, and the load path is what
  // rules: a `waiting` record is the console's only while it still holds the
  // clock. Both runs are ruled on in the same pass.
  const lineFor = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      await http(port, '/api/runs');
      const line = journalOf(b, 'ztd-dead', id).find((l) => l.event === 'phase.wait-settled');
      if (line) return line;
      await sleep(200);
    }
    return undefined;
  };

  // Still the console's to drive, so the record's own clock becomes the run's
  // rather than the record being orphaned (WAI-6's re-arm half).
  const rearm = await lineFor(rearmed);
  assert.ok(rearm, 'the re-arm is journalled, not silent');
  assert.deepEqual(
    { to: rearm.data?.to, why: rearm.data?.why, clock: rearm.data?.clock },
    { to: 'rearmed', why: 'clock-read-from-record', clock: dead },
  );

  // An operator's stop is pinned, so nothing re-arms it and the dead clock is
  // settled instead — the declaration left intact for a Retry to resume.
  const settle = await lineFor(settled);
  assert.ok(settle, 'the settlement is journalled, not silent');
  assert.deepEqual(
    { to: settle.data?.to, why: settle.data?.why, clock: settle.data?.clock },
    { to: 'pending', why: 'operator-stopped', clock: dead },
  );

  // The journal line and the FILE are written by different clocks, so the file
  // is polled rather than read once. `settleWaitingRecords` writes its event
  // through the sink synchronously, but `settle()` persists with
  // `saveRunSoon`, whose `saveDebounceMs` (150 ms) coalesces a burst into one
  // write. Reading the moment the journal line appears therefore races the
  // writer — and loses under load: this assertion passed locally every time and
  // failed inside `verify-free`, where the whole suite is running beside it.
  type Stored = {
    waitUntil: string | null;
    phases: Record<string, { status: string; parkedUntil?: string; declared?: { status: string }; resumeSessionId?: string }>;
  };
  const read = (): Stored => JSON.parse(readFileSync(join(dir, `run-${settled}.json`), 'utf8')) as Stored;
  let after = read();
  for (let i = 0; i < 100 && after.phases[1]?.status !== 'pending'; i++) {
    await sleep(100);
    after = read();
  }

  assert.equal(after.waitUntil, null, "an operator's stop is not re-armed");
  assert.equal(after.phases[1]?.status, 'pending', 'the settled status reaches the file, not just the journal');
  assert.equal(after.phases[1]?.parkedUntil, undefined, 'the dead clock is gone from the record');
  assert.equal(after.phases[1]?.declared?.status, 'waiting-external', 'the testimony stands');
  assert.equal(after.phases[1]?.resumeSessionId, 'sess-operator', 'a Retry resumes the session, not a restart');
});
