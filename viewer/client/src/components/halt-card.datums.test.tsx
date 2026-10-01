/**
 * Every datum behind a stop is within TWO interactions (control-tower phase
 * 17, criterion 4): the runner's words verbatim, the ladder, the rungs it
 * tried, the caps, and the watch refs — each live or refused.
 *
 * The card's headline is one sentence on purpose; what used to BE the
 * headline (the runner's reason) must not become unreachable in exchange. So
 * the test counts presses: nothing is asked of the reader but the one
 * "Details" press (and it is asserted that the datums are NOT all on the
 * first screen, so the count means something).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

import { TooltipProvider } from '@/components/ui';
import { keys, queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';
import { HaltCard } from './halt-card';

const REASON = 'phase 3 blocked: waiting on gh:acme/app#run/42 and its own lock';

const stopped = {
  id: 'r1',
  slug: 'external',
  root: '/repo',
  status: 'parked',
  autonomy: 'keep-going',
  model: 'opus',
  createdAt: '',
  updatedAt: '',
  activePhase: null,
  child: null,
  waitUntil: null,
  pause: null,
  freeze: null,
  spentUsd: 0,
  maxConsecutiveFailures: 4,
  consecutiveFailures: 0,
  halt: { at: '2026-09-29T09:00:00.000Z', kind: 'phase-blocked', reason: REASON, phase: 3 },
  phases: {
    '3': {
      phase: 3,
      status: 'parked',
      attempts: 2,
      costUsd: 4,
      sessionId: 's3',
      situation: { key: 'blocked-declared:external', at: '' },
      watch: ['gh:acme/app#run/42', 'lock:external/3', 'cmd:"curl -sf https://x"'],
      watchState: {
        at: '2026-09-29T09:01:00.000Z',
        refs: [
          {
            ref: 'gh:acme/app#run/42',
            scheme: 'gh',
            state: 'pending',
            checkedAt: '2026-09-29T09:01:00.000Z',
          },
          {
            ref: 'lock:external/3',
            scheme: 'lock',
            state: 'refused',
            detail: "names phase 3's own lock — a lock: watch is for a lock held by someone else",
            checkedAt: '2026-09-29T09:01:00.000Z',
          },
        ],
      },
      watchUnpollable: [{ ref: 'cmd:"curl -sf https://x"', reason: 'a cmd: ref may not hold a $' }],
    },
  },
  recoveries: {
    '3': {
      attempts: 2,
      lastAt: '2026-09-29T08:50:00.000Z',
      rungs: [
        {
          situation: 'blocked-declared:external',
          rung: 'poll-park',
          at: '2026-09-29T08:40:00.000Z',
          outcome: 'failed',
        },
        {
          situation: 'blocked-declared:external',
          rung: 'unblock',
          at: '2026-09-29T08:50:00.000Z',
          outcome: 'failed',
        },
      ],
      errand: {
        phase: 3,
        situation: 'blocked-declared:external',
        tried: ['poll-park', 'unblock'],
        need: 'Phase 3 waits on a CI run the console cannot see land.',
        how: 'Look again once gh:acme/app#run/42 has finished.',
        at: '2026-09-29T08:55:00.000Z',
        cap: 'phase-rungs',
        spent: 6,
        limit: 6,
        onDonePhases: 0,
        setting: 'ladderMaxPhaseRungs',
      },
    },
  },
} as unknown as RunState;

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: true,
    allowAgent: true,
    allowWrites: true,
    autopilot: true,
    root: { ok: true, path: '/repo' },
  });
  client.setQueryData(keys.terminal(), {
    allowed: false,
    agentAllowed: true,
    available: 'yes',
    sessions: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HaltCard run={stopped} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('every datum behind a stop is within two interactions', () => {
  it('reason, ladder, tried rungs, caps and watch refs — live and refused — one press away', () => {
    mount();
    const card = screen.getByTestId('halt-card');
    let presses = 0;

    // The first screen leads with the sentence, and the runner's words are
    // not on it — which is what makes the count below mean anything.
    expect(within(card).queryByTestId('halt-reason')).toBeNull();
    expect(within(card).getByTestId('halt-sentence').textContent).not.toContain(REASON);

    fireEvent.click(within(card).getByTestId('halt-details-toggle'));
    presses += 1;

    const details = within(card).getByTestId('halt-details');
    // 1. the reason, verbatim
    expect(within(details).getByTestId('halt-reason').textContent).toBe(REASON);
    // 2. the ladder
    expect(within(details).getByTestId('ladder')).toBeTruthy();
    // 3. the rungs it tried
    expect(within(details).getByTestId('halt-tried').textContent).toBe(
      'Tried by the autopilot: poll-park · unblock',
    );
    // 4. the cap, with its arithmetic and the setting that raises it
    expect(within(details).getByTestId('halt-cap').textContent).toBe(
      '6 of 6 rungs spent; raised by ladderMaxPhaseRungs',
    );
    // 5. the watch refs, each marked live or refused, with why
    const watch = within(details).getByTestId('halt-watch');
    const states = [...watch.querySelectorAll('li')].map((li) => [
      li.textContent?.split(' — ')[0],
      li.getAttribute('data-watch-state'),
    ]);
    expect(states).toEqual([
      ['gh:acme/app#run/42', 'live'],
      ['lock:external/3', 'refused'],
      ['cmd:"curl -sf https://x"', 'refused'],
    ]);
    expect(watch.textContent).toContain('a lock: watch is for a lock held by someone else');

    expect(presses).toBeLessThanOrEqual(2);
  });

  it('the errand behind the stop is on the first screen, with its family', () => {
    mount();
    const errand = screen.getByTestId('errand');
    expect(errand.textContent).toContain('Phase 3 waits on a CI run the console cannot see land.');
    expect(within(errand).getByTestId('halt-category').getAttribute('data-halt-category')).toBe('external');
    expect(screen.getByTestId('halt-card').getAttribute('data-halt-category')).toBe('external');
  });
});
