/**
 * A login a run depends on is renewed, or somebody is told (control-tower phase
 * 91, #147 asks 1, 3 and 4; #111 clause 3).
 *
 * The console only READ the CLI's credentials, and the one call it made to
 * "refresh" a lapsed profile — `claude auth status` — renews nothing: measured
 * on 2.1.283 (2026-09-26), it answers `loggedIn: true` from the stored blob
 * twenty-one hours after the access token lapsed and never touches the network.
 * What does renew is a `claude -p` start: the CLI refreshes the OAuth token at
 * startup, before any model call. Named with a model no account serves, the
 * start is refused locally (`claude-code:unrecognized_model`, exit 1, $0, no API
 * time) after the refresh has already been written — by the CLI, under its own
 * lock. A token with 102 minutes left was not renewed by the same call: the CLI
 * refreshes only inside its own window, so keep-alive asks just before the
 * lapse and reads the blob back to see whether it happened.
 *
 * KA-1  the renewal call, its environment, and its three answers
 * KA-2  an idle profile's meters stay readable — keep-alive renews before the poller asks (#111)
 * KA-3  keep-alive runs before the lapse, and only for what is due
 * KA-4  a token account's login state is read, never `unknown`; a long-lived
 *       token is offered as the unattended path on every login-backed account;
 *       a renewal that fails is a warning with the exact fix
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Accounts, type AccountView } from '../server/accounts/index.ts';
import type { ClaudeOauth, Exec } from '../server/accounts/credentials.ts';
import {
  keepAliveArgv, keepAliveEnv, keepAliveDueAt, renewLogin, tokenLoginState,
  KEEP_ALIVE_LEAD_MS, KEEP_ALIVE_MODEL, SETUP_TOKEN_LIFETIME_MS, SETUP_TOKEN_WARN_MS,
} from '../server/accounts/keep-alive.ts';
import { STATE_SANDBOX } from './state-sandbox.ts';

const HOUR = 3_600_000;

/* ------------------------------------------------------------------ *
 * KA-1 — the renewal call
 * ------------------------------------------------------------------ */

test('KA-1: the renewal is a `claude -p` start on a model nothing serves — never `auth status`, never a model call', () => {
  const argv = keepAliveArgv();
  assert.equal(argv[0], '-p');
  assert.ok(!argv.includes('auth') && !argv.includes('status'), 'auth status renews nothing (measured)');
  assert.equal(argv[argv.indexOf('--model') + 1], KEEP_ALIVE_MODEL);
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '1');
  assert.ok(argv.includes('--strict-mcp-config'), 'no MCP server starts for it');
  assert.doesNotMatch(KEEP_ALIVE_MODEL, /^(claude-)?(opus|sonnet|haiku|fable)/, 'not a model any account serves');
});

test('KA-1: the call runs under the profile\'s own config dir, as a probe, with none of the calling session\'s channels', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/x', PE_OUTCOME_FILE: '/tmp/outcome.json', PE_OWNER: 'autopilot/abc',
    PE_SESSION_ID: 'sess', CLAUDE_CODE_SESSION_ID: 'cc', CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  };
  const profile = keepAliveEnv(base, '/state/accounts/acct-a/config');
  assert.equal(profile.CLAUDE_CONFIG_DIR, '/state/accounts/acct-a/config');
  assert.equal(profile.PE_SESSION_KIND, 'probe', 'the presence hook registers nothing for it');
  for (const gone of ['PE_OUTCOME_FILE', 'PE_OWNER', 'PE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(profile[gone], undefined, `${gone} is not inherited`);
  }
  assert.equal(profile.PATH, '/usr/bin');
  const machine = keepAliveEnv(base, null);
  assert.equal(machine.CLAUDE_CONFIG_DIR, undefined, 'the machine login renews under the default config dir');
});

test('KA-1: renewLogin answers from the blob the CLI leaves behind — renewed, not due, or failed', async () => {
  const lapsed = Date.now() - 21 * HOUR;
  let blob: ClaudeOauth | null = { accessToken: 'old', expiresAt: lapsed, canRefresh: true };
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  let refreshes = true;
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
    if (refreshes && blob && blob.expiresAt! <= Date.now() + KEEP_ALIVE_LEAD_MS) {
      blob = { accessToken: 'new', expiresAt: Date.now() + 8 * HOUR, canRefresh: true };
    }
    // The model is refused by design: exit 1 after the refresh.
    throw Object.assign(new Error('Command failed'), { code: 1 });
  };
  const read = async () => blob;
  const renewed = await renewLogin({ exec, configDir: '/p', read });
  assert.equal(renewed.outcome, 'renewed');
  assert.equal(renewed.before, lapsed);
  assert.ok((renewed.after ?? 0) > Date.now() + 7 * HOUR);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'claude');
  assert.deepEqual(calls[0].args, keepAliveArgv());
  assert.equal(calls[0].env?.CLAUDE_CONFIG_DIR, '/p');

  // A token with hours left: the CLI does not renew it, and that is not a failure.
  const fresh = await renewLogin({ exec, configDir: '/p', read });
  assert.equal(fresh.outcome, 'not-due');

  // A lapsed token the CLI could not renew: the refresh was refused.
  blob = { accessToken: 'dead', expiresAt: lapsed, canRefresh: true };
  refreshes = false;
  const failed = await renewLogin({ exec, configDir: '/p', read });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.reason, /could not renew/);

  blob = null;
  assert.equal((await renewLogin({ exec, configDir: '/p', read })).outcome, 'no-login');
});

