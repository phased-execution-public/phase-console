/**
 * Comments → follow-up, and the auto reviewer (P14).
 *
 * Five things are pinned here, in the order they can go wrong:
 *
 *   1. **the schema bump** — v2 adds `comments` with no migration, which is
 *      only true if a v1 record still reads whole and a v2 record is refused
 *      by a v1 reader rather than half-read;
 *   2. **the comment store**, including the two ways a comment is silently
 *      lost — a verdict written over it, and an id reused after a delete;
 *   3. **the follow-up**, whose ONE load-bearing property is that EVERY
 *      unresolved comment reaches the session. A follow-up that quotes four of
 *      five is worse than none: four things get fixed and the fifth is buried
 *      under an approval-shaped record;
 *   4. **the reviewer's parser**, which must recover a report a session
 *      half-formatted and must NEVER invent a verdict — an `approved`
 *      manufactured by a parser bug is a clean bill of health nobody gave;
 *   5. **both behaviours driven through the actual Runner**: a reviewer that
 *      does not run unless asked, never resumes the author's session, and
 *      charges its dollars to the phase; and a Send back that re-boards the
 *      phase with the comments in the prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-reviewer-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const {
  FOLLOW_UP_RUNG, FOLLOW_UP_SITUATION, MAX_COMMENTS, REVIEW_SCHEMA_VERSION,
  ReviewStore, composeFollowUp, nextCommentId,
} = await import('../server/review.ts');
const {
  DEFAULT_REVIEWER_POLICY, MAX_REVIEWER_COMMENTS, parseReviewerReport, renderDiff, reviewerPrompt,
} = await import('../server/reviewer.ts');
const { Runner } = await import('../server/runner/runner.ts');
import type { PhaseDiff, ReviewComment } from '../server/review.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

function storeIn(): { store: InstanceType<typeof ReviewStore>; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-reviews-'));
  return {
    store: new ReviewStore(() => dir),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const file = (dir: string, phase = 1): string => join(dir, `phase-${String(phase).padStart(2, '0')}.json`);

/* ------------------------------------------------------------------ *
 * 1. the schema bump
 * ------------------------------------------------------------------ */

test('the schema is v2, and a v1 record on disk still reads whole', () => {
  const s = storeIn();
  try {
    assert.equal(REVIEW_SCHEMA_VERSION, 2);
    // Exactly what P13 wrote — no comments field at all.
    writeFileSync(file(s.dir), JSON.stringify({
      version: 1, slug: 'demo', phase: 1, verdict: 'approved', note: 'fine', at: '2026-01-01T00:00:00Z',
    }));
    const read = s.store.get('demo', 1);
    assert.equal(read?.verdict, 'approved');
    assert.equal(read?.note, 'fine');
    assert.equal(read?.comments, undefined, 'a v1 record means no comments, not an empty list');
  } finally { s.cleanup(); }
});

