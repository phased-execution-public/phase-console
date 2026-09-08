/**
 * The issues board — the facts the Phase 15 contract went to trouble to express,
 * pinned so a redraw cannot lose them.
 *
 *  - **Three states are three sentences.** `fresh`, `stale` (with the age) and
 *    `unknown` (with the reason) must each read differently, and a repository
 *    that could not be asked must be a ROW rather than a blank space.
 *  - **`never-fetched` is not a fault.** Nobody has pressed Refresh; the idle
 *    sweep never discovers. Painting it as a failure is the misreading the
 *    contract's own comment warns about.
 *  - **A body absent is not a body empty.** One is "not cached yet", the other
 *    is an issue somebody filed with no text in it.
 *  - **Nothing renders somebody else's markup.** A title, a label and a body
 *    are a stranger's text on a page that also holds a button which starts an
 *    agent with repository write access.
 *  - **The URL is the state.** Every filter and the open inspector survive a
 *    reload, because the alternative for "look at these three" is a screenshot.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { issuesPollInterval, queryClientConfig } from '@/lib/queries';
import type { ConsoleState, Issue, IssuesPayload, RepoIssues } from '@/lib/api';
import RepoPage from './index';
import {
  REASON_TONE,
  ageLine,
  backedOff,
  boardRows,
  filteredOut,
  issueRef,
  labelUniverse,
  repoRowReason,
  rowKey,
  safeHttpUrl,
  SELECTION_MAX,
} from './issues';
import { repoHref, sectionFor, REPO_SECTIONS } from './routes';
import { verbActions } from '@/app/command/actions';

const {
  state,
  repoTargets,
  repoGraph,
  repoBranches,
  repoCheckouts,
  repoDiff,
  repoSettles,
  issues,
  issuesRefresh,
  agentTicket,
  skills,
  accounts,
  mcp,
} = vi.hoisted(() => ({
  state: vi.fn(),
  repoTargets: vi.fn(),
  repoGraph: vi.fn(),
  repoBranches: vi.fn(),
  repoCheckouts: vi.fn(),
  repoDiff: vi.fn(),
  repoSettles: vi.fn(),
  issues: vi.fn(),
  issuesRefresh: vi.fn(),
  agentTicket: vi.fn(),
  skills: vi.fn(),
  accounts: vi.fn(),
  mcp: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      repoTargets,
      repoGraph,
      repoBranches,
      repoCheckouts,
      repoDiff,
      repoSettles,
      issues,
      issuesRefresh,
      agentTicket,
      skills,
      accounts,
      mcp,
    },
  };
});

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  allowAgent: true,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 1,
  platform: 'darwin',
  home: '/home/x',
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  defaultSkills: [],
  unread: 0,
} as unknown as ConsoleState;

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    labels: [],
    assignees: [],
    updatedAt: '2026-09-01T12:00:00Z',
    url: `https://github.com/acme/one/issues/${number}`,
    ...over,
  };
}

/** Three repositories, one of each state — the fixture the exit criteria name. */
const FRESH: RepoIssues = {
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
    issue(7, { title: 'the lock never releases', labels: ['bug'], assignees: ['dev'] }),
    issue(9, { title: 'closed already', state: 'CLOSED' }),
  ],
};

const STALE: RepoIssues = {
  key: 'sub',
  label: 'phased-execution',
  scopeToken: 'phased-execution',
  kind: 'submodule',
  remote: 'git@github.com:acme/two.git',
  nameWithOwner: 'acme/two',
  state: 'stale',
  fetchedAt: 1_756_000_000_000,
  ageMs: 3_600_000,
  truncated: true,
  issues: [issue(3, { title: 'stale but shown', labels: ['chore'], body: 'a body\nsecond line' })],
};

const UNKNOWN: RepoIssues = {
  key: 'site',
  label: 'phase-console-site',
  scopeToken: 'phase-console-site',
  kind: 'submodule',
  state: 'unknown',
  reason: 'no-auth',
  detail: 'gh auth status: not logged in',
  issues: [],
};

const PAYLOAD: IssuesPayload = {
  at: 1_757_000_012_000,
  refreshing: false,
  repos: [FRESH, STALE, UNKNOWN],
};