/* ------------------------------------------------------------------ *
 * The facade over a profile whose CLI we play
 * ------------------------------------------------------------------ */

type Cli = { renewals: number; statuses: number; refuse: boolean };

/**
 * A fake CLI over a profile directory: the keep-alive call rewrites the blob the
 * way the real refresh does (a new access token, eight hours on), unless it is
 * told the refresh token is dead.
 */
function cliOver(cli: Cli): Exec {
  return async (file, args, opts) => {
    if (file === 'claude' && args[0] === '--version') return { stdout: '9.9.9 (Claude Code)\n' };
    if (file === 'claude' && args[0] === 'auth' && args[1] === 'status') {
      cli.statuses += 1;
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'idle@example.com' }) };
    }
    if (file === 'claude' && args[0] === '-p') {
      const dir = opts?.env?.CLAUDE_CONFIG_DIR;
      if (dir && !cli.refuse) {
        const current = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth: { expiresAt: number } };
        if (current.claudeAiOauth.expiresAt <= Date.now() + KEEP_ALIVE_LEAD_MS) {
          cli.renewals += 1;
          writeBlob(dir, `renewed-${cli.renewals}`, Date.now() + 8 * HOUR);
        }
      }
      throw Object.assign(new Error('Command failed: claude -p'), { code: 1 });
    }
    return { stdout: '' };
  };
}

