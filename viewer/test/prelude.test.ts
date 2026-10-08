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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECISION_KEYS } from '../shared/decisions-model.js';
import { MANIFEST_BLOCKING } from '../shared/policy-model.js';
import {
  PreludeRefusal, manifestRows, preludeFor, probeAccounts, probeCredentials, probeDelivery, probeMcp, probeTrees, resolvedManifest,
  gitStrategyLines, probeGitStrategy, GitStrategyRefusal, GIT_STRATEGY_ACKS, scopedSteps, doorOpens, doorSteps, itemOf,
  type AccountFacts, type PreludeDeps, type PreludeStep,
} from '../server/prelude.ts';
import { HumanStepLedger, sanitiseStep } from '../server/human-steps.ts';
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

/* ------------------------------------------------------------------ *
 * Probe 5 — verification (2026-09-18, run f0da619a)
 *
 * Everything a run's §Verification would stop for a person, asked at the door
 * instead: a phase that would PARK (Person-check: halt with a fragment the
 * runner will not run, nothing runnable, every lead missing) or that would
 * ALWAYS ask (halt-on-everything). The facts are the verification reviews the
 * service computes — this file stays a leaf and never imports the runner.
 * ------------------------------------------------------------------ */

type ReviewFact = {
  phase: number; verdict: string; park?: string; runs: string[];
  items: { text: string; reason: string; fp?: string; approvable?: boolean }[];
  waived: { text: string; reason: string }[]; setup: { text: string; reason: string }[]; missing: string[];
};

const review = (over: Partial<ReviewFact> & { phase: number }): ReviewFact => ({
  verdict: 'clear', runs: ['npm test'], items: [], waived: [], setup: [], missing: [], ...over,
});

const PARKS = review({
  phase: 2, verdict: 'parks',
  park: "phase 2's §Verification holds 1 check the runner will not run (first: frobnicate --check — `frobnicate` is not a recognised command) and the plan says Person-check: halt — …",
  items: [{ text: 'frobnicate --check', reason: '`frobnicate` is not a recognised command', fp: 'f'.repeat(64), approvable: true }],
});

test('verification: a phase that would park blocks the start under its own row, naming the phase and why', async () => {
  const prelude = await preludeFor('alpha', {}, deps({
    verification: async () => ({ reviews: [review({ phase: 1 }), PARKS], scope: null }),
  }));
  assert.equal(prelude.probes.verification.status, 'fail');
  const block = prelude.blocking.find((b) => b.key === 'verification.person-check');
  assert.ok(block, JSON.stringify(prelude.blocking));
  assert.match(block!.why, /phase 2/);
  assert.match(block!.why, /frobnicate --check/);
  assert.equal(prelude.rows.find((r) => r.key === 'verification.person-check')?.probe, 'verification');
  // The detail carries every review, so the Decisions stage can render the answers.
  assert.equal((prelude.probes.verification.detail as { reviews: unknown[] }).reviews.length, 2);
});

test('verification: nothing to stop for is ok — may-ask and Setup refusals are warnings, never blocks', async () => {
  const prelude = await preludeFor('alpha', {}, deps({
    verification: async () => ({
      reviews: [
        review({ phase: 1 }),
        review({ phase: 2, verdict: 'may-ask', items: [{ text: 'eyeball it', reason: 'no command' }] }),
        review({ phase: 3, setup: [{ text: 'frobnicate --serve', reason: '`frobnicate` is not a recognised command' }] }),
      ],
      scope: null,
    }),
  }));
  assert.equal(prelude.probes.verification.status, 'ok');
  assert.ok(!prelude.blocking.some((b) => b.key === 'verification.person-check'));
  assert.ok((prelude.probes.verification.warnings ?? []).length >= 2);
});

test('verification: halt-on-everything asks always, so it blocks too; a phase outside the scope only warns', async () => {
  const asks = await preludeFor('alpha', {}, deps({
    verification: async () => ({
      reviews: [review({ phase: 2, verdict: 'asks', items: [{ text: 'eyeball it', reason: 'no command' }] })], scope: null,
    }),
  }));
  assert.equal(asks.probes.verification.status, 'fail');

  const scoped = await preludeFor('alpha', {}, deps({
    verification: async () => ({ reviews: [review({ phase: 1 }), PARKS], scope: [1] }),
  }));
  assert.equal(scoped.probes.verification.status, 'ok');
  assert.ok((scoped.probes.verification.warnings ?? []).some((w) => /phase 2/.test(w)), 'shown, not blocking');
});

