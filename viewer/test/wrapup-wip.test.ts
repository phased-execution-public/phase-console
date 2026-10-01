/**
 * The wrap-up's WIP is checked before anything builds on it (control-tower
 * phase 89, #127, #103's 2026-09-25 10:53Z ask 3).
 *
 * At 60 % of its window P43 was told "Commit what is done", committed WIP
 * whose own body said the suite had not run, and declared partial. On a shared
 * run branch that commit was at once every sibling's base: 15 files red for
 * every later lane, every push blocked, a sibling's own red masked under it.
 *
 * WU-1  after the wrap-up's `partial --reason context`, the console runs the
 *       plan's FAST gate (the phase's lines measured fast) on the committed
 *       WIP and, red, writes `wipRed {sha, files, lines}` on the phase; green,
 *       it writes nothing; with no fast line it says nothing was checked
 * WU-2  the boarding order puts the WIP's owner first, and every sibling's
 *       brief names the red lines, the files and whose they are
 * WU-3  a booting lane's brief names ANY sibling's uncommitted WIP in the
 *       shared tree, with its owner — whatever the sibling stopped for
 * WU-4  the wrap-up notice says which step applies: a lane of its own, the
 *       shared branch with the gate named, or the shared branch with nothing
 *       to check it — never an unconditional "commit what is done"
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { contextWrapupNotice } from '../server/runner/runner-core.ts';
import type { VerifyOptions } from '../server/runner/verify.ts';
import { newRun, phaseRecord, type RunState, type VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { appendLedger, verificationsFile, type LedgerRow } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const FAST = 'npm run typecheck';
const SLOW = 'npm test';
const RED = 'types › src/cart.ts: Property "total" does not exist';

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

/** A git repository with the engine stubbed; `.done-N` marks phase N done. */
function harness(phases: number[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-wu-')));
  TRASH.push(root);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the base\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
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
  gitIn(root, ['init', '-q']);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'base']);
  return { root, scriptsDir, done: (phase: number) => writeFileSync(join(root, `.done-${phase}`), '') };
}

/** The plan's ledger: FAST has run in seconds, SLOW in twenty minutes — only FAST is the fast gate. */
function seedLedger(root: string): void {
  const row = (command: string, ms: number): LedgerRow => ({
    type: 'verification', slug: 'demo', phase: 7, run: 'earlier', at: '2026-09-24T10:00:00.000Z', kind: 'verify',
    command, code: 0, ms, ok: true,
  });
  appendLedger(verificationsFile(root, 'demo'), [row(FAST, 20_000), row(SLOW, 20 * 60_000)]);
}

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const green = (commands: string[]): VerifySummary => ({
  ok: true, reason: 'green', notRun: [], ran: commands.map((command) => ({ command, ok: true, code: 0, ms: 5, output: '' })),
});

/**
 * Phase 1's first session commits WIP, is told to wrap up (the console's own
 * mark, as `noteContext` writes it), and declares `partial --reason context`;
 * its second session finishes. `gate` answers the wrap-up gate.
 *
 * `windowOpensEarly` moves the phase's first attempt window an hour back, to
 * before the base commit: what a clock reads when the base was committed in the
 * boarding's own second (git dates are whole seconds) — WU-1 flaked on exactly
 * that, 1 run in ~6, until the WIP's files were read from the baseline's head.
 */
async function wrapup(
  gate: (text: string) => VerifySummary,
  opts: { ledger?: boolean; windowOpensEarly?: boolean; baseline?: boolean } = {},
) {
  const h = harness([1]);
  if (opts.ledger !== false) seedLedger(h.root);
  const texts: { purpose: string; text: string; cwd: string }[] = [];
  let sessions = 0;
  let seenAtReboard: unknown;
  // eslint-disable-next-line prefer-const
  let runner: Runner;
  const spawn = async (req: { env?: Record<string, string> }) => {
    sessions += 1;
    const record = runner.current()!.phases['1'];
    if (sessions === 1) {
      if (opts.windowOpensEarly) {
        assert.ok(record.attemptWindows?.[0], 'the boarding opened an attempt window');
        record.attemptWindows![0]!.startedAt = new Date(Date.now() - 3_600_000).toISOString();
      }
      writeFileSync(join(h.root, 'src.txt'), 'half of the cart rewrite\n');
      gitIn(h.root, ['add', 'src.txt']);
      gitIn(h.root, ['commit', '-q', '-m', 'wip: cart rewrite (suite NOT run)']);
      record.contextWrapup = { sessionId: 'sid-1', at: new Date().toISOString(), context: 610_000, window: 1_000_000, delivered: true, attempts: 1 };
      const file = req.env?.PE_OUTCOME_FILE;
      assert.ok(file, 'the session was handed its outcome file');
      mkdirSync(dirname(file!), { recursive: true });
      writeFileSync(file!, JSON.stringify({ version: 1, slug: 'demo', phase: 1, status: 'partial', reason: 'context', written_at: new Date().toISOString(), session_id: 'sid-1' }));
      return { signal: { subtype: 'success' as const, code: 0, text: 'wrapped up' }, sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'wrapped up', durationMs: 1, argv: [] };
    }
    seenAtReboard = JSON.parse(JSON.stringify(record.wipRed ?? null));
    h.done(1);
    return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: 'sid-2', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
  };
  runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn,
    verify: async (text: string, o: VerifyOptions) => {
      texts.push({ purpose: o.purpose ?? 'verify', text, cwd: o.cwd });
      return o.purpose === 'wip-gate' ? gate(text) : green([FAST, SLOW]);
    },
    verificationText: () => `- \`${FAST}\`\n- \`${SLOW}\``,
    // The service always takes the boarding baseline (`service-base.ts`); a test opts in.
    ...(opts.baseline ? { verifyBaseline: () => true } : {}),
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  return { h, state, texts, seenAtReboard, sessions };
}

