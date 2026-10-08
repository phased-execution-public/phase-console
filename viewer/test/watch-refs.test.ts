/**
 * Watch refs — the pure half: which declared refs the console will poll, and
 * what counts as a landing. The `gh` half is deliberately not run here — tests
 * never shell out — so the parse and the verdict predicates carry the contract
 * for those two schemes.
 *
 * The three schemes added in 2026-08-30 (`date:`, `lock:`, `cmd:`), the
 * scheduler that polls them and the `cmd:` execution gate live in
 * `the-clock-is-evidence.test.ts` beside the rest of that phase's proofs.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CMD_RUNS_PER_PHASE, WATCH_CMD_BACKOFF_MS, WATCH_CMD_GH_MS, WATCH_POLL_MS, cmdBackoffAfterMs, cmdStepMs, cmdWrapsGh, declaredWindowOf,
  nextDueFor, parseWatchRef, pollableRefs, prLanded, runLanded,
} from '../server/watch-refs.ts';
import {
  BUDGET_FREE_SCHEMES, DEFAULT_WAIT_BUDGET_MS, evaluateWait, openWaitEntry, parkedMsOf, spendsWaitBudget, waitBudgetEndOf,
} from '../server/runner/wait-budget.ts';
import type { PhaseRecord } from '../server/runner/state.ts';

test('the gh shapes parse, and a malformed one stays unpollable rather than guessed at', () => {
  assert.deepEqual(parseWatchRef('gh:acme/app#run/33123610977'), {
    kind: 'gh-run', repo: 'acme/app', id: '33123610977', ref: 'gh:acme/app#run/33123610977',
  });
  assert.deepEqual(parseWatchRef('gh:acme/web-admin#pr/77'), {
    kind: 'gh-pr', repo: 'acme/web-admin', number: '77', ref: 'gh:acme/web-admin#pr/77',
  });
  // `url:` is still another subsystem's. `cmd:` and `lock:` USED to be here —
  // this module refused to run a recorded shell string on a timer, and could
  // not see a lock at all. Both are now schemes of their own; what changed is
  // not the judgement about executing a session's command but the machinery
  // (`verify.ts`'s read-only policy, and an operator switch). See
  // `the-clock-is-evidence.test.ts`.
  assert.equal(parseWatchRef('url:https://ci.example.com/build/9'), null);
  assert.equal(parseWatchRef('gh:acme#run/1'), null, 'no repo half');
  assert.equal(parseWatchRef('gh:acme/app#run/abc'), null, 'a run id is digits');
  assert.equal(parseWatchRef('gh:acme/app#job/12'), null, 'only run and pr shapes');
  assert.equal(parseWatchRef('gh:../../etc#run/1'), null, 'a repo is owner/name, not a path');
});

test('pollableRefs keeps declaration order, drops the rest, and dedupes', () => {
  const targets = pollableRefs([
    'url:https://ci.example.com/9',
    'gh:acme/app#run/123',
    'nonsense',
    'gh:acme/app#pr/9',
    'gh:acme/app#run/123',
  ]);
  assert.deepEqual(targets.map((t) => t.ref), ['gh:acme/app#run/123', 'gh:acme/app#pr/9'],
    'a ref declared twice is one probe, not two — the scheduler keys its rows on the ref');
  assert.deepEqual(pollableRefs(undefined), []);
});

test('a run lands only when it CONCLUDES — a failure ends the wait too, a start does not', () => {
  assert.equal(runLanded({ status: 'queued' }), 'pending');
  assert.equal(runLanded({ status: 'in_progress' }), 'pending', 'a session resumed to watch a progress bar is the burn this stops');
  assert.equal(runLanded({ status: 'completed', conclusion: 'success' }), 'landed');
  assert.equal(runLanded({ status: 'completed', conclusion: 'failure' }), 'landed', 'the session must look at a failure');
  assert.equal(runLanded({}), 'unknown');
});

test('a cmd: ref backs off 5 m, 15 m, 1 h, 6 h — its cost is bounded by the cadence, not by a count (#19)', () => {
  // A billing restore is a wait measured in days. Twelve runs at a flat five
  // minutes was one hour of watching, after which the ref read `refused` and
  // the one probe that would have noticed the fix was gone (control-tower
  // phase 6). The cadence is what keeps a days-long wait cheap now.
  const NOW = Date.parse('2026-09-22T12:00:00Z');
  const cmd = parseWatchRef('cmd:"gh api repos/acme/app/rulesets --silent"')!;
  assert.deepEqual([...WATCH_CMD_BACKOFF_MS], [300_000, 900_000, 3_600_000, 21_600_000]);
  assert.equal(nextDueFor(cmd, 'pending', NOW, 1), NOW + 300_000, 'after the first run: five minutes');
  assert.equal(nextDueFor(cmd, 'pending', NOW, 2), NOW + 900_000, '…then fifteen');
  assert.equal(nextDueFor(cmd, 'pending', NOW, 3), NOW + 3_600_000, '…then an hour');
  assert.equal(nextDueFor(cmd, 'pending', NOW, 4), NOW + 21_600_000, '…then six hours');
  assert.equal(nextDueFor(cmd, 'pending', NOW, 40), NOW + 21_600_000, 'and six hours from then on, for as long as the budget lasts');
  assert.equal(nextDueFor(cmd, 'unknown', NOW, 0), NOW + 300_000, 'a probe that ran nothing stays on the first step');
  assert.equal(nextDueFor(cmd, 'refused', NOW, 3), null, 'refused still has no next');
  assert.equal(WATCH_POLL_MS.cmd, WATCH_CMD_BACKOFF_MS[0], 'the published cadence is the first step');
  // The other schemes do not count runs at all.
  const run = parseWatchRef('gh:acme/app#run/1')!;
  assert.equal(nextDueFor(run, 'pending', NOW, 9), NOW + WATCH_POLL_MS['gh-run']);
  assert.equal(MAX_CMD_RUNS_PER_PHASE, 200, 'a backstop against a runaway, not the old terminal twelve');
});

test('WR-1: inside the declared window a cmd: ref is asked at least every min(back-off step, window / 6) (#87)', () => {
  const FROM = Date.parse('2026-09-22T12:00:00Z');
  const hour = { from: FROM, until: FROM + 3_600_000 };
  const cmd = parseWatchRef('cmd:"curl -sf https://example.com/health"')!;
  const at = FROM + 60_000;
  assert.equal(nextDueFor(cmd, 'pending', at, 1, hour), at + 300_000, 'the first step is already under a sixth of an hour');
  assert.equal(nextDueFor(cmd, 'pending', at, 2, hour), at + 600_000, 'fifteen minutes is capped at the window\'s sixth (ten)');
  assert.equal(nextDueFor(cmd, 'pending', at, 3, hour), at + 600_000, '…and so is the hour');
  assert.equal(nextDueFor(cmd, 'pending', at, 9, hour), at + 600_000, '…and the six hours');
  // A window whose sixth is longer than the back-off leaves the back-off alone.
  const week = { from: FROM, until: FROM + 7 * 86_400_000 };
  assert.equal(nextDueFor(cmd, 'pending', at, 3, week), at + 3_600_000);
  assert.equal(nextDueFor(cmd, 'pending', at, 2, null), at + 900_000, 'no window: the run-count back-off, unchanged');
  assert.equal(nextDueFor(cmd, 'unknown', at, 0, hour), at + 300_000);
  assert.equal(nextDueFor(cmd, 'refused', at, 2, hour), null, 'refused still has no next');
});

test('WR-2: a cmd: ref that wraps `gh run` or `gh pr` is asked every five minutes inside its window (#87)', () => {
  const FROM = Date.parse('2026-09-22T12:00:00Z');
  const week = { from: FROM, until: FROM + 7 * 86_400_000 };
  const at = FROM + 60_000;
  for (const text of [
    'cmd:"gh run list --workflow deploy.yml --commit cb590f0e --json status --jq .[0].status"',
    'cmd:"gh pr view 12 --repo acme/app --json state"',
    'cmd:"bash -c \'gh run view 99 --json status | grep -q completed\'"',
  ]) {
    const cmd = parseWatchRef(text)!;
    assert.ok(cmdWrapsGh(cmd.kind === 'cmd' ? cmd.command : ''), text);
    assert.equal(nextDueFor(cmd, 'pending', at, 3, week), at + WATCH_CMD_GH_MS, text);
    assert.equal(nextDueFor(cmd, 'pending', at, 9, week), at + WATCH_CMD_GH_MS, text);
  }
  assert.equal(WATCH_CMD_GH_MS, 300_000);
  for (const text of ['gh api repos/acme/app/rulesets --silent', 'npm test', 'echo gh-runner', 'ghrun list']) {
    assert.equal(cmdWrapsGh(text), false, text);
  }
});

test('WR-3: the back-off applies only after the window, counted from the window\'s end (#87)', () => {
  const FROM = Date.parse('2026-09-22T12:00:00Z');
  const window = { from: FROM, until: FROM + 3_600_000 };
  const cmd = parseWatchRef('cmd:"gh run list --commit cb590f0e"')!;
  const past = (min: number) => window.until + min * 60_000;
  // Twelve runs happened inside the window; what the back-off reads after it
  // is how long the window has been over, not how busy it was.
  assert.equal(nextDueFor(cmd, 'pending', past(0), 12, window), past(0) + 300_000, 'the window just ended: five minutes');
  assert.equal(nextDueFor(cmd, 'pending', past(5), 12, window), past(5) + 900_000, '…then fifteen');
  assert.equal(nextDueFor(cmd, 'pending', past(20), 12, window), past(20) + 3_600_000, '…then an hour');
  assert.equal(nextDueFor(cmd, 'pending', past(80), 12, window), past(80) + 21_600_000, '…then six hours');
  assert.equal(nextDueFor(cmd, 'pending', past(4000), 12, window), past(4000) + 21_600_000, 'and six from then on');
  assert.equal(cmdBackoffAfterMs(0), 300_000);
  assert.equal(cmdBackoffAfterMs(-1), 300_000, 'a clock read a moment early is still the first step');
});

test('WR-4: the measured deploy watch — landed at +41.5 min in a 49.8-min window — is seen inside the window (#87)', () => {
  // The one deploy-watch `cmd:` ref the audit observed became true at +41.5
  // min. Phase 6's back-off asked at +0, +5, +20 and then +80 — the window
  // (+49.8) resumed the session before the probe ever saw it. Replayed on the
  // scheduler's own rule: every probe's next time is `nextDueFor`'s answer.
  const FROM = Date.parse('2026-09-16T22:08:34Z');
  const window = { from: FROM, until: FROM + 49.8 * 60_000 };
  const landedAt = FROM + 41.5 * 60_000;
  const cmd = parseWatchRef('cmd:"gh run list --workflow deploy.yml --commit cb590f0e --json status --jq .[0].status"')!;
  const replay = (win: typeof window | null): number => {
    let at = FROM;
    for (let runs = 1; runs < 100; runs += 1) {
      if (at >= landedAt) return at;
      at = nextDueFor(cmd, 'pending', at, runs, win)!;
    }
    return Infinity;
  };
  const seen = replay(window);
  assert.ok(seen < window.until, `seen at +${((seen - FROM) / 60_000).toFixed(1)} min, inside the window`);
  assert.ok(seen - landedAt <= 5 * 60_000, 'at most one gh step late');
  assert.equal(replay(null) - FROM, 80 * 60_000, 'the old schedule saw it at +80 min');
  // The same ref without gh in it is held to a sixth of the window (8.3 min).
  const plain = parseWatchRef('cmd:"curl -sf https://example.com/deployed"')!;
  let at = FROM;
  for (let runs = 1; at < landedAt; runs += 1) at = nextDueFor(plain, 'pending', at, runs, window)!;
  assert.ok(at < window.until && at - landedAt <= (window.until - window.from) / 6, 'a sixth of the window at most');
});

test('WR-5: the declared window is the declaration\'s own instant to the clock it asked for', () => {
  const at = '2026-09-22T12:00:00.000Z';
  assert.deepEqual(declaredWindowOf({
    parkedUntil: '2026-09-22T13:00:00.000Z', declared: { at, requested: '2026-09-22T14:00:00Z' },
  }), { from: Date.parse(at), until: Date.parse('2026-09-22T14:00:00Z') }, 'the session\'s own ask wins over the granted clock');
  assert.deepEqual(declaredWindowOf({ parkedUntil: '2026-09-22T13:00:00.000Z', declared: { at } }),
    { from: Date.parse(at), until: Date.parse('2026-09-22T13:00:00.000Z') }, 'else the clock the park wrote');
  assert.equal(declaredWindowOf({ declared: { at } }), null, 'a spent-budget park has no clock, so no window');
  assert.equal(declaredWindowOf({ parkedUntil: at, declared: { at } }), null, 'an empty window is none');
  assert.equal(declaredWindowOf({}), null);
});

/* The fifth amendment's two window rules (control-tower phase 87, #126). */

