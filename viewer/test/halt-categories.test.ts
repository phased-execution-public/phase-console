/**
 * THE HALT CATEGORIES ARE TOTAL, AND A PARK HELD BY MANY THINGS SAYS WHICH.
 *
 * `shared/halt-categories.js` is the one answer to "what kind of stop is
 * this?" for every surface, so the bar is the fact map's: totality against the
 * OWNERS of each vocabulary, never against a list copied here —
 *
 *   1. every halt kind has a family, a family that exists, and one sentence;
 *   2. every situation has a family, and every sub-kind override names a real
 *      situation key;
 *   3. a `nothing-ready` park unpacks into one row per holder, each with ONE
 *      action — and a park held only by gates that clear themselves reads as a
 *      wait, on the card AND on the server's `situationOfHalt` (#48);
 *   4. the card's recommended verb is the recovery model's first, for every
 *      kind — never a second opinion.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAUSE_SENTENCE,
  HALT_CATEGORIES,
  HALT_CATEGORY_FIX,
  HALT_CATEGORY_LABELS,
  HALT_KIND_CATEGORY,
  HOLDER_ACTIONS,
  SITUATION_CATEGORY,
  SUB_KIND_CATEGORY,
  categoryOfHalt,
  haltSituation,
  holderViews,
  isAuthHalt,
  nothingReadySituation,
} from '../shared/halt-categories.js';
import { haltCtx, haltView } from '../shared/halt-view.js';
import { HALT_HOLDER_KINDS, HALT_HOLDER_VERBS, HALT_KINDS, recoveryActionsFor } from '../shared/recovery-model.js';
import { HALT_KIND_SITUATION } from '../shared/fact-map.js';
import { SITUATIONS, SUB_KINDS, situationKey } from '../shared/situation-model.js';
import { situationOfHalt } from '../server/service-core.ts';

test('every halt kind has a family that exists, and one sentence', () => {
  for (const kind of HALT_KINDS) {
    const category = HALT_KIND_CATEGORY[kind];
    assert.ok(category, `${kind} has no category`);
    assert.ok((HALT_CATEGORIES as readonly string[]).includes(category), `${kind} → ${category}, not a category`);
    const sentence = CAUSE_SENTENCE[kind];
    assert.ok(sentence && sentence.length > 20, `${kind} has no sentence`);
    // One sentence: a full stop at the end, and none in the middle.
    assert.match(sentence, /\.$/, `${kind}'s sentence ends on a full stop`);
    assert.equal(sentence.slice(0, -1).includes('. '), false, `${kind}'s sentence is one sentence`);
  }
  // Nothing extra: a sentence for a kind that does not exist paints nothing.
  assert.deepEqual(Object.keys(CAUSE_SENTENCE).sort(), [...HALT_KINDS].sort());
  assert.deepEqual(Object.keys(HALT_KIND_CATEGORY).sort(), [...HALT_KINDS].sort());
});

test('every family has a label and a fix, and every family is reachable from a kind', () => {
  for (const category of HALT_CATEGORIES) {
    assert.ok(HALT_CATEGORY_LABELS[category], `${category} has no label`);
    assert.ok(HALT_CATEGORY_FIX[category], `${category} has no fix`);
  }
  const reached = new Set(Object.values(HALT_KIND_CATEGORY));
  for (const category of HALT_CATEGORIES) assert.ok(reached.has(category), `no kind lands in ${category}`);
});

test('§Architecture 4: the table places each kind it names', () => {
  const expect: Record<string, string> = {
    'needs-human': 'decision',
    'awaiting-person': 'decision',
    'plan-deadlocked': 'decision',
    'plan-approval': 'decision',
    'credential-refused': 'credentials',
    'run-preflight': 'credentials',
    'models-exhausted': 'limits',
    budget: 'limits',
    'mcp-preflight': 'environment',
    'recovery-failed': 'environment',
    'phase-crashed': 'environment',
    'plan-lint': 'plan',
    'plan-unreadable': 'plan',
    'verification-preflight': 'plan',
    'verify-failed': 'verification',
    'no-handoff': 'verification',
    'failure-streak': 'verification',
    'waiting-external-timeout': 'external',
    'worktree-merge': 'conflict',
    'orphaned-session': 'conflict',
    'interrupted-by-restart': 'conflict',
    'nothing-ready': 'conflict',
    'operator-stop': 'operator',
  };
  for (const [kind, category] of Object.entries(expect)) {
    assert.equal(HALT_KIND_CATEGORY[kind], category, kind);
  }
});

test('every situation has a family, and every sub-kind override is a real key', () => {
  for (const id of SITUATIONS) assert.ok(SITUATION_CATEGORY[id], `${id} has no category`);
  const keys = new Set<string>(SITUATIONS);
  for (const [id, subs] of Object.entries(SUB_KINDS)) {
    for (const sub of subs as readonly string[]) keys.add(situationKey(id, sub));
  }
  for (const key of Object.keys(SUB_KIND_CATEGORY)) assert.ok(keys.has(key), `${key} is not a situation key`);
  // A sub-kind moves the family; the kind alone does not.
  assert.equal(categoryOfHalt('phase-blocked'), 'decision');
  assert.equal(categoryOfHalt('phase-blocked', 'blocked-declared:external'), 'external');
  assert.equal(categoryOfHalt('phase-blocked', 'blocked-declared:lock'), 'conflict');
  assert.equal(categoryOfHalt(undefined, 'resource-wall:auth'), 'credentials');
  assert.equal(categoryOfHalt(undefined, null), 'environment');
});

const gate = (phase: number, gateKind?: string) => ({
  phase,
  kind: 'gate',
  verb: 'approve-gate',
  why: `phase ${phase} is gated`,
  ...(gateKind ? { gateKind } : {}),
});

test('nothing-ready decomposes into its holders, each with its own single action', () => {
  const holders = [
    gate(2, 'manual'),
    { phase: 3, kind: 'errand', verb: 'errand-answered', why: 'phase 3 needs you: sign the deploy' },
    { phase: 4, kind: 'cap', verb: 'settings', why: 'phase 4 spent its cap', setting: 'ladderMaxRunRungs' },
    { phase: 5, kind: 'mcp', verb: 'mcp-continue', why: 'phase 5 waits on docs' },
    { phase: 6, kind: 'qa', verb: 'qa-recover', why: 'phase 6 is done but its QA verdict is fail' },
    { phase: 7, kind: 'retry', verb: 'retry', why: 'phase 7 is failed' },
  ];
  const rows = holderViews(holders);
  assert.equal(rows.length, holders.length, 'one row per holder');
  assert.deepEqual(
    rows.map((row) => row.phase),
    [2, 3, 4, 5, 6, 7],
  );
  for (const row of rows) {
    assert.ok(row.action.label, `phase ${row.phase} has an action`);
    assert.ok(row.why, `phase ${row.phase} says why`);
  }
  assert.equal(rows[0]!.action.label, 'Open the gate');
  assert.equal(rows[1]!.action.press, 'errand-answered');
  assert.equal(rows[2]!.setting, 'ladderMaxRunRungs');
  assert.equal(rows[3]!.action.press, 'mcp-continue');
  assert.equal(rows[5]!.action.press, 'retry');
  // Every holder verb has an action; every holder kind has a row.
  for (const verb of HALT_HOLDER_VERBS) assert.ok(HOLDER_ACTIONS[verb], `verb ${verb} has no action`);
  for (const kind of HALT_HOLDER_KINDS) {
    const [row] = holderViews([{ phase: 1, kind, verb: 'retry', why: 'x' }]);
    assert.ok(row!.label && row!.category, `holder kind ${kind} has no row`);
  }

  const run = {
    slug: 'demo',
    status: 'parked',
    halt: { at: '2026-09-29T00:00:00Z', kind: 'nothing-ready', reason: 'nothing left to run: …', holders },
  };
  const view = haltView(run)!;
  assert.equal(view.holders.length, 6);
  assert.equal(view.category, 'conflict');
});

test('#48: a park held only by gates that clear themselves is a wait, never gated-manual', () => {
  const automatic = { kind: 'nothing-ready', reason: 'x', holders: [gate(2, 'blocked'), gate(3, 'unevaluated')] };
  assert.equal(nothingReadySituation(automatic), 'waiting-external');
  assert.equal(haltSituation(automatic), 'waiting-external');
  assert.equal(situationOfHalt({ at: '', ...automatic } as never), 'waiting-external');
  // The rows say so too: a machine's gate is looked at again, never approved.
  const [row] = holderViews(automatic.holders);
  assert.equal(row!.automatic, true);
  assert.equal(row!.action.press, 'recheck');
  const view = haltView({ slug: 'x', status: 'parked', halt: { at: '', ...automatic } })!;
  assert.equal(view.category, 'external');

  // One person's gate among them: a person's.
  const mixed = { kind: 'nothing-ready', reason: 'x', holders: [gate(2, 'blocked'), gate(3, 'manual')] };
  assert.equal(nothingReadySituation(mixed), 'gated-manual');
  assert.equal(situationOfHalt({ at: '', ...mixed } as never), 'gated-manual');

  // A holder written before verdicts were carried reads the old way.
  assert.equal(nothingReadySituation({ holders: [gate(2)] }), 'gated-manual');
  // No holders at all: the fact map's word.
  assert.equal(nothingReadySituation({ holders: [] }), HALT_KIND_SITUATION['nothing-ready']);
  // No gates: the first holder names it.
  assert.equal(
    nothingReadySituation({ holders: [{ phase: 1, kind: 'qa', verb: 'qa-recover', why: 'x' }] }),
    'qa-pending',
  );
});

test('a park behind a declared external wall is an external wait, on the card, its row and the server', () => {
  // Continued past `needs-human --needs external`, the run parks `nothing-ready`:
  // the wall's own errand, and the sibling its scope fence holds. Read from
  // the kind alone that was "conflict" (control-tower phase 33).
  const holders = [
    { phase: 1, kind: 'errand', verb: 'retry', why: 'the upstream is down', situation: 'blocked-declared:external' },
    { phase: 2, kind: 'retry', verb: 'retry', why: "phase 2 is queued (fenced behind phase 1's declared external wall)" },
  ];
  const halt = { at: '', kind: 'nothing-ready', reason: 'nothing left to run on its own', holders };
  assert.equal(nothingReadySituation(halt), 'blocked-declared:external');
  assert.equal(situationOfHalt(halt as never), 'blocked-declared:external');
  assert.equal(haltView({ slug: 'x', status: 'parked', halt })!.category, 'external');
  assert.equal(holderViews(holders)[0]!.category, 'external');
  // A holder written before it carried a situation reads the old way.
  const bare = [{ ...holders[0]!, situation: undefined }, holders[1]!];
  assert.equal(nothingReadySituation({ ...halt, holders: bare }), 'blocked-declared');
  assert.equal(haltView({ slug: 'x', status: 'parked', halt: { ...halt, holders: bare } })!.category, 'conflict');
});

test('the recommended verb is the recovery model’s first, for every kind', () => {
  for (const kind of HALT_KINDS) {
    for (const record of [undefined, { phase: 2, status: 'failed', sessionId: 's1' }]) {
      const run = {
        slug: 'demo',
        status: 'halted',
        halt: { at: '', kind, reason: 'why', phase: 2 },
        ...(record ? { phases: { '2': record } } : {}),
      };
      const flags = { allowRun: true, allowWrites: true, allowAgent: true };
      const view = haltView(run, { flags })!;
      const first = recoveryActionsFor({ ...haltCtx(run), flags })[0];
      assert.equal(view.recommended?.id, first?.id, `${kind} (${record ? 'record' : 'run'})`);
      assert.ok(view.recommended, `${kind} offers a way forward`);
    }
  }
});

test('a declared wall is named by its errand until a classifier names the record', () => {
  // `needs-human --needs external` parks the run under the kind `needs-human`
  // and writes the phase's errand as `blocked-declared:external`, but no
  // classifier has written the record's own situation yet — on a console with
  // converge off, none ever does. The card named that stop `decision`, the
  // kind's family, beside a ways-forward row naming the errand's (control-tower
  // phase 33, the tower rehearsal).
  const flags = { allowRun: true, allowWrites: true, allowAgent: true };
  const errand = { phase: 1, situation: 'blocked-declared:external', need: 'the upstream is down', how: 'x', tried: [], at: '' };
  const run = {
    slug: 'external-api',
    status: 'parked',
    halt: { at: '2026-10-01T00:00:00Z', kind: 'needs-human', reason: 'phase 1 needs a person: the upstream is down', phase: 1 },
    phases: { '1': { status: 'parked', sessionId: 's1' } },
    recoveries: { '1': { errand } },
  };
  const view = haltView(run, { flags })!;
  assert.equal(view.category, 'external');
  assert.equal(view.situation, 'blocked-declared:external');
  assert.deepEqual(haltCtx(run).situation, { id: 'blocked-declared', sub: 'external' });
  assert.equal(view.recommended?.id, recoveryActionsFor({ ...haltCtx(run), flags })[0]?.id);

  // A classifier's reading of the record outranks the errand's.
  const classified = { ...run, phases: { '1': { status: 'parked', sessionId: 's1', situation: { key: 'blocked-declared:lock' } } } };
  assert.equal(haltView(classified)!.category, 'conflict');
  // A record with nothing left to recover reads nothing from an errand left behind.
  assert.equal(haltView({ ...run, phases: { '1': { status: 'done' } } })!.category, 'decision');
  // Nor does an errand another phase wrote.
  assert.equal(haltView({ ...run, recoveries: { '2': { errand: { ...errand, phase: 2 } } } })!.category, 'decision');
});

test('the view carries the facts the card draws, and nothing it was not given', () => {
  const view = haltView({
    slug: 'limits',
    status: 'halted',
    consecutiveFailures: 3,
    maxConsecutiveFailures: 4,
    failureRoots: [
      { phase: 4, key: 'wip:abc', label: 'phase 3 (red WIP abc)' },
      { phase: 5, key: 'wip:abc', label: 'phase 3 (red WIP abc)' },
      { phase: 6, key: 'refs:x', label: 'gh:acme/app#run/1' },
    ],
    halt: {
      at: '2026-09-29T00:00:00Z',
      kind: 'credential-refused',
      reason: 'the API refused the credential',
      accounts: { unusable: 2, total: 2 },
      evidence: { source: 'api', matched: 'authentication_failed', session: 's1', phase: 3, slug: 'limits' },
    },
  })!;
  assert.equal(view.category, 'credentials');
  assert.equal(view.sentence, CAUSE_SENTENCE['credential-refused']);
  assert.equal(view.reason, 'the API refused the credential');
  assert.deepEqual(view.accounts, { unusable: 2, total: 2, allGone: true });
  assert.deepEqual(view.streak, { count: 3, max: 4, atMax: false });
  assert.equal(view.evidence?.matched, 'authentication_failed');
  // The same block charged once is ONE cause naming every phase it stopped.
  assert.deepEqual(view.roots, [
    { key: 'wip:abc', label: 'phase 3 (red WIP abc)', phases: [4, 5] },
    { key: 'refs:x', label: 'gh:acme/app#run/1', phases: [6] },
  ]);
  assert.equal(haltView({ slug: 'x', status: 'finished', halt: null }), null);
  // A halt written before kinds existed still reads, in the plainest words.
  const legacy = haltView({ slug: 'x', status: 'halted', halt: { reason: 'something broke' } })!;
  assert.equal(legacy.kind, null);
  assert.equal(legacy.category, 'environment');
  assert.equal(legacy.sentence, 'something broke', 'a kindless halt reads in its own words');
  assert.equal(haltView({ slug: 'x', status: 'halted', halt: {} })!.sentence, 'The run stopped without saying why.');
});

test('a sign-in stop is read from the kind first, then the words', () => {
  assert.equal(isAuthHalt({ kind: 'credential-refused', reason: '' }), true);
  assert.equal(isAuthHalt({ kind: 'budget', reason: 'the run spent its budget' }), false);
  assert.equal(isAuthHalt({ reason: 'not signed in' }), true);
  assert.equal(isAuthHalt(null), false);
});