test('WU-1: the WIP\'s files are the commits since the head the phase boarded on — never the base commit, however close its clock', async () => {
  const { state, seenAtReboard } = await wrapup(() => ({
    ok: false, reason: `\`${FAST}\` exited 2`, notRun: [],
    ran: [{ command: FAST, ok: false, code: 2, ms: 900, output: RED, failures: [RED] }],
  }), { windowOpensEarly: true, baseline: true });
  assert.ok(state.phases['1'].baseline?.head, 'the first boarding recorded the head it stood on');
  assert.deepEqual((seenAtReboard as { files?: string[] } | null)?.files, ['src.txt'], 'the base commit\'s files are not the WIP\'s');
});

test('WU-1: a red wrap-up commit is recorded as the phase\'s wipRed — its sha, the files it changed, the red fast line — and nothing slow was run for it', async () => {
  const { h, state, texts, seenAtReboard } = await wrapup((text) => ({
    ok: false, reason: `\`${FAST}\` exited 2`, notRun: [],
    ran: [{ command: FAST, ok: false, code: 2, ms: 900, output: RED, failures: [RED] }],
    ...(text ? {} : {}),
  }), { baseline: true });
  const gate = texts.filter((one) => one.purpose === 'wip-gate');
  assert.equal(gate.length, 1, 'the fast gate ran once, after the wrap-up');
  assert.match(gate[0]!.text, /npm run typecheck/);
  assert.doesNotMatch(gate[0]!.text, /npm test/, 'the twenty-minute line is not a fast one');
  const wip = seenAtReboard as { sha: string; files?: string[]; lines?: { command: string; failures?: string[] }[] };
  const sha = gitIn(h.root, ['log', '--format=%H', '--grep', 'wip: cart rewrite', '-1']);
  assert.equal(wip?.sha, sha, 'the WIP commit is named');
  assert.deepEqual(wip?.files, ['src.txt']);
  assert.deepEqual(wip?.lines, [{ command: FAST, failures: [RED] }]);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.wip-gate');
  assert.equal(line?.data.ok, false);
  assert.equal(line?.data.sha, sha);
  // …and the phase's own green verification later retires it.
  assert.equal(state.phases['1'].status, 'done', state.phases['1'].note);
  assert.equal(state.phases['1'].wipRed, undefined, 'its own green §Verification clears the record');
});

test('WU-1: a green wrap-up gate records nothing red; with no line measured fast, the journal says nothing was checked', async () => {
  const ok = await wrapup(() => green([FAST]));
  assert.equal(ok.seenAtReboard, null);
  assert.equal(journal(ok.h.root, ok.state).find((entry) => entry.event === 'phase.wip-gate')?.data.ok, true);

  const none = await wrapup(() => green([FAST]), { ledger: false });
  assert.equal(none.texts.filter((one) => one.purpose === 'wip-gate').length, 0, 'no fast line — nothing run');
  assert.match(String(journal(none.h.root, none.state).find((entry) => entry.event === 'phase.wip-gate')?.data.skipped ?? ''), /no line .* measured fast/);
});

/** A handcrafted runner over a stored state — the LR-6 shape — for the order and the brief. */
function handcrafted(h: { root: string; scriptsDir: string }, state: RunState) {
  const runner = new Runner({ scriptsDir: h.scriptsDir, spawn: async () => { throw new Error('no spawn'); }, verificationText: () => `- \`${FAST}\`` } as never);
  const handle = runner as never as Record<string, unknown>;
  const events: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  handle.state = state;
  handle.record = (event: string, data: Record<string, unknown> = {}, phase?: number) => { events.push({ event, data, phase }); };
  handle.persist = () => {};
  handle.persistNow = () => {};
  handle.emit = () => {};
  const call = <T>(name: string, ...args: unknown[]): T => (handle[name] as (...a: unknown[]) => T).call(runner, ...args);
  return { runner, events, call };
}

