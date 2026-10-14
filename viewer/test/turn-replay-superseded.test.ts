/**
 * The replay (turn-by-turn phase 7, exit criterion 1) — a synthetic copy of
 * the case §Context 1 measured on a hub: a run in a shared checkout was
 * stopped "relaunch isolated" and replaced by an isolated run of the same
 * plan; a day later the machine login changed identity, and the identity park
 * raised a fresh question on the DEAD run, overwriting the operator's stop —
 * an item with nobody to answer it.
 *
 *   RP-1  an identity change raises nothing on the superseded run: no park, no
 *         errand, no `run.identity-changed`, the operator's stop kept;
 *   RP-2  the run reads auto-resolved "superseded by run <B>", journalled
 *         `run.superseded` once; `unresolve` restores it, for good;
 *   RP-3  a run followed only by a run of DISJOINT `onlyPhases` is not
 *         superseded — the identity change parks it, as it must;
 *   RP-4  an unlanded run is never superseded, whatever follows it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
type RunState = import('../server/runner/state.ts').RunState;
type RunIdentity = import('../server/accounts/index.ts').RunIdentity;

const ADMIN: RunIdentity = { account: 'default', key: 'k-admin', email: 'admin@example.com', org: 'Example Org' };
const INFO: RunIdentity = { account: 'default', key: 'k-info', email: 'info@example.com', org: 'Example Org' };

const PLAN = `---
slug: fleet-demo
created: 2026-10-01
status: active
phases: 3
---

# fleet-demo

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | sweep | — | — | app | it works |
| 2 | clean | 1 | — | app | it still works |
| 3 | report | 2 | — | app | it reads |

## Phases

### Phase 1 — sweep
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — clean
- **Size:** S
- **Verification:** \`true\`

### Phase 3 — report
- **Size:** S
- **Verification:** \`true\`
`;

const SLUG = 'fleet-demo';

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-replay-superseded-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', SLUG), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${SLUG}.md`), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc as typeof svc & {
    identityChanged: (accountId: string, now: RunIdentity) => number;
    runsFor: (slug: string) => Promise<RunState[]>;
    unresolveRun: (slug: string, runId: string) => RunState | null;
  };
}

const journal = (root: string, runId: string) => {
  try {
    return readFileSync(journalFile(root, SLUG, runId), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
  } catch { return []; }
};

/** Run A: bound to admin@, in a shared checkout, stopped by the operator to relaunch it isolated. */
function stoppedToRelaunch(root: string, over: (state: RunState) => void = () => {}): RunState {
  const a = newRun({ slug: SLUG, root } as never);
  a.createdAt = '2026-10-10T17:00:00.000Z';
  a.identity = { ...ADMIN, at: '2026-10-10T17:00:00.000Z' };
  a.status = 'halted' as never;
  a.stoppedBy = 'operator';
  a.halt = { at: '2026-10-10T17:31:00.000Z', reason: 'stopped by the operator — relaunch isolated', phase: 2, kind: 'operator-stop' } as never;
  a.finishedReason = 'stopped by the operator — relaunch isolated';
  phaseRecord(a, 1).status = 'done' as never;
  phaseRecord(a, 2).status = 'interrupted' as never;
  over(a);
  saveRun(a);
  return a;
}

/** Run B: the isolated relaunch, created after A — no identity bound yet, so the park leaves it be. */
function relaunched(root: string, over: (state: RunState) => void = () => {}): RunState {
  const b = newRun({ slug: SLUG, root } as never);
  b.createdAt = '2026-10-10T17:31:30.000Z';
  b.status = 'paused' as never;
  b.stoppedBy = 'system';
  over(b);
  saveRun(b);
  return b;
}