test('verification: with no plan in front of it (the doctor) the probe skips and refuses nothing', async () => {
  const prelude = await preludeFor('alpha', {}, deps());
  assert.equal(prelude.probes.verification.status, 'skip');
  assert.ok(!prelude.blocking.some((b) => b.key === 'verification.person-check'));
});

test('prelude.ts stays a runtime leaf — the offline doctor imports it (bin/doctor-verb.mjs)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server/prelude.ts'), 'utf8');
  const runtime = [...source.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(runtime.length > 0);
  for (const specifier of runtime) {
    assert.match(specifier, /^\.\.\/shared\//, `prelude.ts imports ${specifier} at runtime — only ../shared/* leaves may be`);
  }
});

test('verification: a park the door cannot answer (no bullet, nothing it can name) warns — lint F14 and boarding own it', async () => {
  // Approve and waive answer a NAMED command or fragment. A phase with no
  // §Verification at all, or whose every lead is missing from this machine,
  // has nothing to approve: lint F14 fails the plan and boarding parks the
  // phase, as they did before this probe. Blocking the start on it would stop
  // a run whose first hours are fine for a defect the door cannot fix.
  const prelude = await preludeFor('alpha', {}, deps({
    verification: async () => ({
      reviews: [review({ phase: 3, verdict: 'parks', park: 'the plan states no verification for phase 3 — …', runs: [], items: [] })],
      scope: null,
    }),
  }));
  assert.equal(prelude.probes.verification.status, 'ok');
  assert.ok((prelude.probes.verification.warnings ?? []).some((w) => /phase 3.*states no verification/.test(w)));
});

/* ---- probe 6: the shared trees (control-tower phase 40, #41, BA-7) ---- */

test('trees: another run holding a scoped repository is named, and isolation is recommended when the console can grant it — never a block', async () => {
  const held = [{ repo: 'app', branch: 'pe/beta', run: 'r-beta', slug: 'beta' }];
  const prelude = await preludeFor('alpha', {}, deps({
    trees: async () => ({ held, isolated: false, grantable: true }),
  }));
  assert.equal(prelude.probes.trees.status, 'ok');
  assert.match(prelude.probes.trees.reason, /another run holds `app` on `pe\/beta` \(run r-beta of beta\)/);
  assert.match(prelude.probes.trees.reason, /start this run isolated/);
  assert.deepEqual(prelude.probes.trees.warnings, ['`app` on `pe/beta` (run r-beta of beta)']);
  assert.equal(prelude.blocking.length, 0, 'a held tree queues phases; it never refuses the start');

  const refused = probeTrees({ held, isolated: false, grantable: false, refusal: 'the plan scopes no repository' });
  assert.match(refused.reason, /will queue until/);
  assert.match(refused.reason, /isolation is not available here \(the plan scopes no repository\)/);
  assert.doesNotMatch(refused.reason, /start this run isolated/, 'never recommends what the console cannot grant');

  const isolated = probeTrees({ held, isolated: true, grantable: true });
  assert.equal(isolated.status, 'ok');
  assert.match(isolated.reason, /this run is isolated — it stands in trees of its own and is not held by it/);
  assert.equal(isolated.warnings, undefined);

  assert.deepEqual(probeTrees({ held: [], isolated: false, grantable: true }),
    { status: 'ok', ok: true, reason: "no scoped repository stands on another run's branch" });
  assert.equal(probeTrees(null).status, 'skip');
  assert.equal((await preludeFor('alpha', {}, deps())).probes.trees.status, 'skip', 'no facts, no verdict');
  const broken = await preludeFor('alpha', {}, deps({ trees: async () => { throw new Error('git is gone'); } }));
  assert.equal(broken.probes.trees.status, 'skip');
  assert.match(broken.probes.trees.reason, /could not be read: git is gone/);
});

/* ------------------------------------------------------------------ *
 * Probe 7 — the plan's git lines against the chosen strategy (control-tower phase 11, #18)
 * ------------------------------------------------------------------ */

const FACTS = {
  gitMode: 'new-branch', runBranch: 'pe/demo', isolated: false, superproject: false,
  planWorktrees: false, checkoutPhases: [] as number[],
};

