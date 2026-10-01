/**
 * A resume continues its phase (control-tower phase 46, #61).
 *
 * Every session that carried on a phase's work — a resume with an operator's or
 * a rung's instruction, a wait-resume — ran under `CLOSEOUT_MAX_TURNS` (60), the
 * cap sized for handoff paperwork. In the audit week 4 of the 5 `max_turns`
 * endings were such resumes, cut at 61 turns after 10 to 116 minutes of real
 * work, and two of them then halted `no-handoff`: the resume vehicle pre-stamped
 * `record.closeout`, so `closed()` believed a closeout had already been tried,
 * never read how the session ended, and called a spent cap (and, once, a
 * console shutdown 4.8 s in) "ended cleanly".
 *
 *   RC-1  a continuing session gets the phase's cap minus the turns already spent
 *         (the phase's MEASURED cap since control-tower phase 59 — the size tag
 *         no longer sets a cap);
 *   RC-2  never under `RESUME_MIN_TURNS`, measured from the week's resumes;
 *   RC-3  60 stays for paperwork only;
 *   RC-4  `docs/session-budget.md` and `capsFor` agree;
 *   RC-5  a spent cap on a resume resumes the same session with the cap raised;
 *   RC-6  a console shutdown settles `interrupted`, never `no-handoff`;
 *   RC-7  a closeout marker is written only by a closeout that ran;
 *   PT-2  the measured caps — the phase's row and the resume floor — read a
 *         session's largest PROMPT, never its summed turns (control-tower
 *         phase 89, #62's SIZ-7: `--max-turns` binds per prompt).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { loadSizing } from '../server/analysis/graph.ts';
import { sizingCensus } from '../server/analysis/sizing-model.ts';
import {
  CLOSEOUT_MAX_TURNS, REPAIR_MAX_TURNS, RESUME_MIN_TURNS, SHIPPED_CAP_TABLE, capsFor, phaseCaps, remainingTurns,
} from '../server/runner/session-record.ts';

/** The phase's turn cap under the shipped table: 490 (p99 322 + 50 %). */
const PHASE_TURNS = SHIPPED_CAP_TABLE.modes.phase!.turns!.value;
import type { SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';
import type { PhaseRecord, RunState } from '../server/runner/state.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, saveRun } = await import('../server/runner/state.ts');

/* ------------------------------------------------------------------ *
 * The caps, pure (RC-1..4)
 * ------------------------------------------------------------------ */

test('RC-1: a resume gets the phase\'s turn cap minus the turns the phase already spent — and the phase\'s whole dollars', () => {
  for (const spent of [20, 100, 212]) {
    const caps = capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: spent });
    assert.equal(caps.maxTurns.value, PHASE_TURNS - spent, `the cap minus ${spent}`);
    assert.equal(caps.maxTurns.source, 'remaining');
    assert.match(caps.maxTurns.basis ?? '', new RegExp(`phase ${PHASE_TURNS} − ${spent} spent`),
      'the arithmetic, in words, on the record');
  }
  assert.deepEqual(capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 212 }).maxBudgetUsd,
    phaseCaps().usd, 'the dollars and the turns are the phase\'s own caps, so neither is inert');
  assert.deepEqual(capsFor({ mode: 'resume', phaseBudgetUsd: 40, spentTurns: 212 }).maxBudgetUsd,
    { value: 40, source: 'run' });
  // No count at all is a phase that has spent nothing this console can see.
  assert.equal(capsFor({ mode: 'resume', phaseBudgetUsd: null }).maxTurns.value, PHASE_TURNS);
  assert.equal(remainingTurns(null, Number.NaN).value, PHASE_TURNS, 'an unreadable count is not a negative one');
  assert.equal(remainingTurns(null, -40).value, PHASE_TURNS);
});

