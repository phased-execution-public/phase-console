/**
 * The phase drawer's QA-rounds section — the Runs and Autopilot surfaces.
 *
 * Issue #7 §1 and §2, from where a reader stands: a QA pass decided whether
 * every dependent phase could start, cost real money, and appeared on the run
 * surfaces as a cost line and nothing else. `PhaseRecord` carried no verdict,
 * no report path and no findings; verdicts existed only on the Plans
 * destination, parsed out of `test-status.md`, showing the final row alone —
 * so on the run the issue was written from, ten QA rounds were invisible to
 * every screen while being paid for.
 *
 * The three properties these hold:
 *
 *   - **the rounds come off the RUN, not the diagnosis.** The diagnosis answers
 *     for a phase with no run record at all; the rounds live on the run. So on
 *     the Phases tab, where there is no run to pass, the section is absent
 *     rather than an empty header.
 *   - **every round keeps its own report.** The bug rounds used to have is that
 *     they overwrote each other's reports, so a history that showed one path
 *     twice would be showing the bug rather than the fix.
 *   - **absent is the common case.** Most phases have no rounds and a QA-off
 *     plan has none at all; the section must cost nothing there.
 */

import { act, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  diagnosis: vi.fn(),
  rulings: vi.fn(),
  consoleState: vi.fn(),
  issues: vi.fn(),
}));

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDiagnosis: hooks.diagnosis,
  useRulings: hooks.rulings,
  useConsoleState: hooks.consoleState,
  useIssues: hooks.issues,
}));

// The drawer's neighbours each fetch or render something of their own; none of
// them is what these tests are about.
vi.mock('@/components/situation', () => ({ SituationSummary: () => <div data-testid="situation" /> }));
vi.mock('@/features/plans/gate-card', () => ({ PhaseGate: () => null }));
vi.mock('@/components/recovery-actions', () => ({ RecoveryActions: () => null }));
vi.mock('./phase-row', () => ({ EvidenceLine: () => null }));
// The notes section has tests of its own; here the question is only whether
// the drawer mounts it for THIS phase, and only once open.
vi.mock('@/features/plans/notes-section', () => ({
  NotesSection: (props: { slug: string; phase: number; enabled?: boolean }) => (
    <div
      data-testid="notes"
      data-slug={props.slug}
      data-phase={props.phase}
      data-enabled={String(props.enabled)}
    />
  ),
}));

import { PhaseDrawer } from './phase-drawer';
import type { RunState } from '@/lib/api';

const DIAGNOSIS = {
  boardState: 'done',
  status: 'done',
  situation: { key: 'qa-failed', label: 'QA failed', why: [] },
  evidence: {},
  verification: { ok: true, ran: [], notRun: [], skipped: [] },
  workingTree: [],
};

const ROUNDS = [
  { round: 1, verdict: 'fail', reportPath: 'reports/phase-03-qa.md', costUsd: 4, turns: 20 },
  { round: 2, verdict: 'pass', reportPath: 'reports/phase-03-qa-round2.md', costUsd: 2, turns: 9 },
];

const runWith = (qa?: unknown): RunState =>
  ({
    id: 'r1',
    slug: 'alpha',
    phases: { '3': { phase: 3, status: 'done', ...(qa ? { qa } : {}) } },
  }) as never;

const ISSUE = (number: number, phase: number, over: Record<string, unknown> = {}) => ({
  number,
  state: 'open',
  title: `Issue ${number}`,
  labels: [],
  assignees: [],
  updatedAt: '2026-09-21T10:00:00.000Z',
  url: `https://github.com/acme/demo/issues/${number}`,
  provenance: { slug: 'alpha', phase, draftId: `d${number}` },
  ...over,
});

function view(run?: RunState | null, issues: unknown[] = []) {
  hooks.diagnosis.mockReturnValue({ data: DIAGNOSIS, error: null, isFetching: false });
  hooks.rulings.mockReturnValue({ data: { rulings: [] } });
  hooks.consoleState.mockReturnValue({ data: { allowTerminal: false } });
  hooks.issues.mockReturnValue({
    data: {
      at: 0,
      refreshing: false,
      repos: [{ key: 'root', label: 'demo', scopeToken: 'root', kind: 'root', state: 'fresh', issues }],
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={client}>
      <PhaseDrawer slug="alpha" phase={3} run={run} />
    </QueryClientProvider>,
  );
  // The drawer fetches on open, so every assertion below is about an open one.
  const details = out.container.querySelector('details')!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  return out;
}

describe('the phase drawer shows every QA round the run paid for', () => {
  it('lists round, verdict, report and spend, oldest first', () => {
    view(runWith(ROUNDS));
    expect(screen.getByText('QA rounds:')).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('round 1');
    expect(items[0].textContent).toContain('fail');
    expect(items[0].textContent).toContain('reports/phase-03-qa.md');
    expect(items[0].textContent).toContain('$4.00');
    expect(items[1].textContent).toContain('round 2');
    expect(items[1].textContent).toContain('pass');
    // Each round keeps its OWN report — the fix, visible.
    expect(items[1].textContent).toContain('reports/phase-03-qa-round2.md');
  });

  it('shows nothing when the phase has no rounds', () => {
    view(runWith());
    expect(screen.queryByText('QA rounds:')).toBeNull();
  });

  it('shows nothing with no run at all — the Phases tab, where rounds are not knowable', () => {
    view(null);
    expect(screen.queryByText('QA rounds:')).toBeNull();
  });
});

describe('the phase drawer carries what the phase left behind (many-plans-one-repo phase 15)', () => {
  it('mounts the forward notes for THIS phase, enabled once the drawer is open', () => {
    // Phase 11's notes section, on the run page too: a note addressed to
    // this phase is read here as well as on the Phases tab.
    view(runWith());
    const notes = screen.getByTestId('notes');
    expect(notes.dataset.slug).toBe('alpha');
    expect(notes.dataset.phase).toBe('3');
    expect(notes.dataset.enabled).toBe('true');
  });

  it('lists the issues the sessions of this phase filed, linked, and none of another phase’s', () => {
    // Phase 12's provenance: an issue filed from a draft carries the slug and
    // the phase, and that is the whole join — no title match, no label.
    view(runWith(), [ISSUE(7, 3), ISSUE(8, 3, { state: 'closed' }), ISSUE(9, 4)]);
    const section = screen.getByRole('region', { name: /Issues filed by this phase/ });
    const links = within(section).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/acme/demo/issues/7',
      'https://github.com/acme/demo/issues/8',
    ]);
    expect(section).toHaveTextContent('#7');
    expect(section).toHaveTextContent('Issue 7');
    expect(section).toHaveTextContent('closed');
    expect(section).not.toHaveTextContent('Issue 9');
  });

  it('says nothing about issues when this phase filed none — absent is the common case', () => {
    view(runWith(), [ISSUE(9, 4)]);
    expect(screen.queryByRole('region', { name: /Issues filed by this phase/ })).toBeNull();
  });
});
