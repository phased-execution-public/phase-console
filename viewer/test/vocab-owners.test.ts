/**
 * ONE OWNER PER VOCABULARY — the promise console-audit-hardening P23 exists to
 * make keepable, and the only place it can be held.
 *
 * `console-autopilot-orphans` P10 found 27 status word-lists living outside
 * `shared/`. It deleted the seven that were exact copies and left the rest,
 * because each needed a shared owner INVENTED. P23 invented them
 * (`shared/plan-vocab.js`, `shared/ops-vocab.js`, and `BOARD_BUCKETS` in
 * `shared/status-vocab.js`). This file is what stops them being re-copied.
 *
 * Two halves, because a copy can appear in two different ways:
 *
 *   1. IDENTITY — a consumer that imports the owner must get the SAME object,
 *      or a list whose members come from it. Not `deepEqual`: two lists that
 *      agree today are two lists that disagree the day a word is added, which
 *      is the entire failure mode being designed out.
 *   2. NO RE-DECLARATION — a source scan over `server/`, `client/src/` and
 *      `shared/` that fails when a file writes a vocabulary's members out as a
 *      literal again. This is the half that catches the copy somebody adds
 *      NEXT year; the identity half only covers the consumers wired today.
 *
 * A deliberate superset (`BOARD_WORDS` = buckets + `unknown`, `QA_WORDS` =
 * verdicts + `off`) is not a copy and is asserted as a superset, on purpose:
 * `off` (this plan has no gate) and `unknown` (something could not be read)
 * are different facts, and merging them would turn a broken gate into a green
 * light.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { BOARD_BUCKETS, BOARD_OVERLAY_STATES, BOARD_STATE_UI, PHASE_ACTORS, PHASE_ACTOR_LABELS } from '../shared/status-vocab.js';
import { BOARD_ORDER } from '../shared/phase-model.js';
import {
  BOARD_WORDS,
  HANDOFF_WORDS,
  QA_WORDS,
  RULING_KINDS,
  VERIFICATION_WORDS,
} from '../shared/evidence-model.js';
import { PERMISSION_MODES, PERMISSION_PROFILES, PROFILE_LABELS } from '../shared/run-settings.js';
import {
  BLOCKED_ON,
  CLOSED_PLAN_STATUSES,
  GATE_KINDS,
  HANDOFF_STATUSES,
  HANDOFF_STATUS_WORDS,
  PLAN_STATUSES,
  PLAN_STATUS_ORDER,
  QA_DISPLAY_WORDS,
  QA_MODES,
  QA_RESULTS,
  QA_RESULT_WORDS,
} from '../shared/plan-vocab.js';
import {
  ACCOUNT_KINDS,
  AUTH_STATES,
  CREDENTIAL_CLASSES,
  DELIVERY_OUTCOMES,
  ENTITLEMENT_STATES,
  ETA_BASES,
  HEALTH_SEVERITIES,
  LEAVE_KINDS,
  MCP_STATUSES,
  MCP_TRANSPORTS,
} from '../shared/ops-vocab.js';
import {
  CENSUS_DISCREPANCIES,
  CENSUS_PROVENANCES,
  FLEET_TIERS,
  INSTANCE_HEALTH_KINDS,
  LIVENESS,
  UNOWNED_HOWS,
} from '../shared/fleet-model.js';
import {
  ORCHESTRATION_VERBS,
  PRIORITY_LABELS,
  RUN_PRIORITIES,
  priorityRank,
  runPriority,
} from '../shared/orchestration-model.js';
import {
  ACTOR_FIELDS,
  ACTOR_VIAS,
  CLASSIFIED_BY,
  OPERATOR_DOOR,
  AUTONOMY_MODES,
  BOARDING_BRIEFS,
  CAP_SOURCES,
  CONVERGE_TRIGGERS,
  DECLARATION_CONSUMERS,
  DISPOSITION_KINDS,
  ENDED_BY,
  GIT_MODES,
  HOLDER_KINDS,
  MCP_POLICIES,
  ON_LIMIT_POLICIES,
  OUTCOME_STATUSES,
  PHASE_LIFECYCLE_STATES,
  PHASE_STATUSES,
  PHASE_STOP_KINDS,
  PRESENCE,
  PRESENCE_END_SOURCES,
  QUEUE_KINDS,
  REVIEWER_POLICIES,
  ULTRA_REVIEW_MODES,
  RUNG_OUTCOMES,
  RUN_LIFECYCLE_STATES,
  RUN_PENDING_ACTS,
  RUN_STATUSES,
  SESSION_MODES,
  START_DOORS,
  USAGE_DECISION_ACTIONS,
  WATCH_STATES,
} from '../shared/run-lifecycle.js';
import { RESUME_AT_BOOT_MODES } from '../shared/automation-model.js';
import { DECISION_KEYS, DECISION_STATES, DECISION_SOURCES, NEED_CLASSES } from '../shared/decisions-model.js';
import { REFUSAL_CAUSES, SITUATIONS, parseSituationKey } from '../shared/situation-model.js';
import { RUNG_DRIVERS, RUNG_VEHICLES } from '../shared/ladder-model.js';
import { POLICY_CLASSES, POLICY_SOURCES } from '../shared/policy-model.js';
import { RELAY_MODES } from '../shared/run-settings.js';
import {
  QUESTION_ANSWERED_BY, QUESTION_EXCLUSIONS, QUESTION_UNANSWERABLE_REASONS, RELAY_MECHANISMS,
} from '../shared/relay-model.js';
import {
  BOOT_HOLD_KINDS, PROBE_STATUSES, SHUTDOWN_CLOCK_SOURCES, SHUTDOWN_DURABILITIES, SHUTDOWN_INTENTS, SHUTDOWN_MODES,
} from '../shared/ops-vocab.js';
import {
  CHECKOUT_STATES,
  ISOLATED,
  ISOLATION_LABELS,
  ISOLATION_MODES,
  RADAR_STATES,
  SETTLE_STRATEGIES,
  ISOLATION_RECLAIM,
  isolationMode,
  WORKTREE_ROOTS,
} from '../shared/worktree-model.js';

import {
  PHASE_IN_FLIGHT,
  RUN_IN_FLIGHT,
  RUN_SETTLED,
  SETTLED,
  SETTLED_RUNG_OUTCOMES,
} from '../shared/run-lifecycle.js';
import { LIVE_RUN_STATUSES, PHASE_STATUS_UI, RUN_STATUS_UI, WAIT_REASONS } from '../shared/status-vocab.js';
import { BOARDING_BRIEFS as SERVER_BOARDING_BRIEFS, DECLARATION_CONSUMERS as SERVER_DECLARATION_CONSUMERS, IN_FLIGHT, MCP_POLICIES as SERVER_MCP_POLICIES, ON_LIMIT_POLICIES as SERVER_ON_LIMIT_POLICIES, PHASE_IN_FLIGHT as SERVER_PHASE_IN_FLIGHT, SETTLED as SERVER_SETTLED } from '../server/runner/state.ts';
import { REVIEWER_VERDICT_POLICIES } from '../server/reviewer.ts';
import { CLOSED_STATUSES } from '../server/analysis/stats.ts';
import { QA_RESULTS as SERVER_QA_RESULTS } from '../server/qa-session.ts';
import { MCP_TRANSPORTS as SERVER_MCP_TRANSPORTS } from '../server/mcp/store.ts';
import { PHASE_STATES } from '../server/analysis/metrics.ts';
import { PROFILE_LABELS as SERVER_PROFILE_LABELS } from '../server/runner/approvals.ts';
// The CLIENT half is covered by the source scan below (defaults.ts no longer
// names the members) — it cannot be imported here: it resolves '@/lib', a Vite
// alias node knows nothing about.

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = join(HERE, '..');

const sorted = (xs: readonly string[]) => [...xs].sort();

/* ------------------------------------------------------------------ *
 * 1. Identity — the same object, or members taken from it
 * ------------------------------------------------------------------ */

