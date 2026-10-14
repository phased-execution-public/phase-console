/**
 * `GET /api/turn` — Your turn's one read (control-tower phase 132, #209):
 *
 *   TP-1  it answers `{round, headline, groups, handled, counts}`: every
 *         non-fyi inbox row that asks a person for an act, as an item with
 *         the ledger's detail and the endpoints that press it, grouped by
 *         `groupOf`; an errand and the step it describes are ONE item
 *   TP-2  rows nothing waits on (health, lock, ruling, policy, message) are
 *         not in it, and issue drafts are one line with a link
 *   TP-3  the route answers it — the same items as the inbox's person-facing
 *         rows
 *   TP-4  every item carries the card's four words (turn-by-turn phase 1):
 *         `type`, `personStatus`, `readiness` and `route` — the route in the
 *         console's edition
 *   TP-5  `GET /api/turn/:id` answers a PROJECTED id with its card, and every
 *         item carries its check's `verdict` and `verdicts` (turn-by-turn
 *         phase 3)
 *   TP-6  a pressed approval, gate or plan approval — and an option bound to
 *         the ack — shows in Done as Passed or Closed, with who pressed and
 *         when, from its settled record (turn-by-turn phase 5); a machine's
 *         decision keeps none
 *   TP-7  every item carries `route` and `checkedBy` in both editions, and the
 *         Free answer never says the supervisor (turn-by-turn phase 5)
 *   TP-8  every inbox row that is an item carries the card's words — its type,
 *         its readiness and NOT YET's *when* — and sits in the group its card
 *         sits in (turn-by-turn phase 10)
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const { buildInbox } = await import('../server/inbox.ts');
const { turnView, turnOf, BELL_KINDS } = await import('../server/turn/index.ts');
const { TURN_GROUPS, CHECKED_BY_LABEL, ROUTE_META } = await import('../shared/turn-model.js');
const { settledOfJournal, SettledStore } = await import('../server/turn/settled.ts');
const { inboxItemId } = await import('../shared/attention-model.js');

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const AT = '2026-10-07T11:00:00.000Z';

/** A session's step, its phase parked on it, and the errand the runner wrote for it. */
const STEP = {
  id: 'step-a1', kind: 'browser-login', title: 'Sign the gh CLI in to acme', where: 'host', slug: 'alpha', phase: 2,
  runId: 'r1', birth: 'session', state: 'notified', declaredAt: AT, at: AT, opened: 0, attempts: 0,
  why: 'identity', whySource: 'declared', proofType: 'probe', proof: 'cmd:"gh auth status"',
  waiters: [{ slug: 'alpha', phase: 2, runId: 'r1' }], source: { kind: 'declaration' },
};

