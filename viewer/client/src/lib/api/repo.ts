/**
 * Repo — the six read-only git surfaces Phase 8 shipped under `GET /api/repo/…`.
 *
 * The types are **re-declared here from the endpoint contract**, not imported
 * from `server/git-browse.ts`, and that is this codebase's rule rather than an
 * omission: `RunGitView`, `CheckoutEntry` and `DiffFile` are all hand-mirrored
 * the same way. `shared/` holds vocabulary that both sides must agree on
 * word-for-word; a view shape is a wire contract, and mirroring it is what makes
 * a server change that breaks the client fail a client test instead of silently
 * type-checking against the server's own definition.
 *
 * Two shapes are copied deliberately rather than simplified, because both were
 * P8 QA findings and both change what the UI renders:
 *
 * - **`CheckoutAttribution` is a discriminated union on `via`, not a bag of
 *   optionals.** `runId`/`status`/`live` come from a run RECORD; a `via:'branch'`
 *   row is a guess from a branch NAME an operator could have picked themselves,
 *   and has none of them. Those are exactly the rows the reclaim surface is for,
 *   so the compiler must ask `via` before anything reads `runId`.
 * - **`via` names two different vocabularies.** On a checkout it is
 *   `record | branch` — written evidence versus a guess. On a settle event it is
 *   `record | journal` — which of two sources carried the row, both real. One
 *   renderer for both would say the same word about two different things.
 */

import { request, q } from './client';

/* ---------------- vocabularies ---------------- */

/** What a checkout IS to this console. `debris` is a tree no surviving record claims. */
export type CheckoutRole = 'root' | 'run' | 'lane' | 'staging' | 'operator' | 'debris';

/** The journal's own settle-event names. */
export type SettleKind =
  'settled' | 'pending' | 'unsupported' | 'landed' | 'pushed' | 'failed' | 'released' | 'pruned';

/** A repository this console will answer about: the root, a linked worktree, or a mirror mount. */
export type RepoTargetKind = 'root' | 'submodule' | 'linked' | 'mount';

/* ---------------- targets ---------------- */

export interface RepoTarget {
  /** `root`, or a path relative to the root. The ONLY way to name a target. */
  key: string;
  dir: string;
  label: string;
  kind: RepoTargetKind;
}

export interface RepoTargets {
  targets: RepoTarget[];
}

/* ---------------- graph ---------------- */

export interface RepoCommit {
  sha: string;
  short: string;
  parents: string[];
  /** Decorations git printed for this commit: branch names, tags. */
  refs: string[];
  subject: string;
  author: string;
  at: string;
}

export interface RepoGraph {
  commits: RepoCommit[];
  /** The refs this walk covered. */
  tips: string[];
  trunk?: string;
  /**
   * This walk does not cover every branch it should — a SECOND, independent
   * flag. `truncated` means "more commits"; this means "fewer branches". A
   * named-ref walk never fires the window terms, but the 300-tip cap still can.
   */
  tipsTruncated: boolean;
  truncated: boolean;
  nextCursor?: string;
}

/* ---------------- branches ---------------- */

export interface RepoBranch {
  name: string;
  head: string;
  short: string;
  at?: string;
  subject?: string;
  author?: string;
  upstream?: string;
  current: boolean;
  /** Absent when there is no trunk to measure against — never `0`. */
  ahead?: number;
  behind?: number;
  trunk: boolean;
  /** Parsed from the NAME (`pe/<slug>` / `pe/<slug>-p<N>`), so it is a guess. */
  run?: { slug: string; phase?: number };
  /** Working trees standing on this branch, from the registry — written evidence. */
  heldBy?: string[];
}

export interface RepoBranches {
  branches: RepoBranch[];
  trunk?: string;
  truncated: boolean;
  /** The ahead/behind pass was capped — some rows have no divergence, not zero. */
  divergenceTruncated: boolean;
}

/* ---------------- checkouts ---------------- */

/**
 * How this console knows whose tree that is — three arms, and there is no fourth.
 *
 * `record` is the run record: it carries the run id, its status and whether it is
 * still live. `branch` is the branch name alone, which an operator can write by
 * hand — the arm with no run id, and the reason a reclaim surface must show it.
 */
export type CheckoutAttribution =
  | {
      via: 'record';
      run: { slug: string; phase?: number; runId: string; status?: string; live: boolean };
    }
  | { via: 'branch'; run: { slug: string; phase?: number } }
  | { via?: undefined; run?: undefined };

