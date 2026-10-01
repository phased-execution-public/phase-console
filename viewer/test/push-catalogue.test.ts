/**
 * The `digest` push category (control-tower phase 97, #140 — AP-6, AP-7).
 *
 * An operator away from the console could learn only from the stream, one
 * notification per event, and a stream is exactly what they had muted or were
 * not reading. The digest is the other appetite: off by default, hourly when
 * on, one push that names every decision waiting on them with its deadline,
 * every park and every detection — and, once the channel answers again, the
 * pushes it failed to deliver during an outage (#108's measured impact: the
 * undelivered push was a log line and a health row, never re-said).
 */
import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-push-catalogue-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { CATEGORIES, categoryOf, defaultCategories, routeFor, sanitiseCategories } = await import('../server/push/catalogue.ts');
const { composeDigest, DIGEST_EVERY_MS, UNDELIVERED_KEEP } = await import('../server/push/digest.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-27T20:00:00.000Z');
const nothing = { approvals: [], parks: [], detections: [], undelivered: [] };

test('FC-4: `usage-climbing` is on by default — the warning hours before a wall must reach someone who never opened Settings', () => {
  const climbing = categoryOf('usage-climbing');
  assert.equal(climbing.byDefault, true, 'control-tower phase 92 (#141): the forecast warning is default-on');
  assert.equal(climbing.urgent, false, 'hours ahead is not a wrist buzz');
  assert.equal(defaultCategories()['usage-climbing'], true);
  assert.equal(sanitiseCategories({})['usage-climbing'], true, 'an older client\'s preferences do not turn it off');
  assert.equal(sanitiseCategories({ 'usage-climbing': false })['usage-climbing'], false, 'an operator who muted it keeps it muted');
  assert.match(climbing.detail, /hours ahead/);
});

test('BR-1: `budget` is a category — on by default, never urgent, landing on the run page (control-tower phase 14, #40)', () => {
  const budget = categoryOf('budget');
  assert.equal(budget.byDefault, true, 'a spent budget stops work: the operator must hear it without opening Settings');
  assert.equal(budget.urgent, false, 'a spent budget spends nothing while it waits — the usage-climbing precedent');
  assert.equal(defaultCategories().budget, true);
  assert.equal(sanitiseCategories({}).budget, true, 'an older client\'s preferences do not turn it off');
  assert.equal(sanitiseCategories({ budget: false }).budget, false, 'an operator who muted it keeps it muted');
  assert.equal(routeFor('budget', { slug: 'demo', phase: 4 }), '/#/plan/demo/run', 'the raise lives on the run page');
  assert.equal(routeFor('budget'), '/#/runs');
  assert.match(budget.detail, /80%/);
  assert.equal(CATEGORIES.filter((c) => c.id === 'budget').length, 1);
});

test('AP-6: `digest` is a category — off by default, never urgent, landing on Now', () => {
  const digest = categoryOf('digest');
  assert.equal(digest.byDefault, false, 'a summary is an appetite some operators have, not a default');
  assert.equal(digest.urgent, false, 'it never buzzes a wrist');
  assert.equal(defaultCategories().digest, false);
  assert.equal(sanitiseCategories({}).digest, false, 'an older client\'s preferences do not turn it on');
  assert.equal(sanitiseCategories({ digest: true }).digest, true);
  assert.equal(routeFor('digest'), '/#/now');
  assert.equal(CATEGORIES.filter((c) => c.id === 'digest').length, 1);
});

test('AP-6: hourly when on', () => {
  assert.equal(DIGEST_EVERY_MS, 60 * 60_000);
});

test('AP-6: the digest names every decision waiting, how long it has waited and its deadline — then every park and every detection', () => {
  const digest = composeDigest({
    now: NOW,
    approvals: [{
      slug: 'vca', phase: 22, title: 'Bash: git push origin main',
      createdAt: '2026-09-27T19:20:00.000Z', expiresAt: '2026-09-27T21:09:00.000Z',
    }],
    parks: [{ slug: 'shop', phase: 66, reason: 'phase 66 declared partial (7/8 green)' }],
    detections: [{ slug: 'alpha', phase: 3, text: 'silent for 20 min' }],
    undelivered: [],
  });
  assert.ok(digest);
  assert.equal(digest.title, '3 things wait on you');
  const lines = digest.body.split('\n');
  assert.equal(lines[0], 'vca phase 22 — Bash: git push origin main (waiting 40 min; expires 21:09Z)');
  assert.equal(lines[1], 'shop phase 66 parked — phase 66 declared partial (7/8 green)');
  assert.equal(lines[2], 'alpha phase 3 — silent for 20 min');
});

test('AP-6: nothing waiting and nothing lost is no digest at all — silence is the good news', () => {
  assert.equal(composeDigest({ now: NOW, ...nothing }), null);
});