const HOUR = 3_600_000;
const SIBLING_CMD = "cmd:grep -q '^status: complete' docs/handoffs/demo/phase-43-perf-ii-catalogs.md";

test('BW-4: the declared window is clamped to the wait budget — P41\'s twelve hours against eight, replayed (#126)', () => {
  // P41 on disk (hub run 24fcba33): declared at 09:28:13Z with a window the
  // 4th probe's step says was 11 h 59 m 12 s, against the console's 8 h budget.
  const at = Date.parse('2026-09-25T09:28:13Z');
  const record = {
    phase: 41, status: 'failed', attempts: 1,
    parkedUntil: new Date(at + 11 * HOUR + 59 * 60_000 + 12_000).toISOString(),
    declared: {
      status: 'blocked', reason: 'P43\'s WIP', watch: [SIBLING_CMD], at: new Date(at).toISOString(),
      budget: { ms: DEFAULT_WAIT_BUDGET_MS, source: 'default' },
    },
  } as PhaseRecord;
  const window = declaredWindowOf(record);
  assert.deepEqual(window, { from: at, until: at + 8 * HOUR }, 'the window ends where the budget does: 17:28:13Z, not 21:27:25Z');
  assert.equal(window!.until, waitBudgetEndOf(record), 'the cadence, the card and the refusal read one end');
  // The fourth probe (10:49:04Z): a sixth of the CLAMPED window — 80 min, not
  // 1 h 59 m 52 s — so the probe after it lands inside the budget, not past it.
  const cmd = parseWatchRef(SIBLING_CMD)!;
  assert.equal(cmdStepMs(cmd.kind === 'cmd' ? cmd.command : '', 4, Date.parse('2026-09-25T10:49:04Z'), window), 80 * 60_000);
  // The ask is still the ask: a window inside the budget is untouched.
  const short = { ...record, parkedUntil: new Date(at + 2 * HOUR).toISOString() } as PhaseRecord;
  assert.deepEqual(declaredWindowOf(short), { from: at, until: at + 2 * HOUR });
  // Parked time spent BEFORE this declaration comes off the end, as the budget is a total.
  const spentBefore = { ...record, waitHistory: [] } as PhaseRecord;
  openWaitEntry(spentBefore, { parkedFrom: new Date(at - 3 * HOUR).toISOString(), parkedUntil: new Date(at - HOUR).toISOString(), by: 'session' }, at);
  spentBefore.waitHistory![0].resumedAt = new Date(at - HOUR).toISOString();
  assert.equal(declaredWindowOf(spentBefore)!.until, at + 6 * HOUR);
  // A park whose budget is already spent waits on its refs with no clock of its own — no clamp applies.
  const spent = { ...record, declared: { ...record.declared!, requested: new Date(at + 12 * HOUR).toISOString(), budgetSpent: { at: record.declared!.at, ledger: 'budget' as const } } } as PhaseRecord;
  assert.equal(declaredWindowOf(spent)!.until, at + 12 * HOUR);
});

