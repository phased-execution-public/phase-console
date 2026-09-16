/**
 * Auto-grant: the console answers permission asks itself — the ask still
 * happens, only the answering hand is automated.
 *
 * The operator's chosen shape (2026-08-23): ON by default. Two things are held
 * back: a wrapper whose hidden payload the deny list would stop (a silent yes
 * there is the wall failing, not supervision relaxing), and — since 5.0.0
 * (zero-touch-console phase 13, TRS-4) — the two publishing asks the openPr
 * carve-out pins for a person, `git push` and `gh pr create`, which the
 * 2026-08-23 shape auto-granted 189 times with nobody asked. Those stay a card
 * unless the plan's `permission.destructive` row names the rule as an
 * exception, and a grant under one carries `matched` and is announced.
 *
 * Three layers, one file: the scope resolution (`autoApproveFor` — plan file
 * beats global file beats the shipped ON), the file round-trip (`editPolicy`
 * writes, clears, and above all PRESERVES the scalar through unrelated rule
 * edits), and the broker (`Approvals.grant` mints an already-settled card that
 * fires `resolved` and never `notify`). The service half — the branch in
 * `decideToolUse` — is exercised through the same runner-pool stub
 * `hook-decisions.test.ts` uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-autogrant-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-autogrant-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  Approvals, autoApproveFor, editPolicy, policyExtras, planPolicyPath, POLICY_PATH,
} = await import('../server/runner/approvals.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

/** A scratch pair of policy files, torn down per test. */
function policyFiles(): { global: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-autogrant-policy-'));
  return {
    global: join(dir, 'autopilot.json'),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const write = (file: string, value: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
};

/* ------------------------------------------------------------------ *
 * autoApproveFor — the scope ladder
 * ------------------------------------------------------------------ */

test('with both files silent, the shipped default is ON', () => {
  const f = policyFiles();
  try {
    assert.deepEqual(autoApproveFor(null, f.global), { effective: true, global: null, plan: null });
  } finally { f.cleanup(); }
});

test('the global file speaks when the plan file is silent — both directions', () => {
  const f = policyFiles();
  try {
    write(f.global, { autoApprove: false });
    assert.deepEqual(autoApproveFor(null, f.global), { effective: false, global: false, plan: null });
    write(f.global, { autoApprove: true });
    assert.equal(autoApproveFor(null, f.global).effective, true);
  } finally { f.cleanup(); }
});

test('the plan file outranks the global file — both directions', () => {
  const f = policyFiles();
  try {
    write(f.global, { autoApprove: false });
    write(planPolicyPath('demo', f.dir), { autoApprove: true });
    assert.deepEqual(autoApproveFor('demo', f.global, f.dir), { effective: true, global: false, plan: true });
    write(f.global, { autoApprove: true });
    write(planPolicyPath('demo', f.dir), { autoApprove: false });
    assert.deepEqual(autoApproveFor('demo', f.global, f.dir), { effective: false, global: true, plan: false });
  } finally { f.cleanup(); }
});

test('a legacy unkeyed plan file is honoured, and a hand-edited non-boolean reads as silence', () => {
  const f = policyFiles();
  try {
    // The legacy path: plans/<slug>.json with no instance key.
    write(join(f.dir, 'plans', 'demo.json'), { autoApprove: false });
    assert.equal(autoApproveFor('demo', f.global, f.dir).plan, false);
    write(f.global, { autoApprove: 'yes' });
    assert.deepEqual(autoApproveFor(null, f.global), { effective: true, global: null, plan: null });
  } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * editPolicy — write, clear, PRESERVE
 * ------------------------------------------------------------------ */

test('set writes the scalar, null clears it, and the answer shows in policyExtras', () => {
  const f = policyFiles();
  try {
    editPolicy({ set: { autoApprove: false } }, f.global);
    assert.equal(policyExtras(f.global).autoApprove, false);
    editPolicy({ set: { autoApprove: true } }, f.global);
    assert.equal(policyExtras(f.global).autoApprove, true);
    editPolicy({ set: { autoApprove: null } }, f.global);
    assert.equal(policyExtras(f.global).autoApprove, undefined);
    assert.ok(!readFileSync(f.global, 'utf8').includes('autoApprove'), 'a cleared scalar leaves no key behind');
  } finally { f.cleanup(); }
});

test('a rule edit without `set` PRESERVES the stored scalar — the load-bearing half', () => {
  const f = policyFiles();
  try {
    editPolicy({ set: { autoApprove: false } }, f.global);
    editPolicy({ add: { deny: ['Bash(rm -rf:*)'] } }, f.global);
    assert.equal(policyExtras(f.global).autoApprove, false,
      'every rule edit rewrites the file — losing the scalar on the way through would silently re-enable auto-grant');
    const parsed = JSON.parse(readFileSync(f.global, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed.autoApprove, false);
    assert.ok((parsed.deny as string[]).includes('Bash(rm -rf:*)'));
  } finally { f.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Approvals.grant — the settled card
 * ------------------------------------------------------------------ */

const CARD = {
  runId: 'r1', slug: 'demo', phase: 2, kind: 'tool' as const,
  title: 'Bash: git commit', detail: 'Phase 2 of demo wants to use Bash.',
  evidence: [], tool: { name: 'Bash', input: { command: 'git commit -m x' } },
};

test('grant mints an already-settled card: in the history, never pending, resolved fires, notify never', () => {
  const pendingFile = join(mkdtempSync(join(tmpdir(), 'pc-autogrant-pend-')), 'pending.json');
  const notified: unknown[] = [];
  const resolved: { status: string; decidedBy?: string; reason?: string }[] = [];
  const approvals = new Approvals({
    notify: (a) => notified.push(a),
    resolved: (a) => resolved.push({ status: a.status, decidedBy: a.decidedBy, reason: a.reason }),
  }, pendingFile);
  const out = approvals.grant(CARD, 'auto-grant', 'auto-granted — testing');

  assert.equal(out.status, 'allow');
  assert.equal(out.decidedBy, 'auto-grant');
  assert.equal(out.decidedAt, out.createdAt, 'born decided');
  assert.equal(approvals.pending().length, 0, 'never pending');
  assert.equal(approvals.recent().length, 1, 'in the audit trail');
  assert.equal(approvals.all()[0].id, out.id);
  assert.equal(notified.length, 0, 'notify is the "get a person" channel — push rides it');
  assert.deepEqual(resolved, [{ status: 'allow', decidedBy: 'auto-grant', reason: 'auto-granted — testing' }]);
  assert.ok(!existsSync(pendingFile) || !readFileSync(pendingFile, 'utf8').includes(out.id),
    'nothing to recover after a restart — the card was never outstanding');
});

/* ------------------------------------------------------------------ *
 * decideToolUse — the branch, through the runner-pool stub
 * ------------------------------------------------------------------ */

type Noted = { event: string; data: Record<string, unknown>; phase?: number };
type RunShape = Record<string, unknown>;

function serviceOn(run: RunShape): {
  service: InstanceType<typeof Service>; noted: Noted[]; events: { name: string; data: unknown }[];
} {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: 'guarded', ...run }),
    note: (event: string, data: Record<string, unknown>, phase?: number) =>
      noted.push({ event, data, phase }),
    park: () => {},
  });
  const events: { name: string; data: unknown }[] = [];
  service.onEvent((name: string, data: unknown) => events.push({ name, data }));
  return { service, noted, events };
}

const ASKED = { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } };

function reply(out: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

test('an ask-listed command auto-grants by default: allow reply, journal entry, resolved SSE, no approval SSE, no pending card', async () => {
  rmSync(POLICY_PATH, { force: true });
  const { service, noted, events } = serviceOn({});
  const answer = reply(await service.decideToolUse(ASKED, 'r1'));

  assert.equal(answer.permissionDecision, 'allow');
  assert.match(answer.permissionDecisionReason, /auto-grant/);
  assert.match(answer.permissionDecisionReason, /not a person/);
  assert.equal(service.approvals.pending().length, 0, 'no card waits');
  const card = service.approvals.recent().at(-1);
  assert.ok(card, 'the ask is still recorded');
  assert.equal(card?.status, 'allow');
  assert.equal(card?.decidedBy, 'auto-grant');
  assert.equal(card?.phase, 2, 'stamped with the lane');
  const journalled = noted.find((n) => n.event === 'phase.approval-auto-granted');
  assert.ok(journalled, 'the durable audit is the journal');
  assert.equal(journalled?.data.tool, 'Bash');
  assert.equal(journalled?.data.level, 'default');
  assert.equal(journalled?.phase, 2);
  // Which line of policy asked (LFC-9): the audit's 189 grants carried only the suggestion.
  assert.equal(journalled?.data.matched, 'Bash(git commit:*)');
  assert.equal(card?.matched, 'Bash(git commit:*)');
  assert.ok(events.some((e) => e.name === 'approval:resolved'), 'pages learn a decision exists');
  assert.ok(!events.some((e) => e.name === 'approval'), '`approval` is the "get a person" channel');
  service.close();
});

test('a global OFF brings the person back: the same command raises a real pending card', async () => {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  const { service } = serviceOn({});
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(ASKED, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'opted out — a card waits for a person');
  assert.equal(service.approvals.pending().length, 1);
  service.approvals.disarm();
  service.close();
  rmSync(POLICY_PATH, { force: true });
});

test('the phase level outranks everything: false beats a silent-global ON, and true beats a global OFF', async () => {
  rmSync(POLICY_PATH, { force: true });
  // Phase 2 says hands-on; the default would have auto-granted.
  {
    const { service } = serviceOn({ phaseOptions: { 2: { autoApprove: false } } });
    const pending = Symbol('still asking');
    const outcome = await Promise.race([
      service.decideToolUse(ASKED, 'r1'),
      new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
    ]);
    assert.equal(outcome, pending, 'the phase said ask me');
    service.approvals.disarm();
    service.close();
  }
  // Phase 2 says hands-free; the global file says off.
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  {
    const { service, noted } = serviceOn({ phaseOptions: { 2: { autoApprove: true } } });
    const answer = reply(await service.decideToolUse(ASKED, 'r1'));
    assert.equal(answer.permissionDecision, 'allow');
    assert.equal(noted.find((n) => n.event === 'phase.approval-auto-granted')?.data.level, 'phase');
    service.close();
  }
  rmSync(POLICY_PATH, { force: true });
});

test('the lane is found by session id, so a parallel run applies the RIGHT phase option', async () => {
  rmSync(POLICY_PATH, { force: true });
  const { service } = serviceOn({
    activePhase: 5,
    phases: {
      3: { phase: 3, status: 'running', sessionId: 'sess-3', attempts: 1, costUsd: 0 },
      5: { phase: 5, status: 'running', sessionId: 'sess-5', attempts: 1, costUsd: 0 },
    },
    phaseOptions: { 3: { autoApprove: false } },
  });
  // The call carries phase 3's session id; activePhase (5) would auto-grant.
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse({ ...ASKED, session_id: 'sess-3' }, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, "phase 3 opted out, and it is phase 3's session asking");
  assert.equal(service.approvals.pending()[0]?.phase, 3, 'the card is stamped with the true lane');
  service.approvals.disarm();
  service.close();
});

test('a wrapper hiding a denied payload is never a silent yes — the card stays human', async () => {
  rmSync(POLICY_PATH, { force: true });
  const { service } = serviceOn({});
  // `git push` is deny by default; `flock` hides it one word in. classifyTool
  // says ask (guarded wrapper fallback); auto-grant must refuse to answer it.
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse({ tool_name: 'Bash', tool_input: { command: 'flock /tmp/l git push origin main' } }, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'the wall gets a person, not a standing yes');
  service.approvals.disarm();
  service.close();
});

test('a clean wrapper auto-grants — the same benefit of the doubt trusted gives it, with an audit trail', async () => {
  rmSync(POLICY_PATH, { force: true });
  const { service } = serviceOn({});
  const answer = reply(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock ./job.sh' } }, 'r1',
  ));
  assert.equal(answer.permissionDecision, 'allow');
  assert.match(answer.permissionDecisionReason, /auto-grant/);
  service.close();
});

test('ACC-8.7 (TRS-4): with auto-grant ON at every level and the carve-out on, git push and gh pr create still raise a card — auto-grant never answers the publishing asks', async () => {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: true })}\n`, 'utf8');
  write(planPolicyPath('demo'), { autoApprove: true });
  const { service, noted, events } = serviceOn({
    gitMode: 'new-branch', openPr: true, phaseOptions: { 2: { autoApprove: true } },
  });
  try {
    for (const [command, rule] of [['git push origin work', 'Bash(git push:*)'], ['gh pr create --fill', 'Bash(gh pr create:*)']] as const) {
      const pending = Symbol('still asking');
      const outcome = await Promise.race([
        service.decideToolUse({ tool_name: 'Bash', tool_input: { command } }, 'r1'),
        new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
      ]);
      assert.equal(outcome, pending, `${command} is a person's tap, whatever auto-grant says`);
      const card = service.approvals.pending().find((approval) => (approval.tool?.input as { command?: string }).command === command);
      assert.ok(card, `${command} raised a real card`);
      assert.equal(card?.matched, rule, 'and the card names the rule that asked');
    }
    assert.equal(noted.filter((n) => n.event === 'phase.approval-auto-granted').length, 0, 'nothing was granted');
    assert.equal(
      events.filter((e) => e.name === 'notification' && (e.data as { category?: string }).category === 'approval').length, 2,
      'each raised card went out once on the approval channel',
    );
  } finally {
    service.approvals.disarm();
    service.close();
    rmSync(POLICY_PATH, { force: true });
    rmSync(planPolicyPath('demo'), { force: true });
  }
});

