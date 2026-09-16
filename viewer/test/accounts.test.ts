/**
 * The accounts registry, its secrets, and the facade's redaction boundary.
 *
 * The properties that matter: registered metadata survives a restart with
 * owner-only modes; a secret NEVER appears in anything `list()` hands out;
 * the credential layer talks to a keychain only through the injected exec
 * (tests and CI must never touch a real one) and never to the CLI's own
 * `Claude Code-credentials*` items; and `pickAccount` chooses by headroom
 * while respecting learned-exhausted windows.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// accounts dir is a module-level const off INSTANCE_STATE_DIR.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountStore, ACCOUNTS_DIR, profileConfigDir } from '../server/accounts/store.ts';
import {
  Credentials, claudeKeychainService, consoleKeychainService, KEYCHAIN_STORE_FAILED, type Exec,
} from '../server/accounts/credentials.ts';
import { USAGE_STALE_MS } from '../server/accounts/usage.ts';
import {
  Accounts, ACCOUNT_COOLDOWN_MS, PREFLIGHT_REFUSE_PCT, ProbeInFlightError, probeVerdict,
} from '../server/accounts/index.ts';
import {
  ENTITLEMENT_PROBE_OWNER, probeArgv, probeEnv, runProbeSession, type ProbeSession,
} from '../server/accounts/entitlement-probe.ts';
import { recent } from '../server/log.ts';
import { LearnedAccounts, LEARNED_FILE, credentialFingerprint } from '../server/accounts/learned.ts';
import { ENTITLEMENT_TRANSITIONS, entitlementMayMove } from '../shared/ops-vocab.js';
import { STATE_SANDBOX } from './state-sandbox.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An exec that records every invocation and answers from a script. */
function fakeExec(answers: (file: string, args: string[]) => string | Error = () => '') {
  const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv; input?: string }[] = [];
  const exec: Exec = async (file, args, opts) => {
    // `input` is recorded because that is where a secret now travels — see
    // `keychainStore`. A fake that dropped it could not tell argv from stdin.
    calls.push({
      file, args,
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
    const answer = answers(file, args);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { exec, calls };
}

/* ---------------- store ---------------- */

test('store: add, update, remove round-trip through disk with owner-only modes', () => {
  const store = new AccountStore();
  const id = store.newId('Work Max');
  store.add({ id, kind: 'token', name: 'Work Max', createdAt: '2026-08-06T00:00:00Z' });

  const file = join(ACCOUNTS_DIR, 'accounts.json');
  assert.ok(existsSync(file), 'registry written');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'registry is owner-only');
  assert.equal(statSync(ACCOUNTS_DIR).mode & 0o777, 0o700, 'accounts dir is owner-only');

  const reread = new AccountStore();
  assert.equal(reread.get(id)?.name, 'Work Max');

  store.update(id, { email: 'work@example.com' });
  assert.equal(new AccountStore().get(id)?.email, 'work@example.com');

  assert.ok(store.remove(id));
  assert.equal(new AccountStore().get(id), undefined);
});

test('store: ids are readable, collision-suffixed, and never the built-in one', () => {
  const store = new AccountStore();
  assert.equal(store.newId('Work Max!'), 'work-max');
  store.add({ id: 'work-max', kind: 'token', createdAt: 'x' });
  const second = store.newId('Work MAX');
  assert.notEqual(second, 'work-max');
  assert.match(second, /^work-max-[0-9a-f]{4}$/);
  assert.equal(store.newId('Default'), 'default-2', 'the built-in id is never minted');
  store.remove('work-max');
});

test('learned: a wall keeps future windows and drops the ones already reset — machine-wide, not per row', () => {
  // Walls moved out of the registry row and into the machine-wide learned
  // store in zero-touch-console phase 8 (ACT-10): the credential is the key,
  // so the same login registered in two consoles is ONE wall.
  const accounts = makeAccounts();
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  accounts.markLimited('default', 'five_hour', past);
  accounts.markLimited('default', 'seven_day', future);
  const kept = accounts.limitedUntil('default');
  assert.equal(kept.five_hour, undefined, 'a reset that has passed is not carried around');
  assert.equal(kept.seven_day, future);
  // …and nothing landed in the REGISTRY: no reserved row, no `limitedUntil`.
  const store = new AccountStore();
  assert.equal(store.get('default'), undefined, 'the registry mints no row for a wall any more');
  assert.equal(store.rowsWithLegacyLimits().length, 0);
  // Retire it, as every test here retires what it created — a LIVE wall on
  // `default` disqualifies it from `rankAccounts` for everything downstream.
  accounts.markLimited('default', 'seven_day', past);
  assert.deepEqual(accounts.limitedUntil('default'), {});
  accounts.stop();
});

test('learned: a 4.1.0 registry\'s per-row walls — the reserved default row included — are adopted once and dropped', () => {
  // The old `markLimited` wrote `limitedUntil` on each row and minted a
  // RESERVED `default` row as the machine login's limits carrier. A registry
  // written that way is read, its live windows folded into the learned store,
  // and the field (and the reserved row) removed — so the next console to open
  // the file finds the shape this build writes.
  const file = join(ACCOUNTS_DIR, 'accounts.json');
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  mkdirSync(ACCOUNTS_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    accounts: [
      { id: 'default', kind: 'default', createdAt: 'x', limitedUntil: { five_hour: future, seven_day: past } },
      { id: 'legacy-tok', kind: 'token', name: 'Legacy', createdAt: 'x', limitedUntil: { seven_day_opus: future } },
    ],
  }, null, 2)}\n`);
  assert.equal(new AccountStore().rowsWithLegacyLimits().length, 2, 'both rows still carry the old field on disk');

  const accounts = makeAccounts();
  assert.equal(accounts.limitedUntil('default').five_hour, future, 'the machine login\'s live wall was adopted');
  assert.equal(accounts.limitedUntil('default').seven_day, undefined, 'a lapsed one was not');
  assert.equal(accounts.limitedUntil('legacy-tok').seven_day_opus, future);
  const after = new AccountStore();
  assert.equal(after.get('default'), undefined, 'the reserved row is gone');
  assert.equal(after.get('legacy-tok')?.limitedUntil, undefined, 'and the field with it');
  assert.equal(after.rowsWithLegacyLimits().length, 0);
  // A SECOND construction over the migrated file has nothing to fold — idempotent.
  makeAccounts().stop();
  assert.equal(new AccountStore().rowsWithLegacyLimits().length, 0);

  // Retire what this test created.
  accounts.markLimited('default', 'five_hour', past);
  await0(accounts.remove('legacy-tok'));
  accounts.stop();
});

/** A sync test's fire-and-forget for a facade verb that answers a promise it need not await. */
function await0(p: Promise<unknown>): void { void p.catch(() => undefined); }

test('learned: an account nobody registered is fingerprinted as unregistered — a wall on it lands nowhere a registration reads', () => {
  const accounts = makeAccounts();
  const future = new Date(Date.now() + 60_000).toISOString();
  accounts.markLimited('ghost', 'five_hour', future);
  assert.equal(new AccountStore().get('ghost'), undefined, 'no row is invented');
  // The learned store DOES remember it, under the unregistered key: a journal
  // that names `ghost` can still be read against the wall it hit.
  assert.equal(accounts.limitedUntil('ghost').five_hour, future);
  assert.deepEqual(accounts.limitedUntil('default'), {}, 'and it is not the machine login\'s wall');
  accounts.stop();
});

/* ---------------- credentials ---------------- */

test('credentials: linux token secrets are 0600 files under the account dir', async () => {
  const creds = new Credentials(fakeExec().exec, 'linux');
  await creds.storeToken('tok-a', 'sk-ant-oat01-abcdefghijklmnop');
  const file = join(ACCOUNTS_DIR, 'tok-a', 'token');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await creds.readToken('tok-a'), 'sk-ant-oat01-abcdefghijklmnop');
  await creds.deleteToken('tok-a');
  assert.equal(await creds.readToken('tok-a'), null);
});

test('credentials: macOS token secrets go through `security` under OUR service name', async () => {
  const { exec, calls } = fakeExec((file, args) => {
    if (file === 'security' && args[0] === 'find-generic-password') return 'the-token\n';
    return '';
  });
  const creds = new Credentials(exec, 'darwin');
  await creds.storeToken('tok-b', 'the-token');
  await creds.readToken('tok-b');
  await creds.deleteToken('tok-b');
  assert.ok(calls.every((c) => c.file === 'security'), 'nothing but `security` is spawned');
  for (const call of calls) {
    const service = call.args[call.args.indexOf('-s') + 1];
    assert.equal(service, consoleKeychainService('tok-b'));
    assert.ok(!service.startsWith('Claude Code'), "never the CLI's own items");
  }
});

test('credentials: the CLI keychain service derives from the config dir hash', () => {
  assert.equal(claudeKeychainService(null), 'Claude Code-credentials');
  const derived = claudeKeychainService('/tmp/some/profile');
  assert.match(derived, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(derived, claudeKeychainService('/tmp/some/profile'), 'stable');
  assert.notEqual(derived, claudeKeychainService('/tmp/other/profile'));
});

test('credentials: envFor shapes — profile gets a config dir, token gets a token, default inherits', async () => {
  const creds = new Credentials(fakeExec().exec, 'linux');
  await creds.storeToken('tok-c', 'sekret');
  assert.equal(await creds.envFor(null), null);
  assert.equal(await creds.envFor({ id: 'default', kind: 'default', createdAt: '' } as never), null);
  assert.deepEqual(
    await creds.envFor({ id: 'prof-a', kind: 'profile', createdAt: '' }),
    { CLAUDE_CONFIG_DIR: profileConfigDir('prof-a') },
  );
  const tokenEnv = await creds.envFor({ id: 'tok-c', kind: 'token', createdAt: '' });
  assert.deepEqual(tokenEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'sekret' });
  assert.equal(
    (tokenEnv as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR,
    undefined,
    'a token account keeps the default config dir so transcripts stay portable',
  );
  await creds.deleteToken('tok-c');
});

/* ---------------- the facade ---------------- */

function makeAccounts(overrides: {
  fetchFn?: typeof fetch;
  exec?: Exec;
  onChange?: () => void;
  registryDir?: string;
  learnedFile?: string;
  instanceId?: string;
  now?: () => number;
} = {}): Accounts {
  return new Accounts({
    platform: 'linux',
    exec: overrides.exec ?? fakeExec().exec,
    ...(overrides.fetchFn ? { fetchFn: overrides.fetchFn, usageBase: 'http://usage.invalid' } : {}),
    ...(overrides.onChange ? { onChange: overrides.onChange } : {}),
    ...(overrides.registryDir ? { registryDir: overrides.registryDir } : {}),
    ...(overrides.learnedFile ? { learnedFile: overrides.learnedFile } : {}),
    ...(overrides.instanceId ? { instanceId: overrides.instanceId } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

/** Plant a poller snapshot as if a read had happened at `fetchedAt` — the harness's hand on the cache. */
function plantMeters(
  accounts: Accounts, id: string,
  snapshot: { buckets: Record<string, { utilization: number; resetsAt: string }>; fetchedAt?: string; error?: string; lastErrorAt?: string },
): void {
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set(id, snapshot);
}

test('facade: a token never leaves through list(), and remove() forgets everything', async () => {
  const accounts = makeAccounts();
  const view = await accounts.addToken('Spare Max', 'sk-ant-oat01-supersecretvalue00');
  assert.equal(view.kind, 'token');
  assert.equal(view.name, 'Spare Max');

  const everything = JSON.stringify(await accounts.list());
  assert.ok(!everything.includes('supersecretvalue'), 'no secret in any view');
  assert.ok(!everything.includes(ACCOUNTS_DIR), 'no state paths in any view');

  assert.ok(await accounts.remove(view.id));
  const after = await accounts.list();
  assert.equal(after.some((a) => a.id === view.id), false);
  accounts.stop();
});

test('facade: the default account is always first, built in, and irremovable', async () => {
  const accounts = makeAccounts();
  const list = await accounts.list();
  assert.equal(list[0]?.id, 'default');
  assert.equal(list[0]?.builtIn, true);
  await assert.rejects(() => accounts.remove('default'));
  accounts.stop();
});

test('facade: envFor answers null for the default and unknown ids', async () => {
  const accounts = makeAccounts();
  assert.equal(await accounts.envFor(undefined), null);
  assert.equal(await accounts.envFor('default'), null);
  assert.equal(await accounts.envFor('never-registered'), null);
  accounts.stop();
});

test('facade: pickAccount prefers measured headroom and skips learned-exhausted windows', async () => {
  const usage: Record<string, number> = { fresh: 15, busy: 85 };
  const tokens = new Map<string, string>();
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).authorization ?? '');
    const id = tokens.get(auth.replace('Bearer ', '')) ?? 'unknown';
    return new Response(JSON.stringify({
      five_hour: { utilization: usage[id] ?? 50, resets_at: '2026-08-06T20:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2026-08-12T00:00:00Z' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const accounts = makeAccounts({ fetchFn });
  const fresh = await accounts.addToken('fresh', 'token-fresh-aaaaaaaaaaaa');
  const busy = await accounts.addToken('busy', 'token-busy-bbbbbbbbbbbbb');
  tokens.set('token-fresh-aaaaaaaaaaaa', 'fresh');
  tokens.set('token-busy-bbbbbbbbbbbbb', 'busy');
  await sleep(80);   // both kicks land

  // The default account has no meters here (no login on the sandbox box) —
  // unknown scores 50, so measured-15 wins, measured-85 loses to unknown.
  assert.equal(accounts.pickAccount('default'), fresh.id);

  accounts.markLimited(fresh.id, 'five_hour', new Date(Date.now() + 3_600_000).toISOString());
  assert.notEqual(accounts.pickAccount('default'), fresh.id, 'a learned-exhausted window disqualifies');

  const noOne = accounts.pickAccount(busy.id);
  assert.notEqual(noOne, busy.id, 'never answers the account being escaped from');
  accounts.stop();
  await accounts.remove(fresh.id);
  await accounts.remove(busy.id);
});

test('facade: the default account\'s learned windows SURVIVE a restart, and prune themselves', () => {
  const accounts = makeAccounts();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  accounts.markLimited(undefined, 'five_hour', future);
  accounts.markLimited('default', 'seven_day', new Date(Date.now() - 1_000).toISOString());
  const live = accounts.limitedUntil('default');
  assert.equal(live.five_hour, future);
  assert.equal(live.seven_day, undefined, 'a window that already reset is not carried around');
  accounts.stop();

  // The property this test exists for. These windows used to live in a bare
  // instance field on the facade, so the machine login — the account most
  // consoles actually run on — forgot every wall it had learned the hard way
  // on every restart, while every REGISTERED account remembered. A fresh
  // facade over the same registry is what a restart is.
  const restarted = makeAccounts();
  assert.equal(
    restarted.limitedUntil('default').five_hour, future,
    'the machine login remembers its wall across a restart',
  );
  // …and it is not a registration: `list()` shows one default, polled once.
  assert.deepEqual(
    restarted.limitedUntil(undefined), restarted.limitedUntil('default'),
    'the unnamed machine login and `default` are one account',
  );

  // Retire it, as every test here retires what it created — a live wall on
  // `default` disqualifies it from `rankAccounts` for everything downstream.
  restarted.markLimited('default', 'five_hour', new Date(Date.now() - 1_000).toISOString());
  assert.deepEqual(restarted.limitedUntil('default'), {});
  restarted.stop();
});

test('facade: registry file never contains a secret even after many operations', async () => {
  const accounts = makeAccounts();
  const v = await accounts.addToken('Scrub Me', 'sk-ant-oat01-scrubbablevalue11');
  accounts.markLimited(v.id, 'five_hour', new Date(Date.now() + 1000 * 60).toISOString());
  const raw = readFileSync(join(ACCOUNTS_DIR, 'accounts.json'), 'utf8');
  assert.ok(!raw.includes('scrubbablevalue'), 'accounts.json holds metadata only');
  await accounts.remove(v.id);
  accounts.stop();
});

/* ---------------- rename, the default's name, and auth state ---------------- */

test('store: defaultName round-trips through disk and clears on empty', () => {
  const store = new AccountStore();
  store.setDefaultName('living room mac');
  assert.equal(new AccountStore().defaultName, 'living room mac');
  store.setDefaultName(undefined);
  assert.equal(new AccountStore().defaultName, undefined);
});

test('facade: rename changes the display name only — stored accounts and the machine login alike', async () => {
  const accounts = makeAccounts();
  const v = await accounts.addToken('Old Name', 'sk-ant-oat01-renamablevalue00');
  const renamed = await accounts.rename(v.id, 'New Name');
  assert.equal(renamed?.name, 'New Name');
  assert.equal(renamed?.id, v.id, 'the id never changes — it is a journal key and a path segment');
  assert.equal(accounts.labelFor(v.id), 'New Name');

  await accounts.rename('default', 'the big mac');
  assert.equal(accounts.labelFor(undefined), 'the big mac');
  assert.equal((await accounts.list())[0]?.name, 'the big mac');
  await accounts.rename('default', '');
  assert.equal(accounts.labelFor(undefined), 'the machine login', 'clearing restores the stock label');

  assert.equal(await accounts.rename('nobody-here', 'x'), undefined);
  await accounts.remove(v.id);
  accounts.stop();
});

test('facade: an expired profile announces once, after the refresh was tried — never on first sight', async () => {
  const transitions: string[] = [];
  const { exec, calls } = fakeExec(() => '');
  const accounts = new Accounts({
    platform: 'linux',
    exec,
    onAuthChange: (view, state) => transitions.push(`${view.id}:${state}`),
  });
  const { id, dir } = accounts.beginProfile('stale');
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60 * 60_000, subscriptionType: 'max' },
  }));
  const view = (await accounts.list()).find((a) => a.id === id);
  assert.equal(view?.authState, 'ok');
  await sleep(20);
  assert.deepEqual(transitions, [], 'a first observation never announces');

  // The login expires. The poller path is the authoritative writer, and it
  // sits AFTER the CLI-refresh attempt — only a login the CLI could not
  // rescue may read as expired.
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 60_000, subscriptionType: 'max' },
  }));
  const facade = accounts as unknown as { resolveToken(id: string): Promise<unknown> };
  await facade.resolveToken(id);
  assert.ok(
    calls.some((c) => c.file === 'claude' && c.args[0] === 'auth' && c.args[1] === 'status'),
    'the CLI refresh was attempted before believing the expiry',
  );
  await sleep(20);
  assert.deepEqual(transitions, [`${id}:expired`], 'announced exactly once, on the transition');

  await facade.resolveToken(id);
  await sleep(20);
  assert.deepEqual(transitions, [`${id}:expired`], 'and not again while it stays expired');
  await accounts.remove(id);
  accounts.stop();
});

test('facade: removing a profile deletes its HASHED keychain item, never the plain one', async () => {
  const { exec, calls } = fakeExec(() => '');
  const accounts = new Accounts({ platform: 'darwin', exec });
  const { id } = accounts.beginProfile('goner');
  const hashed = claudeKeychainService(profileConfigDir(id));
  await accounts.remove(id);
  const deletes = calls.filter((c) => c.file === 'security' && c.args[0] === 'delete-generic-password');
  assert.deepEqual(deletes.map((c) => c.args[c.args.indexOf('-s') + 1]), [hashed]);
  assert.ok(
    deletes.every((c) => c.args[c.args.indexOf('-s') + 1] !== claudeKeychainService(null)),
    "the CLI's shared item — the machine login — is never touched",
  );
  accounts.stop();
});

test('facade: a per-model wall disqualifies only that model, and never blanket-skips', async () => {
  const accounts = makeAccounts();
  const spare = await accounts.addToken('spare', 'sk-ant-oat01-sparevalue000000');
  accounts.markLimited(spare.id, 'seven_day_opus', new Date(Date.now() + 3_600_000).toISOString());

  assert.equal(accounts.pickAccount('default', 'opus'), null, 'exhausted on opus, for an opus run');
  assert.equal(accounts.pickAccount('default', 'claude-opus-5'), null, 'full model ids read the same');
  assert.equal(accounts.pickAccount('default', 'sonnet'), spare.id, 'still the right place for a sonnet run');
  assert.equal(
    accounts.pickAccount('default'), spare.id,
    'and a per-model key must never trip the shared-window skip',
  );
  await accounts.remove(spare.id);
  accounts.stop();
});

test('facade: rankAccounts is the predicate pickAccount takes its head from, and a login known broken is never ranked', async () => {
  const accounts = makeAccounts();
  const a = await accounts.addToken('alpha', 'sk-ant-oat01-alphavalue000000');
  const b = await accounts.addToken('beta', 'sk-ant-oat01-betavalue0000000');
  // Unknown usage everywhere scores alike: registration order, the machine
  // login first whenever it is not the one being escaped.
  assert.deepEqual(accounts.rankAccounts('default'), [a.id, b.id]);
  assert.equal(accounts.pickAccount('default'), a.id, 'pickAccount is the head of the ranking');
  assert.deepEqual(accounts.rankAccounts(a.id), ['default', b.id]);

  // A profile nobody has signed in: once read, it is KNOWN signed-out — and a
  // login known broken is no place to continue, whatever its headroom.
  const { id: stale } = accounts.beginProfile('stale');
  await accounts.list();
  assert.equal(accounts.authStateFor(stale), 'signed-out');
  assert.ok(!accounts.rankAccounts('default').includes(stale), 'a signed-out login is never ranked');
  assert.ok(!accounts.rankAccounts(a.id).includes(stale));

  accounts.markLimited(a.id, 'five_hour', new Date(Date.now() + 3_600_000).toISOString());
  assert.deepEqual(accounts.rankAccounts('default'), [b.id], 'learned-exhausted windows still disqualify');
  assert.equal(accounts.pickAccount('default'), b.id);

  await accounts.remove(a.id);
  await accounts.remove(b.id);
  await accounts.remove(stale);
  accounts.stop();
});

/* ---------------- Phase 5: secrets, and telemetry that is not a detector --- */

test('credentials: a token reaches `security` through stdin, and a failure says one fixed sentence', async () => {
  // The same finding as the MCP half, and the reason it is one shared helper:
  // `security add-generic-password -w <value>` puts the token in argv, where
  // every process of the same user can read it out of `ps`. `-w` with no value
  // prompts, and `security` reads the prompts from stdin — twice, comparing.
  const { exec, calls } = fakeExec();
  const creds = new Credentials(exec, 'darwin');
  await creds.storeToken('spare', 'sk-ant-oat01-supersecret');

  const add = calls.find((c) => c.args[0] === 'add-generic-password')!;
  assert.ok(!add.args.some((a) => a.includes('supersecret')), 'not in argv');
  assert.equal(add.args[add.args.length - 1], '-w', '`-w` carries no value — that is what makes it prompt');
  assert.equal(add.input, 'sk-ant-oat01-supersecret\nsk-ant-oat01-supersecret\n', 'fed twice');

  // And the error path, which is where the token used to reach the BROWSER:
  // execFile rejects with `Command failed: <the whole argv>` plus the child's
  // stderr, and that message was returned as an HTTP error body.
  const angry = new Credentials(
    (async () => { throw new Error('Command failed: security add-generic-password -w sk-ant-oat01-supersecret'); }) as Exec,
    'darwin',
  );
  await assert.rejects(
    () => angry.storeToken('spare', 'sk-ant-oat01-supersecret'),
    (error: Error) => {
      assert.equal(error.message, KEYCHAIN_STORE_FAILED, 'one fixed sentence, nothing from the child');
      assert.ok(!error.message.includes('supersecret'));
      return true;
    },
  );
});

test('store: a stored `default` row may carry legacy limits, and may never carry a registration', () => {
  // A stored default row is a 4.1.0 artefact — the old `markLimited` minted
  // one so the machine login remembered its walls across a restart — and it
  // is still read, so the facade can fold those walls into the learned store.
  // What must not survive the read is one claiming to be a REGISTRATION:
  // `add()` refuses to create such a row, but nothing stood between a
  // hand-edited (or downgraded, or corrupted) accounts.json and
  // `{id: 'default', kind: 'token'}` — which `envFor` would honour by looking
  // up a keychain token for it, and run work as an identity nobody registered,
  // under the name that means "the machine's own login".
  const file = join(ACCOUNTS_DIR, 'accounts.json');
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  mkdirSync(ACCOUNTS_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    accounts: [{
      id: 'default', kind: 'token', name: 'smuggled', email: 'nobody@example.com',
      createdAt: 'x', limitedUntil: { five_hour: future },
    }],
  }, null, 2)}\n`);

  const row = new AccountStore().get('default')!;
  assert.equal(row.kind, 'default', 'the kind is pinned on the way in');
  assert.equal(row.name, undefined, 'and it keeps only what a limits carrier is for');
  assert.equal(row.email, undefined);
  assert.equal(row.limitedUntil?.five_hour, future, 'the windows — the reason the row existed — survive the read for the migration');

  // The facade adopts and drops it; retire the adopted wall so `default`
  // stays a candidate downstream.
  const accounts = makeAccounts();
  assert.equal(new AccountStore().get('default'), undefined, 'adopted and gone');
  accounts.markLimited('default', 'five_hour', new Date(Date.now() - 1_000).toISOString());
  accounts.stop();
});

