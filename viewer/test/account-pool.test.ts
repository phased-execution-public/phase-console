/**
 * A failover stays in its pool (control-tower phase 53, #55).
 *
 * The run that raised #55 declared three accounts and failed over at
 * preflight onto a fourth nobody had named, with `tried: []` — the pool it
 * had never asked. The pool is the run's `accounts` rows (`accountPool`), and
 * every failover ranks inside it (`rankInPool`):
 *
 * AP-1  the rank's outsider is never the target — the pool's member is
 * AP-2  the login probe is asked only of pool members, the ranked ones first
 * AP-3  a spent pool parks with an errand naming the pool, and the run stays put
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { accountPool, rankInPool } = await import('../server/runner/state.ts');
const { RESET_MARGIN_MS } = await import('../server/runner/errors.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;

/* ------------------------------------------------------------------ *
 * A runner over stub scripts — the shape `runner.test.ts` uses
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-pool-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  // A linear 2-phase graph: phase N is ready once every earlier phase is done.
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

/** A session that does what it was asked — marks its phase done — and counts itself. */
function workingSession(r: Repo, seen: number[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    seen.push(phase);
    r.markDone(phase);
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: `sess-${phase}`, costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    };
  };
}

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

/** A `HeadroomVerdict` stub: the `spent` accounts refuse with a reset an hour off, the rest pass. */
function headroom(spent: string[], asked: (string | undefined)[] = []) {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  return (accountId: string | undefined, _model?: string) => {
    const id = accountId ?? 'default';
    asked.push(id);
    if (spent.includes(id)) {
      return {
        ok: false as const, accountId: id, kind: 'spent' as const, resetsAt,
        reason: `${id} has 0% of its 5-hour window left (resets ${resetsAt}).`,
      };
    }
    return { ok: true as const, accountId: id, fiveHourPct: 10 };
  };
}

/** What the facade answers when the run walks away from a spent window. */
function leave(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  const until = (leaving.resetsAt ?? new Date(Date.now() + 1_800_000)).toISOString();
  return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until, throttleUntilMs: Date.parse(until) };
}

const POOL = [{ id: 'work', minHeadroomPct: 20 }, { id: 'spare', minHeadroomPct: 20 }];

/* ------------------------------------------------------------------ *
 * The pure half
 * ------------------------------------------------------------------ */

test('the pool is the run\'s accounts rows, and failover ranks inside it — never outside, never the account being left', () => {
  assert.equal(accountPool({}), null, 'no rows: no pool, and failover ranks as it always did');
  assert.deepEqual(accountPool({ accounts: [...POOL, { id: 'work', minHeadroomPct: 50 }] }), ['work', 'spare']);
  assert.deepEqual(rankInPool(['outsider', 'spare'], null, 'work'), ['outsider', 'spare'], 'no pool: the rank, untouched');
  assert.deepEqual(rankInPool(['outsider', 'spare'], ['work', 'spare'], 'work'), ['spare']);
  // The pool's members the rank left out (cooling, walled, signed out) are
  // still asked, after the ranked ones, so the errand can say why each failed.
  assert.deepEqual(rankInPool(['outsider', 'third'], ['work', 'spare', 'third'], 'work'), ['third', 'spare']);
});

/* ------------------------------------------------------------------ *
 * AP-1..3 — the preflight door
 * ------------------------------------------------------------------ */

