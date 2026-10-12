/**
 * The single-source guards for the LIFECYCLE — and the vocabulary they protect.
 *
 * There is ONE place a run is frozen, thawed, stopped, paused, resumed, held
 * or released (`data/lifecycle.ts`, through `press()`), and ONE place a lane
 * body renders. Neither is expressible as a type: nothing stops the next
 * surface from importing `api` and pressing the door itself, which is exactly
 * how three implementations of "freeze this run" once appeared — one
 * reasonable local decision at a time, each with its own busy string, its own
 * sentence and its own invalidation set.
 *
 * The guard is a source walk, coarse on purpose (see
 * `screens/launch/single-source.test.ts`, whose shape this follows): it
 * asks who may MENTION a door, because a mention is where the drift starts and
 * it is what a reviewer can act on. When one of these fails, the fix is almost
 * never to widen the allow-list: call `useLifecycle` / `pressLifecycle`, or
 * render the Run view's `pane-host`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lifecycleToast, type LifecycleVerb } from './lifecycle';
import type { RunState } from '@/data/api';

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
  it('nothing but data/lifecycle.ts touches a per-run lifecycle door', () => {
    // Seven verbs, one caller.
    expect(
      offenders(/\bapi\.(runFreeze|runThaw|runStop|runPause|runResume|runHold|runRelease)\b/, [
        'data/lifecycle.ts',
      ]),
    ).toEqual([]);
  });

  it('nothing but data/lifecycle.ts and the frozen banner freezes or thaws the FLEET', () => {
    // The same act one scope up. The shell's frozen banner presses Thaw through
    // `press()` itself, because the shell may not reach a screen's performer.
    expect(offenders(/\bapi\.(fleetFreeze|fleetThaw)\b/, ['shell/banners.tsx', 'data/lifecycle.ts'])).toEqual(
      [],
    );
  });

  it('the surfaces that offer these verbs press through the performer', () => {
    // The positive half: the guard above proves nobody rolls their own; this
    // proves the ones that DO offer a lifecycle verb use the shared entry — the
    // run's row (one action on the glance, every other verb in place) and the
    // Run view's lane controls and settings sheet. "It does not roll its own"
    // and "it uses the shared one" are two different facts, and only the second
    // says the controls work.
    const performers = FILES.filter(({ text }) => /from '@\/data\/lifecycle'/.test(text)).map(
      ({ path }) => path,
    );
    expect(performers).toEqual(
      expect.arrayContaining([
        'screens/runs/run-row.tsx',
        'screens/plan/run/lane-controls.tsx',
        'screens/plan/run/settings-sheet.tsx',
      ]),
    );
  });
});

describe('one lane body', () => {
  it('nothing but pane-host renders a queued lane', () => {
    // `RunQueuedPane` is a BODY. The 6.x runs index inlined its own beside a
    // copy of the live one, which is how the two surfaces came to offer
    // different controls on the same queued lane.
    expect(offenders(/<RunQueuedPane\b/, ['screens/plan/run/pane-host.tsx'])).toEqual([]);
  });

  it('no tab strip over lanes is left: the Run view names its panes in the address', () => {
    // The 6.x `LaneTabStrip` owned the force-mount rule. 7.0's sessions fold
    // (`RunSessions`) keeps every pane mounted and picks one with `?lane=`, so
    // a strip that builds its own `<Tabs>` over lanes would be a second copy
    // of that rule, held in component state the address cannot reach.
    const users = FILES.filter(({ text }) => /\bLaneTabStrip\b/.test(text)).map(({ path }) => path);
    expect(users).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The vocabulary itself
 * ------------------------------------------------------------------ */

const run = (over: Partial<RunState> = {}) => ({ status: 'running', ...over }) as RunState;

describe('lifecycleToast', () => {
  it('Resume says which of its two acts the door did (control-tower phase 77, #102)', () => {
    const running = { id: 'r1', status: 'running' } as unknown as RunState;
    expect(
      lifecycleToast('resume', 'demo', undefined, running, { resumed: { act: 'relaunched' } }).message,
    ).toMatch(/started again — with its own settings/);
    expect(
      lifecycleToast('resume', 'demo', undefined, running, { resumed: { act: 'pause-cancelled' } }).message,
    ).toBe('Pause cancelled — the run carries on');
  });

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
