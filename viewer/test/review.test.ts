/**
 * The review surface — the diff, the verdict, and the hold the verdict has.
 *
 * Four things are pinned here, in the order they can go wrong:
 *
 *   1. **the parser**, because it is hand-written and a diff renderer that
 *      mis-numbers a line is worse than none — a reviewer would be reading a
 *      real change against the wrong address;
 *   2. **the window**, against a REAL git repository rather than a fixture,
 *      because the bracket is a heuristic over `git log` and the only way to
 *      know it holds is to make history and ask;
 *   3. **the store**, including the two ways a verdict is silently lost — a
 *      half-written file and a file from a newer schema;
 *   4. **the hold**, driven through the actual runner: a phase whose
 *      dependency has requested changes must not board, and must board the
 *      moment the verdict is withdrawn. Exit criterion 2 is a behaviour, so it
 *      is tested as one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-review-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const {
  MAX_HUNK_LINES, REVIEW_SCHEMA_VERSION, ReviewStore, isReviewVerdict,
  parseUnifiedDiff, phaseDiff, resolveWindow, reviewHold, reviewHoldNote,
} = await import('../server/review.ts');
const { Runner } = await import('../server/runner/runner.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * 1. the parser
 * ------------------------------------------------------------------ */

const SAMPLE = [
  'diff --git a/src/keep.ts b/src/keep.ts',
  'index 1111111..2222222 100644',
  '--- a/src/keep.ts',
  '+++ b/src/keep.ts',
  '@@ -10,4 +10,5 @@ export function keep() {',
  ' const before = 1;',
  '-const gone = 2;',
  '+const added = 2;',
  '+const alsoAdded = 3;',
  ' const after = 4;',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-export const gone = true;',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 3333333..4444444 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

test('the parser reads statuses, counts and line numbers off a unified diff', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.deepEqual(files.map((f) => f.path), ['src/keep.ts', 'src/new.ts', 'src/old.ts', 'assets/logo.png']);
  assert.deepEqual(files.map((f) => f.status), ['modified', 'added', 'deleted', 'modified']);

  const keep = files[0]!;
  assert.equal(keep.additions, 2);
  assert.equal(keep.deletions, 1);
  assert.equal(keep.hunks.length, 1);
  // The addresses are the point: a context line before the change keeps both
  // sides, a deletion advances only the old side, an addition only the new.
  const lines = keep.hunks[0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      ['context', 12, 13],
    ],
  );
  assert.equal(files[3]!.binary, true, 'a binary file is marked, not parsed');
  assert.equal(files[3]!.hunks.length, 0);
});

test('a rename keeps both names and does not read as an add plus a delete', () => {
  const files = parseUnifiedDiff([
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 96%',
    'rename from old/name.ts',
    'rename to new/name.ts',
    '--- a/old/name.ts',
    '+++ b/new/name.ts',
    '@@ -1,2 +1,2 @@',
    ' const same = 1;',
    '-const changed = 2;',
    '+const changed = 3;',
    '',
  ].join('\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0]!.status, 'renamed');
  assert.equal(files[0]!.oldPath, 'old/name.ts');
  assert.equal(files[0]!.path, 'new/name.ts');
});

test('a file longer than the per-file cap is marked truncated, never silently short', () => {
  const body = Array.from({ length: 40 }, (_, i) => `+line ${i}`);
  const files = parseUnifiedDiff([
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    `@@ -0,0 +1,${body.length} @@`,
    ...body,
    '',
  ].join('\n'), 10);
  assert.equal(files[0]!.truncated, true);
  assert.equal(files[0]!.hunks[0]!.lines.length, 10);
  // The cap is a rendering limit, so the count reflects what was RENDERED —
  // the honest total for the file comes from --numstat in `phaseDiff`.
  assert.equal(files[0]!.additions, 10);
  assert.ok(MAX_HUNK_LINES > 10, 'the shipped cap is not the test cap');
});

test('a diff that changed nothing parses to nothing rather than to a phantom file', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('\n\n'), []);
});

/* ------------------------------------------------------------------ *
 * 2. the window, against real history
 * ------------------------------------------------------------------ */

type Repo = { root: string; cleanup: () => void };

function git(root: string, args: string[]): string {
  return String(execFileSync('git', args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }));
}

/**
 * A repository shaped like a real plan: two phases, each landing code commits
 * that never touch `docs/` and then a handoff commit that does.
 */
function planRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-review-repo-'));
  const handoffs = join(root, 'docs', 'handoffs', 'demo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(handoffs, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p1: code']);

  writeFileSync(join(handoffs, 'phase-01-first.md'), '---\nstatus: complete\n---\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p1: handoff']);

  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p2: code']);

  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 11;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p2: more code']);

  writeFileSync(join(handoffs, 'phase-02-second.md'), '---\nstatus: complete\n---\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'p2: handoff']);

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a phase is bracketed by the handoffs, and the bracket catches code commits that never touched docs/', async () => {
  const r = planRepo();
  try {
    const handoffDir = join(r.root, 'docs', 'handoffs', 'demo');
    const diff = await phaseDiff({
      root: r.root,
      slug: 'demo',
      phase: 2,
      handoffPath: join(handoffDir, 'phase-02-second.md'),
      handoffDir,
    });
    assert.equal(diff.window.kind, 'handoff-window');
    assert.ok(diff.window.base && diff.window.tip, 'both ends of the bracket resolved');

    const paths = diff.files.map((f) => f.path).sort();
    // b.ts was created and a.ts edited, both in commits that never went near
    // docs/ — this is the whole reason the bracket is the handoff pair.
    assert.deepEqual(paths, ['docs/handoffs/demo/phase-02-second.md', 'src/a.ts', 'src/b.ts']);
    // …and phase 1's work is on the other side of the base.
    assert.ok(!paths.includes('docs/handoffs/demo/phase-01-first.md'));

    const subjects = diff.commits.map((c) => c.subject);
    assert.deepEqual(subjects, ['p2: handoff', 'p2: more code', 'p2: code']);
    assert.equal(diff.failed, false);
    assert.ok(diff.additions > 0);
  } finally { r.cleanup(); }
});

test('the plan\'s FIRST phase brackets from its parent, not from an empty review', async () => {
  const r = planRepo();
  try {
    const handoffDir = join(r.root, 'docs', 'handoffs', 'demo');
    const diff = await phaseDiff({
      root: r.root,
      slug: 'demo',
      phase: 1,
      handoffPath: join(handoffDir, 'phase-01-first.md'),
      handoffDir,
    });
    assert.equal(diff.window.kind, 'handoff-window');
    assert.deepEqual(diff.files.map((f) => f.path), ['docs/handoffs/demo/phase-01-first.md']);
    assert.match(diff.window.note, /first handoff landing/);
  } finally { r.cleanup(); }
});

test('a renamed file appears ONCE, under its new name, with both names kept', async () => {
  // The regression this pins: `git diff --numstat` without `-z` compresses a
  // rename into one field with brace syntax — `src/{old.ts => new.ts}` — which
  // is a path that exists nowhere and matches nothing the unified diff calls a
  // file. Merging the two lists on `path` then produced the same file twice:
  // once with its hunks, once under a name with an arrow in it, marked
  // truncated. The second row is the kind of thing a reader would rationalise
  // rather than report.
  const r = planRepo();
  try {
    const handoffs = join(r.root, 'docs', 'handoffs', 'demo');
    // A pure `git mv`, so git's similarity index is 100% and the rename is not
    // a judgement call. A one-line file whose one line also changed scores 0%
    // and is honestly an add plus a delete — a different case, and not this one.
    git(r.root, ['mv', 'src/b.ts', 'src/renamed.ts']);
    writeFileSync(join(r.root, 'src', 'a.ts'), 'export const a = 111;\n');
    writeFileSync(join(handoffs, 'phase-03-third.md'), '---\nstatus: complete\n---\n');
    git(r.root, ['add', '.']);
    git(r.root, ['commit', '-qm', 'p3: rename']);

    const diff = await phaseDiff({
      root: r.root, slug: 'demo', phase: 3,
      handoffPath: join(handoffs, 'phase-03-third.md'),
      handoffDir: handoffs,
    });
    const renamed = diff.files.filter((f) => f.path.includes('renamed'));
    assert.equal(renamed.length, 1, `expected one row, got ${JSON.stringify(diff.files.map((f) => f.path))}`);
    assert.equal(renamed[0]!.status, 'renamed');
    assert.equal(renamed[0]!.oldPath, 'src/b.ts');
    // …and no row anywhere carrying git's brace syntax.
    assert.equal(diff.files.some((f) => f.path.includes('=>')), false, 'a `{a => b}` path leaked into the file list');
  } finally { r.cleanup(); }
});

