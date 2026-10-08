/**
 * AR-1..4 (control-tower phase 148, #208) — on a console with an owner key,
 * the door table's enrolled mode holds, and a press a door may not make is a
 * REQUEST the owner confirms: never applied, never dropped.
 *
 * AR-1  `owner` presses everything grantable; `device` presses low and medium
 *       answers and declines; `local` declines.
 * AR-2  An authority press through `local`, `session`, `supervisor` — or a
 *       `device` beyond its row — is recorded as a request, naming who asked and
 *       through which door, journalled, and shown on its item or as a
 *       `decision` item: "asked by <label> — confirm?". The same press again is
 *       the same request.
 * AR-3  The owner confirms it in one press — the console presses it then,
 *       through the owner's door, exactly as asked — or refuses it. Nobody else
 *       answers one, and a high-risk one needs a fresh touch.
 * AR-4  What the plan's manifest already allows still executes through any
 *       door: that is carrying out a decision, not making one.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from '../server/log.ts';
import { SoftAuthenticator } from './webauthn-authenticator.ts';
import { Browser, PORT, REMOTE_HOST, call, enrolFirst, freshOwnerState, newService } from './owner-harness.ts';

/** A phone the `--remote` proxy vouched for — the `device` door. */
const DEVICE = { host: REMOTE_HOST, headers: { 'tailscale-user-login': 'owner@example.com' } };

/** An enrolled console with a plan open and a run on it (`demo`, phase 2). */
async function enrolledConsole(manifest?: string, opts: { open?: boolean } = {}) {
  const state = freshOwnerState();
  const service = newService();
  (service.flags as { remoteUsers: string[] }).remoteUsers = ['owner@example.com'];
  (service as unknown as { push: { announce: () => void } }).push.announce = () => {};
  const root = mkdtempSync(join(tmpdir(), 'pc-ar-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '---\nslug: demo\nstatus: active\nphases: 2\n---\n\n# demo\n\n## Phase graph\n\n| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n|------:|-------|-----------|--------------------|-------|---------------|\n| 1 | one | — | — | app | it works |\n| 2 | two | 1 | — | app | it works |\n', 'utf8');
  if (opts.open !== false) assert.equal(service.open(root).ok, true);
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: 'trusted', phases: {},
      ...(manifest ? { manifest: { decisions: [{ key: 'permission.destructive', state: 'answered', value: manifest, source: 'plan' }] } } : {}),
    }),
    note: () => {}, noteWaitDenied: () => {}, park: () => {}, isSpending: () => false,
  });
  const owner = new Browser(service);
  const mac = new SoftAuthenticator('EdDSA');
  await enrolFirst(service, owner, mac);
  return { state, service, owner, mac, close: () => { service.approvals.disarm(); service.close(); } };
}

/** Does the console's policy name this rule anywhere? */
const holds = (service: { policy: (slug: string | null) => unknown }, rule: string) => JSON.stringify(service.policy(null)).includes(rule);

const requested = (answer: { status: number; answer: Record<string, unknown> }) =>
  answer.status === 202 && answer.answer.requested === true;

test('AR-1: the owner presses; a device presses its answers and declines; local declines', async () => {
  const { service, owner, close } = await enrolledConsole();
  try {
    const policy = { add: { deny: ['Bash(shred:*)'] } };
    assert.ok(!requested(await owner.call('POST', '/api/policy', policy)), 'the owner widens a policy');
    // A device: an answer (medium) is its own; a profile raise (high) is not.
    const answered = await call(service, 'POST', '/api/approvals/a-none', { ...DEVICE, body: { decision: 'allow' } });
    assert.ok(!requested(answered) && answered.status !== 403, `a device answers a card: ${answered.status} ${JSON.stringify(answered.answer)}`);
    const raised = await call(service, 'POST', '/api/run/demo/settings', { ...DEVICE, body: { permissionProfile: 'bypass' } });
    assert.ok(requested(raised), `a device asks for a profile raise: ${raised.status}`);
    assert.equal((raised.answer.request as { door: string }).door, 'device');
    // Local: a decline is its own.
    const denied = await call(service, 'POST', '/api/human-steps/nope/deny', { body: { note: 'no' } });
    assert.ok(!requested(denied), `local denies: ${denied.status}`);
  } finally {
    close();
  }
});

