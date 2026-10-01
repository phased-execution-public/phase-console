/**
 * An account that broke is repaired where it was diagnosed (control-tower
 * phase 13, #33) — CR-1..7.
 *
 * Of the three kinds only a profile could be signed in from the console: the
 * machine login was refused by the sign-in door and exempt from the signed-out
 * sentence, and a token account had no way back at all — re-pasting a token
 * minted a SECOND account, which is exactly the duplicate-identity state the
 * usage dialog warns about. And the view left the bar nothing to draw for an
 * account whose login broke.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { METER_STATES, RELOGIN_CONFIRM } from '../shared/ops-vocab.js';
import type { Exec } from '../server/accounts/credentials.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Accounts, meterStateOf } = await import('../server/accounts/index.ts');
const { recent } = await import('../server/log.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quietExec: Exec = async () => ({ stdout: '' });

/** A facade over its own registry, answering usage reads from `fetchFn`. */
function makeAccounts(fetchFn?: typeof fetch) {
  const registryDir = mkdtempSync(join(tmpdir(), 'pc-cred-replace-'));
  return new Accounts({
    platform: 'linux', exec: quietExec, registryDir,
    learnedFile: join(registryDir, 'learned.json'),
    ...(fetchFn ? { fetchFn, usageBase: 'http://usage.invalid' } : {}),
  });
}

type Internals = {
  creds: { readToken(id: string): Promise<string | null>; readIdentity(dir: string | null): unknown };
  poller: { cache: Map<string, Record<string, unknown>>; snapshot(id: string): Record<string, unknown> | undefined };
};
const inside = (accounts: InstanceType<typeof Accounts>) => accounts as unknown as Internals;

const viewOf = async (accounts: InstanceType<typeof Accounts>, id: string) =>
  (await accounts.list()).find((view) => view.id === id);

/* ------------------------------------------------------------------ *
 * CR-1..3 — a credential is REPLACED, never re-added
 * ------------------------------------------------------------------ */

test('CR-1: replaceToken keeps the id and the name, swaps the credential, and forgets what the old one taught', async () => {
  const accounts = makeAccounts();
  try {
    const added = await accounts.addToken('Spare', 'sk-ant-oat01-oldtokenvalue000000');
    // What the old credential taught the machine: a wall, and the poller's
    // verdict that this kind of credential has no meters.
    accounts.markLimited(added.id, 'five_hour', new Date(Date.now() + 3_600_000).toISOString());
    inside(accounts).poller.cache.set(added.id, { buckets: {}, unsupported: true });
    assert.ok(accounts.limitedUntil(added.id).five_hour);

    const replaced = await accounts.replaceToken(added.id, 'sk-ant-oat01-newtokenvalue111111');
    assert.equal(replaced?.id, added.id, 'the same id — journals, runs and pools keep pointing at it');
    assert.equal(replaced?.name, 'Spare');
    assert.equal(await inside(accounts).creds.readToken(added.id), 'sk-ant-oat01-newtokenvalue111111', 'the credential itself was swapped');
    assert.deepEqual(accounts.limitedUntil(added.id), {}, 'the learned row went with the old credential');
    assert.notEqual(inside(accounts).poller.snapshot(added.id)?.unsupported, true, 'and so did the poller\'s verdict');
    assert.equal((await accounts.list()).filter((view) => view.name === 'Spare').length, 1, 'still one account');
    assert.ok(recent().some((entry) => JSON.stringify(entry).includes('accounts.token.replaced')), 'the replacement is logged by name');
    assert.ok(!JSON.stringify(replaced).includes('newtokenvalue'), 'no secret in the answer');

    // A profile signs in again; it has no token to replace. An unknown id is nothing.
    await assert.rejects(() => accounts.replaceToken('default', 'sk-ant-oat01-whatevervalue2222222'), /sign/i);
    assert.equal(await accounts.replaceToken('no-such-account', 'sk-ant-oat01-whatevervalue2222222'), undefined);
    await assert.rejects(() => accounts.replaceToken(added.id, 'x'), /claude setup-token/);
  } finally { accounts.stop(); }
});

const OPEN: InstanceType<typeof Service>[] = [];

