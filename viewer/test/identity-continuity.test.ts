/**
 * A run keeps the identity it started on (control-tower phase 91, #131).
 *
 * Seen on the hub: `default` is a SLOT that follows the machine login. A person
 * signed the machine in as somebody else in another terminal; the live session
 * died, the halt blamed a lapsed login, and the heal resumed the run on the new
 * identity — at 90 % of its weekly window — without a word.
 *
 * ID-1  a run binds the identity behind its account id at start (`run.identity`)
 * ID-2  a change of that identity journals `run.identity-changed {was, now}` and
 *       PARKS the run with an errand offering both ways on — never a boarding on
 *       the new identity; the service does the same for a run no loop drives
 * ID-3  the heal never resumes a run on a changed identity by itself: the
 *       switch-account vehicle refuses, and converge relaunches it only on a press
 * ID-4  a refusal met on a changed identity says the login changed identity —
 *       not "expired or signed out" — and retires nothing
 * ID-4  an identity change also re-keys the learned walls and the breaker (#109)
 * ID-2  a person's answer: continue on the new login, or move to the profile of
 *       the identity the run started on
 * (ID-5, a person's retries surviving a halt, is in `press-does-what-it-says.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATE_SANDBOX } from './state-sandbox.ts';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { pressActor } = await import('../server/actor.ts');
const { planConvergence, PRESS_ONLY_HALT_KINDS } = await import('../server/converge.ts');
const { HALT_KINDS, RUN_HALT_KINDS } = await import('../shared/recovery-model.js');
type RunState = import('../server/runner/state.ts').RunState;
type RunIdentity = import('../server/accounts/index.ts').RunIdentity;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;
type Exec = import('../server/accounts/credentials.ts').Exec;

const PERSON = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;
const ADMIN: RunIdentity = { account: 'default', key: 'k-admin', email: 'admin@example.com', org: 'The Market' };
const INFO: RunIdentity = { account: 'default', key: 'k-info', email: 'info@example.com', org: 'The Market' };

/* ------------------------------------------------------------------ *
 * A runner over stub scripts — the shape `press-does-what-it-says` uses
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-identity-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""; w=""; found=0
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
if [ "\${2:-}" = "status" ]; then echo "phase \${3:-?}: free"; fi
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

const phaseOf = (request: SpawnRequest) => Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);

function runner(r: Repo, spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/* ------------------------------------------------------------------ *
 * A service over a real plan — the vehicle, the verb, the stored park
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-26
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — cart api
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-identity-svc-'));
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

const journalOn = (root: string, runId: string) => readFileSync(journalFile(root, 'alpha', runId), 'utf8')
  .split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });

/** A stored run bound to admin@ on `default`, halted on phase 2 the way #131's re-login left it. */
function haltedOnDefault(root: string, over: (state: RunState) => void = () => {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.identity = { ...ADMIN, at: '2026-09-25T11:51:00.000Z' };
  state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.attempts = 1;
  record.cause = { kind: 'credential-refused', class: 'auth', reason: 'the API refused the login', at: '2026-09-25T12:16:26.000Z' } as never;
  state.halt = { at: '2026-09-25T12:16:26.000Z', reason: 'the API refused the login (account: the machine login)', phase: 2, kind: 'credential-refused' };
  over(state);
  saveRun(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * ID-1 — the run binds its identity at start
 * ------------------------------------------------------------------ */

test('ID-1: a run binds the identity behind its account id at start, and journals it once', async () => {
  const r = repo();
  try {
    const spawn: SpawnFn = async (request) => { r.markDone(phaseOf(request)); return ok(); };
    const { instance, events } = runner(r, spawn, { identityOf: () => ADMIN });
    await instance.start({ slug: 'demo', root: r.root, actor: pressActor(PERSON as never) });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'finished');
    assert.equal(state.identity?.key, 'k-admin');
    assert.equal(state.identity?.email, 'admin@example.com');
    assert.equal(state.identity?.account, 'default');
    const bound = journalled(events, 'run.identity');
    assert.equal(bound.length, 1, 'bound once, at the start');
    assert.equal(bound[0].email, 'admin@example.com');
    assert.equal(bound[0].account, 'default');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * ID-2 — a change parks the run, never boards on the new identity
 * ------------------------------------------------------------------ */

test('ID-2: the machine login changing identity mid-run parks the run before its next boarding — journalled was/now, with an errand offering both ways on', async () => {
  const r = repo();
  try {
    let who: RunIdentity = ADMIN;
    const boarded: number[] = [];
    // Phase 1's session is where the person re-logs the machine in elsewhere.
    const spawn: SpawnFn = async (request) => {
      const phase = phaseOf(request);
      boarded.push(phase);
      r.markDone(phase);
      if (phase === 1) who = INFO;
      return ok();
    };
    const { instance, events } = runner(r, spawn, { identityOf: () => who });
    await instance.start({ slug: 'demo', root: r.root, actor: pressActor(PERSON as never) });
    await instance.wait();
    const state = instance.current()!;
    assert.deepEqual(boarded, [1], 'nothing boards on the new identity');
    assert.equal(state.status, 'halted');
    assert.equal(state.halt?.kind, 'identity-changed');
    assert.match(state.halt?.reason ?? '', /changed identity/);
    assert.match(state.halt?.reason ?? '', /info@example\.com/);
    assert.match(state.halt?.reason ?? '', /admin@example\.com/);
    const changed = journalled(events, 'run.identity-changed');
    assert.equal(changed.length, 1);
    assert.equal((changed[0].was as RunIdentity).email, 'admin@example.com');
    assert.equal((changed[0].now as RunIdentity).email, 'info@example.com');
    assert.ok(state.errand, 'the park carries an errand');
    assert.match(state.errand!.how, /[Cc]ontinue on (the new login|info@example\.com)/);
    assert.match(state.errand!.how, /admin@example\.com/, 'the other way on names the identity the run started on');
    assert.equal(state.identity?.key, 'k-admin', 'the binding is a person\'s to move, not the park\'s');
  } finally { r.cleanup(); }
});

test('ID-2: the service parks a run no loop drives when the identity behind its account changes — journalled on the run, halt kind identity-changed', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = haltedOnDefault(root, (state) => { state.status = 'paused'; state.halt = null; });
    const other = newRun({ slug: 'alpha', root, accountId: 'acct-elsewhere' });
    (svc as unknown as { identityChanged: (accountId: string, now: RunIdentity) => number }).identityChanged('default', INFO);
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.halt?.kind, 'identity-changed');
    assert.match(after.halt?.reason ?? '', /changed identity/);
    assert.ok(after.errand, 'the errand rides the stored park');
    const lines = journalOn(root, run.id).filter((line) => line.event === 'run.identity-changed');
    assert.equal(lines.length, 1);
    assert.equal((lines[0].data?.was as RunIdentity).email, 'admin@example.com');
    assert.equal((lines[0].data?.now as RunIdentity).email, 'info@example.com');
    assert.equal(other.halt ?? null, null, 'a run on another account is not touched');
  } finally { svc.close(); rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * ID-3 — the heal never resumes on a changed identity
 * ------------------------------------------------------------------ */

test('ID-3: the heal\'s switch-account vehicle refuses a run whose account now answers another identity — even with room and a cleared breaker', async () => {
  const root = scratch();
  const svc = service(root);
  const real = (svc as unknown as { accounts: unknown }).accounts;
  try {
    let who: RunIdentity = INFO;
    (svc as unknown as { accounts: unknown }).accounts = {
      roomOf: () => ({ ok: true, headroomPct: 90, resetsAt: null }),
      switchCandidates: () => ({ ranked: [], declined: [], wake: null }),
      // The #131 shape: the new organisation id opened the breaker after the wall.
      entitlementOf: () => ({ state: 'unknown', at: '2026-09-25T12:17:00.000Z' }),
      labelFor: (id: string | undefined) => id ?? 'the machine login',
      accountIds: () => ['default'],
      identityOf: () => who,
    };
    const state = haltedOnDefault(root);
    const record = phaseRecord(state, 2);
    const situation = { id: 'resource-wall', sub: 'auth', key: 'resource-wall:auth', label: 'Resource wall', blurb: '', actor: 'machine', why: [] };
    type Resolved = { vehicle?: { kind: string; accountId?: string }; refused?: string };
    const resolve = (svc as unknown as {
      resolveVehicle: (rung: unknown, situation: unknown, record: unknown, evidence: null, slug: string, state: RunState) => Resolved;
    }).resolveVehicle.bind(svc);
    const refused = resolve({ vehicle: 'switch-account' }, situation, record, null, 'alpha', state);
    assert.equal(refused.vehicle, undefined, 'no resume on somebody else\'s login');
    assert.match(refused.refused ?? '', /changed identity/);
    assert.match(refused.refused ?? '', /a person/);

    // The same login signed in again — the rung resumes in place, as before.
    who = ADMIN;
    const stay = resolve({ vehicle: 'switch-account' }, situation, record, null, 'alpha', state);
    assert.equal(stay.vehicle?.kind, 'switch-account');
    assert.equal(stay.vehicle?.accountId, 'default');
  } finally {
    (svc as unknown as { accounts: unknown }).accounts = real;
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ID-3: an identity-changed park is relaunched by no trigger but a person\'s press — and every halt kind it writes is on the owner\'s list', () => {
  assert.ok(HALT_KINDS.includes('identity-changed'));
  assert.ok(RUN_HALT_KINDS.includes('identity-changed'), 'the run halts, not one phase');
  assert.ok(PRESS_ONLY_HALT_KINDS.includes('identity-changed'));
  const state = newRun({ slug: 'alpha', root: '/nonexistent' });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.halt = { at: '', reason: 'the machine login changed identity', phase: 2, kind: 'identity-changed' };
  const facts = (trigger: 'timer' | 'button') => ({
    slug: 'alpha', now: Date.now(), trigger, board: { 1: 'done', 2: 'ready' }, runs: [state], live: new Set<string>(),
    locks: [], prefs: { resumeAtBoot: 'auto' }, pidAlive: () => false,
  });
  const byClock = planConvergence(facts('timer') as never);
  assert.ok(!byClock.actions.some((a) => a.kind === 'relaunch'), `timer: ${byClock.actions.map((a) => a.kind).join(',')}`);
  const byPress = planConvergence(facts('button') as never);
  assert.ok(byPress.actions.some((a) => a.kind === 'relaunch'), `button: ${byPress.actions.map((a) => a.kind).join(',')}`);
});

/* ------------------------------------------------------------------ *
 * ID-4 — the halt names what happened, and retires nothing
 * ------------------------------------------------------------------ */

test('ID-4: a refusal met after the machine login changed identity halts on the change — not "expired or signed out" — and retires no credential', async () => {
  const r = repo();
  try {
    let who: RunIdentity = ADMIN;
    const left: { kind: string }[] = [];
    const spawn: SpawnFn = async () => {
      // The re-login lands mid-session and the session dies on it.
      who = INFO;
      return ok({ costUsd: 0, turns: 1, signal: { subtype: 'success', code: 1, isError: true, text: '', retryCategories: ['authentication_failed'] } });
    };
    const { instance, events } = runner(r, spawn, {
      identityOf: () => who,
      leaveAccount: ((_id: string | undefined, leaving: { kind: string }) => { left.push(leaving); return null; }) as never,
    });
    await instance.start({ slug: 'demo', root: r.root, actor: pressActor(PERSON as never) });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.halt?.kind, 'identity-changed');
    assert.match(state.halt?.reason ?? '', /changed identity/);
    assert.doesNotMatch(state.halt?.reason ?? '', /expired or signed out/);
    assert.deepEqual(left.filter((l) => l.kind === 'credential'), [], 'the new login is not at fault — nothing is retired');
    assert.equal(journalled(events, 'run.identity-changed').length, 1);
  } finally { r.cleanup(); }
});

test('ID-4 (#109): an identity change re-keys what the machine learned about the credential — its walls and its breaker go with the old identity', async () => {
  const exec: Exec = async (file, args) =>
    file === 'claude' && args[0] === '--version' ? { stdout: '9.9.9 (Claude Code)\n' } : { stdout: '' };
  const changes: { id: string; now: RunIdentity }[] = [];
  const accounts = new Accounts({
    platform: 'linux', exec, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    learnedFile: join(STATE_SANDBOX, 'learned-p91-rekey.json'),
    onIdentityChange: (id: string, now: RunIdentity) => { changes.push({ id, now }); },
  });
  const signIn = (dir: string, email: string, org: string) => {
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: `tok-${email}`, refreshToken: `r-${email}`, expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' },
    }));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org, organizationName: 'An org' } }));
  };
  try {
    const { id, dir } = accounts.beginProfile('rekey');
    signIn(dir, 'admin@example.com', 'org-a');
    const first = accounts.identityOf(id);
    assert.equal(first?.email, 'admin@example.com');
    const resets = new Date(Date.now() + 3 * 3_600_000).toISOString();
    accounts.markLimited(id, 'five_hour', resets);
    accounts.retire(id, undefined, 'the API refused the login', 'classifier', 'auth');
    assert.equal(accounts.entitlementOf(id).state, 'retired');
    assert.ok(accounts.limitedUntil(id).five_hour);

    signIn(dir, 'info@example.com', 'org-a');
    const now = accounts.identityOf(id);
    assert.equal(now?.email, 'info@example.com');
    assert.notEqual(now?.key, first?.key);
    assert.deepEqual(accounts.limitedUntil(id), {}, 'the old identity\'s wall is not the new one\'s');
    assert.equal(accounts.entitlementOf(id).state, 'unknown', 'nor is its retirement');
    assert.deepEqual(changes.map((c) => [c.id, c.now.email]), [[id, 'info@example.com']], 'told once');
    accounts.identityOf(id);
    assert.equal(changes.length, 1, 'an unchanged identity tells nobody');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * ID-2 — the person's answer: continue on the new login, or move
 * ------------------------------------------------------------------ */

test('ID-2: "continue on the new login" re-binds the run to the new identity, journals who chose it, and resumes the run', async () => {
  const root = scratch();
  const svc = service(root);
  const real = (svc as unknown as { accounts: unknown }).accounts;
  try {
    const run = haltedOnDefault(root, (state) => {
      state.halt = { at: '2026-09-25T12:17:00.000Z', reason: 'the machine login changed identity', phase: 2, kind: 'identity-changed' };
    });
    (svc as unknown as { accounts: unknown }).accounts = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      identityOf: () => INFO,
    });
    const starts: Record<string, unknown>[] = [];
    (svc as unknown as { startRun: (slug: string, options: Record<string, unknown>) => Promise<RunState> }).startRun =
      async (_slug, options) => { starts.push(options); return loadRun(root, 'alpha', String(options.resumeRunId), null)!; };
    const answer = await (svc as unknown as {
      answerIdentity: (slug: string, choice: string, actor: unknown, accountId?: string) => Promise<{ ok: boolean; reason?: string }>;
    }).answerIdentity('alpha', 'continue', pressActor(PERSON as never));
    assert.equal(answer.ok, true, answer.reason);
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.identity?.key, 'k-info');
    assert.equal(after.halt ?? null, null);
    const accepted = journalOn(root, run.id).filter((line) => line.event === 'run.identity-accepted');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].data?.by, 'operator');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].resumeRunId, run.id);
  } finally {
    (svc as unknown as { accounts: unknown }).accounts = real;
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ID-2: "move to the same-identity profile" switches the run to the registered account that answers the identity it started on, and resumes it there', async () => {
  const root = scratch();
  const svc = service(root);
  const real = (svc as unknown as { accounts: unknown }).accounts;
  try {
    const run = haltedOnDefault(root, (state) => {
      state.halt = { at: '2026-09-25T12:17:00.000Z', reason: 'the machine login changed identity', phase: 2, kind: 'identity-changed' };
    });
    const ids: Record<string, RunIdentity> = {
      default: INFO,
      'account-346a': { account: 'account-346a', key: 'k-admin-profile', email: 'admin@example.com', org: 'The Market' },
    };
    (svc as unknown as { accounts: unknown }).accounts = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      identityOf: (id: string | undefined) => ids[id ?? 'default'],
      accountIds: () => Object.keys(ids),
      has: (id: string) => id in ids,
      labelFor: (id: string | undefined) => id ?? 'the machine login',
    });
    const starts: Record<string, unknown>[] = [];
    (svc as unknown as { startRun: (slug: string, options: Record<string, unknown>) => Promise<RunState> }).startRun =
      async (_slug, options) => { starts.push(options); return loadRun(root, 'alpha', String(options.resumeRunId), null)!; };
    const answer = await (svc as unknown as {
      answerIdentity: (slug: string, choice: string, actor: unknown, accountId?: string) => Promise<{ ok: boolean; reason?: string; accountId?: string }>;
    }).answerIdentity('alpha', 'move', pressActor(PERSON as never));
    assert.equal(answer.ok, true, answer.reason);
    assert.equal(answer.accountId, 'account-346a');
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.accountId, 'account-346a');
    assert.equal(after.identity?.email, 'admin@example.com', 'the same person, on a login that is theirs');
    assert.equal(after.halt ?? null, null);
    assert.equal(starts.length, 1);
  } finally {
    (svc as unknown as { accounts: unknown }).accounts = real;
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