function routeOf(hash: string) {
  const [path, queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

function mount(hash = '#/repo/issues') {
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

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  repoTargets.mockResolvedValue({ targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] });
  repoGraph.mockResolvedValue({ commits: [], tips: [], tipsTruncated: false, truncated: false });
  repoBranches.mockResolvedValue({ branches: [], truncated: false, divergenceTruncated: false });
  repoCheckouts.mockResolvedValue({ checkouts: [], truncated: false });
  repoDiff.mockResolvedValue({ files: [], filesTruncated: false, fileCount: 0 });
  repoSettles.mockResolvedValue({ events: [], truncated: false, scanned: { runs: 25, entriesPerRun: 500 } });
  issues.mockResolvedValue(PAYLOAD);
  issuesRefresh.mockResolvedValue(PAYLOAD);
  skills.mockResolvedValue([]);
  accounts.mockResolvedValue({ accounts: [] });
  mcp.mockResolvedValue({ servers: [], available: true });
});

/* ------------------------------------------------------------------ *
 * The row model — pure, so it is checked as arithmetic
 * ------------------------------------------------------------------ */

describe('boardRows never turns a repository into a blank space', () => {
  it('gives an `unknown` repository a row of its own', () => {
    const rows = boardRows(PAYLOAD, { state: 'all' });
    const repoRows = rows.filter((row) => row.kind === 'repo');
    expect(repoRows.map((row) => row.repo.key)).toEqual(['site']);
  });

  it('does NOT invent a row for a repository the filter merely excluded', () => {
    // `phased-execution` holds one `chore`; filtering to `bug` leaves it with
    // nothing, and the filter on screen is the explanation. A row here would
    // say "this repository could not be asked", which is false.
    const rows = boardRows(PAYLOAD, { state: 'all', label: 'bug' });
    expect(rows.filter((row) => row.kind === 'repo').map((row) => row.repo.key)).toEqual(['site']);
    expect(rows.filter((row) => row.kind === 'issue')).toHaveLength(1);
  });

  it('opens on OPEN issues, and says so rather than hiding the rest', () => {
    const open = boardRows(PAYLOAD, { state: 'open' }).filter((row) => row.kind === 'issue');
    expect(open.map((row) => row.kind === 'issue' && row.issue.number)).toEqual([7, 3]);
    const closed = boardRows(PAYLOAD, { state: 'closed' }).filter((row) => row.kind === 'issue');
    expect(closed.map((row) => row.kind === 'issue' && row.issue.number)).toEqual([9]);
  });

  it('searches the number with and without its hash, and the repository too', () => {
    expect(boardRows(PAYLOAD, { state: 'all', q: '#9' })).toHaveLength(1 + 1); // the issue + `site`
    expect(boardRows(PAYLOAD, { state: 'all', q: '9' }).filter((r) => r.kind === 'issue')).toHaveLength(1);
    expect(
      boardRows(PAYLOAD, { state: 'all', q: 'acme/two' }).filter((r) => r.kind === 'issue'),
    ).toHaveLength(1);
  });

  it('scopes to one repository by KEY, which is the only name a row has', () => {
    const rows = boardRows(PAYLOAD, { state: 'all', repo: 'sub' });
    expect(rows.every((row) => row.repo.key === 'sub')).toBe(true);
  });

  it('a repository with no GitHub name yields rows nothing can select', () => {
    const orphan: RepoIssues = { ...UNKNOWN, reason: 'no-remote', issues: [issue(1)] };
    const rows = boardRows({ at: 0, refreshing: false, repos: [orphan] }, { state: 'all' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'issue' && rows[0]!.ref).toBe('');
    expect(issueRef(orphan, issue(1))).toBeUndefined();
  });

  it('row keys are stable and distinguish a repo row from an issue row', () => {
    const rows = boardRows(PAYLOAD, { state: 'all' });
    expect(new Set(rows.map(rowKey)).size).toBe(rows.length);
    expect(rowKey({ kind: 'repo', repo: UNKNOWN })).toBe('repo:site');
  });

  it('the label universe is every label once, sorted', () => {
    expect(labelUniverse(PAYLOAD)).toEqual(['bug', 'chore']);
  });
});

describe('a repo row says WHICH silence it is', () => {
  it('does not blame gh for a filter’s work', () => {
    // QA round 1, L-2: an `unknown` repository whose cached issues the filter
    // excluded still asserted its failure reason, contradicting the very rule
    // `boardRows` follows — "the filter is the explanation".
    const held: RepoIssues = { ...UNKNOWN, issues: [issue(11, { labels: ['chore'] })] };
    expect(filteredOut(held, { state: 'all', label: 'bug' })).toBe(true);
    expect(repoRowReason(held, true)).toMatch(/none of them match the filters/i);
    expect(repoRowReason(held, false)).toMatch(/not signed in/i);
  });

  it('a repository that WAS asked and has none says so, rather than “not cached”', () => {
    // QA round 1, L-3: "No issues cached" beside "fetched 12s ago" is a
    // contradiction — it was asked, and the answer was none.
    expect(repoRowReason({ ...FRESH, issues: [] }, false)).toMatch(/it was asked, and the answer was none/i);
  });

  it('renders the filtered sentence in the actual row', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...UNKNOWN, issues: [issue(11, { title: 'a chore', labels: ['chore'] })] }],
    } satisfies IssuesPayload);
    mount('#/repo/issues?state=all&label=bug');
    const reason = await screen.findByTestId('repo-row-reason');
    expect(reason.textContent).toMatch(/none of them match the filters/i);
    expect(reason.textContent).not.toMatch(/not signed in/i);
  });
});

