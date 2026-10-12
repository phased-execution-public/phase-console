/**
 * The Issues desk's rows (7.0, quiet-console phase 18): what the desk reads
 * off `GET /api/issues` — the row model, the filter and the order the address
 * carries, and the columns the grid draws.
 *
 * ## A repository can be a ROW in a table of issues
 *
 * `GET /api/issues` answers with every repository this console stands on,
 * whatever happened to it: `fresh`, `stale` (with the real age) or `unknown`
 * (with the reason). A desk that drew only the issues would turn "GitHub
 * refused us" and "this repository has no open work" into the same blank, so
 * a row is a union: an issue, or a repository that has nothing to show and
 * says why — never asked, no GitHub origin, rate-limited, or genuinely empty.
 * A repository that HAS issues and matched none of the filters gets no row:
 * the filters on screen are the explanation. The rule is "never a silent
 * absence", not "never an absence".
 *
 * `never-fetched` is not a fault. The idle sweep keeps repositories warm and
 * never discovers one, so a repository nobody has asked about has no rows and
 * no failure — pressing Refresh is the first ask there will ever be.
 *
 * ## Everything here came from outside the machine
 *
 * A title, a label, an assignee and a body are somebody else's text. They are
 * drawn as TEXT — no markdown, no HTML, no link detection — and the only URL
 * the desk ever follows is the `url` GitHub sent, and only an http(s) one.
 */

import type { Issue, IssueReason, IssuesPayload, IssueTriage, RepoIssues } from '@/data/api';
import { elapsedWords, plural, relativeTime } from '@/lib/format';
import { Button, Mono, RelativeTime } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Checkbox } from '@/ui/checkbox';
import { OpsStatus } from '@/ui/status';
import {
  ISSUE_CATEGORIES,
  ISSUE_PLAN_STATES,
  ISSUE_SEVERITY_WORDS,
  triageOf,
  type IssueCategory,
  type IssuePlanState,
  type IssueSeverityWord,
} from '@shared/issues-model.js';
import { NOT_MEASURED } from './model';
import { repoSectionHref } from './routes';

/**
 * How many issues one ticket may carry — `TICKET_ISSUES_MAX` on the server,
 * mirrored like every wire constant on this side. Enforced at the LAUNCH,
 * never at the tick: refusing the 21st box would leave a person guessing
 * which of their twenty-one the console disliked.
 */
export const SELECTION_MAX = 20;

/**
 * A brief's `maxLength` — the launch dialog's, the compose sheet's and the
 * wizard's: 8 000 CHARACTERS. A coarse cap, and not the one that decides:
 * `maxLength` counts UTF-16 code units and the server counts bytes.
 */
export const BRIEF_MAX = 8000;

/**
 * The server's ceiling — `MAX_BRIEF_BYTES` in `server/agent.ts`, which answers
 * `400 the brief is too long (8 KB max).` past it. Counted in bytes here too,
 * because the two units disagree wherever the text is not ASCII: some 4 100
 * Persian characters clear `maxLength` and are refused by the server, so a
 * form refuses them first, before the press composes a refusal.
 */
export const BRIEF_MAX_BYTES = 8192;

/** UTF-8 bytes, the way the server counts them. */
export const briefBytes = (text: string): number => new TextEncoder().encode(text).length;

/** What each failure reason means, in the words a person can act on. */
export const REASON_BLURB: Readonly<Record<IssueReason, string>> = Object.freeze({
  'no-gh': 'The gh CLI is not on this machine’s PATH, so nothing can ask GitHub.',
  'no-auth': 'gh is installed but not signed in. Run gh auth login in a terminal, then Refresh.',
  'rate-limited': 'GitHub is rate-limiting this token. A refresh waits out the backoff.',
  'no-remote': 'This repository has no GitHub origin, so it has no issue tracker to read.',
  'never-fetched':
    'Nobody has asked GitHub yet: the idle sweep keeps repositories warm, it never discovers one.',
  failed: 'The last ask did not complete. Refresh really does try this one again.',
});

