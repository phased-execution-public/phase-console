/**
 * A line already measured is not measured again (control-tower phase 105,
 * #190 ask 3).
 *
 * `lastRunOn` reused only the PLAN's own ledger rows. On the hub console every
 * tb phase of ai-builder-v7 re-measured tb `main`'s `task verify:local` — the
 * same tree, the same command, the same machine — because each plan keeps its
 * own ledger and a baseline read only one of them.
 *
 * BL-2  a line measured on the same repository tree hash, command and
 *       environment digest, in the same directory of that repository, by ANY
 *       phase or run of this console is reused for a baseline — named as reused
 *       with its source run and age; a stale measurement, one taken under
 *       another environment or in another directory, is not
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { foldCommand, verifyEnvDigest, type VerifyOptions } from '../server/runner/verify.ts';
import type { RunState, VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { workingTreeOf } from '../server/runner/worktree.ts';
import {
  appendLedger, BASELINE_REUSE_MAX_AGE_MS, baselineLineWords, readConsoleLedgers, reusableRun, verificationsFile,
  type LedgerRow,
} from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const TEST = 'npm test';
const HOUR = 60 * 60_000;

function harness(): { root: string; scriptsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-bl2-'));
  TRASH.push(root);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
S="${root}"
case "$2" in
  --memory-block)
    if [ -f "$S/.done-1" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, scriptsDir };
}

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const green = (): VerifySummary => ({
  ok: true, reason: '1 command green', notRun: [], ran: [{ command: TEST, ok: true, code: 0, ms: 5, output: '' }],
});

/** A runner whose verifier records which purposes it was asked for. */
function runnerFor(h: { root: string; scriptsDir: string }) {
  const purposes: string[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async () => {
      writeFileSync(join(h.root, '.done-1'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      purposes.push(opts.purpose ?? 'verify');
      return green();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  return { runner, purposes };
}

/** A ledger row as this console writes one now: tree, command, environment digest and directory. */
const row = (fields: Partial<LedgerRow>): LedgerRow => ({
  type: 'verification', slug: 'other', phase: 4, run: 'run-other', at: new Date(Date.now() - HOUR).toISOString(),
  kind: 'verify', command: foldCommand(TEST), code: 0, ms: 5, ok: true, env: verifyEnvDigest({}), dir: '', ...fields,
});

/* ------------------------------------------------------------------ *
 * The rule, alone
 * ------------------------------------------------------------------ */

test('BL-2: the reusable run is the newest one on the same tree, command, environment and directory — never a stale one', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const env = verifyEnvDigest({});
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const key = { command: TEST, tree: 't1', env, dir: '', now };
  const rows: LedgerRow[] = [
    row({ run: 'older', tree: 't1', at: at(5) }),
    row({ run: 'newer', tree: 't1', at: at(2) }),
    row({ run: 'other-tree', tree: 't2', at: at(1) }),
    row({ run: 'other-env', tree: 't1', at: at(1), env: 'f'.repeat(16) }),
    row({ run: 'other-dir', tree: 't1', at: at(1), dir: 'viewer' }),
    row({ run: 'cut', tree: 't1', at: at(1), timedOut: true, ok: false, code: 124 }),
  ];
  assert.equal(reusableRun(rows, key)?.run, 'newer');
  assert.equal(reusableRun([row({ run: 'stale', tree: 't1', at: at(BASELINE_REUSE_MAX_AGE_MS / HOUR + 1) })], key), undefined,
    'a measurement older than the freshness bound is not reused');
  const legacy = row({ run: 'legacy', tree: 't1', at: at(1) });
  delete legacy.env;
  assert.equal(reusableRun([legacy], key), undefined, 'a row that names no environment cannot vouch for this one');
});

test('BL-2: the environment digest moves with what the commands run under', () => {
  const base = verifyEnvDigest({});
  assert.equal(verifyEnvDigest({}), base, 'stable for the same environment');
  assert.notEqual(verifyEnvDigest({ setupText: '`npm ci`' }), base, 'a Setup preamble is part of the environment');
  assert.notEqual(verifyEnvDigest({ env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=64' } }), base);
  assert.equal(verifyEnvDigest({ env: { ...process.env, PE_SESSION_ID: 'whatever' } }), base, 'a variable no command reads does not move it');
});

/* ------------------------------------------------------------------ *
 * Through the runner
 * ------------------------------------------------------------------ */

test('BL-2: a line ANOTHER plan of this console measured on the same tree is reused — named with its source run and age', async () => {
  const h = harness();
  const base = await workingTreeOf(h.root);
  assert.ok(base, 'the harness is a repository');
  const measuredAt = new Date(Date.now() - 2 * HOUR).toISOString();
  appendLedger(verificationsFile(h.root, 'other'), [row({ tree: base!.tree, head: base!.head, at: measuredAt })]);
  assert.equal(readConsoleLedgers(h.root).length, 1, 'the console-wide read sees the other plan\'s ledger');

  const { runner, purposes } = runnerFor(h);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.deepEqual(purposes, ['verify'], 'nothing was measured at boarding: the other plan\'s run stood in');
  const line = state.phases['1']!.baseline?.commands[0];
  assert.equal(line?.from, 'reused');
  assert.equal(line?.by?.slug, 'other');
  assert.equal(line?.by?.run, 'run-other');
  assert.equal(line?.by?.phase, 4);
  assert.ok((line?.by?.ageMs ?? 0) >= 2 * HOUR - 60_000, 'its age is named');
  assert.match(baselineLineWords(line!), /^reused from other run run-other \(phase 4, 2h ago\)/);
  const entry = journal(h.root, state).find((r) => r.event === 'phase.verify-baseline');
  const from = (entry?.data.reusedFrom as { command: string; slug: string; run: string }[] | undefined) ?? [];
  assert.deepEqual(from.map((r) => [r.command, r.slug, r.run]), [[TEST, 'other', 'run-other']]);
});

test('BL-2: a measurement under another environment digest is NOT reused — the line is measured', async () => {
  const h = harness();
  const base = await workingTreeOf(h.root);
  appendLedger(verificationsFile(h.root, 'other'), [row({ tree: base!.tree, head: base!.head, env: '0'.repeat(16) })]);
  const { runner, purposes } = runnerFor(h);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.ok(purposes.includes('baseline'), 'measured, not reused');
  assert.equal(state.phases['1']!.baseline?.commands[0]?.from, 'measured');
});

test('BL-2: a stale measurement is NOT reused — the line is measured', async () => {
  const h = harness();
  const base = await workingTreeOf(h.root);
  const stale = new Date(Date.now() - BASELINE_REUSE_MAX_AGE_MS - HOUR).toISOString();
  appendLedger(verificationsFile(h.root, 'other'), [row({ tree: base!.tree, head: base!.head, at: stale })]);
  const { runner, purposes } = runnerFor(h);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.ok(purposes.includes('baseline'), 'measured, not reused');
  assert.equal(state.phases['1']!.baseline?.commands[0]?.from, 'measured');
});

test('BL-2: what the baseline measured is ledgered under its environment digest and directory, for the next reader', async () => {
  const h = harness();
  const { runner } = runnerFor(h);
  await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  const rows = readConsoleLedgers(h.root).filter((r) => r.kind === 'baseline');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.env, verifyEnvDigest({}));
  assert.equal(rows[0]!.dir, '');
});
