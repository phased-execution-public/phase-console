/**
 * The Issues desk — the facts the issue estate went to trouble to express,
 * pinned so a redraw cannot lose them (ported from 6.2's
 * `features/repo/issues.test.tsx` in quiet-console phase 18, with 7.0's
 * toolbar, grid, pick band and panel).
 *
 *  - **Three states are three sentences.** `fresh`, `stale` (with the age) and
 *    `unknown` (with the reason) each read differently, and a repository that
 *    could not be asked is a ROW rather than a blank space.
 *  - **`never-fetched` is not a fault.** Nobody has pressed Refresh; the idle
 *    sweep never discovers. Since 7.0 a reason is words, never a badge, and the
 *    words say so.
 *  - **A body absent is not a body empty.** One is "not cached yet", the other
 *    an issue somebody filed with no text in it.
 *  - **Nothing renders somebody else's markup.** A title, a label and a body
 *    are a stranger's text on a page that also holds a door which starts an
 *    agent with repository write access.
 *  - **The address is the state.** Every filter and the inspected record
 *    survive a reload, because the alternative for "look at these three" is a
 *    screenshot.
 *  - **A pick that left is named, never sent.** A refresh can drop an issue and
 *    an added repository's issue can go on no ticket; both are said in the pick
 *    band and neither reaches the launch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged, a POST with its body. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
  posts: [] as { path: string; body: unknown }[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string, body?: unknown) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
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

/*
 * The launch form stands in as its contract with the doors that open it (the
 * plan launch, and in Pro the fix): a Launch that hands over a launch body while
 * nothing blocks it, and the reason when something does. The form's own fields
 * are `screens/launch`'s.
 */
vi.mock('@/screens/launch/door', () => ({
  LaunchDoor: () => null,
  LaunchForm: (props: {
    onLaunch?: (body: Record<string, unknown>) => void;
    blocked?: boolean;
    blockedReason?: string;
    cancel?: ReactNode;
  }) => (
    <div data-testid="launch-form">
      <button
        type="button"
        disabled={props.blocked}
        onClick={() => props.onLaunch?.({ model: 'claude-opus-5' })}
      >
        Launch
      </button>
      {props.blocked && <p data-testid="launch-form-blocked">{props.blockedReason}</p>}
      {props.cancel}
    </div>
  ),
}));

import type { Issue, IssuesPayload, RepoIssues } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { issuesPollInterval } from '@/data/repo';
import { clockTime } from '@/lib/format';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { closePanel } from '@/shell/panel/modes';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import RepoPlace from './index';
import {
  DEFAULT_FILTER,
  REASON_BLURB,
  SELECTION_MAX,
  ageLine,
  backedOff,
  boardRows,
  deskHref,
  filteredOut,
  issueRef,
  issueRowKey,
  labelUniverse,
  livingRefs,
  repoRowReason,
  repoStateWords,
  safeHttpUrl,
} from './issues';
import { REPO_SECTIONS, repoSectionHref, repoSectionOf } from './routes';

vi.setConfig({ testTimeout: 20_000 });

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowAgent: true,
  allowIssues: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  // Not a macOS home: the scrub refuses that shape in a committed file.
  home: '/home/x',
  repo: { available: true, branch: 'main', dirty: [] },
  prefs: { issueRepos: [] as string[] },
};

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
  issues: [
    issue(3, {
      title: 'stale but shown',
      labels: ['chore'],
      body: 'a body\nsecond line',
      url: 'https://github.com/acme/two/issues/3',
    }),
  ],
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

/** A repository the operator added by its GitHub name — read here, planned from its own checkout. */
const OUTSIDE: RepoIssues = {
  key: 'github:octo/outside',
  label: 'octo/outside',
  scopeToken: '',
  kind: 'added',
  nameWithOwner: 'octo/outside',
  state: 'fresh',
  fetchedAt: 1_757_000_000_000,
  ageMs: 5_000,
  issues: [issue(1, { title: 'an issue from elsewhere', url: 'https://github.com/octo/outside/issues/1' })],
};

const AT = 1_757_000_012_000;
const payload = (...repos: RepoIssues[]): IssuesPayload => ({ at: AT, refreshing: false, repos });
const PAYLOAD = payload(FRESH, STALE, UNKNOWN);

