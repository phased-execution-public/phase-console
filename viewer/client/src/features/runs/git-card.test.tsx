/**
 * The Git card, and the three things it must refuse to imply.
 *
 * 1. **A shared run has no card.** That is EC1's "pick one", asserted rather
 *    than left to the reader: an ordinary run must not grow a panel telling it
 *    what every run before worktrees already was.
 * 2. **An absent fact draws a dash, never an alarm.** The probe answers
 *    `undefined` for a number it could not measure, and a monitoring layer that
 *    turns a healthy run's page red is worse than one that says it does not
 *    know. The stopped-isolated-run case is the whole card in that state.
 * 3. **`unknown` is not `clean`.** The probe went to real trouble to keep the
 *    two apart (`radarPair` returns `unknown` for a pair it could not merge in
 *    memory); a page that paints them the same throws that away.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { GitCard, BranchChip, hasGitStory } from './git-card';
import { keys } from '@/lib/queries';
import { TooltipProvider } from '@/components/ui';
import type { RunGitView, RunState } from '@/lib/api';

const HOME = '/home/someone';

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'running',
    autonomy: 'auto',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activePhase: 10,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    ...over,
  }) as RunState;

const view = (over: Partial<RunGitView> = {}): RunGitView => ({
  at: new Date().toISOString(),
  base: 'main',
  branch: 'pe/demo',
  workRoot: `${HOME}/state/wt/demo`,
  divergence: { ahead: 3, behind: 1 },
  files: ['viewer/server/a.ts', 'viewer/client/b.tsx'],
  filesTruncated: false,
  disk: 412 * 1024 * 1024,
  checkouts: [
    { dir: '/repo', root: true, managed: false, prunable: false, branch: 'main' },
    {
      dir: `${HOME}/state/wt/demo`,
      root: false,
      managed: true,
      prunable: false,
      branch: 'pe/demo',
      disk: 412 * 1024 * 1024,
    },
  ],
  radar: [],
  ...over,
});

const CAP_REACHED = 'the console already holds as many managed worktrees as `worktreeMaxConcurrent` allows';

function mount(node: React.ReactNode, state: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.state(), { allowRun: true, autopilot: true, home: HOME, ...state });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('when the card appears at all', () => {
  it('renders nothing for an ordinary shared run — EC1, the pick', () => {
    mount(<GitCard run={run()} git={null} />);
    expect(screen.queryByTestId('git-card')).toBeNull();
    expect(hasGitStory(run(), null)).toBe(false);
  });

  it('renders for an isolated run, for a REFUSED one, and for neither without a run', () => {
    expect(hasGitStory(run({ checkout: 'worktree' }), null)).toBe(true);
    expect(hasGitStory(run({ checkout: 'refused' }), null)).toBe(true);
    expect(hasGitStory(run(), view())).toBe(true);
    expect(hasGitStory(null, view())).toBe(false);
  });

  it('says what a refusal was, in the run record’s own word', () => {
    mount(<GitCard run={run({ checkout: 'refused', isolationRefusal: 'cap-reached' })} git={null} />);
    expect(screen.getByTestId('git-refused').textContent).toContain('cap-reached');
    // …and the shared tree is stated as the outcome, not implied.
    expect(screen.getByTestId('git-card').textContent).toContain('shared with the console');
  });

  it('renders the refusal as a SENTENCE when the console has told it the words (G-20)', () => {
    mount(<GitCard run={run({ checkout: 'refused', isolationRefusal: 'cap-reached' })} git={null} />, {
      refusalReasons: { 'cap-reached': CAP_REACHED },
    });
    const refused = screen.getByTestId('git-refused').textContent ?? '';
    expect(refused).toContain(CAP_REACHED);
    // The key stays beside the sentence — it is what the journal and the record say.
    expect(refused).toContain('cap-reached');
    // A key the table does not hold (an older server, a newer refusal) still reads as the key.
    mount(<GitCard run={run({ checkout: 'refused', isolationRefusal: 'brand-new' })} git={null} />, {
      refusalReasons: { 'cap-reached': CAP_REACHED },
    });
    expect(screen.getAllByTestId('git-refused')[1]?.textContent).toContain('brand-new');
  });
});

describe('the measured facts', () => {
  it('shows branch, base, divergence, changed files and disk', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={view()} />);
    const card = screen.getByTestId('git-card');
    expect(card.textContent).toContain('pe/demo');
    expect(card.textContent).toContain('main');
    expect(card.textContent).toContain('3 ahead · 1 behind');
    expect(card.textContent).toContain('2 files');
    expect(card.textContent).toContain('412 MB');
  });

  it('renders paths $HOME-relative, so a screenshot carries no username', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={view()} />);
    const card = screen.getByTestId('git-card');
    expect(card.textContent).toContain('~/state/wt/demo');
    expect(card.textContent).not.toContain(HOME);
  });

  it('says a capped file list is capped — a list that silently stops is a lie', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={view({ filesTruncated: true })} />);
    expect(screen.getByTestId('git-card').textContent).toContain('2+ files');
  });

  it('draws dashes, not an alarm, for a stopped isolated run with no probe view', () => {
    mount(<GitCard run={run({ checkout: 'worktree', workRoot: `${HOME}/state/wt/demo` })} git={null} />);
    const card = screen.getByTestId('git-card');
    // The run record still owns where it was working…
    expect(card.textContent).toContain('~/state/wt/demo');
    // …and everything the probe would have measured says so honestly.
    expect(card.textContent).toContain('—');
    expect(card.textContent).toContain('Not measured');
    expect(screen.queryByTestId('radar')).toBeNull();
  });

  it('reads the base off the run record when the probe has none — pinned to the commit it was cut at (phase 15)', () => {
    // The probe's `base` is the root checkout's branch, measured; the run
    // record's is what the runner RESOLVED when it cut the branch — the ref,
    // the sha and who declared the word. A stopped run has the second and not
    // the first, and a dash there was the one fact this card could have said.
    mount(
      <GitCard
        run={run({
          checkout: 'worktree',
          workRoot: `${HOME}/state/wt/demo`,
          base: { ref: 'release/5.1', sha: 'abcdef1234567890abcdef', source: 'ref', declaredBy: 'plan' },
        })}
        git={null}
      />,
    );
    const base = screen.getByTestId('git-base');
    expect(base).toHaveTextContent('release/5.1');
    expect(base).toHaveTextContent('abcdef123456');
    expect(base.getAttribute('title')).toMatch(/a ref named by hand; the plan’s `Base branch:` line/);
  });

  it('prefers the probe’s measured base over the record’s word when both are there', () => {
    mount(
      <GitCard
        run={run({
          checkout: 'worktree',
          workRoot: `${HOME}/state/wt/demo`,
          base: { ref: 'release/5.1', sha: 'abcdef1234567890', source: 'ref', declaredBy: 'plan' },
        })}
        git={view()}
      />,
    );
    expect(screen.getByTestId('git-base')).toHaveTextContent('main');
    expect(screen.getByTestId('git-base')).not.toHaveTextContent('release/5.1');
  });
});

describe('the conflict radar', () => {
  const radar = view({
    radar: [
      { a: 'pe/demo', b: 'pe/other', state: 'conflicted', files: ['viewer/server/a.ts'] },
      { a: 'pe/demo', b: 'main', state: 'unknown', files: [] },
      { a: 'pe/other', b: 'main', state: 'clean', files: [] },
    ],
  });

  it('lists every pair with the files the verdict is about', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={radar} />);
    const rows = screen.getAllByTestId('radar-row');
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain('pe/demo ↔ pe/other');
    expect(rows[0]!.textContent).toContain('viewer/server/a.ts');
  });

  it('paints `unknown` differently from `clean` — an unmeasured pair is not a safe one', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={radar} />);
    const rows = screen.getAllByTestId('radar-row');
    const unknown = rows.find((r) => r.dataset.state === 'unknown')!;
    const clean = rows.find((r) => r.dataset.state === 'clean')!;
    const tone = (row: HTMLElement) => row.querySelector('span')!.className;
    expect(tone(unknown)).not.toBe(tone(clean));
  });

  it('says so plainly when there is only one branch to compare', () => {
    mount(<GitCard run={run({ checkout: 'worktree' })} git={view({ radar: [] })} />);
    expect(screen.getByTestId('git-card').textContent).toContain('no pair to compare');
  });
});

describe('the branch chip', () => {
  it('renders the branch when the lane has one of its own', () => {
    mount(<BranchChip branch="pe/demo-p10" />);
    expect(screen.getByTestId('branch-chip').textContent).toContain('pe/demo-p10');
  });

  it('renders NOTHING without one — absent means the run’s own branch, not a gap', () => {
    const { container } = mount(<BranchChip />);
    expect(container.querySelector('[data-testid="branch-chip"]')).toBeNull();
  });
});
