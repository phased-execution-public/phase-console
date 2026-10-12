/**
 * The Issues desk below the shell breakpoint (ported onto 7.0's desk in
 * quiet-console phase 18).
 *
 * Its own file because the phone is answered for a whole module: `usePhone` is
 * asked on every render by the grid, the toolbar and the doors, so it is mocked
 * here rather than toggled beside a desk suite.
 *
 * What it holds is the thing this surface is FOR. Below 900 px the grid draws
 * each row as a record, and a record keeps only the columns its card names —
 * the rest fold. 6.2's pick column was marked to drop on a card, so a phone had
 * exactly one pick control, "select every issue shown", and no way to choose
 * *these three*: the desk still looked right in a screenshot while the verb the
 * phase existed for was gone (QA round 1, High). Since 7.0 the pick is the
 * card's ONE action — on the card, never in its fold — and a press on it stays
 * in it: it neither follows the card's link nor opens the panel. Nothing else
 * escapes the card either: every column is on it or one press away in its
 * fold. (Whether a box escapes the viewport is measured in a real browser, by
 * the e2e tour's `escape` probe at 360 px; jsdom lays nothing out.)
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Below the shell breakpoint, for every member of this file.
const media = vi.hoisted(() => ({ phone: true }));
vi.mock('@/lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media')>()),
  usePhone: () => media.phone,
  useNarrow: () => media.phone,
  useTouch: () => media.phone,
  isPhone: () => media.phone,
}));

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { Issue, IssuesPayload } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests, useInspected } from '@/shell/panel/inspector-host';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import RepoPlace from './index';
import { DEFAULT_FILTER, issueColumns } from './issues';

vi.setConfig({ testTimeout: 20_000 });

const issue = (number: number, title: string, over: Partial<Issue> = {}): Issue => ({
  number,
  title,
  state: 'OPEN',
  labels: [],
  assignees: [],
  updatedAt: '2026-09-01T12:00:00Z',
  url: `https://github.com/acme/one/issues/${number}`,
  ...over,
});

const PAYLOAD: IssuesPayload = {
  at: 1_757_000_012_000,
  refreshing: false,
  repos: [
    {
      key: 'root',
      label: 'pe-hub',
      scopeToken: 'pe-hub',
      kind: 'root',
      nameWithOwner: 'acme/one',
      state: 'fresh',
      fetchedAt: 1_757_000_000_000,
      ageMs: 12_000,
      issues: [
        issue(7, 'the lock never releases', {
          labels: ['bug'],
          assignees: ['dev'],
          author: 'zsarir',
          triage: { category: 'bug', severity: 'high', plan: { state: 'needs-plan' } },
        }),
        issue(8, 'the other one'),
      ],
    },
    {
      key: 'site',
      label: 'phase-console-site',
      scopeToken: 'phase-console-site',
      kind: 'submodule',
      state: 'unknown',
      reason: 'no-auth',
      issues: [],
    },
  ],
};

function routeOf(hash: string) {
  const [path = '', queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/** What the panel shows, read where a test can see it. */
function Inspected() {
  return <p data-testid="inspected">{useInspected()?.key ?? 'nothing'}</p>;
}

function mount(hash = '#/repo/issues') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RepoPlace route={routeOf(hash)} />
        <aside data-testid="panel">
          <InspectorHost />
          <Inspected />
        </aside>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const card = (ref: string) =>
  screen.getAllByTestId('issue-row').find((row) => row.getAttribute('data-ref') === ref)!;
const pickBox = (ref: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`^Pick ${ref.replace(/[/#]/g, '\\$&')}:`) });

beforeEach(() => {
  media.phone = true;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  server.reads = {
    '/api/state': {
      allowAgent: true,
      root: { path: '/repo', ok: true },
      repo: { available: true, branch: 'main', dirty: [] },
      prefs: { issueRepos: [] },
    },
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/issues': PAYLOAD,
  };
});
afterEach(() => __resetInspectorForTests());

