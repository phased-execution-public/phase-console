/**
 * The bays, mounted (control-tower phase 20).
 *
 *  - The bays come in urgency order and every strip sits in the bay it names.
 *  - Waiting and Queued say what each run waits on: a HOLD, a phase queued on
 *    a sibling run's BRANCH (phase 40, #41) — and the scope FENCE, with the
 *    fencing phase and its refs, and the folded errand's `alsoPhases` (phase
 *    6's fold, #19 — exit criterion 7).
 *  - Needs you is runs: the asks no strip draws are items of Your turn, and
 *    the bay links there with the page's counts (control-tower phase 139).
 *  - Settled is quiet: folded until asked, and `?bay=` opens the bay it names.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConvergeStatusView, InboxItem, QueueEntry, RunState } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      phaseActivity: vi.fn(async () => ({ events: [], untrusted: true })),
      phaseReport: vi.fn(async () => ({ live: false })),
    },
  };
});

import { BAYS } from '@shared/status-model.js';
import { nowLanes } from '@/features/runs/lanes-model';
import { setPrefs } from '@/lib/prefs';
import { nextSweepText } from '../sweep-text';
import { TowerBays } from './bays';
import { towerModel } from './tower-model';

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function run(over: Partial<RunState> & { id: string }, phases: Record<string, unknown>[] = []): RunState {
  const table: Record<string, unknown> = {};
  for (const p of phases) table[String(p.phase)] = { attempts: 1, costUsd: 0, ...p };
  return {
    slug: over.id,
    root: '/repo',
    status: 'running',
    model: 'opus',
    spentUsd: 1,
    runBudgetUsd: null,
    createdAt: iso(NOW - 90 * MIN),
    updatedAt: iso(NOW - MIN),
    phases: table,
    halt: null,
    ...over,
  } as unknown as RunState;
}

/** A run whose P4 declared an external wall: P5 is fenced behind it, P6 folded into its errand. */
const FENCED = run(
  {
    id: 'fenced',
    status: 'waiting',
    waitReason: 'external',
    recoveries: {
      4: {
        attempts: 2,
        lastAt: iso(NOW - 5 * MIN),
        errand: {
          phase: 4,
          situation: 'blocked-declared:external',
          tried: [],
          need: 'the org plan renewed',
          how: 'renew it',
          at: iso(NOW - 5 * MIN),
          alsoPhases: [6],
        },
      },
      6: { attempts: 0, lastAt: iso(NOW - 4 * MIN), foldedInto: 4 },
    },
  } as never,
  [
    { phase: 4, status: 'parked', declared: { status: 'needs-human', reason: 'org plan lapsed' } },
    {
      phase: 5,
      status: 'queued',
      waitingOn: [
        {
          slug: 'fenced',
          phase: 4,
          owner: 'this run',
          kind: 'fence',
          refs: ['gh:acme/web#run/9'],
          until: null,
        },
      ],
    },
    { phase: 6, status: 'parked' },
  ],
);

const QUEUED = run({ id: 'behind-branch', status: 'queued' }, [{ phase: 3, status: 'queued' }]);
const ENTRY = {
  slug: 'behind-branch',
  phase: 3,
  waitingOn: [
    {
      kind: 'branch',
      slug: 'beta',
      phase: null,
      owner: 'run b1 of beta holds phased-execution on pe/beta',
      scope: ['phased-execution'],
      overlaps: ['phased-execution'],
      branch: 'pe/beta',
    },
  ],
} as unknown as QueueEntry;

const HELD = run({ id: 'held', status: 'queued', hold: { at: iso(NOW - 3 * MIN), by: 'you' } } as never, [
  { phase: 2, status: 'queued' },
]);
const LIVE = run(
  {
    id: 'live',
    children: { 7: { pid: 7, phase: 7, sessionId: 's7', startedAt: iso(NOW - 9 * MIN) } },
  } as never,
  [{ phase: 7, status: 'running', startedAt: iso(NOW - 9 * MIN) }],
);
const DONE = run({ id: 'done', status: 'finished', updatedAt: iso(NOW - 10 * MIN) }, [
  { phase: 1, status: 'done' },
]);
const HALTED = run({
  id: 'halted',
  status: 'halted',
  halt: { kind: 'credential-refused', phase: 2, at: iso(NOW - 20 * MIN), reason: 'refused' },
} as never);

const ASK = {
  id: 'plan-gate',
  kind: 'gate',
  severity: 'needs-you',
  slug: 'gamma',
  phase: 3,
  title: 'A gate on gamma P3 wants a person',
  need: 'an approval',
  how: 'approve it',
  since: iso(NOW - 30 * MIN),
  actions: [],
  href: '#/plan/gamma',
} as unknown as InboxItem;
const ERRAND = {
  ...ASK,
  id: 'errand',
  kind: 'errand',
  slug: 'halted',
  runId: 'halted',
  title: 'sign in',
} as InboxItem;