test('RP-1, RP-2: an identity change raises nothing on the superseded run, which reads auto-resolved "superseded by run B" — and unresolve restores it for good', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const a = stoppedToRelaunch(root);
    const b = relaunched(root);
    // A day later, the machine login answers somebody else.
    const parked = svc.identityChanged('default', INFO);
    assert.equal(parked, 0, 'nothing to park: the only run bound to admin@ is superseded');
    const after = loadRun(root, SLUG, a.id, null)!;
    assert.equal(after.halt?.kind, 'operator-stop', 'the operator\'s stop is not overwritten');
    assert.equal(after.stoppedBy, 'operator');
    assert.equal(after.errand ?? null, null, 'no question raised on a run nobody drives again');
    assert.equal(after.finishedReason, 'stopped by the operator — relaunch isolated');
    assert.deepEqual(journal(root, a.id).filter((line) => line.event === 'run.identity-changed' || line.event === 'run.errand'), []);

    // RP-2 — the read resolves it, naming its successor, once.
    const runs = await svc.runsFor(SLUG);
    const read = runs.find((run) => run.id === a.id)!;
    assert.equal(read.resolved?.auto, true);
    assert.equal(read.resolved?.reason, `superseded by run ${b.id}`);
    assert.equal(read.resolved?.supersededBy, b.id);
    assert.equal(loadRun(root, SLUG, a.id, null)!.resolved?.reason, `superseded by run ${b.id}`, 'and it is written down');
    const lines = journal(root, a.id).filter((line) => line.event === 'run.superseded');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.data?.by, b.id);
    assert.equal(lines[0]!.data?.halt, 'operator-stop');
    assert.equal(runs.find((run) => run.id === b.id)!.resolved ?? null, null, 'the successor stands');
    await svc.runsFor(SLUG);
    assert.equal(journal(root, a.id).filter((line) => line.event === 'run.superseded').length, 1, 'journalled once');

    // `unresolve` restores it — and the next read does not resolve it again.
    const back = svc.unresolveRun(SLUG, a.id)!;
    assert.equal(back.resolved, null);
    assert.ok(back.reopenedAt);
    const reread = (await svc.runsFor(SLUG)).find((run) => run.id === a.id)!;
    assert.equal(reread.resolved ?? null, null, 'a person put it back: it stays back');
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});

test('RP-3: a run followed only by a run of disjoint onlyPhases is not superseded — the identity change parks it', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const a = stoppedToRelaunch(root, (s) => { s.stoppedBy = 'system'; s.halt = { at: s.createdAt, reason: 'a wall', phase: 2, kind: 'phase-failed' } as never; });
    const c = relaunched(root, (s) => { s.onlyPhases = [3]; });
    assert.equal(svc.identityChanged('default', INFO), 1);
    const after = loadRun(root, SLUG, a.id, null)!;
    assert.equal(after.halt?.kind, 'identity-changed', 'phase 2 is still owed by A alone');
    assert.ok(after.errand, 'its question is a real one');
    const runs = await svc.runsFor(SLUG);
    assert.equal(runs.find((run) => run.id === a.id)!.resolved ?? null, null, `run ${c.id} does not cover phase 2`);
    assert.deepEqual(journal(root, a.id).filter((line) => line.event === 'run.superseded'), []);
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});

test('RP-3: an operator\'s stop that nothing supersedes is parked on the change, and stays the operator\'s', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const a = stoppedToRelaunch(root);
    assert.equal(svc.identityChanged('default', INFO), 1);
    const after = loadRun(root, SLUG, a.id, null)!;
    assert.equal(after.halt?.kind, 'identity-changed');
    assert.equal(after.stoppedBy, 'operator', 'never written over with the system\'s');
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});

test('RP-4: an unlanded run is never superseded, whatever follows it', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const a = stoppedToRelaunch(root, (s) => {
      s.stoppedBy = 'system';
      s.halt = { at: s.createdAt, reason: 'the work is not on the trunk yet', kind: 'unlanded' } as never;
    });
    relaunched(root);
    const runs = await svc.runsFor(SLUG);
    assert.equal(runs.find((run) => run.id === a.id)!.resolved ?? null, null, 'its merge errand is a person\'s');
    assert.deepEqual(journal(root, a.id).filter((line) => line.event === 'run.superseded'), []);
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});
