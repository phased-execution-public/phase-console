/**
 * The composer (turn-by-turn phase 3, §Architecture 3, `server/turn/compose.ts`):
 *
 *   TC-1  every watch-ref scheme is said in words (`shared/proof-words.js`) —
 *         the ref itself never reaches a person
 *   TC-2  every source × kind × state, in both editions: no title, need, how,
 *         step, check, row title or push title/body says a machine word, and
 *         every open item has a step (or its options) and a check sentence
 *   TC-3  every item's clocks: assigned (a projected one's from the
 *         first-seen store, kept across a restart), a start in words when not
 *         yet, the window as `openUntil`, a declared deadline
 *   TC-4  #255 — an act whose start is a date ahead stays upcoming, never
 *         folded into an act already due
 *   TC-5  #341 — a human step's window is `openUntil`, never a relayed
 *         question's `expiresAt`
 *   TC-6  the titles name the act — a plan act, an errand, a supervisor card
 *   TC-8  #377 — the title rule: sentence case, at most 80 characters, never a
 *         path list, the errand ref a chip (`errandRef`), the whole words as
 *         `headline`; the landing errand's short title and grouped files; the
 *         headline counts and never quotes a title
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildInbox } = await import('../server/inbox.ts');
const { turnView } = await import('../server/turn/index.ts');
const {
  composeItem, composeLanding, landingFilesWords, MACHINE_WORDS, PATH_LIST, scopeWords, shortTitle, TITLE_MAX,
} = await import('../server/turn/compose.ts');
const { FirstSeen, FIRST_SEEN_MAX } = await import('../server/turn/first-seen.ts');
const { humanStepPush, humanStepReminderPush } = await import('../server/push/catalogue.ts');
const { declareHumanStep, HumanStepLedger } = await import('../server/human-steps.ts');
const { WATCH_SCHEMES } = await import('../server/watch-refs.ts');
const { HUMAN_STEP_KINDS, HUMAN_STEP_STATES, HUMAN_STEP_SETTLED_STATES, KIND_META } = await import('../shared/human-step-model.js');
const { TURN_GROUPS, defaultReason } = await import('../shared/turn-model.js');
const { PROOF_SCHEME_WORDS, PROOF_COMMAND, proofWords, whenWords, startAtOf } = await import('../shared/proof-words.js');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const AT = '2026-10-13T11:00:00.000Z';
const AHEAD = '2026-10-20T17:00:00.000Z';

/* ------------------------------------------------------------------ *
 * TC-1 — proof words
 * ------------------------------------------------------------------ */

test('TC-1: every watch scheme has its words, and a ref is said, never echoed', () => {
  assert.deepEqual(Object.keys(PROOF_SCHEME_WORDS).sort(), [...WATCH_SCHEMES].sort(), 'one sentence per scheme the console polls');
  const table: [string, string][] = [
    ['gh:acme/app#pr/12', 'pull request #12 in acme/app is merged or closed'],
    ['gh:acme/app#run/4242', 'the run 4242 in acme/app finishes'],
    ['credential:gh', 'the gh CLI is signed in'],
    ['credential:keychain:deploy-token', 'the keychain item deploy-token is stored'],
    ['credential:env:API_KEY', "$API_KEY is set in the console's environment"],
    ['phase:fleet-clean/13', 'Phase 13 of fleet-clean is done'],
    ['verify:demo/3', 'the red checks of Phase 3 of demo pass'],
    ['lock:demo/4', 'the lock on Phase 4 of demo is free'],
    ['date:2026-10-20T17:00:00Z', 'it is 2026-10-20 17:00 UTC or later'],
    ['unit:build-box/nightly.service', 'the job nightly.service on build-box finishes'],
    ['cmd:"gh auth status"', 'the gh CLI reads signed in'],
    ['cmd:"test -f /srv/app/ready"', 'the file /srv/app/ready exists'],
    ['cmd:"git ls-remote --tags origin v7.1.0"', 'the tag v7.1.0 is on the remote'],
    ['cmd:"curl -fsS https://example.test/health"', 'https://example.test/health answers'],
    ['cmd:"./scripts/odd-probe.sh --deep"', PROOF_COMMAND],
  ];
  for (const [ref, words] of table) {
    assert.equal(proofWords(ref), words, ref);
    assert.doesNotMatch(proofWords(ref), /\b(gh|cmd|date|phase|verify|lock|unit|credential):/, `${ref} is said, not echoed`);
  }
  assert.equal(whenWords('phase:fleet-clean-2026-10/13'), 'when Phase 13 of fleet-clean-2026-10 is done');
  assert.equal(whenWords('date:2026-10-20T17:00:00Z'), 'at 2026-10-20 17:00 UTC');
  assert.equal(startAtOf('date:2026-10-20T17:00:00Z'), '2026-10-20T17:00:00.000Z');
  assert.equal(startAtOf('phase:demo/3'), null);
});