test('store: an accounts registry from a NEWER console is read, not erased', () => {
  const file = join(ACCOUNTS_DIR, 'accounts.json');
  writeFileSync(file, `${JSON.stringify({
    version: 3,
    accounts: [{ id: 'future', kind: 'token', name: 'Later', createdAt: 'x' }],
  }, null, 2)}\n`);

  const store = new AccountStore();
  assert.deepEqual(store.stored().map((a) => a.id), ['future'], 'read forward, never erase');
  store.add({ id: 'now', kind: 'token', name: 'Now', createdAt: 'x' });
  assert.deepEqual(new AccountStore().stored().map((a) => a.id).sort(), ['future', 'now']);
  assert.ok(existsSync(`${file}.v3.bak`), 'copied aside before the downgrade rewrote it');

  const cleanup = new AccountStore();
  cleanup.remove('future');
  cleanup.remove('now');
});

test('facade: ranking ignores a meter that is stale or whose window already reset', async () => {
  // CLAUDE.md's rule, which this broke: the poller is telemetry, never the
  // detector. `limitedUntil` is the detector's answer and has always been
  // expiry-filtered; the poller's snapshot was not — so a bucket read at 100%
  // before a window that has since reset disqualified an account exactly as
  // hard as a real wall, and it stayed out of the rotation until the next
  // successful poll, which is the one thing a console with a failing poller
  // cannot make.
  const accounts = makeAccounts();
  const spare = await accounts.addToken('Spare', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa');
  const now = Date.now();

  const poller = (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller;
  poller.cache.set(spare.id, {
    buckets: { five_hour: { utilization: 100, resetsAt: new Date(now - 60_000).toISOString() } },
    fetchedAt: new Date(now - 90_000).toISOString(),
  });

  assert.ok(
    accounts.rankAccounts('default', undefined, now).includes(spare.id),
    'a window that has already reset is not a wall',
  );

  // A live 100% still disqualifies — this must not have become permissive.
  poller.cache.set(spare.id, {
    buckets: { five_hour: { utilization: 100, resetsAt: new Date(now + 60 * 60_000).toISOString() } },
    fetchedAt: new Date(now).toISOString(),
  });
  assert.ok(!accounts.rankAccounts('default', undefined, now).includes(spare.id), 'a live wall still holds');

  // …and the same live reading, gone stale, stops being evidence.
  poller.cache.set(spare.id, {
    buckets: { five_hour: { utilization: 100, resetsAt: new Date(now + 60 * 60_000).toISOString() } },
    fetchedAt: new Date(now - USAGE_STALE_MS - 1).toISOString(),
  });
  assert.ok(
    accounts.rankAccounts('default', undefined, now).includes(spare.id),
    'no successful poll is behind a snapshot that old',
  );

  await accounts.remove(spare.id);
  accounts.stop();
});

/* ------------------------------------------------------------------ *
 * Phase 8 (zero-touch-console): the breaker, the ranking rules, one
 * machine-wide learned store, tombstones, and the quota door's verdict
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60_000;

test('SES-2: a credential-class refusal RETIRES the account — rankAccounts omits it and the quota door refuses it by name, until an operator clears it', async () => {
  const accounts = makeAccounts();
  const a = await accounts.addToken('alpha', 'sk-ant-oat01-alphavalue000000');
  const b = await accounts.addToken('beta', 'sk-ant-oat01-betavalue0000000');
  assert.deepEqual(accounts.rankAccounts('default'), [a.id, b.id]);

  // The classifier's disposition, as `runner-attempt.ts`'s credential arm
  // hands it to the one helper.
  const left = accounts.leaveAccount(a.id, {
    kind: 'credential', class: 'org-policy', by: 'classifier',
    reason: 'organization policy blocks this credential',
  });
  assert.equal(left.state, 'retired');
  assert.ok(left.throttleUntilMs && left.throttleUntilMs > Date.now(), 'the scheduler is told to hold it too');
  assert.deepEqual(accounts.rankAccounts('default'), [b.id], 'a retired credential is never a candidate');
  assert.deepEqual(accounts.rankAccounts(null), ['default', b.id], 'from every direction');

  const verdict = accounts.headroom(a.id);
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.kind, 'retired');
  assert.match(!verdict.ok ? verdict.reason : '', /alpha is retired/, 'refused BY NAME');
  assert.match(!verdict.ok ? verdict.reason : '', /organization policy/);

  // The view says so, in both vocabularies.
  const view = (await accounts.list()).find((v) => v.id === a.id)!;
  assert.equal(view.entitlement.state, 'retired');
  assert.equal(view.entitlement.class, 'org-policy');
  assert.equal(view.authState, 'unusable', 'a retired credential paints `unusable` whatever its login says');

  // Nothing automatic reopens it: a successful read is refused by the table.
  plantMeters(accounts, a.id, { buckets: { five_hour: { utilization: 10, resetsAt: new Date(Date.now() + HOUR).toISOString() } }, fetchedAt: new Date().toISOString() });
  (accounts as unknown as { usageUpdated: (id: string, u: unknown, m: unknown) => void })
    .usageUpdated(a.id, { buckets: {}, fetchedAt: new Date().toISOString() }, { outcome: 'ok' });
  assert.equal(accounts.entitlementOf(a.id).state, 'retired', 'retired → entitled is not a transition');
  assert.deepEqual(accounts.rankAccounts('default'), [b.id]);

  // The operator's clearance is the one door out — to `unknown`, not `entitled`.
  assert.equal(accounts.clearRetired(a.id), true);
  assert.equal(accounts.clearRetired(a.id), false, 'idempotent: not retired any more');
  assert.equal(accounts.entitlementOf(a.id).state, 'unknown');
  assert.ok(accounts.rankAccounts('default').includes(a.id), 'a cleared account is a candidate again');
  assert.equal(accounts.headroom(a.id).ok, true);

  await accounts.remove(a.id);
  await accounts.remove(b.id);
  accounts.stop();
});

test('ACT-8: an entitlement refusal against one account excludes EVERY account sharing its orgId, until cleared', async () => {
  const accounts = makeAccounts();
  const a = await accounts.addToken('org-a', 'sk-ant-oat01-orgavalue000000000');
  const b = await accounts.addToken('org-b', 'sk-ant-oat01-orgbvalue000000000');
  const c = await accounts.addToken('other', 'sk-ant-oat01-othervalue00000000');
  // Two logins in one organisation (REC-14's shape), one in another. A token
  // account has no `.claude.json`; the organisation reaches the learned store
  // from the usage body or the auth probe — here the probe.
  accounts.noteAuthProbe(a.id, { loggedIn: true, orgId: 'org-shared', checkedAt: '' });
  accounts.noteAuthProbe(b.id, { loggedIn: true, orgId: 'org-shared', checkedAt: '' });
  accounts.noteAuthProbe(c.id, { loggedIn: true, orgId: 'org-else', checkedAt: '' });
  assert.deepEqual(accounts.rankAccounts('default'), [a.id, b.id, c.id]);

  accounts.retire(a.id, 'org-shared', 'organization policy blocks this credential', 'classifier', 'org-policy');
  assert.deepEqual(accounts.rankAccounts('default'), [c.id], 'the sibling in the same organisation is out too');
  assert.equal(accounts.entitlementOf(b.id).state, 'retired');
  assert.equal(accounts.entitlementOf(b.id).via, 'org', 'answered by the organisation\'s row, not its own');
  assert.equal(accounts.entitlementOf(c.id).state, 'unknown', 'another organisation is untouched');
  assert.match((() => { const v = accounts.headroom(b.id); return v.ok ? '' : v.reason; })(), /retired with its organisation/);

  // The views agree on WHICH organisation, without saying which.
  const views = await accounts.list();
  const orgOf = (id: string) => views.find((v) => v.id === id)!.orgId;
  assert.equal(orgOf(a.id), orgOf(b.id), 'two accounts in one organisation show one hash');
  assert.notEqual(orgOf(a.id), orgOf(c.id));
  assert.match(orgOf(a.id)!, /^[0-9a-f]{8}$/, 'hashed, never the id');
  assert.equal(JSON.stringify(views).includes('org-shared'), false, 'the raw orgId leaves the server nowhere');

  // Clearing EITHER account clears the organisation.
  assert.equal(accounts.clearRetired(b.id), true);
  assert.equal(accounts.entitlementOf(a.id).state, 'unknown');
  assert.equal(accounts.entitlementOf(b.id).state, 'unknown');
  assert.deepEqual(accounts.rankAccounts('default'), [a.id, b.id, c.id]);

  // A re-login into ANOTHER organisation also opens a retired credential — a
  // different question, the old answer does not carry.
  accounts.retire(a.id, 'org-shared', 'organization policy blocks this credential', 'classifier', 'org-policy');
  assert.equal(accounts.entitlementOf(a.id).state, 'retired');
  accounts.clearRetired(a.id);
  accounts.retire(a.id, undefined, 'billing or credit balance needs attention', 'classifier', 'billing');
  assert.equal(accounts.entitlementOf(a.id).state, 'retired');
  accounts.noteAuthProbe(a.id, { loggedIn: true, orgId: 'org-new', checkedAt: '' });
  assert.equal(accounts.entitlementOf(a.id).state, 'unknown', 'a new orgId is the second door out of retired');

  for (const id of [a.id, b.id, c.id]) await accounts.remove(id);
  accounts.stop();
});

test('the breaker\'s table: every write outside it is refused and the state stands', () => {
  // The four states and the transitions between them, asserted against the
  // owner (`shared/ops-vocab.js`) rather than restated.
  assert.deepEqual(Object.keys(ENTITLEMENT_TRANSITIONS).sort(), ['cooling', 'entitled', 'retired', 'unknown']);
  assert.equal(entitlementMayMove('unknown', 'entitled'), true);
  assert.equal(entitlementMayMove('unknown', 'cooling'), false, 'a credential nobody proved can pay cannot cool');
  assert.equal(entitlementMayMove('retired', 'entitled'), false, 'nothing reopens a retirement but a person or a new org');
  assert.equal(entitlementMayMove('retired', 'unknown'), true);
  assert.equal(entitlementMayMove('cooling', 'cooling'), true, 'the same word twice is a no-op, not a transition');

  const file = join(STATE_SANDBOX, 'learned-table.json');
  const learned = new LearnedAccounts({ file });
  const fp = credentialFingerprint('test:table');
  assert.equal(learned.setEntitlement(fp, { state: 'cooling', until: new Date(Date.now() + HOUR).toISOString() }), null, 'refused');
  assert.equal(learned.entitlementOf(fp).state, 'unknown', 'and nothing was written');
  assert.equal(learned.setEntitlement(fp, { state: 'entitled', by: 'poller' })?.state, 'entitled');
  assert.equal(learned.setEntitlement(fp, { state: 'cooling', until: new Date(Date.now() + HOUR).toISOString() })?.state, 'cooling');
  // A cooling past its clock READS entitled without a write.
  const past = new LearnedAccounts({ file, now: () => Date.now() + 2 * HOUR });
  assert.equal(past.entitlementOf(fp).state, 'entitled');
  assert.equal(learned.snapshot().credentials[fp].entitlement.state, 'cooling', 'the stored word is untouched — the read derives');
  assert.equal(learned.setEntitlement(fp, { state: 'retired', by: 'classifier' })?.state, 'retired');
  assert.equal(learned.setEntitlement(fp, { state: 'entitled' }), null);
  // The file is owner-only, atomic, and the lock is released.
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('ACT-5: leaving on a usage wall marks the account BEFORE any switch — with the reset when known, a cool-down when not; a per-model window walls only its bucket; an operator\'s switch holds nothing', async () => {
  let now = Date.now();
  const accounts = makeAccounts({ now: () => now });
  const a = await accounts.addToken('wall-a', 'sk-ant-oat01-wallavalue00000000');
  const b = await accounts.addToken('wall-b', 'sk-ant-oat01-wallbvalue00000000');
  assert.deepEqual(accounts.rankAccounts('default', undefined, now), [a.id, b.id]);

  // A wall with the CLI's reset: the window's own name, until the reset.
  const resets = new Date(now + 3 * HOUR);
  const left = accounts.leaveAccount(a.id, { kind: 'usage', bucket: 'five_hour', resetsAt: resets, reason: 'rate limited mid-session', by: 'live-wall' });
  assert.deepEqual(left.wall, { bucket: 'five_hour', resetsAt: resets.toISOString() });
  assert.equal(left.until, resets.toISOString());
  assert.equal(left.throttleUntilMs, resets.getTime());
  assert.equal(left.state, 'cooling');
  assert.deepEqual(accounts.rankAccounts('default', undefined, now), [b.id], 'the account it left is not the next answer');
  assert.equal(accounts.pickAccount(b.id, undefined, now), 'default', 'a burst on B does not return the run to A');

  // A wall with NO reset: the cool-down, and no wall row (there is no window to name a clock for).
  const left2 = accounts.leaveAccount(b.id, { kind: 'usage', bucket: 'learned_window', resetsAt: null, reason: '429 burst', by: 'live-wall' });
  assert.equal(left2.wall, undefined);
  assert.equal(left2.until, new Date(now + ACCOUNT_COOLDOWN_MS).toISOString());
  assert.equal(left2.throttleUntilMs, now + ACCOUNT_COOLDOWN_MS);
  assert.deepEqual(accounts.rankAccounts(null, undefined, now), ['default'], 'both are cooling');
  now += ACCOUNT_COOLDOWN_MS + 1;
  // B is back when its cool-down passes; A waits for its reset. B ranks AHEAD
  // of the never-polled machine login: both score 50, and a wall is proof B
  // could pay (`entitled`), which an account nobody has read is not.
  assert.deepEqual(accounts.rankAccounts(null, undefined, now), [b.id, 'default']);
  now += 3 * HOUR;
  assert.deepEqual(accounts.rankAccounts(null, undefined, now), [a.id, b.id, 'default']);
  assert.equal(accounts.entitlementOf(a.id, now).state, 'entitled', 'a wall is proof the account could pay');

  // A per-MODEL window: the bucket is walled, the account is not cooling.
  const left3 = accounts.leaveAccount(a.id, { kind: 'usage', bucket: 'seven_day_opus', resetsAt: new Date(now + HOUR), reason: 'opus window', by: 'classifier', perModel: true });
  assert.equal(left3.throttleUntilMs, null, 'nothing for the scheduler — every other model is fine');
  assert.equal(left3.state, 'entitled');
  assert.ok(accounts.rankAccounts('default', 'claude-sonnet-5', now).includes(a.id));
  assert.ok(!accounts.rankAccounts('default', 'claude-opus-5', now).includes(a.id));

  // An operator's switch: recorded, held against nobody.
  const left4 = accounts.leaveAccount(a.id, { kind: 'operator', reason: 'account switch by operator', by: 'operator' });
  assert.equal(left4.throttleUntilMs, null);
  assert.equal(left4.wall, undefined);
  assert.ok(accounts.rankAccounts('default', 'claude-sonnet-5', now).includes(a.id));
  assert.equal(accounts.learned.credential(accounts.fingerprintOf(a.id))?.lastLeftAt?.kind, 'operator');

  await accounts.remove(a.id);
  await accounts.remove(b.id);
  accounts.stop();
});

test('SES-4: with A measured at 80 % and B stale-or-errored, rankAccounts is [A, B]; a never-polled profile still ranks between the measured; `unknown` ranks below `entitled`', async () => {
  const now = Date.now();
  const accounts = makeAccounts({ now: () => now });
  const a = await accounts.addToken('meas-a', 'sk-ant-oat01-measavalue00000000');
  const b = await accounts.addToken('meas-b', 'sk-ant-oat01-measbvalue00000000');
  const n = await accounts.addToken('never', 'sk-ant-oat01-nevervalue00000000');
  const c = await accounts.addToken('meas-c', 'sk-ant-oat01-meascvalue00000000');
  const resets = new Date(now + HOUR).toISOString();
  plantMeters(accounts, a.id, { buckets: { five_hour: { utilization: 80, resetsAt: resets } }, fetchedAt: new Date(now).toISOString() });
  plantMeters(accounts, c.id, { buckets: { five_hour: { utilization: 20, resetsAt: resets } }, fetchedAt: new Date(now).toISOString() });
  // B's poller is FAILING: a stale snapshot (no successful read inside the bound).
  plantMeters(accounts, b.id, { buckets: { five_hour: { utilization: 5, resetsAt: resets } }, fetchedAt: new Date(now - USAGE_STALE_MS - 1).toISOString(), error: 'credential was refused' });
  // `never` has no snapshot at all. `default` on the sandbox box has none either.
  assert.deepEqual(
    accounts.rankAccounts('default', undefined, now),
    [c.id, n.id, a.id, b.id],
    'live meters by score with never-polled at 50 between them; the failing poller below every live meter',
  );
  assert.deepEqual(accounts.rankAccounts(n.id, undefined, now).slice(-1), [b.id], 'from any direction, B is last');

  // B errored on its LAST read but has a fresh successful snapshot behind it:
  // still "failing" — the error is the symptom.
  plantMeters(accounts, b.id, { buckets: { five_hour: { utilization: 5, resetsAt: resets } }, fetchedAt: new Date(now).toISOString(), error: 'usage endpoint answered 500', lastErrorAt: new Date(now).toISOString() });
  assert.equal(accounts.rankAccounts('default', undefined, now).at(-1), b.id);

  // `unknown` below `entitled` at equal score: two never-polled accounts, one of
  // which an earlier console proved (a successful read in the shared store).
  const m = await accounts.addToken('proved', 'sk-ant-oat01-provedvalue0000000');
  accounts.learned.noteRead(accounts.fingerprintOf(m.id), { successAt: new Date(now - 5 * HOUR).toISOString() });
  assert.equal(accounts.entitlementOf(m.id, now).state, 'entitled');
  const order = accounts.rankAccounts('default', undefined, now);
  assert.ok(order.indexOf(m.id) < order.indexOf(n.id), 'entitled before unknown at the same 50');
  assert.ok(order.indexOf(c.id) < order.indexOf(m.id), 'but a live 20 % still beats a never-polled 50');

  for (const id of [a.id, b.id, n.id, c.id, m.id]) await accounts.remove(id);
  accounts.stop();
});

test('ACT-2: a five_hour at 100 % whose resetsAt has passed does not refuse a start; a live one at PREFLIGHT_REFUSE_PCT does, with the reset; a learned wall does; the door never throws', async () => {
  const now = Date.now();
  const accounts = makeAccounts({ now: () => now });
  const spare = await accounts.addToken('door', 'sk-ant-oat01-doorvalue000000000');
  // The measured raw-snapshot bug: a meter at 100 % whose window reset twenty
  // minutes ago is a FRESH window nobody re-polled, not a wall.
  plantMeters(accounts, spare.id, { buckets: { five_hour: { utilization: 100, resetsAt: new Date(now - 20 * 60_000).toISOString() } }, fetchedAt: new Date(now - 60_000).toISOString() });
  assert.equal(accounts.headroom(spare.id, undefined, now).ok, true, 'a reset window is not a refusal');
  // …and the same 100 % gone stale is not evidence either.
  plantMeters(accounts, spare.id, { buckets: { five_hour: { utilization: 100, resetsAt: new Date(now + HOUR).toISOString() } }, fetchedAt: new Date(now - USAGE_STALE_MS - 1).toISOString() });
  assert.equal(accounts.headroom(spare.id, undefined, now).ok, true);
  // A LIVE spent window refuses, naming the reset.
  const resets = new Date(now + HOUR).toISOString();
  plantMeters(accounts, spare.id, { buckets: { five_hour: { utilization: PREFLIGHT_REFUSE_PCT, resetsAt: resets } }, fetchedAt: new Date(now).toISOString() });
  const spent = accounts.headroom(spare.id, undefined, now);
  assert.equal(spent.ok, false);
  assert.equal(!spent.ok && spent.kind, 'spent');
  assert.equal(!spent.ok && spent.resetsAt, resets);
  // A busy-but-usable window answers ok with a warning for the announcer.
  plantMeters(accounts, spare.id, { buckets: { five_hour: { utilization: 85, resetsAt: resets } }, fetchedAt: new Date(now).toISOString() });
  const busy = accounts.headroom(spare.id, undefined, now);
  assert.equal(busy.ok, true);
  assert.equal(busy.ok && busy.warn?.pct, 85);
  // A learned wall refuses until its reset, whatever the meter says.
  accounts.markLimited(spare.id, 'five_hour', resets);
  const walled = accounts.headroom(spare.id, undefined, now);
  assert.equal(!walled.ok && walled.kind, 'wall');
  // A per-model wall refuses only that model's run.
  await accounts.remove(spare.id);
  const opus = await accounts.addToken('opus-wall', 'sk-ant-oat01-opuswallvalue00000');
  accounts.markLimited(opus.id, 'seven_day_opus', resets);
  assert.equal(accounts.headroom(opus.id, 'claude-opus-5', now).ok, false);
  assert.equal(accounts.headroom(opus.id, 'claude-sonnet-5', now).ok, true);
  assert.equal(accounts.headroom('never-registered-id', undefined, now).ok, true, 'an unknown id is nobody\'s wall — and no throw');
  await accounts.remove(opus.id);
  accounts.stop();
});

test('ACT-10: two Accounts over two registries sharing one credential see one another\'s wall, entitlement and reads — through the one machine-wide file', () => {
  const now = Date.now();
  const hub = makeAccounts({ registryDir: join(STATE_SANDBOX, 'instance-hub', 'accounts'), instanceId: 'aaaa1111-hub', now: () => now });
  const pe = makeAccounts({ registryDir: join(STATE_SANDBOX, 'instance-pe', 'accounts'), instanceId: 'bbbb2222-pe-hub', now: () => now });
  assert.equal(hub.learned.path, LEARNED_FILE);
  assert.equal(pe.learned.path, LEARNED_FILE, 'one file, whatever the instance');
  assert.equal(hub.fingerprintOf('default'), pe.fingerprintOf('default'), 'the machine login is one credential under two registrations');

  const resets = new Date(now + HOUR).toISOString();
  hub.markLimited('default', 'five_hour', resets);
  assert.equal(pe.limitedUntil('default', now).five_hour, resets, 'a wall the hub console learned is the pe-hub console\'s fact');
  assert.equal(pe.headroom('default', undefined, now).ok, false);

  pe.leaveAccount('default', { kind: 'credential', class: 'billing', reason: 'billing or credit balance needs attention', by: 'classifier' });
  assert.equal(hub.entitlementOf('default', now).state, 'retired', 'and a retirement the pe-hub console wrote is the hub\'s');
  assert.equal(hub.headroom('default', undefined, now).ok, false);
  assert.equal(hub.clearRetired('default'), true);
  assert.equal(pe.entitlementOf('default', now).state, 'unknown');

  // The labels both instances gave the credential are on its one row.
  const row = hub.learned.credential(hub.fingerprintOf('default'))!;
  for (const label of ['aaaa1111-hub/default', 'bbbb2222-pe-hub/default']) {
    assert.ok(row.ids.includes(label), `${label} names the credential`);
  }

  // Retire the wall this test planted so `default` is a candidate downstream.
  hub.markLimited('default', 'five_hour', new Date(now - 1_000).toISOString());
  hub.stop();
  pe.stop();
});

test('ACT-10: labelFor on an id no registry holds answers the tombstoned name', async () => {
  const accounts = makeAccounts();
  const gone = await accounts.addToken('Support Max', 'sk-ant-oat01-supportvalue000000');
  assert.equal(accounts.labelFor(gone.id), 'Support Max');
  await accounts.remove(gone.id);
  assert.equal(accounts.labelFor(gone.id), 'Support Max (removed)', 'a journal line naming the id still reads');
  assert.equal(accounts.labelFor('never-existed'), 'never-existed', 'an id with no history is itself');
  // A fresh facade over the same machine reads the same tombstone.
  assert.equal(makeAccounts().labelFor(gone.id), 'Support Max (removed)');
  accounts.stop();
});

test('the view carries the learned facts, redacted: entitlement, a hashed orgId, the credential fingerprint, lastErrorAt — and no path, no raw id', async () => {
  const accounts = makeAccounts();
  const view = (await accounts.list())[0]!;
  assert.equal(view.id, 'default');
  assert.equal(view.entitlement.state, 'unknown');
  assert.match(view.credential, /^[0-9a-f]{16}$/);
  const failing = await accounts.addToken('failing', 'sk-ant-oat01-failingvalue000000');
  accounts.learned.noteRead(accounts.fingerprintOf(failing.id), { errorAt: '2026-09-14T04:07:18.517Z' });
  const f = (await accounts.list()).find((v) => v.id === failing.id)!;
  assert.equal(f.lastErrorAt, '2026-09-14T04:07:18.517Z');
  assert.equal(f.usage?.fetchedAt, undefined, 'no successful read, no reading time');
  const everything = JSON.stringify(await accounts.list());
  assert.ok(!everything.includes(ACCOUNTS_DIR), 'no state paths');
  assert.ok(!everything.includes(STATE_SANDBOX), 'no learned-store path either');
  await accounts.remove(failing.id);
  accounts.stop();
});

/* ------------------------------------------------------------------ *
 * Profile workspace provisioning
 * ------------------------------------------------------------------ */

test('a profile config dir is provisioned: skills linked, roots trusted, nothing clobbered', async () => {
  // The incident this pins: a session spawned under a bare profile config dir
  // printed `Unknown command: /phased-execution` and exited success with zero
  // turns — the user's skills directory does not exist from inside a moved
  // CLAUDE_CONFIG_DIR, and the workspace was never trusted there.
  const { ensureProfileWorkspace } = await import('../server/accounts/workspace.ts');
  const { lstatSync, readlinkSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const scratch = mkdtempSync(join(tmpdir(), 'pe-workspace-'));
  try {
    const config = join(scratch, 'config');
    const source = join(scratch, 'home-skills');
    mkdirSync(source, { recursive: true });
    // A stand-in for `~/.claude` that does not exist: nothing to link, nothing to
    // inherit — the plugins and settings provisioning have their own tests below.
    const login = join(scratch, 'login');

    ensureProfileWorkspace(config, ['/repo/a'], source, login);
    assert.equal(readlinkSync(join(config, 'skills')), source, 'skills reach the profile');
    const first = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));
    assert.equal(first.projects['/repo/a'].hasTrustDialogAccepted, true);
    assert.equal(statSync(join(config, '.claude.json')).mode & 0o777, 0o600, 'private, like everything here');

    // Idempotent, and a merge rather than a replace.
    ensureProfileWorkspace(config, ['/repo/a', '/repo/b'], source, login);
    const again = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8'));
    assert.equal(again.projects['/repo/a'].hasTrustDialogAccepted, true);
    assert.equal(again.projects['/repo/b'].hasTrustDialogAccepted, true);

    // An operator's own per-profile skills directory is left exactly as found.
    const config2 = join(scratch, 'config2');
    mkdirSync(join(config2, 'skills'), { recursive: true });
    writeFileSync(join(config2, 'skills', 'own.md'), 'mine');
    ensureProfileWorkspace(config2, [], source, login);
    assert.ok(!lstatSync(join(config2, 'skills')).isSymbolicLink(), 'a real directory is not ours to replace');
    assert.equal(readFileSync(join(config2, 'skills', 'own.md'), 'utf8'), 'mine');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a profile config dir inherits the login's plugins: linked when absent, an empty CLI-made registry moved aside, a real one kept", async () => {
  // The incident this pins (measured 2026-09-07): every profile config dir had
  // `skills` linked, so `/phased-execution` boarded — but `plugins/` was the
  // registry the CLI makes for itself on first launch (`installed_plugins.json`
  // `{"version":2,"plugins":{}}` plus the official marketplace it registers by
  // itself), which SHADOWS the login's, so every plugin skill a plan names
  // (`superpowers`, `code-review`, `feature-dev`, `frontend-design`) was
  // absent from every profile-spawned session.
  const { ensureProfileWorkspace } = await import('../server/accounts/workspace.ts');
  const { lstatSync, readlinkSync, readdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const scratch = mkdtempSync(join(tmpdir(), 'pe-workspace-plugins-'));
  try {
    // A stand-in for `~/.claude`: skills, and a plugins registry with something in it.
    const login = join(scratch, 'login');
    const skills = join(login, 'skills');
    const plugins = join(login, 'plugins');
    mkdirSync(skills, { recursive: true });
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user' }] } }),
    );

    // Absent → linked.
    const fresh = join(scratch, 'fresh');
    ensureProfileWorkspace(fresh, [], skills, login);
    assert.equal(readlinkSync(join(fresh, 'plugins')), plugins, "the login's plugins reach the profile");

    // The CLI's own empty registry — byte-for-byte what both measured profiles
    // held — is moved aside, never deleted, and the link takes its place.
    const cliMade = join(scratch, 'cli-made');
    const registry = join(cliMade, 'plugins');
    mkdirSync(join(registry, 'marketplaces', 'claude-plugins-official'), { recursive: true });
    writeFileSync(join(registry, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }, null, 2));
    writeFileSync(
      join(registry, 'known_marketplaces.json'),
      JSON.stringify({
        'claude-plugins-official': {
          source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          installLocation: join(registry, 'marketplaces', 'claude-plugins-official'),
          lastUpdated: '2026-09-06T03:47:27.639Z',
        },
      }, null, 2),
    );
    ensureProfileWorkspace(cliMade, [], skills, login);
    assert.equal(readlinkSync(registry), plugins, "the empty registry no longer hides the login's plugins");
    const aside = readdirSync(cliMade).filter((name) => name.startsWith('plugins.unused-'));
    assert.equal(aside.length, 1, 'moved aside, never deleted');
    assert.deepEqual(JSON.parse(readFileSync(join(cliMade, aside[0], 'installed_plugins.json'), 'utf8')), { version: 2, plugins: {} });
    assert.ok(existsSync(join(cliMade, aside[0], 'marketplaces', 'claude-plugins-official')), 'the whole directory went with it');

    // A registry with anything in it is the operator's and is left exactly as
    // found: a plugin installed under the profile …
    const installed = join(scratch, 'installed');
    mkdirSync(join(installed, 'plugins'), { recursive: true });
    writeFileSync(join(installed, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'own@theirs': [{ scope: 'user' }] } }));
    ensureProfileWorkspace(installed, [], skills, login);
    assert.ok(!lstatSync(join(installed, 'plugins')).isSymbolicLink(), 'an installed plugin is not ours to hide');
    assert.deepEqual(readdirSync(installed).filter((name) => name.startsWith('plugins.unused-')), [], 'and nothing was moved');
    // … or a marketplace a person added by hand, even with nothing installed from it yet.
    const added = join(scratch, 'added');
    mkdirSync(join(added, 'plugins'), { recursive: true });
    writeFileSync(join(added, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
    writeFileSync(
      join(added, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ 'claude-plugins-official': {}, theirs: { source: { source: 'github', repo: 'x/y' } } }),
    );
    ensureProfileWorkspace(added, [], skills, login);
    assert.ok(!lstatSync(join(added, 'plugins')).isSymbolicLink(), 'a marketplace added by hand is content');
    assert.deepEqual(readdirSync(added).filter((name) => name.startsWith('plugins.unused-')), []);

    // A login that has no plugins directory has nothing to offer: the profile is left alone.
    const orphan = join(scratch, 'orphan');
    ensureProfileWorkspace(orphan, [], skills, join(scratch, 'no-such-login'));
    assert.ok(!existsSync(join(orphan, 'plugins')), 'nothing to link to, nothing linked');

    // A second run finds the link and does nothing.
    const before = readdirSync(cliMade).sort();
    ensureProfileWorkspace(cliMade, [], skills, login);
    assert.deepEqual(readdirSync(cliMade).sort(), before, 'a second run is a no-op');
    assert.equal(readlinkSync(registry), plugins);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a profile's settings.json inherits enabledPlugins and extraKnownMarketplaces — filled when lacking, never clobbered, and a second run writes nothing", async () => {
  // Linking the registry is half of it: a plugin the registry holds but no
  // `enabledPlugins` names is installed and OFF. Measured 2026-09-07: one
  // profile had no `settings.json`, the other one holding only `theme` and a
  // notification preference — neither named a plugin.
  const { ensureProfileWorkspace } = await import('../server/accounts/workspace.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const scratch = mkdtempSync(join(tmpdir(), 'pe-workspace-settings-'));
  try {
    const login = join(scratch, 'login');
    const skills = join(login, 'skills');
    mkdirSync(skills, { recursive: true });
    const enabledPlugins = { 'superpowers@claude-plugins-official': true, 'context7@claude-plugins-official': false };
    const extraKnownMarketplaces = { 'anthropic-agent-skills': { source: { source: 'github', repo: 'anthropics/skills' } } };
    writeFileSync(
      join(login, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, model: 'opus', hooks: {}, enabledPlugins, extraKnownMarketplaces, theme: 'dark' }),
    );

    // No settings.json at all → created holding the two keys and nothing else.
    const bare = join(scratch, 'bare');
    ensureProfileWorkspace(bare, [], skills, login);
    const created = JSON.parse(readFileSync(join(bare, 'settings.json'), 'utf8'));
    assert.deepEqual(created, { enabledPlugins, extraKnownMarketplaces }, 'only the plugin keys travel — never permissions, model, hooks or theme');
    assert.equal(statSync(join(bare, 'settings.json')).mode & 0o777, 0o600, 'private, like everything here');

    // A settings.json with keys of its own keeps every one of them, and a key
    // the profile already holds is never overwritten by the login's.
    const own = join(scratch, 'own');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'settings.json'), JSON.stringify({ theme: 'light', agentPushNotifEnabled: true, enabledPlugins: { 'mine@theirs': true } }));
    ensureProfileWorkspace(own, [], skills, login);
    const merged = JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8'));
    assert.deepEqual(
      merged,
      { theme: 'light', agentPushNotifEnabled: true, enabledPlugins: { 'mine@theirs': true }, extraKnownMarketplaces },
      'the lacking key filled, the present ones kept',
    );

    // A second run: byte-identical, same inode — no tmp + rename happened.
    const stat1 = statSync(join(own, 'settings.json'));
    const text1 = readFileSync(join(own, 'settings.json'), 'utf8');
    ensureProfileWorkspace(own, [], skills, login);
    assert.equal(readFileSync(join(own, 'settings.json'), 'utf8'), text1);
    assert.equal(statSync(join(own, 'settings.json')).ino, stat1.ino, 'a second run does not rewrite the file');
    assert.ok(!existsSync(join(own, 'settings.json.tmp')), 'no temp file left behind');

    // Fail-open: a login without a settings.json has nothing to give and the
    // profile gets no file it did not have …
    const orphan = join(scratch, 'orphan');
    ensureProfileWorkspace(orphan, [], skills, join(scratch, 'no-such-login'));
    assert.ok(!existsSync(join(orphan, 'settings.json')));
    // … and a profile settings.json that does not parse is a person's to fix,
    // never ours to replace with `{}`.
    const broken = join(scratch, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'settings.json'), '{ not json');
    ensureProfileWorkspace(broken, [], skills, login);
    assert.equal(readFileSync(join(broken, 'settings.json'), 'utf8'), '{ not json', 'an unparseable file is left for a person');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 15 — does the API take this credential's work?
 * One declared one-turn session, read by the runner's own classifier, whose
 * answer lands in the machine-wide learned store; the rank's reasons on the
 * view; the tombstones as rows.
 * ------------------------------------------------------------------ */

/** A `claude` that prints canned stream-json lines and closes — never a real CLI. */
function fakeProbeSpawn(lines: string[], opts: { closeCode?: number; hold?: boolean } = {}) {
  const seen: { argv: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const spawnFn = ((_file: string, argv: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
    seen.push({ argv, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      if (!opts.hold) child.emit('close', opts.closeCode ?? 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, seen };
}

const PROBE_INIT = JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.271', model: 'claude-haiku-4-5', session_id: 'probe-session', tools: [] });
const PROBE_ANSWER = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.0021 });
const PROBE_ORG_RETRY = JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'oauth_org_not_allowed', attempt: 1, max_retries: 1, error_status: 403, message: 'Your organization has disabled Claude subscription access.' });

/** A token account over its own learned file, so a retirement here reaches no other test. */
async function probeHarness(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-probe-'));
  const accounts = makeAccounts({
    learnedFile: join(dir, 'learned.json'),
    instanceId: 'probe-test',
    fetchFn: (async () => new Response('nope', { status: 500 })) as typeof fetch,
  });
  const view = await accounts.addToken(name, `sk-ant-oat01-${name.toLowerCase().replace(/\W/g, '')}000000000000`);
  return { accounts, id: view.id, dir };
}

test('phase 15: the one-turn check is declared and bounded — one turn, the cheapest model, a budget cap, no MCP server, the account env, no PE_ variable and no session id inherited', async () => {
  const argv = probeArgv();
  const at = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(at('--print'), 'ok');
  assert.equal(at('--max-turns'), '1', 'one turn: the check pays for one answer, never a task');
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--output-format'), 'stream-json');
  assert.ok(Number(at('--max-budget-usd')) > 0 && Number(at('--max-budget-usd')) <= 0.1, 'a cap that a button cannot turn into a bill');
  assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--mcp-config'), 'strict with no config: no server starts, none is unioned in');

  const env = probeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, {
    PATH: '/usr/bin', PE_OWNER: 'someone/else', PE_OUTCOME_FILE: '/x', PHASE_EXEC_GATES: '1', CLAUDE_CODE_SESSION_ID: 'the-console-session',
  });
  assert.equal(env.PE_OWNER, ENTITLEMENT_PROBE_OWNER, 'the session declares itself the console\'s own');
  assert.equal(env.PHASE_CONSOLE_PROBE, '1', 'the presence hook forwards the probe flag, so the registry hides it from every operator total');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok', 'the account\'s env reaches the child');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '1');
  assert.equal(env.PE_OUTCOME_FILE, undefined, 'no PE_ variable the console was started with');
  assert.equal(env.PHASE_EXEC_GATES, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, 'the child never claims the console\'s own session');
  assert.equal(env.PATH, '/usr/bin');

  const { spawnFn, seen } = fakeProbeSpawn([PROBE_INIT, PROBE_ANSWER]);
  const session = await runProbeSession({ env, cwd: '/tmp', spawnFn });
  assert.equal(session.ending, 'result');
  assert.equal(session.cliVersion, '2.1.271');
  assert.equal(session.costUsd, 0.0021);
  assert.equal(session.turns, 1);
  assert.equal(session.signal.subtype, 'success');
  assert.equal(session.signal.isError, false);
  assert.deepEqual(seen[0].argv, argv);
  assert.equal(seen[0].cwd, '/tmp');
});