test('AP-7: pushes the channel failed to deliver are summarised, newest first, the count honest past what is kept', () => {
  const undelivered = Array.from({ length: UNDELIVERED_KEEP + 3 }, (_, i) => ({
    category: 'halted', title: `Run halted #${i + 1}`, at: new Date(NOW - (60 - i) * 60_000).toISOString(),
  }));
  const digest = composeDigest({ now: NOW, ...nothing, undelivered: undelivered.slice(-UNDELIVERED_KEEP), undeliveredTotal: undelivered.length });
  assert.ok(digest);
  assert.equal(digest.title, `${UNDELIVERED_KEEP + 3} notifications did not arrive`);
  assert.ok(digest.body.startsWith(`Did not arrive: Run halted #${UNDELIVERED_KEEP + 3}`), 'newest first');
  assert.match(digest.body, /and 3 more$/m, 'what was not kept is still counted');
});

/* ------------------------------------------------------------------ *
 * Through the service
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-27
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |

## Phases

### Phase 1 — one
- **Size:** S
`;

function service() {
  const root = mkdtempSync(join(tmpdir(), 'pc-push-catalogue-root-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Array<{ category: string; title: string; body: string }> = [];
  let answer: 'sent' | 'failed' = 'sent';
  svc.push.announce = ((category: string, message: { title: string; body: string }, _now: number,
    onDelivery?: (report: Record<string, unknown>) => void) => {
    pushed.push({ category, title: message.title, body: message.body });
    onDelivery?.({ label: 'phone', outcome: answer });
    return null;
  }) as never;
  assert.equal(svc.open(root).ok, true);
  const prefs = (svc as unknown as { prefs: { notify: Record<string, boolean> } }).prefs;
  return {
    svc, pushed, prefs,
    channel: (to: 'sent' | 'failed') => { answer = to; },
    cleanup: () => { svc.approvals.disarm(); rmSync(root, { recursive: true, force: true }); },
  };
}

const card = {
  runId: 'unknown', slug: 'alpha', phase: 1, kind: 'tool' as const,
  title: 'Bash: git push origin main', detail: 'Phase 1 of alpha wants to use Bash.', evidence: [],
  tool: { name: 'Bash', input: { command: 'git push origin main' } },
};

test('AP-6: the hourly tick announces through Service.announce only when the category is on', () => {
  const { svc, pushed, prefs, cleanup } = service();
  try {
    const { approval } = svc.approvals.request(card, 60 * 60_000);
    prefs.notify.digest = false;
    assert.equal(svc.digestTick(), null, 'off: nothing composed, nothing sent');
    assert.equal(pushed.filter((p) => p.category === 'digest').length, 0);
    prefs.notify.digest = true;
    const record = svc.digestTick();
    assert.ok(record, 'on: one digest');
    const sent = pushed.filter((p) => p.category === 'digest');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, '1 thing waits on you');
    assert.ok(sent[0].body.startsWith(`alpha phase 1 — ${approval.title} (waiting 0 min; expires `));
    assert.equal(svc.notifications.list().items.filter((row) => row.category === 'digest').length, 1, 'and the notification inbox has it');
  } finally { cleanup(); }
});

test('AP-7: pushes undelivered during an outage are summarised once the channel answers again — under the digest', () => {
  const { svc, pushed, prefs, channel, cleanup } = service();
  try {
    prefs.notify.digest = true;
    const lost = (title: string) => svc.push.onUndelivered?.({
      category: 'halted', tag: `t-${title}`, title, devices: [{ label: 'phone', outcome: 'failed' }],
    });
    channel('failed');
    lost('Run halted: alpha');
    lost('Permission needed');
    assert.equal(pushed.filter((p) => p.category === 'digest').length, 0, 'nothing to say while the channel is down');
    channel('sent');
    (svc as unknown as { announce: (c: string, m: Record<string, string>) => unknown })
      .announce('finished', { title: 'Plan finished', body: 'alpha', tag: 'fin' });
    const caughtUp = pushed.filter((p) => p.category === 'digest');
    assert.equal(caughtUp.length, 1, 'the first push that arrives brings the catch-up with it');
    assert.equal(caughtUp[0].title, '2 notifications did not arrive');
    assert.match(caughtUp[0].body, /Permission needed/);
    assert.match(caughtUp[0].body, /Run halted: alpha/);
    (svc as unknown as { announce: (c: string, m: Record<string, string>) => unknown })
      .announce('finished', { title: 'Plan finished again', body: 'alpha', tag: 'fin-2' });
    assert.equal(pushed.filter((p) => p.category === 'digest').length, 1, 'said once, not per later push');
  } finally { cleanup(); }
});