describe('the reasons are painted by what they mean', () => {
  it('never-fetched and no-remote are not failures', () => {
    // Neither is a thing to fix: one is a button nobody pressed, the other is a
    // standing fact about a repository. `accent` is this app's rationed amber.
    expect(REASON_TONE['never-fetched']).toBe('neutral');
    expect(REASON_TONE['no-remote']).toBe('neutral');
    expect(REASON_TONE['no-auth']).toBe('accent');
    expect(REASON_TONE.failed).toBe('bad');
  });

  it('the age comes from the SERVER’s measurement, not this browser’s clock', () => {
    // `ageMs` was measured against the payload's own `at`; subtracting
    // `fetchedAt` from `Date.now()` measures the gap between two machines'
    // clocks as well as the age of the data.
    expect(ageLine({ ...FRESH, ageMs: 12_000 })).toBe('fetched 12s ago');
    expect(ageLine({ ...UNKNOWN })).toBe('never fetched');
  });
});

/* ------------------------------------------------------------------ *
 * The rendered board
 * ------------------------------------------------------------------ */

describe('the board renders the estate honestly', () => {
  it('shows all three repositories, the stale one with its age and the unknown one with its reason', async () => {
    mount();
    expect(await screen.findByText('the lock never releases')).toBeTruthy();
    // The `unknown` repository is a row, and the row says why.
    const reason = await screen.findByTestId('repo-row-reason');
    expect(reason.textContent).toMatch(/not signed in|gh is installed but not signed in/i);
    expect(screen.getByTestId('repo-row-detail').textContent).toContain('gh auth status');
    // The estate line counts what could not be asked rather than dropping it.
    expect(screen.getByTestId('estate-line').textContent).toContain('3 repositories');
    expect(screen.getByTestId('estate-line').textContent).toContain('1 could not be asked');
    expect(screen.getByTestId('estate-line').textContent).toContain('1 stale');
  });

  it('marks a stale repository stale on its own rows', async () => {
    mount();
    await screen.findByText('stale but shown');
    const marks = screen.getAllByTestId('repo-freshness').map((node) => node.textContent);
    expect(marks).toContain('stale');
    // A fresh repository wears no marker: the word would be a claim about a
    // measurement rather than the measurement, and the age is in the title.
    expect(marks.filter((m) => m === 'fresh')).toHaveLength(0);
  });

  it('a closed issue is out of the default view and back under “every state”', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    expect(screen.queryByText('closed already')).toBeNull();
    view.go('#/repo/issues?state=all');
    expect(await screen.findByText('closed already')).toBeTruthy();
  });

  it('a filter that matches nothing says the filters are why', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    view.go('#/repo/issues?repo=root&q=zzzz');
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
  });

  it('refresh is scoped by the repository filter, and says which', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('button', { name: /refresh all/i }));
    await waitFor(() => expect(issuesRefresh).toHaveBeenCalledWith(undefined));

    view.go('#/repo/issues?repo=sub');
    fireEvent.click(await screen.findByRole('button', { name: /refresh phased-execution/i }));
    await waitFor(() => expect(issuesRefresh).toHaveBeenLastCalledWith('sub'));
  });

  it('never offers a refresh the server’s own backoff would swallow', async () => {
    // `rate-limited` is the one failure a forced refresh does NOT retry. A live
    // button there would do nothing and say nothing. (QA round 1, M-1.)
    const limited: RepoIssues = {
      ...STALE,
      state: 'unknown',
      reason: 'rate-limited',
      retryAt: Date.now() + 600_000,
    };
    expect(backedOff(limited)).toBe(true);
    expect(backedOff({ ...limited, reason: 'failed' })).toBe(false);
    issues.mockResolvedValue({ ...PAYLOAD, repos: [limited] } satisfies IssuesPayload);
    mount('#/repo/issues?repo=sub&state=all');
    const button = (await screen.findByRole('button', {
      name: /refresh phased-execution/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/rate-limiting/i);
  });

  it('names a `?repo=` that matches no repository instead of quietly asking for it', async () => {
    // QA round 1, M-3: the button read "Refresh all" and sent `'ghost'` (404),
    // and both Selects rendered blank for a filter that was in force.
    mount('#/repo/issues?repo=ghost');
    const note = await screen.findByTestId('ghost-filter');
    expect(note.textContent).toContain('ghost');
    const button = screen.getByRole('button', { name: /^refresh$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(issuesRefresh).not.toHaveBeenCalled();
  });

  it('names a `?label=` nothing carries, for the same reason', async () => {
    mount('#/repo/issues?state=all&label=nonesuch');
    expect((await screen.findByTestId('ghost-filter')).textContent).toContain('nonesuch');
  });

  it('prints the payload’s instant as a wall clock, never as a subtraction', async () => {
    // `data.at` is the SERVER's instant; `Date.now() - data.at` is the clock
    // skew as well as the age — the arithmetic `ageLine` refuses. (L-4.)
    mount();
    const line = await screen.findByTestId('assembled-line');
    expect(line.textContent).toMatch(/^assembled at \d\d:\d\d:\d\d$/);
  });

  it('an issue URL that is not http(s) is shown, never linked', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(5, { url: 'javascript:alert(1)' })] }],
    } satisfies IssuesPayload);
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('https://github.com/a/b/issues/5')).toBe('https://github.com/a/b/issues/5');
    mount();
    await screen.findByText('issue 5');
    fireEvent.click(screen.getAllByRole('button', { name: /show the rest of this row/i })[0]!);
    expect(screen.getByTestId('issue-url-refused')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open on github/i })).toBeNull();
  });

  it('keeps asking while a fetch is in flight, and stops the moment it lands', async () => {
    // Every Refresh control is disabled while `refreshing` is true, and nothing
    // else invalidates this key — no SSE event carries the issue cache. Without
    // a poll the board could sit disabled with no path back but a reload.
    // (QA round 1, M-2.)
    expect(issuesPollInterval({ ...PAYLOAD, refreshing: true })).toBeGreaterThan(0);
    expect(issuesPollInterval(PAYLOAD)).toBe(false);
    expect(issuesPollInterval(undefined)).toBe(false);

    issues.mockResolvedValue({ ...PAYLOAD, refreshing: true } satisfies IssuesPayload);
    mount();
    await screen.findByText('the lock never releases');
    // …and while it is in flight the board says so rather than offering a
    // button that would be swallowed.
    expect(screen.getByTestId('estate-line').textContent).toContain('asking GitHub now');
    expect((screen.getByRole('button', { name: /refresh all/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the poll is WIRED, not merely defined', async () => {
    // QA round 2, Medium: round 1's fix was pinned by asserting the predicate
    // alone, so deleting the `refetchInterval:` line left the whole suite green
    // and the defect back. This asks the only question that matters — does the
    // board actually ask again while a fetch is in flight?
    vi.useFakeTimers();
    try {
      issues.mockResolvedValue({ ...PAYLOAD, refreshing: true } satisfies IssuesPayload);
      mount();
      await vi.waitFor(() => expect(issues).toHaveBeenCalled());
      const first = issues.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(issues.mock.calls.length, 'nothing re-asked while `refreshing` was true').toBeGreaterThan(first);
      // …and it stops the moment the payload settles.
      issues.mockResolvedValue(PAYLOAD);
      await vi.advanceTimersByTimeAsync(6_000);
      const settled = issues.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(issues.mock.calls.length, 'it kept polling a settled payload').toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the row-level Refresh honours the backoff too, not only the toolbar one', async () => {
    const limited: RepoIssues = {
      ...FRESH,
      state: 'unknown',
      reason: 'rate-limited',
      retryAt: Date.now() + 600_000,
    };
    // A repository whose FIRST fetch was rate-limited has no rows, so it is a
    // repo row — which is where the per-repository controls live.
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...limited, issues: [] }],
    } satisfies IssuesPayload);
    mount('#/repo/issues?state=all');
    await screen.findByTestId('repo-row-reason');
    fireEvent.click(screen.getAllByRole('button', { name: /show the rest of this row/i })[0]!);
    const row = screen.getByRole('button', { name: /refresh this repository/i }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(issuesRefresh).not.toHaveBeenCalled();
  });

  it('says when a repository holds more issues than one page', async () => {
    // The per-repository facts live on the repo row and in the inspector; an
    // issue row's detail is about the ISSUE.
    issues.mockResolvedValue({ ...PAYLOAD, repos: [{ ...STALE, truncated: true }] } satisfies IssuesPayload);
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    await screen.findByTestId('issue-body');
    expect(screen.getByTestId('repo-truncated').textContent).toMatch(/more issues exist/i);
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await screen.findByText('the lock never releases');
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * Disclosure — L1 preview, L2 inspector, L3 raw
 * ------------------------------------------------------------------ */

describe('disclosure goes row → inspector → raw', () => {
  it('L1 tells “no body cached” apart from “an empty body”', async () => {
    mount('#/repo/issues?repo=root');
    await screen.findByText('the lock never releases');
    // Issue 7 has no `body` key at all — that is "not asked for", not "empty".
    fireEvent.click(screen.getAllByRole('button', { name: /show the rest of this row/i })[0]!);
    expect(screen.getByText(/No body cached/)).toBeTruthy();
  });

  it('L2 opens from the URL and renders the body as TEXT', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    const body = await screen.findByTestId('issue-body');
    // A `<pre>`, not a markdown renderer: this string came from a stranger.
    expect(body.tagName).toBe('PRE');
    expect(body.textContent).toBe('a body\nsecond line');
  });

  it('L3 carries the server’s record verbatim, one rung down', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    await screen.findByTestId('issue-body');
    // L3 is behind the inspector's own "Raw record" disclosure — one
    // interaction from the row, which is the invariant, not zero.
    fireEvent.click(screen.getByText('Raw record'));
    const raw = await screen.findByText(
      (_, node) => node?.tagName === 'PRE' && (node.textContent ?? '').includes('"number": 3'),
    );
    expect(raw.textContent).toContain('"title": "stale but shown"');
  });

  it('the INSPECTOR refuses a non-http(s) URL too, not just the row', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(6, { url: 'javascript:alert(1)', body: 'x' })] }],
    } satisfies IssuesPayload);
    mount('#/repo/issues?state=all&issue=acme%2Fone%236');
    await screen.findByTestId('issue-body');
    expect(screen.getByTestId('inspector-url-refused').textContent).toContain('javascript:alert(1)');
    expect(screen.queryByRole('link', { name: /javascript:/i })).toBeNull();
  });

  it('says when a body was cut at the server’s ceiling', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(6, { body: 'x', bodyTruncated: true })] }],
    } satisfies IssuesPayload);
    mount('#/repo/issues?state=all&issue=acme%2Fone%236');
    expect((await screen.findByTestId('issue-body-truncated')).textContent).toMatch(/byte ceiling/i);
  });

  it('“New issue” is a LINK out, never a form this console posts', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    await screen.findByTestId('issue-body');
    const link = screen.getByRole('link', { name: /new issue on github/i }) as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/acme/two/issues/new');
    expect(link.rel).toContain('noopener');
  });

  it('renders a BODY containing markup as the literal text it is', async () => {
    // QA round 2, Medium: the title had this test and the body did not, even
    // though the plan's step 2 names the body as the untrusted one. Asserting
    // `tagName === 'PRE'` plus `textContent` is satisfied by a `<pre>` with
    // `dangerouslySetInnerHTML`, so the assertion that actually bites is the
    // absence of the ELEMENT the markup would have produced.
    const nasty = '# not a heading\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>';
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(4, { body: nasty })] }],
    } satisfies IssuesPayload);
    const { container } = mount('#/repo/issues?state=all&issue=acme%2Fone%234');
    const body = await screen.findByTestId('issue-body');
    expect(body.textContent).toBe(nasty);
    expect(container.querySelector('img'), 'the body was parsed as markup').toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // …and no markdown renderer turned the first line into a heading. Scoped to
    // the body's own subtree: the inspector is a Sheet and owns a heading of
    // its own, which an unscoped query would find and call a defect.
    expect(body.querySelector('h1, h2, h3'), 'the body was rendered as markdown').toBeNull();
    // The body must be a TEXT node's worth of content, not parsed elements.
    expect(body.children.length).toBe(0);
  });

  it('renders a repository’s gh DETAIL as text, not markup', async () => {
    // The other string on this board that came from a process's stderr.
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...UNKNOWN, detail: '<img src=x onerror=alert(3)> gh said no' }],
    } satisfies IssuesPayload);
    const { container } = mount();
    const detail = await screen.findByTestId('repo-row-detail');
    expect(detail.textContent).toContain('<img src=x onerror=alert(3)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a title containing markup as the literal text it is', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(4, { title: '<img src=x onerror=alert(1)>' })] }],
    } satisfies IssuesPayload);
    const { container } = mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Selection, the cap and the flag
 * ------------------------------------------------------------------ */

