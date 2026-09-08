/**
 * The Issues section — filters, the estate's own state, and the launch.
 *
 * ## The URL is the state, here as everywhere in this destination
 *
 * `#/repo/issues?repo=&state=&label=&q=&issue=` — the four filters and the open
 * inspector. A filtered board is quotable, survives a reload and pastes into a
 * message; the alternative for "look at these three" is a screenshot, which is
 * the one form of evidence nobody can check.
 *
 * `?repo=` is the SAME parameter the other five sections use for their target,
 * and deliberately so: an issues row and a git surface name a repository with
 * the same key vocabulary (`root`, or the root-relative submodule path), so a
 * link out of a filtered board into Branches still means the repository the
 * reader was looking at. What this section does NOT do is render the page's
 * `TargetPicker` — that list comes from `/api/repo/targets`, which also holds
 * linked worktrees and mounts, and none of those has an issue tracker. One
 * parameter, two option sets, each drawn from the list that can answer.
 *
 * ## Refresh is a visible act with a visible outcome
 *
 * The GET never fetches — a board renders at whatever age its data has, and
 * that age is on screen. So the first open of a console that has never been
 * asked is EMPTY and says so, pointing at the button. The button's scope is the
 * filter: with a repository picked it asks that one, otherwise every askable
 * one, and its label says which.
 */

