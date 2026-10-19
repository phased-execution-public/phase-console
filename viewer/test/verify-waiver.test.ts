/**
 * An operator's waiver of ONE §Verification line, mid-run (one-pool phase 21,
 * #267).
 *
 * ai-builder-v8 P34's work was done and lines 1–10 green; line 11 went red
 * after the baseline on a contract window another plan's merge opened. The
 * owner waived it in chat, the session recorded a ruling — and the console's
 * verification re-ran line 11 for eighty minutes and failed on it, because
 * `verifyApprovalsFor` read only the start door's answers.
 *
 *   VW-1  `extractCommands` sets aside a RUNNABLE line whose fingerprint is
 *         waived — named under `waived`, never run;
 *   VW-2  the door: `waiveVerifyLine` records the waiver on the run, a
 *         `deviation` ruling on the plan's ledger naming who and why, and
 *         `phase.verify-waived {by}` in the run's journal; a line the phase
 *         does not have, or no reason, is refused;
 *   VW-3  the verifier honours it: a line red after the baseline fails the
 *         phase without a waiver, and with one the phase goes done, the line
 *         listed waived and `phase.verify-waived {by: operator}` journalled;
 *   VW-4  the route is an authority press, and the surface names its door.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { commandFingerprint, extractCommands } = await import('../server/runner/verify.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { readRulings, rulingsFile } = await import('../server/runner/rulings.ts');
const { AUTHORITY_ROUTES } = await import('../shared/door-model.js');
type RunState = import('../server/runner/state.ts').RunState;

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const GREEN = 'test -n green';
const CONTRACT = 'test ! -e contract-window';

test('VW-1: a waived RUNNABLE line is set aside, named, never run', () => {
  const text = `- \`${GREEN}\`\n- \`${CONTRACT}\``;
  const plain = extractCommands(text, 'verify');
  assert.deepEqual(plain.commands, [GREEN, CONTRACT]);
  const waived = extractCommands(text, 'verify', { waive: new Set([commandFingerprint(CONTRACT)]) });
  assert.deepEqual(waived.commands, [GREEN]);
  assert.equal(waived.waived.length, 1);
  assert.equal(waived.waived[0]!.code, 'waived');
  assert.equal(waived.waived[0]!.fp, commandFingerprint(CONTRACT));
});

const PLAN = `---
slug: alpha
created: 2026-10-18
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | release | — | — | app | it ships |

## Phases

### Phase 1 — release
- **Size:** S
- **Verification:**
  - \`${GREEN}\`
  - \`${CONTRACT}\`
`;

test('VW-2: the door records the waiver on the run, a ruling on the ledger and a journal line — and refuses what is not a line', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vw2-')));
  TRASH.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  Object.assign(phaseRecord(state, 1), { status: 'parked', note: 'line 11 is red on a contract window' });
  saveRun(state);
  const actor = { by: 'owner@desk', door: 'operator' } as never;

  const none = await svc.waiveVerifyLine('alpha', 1, CONTRACT, '   ', actor);
  assert.equal(none.ok, false);
  assert.equal((none as { status: number }).status, 400, 'a waiver says why');
  const stray = await svc.waiveVerifyLine('alpha', 1, 'npm run something-else', 'not ours', actor);
  assert.equal(stray.ok, false);
  assert.equal((stray as { status: number }).status, 404, 'only a line of the phase');

  const stale = await svc.waiveVerifyLine('alpha', 1, CONTRACT, 'from an old page', actor, 'run-that-moved-on');
  assert.equal(stale.ok, false);
  assert.equal((stale as { status: number }).status, 409, 'a press bound to another run waives nothing');
  assert.equal(loadRun(root, 'alpha', state.id)!.verifyWaivers, undefined);

  const answer = await svc.waiveVerifyLine('alpha', 1, CONTRACT, 'another plan\'s merge opened the contract window', actor, state.id);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const stored = loadRun(root, 'alpha', state.id)!;
  assert.equal(stored.verifyWaivers?.length, 1);
  assert.equal(stored.verifyWaivers![0]!.fp, commandFingerprint(CONTRACT));
  assert.equal(stored.verifyWaivers![0]!.by, 'owner@desk');
  const rulings = readRulings(rulingsFile(root, 'alpha'));
  const ruling = rulings.find((one) => one.id === stored.verifyWaivers![0]!.rulingId);
  assert.ok(ruling, 'the waiver is a ruling on the plan\'s ledger');
  assert.equal(ruling!.kind, 'deviation');
  assert.match(ruling!.what, /waived the §Verification line/);
  assert.equal(ruling!.why, 'another plan\'s merge opened the contract window');
  const journal = readFileSync(journalFile(root, 'alpha', state.id), 'utf8');
  assert.match(journal, /"event":"phase\.verify-waived"[^\n]*"by":"owner@desk"/);

  // A second waiver of the same line replaces the first, never doubles it.
  await svc.waiveVerifyLine('alpha', 1, CONTRACT, 'still the window', actor);
  assert.equal(loadRun(root, 'alpha', state.id)!.verifyWaivers?.length, 1);
});

/** One phase whose session makes `CONTRACT` red after its baseline, then hands off complete. */
async function verifyRace(opts: { waive: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vw3-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.board\ncontract-window\n');
  const board = (done: boolean) => writeFileSync(join(root, '.board'),
    `done: ${done ? '1' : ''}\nin-progress: \nstuck: \nready: ${done ? '' : '1'}\nwaiting: \n`);
  board(false);
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) cat "${root}/.board" ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo S ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const spawn = async (req: { prompt: string; env?: Record<string, string> }) => {
    // Something outside the phase opens the contract window after its baseline.
    writeFileSync(join(root, 'contract-window'), 'open\n');
    const file = req.env?.PE_OUTCOME_FILE;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, slug: 'demo', phase: 1, status: 'complete', written_at: new Date().toISOString(), session_id: 'sid-1' }));
    }
    board(true);
    return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
  };
  const scheduler = new Scheduler({ max: 2, locks: () => [] });
  const runner = new Runner({
    scriptsDir: scripts,
    spawn,
    scheduler,
    phaseScope: () => ['app'],
    verificationText: () => `- \`${GREEN}\`\n- \`${CONTRACT}\``,
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  const stored: RunState = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
  stored.status = 'parked';
  if (opts.waive) {
    stored.verifyWaivers = [{
      phase: 1, fp: commandFingerprint(CONTRACT), text: CONTRACT, reason: 'the contract window is not this phase\'s',
      by: 'owner@desk', at: new Date().toISOString(),
    }];
  }
  saveRun(stored);
  try {
    await runner.start({ slug: 'demo', root, resumeRunId: stored.id } as never);
    await runner.wait();
  } finally {
    scheduler.close();
  }
  const journalled = (name: string) => events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);
  return { state: runner.current()!, journalled, root };
}

