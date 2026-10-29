/**
 * The run in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 11).
 *
 * What is pinned:
 *
 *   - **the run record is said in eight sections**, the phase inspector's, in
 *     its order — each folded behind its name and its count, each one press
 *     from the panel, all open with the page's Everything on — and each opens
 *     onto the fields that belong to it, including the ones the 6.x run page
 *     never drew (a person's account switch, the start door's §Verification
 *     answers, the time blocked in the queue by class, the relay's arming, the
 *     refusal's own words, the cost model, …);
 *   - **a section with nothing to say says so**, rather than offering a fold
 *     that opens onto nothing;
 *   - **Raw is the record whole**, History the run's own story newest first,
 *     and Actions the run's own tab.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) =>
      path === '/api/approvals'
        ? Promise.resolve([])
        : path === '/api/state'
          ? Promise.resolve({ allowRun: true })
          : Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path)),
  };
});

import type { ConsoleState } from '@/data/api';
import type { RunState } from '@/data/api/runs';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { TooltipProvider } from '@/ui/tooltip';
import { RUN_RECORD_SECTIONS, RunRecordSections, inspectRunView } from './inspector';

const AT = (hour: number) => `2026-10-09T${String(hour).padStart(2, '0')}:00:00.000Z`;

/** The fields every run record carries — and nothing else. */
const BARE = {
  id: 'run-0001',
  slug: 'demo',
  root: '/repo',
  status: 'running',
  autonomy: 'guarded',
  model: 'claude-opus-5-5',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 0,
  maxConsecutiveFailures: 0,
  consecutiveFailures: 0,
  createdAt: AT(8),
  updatedAt: AT(9),
  activePhase: null,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: {},
} as unknown as RunState;

/** A record holding a field for each of the eight sections. */
const FULL_RUN = {
  ...BARE,
  status: 'halted',
  phases: {
    '1': { phase: 1, status: 'done' },
    '2': { phase: 2, status: 'parked' },
  },
  // Boarding — never drawn by 6.x
  accountChoice: { accountId: 'acct-b', from: 'acct-a', at: AT(7), by: 'mobin' },
  // Context
  notes: [
    { id: 'n1', at: AT(10), by: 'mobin', text: 'Never touch the billing tables', pinned: true, phase: 2 },
    { id: 'n2', at: AT(11), by: 'ops', text: 'Watch the deploy', pinned: false },
  ],
  // Verification — never drawn by 6.x
  verifyApprovals: {
    approve: [{ fp: 'f1', text: 'make e2e' }],
    waive: [{ phase: 2, fp: 'f2', text: 'open the staging url' }],
    by: 'mobin',
    at: AT(8),
  },
  // Waits and watches
  pause: { requestedAt: AT(12), afterPhase: 2, by: 'mobin' },
  halt: { at: AT(13), reason: 'verification failed twice', phase: 2, kind: 'failure-streak' },
  // Queue — never drawn by 6.x
  blockedMs: { 'other-run': 3_600_000 },
  // Walls and permissions — never drawn by 6.x
  relayArming: { armed: false, version: '2.1.200', floor: '2.1.268', reason: 'below-floor', at: AT(8) },
  // Isolation and trees — never drawn by 6.x
  isolation: 'worktree',
  checkout: 'refused',
  isolationRefusal: 'mounts-occupied',
  isolationRefusalDetail: 'phased-execution is on pe/other with 3 uncommitted paths',
  treeHolds: [{ repo: 'phased-execution', dir: '/repo/phased-execution', branch: 'pe/demo', at: AT(9) }],
  // Cost — never drawn by 6.x
  spentUsd: 4.25,
  costModel: 2,
  // History only
  rulings: [
    {
      id: 'r1',
      slug: 'demo',
      phase: 2,
      kind: 'deviation',
      what: 'kept the old endpoint',
      at: AT(11),
    },
  ],
} as unknown as RunState;

const STATE = {
  allowRun: true,
  refusalReasons: { 'mounts-occupied': 'A mount it needs is occupied by other work.' },
  refusalFixes: { 'mounts-occupied': 'Repair the checkout, or move that work.' },
} as unknown as ConsoleState;

/** What each section opens onto for `FULL_RUN`. */
const OPENS_ONTO: Record<string, string> = {
  boarding: 'to acct-b from acct-a, by mobin',
  context: 'Never touch the billing tables (phase 2)',
  verification: '1 command approved, 1 fragment set aside, by mobin',
  waits: 'by mobin, after phase 2',
  queue: 'by another run, ',
  walls: 'not armed: the CLI is below the floor, CLI 2.1.200 against 2.1.268',
  isolation: 'phased-execution is on pe/other with 3 uncommitted paths',
  cost: '2, each spawn’s rise over its session’s mark',
};

/** The sections alone — with the console's state, or `{ state: undefined }` for a console that sends none. */
function mountSections(run: RunState, { state }: { state?: ConsoleState } = { state: STATE }) {
  return render(
    <TooltipProvider>
      <RunRecordSections run={run} state={state} />
    </TooltipProvider>,
  );
}

/** What an open section's fold holds, as text. */
const bodyOf = (id: string) => {
  const toggle = screen.getByTestId(`run-section-${id}`);
  return document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent ?? '';
};

function inspectIn(run: RunState) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const out = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  act(() => inspectRunView({ run, slug: 'demo', state: STATE, allowRun: true }));
  return out;
}

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const sectionIds = () =>
  [...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));

beforeEach(() => {
  localStorage.clear();
  setPrefs({ everything: {}, tables: {} });
});

