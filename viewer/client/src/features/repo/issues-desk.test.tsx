/**
 * The Issues desk (control-tower phase 118): a repository's whole issue list
 * with its category, severity, plan status and labels.
 *
 *   exit 3  the columns sort, from and into the URL; the category, severity and
 *           plan filters join the others in the URL; a selection survives a
 *           sort and a filter.
 *   exit 4  the picker lists the estate and every repository the operator
 *           added, an added one reads "outside this console", and Add / Remove
 *           write `prefs.issueRepos`.
 *   exit 2  the three readings are drawn through the status family, and an
 *           issue from a server that sent none is derived here by the same
 *           function the server uses.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState, Issue, IssuesPayload, RepoIssues } from '@/lib/api';
import { verbActions } from '@/app/command/actions';
import RepoPage from './index';
import { DEFAULT_FILTER, boardRows, deskHref, sortIssueRows, triageOfIssue, type IssueRow } from './issues';

const { state, issues, issuesRefresh, savePrefs, repoTargets, skills, accounts, mcp, navigateSpy } =
  vi.hoisted(() => ({
    state: vi.fn(),
    issues: vi.fn(),
    issuesRefresh: vi.fn(),
    savePrefs: vi.fn(),
    repoTargets: vi.fn(),
    skills: vi.fn(),
    accounts: vi.fn(),
    mcp: vi.fn(),
    navigateSpy: vi.fn(),
  }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state, issues, issuesRefresh, savePrefs, repoTargets, skills, accounts, mcp },
  };
});

// The desk writes its state into the URL through `navigate`; the spy is how a
// test reads what a press asked for, while the route itself is the test's.
vi.mock('@/app/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/router')>();
  return { ...actual, navigate: navigateSpy };
});

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  allowAgent: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  defaultSkills: [],
  unread: 0,
  prefs: { issueRepos: ['octo/outside'] },
} as unknown as ConsoleState;

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    labels: [],
    assignees: [],
    updatedAt: '2026-10-01T12:00:00Z',
    url: `https://github.com/acme/one/issues/${number}`,
    ...over,
  };
}

/** Rows the way the server sends them since phase 118: each with its triage. */
const ISSUES: Issue[] = [
  issue(203, {
    title: 'a repo tag at zero width',
    labels: ['bug', 'plan:control-tower', 'severity:low'],
    author: 'zsarir',
    updatedAt: '2026-10-03T16:47:30Z',
    triage: {
      category: 'bug',
      severity: 'low',
      plan: { state: 'planned', slug: 'control-tower', phases: [118] },
    },
  }),
  issue(219, {
    title: 'a false alarm',
    labels: ['bug', 'awaiting-plan', 'severity:high'],
    author: 'console',
    updatedAt: '2026-10-05T01:00:00Z',
    triage: { category: 'bug', severity: 'high', plan: { state: 'needs-plan' } },
  }),
  issue(222, {
    title: 'hung test runs',
    labels: ['enhancement', 'awaiting-plan', 'severity:medium'],
    author: 'console',
    updatedAt: '2026-10-04T09:00:00Z',
    triage: { category: 'enhancement', severity: 'medium', plan: { state: 'needs-plan' } },
  }),
  issue(164, {
    title: 'set aside for later',
    labels: ['documentation', 'plan:control-tower-deferred'],
    author: 'zsarir',
    updatedAt: '2026-09-20T09:00:00Z',
    triage: {
      category: 'documentation',
      severity: 'none',
      plan: { state: 'deferred', slug: 'control-tower' },
    },
  }),
  issue(40, {
    title: 'fixed and closed',
    state: 'CLOSED',
    labels: ['bug', 'plan:control-tower', 'severity:critical'],
    author: 'zsarir',
    updatedAt: '2026-09-30T09:00:00Z',
    closedAt: '2026-09-30T09:00:00Z',
    triage: {
      category: 'bug',
      severity: 'critical',
      plan: { state: 'fixed', slug: 'control-tower', phases: [14] },
    },
  }),
  // From a server before 6.1: no triage, so the client derives it.
  issue(7, { title: 'nobody triaged me', labels: ['question'], updatedAt: '2026-08-01T09:00:00Z' }),
];