test('RC-2: the remainder never goes under RESUME_MIN_TURNS — the audit week\'s p90 continuation plus headroom', () => {
  // 22 continuation stints (a resume, and whatever directly continued it after a
  // spent cap): p50 37, p90 83, p95 98, max 107 turns. The handoff records it.
  assert.equal(RESUME_MIN_TURNS, 120);
  assert.ok(RESUME_MIN_TURNS > 107, 'above the longest stint the week measured');
  assert.ok(RESUME_MIN_TURNS > CLOSEOUT_MAX_TURNS, 'and above the cap 4 of the 5 max_turns endings hit');
  const late = capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 400 });
  assert.deepEqual([late.maxTurns.value, late.maxTurns.source], [RESUME_MIN_TURNS, 'remaining']);
  assert.match(late.maxTurns.basis ?? '', /RESUME_MIN_TURNS/, 'a floored cap says so');
  assert.equal(capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 900 }).maxTurns.value, RESUME_MIN_TURNS,
    'a phase already past its whole cap still gets the floor, never zero');
  assert.ok(PHASE_TURNS >= RESUME_MIN_TURNS, 'the floor never exceeds a whole phase');
  assert.equal(remainingTurns(null, 212, 'a wait-resume').basis, `phase ${PHASE_TURNS} − 212 spent — a wait-resume`);
});

test('RC-3: 60 stays for paperwork and bounded reviews; a repair keeps 90; a fresh attempt is the phase\'s whole cap', () => {
  for (const mode of ['closeout', 'qa', 'landing', 'pr', 'review'] as const) {
    assert.deepEqual(capsFor({ mode, phaseBudgetUsd: null, spentTurns: 212 }).maxTurns,
      { value: CLOSEOUT_MAX_TURNS, source: 'closeout' }, mode);
  }
  assert.deepEqual(capsFor({ mode: 'repair', phaseBudgetUsd: null, spentTurns: 212 }).maxTurns,
    { value: REPAIR_MAX_TURNS, source: 'repair' });
  assert.deepEqual(capsFor({ mode: 'phase', phaseBudgetUsd: null, spentTurns: 212 }).maxTurns,
    phaseCaps().turns, 'a phase attempt is the phase itself');
  // A caller that decided a cap still wins — a closeout brief's, a raise.
  const brief = { value: CLOSEOUT_MAX_TURNS, source: 'closeout' as const, basis: 'a closeout brief' };
  assert.deepEqual(capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 212, turns: brief }).maxTurns, brief);
});

