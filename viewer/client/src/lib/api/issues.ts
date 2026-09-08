/**
 * Issues — the estate surface Phase 15 shipped under `GET /api/issues`.
 *
 * The types are **re-declared here from the endpoint contract**, not imported
 * from `server/issues/`, exactly as `./repo.ts` mirrors the git surfaces. A view
 * shape is a wire contract, and mirroring it is what makes a server change that
 * breaks the client fail a CLIENT test instead of silently type-checking against
 * the server's own definition.
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

import { request, post } from './client';

/** Why a repository's issues could not be refreshed. */
export type IssueReason = 'no-gh' | 'no-auth' | 'rate-limited' | 'no-remote' | 'never-fetched' | 'failed';

/** How old — and how trustworthy — a repository's rows are. */
export type IssueFreshness = 'fresh' | 'stale' | 'unknown';

/** What kind of repository this is inside the estate. */
export type IssueRepoKind = 'root' | 'submodule';

export interface Issue {
  number: number;
  /** `OPEN` | `CLOSED`, as `gh` spells it. Compared case-insensitively here. */
  state: string;
  title: string;
  labels: string[];
  assignees: string[];
  /** ISO 8601, as GitHub sent it. */
  updatedAt: string;
  url: string;
  /** Present only once a body was asked for. Plain text — never rendered as markup. */
  body?: string;
  /** True when `body` was cut at the server's byte ceiling. */
  bodyTruncated?: boolean;
}

export interface RepoIssues {
  /** `root`, or the root-relative submodule path. The ONLY way to name one. */
  key: string;
  label: string;
  /** The plan Repos-column token for this repository. */
  scopeToken: string;
  kind: IssueRepoKind;
  /** Absent when this repository has no origin at all. */
  remote?: string;
  /** Absent unless the remote is GitHub — and then it is `owner/repo`. */
  nameWithOwner?: string;
  state: IssueFreshness;
  /** Only with `unknown`. */
  reason?: IssueReason;
  /** Only with `unknown` — what `gh` said, already bounded by the server. */
  detail?: string;
  /** Epoch ms of the last SUCCESSFUL fetch. Absent if there has never been one. */
  fetchedAt?: number;
  /**
   * How old that data is, measured by the SERVER against the payload's own
   * `at`. It travels with `fetchedAt` — both present, or neither — so it is the
   * age to render: it is immune to a browser clock that disagrees with the
   * machine the cache is on.
   */
  ageMs?: number;
  /**
   * Epoch ms before which a refresh will not happen however often it is asked.
   * Present ONLY with `rate-limited` — the one failure whose backoff a forced
   * refresh honours, which is why a board must not offer a button that lies.
   */
  retryAt?: number;
  /** More issues exist than one page holds. */
  truncated?: boolean;
  issues: Issue[];
}

export interface IssuesPayload {
  /** When this payload was assembled — NOT when its data was fetched. */
  at: number;
  /** True while any repository is being fetched right now. */
  refreshing: boolean;
  /** Every repository, always — `unknown` ones included. */
  repos: RepoIssues[];
}

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
  issuesRefresh: (repo?: string) => post<IssuesPayload>('/api/issues/refresh', repo ? { repo } : {}),
};
