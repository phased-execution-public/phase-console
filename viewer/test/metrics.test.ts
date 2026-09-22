/**
 * `/api/metrics` — the scrape endpoint, and the contract its names are.
 *
 * Two different things are pinned here and they fail for different reasons.
 *
 * **That it parses.** The exposition format is line-oriented and unforgiving:
 * an unescaped quote in a label ends the label early and the rest of the line
 * becomes garbage, a family whose TYPE appears twice is rejected outright, and
 * a scraper reports both as "endpoint down" with no clue which line did it. So
 * this file carries a real parser rather than a set of regexes, and every
 * assertion below runs against what the parser made of the bytes.
 *
 * **That the names do not move.** The moment an operator points a scraper at
 * this endpoint, every family name and label is load-bearing — a rename breaks
 * their dashboards silently, weeks later, in the direction nobody checks.
 * `METRIC_FAMILIES` is the declaration and the renderer is the implementation,
 * and this file holds them to each other in BOTH directions: a family declared
 * with no emitter fails, and an emitter with no declaration fails.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  METRICS_CONTENT_TYPE, METRIC_FAMILIES, PHASE_STATES, escapeLabel, renderMetrics,
  type MetricsFacts,
} from '../server/analysis/metrics.ts';
import { count } from '../server/counters.ts';

/* ------------------------------------------------------------------ *
 * a real parser, so "parseable" means parsed
 * ------------------------------------------------------------------ */

type Sample = { name: string; labels: Record<string, string>; value: number };
type Parsed = {
  help: Map<string, string>;
  type: Map<string, string>;
  samples: Sample[];
  /** Families in the order their first sample appeared. */
  order: string[];
};

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Parse the exposition format, refusing anything a scraper would refuse.
 *
 * Deliberately strict and deliberately hand-written: the point of the test is
 * that the bytes are right, and a lenient parser written by the same session
 * that wrote the renderer would agree with it about a shared mistake.
 */
