/**
 * AJ-4..5 (control-tower phase 107, #186) — a push the plan's row allows is
 * never left on a person's card because of the shape around it.
 *
 * ai-builder-v7's row allows "every phase — `git push` of `pe/ai-builder-v7`
 * as a backup". A phase ran that push beside a read-only `$( … )` and a `$?`,
 * and the judge — which refused any substitution — raised a person's card
 * with an hour on its clock. A watchdog freed it by denying it with a reason
 * ("re-run the push as one bare command"), and the session went on in
 * seconds. It happened again on a fresh session, then for a bare `git push`,
 * then six times in one day for `git add && git commit && git push`.
 *
 * AJ-4  A read-only `$( … )` (the neighbours' own read-only roster, applied
 *       inside it), a `$?` read and an `rc=$?` assignment beside a push the
 *       row names are vouched for: #186's shapes, verbatim, answered `allow`.
 * AJ-5  Anything else around a push the row would answer bare is answered AT
 *       ONCE: a `deny` naming the bare form to re-run alone — `git add`,
 *       `git commit`, a `$( … )` that writes, a computed branch, a bare
 *       `git push`. No card is raised, and no automatic actor — the timeout
 *       included — leaves such a call on one: a card raised before the row
 *       named the branch resolves `deny` by `manifest`, naming the bare form,
 *       and nothing parks.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-push-shape-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-push-shape-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { POLICY_PATH } = await import('../server/runner/approvals.ts');
const { manifestVerdict, readOnlyCommand } = await import('../server/runner/manifest-verdict.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

/** ai-builder-v7's row, verbatim from #205. */
const AB7_ROW = 'deny, with these allow rows: Phase 1 — `gh label create`, `gh issue create`; Phases 4/17/22 — `gh pr create`, `gh pr merge --squash --delete-branch`, `gh issue close`, `gh issue comment`, the direct pathspec pushes …; every phase — `git push` of `pe/ai-builder-v7` as a backup …';
const BARE = 'git push origin pe/ai-builder-v7';

const manifestOf = (value: string) => ({
  decisions: [{ key: 'permission.destructive', state: 'answered', source: 'plan', value }],
});

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

const CARVED = { gitMode: 'new-branch', openPr: true };

function serviceOn(run: Record<string, unknown>) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const parked: string[] = [];
  const state = { id: 'r1', slug: 'ai-builder-v7', activePhase: 3, permissionProfile: 'guarded', ...run };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('ai-builder-v7', {
    isSpending: () => false,
    busy: () => true,
    current: () => state,
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    park: (reason: string) => { parked.push(reason); },
    enterPersonWait: () => {},
    leavePersonWait: () => {},
  });
  return { service, noted, parked, state };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

function reply(out: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
}

function autoGrantOff(): () => void {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  return () => rmSync(POLICY_PATH, { force: true });
}

test('AJ-4 (#186): a read-only $( … ), a $? read and rc=$? beside a push the row names are vouched — #186\'s shapes, verbatim, answered allow with no card', async () => {
  const restore = autoGrantOff();
  const { service, noted, parked } = serviceOn({ ...CARVED, manifest: manifestOf(AB7_ROW) });
  try {
    const shapes = [
      // card muqz8grg-4, P3 attempt 2
      'git rev-parse --abbrev-ref HEAD && git push -u origin pe/ai-builder-v7 > /tmp/p3x/push.log 2>&1; echo "PUSH_EXIT=$?"; grep -c rejected /tmp/p3x/push.log | head -10; echo "remote: $(git ls-remote origin refs/heads/pe/ai-builder-v7 | cut -c1-8)"',
      // card mur3yie9-10, P4 attempt 3
      'git push -u origin pe/ai-builder-v7 > /tmp/p4x/tf-push.log 2>&1; rc=$?; echo "rc=$rc"; echo "$(git ls-remote origin refs/heads/pe/ai-builder-v7)"',
      // the issue's reproduction
      'git push -u origin pe/ai-builder-v7 > log 2>&1; echo "EXIT=$?"; echo "$(git ls-remote origin refs/heads/pe/ai-builder-v7)"',
    ];
    for (const command of shapes) {
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'allow', `vouched for: ${command}\n${answer.permissionDecisionReason}`);
    }
    assert.equal(service.approvals.pending().length, 0, 'no card for a push the plan answered');
    const grants = noted.filter((n) => n.event === 'phase.approval-auto-granted');
    assert.equal(grants.length, shapes.length, 'each answered from the manifest, journalled');
    for (const grant of grants) {
      assert.equal((grant.data.exception as { branch?: string }).branch, 'pe/ai-builder-v7');
    }
    assert.deepEqual(parked, []);
  } finally {
    service.approvals.disarm();
    service.close();
    restore();
  }

  // The roster, inside a substitution as beside the push.
  for (const words of [['git', 'ls-remote', 'origin'], ['cut', '-c1-8'], ['git', '-C', 'sub', 'rev-parse', 'HEAD'], ['git', 'branch', '--show-current']]) {
    assert.ok(readOnlyCommand(words), `${words.join(' ')} only reads`);
  }
  for (const words of [['touch', 'x'], ['git', 'commit', '-m', 'x'], ['git', 'branch', '-D', 'x'], ['rm', '-f', 'x']]) {
    assert.ok(!readOnlyCommand(words), `${words.join(' ')} writes`);
  }
});

