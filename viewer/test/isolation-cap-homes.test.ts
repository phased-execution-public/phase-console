/**
 * The isolation cap counts dead-run trees under BOTH worktree homes.
 *
 * `isolatedCheckouts` (service-base.ts, the runner's cap probe) counts the
 * checkouts of runs nothing is driving — a `running` file whose console was
 * killed, a kept dirty tree — because each is a full checkout on disk and the
 * cap exists to bound those (G7). Its readdir used to walk only the state
 * directory's `<slug>/worktrees/`; under the default `worktreeRoot: project`
 * every new tree stands under `<root>/.worktrees/runs/<slug>/`, so an orphan
 * there counted as a free slot and the cap admitted a full set of runs on top
 * of it (code review of the project-root change, finding 2).
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { consoleRunsDir } = await import('../server/runner/state.ts');
const { worktreeHome } = await import('../server/runner/worktree.ts');
const SCRIPTS = join(SKILL_DIR, 'scripts');

type Probe = { deps: { isolatedCheckouts?: (excludingRunId?: string) => number } };

test('the cap probe counts orphaned trees under the project home AND the state home, each run once', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-cap-homes-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    copyFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'linear.md'), join(root, 'docs', 'plans', 'demo.md'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '-A'], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });

    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
      scriptsDir: SCRIPTS, logFile: null, converge: false,
    } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    try {
      assert.equal(svc.open(root).ok, true);
      const probe = (svc as unknown as { makeRunner(): Probe }).makeRunner().deps.isolatedCheckouts!;
      assert.equal(probe(), 0, 'nothing on disk, nothing to count');

      const consoleDir = consoleRunsDir(root);
      const stateDir = join(consoleDir, 'demo');
      const project = worktreeHome({ mode: 'project', root, slug: 'demo', stateDir });
      const legacy = worktreeHome({ mode: 'state', root, slug: 'demo', stateDir });
      // A dead run's tree under the NEW home, one under the OLD, and a run
      // whose tree the operator moved by hand so it stands in both.
      mkdirSync(join(project, 'dead-a', 'integration'), { recursive: true });
      mkdirSync(join(legacy, 'dead-b', 'integration'), { recursive: true });
      mkdirSync(join(project, 'dead-c', 'p2'), { recursive: true });
      mkdirSync(join(legacy, 'dead-c', 'integration'), { recursive: true });

      assert.equal(probe(), 3, 'dead-a (project), dead-b (state), dead-c (both, once)');
      assert.equal(probe('dead-a'), 2, 'the run asking is never counted against itself');
      // A plan that only ever stood under the project home is found too —
      // its slug has no state directory to enumerate.
      mkdirSync(join(worktreeHome({ mode: 'project', root, slug: 'other', stateDir: join(consoleDir, 'other') }), 'dead-d', 'integration'), { recursive: true });
      assert.equal(probe(), 4);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