export type RepoCheckout = {
  dir: string;
  /** The repository this tree belongs to — a target key: `root`, or a submodule's path. */
  repo: string;
  branch?: string;
  /** The main working tree, as opposed to a linked one. */
  root: boolean;
  /** Under the console's own state directory — something it created. */
  managed: boolean;
  /** git still lists it and the directory is gone. */
  prunable: boolean;
  role: CheckoutRole;
  /** `detached@<sha>` — a tree standing on no branch names where it stands. */
  detached?: string;
} & CheckoutAttribution;

export interface RepoCheckouts {
  checkouts: RepoCheckout[];
  /** Always `false`, and honestly so: this reader applies no cap. */
  truncated: boolean;
}

/* ---------------- diff ---------------- */

export interface RepoDiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RepoPatch {
  text: string;
  truncated: boolean;
  /** git could not answer. `text` is empty and means NOTHING. */
  failed: boolean;
  path: string;
}

export interface RepoDiff {
  base?: string;
  tip?: string;
  files: RepoDiffFile[];
  filesTruncated: boolean;
  fileCount: number;
  patch?: RepoPatch;
}

/* ---------------- settles ---------------- */

export interface RepoSettleEvent {
  slug: string;
  runId: string;
  at: string;
  kind: SettleKind;
  branch?: string;
  strategy?: string;
  phase?: number;
  detail?: string;
  /** WHICH SOURCE carried the row — not the checkout vocabulary. Both are real. */
  via: 'record' | 'journal';
}

export interface RepoSettles {
  events: RepoSettleEvent[];
  truncated: boolean;
  /**
   * The window this history was read through — a TAIL, not the whole journal.
   * A surface that shows the events without the window claims a completeness it
   * does not have, so this is rendered, not logged.
   */
  scanned: { runs: number; entriesPerRun: number };
}


/* ---------------- fetchers ---------------- */

/**
 * Only the parameters that were actually given — an empty value is not a request.
 *
 * This is the client half of the rule P8's round-2 High was about: on the server,
 * `Number(query.get(n))` turns a parameter nobody sent into `0`, so a `unified`
 * with a floor of 0 could not tell silence from an explicit "no context". Sending
 * `unified=` for an undefined field would hand the server exactly that ambiguity
 * back, so an absent field is absent from the URL.
 */
function query(params: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${q(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/* A `type`, not an `interface`, and the same for `RepoDiffParams`: only a type
 * alias is assignable to the `Record<string, …>` the query builder takes —
 * an interface has no index signature, by design. */
export type RepoGraphParams = {
  repo?: string;
  /** Repeatable. Naming none is the default walk; naming refs none of which resolve is a 400. */
  ref?: string[];
  all?: boolean;
  limit?: number;
  cursor?: string;
};

export type RepoDiffParams = {
  repo?: string;
  /** Neither given = the working tree against HEAD — what a phase has changed so far. */
  base?: string;
  tip?: string;
  /** One file's patch. Absent = the file list only, with no patch at all. */
  path?: string;
  bytes?: number;
  /** Context lines. Defaults to git's own 3; `0` is a real request. */
  unified?: number;
};

export const repoApi = {
  repoTargets: () => request<RepoTargets>('/api/repo/targets'),

  repoGraph: ({ ref, all, ...rest }: RepoGraphParams = {}) => {
    // `ref` is built by hand because it REPEATS, which `query()` cannot express
    // — but it obeys the same rule: an empty value is not a request, and
    // sending `ref=` would be a named walk of nothing rather than the default.
    const refs = (ref ?? [])
      .filter((r) => r !== '')
      .map((r) => `ref=${q(r)}`)
      .join('&');
    const base = query({ ...rest, ...(all ? { all: 1 } : {}) });
    const path = `/api/repo/graph${base}${refs ? (base ? '&' : '?') + refs : ''}`;
    return request<RepoGraph>(path);
  },

  repoBranches: (repo?: string) => request<RepoBranches>(`/api/repo/branches${query({ repo })}`),

  /** No `repo=`: one registry, one object database — it would answer twice under two names. */
  repoCheckouts: () => request<RepoCheckouts>('/api/repo/checkouts'),

  repoDiff: (params: RepoDiffParams = {}) => request<RepoDiff>(`/api/repo/diff${query(params)}`),

  repoSettles: (params: { limit?: number; slug?: string; runs?: number; entries?: number } = {}) =>
    request<RepoSettles>(`/api/repo/settles${query(params)}`),

};