test('AR-2: local, a session and the supervisor ask — recorded, named, journalled, the same press is the same request', async () => {
  const { state, service, close } = await enrolledConsole();
  const lines: { name: string; data: Record<string, unknown> }[] = [];
  const info = log.info;
  log.info = ((name: string, data: Record<string, unknown>) => { lines.push({ name, data }); return info.call(log, name as never, data as never); }) as typeof log.info;
  try {
    const body = { add: { deny: ['Bash(ar2-never:*)'] }, by: 'nightly-script' };
    const local = await call(service, 'POST', '/api/policy', { body });
    assert.ok(requested(local), `${local.status} ${JSON.stringify(local.answer)}`);
    const request = local.answer.request as { id: string; door: string; label: string; press: string; ask: string; state: string };
    assert.deepEqual([request.door, request.label, request.press, request.state], ['local', 'nightly-script', 'edit-policy', 'open']);
    assert.match(request.ask, /^asked by nightly-script through the local door .* — confirm\?$/);
    assert.match(String(local.answer.error), /asked of the owner/, 'the asker is told what happened to its press');
    assert.equal(holds(service, 'Bash(ar2-never:*)'), false, 'never applied');
    // The same press again: the same request.
    const again = await call(service, 'POST', '/api/policy', { body });
    assert.equal((again.answer.request as { id: string }).id, request.id);
    assert.equal(state.requests.open().length, 1);
    assert.equal(state.requests.open()[0]!.repeats, 1);
    // A session's token: a request too, named by its run.
    const token = service.approvals.arm('r1');
    const session = await call(service, 'POST', '/api/run/demo/settings', { headers: { authorization: `Bearer ${token}` }, body: { permissionProfile: 'bypass' } });
    assert.ok(requested(session), `${session.status} ${JSON.stringify(session.answer)}`);
    assert.deepEqual([(session.answer.request as { door: string }).door, (session.answer.request as { label: string }).label], ['session', 'r1']);
    // The supervisor's bearer: a request.
    const doorOf = service.doorOf.bind(service);
    service.doorOf = () => ({ door: 'supervisor', label: 'chat-1', proof: 'chat-bearer' });
    const supervisor = await call(service, 'POST', '/api/plans/demo/gate/2', { body: { approve: true } });
    service.doorOf = doorOf;
    assert.ok(requested(supervisor), `${supervisor.status} ${JSON.stringify(supervisor.answer)}`);
    assert.deepEqual((supervisor.answer.request as { item: unknown }).item, { kind: 'gate', slug: 'demo', phase: 2 });
    assert.equal(lines.filter((line) => line.name === 'policy.authority-requested').length, 3, 'each journalled once');
    // A body carrying a secret is not kept, so it is not asked.
    const secret = await call(service, 'POST', '/api/policy', { body: { add: { deny: ['x'] }, secret: 'hunter2' } });
    assert.equal(secret.status, 400);
    assert.equal(state.requests.open().length, 3);
  } finally {
    log.info = info;
    close();
  }
});

test('AR-2: a request is shown on its item — or, about none, as a decision item of its own', async () => {
  const { service, close } = await enrolledConsole();
  try {
    const raised = service.raiseTurn({ slug: 'demo', phase: 2, birth: 'plan', step: { kind: 'physical', title: 'Plug the board in' } }) as { id: string; proofType: string };
    assert.equal(raised.proofType, 'attest', 'no proof the console can read: the person\'s word');
    const check = await call(service, 'POST', `/api/human-steps/${raised.id}/check`, { body: {} });
    assert.ok(requested(check), `a person's word through the local door is the owner's: ${check.status} ${JSON.stringify(check.answer)}`);
    await call(service, 'POST', '/api/policy', { body: { add: { deny: ['Bash(shred:*)'] } } });
    const turn = await service.turnAnswer();
    const items = Object.values(turn.groups).flat();
    const onItem = items.find((item) => item.item === raised.id);
    assert.equal(onItem?.requests?.length, 1, 'on its item');
    assert.match(onItem!.requests![0]!.ask, /confirm\?$/);
    const own = items.find((item) => item.record === 'request');
    assert.ok(own, 'a decision item of its own');
    assert.equal(own!.kind, 'decision');
    assert.equal(own!.group, 'decide');
    assert.match(own!.title, /^Asked by .* — confirm\?$/);
    assert.deepEqual(own!.actions.map((action) => action.verb), ['confirm', 'refuse']);
  } finally {
    close();
  }
});

