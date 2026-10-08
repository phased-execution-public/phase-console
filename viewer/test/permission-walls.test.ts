/**
 * PW-1..8 (control-tower phase 135, #212, §Architecture 19) — every wall the
 * AI meets reaches a person as ONE kind of item.
 *
 * PW-1  A wall is RECORDED for its lane: the console's own hook (a deny rule,
 *       every guard) and the CLI's own refusal (a tool outside the allow
 *       list, an MCP tool not granted, its copy of a deny rule, its classifier,
 *       its sandbox) — newest last, bounded, a repeat moved to the end.
 * PW-2  A `blocked --needs permission` declaration citing a recorded wall
 *       raises a `permission` ledger item through the one door — the tool, the
 *       rule, the command, the phase, why, the wall, the risk — for each wall;
 *       a bare declaration cites the newest wall.
 * PW-3  A declaration citing a wall nothing recorded raises NOTHING: at the
 *       door (`/hooks/declaration`) it is refused, exit 4, "nothing refused
 *       this — run it"; a lane this console does not drive is not refused.
 * PW-4  The widen rung raises the item — its card is the item's Grant, the
 *       card's row folds into the item — and a later card supersedes it.
 * PW-5  A capability that is off (the refused landing push) is an item whose
 *       Grant is at the machine only; a guard is `never`, with the manual path.
 * PW-6  (turn-guard.test.ts) G5 itself.
 * PW-7  An App not installed raises `third-party-approval` with its install
 *       link; a sandbox or network wall an operator act, a protected path its
 *       own kind — each with the manual path and no grant.
 * PW-8  The classifier's denial is explained with the exact rule a person
 *       could add to their OWN settings — never applied, nothing written.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SLUG, harness, type Harness } from './turn-harness.ts';

const {
  WALLS_KEPT, appTurnInput, manualTurnInput, permissionTurnInput, wallOfCliDenial, wallOfHookDenial, withWall,
  CAPABILITY_GRANT_LABEL,
} = await import('../server/permissions/walls.ts');
type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord, saveRun, runDir } = await import('../server/runner/state.ts');
const { answerDeclaredProbe } = await import('../server/declared-probe.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { G5_SENTENCE } = await import('../shared/turn-model.js');

const AT = '2026-10-07T10:00:00.000Z';
const AT_MS = Date.parse(AT);

const DENY: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/alpha', at: AT, source: 'hook' };
const ALLOW_LIST: RecordedWall = { wall: 'allow-list', tool: 'WebFetch', command: 'https://example.com/spec', at: AT, source: 'cli' };
const MCP: RecordedWall = { wall: 'mcp', tool: 'mcp__github__create_issue', rule: 'mcp__github', at: AT, source: 'cli' };
const GUARD: RecordedWall = { wall: 'guard', tool: 'Bash', rule: 'console-forge', command: 'curl -X POST http://127.0.0.1:4130/api/policy', at: AT, source: 'hook' };
const CAPABILITY: RecordedWall = {
  wall: 'capability', tool: 'Bash', rule: '--allow-publish', command: 'git push origin pe/alpha', at: AT, source: 'landing',
};

/** A run whose phase 3 ended declaring itself blocked on a permission, the walls its lane met on its record. */
function blockedRun(h: Harness, recorded: RecordedWall[], declared: { rule?: string; command?: string; reason?: string }) {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [3] } as never);
  const record = phaseRecord(state, 3);
  record.status = 'parked';
  record.sessionId = 'sess-3';
  record.endedAt = AT;
  record.walls = recorded;
  record.declared = { status: 'blocked', needs: 'permission', at: AT, ...declared } as never;
  state.status = 'parked' as never;
  saveRun(state);
  return state;
}

type Svc = { raiseDeclaredWall(slug: string, runId: string, phase: number): boolean };

