/**
 * The unified inbox builder — the properties that make it usable, held against
 * a hand-built fact set with no service, no filesystem and no clock.
 *
 * `server/inbox.ts` is pure precisely so this file can exist: every question a
 * reviewer would otherwise have to answer by starting a console and stopping a
 * run ("does a signed-out account raise one row or two?", "does turning off
 * --allow-run hide the card or grey the button?") is answered here by
 * constructing the facts and reading the list.
 *
 * Five properties, each with its own failure story:
 *
 *   1. EXACTLY ONCE PER ASK. Eight sources feed the inbox and three of them
 *      overlap — `analysis/stats.ts` turns a failing QA row into a
 *      `HealthIssue{kind:'qa-fail'}` and an expired lock into a `stale-lock`,
 *      the same facts the `qa` and `lock` kinds raise from their own sources,
 *      and the synthesized `builtIn` account is the machine login the `auth`
 *      probe already speaks for. Each of those is one ask, and one ask that
 *      arrives as two rows has two ids, two acks, and one of them survives
 *      every dismissal.
 *
 *   2. THE ACK IS KEYED ON WHAT, NOT WHEN. An ack stamped before the item's
 *      own `since` is not an ack — the thing came back. Both halves are pinned:
 *      a stale ack must not hide, and a live one must.
 *
 *   3. A FLAG NEVER HIDES. A console without `--allow-run` still has to be told
 *      its run is parked on a permission card. The id set must be identical
 *      with every capability off and with every capability on; only
 *      `InboxAction.flag` may differ.
 *
 *   4. EVERY HREF RESOLVES. `#/plan/<slug>/autopilot` was hand-written at two
 *      call sites against a tab registered as `run`, and an unknown tab is not
 *      an error the router reports — it falls back silently, so every approval
 *      notification for the life of that feature opened the wrong tab. This
 *      file copies `test/route-contract.test.ts`'s assertion and applies it to
 *      every href the builder can emit.
 *
 *   5. THE ORDER IS A FUNCTION OF THE ITEMS. `sortInbox` owns it, this builder
 *      does not re-derive it, and the list it returns is already in it.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before `server/config.ts` resolves
// them — the console's real state directory holds the operator's acks, their
// approvals and their push subscriptions.
import './state-sandbox.ts';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acksFile,
  buildInbox,
  clearAcks,
  inboxIds,
  pruneAcks,
  readAcks,
  removeAck,
  removeAckMany,
  writeAck,
  writeAckMany,
  type InboxFacts,
  type InboxItem,
} from '../server/inbox.ts';
import { planWrite } from '../server/writes.ts';
import { INBOX_KINDS, INBOX_SEVERITIES, inboxItemId, sortInbox } from '../shared/attention-model.js';
import { parseHash, toHash } from '../shared/routes.js';
import { PLAN_TABS, isRouteHead } from '../shared/route-meta.js';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

/* ------------------------------------------------------------------ *
 * The fact set — one of everything Phase 4 can raise, plus one of
 * everything it must NOT raise sitting right beside it.
 * ------------------------------------------------------------------ */

function facts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    runs: [
      {
        id: 'run-1',
        slug: 'demo',
        status: 'parked',
        updatedAt: '2026-08-22T10:00:00.000Z',
        halt: { at: '2026-08-22T09:00:00.000Z', reason: 'verification red', phase: 4, kind: 'verify-failed' },
        recoveries: {
          '4': {
            errand: {
              phase: 4,
              situation: 'verify-red',
              tried: ['re-ran the suite', 'read the transcript'],
              need: 'A look at why the suite is red.',
              how: 'Run it yourself, fix it, then press Recover & continue.',
              at: '2026-08-22T09:30:00.000Z',
            },
          },
          // A plan-wide repair slot. `errandsOf` filters on /^\d+$/, and
          // without that filter this leaks in as `phase: NaN`.
          plan: {
            errand: {
              phase: 0,
              situation: 'plan-broken',
              tried: [],
              need: 'never surfaced',
              how: 'never surfaced',
              at: '2026-08-22T09:31:00.000Z',
            },
          },
        },
      },
      // Stopped, no errand, not the operator's doing, nothing automatic will
      // touch it: the read-only-console case.
      {
        id: 'run-2',
        slug: 'other',
        status: 'halted',
        updatedAt: '2026-08-22T08:00:00.000Z',
        stoppedBy: 'system',
        halt: { at: '2026-08-22T07:45:00.000Z', reason: 'the session exited', kind: 'session-failed' },
      },
      { id: 'run-3', slug: 'ignored', status: 'finished' },
      { id: 'run-4', slug: 'dismissed', status: 'halted', resolved: { at: '2026-08-22T06:00:00.000Z' } },
      { id: 'run-5', slug: 'mine', status: 'paused', stoppedBy: 'operator' },
    ],
    approvals: [
      {
        id: 'a1',
        runId: 'run-1',
        slug: 'demo',
        phase: 4,
        kind: 'tool',
        title: 'Run `rm -rf build`?',
        detail: 'Outside the profile’s allow list.',
        createdAt: '2026-08-22T11:00:00.000Z',
        status: 'pending',
      },
      { id: 'a2', slug: 'demo', status: 'allow', createdAt: '2026-08-22T10:00:00.000Z' },
    ],
    plans: [
      {
        slug: 'demo',
        title: 'Demo plan',
        closed: false,
        updatedAt: '2026-08-22T07:00:00.000Z',
        qaMode: { mode: 'on' },
        qa: [
          { phase: 2, result: 'fail', report: 'two assertions red' },
          { phase: 3, result: 'pending' },
          // Pending on a phase nobody has finished: the table's resting state.
          { phase: 5, result: 'pending' },
        ],
        issues: [
          // Owned by the `qa` kind — must not become a second row.
          { slug: 'demo', severity: 'error', kind: 'qa-fail', message: 'phase 2 failed QA', phase: 2 },
          { slug: 'demo', severity: 'error', kind: 'undefined-dep', message: 'phase 7 depends on 99', phase: 7 },
          { slug: 'demo', severity: 'warning', kind: 'stale-handoff', message: 'not an error' },
        ],
        phases: [
          { phase: 2, title: 'Two', state: 'done' },
          { phase: 3, title: 'Three', state: 'done' },
          { phase: 5, title: 'Five', state: 'ready' },
          {
            phase: 6,
            title: 'Six',
            state: 'ready',
            gated: true,
            gateCheck: 'a human look at the screenshots',
            gateKind: 'human',
            gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' },
          },
          // Gated and already done: the gate is behind it.
          { phase: 8, title: 'Eight', state: 'done', gated: true, gate: { clear: false, kind: 'human', detail: 'x' } },
          { phase: 7, title: 'Seven', state: 'ready' },
        ],
      },
      // A closed plan keeps a live process's voice but reports no progress:
      // no gate, no QA.
      {
        slug: 'shelved',
        closed: true,
        updatedAt: '2026-08-20T07:00:00.000Z',
        qaMode: { mode: 'on' },
        qa: [{ phase: 1, result: 'fail' }],
        phases: [
          { phase: 1, state: 'done' },
          { phase: 2, state: 'ready', gated: true, gate: { clear: false, kind: 'human', detail: 'x' } },
        ],
      },
    ],
    locks: [
      { slug: 'demo', phase: 9, owner: 'alice', expired: true, leaseUntil: Date.parse('2026-08-22T06:00:00.000Z') },
      { slug: 'demo', phase: 10, owner: 'bob', expired: false, session: 's-ended' },
      { slug: 'demo', phase: 11, owner: 'carol', expired: false, session: 's-live' },
      { slug: 'demo', phase: 12, owner: 'dan', expired: false, session: 's-unknown' },
    ],
    lockPresence: { 'demo:10': 'ended', 'demo:11': 'live', 'demo:12': 'unknown' },
    queue: {
      live: 0,
      queued: 1,
      entries: [
        {
          slug: 'demo',
          phase: 13,
          since: NOW - 60_000,
          waitingOn: [{ kind: 'lock', slug: 'demo', phase: 9, owner: 'alice' }],
        },
      ],
    },
    accounts: [
      // The synthesized machine login — `auth` below already speaks for it.
      { id: 'default', builtIn: true, authState: 'signed-out' },
      { id: 'work', name: 'Work', authState: 'expired' },
      // Permanent and correct for a setup-token account.
      { id: 'tok', kind: 'token', authState: 'unknown' },
      { id: 'fine', name: 'Fine', authState: 'ok' },
    ],
    auth: { loggedIn: false, checkedAt: '2026-08-22T11:59:00.000Z' },
    mcp: [
      { id: 'ctx7', label: 'Context7', enabled: true, status: 'needs-auth' },
      { id: 'files', label: 'Files', enabled: true, status: 'failed', needsConfig: ['MCP_FS_ROOT'] },
      // Connected: a tool change alone is not a wall.
      { id: 'ok', label: 'Fine', enabled: true, status: 'connected', toolsChanged: { seenAt: '2026-08-22T04:00:00.000Z' } },
      { id: 'off', label: 'Disabled', enabled: false, status: 'needs-auth' },
      // The probe could not run. "I could not check" is not "they are down".
      { id: 'unk', label: 'Unknown', enabled: true, status: 'unknown' },
      { id: 'soon', label: 'Pending', enabled: true, status: 'pending' },
    ],
    environment: [
      { kind: 'path-missing-dir', detail: 'PATH names /opt/gone, which does not exist', fix: 'Re-run agent.sh install.' },
    ],
    watcher: { healthy: false, watching: 1, expected: 3, failures: 2 },
    degraded: { healthy: false, recent: [{ kind: 'push', message: 'delivery failed twice', at: '2026-08-22T05:00:00.000Z' }] },
    flags: {
      allowWrites: true,
      allowRun: true,
      allowTerminal: true,
      allowAgent: true,
      allowAccounts: true,
      allowMcp: true,
    },
    sessions: [
      // The one that asks: live, foreign, stopped at a permission prompt.
      {
        sessionId: 'sess-live', kind: 'foreign', presence: 'live', cwd: '/work/hub',
        waiting: { since: '2026-08-22T11:05:00.000Z', kind: 'permission', note: 'Claude needs your permission to use Bash' },
      },
      // Everything below is skipped: not waiting, not live, or already asked by
      // a pending approval card for the lane's own phase (a1, demo phase 4).
      { sessionId: 'sess-quiet', kind: 'foreign', presence: 'live', cwd: '/work/hub' },
      {
        sessionId: 'sess-ended', kind: 'foreign', presence: 'ended', cwd: '/work/hub',
        waiting: { since: '2026-08-22T10:00:00.000Z', kind: 'input' },
      },
      {
        sessionId: 'sess-lane', kind: 'autopilot', presence: 'live', cwd: '/work/hub',
        waiting: { since: '2026-08-22T10:00:00.000Z', kind: 'permission' },
        plan: { slug: 'demo', phase: 4, strong: true },
      },
    ],
    acks: {},
    ...over,
  };
}

const byKind = (items: readonly InboxItem[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
};

const find = (items: readonly InboxItem[], id: string): InboxItem | undefined => items.find((i) => i.id === id);

/** The one errand the fixture's ladder wrote — the id every ack test keys on. */
const ERRAND_ID = inboxItemId({ kind: 'errand', slug: 'demo', phase: 4, runId: 'run-1', subject: 'verify-red' });

/* ------------------------------------------------------------------ *
 * The shape of the answer
 * ------------------------------------------------------------------ */

test('no facts at all is an empty view, not an exception', () => {
  // The inbox is a diagnostic surface: a console with nothing open, or one
  // whose gatherers all failed, must still answer. A 500 here is the one
  // outcome that leaves an operator with no way to find out what is wrong.
  const view = buildInbox({}, NOW);
  assert.deepEqual(view.items, []);
  assert.equal(view.generatedAt, '2026-08-22T12:00:00.000Z');

  const bare = buildInbox(undefined, NOW);
  assert.deepEqual(bare.items, [], 'buildInbox() with no facts at all must not throw');
});

test('every kind Phase 4 produces is produced, and exactly as often as there are asks', () => {
  const { items } = buildInbox(facts(), NOW);

  assert.deepEqual(byKind(items), {
    // the ladder's errand, plus the stop nothing automatic will touch
    errand: 2,
    approval: 1,
    gate: 1,
    'sign-in': 2,
    'mcp-auth': 2,
    qa: 2,
    lock: 2,
    'session-ask': 1,
    // environment + watcher + degraded + the plan's own error issue
    health: 4,
  });

  // Every word this builder emits must be in the shared vocabulary, which
  // `test/attention-model.test.ts` in turn holds equal to the client's unions.
  for (const item of items) {
    assert.ok(INBOX_KINDS.includes(item.kind), `${item.id}: '${item.kind}' is not an INBOX_KIND`);
    assert.ok(INBOX_SEVERITIES.includes(item.severity), `${item.id}: '${item.severity}' is not a severity`);
    assert.equal(typeof item.title, 'string');
    assert.ok(item.need, `${item.id}: every item must say what is needed`);
    assert.ok(item.how, `${item.id}: every item must say how to give it`);
    assert.ok(Array.isArray(item.actions), `${item.id}: actions is a list, empty is allowed`);
  }
});

test('stall and ruling are raised from their own facts and from nothing else', () => {
  // Every other kind is derived from facts this fixture already carries, so a
  // stall row that appeared here would be one derived from a run merely being
  // stopped — which is a halt, and has its own card.
  const { items } = buildInbox(facts(), NOW);
  assert.equal(items.filter((i) => i.kind === 'stall').length, 0);
  assert.equal(items.filter((i) => i.kind === 'ruling').length, 0);
});

/* ------------------------------------------------------------------ *
 * stall — nominally in flight, and not moving
 * ------------------------------------------------------------------ */

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A live run whose phases are each stuck in one of the five ways. */
function stallFacts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    runs: [{
      id: 'run-s',
      slug: 'demo',
      status: 'running',
      phases: {
        // Silent past the half-hour floor, with a call still open.
        1: {
          phase: 1, status: 'running',
          liveness: { lastOutputAt: ago(40 * MIN), turnsSinceLastTool: 3, openTool: { name: 'Bash', since: ago(41 * MIN) } },
          stall: { signal: 'silent', since: ago(40 * MIN), detail: 'no output for 40 min' },
        },
        // Silent for ten minutes: the runner has noticed and announced, but
        // the inbox floor is thirty and a person owes nothing yet.
        2: {
          phase: 2, status: 'running',
          liveness: { lastOutputAt: ago(10 * MIN), turnsSinceLastTool: 0 },
          stall: { signal: 'silent', since: ago(10 * MIN), detail: 'no output for 10 min' },
        },
        3: { phase: 3, status: 'queued', lockWaitSince: ago(70 * MIN) },
        4: { phase: 4, status: 'waiting', parkedUntil: ago(20 * MIN), parkReason: 'the image build' },
        // Parked and not yet due: waiting is not stalling.
        5: { phase: 5, status: 'waiting', parkedUntil: new Date(NOW + HOUR).toISOString() },
        6: { phase: 6, status: 'verifying', verifyingSince: ago(25 * MIN) },
        // Verifying, but only for a moment — a build is silent and fine.
        7: { phase: 7, status: 'verifying', verifyingSince: ago(2 * MIN) },
        // Pinned in the CLI's retry watchdog for twenty minutes. Note the
        // liveness clock is FRESH: the retries kept it stamped, which is
        // exactly the shape that used to blind every watchdog at once.
        8: {
          phase: 8, status: 'running',
          liveness: { lastOutputAt: ago(20 * 1000), turnsSinceLastTool: 0 },
          stall: { signal: 'retrying', since: ago(20 * MIN), detail: '41 API retries in a row (rate_limit)' },
        },
        // Retrying for two minutes: the runner has announced, the inbox floor
        // is a quarter of an hour, and a person owes nothing yet.
        9: {
          phase: 9, status: 'running',
          liveness: { lastOutputAt: ago(20 * 1000), turnsSinceLastTool: 0 },
          stall: { signal: 'retrying', since: ago(2 * MIN), detail: '5 API retries in a row' },
        },
      },
    }],
    plans: [{ slug: 'demo', updatedAt: ago(9 * 24 * HOUR) }, { slug: 'shelved', closed: true, updatedAt: ago(30 * 24 * HOUR) }],
    stalledPlans: [
      { slug: 'demo', days: 9, ready: [4, 5] },
      // A closed plan reports no progress, so it cannot be idle either.
      { slug: 'shelved', days: 30, ready: [1] },
    ],
    flags: { allowWrites: true, allowRun: true },
    acks: {},
    ...over,
  };
}

