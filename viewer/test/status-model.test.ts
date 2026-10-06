/**
 * Status model v2 (control-tower phase 16) — `shared/status-model.js`.
 *
 * Three promises, each one a defect the 2026-09-21 audit measured on both
 * consoles of the operator's machine:
 *
 *  1. TOTAL. Every word of every vocabulary the console paints has a row — the
 *     row set is held to the OWNER list by import, never to a copy, so a word
 *     added to an owner fails here before it can reach a page as grey text.
 *  2. AMBER IS A SUMMONS. A status word never makes amber by itself: only an
 *     open inbox item, or a word that IS a person-actor situation (named in
 *     `PERSON_WORDS`, each with its reason), may paint `needs-you`.
 *  3. THE CORPUS. The live cases — paused runs on closed plans that read
 *     "Waiting", stale stops on closed plans that read amber, finished runs
 *     holding failures that read green — resolve as §Architecture 3 says.
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTENTION_LEVELS,
  ATTENTION_META,
  BAYS,
  FACT_KINDS,
  FACT_META,
  NOTE_SEVERITIES,
  OUTCOMES,
  PERSON_WORDS,
  STALE_AFTER_MS,
  STATUS_ICON_NAMES,
  STATUS_VOCABS,
  TENSES,
  UNKNOWN_ICON,
  WORD_ROWS,
  bayOf,
  describePhase,
  describeRun,
  describeWord,
} from '../shared/status-model.js';
import {
  BOARD_BUCKETS,
  BOARD_OVERLAY_STATES,
  STATE_META,
  UI_STATES,
  runUiState,
} from '../shared/status-vocab.js';
import { PHASE_STATUSES, PRESENCE, RUNG_OUTCOMES, RUN_STATUSES, WATCH_STATES } from '../shared/run-lifecycle.js';
import { RUNG_FAILURE_CAUSES } from '../shared/ladder-model.js';
import { GATE_KINDS, PLAN_STATUSES, QA_MODES, QA_RESULT_WORDS, isClosedPlanStatus } from '../shared/plan-vocab.js';
import {
  AUTH_STATES,
  DELIVERY_OUTCOMES,
  ENTITLEMENT_STATES,
  HEALTH_SEVERITIES,
  MCP_STATUSES,
  PROBE_STATUSES,
  RESTART_UPDATE_STATES,
  TERMINAL_STATES,
} from '../shared/ops-vocab.js';
import { LIVENESS } from '../shared/fleet-model.js';
import { DECISION_STATES } from '../shared/decisions-model.js';
import { CHECKOUT_ROLES, CHECKOUT_STATES, RADAR_STATES, SETTLE_KINDS } from '../shared/worktree-model.js';
import { LANDING_STATES } from '../shared/landing-model.js';
import { HANDOFF_WORDS, VERIFICATION_WORDS } from '../shared/evidence-model.js';
import { INBOX_SEVERITIES } from '../shared/attention-model.js';
import { ISSUE_CATEGORIES, ISSUE_PLAN_STATES, ISSUE_SEVERITY_WORDS } from '../shared/issues-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sorted = (xs: readonly string[]) => [...xs].sort();

/**
 * Each vocabulary the model paints, and the OWNER list its rows are held to.
 * The keys are the model's vocabulary ids; the values are imported, so the
 * owner — not this file — decides the members.
 */
