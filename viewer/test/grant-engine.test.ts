/**
 * GE-1..5 (control-tower phase 149, #212, §Architecture 19) — the waiting
 * session resumes by itself, and a grant lets EXACTLY what it names through.
 *
 * GE-1  A grant answers a held hook call at no cost: the card's call is let
 *       through, a `call` grant is spent by that answer, nothing is re-boarded.
 * GE-2  A parked session resumes through the one road back: "The operator
 *       granted `<rule>` for <scope> until <end> — run it again".
 * GE-3  A phase grant against a deny rule lets the granted command run in its
 *       lane only — not from a sibling lane, not for a neighbouring rule (a
 *       forced push is never covered), not once its phase settled.
 * GE-4  A call grant lets that one call through once — the same call again,
 *       or another, is refused as before.
 * GE-5  An open item a later grant covers withdraws itself ("the AI can do this
 *       itself now") and its waiters resume.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';

import { SLUG, call, harness, type Harness } from './turn-harness.ts';

const { ITEM_GRANTED_REASON } = await import('../server/permissions/walls.ts');
const { forcedPush, grantCovers } = await import('../server/permissions/grants.ts');
type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { Service } = await import('../server/service.ts');
const { SKILL_DIR } = await import('../server/config.ts');

const AT = '2026-10-07T10:00:00.000Z';
const DENY: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/alpha', at: AT, source: 'hook' };

/** A run whose phases are parked, each behind a raised permission item. */
function parkedOn(h: Harness, walls: Record<number, RecordedWall>, grant: { approvalId: string } | null = null) {
  const phases = Object.keys(walls).map(Number);
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: phases } as never);
  for (const phase of phases) {
    const record = phaseRecord(state, phase);
    record.status = 'parked';
    record.sessionId = `sess-${phase}`;
    record.endedAt = AT;
    record.walls = [walls[phase]!];
    record.declared = { status: 'blocked', needs: 'permission', rule: walls[phase]!.rule, reason: 'publish the run branch', at: AT } as never;
  }
  state.status = 'parked' as never;
  saveRun(state);
  const ids = phases.map((phase) => h.svc.raisePermissionItem({
    slug: SLUG, runId: state.id, phase, sessionId: `sess-${phase}`, wall: walls[phase]!, need: 'publish the run branch',
    ...(grant ? { grant: { effect: 'broker' as const, approvalId: grant.approvalId, label: 'Allow' } } : {}),
  })!);
  return { state, ids };
}

test('GE-1: a grant answers a held hook call at no cost — the call is let through, the call grant spent, nothing re-boarded', async () => {
  const h = harness();
  try {
    const ask: RecordedWall = { wall: 'ask', tool: 'Bash', rule: 'Bash(make ship:*)', command: 'make ship', at: AT, source: 'broker' };
    const { approval, decided } = h.svc.approvals.request({
      runId: 'r-held', slug: SLUG, phase: 3, kind: 'tool', title: 'Bash: make ship', detail: 'Phase 3 wants to ship.',
      evidence: [], tool: { name: 'Bash', input: { command: 'make ship' } }, suggestedRule: 'Bash(make ship:*)',
    } as never);
    const id = h.svc.raisePermissionItem({ slug: SLUG, runId: 'r-held', phase: 3, wall: ask, grant: { effect: 'broker', approvalId: approval.id, label: 'Allow' } })!;
    const answer = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'call' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const outcome = await decided;
    assert.equal(outcome.decision, 'allow', 'the held call is answered');
    assert.equal(outcome.reason, ITEM_GRANTED_REASON);
    const row = h.svc.grantsNow().list()[0]!;
    assert.equal(row.scope, 'call');
    assert.equal(row.state, 'spent', 'the answer was its one use');
    assert.equal(row.item, id);
    assert.equal(row.card, approval.id);
    assert.equal(h.resumed.length, 0, 'a held call needs no resume — the card answered it');
    assert.equal(h.svc.humanStepsNow().get(id)!.state, 'proven');
  } finally { h.svc.approvals.disarm(); h.cleanup(); }
});

