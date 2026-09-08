/**
 * The issues board below the shell breakpoint.
 *
 * Its own file because faking the phone means mocking `@/lib/media` for a whole
 * module — `matchMedia` answers are cached at module level, which is why
 * `components/ui/table-cards.test.tsx` and `app/shell/app-phone.test.tsx` each
 * exist beside a desktop suite rather than inside one.
 *
 * What it holds is one thing, and it is the thing this surface is FOR. Below
 * 900 px `DataTable` renders a `CardList`, and `CardList` DROPS every column
 * marked `card: 'hide'`. The pick column was marked that way, so a phone had
 * exactly one selection control — "select every issue shown" — and no way to
 * choose *these three*. The board still looked right in a screenshot; the verb
 * the phase exists for was gone. (QA round 1, High.)
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState, IssuesPayload } from '@/lib/api';
import RepoPage from './index';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  useWide: () => false,
  isPhone: () => true,
  reducedMotion: () => true,
  scrollBehavior: () => 'auto',
}));

const { state, repoTargets, repoGraph, repoBranches, repoCheckouts, repoDiff, repoSettles, issues } =
  vi.hoisted(() => ({
    state: vi.fn(),
    repoTargets: vi.fn(),
    repoGraph: vi.fn(),
    repoBranches: vi.fn(),
    repoCheckouts: vi.fn(),
    repoDiff: vi.fn(),
    repoSettles: vi.fn(),
    issues: vi.fn(),
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
    },
  };
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
        {
          number: 7,
          title: 'the lock never releases',
          state: 'OPEN',
          labels: [],
          assignees: [],
          updatedAt: '2026-09-01T12:00:00Z',
          url: 'https://github.com/acme/one/issues/7',
        },
        {
          number: 8,
          title: 'the other one',
          state: 'OPEN',
          labels: [],
          assignees: [],
          updatedAt: '2026-09-01T12:00:00Z',
          url: 'https://github.com/acme/one/issues/8',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({
    allowAgent: true,
    root: { path: '/repo', ok: true },
    repo: { available: true, branch: 'main', dirty: [] },
    defaultSkills: [],
  } as unknown as ConsoleState);
  repoTargets.mockResolvedValue({ targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] });
  repoGraph.mockResolvedValue({ commits: [], tips: [], tipsTruncated: false, truncated: false });
  repoBranches.mockResolvedValue({ branches: [], truncated: false, divergenceTruncated: false });
  repoCheckouts.mockResolvedValue({ checkouts: [], truncated: false });
  repoDiff.mockResolvedValue({ files: [], filesTruncated: false, fileCount: 0 });
  repoSettles.mockResolvedValue({ events: [], truncated: false, scanned: { runs: 25, entriesPerRun: 500 } });
  issues.mockResolvedValue(PAYLOAD);
});

function mount(hash = '#/repo/issues') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const [path, queryPart] = hash.replace(/^#\//, '').split('?');
  const route = {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash}>
        <RepoPage route={route} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('a phone can pick ONE issue', () => {
  it('every card carries its own checkbox, not just the select-all', async () => {
    mount();
    await screen.findByText('the lock never releases');
    const one = screen.getByRole('checkbox', { name: /select acme\/one#7/i });
    const two = screen.getByRole('checkbox', { name: /select acme\/one#8/i });
    expect(one).toBeTruthy();
    expect(two).toBeTruthy();

    fireEvent.click(one);
    expect(screen.getByTestId('selection-count').textContent).toContain('1 selected');
    // And ONE, not both — the point of a per-row control.
    expect((two as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: /author a plan from 1 issue/i })).toBeTruthy();
  });

  it('renders as cards, so this is genuinely the phone rendering', async () => {
    mount();
    await screen.findByText('the lock never releases');
    // `CardList` is a `<ul>`; the desktop branch is a `<table>`.
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('list', { name: /issues across every repository/i })).toBeTruthy();
  });
});
