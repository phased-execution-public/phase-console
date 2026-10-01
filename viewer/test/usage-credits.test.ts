/**
 * Account credits, read (control-tower phase 93, #146) — CR-1, CR-2, CR-6.
 *
 * Both sources of an account's credit state used to be cut down to meters:
 * `parseUsageBody` kept buckets and an org id, and `rate_limit_event` kept the
 * status, window, utilization and reset. The shapes below were READ LIVE on
 * 2026-09-27T22:05Z (machine login, CLI 2.1.283) — the phase 93 handoff
 * records them whole — never guessed.
 *
 *   CR-1  `parseUsageBody` keeps `extra_usage` (minor units to major), the
 *         poller keeps it with each read and a failed read carries it.
 *   CR-2  `rate_limit_event` keeps the CLI's overage fields; the shared meter
 *         carries the credit state, so a follower console sees it.
 *   CR-6  credit spend is visible per account (the view) and per run (booked
 *         from the turns a session ran on credit).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseUsageBody, UsagePoller } = await import('../server/accounts/usage.ts');
const { spawnClaude } = await import('../server/runner/spawn.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { STATE_SANDBOX } = await import('./state-sandbox.ts');
type AccountUsage = import('../server/accounts/usage.ts').AccountUsage;
type StreamEvent = import('../server/runner/spawn.ts').StreamEvent;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type Exec = import('../server/accounts/credentials.ts').Exec;

/** The live `extra_usage` block, verbatim (2026-09-27T22:05Z). */
const LIVE_EXTRA_USAGE = {
  is_enabled: false, monthly_limit: 4000, used_credits: 0, utilization: 0, currency: 'USD', decimal_places: 2,
  disabled_reason: 'out_of_credits', user_disabled: false, spend_limit_reached: false, credits_ever_enabled: true,
  daily: null, weekly: null,
};

/** The live body's shape around it: dollar fields on every window, a `null` reset, the block itself. */
const LIVE_BODY = {
  five_hour: {
    utilization: 100, resets_at: '2026-09-27T22:10:00.100186+00:00',
    limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null,
  },
  seven_day: {
    utilization: 25, resets_at: '2026-10-04T16:00:00.100205+00:00',
    limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null,
  },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  extra_usage: LIVE_EXTRA_USAGE,
};

const exec: Exec = async (file, args) =>
  file === 'claude' && args[0] === '--version' ? { stdout: '2.1.283 (Claude Code)\n' } : { stdout: '' };

/* ------------------------------------------------------------------ *
 * CR-1 — the usage endpoint's credit block survives the parse
 * ------------------------------------------------------------------ */

test('CR-1: parseUsageBody keeps the extra_usage block as the live account sent it — minor units read as major', () => {
  const parsed = parseUsageBody(LIVE_BODY);
  assert.deepEqual(Object.keys(parsed.buckets).sort(), ['five_hour', 'seven_day'], 'the meters are what they were');
  assert.deepEqual(parsed.credits, {
    enabled: false, monthlyLimit: 40, used: 0, currency: 'USD',
    disabledReason: 'out_of_credits', userDisabled: false, spendLimitReached: false,
  });
});

test('CR-1: spend is read in the currency\'s major unit, by the block\'s own decimal places', () => {
  const parsed = parseUsageBody({ extra_usage: { ...LIVE_EXTRA_USAGE, is_enabled: true, disabled_reason: null, used_credits: 1234 } });
  assert.equal(parsed.credits?.enabled, true);
  assert.equal(parsed.credits?.used, 12.34);
  assert.equal(parsed.credits?.monthlyLimit, 40);
  assert.equal(parsed.credits?.disabledReason, undefined, 'a null reason is no reason');
  const yen = parseUsageBody({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 12, currency: 'JPY', decimal_places: 0 } });
  assert.equal(yen.credits?.monthlyLimit, 5000);
  assert.equal(yen.credits?.used, 12);
});

test('CR-1: a body without the block has NO credit state — unknown is never read as off or on', () => {
  assert.equal(parseUsageBody({ five_hour: { utilization: 10, resets_at: '2026-09-27T22:10:00Z' } }).credits, undefined);
  assert.equal(parseUsageBody({ extra_usage: null }).credits, undefined);
  assert.equal(parseUsageBody({ extra_usage: { monthly_limit: 4000 } }).credits, undefined, 'no is_enabled, no verdict');
});

/* ------------------------------------------------------------------ *
 * CR-2 — the CLI's overage fields, and the shared meter
 * ------------------------------------------------------------------ */

/** A stand-in `claude`: one turn off credit, the window rejected with overage allowed, one turn on credit. */
const STUB = `#!/usr/bin/env node
'use strict';
const sid = '11111111-2222-3333-4444-555555555555';
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let heard = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  heard += chunk;
  if (!heard.includes('\\n')) return;
  process.stdin.pause();
  say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [], claude_code_version: '2.1.283' });
  say({ type: 'result', subtype: 'success', session_id: sid, is_error: false, num_turns: 1, result: 'one', total_cost_usd: 0.4 });
  say({ type: 'rate_limit_event', session_id: sid, rate_limit_info: {
    status: 'rejected', resetsAt: 1790547000, rateLimitType: 'five_hour', utilization: 1,
    overageStatus: 'allowed_warning', overageResetsAt: 1791600000, isUsingOverage: true, surpassedThreshold: 0.9 } });
  say({ type: 'result', subtype: 'success', session_id: sid, is_error: false, num_turns: 1, result: 'two', total_cost_usd: 1 });
  process.exit(0);
});
`;

