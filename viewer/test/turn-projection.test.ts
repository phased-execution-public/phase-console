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
const { TURN_GROUPS } = await import('../shared/turn-model.js');

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
  assert.deepEqual(Object.keys(answer).sort(), ['counts', 'groups', 'handled', 'headline', 'issues', 'round', 'seen']);
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
  assert.equal(gate!.group, 'decide');
  const gateRow = inbox.items.find((row) => row.kind === 'gate')!;
  assert.equal(gate!.item, gateRow.id);
  assert.deepEqual(gate!.actions, gateRow.actions);
  // An act not due yet is coming up — its row is fyi, the item is not lost.
  assert.deepEqual(answer.groups.upcoming.map((item) => item.item), ['step-up']);
  assert.equal(answer.counts.now, 1);
  assert.equal(answer.counts.decide, 1);
  assert.equal(answer.counts.upcoming, 1);
  assert.equal(answer.counts.total, 3);
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
    const answer = JSON.parse(body) as { groups: Record<string, { item: string; source: string }[]>; counts: { total: number } };
    const items = Object.values(answer.groups).flat();
    assert.ok(items.some((item) => item.item === raised.id && item.source === 'plan'), 'the plan bullet\'s item is there');
    const inbox = await svc.attention(true);
    const personFacing = new Set(inbox.items.filter((row) => row.turn && row.severity !== 'fyi').map((row) => row.turn!.item));
    assert.deepEqual(new Set(items.filter((item) => answer.groups.done!.every((d) => d.item !== item.item)).map((item) => item.item)), personFacing);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