const stallKinds = (items: readonly InboxItem[]) =>
  items.filter((i) => i.kind === 'stall').map((i) => i.id.split(':').at(-1));

test('each of the six stalls is raised from its own clock, and only past it', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  assert.deepEqual(stallKinds(items).sort(), [
    'park-overdue', 'plan-idle', 'queued-behind-lock',
    'session-retrying', 'session-silent', 'verify-hanging',
  ]);
  // One row per stuck phase, and the ones under their floor are not rows:
  // phase 2 is silent but only for ten minutes, phase 5 is parked and not due,
  // phase 7 has been verifying for two minutes, phase 9 has been retrying for
  // two.
  const stalls = items.filter((i) => i.kind === 'stall');
  assert.deepEqual(stalls.map((i) => i.phase).filter(Boolean).sort((a, b) => a! - b!), [1, 3, 4, 6, 8]);
});

test('a retrying session gets its own row, because nudging it would do nothing', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  const retrying = items.filter((i) => i.kind === 'stall' && i.id.endsWith('session-retrying'));
  assert.deepEqual(retrying.map((i) => i.phase), [8]);
  assert.match(retrying[0].need, /unable to reach the API/);
  assert.match(retrying[0].need, /41 API retries in a row/);
  // The remedy is NOT the silent row's three verbs: a session that cannot
  // reach the API has nothing to say to a nudge.
  assert.deepEqual(retrying[0].actions.map((a) => a.verb), ['freeze', 'stop']);
  assert.equal(retrying[0].since, ago(20 * MIN));

  // ...and the same phase does NOT also raise `session-silent`, even though its
  // productive clock is twenty minutes cold: one ask, one row.
  const silentPhases = items
    .filter((i) => i.kind === 'stall' && i.id.endsWith('session-silent')).map((i) => i.phase);
  assert.ok(!silentPhases.includes(8), 'a retrying lane is one ask, not two');
});

test('the inbox floor is longer than the detector, deliberately', () => {
  // The runner notices silence at ten minutes and announces once, because a
  // notification is cheap and dismissable. The inbox is a list of things a
  // person still owes an answer to, and half an hour is where "it is thinking"
  // stops being the likely explanation. Phase 2 is the case that proves it.
  const { items } = buildInbox(stallFacts(), NOW);
  const silent = items.filter((i) => i.kind === 'stall' && i.id.endsWith('session-silent'));
  assert.deepEqual(silent.map((i) => i.phase), [1]);
  assert.match(silent[0].need, /produced nothing for 40 min/);
  assert.match(silent[0].need, /oldest open tool call is Bash|Bash/);
  // The clock is when the silence BEGAN, so an ack goes stale exactly when the
  // silence restarts and not on the next poll.
  assert.equal(silent[0].since, ago(40 * MIN));
});

/**
 * D15 — a frozen lane owes nobody an answer.
 *
 * Every stall row is a silence detector, and a SIGSTOPped session is silent by
 * construction. So the operator who froze phase 1 to think about it got, half
 * an hour later, a `needs-you` row telling them phase 1 had produced nothing —
 * offering them a Freeze button for a lane already frozen. The row is read on a
 * phone; it must not be a report of the reader's own last action.
 */
test('a frozen lane raises no stall row — from the slot OR from a second child', () => {
  const base = stallFacts();
  const run = base.runs![0];
  const froze = { at: ago(40 * MIN), by: 'console', escalateAt: ago(-5 * MIN) };

  // The mirror slot names the lowest frozen phase.
  const bySlot = buildInbox({ ...base, runs: [{ ...run, freeze: { phase: 1 } }] }, NOW);
  assert.deepEqual(
    bySlot.items.filter((i) => i.kind === 'stall' && i.id.endsWith('session-silent')).map((i) => i.phase),
    [], 'the one silent-past-the-floor phase is the one that was frozen',
  );

  // And the second frozen lane, which the single slot cannot name: phase 8 is
  // `retrying`, so this proves the suppression is not silent-only.
  const byChild = buildInbox({
    ...base,
    runs: [{
      ...run,
      children: { 1: { phase: 1, frozen: froze }, 8: { phase: 8, frozen: froze } },
    }],
  }, NOW);
  const stalls = byChild.items.filter((i) => i.kind === 'stall').map((i) => i.phase);
  assert.ok(!stalls.includes(1), 'phase 1 is frozen');
  assert.ok(!stalls.includes(8), 'and so is phase 8 — the child the mirror slot could not name');

  // Nothing else moved: the same fixture unfrozen still speaks up.
  assert.deepEqual(
    buildInbox(base, NOW).items
      .filter((i) => i.kind === 'stall' && i.id.endsWith('session-silent')).map((i) => i.phase),
    [1],
  );
});

test('a stalled session carries the three verbs that answer one', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  const silent = items.find((i) => i.kind === 'stall' && i.id.endsWith('session-silent'))!;
  assert.deepEqual(silent.actions.map((a) => a.verb), ['steer', 'freeze', 'stop']);
  for (const action of silent.actions) {
    assert.equal(action.method, 'POST');
    assert.match(action.endpoint, /^\/api\/run\/demo\//);
    assert.equal((action.body as { phase: number }).phase, 1, 'every one of them names the lane, not the run');
  }
  // The nudge is canned rather than a compose box: the row is read on a phone
  // at the top of an inbox, and the useful thing to say is the same sentence
  // every time.
  const steer = silent.actions[0].body as { instruction: string };
  assert.match(steer.instruction, /phase-outcome\.sh/);
});

test('a stall with no live session carries the verb that answers IT', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  const verbs = (suffix: string) =>
    items.find((i) => i.kind === 'stall' && i.id.endsWith(suffix))!.actions.map((a) => a.verb);
  // Four of the five have no session to steer: a lock nothing is releasing, a
  // park nothing resumed, a plan nobody has opened, a check that will not end.
  assert.deepEqual(verbs('queued-behind-lock'), ['release', 'stop']);
  assert.deepEqual(verbs('park-overdue'), ['recover']);
  assert.deepEqual(verbs('verify-hanging'), ['stop']);
  assert.deepEqual(verbs('plan-idle'), []);
});

test("a queue behind the run's own sibling lane is pipelining, not a stall", () => {
  const facts = stallFacts();
  const run = facts.runs![0]!;
  facts.runs = [{
    ...run,
    phases: {
      3: {
        phase: 3, status: 'queued', lockWaitSince: ago(70 * MIN),
        waitingOn: [{ slug: 'demo', phase: 2, owner: 'autopilot/run-s' }],
      },
    },
  }];
  const { items } = buildInbox(facts, NOW);
  assert.ok(!items.some((i) => i.id.includes('queued-behind-lock')),
    'an own-run holder is the design working — no row (seen live: phase 10 flagged for waiting on its own phase 9)');
});

test('a queue behind another plan names the holder, and Release aims at ITS lock', () => {
  const facts = stallFacts();
  const run = facts.runs![0]!;
  facts.runs = [{
    ...run,
    phases: {
      3: {
        phase: 3, status: 'queued', lockWaitSince: ago(70 * MIN),
        waitingOn: [{ slug: 'other-plan', phase: 12, owner: 'autopilot/feedf00d' }],
      },
    },
  }];
  const { items } = buildInbox(facts, NOW);
  const row = items.find((i) => i.kind === 'stall' && i.id.endsWith('queued-behind-lock'))!;
  assert.match(row.title, /queued behind other-plan phase 12/);
  assert.match(String(row.need), /autopilot\/feedf00d/);
  const release = row.actions.find((a) => a.verb === 'release')!;
  assert.deepEqual(release.body, { slug: 'other-plan', phase: 12 },
    "the old body released this lane's own phase — a lock nobody held");
});

test('a queued record from before the holder field keeps the old anonymous row', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  const row = items.find((i) => i.kind === 'stall' && i.id.endsWith('queued-behind-lock'))!;
  assert.match(row.title, /queued behind a lock/);
  const release = row.actions.find((a) => a.verb === 'release')!;
  assert.deepEqual(release.body, { slug: 'demo', phase: 3 });
});

test('a closed plan is never idle, because a closed plan claims nothing', () => {
  const { items } = buildInbox(stallFacts(), NOW);
  const idle = items.filter((i) => i.kind === 'stall' && i.id.endsWith('plan-idle'));
  assert.deepEqual(idle.map((i) => i.slug), ['demo']);
  assert.match(idle[0].title, /9 days idle/);
  // Read from the Insights computation, not re-derived: two definitions of
  // "idle for seven days" would drift the first time one learned about a new
  // kind of activity.
  assert.match(idle[0].need, /phases 4, 5 are startable/);
});

test('a stopped run does not raise stall rows off the liveness its lane left behind', () => {
  // `record.liveness` is persisted so a killed lane can still say what it was
  // doing. It is stale by construction, and a halted run reading "silent for
  // three hours" would be an ask nobody can answer.
  const base = stallFacts();
  const stopped = buildInbox({
    ...base,
    runs: [{ ...base.runs![0], status: 'halted' }],
    stalledPlans: [],
  }, NOW);
  assert.deepEqual(stallKinds(stopped.items).sort(), ['park-overdue'],
    'only the park survives — a phase can be parked while its run is not running');
});

/* ------------------------------------------------------------------ *
 * policy — what the console decided by itself (zero-touch phase 19)
 * ------------------------------------------------------------------ */

const ANSWER = {
  slug: 'demo', runId: 'r1', phase: 4, decisionKey: 'qa.exhausted', answer: 'waive', source: 'default',
  at: ago(1 * HOUR),
};

test('a policy answer is an fyi row naming its key, the answer, where it came from and the shipped default', () => {
  const { items } = buildInbox({ policyAnswers: [ANSWER], acks: {} }, NOW);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.kind, 'policy');
  assert.equal(row.severity, 'fyi', 'nothing is waiting — the console already acted');
  // Keyed on the decision key, not the run: one decision per phase, whichever run met it last.
  assert.equal(row.id, inboxItemId({ kind: 'policy', slug: 'demo', phase: 4, subject: 'qa.exhausted' }));
  assert.match(row.title, /demo phase 4 — Policy answered · qa\.exhausted/);
  assert.match(row.need, /"waive" by the shipped default/);
  assert.match(row.need, /nobody was asked/);
  assert.match(row.how, /Shipped default for `qa\.exhausted`: waive/);
  assert.match(row.how, /Settings ▸ Automation ▸ Policy answers/);
  assert.equal(row.since, ANSWER.at);
  assert.equal(row.href, '#/plan/demo/phase/4');
  assert.deepEqual(row.actions, [], 'seeing it IS the interaction');
});

test('answers to one key on one phase are ONE row — the newest; another key or another phase is another row', () => {
  const { items } = buildInbox({
    policyAnswers: [
      ANSWER,
      { ...ANSWER, answer: 'halt', source: 'plan', at: ago(10 * MIN) },
      { ...ANSWER, decisionKey: 'gates', answer: 'delegated', at: ago(2 * HOUR) },
      { ...ANSWER, phase: 7, at: ago(3 * HOUR) },
    ],
    acks: {},
  }, NOW);
  assert.equal(items.length, 3);
  const qa = items.find((i) => i.id === inboxItemId({ kind: 'policy', slug: 'demo', phase: 4, subject: 'qa.exhausted' }));
  assert.ok(qa);
  assert.match(qa.need, /"halt" by the plan’s `## Decisions` row/, 'the newest answer is the one shown');
  assert.ok(items.some((i) => i.id === inboxItemId({ kind: 'policy', slug: 'demo', phase: 4, subject: 'gates' })));
  assert.ok(items.some((i) => i.id === inboxItemId({ kind: 'policy', slug: 'demo', phase: 7, subject: 'qa.exhausted' })));
});

test('a policy answer older than the window, on a closed plan, or with no phase raises nothing', () => {
  const { items } = buildInbox({
    policyAnswers: [
      { ...ANSWER, at: ago(20 * 24 * HOUR) },
      { ...ANSWER, slug: 'shut' },
      { ...ANSWER, phase: 0 },
    ],
    plans: [{ slug: 'shut', closed: true }],
    acks: {},
  }, NOW);
  assert.deepEqual(items, []);
});

test('an acknowledged policy row stays down until the console answers that key again', () => {
  const id = inboxItemId({ kind: 'policy', slug: 'demo', phase: 4, subject: 'qa.exhausted' });
  const acks = { [id]: { at: ago(MIN), by: 'op' } };
  assert.deepEqual(buildInbox({ policyAnswers: [ANSWER], acks }, NOW).items, []);
  const again = buildInbox({ policyAnswers: [ANSWER, { ...ANSWER, at: ago(1000) }], acks }, NOW);
  assert.equal(again.items.length, 1, 'a newer answer moves `since` past the ack');
  assert.equal(again.items[0].id, id);
});

/* ------------------------------------------------------------------ *
 * ruling — a decision worth remembering
 * ------------------------------------------------------------------ */

const RULING = {
  id: 'abc123', slug: 'demo', phase: 4, kind: 'deviation',
  what: 'kept the old field', why: 'a reader predating it still exists',
  costIfWrong: 'one dead branch', at: ago(2 * 24 * HOUR),
};