const ROOT: RepoIssues = {
  key: 'root',
  label: 'pe-hub',
  scopeToken: 'pe-hub',
  kind: 'root',
  nameWithOwner: 'acme/one',
  state: 'fresh',
  fetchedAt: 1_759_000_000_000,
  ageMs: 5_000,
  issues: ISSUES,
};

const OUTSIDE: RepoIssues = {
  key: 'github:octo/outside',
  label: 'octo/outside',
  scopeToken: '',
  kind: 'added',
  nameWithOwner: 'octo/outside',
  state: 'fresh',
  fetchedAt: 1_759_000_000_000,
  ageMs: 5_000,
  issues: [
    issue(1, {
      title: 'an issue from elsewhere',
      labels: ['question'],
      url: 'https://github.com/octo/outside/issues/1',
      triage: { category: 'question', severity: 'none', plan: { state: 'none' } },
    }),
  ],
};

const PAYLOAD: IssuesPayload = { at: 1_759_000_005_000, refreshing: false, repos: [ROOT, OUTSIDE] };

function routeOf(hash: string) {
  const [path, queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path!.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path: path!,
  };
}

function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={at}>
        <RepoPage route={routeOf(at)} />
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { ...view, go: (next: string) => view.rerender(tree(next)) };
}

/** The titles on screen, in the order the board draws them. */
function titlesInOrder(container: HTMLElement, titles: string[]): string[] {
  const text = container.textContent ?? '';
  return titles.filter((t) => text.includes(t)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  issues.mockResolvedValue(PAYLOAD);
  issuesRefresh.mockResolvedValue(PAYLOAD);
  savePrefs.mockResolvedValue({});
  repoTargets.mockResolvedValue({ targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] });
  skills.mockResolvedValue([]);
  accounts.mockResolvedValue({ accounts: [] });
  mcp.mockResolvedValue({ servers: [], available: true });
});

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

