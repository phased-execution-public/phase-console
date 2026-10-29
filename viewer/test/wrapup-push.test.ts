/**
 * The wrap-up pushes what is green (measured-console phase 12; #397, #418's third ask).
 *
 * WP-1  `unpushedIn` counts a `pe/…` branch's commits past `origin/<branch>` (every commit no remote
 *       holds when that ref is absent) and never reads a trunk
 * WP-2  a checkpointed session's fast-forward is pushed where the plan's row allows it —
 *       `phase.wrapup-pushed`, and nothing left on `record.unpushed`
 * WP-3  where the row refuses, nothing is pushed: `record.unpushed` names the tree and the count, and
 *       the next read after a push lands deletes it (`phase.unpushed {landed: true}`)
 * WP-4  the 0.6× notice says push, with the command, where the row allows it — and says the console
 *       names the commits where it does not
 * WP-5  `phase-outcome.sh partial` warns, naming each scope tree ahead of `origin/<branch>` with
 *       the count; the declaration itself is unchanged, and `complete` warns of nothing
 * WP-6  the push rule's condition is the row's verdict on `git push origin <branch>`, as a
 *       session's own push gets it: this plan's row allows the run branch, a bare `deny` row does not
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { originPin, pushableBranch, unpushedIn, type OriginPin } from '../server/runner/unpushed.ts';
import { contextWrapupNotice, wrapupCommitStep } from '../server/runner/runner-core.ts';
import { manifestVerdict } from '../server/runner/manifest-verdict.ts';
import { Runner } from '../server/runner/runner.ts';
import type { RunState } from '../server/runner/state.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'phase-outcome.sh');
const ENV = {
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** A bare origin and a clone on `branch`, pushed once, then `ahead` commits made and not pushed. */
function stubRepo(branch: string, ahead: number): { dir: string; work: string; origin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-wrapup-push-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-qb', branch);
  git(work, 'push', '-q', 'origin', branch);
  for (let i = 0; i < ahead; i++) {
    writeFileSync(join(work, `w${i}.txt`), `${i}\n`);
    git(work, 'add', `w${i}.txt`);
    git(work, 'commit', '-qm', `green ${i}`);
  }
  return { dir, work, origin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('WP-1 the unpushed count: a pe/ branch past its origin, a branch never pushed, never a trunk', async () => {
  const r = stubRepo('pe/demo', 2);
  try {
    assert.deepEqual(await unpushedIn([r.work], r.work), [{ repo: '.', branch: 'pe/demo', ahead: 2, tracked: true }]);
    git(r.work, 'checkout', '-qb', 'pe/demo-p3');
    assert.deepEqual(await unpushedIn([r.work], r.work), [{ repo: '.', branch: 'pe/demo-p3', ahead: 2, tracked: false }]);
    git(r.work, 'checkout', '-q', 'main');
    writeFileSync(join(r.work, 'm.txt'), 'm\n');
    git(r.work, 'add', 'm.txt');
    git(r.work, 'commit', '-qm', 'trunk');
    assert.deepEqual(await unpushedIn([r.work], r.work), [], 'a trunk is never the console’s to count or push');
    assert.equal(pushableBranch('main'), false);
    assert.equal(pushableBranch('pe/demo'), true);
    assert.equal(pushableBranch('pe/../main'), false);
  } finally { r.cleanup(); }
});

type Line = { event: string; phase?: number; data: Record<string, unknown> };

/** A runner holding a one-phase run over `root`, its push verdict `allowed`. */
function runnerOver(root: string, allowed: boolean): { runner: Runner; state: RunState; asked: string[]; journal: () => Line[] } {
  const asked: string[] = [];
  const lines: Line[] = [];
  const runner = new Runner({
    scriptsDir: join(root, 'scripts'),
    pushAllowed: (_state: RunState, _phase: number, command: string) => { asked.push(command); return allowed; },
    onEvent: (name: string, data: { event: string; phase?: number; data: Record<string, unknown> }) => {
      if (name === 'run:journal') lines.push({ event: data.event, phase: data.phase, data: data.data });
    },
  } as never);
  const state = {
    id: 'wp1', slug: 'demo', root, status: 'running', gitMode: 'new-branch',
    phases: { 1: { status: 'running' } }, startedAt: new Date().toISOString(),
  } as unknown as RunState;
  (runner as unknown as { state: RunState }).state = state;
  const journal = () => lines;
  return { runner, state, asked, journal };
}

type NoteUnpushed = {
  noteUnpushed(phase: number, trees: string[], root: string, opts?: { push?: boolean; origins?: ReadonlyMap<string, OriginPin> }): Promise<void>;
};

test('WP-2 a checkpointed session’s fast-forward is pushed where the row allows it', async () => {
  const r = stubRepo('pe/demo', 2);
  try {
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    const { runner, state, asked, journal } = runnerOver(r.dir, true);
    // A hook a session planted never runs under the console's push.
    writeFileSync(join(r.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${JSON.stringify(join(r.dir, 'hook-ran'))}\nexit 1\n`, { mode: 0o755 });
    const pins = new Map([[r.work, (await originPin(r.work))!]]);
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work, { push: true, origins: pins });
    assert.deepEqual(asked.slice(0, 1), ['git push origin pe/demo'], 'the row is asked about exactly the push it will run');
    assert.equal(git(r.origin, 'rev-parse', 'refs/heads/pe/demo'), git(r.work, 'rev-parse', 'HEAD'), 'origin holds the green commits');
    assert.equal(state.phases['1'].unpushed, undefined, 'nothing left unpushed');
    const pushed = journal().find((l) => l.event === 'phase.wrapup-pushed');
    assert.equal(pushed?.data.ok, true);
    assert.equal(pushed?.data.ahead, 2);
    assert.equal(pushed?.data.branch, 'pe/demo');
    assert.equal(existsSync(join(r.dir, 'hook-ran')), false, 'no repository hook ran');
  } finally { r.cleanup(); }
});

test('WP-2b a remote the session re-pointed is never pushed to', async () => {
  const r = stubRepo('pe/demo', 1);
  try {
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    const elsewhere = join(r.dir, 'elsewhere.git');
    git(r.dir, 'init', '-q', '--bare', elsewhere);
    const pins = new Map([[r.work, (await originPin(r.work))!]]);
    git(r.work, 'remote', 'set-url', '--push', 'origin', elsewhere);
    const { runner, state, journal } = runnerOver(r.dir, true);
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work, { push: true, origins: pins });
    const pushed = journal().find((l) => l.event === 'phase.wrapup-pushed');
    assert.equal(pushed?.data.ok, false);
    assert.match(String(pushed?.data.detail), /not what it was before the session ran/);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/pe/demo'], { cwd: elsewhere }).status, 128, 'nothing reached the other remote');
    assert.equal(state.phases['1'].unpushed?.trees[0]?.ahead, 1, 'the count stands');
    // A second push URL beside the pinned one is refused as well: the list must be the one read.
    git(r.work, 'remote', 'set-url', '--push', 'origin', r.origin);
    git(r.work, 'remote', 'set-url', '--add', '--push', 'origin', elsewhere);
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work, { push: true, origins: pins });
    assert.equal(journal().filter((l) => l.event === 'phase.wrapup-pushed').at(-1)?.data.ok, false);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/pe/demo'], { cwd: elsewhere }).status, 128);
    // …and an insteadOf rewrite of the pinned URL, with the remote itself untouched, as well.
    git(r.work, 'config', '--unset-all', 'remote.origin.pushurl');
    git(r.work, 'config', `url.${elsewhere}.insteadOf`, r.origin);
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work, { push: true, origins: pins });
    assert.equal(journal().filter((l) => l.event === 'phase.wrapup-pushed').at(-1)?.data.ok, false);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/pe/demo'], { cwd: elsewhere }).status, 128);
  } finally { r.cleanup(); }
});

test('WP-3 where the row refuses, nothing is pushed and the phase names the unpushed count until a push lands', async () => {
  const r = stubRepo('pe/demo', 1);
  try {
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    const before = git(r.origin, 'rev-parse', 'refs/heads/pe/demo');
    const { runner, state, journal } = runnerOver(r.dir, false);
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work, { push: true });
    assert.equal(git(r.origin, 'rev-parse', 'refs/heads/pe/demo'), before, 'nothing was pushed');
    assert.deepEqual(state.phases['1'].unpushed?.trees, [{ repo: '.', branch: 'pe/demo', ahead: 1, tracked: true }]);
    const named = journal().find((l) => l.event === 'phase.unpushed');
    assert.deepEqual(named?.data.trees, [{ repo: '.', branch: 'pe/demo', ahead: 1, tracked: true, allowed: false }]);
    assert.equal(journal().filter((l) => l.event === 'phase.wrapup-pushed').length, 0);
    // A person (or a later session) pushes: the next read clears it.
    git(r.work, 'push', '-q', 'origin', 'pe/demo');
    await (runner as unknown as NoteUnpushed).noteUnpushed(1, [r.work], r.work);
    assert.equal(state.phases['1'].unpushed, undefined);
    assert.deepEqual(journal().filter((l) => l.event === 'phase.unpushed').at(-1)?.data, { trees: [], landed: true });
  } finally { r.cleanup(); }
});

test('WP-4 the notice says push, with the command, where the row allows it — and where it does not, who names it', () => {
  const allowed = contextWrapupNotice(610_000, 1_000_000, 'bash phase-outcome.sh demo 4', {
    shared: true, fastGate: [], push: { branch: 'pe/demo', allowed: true },
  });
  assert.match(allowed, /Then push what you committed: `git push origin pe\/demo` — a fast-forward, never forced/);
  assert.match(allowed, /partial --reason context/);
  const refused = wrapupCommitStep({ shared: true, fastGate: [], push: { branch: 'pe/demo', allowed: false } });
  assert.match(refused, /may not push it: the console names the unpushed commits on the phase until a push lands/);
  assert.doesNotMatch(refused, /git push/);
  assert.match(wrapupCommitStep({ shared: false, push: { branch: 'pe/demo-p4', allowed: true } }), /git push origin pe\/demo-p4/);
  assert.doesNotMatch(wrapupCommitStep({ shared: true }), /push/, 'no branch known: the old words, unchanged');
});

test('WP-5 phase-outcome.sh partial warns, naming each scope tree ahead of its origin; complete does not', () => {
  const r = stubRepo('pe/demo', 3);
  try {
    const env = {
      ...ENV, PHASE_OUTCOME_PROBE: '0', PE_NOW: '2026-10-25T10:00:00Z', PE_OUTCOME_FILE: join(r.dir, 'outcome.json'),
      XDG_STATE_HOME: join(r.dir, 'state'), DOCS_ROOT: r.work, PE_SCOPE: 'all',
    };
    delete (env as Record<string, string | undefined>).PE_SESSION_ID;
    const partial = spawnSync('/bin/bash', [SCRIPT, 'demo', '4', 'partial', '--reason', 'context'], { cwd: r.work, env, encoding: 'utf8' });
    assert.equal(partial.status, 0);
    assert.match(partial.stderr, /WARNING: unpushed — \. is 3 commit\(s\) ahead of origin\/pe\/demo\. Push it \(git -C .* push origin pe\/demo\)/);
    assert.equal(JSON.parse(readFileSync(env.PE_OUTCOME_FILE, 'utf8')).status, 'partial', 'the declaration is unchanged');
    const complete = spawnSync('/bin/bash', [SCRIPT, 'demo', '4', 'complete'], { cwd: r.work, env, encoding: 'utf8' });
    assert.equal(complete.status, 0);
    assert.doesNotMatch(complete.stderr, /unpushed/);
    git(r.work, 'push', '-q', 'origin', 'pe/demo');
    const pushed = spawnSync('/bin/bash', [SCRIPT, 'demo', '4', 'partial', '--reason', 'context'], { cwd: r.work, env, encoding: 'utf8' });
    assert.doesNotMatch(pushed.stderr, /unpushed/, 'nothing ahead, nothing said');
  } finally { r.cleanup(); }
});

test('WP-6 the push rule is the row’s verdict on `git push origin <branch>`, as a session’s own push gets it', () => {
  const row = 'deny by default; allow `Bash(git push:*)` — the RUN BRANCH after each commit by every phase, never force, never a deleted remote ref';
  assert.equal(manifestVerdict('git push origin pe/demo', row, { runBranch: 'pe/demo', phase: 4 }).answer, 'allow');
  assert.notEqual(manifestVerdict('git push origin main', row, { runBranch: 'pe/demo', phase: 4 }).answer, 'allow');
  assert.notEqual(manifestVerdict('git push origin pe/demo', 'deny — no phase pushes anything', { runBranch: 'pe/demo', phase: 4 }).answer, 'allow');
});

test('WP-7 a phase’s unpushed work is a heads-up on Your turn until a push lands', async () => {
  const { unpushedHeadsUp } = await import('../server/service.ts');
  const state = {
    slug: 'demo', phases: {
      3: { status: 'pending', unpushed: { at: 'x', trees: [{ repo: 'phased-execution', branch: 'pe/demo', ahead: 2, tracked: true }] } },
      4: { status: 'done' },
    },
  } as unknown as RunState;
  assert.deepEqual(unpushedHeadsUp(state), [{
    slug: 'demo', id: 'unpushed-p3',
    what: 'Phase 3 left unpushed work in its checkout: 2 commits on pe/demo in phased-execution — not on origin until a push lands',
  }]);
  assert.deepEqual(unpushedHeadsUp(null), []);
});
