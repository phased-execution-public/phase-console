/**
 * Issues — the estate board, and the row model behind it.
 *
 * ## Why a repository can be a ROW in a table of issues
 *
 * `GET /api/issues` answers with every repository this console stands on,
 * whatever happened to it: `fresh`, `stale` (with the real age), or `unknown`
 * (with the reason). A board that rendered only the issues would turn "GitHub
 * refused us" and "this repository has no open work" into the same blank space,
 * which is the one thing the Phase 15 contract asks a renderer not to do.
 *
 * So the table's row type is a union. An `issue` row is an issue; a `repo` row
 * is a repository that has nothing to show and says why — never fetched, no
 * remote, rate-limited, or genuinely empty. A `repo` row is not selectable,
 * because there is no issue to select.
 *
 * A repository that HAS issues and simply matched none of the current filters
 * gets no row: the filter is on screen and explains it. The rule is "never a
 * silent absence", not "never an absence".
 *
 * ## The three states are three sentences, and `never-fetched` is not a fault
 *
 * The idle sweep keeps warm; it never discovers. A repository nobody has asked
 * about has no rows and no failure — pressing Refresh is the first fetch there
 * will ever be. `REASON_TONE` therefore paints it neutral, and the empty state
 * points at the button rather than apologising.
 *
 * ## Everything here came from outside the machine
 *
 * A title, a label, an assignee and a body are all somebody else's text. They
 * are rendered as TEXT — no markdown, no HTML, no link auto-detection — and the
 * only URL the board ever follows is the `url` GitHub itself sent. The same
 * discipline the server's prompt composer lives under, for the same reason.
 */

import { useMemo } from 'react';
import { CircleDot, CircleCheck, ExternalLink, RefreshCw } from 'lucide-react';
import { Badge, Chip, DataTable, Empty, type BadgeTone, type Column } from '@/components/ui';
import type { Issue, IssueReason, IssuesPayload, RepoIssues } from '@/lib/api';
import { relativeTime, elapsedWords, plural } from '@/lib/format';

/**
 * How many issues one ticket may carry — `TICKET_ISSUES_MAX` on the server.
 *
 * Mirrored rather than imported, like every other wire constant on this side
 * (`lib/api/issues.ts` says why). The board enforces it at the LAUNCH, never at
 * the tick: refusing the 21st checkbox would leave a person guessing which of
 * their twenty-one the console disliked.
 */
export const SELECTION_MAX = 20;

/** The dash. One spelling, so "nothing here" looks the same in every row. */
const UNKNOWN = '—';

/** What each failure reason means, in the words a person can act on. */
export const REASON_BLURB: Readonly<Record<IssueReason, string>> = Object.freeze({
  'no-gh': 'The gh CLI is not on this machine’s PATH, so nothing can ask GitHub.',
  'no-auth': 'gh is installed but not signed in. `gh auth login` in a terminal, then Refresh.',
  'rate-limited': 'GitHub is rate-limiting this token. A forced refresh honours the backoff.',
  'no-remote': 'This repository has no GitHub origin, so it has no issue tracker to read.',
  'never-fetched': 'Nobody has asked yet — the idle sweep keeps repositories warm, it never discovers one.',
  failed: 'The last attempt did not complete. Refresh really does retry this one.',
});

/**
 * The tone each reason paints in.
 *
 * `never-fetched` is deliberately neutral and `no-remote` too: neither is a
 * failure. One is a button nobody has pressed and the other is a standing fact
 * about the repository. Painting either amber would tell an operator to fix
 * something that is not broken — and `accent` IS this app's amber, rationed
 * for exactly the three that do need a person (install gh, sign in, wait).
 */
export const REASON_TONE: Readonly<Record<IssueReason, BadgeTone>> = Object.freeze({
  'no-gh': 'accent',
  'no-auth': 'accent',
  'rate-limited': 'accent',
  'no-remote': 'neutral',
  'never-fetched': 'neutral',
  failed: 'bad',
});

/* ---------------- the row model ---------------- */

export type IssueRow =
  /** `ref` is `''` for a repository with no GitHub name — a row nothing may select. */
  { kind: 'issue'; repo: RepoIssues; issue: Issue; ref: string } | { kind: 'repo'; repo: RepoIssues };

