/**
 * A terminal's hold rests only on what it touched UNDER the console's root
 * (control-tower phase 108, #180).
 *
 * Measured on hub 4123 on 2026-10-01 at 08:58Z: the watchdog's own terminal
 * held an all-scoped phase with `scope: [hub, docs/plans, aws]`, `scopeBasis:
 * touched` and a lease to 09:00:20Z. Its evidence listed writes to
 * `~/.claude/projects/-…-hub/memory/` — outside the root — beside `changed .`
 * (a `git -C <root> …`) and an edit under `docs/plans` from an hour earlier.
 * The watchdog saves memory as it works, so the hold never lapsed.
 *
 *  - HE-1 the #180 shape holds nothing: an hour-old edit is not revived by a
 *    root-level git verb, and a memory write renews nothing;
 *  - HE-2 a bare `changed .` claims nothing — a git verb at a repository UNDER
 *    the root still holds that repository;
 *  - HE-3 the evidence names only what the hold rests on: paths under the
 *    root, newest first, with when — never `~/.claude/**`, never another tree;
 *  - HE-4 a Claude config home (`~/.claude`, `~/.claude-*`, the session's own
 *    config dir) is neither the tree nor somewhere else: a memory write is not
 *    evidence of working elsewhere, while an edit in another repository still is;
 *  - HE-5 wired: the scheduler sees the same.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { PEER_CLAIM_WINDOW_MS } = await import('../server/sessions/registry.ts');
const { inferSessionScope, touchesOf } = await import('../server/sessions/scope-inference.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const HOME = '/home/u';
const MEMORY = `${HOME}/.claude/projects/-w-hub/memory`;

const toolLine = (at: string, ...uses: { name: string; input: Record<string, unknown> }[]): string =>
  JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { role: 'assistant', content: uses.map((use, i) => ({ type: 'tool_use', id: `t${i}`, ...use })) },
  });
const edit = (at: string, file_path: string) => toolLine(at, { name: 'Edit', input: { file_path } });
const write = (at: string, file_path: string) => toolLine(at, { name: 'Write', input: { file_path, content: '…' } });
const bash = (at: string, command: string) => toolLine(at, { name: 'Bash', input: { command } });

function read(lines: string[], opts: { now: string; startedAt?: string; configDir?: string }) {
  return inferSessionScope({
    root: '/w/hub',
    record: {
      cwd: '/w/hub', startedAt: opts.startedAt ?? '2026-10-01T07:00:00Z',
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    },
    touches: touchesOf(lines.join('\n')),
    planScope: () => undefined,
    isRepository: (dir) => dir.endsWith('/api'),
    home: HOME,
    now: Date.parse(opts.now),
  });
}

/* ------------------------------------------------------------------ HE-1 */

test('HE-1 — the #180 shape holds nothing: an hour-old edit is not revived by a root git verb, and memory writes renew nothing', () => {
  const inferred = read([
    edit('2026-10-01T07:58:00Z', '/w/hub/docs/plans/ai-builder-v6.md'),
    edit('2026-10-01T07:59:00Z', '/w/hub/aws/main.tf'),
    write('2026-10-01T08:50:00Z', `${MEMORY}/feedback_watchdog.md`),
    bash('2026-10-01T08:50:20Z', 'git -C /w/hub commit -qm "watchdog notes"'),
    edit('2026-10-01T08:55:00Z', `${MEMORY}/MEMORY.md`),
  ], { now: '2026-10-01T08:58:00Z' });
  assert.deepEqual(inferred.scope, [], `the watchdog held: ${JSON.stringify(inferred)}`);
  assert.equal(inferred.basis, 'nothing', 'its last touch of the tree was an hour ago');
  assert.equal(inferred.leaseUntil, undefined);
});

/* ------------------------------------------------------------------ HE-2 */

test('HE-2 — a bare `changed .` claims nothing; a git verb in a repository under the root still holds that repository', () => {
  const pulled = read([bash('2026-10-01T08:57:00Z', 'git -C /w/hub pull --ff-only')], { now: '2026-10-01T08:58:00Z' });
  assert.deepEqual(pulled.scope, [], 'a git verb at the root says nothing about WHICH paths it touched');
  assert.notEqual(pulled.basis, 'touched');

  // Inside its unknown lease the cwd still answers — never the root token from the git verb.
  const fresh = read([bash('2026-10-01T08:57:00Z', 'git -C /w/hub stash list')], { now: '2026-10-01T08:58:00Z', startedAt: '2026-10-01T08:55:00Z' });
  assert.equal(fresh.basis, 'unknown');
  assert.deepEqual(fresh.scope, ['all']);

  const committed = read([bash('2026-10-01T08:57:00Z', 'git -C /w/hub/api commit -qm wip')], { now: '2026-10-01T08:58:00Z' });
  assert.equal(committed.basis, 'touched');
  assert.deepEqual(committed.scope, ['api'], 'a repository under the root is a real place');
});

/* ------------------------------------------------------------------ HE-3 */

test('HE-3 — the evidence names only paths under the root, newest first, with when', () => {
  const inferred = read([
    edit('2026-10-01T08:40:00Z', '/w/hub/app/src/a.ts'),
    write('2026-10-01T08:45:00Z', `${MEMORY}/project_x.md`),
    edit('2026-10-01T08:46:00Z', '/w/other/lib/x.ts'),
    edit('2026-10-01T08:47:00Z', '/w/hub/app/src/b.ts'),
    bash('2026-10-01T08:48:00Z', 'git -C /w/hub commit -qm wip'),
  ], { now: '2026-10-01T08:50:00Z' });
  assert.equal(inferred.basis, 'touched');
  assert.deepEqual(inferred.scope, ['app/src']);
  assert.equal(inferred.leaseUntil, Date.parse('2026-10-01T08:47:00Z') + PEER_CLAIM_WINDOW_MS,
    'held a window after its last touch OF THE TREE — the memory write, the other tree and the root git verb renew nothing');
  assert.match(inferred.evidence[0] ?? '', /app\/src\/b\.ts.*08:47/, inferred.evidence.join(' | '));
  assert.match(inferred.evidence[1] ?? '', /app\/src\/a\.ts.*08:40/, inferred.evidence.join(' | '));
  for (const line of inferred.evidence) {
    assert.doesNotMatch(line, /\.claude|\/w\/other|changed \./, `evidence the hold does not rest on: ${line}`);
  }
});