test('phase 15: a credential-class api_retry IS the answer — the session ends at once instead of waiting out its retries; silence and a timeout are not answers', async () => {
  const early = await runProbeSession({ env: {}, cwd: '/tmp', spawnFn: fakeProbeSpawn([PROBE_INIT, PROBE_ORG_RETRY], { hold: true }).spawnFn, timeoutMs: 5_000 });
  assert.equal(early.ending, 'refused-early');
  assert.deepEqual(early.signal.retryCategories, ['oauth_org_not_allowed']);
  assert.match(early.signal.text ?? '', /organization has disabled/);

  const quiet = await runProbeSession({ env: {}, cwd: '/tmp', spawnFn: fakeProbeSpawn([], { closeCode: 1 }).spawnFn });
  assert.equal(quiet.ending, 'exited');
  const slow = await runProbeSession({ env: {}, cwd: '/tmp', spawnFn: fakeProbeSpawn([PROBE_INIT], { hold: true }).spawnFn, timeoutMs: 30 });
  assert.equal(slow.ending, 'timeout');
  assert.equal(slow.cliVersion, '2.1.271', 'what the session DID say is kept');
});

test('phase 15: probeVerdict reads the stop with classify() — a refusal fails with its class, a completion or a usage limit is an answer, a capacity blip and a timeout prove nothing', () => {
  const session = (over: Partial<ProbeSession>): ProbeSession => ({
    ending: 'result', signal: { text: '', retryCategories: [] }, argv: probeArgv(), ms: 10, ...over,
  });
  const org = probeVerdict(session({ ending: 'refused-early', signal: { text: '', retryCategories: ['oauth_org_not_allowed'] } }));
  assert.deepEqual([org.status, org.class], ['fail', 'org-policy']);
  const disabled = probeVerdict(session({ signal: { subtype: 'success', isError: true, text: 'API Error: 403 This organization has been disabled.' } }));
  assert.deepEqual([disabled.status, disabled.class], ['fail', 'org-policy'], 'the text arm too, before `success` is believed');
  const billing = probeVerdict(session({ signal: { subtype: 'success', isError: true, text: 'Credit balance is too low' } }));
  assert.deepEqual([billing.status, billing.class], ['fail', 'billing']);
  assert.equal(probeVerdict(session({ signal: { subtype: 'success', isError: false, text: 'ok' } })).status, 'ok');
  const limited = probeVerdict(session({ signal: { subtype: 'success', isError: true, text: "You've hit your session limit · resets 3:45pm" } }));
  assert.equal(limited.status, 'ok', 'a usage limit is the API taking the credential and then counting');
  assert.match(limited.reason, /usage limit/);
  assert.equal(probeVerdict(session({ signal: { subtype: 'error_max_budget_usd', text: '' } })).status, 'ok', 'a spent cap spent something');
  assert.equal(probeVerdict(session({ signal: { subtype: 'success', isError: true, text: 'API Error: 529 overloaded_error' } })).status, 'skip', 'capacity says nothing about the credential');
  assert.equal(probeVerdict(session({ ending: 'timeout', error: 'no answer within 90 s' })).status, 'skip');
  assert.equal(probeVerdict(session({ ending: 'spawn-failed', error: 'spawn claude ENOENT' })).status, 'skip');
});