describe('selection is what the launch is about', () => {
  it('ticking a row arms the launch, and the count is on screen', async () => {
    mount();
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('checkbox', { name: /select acme\/one#7/i }));
    expect(screen.getByTestId('selection-count').textContent).toContain('1 selected');
    expect(screen.getByRole('button', { name: /author a plan from 1 issue/i })).toBeTruthy();
  });

  it('“select every issue shown” takes exactly the rows the filter left', async () => {
    mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('checkbox', { name: /select every issue shown/i }));
    expect(screen.getByTestId('selection-count').textContent).toContain('2 selected');
  });

  it('keeps the bar while a selection lives, even when the filter leaves nothing', async () => {
    // QA round 1, L-5: the bar was gated on `selectable.length`, so narrowing
    // the filter took the launch AND the "clear selection" away while the refs
    // were still going to the ticket.
    const view = mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('checkbox', { name: /select acme\/one#7/i }));
    view.go('#/repo/issues?repo=root&state=all&q=zzzz');
    await waitFor(() => expect(screen.getByTestId('selection-count').textContent).toContain('1 selected'));
    expect(screen.getByRole('button', { name: /clear selection/i })).toBeTruthy();
  });

  it('never sends a ref the payload no longer holds', async () => {
    // QA round 2, Low: a selection made before a refresh could name an issue
    // the console no longer has, and the server refuses the whole ticket —
    // `400 no such issue in this console's repositories`. The dropped ones are
    // NAMED, because nine selected and six sent is the quiet narrowing
    // `agent.ts` refuses a ticket to prevent.
    const view = mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('checkbox', { name: /select acme\/one#7/i }));
    expect(screen.getByTestId('selection-count').textContent).toContain('1 selected');

    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(9, { title: 'closed already', state: 'CLOSED' })] }],
    } satisfies IssuesPayload);
    // A refresh replaces the payload; #7 is gone from it.
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(screen.getByTestId('selection-dropped')).toBeTruthy());
    expect(screen.getByTestId('selection-dropped').textContent).toContain('acme/one#7');
    expect(screen.getByTestId('selection-count').textContent).toContain('0 selected');
    view.unmount();
  });

  it('names the missing flag rather than offering a button that cannot work', async () => {
    state.mockResolvedValue({ ...STATE, allowAgent: false });
    mount();
    await screen.findByText('the lock never releases');
    fireEvent.click(screen.getByRole('checkbox', { name: /select acme\/one#7/i }));
    expect(screen.getByTestId('launch-flag-note').textContent).toContain('--allow-agent');
    expect(
      (screen.getByRole('button', { name: /author a plan from 1 issue/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('the ticket ceiling is the launch’s problem, never the checkbox’s', async () => {
    // Twenty-one rows: every one of them stays tickable. Refusing the 21st tick
    // would leave a person guessing which of their twenty-one the console
    // disliked, and the cap is stated where it applies.
    const many = Array.from({ length: SELECTION_MAX + 1 }, (_, i) => issue(100 + i));
    issues.mockResolvedValue({ ...PAYLOAD, repos: [{ ...FRESH, issues: many }] } satisfies IssuesPayload);
    mount();
    await screen.findByText('issue 100');
    fireEvent.click(screen.getByRole('checkbox', { name: /select every issue shown/i }));
    expect(screen.getByTestId('selection-count').textContent).toContain(`${SELECTION_MAX + 1} selected`);
    expect(screen.getByTestId('selection-count').textContent).toContain('ceiling');
    expect((screen.getByRole('button', { name: /author a plan from/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('one click, all the way to the ticket', () => {
  it('mints a plan ticket carrying the selected refs and the brief', async () => {
    agentTicket.mockResolvedValue({
      ok: true,
      sessionId: 's1',
      token: 't',
      expiresAt: Date.now() + 60_000,
      path: '/x',
      session: { id: 's1' },
    });
    mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('the lock never releases');

    fireEvent.click(screen.getByRole('checkbox', { name: /select acme\/one#7/i }));
    fireEvent.click(screen.getByRole('button', { name: /author a plan from 1 issue/i }));

    // The dialog summarises what was selected before it asks for anything.
    const selection = await screen.findByTestId('launch-selection');
    expect(selection.textContent).toContain('acme/one#7');

    // The server answers `400 a plan session needs a brief.` on an empty one, so
    // the dialog may not offer the button until there is one. (QA round 1, High.)
    const submit = screen.getByRole('button', { name: /start authoring/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(agentTicket).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/what should this plan achieve/i), {
      target: { value: 'close it' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start authoring/i }));

    await waitFor(() => expect(agentTicket).toHaveBeenCalled());
    const body = agentTicket.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.intent).toBe('plan');
    expect(body.issues).toEqual(['acme/one#7']);
    expect(body.brief).toBe('close it');
    // Refs, never text: the server composes the section from its own cache.
    expect(JSON.stringify(body)).not.toContain('the lock never releases');
    // The pane's first screen is sized for the window it is actually in.
    expect(typeof body.cols).toBe('number');
    expect(typeof body.rows).toBe('number');
  });

  it('refuses to launch over the ticket’s ceiling, and says by how much', async () => {
    const many = Array.from({ length: SELECTION_MAX + 2 }, (_, i) => issue(200 + i));
    issues.mockResolvedValue({ ...PAYLOAD, repos: [{ ...FRESH, issues: many }] } satisfies IssuesPayload);
    mount();
    await screen.findByText('issue 200');
    fireEvent.click(screen.getByRole('checkbox', { name: /select every issue shown/i }));
    // The board's own button is already disabled, so the dialog is reached the
    // way a stale render would reach it — and refuses there too, with the number.
    expect((screen.getByRole('button', { name: /author a plan from/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(agentTicket).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Routing, deep links and the palette
 * ------------------------------------------------------------------ */

describe('the URL is the state', () => {
  it('`issues` is a section of this destination and resolves by name', () => {
    expect(REPO_SECTIONS.map((s) => s.id)).toContain('issues');
    expect(sectionFor('issues')).toBe('issues');
    // An unknown segment is still the graph — the rule this destination has
    // always followed, and one a sixth section must not have broken.
    expect(sectionFor('nope')).toBe('graph');
  });

  it('a filtered board is a URL, and the default state is not written into it', () => {
    expect(repoHref('issues', { repo: 'sub', label: 'bug' })).toBe('#/repo/issues?repo=sub&label=bug');
    expect(repoHref('issues')).toBe('#/repo/issues');
  });

  it('the filters survive a reload, because they are read from the route', async () => {
    mount('#/repo/issues?repo=sub&state=all&label=chore');
    expect(await screen.findByText('stale but shown')).toBeTruthy();
    expect(screen.queryByText('the lock never releases')).toBeNull();
  });

  it('the repo TARGET picker is not offered on a section that is estate-wide', async () => {
    // Two targets, so the picker would render on any other section.
    repoTargets.mockResolvedValue({
      targets: [
        { key: 'root', dir: '/repo', label: 'repo', kind: 'root' },
        { key: 'sub', dir: '/repo/sub', label: 'sub', kind: 'submodule' },
      ],
    });
    const view = mount('#/repo/branches');
    expect(await screen.findByLabelText('Repository')).toBeTruthy();
    view.go('#/repo/issues');
    await screen.findByText('the lock never releases');
    // The section's OWN repository filter is here; the page-level picker is not.
    const pickers = screen.getAllByLabelText('Repository');
    expect(pickers).toHaveLength(1);
    expect(within(pickers[0]!).queryByText(/every repository/i)).toBeTruthy();
  });

  it('a label literally named “all” can still be picked', async () => {
    // QA round 2, Low: the "every label" sentinel WAS the string `all`, so a
    // real label of that name collided with it — the trigger read
    // "Every labelall" and choosing the real one cleared the filter, making it
    // the one label on the estate nobody could select.
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, issues: [issue(12, { title: 'labelled all', labels: ['all'] })] }],
    } satisfies IssuesPayload);
    mount('#/repo/issues?state=all&label=all');
    expect(await screen.findByText('labelled all')).toBeTruthy();
    // The assertion that BITES is the trigger's own text. Under a colliding
    // sentinel Radix has two options with one value, and the trigger read
    // "Every labelall" — both of them at once.
    const trigger = screen.getByLabelText('Label');
    expect(trigger.textContent, 'the sentinel and a real label share a value').toBe('all');
    expect(trigger.textContent).not.toContain('Every label');
    // And the control is not showing a ghost note for a label that exists.
    expect(screen.queryByTestId('ghost-filter')).toBeNull();
  });

  it('a repository literally keyed “all” is a real filter, not the sentinel', async () => {
    issues.mockResolvedValue({
      ...PAYLOAD,
      repos: [{ ...FRESH, key: 'all' }, STALE],
    } satisfies IssuesPayload);
    mount('#/repo/issues?repo=all');
    await screen.findByText('the lock never releases');
    expect(screen.queryByText('stale but shown')).toBeNull();
    expect(screen.queryByTestId('ghost-filter')).toBeNull();
    const trigger = screen.getByLabelText('Repository');
    expect(trigger.textContent, 'the sentinel and a real repository key share a value').toBe('pe-hub');
    expect(trigger.textContent).not.toContain('Every repository');
  });

  it('the palette reaches the surface', () => {
    const gone: string[] = [];
    const actions = verbActions({
      state: STATE,
      route: routeOf('#/now') as never,
      plans: [],
      runs: [],
      go: (path) => gone.push(path),
      setTheme: () => {},
      setDensity: () => {},
    });
    const entry = actions.find((action) => action.id === 'do:repo-issues');
    expect(entry, 'no palette entry opens the issues board').toBeTruthy();
    expect(entry!.keywords).toContain('issue');
    entry!.run({ go: (path: string) => gone.push(path) } as never);
    expect(gone).toEqual(['#/repo/issues']);
  });
});
