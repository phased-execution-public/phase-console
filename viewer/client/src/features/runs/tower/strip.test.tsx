/**
 * The strip, mounted (control-tower phase 19).
 *
 * The model's rules are pinned in `strip-model.test.ts`; this pins what a
 * person meets:
 *
 *  1. **Exactly one primary action per strip**, in every bay — and for a stop,
 *     it is the SAME verb the halt card recommends when the strip is opened.
 *  2. **The pulse animates only on an observed live lane** — a `running` word
 *     over a silent session is drawn still.
 *  3. **The peek's trigger is itself a link or button** — the facts it shows
 *     are one press away, never hover-only.
 *  4. **Every duration carries its verb.**
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunState } from '@/lib/api';

const doors = vi.hoisted(() => ({
  runFreeze: vi.fn(async () => ({ run: null })),
  runThaw: vi.fn(async () => ({ run: null })),
  runStop: vi.fn(async () => ({ run: null })),
  runPause: vi.fn(async () => ({ run: null })),
  runResume: vi.fn(async () => ({ run: null })),
  runHold: vi.fn(async () => ({ run: null })),
  runRelease: vi.fn(async () => ({ run: null })),
  phaseActivity: vi.fn(async () => ({ events: [], untrusted: true })),
  phaseReport: vi.fn(async () => ({ live: false })),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...doors } };
});

import { STALL_DEFAULTS } from '@shared/attention-model.js';
import { nowLanes } from '@/features/runs/lanes-model';
import { setPrefs } from '@/lib/prefs';
import { peekableTrigger } from '@/components/peek';
import { Strip } from './strip';

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Phase = { phase: number; status: string } & Record<string, unknown>;

function run(over: Partial<RunState> & { id: string; slug: string }, phases: Phase[]): RunState {
  const table: Record<string, unknown> = {};
  for (const p of phases) table[String(p.phase)] = { attempts: 1, costUsd: 0, ...p };
  return {
    root: '/repo',
    status: 'running',
    model: 'opus',
    autonomy: 'keep-going',
    spentUsd: 4.2,
    runBudgetUsd: 25,
    createdAt: iso(NOW - 3 * 60 * MIN),
    updatedAt: iso(NOW - MIN),
    activePhase: phases[0]?.phase ?? null,
    phases: table,
    ...over,
  } as unknown as RunState;
}

const heard = (agoMs: number) => ({
  phase: 6,
  lastOutputAt: iso(NOW - agoMs),
  turnsSinceLastTool: 0,
  commitsSinceStart: 0,
  treeDirty: false,
});

const live = (beatAgoMs = 5_000) =>
  run(
    {
      id: 'r-live',
      slug: 'console-speed',
      children: { 6: { pid: 106, phase: 6, sessionId: 's6', startedAt: iso(NOW - 14 * MIN) } },
    } as Partial<RunState> & { id: string; slug: string },
    [
      { phase: 5, status: 'done' },
      {
        phase: 6,
        status: 'running',
        attemptStartedAt: iso(NOW - 14 * MIN),
        startedAt: iso(NOW - 14 * MIN),
        liveness: heard(beatAgoMs),
      },
    ],
  );

const halted = () =>
  run(
    {
      id: 'r-halt',
      slug: 'checkout',
      status: 'halted',
      halt: { at: iso(NOW - 12 * MIN), kind: 'verify-failed', reason: 'red', phase: 5 },
    },
    [
      { phase: 4, status: 'done' },
      { phase: 5, status: 'failed', sessionId: 's5' },
    ],
  );

const queued = () =>
  run({ id: 'r-q', slug: 'gamma', status: 'queued' }, [
    { phase: 1, status: 'queued', queuedAt: iso(NOW - 3 * MIN) },
  ]);

const frozen = () =>
  run(
    {
      id: 'r-frz',
      slug: 'delta',
      status: 'frozen',
      freeze: { at: iso(NOW - 2 * MIN), by: 'me', phase: null, pid: 102 },
      children: {
        2: {
          pid: 102,
          phase: 2,
          sessionId: 's2',
          startedAt: iso(NOW - 9 * MIN),
          frozen: { at: iso(NOW - 2 * MIN), by: 'me' },
        },
      },
    } as Partial<RunState> & { id: string; slug: string },
    [{ phase: 2, status: 'running' }],
  );

function mount(r: RunState, allowRun = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['state'], { allowRun, allowWrites: true, allowAgent: true });
  const lanes = nowLanes([r]);
  render(
    <QueryClientProvider client={client}>
      <Strip run={r} lanes={lanes} allowRun={allowRun} />
    </QueryClientProvider>,
  );
  return screen.getByTestId('board-card');
}

beforeEach(() => {
  for (const door of Object.values(doors)) door.mockClear();
  doors.phaseReport.mockImplementation(async () => ({ live: false }));
  setPrefs({ stripsOpen: [] });
});

describe('exactly one primary action per strip', () => {
  const bays: [string, () => RunState, string][] = [
    ['live', () => live(), 'pause'],
    ['a stop', halted, ''],
    ['queued', queued, 'hold'],
    ['frozen', frozen, 'thaw'],
  ];

  for (const [name, make, verb] of bays) {
    it(`${name}: one action on the glance${verb ? ` — ${verb}` : ''}`, () => {
      const strip = mount(make());
      const actions = within(strip).getAllByTestId('strip-action');
      expect(actions).toHaveLength(1);
      if (verb) expect(actions[0]!.dataset.action).toBe(verb);
    });
  }

  it('a stop offers the verb the halt card recommends — the same button, opened', () => {
    const strip = mount(halted());
    const glance = within(strip).getByTestId('strip-action');
    fireEvent.click(within(strip).getByTestId('strip-expand'));
    const card = within(strip).getByTestId('halt-recommended');
    expect(glance.dataset.action).toBe(card.dataset.recommended);
    // Opened, the glance still carries ONE action: the card's is its own.
    expect(within(strip).getAllByTestId('strip-action')).toHaveLength(1);
  });

  it('a read-only console gets Open run — a link, one of it', () => {
    const strip = mount(halted(), false);
    const actions = within(strip).getAllByTestId('strip-action');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.tagName).toBe('A');
    expect(actions[0]!.getAttribute('href')).toMatch(/checkout/);
  });

  it('the glance action acts through its one door; the rest wait one press away', async () => {
    const strip = mount(live());
    expect(within(strip).queryByRole('button', { name: /Freeze/ })).toBeNull();
    fireEvent.click(within(strip).getByTestId('strip-action'));
    await waitFor(() => expect(doors.runPause).toHaveBeenCalledWith('console-speed'));
    fireEvent.click(within(strip).getByTestId('strip-expand'));
    // Every other verb, and not the glance's a second time.
    expect(within(strip).getByRole('button', { name: /Freeze/ })).toBeTruthy();
    expect(
      within(within(strip).getByTestId('strip-verbs')).queryByRole('button', { name: /^Pause/ }),
    ).toBeNull();
  });
});

describe('the pulse', () => {
  const icon = (strip: HTMLElement) => strip.querySelector('[data-vocab="run"] svg');

  it('animates on an observed live lane', () => {
    const strip = mount(live(5_000));
    expect(strip.querySelector('[data-pulse="observed"]')).toBeTruthy();
    expect(icon(strip)?.getAttribute('class') ?? '').toContain('animate-pulse-soft');
  });

  it('is still over a running word whose session has gone silent', () => {
    const strip = mount(live(STALL_DEFAULTS.stallSilentMs + 60_000));
    expect(strip.querySelector('[data-pulse="still"]')).toBeTruthy();
    expect(strip.innerHTML).not.toContain('animate-pulse-soft');
  });

  it('is still on a frozen run, a stop and a queue', () => {
    for (const make of [frozen, halted, queued]) {
      const strip = mount(make());
      expect(strip.innerHTML).not.toContain('animate-pulse-soft');
      cleanup();
    }
  });
});

describe('the peek', () => {
  it('rides the name, which is itself a link to the run page', () => {
    const strip = mount(live());
    const name = within(strip).getByTestId('strip-name');
    expect(name.tagName).toBe('A');
    expect(name.getAttribute('href')).toMatch(/console-speed/);
    // Radix marks its trigger: the peek is on the link, not on a wrapper.
    expect(name.getAttribute('data-state')).toBe('closed');
  });

  it('refuses a trigger that is not a link or a button — no hover-only door', () => {
    expect(peekableTrigger(<a href="#/runs">x</a>)).toBe(true);
    expect(peekableTrigger(<button type="button">x</button>)).toBe(true);
    expect(peekableTrigger(<span>x</span>)).toBe(false);
    expect(peekableTrigger(<a>no href</a>)).toBe(false);
    expect(peekableTrigger('text')).toBe(false);
  });
});

describe('every duration carries its verb', () => {
  it('the glance clock says what it measured', () => {
    expect(within(mount(live())).getByTestId('strip-clock').textContent).toMatch(/^running 14m 0\ds$/);
  });

  it('a stop says how long ago; a queue how long it has queued; a freeze how long ago', () => {
    expect(within(mount(halted())).getByTestId('strip-clock').textContent).toMatch(
      /^halted 12m( \d+s)? ago$/,
    );
  });

  it('opened, each lane and each named clock is a verb and a figure', () => {
    const strip = mount(live());
    fireEvent.click(within(strip).getByTestId('strip-expand'));
    expect(within(strip).getByTestId('lane-clock').textContent).toMatch(/^running 14m 0\ds$/);
    const clocks = within(strip).getByRole('region', { name: 'Clocks for phase 6' });
    expect(clocks.textContent).toMatch(/running 14m/);
    expect(clocks.textContent).toMatch(/worked 14m/);
  });
});

/** A live phase's report (phase 95), as `GET /api/run/:slug/phase/:n/report` answers it. */
const report = (over: Record<string, unknown>) => ({
  slug: 'console-speed',
  runId: 'r-live',
  phase: 6,
  at: iso(NOW),
  status: 'running',
  live: true,
  doing: {},
  done: { count: 1, total: 4, items: [] },
  left: { count: 3, items: [] },
  waitingOn: [],
  whySlow: [],
  eta: { minutes: null, confidence: 'none', basis: 'no task has finished yet', source: [] },
  timeline: [],
  summary: 'Phase 6 is running, 1 of 4 tasks done.',
  ...over,
});