test('CR-2: rate_limit_event keeps the CLI\'s overage fields, and the outcome says where the session went on credit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-credits-'));
  try {
    writeFileSync(join(dir, 'claude'), STUB, 'utf8');
    chmodSync(join(dir, 'claude'), 0o755);
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      onEvent: (event) => events.push(event),
    });
    const limits = events.find((event) => event.kind === 'limits') as Extract<StreamEvent, { kind: 'limits' }> | undefined;
    assert.ok(limits, 'the reading arrived');
    assert.equal(limits.status, 'rejected');
    assert.equal(limits.usingOverage, true);
    assert.equal(limits.overageStatus, 'allowed_warning');
    assert.equal(limits.overageResetsAt, 1791600000);
    assert.equal(limits.overageDisabledReason, undefined);
    assert.equal(outcome.costUsd, 1);
    assert.equal(outcome.creditFromUsd, 0.4, 'the running total when the session went on credit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-2: a refusal names its reason — overageDisabledReason and a rejected overage status are kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-credits-'));
  try {
    writeFileSync(join(dir, 'claude'), STUB.replace(
      "overageStatus: 'allowed_warning', overageResetsAt: 1791600000, isUsingOverage: true",
      "overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false",
    ), 'utf8');
    chmodSync(join(dir, 'claude'), 0o755);
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      onEvent: (event) => events.push(event),
    });
    const limits = events.find((event) => event.kind === 'limits') as Extract<StreamEvent, { kind: 'limits' }>;
    assert.equal(limits.overageStatus, 'rejected');
    assert.equal(limits.overageDisabledReason, 'out_of_credits');
    assert.equal(limits.usingOverage, false);
    assert.equal(outcome.creditFromUsd, undefined, 'no turn ran on credit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


/* ------------------------------------------------------------------ *
 * CR-6 — spend, per account and per run
 * ------------------------------------------------------------------ */

function newAccounts(now: number) {
  return new Accounts({
    platform: 'linux', exec, now: () => now, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    registryDir: mkdtempSync(join(STATE_SANDBOX, 'p93-registry-')),
    learnedFile: join(STATE_SANDBOX, `learned-p93-${Math.random().toString(16).slice(2)}.json`),
  });
}

function plant(accounts: InstanceType<typeof Accounts>, id: string, usage: AccountUsage): void {
  (accounts as unknown as { poller: { cache: Map<string, AccountUsage> } }).poller.cache.set(id, usage);
}

test('CR-6: the account view shows its credits — used, the limit, what remains, and whether a session spends them now', async () => {
  const now = Date.parse('2026-09-27T22:06:00Z');
  const accounts = newAccounts(now);
  plant(accounts, 'default', {
    buckets: { five_hour: { utilization: 100, resetsAt: '2026-09-27T23:10:00Z' } },
    fetchedAt: '2026-09-27T22:05:50Z',
    credits: { enabled: true, monthlyLimit: 40, used: 12.34, currency: 'USD' },
  });
  let view = (await accounts.list()).find((row) => row.id === 'default');
  assert.equal(view?.credits?.allowed, false, 'off until the operator says otherwise');
  assert.equal(view?.credits?.available, true);
  assert.equal(view?.credits?.used, 12.34);
  assert.equal(view?.credits?.limit, 40);
  assert.equal(view?.credits?.remaining, 27.66);
  assert.equal(view?.credits?.currency, 'USD');
  assert.equal(view?.credits?.onCredit, false);

  accounts.noteSessionCredit('default', { usingOverage: true, overageStatus: 'allowed' });
  view = (await accounts.list()).find((row) => row.id === 'default');
  assert.equal(view?.credits?.onCredit, true, 'a live session is spending credit right now');

  plant(accounts, 'default', { buckets: {}, fetchedAt: '2026-09-27T22:05:50Z' });
  view = (await accounts.list()).find((row) => row.id === 'default');
  assert.equal(view?.credits?.available, null, 'a read that did not say is unknown');
  assert.match(view?.credits?.reason ?? '', /credit state unknown/);
});

function stubRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pc-credits-run-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const write = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${state}"
case "\${2:-}" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase \${3:-1} of $1" ;;
  --size) echo M ;;
  *) exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(state, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('CR-6: a run books what its sessions spent ON CREDIT, per phase and for the run — the turns after the session went on credit', async () => {
  const r = stubRepo();
  const spawn: SpawnFn = async () => {
    r.markDone();
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-credit', costUsd: 1, costSource: 'result',
      creditFromUsd: 0.4, turns: 2, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    } satisfies SpawnOutcome;
  };
  const instance = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.spentUsd, 1, 'the whole spawn is still booked as spend');
    assert.equal(Math.round((state.creditUsd ?? 0) * 100) / 100, 0.6, 'of which 0.60 ran on credit');
    assert.equal(Math.round((state.phases['1'].creditUsd ?? 0) * 100) / 100, 0.6, 'and the phase says so too');
  } finally {
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});