test('probe 7 names a Branch line the new-branch strategy will not create — and only then', () => {
  const named = gitStrategyLines({ ...FACTS, planBranch: 'feature/checkout' });
  assert.deepEqual(named.map((line) => [line.kind, line.plan, line.honourable]), [['branch', 'feature/checkout', false]]);
  assert.match(named[0]!.run, /`pe\/demo`/);
  // The default idioms name no branch, prose naming the run branch agrees,
  // and a run that imposes no branch of its own overrides nothing.
  assert.deepEqual(gitStrategyLines({ ...FACTS, planBranch: 'current branch (no new branch)' }), []);
  assert.deepEqual(gitStrategyLines({ ...FACTS, planBranch: '`pe/demo` — it EXISTS, adopted at launch' }), []);
  assert.deepEqual(gitStrategyLines({ ...FACTS, gitMode: 'current', planBranch: 'feature/checkout' }), []);
});

test('probe 7: Worktrees: on is a per-lane ask a shared checkout cannot grant and a superproject never grants', () => {
  const shared = gitStrategyLines({ ...FACTS, planWorktrees: true });
  assert.deepEqual(shared.map((line) => [line.kind, line.honourable]), [['worktrees', true]]);
  assert.match(shared[0]!.run, /shared-checkout run cannot grant/);
  // Isolated in a plain repository: granted, no line.
  assert.deepEqual(gitStrategyLines({ ...FACTS, planWorktrees: true, isolated: true }), []);
  // A superproject: refused per lane even when the run is isolated — the mirror is the run-level answer.
  const superproject = gitStrategyLines({ ...FACTS, planWorktrees: true, isolated: true, superproject: true });
  assert.deepEqual(superproject.map((line) => [line.kind, line.honourable]), [['worktrees', false]]);
  assert.match(superproject[0]!.run, /superproject never grants/);
});

test('probe 7: Checkout: main is inert under a shared checkout and names its phases', () => {
  const lines = gitStrategyLines({ ...FACTS, checkoutPhases: [3, 7] });
  assert.deepEqual(lines.map((line) => [line.kind, line.phases, line.honourable]), [['checkout', [3, 7], true]]);
  assert.match(lines[0]!.plan, /phases 3, 7/);
  assert.deepEqual(gitStrategyLines({ ...FACTS, checkoutPhases: [3], isolated: true }), [], 'a checkout of the run\'s own honours it');
});

