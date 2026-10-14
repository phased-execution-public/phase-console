/**
 * The press vehicle, `pressResume` (turn-by-turn phase 5).
 *
 * PR-1 (#273): a press that lands while its run is PARKING — the loop past
 *       `run.parked`, about to leave — was reserved for a boundary that never
 *       came: `phase.resume-pressed`, then nothing, and the run parked for
 *       good. The unspent reservation now continues the run when the loop
 *       ends, and the phase boards with the press's words.
 * PR-2 (#268): only a PERSON's press is a person-slot recovery. The round's
 *       landing and the supervisor's verb press through doors of their own:
 *       their resume is not `person`, their fresh re-board is a counted rung
 *       signed `console`, and the errand's resume never says "The operator
 *       has done" for them — while a person's press still is, and does.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { service, tempDir } from './verb-harness.ts';
import { DECISION, SLUG, harness, journal, loadRun, parked, saveRun } from './turn-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { doorActor, pressActor } = await import('../server/actor.ts');
const { pressVerb } = await import('../server/verb-press.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;
type StartActor = import('../server/actor.ts').StartActor;

const person = (): StartActor => pressActor({ by: 'mobin', via: 'api', origin: 'local', remoteUser: null });
const watch = (): StartActor => doorActor('watch-landed', { by: 'watch', via: 'timer', origin: 'turn-round', trigger: 'date:x' });
const supervisor = (): StartActor => doorActor('supervisor', { by: 'supervisor', via: 'supervisor', origin: 'supervisor' });

/* ------------------------------------------------------------------ *
 * PR-1 — #273: a press on a parking run
 * ------------------------------------------------------------------ */

