/**
 * The policy advisory (zero-touch phase 12, chapter 08 TRS-9).
 *
 * The audit found the operator's own strikes had emptied the ask list and
 * halved the deny wall on the live console, and nothing said so anywhere a
 * person looks. Now: judged once per boot, logged as `policy.advisory`,
 * announced on the health channel until acknowledged, carried by
 * `GET /api/policy` as `advisory`, and the acknowledgement is a receipt
 * against exactly the rules it named — one more strike and it stands again.
 *
 * A real Service over the sandboxed state home: the policy file the
 * constructor reads is the instance's, so it is written before construction.
 */

// Redirects the state and config homes before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

process.env.PHASE_CONSOLE_LOG = '';

const { Service } = await import('../server/service.ts');
const { editPolicy, POLICY_PATH, DEFAULT_ASK, DEFAULT_DENY } = await import('../server/runner/approvals.ts');
const { log } = await import('../server/log.ts');
const { INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { join } = await import('node:path');

const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, logFile: null, converge: false };
const ACK_FILE = join(INSTANCE_STATE_DIR, 'policy-advisory.json');

function fresh(): void {
  rmSync(POLICY_PATH, { force: true });
  rmSync(ACK_FILE, { force: true });
}

function service(t: { after(fn: () => void): void }) {
  const svc = new Service({ ...flags } as never);
  t.after(() => svc.close());
  return svc;
}

/** Capture `log.warn` for the life of one test. */
function warnings(t: { after(fn: () => void): void }): { event: string; data: Record<string, unknown> }[] {
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  const warn = log.warn;
  log.warn = ((event: string, data?: Record<string, unknown>) => { lines.push({ event, data: data ?? {} }); }) as typeof log.warn;
  t.after(() => { log.warn = warn; });
  return lines;
}

test('a stock policy raises no advisory, logs nothing, and has nothing to acknowledge', (t) => {
  fresh();
  const lines = warnings(t);
  const svc = service(t);
  assert.deepEqual(svc.policyAdvisories(), []);
  assert.deepEqual(svc.policy().advisory, []);
  assert.ok(!lines.some((l) => l.event === 'policy.advisory'));
  assert.equal(svc.acknowledgePolicyAdvisory('ask-empty'), false, 'nothing stands');
  assert.ok(!existsSync(ACK_FILE));
});

test('every ask rule struck: the advisory is logged ONCE at boot, carried by the policy view, and announced until acknowledged', (t) => {
  fresh();
  editPolicy({ remove: { ask: [...DEFAULT_ASK] }, by: 'tester' }, POLICY_PATH);
  const lines = warnings(t);
  const svc = service(t);
  const logged = lines.filter((l) => l.event === 'policy.advisory');
  assert.equal(logged.length, 1, 'once per boot');
  assert.equal(logged[0].data.kind, 'ask-empty');
  assert.deepEqual(logged[0].data.rules, [...DEFAULT_ASK]);
  assert.equal(logged[0].data.acknowledged, false);

  const view = svc.policy();
  assert.equal(view.advisory.length, 1);
  assert.equal(view.advisory[0].kind, 'ask-empty');
  assert.equal(view.advisory[0].acknowledged, false);
  assert.match(view.advisory[0].message, /Guarded and Trusted are the same posture/);

  // The receipt: recorded, read back, and it survives a new console.
  assert.equal(svc.acknowledgePolicyAdvisory('ask-empty'), true);
  assert.equal(svc.policy().advisory[0].acknowledged, true);
  assert.ok(existsSync(ACK_FILE));
  const again = service(t);
  assert.equal(again.policy().advisory[0].acknowledged, true, 'the receipt outlives the process');
  // Acknowledged: logged still (the console's record), announced no more.
  assert.equal(lines.filter((l) => l.event === 'policy.advisory').at(-1)?.data.acknowledged, true);
});

test('the receipt is against the rules it named: one more strike and the advisory stands again', (t) => {
  fresh();
  editPolicy({ remove: { deny: [DEFAULT_DENY[0]] }, by: 'tester' }, POLICY_PATH);
  const svc = service(t);
  assert.deepEqual(svc.policy().advisory.map((a) => `${a.kind}:${a.acknowledged}`), ['deny-struck:false']);
  assert.equal(svc.acknowledgePolicyAdvisory('deny-struck'), true);
  assert.deepEqual(svc.policy().advisory.map((a) => `${a.kind}:${a.acknowledged}`), ['deny-struck:true']);

  editPolicy({ remove: { deny: [DEFAULT_DENY[1]] }, by: 'tester' }, POLICY_PATH);
  const after = svc.policy().advisory;
  assert.deepEqual(after.map((a) => `${a.kind}:${a.acknowledged}`), ['deny-struck:false']);
  assert.deepEqual(after[0].rules, [DEFAULT_DENY[0], DEFAULT_DENY[1]]);
  // Restoring the second strike returns to the acknowledged set.
  editPolicy({ restore: { deny: [DEFAULT_DENY[1]] }, by: 'tester' }, POLICY_PATH);
  assert.deepEqual(svc.policy().advisory.map((a) => `${a.kind}:${a.acknowledged}`), ['deny-struck:true']);
  // A kind that does not stand cannot be acknowledged.
  assert.equal(svc.acknowledgePolicyAdvisory('ask-empty'), false);
});
