/**
 * The repository: the five git surfaces and the issue estate — the desk's
 * read, its refresh and the repositories added to it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/ui/toast';
import { api, type IssuesPayload, type RepoDiffParams, type RepoGraphParams } from './api';
import { keys } from './keys';

/* ------------------------------------------------------------------ *
 * Repo — the five git surfaces
 * ------------------------------------------------------------------ */

/**
 * A repository does not change because a run ticked, and it does change under a
 * console that is committing on your behalf. So these are polled on a slow
 * timer rather than tied to the socket: `staleTime` is the honest bound on how
 * old the answer on screen may be. A reader who knows something just landed
 * re-navigates or reloads; there is no Refresh control on this destination, and
 * a comment promising one is how a later phase comes looking for it.
 *
 * A commit graph read is the expensive one (a `git log` walk of up to 500
 * commits), so it is deliberately the slowest to go stale.
 */
const REPO_STALE = 30_000;

export function useRepoTargets(enabled = true) {
  return useQuery({ queryKey: keys.repoTargets(), queryFn: api.repoTargets, enabled, staleTime: REPO_STALE });
}

export function useRepoGraph(params: RepoGraphParams, enabled = true) {
  return useQuery({
    queryKey: keys.repoGraph(params),
    queryFn: () => api.repoGraph(params),
    enabled,
    staleTime: REPO_STALE,
  });
}

export function useRepoBranches(repo: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.repoBranches(repo),
    queryFn: () => api.repoBranches(repo),
    enabled,
    staleTime: REPO_STALE,
  });
}

export function useRepoCheckouts(enabled = true) {
  return useQuery({
    queryKey: keys.repoCheckouts(),
    queryFn: api.repoCheckouts,
    enabled,
    staleTime: REPO_STALE,
  });
}

/**
 * `placeholderData` holds the previous answer while the next one loads — **only
 * while the FILE LIST cannot have moved**, and the scoping is the whole of it.
 * (This lead said "only across a change of `path`" until QA round 4's F-3: true
 * when it was written, and contradicted fifteen lines below by the very commit
 * that widened it to `unified` and `bytes`.)
 *
 * The nicety it buys is real: picking a file adds `?path=`, which is a NEW key,
 * so without a placeholder the file list the reader just clicked in blanks to a
 * spinner and comes back, on every pick. The unscoped version cost far more
 * than that (QA round 2, M-1). `isPending` goes FALSE the moment a placeholder
 * exists, so the patch pane skipped its spinner and rendered the previous
 * response — whose `patch` is for another file — and `patchFile` degraded that
 * to a zero-hunk row, which `DiffHunks` correctly describes as *"no textual
 * change"*. A file that changed nine lines was told it had changed nothing:
 * exactly the sentence round 1's M2 was about, re-entered through the fix for
 * its L9.
 *
 * Carrying it across a change of RANGE or REPO was a second lie of the same
 * family — the header would say "N files between X and Y" off the old answer
 * while the URL named a different range. So the placeholder applies when, and
 * only when, the FILE LIST cannot have changed. `isPlaceholderData` then means
 * precisely "the list is the right list, the patch is not here yet", which is
 * what the panel needs to know.
 */
export function useRepoDiff(params: RepoDiffParams, enabled = true) {
  return useQuery({
    queryKey: keys.repoDiff(params),
    queryFn: () => api.repoDiff(params),
    enabled,
    staleTime: REPO_STALE,
    placeholderData: (prev, prevQuery) => {
      if (!prev) return undefined;
      const before = (prevQuery?.queryKey as [string, string, RepoDiffParams] | undefined)?.[2];
      if (!before) return undefined;
      return sameFileList(before, params) ? prev : undefined;
    },
  });
}

/**
 * Would these two requests produce the SAME file list?
 *
 * Three parameters decide it, and deliberately only three. `path`, `unified`
 * and `bytes` shape the PATCH and cannot touch the list — the server builds
 * `files` from `diffStat` before it so much as reads them
 * (`git-browse.ts` §`repoDiff`). Comparing `unified` here made toggling the
 * context-lines control blank the whole panel: the list, the header, the
 * truncation banner and the ToggleGroup that was just clicked, taking keyboard
 * focus with it. That is round 1's L9 again, re-entered through a different
 * control (QA round 3, F-3).
 *
 * Exported because a predicate this load-bearing is worth testing directly —
 * round 3's F-2 was that the test named for it asserted nothing about it.
 */
export function sameFileList(a: RepoDiffParams, b: RepoDiffParams): boolean {
  return a.repo === b.repo && a.base === b.base && a.tip === b.tip;
}

export function useRepoSettles(
  params: { limit?: number; slug?: string; runs?: number; entries?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: keys.repoSettles(params),
    queryFn: () => api.repoSettles(params),
    enabled,
    staleTime: REPO_STALE,
  });
}


/* ------------------------------------------------------------------ *
 * Issues — the estate board
 * ------------------------------------------------------------------ */

/**
 * The GET never reaches the network, so it is cheap; what is expensive is the
 * REFRESH, and that is a button. Fifteen seconds is therefore about the cache
 * on disk moving under us — a sweep keeping a repository warm, or another
 * browser's Refresh — not about GitHub.
 */
const ISSUES_STALE = 15_000;

/**
 * How often to ask again WHILE a fetch is in flight somewhere else.
 *
 * `refreshing: true` means another browser's Refresh, or the idle sweep, is
 * asking GitHub right now — and every Refresh control on the board is disabled
 * while it is. Nothing else invalidates this key (no SSE event carries the issue
 * cache), so without a poll the board could sit disabled with no path back until
 * the reader reloaded the page. The poll runs ONLY in that state and stops the
 * moment the payload says the fetch is done. (QA round 1, M-2.)
 */
const ISSUES_SETTLE_POLL = 2_000;

/**
 * Whether to keep asking, and how often — exported because a predicate this
 * load-bearing is worth testing directly, the same reason `sameFileList` is.
 * `false` is TanStack's word for "do not poll".
 */
export const issuesPollInterval = (payload: IssuesPayload | undefined): number | false =>
  payload?.refreshing ? ISSUES_SETTLE_POLL : false;

export function useIssues(enabled = true) {
  return useQuery({
    queryKey: keys.issues(),
    queryFn: api.issues,
    enabled,
    staleTime: ISSUES_STALE,
    refetchInterval: (query) => issuesPollInterval(query.state.data),
  });
}

/**
 * Ask GitHub again — one repository by its key, or every one that can be
 * asked. The answer IS the new payload, so it replaces the cached one at once;
 * the re-read after only confirms it. A refusal is said, because a Refresh
 * that fails silently reads as one that found nothing new.
 */
export function useIssuesRefresh() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (repo: string | undefined) => api.issuesRefresh(repo),
    onSuccess: (payload) => client.setQueryData(keys.issues(), payload),
    onError: (error) => toast(error.message || 'GitHub could not be asked.', 'error'),
    onSettled: () => client.invalidateQueries({ queryKey: keys.issues() }),
  });
}

/**
 * The repositories added to the desk by their `owner/name`, written whole
 * (`prefs.issueRepos`). The state is re-read for the list and the issues for
 * the rows: an added repository appears as `never-fetched` until it is asked.
 */
export function useIssueRepos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (next: readonly string[]) => api.savePrefs({ issueRepos: [...next] }),
    onError: (error) => toast(error.message || 'The desk’s repositories could not be saved.', 'error'),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.state() }),
        client.invalidateQueries({ queryKey: keys.issues() }),
      ]),
  });
}