test('a recent ruling is an fyi row keyed on the PHASE, not the ruling', () => {
  const { items } = buildInbox({ rulings: [RULING], acks: {} }, NOW);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.kind, 'ruling');
  assert.equal(row.severity, 'fyi', 'nothing is waiting — the session already acted on it');
  // Keyed on the phase with the constant subject `rulings`: the row IS the
  // phase's rulings, so an id that moved to the newest one would shed the ack
  // every time a session recorded another.
  assert.equal(row.id, inboxItemId({ kind: 'ruling', slug: 'demo', phase: 4, subject: 'rulings' }));
  assert.match(row.title, /Deviation/);
  assert.equal(row.need, 'kept the old field');
  assert.match(row.how, /a reader predating it still exists/);
  assert.match(row.how, /one dead branch/);
  assert.equal(row.since, RULING.at);
  assert.deepEqual(row.actions, [], 'seeing it IS the interaction');
});

test('a deferral says who it was left for, so the row is an address and not just a label', () => {
  // `Deferral` alone says a session left something; it does not say the thing
  // is waiting for phase 7, which is the only part an operator can act on.
  const row = (value: string | undefined) => buildInbox(
    { rulings: [{ ...RULING, kind: 'deferral', what: 'left the second decoder', for: value }], acks: {} },
    NOW,
  ).items[0];
  assert.match(row('9').title, /deferred to phase 9/i);
  assert.match(row('next').title, /deferred to the next phase/i);
  assert.match(row('all').title, /deferred to every later phase/i);
  // A deferral written before `--for` existed still reads — it just says less.
  assert.match(row(undefined).title, /Deferral/);
});

test('several rulings on one phase collapse to ONE row that counts the rest', () => {
  const three = [
    RULING,
    { ...RULING, id: 'b', kind: 'ambiguity', what: 'read it the narrow way', at: ago(1 * HOUR) },
    { ...RULING, id: 'c', kind: 'deferral', what: 'left the second half', at: ago(3 * HOUR) },
  ];
  const { items } = buildInbox({ rulings: three, acks: {} }, NOW);
  assert.equal(items.length, 1, 'one phase, one row');
  const [row] = items;
  // The NEWEST is the title and the need; the other two are counted. Forty
  // one-per-ruling rows on a single plan is what this replaces, and forty fyi
  // rows is how the needs-you band underneath them stops being read.
  assert.match(row.title, /Ambiguity and 2 more rulings/);
  assert.equal(row.need, 'read it the narrow way');
  assert.equal(row.since, three[1].at);
});

test('rulings on DIFFERENT phases stay different rows', () => {
  const { items } = buildInbox({
    rulings: [RULING, { ...RULING, id: 'z', phase: 7, what: 'phase seven decided' }],
    acks: {},
  }, NOW);
  assert.deepEqual(items.map((i) => i.phase).sort(), [4, 7]);
});

test('a ruling older than the window is history, not an ask', () => {
  const old = { ...RULING, id: 'old1', at: ago(20 * 24 * HOUR) };
  const { items } = buildInbox({ rulings: [RULING, old], acks: {} }, NOW);
  assert.deepEqual(items.map((i) => i.need), ['kept the old field']);
});

test('one busy plan cannot own the list', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...RULING, id: `r${i}`, what: `decision ${i}`, at: new Date(NOW - i * MIN).toISOString(),
  }));
  const { items } = buildInbox({ rulings: many, acks: {} }, NOW);
  // The cap used to be twenty rows per plan. Collapsing to one row per phase
  // makes the cap redundant AND stricter: forty rulings on one phase are one
  // row, and a plan can only ever raise as many ruling rows as it has phases.
  assert.equal(items.length, 1);
  assert.equal(items[0].need, 'decision 0', 'the newest is the one shown');
  assert.match(items[0].title, /39 more rulings/);
});

test('a ruling that names its decision key is a row of its OWN, keyed on the ruling, offering remember', () => {
  // The feedback loop (chapter 10 ZTD-7): a keyed ruling is an answer somebody
  // could keep, so it gets its own row with the actions to keep it — and the
  // un-keyed rulings of the same phase still fold into their fyi row.
  const keyed = { ...RULING, id: 'abcdef012345', what: 'the window is the cap', decisionKey: 'waits', at: ago(1 * HOUR) };
  const { items } = buildInbox({ rulings: [RULING, keyed], acks: {}, flags: { allowWrites: true } }, NOW);
  assert.equal(items.length, 2);
  const row = items.find((i) => i.id === inboxItemId({ kind: 'ruling', slug: 'demo', phase: 4, subject: 'abcdef012345' }));
  assert.ok(row, 'keyed on the ruling id — the ledger ack (which remembering appends) is the row\'s ack');
  assert.equal(row.kind, 'ruling');
  assert.equal(row.severity, 'fyi');
  assert.match(row.title, /Deviation · waits/);
  assert.equal(row.need, 'the window is the cap');
  // The plan action, always; the global action only when the words are an
  // answer the console can hold for the key — `waits` takes window|refuse, and
  // "the window is the cap" is prose, so a button that would be refused on
  // arrival is not offered; the pointer to the editor is.
  assert.deepEqual(row.actions.map((a) => a.verb), ['remember-plan']);
  const [plan] = row.actions;
  assert.equal(plan.endpoint, '/api/run/demo/rulings/abcdef012345/remember');
  assert.equal(plan.method, 'POST');
  assert.deepEqual(plan.body, { scope: 'plan' });
  assert.equal(plan.flag, undefined, 'writes are on');
  assert.match(row.how, /Settings ▸ Automation ▸ Policy answers/);
  // The folded row is exactly what it was: one un-keyed ruling, no actions.
  const folded = items.find((i) => i.id === inboxItemId({ kind: 'ruling', slug: 'demo', phase: 4, subject: 'rulings' }));
  assert.ok(folded);
  assert.doesNotMatch(folded.title, /more ruling/);
  assert.deepEqual(folded.actions, []);
});

test('a keyed ruling whose words ARE an answer offers to remember it on this console too, and writes-off flags the plan action', () => {
  const keyed = { ...RULING, id: 'abcdef012345', what: 'waive', decisionKey: 'qa.exhausted', at: ago(1 * HOUR) };
  const { items } = buildInbox({ rulings: [keyed], acks: {}, flags: { allowWrites: false } }, NOW);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.deepEqual(row.actions.map((a) => a.verb), ['remember-plan', 'remember-global']);
  assert.equal(row.actions[0].flag, 'writes', 'a docs write behind --allow-writes');
  assert.deepEqual(row.actions[1].body, { scope: 'global' });
  assert.equal(row.actions[1].flag, undefined, 'a preference needs no capability');
  assert.doesNotMatch(row.how, /Settings ▸/);
});

test('a keyed ruling the ledger has acked is off the list — remembering it is what acks it', () => {
  const keyed = { ...RULING, id: 'abcdef012345', what: 'waive', decisionKey: 'qa.exhausted', at: ago(1 * HOUR) };
  const id = inboxItemId({ kind: 'ruling', slug: 'demo', phase: 4, subject: 'abcdef012345' });
  const { items } = buildInbox({ rulings: [keyed], acks: { [id]: { at: ago(MIN), by: 'op' } } }, NOW);
  assert.deepEqual(items, []);
});

test('a closed plan raises no rulings, like every other progress claim', () => {
  const { items } = buildInbox(
    { rulings: [RULING], plans: [{ slug: 'demo', closed: true }], acks: {} }, NOW,
  );
  assert.deepEqual(items, []);
});

test('the asks the fixture must NOT raise are not raised', () => {
  const { items } = buildInbox(facts(), NOW);
  const ids = items.map((i) => i.id);

  const absent = (needle: string, why: string) =>
    assert.ok(!ids.some((id) => id.includes(needle)), `${why} — found ${ids.filter((i) => i.includes(needle))}`);

  absent('plan-broken', 'a `plan` recovery slot is not a phase errand');
  absent(':run-3', 'a finished run is not waiting on anybody');
  absent(':run-4', 'a resolved run keeps its record and stops being asked about');
  absent(':run-5', "an operator's own stop is not an ask");
  absent('a2', 'a settled approval is history');
  absent('shelved', 'a closed plan reports no progress');
  absent('demo:11', 'an unexpired lock whose session is live is a queue to wait in');
  absent('demo:12', 'an unexpired lock with unknown presence is not debris');
  absent('sign-in::::tok', 'authState `unknown` is permanent and correct for a token account');
  absent('mcp-auth::::off', 'a disabled server asks nothing');
  absent('mcp-auth::::unk', 'a probe that could not run degrades nothing');
  absent('mcp-auth::::soon', 'pending is not a wall');
  absent('mcp-auth::::ok', 'a tool change on a connected server is not a sign-in');

  // Gated but already done, and pending QA on a phase nobody finished.
  assert.equal(items.filter((i) => i.kind === 'gate').length, 1, 'only the open gate asks');
  assert.deepEqual(
    items.filter((i) => i.kind === 'qa').map((i) => i.phase).sort(),
    [2, 3],
    'a pending QA row on an unfinished phase is the table at rest',
  );
});

test('a per-phase QA gate on a waived plan still raises the owed verdict', () => {
  // The measured hole: the row builder read the PLAN-wide mode alone, so a
  // plan-wide `off` with a per-phase `- **QA:** on` — the live shape — never
  // raised the one row that names a hold on nine phases.
  const plan = {
    slug: 'perphase', title: 'perphase', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'waived' },
    qaModes: { 2: 'on' },
    qa: [{ phase: 2, result: 'pending' }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
  const { items } = buildInbox({ plans: [plan], runs: [], flags: {} } as never, NOW);
  const rows = items.filter((i) => i.kind === 'qa');
  assert.equal(rows.length, 1, 'the phase\'s own regime gates, so the ask must show');
  assert.equal(rows[0].phase, 2);
  assert.match(rows[0].title, /verdict owed/);
});

test('without a per-phase regime the waived plan stays silent — the old default holds', () => {
  const plan = {
    slug: 'perphase', title: 'perphase', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'waived' },
    qa: [{ phase: 2, result: 'pending' }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
  const { items } = buildInbox({ plans: [plan], runs: [], flags: {} } as never, NOW);
  assert.equal(items.filter((i) => i.kind === 'qa').length, 0);
});

test('a phase errand on a LIVE run renders — the run keeps driving, only the errand asks', () => {
  // The ladder's park-with-errand design: exhaustion parks the PHASE with one
  // errand and the run keeps driving. The builder iterated stopped runs only,
  // so the sole pointer to a 16-hour QA hold was invisible while its run drove.
  const run = {
    id: 'r-live', slug: 'liveplan', status: 'running', resolved: false,
    updatedAt: '2026-01-01T00:00:00Z',
    phases: {}, recoveries: {
      2: { attempts: 2, lastAt: '2026-01-01T00:00:00Z', errand: {
        phase: 2, situation: 'qa-pending', tried: ['resume-own-session (qa-verdict) → interrupted'],
        need: 'A QA verdict for this phase — the plan gates on QA and none is recorded.',
        how: 'Run QA from the phase page (the QA launcher) or record pass/waived with qa-record.sh.',
        at: '2026-01-01T00:00:00Z',
      } },
    },
  };
  const { items } = buildInbox({ plans: [], runs: [run], flags: {} } as never, NOW);
  const rows = items.filter((i) => i.kind === 'errand' && i.slug === 'liveplan');
  assert.equal(rows.length, 1, 'a phase errand outlives the run being alive');
  assert.equal(rows[0].phase, 2);
  assert.ok(!(rows[0].actions ?? []).some((a) => a.verb === 'dismiss'),
    'a live run is not dismissable from an errand row');
  assert.ok(!(rows[0].actions ?? []).some((a) => a.verb === 'recover'),
    'recover refuses a live run; the how names the real door');
});

test('an errand whose QA ask is already answered raises no row', () => {
  // Measured live: phase 2's qa-pending errand kept saying "needs you" after
  // the verdict was recorded and pushed — nothing dissolves a satisfied
  // errand while its run drives. The QA table is the authority on verdicts,
  // and the inbox reads it; a standing false ask is how needs-you gets muted.
  const run = {
    id: 'r-live', slug: 'liveplan', status: 'running', resolved: false,
    updatedAt: '2026-01-01T00:00:00Z',
    phases: {}, recoveries: {
      2: { attempts: 2, lastAt: '2026-01-01T00:00:00Z', errand: {
        phase: 2, situation: 'qa-pending', tried: [],
        need: 'A QA verdict for this phase — the plan gates on QA and none is recorded.',
        how: 'Run QA from the phase page.',
        at: '2026-01-01T00:00:00Z',
      } },
    },
  };
  const plan = {
    slug: 'liveplan', title: 'liveplan', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'waived' },
    qa: [{ phase: 2, result: 'pass', report: 'reports/phase-02-qa.md' }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
  const { items } = buildInbox({ plans: [plan], runs: [run], flags: {} } as never, NOW);
  assert.equal(items.filter((i) => i.kind === 'errand' && i.slug === 'liveplan').length, 0,
    'a recorded verdict answers the qa-pending ask');
});

/* ------------------------------------------------------------------ *
 * Identity, dedupe and order
 * ------------------------------------------------------------------ */

test('ids are minted by inboxItemId and by nothing else', () => {
  const { items } = buildInbox(facts(), NOW);

  const expected = [
    ERRAND_ID,
    inboxItemId({ kind: 'errand', slug: 'other', runId: 'run-2', subject: 'unattended-stop' }),
    inboxItemId({ kind: 'approval', slug: 'demo', phase: 4, runId: 'run-1', subject: 'a1' }),
    inboxItemId({ kind: 'gate', slug: 'demo', phase: 6 }),
    inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }),
    inboxItemId({ kind: 'qa', slug: 'demo', phase: 3, subject: 'pending' }),
    inboxItemId({ kind: 'sign-in', subject: 'machine' }),
    inboxItemId({ kind: 'sign-in', subject: 'work' }),
    inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }),
    inboxItemId({ kind: 'mcp-auth', subject: 'files' }),
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 9, subject: 'expired' }),
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 10, subject: 'ended' }),
    inboxItemId({ kind: 'health', subject: 'path-missing-dir' }),
    inboxItemId({ kind: 'health', subject: 'watcher' }),
    inboxItemId({ kind: 'health', subject: 'push' }),
    inboxItemId({ kind: 'health', slug: 'demo', phase: 7, subject: 'undefined-dep' }),
    inboxItemId({ kind: 'session-ask', subject: 'sess-live' }),
  ];

  assert.deepEqual([...items.map((i) => i.id)].sort(), [...expected].sort());

  // The subject never leaves the server, so an id cannot be re-derived from a
  // fetched item — the shared model says so and this is what it means.
  assert.equal(ERRAND_ID, 'errand:demo:4:run-1:verify-red');
  assert.ok(!('subject' in (find(items, ERRAND_ID) as object)), 'subject must not ride the wire');
});

