/**
 * Booked equals priced, at each model's own rates (control-tower phase 109, #202).
 *
 * #62's corroboration priced every session at ONE row, `opus`, found by a
 * family SUBSTRING: `claude-opus-5-5[1m]` contains `opus`, so every Opus 5.5
 * session was priced at Opus 5's rates. 347 `phase.cost-mismatch` lines on
 * this machine, 2026-09-25 → 10-03, every one `under`, every one Opus 5.5; the
 * fresh 5.5 sessions sat at a median 0.536 × the console's price. The booking
 * was right and the price was wrong — and with the price ≈ 1.9 × the true cost,
 * a doubled booking of #62's own kind read as agreement.
 *
 *   BP-1  an Opus 5.5 row ($4 input · $8 one-hour cache write · $0.20 cache read
 *         · $20 output per MTok) beside the Opus 5 row ($5 · $10 · $0.50 · $25);
 *   BP-2  P85's tokens price to $14.2217 — the CLI's own `total_cost_usd`;
 *   BP-3  matched by the WHOLE model id, never by a family substring: an
 *         unmeasured version, and an alias that names no version, go unpriced
 *         and uncorroborated;
 *   BP-4  a fresh Opus 5.5 session booking the CLI's figure writes no finding,
 *         and a doubled booking on the default model is a finding again;
 *   BP-5  a model whose fresh sessions sit at one ratio all day is announced
 *         ONCE (`phase.cost-drift`), not once per session — and a session off
 *         that ratio is still a finding.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COST_DRIFT_BAND, COST_DRIFT_SESSIONS, COST_DRIFT_WINDOW_MS, CostDrift, TOKEN_PRICES_USD, priceRowOf, priceUsage,
} from '../server/runner/usage.ts';
import type { SpawnOutcome } from '../server/runner/spawn.ts';
import type { TokenCounters } from '../server/runner/usage.ts';

const { Runner } = await import('../server/runner/runner.ts');

const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} ≠ ${b}`);
const tokensOf = (partial: Partial<TokenCounters>): TokenCounters => ({
  calls: 40, lastContext: 450_000, peakContext: 450_000, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, rebuilds: 0, ...partial,
});
/** control-tower P85's session `fa0e854a…`, fresh, `claude-opus-5-5[1m]` (#202's table). */
const P85 = tokensOf({ input: 268, cacheWrite: 389_327, cacheRead: 37_695_498, output: 178_346 });

/* ------------------------------------------------------------------ *
 * BP-1 … BP-3 — the table
 * ------------------------------------------------------------------ */

test('BP-1: Opus 5.5 is priced at its own rates, beside Opus 5\'s — per MTok, every counter', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]']) {
    near(priceUsage(id, tokensOf({ input: 1_000_000 }))!, 4, `${id} input`);
    near(priceUsage(id, tokensOf({ cacheWrite: 1_000_000 }))!, 8, `${id} a one-hour cache write`);
    near(priceUsage(id, tokensOf({ cacheRead: 1_000_000 }))!, 0.2, `${id} a cache read`);
    near(priceUsage(id, tokensOf({ output: 1_000_000 }))!, 20, `${id} output`);
  }
  for (const id of ['claude-opus-5', 'claude-opus-5[1m]']) {
    near(priceUsage(id, tokensOf({ input: 1_000_000 }))!, 5, `${id} input`);
    near(priceUsage(id, tokensOf({ cacheWrite: 1_000_000 }))!, 10, `${id} a one-hour cache write`);
    near(priceUsage(id, tokensOf({ cacheRead: 1_000_000 }))!, 0.5, `${id} a cache read`);
    near(priceUsage(id, tokensOf({ output: 1_000_000 }))!, 25, `${id} output`);
  }
  assert.deepEqual(Object.keys(TOKEN_PRICES_USD).sort(), ['claude-opus-5', 'claude-opus-5-5'], 'one row per measured model version');
});

test('BP-2: P85\'s tokens price to $14.2217 — the CLI\'s own total — where the one `opus` row said $27.2010', () => {
  near(priceUsage('claude-opus-5-5[1m]', P85)!, 14.2217, 'at Opus 5.5\'s rates', 1e-4);
  near(priceUsage('claude-opus-5', P85)!, 27.2010, 'the same tokens at Opus 5\'s rates — the journal\'s old pricedUsd', 1e-4);
});