test('RC-4: docs/session-budget.md\'s tables and capsFor agree, row by row', () => {
  const doc = readFileSync(new URL('../../docs/session-budget.md', import.meta.url), 'utf8');
  // The measured caps: the phase's dollars and turns, and the resume floor (control-tower phase 59).
  const row = /^\| `phase` \| \$(\d+) \| (\d+) \|/m.exec(doc);
  assert.ok(row, 'the caps table has a `phase` row');
  assert.deepEqual([Number(row![1]), Number(row![2])], [phaseCaps().usd.value, phaseCaps().turns.value], 'phase');
  assert.doesNotMatch(doc, /^\| `[SML]` \| \$\d+ \| \d+ \|/m, 'no per-size caps row survives');
  // The per-session table: every mode is named once, with the cap capsFor gives it.
  const table = /\| Session \| Turn cap \|\n\|---\|---\|\n((?:\|.*\|\n)+)/.exec(doc);
  assert.ok(table, 'a "Session | Turn cap" table');
  const rows = table![1].trim().split('\n').map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const named = new Map<string, string>();
  for (const [modes, cap] of rows) for (const mode of modes.match(/`([a-z-]+)`/g) ?? []) named.set(mode.slice(1, -1), cap);
  const expect: Record<string, (cap: string) => void> = {
    phase: (cap) => assert.match(cap, /the phase's measured cap/),
    resume: (cap) => assert.match(cap, new RegExp(`the phase's cap minus the turns the phase already spent, never under ${RESUME_MIN_TURNS} \\(\`RESUME_MIN_TURNS\`\\)`)),
    repair: (cap) => assert.match(cap, new RegExp(`^${REPAIR_MAX_TURNS} \\(\`REPAIR_MAX_TURNS\`\\)`)),
    closeout: (cap) => assert.match(cap, new RegExp(`^${CLOSEOUT_MAX_TURNS} \\(\`CLOSEOUT_MAX_TURNS\`\\)`)),
  };
  const modeCap: Record<string, keyof typeof expect> = {
    phase: 'phase', resume: 'resume', 'wait-resume': 'resume', repair: 'repair',
    closeout: 'closeout', qa: 'closeout', landing: 'closeout', pr: 'closeout', review: 'closeout',
  };
  for (const [mode, kind] of Object.entries(modeCap)) {
    const cap = named.get(mode);
    assert.ok(cap, `the table names \`${mode}\``);
    expect[kind](cap!);
    // …and the code agrees with the words, for the modes capsFor decides by itself.
    if (mode === 'wait-resume') continue;
    const turns = capsFor({ mode: mode as 'phase', phaseBudgetUsd: null, spentTurns: 480 }).maxTurns.value;
    const want = kind === 'phase' ? PHASE_TURNS : kind === 'resume' ? RESUME_MIN_TURNS : kind === 'repair' ? REPAIR_MAX_TURNS : CLOSEOUT_MAX_TURNS;
    assert.equal(turns, want, `capsFor(${mode})`);
  }
  assert.doesNotMatch(doc, /A phase attempt\s+or a resume gets the whole row/,
    'the sentence that said a resume gets the whole row while the code gave it 60 is gone');
});

/* ------------------------------------------------------------------ *
 * PT-2 — calibration reads the largest prompt (control-tower phase 89, #62)
 * ------------------------------------------------------------------ */

test('PT-2: cap calibration reads the per-prompt maximum — a census of sessions with turns 338 and promptTurns 120 samples 120', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const shipped = loadSizing(join(SKILL_DIR, 'scripts'));
  // Sessions woken more than once: 338 turns in sum, and no one prompt past
  // 120 — the shape many-plans-one-repo P15 was, 338 "over" a 300 cap that
  // the CLI enforces per prompt.
  const lines = (mode: 'phase' | 'resume', data: Record<string, unknown> = {}) => Array.from({ length: 24 }, (_, i) => ({
    event: 'phase.session', phase: i + 1, time: new Date(now - i * 3_600_000).toISOString(),
    data: { mode, turns: 338, promptTurns: 120, costUsd: 5, costSource: 'result', resumed: mode === 'resume', ...data },
  }));
  const census = sizingCensus([{ slug: 'p', phases: {}, lines: [...lines('phase'), ...lines('resume')] }], () => undefined, shipped, now);

  // The phase's row — what a fresh attempt runs under.
  const row = census.caps.modes.phase!.turns!;
  assert.equal(row.derivation!.observed, 120, 'the p99 of the largest prompts, not of the sums');
  assert.equal(row.value, 180, '120 + 50 %, rounded up to ten — where the sums would have read 510');
  assert.equal(capsFor({ mode: 'phase', phaseBudgetUsd: null, table: census.caps }).maxTurns.value, 180);
  // The resume floor `remainingTurns` falls back to — the resumes' own measured cap, from the same figure.
  assert.equal(census.caps.modes.resume!.turns!.derivation!.observed, 120);
  assert.equal(remainingTurns(census.caps, 900).value, Math.max(RESUME_MIN_TURNS, 180));

  // A line written before the field carries only the sum, and that is still read.
  const old = sizingCensus([{ slug: 'p', phases: {}, lines: lines('phase', { promptTurns: undefined }) }], () => undefined, shipped, now);
  assert.equal(old.caps.modes.phase!.turns!.derivation!.observed, 338);
});

/* ------------------------------------------------------------------ *
 * The vehicle and `closed()` (RC-1, RC-5..7), through a real Runner
 * ------------------------------------------------------------------ */

type Harness = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

function executable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** One phase of size `size`, whose board reads `done` once the fake session "writes its handoff". */
function harness(size: 'S' | 'M' | 'L' = 'L'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-resume-caps-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  executable(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"
mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if [ -f "$S/done" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-mode) echo off ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of demo" ;;
  --size) echo ${size} ;;
  *) exit 0 ;;
esac
`);
  executable(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  executable(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(stub, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-work', costUsd: 0.5, turns: 4, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

type Events = { event: string; data: Record<string, unknown> }[];

function runnerFor(h: Harness, spawn: (request: SpawnRequest) => Promise<SpawnOutcome>) {
  const events: Events = [];
  const instance = new Runner({
    scriptsDir: h.scripts,
    spawn,
    verificationText: () => '`true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event, data) => events.push({ event, data }),
  } as never);
  return { instance, events };
}