test('probe 7 warns and never blocks; the start door asks for honour or override instead', async () => {
  assert.deepEqual([...GIT_STRATEGY_ACKS], ['honour', 'override']);
  const verdict = probeGitStrategy({ ...FACTS, planBranch: 'feature/x', checkoutPhases: [2] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings?.length, 2);
  assert.equal(probeGitStrategy(null).status, 'skip');
  assert.equal(probeGitStrategy(FACTS).warnings, undefined);

  const prelude = await preludeFor('demo', {}, deps({ gitStrategy: async () => ({ ...FACTS, planBranch: 'feature/x' }) }));
  assert.equal(prelude.probes['git-strategy'].warnings?.length, 1);
  assert.equal(prelude.blocking.length, 0, 'a git line is answered at the start door, never as a blocking row');
  const refusal = new GitStrategyRefusal((prelude.probes['git-strategy'].detail as { lines: never[] }).lines, null);
  assert.match(refusal.message, /"honour" or "override"/);
});

/* ------------------------------------------------------------------ *
 * Probe 9 — the launch door asks for a person's turns (control-tower phase 44)
 * ------------------------------------------------------------------ */

const STEP_BROWSER = { kind: 'browser-login', what: 'Sign in to Vercel', open: 'vercel login', proof: 'cmd:"vercel whoami"', where: 'host' } as const;
const STEP_APPROVAL = { kind: 'third-party-approval', what: 'An org owner approves the app', open: 'https://github.com/organizations/acme/settings/oauth_application_policy', proof: 'cmd:"gh api orgs/acme"', where: 'any', windowMinutes: 2880 } as const;
const STEP_BARE = { kind: 'physical', what: 'Plug the test phone in', where: 'host' } as const;

test('the launch door lists the plan-declared steps for the scoped phases — onlyPhases, else every phase not done', () => {
  const steps: Record<number, readonly (typeof STEP_BROWSER | typeof STEP_APPROVAL | typeof STEP_BARE)[]> = {
    1: [STEP_BROWSER], 2: [STEP_APPROVAL, STEP_BARE], 3: [],
  };
  const of = (phase: number) => (steps[phase] ?? []) as never[];
  assert.deepEqual(scopedSteps(of, [1, 2, 3], { done: [1] }).map((s) => [s.phase, (s.step as { what: string }).what]),
    [[2, STEP_APPROVAL.what], [2, STEP_BARE.what]], 'a done phase needs nobody');
  assert.deepEqual(scopedSteps(of, [1, 2, 3], { onlyPhases: [1], done: [1] }).map((s) => s.phase), [1],
    'a scoped run asks for its own phases, whatever the board says');
  assert.deepEqual(scopedSteps(of, [1, 2, 3]).length, 3);
});

test('the launch door runs every proof AT ONCE, pre-clears the proven, and returns the rest with their open actions', async () => {
  let inFlight = 0;
  let peak = 0;
  const asked: string[] = [];
  const probeStep = async (ref: string) => {
    asked.push(ref);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return ref.includes('vercel') ? { landed: true, read: 'landed — exit 0' } : { landed: false, read: 'pending — exit 1' };
  };
  const listed = [
    { phase: 2, step: STEP_BROWSER }, { phase: 3, step: STEP_APPROVAL }, { phase: 3, step: STEP_BARE },
  ] as never[];
  const prelude = await preludeFor('demo', {}, deps({ humanSteps: async () => listed, probeStep }));
  assert.equal(peak, 2, 'both proofs were out at the same time — the door does not probe one by one');
  assert.deepEqual(asked.sort(), [STEP_APPROVAL.proof, STEP_BROWSER.proof].sort(), 'a step with no proof runs nothing');
  const [browser, approval, bare] = prelude.humanSteps;
  assert.equal(browser!.state, 'pre-cleared');
  assert.deepEqual(browser!.open, { command: 'vercel login' });
  assert.equal(approval!.state, 'needed');
  assert.deepEqual(approval!.open, { url: STEP_APPROVAL.open }, 'an http(s) open value is a link to open');
  assert.equal(approval!.read, 'pending — exit 1');
  assert.equal(approval!.windowMinutes, 2880);
  assert.equal(bare!.state, 'unchecked', 'no proof: only a person can say');
  const verdict = prelude.probes['human-steps'];
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /this run will need you 2 times \(1 more pre-cleared at the door\)/);
  assert.equal(verdict.warnings?.length, 2);
  assert.deepEqual(prelude.blocking, [], 'a person\'s turn is an ask at the door, never a refused start');
  // It rides the stored manifest like every other probe.
  assert.equal(resolvedManifest(prelude).probes['human-steps']?.status, 'ok');
});

test('the launch door: nothing declared skips; a probe that throws leaves the step unchecked, never blocking', async () => {
  const none = await preludeFor('demo', {}, deps({ humanSteps: async () => [] }));
  assert.equal(none.probes['human-steps'].status, 'skip');
  assert.deepEqual(none.humanSteps, []);
  const thrown = await preludeFor('demo', {}, deps({
    humanSteps: async () => [{ phase: 2, step: STEP_BROWSER }] as never[],
    probeStep: async () => { throw new Error('gh is not installed'); },
  }));
  assert.equal(thrown.humanSteps[0]!.state, 'unchecked');
  assert.match(thrown.humanSteps[0]!.read ?? '', /could not run: gh is not installed/);
  assert.deepEqual(thrown.blocking, []);
  // A console with no plan in front of it (the doctor) asks nothing at all.
  const doctor = await preludeFor('demo', {}, deps());
  assert.equal(doctor.probes['human-steps'].status, 'skip');
});

test('phase 132: every credential id the preflight probes is a credential: proof the watch clock reads — and only those', async () => {
  const { parseWatchRef } = await import('../server/watch-refs.ts');
  const { credentialProof } = await import('../server/turn/index.ts');
  for (const id of ['gh', 'claude', 'claude-login', 'env:DEPLOY_KEY', 'keychain:svc', 'file:~/.netrc']) {
    assert.equal(knownCredentialId(id), true, id);
    assert.equal(parseWatchRef(credentialProof(id))?.kind, 'credential', `credential:${id} is a proof`);
  }
  for (const id of ['npm', 'aws-prod']) {
    assert.equal(knownCredentialId(id), false);
    assert.equal(parseWatchRef(credentialProof(id)), null, `${id} has no probe, so it is no proof`);
  }
});

