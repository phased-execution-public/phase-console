/**
 * A declared block's watch resumes it (control-tower phase 87, #126).
 *
 * Measured on hub 4123 on 2026-09-25 (run 24fcba33): P50 and P41 each declared `blocked` with a
 * pollable watch on a sibling's handoff, and each was recorded `failed`. `failed` is watch-eligible,
 * so the clock went on probing the refs (4 and 3 runs), but a landing on a phase that is not parked
 * resumes nothing: `onWatchLanded` and `landWatch` both answered "nothing a landing could resume",
 * the healer stood down because the clock owned the phase, and only a person's Retry could bring
 * either back — with nothing on the card saying so. And a `done` landing was not even terminal: the
 * scheduler deleted only the row's `nextDueAt`, so `dueFor` offered the same landing every minute.
 *
 * BW-1  the landing of a declared block's ref resumes the phase in its lane, its own session told
 *       what landed
 * BW-2  a ref that lands while the phase already reads `failed` (a record from before this fix)
 *       raises ONE errand naming the landing and saying "press Retry", and is journalled
 * BW-3  a `done` landing is terminal on disk and never offered again
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { Runner } from '../server/runner/runner.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { newRun, saveRun, type PhaseRecord, type RunState } from '../server/runner/state.ts';
import { WatchScheduler, type WatchLandingOutcome } from '../server/watch-scheduler.ts';

type Line = { event: string; phase?: number; data: Record<string, unknown> };

function journal(root: string, state: RunState): Line[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** #126's watch: the sibling's handoff reaching `complete`. */
const SIBLING_REF = "cmd:grep -q '^status: complete' docs/handoffs/demo/phase-43-perf-ii-catalogs.md";

/* ------------------------------------------------------------------ *
 * BW-1 — the landing resumes the block in its lane
 * ------------------------------------------------------------------ */

function harness(phases: number[]): { root: string; scriptsDir: string; done: (phase: number) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-block-watch-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
S="${root}"
case "$2" in
  --memory-block)
    d=""; r=""
    for p in ${phases.join(' ')}; do if [ -f "$S/.done-$p" ]; then d="$d$p,"; else r="$r$p,"; fi; done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "; echo "ready: \${r%,}"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return {
    root, scriptsDir,
    done: (phase) => writeFileSync(join(root, `.done-${phase}`), ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type SpawnReq = { prompt?: string; name?: string; resume?: string; env?: Record<string, string> };

function phaseOf(req: SpawnReq): number {
  return Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1] ?? /\bp(\d+)\b/.exec(req.name ?? '')?.[1]);
}

const success = (sessionId: string) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

