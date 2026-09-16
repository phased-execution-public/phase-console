/**
 * The situation classifier — the three measured specimens, built from the
 * journal facts, pinned to the situations they really were; the precedence
 * order; the sub-kind reader; parity by identity across every layer; and
 * the evidence collector against stubbed dependencies.
 *
 * Provenance for the specimens: the live state dir's journals
 * (`~/.local/state/phase-console/runs/4557c636-hub/`, files `A` =
 * `aug-notif-admin-repair/run-d86f48d9.jsonl` + its `.json`/`.log.jsonl`,
 * journal `seq` == line number) and the hub handoff history. NOTE: the
 * design document attributed the Aug 14 P7 story to
 * `aug-hetzner-remediation/run-4ce969d8.jsonl`; that run's phase 7 was clean
 * (B:70–80, done at 03:45:02). The closeouts re-confirming a blocked handoff
 * are `aug-notif-admin-repair` phase 7 in the same clock window (A:145–165).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SITUATIONS, SITUATION_ACTOR, SITUATION_BLURBS, SITUATION_LABELS, SUB_KINDS,
  SITUATION_SUB_ACTOR, REFUSAL_CAUSES, actorFor, classifyExitSaid, refusalCauseOf,
  parseSituationKey, situationKey, situationLabel,
} from '../shared/situation-model.js';
import {
  SITUATIONS as SERVER_SITUATIONS, MCP_PARK_RE, VERIFICATION_PARK_RE,
  blockerStatement, blockerSubKind, classifySituation, collectEvidence, parseLockStatus,
  summariseEvidence, workEvidence, type PhaseEvidence,
} from '../server/runner/situation.ts';
import { SITUATIONS as LADDER_SITUATIONS, RUNGS_BY_SITUATION, errandFor, rungsFor } from '../server/runner/ladder.ts';
import { MCP_PARK_NOTE, VERIFICATION_PARK_NOTE } from '../server/runner/runner.ts';
import { consumeDeclaration, newRun, phaseRecord } from '../server/runner/state.ts';

/* ------------------------------------------------------------------ *
 * Fixtures — one per specimen, fields annotated with their journal lines
 * ------------------------------------------------------------------ */

const BASE: Omit<PhaseEvidence, 'slug' | 'phase' | 'board' | 'handoff' | 'record' | 'run' | 'work' | 'at'> = {
  lock: null, declared: null, gate: null, mcp: null, health: [], registry: null, qa: { mode: 'off' }, auth: null,
};

/**
 * Specimen 1 — `aug-notif-admin-repair` phase 12, 2026-08-19 11:20:42Z, the
 * moment "Recover & continue" answered `needs-you: no phase to anchor a
 * recovery on` (A:213, A:214). Record from A:173 (phase.start 08-14
 * 23:05:01), A:176 (run.stop-requested), A:178 (phase.session attempt 1:
 * $1.44, 16 turns, 51 s, error_during_execution, session 7a83a9dc…, said "");
 * run parked at A:212 with no phase.start; board `ready` (A:217 boardState);
 * lock free (AL:14383); MCP servers degraded under `continue` (A:171). Work:
 * the run root (the docs hub) read "uncommitted changes" (A:217) — its
 * submodule pointers — while the repo the phase names, web-admin, was
 * clean at fe1113aa with no P12 commit (AL:14371, AL:14379; the closeout's
 * own finding "Phase 12 was never implemented — the prior session ended
 * during bootstrap", A:218).
 */
const P12_NEVER_STARTED: PhaseEvidence = {
  ...BASE,
  slug: 'aug-notif-admin-repair', phase: 12, board: 'ready',
  handoff: { exists: false },
  record: {
    status: 'interrupted', attempts: 1, sessionId: '7a83a9dc-cd93-4213-8ebe-82bdea104cf2', resumable: true,
    startedAt: '2026-08-14T23:05:01.401Z', endedAt: null, verification: null, closeout: null,
    note: 'stopped by the operator', said: '', gate: { clear: true, kind: 'clear' },
    costUsd: 1.4405570000000003, turns: 16,
  },
  run: {
    status: 'parked',
    halt: { reason: 'nothing left to run on its own — phase 12 is interrupted (stopped by the operator)', phase: 12 },
    waitUntil: null, resolved: false,
  },
  lock: null,
  work: { did: false, why: 'web-admin: clean tree, 0 commits since the phase started', dirty: 0, commits: 0 },
  mcp: { unreachable: ['serena', 'semgrep', 'codeatlas-admin'], policy: 'continue' },
  at: '2026-08-19T11:20:42.000Z',
};

/**
 * Specimen 2 — `aug-notif-admin-repair` phase 2, 2026-08-13 13:47:11Z, the
 * moment auto-recovery launched a SECOND closeout (A:72). The session had
 * handed off `in-progress` deliberately (A:57: $40.03, 261 turns, success,
 * session 155b4e75…; hub 9cecdce 13:24:01Z "P2 in-progress — 5 dead route
 * families registered"); the runner's own closeout ran at once (A:59, because
 * 'a handoff exists for phase 2 but reads "in-progress"'), came back
 * "I did not mark Phase 2 complete, and that is deliberate … Exit criterion
 * 4 is not met" (A:62: $6.34, 10 turns) and the run halted `no-handoff`
 * (A:63). Lock re-claimed by the autopilot for the closeout (A:60). Work:
 * commits in aws and hub (c15170d). Verification: none recorded on the
 * record yet (the session's own run of the 13 commands was green, A:62).
 */
const P2_OUTSTANDING = `### 🔴 Exit criterion 4 is NOT met — this phase hands off \`in-progress\`

Two items from plan §Phase 2 steps 4 and 5 are unstarted. I stopped rather than rush them,
because both change **wire shapes that Phase 8 must absorb**, and a half-done version would
either be wrong or turn a currently-green verification red.

**(a) Pagination adoption — BE-15.** \`admin-wallets\` computes page maths inline instead of
importing \`parsePaginationParams\`; \`admin-audit-log\` and \`admin-search\` expose no sort params.
Bounded, mechanical work in three named lambdas.

**(b) The envelope ARGUMENT-shape gate — BE-11 root fix.** \`check-admin-envelope-parity.py\`
currently validates only that each lambda **imports** from \`admin-http\`; it never inspects what is
*passed*.`;
const P2_WORK_IN_PROGRESS: PhaseEvidence = {
  ...BASE,
  slug: 'aug-notif-admin-repair', phase: 2, board: 'in-progress',
  handoff: { exists: true, status: 'in-progress', outstanding: P2_OUTSTANDING },
  record: {
    status: 'failed', attempts: 1, sessionId: '155b4e75-fbac-4896-8f01-54b6a3a5c08c', resumable: true,
    startedAt: '2026-08-13T12:46:33.022Z', endedAt: null, verification: null,
    closeout: { at: '2026-08-13T13:24:39.000Z', ok: true, note: 'a handoff exists for phase 2 but reads "in-progress"' },
    note: null,
    said: 'The closeout is finished. **I did not mark Phase 2 `complete`, and that is deliberate.** ## Verification — all 13 green, nothing regressed … **Exit criterion 4 is not met:** …',
    gate: { clear: true, kind: 'clear' }, costUsd: 46.368935, turns: 271,
  },
  run: {
    status: 'halted',
    halt: {
      kind: 'no-handoff', phase: 2,
      reason: 'the session for phase 2 ended cleanly but the board still reads "in-progress" — no handoff was written, or it is not marked complete. the runner asked its session to finish the closeout. It signed off: "The closeout is finished. **I did not mark Phase 2 `complete`, and that is deliberate.** …"',
    },
    waitUntil: null, resolved: false,
  },
  lock: { holder: 'autopilot/d86f48d9', ours: true, expired: false },
  work: { did: true, why: 'aws: clean tree, 3 commits since the phase started; .: clean tree, 2 commits since the phase started', dirty: 0, commits: 5 },
  at: '2026-08-13T13:47:11.000Z',
};

/**
 * Specimen 3 — `aug-notif-admin-repair` phase 7, 2026-08-14 03:36:13Z, the
 * moment auto-recovery launched its first closeout (A:156) on a phase whose
 * first closeout had ALREADY written and committed a `blocked` handoff
 * (A:147–152: web-admin e0a00663, hub ad4fc7d "P7 BLOCKED — 2 of 4 exit
 * criteria", lock released AL:12353) and the runner halted `no-handoff`
 * because the board rendered `blocked` as `stuck` (A:153). Two more closeouts
 * followed ($4.43 + $2.90) re-confirming "the handoff exists and is blocked"
 * (A:158, A:163) until the third declared `blocked` (A:164) and the run
 * halted `phase-blocked` (A:165). The Outstanding text is the handoff body
 * at ad4fc7d: its blocker block says "nothing external blocks it" and lists
 * two exit criteria to BUILD; its ledger blocks mention a CI token and "no
 * credential exists today" — the nouns that must NOT decide the sub-kind.
 */
