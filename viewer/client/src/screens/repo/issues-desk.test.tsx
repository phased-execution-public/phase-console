/**
 * The Issues desk's readings, orders and filters (control-tower phase 118;
 * ported onto 7.0's desk in quiet-console phase 18): a repository's whole issue
 * list with its category, severity, plan status and labels.
 *
 *   readings  the three are drawn as a dot and a word through the status
 *             family, with the plan and its phases beside the plan status; an
 *             issue from a server that sent none is read here by the same
 *             function the server uses.
 *   orders    every column the desk orders by sorts — stably, a repository row
 *             always last — from and into the address, from a column's head or
 *             the toolbar's Sort panel; a pick survives a sort and a filter.
 *   filters   category, severity and plan status join the others in the
 *             address; a word outside its vocabulary is no filter; the toolbar's
 *             Filter panel writes each one.
 *   added     the repository filter lists the estate and every repository the
 *             operator added; an added one reads "outside this console", and the
 *             ⋯ menu's Add and Remove write `prefs.issueRepos`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every POST is logged with its body. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  posts: [] as { path: string; body: unknown }[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string, body?: unknown) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string, body?: unknown) => unknown)(path, body);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return {
    ...actual,
    request: (path: string) => answer(path),
    post: (path: string, body?: unknown) => {
      server.posts.push({ path, body });
      return answer(path, body);
    },
  };
});

import { ISSUE_REPOS_MAX } from '@shared/issues-model.js';
import type { ConsoleState, Issue, IssuesPayload, RepoIssues } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { verbActions } from '@/shell/palette/actions';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import RepoPlace from './index';
import {
  DEFAULT_FILTER,
  boardRows,
  deskHref,
  filterFrom,
  filtersInForce,
  nextSort,
  planWhere,
  sortFrom,
  sortIssueRows,
  triageOfIssue,
  type IssueRow,
} from './issues';

vi.setConfig({ testTimeout: 20_000 });

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  allowAgent: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  home: '/home/x',
  repo: { available: true, branch: 'main', dirty: [] },
  prefs: { issueRepos: ['octo/outside'] },
};

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
  const [path = '', queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/** Repo at a hash, the panel beside it; `go` is the router's re-render on the same client. */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RepoPlace route={routeOf(at)} />
        <aside data-testid="panel">
          <InspectorHost />
        </aside>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { ...view, go: (next: string) => view.rerender(tree(next)) };
}

/** The refs of the issue rows, in the order the desk draws them. */
const refsShown = () => screen.queryAllByTestId('issue-row').map((row) => row.getAttribute('data-ref'));
const pickBox = (ref: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`^Pick ${ref.replace(/[/#]/g, '\\$&')}:`) });
const posted = (path: string) => server.posts.filter((p) => p.path === path).map((p) => p.body);
const headButton = (name: string) => within(screen.getByRole('columnheader', { name })).getByRole('button');

