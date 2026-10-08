/**
 * AP-1..5 (control-tower phase 84, #112) — a push the plan's
 * `permission.destructive` row already answered is answered FROM THE ROW.
 *
 * vca-refactor's row said, in writing, that the run may push its branch. The
 * console still raised a person-only card for exactly that push, and after an
 * hour decided it itself — `deny`, by the timeout — and parked the run until a
 * Recover press, 3 h 40 min later. The row was prose the exception reader
 * could not see (`destructiveExceptions` reads only `allow \`rule\`` clauses),
 * and nothing that settles a card consulted the manifest at all.
 *
 * AP-1  A plain push to a branch the row names is answered `allow` from the
 *       manifest — with auto-grant OFF too — journalled with the row, announced.
 * AP-2  The same inside a compound command: redirects, `echo $?`, and
 *       read-only `grep` / `git status` / `git stash list` tails beside it.
 * AP-3  A force push, another branch, a refspec to `main`: a person's card,
 *       which names the row it was checked against and why it did not match.
 *       A push the row names, in a shape it cannot answer as it stands — a
 *       neighbour that writes, a branch the shell computes, a bare push — is
 *       refused AT ONCE naming the bare form (control-tower phase 107, #186).
 * AP-4  No automatic actor — `by: timeout` included — decides `deny` on a card
 *       the manifest answers: the card resolves to the manifest's answer and
 *       the run is not parked. A person's deny still stands.
 * AP-5  The grammar: which branches a row names, and which command shapes a
 *       named branch covers — narrowly, because reading a refusal as a
 *       permission is the one mistake that matters.
 * AJ-6  (control-tower phase 107, #205) A command the row names for the
 *       RUNNING phase — `gh pr create` in a `Phases 4/17/22 —` list — is
 *       auto-granted from the manifest and announced, naming the row and the
 *       phase; a phase the row does not name gets the card, which says which
 *       phases the row allows.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-push-manifest-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-push-manifest-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { POLICY_PATH, planPolicyPath } = await import('../server/runner/approvals.ts');
const { destructivePushBranches } = await import('../shared/policy-model.js');
const { manifestPushVerdict, manifestVerdict } = await import('../server/runner/manifest-verdict.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

/** The row vca-refactor wrote, in its shape: a `may publish:` clause naming two branches, and a trunk for another repository. */
const VCA_ROW = 'deny; **may publish: branch pushes to `pe/vca-refactor`** + `fix/vca-backend-gaps`, hub `main` pathspec pushes, `gh pr create --draft` for review';

const manifestOf = (value: string) => ({
  decisions: [{ key: 'permission.destructive', state: 'answered', source: 'plan', value }],
});

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

function serviceOn(run: Record<string, unknown>) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const parked: string[] = [];
  const state = { id: 'r1', slug: 'vca-refactor', activePhase: 17, permissionProfile: 'guarded', ...run };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('vca-refactor', {
    isSpending: () => false,
    busy: () => true,
    current: () => state,
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    park: (reason: string) => { parked.push(reason); },
    enterPersonWait: () => {},
    leavePersonWait: () => {},
  });
  const events: { name: string; data: unknown }[] = [];
  service.onEvent((name: string, data: unknown) => events.push({ name, data }));
  return { service, noted, events, parked, state };
}

function reply(out: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

/** The carve-out that makes `git push` a person's tap — the shape #112 was raised under. */
const CARVED = { gitMode: 'new-branch', openPr: true };

function autoGrantOff(): () => void {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  return () => rmSync(POLICY_PATH, { force: true });
}

async function stillAsking(service: InstanceType<typeof Service>, command: string): Promise<boolean> {
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(bash(command), 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 150).unref(); }),
  ]);
  return outcome === pending;
}