/* ------------------------------------------------------------------ HE-4 */

test('HE-4 — a Claude config home is neither the tree nor elsewhere; another repository is still elsewhere', () => {
  // Fresh in the root, writing memory: still a session that may be about to
  // claim — the unknown lease stands, it is not "working elsewhere".
  const memoryOnly = read([
    write('2026-10-01T08:56:00Z', `${MEMORY}/feedback.md`),
    write('2026-10-01T08:56:10Z', `${HOME}/.claude-a/projects/-w-hub/memory/x.md`),
    write('2026-10-01T08:56:20Z', '/s/accounts/work/config/projects/-w-hub/memory/y.md'),
  ], { now: '2026-10-01T08:58:00Z', startedAt: '2026-10-01T08:55:00Z', configDir: '/s/accounts/work/config' });
  assert.equal(memoryOnly.basis, 'unknown', `a memory write is not evidence of another tree: ${JSON.stringify(memoryOnly)}`);
  assert.equal(memoryOnly.leaseUntil, Date.parse('2026-10-01T08:55:00Z') + PEER_CLAIM_WINDOW_MS, 'the lease runs from its START, never from a memory write');
  const lapsed = read([write('2026-10-01T09:20:00Z', `${MEMORY}/feedback.md`)], { now: '2026-10-01T09:21:00Z', startedAt: '2026-10-01T08:55:00Z' });
  assert.equal(lapsed.basis, 'nothing', 'and writing memory never re-opens it');

  // The #119 rule stands: every touch in ANOTHER repository holds nothing here.
  const elsewhere = read([edit('2026-10-01T08:56:00Z', '/w/pe-hub/docs/plans/control-tower.md')],
    { now: '2026-10-01T08:58:00Z', startedAt: '2026-10-01T08:55:00Z' });
  assert.equal(elsewhere.basis, 'elsewhere');
  assert.ok(elsewhere.evidence.some((line) => line.includes('/w/pe-hub')), 'and says where it works instead');
});

/* ------------------------------------------------------------------ HE-5 */

async function call(svc: InstanceType<typeof Service>, method: string, path: string, body?: unknown): Promise<number> {
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end() {}, on() { return this; }, writableEnded: false, destroyed: false,
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
  return status;
}

test('HE-5 — wired: the watchdog shape holds no all-scoped phase, and a real hold names only its own edits', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p108-he-'));
  const sleepers: ReturnType<typeof spawnProcess>[] = [];
  try {
    const root = join(base, 'hub');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), [
      '---', 'slug: alpha', 'created: 2026-10-04', 'status: active', 'phases: 1', '---', '', '# alpha', '', '## Phase graph', '',
      '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
      '|------:|-------|-----------|--------------------|-------|---------------|',
      '| 1 | one | — | — | all | it works |', '', '## Phases', '', '### Phase 1 — one', '- **Verification:**', '  - `true`', '',
    ].join('\n'));
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

    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const memory = join(homedir(), '.claude', 'projects', '-w-hub', 'memory');
    const session = async (id: string, lines: string[]): Promise<void> => {
      const transcript = join(base, `${id}.jsonl`);
      writeFileSync(transcript, `${lines.join('\n')}\n`);
      const proc = spawnProcess('sleep', ['120'], { stdio: 'ignore' });
      sleepers.push(proc);
      assert.equal(await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: id, event: 'SessionStart', cwd: root, root, pid: proc.pid,
        transcript_path: transcript, user: 'sam', host: 'laptop', source: 'startup', at: ago(3 * 3_600_000),
      }), 200);
    };
    const request = { slug: 'alpha', phase: 1, runId: 'he-run', scope: ['all'] };
    const sessionHolders = () => svc.scheduler.wouldBlock(request).filter((holder) => holder.kind === 'session');

    await session('watchdog', [
      edit(ago(60 * 60_000), join(root, 'docs', 'plans', 'alpha.md')),
      write(ago(8 * 60_000), join(memory, 'feedback_watchdog.md')),
      bash(ago(7 * 60_000 + 40_000), `git -C ${root} commit -qm "watchdog notes"`),
      write(ago(30_000), join(memory, 'MEMORY.md')),
    ]);
    assert.deepEqual(sessionHolders(), [], 'the watchdog no longer holds the phase it is trying to keep moving');

    await session('editor', [
      write(ago(2 * 60_000), join(memory, 'notes.md')),
      edit(ago(60_000), join(root, 'docs', 'plans', 'alpha.md')),
    ]);
    const held = sessionHolders();
    assert.equal(held.length, 1, JSON.stringify(held));
    assert.equal(held[0]!.session, 'editor');
    assert.deepEqual(held[0]!.scope, ['docs/plans']);
    assert.ok((held[0]!.evidence ?? []).length >= 1, 'the queue names what the hold rests on');
    for (const line of held[0]!.evidence ?? []) assert.doesNotMatch(line, /\.claude/, `evidence outside the root: ${line}`);
    svc.close?.();
  } finally {
    for (const proc of sleepers) proc.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});