test('BW-1: the landing of a declared block\'s ref resumes the phase in its lane — its OWN session, told what landed', async () => {
  const h = harness([1, 2]);
  try {
    let releasePhase2: () => void = () => {};
    const phase2 = new Promise<void>((resolve) => { releasePhase2 = resolve; });
    const spawns: SpawnReq[] = [];
    let accepted: boolean | null = null;
    let runner!: Runner;
    runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => {
        spawns.push(req);
        const phase = phaseOf(req);
        if (phase === 1 && !req.resume) {
          writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
            version: 1, slug: 'demo', phase: 1, status: 'blocked', needs: 'external',
            reason: 'the only red is P43\'s WIP; unblock = P43 lands', watch: [SIBLING_REF],
            written_at: new Date().toISOString(), session_id: 'sid-1',
          }));
          return success('sid-1');
        }
        if (phase === 2) {
          // While phase 2 works, the sibling's handoff reaches `complete`: the
          // healer's write on the declaration, then the live lane's door.
          const state = runner.current()!;
          await new Promise((resolve) => setTimeout(resolve, 50));
          state.phases['1'].declared!.landed = { ref: SIBLING_REF, detail: 'exit 0', at: new Date().toISOString(), resumes: 1 };
          accepted = runner.landWatch(1, { ref: SIBLING_REF, detail: 'exit 0' }, { count: 1, sessionId: 'sid-1' });
          await phase2;
        }
        h.done(phase);
        return success(`sid-${phase}`);
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 } as never);
    setTimeout(() => releasePhase2(), 200);
    await runner.wait();

    assert.equal(accepted, true, 'the live lane accepts the landing on a parked block');
    const resumed = spawns.find((s) => phaseOf(s) === 1 && s.resume);
    assert.ok(resumed, 'phase 1 was resumed');
    assert.equal(resumed!.resume, 'sid-1', 'its OWN session');
    assert.match(resumed!.prompt ?? '', /LANDED/, 'told what landed');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.consecutiveFailures, 0);
    const lines = journal(h.root, state);
    assert.ok(lines.some((l) => l.event === 'phase.resume-automatic' && l.phase === 1 && l.data.path === 'live-lane'));
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * BW-2 — a landing on a phase already `failed`
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-26
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | catalogs | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — catalogs
- **Size:** S
`;

/** P41's disk shape on a LIVE run: `failed` over a declared block whose watch still stands. */
function failedBlockRun(root: string): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'running';
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  state.phases['2'] = {
    phase: 2, status: 'failed', attempts: 1, sessionId: 'sid-41',
    note: 'the only red is P43\'s WIP',
    declared: { status: 'blocked', reason: 'the only red is P43\'s WIP', watch: [SIBLING_REF], needs: 'external', at },
    watch: [SIBLING_REF],
    halt: { at, reason: 'phase 2 declared itself blocked', phase: 2, kind: 'phase-blocked' },
  } as PhaseRecord;
  saveRun(state);
  return state;
}

test('BW-2: a ref that lands on a phase already `failed` raises ONE errand naming the landing and "press Retry" — never a silent retire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-block-watch-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  try {
    assert.equal(svc.open(root).ok, true);
    const live = failedBlockRun(root);
    // The run's loop is live and holds the record — the case #126 measured.
    (svc as unknown as { liveRunner: (slug: string) => unknown }).liveRunner = (slug: string) => (slug === 'alpha'
      ? { current: () => live, landingPending: () => false, landWatch: () => false }
      : undefined);
    const land = (): Promise<WatchLandingOutcome> => (svc as unknown as {
      onWatchLanded: (slug: string, st: RunState, phase: number, l: unknown) => Promise<WatchLandingOutcome>;
    }).onWatchLanded('alpha', live, 2, { ref: SIBLING_REF, state: 'landed', detail: 'exit 0' });

    assert.equal(await land(), 'done', 'nothing in this run resumes a failed phase by itself');
    const errand = live.recoveries?.['2']?.errand;
    assert.ok(errand, 'the landing became an errand');
    assert.match(errand!.need, /phase 2/);
    assert.ok(errand!.need.includes(SIBLING_REF), 'naming the ref that landed');
    assert.match(`${errand!.need} ${errand!.how}`, /press Retry/i);
    assert.equal(live.phases['2'].watchLandedErrandFor, SIBLING_REF);

    assert.equal(await land(), 'done');
    const lines = journal(root, live);
    assert.equal(lines.filter((l) => l.event === 'phase.errand' && l.phase === 2).length, 1, 'one errand per declaration, however often it is offered');
    const landedLine = lines.find((l) => l.event === 'phase.watch-landed' && l.phase === 2);
    assert.ok(landedLine, 'the landing retired unresumed is journalled');
    assert.equal(landedLine!.data.resumed, false);
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * BW-3 — a `done` landing is terminal on disk
 * ------------------------------------------------------------------ */

test('BW-3: a `done` landing is terminal ON DISK — the scheduler never offers it again', async () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/whatever' });
  state.phases['2'] = {
    phase: 2, status: 'failed', attempts: 1,
    declared: { status: 'blocked', reason: 'P43\'s WIP', watch: [SIBLING_REF], at: new Date().toISOString() },
  } as PhaseRecord;
  let offers = 0;
  const saved: string[] = [];
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t: { ref: string }) => ({ ref: t.ref, state: 'landed' as const, detail: 'exit 0' }),
    onLanded: async () => { offers += 1; return 'done' as const; },
    save: (_slug: string, st: RunState) => { saved.push(JSON.stringify(st.phases['2'])); },
  } as never);
  try {
    scheduler.open();
    await scheduler.tick();
    assert.equal(offers, 1, 'offered once');
    assert.ok(saved.length > 0, 'and the retirement was saved');
    const onDisk = JSON.parse(saved[saved.length - 1]) as PhaseRecord;
    assert.deepEqual(onDisk.watchLandedDone, [SIBLING_REF], 'the answer is on the record, not in a deleted clock');
    // A minute later — and every minute after, which is what #126 measured.
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(offers, 1, 'never offered again');
  } finally { scheduler.close(); }
});
