/**
 * Edits to a run nobody is driving, and the account seam underneath them (#22).
 *
 * On 2026-09-21 the operator re-registered a profile and moved two running
 * autopilot runs onto it. One move went through a live runner and was
 * journalled; the other took the stored-run branch, which set `accountId` and
 * returned — no journal line, no `accounts` manifest update, no `by`/`via`. The
 * record that came out of it names one account in one field and another in the
 * next, and nothing in its history can explain either.
 *
 * Two neighbours in the same path were as bad: removing an account deleted the
 * profile's config directory with no check that a live session's
 * `CLAUDE_CONFIG_DIR` pointed at it, and re-creating one re-minted the same
 * readable id — so a run record saying `accountId: "account"` named a path,
 * not a credential.
 *
 * SE-1..SE-3, one per ask.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { AccountStore, profileConfigDir } = await import('../server/accounts/store.ts');
type RunState = import('../server/runner/state.ts').RunState;
type SessionView = import('../server/sessions/registry.ts').SessionView;

const PLAN = `---
slug: alpha
created: 2026-09-22
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

### Phase 2 — cart api
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-stored-edit-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    allowAccounts: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** A parked run with no loop behind it — the branch #22 is about. */
function storedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.activePhase = 2;
  state.accounts = [{ id: 'default', minHeadroomPct: 15 }];
  phaseRecord(state, 2).status = 'parked';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

const PRESS = {
  by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null,
} as const;

test('SE-1: a stored-run account switch is journalled, and the active id joins the manifest', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    const outcome = svc.switchAccountRun('alpha', 'acct-b', PRESS as never);
    assert.equal(outcome.ok, true, outcome.reason);

    const after = JSON.parse(readFileSync(runFile(root, 'alpha', run.id), 'utf8')) as RunState;
    assert.equal(after.accountId, 'acct-b');
    assert.ok(
      after.accounts?.some((row) => row.id === 'acct-b'),
      'the record names an account its own manifest does not list — the two fields disagree',
    );

    const journal = readFileSync(journalFile(root, 'alpha', run.id), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
    const switched = journal.find((line) => line.event === 'run.account-switch');
    assert.ok(switched, 'the move left no line in the run\'s own history');
    assert.equal(switched!.data?.from, 'default');
    assert.equal(switched!.data?.to, 'acct-b');
    assert.equal(switched!.data?.checkpointed, null, 'no lane held a pid: `null`, not a count of zero');
    assert.equal(switched!.data?.by, 'operator');
    assert.equal(switched!.data?.via, 'api');
    assert.equal(switched!.data?.origin, '127.0.0.1');
  } finally {
    svc.close();
  }
});

test('SE-1: moving a stored run back to the machine login is journalled too', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root, { accountId: 'acct-b', accounts: [{ id: 'acct-b', minHeadroomPct: 20 }] });
    assert.equal(svc.switchAccountRun('alpha', 'default', PRESS as never).ok, true);
    const journal = readFileSync(journalFile(root, 'alpha', run.id), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
    const switched = journal.find((line) => line.event === 'run.account-switch');
    assert.ok(switched, 'a move BACK to the default is still a move');
    assert.equal(switched!.data?.from, 'acct-b');
    assert.equal(switched!.data?.to, 'default');
  } finally {
    svc.close();
  }
});

test('SE-2: an account a live session is signed into cannot be removed under it', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const accounts = (svc as unknown as {
      accounts: { dir: string; store: InstanceType<typeof AccountStore> };
    }).accounts;
    const id = 'account';
    // A registered profile, and a live session whose CLAUDE_CONFIG_DIR is its
    // config directory — the exact shape that lost a session's transcripts.
    accounts.store.add({ id, kind: 'profile', name: 'account', createdAt: new Date().toISOString() });
    const dir = profileConfigDir(id, accounts.dir);
    (svc as unknown as { sessionViews(): SessionView[] }).sessionViews =
      () => ([{ sessionId: 'sess-live', kind: 'agent', presence: 'live', configDir: dir } as unknown as SessionView]);

    await assert.rejects(
      () => svc.removeAccount(id),
      (error: Error) => {
        assert.match(error.message, /sess-live|1 live session|signed in/i,
          'the refusal does not name what is holding the account');
        assert.equal((error as { status?: number }).status, 409);
        return true;
      },
      'the profile\'s config directory was deleted under a session that is using it',
    );
  } finally {
    svc.close();
  }
});

test('SE-3: a re-created profile never reuses a removed one\'s id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-account-ids-'));
  const store = new AccountStore(dir);
  const first = store.newId('account');
  store.add({ id: first, kind: 'profile', name: 'account', createdAt: new Date().toISOString() });
  store.remove(first);

  const second = store.newId('account');
  assert.notEqual(
    second, first,
    'the new profile took the removed one\'s id — and its directory path — so a run record '
    + 'naming it cannot tell the two credentials apart',
  );

  // Across a restart, too: the refusal has to be on disk, not in memory.
  const reopened = new AccountStore(dir);
  assert.notEqual(reopened.newId('account'), first);
});

test('SE-4: a settings patch on a stored run is journalled on that run, with who asked (control-tower phase 77, #101)', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root, { resumeOnRestart: false, relay: 'off' });
    const edited = svc.configureRun('alpha', { resumeOnRestart: true, relay: 'last-resort' }, 'operator');
    assert.equal(edited?.resumeOnRestart, true);
    const after = JSON.parse(readFileSync(runFile(root, 'alpha', run.id), 'utf8')) as RunState;
    assert.equal(after.resumeOnRestart, true, 'the answer the next restart reads');
    assert.equal(after.relay, 'last-resort');
    const journal = readFileSync(journalFile(root, 'alpha', run.id), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
    const line = journal.find((entry) => entry.event === 'run.reconfigured');
    assert.ok(line, 'the edit left no line in the run\'s own history');
    assert.equal((line!.data?.patch as Record<string, unknown>)?.resumeOnRestart, true);
    assert.equal(line!.data?.stored, true);
    assert.equal(line!.data?.by, 'operator');
  } finally {
    svc.close();
  }
});

test('SE-5: journalStoredEdit inherits the reason the request gave (control-tower phase 96, #142)', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    const why = 'moving the run onto the profile whose credit covers the weekly limit';
    assert.equal(svc.switchAccountRun('alpha', 'acct-b', { ...PRESS, reason: why } as never).ok, true);
    const journal = readFileSync(journalFile(root, 'alpha', run.id), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
    assert.equal(journal.find((line) => line.event === 'run.account-switch')?.data?.reason, why);
    // …and an edit given no reason writes no key.
    svc.switchAccountRun('alpha', 'default', PRESS as never);
    const back = readFileSync(journalFile(root, 'alpha', run.id), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> })
      .filter((line) => line.event === 'run.account-switch').at(-1);
    assert.equal('reason' in (back?.data ?? {}), false);
  } finally {
    svc.close();
  }
});