async function openSlot(word: 'Filter' | 'Sort'): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${word}`) }));
  return screen.findByRole('dialog', { name: word });
}
async function openMore(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}
async function openAddDialog(): Promise<HTMLElement> {
  fireEvent.click(within(await openMore()).getByRole('menuitem', { name: 'Add a repository' }));
  return screen.findByRole('dialog', { name: 'Add a repository' });
}
function addByName(dialog: HTMLElement, name: string) {
  fireEvent.change(within(dialog).getByLabelText('Repository'), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add the repository' }));
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  server.posts = [];
  server.reads = {
    '/api/state': STATE,
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/issues': PAYLOAD,
    '/api/issues/refresh': PAYLOAD,
    '/api/prefs': {},
  };
});
afterEach(() => __resetInspectorForTests());

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
    expect(numbers(sortIssueRows(rows(), { id: 'author', dir: 'descending' })).slice(-2)).toEqual([7, 1]);
  });

  it('is stable: ties keep the payload’s order, in both directions', () => {
    // Three issues read "no severity": 164, 7 and 1, in that order on the wire.
    expect(numbers(sortIssueRows(rows(), { id: 'severity', dir: 'descending' })).slice(-3)).toEqual([
      164, 7, 1,
    ]);
    expect(numbers(sortIssueRows(rows(), { id: 'severity', dir: 'ascending' })).slice(0, 3)).toEqual([
      164, 7, 1,
    ]);
    // No order at all is the payload's own, as a copy.
    const given = rows();
    const unsorted = sortIssueRows(given, undefined);
    expect(unsorted).toEqual(given);
    expect(unsorted).not.toBe(given);
  });

  it('keeps a repository row after the issues, whatever the sort', () => {
    const withRepoRow = boardRows(
      { ...PAYLOAD, repos: [{ ...ROOT, key: 'empty', issues: [] }, ROOT] },
      { ...DEFAULT_FILTER, state: 'all' },
    );
    expect(withRepoRow[0]!.kind).toBe('repo');
    for (const dir of ['ascending', 'descending'] as const) {
      const sorted = sortIssueRows(withRepoRow, { id: 'number', dir });
      expect(sorted[sorted.length - 1]!.kind).toBe('repo');
    }
  });

  it('reads an order from the address, and a press on a column reverses it or starts it', () => {
    expect(sortFrom({ sort: 'severity' })).toEqual({ id: 'severity', dir: 'descending' });
    expect(sortFrom({ sort: 'severity', dir: 'asc' })).toEqual({ id: 'severity', dir: 'ascending' });
    expect(sortFrom({ sort: 'title' })).toEqual({ id: 'title', dir: 'ascending' });
    // A word the vocabulary lacks is no order, not an order of nothing.
    expect(sortFrom({ sort: 'mood' })).toBeUndefined();
    expect(nextSort({ id: 'severity', dir: 'descending' }, 'severity')).toEqual({
      id: 'severity',
      dir: 'ascending',
    });
    expect(nextSort({ id: 'severity', dir: 'descending' }, 'number')).toEqual({
      id: 'number',
      dir: 'descending',
    });
    expect(nextSort(undefined, 'title')).toEqual({ id: 'title', dir: 'ascending' });
  });

  it('draws the order the address names, and marks the column', async () => {
    mount('#/repo/issues?state=all&sort=severity');
    await screen.findByText('fixed and closed');
    expect(refsShown()).toEqual([
      'acme/one#40',
      'acme/one#219',
      'acme/one#222',
      'acme/one#203',
      'acme/one#164',
      'acme/one#7',
      'octo/outside#1',
    ]);
    expect(screen.getByRole('columnheader', { name: 'Severity' })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: 'Updated' })).toHaveAttribute('aria-sort', 'none');
    // The toolbar's Sort says which order is in force.
    expect(screen.getByRole('button', { name: 'Sort, Severity' })).toBeTruthy();
  });

  it('a press on the sorted column writes the reverse into the address; a press elsewhere, that column', async () => {
    mount('#/repo/issues?state=all&sort=severity');
    await screen.findByText('fixed and closed');
    fireEvent.click(headButton('Severity'));
    expect(window.location.hash).toBe('#/repo/issues?state=all&sort=severity&dir=asc');
    fireEvent.click(headButton('Updated'));
    expect(window.location.hash).toBe('#/repo/issues?state=all&sort=updated');
    // Who opened an issue is an Everything column: drawn, its head orders too.
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    fireEvent.click(headButton('Opened by'));
    expect(window.location.hash).toBe('#/repo/issues?state=all&sort=author');
  });

  it('the Sort panel chooses an order and its direction, in words', async () => {
    const first = mount('#/repo/issues');
    await screen.findByText('a false alarm');
    let panel = await openSlot('Sort');
    const orders = within(panel).getByRole('radiogroup', { name: 'Order the issues' });
    expect(within(orders).getByRole('radio', { name: /^As GitHub lists them/ })).toBeChecked();
    // No order in force, no direction to choose.
    expect(within(panel).queryByRole('radiogroup', { name: 'Direction' })).toBeNull();
    fireEvent.click(within(orders).getByRole('radio', { name: 'Plan status' }));
    expect(window.location.hash).toBe('#/repo/issues?sort=status');
    first.unmount();

    mount('#/repo/issues?sort=status');
    await screen.findByText('a false alarm');
    panel = await openSlot('Sort');
    const direction = within(panel).getByRole('radiogroup', { name: 'Direction' });
    expect(within(direction).getByRole('radio', { name: 'Needs a plan first' })).toBeChecked();
    fireEvent.click(within(direction).getByRole('radio', { name: 'No plan first' }));
    expect(window.location.hash).toBe('#/repo/issues?sort=status&dir=desc');
    fireEvent.click(within(panel).getByRole('radio', { name: /^As GitHub lists them/ }));
    expect(window.location.hash).toBe('#/repo/issues');
  });
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

describe('the desk filters', () => {
  it('by category, severity and plan state, read from the address and said in the panel', async () => {
    mount('#/repo/issues?state=all&category=bug&severity=high&plan=needs-plan');
    expect(await screen.findByText('a false alarm')).toBeTruthy();
    expect(refsShown()).toEqual(['acme/one#219']);
    // Four settings away from their defaults: the state, and the three readings.
    expect(screen.getByRole('button', { name: 'Filter, 4 in use' })).toBeTruthy();
    const panel = await openSlot('Filter');
    const chosen = (label: string) => {
      const select = within(panel).getByLabelText(label) as HTMLSelectElement;
      return [select.value, select.selectedOptions[0]!.textContent];
    };
    expect(chosen('Category')).toEqual(['bug', 'Bug']);
    expect(chosen('Severity')).toEqual(['high', 'High']);
    expect(chosen('Plan status')).toEqual(['needs-plan', 'Needs a plan']);
    expect(within(panel).getByRole('radio', { name: 'Open and closed' })).toBeChecked();
  });

  it('writes every filter and the order into one address, and leaves the defaults out', () => {
    expect(deskHref({ ...DEFAULT_FILTER }, undefined, { category: 'bug' })).toBe(
      '#/repo/issues?category=bug',
    );
    expect(
      deskHref({ state: 'all', severity: 'none', plan: 'fixed' }, { id: 'updated', dir: 'ascending' }, {}),
    ).toBe('#/repo/issues?state=all&severity=none&plan=fixed&sort=updated&dir=asc');
    // A column's own first direction is not written.
    expect(deskHref({ ...DEFAULT_FILTER }, { id: 'severity', dir: 'descending' }, {})).toBe(
      '#/repo/issues?sort=severity',
    );
    // `sort: null` takes the order off.
    expect(deskHref({ ...DEFAULT_FILTER }, { id: 'severity', dir: 'descending' }, { sort: null })).toBe(
      '#/repo/issues',
    );
  });

  it('a filter value the vocabulary lacks is no filter at all', async () => {
    const query = { state: 'all', category: 'feature', severity: 'urgent', plan: 'someday', filed: 'robots' };
    expect(filterFrom(query)).toEqual({ state: 'all' });
    expect(filtersInForce(filterFrom(query))).toBe(1);
    expect(filterFrom({ state: 'bogus' }).state).toBe('open');
    mount('#/repo/issues?state=all&category=feature&severity=urgent&plan=someday');
    expect(await screen.findByText('a false alarm')).toBeTruthy();
    expect(screen.getByText('nobody triaged me')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter, 1 in use' })).toBeTruthy();
  });

  it('the panel’s selects write the address, an empty choice taking the filter off', async () => {
    mount('#/repo/issues?plan=needs-plan');
    await screen.findByText('a false alarm');
    const panel = await openSlot('Filter');
    fireEvent.change(within(panel).getByLabelText('Severity'), { target: { value: 'high' } });
    expect(window.location.hash).toBe('#/repo/issues?severity=high&plan=needs-plan');
    fireEvent.change(within(panel).getByLabelText('Category'), { target: { value: 'documentation' } });
    expect(window.location.hash).toBe('#/repo/issues?category=documentation&plan=needs-plan');
    fireEvent.change(within(panel).getByLabelText('Label'), { target: { value: 'question' } });
    expect(window.location.hash).toBe('#/repo/issues?label=question&plan=needs-plan');
    fireEvent.change(within(panel).getByLabelText('Plan status'), { target: { value: '' } });
    expect(window.location.hash).toBe('#/repo/issues');
    // Each select offers its whole vocabulary, in the words the status family paints it with.
    const severities = [...(within(panel).getByLabelText('Severity') as HTMLSelectElement).options];
    expect(severities.map((o) => o.textContent)).toEqual([
      'Every severity',
      'Critical',
      'High',
      'Medium',
      'Low',
      'No severity',
    ]);
  });

  it('the State and repository choices write the address', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    const panel = await openSlot('Filter');
    expect(within(panel).getByRole('radio', { name: 'Open' })).toBeChecked();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Closed' }));
    expect(window.location.hash).toBe('#/repo/issues?state=closed');
    const which = within(panel).getByRole('radiogroup', { name: 'Which repository' });
    fireEvent.click(within(which).getByRole('radio', { name: /^octo\/outside/ }));
    expect(window.location.hash).toBe('#/repo/issues?repo=github%3Aocto%2Foutside');
  });

  it('the search narrows as it is typed, and reaches the address once typing stops', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    const search = screen.getByRole('searchbox', { name: /^Find an issue/ });
    fireEvent.change(search, { target: { value: 'alarm' } });
    // At once: the rows do not wait for the address.
    expect(refsShown()).toEqual(['acme/one#219']);
    expect(screen.getByTestId('issues-filtered').textContent).toBe('1 of 7 issues shown.');
    // A moment later, replacing rather than pushing, so Back does not walk the half-typed words.
    await waitFor(() => expect(window.location.hash).toBe('#/repo/issues?q=alarm'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filters' }));
    expect(window.location.hash).toBe('#/repo/issues');
    expect((search as HTMLInputElement).value).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Picks across a sorted, filtered list
 * ------------------------------------------------------------------ */

describe('the desk picks', () => {
  it('every issue shown, and the picks survive a sort and a narrower filter', async () => {
    const view = mount('#/repo/issues?state=all&category=bug&sort=severity');
    await screen.findByText('fixed and closed');
    expect(refsShown()).toEqual(['acme/one#40', 'acme/one#219', 'acme/one#203']);
    fireEvent.click(pickBox('acme/one#219'));
    fireEvent.click(screen.getByRole('button', { name: 'Pick every issue shown (3)' }));
    expect(screen.getByTestId('selection-count').textContent).toBe('3 picked');
    view.go('#/repo/issues?state=all&category=bug&severity=high&sort=number&dir=asc');
    await waitFor(() => expect(refsShown()).toEqual(['acme/one#219']));
    expect(screen.getByTestId('selection-count').textContent).toBe('3 picked');
    expect(pickBox('acme/one#219')).toBeChecked();
  });
});

/* ------------------------------------------------------------------ *
 * The three readings, through the status family
 * ------------------------------------------------------------------ */

describe('the desk reads each issue', () => {
  it('draws category, severity and plan status as a dot and a word, with the plan and its phases', async () => {
    const { container } = mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('a repo tag at zero width');
    const of = (vocab: string) => [...container.querySelectorAll(`[data-vocab="${vocab}"]`)];
    // What kind waits in each row's fold until Everything stands it up as a column.
    expect(of('issue-category')).toHaveLength(0);
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    expect(of('issue-category')).toHaveLength(6);
    expect(of('issue-severity')).toHaveLength(6);
    expect(of('issue-plan')).toHaveLength(6);
    // Never colour alone: every reading draws its dot AND its word.
    for (const el of [...of('issue-category'), ...of('issue-severity'), ...of('issue-plan')]) {
      expect(el.querySelector('[data-dot]'), el.outerHTML.slice(0, 80)).toBeTruthy();
      expect((el.textContent ?? '').trim().length).toBeGreaterThan(2);
    }
    const word = (vocab: string, status: string) =>
      container.querySelector(`[data-vocab="${vocab}"][data-status="${status}"]`)?.textContent?.trim();
    expect(word('issue-severity', 'high')).toBe('High');
    expect(word('issue-plan', 'needs-plan')).toBe('Needs a plan');
    expect(word('issue-category', 'question')).toBe('Question');
    expect(container.querySelectorAll('[data-vocab="issue-plan"][data-status="planned"]')).toHaveLength(1);
    // Where the plan stands is said beside it: the plan, and its phases when it names them.
    expect(screen.getAllByTestId('plan-where').map((el) => el.textContent)).toEqual([
      'control-tower, phase 118',
      'control-tower',
      'control-tower, phase 14',
    ]);
  });

  it('derives the reading itself when the server sent none — by the server’s own function', () => {
    const plain = ISSUES.find((i) => i.number === 7)!;
    expect(triageOfIssue(plain)).toEqual({ category: 'question', severity: 'none', plan: { state: 'none' } });
    expect(triageOfIssue(ISSUES[0]!)).toBe(ISSUES[0]!.triage);
  });

  it('says where a plan stands in words: the plan, and the phase or phases it names', () => {
    const triage = (plan: { state: 'planned'; slug?: string; phases?: number[] }) =>
      ({ category: 'bug', severity: 'low', plan }) as const;
    expect(planWhere(triage({ state: 'planned', slug: 'control-tower', phases: [118, 119] }))).toBe(
      'control-tower, phases 118, 119',
    );
    expect(planWhere(triage({ state: 'planned', slug: 'control-tower', phases: [118] }))).toBe(
      'control-tower, phase 118',
    );
    expect(planWhere(triage({ state: 'planned', slug: 'control-tower' }))).toBe('control-tower');
    expect(planWhere(triage({ state: 'planned' }))).toBeUndefined();
  });

  it('shows who opened it and its labels, one press away', async () => {
    mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('a repo tag at zero width');
    expect(screen.queryByText('zsarir')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    expect((await screen.findAllByText('zsarir')).length).toBe(3);
    expect(screen.getByRole('columnheader', { name: 'Labels' })).toBeTruthy();
    expect(screen.getByText('bug, plan:control-tower, severity:low')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = mount('#/repo/issues?state=all');
    await screen.findByText('a repo tag at zero width');
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * The repositories added to the desk
 * ------------------------------------------------------------------ */

describe('the repositories added to the desk', () => {
  it('lists an added repository and marks it outside this console', async () => {
    mount('#/repo/issues?repo=github:octo/outside');
    expect(await screen.findByText('an issue from elsewhere')).toBeTruthy();
    expect(screen.queryByText('a false alarm')).toBeNull();
    expect(screen.getByTestId('outside-repo').textContent).toMatch(/octo\/outside is outside this console/);
    const panel = await openSlot('Filter');
    const which = within(panel).getByRole('radiogroup', { name: 'Which repository' });
    expect(
      within(which).getByRole('radio', { name: 'octo/outsideoutside this console, fetched 5s ago' }),
    ).toBeChecked();
  });

  it('adds an owner/name to prefs and asks GitHub for it at once', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    const dialog = await openAddDialog();
    // Nothing typed, nothing to add.
    expect(within(dialog).getByRole('button', { name: 'Add the repository' })).toBeDisabled();
    addByName(dialog, 'octo/new');
    await waitFor(() => expect(posted('/api/prefs')).toEqual([{ issueRepos: ['octo/outside', 'octo/new'] }]));
    await waitFor(() => expect(posted('/api/issues/refresh')).toEqual([{ repo: 'github:octo/new' }]));
    expect(window.location.hash).toBe('#/repo/issues?repo=github%3Aocto%2Fnew');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a repository' })).toBeNull());
  });

  it('refuses a name that is not GitHub’s owner/name, and says what it wants', async () => {
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    const dialog = await openAddDialog();
    addByName(dialog, 'https://github.com/octo/x');
    const error = await within(dialog).findByTestId('add-repo-error');
    expect(error.textContent).toMatch(/owner\/name, like octo\/widget/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(within(dialog).getByLabelText('Repository')).toHaveAttribute('aria-describedby', error.id);
    expect(posted('/api/prefs')).toEqual([]);
  });

  it('a name the desk already lists is a repository to go to, never one to add twice', async () => {
    server.reads['/api/state'] = { ...STATE, prefs: { issueRepos: ['octo/outside', 'octo/pending'] } };
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    addByName(await openAddDialog(), 'ACME/one');
    expect(window.location.hash).toBe('#/repo/issues?repo=root');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a repository' })).toBeNull());
    // Added already and not fetched yet: still a repository to go to.
    addByName(await openAddDialog(), 'octo/pending');
    expect(window.location.hash).toBe('#/repo/issues?repo=github%3Aocto%2Fpending');
    expect(posted('/api/prefs')).toEqual([]);
  });

  it('holds at most its ceiling of added repositories, and says so', async () => {
    const full = Array.from({ length: ISSUE_REPOS_MAX }, (_, i) => `octo/r${i}`);
    server.reads['/api/state'] = { ...STATE, prefs: { issueRepos: full } };
    mount('#/repo/issues');
    await screen.findByText('a false alarm');
    const dialog = await openAddDialog();
    addByName(dialog, 'octo/one-more');
    expect((await within(dialog).findByTestId('add-repo-error')).textContent).toBe(
      `The desk holds ${ISSUE_REPOS_MAX} added repositories: remove one to add another.`,
    );
    expect(posted('/api/prefs')).toEqual([]);
  });

  it('removes the added repository the filter names, from the ⋯ menu', async () => {
    mount('#/repo/issues?repo=github:octo/outside');
    await screen.findByText('an issue from elsewhere');
    fireEvent.click(
      within(await openMore()).getByRole('menuitem', { name: 'Remove octo/outside from the desk' }),
    );
    await waitFor(() => expect(posted('/api/prefs')).toEqual([{ issueRepos: [] }]));
    expect(window.location.hash).toBe('#/repo/issues');
  });

  it('offers no Remove for a repository of the estate', async () => {
    mount('#/repo/issues?repo=root');
    await screen.findByText('a false alarm');
    const menu = await openMore();
    expect(within(menu).getByRole('menuitem', { name: 'Add a repository' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: /^Remove/ })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * One move from anywhere
 * ------------------------------------------------------------------ */

describe('the way in', () => {
  it('the palette opens the desk', () => {
    const gone: string[] = [];
    const actions = verbActions({
      state: STATE as unknown as ConsoleState,
      route: routeOf('#/runs'),
      plans: [],
      runs: [],
      go: (path) => gone.push(path),
      setTheme: () => {},
      setDensity: () => {},
    });
    const entry = actions.find((action) => action.id === 'do:repo-issues');
    expect(entry, 'no palette entry opens the Issues desk').toBeTruthy();
    expect(entry!.label).toMatch(/issues desk/i);
    expect(entry!.keywords).toContain('issue');
    expect(entry!.keywords).toContain('severity');
    entry!.run({ go: (path: string) => gone.push(path) } as never);
    expect(gone).toEqual(['#/repo/issues']);
  });
});
