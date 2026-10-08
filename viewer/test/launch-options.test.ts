/**
 * What a launch carries: default skills as an opt-in, and QA turned on at start.
 *
 * Two decisions moved into `startRun` and both are about consent. The machine's
 * default skills used to ride into every run as a side effect of existing; now
 * they ride only when the launch (or the stored preference) says so, and the
 * OFF paths are the ones pinned — the preference must not re-seed a resume, and
 * an unticked box must mean none. QA-on-launch is the same shape: the launch
 * flag (or preference) activates the plan's QA gate BEFORE the runner starts,
 * loudly refuses without `--allow-writes`, and an explicit `qa: false` beats
 * the preference.
 *
 * The runner is stubbed to a recorder: these tests are about what `startRun`
 * DECIDES, and the captured StartOptions are where the decision lands. Nothing
 * here spawns a session.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-launch-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { HUMAN_STEPS_FILE } = await import('../server/human-steps.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
import type { StartOptions } from '../server/runner/runner.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-08-04
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | the tables exist |
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | money moves |

## Phases

### Phase 1 — schema
- **Size:** S
- **Goal:** the tables.

### Phase 2 — cart api endpoint
- **Size:** S
- **Goal:** A cart endpoint that survives a reload.

### Phase 3 — checkout
- **Size:** S
`;

const handoff = (phase: number, title: string) => `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: complete
completed: 2026-08-01
depends_on: [${phase === 1 ? '' : phase - 1}]
blocks: [${phase + 1}]
key_files:
  - src/cart.ts
---

# Phase ${phase}

## What this phase did
It did the thing.
`;

const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(opts: { handoffs?: number[]; plan?: string } = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-launch-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), opts.plan ?? PLAN, 'utf8');
  for (const phase of opts.handoffs ?? []) {
    writeFileSync(
      join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-phase-${phase}.md`),
      handoff(phase, `phase-${phase}`), 'utf8',
    );
  }
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A Service whose runner is a recorder. `startRun`'s job ends where
 * `Runner.start` begins, so everything after the decision is stubbed out.
 */
function service(root: string, over: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: SCRIPTS, logFile: null, defaultSkills: [], ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  // The config home is shared by every test in this file, so each service
  // opens on a known slate — a preference set three tests ago is not part of
  // this test's arrangement.
  svc.savePreferences({ attachDefaultSkills: false, qaByDefault: false });
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);

  const captured: StartOptions[] = [];
  (svc as never as { runnerFor: (slug: string) => unknown }).runnerFor = () => ({
    start: async (options: StartOptions) => {
      captured.push(options);
      return { id: 'run-1', slug: options.slug, status: 'running', phases: {} };
    },
  });
  return { svc, captured };
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Default skills — the attach decision
 * ------------------------------------------------------------------ */

test('with everything off, a silent launch carries no skills at all', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'] });
    assert.equal(captured[0]!.skills, undefined, 'the machine default no longer rides along uninvited');
  } finally { cleanup(); }
});

test('the preference seeds a fresh run, and what was picked rides WITH the defaults', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'] });
    assert.deepEqual(captured[0]!.skills, ['graph-tool']);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], skills: ['investigate'] });
    // A union, not a coup: the attach box and the picker are separate answers,
    // and ticking one must not erase the other.
    assert.deepEqual(captured[1]!.skills, ['graph-tool', 'investigate']);
  } finally { cleanup(); }
});

test('the per-launch choice beats the preference, in both directions', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], attachDefaultSkills: true });
    assert.deepEqual(captured[0]!.skills, ['graph-tool'], 'a tick beats an off preference');
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], attachDefaultSkills: false, skills: ['investigate'] });
    assert.deepEqual(captured[1]!.skills, ['investigate'], 'an untick beats an on preference');
  } finally { cleanup(); }
});

test('an explicit empty list survives as none — the operator unchecked every box', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], skills: [] });
    assert.deepEqual(captured[0]!.skills, []);
  } finally { cleanup(); }
});

test('a resume never re-seeds from the preference — the run answers for itself', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc, captured } = service(root, { defaultSkills: ['graph-tool'] });
    svc.savePreferences({ attachDefaultSkills: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: 'run-1', skills: ['investigate'] });
    assert.deepEqual(captured[0]!.skills, ['investigate'], 'the picked list passes through untouched');
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: 'run-1' });
    assert.equal(captured[1]!.skills, undefined, 'an omission stays an omission, so sticky skills rule');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA on launch
 * ------------------------------------------------------------------ */