/* ------------------------------------------------------------------ *
 * The walk's facts — every source the console projects, and the ledger
 * ------------------------------------------------------------------ */

const OPEN_STATES = HUMAN_STEP_STATES.filter((state) => !(HUMAN_STEP_SETTLED_STATES as readonly string[]).includes(state));
const BIRTHS = [
  { birth: 'session', source: { kind: 'declaration' }, phase: 3 },
  { birth: 'plan', source: { kind: 'plan-bullet' }, phase: 2 },
  // The plan's own act — phase 0, an act under its `## Operator errands`.
  { birth: 'plan', source: { kind: 'plan-bullet' }, phase: 0 },
  { birth: 'console', source: { kind: 'errand', ref: 'blocked-declared:human-acts' }, phase: 4 },
  { birth: 'console', source: { kind: 'preflight', ref: 'credential:gh' }, phase: 1 },
  { birth: 'supervisor', source: { kind: 'supervisor', ref: 'turn-unopened' }, phase: 5 },
] as const;

/** One ledger step of a kind, in a state, of a birth — the fields every reader holds. */
function stepOf(kind: string, state: string, at: (typeof BIRTHS)[number], n: number): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (kind === 'device-code') extra.code = 'WXYZ-1234';
  if (kind === 'secret-entry') extra.credential = 'keychain:deploy-token';
  if (kind === 'permission') {
    extra.permission = { wall: 'deny', rule: 'Bash(rm:*)', command: 'rm -rf build', scopes: ['call'], family: 'any' };
  }
  if (kind === 'decision') extra.options = [{ id: 'box', label: 'The build box', recommended: true }, { id: 'cloud', label: 'The cloud runner' }];
  const proofs = ['cmd:"gh auth status"', 'gh:acme/app#pr/12', 'credential:gh', undefined, 'phase:demo/1'];
  const proof = proofs[n % proofs.length];
  return {
    id: `s-${kind}-${state}-${at.birth}-${at.phase}`, kind, title: `${KIND_META[kind as keyof typeof KIND_META].label} for the release (E-${n % 5 + 1})`,
    where: KIND_META[kind as keyof typeof KIND_META].where, slug: 'demo', phase: at.phase, runId: 'r1', birth: at.birth, state,
    declaredAt: AT, at: AT, opened: 0, attempts: state === 'returned' ? 1 : 0,
    why: defaultReason(kind as never), whySource: 'inferred',
    proofType: kind === 'decision' ? 'answer' : kind === 'permission' ? 'grant' : proof ? 'probe' : 'attest',
    ...(proof && kind !== 'decision' && kind !== 'permission' ? { proof } : {}),
    ...(n % 3 === 0 ? { openCommand: 'gh workflow run deploy.yml -R acme/app' } : n % 3 === 1 ? { openUrl: 'https://example.test/settings' } : {}),
    ...(n % 4 === 0 ? { lines: ['Open the settings page.', 'Add the key.'] } : {}),
    ...(state === 'upcoming' ? { dueWhen: n % 2 ? `date:${AHEAD}` : 'phase:demo/1' } : { until: AHEAD }),
    ...(n % 2 ? { deadline: '2026-10-25' } : {}),
    ...(state === 'checking' || state === 'returned' ? { checkedAt: AT } : {}),
    ...(state === 'returned'
      ? { verdict: { state: 'rejected', note: 'not stored yet', redo: ['store it again'], read: [], at: AT, by: 'probe', attempt: 1 } }
      : {}),
    waiters: [{ slug: 'demo', phase: at.phase, runId: 'r1' }], source: at.source,
    ...extra,
  };
}

const STEPS: Record<string, unknown>[] = [];
let n = 0;
for (const kind of HUMAN_STEP_KINDS) for (const state of HUMAN_STEP_STATES) for (const at of BIRTHS) STEPS.push(stepOf(kind, state, at, n++));