test('phase 15: an answer promotes `unknown` to `entitled` by probe, counts the check, keeps its cost and version, and the view carries it — logged with the actor whole', async () => {
  const { accounts, id } = await probeHarness('Probe Answer');
  try {
    const { spawnFn, seen } = fakeProbeSpawn([PROBE_INIT, PROBE_ANSWER]);
    const actor = { by: 'operator', via: 'api', origin: 'local', remoteUser: null, door: 'operator', trigger: 'entitlement-probe' };
    const out = await accounts.probeEntitlement(id, { actor, spawnFn, cwd: mkdtempSync(join(tmpdir(), 'pc-probe-cwd-')) });
    assert.ok(out);
    assert.equal(out.spent, true);
    assert.deepEqual(out.moved, { from: 'unknown', to: 'entitled' });
    assert.equal(out.probe.status, 'ok');
    assert.equal(out.probe.count, 1);
    assert.equal(out.probe.by, 'operator');
    assert.equal(out.probe.costUsd, 0.0021);
    assert.equal(out.probe.cliVersion, '2.1.271');
    assert.equal(out.probe.ending, 'result');
    assert.equal(seen[0].env.CLAUDE_CODE_OAUTH_TOKEN?.startsWith('sk-ant-oat01-'), true, 'the TOKEN account\'s credential, never the machine login');
    assert.equal(out.account.entitlement.state, 'entitled');
    assert.equal(out.account.entitlement.by, 'probe');
    assert.equal(out.account.probe?.status, 'ok');
    assert.ok(!JSON.stringify(out).includes('sk-ant-oat01'), 'no secret in what the route hands back');

    const second = await accounts.probeEntitlement(id, { actor, spawnFn: fakeProbeSpawn([PROBE_INIT, PROBE_ANSWER]).spawnFn });
    assert.equal(second?.probe.count, 2, 'every check is counted');
    assert.equal(second?.moved, undefined, 'an entitled credential stays entitled; nothing moved');

    const lines = recent(200);
    const start = lines.findLast((line) => line.event === 'session.start' && line.data?.account === id);
    assert.equal(start?.data?.door, 'operator');
    assert.equal(start?.data?.trigger, 'entitlement-probe');
    assert.equal(start?.data?.owner, ENTITLEMENT_PROBE_OWNER);
    const ran = lines.findLast((line) => line.event === 'accounts.entitlement-probe.ran' && line.data?.account === id);
    assert.equal(ran?.data?.status, 'ok');
    assert.equal(ran?.data?.spent, true);
  } finally {
    await accounts.remove(id);
    accounts.stop();
  }
});