test('WU-2: the WIP\'s owner boards first, and every sibling\'s brief names its red lines, its files and that they are its', async () => {
  const h = harness([1, 2, 3]);
  const state = newRun({ slug: 'demo', root: h.root });
  for (const phase of [1, 2, 3]) phaseRecord(state, phase).status = 'pending';
  // Phase 2 has queued for an hour; phase 3's WIP is red since a minute ago.
  phaseRecord(state, 2).queueSince = new Date(Date.now() - 3_600_000).toISOString();
  phaseRecord(state, 3).wipRed = { sha: 'a'.repeat(40), at: new Date(Date.now() - 60_000).toISOString(), files: ['src/cart.ts', 'src/total.ts'], lines: [{ command: FAST, failures: [RED] }] };
  const { events, call } = handcrafted(h, state);
  assert.deepEqual(call<number[]>('boardingOrder', [1, 2, 3]), [3, 2, 1], 'the red WIP\'s owner first, then seniority');
  assert.ok(events.some((e) => e.event === 'phase.seniority' && e.phase === 3 && e.data.clock === 'wip-red'), 'and why');

  const brief = await call<Promise<string>>('boardingWipBlock', 1, { phase: 1 });
  assert.match(brief, /Phase 3's work-in-progress is COMMITTED and RED \(commit aaaaaaaaaaaa\)/);
  assert.match(brief, /npm run typecheck/);
  assert.match(brief, /src\/cart\.ts, src\/total\.ts/);
  assert.match(brief, /Those reds are phase 3's/);
  assert.doesNotMatch(await call<Promise<string>>('boardingWipBlock', 3, { phase: 3 }), /Phase 3's work-in-progress/, 'never its own');
});

test('WU-3: a booting lane is told a sibling\'s UNCOMMITTED work in the shared tree, file by file with its owner — a scope-cap partial too', async () => {
  const h = harness([1, 2]);
  const state = newRun({ slug: 'demo', root: h.root });
  const sibling = phaseRecord(state, 2);
  sibling.status = 'pending';
  sibling.attemptWindows = [{ attempt: 1, startedAt: '2026-09-25T06:00:00.000Z', endedAt: '2026-09-25T06:55:00.000Z' }];
  sibling.lastPartial = { sessionId: 'sid-2', reason: 'scope-cap', at: '2026-09-25T06:55:00.000Z' };
  phaseRecord(state, 1).status = 'pending';
  for (const name of ['runner-attempt.ts', 'outcome.bats']) {
    writeFileSync(join(h.root, name), 'phase 2 was here\n');
    utimesSync(join(h.root, name), new Date('2026-09-25T06:30:00.000Z'), new Date('2026-09-25T06:30:00.000Z'));
  }
  const { call } = handcrafted(h, state);
  const brief = await call<Promise<string>>('boardingWipBlock', 1, { phase: 1 });
  assert.match(brief, /This tree holds phase 2's UNCOMMITTED work \(it stopped with `partial --reason scope-cap`\): 2 file\(s\) — outcome\.bats, runner-attempt\.ts/);
  assert.match(brief, /do not commit, stash, reset or debug them/);
  assert.equal(await call<Promise<string>>('boardingWipBlock', 1, { phase: 1, worktree: '/elsewhere' }), '', 'a lane with a tree of its own is not told about this one');
});

test('WU-4: the wrap-up notice says which commit step applies — never an unconditional "Commit what is done"', () => {
  const outcome = 'bash phase-outcome.sh demo 1';
  const shared = contextWrapupNotice(610_000, 1_000_000, outcome, { shared: true, fastGate: [FAST] });
  assert.doesNotMatch(shared, /2\. Commit what is done\./);
  assert.match(shared, /this branch is SHARED/);
  assert.match(shared, /runs this phase's fast gate on your last commit \(`npm run typecheck`\)/);
  assert.match(shared, /recorded against THIS phase \(`wipRed`\)/);
  assert.match(shared, /Leave anything unverified UNCOMMITTED/);
  assert.match(contextWrapupNotice(610_000, 1_000_000, outcome, { shared: true, fastGate: [] }), /NOTHING checks your commit/);
  assert.match(contextWrapupNotice(610_000, 1_000_000, outcome, { shared: false }), /this lane's branch is its own/);
  assert.match(shared, /partial --reason context/, 'the declaration it asks for is unchanged');
});