test('one fact that two sources report is one row', () => {
  const { items } = buildInbox(facts(), NOW);

  // `analysis/stats.ts` reports a failing QA row as HealthIssue{kind:'qa-fail'}
  // and the `qa` kind reports it from `PlanRecord.qa`. Two ids, two acks, and
  // dismissing either leaves the other — so the health side is suppressed by
  // construction rather than deduped by id, because the ids genuinely differ.
  assert.equal(items.filter((i) => i.id.includes('qa-fail')).length, 0);
  assert.equal(items.filter((i) => i.kind === 'qa' && i.phase === 2).length, 1);

  // The synthesized `builtIn` account IS the machine login the `auth` probe
  // already speaks for.
  assert.equal(items.filter((i) => i.kind === 'sign-in').length, 2);
  assert.ok(find(items, inboxItemId({ kind: 'sign-in', subject: 'machine' })));
  assert.equal(items.filter((i) => i.id.endsWith(':default')).length, 0);

  // And nothing anywhere may share an id with anything else.
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'two rows with one id means one ack silencing two asks');
});

test('the list arrives in sortInbox order: worst first, then oldest first', () => {
  const view = buildInbox(facts(), NOW);
  assert.deepEqual(view.items, sortInbox(view.items), 'the builder must not re-derive the order');

  const ranks = view.items.map((i) => INBOX_SEVERITIES.indexOf(i.severity));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'severity must be non-decreasing down the list');

  // The permission card is urgent and carries a real clock; the machine
  // sign-out is urgent with no clock at all, and an item with no clock sorts
  // LAST within its severity rather than pinning itself to the top forever.
  assert.equal(view.items[0].kind, 'approval');
  // The session ask is urgent too, five minutes younger than the card.
  assert.equal(view.items[1].kind, 'session-ask');
  assert.equal(view.items[2].id, inboxItemId({ kind: 'sign-in', subject: 'machine' }));
  assert.equal(
    view.items[view.items.length - 1].id,
    inboxItemId({ kind: 'lock', slug: 'demo', phase: 10, subject: 'ended' }),
  );

  const urgent = view.items.filter((i) => i.severity === 'urgent').map((i) => i.kind);
  assert.deepEqual(urgent, ['approval', 'session-ask', 'sign-in'],
    'urgent is reserved for what is stopped dead and costing — a permission prompt is exactly that');
});

/* ------------------------------------------------------------------ *
 * Acknowledgement
 * ------------------------------------------------------------------ */

test('an ack older than the item’s own since is not an ack — the thing came back', () => {
  // The errand's clock is 09:30. An ack from 09:00 was given to an EARLIER
  // instance of the same ask; treating it as current is how a wall that was
  // fixed, then broke again, stays silently acknowledged.
  const stale = buildInbox(facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T09:00:00.000Z', by: 'me' } } }), NOW);
  const item = find(stale.items, ERRAND_ID);
  assert.ok(item, 'a stale ack must not hide the item');
  assert.equal(item.ack, undefined, 'and must not be reported as an acknowledgement');

  const live = buildInbox(facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'me' } } }), NOW);
  assert.equal(find(live.items, ERRAND_ID), undefined, 'a live ack hides the item by default');
});

test('default hides acked items; all:true includes them, carrying the ack', () => {
  const acked = facts({ acks: { [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'mobin' } } });

  const hidden = buildInbox(acked, NOW);
  const shown = buildInbox(acked, NOW, { all: true });

  assert.equal(hidden.items.length, shown.items.length - 1);
  assert.equal(find(hidden.items, ERRAND_ID), undefined);
  assert.deepEqual(find(shown.items, ERRAND_ID)?.ack, { at: '2026-08-22T10:00:00.000Z', by: 'mobin' });

  // `inboxIds` is the keep-set `pruneAcks` needs, and it must be the FULL id
  // space — deriving it from the filtered list would prune the ack of every
  // item the filter just hid, un-acking everything on the next request.
  const ids = inboxIds(acked, NOW);
  assert.ok(ids.includes(ERRAND_ID));
  assert.equal(ids.length, shown.items.length);
});

test('an item with no clock keeps its ack, because absence is what un-acks it', () => {
  // A signed-out account records no WHEN, so `since` is empty and no timestamp
  // comparison can tell a returning sign-out from the acknowledged one. That
  // is `pruneAcks`' job, and it is why the ack must survive here.
  const id = inboxItemId({ kind: 'sign-in', subject: 'machine' });
  const view = buildInbox(facts({ acks: { [id]: { at: '2020-01-01T00:00:00.000Z' } } }), NOW, { all: true });
  const item = find(view.items, id);
  assert.equal(item?.since, '', 'a fact with no start clock must not invent one');
  assert.deepEqual(item?.ack, { at: '2020-01-01T00:00:00.000Z' });
});

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

test('a capability flag never hides an item — it disables the action and names the flag', () => {
  const on = buildInbox(facts(), NOW);
  const off = buildInbox(
    facts({
      flags: {
        allowWrites: false,
        allowRun: false,
        allowTerminal: false,
        allowAgent: false,
        allowAccounts: false,
        allowMcp: false,
      },
    }),
    NOW,
  );

  assert.deepEqual(off.items.map((i) => i.id), on.items.map((i) => i.id), 'a read-only console sees the same asks');

  // On a fully-capable console nothing is flagged: `flag` means "this cannot be
  // pressed", so its presence has to be information rather than decoration.
  for (const item of on.items) {
    for (const action of item.actions) {
      assert.equal(action.flag, undefined, `${item.id}/${action.verb} must not be flagged on a capable console`);
    }
  }

  const flagOf = (id: string, verb: string) => find(off.items, id)?.actions.find((a) => a.verb === verb)?.flag;
  assert.equal(flagOf(ERRAND_ID, 'recover'), 'run');
  assert.equal(flagOf(inboxItemId({ kind: 'approval', slug: 'demo', phase: 4, runId: 'run-1', subject: 'a1' }), 'allow'), 'run');
  assert.equal(flagOf(inboxItemId({ kind: 'gate', slug: 'demo', phase: 6 }), 'approve'), 'writes');
  assert.equal(flagOf(inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }), 'qa-session'), 'agent');
  // The gate the row NAMES must be the gate the route APPLIES, and that is true
  // only because the body says `kind: 'claude'`. Without it `api/routes.ts`
  // reads a missing kind as 'shell', guards on --allow-terminal instead of
  // --allow-agent, skips parseQaRequest/resolveQa/buildAgentLaunch entirely and
  // mints a bare `$SHELL -l` — while the toast says "done" and the phase goes
  // unreviewed. So the assertion above is a claim about a flag, and this one is
  // what makes the claim true.
  assert.equal(
    (find(off.items, inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }))
      ?.actions.find((a) => a.verb === 'qa-session')?.body as { kind?: string } | undefined)?.kind,
    'claude',
  );
  // There is no `qa-record` action to flag any more, and that is the fix rather
  // than a regression: the body it posted carried neither `result` nor `report`,
  // both of which `planWrite` requires, so it answered with a WriteError on every
  // console — capable or not. A verdict is a judgement (pass, fail, waived) that
  // no single press can make, so it belongs on the phase page's form, which is
  // where the item's `href` and `how` now send people. Pinned so it is not
  // re-added as a one-press button: see the write-body guard below.
  assert.equal(
    find(off.items, inboxItemId({ kind: 'qa', slug: 'demo', phase: 2, subject: 'fail' }))
      ?.actions.some((a) => a.verb === 'qa-record'),
    false,
  );
  assert.equal(flagOf(inboxItemId({ kind: 'sign-in', subject: 'work' }), 'login'), 'accounts');
  assert.equal(flagOf(inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }), 'login'), 'mcp');
  assert.equal(flagOf(inboxItemId({ kind: 'lock', slug: 'demo', phase: 9, subject: 'expired' }), 'release'), 'writes');

  // Dismissing a card is a judgement about what deserves attention, and a
  // console that cannot even do that is the dead end these cards were built to
  // end. Never flagged, on either console.
  assert.equal(flagOf(ERRAND_ID, 'dismiss'), undefined);
  assert.equal(flagOf(inboxItemId({ kind: 'mcp-auth', subject: 'ctx7' }), 'refresh'), undefined);
});

test('a server that can never connect is raised, with no sign-in button', () => {
  const { items } = buildInbox(facts(), NOW);
  const unconfigured = find(items, inboxItemId({ kind: 'mcp-auth', subject: 'files' }));
  assert.ok(unconfigured, '`needsConfig` raises: it is a wall, just not an auth one');
  assert.equal(
    unconfigured.actions.some((a) => a.verb === 'login'),
    false,
    'an unfilled ${VAR} can never connect, so a sign-in button would be a button that cannot work',
  );
  assert.ok(unconfigured.need.includes('MCP_FS_ROOT'), 'and it names what is missing');
});

test('the stop nothing automatic will touch is raised only while nothing will', () => {
  const halted = {
    id: 'run-9',
    slug: 'auto',
    status: 'halted',
    updatedAt: '2026-08-22T08:00:00.000Z',
    stoppedBy: 'system' as const,
    autoRecover: { attempts: 1 },
    halt: { at: '2026-08-22T07:00:00.000Z', reason: 'verification red' },
  };
  const only = (over: Partial<InboxFacts>) =>
    buildInbox({ runs: [halted], ...over }, NOW).items.filter((i) => i.kind === 'errand');

  assert.equal(only({ flags: { allowRun: true } }).length, 0, 'the ladder owns a run that opted in on a running console');
  assert.equal(only({ flags: { allowRun: false } }).length, 1, 'a read-only console must still be told');
  assert.equal(
    only({ flags: { allowRun: true }, runs: [{ ...halted, autoRecover: undefined }] as never }).length,
    1,
    'auto-recovery off means nothing climbs it by itself',
  );
  assert.equal(
    only({ flags: { allowRun: true }, runs: [{ ...halted, stoppedBy: 'operator' }] as never }).length,
    0,
    "an operator's own stop is not an ask",
  );
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

test('every href the builder can emit lands on a head the client registers', () => {
  // Copied from `test/route-contract.test.ts`, which explains why: an unknown
  // head or an unregistered plan tab is not an error the router reports — it
  // falls back silently, so a wrong href is a link that looks like it worked.
  const { items } = buildInbox(facts(), NOW, { all: true });
  assert.ok(items.length > 10, 'the fact set must actually exercise every builder');

  // The two kinds the base fixture deliberately does not carry facts for.
  const more = buildInbox({ ...stallFacts(), rulings: [RULING] }, NOW, { all: true }).items;
  assert.ok(more.some((i) => i.kind === 'stall') && more.some((i) => i.kind === 'ruling'));

  for (const item of [...items, ...more]) {
    const { segments } = parseHash(toHash(item.href));
    assert.ok(isRouteHead(segments[0]), `${item.id} → ${item.href} — '${segments[0]}' is not in ROUTE_HEADS`);
    assert.ok(!item.href.includes('undefined'), `${item.id} leaked an undefined into ${item.href}`);
    if (segments[0] !== 'plan') continue;
    const tail = segments[2];
    assert.ok(
      PLAN_TABS.includes(tail) || tail === 'phase' || tail === 'handoff',
      `${item.id} targets plan tab '${tail}', which the plan view does not register`,
    );
  }
});

test('a slug that needs encoding survives into the href', () => {
  const { items } = buildInbox(
    {
      runs: [
        {
          id: 'r',
          slug: 'a plan/with?odd chars',
          status: 'halted',
          stoppedBy: 'system',
          halt: { at: '2026-08-22T07:00:00.000Z' },
        },
      ],
    },
    NOW,
  );
  const { segments } = parseHash(items[0].href);
  assert.deepEqual(segments, ['plan', 'a plan/with?odd chars', 'run']);
});

/* ------------------------------------------------------------------ *
 * The acks file
 * ------------------------------------------------------------------ */

/**
 * A disposable acks directory per test.
 *
 * Every acks function takes its directory as a parameter for exactly this
 * reason — the `launcher.ts` rule, same incident class: a test that reached
 * `INSTANCE_STATE_DIR` would be writing into the operator's own console state,
 * which is what `state-sandbox.ts` exists to make impossible and what this
 * makes unnecessary.
 */
const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-acks-'));
  sandboxes.push(dir);
  return dir;
}

after(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover tmpdir is not a failure */
    }
  }
});

test('acks round-trip through a file that outlives the process', () => {
  const dir = sandbox();

  // The console's dedupe maps (`notifiedRun` / `notifiedPhase`) are in-memory
  // and re-announce after a restart on purpose. An inbox may not: it
  // accumulates, so its acks have to be a real file.
  assert.deepEqual(readAcks(dir), {}, 'a missing file is "nothing is acknowledged", not an error');

  writeAck(dir, ERRAND_ID, 'mobin', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'lock:demo:9::expired', undefined, '2026-08-22T10:05:00.000Z');

  assert.deepEqual(readAcks(dir), {
    [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'mobin' },
    'lock:demo:9::expired': { at: '2026-08-22T10:05:00.000Z' },
  });

  assert.equal(removeAck(dir, ERRAND_ID), true);
  assert.equal(removeAck(dir, ERRAND_ID), false, 'removing what is not there is not an error');
  assert.deepEqual(Object.keys(readAcks(dir)), ['lock:demo:9::expired']);

  clearAcks(dir);
  assert.deepEqual(readAcks(dir), {});
  clearAcks(dir);
});

test('a bulk acknowledge is one write, and answers per item', () => {
  const dir = sandbox();

  // `writeAck` is read-modify-write-the-whole-file, which is right for one and
  // wrong for seventeen: the file holds up to 2000 entries, so a bulk press
  // through the single-item writer would rewrite and fsync-rename it once per
  // id to record a change it could make once.
  const written = writeAckMany(dir, [ERRAND_ID, 'lock:demo:9::expired'], 'mobin', '2026-08-22T10:00:00.000Z');
  assert.deepEqual(Object.keys(written), [ERRAND_ID, 'lock:demo:9::expired']);
  assert.deepEqual(readAcks(dir), {
    [ERRAND_ID]: { at: '2026-08-22T10:00:00.000Z', by: 'mobin' },
    'lock:demo:9::expired': { at: '2026-08-22T10:00:00.000Z', by: 'mobin' },
  });

  // Every id in one batch carries ONE stamp. The staleness rule compares an
  // ack's `at` against the item's own `since`, so ids acknowledged by the same
  // press must age together — otherwise which of seventeen comes back first
  // depends on how long the loop took.
  const stamps = new Set(Object.values(readAcks(dir)).map((ack) => ack.at));
  assert.equal(stamps.size, 1);

  // An empty batch writes nothing at all rather than an empty file.
  const empty = sandbox();
  assert.deepEqual(writeAckMany(empty, []), {});
  assert.deepEqual(readAcks(empty), {});
});

test('a bulk un-acknowledge says which ids it actually removed', () => {
  const dir = sandbox();
  writeAckMany(dir, ['a', 'b'], 'mobin', '2026-08-22T10:00:00.000Z');

  // Per id, because "some of them were not acked" is a different fact from
  // "the call failed", and Undo has to be able to tell them apart.
  const removed = removeAckMany(dir, ['a', 'never-acked', 'b']);
  assert.deepEqual(removed, { a: true, 'never-acked': false, b: true });
  assert.deepEqual(readAcks(dir), {});

  // Removing nothing is not an error, and does not rewrite the file either.
  assert.deepEqual(removeAckMany(dir, ['ghost']), { ghost: false });
});

