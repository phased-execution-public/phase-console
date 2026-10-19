/**
 * MV-1..7 (one-pool phase 2, #276) — a `git push` the row allows as a WHOLE
 * rule is still judged by the push reader, so the trunk check runs on every
 * push verdict.
 *
 * Until 8.0 an entry naming `Bash(git push:*)` itself took the whole-rule
 * path in `manifestVerdict`, which never reached `judgePush`: a row allowing
 * pushes "of the run branch" auto-allowed `git push origin main` in every
 * phase, and a force push and a bare push with it. Most plans' rows (this
 * plan's own included) are of that shape.
 *
 * MV-1  The issue's repro: a branch-scoped whole rule answers `git push origin
 *       main` as a person's card in every phase, and pushes the branch it names.
 * MV-2  issues-sweep-hub-tb-hz's row (quoted in #250's test): the same.
 * MV-3  This plan's own row (one-pool `permission.destructive`): the trunk is
 *       answered only in the phases the row names `main` for — 34, 35, 37, 38 —
 *       and the run branch in every phase.
 * MV-4  A whole rule in a row that names no branch answers any branch but a
 *       trunk or the run's base branch, in a shape the push reader covers: a
 *       force, a delete, `--no-verify`, another remote are a person's card; a
 *       bare push is `deny`, naming the run branch to push alone.
 * MV-5  The run's base branch is a trunk too.
 * MV-6  A trunk is answered only by a clause that NAMES it with its phases —
 *       never one written without phases, never one behind a refusal.
 * MV-7  The verdict table this phase's handoff records.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { destructiveTrunkPushes } from '../shared/policy-model.js';
import { manifestVerdict } from '../server/runner/manifest-verdict.ts';

/** This plan's own row, verbatim from `docs/plans/one-pool.md` §Decisions (2026-10-17) — its repository names as placeholders (scrub). */
const ONE_POOL_ROW = 'deny by default; allow `Bash(git push:*)` — the RUN BRANCH after each commit by every phase, `main` by phase 34 (and the site\'s `main` by 37, the tap\'s `main` by 35 and 38), never force, never a deleted remote ref; `Bash(gh release create:*)` phase 34 only; `Bash(gh label create:*)`, `Bash(gh issue edit:*)`, `Bash(gh issue comment:*)` and `Bash(gh issue close:*)` on `example-org/console`, `example-org/docs-root` and `example-org/site` only — labels and the planning comment by phase 1, closures by the fixing phases §Architecture 9 names at their finish and by phase 34 as the backstop; `Bash(npm publish:*)` and `Bash(npm stage publish:*)` phase 35 only, through `scripts/publish-pro.sh`, once for 8.0.0; `Bash(brew install:*)` / `Bash(brew uninstall:*)` of `example/tap/example-console` phases 35 and 38 only (a smoke that leaves nothing behind); `Bash(npm install -g:*)` ONLY into a temp `--prefix`, phases 35 and 38; `Bash(vercel:*)` phase 37 only (the production deployment of the site); `Bash(gh release upload:*)` phase 37 only, with `--clobber`, after phase 34 — if the Release asset\'s `.build-rev` is not the tag\'s commit (#358\'s shape). No phase runs `npm unpublish`, `npm deprecate`, `npm owner`, `gh issue create` by hand, `chmod` outside the run\'s trees, or deletes a tap formula. Nothing in this row names an approval, a policy edit, a permission profile or a gate.';

/** issues-sweep-hub-tb-hz's row, verbatim (#250's test). */
const SWEEP_ROW = 'deny; allow `git push` of `pe/issues-sweep-hub-tb-hz`, of an annotated `archive/*` tag and (Phase 21) of the SDK tag and the release-please branch, always as `git -C <absolute repo path> push origin <branch>` alone in its call; allow `gh pr create`, `gh pr merge --squash --delete-branch` and `gh pr close --delete-branch` in the release phases and in Phases 13, 15, 16, 21, 33, 40 and 41; allow `gh issue edit`, `gh issue comment`, `gh issue close` and `gh label create` on the ten repos; never force-push, never move a tag';

const RUN = 'pe/one-pool';
const PHASES = Array.from({ length: 41 }, (_, i) => i + 1);

test('MV-1 (#276): a whole `Bash(git push:*)` rule scoped to one branch never answers a push of the trunk — in any phase', () => {
  const row = 'deny by default; allow `Bash(git push:*)` of `pe/x`';
  for (const phase of PHASES) {
    const main = manifestVerdict('git push origin main', row, { phase });
    assert.notEqual(main.answer, 'allow', `phase ${phase}: ${main.why}`);
    assert.match(main.why, /trunk/, `phase ${phase}: the card says why`);
  }
  assert.equal(manifestVerdict('git push origin master', row, { phase: 2 }).answer, null);
  assert.equal(manifestVerdict('git push origin pe/x', row, { phase: 2 }).answer, 'allow', 'the branch it names');
  assert.equal(manifestVerdict('git push origin pe/y', row, { phase: 2 }).answer, null, 'a branch it does not name');
  assert.equal(manifestVerdict('git push origin pe/x:main', row, { phase: 2 }).answer, null, 'a refspec onto the trunk');
});

test('MV-2 (#276): issues-sweep-hub-tb-hz\'s row — `git push origin main` is a person\'s card in every phase', () => {
  for (const phase of PHASES) {
    assert.equal(manifestVerdict('git push origin main', SWEEP_ROW, { phase }).answer, null, `phase ${phase}`);
    assert.equal(manifestVerdict('git push origin pe/issues-sweep-hub-tb-hz', SWEEP_ROW, { phase }).answer, 'allow', `phase ${phase}`);
  }
});

