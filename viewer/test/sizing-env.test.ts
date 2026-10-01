/**
 * F5 — one sizing source, pinned in every place that copies it.
 *
 * CLAUDE.md states the invariant in three parts: "`scripts/sizing.env` holds
 * every size weight and per-model budget, and `scripts/mcp.env` the
 * per-attached-server surcharge. `phase-graph.sh` sources it,
 * `references/sizing.md` documents those exact numbers, and
 * `viewer/server/analysis/graph.ts` reads the same file."
 *
 * Two of those three were code and could have been compared; nothing compared
 * them (coverage-5). The doc half was compared by nothing at all (coverage-6).
 * And `test/eta.test.ts` held a FOURTH copy as three local constants, so the
 * suite that reasons hardest about weights was the one least likely to notice a
 * change to them.
 *
 * This file closes all of it, in the shape `models-env.test.ts` and
 * `verify-env.test.ts` already established: the FILE is the truth, the shipped
 * fallback must equal it, and the documentation must state its numbers.
 *
 * These tests need no environment and no plan library — they run on a bare
 * clone, which is the point (xcut-9).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  loadSizing, loadMcpSurcharge, mcpSurchargeOf, weightOf, expectedFromEnv, sessionsFor, shippedSessionsPerSize,
  SIZING_ENV_FALLBACK, MCP_ENV_FALLBACK,
} from '../server/analysis/graph.ts';
import {
  contextLine, contextOf, forecastLine, forecastSessions, sessionsPerPhaseOf, shippedContextModel, weightLine,
} from '../server/analysis/sizing-model.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const REFERENCES = join(SKILL_DIR, 'references');

/** The same `^KEY=<digits>` rule both readers use, applied to the raw file. */
function envNumbers(file: string): Record<string, number> {
  const text = readFileSync(join(SCRIPTS, file), 'utf8');
  const values: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(\d+)/.exec(line.trim());
    if (m) values[m[1]] = Number(m[2]);
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * sizing.env
 * ------------------------------------------------------------------ */

test('the shipped Sizing fallback is identical to scripts/sizing.env', () => {
  assert.deepEqual(loadSizing(SCRIPTS), SIZING_ENV_FALLBACK);
});

test('every key the sizing reader looks for is actually present in the file', () => {
  const values = envNumbers('sizing.env');
  for (const key of ['SIZE_S', 'SIZE_M', 'SIZE_L',
    'BUDGET_HAIKU', 'BUDGET_BIG', 'BUDGET_DEFAULT', 'BUDGET_1M',
    // The session model and the sessions per phase (control-tower phase 59, #83).
    'SESSION_BOOT_FLOOR', 'SESSION_WORK_FLOOR', 'SESSION_SLOPE_PCT', 'SESSION_TARGET_PCT',
    'SESSIONS_S_X100', 'SESSIONS_S_WRAP_X100', 'WRAP_S_PCT',
    'SESSIONS_M_X100', 'SESSIONS_M_WRAP_X100', 'WRAP_M_PCT',
    'SESSIONS_L_X100', 'SESSIONS_L_WRAP_X100', 'WRAP_L_PCT']) {
    assert.ok(key in values, `${key} is missing from sizing.env, so the reader is on its fallback`);
  }
  // BUDGET_1M carries a digit in its NAME. A key class of [A-Z_] parsed the
  // file happily while dropping exactly that line — silent, one-sided, and the
  // reason the reader's regex is [A-Z0-9_]. Assert the digit case explicitly.
  assert.equal(values.BUDGET_1M, loadSizing(SCRIPTS).budget1m);
});

test('a sizing number changed in the file moves the reader, not the fallback', () => {
  // The fallback is a copy by construction; this states what the copy is FOR.
  const file = envNumbers('sizing.env');
  const read = loadSizing(SCRIPTS);
  assert.equal(read.S, file.SIZE_S);
  assert.equal(read.M, file.SIZE_M);
  assert.equal(read.L, file.SIZE_L);
  assert.equal(read.budgetHaiku, file.BUDGET_HAIKU);
  assert.equal(read.budgetBig, file.BUDGET_BIG);
  assert.equal(read.budgetDefault, file.BUDGET_DEFAULT);
  assert.equal(read.budget1m, file.BUDGET_1M);
  assert.equal(read.bootFloor, file.SESSION_BOOT_FLOOR);
  assert.equal(read.workFloor, file.SESSION_WORK_FLOOR);
  assert.equal(read.slopePct, file.SESSION_SLOPE_PCT);
  assert.equal(read.targetPct, file.SESSION_TARGET_PCT);
  for (const size of ['S', 'M', 'L'] as const) {
    assert.deepEqual(read.sessions[size], {
      noWrapX100: file[`SESSIONS_${size}_X100`], wrapX100: file[`SESSIONS_${size}_WRAP_X100`], wrapPct: file[`WRAP_${size}_PCT`],
    }, size);
  }
});

test('an unreadable scripts directory falls back rather than throwing', () => {
  assert.deepEqual(loadSizing(join(SKILL_DIR, 'no-such-directory')), SIZING_ENV_FALLBACK);
  assert.deepEqual(loadMcpSurcharge(join(SKILL_DIR, 'no-such-directory')), MCP_ENV_FALLBACK);
});

/* ------------------------------------------------------------------ *
 * mcp.env
 * ------------------------------------------------------------------ */

test('the shipped MCP surcharge fallback is identical to scripts/mcp.env', () => {
  assert.deepEqual(loadMcpSurcharge(SCRIPTS), MCP_ENV_FALLBACK);
  const file = envNumbers('mcp.env');
  assert.equal(loadMcpSurcharge(SCRIPTS).surcharge, file.MCP_SURCHARGE);
  assert.equal(loadMcpSurcharge(SCRIPTS).surchargeMax, file.MCP_SURCHARGE_MAX);
});

test('the surcharge is per server and capped, exactly as _mcp_surcharge computes it', () => {
  const mcp = loadMcpSurcharge(SCRIPTS);
  assert.equal(mcpSurchargeOf(0, mcp), 0, 'a phase with no servers pays nothing');
  assert.equal(mcpSurchargeOf(1, mcp), mcp.surcharge);
  assert.equal(mcpSurchargeOf(3, mcp), 3 * mcp.surcharge);
  const overCap = Math.ceil(mcp.surchargeMax / mcp.surcharge) + 5;
  assert.equal(mcpSurchargeOf(overCap, mcp), mcp.surchargeMax, 'tool search flattens the tail');
  // Defensive: a count that is not a count must not produce NaN weight.
  assert.equal(mcpSurchargeOf(-1, mcp), 0);
  assert.equal(mcpSurchargeOf(Number.NaN, mcp), 0);
});

test('weightOf charges the surcharge only when it is given servers to charge for', () => {
  const sizing = loadSizing(SCRIPTS);
  const mcp = loadMcpSurcharge(SCRIPTS);
  // The old two-argument call must keep its old answer — many callers have no
  // server list, and a wrong number is worse than an incomplete one.
  assert.equal(weightOf('L', sizing), sizing.L);
  assert.equal(weightOf('L', sizing, 0, mcp), sizing.L);
  assert.equal(weightOf('L', sizing, 2, mcp), sizing.L + 2 * mcp.surcharge);
  assert.equal(weightOf('S', sizing, ['a', 'b', 'c'], mcp), sizing.S + 3 * mcp.surcharge);
  assert.equal(weightOf(undefined, sizing, 1, mcp), sizing.M + mcp.surcharge, 'no Size tag means M');
});

/* ------------------------------------------------------------------ *
 * references/sizing.md — the third copy, and the one a person reads
 * ------------------------------------------------------------------ */

test('references/sizing.md states the numbers scripts/sizing.env holds', () => {
  const doc = readFileSync(join(REFERENCES, 'sizing.md'), 'utf8');
  const sizing = loadSizing(SCRIPTS);
  const k = (n: number) => `${Math.round(n / 1000)}K`;

  // The S/M/L weights, written as `S=15K M=40K L=90K` in the F5 clause and
  // repeated in the sizing table's own prose.
  assert.match(doc, new RegExp(`S=${k(sizing.S)}`), 'sizing.md no longer states SIZE_S');
  assert.match(doc, new RegExp(`M=${k(sizing.M)}`), 'sizing.md no longer states SIZE_M');
  assert.match(doc, new RegExp(`L=${k(sizing.L)}`), 'sizing.md no longer states SIZE_L');

  // The budget column of the model table.
  for (const [name, value] of [
    ['BUDGET_1M', sizing.budget1m], ['BUDGET_BIG', sizing.budgetBig],
    ['BUDGET_HAIKU', sizing.budgetHaiku], ['BUDGET_DEFAULT', sizing.budgetDefault],
  ] as const) {
    const row = doc.split('\n').find((l) => l.includes(`\`${name}\``));
    assert.ok(row, `sizing.md no longer has a row for ${name}`);
    assert.ok(
      row.includes(k(value)),
      `sizing.md's ${name} row says "${row.trim()}" but sizing.env says ${k(value)}`,
    );
  }
});

test('references/sizing.md states the numbers scripts/mcp.env holds', () => {
  const doc = readFileSync(join(REFERENCES, 'sizing.md'), 'utf8');
  const mcp = loadMcpSurcharge(SCRIPTS);
  // Written for a reader, with a thousands separator: "1,500 tokens each,
  // capped at 12,000".
  const grouped = (n: number) => n.toLocaleString('en-US');
  assert.match(
    doc, new RegExp(`${grouped(mcp.surcharge)}\\s+tokens each`),
    `sizing.md no longer states MCP_SURCHARGE (${grouped(mcp.surcharge)})`,
  );
  assert.match(
    doc, new RegExp(`capped at\\s+\\*{0,2}${grouped(mcp.surchargeMax)}`),
    `sizing.md no longer states MCP_SURCHARGE_MAX (${grouped(mcp.surchargeMax)})`,
  );
});

/* ------------------------------------------------------------------ *
 * The session model: the doc states it, and the engine and the console
 * compute it identically (control-tower phase 59, #83)
 * ------------------------------------------------------------------ */

test('references/sizing.md states the session model and the sessions per phase sizing.env holds', () => {
  const doc = readFileSync(join(REFERENCES, 'sizing.md'), 'utf8');
  const sizing = loadSizing(SCRIPTS);
  const k = (n: number) => `${Math.round(n / 1000)}K`;
  assert.match(doc, new RegExp(`${k(sizing.bootFloor)} \\+ ${k(sizing.workFloor)} \\+ ${(sizing.slopePct / 100).toFixed(2)} × weight`),
    'sizing.md states boot + work + slope × weight in the shipped numbers');
  assert.match(doc, /1 phase ≥ 1 session/, 'the unit a forecast is in');
  for (const size of ['S', 'M', 'L'] as const) {
    const expected = expectedFromEnv(sizing.sessions[size]).toFixed(2);
    assert.match(doc, new RegExp(`\\| \`${size}\` \\|[^\\n]*\\b${expected}\\b`), `sizing.md's ${size} row states ${expected} sessions per phase`);
  }
  assert.doesNotMatch(doc, /real context runs about \*\*~3× the summed weight\*\*/, 'the multiple the model replaced is gone');
});

/** The engine's `--session-plan` on a fixture, with the session's channel stripped. */
function sessionPlanOf(fixture: string, args: string[], env: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-sizing-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', fixture), { recursive: true });
    copyFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', `${fixture}.md`), join(root, 'docs', 'plans', `${fixture}.md`));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PE_') && key !== 'DOCS_ROOT'));
    return execFileSync('/bin/bash', [join(SCRIPTS, 'phase-graph.sh'), fixture, '--session-plan', ...args], {
      env: { ...clean, ...env, DOCS_ROOT: root }, encoding: 'utf8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the engine and the console forecast the same sessions, weigh the same sum, state the same context', () => {
  const sizing = loadSizing(SCRIPTS);
  const out = sessionPlanOf('sizes', ['opus']);
  // The sizes fixture: S, S, M, L, S — none done.
  const sizes = ['S', 'S', 'M', 'L', 'S'] as const;
  const phases = sizes.map((size) => ({ size, weight: weightOf(size, sizing) }));
  const table = sessionsPerPhaseOf([], sizing);
  const forecast = forecastSessions(phases, table);
  assert.equal(forecast.sessions, sessionsFor([...sizes], shippedSessionsPerSize(sizing)));
  assert.ok(out.includes(forecastLine(forecast, table)), `the engine's forecast line is the console's:\n${out}`);
  assert.ok(out.includes(weightLine(phases, phases)), 'the engine\'s generated weight line is the console\'s');
  assert.ok(out.includes(contextLine(shippedContextModel(sizing), 5 * sizing.budgetBig, sizing.targetPct)),
    'the engine\'s context line is the console\'s');
  // A console's measured boot floor moves both the same way.
  const measured = sessionPlanOf('sizes', ['opus'], { PE_BOOT_FLOOR: '89000', PE_BOOT_FLOOR_SAMPLES: '14' });
  const own = { ...shippedContextModel(sizing), boot: 89_000, floor: 89_000 + sizing.workFloor };
  assert.ok(measured.includes(contextLine(own, 5 * sizing.budgetBig, sizing.targetPct)));
});

test('the engine\'s batch check adds the floor once per session — the console\'s context model, per group', () => {
  const sizing = loadSizing(SCRIPTS);
  const model = shippedContextModel(sizing);
  const out = sessionPlanOf('sizes', ['opus']);
  const target = (5 * sizing.budgetBig * sizing.targetPct) / 100;
  const groups = [...out.matchAll(/Session \d+\s+(?:batch|solo)\s+\(~(\d+)K\)/g)].map((m) => Number(m[1]) * 1000);
  assert.ok(groups.length >= 2, 'the 175K fixture is two sessions by hand');
  for (const weight of groups) assert.ok(contextOf(model, weight) <= target, `a ${weight} group peaks under the target`);
  assert.ok(contextOf(model, groups.reduce((a, b) => a + b, 0)) > target, 'and all of it together would not');
});
