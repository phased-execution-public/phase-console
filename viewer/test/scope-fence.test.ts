/**
 * The scope fence, the fold, the watch sentences and the live lane
 * (control-tower phase 6, #19 and #15) — criteria SF-1 … SF-9.
 *
 * The measured shape these pin: a session declared `needs-human --needs
 * external` (every check on a repository refused), and within the hour the
 * console boarded three more sessions into the same repository — each paying
 * to rediscover the wall and file another copy of one errand — while the
 * sentences around the park said the console was "watching its refs" with
 * none of them live, and a landing on a live run was charged as a rejection.
 *
 * Service tests follow `auto-recovery.test.ts`: a real `Service` over a real
 * plan and the real engine, with only the drives (`retryPhase`,
 * `recoverPhase`, `startRun`) and the announcement door stubbed. Runner tests
 * either run a real `Runner` on a stub repository, or call one of its
 * methods on an instance whose journal and saves are captured.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { journalFile, loadRun, newRun, phaseRecord, resetForRetry, saveRun } = await import('../server/runner/state.ts');
const { Runner } = await import('../server/runner/runner.ts');
const {
  Scheduler, applyScopeFence, errandFoldTarget, fenceFor, fenceHolderOf, fenceHolders, foldStands, isExternalWall,
  wallFingerprint,
} = await import('../server/runner/scheduler.ts');
const { RunBusyError } = await import('../server/service-core.ts');
const { consoleLockRef } = await import('../server/service-recovery.ts');
const { evidenceFingerprint } = await import('../server/converge.ts');
const { DEFAULT_WAIT_BUDGET_MS } = await import('../server/runner/wait-budget.ts');
const { FENCE_LIFT_REASONS } = await import('../shared/run-lifecycle.js');
const { recent: recentLog } = await import('../server/log.ts');
type RunState = import('../server/runner/state.ts').RunState;
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const HOUR = 60 * 60_000;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Two phases on one repository and a third on another — three roots. */
const PLAN = `---
slug: alpha
created: 2026-09-22
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | wall | — | 2, 3 | app | it works |
| 2 | sibling | — | 1, 3 | app | it works |
| 3 | elsewhere | — | 1, 2 | docs | it works |

## Phases

### Phase 1 — wall
- **Size:** S

### Phase 2 — sibling
- **Size:** S

### Phase 3 — elsewhere
- **Size:** S
`;

const SCOPES: Record<number, string[]> = { 1: ['app'], 2: ['app'], 3: ['docs'], 4: ['app'] };
const scopeOf = (phase: number): string[] => SCOPES[phase] ?? ['all'];

const REF = 'gh:acme/app#run/4101';
const REF2 = 'gh:acme/app#pr/77';
const CMD = 'cmd:"test -f /tmp/acme-ci-restored"';
// A wall the SESSION declared. Its words are chosen to be nothing the runner's
// own credential, limit or outage classifier (`runner/errors.ts`) knows.
const WALL = 'The hosted CI for acme/app refuses every check until its plan is renewed; a person must renew it.';

type Declared = NonNullable<PhaseRecord['declared']>;

/** Park a record on a declared EXTERNAL wall, the way the runner's needs-human arm writes it. */
function declareWall(record: PhaseRecord, at: string, over: Partial<Declared> = {}): PhaseRecord {
  const declared: Declared = {
    status: 'needs-human', reason: WALL, watch: [REF], needs: 'external', at,
    budget: { ms: DEFAULT_WAIT_BUDGET_MS, source: 'default' }, ...over,
  };
  record.status = 'parked';
  record.note = declared.reason;
  record.sessionId = `sess-wall-${record.phase}`;
  record.endedAt = at;
  record.watch = [...(declared.watch ?? [])];
  record.declared = declared;
  return record;
}

/** The errand the runner writes for such a wall. */
function wallErrand(phase: number, at: string, need = WALL) {
  return {
    phase, situation: 'blocked-declared:external', at, tried: [], need,
    how: 'Settle the external blocker it names, then Retry.',
  };
}

/** A plain run of `alpha` in memory — for the helpers, which never touch disk. */
function fenceState(now: number, at = new Date(now - 60_000).toISOString()): RunState {
  const state = newRun({ slug: 'alpha', root: join(tmpdir(), 'scope-fence-pure') });
  declareWall(phaseRecord(state, 1), at);
  phaseRecord(state, 2);
  phaseRecord(state, 3);
  return state;
}

type Line = { event: string; data: Record<string, unknown>; phase?: number };

function fenceSink() {
  const lines: Line[] = [];
  const changed: number[] = [];
  return {
    lines, changed,
    sink: {
      journal: (event: string, data: Record<string, unknown>, phase: number) => { lines.push({ event, data, phase }); },
      changed: (phase: number) => { changed.push(phase); },
    },
  };
}

const OPEN = new Map<string, Array<{ close: () => void }>>();

/** A project root holding the plan — written BEFORE a console opens it, since the store reads once. */
function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-scope-fence-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}
type Svc = ReturnType<typeof service>;
type Loose = Record<string, unknown>;

/**
 * Every announcement the console makes goes through `announce` — record them.
 * Except the docs watcher's "Plans changed", which fires on its own debounce
 * after the root opens and says nothing about any phase, and the meters'
 * `usage-climbing`: a real Service polls the machine login's own usage, so a
 * meter past its threshold announces whenever a poll lands inside a test
 * (control-tower phase 123 — SF-5 met the operator's weekly meter at 100 %).
 */
function announcements(svc: Svc): Array<{ category: string; title: string; phase: number | null }> {
  const out: Array<{ category: string; title: string; phase: number | null }> = [];
  (svc as never as Loose).announce = (category: string, message: { title: string }, context: { phase?: number | null } = {}) => {
    if (category === 'changed' || category === 'usage-climbing') return;
    out.push({ category, title: message.title, phase: context.phase ?? null });
  };
  return out;
}

/** The three ways the healer boards a phase, recorded instead of driven. */
function stubDrives(svc: Svc): Array<{ via: string; phase?: number }> {
  const drives: Array<{ via: string; phase?: number }> = [];
  const s = svc as never as Loose;
  s.retryPhase = async (_slug: string, phase: number) => { drives.push({ via: 'retry', phase }); return null; };
  s.recoverPhase = async (_slug: string, phase: number) => { drives.push({ via: 'recover', phase }); return null; };
  s.startRun = async () => { drives.push({ via: 'start' }); return null; };
  return drives;
}

