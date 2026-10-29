/**
 * Every card is complete (turn-by-turn phase 11, §Architecture 1 and 3): the
 * walk is every source × kind × state × edition the console can raise, and each
 * item it yields must carry the whole card —
 *
 *   TCC-1  a type, a person's status, a readiness while the act is the
 *          person's or a settled word once it is not, a route (*Goes to*) the
 *          edition may say, *Checked by*, a check in words, at least one step,
 *          its options or its approval block — and no machine word anywhere
 *          a person reads it; the inbox rows the bell and the Runs home draw
 *          carry the same type and readiness
 *   TCC-2  the walk reaches what it claims: every source of `TURN_SOURCES`,
 *          every kind in every state, every type, every person's status and
 *          every route, in both editions
 *   TCC-3  the negative: a machine word planted in one step's lines, or a card
 *          stripped of its check, fails the walk and names the item
 *   TCC-4  #377 — every title is at most 80 characters, starts upper-case
 *          (unless it leads with a name: a branch, a path, a slug),
 *          holds no path list and no errand ref (the ref is `errandRef`, a chip)
 *   TCC-5  the packs' words (measured-console phase 29): a gstack
 *          `decisions.jsonl` approval row and a `GSTACK_RESULT … gate_pending`
 *          line, raised through the one door, are ONE whole card each — an
 *          Approval and a Decision
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { buildInbox } = await import('../server/inbox.ts');
const { turnView } = await import('../server/turn/index.ts');
const { MACHINE_WORDS } = await import('../server/turn/compose.ts');
const { closingAskOf, pendingApprovalsOf } = await import('../server/turn/packs.ts');
const { raiseTurn } = await import('../server/turn/index.ts');
const { HumanStepLedger } = await import('../server/human-steps.ts');
const { HUMAN_STEP_KINDS, HUMAN_STEP_STATES, HUMAN_STEP_SETTLED_STATES, KIND_META } = await import('../shared/human-step-model.js');
const {
  TURN_GROUPS, TURN_SOURCES, ITEM_TYPES, PERSON_STATUSES, PERSON_STATUS_LABEL, READINESS, ROUTE_TO, TYPE_META,
  CHECKED_BY_LABEL, readinessShown, defaultReason,
} = await import('../shared/turn-model.js');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const AT = '2026-10-13T11:00:00.000Z';
const AHEAD = '2026-10-20T17:00:00.000Z';
const EDITIONS = ['free', 'pro'] as const;
type Edition = (typeof EDITIONS)[number];

/** A watch ref echoed instead of said — the scheme a person must never read. */
const REF_ECHO = /\b(?:gh|cmd|date|verify|lock|unit|credential):\S/;
/** Two or more `/`-separated paths in a row — a list a title never carries (#377). */
const PATH_LIST = /(?:[\w.@~-]+\/)+[\w.@~-]+\s*,\s*(?:[\w.@~-]+\/)*[\w.@~-]+/;
/** A first word that is a name — a branch, a path, a slug with digits, a command in backticks. */
const NAME_LEAD = /^[^\s]*[/._@:\d`]/;
/** A plan's errands-table ref left in a title — "(E-4)" — which is a chip, never words (#377). */
const ERRAND_REF_IN_TITLE = /\(E-\d+\b[^)]*\)/;
/** The person's statuses a card says once the act is no longer theirs. */
const SETTLED_WORDS = new Set(['passed', 'not-doing', 'closed']);

/* ------------------------------------------------------------------ *
 * The walk's facts — every birth of a ledger step, and every projected source
 * ------------------------------------------------------------------ */

const BIRTHS = [
  { birth: 'session', source: { kind: 'declaration' }, phase: 3 },
  { birth: 'session', source: { kind: 'wall' }, phase: 3 },
  { birth: 'plan', source: { kind: 'plan-bullet' }, phase: 2 },
  // The plan's own act — phase 0, an act under its `## Operator errands`.
  { birth: 'plan', source: { kind: 'plan-bullet' }, phase: 0 },
  { birth: 'console', source: { kind: 'errand', ref: 'blocked-declared:human-acts' }, phase: 4 },
  { birth: 'console', source: { kind: 'preflight', ref: 'credential:gh' }, phase: 1 },
  { birth: 'console', source: { kind: 'relay', ref: 'unanswerable' }, phase: 6 },
  { birth: 'console', source: { kind: 'stall', ref: 'idle' }, phase: 8 },
  // A phase's run request (turn-by-turn phase 6): ONE approval per run and act.
  { birth: 'console', source: { kind: 'run-request', ref: 'hold' }, phase: 9 },
  { birth: 'supervisor', source: { kind: 'supervisor', ref: 'turn-unopened' }, phase: 5 },
  // What a session's closing words asked (measured-console phase 29): its prose questions, a pack's gate.
  { birth: 'console', source: { kind: 'prose-question', ref: 'sess-closing' }, phase: 14 },
  { birth: 'console', source: { kind: 'pack', ref: 'gstack:run-1-r2-p1' }, phase: 15 },
] as const;
type Birth = (typeof BIRTHS)[number];

