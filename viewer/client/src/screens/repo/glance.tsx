/**
 * The Repo glance — the situation under the title, in words (7.0, quiet-console
 * phase 17; 6.2's three tiles and an uncommitted list).
 *
 * `/api/state` answers `repo` from `repoInfo` (`server/git.ts`), and two of its
 * facts are easy to over-read, so the words never do:
 *
 * - its `git status` is scoped to the DOCS directory, so a count is always
 *   "under docs/", never "the tree" — the whole tree's answer is Changes;
 * - both tracking counts are absent when the branch has no upstream. That is
 *   not "nothing to push", it is not tracked at all, and every unpushed run
 *   branch would otherwise read as safely pushed.
 *
 * And a state with no `repo` block is a server that did not say, never a clean
 * tree: reassurance is not drawn over silence.
 */

import type { ReactNode } from 'react';
import type { ConsoleState } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { plural } from '@/lib/format';
import { sourceHref } from '@/shell/routes';
import { Button, Mono } from '@/ui';
import { Disclosure } from '@/ui/disclosure';

type RepoInfo = NonNullable<ConsoleState['repo']>;

/** Whether the branch has an upstream to count against — either count present. */
export const isTracked = (repo: RepoInfo): boolean => repo.ahead !== undefined || repo.behind !== undefined;

/** "2 commits not pushed, up to date" — said only of a tracked branch. */
function trackingWords(repo: RepoInfo): string {
  const ahead = repo.ahead ?? 0;
  const behind = repo.behind ?? 0;
  return [
    ahead ? `${plural(ahead, 'commit')} not pushed` : 'nothing to push',
    behind ? `${plural(behind, 'commit')} not pulled` : 'up to date',
  ].join(', ');
}

function docsWords(dirty: readonly string[]): string {
  return dirty.length
    ? `${plural(dirty.length, 'file')} uncommitted under docs/.`
    : 'Nothing uncommitted under docs/.';
}

/** The glance's sentence — the page's lead, so inline content only. */
export function RepoGlance() {
  const { data: state, isPending, error, refetch } = useConsoleState();

  if (isPending) return <>Reading the repository…</>;
  if (error) {
    const said =
      error instanceof Error && error.message ? error.message : 'The read failed and said nothing.';
    return (
      <>
        <span data-testid="repo-glance-error">{said}</span>{' '}
        <Button size="sm" variant="ghost" onClick={() => void refetch()}>
          Try again
        </Button>
      </>
    );
  }

  const repo = state?.repo;
  if (!repo) {
    return (
      <>
        This console did not report a repository: an older server, or one that could not read the source.
        Nothing here is a statement about the tree.
      </>
    );
  }
  if (repo.available === false) {
    return (
      <>
        This source is not a git repository.{' '}
        <a href={sourceHref()} className="tap-line whitespace-nowrap text-ink underline underline-offset-2">
          Open a different project
        </a>
      </>
    );
  }

  const dirty = repo.dirty ?? [];
  const branch: ReactNode = repo.branch ? (
    <>
      On <Mono value={repo.branch} className="text-body text-ink" />
    </>
  ) : (
    'With no branch named'
  );
  return (
    <span data-testid="repo-glance">
      {branch}
      {isTracked(repo)
        ? `: ${trackingWords(repo)}. `
        : ', which has no upstream: not tracked, so nothing here says whether it is pushed. '}
      {docsWords(dirty)}
    </span>
  );
}

/** The uncommitted paths under docs/, folded — drawn only when there are any. */
export function DocsFold() {
  const { data: state } = useConsoleState();
  const dirty = state?.repo?.available === false ? [] : (state?.repo?.dirty ?? []);
  if (!dirty.length) return null;
  return (
    <Disclosure label="Uncommitted under docs/" count={dirty.length} testId="repo-docs-fold">
      <ul className="flex min-w-0 flex-col gap-1">
        {dirty.map((path) => (
          <li key={path} className="min-w-0 truncate">
            <Mono value={path} title={path} />
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