test('the server re-exports the OWNER object, not a copy that matches it', () => {
  // `===`, deliberately. A copy passes deepEqual today and drifts tomorrow.
  assert.equal(SERVER_QA_RESULTS, QA_RESULTS, 'qa-session.ts QA_RESULTS');
  assert.equal(SERVER_MCP_TRANSPORTS, MCP_TRANSPORTS, 'mcp/store.ts MCP_TRANSPORTS');
  assert.equal(CLOSED_STATUSES, CLOSED_PLAN_STATUSES, 'analysis/stats.ts CLOSED_STATUSES');
});

test('the actor labels are keyed by exactly the PHASE_ACTORS', () => {
  // The labels table is a Record over the union — the compiler holds it total,
  // this holds it free of invented keys.
  assert.deepEqual(sorted(Object.keys(PHASE_ACTOR_LABELS)), sorted(PHASE_ACTORS));
});

test('every board word-list takes its MEMBERS from BOARD_BUCKETS', () => {
  // Five lists were live across shared/, server/ and the client. They are one
  // vocabulary with three deliberate shapes: the buckets, a display ORDER, and
  // two supersets. Membership is asserted; order is each list's own business.
  assert.deepEqual(sorted(BOARD_ORDER), sorted(BOARD_BUCKETS), 'phase-model BOARD_ORDER');
  assert.deepEqual(sorted(PHASE_STATES), sorted(BOARD_BUCKETS), 'metrics PHASE_STATES');

  // The two supersets, asserted AS supersets so the extra word is visible.
  assert.deepEqual(
    sorted(BOARD_WORDS),
    sorted([...BOARD_BUCKETS, 'unknown']),
    'evidence-model BOARD_WORDS is the buckets plus `unknown`',
  );
  assert.deepEqual(
    sorted(Object.keys(BOARD_STATE_UI)),
    sorted([...BOARD_BUCKETS, ...BOARD_OVERLAY_STATES]),
    'BOARD_STATE_UI paints the buckets plus the two console-only overlays',
  );

  // The overlays are NOT buckets: the engine can never emit them.
  for (const overlay of BOARD_OVERLAY_STATES) {
    assert.ok(
      !(BOARD_BUCKETS as readonly string[]).includes(overlay),
      `\`${overlay}\` is an overlay and must not be a bucket`,
    );
  }
});

test('phase-graph.sh really does emit exactly the five buckets', () => {
  // The engine is the authority, so read IT rather than trusting this file's
  // idea of it. `--memory-block` is the machine shape `engine.ts` parses.
  const src = readFileSync(join(VIEWER, '..', 'scripts', 'phase-graph.sh'), 'utf8');
  for (const bucket of BOARD_BUCKETS) {
    assert.ok(
      src.includes(`printf '${bucket}: %s\\n'`),
      `phase-graph.sh must emit the \`${bucket}:\` bucket`,
    );
  }
  // And the parser accepts exactly those, no more.
  const engine = readFileSync(join(VIEWER, 'server', 'engine.ts'), 'utf8');
  const re = /\^\((done\|in-progress\|stuck\|ready\|waiting)\):/;
  assert.ok(re.test(engine), 'engine.ts must parse exactly the five buckets');
});

test('the QA words are THREE vocabularies and stay three', () => {
  // The expensive mistake here would be "simplifying" these into one union.
  assert.deepEqual(sorted(QA_RESULT_WORDS), sorted([...QA_RESULTS, 'unknown']));
  assert.deepEqual(sorted(QA_DISPLAY_WORDS), sorted([...QA_RESULTS, 'off']));
  assert.equal(QA_WORDS, QA_DISPLAY_WORDS, 'evidence-model QA_WORDS is the display list itself');

  // `off` and `unknown` are different facts and must never be in one list.
  assert.ok(!(QA_RESULT_WORDS as readonly string[]).includes('off'));
  assert.ok(!(QA_DISPLAY_WORDS as readonly string[]).includes('unknown'));
  assert.ok((QA_MODES as readonly string[]).includes('off'));
  assert.ok((QA_MODES as readonly string[]).includes('unknown'));
});

test('the handoff vocabulary is FROZEN at four writable words', () => {
  // CLAUDE.md names this load-bearing. Consolidating the listings was in
  // scope; widening the vocabulary was not, and this is what says so.
  assert.deepEqual(sorted(HANDOFF_STATUSES), sorted(['complete', 'in-progress', 'blocked', 'pending']));
  assert.deepEqual(sorted(HANDOFF_STATUS_WORDS), sorted([...HANDOFF_STATUSES, 'unknown']));
  assert.deepEqual(sorted(HANDOFF_WORDS), sorted([...HANDOFF_STATUS_WORDS, 'absent']));
});