test('qa: true turns the gate on before the runner starts, with the waived backfill', async () => {
  const { root, cleanup } = scratch({ handoffs: [1, 2] });
  try {
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], qa: true });
    assert.equal(captured.length, 1, 'the run still started');
    const table = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    // Anchored on the LATEST handoff (phase 2), so phase 1 — complete before
    // activation — is recorded waived rather than left to flip its dependents.
    assert.match(table, /\|\s*1\s*\|\s*waived/);
    const mode = await svc.qaMode('alpha');
    assert.notEqual(mode.mode, 'off');
  } finally { cleanup(); }
});

test('QA on launch without --allow-writes is refused loudly, naming the flag', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root, { allowWrites: false });
    await assert.rejects(() => svc.startRun('alpha', { acknowledgedWaivers: ['announce'], qa: true }), /--allow-writes/);
    assert.equal(captured.length, 0, 'a refused activation must not half-start the run');
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
  } finally { cleanup(); }
});

test('the preference activates QA for a fresh run, and qa: false vetoes it', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root);
    svc.savePreferences({ qaByDefault: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], qa: false });
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')),
      'unticking the box means no activation, whatever the preference says');
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'] });
    assert.ok(existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
    assert.equal(captured.length, 2);
  } finally { cleanup(); }
});

test('a resume does not let the preference activate QA behind the run', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc } = service(root);
    svc.savePreferences({ qaByDefault: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], resumeRunId: 'run-1' });
    assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md')));
  } finally { cleanup(); }
});

test('a plan already under QA starts without another activation write', async () => {
  const { root, cleanup } = scratch({ handoffs: [1] });
  try {
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], qa: true });
    const before = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], qa: true });
    const after = readFileSync(join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'), 'utf8');
    assert.equal(after, before, 'activation is once; a second launch finds the gate already on');
    assert.equal(captured.length, 2);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The claim — a phase somebody else is holding
 * ------------------------------------------------------------------ */

/** Write a lock file the way `phase-lock.sh claim` does. */
function claim(root: string, phase: number, owner: string, leaseSeconds: number) {
  const dir = join(root, 'docs', 'handoffs', 'alpha', '.locks');
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(dir, `phase-0${phase}.lock`),
    `slug=alpha\nphase=${phase}\nowner=${owner}\nhost=box\n`
    + `claimed_at=${now}\nlease_until=${now + leaseSeconds}\nscope=app\n`,
    'utf8',
  );
}

test('a named phase somebody else holds refuses the launch outright', async () => {
  // The defect this closes: this used to answer 200, mint a run, and only
  // degrade to `parked` several subprocesses later inside the runner. The
  // console said a run had started; nothing ran.
  const { root, cleanup } = scratch();
  try {
    claim(root, 1, 'someone/else', 1800);
    const { svc, captured } = service(root);
    await assert.rejects(
      () => svc.startRun('alpha', { acknowledgedWaivers: ['announce'], onlyPhases: [1] }),
      (error: Error) => {
        assert.equal(error.name, 'PhaseClaimedError');
        assert.match(error.message, /claimed by someone\/else/);
        return true;
      },
    );
    assert.equal(captured.length, 0, 'and no run is minted on the way out');
  } finally { cleanup(); }
});

test('a LAPSED claim refuses nothing', async () => {
  const { root, cleanup } = scratch();
  try {
    claim(root, 1, 'someone/else', -60);
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], onlyPhases: [1] });
    assert.equal(captured.length, 1, 'a lease that ran out is not a holder');
  } finally { cleanup(); }
});

test('a whole-plan run is not refused by one claimed phase', async () => {
  // Deliberate asymmetry. A run with no named phases should park the claimed
  // one and get on with the other two; refusing the run would let a single
  // stale-looking claim stop a plan.
  const { root, cleanup } = scratch();
  try {
    claim(root, 1, 'someone/else', 1800);
    const { svc, captured } = service(root);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'] });
    assert.equal(captured.length, 1);
  } finally { cleanup(); }
});