function writeBlob(dir: string, token: string, expiresAt: number): void {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}`, expiresAt, subscriptionType: 'max' },
  }));
}

function signIn(dir: string, token: string, expiresAt: number): void {
  writeBlob(dir, token, expiresAt);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'idle@example.com', organizationUuid: 'org-idle', organizationName: 'Idle org' },
  }));
}

/** A usage endpoint that honours only the tokens it is told are live. */
function endpoint(live: Set<string>) {
  const seen: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = String(headers.authorization ?? headers.Authorization ?? '').replace(/^Bearer /, '');
    seen.push(token);
    if (!live.has(token)) return new Response('{"error":"refused"}', { status: 401 });
    return new Response(JSON.stringify({
      five_hour: { utilization: 12, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
      seven_day: { utilization: 30, resets_at: new Date(Date.now() + 48 * HOUR).toISOString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

/* ------------------------------------------------------------------ *
 * KA-2 — keep-alive renews before the poller asks (#111 clause 3)
 * ------------------------------------------------------------------ */

test('KA-2: an idle profile whose access token lapsed is renewed through the CLI before the poller asks — its meters stay readable', async () => {
  const cli: Cli = { renewals: 0, statuses: 0, refuse: false };
  const live = new Set<string>(['renewed-1']);
  const { fetchFn, seen } = endpoint(live);
  const accounts = new Accounts({
    platform: 'linux', exec: cliOver(cli), fetchFn, usageBase: 'http://usage.invalid',
    learnedFile: join(STATE_SANDBOX, 'learned-p91-ka2.json'),
  });
  try {
    const { id, dir } = accounts.beginProfile('idle');
    signIn(dir, 'lapsed-token', Date.now() - 21 * HOUR);
    const usage = await accounts.refreshUsage(id);
    assert.equal(cli.renewals, 1, 'the CLI renewed the login first');
    assert.deepEqual(seen, ['renewed-1'], 'the endpoint was asked with the renewed token, never the lapsed one');
    assert.equal(usage?.buckets.seven_day?.utilization, 30, 'the meters are read');
    assert.equal(usage?.error, undefined);
    const view = (await accounts.list()).find((a) => a.id === id);
    assert.equal(view?.authState, 'ok');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * KA-3 — before the lapse, and only what is due
 * ------------------------------------------------------------------ */

test('KA-3: keep-alive renews a login inside its lead before the lapse, and leaves one with hours to run alone', async () => {
  const now = Date.now();
  assert.equal(keepAliveDueAt({ accessToken: 't', expiresAt: now + 3 * HOUR, canRefresh: true }), now + 3 * HOUR - KEEP_ALIVE_LEAD_MS);
  assert.equal(keepAliveDueAt({ accessToken: 't', expiresAt: now + HOUR }), null, 'nothing renews a blob with no refresh token');
  assert.equal(keepAliveDueAt(null), null);

  const cli: Cli = { renewals: 0, statuses: 0, refuse: false };
  const accounts = new Accounts({
    platform: 'linux', exec: cliOver(cli), fetchFn: endpoint(new Set()).fetchFn, usageBase: 'http://usage.invalid',
    learnedFile: join(STATE_SANDBOX, 'learned-p91-ka3.json'),
  });
  try {
    const soon = accounts.beginProfile('soon');
    const later = accounts.beginProfile('later');
    signIn(soon.dir, 'soon-token', Date.now() + 2 * 60_000);
    signIn(later.dir, 'later-token', Date.now() + 5 * HOUR);
    const renewals = await accounts.keepAlive();
    assert.equal(renewals[soon.id]?.outcome, 'renewed', 'two minutes from lapsing — inside the lead');
    assert.equal(renewals[later.id], undefined, 'five hours out — not asked at all');
    assert.equal(cli.renewals, 1);
    const blob = JSON.parse(readFileSync(join(soon.dir, '.credentials.json'), 'utf8')) as { claudeAiOauth: { expiresAt: number } };
    assert.ok(blob.claudeAiOauth.expiresAt > Date.now() + 7 * HOUR, 'renewed before it lapsed');
    await accounts.remove(soon.id);
    await accounts.remove(later.id);
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * KA-4 — tokens are read, the unattended path is offered, a failure warns
 * ------------------------------------------------------------------ */

test('KA-4: a token account\'s login state is read from its age — never unknown — and names when it must be replaced', async () => {
  const created = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(tokenLoginState(created, created + 30 * 24 * HOUR), 'ok');
  assert.equal(tokenLoginState(created, created + SETUP_TOKEN_LIFETIME_MS - SETUP_TOKEN_WARN_MS + HOUR), 'expiring');
  assert.equal(tokenLoginState(created, created + SETUP_TOKEN_LIFETIME_MS + HOUR), 'expired');
  assert.equal(tokenLoginState(Number.NaN, created), 'ok', 'an unreadable date is not a lapse');

  const accounts = new Accounts({
    platform: 'linux', exec: cliOver({ renewals: 0, statuses: 0, refuse: false }), fetchFn: endpoint(new Set()).fetchFn,
    usageBase: 'http://usage.invalid', learnedFile: join(STATE_SANDBOX, 'learned-p91-ka4.json'),
    accountsDir: join(STATE_SANDBOX, 'accounts-p91-ka4'),
  });
  try {
    const view = await accounts.addToken('unattended', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(view.kind, 'token');
    assert.equal(view.authState, 'ok', 'a fresh token reads ok, not unknown');
    assert.ok(view.tokenExpiresAt, 'the card can say when it must be replaced');
    assert.ok(Date.parse(view.tokenExpiresAt!) > Date.now() + 300 * 24 * HOUR);
    assert.equal(view.unattended, undefined, 'a token IS the unattended path');
    const machine = (await accounts.list()).find((a) => a.id === 'default')!;
    assert.match(machine.unattended ?? '', /claude setup-token/, 'a login-backed account offers the long-lived token');
    await accounts.remove(view.id);
  } finally { accounts.stop(); }
});

test('KA-4: a renewal that fails is a warning with the exact fix — once per failure, never for a login that renewed', async () => {
  const cli: Cli = { renewals: 0, statuses: 0, refuse: true };
  const warned: { view: AccountView; fix: string; reason: string }[] = [];
  const accounts = new Accounts({
    platform: 'linux', exec: cliOver(cli), fetchFn: endpoint(new Set()).fetchFn, usageBase: 'http://usage.invalid',
    learnedFile: join(STATE_SANDBOX, 'learned-p91-ka4b.json'),
    onLoginAtRisk: (view, risk) => { warned.push({ view, ...risk }); },
  });
  try {
    const { id, dir } = accounts.beginProfile('dying');
    signIn(dir, 'dying-token', Date.now() - HOUR);
    const answer = await accounts.renewLogin(id);
    assert.equal(answer.outcome, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warned.length, 1);
    assert.equal(warned[0].view.id, id);
    assert.match(warned[0].fix, /claude auth login/);
    assert.match(warned[0].fix, new RegExp(`CLAUDE_CONFIG_DIR=\\S*${id}/config`), 'the exact command, for this profile');
    await accounts.renewLogin(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warned.length, 1, 'the same failure is told once');

    cli.refuse = false;
    assert.equal((await accounts.renewLogin(id)).outcome, 'renewed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warned.length, 1, 'a renewal is not a warning');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});