test('BW-5: refs read from console state — `phase:` and `verify:` (phase 88) — spend no wait budget; `cmd:` keeps it', () => {
  assert.deepEqual([...BUDGET_FREE_SCHEMES].sort(), ['phase', 'verify']);
  assert.equal(spendsWaitBudget(['phase:demo/43']), false, 'a sibling\'s completion is the queue\'s to decide, not the clock\'s');
  assert.equal(spendsWaitBudget(['verify:demo/12']), false, 'a phase\'s own red lines going green likewise');
  assert.equal(spendsWaitBudget(['phase:demo/43', 'verify:demo/12']), false);
  assert.equal(spendsWaitBudget([SIBLING_CMD]), true, 'a cmd: ref RUNS something — its wait is budgeted');
  assert.equal(spendsWaitBudget(['phase:demo/43', SIBLING_CMD]), true, 'one budgeted ref budgets the park');
  assert.equal(spendsWaitBudget(['gh:acme/app#run/42', 'date:2026-09-26T09:00:00Z', 'lock:other/2']), true);
  assert.equal(spendsWaitBudget([]), true, 'a wait naming nothing is a clock, and a clock is budgeted');

  // A park on console state is granted as asked, past any budget…
  const now = Date.parse('2026-09-26T09:00:00Z');
  const budget = { budgetMs: HOUR, source: 'phase' as const, countersignedUntil: null, refs: [] };
  const asked = evaluateWait({ now, requestedUntil: now + 12 * HOUR, parkedMs: 50 * 60_000, waits: 1, budget, ledger: 'session', unbudgeted: true });
  assert.equal(asked.verdict, 'park');
  assert.equal(asked.verdict === 'park' && asked.until, now + 12 * HOUR);
  assert.equal(asked.verdict === 'park' && asked.capped, false);
  // …its parked time is never summed into the budget…
  const record = { phase: 5, status: 'waiting', attempts: 1 } as PhaseRecord;
  openWaitEntry(record, { parkedFrom: new Date(now - 5 * HOUR).toISOString(), parkedUntil: new Date(now + HOUR).toISOString(), by: 'session', unbudgeted: true }, now);
  assert.equal(parkedMsOf(record, now), 0);
  // …and it has no budget end, so nothing clamps its window.
  record.declared = { status: 'blocked', watch: ['phase:demo/43'], at: new Date(now).toISOString(), budget: { ms: HOUR, source: 'phase' } };
  record.parkedUntil = new Date(now + 12 * HOUR).toISOString();
  assert.equal(waitBudgetEndOf(record), null);
  assert.deepEqual(declaredWindowOf(record), { from: now, until: now + 12 * HOUR });
  // A cmd: park keeps its end.
  record.declared = { ...record.declared, watch: [SIBLING_CMD] };
  assert.equal(waitBudgetEndOf(record), now + HOUR);
});

