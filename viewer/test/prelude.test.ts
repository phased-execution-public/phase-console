/**
 * The run-start prelude (phase 11 — ZTD-2, QRL-2, ACT-9, ACC-10.1's
 * channel-less clause): the manifest rendered with every missing key
 * synthesised and never `outstanding`; the four probes, each refusing on its
 * stated condition and never on one it could not check; the blocking list a
 * written row, an unacknowledged waiver or a failed probe puts a start on; the
 * one recorded override; and the credential probe registry that answers by
 * id and never by value.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DECISION_KEYS } from '../shared/decisions-model.js';
import { MANIFEST_BLOCKING } from '../shared/policy-model.js';
import {
  PreludeRefusal, manifestRows, preludeFor, probeAccounts, probeCredentials, probeDelivery, probeMcp, resolvedManifest,
  type AccountFacts, type PreludeDeps,
} from '../server/prelude.ts';
import {
  credentialsHeld, forgetCredentialProbes, heldIdsCached, knownCredentialId, probeCredential,
} from '../server/credentials-probe.ts';

const NOW = '2026-09-14T12:00:00.000Z';

function account(over: Partial<AccountFacts> = {}): AccountFacts {
  return {
    id: 'default', minHeadroomPct: 0, registered: true, authState: 'ok', label: 'the machine login',
    entitlement: { state: 'entitled' }, headroom: { ok: true, accountId: 'default', fiveHourPct: 40 },
    ...over,
  };
}

/** Deps over a plan that names nothing — the estate's ordinary plan. */
function deps(over: Partial<PreludeDeps> = {}): PreludeDeps {
  return {
    decisions: () => ({ rows: [], present: false }),
    planAccounts: () => [],
    planCredentials: () => ({ ids: [], policy: null }),
    planMcp: () => ({ ids: [], policy: null }),
    accounts: {
      defaultId: 'default',
      has: (id) => id === 'work',
      authStateFor: () => 'ok',
      entitlementOf: () => ({ state: 'entitled' }),
      headroom: (id) => ({ ok: true, accountId: id, fiveHourPct: 40 }),
      labelFor: (id) => (id === 'default' ? 'the machine login' : id),
    },
    mcp: { preflight: async () => ({ ok: true, blocking: [], unknown: [] }) },
    credentials: { held: async (ids) => ids.map((id) => ({ id, status: 'ok' as const, reason: 'held' })) },
    delivery: async () => ({ devices: 1, notifyCommand: false, webhooks: 0, remote: false }),
    prefs: { policy: null },
    now: () => NOW,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * The rows
 * ------------------------------------------------------------------ */

test('a plan with no manifest gets every key synthesised as answered — never outstanding — and starts on the form\'s answers', async () => {
  const prelude = await preludeFor('alpha', { resumeOnRestart: true, relay: 'off' }, deps());
  assert.equal(prelude.manifestPresent, false);
  assert.deepEqual(prelude.rows.map((r) => r.key), [...DECISION_KEYS]);
  assert.ok(prelude.rows.every((r) => r.state === 'answered'), 'no synthesised row is outstanding');
  assert.deepEqual(prelude.blocking, []);
  const byKey = Object.fromEntries(prelude.rows.map((r) => [r.key, r]));
  assert.equal(byKey['resume.on-restart'].value, 'continue');
  assert.equal(byKey['resume.on-restart'].origin, 'run');
  assert.equal(byKey.relay.value, 'off');
  assert.equal(byKey.relay.origin, 'run');
  assert.equal(byKey.gates.value, 'delegated');
  assert.equal(byKey.gates.origin, 'default');
  assert.equal(byKey['qa.exhausted'].value, 'waive');
  assert.equal(byKey.accounts.value, 'default:0 (id:minimum five-hour headroom %)');
  assert.equal(byKey.accounts.origin, 'default');
  assert.equal(byKey.credentials.value, 'none named; credential policy: continue');
  // The blocking column follows the template even on a synthesised row.
  for (const row of prelude.rows) {
    assert.equal(row.blocking, (MANIFEST_BLOCKING as readonly string[]).includes(row.key) ? 'yes' : 'no', row.key);
  }
  // The four probe rows are marked with the probe that judged them.
  assert.equal(byKey.accounts.probe, 'accounts');
  assert.equal(byKey.mcp.probe, 'mcp');
  assert.equal(byKey.credentials.probe, 'credentials');
  assert.equal(byKey.announce.probe, 'delivery');
});

test('a written row is kept as written; an outstanding blocking row blocks, a non-blocking one does not', async () => {
  const written = [
    { key: 'credentials', value: '', owner: 'operator', state: 'outstanding', blocking: 'yes' as const, source: 'plan', evidence: '', phase: null },
    { key: 'waits', value: '', owner: 'dev-lead', state: 'outstanding', blocking: 'no' as const, source: 'plan', evidence: '', phase: null },
    { key: 'gates', value: '`Gates: operator`', owner: 'operator', state: 'answered', blocking: 'no' as const, source: 'plan', evidence: 'x', phase: null },
  ];
  const prelude = await preludeFor('alpha', { resumeOnRestart: false, relay: 'off' }, deps({ decisions: () => ({ rows: written, present: true }) }));
  assert.equal(prelude.manifestPresent, true);
  assert.deepEqual(prelude.blocking, [{ key: 'credentials', why: 'outstanding — owed by operator' }]);
  const gates = prelude.rows.find((r) => r.key === 'gates')!;
  assert.equal(gates.origin, 'plan');
  assert.equal(gates.value, '`Gates: operator`');
  const resume = prelude.rows.find((r) => r.key === 'resume.on-restart')!;
  assert.equal(resume.value, 'hold');
  // An unknown key is kept so the prelude and F25 say the same thing.
  const odd = await preludeFor('alpha', {}, deps({
    decisions: () => ({ rows: [{ key: 'nonsense', value: 'x', owner: 'me', state: 'answered', blocking: 'no', source: 'plan', evidence: '', phase: null }], present: true }),
  }));
  assert.ok(odd.rows.some((r) => r.key === 'nonsense'));
  // A manifest the engine could not read blocks under plan-health.
  const broken = await preludeFor('alpha', {}, deps({ decisions: () => ({ rows: [], present: true, error: 'exit 2' }) }));
  assert.deepEqual(broken.blocking, [{ key: 'plan-health', why: 'the manifest could not be read: exit 2' }]);
});

test('a waived row must be acknowledged; acknowledging it clears the block', async () => {
  const written = [
    { key: 'relay', value: 'every phase is hand-driven', owner: 'operator', state: 'waived', blocking: 'yes' as const, source: 'plan', evidence: '', phase: null },
  ];
  const d = deps({ decisions: () => ({ rows: written, present: true }) });
  const unacked = await preludeFor('alpha', {}, d);
  assert.deepEqual(unacked.waived, ['relay']);
  assert.deepEqual(unacked.blocking, [{ key: 'relay', why: 'waived row not acknowledged — every phase is hand-driven' }]);
  const acked = await preludeFor('alpha', { acknowledgedWaivers: ['relay'] }, d);
  assert.deepEqual(acked.blocking, []);
  assert.deepEqual(acked.acknowledged, ['relay']);
});

/* ------------------------------------------------------------------ *
 * The probes
 * ------------------------------------------------------------------ */

test('accounts: refuses only when EVERY declared account is unusable; one usable account starts with warnings', () => {
  assert.equal(probeAccounts([]).status, 'skip');
  const one = probeAccounts([account()]);
  assert.equal(one.status, 'ok');
  assert.match(one.reason, /1 of 1 declared account usable/);
  const mixed = probeAccounts([
    account({ id: 'a', label: 'a', entitlement: { state: 'retired', reason: 'org policy' } }),
    account({ id: 'b', label: 'b', authState: 'signed-out' }),
    account({ id: 'c', label: 'c', registered: false }),
    account({ id: 'd', label: 'd', headroom: { ok: false, accountId: 'd', kind: 'spent', reason: 'd hit its usage limit' } }),
    account({ id: 'e', label: 'e', minHeadroomPct: 20, headroom: { ok: true, accountId: 'e', fiveHourPct: 85 } }),
    account({ id: 'f', label: 'f', minHeadroomPct: 20, headroom: { ok: true, accountId: 'f', fiveHourPct: 80 } }),
  ]);
  assert.equal(mixed.status, 'ok', 'f has exactly the headroom it declared');
  assert.equal(mixed.warnings?.length, 5);
  assert.match(mixed.warnings![0], /a — retired by the breaker \(org policy\)/);
  assert.match(mixed.warnings![1], /b — login signed-out/);
  assert.match(mixed.warnings![2], /c — not registered/);
  assert.match(mixed.warnings![3], /d — d hit its usage limit/);
  assert.match(mixed.warnings![4], /e — 15 % five-hour headroom left, 20 % required/);
  const none = probeAccounts([
    account({ id: 'a', label: 'a', entitlement: { state: 'retired' } }),
    account({ id: 'e', label: 'e', minHeadroomPct: 20, headroom: { ok: true, accountId: 'e', fiveHourPct: 85 } }),
  ]);
  assert.equal(none.status, 'fail');
  assert.match(none.reason, /every declared account is unusable: a — retired by the breaker; e — 15 %/);
  // A never-polled account (no fiveHourPct) is not judged against a minimum it cannot be measured on.
  assert.equal(probeAccounts([account({ minHeadroomPct: 50, headroom: { ok: true, accountId: 'default' } })]).status, 'ok');
});

test('MCP: require and a server down refuses; continue warns; nothing named or nothing probed skips', () => {
  assert.equal(probeMcp([], 'require', null).status, 'skip');
  assert.equal(probeMcp(['a'], 'require', null).status, 'skip');
  assert.equal(probeMcp(['a'], 'require', { ok: false, blocking: [], unknown: [], probeError: 'no claude on PATH' }).status, 'skip');
  const down = { ok: false, blocking: [{ id: 'a', status: 'needs-auth' }], unknown: ['zzz'] };
  const required = probeMcp(['a', 'zzz'], 'require', down);
  assert.equal(required.status, 'fail');
  assert.match(required.reason, /MCP policy is require and a \(needs-auth\), zzz \(unknown to this console\) will not connect/);
  const continued = probeMcp(['a', 'zzz'], 'continue', down);
  assert.equal(continued.status, 'ok');
  assert.deepEqual(continued.warnings, ['a (needs-auth)', 'zzz (unknown to this console)']);
  assert.equal(probeMcp(['a'], 'require', { ok: true, blocking: [], unknown: [] }).status, 'ok');
});

test('credentials: require and an id absent refuses; continue warns; an id with no probe is a skip, not a refusal', () => {
  assert.equal(probeCredentials([], 'require', []).status, 'skip');
  const verdicts = [
    { id: 'gh', status: 'ok' as const, reason: 'signed in' },
    { id: 'env:TOKEN', status: 'fail' as const, reason: '$TOKEN is not set in the console\'s environment' },
    { id: 'vault:thing', status: 'skip' as const, reason: 'no probe for this credential id' },
  ];
  const required = probeCredentials(['gh', 'env:TOKEN', 'vault:thing'], 'require', verdicts);
  assert.equal(required.status, 'fail');
  assert.match(required.reason, /credential policy is require and env:TOKEN is not held: \$TOKEN is not set/);
  assert.deepEqual(required.detail, { missing: ['env:TOKEN'] });
  assert.deepEqual(required.warnings, ['vault:thing — no probe for this credential id']);
  const continued = probeCredentials(['gh', 'env:TOKEN'], 'continue', verdicts.slice(0, 2));
  assert.equal(continued.status, 'ok');
  assert.match(continued.reason, /env:TOKEN not held; policy continue runs and reports the gap/);
  const held = probeCredentials(['gh'], 'require', verdicts.slice(0, 1));
  assert.equal(held.status, 'ok');
  assert.match(held.reason, /1 of 1 credential held/);
  // Unknown ids alone never refuse, even under require.
  assert.equal(probeCredentials(['vault:thing'], 'require', verdicts.slice(2)).status, 'ok');
});

test('delivery: a device, a notify command or a webhook is a channel; under --remote Tailscale must serve this port', () => {
  const none = probeDelivery({ devices: 0, notifyCommand: false, webhooks: 0, remote: false });
  assert.equal(none.status, 'fail');
  assert.match(none.reason, /no delivery channel/);
  assert.deepEqual(none.channels, []);
  const some = probeDelivery({ devices: 2, notifyCommand: true, webhooks: 1, remote: false });
  assert.equal(some.status, 'ok');
  assert.equal(some.reason, '2 subscribed devices, PHASE_CONSOLE_NOTIFY, 1 webhook');
  assert.equal(probeDelivery({ devices: 1, notifyCommand: false, webhooks: 0, remote: true, tailscale: null }).status, 'fail');
  assert.match(probeDelivery({ devices: 1, notifyCommand: false, webhooks: 0, remote: true, tailscale: { running: true, forOurPort: false } }).reason,
    /Serve does not point at this port/);
  assert.equal(probeDelivery({ devices: 1, notifyCommand: false, webhooks: 0, remote: true, tailscale: { running: true, forOurPort: true } }).status, 'ok');
});

test('a channel-less start is refused on the announce row until it is acknowledged (ACC-10.1)', async () => {
  const d = deps({ delivery: async () => ({ devices: 0, notifyCommand: false, webhooks: 0, remote: false }) });
  const refused = await preludeFor('alpha', { resumeOnRestart: true, relay: 'off' }, d);
  assert.equal(refused.probes.delivery.status, 'fail');
  assert.deepEqual(refused.blocking.map((b) => b.key), ['announce']);
  assert.match(refused.blocking[0].why, /acknowledge to start anyway/);
  const announce = refused.rows.find((r) => r.key === 'announce')!;
  assert.equal(announce.state, 'outstanding');
  assert.equal(announce.blocking, 'yes');
  assert.equal(announce.owner, 'operator');
  const acked = await preludeFor('alpha', { resumeOnRestart: true, relay: 'off', acknowledgedWaivers: ['announce'] }, d);
  assert.deepEqual(acked.blocking, []);
  assert.equal(acked.rows.find((r) => r.key === 'announce')!.state, 'waived');
  assert.equal(acked.delivery.acknowledged, true);
  assert.equal(acked.delivery.ok, false, 'acknowledged is not the same fact as reachable');
});

test('the four probes read the plan and the form: the accounts clause, the credentials union, the run\'s MCP list', async () => {
  const probed: string[][] = [];
  const held: string[][] = [];
  const d = deps({
    planAccounts: () => [{ id: 'default', minHeadroomPct: 20 }, { id: 'work', minHeadroomPct: 10 }],
    planCredentials: () => ({ ids: ['gh', 'claude-login'], policy: 'require' }),
    planMcp: () => ({ ids: ['ctx'], policy: 'require' }),
    mcp: { preflight: async (ids) => { probed.push([...ids]); return { ok: true, blocking: [], unknown: [] }; } },
    credentials: { held: async (ids) => { held.push([...ids]); return ids.map((id) => ({ id, status: 'ok' as const, reason: 'held' })); } },
    accounts: {
      defaultId: 'default', has: (id) => id === 'work', authStateFor: () => 'ok', labelFor: (id) => id,
      entitlementOf: () => ({ state: 'entitled' }),
      headroom: (id) => ({ ok: true, accountId: id, fiveHourPct: id === 'default' ? 90 : 50 }),
    },
  });
  const prelude = await preludeFor('alpha', { resumeOnRestart: true, relay: 'off', mcpServers: ['extra'] }, d);
  assert.deepEqual(prelude.accounts, [{ id: 'default', minHeadroomPct: 20 }, { id: 'work', minHeadroomPct: 10 }]);
  assert.equal(prelude.probes.accounts.status, 'ok', 'work has 50 % left');
  assert.deepEqual(prelude.probes.accounts.warnings, ['default — 10 % five-hour headroom left, 20 % required']);
  assert.deepEqual(probed, [['ctx', 'extra']]);
  assert.deepEqual(held, [['gh', 'claude-login']]);
  assert.deepEqual(prelude.credentials, { policy: 'require', ids: ['gh', 'claude-login'], held: ['gh', 'claude-login'], missing: [] });
  const accountsRow = prelude.rows.find((r) => r.key === 'accounts')!;
  assert.equal(accountsRow.origin, 'plan');
  assert.equal(accountsRow.value, 'default:20, work:10 (id:minimum five-hour headroom %)');
  // The form's own list outranks the plan's clause.
  const formed = await preludeFor('alpha', { accounts: [{ id: 'work', minHeadroomPct: 300 }] }, d);
  assert.deepEqual(formed.accounts, [{ id: 'work', minHeadroomPct: 100 }]);
  assert.equal(formed.rows.find((r) => r.key === 'accounts')!.origin, 'run');
  // Every declared account under its minimum refuses.
  const starved = await preludeFor('alpha', { accounts: [{ id: 'default', minHeadroomPct: 50 }] }, d);
  assert.deepEqual(starved.blocking.map((b) => b.key), ['accounts']);
});

test('resolvedManifest is the echo run.start carries, with the override stamped when the door was passed on one', async () => {
  const prelude = await preludeFor('alpha', { resumeOnRestart: true, relay: 'off' }, deps());
  const plain = resolvedManifest(prelude);
  assert.equal(plain.at, NOW);
  assert.equal(plain.decisions.length, DECISION_KEYS.length);
  assert.ok(!('probe' in plain.decisions[0]), 'the probe marker is the prelude\'s, not the run\'s');
  assert.deepEqual(plain.probes.delivery, { status: 'ok', reason: '1 subscribed device' });
  assert.equal(plain.overridden, undefined);
  const overridden = resolvedManifest(prelude, { rows: ['credentials'], by: 'the operator' });
  assert.deepEqual(overridden.overridden, { rows: ['credentials'], by: 'the operator', at: NOW });
});

test('PreludeRefusal names the first open decision, counts the rest, and carries the whole prelude', async () => {
  const written = [
    { key: 'credentials', value: '', owner: 'operator', state: 'outstanding', blocking: 'yes' as const, source: 'plan', evidence: '', phase: null },
    { key: 'human-acts', value: '', owner: 'operator', state: 'outstanding', blocking: 'yes' as const, source: 'plan', evidence: '', phase: null },
  ];
  const prelude = await preludeFor('alpha', {}, deps({ decisions: () => ({ rows: written, present: true }) }));
  const refusal = new PreludeRefusal(prelude);
  assert.equal(refusal.name, 'PreludeRefusal');
  assert.match(refusal.message, /2 decisions still open — credentials: outstanding — owed by operator \(and 1 more\)/);
  assert.equal(refusal.unanswered.length, 2);
  assert.equal(refusal.prelude, prelude);
  const manifest = manifestRows(written, {}, deps(), [{ id: 'default', minHeadroomPct: 0 }]);
  assert.equal(manifest.filter((r) => r.state === 'outstanding').length, 2);
});

/* ------------------------------------------------------------------ *
 * The credential probe registry
 * ------------------------------------------------------------------ */

test('credential probes answer by id and never by value: env, file, gh, claude, keychain, unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-cred-'));
  try {
    writeFileSync(join(dir, 'token'), 'super-secret-value');
    const env = { PRESENT: 'super-secret-value', EMPTY: '' } as NodeJS.ProcessEnv;
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === 'gh') return { code: 1, stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n' };
      if (file === 'security') return { code: 44, stderr: 'The specified item could not be found in the keychain.' };
      return { code: null, stderr: 'ENOENT' };
    };
    const base = { env, exec, platform: 'darwin' as const, home: dir, claudeLogin: async () => ({ loggedIn: true }) };
    assert.deepEqual(await probeCredential('env:PRESENT', base), { id: 'env:PRESENT', status: 'ok', reason: '$PRESENT is set' });
    assert.equal((await probeCredential('env:EMPTY', base)).status, 'fail');
    assert.equal((await probeCredential('env:ABSENT', base)).status, 'fail');
    const file = await probeCredential(`file:${join(dir, 'token')}`, base);
    assert.equal(file.status, 'ok');
    assert.ok(!file.reason.includes('super-secret'), 'a reason never carries a value');
    assert.equal((await probeCredential('file:~/token', base)).status, 'ok', '~ expands');
    assert.equal((await probeCredential('file:~/nope', base)).status, 'fail');
    const gh = await probeCredential('gh', base);
    assert.equal(gh.status, 'fail');
    assert.match(gh.reason, /gh auth status exited 1 — You are not logged into any GitHub hosts/);
    assert.deepEqual(calls[0], ['gh', 'auth', 'status']);
    assert.equal((await probeCredential('gh', { ...base, exec: async () => ({ code: 0, stderr: '' }) })).status, 'ok');
    assert.equal((await probeCredential('gh', { ...base, exec: async () => ({ code: null, stderr: 'ENOENT' }) })).status, 'skip');
    assert.equal((await probeCredential('claude', base)).status, 'ok');
    assert.equal((await probeCredential('claude-login', base)).status, 'ok', 'the alias this plan\'s own line uses');
    assert.match((await probeCredential('claude', { ...base, claudeLogin: async () => ({ loggedIn: false, detail: 'expired' }) })).reason, /signed out — expired/);
    assert.equal((await probeCredential('claude', { ...base, claudeLogin: async () => { throw new Error('boom'); } })).status, 'skip');
    const keychain = await probeCredential('keychain:Claude Code-credentials', base);
    assert.equal(keychain.status, 'fail');
    assert.deepEqual(calls.at(-1), ['security', 'find-generic-password', '-s', 'Claude Code-credentials']);
    assert.equal((await probeCredential('keychain:x', { ...base, platform: 'linux' })).status, 'skip');
    const unknown = await probeCredential('vault:thing', base);
    assert.equal(unknown.status, 'skip');
    assert.match(unknown.reason, /no probe for this credential id/);
    assert.equal(knownCredentialId('gh'), true);
    assert.equal(knownCredentialId('env:X'), true);
    assert.equal(knownCredentialId('vault:thing'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credentialsHeld memoises per id for the cache window and reports the held ids the lint reads', async () => {
  forgetCredentialProbes();
  let clock = 1_000;
  let asked = 0;
  const exec = async () => { asked += 1; return { code: 0, stderr: '' }; };
  const d = { exec, env: { A: '1' } as NodeJS.ProcessEnv, platform: 'darwin' as const, now: () => clock, claudeLogin: async () => ({ loggedIn: false }) };
  const first = await credentialsHeld(['gh', 'gh', 'env:A', 'claude'], d);
  assert.deepEqual(first.map((v) => `${v.id}:${v.status}`), ['gh:ok', 'env:A:ok', 'claude:fail']);
  assert.equal(asked, 1, 'a duplicated id is asked once');
  await credentialsHeld(['gh'], d);
  assert.equal(asked, 1, 'inside the window the answer stands');
  assert.deepEqual(heldIdsCached().sort(), ['env:A', 'gh']);
  clock += 61_000;
  await credentialsHeld(['gh'], d);
  assert.equal(asked, 2, 'past the window it is asked again');
  forgetCredentialProbes();
  assert.deepEqual(heldIdsCached(), []);
});