test('a record from a FUTURE schema is refused, not half-read', () => {
  const s = storeIn();
  try {
    writeFileSync(file(s.dir), JSON.stringify({
      version: REVIEW_SCHEMA_VERSION + 1, slug: 'demo', phase: 1, verdict: 'requested-changes', at: 'x',
    }));
    // The safe direction: absent means no verdict, therefore no hold. Guessing
    // at a shape this reader does not know is how a forward-compatible format
    // becomes a corrupt one.
    assert.equal(s.store.get('demo', 1), undefined);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * 2. the comment store
 * ------------------------------------------------------------------ */

test('a comment with no verdict yet records `commented` — which holds nothing', () => {
  const s = storeIn();
  try {
    const rec = s.store.addComment('demo', 1, { path: 'a.ts', line: 4, side: 'new', body: 'this leaks' });
    assert.equal(rec?.verdict, 'commented');
    assert.equal(rec?.comments?.length, 1);
    assert.equal(rec?.comments?.[0].id, 'c1');
    assert.equal(rec?.comments?.[0].line, 4);
  } finally { s.cleanup(); }
});

test('recording a verdict does NOT wipe the comments that were already there', () => {
  const s = storeIn();
  try {
    s.store.addComment('demo', 1, { path: 'a.ts', line: 4, body: 'one' });
    s.store.addComment('demo', 1, { path: 'a.ts', line: 9, body: 'two' });
    // The order a reviewer actually works in: comment, comment, then press
    // Request changes. Before `set` merged, this wrote a fresh record and the
    // follow-up it was about to compose had nothing to quote.
    const after = s.store.set('demo', 1, { verdict: 'requested-changes', note: 'see the comments' });
    assert.equal(after.verdict, 'requested-changes');
    assert.equal(after.comments?.length, 2);
    assert.deepEqual(after.comments?.map((c) => c.body), ['one', 'two']);
  } finally { s.cleanup(); }
});

test('a deleted id is never reused — the next id comes off the highest, not the count', () => {
  const s = storeIn();
  try {
    for (const body of ['one', 'two', 'three']) s.store.addComment('demo', 1, { path: 'a.ts', body });
    s.store.removeComment('demo', 1, 'c2');
    const after = s.store.addComment('demo', 1, { path: 'a.ts', body: 'four' });
    const ids = after?.comments?.map((c) => c.id) ?? [];
    assert.deepEqual(ids, ['c1', 'c3', 'c4'], 'c4, not a second c3');
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  } finally { s.cleanup(); }
});

test('nextCommentId ignores ids it did not mint', () => {
  assert.equal(nextCommentId([]), 'c1');
  assert.equal(nextCommentId([{ id: 'auto-xyz' } as ReviewComment]), 'c1');
  assert.equal(nextCommentId([{ id: 'c9' } as ReviewComment, { id: 'c2' } as ReviewComment]), 'c10');
});

test('resolve is a toggle, and never writes `resolved: false`', () => {
  const s = storeIn();
  try {
    s.store.addComment('demo', 1, { path: 'a.ts', body: 'x' });
    const on = s.store.resolveComment('demo', 1, 'c1');
    assert.equal(on?.comments?.[0].resolved, true);
    const off = s.store.resolveComment('demo', 1, 'c1', false);
    assert.equal(off?.comments?.[0].resolved, undefined);
    // Two spellings of one fact make two different comparisons possible.
    assert.equal(readFileSync(file(s.dir), 'utf8').includes('"resolved": false'), false);
  } finally { s.cleanup(); }
});

test('an unknown comment id is refused rather than silently doing nothing', () => {
  const s = storeIn();
  try {
    s.store.addComment('demo', 1, { path: 'a.ts', body: 'x' });
    assert.equal(s.store.resolveComment('demo', 1, 'c99'), null);
    assert.equal(s.store.removeComment('demo', 1, 'c99'), null);
  } finally { s.cleanup(); }
});

test('the comment cap is a refusal, not a silent drop', () => {
  const s = storeIn();
  try {
    for (let i = 0; i < MAX_COMMENTS; i += 1) s.store.addComment('demo', 1, { path: 'a.ts', body: `#${i}` });
    assert.equal(s.store.addComment('demo', 1, { path: 'a.ts', body: 'one too many' }), null);
    assert.equal(s.store.get('demo', 1)?.comments?.length, MAX_COMMENTS);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * 3. the follow-up
 * ------------------------------------------------------------------ */

const COMMENTS: ReviewComment[] = [
  { id: 'c1', path: 'server/a.ts', line: 12, side: 'new', body: 'this can be null here', at: 'T' },
  { id: 'c2', path: 'server/a.ts', line: 40, side: 'old', body: 'why was this removed?', at: 'T' },
  { id: 'c3', path: 'client/b.tsx', body: 'the whole file is untested', at: 'T' },
  { id: 'c4', path: 'server/c.ts', line: 7, body: 'already fixed', at: 'T', resolved: true },
];

test('EVERY unresolved comment reaches the prompt, with its anchor', () => {
  const text = composeFollowUp({ slug: 'demo', phase: 3, comments: COMMENTS });
  for (const c of COMMENTS.filter((x) => !x.resolved)) {
    assert.ok(text.includes(c.body), `comment ${c.id}'s words are in the prompt`);
    assert.ok(text.includes(c.id), `comment ${c.id}'s id is in the prompt, so it can be answered by id`);
    assert.ok(text.includes(c.path), `comment ${c.id}'s file is in the prompt`);
  }
  assert.ok(text.includes('server/a.ts:12'), 'a line comment is anchored path:line');
  assert.ok(text.includes('server/a.ts:40 (the removed side)'), 'an old-side comment says which side');
  assert.ok(text.includes('client/b.tsx (about the file, not a line)'), 'a file comment says so');
  // The count is stated so the session can check the list it received against
  // the number it was told to expect.
  assert.ok(/left 3 comments/.test(text), 'the count is stated and matches');
});

test('a resolved comment is NOT re-asked for', () => {
  const text = composeFollowUp({ slug: 'demo', phase: 3, comments: COMMENTS });
  assert.equal(text.includes('already fixed'), false, 'an answered comment is not asked again');
});

test('the follow-up says it is not a restart, and still demands the handoff', () => {
  const text = composeFollowUp({ slug: 'demo', phase: 3, comments: COMMENTS, note: 'overall: close' });
  assert.ok(/not a restart/.test(text), 'the session is told nothing it landed was reverted');
  assert.ok(/handoff/.test(text), 'the deliverable is still the handoff');
  assert.ok(/Verification/.test(text), 'and the verification still has to be run');
  assert.ok(text.includes('> overall: close'), 'the overall note is quoted');
});

test('a multi-line comment body cannot escape its block quote', () => {
  const text = composeFollowUp({
    slug: 'demo', phase: 1,
    comments: [{ id: 'c1', path: 'a.ts', body: 'line one\nline two\nline three', at: 'T' }],
  });
  for (const line of ['> line one', '> line two', '> line three']) {
    assert.ok(text.includes(line), `${line} is quoted`);
  }
});

test('an all-resolved comment set produces a follow-up that SAYS it is empty', () => {
  const text = composeFollowUp({
    slug: 'demo', phase: 1,
    comments: [{ id: 'c1', path: 'a.ts', body: 'done', at: 'T', resolved: true }],
  });
  assert.ok(/already marked resolved/.test(text), 'the session is told, rather than left to guess');
  assert.equal(/left 0 comments/.test(text), true);
});

/* ------------------------------------------------------------------ *
 * 4. the reviewer's prompt and parser
 * ------------------------------------------------------------------ */

const DIFF: PhaseDiff = {
  slug: 'demo', phase: 2,
  window: { kind: 'handoff-window', base: 'aaa', tip: 'bbb', note: 'bracketed by the handoffs' },
  commits: [{ sha: 'bbb1111', subject: 'do the thing' }],
  files: [{
    path: 'server/a.ts', status: 'modified', additions: 2, deletions: 1, binary: false,
    hunks: [{
      header: '@@ -1,3 +1,4 @@',
      lines: [
        { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
        { kind: 'del', text: 'const b = 2;', oldLine: 2 },
        { kind: 'add', text: 'const b = 3;', newLine: 2 },
        { kind: 'add', text: 'const c = 4;', newLine: 3 },
      ],
    }],
  }],
  additions: 2, deletions: 1, truncated: false, failed: false,
};

test('the reviewer is told the exit criteria and shown numbered diff lines', () => {
  const text = reviewerPrompt({
    slug: 'demo', phase: 2, title: 'the thing',
    exitCriteria: '1. it does the thing',
    verification: { commands: ['npm test'], ok: true },
    diff: DIFF, policy: 'may-hold',
  });
  assert.ok(text.includes('1. it does the thing'), "the plan's own words, not a paraphrase");
  assert.ok(text.includes('npm test'), 'the verification is named');
  assert.ok(text.includes('server/a.ts'), 'the file list is there');
  assert.ok(/\s2 \+const b = 3;/.test(text), 'lines carry the numbers a finding must anchor to');
  assert.ok(/do not commit/.test(text), 'it is told not to do the work');
});

test('under comment-only the prompt does not even offer requested-changes', () => {
  const text = reviewerPrompt({ slug: 'demo', phase: 2, diff: DIFF, policy: 'comment-only' });
  assert.equal(/"requested-changes"/.test(text), false, 'the verdict is not on the menu');
  assert.ok(/does not allow a reviewer to hold work/.test(text), 'and it is told why');
  const holding = reviewerPrompt({ slug: 'demo', phase: 2, diff: DIFF, policy: 'may-hold' });
  assert.ok(/"requested-changes"/.test(holding));
  assert.ok(/a held plan stops/.test(holding), 'and told what it costs');
});

test('the default policy is the cautious one', () => {
  assert.equal(DEFAULT_REVIEWER_POLICY, 'comment-only');
});

test('a well-formed report parses, findings and all', () => {
  const report = parseReviewerReport(
    'I read it.\n\n```review\n'
    + '{"verdict":"approved","note":"looks right","findings":'
    + '[{"path":"server/a.ts","line":2,"side":"new","body":"nit"}]}\n```',
    'may-hold', ['server/a.ts'],
  );
  assert.equal(report?.verdict, 'approved');
  assert.equal(report?.note, 'looks right');
  assert.deepEqual(report?.findings, [{ path: 'server/a.ts', body: 'nit', line: 2, side: 'new' }]);
});

test('a half-formatted answer is still recovered — a paid-for review is not thrown away over a fence label', () => {
  for (const text of [
    '```json\n{"verdict":"commented","findings":[]}\n```',
    '```\n{"verdict":"commented","findings":[]}\n```',
    'my verdict: {"verdict":"commented","findings":[]} and that is all',
  ]) {
    assert.equal(parseReviewerReport(text)?.verdict, 'commented', `recovered from: ${text.slice(0, 24)}`);
  }
});

test('a body containing braces does not truncate the bare-object recovery', () => {
  const report = parseReviewerReport(
    'no fence here. {"verdict":"commented","note":"the literal {a: 1} is wrong","findings":[]}',
  );
  assert.equal(report?.verdict, 'commented');
  assert.equal(report?.note, 'the literal {a: 1} is wrong');
});

test('no parseable block means NO report — never a fabricated verdict', () => {
  for (const text of ['', 'The code looks fine to me.', '```review\nnot json\n```', '{"verdict":"lgtm"}']) {
    assert.equal(parseReviewerReport(text), null, `no verdict invented from: ${text.slice(0, 24)}`);
  }
});

test('comment-only DOWNGRADES a requested-changes, and records what was asked for', () => {
  const report = parseReviewerReport('```review\n{"verdict":"requested-changes","findings":[]}\n```', 'comment-only');
  assert.equal(report?.verdict, 'commented', 'nothing is held');
  assert.equal(report?.askedFor, 'requested-changes', 'and the ask is not lost');
  // The policy is enforced on the way IN, not by the prompt: a run that said a
  // reviewer may not hold work must not depend on the reviewer reading that.
  const held = parseReviewerReport('```review\n{"verdict":"requested-changes","findings":[]}\n```', 'may-hold');
  assert.equal(held?.verdict, 'requested-changes');
  assert.equal(held?.askedFor, undefined);
});

test('a finding against a path the diff never mentioned is dropped', () => {
  const report = parseReviewerReport(
    '```review\n{"verdict":"commented","findings":['
    + '{"path":"server/a.ts","body":"real"},{"path":"invented/x.ts","body":"hallucinated"}]}\n```',
    'may-hold', ['server/a.ts'],
  );
  assert.deepEqual(report?.findings.map((f) => f.path), ['server/a.ts']);
});

test('findings are capped, and a malformed one is skipped rather than fatal', () => {
  const many = Array.from({ length: MAX_REVIEWER_COMMENTS + 10 }, () => ({ path: 'a.ts', body: 'x' }));
  const report = parseReviewerReport(
    `\`\`\`review\n{"verdict":"commented","findings":${JSON.stringify([
      { path: 'a.ts' }, { body: 'no path' }, null, 'nonsense', ...many,
    ])}}\n\`\`\``,
  );
  assert.equal(report?.findings.length, MAX_REVIEWER_COMMENTS);
  assert.ok(report?.findings.every((f) => f.path && f.body));
});

test('renderDiff names every file even when it can only show some hunks', () => {
  const text = renderDiff(DIFF, 10);
  assert.ok(text.includes('server/a.ts'), 'the file is listed with its real counts');
  assert.ok(/hunks omitted here for length/.test(text), 'and the cut is announced, not silent');
});

/* ------------------------------------------------------------------ *
 * 5. driven through the actual Runner
 * ------------------------------------------------------------------ */

type Stub = { root: string; scripts: string; state: string; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A one-phase plan whose phase boards, verifies and finishes. */
function stubPlan(): Stub {
  const root = mkdtempSync(join(tmpdir(), 'pc-reviewer-run-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx "1" "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready:"; else echo "done:"; echo "ready: 1"; fi
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
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

function outcomeFor(text: string, costUsd = 0): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd, turns: 1, resultText: text,
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

const GOOD_REPORT = '```review\n{"verdict":"commented","note":"read it","findings":'
  + '[{"path":"server/a.ts","line":2,"body":"this can be null"}]}\n```';

/** Run the stub once; hand back every spawn request and the recorded reports. */
async function driveReview(
  s: Stub, deps: Record<string, unknown> = {}, start: Record<string, unknown> = {},
): Promise<{
    requests: SpawnRequest[];
    recorded: { phase: number; report: { verdict: string; findings: unknown[] } }[];
    events: { event: string; data: Record<string, unknown> }[];
  }> {
  const requests: SpawnRequest[] = [];
  const recorded: { phase: number; report: { verdict: string; findings: unknown[] } }[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    requests.push(request);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) {
      writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' });
      return outcomeFor('done', 1);
    }
    // Anything that is not the boot prompt is the reviewer.
    return outcomeFor(GOOD_REPORT, 0.25);
  };
  const runner = new Runner({
    scriptsDir: s.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    reviewer: {
      facts: async (_slug: string, phase: number, policy: string) => ({
        slug: 'demo', phase, policy, diff: DIFF,
      }),
      record: (_slug: string, phase: number, report: { verdict: string; findings: unknown[] }) => {
        recorded.push({ phase, report });
      },
    },
    ...deps,
  } as never);
  await runner.start({ slug: 'demo', root: s.root, onlyPhases: [1], ...start } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  return { requests, recorded, events };
}

test('the reviewer does not run unless the run asked for it', async () => {
  const s = stubPlan();
  try {
    const { requests, recorded } = await driveReview(s);
    assert.equal(requests.length, 1, 'the phase session, and nothing else');
    assert.deepEqual(recorded, [], 'nothing was reviewed and nothing was spent');
  } finally { s.cleanup(); }
});

test('with it on, a finished phase is reviewed by a session that is NOT the author\'s', async () => {
  const s = stubPlan();
  try {
    const { requests, recorded } = await driveReview(s, {}, { reviewEachPhase: true });
    assert.equal(requests.length, 2, 'the phase, then the reviewer');
    const review = requests[1]!;
    // The whole point. A review inherited from the session that wrote the code
    // is the author agreeing with themselves.
    assert.equal(review.resume, undefined, 'the reviewer never resumes the phase session');
    assert.match(review.prompt, /You are reviewing phase 1/);
    assert.match(review.name ?? '', /^Review demo P1$/);
    // Read-only by construction, not merely by instruction: a reviewer with a
    // shell can `git commit`, and then it is a second author.
    assert.deepEqual(review.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(review.tools?.includes('Bash'), false);
    assert.equal(recorded.length, 1, 'the report was recorded');
    assert.equal(recorded[0].report.verdict, 'commented');
    assert.equal(recorded[0].report.findings.length, 1);
  } finally { s.cleanup(); }
});

/**
 * …and not while the console is frozen.
 *
 * The reviewer is a whole `claude` session spawned from inside the drive loop,
 * so it passes through neither `startRun` nor `Scheduler.admit` — the two
 * places a fleet freeze is enforced. QA found the gap by reading this branch
 * cold: a Freeze-all landing after a phase's child resolves (its pid is nulled
 * the instant it does) marked the lane frozen and started a reviewer anyway.
 * That is the "it said frozen and kept working" report, arriving through the
 * one door nothing was watching.
 *
 * The skip is journalled rather than silent: a review that did not happen is a
 * fact about the phase, and the run is about to park frozen in any case.
 */
test('the reviewer does not run while the console is frozen', async () => {
  const s = stubPlan();
  try {
    const { requests, recorded, events } = await driveReview(
      s,
      { fleetHold: () => ({ at: '2026-08-26T10:00:00Z', by: 'mo' }) },
      { reviewEachPhase: true },
    );
    assert.equal(requests.length, 1, 'the phase session, and NOT the reviewer');
    assert.deepEqual(recorded, [], 'nothing was reviewed and nothing was spent');
    const skipped = events.find(
      (e) => e.event === 'run:journal' && e.data.event === 'phase.review-session-skipped',
    );
    assert.ok(skipped, 'and the journal says why, rather than the review simply not appearing');
    assert.match(
      String((skipped!.data.data as Record<string, unknown>).reason),
      /console is frozen by mo/,
    );
  } finally { s.cleanup(); }
});

test('a reviewer that DOES run is one the console can freeze — it reports its handle and pid', async () => {
  const s = stubPlan();
  try {
    const { requests } = await driveReview(s, {}, { reviewEachPhase: true });
    const review = requests[1]!;
    // The gate above stops one STARTING. This is what makes one already running
    // stoppable: a session the console holds no handle or pid for cannot be
    // SIGSTOPped, so a freeze pressed mid-review would leave it running and
    // spending, invisibly. The closeout has carried these for exactly this
    // reason; the reviewer shipped without them.
    assert.equal(typeof review.onHandle, 'function', 'a reviewer with no handle can never be frozen');
    assert.equal(typeof review.onPid, 'function', 'and one with no pid can never be signalled');
  } finally { s.cleanup(); }
});

test("the reviewer's dollars land on the phase and the run", async () => {
  const s = stubPlan();
  try {
    const { events } = await driveReview(s, {}, { reviewEachPhase: true });
    const done = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.review-session-done');
    assert.ok(done, 'the reviewer journalled a result');
    assert.equal((done!.data.data as Record<string, unknown>).costUsd, 0.25);
    // `phase.done` is journalled BEFORE the reviewer runs, so the accounting
    // proof is the record itself: 1 (the phase) + 0.25 (the review).
    const run = events.filter((e) => e.event === 'run:run').at(-1);
    const state = run?.data.state as { spentUsd: number; phases: Record<string, { costUsd: number }> };
    assert.equal(state.spentUsd, 1.25, 'the run total carries the review');
    assert.equal(state.phases['1'].costUsd, 1.25, "and so does the phase's own figure");
  } finally { s.cleanup(); }
});

test('a reviewer that answers unparseably is recorded as producing nothing — not as an approval', async () => {
  const s = stubPlan();
  try {
    const spawn: SpawnFn = async (request: SpawnRequest) => {
      const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
      if (phase) { writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' }); return outcomeFor('done', 1); }
      return outcomeFor('Looks good to me!', 0.25);
    };
    const { recorded, events } = await driveReview(s, { spawn }, { reviewEachPhase: true });
    assert.deepEqual(recorded, [], 'no verdict was stored');
    const done = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.review-session-done');
    assert.equal((done!.data.data as Record<string, unknown>).ok, false);
    assert.match(String((done!.data.data as Record<string, unknown>).reason), /required format/);
  } finally { s.cleanup(); }
});

test('an empty or failed diff is skipped by name, never reviewed as "no changes"', async () => {
  for (const [label, diff] of [
    ['empty', { ...DIFF, files: [] }],
    ['failed', { ...DIFF, failed: true }],
  ] as const) {
    const s = stubPlan();
    try {
      const { requests, events } = await driveReview(s, {
        reviewer: {
          facts: async () => ({ slug: 'demo', phase: 1, policy: 'comment-only', diff }),
          record: () => { throw new Error('must not be reached'); },
        },
      }, { reviewEachPhase: true });
      assert.equal(requests.length, 1, `${label}: no reviewer session was paid for`);
      const skip = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.review-session-skipped');
      assert.ok(skip, `${label}: the skip is journalled with its reason`);
    } finally { s.cleanup(); }
  }
});

test('reviewEachPhase with no review surface wired is journalled, not silently ignored', async () => {
  const s = stubPlan();
  try {
    const { requests, events } = await driveReview(s, { reviewer: undefined }, { reviewEachPhase: true });
    assert.equal(requests.length, 1);
    const skip = events.find((e) => e.event === 'run:journal' && e.data.event === 'phase.review-session-skipped');
    assert.match(String((skip!.data.data as Record<string, unknown>).reason), /no review surface/);
  } finally { s.cleanup(); }
});

/* --- send back --------------------------------------------------------- */

test('Send back re-boards the phase with the comments in the prompt', async () => {
  const s = stubPlan();
  try {
    const requests: SpawnRequest[] = [];
    let sent = false;
    const runner = new Runner({
      scriptsDir: s.scripts,
      spawn: (async (request: SpawnRequest) => {
        requests.push(request);
        const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
        if (phase) writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' });
        return outcomeFor('done', 0);
      }) as SpawnFn,
      verificationText: () => '`true`',
      onEvent: (event: string, data: Record<string, unknown>) => {
        // The operator's act, at the only point inside a test where the run is
        // still alive: the moment the phase reports done.
        if (!sent && event === 'run:phase' && data.status === 'done') {
          sent = true;
          const out = (runner as unknown as {
            sendBack: (p: number, t: string, by?: string) => { ok: boolean; boarded?: boolean };
          }).sendBack(1, composeFollowUp({ slug: 'demo', phase: 1, comments: COMMENTS }), 'tester');
          assert.equal(out.ok, true);
          assert.equal(out.boarded, true, 'a live run boards it itself');
        }
      },
    } as never);
    await runner.start({ slug: 'demo', root: s.root, onlyPhases: [1] } as Parameters<typeof runner.start>[0]);
    await runner.wait();

    assert.equal(requests.length, 2, 'the phase ran, was sent back, and ran again');
    const second = requests[1]!.prompt;
    assert.match(second, /BOOT phase 1/, 'a self-contained boot prompt, not a bare instruction');
    assert.match(second, /REVIEW FOLLOW-UP/, 'carrying the follow-up');
    for (const c of COMMENTS.filter((x) => !x.resolved)) {
      assert.ok(second.includes(c.body), `comment ${c.id} survived into the boarding prompt`);
    }
    // The regression this pins: `resume` used to drop `hint.instruction`, so a
    // follow-up boarded the phase with the generic "you were interrupted" text.
    assert.equal(/RESUMING phase 1/.test(second), false, 'the follow-up REPLACED the generic resume text');
  } finally { s.cleanup(); }
});

test('the board reading `done` does NOT undo a Send back', async () => {
  // The defect this pins, found by writing the test above: the drive loop's
  // reconcile pass closes any record the board has overtaken — and the board
  // goes on reading `done` from the handoff the phase wrote BEFORE the review,
  // which is the very handoff being sent back. Unexempted, the record flipped
  // to `done` between two ticks, the hint went with it, and the follow-up
  // session never boarded.
  const s = stubPlan();
  try {
    let sent = false;
    const boarded: string[] = [];
    const runner = new Runner({
      scriptsDir: s.scripts,
      spawn: (async (request: SpawnRequest) => {
        boarded.push(request.prompt.slice(0, 40));
        const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
        if (phase) writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' });
        return outcomeFor('done', 0);
      }) as SpawnFn,
      verificationText: () => '`true`',
      onEvent: (event: string, data: Record<string, unknown>) => {
        if (!sent && event === 'run:phase' && data.status === 'done') {
          sent = true;
          (runner as unknown as { sendBack: (p: number, t: string) => unknown })
            .sendBack(1, composeFollowUp({ slug: 'demo', phase: 1, comments: COMMENTS }));
        }
      },
    } as never);
    await runner.start({ slug: 'demo', root: s.root, onlyPhases: [1] } as Parameters<typeof runner.start>[0]);
    await runner.wait();
    assert.equal(boarded.length, 2, 'the phase boarded a second time despite a board that reads done');
    const state = (runner as unknown as { state: { phases: Record<string, { attempts: number }> } }).state;
    assert.equal(state.phases['1'].attempts, 2, 'and it is recorded as a second attempt');
  } finally { s.cleanup(); }
});

test('sendBack refuses an empty follow-up, and a running phase', async () => {
  const s = stubPlan();
  try {
    const runner = new Runner({
      scriptsDir: s.scripts,
      spawn: (async () => outcomeFor('done', 0)) as SpawnFn,
      verificationText: () => '`true`',
    } as never);
    const ctl = runner as unknown as {
      sendBack: (p: number, t: string) => { ok: boolean; reason?: string };
    };
    // Not loaded yet: the one refusal that stands in for "no run here".
    const cold = ctl.sendBack(1, 'anything');
    assert.equal(cold.ok, false);
    assert.match(String(cold.reason), /not loaded/);

    await runner.start({ slug: 'demo', root: s.root, onlyPhases: [1] } as Parameters<typeof runner.start>[0]);
    await runner.wait();
    const empty = ctl.sendBack(1, '   ');
    assert.equal(empty.ok, false);
    // An empty follow-up would re-board the phase with the plain resume brief —
    // indistinguishable from a Retry, while the operator believes they sent
    // comments.
    assert.match(String(empty.reason), /something to say/);
  } finally { s.cleanup(); }
});

test('the follow-up boarding has its own situation and rung, so the journal can tell it apart', () => {
  assert.equal(FOLLOW_UP_SITUATION, 'review:follow-up');
  assert.equal(FOLLOW_UP_RUNG, 'reboard-review-follow-up');
});
