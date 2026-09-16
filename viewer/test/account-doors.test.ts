/**
 * The account on every start door (zero-touch-console phase 8, ACT-1/ACT-2).
 *
 * Twelve automatic `startRun` doors, and nine of them passed no `accountId` —
 * so the quota door judged the machine login while the runner resumed the
 * stored run under `state.accountId`, wrong in both directions. The fix is ONE
 * resolver in `Service.startRun`: an explicit option is an override, a resume
 * without one keeps the stored run's account, a fresh start without one is the
 * machine login. Every door passes through it, so this suite proves the
 * resolver and `test/invariants.test.ts` holds every site to naming an account
 * or a stored run.
 *
 * And the quota door itself no longer lives in the service as an exception:
 * `preflightAccount` answers a VERDICT the runner climbs on, so the service's
 * `startRun` never throws over a spent window again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-account-doors-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, saveRun } = await import('../server/runner/state.ts');
const { doorActor, pressActor } = await import('../server/actor.ts');
const { PreludeRefusal } = await import('../server/prelude.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — api
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-account-doors-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** Replace the plan's runner with a recorder: `start` captures its options and answers a settled run. */
function recordStarts(svc: ReturnType<typeof service>): Record<string, unknown>[] {
  const starts: Record<string, unknown>[] = [];
  const runner = svc.runnerFor('alpha');
  (runner as unknown as { start: (options: Record<string, unknown>) => Promise<unknown> }).start =
    async (options) => {
      starts.push(options);
      const state = newRun({ slug: 'alpha', root: options.root as string, ...(options.accountId ? { accountId: options.accountId as string } : {}) });
      state.status = 'finished';
      return state;
    };
  return starts;
}

function storedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root, ...over });
  state.status = 'paused';
  saveRun(state);
  return state;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

test('ACT-1: a stored run with accountId p, resumed with no account named, reaches the runner as p — whichever door resumed it', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const starts = recordStarts(svc);
    const stored = storedRun(root, { accountId: 'p' });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: stored.id, actor: doorActor('converge-relaunch', { by: 'converge', via: 'timer', origin: 'test' }) });
    assert.equal(starts.length, 1);
    assert.equal(starts[0].accountId, 'p', 'the stored run\'s account, resolved by the service before any door is asked');
    svc.close();
  } finally { cleanup(); }
});

test('ACT-1: an explicit accountId is an override on a resume; a fresh start names nothing and means the machine login', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const starts = recordStarts(svc);
    const stored = storedRun(root, { accountId: 'p' });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: stored.id, accountId: 'q', actor: doorActor('wait-clock', { by: 'console', via: 'timer', origin: 'test' }) });
    assert.equal(starts[0].accountId, 'q', 'the option wins over the stored run');
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: doorActor('boot-readopt', { by: 'console', via: 'boot', origin: 'test' }) });
    assert.equal(starts[1].accountId, undefined, 'a fresh start with no account is the machine login, by design');
    // A stored run WITHOUT an account resumed without one stays on the machine login.
    const plain = storedRun(root);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: plain.id, actor: doorActor('wait-clock', { by: 'console', via: 'timer', origin: 'test' }) });
    assert.equal(starts[2].accountId, undefined);
    svc.close();
  } finally { cleanup(); }
});

test('ACT-2: the service\'s quota door is a verdict, not an exception — a spent window no longer makes startRun throw', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const starts = recordStarts(svc);
    // The machine login walled until tomorrow, machine-wide.
    svc.accounts.markLimited('default', 'five_hour', new Date(Date.now() + 24 * 3_600_000).toISOString());
    const verdict = (svc as unknown as { preflightAccount: (id?: string) => { ok: boolean; reason?: string } }).preflightAccount(undefined);
    assert.equal(verdict.ok, false, 'the verdict says so');
    assert.match(verdict.reason ?? '', /hit its usage limit/);
    // A FRESH start is the person's door, and the prelude answers there
    // (phase 11, ZTD-2): every declared account unusable is a 409 with the
    // row named, before a run exists — not a run that parks a second later.
    await assert.rejects(
      () => svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: pressActor({ by: 'operator', via: 'api', origin: 'test', remoteUser: null }) }),
      (error: unknown) => error instanceof PreludeRefusal
        && error.unanswered.some((b) => b.key === 'accounts' && /hit its usage limit/.test(b.why)),
    );
    assert.equal(starts.length, 0, 'the runner was never asked');
    // …and every AUTOMATIC door resumes a stored run, which skips the prelude:
    // `startRun` hands the runner the run regardless, and the RUNNER climbs
    // or parks on the verdict, where the run exists to be switched or parked.
    const stored = storedRun(root);
    let threw: unknown = null;
    try {
      await svc.startRun('alpha', { resumeRunId: stored.id, actor: doorActor('outcome-inbox', { by: 'unsupervised', via: 'event', origin: 'test' }) });
    } catch (error) { threw = error; }
    assert.equal(threw, null, 'no exception — the nine automatic doors used to swallow one into a log.warn');
    assert.equal(starts.length, 1);
    svc.accounts.markLimited('default', 'five_hour', new Date(Date.now() - 1_000).toISOString());
    svc.close();
  } finally { cleanup(); }
});

test('phase 15: the one-turn account check is a PRESS — never refused or counted by the start ceiling, its spend still charged, and behind --allow-accounts', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const asked: { id: string; actor: Record<string, unknown> }[] = [];
    const account = (await svc.listAccounts())[0];
    svc.accounts.probeEntitlement = (async (id: string, opts: { actor: Record<string, unknown> }) => {
      asked.push({ id, actor: opts.actor });
      return {
        account, spent: true,
        probe: { at: new Date().toISOString(), status: 'ok', reason: 'answered', by: String(opts.actor.by), costUsd: 0.25, count: 1 },
      };
    }) as typeof svc.accounts.probeEntitlement;
    const person = { by: 'operator', via: 'api' as const, origin: 'local', remoteUser: null };

    // The flag first: registration-class, like the clearance beside it.
    await assert.rejects(() => svc.probeAccountEntitlement('default', person), /--allow-accounts/);
    assert.equal(asked.length, 0);

    (svc.flags as { allowAccounts: boolean }).allowAccounts = true;
    const before = svc.startCeiling.admit(person);
    const out = await svc.probeAccountEntitlement('default', person);
    assert.equal(out?.probe.status, 'ok');
    assert.deepEqual(asked[0], { id: 'default', actor: { ...person, door: 'operator', trigger: 'entitlement-probe' } }, 'the press door, with the check named as its trigger');
    const after = svc.startCeiling.admit(person);
    assert.equal(after.ok && before.ok ? after.starts - before.starts : null, 0, 'a press is never counted as an automatic start');
    assert.equal(after.ok && before.ok ? Math.round((after.usd - before.usd) * 100) / 100 : null, 0.25, 'but what the session spent reaches the ceiling\'s dollars');
    assert.equal(await svc.probeAccountEntitlement('nobody', person), undefined);
    svc.close();
  } finally { cleanup(); }
});