test('AP-1 (#112): a push to a branch the row names is answered allow FROM THE MANIFEST — auto-grant off, no card, journalled with the row, announced once', async () => {
  const restore = autoGrantOff();
  const { service, noted, events } = serviceOn({ ...CARVED, manifest: manifestOf(VCA_ROW) });
  try {
    const answer = reply(await service.decideToolUse(bash('git push origin pe/vca-refactor'), 'r1'));
    assert.equal(answer.permissionDecision, 'allow', 'the plan answered this in writing');
    assert.match(answer.permissionDecisionReason, /permission\.destructive/);
    assert.equal(service.approvals.pending().length, 0, 'no card waits on a question the plan answered');

    const granted = noted.find((n) => n.event === 'phase.approval-auto-granted');
    assert.ok(granted, 'the durable record is the journal');
    assert.equal(granted.data.answeredBy, 'permission.destructive');
    const exception = granted.data.exception as { rule: string; value: string; source: string; branch?: string; why: string };
    assert.equal(exception.rule, 'Bash(git push:*)');
    assert.equal(exception.branch, 'pe/vca-refactor');
    assert.equal(exception.source, 'plan');
    assert.match(exception.value, /may publish/, 'the row it was answered from, as read');

    const card = service.approvals.recent().at(-1);
    assert.equal(card?.status, 'allow');
    assert.equal(card?.manifest?.key, 'permission.destructive');
    assert.equal(card?.manifest?.answer, 'allow');
    const announced = events.filter((e) => e.name === 'notification'
      && (e.data as { category?: string }).category === 'approval');
    assert.equal(announced.length, 1, 'a push under the manifest is announced, once');
    assert.match(JSON.stringify(announced[0].data), /pe\/vca-refactor/, 'and the announcement names what was allowed');
  } finally {
    service.approvals.disarm();
    service.close();
    restore();
  }
});

test('AP-2 (#112): the same push inside a compound command — redirects, echo $?, read-only tails — is answered from the manifest', async () => {
  const { service, noted } = serviceOn({ ...CARVED, manifest: manifestOf(VCA_ROW) });
  try {
    for (const command of [
      'git push origin pe/vca-refactor > /tmp/vca-refactor/p17/s5-push.log 2>&1; echo "PUSH_EXIT=$?"; grep -c rejected /tmp/vca-refactor/p17/s5-push.log; git status -sb | head -1; git stash list | head -3',
      'git push -u origin fix/vca-backend-gaps && git log --oneline -1',
      'git push origin HEAD:pe/vca-refactor 2>&1 | tail -5',
      'git push origin pe/vca-refactor 2>/dev/null || echo "push failed"',
    ]) {
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'allow', `answered from the row: ${command}`);
    }
    assert.equal(service.approvals.pending().length, 0);
    assert.equal(noted.filter((n) => n.event === 'phase.approval-auto-granted').length, 4);
  } finally {
    service.approvals.disarm();
    service.close();
  }
});

test('AP-3 (#112, #186): a force push, another branch or a refspec to main stays a person\'s card naming the row and why; the row\'s own branch in a shape it cannot answer is refused at once, naming the bare form', async () => {
  const { service, noted } = serviceOn({ ...CARVED, manifest: manifestOf(VCA_ROW) });
  try {
    const cases: [string, RegExp][] = [
      ['git push origin +pe/vca-refactor', /force/i],
      ['git push origin some-other-branch', /some-other-branch/],
      ['git push origin pe/vca-refactor:main', /main/],
      ['git push origin main', /main/],
      ['git push origin :pe/vca-refactor', /delete/i],
    ];
    for (const [command, why] of cases) {
      assert.ok(await stillAsking(service, command), `${command} is a person's tap`);
      const card = service.approvals.pending().find((a) => (a.tool?.input as { command?: string }).command === command);
      assert.ok(card, `${command} raised a card`);
      assert.equal(card.manifest?.key, 'permission.destructive', 'the card names the row it was checked against');
      assert.equal(card.manifest?.answer, null, 'which did not answer it');
      assert.match(card.manifest?.value ?? '', /may publish/, 'the row as read');
      assert.match(card.manifest?.why ?? '', why, `and why not, for ${command}: ${card.manifest?.why}`);
    }
    // The wall's own force and delete rules answer before any card: never allowed.
    for (const command of ['git push --force origin pe/vca-refactor', 'git push origin --delete pe/vca-refactor']) {
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `${command} is walled, whatever the row names`);
    }
    // #186: the row names the branch; only the SHAPE is wrong. Answered now,
    // with the form to re-run — no card for a person, no hour for the timeout.
    const before = service.approvals.pending().length;
    const reshaped: [string, RegExp, string][] = [
      ['git push origin pe/vca-refactor && touch build/stamp', /touch/, 'git push origin pe/vca-refactor'],
      ['git push origin $(git branch --show-current)', /computes/, 'git push origin <one of: pe/vca-refactor, fix/vca-backend-gaps>'],
      ['git push', /names no branch/i, 'git push origin <one of: pe/vca-refactor, fix/vca-backend-gaps>'],
    ];
    for (const [command, why, bare] of reshaped) {
      const answer = reply(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `${command} is answered at once`);
      assert.ok(answer.permissionDecisionReason.includes(`Re-run \`${bare}\` alone`), `the bare form, for ${command}: ${answer.permissionDecisionReason}`);
      assert.match(answer.permissionDecisionReason, why);
      const line = noted.findLast((n) => n.event === 'phase.approval-reshaped');
      assert.equal(line?.data.bareForm, bare, `journalled with its bare form: ${command}`);
      assert.equal(line?.data.answeredBy, 'permission.destructive');
    }
    assert.equal(service.approvals.pending().length, before, 'no card was raised for a reshape');
  } finally {
    service.approvals.disarm();
    service.close();
  }
});