test('PW-1: the hook\'s refusals and the CLI\'s are each recorded as the wall they are — newest last, bounded', () => {
  assert.equal(wallOfHookDenial({ tool: 'Bash', rule: 'Bash(git push:*)', command: 'git  push\norigin x' }, AT).wall, 'deny');
  assert.equal(wallOfHookDenial({ tool: 'Bash', rule: 'Bash(git push:*)', command: 'git  push\norigin x' }, AT).command, 'git push origin x');
  for (const guard of ['in-turn-wait', 'poll-loop', 'sign-in', 'gate-forge', 'console-forge', 'run-tree-clone']) {
    assert.equal(wallOfHookDenial({ tool: 'Bash', rule: guard }, AT).wall, 'guard', guard);
  }
  const byShape = wallOfHookDenial({ tool: 'Read', rule: null, command: '.env' }, AT);
  assert.equal(byShape.wall, 'deny', 'a deny by shape alone is still the deny list');
  assert.equal(byShape.rule, undefined);

  assert.equal(wallOfCliDenial({ tool: 'Bash', target: 'git push', reasonType: 'hook' }, AT), null, 'the console\'s own hook recorded it already');
  const mcp = wallOfCliDenial({ tool: 'mcp__github__create_issue', reasonType: 'mode' }, AT)!;
  assert.deepEqual([mcp.wall, mcp.rule, mcp.source], ['mcp', 'mcp__github', 'cli']);
  assert.equal(wallOfCliDenial({ tool: 'Bash', target: 'npm test', reasonType: 'rule' }, AT)!.wall, 'deny');
  assert.equal(wallOfCliDenial({ tool: 'WebFetch', target: 'https://x', reasonType: 'mode', reason: 'no approval surface in this session' }, AT)!.wall, 'allow-list');
  assert.equal(wallOfCliDenial({ tool: 'Bash', target: 'ls', reasonType: 'classifier' }, AT)!.wall, 'classifier');
  assert.equal(wallOfCliDenial({ tool: 'Bash', target: 'curl x', reasonType: 'sandbox' }, AT)!.wall, 'sandbox');
  assert.equal(wallOfCliDenial({ tool: 'Bash', target: 'npm test' }, AT)!.wall, 'allow-list', 'no reason type: asked where nobody could answer');

  let kept: RecordedWall[] = [];
  for (let i = 0; i < WALLS_KEPT + 3; i += 1) kept = withWall(kept, { ...DENY, command: `git push origin b${i}` });
  assert.equal(kept.length, WALLS_KEPT, 'bounded');
  assert.equal(kept.at(-1)!.command, `git push origin b${WALLS_KEPT + 2}`, 'newest last');
  kept = withWall(kept, { ...kept[0]!, at: '2026-10-07T11:00:00.000Z' });
  assert.equal(kept.length, WALLS_KEPT, 'a repeat is the same wall met again');
  assert.equal(kept.at(-1)!.at, '2026-10-07T11:00:00.000Z', '…moved to the end with its new clock');
});

