/**
 * Plan mode as a choice of its own (control-tower phase 11, #34).
 *
 * A plan file can say which permission mode its phases need, a run can
 * default it, and a plan-mode phase under autopilot has somebody to hand its
 * plan to: `ExitPlanMode` reaches the hook, the console captures the plan and
 * parks the phase `plan-approval`, and a person's Approve resumes the SAME
 * session in `acceptEdits`.
 *
 * The CLI's behaviour is MEASURED, not assumed — `fixtures/spikes/exit-plan-mode.json`
 * (CLI 2.1.280): the tool exists only for a session with a permission host;
 * the hook receives `{plan, planFilePath}`; a deny reaches the model as a tool
 * error and the session ends its turn; `--resume <same id> --permission-mode
 * acceptEdits` carries the plan out. The PM ids are the plan's §Phase 11
 * exit criteria.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_OUTCOME_FILE']) delete process.env[key];

const { SKILL_DIR } = await import('../server/config.ts');
const {
  resolvePermissionMode, RUN_START_FIELDS, RUN_SETTINGS_FIELDS, START_ONLY_FIELDS, DEFAULT_PERMISSION_MODE,
} = await import('../shared/run-settings.js');
const { DECISION_KEYS } = await import('../shared/decisions-model.js');
const { DECISION_ANSWERS, POLICY_DEFAULTS } = await import('../shared/policy-model.js');
const {
  HALT_KINDS, PHASE_HALT_KINDS, KIND_PROFILE,
} = await import('../shared/recovery-model.js');
const {
  classifyTool, carvedPolicy, loadPolicy, HOOK_TOOLS, PLAN_CLASS, PRE_TOOL_USE_MATCHER, planRule,
} = await import('../server/runner/approvals.ts');
const { buildArgv } = await import('../server/runner/spawn.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { Service } = await import('../server/service.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { outcomeFileFor, readOutcome } = await import('../server/runner/outcome.ts');
const {
  planOf, planDigest, planHoldOutcome, PLAN_APPROVAL_NEED, planApprovedInstruction,
} = await import('../server/runner/plan-approval.ts');

const SPIKE = JSON.parse(readFileSync(new URL('./fixtures/spikes/exit-plan-mode.json', import.meta.url), 'utf8'));
/** The hook body the CLI really sent for `ExitPlanMode` (scrubbed). */
const EXIT_PLAN_BODY = SPIKE.arms.host.hookBody as Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * The spike, as the contract the code is written against
 * ------------------------------------------------------------------ */

test('the spike: ExitPlanMode needs a host, carries {plan, planFilePath}, and a deny ends the turn', () => {
  assert.equal(SPIKE.verdict, 'needs-host');
  assert.deepEqual(SPIKE.arms.floor.offered, [], 'on the floor the CLI offers no ExitPlanMode');
  assert.match(SPIKE.arms.floor.toolError, /ExitPlanMode is disabled for this session/);
  assert.ok(SPIKE.arms.host.offered.includes('ExitPlanMode'), 'with a permission host it is offered');
  assert.equal(EXIT_PLAN_BODY.tool_name, 'ExitPlanMode');
  assert.equal(EXIT_PLAN_BODY.permission_mode, 'plan');
  assert.deepEqual(Object.keys(EXIT_PLAN_BODY.tool_input as object).sort(), ['plan', 'planFilePath']);
  assert.equal(SPIKE.arms.host.result.subtype, 'success', 'the session ended its turn after the deny');
  assert.equal(SPIKE.arms.resume.sameSession, true);
  assert.equal(SPIKE.arms.resume.initPermissionMode, 'acceptEdits');
  // Nothing identifying survived the scrub.
  assert.doesNotMatch(JSON.stringify(SPIKE), /\/Users\//);
});

/* ------------------------------------------------------------------ *
 * PM-1 — the resolution order
 * ------------------------------------------------------------------ */

test('PM-1 — retry, run per-phase, plan bullet, plan line, run default, then acceptEdits', () => {
  const r = resolvePermissionMode;
  assert.deepEqual(r(), { value: 'acceptEdits', source: undefined }, 'nothing spoke: the machine default');
  assert.equal(DEFAULT_PERMISSION_MODE, 'acceptEdits');
  assert.deepEqual(r({ runDefault: 'auto' }), { value: 'auto', source: 'default' });
  assert.deepEqual(r({ planLine: 'plan', runDefault: 'auto' }), { value: 'plan', source: 'plan' }, 'the plan line beats the run default');
  assert.deepEqual(
    r({ planPhase: 'acceptEdits', planLine: 'plan', runDefault: 'auto' }), { value: 'acceptEdits', source: 'plan' },
    'the bullet overrides the line — never a union',
  );
  assert.deepEqual(r({ run: 'dontAsk', planPhase: 'plan' }), { value: 'dontAsk', source: 'run' }, "the run's per-phase choice beats the plan");
  assert.deepEqual(r({ retry: 'acceptEdits', run: 'plan', planPhase: 'plan' }), { value: 'acceptEdits', source: 'retry' });
  // A word that is not a mode is not an answer at any level — it falls through.
  assert.deepEqual(
    r({ retry: 'guarded', run: 'bypassPermissions', planPhase: 'paln', planLine: 'plan' }), { value: 'plan', source: 'plan' },
  );
});

/* ------------------------------------------------------------------ *
 * PM-2 — the run door takes a mode, refuses a word that is not one
 * ------------------------------------------------------------------ */

type Captured = { status: number; body: unknown };
const DECIDED = { resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 0 }] };

