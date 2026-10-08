/**
 * A person's press does what it says (control-tower phase 53, #54 #55 #56).
 *
 * Seen on one run in one morning: `resume-phase` answered 200 and launched
 * nothing because the resume policy said the session was not worth resuming;
 * a Retry answered 200 and the phase re-parked twelve seconds later on the
 * ladder's own rung cap; a `needs-human --needs human-acts` park read
 * `blocked-declared:unknown`, with nothing a person could press to hand the
 * acts to the session; a live account switch answered ok and did not survive.
 *
 * PR-1..3  every boarding verb answers the act it caused, or refuses
 * PR-5     a person's Retry boards outside the automatic ladder (the loop)
 * PR-7     Delegate to the session: the ruling, and the resume with the words
 * PR-8     a live switch persists: journalled, stored, in the pool
 * SW-4     a switch never checkpoints a closing lane — it answers deferred:[N] (#107)
 * SW-5     `when: "boundary"` checkpoints nothing: live lanes finish where they are
 * (PR-4/PR-5's pure half is in `ladder.test.ts`; PR-6 in `recovery-model.test.ts`;
 * PR-9 in `accounts.test.ts`; PR-10 in `prefs.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { rulingsFile, readRulings } = await import('../server/runner/rulings.ts');
const { doorActor, pressActor } = await import('../server/actor.ts');
const { PERSON_SLOT_BY } = await import('../server/runner/ladder.ts');
type RunState = import('../server/runner/state.ts').RunState;
type RungRecord = import('../server/runner/state.ts').RungRecord;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;

const T0 = '2026-09-23T06:00:00.000Z';
const PERSON = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;

/* ------------------------------------------------------------------ *
 * A runner over stub scripts — the shape `runner.test.ts` uses
 * ------------------------------------------------------------------ */