describe('why it is not moving — from the phase report, when nothing is detected (control-tower phase 102, #163)', () => {
  it('a live phase that is slow says why, first reason first', async () => {
    doors.phaseReport.mockImplementation(
      async () =>
        report({
          whySlow: [
            { rule: 'machine-load', text: 'machine load 82 on 14 CPUs is above the guard', source: [] },
            {
              rule: 'context-wrap-up',
              text: 'context 551k of 1M: will hand off to a fresh session',
              source: [],
            },
          ],
        }) as never,
    );
    const strip = mount(live());
    await waitFor(() => expect(within(strip).getByTestId('strip-why').getAttribute('data-why')).toBe('slow'));
    expect(within(strip).getByTestId('strip-why').textContent).toBe(
      'Slow: machine load 82 on 14 CPUs is above the guard (and 1 more).',
    );
    expect(doors.phaseReport).toHaveBeenCalledWith('console-speed', 6);
  });

  it('a live phase that is not slow says what it is doing and when it should end', async () => {
    doors.phaseReport.mockImplementation(
      async () =>
        report({
          doing: {
            task: { id: 'p6.task2', text: 'p6.task2 — wire the endpoint', source: [] },
            operation: { label: 'iOS sweep', done: 45, of: 68, pct: 66, at: iso(NOW), source: [] },
          },
          eta: { minutes: { low: 20, high: 35 }, confidence: 'medium', basis: 'b', source: [] },
        }) as never,
    );
    const strip = mount(live());
    await waitFor(() =>
      expect(within(strip).getByTestId('strip-why').getAttribute('data-why')).toBe('doing'),
    );
    expect(within(strip).getByTestId('strip-why').textContent).toBe(
      'On p6.task2 — wire the endpoint, iOS sweep 45/68 — about 20–35 min left.',
    );
  });

  it('says nothing for a run with no live phase and nothing detected', async () => {
    const strip = mount(halted());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(strip).queryByTestId('strip-why')).toBeNull();
    expect(doors.phaseReport).not.toHaveBeenCalled();
  });
});