test('ACC-8.7 (TRS-4): a plan whose permission.destructive row allows the rule lets auto-grant answer it — with matched, and exactly one approval notification', async () => {
  rmSync(POLICY_PATH, { force: true });
  const manifest = {
    decisions: [{ key: 'permission.destructive', state: 'answered', source: 'plan', value: 'deny; allow `Bash(gh pr create:*)`' }],
  };
  const { service, noted, events } = serviceOn({ gitMode: 'new-branch', openPr: true, manifest });
  try {
    const answer = reply(await service.decideToolUse(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } }, 'r1',
    ));
    assert.equal(answer.permissionDecision, 'allow');
    assert.match(answer.permissionDecisionReason, /auto-grant/);
    const granted = noted.find((n) => n.event === 'phase.approval-auto-granted');
    assert.equal(granted?.data.matched, 'Bash(gh pr create:*)');
    assert.deepEqual((granted?.data.exception as { rule: string }).rule, 'Bash(gh pr create:*)');
    const card = service.approvals.recent().at(-1);
    assert.equal(card?.matched, 'Bash(gh pr create:*)');
    assert.match(String(card?.reason), /permission\.destructive exception/);
    const announced = events.filter((e) => e.name === 'notification' && (e.data as { category?: string }).category === 'approval');
    assert.equal(announced.length, 1, 'a grant under an exception is announced, once');
    assert.equal((announced[0].data as { title?: string }).title, 'Published under a plan exception');
    assert.ok(!events.some((e) => e.name === 'approval'), 'and never queued as a question');

    // The exception names ONE rule: the other publishing ask is still a card.
    const pending = Symbol('still asking');
    const outcome = await Promise.race([
      service.decideToolUse({ tool_name: 'Bash', tool_input: { command: 'git push origin work' } }, 'r1'),
      new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
    ]);
    assert.equal(outcome, pending);
  } finally {
    service.approvals.disarm();
    service.close();
  }
});

test('a call whose token names no run never auto-grants — an anomaly stays in front of a person', async () => {
  rmSync(POLICY_PATH, { force: true });
  const service = new Service(flags as never);
  const pending = Symbol('still asking');
  // WebFetch is on the shipped ask list, and this token matches nothing.
  const outcome = await Promise.race([
    service.decideToolUse({ tool_name: 'WebFetch', tool_input: { url: 'https://x.test' } }, 'nobody'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending);
  service.approvals.disarm();
  service.close();
});

// The instance state dir is shared by every Service above; the redirect at the
// top of this file is what keeps all of it out of the operator's real state.
test('scratch state is our own', () => {
  assert.ok(INSTANCE_STATE_DIR.startsWith(STATE_HOME));
});