describe('a phone can pick ONE issue', () => {
  it('every card carries its own pick, not just a pick-all, and one press picks one', async () => {
    mount();
    await screen.findByText('the lock never releases');
    const one = pickBox('acme/one#7');
    const two = pickBox('acme/one#8');
    expect(within(card('acme/one#7')).getByRole('checkbox')).toBe(one);
    expect(within(card('acme/one#8')).getByRole('checkbox')).toBe(two);

    fireEvent.click(one);
    expect(screen.getByTestId('selection-count').textContent).toBe('1 picked');
    // And ONE, not both — the point of a per-card control.
    expect(one).toBeChecked();
    expect(two).not.toBeChecked();
    expect(screen.getByTestId('launch-open').textContent).toBe('Author a plan from 1 issue');
  });

  it('the pick is the card’s action: on the card, never in its fold, and a press on it goes nowhere else', async () => {
    mount();
    await screen.findByText('the lock never releases');
    const record = card('acme/one#7');
    // The fold is shut, and folds unmount: a pick that lived in it would not be here.
    const fold = within(record).getByRole('button', { name: /^Details/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    const box = within(record).getByRole('checkbox');
    expect(fold.contains(box)).toBe(false);

    // The whole card follows its link on a plain press — but not a press on its pick.
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(window.location.hash).toBe('');
    expect(screen.getByTestId('inspected').textContent).toBe('nothing');
    expect(getPrefs().panel.open).not.toBe(true);
  });

  it('a press on the card anywhere else follows the card’s own link to its record', async () => {
    mount();
    await screen.findByText('the lock never releases');
    const record = card('acme/one#7');
    const link = within(record).getByRole('link', { name: 'the lock never releases' });
    expect(link).toHaveAttribute('href', '#/repo/issues?issue=acme%2Fone%237');
    const follow = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      fireEvent.click(within(record).getByText('High'));
      expect(follow).toHaveBeenCalledTimes(1);
      expect(follow.mock.instances[0]).toBe(link);
      // …and the pick, pressed after, still does not.
      fireEvent.click(within(record).getByRole('checkbox'));
      expect(follow).toHaveBeenCalledTimes(1);
    } finally {
      follow.mockRestore();
    }
  });
});

describe('the phone rendering', () => {
  it('draws records, not a table — so this is genuinely the phone rendering', async () => {
    mount();
    await screen.findByText('the lock never releases');
    // The record list is a `<ul>`; the desk's table is a `<table>`.
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Issues' });
    expect(within(list).getAllByTestId('issue-row')).toHaveLength(2);
    // A repository that could not be asked is a record too, and says why.
    const repo = within(list).getByTestId('issue-repo-row');
    expect(repo).toHaveAttribute('data-repo', 'site');
    expect(within(repo).getByTestId('repo-row-reason').textContent).toMatch(/not signed in/);
  });

  it('no column escapes a card: each is on it, or one press away in its fold', async () => {
    mount();
    await screen.findByText('the lock never releases');
    const record = card('acme/one#7');
    // On the card: the number, the title (the record's link), how bad, where it
    // stands in a plan, when it last moved, and the pick.
    expect(within(record).getByText('#7')).toBeTruthy();
    expect(within(record).getByRole('link', { name: 'the lock never releases' })).toBeTruthy();
    expect(within(record).getByText('High')).toBeTruthy();
    expect(within(record).getByText('Needs a plan')).toBeTruthy();
    expect(within(record).getByRole('checkbox')).toBeTruthy();
    const onCard = ['Pick', 'Issue', 'Title', 'Severity', 'Plan status', 'Updated'];

    fireEvent.click(within(record).getByRole('button', { name: /^Details/ }));
    const heads = [...record.querySelectorAll('dt')].map((dt) => dt.textContent);
    const every = issueColumns({
      filter: DEFAULT_FILTER,
      sort: undefined,
      picked: new Set(),
      onPick: () => {},
    }).map((c) => c.head);
    // Everything not on the card is in its fold, and nothing is in neither.
    expect([...onCard, ...heads].sort()).toEqual([...every].sort());
    expect(within(record).getByText('zsarir')).toBeTruthy();
    expect(within(record).getByText('dev')).toBeTruthy();
  });

  it('keeps the search on the bar and puts the filters and the verbs in one View sheet', async () => {
    mount();
    await screen.findByText('the lock never releases');
    expect(screen.getByRole('searchbox', { name: /^Find an issue/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    expect(within(sheet).getByRole('radiogroup', { name: 'Which repository' })).toBeTruthy();
    expect(within(sheet).getByRole('radiogroup', { name: 'State' })).toBeTruthy();
    expect(within(sheet).getByRole('radiogroup', { name: 'Order the issues' })).toBeTruthy();
    expect(within(sheet).getByRole('combobox', { name: 'Severity' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Add a repository' })).toBeTruthy();
    expect(within(sheet).getByRole('switch', { name: 'Everything' })).toBeTruthy();
  });

  it('has no axe violations, a pick standing', async () => {
    const { container } = mount();
    await screen.findByText('the lock never releases');
    fireEvent.click(pickBox('acme/one#7'));
    await expectNoAxeViolations(container);
  });
});