function service(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pc-cred-route-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return { svc, root, cleanup: () => { for (const s of OPEN.splice(0)) s.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Captured = { status: number; body: Record<string, unknown> };

async function call(svc: unknown, method: string, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method,
    headers: { 'x-phase-console': '1', 'user-agent': 'Mozilla/5.0 (Macintosh)', host: '127.0.0.1:4130' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('CR-2: `PUT /api/accounts/:id/credential` replaces a token account\'s credential and answers the same account', async () => {
  const { svc, cleanup } = service();
  try {
    const added = await call(svc, 'POST', '/api/accounts', { name: 'Work', token: 'sk-ant-oat01-workvalueaaaaaaaaaa' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const id = (added.body.account as { id: string }).id;

    const out = await call(svc, 'PUT', `/api/accounts/${id}/credential`, { token: 'sk-ant-oat01-workvaluebbbbbbbbbb' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((out.body.account as { id: string }).id, id);
    assert.equal((await svc.listAccounts()).filter((view) => view.name === 'Work').length, 1);

    assert.equal((await call(svc, 'PUT', `/api/accounts/${id}/credential`, {})).status, 400, 'no token is a request that will never work');
    assert.equal((await call(svc, 'PUT', '/api/accounts/nobody/credential', { token: 'sk-ant-oat01-workvaluecccccccccc' })).status, 404);
    assert.equal((await call(svc, 'PUT', '/api/accounts/default/credential', { token: 'sk-ant-oat01-workvaluecccccccccc' })).status, 400,
      'the machine login is signed in again, never given a token');
  } finally { cleanup(); }
});

test('CR-3: adding a token under a name that exists is a 409 pointing at the account to replace', async () => {
  const { svc, cleanup } = service();
  try {
    const first = await call(svc, 'POST', '/api/accounts', { name: 'Spare Max', token: 'sk-ant-oat01-sparevalueaaaaaaaaa' });
    const id = (first.body.account as { id: string }).id;
    const again = await call(svc, 'POST', '/api/accounts', { name: 'spare max', token: 'sk-ant-oat01-sparevaluebbbbbbbbb' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.deepEqual(again.body.existing, { id, kind: 'token' });
    assert.match(String(again.body.error), new RegExp(`${id}`));
    assert.match(String(again.body.error), /replace/i, 'and says what to do instead');
    assert.equal((await svc.listAccounts()).filter((view) => view.name?.toLowerCase() === 'spare max').length, 1, 'no second account was minted');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * CR-4..5 — every kind can be signed in again, and is told how
 * ------------------------------------------------------------------ */

type Launch = { file?: string; args?: string[]; env?: Record<string, string | undefined> };

test('CR-4: the sign-in door takes the machine login (its own login, no CLAUDE_CONFIG_DIR), answers a token with replace-token, and warns while a run pays as the machine login', async () => {
  const { svc, cleanup } = service();
  const launches: Launch[] = [];
  // Never a real terminal: the pty is a seam, and the fallback beside it opens Terminal.app.
  (svc as unknown as { terminals: { mint: unknown } }).terminals.mint = async (_a: unknown, _b: unknown, launch: Launch) => {
    launches.push(launch);
    return { ok: true, sessionId: 'pty-1', token: 't', expiresAt: Date.now() + 60_000 };
  };
  const runners = (svc as unknown as { runners: Map<string, unknown> }).runners;
  try {
    const machine = await svc.beginAccountLogin({ accountId: 'default' });
    assert.equal(machine.mode, 'embedded');
    assert.equal(machine.command, 'claude auth login', 'the command a person would type — no config dir');
    assert.deepEqual(launches[0]?.args, ['auth', 'login']);
    assert.equal(launches[0]?.file, 'claude');
    assert.ok(launches[0]?.env && 'CLAUDE_CONFIG_DIR' in launches[0].env && launches[0].env.CLAUDE_CONFIG_DIR === undefined,
      'an inherited CLAUDE_CONFIG_DIR is taken OUT of the pty\'s env — the machine login is the CLI\'s own');

    const token = await svc.addTokenAccount('Night', 'sk-ant-oat01-nightvalueaaaaaaaaa');
    const repaste = await svc.beginAccountLogin({ accountId: token.id });
    assert.equal(repaste.mode, 'replace-token');
    assert.equal(repaste.accountId, token.id);
    assert.match(repaste.command, /claude setup-token/);
    assert.equal(launches.length, 1, 'no terminal for a token — the verb is a paste');

    // A live run paying as the machine login, its identity bound (phase 91):
    // a re-login that changes that identity ends the sessions on it (#131).
    const state = newRun({ slug: 'alpha', root: '/nonexistent' }) as RunState;
    state.identity = { account: 'default', key: 'k1', email: 'me@example.com', at: new Date().toISOString() };
    runners.set('alpha', { current: () => state, busy: () => true, isSpending: () => false, burningOn: () => [] });
    const warned = await svc.beginAccountLogin({ accountId: 'default' });
    assert.equal(warned.mode, 'warn');
    assert.deepEqual(warned.runs, ['alpha']);
    assert.match(warned.warning ?? '', /me@example\.com/, 'it names the identity the run is bound to');
    assert.equal(launches.length, 1, 'nothing ran before the person answered the warning');
    const confirmed = await svc.beginAccountLogin({ accountId: 'default', confirm: RELOGIN_CONFIRM });
    assert.equal(confirmed.mode, 'embedded');
    assert.equal(launches.length, 2);
  } finally {
    runners.delete('alpha');
    cleanup();
  }
});

test('CR-5: the signed-out remediation covers the machine login — its own command, from the one `loginFix`', async () => {
  const accounts = makeAccounts();
  try {
    const machine = accounts.signInFix(undefined);
    assert.match(machine, /`claude auth login`/);
    assert.doesNotMatch(machine, /CLAUDE_CONFIG_DIR/);
    const token = await accounts.addToken('Tok', 'sk-ant-oat01-tokvalueaaaaaaaaaaa');
    assert.match(accounts.signInFix(token.id), /claude setup-token/);
    const profile = accounts.beginProfile('Prof');
    assert.match(accounts.signInFix(profile.id), /CLAUDE_CONFIG_DIR=.* claude auth login/);
  } finally { accounts.stop(); }
  // The run's preflight sentence no longer exempts the machine login.
  const source = readFileSync(new URL('../server/service-base.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('checkAuth: async (accountId)'), source.indexOf('leaveAccount: (accountId, leaving)'));
  assert.ok(block.length > 0, 'the preflight probe was found');
  assert.doesNotMatch(block, /accountId !== DEFAULT_ACCOUNT_ID/, 'the machine login is no longer exempt');
  assert.match(block, /signInFix\(accountId\)/, 'the fix comes from the one sentence');
});

/* ------------------------------------------------------------------ *
 * CR-6..7 — the view says where each login and each meter stands
 * ------------------------------------------------------------------ */

test('CR-6: a token\'s authState follows the poller\'s verdict — a credential it served and then refused reads expired', async () => {
  let refuse = false;
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).authorization ?? '');
    if (auth.includes('neverserved') || refuse) return new Response('{"error":"nope"}', { status: 401 });
    return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString() } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const accounts = makeAccounts(fetchFn);
  try {
    const served = await accounts.addToken('Served', 'sk-ant-oat01-servedvalueaaaaaaaaa');
    const never = await accounts.addToken('Never', 'sk-ant-oat01-neverservedvaluebbbb');
    await sleep(80);
    let view = await viewOf(accounts, served.id);
    assert.equal(view?.authState, 'ok');
    assert.equal(view?.meter, 'ok');
    // The kind itself is not served: that is the meter's word, not a login verdict.
    const unserved = await viewOf(accounts, never.id);
    assert.equal(unserved?.meter, 'unsupported');
    assert.equal(unserved?.authState, 'ok', 'a young token the endpoint never served is judged by its age');

    refuse = true;
    await accounts.refreshUsage(served.id);
    view = await viewOf(accounts, served.id);
    assert.equal(view?.authState, 'expired', 'the endpoint served this credential and now refuses it — the poller\'s verdict, not the token\'s age');
    assert.equal(view?.meter, 'broken');

    // Replacing the credential clears the verdict with it.
    refuse = false;
    await accounts.replaceToken(served.id, 'sk-ant-oat01-servedvaluecccccccccc');
    await sleep(80);
    assert.equal((await viewOf(accounts, served.id))?.authState, 'ok');
  } finally { accounts.stop(); }
});

test('CR-7: every AccountView carries a meter state, the runs paying as it, and the built-in row its email', async () => {
  assert.deepEqual([...METER_STATES], ['ok', 'broken', 'unsupported', 'none']);
  const accounts = makeAccounts();
  try {
    inside(accounts).creds.readIdentity = (dir: string | null) => (dir === null ? { email: 'me@example.com' } : null);
    accounts.setPayingProbe((id) => (id === 'default' ? [{ slug: 'alpha', runId: 'r1' }] : []));
    const views = await accounts.list();
    const machine = views.find((view) => view.builtIn);
    assert.equal(machine?.email, 'me@example.com', 'the machine login says which Claude account it is');
    assert.deepEqual(machine?.paying, [{ slug: 'alpha', runId: 'r1' }], 'and which runs pay as it');
    for (const view of views) {
      assert.ok(METER_STATES.includes(view.meter), `${view.id}: meter "${String(view.meter)}"`);
      assert.ok(Array.isArray(view.paying), `${view.id}: paying is always a list`);
    }
  } finally { accounts.stop(); }

  // The rule, whatever this machine's own login is doing.
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const read = { buckets: { five_hour: { utilization: 40, resetsAt: soon } }, fetchedAt: new Date().toISOString() };
  assert.equal(meterStateOf(undefined, undefined), 'none', 'never read: an empty bar, never an absent one');
  assert.equal(meterStateOf('ok', read as never), 'ok');
  assert.equal(meterStateOf('expired', read as never), 'broken', 'a broken login outranks its last good numbers');
  assert.equal(meterStateOf('signed-out', undefined), 'broken');
  assert.equal(meterStateOf('ok', { buckets: {}, error: 'refused' } as never), 'broken');
  assert.equal(meterStateOf('ok', { buckets: {}, unsupported: true } as never), 'unsupported');
});