describe('the desk sorts', () => {
  const rows = (): IssueRow[] => boardRows(PAYLOAD, { ...DEFAULT_FILTER, state: 'all' });
  const numbers = (sorted: IssueRow[]) => sorted.map((row) => (row.kind === 'issue' ? row.issue.number : 0));

  it('by severity, worst first — and a second press reverses it', () => {
    expect(numbers(sortIssueRows(rows(), { id: 'severity', dir: 'descending' })).slice(0, 4)).toEqual([
      40, 219, 222, 203,
    ]);
    expect(numbers(sortIssueRows(rows(), { id: 'severity', dir: 'ascending' })).slice(-4)).toEqual([
      203, 222, 219, 40,
    ]);
  });

  it('by number, by title, by updated, by status, by category, by author', () => {
    expect(numbers(sortIssueRows(rows(), { id: 'number', dir: 'ascending' }))).toEqual([
      1, 7, 40, 164, 203, 219, 222,
    ]);
    expect(numbers(sortIssueRows(rows(), { id: 'updated', dir: 'descending' })).slice(0, 2)).toEqual([
      219, 222,
    ]);
    expect(numbers(sortIssueRows(rows(), { id: 'title', dir: 'ascending' })).slice(0, 2)).toEqual([219, 203]);
    // The plan journey, in its own order: needs a plan, planned, deferred, fixed, none.
    expect(numbers(sortIssueRows(rows(), { id: 'status', dir: 'ascending' })).slice(0, 4)).toEqual([
      219, 222, 203, 164,
    ]);
    expect(numbers(sortIssueRows(rows(), { id: 'category', dir: 'ascending' })).slice(0, 3)).toEqual([
      203, 219, 40,
    ]);
    // An issue with no author sorts after every named one, whichever the direction.
    const byAuthor = numbers(sortIssueRows(rows(), { id: 'author', dir: 'ascending' }));
    expect(byAuthor.slice(0, 2)).toEqual([219, 222]);
    expect(byAuthor.slice(-2)).toEqual([7, 1]);
  });

  it('keeps a repository row after the issues, whatever the sort', () => {
    const withRepoRow = boardRows(
      { ...PAYLOAD, repos: [{ ...ROOT, key: 'empty', issues: [] }, ROOT] },
      { ...DEFAULT_FILTER, state: 'all' },
    );
    const sorted = sortIssueRows(withRepoRow, { id: 'number', dir: 'ascending' });
    expect(sorted[sorted.length - 1]!.kind).toBe('repo');
  });

  it('reads the sort from the URL and marks the column', async () => {
    const { container } = mount('#/repo/issues?state=all&sort=severity');
    await screen.findByText('fixed and closed');
    expect(
      titlesInOrder(container, [
        'fixed and closed',
        'a false alarm',
        'hung test runs',
        'a repo tag at zero width',
      ]),
    ).toEqual(['fixed and closed', 'a false alarm', 'hung test runs', 'a repo tag at zero width']);
    const head = screen.getByRole('columnheader', { name: /severity/i });
    expect(head.getAttribute('aria-sort')).toBe('descending');
  });

  it('a press on the sorted column writes the reverse into the URL; a press elsewhere, that column', async () => {
    mount('#/repo/issues?state=all&sort=severity');
    await screen.findByText('fixed and closed');
    fireEvent.click(within(screen.getByRole('columnheader', { name: /severity/i })).getByRole('button'));
    expect(navigateSpy).toHaveBeenLastCalledWith('#/repo/issues?state=all&sort=severity&dir=asc');
    fireEvent.click(within(screen.getByRole('columnheader', { name: /^author/i })).getByRole('button'));
    expect(navigateSpy).toHaveBeenLastCalledWith('#/repo/issues?state=all&sort=author');
  });
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

describe('the desk filters', () => {
  it('by category, severity and plan state, read from the URL', async () => {
    mount('#/repo/issues?state=all&category=bug&severity=high&plan=needs-plan');
    expect(await screen.findByText('a false alarm')).toBeTruthy();
    for (const other of [
      'a repo tag at zero width',
      'hung test runs',
      'fixed and closed',
      'nobody triaged me',
    ]) {
      expect(screen.queryByText(other)).toBeNull();
    }
    expect(screen.getByLabelText('Category').textContent).toBe('Bug');
    expect(screen.getByLabelText('Severity').textContent).toBe('High');
    expect(screen.getByLabelText('Plan status').textContent).toBe('Needs a plan');
  });

  it('writes every filter and the sort into one URL, and leaves the defaults out', () => {
    expect(deskHref({ ...DEFAULT_FILTER }, undefined, { category: 'bug' })).toBe(
      '#/repo/issues?category=bug',
    );
    expect(
      deskHref({ state: 'all', severity: 'none', plan: 'fixed' }, { id: 'updated', dir: 'ascending' }, {}),
    ).toBe('#/repo/issues?state=all&severity=none&plan=fixed&sort=updated&dir=asc');
    // A column's own default direction is not written.
    expect(deskHref({ ...DEFAULT_FILTER }, { id: 'severity', dir: 'descending' }, {})).toBe(
      '#/repo/issues?sort=severity',
    );
  });

  it('a filter value the vocabulary lacks is no filter at all', async () => {
    mount('#/repo/issues?state=all&category=feature&severity=urgent&plan=someday');
    expect(await screen.findByText('a false alarm')).toBeTruthy();
    expect(screen.getByText('nobody triaged me')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Selection across a sorted, filtered list
 * ------------------------------------------------------------------ */

describe('the desk selects', () => {
  it('every issue shown, and the selection survives a sort and a narrower filter', async () => {
    const view = mount('#/repo/issues?state=all&category=bug&sort=severity');
    await screen.findByText('fixed and closed');
    fireEvent.click(screen.getByLabelText('Select every issue shown'));
    expect(screen.getByTestId('selection-count').textContent).toContain('3 selected');
    view.go('#/repo/issues?state=all&category=bug&severity=high&sort=number&dir=asc');
    await screen.findByText('a false alarm');
    expect(screen.getByTestId('selection-count').textContent).toContain('3 selected');
    expect((screen.getByLabelText(/^Select acme\/one#219/) as HTMLInputElement).checked).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The three readings, through the status family
 * ------------------------------------------------------------------ */

describe('the desk reads each issue', () => {
  it('draws category, severity and plan state as status badges, with the plan and phase', async () => {
    const { container } = mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('a repo tag at zero width');
    expect(container.querySelectorAll('[data-vocab="issue-category"]').length).toBeGreaterThanOrEqual(6);
    expect(container.querySelectorAll('[data-vocab="issue-severity"]').length).toBeGreaterThanOrEqual(6);
    const planned = [...container.querySelectorAll('[data-vocab="issue-plan"][data-status="planned"]')];
    expect(planned.length).toBe(1);
    expect(screen.getByText(/control-tower · phase 118/)).toBeTruthy();
    expect(screen.getByText(/control-tower · phase 14/)).toBeTruthy();
  });

  it('derives the reading itself when the server sent none — by the server’s own function', () => {
    const plain = ISSUES.find((i) => i.number === 7)!;
    expect(triageOfIssue(plain)).toEqual({ category: 'question', severity: 'none', plan: { state: 'none' } });
    expect(triageOfIssue(ISSUES[0]!)).toBe(ISSUES[0]!.triage);
  });

  it('shows the author', async () => {
    mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('a repo tag at zero width');
    expect(screen.getAllByText('zsarir').length).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    const { container } = mount('#/repo/issues?state=all');
    await screen.findByText('a repo tag at zero width');
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * The repository picker
 * ------------------------------------------------------------------ */

describe('the repository picker', () => {
  it('lists an added repository and marks it outside this console', async () => {
    mount('#/repo/issues?repo=github:octo/outside');
    expect(await screen.findByText('an issue from elsewhere')).toBeTruthy();
    expect(screen.queryByText('a false alarm')).toBeNull();
    expect(screen.getByLabelText('Repository').textContent).toContain('octo/outside');
    expect(screen.getByTestId('outside-repo').textContent).toMatch(/outside this console/i);
  });

  it('adds an owner/name to prefs and fetches it at once', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    fireEvent.change(screen.getByLabelText('Add a repository'), { target: { value: 'octo/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ issueRepos: ['octo/outside', 'octo/new'] }));
    await waitFor(() => expect(issuesRefresh).toHaveBeenCalledWith('github:octo/new'));
    expect(navigateSpy).toHaveBeenLastCalledWith('#/repo/issues?repo=github%3Aocto%2Fnew');
  });

  it('refuses a name that is not GitHub’s owner/name, and says what it wants', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    fireEvent.change(screen.getByLabelText('Add a repository'), {
      target: { value: 'https://github.com/octo/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByTestId('add-repo-error')).textContent).toMatch(/owner\/name/);
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('a name the desk already lists is a repository to go to, never one to add twice', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    fireEvent.change(screen.getByLabelText('Add a repository'), { target: { value: 'ACME/one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(navigateSpy).toHaveBeenLastCalledWith('#/repo/issues?repo=root');
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('removes an added repository from prefs', async () => {
    mount('#/repo/issues?repo=github:octo/outside');
    await screen.findByText('an issue from elsewhere');
    fireEvent.click(screen.getByRole('button', { name: /remove octo\/outside/i }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ issueRepos: [] }));
  });
});

/* ------------------------------------------------------------------ *
 * One move from anywhere
 * ------------------------------------------------------------------ */

describe('the way in', () => {
  it('the palette opens the desk', () => {
    const gone: string[] = [];
    const actions = verbActions({
      state: STATE,
      route: routeOf('#/runs') as never,
      plans: [],
      runs: [],
      go: (path) => gone.push(path),
      setTheme: () => {},
      setDensity: () => {},
    });
    const entry = actions.find((action) => action.id === 'do:repo-issues');
    expect(entry?.label).toMatch(/issues desk/i);
    expect(entry!.keywords).toContain('severity');
    entry!.run({ go: (path: string) => gone.push(path) } as never);
    expect(gone).toEqual(['#/repo/issues']);
  });
});