test('the permission profiles are labelled in ONE place', () => {
  // Three tables held these strings and two disagreed — the server served
  // "ask about", both client tables said "ask me about", so the same profile
  // read two ways depending on the surface. P23 reconciled them deliberately.
  assert.deepEqual(sorted(Object.keys(PROFILE_LABELS)), sorted(PERMISSION_PROFILES));
  // Since phase 12 every label says what the profile silences and that deny
  // still refuses — the one difference a picker may claim.
  assert.equal(PROFILE_LABELS.guarded, 'Guarded — asks about everything on the ask list; deny still refuses');
  for (const label of Object.values(PROFILE_LABELS)) assert.match(label, /deny still refuses$/);
  assert.equal(SERVER_PROFILE_LABELS, PROFILE_LABELS, 'approvals.ts serves the owner table');

});

test('isolation is what was ASKED for and checkout is what was GOT — two lists', () => {
  // The expensive mistake here is the mirror image of the QA one above:
  // merging these into a single word-set. `worktree` appears in both and means
  // two different things — a request in one, an outcome in the other — and
  // `refused` (asked and could not) has nowhere to live if they are one list.
  assert.deepEqual(sorted(ISOLATION_MODES), sorted(['queue', 'worktree']));
  assert.deepEqual(sorted(CHECKOUT_STATES), sorted(['shared', 'worktree', 'refused']));
  assert.ok(!(ISOLATION_MODES as readonly string[]).includes('refused'), 'a refusal is not a request');
  assert.ok(!(ISOLATION_MODES as readonly string[]).includes('shared'), 'the shared tree is not a request');
  assert.ok(!(CHECKOUT_STATES as readonly string[]).includes('queue'), 'queueing is not a checkout');

  // The labels key the modes and nothing else — a mode with no label would
  // render blank in the launch dialog and a label with no mode is dead text.
  assert.deepEqual(sorted(Object.keys(ISOLATION_LABELS)), sorted(ISOLATION_MODES));

  // `ISOLATED` is the one word that isolates, so no reader re-types it.
  assert.ok((ISOLATION_MODES as readonly string[]).includes(ISOLATED));
});

test('only the exact word `worktree` isolates', () => {
  // The `gitMode` rule, for the same reason: a typo in config.json, a stale
  // client or a hand-edited run file must never be what mints a worktree.
  assert.equal(isolationMode('worktree'), 'worktree');
  for (const near of ['Worktree', 'WORKTREE', ' worktree', 'worktrees', 'true', '', 'queue']) {
    assert.equal(isolationMode(near), 'queue', `\`${String(near)}\` must not isolate`);
  }
  for (const wrong of [undefined, null, 1, true, {}, ['worktree']]) {
    assert.equal(isolationMode(wrong), 'queue', `${JSON.stringify(wrong) ?? 'undefined'} must not isolate`);
  }
  // Absent means queue — every run file written before the feature existed
  // must keep meaning exactly what it meant.
  assert.equal(isolationMode(undefined), 'queue');
});

test('priority orders the queue and nothing else — three classes, one default', () => {
  // The order of the ARRAY is the scan order (`priorityRank` is `indexOf`), so
  // unlike every other vocabulary here membership alone is not enough: a list
  // that agreed on members and disagreed on order would silently invert the
  // queue. Both are asserted.
  assert.deepEqual([...RUN_PRIORITIES], ['high', 'normal', 'low']);
  assert.equal(priorityRank('high'), 0);
  assert.ok(priorityRank('high') < priorityRank('normal'));
  assert.ok(priorityRank('normal') < priorityRank('low'));

  // A label per class, and no label without a class: an unlabelled class
  // renders blank in the launch dialog and a label with no class is dead text.
  assert.deepEqual(sorted(Object.keys(PRIORITY_LABELS)), sorted(RUN_PRIORITIES));

  // Absent is `normal` — every run file written before priorities existed has
  // to keep meaning exactly what it meant.
  assert.equal(runPriority(undefined), 'normal');
  assert.equal(priorityRank(undefined), priorityRank('normal'));
});

test('only the three exact words are a class', () => {
  // The `isolationMode` rule, for the same reason: a typo in a run file, a
  // stale client or a hand-edited checkpoint must never be what moves a plan
  // to the front of the queue.
  for (const word of RUN_PRIORITIES) assert.equal(runPriority(word), word);
  for (const near of ['High', 'HIGH', ' high', 'higher', 'urgent', '', 'p1']) {
    assert.equal(runPriority(near), 'normal', `\`${String(near)}\` must not be a class`);
  }
  for (const wrong of [undefined, null, 0, 1, true, {}, ['high']]) {
    assert.equal(runPriority(wrong), 'normal', `${JSON.stringify(wrong) ?? 'undefined'} must not be a class`);
  }
});

test('hold/release are RUN verbs and bump is an ENTRY verb — one list, three words', () => {
  assert.deepEqual(sorted(ORCHESTRATION_VERBS), sorted(['hold', 'release', 'bump']));
  // The split is the reason there is one list rather than one verb with a
  // scope argument: hold/release live on the run's checkpoint and survive a
  // restart; a bump names a queue entry, and the pending `admit()` promise
  // that entry belongs to does not survive one either.
  assert.ok((ORCHESTRATION_VERBS as readonly string[]).includes('bump'));
  assert.ok(!(ORCHESTRATION_VERBS as readonly string[]).includes('pause'), 'a hold is not a pause');
});

test('the radar keeps `unknown` separate from `clean`', () => {
  // The same fact the QA words make: could-not-measure and measured-safe are
  // different, and merging them paints an unmeasured pair as a safe one.
  assert.deepEqual(sorted(RADAR_STATES), sorted(['clean', 'overlap', 'conflicted', 'unknown']));
  assert.ok((RADAR_STATES as readonly string[]).includes('unknown'));
  assert.deepEqual(sorted(SETTLE_STRATEGIES), sorted(['pr', 'merge-queue', 'integration', 'keep']));
  // There is deliberately no `always`: a dirty checkout holds work that exists
  // nowhere else, and no setting may authorise throwing it away. A third word
  // here would be a decision somebody has to make on purpose.
  assert.deepEqual(sorted(ISOLATION_RECLAIM), sorted(['clean-only', 'never']));
  assert.ok(!(ISOLATION_RECLAIM as readonly string[]).includes('always'),
    'a reclaim that does not ask whether the tree is clean must not be expressible');
  assert.equal(SETTLE_STRATEGIES[0], 'pr', 'the default settles by asking a person to look');
});

