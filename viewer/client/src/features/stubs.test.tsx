/**
 * Repo's docs-scoped glance, and the one property that made it worth shipping
 * as a stub: **it never claims more than it can source.**
 *
 * Debug's own cases lived here too until Phase 10 gave that destination four
 * fetching sections; they are in `features/debug/debug.test.tsx` now, where
 * the whole surface is mocked. Moved, not dropped — each is a QA finding.
 *
 * The cases below are QA findings from Phase 4's first round, pinned so they
 * cannot come back:
 *
 *  - `state.repo.dirty` is scoped to the DOCS directory by `server/git.ts`
 *    `repoInfo` — it is "uncommitted under `docs/`", never the working tree.
 *    The first draft of Repo called it "changed files" and told a clean story
 *    about a tree with forty modified files in it.
 *  - `repoInfo` leaves BOTH tracking counts `undefined` when the branch has no
 *    upstream. `?? 0` rendered that as "nothing to push / up to date", which is
 *    the opposite of true for every unpushed lane branch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState } from '@/lib/api';
import RepoPage from './repo/index';

const { state, repoGraph, repoTargets } = vi.hoisted(() => ({
  state: vi.fn(),
  repoGraph: vi.fn(),
  repoTargets: vi.fn(),
}));

/*
 * Phase 9 grew Repo from a one-card stub into five sections, and the first of
 * them fetches on mount. These stubs are still about the ONE card above them —
 * the docs-scoped glance — so the git surfaces are mocked to an empty answer
 * rather than left to reach a network that is not there. An unmocked fetcher
 * would not fail these assertions; it would make them slow and their console
 * output a lie about what the page did.
 */
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, repoGraph, repoTargets } };
});

const BASE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  // Both set, so "unknown" in a `dd` can only ever be the watcher — the fact
  // the third Debug case is actually about.
  platform: 'darwin',
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

const route = { segments: ['repo'], query: {}, path: 'repo' };

function mount(Page: typeof RepoPage) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/repo">
        <Page route={route} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(BASE);
  repoTargets.mockResolvedValue({ targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] });
  repoGraph.mockResolvedValue({
    commits: [],
    tips: [],
    tipsTruncated: false,
    truncated: false,
  });
});

describe('Repo says which corner of the tree it is looking at', () => {
  it('names docs/ rather than calling it the working tree', async () => {
    state.mockResolvedValue({ ...BASE, repo: { ...BASE.repo, dirty: ['docs/plans/a.md'] } });
    mount(RepoPage);
    // The words matter more than usual here: `repoInfo` scopes `git status` to
    // the docs dir, so any label that omits it is a false statement about the
    // rest of the tree.
    expect(await screen.findByText(/uncommitted under docs\//i)).toBeTruthy();
    expect(screen.queryByText(/^changed files$/i)).toBeNull();
  });

  it('says the same thing when the list is empty, instead of "the tree is clean"', async () => {
    mount(RepoPage);
    expect(await screen.findByText(/nothing uncommitted under docs\//i)).toBeTruthy();
    expect(screen.queryByText(/the tree is clean/i)).toBeNull();
  });

  it('reports an untracked branch as untracked, never as pushed and current', async () => {
    // `ahead`/`behind` BOTH absent is exactly what `repoInfo` returns when
    // `git rev-list …@{upstream}` fails — i.e. no upstream at all.
    state.mockResolvedValue({ ...BASE, repo: { available: true, branch: 'pe/x', dirty: [] } });
    mount(RepoPage);
    expect(await screen.findByText('no upstream')).toBeTruthy();
    expect(screen.getAllByText('not tracked')).toHaveLength(2);
    expect(screen.queryByText(/nothing to push|up to date/i)).toBeNull();
  });

  it('still counts a real ahead when the branch IS tracked', async () => {
    state.mockResolvedValue({
      ...BASE,
      repo: { available: true, branch: 'main', ahead: 2, behind: 0, dirty: [] },
    });
    mount(RepoPage);
    expect(await screen.findByText('commits not pushed')).toBeTruthy();
    expect(screen.getByText('up to date')).toBeTruthy();
    expect(screen.queryByText('no upstream')).toBeNull();
  });

  it('does not read a MISSING repo block as a clean tree', async () => {
    // An older server, or one that could not read the source, sends no `repo`
    // at all. Drawing "nothing uncommitted" over that is the same defect as
    // the docs-scope one: reassurance in place of an answer.
    state.mockResolvedValue({ ...BASE, repo: undefined });
    mount(RepoPage);
    expect(await screen.findByText(/did not report a repository/i)).toBeTruthy();
    expect(screen.queryByText(/nothing uncommitted/i)).toBeNull();
  });

  it("shows the server's own words when the read fails", async () => {
    state.mockRejectedValue(new Error('state read failed'));
    mount(RepoPage);
    expect(await screen.findByText(/state read failed/i)).toBeTruthy();
    // And does NOT draw a clean tree over a fact it does not have.
    expect(screen.queryByText(/nothing uncommitted/i)).toBeNull();
  });
});
