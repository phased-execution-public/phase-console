/**
 * A session ends when its agents do (control-tower phase 109, #188).
 *
 * ai-builder-v7 P16 handed off `partial / context` while an async Agent it had
 * launched ("Knobs guide, quotas, bake-off, memory") still wrote the tree. The
 * Stop hook waved the exit through, the agent ran on for the CLI's ten-minute
 * ceiling and was killed mid-edit: 10 modified and 4 untracked files that no
 * commit and no handoff explained. Three of the run's seven phases met it.
 *
 *   BG-1  while a background agent or monitor the session launched still runs,
 *         a `partial` or `complete` exit — or a turn ending on a board that
 *         reads done — is refused through the Stop hook's refuse-twice channel,
 *         with the two ways out: wait in the foreground, bounded, or `TaskStop`
 *         it and record it under Outstanding; a turn that ends to WAIT on one
 *         is still let go, and so is a declared wait;
 *   BG-2  the 0.6× wrap-up notice names the live background agents and the same
 *         two choices;
 *   BG-3  one still killed after the handoff is named in the next boarding's
 *         brief: its description, its last words, and the paths written after
 *         the handoff.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { StreamEvent } from '../server/runner/spawn.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { backgroundExitRefusal, contextWrapupNotice } = await import('../server/runner/runner-core.ts');
const { applyEvent, awaitingBackground, newLaneSignals } = await import('../server/runner/liveness.ts');
const { outcomeFileFor } = await import('../server/runner/outcome.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null };

/** The stream a lane saw, folded through the real liveness reducer. */
function laneWith(events: StreamEvent[], at0 = Date.parse('2026-10-02T13:31:07Z')) {
  const signals = newLaneSignals(0);
  let at = at0;
  for (const event of events) applyEvent(signals, event, at++);
  return signals;
}

const started = (taskId: string, taskType: string, tool: string, description: string, toolUseId?: string): StreamEvent =>
  ({ kind: 'background', op: 'started', taskId, taskType, tool, description, ...(toolUseId ? { toolUseId } : {}) });

const AGENT = started('t-knobs', 'local_agent', 'Agent', 'Knobs guide, quotas, bake-off, memory', 'toolu_014Xv');

/** A service over one run on phase 16, whose board and lane the test writes. */
function serviceForStop(opts: { events: StreamEvent[]; board?: string; outcome?: string }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-bg-stop-')));
  TRASH.push(root);
  const service = new Service(flags as never);
  const state = {
    id: 'r188', slug: 'demo', root, activePhase: 16,
    phases: { 16: { phase: 16, sessionId: 'sess-92aa', startedAt: '2026-01-01T00:00:00Z' } },
  };
  const signals = laneWith(opts.events);
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    isSpending: () => false,
    busy: () => true,
    current: () => state,
    note: () => {},
    awaitingBackground: (phase: number) => (phase === 16 ? awaitingBackground(signals) : []),
  });
  (service as unknown as { root: unknown }).root = { ok: true, path: root };
  (service as unknown as { board: () => Promise<unknown> }).board = async () =>
    ({ phased: true, states: { 16: opts.board ?? 'in-progress' }, done: [], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {} });
  (service as unknown as { qaMode: () => Promise<unknown> }).qaMode = async () => ({ mode: 'off' });
  if (opts.outcome) {
    const file = outcomeFileFor(root, 'demo', 'r188', 16);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, slug: 'demo', phase: 16, status: opts.outcome, reason: 'context', written_at: new Date().toISOString(), session_id: 'sess-92aa' }));
  }
  return service;
}

type Decision = { hookSpecificOutput?: { decision?: string; reason?: string } };

/* ------------------------------------------------------------------ *
 * BG-1 — the Stop hook refuses an exit while the session's own agent runs
 * ------------------------------------------------------------------ */

