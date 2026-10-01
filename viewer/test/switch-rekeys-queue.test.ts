/**
 * A switch re-keys the queue (control-tower phase 78, #92).
 *
 * An operator moved two runs off a walled account, and every phase already
 * queued behind that account's usage window stayed queued: the run record
 * named the new account, `/api/queue` still showed each entry held by
 * `usage window · account <old>`, and nothing boarded until the OLD window
 * reset — days, for a weekly wall. Retry reset the phase record and left the
 * entry as it was. The entries had frozen the account they were requested
 * under, and the switch never told the scheduler.
 *
 * SW-1  every switch re-keys the run's queued entries to the new account,
 *       keeping their age and place, and the scheduler re-polls at once
 * SW-2  Retry on a queued phase re-requests it under the run's current account
 * SW-3  the queue view names each entry's account
 * (SW-4/SW-5 — a closing lane is not checkpointed, `when: 'boundary'` — are in
 * `press-does-what-it-says.test.ts`; the onLimit face of SW-1 is in
 * `usage-brake.test.ts`; the scheduler's own half in `scheduler.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Runner } = await import('../server/runner/runner.ts');
const { BRAKE_HOLDER, Scheduler } = await import('../server/runner/scheduler.ts');
type RunState = import('../server/runner/state.ts').RunState;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type Scheduler = import('../server/runner/scheduler.ts').Scheduler;
type LeaveReason = import('../server/accounts/index.ts').LeaveReason;
type LeaveResult = import('../server/accounts/index.ts').LeaveResult;

const PERSON = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;
const HOUR = 3_600_000;

/* ------------------------------------------------------------------ *
 * A runner over stub scripts — the shape `runner.test.ts` uses
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * A two-phase plan; each phase rides its own repository (`repo-N`). Linear by
 * default; `parallel` makes both ready at once.
 */
function repo(parallel = false): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-rekey-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  if (parallel) writeFileSync(join(state, 'parallel'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""; w=""; found=0
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ] || [ -f "$S/parallel" ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --repos) echo "repo-$arg" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
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

type Spawned = { phase: number; token: string | undefined; grants: (string | undefined)[] };

/**
 * A session that marks its phase done — and remembers, at the moment it was
 * spawned, which account it ran as and which accounts the scheduler's grants
 * were counted against.
 */
function recordingSession(r: Repo, scheduler: Scheduler, spawned: Spawned[]): SpawnFn {
  return async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    spawned.push({
      phase,
      token: request.env?.CLAUDE_CODE_OAUTH_TOKEN,
      grants: scheduler.snapshot().grants.map((grant) => grant.accountId),
    });
    r.markDone(phase);
    return ok({ sessionId: `sess-${phase}` });
  };
}

function runner(r: Repo, spawn: SpawnFn, scheduler: Scheduler, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    // Each account runs as its own token, so a spawn says which one it paid with.
    accountEnv: async (accountId) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null),
    ...extra,
  });
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** Resolve when `probe` holds, or fail naming what never happened. */
async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The run's one queued entry, as the queue page reads it. */
function queuedEntry(scheduler: Scheduler, runId: string) {
  return scheduler.snapshot().entries.find((entry) => entry.runId === runId);
}

/* ------------------------------------------------------------------ *
 * SW-1 — the operator's switch re-keys what is queued (#92)
 * ------------------------------------------------------------------ */