const journalled = (events: Events, name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** A run halted on phase 1 after a session that did 212 turns of work and wrote nothing. */
function storedRun(h: Harness, record: Partial<PhaseRecord> = {}): RunState {
  const state = newRun({ slug: 'demo', root: h.root, model: 'opus' });
  state.status = 'halted';
  state.onlyPhases = [1];
  state.halt = { at: new Date().toISOString(), reason: 'no handoff was written', phase: 1, kind: 'no-handoff' } as never;
  state.phases['1'] = {
    phase: 1, status: 'failed', attempts: 1, costUsd: 9.96, turns: 212, sessionId: 'sess-work',
    ...record,
  } as PhaseRecord;
  saveRun(state);
  return state;
}

async function resumeWith(
  h: Harness, spawn: (request: SpawnRequest, n: number) => Promise<SpawnOutcome>, record: Partial<PhaseRecord> = {},
) {
  const requests: SpawnRequest[] = [];
  const { instance, events } = runnerFor(h, async (request) => {
    requests.push(request);
    return spawn(request, requests.length);
  });
  const state = storedRun(h, record);
  await instance.recover({
    slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'resume',
    instruction: 'Carry on from where you stopped.', by: 'test',
  } as never);
  await instance.wait();
  return { instance, events, requests, record: instance.current()!.phases['1'] };
}

test('RC-1: the resume vehicle spawns under the remainder — a phase that spent 212 turns resumes with 278, not 60', async () => {
  const h = harness('L');
  try {
    const { requests, record } = await resumeWith(h, async () => { h.markDone(); return ok(); });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].resume, 'sess-work', 'the phase\'s own conversation');
    assert.deepEqual(requests[0].caps?.maxTurns, { value: 278, source: 'remaining', basis: 'phase 490 − 212 spent' });
    assert.equal(requests[0].maxTurns, 278, 'and that is what reaches --max-turns');
    assert.equal(record.status, 'done');
  } finally { h.cleanup(); }
});

test('RC-1: a wait-resume boards under the remainder too — never the closeout\'s 60', async () => {
  const h = harness('M');
  try {
    const stale = newRun({ slug: 'demo', root: h.root, model: 'opus' });
    stale.status = 'paused';
    stale.stoppedBy = 'system';
    stale.onlyPhases = [1];
    stale.phases['1'] = {
      phase: 1, status: 'waiting', attempts: 1, costUsd: 3, turns: 100, waits: 1,
      sessionId: 'sess-w', resumeSessionId: 'sess-w',
      parkedUntil: new Date(Date.now() - 60_000).toISOString(),
      parkReason: 'the image build',
      declared: { status: 'waiting-external', reason: 'the image build', at: new Date(Date.now() - 3_600_000).toISOString() },
    } as PhaseRecord;
    saveRun(stale);
    const requests: SpawnRequest[] = [];
    const { instance, events } = runnerFor(h, async (request) => {
      requests.push(request);
      h.markDone();
      return ok({ sessionId: 'sess-w' });
    });
    await instance.start({ slug: 'demo', root: h.root, resumeRunId: stale.id, onlyPhases: [1] });
    await instance.wait();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].resume, 'sess-w');
    assert.deepEqual(requests[0].caps?.maxTurns, { value: 390, source: 'remaining', basis: 'phase 490 − 100 spent — a wait-resume' });
    assert.equal(journalled(events, 'phase.wait-resume')[0]?.capSource, 'remaining');
  } finally { h.cleanup(); }
});

test('RC-5: a resume that spends its turn cap is resumed again with the cap raised — never halted no-handoff', async () => {
  const h = harness('L');
  try {
    const { requests, events, record, instance } = await resumeWith(h, async (_request, n) => {
      if (n === 1) {
        return ok({
          signal: { subtype: 'error_max_turns', terminalReason: 'max_turns', isError: true, code: 1, text: '' },
          turns: 389, costUsd: 16.11, resultText: 'Reached the maximum number of turns',
        });
      }
      h.markDone();
      return ok({ turns: 37, costUsd: 21.53 });
    });
    assert.equal(requests.length, 2, 'the spent cap was raised and the same session resumed');
    assert.equal(requests[1].resume, 'sess-work');
    assert.equal(requests[1].caps?.maxTurns.source, 'raise');
    assert.equal(requests[1].caps?.maxTurns.value, 556, 'double the cap it spent');
    assert.match(requests[1].prompt, /turn cap/i, 'and it is told why it is back');
    assert.equal(record.status, 'done');
    assert.deepEqual(journalled(events, 'phase.resume').map((line) => [line.raise, line.maxTurns]), [['turns', 556]]);
    assert.equal(journalled(events, 'phase.halted').length, 0, 'no halt at all');
    assert.equal(instance.current()!.halt, null);
    assert.equal(instance.current()!.consecutiveFailures ?? 0, 0, 'a spent cap charges no streak');
  } finally { h.cleanup(); }
});