test('BG-1: a `partial` declared while the session\'s own agent still runs is refused — twice, with the two ways out', async () => {
  const service = serviceForStop({ events: [AGENT], outcome: 'partial' });
  try {
    const first = await service.decideStop({ session_id: 'sess-92aa' }, 'r188') as Decision;
    assert.equal(first.hookSpecificOutput?.decision, 'block', 'the handoff waits for its agent');
    const reason = first.hookSpecificOutput!.reason!;
    assert.match(reason, /Phase 16 of demo cannot hand off yet: 1 background agent you launched is still running/);
    assert.match(reason, /"Knobs guide, quotas, bake-off, memory" \(Agent, task t-knobs, since 13:31Z/);
    assert.match(reason, /ten-minute ceiling, mid-edit/);
    assert.match(reason, /`TaskOutput` call with `block: true` and a timeout of at most 600000 ms/, 'await it in the foreground, bounded');
    assert.match(reason, /`TaskStop` \(t-knobs\)/, 'or stop it, by id');
    assert.match(reason, /\*\*Outstanding\*\*/, '…and record what it was doing');
    const second = await service.decideStop({ session_id: 'sess-92aa' }, 'r188') as Decision;
    assert.equal(second.hookSpecificOutput?.decision, 'block', 'refused a second time');
    assert.deepEqual(await service.decideStop({ session_id: 'sess-92aa' }, 'r188'), {}, 'and never a third: the hook carries workflow, not safety');
  } finally { service.close(); }
});

test('BG-1: `complete`, or a board that already reads done, is the same exit — refused while the agent runs', async () => {
  for (const shape of [{ outcome: 'complete' }, { board: 'done' }]) {
    const service = serviceForStop({ events: [AGENT], ...shape });
    try {
      const decision = await service.decideStop({ session_id: 'sess-92aa' }, 'r188') as Decision;
      assert.equal(decision.hookSpecificOutput?.decision, 'block', JSON.stringify(shape));
      assert.match(decision.hookSpecificOutput!.reason!, /cannot hand off yet/);
    } finally { service.close(); }
  }
});

test('BG-1: a monitor is an agent of the session too; a background SHELL is not — it died with the turn', async () => {
  const monitor = serviceForStop({ events: [started('m1', 'local_bash', 'Monitor', 'tail the deploy log')], outcome: 'partial' });
  try {
    const decision = await monitor.decideStop({ session_id: 'sess-92aa' }, 'r188') as Decision;
    assert.match(decision.hookSpecificOutput?.reason ?? '', /1 background monitor you launched is still running/);
  } finally { monitor.close(); }
  const shell = serviceForStop({ events: [started('b1', 'local_bash', 'Bash', 'npm test')], outcome: 'partial' });
  try {
    assert.deepEqual(await shell.decideStop({ session_id: 'sess-92aa' }, 'r188'), {}, 'a declared partial with only a shell behind it ends');
  } finally { shell.close(); }
});

test('BG-1: an exit with nothing running ends; a turn that ends to WAIT on its agent ends; a declared wait ends', async () => {
  const cases: { events: StreamEvent[]; outcome?: string; board?: string; why: string }[] = [
    { events: [], outcome: 'partial', why: 'nothing in the background' },
    { events: [AGENT, { kind: 'background', op: 'ended', taskId: 't-knobs', status: 'completed' } as StreamEvent], outcome: 'partial', why: 'the agent already reported' },
    { events: [AGENT], why: 'no outcome: the turn ends to wait, and the notification wakes it (rule 4)' },
    { events: [AGENT], outcome: 'waiting-external', why: 'a declared wait parks the phase — not a handoff of the work' },
  ];
  for (const one of cases) {
    const service = serviceForStop(one);
    try {
      assert.deepEqual(await service.decideStop({ session_id: 'sess-92aa' }, 'r188'), {}, one.why);
    } finally { service.close(); }
  }
});

/* ------------------------------------------------------------------ *
 * BG-2 — the wrap-up notice names the live agents
 * ------------------------------------------------------------------ */

test('BG-2: the 0.6× wrap-up notice names the session\'s live background agents and the same two choices', () => {
  const signals = laneWith([AGENT, started('t-roster', 'local_agent', 'Agent', 'Roster script')]);
  const now = Date.parse('2026-10-02T13:52:34Z');
  const notice = contextWrapupNotice(600_480, 1_000_000, 'bash phase-outcome.sh demo 16', {
    shared: true, fastGate: [], background: awaitingBackground(signals), now,
  });
  assert.match(notice, /You still have 2 background agents running: "Knobs guide, quotas, bake-off, memory" \(Agent, task t-knobs, since 13:31Z — 21 min\), "Roster script"/);
  assert.match(notice, /Before step 3, wait for each in ONE bounded foreground call \(`TaskOutput` with `block: true`, at most ten minutes\), or stop it with `TaskStop`/);
  assert.match(notice, /A handoff while one runs is refused/);
  assert.ok(notice.indexOf('You still have') < notice.indexOf('1. Finish the step'), 'said before the steps that end in a handoff');
  const quiet = contextWrapupNotice(600_480, 1_000_000, 'bash phase-outcome.sh demo 16', { shared: true, fastGate: [], background: [] });
  assert.doesNotMatch(quiet, /background/, 'a session with nothing in the background reads exactly as before');
  // One wording for one rule: the hook's refusal and the notice name the same agent the same way.
  assert.match(backgroundExitRefusal(16, 'demo', awaitingBackground(signals), now), /"Roster script" \(Agent, task t-roster/);
});

/* ------------------------------------------------------------------ *
 * BG-3 — a killed agent is named in the next boarding's brief
 * ------------------------------------------------------------------ */

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

test('BG-3: an agent still killed after the handoff is named to the next attempt — its description, its last words, the paths it wrote after', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-bg-brief-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'KnobsCard.tsx'), 'the base\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done\n');
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) if [ -f "${root}/.done" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  gitIn(root, ['init', '-q']);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'base']);

  const prompts: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  /** The 15-second retry pause, skipped: the test is about what the retry is told. */
  class Instant extends Runner {
    protected override sleep(): Promise<void> { return Promise.resolve(); }
  }
  const runner = new Instant({
    scriptsDir: scripts,
    spawn: async (req: { prompt: string; env?: Record<string, string>; onEvent?: (event: StreamEvent) => void }) => {
      prompts.push(req.prompt);
      if (prompts.length === 1) {
        // The session launches its agent, which talks; the session hands off…
        req.onEvent?.(AGENT);
        req.onEvent?.({ kind: 'subagent', text: 'Writing QuotasCard.tsx — the bake-off drawer is half wired', parent: 'toolu_014Xv' } as StreamEvent);
        const file = req.env!.PE_OUTCOME_FILE!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ version: 1, slug: 'demo', phase: 1, status: 'partial', reason: 'scope-cap', written_at: new Date().toISOString(), session_id: 'sess-p16' }));
        // …and the agent goes on writing after it, until the CLI's ceiling ends the process.
        await new Promise((done) => { setTimeout(done, 20); });
        writeFileSync(join(root, 'QuotasCard.tsx'), 'half a drawer\n');
        writeFileSync(join(root, 'KnobsCard.tsx'), 'the base, half rewritten\n');
        req.onEvent?.({ kind: 'background', op: 'ended', taskId: 't-knobs', status: 'process-exited' } as StreamEvent);
        return {
          signal: {
            subtype: 'success', code: 0, text: 'Background tasks still running after 600s; terminating.',
            backgroundTasks: [{ id: 't-knobs', description: 'Knobs guide, quotas, bake-off, memory', taskType: 'local_agent' }],
          },
          sessionId: 'sess-p16', costUsd: 0, turns: 3, resultText: 'handed off', durationMs: 1, argv: [],
        };
      }
      writeFileSync(join(root, '.done'), '1\n');
      return { signal: { subtype: 'success', code: 0, text: 'done' }, sessionId: 'sess-p16b', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
    },
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  await runner.start({ slug: 'demo', root, autonomy: 'keep-going' } as never);
  await runner.wait();

  const killed = events.filter((e) => e.event === 'run:journal' && e.data.event === 'phase.agents-killed')
    .map((e) => e.data.data as Record<string, unknown>);
  assert.equal(killed.length, 1, 'the kill is journalled once');
  assert.deepEqual(killed[0]!.paths, ['KnobsCard.tsx', 'QuotasCard.tsx'], 'the paths written after the handoff, by name');
  assert.ok(prompts.length >= 2, 'the phase boarded again');
  const brief = prompts[1]!;
  assert.match(brief, /WHAT THE CONSOLE KNOWS ABOUT THIS TREE/);
  assert.match(brief, /Your previous session's background subagent "Knobs guide, quotas, bake-off, memory" was still running when that session ended — after it handed off at/);
  assert.match(brief, /the CLI's ten-minute ceiling stopped it mid-work/);
  assert.match(brief, /Its last words: "Writing QuotasCard\.tsx — the bake-off drawer is half wired"/);
  assert.match(brief, /Paths written after that handoff and never committed — that agent's half-finished work, not the WIP the handoff describes: KnobsCard\.tsx, QuotasCard\.tsx/);
  assert.equal(runner.current()!.phases['1']!.agentsKilled, undefined, 'consumed by the brief that named it');
});