test('an unreadable acks file degrades to empty rather than taking the route down', () => {
  const dir = sandbox();
  writeFileSync(acksFile(dir), 'not json at all');
  assert.deepEqual(readAcks(dir), {});

  writeFileSync(acksFile(dir), JSON.stringify({ version: 99, acks: { x: { at: 'now' } } }));
  assert.deepEqual(readAcks(dir), {}, 'a version this console does not know is not readable state');

  writeFileSync(acksFile(dir), JSON.stringify({ version: 1, acks: { good: { at: 'a' }, bad: { by: 'no at' } } }));
  assert.deepEqual(readAcks(dir), { good: { at: 'a' } }, 'a malformed entry is dropped, the rest survives');
});

test('pruning drops the acks of asks that have gone, and only those', () => {
  const dir = sandbox();
  writeAck(dir, 'still-asking', 'me', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'gone-away', 'me', '2026-08-22T10:00:00.000Z');
  writeAck(dir, 'ancient', 'me', '2020-01-01T00:00:00.000Z');

  const dropped = pruneAcks(dir, ['still-asking', 'ancient'], { now: NOW });
  assert.equal(dropped, 2, 'the vanished one and the aged-out one');
  assert.deepEqual(Object.keys(readAcks(dir)), ['still-asking']);

  assert.equal(pruneAcks(dir, ['still-asking'], { now: NOW }), 0, 'nothing to do writes nothing');
});

test('an item that goes away and comes back returns unacknowledged', () => {
  // The whole reason `pruneAcks` exists: a signed-out account carries no clock,
  // so nothing about its `since` can say it is new. Absence can.
  const dir = sandbox();
  const id = inboxItemId({ kind: 'sign-in', subject: 'machine' });
  const out = facts({ auth: { loggedIn: false } });

  writeAck(dir, id, 'mobin', '2026-08-22T11:00:00.000Z');
  assert.equal(find(buildInbox({ ...out, acks: readAcks(dir) }, NOW).items, id), undefined, 'acked, so hidden');

  // Signed in: the item is gone, and the route prunes against the ids the
  // build produced.
  const back = facts({ auth: { loggedIn: true } });
  pruneAcks(dir, inboxIds(back, NOW), { now: NOW });
  assert.deepEqual(readAcks(dir), {}, 'its ack goes with it');

  // Signed out again — same id, no ack.
  const again = find(buildInbox({ ...out, acks: readAcks(dir) }, NOW).items, id);
  assert.ok(again, 'the ask returns');
  assert.equal(again.ack, undefined);
});

test('the acks file is written the way small JSON state is written here', () => {
  const dir = sandbox();
  writeAck(dir, 'x', 'me', '2026-08-22T10:00:00.000Z');
  const raw = readFileSync(acksFile(dir), 'utf8');
  assert.equal(JSON.parse(raw).version, 1, 'a version envelope, so a later shape is recognisable');
  assert.ok(raw.endsWith('\n'));
});

/* ------------------------------------------------------------------ *
 * Every action must be one the server would actually accept
 * ------------------------------------------------------------------ */

test('no inbox action posts a /api/write body the write layer rejects', () => {
  // `useInboxActions.perform` posts the endpoint, method and body off the action
  // VERBATIM — deliberately, so the client holds no second copy of the routing
  // table. The cost of that contract is that an incomplete body is a button that
  // can only ever fail, and one shipped: the QA row's "Record a verdict" carried
  // neither `result` nor `report`, both required by `planWrite`, so every press
  // answered with a WriteError. It was the one button an operator reaches for
  // when a QA verdict has wedged their plan.
  //
  // Asserted against the real `planWrite` rather than a list of expected shapes:
  // a list would be a third copy of the same rule, and it would drift.
  const all: Array<{ id: string; verb: string; body: unknown }> = [];
  for (const flags of [
    { allowWrites: true, allowRun: true, allowAgent: true, allowMcp: true, allowAccounts: true },
    { allowWrites: false, allowRun: false, allowAgent: false, allowMcp: false, allowAccounts: false },
  ]) {
    for (const item of buildInbox(facts({ flags: flags as never }), NOW).items) {
      for (const action of item.actions ?? []) {
        if (action.endpoint === '/api/write') all.push({ id: item.id, verb: action.verb, body: action.body });
      }
    }
  }
  for (const { id, verb, body } of all) {
    assert.doesNotThrow(
      () => planWrite(body as never, { root: '/tmp/root', docsDir: '/tmp/root/docs' }),
      `${id} offers a ${verb} button whose body the write layer refuses — it can only ever fail`,
    );
  }
  // Positive control: the exact body that shipped must still be refused, so this
  // guard is known to have teeth rather than merely being green.
  assert.throws(
    () => planWrite({ action: 'qa-record', slug: 'demo', phase: 1 } as never,
      { root: '/tmp/root', docsDir: '/tmp/root/docs' }),
    /QA result must be one of/,
    'the shipped body was rejected by the write layer — that is what made the button dead',
  );
});

test('a QA row still offers a door, and names the one that works', () => {
  const { items } = buildInbox(facts(), NOW);
  const qa = items.filter((i) => i.kind === 'qa');
  for (const item of qa) {
    assert.ok(item.href, 'the phase page is where the verdict form lives');
    assert.match(item.how, /Record QA|QA session|Fix & re-QA|Re-run QA|Waive with a reason/,
      'the remedy must name a door that exists');
  }
});

test('a stop the ladder has not engaged with is still raised, even with auto-recovery armed', () => {
  // The suppression reads "the ladder will climb this and leave an errand, so
  // saying anything here would be saying it twice". That holds only for stops
  // the ladder can actually reach. A run whose every record the board reads
  // `done` yields no candidate at all, so nothing was ever written — and this
  // row, the one thing that would have told a person their run was waiting on
  // them, was suppressed on the assumption of an errand that never came.
  const wedged = {
    id: 'run-w', slug: 'wedged', status: 'parked' as const, stoppedBy: 'system' as const,
    updatedAt: '2026-08-22T10:00:00.000Z',
    autoRecover: { attempts: 2 },
    halt: { at: '2026-08-22T09:00:00.000Z', reason: 'nothing is ready to run', phase: 1, kind: 'plan-deadlocked' },
    phases: { 1: { phase: 1, status: 'done' } },
  };
  const { items } = buildInbox(
    facts({ runs: [wedged as never], flags: { allowRun: true, allowWrites: true } as never }), NOW,
  );
  const row = items.find((i) => i.kind === 'errand' && i.slug === 'wedged');
  assert.ok(row, 'a stop nothing has touched must reach the person it is waiting on');
  assert.equal(row!.severity, 'needs-you');
});

test('once the ladder HAS engaged, the generic row stands down for the errand', () => {
  const climbed = {
    id: 'run-c', slug: 'climbed', status: 'parked' as const, stoppedBy: 'system' as const,
    updatedAt: '2026-08-22T10:00:00.000Z',
    autoRecover: { attempts: 2 },
    halt: { at: '2026-08-22T09:00:00.000Z', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' },
    phases: { 2: { phase: 2, status: 'failed' } },
    recoveries: { 2: { attempts: 1, lastAt: NOW, rungs: [{ situation: 'verify-red', rung: 'resume-own-session', at: NOW, outcome: 'failed' }] } },
  };
  const { items } = buildInbox(
    facts({ runs: [climbed as never], flags: { allowRun: true, allowWrites: true } as never }), NOW,
  );
  // `&& i.subject === 'unattended-stop'` used to ride this predicate, and
  // `InboxItem` has no `subject` — `mint()` destructures it off and only feeds
  // it to `inboxItemId`. So the predicate was ALWAYS false and the assertion
  // passed without ever reaching the guard it names. This is the only test over
  // `errandDrafts`' engaged/not-engaged split, and it now really runs.
  assert.equal(
    items.some((i) => i.kind === 'errand' && i.slug === 'climbed'),
    false,
    'the ladder is working on it — two voices for one ask is the duplication this guard exists to stop',
  );
});

test('a closed plan does not ask anyone to continue its stopped run', () => {
  // A closed plan keeps its voice for errands, approvals, locks and health —
  // "claims about a process, not a pulse", and that policy is right. But
  // `unattended-stop` is the one errand that is explicitly a claim about a
  // STOPPED run ("nothing climbs this stop by itself"), and on a plan somebody
  // has closed there is nothing to climb toward. Measured live: two closed,
  // complete plans were contributing 2 of a console's 16 `needs-you` rows.
  const stopped = {
    id: 'run-done', slug: 'shut', status: 'parked' as const, stoppedBy: 'system' as const,
    updatedAt: '2026-08-22T10:00:00.000Z',
    halt: { at: '2026-08-22T09:00:00.000Z', reason: 'nothing is ready to run' },
  };
  const withPlan = (closed: boolean) => buildInbox(facts({
    runs: [stopped as never],
    plans: [{ slug: 'shut', closed, updatedAt: '2026-08-22T10:00:00.000Z' } as never],
    flags: { allowRun: false } as never,
  }), NOW).items.filter((i) => i.kind === 'errand' && i.slug === 'shut');

  assert.equal(withPlan(false).length, 1, 'an OPEN plan still asks — that is the whole point of the row');
  assert.equal(withPlan(true).length, 0, 'a closed plan has nothing to continue toward');
});

test('a QA verdict that is holding a plan is needs-you, not fyi', () => {
  // `pending` was graded `fyi` because "an owed verdict is a chore the operator
  // scheduled". That reads right until you notice what a pending row DOES: the
  // engine's `_is_verified` accepts only `pass|waived`, so a pending verdict on
  // a done phase holds every dependent exactly as hard as a failure — and
  // nothing dispatches QA on its own, so it holds them for ever. Measured: half
  // of why a real plan was dead sat below forty stale `fyi` rulings.
  //
  // The condition is unchanged (QA on, and the phase actually finished); only
  // the loudness moves, because the consequence was always this loud.
  const { items } = buildInbox(facts(), NOW);
  // Phase 3 of the fixture: done, QA on, verdict still `pending`.
  const owed = items.filter((i) => i.kind === 'qa' && i.phase === 3);
  assert.equal(owed.length, 1, 'the fixture must still raise an owed verdict');
  for (const item of owed) {
    assert.equal(item.severity, 'needs-you', `${item.id} holds its dependents and says so quietly`);
    assert.match(item.need, /holds|depend/i, 'and the ask names the consequence');
  }
});


/* ------------------------------------------------------------------ *
 * Session asks
 * ------------------------------------------------------------------ */

test('a session ask: only a live, waiting session raises one — a lane already asked by its phase\'s card excepted — permission urgent, input needs-you', () => {
  const { items } = buildInbox(facts(), NOW);
  const asks = items.filter((i) => i.kind === 'session-ask');
  assert.equal(asks.length, 1, 'quiet and ended sessions raise nothing, and a carded lane is not asked twice');
  const ask = asks[0];
  assert.equal(ask.severity, 'urgent', 'a permission prompt is a session parked dead');
  assert.match(ask.title, /permission/);
  assert.equal(ask.need, 'Claude needs your permission to use Bash', "the CLI's own words when it gave any");
  assert.match(ask.how, /terminal/);
  assert.equal(ask.since, '2026-08-22T11:05:00.000Z', "the episode's start is the item's clock");
  assert.equal(ask.href, '#/sessions');
  assert.deepEqual(ask.actions, [], 'no verb can answer someone else\u2019s terminal');

  // An ELICITATION — a question with no default — is an ask, and quieter:
  // nothing is spending while it waits, unlike a permission card.
  const elicit = buildInbox(facts({
    sessions: [{
      sessionId: 'sess-elicit', kind: 'foreign', presence: 'live', cwd: '/w',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'elicitation' },
    }],
  }), NOW);
  assert.equal(elicit.items.find((i) => i.kind === 'session-ask')?.severity, 'needs-you',
    'an elicitation stops the session, but nothing is burning while it waits');
});

test('ACC-8.9 (REG-5, TRS-6): a lane waiting on a person is a row in its own right — carrying the question and a steer that answers it', () => {
  const view = buildInbox(facts({
    approvals: [],
    flags: { allowRun: true },
    sessions: [{
      sessionId: 'sess-lane', kind: 'autopilot', presence: 'live', cwd: '/work/hub',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'elicitation', note: 'Which schema should I migrate first?' },
      plan: { slug: 'demo', phase: 4, strong: true },
    }],
  }), NOW);
  const row = view.items.find((i) => i.kind === 'session-ask');
  assert.ok(row, 'no approval card stands for the phase, so the lane\'s own wait is the ask');
  assert.equal(row?.need, 'Which schema should I migrate first?', 'the question itself');
  assert.match(row?.how ?? '', /Answer it here/);
  assert.equal(row?.actions.length, 1);
  assert.equal(row?.actions[0].verb, 'steer');
  assert.equal(row?.actions[0].endpoint, '/api/run/demo/steer');
  assert.deepEqual(row?.actions[0].body, { phase: 4 });
  assert.equal(row?.actions[0].says?.field, 'instruction');
  assert.equal(row?.actions[0].flag, undefined, 'pressable where runs are allowed');

  // Gated like every run verb, and a lane the console cannot place has no verb to offer.
  const gated = buildInbox(facts({
    approvals: [],
    flags: {},
    sessions: [{
      sessionId: 'sess-lane', kind: 'autopilot', presence: 'live', cwd: '/work/hub',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'permission' }, plan: { slug: 'demo', phase: 4, strong: true },
    }],
  }), NOW).items.find((i) => i.kind === 'session-ask');
  assert.equal(gated?.actions[0].flag, 'run');
  const unplaced = buildInbox(facts({
    approvals: [],
    sessions: [{ sessionId: 'sess-lane', kind: 'autopilot', presence: 'live', cwd: '/work/hub', waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'permission' } }],
  }), NOW).items.find((i) => i.kind === 'session-ask');
  assert.ok(unplaced, 'an uncorrelated lane still asks');
  assert.deepEqual(unplaced?.actions, []);
});

test('an idle prompt is NOT a session ask — a finished turn is what fine looks like', () => {
  // The Notification hook fires for more than a prompt, and every one of them
  // used to become a row and an URGENT push. `idle_prompt` is the CLI saying a
  // turn ended and it is waiting — which is a terminal at rest. The session is
  // still recorded as `waiting` (the sessions page shows it); it just does not
  // ask anybody for anything.
  const idle = buildInbox(facts({
    sessions: [{
      sessionId: 'sess-idle', kind: 'foreign', presence: 'live', cwd: '/w',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'input' },
    }],
  }), NOW);
  assert.equal(idle.items.find((i) => i.kind === 'session-ask'), undefined);
});

