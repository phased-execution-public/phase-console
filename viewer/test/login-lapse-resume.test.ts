/**
 * A lapsed login stops an unattended run only until it works again
 * (control-tower phase 91, #147 asks 4 and 5; operator decision 12).
 *
 * A run stopped because its login EXPIRED or was SIGNED OUT resumes by itself
 * once `claude auth status` and a usage read both succeed on the identity the
 * run started on — no press. An organisation or policy refusal stays a person's
 * (RCV-1 kept): a relaunch by clock would only meet the same wall. And before a
 * login a live or queued run depends on can no longer be renewed, a person is
 * told, with the exact fix.
 *
 * KA-5  converge relaunches an expired/signed-out stop once the login is
 *       restored on the same identity; org and policy stops stay press-only
 * KA-5  the facade reopens an `auth` retirement on proof — `auth status` and a
 *       read that landed after it — and only an `auth` one
 * KA-5  the service's fact reads the run's own account, since its halt, on the
 *       identity it is bound to
 * KA-4  a login a run depends on that cannot be renewed is announced (push and
 *       the notification inbox) with the exact fix; one nobody depends on is not
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATE_SANDBOX } from './state-sandbox.ts';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { planConvergence } = await import('../server/converge.ts');
type RunState = import('../server/runner/state.ts').RunState;
type RunIdentity = import('../server/accounts/index.ts').RunIdentity;
type Exec = import('../server/accounts/credentials.ts').Exec;

const HOUR = 3_600_000;
const ADMIN: RunIdentity = { account: 'default', key: 'k-admin', email: 'admin@example.com', org: 'The Market' };

function haltedOn(cls: string, over: (state: RunState) => void = () => {}): RunState {
  const state = newRun({ slug: 'alpha', root: '/nonexistent' });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.identity = { ...ADMIN, at: '2026-09-26T01:00:00.000Z' };
  const at = '2026-09-26T02:00:00.000Z';
  state.halt = { at, reason: `the API refused the login (account: the machine login)`, phase: 1, kind: 'credential-refused' };
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.cause = { kind: 'credential-refused', class: cls, reason: 'refused', at } as never;
  over(state);
  return state;
}

const facts = (run: RunState, trigger: 'timer' | 'button', loginRestored?: (run: RunState) => boolean) => ({
  slug: 'alpha', now: Date.now(), trigger, board: { 1: 'ready', 2: 'ready', 3: 'waiting' }, runs: [run], live: new Set<string>(),
  locks: [], prefs: { resumeAtBoot: 'auto' }, pidAlive: () => false, ...(loginRestored ? { loginRestored } : {}),
});
const kinds = (plan: { actions: { kind: string }[] }) => plan.actions.map((a) => a.kind);

/* ------------------------------------------------------------------ *
 * KA-5 — converge
 * ------------------------------------------------------------------ */

test('KA-5: an expired or signed-out stop is relaunched by the clock once the login is restored on the same identity — not before', () => {
  const run = haltedOn('auth');
  const waiting = planConvergence(facts(run, 'timer', () => false) as never);
  assert.ok(!kinds(waiting).includes('relaunch'), `not restored yet: ${kinds(waiting).join(',')}`);
  const restored = planConvergence(facts(run, 'timer', () => true) as never);
  assert.ok(kinds(restored).includes('relaunch'), `restored: ${kinds(restored).join(',')}`);
  const relaunch = restored.actions.find((a) => a.kind === 'relaunch') as { why?: string[] } | undefined;
  assert.match((relaunch?.why ?? []).join(' '), /login/);
});

test('KA-5: an organisation, billing or policy refusal stays a person\'s press whatever the login says (RCV-1 kept)', () => {
  for (const cls of ['org-policy', 'billing']) {
    const run = haltedOn(cls);
    const plan = planConvergence(facts(run, 'timer', () => true) as never);
    assert.ok(!kinds(plan).includes('relaunch'), `${cls}: ${kinds(plan).join(',')}`);
    const pressed = planConvergence(facts(run, 'button', () => true) as never);
    assert.ok(kinds(pressed).includes('relaunch'), `${cls} by button: ${kinds(pressed).join(',')}`);
  }
});

/* ------------------------------------------------------------------ *
 * KA-5 — the facade reopens an auth retirement on proof
 * ------------------------------------------------------------------ */

function signIn(dir: string, token: string): void {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + 6 * HOUR, subscriptionType: 'max' },
  }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'lapse@example.com', organizationUuid: 'org-lapse', organizationName: 'Lapse org' },
  }));
}

