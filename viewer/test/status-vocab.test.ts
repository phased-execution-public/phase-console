/**
 * The status vocabulary: one module, eight UI states, every word mapped.
 *
 * Two promises, held here because nothing else can hold them:
 *
 *   1. IDENTITY — the client's `lib/status-vocab.ts` re-exports the very
 *      objects `shared/status-vocab.js` exports. Not equal: the same. A copy
 *      would pass `deepEqual` today and drift tomorrow.
 *   2. TOTALITY — every run status, phase-record status and board state the
 *      server can write, and every situation the classifier can produce, maps
 *      to exactly one UI state; every UI state has a label, a hue of its own
 *      name, a tone family and an icon. A new word that lands unmapped reads
 *      as the unknown state on every page, and this test names it first.
 *
 * The RUN and PHASE word lists are taken from the SERVER's own type unions
 * (`server/runner/state.ts`) by reading the source — the types erase at
 * runtime, and a hand-copied list here would be a third place to forget.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTOR_UI,
  BOARD_LABELS,
  BOARD_STATE_UI,
  PHASE_STATUS_UI,
  RUN_STATUS_UI,
  STATE_META,
  UI_STATES,
  UNKNOWN_STATE,
  actorUiState,
  boardLabel,
  boardUiState,
  isUiState,
  phaseUiState,
  runUiState,
  situationUiState,
  uiLabel,
  uiState,
  wordUiState,
  worstOf,
} from '../shared/status-vocab.js';
import { SITUATIONS, SITUATION_ACTOR } from '../shared/situation-model.js';
import { BOARD_ORDER } from '../shared/phase-model.js';
import { PHASE_STATUSES, RUN_STATUSES } from '../shared/run-lifecycle.js';
import { QA_RESULTS } from '../shared/plan-vocab.js';
import { describeWord } from '../shared/status-model.js';

/**
 * The status words the server actually writes.
 *
 * This used to SCRAPE `server/runner/state.ts` for a `RunStatus = 'a' | 'b'`
 * union, because that file was where the words lived and a scrape was the only
 * way to catch a drift the compiler could not see. Since the lifecycle
 * vocabularies moved to `shared/run-lifecycle.js` there is no second copy to
 * drift FROM: `state.ts` aliases the owner's typedef, and
 * `vocab-owners.test.ts` holds every other shadow to the same object. So the
 * words come from the owner, by identity, and the assertions below keep their
 * whole point — that the paint tables map exactly the words the server writes,
 * with nothing unmapped and nothing stale.
 */
const SERVER_RUN_STATUSES: readonly string[] = RUN_STATUSES;
const SERVER_PHASE_STATUSES: readonly string[] = PHASE_STATUSES;

// 6.0 (control-tower phase 31): the two "twelve words" assertions are retired —
// a floor on how MANY words the server writes, and a pin of where each one
// landed in the one-question paint map. What a word looks like is now decided
// by the status model's first-match DECISION TABLE (`describeRun`,
// `describePhase`, `describeWord` in `shared/status-model.js`), which
// `status-model.test.ts` holds row by row; this file keeps totality and
// identity. What it adds is the join: every word the server writes has a row
// in that table, so no page can draw one as the Unknown.
test('every run and phase word the server writes is decided by the model’s table, never Unknown', () => {
  for (const word of SERVER_RUN_STATUSES) {
    const view = describeWord('run', word);
    assert.equal(view.known, true, `run word ${word} has no row in WORD_ROWS.run`);
    assert.ok(isUiState(view.paint), `run word ${word} paints ${view.paint}`);
  }
  for (const word of SERVER_PHASE_STATUSES) {
    const view = describeWord('phase', word);
    assert.equal(view.known, true, `phase word ${word} has no row in WORD_ROWS.phase`);
    assert.ok(isUiState(view.paint), `phase word ${word} paints ${view.paint}`);
  }
});

test('eight UI states, worst first, each with a label, its own hue, a tone and an icon', () => {
  assert.deepEqual([...UI_STATES], ['needs-you', 'failed', 'running', 'verifying', 'waiting', 'queued', 'skipped', 'done']);
  assert.ok(Object.isFrozen(UI_STATES));
  assert.ok(Object.isFrozen(STATE_META));
  for (const state of UI_STATES) {
    const meta = STATE_META[state];
    assert.ok(meta, state);
    assert.ok(meta.label.length >= 4, `${state} label`);
    assert.equal(meta.hue, state, `${state} paints with its own token`);
    assert.ok(['accent', 'bad', 'live', 'wait', 'neutral', 'ok'].includes(meta.tone), `${state} tone`);
    assert.ok(/^[a-z-]+$/.test(meta.icon), `${state} icon is a lucide name`);
  }
  // Amber is one state's: only needs-you is the accent family.
  assert.deepEqual(UI_STATES.filter((s) => STATE_META[s].tone === 'accent'), ['needs-you']);
  assert.deepEqual(Object.keys(STATE_META).sort(), [...UI_STATES].sort());
});