const OWNERS: Record<string, readonly string[]> = {
  run: RUN_STATUSES,
  phase: PHASE_STATUSES,
  board: [...BOARD_BUCKETS, ...BOARD_OVERLAY_STATES],
  plan: PLAN_STATUSES,
  handoff: HANDOFF_WORDS,
  'qa-result': QA_RESULT_WORDS,
  'qa-mode': QA_MODES,
  gate: GATE_KINDS,
  mcp: MCP_STATUSES,
  auth: AUTH_STATES,
  entitlement: ENTITLEMENT_STATES,
  delivery: DELIVERY_OUTCOMES,
  watch: WATCH_STATES,
  decision: DECISION_STATES,
  presence: PRESENCE,
  terminal: TERMINAL_STATES,
  liveness: LIVENESS,
  rung: RUNG_OUTCOMES,
  rungCause: RUNG_FAILURE_CAUSES,
  health: HEALTH_SEVERITIES,
  probe: PROBE_STATUSES,
  restart: RESTART_UPDATE_STATES,
  checkout: CHECKOUT_STATES,
  radar: RADAR_STATES,
  settle: SETTLE_KINDS,
  'checkout-role': CHECKOUT_ROLES,
  landing: LANDING_STATES,
  verification: VERIFICATION_WORDS,
  'issue-category': ISSUE_CATEGORIES,
  'issue-severity': ISSUE_SEVERITY_WORDS,
  'issue-plan': ISSUE_PLAN_STATES,
  note: NOTE_SEVERITIES,
};

/* ------------------------------------------------------------------ *
 * 1. Total
 * ------------------------------------------------------------------ */

test('the model paints exactly the vocabularies this file holds to an owner', () => {
  assert.deepEqual(sorted(STATUS_VOCABS), sorted(Object.keys(OWNERS)));
  assert.deepEqual(sorted(Object.keys(WORD_ROWS)), sorted(STATUS_VOCABS));
});

for (const [vocab, members] of Object.entries(OWNERS)) {
  test(`every ${vocab} word has a row, and no row names a word the owner lacks`, () => {
    const rows = (WORD_ROWS as Record<string, Record<string, unknown>>)[vocab];
    assert.ok(rows, `${vocab} has no row table`);
    assert.deepEqual(sorted(Object.keys(rows)), sorted(members), `${vocab} rows drifted from their owner`);
  });
}

