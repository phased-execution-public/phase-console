/**
 * A resumable run keeps its trees (control-tower phase 82, #94).
 *
 * Measured on 4130: a console restart, and again a pause, swept two of
 * control-tower's four mirror mounts while the run was about to resume — the
 * boot sweep ran before the run re-registered, and the drive's own prune took
 * every clean mount at a pause. The rebuild was then refused `scope-outside-root`
 * for the WHOLE run because one phase's Repos cell named a repository outside the
 * root, and all 75 phases fell back to the shared checkout.
 *
 *  - WS-1 a run is resumable while a loop will come back to it;
 *  - WS-2 no sweep removes a resumable run's trees — the boot sweep, the drive's
 *    own sweep, and the prune at the end of a loop that paused — nor the
 *    directory of a run that is over while its `stale-mounts/` holds a
 *    quarantine (control-tower phase 90, #139);
 *  - WS-3 a mount lost while the run was stopped is rebuilt on resume;
 *  - WS-4 an out-of-root Repos cell refuses its own phase only.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUN_STATUSES, runResumable } from '../shared/run-lifecycle.js';
import {
  ensureMirror,
  laneNames,
  resolveMounts,
  staleMountsDir,
  sweepStale,
  validateMirror,
} from '../server/runner/worktree.ts';
import type { SpawnRequest } from '../server/runner/spawn.ts';
import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';

// The console exports `PE_*` into every session it spawns — this suite's too,
// under an autopilot — and an assertion that a claim variable is ABSENT must
// not read the supervisor's own.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

/* ------------------------------------------------------------------ WS-1 */

test('WS-1 — a run is resumable while a loop will come back to it, and over only when finished, resolved or told not to', () => {
  for (const status of ['paused', 'pausing', 'halted', 'halting', 'parked', 'waiting', 'queued', 'running', 'frozen', 'stopping']) {
    assert.equal(runResumable({ status }), true, status);
  }
  assert.equal(runResumable({ status: 'interrupted', resumeOnRestart: true }), true, 'interrupted, and the run said resume');
  assert.equal(runResumable({ status: 'interrupted' }), true,
    'a run from before the answer existed falls back to the console default — kept rather than guessed away');
  assert.equal(runResumable({ status: 'interrupted', resumeOnRestart: false }), false, 'the run said never');
  assert.equal(runResumable({ status: 'finished' }), false);
  assert.equal(runResumable({ status: 'halted', resolved: { at: '2026-09-26T00:00:00Z' } }), false, 'a resolved run is over');
  assert.equal(runResumable(null), false, 'an unreadable run is not kept for ever');
  for (const status of RUN_STATUSES) assert.equal(typeof runResumable({ status }), 'boolean', `${status} is answered`);
});

/* ------------------------------------------------------------------ WS-2 */

test('WS-2 — the sweep spares a resumable run\'s mirror, and takes the same mirror once the run is over', async () => {
  const { base, root } = superRoot();
  const stateDir = join(base, 'state');
  const res = await resolveMounts(root, ['web', 'api']);
  assert.equal(res.ok, true);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  const names = laneNames({ stateDir, runId: 'r-paused', slug: 'demo', phase: 0 });
  assert.equal((await ensureMirror({ names, runId: 'r-paused', slug: 'demo', mounts })).ok, true);

  // The run is not live: this is the boot sweep, before any runner re-registers.
  const spared = await sweepStale(root, {
    stateDir, slug: 'demo', liveRunIds: [], resumable: (runId) => runId === 'r-paused',
  });
  assert.deepEqual(spared.spared, ['r-paused']);
  assert.deepEqual(spared.removed, []);
  assert.equal(await validateMirror(names.integration, names.runBranch), true,
    'every mount of the resumable run still stands, clean mounts included');

  // The same run, over: swept exactly as before.
  const over = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [], resumable: () => false });
  assert.ok(over.runs.includes('r-paused'), 'a run that is over is still swept');
  assert.equal(existsSync(names.integration), false);
});

test('WS-2 — a run that is over keeps its directory while a quarantine is in it, and loses it once a person clears it', async () => {
  const { base, root } = superRoot();
  const stateDir = join(base, 'state');
  const res = await resolveMounts(root, ['web', 'api']);
  assert.equal(res.ok, true);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  const names = laneNames({ stateDir, runId: 'r-over', slug: 'demo', phase: 0 });
  assert.equal((await ensureMirror({ names, runId: 'r-over', slug: 'demo', mounts })).ok, true);

  // What a repair moved aside instead of deleting: a session's work at a mount.
  const stale = staleMountsDir(names.integration);
  const moved = join(stale, '2026-09-27T10-00-00-000Z', 'web');
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, 'wip.txt'), 'a session was here');

  const first = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [], resumable: () => false });
  assert.equal(first.runs.includes('r-over'), false, 'the run directory went with its quarantine');
  assert.ok(first.kept.includes(stale), `the quarantine is named as kept: ${JSON.stringify(first.kept)}`);
  assert.equal(readFileSync(join(moved, 'wip.txt'), 'utf8'), 'a session was here');
  assert.equal(existsSync(names.integration), false, 'the clean mirror of a run that is over is still taken');

  // A person clears it; the next sweep takes the directory like any other.
  rmSync(join(stale, '2026-09-27T10-00-00-000Z'), { recursive: true });
  const second = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [], resumable: () => false });
  assert.ok(second.runs.includes('r-over'), 'an empty stale-mounts/ holds nothing');
  assert.equal(existsSync(dirname(names.integration)), false);
});