const OPEN_STATES = HUMAN_STEP_STATES.filter((state) => !(HUMAN_STEP_SETTLED_STATES as readonly string[]).includes(state));

/** One ledger step of a kind, in a state, of a birth — every field a reader holds. */
function stepOf(kind: string, state: string, at: Birth, n: number): Record<string, unknown> {
  const meta = KIND_META[kind as keyof typeof KIND_META];
  const extra: Record<string, unknown> = {};
  if (kind === 'device-code') extra.code = 'WXYZ-1234';
  if (kind === 'secret-entry') extra.credential = 'keychain:deploy-token';
  if (kind === 'permission') {
    extra.permission = { wall: 'deny', rule: 'Bash(rm:*)', command: 'rm -rf build', scopes: ['call'], family: 'any' };
  }
  const decides = kind === 'decision' || at.source.kind === 'run-request';
  if (decides) {
    extra.options = [{ id: 'approve', label: 'Approve', recommended: true }, { id: 'deny', label: 'Deny' }];
    extra.recommended = 'approve';
  }
  const proofs = ['cmd:"gh auth status"', 'gh:acme/app#pr/12', 'credential:gh', undefined, 'phase:demo/1', 'date:2026-10-20T17:00:00Z'];
  const proof = proofs[n % proofs.length];
  const proofType = decides ? 'answer' : kind === 'permission' ? 'grant' : proof ? 'probe' : n % 2 ? 'judgement' : 'attest';
  return {
    id: `s-${kind}-${state}-${at.birth}-${at.source.kind}-${at.phase}`, kind, title: `${meta.label} for the release (E-${(n % 5) + 1})`,
    where: meta.where, slug: 'demo', phase: at.phase, runId: 'r1', birth: at.birth, state,
    declaredAt: AT, at: AT, opened: 0, attempts: state === 'returned' ? 1 : 0,
    why: defaultReason(kind as never), whySource: 'inferred', proofType,
    ...(proofType === 'judgement' ? { proofWords: 'the release page shows the notes published' } : {}),
    ...(proof && proofType === 'probe' ? { proof } : {}),
    ...(n % 3 === 0 ? { openCommand: 'gh workflow run deploy.yml -R acme/app' } : n % 3 === 1 ? { openUrl: 'https://example.test/settings' } : {}),
    ...(n % 4 === 0 ? { lines: ['Open the settings page.', 'Add the key.'] } : {}),
    ...(state === 'upcoming' ? { dueWhen: n % 2 ? `date:${AHEAD}` : 'phase:demo/1' } : { until: AHEAD }),
    ...(n % 2 ? { deadline: '2026-10-25' } : {}),
    ...(state === 'checking' || state === 'returned' || state === 'proven' ? { checkedAt: AT } : {}),
    ...(state === 'returned'
      ? { verdict: { state: 'rejected', note: 'not stored yet', redo: ['store it again'], read: [], at: AT, by: 'probe', attempt: 1 } }
      : {}),
    ...(state === 'proven' ? { verdict: { state: 'passed', note: 'it holds', redo: [], read: [], at: AT, by: 'probe', attempt: 1 } } : {}),
    ...(state === 'declined' || state === 'cannot' ? { note: 'Not this week — the owner is away.' } : {}),
    waiters: [{ slug: 'demo', phase: at.phase, runId: 'r1' }], source: at.source,
    ...extra,
  };
}

/** Every kind in every state, of every birth — the ledger half of the walk. */
function ledgerSteps(): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  let n = 0;
  for (const kind of HUMAN_STEP_KINDS) for (const state of HUMAN_STEP_STATES) for (const at of BIRTHS) steps.push(stepOf(kind, state, at, n++));
  return steps;
}