test('MV-3 (#276): this plan\'s own row — the trunk only in the phases it names `main` for; the run branch in every phase', () => {
  const named = [34, 35, 37, 38];
  for (const phase of PHASES) {
    const main = manifestVerdict('git push origin main', ONE_POOL_ROW, { phase, runBranch: RUN });
    if (named.includes(phase)) assert.equal(main.answer, 'allow', `phase ${phase}: ${main.why}`);
    else assert.equal(main.answer, null, `phase ${phase}: ${main.why}`);
    assert.equal(manifestVerdict(`git push origin ${RUN}`, ONE_POOL_ROW, { phase, runBranch: RUN }).answer, 'allow', `phase ${phase}`);
    assert.equal(manifestVerdict(`git push -u origin ${RUN}`, ONE_POOL_ROW, { phase, runBranch: RUN }).answer, 'allow', `phase ${phase}`);
  }
  assert.match(manifestVerdict('git push origin main', ONE_POOL_ROW, { phase: 34, runBranch: RUN }).why, /main.*phase 34/);
  assert.deepEqual(destructiveTrunkPushes(ONE_POOL_ROW, { phase: 34 }), ['main']);
  assert.deepEqual(destructiveTrunkPushes(ONE_POOL_ROW, { phase: 2 }), []);
  assert.deepEqual(destructiveTrunkPushes(ONE_POOL_ROW, {}), [], 'no phase known, no trunk read');
});

test('MV-4 (#276): a whole rule that names no branch answers any branch but a trunk, in a shape the push reader covers', () => {
  const ours = 'deny by default; allow `Bash(git push:*)`, `Bash(gh pr create:*)`';
  const v = (command: string) => manifestVerdict(command, ours, { phase: 9, runBranch: RUN });
  assert.equal(v(`git push origin ${RUN}`).answer, 'allow');
  assert.equal(v('git push origin feature/other').answer, 'allow', 'any branch that is not a trunk, as TRS-4 read the whole rule');
  assert.equal(v('git push origin main').answer, null);
  assert.equal(v('git push origin HEAD:main').answer, null, 'a refspec onto the trunk');
  assert.equal(v('git push origin refs/heads/master').answer, null);
  assert.equal(v(`git push --force origin ${RUN}`).answer, null, 'a force push');
  assert.equal(v(`git push origin +${RUN}`).answer, null, 'a `+` refspec');
  assert.equal(v(`git push origin :${RUN}`).answer, null, 'a delete');
  assert.equal(v(`git push --no-verify origin ${RUN}`).answer, null, 'skipping the hook');
  assert.equal(v(`git push upstream ${RUN}`).answer, null, 'another remote');
  const bare = v('git add -A && git commit -m x && git push');
  assert.equal(bare.answer, 'deny', 'a bare push goes wherever the upstream points — the trunk included');
  assert.equal(bare.bareForm, `git push origin ${RUN}`);
  assert.equal(v('gh pr create --fill').answer, 'allow', 'the other whole rule is unchanged');
});

test('MV-5 (#276): the run\'s base branch is a trunk', () => {
  const ours = 'deny by default; allow `Bash(git push:*)`';
  assert.equal(manifestVerdict('git push origin develop', ours, { phase: 3, baseBranch: 'develop' }).answer, null);
  assert.equal(manifestVerdict('git push origin develop', ours, { phase: 3 }).answer, 'allow', 'no base named, an ordinary branch');
  const named = 'deny; allow `Bash(git push:*)`, `develop` in phase 3';
  assert.equal(manifestVerdict('git push origin develop', named, { phase: 3, baseBranch: 'develop' }).answer, 'allow');
  assert.equal(manifestVerdict('git push origin develop', named, { phase: 4, baseBranch: 'develop' }).answer, null);
});

test('MV-6 (#276): a trunk is answered only by a clause that names it with its phases, never behind a refusal', () => {
  assert.deepEqual(destructiveTrunkPushes('deny; push `main` in phases 35 and 144', { phase: 35 }), ['main']);
  assert.deepEqual(destructiveTrunkPushes('deny; push `main` in phases 35 and 144', { phase: 36 }), []);
  for (const refusal of [
    'deny; allow `Bash(git push:*)`; may push to `main` + `master`',
    'deny; never push `main` in phase 3',
    'deny pushes to `main` in phase 3',
    'deny; allow `Bash(git push:*)` — never `main` in phase 3',
    'deny; allow `gh pr merge` into `main` in phase 3',
    '',
  ]) {
    assert.deepEqual(destructiveTrunkPushes(refusal, { phase: 3 }), [], refusal);
    assert.equal(manifestVerdict('git push origin main', refusal, { phase: 3 }).answer, null, refusal);
  }
});

test('MV-7: the verdict table for this plan\'s own row, before and after (#276)', () => {
  // Before (7.1.0): `allow` for every command below in every phase — the whole-rule path.
  const table = {
    'git push origin pe/one-pool': ['allow', 'allow', 'allow'],
    'git push origin main': [null, 'allow', null],
    'git push --force origin pe/one-pool': [null, null, null],
    'git push': ['deny', 'deny', 'deny'],
  } as const;
  for (const [command, [two, thirtyFour, thirtySix]] of Object.entries(table)) {
    for (const [phase, want] of [[2, two], [34, thirtyFour], [36, thirtySix]] as const) {
      assert.equal(manifestVerdict(command, ONE_POOL_ROW, { phase, runBranch: RUN }).answer, want, `${command} in phase ${phase}`);
    }
  }
});