/**
 * A stored run of `alpha` parked on phase 1's declared external wall — one
 * live `gh:` ref, inside its wait budget. `others` get a pending record each:
 * the siblings a heal pass could board.
 */
function wallRun(root: string, opts: { others?: number[]; refs?: string[]; at?: string } = {}): RunState {
  const at = opts.at ?? new Date().toISOString();
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'parked';
  state.halt = { at, reason: `phase 1 needs a person: ${WALL}`, phase: 1, kind: 'needs-human' };
  state.finishedReason = state.halt.reason;
  declareWall(phaseRecord(state, 1), at, opts.refs ? { watch: [...opts.refs] } : {});
  for (const phase of opts.others ?? [2, 3]) phaseRecord(state, phase);
  saveRun(state);
  return state;
}

function journalOf(root: string, slug: string, runId: string): Line[] {
  let text = '';
  try { text = readFileSync(journalFile(root, slug, runId), 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
}

type Landed = { ref: string; state: 'landed'; detail?: string };

/** The watch scheduler's one call into the healer (`onLanded` → `onWatchLanded`). */
function land(svc: Svc, state: RunState, phase: number, ref: string): Promise<string> {
  return (svc as never as {
    onWatchLanded: (slug: string, st: RunState, ph: number, landed: Landed) => Promise<string>;
  }).onWatchLanded('alpha', state, phase, { ref, state: 'landed', detail: 'completed: success' });
}

/** The healer's drive settles asynchronously — let it. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const runnersOf = (svc: Svc) => (svc as never as { runners: Map<string, unknown> }).runners;

/**
 * A live runner as the service sees one — `busy`, its own state object, and
 * the two landing doors recorded. Everything the service's other readers or
 * the usage poller may ask of a runner answers harmlessly.
 */
function fakeLiveRunner(state: RunState) {
  const landed: Array<{ phase: number; ref: string; count: number; sessionId: string | null | undefined }> = [];
  const pending = new Set<number>();
  let docsChanged = 0;
  const runner = {
    busy: () => true,
    current: () => state,
    isSpending: () => false,
    landingPending: (phase: number) => pending.has(phase),
    landWatch: (phase: number, l: { ref: string }, opts: { count: number; sessionId?: string | null }) => {
      landed.push({ phase, ref: l.ref, count: opts.count, sessionId: opts.sessionId });
      pending.add(phase);
      return true;
    },
    noteDocsChanged: () => { docsChanged += 1; },
    note: () => {},
    close: () => {},
    thaw: () => {},
    gitSnapshot: () => null,
    holdsIsolatedCheckout: () => false,
  };
  return { runner, landed, docsChanged: () => docsChanged };
}

/**
 * A `Runner` whose journal, saves and parks are captured — the seam for the
 * outcome router (`routeOutcome`, the needs-human arm). `onEvent` is the
 * runner's real channel to the service.
 */
function runnerHandle(state: RunState, onEvent?: (event: string, data: Record<string, unknown>) => void) {
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  const instance = new Runner({
    scriptsDir: SCRIPTS,
    spawn: async () => { throw new Error('no session is spawned in this test'); },
    phaseScope: (_slug: string, phase: number) => scopeOf(phase),
    onEvent: (event: string, data: Record<string, unknown>) => { emitted.push({ event, data }); onEvent?.(event, data); },
  } as never);
  const events: Line[] = [];
  const parks: Array<{ reason: string; phase?: number; kind?: string }> = [];
  const handle = instance as never as Loose;
  handle.state = state;
  handle.record = (event: string, data: Record<string, unknown> = {}, phase?: number) => { events.push({ event, data, phase }); };
  handle.persist = () => {};
  handle.persistNow = () => {};
  handle.park = (reason: string, phase?: number, kind?: string) => { parks.push({ reason, phase, kind }); };
  handle.waitBudgetOf = async () => ({ budgetMs: DEFAULT_WAIT_BUDGET_MS, source: 'default', countersignedUntil: null, refs: [] });
  const board = { phased: true, states: { 1: 'ready', 2: 'in-progress', 3: 'in-progress' }, done: [], inProgress: [2, 3], stuck: [], ready: [1], waiting: [], blockedBy: {} };
  const route = (phase: number, outcome: Record<string, unknown>) =>
    (handle.routeOutcome as (p: number, d: unknown, b: unknown) => Promise<string | null>).call(instance, phase, outcome, board);
  return { instance, events, emitted, parks, route };
}

/* ------------------------------------------------------------------ *
 * SF-1..3 — the fence: who holds one, who it holds, and both boarders
 * ------------------------------------------------------------------ */

test('SF-1..3 — a phase parked on a declared external wall with a live ref holds a fence; nothing else does', () => {
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  const wall = () => declareWall({ phase: 1, status: 'pending', attempts: 0, costUsd: 0 } as PhaseRecord, at);

  assert.equal(isExternalWall(wall()), true, '`--needs external` is the wall');
  assert.equal(isExternalWall(declareWall(wall(), at, { needs: 'credential' })), false, 'a credential is not an external wall');
  assert.equal(isExternalWall(declareWall(wall(), at, { needs: undefined }), { situation: 'blocked-declared:external' }), true,
    'no `--needs`, but the classifier or its errand filed it external');
  assert.equal(isExternalWall(declareWall(wall(), at, { status: 'waiting-external' })), false, 'a wait is not a wall');

  const until = Date.parse(at) + DEFAULT_WAIT_BUDGET_MS;
  assert.deepEqual(fenceHolderOf(wall(), null, now), { phase: 1, refs: [REF], until, wall: at });

  const waiting = wall(); waiting.status = 'waiting';
  assert.equal(fenceHolderOf(waiting, null, now), null, 'only a PARKED wall fences');
  const landed = wall(); landed.declared!.landed = { ref: REF, at: new Date(now).toISOString(), resumes: 1 };
  assert.equal(fenceHolderOf(landed, null, now), null, 'a landed wall is down');
  const lifted = wall(); lifted.fenceLifted = { why: 'retry', at: new Date(now).toISOString() };
  assert.equal(fenceHolderOf(lifted, null, now), null, 'an operator lifted it after it was declared');
  const older = wall(); older.fenceLifted = { why: 'release', at: new Date(now - HOUR).toISOString() };
  assert.equal(fenceHolderOf(older, null, now)?.phase, 1, 'a lift of an EARLIER wall does not lift this one');
  assert.equal(fenceHolderOf(wall(), null, until), null, 'the wait budget has ended');

  const refused = wall();
  refused.watchState = { at, refs: [{ ref: REF, scheme: 'gh-run', state: 'refused', detail: 'refused', checkedAt: at }] };
  assert.equal(fenceHolderOf(refused, null, now), null, 'no live ref and no errand: nothing can bring it down by itself');
  assert.deepEqual(fenceHolderOf(refused, wallErrand(1, at), now), { phase: 1, refs: [], until, wall: at },
    'its standing errand keeps the fence up');

  const holders = [{ ...fenceHolderOf(wall(), null, now)!, scope: ['app'] }];
  assert.equal(fenceFor(2, ['app'], holders)?.phase, 1, 'an intersecting scope is fenced');
  assert.equal(fenceFor(3, ['docs'], holders), null, 'a disjoint scope is not');
  assert.equal(fenceFor(1, ['app'], holders), null, 'and a wall never fences itself');
});

test('SF-1..3 — applyScopeFence: a pending sibling reads queued behind the wall with ONE phase.fenced; a disjoint one is untouched; a failed one keeps its word', () => {
  const now = Date.now();
  const state = fenceState(now);
  const at = state.phases['1'].declared!.at;
  const failed = phaseRecord(state, 4); failed.status = 'failed';
  const { lines, changed, sink } = fenceSink();

  const fenced = applyScopeFence(state, [1, 2, 3, 4], scopeOf, now, sink);
  assert.deepEqual([...fenced].sort(), [2, 4]);
  const until = Date.parse(at) + DEFAULT_WAIT_BUDGET_MS;
  const b = state.phases['2'];
  assert.equal(b.status, 'queued');
  assert.deepEqual(b.waitingOn, [{ kind: 'fence', slug: 'alpha', phase: 1, owner: 'phase 1', refs: [REF], until, wall: at }]);
  assert.match(b.note ?? '', /^fenced behind phase 1's declared external wall in the same scope \(watching gh:acme\/app#run\/4101\)/);
  assert.equal(state.phases['3'].status, 'pending', 'the disjoint phase boards — keep-going, unchanged');
  assert.equal(state.phases['3'].waitingOn, undefined);
  assert.equal(state.phases['4'].status, 'failed', 'a non-pending status keeps its word…');
  assert.equal(state.phases['4'].waitingOn?.[0]?.kind, 'fence', '…and gains only the holder');
  assert.equal(state.phases['1'].status, 'parked', 'the wall is never its own candidate');
  assert.deepEqual(lines.map((l) => [l.event, l.phase]), [['phase.fenced', 2], ['phase.fenced', 4]]);
  assert.deepEqual(lines[0].data, {
    fence: 1, refs: [REF], overlaps: ['app'], until: new Date(until).toISOString(), wall: at,
  });
  assert.deepEqual(changed.sort(), [2, 4]);

  // Once per wall: the next pass refreshes the entry and says nothing.
  const again = applyScopeFence(state, [2, 3, 4], scopeOf, now + 60_000, sink);
  assert.deepEqual([...again].sort(), [2, 4]);
  assert.equal(lines.length, 2, 'a second pass writes no second phase.fenced');
  assert.equal(state.phases['2'].status, 'queued');

  // A NEW wall is news again: the old fence comes down first, then the new one goes up.
  const later = new Date(now + 120_000).toISOString();
  declareWall(state.phases['1'], later);
  applyScopeFence(state, [2], scopeOf, now + 180_000, sink);
  assert.deepEqual(lines.slice(2).filter((l) => l.phase === 2).map((l) => [l.event, l.data.wall, l.data.why]), [
    ['phase.fence-lifted', at, 'cleared'], ['phase.fenced', later, undefined],
  ]);
  assert.equal(state.phases['2'].status, 'queued');
  assert.equal(state.phases['2'].waitingOn?.[0]?.wall, later);
});

test('SF-1..3 — the heal refuses the fenced sibling and drives the disjoint one', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    announcements(svc);
    const stored = wallRun(s.root);
    const at = stored.phases['1'].declared!.at;

    const out = await svc.maybeAutoRecover('alpha', { trigger: 'timer' });
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 3, 'the one drivable candidate is the disjoint phase');
    assert.deepEqual(drives, [{ via: 'retry', phase: 3 }]);

    const disk = loadRun(s.root, 'alpha', stored.id)!;
    assert.equal(disk.phases['2'].status, 'queued');
    assert.deepEqual(disk.phases['2'].waitingOn, [{
      kind: 'fence', slug: 'alpha', phase: 1, owner: 'phase 1', refs: [REF],
      until: Date.parse(at) + DEFAULT_WAIT_BUDGET_MS, wall: at,
    }]);
    assert.equal(disk.phases['3'].waitingOn, undefined);
    const fencedLines = () => journalOf(s.root, 'alpha', stored.id).filter((l) => l.event === 'phase.fenced');
    assert.equal(fencedLines().length, 1);
    assert.equal(fencedLines()[0].phase, 2);
    assert.equal(fencedLines()[0].data.fence, 1);
    assert.equal(fencedLines()[0].data.by, 'heal', 'signed by the healer');

    // A second pass over the same wall: still refused, still one line.
    await svc.maybeAutoRecover('alpha', { trigger: 'timer' });
    assert.equal(fencedLines().length, 1, 'once per wall per phase');
    assert.ok(!drives.some((d) => d.phase === 2), `phase 2 was never driven (${JSON.stringify(drives)})`);
    assert.equal(loadRun(s.root, 'alpha', stored.id)!.phases['2'].status, 'queued');
  } finally { s.cleanup(); }
});