test('every server run status and phase status maps to exactly one UI state', () => {
  for (const word of SERVER_RUN_STATUSES) {
    assert.ok(word in RUN_STATUS_UI, `run status "${word}" is unmapped`);
    assert.ok(isUiState(RUN_STATUS_UI[word as keyof typeof RUN_STATUS_UI]), word);
  }
  for (const word of SERVER_PHASE_STATUSES) {
    assert.ok(word in PHASE_STATUS_UI, `phase status "${word}" is unmapped`);
    assert.ok(isUiState(PHASE_STATUS_UI[word as keyof typeof PHASE_STATUS_UI]), word);
  }
  // …and nothing the server does not write is mapped either (a stale word
  // would explain itself on a page nobody can reach).
  for (const word of Object.keys(RUN_STATUS_UI)) assert.ok(SERVER_RUN_STATUSES.includes(word), `RUN_STATUS_UI.${word} is not a server status`);
  for (const word of Object.keys(PHASE_STATUS_UI)) assert.ok(SERVER_PHASE_STATUSES.includes(word), `PHASE_STATUS_UI.${word} is not a server status`);
});

test('every board state the engine emits maps, and the board order names only mapped words', () => {
  for (const word of ['done', 'in-progress', 'ready', 'waiting', 'gated', 'blocked', 'stuck']) {
    assert.ok(isUiState(BOARD_STATE_UI[word as keyof typeof BOARD_STATE_UI]), `board ${word}`);
  }
  for (const word of BOARD_ORDER) assert.ok(word in BOARD_STATE_UI, `BOARD_ORDER has unmapped "${word}"`);
  assert.equal(boardUiState('ready'), 'queued');
  assert.equal(boardLabel('ready'), 'Next up');
  assert.equal(BOARD_LABELS.ready, 'Next up');
  assert.equal(boardLabel('done'), 'Done');
  assert.equal(boardLabel('stuck'), 'Needs you');
});

test('every situation has a UI state through its actor, imported from the situation model', () => {
  for (const id of SITUATIONS) {
    const actor = SITUATION_ACTOR[id];
    assert.ok(actor in ACTOR_UI, `actor "${actor}" of ${id} is unmapped`);
    assert.equal(situationUiState(id), ACTOR_UI[actor], id);
  }
  assert.equal(actorUiState('machine'), 'running');
  assert.equal(actorUiState('machine', { errand: { need: 'x' } }), 'needs-you', 'a machine situation with an errand is a person\'s');
  assert.equal(actorUiState('person'), 'needs-you');
  assert.equal(actorUiState('wait'), 'waiting');
  assert.equal(actorUiState('none'), 'done');
  assert.equal(situationUiState('plan-broken', { errand: true }), 'needs-you');
});

test('unknown words read as the unknown state — never amber, never green', () => {
  assert.equal(UNKNOWN_STATE, 'waiting');
  assert.equal(runUiState('quantum-superposition'), UNKNOWN_STATE);
  assert.equal(phaseUiState(undefined), UNKNOWN_STATE);
  assert.equal(boardUiState(null), UNKNOWN_STATE);
  assert.equal(wordUiState('--allow-run'), null);
  assert.equal(uiLabel('nonsense'), STATE_META[UNKNOWN_STATE].label);
  assert.notEqual(STATE_META[UNKNOWN_STATE].tone, 'accent');
  assert.notEqual(STATE_META[UNKNOWN_STATE].tone, 'ok');
});