function routeOf(hash: string) {
  const [path = '', queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/**
 * Mount Repo at a hash, the panel's body beside it. `go(next)` re-renders at
 * another address on the SAME query client — what the router does with the
 * hash a press wrote.
 */
function mount(hash = '#/repo/issues') {
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

/* ---------------- the presses and the readings ---------------- */

const panel = () => screen.getByTestId('panel');
/** Radix tabs move on a primary mouse-down, never on a click. */
const openTab = (name: string) =>
  fireEvent.mouseDown(within(panel()).getByRole('tab', { name }), { button: 0 });
const refsShown = () => screen.queryAllByTestId('issue-row').map((row) => row.getAttribute('data-ref'));
function rowOf(ref: string): HTMLElement {
  const row = screen.getAllByTestId('issue-row').find((r) => r.getAttribute('data-ref') === ref);
  expect(row, `no issue row for ${ref}`).toBeTruthy();
  return row!;
}
const repoRowOf = (key: string) =>
  screen.getAllByTestId('issue-repo-row').find((r) => r.getAttribute('data-repo') === key);
const pickBox = (ref: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`^Pick ${ref.replace(/[/#]/g, '\\$&')}:`) });
const pick = (ref: string) => fireEvent.click(pickBox(ref));
const expandRow = (row: HTMLElement) =>
  fireEvent.click(within(row).getByRole('button', { name: /Show the rest of this row/ }));
const posted = (path: string) => server.posts.filter((p) => p.path === path).map((p) => p.body);

async function openFilter(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
  return screen.findByRole('dialog', { name: 'Filter' });
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  server.calls = [];
  server.posts = [];
  server.reads = {
    '/api/state': STATE,
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/issues': PAYLOAD,
    // A refresh answers with the payload as it now stands.
    '/api/issues/refresh': () => server.reads['/api/issues'],
    '/api/prefs': {},
    '/api/accounts': { accounts: [] },
    '/api/terminal': {
      ok: true,
      sessionId: 's1',
      token: 't',
      expiresAt: 0,
      path: '/x',
      session: { id: 's1' },
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  __resetInspectorForTests();
});

/* ------------------------------------------------------------------ *
 * The row model — pure, so it is checked as arithmetic
 * ------------------------------------------------------------------ */

describe('boardRows never turns a repository into a blank space', () => {
  it('gives an `unknown` repository a row of its own', () => {
    const rows = boardRows(PAYLOAD, { state: 'all' });
    expect(rows.filter((row) => row.kind === 'repo').map((row) => row.repo.key)).toEqual(['site']);
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
    const numbers = (state: 'open' | 'closed') =>
      boardRows(PAYLOAD, { state }).flatMap((row) => (row.kind === 'issue' ? [row.issue.number] : []));
    expect(DEFAULT_FILTER.state).toBe('open');
    expect(numbers('open')).toEqual([7, 3]);
    expect(numbers('closed')).toEqual([9]);
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
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.repo.key === 'sub')).toBe(true);
  });

  it('a repository with no GitHub name yields rows nothing can pick', () => {
    const orphan: RepoIssues = { ...UNKNOWN, reason: 'no-remote', issues: [issue(1)] };
    const rows = boardRows(payload(orphan), { state: 'all' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'issue' && rows[0]!.ref).toBe('');
    expect(issueRef(orphan, issue(1))).toBeUndefined();
    expect(issueRef(FRESH, issue(7))).toBe('acme/one#7');
  });

  it('row keys are stable and tell a repository row from an issue row', () => {
    const rows = boardRows(PAYLOAD, { state: 'all' });
    expect(new Set(rows.map(issueRowKey)).size).toBe(rows.length);
    expect(issueRowKey({ kind: 'repo', repo: UNKNOWN })).toBe('repo:site');
  });

  it('the label universe is every label once, sorted', () => {
    expect(labelUniverse(PAYLOAD)).toEqual(['bug', 'chore']);
  });

  it('what a ticket may name: the estate’s refs, and the added repositories’ apart', () => {
    const both = payload(FRESH, OUTSIDE);
    expect(livingRefs(both)).toEqual(['acme/one#7', 'acme/one#9']);
    expect(livingRefs(both, 'added')).toEqual(['octo/outside#1']);
  });
});

describe('a repository row says WHICH silence it is', () => {
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

  it('draws the filtered sentence in the actual row', async () => {
    server.reads['/api/issues'] = payload({
      ...UNKNOWN,
      issues: [issue(11, { title: 'a chore', labels: ['chore'] })],
    });
    mount('#/repo/issues?state=all&label=bug');
    const reason = await screen.findByTestId('repo-row-reason');
    expect(reason.textContent).toMatch(/none of them match the filters/i);
    expect(reason.textContent).not.toMatch(/not signed in/i);
  });
});

describe('a reason and an age are words', () => {
  it('never-fetched and no-remote are not failures, and say so in their words', () => {
    // 7.0 paints no badge for a reason: its words are what a person reads, so
    // the words are what must not call a button nobody pressed a fault.
    expect(repoStateWords({ ...UNKNOWN, reason: 'never-fetched' })).toBe('not asked yet');
    expect(repoStateWords({ ...UNKNOWN, reason: 'no-remote' })).toBe('no GitHub origin');
    expect(REASON_BLURB['never-fetched']).not.toMatch(/fail|error|refus/i);
    expect(REASON_BLURB['no-remote']).not.toMatch(/fail|error|refus/i);
    expect(REASON_BLURB['no-auth']).toMatch(/gh auth login/);
    expect(REASON_BLURB.failed).toMatch(/did not complete/i);
    // Six reasons, six sentences: none borrows another's.
    expect(new Set(Object.values(REASON_BLURB)).size).toBe(Object.keys(REASON_BLURB).length);
  });

  it('the age comes from the SERVER’s measurement, not this browser’s clock', () => {
    // `ageMs` was measured against the payload's own `at`; subtracting
    // `fetchedAt` from `Date.now()` measures the gap between two machines'
    // clocks as well as the age of the data. `fetchedAt` here is a year ago by
    // this browser's clock, and the server says twelve seconds.
    const skewed = { ...FRESH, fetchedAt: Date.now() - 365 * 86_400_000, ageMs: 12_000 };
    expect(ageLine(skewed)).toBe('fetched 12s ago');
    expect(ageLine({ ...UNKNOWN })).toBe('never fetched');
    // Only without the server's figure does this browser do the arithmetic.
    expect(ageLine({ ...FRESH, fetchedAt: Date.now() - 4 * 60_000, ageMs: undefined })).toBe(
      'fetched 4 minutes ago',
    );
  });

  it('a stale repository says stale with its age; an added one says it is outside this console', () => {
    expect(repoStateWords(STALE)).toBe('stale, fetched 1h 00m ago');
    expect(repoStateWords(FRESH)).toBe('fetched 12s ago');
    expect(repoStateWords(OUTSIDE)).toBe('outside this console, fetched 5s ago');
    expect(repoStateWords(UNKNOWN)).toBe('gh is not signed in');
  });
});

/* ------------------------------------------------------------------ *
 * The drawn desk
 * ------------------------------------------------------------------ */

describe('the desk draws the estate honestly', () => {
  it('shows all three repositories, the stale one with its age and the unknown one with its reason', async () => {
    mount();
    expect(await screen.findByText('the lock never releases')).toBeTruthy();
    // The `unknown` repository is a row, and the row says why.
    const row = repoRowOf('site')!;
    expect(within(row).getByTestId('repo-row-reason').textContent).toMatch(
      /gh is installed but not signed in/i,
    );
    expect(within(row).getByTestId('repo-row-detail').textContent).toContain('gh auth status');
    // The estate line counts what could not be asked rather than dropping it.
    const estate = screen.getByTestId('estate-line').textContent;
    expect(estate).toBe('3 repositories, 1 stale, 1 not answering.');
  });

  it('marks a stale repository stale on its own rows, and a fresh one with nothing but its age on hover', async () => {
    mount();
    await screen.findByText('stale but shown');
    expect(within(rowOf('acme/two#3')).getByTestId('repo-freshness').textContent).toBe(
      'stale, fetched 1h 00m ago',
    );
    // A fresh repository wears no marker: the word would be a claim about a
    // measurement rather than the measurement, and the age is in the title.
    const fresh = rowOf('acme/one#7');
    expect(within(fresh).queryByTestId('repo-freshness')).toBeNull();
    expect(within(fresh).getByTitle('fetched 12s ago')).toBeTruthy();
  });

  it('a closed issue is out of the default view, and back under “Open and closed”', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    expect(screen.queryByText('closed already')).toBeNull();
    expect(refsShown()).toEqual(['acme/one#7', 'acme/two#3']);
    view.go('#/repo/issues?state=all');
    expect(await screen.findByText('closed already')).toBeTruthy();
    expect(refsShown()).toEqual(['acme/one#7', 'acme/one#9', 'acme/two#3']);
  });

  it('a filter that matches nothing says the filters are why, and offers to clear them', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    view.go('#/repo/issues?repo=root&q=zzzz');
    expect(await screen.findByText('No issue matches the filters.')).toBeTruthy();
    // Counted against every issue the desk holds: the repository filter is one
    // of the filters that left none.
    expect(screen.getByTestId('issues-filtered').textContent).toBe('0 of 3 issues shown.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear the filters' })[0]!);
    expect(window.location.hash).toBe('#/repo/issues');
  });

  it('prints the payload’s instant as a wall clock, never as a subtraction', async () => {
    // `data.at` is the SERVER's instant; `Date.now() - data.at` is the clock
    // skew as well as the age — the arithmetic `ageLine` refuses. (L-4.)
    mount();
    const line = await screen.findByTestId('assembled-line');
    expect(line.textContent).toBe(`Assembled at ${clockTime(AT)}.`);
    expect(line.textContent).toMatch(/^Assembled at \d\d:\d\d:\d\d\.$/);
  });

  it('an issue URL that is not http(s) is shown in the row, never linked', async () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('not a url')).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl('https://github.com/a/b/issues/5')).toBe('https://github.com/a/b/issues/5');
    expect(safeHttpUrl('http://example.test/5')).toBe('http://example.test/5');
    server.reads['/api/issues'] = payload({ ...FRESH, issues: [issue(5, { url: 'javascript:alert(1)' })] });
    mount();
    await screen.findByText('issue 5');
    expandRow(rowOf('acme/one#5'));
    expect(screen.getByTestId('issue-url-refused').textContent).toContain('javascript:alert(1)');
    expect(screen.queryByRole('link', { name: /open on github/i })).toBeNull();
  });

  it('a row’s fold holds the first lines of the body and GitHub’s own page', async () => {
    mount('#/repo/issues?repo=sub');
    await screen.findByText('stale but shown');
    expandRow(rowOf('acme/two#3'));
    expect(screen.getByText('a body\nsecond line', { normalizer: (s) => s })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/two/issues/3',
    );
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await screen.findByText('the lock never releases');
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * Refresh — a visible act with a visible outcome, and three refusals
 * ------------------------------------------------------------------ */

describe('Refresh says what it will ask, and refuses what it could not do', () => {
  it('is scoped by the repository filter, and says which', async () => {
    const view = mount();
    await screen.findByText('the lock never releases');
    const every = screen.getByTestId('issues-refresh');
    expect(every.textContent).toBe('Refresh every repository');
    fireEvent.click(every);
    await waitFor(() => expect(posted('/api/issues/refresh')).toEqual([{}]));
    await waitFor(() =>
      expect(screen.getByTestId('issues-refresh').textContent).toBe('Refresh every repository'),
    );

    view.go('#/repo/issues?repo=sub');
    const one = await screen.findByRole('button', { name: 'Refresh phased-execution' });
    expect(one).toHaveAttribute('data-testid', 'issues-refresh');
    fireEvent.click(one);
    await waitFor(() => expect(posted('/api/issues/refresh')).toEqual([{}, { repo: 'sub' }]));
  });

  it('while a fetch is in flight it says so, and offers nothing that would be swallowed', async () => {
    server.reads['/api/issues'] = { ...PAYLOAD, refreshing: true } satisfies IssuesPayload;
    mount();
    await screen.findByText('the lock never releases');
    expect(screen.getByTestId('estate-line').textContent).toContain('asking GitHub now');
    const button = screen.getByTestId('issues-refresh');
    expect(button.textContent).toBe('Asking GitHub…');
    expect(button).toBeDisabled();
  });

  it('keeps asking while a fetch is in flight, and stops the moment it lands', () => {
    // Every Refresh control is disabled while `refreshing` is true, and nothing
    // else invalidates this key — no SSE event carries the issue cache. Without
    // a poll the desk could sit disabled with no path back but a reload.
    // (QA round 1, M-2.)
    expect(issuesPollInterval({ ...PAYLOAD, refreshing: true })).toBeGreaterThan(0);
    expect(issuesPollInterval(PAYLOAD)).toBe(false);
    expect(issuesPollInterval(undefined)).toBe(false);
  });

  it('the poll is WIRED, not merely defined', async () => {
    // QA round 2, Medium: round 1's fix was pinned by asserting the predicate
    // alone, so deleting the `refetchInterval:` line left the whole suite green
    // and the defect back. This asks the only question that matters — does the
    // desk actually ask again while a fetch is in flight?
    vi.useFakeTimers();
    const reads = () => server.calls.filter((path) => path === '/api/issues').length;
    server.reads['/api/issues'] = { ...PAYLOAD, refreshing: true } satisfies IssuesPayload;
    mount();
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
    const first = reads();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reads(), 'nothing re-asked while `refreshing` was true').toBeGreaterThan(first);
    // …and it stops the moment the payload settles.
    server.reads['/api/issues'] = PAYLOAD;
    await vi.advanceTimersByTimeAsync(6_000);
    const settled = reads();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reads(), 'it kept polling a settled payload').toBe(settled);
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
    expect(backedOff({ ...limited, retryAt: Date.now() - 1 })).toBe(false);
    server.reads['/api/issues'] = payload(limited);
    mount('#/repo/issues?repo=sub&state=all');
    const button = await screen.findByRole('button', { name: 'Refresh phased-execution' });
    expect(button).toBeDisabled();
    expect(button.title).toMatch(/rate-limiting/i);
    fireEvent.click(button);
    expect(posted('/api/issues/refresh')).toEqual([]);
  });

  it('names a `?repo=` that matches no repository instead of quietly asking for it — and keeps it in force', async () => {
    // QA round 1, M-3: the button read "Refresh all" and sent `'ghost'` (404),
    // and both selects rendered blank for a filter that was in force.
    mount('#/repo/issues?repo=ghost');
    const note = await screen.findByTestId('ghost-filter');
    expect(note.textContent).toContain('No repository here is called ghost.');
    expect(note.textContent).toContain('The filter still holds');
    const button = screen.getByTestId('issues-refresh');
    expect(button.textContent).toBe('Refresh');
    expect(button).toBeDisabled();
    expect(button.title).toMatch(/No repository here is called ghost/);
    fireEvent.click(button);
    expect(posted('/api/issues/refresh')).toEqual([]);
    // The control says what the filter is set to rather than looking unset.
    expect(screen.getByRole('button', { name: 'Filter, 1 in use' })).toBeTruthy();
    const filters = await openFilter();
    const which = within(filters).getByRole('radiogroup', { name: 'Which repository' });
    expect(within(which).getByRole('radio', { name: /^ghost/ })).toBeChecked();
    expect(within(which).getByRole('radio', { name: /^Every repository/ })).not.toBeChecked();
  });

  it('names a `?label=` nothing carries, for the same reason', async () => {
    mount('#/repo/issues?state=all&label=nonesuch');
    expect((await screen.findByTestId('ghost-filter')).textContent).toContain(
      'No issue carries the label nonesuch.',
    );
    const filters = await openFilter();
    const label = within(filters).getByLabelText('Label') as HTMLSelectElement;
    expect(label.value).toBe('nonesuch');
    expect(label.selectedOptions[0]!.textContent).toBe('nonesuch, which no issue carries');
  });

  it('the row-level Refresh honours the backoff too, not only the toolbar’s', async () => {
    // A repository whose FIRST fetch was rate-limited has no rows, so it is a
    // repository row — whose fold carries the per-repository acts.
    const limited: RepoIssues = {
      ...FRESH,
      state: 'unknown',
      reason: 'rate-limited',
      retryAt: Date.now() + 600_000,
      fetchedAt: undefined,
      ageMs: undefined,
      issues: [],
    };
    server.reads['/api/issues'] = payload(limited);
    mount('#/repo/issues?state=all');
    await screen.findByTestId('repo-row-reason');
    expandRow(repoRowOf('root')!);
    const row = screen.getByRole('button', { name: 'Refresh pe-hub' });
    expect(row).toBeDisabled();
    expect(screen.getByTestId('repo-backed-off').textContent).toMatch(/rate-limiting this token/);
    fireEvent.click(row);
    expect(posted('/api/issues/refresh')).toEqual([]);
  });

  it('a repository row’s own Refresh asks for that repository alone', async () => {
    server.reads['/api/issues'] = payload({ ...STALE, issues: [] });
    mount('#/repo/issues?state=all');
    await screen.findByTestId('repo-row-reason');
    expandRow(repoRowOf('sub')!);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh phased-execution' }));
    await waitFor(() => expect(posted('/api/issues/refresh')).toEqual([{ repo: 'sub' }]));
    // "New issue" is a LINK out, never a form this console posts.
    expect(screen.getByRole('link', { name: 'New issue on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/two/issues/new',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The record — in the shell's panel, its address naming it
 * ------------------------------------------------------------------ */

describe('an issue is a record in the panel, and its address opens it', () => {
  it('a row’s fold tells “no body cached” apart from “an empty body”', async () => {
    server.reads['/api/issues'] = payload({
      ...FRESH,
      issues: [issue(7, { title: 'never asked for' }), issue(8, { title: 'asked, and empty', body: '' })],
    });
    mount('#/repo/issues?repo=root');
    await screen.findByText('never asked for');
    // Issue 7 has no `body` key at all — that is "not asked for", not "empty".
    expandRow(rowOf('acme/one#7'));
    expect(screen.getByText(/No body cached yet/)).toBeTruthy();
    expandRow(rowOf('acme/one#8'));
    expect(screen.getByText('This issue has an empty body.')).toBeTruthy();
  });

  it('pressing the record’s link names it in the address, and the panel opens on it', async () => {
    const view = mount('#/repo/issues?state=all');
    await screen.findByText('stale but shown');
    const link = within(rowOf('acme/two#3')).getByRole('link', { name: '#3: stale but shown' });
    expect(link).toHaveAttribute('href', '#/repo/issues?state=all&issue=acme%2Ftwo%233');
    fireEvent.click(link);
    view.go(link.getAttribute('href')!);
    expect(await within(panel()).findByRole('heading', { name: 'stale but shown' })).toBeTruthy();
    // The row on show is marked.
    await waitFor(() => expect(rowOf('acme/two#3')).toHaveAttribute('aria-current', 'true'));
    expect(rowOf('acme/one#7')).not.toHaveAttribute('aria-current');
  });

  it('opens from the address, and renders the body as TEXT', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    const body = await within(panel()).findByTestId('issue-body');
    // A `<pre>`, not a markdown renderer: this string came from a stranger.
    expect(body.tagName).toBe('PRE');
    expect(body.textContent).toBe('a body\nsecond line');
  });

  it('a second press on the row the address already names opens the panel again', async () => {
    window.location.hash = '#/repo/issues?issue=acme%2Fone%237';
    mount('#/repo/issues?issue=acme%2Fone%237');
    await within(panel()).findByRole('heading', { name: 'the lock never releases' });
    act(() => closePanel());
    expect(getPrefs().panel.open).toBe(false);
    fireEvent.click(within(rowOf('acme/one#7')).getByRole('link'));
    expect(getPrefs().panel.open).toBe(true);
  });

  it('carries the server’s record verbatim, one tab down', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    await within(panel()).findByTestId('issue-body');
    openTab('Raw');
    const raw = await within(panel()).findByText(
      (_, node) => node?.tagName === 'PRE' && (node.textContent ?? '').includes('"number": 3'),
    );
    expect(raw.textContent).toContain('"title": "stale but shown"');
  });

  it('the panel refuses a non-http(s) URL too, not only the row', async () => {
    server.reads['/api/issues'] = payload({
      ...FRESH,
      issues: [issue(6, { url: 'javascript:alert(1)', body: 'x' })],
    });
    mount('#/repo/issues?state=all&issue=acme%2Fone%236');
    await within(panel()).findByTestId('issue-body');
    openTab('Actions');
    expect(within(panel()).getByTestId('inspector-url-refused').textContent).toContain('javascript:alert(1)');
    expect(within(panel()).queryByRole('link', { name: /javascript:|open on github/i })).toBeNull();
  });

  it('says when a body was cut at the server’s ceiling', async () => {
    server.reads['/api/issues'] = payload({
      ...FRESH,
      issues: [issue(6, { body: 'x', bodyTruncated: true })],
    });
    mount('#/repo/issues?state=all&issue=acme%2Fone%236');
    expect((await within(panel()).findByTestId('issue-body-truncated')).textContent).toMatch(/byte ceiling/i);
  });

  it('says a body not cached yet is not cached, in the panel as in the row', async () => {
    mount('#/repo/issues?issue=acme%2Fone%237');
    expect(await within(panel()).findByText(/No body cached yet/)).toBeTruthy();
    expect(within(panel()).queryByTestId('issue-body')).toBeNull();
  });

  it('“New issue” is a LINK out, and the panel says when a repository holds more than the desk reads', async () => {
    mount('#/repo/issues?state=all&issue=acme%2Ftwo%233');
    await within(panel()).findByTestId('issue-body');
    openTab('Actions');
    const link = within(panel()).getByRole('link', { name: /new issue on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/two/issues/new');
    expect(link.getAttribute('rel')).toContain('noopener');
    // Since control-tower phase 118 the desk reads a repository's whole list
    // up to the server's cap (2,000); past it the newest are shown, and said.
    expect(within(panel()).getByTestId('repo-truncated').textContent).toMatch(
      /more issues than the desk reads at once/i,
    );
  });

  it('renders a BODY containing markup as the literal text it is', async () => {
    // QA round 2, Medium: asserting `tagName === 'PRE'` plus `textContent` is
    // satisfied by a `<pre>` with `dangerouslySetInnerHTML`, so the assertion
    // that actually bites is the absence of the ELEMENT the markup would have
    // produced.
    const nasty = '# not a heading\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>';
    server.reads['/api/issues'] = payload({ ...FRESH, issues: [issue(4, { body: nasty })] });
    mount('#/repo/issues?state=all&issue=acme%2Fone%234');
    const body = await within(panel()).findByTestId('issue-body');
    expect(body.textContent).toBe(nasty);
    // The row's own preview is the same stranger's text.
    expandRow(rowOf('acme/one#4'));
    expect(document.body.querySelector('img'), 'the body was parsed as markup').toBeNull();
    expect(document.body.querySelector('script')).toBeNull();
    // …and no markdown renderer turned the first line into a heading.
    expect(body.querySelector('h1, h2, h3'), 'the body was rendered as markdown').toBeNull();
    expect(body.children.length).toBe(0);
  });

  it('renders a repository’s gh DETAIL as text, not markup', async () => {
    // The other string on this desk that came from a process's stderr.
    server.reads['/api/issues'] = payload({ ...UNKNOWN, detail: '<img src=x onerror=alert(3)> gh said no' });
    mount();
    const detail = await screen.findByTestId('repo-row-detail');
    expect(detail.textContent).toContain('<img src=x onerror=alert(3)>');
    expect(document.body.querySelector('img')).toBeNull();
  });

  it('renders a title containing markup as the literal text it is', async () => {
    server.reads['/api/issues'] = payload({
      ...FRESH,
      issues: [issue(4, { title: '<img src=x onerror=alert(1)>' })],
    });
    mount();
    expect((await screen.findAllByText('<img src=x onerror=alert(1)>')).length).toBeGreaterThan(0);
    expect(document.body.querySelector('img')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Picks, the band, the cap and the flag
 * ------------------------------------------------------------------ */

describe('a pick is what the launch is about', () => {
  it('picking a row arms the launch, and the count is on screen', async () => {
    mount();
    await screen.findByText('the lock never releases');
    // Nothing picked, no band: a strip of greyed doors is noise.
    expect(screen.queryByTestId('issue-selection')).toBeNull();
    pick('acme/one#7');
    expect(screen.getByRole('region', { name: 'Picked issues' })).toBeTruthy();
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    const launch = screen.getByTestId('launch-open');
    expect(launch.textContent).toBe('Author a plan from 1 issue');
    expect(launch).toBeEnabled();
    expect(screen.queryByTestId('launch-why')).toBeNull();
    // A second press takes the pick back.
    pick('acme/one#7');
    expect(screen.queryByTestId('issue-selection')).toBeNull();
  });

  it('“Pick every issue shown” takes exactly the rows the filter left', async () => {
    mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    fireEvent.click(screen.getByRole('button', { name: 'Pick every issue shown (2)' }));
    expect(screen.getByTestId('selection-count').textContent).toBe('2 picked');
    expect(pickBox('acme/one#9')).toBeChecked();
    // Every row shown is picked: the offer goes.
    expect(screen.queryByRole('button', { name: /Pick every issue shown/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the picks' }));
    expect(screen.queryByTestId('issue-selection')).toBeNull();
  });

  it('keeps the band while a pick lives, even when the filter leaves nothing', async () => {
    // QA round 1, L-5: the bar was gated on the selectable rows, so narrowing
    // the filter took the launch AND the clear away while the refs were still
    // going to the ticket.
    const view = mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    view.go('#/repo/issues?repo=root&state=all&q=zzzz');
    await screen.findByText('No issue matches the filters.');
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    expect(screen.getByRole('button', { name: 'Clear the picks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pick every issue shown/ })).toBeNull();
  });

  it('never sends a ref the payload no longer holds, and names it', async () => {
    // QA round 2, Low: a pick made before a refresh could name an issue the
    // console no longer has, and the server refuses the whole ticket. The
    // dropped one is NAMED, because nine picked and six sent is the quiet
    // narrowing the ticket door refuses to make.
    const after = payload(
      { ...FRESH, issues: [issue(9, { title: 'closed already', state: 'CLOSED' })] },
      STALE,
    );
    server.reads['/api/issues/refresh'] = () => {
      server.reads['/api/issues'] = after;
      return after;
    };
    mount('#/repo/issues?repo=root&state=all');
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pe-hub' }));
    const dropped = await screen.findByTestId('selection-dropped');
    expect(posted('/api/issues/refresh')).toEqual([{ repo: 'root' }]);
    expect(dropped.textContent).toBe(
      '1 picked issue no longer in this console’s issues, and not sent: acme/one#7.',
    );
    expect(screen.getByTestId('selection-count').textContent).toBe('0 picked');
    expect(screen.getByTestId('launch-open')).toBeDisabled();
    expect(screen.getByTestId('launch-why').textContent).toBe(
      'None of the picked issues can go on a ticket.',
    );
  });

  it('a pick from an added repository is named, and not counted toward the ticket', async () => {
    server.reads['/api/issues'] = payload(FRESH, OUTSIDE);
    mount('#/repo/issues');
    await screen.findByText('an issue from elsewhere');
    pick('octo/outside#1');
    expect(screen.getByTestId('selection-outside').textContent).toBe(
      '1 picked issue from a repository outside this console: a plan here cannot take it, so it is not sent.',
    );
    expect(screen.getByTestId('selection-count').textContent).toBe('0 picked');
    expect(screen.getByTestId('launch-open')).toBeDisabled();
    pick('acme/one#7');
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    expect(screen.getByTestId('launch-open').textContent).toBe('Author a plan from 1 issue');
    expect(screen.getByTestId('launch-open')).toBeEnabled();
  });

  it('names the missing flag rather than offering a door that cannot open', async () => {
    server.reads['/api/state'] = { ...STATE, allowAgent: false };
    mount();
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    expect(screen.getByTestId('launch-why').textContent).toContain('--allow-agent');
    expect(screen.getByTestId('launch-open')).toBeDisabled();
  });

  it('a shut door points at the words that say why, so a screen reader hears more than a grey', async () => {
    // The note carries its id for exactly this; the plan doors already point
    // at theirs (`plan-doors-why`), and 6.2's fix door pointed at its own.
    server.reads['/api/state'] = { ...STATE, allowAgent: false };
    mount();
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    const why = screen.getByTestId('launch-why');
    expect(why).toHaveAttribute('id', 'launch-why');
    expect(screen.getByTestId('launch-open')).toHaveAttribute('aria-describedby', 'launch-why');
  });

  it('the ticket ceiling is the launch’s problem, never the pick’s', async () => {
    // Twenty-one rows: every one stays pickable. Refusing the 21st pick would
    // leave a person guessing which of their twenty-one the console disliked,
    // and the cap is stated where it applies.
    const many = Array.from({ length: SELECTION_MAX + 1 }, (_, i) => issue(100 + i));
    server.reads['/api/issues'] = payload({ ...FRESH, issues: many });
    mount();
    await screen.findByText('issue 100');
    pick('acme/one#100');
    fireEvent.click(screen.getByRole('button', { name: `Pick every issue shown (${SELECTION_MAX + 1})` }));
    expect(screen.getByTestId('selection-count').textContent).toBe(`${SELECTION_MAX + 1} picked`);
    for (const box of screen.getAllByRole('checkbox', { name: /^Pick acme\/one#/ })) {
      expect(box).toBeEnabled();
      expect(box).toBeChecked();
    }
    expect(screen.getByTestId('launch-why').textContent).toBe(
      `A ticket carries at most ${SELECTION_MAX} issues, and ${SELECTION_MAX + 1} are picked.`,
    );
    expect(screen.getByTestId('launch-open')).toBeDisabled();
  });

  it('has no axe violations with the band standing', async () => {
    server.reads['/api/issues'] = payload(FRESH, OUTSIDE);
    const { container } = mount();
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    pick('octo/outside#1');
    await screen.findByTestId('selection-outside');
    await expectNoAxeViolations(container);
  });
});

describe('one press on the door, all the way to the ticket', () => {
  /** Write the brief and press the form's Launch, in the dialog the door opened. */
  async function launchFrom(dialogName: RegExp, brief: string) {
    const dialog = await screen.findByRole('dialog', { name: dialogName });
    const launch = within(dialog).getByRole('button', { name: 'Launch' });
    // The server answers `400 a plan session needs a brief.` on an empty one,
    // so the dialog may not offer the button until there is one, and says why
    // beside it. (QA round 1, High.)
    expect(launch).toBeDisabled();
    expect(within(dialog).getByTestId('launch-form-blocked').textContent).toMatch(/brief/i);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: brief } });
    expect(launch).toBeEnabled();
    fireEvent.click(launch);
    return dialog;
  }

  it('mints a plan ticket carrying the picked refs and the brief', async () => {
    mount('#/repo/issues?state=all&repo=root');
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    fireEvent.click(screen.getByTestId('launch-open'));
    const dialog = await launchFrom(/Author a plan from 1 issue/, 'close it');
    expect(within(dialog).getByText('acme/one#7')).toBeTruthy();
    await waitFor(() => expect(posted('/api/terminal')).toHaveLength(1));
    const body = posted('/api/terminal')[0] as Record<string, unknown>;
    expect(body.intent).toBe('plan');
    expect(body.issues).toEqual(['acme/one#7']);
    expect(body.brief).toBe('close it');
    // Refs, never text: the server composes the section from its own cache.
    expect(JSON.stringify(body)).not.toContain('the lock never releases');
    // The pane's first screen is sized for the window it is actually in.
    expect(typeof body.cols).toBe('number');
    expect(typeof body.rows).toBe('number');
    // …and the session it minted is where the desk goes.
    await waitFor(() => expect(window.location.hash).toBe('#/sessions/s1'));
  });

  it('sends the live picks alone: never one a refresh dropped, never one from an added repository', async () => {
    const before = payload(FRESH, STALE, OUTSIDE);
    const after = payload({ ...FRESH, issues: [] }, STALE, OUTSIDE);
    server.reads['/api/issues'] = before;
    server.reads['/api/issues/refresh'] = () => {
      server.reads['/api/issues'] = after;
      return after;
    };
    mount('#/repo/issues?state=all');
    await screen.findByText('the lock never releases');
    pick('acme/one#7');
    pick('acme/two#3');
    pick('octo/outside#1');
    expect(screen.getByTestId('selection-count').textContent).toBe('2 picked');
    fireEvent.click(screen.getByTestId('issues-refresh'));
    await screen.findByTestId('selection-dropped');
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    expect(screen.getByTestId('selection-outside')).toBeTruthy();
    fireEvent.click(screen.getByTestId('launch-open'));
    await launchFrom(/Author a plan from 1 issue/, 'close the stale one');
    await waitFor(() => expect(posted('/api/terminal')).toHaveLength(1));
    expect((posted('/api/terminal')[0] as Record<string, unknown>).issues).toEqual(['acme/two#3']);
  });
});

/* ------------------------------------------------------------------ *
 * The address, and the repository filter that is the desk's own
 * ------------------------------------------------------------------ */

describe('the address is the state', () => {
  it('`issues` is a section of Repo and resolves by name', () => {
    expect(REPO_SECTIONS.map((s) => s.id)).toContain('issues');
    expect(repoSectionOf('issues')).toBe('issues');
    // An unknown segment is still History — the rule this destination has
    // always followed, and one the desk must not have broken.
    expect(repoSectionOf('nope')).toBe('history');
  });

  it('a filtered desk is an address, and the default state is not written into it', () => {
    expect(deskHref(DEFAULT_FILTER, undefined, { repo: 'sub', label: 'bug' })).toBe(
      '#/repo/issues?repo=sub&label=bug',
    );
    expect(deskHref(DEFAULT_FILTER, undefined, {})).toBe('#/repo/issues');
    expect(deskHref({ state: 'all' }, undefined, { state: 'open' })).toBe('#/repo/issues');
    expect(repoSectionHref('issues')).toBe('#/repo/issues');
    // The inspected record belongs to the patch alone: a filter change drops it.
    expect(deskHref({ state: 'open', repo: 'sub' }, undefined, { issue: 'acme/two#3' })).toBe(
      '#/repo/issues?repo=sub&issue=acme%2Ftwo%233',
    );
  });

  it('the filters survive a reload, because they are read from the address', async () => {
    mount('#/repo/issues?repo=sub&state=all&label=chore');
    expect(await screen.findByText('stale but shown')).toBeTruthy();
    expect(screen.queryByText('the lock never releases')).toBeNull();
    // One repository picked, the Repository column goes: every row is that one.
    expect(screen.queryByRole('columnheader', { name: 'Repository' })).toBeNull();
  });

  it('the desk’s repository filter is the issue estate’s, not a git section’s target picker', async () => {
    // Two git targets; the estate is three repositories, one of which no git
    // section can be about.
    server.reads['/api/repo/targets'] = {
      targets: [
        { key: 'root', dir: '/repo', label: 'repo', kind: 'root' },
        { key: 'sub', dir: '/repo/sub', label: 'sub', kind: 'submodule' },
      ],
    };
    mount('#/repo/issues');
    await screen.findByText('the lock never releases');
    const filters = await openFilter();
    expect(within(filters).queryByTestId('repo-target')).toBeNull();
    const which = within(filters).getByTestId('issues-repo');
    expect(which).toHaveAttribute('aria-label', 'Which repository');
    // Every repository, and the estate's three — the one git cannot read included.
    expect(within(which).getAllByRole('radio')).toHaveLength(4);
    expect(within(which).getByRole('radio', { name: /^Every repository/ })).toBeChecked();
    expect(within(which).getByRole('radio', { name: /^phase-console-site/ })).toBeTruthy();
    // Each line says where its repository stands.
    expect(
      within(which).getByRole('radio', { name: /^phased-executionstale, fetched 1h 00m ago$/ }),
    ).toBeTruthy();
    fireEvent.click(within(which).getByRole('radio', { name: /^phased-execution/ }));
    expect(window.location.hash).toBe('#/repo/issues?repo=sub');
  });

  it('a label literally named “all” can still be picked', async () => {
    // QA round 2, Low: the "every label" sentinel WAS the string `all`, so a
    // real label of that name collided with it. The sentinel is the empty
    // value now, which no label can be.
    server.reads['/api/issues'] = payload({
      ...FRESH,
      issues: [issue(12, { title: 'labelled all', labels: ['all'] })],
    });
    mount('#/repo/issues?state=all&label=all');
    expect(await screen.findByText('labelled all')).toBeTruthy();
    expect(screen.queryByTestId('ghost-filter')).toBeNull();
    const filters = await openFilter();
    const label = within(filters).getByLabelText('Label') as HTMLSelectElement;
    expect(label.value, 'the sentinel and a real label share a value').toBe('all');
    expect(label.selectedOptions[0]!.textContent).toBe('all');
    expect([...label.options].map((o) => o.textContent)).toEqual(['Every label', 'all']);
  });

  it('a repository literally keyed “all” is a real filter, not the sentinel', async () => {
    server.reads['/api/issues'] = payload({ ...FRESH, key: 'all' }, STALE);
    mount('#/repo/issues?repo=all');
    await screen.findByText('the lock never releases');
    expect(screen.queryByText('stale but shown')).toBeNull();
    expect(screen.queryByTestId('ghost-filter')).toBeNull();
    const filters = await openFilter();
    const which = within(filters).getByRole('radiogroup', { name: 'Which repository' });
    expect(within(which).getByRole('radio', { name: /^pe-hub/ })).toBeChecked();
    expect(within(which).getByRole('radio', { name: /^Every repository/ })).not.toBeChecked();
  });
});

/* ------------------------------------------------------------------ *
 * Filed by sessions — the drafts engine's issues carry their provenance
 * (many-plans-one-repo phase 12)
 * ------------------------------------------------------------------ */

describe('filed by sessions', () => {
  const SESSION_ISSUE = issue(41, {
    title: 'phase-lock.sh drops the lease',
    labels: ['phase-console', 'from-session', 'demo'],
    provenance: { slug: 'demo', phase: 3, runId: 'r1', draftId: 'abcdefabcdef' },
  });
  const WITH = payload({ ...FRESH, issues: [...FRESH.issues, SESSION_ISSUE] }, STALE, UNKNOWN);

  it('keeps only the session-filed issues under filed=sessions, and no repository row at all', () => {
    const rows = boardRows(WITH, { state: 'all', filed: 'sessions' });
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.number : `repo:${r.repo.key}`))).toEqual([41]);
    // Without the filter every issue is a row, session-filed or not.
    expect(boardRows(WITH, { state: 'all' }).filter((r) => r.kind === 'issue')).toHaveLength(4);
  });

  it('the filter is an address, read from the route and written by its control', async () => {
    expect(deskHref(DEFAULT_FILTER, undefined, { filed: 'sessions' })).toBe('#/repo/issues?filed=sessions');
    server.reads['/api/issues'] = WITH;
    mount('#/repo/issues?state=all&filed=sessions');
    expect(await screen.findByText('phase-lock.sh drops the lease')).toBeTruthy();
    expect(screen.queryByText('the lock never releases')).toBeNull();
    const filters = await openFilter();
    const filed = within(filters).getByLabelText('Filed by') as HTMLSelectElement;
    expect(filed.value).toBe('sessions');
    expect(filed.selectedOptions[0]!.textContent).toBe('A session of this console');
    fireEvent.change(filed, { target: { value: '' } });
    expect(window.location.hash).toBe('#/repo/issues?state=all');
  });

  it('a session-filed issue says which phase filed it, and the panel links there; a person-filed one does not', async () => {
    server.reads['/api/issues'] = WITH;
    const view = mount('#/repo/issues?state=all');
    await screen.findByText('phase-lock.sh drops the lease');
    // Filed by is an Everything column: one press shows it on every row.
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    const cells = await screen.findAllByTestId('provenance');
    expect(cells).toHaveLength(1);
    expect(cells[0]!.textContent).toBe('demo P3');
    expect(cells[0]).toHaveAttribute('title', 'Filed by a session of demo, phase 3');
    expect(within(rowOf('acme/one#41')).getByTestId('provenance')).toBe(cells[0]);
    view.go('#/repo/issues?state=all&issue=acme%2Fone%2341');
    const link = await within(panel()).findByTestId('provenance-link');
    expect(link).toHaveAttribute('href', '#/plan/demo/phase/3');
    expect(link.textContent).toBe('A session of demo, phase 3');
  });

  it('with the filter on and nothing filed by a session, the empty state says so and names what allows it', async () => {
    mount('#/repo/issues?state=all&filed=sessions');
    expect(await screen.findByText(/no issue here was filed by a session/i)).toBeTruthy();
    expect(screen.getByText(/its plan’s Issues line, its run or this console allows it/)).toBeTruthy();
    // Under this filter a repository's silence answers nothing: no repository row.
    expect(screen.queryAllByTestId('issue-repo-row')).toHaveLength(0);
  });
});