test('phase 15: a refusal RETIRES the credential with its organisation, as a phase\'s refusal would — the view says unusable and why the rank leaves it out, and clearing stays a person\'s', async () => {
  const { accounts, id } = await probeHarness('Probe Refused');
  try {
    accounts.noteAuthProbe(id, { loggedIn: true, orgId: '11111111-2222-4333-8444-555555555555' } as never);
    const out = await accounts.probeEntitlement(id, {
      actor: { by: 'operator' }, spawnFn: fakeProbeSpawn([PROBE_INIT, PROBE_ORG_RETRY], { hold: true }).spawnFn,
    });
    assert.ok(out);
    assert.equal(out.probe.status, 'fail');
    assert.equal(out.probe.class, 'org-policy');
    assert.equal(out.probe.ending, 'refused-early');
    assert.deepEqual(out.moved, { from: 'unknown', to: 'retired' });
    assert.equal(out.account.authState, 'unusable');
    assert.equal(out.account.entitlement.by, 'probe');
    assert.equal(out.account.breaker?.candidate, false);
    assert.match(out.account.breaker?.candidate === false ? out.account.breaker.why : '', /^retired/);
    assert.equal(accounts.rankAccounts(null).includes(id), false, 'out of the rank until cleared');

    // A later ANSWER does not reopen it: the one door out of `retired` is a person's.
    const answered = await accounts.probeEntitlement(id, { actor: { by: 'operator' }, spawnFn: fakeProbeSpawn([PROBE_INIT, PROBE_ANSWER]).spawnFn });
    assert.equal(answered?.probe.status, 'ok');
    assert.equal(answered?.account.entitlement.state, 'retired');
    assert.equal(answered?.moved, undefined);
    assert.ok(accounts.clearRetired(id, 'operator'));
    assert.equal(accounts.entitlementOf(id).state, 'unknown');
  } finally {
    await accounts.remove(id);
    accounts.stop();
  }
});

