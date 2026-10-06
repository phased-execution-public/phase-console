/**
 * The Issues section — filters, the estate's own state, and the launch.
 *
 * ## The URL is the state, here as everywhere in this destination
 *
 * `#/repo/issues?repo=&state=&label=&q=&filed=&issue=` — the five filters and
 * the open inspector (`filed=sessions`, phase 12, keeps the issues a session of
 * this console filed). A filtered board is quotable, survives a reload and
 * pastes into a message; the alternative for "look at these three" is a screenshot, which is
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
import { Plus, RefreshCw, Sparkles, X } from 'lucide-react';
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
import { useConsoleState, useIssues, useIssuesRefresh, useSavePrefs } from '@/lib/queries';
import { clockTime } from '@/lib/format';
import { describeWord } from '@shared/status-model.js';
import {
  ISSUE_CATEGORIES,
  ISSUE_PLAN_STATES,
  ISSUE_REPOS_MAX,
  ISSUE_SEVERITY_WORDS,
  addedRepoKey,
  issueRepoName,
} from '@shared/issues-model.js';
import {
  DEFAULT_FILTER,
  IssueBoard,
  RepoActions,
  SELECTION_MAX,
  SORT_DEFAULT_DIR,
  ageLine,
  backedOff,
  boardRows,
  deskHref,
  issueRef,
  labelUniverse,
  safeHttpUrl,
  sortFrom,
  wordOf,
  type IssueFilter,
  type IssueRow,
  type IssueSort,
  type IssueSortId,
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

/**
 * `all` is a word in the URL; the other two are the vocabulary's own. The
 * desk's three readings (control-tower phase 118) take only a word of their
 * own vocabulary — anything else is no filter, rather than a filter that hides
 * every row for a word nothing could ever carry.
 */