function parse(text: string): Parsed {
  const out: Parsed = { help: new Map(), type: new Map(), samples: [], order: [] };
  assert.ok(text.endsWith('\n'), 'the body must end with a newline');
  const lines = text.slice(0, -1).split('\n');

  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}: ${JSON.stringify(line)}`;
    assert.notEqual(line, '', `${where} — a blank line is not part of the format`);

    if (line.startsWith('# ')) {
      const [, kind, name, ...rest] = line.split(' ');
      if (kind === 'HELP') {
        assert.ok(NAME.test(name!), `${where} — bad metric name`);
        assert.ok(!out.help.has(name!), `${where} — HELP repeated for ${name}`);
        out.help.set(name!, rest.join(' '));
        continue;
      }
      if (kind === 'TYPE') {
        assert.ok(NAME.test(name!), `${where} — bad metric name`);
        assert.ok(!out.type.has(name!), `${where} — TYPE repeated for ${name}`);
        assert.ok(['gauge', 'counter'].includes(rest[0]!), `${where} — unknown type`);
        out.type.set(name!, rest[0]!);
        continue;
      }
      assert.fail(`${where} — a comment that is neither HELP nor TYPE`);
    }

    const match = /^([^\s{]+)(\{(.*)\})? (.+)$/.exec(line);
    assert.ok(match, `${where} — not a sample`);
    const [, name, , labelText, valueText] = match;
    assert.ok(NAME.test(name!), `${where} — bad metric name`);

    const labels: Record<string, string> = {};
    if (labelText) {
      // Values are quoted and may contain escaped quotes; split on the commas
      // BETWEEN pairs only.
      for (const pair of labelText.match(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"/g) ?? []) {
        const eq = pair.indexOf('=');
        const key = pair.slice(0, eq);
        assert.ok(LABEL_NAME.test(key), `${where} — bad label name ${key}`);
        labels[key] = pair
          .slice(eq + 2, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      const rebuilt = Object.entries(labels).length;
      assert.equal(rebuilt, labelText.split(',').length - countEscapedCommas(labelText),
        `${where} — label set did not round-trip`);
    }

    const value = Number(valueText);
    assert.ok(Number.isFinite(value), `${where} — value is not a finite number`);
    if (!out.order.includes(name!)) out.order.push(name!);
    out.samples.push({ name: name!, labels, value });
  }
  return out;
}

/** Commas inside a quoted label value are not pair separators. */
function countEscapedCommas(labelText: string): number {
  let inQuote = false;
  let count = 0;
  for (let i = 0; i < labelText.length; i++) {
    const ch = labelText[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && inQuote) count++;
  }
  return count;
}

const valueOf = (parsed: Parsed, name: string, labels: Record<string, string> = {}): number | undefined =>
  parsed.samples.find((s) =>
    s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

const PLAN = {
  slug: 'demo-plan', status: 'active', closed: false,
  phases: 10, done: 4, ready: 2, waiting: 3, inProgress: 1, stuck: 0,
  remainingWeight: 240_000, percent: 40,
};

const FACTS: MetricsFacts = {
  plans: [PLAN, { ...PLAN, slug: 'closed-plan', status: 'complete', closed: true, done: 10, ready: 0, waiting: 0, inProgress: 0, remainingWeight: 0, percent: 100 }],
  runs: [
    { slug: 'demo-plan', status: 'running', spentUsd: 12.5, attempts: 7, phaseSeconds: 3600 },
    { slug: 'demo-plan', status: 'halted', spentUsd: 3, attempts: 2, phaseSeconds: 600 },
  ],
  cost: [{ slug: 'demo-plan', totalUsd: 15.5, attributedUsd: 15.5, residualUsd: 0, ladderUsd: 4 }],
  rungs: [
    { rung: 'resume-own-session', outcome: 'fixed' },
    { rung: 'resume-own-session', outcome: 'fixed' },
    { rung: 'fresh-session', outcome: 'failed' },
    { rung: 'fresh-session' },
  ],
  // Two isolated runs, so the sort has something to sort and the "every
  // declared family emits" check above cannot be satisfied by a single entry.
  git: [
    { slug: 'demo-plan', worktrees: 2, diskBytes: 1_234_567, conflictedFiles: 3 },
    { slug: 'busy-plan', worktrees: 1, diskBytes: 89_000, conflictedFiles: 0 },
  ],
  today: { settledUsd: 9.25, ladderUsd: 4, capUsd: 20 },
  version: 'abc1234',
  instanceId: 'hub',
  scrapeSeconds: 0.012,
};

/* ------------------------------------------------------------------ *
 * the format
 * ------------------------------------------------------------------ */

test('the body is valid Prometheus exposition text', () => {
  const parsed = parse(renderMetrics(FACTS));
  assert.ok(parsed.samples.length > 10);
  // Every family that emitted a sample declared what it is first.
  for (const name of parsed.order) {
    assert.ok(parsed.help.has(name), `${name} emitted samples with no HELP`);
    assert.ok(parsed.type.has(name), `${name} emitted samples with no TYPE`);
  }
});

/**
 * The process-lifetime counters are not part of `FACTS` — they are state this
 * process accumulated — so the fixture has to be rich in that dimension too, or
 * "the declared families and the emitted ones agree in BOTH directions" passes
 * for every counter by way of "no data", which is the one excuse that test
 * exists to refuse.
 *
 * Seeded ONCE, at load: the byte-identity test below compares two scrapes of an
 * unchanged console, and a counter that moved between them is a changed console.
 */
count('log_lines_total', ['info']);
count('journal_appends_total', []);
count('journal_overflow_total', []);
count('transcript_shed_total', ['tool_result']);
count('git_commands_total', ['status', 'true']);
count('git_command_seconds_total', ['status'], 0.25);
count('engine_calls_total', ['phase-graph.sh', 'hit']);
count('http_requests_total', ['2xx']);
count('shell_commands_total', ['gh', 'true']);
count('retention_removed_total', ['git-trace']);

test('a _total is a counter and a counter is a _total — the suffix is not decoration', () => {
  const parsed = parse(renderMetrics(FACTS));
  for (const [name, type] of parsed.type) {
    assert.equal(type === 'counter', name.endsWith('_total'),
      `${name} is a ${type}: rate() over a mislabelled family is silently wrong`);
  }
});

test('the declared families and the emitted ones agree in BOTH directions', () => {
  const parsed = parse(renderMetrics(FACTS));
  const declared = new Set(METRIC_FAMILIES.map(([name]) => name));
  for (const name of parsed.order) {
    assert.ok(declared.has(name), `${name} is emitted but not declared in METRIC_FAMILIES`);
  }
  // Every declared family emits under these facts — the fixture is deliberately
  // rich enough that a family with no emitter cannot hide behind "no data".
  for (const name of declared) {
    assert.ok(parsed.order.includes(name), `${name} is declared but nothing emits it`);
  }
});

test('the HELP text is the declared HELP text, so the docs cannot describe a different metric', () => {
  const parsed = parse(renderMetrics(FACTS));
  for (const [name, , help] of METRIC_FAMILIES) {
    if (!parsed.help.has(name)) continue;
    assert.equal(parsed.help.get(name), help.replace(/\n/g, ' '));
  }
});

test('two scrapes of an unchanged console are byte-identical', () => {
  assert.equal(renderMetrics(FACTS), renderMetrics(FACTS));
  // And the order does not depend on the order the facts arrived in.
  const shuffled: MetricsFacts = {
    ...FACTS,
    plans: [...FACTS.plans].reverse(),
    runs: [...FACTS.runs].reverse(),
    rungs: [...FACTS.rungs].reverse(),
    git: [...(FACTS.git ?? [])].reverse(),
  };
  assert.equal(renderMetrics(shuffled), renderMetrics(FACTS));
});

/* ------------------------------------------------------------------ *
 * escaping — the line-ending defect
 * ------------------------------------------------------------------ */

test('a slug carrying a quote, a backslash or a newline does not end its own label', () => {
  const nasty = 'we"ird\\plan\nname';
  const parsed = parse(renderMetrics({
    ...FACTS,
    plans: [{ ...PLAN, slug: nasty }],
    runs: [{ slug: nasty, status: 'running', spentUsd: 1, attempts: 1, phaseSeconds: 1 }],
    cost: [{ slug: nasty, totalUsd: 1, attributedUsd: 1, residualUsd: 0, ladderUsd: 0 }],
  }));
  const sample = parsed.samples.find((s) => s.name === 'phase_console_plan_remaining_weight');
  assert.equal(sample?.labels.slug, nasty, 'the slug must survive the round trip intact');
});

test('escapeLabel escapes the three characters that can break a line, and nothing else', () => {
  assert.equal(escapeLabel('a"b'), 'a\\"b');
  assert.equal(escapeLabel('a\\b'), 'a\\\\b');
  assert.equal(escapeLabel('a\nb'), 'a\\nb');
  assert.equal(escapeLabel('plain-slug_1'), 'plain-slug_1');
});

/* ------------------------------------------------------------------ *
 * the numbers — the exit criterion's five subjects
 * ------------------------------------------------------------------ */

test('runs, phases, attempts, ladder rungs and USD are all covered', () => {
  const parsed = parse(renderMetrics(FACTS));

  // runs
  assert.equal(valueOf(parsed, 'phase_console_runs', { slug: 'demo-plan', status: 'running' }), 1);
  assert.equal(valueOf(parsed, 'phase_console_runs', { slug: 'demo-plan', status: 'halted' }), 1);

  // phases, by every board state
  for (const state of PHASE_STATES) {
    assert.equal(typeof valueOf(parsed, 'phase_console_phases', { slug: 'demo-plan', state }), 'number',
      `no phase count for ${state}`);
  }
  assert.equal(valueOf(parsed, 'phase_console_phases', { slug: 'demo-plan', state: 'done' }), 4);
  assert.equal(valueOf(parsed, 'phase_console_phases', { slug: 'demo-plan', state: 'ready' }), 2);

  // attempts — summed across the plan's runs
  assert.equal(valueOf(parsed, 'phase_console_phase_attempts_total', { slug: 'demo-plan' }), 9);

  // ladder rungs — tallied by rung AND outcome, with an unsettled rung counted
  assert.equal(valueOf(parsed, 'phase_console_ladder_rungs_total',
    { rung: 'resume-own-session', outcome: 'fixed' }), 2);
  assert.equal(valueOf(parsed, 'phase_console_ladder_rungs_total',
    { rung: 'fresh-session', outcome: 'running' }), 1, 'a rung with no outcome is still a rung climbed');

  // USD
  assert.equal(valueOf(parsed, 'phase_console_spend_usd_total', { slug: 'demo-plan' }), 15.5);
  assert.equal(valueOf(parsed, 'phase_console_ladder_spend_usd_total', { slug: 'demo-plan' }), 4);
  assert.equal(valueOf(parsed, 'phase_console_settled_usd_today'), 9.25);
  assert.equal(valueOf(parsed, 'phase_console_ladder_usd_today'), 4);
});

test('progress is a 0-1 ratio, the Prometheus convention, not the 0-100 percent the board carries', () => {
  const parsed = parse(renderMetrics(FACTS));
  assert.equal(valueOf(parsed, 'phase_console_plan_progress_ratio', { slug: 'demo-plan' }), 0.4);
  assert.equal(valueOf(parsed, 'phase_console_plan_progress_ratio', { slug: 'closed-plan' }), 1);
});

test('a plan with no phases is zero progress, never a division by zero', () => {
  const parsed = parse(renderMetrics({
    ...FACTS,
    plans: [{ ...PLAN, phases: 0, done: 0, ready: 0, waiting: 0, inProgress: 0, stuck: 0 }],
  }));
  assert.equal(valueOf(parsed, 'phase_console_plan_progress_ratio', { slug: 'demo-plan' }), 0);
});

test('closed plans are counted as closed rather than hidden', () => {
  const parsed = parse(renderMetrics(FACTS));
  assert.equal(valueOf(parsed, 'phase_console_plans', { status: 'active', closed: '0' }), 1);
  assert.equal(valueOf(parsed, 'phase_console_plans', { status: 'complete', closed: '1' }), 1);
});

test('no day cap is ABSENT, never zero — a zero would alert as "the ladder can never spend again"', () => {
  const capped = parse(renderMetrics(FACTS));
  assert.equal(valueOf(capped, 'phase_console_day_cap_usd'), 20);

  const uncapped = parse(renderMetrics({ ...FACTS, today: { ...FACTS.today, capUsd: null } }));
  assert.equal(valueOf(uncapped, 'phase_console_day_cap_usd'), undefined);
  assert.ok(!uncapped.type.has('phase_console_day_cap_usd'), 'and no orphan TYPE line either');

  // A cap OF zero is a real setting — the operator who wants the ladder to
  // spend nothing — and must report as the number it is.
  const zero = parse(renderMetrics({ ...FACTS, today: { ...FACTS.today, capUsd: 0 } }));
  assert.equal(valueOf(zero, 'phase_console_day_cap_usd'), 0);
});

test('the residual is reported even when it is zero — a missing series cannot be alerted on', () => {
  const parsed = parse(renderMetrics(FACTS));
  assert.equal(valueOf(parsed, 'phase_console_spend_residual_usd', { slug: 'demo-plan' }), 0);
});

test('a non-finite figure is dropped, never printed as NaN', () => {
  const parsed = parse(renderMetrics({
    ...FACTS,
    cost: [{ slug: 'demo-plan', totalUsd: Number.NaN, attributedUsd: 1, residualUsd: 0, ladderUsd: 0 }],
  }));
  assert.equal(valueOf(parsed, 'phase_console_spend_usd_total', { slug: 'demo-plan' }), undefined);
  assert.equal(valueOf(parsed, 'phase_console_phase_spend_usd_total', { slug: 'demo-plan' }), 1);
});

test('an empty console still answers — build info, and nothing invented', () => {
  const parsed = parse(renderMetrics({
    plans: [], runs: [], cost: [], rungs: [],
    today: { settledUsd: 0, ladderUsd: 0, capUsd: null },
  }));
  assert.equal(valueOf(parsed, 'phase_console_build_info', { version: 'unknown', instance: 'unknown' }), 1);
  assert.equal(valueOf(parsed, 'phase_console_settled_usd_today'), 0);
  assert.equal(valueOf(parsed, 'phase_console_runs'), undefined, 'no runs means no run series at all');
});

test('the content type declares the format VERSION a scraper switches parsers on', () => {
  assert.match(METRICS_CONTENT_TYPE, /^text\/plain; version=0\.0\.4; charset=utf-8$/);
});

/* ------------------------------------------------------------------ *
 * the worktree families — absent, not zero
 * ------------------------------------------------------------------ */

test('the three worktree families scrape per slug, with the right types', () => {
  const parsed = parse(renderMetrics(FACTS));

  assert.equal(valueOf(parsed, 'phase_console_worktrees', { slug: 'demo-plan' }), 2);
  assert.equal(valueOf(parsed, 'phase_console_worktrees', { slug: 'busy-plan' }), 1);
  assert.equal(valueOf(parsed, 'phase_console_worktree_disk_bytes', { slug: 'demo-plan' }), 1_234_567);
  assert.equal(valueOf(parsed, 'phase_console_branch_conflicted_files', { slug: 'demo-plan' }), 3);

  // Gauges, all three. `_total` is the counter suffix and none of these is a
  // count that only goes up — a worktree is removed at settle, and a conflict
  // is the thing you want to see go back down.
  for (const name of [
    'phase_console_worktrees',
    'phase_console_worktree_disk_bytes',
    'phase_console_branch_conflicted_files',
  ]) {
    assert.equal(parsed.type.get(name), 'gauge', name);
    // Never a run id: a run id is minted per boarding, and a scraper keeps a
    // dead series forever.
    for (const sample of parsed.samples.filter((s) => s.name === name)) {
      assert.deepEqual(Object.keys(sample.labels), ['slug'], `${name} is labelled by slug and nothing else`);
    }
  }
});

test('a plan with an isolated run and a clean branch reports 0 — that is not the same as absent', () => {
  const parsed = parse(renderMetrics(FACTS));
  assert.equal(valueOf(parsed, 'phase_console_branch_conflicted_files', { slug: 'busy-plan' }), 0,
    'a measured zero is the healthy reading, and an alert has to be able to see it');
});

test('no isolated run means the families are ABSENT, not zero', () => {
  for (const git of [undefined, []]) {
    const parsed = parse(renderMetrics({ ...FACTS, git }));
    for (const name of [
      'phase_console_worktrees',
      'phase_console_worktree_disk_bytes',
      'phase_console_branch_conflicted_files',
    ]) {
      assert.equal(valueOf(parsed, name), undefined, `${name} invented a sample from no facts`);
      assert.ok(!parsed.type.has(name), `${name} left an orphan TYPE line behind`);
    }
    // And the rest of the scrape is untouched — a console with no isolated run
    // is the common case, not a degraded one.
    assert.equal(valueOf(parsed, 'phase_console_settled_usd_today'), 9.25);
  }
});

test('a du that could not answer drops ONE slug, not the family', () => {
  const parsed = parse(renderMetrics({
    ...FACTS,
    git: [
      { slug: 'demo-plan', worktrees: 2, conflictedFiles: 0 },
      { slug: 'busy-plan', worktrees: 1, diskBytes: 89_000, conflictedFiles: 0 },
    ],
  }));
  assert.equal(valueOf(parsed, 'phase_console_worktree_disk_bytes', { slug: 'demo-plan' }), undefined);
  assert.equal(valueOf(parsed, 'phase_console_worktree_disk_bytes', { slug: 'busy-plan' }), 89_000);
  // The count is a different measurement and is not lost with the bytes.
  assert.equal(valueOf(parsed, 'phase_console_worktrees', { slug: 'demo-plan' }), 2);
});