test('phase 15: refused before any spend when a check would mislead — a token that is gone never inherits the machine login; one check per account at a time', async () => {
  const { accounts, id, dir } = await probeHarness('Probe Busy');
  try {
    // One at a time: a second press while the first is running is refused by name.
    const held = accounts.probeEntitlement(id, { actor: { by: 'operator' }, spawnFn: fakeProbeSpawn([PROBE_INIT], { hold: true }).spawnFn, timeoutMs: 80 });
    assert.equal(accounts.probeInFlight(id), true);
    await assert.rejects(accounts.probeEntitlement(id, { actor: { by: 'operator' } }), ProbeInFlightError);
    const timedOut = await held;
    assert.equal(timedOut?.probe.status, 'skip', 'no answer is not a no');
    assert.equal(timedOut?.account.entitlement.state, 'unknown', 'and moves nothing');
    assert.equal(accounts.probeInFlight(id), false);

    // The token vanishes from its store: the check refuses rather than run as whoever is signed in.
    const { rmSync } = await import('node:fs');
    rmSync(join(ACCOUNTS_DIR, id, 'token'), { force: true });
    const { spawnFn, seen } = fakeProbeSpawn([PROBE_INIT, PROBE_ANSWER]);
    const refused = await accounts.probeEntitlement(id, { actor: { by: 'operator' }, spawnFn });
    assert.equal(seen.length, 0, 'no session started');
    assert.equal(refused?.spent, false);
    assert.equal(refused?.probe.status, 'skip');
    assert.match(refused?.probe.reason ?? '', /token is missing/);
    assert.equal(refused?.probe.count, 2, 'a refused press is still a press');
    assert.equal(await accounts.probeEntitlement('nobody-here', { actor: { by: 'operator' } }), undefined);
  } finally {
    await accounts.remove(id);
    accounts.stop();
    void dir;
  }
});