/* ------------------------------------------------------------------ *
 * The launch door opens a plan's `auto-open: host` step (control-tower phase 139)
 *
 * §Architecture 12's safety floor, promised since phase 41: a step the PLAN
 * marked `auto-open: host` opens on the machine at the launch door — and only
 * there, only behind a flag, only a link, only one the person was shown in full.
 * `doorOpens` is that rule as a pure function; every clause below is one way for
 * a step not to open.
 * ------------------------------------------------------------------ */

const LOGIN = 'https://vercel.com/login?next=/cli';
const FLAGGED = { shown: [LOGIN], allowTerminal: true, allowAgent: false };

/** One plan-declared step as the launch door lists it, marked to open on the host. */
function doorStep(over: Partial<PreludeStep> = {}): PreludeStep {
  return {
    phase: 2, kind: 'browser-login', what: 'Sign in to Vercel', where: 'host', state: 'unchecked',
    open: { url: LOGIN }, autoOpen: 'host', ...over,
  };
}

test('doorOpens: a plan step that said auto-open: host opens for a link the form showed — owed or unchecked, in the plan\'s order', () => {
  assert.deepEqual(
    doorOpens([doorStep()], FLAGGED),
    [{ phase: 2, kind: 'browser-login', what: 'Sign in to Vercel', url: LOGIN }],
  );
  assert.equal(doorOpens([doorStep({ state: 'needed' })], FLAGGED).length, 1, 'a proof that ran and does not hold is owed as much as none');
  // Each listed step is judged on its own: the unmarked one in the middle opens nothing.
  const approval = 'https://github.com/apps/acme/installations/new';
  const opens = doorOpens(
    [doorStep(), doorStep({ phase: 3, what: 'No auto-open word', autoOpen: undefined }), doorStep({ phase: 4, what: 'Approve the app', open: { url: approval } })],
    { ...FLAGGED, shown: [LOGIN, approval] },
  );
  assert.deepEqual(opens.map((open) => [open.phase, open.url]), [[2, LOGIN], [4, approval]]);
});

test('doorOpens: nothing opens on a console that may not open anything on the machine — and either flag is enough', () => {
  assert.deepEqual(doorOpens([doorStep()], { ...FLAGGED, allowTerminal: false, allowAgent: false }), []);
  assert.equal(doorOpens([doorStep()], { ...FLAGGED, allowTerminal: false, allowAgent: true }).length, 1, '--allow-agent alone suffices');
  assert.equal(doorOpens([doorStep()], { ...FLAGGED, allowTerminal: true, allowAgent: false }).length, 1, '--allow-terminal alone suffices');
});

test('doorOpens: only a link the form SHOWED opens, exactly as spelled — another spelling, a longer or shorter link, or nothing shown, opens nothing', () => {
  for (const shown of [
    [], // a door that showed nothing: converge, a webhook, bin/
    [`${LOGIN}/`], [LOGIN.toUpperCase()], [` ${LOGIN}`], [`${LOGIN} `], // other spellings of it
    ['https://vercel.com/login'], [`${LOGIN}&x=1`], // a prefix of it, and a longer one
    ['https://example.com/'], // a different link altogether
  ]) {
    assert.deepEqual(doorOpens([doorStep()], { ...FLAGGED, shown }), [], JSON.stringify(shown));
  }
  assert.equal(doorOpens([doorStep()], { ...FLAGGED, shown: ['https://example.com/', LOGIN] }).length, 1, 'one among several shown');
});

test('doorOpens: never a command, and never a link that is not http(s) — whatever the form sent back', () => {
  for (const link of ['file:///etc/hosts', 'ftp://files.example.com/x', 'javascript:alert(1)', 'vscode://file/etc/hosts', 'mailto:a@example.com', 'http://', 'https:///nohost']) {
    // Hand-built — `doorSteps` itself would make each of these a command — so the rule
    // is held on its own, not by the door that lists the steps.
    assert.deepEqual(doorOpens([doorStep({ open: { url: link } })], { ...FLAGGED, shown: [link] }), [], link);
  }
  assert.deepEqual(
    doorOpens([doorStep({ open: { command: 'vercel login' } })], { ...FLAGGED, shown: ['vercel login'] }), [],
    'a command is the terminal\'s, run on a person\'s Enter',
  );
  assert.deepEqual(doorOpens([doorStep({ open: undefined })], FLAGGED), [], 'a step with nothing to open');
});