/* ---- the live loop: a real Runner resuming a run parked on the wall ---- */

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A stub repository whose board reads every unfinished phase of 1–3 ready. */
function stubRepo(): { root: string; scripts: string; stub: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-scope-fence-lanes-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${stub}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, stub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A real `Runner` resuming a stored run of the stub plan whose phase 1 is
 * parked on the wall (scope `app`); phase 2 shares the scope, phase 3 is on
 * `docs`. A spawned session finishes its phase at once.
 */
async function resumeOnWall(onlyPhases?: number[]): Promise<{ spawned: number[]; state: RunState; lines: Line[] }> {
  const r = stubRepo();
  const scheduler = new Scheduler({ max: 3, locks: () => [] });
  const spawned: number[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    spawned.push(phase);
    appendFileSync(join(r.stub, 'done'), `${phase}\n`);
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: `sess-${phase}`, costUsd: 0, turns: 1,
      resultText: 'done', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, scheduler, maxParallel: 3,
    verificationText: () => '`true`',
    phaseScope: (_slug: string, phase: number) => (phase === 3 ? ['docs'] : ['app']),
  } as never);
  try {
    const at = new Date().toISOString();
    const stored = newRun({ slug: 'demo', root: r.root });
    stored.status = 'parked';
    stored.halt = { at, reason: `phase 1 needs a person: ${WALL}`, phase: 1, kind: 'needs-human' };
    declareWall(phaseRecord(stored, 1), at);
    saveRun(stored);

    await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stored.id, autonomy: 'keep-going', ...(onlyPhases ? { onlyPhases } : {}),
    } as never);
    await instance.wait();
    return { spawned, state: instance.current()!, lines: journalOf(r.root, 'demo', stored.id) };
  } finally {
    scheduler.close();
    instance.close();
    r.cleanup();
  }
}

