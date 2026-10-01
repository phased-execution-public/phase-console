/**
 * Notes on a run (control-tower phase 96, #142).
 *
 * Supervising four runs on 2026-09-25/26, the watchdog kept its own log — about
 * 400 lines in a day of decisions and interventions, each with its reason —
 * because the console held none of them. The next operator, or a supervising
 * agent after a restart, could see what happened to a run but not why: "keep
 * this run on admin@ past its weekly limit" lived in a file nobody else reads,
 * and a phase that boarded after the decision was never told it.
 *
 * NT-1: a note is journalled (`run.note {by, text, pinned}`), kept on the run,
 *       and drawn on the timeline.
 * NT-2: pinning is journalled, and only a PINNED note reaches a session — in
 *       the boarding prompt, where the phase reads it.
 * NT-3: dismissing a run's card with a note is journalled too; it used to live
 *       on the record alone.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { projectTimeline } = await import('../server/analysis/timeline.ts');
const { pinnedNotesBlock } = await import('../server/runner/runner-core.ts');
const { Runner } = await import('../server/runner/runner.ts');
type RunState = import('../server/runner/state.ts').RunState;
type RunNote = import('../server/runner/state.ts').RunNote;
type JournalEntry = import('../server/runner/journal.ts').JournalEntry;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

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
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-run-notes-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** A parked run with no loop behind it — where an operator's note usually lands. */
function storedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.activePhase = 2;
  phaseRecord(state, 2).status = 'parked';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

type Captured = { status: number; body: Record<string, unknown> };

/** One POST through the real `handleApi`, as a browser on this machine sends it. */
async function post(svc: unknown, path: string, body: unknown): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