test('AP-1: a spent account fails over to the pool\'s member, never the rank\'s outsider, and the switch names the pool', async () => {
  const r = repo();
  try {
    const seen: number[] = [];
    const { instance, events } = runner(r, workingSession(r, seen), {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountHeadroom: headroom(['work']),
      // The rank prefers an account the run never named.
      rankAccounts: (excluding) => ['outsider', 'spare'].filter((id) => id !== excluding),
      leaveAccount: leave,
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'finished');
    assert.equal(state.accountId, 'spare', 'the pool\'s member took the run');
    assert.deepEqual(seen, [1, 2]);
    const switched = journalled(events, 'run.account-switched');
    assert.equal(switched.length, 1);
    assert.equal(switched[0].to, 'spare');
    assert.equal(switched[0].at, 'preflight');
    assert.deepEqual(switched[0].pool, ['work', 'spare'], 'the switch names the pool it stayed in');
  } finally { r.cleanup(); }
});

test('AP-2: the login probe is asked only of pool members — the ranked ones first, then the rest of the pool', async () => {
  const r = repo();
  try {
    const probed: string[] = [];
    const signedIn = new Set(['spare', 'outsider']);
    const { instance, events } = runner(r, workingSession(r, []), {
      checkAuth: async (accountId) => {
        const id = accountId ?? 'default';
        probed.push(id);
        return { loggedIn: signedIn.has(id), checkedAt: '', ...(signedIn.has(id) ? {} : { detail: `${id} is signed out` }) };
      },
      accountHeadroom: headroom([]),
      // The rank left `spare` out (say it was cooling) and put an outsider first.
      rankAccounts: (excluding) => ['outsider', 'third'].filter((id) => id !== excluding),
    });
    await instance.start({
      slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work',
      accounts: [...POOL, { id: 'third', minHeadroomPct: 20 }],
    });
    await instance.wait();
    assert.equal(instance.current()!.accountId, 'spare');
    assert.equal(probed.includes('outsider'), false, 'an account outside the pool is never probed');
    assert.deepEqual(probed.slice(0, 3), ['work', 'third', 'spare'], 'the run\'s own, then the ranked member, then the rest of the pool');
    const switched = journalled(events, 'run.account-switched');
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0].tried, ['switch-account → third: not signed in']);
  } finally { r.cleanup(); }
});

test('AP-3: with the pool spent the run parks with an errand naming the pool — it never leaves the pool by itself', async () => {
  const r = repo();
  try {
    const seen: number[] = [];
    const asked: (string | undefined)[] = [];
    const { instance, events } = runner(r, workingSession(r, seen), {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountHeadroom: headroom(['work', 'spare'], asked),
      // An outsider with all the headroom in the world.
      rankAccounts: (excluding) => ['outsider'].filter((id) => id !== excluding),
      leaveAccount: leave,
    });
    const parked = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL });
    assert.equal(parked.status, 'parked');
    assert.equal(parked.halt?.kind, 'run-preflight');
    assert.equal(parked.accountId, 'work', 'the run stays on the account it was on');
    assert.equal(seen.length, 0, 'nothing spawned behind the refusal');
    assert.match(parked.errand?.need ?? '', /pool \(work, spare\)/, 'the errand names the pool');
    assert.match(parked.errand?.how ?? '', /outside the pool adds it to the pool/, 'and how to widen it');
    assert.equal(parked.errand?.tried?.length, 1, 'the pool\'s one other member was asked, and only it');
    assert.match(parked.errand!.tried![0], /^switch-account → spare: spare has 0% of its 5-hour window left/);
    assert.equal(asked.includes('outsider'), false, 'the outsider is never even asked for headroom');
    assert.equal(journalled(events, 'run.account-switched').length, 0);
    const refused = journalled(events, 'run.preflight-refused');
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0].pool, ['work', 'spare']);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * AP-4 — the headroom-aware picker stays in the pool (control-tower phase 78)
 * ------------------------------------------------------------------ */

test('AP-4: at a mid-phase wall the headroom-aware picker is asked WITH the pool and the wall\'s reset, and an outsider it ranks is still never taken', async () => {
  const r = repo();
  try {
    const asked: { pool: readonly string[] | null | undefined; until: number | null | undefined }[] = [];
    const reset = Math.floor((Date.now() + 2 * 3_600_000) / 1000);
    let calls = 0;
    const { instance } = runner(r, async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${reset}` },
          sessionId: 'sess-wall', costUsd: 0.01, turns: 1, resultText: '', durationMs: 5, argv: ['-p', '<prompt>'],
        };
      }
      r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1'));
      return {
        signal: { subtype: 'success', code: 0, text: '' },
        sessionId: 'sess-wall', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
      };
    }, {
      switchCandidates: (_excluding, _model, opts) => {
        asked.push({ pool: opts.pool, until: opts.until });
        return { ranked: ['outsider', 'spare'], declined: [], wake: null };
      },
      portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
      leaveAccount: leave,
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL, onLimit: 'switch' });
    await instance.wait();
    assert.equal(instance.current()!.accountId, 'spare', 'the pool\'s member, never the outsider');
    assert.deepEqual(asked[0]?.pool, ['work', 'spare']);
    assert.equal(asked[0]?.until, reset * 1000 + RESET_MARGIN_MS, 'weighed against the wall\'s own reset (and its margin)');
  } finally { r.cleanup(); }
});
