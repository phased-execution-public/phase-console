/**
 * No datum removed from Repo — every fact its rows showed is within TWO
 * interactions (control-tower phase 26's ledger, walked over 7.0's place in
 * quiet-console phases 17 and 18; `docs/design.md` §5: "No datum removed ·
 * every datum within 2 interactions").
 *
 * 7.0 draws Repo's tables on the grid, and the grid cuts its columns to the
 * width it measures, so the ledger is walked where the cut bites: every box is
 * stubbed 400 px wide, which leaves each table its priority-one columns and
 * folds the rest into the row. A fact is on the row (no press), in the row's
 * fold or in the panel the row's link opens (one press), or one press beyond
 * that. A fact that needs a third press, or is on no page at all, fails here
 * by name.
 *
 * Since 7.0 a status is a dot and a WORD, never an icon (quiet-console phase
 * 4). The status words are read as the label a person sees and as the raw
 * word on `data-status`, which is what the typed family promises a test.
 *
 * The Issues desk is walked like the git sections: an issue's number and
 * title on its row, its readings, repository, labels, people and clock in the
 * row's fold, and the whole issue in the panel its link opens.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});


import type {
  IssuesPayload,
  RepoBranches,
  RepoCheckouts,
  RepoDiff,
  RepoGraph,
  RepoSettles,
} from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { relativeTime } from '@/lib/format';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { TooltipProvider } from '@/ui/tooltip';
import RepoPlace from './index';

vi.setConfig({ testTimeout: 20_000 });

const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const STATE = {
  autopilot: true,
  root: { path: '/repo', ok: true },
  // `homePath` shortens a path under this to `~/…`.
  home: '/home/op',
  repo: { available: true, branch: 'main', ahead: 2, behind: 0, dirty: ['docs/plans/a.md'] },
};

const BRANCHES: RepoBranches = {
  trunk: 'main',
  truncated: true,
  divergenceTruncated: true,
  branches: [
    {
      name: 'main',
      head: 'a'.repeat(40),
      short: 'aaaaaaa',
      current: true,
      trunk: true,
      subject: 'the trunk as it stands',
      upstream: 'origin/main',
      author: 'p9',
      at: at(2),
    },
    {
      name: 'pe/control-tower-p26',
      head: 'c'.repeat(40),
      short: 'ccccccc',
      current: false,
      trunk: false,
      subject: 'repo, issues and insights',
      run: { slug: 'control-tower', phase: 26 },
      ahead: 3,
      behind: 1,
      heldBy: ['/home/op/.state/lanes/p26'],
      upstream: 'origin/pe/control-tower-p26',
      author: 'p26 session',
      at: at(5),
    },
  ],
};

const CHECKOUTS: RepoCheckouts = {
  truncated: false,
  checkouts: [
    {
      dir: '/repo',
      repo: 'root',
      role: 'root',
      root: true,
      managed: false,
      prunable: false,
      via: 'none',
      branch: 'main',
    },
    {
      dir: '/state/runs/abc/integration',
      repo: 'root',
      role: 'run',
      root: false,
      managed: true,
      prunable: false,
      via: 'record',
      run: { slug: 'control-tower', runId: 'abc123', status: 'running', live: true },
      branch: 'pe/control-tower',
    },
    {
      dir: '/state/runs/old/integration',
      repo: 'phased-execution',
      role: 'debris',
      root: false,
      managed: false,
      prunable: true,
      via: 'branch',
      run: { slug: 'gone', phase: 9 },
      detached: 'detached@1f44624',
    },
  ] as RepoCheckouts['checkouts'],
};

const SETTLES: RepoSettles = {
  truncated: false,
  scanned: { runs: 25, entriesPerRun: 500 },
  events: [
    {
      slug: 'control-tower',
      runId: 'abc123',
      at: at(1),
      kind: 'unsupported',
      phase: 26,
      detail: 'a mirror run settles in its one tree',
      branch: 'pe/control-tower',
      strategy: 'fast-forward',
      via: 'record',
    },
    { slug: 'demo', runId: 'def456', at: at(3), kind: 'failed', via: 'journal' },
  ],
};

const GRAPH: RepoGraph = {
  trunk: 'main',
  tips: ['main', 'pe/control-tower'],
  tipsTruncated: false,
  truncated: false,
  commits: [
    {
      sha: 'b2'.repeat(20),
      short: 'b2b2b2b',
      parents: ['a1'.repeat(20)],
      refs: ['pe/control-tower'],
      subject: 'Settle the lane on the trunk',
      author: 'p26 session',
      at: at(4),
    },
    {
      sha: 'a1'.repeat(20),
      short: 'a1a1a1a',
      parents: [],
      refs: ['main'],
      subject: 'The first commit',
      author: 'p9',
      at: at(30),
    },
  ],
};

const PATCH = [
  'diff --git a/viewer/x.ts b/viewer/x.ts',
  '--- a/viewer/x.ts',
  '+++ b/viewer/x.ts',
  '@@ -1,2 +1,2 @@',
  '-the line it had',
  '+the line it has',
  ' the line it kept',
  '',
].join('\n');

/** The range's file list, and — once a file is asked for — that file's patch. */
const DIFF = (path: string): RepoDiff => ({
  files: [{ path: 'viewer/x.ts', additions: 12, deletions: 3, binary: false }],
  filesTruncated: false,
  fileCount: 1,
  ...(path.includes('path=')
    ? { patch: { path: 'viewer/x.ts', text: PATCH, truncated: false, failed: false } }
    : {}),
});

