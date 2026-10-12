/**
 * The lifecycle verbs — pause, resume, hold, release, freeze, thaw, stop, and
 * the two fleet-wide ones — pressed through the ONE door (7.0, quiet-console
 * phase 7; the words since control-tower phase 18).
 *
 * One busy word, one toast vocabulary, one invalidation set — the three things
 * three copies of "freeze this run" once disagreed about. Every press goes
 * through `press()` (`data/press.ts`), so a console with an owner key answers
 * it the way it answers every other press: done, or asked of the owner — and
 * a 202 is never read as done. `data/lifecycle.test.ts` pins this file as the
 * only caller of the seven doors.
 */

import { useCallback, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from '@/ui/toast';
import { api, type RunState } from './api';
import { keys } from './keys';
import { press } from './press';

/** The seven per-run verbs, in the order an operator escalates through them. */
export type LifecycleVerb = 'pause' | 'resume' | 'hold' | 'release' | 'freeze' | 'thaw' | 'stop';

/** Each verb's label and the sentence a button's title says — the strip's words since control-tower phase 19. */
export const LIFECYCLE_WORDS: Readonly<Record<LifecycleVerb, { label: string; title: string }>> =
  Object.freeze({
    pause: { label: 'Pause', title: 'Stop at the next phase boundary' },
    resume: { label: 'Resume', title: 'Carry on from where it stopped' },
    hold: { label: 'Hold', title: 'The running phases finish; nothing new is admitted' },
    release: { label: 'Release', title: 'Let this run be admitted again' },
    freeze: { label: 'Freeze', title: 'Stop every session of this run where it stands' },
    thaw: { label: 'Thaw', title: 'Continue — the session picks up mid-token' },
    stop: { label: 'Stop', title: 'Its sessions get SIGTERM and the run winds down' },
  });

/**
 * The one fact about a lane the endpoints cannot report back: a queued lane
 * holds no process, so stopping it DEQUEUES rather than kills — a different
 * sentence. `resumed` is what Resume actually did, from the door's own answer
 * (control-tower phase 77, #102); filled by the performer, never by a caller.
 */
export interface LifecycleContext {
  queued?: boolean;
  resumed?: { act: 'pause-cancelled' | 'relaunched' };
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
 * What the SERVER did, in one sentence — never what the click intended. Each
 * case reads the run the door handed back rather than assuming the press
 * landed: a freeze that finds no session used to answer 200 and say nothing.
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
            : context.queued
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
      if (context.resumed?.act === 'relaunched') {
        return { message: `${slug} started again — with its own settings, from where it paused`, tone: 'ok' };
      }
      return after?.status === 'pausing'
        ? {
            message: 'The pause could not be cancelled — reload and look at the status',
            tone: 'warn',
          }
        : { message: 'Pause cancelled — the run carries on', tone: 'ok' };
    case 'hold':
      return {
        message: `${slug} held — the running phases finish, and nothing new is admitted`,
        tone: 'ok',
      };
    case 'release':
      return { message: `${slug} released — it may be admitted again`, tone: 'ok' };
  }
}

type Answer = { run?: RunState | null; resumed?: LifecycleContext['resumed'] };

/** The door each verb goes through. One table, so nothing is reachable twice. */
const DOORS: Record<LifecycleVerb, (slug: string, phase?: number) => Promise<Answer>> = {
  freeze: (slug, phase) => api.runFreeze(slug, phase),
  thaw: (slug, phase) => api.runThaw(slug, phase),
  stop: (slug, phase) => api.runStop(slug, phase),
  pause: (slug) => api.runPause(slug),
  resume: (slug) => api.runResume(slug),
  hold: (slug) => api.runHold(slug),
  release: (slug) => api.runRelease(slug),
};

/** The refusal in the server's own words — the honest floor when it said nothing. */
const words = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/**
 * One verb, start to finish, through `press()`: the door, the sentence, the
 * toast and the invalidation — `keys.afterRunAct`, the one set every run
 * surface refreshes on. A press the owner must confirm toasts the server's
 * own words for that and refreshes nothing: nothing was done yet.
 */
export async function pressLifecycle(
  client: QueryClient,
  verb: LifecycleVerb,
  slug: string,
  phase?: number,
  context: LifecycleContext = {},
): Promise<void> {
  try {
    const pressed = await press(() => DOORS[verb](slug, phase));
    if (pressed.state === 'asked') {
      toast(pressed.words, 'info');
      return;
    }
    const { run: after, resumed } = pressed.result;
    const { message, tone } = lifecycleToast(
      verb,
      slug,
      phase,
      after,
      resumed ? { ...context, resumed } : context,
    );
    toast(message, tone);
  } catch (cause) {
    toast(words(cause), 'error');
  } finally {
    // `void`, never `await`: `invalidateQueries` resolves only once the refetch
    // settles, and awaiting it would hold a caller's busy flag for a round trip.
    for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: keys.queue() });
  }
}

export interface Lifecycle {
  /** The verb in flight, or `null`. One string, so one spinner rule. */
  busy: LifecycleVerb | null;
  act: (verb: LifecycleVerb) => Promise<void>;
}

/** A run's verbs, with one busy word — what a row's one action and its expanded verbs share. */
export function useLifecycle(slug: string, phase?: number, context: LifecycleContext = {}): Lifecycle {
  const client = useQueryClient();
  const [busy, setBusy] = useState<LifecycleVerb | null>(null);
  const queued = context.queued;
  const act = useCallback(
    async (verb: LifecycleVerb) => {
      setBusy(verb);
      try {
        await pressLifecycle(client, verb, slug, phase, { ...(queued ? { queued } : {}) });
      } finally {
        setBusy(null);
      }
    },
    [client, slug, phase, queued],
  );
  return { busy, act };
}

/* ------------------------------------------------------------------ *
 * The fleet pair — the same act one scope up
 * ------------------------------------------------------------------ */

/** Freeze or thaw every run of this console. The state, the queue and the runs re-read together. */
export async function pressFleet(client: QueryClient, verb: 'freeze' | 'thaw'): Promise<void> {
  try {
    const pressed = await press(() => (verb === 'freeze' ? api.fleetFreeze() : api.fleetThaw()));
    if (pressed.state === 'asked') {
      toast(pressed.words, 'info');
      return;
    }
    if (verb === 'freeze') {
      const held = pressed.result.runs;
      toast(
        held === 1
          ? 'Console frozen — 1 run held where it stands.'
          : `Console frozen — ${held} runs held where they stand.`,
        'ok',
      );
    } else toast('Console thawed — everything carries on from where it was.', 'ok');
  } catch (cause) {
    toast(words(cause), 'error');
  } finally {
    void client.invalidateQueries({ queryKey: keys.state() });
    void client.invalidateQueries({ queryKey: keys.queue() });
    void client.invalidateQueries({ queryKey: keys.runs() });
  }
}
