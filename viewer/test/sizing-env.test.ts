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
import {
  loadSizing, loadMcpSurcharge, mcpSurchargeOf, weightOf,
  SIZING_ENV_FALLBACK, MCP_ENV_FALLBACK,
} from '../server/analysis/graph.ts';

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
    'BUDGET_HAIKU', 'BUDGET_BIG', 'BUDGET_DEFAULT', 'BUDGET_1M']) {
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