test('WS-2 — both sweeps ask the stored run whether it is resumable', () => {
  // The boot sweep runs before any runner re-registers, so `liveRunIds` is
  // empty there by construction; the stored run is the only witness.
  for (const [file, owner] of [['service-base.ts', 'sweepStaleWorktrees'], ['runner/runner-loop.ts', 'sweepStaleWorktrees']] as const) {
    const text = readFileSync(join(SERVER, file), 'utf8');
    const at = text.indexOf(`async ${owner}(`);
    assert.ok(at >= 0, `${file} has ${owner}`);
    const call = text.slice(text.indexOf('sweepStale(', at), text.indexOf('});', text.indexOf('sweepStale(', at)));
    assert.match(call, /resumable: \(runId\) => runResumable\(loadRun\(/, `${file}'s sweep asks runResumable of the stored run`);
  }
});

/* ------------------------------------------------------------ WS-2 + WS-3 */

test('WS-2/WS-3 — a pause keeps the mirror, and a mount lost while paused is rebuilt on resume', async () => {
  const { root } = superRoot();
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    // The operator presses Pause while phase 1 works: the loop lands `paused`.
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(first.status, 'paused');
  const workRoot = String(first.workRoot ?? '');
  assert.ok(workRoot && workRoot !== root, `the run took its mirror; requests went to ${h.requests.map((q) => q.cwd).join(', ')}`);
  assert.equal(h.requests[0]!.cwd, workRoot);

  await until(() => journal(root, 'run.worktrees-kept').length + journal(root, 'run.worktrees-pruned').length > 0,
    'the loop end to decide about the trees');
  assert.equal(journal(root, 'run.worktrees-pruned').length, 0, 'nothing was pruned at the pause');
  const kept = journal(root, 'run.worktrees-kept');
  assert.equal(kept.length, 1);
  assert.equal((kept[0]!.data as Record<string, unknown>).status, 'paused');
  for (const mount of ['web', 'api']) {
    assert.equal(existsSync(join(workRoot, mount)), true, `the ${mount} mount survived the pause`);
  }

  // Something removes a mount while the run is stopped — an older console's
  // sweep, or a person tidying up.
  git(join(root, 'web'), 'worktree', 'remove', '--force', join(workRoot, 'web'));
  assert.equal(existsSync(join(workRoot, 'web')), false);

  const second = await drive(h, { resumeRunId: String(first.id), onlyPhases: [2] });
  assert.equal(second.checkout, 'worktree', `the resume kept its isolation (refusal: ${String(second.isolationRefusal)})`);
  assert.equal(second.workRoot, workRoot);
  const phase2 = h.requests.find((q) => /BOOT phase 2\b/.test(q.prompt));
  assert.equal(phase2?.cwd, workRoot, 'phase 2 ran in the repaired mirror, not the shared root');
  assert.equal(git(join(workRoot, 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'the lost mount stands again on the run branch');
  const repaired = journal(root, 'run.mirror-repaired');
  assert.equal(repaired.length, 1);
  assert.deepEqual((repaired[0]!.data as Record<string, unknown>).missing, ['web']);
  assert.equal((repaired[0]!.data as Record<string, unknown>).ok, true);
});

/* ------------------------------------------------------------------ WS-4 */

test('WS-4 — an out-of-root Repos cell refuses its own phase, never the run', async () => {
  const { root } = superRoot();
  // Phase 1 names a repository that is not under the root (the tap); phase 2
  // names a submodule. The plan's union holds both.
  const h = harness(root, { 1: 'homebrew-tap', 2: 'web' }, { planScope: () => ['web', 'homebrew-tap'] });
  const state = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(state.checkout, 'worktree', `one cell must not refuse the run (refusal: ${String(state.isolationRefusal)})`);
  assert.equal(state.isolationRefusal, undefined);
  const workRoot = String(state.workRoot);
  const byPhase = (n: number): SpawnRequest | undefined => h.requests.find((q) => new RegExp(`BOOT phase ${n}\\b`).test(q.prompt));
  assert.equal(byPhase(2)?.cwd, workRoot, 'the in-root phase ran isolated');
  assert.equal(byPhase(2)?.env?.PE_BRANCH, 'pe/demo', 'and claimed on its branch');

  // The out-of-root phase: its claim is unqualified (it collides with every
  // intersecting claim, the truth the console can vouch for) and the journal
  // says why, once.
  assert.equal(byPhase(1)?.env?.PE_BRANCH, undefined);
  assert.equal(byPhase(1)?.env?.PE_WORKTREE, undefined);
  const refused = journal(root, 'phase.isolation-refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.phase, 1);
  assert.equal((refused[0]!.data as Record<string, unknown>).refusal, 'scope-outside-root');
  assert.deepEqual((refused[0]!.data as Record<string, unknown>).tokens, ['homebrew-tap']);
});

test('WS-4 — a plan whose every cell is outside the root still refuses the run (the hub shape)', async () => {
  const { root } = superRoot();
  const h = harness(root, { 1: 'homebrew-tap', 2: 'homebrew-tap' }, { planScope: () => ['homebrew-tap'] });
  const state = await drive(h, { onlyPhases: [1] });
  assert.equal(state.checkout, 'refused');
  assert.equal(state.isolationRefusal, 'scope-outside-root');
  assert.equal(h.requests[0]!.cwd, root);
});