function facts(): Record<string, unknown> {
  return {
    flags: { allowRun: true },
    humanSteps: [STEP, { ...STEP, id: 'step-up', state: 'upcoming', title: 'Approve the release', kind: 'operator-act', why: 'reserved', proofType: 'attest', proof: undefined, dueWhen: 'phase:alpha/1', phase: 1, runId: undefined, birth: 'plan', source: { kind: 'plan-bullet' } }],
    runs: [{
      id: 'r1', slug: 'alpha', status: 'parked', updatedAt: AT,
      phases: { 2: { phase: 2, status: 'parked', declared: { step: { id: 'step-a1' } } } },
      recoveries: { 2: { errand: { phase: 2, situation: 'blocked-declared:human-acts', tried: [], need: 'Your turn — sign in', how: 'At the machine', at: AT, stepId: 'step-a1' } } },
    }],
    plans: [{
      slug: 'alpha', closed: false, updatedAt: AT,
      phases: [{ phase: 6, state: 'ready', gated: true, gateKind: 'human', gateCheck: 'a human look', gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' } }],
    }],
  };
}

test('TP-1: the answer is {round, headline, groups, handled, counts} — an errand and its step are ONE item, pressed through the step', () => {
  const inbox = buildInbox(facts() as never, NOW, { all: true });
  const answer = turnView(inbox, { steps: facts().humanSteps as never, now: NOW });
  // `seen` (control-tower phase 136): the person's last look, which the
  // handled count is taken from — null here, so the count is the last day's.
  // `headsUp` (turn-by-turn phase 4): the plans' unbound errands rows, in no group.
  // `strip` (turn-by-turn phase 9): the page's numbers and its next deadline.
  assert.deepEqual(Object.keys(answer).sort(), ['counts', 'groups', 'handled', 'headline', 'headsUp', 'issues', 'round', 'seen', 'strip']);
  assert.equal(answer.seen, null);
  assert.deepEqual(Object.keys(answer.groups), [...TURN_GROUPS]);
  assert.deepEqual(answer.handled, []);
  assert.equal(answer.round.at, inbox.generatedAt);
  const all = TURN_GROUPS.flatMap((group) => answer.groups[group]);
  // The errand row and the step's own row are one item, its id the step's.
  const step = all.find((item) => item.item === 'step-a1');
  assert.ok(step, 'the step is an item');
  assert.equal(all.filter((item) => item.item === 'step-a1').length, 1, 'ONE item, not two');
  assert.equal(step!.rows.length, 2, 'standing for both rows');
  assert.ok(step!.rows.some((row) => row.startsWith('errand')) && step!.rows.some((row) => row.startsWith('human-step')));
  assert.equal(step!.record, 'ledger');
  assert.equal(step!.group, 'now');
  assert.equal(step!.actions[0]?.endpoint, '/api/human-steps/step-a1/check', 'pressed through the ledger');
  assert.equal(step!.step?.proof, 'cmd:"gh auth status"', 'with the ledger\'s detail');
  assert.equal(step!.step?.why, 'identity');
  // A gate is projected: its own row, its own endpoints.
  const gate = all.find((item) => item.source === 'gate');
  assert.ok(gate);
  assert.equal(gate!.record, 'projected');
  assert.equal(gate!.group, 'approve', 'the groups v2: a gate is a yes or no — Approve');
  const gateRow = inbox.items.find((row) => row.kind === 'gate')!;
  assert.equal(gate!.item, gateRow.id);
  assert.deepEqual(gate!.actions, gateRow.actions);
  // An act not due yet is coming up — its row is fyi, the item is not lost.
  assert.deepEqual(answer.groups.upcoming.map((item) => item.item), ['step-up']);
  assert.equal(answer.counts.approve, 1);
  assert.equal(answer.counts.now, 1);
  assert.equal(answer.counts.decide, 0);
  assert.equal(answer.counts.upcoming, 1);
  assert.equal(answer.counts.total, 3, 'the open total counts Approve');
  assert.deepEqual(answer.strip, { todo: 2, checking: 0, passedToday: 0, nextDeadline: null });
  // The card's four words (turn-by-turn phase 1), on every item.
  const words = (item: { type: string; personStatus: string; readiness: string; route: string }) =>
    [item.type, item.personStatus, item.readiness, item.route];
  assert.deepEqual(words(step!), ['do', 'todo', 'now', 'phase'], 'a session\'s sign-in: a task, its phase resumes');
  assert.deepEqual(words(gate!), ['approve', 'todo', 'now', 'gate'], 'a manual gate: an approval, the gate opens');
  assert.deepEqual(words(answer.groups.upcoming[0]!), ['do', 'todo', 'not-yet', 'phase'], 'an act not due yet');
  // Composed by phase 136's rules: how many need the person and the oldest,
  // then what is coming up.
  assert.equal(answer.headline, '2 need you now — the oldest (Sign the gh CLI in to acme) has waited 1 h and holds phase 2 · 1 coming up.');
});

test('TP-1: a step settled in the last day is Done, with nothing to press; an older one is gone', () => {
  const settled = { ...STEP, id: 'step-done', state: 'proven', at: '2026-10-07T09:00:00.000Z' };
  const old = { ...STEP, id: 'step-old', state: 'proven', at: '2026-10-05T09:00:00.000Z' };
  const answer = turnView({ items: [], generatedAt: new Date(NOW).toISOString() }, { steps: [settled, old] as never, now: NOW });
  assert.deepEqual(answer.groups.done.map((item) => item.item), ['step-done']);
  assert.deepEqual(answer.groups.done[0]!.actions, []);
  // The headline's rules are phase 136's (`turn/headline.ts` `headlineOf`).
  assert.equal(answer.headline, 'Nothing needs you now.');
});

test('TP-4: the four words on every item — a plan\'s own act is the console\'s, the ladder\'s ask the run\'s or the supervisor\'s, an owner request waits for the owner', () => {
  const own = {
    ...STEP, id: 'step-own', kind: 'operator-act', title: 'Rotate the release key', phase: 0, runId: undefined, birth: 'plan',
    why: 'reserved', proofType: 'attest', proof: undefined, waiters: [{ slug: 'alpha', phase: 0 }], source: { kind: 'plan-bullet' },
  };
  const row = (kind: string, id: string, extra: Record<string, unknown> = {}) => ({
    id, kind, severity: 'needs-you', title: id, need: 'n', how: 'h', since: AT, actions: [], href: `#/${id}`, slug: 'alpha', phase: 2, ...extra,
  });
  const ownRow = row('human-step', 'human-step:step-own', { subject: 'step-own', phase: 0, turn: turnOf({ kind: 'human-step', subject: 'step-own' }, 'human-step:step-own', () => own as never) });
  const errandRow = row('errand', 'errand:alpha:2', { turn: turnOf({ kind: 'errand' }, 'errand:alpha:2', () => undefined) });
  const request = {
    id: 'req-1', at: AT, state: 'open', door: 'session', label: 'alpha phase 2', proof: 'run r1', press: 'run-resume',
    authority: 'run', risk: 'low', method: 'POST', path: '/api/runs/r1/resume', body: {}, summary: 'Resume the run', item: null, repeats: 0,
  };
  const read = (edition?: 'free' | 'pro') => {
    const answer = turnView({ generatedAt: AT, items: [ownRow, errandRow] as never }, {
      steps: [own] as never, now: NOW, requests: [request] as never, ...(edition ? { edition } : {}),
    });
    return new Map(TURN_GROUPS.flatMap((group) => answer.groups[group]).map((item) => [item.item, item]));
  };
  const free = read();
  assert.equal(free.get('step-own')?.type, 'do');
  assert.equal(free.get('step-own')?.route, 'console', 'the plan\'s own act: the console checks it');
  assert.equal(free.get('errand:alpha:2')?.type, 'decide');
  assert.equal(free.get('errand:alpha:2')?.route, 'run', 'Free: the run applies it');
  assert.equal(read('pro').get('errand:alpha:2')?.route, 'supervisor', 'Pro: the supervisor applies it');
  const owner = free.get('request:req-1');
  assert.ok(owner, 'the request is an item of its own');
  assert.deepEqual([owner!.type, owner!.personStatus, owner!.route], ['approve', 'owner', 'console']);
  for (const item of free.values()) {
    for (const key of ['type', 'personStatus', 'readiness', 'route'] as const) assert.ok(item[key], `${item.item}: ${key}`);
  }
});

test('TP-2: rows nothing waits on are not items; issue drafts are one line with a link', () => {
  for (const kind of BELL_KINDS) {
    assert.equal(turnOf({ kind, severity: 'needs-you' }, `${kind}:x`, () => undefined), undefined, `${kind} stays in the bell`);
  }
  assert.equal(turnOf({ kind: 'issue-draft', severity: 'needs-you' }, 'issue-draft:x', () => undefined), undefined);
  const row = (kind: string, id: string, extra: Record<string, unknown> = {}) => ({
    id, kind, severity: 'needs-you', title: id, need: 'n', how: 'h', since: AT, actions: [], href: `#/${id}`, ...extra,
  });
  const answer = turnView({
    generatedAt: AT,
    items: [row('health', 'health:a'), row('lock', 'lock:a'), row('issue-draft', 'issue-draft:a', { href: '#/repo/issues' }), row('issue-draft', 'issue-draft:b')] as never,
  });
  assert.equal(answer.counts.total, 0);
  assert.deepEqual(answer.issues, { count: 2, href: '#/repo/issues' });
});

test('TP-3: GET /api/turn answers the same items as the inbox\'s person-facing rows', async () => {
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const { handleApi } = await import('../server/api/routes.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-projection-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'beta.md'), '---\nslug: beta\nstatus: active\nphases: 1\n---\n\n# beta\n\n## Phase graph\n\n| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n|------:|-------|-----------|--------------------|-------|---------------|\n| 1 | one | — | — | app | it works |\n', 'utf8');
    const svc = new Service({ port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);
    const raised = svc.raiseTurn({ slug: 'beta', phase: 1, birth: 'plan', step: { kind: 'physical', title: 'Plug the board in', proof: 'cmd:"true"' } });
    assert.ok(raised && !('refused' in raised));
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/api/turn', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0;
    let body = '';
    const res = {
      writeHead: (code: number) => { status = code; return res; }, setHeader: () => {}, headersSent: false,
      end: (chunk?: string | Buffer) => { body += chunk ? String(chunk) : ''; },
    };
    await handleApi({ service: svc } as never, req as never, res as never, new URL('http://127.0.0.1/api/turn'));
    assert.equal(status, 200);
    const answer = JSON.parse(body) as {
      groups: Record<string, { item: string; source: string; type: string; personStatus: string; readiness: string; route: string }[]>;
      counts: { total: number };
    };
    const items = Object.values(answer.groups).flat();
    assert.ok(items.some((item) => item.item === raised.id && item.source === 'plan'), 'the plan bullet\'s item is there');
    // …carrying the card's four words over the wire (turn-by-turn phase 1).
    const bullet = items.find((item) => item.item === raised.id)!;
    assert.deepEqual([bullet.type, bullet.personStatus, bullet.readiness, bullet.route], ['do', 'todo', 'now', 'phase']);
    const inbox = await svc.attention(true);
    const personFacing = new Set(inbox.items.filter((row) => row.turn && row.severity !== 'fyi').map((row) => row.turn!.item));
    assert.deepEqual(new Set(items.filter((item) => answer.groups.done!.every((d) => d.item !== item.item)).map((item) => item.item)), personFacing);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TP-5: GET /api/turn/:id answers a projected id with its card; items carry verdict and verdicts', async () => {
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const { handleApi } = await import('../server/api/routes.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-explain-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'gamma.md'), [
      '---', 'slug: gamma', 'status: active', 'phases: 2', '---', '', '# gamma', '', '## Phase graph', '',
      '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
      '|------:|-------|-----------|--------------------|-------|---------------|',
      '| 1 | one | — | — | app | it works |', '| 2 | two | — | — | app | it works |', '',
      '## Phases', '', '### Phase 1 — one', '- **Verification:** `true`', '',
      '### Phase 2 — two *(GATED)*', '- **Gates (must clear first):** 1. Look at the screenshots. 2. Approve.',
      '- **Gate-check:** manual the owner looks', '- **Verification:** `true`', '',
    ].join('\n'), 'utf8');
    const svc = new Service({ port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);
    const raised = svc.raiseTurn({ slug: 'gamma', phase: 1, birth: 'plan', step: { kind: 'physical', title: 'Plug the board in', proof: 'cmd:"true"' } });
    assert.ok(raised && !('refused' in raised));
    // The inbox the service reads, with a manual gate beside the ledger's
    // rows: a projected item whose record is the gate, not the ledger.
    const attention = svc.attention.bind(svc);
    svc.attention = (async (all?: boolean) => {
      const real = await attention(all);
      const gate = buildInbox({
        plans: [{ slug: 'gamma', closed: false, phases: [{ phase: 2, state: 'ready', gated: true, gateKind: 'human', gateCheck: 'the owner looks', gate: { clear: false, kind: 'human', detail: 'nobody has looked' } }] }],
      } as never, NOW, { all: true }).items.filter((row) => row.kind === 'gate');
      return { ...real, items: [...real.items, ...gate] };
    }) as typeof svc.attention;
    // A check that sent it back: the item carries the verdict, and every one.
    const ledger = svc.humanStepsNow();
    ledger.move(raised.id, 'checking', { by: 'person', verb: 'check' });
    const verdict = { state: 'rejected', note: 'the board is not seen', redo: ['plug it in again'], read: [], at: AT, by: 'probe', attempt: 0 };
    ledger.move(raised.id, 'returned', { by: 'probe', verb: 'return', verdict: verdict as never });
    const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const req = Object.assign(Readable.from([]), { method: 'GET', url: path, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } });
      let status = 0;
      let body = '';
      const res = {
        writeHead: (code: number) => { status = code; return res; }, setHeader: () => {}, headersSent: false,
        end: (chunk?: string | Buffer) => { body += chunk ? String(chunk) : ''; },
      };
      await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
      return { status, body: JSON.parse(body) as Record<string, unknown> };
    };
    const turn = await get('/api/turn');
    type Item = { item: string; record: string; source: string; title: string; check: string; steps: unknown[]; verdict: { state: string } | null; verdicts: unknown[]; timing: { assignedAt: string } };
    const items = Object.values(turn.body.groups as Record<string, Item[]>).flat();
    const mine = items.find((item) => item.item === raised.id)!;
    assert.equal(mine.verdict?.state, 'rejected');
    assert.equal(mine.verdicts.length, 1);
    const gate = items.find((item) => item.source === 'gate');
    assert.ok(gate, 'a manual gate is a projected item');
    assert.equal(gate!.record, 'projected');
    assert.equal(gate!.verdict, null, 'no check has answered a projected item');
    assert.deepEqual(gate!.verdicts, []);
    // The projected id is explained with its card, as the turn draws it.
    const explained = await get(`/api/turn/${encodeURIComponent(gate!.item)}`);
    assert.equal(explained.status, 200);
    const item = (explained.body as { item: Record<string, unknown> }).item;
    assert.equal(item.id, gate!.item);
    assert.equal(item.record, 'projected');
    assert.equal((item.card as Item).title, gate!.title);
    assert.ok((item.card as Item).steps.length >= 1);
    assert.match(String(item.check), /\.$/);
    assert.equal((item.timing as Item['timing']).assignedAt, gate!.timing.assignedAt, 'the same clock on both reads');
    // A ledger id keeps its record's explanation, and gains its card.
    const own = await get(`/api/turn/${raised.id}`);
    assert.equal(own.status, 200);
    assert.equal(((own.body as { item: { card: Item } }).item.card).item, raised.id);
    assert.equal((await get('/api/turn/nothing-here')).status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TP-6: a pressed approval, gate and plan approval show in Done as Passed or Closed, with who pressed and when', () => {
  const line = (event: string, data: Record<string, unknown>, phase = 2) => ({ slug: 'alpha', runId: 'r1', entry: { seq: 7, event, phase, data } });
  const approved = settledOfJournal(line('phase.approval-decided', {
    approvalId: 'ap-1', kind: 'tool', decision: 'approved', decidedBy: 'operator', door: 'local', title: 'Run npm publish',
  }), AT)!;
  assert.deepEqual(
    { item: approved.item, outcome: approved.outcome, by: approved.by, what: approved.what, source: approved.source },
    { item: inboxItemId({ kind: 'approval', slug: 'alpha', phase: 2, runId: 'r1', subject: 'ap-1' }), outcome: 'passed', by: 'operator', what: 'Approved', source: 'approval' },
    'the card\'s own row id: the open item and its settled record are ONE item',
  );
  const rejected = settledOfJournal(line('phase.plan-rejected', { by: 'operator', reason: 'split it in two' }, 4), AT)!;
  assert.deepEqual([rejected.source, rejected.outcome, rejected.by], ['plan-approval', 'closed', 'operator']);
  assert.match(rejected.what, /^Rejected the plan — split it in two$/);
  const plan = settledOfJournal(line('phase.plan-approved', { by: 'operator', sha: 'abc' }, 4), AT)!;
  assert.equal(plan.outcome, 'passed');
  // A machine's decision is handled, never a person's press: a timeout, the plan's own policy, a rule.
  assert.equal(settledOfJournal(line('phase.approval-decided', { approvalId: 'ap-2', decision: 'denied', decidedBy: 'timeout' }), AT), null);
  assert.equal(settledOfJournal(line('phase.plan-approved', { by: 'policy' }, 4), AT), null);
  assert.equal(settledOfJournal(line('phase.question-answered', { approvalId: 'q', key: 'k', by: 'rule', answer: 'Yes' }), AT), null);
  const asked = settledOfJournal(line('phase.question-answered', { approvalId: 'q', key: 'k', by: 'human', who: 'operator', question: 'Ship it?', answer: 'Yes' }), AT)!;
  assert.deepEqual([asked.outcome, asked.what], ['passed', 'Answered “Yes”']);

  const gate = {
    item: inboxItemId({ kind: 'gate', slug: 'alpha', phase: 6 }), at: AT, source: 'gate' as const, outcome: 'passed' as const,
    by: 'operator', title: 'Open the gate on Phase 6 of alpha', what: 'Approved the gate', slug: 'alpha', phase: 6,
  };
  const answer = turnView({ items: [], generatedAt: new Date(NOW).toISOString() }, { now: NOW, settled: [approved, rejected, gate, {
    ...gate, item: 'gate:old', at: '2026-10-05T09:00:00.000Z',
  }] });
  const done = new Map(answer.groups.done.map((item) => [item.item, item]));
  assert.deepEqual([...done.keys()].sort(), [approved.item, rejected.item, gate.item].sort(), 'the last day only');
  for (const item of done.values()) {
    assert.deepEqual(item.actions, [], `${item.item}: nothing to press`);
    assert.equal(item.settled?.at, AT, 'when');
    assert.equal(item.settled?.by, 'operator', 'who pressed');
  }
  assert.equal(done.get(approved.item)!.personStatus, 'passed');
  assert.equal(done.get(gate.item)!.personStatus, 'passed');
  assert.equal(done.get(rejected.item)!.personStatus, 'closed');
  assert.match(done.get(rejected.item)!.how, /^Closed — rejected the plan — split it in two by operator\.$/);
  assert.equal(answer.counts.total, 0, 'Done is never counted as open');
});

test('TP-6: an option bound to the ack moves its item to Done — until the row asks again', () => {
  const row = {
    id: 'conflict:alpha:::zone', kind: 'conflict', severity: 'needs-you', title: 'Two branches touch the same files', need: 'n', how: 'h',
    since: AT, actions: [], href: '#/', slug: 'alpha', ack: { at: '2026-10-07T11:30:00.000Z', by: 'operator' },
    turn: turnOf({ kind: 'conflict' }, 'conflict:alpha:::zone', () => undefined),
  };
  const record = {
    item: 'conflict:alpha:::zone', at: '2026-10-07T11:30:00.000Z', source: 'conflict' as const, outcome: 'closed' as const,
    by: 'operator', title: row.title, what: 'Leave them, and resolve the conflict when the branches meet', slug: 'alpha',
  };
  const read = (rows: unknown[]) => turnView({ items: rows as never, generatedAt: new Date(NOW).toISOString() }, { now: NOW, settled: [record] });
  const pressed = read([row]);
  assert.deepEqual(pressed.groups.decide.map((item) => item.item), [], 'no longer asked');
  assert.deepEqual(pressed.groups.done.map((item) => [item.item, item.personStatus]), [['conflict:alpha:::zone', 'closed']]);
  // The conflict came back (a newer clock, the ack stale): it asks again, and the old press is not shown beside it.
  const again = read([{ ...row, since: '2026-10-07T11:45:00.000Z', ack: null }]);
  assert.equal(again.groups.done.length, 0);
  assert.equal(TURN_GROUPS.flatMap((group) => again.groups[group]).filter((item) => item.item === 'conflict:alpha:::zone').length, 1);
});

test('TP-6: the settled store keeps one record per item, bounded by age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-settled-'));
  try {
    const store = new SettledStore(join(dir, 'turn-settled.json'));
    const base = { item: 'i1', source: 'gate' as const, outcome: 'passed' as const, by: 'a', title: 't', what: 'w' };
    store.record({ ...base, at: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(), item: 'stale' }, NOW - 3 * 24 * 60 * 60_000);
    store.record({ ...base, at: new Date(NOW - 60_000).toISOString() }, NOW);
    store.record({ ...base, at: new Date(NOW).toISOString(), by: 'b' }, NOW);
    const again = new SettledStore(join(dir, 'turn-settled.json'));
    assert.deepEqual(again.recent(24 * 60 * 60_000, NOW).map((one) => [one.item, one.by]), [['i1', 'b']], 'a second press replaces the first; the stale one is gone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-7: every item carries route and checkedBy in both editions, and the Free answer never says the supervisor', () => {
  const inbox = buildInbox(facts() as never, NOW);
  for (const edition of ['free', 'pro'] as const) {
    const answer = turnView(inbox, { steps: facts().humanSteps as never, now: NOW, edition });
    const items = TURN_GROUPS.flatMap((group) => answer.groups[group]);
    assert.ok(items.length >= 3, `${edition}: items to read`);
    for (const item of items) {
      assert.ok(item.route, `${edition} ${item.item}: route`);
      assert.equal(item.checkedBy, CHECKED_BY_LABEL[item.proofType], `${edition} ${item.item}: checkedBy is the label of its proof type`);
    }
    if (edition === 'free') {
      for (const item of items) {
        assert.notEqual(item.route, 'supervisor', `${item.item}: Free has no supervisor`);
        assert.doesNotMatch(`${ROUTE_META[item.route].label} ${ROUTE_META[item.route].resumes} ${item.checkedBy}`, /supervisor/i);
      }
    }
  }
});


test('TP-v2 (turn-by-turn phase 9): the six groups by type and readiness, counts with Approve, and the strip — to do, checking, passed today, the next deadline', () => {
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
  const base = { ...STEP, waiters: [], verdicts: [] };
  const steps = [
    { ...base, id: 'st-do', kind: 'browser-login', state: 'notified', deadline: at(180) },
    { ...base, id: 'st-permit', kind: 'permission', why: 'permission', proofType: 'grant', state: 'notified', deadline: at(-20),
      permission: { wall: 'ask', tool: 'Bash', rule: 'Bash(npm test:*)', command: 'npm test', family: 'any', risk: 'low', scopes: ['call'] } },
    { ...base, id: 'st-decide', kind: 'decision', why: 'decision', proofType: 'answer', state: 'notified',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { ...base, id: 'st-check', kind: 'physical', why: 'physical', state: 'checking', deadline: at(5) },
    { ...base, id: 'st-up', kind: 'operator-act', state: 'upcoming', dueWhen: 'date:2026-12-01T00:00:00Z', deadline: at(-600) },
    { ...base, id: 'st-passed', state: 'proven', at: at(-60) },
    { ...base, id: 'st-closed', state: 'dismissed', at: at(-30) },
  ];
  const inbox = buildInbox({ ...facts(), humanSteps: steps } as never, NOW, { all: true });
  const answer = turnView(inbox, { steps: steps as never, now: NOW });
  const ids = (group: string) => (answer.groups as Record<string, { item: string }[]>)[group]!.map((item) => item.item).sort();
  assert.deepEqual(Object.keys(answer.groups), ['approve', 'now', 'decide', 'checking', 'upcoming', 'done']);
  assert.ok(ids('approve').includes('st-permit'), 'a permission is an approval');
  assert.ok(ids('now').includes('st-do'), 'a sign-in is a task to do now');
  assert.ok(ids('decide').includes('st-decide'), 'a decision is to decide');
  assert.ok(ids('checking').includes('st-check'));
  assert.ok(ids('upcoming').includes('st-up'), 'NOT YET is coming up');
  assert.deepEqual(ids('done').filter((id) => id.startsWith('st-')), ['st-closed', 'st-passed']);
  for (const group of TURN_GROUPS) {
    for (const item of answer.groups[group]) assert.equal(item.group, group, `${item.item} says the group it is drawn in`);
  }
  assert.equal(answer.counts.total, answer.counts.approve + answer.counts.now + answer.counts.decide + answer.counts.checking + answer.counts.upcoming);
  assert.equal(answer.strip.todo, answer.counts.approve + answer.counts.now + answer.counts.decide);
  assert.equal(answer.strip.checking, answer.counts.checking);
  assert.equal(answer.strip.passedToday, 1, 'a closed one did not pass');
  // The nearest deadline of any item not done — an overdue one is the nearest of all.
  assert.equal(answer.strip.nextDeadline?.item, 'st-up');
  assert.equal(answer.strip.nextDeadline?.at, at(-600));
  assert.ok(answer.headline.startsWith(`${answer.strip.todo} need you now`), 'the headline counts Approve too');
});

test('TP-8: an inbox row carries its card’s type, readiness and when — and the group its card sits in', () => {
  const inbox = buildInbox(facts() as never, NOW, { all: true });
  const answer = turnView(inbox, { steps: facts().humanSteps as never, now: NOW });
  const cards = new Map(TURN_GROUPS.flatMap((group) => answer.groups[group].map((card) => [card.item, card] as const)));
  const rows = inbox.items.filter((row) => row.turn);
  assert.ok(rows.length >= 3, 'the step, the upcoming act and the gate');
  for (const row of rows) {
    const turn = row.turn!;
    assert.ok(turn.type, `${row.id} has a type`);
    assert.ok(turn.readiness, `${row.id} has a readiness`);
    const card = cards.get(turn.item);
    if (!card) continue;
    assert.equal(turn.type, card.type, `${row.id}: the row's type is its card's`);
    assert.equal(turn.readiness, card.readiness, `${row.id}: the row's readiness is its card's`);
    assert.equal(turn.group, card.group, `${row.id}: the row sits where its card sits`);
  }
  const step = rows.find((row) => row.turn!.item === 'step-a1')!;
  assert.deepEqual([step.turn!.type, step.turn!.readiness, step.title], ['do', 'now', 'Sign the gh CLI in to acme']);
  const later = rows.find((row) => row.turn!.item === 'step-up')!;
  assert.equal(later.turn!.readiness, 'not-yet');
  assert.equal(later.turn!.group, 'upcoming');
  assert.match(String(later.turn!.startWhen), /^when /, 'NOT YET says when, in words');
  const gate = rows.find((row) => row.kind === 'gate')!;
  assert.deepEqual([gate.turn!.type, gate.turn!.group], ['approve', 'approve'], 'a gate is an Approval, in Approve');
});
