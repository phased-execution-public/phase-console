/**
 * LK — every lock claim on the machine, one read away, with its history (#24).
 *
 * The lock decides whether a phase may board at all, and it was the one object
 * with no view: answering "why is this phase not starting?" took the queue,
 * `phase-lock.sh status` per phase, `cat` of the lock files and `ps`. The rows
 * are built from the lock FILES (`lockView` carries no branch or worktree), a
 * lapse is judged by `lockLapsed` with presence (never the scan-time
 * `expired` bit), and a row says what it is blocking.
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { lockPath } from '../server/store.ts';
import { lockRows, parseLockFilter, type LockRowDeps } from '../server/locks.ts';
import { LOCK_EVENT_KINDS, LOCK_FILTERS, LOCK_HOLDER_KINDS } from '../shared/lock-model.js';

const FLAGS = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: true,
  scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
};

const PLAN = (slug: string): string => [
  '---', `slug: ${slug}`, 'created: 2026-09-21', 'status: active', 'phases: 3', '---', '', `# ${slug}`, '',
  '## Phase graph', '',
  '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
  '|------:|-------|-----------|--------------------|-------|---------------|',
  '| 1 | first | — | — | app | it works |',
  '| 2 | second | — | — | web | it still works |',
  '| 3 | third | — | — | app | it works again |', '',
  '## Phases', '',
  '### Phase 1 — first', '- **Size:** S', '',
  '### Phase 2 — second', '- **Size:** S', '',
  '### Phase 3 — third', '- **Size:** S', '',
].join('\n');

function scratch(...slugs: string[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-lk-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  for (const slug of slugs) writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN(slug), 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A lock exactly as `phase-lock.sh claim` writes one: `key=value`, epoch SECONDS. */
function claim(root: string, slug: string, phase: number, lines: Record<string, string | number>): string {
  const file = lockPath(join(root, 'docs', 'handoffs'), slug, phase);
  mkdirSync(join(root, 'docs', 'handoffs', slug, '.locks'), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const body = { slug, phase, host: 'test', claimed_at: now - 60, lease_until: now + 3600, ...lines };
  writeFileSync(file, `${Object.entries(body).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, 'utf8');
  return file;
}

function service(root: string): Service {
  const svc = new Service(FLAGS as never);
  assert.equal(svc.open(root).ok, true, 'the scratch docs root opens');
  return svc;
}

async function call(svc: unknown, path: string): Promise<{ status: number; body: any }> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, body: null as any };
  const req = {
    method: 'GET',
    headers: { 'x-phase-console': '1' } as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* no body */ },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('LK-1 — GET /api/locks: one row per claim, with the identity the FILE carries', async () => {
  assert.deepEqual([...LOCK_HOLDER_KINDS], ['autopilot', 'person']);
  assert.deepEqual([...LOCK_FILTERS], ['held', 'lapsed', 'scope']);
  const { root, cleanup } = scratch('demo');
  try {
    const now = Math.floor(Date.now() / 1000);
    claim(root, 'demo', 1, {
      owner: 'sam.doe@example.com/opus-p1', scope: 'app', session: 'c399fe08-aaaa-bbbb-cccc-000000000001',
      branch: 'pe/demo', worktree: '/tmp/somewhere/demo',
    });
    claim(root, 'demo', 2, { owner: 'autopilot/abcdef12', scope: 'web', lease_until: now - 120 });
    const svc = service(root);
    const res = await call(svc, '/api/locks');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const rows = res.body.rows as Record<string, any>[];
    assert.equal(rows.length, 2);
    // Worst-first: the lapsed claim still on disk leads.
    assert.deepEqual(rows.map((r) => r.phase), [2, 1]);
    const person = rows.find((r) => r.phase === 1)!;
    assert.equal(person.slug, 'demo');
    assert.equal(person.phaseTitle, 'first');
    assert.equal(person.owner, 'sam.doe@example.com/opus-p1');
    assert.equal(person.host, 'test');
    assert.equal(person.claimedAt, (now - 60) * 1000);
    assert.equal(person.leaseUntil, (now + 3600) * 1000);
    assert.deepEqual(person.scope, ['app']);
    assert.equal(person.session, 'c399fe08-aaaa-bbbb-cccc-000000000001');
    assert.ok(['live', 'ended', 'unknown'].includes(person.presence));
    // Read off the lock file — `lockView` carries neither.
    assert.equal(person.branch, 'pe/demo');
    assert.equal(person.worktree, '/tmp/somewhere/demo');
    assert.equal(person.lapsed, false);
    assert.equal(person.holderKind, 'person');
    assert.deepEqual(person.blocking, []);
    const lane = rows.find((r) => r.phase === 2)!;
    assert.equal(lane.holderKind, 'autopilot');
    assert.equal(lane.runId, 'abcdef12');
    assert.equal(lane.lapsed, true);
  } finally { cleanup(); }
});

/** The pure builder's deps over literal locks. */
function deps(over: Partial<LockRowDeps> = {}): LockRowDeps {
  const nowMs = Date.parse('2026-09-22T12:00:00.000Z');
  return {
    locks: () => [
      { slug: 'demo', phase: 1, owner: 'ops@example.org/p1', host: 'h', claimedAt: nowMs - 60_000,
        leaseUntil: nowMs + 3_600_000, expired: false, scope: ['app'], session: 'sess-1', file: 'x' },
      { slug: 'demo', phase: 3, owner: 'ops@example.org/p3', claimedAt: nowMs - 60_000,
        leaseUntil: nowMs + 3_600_000, expired: false, scope: ['web'], file: 'y' },
    ],
    title: (_slug, phase) => `phase ${phase}`,
    presence: () => 'unknown',
    queue: () => [],
    eta: () => undefined,
    now: () => nowMs,
    ...over,
  };
}

test('LK-2 — a lapse is `lockLapsed` with presence, never the scan-time `expired` bit', () => {
  // An ENDED session lapses its claim before the lease runs out — which the
  // frozen `expired` bit can never say.
  const rows = lockRows(deps({ presence: (lock) => (lock.session === 'sess-1' ? 'ended' : 'unknown') }));
  const one = rows.find((r) => r.phase === 1)!;
  assert.equal(one.presence, 'ended');
  assert.equal(one.lapsed, true);
  assert.equal(rows[0].phase, 1, 'a lapsed claim sorts first');
  // And the source never reads the bit at all.
  const source = readFileSync(new URL('../server/locks.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /\.expired\b/, 'server/locks.ts reads `lock.expired` somewhere');
  assert.match(source, /lockLapsed\(/);
});

test('LK-3 — a row says what it is blocking, and its holder\'s ETA', () => {
  const rows = lockRows(deps({
    queue: () => [{
      id: 'q1', slug: 'other', phase: 4, runId: 'feedbeef', scope: ['app'], since: 0, bypassed: 0, reserving: false,
      waitingOn: [{ kind: 'lock', slug: 'demo', phase: 1, owner: 'ops@example.org/p1', scope: ['app'], overlaps: ['app'] }],
    } as never],
    eta: (slug) => (slug === 'demo' ? { remainingWeight: 3, label: '~2 h' } : undefined),
  }));
  const blocking = rows.find((r) => r.phase === 1)!;
  assert.deepEqual(blocking.blocking, [{ slug: 'other', phase: 4, runId: 'feedbeef' }]);
  assert.deepEqual(blocking.eta, { remainingWeight: 3, label: '~2 h' });
  // Live-and-blocking before live-and-idle.
  assert.deepEqual(rows.map((r) => r.phase), [1, 3]);
  assert.deepEqual(rows.find((r) => r.phase === 3)!.blocking, []);
});

test('LK-4 — the filters: ?held=1, ?lapsed=1, ?scope=<repo>', async () => {
  assert.deepEqual(parseLockFilter(new URLSearchParams('held=1&scope=app')), { held: true, scope: 'app' });
  assert.deepEqual(parseLockFilter(new URLSearchParams('')), {});
  const { root, cleanup } = scratch('demo');
  try {
    const now = Math.floor(Date.now() / 1000);
    claim(root, 'demo', 1, { owner: 'a@example.org/p1', scope: 'app' });
    claim(root, 'demo', 2, { owner: 'b@example.org/p2', scope: 'web', lease_until: now - 10 });
    claim(root, 'demo', 3, { owner: 'c@example.org/p3' }); // no scope: unknown, collides with everything
    const svc = service(root);
    const phases = async (query: string): Promise<number[]> =>
      ((await call(svc, `/api/locks${query}`)).body.rows as { phase: number }[]).map((r) => r.phase).sort();
    assert.deepEqual(await phases(''), [1, 2, 3]);
    assert.deepEqual(await phases('?held=1'), [1, 3]);
    assert.deepEqual(await phases('?lapsed=1'), [2]);
    // "Who has app?" — the app claim, and the unscoped one, which claims everything.
    assert.deepEqual(await phases('?scope=app'), [1, 3]);
    assert.deepEqual(await phases('?scope=web&held=1'), [3]);
  } finally { cleanup(); }
});