test('RC-6: a resume the console shut down settles interrupted — never no-handoff, never a streak charge, no closeout', async () => {
  const h = harness('L');
  try {
    let runnerRef: Record<string, unknown> | null = null;
    const requests: SpawnRequest[] = [];
    const { instance, events } = runnerFor(h, async (request) => {
      requests.push(request);
      // What `checkpointForShutdown` leaves behind: the flag, then the session
      // cut 4.8 s in, re-reporting the conversation's earlier total.
      runnerRef!.shuttingDown = true;
      return ok({
        signal: { subtype: 'error_during_execution', terminalReason: 'aborted_streaming', isError: true, code: 143, text: '' },
        endedBy: 'shutdown', endedReason: 'the console shut down', turns: 2, costUsd: 26.01, durationMs: 4_823,
        resultText: '',
      });
    });
    runnerRef = instance as never as Record<string, unknown>;
    const state = storedRun(h);
    await instance.recover({
      slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'resume',
      instruction: 'Carry on from where you stopped.', by: 'test',
    } as never);
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.equal(requests.length, 1, 'no closeout was spawned into a console that is going away');
    assert.equal(record.status, 'interrupted');
    assert.equal(record.resumeSessionId, 'sess-work', 'kept for the --resume after the restart');
    assert.match(record.note ?? '', /console/i);
    assert.notEqual(record.halt?.kind, 'no-handoff');
    assert.equal(journalled(events, 'phase.halted').filter((line) => line.kind === 'no-handoff').length, 0);
    assert.equal(instance.current()!.consecutiveFailures ?? 0, 0, 'nothing charged the streak');
    assert.equal(instance.current()!.stoppedBy, 'system');
    assert.equal(record.closeout, undefined, 'and no closeout marker for a closeout that never ran');
  } finally { h.cleanup(); }
});

test('RC-7: a resume writes no closeout marker — a clean ending with no handoff gets a REAL closeout', async () => {
  const h = harness('L');
  try {
    // Work on disk and no paperwork: the shape a closeout exists for.
    execFileSync('git', ['init', '-q'], { cwd: h.root });
    writeFileSync(join(h.root, 'half-finished.txt'), 'work in flight\n');
    const { requests, events, record } = await resumeWith(h, async (_request, n) => {
      if (n === 1) return ok({ resultText: 'stopped one step short of the handoff' });
      h.markDone();
      return ok({ costUsd: 0.9 });
    });
    assert.equal(requests.length, 2, 'the closeout session ran');
    assert.deepEqual(journalled(events, 'phase.session').map((line) => line.mode), ['resume', 'closeout']);
    assert.deepEqual(requests[1].caps?.maxTurns, { value: CLOSEOUT_MAX_TURNS, source: 'closeout' }, 'paperwork keeps 60');
    assert.ok(record.closeout, 'the marker is the closeout\'s own');
    assert.notEqual(record.closeout?.note, 'resumed with an operator instruction');
    assert.equal(record.status, 'done');
  } finally { h.cleanup(); }
});

test('RC-7: a resume that finishes its phase leaves no closeout marker at all', async () => {
  const h = harness('L');
  try {
    const { record } = await resumeWith(h, async () => { h.markDone(); return ok(); });
    assert.equal(record.status, 'done');
    assert.equal(record.closeout, undefined);
  } finally { h.cleanup(); }
});

test('RC-6: the no-handoff halt never says "ended cleanly" about a session that spent its cap', async () => {
  const h = harness('L');
  try {
    // Raise after raise, the session never writes a handoff: the bounded raise
    // runs out and the phase halts — in words that say what really happened.
    const { record, requests } = await resumeWith(h, async () => ok({
      signal: { subtype: 'error_max_turns', terminalReason: 'max_turns', isError: true, code: 1, text: '' },
      turns: 400, costUsd: 1,
    }));
    assert.ok(requests.length >= 2 && requests.length <= 4, `a bounded number of raises (${requests.length} sessions)`);
    assert.equal(record.status, 'failed');
    assert.doesNotMatch(record.halt?.reason ?? '', /ended cleanly/);
    assert.match(record.halt?.reason ?? '', /turn cap/);
  } finally { h.cleanup(); }
});