test('PW-1: the runner stamps every hook refusal — a deny rule AND a guard — on the lane that met it', () => {
  const state = { phases: { '3': { phase: 3, status: 'running' } } } as never as { phases: Record<string, { walls?: RecordedWall[] }> };
  let persisted = 0;
  const lane = {
    state, record: () => 1, now: () => new Date(AT_MS), persist: () => { persisted += 1; },
    noteWall: Runner.prototype.noteWall,
  };
  Runner.prototype.note.call(lane as never, 'phase.tool-denied', { tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin x' }, 3);
  Runner.prototype.note.call(lane as never, 'phase.tool-denied', { tool: 'Bash', rule: 'gate-forge', why: 'a manual gate' }, 3);
  Runner.prototype.note.call(lane as never, 'phase.approval-raised', { tool: 'Bash' }, 3);
  assert.deepEqual(state.phases['3']!.walls!.map((w) => [w.wall, w.rule]), [['deny', 'Bash(git push:*)'], ['guard', 'gate-forge']]);
  assert.equal(persisted, 2);
});

test('PW-2: a declaration citing a recorded wall raises ONE permission item — for each wall — with every fact a person needs', () => {
  for (const wall of [DENY, ALLOW_LIST, MCP, GUARD, CAPABILITY]) {
    const h = harness();
    try {
      const state = blockedRun(h, [wall], {
        ...(wall.rule ? { rule: wall.rule } : { command: wall.command! }), reason: 'the phase must publish its branch',
      });
      assert.equal((h.svc as unknown as Svc).raiseDeclaredWall(SLUG, state.id, 3), true, wall.wall);
      const open = h.svc.humanStepsNow().open().filter((step) => step.kind === 'permission');
      assert.equal(open.length, 1, `one item for the ${wall.wall} wall`);
      const item = open[0]!;
      assert.equal(item.why, 'permission');
      assert.equal(item.proofType, 'grant');
      assert.equal(item.phase, 3);
      assert.equal(item.runId, state.id);
      assert.equal(item.permission?.wall, wall.wall);
      assert.equal(item.permission?.tool, wall.tool);
      if (wall.rule) assert.equal(item.permission?.rule, wall.rule);
      if (wall.command) assert.equal(item.permission?.command, wall.command);
      assert.equal(item.permission?.need, 'the phase must publish its branch');
      assert.ok(item.permission?.risk, 'its risk tier');
      assert.match(item.lines?.[0] ?? '', /^Raised because the AI lacks permission `[^`]+` to /, 'the sentence it leads with');
      assert.ok((item.lines ?? []).some((line) => line.startsWith('Phase 3 of alpha needs it: the phase must publish')), 'the phase and why');
      assert.ok((item.lines ?? []).some((line) => line.startsWith('The wall: ')), 'the wall, in words');
      assert.ok((item.lines ?? []).some((line) => line.startsWith('Risk: ')), 'the risk, in words');
    } finally { h.cleanup(); }
  }
});

test('PW-2: a bare declaration cites the newest recorded wall; the same wall raised again is the same item', () => {
  const h = harness();
  try {
    const state = blockedRun(h, [ALLOW_LIST, MCP], {});
    const svc = h.svc as unknown as Svc;
    assert.equal(svc.raiseDeclaredWall(SLUG, state.id, 3), true);
    assert.equal(svc.raiseDeclaredWall(SLUG, state.id, 3), true);
    const open = h.svc.humanStepsNow().open().filter((step) => step.kind === 'permission');
    assert.equal(open.length, 1, 'one item, raised twice');
    assert.equal(open[0]!.permission?.wall, 'mcp');
    assert.equal(h.pushes.length, 1, 'and one push');
  } finally { h.cleanup(); }
});

test('PW-3: a declaration citing a wall nothing recorded raises nothing at ingest, and is refused at the door', async () => {
  const h = harness();
  try {
    const state = blockedRun(h, [DENY], { rule: 'Bash(npm publish:*)' });
    assert.equal((h.svc as unknown as Svc).raiseDeclaredWall(SLUG, state.id, 3), false);
    assert.equal(h.svc.humanStepsNow().open().length, 0, 'no item for a wall nothing recorded');

    const stage = (declared: Record<string, unknown>) => {
      const dir = runDir(h.root, SLUG);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `run-${state.id}-p3-outcome.json.tmp.4242`);
      writeFileSync(path, JSON.stringify({ version: 1, slug: SLUG, phase: 3, status: 'blocked', needs: 'permission', watch: [], written_at: new Date().toISOString(), ...declared }));
      return path;
    };
    const probe = async () => ({ landed: null, refs: [] });
    const deps = { root: h.root, probe, walls: () => [DENY] };
    const refused = await answerDeclaredProbe({ slug: SLUG, phase: 3, file: stage({ rule: 'Bash(npm publish:*)', command: 'npm publish' }) }, deps);
    assert.equal(refused.status, 200);
    assert.equal((refused as { verdict: string }).verdict, 'guard');
    assert.equal((refused as { rule: string }).rule, 'G5');
    assert.equal((refused as { exit: number }).exit, 4);
    assert.equal((refused as { sentence: string }).sentence, G5_SENTENCE.replace(/["\\]/g, "'"));
    const cited = await answerDeclaredProbe({ slug: SLUG, phase: 3, file: stage({ rule: 'Bash(git push:*)' }) }, deps);
    assert.equal((cited as { verdict: string }).verdict, 'pending', 'a cited wall parks as it always did');
    const undriven = await answerDeclaredProbe({ slug: SLUG, phase: 3, file: stage({ rule: 'Bash(npm publish:*)' }) }, { ...deps, walls: () => null });
    assert.equal((undriven as { verdict: string }).verdict, 'pending', 'a lane this console drives no record of is explained, never refused');
  } finally { h.cleanup(); }
});

test('PW-4: the widen rung raises the item, its card the Grant; the card\'s row IS the item; a new card supersedes it', () => {
  const h = harness();
  try {
    const state = blockedRun(h, [DENY], { rule: 'Bash(git push:*)' });
    const raise = (card: string) => h.svc.raisePermissionItem({
      slug: SLUG, runId: state.id, phase: 3, sessionId: 'sess-3', wall: DENY, need: 'publish the branch',
      grant: { effect: 'strike', approvalId: card, label: `strike \`${DENY.rule}\` from this plan's deny list — permanent` },
    });
    const first = raise('card-1');
    assert.ok(first);
    const item = h.svc.humanStepsNow().get(first)!;
    assert.deepEqual(item.permission?.grant, { effect: 'strike', approvalId: 'card-1', label: `strike \`${DENY.rule}\` from this plan's deny list — permanent` });
    assert.equal(item.permission?.risk, 'high', 'a deny-wall rule is high');

    const inbox = buildInbox({
      plans: [], runs: [], flags: { allowRun: true },
      approvals: [{
        id: 'card-1', runId: state.id, slug: SLUG, phase: 3, kind: 'tool', standing: true, title: 'Phase 3: widen?', createdAt: AT,
        status: 'pending', tool: { name: 'Bash', input: { command: DENY.command } }, suggestedRule: DENY.rule,
      }],
      humanSteps: h.svc.humanStepsNow().open(),
    } as never, AT_MS + 1_000);
    const card = inbox.items.find((row) => row.kind === 'approval');
    const step = inbox.items.find((row) => row.kind === 'human-step');
    assert.equal(card?.turn?.item, first, 'the card\'s row is the item\'s');
    assert.equal(step?.turn?.item, first);
    assert.equal(step?.turn?.permission?.wall, 'deny');
    assert.deepEqual(step?.actions.map((a) => a.verb), ['grant', 'deny', 'convert'], 'Grant, Deny, I\'ll do it myself');
    // Since phase 149 the Grant is the scoped grant's press; the engine answers the card behind it.
    assert.equal(step?.actions[0]?.endpoint, `/api/human-steps/${first}/grant`, 'Grant presses the item, at its narrowest scope');
    assert.deepEqual(step?.actions[0]?.body, { scope: 'call' });

    const second = raise('card-2');
    assert.notEqual(second, first);
    assert.equal(h.svc.humanStepsNow().get(first)!.state, 'dismissed', 'the old item pressed a card nobody holds');
    assert.equal(h.svc.humanStepsNow().open().filter((s) => s.kind === 'permission').length, 1);
  } finally { h.cleanup(); }
});