test('a PR lands when it leaves OPEN, whichever door it takes', () => {
  assert.equal(prLanded({ state: 'OPEN' }), 'pending');
  assert.equal(prLanded({ state: 'MERGED' }), 'landed');
  assert.equal(prLanded({ state: 'CLOSED' }), 'landed');
  assert.equal(prLanded({}), 'unknown');
});

test('phase 132: credential:<id> is read by presence — the ids credentials-probe knows, and nothing else', async () => {
  const { probeWatchRef, WATCH_SCHEMES } = await import('../server/watch-refs.ts');
  assert.ok((WATCH_SCHEMES as readonly string[]).includes('credential'));
  for (const id of ['gh', 'claude', 'claude-login', 'env:DEPLOY_KEY', 'keychain:phase-console-npm-token', 'file:~/.npmrc']) {
    assert.deepEqual(parseWatchRef(`credential:${id}`), { kind: 'credential', id, ref: `credential:${id}` });
  }
  for (const bad of ['credential:', 'credential:npm', 'credential:env:', 'credential:keychain:a b']) {
    assert.equal(parseWatchRef(bad), null, `${bad} is no ref`);
  }
  const target = parseWatchRef('credential:env:DEPLOY_KEY')!;
  const said = (status: 'ok' | 'fail' | 'skip') => ({ credentialProbe: async () => ({ status, reason: `read ${status}` }) });
  assert.equal((await probeWatchRef(target, said('ok'))).state, 'landed');
  assert.equal((await probeWatchRef(target, said('fail'))).state, 'pending');
  assert.equal((await probeWatchRef(target, said('skip'))).state, 'unknown');
  assert.equal((await probeWatchRef(target, {})).state, 'unknown', 'no prober, no guess');
  assert.equal(nextDueFor(target, 'pending', 0), WATCH_POLL_MS.credential);
});