test('worstOf and uiState decide by precedence, with the board\'s done above everything', () => {
  assert.equal(worstOf(['done', 'running', 'waiting']), 'running');
  assert.equal(worstOf(['queued', 'needs-you']), 'needs-you');
  assert.equal(worstOf([]), UNKNOWN_STATE);
  // A run that is running with a phase record failed → failed outranks running.
  assert.equal(uiState({ run: 'running', record: 'failed' }), 'failed');
  // An approval waiting beats everything but the board saying done.
  assert.equal(uiState({ run: 'running', approvals: 2 }), 'needs-you');
  assert.equal(uiState({ run: 'running', board: 'done', approvals: 2 }), 'done');
  // A record the board has overtaken is history: board done wins over failed.
  assert.equal(uiState({ record: 'failed', board: 'done' }), 'done');
  // A parked record on a ready board phase needs a person.
  assert.equal(uiState({ record: 'parked', board: 'ready' }), 'needs-you');
  // Situations, three ways in: id, {id}, {actor}.
  assert.equal(uiState({ situation: 'gated-manual' }), 'needs-you');
  assert.equal(uiState({ situation: { id: 'foreign-live' } }), 'waiting');
  assert.equal(uiState({ situation: { actor: 'machine' } }), 'running');
  assert.equal(uiState({ situation: { actor: 'machine' }, errand: { need: 'sign in' } }), 'needs-you');
  // Nothing known is the unknown state.
  assert.equal(uiState({}), UNKNOWN_STATE);
  assert.equal(uiState(), UNKNOWN_STATE);
});

test('wordUiState answers for every vocabulary and the UI states themselves', () => {
  assert.equal(wordUiState('halted'), 'needs-you');
  assert.equal(wordUiState('verifying'), 'verifying');
  assert.equal(wordUiState('ready'), 'queued');
  assert.equal(wordUiState('needs-you'), 'needs-you');
  assert.equal(wordUiState('Departed'), null, 'the departures spellings are gone');
});

test('the client re-exports the SAME vocabulary objects (identity, not a copy)', async () => {
  const client = await import('../client/src/lib/status-vocab.ts');
  assert.equal(client.UI_STATES, UI_STATES);
  assert.equal(client.STATE_META, STATE_META);
  assert.equal(client.RUN_STATUS_UI, RUN_STATUS_UI);
  assert.equal(client.PHASE_STATUS_UI, PHASE_STATUS_UI);
  assert.equal(client.BOARD_STATE_UI, BOARD_STATE_UI);
  assert.equal(client.ACTOR_UI, ACTOR_UI);
  assert.equal(client.uiState, uiState);
  assert.equal(client.runUiState, runUiState);
  assert.equal(client.phaseUiState, phaseUiState);
  assert.equal(client.boardUiState, boardUiState);
  assert.equal(client.situationUiState, situationUiState);
  assert.equal(client.wordUiState, wordUiState);
  // The client's explanations cover every word the shared tables know, and
  // every UI state — the hover and the Guide read these.
  for (const word of Object.keys(RUN_STATUS_UI)) assert.ok(client.RUN_STATUS_HELP[word as keyof typeof client.RUN_STATUS_HELP], `help for run ${word}`);
  for (const word of Object.keys(PHASE_STATUS_UI)) assert.ok(client.PHASE_STATUS_HELP[word as keyof typeof client.PHASE_STATUS_HELP], `help for phase ${word}`);
  for (const word of Object.keys(BOARD_STATE_UI)) assert.ok(client.BOARD_STATE_HELP[word as keyof typeof client.BOARD_STATE_HELP], `help for board ${word}`);
  for (const state of UI_STATES) assert.ok(client.UI_STATE_HELP[state], `help for ui ${state}`);
  // QA verdicts map too, and never to amber: a verdict is a fact, not an ask.
  // Since control-tower phase 16 a verdict's paint is the status model's
  // `qa-result` row, drawn by `QaBadge`; the client keeps only what it MEANS.
  assert.equal('qaUiState' in client, false, 'the QA paint table was folded into the status model');
  const paint = (word: string | undefined) => describeWord('qa-result', word);
  assert.equal(paint('pass').paint, 'done');
  assert.equal(paint('fail').paint, 'failed');
  assert.equal(paint('waived').paint, 'skipped');
  assert.equal(paint('pending').paint, 'queued');
  assert.equal(paint(undefined).known, false, 'no verdict is Unknown, not a verdict');
  for (const word of [...QA_RESULTS, 'unknown', undefined]) {
    assert.equal(paint(word).attention, 'none', `QA ${word ?? '(none)'} asks nothing of a person`);
    assert.notEqual(paint(word).paint, 'needs-you', `QA ${word ?? '(none)'} is never amber`);
  }
  for (const result of QA_RESULTS) assert.ok(client.QA_RESULT_HELP[result], `help for QA ${result}`);
});

