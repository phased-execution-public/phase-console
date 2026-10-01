/**
 * §Verification is paid for once (control-tower phase 62, #68, AUD-10).
 *
 * In one measured week the console re-ran a phase's verify:local or
 * run-tests suite in 21 phases — 398 minutes — after 640 minutes of the same
 * suites run in-turn by the sessions themselves, with no record anywhere of
 * what a session had proved at which tree. A session now records each command
 * it ran through `phase-outcome.sh … verified` — the command, its exit status
 * and the WORKING tree it ran against — and the console re-runs only what was
 * not proven at an equivalent tree: the proven tree itself, or one where only
 * paperwork (`docs/handoffs/**`, `.locks/**`, `CHANGELOG.md`) changed since.
 * Where the two disagree, the journal says so.
 *
 *   VP-1  the tree a proof names is the same object in both languages
 *   VP-2  which proofs hold: same tree, paperwork-only change, a real change, a red proof
 *   VP-3  `verifyPhase` does not run a proven command, and runs the rest
 *   VP-4  the runner end to end: proven → not re-run; changed → re-run, and a
 *         disagreement is journalled
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Runner } from '../server/runner/runner.ts';
import { verifyPhase } from '../server/runner/verify.ts';
import { isPaperwork, judgeProofs, proofsFile, readProofs } from '../server/runner/proofs.ts';
import { workingTreeOf } from '../server/runner/worktree.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTCOME = join(REPO_ROOT, 'scripts', 'phase-outcome.sh');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit: src/a.ts, CHANGELOG.md. */
function repo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-proof-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# changes\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Record a proof exactly as a session would — through the script. */
function prove(dir: string, ledger: string, command: string, code: number, phase = 1): void {
  execFileSync('bash', [OUTCOME, 'demo', String(phase), 'verified', '--command', command, '--exit', String(code), '--in', dir], {
    env: { ...process.env, PE_PROOFS_FILE: ledger, PE_SESSION_ID: 'sess-proof', PE_NOW: '2026-09-25T10:00:00Z' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* ------------------------------------------------------------------ *
 * VP-1 — one tree, two languages
 * ------------------------------------------------------------------ */

test('VP-1: the tree the script records is the tree the console computes — uncommitted and untracked work included', async () => {
  const r = repo();
  const ledger = join(r.dir, '..', `${Date.now()}-proofs.ndjson`);
  try {
    // What a session has when it runs its suite: an edit not yet committed and
    // a new file not yet added. The proof is about what RAN.
    writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(r.dir, 'src', 'b.ts'), 'export const b = 1;\n');
    prove(r.dir, ledger, 'npm test', 0);
    const [proof] = [...readProofs(ledger, 'demo', 1).values()];
    const mine = await workingTreeOf(r.dir);
    assert.ok(mine, 'the console could name the working tree');
    assert.equal(proof.tree, mine!.tree, 'bash and TS name the same tree object');
    assert.equal(proof.head, git(r.dir, 'rev-parse', 'HEAD'));
    // Neither side touched the session's index: nothing is staged.
    assert.equal(git(r.dir, 'diff', '--cached', '--name-only'), '');
    // And the tree really is the working content: committing it changes HEAD, not the tree.
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'the tested work');
    assert.equal((await workingTreeOf(r.dir))!.tree, proof.tree, 'the commit it proved lands on the same tree');
  } finally {
    rmSync(ledger, { force: true });
    r.cleanup();
  }
});

test('VP-1: a linked worktree answers too — the mirror every console run works in is one', async () => {
  const r = repo();
  const lane = `${r.dir}-lane`;
  const ledger = `${r.dir}-proofs.ndjson`;
  try {
    git(r.dir, 'worktree', 'add', '-q', '-b', 'pe/demo', lane);
    writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 3;\n');
    prove(lane, ledger, 'npm test', 0);
    const [proof] = [...readProofs(ledger, 'demo', 1).values()];
    assert.equal(proof.tree, (await workingTreeOf(lane))!.tree);
    assert.equal(git(lane, 'diff', '--cached', '--name-only'), '');
  } finally {
    rmSync(ledger, { force: true });
    rmSync(lane, { recursive: true, force: true });
    r.cleanup();
  }
});

/** The working tree's content hashed from an EMPTY index — no stat data trusted: the ground truth. */
function freshTree(dir: string): string {
  const index = join(dir, '..', `${Date.now()}-fresh-index`);
  try {
    execFileSync('git', ['-C', dir, 'add', '-A'], { env: { ...process.env, GIT_INDEX_FILE: index }, stdio: 'ignore' });
    return execFileSync('git', ['-C', dir, 'write-tree'], { env: { ...process.env, GIT_INDEX_FILE: index }, encoding: 'utf8' }).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

test('VP-1: a file rewritten at the same size in the second it was checked out is named as it RAN, in both languages', async () => {
  // A fresh checkout's index trusts its entries' stat data, and a same-size
  // rewrite in the same second matches them on every field git reads. Git
  // re-reads such an entry only while it is not older than the INDEX FILE, so
  // the private copy keeps the index file's mtime; a copy without it named the
  // checkout's tree a second later — the flake this pins.
  const r = repo();
  const lane = `${r.dir}-racy`;
  const ledger = `${r.dir}-proofs.ndjson`;
  try {
    git(r.dir, 'worktree', 'add', '-q', '-b', 'pe/racy', lane);
    writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 7;\n');
    await new Promise((settle) => setTimeout(settle, 1100));
    prove(lane, ledger, 'npm test', 0);
    const truth = freshTree(lane);
    const [proof] = [...readProofs(ledger, 'demo', 1).values()];
    assert.equal(proof.tree, truth, 'the script names what ran');
    assert.equal((await workingTreeOf(lane))!.tree, truth, 'and so does the console');
  } finally {
    rmSync(ledger, { force: true });
    rmSync(lane, { recursive: true, force: true });
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * VP-2 — which proofs hold
 * ------------------------------------------------------------------ */

test('VP-2: paperwork is the handoffs, the locks and the changelog — nothing a suite reads', () => {
  for (const path of ['docs/handoffs/demo/phase-01-x.md', 'docs/handoffs/demo/.locks/phase-01.lock', '.locks/phase-02.lock', 'CHANGELOG.md']) {
    assert.equal(isPaperwork(path), true, path);
  }
  for (const path of ['src/a.ts', 'docs/plans/demo.md', 'viewer/CHANGELOG.md.bak', 'docs/handoffs.md', 'tests/fixtures/CHANGELOG.md']) {
    assert.equal(isPaperwork(path), false, path);
  }
});

test('VP-2: a green proof holds at its own tree and across paperwork; a code change or a red proof does not', async () => {
  const r = repo();
  const ledger = `${r.dir}-proofs.ndjson`;
  try {
    prove(r.dir, ledger, 'npm   test', 0);
    prove(r.dir, ledger, 'bash tests/run-tests.sh', 1);
    // The SAME tree.
    let judged = await judgeProofs({ file: ledger, slug: 'demo', phase: 1, cwd: r.dir });
    assert.deepEqual([...judged.proven.keys()], ['npm test'], 'folded exactly as a §Verification command is');
    assert.deepEqual(judged.proven.get('npm test')!.paperwork, []);
    assert.match(judged.refused.find((x) => x.command === 'bash tests/run-tests.sh')!.why, /red/);

    // Paperwork only: the handoff, a lock, the changelog — committed or not.
    mkdirSync(join(r.dir, 'docs', 'handoffs', 'demo', '.locks'), { recursive: true });
    writeFileSync(join(r.dir, 'docs', 'handoffs', 'demo', 'phase-01-x.md'), '---\nstatus: complete\n---\n');
    writeFileSync(join(r.dir, 'docs', 'handoffs', 'demo', '.locks', 'phase-01.lock'), 'owner=x\n');
    writeFileSync(join(r.dir, 'CHANGELOG.md'), '# changes\n\n- phase 1\n');
    git(r.dir, 'add', 'CHANGELOG.md');
    git(r.dir, 'commit', '-qm', 'paperwork');
    judged = await judgeProofs({ file: ledger, slug: 'demo', phase: 1, cwd: r.dir });
    assert.ok(judged.proven.has('npm test'), 'paperwork since the proof does not un-prove it');
    assert.deepEqual([...judged.proven.get('npm test')!.paperwork].sort(), [
      'CHANGELOG.md', 'docs/handoffs/demo/.locks/phase-01.lock', 'docs/handoffs/demo/phase-01-x.md',
    ]);

    // A change a suite can read.
    writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 9;\n');
    judged = await judgeProofs({ file: ledger, slug: 'demo', phase: 1, cwd: r.dir });
    assert.equal(judged.proven.size, 0);
    const refusal = judged.refused.find((x) => x.command === 'npm test')!;
    assert.match(refusal.why, /changed since/);
    assert.deepEqual(refusal.changed, ['src/a.ts']);
  } finally {
    rmSync(ledger, { force: true });
    r.cleanup();
  }
});

test('VP-2: the last proof of a command wins, another phase\'s proofs are not this phase\'s, and nothing on file asks git nothing', async () => {
  const r = repo();
  const ledger = `${r.dir}-proofs.ndjson`;
  try {
    prove(r.dir, ledger, 'npm test', 1);
    prove(r.dir, ledger, 'npm test', 0);
    prove(r.dir, ledger, 'npm run lint', 0, 2);
    const judged = await judgeProofs({ file: ledger, slug: 'demo', phase: 1, cwd: r.dir });
    assert.deepEqual([...judged.proven.keys()], ['npm test'], 'the re-run green supersedes the red before it');
    assert.equal(judged.recorded.size, 1, 'phase 2\'s proof is phase 2\'s');
    // A garbled line is skipped, not fatal.
    appendFileSync(ledger, '{not json\n');
    assert.equal(readProofs(ledger, 'demo', 1).size, 1);
    // No ledger at all: no tree is computed, nothing is proven.
    const none = await judgeProofs({ file: `${ledger}.absent`, slug: 'demo', phase: 1, cwd: r.dir });
    assert.equal(none.tree, null);
    assert.equal(none.proven.size, 0);
  } finally {
    rmSync(ledger, { force: true });
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * VP-3 — verifyPhase honours a proof
 * ------------------------------------------------------------------ */

test('VP-3: a proven command is not run — its row is green and names the proof; an unproven one runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-proof-vp3-'));
  try {
    // `false` would be red if it ran: a green row proves it did not.
    const proven = new Map([['false', { tree: 'a'.repeat(40), at: '2026-09-25T10:00:00Z', session: 'sess-proof', paperwork: [] }]]);
    const summary = await verifyPhase('- `false`\n- `true`', { cwd: dir, proven });
    assert.equal(summary.ok, true, summary.reason);
    assert.equal(summary.ran.length, 2);
    assert.equal(summary.ran[0].command, 'false');
    assert.equal(summary.ran[0].ok, true);
    assert.equal(summary.ran[0].ms, 0);
    assert.equal(summary.ran[0].proven?.session, 'sess-proof');
    assert.equal(summary.ran[1].proven, undefined, 'the second command really ran');
    assert.match(summary.reason, /1 proven by the session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * VP-4 — the runner, end to end
 * ------------------------------------------------------------------ */

/**
 * A git repository that is also the run's root, with a phase-graph stub whose
 * board flips to done once the phase is handed out, and a session that either
 * records a proof of `false` (as if its own run of it had been green) or
 * changes code after it did.
 */
function runRepo() {
  const r = repo();
  const scripts = join(r.dir, '.stub', 'scripts');
  const served = join(r.dir, '.stub', 'served');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(r.dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(r.dir, '.gitignore'), '.stub/\n');
  git(r.dir, 'add', '-A');
  git(r.dir, 'commit', '-qm', 'ignore the stub');
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block)
    if [ -f "${served}" ]; then echo "ready: "; echo "done: 1"; else echo "ready: 1"; echo "done: "; fi ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase 1"; touch "${served}" ;;
  *) exit 2 ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { ...r, scripts };
}

function drive(r: ReturnType<typeof runRepo>, session: () => void) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: async () => {
      session();
      return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: 'sess-proof', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
    },
    verificationText: () => '- `false`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  const journalled = (name: string) => events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);
  return { instance, events, journalled };
}

test('VP-4: a command the session proved at this tree is not run again, and the phase settles on the proof', async () => {
  const r = runRepo();
  const ledger = proofsFile(r.dir, 'demo');
  try {
    const { instance, journalled } = drive(r, () => prove(r.dir, ledger, 'false', 0));
    await instance.start({ slug: 'demo', root: r.dir, autonomy: 'keep-going' });
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'done', record.note);
    assert.equal(record.verification?.ok, true);
    assert.ok(record.verification?.ran[0].proven, 'the row says the session proved it');
    const [line] = journalled('phase.verify-proven');
    assert.ok(line, 'the judgement is journalled');
    assert.deepEqual((line.proven as { command: string }[]).map((p) => p.command), ['false']);
    assert.equal(journalled('phase.verify-disagreed').length, 0);
  } finally {
    rmSync(ledger, { force: true });
    r.cleanup();
  }
});

test('VP-4: a code change after the proof is re-run, and the session\'s green against the console\'s red is journalled', async () => {
  const r = runRepo();
  const ledger = proofsFile(r.dir, 'demo');
  try {
    let sessions = 0;
    const { instance, journalled } = drive(r, () => {
      // The first session proves, then edits; any later one (the re-opened
      // phase's fix session) does nothing at all.
      if (sessions++ > 0) return;
      prove(r.dir, ledger, 'false', 0);
      // …and then an edit a suite reads, after the proof and before the handoff.
      writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 42;\n');
    });
    await instance.start({ slug: 'demo', root: r.dir, autonomy: 'keep-going' });
    await instance.wait();
    const record = instance.current()!.phases['1'];
    assert.notEqual(record.status, 'done', 'a red verdict is not a done phase');
    assert.equal(record.verification?.ok, false, 'the console ran it, and it is red');
    assert.equal(record.verification?.ran[0].proven, undefined);
    const [judged] = journalled('phase.verify-proven');
    assert.match(String((judged.refused as { why: string }[])[0].why), /changed since/);
    const [disagreed] = journalled('phase.verify-disagreed');
    assert.ok(disagreed, 'the two verdicts disagree, and the journal says so');
    assert.equal(disagreed.command, 'false');
    assert.equal((disagreed.session as { code: number }).code, 0);
    assert.equal((disagreed.console as { code: number }).code, 1);
    assert.deepEqual(disagreed.changed, ['src/a.ts']);
  } finally {
    rmSync(ledger, { force: true });
    r.cleanup();
  }
});