test('PW-5: a capability that is off is granted at the machine only; a guard is never, with the manual path', () => {
  const at = { slug: SLUG, phase: 3, runId: 'r1' };
  const capability = permissionTurnInput(at, CAPABILITY, { grant: { effect: 'capability', label: CAPABILITY_GRANT_LABEL } });
  const cap = (capability.step as { permission: { wall: string; risk: string; grant?: { label: string } } }).permission;
  assert.equal(cap.wall, 'capability');
  assert.equal(cap.risk, 'high');
  assert.match(cap.grant!.label, /^at the machine only/);
  assert.match(cap.grant!.label, /Never from a paired device/);

  const guard = permissionTurnInput(at, GUARD, { grant: { effect: 'broker', approvalId: 'c1', label: 'Allow' } });
  const never = (guard.step as { permission: { risk: string; scopes: string[]; never?: { why: string; manual: string }; grant?: unknown } }).permission;
  assert.equal(never.risk, 'never');
  assert.deepEqual(never.scopes, [], 'no scope is offered');
  assert.equal(never.grant, undefined, 'and no grant, whatever was passed');
  assert.match(never.never!.why, /guard/);
  assert.ok(never.never!.manual.length > 10, 'the manual path');
  assert.ok((guard.step as { lines: string[] }).lines.some((line) => line.startsWith('What to do instead: ')));
});