test('every row is a precise word, an icon and a paint on the closed axes', () => {
  for (const vocab of STATUS_VOCABS) {
    for (const [word, row] of Object.entries(WORD_ROWS[vocab])) {
      const at = `${vocab}:${word}`;
      assert.ok(row.label.trim().length > 0, `${at} has no label`);
      assert.match(row.icon, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${at} icon is not a lucide name`);
      assert.ok((UI_STATES as readonly string[]).includes(row.paint), `${at} paints ${row.paint}`);
      assert.ok((TENSES as readonly string[]).includes(row.tense), `${at} tense ${row.tense}`);
      assert.ok((ATTENTION_LEVELS as readonly string[]).includes(row.attention), `${at} attention ${row.attention}`);
      if (row.outcome !== undefined) {
        assert.ok((OUTCOMES as readonly string[]).includes(row.outcome), `${at} outcome ${row.outcome}`);
      }
      assert.ok(STATUS_ICON_NAMES.includes(row.icon), `${at} icon ${row.icon} is not in STATUS_ICON_NAMES`);
    }
  }
});

test('a settled row says how it ended; a live or standing row does not pretend to', () => {
  for (const vocab of STATUS_VOCABS) {
    for (const [word, row] of Object.entries(WORD_ROWS[vocab])) {
      if (row.tense !== 'settled') assert.equal(row.outcome, undefined, `${vocab}:${word} is ${row.tense} with an outcome`);
    }
  }
});

test('the attention axis is `none` plus the inbox severities, quietest first', () => {
  assert.deepEqual([...ATTENTION_LEVELS], ['none', ...[...INBOX_SEVERITIES].reverse()]);
  assert.deepEqual(sorted(Object.keys(ATTENTION_META)), sorted(ATTENTION_LEVELS));
  assert.deepEqual([...TENSES], ['live', 'standing', 'settled']);
  assert.deepEqual([...OUTCOMES], ['ok', 'partial', 'failed', 'stopped', 'superseded', 'unknown']);
  assert.deepEqual([...BAYS], ['needs-you', 'live', 'waiting', 'queued', 'ready', 'settled']);
  assert.equal(STALE_AFTER_MS, 7 * 864e5);
  assert.deepEqual(sorted(Object.keys(FACT_META)), sorted(FACT_KINDS));
  for (const kind of FACT_KINDS) assert.ok(STATUS_ICON_NAMES.includes(FACT_META[kind].icon), `${kind} icon`);
  for (const level of ATTENTION_LEVELS) assert.ok(STATUS_ICON_NAMES.includes(ATTENTION_META[level].icon), `${level} icon`);
  assert.ok(STATUS_ICON_NAMES.includes(UNKNOWN_ICON));
  assert.equal(new Set(STATUS_ICON_NAMES).size, STATUS_ICON_NAMES.length, 'icon names are listed once');
});

/* ------------------------------------------------------------------ *
 * 2. Amber is a summons
 * ------------------------------------------------------------------ */

test('amber rows are exactly the person-actor words, and each says why', () => {
  const amber: string[] = [];
  for (const vocab of STATUS_VOCABS) {
    for (const [word, row] of Object.entries(WORD_ROWS[vocab])) {
      const summons = row.attention === 'needs-you' || row.attention === 'urgent';
      assert.equal(row.paint === 'needs-you', summons, `${vocab}:${word} — amber paint and a summons must agree`);
      if (summons) amber.push(`${vocab}:${word}`);
    }
  }
  assert.deepEqual(sorted(amber), sorted(Object.keys(PERSON_WORDS)));
  for (const [key, why] of Object.entries(PERSON_WORDS)) assert.ok(why.length > 20, `${key} names no reason`);
});

test('no run or board word is amber by itself', () => {
  for (const vocab of ['run', 'board']) {
    for (const [word, row] of Object.entries(WORD_ROWS[vocab])) {
      assert.notEqual(row.paint, 'needs-you', `${vocab}:${word} is amber from the word alone`);
    }
  }
  // The one phase word that is: a sign-off only a person can give — the phase
  // twin of a run's `person` wait.
  const phaseAmber = Object.entries(WORD_ROWS.phase).filter(([, row]) => row.paint === 'needs-you').map(([w]) => w);
  assert.deepEqual(phaseAmber, ['awaiting-verification']);
});

test('`stuck` reads the same wherever it is drawn: not red, not amber, until somebody is asked', () => {
  const alone = describePhase(null, { boardState: 'stuck' });
  assert.equal(alone.paint, 'waiting');
  assert.equal(alone.attention, 'fyi');
  const asked = describePhase(null, {
    boardState: 'stuck',
    slug: 'p',
    phase: 3,
    inbox: [{ kind: 'errand', severity: 'needs-you', slug: 'p', phase: 3 }],
  });
  assert.equal(asked.paint, 'needs-you');
  assert.equal(asked.attention, 'needs-you');
});

/* ------------------------------------------------------------------ *
 * 3. describeWord — a pure lookup, and a first-class Unknown
 * ------------------------------------------------------------------ */

test('a known word reads its row; the word and vocabulary ride along', () => {
  const v = describeWord('qa-result', 'fail');
  assert.equal(v.vocab, 'qa-result');
  assert.equal(v.word, 'fail');
  assert.equal(v.known, true);
  assert.equal(v.paint, 'failed');
  assert.equal(v.tense, 'settled');
  assert.equal(v.outcome, 'failed');
});

test('a word outside the vocabulary is Unknown — its own icon, never Waiting', () => {
  for (const [vocab, word] of [
    ['plan', '✅ GO'],
    ['plan', null],
    ['qa-result', 'running'],
    ['mcp', ''],
    ['nonsense-vocabulary', 'done'],
  ] as const) {
    const v = describeWord(vocab as never, word as never);
    assert.equal(v.known, false, `${vocab}:${String(word)}`);
    assert.equal(v.label, 'Unknown');
    assert.equal(v.icon, UNKNOWN_ICON);
    assert.notEqual(v.icon, STATE_META.waiting.icon);
    assert.notEqual(v.paint, 'waiting');
    assert.notEqual(v.paint, 'needs-you');
    assert.equal(v.attention, 'none');
  }
  // A word some OTHER vocabulary owns is still unknown here: `done` is a phase
  // word, not a plan status.
  assert.equal(describeWord('plan', 'done').known, false);
});

/* ------------------------------------------------------------------ *
 * 4. describeRun — the first-match table
 * ------------------------------------------------------------------ */

const NOW = Date.parse('2026-09-23T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 864e5).toISOString();

test('closed plan, resolved run, or a newer run of the slug: settled, superseded, quiet', () => {
  const closed = describeRun({ id: 'a', slug: 's', status: 'paused', updatedAt: ago(1) }, { planClosed: true, now: NOW });
  assert.deepEqual(
    [closed.paint, closed.attention, closed.tense, closed.outcome, closed.label, closed.note?.kind],
    ['skipped', 'none', 'settled', 'superseded', 'Paused', 'plan-closed'],
  );
  const resolved = describeRun({ id: 'b', slug: 's', status: 'halted', resolved: { at: ago(2) } }, { now: NOW });
  assert.deepEqual([resolved.outcome, resolved.note?.kind, resolved.attention], ['superseded', 'resolved', 'none']);
  const overtaken = describeRun({ id: 'c', slug: 's', status: 'interrupted' }, { newerRunId: 'd', now: NOW });
  assert.deepEqual([overtaken.outcome, overtaken.note?.kind, overtaken.paint], ['superseded', 'overtaken', 'skipped']);
  // An open inbox item cannot make a closed plan's leftover amber.
  const loud = describeRun(
    { id: 'e', slug: 's', status: 'parked' },
    { planClosed: true, inbox: [{ kind: 'errand', severity: 'urgent', runId: 'e', slug: 's' }], now: NOW },
  );
  assert.equal(loud.attention, 'none');
});

test('a finished run is done when every phase it touched settled well, partial when one did not', () => {
  const clean = describeRun({ id: 'a', slug: 's', status: 'finished', phases: { 1: { status: 'done' }, 2: { status: 'skipped' }, 3: { status: 'pending' } } }, { now: NOW });
  assert.deepEqual([clean.paint, clean.tense, clean.outcome, clean.note], ['done', 'settled', 'ok', undefined]);
  const partial = describeRun(
    { id: 'b', slug: 's', status: 'finished', phases: { 1: { status: 'done' }, 2: { status: 'failed' }, 3: { status: 'parked' } } },
    { now: NOW },
  );
  assert.deepEqual([partial.paint, partial.outcome, partial.attention, partial.label], ['skipped', 'partial', 'none', 'Finished']);
  assert.equal(partial.note?.kind, 'failed-count');
  assert.equal(partial.note?.count, 2);
  assert.equal(partial.note?.paint, 'failed');
  assert.equal(partial.note?.text, '1 failed, 1 parked');
  // A done phase that still holds an errand is owed something — not settled well.
  const owed = describeRun(
    { id: 'c', slug: 's', status: 'finished', phases: { 1: { status: 'done' } }, recoveries: { 1: { errand: { need: 'x' } } } },
    { now: NOW },
  );
  assert.equal(owed.outcome, 'partial');
  // And a finished run keeps its outcome when its plan closes afterwards.
  const later = describeRun({ id: 'd', slug: 's', status: 'finished', phases: { 1: { status: 'failed' } } }, { planClosed: true, now: NOW });
  assert.equal(later.outcome, 'partial');
});

test('stopped by the operator: queued, and it says who', () => {
  const paused = describeRun({ id: 'a', slug: 's', status: 'paused', stoppedBy: 'operator' }, { now: NOW });
  assert.deepEqual([paused.paint, paused.label, paused.tense, paused.attention], ['queued', 'Paused by you', 'standing', 'none']);
  const stopped = describeRun({ id: 'b', slug: 's', status: 'interrupted', stoppedBy: 'operator', halt: { kind: 'operator-stop' } }, { now: NOW });
  assert.deepEqual([stopped.paint, stopped.label], ['queued', 'Stopped by you']);
});

test('a live loop is running, and the act landing on it is the label', () => {
  for (const [status, label] of [['running', 'Running'], ['pausing', 'Pausing'], ['stopping', 'Stopping'], ['halting', 'Halting']] as const) {
    const v = describeRun({ id: 'a', slug: 's', status }, { now: NOW });
    assert.deepEqual([v.paint, v.tense, v.label, v.attention], ['running', 'live', label, 'none'], status);
  }
  const frozen = describeRun({ id: 'b', slug: 's', status: 'frozen' }, { now: NOW });
  assert.deepEqual([frozen.label, frozen.icon, frozen.paint], ['Frozen', 'snowflake', 'waiting']);
});

test('a wait says what it waits on; only a person wait is amber; scope is a queue', () => {
  const person = describeRun({ id: 'a', slug: 's', status: 'waiting', waitReason: 'person' }, { now: NOW });
  assert.deepEqual([person.paint, person.attention], ['needs-you', 'needs-you']);
  for (const kind of ['usage-limit', 'external', 'schedule', 'connectivity', 'engine-busy']) {
    const v = describeRun({ id: 'b', slug: 's', status: 'waiting', waitReason: kind }, { now: NOW });
    assert.deepEqual([v.paint, v.attention, v.note?.kind], ['waiting', 'none', 'waiting-on'], kind);
    assert.ok(v.note?.text, kind);
  }
  const scope = describeRun({ id: 'c', slug: 's', status: 'queued' }, { now: NOW });
  assert.deepEqual([scope.paint, scope.tense], ['queued', 'standing']);
});

test('a stop is amber only with an open inbox item — red when that item is urgent', () => {
  const run = { id: 'r1', slug: 's', status: 'halted', updatedAt: ago(1) };
  const asked = describeRun(run, { inbox: [{ kind: 'errand', severity: 'needs-you', runId: 'r1', slug: 's' }], now: NOW });
  assert.deepEqual([asked.paint, asked.attention, asked.tense], ['needs-you', 'needs-you', 'standing']);
  const urgent = describeRun(run, { inbox: [{ kind: 'approval', severity: 'urgent', runId: 'r1', slug: 's' }], now: NOW });
  assert.deepEqual([urgent.paint, urgent.attention], ['failed', 'urgent']);
  const fyi = describeRun(run, { inbox: [{ kind: 'policy', severity: 'fyi', runId: 'r1', slug: 's' }], now: NOW });
  assert.notEqual(fyi.paint, 'needs-you');
  const other = describeRun(run, { inbox: [{ kind: 'errand', severity: 'needs-you', runId: 'r2', slug: 'other' }], now: NOW });
  assert.notEqual(other.paint, 'needs-you', 'another run’s item is not this run’s summons');
  const recovering = describeRun(run, { rungsLeft: true, now: NOW });
  assert.deepEqual([recovering.paint, recovering.label, recovering.note?.kind, recovering.tense], ['running', 'Halted', 'recovering', 'live']);
  const quiet = describeRun(run, { now: NOW });
  assert.deepEqual([quiet.paint, quiet.attention, quiet.tense], ['waiting', 'fyi', 'standing']);
});

test('a stop nobody answered for a week goes dormant: quiet, settled, never amber', () => {
  for (const status of ['halted', 'parked', 'interrupted', 'paused']) {
    const v = describeRun({ id: 'a', slug: 's', status, updatedAt: ago(8) }, { now: NOW });
    assert.deepEqual([v.attention, v.tense, v.outcome, v.paint, v.note?.kind], ['none', 'settled', 'unknown', 'skipped', 'dormant'], status);
    assert.equal(v.staleSince, ago(8));
  }
  const fresh = describeRun({ id: 'b', slug: 's', status: 'interrupted', updatedAt: ago(6) }, { now: NOW });
  assert.equal(fresh.staleSince, undefined);
});

test('a run status outside the vocabulary is Unknown, never Waiting', () => {
  const v = describeRun({ id: 'a', slug: 's', status: 'complete' }, { now: NOW });
  assert.deepEqual([v.known, v.label, v.icon], [false, 'Unknown', UNKNOWN_ICON]);
  assert.notEqual(v.paint, 'waiting');
});

test('icons are per word', () => {
  const icon = (status: string) => describeRun({ id: 'a', slug: 's', status }, { now: NOW }).icon;
  assert.equal(icon('paused'), 'pause');
  assert.equal(icon('frozen'), 'snowflake');
  assert.equal(icon('stopping'), 'square');
  assert.equal(icon('halted'), 'octagon-alert');
  assert.equal(icon('parked'), 'circle-parking');
  assert.equal(icon('interrupted'), 'unplug');
  const icons = RUN_STATUSES.map((s) => WORD_ROWS.run[s].icon);
  assert.equal(new Set(icons).size, icons.length, 'no two run words share an icon');
});

/* ------------------------------------------------------------------ *
 * 5. describePhase
 * ------------------------------------------------------------------ */

test('the board saying done wins over any record; a closed plan quiets the rest', () => {
  assert.equal(describePhase({ status: 'failed' }, { boardState: 'done' }).paint, 'done');
  const closed = describePhase({ status: 'parked' }, { boardState: 'stuck', planClosed: true });
  assert.deepEqual([closed.paint, closed.attention, closed.outcome], ['skipped', 'none', 'superseded']);
});

test('a sign-off a person owes is amber; a park is amber only with its inbox item', () => {
  assert.equal(describePhase({ status: 'awaiting-verification' }, {}).attention, 'needs-you');
  const parked = describePhase({ status: 'parked' }, { slug: 'p', phase: 2 });
  assert.deepEqual([parked.paint, parked.attention], ['waiting', 'fyi']);
  const asked = describePhase({ status: 'parked' }, { slug: 'p', phase: 2, inbox: [{ kind: 'gate', severity: 'needs-you', slug: 'p', phase: 2 }] });
  assert.equal(asked.paint, 'needs-you');
  const elsewhere = describePhase({ status: 'parked' }, { slug: 'p', phase: 2, inbox: [{ kind: 'gate', severity: 'needs-you', slug: 'p', phase: 5 }] });
  assert.notEqual(elsewhere.paint, 'needs-you');
});

test('a running record with no session behind it is not live', () => {
  const live = describePhase({ status: 'running' }, { live: true });
  assert.deepEqual([live.tense, live.paint], ['live', 'running']);
  const orphan = describePhase({ status: 'running' }, { live: false });
  assert.notEqual(orphan.tense, 'live');
  assert.equal(orphan.note?.kind, 'no-session');
});

test('a ready phase is next up; an unknown record word is Unknown', () => {
  const ready = describePhase(null, { boardState: 'ready' });
  assert.deepEqual([ready.label, ready.paint, bayOf(ready)], ['Next up', 'queued', 'ready']);
  const odd = describePhase({ status: 'mystery' }, {});
  assert.deepEqual([odd.known, odd.icon], [false, UNKNOWN_ICON]);
});

/* ------------------------------------------------------------------ *
 * 6. bayOf
 * ------------------------------------------------------------------ */

test('every bay is reachable, and urgency decides it first', () => {
  const bays = new Set([
    bayOf(describeRun({ id: 'a', slug: 's', status: 'waiting', waitReason: 'person' }, { now: NOW })),
    bayOf(describeRun({ id: 'a', slug: 's', status: 'running' }, { now: NOW })),
    bayOf(describeRun({ id: 'a', slug: 's', status: 'waiting', waitReason: 'external' }, { now: NOW })),
    bayOf(describeRun({ id: 'a', slug: 's', status: 'queued' }, { now: NOW })),
    bayOf(describePhase(null, { boardState: 'ready' })),
    bayOf(describeRun({ id: 'a', slug: 's', status: 'finished' }, { now: NOW })),
  ]);
  assert.deepEqual(sorted([...bays]), sorted(BAYS));
  assert.equal(bayOf(describeRun({ id: 'a', slug: 's', status: 'halted', updatedAt: ago(30) }, { now: NOW })), 'settled', 'dormant is settled');
});

/* ------------------------------------------------------------------ *
 * 7. The live corpus
 * ------------------------------------------------------------------ */

type CorpusCase = {
  group: 'paused-on-closed-plan' | 'stale-stop-on-closed-plan' | 'finished-holding-failures';
  console: string;
  planStatus: string | null;
  run: { id: string; slug: string; status: string; updatedAt: string | null; phases: Record<string, { status: string }> };
  overtaken: boolean;
};
/**
 * The audit's cases are the `audit` block of the live-status corpus — the same
 * file whose `runs`/`phases` shapes `run-lifecycle.test.ts` folds (3.5.0).
 */
const CORPUS = (
  JSON.parse(readFileSync(join(HERE, 'fixtures/live-status-corpus.json'), 'utf8')) as {
    audit: {
      capturedAt: string;
      measured: Record<string, number | string>;
      counts: Record<string, number>;
      cases: CorpusCase[];
      planStatuses: { raw: string | null }[];
    };
  }
).audit;
const AT = Date.parse(CORPUS.capturedAt);
const ctxOf = (c: CorpusCase) => ({
  planClosed: isClosedPlanStatus(c.planStatus),
  newerRunId: c.overtaken ? 'a-newer-run' : null,
  inbox: [],
  now: AT,
});

test('the corpus still holds at least the audit’s cases', () => {
  for (const group of ['paused-on-closed-plan', 'stale-stop-on-closed-plan', 'finished-holding-failures']) {
    const n = CORPUS.cases.filter((c) => c.group === group).length;
    assert.equal(n, CORPUS.counts[group], `${group} count`);
    assert.ok(n >= Number(CORPUS.measured[group]), `${group}: ${n} cases, the audit measured ${CORPUS.measured[group]}`);
  }
});

test('dead paused runs on closed plans: settled, superseded, no attention (they read Waiting)', () => {
  for (const c of CORPUS.cases.filter((x) => x.group === 'paused-on-closed-plan')) {
    assert.equal(runUiState(c.run.status), 'waiting', 'the defect as measured');
    const v = describeRun(c.run, ctxOf(c));
    assert.deepEqual([v.tense, v.outcome, v.attention, v.paint], ['settled', 'superseded', 'none', 'skipped'], c.run.id);
    assert.equal(bayOf(v), 'settled');
  }
});

test('stale stops on closed plans: no amber (they read Needs you)', () => {
  for (const c of CORPUS.cases.filter((x) => x.group === 'stale-stop-on-closed-plan')) {
    assert.equal(runUiState(c.run.status), 'needs-you', 'the defect as measured');
    const v = describeRun(c.run, ctxOf(c));
    assert.notEqual(v.paint, 'needs-you', c.run.id);
    assert.equal(v.attention, 'none', c.run.id);
    assert.equal(v.outcome, 'superseded', c.run.id);
  }
  // …and a stale interrupted run on an OPEN plan with nothing in the inbox is
  // not amber either: waiting, then dormant.
  const open = CORPUS.cases.find((x) => x.group === 'stale-stop-on-closed-plan' && x.run.status === 'interrupted')!;
  const v = describeRun({ ...open.run, resolved: false }, { planClosed: false, inbox: [], now: AT });
  assert.notEqual(v.paint, 'needs-you');
});

test('finished runs holding failures: partial with a red count (they read green)', () => {
  for (const c of CORPUS.cases.filter((x) => x.group === 'finished-holding-failures')) {
    assert.equal(runUiState(c.run.status), 'done', 'the defect as measured');
    const v = describeRun(c.run, ctxOf(c));
    assert.deepEqual([v.outcome, v.paint, v.tense, v.attention], ['partial', 'skipped', 'settled', 'none'], c.run.id);
    assert.equal(v.note?.kind, 'failed-count', c.run.id);
    assert.ok((v.note?.count ?? 0) >= 1, c.run.id);
    assert.equal(v.note?.paint, 'failed');
  }
});

test('the live plan-status values: a stray value is Unknown, a real word is painted', () => {
  for (const { raw } of CORPUS.planStatuses) {
    const v = describeWord('plan', raw);
    assert.equal(v.known, (PLAN_STATUSES as readonly (string | null)[]).includes(raw), String(raw));
    if (!v.known) assert.equal(v.label, 'Unknown');
  }
  assert.equal(describeWord('plan', 'complete').paint, 'done');
  assert.notEqual(describeWord('plan', 'active').paint, 'skipped', 'an open plan is not grey');
});