function filterFrom(query: Record<string, string | undefined>): IssueFilter {
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

/** A vocabulary's words as a Select's options, each in the words the status family paints it with. */
function wordOptions(vocab: 'issue-category' | 'issue-severity' | 'issue-plan', words: readonly string[]) {
  return words.map((word) => (
    <SelectItem key={word} value={pick(word)}>
      {describeWord(vocab, word).label}
    </SelectItem>
  ));
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
  const sort = useMemo(() => sortFrom(route.query), [route.query]);
  // One link builder for every control: the filters and the sort in force, one change over them.
  const href = (patch: Parameters<typeof deskHref>[2]) => deskHref(filter, sort, patch);
  const openRef = route.query.issue;
  const { data, isPending, error, refetch } = useIssues();
  const { data: state } = useConsoleState();
  const refresh = useIssuesRefresh();
  const savePrefs = useSavePrefs();
  const [selected, setSelected] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

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
  // A repository the operator ADDED is read here and planned nowhere: no plan
  // of this console can scope it, and the ticket door resolves only the
  // estate. Its picks stay picked — and are named rather than sent.
  const outside = new Set(livingRefs(data, 'added'));
  const live = selected.filter((ref) => held.has(ref));
  const outsidePicked = selected.filter((ref) => outside.has(ref));
  const dropped = selected.filter((ref) => !held.has(ref) && !outside.has(ref));
  const added = state?.prefs?.issueRepos ?? [];
  const scopedAdded = scoped?.kind === 'added' ? scoped : undefined;

  /** Write the added list, then fetch what was added — the next read lists it, the refresh fills it. */
  const saveAdded = (next: string[], fetch?: string) =>
    savePrefs.mutate(
      { issueRepos: next },
      {
        onSuccess: () => {
          if (fetch) {
            refresh.mutate(addedRepoKey(fetch));
            navigate(href({ repo: addedRepoKey(fetch) }));
          } else {
            void refetch();
          }
        },
      },
    );
  const addRepo = (raw: string) => {
    const name = issueRepoName(raw);
    if (!name) {
      setAdding('An added repository is GitHub’s owner/name — octo/widget, not a URL or a path.');
      return;
    }
    // A name the desk already lists — the estate's own, or one added before —
    // is a repository to go to, not one to add twice.
    const listed = data.repos.find((repo) => repo.nameWithOwner?.toLowerCase() === name.toLowerCase());
    if (listed || added.some((have) => have.toLowerCase() === name.toLowerCase())) {
      setAdding(null);
      navigate(href({ repo: listed?.key ?? addedRepoKey(name) }));
      return;
    }
    if (added.length >= ISSUE_REPOS_MAX) {
      setAdding(`The desk holds ${ISSUE_REPOS_MAX} added repositories — remove one to add another.`);
      return;
    }
    setAdding(null);
    saveAdded([...added, name], name);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Repository</span>
          <Select
            value={filter.repo === undefined ? ANY : pick(filter.repo)}
            onValueChange={(value) => navigate(href({ repo: unpick(value) }))}
          >
            <SelectTrigger className="min-w-44" aria-label="Repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every repository</SelectItem>
              {data.repos.map((repo) => (
                <SelectItem key={repo.key} value={pick(repo.key)}>
                  {repo.label}
                  {repo.kind === 'added' && <span className="text-ink-faint"> · outside this console</span>}
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
            onValueChange={(value) => navigate(href({ state: value as IssueFilter['state'] }))}
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
            onValueChange={(value) => navigate(href({ label: unpick(value) }))}
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

        {/* Who filed it (phase 12): everyone, or only the sessions of this
            console — the issues carrying a provenance, which is also what the
            chip on each such row renders. Two options, so the sentinel trick
            the other controls need is not needed here. */}
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Filed by</span>
          <Select
            value={filter.filed ?? 'anyone'}
            onValueChange={(value) =>
              navigate(href({ filed: value === 'sessions' ? 'sessions' : undefined }))
            }
          >
            <SelectTrigger className="min-w-32" aria-label="Filed by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anyone">Anyone</SelectItem>
              <SelectItem value="sessions">Sessions</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {/* The desk's three readings (control-tower phase 118): what kind of
            issue, how bad, and where it stands in a plan — each one word of
            the vocabulary `shared/issues-model.js` derives, so a filter and a
            badge can never disagree about a word. */}
        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Category</span>
          <Select
            value={filter.category === undefined ? ANY : pick(filter.category)}
            onValueChange={(value) => navigate(href({ category: unpick(value) as IssueFilter['category'] }))}
          >
            <SelectTrigger className="min-w-36" aria-label="Category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every category</SelectItem>
              {wordOptions('issue-category', ISSUE_CATEGORIES)}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Severity</span>
          <Select
            value={filter.severity === undefined ? ANY : pick(filter.severity)}
            onValueChange={(value) => navigate(href({ severity: unpick(value) as IssueFilter['severity'] }))}
          >
            <SelectTrigger className="min-w-32" aria-label="Severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every severity</SelectItem>
              {wordOptions('issue-severity', ISSUE_SEVERITY_WORDS)}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-muted">
          <span>Plan status</span>
          <Select
            value={filter.plan === undefined ? ANY : pick(filter.plan)}
            onValueChange={(value) => navigate(href({ plan: unpick(value) as IssueFilter['plan'] }))}
          >
            <SelectTrigger className="min-w-36" aria-label="Plan status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every plan status</SelectItem>
              {wordOptions('issue-plan', ISSUE_PLAN_STATES)}
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
            navigate(href({ q: value || undefined }));
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

        {(filter.repo ||
          filter.label ||
          filter.q ||
          filter.filed ||
          filter.category ||
          filter.severity ||
          filter.plan ||
          sort ||
          filter.state !== DEFAULT_FILTER.state) && (
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

      {/* The repositories beyond the estate (control-tower phase 118): any
          GitHub `owner/name` the operator adds is read and refreshed here,
          remembered in `prefs.issueRepos`, and marked outside this console —
          it has no checkout here, so no plan of this console can take it. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            addRepo(String(new FormData(form).get('add') ?? ''));
            form.reset();
          }}
        >
          <label className="flex flex-col gap-1 text-2xs text-ink-muted">
            <span>Add a repository</span>
            <Input
              name="add"
              aria-label="Add a repository"
              aria-describedby={adding ? 'add-repo-error' : undefined}
              placeholder="owner/name"
              className="w-48"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button size="sm" type="submit" variant="ghost" disabled={savePrefs.isPending}>
            <Plus size={14} aria-hidden /> Add
          </Button>
        </form>
        {adding && (
          <p id="add-repo-error" className="self-center text-2xs text-ink-muted" data-testid="add-repo-error">
            {adding}
          </p>
        )}
        {scopedAdded && (
          <p
            className="flex flex-wrap items-center gap-2 self-center text-2xs text-ink-muted"
            data-testid="outside-repo"
          >
            <span>
              <code className="font-mono">{scopedAdded.label}</code> is outside this console: read and
              refreshed here, planned from its own.
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${scopedAdded.label} from the desk`}
              disabled={savePrefs.isPending}
              onClick={() => {
                saveAdded(added.filter((name) => name.toLowerCase() !== scopedAdded.label.toLowerCase()));
                navigate(href({ repo: undefined }));
              }}
            >
              <X size={14} aria-hidden /> Remove
            </Button>
          </p>
        )}
      </div>

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
          {outsidePicked.length > 0 && (
            <span className="text-2xs text-ink-faint" data-testid="selection-outside">
              {outsidePicked.length} from a repository outside this console — a plan here cannot take{' '}
              {outsidePicked.length === 1 ? 'it' : 'them'}, so{' '}
              {outsidePicked.length === 1 ? 'it is' : 'they are'} not sent.
            </span>
          )}
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
        onOpen={(row) => navigate(href({ issue: row.ref || `${row.repo.key}#${row.issue.number}` }))}
        onRefresh={(key) => refresh.mutate(key)}
        refreshing={refresh.isPending || data.refreshing}
        {...(sort ? { sort } : {})}
        onSort={(id: IssueSortId) => {
          // A press on the column in force reverses it; on any other, that
          // column in its own first direction.
          const next: IssueSort =
            sort?.id === id
              ? { id, dir: sort.dir === 'ascending' ? 'descending' : 'ascending' }
              : { id, dir: SORT_DEFAULT_DIR[id] };
          navigate(href({ sort: next }));
        }}
      />

      {open && (
        <IssueInspector
          repo={open.repo}
          issue={open.issue}
          onClose={() => navigate(href({}))}
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

/**
 * Every ref the payload can still resolve — what a ticket may name: the
 * estate's (`kind` absent), or the added repositories' (`'added'`), which no
 * ticket may name.
 */
function livingRefs(payload: IssuesPayload | undefined, kind?: 'added'): string[] {
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
          <dd className="min-w-0 break-words font-mono">
            {repo.kind === 'added' ? 'none — outside this console' : repo.scopeToken}
          </dd>
          <dt className="uppercase tracking-wide text-ink-muted">Author</dt>
          <dd className="min-w-0 break-words">{issue.author ?? 'not recorded'}</dd>
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
