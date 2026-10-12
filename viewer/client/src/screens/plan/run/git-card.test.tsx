/**
 * The Run view's Checkout fold (7.0, quiet-console phase 12; the 6.x git
 * card), and the three things it must refuse to imply.
 *
 * 1. **A shared run has no fold.** An ordinary run must not grow a section
 *    telling it what every run before worktrees already was.
 * 2. **An absent fact draws a dash, never an alarm.** The probe answers
 *    `undefined` for a number it could not measure, and a monitoring layer
 *    that turns a healthy run's page red is worse than one that says it does
 *    not know. The stopped isolated run is the whole fold in that state.
 * 3. **`unknown` is not `clean`.** The probe went to real trouble to keep the
 *    two apart (`radarPair` returns `unknown` for a pair it could not merge in
 *    memory); a page that paints them the same throws that away.
 *
 * And the refusal: parked or shared, in the server's own sentence, with its
 * fix (control-tower phase 90; `isolation-refused-parks.test.ts` RI-2 reads
 * this file's twin by path).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { RunGitView, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { RunBranch, RunCheckout, hasGitStory } from './git-card';

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

function mount(node: ReactNode, state: Record<string, unknown> = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), { allowRun: true, autopilot: true, home: HOME, ...state });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const fold = () => screen.getByTestId('run-checkout');

describe('when the fold is drawn at all', () => {
  it('draws nothing for an ordinary shared run', () => {
    mount(<RunCheckout run={run()} git={null} />);
    expect(screen.queryByTestId('run-checkout')).toBeNull();
    expect(hasGitStory(run(), null)).toBe(false);
  });

  it('draws for an isolated run, for a REFUSED one, for one the probe sees, and never without a run', () => {
    expect(hasGitStory(run({ checkout: 'worktree' }), null)).toBe(true);
    expect(hasGitStory(run({ checkout: 'refused' }), null)).toBe(true);
    expect(hasGitStory(run(), view())).toBe(true);
    expect(hasGitStory(null, view())).toBe(false);
    mount(<RunCheckout run={null} git={view()} />);
    expect(screen.queryByTestId('run-checkout')).toBeNull();
  });

  it('says what a refusal was, in the run record’s own word, and the shared tree as the outcome', () => {
    mount(<RunCheckout run={run({ checkout: 'refused', isolationRefusal: 'cap-reached' })} git={null} />);
    const refused = screen.getByTestId('git-refused');
    expect(refused.textContent).toContain('cap-reached');
    expect(refused).not.toHaveAttribute('data-parked');
    // …and the shared tree is stated as the outcome, not implied.
    expect(fold().textContent).toContain('shared with the console');
    expect(screen.getByTestId('git-checkout')).toHaveAttribute('data-status', 'refused');
  });

  it('says the run is PARKED when the refusal parked it, and names the fix (control-tower phase 90)', () => {
    const parked = {
      checkout: 'refused',
      isolationRefusal: 'cap-reached',
      isolationRefusalDetail: 'three managed worktrees are live: demo, other, third',
      halt: { kind: 'isolation-refused', at: '', reason: '' },
    };
    mount(<RunCheckout run={run(parked as never)} git={null} />, {
      refusalReasons: { 'cap-reached': CAP_REACHED },
      refusalFixes: { 'cap-reached': 'Raise the worktree cap, then Retry.' },
    });
    const refused = screen.getByTestId('git-refused');
    expect(refused.textContent).toContain('parked');
    expect(refused.textContent).toContain('Raise the worktree cap, then Retry.');
    // The refusal's own detail, in its own words.
    expect(refused.textContent).toContain('three managed worktrees are live');
    // A refusal a person must fix is the one summons here; a structural one is not.
    expect(refused).toHaveAttribute('data-parked');
    expect(refused.className).toContain('state-needs-you');
    expect(fold().textContent).toContain('the run is parked');
  });

  it('renders the refusal as a SENTENCE when the console has told it the words (G-20)', () => {
    mount(<RunCheckout run={run({ checkout: 'refused', isolationRefusal: 'cap-reached' })} git={null} />, {
      refusalReasons: { 'cap-reached': CAP_REACHED },
    });
    const refused = screen.getByTestId('git-refused').textContent ?? '';
    expect(refused).toContain(CAP_REACHED);
    // The key stays beside the sentence — it is what the journal and the record say.
    expect(refused).toContain('cap-reached');
    // A key the table does not hold (an older server, a newer refusal) still reads as the key.
    mount(<RunCheckout run={run({ checkout: 'refused', isolationRefusal: 'brand-new' })} git={null} />, {
      refusalReasons: { 'cap-reached': CAP_REACHED },
    });
    const second = screen.getAllByTestId('git-refused')[1]?.textContent ?? '';
    expect(second).toContain('brand-new');
    expect(second).toContain('the journal has its sentence');
  });
});

describe('the measured facts', () => {
  it('shows the checkout as a status word, then branch, base, divergence, changed files and disk', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={view()} />);
    const word = screen.getByTestId('git-checkout');
    expect(word).toHaveAttribute('data-vocab', 'checkout');
    expect(word).toHaveAttribute('data-status', 'worktree');
    expect(word.querySelector('[data-dot]')).not.toBeNull();
    const text = fold().textContent ?? '';
    expect(text).toContain('pe/demo');
    expect(text).toContain('main');
    expect(text).toContain('3 ahead · 1 behind');
    expect(text).toContain('2 files');
    expect(text).toContain('412 MB');
    // How the branch settles, in the shared owner's words.
    expect(text).toContain('Pull request');
  });

  it('says a mirror checkout is a mirror, and names its mounts', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree', mountedRepos: ['api', 'web'] })} git={view()} />);
    expect(fold().textContent).toContain('a mirror of 2 repositories');
    expect(fold().textContent).toContain('api, web');
  });

  it('renders paths $HOME-relative, so a screenshot carries no username', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={view()} />);
    expect(fold().textContent).toContain('~/state/wt/demo');
    expect(fold().textContent).not.toContain(HOME);
  });

  it('says a capped file list is capped — a list that silently stops is a lie', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={view({ filesTruncated: true })} />);
    expect(fold().textContent).toContain('2+ files');
    fireEvent.click(screen.getByTestId('git-files'));
    expect(fold().textContent).toContain('The probe caps this list');
  });

  it('folds what the branch changed, counted, and lists every file once opened', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={view()} />);
    const toggle = screen.getByTestId('git-files');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.textContent).toContain('(2)');
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
    fireEvent.click(toggle);
    const files = screen.getByRole('list', { name: 'Changed files' });
    expect(within(files).getByText('viewer/client/b.tsx').tagName).toBe('CODE');
  });

  it('draws dashes, not an alarm, for a stopped isolated run with no probe view', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree', workRoot: `${HOME}/state/wt/demo` })} git={null} />);
    // The run record still owns where it was working…
    expect(fold().textContent).toContain('~/state/wt/demo');
    // …and everything the probe would have measured says so honestly.
    expect(fold().textContent).toContain('—');
    expect(fold().textContent).toContain('Not measured');
    expect(screen.queryByTestId('radar')).toBeNull();
    expect(fold().querySelector('[data-paint="failed"]')).toBeNull();
  });

  it('reads the base off the run record when the probe has none — pinned to the commit it was cut at', () => {
    // The probe's `base` is the root checkout's branch, measured; the run
    // record's is what the runner RESOLVED when it cut the branch — the ref,
    // the sha and who declared the word. A stopped run has the second only.
    mount(
      <RunCheckout
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
      <RunCheckout
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

describe('the merge radar', () => {
  const radar = view({
    radar: [
      { a: 'pe/demo', b: 'pe/other', state: 'conflicted', files: ['viewer/server/a.ts'] },
      { a: 'pe/demo', b: 'main', state: 'unknown', files: [] },
      { a: 'pe/other', b: 'main', state: 'clean', files: [], zones: ['viewer/shared/vocab.js'] },
    ],
  });

  it('lists every pair with the files the verdict is about', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={radar} />);
    const rows = screen.getAllByTestId('radar-row');
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain('pe/demo ↔ pe/other');
    expect(rows[0]!.textContent).toContain('viewer/server/a.ts');
  });

  it('paints `unknown` differently from `clean` — an unmeasured pair is not a safe one', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={radar} />);
    const word = (state: string) =>
      screen
        .getAllByTestId('radar-row')
        .find((row) => row.dataset.state === state)!
        .querySelector('[data-testid="radar-word"]')!;
    expect(word('unknown').getAttribute('data-paint')).not.toBe(word('clean').getAttribute('data-paint'));
    expect(word('unknown').textContent).toContain('Not checked');
    expect(word('conflicted').getAttribute('data-vocab')).toBe('radar');
  });

  it('says a clash zone even beside a clean verdict — those files merge and are wrong afterwards', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={radar} />);
    const clean = screen.getAllByTestId('radar-row').find((row) => row.dataset.state === 'clean')!;
    expect(within(clean).getByTestId('radar-zone')).toHaveTextContent('Clash zone: viewer/shared/vocab.js');
  });

  it('says so plainly when there is only one branch to compare', () => {
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={view({ radar: [] })} />);
    expect(fold().textContent).toContain('no pair to compare');
  });
});

describe('the checkouts the console made', () => {
  it('lists each with its branch, its place and its size — and tells the console’s lock from a hand’s', () => {
    const git = view({
      checkouts: [
        ...view().checkouts,
        {
          dir: `${HOME}/state/wt/demo-p4`,
          root: false,
          managed: true,
          prunable: true,
          branch: 'pe/demo-p4',
          disk: 1024,
          locked: 'phase-console run r1',
        },
        {
          dir: `${HOME}/state/wt/demo-p5`,
          root: false,
          managed: true,
          prunable: false,
          locked: '',
        },
      ],
    });
    mount(<RunCheckout run={run({ checkout: 'worktree' })} git={git} />);
    const list = screen.getByTestId('git-checkouts');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('~/state/wt/demo-p4')).toBeInTheDocument();
    expect(within(list).getByText('prunable')).toBeInTheDocument();
    const locks = within(list).getAllByTestId('checkout-lock');
    expect(locks.map((lock) => lock.textContent)).toEqual(['locked by the console', 'locked by hand']);
    // A lock with no reason is still a lock, and says it has none.
    expect(locks[1]).toHaveAttribute('title', 'Locked, with no reason given.');
    // The root checkout is the operator's, not one the console made.
    expect(within(list).queryByText('/repo')).toBeNull();
  });
});

describe('the branch words', () => {
  it('draw the branch when a checkout has one of its own, with what it was cut from on hover', () => {
    mount(
      <RunBranch
        branch="pe/demo-p10"
        base={{ ref: 'main', sha: '0123456789abcdef', source: 'origin-head', declaredBy: 'default' }}
      />,
    );
    const branch = screen.getByTestId('run-branch');
    expect(branch.textContent).toBe('pe/demo-p10');
    expect(branch.tagName).toBe('CODE');
    expect(branch.getAttribute('title')).toMatch(
      /Cut from main at 0123456789ab \(the remote’s HEAD; the shipped default\)/,
    );
  });

  it('draw NOTHING without one — absent means the run’s own branch, not a gap', () => {
    const { container } = mount(<RunBranch />);
    expect(container.querySelector('[data-testid="run-branch"]')).toBeNull();
  });
});

describe('the fold is reachable', () => {
  it('has no axe violations, with a refusal, the radar and the changed files open', async () => {
    const { container } = mount(
      <RunCheckout
        run={run({ checkout: 'refused', isolationRefusal: 'cap-reached' })}
        git={view({ radar: [{ a: 'pe/demo', b: 'main', state: 'overlap', files: ['a.ts'] }] })}
      />,
      { refusalReasons: { 'cap-reached': CAP_REACHED } },
    );
    fireEvent.click(screen.getByTestId('git-files'));
    await expectNoAxeViolations(container);
  });
});