export interface IssueFilter {
  /** A repository KEY (`root`, or a submodule path). Absent = every repository. */
  repo?: string;
  /** `open` · `closed` · `all`. The default is `open` and the control says so. */
  state: 'open' | 'closed' | 'all';
  label?: string;
  /** Free text over the number, the title and the repository. */
  q?: string;
}

export const DEFAULT_FILTER: Readonly<IssueFilter> = Object.freeze({ state: 'open' });

/**
 * `owner/repo#12` — the only spelling the ticket door accepts.
 *
 * `undefined` when the repository has no GitHub name, which is also exactly
 * when it can have no issues. A row with no ref can never be selected, so the
 * cap and the payload cannot disagree about what "selected" meant.
 */
export function issueRef(repo: RepoIssues, issue: Issue): string | undefined {
  return repo.nameWithOwner ? `${repo.nameWithOwner}#${issue.number}` : undefined;
}

/** Case-insensitive, because `gh` spells the state `OPEN` and a URL spells it `open`. */
const isOpen = (issue: Issue) => issue.state.toUpperCase() !== 'CLOSED';

function matches(repo: RepoIssues, issue: Issue, filter: IssueFilter): boolean {
  if (filter.state === 'open' && !isOpen(issue)) return false;
  if (filter.state === 'closed' && isOpen(issue)) return false;
  if (filter.label && !issue.labels.includes(filter.label)) return false;
  const q = filter.q?.trim().toLowerCase();
  if (!q) return true;
  // The number is searched with and without its `#`, because both are how a
  // person writes one. `repo.label` and the owner name are in scope too: a
  // board over an estate is searched by "the thing in pe-hub about locks".
  const hay = [
    issue.title,
    `#${issue.number}`,
    String(issue.number),
    repo.label,
    repo.nameWithOwner ?? '',
    ...issue.labels,
    ...issue.assignees,
  ]
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * The rows a filter leaves, repository by repository and in payload order.
 *
 * A repository contributing no ISSUE rows becomes a `repo` row only when it
 * cannot speak for itself — `unknown`, or holding no cached issues at all. One
 * that holds issues none of which matched keeps its silence, because the filter
 * on screen is the explanation.
 */
export function boardRows(payload: IssuesPayload | undefined, filter: IssueFilter): IssueRow[] {
  const rows: IssueRow[] = [];
  for (const repo of payload?.repos ?? []) {
    if (filter.repo && repo.key !== filter.repo) continue;
    let kept = 0;
    for (const issue of repo.issues) {
      if (!matches(repo, issue, filter)) continue;
      kept += 1;
      rows.push({ kind: 'issue', repo, issue, ref: issueRef(repo, issue) ?? '' });
    }
    if (kept === 0 && (repo.state === 'unknown' || repo.issues.length === 0)) {
      rows.push({ kind: 'repo', repo });
    }
  }
  return rows;
}

/**
 * Why this repository has no issue rows — three different silences.
 *
 * QA round 1, L2: an `unknown` repository whose cached issues the FILTER had
 * excluded still asserted its failure reason, which contradicts the very rule
 * `boardRows` follows one function up ("the filter is the explanation"). And a
 * repository with a fetch time and an empty list read "No issues cached", which
 * is false — it was asked, and the answer was none.
 */
export function repoRowReason(repo: RepoIssues, filtered: boolean): string {
  if (filtered) return 'Issues are cached here — none of them match the filters above.';
  if (repo.state === 'unknown') return REASON_BLURB[repo.reason ?? 'failed'];
  return 'No issues in this repository — it was asked, and the answer was none.';
}

/** True when this repository holds issues that the current filter excluded. */
export const filteredOut = (repo: RepoIssues, filter: IssueFilter): boolean =>
  repo.issues.length > 0 && !repo.issues.some((issue) => matches(repo, issue, filter));

/**
 * A refresh that will not run however often it is asked.
 *
 * `rate-limited` is the ONE failure whose backoff a forced refresh honours
 * (`server/issues/index.ts` returns without asking), so it is the one refusal a
 * board has to show rather than attempt. Every other failure really does retry,
 * which is why a plain failure carries no `retryAt` at all.
 */
export const backedOff = (repo: RepoIssues, now = Date.now()): boolean =>
  repo.reason === 'rate-limited' && (repo.retryAt ?? 0) > now;

/** Only an `http(s)` URL reaches an `href`. Anything else is shown as text. */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Every label present in the payload, once, sorted — the filter's options. */
export function labelUniverse(payload: IssuesPayload | undefined): string[] {
  const out = new Set<string>();
  for (const repo of payload?.repos ?? []) {
    for (const issue of repo.issues) for (const label of issue.labels) out.add(label);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** A stable key per row — a ref where there is one, the repository otherwise. */
export const rowKey = (row: IssueRow): string =>
  row.kind === 'repo' ? `repo:${row.repo.key}` : `issue:${row.repo.key}#${row.issue.number}`;

/**
 * How old this repository's data is, said rather than hidden.
 *
 * `fresh` still shows its age: "fresh" is a threshold the server applied, not a
 * promise that the rows arrived this second, and a board that prints the word
 * without the number is asking to be trusted about a measurement it is holding.
 *
 * The SERVER's `ageMs` is preferred over this browser's arithmetic on
 * `fetchedAt` — the two disagree by whatever the clocks do, and only one of
 * them measured the cache it is describing. The pair travels together, so the
 * fallback is only ever reached by a server older than this field.
 */
export function ageLine(repo: RepoIssues): string {
  if (repo.fetchedAt === undefined) return 'never fetched';
  if (repo.ageMs !== undefined) return `fetched ${elapsedWords(repo.ageMs)} ago`;
  return `fetched ${relativeTime(repo.fetchedAt)}`;
}

/* ---------------- cells ---------------- */

/** The repository, with its freshness carried as a marker rather than a column. */
export function RepoCell({ repo, freshness = true }: { repo: RepoIssues; freshness?: boolean }) {
  const tone: BadgeTone =
    repo.state === 'unknown' ? (REASON_TONE[repo.reason ?? 'failed'] ?? 'bad') : 'neutral';
  const title =
    repo.state === 'unknown'
      ? `${REASON_BLURB[repo.reason ?? 'failed']} (${ageLine(repo)})`
      : `${repo.kind} · scope token ${repo.scopeToken} · ${ageLine(repo)}`;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <code className="min-w-0 truncate font-mono text-2xs text-ink" title={title}>
        {repo.label}
      </code>
      {freshness && repo.state !== 'fresh' && (
        <Badge tone={tone} title={title} data-testid="repo-freshness">
          {repo.state === 'stale' ? 'stale' : (repo.reason ?? 'unknown')}
        </Badge>
      )}
    </span>
  );
}

/** OPEN or CLOSED, in the app's own words rather than `gh`'s shouting. */
export function StateCell({ issue }: { issue: Issue }) {
  const open = isOpen(issue);
  return (
    <Badge tone={open ? 'ok' : 'neutral'} title={`GitHub says ${issue.state}.`}>
      <span className="inline-flex items-center gap-1">
        {open ? <CircleDot size={10} aria-hidden /> : <CircleCheck size={10} aria-hidden />}
        {open ? 'open' : 'closed'}
      </span>
    </Badge>
  );
}

/**
 * The first lines of a body, as TEXT.
 *
 * `whitespace-pre-wrap` keeps the author's line breaks and `break-words` keeps
 * a pasted stack trace inside its column. Nothing here parses markdown, and
 * that is the point: this string came from a stranger.
 */
export function BodyPreview({ issue, lines = 3 }: { issue: Issue; lines?: number }) {
  if (issue.body === undefined) {
    return (
      <p className="text-2xs text-ink-faint">
        No body cached. Bodies are fetched within a budget during a refresh — this one has not been asked for
        yet, which is not the same as an issue with nothing written in it.
      </p>
    );
  }
  const text = issue.body.split('\n').slice(0, lines).join('\n').trim();
  if (!text) return <p className="text-2xs text-ink-faint">This issue has an empty body.</p>;
  return (
    <p className="min-w-0 break-words whitespace-pre-wrap text-2xs text-ink-muted">
      {text}
      {(issue.body.split('\n').length > lines || issue.bodyTruncated) && (
        <span className="text-ink-faint"> …</span>
      )}
    </p>
  );
}

/* ---------------- the table ---------------- */

export interface IssueBoardProps {
  payload: IssuesPayload;
  filter: IssueFilter;
  /** Selected refs, by `owner/repo#12`. */
  selected: ReadonlySet<string>;
  onToggle: (ref: string) => void;
  /** Open the L2 inspector on this row. */
  onOpen: (row: Extract<IssueRow, { kind: 'issue' }>) => void;
  /** Ask this one repository again. Absent where the console may not. */
  onRefresh?: (repoKey: string) => void;
  refreshing?: boolean;
}

export function IssueBoard({
  payload,
  filter,
  selected,
  onToggle,
  onOpen,
  onRefresh,
  refreshing = false,
}: IssueBoardProps) {
  const rows = useMemo(() => boardRows(payload, filter), [payload, filter]);

  const columns = useMemo<Column<IssueRow>[]>(
    () => [
      {
        id: 'pick',
        head: '',
        priority: 1,
        min: 40,
        width: '40px',
        // `meta`, never `hide`: `CardList` DROPS a hidden column, and below the
        // shell breakpoint the card list is the whole rendering — so hiding it
        // left a phone with no way to pick ONE issue, which is this surface's
        // central verb. (QA round 1, High.) The meta line is where a card's
        // small per-row controls live.
        card: 'meta',
        cell: (row) =>
          row.kind === 'issue' && row.ref ? (
            // A native checkbox, not the primitive: a row's tick is inside a
            // table cell that already handles its own click, and the label
            // element gives the 44px target without a second wrapper.
            // No `sm:min-h-0`. The floor was released at 640, which is a WIDTH
            // — and a touch tablet at 768 or 1024 is every bit as coarse a
            // pointer as a phone, so releasing it there left a 16px box as the
            // only way to pick one issue. `hover:none` is the question that was
            // meant all along.
            <label className="flex min-h-(--tap-min) cursor-pointer items-center justify-center [@media(hover:hover)]:sm:min-h-0">
              <input
                type="checkbox"
                checked={selected.has(row.ref)}
                onChange={() => onToggle(row.ref)}
                aria-label={`Select ${row.ref} — ${row.issue.title}`}
                className="size-4 accent-[var(--accent)]"
              />
            </label>
          ) : null,
      },
      {
        id: 'number',
        head: 'Issue',
        identity: true,
        priority: 1,
        min: 92,
        // Deliberately NOT `card: 'title'`, though it was. `CardList` takes the
        // FIRST column marked `title`, so with two of them the card's headline
        // was `#41` and the issue's actual title dropped into the labelled
        // pairs below it — a list of numbers, on the one rendering where the
        // title is the only thing worth reading. Identity without `title` is
        // exactly the case `lead` exists for: the number prints small and in
        // mono beside the headline.
        cell: (row) =>
          row.kind === 'repo' ? (
            <span className="font-mono text-2xs text-ink-faint">{UNKNOWN}</span>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="flex min-h-(--tap-min) items-center font-mono text-2xs text-ink hover:text-action sm:min-h-0"
              aria-label={`Open issue ${row.ref || `#${row.issue.number}`}`}
            >
              #{row.issue.number}
            </button>
          ),
      },
      {
        id: 'title',
        head: 'Title',
        flex: true,
        priority: 1,
        min: 200,
        card: 'title',
        cell: (row) =>
          row.kind === 'repo' ? (
            <span className="min-w-0 break-words text-2xs text-ink-muted" data-testid="repo-row-reason">
              {repoRowReason(row.repo, filteredOut(row.repo, filter))}
              {row.repo.detail && (
                <span className="block break-words text-ink-faint" data-testid="repo-row-detail">
                  {row.repo.detail}
                </span>
              )}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="flex min-h-(--tap-min) w-full min-w-0 items-center text-left text-sm text-ink hover:text-action sm:min-h-0"
            >
              <span className="min-w-0 break-words">{row.issue.title}</span>
            </button>
          ),
      },
      {
        id: 'repo',
        head: 'Repository',
        priority: 2,
        min: 140,
        card: 'meta',
        // A repository ROW already has a State column carrying its reason, and
        // on a card the meta values join one line — so this said it twice and
        // the Updated column said it a third time in words: `hub ·
        // never-fetched · never fetched · never-fetched`. An issue row keeps
        // the marker, because there is no other column saying how fresh the
        // repository behind it is.
        //
        // `stale` is the exception, and the reason the condition is not just
        // the kind: State says the repository's REASON, and a stale repo has
        // none — it renders `no issues`, so dropping the badge took the word
        // `stale` off the row entirely while `estate-line` went on counting it.
        cell: (row) => (
          <RepoCell repo={row.repo} freshness={row.kind === 'issue' || row.repo.state === 'stale'} />
        ),
      },
      {
        id: 'labels',
        head: 'Labels',
        priority: 4,
        min: 140,
        cell: (row) =>
          row.kind === 'repo' || row.issue.labels.length === 0 ? (
            <span className="text-2xs text-ink-faint">{UNKNOWN}</span>
          ) : (
            // A label is whatever the repository's maintainers typed, so the
            // chips break — same answer as the branches Run cell and
            // `scope-chips.tsx`. A `whitespace-nowrap` chip in a 140px track
            // escapes the track instead of widening it.
            <span className="flex min-w-0 flex-wrap gap-1">
              {row.issue.labels.map((label) => (
                <Chip key={label} tone="neutral" className="max-w-full break-all whitespace-normal">
                  {label}
                </Chip>
              ))}
            </span>
          ),
      },
      {
        id: 'assignee',
        head: 'Assignee',
        priority: 5,
        min: 120,
        cell: (row) =>
          row.kind === 'repo' || row.issue.assignees.length === 0 ? (
            <span className="text-2xs text-ink-faint">unassigned</span>
          ) : (
            <span className="min-w-0 break-words text-2xs text-ink-muted">
              {row.issue.assignees.join(', ')}
            </span>
          ),
      },
      {
        id: 'age',
        head: 'Updated',
        priority: 3,
        min: 108,
        card: 'meta',
        cell: (row) => {
          // No `whitespace-nowrap` on either branch. Under `table-fixed` a cell
          // that refuses to wrap does not widen its column, it escapes it — the
          // same mechanism the State column above paid 13 px for.
          if (row.kind === 'repo') {
            return <span className="text-2xs text-ink-faint">{ageLine(row.repo)}</span>;
          }
          const at = Date.parse(row.issue.updatedAt);
          return (
            <span
              className="text-2xs text-ink-muted"
              title={Number.isNaN(at) ? row.issue.updatedAt : new Date(at).toLocaleString()}
            >
              {Number.isNaN(at) ? row.issue.updatedAt : relativeTime(at)}
            </span>
          );
        },
      },
      {
        id: 'state',
        head: 'State',
        priority: 2,
        // 132, not 92, and the 40 px is not slack. The widest thing this column
        // holds is a repository row's reason badge — `never-fetched` measures
        // 105 px — and the cell adds `--tile-pad-x` on both sides. A track of 92
        // put the whole table 13 px over its box at 1024 and 1440, which
        // `useTableFit` correctly reads as overflow: the wrapper starts
        // scrolling, the sticky header goes, the identity column pins, and the
        // last column is cut. Thirteen pixels bought all of that.
        min: 132,
        card: 'meta',
        cell: (row) =>
          row.kind === 'repo' ? (
            <Badge
              tone={
                row.repo.state === 'unknown' ? (REASON_TONE[row.repo.reason ?? 'failed'] ?? 'bad') : 'neutral'
              }
            >
              {row.repo.state === 'unknown' ? (row.repo.reason ?? 'unknown') : 'no issues'}
            </Badge>
          ) : (
            <StateCell issue={row.issue} />
          ),
      },
    ],
    [selected, onToggle, onOpen, filter],
  );

  return (
    <DataTable
      label="Issues across every repository"
      columns={columns}
      rows={rows}
      getRowKey={rowKey}
      rowClassName={(row) => (row.kind === 'repo' ? 'bg-ground-deep/30' : undefined)}
      detail={(row) => <RowDetail row={row} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing} />}
      empty={
        <Empty
          icon={<CircleDot size={20} aria-hidden />}
          title="Nothing matches"
          body="Every repository this console stands on is listed here — including the ones it could not ask. If this is empty, the filters above are why."
        />
      }
    />
  );
}

/** L1 — what a row reveals without leaving the table. */
function RowDetail({
  row,
  onRefresh,
  refreshing,
}: {
  row: IssueRow;
  onRefresh?: (repoKey: string) => void;
  refreshing: boolean;
}) {
  if (row.kind === 'repo') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-2xs text-ink-muted">
          {row.repo.nameWithOwner ? (
            <>
              <code className="font-mono">{row.repo.nameWithOwner}</code> · scope token{' '}
              <code className="font-mono">{row.repo.scopeToken}</code>
            </>
          ) : (
            <>
              No GitHub origin. This repository is still part of the estate — it simply has no issue tracker
              to read.
            </>
          )}
        </p>
        <RepoActions repo={row.repo} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing} />
      </div>
    );
  }
  // The URL came off the wire with everything else on this board. `gh` sends an
  // https one, so this never fires in practice — which is exactly the argument
  // for it being cheap: an `href` is the one place a string from outside the
  // machine gets to be a capability rather than text.
  const href = safeHttpUrl(row.issue.url);
  return (
    <div className="flex flex-col gap-2">
      <BodyPreview issue={row.issue} />
      <div className="flex flex-wrap items-center gap-3 text-2xs">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-(--tap-min) items-center gap-1 text-action hover:underline sm:min-h-0"
          >
            <ExternalLink size={12} aria-hidden /> Open on GitHub
          </a>
        ) : (
          <span className="text-ink-faint" data-testid="issue-url-refused">
            This issue&rsquo;s URL is not an http(s) address, so it is shown rather than linked:{' '}
            <code className="font-mono break-all">{row.issue.url}</code>
          </span>
        )}
        {row.ref && <code className="font-mono text-ink-faint">{row.ref}</code>}
      </div>
    </div>
  );
}

