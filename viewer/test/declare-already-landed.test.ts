/**
 * A session is never parked on something that has already happened (#86,
 * control-tower phase 50).
 *
 * Measured: 5 of 30 declared watch refs were already true when declared (8 of
 * 30 at the first probe) — three workflow runs had completed before the
 * session said it would wait for them. Each cost a park, a probe on the next
 * tick and a resume of a 300–470k-token context.
 *
 *   AL-1  at ingest the console asks a declaration's pollable refs within 20 s,
 *         and a ref that has ALREADY landed answers the still-live session
 *         "already landed — continue" through `phase-outcome.sh`'s exit 3,
 *         parking nothing;
 *   AL-2  a ref that has not landed, or a declaration the door refuses, parks
 *         exactly as before;
 *   AL-3  with no console answering, it parks as before.
 *
 * The script is driven for real, against a console of this test's own: a
 * node `http` server routing into the real `handleApi`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WatchState } from '../server/watch-refs.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { runDir } = await import('../server/runner/state.ts');
const { outcomeInboxDir } = await import('../server/runner/outcome.ts');
const {
  ALREADY_LANDED_EXIT, ALREADY_LANDED_EVENT, DECLARED_PROBE_BUDGET_MS, answerDeclaredProbe,
} = await import('../server/declared-probe.ts');
const { WatchScheduler } = await import('../server/watch-scheduler.ts');
const { handleApi } = await import('../server/api/routes.ts');

const SCRIPT = join(SKILL_DIR, 'scripts', 'phase-outcome.sh');
const REF = 'gh:acme/app#run/35294570835';

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function repoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-already-landed-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  return root;
}

/** Stage a declaration where `phase-outcome.sh` stages one, and answer its path. */
function stage(dir: string, name: string, body: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    version: 1, slug: 'demo', phase: 4, status: 'waiting-external', watch: [REF],
    written_at: new Date().toISOString(), ...body,
  }));
  return path;
}

const landedProbe = (detail = 'completed: success') => async (_slug: string, _phase: number, refs: readonly string[]) => ({
  landed: { ref: refs[0], state: 'landed', detail } as WatchState,
  refs: refs.map((ref, i) => ({ ref, state: i === 0 ? 'landed' : 'pending' }) as WatchState),
});
const pendingProbe = async (_slug: string, _phase: number, refs: readonly string[]) => ({
  landed: null, refs: refs.map((ref) => ({ ref, state: 'pending' }) as WatchState),
});

/* ------------------------------------------------------------------ *
 * AL-1 — the door's rules
 * ------------------------------------------------------------------ */