test('SF-1..3 — the live loop: a Runner resuming a run parked on the wall never spawns the fenced sibling, and boards the disjoint phase under keep-going', async () => {
  const { spawned, state, lines } = await resumeOnWall();
  assert.deepEqual(spawned, [3], 'phase 3 boarded; phase 2 never spawned while phase 1 fences its scope');
  assert.equal(state.phases['2'].status, 'queued');
  assert.equal(state.phases['2'].waitingOn?.[0]?.kind, 'fence');
  assert.equal(state.phases['2'].waitingOn?.[0]?.phase, 1);
  assert.equal(state.phases['1'].status, 'parked', 'the wall itself is left standing');
  assert.notEqual(state.status, 'finished', 'a fenced phase is outstanding work, never "finished"');
  const fenced = lines.filter((l) => l.event === 'phase.fenced');
  assert.deepEqual(fenced.map((l) => l.phase), [2], 'one phase.fenced, however many ticks the loop took');
});

test('SF-1..3 — the live loop: a run scoped to the fenced phase is never "finished" — it parks with the phase outstanding', async () => {
  const { spawned, state, lines } = await resumeOnWall([2]);
  assert.deepEqual(spawned, [], 'the one asked phase is fenced, so nothing boards');
  assert.equal(state.phases['2'].status, 'queued');
  assert.equal(state.status, 'parked', `not "scoped to phase 2, and it is settled" (${state.finishedReason ?? ''})`);
  assert.equal(lines.filter((l) => l.event === 'run.finished').length, 0);
  assert.equal(lines.filter((l) => l.event === 'phase.fenced').length, 1);
});

/* ------------------------------------------------------------------ *
 * SF-4 — the lift, one door per `why`
 * ------------------------------------------------------------------ */

test('SF-4 — every lift reason used here is the shared vocabulary\'s', () => {
  for (const why of ['landed', 'retry', 'release', 'budget']) {
    assert.ok((FENCE_LIFT_REASONS as readonly string[]).includes(why), why);
  }
});

test('SF-4 — a landing lifts the fence (why: landed): the sibling goes back to pending and the heal boards it', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    announcements(svc);
    const stored = wallRun(s.root, { others: [2] });

    const first = await svc.maybeAutoRecover('alpha');
    assert.equal(first.launched, false, 'the only sibling is fenced');
    assert.equal(loadRun(s.root, 'alpha', stored.id)!.phases['2'].status, 'queued');

    // The watch clock's door: the ref lands, the declaration carries it.
    await land(svc, loadRun(s.root, 'alpha', stored.id)!, 1, REF);
    await settled();
    const walled = loadRun(s.root, 'alpha', stored.id)!.phases['1'];
    assert.equal(walled.declared?.landed?.ref, REF);
    assert.equal(walled.fenceLifted?.why, 'landed');

    await svc.maybeAutoRecover('alpha');
    const lifted = journalOf(s.root, 'alpha', stored.id).filter((l) => l.event === 'phase.fence-lifted');
    assert.equal(lifted.length, 1);
    assert.equal(lifted[0].phase, 2);
    assert.equal(lifted[0].data.fence, 1);
    assert.equal(lifted[0].data.why, 'landed');
    const b = loadRun(s.root, 'alpha', stored.id)!.phases['2'];
    assert.equal(b.status, 'pending');
    assert.equal(b.waitingOn, undefined);
    assert.ok(!String(b.note ?? '').startsWith('fenced behind'), 'the fence note goes with the fence');
    assert.ok(drives.some((d) => d.via === 'retry' && d.phase === 2), `phase 2 boards (${JSON.stringify(drives)})`);
  } finally { s.cleanup(); }
});

test('SF-4 — an operator\'s Retry of the wall lifts it (why: retry)', () => {
  const now = Date.now();
  const state = fenceState(now);
  const { lines, sink } = fenceSink();
  applyScopeFence(state, [2], scopeOf, now, sink);
  assert.equal(state.phases['2'].status, 'queued');

  const spent: Line[] = [];
  resetForRetry(state.phases['1'], { by: 'operator', journal: (event, data, phase) => { spent.push({ event, data, phase }); } });
  assert.equal(state.phases['1'].fenceLifted?.why, 'retry');

  const fenced = applyScopeFence(state, [1, 2], scopeOf, now + 1_000, sink);
  assert.equal(fenced.size, 0);
  const lift = lines.filter((l) => l.event === 'phase.fence-lifted');
  assert.deepEqual(lift.map((l) => [l.phase, l.data.fence, l.data.why]), [[2, 1, 'retry']]);
  assert.equal(state.phases['2'].status, 'pending');
  assert.equal(state.phases['2'].waitingOn, undefined);
});