test('GE-2: a parked session resumes by itself — "The operator granted <rule> for <scope> until <end> — run it again"', async () => {
  const h = harness();
  try {
    const { ids: [id] } = parkedOn(h, { 3: DENY });
    const answer = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'phase', rule: 'Bash(git push:*)', reason: 'the run branch only' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const step = h.svc.humanStepsNow().get(id!)!;
    assert.equal(step.state, 'proven');
    assert.match(step.note ?? '', /^granted `Bash\(git push:\*\)` for this phase until the phase settles/);
    assert.equal(h.resumed.length, 1, 'resumed once');
    const said = h.resumed[0]!.instruction ?? '';
    assert.ok(said.startsWith('The operator granted `Bash(git push:*)` for this phase until the phase settles'), said);
    assert.ok(said.includes('— run it again: `git push origin pe/alpha`'), said);
    const row = h.svc.grantsNow().list()[0]!;
    assert.equal(row.reason, 'the run branch only', 'the reason is kept');
    assert.equal(row.door, 'local');
  } finally { h.cleanup(); }
});

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/** A service driving run r1 — phases 2 and 3 live in their own lanes (sessions sess-2, sess-3). */
function hooked(phase2: Record<string, unknown> = {}) {
  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const noted: Noted[] = [];
  const run = {
    id: 'r1', slug: 'gedemo', activePhase: 2, permissionProfile: 'trusted', status: 'running',
    phases: {
      '2': { phase: 2, status: 'running', sessionId: 'sess-2', ...phase2 },
      '3': { phase: 3, status: 'running', sessionId: 'sess-3' },
    },
  };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('gedemo', {
    busy: () => true, current: () => run,
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteToolDenied: () => {}, noteWaitDenied: () => {}, park: () => {}, isSpending: () => false,
  });
  return { service, noted, run };
}