async function call(service: unknown, method: string, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null };
  const sent = /\/start$/.test(path) ? { ...DECIDED, ...body } : body;
  const req = {
    method,
    headers: { 'x-phase-console': '1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(sent)); },
  };
  const chunks: Buffer[] = [];
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) { if (chunk) chunks.push(Buffer.from(chunk as never)); },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  const text = Buffer.concat(chunks).toString('utf8');
  try { out.body = JSON.parse(text); } catch { out.body = text; }
  return out;
}

function fakeService(over: Record<string, unknown> = {}) {
  const started: Record<string, unknown>[] = [];
  const configured: Record<string, unknown>[] = [];
  return {
    flags: { allowWrites: true, allowRun: true, maxSessions: 4 },
    store: { get: () => ({}), list: () => [] },
    accounts: { has: () => false },
    startRun: async (_slug: string, options: Record<string, unknown>) => { started.push(options); return { id: 'r1' }; },
    configureRun: (_slug: string, patch: Record<string, unknown>) => { configured.push(patch); return { id: 'r1' }; },
    verificationPreflight: async () => [],
    runFor: async () => null,
    _started: started,
    _configured: configured,
    ...over,
  };
}
const errorOf = (out: Captured) => String((out.body as { error?: string })?.error ?? '');

test('PM-2 — permissionMode rides start and settings; a word that is not a mode is a 400, never dropped', async () => {
  assert.ok(RUN_START_FIELDS.includes('permissionMode') && RUN_SETTINGS_FIELDS.includes('permissionMode'));
  assert.ok(!START_ONLY_FIELDS.includes('permissionMode'), 'a run default is patchable mid-run');

  for (const mode of ['acceptEdits', 'auto', 'dontAsk', 'plan', 'manual']) {
    const service = fakeService();
    assert.equal((await call(service, 'POST', '/api/run/demo/start', { permissionMode: mode })).status, 200, mode);
    assert.equal(service._started[0].permissionMode, mode);
  }
  const bad = await call(fakeService(), 'POST', '/api/run/demo/start', { permissionMode: 'guarded' });
  assert.equal(bad.status, 400);
  assert.match(errorOf(bad), /permissionMode must be one of: acceptEdits, auto, dontAsk, plan, manual/);
  // Bypass is the absence of a mode, so the pair is a contradiction — refused
  // by name rather than letting the profile silently win at the spawn.
  const both = await call(fakeService(), 'POST', '/api/run/demo/start', { permissionMode: 'plan', permissionProfile: 'bypass' });
  assert.equal(both.status, 400);
  assert.match(errorOf(both), /cannot be combined with the bypass profile/);

  const settings = fakeService();
  assert.equal((await call(settings, 'POST', '/api/run/demo/settings', { permissionMode: 'plan' })).status, 200);
  assert.equal(settings._configured[0].permissionMode, 'plan');
  assert.equal((await call(settings, 'POST', '/api/run/demo/settings', { permissionMode: '' })).status, 200);
  assert.equal(settings._configured[1].permissionMode, '', 'empty clears the run default back to acceptEdits');
  assert.equal((await call(fakeService(), 'POST', '/api/run/demo/settings', { permissionMode: 'yolo' })).status, 400);
});

