/**
 * The single-source guards for the LIFECYCLE — and the vocabulary they protect.
 *
 * Phase 18's claim is that there is now ONE place a run is frozen, thawed,
 * stopped, paused, resumed, held or released, and ONE place a lane body
 * renders. Neither is expressible as a type: nothing stops the next surface
 * from importing `api` and pressing the door itself, which is exactly how
 * three implementations of "freeze this run" appeared — one reasonable local
 * decision at a time, each with its own busy string, its own sentence and its
 * own invalidation set.
 *
 * The guard is a source walk, coarse on purpose (see
 * `features/run-setup/single-source.test.ts`, whose shape this follows): it
 * asks who may MENTION a door, because a mention is where the drift starts and
 * it is what a reviewer can act on.
 *
 * When one of these fails, the fix is almost never to widen the allow-list. It
 * is to call `useRunLifecycle` / `performLifecycle`, or to render `LanePane`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lifecycleToast, type LifecycleVerb } from './run-lifecycle';
import type { RunState } from '@/lib/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

/** Comments stripped: a prose mention in a module header is documentation. */
const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: decommented(readFileSync(path, 'utf8')),
}));

function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return FILES.filter(({ path, text }) => pattern.test(text) && !allowed.includes(path)).map(
    ({ path }) => path,
  );
}

describe('one lifecycle', () => {
  it('nothing but run-lifecycle.ts touches a per-run lifecycle door', () => {
    // Seven verbs, one caller. `lane-controls.tsx`, `lane-setup.tsx` and
    // `features/runs/index.tsx` each held their own copy of three of them.
    expect(
      offenders(/\bapi\.(runFreeze|runThaw|runStop|runPause|runResume|runHold|runRelease)\b/, [
        'lib/run-lifecycle.ts',
      ]),
    ).toEqual([]);
  });

  it('nothing but run-lifecycle.ts freezes or thaws the FLEET', () => {
    // The same act one scope up. It lived beside its banner until phase 18,
    // which is how a second caller would have gone unnoticed: the guard was
    // over the per-run doors alone.
    expect(offenders(/\bapi\.(fleetFreeze|fleetThaw)\b/, ['lib/run-lifecycle.ts'])).toEqual([]);
  });

  it('the surfaces that offer these verbs import the shared hook', () => {
    // The positive half. The guard above proves nobody rolls their own; this
    // proves the ones that DO offer a lifecycle verb use the shared entry.
    const users = FILES.filter(({ text }) => /from '@\/lib\/run-lifecycle'/.test(text)).map(
      ({ path }) => path,
    );
    expect(users).toEqual(
      expect.arrayContaining([
        'components/fleet-freeze.tsx',
        'features/runs/lane-controls.tsx',
        'features/runs/lane-setup.tsx',
        // Phase 19's board: nine verbs on one card, and the surface the hook
        // was extracted FOR. Named here rather than left to the negative guard
        // because "the board does not roll its own" and "the board uses the
        // shared one" are two different facts, and only the second says the
        // controls work.
        'features/runs/board.tsx',
      ]),
    );
  });
});

describe('one lane body', () => {
  it('nothing but pane-host renders a queued lane', () => {
    // `QueuedPane` is a BODY. The runs index inlined its own beside a copy of
    // the live one, which is how the two surfaces came to offer different
    // controls on the same queued lane.
    expect(offenders(/<QueuedPane\b/, ['features/runs/pane-host.tsx'])).toEqual([]);
  });

  it('the two tab strips share their guts', () => {
    // `LaneTabStrip` owns the force-mount rule — the part that is easy to get
    // wrong and was written out twice. A strip that builds its own `<Tabs>`
    // over lanes is a third copy of it.
    const users = FILES.filter(({ text }) => /\bLaneTabStrip\b/.test(text)).map(({ path }) => path);
    expect(users.sort()).toEqual(['features/runs/index.tsx', 'features/runs/lanes.tsx']);
  });
});