test('SW-1: a phase queued behind the old account\'s usage window boards on the new account the moment a person switches — not at the old reset', async () => {
  const r = repo();
  const scheduler = new Scheduler({ locks: () => [] });
  const spawned: Spawned[] = [];
  // `acct-old` is walled for an hour: the run's first phase queues behind it.
  scheduler.throttle(Date.now() + HOUR, 'acct-old', 'five_hour');
  const { instance, events } = runner(r, recordingSession(r, scheduler, spawned), scheduler);
  try {
    const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-old' });
    await until(() => queuedEntry(scheduler, started.id) !== undefined, 'phase 1 to queue');
    const entry = queuedEntry(scheduler, started.id)!;
    assert.equal(entry.waitingOn[0]?.slug, 'usage window');
    assert.equal(entry.waitingOn[0]?.owner, 'account acct-old');
    assert.equal(entry.accountId, 'acct-old', 'SW-3: the entry names the account it would spend');
    assert.equal(spawned.length, 0, 'nothing boards on a walled account');

    const out = instance.switchAccount('acct-new', PERSON as never);
    assert.equal(out.ok, true);
    await until(() => spawned.length >= 1, 'phase 1 to board on the new account');
    assert.equal(spawned[0].phase, 1);
    assert.equal(spawned[0].token, 'tok-acct-new', 'it ran as the account the person chose');
    assert.deepEqual(spawned[0].grants, ['acct-new'], 'and its lane is counted against it, not the account it left');
    await instance.wait();

    const switched = journalled(events, 'run.account-switch');
    assert.equal(switched.length, 1);
    assert.equal(switched[0].rekeyed, 1, 'the switch says how many queued entries it moved');
    // The wait is ONE wait: the entry kept the age it had when it first queued.
    const admitted = journalled(events, 'phase.admitted').find((line) => (line.waitedMs as number) >= 0);
    assert.ok(admitted, 'phase 1 was admitted');
    const queued = events.filter((e) => e.event === 'run:journal' && e.data.event === 'phase.queued');
    assert.equal(queued.length, 1, 'it queued once — the re-key is not a second queueing');
    assert.equal(instance.current()!.status, 'finished');
  } finally {
    if (instance.busy()) await instance.stop();
    scheduler.close();
    r.cleanup();
  }
});