const ISSUES: IssuesPayload = {
  at: 1_757_000_012_000,
  refreshing: false,
  repos: [
    {
      key: 'root',
      label: 'pe-hub',
      scopeToken: 'pe-hub',
      kind: 'root',
      remote: 'git@github.com:acme/one.git',
      nameWithOwner: 'acme/one',
      state: 'fresh',
      fetchedAt: 1_757_000_000_000,
      ageMs: 12_000,
      issues: [
        {
          number: 7,
          title: 'the lock never releases',
          state: 'OPEN',
          labels: ['bug'],
          assignees: ['dev'],
          updatedAt: '2026-09-01T12:00:00Z',
          url: 'https://github.com/acme/one/issues/7',
        },
      ],
    },
  ] as IssuesPayload['repos'],
};

function routeOf(hash: string) {
  const [path = '', queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/** The place at an address, the panel's body beside it; `go` is the router's re-render. */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (address: string) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RepoPlace route={routeOf(address)} />
        <aside data-testid="panel">
          <InspectorHost />
        </aside>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { go: (next: string) => view.rerender(tree(next)) };
}

/** Every press is counted; a datum's budget is two. */
let presses = 0;
const press = (el: Element) => {
  presses += 1;
  fireEvent.click(el);
};

/** Press a row's link and arrive where it leads — what the router does with a hash. */
function follow(link: Element, go: (next: string) => void) {
  press(link);
  go(link.getAttribute('href') ?? '');
}

const panelText = () => screen.getByTestId('panel').textContent ?? '';

async function expectWithin(
  budget: number,
  facts: readonly string[],
  where: () => string = () => document.body.textContent ?? '',
) {
  for (const fact of facts) {
    await waitFor(() => expect(where().includes(fact), `"${fact}" is not on the page`).toBe(true));
  }
  expect(presses, `reached in ${presses} presses`).toBeLessThanOrEqual(budget);
}

/** A row the grid drew, by its test id and a data attribute. */
async function rowWith(testId: string, attribute: string, value: string): Promise<HTMLElement> {
  let row: HTMLElement | undefined;
  await waitFor(() => {
    row = screen.getAllByTestId(testId).find((r) => r.getAttribute(attribute) === value);
    expect(row, `no ${testId} with ${attribute}="${value}"`).toBeTruthy();
  });
  return row!;
}

/** One press: the row's folded columns, when the grid folded any. */
function openFold(row: HTMLElement) {
  const more = within(row).queryByRole('button', { name: /Show the rest of this row/ });
  expect(more, 'the row folds nothing at 400 px, so this ledger proves nothing').toBeTruthy();
  press(more!);
}

/** A status of the typed family: a dot and its word, the raw word on `data-status`. */
function status(vocab: string, word: string): string {
  const found = document.querySelector(`[data-vocab="${vocab}"][data-status="${word}"]`);
  expect(found, `no ${vocab} status for "${word}"`).toBeTruthy();
  expect(found!.querySelector('[data-dot]'), `the ${vocab} status for "${word}" draws its dot`).toBeTruthy();
  return (found!.textContent ?? '').trim();
}

beforeEach(() => {
  presses = 0;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  // A 400 px box everywhere: the grid and the history cut their columns to it.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  server.reads = {
    '/api/state': STATE,
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/repo/graph': GRAPH,
    '/api/repo/branches': BRANCHES,
    '/api/repo/checkouts': CHECKOUTS,
    '/api/repo/settles': SETTLES,
    '/api/repo/diff': DIFF,
    '/api/issues': ISSUES,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetInspectorForTests();
});

describe('every datum of Repo is within two interactions, at a 400 px table', () => {
  it('the glance: the branch, its tracking and the docs corner; the uncommitted paths one fold away', async () => {
    mount('#/repo');
    await expectWithin(0, ['main', '2 commits not pushed, up to date.', '1 file uncommitted under docs/.']);
    press(screen.getByTestId('repo-docs-fold'));
    await expectWithin(1, ['docs/plans/a.md']);
  });

  it('History: subject and sha on the row; author, refs, parents and when one press away in the panel', async () => {
    const { go } = mount('#/repo');
    const row = await rowWith('commit-row', 'data-sha', 'b2'.repeat(20));
    await expectWithin(0, ['Settle the lane on the trunk', 'b2b2b2b', 'The first commit', 'a1a1a1a']);
    // At 400 px the history keeps the sha and cuts the rest: the panel holds them.
    expect(within(row).queryByText('p26 session')).toBeNull();
    follow(within(row).getByRole('link'), go);
    await expectWithin(
      1,
      [
        'Committed by p26 session',
        'pe/control-tower',
        'a1a1a1a',
        relativeTime(Date.parse(GRAPH.commits[0]!.at)),
      ],
      panelText,
    );
  });

  it('Branches: name, checked out, trunk and subject on the row; run, divergence, holders, last commit, upstream, head and author one press away', async () => {
    const { go } = mount('#/repo/branches');
    await expectWithin(0, [
      'main',
      'Checked out',
      'Trunk',
      'the trunk as it stands',
      'pe/control-tower-p26',
      'repo, issues and insights',
    ]);
    // The two windows the list was read through are said, never implied.
    expect(screen.getByTestId('branches-truncated')).toBeInTheDocument();
    expect(screen.getByTestId('divergence-truncated')).toBeInTheDocument();

    const lane = await rowWith('branch-row', 'data-name', 'pe/control-tower-p26');
    openFold(lane);
    await expectWithin(1, [
      'control-tower P26',
      '3 ahead, 1 behind',
      '1 checkout',
      relativeTime(Date.parse(BRANCHES.branches[1]!.at!)),
      'origin/pe/control-tower-p26',
      'ccccccc',
      'p26 session',
    ]);

    // The same facts, and the holder's directory, through the row's link.
    presses = 0;
    follow(within(lane).getAllByRole('link')[0]!, go);
    await expectWithin(
      1,
      [
        'control-tower P26: read from the branch name',
        '3 ahead, 1 behind',
        'origin/pe/control-tower-p26',
        '~/.state/lanes/p26',
        'c'.repeat(40),
      ],
      panelText,
    );
  });

  it('Working trees: directory, role and attribution on the row; repository, branch or detached head, liveness and the flags one press away', async () => {
    const { go } = mount('#/repo/trees');
    await expectWithin(0, ['/state/runs/old/integration', 'by name', 'record']);
    // The role is a dot and its word, the raw role on data-status.
    expect(status('checkout-role', 'debris')).toBe('Debris');
    expect(status('checkout-role', 'run')).toBe('Run');
    expect(status('checkout-role', 'root')).toBe('Root');
    // And the note that asks for the Attributed column before reclaiming.
    expect(screen.getByTestId('debris-note').textContent).toMatch(/One tree is/);

    openFold(await rowWith('checkout-row', 'data-role', 'debris'));
    await expectWithin(1, ['phased-execution', 'detached@1f44624', 'Prunable', 'gone P9, from the name']);

    presses = 0;
    const run = await rowWith('checkout-row', 'data-role', 'run');
    openFold(run);
    await expectWithin(1, ['pe/control-tower', 'Managed', 'abc123']);
    // Whether its run lives is the presence word, never a hue alone.
    expect(status('presence', 'live')).toBe('Live');

    presses = 0;
    follow(within(run).getAllByRole('link')[0]!, go);
    await expectWithin(
      1,
      ['The run record says so: control-tower, run abc123, running, and a runner is driving it now.'],
      panelText,
    );
  });

  it('Settles: run, phase, detail and event on the row; branch, strategy, source, when and the run id one press away', async () => {
    const { go } = mount('#/repo/settles');
    await expectWithin(0, ['control-tower', 'P26', 'a mirror run settles in its one tree', 'demo']);
    expect(status('settle', 'unsupported')).toBe('Not supported here');
    expect(status('settle', 'failed')).toBe('Failed');
    expect(screen.getByTestId('settles-scanned').textContent).toMatch(/25 run journals, at most 500 entries/);

    const row = await rowWith('settle-row', 'data-kind', 'unsupported');
    openFold(row);
    await expectWithin(1, [
      'pe/control-tower',
      'fast-forward',
      'Record',
      relativeTime(Date.parse(SETTLES.events[0]!.at)),
      'abc123',
    ]);

    presses = 0;
    follow(within(row).getAllByRole('link')[0]!, go);
    await expectWithin(1, ['abc123', 'fast-forward', 'From the run record'], panelText);
  });

  it('Changes: a file’s path and counts on its line; its patch one press; its record two', async () => {
    const { go } = mount('#/repo/changes');
    const file = await screen.findByRole('button', { name: /viewer\/x\.ts/ });
    await expectWithin(0, ['viewer/x.ts', '+12 −3']);
    press(file);
    go(window.location.hash);
    await expectWithin(1, ['the line it had', 'the line it has']);
    press(await screen.findByRole('button', { name: 'Inspect this file' }));
    await expectWithin(2, ['12 added, 3 removed', 'The working tree against HEAD'], panelText);
  });

  it('Issues: number and title on the row; the three readings, repository, labels, people and when one fold away; the whole issue one press away', async () => {
    const { go } = mount('#/repo/issues');
    const row = await rowWith('issue-row', 'data-ref', 'acme/one#7');
    await expectWithin(0, ['#7', 'the lock never releases']);
    // Under Repo's own section links, with Issues the current one.
    const nav = screen.getByRole('navigation', { name: 'Repo sections' });
    expect(within(nav).getByRole('link', { name: 'Issues' })).toHaveAttribute('aria-current', 'page');
    // The estate and the age of what is shown are said under the toolbar.
    expect(screen.getByTestId('estate-line').textContent).toBe('1 repository.');

    openFold(row);
    await expectWithin(1, [
      'pe-hub',
      'bug',
      'dev',
      relativeTime(Date.parse(ISSUES.repos[0]!.issues[0]!.updatedAt)),
      'Open on GitHub',
      'acme/one#7',
      'No body cached yet',
    ]);
    // The readings are dots and words of the issue vocabularies.
    expect(status('issue-category', 'bug')).toBe('Bug');
    expect(status('issue-severity', 'none')).toBe('No severity');
    expect(status('issue-plan', 'none')).toBe('No plan');

    presses = 0;
    follow(within(row).getAllByRole('link')[0]!, go);
    await expectWithin(1, ['the lock never releases', 'acme/one', 'Scope token', 'pe-hub', 'dev'], panelText);
    // GitHub's page is the record's act, under its Actions tab: the second
    // press, and Radix moves a tab on a primary mouse-down, never a click.
    presses += 1;
    fireEvent.mouseDown(within(screen.getByTestId('panel')).getByRole('tab', { name: 'Actions' }), {
      button: 0,
    });
    await expectWithin(2, ['Open on GitHub'], panelText);
  });

});

describe('a status column of the Repo tables is never colour alone', () => {
  it('every role, liveness and settle cell is a dot and a word', async () => {
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    // At 400 px a tree's liveness is in its fold: open the row a run record claims.
    openFold(await rowWith('checkout-row', 'data-role', 'run'));
    const trees = [...document.querySelectorAll('[data-vocab][data-status]')];
    expect(trees.length).toBeGreaterThanOrEqual(4);
    for (const el of trees) {
      expect(el.querySelector('[data-dot]'), el.outerHTML.slice(0, 80)).toBeTruthy();
      expect((el.textContent ?? '').trim().length, el.outerHTML.slice(0, 80)).toBeGreaterThan(2);
    }
  });

  it('and the settles say their event in words', async () => {
    mount('#/repo/settles');
    await screen.findAllByTestId('settle-row');
    const words = [...document.querySelectorAll('[data-vocab="settle"][data-status]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(words).toEqual(['Not supported here', 'Failed']);
  });
});