import { useMemo, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { ViewProps } from '@/app/router';
import { navigate } from '@/app/router';
import {
  Badge,
  Button,
  Input,
  PageError,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/ui';
import type { Issue, IssuesPayload, RepoIssues } from '@/lib/api';
import { useConsoleState, useIssues, useIssuesRefresh } from '@/lib/queries';
import { clockTime } from '@/lib/format';
import {
  DEFAULT_FILTER,
  IssueBoard,
  RepoActions,
  SELECTION_MAX,
  ageLine,
  backedOff,
  boardRows,
  issueRef,
  labelUniverse,
  safeHttpUrl,
  type IssueFilter,
  type IssueRow,
} from './issues';
// The LAZY boundary, never `./issues-launch` — see that module's twin.
import { IssuesLaunchDialog } from './lazy-issues-launch';
import { RepoInspector } from './inspector';
import { repoHref } from './routes';

/**
 * The "no filter" option's value, and why every real option is PREFIXED.
 *
 * A Radix `Select` identifies its options by a string, and it forbids the empty
 * one — so "every repository" needs a sentinel. A bare `all` is not one: a
 * repository KEY or a GitHub LABEL may literally be `all`, and then the real
 * option and the sentinel are the same value. Measured on a live render with a
 * label named `all`: the trigger read "Every labelall" and picking the real one
 * CLEARED the filter, so that label could never be selected at all. The
 * round-1 ghost-option fix widened it — `?repo=all` produced
 * "Every repositoryall · not in this estate". (QA round 2, Low.)
 *
 * Prefixing every real value is what makes the collision impossible rather than
 * unlikely: `pick(x)` is `v:x`, which cannot equal `ANY` for any `x`.
 */
const ANY = 'all';
const pick = (value: string) => `v:${value}`;
const unpick = (value: string) => (value === ANY ? undefined : value.slice(2));

/** `all` is a word in the URL; the other two are the vocabulary's own. */
function filterFrom(query: Record<string, string | undefined>): IssueFilter {
  const state = query.state === 'closed' || query.state === 'all' ? query.state : DEFAULT_FILTER.state;
  return {
    state,
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.label ? { label: query.label } : {}),
    ...(query.q ? { q: query.q } : {}),
  };
}

/** A link to this section carrying one changed filter, and dropping the rest of the noise. */
function href(current: IssueFilter, patch: Partial<IssueFilter> & { issue?: string }): string {
  const next = { ...current, ...patch };
  return repoHref('issues', {
    repo: next.repo,
    // `open` is the default, so it is not written — a URL that states every
    // default is a URL nobody can read the interesting part of.
    state: next.state === DEFAULT_FILTER.state ? undefined : next.state,
    label: next.label,
    q: next.q,
    issue: patch.issue,
  });
}

/** The estate in one line: how many repositories, and how many cannot answer. */
function EstateLine({ payload }: { payload: IssuesPayload }) {
  const unknown = payload.repos.filter((r) => r.state === 'unknown');
  const stale = payload.repos.filter((r) => r.state === 'stale');
  return (
    <p className="text-2xs text-ink-faint" data-testid="estate-line">
      {payload.repos.length} repositor{payload.repos.length === 1 ? 'y' : 'ies'} in this estate
      {stale.length > 0 && ` · ${stale.length} stale`}
      {unknown.length > 0 && ` · ${unknown.length} could not be asked`}
      {payload.refreshing && ' · asking GitHub now'}
    </p>
  );
}

export default function IssuesSection({ route }: { route: ViewProps['route'] }) {
  const filter = useMemo(() => filterFrom(route.query), [route.query]);
  const openRef = route.query.issue;
  const { data, isPending, error, refetch } = useIssues();
  const { data: state } = useConsoleState();
  const refresh = useIssuesRefresh();
  const [selected, setSelected] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);

  const labels = useMemo(() => labelUniverse(data), [data]);
  const rows = useMemo(() => boardRows(data, filter), [data, filter]);
  const open = useMemo(() => (openRef ? findByRef(data, openRef) : undefined), [data, openRef]);
  const scoped = filter.repo ? data?.repos.find((r) => r.key === filter.repo) : undefined;
  // A filter value the payload cannot satisfy. It is still IN FORCE, so it is
  // named rather than silently ignored — in the control, and in a line.
  const ghostRepo = filter.repo && !scoped ? filter.repo : undefined;
  const ghostLabel = filter.label && !labels.includes(filter.label) ? filter.label : undefined;

  if (isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const toggle = (ref: string) =>
    setSelected((prior) => (prior.includes(ref) ? prior.filter((r) => r !== ref) : [...prior, ref]));

  const selectable = rows.filter((row): row is Extract<IssueRow, { kind: 'issue' }> =>
    Boolean(row.kind === 'issue' && row.ref),
  );
  const allShown = selectable.length > 0 && selectable.every((row) => selected.includes(row.ref));
  /*
   * The selection reconciled against the payload it was made from.
   *
   * A ref can leave: a refresh drops an issue, a repository goes `unknown`.
   * The server refuses a ref it does not hold — `400 no such issue in this
   * console's repositories` — so an unreconciled selection turns a click into a
   * refusal, which is the shape of defect round 1's High was. (QA round 2.)
   * The dropped ones are NAMED rather than silently discarded: nine selected
   * and six sent is exactly the quiet narrowing `agent.ts` refuses a ticket to
   * prevent.
   */
  const held = new Set(livingRefs(data));
  const live = selected.filter((ref) => held.has(ref));
  const dropped = selected.filter((ref) => !held.has(ref));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Repository</span>
          <Select
            value={filter.repo === undefined ? ANY : pick(filter.repo)}
            onValueChange={(value) => navigate(href(filter, { repo: unpick(value) }))}
          >
            <SelectTrigger className="min-w-44" aria-label="Repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every repository</SelectItem>
              {data.repos.map((repo) => (
                <SelectItem key={repo.key} value={pick(repo.key)}>
                  {repo.label}
                  {repo.state !== 'fresh' && <span className="text-ink-faint"> · {repo.state}</span>}
                </SelectItem>
              ))}
              {/* A pasted `?repo=` naming nothing here is still IN FORCE, so the
                  control has to say what it is set to. Without this option the
                  Select renders blank and the filter looks unset while it is
                  hiding every row. (QA round 1, M-3.) */}
              {ghostRepo && <SelectItem value={pick(ghostRepo)}>{ghostRepo} · not in this estate</SelectItem>}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>State</span>
          <Select
            value={filter.state}
            onValueChange={(value) => navigate(href(filter, { state: value as IssueFilter['state'] }))}
          >
            <SelectTrigger className="min-w-32" aria-label="State">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="all">Every state</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Label</span>
          <Select
            value={filter.label === undefined ? ANY : pick(filter.label)}
            onValueChange={(value) => navigate(href(filter, { label: unpick(value) }))}
          >
            <SelectTrigger className="min-w-40" aria-label="Label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every label</SelectItem>
              {labels.map((label) => (
                <SelectItem key={label} value={pick(label)}>
                  {label}
                </SelectItem>
              ))}
              {/* Same rule as the repository above: a label nothing carries is
                  still the filter in force. */}
              {ghostLabel && (
                <SelectItem value={pick(ghostLabel)}>{ghostLabel} · no issue carries it</SelectItem>
              )}
            </SelectContent>
          </Select>
        </label>

        {/* A form, not a keystroke listener: typing into the address bar on
            every character fills the back stack with half-typed words. */}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
            navigate(href(filter, { q: value || undefined }));
          }}
        >
          <label className="flex flex-col gap-1 text-2xs text-ink-muted">
            <span>Search</span>
            <Input
              name="q"
              defaultValue={filter.q ?? ''}
              placeholder="title, #number, repository"
              className="w-52"
            />
          </label>
          <Button size="sm" type="submit" variant="ghost">
            Filter
          </Button>
        </form>

        {(filter.repo || filter.label || filter.q || filter.state !== DEFAULT_FILTER.state) && (
          <Button size="sm" variant="ghost" onClick={() => navigate(repoHref('issues'))}>
            Clear
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            /*
             * Three refusals, and the middle one is the interesting one.
             * `rate-limited` is the ONE failure the server's own backoff
             * enforces against a forced refresh, so a live-looking button here
             * would do nothing and say nothing — the same "button that lies"
             * the row-level control already refuses. A `?repo=` naming no
             * repository is the third: there is nothing to ask.
             * (QA round 1, M-1 and M-3.)
             */
            disabled={
              refresh.isPending ||
              data.refreshing ||
              Boolean(ghostRepo) ||
              (scoped ? backedOff(scoped) : false)
            }
            onClick={() => refresh.mutate(filter.repo)}
            title={
              ghostRepo
                ? `No repository here is called ${ghostRepo}, so there is nothing to ask.`
                : scoped && backedOff(scoped)
                  ? `GitHub is rate-limiting this token; a refresh will not run before ${new Date(
                      scoped.retryAt!,
                    ).toLocaleTimeString()}.`
                  : scoped
                    ? `Ask GitHub for ${scoped.nameWithOwner ?? scoped.label} again.`
                    : 'Ask GitHub for every repository that has a GitHub origin.'
            }
          >
            <RefreshCw size={14} aria-hidden />
            {ghostRepo ? 'Refresh' : scoped ? `Refresh ${scoped.label}` : 'Refresh all'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <EstateLine payload={data} />
        {/* A WALL CLOCK, not a subtraction: `data.at` is the server's instant
            and `Date.now()` is this browser's, so their difference is the clock
            skew as well as the age — the very arithmetic `ageLine` refuses.
            Formatting one instant in the reader's own zone says nothing it
            cannot know. (QA round 1, L-4.) */}
        <p className="text-2xs text-ink-faint" data-testid="assembled-line">
          assembled at {clockTime(data.at)}
        </p>
      </div>

      {(ghostRepo || ghostLabel) && (
        <p className="text-2xs text-ink-muted" data-testid="ghost-filter">
          {ghostRepo && (
            <>
              No repository here is called <code className="font-mono">{ghostRepo}</code>.{' '}
            </>
          )}
          {ghostLabel && (
            <>
              No issue carries the label <code className="font-mono">{ghostLabel}</code>.{' '}
            </>
          )}
          The filter is still in force — Clear takes it off.
        </p>
      )}

      {/* The bar survives a filter that leaves nothing selectable: a selection
          that exists with no way to launch or clear it is a dead end, and the
          refs are still going to the ticket. (QA round 1, L-5.) */}
      {(selectable.length > 0 || selected.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-rule bg-surface px-2 py-1.5">
          {/* `[@media(hover:hover)]:sm:min-h-0`, not `sm:min-h-0` — the same
              correction `issues.tsx:345` spells out. A plain `sm:` release
              drops the floor at a WIDTH, so a touch tablet at 768 kept the
              16 px native box as its only way to select every issue — the space
              is load-bearing: `theme.test.ts`'s stray-breakpoint sweep reads raw
              text, so a bare `<digits>px` anywhere after an `@media` mention in
              the same comment reads as a breakpoint. The
              comment below would have been false above `sm`. A mouse still
              gets the compact bar. (QA round 2, L1.) */}
          <label className="flex min-h-(--tap-min) items-center gap-2 text-2xs text-ink-muted [@media(hover:hover)]:sm:min-h-0">
            <input
              type="checkbox"
              disabled={selectable.length === 0}
              checked={allShown}
              onChange={() =>
                setSelected((prior) =>
                  allShown
                    ? prior.filter((ref) => !selectable.some((row) => row.ref === ref))
                    : [...new Set([...prior, ...selectable.map((row) => row.ref)])],
                )
              }
              aria-label="Select every issue shown"
              // No `tap-area` here, and that is not an oversight. This is a
              // NATIVE `<input type="checkbox">` — a replaced element, on which
              // generated content is undefined: Blink does render the
              // pseudo-element (measured 44×44, all four corners hit), Gecko
              // does not, and a class that asserts a guarantee the element
              // cannot make on its own is a class that gets copied. The floor
              // is the enclosing `<label>`, which is `min-h-(--tap-min)` under
              // every coarse pointer and wraps the whole word as one target.
              className="size-4 accent-[var(--accent)]"
            />
            Select every issue shown ({selectable.length})
          </label>
          <span className="text-2xs text-ink-faint" data-testid="selection-count">
            {live.length} selected
            {live.length > SELECTION_MAX && ` · ${SELECTION_MAX} is the ticket’s ceiling`}
          </span>
          {dropped.length > 0 && (
            <span className="text-2xs text-ink-faint" data-testid="selection-dropped">
              {dropped.length} no longer in this console’s issues and will not be sent:{' '}
              <code className="font-mono">{dropped.join(', ')}</code>
            </span>
          )}
          {selected.length > 0 && (
            <>
              <Button
                size="sm"
                variant="action"
                disabled={state?.allowAgent !== true || live.length === 0 || live.length > SELECTION_MAX}
                onClick={() => setLaunching(true)}
              >
                <Sparkles size={14} aria-hidden /> Author a plan from {live.length} issue
                {live.length === 1 ? '' : 's'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            </>
          )}
          {state?.allowAgent !== true && (
            <span className="text-2xs text-ink-faint" data-testid="launch-flag-note">
              Authoring a plan needs <code className="font-mono">--allow-agent</code>.
            </span>
          )}
        </div>
      )}

      <IssueBoard
        payload={data}
        filter={filter}
        selected={new Set(selected)}
        onToggle={toggle}
        onOpen={(row) => navigate(href(filter, { issue: row.ref || `${row.repo.key}#${row.issue.number}` }))}
        onRefresh={(key) => refresh.mutate(key)}
        refreshing={refresh.isPending || data.refreshing}
      />

      {open && (
        <IssueInspector
          repo={open.repo}
          issue={open.issue}
          onClose={() => navigate(href(filter, {}))}
          onRefresh={(key) => refresh.mutate(key)}
          refreshing={refresh.isPending || data.refreshing}
        />
      )}

      {launching && (
        <IssuesLaunchDialog
          issues={live}
          allowAgent={state?.allowAgent === true}
          rootOpen={Boolean(state?.root?.path)}
          onClose={() => setLaunching(false)}
        />
      )}
    </div>
  );
}

/** Every ref the payload can still resolve — what a ticket may name. */
function livingRefs(payload: IssuesPayload | undefined): string[] {
  const out: string[] = [];
  for (const repo of payload?.repos ?? []) {
    for (const issue of repo.issues) {
      const ref = issueRef(repo, issue);
      if (ref) out.push(ref);
    }
  }
  return out;
}

/** The row a `?issue=` names, by ref — or by `<key>#<number>` where there is no ref. */
function findByRef(
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

/**
 * L2 — the whole issue, and L3 under it.
 *
 * The body is rendered as TEXT inside a `<pre>`: it came from a stranger, and
 * markdown here would be a renderer executing somebody else's document on a
 * page that also holds a button which starts an agent. `whitespace-pre-wrap`
 * keeps the author's own line breaks without giving up wrapping.
 */
export function IssueInspector({
  repo,
  issue,
  onClose,
  onRefresh,
  refreshing,
}: {
  repo: RepoIssues;
  issue: Issue;
  onClose: () => void;
  onRefresh?: (repoKey: string) => void;
  refreshing: boolean;
}) {
  const ref = issueRef(repo, issue);
  return (
    <RepoInspector
      open
      onClose={onClose}
      title={issue.title}
      description={
        <span className="font-mono text-2xs">
          {ref ?? `${repo.label}#${issue.number}`} · {ageLine(repo)}
        </span>
      }
      meta={
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={issue.state.toUpperCase() === 'CLOSED' ? 'neutral' : 'ok'}>
            {issue.state.toLowerCase()}
          </Badge>
          {issue.labels.map((label) => (
            <Badge key={label} tone="neutral">
              {label}
            </Badge>
          ))}
        </span>
      }
      record={issue}
    >
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
          <dt className="uppercase tracking-wide text-ink-muted">Repository</dt>
          <dd className="min-w-0 break-words font-mono">{repo.nameWithOwner ?? repo.label}</dd>
          <dt className="uppercase tracking-wide text-ink-muted">Scope token</dt>
          <dd className="min-w-0 break-words font-mono">{repo.scopeToken}</dd>
          <dt className="uppercase tracking-wide text-ink-muted">Assignees</dt>
          <dd className="min-w-0 break-words">{issue.assignees.join(', ') || 'unassigned'}</dd>
          <dt className="uppercase tracking-wide text-ink-muted">Updated</dt>
          <dd className="min-w-0 break-words">{issue.updatedAt}</dd>
        </dl>

        <div>
          <p className="text-2xs uppercase tracking-wide text-ink-muted">Body</p>
          {issue.body === undefined ? (
            <p className="mt-1 text-2xs text-ink-faint">
              No body cached. Bodies are fetched within a budget during a refresh — this one has not been
              asked for yet, which is not the same as an issue with nothing written in it.
            </p>
          ) : (
            <pre
              data-testid="issue-body"
              className="mt-1 min-w-0 break-words whitespace-pre-wrap font-mono text-2xs text-ink-muted"
            >
              {issue.body}
            </pre>
          )}
          {issue.bodyTruncated && (
            <p className="mt-1 text-2xs text-ink-faint" data-testid="issue-body-truncated">
              Cut at the server’s byte ceiling — the rest is on GitHub.
            </p>
          )}
        </div>

        <RepoActions repo={repo} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing} />
        {safeHttpUrl(issue.url) ? (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-2xs break-all text-action hover:underline"
          >
            {issue.url}
          </a>
        ) : (
          <span className="text-2xs break-all text-ink-faint" data-testid="inspector-url-refused">
            {issue.url}
          </span>
        )}
      </div>
    </RepoInspector>
  );
}