/** The same reasons in a few words — a row's repository cell and the filter's lines. */
const REASON_WORDS: Readonly<Record<IssueReason, string>> = Object.freeze({
  'no-gh': 'gh is not installed',
  'no-auth': 'gh is not signed in',
  'rate-limited': 'rate-limited',
  'no-remote': 'no GitHub origin',
  'never-fetched': 'not asked yet',
  failed: 'the last ask failed',
});

/* ---------------- the row model ---------------- */

export type IssueRow =
  /** `ref` is `''` for a repository with no GitHub name — a row nothing may pick. */
  { kind: 'issue'; repo: RepoIssues; issue: Issue; ref: string } | { kind: 'repo'; repo: RepoIssues };

export interface IssueFilter {
  /** A repository KEY (`root`, a submodule path, or `github:<owner/name>` for an added one). Absent = every one. */
  repo?: string;
  /** The default is `open`, and the filter says so. */
  state: 'open' | 'closed' | 'all';
  label?: string;
  /** Free text over the number, the title, the repository, the labels and the people. */
  q?: string;
  /** `sessions` keeps only the issues a session of this console filed — the ones with a provenance. */
  filed?: 'sessions';
  /** The desk's three readings (control-tower phase 118) — each one word of its vocabulary, or absent. */
  category?: IssueCategory;
  severity?: IssueSeverityWord;
  plan?: IssuePlanState;
}

export const DEFAULT_FILTER: Readonly<IssueFilter> = Object.freeze({ state: 'open' });

/**
 * What the desk reads off an issue: the server's derivation when it sent one,
 * else the SAME function run here (`shared/issues-model.js`) — so an issue from
 * a server before 6.1 reads exactly as a new one would, less the phase only the
 * server's plans can name.
 */
export function triageOfIssue(issue: Issue): IssueTriage {
  return issue.triage ?? triageOf(issue);
}

/** One word of a vocabulary from the address, or nothing — a word the vocabulary lacks is no filter. */
export function wordOf<W extends string>(words: readonly W[], value: string | undefined): W | undefined {
  return value !== undefined && (words as readonly string[]).includes(value) ? (value as W) : undefined;
}

/**
 * The filter the address states. A word outside its vocabulary is no filter,
 * rather than one that hides every row for a word nothing could ever carry.
 */
export function filterFrom(query: Readonly<Record<string, string | undefined>>): IssueFilter {
  const state = query.state === 'closed' || query.state === 'all' ? query.state : DEFAULT_FILTER.state;
  const category = wordOf(ISSUE_CATEGORIES, query.category);
  const severity = wordOf(ISSUE_SEVERITY_WORDS, query.severity);
  const plan = wordOf(ISSUE_PLAN_STATES, query.plan);
  return {
    state,
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.label ? { label: query.label } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.filed === 'sessions' ? { filed: 'sessions' as const } : {}),
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    ...(plan ? { plan } : {}),
  };
}

/** How many of the filter's settings are away from their default — the Filter slot's count. */
export function filtersInForce(filter: IssueFilter): number {
  return (
    (filter.repo ? 1 : 0) +
    (filter.state !== DEFAULT_FILTER.state ? 1 : 0) +
    (filter.label ? 1 : 0) +
    (filter.filed ? 1 : 0) +
    (filter.category ? 1 : 0) +
    (filter.severity ? 1 : 0) +
    (filter.plan ? 1 : 0)
  );
}

/* ---------------- the order ---------------- */

/** The columns the desk orders by, as the address spells them (`?sort=`). */
export const ISSUE_SORT_IDS = [
  'number',
  'title',
  'category',
  'severity',
  'status',
  'labels',
  'assignee',
  'author',
  'updated',
] as const;
export type IssueSortId = (typeof ISSUE_SORT_IDS)[number];
export type SortDir = 'ascending' | 'descending';
export interface IssueSort {
  id: IssueSortId;
  dir: SortDir;
}

/**
 * Where an order's first press points: the newest number and the latest update
 * first, the worst severity first, everything else from the top of its own
 * order. A second press reverses it.
 */