test('SF-4 — a Release of the wall\'s lock lifts it (why: release) — on a stored run through the heal, on a live one through its own loop', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    announcements(svc);
    const stored = wallRun(s.root, { others: [2] });
    await svc.maybeAutoRecover('alpha');
    assert.equal(loadRun(s.root, 'alpha', stored.id)!.phases['2'].status, 'queued');

    const release = (svc as never as { noteFenceReleased: (slug: string, phase: number) => void }).noteFenceReleased.bind(svc);
    release('alpha', 1);
    assert.equal(loadRun(s.root, 'alpha', stored.id)!.phases['1'].fenceLifted?.why, 'release');

    await svc.maybeAutoRecover('alpha');
    const lifted = journalOf(s.root, 'alpha', stored.id).filter((l) => l.event === 'phase.fence-lifted');
    assert.deepEqual(lifted.map((l) => [l.phase, l.data.fence, l.data.why, l.data.by]), [[2, 1, 'release', 'heal']]);
    assert.equal(loadRun(s.root, 'alpha', stored.id)!.phases['2'].status, 'pending');
    assert.ok(drives.some((d) => d.via === 'retry' && d.phase === 2), 'and the sibling boards');

    // A live run: the stamp goes on the loop's own record, and the loop is woken.
    const live = loadRun(s.root, 'alpha', stored.id)!;
    delete live.phases['1'].fenceLifted;
    const lane = fakeLiveRunner(live);
    runnersOf(svc).set('alpha', lane.runner);
    try {
      release('alpha', 1);
      assert.equal(live.phases['1'].fenceLifted?.why, 'release');
      assert.equal(lane.docsChanged(), 1, 'the drive loop is woken to lift it');
    } finally { runnersOf(svc).delete('alpha'); }
  } finally { s.cleanup(); }
});

test('SF-4 — the end of the wall\'s wait budget lifts it (why: budget); the fingerprint carries that clock and forgets it once past', () => {
  const t0 = Date.now();
  const at = new Date(t0 - 30 * 60_000).toISOString();
  const state = fenceState(t0, at);
  state.phases['1'].declared!.budget = { ms: HOUR, source: 'phase' };
  const until = Date.parse(at) + HOUR;
  const { lines, sink } = fenceSink();

  assert.deepEqual([...applyScopeFence(state, [2], scopeOf, t0, sink)], [2]);
  assert.equal(state.phases['2'].waitingOn?.[0]?.until, until);
  const board = { 1: 'ready', 2: 'ready', 3: 'ready' };
  const fenceTerm = (now: number) => (JSON.parse(evidenceFingerprint(state, board, [], null, null, now)) as unknown[]).at(-1);
  assert.equal(fenceTerm(t0), `fence@${Math.floor(until / 60_000)}`, 'the soonest future fence end is a term of its own');
  assert.equal(fenceTerm(until + 60_000), '', 'a past end is not due for ever');

  const fenced = applyScopeFence(state, [2], scopeOf, until + 60_000, sink);
  assert.equal(fenced.size, 0);
  const lift = lines.filter((l) => l.event === 'phase.fence-lifted');
  assert.deepEqual(lift.map((l) => [l.phase, l.data.fence, l.data.why]), [[2, 1, 'budget']]);
  assert.equal(state.phases['2'].status, 'pending');
});

/* ------------------------------------------------------------------ *
 * SF-5 — the same wall folds into the first errand
 * ------------------------------------------------------------------ */

test('SF-5 — the wall fingerprint: the same words (numbers folded) or the same probe is one wall; another scope never folds', () => {
  assert.deepEqual(wallFingerprint({ reason: 'Run 4101 FAILED: CI refuses.', watch: [REF] }),
    ['reason:run # failed ci refuses', `ref:${REF}`]);
  assert.deepEqual(wallFingerprint({ reason: 'run 9 failed — ci refuses' }), ['reason:run # failed ci refuses']);

  const at = new Date().toISOString();
  const state = newRun({ slug: 'alpha', root: join(tmpdir(), 'scope-fence-pure') });
  declareWall(phaseRecord(state, 1), at);
  state.recoveries = { 1: { attempts: 0, lastAt: at, errand: wallErrand(1, at) } } as never;
  declareWall(phaseRecord(state, 2), at, { watch: [REF2] });
  declareWall(phaseRecord(state, 3), at);
  declareWall(phaseRecord(state, 4), at, { reason: 'something else entirely' });
  declareWall(phaseRecord(state, 5), at, { reason: 'something else entirely', watch: [REF2] });
  const scopes = (p: number) => (p === 3 ? ['docs'] : ['app']);
  assert.equal(errandFoldTarget(state, 2, scopes), 1, 'the same words, another ref');
  assert.equal(errandFoldTarget(state, 3, scopes), null, 'the same wall in a disjoint scope is not this errand');
  assert.equal(errandFoldTarget(state, 4, scopes), 1, 'other words, the same probe');
  assert.equal(errandFoldTarget(state, 5, scopes), null, 'neither the words nor the probe');
  assert.equal(foldStands(state, 2), false, 'nothing is folded until a writer folds it');
});

/** Phase 1's errand stands; phase 2 has just declared the same wall through the inbox (no errand of its own). */
function foldRun(root: string): RunState {
  const at = new Date().toISOString();
  const state = wallRun(root, { others: [], at });
  state.recoveries = { 1: { attempts: 0, lastAt: at, errand: wallErrand(1, at) } } as never;
  declareWall(phaseRecord(state, 2), at);
  saveRun(state);
  return state;
}

test('SF-5 — heal path: a second same-scope external wall with the same reason folds into the first errand — alsoPhases, foldedInto, no errand, nothing announced, no second park', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    const announced = announcements(svc);
    const stored = foldRun(s.root);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    const disk = loadRun(s.root, 'alpha', stored.id)!;
    assert.deepEqual(disk.recoveries?.['1']?.errand?.alsoPhases, [2], 'the first errand names the second phase');
    assert.equal(disk.recoveries?.['2']?.foldedInto, 1);
    assert.equal(disk.recoveries?.['2']?.errand, undefined, 'no errand of its own');
    assert.equal(foldStands(disk, 2), true);
    const lines = journalOf(s.root, 'alpha', stored.id);
    const folded = lines.filter((l) => l.event === 'phase.errand-folded');
    assert.deepEqual(folded.map((l) => [l.phase, l.data.into, l.data.situation, l.data.by]),
      [[2, 1, 'blocked-declared:external', 'heal']]);
    assert.equal(lines.filter((l) => l.event === 'phase.errand').length, 0, 'no second phase.errand');
    assert.deepEqual(announced, [], 'nothing announced — the first errand already told a person');
    assert.equal(disk.status, 'parked');
    assert.equal(disk.halt?.phase, 1, 'the run is still parked on the first wall, not parked again');
    assert.deepEqual(drives, []);

    // The fold stands across passes: nothing re-written, nothing re-said.
    await svc.maybeAutoRecover('alpha');
    const again = journalOf(s.root, 'alpha', stored.id);
    assert.equal(again.filter((l) => l.event === 'phase.errand-folded').length, 1);
    assert.equal(again.filter((l) => l.event === 'phase.errand').length, 0);
    assert.deepEqual(announced, []);
  } finally { s.cleanup(); }
});

