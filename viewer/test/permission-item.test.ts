/**
 * PI-1..4 (control-tower phase 135, #212, §Architecture 19) — the permission
 * item itself: its risk, its never list, and the two answers besides a grant.
 *
 * PI-1  `GRANT_RISK` is TOTAL over wall × rule family × scope — every cell is
 *       named by a row — and answers the plan's tiers: never for every guard, a
 *       credential, a sandbox, the classifier, a forced or deleting push
 *       (`PUSH_DENY_CARVED`), the host family, a protected path, a secret's
 *       value; high for a profile raise, a capability, any other deny-wall
 *       rule, any `always`; low and medium the rest.
 * PI-2  The item shows its tier; a never item offers no scope and no Grant on
 *       any door — it says why, with the manual path.
 * PI-3  *Deny*: the item settles `declined`, the card behind it is answered
 *       deny, and the waiting session is resumed ONCE on the road back: "denied
 *       — do not retry; find another way inside the plan or say what remains".
 * PI-4  *I'll do it myself*: the item becomes an `operator-act` whose guide is
 *       the command in both copy forms, and whose pass resumes the session.
 * PI-5  An item's evidence is read from the ASKING lane's tree and record —
 *       never the console's root, never another plan's run.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SLUG, call, harness, type Harness } from './turn-harness.ts';

const {
  GRANT_RISK, GRANT_SCOPES, HOST_COMMANDS, RULE_FAMILIES, WALLS, grantScopesOf, itemRiskOf, neverReason, riskOf, riskRowOf,
} = await import('../shared/turn-model.js');
const {
  ITEM_DENIED_REASON, evidenceTreeOf, permissionDetail, ruleFamilyOf,
} = await import('../server/permissions/walls.ts');
type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;
const { DEFAULT_DENY, PUSH_DENY_CARVED } = await import('../server/runner/approvals.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { guideCommands } = await import('../shared/guide-grammar.js');

const AT = '2026-10-07T10:00:00.000Z';
const DENY: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/alpha', at: AT, source: 'hook' };
const DENIAL_WORDS = 'Denied — do not retry; find another way inside the plan or say what remains.';

const NEVER_WALLS = ['guard', 'credential', 'sandbox', 'classifier'];
const NEVER_FAMILIES = ['force-push', 'host', 'protected-path', 'secret-value'];

test('PI-1: GRANT_RISK is total — every wall × family × scope is named by a row — and answers the plan\'s tiers', () => {
  assert.equal(WALLS.length * RULE_FAMILIES.length * GRANT_SCOPES.length, 270);
  for (const wall of WALLS) {
    for (const family of RULE_FAMILIES) {
      for (const scope of GRANT_SCOPES) {
        const cell = `${wall} × ${family} × ${scope}`;
        assert.ok(riskRowOf({ wall, family, scope }), `${cell} is named by a row, not the fallback`);
        const tier = riskOf({ wall, family, scope });
        if (NEVER_WALLS.includes(wall) || NEVER_FAMILIES.includes(family)) assert.equal(tier, 'never', cell);
        else if (family === 'profile' || wall === 'capability' || wall === 'deny' || scope === 'always') assert.equal(tier, 'high', cell);
        else assert.equal(tier, scope === 'call' || scope === 'phase' ? 'low' : 'medium', cell);
      }
    }
  }
  for (const row of GRANT_RISK) {
    assert.ok(row.family === '*' || (RULE_FAMILIES as readonly string[]).includes(row.family), `family ${row.family}`);
  }
});

test('PI-1: the never list is read off the rules the console ships — host, forced and deleting pushes, protected paths, secrets', () => {
  for (const word of HOST_COMMANDS) {
    assert.ok(DEFAULT_DENY.includes(`Bash(${word}:*)`), `DEFAULT_DENY walls ${word}`);
    assert.equal(ruleFamilyOf({ tool: 'Bash', rule: `Bash(${word}:*)` }), 'host');
  }
  for (const rule of PUSH_DENY_CARVED) assert.equal(ruleFamilyOf({ tool: 'Bash', rule }), 'force-push', rule);
  assert.equal(ruleFamilyOf({ tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push --force origin main' }), 'force-push');
  assert.equal(ruleFamilyOf({ tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/alpha' }), 'any', 'a plain push is grantable');
  assert.equal(ruleFamilyOf({ tool: 'Bash', command: 'FOO=1 sudo shutdown -h now' }), 'host');
  assert.equal(ruleFamilyOf({ tool: 'Edit', command: '.claude/settings.json' }), 'protected-path');
  assert.equal(ruleFamilyOf({ tool: 'Read', command: 'config/.env.production' }), 'secret-value');
  assert.equal(ruleFamilyOf({ tool: 'Bash', command: 'grep -rn shutdown viewer/server' }), 'any', 'a word in a pattern is not the command');
});

test('PI-2: an item shows its tier; a never item offers no scope and no Grant, and says why with the manual path', () => {
  assert.equal(itemRiskOf({ wall: 'ask' }), 'low');
  assert.equal(itemRiskOf({ wall: 'deny' }), 'high');
  assert.deepEqual(grantScopesOf({ wall: 'mcp' }), ['call', 'phase', 'plan', 'repository', 'always']);
  assert.equal(neverReason({ wall: 'mcp' }), null);

  const forced = permissionDetail({ ...DENY, rule: 'Bash(git push --force:*)', command: 'git push --force origin main' }, {
    grant: { effect: 'strike', approvalId: 'c1', label: 'strike it' },
  });
  assert.equal(forced.family, 'force-push');
  assert.equal(forced.risk, 'never');
  assert.deepEqual(forced.scopes, []);
  assert.equal(forced.grant, undefined, 'a never cell carries no grant, whatever was offered');
  assert.match(forced.never!.why, /forced or deleting push/);
  assert.match(forced.never!.manual, /yourself/);

  const plain = permissionDetail(DENY, { grant: { effect: 'strike', approvalId: 'c1', label: 'strike it' } });
  assert.equal(plain.risk, 'high');
  assert.deepEqual(plain.scopes, ['call', 'phase', 'plan', 'repository', 'always']);

  // On the screen: a never item's row offers Deny and I'll do it myself — never Grant.
  const inbox = buildInbox({
    plans: [], runs: [], flags: { allowRun: true }, approvals: [],
    humanSteps: [{
      id: 'hs-never', kind: 'permission', title: 'The AI lacks permission', where: 'any', slug: SLUG, phase: 3, runId: 'r1',
      declaredAt: AT, state: 'notified', birth: 'console', why: 'permission', proofType: 'grant', openCommand: 'git push --force origin main',
      source: { kind: 'wall', ref: 'deny:Bash(git push --force:*)' },
      permission: { ...forced, grant: { effect: 'strike', approvalId: 'c1', label: 'strike it' } },
    }],
  } as never, Date.parse(AT) + 1_000);
  const row = inbox.items.find((item) => item.kind === 'human-step')!;
  assert.deepEqual(row.actions.map((a) => a.verb), ['deny', 'convert']);
  assert.equal(row.turn?.permission?.risk, 'never');
});

/** A run whose phase 3 is parked behind a permission item, its session ended. */
function parkedOnWall(h: Harness, grant: { approvalId: string } | null = null) {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [3] } as never);
  const record = phaseRecord(state, 3);
  record.status = 'parked';
  record.sessionId = 'sess-3';
  record.endedAt = AT;
  record.walls = [DENY];
  record.declared = { status: 'blocked', needs: 'permission', rule: DENY.rule, reason: 'publish the run branch', at: AT } as never;
  state.status = 'parked' as never;
  saveRun(state);
  const id = h.svc.raisePermissionItem({
    slug: SLUG, runId: state.id, phase: 3, sessionId: 'sess-3', wall: DENY, need: 'publish the run branch',
    ...(grant ? { grant: { effect: 'broker' as const, approvalId: grant.approvalId, label: 'Allow' } } : {}),
  });
  assert.ok(id);
  return { state, id: id! };
}