test('SW-1: the on-limit switch re-keys what is queued too — a phase held by the old account\'s brake boards on the new account at the wall, not when the lane ends', async () => {
  const r = repo(true);
  const scheduler = new Scheduler({ locks: () => [] });
  // `acct-old` is nearly spent: its brake admits no second lane while one is live.
  scheduler.brake('acct-old', { untilMs: null, pct: 96 });
  const resetS = Math.floor((Date.now() + HOUR) / 1000);
  const log: { phase: number; token: string | undefined; grant: string | undefined }[] = [];
  let boarded2: () => void = () => {};
  const phase2Boarded = new Promise<'boarded'>((resolve) => { boarded2 = () => resolve('boarded'); });
  let resumed: 'boarded' | 'timeout' | null = null;
  let walls = 0;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    const runId = instance.current()?.id;
    const own = scheduler.snapshot().grants.find((grant) => grant.runId === runId && grant.phase === phase);
    log.push({ phase, token: request.env?.CLAUDE_CODE_OAUTH_TOKEN, grant: own?.accountId ?? 'default' });
    if (phase === 1 && walls === 0) {
      walls += 1;
      await until(() => scheduler.snapshot().entries.some((entry) => entry.phase === 2 && entry.waitingOn[0]?.slug === BRAKE_HOLDER),
        'phase 2 to queue behind the brake');
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${resetS}` }, sessionId: 'sess-1' });
    }
    if (phase === 1) {
      // The resumed attempt holds until phase 2 has boarded — or gives up.
      resumed = await Promise.race([phase2Boarded, new Promise<'timeout'>((resolve) => setTimeout(resolve, 3_000, 'timeout'))]);
    }
    if (phase === 2) boarded2();
    r.markDone(phase);
    return ok({ sessionId: `sess-${phase}` });
  };
  const leave = (accountId: string | undefined, leaving: LeaveReason): LeaveResult => {
    const untilIso = (leaving.resetsAt ?? new Date(Date.now() + HOUR)).toISOString();
    return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until: untilIso, throttleUntilMs: Date.parse(untilIso) };
  };
  const { instance } = runner(r, spawn, scheduler, {
    maxParallel: 2,
    // Disjoint scopes, so the two lanes may run side by side.
    phaseScope: (_slug, phase) => [`repo-${phase}`],
    pickAccount: () => 'spare',
    rankAccounts: () => ['spare'],
    switchCandidates: () => ({ ranked: ['spare'], declined: [], wake: null }),
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-old', onLimit: 'switch', maxParallel: 2 });
    const settled = await Promise.race([instance.wait().then(() => 'finished'), new Promise((resolve) => setTimeout(resolve, 8_000, 'stuck'))]);
    assert.equal(settled, 'finished', 'phase 2 was never admitted');
    const second = log.find((row) => row.phase === 2)!;
    assert.equal(second.token, 'tok-spare');
    assert.equal(second.grant, 'spare', 'its lane is counted against the account that pays for it');
    assert.equal(resumed, 'boarded', 'phase 2 boarded while phase 1 was still working — at the switch, not after it');
    assert.equal(instance.current()!.accountId, 'spare');
  } finally {
    if (instance.busy()) await instance.stop();
    scheduler.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SW-2 — Retry on a queued phase re-requests under the current account
 * ------------------------------------------------------------------ */

test('SW-2: Retry on a queued phase re-requests it under the run\'s CURRENT account — a record reset alone left it held (#92)', async () => {
  const r = repo();
  const scheduler = new Scheduler({ locks: () => [] });
  const spawned: Spawned[] = [];
  scheduler.throttle(Date.now() + HOUR, 'acct-old', 'five_hour');
  const { instance } = runner(r, recordingSession(r, scheduler, spawned), scheduler);
  try {
    const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-old' });
    await until(() => queuedEntry(scheduler, started.id) !== undefined, 'phase 1 to queue');
    const since = queuedEntry(scheduler, started.id)!.since;
    // The run's account moved on without its queue (a switch an older console
    // made, a Continue that named another account): the entry still names the old.
    (instance.current() as RunState).accountId = 'acct-new';
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(queuedEntry(scheduler, started.id)?.accountId, 'acct-old', 'nothing re-keys by itself');
    assert.equal(spawned.length, 0);

    instance.retry(1, undefined, { press: true });
    await until(() => spawned.length >= 1, 'the retried phase to board');
    assert.equal(spawned[0].token, 'tok-acct-new');
    assert.deepEqual(spawned[0].grants, ['acct-new']);
    assert.ok(since <= Date.now(), 'the entry that boarded was the one that had been waiting');
    await instance.wait();
    assert.equal(instance.current()!.status, 'finished');
  } finally {
    if (instance.busy()) await instance.stop();
    scheduler.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SW-3 — the queue view names each entry's account
 * ------------------------------------------------------------------ */

test('SW-3: the queue view names every waiting entry\'s account — the machine login by name, never an absent field', async () => {
  const scheduler = new Scheduler({ locks: () => [] });
  try {
    // A live grant on each scope, so both entries wait.
    const holdA = await scheduler.admit({ slug: 'other', phase: 1, runId: 'run-x', scope: ['a'] });
    const holdB = await scheduler.admit({ slug: 'other', phase: 2, runId: 'run-x', scope: ['b'] });
    const paid = scheduler.admit({ slug: 'demo', phase: 3, runId: 'run-1', scope: ['a'], accountId: 'acct-7' });
    const machine = scheduler.admit({ slug: 'demo', phase: 4, runId: 'run-1', scope: ['b'] });
    await new Promise((resolve) => setImmediate(resolve));
    const entries = scheduler.snapshot().entries;
    assert.deepEqual(entries.map((entry) => [entry.phase, entry.accountId]), [[3, 'acct-7'], [4, 'default']]);
    scheduler.release(holdA);
    scheduler.release(holdB);
    scheduler.release(await paid);
    scheduler.release(await machine);
  } finally { scheduler.close(); }
});