export const SORT_DEFAULT_DIR: Readonly<Record<IssueSortId, SortDir>> = Object.freeze({
  number: 'descending',
  title: 'ascending',
  category: 'ascending',
  severity: 'descending',
  status: 'ascending',
  labels: 'ascending',
  assignee: 'ascending',
  author: 'ascending',
  updated: 'descending',
});

/** An order read from the address, or none — the payload's own, newest first per repository. */
export function sortFrom(query: Readonly<Record<string, string | undefined>>): IssueSort | undefined {
  const id = wordOf(ISSUE_SORT_IDS, query.sort);
  if (!id) return undefined;
  const dir = query.dir === 'asc' ? 'ascending' : query.dir === 'desc' ? 'descending' : SORT_DEFAULT_DIR[id];
  return { id, dir };
}

/** A press on an order: the one in force reverses, any other starts in its own first direction. */
export function nextSort(current: IssueSort | undefined, id: IssueSortId): IssueSort {
  return current?.id === id
    ? { id, dir: current.dir === 'ascending' ? 'descending' : 'ascending' }
    : { id, dir: SORT_DEFAULT_DIR[id] };
}

const SEVERITY_RANK = (word: IssueSeverityWord) =>
  ISSUE_SEVERITY_WORDS.length - ISSUE_SEVERITY_WORDS.indexOf(word);

/**
 * A row's order value. `undefined` is "nothing to compare" — no author, no
 * assignee, no labels — and sorts after every real value whichever the
 * direction, because an empty cell is not the smallest name.
 */
function sortValue(row: Extract<IssueRow, { kind: 'issue' }>, id: IssueSortId): string | number | undefined {
  const { issue } = row;
  switch (id) {
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'category':
      return ISSUE_CATEGORIES.indexOf(triageOfIssue(issue).category);
    case 'severity':
      // Ranked so that DESCENDING is worst first: critical is the largest.
      return SEVERITY_RANK(triageOfIssue(issue).severity);
    case 'status':
      return ISSUE_PLAN_STATES.indexOf(triageOfIssue(issue).plan.state);
    case 'labels':
      return issue.labels.length ? [...issue.labels].sort((a, b) => a.localeCompare(b)).join(' ') : undefined;
    case 'assignee':
      return issue.assignees[0];
    case 'author':
      return issue.author || undefined;
    case 'updated': {
      const at = Date.parse(issue.updatedAt);
      return Number.isNaN(at) ? undefined : at;
    }
  }
}

/**
 * The rows in the order asked for — stable, so ties keep the payload's order,
 * and a repository row always after the issues: it is a note about the estate,
 * not a datum to rank.
 */
export function sortIssueRows(rows: readonly IssueRow[], sort: IssueSort | undefined): IssueRow[] {
  if (!sort) return [...rows];
  const flip = sort.dir === 'ascending' ? 1 : -1;
  const keyed = rows.map((row, index) => ({
    row,
    index,
    value: row.kind === 'issue' ? sortValue(row, sort.id) : undefined,
  }));
  keyed.sort((a, b) => {
    if (a.row.kind !== b.row.kind) return a.row.kind === 'repo' ? 1 : -1;
    if (a.value === undefined || b.value === undefined) {
      if (a.value === b.value) return a.index - b.index;
      return a.value === undefined ? 1 : -1;
    }
    const order =
      typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value));
    return order * flip || a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}

/* ---------------- the address ---------------- */

/**
 * The desk's address with one change: the filters and the order it carries
 * now, the patch over them, and every default left out — an address that
 * states every default is one nobody can read the interesting part of.
 * `issue` names the inspected record and belongs only to the patch.
 */
