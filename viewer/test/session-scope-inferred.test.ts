/**
 * A terminal session holds what it touched (control-tower phase 82, #119, SS-1..4).
 *
 * Measured on hub 4123: an interactive `claude` opened in the hub ROOT to amend
 * a plan in ANOTHER docs root was registered as a holder of scope `all`, and
 * every queued phase of an unrelated run waited behind it — the run page said
 * only "queued", and the session never knew it was blocking anything. The cwd
 * is not evidence of work; what the session edited, the repositories it
 * changed and the plans its lock and graph calls named are.
 *
 *  - SS-1 the scope is inferred from the transcript; with nothing touched here
 *    it is a bounded unknown lease, and never `all` from the cwd alone;
 *  - SS-2 the holder carries how its scope was read, for the queue and the card;
 *  - SS-3 an operator releases a terminal's hold;
 *  - SS-4 the session's own hook is told, once, that it is blocking a run.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { PEER_CLAIM_WINDOW_MS } = await import('../server/sessions/registry.ts');
const { inferSessionScope, touchesOf, UNKNOWN_LEASE_MS } = await import('../server/sessions/scope-inference.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

/** One transcript line the way the CLI writes it: an assistant turn with tool calls. */
const toolLine = (at: string, ...uses: { name: string; input: Record<string, unknown> }[]): string =>
  JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { role: 'assistant', content: uses.map((use, i) => ({ type: 'tool_use', id: `t${i}`, ...use })) },
  });

/* ------------------------------------------------------------------ SS-1 */