const P7_OUTSTANDING = `### 🔴 To finish Phase 7 (resume here — nothing external blocks it)

1. **Criterion 3 — codegen.** Drop \`--path-params-as-types\` from \`scripts/generate-types.js\`, keep
   the \`[object Object]\` neutraliser, delete the \`@ts-nocheck\` header, remove
   \`src/types/api-generated.ts\` from \`tsconfig.json\` \`exclude\`, regenerate, commit the (large)
   result. Then decide the staleness-gate option (a/b/c above) and wire CI **without a step that
   can silently skip**. Expect the regenerated file to be ~55.6k lines.
2. **Criterion 4 — relay allow-list gate.** Build it against the \`admin-config\` relay mapping, not
   the raw \`/internal/admin/*\` namespace. Red-proof it.
3. **Re-run the full §Verification battery** — it must be green before this handoff becomes
   \`complete\`.

### ⚠️ MCP servers requested for this phase and UNAVAILABLE to the session

The boot prompt named \`serena\`, \`semgrep\` and \`codeatlas-admin\`; **none was available**, so none
was used. → **Operator errand:** re-run a reference + SAST pass over \`e0a00663\` once the servers are live.

### Errands / ledger items this phase created

- **E-P7-2:** cross-repo checkout token for web-admin CI, if option (a) is chosen for the
  staleness gate. Operator-owned — no credential exists today.`;
const P7_BLOCKED_DECLARED: PhaseEvidence = {
  ...BASE,
  slug: 'aug-notif-admin-repair', phase: 7, board: 'stuck',
  handoff: { exists: true, status: 'blocked', outstanding: P7_OUTSTANDING },
  record: {
    status: 'failed', attempts: 1, sessionId: '393b8c43-4828-439c-ac1a-82bed9a73be1', resumable: true,
    startedAt: '2026-08-14T02:53:23.726Z', endedAt: null, verification: null,
    closeout: { at: '2026-08-14T03:28:07.000Z', ok: true, note: 'the working tree has uncommitted changes' },
    note: null,
    said: 'Phase 7 is closed out as **`blocked`** — the honest status, since verification is red on 2 of 6 commands. …',
    gate: { clear: true, kind: 'clear' }, costUsd: 23.6629035, turns: 144,
  },
  run: {
    status: 'halted',
    halt: {
      kind: 'no-handoff', phase: 7,
      reason: 'the session for phase 7 ended cleanly but the board still reads "stuck" — no handoff was written, or it is not marked complete. the runner asked its session to finish the closeout. It signed off: "Phase 7 is closed out as **`blocked`** — the honest status, since verification is red on 2 of 6 commands. …"',
    },
    waitUntil: null, resolved: false,
  },
  lock: null,
  work: { did: true, why: 'web-admin: clean tree, 1 commit since the phase started; .: clean tree, 2 commits since the phase started', dirty: 0, commits: 3 },
  at: '2026-08-14T03:36:13.000Z',
};

/* ------------------------------------------------------------------ *
 * The specimens
 * ------------------------------------------------------------------ */

test('specimen 1 — the never-started phase read as interrupted is never-started', () => {
  const s = classifySituation(P12_NEVER_STARTED);
  assert.equal(s.id, 'never-started', s.why.join(' | '));
  assert.equal(s.actor, 'machine');
  assert.ok(s.why.some((w) => /no handoff/.test(w)));
  assert.ok(s.why.some((w) => /clean tree/.test(w)));
  // The first rung for it is the runner's own fresh board — no closeout, no agent, no person.
  assert.equal(rungsFor(s.key)[0]?.vehicle, 'reboard-fresh');
});

test('specimen 1 — seen through the run root\'s false witness (dirty submodule pointers) it would read work-in-progress, which is why work evidence is scope-aware', () => {
  const s = classifySituation({ ...P12_NEVER_STARTED, work: { did: true, why: '.: 9 uncommitted paths', dirty: 9 } });
  assert.equal(s.id, 'work-in-progress');
});

test('specimen 2 — the deliberate in-progress handoff is work-in-progress, never a closeout', () => {
  const s = classifySituation(P2_WORK_IN_PROGRESS);
  assert.equal(s.id, 'work-in-progress', s.why.join(' | '));
  assert.ok(s.why.some((w) => /in-progress/.test(w)));
  assert.ok(s.why.some((w) => /Outstanding: .*Exit criterion 4/.test(w)));
  const rungs = rungsFor(s.key);
  assert.equal(rungs[0]?.vehicle, 'resume-own-session');
  assert.equal(rungs[0]?.params?.mode, 'continue');
  assert.ok(!rungs.some((r) => r.vehicle === 'closeout-own-session' || r.vehicle === 'closeout-agent'),
    'a work-in-progress phase is continued, never closed out');
});

test('specimen 3 — the committed blocked handoff is blocked-declared:unknown, not missing paperwork', () => {
  const s = classifySituation(P7_BLOCKED_DECLARED);
  assert.equal(s.id, 'blocked-declared', s.why.join(' | '));
  assert.equal(s.sub, 'unknown');
  assert.equal(s.key, 'blocked-declared:unknown');
  assert.ok(s.why.some((w) => /handoff reads blocked/.test(w)));
  assert.equal(rungsFor(s.key)[0]?.vehicle, 'unblock-session');
  assert.equal(rungsFor(s.key).length, 1, 'ONE bounded unblock session, then an errand');
});

test('specimen 3 — as the third closeout finally declared it (A:164/165) it reads the same', () => {
  const s = classifySituation({
    ...P7_BLOCKED_DECLARED,
    run: {
      status: 'halted',
      halt: {
        kind: 'phase-blocked', phase: 7,
        reason: 'phase 7 declared itself blocked: Closeout IS complete: handoff phase-07-two-file-gates-and-codegen.md is written, filled, status=blocked, committed (hub ad4fc7d) and pushed; INDEX updated; web-admin e0a00663 pushed; lock released. Board reads \'stuck\' because that is how status=blocked renders — not a missing handoff. Verification re-run twice: 4 green / 2 RED (git diff --exit-code on src/types, and @ts-nocheck still present), both from exit criterion 3. Phase 7 needs 2 of 4 exit criteria BUILT (EC-3 codegen: drop --path-par…',
      },
    },
    declared: { status: 'blocked', reason: 'Closeout IS complete … Phase 7 needs 2 of 4 exit criteria BUILT (EC-3 codegen …', watch: [] },
  });
  assert.equal(s.key, 'blocked-declared:unknown');
});

test('superseded when the board reads done — and the QA verdicts outrank it when QA gates', () => {
  const done = { ...P7_BLOCKED_DECLARED, board: 'done' };
  assert.equal(classifySituation(done).id, 'superseded');
  assert.equal(classifySituation({ ...done, qa: { mode: 'on', result: 'fail' } }).id, 'qa-failed');
  assert.equal(classifySituation({ ...done, qa: { mode: 'on' } }).id, 'qa-pending');
  assert.equal(classifySituation({ ...done, qa: { mode: 'on', result: 'pass' } }).id, 'superseded');
  assert.equal(classifySituation({ ...done, qa: { mode: 'waived', result: 'waived' } }).id, 'superseded');
});

/* ------------------------------------------------------------------ *
 * Precedence and the rest of the vocabulary
 * ------------------------------------------------------------------ */

test('ACC-7.3 (REG-3): with NO lock, a live session in the repository is foreign-live from presence alone — the ladder waits, never boards beside it', () => {
  // The first minute of a hand session: started, not claimed. Every other
  // registry reading was reached through a lock, so this phase used to read
  // `never-started` and the healer would climb into the person's tree.
  const peer = {
    ...P12_NEVER_STARTED, lock: null,
    registry: { live: true, peer: true as const, sessionId: 's-hand-peer-0001', owner: 'sam@laptop', pid: 4242, cwd: '/work/hub' },
  };
  const s = classifySituation(peer);
  assert.equal(s.id, 'foreign-live');
  assert.match(s.why.join(' '), /no lock is held, but the session registry shows a live Claude session in this repository \(s-hand-p, pid 4242, in \/work\/hub\)/);
  // A peer the registry can no longer vouch for is not one.
  assert.notEqual(classifySituation({ ...peer, registry: { ...peer.registry, live: false } }).id, 'foreign-live');
  // Only the lock-free witness speaks this way: a registry hit without `peer` (the lock's session) needs its lock.
  assert.notEqual(classifySituation({ ...peer, registry: { live: true, sessionId: 's-x' } }).id, 'foreign-live');
  // The summary names the witness for what it is.
  assert.ok(summariseEvidence(peer).some((line) => /registry: a live session in the repository, holding no lock/.test(line)));
  // A board that reads done still wins: the work is recorded, whoever is in the tree.
  assert.equal(classifySituation({ ...peer, board: 'done' }).id, 'superseded');
});

test('a foreign live lock outranks everything that would spend; an expired one over work is stale; over nothing it is debris', () => {
  const live = { ...P2_WORK_IN_PROGRESS, lock: { holder: 'someone@host', ours: false, expired: false } };
  assert.equal(classifySituation(live).id, 'foreign-live');
  const stale = { ...P2_WORK_IN_PROGRESS, lock: { holder: 'someone@host', ours: false, expired: true } };
  assert.equal(classifySituation(stale).id, 'foreign-stale');
  // The registry saying "that session ended" makes an unexpired lock debris too.
  const ended = { ...P2_WORK_IN_PROGRESS, lock: { holder: 'someone@host', ours: false, expired: false, live: false } };
  assert.equal(classifySituation(ended).id, 'foreign-stale');
  const debris = { ...P12_NEVER_STARTED, lock: { holder: 'someone@host', ours: false, expired: true } };
  assert.equal(classifySituation(debris).id, 'never-started', 'an expired lock over no work is not the story');
  // Our own claim is never foreign.
  assert.equal(classifySituation(P2_WORK_IN_PROGRESS).id, 'work-in-progress');
});