export function deskHref(
  current: IssueFilter,
  sort: IssueSort | undefined,
  patch: Partial<IssueFilter> & { issue?: string; sort?: IssueSort | null },
): string {
  const next = { ...current, ...patch };
  const order = patch.sort === null ? undefined : (patch.sort ?? sort);
  return repoSectionHref('issues', {
    repo: next.repo,
    state: next.state === DEFAULT_FILTER.state ? undefined : next.state,
    label: next.label,
    q: next.q,
    filed: next.filed,
    category: next.category,
    severity: next.severity,
    plan: next.plan,
    sort: order?.id,
    dir:
      order && order.dir !== SORT_DEFAULT_DIR[order.id]
        ? order.dir === 'ascending'
          ? 'asc'
          : 'desc'
        : undefined,
    issue: patch.issue,
  });
}

/**
 * `owner/repo#12` — the only spelling the ticket door accepts. Absent when the
 * repository has no GitHub name, which is also exactly when it can have no
 * issues, so the cap and the payload never disagree about what "picked" meant.
 */
export function issueRef(repo: RepoIssues, issue: Issue): string | undefined {
  return repo.nameWithOwner ? `${repo.nameWithOwner}#${issue.number}` : undefined;
}

/** Case-insensitive, because `gh` spells the state `OPEN` and an address spells it `open`. */
export const isOpenIssue = (issue: Issue): boolean => issue.state.toUpperCase() !== 'CLOSED';

function matches(repo: RepoIssues, issue: Issue, filter: IssueFilter): boolean {
  if (filter.filed === 'sessions' && !issue.provenance) return false;
  if (filter.state === 'open' && !isOpenIssue(issue)) return false;
  if (filter.state === 'closed' && isOpenIssue(issue)) return false;
  if (filter.label && !issue.labels.includes(filter.label)) return false;
  if (filter.category || filter.severity || filter.plan) {
    const triage = triageOfIssue(issue);
    if (filter.category && triage.category !== filter.category) return false;
    if (filter.severity && triage.severity !== filter.severity) return false;
    if (filter.plan && triage.plan.state !== filter.plan) return false;
  }
  const q = filter.q?.trim().toLowerCase();
  if (!q) return true;
  // The number is searched with and without its `#`, because both are how a
  // person writes one; the repository is in scope because an estate is
  // searched by "the thing in pe-hub about locks".
  const hay = [
    issue.title,
    `#${issue.number}`,
    String(issue.number),
    repo.label,
    repo.nameWithOwner ?? '',
    ...issue.labels,
    ...issue.assignees,
    issue.author ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * The rows a filter leaves, repository by repository in payload order. A
 * repository contributing no issue rows becomes a row of its own only when it
 * cannot speak for itself — `unknown`, or holding no cached issues at all.
 * Under the sessions filter the question is "which issues did sessions file",
 * and a repository's silence is no answer to it: no repository row there.
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
    if (kept === 0 && filter.filed !== 'sessions' && (repo.state === 'unknown' || repo.issues.length === 0)) {
      rows.push({ kind: 'repo', repo });
    }
  }
  return rows;
}

/**
 * Every issue the desk holds, open and closed, in every repository — the
 * "N of M shown" denominator. Counted against the whole holding, because the
 * repository and the state are filters too: a count taken under them could not
 * say how much they left out.
 */
export function issueCount(payload: IssuesPayload | undefined): number {
  let count = 0;
  for (const repo of payload?.repos ?? []) count += repo.issues.length;
  return count;
}

/** True when this repository holds issues that the filter excluded. */
export const filteredOut = (repo: RepoIssues, filter: IssueFilter): boolean =>
  repo.issues.length > 0 && !repo.issues.some((issue) => matches(repo, issue, filter));

/**
 * Why a repository has no issue rows — three different silences: the filter
 * excluded what it holds, it could not be asked, or it was asked and the
 * answer was none.
 */
export function repoRowReason(repo: RepoIssues, filtered: boolean): string {
  if (filtered) return 'Issues are cached here; none of them match the filters.';
  if (repo.state === 'unknown') return REASON_BLURB[repo.reason ?? 'failed'];
  return 'No issues in this repository: it was asked, and the answer was none.';
}