test('PW-7: an App not installed, a sandbox wall and a protected path raise their own kinds — manual path, no grant', () => {
  const h = harness();
  try {
    const at = { slug: SLUG, phase: 3, runId: 'r1' };
    const app = h.svc.raiseTurn(appTurnInput(at, { name: 'Claude', installUrl: 'https://github.com/apps/claude', repo: 'acme/site' }));
    assert.ok(app && !('refused' in app));
    assert.equal(app.kind, 'third-party-approval');
    assert.equal(app.why, 'third-party');
    assert.equal(app.openUrl, 'https://github.com/apps/claude', 'the install link');
    assert.equal(app.permission, undefined, 'no grant');

    const sandbox = h.svc.raiseTurn(manualTurnInput(at, { wall: 'sandbox', tool: 'Bash', command: 'curl https://registry.npmjs.org', at: AT, source: 'cli' }));
    assert.ok(sandbox && !('refused' in sandbox));
    assert.equal(sandbox.kind, 'operator-act');
    assert.equal(sandbox.openCommand, 'curl https://registry.npmjs.org');
    assert.ok((sandbox.lines ?? []).some((line) => line.startsWith('Why no grant: ')), 'why no grant');

    const path = h.svc.raiseTurn(manualTurnInput(at, { wall: 'deny', tool: 'Edit', command: '.claude/settings.json', at: AT, source: 'cli' }));
    assert.ok(path && !('refused' in path));
    assert.equal(path.kind, 'protected-path');
    assert.match(path.title, /\.claude/);
    for (const step of [sandbox, path]) assert.equal(step.permission, undefined, `${step.kind}: no grant`);
  } finally { h.cleanup(); }
});

test('PW-8: the classifier\'s denial is explained with the rule a person could add — never applied, nothing written', () => {
  const home = mkdtempSync(join(tmpdir(), 'pc-pw8-home-'));
  const was = process.env.HOME;
  process.env.HOME = home;
  const h = harness();
  try {
    const wall = wallOfCliDenial({ tool: 'Bash', target: 'npm run deploy:preview', reasonType: 'classifier' }, AT)!;
    const id = h.svc.raisePermissionItem({ slug: SLUG, runId: 'r1', phase: 3, wall, grant: { effect: 'broker', approvalId: 'x', label: 'Allow' } });
    const item = h.svc.humanStepsNow().get(id!)!;
    assert.equal(item.permission?.wall, 'classifier');
    assert.equal(item.permission?.risk, 'never');
    assert.equal(item.permission?.ownRule, 'Bash(npm run:*)', 'the exact rule');
    assert.equal(item.permission?.grant, undefined, 'never applied by the console');
    assert.ok((item.lines ?? []).some((line) => line.includes('"Bash(npm run:*)"') && line.includes('your own Claude Code settings')));
    assert.equal(existsSync(join(home, '.claude', 'settings.json')), false, 'nothing is written to a person\'s own settings');
  } finally {
    h.cleanup();
    process.env.HOME = was;
    rmSync(home, { recursive: true, force: true });
  }
});

test('PW-4: answered on its card, the item is answered too — an Allow is the grant that covers it, a Deny a denial', () => {
  for (const decision of ['allow', 'deny'] as const) {
    const h = harness();
    try {
      const state = blockedRun(h, [DENY], { rule: 'Bash(git push:*)' });
      const { approval } = h.svc.approvals.request({
        runId: state.id, slug: SLUG, phase: 3, kind: 'tool', title: 'Phase 3: widen?', detail: 'x', evidence: [],
        tool: { name: 'Bash', input: { command: DENY.command } }, suggestedRule: DENY.rule,
      } as never);
      const id = h.svc.raisePermissionItem({
        slug: SLUG, runId: state.id, phase: 3, wall: DENY, grant: { effect: 'strike', approvalId: approval.id, label: 'strike it' },
      })!;
      assert.equal(h.svc.decideApproval(approval.id, decision, 'me', undefined).ok, true);
      const step = h.svc.humanStepsNow().get(id)!;
      assert.equal(step.state, decision === 'allow' ? 'dismissed' : 'declined', decision);
      assert.match(step.note ?? '', decision === 'allow' ? /^granted on its card — strike it/ : /^denied on its card/);
      // Raised again once its card is gone, the wall is a NEW item — never a dead Grant button.
      const again = h.svc.raisePermissionItem({ slug: SLUG, runId: state.id, phase: 3, wall: DENY });
      assert.ok(again);
      assert.notEqual(again, id);
    } finally { h.svc.approvals.disarm(); h.cleanup(); }
  }
});