test('SF-5 — runner path: with the first wall\'s fence lifted by its budget and its errand standing, a sibling boards, declares the same wall and folds — no errand, no announcement, no park', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const announced = announcements(svc);
    const now = Date.now();
    const at = new Date(now - 3 * HOUR).toISOString();
    const state = newRun({ slug: 'alpha', root: s.root });
    state.status = 'running';
    declareWall(phaseRecord(state, 1), at, { budget: { ms: HOUR, source: 'phase' } });
    state.recoveries = { 1: { attempts: 0, lastAt: at, errand: wallErrand(1, at) } } as never;
    const b = phaseRecord(state, 2);

    // Past its budget the wall fences nothing, though its errand still stands.
    assert.deepEqual(fenceHolders(state, scopeOf, now), []);
    assert.equal(applyScopeFence(state, [2], scopeOf, now, fenceSink().sink).size, 0, 'so phase 2 boards');
    b.status = 'running';
    b.sessionId = 'sess-b';

    // The runner's events reach the service exactly as a live run's do.
    const runnerEvent = (event: string, data: Record<string, unknown>) =>
      (svc as never as { onRunnerEvent: (e: string, d: unknown) => void }).onRunnerEvent(event, data);
    const r = runnerHandle(state, runnerEvent);
    try {
      const written_at = new Date().toISOString();
      const verdict = await r.route(2, { status: 'needs-human', reason: WALL, watch: [REF], needs: 'external', written_at });
      assert.equal(verdict, 'waiting', 'the lane settles without halting the run');
      assert.deepEqual(r.parks, [], 'no second park of the run');
      assert.equal(state.recoveries?.['2']?.foldedInto, 1);
      assert.equal(state.recoveries?.['2']?.errand, undefined, 'no errand of its own');
      assert.deepEqual(state.recoveries?.['1']?.errand?.alsoPhases, [2]);
      assert.deepEqual(r.events.filter((l) => l.event === 'phase.errand-folded').map((l) => [l.phase, l.data.into, l.data.situation]),
        [[2, 1, 'blocked-declared:external']]);
      assert.equal(r.events.filter((l) => l.event === 'phase.errand').length, 0);
      const emit = r.emitted.filter((e) => e.event === 'run:phase' && e.data.phase === 2);
      assert.equal(emit.length, 1);
      assert.equal(emit[0].data.foldedInto, 1);
      assert.equal(emit[0].data.errand, undefined, 'emitted with no errand — so there is nothing to announce');
      assert.deepEqual(announced.filter((a) => a.phase === 2), [], 'and the service announced nothing');
      assert.equal(b.status, 'parked');
      assert.equal(b.declared?.needs, 'external');

      // The same wiring DOES announce a different wall: its own errand, said once.
      const c = phaseRecord(state, 3);
      c.status = 'running';
      const other = await r.route(3, {
        status: 'needs-human', reason: 'The docs host is read-only until a person unlocks it.', watch: [], needs: 'external', written_at,
      });
      assert.equal(other, 'halted');
      assert.equal(r.parks.length, 1);
      assert.equal(state.recoveries?.['3']?.errand?.situation, 'blocked-declared:external');
      assert.equal(announced.filter((a) => a.phase === 3).length, 1);
    } finally { r.instance.close(); }
  } finally { s.cleanup(); }
});

test('SF-5 — a void fold (the errand it folded into no longer names it) gets its own errand from the healer', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    stubDrives(svc);
    const announced = announcements(svc);
    // Phase 1's wall came down and the phase finished; its errand is gone.
    // Phase 2 is still parked on the same wall, carrying a fold into nothing.
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(join(s.root, 'docs', 'handoffs', 'alpha', 'phase-01-wall.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: wall\nstatus: complete\n---\n# done\n', 'utf8');
    const at = new Date().toISOString();
    const state = newRun({ slug: 'alpha', root: s.root, autoRecover: true });
    state.status = 'parked';
    state.halt = { at, reason: `phase 2 needs a person: ${WALL}`, phase: 2, kind: 'needs-human' };
    phaseRecord(state, 1).status = 'done';
    declareWall(phaseRecord(state, 2), at);
    state.recoveries = { 1: { attempts: 0, lastAt: at }, 2: { attempts: 0, lastAt: at, foldedInto: 1 } } as never;
    saveRun(state);
    assert.equal(foldStands(state, 2), false, 'the premise: the fold is void');

    await svc.maybeAutoRecover('alpha');
    const disk = loadRun(s.root, 'alpha', state.id)!;
    const errand = disk.recoveries?.['2']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:external');
    assert.equal(errand?.need, WALL);
    assert.equal(disk.recoveries?.['2']?.foldedInto, undefined, 'the void fold is dropped');
    const lines = journalOf(s.root, 'alpha', state.id);
    assert.deepEqual(lines.filter((l) => l.event === 'phase.errand').map((l) => l.phase), [2]);
    assert.equal(lines.filter((l) => l.event === 'phase.errand-folded').length, 0);
    assert.equal(announced.filter((a) => a.phase === 2).length, 1, 'and a person is told, once');
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SF-6 — live versus refused refs, in every sentence about the park
 * ------------------------------------------------------------------ */

/**
 * Phase 1 parked on the wall, declaring a `gh:` ref and a `cmd:` ref; `refused`
 * rows read refused. Phases 2 and 3 read done on the board, so the wall is the
 * only open work: Recover goes to the healer rather than relaunching the run
 * for ready phases it never boarded (converge's own rule).
 */
function sentenceRun(root: string, refused: string[]): RunState {
  const dir = join(root, 'docs', 'handoffs', 'alpha');
  mkdirSync(dir, { recursive: true });
  for (const [phase, title] of [[2, 'sibling'], [3, 'elsewhere']] as const) {
    writeFileSync(join(dir, `phase-0${phase}-${title}.md`),
      `---\nplan: docs/plans/alpha.md\nphase: ${phase}\ntitle: ${title}\nstatus: complete\n---\n# done\n`, 'utf8');
  }
  const at = new Date().toISOString();
  const state = wallRun(root, { others: [], refs: [REF, CMD], at });
  state.phases['1'].watchState = {
    at,
    // A declared ref the clock has asked and been told "not yet" reads
    // `pending`; since control-tower phase 88 (#125) a ref with no row is
    // `unknown`, never `live`, so the live one is given its row here.
    refs: [REF, CMD].map((ref) => ({
      ref, scheme: ref.startsWith('cmd:') ? 'cmd' as const : 'gh-run' as const,
      state: refused.includes(ref) ? 'refused' as const : 'pending' as const,
      detail: refused.includes(ref) ? 'refused by the read-only policy' : 'in_progress', checkedAt: at,
    })),
  };
  saveRun(state);
  return state;
}

test('SF-6 — one live gh: ref and one refused cmd: row: the heal reason and the errand name the live one as watched and the refused one as not', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    stubDrives(svc);
    announcements(svc);
    const stored = sentenceRun(s.root, [CMD]);
    const clause = `the console is watching one live ref (${REF}) and resumes the session when one lands; refused, not watched: ${CMD}`;

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.ok((out.reason ?? '').includes(`phase 1 declared needs-human: ${WALL} — ${clause}`), out.reason);
    // The stored errand keeps its own words; the sentence is derived from the
    // record wherever it is shown (control-tower phase 88, #125).
    const { liveErrandHow } = await import('../server/watch-refs.ts');
    const saved = loadRun(s.root, 'alpha', stored.id)!;
    const errand = saved.recoveries?.['1']?.errand;
    assert.ok(errand && !/watching/.test(errand.how), 'nothing frozen into the stored words');
    const how = liveErrandHow(errand!, saved.phases['1']);
    assert.ok(how.endsWith(` T${clause.slice(1)}.`), how);

    await svc.recoverPlan('alpha', undefined as never);
    const quoted = journalOf(s.root, 'alpha', stored.id)
      .filter((l) => l.event === 'run.plan-recover' && l.data.step === 'errand');
    assert.equal(quoted.length, 1);
    assert.ok(String(quoted[0].data.reason ?? '').includes(clause), String(quoted[0].data.reason));
  } finally { s.cleanup(); }
});