/**
 * What can be done to one repository from its row.
 *
 * `rate-limited` is the one refusal that has to be shown rather than attempted:
 * the server honours its own backoff, so a button that looked live would do
 * nothing and say nothing. Every other failure really does retry.
 */
export function RepoActions({
  repo,
  onRefresh,
  refreshing,
}: {
  repo: RepoIssues;
  onRefresh?: (repoKey: string) => void;
  refreshing: boolean;
}) {
  const held = backedOff(repo);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onRefresh && repo.nameWithOwner && (
        <button
          type="button"
          disabled={refreshing || held}
          onClick={() => onRefresh(repo.key)}
          title={
            held
              ? `GitHub is rate-limiting this token; a refresh will not run before ${new Date(
                  repo.retryAt!,
                ).toLocaleTimeString()}.`
              : `Ask GitHub for ${repo.nameWithOwner} again.`
          }
          className="inline-flex min-h-(--tap-min) items-center gap-1 rounded border border-rule px-2 text-2xs text-ink-muted hover:text-ink disabled:opacity-50 sm:min-h-0 sm:py-1"
        >
          <RefreshCw size={12} aria-hidden /> Refresh this repository
        </button>
      )}
      {repo.nameWithOwner && (
        <a
          href={`https://github.com/${repo.nameWithOwner}/issues/new`}
          target="_blank"
          rel="noreferrer noopener"
          // A LINK, never a form: this console files nothing on anybody's
          // behalf, and `issues-readonly.test.ts` is the server-side half of
          // the same promise.
          className="inline-flex min-h-(--tap-min) items-center gap-1 text-2xs text-action hover:underline sm:min-h-0"
        >
          <ExternalLink size={12} aria-hidden /> New issue on GitHub
        </a>
      )}
      {repo.truncated && (
        <span className="text-2xs text-ink-faint" data-testid="repo-truncated">
          More issues exist than one page holds — {plural(repo.issues.length, 'row')} shown.
        </span>
      )}
    </div>
  );
}