test('PI-3: Deny settles the item declined, answers its card deny, and resumes the session once — "do not retry"', async () => {
  const h = harness();
  try {
    const { approval, decided } = h.svc.approvals.request({
      runId: 'r-card', slug: SLUG, phase: 3, kind: 'tool', title: 'Bash: git push origin pe/alpha', detail: 'Phase 3 wants to push.',
      evidence: [], tool: { name: 'Bash', input: { command: DENY.command } }, suggestedRule: DENY.rule,
    } as never);
    const { id } = parkedOnWall(h, { approvalId: approval.id });
    const answer = await call(h.svc, 'POST', `/api/human-steps/${id}/deny`, { reason: 'publish nothing from this phase' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const step = h.svc.humanStepsNow().get(id)!;
    assert.equal(step.state, 'declined', 'a person\'s answer — never the console\'s withdrawal');
    assert.match(step.note ?? '', /^denied: publish nothing/);
    const outcome = await decided;
    assert.equal(outcome.decision, 'deny', 'the card behind it is answered');
    assert.equal(outcome.reason, ITEM_DENIED_REASON);
    assert.equal(h.resumed.length, 1, 'resumed once');
    assert.ok(h.resumed[0]!.instruction?.includes(DENIAL_WORDS), h.resumed[0]!.instruction);
    assert.ok(h.resumed[0]!.instruction?.includes('`Bash(git push:*)`'), 'it names what was denied');
    const again = await call(h.svc, 'POST', `/api/human-steps/${id}/deny`, {});
    assert.equal(again.status, 409, 'a settled item is settled');
  } finally { h.svc.approvals.disarm(); h.cleanup(); }
});

test('PI-3: Deny answers a permission item only; a body carrying a secret is refused whole', async () => {
  const h = harness();
  try {
    const other = h.svc.raiseTurn({ slug: SLUG, phase: 3, birth: 'console', runId: 'r1', step: { kind: 'operator-act', title: 'Restart the box', why: 'physical' } });
    assert.ok(other && !('refused' in other));
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${other.id}/deny`, {})).status, 409);
    const { id } = parkedOnWall(h);
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${id}/deny`, { reason: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).status, 400);
    assert.equal(h.svc.humanStepsNow().get(id)!.state !== 'declined', true);
  } finally { h.cleanup(); }
});

test('PI-4: I\'ll do it myself turns the item into the person\'s act — the command in both copy forms — and its pass resumes the session', async () => {
  const h = harness();
  try {
    const { state, id } = parkedOnWall(h);
    const converted = await call(h.svc, 'POST', `/api/human-steps/${id}/convert`, {});
    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    assert.equal(h.svc.humanStepsNow().get(id)!.state, 'dismissed', 'the permission item is replaced');
    const into = (converted.body.converted as { into: string }).into;
    const act = h.svc.humanStepsNow().get(into)!;
    assert.equal(act.kind, 'operator-act');
    assert.equal(act.why, 'permission');
    assert.equal(act.openCommand, DENY.command);
    assert.equal(act.source?.kind, 'convert');
    assert.equal(act.runId, state.id);
    assert.ok(act.guide, 'a guide, read by the one grammar');
    const commands = guideCommands(act.guide!);
    assert.equal(commands[0], DENY.command, 'the command as it is');
    assert.ok(commands[1]?.startsWith(`cd '${h.root}' && `), 'and from the lane\'s own checkout');
    assert.ok(commands[1]?.endsWith(DENY.command));

    const checked = await call(h.svc, 'POST', `/api/human-steps/${into}/check`, { note: 'I ran the push myself' });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(h.svc.humanStepsNow().get(into)!.state, 'proven');
    assert.equal(h.resumed.length, 1, 'its pass resumes the session');
    assert.equal(h.resumed[0]!.phase, 3);
  } finally { h.cleanup(); }
});

test('PI-5: an item\'s evidence is read from the asking lane\'s tree and record, never the console\'s root', async () => {
  const lane = mkdtempSync(join(tmpdir(), 'pc-pi5-lane-'));
  const h = harness();
  try {
    assert.equal(evidenceTreeOf({ cwd: `${lane}/sub`, workRoot: lane, root: '/elsewhere' }), lane,
      'the run\'s own tree that holds the call — never the directory a session chose');
    assert.equal(evidenceTreeOf({ cwd: '/r/lanes/p3/src', trees: ['/r/lanes/p3'], workRoot: '/r', root: '/r' }), '/r/lanes/p3', 'the deepest');
    assert.equal(evidenceTreeOf({ cwd: `${lane}/../escaped`, workRoot: '/r', root: '/r', trees: [lane] }), '/r', 'resolved first: ../ leaves the tree');
    assert.equal(evidenceTreeOf({ cwd: '/tmp/not-a-run-tree', workRoot: lane, root: '/elsewhere' }), lane, 'else the run\'s checkout');
    assert.equal(evidenceTreeOf({ cwd: null, root: '/r' }), '/r');
    assert.equal(evidenceTreeOf({}), null, 'no run: no tree — never the console root');

    execFileSync('git', ['init', '-q', lane]);
    writeFileSync(join(lane, 'lane-only.txt'), 'the lane\'s own change\n');
    const run = {
      root: '/does-not-exist', workRoot: lane,
      phases: { '3': { phase: 3, verification: { ran: [{ ok: false, command: 'npm test' }] } } },
    };
    const evidenceFor = (h.svc as unknown as { evidenceFor(phase: number, at: object): Promise<{ label: string; body: string }[]> }).evidenceFor;
    // A nested repository the session made, whose config hangs a command on git status, is never where git runs.
    execFileSync('git', ['init', '-q', join(lane, 'planted')]);
    execFileSync('git', ['-C', join(lane, 'planted'), 'config', 'core.fsmonitor', `touch ${join(lane, 'PWNED')}`]);
    const evidence = await evidenceFor.call(h.svc, 3, { run, cwd: join(lane, 'planted') });
    assert.equal(existsSync(join(lane, 'PWNED')), false, 'nothing the session planted ran');
    const tree = evidence.find((e) => e.label === 'Working tree');
    assert.ok(tree?.body.includes('lane-only.txt'), JSON.stringify(evidence));
    assert.ok(evidence.some((e) => e.label === 'Verification so far' && e.body.includes('FAIL  npm test')), 'the asking lane\'s record');
    assert.deepEqual(await evidenceFor.call(h.svc, 3, {}), [], 'no asking lane: nothing read from the console\'s root');
  } finally {
    h.cleanup();
    rmSync(lane, { recursive: true, force: true });
  }
});

test('PI-4: a permission item is answered, never checked — a check would pass it on a word and resume a walled session', async () => {
  const h = harness();
  try {
    const { id } = parkedOnWall(h);
    const checked = await call(h.svc, 'POST', `/api/human-steps/${id}/check`, { note: 'done' });
    assert.equal(checked.status, 409);
    assert.match(String(checked.body.error), /Grant it, Deny it, or press I'll do it myself/);
    assert.equal(h.svc.humanStepsNow().get(id)!.state, 'notified', 'still open');
    assert.equal(h.resumed.length, 0);
  } finally { h.cleanup(); }
});