/** A plan library whose engine is a stub: phases 1–3, each ready until done.txt names it. */
function stubEngine() {
  const root = tempDir('press-root');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '---\nslug: demo\n---\n# demo\n');
  const scripts = tempDir('press-scripts');
  const doneFile = join(root, 'done.txt');
  writeFileSync(doneFile, '1\n2\n');
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
    done=""; ready=""
    for p in 1 2 3; do
      if grep -qx "$p" "${doneFile}"; then done="$done,$p"; else ready="$ready,$p"; fi
    done
    echo "done: \${done#,}"; echo "ready: \${ready#,}"; echo "waiting:" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  for (const name of ['phase-lock.sh', 'next-phase-prompt.sh', 'new-handoff.sh']) script(name, '#!/usr/bin/env bash\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, doneFile };
}

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('PR-1 (#273): an answer pressed while its run is parking is not lost — the run continues and the phase boards with the words', async () => {
  const { root, scripts, doneFile } = stubEngine();
  const spawned: SpawnRequest[] = [];
  const spawn: SpawnFn = async (request) => {
    spawned.push(request);
    writeFileSync(doneFile, '3\n', { flag: 'a' });
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: 'sess-3b', costUsd: 0, turns: 1, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    };
  };
  const runner = new Runner({ scriptsDir: scripts, spawn, verificationText: () => '`true`' });

  // Phases 1 and 2 done; phase 3 parked on a person's decision, its session ended.
  const stored = newRun({ slug: 'demo', root });
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const p of [1, 2]) Object.assign(phaseRecord(stored, p), { status: 'done', endedAt: at });
  Object.assign(phaseRecord(stored, 3), {
    status: 'parked', sessionId: 'sess-3', attempts: 1, startedAt: at, endedAt: at,
    declared: { status: 'needs-human', reason: 'a person must decide', needs: 'decision', at },
  });
  stored.status = 'parked' as never;
  saveRun(stored);

  const svc = await service(root);
  const bag = svc as unknown as Record<string, unknown> & { runners: Map<string, unknown> };
  bag.runners.set('demo', runner);
  // The service's continuation goes through `startRun`; here it resumes the same runner.
  const continued: { resumeRunId?: string; door?: string }[] = [];
  bag.startRun = async (slug: string, opts: { resumeRunId?: string; actor?: { door?: string } }) => {
    continued.push({ resumeRunId: opts.resumeRunId, door: opts.actor?.door });
    return runner.start({ slug, root, resumeRunId: opts.resumeRunId } as Parameters<typeof runner.start>[0]);
  };

  // The race the tower rehearsal met: the press arrives the moment the loop
  // writes `run.parked`, with the loop still behind the run.
  let press: Promise<unknown> | null = null;
  const words = 'The operator answered `Use Postgres`: keep it on the box.';
  const live = runner as unknown as { record: (event: string, ...rest: unknown[]) => unknown };
  const record = live.record.bind(runner);
  live.record = (event: string, ...rest: unknown[]) => {
    const out = record(event, ...rest);
    if (event === 'run.parked' && !press) press = svc.pressResume('demo', 3, 'resume', { instruction: words, actor: watch() });
    return out;
  };

  try {
    await runner.start({ slug: 'demo', root, resumeRunId: stored.id } as Parameters<typeof runner.start>[0]);
    await until('the loop to park and the press to land', () => press !== null);
    const answer = await press! as { ok: boolean; error?: string };
    assert.equal(answer.ok, true, `the press was taken: ${JSON.stringify(answer)}`);
    await runner.wait();
    await until('the reservation to board phase 3', () => spawned.length > 0);
    await runner.wait();

    assert.deepEqual(continued, [{ resumeRunId: stored.id, door: 'watch-landed' }],
      'the unspent reservation continued the run, once, in the presser\'s name');
    assert.equal(spawned.length, 1, `one session: ${JSON.stringify(spawned.map((s) => s.resume ?? s.prompt.slice(0, 40)))}`);
    assert.match(spawned[0]!.prompt, /keep it on the box/, 'the press\'s words reached the session');
    const after = runner.current()!;
    assert.equal(after.phases['3']?.status, 'done', 'phase 3 ran to done');
  } finally {
    bag.runners.delete('demo');
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * PR-2 — #268: the person slot is a person's
 * ------------------------------------------------------------------ */

type Recovered = { phase: number; mode: string; instruction?: string; person?: boolean };

/** The turn harness, with `recoverPhase` recording whether the press was a person's. */
function recording() {
  const h = harness();
  const recovered: Recovered[] = [];
  (h.svc as unknown as Record<string, unknown>).recoverPhase = async (
    _slug: string, phase: number, mode: string, opts: { instruction?: string; person?: boolean } = {},
  ) => {
    recovered.push({ phase, mode, ...(opts.instruction ? { instruction: opts.instruction } : {}), ...(opts.person ? { person: true } : {}) });
    return null;
  };
  return { h, recovered };
}

test('PR-2 (#268): a resumable phase — a person\'s press resumes in the person slot; the round\'s and the supervisor\'s do not', async () => {
  const { h, recovered } = recording();
  try {
    parked(h, DECISION);
    const mine = await h.svc.pressResume(SLUG, 3, 'resume', { instruction: 'go on', actor: person() });
    assert.equal(mine.ok, true, JSON.stringify(mine));
    const round = await h.svc.pressResume(SLUG, 3, 'resume', { instruction: 'the proof landed', actor: watch() });
    assert.equal(round.ok, true, JSON.stringify(round));
    const verb = await pressVerb(h.svc as never, SLUG, 'resume-phase', { phase: 3, instruction: 'resume it' }, supervisor());
    assert.equal(verb.ok, true, JSON.stringify(verb));
    assert.deepEqual(recovered.map((r) => [r.instruction, r.person ?? false]), [
      ['go on', true],
      ['the proof landed', false],
      ['resume it', false],
    ], 'person: true only for the person\'s press');
  } finally { h.cleanup(); }
});

test('PR-2 (#268): no session to resume — an automatic door\'s fresh re-board is a counted rung signed console, a person\'s stays in the person slot', async () => {
  for (const [actor, expect] of [[person(), 'person'], [watch(), 'console']] as const) {
    const h = harness();
    try {
      const boarded: { by?: string; instruction?: string }[] = [];
      (h.svc as unknown as Record<string, unknown>).startRun = async (
        _slug: string, opts: { reboard?: { by?: string; instruction?: string }[] },
      ) => { boarded.push({ ...opts.reboard?.[0] }); return null; };
      const { state } = parked(h, DECISION);
      const record = phaseRecord(state, 3);
      record.sessionId = undefined;
      saveRun(state);

      await h.svc.pressResume(SLUG, 3, 'resume', { instruction: 'carry on', actor });
      assert.equal(boarded.length, 1, `${expect}: one fresh boarding`);
      assert.equal(boarded[0]!.instruction?.startsWith('carry on'), true);
      const rung = loadRun(h.root, SLUG, state.id)!.recoveries?.['3']?.rungs?.at(-1);
      const line = journal(h.root, state).filter((l) => l.event === 'phase.rung').at(-1)!;
      if (expect === 'person') {
        assert.equal(boarded[0]!.by, 'operator', 'a person\'s boarding hint is the person slot');
        assert.equal(rung?.by, 'operator');
        assert.equal(line.data.slot, 'person');
      } else {
        assert.equal(boarded[0]!.by, 'console', 'the round\'s boarding is the console\'s');
        assert.equal(rung?.by, undefined, 'a counted rung — not the person slot');
        assert.equal(line.data.slot, undefined);
        assert.equal(line.data.by, 'console');
        assert.equal(line.data.door, 'watch-landed', 'the rung names the door that pressed it');
      }
      const pressed = journal(h.root, state).filter((l) => l.event === 'phase.resume-pressed');
      assert.equal(pressed.at(-1)?.data.door, actor.door, 'the press line carries its door as before');
    } finally { h.cleanup(); }
  }
});

/** An errand on a parked phase, its item proved by a ref the console reads (RD-9's shape). */
function errandRun(h: ReturnType<typeof harness>) {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [3] } as never);
  const record = phaseRecord(state, 3);
  record.status = 'parked' as never;
  record.sessionId = 'sess-3';
  record.endedAt = new Date().toISOString();
  const at = new Date().toISOString();
  state.recoveries = { 3: { attempts: 1, lastAt: at, errand: { phase: 3, situation: 'credentials-missing', at, tried: [], need: 'sign gh in', how: 'run gh auth login' } } } as never;
  state.status = 'parked' as never;
  saveRun(state);
  return state;
}

