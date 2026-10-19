/** Admission: the queue, and what holds a plan's scopes. */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueueVerb } from '@shared/orchestration-model.js';
import { api, type QueueView } from './api';
import { keys } from './keys';
import { press } from './press';

/**
 * An operator's word on ONE phase's place in the queue — the queue verbs that
 * are not operator verbs of their own: `bump` is (`verbs.ts` presses it), and
 * `reorder` names a run's whole list, not a phase.
 */
export type QueueMove = Exclude<QueueVerb, 'bump' | 'reorder'>;

/** A queue move's target — a phase of a run, or an entry by id — and what it is written down with. */
export interface QueueMoveBody {
  slug?: string;
  phase?: number;
  entryId?: string;
  reason?: string;
  /** `defer`: when the hold lifts by itself, an ISO time. */
  until?: string;
  /** `requeue`: back in at the front rather than at its seniority. */
  position?: 'front';
}

/**
 * Hold, release, defer, withdraw or requeue one phase (`POST
 * /api/queue/<verb>`, control-tower phase 99) — run class, since it changes
 * what STARTS. Durable: the mark is on the phase's record, so it outlives the
 * entry. The queue and the run's scopes are read again behind it, whatever the
 * answer was.
 */
export function useQueueAct() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ verb, ...body }: QueueMoveBody & { verb: QueueMove }) =>
      press(() => api.queueAct(verb, { ...body })),
    onSettled: (_answer, _error, { slug }) => {
      for (const queryKey of [keys.queue(), keys.state(), ...(slug ? [keys.scopes(slug)] : [])])
        void client.invalidateQueries({ queryKey });
    },
  });
}

/** What the queue's policy door takes: the console's word, a plan's own (`slug`; `null` gives it back), the load factor. */
export interface QueuePolicyChange {
  policy?: string | null;
  slug?: string;
  loadFactor?: number;
  reason?: string;
}

/**
 * The scheduling policy and the load guard (`POST /api/queue/policy`) — run
 * class, since it changes what STARTS. The answer is the whole policy and the
 * load reading, written into the queue's cache at once; the queue, the state
 * and the settings schema (where the three keys read their sources) are read
 * again behind it.
 */
export function useQueuePolicyWrite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: QueuePolicyChange) => press(() => api.queuePolicy(change)),
    onSuccess: (pressed) => {
      if (pressed.state !== 'done') return;
      const { policy, load } = pressed.result;
      client.setQueryData<QueueView>(keys.queue(), (held) => (held ? { ...held, policy, load } : held));
    },
    onSettled: () => {
      for (const queryKey of [keys.queue(), keys.state(), keys.prefsSchema()])
        void client.invalidateQueries({ queryKey });
    },
  });
}

/**
 * What holds a scope, and what is waiting behind it.
 *
 * `keepPreviousData` because the answer is a live thing that moves while it is
 * being read: without it the queue card blanks on every admission, which is the
 * exact moment somebody is looking at it.
 */
export function useQueue(enabled = true) {
  return useQuery({
    queryKey: keys.queue(),
    queryFn: api.queue,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * This plan's phases, their declared scopes, and what each would collide with.
 *
 * Answered from the plan's Repos column plus every live lock across every plan,
 * so it is the one call that can say *why* a phase is not starting. Cheap enough
 * to hold open on the run page; refreshed by `run:queue` for every plan at once.
 */
export function useRunScopes(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.scopes(slug ?? ''),
    queryFn: () => api.runScopes(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

