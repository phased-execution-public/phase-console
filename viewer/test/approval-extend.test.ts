/**
 * Extend: a card's deadline moves inside the live hook window, and past it the
 * card STANDS — answerable for twelve hours — and resumes its phase with a
 * one-time grant when a person allows it (control-tower phase 97, #140 — AP-3,
 * AP-4).
 *
 * The approval routes answered allow or deny and nothing else, so an operator
 * who could not decide yet could only lose the card. The hard limit is real:
 * the hook's timeout is fixed in the session's hook config at spawn, and an
 * answer after it cannot reach the session (the call fails open). So Extend
 * never pretends to move it — a deadline asked for past it answers the hook no
 * at the limit, and the card itself stays up as a standing card.
 */
import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-approval-extend-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const {
  Approvals, EXTEND_CHOICES_MIN, EXTEND_MAX_MIN, HOOK_TIMEOUT_SECONDS, STANDING_REASON, WIDEN_ANSWER_BY_MS,
} = await import('../server/runner/approvals.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { applySettings, RUN_SETTING_KEYS } = await import('../server/runner/runner-core.ts');
const { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } = await import('../shared/run-settings.js');
type RunState = import('../server/runner/state.ts').RunState;
type Approval = import('../server/runner/approvals.ts').Approval;

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

let files = 0;
const pendingFile = (): string => join(STATE_HOME, `broker-${++files}`, 'pending.json');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toolCard = (over: Record<string, unknown> = {}) => ({
  runId: 'r1', slug: 'alpha', phase: 2, kind: 'tool' as const,
  title: 'Bash: git push origin main', detail: 'Phase 2 of alpha wants to use Bash.', evidence: [],
  tool: { name: 'Bash', input: { command: 'git push origin main' } },
  ...over,
});

async function held<T>(work: () => Promise<T>): Promise<T> {
  const keep = setInterval(() => {}, 25);
  try { return await work(); } finally { clearInterval(keep); }
}

test('AP-3: the Extend buttons are half an hour and two hours; one Extend asks for at most a standing card\'s twelve hours', () => {
  assert.deepEqual([...EXTEND_CHOICES_MIN], [30, 120]);
  assert.equal(EXTEND_MAX_MIN * 60_000, WIDEN_ANSWER_BY_MS);
});

test('AP-3: a tool card carries its hook call\'s hard limit, and Extend moves the deadline inside it — recorded, the clock re-armed', async () => {
  const events: string[] = [];
  const approvals = new Approvals({ record: (event) => { events.push(event); } }, pendingFile());
  await held(async () => {
    // A per-run default far shorter than the hook's hour, so there is room to extend into.
    const { approval, decided } = approvals.request(toolCard(), 60);
    assert.equal(
      Date.parse(approval.hookDeadline!) - Date.parse(approval.createdAt), (HOOK_TIMEOUT_SECONDS - 20) * 1000,
      'the hard limit is the hook\'s own timeout, less the margin the broker always answers inside',
    );
    const before = approval.expiresAt;
    const answer = approvals.extend(approval.id, 30, 'console');
    assert.equal(answer.ok, true);
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(before), 30 * 60_000, '+30 min from the old deadline');
    assert.equal(approval.standsUntil, undefined, 'inside the window it is still a live hook card');
    assert.deepEqual(approval.extended?.map((e) => [e.by, e.minutes, e.to]), [['console', 30, approval.expiresAt]]);
    assert.ok(events.includes('extended'), 'the journal side is told');
    await sleep(120);
    assert.equal(approvals.isPending(approval.id), true, 'the old 60 ms deadline no longer times it out');
    assert.equal(approvals.settle(approval.id, 'allow', 'console'), true);
    assert.equal((await decided).decision, 'allow');
  });
});