test('AP-4 (#112): no automatic actor decides deny on a card the manifest answers — the timeout resolves to the manifest\'s answer and nothing parks; a person\'s deny stands', async () => {
  const { service, parked, state } = serviceOn({ ...CARVED, manifest: manifestOf('deny; may publish: nothing yet') });
  try {
    // Raised while the row did not name the branch…
    const hook = service.decideToolUse(bash('git push origin pe/vca-refactor'), 'r1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const card = service.approvals.pending()[0];
    assert.ok(card, 'the card is up: the row named no branch when it was raised');
    assert.equal(card.manifest?.answer, null);

    // …then the plan is amended, and nobody comes. The timeout re-reads the row.
    (state as { manifest: unknown }).manifest = manifestOf(VCA_ROW);
    service.approvals.settle(card.id, 'deny', 'timeout', 'nobody answered');
    const answer = reply(await hook);
    assert.equal(answer.permissionDecision, 'allow', 'the timeout resolves to the manifest\'s answer, never deny-and-park');
    assert.deepEqual(parked, [], 'and the run is not parked');
    const settled = service.approvals.recent().find((a) => a.id === card.id);
    assert.equal(settled?.status, 'allow');
    assert.equal(settled?.decidedBy, 'manifest');

    // A script's deny on a manifest-answered card is not a judgement either.
    const second = service.approvals.request({
      runId: 'r1', slug: 'vca-refactor', phase: 17, kind: 'tool', title: 'Bash: git push', detail: 'd', evidence: [],
      tool: { name: 'Bash', input: { command: 'git push origin fix/vca-backend-gaps' } },
    });
    service.decideApproval(second.approval.id, 'deny', 'script');
    assert.deepEqual(
      (({ decision, by }) => ({ decision, by }))(await second.decided),
      { decision: 'allow', by: 'manifest' },
    );

    // A person may still say no: the manifest is a permission, not an order.
    const third = service.approvals.request({
      runId: 'r1', slug: 'vca-refactor', phase: 17, kind: 'tool', title: 'Bash: git push', detail: 'd', evidence: [],
      tool: { name: 'Bash', input: { command: 'git push origin pe/vca-refactor' } },
    });
    service.decideApproval(third.approval.id, 'deny', 'operator');
    assert.equal((await third.decided).decision, 'deny', 'a person\'s deny stands');

    // And a card the manifest does NOT answer still times out to deny.
    const fourth = service.approvals.request({
      runId: 'r1', slug: 'vca-refactor', phase: 17, kind: 'tool', title: 'Bash: git push', detail: 'd', evidence: [],
      tool: { name: 'Bash', input: { command: 'git push --force origin pe/vca-refactor' } },
    }, 20);
    const expired = await fourth.decided;
    assert.equal(expired.decision, 'deny');
    assert.equal(expired.by, 'timeout');
  } finally {
    service.approvals.disarm();
    service.close();
  }
});

test('AP-5 (#112): the grammar — the branches a row names, and the command shapes a named branch covers', () => {
  assert.deepEqual(destructivePushBranches(VCA_ROW).sort(), ['fix/vca-backend-gaps', 'pe/vca-refactor'],
    'two named branches; the other repository\'s trunk and the gh verb are not branches this plan may push');
  const ours = 'deny by default; allow `Bash(git push:*)`, `Bash(gh pr create:*)`. **`git push` of the RUN BRANCH is used by EVERY phase** — decision 8 requires it';
  assert.deepEqual(destructivePushBranches(ours, { runBranch: 'pe/control-tower' }), ['pe/control-tower']);
  assert.deepEqual(destructivePushBranches(ours), [], 'no run branch known, none read');

  for (const refusal of [
    'deny — never push to `pe/x`',
    'deny pushes to `pe/x`',
    'deny — the wall does not allow `git push`',
    'deny; may push to `main` + `master`',
    'deny — no phase publishes',
    '',
  ]) {
    assert.deepEqual(destructivePushBranches(refusal), [], `a refusal, or a trunk, is never a permission: ${refusal}`);
  }

  const verdict = (command: string) => manifestPushVerdict(command, VCA_ROW, {});
  assert.equal(verdict('git push origin pe/vca-refactor').answer, 'allow');
  assert.equal(verdict('git push origin pe/vca-refactor').branch, 'pe/vca-refactor');
  assert.equal(verdict('git push origin refs/heads/pe/vca-refactor').answer, 'allow');
  assert.equal(verdict('git push origin pe/vca-refactor fix/vca-backend-gaps').answer, 'allow', 'two named branches in one push');
  assert.equal(verdict('git push origin pe/vca-refactor main').answer, null, 'a trunk riding along is still a trunk');
  assert.match(verdict('git push origin :pe/vca-refactor').why, /delete/i, 'an empty source deletes the branch the row names');
  assert.equal(verdict('git push origin pe/vca-refactor:').answer, 'deny', 'an empty destination names no branch — re-run it named');
  assert.equal(verdict('git push --force-with-lease origin pe/vca-refactor').answer, null);
  assert.equal(verdict('git push --no-verify origin pe/vca-refactor').answer, null, 'skipping the gate hook is not covered');
  assert.equal(verdict('git push --tags origin pe/vca-refactor').answer, null);
  // The row's branch in a shape it cannot answer: never `allow`, and never a
  // card either (#186) — `deny`, naming the push to re-run alone.
  for (const command of [
    'git push origin pe/vca-refactor; git reset --hard HEAD~3',
    'git push origin pe/vca-refactor | sh',
    'echo `git push origin pe/vca-refactor`',
  ]) {
    const answer = verdict(command);
    assert.equal(answer.answer, 'deny', `a destructive neighbour, a shell reading the push, a push in a substitution: ${command}`);
    assert.equal(answer.bareForm, 'git push origin pe/vca-refactor', command);
  }
  assert.equal(verdict('echo "$(git push origin main)"').answer, null, 'a substitution inside quotes is still a substitution');
  assert.equal(verdict('echo done').answer, null, 'no push at all is not a push the row answered');
  assert.equal(manifestPushVerdict('git push origin pe/control-tower', 'deny', { runBranch: 'pe/control-tower' }).answer, null,
    'a row that names nothing answers nothing');
});

/** ai-builder-v7's row, verbatim from #205: named commands in a phase-qualified list. */
const AB7_ROW = 'deny, with these allow rows: Phase 1 — `gh label create`, `gh issue create`; Phases 4/17/22 — `gh pr create`, `gh pr merge --squash --delete-branch`, `gh issue close`, `gh issue comment`, the direct pathspec pushes …; every phase — `git push` of `pe/ai-builder-v7` as a backup …';

test('AJ-6 (#205): a command the row names for the RUNNING phase is auto-granted from the manifest and announced, naming the row and the phase; another phase gets the card, which names the phases the row allows', async () => {
  const restore = autoGrantOff();
  const command = 'gh pr create -R acme/app-backend --base main --head pe/ai-builder-v7 --title "Release 0" --body "b"';
  const four = serviceOn({ ...CARVED, slug: 'ai-builder-v7', activePhase: 4, manifest: manifestOf(AB7_ROW) });
  try {
    const answer = reply(await four.service.decideToolUse(bash(command), 'r1'));
    assert.equal(answer.permissionDecision, 'allow', 'the row names gh pr create for phase 4');
    assert.match(answer.permissionDecisionReason, /permission\.destructive/);
    assert.equal(four.service.approvals.pending().length, 0, 'no card for what the plan answered');
    const granted = four.noted.find((n) => n.event === 'phase.approval-auto-granted');
    assert.ok(granted, 'journalled');
    assert.equal(granted.phase, 4, 'on the phase that ran it');
    assert.equal(granted.data.answeredBy, 'permission.destructive');
    const exception = granted.data.exception as { rule: string; value: string; why: string };
    assert.equal(exception.rule, 'Bash(gh pr create:*)');
    assert.match(exception.value, /Phases 4\/17\/22/, 'the row it was answered from');
    assert.match(exception.why, /`gh pr create` for phase 4/, 'naming the command and the phase');
    const announced = four.events.filter((e) => e.name === 'notification' && (e.data as { category?: string }).category === 'approval');
    assert.equal(announced.length, 1, 'and announced');
    // The sibling shape #205 also carded: a read-only wait before the create.
    const waited = reply(await four.service.decideToolUse(bash(
      'until [ "$(git ls-remote origin refs/heads/pe/ai-builder-v7)" = "abc" ]; do sleep 10; done; ' + command), 'r1'));
    assert.equal(waited.permissionDecision, 'allow', 'a wait loop before the create does not hide it');
  } finally {
    four.service.approvals.disarm();
    four.service.close();
  }

  const five = serviceOn({ ...CARVED, slug: 'ai-builder-v7', activePhase: 5, manifest: manifestOf(AB7_ROW) });
  try {
    assert.ok(await stillAsking(five.service, command), 'phase 5 is not named: a person\'s card');
    const card = five.service.approvals.pending()[0];
    assert.equal(card?.manifest?.answer, null);
    assert.match(card?.manifest?.why ?? '', /phases 4, 17, 22 — not phase 5/, `the card names the phases: ${card?.manifest?.why}`);
    assert.equal(five.noted.filter((n) => n.event === 'phase.approval-auto-granted').length, 0);
  } finally {
    five.service.approvals.disarm();
    five.service.close();
    restore();
  }
});

test('AJ-6 (#205): the grammar reads a phase-qualified list per phase — named options, a phase written in the clause, and a refusal never read as a permission', () => {
  const v = (command: string, phase: number) => manifestVerdict(command, AB7_ROW, { phase });
  assert.equal(v('gh pr merge 12 --squash --delete-branch', 17).answer, 'allow', 'the named form, in a named phase');
  assert.match(v('gh pr merge 12 --merge', 17).why, /--squash --delete-branch/, 'a merge without the named options is a card that says which');
  assert.equal(v('gh pr merge 12 --merge', 17).answer, null);
  assert.equal(v('gh pr create --title x', 22).answer, 'allow');
  assert.equal(v('gh pr create --title x', 1).answer, null, 'phase 1 names other commands');
  assert.equal(v('git push origin pe/ai-builder-v7', 9).answer, 'allow', 'every phase — the backup push');
  assert.equal(v('git push origin main', 4).answer, null, 'a trunk is never read from a list');
  // A list does not run on into a clause that refuses.
  const refusing = 'deny, with these allow rows: Phases 4/17 — `gh pr create`; Phase 9 — never `gh pr merge`';
  assert.equal(manifestVerdict('gh pr merge 3 --squash', refusing, { phase: 9 }).answer, null);
  // The run's own row (classic `allow`, no phases) answers every phase, as it always did.
  const ours = 'deny by default; allow `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh release create:*)`';
  assert.equal(manifestVerdict('gh pr create --fill', ours, { phase: 107 }).answer, 'allow');
  assert.equal(manifestVerdict('git add -A && git commit -m x && git push', ours, { phase: 107 }).answer, 'allow',
    'a whole `Bash(git push:*)` rule answers any push, as TRS-4 always did');
});

test('AJ-6 (#205): the row answers the publishing act ALONE — a command beside it is judged as if it ran alone; a named form is that form; a remote is a name', async () => {
  const restore = autoGrantOff();
  // A guarded run: `npm install` is on the ask list, so it never rides a named
  // `gh pr create` past it — answered at once, naming the bare form.
  const guarded = serviceOn({ ...CARVED, slug: 'ai-builder-v7', activePhase: 4, manifest: manifestOf(AB7_ROW) });
  try {
    const answer = reply(await guarded.service.decideToolUse(bash('gh pr create --fill && npm install left-pad'), 'r1'));
    assert.equal(answer.permissionDecision, 'deny', answer.permissionDecisionReason);
    assert.match(answer.permissionDecisionReason, /asks about on its own: npm install left-pad/);
    assert.ok(answer.permissionDecisionReason.includes('Re-run `gh pr create --fill` alone'), answer.permissionDecisionReason);
    assert.equal(guarded.service.approvals.pending().length, 0, 'answered at once, no card');
    // The read-only roster rides along as it always did.
    const read = reply(await guarded.service.decideToolUse(bash('cd backend && gh pr create --fill 2>&1 | tail -3'), 'r1'));
    assert.equal(read.permissionDecision, 'allow', read.permissionDecisionReason);
  } finally {
    guarded.service.approvals.disarm();
    guarded.service.close();
  }
  // A trusted run with a whole `Bash(git push:*)` rule (this plan's own row):
  // `git add` and `git commit` are allowed on their own there, so the
  // compound push is answered as before.
  const ours = 'deny by default; allow `Bash(git push:*)`, `Bash(gh pr create:*)`';
  const trusted = serviceOn({ ...CARVED, slug: 'ai-builder-v7', activePhase: 9, permissionProfile: 'trusted', manifest: manifestOf(ours) });
  try {
    const answer = reply(await trusted.service.decideToolUse(bash('git add -A && git commit -m "wip" && git push origin pe/ai-builder-v7'), 'r1'));
    assert.equal(answer.permissionDecision, 'allow', answer.permissionDecisionReason);
  } finally {
    trusted.service.approvals.disarm();
    trusted.service.close();
    restore();
  }

  const v = (command: string, phase: number) => manifestVerdict(command, AB7_ROW, { phase });
  // A named form is that form: an option it does not name is a person's card.
  assert.equal(v('gh pr merge 12 --squash --delete-branch --admin', 17).answer, null);
  assert.match(v('gh pr merge 12 --squash --delete-branch --admin', 17).why, /also carries --admin/);
  assert.equal(v('gh pr merge 12 --squash --delete-branch -R acme/app --subject "Release 0"', 17).answer, 'allow',
    'options that only parameterise it are its own');
  // The row answers a push to the checkout's origin — never a URL, a path
  // (`.` and `..` are paths) or another remote.
  for (const command of ['git push https://example.invalid/r.git pe/ai-builder-v7', 'git push ../elsewhere pe/ai-builder-v7',
    'git push git@example.invalid:r.git pe/ai-builder-v7', 'git push .. pe/ai-builder-v7', 'git push . pe/ai-builder-v7']) {
    assert.equal(v(command, 3).answer, null, command);
    assert.match(v(command, 3).why, /a URL or a path/, command);
  }
  assert.equal(v('git push upstream pe/ai-builder-v7', 3).answer, null, 'another remote is a person\'s call');
  assert.match(v('git push upstream pe/ai-builder-v7', 3).why, /the remote upstream/);
  // What runs is what the row answered: an environment or git's own options in
  // front of the verb change it (an ssh command, a remote URL, a host) — a
  // person's call, whatever the row names.
  for (const [command, why] of [
    ['GIT_SSH_COMMAND="ssh -i k" git push origin pe/ai-builder-v7', /GIT_SSH_COMMAND/],
    ['env GIT_SSH_COMMAND=x git push origin pe/ai-builder-v7', /GIT_SSH_COMMAND|env/],
    ['git -c remote.origin.url=https://example.invalid/r.git push origin pe/ai-builder-v7', /git's own `-c`/],
    ['GH_HOST=example.invalid gh pr create --fill', /GH_HOST/],
  ] as [string, RegExp][]) {
    assert.equal(v(command, 4).answer, null, command);
    assert.match(v(command, 4).why, why, command);
  }
  assert.equal(v('git -C sub --no-pager push origin pe/ai-builder-v7', 3).answer, 'allow', 'where it runs is not what it does');
  // A line that changes what its publishing command runs is answered with the bare form.
  for (const [command, bare] of [
    ['PATH=/tmp/x:$PATH; git push origin pe/ai-builder-v7', 'git push origin pe/ai-builder-v7'],
    ['export GH_HOST=example.invalid; gh pr create --fill', 'gh pr create --fill'],
    ['git() { echo; }; git push origin pe/ai-builder-v7', 'git push origin pe/ai-builder-v7'],
    ['gh pr create --fill; PUSH="git push origin main"; eval "$PUSH"', 'gh pr create --fill'],
  ] as [string, string][]) {
    const answer = v(command, 4);
    assert.equal(answer.answer, 'deny', `${command}: ${answer.why}`);
    assert.equal(answer.bareForm, bare, command);
  }
  // What the verdict hands the caller to judge.
  assert.deepEqual(manifestVerdict('gh pr create --fill && npm install left-pad', AB7_ROW, { phase: 4 }).companions, ['npm install left-pad']);
  assert.equal(manifestVerdict('gh pr create --title "x y"', AB7_ROW, { phase: 4 }).companions, undefined, 'nothing beside it');
});

test('AJ-7 (issues-sweep-hub-tb-hz Phase 30, 2026-10-06): `gh pr create` in a release phase is answered from the row once the plan\'s release phases are known — unresolved, the card names the numbered phases alone', () => {
  const row = 'deny; allow `git push` of `pe/issues-sweep-hub-tb-hz`, of an annotated `archive/*` tag and (Phase 21) of the SDK tag and the release-please branch, always as `git -C <absolute repo path> push origin <branch>` alone in its call; allow `gh pr create`, `gh pr merge --squash --delete-branch` and `gh pr close --delete-branch` in the release phases and in Phases 13, 15, 16, 21, 33, 40 and 41; allow `gh issue edit`, `gh issue comment`, `gh issue close` and `gh label create` on the ten repos; never force-push, never move a tag';
  // Phase 30's own call (card muw61u0u-13, 04:16Z), and the merge the same row names.
  const create = 'gh pr create -R example-org/infra --head pe/issues-sweep-hub-tb-hz --base main --title "fix: sweep release b1 - aws pin 90623843, register-lint at the pin, pin-bot cadence" --body-file /tmp/p30/hz-pr-body.md';
  const merge = 'gh pr merge 256 -R example-org/infra --squash --delete-branch --subject "fix: sweep release b1"';
  const releasePhases = [19, 20, 23, 30, 31, 32, 38, 39];
  const resolved = manifestVerdict(create, row, { phase: 30, releasePhases });
  assert.equal(resolved.answer, 'allow', resolved.why);
  assert.match(resolved.why, /for phase 30 \(a release phase\)/, 'the journal line says how the phase qualified');
  assert.equal(manifestVerdict(merge, row, { phase: 31, releasePhases }).answer, 'allow');
  assert.equal(manifestVerdict(merge, row, { phase: 33, releasePhases }).answer, 'allow', 'a numbered phase, as before');
  assert.equal(manifestVerdict(create, row, { phase: 5, releasePhases }).answer, null, 'a build phase is a person\'s card');
  const unresolved = manifestVerdict(create, row, { phase: 30 });
  assert.equal(unresolved.answer, null, 'the plan not in hand: a person\'s card, which says why');
  assert.match(unresolved.why, /phases 13, 15, 16, 21, 33, 40, 41 — not phase 30/);
  const none = manifestVerdict(create, 'deny; allow `gh pr create` in the release phases', { phase: 30, releasePhases: [] });
  assert.equal(none.answer, null);
  assert.match(none.why, /the release phases, which this plan resolves to no phase number — not phase 30/);
});
