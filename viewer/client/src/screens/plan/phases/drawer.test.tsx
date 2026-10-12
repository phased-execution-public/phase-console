/**
 * The phase drawer — a row opened in place (7.0, quiet-console phase 10;
 * ported from `features/runs/phase-drawer.test.tsx`).
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
 *     the Phases view, where there is no run to pass, the section is absent
 *     rather than an empty header.
 *   - **every round keeps its own report.** The bug rounds used to have is that
 *     they overwrote each other's reports, so a history that showed one path
 *     twice would be showing the bug rather than the fix.
 *   - **absent is the common case.** Most phases have no rounds and a QA-off
 *     plan has none at all; the section must cost nothing there.
 *
 * 7.0's fold is a `Disclosure` that unmounts what it folds, so every case
 * presses "Why is this not done?" before it looks inside.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';

const hooks = vi.hoisted(() => ({
  diagnosis: vi.fn(),
  rulings: vi.fn(),
  consoleState: vi.fn(),
  issues: vi.fn(),
}));

vi.mock('@/data/runs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDiagnosis: hooks.diagnosis,
  useRulings: hooks.rulings,
}));
vi.mock('@/data/console', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConsoleState: hooks.consoleState,
}));
vi.mock('@/data/repo', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIssues: hooks.issues,
}));
// The phase's prose is fetched on open; none of these cases is about it
// (`inspector.test.tsx` is).
vi.mock('@/data/plans', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlan: () => ({ data: undefined }),
}));

// The drawer's neighbours each fetch or render something of their own; none of
// them is what these tests are about.
vi.mock('./situation', () => ({
  SituationSummary: () => <div data-testid="situation" />,
}));
vi.mock('@/screens/settings/account-row', () => ({ ACCOUNT_RECOVERY_PARTS: {} }));
vi.mock('../run/activity', () => ({ LastActivity: () => null, NowPanel: () => null }));
vi.mock('./gate-card', () => ({ PhaseGate: () => null }));
vi.mock('@/cards/recovery-actions', () => ({ RecoveryActions: () => null }));
vi.mock('./row', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  EvidenceWords: () => null,
}));
// The notes section has tests of its own; here the question is only whether
// the drawer mounts it for THIS phase, and only once open.
vi.mock('./notes', () => ({
  NotesSection: (props: { slug: string; phase: number; enabled?: boolean }) => (
    <div
      data-testid="notes"
      data-slug={props.slug}
      data-phase={props.phase}
      data-enabled={String(props.enabled)}
    />
  ),
}));

import { PhaseDrawer } from './drawer';

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

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Press "Why is this not done?" — the diagnosis is fetched on open, so every assertion is about an open one. */
const openWhy = () => fireEvent.click(screen.getByTestId('why-3'));

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
  const out = mount(<PhaseDrawer slug="alpha" phase={3} run={run} />);
  openWhy();
  return out;
}

/** A section under its own heading: the heading's block. */
const sectionOf = (heading: string) =>
  screen.getByRole('heading', { name: heading }).closest('div')!.parentElement!;