test('the lifecycle subsets take their MEMBERS from the full lists, never a second literal', () => {
  // Not `deepEqual` against a hand-written expectation: the point is that the
  // subset is a FILTER over the owner, so the only thing worth asserting is
  // that every member is one of the owner's and that the exclusions are the
  // intended ones. A subset written out by hand passes the first half today
  // and fails it silently the day a word lands.
  for (const status of RUN_IN_FLIGHT) {
    assert.ok((RUN_STATUSES as readonly string[]).includes(status), `${status} must be a run status`);
  }
  for (const status of RUN_SETTLED) {
    assert.ok((RUN_STATUSES as readonly string[]).includes(status), `${status} must be a run status`);
  }
  // Disjoint, and NOT exhaustive: `queued` is in neither, and that is the
  // content. A queued run holds no child and no lock (not in flight) while a
  // loop sits in `admit()` behind it (not settled). Making the two complements
  // would force `queued` onto one side and answer one of the two questions
  // wrongly — which is exactly the bug that once painted a queued run as
  // *interrupted* on the fleet page.
  for (const status of RUN_IN_FLIGHT) {
    assert.ok(!(RUN_SETTLED as readonly string[]).includes(status), `${status} cannot be both`);
  }
  assert.deepEqual(
    sorted(RUN_STATUSES.filter((s) =>
      !(RUN_IN_FLIGHT as readonly string[]).includes(s) && !(RUN_SETTLED as readonly string[]).includes(s))),
    ['queued'],
    '`queued` is the one run status that is neither in flight nor settled',
  );

  for (const status of PHASE_IN_FLIGHT) {
    assert.ok((PHASE_STATUSES as readonly string[]).includes(status), `${status} must be a phase status`);
  }
  for (const status of SETTLED) {
    assert.ok((PHASE_STATUSES as readonly string[]).includes(status), `${status} must be a phase status`);
  }
  // `queued`, `pending` and `waiting` are in NEITHER, and that is the content:
  // a queued phase is one the loop is waiting to start, and a waiting one is
  // asleep on a clock that hands it back. Both are the opposite of settled and
  // neither holds a lane.
  assert.deepEqual(
    sorted(PHASE_STATUSES.filter((s) =>
      !(PHASE_IN_FLIGHT as readonly string[]).includes(s) && !(SETTLED as readonly string[]).includes(s))),
    sorted(['queued', 'pending', 'waiting']),
  );

  // The rung verdicts: everything but the two words that mean "no verdict yet".
  assert.deepEqual(
    sorted(SETTLED_RUNG_OUTCOMES),
    sorted(RUNG_OUTCOMES.filter((o) => o !== 'running' && o !== 'work-in-progress')),
  );

  // The client's notion of live differs from the server's by exactly `queued`,
  // and that difference is a documented decision rather than a drift.
  assert.deepEqual(
    sorted([...IN_FLIGHT, 'queued']),
    sorted(LIVE_RUN_STATUSES),
    'LIVE_RUN_STATUSES is IN_FLIGHT plus `queued` — see status-vocab.js',
  );
});

test('the server re-exports the lifecycle OWNER objects, not copies', () => {
  // `===`, the same bar the other owners are held to.
  assert.equal(SERVER_SETTLED, SETTLED, 'state.ts SETTLED');
  assert.equal(SERVER_PHASE_IN_FLIGHT, PHASE_IN_FLIGHT, 'state.ts PHASE_IN_FLIGHT');
  assert.equal(SERVER_BOARDING_BRIEFS, BOARDING_BRIEFS, 'state.ts BOARDING_BRIEFS');
  assert.equal(SERVER_MCP_POLICIES, MCP_POLICIES, 'state.ts MCP_POLICIES');
  assert.equal(SERVER_ON_LIMIT_POLICIES, ON_LIMIT_POLICIES, 'state.ts ON_LIMIT_POLICIES');
  assert.equal(SERVER_DECLARATION_CONSUMERS, DECLARATION_CONSUMERS, 'state.ts DECLARATION_CONSUMERS');
  assert.equal(REVIEWER_VERDICT_POLICIES, REVIEWER_POLICIES, 'reviewer.ts REVIEWER_VERDICT_POLICIES');
  // `IN_FLIGHT` is the one that is a copy BY VALUE — it is typed
  // `readonly RunStatus[]` for its consumers — so membership is what is held.
  assert.deepEqual(sorted(IN_FLIGHT), sorted(RUN_IN_FLIGHT), 'state.ts IN_FLIGHT');
});

test('the two paint tables are keyed by exactly the lifecycle statuses', () => {
  // The compiler holds the Records total against the union; this holds them
  // free of INVENTED keys, which the compiler cannot see.
  assert.deepEqual(sorted(Object.keys(RUN_STATUS_UI)), sorted(RUN_STATUSES));
  assert.deepEqual(sorted(Object.keys(PHASE_STATUS_UI)), sorted(PHASE_STATUSES));
});

test('plan status: one membership, one ordering, one closed set', () => {
  assert.deepEqual(sorted(PLAN_STATUS_ORDER), sorted(PLAN_STATUSES));
  for (const s of CLOSED_PLAN_STATUSES) {
    assert.ok((PLAN_STATUSES as readonly string[]).includes(s), `${s} must be a plan status`);
  }
  assert.equal(CLOSED_PLAN_STATUSES.length, 3, 'exactly three terminal statuses');
});

/* ------------------------------------------------------------------ *
 * 2. No re-declaration — the half that catches next year's copy
 * ------------------------------------------------------------------ */

/**
 * Each consolidated vocabulary, its owner file, and the files allowed to name
 * its members as literals anyway. Every allowance is a decision with a reason
 * — never widen this to silence a red gate; move the words to the owner.
 */
