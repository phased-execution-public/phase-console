/**
 * A live run reads its held gates again, and admits nothing ahead of its own
 * dependency (one-pool phase 23).
 *
 *   #239  phases 24–26 of a sweep were gated `plan ai-builder-v7:22`; that
 *         plan's phase 22 verified at 17:07, and the sweep — `running`, lanes
 *         free — kept them `gated` until a person retried each one at 17:58. A
 *         `gated` record is settled, so the drive loop never asked the gate
 *         again, and the docs change that opened it was another plan's.
 *   #288  control-tower phase 65's handoff read `blocked`; an amendment gave it
 *         a new dependency, phase 150, ready and not done. The board put 65 in
 *         `stuck` and the run admitted it ahead of 150.
 *
 *   GR-1  a gated phase is boarded while its sibling's lane still runs, once
 *         another plan's docs change opens its gate (`phase.gate-cleared`,
 *         `by: docs-change`) — and not while the gate stays closed.
 *   GR-2  the same gate opened with NO docs change is found by the drive
 *         tick's own re-read clock (`GATE_REREAD_MS`).
 *   GR-3  a stuck phase with a person's hint and an unmet dependency is not
 *         admitted (`phase.dependency-held`); its dependency boards first,
 *         and the stuck phase boards the moment the dependency is done.
 *   #416  a phase appended to a live plan read its GATED graph row before its
 *         section existed: `ai` with an empty detail, queued, and about to
 *         board a release the plan reserved for its owner.
 *   GR-4  (measured-console phase 30) a queued phase whose plan file changes
 *         under it reads its gate again — `phase.gate-reread` — and a gate
 *         that now reads manual holds it `gated`; it never boards.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { GATE_REREAD_MS } = await import('../server/runner/runner-loop.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });


/** A scratch root whose `phase-graph.sh` reads `.board` and `.gate` (present = clear). */
function scratch(boardLines: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-gr-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'sweep.md'), '# sweep\n');
  writeFileSync(join(root, '.board'), boardLines.join('\n') + '\n');
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) cat "${root}/.board" ;;
  --gate-status)
    if [ "$3" = 1 ] && [ ! -f "${root}/.gate" ]; then echo "blocked: other phase(s) 22 not verified"; exit 1; fi
    echo "clear (no gate)" ;;
  --gate-kind) echo auto ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { root, scripts, board: (lines: string[]) => writeFileSync(join(root, '.board'), lines.join('\n') + '\n') };
}

type Events = { event: string; data: Record<string, unknown> }[];
const journalled = (events: Events, name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number }));

const ok = (phase: number) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: `sid-${phase}`, costUsd: 0, turns: 1,
  resultText: 'done', durationMs: 1, argv: [],
});

/**
 * Phase 1 is gated behind another plan; phase 2 is ready on a disjoint scope
 * and its session runs until `release()` — the lane that keeps the run live.
 */
async function gatedRun(opts: { openGate: (root: string, runner: InstanceType<typeof Runner>) => void; holdMs?: number }) {
  const { root, scripts, board } = scratch(['done: ', 'in-progress: ', 'stuck: ', 'ready: 1, 2', 'waiting: ']);
  const done: number[] = [];
  const spawned: { phase: number; whileTwoRan: boolean }[] = [];
  const events: Events = [];
  let twoRunning = false;
  let startedWhileTwoRan: boolean | null = null;
  let releaseTwo: () => void = () => {};
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  let runner!: InstanceType<typeof Runner>;
  const spawn = async (req: { prompt: string }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push({ phase, whileTwoRan: twoRunning });
    if (phase === 2) {
      twoRunning = true;
      setImmediate(() => opts.openGate(root, runner));
      await new Promise<void>((resolve) => { releaseTwo = resolve; setTimeout(resolve, opts.holdMs ?? 8_000); });
      twoRunning = false;
    }
    done.push(phase);
    const open = [1, 2].filter((p) => !done.includes(p));
    board([`done: ${done.join(', ')}`, 'in-progress: ', 'stuck: ', `ready: ${open.join(', ')}`, 'waiting: ']);
    return ok(phase);
  };
  runner = new Runner({
    scriptsDir: scripts, spawn, scheduler,
    phaseScope: (_slug: string, phase: number) => [phase === 1 ? 'a' : 'b'],
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
      if (event === 'run:journal' && data.event === 'phase.start' && data.phase === 1) {
        // Read at phase 1's START, before the release below lets phase 2 end.
        startedWhileTwoRan = twoRunning;
        releaseTwo();
      }
    },
  } as never);
  const stored: RunState = newRun({ slug: 'sweep', root, autonomy: 'keep-going', autoRecover: true } as never);
  stored.status = 'parked';
  saveRun(stored);
  try {
    await runner.start({ slug: 'sweep', root, resumeRunId: stored.id, maxParallel: 2 } as never);
    await runner.wait();
  } finally {
    scheduler.close();
    runner.stop?.();
  }
  for (const s of spawned) if (s.phase === 1) s.whileTwoRan = startedWhileTwoRan === true;
  return { spawned, events, state: runner.current()! };
}