describe('the phase drawer shows every QA round the run paid for', () => {
  it('lists round, verdict, report and spend, oldest first', () => {
    view(runWith(ROUNDS));
    const section = sectionOf('QA rounds');
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Round 1');
    expect(items[0]!.querySelector('[data-status]')).toHaveAttribute('data-status', 'fail');
    expect(items[0]!.textContent).toContain('reports/phase-03-qa.md');
    expect(items[0]!.textContent).toContain('$4.00');
    expect(items[1]!.textContent).toContain('Round 2');
    expect(items[1]!.querySelector('[data-status]')).toHaveAttribute('data-status', 'pass');
    // Each round keeps its OWN report — the fix, visible — and each is the way to its own sheet.
    expect(within(items[0]!).getByRole('link', { name: 'reports/phase-03-qa.md' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=3',
    );
    expect(within(items[1]!).getByRole('link', { name: 'reports/phase-03-qa-round2.md' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=3:2',
    );
  });

  it('shows nothing when the phase has no rounds', () => {
    view(runWith());
    expect(screen.queryByRole('heading', { name: 'QA rounds' })).toBeNull();
  });

  it('shows nothing with no run at all — the Phases view, where rounds are not knowable', () => {
    view(null);
    expect(screen.queryByRole('heading', { name: 'QA rounds' })).toBeNull();
  });
});

describe('the phase drawer carries what the phase left behind (many-plans-one-repo phase 15)', () => {
  it('mounts the forward notes for THIS phase, enabled once the drawer is open', () => {
    // Phase 11's notes section, on the run page too: a note addressed to
    // this phase is read here as well as on the Phases view.
    hooks.diagnosis.mockReturnValue({ data: DIAGNOSIS, error: null, isFetching: false });
    hooks.rulings.mockReturnValue({ data: { rulings: [] } });
    hooks.consoleState.mockReturnValue({ data: { allowTerminal: false } });
    hooks.issues.mockReturnValue({ data: undefined });
    mount(<PhaseDrawer slug="alpha" phase={3} run={runWith()} />);
    // Folded, the diagnosis and the notes under it are not mounted at all.
    expect(screen.queryByTestId('notes')).toBeNull();
    openWhy();
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

/* ------------------------------------------------------------------------- *
 * The QA section (control-tower phase 23, #27) — what the QA tab held for a
 * row, one press from it now.
 * ------------------------------------------------------------------------- */

function openWithView(viewOver: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  hooks.diagnosis.mockReturnValue({ data: DIAGNOSIS, error: null, isFetching: false });
  hooks.rulings.mockReturnValue({ data: { rulings: [] } });
  hooks.consoleState.mockReturnValue({ data: { allowTerminal: false, allowWrites: true, allowRun: true } });
  hooks.issues.mockReturnValue({ data: { at: 0, refreshing: false, repos: [] } });
  mount(
    <PhaseDrawer
      slug="alpha"
      phase={3}
      run={null}
      view={
        { phase: 3, title: 'Three', state: 'done', size: 'M', weight: 1, gated: false, ...viewOver } as never
      }
      {...extra}
    />,
  );
  // The QA section is drawn at once — it costs nothing — and needs no press.
  return screen.getByTestId('drawer-qa');
}

describe('the drawer’s QA section', () => {
  it('names the regime WITH the level that decided it, the verdict and its round, and what it holds', () => {
    const qa = openWithView(
      {
        qa: { result: 'fail', report: 'reports/phase-03-qa-round2.md' },
        qaMode: { mode: 'on', source: 'phase' },
        qaRounds: { count: 2, latest: { round: 2, result: 'fail' } },
      },
      { holds: [5, 6], planQaMode: 'off' },
    );
    expect(qa.textContent).toContain('on, decided by the phase’s own QA bullet');
    expect(qa.textContent).toContain('round 2 of 2');
    expect(qa.querySelector('[data-status="fail"]')).toBeInTheDocument();
    expect(qa.textContent).toContain('P5, P6 — until this verdict changes');
    // The round history, each round a link to its own report sheet.
    expect(within(qa).getByRole('link', { name: 'round 1' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=3',
    );
    expect(within(qa).getByRole('link', { name: 'round 2' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=3:2',
    );
    expect(within(qa).getByRole('link', { name: 'Open the report' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=3:2',
    );
  });

  it('says the PLAN decided when the phase has no bullet of its own — waived is a regime too', () => {
    const qa = openWithView({ qaMode: { mode: 'waived', source: 'plan' } });
    expect(qa.textContent).toContain('waived, decided by the plan’s QA gate line');
    expect(qa.textContent).toContain('none recorded');
  });

  it('a phase HELD by a dependency’s verdict says so, in the engine’s own words', () => {
    const qa = openWithView({ state: 'waiting', blockedBy: [{ phase: 2, why: 'qa:fail' }] });
    expect(qa.textContent).toContain('P2’s verdict (fail) — the engine says qa:fail');
  });

  it('is absent when the drawer is opened without the phase — the diagnosis alone, as before', () => {
    view(null);
    expect(screen.queryByTestId('drawer-qa')).toBeNull();
  });
});

describe('the drawer shows what the BASELINE said, as it shows a verdict’s red (control-tower phase 106, #195)', () => {
  const withBaseline = (commands: unknown[]): RunState =>
    ({
      id: 'r1',
      slug: 'alpha',
      phases: {
        '3': {
          phase: 3,
          status: 'running',
          baseline: {
            at: '2026-10-03T12:00:00.000Z',
            tree: 'a'.repeat(40),
            head: 'b'.repeat(40),
            concurrent: true,
            commands,
          },
        },
      },
    }) as never;

  it('names a red baseline line with its failing tests and the tail of its output', () => {
    view(
      withBaseline([
        { command: 'npm test', ok: true, code: 0, from: 'measured' },
        {
          command: 'task verify:local',
          ok: false,
          code: 1,
          from: 'measured',
          once: true,
          failures: ['preview store › round-trip'],
          tail: '# AuthenticationError: invalid password\n# fail 1',
        },
      ]),
    );
    const section = sectionOf('Red before this phase began');
    expect(within(section).getByText('task verify:local')).toBeTruthy();
    expect(within(section).queryByText('npm test')).toBeNull();
    expect(section.textContent).toContain('preview store › round-trip');
    expect(section.textContent).toContain('AuthenticationError: invalid password');
  });

  it('says why a line could not run at all — the machine, not a red the phase inherited', () => {
    view(
      withBaseline([
        {
          command: 'cd hetzner && npm run verify:local',
          ok: false,
          code: 1,
          from: 'measured',
          environment: 'the dependencies are not installed here — `hetzner/node_modules` is absent',
          tail: "Error: Cannot find module 'tsx'",
        },
      ]),
    );
    const section = sectionOf('Red before this phase began');
    expect(section.textContent).toContain('could not run here');
    expect(section.textContent).toContain('hetzner/node_modules');
  });

  it('is absent when every baseline line was green — the common case', () => {
    view(withBaseline([{ command: 'npm test', ok: true, code: 0, from: 'measured' }]));
    expect(screen.queryByRole('heading', { name: 'Red before this phase began' })).toBeNull();
  });
});