test('SS-1 — the transcript says what a session touched: edits, the repositories it changed, the plans its lock and graph calls named', () => {
  const touches = touchesOf([
    toolLine('2026-09-26T10:00:00Z', { name: 'Edit', input: { file_path: '/w/hub/web/src/a.ts', old_string: 'x', new_string: 'y' } }),
    toolLine('2026-09-26T10:01:00Z', { name: 'Write', input: { file_path: '/w/hub/docs/notes.md', content: '…' } }),
    toolLine('2026-09-26T10:02:00Z', { name: 'NotebookEdit', input: { notebook_path: '/w/hub/lab/n.ipynb' } }),
    toolLine('2026-09-26T10:03:00Z', {
      name: 'Bash',
      input: { command: 'DOCS_ROOT=/w/pe-hub bash /w/pe-hub/console/scripts/phase-graph.sh control-tower --decisions 82' },
    }),
    toolLine('2026-09-26T10:04:00Z', {
      name: 'Bash',
      input: { command: 'bash scripts/phase-lock.sh alpha claim 2 --scope "api,web" --git' },
    }),
    toolLine('2026-09-26T10:05:00Z', { name: 'Bash', input: { command: 'git -C /w/hub/api commit -qm "wip"' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Edit /w/hub/secret.ts please' } }),
    'not json at all',
  ].join('\n'));

  assert.deepEqual(touches.paths.map((touch) => touch.path),
    ['/w/hub/web/src/a.ts', '/w/hub/docs/notes.md', '/w/hub/lab/n.ipynb', '/w/hub/api']);
  assert.equal(touches.paths[0]!.at, Date.parse('2026-09-26T10:00:00Z'));
  assert.deepEqual(touches.plans.map(({ slug, docsRoot, phase, scope }) => ({ slug, docsRoot, phase, scope })), [
    { slug: 'control-tower', docsRoot: '/w/pe-hub', phase: undefined, scope: undefined },
    { slug: 'alpha', docsRoot: undefined, phase: 2, scope: ['api', 'web'] },
  ]);
});

test('SS-1 — the #119 shape: a session in the root that works another docs root holds nothing here, inside its window too', () => {
  const now = Date.parse('2026-09-26T06:45:00Z');
  const inferred = inferSessionScope({
    root: '/w/hub',
    record: { cwd: '/w/hub', startedAt: '2026-09-26T06:43:49Z' },
    touches: touchesOf([
      toolLine('2026-09-26T06:44:10Z', { name: 'Edit', input: { file_path: '/w/pe-hub/docs/plans/control-tower.md' } }),
      toolLine('2026-09-26T06:44:30Z', {
        name: 'Bash', input: { command: 'DOCS_ROOT=/w/pe-hub bash /w/pe-hub/console/scripts/phase-graph.sh control-tower' },
      }),
    ].join('\n')),
    planScope: () => undefined,
    now,
  });
  assert.deepEqual(inferred.scope, []);
  assert.equal(inferred.basis, 'elsewhere');
  assert.ok(inferred.evidence.some((line) => line.includes('/w/pe-hub')), inferred.evidence.join(' | '));
});

test('SS-1 — what it touched here is what it holds, for a bounded window after its last touch', () => {
  const touches = touchesOf([
    toolLine('2026-09-26T09:00:00Z', { name: 'Edit', input: { file_path: '/w/hub/phased-execution/viewer/server/a.ts' } }),
    toolLine('2026-09-26T09:30:00Z', { name: 'Write', input: { file_path: '/w/hub/README.md' } }),
  ].join('\n'));
  const at = (iso: string) => inferSessionScope({
    root: '/w/hub', record: { cwd: '/w/hub', startedAt: '2026-09-26T08:00:00Z' },
    touches, planScope: () => undefined, isRepository: () => false, now: Date.parse(iso),
  });
  const live = at('2026-09-26T09:35:00Z');
  assert.equal(live.basis, 'touched');
  assert.deepEqual(live.scope, ['phased-execution/viewer', 'hub'], 'the directory it edited in, and the root itself for a top-level file');
  assert.equal(live.leaseUntil, Date.parse('2026-09-26T09:30:00Z') + PEER_CLAIM_WINDOW_MS, 'held until a window after its LAST touch');
  const lapsed = at('2026-09-26T09:41:00Z');
  assert.deepEqual(lapsed.scope, [], 'an idle session stops holding');
});

test('SS-1 — a lock or graph call naming a plan of THIS root holds that phase\'s scope; a plan of another root does not', () => {
  const inferred = inferSessionScope({
    root: '/w/hub',
    record: { cwd: '/w/hub', startedAt: '2026-09-26T08:00:00Z' },
    touches: touchesOf([
      toolLine('2026-09-26T08:01:00Z', { name: 'Bash', input: { command: 'bash scripts/phase-lock.sh alpha conflicts 3' } }),
      toolLine('2026-09-26T08:02:00Z', { name: 'Bash', input: { command: 'bash scripts/phase-graph.sh beta' } }),
    ].join('\n')),
    planScope: (slug, phase) => (slug === 'alpha' ? (phase === 3 ? ['api'] : []) : undefined),
    now: Date.parse('2026-09-26T08:05:00Z'),
  });
  assert.equal(inferred.basis, 'touched');
  assert.deepEqual(inferred.scope, ['api']);
});

test('SS-1 — nothing touched: a bounded unknown lease from the newest start, then nothing — never `all` from the cwd alone', () => {
  const read = (cwd: string, iso: string, isRepository = (dir: string) => dir.endsWith('/api')) => inferSessionScope({
    root: '/w/hub', record: { cwd, startedAt: '2026-09-26T08:00:00Z' },
    touches: null, planScope: () => undefined, isRepository, now: Date.parse(iso),
  });
  assert.equal(UNKNOWN_LEASE_MS, PEER_CLAIM_WINDOW_MS, 'one window: the claim window REG-3 already bounds');
  const early = read('/w/hub', '2026-09-26T08:04:00Z');
  assert.equal(early.basis, 'unknown');
  assert.deepEqual(early.scope, ['all'], 'while it might be about to claim, it could reach anything');
  assert.equal(early.leaseUntil, Date.parse('2026-09-26T08:00:00Z') + UNKNOWN_LEASE_MS);
  assert.deepEqual(read('/w/hub/api/src', '2026-09-26T08:04:00Z').scope, ['api'], 'a cwd in a repository narrows the lease');
  const late = read('/w/hub', '2026-09-26T08:30:00Z');
  assert.equal(late.basis, 'nothing');
  assert.deepEqual(late.scope, [], 'once the lease is spent the cwd is not evidence of anything');
  const declared = inferSessionScope({
    root: '/w/hub', record: { cwd: '/w/hub', scope: 'web', startedAt: '2026-09-26T08:00:00Z' },
    touches: null, now: Date.parse('2026-09-26T08:04:00Z'),
  });
  assert.equal(declared.basis, 'declared');
  assert.deepEqual(declared.scope, ['web']);
});

/* ------------------------------------------------------- SS-1..4, wired */

const PLAN = `---
slug: alpha
created: 2026-09-26
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |
| 2 | two | 1 | — | app | it works |

## Phases

### Phase 1 — one
- **Verification:**
  - \`true\`

### Phase 2 — two
- **Verification:**
  - \`true\`
`;

async function call(
  svc: InstanceType<typeof Service>, method: string, path: string, body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: { host: '127.0.0.1:4123', 'content-type': 'application/json', 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (raw) yield Buffer.from(raw); },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return { status, payload: payload as Record<string, unknown> };
}

test('SS-1..4 — the console reads the transcript: elsewhere holds nothing, a touch holds its scope and says so, a release lets go, the hook is told once', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p82-ss-'));
  const sleepers: ReturnType<typeof spawnProcess>[] = [];
  try {
    const root = join(base, 'hub');
    const other = join(base, 'pe-hub');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'app', 'src'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '-A'], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });

    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
      scriptsDir: SCRIPTS, logFile: null, converge: false, remoteHosts: [], remoteUsers: [],
    } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);
    await svc.bootSettled;

    const now = new Date().toISOString();
    const session = async (id: string, transcriptLines: string[]): Promise<void> => {
      const transcript = join(base, `${id}.jsonl`);
      writeFileSync(transcript, `${transcriptLines.join('\n')}\n`);
      const proc = spawnProcess('sleep', ['120'], { stdio: 'ignore' });
      sleepers.push(proc);
      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: id, event: 'SessionStart', cwd: root, root, pid: proc.pid,
        transcript_path: transcript, user: 'sam', host: 'laptop', source: 'startup', at: now,
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));
    };
    const request = { slug: 'alpha', phase: 2, runId: 'ss-run', scope: ['app'] };
    const sessionHolders = () => svc.scheduler.wouldBlock(request).filter((holder) => holder.kind === 'session');

    // #119: in the root, working another docs root — holds nothing here.
    await session('s-elsewhere', [
      toolLine(now, { name: 'Edit', input: { file_path: join(other, 'docs', 'plans', 'control-tower.md') } }),
    ]);
    assert.deepEqual(sessionHolders(), [], 'a session that works elsewhere blocks nothing in this root');

    // A session that edited this root's `app`: it holds `app`, and says how that was read.
    await session('s-app', [
      toolLine(now, { name: 'Edit', input: { file_path: join(root, 'app', 'src', 'x.ts') } }),
    ]);
    const held = sessionHolders();
    assert.equal(held.length, 1, JSON.stringify(held));
    assert.equal(held[0]!.session, 's-app');
    assert.deepEqual(held[0]!.scope, ['app/src']);
    assert.equal(held[0]!.scopeBasis, 'touched');
    assert.ok(held[0]!.leaseUntil && held[0]!.leaseUntil > Date.now(), 'its hold is bounded');

    // SS-4: the admission queues behind it, and the session's next hook event
    // is answered with one notice — never a second.
    let granted = false;
    const admission = svc.scheduler.admit(request).then((grant) => { granted = true; return grant; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(granted, false, 'queued behind the terminal');
    const stop = () => call(svc, 'POST', '/hooks/session', {
      version: 1, session_id: 's-app', event: 'Stop', cwd: root, root, at: new Date().toISOString(),
    });
    const first = await stop();
    assert.equal(first.status, 200);
    assert.match(String(first.payload.notice ?? ''), /alpha P2/, JSON.stringify(first.payload));
    assert.match(String(first.payload.notice ?? ''), /release/i);
    const second = await stop();
    assert.equal(second.payload.notice, undefined, 'one notice per run, not one per turn');

    // SS-3: the operator releases it — for two hours — and the queue moves.
    const released = await call(svc, 'POST', '/api/sessions/s-app/release', { hours: 2 });
    assert.equal(released.status, 200, JSON.stringify(released.payload));
    assert.deepEqual(sessionHolders(), [], 'a released terminal holds nothing');
    svc.scheduler.poll();
    await Promise.race([admission, new Promise((resolve) => setTimeout(resolve, 3000))]);
    assert.equal(granted, true, 'the queued phase was admitted once the hold was released');
    const unknown = await call(svc, 'POST', '/api/sessions/nope/release', {});
    assert.equal(unknown.status, 404);
    svc.close?.();
  } finally {
    for (const proc of sleepers) proc.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});