test('phase 15: tombstones() answers what THIS console removed from the learned store, and forgets an id registered again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-tombstones-'));
  const accounts = makeAccounts({ learnedFile: join(dir, 'learned.json'), instanceId: 'tomb-test' });
  const other = makeAccounts({ learnedFile: join(dir, 'learned.json'), instanceId: 'another-console' });
  try {
    const view = await accounts.addToken('Old Support', 'sk-ant-oat01-oldsupport0000000000');
    assert.deepEqual(accounts.tombstones(), []);
    await accounts.remove(view.id);
    const [tomb] = accounts.tombstones();
    assert.equal(tomb?.id, view.id);
    assert.equal(tomb?.name, 'Old Support');
    assert.equal(tomb?.credential, view.credential);
    assert.equal(tomb?.entitlement.state, 'unknown');
    assert.deepEqual(other.tombstones(), [], 'another console\'s registrations are its own to list');
    const again = await accounts.addToken('Old Support', 'sk-ant-oat01-oldsupport1111111111');
    assert.equal(again.id, view.id);
    assert.deepEqual(accounts.tombstones(), [], 'registered again, so no longer a tombstone');
    await accounts.remove(again.id);
  } finally {
    accounts.stop();
    other.stop();
  }
});

test('phase 15: list() ranks the candidates in the order an `auto` pick walks, and says why the others are out in the rank\'s own words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-standing-'));
  const accounts = makeAccounts({ learnedFile: join(dir, 'learned.json'), instanceId: 'standing-test' });
  const busy = await accounts.addToken('Busy Max', 'sk-ant-oat01-busymax00000000000000');
  const idle = await accounts.addToken('Idle Max', 'sk-ant-oat01-idlemax00000000000000');
  const cool = await accounts.addToken('Cool Max', 'sk-ant-oat01-coolmax00000000000000');
  try {
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    plantMeters(accounts, busy.id, { buckets: { five_hour: { utilization: 80, resetsAt: soon } }, fetchedAt: new Date().toISOString() });
    plantMeters(accounts, idle.id, { buckets: { five_hour: { utilization: 10, resetsAt: soon } }, fetchedAt: new Date().toISOString() });
    accounts.leaveAccount(cool.id, { kind: 'usage', reason: 'usage limit hit', by: 'live-wall' });
    const views = await accounts.list();
    const of = (id: string) => views.find((view) => view.id === id)!;
    const order = accounts.rankAccounts(null);
    assert.equal(of(idle.id).breaker?.candidate, true);
    assert.deepEqual(
      views.filter((view) => view.breaker?.candidate).map((view) => [view.id, view.breaker?.candidate ? view.breaker.rank : null])
        .sort((a, b) => Number(a[1]) - Number(b[1])).map(([viewId]) => viewId),
      order,
      'the rank numbers ARE rankAccounts\' order',
    );
    const cooled = of(cool.id).breaker;
    assert.equal(cooled?.candidate, false);
    assert.match(cooled?.candidate === false ? cooled.why : '', /^cooling/);
    assert.ok(cooled?.candidate === false && cooled.until, 'a cooling account says until when');
    assert.ok(typeof of(idle.id).pollEveryMs === 'number' && of(idle.id).pollEveryMs! > 0, 'the meters\' age is judged against the cadence');
    assert.ok(of(cool.id).lastLeftAt?.by === 'live-wall', 'who moved off it, and why');
  } finally {
    for (const view of [busy, idle, cool]) await accounts.remove(view.id);
    accounts.stop();
  }
});