test('GR-1 (#239): another plan\'s docs change opens the gate and the held phase boards beside the live lane', async () => {
  const { spawned, events } = await gatedRun({
    openGate: (root, runner) => { writeFileSync(join(root, '.gate'), 'open\n'); runner.noteForeignDocs(); },
  });
  const one = spawned.find((s) => s.phase === 1);
  assert.ok(one, `phase 1 boarded: ${JSON.stringify(spawned)}`);
  assert.equal(one!.whileTwoRan, true, 'while phase 2 still held its lane — not after the run drained');
  const gated = journalled(events, 'phase.gated').filter((l) => l.phase === 1);
  assert.equal(gated.length, 1, 'held once by its closed gate');
  const cleared = journalled(events, 'phase.gate-cleared');
  assert.equal(cleared.length, 1, `cleared once: ${JSON.stringify(cleared)}`);
  assert.equal(cleared[0]!.phase, 1);
  assert.equal(cleared[0]!.by, 'docs-change');
});

test('GR-2 (#239): with no docs change at all the drive tick\'s own clock finds the open gate', { timeout: 150_000 }, async () => {
  assert.equal(GATE_REREAD_MS, 60_000, 'a minute between reads of one held gate');
  const t0 = Date.now();
  const { spawned, events } = await gatedRun({
    openGate: (root) => { writeFileSync(join(root, '.gate'), 'open\n'); },
    holdMs: 120_000,
  });
  const one = spawned.find((s) => s.phase === 1);
  assert.ok(one, `phase 1 boarded: ${JSON.stringify(spawned)}`);
  assert.equal(one!.whileTwoRan, true, 'while phase 2 still held its lane — the re-read clock, not the lane ending');
  const cleared = journalled(events, 'phase.gate-cleared');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.by, 'reread');
  assert.ok(Date.now() - t0 < GATE_REREAD_MS + 30_000, `within one re-read period (${Date.now() - t0} ms)`);
});