test('BP-3: a row is matched by the whole model id — an unmeasured version and a bare alias go unpriced', () => {
  assert.equal(priceRowOf('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(priceRowOf('CLAUDE-OPUS-5-5'), 'claude-opus-5-5', 'case is not a version');
  assert.equal(priceRowOf('claude-opus-5-20260601'), 'claude-opus-5', 'a dated id is its model');
  assert.equal(priceRowOf('claude-opus-5'), 'claude-opus-5');
  // The substring match priced every one of these as Opus 5.
  for (const id of ['claude-opus-5-6', 'claude-opus-6', 'claude-opus-5-5-preview', 'opus', 'opus[1m]', 'claude-sonnet-5', 'some-future-model', '', null, undefined]) {
    assert.equal(priceRowOf(id), null, `${String(id)} names no measured row`);
    assert.equal(priceUsage(id, tokensOf({ output: 1_000 })), null, `${String(id)} is not priced, so not corroborated`);
  }
});

/* ------------------------------------------------------------------ *
 * A run of N fresh sessions, one per phase (BP-4, BP-5)
 * ------------------------------------------------------------------ */

type Session = { model: string; booked: number; tokens: TokenCounters; resume?: boolean };

async function runSessions(sessions: Session[], costDrift?: InstanceType<typeof CostDrift>) {
  const root = mkdtempSync(join(tmpdir(), 'pc-booked-priced-'));
  try {
    const scripts = join(root, 'scripts');
    const stub = join(root, '.stub');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
    const all = sessions.map((_, i) => i + 1).join(' ');
    writeFileSync(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"
case "\${2:-}" in
  --memory-block)
    d=""; r=""
    for p in ${all}; do if [ -f "$S/done-$p" ]; then d="$d$p,"; else r="$r$p,"; fi; done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "; echo "ready: \${r%,}"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase \${3:-} of demo" ;;
  --size) echo M ;;
esac
exit 0
`);
    chmodSync(join(scripts, 'phase-graph.sh'), 0o755);
    writeFileSync(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
    chmodSync(join(scripts, 'phase-lock.sh'), 0o755);
    writeFileSync(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
    chmodSync(join(scripts, 'validate.sh'), 0o755);

    const events: { event: string; data: Record<string, unknown> }[] = [];
    const runner = new Runner({
      scriptsDir: scripts,
      spawn: async (request: { prompt: string }) => {
        const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? 0);
        const session = sessions[phase - 1]!;
        writeFileSync(join(stub, `done-${phase}`), '1\n');
        return {
          signal: { subtype: 'success', code: 0, text: '' },
          sessionId: `sess-${phase}`, costUsd: session.booked, turns: 4, resultText: 'done', durationMs: 10, argv: [],
          resolvedModel: session.model, tokens: session.tokens,
        } as SpawnOutcome;
      },
      verificationText: () => '`true`',
      verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
      phaseDefaults: (_slug: string, phase: number) => ({ model: sessions[phase - 1]?.model ?? 'claude-opus-5-5[1m]' }),
      onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
      ...(costDrift ? { costDrift } : {}),
    } as never);
    await runner.start({ slug: 'demo', root, maxParallel: 1 } as never);
    await runner.wait();
    assert.ok(sessions.every((_, i) => existsSync(join(stub, `done-${i + 1}`))), 'every session ran');
    const lines = (name: string) => events
      .filter((e) => e.event === 'run:journal' && e.data.event === name)
      .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number }));
    return { runner, lines };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('BP-4: a fresh Opus 5.5 session booking the CLI\'s figure writes no finding — the 347 false lines end', async () => {
  const { lines } = await runSessions([{ model: 'claude-opus-5-5[1m]', booked: 14.2217, tokens: P85 }]);
  assert.deepEqual(lines('phase.cost-mismatch'), [], 'booked $14.2217 against a price of $14.2217 is agreement');
  assert.deepEqual(lines('phase.cost-drift'), []);
});

test('BP-4: the #62 check sees the default model again — a doubled Opus 5.5 booking is a finding, where it read as agreement', async () => {
  // At the old row P85 priced to $27.20: a booking of $28.44 (2× the truth) was
  // within a quarter of it and passed. At the right row it is twice the price.
  const { lines } = await runSessions([{ model: 'claude-opus-5-5[1m]', booked: 28.4434, tokens: P85 }]);
  const found = lines('phase.cost-mismatch');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.direction, 'over');
  near(Number(found[0]!.pricedUsd), 14.2217, 'priced at Opus 5.5\'s own rates', 1e-9);
  assert.equal(found[0]!.ratio, 2);
});

test('BP-4: an unmeasured version is not corroborated — no price, no finding, whatever it booked', async () => {
  const { lines } = await runSessions([{ model: 'claude-opus-6[1m]', booked: 1, tokens: P85 }]);
  assert.deepEqual(lines('phase.cost-mismatch'), []);
});

/* ------------------------------------------------------------------ *
 * BP-5 — a drifting ratio is announced once
 * ------------------------------------------------------------------ */

test('BP-5: three fresh sessions of one model at one ratio are a drift — announced once; the rest of the day is quiet', () => {
  const drift = new CostDrift();
  const t0 = Date.parse('2026-10-03T08:00:00Z');
  const at = (minutes: number) => t0 + minutes * 60_000;
  const model = 'claude-opus-5';
  const note = (ratio: number, minutes: number, extra: Partial<{ fresh: boolean; direction: 'over' | 'under' }> = {}) =>
    drift.note({ model, ratio, direction: 'under', fresh: true, at: at(minutes), ...extra });
  assert.equal(COST_DRIFT_SESSIONS, 3);
  assert.equal(COST_DRIFT_BAND, 0.05);
  assert.equal(COST_DRIFT_WINDOW_MS, 24 * 3_600_000);
  assert.equal(note(0.54, 0).kind, 'mismatch', 'one session is a finding');
  assert.equal(note(0.55, 10, { fresh: false }).kind, 'mismatch', 'a resumed session is a finding, and is no evidence of a drift');
  assert.equal(note(0.53, 20).kind, 'mismatch', 'two are still findings');
  const told = note(0.54, 30);
  assert.equal(told.kind, 'drift', 'the third at the same ratio is the price, not the booking');
  assert.equal((told as { ratio: number }).ratio, 0.54);
  assert.equal((told as { sessions: number }).sessions, 3);
  assert.equal((told as { since: string }).since, new Date(at(0)).toISOString());
  assert.equal(note(0.55, 60).kind, 'explained', 'the next one is the drift already announced');
  assert.equal(note(0.54, 600, { fresh: false }).kind, 'explained', 'resumed or fresh, it is the same drift');
  assert.equal(note(1.6, 620, { direction: 'over' }).kind, 'mismatch', 'a session off the ratio is still a finding — the check is not blind');
  assert.equal(note(0.7, 640).kind, 'mismatch', 'outside the band is not the drift');
  assert.equal(note(0.54, 30 + 24 * 60 + 1).kind, 'mismatch', 'a day later the announcement has lapsed: it is evidence again');
  assert.equal(drift.note({ model: 'claude-opus-5-5', ratio: 0.54, direction: 'under', fresh: true, at: at(700) }).kind, 'mismatch', 'per model');
});

test('BP-5: a session that booked NOTHING is a finding, never a drift — three of them do not silence a fourth', () => {
  const drift = new CostDrift();
  const t0 = Date.parse('2026-10-03T08:00:00Z');
  const kinds = [0, 1, 2, 3].map((i) => drift.note({ model: 'claude-opus-5-5', ratio: 0, direction: 'under', fresh: true, at: t0 + i * 60_000 }).kind);
  assert.deepEqual(kinds, ['mismatch', 'mismatch', 'mismatch', 'mismatch']);
});

test('BP-5: a ratio that wanders is never a drift — the band is ±5 % of the median', () => {
  const drift = new CostDrift();
  const t0 = Date.parse('2026-10-03T08:00:00Z');
  const verdicts = [0.5, 0.6, 0.55, 0.62].map((ratio, i) => drift.note({ model: 'claude-opus-5', ratio, direction: 'under', fresh: true, at: t0 + i * 60_000 }).kind);
  assert.deepEqual(verdicts, ['mismatch', 'mismatch', 'mismatch', 'mismatch']);
  const mixed = new CostDrift();
  const kinds = [['under', 0.5], ['over', 0.5], ['under', 0.5]].map(([direction, ratio], i) =>
    mixed.note({ model: 'claude-opus-5', ratio: ratio as number, direction: direction as 'over' | 'under', fresh: true, at: t0 + i * 60_000 }).kind);
  assert.deepEqual(kinds, ['mismatch', 'mismatch', 'mismatch'], 'one direction or none');
});

test('BP-5: through the runner — two findings, then ONE phase.cost-drift, then silence; a doubled booking is still caught', async () => {
  // A price row that has gone stale (the next lineup change): every fresh
  // session books 0.54 × what the table says.
  const priced = priceUsage('claude-opus-5', P85)!;
  const at = (ratio: number): Session => ({ model: 'claude-opus-5', booked: Math.round(priced * ratio * 10_000) / 10_000, tokens: P85 });
  const { lines } = await runSessions([at(0.54), at(0.54), at(0.54), at(0.54), at(0.54), at(3)]);
  const findings = lines('phase.cost-mismatch');
  assert.deepEqual(findings.map((line) => line.phase), [1, 2, 6], 'phases 1 and 2 are findings, 3 announces, 4 and 5 are quiet, 6 is off the ratio');
  assert.equal(findings[2]!.direction, 'over');
  const drift = lines('phase.cost-drift');
  assert.equal(drift.length, 1, 'announced once, not per session');
  assert.equal(drift[0]!.phase, 3);
  assert.equal(drift[0]!.model, 'claude-opus-5');
  assert.equal(drift[0]!.direction, 'under');
  assert.equal(drift[0]!.ratio, 0.54);
  assert.equal(drift[0]!.sessions, 3);
  assert.equal(drift[0]!.sessionId, 'sess-3');
});

test('BP-5: one drift memory across runs — the console\'s, so a second run of the same day stays quiet', async () => {
  const shared = new CostDrift();
  const priced = priceUsage('claude-opus-5', P85)!;
  const stale: Session = { model: 'claude-opus-5', booked: Math.round(priced * 0.54 * 10_000) / 10_000, tokens: P85 };
  const first = await runSessions([stale, stale, stale], shared);
  assert.equal(first.lines('phase.cost-drift').length, 1);
  const second = await runSessions([stale, stale], shared);
  assert.deepEqual(second.lines('phase.cost-mismatch'), [], 'the drift is the console\'s, not the run\'s');
  assert.deepEqual(second.lines('phase.cost-drift'), []);
});