test('doorOpens: a pre-cleared step needs nobody, and a step with a due-when is not asked yet — neither opens', () => {
  assert.deepEqual(doorOpens([doorStep({ state: 'pre-cleared' })], FLAGGED), []);
  assert.deepEqual(doorOpens([doorStep({ due: 'date:2099-01-01T00:00:00Z' })], FLAGGED), []);
  assert.deepEqual(doorOpens([doorStep({ due: 'phase:demo/2' })], FLAGGED), []);
  assert.deepEqual(doorOpens([doorStep({ autoOpen: undefined })], FLAGGED), [], 'the plan did not say auto-open');
});

test('doorOpens over the real door: the plan bullet\'s own words, through doorSteps, open one link and nothing else', async () => {
  const registrar = 'https://registrar.example/renew';
  const listed = [
    { phase: 2, step: { kind: 'browser-login', what: 'Sign in to Vercel', where: 'host', open: LOGIN, autoOpen: 'host' } },
    { phase: 3, step: { kind: 'browser-login', what: 'Sign the gh CLI in', where: 'host', open: 'gh auth login --web', autoOpen: 'host' } },
    { phase: 4, step: { kind: 'physical', what: 'Plug the test phone in', where: 'host' } },
    { phase: 5, step: { kind: 'operator-act', what: 'Renew the domain', where: 'host', open: registrar, autoOpen: 'host', due: 'date:2099-01-01T00:00:00Z' } },
    { phase: 6, step: { kind: 'browser-login', what: 'Read the docs', where: 'any', open: 'https://docs.example/' } },
  ] as never[];
  const steps = await doorSteps(listed, undefined);
  const opens = doorOpens(steps, { shown: [LOGIN, registrar, 'https://docs.example/', 'gh auth login --web'], allowTerminal: true, allowAgent: false });
  assert.deepEqual(opens.map((open) => open.phase), [2], 'a command, a bare step, a step not due and a link with no auto-open word stay shut');
});

test('a session\'s step never carries auto-open: the ledger drops the word from every birth but the plan', () => {
  const offered = { kind: 'browser-login', title: 'Sign in to Vercel', open_url: LOGIN, auto_open: 'host' };
  for (const birth of ['session', 'console', 'supervisor'] as const) {
    const clean = sanitiseStep(offered, birth)!;
    assert.equal(clean.step.autoOpen, undefined, birth);
    assert.ok(clean.dropped.includes('auto-open'), `${birth}: offered, and not kept`);
    assert.equal(clean.step.openUrl, LOGIN, 'the link itself is kept — only the self-opening is dropped');
  }
  const plan = sanitiseStep(offered, 'plan')!;
  assert.equal(plan.step.autoOpen, 'host');
  assert.deepEqual(plan.dropped, []);
  // The other spelling is read the same way, and `host` is the only word there is.
  assert.equal(sanitiseStep({ kind: 'browser-login', title: 'Sign in', autoOpen: 'host' }, 'session')!.step.autoOpen, undefined);
  assert.equal(sanitiseStep({ ...offered, auto_open: 'anywhere' }, 'plan')!.step.autoOpen, undefined);
});

test('itemOf: the open step of THIS plan, born plan, with the same phase, kind and title — a session\'s or another plan\'s is not it', () => {
  const held = (over: Record<string, unknown> = {}) => ({
    id: 'hs-1', slug: 'demo', birth: 'plan', phase: 2, kind: 'browser-login', title: 'Sign in to Vercel', ...over,
  });
  assert.equal(itemOf(doorStep(), [held()], 'demo'), 'hs-1');
  assert.equal(itemOf(doorStep({ what: '  Sign in to Vercel  ' }), [held()], 'demo'), 'hs-1', 'the title is trimmed, as the door asks it');
  for (const [why, other] of [
    ['a session declared the same words', held({ birth: 'session' })],
    ['the console raised the same words', held({ birth: 'console' })],
    ['the supervisor raised them', held({ birth: 'supervisor' })],
    ['another plan asked the same', held({ slug: 'other' })],
    ['another phase', held({ phase: 3 })],
    ['another kind', held({ kind: 'device-code' })],
    ['another title', held({ title: 'Sign in to Netlify' })],
  ] as const) assert.equal(itemOf(doorStep(), [other], 'demo'), undefined, why);
  assert.equal(itemOf(doorStep(), [held({ birth: 'session', id: 'hs-s' }), held({ id: 'hs-p' })], 'demo'), 'hs-p', 'the plan\'s own is found past a session\'s');
  assert.equal(itemOf(doorStep(), [], 'demo'), undefined);
});