describe('one lane-fact vocabulary', () => {
  it('the three converted surfaces read the shared atoms', () => {
    // C2 is an EXTRACTION, converted one surface at a time. Phase 18 took
    // `LiveStrip` and `PlanPulse`; phase 19's board is the third, and it drew
    // its lane row from the atoms rather than picking facts a fourth way.
    //
    // ⚠️ `now/lane-row.tsx` and `features/sessions/list.tsx` are STILL not
    // converted, and this asserts that rather than glossing it: the board was a
    // new file, so composing the atoms cost nothing, while those two would each
    // change what is on screen — `LaneCost` renders nothing for an absent cost
    // where `LaneRow` always prints `$0.00`, `LaneElapsed` is a live `Duration`
    // where `LaneRow` is a titled badge, and `LaneEta` renders nothing where
    // `LaneRow` says "no ETA". Each of those is a decision, not a move. A guard
    // that overstates is how a done-list stops being readable.
    const users = FILES.filter(({ text }) => /from '@\/components\/lane-facts'/.test(text)).map(
      ({ path }) => path,
    );
    expect(users.sort()).toEqual([
      'components/pulse.tsx',
      'features/runs/board.tsx',
      'features/runs/live-strip.tsx',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The vocabulary itself
 * ------------------------------------------------------------------ */

const run = (over: Partial<RunState> = {}) => ({ status: 'running', ...over }) as RunState;

describe('lifecycleToast', () => {
  it('reports what the SERVER did, not what the click intended', () => {
    // A freeze that lands on nothing answers 200 with an unfrozen run. Saying
    // "frozen" there is the console lying about its own act, and it is the
    // reading each of the three copies had to get right separately.
    expect(lifecycleToast('freeze', 'demo', undefined, run())).toMatchObject({ tone: 'warn' });
    expect(lifecycleToast('freeze', 'demo', undefined, run({ status: 'frozen' }))).toMatchObject({
      tone: 'ok',
    });
    expect(lifecycleToast('thaw', 'demo', undefined, run({ status: 'frozen' }))).toMatchObject({
      tone: 'warn',
    });
    expect(lifecycleToast('pause', 'demo', undefined, run())).toMatchObject({ tone: 'warn' });
  });

  it("reads a LANE's freeze off the lane, never off the run's word", () => {
    // A run whose own status says `frozen` says nothing about phase 9: a run
    // with three lanes is `running` while one of them is stopped, and it is
    // `frozen` while a lane that started since is not. The per-lane fact is
    // `children[9].frozen`, with the single `freeze` slot as the fallback for
    // a run written before lanes carried their own.
    expect(lifecycleToast('freeze', 'demo', 9, run({ status: 'frozen' })).message).toMatch(
      /Nothing to freeze: phase 9/,
    );
    const laneFrozen = run({
      status: 'running',
      children: { 9: { pid: 1, phase: 9, sessionId: 's', startedAt: '', frozen: { at: 'x', by: 'me' } } },
    } as Partial<RunState>);
    expect(lifecycleToast('freeze', 'demo', 9, laneFrozen).message).toMatch(/^Phase 9 /);
  });

  it('names a phase when it has one, and the plan when it does not', () => {
    expect(lifecycleToast('freeze', 'demo', undefined, run({ status: 'frozen' })).message).toMatch(/^demo /);
  });

  it('says DEQUEUED for a queued lane, because nothing was killed', () => {
    // The one fact the endpoints cannot report back, and the reason the hook
    // takes a context at all: a queued lane holds no process, so Stop takes it
    // out of the line and Retry can put it back.
    expect(lifecycleToast('stop', 'demo', 4, run(), { queued: true }).message).toMatch(
      /taken out of the line/,
    );
    expect(lifecycleToast('stop', 'demo', 4, run()).message).toMatch(/stopped —/);
  });

  it('answers for every verb — a new one cannot arrive silently mute', () => {
    const verbs: LifecycleVerb[] = ['pause', 'resume', 'hold', 'release', 'freeze', 'thaw', 'stop'];
    for (const verb of verbs) {
      const { message } = lifecycleToast(verb, 'demo', undefined, run());
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('a hold does not claim to have stopped anything', () => {
    // A hold refuses the next ADMISSION; the phases already running finish and
    // write their handoffs. "Stopped" would be wrong in the one way that
    // matters to somebody deciding between this and Pause.
    expect(lifecycleToast('hold', 'demo', undefined, run()).message).toMatch(/the running phases finish/);
  });
});