/* ------------------------------------------------------------------ *
 * PM-3 — the runner boards the resolved mode, and a plan-mode phase a host
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; state: string };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A one-phase stub plan whose engine answers from a `done` file. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-planmode-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready:"; else echo "done:"; echo "ready: 1"; fi
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  for (const name of ['phase-lock.sh', 'next-phase-prompt.sh', 'new-handoff.sh']) write(join(scripts, name), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, state };
}

function outcome(sessionId = 'sess-plan-0001'): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId, costUsd: 0, turns: 1, resultText: 'Plan is written and awaiting approval.',
    durationMs: 10, argv: ['-p', '<prompt>'],
  } as SpawnOutcome;
}

/** A broker just real enough for the run's settings files to be written. */
const APPROVALS = {
  arm: () => 'tok', liveToken: () => 'tok', disarm: () => {}, offer: () => ({}), pending: () => [],
  // The loop's ending (#74) releases the run's token through these two.
  release: () => 'disarmed', heldTokens: () => [],
};

function runnerFor(r: Repo, deps: Record<string, unknown>, session: (req: SpawnRequest, runner: InstanceType<typeof Runner>) => void) {
  const requests: SpawnRequest[] = [];
  let self: InstanceType<typeof Runner> | null = null;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    requests.push(request);
    session(request, self!);
    return outcome();
  };
  self = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`', ...deps,
  } as never);
  return { runner: self, requests };
}

const finishes = (r: Repo) => (request: SpawnRequest) => {
  if (/BOOT phase 1/.test(request.prompt)) writeFileSync(join(r.state, 'done'), '1\n', { flag: 'a' });
};

test('PM-3 — the plan\'s mode boards the phase; the run default and a Retry take their places in the order', async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>, string | undefined][] = [
    [{}, {}, undefined],
    [{ phaseDefaults: () => ({ permissionMode: 'plan' }) }, {}, 'plan'],
    [{}, { permissionMode: 'auto' }, 'auto'],
    [{ phaseDefaults: () => ({ permissionMode: 'dontAsk' }) }, { permissionMode: 'auto' }, 'dontAsk'],
    [{ phaseDefaults: () => ({ permissionMode: 'plan' }) }, { phaseOptions: { 1: { permissionMode: 'acceptEdits' } } }, 'acceptEdits'],
  ];
  for (const [deps, options, want] of cases) {
    const r = repo();
    try {
      const { runner, requests } = runnerFor(r, deps, finishes(r));
      await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1], ...options } as never);
      await runner.wait();
      assert.equal(requests[0]?.permissionMode, want, JSON.stringify({ deps: Object.keys(deps), options }));
      assert.ok(buildArgv({ ...requests[0], prompt: '' } as SpawnRequest).join(' ').includes(`--permission-mode ${want ?? 'acceptEdits'}`));
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  }
});

test('PM-3 — a plan-mode phase boards with the relay\'s host and the plan-host settings, even with the relay off', async () => {
  const r = repo();
  try {
    // Read while the session lives: the run's teardown sweeps both of its
    // settings files, the plan-host variant included.
    let settings: { hooks: Record<string, { matcher: string }[]> } | null = null;
    const { runner, requests } = runnerFor(r, {
      phaseDefaults: () => ({ permissionMode: 'plan' }),
      approvals: APPROVALS, origin: 'http://127.0.0.1:9',
      cliVersion: async () => '2.1.280', initVersion: () => '2.1.280',
    }, (request) => {
      if (request.settings) settings = JSON.parse(readFileSync(String(request.settings), 'utf8'));
      finishes(r)(request);
    });
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1] } as never);
    await runner.wait();
    const sent = requests[0]!;
    assert.equal(sent.permissionMode, 'plan');
    assert.equal(sent.permissionPromptTool, 'mcp__pcrelay__hold', 'the host is what makes the CLI offer ExitPlanMode');
    assert.match(String(sent.settings), /-plan\.json$/, 'the plan-host settings variant, with the PermissionRequest hook');
    assert.ok(settings, 'the variant was written before the session started');
    assert.ok(settings!.hooks.PermissionRequest, 'a host that never answers needs the hook to answer instead');
    assert.match(settings!.hooks.PreToolUse[0].matcher, /ExitPlanMode/);
    assert.equal(runner.current()?.relayArming?.armed ?? false, false, "the RUN's relay is untouched");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * PM-4 — ExitPlanMode is held, on every profile, and the hook captures it
 * ------------------------------------------------------------------ */

test('PM-4 — ExitPlanMode reaches the hook and is classified hold on every profile', () => {
  assert.deepEqual(PLAN_CLASS, ['ExitPlanMode']);
  assert.ok(HOOK_TOOLS.includes('ExitPlanMode'));
  assert.ok(PRE_TOOL_USE_MATCHER.split('|').includes('ExitPlanMode'));
  for (const profile of ['guarded', 'trusted', 'bypass'] as const) {
    const policy = carvedPolicy(loadPolicy(), profile, false);
    assert.equal(classifyTool('ExitPlanMode', EXIT_PLAN_BODY.tool_input, policy, profile), 'hold', profile);
    // Not even the operator's own allow list answers it — handing a plan to a
    // person is not a permission.
    assert.equal(classifyTool('ExitPlanMode', EXIT_PLAN_BODY.tool_input, { ...policy, always: ['ExitPlanMode'] }, profile), 'hold');
  }
  assert.equal(planRule('ExitPlanMode', {}), 'ExitPlanMode');
  assert.equal(planRule('Bash', {}), null);
  assert.deepEqual(planOf(EXIT_PLAN_BODY.tool_input), {
    text: (EXIT_PLAN_BODY.tool_input as { plan: string }).plan,
    planFilePath: (EXIT_PLAN_BODY.tool_input as { planFilePath: string }).planFilePath,
  });
  assert.equal(planOf({ plan: '   ' }), null, 'an empty plan is no plan');
});

type Noted = { event: string; data: Record<string, unknown>; phase?: number };
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null };

function serviceWithPlanRunner(decisions: Record<string, unknown>[] = []) {
  const service = new Service(flags as never);
  const calls: { presented: unknown[]; held: unknown[]; continued: unknown[] } = { presented: [], held: [], continued: [] };
  const presented = { sha: planDigest('the plan'), bytes: 8, path: '/tmp/x-plan.md', truncated: false };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: 'trusted',
      phases: { 2: { phase: 2, status: 'running', sessionId: EXIT_PLAN_BODY.session_id } },
      manifest: { decisions },
    }),
    note: () => {},
    park: () => {},
    isSpending: () => false,
    presentPlan: (...args: unknown[]) => { calls.presented.push(args); return presented; },
    holdPlan: (...args: unknown[]) => { calls.held.push(args); },
    continuePlan: (...args: unknown[]) => { calls.continued.push(args); },
  });
  return { service, calls, presented };
}

const hookAnswer = (reply: Record<string, unknown>) => (reply as {
  hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
}).hookSpecificOutput;

test('PM-4 — the hook captures the plan, holds it for a person, and denies with the instruction to end the turn', async () => {
  const { service, calls, presented } = serviceWithPlanRunner();
  const answer = hookAnswer(await service.decideToolUse(EXIT_PLAN_BODY, 'r1'));
  assert.equal(answer.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, /captured your plan/);
  assert.match(answer.permissionDecisionReason, /NOT a rejection/);
  assert.match(answer.permissionDecisionReason, /End your turn now/);
  assert.equal(calls.presented.length, 1);
  const [phase, plan, sessionId] = calls.presented[0] as [number, { text: string }, string];
  assert.equal(phase, 2);
  assert.equal(plan.text, (EXIT_PLAN_BODY.tool_input as { plan: string }).plan);
  assert.equal(sessionId, EXIT_PLAN_BODY.session_id);
  assert.deepEqual(calls.held[0], [2, presented, EXIT_PLAN_BODY.session_id]);
  assert.equal(calls.continued.length, 0);
});

test('PM-4 — a plan no run of this console drives is let through, never held for nobody', async () => {
  const service = new Service(flags as never);
  const answer = hookAnswer(await service.decideToolUse(EXIT_PLAN_BODY, 'unknown-run'));
  assert.equal(answer.permissionDecision, 'allow');
});

/* ------------------------------------------------------------------ *
 * PM-5 — the runner keeps the text, declares, and parks `plan-approval`
 * ------------------------------------------------------------------ */

test('PM-5 — presentPlan keeps the text and journals it; holdPlan declares needs-human --needs plan-approval', async () => {
  const r = repo();
  try {
    const text = (EXIT_PLAN_BODY.tool_input as { plan: string }).plan;
    let presented: ReturnType<InstanceType<typeof Runner>['presentPlan']> = null;
    let declared: ReturnType<typeof readOutcome> = null;
    const { runner } = runnerFor(r, { phaseDefaults: () => ({ permissionMode: 'plan' }) }, (request, self) => {
      if (!/BOOT phase 1/.test(request.prompt)) return;
      // What the hook does when this session calls ExitPlanMode.
      presented = self.presentPlan(1, { text, planFilePath: '<config>/plans/demo.md' }, 'sess-plan-0001');
      self.holdPlan(1, presented!, 'sess-plan-0001');
      const state = self.current()!;
      declared = readOutcome(outcomeFileFor(state.root, state.slug, state.id, 1), { slug: 'demo', phase: 1 });
    });
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1] } as never);
    await runner.wait();

    assert.ok(presented, 'the plan was kept');
    const kept = presented as unknown as { sha: string; bytes: number; path: string };
    assert.equal(kept.sha, planDigest(text));
    assert.equal(kept.bytes, Buffer.byteLength(text));
    assert.equal(readFileSync(kept.path, 'utf8').trimEnd(), text.trimEnd());
    assert.ok(declared, 'the console declared the outcome the Stop hook and the runner read');
    const d = declared as unknown as { status: string; needs: string; session_id: string };
    assert.equal(d.status, 'needs-human');
    assert.equal(d.needs, PLAN_APPROVAL_NEED);
    assert.equal(d.session_id, 'sess-plan-0001');

    // The declared-outcome path took the park — under its own kind.
    const state = runner.current()!;
    const record = state.phases['1']!;
    assert.equal(record.status, 'parked');
    assert.equal(state.halt?.kind, 'plan-approval');
    assert.equal(record.planApproval?.state, 'pending');
    assert.equal(record.declared?.needs, PLAN_APPROVAL_NEED);
    const errand = state.recoveries?.['1']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:gate', 'the gate sub-kind: an empty ladder, a person only');
    assert.match(String(errand?.need), new RegExp(kept.sha.slice(0, 12)));
    assert.match(String(errand?.how), /Approve/);

  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('PM-5 — the halt kind and the decision key are owned vocabulary', () => {
  assert.ok(HALT_KINDS.includes('plan-approval'));
  assert.ok(PHASE_HALT_KINDS.includes('plan-approval'), 'a held plan is about the phase');
  assert.deepEqual(KIND_PROFILE['plan-approval'], { sessionShaped: false, humanClass: null, autoClass: null });
  assert.ok(DECISION_KEYS.includes('plan-approval'));
  assert.deepEqual([...DECISION_ANSWERS['plan-approval']!], ['hold', 'continue']);
  assert.equal(POLICY_DEFAULTS['plan-approval'], 'hold', 'a presented plan waits for a person unless the plan says otherwise');
  const outcomeShape = planHoldOutcome({ slug: 'demo', phase: 3, sha: 'a'.repeat(64), bytes: 10 });
  assert.equal(outcomeShape.version, 1);
  assert.equal(outcomeShape.needs, 'plan-approval');
});

/* ------------------------------------------------------------------ *
 * PM-6 — the inbox row carries Approve and Reject
 * ------------------------------------------------------------------ */

test('PM-6 — a held plan\'s errand row offers Approve and Reject, live run or stopped', () => {
  for (const status of ['parked', 'running']) {
    const view = buildInbox({
      flags: { allowRun: true },
      runs: [{
        id: 'r1', slug: 'demo', status,
        phases: { 2: { phase: 2, status: 'parked', planApproval: { state: 'pending', sha: 'b'.repeat(64), bytes: 9, path: '/x' } } },
        recoveries: { 2: { attempts: 0, errand: { phase: 2, situation: 'blocked-declared:gate', at: '2026-09-23T10:00:00Z', need: 'A decision on the plan', how: 'Approve or Reject' } } },
      }],
    } as never, Date.parse('2026-09-23T10:05:00Z'));
    const row = view.items.find((item) => item.kind === 'errand' && item.phase === 2);
    assert.ok(row, status);
    const verbs = row!.actions.map((action) => action.verb);
    assert.deepEqual(verbs.slice(0, 2), ['approve-plan', 'reject-plan'], status);
    const [approve, reject] = row!.actions;
    assert.equal(approve.endpoint, '/api/run/demo/plan-approval');
    assert.deepEqual(approve.body, { phase: 2, decision: 'approve' });
    assert.deepEqual(reject.body, { phase: 2, decision: 'reject' });
    assert.equal(reject.says?.field, 'reason', 'a rejection carries its reason');
  }
});

/* ------------------------------------------------------------------ *
 * PM-7 — Approve resumes the SAME session in acceptEdits; Reject records why
 * ------------------------------------------------------------------ */

function decidingService(pending = true) {
  const service = new Service(flags as never);
  const decided: { event: string; data: Record<string, unknown>; phase: number; state: Record<string, unknown> }[] = [];
  const recovered: unknown[][] = [];
  const state = {
    id: 'r1', slug: 'demo', status: 'parked',
    phases: { 2: { phase: 2, status: 'parked', sessionId: 'sess-plan-0001', planApproval: { state: pending ? 'pending' : 'approved', sha: 'c'.repeat(64), bytes: 12, path: '/x', at: 'then' } } },
  };
  const runner = {
    busy: () => false,
    current: () => state,
    note: () => {},
    park: () => {},
    isSpending: () => false,
    recordPlanDecision: (phase: number, decide: (s: unknown) => void, event: string, data: Record<string, unknown>) => {
      decide(state);
      decided.push({ event, data, phase, state });
    },
  };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', runner);
  Object.assign(service as object, {
    root: { ok: true, path: '/tmp' },
    liveRunner: () => runner,
    runnerByRunId: () => runner,
    recoverPhase: async (...args: unknown[]) => { recovered.push(args); return state; },
  });
  return { service, decided, recovered, state };
}

test('PM-7 — Approve journals phase.plan-approved {by} and resumes the same session through the recover verb', async () => {
  const { service, decided, recovered, state } = decidingService();
  const result = await service.decidePlan('demo', 2, 'approve', 'mobin');
  assert.deepEqual(result, { ok: true, decision: 'approve', sha: 'c'.repeat(64) });
  assert.equal(decided[0].event, 'phase.plan-approved');
  assert.equal(decided[0].data.by, 'mobin');
  assert.equal(state.phases[2].planApproval.state, 'approved');
  assert.equal(recovered.length, 1);
  const [slug, phase, mode, opts] = recovered[0] as [string, number, string, { instruction: string; by: string }];
  assert.deepEqual([slug, phase, mode], ['demo', 2, 'resume'], 'the recover verb resumes the phase\'s OWN session');
  assert.equal(opts.by, 'mobin');
  assert.equal(opts.instruction, planApprovedInstruction('mobin', { sha: 'c'.repeat(64) }));
  assert.match(opts.instruction, /acceptEdits/);
});

test('PM-7 — the resumed session is spawned in acceptEdits, named rather than defaulted', () => {
  const source = readFileSync(new URL('../server/runner/runner-control.ts', import.meta.url), 'utf8');
  const resume = source.slice(source.indexOf('protected async resumeWithInstruction('));
  assert.match(resume.slice(0, 12_000), /planApproval\?\.state === 'approved' \? \{ permissionMode: 'acceptEdits' as const \}/);
  const argv = buildArgv({ prompt: '', resume: 'sess-plan-0001', permissionMode: 'acceptEdits' } as SpawnRequest);
  assert.ok(argv.join(' ').includes('--permission-mode acceptEdits'));
  assert.ok(argv.join(' ').includes('--resume sess-plan-0001'));
});

test('PM-7 — Reject journals phase.plan-rejected with its reason and leaves the phase parked', async () => {
  const { service, decided, recovered, state } = decidingService();
  const result = await service.decidePlan('demo', 2, 'reject', 'mobin', 'split the migration first');
  assert.equal(result.ok, true);
  assert.equal(decided[0].event, 'phase.plan-rejected');
  assert.equal(decided[0].data.reason, 'split the migration first');
  assert.equal(state.phases[2].planApproval.state, 'rejected');
  assert.equal(recovered.length, 0, 'nothing resumes on a rejection');
});

test('PM-7 — a decision with no plan pending is a 409, and the route refuses a malformed body', async () => {
  const { service } = decidingService(false);
  const result = await service.decidePlan('demo', 2, 'approve', 'mobin');
  assert.deepEqual(result, { ok: false, status: 409, error: 'no plan waits for a decision on phase 2 of demo' });
  const bad = await call({ ...fakeService(), decidePlan: async () => ({ ok: true }) }, 'POST', '/api/run/demo/plan-approval', { phase: 2, decision: 'maybe' });
  assert.equal(bad.status, 400);
  const routed: unknown[][] = [];
  const good = await call({
    ...fakeService(),
    decidePlan: async (...args: unknown[]) => { routed.push(args); return { ok: true, decision: 'reject', sha: 'x' }; },
  }, 'POST', '/api/run/demo/plan-approval', { phase: 2, decision: 'reject', reason: 'no' });
  assert.equal(good.status, 200);
  assert.deepEqual([routed[0][0], routed[0][1], routed[0][2], routed[0][4]], ['demo', 2, 'reject', 'no']);
});

/* ------------------------------------------------------------------ *
 * PM-8 — `plan-approval: continue` pre-answers: allow and journal, no park
 * ------------------------------------------------------------------ */

test('PM-8 — a Decisions row plan-approval: continue approves at the hook and parks nothing', async () => {
  const { service, calls } = serviceWithPlanRunner([
    { key: 'plan-approval', value: 'continue', owner: 'operator', state: 'answered', blocking: 'no', source: 'plan' },
  ]);
  const answer = hookAnswer(await service.decideToolUse(EXIT_PLAN_BODY, 'r1'));
  assert.equal(answer.permissionDecision, 'allow');
  assert.match(answer.permissionDecisionReason, /plan-approval: continue/);
  assert.equal(calls.presented.length, 1, 'the plan is still kept and journalled');
  assert.equal(calls.continued.length, 1);
  assert.equal(calls.held.length, 0, 'no declaration, so no park');
});

test('PM-8 — continuePlan journals phase.plan-approved {by: policy} and never declares', async () => {
  const r = repo();
  try {
    const { runner } = runnerFor(r, {}, (request, self) => {
      if (!/BOOT phase 1/.test(request.prompt)) return;
      const presented = self.presentPlan(1, { text: 'do the thing' }, 'sess-plan-0001')!;
      self.continuePlan(1, presented, 'plan');
      writeFileSync(join(r.state, 'done'), '1\n', { flag: 'a' });
    });
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1] } as never);
    await runner.wait();
    const state = runner.current()!;
    assert.equal(state.phases['1']?.planApproval?.state, 'continued');
    assert.equal(state.phases['1']?.status, 'done');
    assert.notEqual(state.halt?.kind, 'plan-approval');
    assert.equal(existsSync(outcomeFileFor(state.root, state.slug, state.id, 1)), false);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});
