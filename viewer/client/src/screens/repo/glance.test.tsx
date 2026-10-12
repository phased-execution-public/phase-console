/**
 * Repo's glance, and the one property that made it worth shipping: **it never
 * claims more than it can source** (moved from `features/stubs.test.tsx` in
 * quiet-console phase 17, where the glance became the page's lead sentence).
 *
 * The cases are QA findings from 4.0's first round, pinned so they cannot
 * come back:
 *
 *  - `state.repo.dirty` is scoped to the DOCS directory by `server/git.ts`
 *    `repoInfo` — it is "uncommitted under `docs/`", never the working tree.
 *    The first draft of Repo called it "changed files" and told a clean story
 *    about a tree with forty modified files in it.
 *  - `repoInfo` leaves BOTH tracking counts `undefined` when the branch has no
 *    upstream. `?? 0` rendered that as "nothing to push / up to date", which is
 *    the opposite of true for every unpushed lane branch.
 *  - a state with no `repo` block is a server that did not say, and a failed
 *    read is the server's own words — neither is a clean tree.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path; the git sections answer empty, so the page settles. */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { ConsoleState } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/ui/tooltip';
import RepoPlace from './index';

const BASE = {
  autopilot: true,
  root: { path: '/repo', ok: true },
  repo: { available: true, branch: 'main', dirty: [] },
} as unknown as ConsoleState;

const withRepo = (repo: ConsoleState['repo']) => ({ ...BASE, repo });

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RepoPlace route={{ segments: ['repo'], query: {}, path: 'repo' }} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  server.reads = {
    '/api/state': BASE,
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/repo/graph': { commits: [], tips: [], tipsTruncated: false, truncated: false },
  };
});

describe('Repo says which corner of the tree it is looking at', () => {
  it('names docs/ rather than calling it the working tree', async () => {
    server.reads['/api/state'] = withRepo({
      available: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirty: ['docs/plans/a.md'],
    });
    mount();
    // The words matter more than usual here: `repoInfo` scopes `git status` to
    // the docs dir, so any label that omits it is a false statement about the
    // rest of the tree.
    const glance = await screen.findByTestId('repo-glance');
    expect(glance.textContent).toBe('On main: nothing to push, up to date. 1 file uncommitted under docs/.');
    expect(screen.queryByText(/changed files/i)).toBeNull();
    // The paths themselves are one fold away, under the same words.
    const fold = screen.getByTestId('repo-docs-fold');
    expect(fold.textContent).toBe('Uncommitted under docs/(1)');
    expect(screen.queryByText('docs/plans/a.md')).toBeNull();
    fireEvent.click(fold);
    expect(await screen.findByText('docs/plans/a.md')).toBeTruthy();
  });

  it('says the same thing when the list is empty, instead of "the tree is clean"', async () => {
    server.reads['/api/state'] = withRepo({
      available: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirty: [],
    });
    mount();
    expect((await screen.findByTestId('repo-glance')).textContent).toMatch(
      /Nothing uncommitted under docs\/\.$/,
    );
    expect(screen.queryByText(/the tree is clean/i)).toBeNull();
    // Nothing to list, so no fold claiming a list.
    expect(screen.queryByTestId('repo-docs-fold')).toBeNull();
  });

  it('reports an untracked branch as untracked, never as pushed and current', async () => {
    // `ahead`/`behind` BOTH absent is exactly what `repoInfo` returns when
    // `git rev-list …@{upstream}` fails — i.e. no upstream at all.
    server.reads['/api/state'] = withRepo({ available: true, branch: 'pe/x', dirty: [] });
    mount();
    const glance = await screen.findByTestId('repo-glance');
    expect(glance.textContent).toContain('pe/x, which has no upstream: not tracked');
    expect(glance.textContent).not.toMatch(/nothing to push|up to date/i);
  });

  it('still counts a real ahead when the branch IS tracked', async () => {
    server.reads['/api/state'] = withRepo({
      available: true,
      branch: 'main',
      ahead: 2,
      behind: 0,
      dirty: [],
    });
    mount();
    const glance = await screen.findByTestId('repo-glance');
    expect(glance.textContent).toContain('2 commits not pushed, up to date.');
    expect(glance.textContent).not.toMatch(/no upstream/);
  });

  it('counts a branch that is behind as well as one that is ahead', async () => {
    server.reads['/api/state'] = withRepo({
      available: true,
      branch: 'main',
      ahead: 0,
      behind: 1,
      dirty: [],
    });
    mount();
    expect((await screen.findByTestId('repo-glance')).textContent).toContain(
      'nothing to push, 1 commit not pulled.',
    );
  });

  it('does not read a MISSING repo block as a clean tree', async () => {
    // An older server, or one that could not read the source, sends no `repo`
    // at all. Drawing "nothing uncommitted" over that is the same defect as
    // the docs-scope one: reassurance in place of an answer.
    server.reads['/api/state'] = withRepo(undefined);
    mount();
    expect(await screen.findByText(/did not report a repository/i)).toBeTruthy();
    expect(screen.queryByText(/nothing uncommitted/i)).toBeNull();
  });

  it('says a source that is not a git repository is not one, and offers another', async () => {
    server.reads['/api/state'] = withRepo({ available: false, dirty: [] } as unknown as ConsoleState['repo']);
    mount();
    expect(await screen.findByText(/This source is not a git repository/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open a different project' })).toBeTruthy();
    expect(screen.queryByText(/nothing uncommitted/i)).toBeNull();
  });

  it("shows the server's own words when the read fails", async () => {
    server.reads['/api/state'] = new Error('state read failed');
    mount();
    expect((await screen.findByTestId('repo-glance-error')).textContent).toBe('state read failed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // And does NOT draw a clean tree over a fact it does not have.
    expect(screen.queryByText(/nothing uncommitted/i)).toBeNull();
  });
});
