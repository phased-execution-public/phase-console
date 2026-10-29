/**
 * A Retry never answers 200 over nothing (measured-console phase 13, #424 #425).
 *
 * #424 — `POST /api/run/<slug>/retry {phase, addendum}` on a phase whose
 * session was RUNNING answered 200, journaled the addendum and a re-board
 * rung, and then did nothing with either: the session never saw the words (a
 * production release GO), and three minutes later the supervisor flagged
 * `hinted-not-queued`. The addendum now reaches the running session as an
 * operator message (`deliver: next-turn`), answered `{delivered: 'message'}`;
 * a plain Retry there refuses 409 naming the session.
 *
 * #425 — a Retry on a DONE phase answered 200 with the run and did nothing:
 * the loop never boards a phase the board reads done. It refuses 409 with the
 * reason now.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-10-26
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | release | 1 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — release
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-retry-live-done-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

type Captured = { status: number; body: Record<string, unknown> };

/** One HTTP call against the real route table, read the way a client reads it. */
async function call(svc: unknown, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (retry test)' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

const journalOn = (root: string, runId: string) => {
  try {
    return readFileSync(journalFile(root, 'alpha', runId), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; phase?: number; t?: string; at?: string; data?: Record<string, unknown> });
  } catch { return []; }
};

/**
 * A run of alpha whose phase 2 is RUNNING in a lane this console holds — the
 * #424 shape: phase 8 resumed by its own landed watch 41 s before the Retry.
 * The plan's runner is the real one with its lane facts stubbed; its stdin is
 * open, so the console's own message bus can reach the session.
 */
function liveLane(svc: ReturnType<typeof service>, root: string) {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'running';
  state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
  const record = phaseRecord(state, 2);
  record.status = 'running';
  record.attempts = 1;
  record.sessionId = 'sess-live';
  saveRun(state);
  const told: string[] = [];
  const retried: unknown[] = [];
  const runner = svc.runnerFor('alpha') as unknown as Record<string, unknown>;
  Object.assign(runner, {
    busy: () => true,
    current: () => state,
    laneHeld: (phase: number) => phase === 2,
    livePhases: () => [2],
    canTell: (phase: number) => phase === 2,
    tellMessage: (phase: number, framed: string) => { told.push(`${phase}:${framed}`); return true; },
    retry: (...args: unknown[]) => { retried.push(args); },
  });
  const sessions = svc.sessions as unknown as { presence: (id: string) => string };
  const presence = sessions.presence.bind(sessions);
  sessions.presence = (id: string) => (id === 'sess-live' ? 'live' : presence(id));
  return { state, told, retried };
}

/* ------------------------------------------------------------------ *
 * #424 — a Retry on a LIVE phase
 * ------------------------------------------------------------------ */

test('#424: a plain Retry on a live phase refuses 409 naming its session — never a 200 that resets a running record', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const { state, retried } = liveLane(svc, root);
    const out = await call(svc, '/api/run/alpha/retry', { phase: 2 });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.match(String(out.body.error), /Phase 2 of alpha is live \(session sess-live\)/);
    assert.equal(out.body.sessionId, 'sess-live');
    assert.deepEqual(retried, [], 'the runner was never told to retry a running phase');
    assert.equal(phaseRecord(state, 2).status, 'running', 'the running record is untouched');
    assert.equal(journalOn(root, state.id).filter((l) => l.event === 'phase.retry-requested').length, 0);
    // Per-phase settings cannot change under a running session either.
    const edited = await call(svc, '/api/run/alpha/retry', { phase: 2, addendum: 'go', options: { model: 'sonnet' } });
    assert.equal(edited.status, 409, JSON.stringify(edited.body));
    assert.match(String(edited.body.error), /settings cannot change under a running session/);
  } finally {
    svc.close();
  }
});


/* ------------------------------------------------------------------ *
 * #425 — a Retry on a DONE phase
 * ------------------------------------------------------------------ */

test('#425: a Retry on a done phase refuses 409 with the reason — never 200 over an unchanged run', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    // Phase 2 is done on the board (its handoff says complete) and in the
    // record; the run is parked on something else.
    for (const [phase, title] of [[1, 'schema'], [2, 'release']] as const) {
      writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-${title}.md`),
        `---\nplan: docs/plans/alpha.md\nphase: ${phase}\ntitle: ${title}\nstatus: complete\n---\n# done\n`, 'utf8');
    }
    const state: RunState = newRun({ slug: 'alpha', root });
    state.status = 'parked';
    state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
    Object.assign(phaseRecord(state, 2), { status: 'done', attempts: 7 });
    saveRun(state);
    const starts: unknown[] = [];
    (svc as unknown as { startRun: (...args: unknown[]) => unknown }).startRun = async (...args: unknown[]) => { starts.push(args); return state; };
    const before = journalOn(root, state.id).length;

    const out = await call(svc, '/api/run/alpha/retry', { phase: 2, addendum: 'Release A.2: cut it.' });
    assert.notEqual(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.status, 409);
    assert.match(String(out.body.error), /^Phase 2 of alpha is done — /);
    assert.match(String(out.body.error), /no verb that re-opens a done phase/);
    assert.equal(out.body.run, undefined, 'no run answered for an act that did not happen');
    assert.deepEqual(starts, [], 'the run was not continued');
    const after = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(after.phases['2'].status, 'done');
    assert.equal(after.phases['2'].attempts, 7);
    assert.equal(journalOn(root, state.id).length, before, 'nothing journalled as if it retried');

    // A phase that is NOT done is retried as before.
    Object.assign(phaseRecord(state, 2), { status: 'parked' });
    saveRun(state);
    writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-02-release.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 2\ntitle: release\nstatus: in-progress\n---\n# going\n', 'utf8');
    const retried = await call(svc, '/api/run/alpha/retry', { phase: 2 });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(starts.length, 1, 'the stored run was continued');
  } finally {
    svc.close();
  }
});