test('AR-3: the owner confirms in one press — pressed as asked, through the owner\'s door — or refuses; nobody else answers', async () => {
  const { state, service, owner, close } = await enrolledConsole();
  const lines: string[] = [];
  const info = log.info;
  log.info = ((name: string, data: unknown) => { lines.push(name); return info.call(log, name as never, data as never); }) as typeof log.info;
  try {
    const asked = await call(service, 'POST', '/api/policy', { body: { add: { deny: ['Bash(ar3-confirmed:*)'] } } });
    const id = (asked.answer.request as { id: string }).id;
    assert.equal(holds(service, 'Bash(ar3-confirmed:*)'), false, 'asked, not applied');
    // Not the owner: neither a script nor a phone answers a request.
    assert.equal((await call(service, 'POST', `/api/owner/requests/${id}/confirm`)).status, 401);
    assert.equal((await call(service, 'POST', `/api/owner/requests/${id}/confirm`, DEVICE)).status, 401);
    const confirmed = await owner.call('POST', `/api/owner/requests/${id}/confirm`);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.answer));
    assert.equal((confirmed.answer.request as { state: string }).state, 'confirmed');
    assert.ok(holds(service, 'Bash(ar3-confirmed:*)'), 'pressed exactly as asked');
    assert.ok(lines.includes('policy.authority-confirmed'));
    assert.equal((await owner.call('POST', `/api/owner/requests/${id}/confirm`)).status, 409, 'answered once');
    // Refused: nothing applied.
    const second = await call(service, 'POST', '/api/policy', { body: { add: { deny: ['Bash(dd-wipe:*)'] } } });
    const refused = await owner.call('POST', `/api/owner/requests/${(second.answer.request as { id: string }).id}/refuse`);
    assert.equal((refused.answer.request as { state: string }).state, 'refused');
    assert.equal(holds(service, 'Bash(dd-wipe:*)'), false);
    assert.ok(lines.includes('policy.authority-declined'));
    // A high-risk request needs a fresh touch to confirm.
    const raise = await call(service, 'POST', '/api/run/demo/settings', { body: { permissionProfile: 'bypass' } });
    const rows = JSON.parse(readFileSync(state.sessions.file, 'utf8')) as { sessions: { assertedAt: string }[] };
    for (const row of rows.sessions) row.assertedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(state.sessions.file, JSON.stringify(rows), { mode: 0o600 });
    const stale = await owner.call('POST', `/api/owner/requests/${(raise.answer.request as { id: string }).id}/confirm`);
    assert.equal(stale.status, 401);
    assert.equal(stale.answer.reassert, true);
  } finally {
    log.info = info;
    close();
  }
});

test('AR-4: what the manifest already allows executes through any door — and opens nothing else', async () => {
  // No plan open: the run's own manifest is the one the console reads.
  const { service, close } = await enrolledConsole('deny; allow `Console(run-settings)` — phase 2 only', { open: false });
  try {
    const named = await call(service, 'POST', '/api/run/demo/settings', { body: { model: 'sonnet' } });
    assert.ok(!requested(named), `carrying out a decision: ${named.status} ${JSON.stringify(named.answer)}`);
    const other = await call(service, 'POST', '/api/policy', { body: { add: { deny: ['Bash(shred:*)'] } } });
    assert.ok(requested(other), 'one named press opens no other');
  } finally {
    close();
  }
});

test('AR-2: a page on another site plants no request — the console\'s header and the same origin first, as for any press', async () => {
  const { state, service, close } = await enrolledConsole();
  try {
    const crossSite = await call(service, 'POST', '/api/policy', { headers: { origin: 'https://evil.example' }, body: { add: { deny: ['Bash(x:*)'] } } });
    assert.equal(crossSite.status, 403);
    const headerless = await call(service, 'POST', '/api/policy', { headers: { 'x-phase-console': '' }, body: { add: { deny: ['Bash(x:*)'] } } });
    assert.equal(headerless.status, 403);
    assert.equal(state.requests.all().length, 0, 'nothing was written for the owner to confirm');
  } finally {
    close();
  }
});

test('AR: an unenrolled console is unchanged — a local press is a person\'s, and nothing is asked', async () => {
  freshOwnerState();
  const service = newService();
  try {
    const local = await call(service, 'POST', '/api/policy', { host: `127.0.0.1:${PORT}`, body: { add: { deny: ['Bash(shred:*)'] } } });
    assert.ok(!requested(local), `${local.status}`);
  } finally {
    service.close();
  }
});