test('itemOf over a real ledger: the plan\'s step is found, a session\'s of the same words is not, and a settled one is no longer open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-door-item-'));
  try {
    const ledger = new HumanStepLedger(join(dir, 'human-steps.ndjson'));
    const declare = (birth: 'plan' | 'session', slug = 'demo') => ledger.declare({
      slug, phase: 2, birth, clean: sanitiseStep({ kind: 'browser-login', title: 'Sign in to Vercel', open_url: LOGIN }, birth)!.step,
    });
    const bySession = declare('session');
    assert.equal(itemOf(doorStep(), ledger.open(), 'demo'), undefined, 'a session\'s step of the same words is another ask');
    const byPlan = declare('plan');
    assert.notEqual(byPlan.id, bySession.id);
    assert.equal(itemOf(doorStep(), ledger.open(), 'demo'), byPlan.id);
    assert.equal(itemOf(doorStep(), ledger.open(), 'other'), undefined, 'another plan\'s launch does not borrow it');
    ledger.move(byPlan.id, 'dismissed', { by: 'tester', verb: 'dismiss' });
    assert.equal(itemOf(doorStep(), ledger.open(), 'demo'), undefined, 'a settled step no longer asks');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prelude names, on each owed step, the item that already asks for it — none on a pre-cleared step, a session\'s step or an unreadable ledger', async () => {
  const listed = [{ phase: 2, step: STEP_BROWSER }, { phase: 3, step: STEP_APPROVAL }, { phase: 3, step: STEP_BARE }] as never[];
  const probeStep = async (ref: string) => (ref.includes('vercel')
    ? { landed: true, read: 'landed — exit 0' } : { landed: false, read: 'pending — exit 1' });
  const held = [
    // An earlier launch asked the pre-cleared step; nobody will ask it now, so no item is named for it.
    { id: 'hs-browser', slug: 'demo', birth: 'plan', phase: 2, kind: 'browser-login', title: STEP_BROWSER.what },
    { id: 'hs-approval', slug: 'demo', birth: 'plan', phase: 3, kind: 'third-party-approval', title: STEP_APPROVAL.what },
    // A session declared the bare step's words: its own ask, not the plan's.
    { id: 'hs-session', slug: 'demo', birth: 'session', phase: 3, kind: 'physical', title: STEP_BARE.what },
  ];
  const prelude = await preludeFor('demo', {}, deps({ humanSteps: async () => listed, probeStep, openSteps: () => held }));
  const [browser, approval, bare] = prelude.humanSteps;
  assert.equal(browser!.state, 'pre-cleared');
  assert.equal(browser!.item, undefined);
  assert.equal(approval!.item, 'hs-approval');
  assert.equal(bare!.item, undefined);
  // It rides the stored manifest's probe like every other field, and the ask itself is unchanged.
  assert.equal(prelude.probes['human-steps'].ok, true);
  assert.deepEqual(prelude.blocking, []);

  // No ledger handed over (the doctor, a caller with none): nothing is named.
  const bare2 = await preludeFor('demo', {}, deps({ humanSteps: async () => listed, probeStep }));
  assert.deepEqual(bare2.humanSteps.map((step) => step.item), [undefined, undefined, undefined]);
  // A ledger that throws is the same silence — the steps are still listed, the probe still ok.
  const thrown = await preludeFor('demo', {}, deps({
    humanSteps: async () => listed, probeStep, openSteps: () => { throw new Error('the ledger is unreadable'); },
  }));
  assert.equal(thrown.humanSteps.length, 3);
  assert.deepEqual(thrown.humanSteps.map((step) => step.item), [undefined, undefined, undefined]);
  assert.equal(thrown.probes['human-steps'].status, 'ok');
});
