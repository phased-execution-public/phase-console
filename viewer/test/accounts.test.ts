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
import { mkdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AccountStore, ACCOUNTS_DIR, profileConfigDir } from '../server/accounts/store.ts';
import {
  Credentials, claudeKeychainService, consoleKeychainService, KEYCHAIN_STORE_FAILED, type Exec,
} from '../server/accounts/credentials.ts';
import { USAGE_STALE_MS } from '../server/accounts/usage.ts';
import { Accounts } from '../server/accounts/index.ts';

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

test('store: markLimited keeps future windows and drops the ones already reset', () => {
  const store = new AccountStore();
  const id = store.newId('limits');
  store.add({ id, kind: 'token', createdAt: 'x' });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  store.markLimited(id, 'five_hour', past);
  store.markLimited(id, 'seven_day', future);
  const kept = store.get(id)?.limitedUntil ?? {};
  assert.equal(kept.five_hour, undefined, 'a reset that has passed is not carried around');
  assert.equal(kept.seven_day, future);
  store.remove(id);
});

test('store: the default account gets a RESERVED row — persisted, but never a registration', () => {
  const store = new AccountStore();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  assert.equal(store.get('default'), undefined, 'no row until there is something to remember');

  store.markLimited('default', 'five_hour', future);
  assert.equal(store.get('default')?.limitedUntil?.five_hour, future);
  assert.equal(store.get('default')?.kind, 'default');

  // The whole objection to a stored default row was that it would double-list
  // and double-poll — `list()` and `startPolling()` both walk `stored()`, so
  // that is the line that has to hold, and it is asserted rather than assumed.
  assert.ok(
    !store.stored().some((meta) => meta.id === 'default'),
    'the reserved row is invisible to everything that means "accounts the operator added"',
  );
  // …and it is still not something anyone may register.
  assert.throws(() => store.add({ id: 'default', kind: 'token', createdAt: 'x' }), /built in/);
  // A minted id never collides with it either.
  assert.notEqual(store.newId('default'), 'default');

  // It survives the process, which is the entire point.
  assert.equal(new AccountStore().get('default')?.limitedUntil?.five_hour, future);

  // Retire it, as every test here retires what it created — a LIVE wall on
  // `default` disqualifies it from `rankAccounts` for everything downstream.
  // A past reset is what "retired" means: the row keeps the key until the next
  // write prunes it, and every reader filters on read.
  store.markLimited('default', 'five_hour', new Date(Date.now() - 1_000).toISOString());
  const raw = new AccountStore().get('default')?.limitedUntil ?? {};
  assert.ok(
    Object.values(raw).every((iso) => Date.parse(iso) <= Date.now()),
    'no live wall is left on the machine login',
  );
});

test('store: an account nobody registered is not learned about — no row is invented', () => {
  const store = new AccountStore();
  store.markLimited('ghost', 'five_hour', new Date(Date.now() + 60_000).toISOString());
  assert.equal(store.get('ghost'), undefined, 'only `default` is minted on demand');
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
} = {}): Accounts {
  return new Accounts({
    platform: 'linux',
    exec: overrides.exec ?? fakeExec().exec,
    ...(overrides.fetchFn ? { fetchFn: overrides.fetchFn, usageBase: 'http://usage.invalid' } : {}),
    ...(overrides.onChange ? { onChange: overrides.onChange } : {}),
  });
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

test('store: a stored `default` row may carry limits, and may never carry a registration', () => {
  // A stored default row is legitimate and load-bearing — `markLimited` mints
  // one so the machine login remembers its walls across a restart. What must
  // not survive the read is one claiming to be a REGISTRATION: `add()` refuses
  // to create such a row, but nothing stood between a hand-edited (or
  // downgraded, or corrupted) accounts.json and `{id: 'default', kind: 'token'}`
  // — which `envFor` would honour by looking up a keychain token for it, and
  // run work as an identity nobody registered, under the name that means "the
  // machine's own login".
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
  assert.equal(row.limitedUntil?.five_hour, future, 'the windows — the whole reason the row exists — survive');

  // Retire it: a live wall on `default` disqualifies it downstream.
  const store = new AccountStore();
  store.markLimited('default', 'five_hour', new Date(Date.now() - 1_000).toISOString());
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