test('a Notification the registry did not classify raises nothing at all', () => {
  // `waiting` absent, or a kind from a payload shape this build has never seen.
  for (const waiting of [null, undefined, { since: '2026-08-22T11:00:00.000Z', kind: 'tool-use' }]) {
    const view = buildInbox(facts({
      sessions: [{ sessionId: 'sess-q', kind: 'foreign', presence: 'live', cwd: '/w', waiting }],
    }), NOW);
    assert.equal(view.items.find((i) => i.kind === 'session-ask'), undefined,
      `an unclassified '${waiting?.kind ?? 'absent'}' notification must raise nothing`);
  }
});

test("a session ask's id is the sessionId alone, so a flapping plan correlation never sheds the ack", () => {
  const withPlan = buildInbox(facts({
    sessions: [{
      sessionId: 'sess-x', kind: 'foreign', presence: 'live', cwd: '/w',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'elicitation' },
      plan: { slug: 'demo', phase: 4, strong: false },
    }],
  }), NOW);
  const without = buildInbox(facts({
    sessions: [{
      sessionId: 'sess-x', kind: 'foreign', presence: 'live', cwd: '/w',
      waiting: { since: '2026-08-22T11:00:00.000Z', kind: 'elicitation' },
    }],
  }), NOW);
  const idOf = (v: { items: readonly InboxItem[] }) => v.items.find((i) => i.kind === 'session-ask')?.id;
  assert.equal(idOf(withPlan), idOf(without), 'the weak correlation is display, never identity');
  assert.equal(idOf(withPlan), inboxItemId({ kind: 'session-ask', subject: 'sess-x' }));
  // The correlation still shows in the words, where it belongs.
  assert.match(withPlan.items.find((i) => i.kind === 'session-ask')?.need ?? '', /demo phase 4/);
});

test('an acked session ask stays quiet within its episode and returns when a NEW episode begins', () => {
  const session = (since: string) => ({
    sessions: [{
      sessionId: 'sess-a', kind: 'foreign', presence: 'live', cwd: '/w',
      waiting: { since, kind: 'elicitation' as const },
    }],
  });
  const id = inboxItemId({ kind: 'session-ask', subject: 'sess-a' });
  const ack = { [id]: { at: '2026-08-22T11:30:00.000Z', by: 'sam' } };

  const sameEpisode = buildInbox(facts({ ...session('2026-08-22T11:00:00.000Z'), acks: ack }), NOW);
  assert.equal(sameEpisode.items.find((i) => i.kind === 'session-ask'), undefined, 'acked — quiet');

  const newEpisode = buildInbox(facts({ ...session('2026-08-22T11:45:00.000Z'), acks: ack }), NOW);
  assert.ok(newEpisode.items.find((i) => i.kind === 'session-ask'),
    'a since past the ack is a new ask — the standing ackFor rule, no special case');
});

/* ------------------------------------------------------------------ *
 * Words an action can carry
 * ------------------------------------------------------------------ */

/**
 * `InboxAction.says` is what lets `#/approve` offer a text box without knowing
 * that a gate wants `note` and a permission card wants `reason`. The client
 * reads the field name off the action, so a producer that stops declaring one
 * silently removes the box — and the client's own tests, which build their own
 * fixtures, would not notice. This asserts the REAL builder.
 */
test('the actions that can carry words say which body key they go in', () => {
  const facts: InboxFacts = {
    flags: { allowRun: true, allowWrites: true },
    approvals: [{
      id: 'ap-1', status: 'pending', slug: 'demo', phase: 2, runId: 'r1',
      title: 'Bash(git push:*)', createdAt: '2026-08-22T11:00:00.000Z',
    }],
    plans: [{
      slug: 'demo',
      updatedAt: '2026-08-22T11:00:00.000Z',
      phases: [{
        phase: 4, title: 'Four', state: 'ready', gated: true, gateKind: 'human',
        gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' },
      }],
    }],
  } as unknown as InboxFacts;

  const { items } = buildInbox(facts, NOW);

  const gateAction = items.find((i) => i.kind === 'gate')?.actions.find((a) => a.verb === 'approve');
  assert.ok(gateAction, 'the open gate must offer approve');
  assert.equal(gateAction.says?.field, 'note',
    'a gate clearance is written into gate-status.md, and `note` is the column that carries the evidence');
  assert.ok(gateAction.says?.label, 'a field with no label is a box nobody knows what to type in');

  for (const verb of ['allow', 'deny'] as const) {
    const decide = items.find((i) => i.kind === 'approval')?.actions.find((a) => a.verb === verb);
    assert.ok(decide, `the pending card must offer ${verb}`);
    assert.equal(decide.says?.field, 'reason',
      'the approvals route reads the operator’s words as `reason`');
  }

  // And the key really is the route's. A `says.field` naming something the
  // endpoint ignores is a box that swallows what was typed.
  assert.ok(gateAction.says);
  assert.notEqual(gateAction.says.field, 'reason', 'the gate route reads `note`, not `reason`');
});

/* ------------------------------------------------------------------ *
 * conflict — two live branches that would not merge
 *
 * The radar is repository-WIDE: every isolated run of one repository sees
 * every pair. So the interesting properties are not "does a conflict raise a
 * card" but "does ONE conflict raise ONE card, and does it name the run an
 * operator can actually move".
 * ------------------------------------------------------------------ */

const OLDER = { slug: 'alpha', branch: 'pe/alpha', startedAt: '2026-08-22T08:00:00.000Z', isolation: 'worktree' };
const YOUNGER = { slug: 'beta', branch: 'pe/beta', startedAt: '2026-08-22T10:00:00.000Z', isolation: 'worktree' };
const CONFLICT = { a: 'pe/alpha', b: 'pe/beta', state: 'conflicted', files: ['viewer/server/inbox.ts'] };
const CLEAN = { a: 'pe/alpha', b: 'pe/beta', state: 'clean', files: [] };

/** Both runs' probes, each carrying the same repository-wide radar. */
const bothSee = (pair: typeof CONFLICT | typeof CLEAN) => [
  { ...OLDER, radar: [pair] },
  { ...YOUNGER, radar: [pair] },
];

const conflicts = (over: Partial<InboxFacts> = {}): InboxItem[] =>
  buildInbox(facts(over), NOW).items.filter((item) => item.kind === 'conflict');

test('clean → conflicted mints exactly ONE card, from two runs that both see it', () => {
  assert.deepEqual(conflicts({ git: bothSee(CLEAN) }), [], 'a clean radar asks nobody anything');

  const raised = conflicts({ git: bothSee(CONFLICT) });
  assert.equal(raised.length, 1, 'both probes report the pair; the operator is asked once');
  const [item] = raised;
  assert.equal(item.severity, 'needs-you');
  assert.match(item.title, /pe\/alpha × pe\/beta/, 'the subject is the branch PAIR');
  assert.ok(item.need.includes('viewer/server/inbox.ts'), 'the card names the file it is about');
  assert.ok(item.how, 'every item must say how to give what it needs');
});

test('the id is the PAIR, order-independent — so one ack silences one question', () => {
  const forward = conflicts({ git: bothSee(CONFLICT) })[0];
  const backward = conflicts({ git: bothSee({ ...CONFLICT, a: 'pe/beta', b: 'pe/alpha' }) })[0];
  assert.equal(forward.id, backward.id, 'a × b and b × a are one question and must be one id');
  // And which probe reported it first cannot change the id either.
  const reversed = conflicts({ git: [...bothSee(CONFLICT)].reverse() })[0];
  assert.equal(reversed.id, forward.id);
});

test('conflicted → clean resolves the card, and the ack goes with it', () => {
  const live = facts({ git: bothSee(CONFLICT) });
  const id = buildInbox(live, NOW).items.find((i) => i.kind === 'conflict')!.id;

  // Acknowledged, and therefore hidden — but still an id the facts produce, so
  // `pruneAcks` keeps the ack.
  const acked = facts({ git: bothSee(CONFLICT), acks: { [id]: { at: '2026-08-22T11:00:00.000Z' } } });
  assert.deepEqual(buildInbox(acked, NOW).items.filter((i) => i.kind === 'conflict'), []);
  assert.ok(inboxIds(acked, NOW).includes(id), 'an acked item is still an id the facts produce');

  // Resolved: the card is gone AND the id is gone, which is what makes the ack
  // prunable — and therefore what makes the same conflict read as NEW if it
  // ever comes back.
  const resolved = facts({ git: bothSee(CLEAN) });
  assert.deepEqual(buildInbox(resolved, NOW).items.filter((i) => i.kind === 'conflict'), []);
  assert.ok(!inboxIds(resolved, NOW).includes(id), 'a resolved pair must stop producing its id');
});

test('Serialize names the YOUNGER run and posts the settings endpoint verbatim', () => {
  const [item] = conflicts({ git: bothSee(CONFLICT), flags: { allowRun: true } });
  assert.equal(item.slug, 'beta', 'the younger run is the one asked to move');
  assert.equal(item.href, '#/plan/beta/run');

  const action = item.actions.find((a) => a.verb === 'serialize');
  assert.ok(action, 'a conflict with a movable run must offer the remedy');
  assert.equal(action.endpoint, '/api/run/beta/settings');
  assert.equal(action.method, 'POST');
  assert.deepEqual(action.body, { isolation: 'queue' });
  assert.equal(action.flag, undefined, '--allow-run is on, so nothing gates it');
  assert.ok(action.label.includes('beta'), 'the button says which run it moves');
});

test('the remedy is flagged, not hidden, when --allow-run is off', () => {
  const [item] = conflicts({ git: bothSee(CONFLICT), flags: { allowRun: false } });
  const action = item.actions.find((a) => a.verb === 'serialize');
  assert.equal(action?.flag, 'run', 'a read-only console shows the remedy and says what it costs');
});

test('a run that already queues is never offered a lowering it would 409 on', () => {
  // `RunSettingsPatch.isolation` travels one way. The younger run here is
  // already `queue`, so the only movable run is the older one.
  const [item] = conflicts({
    git: [
      { ...OLDER, radar: [CONFLICT] },
      { ...YOUNGER, isolation: 'queue', radar: [CONFLICT] },
    ],
    flags: { allowRun: true },
  });
  assert.equal(item.slug, 'alpha');
  assert.equal(item.actions.find((a) => a.verb === 'serialize')?.endpoint, '/api/run/alpha/settings');
});

test('a conflict with the operator’s own branch is reported with no remedy invented', () => {
  // `main` has a checkout and no run. Serializing `alpha` would move it into
  // the shared checkout — which is standing on the very branch it conflicts
  // with — so the row reports the fact and ships no button rather than one
  // that makes things worse.
  const [item] = conflicts({
    git: [{ ...OLDER, radar: [{ a: 'main', b: 'pe/alpha', state: 'conflicted', files: ['a.ts', 'b.ts'] }] }],
    flags: { allowRun: true },
  });
  assert.equal(item.slug, undefined, 'no run pair, so the card belongs to no plan');
  assert.equal(item.href, '#/runs');
  assert.deepEqual(item.actions, []);
  assert.ok(item.need.includes('2 files'));
});

test('two queue runs are already serialized — the card reports, and offers nothing', () => {
  const [item] = conflicts({
    git: [
      { ...OLDER, isolation: 'queue', radar: [CONFLICT] },
      { ...YOUNGER, isolation: 'queue', radar: [CONFLICT] },
    ],
    flags: { allowRun: true },
  });
  assert.deepEqual(item.actions, [], 'lowering a run that already queues is a 409, not a remedy');
});

test('overlap and unknown raise nothing — the radar has four words and one of them asks', () => {
  for (const state of ['overlap', 'unknown', 'clean']) {
    assert.deepEqual(conflicts({ git: bothSee({ ...CONFLICT, state }) }), [], state);
  }
});

/* ------------------------------------------------------------------ *
 * One derivation — the guards the fact map now owns
 * ------------------------------------------------------------------ */

/** A plan whose phase N is gated, not done, and not clear. */
const gatedPlan = (over: Record<string, unknown> = {}, phase: Record<string, unknown> = {}) => ({
  plans: [{
    slug: 'gp',
    phases: [{
      phase: 2, state: 'ready', gated: true, gateCheck: 'somebody must look',
      gateKind: 'human', gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' },
      ...phase,
    }],
    ...over,
  }],
});

test('a gate raises a row only when a PERSON must clear it', () => {
  const rows = (f: InboxFacts) => buildInbox(f, NOW).items.filter((i) => i.kind === 'gate');
  assert.equal(rows(gatedPlan()).length, 1, 'the baseline human gate still asks');

  // An `ai` gate is the phase's own first task: the boot prompt orders the
  // session to verify each condition, do the work to make failing ones true,
  // and record the clearance. Asking a person too is asking for an act nobody
  // needs to perform.
  assert.deepEqual(rows(gatedPlan({}, { gateKind: 'ai', gate: { clear: false, kind: 'ai' } })), []);

  // A DELEGATED human gate is the same case by the operator's own standing
  // decision (Settings ▸ Automation), which is off by default and explicit.
  assert.deepEqual(rows(gatedPlan({ gatesDelegated: true })), []);

  // Already approved: `gate-approve.sh` wrote the row and the engine reads it.
  assert.deepEqual(rows(gatedPlan({}, { gate: { clear: false, kind: 'human', approved: true } })), []);

  // And a gate on a phase the board is NOT calling ready asks for an act that
  // would change nothing today — the phase is held by its dependencies, and
  // approving the gate does not board it.
  assert.deepEqual(rows(gatedPlan({}, { state: 'waiting' })), []);
  assert.deepEqual(rows(gatedPlan({}, { state: 'done' })), []);
});

test('a declared park raises its errand and NO plan-health row', () => {
  // The measured defect: `plan-broken:stale-handoff` was the classifier's most
  // common wrong answer — 92 times across 34 runs — every time a session had
  // honestly declared an external wait. The handoff really does read
  // "in-progress"; the health check really does see it; and both are wrong
  // ABOUT THIS PHASE, because the session said what it was doing.
  const declared = {
    runs: [{
      id: 'r', slug: 'dp', status: 'waiting',
      recoveries: {
        '3': {
          errand: {
            phase: 3, situation: 'waiting-external', need: 'the CI run to land',
            how: 'nothing — it resumes itself', at: '2026-08-22T09:00:00.000Z',
          },
        },
      },
    }],
    plans: [{
      slug: 'dp',
      issues: [{ slug: 'dp', severity: 'error', kind: 'stale-handoff', message: 'phase 3 is in-progress', phase: 3 }],
    }],
    acks: {},
  } satisfies InboxFacts;
  const items = buildInbox(declared, NOW).items;
  assert.equal(items.filter((i) => i.kind === 'health').length, 0, 'the declaration wins');
  const errands = items.filter((i) => i.kind === 'errand');
  assert.equal(errands.length, 1);
  assert.equal(errands[0].need, 'the CI run to land');

  // The guard is narrow: a plan-broken situation on the SAME phase still
  // raises its health row, because that is the one situation the fact map lets
  // raise one.
  const broken = structuredClone(declared) as InboxFacts;
  (broken.runs as { recoveries: Record<string, { errand: { situation: string } }> }[])[0]
    .recoveries['3'].errand.situation = 'plan-broken:lint';
  assert.equal(buildInbox(broken, NOW).items.filter((i) => i.kind === 'health').length, 1);
});