afterEach(() => {
  act(() => __resetInspectorForTests());
});

describe('the run’s record, in eight sections', () => {
  it('names the phase inspector’s eight, in its order', () => {
    expect(RUN_RECORD_SECTIONS.map((s) => s.label)).toEqual([
      'Boarding',
      'Context',
      'Verification',
      'Waits and watches',
      'Queue',
      'Walls and permissions',
      'Isolation and trees',
      'Cost',
    ]);
  });

  it('folds each behind its name and its count, with nothing of it in the page until it opens', () => {
    mountSections(FULL_RUN);
    expect(sectionIds()).toEqual(RUN_RECORD_SECTIONS.map((s) => s.id));
    for (const section of RUN_RECORD_SECTIONS) {
      const toggle = screen.getByTestId(`run-section-${section.id}`);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // A fold strip: the name, and its count in a pill — heard as "Boarding (4)".
      expect(toggle.textContent).toMatch(new RegExp(`^${section.label} \\(\\d+\\)$`));
      expect(document.body.textContent).not.toContain(OPENS_ONTO[section.id]);
    }
  });

  it('opens each in place onto the fields that belong to it — the never-drawn ones included', () => {
    mountSections(FULL_RUN);
    for (const section of RUN_RECORD_SECTIONS) {
      fireEvent.click(screen.getByTestId(`run-section-${section.id}`));
      expect(bodyOf(section.id), `${section.label} opens onto its fields`).toContain(OPENS_ONTO[section.id]);
    }
  });

  it('reads a refusal’s sentence and its fix from the console, beside the refusal’s own words', () => {
    const { unmount } = mountSections(FULL_RUN);
    fireEvent.click(screen.getByTestId('run-section-isolation'));
    expect(screen.getByText('A mount it needs is occupied by other work.')).toBeInTheDocument();
    expect(screen.getByText('Repair the checkout, or move that work.')).toBeInTheDocument();
    // …and falls back to the key on a console that sends no table.
    unmount();
    mountSections(FULL_RUN, { state: undefined });
    fireEvent.click(screen.getByTestId('run-section-isolation'));
    expect(screen.getByText('mounts-occupied')).toBeInTheDocument();
  });

  it('says "nothing recorded" for a section with nothing to say, and offers no fold', () => {
    mountSections(BARE);
    // Boarding always has its start; isolation always has its root.
    expect(screen.getByTestId('run-section-boarding')).toBeInTheDocument();
    expect(screen.getByTestId('run-section-isolation')).toBeInTheDocument();
    for (const id of ['context', 'verification', 'waits', 'queue', 'walls', 'cost']) {
      const section = RUN_RECORD_SECTIONS.find((s) => s.id === id)!;
      expect(screen.queryByTestId(`run-section-${id}`)).toBeNull();
      expect(screen.getByText(`${section.label}: nothing recorded.`)).toBeInTheDocument();
    }
  });

  it('with Everything on, every section is open — no press at all', () => {
    setPrefs({ everything: { plan: true } });
    mountSections(FULL_RUN);
    for (const section of RUN_RECORD_SECTIONS) {
      expect(screen.getByTestId(`run-section-${section.id}`)).toHaveAttribute('aria-expanded', 'true');
      expect(bodyOf(section.id)).toContain(OPENS_ONTO[section.id]);
    }
  });
});

describe('the run in the panel', () => {
  const panel = () => screen.getByRole('region', { name: 'demo' });

  it('names the plan and the run, with the run’s word as its identity row', () => {
    inspectIn(FULL_RUN);
    expect(screen.getByRole('heading', { name: 'demo' })).toBeInTheDocument();
    expect(within(panel()).getByText('Run run-0001, 2 phases on record')).toBeInTheDocument();
    expect(panel().querySelector('[data-vocab="run"]')).toHaveAttribute('data-status', 'halted');
  });

  it('opens on the eight sections', () => {
    inspectIn(FULL_RUN);
    expect(within(panel()).getByTestId('run-record-sections')).toBeInTheDocument();
  });

  it('Raw carries the record whole', () => {
    inspectIn(FULL_RUN);
    openTab('Raw');
    const raw = panel().querySelector('pre')!;
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(FULL_RUN)));
  });

  it('History is the run’s own story, newest first — its halt by kind, its notes, its rulings, its start', () => {
    inspectIn(FULL_RUN);
    openTab('History');
    const story = within(screen.getByTestId('run-history'))
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(story).toHaveLength(5);
    expect(story[0]).toContain('Halted, failure-streak on phase 2');
    // The halt's sentence is the halt card's to say.
    expect(story[0]).not.toContain('verification failed twice');
    expect(story[1]).toContain('Noted: Watch the deploy');
    expect(story[1]).toContain('ops');
    expect(story[2]).toContain('A deviation ruling on phase 2: kept the old endpoint');
    expect(story[3]).toContain('Pinned a note on phase 2: Never touch the billing tables');
    expect(story[4]).toContain('Started');
  });

  it('Actions is the run’s own tab: the six, then every other verb', () => {
    inspectIn(FULL_RUN);
    openTab('Actions');
    expect(within(panel()).getByTestId('run-actions')).toBeInTheDocument();
    expect(
      within(panel())
        .getAllByTestId('run-action')
        .map((li) => li.dataset.action),
    ).toEqual(['isolate', 'isolate-phase', 'board-at-boundary', 'repair-checkout', 'errand-tree', 'extend']);
    expect(within(panel()).getByTestId('run-actions-other')).toHaveTextContent('Every other verb');
  });
});