const VOCABULARIES: {
  name: string;
  members: readonly string[];
  owner: string;
  allow?: readonly string[];
}[] = [
  {
    name: 'board buckets',
    members: BOARD_BUCKETS,
    owner: 'shared/status-vocab.js',
    allow: [
      // The paint table keys them; the two orderings rank them. Both take
      // MEMBERSHIP from the owner and are asserted above.
      'shared/phase-model.js',
      'server/analysis/metrics.ts',
      // The parser's regex must spell the five out — it reads the engine's
      // stdout, and a regex cannot be built from an import without becoming
      // unreadable. Asserted against the owner above instead.
      'server/engine.ts',
    ],
  },
  {
    name: 'phase actors',
    members: PHASE_ACTORS,
    owner: 'shared/status-vocab.js',
    allow: [
      // The two TS shadows of the owner's union, each commented back to it —
      // the same shape LIVE_VIA's shadows take. Any THIRD spelling fails.
      'server/service-core.ts',
      'client/src/lib/api/runs.ts',
    ],
  },
  { name: 'plan statuses', members: PLAN_STATUSES, owner: 'shared/plan-vocab.js' },
  { name: 'QA results', members: QA_RESULTS, owner: 'shared/plan-vocab.js' },
  { name: 'QA modes', members: QA_MODES, owner: 'shared/plan-vocab.js' },
  { name: 'gate kinds', members: GATE_KINDS, owner: 'shared/plan-vocab.js' },
  { name: 'blockedOn', members: BLOCKED_ON, owner: 'shared/plan-vocab.js' },
  {
    name: 'handoff statuses',
    members: HANDOFF_STATUSES,
    owner: 'shared/plan-vocab.js',
    allow: [
      // The display ordering; membership comes from the owner.
      'shared/evidence-model.js',
    ],
  },
  {
    name: 'permission profiles',
    members: PERMISSION_PROFILES,
    owner: 'shared/run-settings.js',
    allow: [
      // These are different SETS, not copies: each surface offers its own
      // subset, and two of them include words that are not profiles at all
      // (`plan`, `auto`, `dontAsk` are MODES). Naming a superset is not
      // re-declaring the vocabulary — `RUN_PERMISSIONS`, the one that IS the
      // three profiles, derives from the owner.
      'client/src/features/run-setup/modes.ts',
      'client/src/features/run-setup/schema.ts',
    ],
  },
  {
    name: 'permission modes',
    members: PERMISSION_MODES,
    owner: 'shared/run-settings.js',
    allow: [
      // The run-setup picker's own ORDER; membership is the owner's.
      'client/src/features/run-setup/modes.ts',
    ],
  },
  {
    name: 'ruling kinds',
    members: RULING_KINDS,
    // attention-model.js declares it; evidence-model.js RE-EXPORTS it (same
    // object, asserted by the identity half). The owner is where it is frozen.
    owner: 'shared/attention-model.js',
    allow: [
      // The boot prompt PRINTS the kinds into a session's instructions — it is
      // a sentence for a reader, not a second declaration.
      'server/runner/runner-core.ts',
    ],
  },
  { name: 'verification words', members: VERIFICATION_WORDS, owner: 'shared/evidence-model.js' },
  { name: 'health severities', members: HEALTH_SEVERITIES, owner: 'shared/ops-vocab.js' },
  { name: 'MCP statuses', members: MCP_STATUSES, owner: 'shared/ops-vocab.js' },
  { name: 'MCP transports', members: MCP_TRANSPORTS, owner: 'shared/ops-vocab.js' },
  { name: 'account kinds', members: ACCOUNT_KINDS, owner: 'shared/ops-vocab.js' },
  { name: 'auth states', members: AUTH_STATES, owner: 'shared/ops-vocab.js' },
  { name: 'entitlement states', members: ENTITLEMENT_STATES, owner: 'shared/ops-vocab.js' },
  { name: 'leave kinds', members: LEAVE_KINDS, owner: 'shared/ops-vocab.js' },
  { name: 'credential classes', members: CREDENTIAL_CLASSES, owner: 'shared/ops-vocab.js' },
  { name: 'delivery outcomes', members: DELIVERY_OUTCOMES, owner: 'shared/ops-vocab.js' },
  { name: 'ETA bases', members: ETA_BASES, owner: 'shared/ops-vocab.js' },
  {
    name: 'isolation modes',
    members: ISOLATION_MODES,
    owner: 'shared/worktree-model.js',
  },
  { name: 'checkout states', members: CHECKOUT_STATES, owner: 'shared/worktree-model.js' },
  { name: 'radar states', members: RADAR_STATES, owner: 'shared/worktree-model.js' },
  { name: 'settle strategies', members: SETTLE_STRATEGIES, owner: 'shared/worktree-model.js' },
  { name: 'isolation reclaim modes', members: ISOLATION_RECLAIM, owner: 'shared/worktree-model.js' },
  { name: 'worktree roots', members: WORKTREE_ROOTS, owner: 'shared/worktree-model.js' },
  {
    name: 'run priorities',
    members: RUN_PRIORITIES,
    owner: 'shared/orchestration-model.js',
  },
  {
    name: 'orchestration verbs',
    members: ORCHESTRATION_VERBS,
    owner: 'shared/orchestration-model.js',
  },

  /* -- the lifecycle sixteen (`shared/run-lifecycle.js`) ---------------- *
   * Each was spelled out two to eighteen times before it had an owner. The
   * entries are terse because most of them have NOTHING to allow: the shadows
   * are now aliases of the owner's typedef rather than second spellings, which
   * is the shape this gate was built to make possible. */
  { name: 'run statuses', members: RUN_STATUSES, owner: 'shared/run-lifecycle.js' },
  { name: 'phase statuses', members: PHASE_STATUSES, owner: 'shared/run-lifecycle.js' },

  /* The four the 3.5.0 lifecycle adds. They live with the statuses they fold
   * because they are the same fact split along its axes, and a split whose
   * halves lived in two files is exactly the sprawl this replaces. */
  { name: 'run lifecycle states', members: RUN_LIFECYCLE_STATES, owner: 'shared/run-lifecycle.js' },
  {
    name: 'phase lifecycle states',
    members: PHASE_LIFECYCLE_STATES,
    owner: 'shared/run-lifecycle.js',
  },
  { name: 'run pending acts', members: RUN_PENDING_ACTS, owner: 'shared/run-lifecycle.js' },
  { name: 'phase stop kinds', members: PHASE_STOP_KINDS, owner: 'shared/run-lifecycle.js' },

  /* What a console does about the runs its own restart stopped. */
  {
    name: 'resume-at-boot modes',
    members: RESUME_AT_BOOT_MODES,
    owner: 'shared/automation-model.js',
  },
  { name: 'disposition kinds', members: DISPOSITION_KINDS, owner: 'shared/run-lifecycle.js' },
  { name: 'rung outcomes', members: RUNG_OUTCOMES, owner: 'shared/run-lifecycle.js' },
  { name: 'watch states', members: WATCH_STATES, owner: 'shared/run-lifecycle.js' },
  { name: 'outcome statuses', members: OUTCOME_STATUSES, owner: 'shared/run-lifecycle.js' },
  { name: 'presence', members: PRESENCE, owner: 'shared/run-lifecycle.js' },
  { name: 'holder kinds', members: HOLDER_KINDS, owner: 'shared/run-lifecycle.js' },
  {
    name: 'queue kinds',
    members: QUEUE_KINDS,
    owner: 'shared/run-lifecycle.js',
    allow: [
      // `RunSetupMode` is a NINE-member superset that happens to contain both
      // words. It is a different vocabulary — the run-setup dialog's own modes
      // — and naming a superset is not re-declaring this one. The same
      // reasoning as the permission-profiles allowance above.
      'client/src/features/run-setup/modes.ts',
    ],
  },
  { name: 'boarding briefs', members: BOARDING_BRIEFS, owner: 'shared/run-lifecycle.js' },
  { name: 'converge triggers', members: CONVERGE_TRIGGERS, owner: 'shared/run-lifecycle.js' },

  /* The attribution vocabularies zero-touch-console phase 2 added for phases
   * 5–7 to wire: which of the fourteen automatic-start doors opened, and how
   * an actor reached the console. Owned before any emitter exists, so the
   * first emitter imports a word rather than inventing one. */
  { name: 'start doors', members: START_DOORS, owner: 'shared/run-lifecycle.js' },
  { name: 'actor vias', members: ACTOR_VIAS, owner: 'shared/run-lifecycle.js' },
  { name: 'classified by', members: CLASSIFIED_BY, owner: 'shared/run-lifecycle.js' },

  /* The session ledger (zero-touch-console phase 4, chapter 03 SES-1/SES-8/
   * SES-9): who ended a session, what each spawn site's session was for,
   * where a turn or dollar cap came from, and what the console decided about
   * an in-session usage warning. `phase.session` and `run.usage-decision`
   * write these words; `session-record.ts` and `spawn.ts` import them. */
  { name: 'session endings', members: ENDED_BY, owner: 'shared/run-lifecycle.js' },
  { name: 'session modes', members: SESSION_MODES, owner: 'shared/run-lifecycle.js' },
  { name: 'cap sources', members: CAP_SOURCES, owner: 'shared/run-lifecycle.js' },
  { name: 'usage decision actions', members: USAGE_DECISION_ACTIONS, owner: 'shared/run-lifecycle.js' },

  /* The declaration licences (zero-touch-console phase 6, chapter 04 WAI-9):
   * the four ways `record.declared` is ever spent. `consumeDeclaration` takes
   * one as `why` and every one journals `phase.declaration-consumed`. */
  { name: 'declaration consumers', members: DECLARATION_CONSUMERS, owner: 'shared/run-lifecycle.js' },

  /* The decision manifest (zero-touch-console phase 3, chapter 13 §1.1): the
   * seventeen keys a plan answers before a run starts, the states a row can be
   * in, where an answer came from, and the blocker classes `--needs` accepts
   * as a key's short form. `scripts/decisions.env` is the bash twin, held
   * equal by `test/decisions-model.test.ts`; both engines' readers import the
   * owner. */
  { name: 'decision keys', members: DECISION_KEYS, owner: 'shared/decisions-model.js' },
  { name: 'decision states', members: DECISION_STATES, owner: 'shared/decisions-model.js' },
  { name: 'decision sources', members: DECISION_SOURCES, owner: 'shared/decisions-model.js' },
  {
    name: 'need classes',
    members: NEED_CLASSES,
    // Derived in decisions-model.js from `SUB_KINDS['blocked-declared']`, whose
    // literal lives here; the runner's `BlockerSubKind` type derives from the
    // same array.
    owner: 'shared/situation-model.js',
  },
  /* Why a `never-started:refusal` refused (phase 9, RCV-2) — a cause beside
   * the sub-kind, never a fourth sub-kind; `refusalCauseOf` is its one reader. */
  { name: 'refusal causes', members: REFUSAL_CAUSES, owner: 'shared/situation-model.js' },

  /* The ladder's vehicles and who drives each (zero-touch-console phase 10,
   * LFC-2/RCV-10). The client's `RungVehicle` union used to be a second
   * spelling of the vehicle list — a vehicle renamed in the owner would have
   * left it naming a rung nothing owned; it derives from the owner now. The
   * server's `switch` over vehicles names them one `case` at a time, which is
   * a comparison, not a re-declaration. */
  { name: 'rung vehicles', members: RUNG_VEHICLES, owner: 'shared/ladder-model.js' },
  { name: 'rung drivers', members: RUNG_DRIVERS, owner: 'shared/ladder-model.js' },

  /* The wait axis's reasons. `run-lifecycle.js` compares against each member
   * in turn (`recorded === 'external' || …`) because `status-vocab.js`, the
   * owner, imports IT — `test/run-lifecycle.test.ts` asserts that copy agrees
   * over every member, which is what holds it honest (LFC-5). */
  { name: 'wait reasons', members: WAIT_REASONS, owner: 'shared/status-vocab.js', allow: ['shared/run-lifecycle.js'] },
  { name: 'autonomy modes', members: AUTONOMY_MODES, owner: 'shared/run-lifecycle.js' },
  { name: 'on-limit policies', members: ON_LIMIT_POLICIES, owner: 'shared/run-lifecycle.js' },
  { name: 'MCP policies', members: MCP_POLICIES, owner: 'shared/run-lifecycle.js' },
  // The fleet's words (zero-touch phase 17, FLT-6 / R-F6): the tiers, and what
  // the census says about every console of a machine.
  { name: 'fleet tiers', members: FLEET_TIERS, owner: 'shared/fleet-model.js' },
  { name: 'census provenances', members: CENSUS_PROVENANCES, owner: 'shared/fleet-model.js' },
  { name: 'liveness', members: LIVENESS, owner: 'shared/fleet-model.js' },
  { name: 'census discrepancies', members: CENSUS_DISCREPANCIES, owner: 'shared/fleet-model.js' },
  { name: 'unowned hows', members: UNOWNED_HOWS, owner: 'shared/fleet-model.js' },
  { name: 'instance health kinds', members: INSTANCE_HEALTH_KINDS, owner: 'shared/fleet-model.js' },
  { name: 'git modes', members: GIT_MODES, owner: 'shared/run-lifecycle.js' },
  { name: 'reviewer policies', members: REVIEWER_POLICIES, owner: 'shared/run-lifecycle.js' },
  { name: 'ultra-review modes', members: ULTRA_REVIEW_MODES, owner: 'shared/run-lifecycle.js' },

  /* The policy table (phase 11): the 18 intervention classes and where an
   * answer came from; the relay's two modes and the probe verdict words the
   * prelude and `doctor` share. */
  { name: 'policy classes', members: POLICY_CLASSES, owner: 'shared/policy-model.js' },
  { name: 'policy sources', members: POLICY_SOURCES, owner: 'shared/policy-model.js' },
  { name: 'relay modes', members: RELAY_MODES, owner: 'shared/run-settings.js' },
  { name: 'probe statuses', members: PROBE_STATUSES, owner: 'shared/ops-vocab.js' },

  /* The relay (phase 14): the two hook events a question arrives on, the
   * exclusions and the budget that take a question to a person, and who
   * answered one. The journal, the inbox, the client's question card and the
   * relay itself all read these; `QuestionAnsweredBy` and the reasons' type
   * derive from the owner. */
  { name: 'relay mechanisms', members: RELAY_MECHANISMS, owner: 'shared/relay-model.js' },
  { name: 'question exclusions', members: QUESTION_EXCLUSIONS, owner: 'shared/relay-model.js' },
  { name: 'question unanswerable reasons', members: QUESTION_UNANSWERABLE_REASONS, owner: 'shared/relay-model.js' },
  { name: 'question answered-by words', members: QUESTION_ANSWERED_BY, owner: 'shared/relay-model.js' },

  /* The off switch and the boot (phase 16): how strong a Shut down press is,
   * what it achieves, why the process went away, the clocks it discards, why a
   * boot holds its automation, and who said a session ended. The server's
   * stop plan, the readiness inventory, the dialog and the Sessions page all
   * read these; each type derives from its owner. */
  { name: 'shutdown modes', members: SHUTDOWN_MODES, owner: 'shared/ops-vocab.js' },
  { name: 'shutdown durabilities', members: SHUTDOWN_DURABILITIES, owner: 'shared/ops-vocab.js' },
  { name: 'shutdown intents', members: SHUTDOWN_INTENTS, owner: 'shared/ops-vocab.js' },
  { name: 'shutdown clock sources', members: SHUTDOWN_CLOCK_SOURCES, owner: 'shared/ops-vocab.js' },
  { name: 'boot hold kinds', members: BOOT_HOLD_KINDS, owner: 'shared/ops-vocab.js' },
  { name: 'presence end sources', members: PRESENCE_END_SOURCES, owner: 'shared/run-lifecycle.js' },
];