test('a phase with no handoff falls back to the working tree and SAYS so', async () => {
  const r = planRepo();
  try {
    writeFileSync(join(r.root, 'src', 'c.ts'), 'export const c = 3;\n');
    git(r.root, ['add', 'src/c.ts']);
    const window = await resolveWindow({
      root: r.root,
      handoffDir: join(r.root, 'docs', 'handoffs', 'demo'),
    });
    assert.equal(window.kind, 'working-tree');
    assert.match(window.note, /has not committed a handoff/);
  } finally { r.cleanup(); }
});

test('an explicit range wins over the heuristic, and a rubbish one falls back rather than throwing', async () => {
  const r = planRepo();
  try {
    const handoffDir = join(r.root, 'docs', 'handoffs', 'demo');
    const head = git(r.root, ['rev-parse', 'HEAD']).trim();
    const explicit = await resolveWindow({ root: r.root, handoffDir, base: `${head}~2`, tip: head });
    assert.equal(explicit.kind, 'explicit');

    const rubbish = await resolveWindow({
      root: r.root, handoffDir, handoffPath: join(handoffDir, 'phase-02-second.md'),
      base: 'not-a-real-ref', tip: 'nor-is-this',
    });
    assert.equal(rubbish.kind, 'handoff-window', 'an unresolvable override degrades to the heuristic');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * 3. the store
 * ------------------------------------------------------------------ */

function store(): { s: InstanceType<typeof ReviewStore>; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-review-store-'));
  return {
    s: new ReviewStore(() => dir),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a verdict round-trips, and withdrawing it removes the hold', () => {
  const { s, cleanup } = store();
  try {
    assert.equal(s.get('demo', 3), undefined, 'nothing reviewed is not "approved"');
    const written = s.set('demo', 3, { verdict: 'requested-changes', note: 'the parser is wrong', by: 'me' });
    assert.equal(written.version, REVIEW_SCHEMA_VERSION);
    assert.equal(s.get('demo', 3)?.verdict, 'requested-changes');
    assert.equal(s.get('demo', 3)?.note, 'the parser is wrong');
    assert.deepEqual(s.all('demo').map((r) => r.phase), [3]);

    assert.equal(s.clear('demo', 3), true);
    assert.equal(s.get('demo', 3), undefined);
    assert.equal(s.clear('demo', 3), false, 'withdrawing twice is not an error, it is a no-op');
  } finally { cleanup(); }
});

test('a half-written or future-version verdict is ignored rather than half-believed', () => {
  const { s, dir, cleanup } = store();
  try {
    writeFileSync(join(dir, 'phase-04.json'), '{"version":1,"verdict":"requested-cha');
    assert.equal(s.get('demo', 4), undefined);

    writeFileSync(join(dir, 'phase-05.json'), JSON.stringify({
      version: REVIEW_SCHEMA_VERSION + 1, slug: 'demo', phase: 5, verdict: 'requested-changes', at: 'x',
    }));
    assert.equal(s.get('demo', 5), undefined, 'a newer schema is not guessed at');

    writeFileSync(join(dir, 'phase-06.json'), JSON.stringify({
      version: 1, slug: 'demo', phase: 6, verdict: 'nonsense', at: 'x',
    }));
    assert.equal(s.get('demo', 6), undefined, 'an unknown verdict is not a verdict');
    assert.deepEqual(s.all('demo'), []);
  } finally { cleanup(); }
});

test('a store with no root open refuses to write instead of inventing a path', () => {
  const s = new ReviewStore(() => null);
  assert.equal(s.get('demo', 1), undefined);
  assert.deepEqual(s.all('demo'), []);
  assert.throws(() => s.set('demo', 1, { verdict: 'approved' }), /nowhere to record/);
});

test('the write is atomic — the final file is complete JSON, and no temp file survives', () => {
  const { s, dir, cleanup } = store();
  try {
    s.set('demo', 7, { verdict: 'approved', note: 'fine' });
    const raw = readFileSync(join(dir, 'phase-07.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw).verdict, 'approved');
    assert.deepEqual(s.all('demo').map((r) => r.phase), [7], 'the .tmp file is gone, not listed');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * 4. the hold
 * ------------------------------------------------------------------ */

test('only a requested-changes verdict on a DIRECT dependency holds a phase', () => {
  const reviews = [
    { version: 1, slug: 'demo', phase: 1, verdict: 'requested-changes' as const, at: 'x' },
    { version: 1, slug: 'demo', phase: 2, verdict: 'approved' as const, at: 'x' },
    { version: 1, slug: 'demo', phase: 9, verdict: 'requested-changes' as const, at: 'x' },
    { version: 1, slug: 'demo', phase: 4, verdict: 'commented' as const, at: 'x' },
  ];
  assert.deepEqual(reviewHold([1, 2], reviews), [1]);
  assert.deepEqual(reviewHold([2], reviews), [], 'approved holds nothing');
  assert.deepEqual(reviewHold([4], reviews), [], 'a comment is not a verdict');
  assert.deepEqual(reviewHold([], reviews), [], 'a root phase depends on nothing');
  assert.deepEqual(reviewHold([2, 3], reviews), [], 'phase 9 is not a dependency of this phase');
  assert.deepEqual(reviewHold([9, 1], reviews), [1, 9], 'reported in phase order');
  assert.match(reviewHoldNote([1, 9]), /P1, P9 have requested changes/);
  assert.match(reviewHoldNote([1]), /P1 has requested changes/);
  // The note must name whose hold this is — it is the console's, not the board's.
  assert.match(reviewHoldNote([1]), /not the engine/);
});

test('isReviewVerdict rejects everything that is not one of the three', () => {
  assert.ok(isReviewVerdict('approved') && isReviewVerdict('requested-changes') && isReviewVerdict('commented'));
  for (const bad of ['', 'APPROVED', 'reject', 'withdraw', null, 7, undefined, {}]) {
    assert.equal(isReviewVerdict(bad), false, `${String(bad)} is not a verdict`);
  }
});

/* --- the hold, driven through the runner ------------------------------- */

type Stub = { root: string; scripts: string; state: string; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** The two-phase stub plan the runner harnesses in this suite share. */
function stubPlan(): Stub {
  const root = mkdtempSync(join(tmpdir(), 'pc-review-run-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  // Phase 1 is already done, so phase 2 — the one under review hold — is the
  // only phase the board reports ready.
  writeFileSync(join(state, 'done'), '1\n');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"
    echo "ready: \${r%,}"
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "$arg" >> "$S/gate-asked"; echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');

  return { root, scripts, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function outcome(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/** Drive the stub plan once; hand back the prompts spawned and the events emitted. */
async function drive(
  s: Stub, deps: Record<string, unknown> = {},
): Promise<{ prompts: string[]; events: { event: string; data: Record<string, unknown> }[] }> {
  const prompts: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    prompts.push(request.prompt);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' });
    return outcome();
  };
  const runner = new Runner({
    scriptsDir: s.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    ...deps,
  } as never);
  await runner.start({ slug: 'demo', root: s.root, onlyPhases: [2] } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  return { prompts, events };
}

test('a phase whose dependency has requested changes never boards — and the note says whose hold it is', async () => {
  const s = stubPlan();
  try {
    const { prompts, events } = await drive(s, { reviewHold: () => [1] });
    assert.deepEqual(prompts, [], 'no session was spawned, so nothing was spent');
    // `run:` is the runner's own prefix on every event it broadcasts.
    const phaseEvent = events.find((e) => e.event === 'run:phase' && e.data.status === 'gated');
    assert.ok(phaseEvent, 'the phase reported itself held');
    assert.deepEqual(phaseEvent!.data.reviewHold, [1]);
    // Its own journal line, so an audit can tell a review hold from a gate
    // without parsing prose — the same reason `phase.gate-delegated` exists.
    const line = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.review-held');
    assert.ok(line, 'the hold is journalled under its own name');
    // And it refused BEFORE spending anything: the gate is a subprocess, and a
    // phase that is not going to board however the gate answers should not pay
    // for the answer. The stub records every `--gate-status` it is asked for.
    assert.equal(existsSync(join(s.state, 'gate-asked')), false, 'no gate subprocess was spent');
    // The engine's own gate said `clear`, so a `gated` phase here can only be
    // the review hold — which is exactly the confusion the note has to prevent.
    assert.equal(events.some((e) => e.event === 'run:journal' && e.data.event === 'phase.gated'), false);
  } finally { s.cleanup(); }
});

test('withdrawing the request releases the phase — the same run boards it', async () => {
  const s = stubPlan();
  try {
    const held = await drive(s, { reviewHold: () => [1] });
    assert.deepEqual(held.prompts, []);

    const released = await drive(s, { reviewHold: () => [] });
    assert.equal(released.prompts.length, 1, 'with the hold gone the phase boards');
    assert.match(released.prompts[0]!, /BOOT phase 2/);
  } finally { s.cleanup(); }
});

test('a console with no review surface wired holds nothing at all', async () => {
  const s = stubPlan();
  try {
    const { prompts } = await drive(s);
    assert.equal(prompts.length, 1, 'an absent dep is not an empty hold, it is no hold');
  } finally { s.cleanup(); }
});