test('a declared external wait outranks a manual gate, which outranks a broken plan, which outranks red verification', () => {
  const waiting = { ...P2_WORK_IN_PROGRESS, record: { ...P2_WORK_IN_PROGRESS.record!, status: 'waiting', parkReason: 'CI image build', watch: ['gh:run/77'], parkedUntil: '2026-08-13T14:00:00.000Z' }, gate: { clear: false, kind: 'manual', detail: 'operator signs the deploy' } };
  const w = classifySituation(waiting);
  assert.equal(w.id, 'waiting-external');
  assert.ok(w.why.some((x) => /watching gh:run\/77/.test(x)));
  const gated = { ...P2_WORK_IN_PROGRESS, gate: { clear: false, kind: 'manual', detail: 'operator signs the deploy' }, run: { status: 'halted', halt: { kind: 'plan-lint', phase: 2, reason: 'LINT FAIL' } } };
  assert.equal(classifySituation(gated).id, 'gated-manual');
  // An automatic gate that is merely unmet is a wait, not a person.
  assert.equal(classifySituation({ ...P2_WORK_IN_PROGRESS, gate: { clear: false, kind: 'blocked', detail: 'phase 9 not done' } }).id, 'waiting-external');
  const lint = classifySituation({ ...P2_WORK_IN_PROGRESS, run: { status: 'halted', halt: { kind: 'plan-lint', phase: 2, reason: 'phase 2 left the plan failing validate.sh: LINT FAIL' } }, record: { ...P2_WORK_IN_PROGRESS.record!, verification: { ok: false, failed: 2, ran: 6 } } });
  assert.equal(lint.key, 'plan-broken:lint');
  const preflight = classifySituation({ ...P12_NEVER_STARTED, run: { status: 'parked', halt: { kind: 'verification-preflight', phase: 12, reason: 'nothing left to run on its own — phase 12 is parked (the plan states no verification for phase 12)' } }, record: { ...P12_NEVER_STARTED.record!, status: 'parked', note: 'the plan states no verification for phase 12 — nothing would prove the work. Add a §Verification command to the plan, then Retry.' } });
  assert.equal(preflight.key, 'plan-broken:verification');
  const issue = classifySituation({ ...P12_NEVER_STARTED, health: [{ kind: 'graph-cycle', severity: 'error' }] });
  assert.equal(issue.key, 'plan-broken:graph-cycle');
});

test('a declared needs-human park is testimony — a note that MENTIONS §Verification is not a broken plan', () => {
  /*
   * Specimen 4 — the 2026-08-28 filters incident (run journal `run-e3920406.jsonl`,
   * phase 12). The session declared needs-human for a production outage; its
   * reason ended "…then run the 4 §Verification cmds and flip the handoff" —
   * a TO-DO LIST, which the prose sniff read as plan-broken:verification.
   * Three rungs then burned re-confirming the outage (each re-park scored
   * `failed`), and at 01:35:06Z the honest errand was overwritten with
   * "A plan, handoff or INDEX that passes validate.sh" — a prescription
   * nobody could act on, about a plan nothing was wrong with.
   */
  const NOTE = 'Prod outage, day 2: boxes down, runners offline. Operator must restore box #2. '
    + 'Then run the 4 §Verification cmds and flip the handoff.';
  const REFS = ['gh:acme/app#run/123', 'cmd:gh run list --workflow deploy.yml'];
  const parked: PhaseEvidence = {
    ...P2_WORK_IN_PROGRESS,
    record: {
      ...P2_WORK_IN_PROGRESS.record!,
      status: 'parked', note: NOTE, watch: REFS,
      declared: { status: 'needs-human', reason: NOTE, watch: REFS, at: '2026-08-28T01:34:03.265Z' },
    },
    run: { status: 'parked', halt: { kind: 'needs-human', phase: 2, reason: `phase 2 needs a person: ${NOTE}` } },
  };
  const s1 = classifySituation(parked);
  assert.equal(s1.id, 'blocked-declared', 'the declaration outranks the prose sniff');
  assert.equal(s1.sub, 'external', 'a gh ref makes the blocker external — the free poll ladder');

  // The restart shape: the halt lost its kind (old `park()` wrote none) and
  // the in-memory declared map died with the process. The RECORD's persisted
  // declaration alone must still carry the classification.
  const restarted: PhaseEvidence = {
    ...parked,
    run: { status: 'parked', halt: { phase: 2, reason: `phase 2 needs a person: ${NOTE}` } },
  };
  assert.equal(classifySituation(restarted).id, 'blocked-declared');

  // Legacy: the same park on a record written BEFORE `declared` existed keeps
  // the old reading — the sniff is for the runner's own verification parks.
  const legacy: PhaseEvidence = {
    ...parked,
    record: { ...parked.record!, declared: undefined },
    run: { status: 'parked', halt: { phase: 2, reason: 'nothing left to run on its own' } },
  };
  assert.equal(classifySituation(legacy).key, 'plan-broken:verification');

  // A stale `complete` in the unsupervised map is NOT park testimony: the
  // sniff still reads the runner's own verification park under it.
  const staleMap: PhaseEvidence = {
    ...legacy,
    declared: { status: 'complete', reason: 'done earlier' },
  };
  assert.equal(classifySituation(staleMap).key, 'plan-broken:verification');

  // A plan HEALTH error does not outrank the declaration either — a handoff
  // reading blocked mid-outage IS the declared state, not a second defect
  // (live: the chip read "Plan needs repair · stale-handoff" over the healed
  // errand until this guard).
  const withHealth: PhaseEvidence = {
    ...parked,
    health: [{ kind: 'stale-handoff', severity: 'error', phase: 2 }],
  };
  assert.equal(classifySituation(withHealth).id, 'blocked-declared');
});

test('MCP and resource walls, by sub-kind', () => {
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, run: { status: 'parked', halt: { kind: 'mcp-preflight', reason: 'every ready phase is parked on MCP servers' } } }).id, 'mcp-unavailable');
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, mcp: { unreachable: ['serena'], policy: 'require' } }).id, 'mcp-unavailable');
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, mcp: { unreachable: ['serena'], policy: 'continue' } }).id, 'never-started', 'under continue a degraded server is not a wall');
  const wall = (halt: { kind?: string; reason: string }, record: Partial<NonNullable<PhaseEvidence['record']>> = {}) =>
    classifySituation({ ...P2_WORK_IN_PROGRESS, run: { status: 'halted', halt: { ...halt, phase: 2 } }, record: { ...P2_WORK_IN_PROGRESS.record!, ...record } });
  assert.equal(wall({ kind: 'budget', reason: 'the run budget of $5 is spent' }).key, 'resource-wall:budget');
  assert.equal(wall({ kind: 'models-exhausted', reason: 'every model is limited' }).key, 'resource-wall:model');
  assert.equal(wall({ kind: 'needs-human', reason: 'authentication failed — sign in and continue' }).key, 'resource-wall:auth');
  assert.equal(wall({ kind: 'run-preflight', reason: 'claude is signed out' }).key, 'resource-wall:auth');
  assert.equal(classifySituation({ ...P2_WORK_IN_PROGRESS, auth: { signedIn: false } }).key, 'resource-wall:auth');
  assert.equal(classifySituation({ ...P2_WORK_IN_PROGRESS, run: { status: 'waiting', waitUntil: '2026-08-13T15:00:00.000Z', halt: null } }).key, 'resource-wall:usage');
  assert.equal(wall({ reason: 'usage limit reached — resets at 15:00' }).key, 'resource-wall:usage');
});

test('ACT-6: a live wall the runner escalated classifies resource-wall:usage from the phase record alone — the wait shape and the park shape', () => {
  // Both shapes `runner.ts`'s `escalateLiveWall` writes: the phase parked on
  // the window (the retry-storm park's own shape) and the phase parked with
  // the errand when no reset was known. Neither fabricates a run-level
  // `limits.status`; the note carries the wall's words.
  const reason = 'rate limited mid-session (rate_limit) — 3 rate-limit events in 40s with no work between them';
  const waiting = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'waiting', waitUntil: '2026-08-13T15:00:00.000Z', halt: null },
    record: {
      ...P2_WORK_IN_PROGRESS.record!, status: 'waiting',
      note: `${reason}. Waiting until 2026-08-13T15:00:00.000Z, when the window resets.`,
    },
  });
  assert.equal(waiting.key, 'resource-wall:usage');
  const parked = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'parked', halt: null, waitUntil: null },
    record: {
      ...P2_WORK_IN_PROGRESS.record!, status: 'parked',
      note: `Resource wall — ${reason}. An account whose usage window has room, or the current window to reopen.`,
    },
  });
  assert.equal(parked.key, 'resource-wall:usage');
  assert.equal(parked.actor, 'machine', 'the ladder\'s to climb — switch-account, wait-window — never a person\'s first');
});