test('SF-6 — every row refused: neither the heal reason, the errand nor plan-recover claims to be watching; each says nothing will resume it', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    stubDrives(svc);
    announcements(svc);
    const stored = sentenceRun(s.root, [REF, CMD]);
    const clause = `none of its refs is live (refused, not watched: ${REF}, ${CMD}) — nothing will resume it by itself: do the errand, then press Retry on phase 1`;

    const out = await svc.maybeAutoRecover('alpha');
    assert.ok((out.reason ?? '').includes(clause), out.reason);
    assert.doesNotMatch(out.reason ?? '', /is watching/);
    const { liveErrandHow } = await import('../server/watch-refs.ts');
    const saved = loadRun(s.root, 'alpha', stored.id)!;
    const how = liveErrandHow(saved.recoveries!['1']!.errand!, saved.phases['1']);
    assert.ok(how.endsWith(` N${clause.slice(1)}.`), how);
    assert.doesNotMatch(how, /is watching/);

    // The operator's Recover quotes the heal's refusal as its reason.
    await svc.recoverPlan('alpha', undefined as never);
    const quoted = journalOf(s.root, 'alpha', stored.id)
      .filter((l) => l.event === 'run.plan-recover' && l.data.step === 'errand');
    assert.equal(quoted.length, 1, JSON.stringify(journalOf(s.root, 'alpha', stored.id).filter((l) => l.event === 'run.plan-recover')));
    assert.ok(String(quoted[0].data.reason ?? '').includes(clause), String(quoted[0].data.reason));
    assert.doesNotMatch(String(quoted[0].data.reason ?? ''), /is watching/);
  } finally { s.cleanup(); }
});

test('SF-6 — the runner\'s own errand says the same: a retired cmd: ref is refused, never watched', async () => {
  const written_at = new Date().toISOString();
  const errandHow = async (watch: string[]) => {
    const state = newRun({ slug: 'alpha', root: join(tmpdir(), 'scope-fence-pure') });
    const record = phaseRecord(state, 3);
    record.status = 'running';
    record.watchRetired = [CMD];
    const r = runnerHandle(state);
    try {
      assert.equal(await r.route(3, { status: 'needs-human', reason: WALL, watch, needs: 'external', written_at }), 'halted');
      const errand = state.recoveries?.['3']?.errand;
      assert.ok(errand && !/watching|resume/i.test(errand.how), 'the stored words freeze no watch sentence (#125)');
      // The live ref has been asked once: pending.
      record.watchState = { at: written_at, refs: watch.filter((ref) => ref !== CMD).map((ref) => ({ ref, scheme: 'gh-run' as const, state: 'pending' as const, checkedAt: written_at })) };
      const { liveErrandHow } = await import('../server/watch-refs.ts');
      return liveErrandHow(errand!, record);
    } finally { r.instance.close(); }
  };
  const one = await errandHow([REF, CMD]);
  assert.ok(one.endsWith(` The console is watching one live ref (${REF}) and resumes the session when one lands; refused, not watched: ${CMD}.`), one);
  const none = await errandHow([CMD]);
  assert.ok(none.endsWith(` None of its refs is live (refused, not watched: ${CMD}) — nothing will resume it by itself: do the errand, then press Retry on phase 3.`), none);
  assert.doesNotMatch(none, /is watching/);
});

/* ------------------------------------------------------------------ *
 * SF-7 — a landing on a live run boards through the run's own lanes
 * ------------------------------------------------------------------ */

