/**
 * The lifecycle verbs — freeze, thaw, stop, pause, resume, hold, release, and
 * the two fleet-wide ones — in ONE place.
 *
 * ## What was wrong
 *
 * There were three implementations of "freeze this run", and they differed in
 * every way a caller can differ: `LaneControls` kept its own `busy` string and
 * invalidated `runs` + `run(slug)`; the runs index kept a `resolvingId` and
 * invalidated `runs` alone; `lane-setup.tsx` went through the run page's
 * `act()` and invalidated `run(slug)` + `approvals` + `plan(slug)`. Same verb,
 * three refresh sets, three toast vocabularies. Nothing errors when they
 * disagree — a press just leaves a stale card somewhere, on whichever surface
 * happened to have the thinner invalidation, and the operator reads it as the
 * console lying about what it did.
 *
 * The immediate cost was a fourth: the orchestration board (phase 19) puts
 * every one of these verbs on a card, and a board that rolled its own would
 * have been the fourth set of rules over the same six endpoints.
 *
 * ## What this is
 *
 * `useRunLifecycle(slug, phase?)` — one busy shape, one toast vocabulary, one
 * invalidation set. `phase` is what makes the same hook serve a lane control
 * and a whole-run control: the endpoints already take an optional phase, and
 * the SENTENCES differ (`Phase 9 frozen — its session…` vs `demo frozen — its
 * sessions…`), which is exactly the kind of near-duplication that drifts when
 * it is written three times.
 *
 * ## The invalidation set is a union, deliberately
 *
 * Every verb refreshes `runs` + `run(slug)` + `plan(slug)` + `approvals`, which
 * is the union of what the three callers each did separately. Over-invalidating
 * costs a refetch of queries that are actually mounted; under-invalidating
 * costs a screen that disagrees with the server, and the three-way split was
 * the proof that nobody can keep three subsets right.
 *
 * ⚠️ **`single-source.test.ts` pins this file as the only caller** of the
 * freeze/thaw/stop/pause/resume/hold/release doors. When it fails, the fix is
 * to use the hook, not to widen the allow-list.
 */