function reading(): typeof fetch {
  return (async () => new Response(JSON.stringify({
    five_hour: { utilization: 5, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(Date.now() + 48 * HOUR).toISOString() },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('KA-5: an expired login\'s retirement is reopened once `auth status` and a usage read succeed after it — an org refusal\'s is not', async () => {
  const statuses: string[] = [];
  const exec: Exec = async (file, args, opts) => {
    if (file === 'claude' && args[0] === '--version') return { stdout: '9.9.9 (Claude Code)\n' };
    if (file === 'claude' && args[0] === 'auth' && args[1] === 'status') {
      statuses.push(String(opts?.env?.CLAUDE_CONFIG_DIR ?? ''));
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'lapse@example.com' }) };
    }
    return { stdout: '' };
  };
  const accounts = new Accounts({
    platform: 'linux', exec, fetchFn: reading(), usageBase: 'http://usage.invalid',
    learnedFile: join(STATE_SANDBOX, 'learned-p91-lapse.json'),
  });
  try {
    const expired = accounts.beginProfile('expired');
    const policy = accounts.beginProfile('policy');
    signIn(expired.dir, 'tok-expired');
    signIn(policy.dir, 'tok-policy');
    const key = accounts.identityOf(expired.id)?.key;
    accounts.retire(expired.id, undefined, 'the API refused the login', 'classifier', 'auth');
    accounts.retire(policy.id, undefined, 'organization policy blocks this credential', 'classifier', 'org-policy');
    const since = new Date(Date.now() - 1000).toISOString();
    assert.equal(accounts.loginRestored(expired.id, since, key), false, 'nothing has proved it yet');

    await accounts.refreshUsage(expired.id);
    await accounts.refreshUsage(policy.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(statuses.includes(expired.dir), '`auth status` was asked under the expired profile');
    assert.equal(accounts.entitlementOf(expired.id).state, 'entitled', 'the login works again — the retirement is answered');
    assert.equal(accounts.loginRestored(expired.id, since, key), true);
    assert.equal(accounts.loginRestored(expired.id, since, 'k-somebody-else'), false, 'only on the identity the run is bound to');
    assert.equal(accounts.loginRestored(expired.id, new Date(Date.now() + HOUR).toISOString(), key), false, 'only by proof newer than the stop');
    assert.notEqual(accounts.entitlementOf(policy.id).state, 'entitled', 'an organisation refusal is not a lapse');
    assert.equal(accounts.loginRestored(policy.id, since, accounts.identityOf(policy.id)?.key), false);
    await accounts.remove(expired.id);
    await accounts.remove(policy.id);
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * KA-5 / KA-4 — the service's fact and its warning
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-26
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-lapse-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

test('KA-5: the service asks the run\'s own account, since its halt, on the identity it is bound to', async () => {
  const root = scratch();
  const svc = service(root);
  const real = (svc as unknown as { accounts: unknown }).accounts;
  try {
    const asked: [string | undefined, string, string | undefined][] = [];
    (svc as unknown as { accounts: unknown }).accounts = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      loginRestored: (id: string | undefined, since: string, key: string | undefined) => { asked.push([id, since, key]); return true; },
      identityOf: () => ADMIN,
    });
    const restored = (svc as unknown as { loginRestoredFor: (run: RunState) => boolean }).loginRestoredFor.bind(svc);
    const run = haltedOn('auth', (state) => { state.root = root; state.accountId = 'acct-a'; });
    assert.equal(restored(run), true);
    assert.deepEqual(asked, [['acct-a', run.halt!.at, 'k-admin']]);
    assert.equal(restored(haltedOn('org-policy')), false, 'never asked for a refusal that is not a lapse');
    assert.equal(restored({ ...run, halt: { ...run.halt!, kind: 'failure-streak' } }), false);
  } finally {
    (svc as unknown as { accounts: unknown }).accounts = real;
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('KA-4: a login a live or queued run depends on that can no longer be renewed is announced with the exact fix — one nobody depends on is not', async () => {
  const root = scratch();
  const svc = service(root);
  const told: { category: string; title: string; body: string }[] = [];
  (svc as unknown as { announce: (category: string, message: { title: string; body: string }) => null }).announce =
    (category, message) => { told.push({ category, title: message.title, body: message.body }); return null; };
  try {
    const run = newRun({ slug: 'alpha', root, accountId: 'acct-a' });
    run.status = 'paused';
    saveRun(run);
    const risk = { reason: 'the CLI could not renew the login — its refresh was refused', fix: 'CLAUDE_CONFIG_DIR=$HOME/.local/state/x/acct-a/config claude auth login' };
    const warn = (svc as unknown as { loginAtRisk: (view: { id: string; email?: string }, risk: { reason: string; fix: string }) => boolean }).loginAtRisk.bind(svc);
    assert.equal(warn({ id: 'acct-a', email: 'a@example.com' }, risk), true);
    assert.equal(told.length, 1);
    assert.equal(told[0].category, 'limits');
    assert.match(told[0].title, /a@example\.com/);
    assert.ok(told[0].body.includes(risk.fix), 'the exact fix is in the message');
    assert.match(told[0].body, /alpha/, 'and the run that depends on it');
    assert.equal(warn({ id: 'acct-nobody' }, risk), false, 'no run depends on it — nothing to say');
    assert.equal(told.length, 1);
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});
