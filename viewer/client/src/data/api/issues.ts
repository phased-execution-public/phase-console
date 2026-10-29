/**
 * Issues — the estate surface Phase 15 shipped under `GET /api/issues`.
 *
 * The shapes are the wire's (`shared/wire/issues.js`), imported by the
 * server's handlers and by this file alike; this file keeps only the fetches.
 *
 * Three things the shapes say that a renderer must not flatten:
 *
 * - **`state` is three-valued and `unknown` is not "empty".** A repository whose
 *   probe could not answer keeps its last good rows, with their real age beside
 *   the failure. `fresh | stale | unknown` are three different sentences.
 * - **`never-fetched` is the reason that is NOT a fault.** Nobody has pressed
 *   Refresh yet — the idle sweep deliberately never discovers a repository it
 *   has not been asked about, so an untouched console spends no GitHub quota.
 *   Painting it as a failure is the one misreading this contract invites.
 * - **`body` absent ≠ body empty.** A body arrives only once something asked for
 *   one, within the fetch pass's budget. "Not cached" and "no body" are two
 *   facts, and only one of them is about the issue.
 */

import { request, post } from '../http';
import type { IssuesPayload, IssuesRefreshBody } from '@shared/wire/issues.js';

export type {
  Issue,
  IssueFreshness,
  IssueProvenance,
  IssueReason,
  IssueRepoKind,
  IssueTriage,
  IssuesPayload,
  IssuesRefreshBody,
  RepoIssues,
} from '@shared/wire/issues.js';

export const issuesApi = {
  /** Never fetches, so it never blocks on the network. */
  issues: () => request<IssuesPayload>('/api/issues'),

  /**
   * Go and ask. Omit `repo` to refresh every askable repository.
   *
   * An unknown KEY is a 404 (an `ApiError`); a key with no GitHub remote is a
   * 200 whose row says `no-remote`. Single-flighted server-side, so two
   * browsers pressing Refresh is one `gh` call.
   */
  issuesRefresh: (repo?: string) =>
    post<IssuesPayload>('/api/issues/refresh', (repo ? { repo } : {}) satisfies IssuesRefreshBody),
};