function mount(focus?: (typeof BAYS)[number]) {
  const runs = [FENCED, QUEUED, HELD, LIVE, DONE, HALTED];
  const model = towerModel({
    runs,
    lanes: nowLanes(runs, new Map(), NOW),
    entries: [ENTRY],
    inbox: [ASK, ERRAND],
    now: NOW,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TowerBays model={model} allowRun {...(focus ? { focus } : {})} />
    </QueryClientProvider>,
  );
}

const bay = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  cleanup();
  setPrefs({ stripsOpen: [], towerSettledOpen: false });
});

describe('the bays', () => {
  it('come most urgent first, and each strip sits in the bay it names', () => {
    mount();
    const order = screen.getAllByTestId('bay').map((el) => el.getAttribute('data-bay'));
    expect(order).toEqual([...BAYS]);
    for (const el of screen.getAllByTestId('bay')) {
      for (const strip of el.querySelectorAll('[data-strip]')) {
        expect(strip.getAttribute('data-bay')).toBe(el.getAttribute('data-bay'));
      }
    }
    expect(within(bay('Needs you')).getByRole('link', { name: 'halted' })).toBeTruthy();
    expect(within(bay('Live')).getByRole('link', { name: 'live' })).toBeTruthy();
  });

  it('draws the fence on the bay — the fencing phase and its refs — and the folded errand’s other phases (#19)', () => {
    mount();
    const strip = within(bay('Waiting')).getByRole('article', { name: /^fenced/ });
    const waits = within(strip)
      .getAllByTestId('strip-wait')
      .map((el) => el.textContent);
    expect(waits).toContain("P5 is fenced by P4's external wall, waiting on gh:acme/web#run/9");
    expect(waits).toContain("P4's errand also stands for P6: one wall, one ask");
  });

  it('says what a queued run waits on, a sibling run’s branch included (#41), and names a hold', () => {
    mount();
    const queued = within(bay('Queued'));
    const branch = queued.getByRole('article', { name: /^behind-branch/ });
    expect(within(branch).getByTestId('strip-wait').textContent).toBe(
      "P3 queued — waiting on beta's branch pe/beta on phased-execution",
    );
    const held = queued.getByRole('article', { name: /^held/ });
    expect(within(held).getAllByTestId('strip-wait')[0]!.textContent).toBe(
      'Held by you: nothing new boards until it is released',
    );
  });

  it('draws no loose row in Needs you — the gate no strip draws is an item of the page it links to', () => {
    mount();
    const needs = within(bay('Needs you'));
    expect(needs.queryByText('A gate on gamma P3 wants a person')).toBeNull();
    expect(needs.queryByTestId('bay-inbox')).toBeNull();
    expect(needs.queryByText('sign in')).toBeNull();
  });

  it('keeps Settled folded until asked, and opens the bay an address names', () => {
    mount();
    expect(within(bay('Settled')).queryByRole('article')).toBeNull();
    fireEvent.click(within(bay('Settled')).getByRole('button', { name: /Show/ }));
    expect(within(bay('Settled')).getByRole('article', { name: /^done/ })).toBeTruthy();

    cleanup();
    setPrefs({ towerSettledOpen: false });
    mount('settled');
    const settled = bay('Settled');
    expect(settled.getAttribute('data-focused')).toBe('true');
    expect(within(settled).getByRole('article', { name: /^done/ })).toBeTruthy();
  });
});

/**
 * The empty Needs-you bay says when the loop next looks by itself — Now's
 * empty inbox said it, and deleting Now (control-tower phase 21) must not lose
 * it. "Nothing is waiting on you" alone reads as "and nothing ever will".
 */
describe('an empty Needs-you bay says when the loop next looks', () => {
  const converge = (over: Partial<ConvergeStatusView>) =>
    ({ automatic: true, everyMs: 0, pending: [], running: [], reports: [], ...over }) as ConvergeStatusView;

  it('names the sweep clock, the manual console, and what it cannot know', () => {
    expect(nextSweepText(converge({ everyMs: 900_000 }))).toMatch(/every 15 min/);
    expect(nextSweepText(converge({ automatic: false }))).toContain('manual');
    expect(nextSweepText(undefined)).toContain('whenever anything changes');
  });

  it('draws it under the empty bay, and not under a filter that emptied it', () => {
    const model = towerModel({ runs: [], lanes: [], entries: [], inbox: [], now: NOW });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <TowerBays model={model} allowRun={false} converge={converge({ automatic: false })} />
      </QueryClientProvider>,
    );
    expect(within(bay('Needs you')).getByText(/No run is waiting on you\. .*manual/)).toBeTruthy();
    rerender(
      <QueryClientProvider client={client}>
        <TowerBays model={model} allowRun={false} converge={converge({ automatic: false })} filtered />
      </QueryClientProvider>,
    );
    expect(within(bay('Needs you')).queryByText(/manual/)).toBeNull();
  });
});