/**
 * A refresh that will not run however often it is asked. `rate-limited` is
 * the ONE failure whose backoff a forced refresh honours, so it is the one
 * refusal a desk shows rather than attempts; every other failure really does
 * retry, which is why only it carries a `retryAt`.
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

/** Every label present in the payload, once, sorted — the filter's choices. */
export function labelUniverse(payload: IssuesPayload | undefined): string[] {
  const out = new Set<string>();
  for (const repo of payload?.repos ?? []) {
    for (const issue of repo.issues) for (const label of issue.labels) out.add(label);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** A stable key per row — the repository's key and the number, or the repository alone. */
export const issueRowKey = (row: IssueRow): string =>
  row.kind === 'repo' ? `repo:${row.repo.key}` : `issue:${row.repo.key}#${row.issue.number}`;

/**
 * Every ref the payload can still resolve — what a ticket may name: the
 * estate's (`kind` absent), or the added repositories' (`'added'`), which no
 * ticket may name because no plan of this console can scope them.
 */
export function livingRefs(payload: IssuesPayload | undefined, kind?: 'added'): string[] {
  const out: string[] = [];
  for (const repo of payload?.repos ?? []) {
    if ((repo.kind === 'added') !== (kind === 'added')) continue;
    for (const issue of repo.issues) {
      const ref = issueRef(repo, issue);
      if (ref) out.push(ref);
    }
  }
  return out;
}

/** The record `?issue=` names, by ref — or by `<key>#<number>` where there is no ref. */
export function findByRef(
  payload: IssuesPayload | undefined,
  ref: string,
): { repo: RepoIssues; issue: Issue } | undefined {
  for (const repo of payload?.repos ?? []) {
    for (const issue of repo.issues) {
      if (issueRef(repo, issue) === ref || `${repo.key}#${issue.number}` === ref) return { repo, issue };
    }
  }
  return undefined;
}

/** The address's name for a row's record — its ref, or `<key>#<number>`. */
export const recordRef = (row: Extract<IssueRow, { kind: 'issue' }>): string =>
  row.ref || `${row.repo.key}#${row.issue.number}`;

/**
 * How old a repository's data is, said rather than hidden. `fresh` still shows
 * its age: it is a threshold the server applied, not a promise the rows arrived
 * this second. The SERVER's `ageMs` is preferred over this browser's arithmetic
 * on `fetchedAt`, because only one of the two clocks measured the cache.
 */
export function ageLine(repo: RepoIssues): string {
  if (repo.fetchedAt === undefined) return 'never fetched';
  if (repo.ageMs !== undefined) return `fetched ${elapsedWords(repo.ageMs)} ago`;
  return `fetched ${relativeTime(repo.fetchedAt)}`;
}

/** Where a repository stands, in a few words — its row, the filter's line under its name. */
export function repoStateWords(repo: RepoIssues): string {
  if (repo.state === 'unknown') return REASON_WORDS[repo.reason ?? 'failed'];
  const age = ageLine(repo);
  if (repo.kind === 'added') return `outside this console, ${age}`;
  return repo.state === 'stale' ? `stale, ${age}` : age;
}

/** Where an issue stands in a plan, as words: the plan and its phases when it names them. */
export function planWhere(triage: IssueTriage): string | undefined {
  const { plan } = triage;
  if (!plan.slug) return undefined;
  if (!plan.phases?.length) return plan.slug;
  return `${plan.slug}, phase${plan.phases.length > 1 ? 's' : ''} ${plan.phases.join(', ')}`;
}

/* ---------------- the columns ---------------- */

const dash = <span className="text-meta text-ink-faint">{NOT_MEASURED}</span>;

/** What the columns need from the desk around them. */
export interface IssueColumnsInput {
  filter: IssueFilter;
  sort: IssueSort | undefined;
  picked: ReadonlySet<string>;
  onPick: (ref: string) => void;
}

/**
 * The desk's columns. At the glance: the pick, the number (the record's link),
 * the title, how bad, where it stands in a plan, the repository and when it
 * last moved; with Everything on, what kind, the labels, the people, the state
 * and who filed it as well. What kind is the one reading kept in the row's
 * fold: drawn at the glance it left the title a quarter of a 1280 desk, four
 * lines to an issue, and the labels and the Filter say it too. One repository
 * picked, the repository column goes — every row is that one, and the filter
 * says which.
 */
export function issueColumns({ filter, sort, picked, onPick }: IssueColumnsInput): Column<IssueRow>[] {
  // A column says which way its next press points: the way it points now when
  // it is the order in force, its own first direction otherwise.
  const by = (id: IssueSortId): Pick<Column<IssueRow>, 'sort'> => ({
    sort: { id, dir: sort?.id === id ? sort.dir : SORT_DEFAULT_DIR[id] },
  });
  const all: Column<IssueRow>[] = [
    {
      id: 'pick',
      head: 'Pick',
      min: 48,
      width: '48px',
      priority: 1,
      hideable: false,
      // On a phone the pick is the card's one action: picking these three is
      // the verb the desk exists for, so a card that dropped it would leave a
      // phone with no way to choose one issue.
      card: 'action',
      cell: (row) =>
        row.kind === 'issue' && row.ref ? (
          <span className="flex items-center justify-center">
            <Checkbox
              checked={picked.has(row.ref)}
              onCheckedChange={() => onPick(row.ref)}
              aria-label={`Pick ${row.ref}: ${row.issue.title}`}
              data-testid="issue-pick"
            />
          </span>
        ) : null,
    },
    {
      id: 'number',
      head: 'Issue',
      identity: true,
      min: 96,
      priority: 1,
      ...by('number'),
      value: (row) => (row.kind === 'issue' ? row.issue.number : undefined),
      cell: (row) =>
        row.kind === 'repo' ? (
          dash
        ) : (
          <span className="font-mono text-meta text-ink">
            #{row.issue.number}
            <span className="sr-only">: {row.issue.title}</span>
          </span>
        ),
    },
    {
      id: 'title',
      head: 'Title',
      flex: true,
      min: 240,
      priority: 1,
      card: 'title',
      ...by('title'),
      value: (row) => (row.kind === 'issue' ? row.issue.title : row.repo.label),
      cell: (row) =>
        row.kind === 'repo' ? (
          <span className="flex min-w-0 flex-col gap-0.5" data-testid="repo-row-reason">
            <span className="break-words text-body text-ink-muted">
              {repoRowReason(row.repo, filteredOut(row.repo, filter))}
            </span>
            {row.repo.detail && (
              <span className="break-words text-meta text-ink-faint" data-testid="repo-row-detail">
                {row.repo.detail}
              </span>
            )}
          </span>
        ) : (
          // Inline, never a block: on a phone's card this cell is the row's
          // link, and a block inside the inline `<a>` leaves the link's own box
          // off its words — a tap at its middle lands on the card instead.
          <span className="break-words text-body text-ink">{row.issue.title}</span>
        ),
    },
    {
      id: 'severity',
      head: 'Severity',
      min: 128,
      priority: 2,
      card: 'meta',
      ...by('severity'),
      value: (row) => (row.kind === 'issue' ? triageOfIssue(row.issue).severity : undefined),
      cell: (row) =>
        row.kind === 'repo' ? (
          dash
        ) : (
          <OpsStatus vocab="issue-severity" word={triageOfIssue(row.issue).severity} />
        ),
    },
    {
      id: 'plan',
      head: 'Plan status',
      min: 168,
      priority: 2,
      card: 'meta',
      ...by('status'),
      value: (row) => (row.kind === 'issue' ? triageOfIssue(row.issue).plan.state : undefined),
      cell: (row) => {
        if (row.kind === 'repo') return dash;
        const triage = triageOfIssue(row.issue);
        const where = planWhere(triage);
        // A row that wraps, not a stack: in the table's 168 px the plan's name
        // falls under its status by itself, and on a card's meta line it
        // stays beside it rather than standing that line on two.
        return (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <OpsStatus vocab="issue-plan" word={triage.plan.state} />
            {where && (
              <span className="min-w-0 break-words text-meta text-ink-muted" data-testid="plan-where">
                {where}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: 'category',
      head: 'Category',
      min: 144,
      everything: true,
      ...by('category'),
      value: (row) => (row.kind === 'issue' ? triageOfIssue(row.issue).category : undefined),
      cell: (row) =>
        row.kind === 'repo' ? (
          dash
        ) : (
          <OpsStatus vocab="issue-category" word={triageOfIssue(row.issue).category} />
        ),
    },
    {
      id: 'repo',
      head: 'Repository',
      min: 160,
      priority: 3,
      value: (row) => row.repo.label,
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5" title={repoStateWords(row.repo)}>
          <Mono value={row.repo.label} className="min-w-0 break-words text-ink" />
          {(row.kind === 'repo' || row.repo.state !== 'fresh') && (
            <span className="break-words text-meta text-ink-muted" data-testid="repo-freshness">
              {repoStateWords(row.repo)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'updated',
      head: 'Updated',
      min: 128,
      priority: 2,
      card: 'meta',
      ...by('updated'),
      value: (row) => (row.kind === 'issue' ? row.issue.updatedAt : undefined),
      cell: (row) => {
        if (row.kind === 'repo') return <span className="text-meta text-ink-muted">{ageLine(row.repo)}</span>;
        const at = Date.parse(row.issue.updatedAt);
        return Number.isNaN(at) ? (
          <span className="text-meta text-ink-muted">{row.issue.updatedAt}</span>
        ) : (
          <RelativeTime at={at} live={false} className="text-meta text-ink-muted" />
        );
      },
    },
    {
      id: 'labels',
      head: 'Labels',
      min: 176,
      everything: true,
      ...by('labels'),
      value: (row) => (row.kind === 'issue' ? row.issue.labels.join(', ') : undefined),
      // A label is whatever a maintainer typed, so it breaks where it must.
      cell: (row) =>
        row.kind === 'repo' || row.issue.labels.length === 0 ? (
          dash
        ) : (
          <span className="min-w-0 break-words text-meta text-ink-muted">{row.issue.labels.join(', ')}</span>
        ),
    },
    {
      id: 'assignee',
      head: 'Assignees',
      min: 136,
      everything: true,
      ...by('assignee'),
      value: (row) => (row.kind === 'issue' ? row.issue.assignees.join(', ') : undefined),
      cell: (row) =>
        row.kind === 'repo' ? (
          dash
        ) : row.issue.assignees.length === 0 ? (
          <span className="text-meta text-ink-faint">Unassigned</span>
        ) : (
          <span className="min-w-0 break-words text-meta text-ink-muted">
            {row.issue.assignees.join(', ')}
          </span>
        ),
    },
    {
      id: 'author',
      head: 'Opened by',
      min: 136,
      everything: true,
      ...by('author'),
      value: (row) => (row.kind === 'issue' ? row.issue.author : undefined),
      cell: (row) =>
        row.kind === 'repo' || !row.issue.author ? (
          dash
        ) : (
          <span className="min-w-0 break-words text-meta text-ink-muted">{row.issue.author}</span>
        ),
    },
    {
      id: 'state',
      head: 'State',
      min: 112,
      everything: true,
      value: (row) => (row.kind === 'issue' ? (isOpenIssue(row.issue) ? 'open' : 'closed') : undefined),
      cell: (row) =>
        row.kind === 'repo' ? (
          dash
        ) : (
          <span className="text-meta text-ink-muted" title={`GitHub says ${row.issue.state}.`}>
            {isOpenIssue(row.issue) ? 'Open' : 'Closed'}
          </span>
        ),
    },
    {
      id: 'filed',
      head: 'Filed by',
      min: 176,
      everything: true,
      value: (row) =>
        row.kind === 'issue' && row.issue.provenance
          ? `${row.issue.provenance.slug} P${row.issue.provenance.phase}`
          : undefined,
      cell: (row) =>
        row.kind === 'issue' && row.issue.provenance ? (
          <span
            className="min-w-0 wrap-anywhere text-meta text-ink-muted"
            data-testid="provenance"
            title={`Filed by a session of ${row.issue.provenance.slug}, phase ${row.issue.provenance.phase}`}
          >
            {row.issue.provenance.slug} P{row.issue.provenance.phase}
          </span>
        ) : (
          dash
        ),
    },
  ];
  return filter.repo ? all.filter((column) => column.id !== 'repo') : all;
}

/* ---------------- what a row reveals in place ---------------- */

/**
 * The first lines of a body, as TEXT. `whitespace-pre-wrap` keeps the author's
 * line breaks and `break-words` keeps a pasted stack trace inside its column.
 * An absent body is not an empty one: bodies are fetched within a budget.
 */
export function BodyPreview({ issue, lines = 3 }: { issue: Issue; lines?: number }) {
  if (issue.body === undefined) {
    return (
      <p className="max-w-(--measure) text-meta text-ink-muted">
        No body cached yet: bodies are fetched within a budget during a refresh, which is not the same as an
        issue with nothing written in it.
      </p>
    );
  }
  const text = issue.body.split('\n').slice(0, lines).join('\n').trim();
  if (!text) return <p className="text-meta text-ink-muted">This issue has an empty body.</p>;
  return (
    <p className="min-w-0 max-w-(--measure) break-words whitespace-pre-wrap text-body text-ink-muted">
      {text}
      {(issue.body.split('\n').length > lines || issue.bodyTruncated) && (
        <span className="text-ink-faint"> …</span>
      )}
    </p>
  );
}

/**
 * What can be done to one repository: ask it again, or open a new issue on
 * GitHub — a LINK, never a form: this console files nothing on anybody's
 * behalf from here. `rate-limited` is the one refusal shown rather than tried.
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
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {onRefresh && repo.nameWithOwner && (
          <Button
            size="sm"
            disabled={refreshing || held}
            onClick={() => onRefresh(repo.key)}
            title={
              held
                ? `GitHub is rate-limiting this token; a refresh will not run before ${new Date(
                    repo.retryAt!,
                  ).toLocaleTimeString()}.`
                : `Ask GitHub for ${repo.nameWithOwner} again.`
            }
          >
            Refresh {repo.label}
          </Button>
        )}
        {repo.nameWithOwner && (
          <Button size="sm" variant="ghost" asChild>
            <a
              href={`https://github.com/${repo.nameWithOwner}/issues/new`}
              target="_blank"
              rel="noreferrer noopener"
            >
              New issue on GitHub
            </a>
          </Button>
        )}
      </div>
      {held && (
        <p className="text-meta text-ink-muted" data-testid="repo-backed-off">
          GitHub is rate-limiting this token: a refresh waits until{' '}
          {new Date(repo.retryAt!).toLocaleTimeString()}.
        </p>
      )}
      {repo.truncated && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="repo-truncated">
          This repository holds more issues than the desk reads at once: the newest{' '}
          {plural(repo.issues.length, 'issue')} are shown.
        </p>
      )}
    </div>
  );
}

/** A row's detail, revealed in place: the body's first lines and GitHub's page, or the repository's acts. */
export function IssueRowDetail({
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
      <div className="flex min-w-0 flex-col gap-2">
        <p className="max-w-(--measure) text-meta text-ink-muted">
          {row.repo.nameWithOwner ? (
            <>
              <Mono value={row.repo.nameWithOwner} />, scope token <Mono value={row.repo.scopeToken} />
            </>
          ) : (
            'No GitHub origin. This repository is still part of the estate; it simply has no issue tracker to read.'
          )}
        </p>
        <RepoActions repo={row.repo} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing} />
      </div>
    );
  }
  const href = safeHttpUrl(row.issue.url);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <BodyPreview issue={row.issue} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2"
          >
            Open on GitHub
          </a>
        ) : (
          <span className="wrap-anywhere text-ink-muted" data-testid="issue-url-refused">
            Its address is not http(s), so it is shown rather than linked: {row.issue.url}
          </span>
        )}
        {row.ref && <Mono value={row.ref} className="wrap-anywhere" />}
      </div>
    </div>
  );
}
