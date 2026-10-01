/**
 * An approval card warns before it runs out, and says what running out will do
 * (control-tower phase 97, #140 — AP-1, AP-2).
 *
 * vca P22's card auto-denied at 21:09Z on its hour: its countdown lived in the
 * UI alone, no push or inbox row said "this card auto-denies in 10 min", and
 * nothing on the card said the timeout would also park the run. So a card now
 * warns at T-15 and T-5 minutes — through `Service.announce`, which is the push
 * AND the notification inbox — and carries `onTimeout`, the sentence of what
 * its timeout will do, from the moment it is raised.
 */
import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-approval-expiry-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Approvals, EXPIRY_WARNINGS_MS, timeoutConsequence } = await import('../server/runner/approvals.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

let files = 0;
const pendingFile = (): string => join(STATE_HOME, `broker-${++files}`, 'pending.json');

const toolCard = (over: Record<string, unknown> = {}) => ({
  runId: 'r1', slug: 'alpha', phase: 2, kind: 'tool' as const,
  title: 'Bash: git push origin main', detail: 'Phase 2 of alpha wants to use Bash.', evidence: [],
  tool: { name: 'Bash', input: { command: 'git push origin main' } },
  ...over,
});

/** A pending card's timers are unref'd; in a test nothing else holds the loop open. */
async function held<T>(work: () => Promise<T>): Promise<T> {
  const keep = setInterval(() => {}, 25);
  try { return await work(); } finally { clearInterval(keep); }
}

test('AP-1: the warnings are fifteen and five minutes before the deadline', () => {
  assert.deepEqual([...EXPIRY_WARNINGS_MS], [15 * 60_000, 5 * 60_000]);
  assert.deepEqual([...new Approvals({}, pendingFile()).warnLeadsMs], [...EXPIRY_WARNINGS_MS], 'the broker warns on the shipped leads');
});

test('AP-1: a card warns at each lead still ahead of it, in order, once each — and a card answered first is never warned', async () => {
  const warned: Array<{ id: string; lead: number }> = [];
  const approvals = new Approvals({ warn: (approval, lead) => { warned.push({ id: approval.id, lead }); } }, pendingFile());
  approvals.warnLeadsMs = [90, 45];
  await held(async () => {
    const { approval, decided } = approvals.request(toolCard(), 135);
    const answered = approvals.request(toolCard({ title: 'Bash: git commit -m x' }), 135);
    assert.equal(approvals.settle(answered.approval.id, 'allow', 'console'), true);
    const outcome = await decided;
    assert.equal(outcome.by, 'timeout', 'the unanswered card still times out after its warnings');
    assert.deepEqual(warned.map((w) => w.lead), [90, 45], 'T-90 then T-45, each once');
    assert.ok(warned.every((w) => w.id === approval.id), 'the answered card was never warned about');
    assert.deepEqual(approval.warned, [90, 45], 'the card records the warnings it gave');
  });
});

test('AP-1: a lead longer than the card\'s whole window is skipped, not fired at once', async () => {
  const warned: number[] = [];
  const approvals = new Approvals({ warn: (_approval, lead) => { warned.push(lead); } }, pendingFile());
  approvals.warnLeadsMs = [200, 30];
  await held(async () => {
    const { decided } = approvals.request(toolCard(), 80);
    await decided;
  });
  assert.deepEqual(warned, [30], 'only the lead the card lives long enough to reach');
});

test('AP-2: a card says what its timeout will do from the moment it is raised', () => {
  const approvals = new Approvals({}, pendingFile());
  const tool = approvals.request(toolCard(), 60 * 60_000).approval;
  assert.match(tool.onTimeout ?? '', /^auto-denies at \d\d:\d\dZ; the run then parks until this phase completes or someone presses Retry$/);
  assert.ok(tool.onTimeout!.includes(`${tool.expiresAt.slice(11, 16)}Z`), 'the clock is the card\'s own deadline');
  assert.equal(tool.onTimeout, timeoutConsequence(tool));

  const verify = approvals.request(toolCard({ kind: 'verify', tool: undefined, title: 'look at the dashboard' }), 60_000).approval;
  assert.match(verify.onTimeout ?? '', /^goes unanswered at \d\d:\d\dZ — the phase parks \(not failed\) until someone retries it$/);

  const standing = approvals.offer(toolCard({ title: 'widen: Bash(git push:*)' })).approval;
  assert.match(standing.onTimeout ?? '', /^reads as denied at \d\d:\d\dZ — the phase stays parked on its errand until someone retries it$/);

  for (const card of [tool, verify, standing]) approvals.settle(card.id, 'deny', 'console');
});

/* ------------------------------------------------------------------ *
 * Through the service: the push and the notification inbox
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

test('AP-1 + AP-2: the service announces each warning to the push channel and the notification inbox — the deadline, the consequence, and Allow/Extend on the push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-approval-expiry-root-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Array<{ category: string; message: Record<string, unknown> }> = [];
  svc.push.announce = ((category: string, message: Record<string, unknown>) => {
    pushed.push({ category, message });
    return null;
  }) as never;
  try {
    assert.equal(svc.open(root).ok, true);
    svc.approvals.warnLeadsMs = [60];
    const { approval, decided } = svc.approvals.request(toolCard({ runId: 'unknown' }), 90);
    await held(async () => { await decided; });

    const warnings = pushed.filter((p) => p.category === 'approval' && /expires in/.test(String(p.message.title)));
    assert.equal(warnings.length, 1, 'one warning push for the one lead');
    const warning = warnings[0].message;
    assert.match(String(warning.title), /^Approval expires in \d+ min — alpha phase 2$/);
    assert.ok(String(warning.body).includes(approval.title), 'the push names the card');
    assert.ok(String(warning.body).includes(approval.onTimeout!), 'and what its timeout will do');
    assert.equal(warning.tag, pushed[0].message.tag, 'the warning replaces the card on the lock screen — same tag');
    assert.deepEqual(
      (warning.actions as Array<{ action: string }>).map((a) => a.action), ['allow', 'extend'],
      'answerable from the push: Allow, or Extend',
    );
    const inbox = svc.notifications.list().items.filter((row) => /expires in/.test(row.title));
    assert.equal(inbox.length, 1, 'the notification inbox carries the warning too');
    assert.equal(inbox[0].category, 'approval');
  } finally {
    svc.approvals.disarm();
    rmSync(root, { recursive: true, force: true });
  }
});