test('PR-2 (#268): the round\'s landed proof resumes the errand in the console\'s words — never "The operator has done" — and not as a person', async () => {
  const { h, recovered } = recording();
  try {
    errandRun(h);
    // What the round's landing hands the errand's resume (`resumeAfterPass`):
    // its own door, `watch-landed`, and what the proof read.
    const answer = await (h.svc as unknown as {
      resumeAnsweredErrand: (slug: string, phase: number, words: string, actor: StartActor,
        proven?: { title: string; read: string }) => Promise<{ ok: boolean }>;
    }).resumeAnsweredErrand(SLUG, 3, '', watch(), { title: 'Sign gh in', read: 'landed — 2020-01-01T00:00:00Z has passed' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(recovered.length, 1, `the round resumed the phase once: ${JSON.stringify(recovered)}`);
    const said = String(recovered[0]!.instruction);
    assert.doesNotMatch(said, /The operator/, 'no claim that an operator acted');
    assert.match(said, /^The console's watch saw what this phase asked a person for \("sign gh in"\) done: its proof landed \(/);
    assert.match(said, /No operator pressed anything/);
    assert.equal(recovered[0]!.person, undefined, 'and not in the person slot');
  } finally { h.cleanup(); }
});

test('PR-2 (#268): a person\'s Done — continue on the same errand still says "The operator (<by>) has done", in the person slot', async () => {
  const { h, recovered } = recording();
  try {
    errandRun(h);
    const answer = await (h.svc as unknown as {
      resumeAnsweredErrand: (slug: string, phase: number, words: string, actor: StartActor) => Promise<{ ok: boolean }>;
    }).resumeAnsweredErrand(SLUG, 3, 'signed in as the bot', person());
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(recovered.length, 1);
    assert.match(String(recovered[0]!.instruction),
      /^The operator \(mobin\) has done what this phase asked a person for \("sign gh in"\) and answered it: Done — continue\./);
    assert.match(String(recovered[0]!.instruction), /Their note: signed in as the bot/);
    assert.equal(recovered[0]!.person, true);

    // The supervisor's press on an errand says who it was, and is no person's.
    recovered.length = 0;
    errandRun(h);
    await (h.svc as unknown as {
      resumeAnsweredErrand: (slug: string, phase: number, words: string, actor: StartActor) => Promise<{ ok: boolean }>;
    }).resumeAnsweredErrand(SLUG, 3, '', supervisor());
    assert.match(String(recovered[0]!.instruction), /^The supervisor \(supervisor\) found what this phase asked a person for/);
    assert.equal(recovered[0]!.person, undefined);
  } finally { h.cleanup(); }
});