test('VW-3: without a waiver a line red after the baseline fails the phase', async () => {
  const { state } = await verifyRace({ waive: false });
  assert.notEqual(state.phases['1']!.status, 'done', `the red line is the phase's: ${state.phases['1']!.status}`);
});

test('VW-3: with the operator\'s waiver the line is set aside and the phase goes done', async () => {
  const { state, journalled, root } = await verifyRace({ waive: true });
  assert.ok(existsSync(join(root, 'contract-window')), 'the line really is red now');
  assert.equal(state.phases['1']!.status, 'done');
  const waived = journalled('phase.verify-waived').filter((line) => line.stage === 'verify' && line.by === 'operator');
  assert.equal(waived.length, 1, JSON.stringify(journalled('phase.verify-waived')));
  const lines = waived[0]!.lines as { line: string; by: string; reason: string }[];
  assert.deepEqual(lines.map((one) => [one.line, one.by]), [[CONTRACT, 'owner@desk']]);
  const verification = state.phases['1']!.verification;
  assert.ok(verification?.waived?.some((item) => item.fp === commandFingerprint(CONTRACT)), 'listed under waived');
  assert.ok(verification?.ran.every((row) => row.command !== CONTRACT), 'never run');
});

test('VW-4: the route is an authority press, a session cannot make it, and the surface names its door', () => {
  const row = AUTHORITY_ROUTES.find((one) => one.path === '/api/run/:slug/verify-waive');
  assert.ok(row, 'the waiver is an authority route');
  assert.equal(row!.method, 'POST');
  assert.equal(row!.authority, 'override');
  const surface = readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'client', 'src', 'data', 'surface.ts'), 'utf8');
  assert.match(surface, /route\('POST', '\/api\/run\/:slug\/verify-waive', at\(runView, 'api\/runs#runsApi\.runVerifyWaive'\)/);
  const fold = readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'client', 'src', 'screens', 'plan', 'run', 'verification.tsx'), 'utf8');
  assert.match(fold, /runsApi\.runVerifyWaive\(/, 'the door is on the run\'s verification section');
});
