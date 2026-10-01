/**
 * A phase can wait on its OWN red §Verification lines going green — `verify:<slug>/<N>`
 * (control-tower phase 88, #129's 2026-09-25 11:55:44Z comment).
 *
 * P41 declared a wait on P43's handoff reading `complete`, and a private clone showed it needed
 * THREE siblings' reds cleared (P43's WIP, P50's ratchet, P57's bundle budget). A `phase:` ref on
 * P43 would have landed and re-boarded P41 into two remaining reds. What P41 was really waiting for
 * is its own §Verification passing, and only re-running it can say so.
 *
 * VW-1  the declaring phase's red lines are re-run when the branch head MOVES — never on an
 *       unchanged head — and the ref lands only when every one passes
 * VW-2  the red lines are the console's own verdict, else the session's red proofs, else the
 *       phase's whole §Verification; a verify: ref names the declaring phase itself
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PhaseRecord, RunState } from '../server/runner/state.ts';
import { VerifyWatch, redLinesOf } from '../server/verify-watch.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { parseWatchRef, WATCH_SCHEMES } from '../server/watch-refs.ts';

const REF = 'verify:demo/41';
const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const H2 = 'c'.repeat(40);

const redRecord = (): PhaseRecord => ({
  phase: 41, status: 'waiting',
  verification: {
    ok: false, reason: 'red', notRun: [],
    ran: [
      { command: 'npm run lint', ok: true, code: 0, ms: 5, output: '' },
      { command: 'npm test', ok: false, code: 1, ms: 9, output: 'not ok 3', tree: { repo: '.', branch: 'pe/demo', head: H0 } },
    ],
  },
} as unknown as PhaseRecord);

test('VW-1: the red lines re-run only when the branch head moves, and the ref lands only when they pass', async () => {
  assert.ok((WATCH_SCHEMES as readonly string[]).includes('verify'));
  const target = parseWatchRef(REF)!;
  assert.deepEqual(target, { kind: 'verify', slug: 'demo', phase: 41, ref: REF });

  let head = H0;
  let green = false;
  const ran: { command: string; cwd: string; head: string }[] = [];
  const watch = new VerifyWatch({
    lookup: () => ({ record: redRecord(), cwd: '/work/tree' }),
    head: async () => head,
    run: async (command, cwd) => { ran.push({ command, cwd, head }); return green ? { ok: true, detail: 'exit 0' } : { ok: false, detail: 'exit 1 — not ok 3' }; },
  });

  const first = await watch.probe(target);
  assert.equal(first.state, 'pending');
  assert.match(first.detail ?? '', /head .*moves/i, 'waiting for the head to move off the red one');
  assert.equal(ran.length, 0, 'an unchanged head runs nothing');

  head = H1;
  const kicked = await watch.probe(target);
  assert.equal(kicked.state, 'pending');
  assert.match(kicked.detail ?? '', /re-running 1 red line/);
  await watch.settled();
  assert.deepEqual(ran.map((r) => r.command), ['npm test'], 'only the red line, never the green one');
  assert.equal(ran[0].cwd, '/work/tree');
  const still = await watch.probe(target);
  assert.equal(still.state, 'pending');
  assert.match(still.detail ?? '', /still red at bbbbbbbb/);
  await watch.probe(target);
  await watch.settled();
  assert.equal(ran.length, 1, 'the same head is not re-run');

  head = H2; green = true;
  await watch.probe(target);
  await watch.settled();
  const landed = await watch.probe(target);
  assert.equal(landed.state, 'landed');
  assert.match(landed.detail ?? '', /green at cccccccc/);
});

test('VW-2: the red lines — the console\'s verdict, else the session\'s red proofs, else the whole §Verification', () => {
  const fromConsole = redLinesOf(redRecord());
  assert.deepEqual(fromConsole, { lines: ['npm test'], from: 'console', head: H0 });

  const proofs = new Map([
    ['npm test', { command: 'npm test', code: 1, tree: 'd'.repeat(40), head: H1, at: '2026-09-25T11:50:00Z' }],
    ['npm run lint', { command: 'npm run lint', code: 0, tree: 'd'.repeat(40), at: '2026-09-25T11:50:00Z' }],
  ]);
  const bare = { phase: 41, status: 'waiting' } as PhaseRecord;
  assert.deepEqual(redLinesOf(bare, proofs), { lines: ['npm test'], from: 'session', head: H1 });
  assert.deepEqual(redLinesOf(bare, new Map(), ['npm run lint', 'npm test']), { lines: ['npm run lint', 'npm test'], from: 'plan', head: null });
  assert.deepEqual(redLinesOf(bare), { lines: [], from: 'none', head: null });
});

test('VW-2: a verify: ref names the DECLARING phase — another phase\'s is refused, and the scheduler asks the verify oracle', async () => {
  const run = {
    id: 'r1', slug: 'demo', status: 'running',
    phases: {
      '41': {
        phase: 41, status: 'waiting',
        declared: { status: 'blocked', needs: 'external', watch: [REF, 'verify:demo/43'], at: '2026-09-27T09:59:00Z', parked: 'poll-park' },
      } as unknown as PhaseRecord,
    },
  } as unknown as RunState;
  const asked: string[] = [];
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    verifyProbe: async (target) => { asked.push(target.ref); return { ref: target.ref, state: 'pending', detail: 'waiting for the branch head to move' }; },
    onLanded: () => 'deferred',
  });
  scheduler.open();
  await scheduler.tick();
  const rows = run.phases['41'].watchState!.refs;
  assert.equal(rows.find((r) => r.ref === REF)?.state, 'pending');
  assert.equal(rows.find((r) => r.ref === 'verify:demo/43')?.state, 'refused', 'another phase\'s red lines are not this phase\'s wait');
  assert.deepEqual(asked, [REF]);
  scheduler.close();
});