test('AJ-5 (#186): anything else around a push the row would answer bare is a deny AT ONCE naming the bare form — no card, and the timeout never leaves one on a person', async () => {
  const restore = autoGrantOff();
  const { service, noted, parked, state } = serviceOn({ ...CARVED, manifest: manifestOf(AB7_ROW) });
  try {
    const shapes: [string, RegExp, string][] = [
      ['git add -A && git commit -m "fix" && git push origin pe/ai-builder-v7', /git add/, BARE],
      ['ruff check . && pytest -q && git add -A && git commit -m "p9" && git push origin pe/ai-builder-v7', /ruff|pytest|git add/, BARE],
      ['git push', /names no branch/, BARE],
      ['git push -u', /names no branch/, 'git push -u origin pe/ai-builder-v7'],
      ['git push origin pe/ai-builder-v7 && echo "$(touch stamp)"', /\$\( … \).*touch/, BARE],
      ['git push origin "$BRANCH"', /computes/, BARE],
      ['git push origin HEAD', /HEAD/, BARE],
    ];
    for (const [command, why, bare] of shapes) {
      const started = Date.now();
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.ok(Date.now() - started < 5_000, 'answered at once, not on a clock');
      assert.equal(answer.permissionDecision, 'deny', command);
      assert.match(answer.permissionDecisionReason, why, `${command}: ${answer.permissionDecisionReason}`);
      assert.ok(answer.permissionDecisionReason.includes(`Re-run \`${bare}\` alone, then read its result in a separate call`),
        `the bare form to re-run: ${answer.permissionDecisionReason}`);
      assert.match(answer.permissionDecisionReason, /not a person rejecting your work/);
    }
    assert.equal(service.approvals.pending().length, 0, 'no card left for anyone, the timeout included');
    const reshaped = noted.filter((n) => n.event === 'phase.approval-reshaped');
    assert.equal(reshaped.length, shapes.length, 'each journalled');
    assert.deepEqual(reshaped.map((n) => n.data.bareForm), shapes.map(([, , bare]) => bare));
    assert.ok(reshaped.every((n) => n.phase === 3 && n.data.rule === 'Bash(git push:*)'));
    assert.deepEqual(parked, [], 'nothing parks');

    // A card raised while the row named no branch, then the row is amended
    // and nobody comes: the timeout's deny becomes the plan's, naming the
    // bare form — never a park on a person for a manifest-allowable act.
    (state as { manifest: unknown }).manifest = manifestOf('deny; may publish: nothing yet');
    const command = 'git add -A && git commit -m "late" && git push origin pe/ai-builder-v7';
    const hook = service.decideToolUse(bash(command), 'r1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const card = service.approvals.pending()[0];
    assert.ok(card, 'raised while the row named no branch');
    assert.equal(card.manifest?.answer, null);
    (state as { manifest: unknown }).manifest = manifestOf(AB7_ROW);
    service.approvals.settle(card.id, 'deny', 'timeout', 'nobody answered');
    const answer = reply(await hook);
    assert.equal(answer.permissionDecision, 'deny');
    assert.match(answer.permissionDecisionReason, /^not approved \(manifest\)/, answer.permissionDecisionReason);
    assert.ok(answer.permissionDecisionReason.includes(`Re-run \`${BARE}\` alone`));
    const settled = service.approvals.recent().find((a) => a.id === card.id);
    assert.equal(settled?.decidedBy, 'manifest', 'the plan answered, not the clock');
    assert.equal(settled?.manifest?.answer, 'deny');
    assert.equal(settled?.manifest?.bareForm, BARE);
    assert.deepEqual(parked, [], 'and the run is not parked');
  } finally {
    service.approvals.disarm();
    service.close();
    restore();
  }

  // What stays a person's: the row does not cover the act in ANY form.
  for (const command of ['git push origin main', 'git push origin other-branch', 'git push origin +pe/ai-builder-v7']) {
    assert.equal(manifestVerdict(command, AB7_ROW, { phase: 3 }).answer, null, `a card: ${command}`);
  }
});