const bash = (command: string, session: string) => ({ tool_name: 'Bash', tool_input: { command }, session_id: session });
const decision = (reply: Record<string, unknown>) => (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;

test('GE-3: a phase grant against a deny rule lets exactly the granted command run — its lane, its rule, its phase', async () => {
  const { service, run } = hooked();
  const before = decision(await service.decideToolUse(bash('git push origin pe/gedemo', 'sess-2'), 'r1'));
  assert.equal(before.permissionDecision, 'deny', 'the wall stands before any grant');
  const applied = service.grantsNow().apply({
    scope: 'phase', wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', slug: 'gedemo', phase: 2, runId: 'r1',
    by: 'me', door: 'local', typed: 'Bash(git push:*)',
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  const granted = decision(await service.decideToolUse(bash('git push origin pe/gedemo', 'sess-2'), 'r1'));
  assert.equal(granted.permissionDecision, 'allow');
  assert.match(granted.permissionDecisionReason, /granted by me for this phase until the phase settles/);
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/gedemo', 'sess-3'), 'r1')).permissionDecision, 'deny', 'not from a sibling lane');
  assert.equal(decision(await service.decideToolUse(bash('git push --force origin main', 'sess-2'), 'r1')).permissionDecision, 'deny', 'not a forced push — never covered');
  for (const forced of ['git push origin main --force', 'git push -u origin pe/x -f', 'git push origin +main', 'git push origin :pe/old']) {
    assert.equal(decision(await service.decideToolUse(bash(forced, 'sess-2'), 'r1')).permissionDecision, 'deny', `never: ${forced}`);
  }
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/gedemo && npm publish', 'sess-2'), 'r1')).permissionDecision, 'deny', 'not a neighbouring rule');
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/gedemo && sudo reboot', 'sess-2'), 'r1')).permissionDecision, 'deny', 'not a host command beside it');
  run.phases['2'].status = 'done';
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/gedemo', 'sess-2'), 'r1')).permissionDecision, 'deny', 'not after its phase settled');
  service.grantsNow().end(applied.row.id, 'revoked', 'me');
});

test('GE-4: a call grant lets that one call through once — the same call again, or another, is refused', async () => {
  const { service } = hooked();
  const applied = service.grantsNow().apply({
    scope: 'call', wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/once', slug: 'gedemo', phase: 2, runId: 'r1',
    by: 'me', door: 'local', typed: 'Bash(git push:*)',
  });
  assert.ok(applied.ok);
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/other', 'sess-2'), 'r1')).permissionDecision, 'deny', 'another call is not it');
  assert.equal(decision(await service.decideToolUse(bash(`git push origin pe/once; ${'x'.repeat(420)}; npm publish`, 'sess-2'), 'r1')).permissionDecision, 'deny', 'a call that only begins like it is not it');
  assert.equal(decision(await service.decideToolUse(bash('git push  origin pe/once', 'sess-2'), 'r1')).permissionDecision, 'allow', 'the call (whitespace folded)');
  assert.equal(service.grantsNow().get(applied.row.id)?.state, 'spent');
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/once', 'sess-2'), 'r1')).permissionDecision, 'deny', '…once');
});

test('GE-5: an open item a later grant covers withdraws itself — "the AI can do this itself now" — and its waiters resume', async () => {
  const h = harness();
  try {
    const { ids: [first, second] } = parkedOn(h, { 3: DENY, 4: { ...DENY, command: 'git push origin pe/beta' } });
    const answer = await call(h.svc, 'POST', `/api/human-steps/${first}/grant`, { scope: 'plan', rule: 'Bash(git push:*)' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = h.svc.humanStepsNow().get(second!)!;
    assert.equal(other.state, 'dismissed', 'the covered item withdraws itself');
    assert.match(other.note ?? '', /^the AI can do this itself now — /);
    const phases = h.resumed.map((one) => one.phase).sort();
    assert.deepEqual(phases, [3, 4], 'both waiters resume');
    for (const resume of h.resumed) assert.match(resume.instruction ?? '', /^The operator granted `Bash\(git push:\*\)` for this plan until it is revoked/);
    h.svc.grantsNow().revokeAll('test');
  } finally { h.cleanup(); }
});

test('GE-3: the never list reads a push by an allow-list — an abbreviated flag, configuration before the verb, a forcing refspec or a word left to the shell is a forced push', () => {
  const forced = [
    'git push --force-w origin main', 'git push --force-i origin main', 'git push --forc origin main', 'git push --dele origin pe/old',
    'git push --mir origin', 'git push --pru origin', 'git push -fu origin main', 'git push -o ci.skip --force origin main',
    'git -c remote.origin.mirror=true push origin', "git -c 'remote.origin.push=+refs/heads/*:refs/heads/*' push origin",
    'git --config-env=remote.origin.mirror=MIRROR push origin',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push origin',
    'export GIT_CONFIG_PARAMETERS=x; git push origin pe/x',
    'git push origin "+main"', 'git push origin \\+main', 'git push origin -- :pe/old', 'git push "--for"ce origin main',
    'git push origin $BRANCH', 'git push origin `cat ref`', 'git push origin {+main,x}', 'bash -c "git push --force-w origin main"',
    // What the shell or git reads differently from the words on the line.
    '$(which git) push --force origin main', '`which git` push --force origin main', 'G=git; $G push --force origin main',
    'git $VERB --force origin main', 'git -c alias.p=push p --force origin main', 'echo --force | xargs git push origin main',
    'git push -o --force origin main', 'git send-pack --force origin refs/heads/main',
    // Case is the file system's (macOS), a verb may be its own program, a here-string is still a shell's input.
    'GIT push --force origin main', 'Git push --force origin main', 'git PUSH --force origin main', '$(which git) PUSH --force origin main',
    'git-push --force origin main', '/usr/libexec/git-core/git-push --force origin main', 'git-send-pack --force origin refs/heads/main',
    "bash <<< 'git push --force origin main'", "bash <<'EOF'\ngit push --force origin main\nEOF",
    // An alias the line defines may make any word git (bash with `expand_aliases` runs it on the next line).
    "bash -c 'shopt -s expand_aliases\nalias g=git\ng push --force origin main'",
    // A push glued after an expansion; a value assigned on the line and run; an escape a program
    // decodes (`\x2d` is `-` to printf, `echo -e` and `$'…'`); a subshell glued to git.
    'G=git-; "$G"push --force origin main', "P='git push -f origin main'; eval \"$P\"",
    "bash -c \"$(printf 'git push \\x2d\\x2dforce origin main')\"", "echo -e 'git push \\x2d\\x2dforce origin main' | bash",
    "bash <<< '(git push --force origin main)'", "bash <<< $'git push --force origin main'",
    // An unread command may be git, and the push it runs may be named anywhere on the line.
    'P="git push"; $P --force origin main', 'IFS=,; P=git,push,--force,origin,main; $P', 'G=git; V=push; $G $V --force origin main',
    // Options that run a program, or another repository's push.
    "git push --receive-pack='git-receive-pack --force' /srv/repo main", 'git push --exec=/tmp/x /srv/repo main',
    'git push --recurse-submodules=on-demand origin main',
  ];
  for (const command of forced) assert.equal(forcedPush(command), true, command);
  const plain = [
    'git push origin pe/gedemo', 'git push -u origin pe/gedemo', 'git push --set-upstream origin pe/gedemo', 'git push --no-verify origin pe/gedemo',
    'git -C /tmp/repo push origin pe/gedemo', 'git push --follow-tags origin pe/gedemo', 'git push -o ci.skip origin pe/gedemo',
    'git push origin HEAD:refs/heads/pe/gedemo', 'git log --grep push', 'git push --no-force-with-lease origin pe/x',
    'git push origin pe/gedemo 2>&1 | tail -5', 'git push origin pe/gedemo && echo pushed', 'git -C /tmp/repo push -u origin pe/gedemo',
    // Work that names no push stays work — a lifted push wall must not refuse a session its own tools.
    'git -c color.ui=never diff', 'bash "$PE_SCRIPTS"/phase-outcome.sh control-tower 149 verified --command "npm test" --exit 0',
    '"$S"/phase-tasks.sh control-tower 149 update --id p149.task1 --status completed',
    // Text the shell never runs is data, never a push: a quoted here-doc's body (a commit message, a
    // file), a comment, a group's braces — and a push named inside an identifier is no push.
    "git commit -m \"$(cat <<'EOF'\nfix(permissions): read the line whole\n\n* push wall: an ordinary push still passes\nEOF\n)\"",
    "cat > /tmp/notes.md <<'EOF'\n* push pe/gedemo once the gates pass\nEOF",
    "cat > /tmp/env.md <<'EOF'\nGIT_CONFIG_COUNT=0 is unset here\nEOF\ngit push origin pe/gedemo",
    '{ git push -u origin pe/gedemo; } 2>&1 | tail -5', 'git push origin pe/gedemo  # pushes pe/* only',
    'git -c color.ui=never grep -n forcedPush viewer/server',
    "gh pr create --title t --body \"$(cat <<'EOF'\n* push the branch [x]\nEOF\n)\"",
  ];
  for (const command of plain) assert.equal(forcedPush(command), false, command);
});

test('GE-5: a call grant covers no other item — a call that only LOOKS like it keeps its own card held and its item open', async () => {
  const h = harness();
  try {
    const raise = (wall: 'ask' | 'allow-list', command: string) => {
      const { approval } = h.svc.approvals.request({
        runId: 'r-held', slug: SLUG, phase: 3, kind: 'tool', title: `Bash: ${command}`, detail: 'Phase 3 wants to ship.',
        evidence: [], tool: { name: 'Bash', input: { command } }, suggestedRule: 'Bash(make ship:*)',
      } as never);
      const id = h.svc.raisePermissionItem({
        slug: SLUG, runId: 'r-held', phase: 3, wall: { wall, tool: 'Bash', rule: 'Bash(make ship:*)', command, at: AT, source: 'broker' },
        grant: { effect: 'broker', approvalId: approval.id, label: 'Allow' },
      })!;
      return { approval, id };
    };
    // Two calls of one lane, one rule: shown without their quotes they read the same — they are not the same call.
    const granted = raise('ask', "make ship 'v1 && v2'");
    const lookalike = raise('allow-list', 'make ship v1 && v2');
    assert.equal(grantCovers({ scope: 'call', rule: 'Bash(make ship:*)', wall: 'ask', slug: SLUG, phase: 3, runId: 'r-held', command: 'make ship v1 && v2' },
      { slug: SLUG, phase: 3, runId: 'r-held', permission: { wall: 'ask', tool: 'Bash', rule: 'Bash(make ship:*)', command: 'make ship v1 && v2' } }), false,
    'not even the very same text: a call grant is one use, spent on its own call');
    const answer = await call(h.svc, 'POST', `/api/human-steps/${granted.id}/grant`, { scope: 'call' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.svc.humanStepsNow().get(lookalike.id)!.state === 'dismissed', false, 'the look-alike item stays open');
    assert.ok(h.svc.approvals.isPending(lookalike.approval.id), 'the look-alike call is still held — nothing answered it allow');
    assert.equal(h.svc.grantsNow().list()[0]!.state, 'spent', 'its one use was its own call');
    assert.equal(h.resumed.length, 0, 'nothing resumed on its behalf');
  } finally { h.svc.approvals.disarm(); h.cleanup(); }
});

test('GE-3: a plan grant that lifts the push wall never opens a forced or deleting push — the hook refuses it, wherever the flag sits', async () => {
  const { service } = hooked();
  const applied = service.grantsNow().apply({
    scope: 'plan', wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', slug: 'gedemo', phase: 2, runId: 'r1',
    by: 'me', door: 'local', typed: 'Bash(git push:*)',
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(decision(await service.decideToolUse(bash('git push origin pe/gedemo', 'sess-3'), 'r1')).permissionDecision, 'allow', 'the plan may push');
  for (const forced of [
    'git push origin main --force', 'git push --force origin main', 'git push origin +main',
    'git push --force-w origin main', 'git push --dele origin pe/old', 'git -c remote.origin.mirror=true push origin',
  ]) {
    const answer = decision(await service.decideToolUse(bash(forced, 'sess-3'), 'r1'));
    assert.equal(answer.permissionDecision, 'deny', forced);
  }
  assert.match(decision(await service.decideToolUse(bash('git push origin main --force', 'sess-3'), 'r1')).permissionDecisionReason, /never list/);
  service.grantsNow().end(applied.row.id, 'revoked', 'me');
});