test('only a run budget is a budget wall — the ladder\'s and the wait\'s "budget is spent" are not (LFC-8)', () => {
  // All ten `resource-wall:budget` classifications the audit found were the
  // LADDER's exhaustion sentence, carried into a kindless park's reason and
  // re-read by a regex as a spent RUN budget — whose one remedy the console
  // refuses. The kind is the evidence now; the prose is not read at all.
  const halted = (halt: { kind: string; reason: string; phase?: number }) =>
    classifySituation({ ...P2_WORK_IN_PROGRESS, run: { status: 'parked', halt } });
  const ladder = halted({
    kind: 'nothing-ready',
    reason: 'nothing is ready to run: phase 2 needs you — the phase\'s ladder budget is spent (3 of 3 rungs) (see the errand)',
  });
  assert.notEqual(ladder.key, 'resource-wall:budget', 'the ladder\'s cap is not the run\'s budget');
  assert.equal(halted({ kind: 'budget', reason: 'the run budget of $5 is spent' }).key, 'resource-wall:budget',
    'a run budget halt still is one — by its kind');
  // The wait budget's full sentence, which the old regex also matched.
  const wait = classifySituation({
    ...P7_BLOCKED_DECLARED,
    handoff: { exists: true, status: 'blocked', outstanding: 'blocked' },
    run: { status: 'halted', halt: { kind: 'waiting-external-timeout', phase: 7,
      reason: 'phase 7 is still waiting on external work after 3 wait(s) and 480 minutes parked (the CI image build; watching gh:run/123) — the wait budget is spent. Retry when the external work lands, or split the phase behind a Gate-check.' } },
  });
  assert.equal(wait.key, 'blocked-declared:external');
});

test('a usage window the CLI reports `rejected` is a usage wall — `limited` was never a word the CLI sends (SES-9)', () => {
  const rejected = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'running', halt: null, limits: { status: 'rejected', utilization: 1, resetsAt: 1789956000 } },
  });
  assert.equal(rejected.key, 'resource-wall:usage');
  assert.ok(rejected.why.some((line) => /rejected at 100 %/.test(line)), `the evidence says what the CLI said (${rejected.why.join(' | ')})`);
  const warned = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'running', halt: null, limits: { status: 'allowed_warning', utilization: 0.99 } },
  });
  assert.notEqual(warned.key, 'resource-wall:usage', 'a warning is not a wall');
});

test('declared blockers branch by what the session actually said it is blocked on', () => {
  const blocked = (over: Partial<PhaseEvidence>, handoffOutstanding = 'blocked') =>
    classifySituation({ ...P7_BLOCKED_DECLARED, handoff: { exists: true, status: 'blocked', outstanding: handoffOutstanding }, ...over });
  assert.equal(blocked({ declared: { status: 'blocked', reason: 'phase 3 is held by someone@host', watch: ['lock:alpha/3'] } }).key, 'blocked-declared:lock');
  assert.equal(blocked({ declared: { status: 'blocked', reason: 'the deploy needs the SSH key for the box, which no session holds', watch: [] } }).key, 'blocked-declared:credential');
  assert.equal(blocked({ declared: { status: 'blocked', reason: 'waiting for the operator approval of the deploy window', watch: [] } }).key, 'blocked-declared:gate');
  assert.equal(blocked({ declared: { status: 'blocked', reason: 'waiting for the CI image build to finish', watch: ['gh:run/123'] } }).key, 'blocked-declared:external');
  assert.equal(blocked({ run: { status: 'halted', halt: { kind: 'waiting-external-timeout', phase: 7, reason: 'phase 7 is still waiting on external work after 3 wait(s)' } } }).key, 'blocked-declared:external');
  // needs-human without a machine-shaped reason is an unknown blocker — the measured "closeout passes looped" shape.
  const needsHuman = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'parked', halt: { kind: 'needs-human', phase: 2, reason: 'phase 2 needs a person: Exit criterion 4 unfinished (BE-15 pagination). Verification is 13/13 GREEN — but three closeout-only passes have now looped, each forbidden from doing the remaining implementation work. Needs authorization for ONE normal working session scoped to aws.' } },
    record: { ...P2_WORK_IN_PROGRESS.record!, status: 'parked', note: 'Exit criterion 4 unfinished … Needs authorization for ONE normal working session scoped to aws' },
    declared: { status: 'needs-human', reason: 'Exit criterion 4 unfinished (BE-15 pagination). Verification is 13/13 GREEN and nothing is broken — but three closeout-only passes have now looped, each forbidden from doing the remaining implementation work. Needs authorization for ONE normal working session scoped to aws; it then closes the phase complete.', watch: [] },
  });
  assert.equal(needsHuman.key, 'blocked-declared:unknown');

  // `--needs <key>` (zero-touch-console P3, ZTD-3): the session's own word is
  // read BEFORE the prose. The same lock-shaped sentence and lock ref that
  // classified `lock` above classifies `credential` when the declaration says
  // so; a decision key answers through its blocker class; a key no class
  // points at leaves the prose cascade to decide, as it always did.
  const lockProse = { reason: 'phase 3 is held by someone@host', watch: ['lock:alpha/3'] };
  assert.equal(blocked({ declared: { status: 'blocked', needs: 'credential', ...lockProse } }).key, 'blocked-declared:credential');
  assert.equal(blocked({ declared: { status: 'blocked', needs: 'credentials', ...lockProse } }).key, 'blocked-declared:credential');
  assert.equal(blocked({ declared: { status: 'blocked', needs: 'permission.destructive', ...lockProse } }).key, 'blocked-declared:permission');
  assert.equal(blocked({ declared: { status: 'needs-human', needs: 'gates', reason: 'no gate in sight', watch: [] } }).key, 'blocked-declared:gate');
  assert.equal(blocked({ declared: { status: 'blocked', needs: 'waits', reason: 'nothing external here', watch: [] } }).key, 'blocked-declared:external');
  assert.equal(blocked({ declared: { status: 'blocked', needs: 'budgets', ...lockProse } }).key, 'blocked-declared:lock', 'no class points at budgets — the prose decides');
  // And the persisted RECORD copy speaks after a restart, with the same precedence.
  const fromRecord = classifySituation({
    ...P7_BLOCKED_DECLARED,
    handoff: { exists: true, status: 'blocked', outstanding: 'blocked' },
    declared: null,
    record: { ...P7_BLOCKED_DECLARED.record!, declared: { status: 'blocked', needs: 'credential', ...lockProse, at: '2026-09-14T00:00:00Z' } },
  });
  assert.equal(fromRecord.key, 'blocked-declared:credential');
});

test('the blocker statement is the first block of Outstanding; ledger nouns below it do not decide', () => {
  const block = blockerStatement(P7_OUTSTANDING);
  assert.match(block, /nothing external blocks it/);
  assert.doesNotMatch(block, /no credential exists today/);
  assert.equal(blockerSubKind(block), 'unknown');
  assert.equal(blockerSubKind(P7_OUTSTANDING), 'credential', 'the WHOLE section would mislead — which is why only the first block is read');
  // A section whose heading is included still yields the first block, not just the heading.
  assert.match(blockerStatement(`## Outstanding / blockers\n\n${P7_OUTSTANDING}`), /Criterion 3 — codegen/);
  assert.equal(blockerStatement(undefined), '');
});

test('red verification; done-unrecorded vs work-in-progress vs never-started', () => {
  const red = classifySituation({ ...P2_WORK_IN_PROGRESS, handoff: { exists: false }, record: { ...P2_WORK_IN_PROGRESS.record!, verification: { ok: false, failed: 1, ran: 2 } }, run: { status: 'halted', halt: { kind: 'verify-failed', phase: 2, reason: 'phase 2 did not verify' } } });
  assert.equal(red.id, 'verify-red');
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, record: { ...P12_NEVER_STARTED.record!, status: 'failed' }, run: { status: 'halted', halt: { kind: 'verify-failed', phase: 12, reason: 'did not verify' } } }).id, 'verify-red', 'the halt kind is a witness even without a verification record');
  // A session that ended cleanly with no handoff: done-unrecorded when work exists or cannot be read; never-started when the tree provably moved not at all.
  const noHandoff = { ...P7_BLOCKED_DECLARED, board: 'ready', handoff: { exists: false } as PhaseEvidence['handoff'] };
  assert.equal(classifySituation(noHandoff).id, 'done-unrecorded');
  assert.equal(classifySituation({ ...noHandoff, work: { did: null, why: 'the working tree could not be read' } }).id, 'done-unrecorded');
  assert.equal(classifySituation({ ...noHandoff, work: { did: false, why: 'clean' } }).id, 'never-started');
  // Green verification + work + no handoff is done-unrecorded; with an in-progress handoff it is work-in-progress.
  const green = { ...noHandoff, run: { status: 'halted', halt: null }, record: { ...noHandoff.record!, verification: { ok: true, failed: 0, ran: 6 } } };
  assert.equal(classifySituation(green).id, 'done-unrecorded');
  assert.equal(classifySituation({ ...green, handoff: { exists: true, status: 'in-progress', outstanding: 'one more thing' } }).id, 'work-in-progress');
  // Interrupted over an unreadable tree: its own session is the witness — resume, never re-board.
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, work: { did: null, why: 'the working tree could not be read' } }).id, 'work-in-progress');
  // A pending record (or none) with no handoff is never-started; a skipped record fits nothing.
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, record: null, work: { did: null, why: 'unreadable' } }).id, 'never-started');
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, record: { status: 'skipped' }, work: { did: null, why: 'unreadable' } }).id, 'unknown');
  // A live lane of this console is work in progress by definition.
  assert.equal(classifySituation({ ...P12_NEVER_STARTED, record: { ...P12_NEVER_STARTED.record!, live: true } }).id, 'work-in-progress');
});

/* ------------------------------------------------------------------ *
 * Parity and completeness
 * ------------------------------------------------------------------ */

test('server, ladder and client import the SAME situation list', async () => {
  assert.equal(SERVER_SITUATIONS, SITUATIONS);
  assert.equal(LADDER_SITUATIONS, SITUATIONS);
  const client = await import('../client/src/lib/situation.ts');
  assert.equal(client.SITUATIONS, SITUATIONS);
  assert.equal(client.SITUATION_LABELS, SITUATION_LABELS);
  assert.equal(client.SITUATION_BLURBS, SITUATION_BLURBS);
  assert.ok(Object.isFrozen(SITUATIONS));
});