test('AP-3: Extend refuses what it cannot honour — an unknown card, a bad number, a relayed question', () => {
  const approvals = new Approvals({}, pendingFile());
  const card = approvals.request(toolCard(), 60_000).approval;
  assert.equal(approvals.extend('no-such-card', 30, 'console').ok, false);
  for (const minutes of [0, -5, 1.5, EXTEND_MAX_MIN + 1, Number.NaN]) {
    assert.equal(approvals.extend(card.id, minutes, 'console').ok, false, `${minutes} minutes`);
  }
  const question = approvals.request(toolCard({ kind: 'question' }), 60_000).approval;
  const refused = approvals.extend(question.id, 30, 'console');
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /answered by rule/);
  approvals.settle(card.id, 'deny', 'console');
  approvals.settle(question.id, 'deny', 'console');
});

test('AP-4: past the hook window the hook is told no at its limit, and the card STANDS for 12 h — a run ending does not answer it, a person still can', async () => {
  const events: string[] = [];
  const resolved: Approval[] = [];
  const approvals = new Approvals({
    record: (event) => { events.push(event); },
    resolved: (approval) => { resolved.push({ ...approval }); },
  }, pendingFile());
  approvals.hookWindowMs = 80;
  await held(async () => {
    const { approval, decided } = approvals.request(toolCard(), 40);
    const answer = approvals.extend(approval.id, 120, 'console');
    assert.equal(answer.ok, true);
    assert.equal(answer.ok && answer.standing, true, 'the answer says the card will stand');
    assert.equal(approval.expiresAt, approval.hookDeadline, 'the hook is still answered at its hard limit');
    assert.equal(Date.parse(approval.standsUntil!) - Date.parse(approval.hookDeadline!), WIDEN_ANSWER_BY_MS);
    assert.match(approval.onTimeout ?? '', /stands until \d\d:\d\dZ/, 'and the card says so before it happens');

    const hook = await decided;
    assert.deepEqual([hook.decision, hook.by, hook.reason], ['deny', 'standing', STANDING_REASON],
      'silence fails open, so the session is told no — with the reason');
    assert.equal(approvals.isPending(approval.id), true, 'the CARD stands');
    assert.equal(approval.standing, true);
    assert.ok(approval.converted?.at, 'and says when it outlived its hook call');
    assert.equal(approval.expiresAt, approval.standsUntil, 'on a standing card\'s clock');
    assert.ok(events.includes('standing'));
    assert.equal(resolved.length, 0, 'answering the hook is not deciding the card');

    approvals.disarm('r1');
    assert.equal(approvals.isPending(approval.id), true, 'the run\'s loop ending does not answer a standing card');
    assert.equal(approvals.settle(approval.id, 'allow', 'console'), true);
    assert.equal(resolved.at(-1)?.status, 'allow');
    assert.ok(resolved.at(-1)?.converted, 'the decision is on the card that stood');
  });
});