/** Every projected source: errands, cards, gates, QA, sign-ins, MCP, a session's ask, a conflict, the supervisor. */
function facts(): Record<string, unknown> {
  const errand = (phase: number, situation: string, need: string, how: string, extra: Record<string, unknown> = {}) => ({
    errand: { phase, situation, tried: [], need, how, at: AT, ...extra },
  });
  return {
    flags: { allowRun: true, allowWrites: true, allowAgent: true, allowAccounts: true, allowMcp: true },
    humanSteps: STEPS.filter((step) => !(HUMAN_STEP_SETTLED_STATES as readonly string[]).includes(step.state as string)),
    runs: [
      {
        id: 'r1', slug: 'demo', status: 'parked', updatedAt: AT,
        phases: { 7: { phase: 7, status: 'parked', planApproval: { state: 'pending' } } },
        recoveries: {
          1: errand(1, 'qa-failed', 'A QA verdict of pass or waived for this phase — the recorded fail holds every dependent.', 'Press Re-run QA.'),
          6: errand(6, 'blocked-declared:protected-path', 'A protected edit.', 'Apply it by hand.', { step: { kind: 'protected-path', act: 'bump the version', path: 'package.json' } }),
          7: errand(7, 'blocked-declared:plan-approval', 'A decision on the plan.', 'Approve or reject.'),
          8: errand(8, 'resource-wall:auth', 'Headroom: an account with usage left.', 'Sign an account in under Settings ▸ Accounts.'),
        },
      },
      // An identity park (turn-by-turn phase 4): its two options name both logins.
      {
        id: 'r3', slug: 'ident', status: 'halted', updatedAt: AT, halt: { at: AT, reason: 'changed identity', kind: 'identity-changed' },
        errand: {
          phase: 0, situation: 'resource-wall:auth', tried: [], at: AT, need: 'A person\'s choice of login.',
          how: 'Choose which login goes on.', identity: { was: 'a@example.com', now: 'b@example.com' },
        },
      },
      {
        id: 'r2', slug: 'other', status: 'halted', updatedAt: AT, halt: { at: AT, reason: 'stopped', kind: 'session-failed' },
        errand: { phase: 0, situation: 'plan-broken', tried: [], need: 'The plan-health issue this phase stopped on.', how: 'Open the plan and fix it.', at: AT },
      },
    ],
    approvals: [
      { id: 'a1', runId: 'r1', slug: 'demo', phase: 4, kind: 'tool', title: 'Run `rm -rf build`?', detail: 'Outside the allow list.', createdAt: AT, status: 'pending' },
      { id: 'a2', runId: 'r1', slug: 'demo', phase: 5, kind: 'verify', title: 'Check the page by eye', detail: 'The screenshots are attached.', createdAt: AT, status: 'pending' },
      {
        id: 'a3', runId: 'r1', slug: 'demo', phase: 3, kind: 'question', createdAt: AT, expiresAt: '2026-10-13T12:01:00.000Z', status: 'pending',
        question: { items: [{ key: 'q1', question: 'Which region should the build use?', options: [{ label: 'eu (Recommended)' }, { label: 'us' }] }] },
      },
    ],
    plans: [{
      slug: 'demo', closed: false, updatedAt: AT, qaMode: { mode: 'on' },
      qa: [{ phase: 9, result: 'fail', report: 'two assertions red' }, { phase: 10, result: 'pending' }],
      phases: [
        { phase: 9, state: 'done' }, { phase: 10, state: 'done' },
        { phase: 11, state: 'ready', gated: true, gateKind: 'human', gateCheck: 'a human look', gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' } },
      ],
    }],
    accounts: [{ id: 'work', name: 'Work', authState: 'expired' }],
    auth: { loggedIn: false, checkedAt: AT },
    mcp: [{ id: 'ctx7', label: 'Context7', enabled: true, status: 'needs-auth' }],
    sessions: [{
      sessionId: 'sess-live', kind: 'foreign', presence: 'live', cwd: '/work/app',
      waiting: { since: AT, kind: 'permission', note: 'Claude needs your permission to use Bash' },
    }],
    git: [
      { slug: 'alpha', branch: 'pe/alpha', startedAt: AT, isolation: 'worktree', radar: [{ a: 'pe/alpha', b: 'pe/beta', state: 'conflicted', files: ['a.ts'] }] },
      { slug: 'beta', branch: 'pe/beta', startedAt: AT, isolation: 'worktree', radar: [{ a: 'pe/alpha', b: 'pe/beta', state: 'conflicted', files: ['a.ts'] }] },
    ],
    supervisorCards: [
      { id: 'sc1', kind: 'suggestion', situation: 'ahead-of-dependency', slug: 'demo', phase: 12, runId: 'r1', since: AT, verb: 'bump', why: 'the policy is suggest: bump the dependency', evidence: ['phase 12 is queued ahead of phase 11'] },
      { id: 'sc2', kind: 'escalation', situation: 'turn-unopened', slug: 'demo', phase: 13, runId: 'r1', since: AT, verb: null, why: 'an item has waited unopened for two hours', evidence: ['nobody opened it'], command: 'phase-console open demo' },
      // An escalation pressed in the app (turn-by-turn phase 4): no command, its route bound to an action.
      {
        id: 'sc3', kind: 'escalation', situation: 'checkout-refused', slug: 'demo', phase: null, runId: 'r1', since: AT, verb: 'errand-tree',
        why: 'the run’s checkout was refused', evidence: ['refused'], action: { label: 'Give the run its own checkout', method: 'POST', endpoint: '/api/run/demo/isolate' },
      },
    ],
  };
}

/** Every person-facing word of one item — its options and its approval block too (turn-by-turn phase 4). */
function wordsOf(item: {
  title: string; need: string; how: string; check: string; meta: string; steps: { text: string; expect?: string; warn?: string }[];
  options?: { label: string; consequence?: string }[]; approval?: { what: string; askedBy: string; ifApproved: string; ifDenied: string } | null;
}): string[] {
  return [
    item.title, item.need, item.how, item.check, item.meta, ...item.steps.flatMap((s) => [s.text, s.expect ?? '', s.warn ?? '']),
    ...(item.options ?? []).flatMap((o) => [o.label, o.consequence ?? '']),
    ...(item.approval ? [item.approval.what, item.approval.askedBy, item.approval.ifApproved, item.approval.ifDenied] : []),
  ];
}

/* ------------------------------------------------------------------ *
 * TC-2 — the walk
 * ------------------------------------------------------------------ */

test('TC-2: every source × kind × state, both editions — no machine word, a step and a check on every open item', () => {
  const inbox = buildInbox(facts() as never, NOW, { all: true });
  // The inbox rows the bell, the Runs home and the fleet read.
  for (const row of inbox.items) {
    if (!row.turn) continue;
    for (const said of [row.title, row.need, row.how]) assert.doesNotMatch(said, MACHINE_WORDS, `${row.id}: "${said}"`);
  }
  const sources = new Set<string>();
  for (const edition of ['free', 'pro'] as const) {
    const answer = turnView(inbox, { steps: STEPS as never, now: NOW, edition });
    const items = TURN_GROUPS.flatMap((group) => answer.groups[group]);
    assert.ok(items.length > HUMAN_STEP_KINDS.length * OPEN_STATES.length, 'the walk reaches every open step and every projected source');
    for (const item of items) {
      sources.add(item.source);
      for (const said of wordsOf(item)) assert.doesNotMatch(said, MACHINE_WORDS, `${edition} ${item.item}: "${said}"`);
      assert.ok(item.title.trim(), `${item.item}: a title`);
      assert.match(item.check, /\.$/, `${item.item}: the check is a sentence`);
      assert.ok(item.timing.assignedAt && Number.isFinite(Date.parse(item.timing.assignedAt)), `${item.item}: assigned`);
      if (item.group === 'done') continue;
      assert.ok(item.steps.length >= 1 || Boolean(item.step?.options?.length), `${item.item}: a step or its options`);
    }
  }
  for (const source of ['session', 'plan', 'errand', 'preflight', 'supervisor', 'approval', 'question', 'person-check', 'gate', 'qa', 'sign-in', 'mcp-auth', 'session-ask', 'conflict', 'plan-approval']) {
    assert.ok(sources.has(source), `the walk reaches the ${source} source`);
  }
  // The pushes: the first one and a reminder, for every ledger step.
  for (const step of STEPS) {
    const facts = { ...step, label: KIND_META[step.kind as keyof typeof KIND_META].label } as never;
    for (const push of [humanStepPush(facts), humanStepReminderPush(facts, 2)]) {
      for (const said of [push.message.title, push.message.body, push.message.detail]) {
        assert.doesNotMatch(said, MACHINE_WORDS, `${step.id}: "${said}"`);
        assert.doesNotMatch(said, /\bphase 0\b/i, 'no "phase 0" on the lock screen');
      }
      if (step.openCommand) assert.ok(!push.message.body.includes(step.openCommand as string), `${step.id}: no raw command on the lock screen`);
    }
  }
});

test('TC-2: the steps come by precedence — an authored guide, the errands row, the lines, the ask, then a minimal guide', () => {
  const base = { source: 'plan', record: 'ledger', kind: 'operator-act', proofType: 'probe', why: 'reserved', slug: 'demo', phase: 2, now: NOW } as const;
  const guide = { lang: 'en', dir: 'ltr', summary: 'Rotate it.', steps: [{ text: 'Open the vault.', code: 'vault login' }], trouble: [{ symptom: 'denied', fix: 'ask the owner' }], version: 1 };
  assert.equal(composeItem({ ...base, step: { title: 'Rotate the key', guide, guideFrom: 'plan-file' } } as never).stepsFrom, 'guide');
  assert.equal(composeItem({ ...base, step: { title: 'Rotate the key', guide, guideFrom: 'errands-table' } } as never).stepsFrom, 'errand');
  const lines = composeItem({ ...base, step: { title: 'Rotate the key', lines: ['Open the vault'], openCommand: 'vault login' } } as never);
  assert.equal(lines.stepsFrom, 'lines');
  assert.deepEqual(lines.steps.map((s) => s.text), ['Run this command.', 'Open the vault.', "When it is done, press I've done this — check."]);
  const ask = composeItem({ ...base, record: 'projected', source: 'gate', row: { title: 'x', need: 'n', how: 'Do the steps, then press Approve.' } } as never);
  assert.equal(ask.stepsFrom, 'ask');
  assert.deepEqual(ask.steps.map((s) => s.text), ['Do the steps, then press Approve.']);
  const minimal = composeItem({ ...base, step: { title: 'Rotate the key (E-4)', proof: 'gh:acme/app#pr/12', openUrl: 'https://example.test/keys' } } as never);
  assert.equal(minimal.stepsFrom, 'minimal');
  assert.equal(minimal.title, 'Rotate the key', 'the errand ref is meta, not title');
  assert.equal(minimal.check, 'The console checks that pull request #12 in acme/app is merged or closed.');
  assert.equal(minimal.meta, 'demo · Phase 2');
  const own = composeItem({ ...base, phase: 0, step: { title: 'Rotate the key (E-4)', eref: 'E-4', effortMin: 10, unblocks: [{ slug: 'demo', phase: 3 }] } } as never);
  assert.equal(own.meta, "demo · the plan's own errand E-4 · about 10 min · unblocks Phase 3");
  assert.equal(scopeWords('demo', 0), 'the plan demo');
});

/* ------------------------------------------------------------------ *
 * TC-3 — the clocks
 * ------------------------------------------------------------------ */

test('TC-3: assigned, a start in words when not yet, the window, a declared deadline', () => {
  const answer = turnView(buildInbox(facts() as never, NOW, { all: true }), { steps: STEPS as never, now: NOW });
  const items = TURN_GROUPS.flatMap((group) => answer.groups[group]);
  const upcoming = items.filter((item) => item.step?.state === 'upcoming');
  assert.ok(upcoming.length > 0);
  for (const item of upcoming) {
    assert.equal(item.readiness, 'not-yet');
    assert.match(item.timing.startWhen ?? '', /^(when Phase 1 of demo is done|at 2026-10-20 17:00 UTC)$/, item.item);
    if (item.timing.startWhen?.startsWith('at ')) assert.equal(item.timing.startAt, AHEAD);
  }
  const windowed = items.find((item) => item.step?.state === 'notified')!;
  assert.equal(windowed.timing.openUntil, AHEAD, 'the window is openUntil');
  assert.equal(windowed.timing.assignedAt, AT, 'a ledger item is assigned when it was declared');
  assert.ok(items.some((item) => item.timing.deadline === '2026-10-25T00:00:00.000Z'), 'a declared deadline');
  const returned = items.find((item) => item.step?.state === 'returned')!;
  assert.equal(returned.verdict?.state, 'rejected');
  assert.equal(returned.timing.checkedAt, AT);
  assert.equal(returned.timing.submittedAt, AT);
});

test('TC-3: a projected item is assigned when it was first seen — the same answer after a restart, the store bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-first-seen-'));
  try {
    const file = join(dir, 'turn-first-seen.json');
    const inbox = buildInbox(facts() as never, NOW, { all: true });
    const read = (now: number) => {
      const store = new FirstSeen(file);
      const answer = turnView(inbox, { steps: STEPS as never, now, firstSeen: (entries) => store.stamp(entries, now) });
      return new Map(TURN_GROUPS.flatMap((g) => answer.groups[g]).filter((i) => i.record !== 'ledger').map((i) => [i.item, i.timing.assignedAt]));
    };
    const first = read(NOW);
    assert.ok(first.size > 5);
    // A new store over the same file — a restarted console — an hour on.
    const again = read(NOW + 3_600_000);
    assert.deepEqual(again, first, 'kept across a restart');
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).ids, 'the store is a file');
    // A row with no clock of its own is assigned at the first read that showed it.
    const store = new FirstSeen(join(dir, 'other.json'));
    assert.equal(store.stamp([{ id: 'x', since: '' }], NOW).get('x'), new Date(NOW).toISOString());
    // Bounded: the oldest go first.
    const many = Array.from({ length: FIRST_SEEN_MAX + 5 }, (_, i) => ({ id: `id-${i}`, since: AT }));
    store.stamp(many.slice(0, 5), NOW - 7_200_000);
    store.stamp(many.slice(5), NOW);
    const kept = JSON.parse(readFileSync(join(dir, 'other.json'), 'utf8')).ids as Record<string, unknown>;
    assert.equal(Object.keys(kept).length, FIRST_SEEN_MAX);
    assert.ok(!('id-0' in kept), 'the oldest is dropped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * TC-4 — #255
 * ------------------------------------------------------------------ */

test('TC-4 (#255): an act due at a date ahead stays upcoming — never folded into the same act already due', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-compose-255-'));
  try {
    const ledger = new HumanStepLedger(join(dir, 'human-steps.ndjson'), () => new Date(NOW));
    const door = { ledger, announce: () => true };
    const act = { kind: 'operator-act', title: 'Restart the console', open_command: 'phase-console restart demo', why: 'physical' };
    const now = declareHumanStep(door, { slug: 'demo', phase: 3, birth: 'session', step: act }) as { id: string; state: string };
    assert.equal(now.state, 'notified');
    const later = declareHumanStep(door, { slug: 'demo', phase: 4, birth: 'session', step: { ...act, due_when: `date:${AHEAD}` } }) as { id: string; state: string };
    assert.notEqual(later.id, now.id, 'a later start is an item of its own');
    assert.equal(later.state, 'upcoming', 'a date ahead is not due');
    // Another phase's act on the SAME start is still an act of ITS phase — two
    // items, never folded (turn-by-turn phase 7, #261, #257).
    const twin = declareHumanStep(door, { slug: 'demo', phase: 5, birth: 'session', step: { ...act, due_when: `date:${AHEAD}` } }) as { id: string; state: string };
    assert.notEqual(twin.id, later.id);
    assert.equal(twin.state, 'upcoming');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * TC-5 — #341
 * ------------------------------------------------------------------ */

test('TC-5 (#341): a human step\'s window is openUntil on its row and item — never a relayed question\'s countdown', () => {
  const step = STEPS.find((s) => s.state === 'notified' && s.kind === 'secret-entry')!;
  const inbox = buildInbox({ humanSteps: [step] } as never, NOW, { all: true });
  const row = inbox.items.find((item) => item.kind === 'human-step')!;
  assert.equal(row.expiresAt, undefined, 'no answer-by-rule countdown');
  assert.equal(row.openUntil, AHEAD);
  const item = turnView(inbox, { steps: [step] as never, now: NOW }).groups.now[0]!;
  assert.equal(item.timing.openUntil, AHEAD);
  // A relayed question keeps its window — it IS answered by rule when it closes.
  const question = buildInbox(facts() as never, NOW, { all: true }).items.find((item) => item.kind === 'question')!;
  assert.equal(question.expiresAt, '2026-10-13T12:01:00.000Z');
});

/* ------------------------------------------------------------------ *
 * TC-6 — the titles name the act
 * ------------------------------------------------------------------ */

test('TC-6: a plan act, an errand and a supervisor card are titled by their act', () => {
  const own = {
    ...stepOf('operator-act', 'notified', BIRTHS[2], 3), title: 'Rotate the deploy key (E-4)', openCommand: 'vercel env add KEY',
  };
  const inbox = buildInbox({ ...facts(), humanSteps: [own] } as never, NOW, { all: true });
  const plan = inbox.items.find((row) => row.kind === 'human-step')!;
  assert.equal(plan.title, 'Rotate the deploy key');
  const errand = inbox.items.find((row) => row.kind === 'errand' && row.phase === 1)!;
  assert.equal(errand.title, 'Decide what the failed QA review needs (Phase 1 of demo)', 'the ASK table names the act (turn-by-turn phase 4)');
  const push = humanStepPush({ ...own, label: KIND_META['operator-act'].label } as never);
  assert.equal(push.message.title, 'Now: Rotate the deploy key');
  assert.match(push.message.body, /^The plan demo — at the machine this console runs on\. /);
});

/* ------------------------------------------------------------------ *
 * TC-7 — a plan's heads-up (turn-by-turn phase 4, phase 3's deferral)
 * ------------------------------------------------------------------ */

test('TC-7: an errands row no bullet names is a Heads-up — its steps, nothing to press, in no group and never counted', async () => {
  const { parsePlan } = await import('../server/parse/plan.ts');
  const { PlanItems } = await import('../server/turn/plan-items.ts');
  const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'plans', 'guided.md');
  const plan = parsePlan(readFileSync(fixture, 'utf8'), 'guided');
  const items = new PlanItems({ plan: () => ({ plan, revision: 1 }), docsRoot: () => undefined });
  const headsUp = items.headsUp('guided');
  assert.deepEqual(headsUp.map((row) => row.id), ['E-5'], 'the one row no bullet names');
  const answer = turnView({ items: [], generatedAt: new Date(NOW).toISOString() }, { now: NOW, headsUp });
  const [item] = answer.headsUp;
  assert.ok(item);
  assert.equal(item.type, 'know', 'a Heads-up');
  assert.equal(item.title, 'Read the release notes once');
  assert.equal(item.stepsFrom, 'errand');
  assert.ok(item.steps.length >= 1 && /open the notes/i.test(item.steps[0]!.text), JSON.stringify(item.steps));
  assert.match(item.check, /Nothing checks it or waits on it/);
  assert.match(item.meta, /the plan's own errand E-5/);
  assert.deepEqual(item.actions, [], 'nothing to press');
  assert.equal(answer.counts.total, 0, 'never counted');
  assert.ok(TURN_GROUPS.every((group) => answer.groups[group].length === 0), 'in no group');
  for (const said of wordsOf(item)) assert.doesNotMatch(said, MACHINE_WORDS);
});

test('#368 — no checkWords output carries a machine word, a ref, or the console\'s phrase for a ref it cannot read', async () => {
  const { checkWords } = await import('../server/turn/compose.ts');
  const { PROOF_UNREAD } = await import('../shared/proof-words.js');
  const { PROOF_TYPES } = await import('../shared/turn-model.js');
  const proofs = [
    undefined, 'cmd:"gh auth status"', 'cmd:"grep -qi \'^store: answered\' /home/me/docs/owner-answers.md"',
    'mcp:linear', 'whenever it is done', 'cmd:"python3 -c \\"import x\\""', 'phase:demo/3', 'gh:acme/w#pr/4',
    'credential:keychain:svc', 'unit:box/build.service', 'date:2026-10-20T09:00:00Z',
  ];
  for (const proofType of PROOF_TYPES) {
    for (const proof of proofs) {
      for (const hasOptions of [false, true]) {
        const said = checkWords({ proofType, ...(proof ? { proof } : {}), hasOptions });
        assert.ok(!MACHINE_WORDS.test(said), `${proofType} ${proof ?? '-'}: ${said} carries a machine word`);
        assert.ok(!said.includes(PROOF_UNREAD), `${proofType} ${proof ?? '-'}: ${said}`);
        assert.ok(!/cmd:|POST \/api|phase 0\b/.test(said), said);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * TC-8 — the title rule (#377)
 * ------------------------------------------------------------------ */

/** The landing need a 7.1 console wrote — the title #377 quotes. */
const OLD_LANDING = 'ai-builder-e2e-fixes-r3 — pe/ai-builder-e2e-fixes-r3 in `aws` holds changes origin/main does not hold: '
  + 'contracts/api/app/routes.ts, contracts/api/app/models.ts, docs/plans/ai-builder.md, web/src/app.tsx';

test('TC-8 (#377): shortTitle — sentence case, at most 80 characters, cut at a word before a path list, the ref a chip', () => {
  const plan = shortTitle("enter Feed B's investor-password data account (E-4)");
  assert.deepEqual(plan, { title: "Enter Feed B's investor-password data account", errandRef: 'E-4' }, 'raised, the ref out, nothing cut');
  assert.equal(shortTitle('Rotate the key (E-4, hub #105)').errandRef, 'E-4');
  const old = shortTitle(OLD_LANDING);
  assert.ok(old.title.length <= TITLE_MAX, `${old.title.length}: ${old.title}`);
  assert.match(old.title, /^ai-builder-e2e-fixes-r3 /, 'a title that leads with a name says it as written — never "Ai-builder…"');
  assert.match(old.title, /…$/, 'an ellipsis, because it cut');
  assert.doesNotMatch(old.title, PATH_LIST);
  assert.doesNotMatch(old.title, /contracts\//, 'no file of the list');
  assert.equal(old.headline, OLD_LANDING, 'the whole words are the headline');
  // Never mid-word: what is left before the ellipsis is a prefix ending on a whole word.
  const kept = old.title.slice(0, -1);
  assert.ok(OLD_LANDING.startsWith(kept), kept);
  assert.match(OLD_LANDING.slice(kept.length, kept.length + 1), /[\s:,;]/, `cut at a boundary: "${kept}"`);
  assert.equal(shortTitle('pe/alpha × pe/beta — these branches would not merge').title, 'pe/alpha × pe/beta — these branches would not merge');
  const long = shortTitle('make sure the deploy key for the staging cluster is rotated before the window closes on friday evening');
  assert.ok(long.title.length <= TITLE_MAX && /^Make /.test(long.title) && long.title.endsWith('…'), long.title);
  const cut = long.title.slice(0, -1);
  assert.ok(long.headline!.startsWith(cut) && /^[\s:,;]/.test(long.headline!.slice(cut.length)), `never mid-word: "${long.title}"`);
  assert.deepEqual(shortTitle('Sign the gh CLI in'), { title: 'Sign the gh CLI in' }, 'a short title is left as it is');
});

test('TC-8 (#377): every item composes its title by the rule — a plan act with its ref, a long act with its headline, and its push', () => {
  const base = { source: 'plan', record: 'ledger', kind: 'operator-act', proofType: 'attest', why: 'reserved', slug: 'demo', phase: 0, now: NOW } as const;
  const plan = composeItem({ ...base, step: { title: "enter Feed B's investor-password data account (E-4)" } } as never);
  assert.equal(plan.title, "Enter Feed B's investor-password data account");
  assert.equal(plan.errandRef, 'E-4');
  assert.equal(plan.headline, undefined);
  const bound = composeItem({ ...base, step: { title: 'rotate the key', eref: 'E-9' } } as never);
  assert.equal(bound.errandRef, 'E-9', 'the plan item\'s own eref is the chip');
  const long = composeItem({ ...base, phase: 3, step: { title: `Check that ${OLD_LANDING}` } } as never);
  assert.ok(long.title.length <= TITLE_MAX, long.title);
  assert.ok(long.headline && long.headline.length > TITLE_MAX, 'the long form is the headline');
  // The row and the push say the same short title (one composer).
  const step = { ...stepOf('operator-act', 'notified', BIRTHS[1], 1), title: `Check that ${OLD_LANDING}` };
  const inbox = buildInbox({ ...facts(), humanSteps: [step] } as never, NOW, { all: true });
  const row = inbox.items.find((one) => one.kind === 'human-step')!;
  assert.equal(row.title, long.title);
  const push = humanStepPush({ ...step, label: KIND_META['operator-act'].label } as never);
  assert.equal(push.message.title, `Now: ${long.title}`);
  const answer = turnView(inbox, { steps: [step] as never, now: NOW });
  const item = TURN_GROUPS.flatMap((group) => answer.groups[group]).find((one) => one.item === step.id)!;
  assert.equal(item.title, long.title);
  assert.equal(item.headline, long.headline);
});

test('TC-8 (#377): the landing errand — a short title that names the act, its files grouped by repository', () => {
  const proof = (mount: string, n: number, state = 'ahead') => ({
    mount, branch: 'pe/ai-builder-e2e-fixes-r3', state, into: 'origin/main',
    files: Array.from({ length: n }, (_, i) => `${mount || 'docs'}/src/file-${i}.ts`),
  });
  const two = composeLanding('ai-builder-e2e-fixes-r3', [proof('aws', 12), proof('web', 3)], { mounted: true });
  assert.equal(two.title, 'Land ai-builder-e2e-fixes-r3 on main: 2 repositories differ from origin/main');
  assert.ok(two.title.length <= TITLE_MAX);
  assert.deepEqual(two.files.map((group) => [group.repo, group.paths.length]), [['aws', 12], ['web', 3]]);
  assert.equal(landingFilesWords(two.files), '12 files in aws · 3 in web');
  assert.match(two.need, /^Land ai-builder-e2e-fixes-r3 on main: 2 repositories differ from origin\/main\. The run branch pe\/ai-builder-e2e-fixes-r3 differs in 12 files in aws · 3 in web\.$/);
  assert.doesNotMatch(two.need, /file-0/, 'no path in the need either');
  const one = composeLanding('demo', [proof('aws', 1)], { mounted: true });
  assert.equal(one.title, 'Land demo on main: aws differs from origin/main');
  assert.equal(composeLanding('demo', [proof('', 2, 'conflicted')], { mounted: true }).title, 'Land demo on main: the root repository conflicts with main');
  assert.equal(composeLanding('demo', [proof('', 2, 'conflicted')]).title, 'Land demo on main: the repository conflicts with main');

  // The row and the card: the composer's title, the files riding along.
  const run = (errand: Record<string, unknown>) => ({
    id: 'r9', slug: 'ai-builder-e2e-fixes-r3', status: 'parked', updatedAt: AT, halt: { at: AT, reason: 'unlanded', kind: 'unlanded' },
    unlanded: { phase: 4 }, errand: { phase: 0, situation: 'unknown', tried: [], how: 'Merge it.', at: AT, ...errand },
  });
  const inbox = buildInbox({ runs: [run({ need: two.need, title: two.title, files: two.files })], flags: { allowRun: true } } as never, NOW, { all: true });
  const row = inbox.items.find((one) => one.kind === 'errand')!;
  assert.equal(row.title, two.title);
  assert.deepEqual(row.files, two.files);
  const answer = turnView(inbox, { now: NOW });
  const item = TURN_GROUPS.flatMap((group) => answer.groups[group]).find((one) => one.rows.includes(row.id))!;
  assert.equal(item.title, two.title);
  assert.deepEqual(item.files, two.files, 'the card draws them under Details');
  // An errand an older console wrote — the long need, no title — is cut to the rule, its whole words kept.
  const old = buildInbox({ runs: [run({ need: OLD_LANDING.replace(/^[^—]+— /, '') })], flags: { allowRun: true } } as never, NOW, { all: true });
  const oldRow = old.items.find((one) => one.kind === 'errand')!;
  assert.ok(oldRow.title.length <= TITLE_MAX, oldRow.title);
  assert.doesNotMatch(oldRow.title, PATH_LIST);
  assert.ok(oldRow.headline && oldRow.headline.includes('contracts/api/app/routes.ts'), 'the whole words ride as the headline');
  const oldItem = TURN_GROUPS.flatMap((group) => turnView(old, { now: NOW }).groups[group]).find((one) => one.rows.includes(oldRow.id))!;
  assert.equal(oldItem.title, oldRow.title);
  assert.equal(oldItem.headline, oldRow.headline);
});

test('TC-8 (#377): the headline counts — to do now, coming up, done today — and quotes no title', () => {
  const inbox = buildInbox(facts() as never, NOW, { all: true });
  const answer = turnView(inbox, { steps: STEPS as never, now: NOW });
  const todo = answer.counts.approve + answer.counts.now + answer.counts.decide;
  const parts = [
    `${todo} to do now`,
    ...(answer.counts.checking ? [`${answer.counts.checking} being checked`] : []),
    ...(answer.counts.upcoming ? [`${answer.counts.upcoming} coming up`] : []),
    ...(answer.counts.done ? [`${answer.counts.done} done today`] : []),
  ];
  assert.equal(answer.headline, `${parts.join(' · ')}.`);
  for (const item of TURN_GROUPS.flatMap((group) => answer.groups[group])) assert.ok(!answer.headline.includes(item.title), item.title);
  assert.equal(turnView({ items: [], generatedAt: new Date(NOW).toISOString() }, { now: NOW }).headline, 'Nothing needs you now.');
});