test('an errand on a LIVE run carries the recheck action', () => {
  // The loop used to visit stopped runs alone, so the one pointer to a QA hold
  // sat invisible for sixteen hours while its run drove on around it. Recover
  // and Dismiss are both refused on a live run — `recheck` is the verb that is
  // true in either state, and it is what a person presses after doing the thing
  // the errand asked for.
  const live = {
    runs: [{
      id: 'r', slug: 'lr', status: 'running',
      recoveries: {
        '5': {
          errand: {
            phase: 5, situation: 'qa-pending', need: 'a QA verdict',
            how: 'record one on the phase page', at: '2026-08-22T09:00:00.000Z',
          },
        },
      },
    }],
    flags: { allowRun: true },
    acks: {},
  } satisfies InboxFacts;
  const [errand] = buildInbox(live, NOW).items.filter((i) => i.kind === 'errand');
  assert.ok(errand, 'a live run still raises its phase errand');
  const verbs = errand.actions.map((a) => a.verb);
  assert.deepEqual(verbs, ['recheck'], 'recheck alone — recover 409s and dismiss would resolve a live run');
  const [action] = errand.actions;
  assert.equal(action.endpoint, '/api/run/lr/recheck');
  assert.deepEqual(action.body, { phase: 5 }, 'recheck is a PHASE verb and needs one');
});

test('editing the plan file un-acks nothing', () => {
  // `plan.updatedAt` is the newest mtime across the plan file AND every handoff
  // artefact, so it moves every time a phase lands, a handoff is written or a
  // lock is claimed. Using it as a gate row's `since` threw the operator's ack
  // away on the next commit and asked them to approve the same gate again an
  // hour after they declined to.
  const base = gatedPlan();
  const id = buildInbox(base, NOW).items.find((i) => i.kind === 'gate')!.id;
  const acks = { [id]: { at: '2026-08-22T11:00:00.000Z', by: 'sam' } };

  const quiet = buildInbox({ ...base, acks }, NOW).items.filter((i) => i.kind === 'gate');
  assert.deepEqual(quiet, [], 'acked — quiet');

  // The plan is rewritten a minute later. Nothing about the GATE changed.
  const touched = {
    plans: [{ ...base.plans[0], updatedAt: new Date(NOW).toISOString() }],
    acks,
  } as InboxFacts;
  assert.deepEqual(
    buildInbox(touched, NOW).items.filter((i) => i.kind === 'gate'), [],
    'the plan moving is not the gate coming back',
  );
});

/* ------------------------------------------------------------------ *
 * P9 — the three QA-recovery verbs on the inbox row (issue #11)
 * ------------------------------------------------------------------ */

/** A plan whose phase 2 is finished and whose QA verdict is holding it. */
function qaHeldPlan(result: string) {
  return {
    slug: 'held', title: 'held', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'on' },
    qa: [{ phase: 2, result, ...(result === 'fail' ? { report: 'reports/phase-02-qa.md' } : {}) }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
}

const qaRow = (result: string, flags: Record<string, unknown> = { allowRun: true, allowWrites: true }) =>
  buildInbox({ plans: [qaHeldPlan(result)], runs: [], flags } as never, NOW)
    .items.find((i: { kind: string }) => i.kind === 'qa');

test('P9: a failed QA row offers Fix & re-QA, Re-run QA and Waive — the verbs, not a description', () => {
  // Before issue #11 this row carried one action, "Start a QA session", which
  // is the right answer to a MISSING verdict and the wrong one to a red one: a
  // review of unfixed code fails again, and the ladder's own rung had already
  // spent its caps proving it.
  const row = qaRow('fail')!;
  const verbs = row.actions.map((a: { verb: string }) => a.verb);
  assert.ok(verbs.includes('qa-recover'), 'Fix & re-QA');
  assert.ok(verbs.includes('qa-rerun'), 'Re-run QA');
  assert.ok(verbs.includes('qa-waive'), 'Waive with a reason');
  // Ordered fix → re-review → waive: cheapest BELIEF first.
  assert.ok(verbs.indexOf('qa-recover') < verbs.indexOf('qa-rerun'));
  assert.ok(verbs.indexOf('qa-rerun') < verbs.indexOf('qa-waive'));
  // Each performed verbatim by the client, so the endpoint has to be right.
  const byVerb = Object.fromEntries(row.actions.map((a: { verb: string }) => [a.verb, a]));
  assert.equal(byVerb['qa-recover'].endpoint, '/api/run/held/qa-recover');
  assert.equal(byVerb['qa-rerun'].endpoint, '/api/run/held/qa-rerun');
  assert.equal(byVerb['qa-waive'].endpoint, '/api/plans/held/qa-waive');
  for (const verb of ['qa-recover', 'qa-rerun', 'qa-waive']) {
    assert.equal(byVerb[verb].method, 'POST');
    assert.deepEqual(byVerb[verb].body, { phase: 2 });
  }
  // The waiver is the one action that carries the operator's own words, and the
  // SERVER names the body key — a client that had to know which action wants
  // `reason` and which wants `note` is the routing table `inboxAct` avoids.
  assert.equal(byVerb['qa-waive'].says.field, 'reason');
  assert.ok(!byVerb['qa-recover'].says, 'a loop takes no words');
  // And `how` names them rather than describing the situation again.
  assert.match(row.how, /Fix & re-QA/);
  assert.match(row.how, /Re-run QA/);
});

test('P9: a PENDING row offers the review and the waiver — never a fix with no findings', () => {
  const row = qaRow('pending')!;
  const verbs = row.actions.map((a: { verb: string }) => a.verb);
  assert.ok(!verbs.includes('qa-recover'), 'a pending verdict names no findings to fix');
  assert.ok(verbs.includes('qa-rerun'));
  assert.ok(verbs.includes('qa-waive'));
  assert.match(row.how, /Re-run QA/);
});

test('P9: the two run verbs name --allow-run, and the waiver names --allow-writes', () => {
  // A flag is present ONLY when the capability is off, so a client renders the
  // disabled state from one fact rather than joining two.
  const on = qaRow('fail', { allowRun: true, allowWrites: true, allowAgent: true })!;
  const P9 = ['qa-recover', 'qa-rerun', 'qa-waive'];
  for (const action of on.actions.filter((a: { verb: string }) => P9.includes(a.verb))) {
    assert.equal(action.flag, undefined, action.verb);
  }

  const off = qaRow('fail', { allowRun: false, allowWrites: false })!;
  const byVerb = Object.fromEntries(off.actions.map((a: { verb: string }) => [a.verb, a]));
  assert.equal(byVerb['qa-recover'].flag, 'run');
  assert.equal(byVerb['qa-rerun'].flag, 'run');
  // The split is the point: writing a row is not running a session, so a
  // console that may write but may not run can still release a gate.
  assert.equal(byVerb['qa-waive'].flag, 'writes');
});

test('P9 (QA round 1, M1): a plan whose gate was turned off raises NO qa row, fail included', () => {
  // `**QA gate:** off` resolves to mode `waived`: every verdict it recorded
  // STAYS recorded and stops holding anyone. Raising a needs-you row with a
  // live, POST-able Fix & re-QA button over one is asking a person to spend a
  // session on a hold that does not exist — and `failed` was the one word with
  // no mode guard, so it did exactly that.
  const plan = {
    slug: 'released', title: 'released', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'waived' },
    qa: [{ phase: 2, result: 'fail', report: 'reports/phase-02-qa.md' }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
  const { items } = buildInbox(
    { plans: [plan], runs: [], flags: { allowRun: true, allowWrites: true } } as never, NOW);
  assert.equal(items.filter((i: { kind: string }) => i.kind === 'qa').length, 0);
});

test('P9 (QA round 1, M1): a per-phase `- **QA:** on` still raises the fail on a waived plan', () => {
  // The inverse, and the reason the guard is `mode === 'on' || qaModes[n]` and
  // not `mode === 'on'`: the phase's own word beats the plan's, both ways.
  const plan = {
    slug: 'perphase', title: 'perphase', closed: false,
    updatedAt: '2026-01-01T00:00:00Z',
    qaMode: { mode: 'waived' },
    qaModes: { 2: 'on' },
    qa: [{ phase: 2, result: 'fail', report: 'reports/phase-02-qa.md' }],
    issues: [],
    phases: [{ phase: 2, title: 'two', state: 'done', gated: false }],
  };
  const { items } = buildInbox(
    { plans: [plan], runs: [], flags: { allowRun: true, allowWrites: true } } as never, NOW);
  const rows = items.filter((i: { kind: string }) => i.kind === 'qa');
  assert.equal(rows.length, 1, "the phase's own regime gates, so the ask must show");
  assert.ok(rows[0].actions.some((a: { verb: string }) => a.verb === 'qa-recover'));
});

/* ------------------------------------------------------------------ *
 * The relay's question rows (zero-touch-console phase 14)
 * ------------------------------------------------------------------ */

test('a relayed question is one urgent row per unanswered question, one action per option, with the window it closes on — and never a permission row', () => {
  const createdAt = '2026-08-22T11:59:30.000Z';
  const expiresAt = '2026-08-22T12:00:30.000Z';
  const view = buildInbox(facts({
    runs: [], plans: [], locks: [],
    approvals: [{
      id: 'q1', runId: 'run-9', slug: 'demo', phase: 3, kind: 'question', status: 'pending', createdAt, expiresAt,
      title: 'Which colour should the banner be?', detail: 'Phase 3 of demo asks.',
      question: {
        items: [
          { key: 'colour:which-colour', question: 'Which colour should the banner be?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue (Recommended)' }] },
          { key: 'port:which-port', question: 'Which port?', options: [{ label: '8080' }, { label: '9090' }] },
          { key: 'done:already', question: 'Already answered?', options: [{ label: 'Yes' }] },
        ],
        answers: { 'done:already': { label: 'Yes', by: 'human' } },
      },
    }, {
      id: 'q2', runId: 'run-9', slug: 'demo', phase: 4, kind: 'question', status: 'pending', createdAt, expiresAt,
      question: { items: [{ key: 'kept:one', question: 'Kept for the resume?', options: [{ label: 'Yes' }] }], answers: {}, deferred: { toolUseId: 't' } },
    }],
    flags: { allowRun: true },
  }), NOW);
  const questions = view.items.filter((item) => item.kind === 'question');
  assert.deepEqual(questions.map((item) => item.title).sort(), ['Which colour should the banner be?', 'Which port?'],
    'one row per question still open — not the answered one, not the deferred card');
  assert.ok(!view.items.some((item) => item.kind === 'approval'), 'a question is not a permission card');
  const colour = questions.find((item) => item.title.startsWith('Which colour'))!;
  assert.equal(colour.severity, 'urgent');
  assert.equal(colour.expiresAt, expiresAt, 'the window a surface counts down to');
  assert.match(colour.how, /"Blue \(Recommended\)" unless a rule says otherwise/, 'what silence will choose');
  assert.deepEqual(colour.actions.map((action) => action.label), ['Red', 'Blue (Recommended)']);
  assert.deepEqual(colour.actions[1], {
    verb: 'answer-2', label: 'Blue (Recommended)', endpoint: '/api/run/demo/answer', method: 'POST',
    body: { approvalId: 'q1', key: 'colour:which-colour', label: 'Blue (Recommended)' },
  });
  assert.equal(colour.id, inboxItemId({ kind: 'question', slug: 'demo', phase: 3, runId: 'run-9', subject: 'q1:colour:which-colour' }));
  // Gated like the permission card beside it.
  const locked = buildInbox(facts({ runs: [], plans: [], locks: [], approvals: [{
    id: 'q1', runId: 'run-9', slug: 'demo', phase: 3, kind: 'question', status: 'pending', createdAt, expiresAt,
    question: { items: [{ key: 'a:b', question: 'A?', options: [{ label: 'x' }] }], answers: {} },
  }], flags: { allowRun: false } }), NOW).items.find((item) => item.kind === 'question')!;
  assert.equal(locked.actions[0].flag, 'run');
});

test('a relayed answer\'s ruling offers to become a relay RULE — never a ## Decisions row', () => {
  const at = '2026-08-22T11:00:00.000Z';
  const view = buildInbox(facts({
    runs: [], plans: [], locks: [], approvals: [],
    rulings: [{
      id: 'abc123def456', slug: 'demo', phase: 3, kind: 'ambiguity', decisionKey: 'ambiguity', at,
      what: 'answered "Which port?" with "8080"', why: 'no operator answered within the window; the console answered by first-option',
      relay: { tool: 'AskUserQuestion', key: 'port:which-port', answer: '8080', answeredBy: 'first-option' },
    }],
    flags: { allowWrites: true },
  }), NOW);
  const row = view.items.find((item) => item.kind === 'ruling')!;
  assert.ok(row, 'the ruling is a row');
  assert.deepEqual(row.actions.map((action) => action.verb), ['remember-rule']);
  assert.deepEqual(row.actions[0].body, { scope: 'rule' });
  assert.match(row.how, /answer "8080" to this question on every run/);
});

/* ------------------------------------------------------------------ *
 * Instance health is work (zero-touch phase 17, FLT-1 iv / FLT-6)
 * ------------------------------------------------------------------ */

test('instance health: unread on a console that can reach nobody is itself a needs-you — and not once a channel exists', () => {
  const unheard = {
    fleet: { delivery: { ok: false, reason: 'no delivery channel: no subscribed device' }, unread: 29, remote: null, siblings: [] },
  } satisfies InboxFacts;
  const rows = buildInbox(unheard, NOW).items.filter((item) => item.kind === 'health');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.severity, 'needs-you');
  assert.match(rows[0]!.title, /29 notifications nobody was told about/);
  assert.match(rows[0]!.need, /no subscribed device/);

  const reached = { fleet: { ...unheard.fleet, delivery: { ok: true, reason: '1 subscribed device' } } } satisfies InboxFacts;
  assert.equal(buildInbox(reached, NOW).items.filter((item) => item.kind === 'health').length, 0, 'unread with a recipient is just unread');
  const nothingUnread = { fleet: { ...unheard.fleet, unread: 0 } } satisfies InboxFacts;
  assert.equal(buildInbox(nothingUnread, NOW).items.length, 0);
});