test('SF-7 — a landing on a LIVE run goes to Runner.landWatch: phase.watch-landed, the live objects written, no recoverPhase', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    announcements(svc);
    const stored = wallRun(s.root, { others: [2] });
    const live = loadRun(s.root, 'alpha', stored.id)!; // the loop's own objects
    const offered = loadRun(s.root, 'alpha', stored.id)!; // the copy the watch clock hands over
    const lane = fakeLiveRunner(live);
    runnersOf(svc).set('alpha', lane.runner);
    try {
      assert.equal(svc.watchResumeInFlight('alpha', 1), false);
      const outcome = await land(svc, offered, 1, REF);
      assert.equal(outcome, 'resumed');
      assert.deepEqual(lane.landed, [{ phase: 1, ref: REF, count: 1, sessionId: 'sess-wall-1' }]);
      assert.deepEqual(drives, [], 'no recoverPhase, no retry, no start — the loop boards it');
      const lines = journalOf(s.root, 'alpha', stored.id);
      assert.deepEqual(lines.filter((l) => l.event === 'phase.watch-landed').map((l) => [l.phase, l.data.ref]), [[1, REF]]);
      assert.equal(lines.filter((l) => l.event === 'phase.resume-automatic').length, 0,
        'the live lane journals its own resume — the service writes none');
      const record = live.phases['1'];
      assert.equal(record.declared?.landed?.ref, REF, 'written on the LIVE record');
      assert.equal(record.fenceLifted?.why, 'landed');
      assert.equal(record.watchResumes, 1);
      assert.equal(offered.phases['1'].declared?.landed, undefined, 'never on a copy the loop would overwrite');
      assert.equal(svc.watchResumeInFlight('alpha', 1), true, 'the offer is held while the loop holds the landing');
    } finally { runnersOf(svc).delete('alpha'); }
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SF-8 — the console busy with itself is not a rejection
 * ------------------------------------------------------------------ */

test('SF-8 — a busy refusal is never charged: RunBusyError four times, past the cap of three, leaves no watchRejections and no errand', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const announced = announcements(svc);
    let calls = 0;
    (svc as never as Loose).recoverPhase = async () => { calls += 1; throw new RunBusyError('alpha'); };
    const stored = wallRun(s.root, { others: [] });
    const live = loadRun(s.root, 'alpha', stored.id)!;
    const since = Date.now();

    for (let i = 0; i < 4; i += 1) {
      await land(svc, live, 1, REF);
      await settled();
    }
    assert.equal(calls, 4, 'every offer reached the drive — nothing backed off or capped it');
    const record = live.phases['1'];
    assert.equal(record.watchRejections, undefined, 'no rejection was charged');
    assert.equal(record.watchResumes, undefined, 'and every delivery was un-charged');
    assert.equal(record.watchLandedErrandFor, undefined);
    const disk = loadRun(s.root, 'alpha', stored.id)!;
    assert.equal(disk.phases['1'].watchRejections, undefined);
    assert.equal(disk.recoveries?.['1']?.errand, undefined, 'no errand');
    assert.equal(journalOf(s.root, 'alpha', stored.id).filter((l) => l.event === 'phase.errand').length, 0);
    assert.equal(announced.filter((a) => /needs you/.test(a.title)).length, 0, 'nobody is asked');
    const voids = recentLog(500).filter((e) => e.event === 'run.watch-resume-void'
      && Date.parse(e.time) >= since && e.data?.busy === true);
    assert.equal(voids.length, 4, 'each said as a void delivery, busy');
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * SF-9 — console lock refs and one landing errand per declaration
 * ------------------------------------------------------------------ */

test('SF-9 — a lock: ref the console implied or minted around a declared phase lands as done: nothing resumed, no errand', async () => {
  const IMPLIED = 'lock:beta/3';
  const MINTED = 'lock:gamma/1';
  const OWN = 'lock:delta/2';
  assert.equal(consoleLockRef({ declared: { watch: [REF] } }, IMPLIED), true, 'not in the declaration: implied');
  assert.equal(consoleLockRef({ declared: { watch: [REF, MINTED], minted: [MINTED] } }, MINTED), true, 'minted');
  assert.equal(consoleLockRef({ declared: { watch: [REF, OWN] } }, OWN), false, 'the session\'s own lock ref is its word');
  assert.equal(consoleLockRef({ declared: { watch: [REF] } }, REF), false, 'and a gh: ref is never a console lock');

  const s = scratch();
  try {
    const svc = service(s.root);
    const drives = stubDrives(svc);
    const announced = announcements(svc);
    const stored = wallRun(s.root, { others: [], refs: [REF, MINTED] });
    const live = loadRun(s.root, 'alpha', stored.id)!;
    live.phases['1'].declared!.minted = [MINTED];

    for (const ref of [IMPLIED, MINTED, IMPLIED]) {
      assert.equal(await land(svc, live, 1, ref), 'done', ref);
      await settled();
    }
    assert.deepEqual(drives, []);
    const lines = journalOf(s.root, 'alpha', stored.id);
    assert.equal(lines.filter((l) => l.event === 'phase.errand').length, 0);
    assert.equal(lines.filter((l) => l.event === 'phase.watch-landed').length, 0);
    assert.equal(live.phases['1'].watchLandedErrandFor, undefined);
    assert.equal(live.phases['1'].declared?.landed, undefined, 'the declaration is not resumed');
    assert.deepEqual(announced, []);
  } finally { s.cleanup(); }
});

test('SF-9 — two declared refs, rejected to the cap between them, write exactly ONE phase.errand', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    const announced = announcements(svc);
    let calls = 0;
    (svc as never as Loose).recoverPhase = async () => {
      calls += 1;
      throw new Error('another recovery of this phase is already running');
    };
    const stored = wallRun(s.root, { others: [], refs: [REF, REF2] });
    const live = loadRun(s.root, 'alpha', stored.id)!;

    for (const ref of [REF, REF2, REF, REF2, REF, REF2]) {
      await land(svc, live, 1, ref);
      await settled();
    }
    assert.equal(calls, 3, 'the ledger is the phase\'s: the third rejection is the cap, whichever ref it came from');
    assert.equal(live.phases['1'].watchRejections?.count, 3);
    const lines = journalOf(s.root, 'alpha', stored.id);
    const errands = lines.filter((l) => l.event === 'phase.errand');
    assert.equal(errands.length, 1, 'one errand per declaration, not one per ref');
    assert.match(String(errands[0].data.need ?? ''), /3 attempts to resume this phase were refused/);
    assert.equal(announced.filter((a) => a.phase === 1 && /needs you/.test(a.title)).length, 1, 'said once');
    assert.equal(lines.filter((l) => l.event === 'phase.watch-landed').length, 2, 'each ref\'s landing journalled once');
    assert.ok(loadRun(s.root, 'alpha', stored.id)!.recoveries?.['1']?.errand, 'and the errand is on disk');
  } finally { s.cleanup(); }
});