import { useCallback, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { RunState } from '@/lib/api';
import { keys } from '@/lib/queries';
import { toast } from '@/components/ui';

/** The seven per-run verbs, in the order an operator escalates through them. */
export type LifecycleVerb = 'pause' | 'resume' | 'hold' | 'release' | 'freeze' | 'thaw' | 'stop';

/**
 * The one fact about a lane the endpoints cannot report back.
 *
 * A queued lane holds no process, so stopping it DEQUEUES rather than kills —
 * a different sentence, and the only per-caller variation in the vocabulary.
 * It is passed in rather than inferred because the caller is the surface that
 * already knows (`lane.queued`), and re-deriving it from the run the door
 * returned would read the state AFTER the act.
 */
export interface LifecycleContext {
  queued?: boolean;
}

/** A run's freeze, wherever it is recorded — the run's slot, or the lane's. */
function frozenNow(run: RunState | null | undefined, phase?: number): boolean {
  if (!run) return false;
  if (phase != null) {
    const child = run.children?.[String(phase)];
    if (child?.frozen) return true;
    return Boolean(run.freeze && run.freeze.phase === phase);
  }
  return run.status === 'frozen' || Boolean(run.freeze);
}

/** How many of a run's sessions are stopped where they stood. */
function frozenCount(run: RunState | null | undefined): number {
  return Object.values(run?.children ?? {}).filter((child) => child.frozen).length;
}

/**
 * What the SERVER did, in one sentence — never what the click intended.
 *
 * Each of these reads the run the door handed back rather than assuming the
 * press landed. A freeze that finds no session used to answer 200 and say
 * nothing at all, which reads as "it worked".
 */
export function lifecycleToast(
  verb: LifecycleVerb,
  slug: string,
  phase: number | undefined,
  after: RunState | null | undefined,
  context: LifecycleContext = {},
): { message: string; tone: 'ok' | 'warn' } {
  const where = phase != null ? `Phase ${phase}` : slug;
  switch (verb) {
    case 'freeze': {
      const held = frozenNow(after, phase);
      if (!held) {
        return {
          message:
            phase != null
              ? `Nothing to freeze: phase ${phase} has no running session.`
              : `Nothing to freeze: no session is running on ${slug}.`,
          tone: 'warn',
        };
      }
      const count = frozenCount(after);
      return {
        message:
          phase != null
            ? `${where} frozen — its session is stopped where it stood`
            : count > 1
              ? `${where} frozen — ${count} sessions are stopped where they stood`
              : `${where} frozen — its sessions are stopped where they stood`,
        tone: 'ok',
      };
    }
    case 'thaw': {
      const still = frozenNow(after, phase);
      return still
        ? {
            message: `${where} could not be continued — open the autopilot and look at the status`,
            tone: 'warn',
          }
        : { message: `${where} continued — the session picks up mid-token`, tone: 'ok' };
    }
    case 'stop':
      return {
        message:
          phase == null
            ? `${where} stopping — sessions get SIGTERM and the run winds down`
            : // A queued lane has no process: stopping it takes it OUT OF THE
              // LINE. Saying "stopped" would claim a session was killed that
              // never existed, and Retry can put a dequeued phase back.
              context.queued
              ? `${where} taken out of the line — the rest of the run carries on`
              : `${where} stopped — the rest of the run carries on`,
        tone: 'ok',
      };
    case 'pause':
      if (after?.status !== 'pausing') {
        return { message: `Nothing to pause: no phase is running on ${slug}.`, tone: 'warn' };
      }
      return {
        message:
          after.pause?.afterPhase != null
            ? `Pause armed — phase ${after.pause.afterPhase} finishes first`
            : 'Pause armed — stopping at the next phase boundary',
        tone: 'ok',
      };
    case 'resume':
      return after?.status === 'pausing'
        ? {
            message: 'The pause could not be cancelled — reload and look at the status',
            tone: 'warn',
          }
        : { message: 'Pause cancelled — the run carries on', tone: 'ok' };
    case 'hold':
      // A hold refuses the next ADMISSION; the phases already running finish
      // and write their handoffs. Saying "stopped" here would be wrong in the
      // one way that matters — nothing in flight is touched.
      return {
        message: `${slug} held — the running phases finish, and nothing new is admitted`,
        tone: 'ok',
      };
    case 'release':
      return { message: `${slug} released — it may be admitted again`, tone: 'ok' };
  }
}

/** The door each verb goes through. One table, so nothing is reachable twice. */
const DOORS: Record<LifecycleVerb, (slug: string, phase?: number) => Promise<{ run?: RunState | null }>> = {
  freeze: (slug, phase) => api.runFreeze(slug, phase),
  thaw: (slug, phase) => api.runThaw(slug, phase),
  stop: (slug, phase) => api.runStop(slug, phase),
  pause: (slug) => api.runPause(slug),
  resume: (slug) => api.runResume(slug),
  hold: (slug) => api.runHold(slug),
  release: (slug) => api.runRelease(slug),
};

/**
 * The performer: one verb, start to finish, with no React state of its own.
 *
 * `useRunLifecycle` is this plus a busy word. It is exported separately for
 * the one caller that cannot bind a hook to a slug — the fleet TABLE, whose
 * rows are a different run each and whose handler is handed the row. Same
 * doors, same sentences, same invalidation; the alternative was a fourth
 * implementation for the surface with the most rows on it.
 */
export async function performLifecycle(
  client: QueryClient,
  verb: LifecycleVerb,
  slug: string,
  phase?: number,
  context: LifecycleContext = {},
): Promise<void> {
  try {
    const { run: after } = await DOORS[verb](slug, phase);
    const { message, tone } = lifecycleToast(verb, slug, phase, after, context);
    toast(message, tone);
  } catch (error) {
    toast(String((error as Error)?.message ?? error), 'error');
  } finally {
    // `void`, never `await`: `invalidateQueries` resolves only once the
    // refetch settles, and awaiting it would hold a caller's busy flag for the
    // length of a round trip after the act itself has landed.
    //
    // The SET is `keys.afterRunAct` and not a list written out here: it was a
    // second copy of the same four keys, and two copies of an invalidation set
    // are how one surface refreshes after a verb and its neighbour does not.
    for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
  }
}

export interface RunLifecycle {
  /** The verb in flight, or `null`. One string, so one spinner rule. */
  busy: LifecycleVerb | null;
  /** Run any verb. Resolves once the door answered and the toast is out. */
  act: (verb: LifecycleVerb) => Promise<void>;
  freeze: () => Promise<void>;
  thaw: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  hold: () => Promise<void>;
  release: () => Promise<void>;
}

export function useRunLifecycle(slug: string, phase?: number, context: LifecycleContext = {}): RunLifecycle {
  const client = useQueryClient();
  const [busy, setBusy] = useState<LifecycleVerb | null>(null);
  const queued = context.queued;

  const act = useCallback(
    async (verb: LifecycleVerb) => {
      setBusy(verb);
      try {
        await performLifecycle(client, verb, slug, phase, { ...(queued ? { queued } : {}) });
      } finally {
        setBusy(null);
      }
    },
    [client, slug, phase, queued],
  );

  return {
    busy,
    act,
    freeze: useCallback(() => act('freeze'), [act]),
    thaw: useCallback(() => act('thaw'), [act]),
    stop: useCallback(() => act('stop'), [act]),
    pause: useCallback(() => act('pause'), [act]),
    resume: useCallback(() => act('resume'), [act]),
    hold: useCallback(() => act('hold'), [act]),
    release: useCallback(() => act('release'), [act]),
  };
}

/* ================================================================== *
 * The fleet pair
 * ================================================================== */

/**
 * Freeze and thaw the whole console. One hook, two verbs.
 *
 * It lives here rather than beside the banner because it is the same act at a
 * different scope, and the single-source guard is over the DOORS, not over the
 * per-run ones alone: a fleet freeze that grew a second caller would be the
 * same defect one level up.
 *
 * `keys.state()` is the invalidation that matters — the banner and every
 * control read `fleet` from there — and the queue goes with it because every
 * waiting entry's holder changes at the same instant. The server also emits
 * `run:queue`, which invalidates both; this makes the press feel immediate on
 * the tab that made it rather than waiting for the round trip.
 */
export function useFleetLifecycle() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<'freeze' | 'thaw' | null>(null);

  const run = useCallback(
    async (verb: 'freeze' | 'thaw') => {
      setBusy(verb);
      try {
        if (verb === 'freeze') {
          const result = await api.fleetFreeze();
          toast(
            result.runs === 1
              ? 'Console frozen — 1 run held where it stands.'
              : `Console frozen — ${result.runs} runs held where they stand.`,
            'ok',
          );
        } else {
          await api.fleetThaw();
          toast('Console thawed — everything carries on from where it was.', 'ok');
        }
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setBusy(null);
        void client.invalidateQueries({ queryKey: keys.state() });
        void client.invalidateQueries({ queryKey: keys.queue() });
        void client.invalidateQueries({ queryKey: keys.runs() });
      }
    },
    [client],
  );

  return {
    busy,
    freeze: useCallback(() => run('freeze'), [run]),
    thaw: useCallback(() => run('thaw'), [run]),
  };
}