test('no orphan situation: every id has a label, a blurb, an actor, a rung table and an errand', () => {
  for (const id of SITUATIONS) {
    assert.ok(SITUATION_LABELS[id]?.length > 3, id);
    assert.ok(SITUATION_BLURBS[id]?.length > 40, `${id} blurb must say what it means and what happens next`);
    assert.ok(['machine', 'person', 'wait', 'none'].includes(SITUATION_ACTOR[id]), id);
    const subs = SUB_KINDS[id];
    if (subs && (id === 'blocked-declared' || id === 'resource-wall')) {
      for (const sub of subs) assert.ok(situationKey(id, sub) in RUNGS_BY_SITUATION, `${id}:${sub} needs a rung table (empty is fine)`);
    } else {
      assert.ok(id in RUNGS_BY_SITUATION, `${id} needs a rung table (empty is fine)`);
    }
    if (SITUATION_ACTOR[id] === 'machine') {
      const table = subs && id !== 'plan-broken' ? subs.flatMap((sub) => rungsFor(situationKey(id, sub))) : rungsFor(id);
      assert.ok(table.length > 0, `${id} is a machine's but has no rung anywhere`);
    }
    const errand = errandFor(id, [], 1);
    assert.ok(errand.need.length > 10 && errand.how.length > 10, `${id} errand must say need + how`);
  }
  for (const key of Object.keys(RUNGS_BY_SITUATION)) {
    assert.ok(SITUATIONS.includes(parseSituationKey(key).id as never), `rung table for unknown situation ${key}`);
  }
  assert.deepEqual(parseSituationKey('blocked-declared:unknown'), { id: 'blocked-declared', sub: 'unknown' });
  assert.deepEqual(parseSituationKey('not-a-thing'), { id: 'unknown' });
  assert.equal(situationLabel('resource-wall', 'auth'), 'Resource wall · auth');
});

test('the park-note regexes mirror the runner\'s own', () => {
  assert.equal(VERIFICATION_PARK_RE.source, VERIFICATION_PARK_NOTE.source);
  assert.equal(MCP_PARK_RE.source, MCP_PARK_NOTE.source);
});

/* ------------------------------------------------------------------ *
 * The collector, against stubbed dependencies
 * ------------------------------------------------------------------ */

/**
 * autopilot-10: the `require` arm was unreachable code.
 *
 * `PhaseEvidence.mcp` is typed `{ unreachable, policy? }` and the classifier's
 * `mcp-unavailable` test has three disjuncts, the third being
 * `policy === 'require'`. But the only place the field was BUILT —
 * `collectEvidence` — populated `unreachable` alone, and neither evidence
 * builder passed a policy, so the disjunct could not fire from live evidence
 * and `summariseEvidence`'s `(policy …)` never printed. A phase whose plan
 * says it requires a server, degraded, with no halt kind and no park note,
 * classified as something else entirely.
 */
test('a degraded phase whose plan REQUIRES the server classifies mcp-unavailable (autopilot-10)', () => {
  const degraded = {
    ...P12_NEVER_STARTED,
    // No halt kind, no park note — the two disjuncts that already worked.
    run: { status: 'parked', halt: null, waitUntil: null, resolved: false },
    record: { ...P12_NEVER_STARTED.record!, status: 'failed', note: '' },
  } as PhaseEvidence;

  assert.notEqual(
    classifySituation({ ...degraded, mcp: { unreachable: ['serena'], policy: 'require' } }).id,
    'unknown',
  );
  assert.equal(
    classifySituation({ ...degraded, mcp: { unreachable: ['serena'], policy: 'require' } }).id,
    'mcp-unavailable',
    'the third disjunct fires now that something populates `policy`',
  );
  // `continue` is the default and must NOT park a phase on a server it was
  // told to do without — that is the whole point of the policy.
  assert.notEqual(
    classifySituation({ ...degraded, mcp: { unreachable: ['serena'], policy: 'continue' } }).id,
    'mcp-unavailable',
  );
});

test('collectEvidence carries the resolved MCP policy onto the evidence (autopilot-10)', async () => {
  const run = {
    id: 'r1', slug: 'demo', phases: {
      3: { phase: 3, status: 'failed', attempts: 1, mcpDegraded: [{ id: 'serena', reason: 'needs-auth' }] },
    },
  } as unknown as Parameters<typeof collectEvidence>[3];

  const asked: string[] = [];
  const e = await collectEvidence({
    root: '/nowhere',
    git: async () => null,
    mcpPolicy: (slug, phase) => { asked.push(`${slug}:${phase}`); return 'require'; },
  }, 'demo', 3, run, { 3: 'ready' });

  assert.deepEqual(asked, ['demo:3'], 'asked for this plan and phase');
  assert.equal(e.mcp?.policy, 'require');
  assert.deepEqual(e.mcp?.unreachable, ['serena']);

  // A dep that throws leaves the field off rather than losing the evidence.
  const thrown = await collectEvidence({
    root: '/nowhere', git: async () => null,
    mcpPolicy: () => { throw new Error('no plan'); },
  }, 'demo', 3, run, { 3: 'ready' });
  assert.equal(thrown.mcp?.policy, undefined);
  assert.deepEqual(thrown.mcp?.unreachable, ['serena'], 'the degradation itself survives');
});

test('parseLockStatus reads the script\'s shapes — including the session and the lease', () => {
  assert.equal(parseLockStatus('phase 3: free'), null);
  const held = parseLockStatus('phase 3: held by mobin@host since 2026-08-21 01:26, lease until 2026-08-21 01:56 [scope: phased-execution]');
  assert.deepEqual(held, {
    holder: 'mobin@host', ours: false, expired: false,
    // Declared on `LockEvidence` and documented since it was written, but never
    // assigned — the pattern captured the lease and threw it away.
    leaseUntil: Date.parse('2026-08-21 01:56'),
    scope: ['phased-execution'],
  });
  const expired = parseLockStatus('phase 3: held by autopilot/39f4afe9 since 2026-08-20 09:38, lease until 2026-08-20 10:08 (EXPIRED — free to take over) [scope: a, b]', (o) => o.startsWith('autopilot/'));
  assert.deepEqual(expired, {
    holder: 'autopilot/39f4afe9', ours: true, expired: true,
    leaseUntil: Date.parse('2026-08-20 10:08'),
    scope: ['a', 'b'],
  });

  // The fourth shape, and the one that was wrong: `phase-lock.sh` prints the
  // session as a BRACKETED suffix. `\S+` is greedy over non-whitespace, so it
  // captured the closing bracket too and produced an id (`sess-123]`) that
  // could never match the registry — which is the only thing the field is for.
  const withSession = parseLockStatus(
    'phase 3: held by mobin@host since 2026-08-21 01:26, lease until 2026-08-21 01:56 [scope: a, b] [session: 716c2bf1-4060-4cf8]',
  );
  assert.equal(withSession?.session, '716c2bf1-4060-4cf8', 'no trailing bracket');
  assert.deepEqual(withSession?.scope, ['a', 'b'], 'and the scope is still its own field');

  // A lock FILE line spells it `session=<id>`; both spellings read the same.
  assert.equal(
    parseLockStatus('phase 3: held by mobin@host since 2026-08-21 01:26 session=abc-123')?.session,
    'abc-123',
  );

  // A lease the script did not print, or printed unparseably, leaves the field
  // off rather than stamping NaN.
  const noLease = parseLockStatus('phase 3: held by mobin@host since 2026-08-21 01:26 [scope: a]');
  assert.equal(noLease?.leaseUntil, undefined);
});

test('workEvidence asks per scope directory, ignores submodule pointers, and says null when git cannot answer', async () => {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    const dir = args[0] === '-C' ? args[1] : '.';
    if (dir === 'missing') return null;
    if (args.includes('status')) return dir === 'web-admin' ? '' : ' M aws\n?? notes.md\n';
    if (args.includes('log')) return dir === 'web-admin' ? '' : 'abc123 feat\n';
    return '';
  };
  const clean = await workEvidence(git, '2026-08-14T23:05:01.401Z', ['web-admin']);
  assert.deepEqual(clean, { did: false, why: 'web-admin: clean tree, 0 commits since the phase started', dirty: 0, commits: 0 });
  assert.ok(calls.some((c) => c.includes('--ignore-submodules=all')), 'submodule pointers are not work');
  const dirty = await workEvidence(git, '2026-08-14T23:05:01.401Z', ['web-admin', '.']);
  assert.equal(dirty.did, true);
  assert.match(dirty.why, /\.: 2 uncommitted paths, 1 commit/);
  const unreadable = await workEvidence(git, null, ['missing']);
  assert.deepEqual(unreadable, { did: null, why: 'the working tree could not be read' });
  const noStart = await workEvidence(git, null, ['web-admin']);
  assert.equal(noStart.did, false);
  assert.match(noStart.why, /no start time/);
});