/** Every projected source: errands, cards, gates, QA, sign-ins, MCP, a session's ask, a conflict, the supervisor. */
function inboxFacts(steps: readonly Record<string, unknown>[]): Record<string, unknown> {
  const errand = (phase: number, situation: string, need: string, how: string, extra: Record<string, unknown> = {}) => ({
    errand: { phase, situation, tried: [], need, how, at: AT, ...extra },
  });
  return {
    flags: { allowRun: true, allowWrites: true, allowAgent: true, allowAccounts: true, allowMcp: true },
    humanSteps: steps.filter((step) => !(HUMAN_STEP_SETTLED_STATES as readonly string[]).includes(step.state as string)),
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
      // An identity park: its two options name both logins.
      {
        id: 'r3', slug: 'ident', status: 'halted', updatedAt: AT, halt: { at: AT, reason: 'changed identity', kind: 'identity-changed' },
        errand: {
          phase: 0, situation: 'resource-wall:auth', tried: [], at: AT, need: 'A person\'s choice of login.',
          how: 'Choose which login goes on.', identity: { was: 'a@example.com', now: 'b@example.com' },
        },
      },
      // A landing errand (#377): its title the composer's, its files for Details.
      {
        id: 'r4', slug: 'landing', status: 'parked', updatedAt: AT, halt: { at: AT, reason: 'unlanded', kind: 'unlanded' }, unlanded: { phase: 2 },
        errand: {
          phase: 0, situation: 'unknown', tried: [], at: AT, how: 'Merge the trunk into a merge errand tree and land it.',
          need: 'Land landing on main: 2 repositories differ from origin/main. The run branch pe/landing differs in 2 files in aws · 1 in web.',
          title: 'Land landing on main: 2 repositories differ from origin/main',
          files: [{ repo: 'aws', paths: ['contracts/api/a.ts', 'contracts/api/b.ts'] }, { repo: 'web', paths: ['src/app.tsx'] }],
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
      {
        id: 'sc3', kind: 'escalation', situation: 'checkout-refused', slug: 'demo', phase: null, runId: 'r1', since: AT, verb: 'errand-tree',
        why: 'the run’s checkout was refused', evidence: ['refused'], action: { label: 'Give the run its own checkout', method: 'POST', endpoint: '/api/run/demo/isolate' },
      },
    ],
  };
}

/** Two owner-door requests (control-tower phase 148): one about an item the turn shows, one about none — its own item. */
function ownerRequests(): Record<string, unknown>[] {
  const request = (id: string, item: unknown) => ({
    id, at: AT, state: 'open', door: 'local', label: 'a local script', proof: 'loopback', press: 'edit-prefs', authority: 'configure',
    risk: 'medium', method: 'POST', path: '/api/prefs', body: { convergeEveryMs: 30_000 }, summary: 'Change how often the console converges', item, repeats: 0,
  });
  return [request('e0request0a', null), request('e0request0b', { kind: 'approval', id: 'a1' })];
}

/** Done's projected items: a gate a person approved, and a question left alone. */
function settledRecords(): Record<string, unknown>[] {
  return [
    { item: 'gate:demo:11', at: AT, source: 'gate', outcome: 'passed', by: 'local', title: 'Approve the gate of Phase 11', what: 'Approved', slug: 'demo', phase: 11 },
    { item: 'question:demo:3', at: AT, source: 'question', outcome: 'closed', by: 'local', title: 'Which region should the build use?', what: 'Left for the session', slug: 'demo', phase: 3 },
  ];
}

/** The plans' heads-ups: an errands row no bullet names, with a guide and without. */
const HEADS_UP = [
  {
    slug: 'demo', id: 'E-7', what: 'renew the release domain before it lapses',
    guide: { lang: 'en', dir: 'ltr', summary: 'The domain lapses at the month end.', steps: [{ text: 'Open the registrar.' }, { text: 'Renew it for a year.' }], trouble: [], version: 1 },
  },
  { slug: 'demo', id: 'E-8', what: 'tell the owner the store listing is live' },
];

/* ------------------------------------------------------------------ *
 * The walk and its judge
 * ------------------------------------------------------------------ */

type Card = ReturnType<typeof turnView>['groups']['now'][number];

/** One edition's answer over the whole walk: every group's items and the heads-ups. */
function walk(edition: Edition, mutate?: (steps: Record<string, unknown>[]) => void) {
  const steps = ledgerSteps();
  mutate?.(steps);
  const inbox = buildInbox(inboxFacts(steps) as never, NOW, { all: true });
  const answer = turnView(inbox, {
    steps: steps as never, now: NOW, edition, requests: ownerRequests() as never, settled: settledRecords() as never, headsUp: HEADS_UP as never,
  });
  return { inbox, answer, items: [...TURN_GROUPS.flatMap((group) => answer.groups[group]), ...answer.headsUp], steps };
}

/** Every word of one card a person reads — its options, approval block, verdict and timing words too. */
function wordsOf(item: Card): string[] {
  const words: (string | undefined | null)[] = [
    item.title, item.need, item.how, item.check, item.meta, item.checkedBy,
    ...item.steps.flatMap((s) => [s.text, s.expect, s.warn]),
    ...(item.trouble ?? []).flatMap((t: { symptom?: string; fix?: string }) => [t.symptom, t.fix]),
    ...(item.options ?? []).flatMap((o) => [o.label, o.consequence]),
    ...(item.approval ? [item.approval.what, item.approval.askedBy, item.approval.ifApproved, item.approval.ifDenied] : []),
    item.timing?.startWhen,
  ];
  return words.filter((w): w is string => typeof w === 'string');
}

/** What is missing from one card, or wrong on it — empty when the card is whole. */
function cardMisses(item: Card, edition: Edition): string[] {
  const misses: string[] = [];
  const id = `${edition} ${item.item}`;
  if (!(ITEM_TYPES as readonly string[]).includes(item.type)) misses.push(`${id}: no type (${item.type})`);
  else if (!TYPE_META[item.type].label) misses.push(`${id}: a type with no label`);
  if (!(PERSON_STATUSES as readonly string[]).includes(item.personStatus) || !PERSON_STATUS_LABEL[item.personStatus]) {
    misses.push(`${id}: no person's status (${item.personStatus})`);
  }
  if (readinessShown(item.personStatus)) {
    if (!(READINESS as readonly string[]).includes(item.readiness)) misses.push(`${id}: the act is the person's and has no readiness (${item.readiness})`);
  } else if (item.group === 'done' && !SETTLED_WORDS.has(item.personStatus)) {
    misses.push(`${id}: done, but its status is no settled word (${item.personStatus})`);
  }
  if (!(ROUTE_TO as readonly string[]).includes(item.route)) misses.push(`${id}: no route (${item.route})`);
  if (edition === 'free' && item.route === 'supervisor') misses.push(`${id}: the free edition says the supervisor`);
  if (!item.checkedBy || !(Object.values(CHECKED_BY_LABEL) as string[]).includes(item.checkedBy)) misses.push(`${id}: no Checked by (${item.checkedBy})`);
  if (!item.title?.trim()) misses.push(`${id}: no title`);
  // The title rule (#377): short, sentence case, no path list, no errand ref.
  else {
    if (item.title.length > 80) misses.push(`${id}: a title of ${item.title.length} characters ("${item.title}")`);
    // Sentence case raises a word, never a name: "pe/alpha × pe/beta …" leads as written.
    if (/^\p{Ll}/u.test(item.title) && !NAME_LEAD.test(item.title)) misses.push(`${id}: a title that starts in lower case ("${item.title}")`);
    if (PATH_LIST.test(item.title)) misses.push(`${id}: a path list in the title ("${item.title}")`);
    if (ERRAND_REF_IN_TITLE.test(item.title)) misses.push(`${id}: an errand ref in the title ("${item.title}")`);
  }
  if (!/\S.*\.$/.test(item.check ?? '')) misses.push(`${id}: the check is not a sentence ("${item.check ?? ''}")`);
  if (item.group !== 'done') {
    const options = item.options?.length ?? item.step?.options?.length ?? 0;
    if (item.steps.length < 1 && !options && !item.approval) misses.push(`${id}: no step, no options and no approval block`);
  }
  for (const said of wordsOf(item)) {
    if (MACHINE_WORDS.test(said) || REF_ECHO.test(said)) misses.push(`${id}: a machine word in "${said.slice(0, 160)}"`);
  }
  return misses;
}

/* ------------------------------------------------------------------ *
 * TCC-1 — every card is whole
 * ------------------------------------------------------------------ */

test('TCC-1: every source × kind × state × edition yields a complete card, and its rows say the same words', () => {
  for (const edition of EDITIONS) {
    const { inbox, items } = walk(edition);
    assert.ok(items.length > HUMAN_STEP_KINDS.length * OPEN_STATES.length * BIRTHS.length, `${edition}: the walk reaches every open step`);
    const misses = items.flatMap((item) => cardMisses(item, edition));
    assert.deepEqual(misses.slice(0, 12), [], `${edition}: ${misses.length} miss(es)`);
    // The rows the bell, the Runs home and the fleet draw (turn-by-turn phase 10).
    for (const row of inbox.items) {
      if (!row.turn) continue;
      for (const said of [row.title, row.need, row.how]) assert.doesNotMatch(said, MACHINE_WORDS, `${row.id}: "${said}"`);
      assert.ok((ITEM_TYPES as readonly string[]).includes(row.turn.type as string), `${row.id}: the row carries the card's type`);
      assert.ok((READINESS as readonly string[]).includes(row.turn.readiness as string), `${row.id}: the row carries the card's readiness`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * TCC-4 — the title rule (#377)
 * ------------------------------------------------------------------ */

test('TCC-4: every title is short and sentence case, with no path list and no errand ref — the ref a chip, the files Details', () => {
  for (const edition of EDITIONS) {
    const { inbox, items } = walk(edition);
    // The walk's plan items carry "(E-n)" in their raw titles: each is a chip now.
    const plan = items.filter((item) => item.record === 'ledger' && item.source === 'plan');
    assert.ok(plan.length && plan.every((item) => /^E-\d+$/.test(item.errandRef ?? '')), `${edition}: every plan item carries its ref as a chip`);
    for (const row of inbox.items) {
      if (!row.turn) continue;
      assert.ok(row.title.length <= 80 && !PATH_LIST.test(row.title) && !ERRAND_REF_IN_TITLE.test(row.title), `${row.id}: "${row.title}"`);
    }
    const landing = items.find((item) => item.slug === 'landing');
    assert.equal(landing?.title, 'Land landing on main: 2 repositories differ from origin/main');
    assert.deepEqual(landing?.files?.map((group) => [group.repo, group.paths.length]), [['aws', 2], ['web', 1]]);
  }
  const { items } = walk('free');
  const whole = items.find((item) => item.group === 'now' && item.record === 'ledger' && item.steps.length > 0 && !item.options?.length && !item.approval)!;
  assert.match(cardMisses({ ...whole, title: 'x'.repeat(81) }, 'free').join('\n'), /a title of 81 characters/);
  assert.match(cardMisses({ ...whole, title: 'sign the gh CLI in' }, 'free').join('\n'), /starts in lower case/);
  assert.match(cardMisses({ ...whole, title: 'Land it: contracts/a.ts, docs/b.md' }, 'free').join('\n'), /path list/);
  assert.match(cardMisses({ ...whole, title: 'Rotate the key (E-4)' }, 'free').join('\n'), /errand ref/);
});

/* ------------------------------------------------------------------ *
 * TCC-2 — the walk reaches what it claims
 * ------------------------------------------------------------------ */

test('TCC-2: the walk reaches every source, every kind in every state, every type, status and route — in both editions', () => {
  for (const edition of EDITIONS) {
    const { items } = walk(edition);
    const seen = (pick: (item: Card) => string | undefined) => new Set(items.map(pick).filter(Boolean));
    const sources = seen((item) => item.source);
    for (const source of TURN_SOURCES) assert.ok(sources.has(source), `${edition}: the walk reaches the ${source} source`);
    const types = seen((item) => item.type);
    for (const type of ITEM_TYPES) assert.ok(types.has(type), `${edition}: a ${type} card`);
    const statuses = seen((item) => item.personStatus);
    for (const status of PERSON_STATUSES) assert.ok(statuses.has(status), `${edition}: a card reading ${status}`);
    const readiness = seen((item) => (readinessShown(item.personStatus) ? item.readiness : undefined));
    for (const word of READINESS) assert.ok(readiness.has(word), `${edition}: a card ${word}`);
    const routes = seen((item) => item.route);
    const expected = ROUTE_TO.filter((route) => (edition === 'free' ? route !== 'supervisor' : route !== 'run'));
    for (const route of expected) assert.ok(routes.has(route), `${edition}: a card that goes to the ${route}`);
    // A run request is the approval it was in every state, Done included.
    for (const item of items.filter((x) => x.source === 'run-request')) {
      assert.equal(item.type, 'approve', `${edition} ${item.item}: a run request is an approval`);
      assert.ok(item.approval?.what, `${edition} ${item.item}: a run request carries its approval block`);
    }
    // Every kind in every state — the ledger's open ones drawn, the settled ones on Done.
    const ledger = new Set(items.filter((item) => item.record === 'ledger').map((item) => `${item.kind}:${item.step?.state}`));
    for (const kind of HUMAN_STEP_KINDS) {
      for (const state of HUMAN_STEP_STATES) assert.ok(ledger.has(`${kind}:${state}`), `${edition}: a ${kind} card ${state}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * TCC-3 — the planted negative
 * ------------------------------------------------------------------ */

test('TCC-3: a machine word planted in one step fails the walk, naming the item', () => {
  const planted = 's-operator-act-opened-session-declaration-3';
  const { items } = walk('pro', (steps) => {
    const step = steps.find((s) => s.id === planted);
    assert.ok(step, 'the planted step is in the walk');
    step!.lines = ['Run POST /api/run/demo/stop from the console.'];
  });
  const misses = items.flatMap((item) => cardMisses(item, 'pro'));
  assert.ok(misses.length >= 1, 'the planted word is found');
  assert.ok(misses.every((m) => m.includes(planted)), `only the planted item misses: ${misses.join(' | ')}`);
  assert.match(misses.join('\n'), /machine word in "Run POST \/api\/run\/demo\/stop/);
});

test('TCC-3: a card stripped of its check, its steps or its route fails the judge', () => {
  const { items } = walk('free');
  const whole = items.find((item) => item.group === 'now' && item.record === 'ledger' && item.steps.length > 0 && !item.options?.length && !item.approval);
  assert.ok(whole, 'a whole Do now card');
  assert.deepEqual(cardMisses(whole!, 'free'), []);
  assert.match(cardMisses({ ...whole!, check: '' }, 'free').join('\n'), /check is not a sentence/);
  assert.match(cardMisses({ ...whole!, steps: [], step: { ...whole!.step, options: [] } } as never, 'free').join('\n'), /no step, no options/);
  assert.match(cardMisses({ ...whole!, route: 'supervisor' }, 'free').join('\n'), /free edition says the supervisor/);
  assert.match(cardMisses({ ...whole!, readiness: undefined } as never, 'free').join('\n'), /no readiness/);
  assert.match(cardMisses({ ...whole!, title: 'Wait for cmd:"gh auth status"' }, 'free').join('\n'), /machine word/);
});

/* ------------------------------------------------------------------ *
 * TCC-5 — the packs' words
 * ------------------------------------------------------------------ */

test('TCC-5: a gstack approval row and a GSTACK_RESULT gate line each become ONE whole card — an Approval and a Decision', () => {
  const packs = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packs');
  const read = (name: string) => readFileSync(join(packs, name), 'utf8');
  const said = read('closing-gstack-gate.md').replace('RUN_DIR', '/tmp/run-1');
  const row = closingAskOf(said, { ref: 'sess-a', readRun: () => pendingApprovalsOf(read('decisions.jsonl'), read('gate.json')) })!;
  const line = closingAskOf(said, { ref: 'sess-b', readRun: () => [] })!;
  const dir = mkdtempSync(join(tmpdir(), 'pc-tcc-packs-'));
  try {
    const ledger = new HumanStepLedger(join(dir, 'human-steps.ndjson'));
    const door = { ledger, announce: () => true };
    for (const [ask, phase] of [[row, 14], [line, 15]] as const) {
      raiseTurn(door, { slug: 'demo', phase, birth: 'console', runId: 'r1', step: ask.step });
      // The same source asked again is the same item.
      raiseTurn(door, { slug: 'demo', phase, birth: 'console', runId: 'r1', step: ask.step });
    }
    const raised = ledger.all();
    assert.equal(raised.length, 2, 'one item each');
    for (const edition of EDITIONS) {
      const { items } = walk(edition, (steps) => steps.push(...(raised as never[])));
      const cards = items.filter((item) => raised.some((step) => step.id === item.item));
      assert.equal(cards.length, 2, `${edition}: both reach the page`);
      const approval = cards.find((card) => card.item === raised[0]!.id)!;
      const decision = cards.find((card) => card.item === raised[1]!.id)!;
      assert.equal(approval.type, 'approve', `${edition}: the approval row is an Approval`);
      assert.equal(decision.type, 'decide', `${edition}: the gate line is a Decision`);
      assert.equal(approval.source, 'session');
      assert.deepEqual(approval.options?.filter((o) => o.recommended).map((o) => o.label), ['Approve with the recommended changes']);
      assert.deepEqual(decision.options?.filter((o) => o.recommended).map((o) => o.label), ['Take every recommendation']);
      for (const card of cards) {
        assert.ok(card.steps.length >= 1, `${edition} ${card.item}: steps`);
        assert.deepEqual(cardMisses(card, edition), [], `${edition} ${card.item}: a whole card`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