function journal(root: string, runId: string): JournalEntry[] {
  return readFileSync(journalFile(root, 'alpha', runId), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
}

function stored(root: string, runId: string): RunState {
  return JSON.parse(readFileSync(runFile(root, 'alpha', runId), 'utf8')) as RunState;
}

/* ------------------------------------------------------------------ *
 * NT-1 — a note is journalled, kept, and drawn
 * ------------------------------------------------------------------ */

test('NT-1: POST /api/run/:slug/notes journals run.note {by, text, pinned}, keeps the note on the run, and the timeline draws it', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    const out = await post(svc, '/api/run/alpha/notes', {
      text: '  keep this run on admin@ — its credit covers the weekly limit  ', pinned: true, by: 'mobin',
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const note = out.body.note as RunNote;
    assert.equal(note.text, 'keep this run on admin@ — its credit covers the weekly limit', 'trimmed, never rewritten');
    assert.equal(note.pinned, true);
    assert.equal(note.by, 'mobin');
    assert.match(note.id, /^[0-9a-f]{8,}$/);

    assert.deepEqual(
      stored(root, run.id).notes?.map((one) => [one.id, one.text, one.pinned, one.by]),
      [[note.id, note.text, true, 'mobin']],
      'the note is part of the run record, so the run page and the next boarding read it',
    );

    const line = journal(root, run.id).find((entry) => entry.event === 'run.note');
    assert.ok(line, 'the decision left no line in the run\'s own history');
    assert.equal(line!.data?.id, note.id);
    assert.equal(line!.data?.by, 'mobin');
    assert.equal(line!.data?.text, note.text);
    assert.equal(line!.data?.pinned, true);

    const drawn = projectTimeline(journal(root, run.id)).marks.filter((mark) => mark.kind === 'note');
    assert.equal(drawn.length, 1, 'the timeline does not draw the note');
    assert.match(drawn[0]!.label, /keep this run on admin@/);
  } finally {
    svc.close();
  }
});

test('NT-1: a note naming a phase is that phase\'s line; an empty note, a bad phase and a plan with no run are refused', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    // No run of the plan yet: there is nothing to write a note on, and saying
    // so beats a 200 over a note nobody will ever see.
    const none = await post(svc, '/api/run/alpha/notes', { text: 'too early' });
    assert.equal(none.status, 409, JSON.stringify(none.body));
    assert.match(String(none.body.error), /no run/i);

    const run = storedRun(root);
    const empty = await post(svc, '/api/run/alpha/notes', { text: '   ' });
    assert.equal(empty.status, 400);
    const bad = await post(svc, '/api/run/alpha/notes', { text: 'x', phase: 'two' });
    assert.equal(bad.status, 400);

    const out = await post(svc, '/api/run/alpha/notes', { text: 'do not re-clone mounts in this worktree', phase: 2 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((out.body.note as RunNote).phase, 2);
    assert.equal((out.body.note as RunNote).pinned, false, 'a note is not pinned unless somebody pins it');
    const line = journal(root, run.id).find((entry) => entry.event === 'run.note');
    assert.equal(line?.phase, 2, 'a phase\'s note is filed on that phase, so its history shows it');
    assert.equal(line?.data?.by, 'operator', 'no label offered: the request\'s derived actor');
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * NT-2 — only a pinned note reaches a session
 * ------------------------------------------------------------------ */

test('NT-2: pinning and unpinning are journalled, and only a PINNED note is in a phase\'s notes block', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    const standing = (await post(svc, '/api/run/alpha/notes', { text: 'every run stays on admin@', pinned: true })).body.note as RunNote;
    const forTwo = (await post(svc, '/api/run/alpha/notes', { text: 'phase 2 keeps the old schema', pinned: true, phase: 2 })).body.note as RunNote;
    const passing = (await post(svc, '/api/run/alpha/notes', { text: 'looked at the lock, it is fine' })).body.note as RunNote;

    const unpin = await post(svc, '/api/run/alpha/notes', { id: standing.id, pinned: false, by: 'mobin' });
    assert.equal(unpin.status, 200, JSON.stringify(unpin.body));
    const moved = journal(root, run.id).filter((entry) => entry.event === 'run.note-pinned');
    assert.deepEqual(moved.map((entry) => [entry.data?.id, entry.data?.pinned, entry.data?.by]), [[standing.id, false, 'mobin']]);

    const notes = stored(root, run.id).notes ?? [];
    assert.equal(notes.find((one) => one.id === standing.id)?.pinned, false);

    const two = pinnedNotesBlock(notes, 2);
    assert.match(two, /phase 2 keeps the old schema/);
    assert.doesNotMatch(two, /every run stays on admin@/, 'an unpinned note is history, not a standing decision');
    assert.doesNotMatch(two, new RegExp(passing.text), 'an unpinned note never reaches a session');
    assert.equal(pinnedNotesBlock(notes, 1), '', 'a note pinned to phase 2 is not phase 1\'s');
    assert.equal(pinnedNotesBlock(undefined, 1), '', 'no notes: the prompt is byte-identical to what it was');

    const repin = await post(svc, '/api/run/alpha/notes', { id: standing.id, pinned: true });
    assert.equal(repin.status, 200);
    assert.match(pinnedNotesBlock(stored(root, run.id).notes, 1), /every run stays on admin@/);

    const unknown = await post(svc, '/api/run/alpha/notes', { id: 'feedfacefeed', pinned: false });
    assert.equal(unknown.status, 404);
    assert.ok(forTwo.id);
  } finally {
    svc.close();
  }
});

test('NT-2: a pinned note reaches the session in its boarding prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-run-notes-board-'));
  trash.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const doneFile = join(root, 'done');
  writeFileSync(doneFile, '');
  const script = (name: string, body: string) => {
    writeFileSync(join(scripts, name), body, 'utf8');
    chmodSync(join(scripts, name), 0o755);
  };
  script('phase-graph.sh', `#!/usr/bin/env bash
set -u
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "${doneFile}"; then echo "done: 1"; echo "ready:"; else echo "done:"; echo "ready: 1"; fi
    echo "waiting:" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  for (const name of ['phase-lock.sh', 'next-phase-prompt.sh', 'new-handoff.sh']) script(name, '#!/usr/bin/env bash\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');

  // The run exists before the phase boards, carrying the operator's decision.
  const earlier = newRun({ slug: 'demo', root });
  earlier.status = 'interrupted';
  earlier.notes = [
    { id: 'a1b2c3d4', at: '2026-09-26T07:10:00.000Z', by: 'mobin', text: 'keep this run on admin@ past its weekly limit', pinned: true },
    { id: 'b1b2c3d4', at: '2026-09-26T07:11:00.000Z', by: 'mobin', text: 'an aside nobody pinned', pinned: false },
  ];
  saveRun(earlier);

  const prompts: string[] = [];
  const spawn: SpawnFn = async (request) => {
    prompts.push(request.prompt);
    writeFileSync(doneFile, '1\n', { flag: 'a' });
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: 'sess-0096', costUsd: 0, turns: 1, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    };
  };
  const runner = new Runner({ scriptsDir: scripts, spawn, verificationText: () => '`true`' });
  await runner.start({ slug: 'demo', root, resumeRunId: earlier.id, onlyPhases: [1] } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  assert.ok(prompts.length, 'the phase never boarded, so there is no prompt to read');
  assert.match(prompts[0]!, /keep this run on admin@ past its weekly limit/, 'the pinned decision never reached the session');
  assert.doesNotMatch(prompts[0]!, /an aside nobody pinned/);
});

/* ------------------------------------------------------------------ *
 * NT-3 — a dismissal's note is journalled
 * ------------------------------------------------------------------ */

test('NT-3: resolve {note} is journalled on the run it dismissed, with who asked', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root, { status: 'halted' });
    const out = await post(svc, '/api/run/alpha/resolve', { runId: run.id, note: 'superseded by the rerun', by: 'mobin' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const line = journal(root, run.id).find((entry) => entry.event === 'run.resolved');
    assert.ok(line, 'the dismissal and its note live on the record alone — the history cannot explain it');
    assert.equal(line!.data?.note, 'superseded by the rerun');
    assert.equal(line!.data?.by, 'mobin');
    assert.equal(line!.data?.stored, true);
  } finally {
    svc.close();
  }
});