type Repo = {
  root: string;
  scripts: string;
  markDone: (phase: number) => void;
  setInProgress: (phase: number) => void;
  cleanup: () => void;
};

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-press-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  // A linear 3-phase graph: phase N is ready once every earlier phase is done;
  // a phase listed in `inprog` has an in-progress handoff (the board says so).
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""; w=""; i=""; found=0
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif grep -qx "$p" "$S/inprog" 2>/dev/null; then i="$i$p,"; found=1
      elif [ "$found" -eq 0 ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: \${i%,}"; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
if [ "\${2:-}" = "status" ]; then echo "phase \${3:-?}: free"; fi
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    setInProgress: (phase) => writeFileSync(join(state, 'inprog'), `${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

/** A session that does what it was asked — marks its phase done — and remembers each prompt. */
function workingSession(r: Repo, prompts: { phase: number; prompt: string }[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    prompts.push({ phase, prompt: request.prompt });
    r.markDone(phase);
    return ok();
  };
}

function runner(r: Repo, spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

const merit = (rung: string, params?: RungRecord['params']): RungRecord =>
  ({ situation: 'work-in-progress', rung, at: T0, outcome: 'failed', cause: 'merit', ...(params ? { params } : {}) });

/* ------------------------------------------------------------------ *
 * A service over a real plan — the route and service doors
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-23
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
- **Verification:** \`true\`

### Phase 2 — cart api
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-press-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** Replace `startRun` with a recorder that answers the resumed run. */
function recordStarts(svc: ReturnType<typeof service>, root: string): Record<string, unknown>[] {
  const starts: Record<string, unknown>[] = [];
  (svc as unknown as { startRun: (slug: string, options: Record<string, unknown>) => Promise<RunState> }).startRun =
    async (_slug, options) => {
      starts.push(options);
      return loadRun(root, 'alpha', String(options.resumeRunId), null)!;
    };
  return starts;
}

/** A stored run parked on phase 2, its session last seen under `acct-x`. */
function parkedRun(root: string, over: (state: RunState) => void = () => {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.attempts = 1;
  record.sessionId = 'sess-parked';
  over(state);
  saveRun(state);
  return state;
}

/** A session the resume policy calls not worth resuming: large, and paid for by another account. */
function notWorthResuming(state: RunState): void {
  state.accountId = 'acct-y';
  const record = phaseRecord(state, 2);
  record.sessionAccountId = 'acct-x';
  record.tokens = [{
    sessionId: 'sess-parked', endedAt: new Date(Date.now() - 15 * 3_600_000).toISOString(),
    lastContext: 400_000, window: 1_000_000, account: 'acct-x',
  }] as never;
}

type Captured = { status: number; body: Record<string, unknown> };

/** One HTTP call against the real route table, read the way a client reads it. */
async function call(svc: unknown, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method: 'POST',
    // A browser's User-Agent: the console's own client is what presses, and
    // `actorOfRequest` names a UA-less caller `script`, not the operator.
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (press test)' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

const journalOn = (root: string, runId: string) => readFileSync(journalFile(root, 'alpha', runId), 'utf8')
  .split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });

/* ------------------------------------------------------------------ *
 * PR-1..3 — every boarding verb answers the act it caused, or refuses
 * ------------------------------------------------------------------ */

test('PR-1: a resume whose policy says fresh boards the resume brief plus the operator\'s instruction — never 200 over nothing (#54, #55)', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = parkedRun(root, notWorthResuming);
    const armed: unknown[] = [];
    (svc.runnerFor('alpha') as unknown as { recover: (o: unknown) => unknown }).recover = (o) => { armed.push(o); return run; };

    const out = await call(svc, '/api/run/alpha/resume-phase', { phase: 2, instruction: 'The production merge is yours now.' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(armed.length, 0, 'no recovery is armed for a session the policy will not resume');
    // A re-board is a hint, and a hint is not a launch (control-tower phase 86,
    // RS-5): no loop boarded it at this admission, so it answers `queued`.
    assert.equal(out.body.launched, undefined, 'nothing boarded at this admission, so nothing is "launched"');
    const launched = out.body.queued as Record<string, unknown>;
    assert.deepEqual(
      { runId: launched.runId, phase: launched.phase, session: launched.session, brief: launched.brief, position: launched.position },
      { runId: run.id, phase: 2, session: null, brief: 'resume', position: null },
      'the answer names what it set in motion: a fresh session with the resume brief, queued',
    );
    assert.match(String(launched.why), /another account|account/i, 'and why it did not resume');

    // It boarded through the run's own loop, carrying the words.
    assert.equal(starts.length, 1);
    const reboard = (starts[0].reboard as Record<string, unknown>[])[0];
    assert.equal(reboard.phase, 2);
    assert.equal(reboard.rung, 'reboard-resume-brief');
    assert.equal(reboard.brief, 'resume');
    assert.equal(reboard.by, PERSON_SLOT_BY);
    assert.match(String(reboard.instruction), /^The production merge is yours now\./, 'the operator\'s words first');
    assert.match(String(reboard.instruction), /started this session fresh instead of resuming session sess-parked/,
      'then why it is a fresh session');
    assert.equal(starts[0].resumeRunId, run.id);
    assert.equal((starts[0].actor as { door?: string }).door, 'operator', 'the operator\'s door, never an automatic one');

    // The rung sits in the person slot, reading no cap.
    const disk = loadRun(root, 'alpha', run.id, null)!;
    const rungs = disk.recoveries?.['2']?.rungs ?? [];
    assert.equal(rungs.length, 1);
    assert.equal(rungs[0].by, PERSON_SLOT_BY);
    assert.equal(rungs[0].rung, 'reboard-resume-brief');
  } finally {
    svc.close();
  }
});

test('PR-1: the re-board boards the phase with the resume brief AND the words, through the loop (the runner half)', async () => {
  const r = repo();
  try {
    const prompts: { phase: number; prompt: string }[] = [];
    const { instance } = runner(r, workingSession(r, prompts));
    r.markDone(1);
    const stored = newRun({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    stored.status = 'parked';
    stored.phases['1'] = { ...phaseRecord(stored, 1), status: 'done' } as never;
    phaseRecord(stored, 2).status = 'parked';
    saveRun(stored);
    await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stored.id, actor: pressActor(PERSON as never),
      reboard: [{ phase: 2, situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', by: PERSON_SLOT_BY, instruction: 'WORDS-FROM-THE-OPERATOR' }],
    });
    await instance.wait();
    const boarded = prompts.find((p) => p.phase === 2);
    assert.ok(boarded, 'phase 2 boarded');
    assert.match(boarded!.prompt, /BOOT phase 2 of demo/, 'the engine\'s boot prompt');
    assert.match(boarded!.prompt, /WORDS-FROM-THE-OPERATOR/, 'and the operator\'s instruction under the resume brief');
  } finally {
    r.cleanup();
  }
});

test('PR-1: a person\'s recovery that finds it cannot resume after all leaves the phase hinted to board fresh with the words — a rung\'s does not', async () => {
  const r = repo();
  try {
    for (const person of [true, false]) {
      const { instance } = runner(r, async () => ok(), {
        // The transcript cannot be carried to the account paying now.
        portTranscript: () => ({ ported: false, findable: false, why: 'not under this account' }) as never,
      });
      const stored = newRun({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-y' });
      stored.status = 'parked';
      const record = phaseRecord(stored, 1);
      record.status = 'parked';
      record.sessionId = `sess-${person ? 'p' : 'r'}`;
      record.sessionAccountId = 'acct-x';
      saveRun(stored);
      await instance.recover({
        slug: 'demo', root: r.root, runId: stored.id, phase: 1, mode: 'resume',
        instruction: 'Finish the merge.', by: 'operator', ...(person ? { person: true } : {}),
      });
      await instance.wait();
      const after = instance.current()!;
      const hint = phaseRecord(after, 1).boardingHint;
      if (person) {
        assert.equal(hint?.rung, 'reboard-resume-brief', 'the words are kept for the boarding');
        assert.equal(hint?.brief, 'resume');
        assert.equal(hint?.by, PERSON_SLOT_BY);
        assert.match(hint?.instruction ?? '', /^Finish the merge\./);
        assert.match(after.finishedReason ?? '', /boards fresh with the resume brief and the instruction/);
      } else {
        assert.equal(hint, undefined, 'a rung\'s resume leaves the next move to the ladder, as before');
        assert.match(after.finishedReason ?? '', /The next rung is a fresh session/);
      }
    }
  } finally {
    r.cleanup();
  }
});

test('PR-2: a verb that finds nothing to act on refuses with a reason — never 200 {run: null}', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    // A plan with no run at all.
    for (const [verb, body] of [
      ['retry', { phase: 1 }], ['skip', { phase: 1 }], ['pause', {}], ['resume', {}], ['hold', {}], ['release', {}],
      ['resume-phase', { phase: 1, instruction: 'go' }], ['closeout', { phase: 1 }], ['delegate', { phase: 1, instruction: 'go' }],
    ] as const) {
      const out = await call(svc, `/api/run/alpha/${verb}`, body);
      assert.equal(out.status, 409, `${verb} answered ${out.status} ${JSON.stringify(out.body)}`);
      assert.ok(typeof out.body.error === 'string' && out.body.error.length > 10, `${verb} refused without a reason`);
      assert.equal(out.body.run, undefined, `${verb} must not answer a run it did not act on`);
    }
  } finally {
    svc.close();
  }
});

test('PR-2: Retry answers the fresh session it boarded; a resumable resume answers the session it resumes', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = parkedRun(root);
    const retried = await call(svc, '/api/run/alpha/retry', { phase: 2 });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual(retried.body.queued, { runId: run.id, phase: 2, session: null, brief: 'fresh', position: null },
      'a Retry is a re-board: queued, until a loop boards it at its admission (RS-5)');
    assert.equal(starts.length, 1, 'the stored run was continued');

    // A small session under the paying account: resumable, so the recovery resumes IT.
    const resumable = parkedRun(root);
    const armed: Record<string, unknown>[] = [];
    (svc.runnerFor('alpha') as unknown as { recover: (o: Record<string, unknown>) => unknown }).recover =
      (o) => { armed.push(o); return resumable; };
    const out = await call(svc, '/api/run/alpha/resume-phase', { phase: 2, instruction: 'fix the test first' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.queued, { runId: resumable.id, phase: 2, session: 'sess-parked', brief: 'continue', position: null });
    assert.equal(armed.length, 1);
    assert.equal(armed[0].mode, 'resume');
    assert.equal(armed[0].instruction, 'fix the test first');
    assert.equal(armed[0].person, true, 'a person\'s press, so a late failure keeps the words');
    const closeout = await call(svc, '/api/run/alpha/closeout', { phase: 2 });
    assert.equal(closeout.status, 200, JSON.stringify(closeout.body));
    assert.equal(((closeout.body.launched ?? closeout.body.queued) as Record<string, unknown>).brief, 'closeout');
  } finally {
    svc.close();
  }
});

test('PR-3: a resume whose session is still running is refused naming it — nothing is armed, nothing boards', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    parkedRun(root);
    const armed: unknown[] = [];
    (svc.runnerFor('alpha') as unknown as { recover: (o: unknown) => unknown }).recover = (o) => { armed.push(o); return null; };
    (svc as unknown as { declarerPresence: (id: string) => unknown }).declarerPresence =
      (id) => (id === 'sess-parked' ? { presence: 'live', pid: 4242 } : { presence: 'unknown' });
    const out = await call(svc, '/api/run/alpha/resume-phase', { phase: 2, instruction: 'go' });
    assert.equal(out.status, 409);
    assert.match(String(out.body.error), /sess-parked is still running \(pid 4242\)/);
    assert.equal(out.body.sessionId, 'sess-parked', 'the client opens the session instead of erring');
    assert.equal(armed.length, 0);
    assert.equal(starts.length, 0);
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * PR-5 — the loop half of the person slot (#56's first defect)
 * ------------------------------------------------------------------ */

test('PR-5: a person\'s Retry boards a phase whose ladder is spent — the loop does not climb it and park it again (#56)', async () => {
  const r = repo();
  try {
    // The #36 shape: an in-progress handoff, three rungs spent on merit.
    r.setInProgress(1);
    const prompts: { phase: number; prompt: string }[] = [];
    const { instance, events } = runner(r, workingSession(r, prompts));
    const stored = newRun({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    stored.status = 'parked';
    const record = phaseRecord(stored, 1);
    record.status = 'failed';
    record.attempts = 3;
    record.endedAt = T0;
    stored.recoveries = {
      1: { attempts: 3, lastAt: T0, rungs: [merit('resume-own-session', { mode: 'continue' }), merit('reboard-resume-brief'), merit('unblock-session')] },
    } as never;
    saveRun(stored);

    // An automatic Continue: the ladder is spent, and it parks the phase.
    await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stored.id,
      actor: doorActor('converge-relaunch', { by: 'converge', via: 'timer', origin: 'test' }),
    });
    await instance.wait();
    assert.equal(prompts.length, 0, 'nothing boards behind a spent ladder');
    assert.equal(journalled(events, 'phase.ladder-refused').length, 1, 'the cap refused the climb');

    // The person's press, then the Continue it rides on.
    const refusedBefore = journalled(events, 'phase.ladder-refused').length;
    instance.retry(1, undefined, { press: true });
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, actor: pressActor(PERSON as never) });
    await instance.wait();
    assert.deepEqual(prompts.map((p) => p.phase), [1, 2, 3], 'phase 1 boarded — and the run went on');
    assert.equal(journalled(events, 'phase.ladder-refused').length, refusedBefore, 'no cap was read for the press');
    const rung = journalled(events, 'phase.rung').find((line) => line.slot === 'person');
    assert.ok(rung, 'the rung is journalled, naming the slot');
    assert.equal(rung!.by, PERSON_SLOT_BY);
    const history = instance.current()!.recoveries?.['1']?.rungs ?? [];
    assert.equal(history.filter((h) => h.by === PERSON_SLOT_BY).length, 1, 'recorded by: operator');
    assert.equal(instance.current()!.status, 'finished');
  } finally {
    r.cleanup();
  }
});

test('ID-5: a person\'s Retry survives a halt that withdrew it before it boarded — kept open, and re-armed first when the run resumes (#131)', async () => {
  const r = repo();
  try {
    const prompts: { phase: number; prompt: string }[] = [];
    const { instance, events } = runner(r, workingSession(r, prompts));
    // The PR-5 shape: a failed phase whose ladder is spent, so the automatic
    // Continue below boards nothing and leaves the run for the press.
    const stored = newRun({ slug: 'demo', root: r.root, autonomy: 'keep-going', autoRecover: true });
    stored.status = 'parked';
    const record = phaseRecord(stored, 1);
    record.status = 'failed';
    record.attempts = 3;
    record.endedAt = T0;
    stored.recoveries = {
      1: { attempts: 3, lastAt: T0, rungs: [merit('resume-own-session', { mode: 'continue' }), merit('reboard-resume-brief'), merit('unblock-session')] },
    } as never;
    saveRun(stored);
    const relaunch = () => instance.start({
      slug: 'demo', root: r.root, resumeRunId: stored.id,
      actor: doorActor('converge-relaunch', { by: 'converge', via: 'timer', origin: 'test' }),
    });
    await relaunch();
    await instance.wait();
    assert.equal(prompts.length, 0);

    // The person presses Retry; then — before its lane ever spawns — a halt
    // withdraws the queue, and the lane that held the phase ends. That lane's
    // end is where the rungs it was climbing are settled.
    instance.retry(1, undefined, { press: true });
    const ended = new Date(Date.now() + 1000).toISOString();
    (instance as unknown as { settleRungsAfterAttempt: (phase: number, since: string) => void }).settleRungsAfterAttempt(1, ended);
    const person = (instance.current()!.recoveries?.['1']?.rungs ?? []).find((rung) => rung.by === PERSON_SLOT_BY);
    assert.ok(person, 'the press opened a person-slot rung');
    assert.equal(person!.outcome, 'running', 'a person\'s retry is not withdrawn with the queue — it is still owed');
    assert.equal(instance.current()!.phases['1'].boardingHint?.by, PERSON_SLOT_BY, 'and the hint that boards it first is kept');
    assert.equal(journalled(events, 'phase.retry-kept').length, 1, 'the keep is journalled');

    // The resume — even the clock's door, with no press of its own — boards the person's retry.
    await relaunch();
    await instance.wait();
    assert.equal(prompts[0]?.phase, 1, 'the retried phase boarded first');
    const settled = (instance.current()!.recoveries?.['1']?.rungs ?? []).find((rung) => rung.by === PERSON_SLOT_BY && rung.at === person!.at);
    assert.equal(settled?.outcome, 'fixed', 'and its rung settles by what that boarding did');
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * PR-7 — Delegate to the session (#54's second defect)
 * ------------------------------------------------------------------ */

test('PR-7: Delegate records a deviation ruling on human-acts naming the operator, and resumes with the words', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = parkedRun(root, (state) => {
      notWorthResuming(state);
      phaseRecord(state, 2).declared = {
        status: 'needs-human', needs: 'human-acts', reason: 'the production merge is the owner\'s', at: T0,
      } as never;
    });
    const out = await call(svc, '/api/run/alpha/delegate', { phase: 2, instruction: 'Merge it; I trust the gate.' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(((out.body.launched ?? out.body.queued) as Record<string, unknown>).phase, 2);
    assert.ok(typeof out.body.rulingId === 'string', 'the answer names the ruling it wrote');

    const rulings = readRulings(rulingsFile(root, 'alpha'));
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0].kind, 'deviation');
    assert.equal(rulings[0].decisionKey, 'human-acts');
    assert.equal(rulings[0].by, 'operator');
    assert.match(rulings[0].what, /^operator delegated the acts phase 2 kept for a person/);
    assert.equal(rulings[0].why, 'Merge it; I trust the gate.');
    assert.equal(rulings[0].id, out.body.rulingId);

    // Resumed with the instruction that the acts are the session's now.
    const instruction = String((starts[0].reboard as Record<string, unknown>[])[0].instruction);
    assert.match(instruction, /has delegated to this session the acts this phase declared for a person/);
    assert.match(instruction, /do not declare needs-human for them again/);
    assert.match(instruction, /Their words: Merge it; I trust the gate\./);
    const line = journalOn(root, run.id).find((entry) => entry.event === 'phase.delegated');
    assert.ok(line, 'phase.delegated is journalled on the run');
    assert.equal(line!.data?.rulingId, out.body.rulingId);

    // A phase that is not parked on human acts is refused, and nothing is written.
    const other = parkedRun(root, (state) => {
      phaseRecord(state, 2).declared = { status: 'needs-human', needs: 'credential', reason: 'a token', at: T0 } as never;
    });
    const refused = await call(svc, '/api/run/alpha/delegate', { phase: 2, instruction: 'go' });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /not parked on acts kept for a person/);
    assert.equal(readRulings(rulingsFile(root, 'alpha')).length, 1, 'no ruling for a refusal');
    assert.ok(other.id);
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * PR-8 — a live switch persists (#56's second defect)
 * ------------------------------------------------------------------ */

test('PR-8: switch-account on a live runner is journalled, stored at once, and joins the run\'s pool', async () => {
  const r = repo();
  try {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { instance, events } = runner(r, async (request) => {
      await held;
      r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]));
      return ok();
    });
    const started = await instance.start({
      slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-ebbb',
      accounts: [{ id: 'acct-ebbb', minHeadroomPct: 20 }],
    });
    assert.equal(instance.busy(), true);
    const out = instance.switchAccount('default', PERSON as never);
    assert.equal(out.ok, true);
    // Stored NOW — a Continue that loads the run off disk sees the move.
    const disk = JSON.parse(readFileSync(runFile(r.root, 'demo', started.id), 'utf8')) as RunState;
    assert.equal(disk.accountId, undefined, 'the machine login is the omission state');
    assert.ok(disk.accounts?.some((row) => row.id === 'default'), 'the target joins the pool — failover never walks it straight back');
    const switched = journalled(events, 'run.account-switch');
    assert.equal(switched.length, 1);
    assert.equal(switched[0].to, 'default');
    assert.equal(switched[0].by, 'operator');
    release();
    await instance.wait();
  } finally {
    r.cleanup();
  }
});

test('PR-8: a switch pressed while the run is still STARTING lands on the run the start persists', async () => {
  const r = repo();
  const svc = service(r.root);
  try {
    let pass: () => void = () => {};
    const gate = new Promise<void>((resolve) => { pass = resolve; });
    const { instance } = runner(r, async (request) => {
      r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]));
      return ok();
    }, {
      // The auth probe is the start's first await: the window the switch lands in.
      checkAuth: async () => { await gate; return { loggedIn: true, checkedAt: '' }; },
    });
    (svc as unknown as { runners: Map<string, unknown> }).runners.set('demo', instance);
    const starting = instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-ebbb' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(instance.busy(), true, 'a run being started is live to every control');
    const out = svc.switchAccountRun('demo', 'default', PERSON as never);
    assert.equal(out.ok, true, out.reason);
    pass();
    const state = await starting;
    await instance.wait();
    assert.equal(state.accountId, undefined, 'the switch survived the start\'s own save');
    assert.equal(loadRun(r.root, 'demo', state.id, null)!.accountId, undefined);
  } finally {
    svc.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * RS-6 — Resume lifts a SETTLED pause (control-tower phase 77, #102)
 * ------------------------------------------------------------------ */

test('RS-6: resume on a settled pause relaunches the run with its own settings, and answers what it launched (#102)', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = parkedRun(root, (state) => {
      state.status = 'paused';
      state.autonomy = 'halt-on-everything';
      state.permissionProfile = 'bypass';
    });
    const out = await call(svc, '/api/run/alpha/resume', {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.resumed, { runId: run.id, from: 'paused', act: 'relaunched' });
    assert.equal(starts.length, 1, 'the paused run was started again — `pause` then `resume` is not a no-op');
    assert.equal(starts[0].resumeRunId, run.id);
    // The press names no setting, so the stored run's stand (RS-1..3).
    for (const field of ['autonomy', 'permissionProfile', 'relay', 'resumeOnRestart', 'accounts', 'phaseBudgetUsd', 'runBudgetUsd']) {
      assert.equal(starts[0][field], undefined, `resume said ${field} for the run`);
    }
    assert.equal((starts[0].actor as { by?: string } | undefined)?.by, 'operator', 'a person\'s press');
  } finally {
    svc.close();
  }
});

test('RS-6: a pause still being reached is taken back on the live loop; a STOPPED run is continued with its own settings (#176); a finished one is refused', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    // A live loop mid-pause: the pause is cancelled, nothing new is launched.
    const live = parkedRun(root, (state) => { state.status = 'pausing'; });
    let cancelled = 0;
    const runners = (svc as unknown as { runners: Map<string, unknown> }).runners;
    runners.set('alpha', {
      busy: () => true,
      resumePause: () => { cancelled += 1; return true; },
      current: () => ({ ...live, status: 'running' }),
    });
    const out = await call(svc, '/api/run/alpha/resume', {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.resumed, { runId: live.id, from: 'pausing', act: 'pause-cancelled' });
    assert.equal(cancelled, 1);
    assert.equal(starts.length, 0, 'the loop never stopped — nothing to relaunch');

    // No loop behind a `pausing` record (its console went away mid-pause):
    // the read path calls that `interrupted`, and since control-tower phase
    // 110 (#176) Resume continues it through the one door — never a status
    // flipped to a `running` nobody drives.
    runners.delete('alpha');
    const interrupted = parkedRun(root, (state) => { state.status = 'pausing'; });
    const orphaned = await call(svc, '/api/run/alpha/resume', {});
    assert.equal(orphaned.status, 200, JSON.stringify(orphaned.body));
    assert.deepEqual(orphaned.body.resumed, { runId: interrupted.id, from: 'interrupted', act: 'relaunched' });

    // A parked run is continued the same way, naming nothing but the run: the
    // supervisor's remedy for a parked run with ready work pressed this verb,
    // and every press was refused while the run sat for 6.6 hours.
    const parked = parkedRun(root);
    const continued = await call(svc, '/api/run/alpha/resume', {});
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.deepEqual(continued.body.resumed, { runId: parked.id, from: 'parked', act: 'relaunched' });
    assert.deepEqual(starts.map((start) => start.resumeRunId), [interrupted.id, parked.id]);
    for (const field of ['autonomy', 'permissionProfile', 'onlyPhases', 'accountId', 'onLimit']) {
      assert.equal(starts[1]![field], undefined, `resume said ${field} for the run`);
    }

    // A finished run is not Resume's: refused by name, nothing started. (The
    // runs above are finished first — the latest run is the newest unfinished.)
    for (const id of [live.id, interrupted.id, parked.id]) {
      const stored = loadRun(root, 'alpha', id, null)!;
      stored.status = 'finished';
      saveRun(stored);
    }
    parkedRun(root, (state) => { state.status = 'finished'; });
    const refused = await call(svc, '/api/run/alpha/resume', {});
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /No pause of alpha .* its run is finished\./);
    assert.equal(starts.length, 2, 'nothing was started for a refusal');
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * SW-4/SW-5 — a switch never cuts a closing lane, and can wait for the
 * boundary (control-tower phase 78, #107)
 * ------------------------------------------------------------------ */

/**
 * Phase 1's session is a REAL child we can see die — held until released —
 * which, when asked, has already written its handoff or declared its outcome:
 * a lane in its closeout. Every later phase finishes at once.
 */
function closingSession(r: Repo, closing: 'none' | 'outcome' = 'none') {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let child: ReturnType<typeof spawnProcess> | null = null;
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const tokens: (string | undefined)[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    tokens.push(request.env?.CLAUDE_CODE_OAUTH_TOKEN);
    if (phase === 1 && !child) {
      child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
      request.onPid?.(child.pid!);
      request.onEvent?.({ kind: 'init', sessionId: 'sess-closing', model: 'stub-1', tools: 0 });
      if (closing === 'outcome' && request.env?.PE_OUTCOME_FILE) {
        // What `phase-outcome.sh … complete` leaves behind, moments before the session exits.
        writeFileSync(request.env.PE_OUTCOME_FILE, JSON.stringify({
          version: 1, slug: 'demo', phase: 1, status: 'complete', written_at: new Date().toISOString(),
        }));
      }
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    r.markDone(phase);
    return ok({ sessionId: `sess-${phase}` });
  };
  const alive = (): boolean => {
    try { process.kill(child!.pid!, 0); return true; } catch { return false; }
  };
  return { spawn, inSession, release: () => release(), alive, tokens };
}

const tokenEnv = async (accountId: string | undefined) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null);

test('SW-4: a switch does not checkpoint a lane whose handoff already reads complete — it answers deferred:[N] and the lane finishes where it is (#107)', async () => {
  const r = repo();
  const lane = closingSession(r);
  const { instance, events } = runner(r, lane.spawn, {
    accountEnv: tokenEnv,
    // The board reads phase 1 done: its session is only committing and releasing.
    handoffFor: (_slug, phase) => (phase === 1 ? { exists: true, status: 'complete' } : null),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-old' });
    await lane.inSession;
    const out = instance.switchAccount('acct-new', PERSON as never);
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.checkpointed, 0, 'nothing cut');
    assert.deepEqual(out.ok && out.deferred, [1], 'the closing lane is named, not killed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lane.alive(), true, 'the closeout is still running');
    assert.deepEqual(journalled(events, 'phase.checkpointed'), []);
    const switched = journalled(events, 'run.account-switch');
    assert.deepEqual(switched[0].deferred, [1]);
    assert.equal(instance.current()!.accountId, 'acct-new', 'the switch itself took effect — for the next session');
    lane.release();
    await instance.wait();
    assert.deepEqual(lane.tokens, ['tok-acct-old', 'tok-acct-new', 'tok-acct-new'],
      'phase 1 finished on the account it was closing out on; everything after ran on the new one');
  } finally {
    lane.release();
    if (instance.busy()) await instance.stop();
    r.cleanup();
  }
});

test('SW-4: a lane whose session has declared its outcome is closing too — deferred, never checkpointed; an ordinary live lane still is', async () => {
  const r = repo();
  const lane = closingSession(r, 'outcome');
  const { instance } = runner(r, lane.spawn, { accountEnv: tokenEnv });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-old' });
    await lane.inSession;
    const out = instance.switchAccount('acct-new', PERSON as never);
    assert.deepEqual(out.ok && out.deferred, [1]);
    assert.equal(out.ok && out.checkpointed, 0);
    assert.equal(lane.alive(), true);
  } finally {
    lane.release();
    if (instance.busy()) await instance.stop();
    r.cleanup();
  }

  // The control: nothing says it is closing, so "now" means now.
  const r2 = repo();
  const busy = closingSession(r2);
  const second = runner(r2, busy.spawn, { accountEnv: tokenEnv });
  try {
    await second.instance.start({ slug: 'demo', root: r2.root, autonomy: 'keep-going', accountId: 'acct-old' });
    await busy.inSession;
    const out = second.instance.switchAccount('acct-new', PERSON as never);
    assert.equal(out.ok && out.checkpointed, 1, 'a working lane moves at once, as it always did');
    assert.deepEqual(out.ok && out.deferred, []);
  } finally {
    busy.release();
    if (second.instance.busy()) await second.instance.stop();
    r2.cleanup();
  }
});

test('SW-5: switch-account {when: "boundary"} checkpoints nothing — every live lane finishes on the old account, and every later admission is on the new one', async () => {
  const r = repo();
  const lane = closingSession(r);
  const svc = service(r.root);
  const { instance, events } = runner(r, lane.spawn, { accountEnv: tokenEnv });
  (svc as unknown as { runners: Map<string, unknown> }).runners.set('demo', instance);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-ebbb' });
    await lane.inSession;
    const answer = await call(svc, '/api/run/demo/switch-account', { accountId: 'default', when: 'boundary' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body.deferred, [1], 'the answer names the lane that finishes first');
    assert.equal(answer.body.checkpointed, 0);
    assert.equal(lane.alive(), true);
    assert.deepEqual(journalled(events, 'phase.checkpointed'), []);
    assert.equal(journalled(events, 'run.account-switch')[0]?.when, 'boundary');
    lane.release();
    await instance.wait();
    assert.deepEqual(lane.tokens, ['tok-acct-ebbb', undefined, undefined], 'the machine login paid for everything after the boundary');

    const bad = await call(svc, '/api/run/demo/switch-account', { accountId: 'default', when: 'later' });
    assert.equal(bad.status, 400, 'a word the verb does not know is refused, not read as now');
  } finally {
    lane.release();
    if (instance.busy()) await instance.stop();
    svc.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SH-4/SH-6 — the healer's `switch-account` vehicle, wired (control-tower
 * phase 78, #106; the pure rule is in `ladder.test.ts`)
 * ------------------------------------------------------------------ */

test('SH-4/SH-6: the healer\'s switch-account rung reads the LIVE meters of the run\'s own account — room there is a resume in place; a live wall moves it, and a move back names the person it reverses', async () => {
  const root = scratch();
  const svc = service(root);
  const real = (svc as unknown as { accounts: unknown }).accounts;
  try {
    type Room = { ok: boolean; headroomPct: number | null; resetsAt: string | null };
    const rooms: Record<string, Room> = {
      'acct-5398': { ok: true, headroomPct: 95, resetsAt: null },
      'acct-84b6': { ok: true, headroomPct: 36, resetsAt: null },
    };
    const asked: { excluding: string | undefined; until: string | null | undefined }[] = [];
    // The facade, stubbed: the machine's keychain is never touched by a test.
    (svc as unknown as { accounts: unknown }).accounts = {
      roomOf: (id: string | undefined) => rooms[id ?? 'default'],
      switchCandidates: (excluding: string | undefined, _model: string | undefined, opts: { until?: string | null }) => {
        asked.push({ excluding, until: opts.until });
        return { ranked: ['acct-84b6', 'acct-5398'].filter((id) => id !== excluding), declined: [], wake: null };
      },
      entitlementOf: () => ({ state: 'entitled' }),
      labelFor: (id: string | undefined) => id ?? 'the machine login',
      accountIds: () => ['default', 'acct-5398', 'acct-84b6'],
    };
    const state = newRun({ slug: 'alpha', root, accountId: 'acct-5398' });
    const choice = { accountId: 'acct-5398', from: 'acct-84b6', at: '2026-09-24T17:49:32.000Z', by: 'operator' };
    state.accountChoice = choice;
    const record = phaseRecord(state, 2);
    const situation = {
      id: 'resource-wall', sub: 'usage', key: 'resource-wall:usage', label: 'Resource wall', blurb: '', actor: 'machine', why: [],
    };
    type Resolved = { vehicle?: { kind: string; accountId?: string; from?: string; why?: string; reverts?: unknown }; refused?: string };
    const resolve = (svc as unknown as {
      resolveVehicle: (rung: unknown, situation: unknown, record: unknown, evidence: null, slug: string, state: RunState) => Resolved;
    }).resolveVehicle.bind(svc);

    // #106: a stale wall off a checkpoint, the run's account at 5 % — a resume where it is.
    const stay = resolve({ vehicle: 'switch-account' }, situation, record, null, 'alpha', state);
    assert.equal(stay.vehicle?.kind, 'switch-account');
    assert.equal(stay.vehicle?.accountId, 'acct-5398', 'the person\'s choice is not reverted on stale evidence');
    assert.equal(stay.vehicle?.from, 'acct-5398');
    assert.match(stay.vehicle?.why ?? '', /95 %/);

    // A LIVE wall on it now: the rung moves, back to where the person moved it from, and says so.
    const resets = new Date(Date.now() + 3_600_000).toISOString();
    rooms['acct-5398'] = { ok: false, headroomPct: 0, resetsAt: resets };
    const moved = resolve({ vehicle: 'switch-account' }, situation, record, null, 'alpha', state);
    assert.equal(moved.vehicle?.accountId, 'acct-84b6');
    assert.deepEqual(moved.vehicle?.reverts, choice);
    assert.equal(asked.at(-1)?.until, resets, 'the picker weighed the targets against the live wall\'s reset');

    // SH-5: every other account has less room than the one the run is on — refused, nothing moves.
    rooms['acct-5398'] = { ok: false, headroomPct: 3, resetsAt: resets };
    rooms['acct-84b6'] = { ok: true, headroomPct: 2, resetsAt: null };
    const worse = resolve({ vehicle: 'switch-account' }, situation, record, null, 'alpha', state);
    assert.equal(worse.vehicle, undefined);
    assert.match(worse.refused ?? '', /less headroom/);
  } finally {
    (svc as unknown as { accounts: unknown }).accounts = real;
    svc.close();
  }
});

test('SH-6: on a stored run a person\'s switch is remembered as their choice; the ladder\'s move back is journalled as a reversal and announced — its own moves are never a choice', async () => {
  const root = scratch();
  const svc = service(root);
  const told: { category: string; title: string }[] = [];
  (svc as unknown as { announce: (category: string, message: { title: string }) => null }).announce =
    (category, message) => { told.push({ category, title: message.title }); return null; };
  try {
    const run = parkedRun(root, (state) => { state.accountId = 'acct-84b6'; });
    const pressed = svc.switchAccountRun('alpha', 'default', PERSON as never);
    assert.equal(pressed.ok, true, pressed.reason);
    const chosen = loadRun(root, 'alpha', run.id, null)!.accountChoice;
    assert.equal(chosen?.accountId, 'default');
    assert.equal(chosen?.from, 'acct-84b6');
    assert.equal(chosen?.by, 'operator');

    // The ladder's rung, through converge: its own door, on a clock.
    const heal = doorActor('converge-heal', {
      by: 'heal', via: 'timer', origin: 'converge:timer', trigger: 'resource-wall:usage', guard: 'ladder:switch-account',
    });
    const back = svc.switchAccountRun('alpha', 'acct-84b6', heal);
    assert.equal(back.ok, true, back.reason);
    const stored = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(stored.accountId, 'acct-84b6');
    assert.deepEqual(stored.accountChoice, chosen, 'the machine\'s move is not a person\'s choice — the memory stands');
    const reverted = journalOn(root, run.id).filter((line) => line.event === 'run.account-switch-reverted');
    assert.equal(reverted.length, 1);
    assert.equal(reverted[0].data?.from, 'default');
    assert.equal(reverted[0].data?.to, 'acct-84b6');
    assert.deepEqual(told.map((row) => row.category), ['limits']);
    assert.match(told[0].title, /reversed/);
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * RS-5 — a person's re-board outranks the console's candidates, and the
 * verb answers what happened (control-tower phase 86, #128's 2026-09-25T20:04Z
 * comment; #135 D.18)
 * ------------------------------------------------------------------ */

test('RS-5: an operator\'s re-board outranks every console candidate — older console hints and fresh ready phases board after it', async () => {
  const { boardHarness } = await import('./lane-harness.ts');
  const h = boardHarness({ states: { 1: 'ready', 2: 'in-progress', 3: 'in-progress' } });
  const stored = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  stored.status = 'parked';
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  Object.assign(phaseRecord(stored, 2), {
    status: 'pending', attempts: 1, boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: ago(3 * 3_600_000), by: 'console' },
  });
  Object.assign(phaseRecord(stored, 3), {
    status: 'pending', attempts: 1, boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: ago(60_000), by: PERSON_SLOT_BY },
  });
  saveRun(stored);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: stored.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [3, 2, 1], 'the person\'s press first, then seniority, then the phase that never started');
});

test('RS-5: the verb answers launched only when the phase boarded at that admission — queued {position} otherwise', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    recordStarts(svc, root);
    const run = parkedRun(root, notWorthResuming);
    const runner = svc.runnerFor('alpha') as unknown as { boardingVerdict: (phase: number) => Promise<unknown> };
    runner.boardingVerdict = async () => ({ boarded: true });
    const boarded = await call(svc, '/api/run/alpha/resume-phase', { phase: 2, instruction: 'go' });
    assert.equal(boarded.status, 200, JSON.stringify(boarded.body));
    assert.equal((boarded.body.launched as Record<string, unknown>).phase, 2, 'it boarded: launched');
    assert.equal(boarded.body.queued, undefined);

    runner.boardingVerdict = async () => ({ queued: { position: 2, behind: { kind: 'serial', slug: 'alpha', phase: 1, owner: 'phase 1 of this run' } } });
    const queued = await call(svc, '/api/run/alpha/retry', { phase: 2 });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.launched, undefined, 'never launched for a hint');
    const q = queued.body.queued as Record<string, unknown>;
    assert.equal(q.runId, run.id);
    assert.equal(q.position, 2, 'its place in line');
    assert.equal((q.behind as Record<string, unknown>).phase, 1, 'and what it waits behind');
  } finally {
    svc.close();
  }
});

test('RS-5: a live run\'s verdict — a pressed phase serial behind a live lane is queued at position 1, and boarded once its lane holds the scope', async () => {
  const { boardHarness } = await import('./lane-harness.ts');
  let releaseOne!: () => void;
  const one = new Promise<void>((done) => { releaseOne = done; });
  const verdicts: unknown[] = [];
  const { Scheduler } = await import('../server/runner/scheduler.ts');
  const h = boardHarness({
    deps: { scheduler: new Scheduler({ max: 4, locks: () => [] }) },
    states: { 1: 'ready', 2: 'in-progress' },
    onSpawn: async (phase, _request, harness) => {
      if (phase === 1) await one;
      if (phase === 2) verdicts.push(await harness.runner.boardingVerdict(2, 1_000));
    },
  });
  const stored = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  stored.status = 'parked';
  Object.assign(phaseRecord(stored, 2), { status: 'pending', attempts: 1 });
  saveRun(stored);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: stored.id, maxParallel: 1 } as never);
  try {
    for (let i = 0; i < 100 && !h.spawned.includes(1); i++) await new Promise((done) => { setTimeout(done, 20); });
    h.runner.retry(2, undefined, { press: true });
    const verdict = await h.runner.boardingVerdict(2, 2_000) as { queued?: { position: number; behind?: { phase: number } } };
    assert.equal(verdict.queued?.position, 1, 'first in line behind the live lane');
    assert.equal(verdict.queued?.behind?.phase, 1, 'serial behind phase 1');
  } finally {
    releaseOne();
    await h.runner.wait();
  }
  assert.deepEqual(verdicts, [{ boarded: true }], 'once its lane held the scope, the verdict is boarded');
});

test('SW-6: switch-account {dry: true} previews the lanes it would checkpoint and acts on nothing (phase 25, #107 ask 2)', async () => {
  const r = repo();
  const lane = closingSession(r);
  const svc = service(r.root);
  const { instance, events } = runner(r, lane.spawn, { accountEnv: tokenEnv });
  (svc as unknown as { runners: Map<string, unknown> }).runners.set('demo', instance);
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'acct-ebbb' });
    await lane.inSession;
    const now = await call(svc, '/api/run/demo/switch-account', { accountId: 'default', dry: true });
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.equal(now.body.dry, true);
    assert.deepEqual(now.body.wouldCheckpoint, [1], 'a working lane would be cut now');
    assert.deepEqual(now.body.deferred, []);
    const boundary = await call(svc, '/api/run/demo/switch-account', { accountId: 'default', when: 'boundary', dry: true });
    assert.deepEqual(boundary.body.wouldCheckpoint, [], 'at the boundary nothing is cut');
    assert.deepEqual(boundary.body.deferred, [1]);
    // Nothing happened: the lane lives, the run is on its account, nothing journalled.
    assert.equal(lane.alive(), true);
    assert.equal(instance.current()!.accountId, 'acct-ebbb');
    assert.deepEqual(journalled(events, 'phase.checkpointed'), []);
    assert.deepEqual(journalled(events, 'run.account-switch'), []);
  } finally {
    lane.release();
    if (instance.busy()) await instance.stop();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * OD-1..2 (control-tower phase 131, #208) — who pressed is what the press proves
 * ------------------------------------------------------------------ */

test('OD-2: `bin/btw` names itself — its ask is recorded `via: cli` with its label, through the local door', async () => {
  const { actorOfRequest } = await import('../server/api/actor.ts');
  const btw = readFileSync(new URL('../../bin/btw', import.meta.url), 'utf8');
  const userAgent = /-A '([^']+)'/.exec(btw)?.[1];
  assert.ok(userAgent, 'btw sends a User-Agent of its own (it sent none, and read as a script)');
  const actor = actorOfRequest({ headers: { host: '127.0.0.1:4123', 'user-agent': userAgent } }, {}, { by: 'btw' });
  assert.equal(actor.via, 'cli');
  assert.equal(actor.by, 'btw');
  assert.equal(actor.pressDoor, 'local', 'a terminal proves nothing more than this machine');
});

test('OD-1/OD-2: a person\'s press keeps the door it came through beside the start door — a label moves neither', async () => {
  const { actorOfRequest } = await import('../server/api/actor.ts');
  const scripted = actorOfRequest({ headers: { host: '127.0.0.1:4123', 'user-agent': 'curl/8.7.1' } }, {}, { by: 'operator' });
  assert.equal(scripted.by, 'operator', 'the label is recorded as offered');
  assert.equal(scripted.pressDoor, 'local', 'and the door is what the request proved');
  const started = pressActor(scripted);
  assert.equal(started.door, 'operator', 'the start door a person\'s press opens');
  assert.equal(started.pressDoor, 'local', 'the press door rides beside it into run.start');
  assert.equal(doorActor('converge-heal', { by: 'console', via: 'timer', origin: 'pe-hub' }).pressDoor, undefined,
    'an automatic door stamps nothing: its door is read off its clock');
});