test('instance health: under --remote, Tailscale stopped and Serve pointing elsewhere are each a needs-you naming what to do', () => {
  const stopped = {
    fleet: { delivery: { ok: true, reason: 'x' }, unread: 0, siblings: [], remote: { running: false, detail: 'Stopped', forOurPort: false, hosts: ['console.example.ts.net'] } },
  } satisfies InboxFacts;
  const down = buildInbox(stopped, NOW).items;
  assert.equal(down.length, 1);
  assert.equal(down[0]!.severity, 'needs-you');
  assert.match(down[0]!.title, /Tailscale is not running/);
  assert.match(down[0]!.need, /console\.example\.ts\.net/);

  const elsewhere = {
    fleet: { ...stopped.fleet, remote: { running: true, forOurPort: false, hosts: ['console.example.ts.net'], occupant: { port: 4130, id: 'f922d743-pe-hub', name: 'pe-hub' } } },
  } satisfies InboxFacts;
  const serve = buildInbox(elsewhere, NOW).items;
  assert.equal(serve.length, 1);
  assert.match(serve[0]!.title, /Serve points at another console/);
  assert.match(serve[0]!.need, /the console "pe-hub" \(port 4130\)/, 'the occupant by name, never "something else"');

  const ours = { fleet: { ...stopped.fleet, remote: { running: true, forOurPort: true, hosts: ['console.example.ts.net'] } } } satisfies InboxFacts;
  assert.equal(buildInbox(ours, NOW).items.length, 0);
});


test('instance health: an orphaned sibling and a sibling with no live process are needs-you; one stopped on purpose is not', () => {
  const sibling = (over: Record<string, unknown>) => ({
    id: '3a3a6ca6-tour', name: 'tour', root: '/tmp/tour', liveness: 'stopped', discrepancies: [] as string[],
    unit: false, autostart: true as boolean | 'once', stopMarker: false, lastSeenAt: '2026-09-13T04:12:17.000Z', stoppedAt: null as string | null,
    ...over,
  });
  const facts = (siblings: ReturnType<typeof sibling>[]) => ({
    fleet: { delivery: { ok: true, reason: 'x' }, unread: 0, remote: null, siblings },
  }) satisfies InboxFacts;

  const orphaned = buildInbox(facts([sibling({ liveness: 'orphaned', discrepancies: ['root-missing'] })]), NOW).items;
  assert.equal(orphaned.length, 1);
  assert.match(orphaned[0]!.title, /registered for a directory that is gone/);
  assert.match(orphaned[0]!.how, /phase-console remove 3a3a6ca6-tour/);

  const crashed = buildInbox(facts([sibling({ discrepancies: ['stale-heartbeat'] })]), NOW).items;
  assert.equal(crashed.length, 1, 'stopped beating without a clean exit');
  assert.match(crashed[0]!.title, /"tour" is down/);
  assert.equal(crashed[0]!.severity, 'needs-you');

  const supervised = buildInbox(facts([sibling({ unit: true, stoppedAt: '2026-09-13T04:12:17.000Z' })]), NOW).items;
  assert.equal(supervised.length, 1, 'a unit that should keep it up, and it is not running');

  assert.equal(buildInbox(facts([sibling({ unit: true, stopMarker: true })]), NOW).items.length, 0, 'Stay off is a decision');
  assert.equal(buildInbox(facts([sibling({ unit: true, autostart: false })]), NOW).items.length, 0, 'autostart:false is a decision');
  assert.equal(buildInbox(facts([sibling({ stoppedAt: '2026-09-13T04:12:17.000Z' })]), NOW).items.length, 0,
    'a foreground console closed cleanly is not down — nothing was meant to keep it up');
  assert.equal(buildInbox(facts([sibling({ liveness: 'running' })]), NOW).items.length, 0);
});

/* ------------------------------------------------------------------ *
 * Phase 7 — clash zones: the pairs that merge CLEANLY and are wrong
 * afterwards.
 * ------------------------------------------------------------------ */

const ZONED = {
  a: 'pe/alpha', b: 'pe/beta', state: 'overlap',
  files: ['package-lock.json'], zones: ['**/package-lock.json'],
};

test('P7 — a clash zone raises ONE `fyi` row, beside the conflict rows and never instead of them', () => {
  // 🔴 `overlap`, not `conflicted`: git would merge these two happily, which
  // is exactly the problem. A radar that only spoke at `conflicted` would say
  // nothing until the lockfile was already wrong.
  const raised = conflicts({ git: [{ ...OLDER, radar: [ZONED] }, { ...YOUNGER, radar: [ZONED] }] });

  assert.equal(raised.length, 1, 'both probes carry the pair; the operator is told once');
  const [item] = raised;
  assert.equal(item.severity, 'fyi', 'nothing is broken yet — a needs-you row here teaches people to stop reading');
  assert.match(item.title, /both branches are editing a clash zone/);
  assert.match(item.need, /package-lock\.json/);
  assert.equal(item.slug, 'beta', 'the YOUNGER run is the one worth serializing');
  assert.equal(item.actions.find((action) => action.verb === 'serialize')?.label, 'Serialize beta');
});

test('P7 — a zoned pair that is ALSO conflicted produces both rows, and they are different cards', () => {
  const both = { ...ZONED, state: 'conflicted' };
  const raised = conflicts({ git: [{ ...OLDER, radar: [both] }, { ...YOUNGER, radar: [both] }] });

  assert.equal(raised.length, 2, 'a conflict and a zone are two things to say about one pair');
  assert.deepEqual(
    raised.map((item) => item.severity).sort(), ['fyi', 'needs-you'],
    'and they are not the same severity, which is why they are not one row',
  );
  // Distinct subjects, so acknowledging one does not silence the other.
  assert.equal(new Set(raised.map((item) => item.id)).size, 2);
});

test('P7 — a pair with no zones raises no zone row at all', () => {
  const raised = conflicts({ git: bothSee(CONFLICT) });
  assert.deepEqual(raised.map((item) => item.severity), ['needs-you']);
});

/* ------------------------------------------------------------------ *
 * issue-draft — a session's draft, held for a person (phase 12)
 * ------------------------------------------------------------------ */

const DRAFT = {
  id: 'abcdefabcdef', slug: 'demo', phase: 3, action: 'file', repo: 'phased-execution',
  title: 'phase-lock.sh drops the lease on a slow disk', where: 'scripts/phase-lock.sh:212',
  state: 'pending-approval', stateAt: '2026-08-22T11:00:00.000Z', runId: 'r1',
};

test('a pending-approval draft is a needs-you row with Approve, Discard and two Edits, keyed on the draft id', () => {
  const { items } = buildInbox({ issueDrafts: [DRAFT], flags: { allowPublish: true }, acks: {} }, NOW);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.kind, 'issue-draft');
  assert.equal(row.severity, 'needs-you');
  assert.equal(row.id, inboxItemId({ kind: 'issue-draft', slug: 'demo', phase: 3, runId: 'r1', subject: 'abcdefabcdef' }));
  assert.match(row.title, /demo phase 3 — file an issue on phased-execution/);
  assert.match(row.title, /phase-lock\.sh drops the lease/);
  assert.match(row.need, /scripts\/phase-lock\.sh:212/);
  assert.match(row.how, /Approve files it/);
  assert.equal(row.since, DRAFT.stateAt);
  assert.equal(row.href, '#/plan/demo/phase/3');
  assert.deepEqual(row.actions.map((a) => [a.verb, a.method, a.endpoint]), [
    ['approve', 'POST', '/api/run/demo/issues/abcdefabcdef/file'],
    ['discard', 'POST', '/api/run/demo/issues/abcdefabcdef/discard'],
    ['edit-title', 'POST', '/api/run/demo/issues/abcdefabcdef/edit'],
    ['edit-body', 'POST', '/api/run/demo/issues/abcdefabcdef/edit'],
  ]);
  assert.equal(row.actions[0].flag, undefined, 'the flag is on, so Approve is pressable');
  assert.deepEqual(row.actions[2].says, { field: 'title', label: 'New title', placeholder: DRAFT.title });
  assert.equal(row.actions[3].says?.field, 'body');
});

test('with --allow-publish off the Approve action carries the flag and the row says so', () => {
  const { items } = buildInbox({ issueDrafts: [DRAFT], flags: {}, acks: {} }, NOW);
  const [row] = items;
  assert.equal(row.actions[0].flag, 'publish');
  assert.equal(row.actions[1].flag, undefined, 'Discard needs no capability');
  assert.match(row.how, /--allow-publish/);
});

test('a comment and a close draft name their number; a close held for the landing is fyi with Discard alone', () => {
  const { items } = buildInbox({
    issueDrafts: [
      { ...DRAFT, id: 'bbbbbbbbbbbb', action: 'comment', number: 17, text: 'seen again from phase 3', title: undefined, where: undefined },
      { ...DRAFT, id: 'cccccccccccc', action: 'close', number: 12, reason: 'fixed in 9159e249', title: undefined, where: undefined, state: 'pending-landing', note: 'held until phase 3 has landed (pr)' },
    ],
    flags: { allowPublish: true }, acks: {},
  }, NOW);
  assert.equal(items.length, 2);
  const comment = items.find((i) => i.severity === 'needs-you')!;
  const close = items.find((i) => i.severity === 'fyi')!;
  assert.match(comment.title, /comment on phased-execution#17/);
  assert.match(comment.need, /seen again from phase 3/);
  assert.match(close.title, /close phased-execution#12/);
  assert.match(close.title, /waits for phase 3 to land/);
  assert.match(close.need, /fixed in 9159e249/);
  assert.match(close.how, /held until phase 3 has landed/);
  assert.deepEqual(close.actions.map((a) => a.verb), ['discard']);
});

test('every other state raises nothing — filed, discarded, duplicate, over-budget, failed, drafted', () => {
  const states = ['drafted', 'duplicate', 'filing', 'filed', 'commented', 'closed', 'discarded', 'over-budget', 'failed'];
  const { items } = buildInbox({
    issueDrafts: states.map((state, i) => ({ ...DRAFT, id: `${i}`.repeat(12), state })),
    flags: { allowPublish: true }, acks: {},
  }, NOW);
  assert.deepEqual(items, []);
});

test('a draft of a closed plan raises nothing, and an acked row hides', () => {
  const closed = buildInbox({ issueDrafts: [DRAFT], plans: [{ slug: 'demo', closed: true } as never], acks: {} }, NOW);
  assert.deepEqual(closed.items, []);
  const id = inboxItemId({ kind: 'issue-draft', slug: 'demo', phase: 3, runId: 'r1', subject: 'abcdefabcdef' });
  const acked = buildInbox({ issueDrafts: [DRAFT], acks: { [id]: { at: '2026-08-22T11:30:00.000Z' } } }, NOW);
  assert.deepEqual(acked.items, []);
});

/* ------------------------------------------------------------------ *
 * message — what a session said to the OPERATOR (phase 15, over phase 10's
 * `operator:` address, which was delivered to "the inbox" and rendered nowhere)
 * ------------------------------------------------------------------ */

const ASK = {
  id: 'aaaaaaaaaaaa', slug: 'demo', phase: 4, kind: 'ask', from: 'phase:demo/4', to: 'operator:',
  text: 'The plan names release/5.1 as the base but origin has no such branch — fork from main?',
  state: 'delivered', priority: 'normal', writtenAt: '2026-09-21T10:00:00.000Z', runId: 'r1',
};

test('an ask addressed to the operator is a needs-you row with Answer (a reply, with the text) and Mark seen (an ack)', () => {
  const { items } = buildInbox({ messages: [ASK], flags: { allowRun: true }, acks: {} }, NOW);
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.kind, 'message');
  assert.equal(row.severity, 'needs-you');
  assert.equal(row.id, inboxItemId({ kind: 'message', slug: 'demo', phase: 4, runId: 'r1', subject: 'aaaaaaaaaaaa' }));
  assert.match(row.title, /demo phase 4 asks you/);
  assert.match(row.need, /origin has no such branch/);
  assert.match(row.how, /Answer/);
  assert.equal(row.since, ASK.writtenAt);
  assert.equal(row.href, '#/plan/demo/phase/4');
  assert.deepEqual(row.actions.map((a) => [a.verb, a.method, a.endpoint]), [
    ['answer', 'POST', '/api/run/demo/messages/aaaaaaaaaaaa/reply'],
    ['seen', 'POST', '/api/run/demo/messages/aaaaaaaaaaaa/ack'],
  ]);
  // The reply goes back to the sender, and the words are the person's own.
  assert.deepEqual(row.actions[0].body, { to: 'phase:demo/4', phase: 4 });
  assert.deepEqual(row.actions[0].says, { field: 'text', label: 'Your answer', placeholder: 'What the session should know' });
  assert.equal(row.actions[0].flag, undefined, 'the run flag is on, so Answer is pressable');
  assert.equal(row.actions[1].says, undefined, 'an ack carries no words');
});

test('a NOTE to the operator is fyi with Mark seen alone; a high-priority ask is urgent', () => {
  const { items } = buildInbox({
    messages: [
      { ...ASK, id: 'bbbbbbbbbbbb', kind: 'note', text: 'Landed the schema; the wizard order is pinned.' },
      { ...ASK, id: 'cccccccccccc', priority: 'high' },
    ],
    flags: { allowRun: true }, acks: {},
  }, NOW);
  assert.equal(items.length, 2);
  const idOf = (subject: string) => inboxItemId({ kind: 'message', slug: 'demo', phase: 4, runId: 'r1', subject });
  const note = items.find((i) => i.id === idOf('bbbbbbbbbbbb'))!;
  const urgent = items.find((i) => i.id === idOf('cccccccccccc'))!;
  assert.equal(note.severity, 'fyi');
  assert.match(note.title, /demo phase 4 says/);
  assert.deepEqual(note.actions.map((a) => a.verb), ['seen']);
  assert.equal(urgent.severity, 'urgent');
});

test('without --allow-run the Answer action carries the flag and the row says so; Mark seen needs nothing', () => {
  const { items } = buildInbox({ messages: [ASK], flags: {}, acks: {} }, NOW);
  const [row] = items;
  assert.equal(row.actions[0].flag, 'run');
  assert.equal(row.actions[1].flag, undefined);
  assert.match(row.how, /--allow-run/);
});

test('a message that is acked, answered, expired or refused raises nothing, and one to a phase never does', () => {
  const { items } = buildInbox({
    messages: [
      { ...ASK, id: '111111111111', state: 'acked' },
      { ...ASK, id: '222222222222', state: 'expired' },
      { ...ASK, id: '333333333333', state: 'refused' },
      { ...ASK, id: '444444444444', to: 'phase:demo/5' },
      // Answered: a reply names it, so the ask is closed even though its own
      // state never moved.
      { ...ASK, id: '555555555555' },
      { ...ASK, id: '666666666666', kind: 'reply', from: 'operator:', to: 'phase:demo/4', replyTo: '555555555555', state: 'delivered' },
    ],
    flags: { allowRun: true }, acks: {},
  }, NOW);
  assert.deepEqual(items, []);
});

test('a message of a closed plan raises nothing, and an acked row hides', () => {
  const closed = buildInbox({ messages: [ASK], plans: [{ slug: 'demo', closed: true } as never], acks: {} }, NOW);
  assert.deepEqual(closed.items, []);
  const id = inboxItemId({ kind: 'message', slug: 'demo', phase: 4, runId: 'r1', subject: 'aaaaaaaaaaaa' });
  const acked = buildInbox({ messages: [ASK], acks: { [id]: { at: '2026-09-21T10:30:00.000Z' } } }, NOW);
  assert.deepEqual(acked.items, []);
});