test('AL-1: a staged declaration whose ref has already landed answers "continue", and journals it on its run', async () => {
  const root = repoRoot();
  const file = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json.tmp.4242', {});
  const journal: { runId: string | null; kind: string; data: Record<string, unknown>; phase: number }[] = [];
  const answer = await answerDeclaredProbe({ slug: 'demo', phase: 4, file }, {
    root, probe: landedProbe(),
    journal: (_slug, runId, kind, data, phase) => { journal.push({ runId, kind, data, phase }); },
  });
  assert.equal(answer.status, 200);
  assert.equal('verdict' in answer && answer.verdict, 'landed');
  if (answer.status !== 200 || answer.verdict !== 'landed') return;
  assert.equal(answer.ref, REF);
  assert.match(answer.sentence, /^already landed — continue: gh:acme\/app#run\/35294570835 \(completed: success\)\./);
  assert.doesNotMatch(answer.sentence, /"/, 'quote-free, so the script can lift it from the JSON');
  assert.equal(journal.length, 1);
  assert.deepEqual([journal[0].runId, journal[0].kind, journal[0].phase], ['abc123', ALREADY_LANDED_EVENT, 4]);
  assert.equal(journal[0].data.ref, REF);
  assert.equal(journal[0].data.status, 'waiting-external');
  assert.ok(existsSync(file), 'the door never touches the file — the script decides what becomes of it');
  assert.equal(DECLARED_PROBE_BUDGET_MS, 20_000, 'the ingest probe is bounded at 20 s in total');
  assert.equal(ALREADY_LANDED_EXIT, 3);
});

test('AL-1: blocked and needs-human refs are asked too; the unsupervised inbox is a door as well', async () => {
  const root = repoRoot();
  for (const status of ['blocked', 'needs-human']) {
    const file = stage(outcomeInboxDir(root, 'demo'), `phase-04-20260923T103000Z.json.tmp.${status.length}`,
      { status, needs: 'credential', watch: ['cmd:"security find-generic-password -s demo-token"'] });
    const answer = await answerDeclaredProbe({ slug: 'demo', phase: 4, file }, { root, probe: landedProbe('exit 0') });
    assert.equal(answer.status === 200 && answer.verdict, 'landed', status);
  }
});

test('AL-2: the door refuses what is not a fresh, staged, parking declaration of its own plan — and a refusal parks as before', async () => {
  const root = repoRoot();
  const deps = { root, probe: landedProbe() };
  const asked = async (file: string, over: Record<string, unknown> = {}) =>
    answerDeclaredProbe({ slug: 'demo', phase: 4, file, ...over }, deps);
  // Outside the console's own state directory.
  const elsewhere = stage(root, 'run-abc123-p4-outcome.json.tmp.1', {});
  assert.equal((await asked(elsewhere)).status, 404);
  // Not a staged name — a landed file, or anything else.
  const landedName = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json', {});
  assert.equal((await asked(landedName)).status, 400);
  // Another phase's file, or another phase in the body.
  const other = stage(runDir(root, 'demo'), 'run-abc123-p5-outcome.json.tmp.2', { phase: 5 });
  assert.equal((await asked(other)).status, 400);
  // A declaration that parks nothing has nothing to probe.
  const partial = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json.tmp.3', { status: 'partial' });
  assert.equal((await asked(partial)).status, 409);
  // A stale one is not what a live session is waiting on.
  const stale = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json.tmp.4', {
    written_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  assert.equal((await asked(stale)).status, 409);
  // A relative path, a bad slug, a bad phase.
  assert.equal((await asked('run-abc123-p4-outcome.json.tmp.5')).status, 400);
  assert.equal((await asked(elsewhere, { slug: '../demo' })).status, 400);
  assert.equal((await asked(elsewhere, { phase: 0 })).status, 400);
  // No repository at all.
  assert.equal((await answerDeclaredProbe({ slug: 'demo', phase: 4, file: elsewhere }, { root: null, probe: landedProbe() })).status, 404);
});

test('AL-2: a ref that has not landed is pending — the declaration parks', async () => {
  const root = repoRoot();
  const file = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json.tmp.7', {});
  const answer = await answerDeclaredProbe({ slug: 'demo', phase: 4, file }, { root, probe: pendingProbe });
  assert.deepEqual(answer.status === 200 && answer.verdict, 'pending');
  const none = stage(runDir(root, 'demo'), 'run-abc123-p4-outcome.json.tmp.8', { watch: ['url:https://ci.example.com/9'] });
  let asked = 0;
  const unpollable = await answerDeclaredProbe({ slug: 'demo', phase: 4, file: none }, {
    root, probe: async (...args) => { asked += 1; return landedProbe()(...args); },
  });
  assert.equal(unpollable.status === 200 && unpollable.verdict, 'pending', 'nothing pollable is never a landing');
  assert.equal(asked, 0);
});

/* ------------------------------------------------------------------ *
 * AL-1 — the scheduler's bounded probe
 * ------------------------------------------------------------------ */

test('AL-1: probeDeclared asks every ref at once, bounded by the budget; own-lock is refused, a freeze answers nothing', async () => {
  const never = new Promise<WatchState>(() => {});
  const scheduler = new WatchScheduler({
    runs: () => [],
    probe: async (target) => (target.ref === REF
      ? { ref: target.ref, state: 'landed', detail: 'completed: failure' }
      : target.ref.startsWith('cmd:') ? never : { ref: target.ref, state: 'pending' }),
  });
  const started = Date.now();
  const answer = await scheduler.probeDeclared('demo', 4, ['cmd:"sleep 999"', 'gh:acme/app#pr/9', REF, 'lock:demo/4'], { budgetMs: 150 });
  assert.ok(Date.now() - started < 2_000, 'a ref that never answers costs the budget, not the session');
  assert.equal(answer.landed?.ref, REF);
  const by = Object.fromEntries(answer.refs.map((r) => [r.ref, r.state]));
  assert.deepEqual(by, { 'cmd:"sleep 999"': 'unknown', 'gh:acme/app#pr/9': 'pending', [REF]: 'landed', 'lock:demo/4': 'refused' });
  const frozen = new WatchScheduler({ runs: () => [], fleetHold: () => ({ at: 'now' }), probe: async (t) => ({ ref: t.ref, state: 'landed' }) });
  const held = await frozen.probeDeclared('demo', 4, [REF], { budgetMs: 150 });
  assert.equal(held.landed, null, 'a frozen console answers nothing, and the declaration parks');
});

/* ------------------------------------------------------------------ *
 * AL-1..3 — the real script against a console of this test's own
 * ------------------------------------------------------------------ */

type Console = { url: string; requests: number; close: () => Promise<void> };

async function consoleOf(root: string, probe: typeof pendingProbe): Promise<Console> {
  const service = {
    flags: {},
    probeDeclaration: (body: Record<string, unknown>) => answerDeclaredProbe(body, { root, probe }),
  };
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    void handleApi({ service } as never, req, res, new URL(`http://127.0.0.1${req.url}`)).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() { return state.requests; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function declare(root: string, url: string | null, args: string[], env: Record<string, string> = {}) {
  const file = join(runDir(root, 'demo'), 'run-abc123-p4-outcome.json');
  mkdirSync(runDir(root, 'demo'), { recursive: true });
  // Asynchronous on purpose: the console answering it lives in THIS process,
  // and a synchronous spawn would hold the event loop it answers on.
  const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile('bash', [SCRIPT, 'demo', '4', ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env,
      DOCS_ROOT: root, PE_OUTCOME_FILE: file, PHASE_OUTCOME_PROBE: '1',
      PHASE_CONSOLE_URL: url ?? 'http://127.0.0.1:9', ...env,
    },
    }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });
  const leftovers = readdirSync(runDir(root, 'demo')).filter((name) => name.includes('.tmp.'));
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, file, landed: existsSync(file), leftovers };
}

test('AL-1: the script asks, hears "already landed", parks nothing and exits 3 — the sentence on stdout', async () => {
  const root = repoRoot();
  const console = await consoleOf(root, landedProbe());
  try {
    const out = await declare(root, console.url, ['waiting-external', '--wait-minutes', '30', '--reason', 'the deploy', '--watch', REF]);
    assert.equal(out.code, ALREADY_LANDED_EXIT, out.stderr);
    assert.match(out.stdout, /^already landed — continue: gh:acme\/app#run\/35294570835 \(completed: success\)/);
    assert.equal(out.landed, false, 'no declaration was written — nothing parks');
    assert.deepEqual(out.leftovers, [], 'the staged file is gone');
    assert.equal(console.requests, 1);
  } finally {
    await console.close();
  }
});

test('AL-2: a pending answer parks as before — the declaration is written, exit 0', async () => {
  const root = repoRoot();
  const console = await consoleOf(root, pendingProbe);
  try {
    const out = await declare(root, console.url, ['waiting-external', '--wait-minutes', '30', '--watch', REF]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.landed, true);
    assert.equal(JSON.parse(readFileSync(out.file, 'utf8')).status, 'waiting-external');
    assert.deepEqual(out.leftovers, []);
    assert.equal(console.requests, 1);
  } finally {
    await console.close();
  }
});

test('AL-1: #122\'s block on a sibling\'s handoff is asked at ingest — complete already parks nothing, still working is written `blocked` for the runner\'s poll-park', async () => {
  // P50's declaration (hub run 24fcba33, control-tower phase 87): blocked on a
  // sibling's WIP, watching that sibling's handoff. A sibling that has already
  // finished is news for the session, not a park; one still working is a wait
  // the runner parks `waiting` on this ref — never a failure.
  // Absolute since control-tower phase 88 (#152): the console runs a cmd: ref
  // from its own root, so the script refuses a relative path with exit 2 — and
  // it now recommends phase:demo/43 for this wait.
  const sibling = "cmd:grep -q '^status: complete' /work/docs/handoffs/demo/phase-43-perf-ii-catalogs.md";
  const args = ['blocked', '--needs', 'external', '--reason', 'the only red is P43\'s WIP', '--watch', sibling];
  const root = repoRoot();
  const finished = await consoleOf(root, landedProbe('exit 0'));
  try {
    const out = await declare(root, finished.url, args);
    assert.equal(out.code, ALREADY_LANDED_EXIT, out.stderr);
    assert.ok(out.stdout.startsWith(`already landed — continue: ${sibling}`), out.stdout);
    assert.equal(out.landed, false, 'nothing parks, nothing fails');
  } finally {
    await finished.close();
  }
  const working = await consoleOf(root, pendingProbe);
  try {
    const out = await declare(root, working.url, args);
    assert.equal(out.code, 0, out.stderr);
    const written = JSON.parse(readFileSync(out.file, 'utf8'));
    assert.equal(written.status, 'blocked');
    assert.deepEqual(written.watch, [sibling], 'the ref arrives whole, for the watch clock to poll');
    assert.equal(written.needs, 'external');
  } finally {
    await working.close();
  }
});

test('AL-3: with no console answering it parks as before; a declaration with nothing to ask asks nothing', async () => {
  const root = repoRoot();
  const nobody = await declare(root, null, ['waiting-external', '--wait-minutes', '30', '--watch', REF]);
  assert.equal(nobody.code, 0, nobody.stderr);
  assert.equal(nobody.landed, true, 'no console: written, exactly as before');
  assert.deepEqual(nobody.leftovers, []);
  const console = await consoleOf(root, landedProbe());
  try {
    for (const args of [
      ['waiting-external', '--wait-minutes', '30'],
      ['partial', '--reason', 'context'],
    ]) {
      const out = await declare(root, console.url, args);
      assert.equal(out.code, 0, `${args[0]}: ${out.stderr}`);
      assert.equal(out.landed, true);
    }
    const off = await declare(root, console.url, ['waiting-external', '--wait-minutes', '30', '--watch', REF], { PHASE_OUTCOME_PROBE: '0' });
    assert.equal(off.code, 0);
    assert.equal(console.requests, 0, 'no refs, a status that parks nothing, or the probe switched off: no request');
  } finally {
    await console.close();
  }
});

test('AL-1: the door is for a session on this machine only', async () => {
  const service = { flags: {}, probeDeclaration: () => { throw new Error('must not be reached'); } };
  const out = { status: 0 };
  const req = {
    method: 'POST', headers: {}, socket: { remoteAddress: '10.0.0.5' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); },
  };
  const res = { writeHead(status: number) { out.status = status; return this; }, end() { return this; }, on() { return this; } };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/hooks/declaration'));
  assert.equal(out.status, 403);
});