test('collectEvidence assembles the facts from the dependencies it is given, and never invents one', async () => {
  const run = newRun({ slug: 'alpha', root: '/repo' });
  const record = phaseRecord(run, 2);
  record.status = 'failed';
  record.sessionId = 'sess-2';
  record.startedAt = '2026-08-13T12:46:33.022Z';
  record.verification = { ok: false, reason: '1 of 2 failed', ran: [{ command: 'npm test', ok: false, code: 1, ms: 10, output: 'boom' }, { command: 'true', ok: true, code: 0, ms: 1, output: '' }], notRun: [], skipped: [] } as never;
  record.mcpDegraded = [{ id: 'serena', reason: 'unreachable' }] as never;
  run.halt = { at: 'x', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' };
  const e = await collectEvidence({
    root: '/repo',
    handoff: () => ({ status: 'in-progress', outstanding: 'exit criterion 4' }),
    lock: () => ({ holder: 'autopilot/r1', ours: true, expired: false }),
    qa: () => ({ mode: 'on', result: 'pending' }),
    health: () => [{ kind: 'index-stale', severity: 'warning', phase: 2 }],
    gate: () => ({ clear: true, kind: 'clear' }),
    repos: () => ['aws'],
    git: async (args) => (args.includes('status') ? ' M lambdas.yaml\n' : 'c15170d fix\n'),
    now: () => new Date('2026-08-13T13:47:11.000Z'),
  }, 'alpha', 2, run, { 1: 'done', 2: 'in-progress' });
  assert.equal(e.board, 'in-progress');
  assert.deepEqual(e.handoff, { exists: true, status: 'in-progress', outstanding: 'exit criterion 4' });
  assert.equal(e.record?.status, 'failed');
  assert.equal(e.record?.resumable, true);
  assert.deepEqual(e.record?.verification, { ok: false, failed: 1, ran: 2, skipped: 0 });
  assert.deepEqual(e.record?.mcpDegraded, ['serena']);
  assert.deepEqual(e.run?.halt, { kind: 'verify-failed', reason: 'phase 2 did not verify', phase: 2 });
  assert.deepEqual(e.lock, { holder: 'autopilot/r1', ours: true, expired: false });
  assert.equal(e.work.did, true);
  assert.match(e.work.why, /^aws: 1 uncommitted path, 1 commit since the phase started$/);
  assert.deepEqual(e.qa, { mode: 'on', result: 'pending' });
  assert.equal(e.health.length, 1);
  assert.equal(e.at, '2026-08-13T13:47:11.000Z');
  assert.equal(e.declared, null);
  assert.equal(e.registry, null);
  const lines = summariseEvidence(e);
  assert.ok(lines.some((l) => /^board: in-progress$/.test(l)));
  assert.ok(lines.some((l) => /^verification: red \(1\/2 ok\)$/.test(l)));
  assert.ok(lines.some((l) => /^lock: held by autopilot\/r1 \(ours\)$/.test(l)));
  // And the classifier reads the assembled facts the same way it reads a hand-built fixture.
  assert.equal(classifySituation(e).id, 'verify-red');
  // No record in the run, nothing on disk: the bare minimum still answers.
  const bare = await collectEvidence({ root: '/repo', git: async () => null }, 'alpha', 3, null, { 3: 'ready' });
  assert.equal(bare.record, null);
  assert.deepEqual(bare.work, { did: null, why: 'the working tree could not be read' });
  assert.equal(classifySituation(bare).id, 'never-started');
});

test('an APPROVED gate is not re-gated by the record\'s stale snapshot', () => {
  // The invariant CLAUDE.md pins — "the engine is the authority on gate state,
  // including for the healer" — had a hole one line wide. The live read is
  // consulted first and correctly declines when the engine says `clear`; the
  // very next statement then re-asked the RECORD's snapshot, taken before the
  // operator approved, with no reference to the live read at all. So approving
  // a gate left the classifier answering `gated-manual` for ever, the healer
  // wrote an errand for a gate that was already open, and the run stayed put.
  const base = {
    phase: 2, board: 'ready' as const,
    handoff: { exists: false }, lock: null, qa: null, health: [], work: { did: false, why: '' },
    record: { status: 'gated', gate: { clear: false, kind: 'manual', detail: 'an operator must confirm' } },
  };
  const live = classifySituation({ ...base, gate: { clear: true, kind: 'clear', detail: 'no gate' } } as never);
  assert.notEqual(live.id, 'gated-manual',
    'the engine says clear — a snapshot from before the approval must not overrule it');

  // The snapshot still speaks when the live read agrees...
  const stillGated = classifySituation({ ...base, gate: { clear: false, kind: 'manual', detail: 'confirm' } } as never);
  assert.equal(stillGated.id, 'gated-manual');
  // ...and when the live read could not RUN at all, which is the case it exists for.
  const unreadable = classifySituation({ ...base, gate: null } as never);
  assert.equal(unreadable.id, 'gated-manual');
});

test('a cmd gate the read did not EXECUTE is not "a person must clear it"', () => {
  // `--gate-status` refuses to run a `cmd` gate without PHASE_EXEC_GATES=1.
  // The classifier's read is the page-safe one, so every unapproved cmd gate
  // came back `manual` and was classified `gated-manual` — actor `person`, no
  // rungs, an errand at once. The console asked somebody to clear a gate that is
  // a COMMAND, and would have cleared itself the moment the runner boarded the
  // phase (the runner does pass PHASE_EXEC_GATES=1).
  //
  // "I could not check" and "a person must decide" are different facts — the
  // same rule the MCP probe already follows. Classification simply continues;
  // nothing is boarded on the strength of it, because boarding re-reads the
  // gate for real.
  //
  // Since console-speed-and-sync P9 the ENGINE draws the line itself, in the
  // kind. Both shapes are asserted here on purpose: the new word is what the
  // engine emits today, and the old one is what every run record written before
  // P9 still holds on disk.
  const base = {
    phase: 2, board: 'ready' as const,
    handoff: { exists: false }, lock: null, qa: null, health: [], work: { did: false, why: '' },
  };
  const unevaluated = classifySituation({
    ...base,
    gate: { clear: false, kind: 'unevaluated', detail: 'cmd gate not executed (set PHASE_EXEC_GATES=1 to evaluate): task ready' },
  } as never);
  assert.notEqual(unevaluated.id, 'gated-manual', 'the engine\'s own word for "I did not check"');

  const notRun = classifySituation({
    ...base,
    gate: { clear: false, kind: 'manual', detail: 'cmd gate not executed (set PHASE_EXEC_GATES=1 to evaluate): task ready' },
  } as never);
  assert.notEqual(notRun.id, 'gated-manual', 'a record written by a pre-P9 engine');

  // A gate that really does want a person is untouched.
  const real = classifySituation({
    ...base,
    gate: { clear: false, kind: 'manual', detail: 'operator — confirm the price row' },
  } as never);
  assert.equal(real.id, 'gated-manual');
});

test('a waived plan does not classify a done phase as QA-blocked', () => {
  // `**QA gate:** off` reports as `waived` and stops gating dependents, but the
  // classifier admitted any mode that was not `off` — so a done phase carrying a
  // stale `fail` row still read `qa-failed`, actor `machine`. `qaHolds` correctly
  // requires `on`, so the phase stays out of the candidate list; the healer's
  // no-candidate branch then classified the halt's phase anyway and wrote a QA
  // errand for a plan whose gate the operator had explicitly released.
  const base = {
    phase: 1, board: 'done' as const,
    handoff: { exists: true, status: 'complete' }, lock: null, health: [],
    work: { did: false, why: '' },
  };
  assert.equal(classifySituation({ ...base, qa: { mode: 'waived', result: 'fail' } } as never).id, 'superseded',
    'a released gate leaves settled work settled');
  assert.equal(classifySituation({ ...base, qa: { mode: 'waived' } } as never).id, 'superseded');
  // And a plan that really does gate is untouched.
  assert.equal(classifySituation({ ...base, qa: { mode: 'on', result: 'fail' } } as never).id, 'qa-failed');
  assert.equal(classifySituation({ ...base, qa: { mode: 'on' } } as never).id, 'qa-pending');
});

test('a delegated human gate is the ladder\'s, not a person\'s', () => {
  // `delegateHumanGates` reaches the RUNNER (a gated phase boots like an `ai`
  // one) but never reached the classifier — so a phase already recorded `gated`
  // from before the operator turned delegation on still classified
  // `gated-manual`, actor `person`, rungs `[]`. The ladder writes the errand at
  // once and never boards it: delegation silently did nothing for exactly the
  // phases that were already stuck, which are the ones an operator turns it on
  // for.
  const base = {
    phase: 2, board: 'ready' as const,
    handoff: { exists: false }, lock: null, qa: null, health: [],
    work: { did: false, why: '' },
    gate: { clear: false, kind: 'manual', detail: 'the owner approves the copy' },
  };
  assert.equal(classifySituation({ ...base } as never).id, 'gated-manual',
    'by default a human gate is a person\'s');
  assert.notEqual(classifySituation({ ...base, gateDelegated: true } as never).id, 'gated-manual',
    'delegated, it is something the ladder can board');
});

/* ------------------------------------------------------------------ *
 * D26 — the three shapes of a zero-turn exit
 * ------------------------------------------------------------------ */

/** `P12_NEVER_STARTED` with a zero-turn exit that said something. */
function exited(said: string): PhaseEvidence {
  return {
    ...P12_NEVER_STARTED,
    record: { ...P12_NEVER_STARTED.record!, status: 'interrupted', turns: 0, costUsd: 0, said },
  };
}

test('a laptop that slept resumes the same session, not a fresh one (D26)', () => {
  const s = classifySituation(exited('The session ended because the computer went to sleep mid-response.'));
  assert.equal(s.id, 'never-started');
  assert.equal(s.sub, 'sleep');
  assert.equal(s.key, 'never-started:sleep');
  assert.ok(s.why.some((w) => /went to sleep/.test(w)), s.why.join(' | '));
  // The whole point: the transcript is intact, so the FIRST rung resumes that
  // session. A fresh board would throw away the context a sleeping lid did not.
  const rungs = rungsFor(s.key);
  assert.equal(rungs[0]?.vehicle, 'resume-own-session');
  assert.equal(rungs[0]?.params?.mode, 'continue');
  assert.equal(rungs[1]?.vehicle, 'reboard-fresh', 'and it still falls back if the resume cannot be driven');
});

test('a policy refusal is a person\'s, and the errand quotes it (D26)', () => {
  const said = 'I can\'t help with that. [reasoning_extraction]';
  const s = classifySituation(exited(said));
  assert.equal(s.key, 'never-started:refusal');
  // No rungs at all: the same prompt gets the same refusal, so re-boarding is
  // spending to learn nothing. Three consecutive re-boards is what happened.
  assert.deepEqual([...rungsFor(s.key)], []);
  const errand = errandFor(s.key, [], 12, '2026-08-26T00:00:00.000Z', said);
  assert.match(errand.need, /what the model refused/i);
  assert.equal(errand.said, said, 'verbatim — a paraphrase of a refusal is not evidence of one');
});

test('a skill that would not load is an environment errand naming the install (D26)', () => {
  const s = classifySituation(exited('Unknown command: /phased-execution'));
  assert.equal(s.key, 'never-started:skill-missing');
  assert.deepEqual([...rungsFor(s.key)], [], 'the next attempt runs the same broken install');
  const errand = errandFor(s.key, [], 12, '2026-08-26T00:00:00.000Z', 'Unknown command: /phased-execution');
  assert.match(errand.how, /install-skill|Unknown command|Settings/i);
  assert.match(errand.need, /this machine/i);
});

test('an exit that names none of the three keeps today\'s path (D26)', () => {
  // The guard on the whole feature: a fourth shape must be MEASURED before it
  // earns a word, and until then nothing about the old behaviour may change.
  for (const said of ['', 'Done for now.', 'I read the plan and stopped.']) {
    const s = classifySituation(exited(said));
    assert.equal(s.key, 'never-started', `"${said}" must not be classified`);
    assert.equal(rungsFor(s.key)[0]?.vehicle, 'reboard-fresh');
  }
});

/* ------------------------------------------------------------------ *
 * A `waiting` record is only a declared wait when a session DECLARED one
 * (console-unattended-autopilot P2, QA round 2 G3)
 * ------------------------------------------------------------------ */

test('a waiting park the CONSOLE made is classified by its own note, not narrated as the session\'s', () => {
  // Arm 5 read `rec.status === 'waiting'` ALONE and then stated, as fact, "the
  // session declared it is waiting on external work". Both legitimate writers of
  // that status set `record.declared` in the same breath — so the only records
  // that reached it undeclared were parks the CONSOLE had made, which were then
  // attributed to a session that had said nothing AND pre-empted the arms that
  // would have read them correctly.
  //
  // The specimen is the retry-storm park (`runner.ts` `retryStormRemedy`): a
  // lane that emitted nothing but API retries, parked on the wall it was
  // hitting. Exit criterion 4 requires this to read `resource-wall:usage`.
  const parked: PhaseEvidence = {
    ...P12_NEVER_STARTED,
    board: 'in-progress',
    handoff: { exists: false },
    record: {
      ...P12_NEVER_STARTED.record!,
      status: 'waiting',
      note: 'nothing but API retries (rate_limit) — 5 API retries in a row, nothing produced '
        + 'for 12 min. Waiting until 2026-08-19T12:20:00.000Z, when the window resets.',
      endedAt: '2026-08-19T11:20:00.000Z',
    },
    run: { status: 'running', halt: null, waitUntil: null, resolved: false },
  };
  const s = classifySituation(parked);
  assert.equal(s.id, 'resource-wall');
  assert.equal(s.sub, 'usage', `read as ${s.key}: ${s.why.join(' · ')}`);
  // The guard is `declared` OR `watch`, and the second half is not optional: a
  // checkpoint written before `declared` existed carries the session's refs and
  // nothing else, and it IS a declared wait. Adding refs to this same record
  // must therefore put it back on arm 5.
  const legacy = classifySituation({
    ...parked, record: { ...parked.record!, watch: ['gh:acme/app#run/9'] },
  } as PhaseEvidence);
  assert.equal(legacy.id, 'waiting-external', 'a pre-`declared` wait is still a wait');
  // And nothing in the account of it claims the session said anything.
  assert.ok(
    !s.why.some((w) => /the session declared/.test(w)),
    `a console-made park must not be narrated as testimony: ${s.why.join(' · ')}`,
  );
});

test('a storm park on a phase that ONCE declared refs is a wall, not testimony — the shadow retires with the declaration', () => {
  // QA round 3, M1 — the C3 shape, built through the REAL state helpers, not by
  // hand. G3's guard held for the record it was tested on and was defeated by
  // this reachable neighbour: `parkWaiting` copies `declared.watch` onto
  // `record.watch`, and nothing cleared the copy — so a phase that had EVER
  // declared a `--watch` ref carried it for the life of the run, and a
  // retry-storm park the CONSOLE later made on it satisfied arm 5's second
  // disjunct and was narrated as the session's testimony all over again. This
  // is the plan's own normal case: a resumed session hitting a usage wall
  // after a long declared wait. `consumeDeclaration` now deletes the shadow
  // with the declaration it mirrors, so the record that reaches the classifier
  // no longer claims a wait that is over.
  const record = {
    ...P12_NEVER_STARTED.record!,
    status: 'waiting',
    // The declared park, exactly as `parkWaiting` leaves it: the declaration
    // AND its record-level copy.
    declared: {
      status: 'waiting-external', reason: 'the image build',
      watch: ['gh:acme/app#run/9'], at: '2026-08-19T10:00:00.000Z',
    },
    watch: ['gh:acme/app#run/9'],
  };
  // The resumed session produced a turn — the declaration is spent through the
  // one writer…
  consumeDeclaration(record as never, 'session-productive');
  // …and the lane then hits a retry storm; the console parks it
  // (`retryStormRemedy`'s exact writes — deliberately no `declared`).
  const parked: PhaseEvidence = {
    ...P12_NEVER_STARTED,
    board: 'in-progress',
    handoff: { exists: false },
    record: {
      ...record,
      status: 'waiting',
      note: 'nothing but API retries (rate_limit) — 5 API retries in a row, nothing produced '
        + 'for 12 min. Waiting until 2026-08-19T12:20:00.000Z, when the window resets.',
      endedAt: '2026-08-19T11:20:00.000Z',
    },
    run: { status: 'running', halt: null, waitUntil: null, resolved: false },
  } as PhaseEvidence;
  const s = classifySituation(parked);
  assert.equal(s.key, 'resource-wall:usage', `read as ${s.key}: ${s.why.join(' · ')}`);
  assert.ok(
    !s.why.some((w) => /the session declared/.test(w)),
    `a console-made park must not be narrated as testimony: ${s.why.join(' · ')}`,
  );
});

test('a DECLARED wait still reads waiting-external — the guard costs the real case nothing', () => {
  const declared: PhaseEvidence = {
    ...P12_NEVER_STARTED,
    board: 'in-progress',
    handoff: { exists: false },
    record: {
      ...P12_NEVER_STARTED.record!,
      status: 'waiting',
      note: 'waiting on the image build',
      parkReason: 'waiting on the image build',
      declared: { status: 'waiting-external', reason: 'waiting on the image build', watch: ['gh:acme/app#run/9'], at: '2026-08-19T11:00:00.000Z' },
      endedAt: '2026-08-19T11:20:00.000Z',
    },
    run: { status: 'parked', halt: null, waitUntil: null, resolved: false },
  } as PhaseEvidence;
  const s = classifySituation(declared);
  assert.equal(s.id, 'waiting-external', `read as ${s.key}`);
  assert.ok(s.why.some((w) => /the session declared/.test(w)));
});

/* ------------------------------------------------------------------ *
 * Declared blockers — the permission wall and the watch schemes (P12)
 * ------------------------------------------------------------------ */

test('blockerSubKind: a tool the permission policy refused is `permission`, read before the credential phrases; ssh\'s own "Permission denied" stays a credential', () => {
  // The measured specimen: local-ci-fast-feedback P8, twice, and console-autopilot-orphans P7 before it.
  const p8 = "Edit/Write on .claude/** is permission-denied in this unattended session (.claude/rules/ = 'sensitive file'; "
    + ".claude/skills/ = 'not granted'), and 3 of P8's 4 target files live there. Operator action: either grant the path or run the edits by hand.";
  assert.equal(blockerSubKind(p8), 'permission');
  assert.equal(blockerSubKind('Bash(git push:*) is denied on every profile — the deny wall holds and the PR cannot be opened from here.'), 'permission');
  assert.equal(blockerSubKind('The tool call was refused by the PreToolUse hook: WebFetch is not permitted for this plan.'), 'permission');
  assert.equal(blockerSubKind('ssh: Permission denied (publickey). Needs the deploy key for the box.'), 'credential');
  assert.equal(
    blockerSubKind('we could not write the handoff because CI blocked the merge — waiting on the pipeline to go green'),
    'external', 'lowercase prose about writing beside "blocked" is not a tool wall',
  );
  assert.equal(SUB_KINDS['blocked-declared'].includes('permission'), true);
  // One rung since phase 9 (TRS-10): the console offers the denied rule as an
  // approval card; nothing spends until a person answers it.
  assert.equal(rungsFor('blocked-declared:permission').length, 1);
  assert.equal(rungsFor('blocked-declared:permission')[0].vehicle, 'widen-rule');
  assert.equal(rungsFor('blocked-declared:permission')[0].spends, false);
  const ask = errandFor('blocked-declared:permission', [], 8);
  assert.match(ask.how, /Settings ▸ Permissions/);
  assert.match(ask.how, /Never strike a deny rule/);
});

/* ------------------------------------------------------------------ *
 * Phase 9 — the wall read from the console's own evidence (RCV-2, SES-3, LFC-3)
 * ------------------------------------------------------------------ */

test('RCV-2/SES-3: a credential-refused halt classifies resource-wall:auth for every class, from the kind alone — never blocked-declared', () => {
  const REASONS = {
    'org-policy': 'organization policy blocks this credential (account: account)',
    auth: 'authentication failed — the session\'s Claude login is expired or signed out; sign that account in again, then continue the run (account: p)',
    billing: 'billing or credit balance needs attention (account: p)',
    certificate: 'the API refused the connection: a certificate this machine does not trust (a self-signed or intercepting certificate) — fix the trust store or the proxy, then continue the run',
  } as const;
  for (const [cls, reason] of Object.entries(REASONS)) {
    // The run's halt, kind alone — the reason is prose the regexes never read.
    const s = classifySituation({
      ...P2_WORK_IN_PROGRESS,
      run: { status: 'halted', halt: { kind: 'credential-refused', reason, phase: 2 } },
    });
    assert.equal(s.key, 'resource-wall:auth', `${cls} from halt.kind`);
    assert.notEqual(s.id, 'blocked-declared');
    assert.ok(s.why.some((w) => /refused the run's credential/.test(w)), s.why.join(' | '));
    // …and the CAUSE on the record alone, with the run's halt long gone (a
    // relaunch cleared it; a later rung's result rewrote the record) — the
    // wall still answers, whatever the attempt looked like.
    const carried = classifySituation({
      ...P2_WORK_IN_PROGRESS,
      run: { status: 'parked', halt: null },
      record: {
        ...P2_WORK_IN_PROGRESS.record!, status: 'interrupted', turns: 0, costUsd: 0,
        cause: { kind: 'credential-refused', class: cls, reason, at: '2026-09-06T03:44:46.532Z', account: 'account' },
      },
    });
    assert.equal(carried.key, 'resource-wall:auth', `${cls} from record.cause`);
    assert.ok(carried.why.some((w) => new RegExp(`\\(${cls}\\)`).test(w)), carried.why.join(' | '));
    assert.ok(carried.why.some((w) => /stamped on the record/.test(w)));
    // Decided from the session's own sign-off (RCV-7, phase 10): the errand quotes it.
    assert.equal(s.fromSaid, true);
    assert.equal(carried.fromSaid, true);
  }
  // The runner's own halt sentence never reached `AUTH_RE` (the measured
  // miss): under the OLD kind it still reads as a declared blocker, which is
  // exactly why the kind — not the prose — now carries the class.
  const old = classifySituation({
    ...P2_WORK_IN_PROGRESS,
    run: { status: 'halted', halt: { kind: 'needs-human', reason: 'organization policy blocks this credential (account: account)', phase: 2 } },
  });
  assert.equal(old.id, 'blocked-declared', 'a 4.1.0 record keeps its old reading — the fix is the kind, not a regex');
});

test('RCV-2: the three sign-offs the reader was blind to classify never-started:refusal with an empty table, the cause named', () => {
  const cases: [string, string][] = [
    ['Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access', 'org-subscription'],
    ['API Error: Unable to connect to API: Self-signed certificate detected.', 'certificate'],
    ['organization policy blocks this credential (account: account)', 'org-policy'],
    ['I can\'t help with that. [reasoning_extraction]', 'aup'],
  ];
  for (const [said, cause] of cases) {
    assert.equal(classifyExitSaid(said), 'refusal', said);
    assert.equal(refusalCauseOf(said), cause, said);
    const s = classifySituation(exited(said));
    assert.equal(s.key, 'never-started:refusal', said);
    assert.equal(s.actor, 'person', 'a refusal is a person\'s — the sub-actor, not the parent\'s machine');
    assert.equal(s.fromSaid, true, 'the sub-kind was read off the words, so the errand quotes them (RCV-7)');
    assert.deepEqual([...rungsFor(s.key)], [], 're-boarding is spending to learn nothing');
    assert.ok(s.why.some((w) => w === `refusal cause ${cause}`), s.why.join(' | '));
    const errand = errandFor(s.key, [], 12, '2026-09-06T00:00:00.000Z', said);
    assert.equal(errand.said, said, 'the errand quotes the sign-off verbatim');
  }
  assert.deepEqual([...REFUSAL_CAUSES], ['aup', 'org-policy', 'org-subscription', 'certificate']);
  assert.equal(refusalCauseOf('tests for the organization chart module passed'), undefined, 'a session that merely mentioned an organisation was not refused by one');
  assert.equal(classifyExitSaid('Refactored the login-expired path and its tests'), undefined);
  // A bare `never-started` read nothing off the words: no flag, nothing quoted.
  const bare = classifySituation(exited('Refactored the login-expired path and its tests'));
  assert.equal(bare.key, 'never-started');
  assert.equal(bare.fromSaid, undefined);
});

test('LFC-3: the console\'s own tool-denied record classifies blocked-declared:permission above the prose; the wait guard\'s denial is not a permission block', () => {
  const blocked = (over: Partial<PhaseEvidence>) => classifySituation({
    ...P7_BLOCKED_DECLARED,
    handoff: { exists: true, status: 'blocked', outstanding: 'blocked — could not proceed' },
    ...over,
  });
  // A declaration that says only "blocked" used to read `:unknown` and spend
  // an unblock session walking into the wall the console had recorded.
  const denied = blocked({
    declared: { status: 'blocked', reason: 'blocked — could not proceed', watch: [] },
    record: {
      ...P7_BLOCKED_DECLARED.record!,
      toolDenied: { tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/demo', at: '2026-09-06T00:00:00.000Z' },
    },
  });
  assert.equal(denied.key, 'blocked-declared:permission');
  assert.equal(denied.actor, 'machine', 'it has a rung (widen-rule) — the machine\'s until a person answers the card');
  assert.ok(denied.why.some((w) => /refused Bash `git push origin pe\/demo` under rule Bash\(git push:\*\)/.test(w)), denied.why.join(' | '));
  // The session's own `--needs` word still outranks the console's denial.
  const declaredKey = blocked({
    declared: { status: 'blocked', reason: 'blocked — could not proceed', watch: [], needs: 'gate' },
    record: {
      ...P7_BLOCKED_DECLARED.record!,
      toolDenied: { tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push', at: '2026-09-06T00:00:00.000Z' },
    },
  });
  assert.equal(declaredKey.key, 'blocked-declared:gate');
  // The in-turn-wait guard refusing `until … sleep` is not a permission wall:
  // the session was told what to do instead, and a person has nothing to widen.
  const waited = blocked({
    declared: { status: 'blocked', reason: 'blocked — could not proceed', watch: [] },
    record: {
      ...P7_BLOCKED_DECLARED.record!,
      toolDenied: { tool: 'Bash', rule: 'in-turn-wait', command: 'until test -f /tmp/x; do sleep 30; done', matched: 'until [^`]+; *do', at: '2026-09-06T00:00:00.000Z' },
    },
  });
  assert.equal(waited.key, 'blocked-declared:unknown');
});

test('LFC-3: the four empty sub-tables are a person\'s — one table, read by the classifier, the ladder and the client alike', () => {
  assert.deepEqual(SITUATION_SUB_ACTOR, {
    'blocked-declared:credential': 'person',
    'blocked-declared:gate': 'person',
    'never-started:refusal': 'person',
    'never-started:skill-missing': 'person',
  });
  for (const key of Object.keys(SITUATION_SUB_ACTOR)) {
    assert.deepEqual([...rungsFor(key)], [], `${key} has no rung — that is why it is a person's`);
    const { id, sub } = parseSituationKey(key);
    assert.equal(actorFor(id, sub), 'person');
    assert.equal(SITUATION_ACTOR[id], 'machine', 'the parent climbs; only the sub-kind is a person\'s');
  }
  assert.equal(actorFor('blocked-declared', 'permission'), 'machine', 'the one sub-kind with a rung stays the machine\'s');
  assert.equal(actorFor('blocked-declared', 'unknown'), 'machine');
  assert.equal(actorFor('gated-manual'), 'person');
  assert.equal(actorFor('no-such-situation'), 'person', 'a word from a newer build reaches a person, never a crash');
});

test('blockerSubKind: every scheme the watch clock polls reads as an external wait, not only the GitHub ones', () => {
  const prose = 'The boxes have to come back first; nothing here can bring them up.';
  assert.equal(blockerSubKind(prose), 'unknown', 'the prose alone names no machine category');
  assert.equal(blockerSubKind(prose, ['date:2026-08-27T21:26:31Z']), 'external');
  assert.equal(blockerSubKind(prose, ['until:2026-08-27T21:26:31Z']), 'external');
  assert.equal(blockerSubKind(prose, ['cmd:"test -f /tmp/done"']), 'external');
  assert.equal(blockerSubKind(prose, ['gh:phased-execution-public/phase-console#run/1']), 'external');
  assert.equal(blockerSubKind(prose, ['lock:demo/3']), 'lock', 'a lock ref is still a lock');
});