async function stuckAhead(by: string) {
  const { root, scripts, board } = scratch([
    'done: ', 'in-progress: ', 'stuck: 65', 'ready: 150', 'waiting: ', 'blocked: 65<-150(not-done)',
  ]);
  const spawned: number[] = [];
  const events: Events = [];
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const spawn = async (req: { prompt: string }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push(phase);
    if (phase === 150) board(['done: 150', 'in-progress: ', 'stuck: 65', 'ready: ', 'waiting: ']);
    else board(['done: 65' + (spawned.includes(150) ? ', 150' : ''), 'in-progress: ', 'stuck: ', `ready: ${spawned.includes(150) ? '' : '150'}`, 'waiting: ']);
    return ok(phase);
  };
  const runner = new Runner({
    scriptsDir: scripts, spawn, scheduler,
    phaseScope: () => ['all'],
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  const stored: RunState = newRun({ slug: 'sweep', root, autonomy: 'keep-going', autoRecover: true } as never);
  stored.status = 'parked';
  // The #288 shape: a hint an hour old on the blocked phase, which seniority
  // boards ahead of a phase that never waited.
  Object.assign(phaseRecord(stored, 65), {
    status: 'pending', attempts: 1,
    boardingHint: { situation: 'blocked-declared', rung: 'reboard-fresh', brief: 'fresh', at: new Date(Date.now() - 3_600_000).toISOString(), by },
  });
  saveRun(stored);
  try {
    await runner.start({ slug: 'sweep', root, resumeRunId: stored.id, maxParallel: 2 } as never);
    await runner.wait();
  } finally {
    scheduler.close();
    runner.stop?.();
  }
  return { spawned, events };
}

test('GR-3 (#288): a stuck phase ahead of its own unmet dependency is not admitted — the dependency boards first', async () => {
  const { spawned, events } = await stuckAhead('console');
  assert.equal(spawned[0], 150, `the dependency boarded first: ${JSON.stringify(spawned)}`);
  assert.ok(spawned.includes(65), 'and the held phase boarded once it was done');
  const refused = journalled(events, 'phase.dependency-held');
  assert.equal(refused.length, 1, `held once: ${JSON.stringify(refused)}`);
  assert.equal(refused[0]!.phase, 65);
  assert.equal(refused[0]!.reason, 'dependency');
  assert.deepEqual(refused[0]!.unmet, [150]);
  assert.equal(refused[0]!.board, 'stuck');
});

test('GR-3b: a PERSON\'s re-board of that phase is a person\'s word — it boards, and nothing is held', async () => {
  const { PERSON_SLOT_BY } = await import('../shared/ladder-model.js');
  const { spawned, events } = await stuckAhead(PERSON_SLOT_BY);
  assert.equal(spawned[0], 65, `the person's Retry boards the phase they named: ${JSON.stringify(spawned)}`);
  assert.equal(journalled(events, 'phase.dependency-held').length, 0);
});

test('GR-4 (#416): a queued phase whose plan changed under it reads its gate again and never boards on the old read', async () => {
  const { root, scripts } = scratch(['done: ', 'in-progress: ', 'stuck: ', 'ready: 1, 2', 'waiting: ']);
  // Phase 2's gate: `ai:` with no detail (the #416 read) until the plan is
  // amended, then the owner's manual gate the section always meant.
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) cat "${root}/.board" ;;
  --gate-status)
    if [ "$3" = 2 ]; then
      if [ -f "${root}/.amended" ]; then echo "manual: the owner approves Release A.1 on the Gate card"; else echo "ai:"; fi
      exit 1
    fi
    echo "clear (no gate)" ;;
  --gate-kind) if [ "$3" = 2 ] && [ -f "${root}/.amended" ]; then echo human; else echo ai; fi ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  const spawned: number[] = [];
  const events: Events = [];
  // One lane on the console: phase 2 queues behind phase 1's session.
  const scheduler = new Scheduler({ max: 1, locks: () => [] });
  let runner!: InstanceType<typeof Runner>;
  const spawn = async (req: { prompt: string }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push(phase);
    if (phase === 1) {
      // The plan is amended while phase 2 waits for the lane.
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(join(root, '.amended'), 'yes\n');
      runner.notePlanChanged();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      writeFileSync(join(root, '.board'), ['done: 1', 'in-progress: ', 'stuck: ', 'ready: 2', 'waiting: '].join('\n') + '\n');
    }
    return ok(phase);
  };
  runner = new Runner({
    scriptsDir: scripts, spawn, scheduler,
    phaseScope: (_slug: string, phase: number) => [phase === 1 ? 'a' : 'b'],
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  const stored: RunState = newRun({ slug: 'sweep', root, autonomy: 'keep-going', autoRecover: true } as never);
  stored.status = 'parked';
  saveRun(stored);
  try {
    await runner.start({ slug: 'sweep', root, resumeRunId: stored.id, maxParallel: 2 } as never);
    await runner.wait();
  } finally {
    scheduler.close();
    runner.stop?.();
  }
  assert.deepEqual(spawned, [1], `phase 2 never boarded on the old plan's gate: ${JSON.stringify(spawned)}`);
  const reread = journalled(events, 'phase.gate-reread').filter((l) => l.phase === 2);
  assert.ok(reread.length >= 1, `the gate was read again after the plan changed: ${JSON.stringify(reread)}`);
  const record = runner.current()!.phases['2']!;
  assert.equal(record.status, 'gated', 'held by the gate the plan now states');
  assert.equal(record.gate?.kind, 'manual', `its true kind on the record /api/runs reads: ${JSON.stringify(record.gate)}`);
  assert.match(record.gate?.detail ?? '', /owner approves/);
});