test('retry of a claimed phase is refused too', async () => {
  const { root, cleanup } = scratch();
  try {
    claim(root, 2, 'someone/else', 1800);
    const { svc } = service(root);
    await assert.rejects(
      () => svc.retryPhase('alpha', 2),
      (error: Error) => error.name === 'PhaseClaimedError',
    );
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The launch door opens a plan's `auto-open: host` step (control-tower phase 139)
 *
 * §Architecture 12's safety floor, promised since phase 41: a step the PLAN
 * marked `auto-open: host` opens on the machine at the launch door — behind a
 * capability flag, for a link the launch form SHOWED in full and sent back, and
 * nowhere else. The runner is still a recorder and the opener is a recorder
 * too: nothing here opens a browser or spawns a session.
 * ------------------------------------------------------------------ */

const LINK = 'https://vercel.com/login?next=/cli';
const APPROVAL = 'https://github.com/apps/acme';
const PRESS = { by: 'mobin', via: 'api', origin: 'test', remoteUser: null, door: 'operator' } as never;

/** `PLAN`, with the three bullets a launch door meets: a link to open, a command to run, a link to read. */
const DOOR_PLAN = PLAN
  .replace('- **Goal:** the tables.\n', `- **Goal:** the tables.\n- **Human step:** browser-login · Sign in to Vercel · open: ${LINK} · where: host · auto-open: host\n`)
  .replace('- **Goal:** A cart endpoint that survives a reload.\n',
    '- **Goal:** A cart endpoint that survives a reload.\n- **Human step:** browser-login · Sign the gh CLI in · open: `gh auth login --web` · where: host · auto-open: host\n')
  .replace('### Phase 3 — checkout\n- **Size:** S\n',
    `### Phase 3 — checkout\n- **Size:** S\n- **Human step:** third-party-approval · The org owner approves the app · open: ${APPROVAL} · where: any\n`);

type HostOpened = { opened: boolean; opener?: string; detail?: string };

/** A service whose host opener is a recorder, on a ledger that starts empty (this file's state home is shared by every test). */
function doorService(root: string, over: Record<string, unknown> = {}, open?: (url: string) => Promise<HostOpened>) {
  rmSync(join(INSTANCE_STATE_DIR, HUMAN_STEPS_FILE), { force: true });
  const made = service(root, over);
  const opened: string[] = [];
  (made.svc as unknown as { hostOpener: (url: string) => Promise<HostOpened> }).hostOpener = open
    ? (url) => { opened.push(url); return open(url); }
    : async (url) => { opened.push(url); return { opened: true, opener: 'open' }; };
  return { ...made, opened };
}

type Svc = ReturnType<typeof service>['svc'];
const stepTitled = (svc: Svc, title: string) => svc.humanStepsNow().all().find((step) => step.title === title);
const runJournal = (root: string): { event: string; phase?: number; data: Record<string, unknown> }[] => {
  const file = journalFile(root, 'alpha', 'run-1');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

/** The door's opens are fire-and-forget: a launch has returned while they finish, so a test waits for what they leave. */
async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('LD-1 — a launch that showed the link opens a plan\'s auto-open step ONCE, through the seam: the step reads opened on the host, and the run says so', async () => {
  const { root, cleanup } = scratch({ plan: DOOR_PLAN });
  try {
    const { svc, captured, opened } = doorService(root, { allowTerminal: true });
    // Everything is "shown" — the command and the link with no auto-open word too.
    await svc.startRun('alpha', {
      acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK, 'gh auth login --web', APPROVAL],
    });
    const vercel = () => stepTitled(svc, 'Sign in to Vercel');
    await until(() => vercel()?.state === 'opened', 'the step reads opened');
    assert.deepEqual(opened, [LINK], 'one open of the shown link — not the command, not the link the plan did not mark');
    assert.equal(captured.length, 1, 'and the run started');

    const step = vercel()!;
    assert.equal(step.birth, 'plan');
    assert.equal(step.opened, 1);
    const last = svc.humanStepsNow().history(step.id).at(-1)!;
    assert.deepEqual([last.state, last.verb, last.where, last.by], ['opened', 'open', 'host', 'launch']);

    // The other two bullets were ASKED all the same — recorded, announced — and left shut.
    for (const title of ['Sign the gh CLI in', 'The org owner approves the app']) {
      assert.equal(stepTitled(svc, title)?.state, 'notified', title);
      assert.equal(stepTitled(svc, title)?.opened, 0, title);
    }

    // The step was born before the run, so the line is written on the run the launch made.
    await until(() => runJournal(root).some((line) => line.event === 'phase.human-step-opened'), 'the run\'s journal line');
    const line = runJournal(root).find((entry) => entry.event === 'phase.human-step-opened')!;
    assert.equal(line.phase, 1);
    assert.deepEqual(
      { stepId: line.data.stepId, kind: line.data.kind, where: line.data.where, door: line.data.door, by: line.data.by, n: line.data.n, what: line.data.what },
      { stepId: step.id, kind: 'browser-login', where: 'host', door: 'launch', by: 'mobin', n: 1, what: 'url' },
    );
  } finally { cleanup(); }
});

test('LD-2 — the same launch WITHOUT the link shown opens nothing: not shown, shown spelled another way, nothing sent, a resume — the step is still asked', async () => {
  for (const shown of [undefined, [], [`${LINK}/`], [LINK.replace('https', 'http')], ['https://example.com/']]) {
    const { root, cleanup } = scratch({ plan: DOOR_PLAN });
    try {
      const { svc, opened } = doorService(root, { allowTerminal: true });
      await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, ...(shown ? { autoOpenShown: shown } : {}) });
      assert.equal(stepTitled(svc, 'Sign in to Vercel')?.state, 'notified', `${JSON.stringify(shown)}: asked, and left for a person`);
      // The opens are fire-and-forget, so give one that should not exist its chance to happen.
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(opened, [], JSON.stringify(shown));
      assert.equal(stepTitled(svc, 'Sign in to Vercel')?.opened, 0);
      assert.ok(!runJournal(root).some((line) => line.event.startsWith('phase.human-step-open')), 'and the run has nothing to say about it');
    } finally { cleanup(); }
  }
  // A resume asks nothing at its door, so it opens nothing either.
  const { root, cleanup } = scratch({ plan: DOOR_PLAN });
  try {
    const { svc, opened } = doorService(root, { allowTerminal: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, resumeRunId: 'run-1', autoOpenShown: [LINK] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(opened, []);
    assert.equal(svc.humanStepsNow().all().length, 0, 'a resume records no step of the plan');
  } finally { cleanup(); }
});

test('LD-3 — opening on the machine is behind --allow-terminal or --allow-agent: with neither, a shown link opens nothing; either one alone is enough', async () => {
  for (const [flags, expected] of [
    [{}, []], [{ allowTerminal: false, allowAgent: false }, []], [{ allowTerminal: true }, [LINK]], [{ allowAgent: true }, [LINK]],
  ] as const) {
    const { root, cleanup } = scratch({ plan: DOOR_PLAN });
    try {
      const { svc, opened } = doorService(root, { ...flags });
      await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
      const want = expected.length ? 'opened' : 'notified';
      await until(() => stepTitled(svc, 'Sign in to Vercel')?.state === want, `${JSON.stringify(flags)}: the step reads ${want}`);
      // Give an open that should not exist its chance to happen.
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(opened, [...expected], JSON.stringify(flags));
      assert.equal(stepTitled(svc, 'Sign in to Vercel')?.state, want, `${JSON.stringify(flags)}: asked either way`);
    } finally { cleanup(); }
  }
});

test('LD-4 — a launch never waits on the browser: it returns while the opener is still working, and the step moves when the opener is done', async () => {
  const { root, cleanup } = scratch({ plan: DOOR_PLAN });
  try {
    let release!: (answer: HostOpened) => void;
    const slow = new Promise<HostOpened>((resolve) => { release = resolve; });
    const { svc, captured, opened } = doorService(root, { allowTerminal: true }, () => slow);
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
    assert.equal(captured.length, 1, 'the run started with the opener still out');
    assert.deepEqual(opened, [LINK], 'the opener WAS asked, before the runner started');
    assert.equal(stepTitled(svc, 'Sign in to Vercel')?.state, 'notified', 'and nothing moved yet');
    release({ opened: true, opener: 'open' });
    await until(() => stepTitled(svc, 'Sign in to Vercel')?.state === 'opened', 'the step reads opened once the opener is done');
  } finally { cleanup(); }
});

test('LD-5 — a second launch finds the step already asked: it records nothing again and opens nothing again', async () => {
  const { root, cleanup } = scratch({ plan: DOOR_PLAN });
  try {
    const { svc, captured, opened } = doorService(root, { allowTerminal: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
    await until(() => stepTitled(svc, 'Sign in to Vercel')?.state === 'opened', 'the first open');
    const first = stepTitled(svc, 'Sign in to Vercel')!;
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(captured.length, 2, 'both launches started');
    assert.deepEqual(opened, [LINK], 'the link opened once, not once per launch');
    assert.deepEqual(
      svc.humanStepsNow().all().filter((step) => step.title === 'Sign in to Vercel').map((step) => [step.id, step.opened]),
      [[first.id, 1]], 'one step, opened once',
    );
  } finally { cleanup(); }
});

test('LD-6 — a machine that would not open it, or an opener that throws, fails nothing: the launch goes on, the step stands for a person, the run says why', async () => {
  for (const [name, open, why] of [
    ['an opener that says no', async () => ({ opened: false, opener: 'open', detail: 'this machine has no desktop opener — open the link yourself' }), /no desktop opener/],
    ['an opener that throws', async (): Promise<HostOpened> => { throw new Error('the desktop is locked'); }, /the desktop is locked/],
  ] as const) {
    const { root, cleanup } = scratch({ plan: DOOR_PLAN });
    try {
      const { svc, captured, opened } = doorService(root, { allowTerminal: true }, open);
      const run = await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
      assert.equal(run.id, 'run-1', `${name}: the launch still answered with its run`);
      assert.equal(captured.length, 1);
      await until(() => runJournal(root).some((line) => line.event === 'phase.human-step-open-skipped'), `${name}: the run's journal line`);
      assert.deepEqual(opened, [LINK], name);
      const step = stepTitled(svc, 'Sign in to Vercel')!;
      assert.equal(step.state, 'notified', `${name}: not opened, so still waiting for a person`);
      assert.equal(step.opened, 0);
      const line = runJournal(root).find((entry) => entry.event === 'phase.human-step-open-skipped')!;
      assert.equal(line.data.door, 'launch');
      assert.equal(line.data.where, 'host');
      assert.equal(line.data.stepId, step.id);
      assert.match(String(line.data.why), why);
      assert.ok(!runJournal(root).some((entry) => entry.event === 'phase.human-step-opened'), `${name}: nothing claims it opened`);
    } finally { cleanup(); }
  }
});

test('LD-7 — one link opens one tab per launch, however many steps name it; each step is still asked', async () => {
  const twice = DOOR_PLAN.replace(
    '- **Human step:** browser-login · Sign the gh CLI in · open: `gh auth login --web` · where: host · auto-open: host',
    `- **Human step:** browser-login · Sign in to Vercel for the preview · open: ${LINK} · where: host · auto-open: host`,
  );
  const { root, cleanup } = scratch({ plan: twice });
  try {
    const { svc, opened } = doorService(root, { allowTerminal: true });
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS, autoOpenShown: [LINK] });
    await until(() => stepTitled(svc, 'Sign in to Vercel')?.state === 'opened', 'the first step reads opened');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(opened, [LINK], 'two bullets, one link, one tab');
    assert.equal(stepTitled(svc, 'Sign in to Vercel for the preview')?.state, 'notified', 'the second is asked all the same, and left for a person');
  } finally { cleanup(); }
});

test('LD-8 — the prelude names the item a launch already raised for each step, so the form and the door agree on "already asked" — a session\'s of the same words is not it', async () => {
  const { root, cleanup } = scratch({ plan: DOOR_PLAN });
  try {
    const { svc } = doorService(root, { allowTerminal: true });
    const titles = ['Sign in to Vercel', 'Sign the gh CLI in', 'The org owner approves the app'];
    // A session declared the first step's words on its own: another ask, never the plan's.
    const session = svc.recordHumanStep({
      slug: 'alpha', phase: 1, birth: 'session', step: { kind: 'browser-login', title: 'Sign in to Vercel', open_url: LINK },
    })!;
    const before = await svc.prelude('alpha', { acknowledgedWaivers: ['announce'] });
    assert.deepEqual(before.humanSteps.map((step) => step.what), titles);
    assert.deepEqual(before.humanSteps.map((step) => step.item), [undefined, undefined, undefined], 'the plan has asked nothing yet');

    // A launch with no link shown asks all three and opens none.
    await svc.startRun('alpha', { acknowledgedWaivers: ['announce'], actor: PRESS });
    const asked = titles.map((title) => svc.humanStepsNow().all().find((step) => step.title === title && step.birth === 'plan')!.id);
    assert.ok(!asked.includes(session.id));
    const after = await svc.prelude('alpha', { acknowledgedWaivers: ['announce'] });
    assert.deepEqual(after.humanSteps.map((step) => step.item), asked, 'each step names the plan\'s own item');
  } finally { cleanup(); }
});