/** Every source file the scan covers — tests excluded; they may say anything. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry)) continue;
      if (/\.test\.[a-z]+$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(join(VIEWER, 'shared'));
  walk(join(VIEWER, 'server'));
  walk(join(VIEWER, 'client', 'src'));
  // The fleet supervisor's own sources (Pro; absent from the free tree).
  if (existsSync(join(VIEWER, 'fleet'))) walk(join(VIEWER, 'fleet'));
  return out;
}

test('no file outside the owner re-declares a vocabulary as a literal', () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, 'the scan must actually be scanning something');

  /**
   * The signature of a RE-DECLARATION: the members written out as one
   * sequence — a literal array `['a','b','c']`, a TS union `'a'|'b'|'c'`, or a
   * JSDoc `@typedef {'a'|'b'}`. Anything whose separator is `,` or `|`.
   *
   * Deliberately NOT matched, because neither can silently drift:
   *   - a comparison (`status === 'pass'`), which names one word;
   *   - a `Record<TheUnion, X>` object literal, whose keys the compiler already
   *     holds total against the union — the same reasoning that lets the
   *     `RunStatus`/`PhaseStatus` client mirrors stand (`_runTotal`).
   */
  const SEQUENCE = /(?:['"`]?[\w-]+['"`]?\s*[|,]\s*){1,}['"`]?[\w-]+['"`]?/g;

  /**
   * Comments are stripped first: this gate polices DECLARATIONS, not prose.
   * A doc line that spells a vocabulary out (`server/inbox.ts`, `situation.ts`)
   * is documentation and may go stale; a `const` or a type union is a second
   * source of truth and may not. The one exception is a JSDoc `@typedef`,
   * which really is a declaration in a .js file — those are derived with
   * `(typeof OWNER)[number]` instead, so they no longer spell members out.
   */
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

  /** Does any single comma/pipe-separated run contain every member? */
  const reDeclares = (text: string, members: readonly string[]) => {
    for (const run of text.match(SEQUENCE) ?? []) {
      const tokens = new Set(
        run.split(/[|,]/).map((t) => t.trim().replace(/^['"`]|['"`]$/g, '')),
      );
      if (members.every((m) => tokens.has(m))) return true;
    }
    return false;
  };

  const offences: string[] = [];
  for (const vocab of VOCABULARIES) {
    const permitted = new Set([vocab.owner, ...(vocab.allow ?? [])]);
    for (const file of files) {
      const rel = relative(VIEWER, file).split('\\').join('/');
      if (permitted.has(rel)) continue;
      if (reDeclares(stripComments(readFileSync(file, 'utf8')), vocab.members)) {
        offences.push(`${rel} re-declares the ${vocab.name} (${vocab.members.join(', ')})`);
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    `a vocabulary must have ONE owner — import it instead of re-typing its members:\n  ${offences.join('\n  ')}`,
  );
});

/* ------------------------------------------------------------------ *
 * 2b. Every situation an errand names is one the vocabulary can parse (RCV-11)
 * ------------------------------------------------------------------ */

test('every `situation:` literal under server/ parses to a SITUATIONS member — an errand is filed under a word every reader knows', () => {
  // `stallPark` used to write `situation: 'silent-session:unfixable'`, a key in
  // no vocabulary: `parseSituationKey` answered `unknown`, so the card, the
  // inbox and the client read a stall park as a phase nobody could classify.
  // Every situation an errand, a hint or a rung record names is a member now.
  const LITERAL = /\bsituation:\s*'([a-z][a-z-]*(?::[a-z][a-z-]*)?)'/g;
  const offences: string[] = [];
  let seen = 0;
  for (const file of sourceFiles()) {
    const rel = relative(VIEWER, file).split('\\').join('/');
    if (!rel.startsWith('server/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LITERAL)) {
      seen += 1;
      // The parser folds an unknown head to `unknown`, so a literal is known
      // only when its own head IS the member the parser answered — `unknown`'s
      // own family (`unknown:declaration-cap`, phase 6) passes; an invented
      // head like `silent-session` does not.
      const { id } = parseSituationKey(m[1]);
      const known = (SITUATIONS as readonly string[]).includes(id) && m[1].split(':')[0] === id;
      if (!known) offences.push(`${rel}: situation: '${m[1]}' parses to ${id}`);
    }
  }
  assert.ok(seen >= 4, `the scan sees the literals (${seen})`);
  assert.deepEqual(offences, []);
  // The specimen itself, by name.
  const runner = readFileSync(join(VIEWER, 'server/runner/runner.ts'), 'utf8');
  assert.ok(!runner.includes("'silent-session:unfixable'"), 'the stall park files under a SITUATIONS member (never-started)');
});

/* ------------------------------------------------------------------ *
 * 3. The doors, the actor, and the wait reasons have writers (phase 2 of zero-touch-console)
 * ------------------------------------------------------------------ */

test('START_DOORS is the census — fourteen doors, owned once — and the actor shape is spelled once', () => {
  assert.equal(START_DOORS.length, 14, 'chapter 02 of the sep-review audit counted fourteen automatic-start doors');
  assert.equal(new Set(START_DOORS).size, START_DOORS.length, 'no door may be listed twice');
  for (const door of START_DOORS) assert.match(door, /^[a-z][a-z0-9-]*$/, `${door} is not a kebab-case word`);
  assert.ok(Object.isFrozen(START_DOORS) && Object.isFrozen(ACTOR_VIAS) && Object.isFrozen(ACTOR_FIELDS));
  // Seven since phase 7: `event` is the transport of a door opened by an
  // observation (a recovery exiting, a declaration landing) — three of the
  // fourteen — which is neither a clock nor a request.
  assert.deepEqual([...ACTOR_VIAS], ['api', 'cli', 'signal', 'timer', 'boot', 'hook', 'event']);
  assert.deepEqual([...CLASSIFIED_BY], ['drive', 'outcome', 'closed', 'heal']);
  assert.equal(OPERATOR_DOOR, 'operator');
  assert.ok(!(START_DOORS as readonly string[]).includes(OPERATOR_DOOR), 'the press is not an automatic door');
  assert.deepEqual([...ACTOR_FIELDS], ['by', 'via', 'origin', 'remoteUser', 'door', 'trigger', 'guard', 'counter']);
  // The nine `startRun` doors lead, then the five that spawn some other way —
  // the census's order, which phase 7's lint reads back.
  assert.deepEqual(START_DOORS.slice(0, 9), [
    'boot-readopt', 'wait-clock', 'converge-relaunch', 'converge-heal', 'recovery-continue',
    'pty-continue', 'watch-landed', 'mcp-require-timeout', 'outcome-inbox',
  ]);
});

/**
 * Every wait reason has a PRODUCTION writer — an assignment under `server/`,
 * not a comparison. `scope` was only ever derived and `schedule` only ever
 * written by a test, so `waitReason` was null in 53 of 53 run files and
 * `lifecycle.wait.kind` a guess on every one (LFC-5, gate ACC-11.3).
 *
 * The assigned values are read off the two shapes a writer has: the named
 * writer's argument (`setRunState(state, …, { kind: '<reason>' })`) and a
 * direct `state.waitReason = '<reason>'`. `setRunState` itself must have a
 * caller outside `test/` — it had exactly one, in `run-lifecycle.test.ts`.
 */
test('every WAIT_REASONS member is ASSIGNED somewhere under server/, and setRunState has a non-test caller', () => {
  const assigned = new Map<string, string[]>();
  let namedWriterCalls = 0;
  for (const file of sourceFiles()) {
    const rel = relative(VIEWER, file).split('\\').join('/');
    if (!rel.startsWith('server/')) continue;
    const text = readFileSync(file, 'utf8');
    // The named writer's argument: a bare literal, or every arm of a ternary
    // (`kind: head?.slug === SCHEDULE_HOLDER ? 'schedule' : 'scope'`).
    for (const m of text.matchAll(/setRunState\([^;]*?\bkind:\s*([^,}]*)/gs)) {
      for (const lit of m[1].matchAll(/'([a-z-]+)'/g)) {
        (assigned.get(lit[1]) ?? assigned.set(lit[1], []).get(lit[1]))!.push(rel);
      }
    }
    for (const m of text.matchAll(/\bwaitReason\s*=\s*'([a-z-]+)'/g)) {
      (assigned.get(m[1]) ?? assigned.set(m[1], []).get(m[1]))!.push(rel);
    }
    namedWriterCalls += (text.match(/\bsetRunState\(/g) ?? []).length - (rel === 'server/runner/state.ts' ? 1 : 0);
  }
  const unwritten = WAIT_REASONS.filter((reason) => !assigned.has(reason));
  assert.deepEqual(unwritten, [], 'these WAIT_REASONS have no production writer under server/ — write one or drop the word');
  const unlisted = [...assigned.keys()].filter((reason) => !(WAIT_REASONS as readonly string[]).includes(reason));
  assert.deepEqual(unlisted, [], 'a writer assigns a wait reason WAIT_REASONS does not hold');
  assert.ok(namedWriterCalls >= 5, `setRunState is called ${namedWriterCalls} time(s) under server/ — the named writer must be the production path`);
});