/* ------------------------------------------------------------------ *
 * Through the service and the route
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-27
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |
| 2 | two | 1 | — | app | it still works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S
`;

function service() {
  const root = mkdtempSync(join(tmpdir(), 'pc-approval-extend-root-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => null) as never;
  assert.equal(svc.open(root).ok, true);
  return { svc, root, cleanup: () => { svc.approvals.disarm(); rmSync(root, { recursive: true, force: true }); } };
}

test('AP-4: allowing a standing card grants that one call ONCE and resumes its phase through the Resume press', async () => {
  const { svc, cleanup } = service();
  try {
    const resumed: Array<{ slug: string; phase: number; mode: string; opts: { instruction?: string } }> = [];
    (svc as unknown as Record<string, unknown>).pressResume = async (
      slug: string, phase: number, mode: string, opts: { instruction?: string },
    ) => { resumed.push({ slug, phase, mode, opts }); return { ok: true }; };
    svc.approvals.hookWindowMs = 50;
    const { approval, decided } = svc.approvals.request(toolCard(), 20);
    const extended = svc.extendApproval(approval.id, 120, 'console');
    assert.equal(extended.ok, true);
    await held(async () => { await decided; });
    assert.equal(svc.approvals.isPending(approval.id), true, 'standing');

    const input = { command: 'git push origin main' };
    assert.equal(svc.takeOneTimeGrant('r1', 2, 'Bash', input), false, 'no grant before anyone allowed it');
    const answered = svc.decideApproval(approval.id, 'allow', 'console', undefined, undefined,
      { by: 'console', via: 'console', origin: 'approval-extend.test' } as never);
    assert.equal(answered.ok, true);
    await sleep(10);
    assert.deepEqual(resumed.map((r) => [r.slug, r.phase, r.mode]), [['alpha', 2, 'resume']], 'the phase is resumed');
    assert.match(resumed[0].opts.instruction ?? '', /granted once/);
    assert.equal(svc.takeOneTimeGrant('r1', 2, 'Bash', input), approval.id, 'the same call is granted — by that card');
    assert.equal(svc.takeOneTimeGrant('r1', 2, 'Bash', input), false, '…once');
    assert.equal(svc.takeOneTimeGrant('r1', 2, 'Bash', { command: 'git push --force' }), false, 'and only that call');
  } finally { cleanup(); }
});

test('AP-4: denying a standing card grants nothing and resumes nothing — the park stands', async () => {
  const { svc, cleanup } = service();
  try {
    let pressed = 0;
    (svc as unknown as Record<string, unknown>).pressResume = async () => { pressed += 1; return { ok: true }; };
    svc.approvals.hookWindowMs = 50;
    const { approval, decided } = svc.approvals.request(toolCard(), 20);
    svc.extendApproval(approval.id, 120, 'console');
    await held(async () => { await decided; });
    assert.equal(svc.decideApproval(approval.id, 'deny', 'console', undefined).ok, true);
    await sleep(10);
    assert.equal(pressed, 0);
    assert.equal(svc.takeOneTimeGrant('r1', 2, 'Bash', { command: 'git push origin main' }), false);
  } finally { cleanup(); }
});

test('AP-3: POST /api/approvals/:id/extend {minutes} answers the moved card; a refusal carries its status', async () => {
  const calls: Array<[string, number, string]> = [];
  const service = {
    flags: { allowRun: true },
    // Past the "no source directory is open" door every /api route below it sits behind.
    store: {},
    extendApproval: (id: string, minutes: number, by: string) => {
      calls.push([id, minutes, by]);
      return minutes === 30
        ? { ok: true, approval: { id, expiresAt: '2026-09-27T12:00:00.000Z' }, standing: false }
        : { ok: false, status: 400, error: 'minutes must be a whole number from 1 to 720' };
    },
  };
  const server = createServer((req, res) => {
    void handleApi({ service } as never, req, res, new URL(`http://127.0.0.1${req.url}`)).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const post = (minutes: unknown) => fetch(`http://127.0.0.1:${port}/api/approvals/card-1/extend`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-phase-console': '1' },
      body: JSON.stringify({ minutes }),
    });
    const ok = await post(30);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, approval: { id: 'card-1', expiresAt: '2026-09-27T12:00:00.000Z' }, standing: false });
    const bad = await post('lots');
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'card-1');
    assert.ok(Number.isNaN(calls[1][1]), 'the route passes the number through; the broker judges it');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('AP-3: a per-run default — how long this run\'s cards wait, set at start or mid-run, cleared back to the hook\'s hour', () => {
  assert.ok((RUN_START_FIELDS as readonly string[]).includes('approvalTimeoutMinutes'), 'a start may choose it');
  assert.ok((RUN_SETTINGS_FIELDS as readonly string[]).includes('approvalTimeoutMinutes'), 'and a running run may change it');
  assert.ok((RUN_SETTING_KEYS as readonly string[]).includes('approvalTimeoutMinutes'), 'a resume keeps it');
  const state = { approvalTimeoutMinutes: undefined } as unknown as RunState;
  applySettings(state, { approvalTimeoutMinutes: 20 });
  assert.equal(state.approvalTimeoutMinutes, 20);
  applySettings(state, { approvalTimeoutMinutes: null });
  assert.equal('approvalTimeoutMinutes' in state, false, '`null` puts the cards back on the hook call\'s hour');
  // …which is also the ceiling: a default can never outlive the hook call.
  const approvals = new Approvals({}, pendingFile());
  const card = approvals.request(toolCard(), 24 * 60 * 60_000).approval;
  assert.equal(card.expiresAt, card.hookDeadline, 'a default longer than the hook call stops at its hard limit');
  approvals.settle(card.id, 'deny', 'console');
});
