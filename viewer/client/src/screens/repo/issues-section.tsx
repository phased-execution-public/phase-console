/**
 * The Issues desk — every issue of the repositories this console stands on,
 * read with its category, severity and plan status, and turned into work
 * (7.0, quiet-console phase 18).
 *
 * ```
 * [Find an issue…]  Filter 2  Sort  Updated                    ⋯  Everything
 * 3 repositories. Assembled at 14:02.  Refresh every repository
 * ☐  #41  The phone's chip overlaps its icon   ● High   ● Needs a plan   2 h ago
 * ```
 *
 * ## The address is the state
 *
 * `#/repo/issues?repo=&state=&label=&q=&filed=&category=&severity=&plan=&sort=&dir=&issue=`
 * — the filters, the order and the inspected issue. A narrowed desk is
 * quotable, survives a reload and pastes into a message; the alternative for
 * "look at these three" is a screenshot, which is the one form of evidence
 * nobody can check. `?repo=` is the same parameter the git sections read, in
 * the same key vocabulary, so a link out of a narrowed desk into Branches still
 * means the repository the reader was looking at; the choices come from the
 * issue estate, which holds the repositories with a tracker.
 *
 * ## Refresh is a visible act with a visible outcome
 *
 * The read never asks GitHub — the desk shows its data at whatever age it has,
 * and the age is on screen. So a console nobody has asked shows its
 * repositories as not asked yet, beside the button that asks. The button's
 * scope is the filter's: one repository when one is picked, every askable one
 * otherwise, and its words say which.
 *
 * ## Picking is how issues become work
 *
 * A pick is a ref (`owner/repo#12`), reconciled against the payload it was made
 * from: a refresh can drop an issue, and the server refuses a ref it does not
 * hold, so a pick that left is NAMED rather than silently sent or silently
 * dropped. The doors over the picks — author a plan (both editions), fix one,
 * hand them to the supervisor, solve with autopilot (Pro) — each say beside
 * them why they cannot be pressed now.
 */

import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { describeWord } from '@shared/status-model.js';
import {
  ISSUE_CATEGORIES,
  ISSUE_PLAN_STATES,
  ISSUE_REPOS_MAX,
  ISSUE_SEVERITY_WORDS,
  addedRepoKey,
  issueRepoName,
} from '@shared/issues-model.js';
import type { IssuesPayload, RepoIssues } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useIssueRepos, useIssues, useIssuesRefresh } from '@/data/repo';
import { clockTime, plural } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { useInspected } from '@/shell/panel/inspector-host';
import { useNavigate } from '@/shell/router';
import type { Route } from '@/shell/routes';
import { Button, Empty, Input, Label, useEverything } from '@/ui';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import { Grid } from '@/ui/grid/grid';
import { NativeSelect } from '@/ui/native-select';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { inspectIssue, issueKey, useAddressed, type IssueSubject } from './inspector';
import {
  DEFAULT_FILTER,
  ISSUE_SORT_IDS,
  IssueRowDetail,
  SELECTION_MAX,
  SORT_DEFAULT_DIR,
  backedOff,
  boardRows,
  deskHref,
  filterFrom,
  filtersInForce,
  findByRef,
  issueColumns,
  issueCount,
  issueRowKey,
  labelUniverse,
  livingRefs,
  nextSort,
  recordRef,
  repoStateWords,
  sortFrom,
  sortIssueRows,
  type IssueFilter,
  type IssueRow,
  type IssueSort,
  type IssueSortId,
} from './issues';
import { PanelChoices, ReadError, RowsLoading, reopens } from './parts';

/** The plan-from-issues dialog arrives when it is opened: the desk's readers mostly only read. */
const IssuesLaunchDialog = lazy(() =>
  import('./issues-launch').then((m) => ({ default: m.IssuesLaunchDialog })),
);

type IssueOnlyRow = Extract<IssueRow, { kind: 'issue' }>;

/* ---------------- the words ---------------- */

const STATE_CHOICES: readonly { id: IssueFilter['state']; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'Open and closed' },
];

/** What each order is called, and what its two directions mean. */
const SORT_WORDS: Readonly<Record<IssueSortId, { label: string; ascending: string; descending: string }>> = {
  updated: { label: 'Updated', ascending: 'Least recent first', descending: 'Most recent first' },
  number: { label: 'Number', ascending: 'Oldest first', descending: 'Newest first' },
  severity: { label: 'Severity', ascending: 'Mildest first', descending: 'Worst first' },
  status: { label: 'Plan status', ascending: 'Needs a plan first', descending: 'No plan first' },
  category: { label: 'Category', ascending: 'Bugs first', descending: 'Other first' },
  title: { label: 'Title', ascending: 'A to Z', descending: 'Z to A' },
  labels: { label: 'Labels', ascending: 'A to Z', descending: 'Z to A' },
  assignee: { label: 'Assignees', ascending: 'A to Z', descending: 'Z to A' },
  author: { label: 'Opened by', ascending: 'A to Z', descending: 'Z to A' },
};

/** The orders in the sort panel: the useful first, then the rest in the vocabulary's order. */
const SORT_CHOICES: readonly IssueSortId[] = [
  'updated',
  'severity',
  'status',
  'number',
  ...ISSUE_SORT_IDS.filter((id) => !['updated', 'severity', 'status', 'number'].includes(id)),
];

/** The estate in one sentence: how many repositories, and how many cannot answer. */
function estateWords(payload: IssuesPayload): string {
  const unknown = payload.repos.filter((r) => r.state === 'unknown').length;
  const stale = payload.repos.filter((r) => r.state === 'stale').length;
  const parts = [plural(payload.repos.length, 'repository', 'repositories')];
  if (stale) parts.push(`${stale} stale`);
  if (unknown) parts.push(`${unknown} not answering`);
  return `${parts.join(', ')}${payload.refreshing ? '; asking GitHub now' : ''}.`;
}

/* ---------------- the section ---------------- */

export default function IssuesSection({ route }: { route: Route }) {
  const navigate = useNavigate();
  const filter = useMemo(() => filterFrom(route.query), [route.query]);
  const sort = useMemo(() => sortFrom(route.query), [route.query]);
  const openRef = route.query.issue || undefined;
  const { data, isPending, error, refetch } = useIssues();
  const { data: state } = useConsoleState();
  const refresh = useIssuesRefresh();
  const saveRepos = useIssueRepos();
  const everything = useEverything('repo-issues');
  const phone = usePhone();
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [launching, setLaunching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // The search narrows the rows as it is typed, and reaches the address a
  // moment after typing stops — replacing, never pushing, so the back button
  // does not walk back through half-typed words.
  const [query, setQuery] = useState(filter.q ?? '');
  const written = useRef(filter.q ?? '');
  useEffect(() => {
    const said = filter.q ?? '';
    if (said === written.current) return;
    written.current = said;
    setQuery(said);
  }, [filter.q]);
  useEffect(() => {
    const want = query.trim();
    if (want === written.current) return;
    const timer = window.setTimeout(() => {
      written.current = want;
      navigate(deskHref(filter, sort, { q: want || undefined }), { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, filter, sort, navigate]);
  const searched = useMemo<IssueFilter>(() => {
    const { q: _said, ...rest } = filter;
    const words = query.trim();
    return words ? { ...rest, q: words } : rest;
  }, [filter, query]);

  const href = (patch: Parameters<typeof deskHref>[2]) => deskHref(filter, sort, patch);
  const labels = useMemo(() => labelUniverse(data), [data]);
  const rows = useMemo(() => sortIssueRows(boardRows(data, searched), sort), [data, searched, sort]);
  const scoped = filter.repo ? data?.repos.find((r) => r.key === filter.repo) : undefined;
  // A filter value the payload cannot satisfy is still IN FORCE, so it is
  // named — in its control and in a line — rather than silently ignored.
  const ghostRepo = filter.repo && data && !scoped ? filter.repo : undefined;
  const ghostLabel = filter.label && data && !labels.includes(filter.label) ? filter.label : undefined;
  const refreshing = refresh.isPending || Boolean(data?.refreshing);
  const ask = refresh.mutate;
  const onRefresh = useCallback((key: string) => ask(key), [ask]);

  /* The record the address names, in the panel. */
  const open = useMemo(() => (openRef ? findByRef(data, openRef) : undefined), [data, openRef]);
  const subject = useMemo<IssueSubject | undefined>(
    () => (open ? { repo: open.repo, issue: open.issue, onRefresh, refreshing } : undefined),
    [open, onRefresh, refreshing],
  );
  useAddressed(open ? issueKey(open.repo, open.issue) : undefined, subject, inspectIssue);
  const inspected = useInspected()?.key;

  /* The picks, reconciled against the payload they were made from. */
  const held = useMemo(() => new Set(livingRefs(data)), [data]);
  const outside = useMemo(() => new Set(livingRefs(data, 'added')), [data]);
  const live = picked.filter((ref) => held.has(ref));
  const outsidePicked = picked.filter((ref) => outside.has(ref));
  const dropped = picked.filter((ref) => !held.has(ref) && !outside.has(ref));
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const togglePick = useCallback(
    (ref: string) =>
      setPicked((prior) => (prior.includes(ref) ? prior.filter((r) => r !== ref) : [...prior, ref])),
    [],
  );
  const columns = useMemo(
    () => issueColumns({ filter: searched, sort, picked: pickedSet, onPick: togglePick }),
    [searched, sort, pickedSet, togglePick],
  );
  const pickable = rows.filter((row): row is IssueOnlyRow => row.kind === 'issue' && Boolean(row.ref));
  const allShown = pickable.length > 0 && pickable.every((row) => pickedSet.has(row.ref));

  const allowAgent = state?.allowAgent === true;
  const rootOpen = Boolean(state?.root?.path);
  const launchWhy = !allowAgent
    ? 'Authoring a plan needs --allow-agent: restart the console with it to author one from here.'
    : live.length === 0
      ? 'None of the picked issues can go on a ticket.'
      : live.length > SELECTION_MAX
        ? `A ticket carries at most ${SELECTION_MAX} issues, and ${live.length} are picked.`
        : undefined;

  /* The repositories added to the desk by their GitHub name. */
  const added = state?.prefs?.issueRepos ?? [];
  const scopedAdded = scoped?.kind === 'added' ? scoped : undefined;
  const addRepo = (raw: string) => {
    if (!data) return;
    const name = issueRepoName(raw);
    if (!name) {
      setAddError('An added repository is its GitHub owner/name, like octo/widget: not a URL or a path.');
      return;
    }
    // A name the desk already lists is a repository to go to, not one to add twice.
    const listed = data.repos.find((repo) => repo.nameWithOwner?.toLowerCase() === name.toLowerCase());
    if (listed || added.some((have) => have.toLowerCase() === name.toLowerCase())) {
      setAdding(false);
      navigate(href({ repo: listed?.key ?? addedRepoKey(name) }));
      return;
    }
    if (added.length >= ISSUE_REPOS_MAX) {
      setAddError(`The desk holds ${ISSUE_REPOS_MAX} added repositories: remove one to add another.`);
      return;
    }
    saveRepos.mutate([...added, name], {
      onSuccess: () => {
        setAdding(false);
        ask(addedRepoKey(name));
        navigate(href({ repo: addedRepoKey(name) }));
      },
    });
  };

  const narrowed = filtersInForce(searched) > 0 || Boolean(searched.q);
  const clear = () => {
    written.current = '';
    setQuery('');
    navigate(deskHref(DEFAULT_FILTER, undefined, {}));
  };
  const refreshHeld = Boolean(ghostRepo) || (scoped ? backedOff(scoped) : false);

  const verbs: ToolbarVerb[] = [
    {
      id: 'add-repo',
      label: 'Add a repository',
      onSelect: () => {
        setAddError(null);
        setAdding(true);
      },
    },
    ...(scopedAdded
      ? [
          {
            id: 'remove-repo',
            label: `Remove ${scopedAdded.label} from the desk`,
            onSelect: () => {
              const name = scopedAdded.label.toLowerCase();
              saveRepos.mutate(added.filter((have) => have.toLowerCase() !== name));
              navigate(href({ repo: undefined }));
            },
          },
        ]
      : []),
  ];

  const toolbar = (
    <Toolbar
      label="Issues"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: 'Find an issue',
        label: 'Find an issue by title, number, repository, label or person',
      }}
      filter={{
        active: filtersInForce(filter),
        panel: data ? (
          <IssueFilters
            payload={data}
            filter={filter}
            labels={labels}
            ghostRepo={ghostRepo}
            ghostLabel={ghostLabel}
            onChange={(patch) => navigate(href(patch))}
          />
        ) : (
          <p className="text-meta text-ink-muted">The filters arrive with the issues.</p>
        ),
      }}
      sort={{
        ...(sort ? { value: SORT_WORDS[sort.id].label } : {}),
        panel: <IssueOrder sort={sort} onChange={(next) => navigate(href({ sort: next }))} />,
      }}
      more={verbs}
      everything={everything}
      note={
        data ? (
          <>
            <span data-testid="estate-line">{estateWords(data)}</span>
            {/* A WALL CLOCK, not a subtraction: `data.at` is the server's
                instant and this browser's clock may disagree with it. */}
            <span data-testid="assembled-line">Assembled at {clockTime(data.at)}.</span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="issues-refresh"
              disabled={refreshing || refreshHeld}
              onClick={() => ask(filter.repo)}
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
              {refreshing
                ? 'Asking GitHub…'
                : ghostRepo
                  ? 'Refresh'
                  : scoped
                    ? `Refresh ${scoped.label}`
                    : 'Refresh every repository'}
            </Button>
            {narrowed && (
              <>
                <span className="tnum" aria-live="polite" data-testid="issues-filtered">
                  {rows.filter((row) => row.kind === 'issue').length} of {plural(issueCount(data), 'issue')}{' '}
                  shown.
                </span>
                <Button size="sm" variant="ghost" onClick={clear}>
                  Clear the filters
                </Button>
              </>
            )}
          </>
        ) : undefined
      }
    />
  );

  if (isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <RowsLoading label="Reading the issues" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {toolbar}
        <ReadError error={error} retry={() => void refetch()} />
      </div>
    );
  }
  if (!data) return null;

  const hrefOf = (row: IssueOnlyRow) => href({ issue: recordRef(row) });
  const subjectOf = (row: IssueOnlyRow): IssueSubject => ({
    repo: row.repo,
    issue: row.issue,
    onRefresh,
    refreshing,
  });

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="issues-desk">
      {toolbar}

      {(ghostRepo || ghostLabel || scopedAdded) && (
        <div className="flex min-w-0 max-w-(--measure) flex-col gap-1 text-meta text-ink-muted">
          {(ghostRepo || ghostLabel) && (
            <p data-testid="ghost-filter">
              {ghostRepo && <>No repository here is called {ghostRepo}. </>}
              {ghostLabel && <>No issue carries the label {ghostLabel}. </>}
              The filter still holds: Clear the filters takes it off.
            </p>
          )}
          {scopedAdded && (
            <p data-testid="outside-repo">
              {scopedAdded.label} is outside this console: read and refreshed here, planned from its own
              checkout. Remove it from the desk in the toolbar&rsquo;s ⋯ menu.
            </p>
          )}
        </div>
      )}

      {picked.length > 0 && (
        <div
          role="region"
          aria-label="Picked issues"
          data-testid="issue-selection"
          className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-raised px-(--tile-pad-x) py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className="tnum text-body font-medium text-ink"
              aria-live="polite"
              data-testid="selection-count"
            >
              {live.length} picked
            </span>
            <Button
              size="sm"
              variant="primary"
              data-testid="launch-open"
              className="h-auto shrink whitespace-normal"
              disabled={launchWhy !== undefined}
              aria-describedby={launchWhy ? 'launch-why' : undefined}
              onClick={() => setLaunching(true)}
            >
              Author a plan from {plural(live.length, 'issue')}
            </Button>
            {!allShown && pickable.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-auto shrink whitespace-normal"
                onClick={() =>
                  setPicked((prior) => [...new Set([...prior, ...pickable.map((row) => row.ref)])])
                }
              >
                Pick every issue shown ({pickable.length})
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-auto shrink whitespace-normal"
              onClick={() => setPicked([])}
            >
              Clear the picks
            </Button>
          </div>
          <PickNotes
            launchWhy={launchWhy}
            outside={outsidePicked}
            dropped={dropped}
          />
        </div>
      )}

      <Grid
        label="Issues"
        columns={columns}
        rows={rows}
        getRowKey={issueRowKey}
        rowHref={(row) => (row.kind === 'issue' ? hrefOf(row) : undefined)}
        rowProps={(row) =>
          row.kind === 'issue'
            ? {
                'data-testid': 'issue-row',
                'data-ref': recordRef(row),
                ...(inspected === issueKey(row.repo, row.issue) ? { 'aria-current': 'true' } : {}),
                ...reopens(hrefOf(row), () => inspectIssue(subjectOf(row))),
              }
            : { 'data-testid': 'issue-repo-row', 'data-repo': row.repo.key }
        }
        rowClassName={(row) =>
          row.kind === 'repo'
            ? 'bg-ground-deep/40'
            : inspected === issueKey(row.repo, row.issue)
              ? 'bg-surface-raised'
              : undefined
        }
        {...(sort ? { activeSort: sort.id } : {})}
        // On a phone the toolbar's Sort, in its View sheet, is the one order
        // control (phase 15's rule): a second row of order chips over the cards
        // would say it twice. A desk sorts by pressing a column's head.
        {...(phone
          ? {}
          : { onSort: (id: string) => navigate(href({ sort: nextSort(sort, id as IssueSortId) })) })}
        detail={(row) => <IssueRowDetail row={row} onRefresh={onRefresh} refreshing={refreshing} />}
        toolbar={false}
        everything={everything}
        tableId="repo-issues"
        virtual
        empty={
          filter.filed === 'sessions' ? (
            <Empty
              title="No issue here was filed by a session: a session files one only where its plan’s Issues line, its run or this console allows it."
              action={
                <Button size="sm" onClick={clear}>
                  Clear the filters
                </Button>
              }
            />
          ) : data.repos.length === 0 ? (
            <Empty title="This console reports no repository to read issues from." />
          ) : (
            <Empty
              title="No issue matches the filters."
              action={
                <Button size="sm" onClick={clear}>
                  Clear the filters
                </Button>
              }
            />
          )
        }
      />

      {launching && (
        <Suspense fallback={null}>
          <IssuesLaunchDialog
            issues={live}
            allowAgent={allowAgent}
            rootOpen={rootOpen}
            onClose={() => setLaunching(false)}
          />
        </Suspense>
      )}
      {adding && (
        <AddRepoDialog
          busy={saveRepos.isPending}
          error={addError}
          onAdd={addRepo}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/* ---------------- the pick band's notes ---------------- */

/**
 * A sentence with each command-line flag held on one line: at 360 a browser
 * breaks `--allow-agent` after its dashes, and a flag split in two is one
 * nobody can read off the screen and type.
 */
function FlagWords({ text }: { text: string }) {
  return (
    <>
      {text.split(/(--[a-z][a-z-]*)/).map((part, index) =>
        index % 2 ? (
          <span key={index} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Why a door over the picks cannot be pressed, and which picks will not be sent — in words, never a silent grey. */
function PickNotes({
  launchWhy,
  outside,
  dropped,
}: {
  launchWhy: string | undefined;
  outside: readonly string[];
  dropped: readonly string[];
}) {
  const lines: { id: string; text: string }[] = [];
  if (launchWhy) lines.push({ id: 'launch-why', text: launchWhy });
  if (outside.length) {
    lines.push({
      id: 'selection-outside',
      text: `${plural(outside.length, 'picked issue')} from a repository outside this console: a plan here cannot take ${
        outside.length === 1 ? 'it, so it is' : 'them, so they are'
      } not sent.`,
    });
  }
  if (dropped.length) {
    lines.push({
      id: 'selection-dropped',
      text: `${plural(dropped.length, 'picked issue')} no longer in this console’s issues, and not sent: ${dropped.join(', ')}.`,
    });
  }
  if (!lines.length) return null;
  return (
    <ul className="flex min-w-0 max-w-(--measure) flex-col gap-0.5 text-meta text-ink-muted">
      {lines.map((line) => (
        <li key={line.id} id={line.id} data-testid={line.id} className="break-words">
          <FlagWords text={line.text} />
        </li>
      ))}
    </ul>
  );
}

/* ---------------- the filter and the order ---------------- */

/** One choice of a vocabulary as a select: every word in the words the status family paints it with. */
function WordSelect({
  label,
  every,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  every: string;
  value: string | undefined;
  options: readonly { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-meta font-normal text-ink-muted">
        {label}
      </Label>
      <NativeSelect
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="w-full max-w-full"
        data-testid={testId}
      >
        {/* The empty value is "no filter": a label or key may be any word, never an empty one. */}
        <option value="">{every}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

const vocabOptions = (vocab: 'issue-category' | 'issue-severity' | 'issue-plan', words: readonly string[]) =>
  words.map((word) => ({ value: word, label: describeWord(vocab, word).label }));

function IssueFilters({
  payload,
  filter,
  labels,
  ghostRepo,
  ghostLabel,
  onChange,
}: {
  payload: IssuesPayload;
  filter: IssueFilter;
  labels: readonly string[];
  ghostRepo: string | undefined;
  ghostLabel: string | undefined;
  onChange: (patch: Partial<IssueFilter>) => void;
}) {
  const id = useId();
  // No repository key can be `*`: the keys are `root`, a submodule's path or `github:<owner/name>`.
  const EVERY = '*';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-meta text-ink-muted">Repository</legend>
        <RadioGroup
          aria-label="Which repository"
          value={filter.repo ?? EVERY}
          onValueChange={(key) => onChange({ repo: key === EVERY ? undefined : key })}
          data-testid="issues-repo"
        >
          <RadioItem
            id={`${id}-every`}
            value={EVERY}
            label="Every repository"
            description={plural(payload.repos.length, 'repository', 'repositories')}
          />
          {payload.repos.map((repo: RepoIssues) => (
            <RadioItem
              key={repo.key}
              id={`${id}-${repo.key}`}
              value={repo.key}
              label={repo.label}
              description={repoStateWords(repo)}
            />
          ))}
          {/* A pasted `?repo=` naming nothing here is still IN FORCE, so the
              control says what it is set to rather than looking unset. */}
          {ghostRepo && (
            <RadioItem
              id={`${id}-ghost`}
              value={ghostRepo}
              label={ghostRepo}
              description="Not in this estate: no rows can match it."
            />
          )}
        </RadioGroup>
      </fieldset>
      <PanelChoices
        name="State"
        value={filter.state}
        options={STATE_CHOICES}
        onChange={(next) => onChange({ state: next })}
        testId="issues-state"
      />
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <WordSelect
          label="Severity"
          every="Every severity"
          value={filter.severity}
          options={vocabOptions('issue-severity', ISSUE_SEVERITY_WORDS)}
          onChange={(word) => onChange({ severity: word as IssueFilter['severity'] })}
          testId="issues-severity"
        />
        <WordSelect
          label="Plan status"
          every="Every plan status"
          value={filter.plan}
          options={vocabOptions('issue-plan', ISSUE_PLAN_STATES)}
          onChange={(word) => onChange({ plan: word as IssueFilter['plan'] })}
          testId="issues-plan"
        />
        <WordSelect
          label="Category"
          every="Every category"
          value={filter.category}
          options={vocabOptions('issue-category', ISSUE_CATEGORIES)}
          onChange={(word) => onChange({ category: word as IssueFilter['category'] })}
          testId="issues-category"
        />
        <WordSelect
          label="Label"
          every="Every label"
          value={filter.label}
          options={[
            ...labels.map((label) => ({ value: label, label })),
            // The same rule as the repository: a label nothing carries is still the filter.
            ...(ghostLabel ? [{ value: ghostLabel, label: `${ghostLabel}, which no issue carries` }] : []),
          ]}
          onChange={(label) => onChange({ label })}
          testId="issues-label"
        />
        <WordSelect
          label="Filed by"
          every="Anyone"
          value={filter.filed}
          options={[{ value: 'sessions', label: 'A session of this console' }]}
          onChange={(word) => onChange({ filed: word === 'sessions' ? 'sessions' : undefined })}
          testId="issues-filed"
        />
      </div>
    </div>
  );
}

function IssueOrder({
  sort,
  onChange,
}: {
  sort: IssueSort | undefined;
  onChange: (next: IssueSort | null) => void;
}) {
  const NONE = 'none';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PanelChoices
        name="Order the issues"
        value={sort?.id ?? NONE}
        options={[
          { id: NONE, label: 'As GitHub lists them', blurb: 'Newest first, repository by repository.' },
          ...SORT_CHOICES.map((id) => ({ id, label: SORT_WORDS[id].label })),
        ]}
        onChange={(id) => onChange(id === NONE ? null : nextSort(undefined, id as IssueSortId))}
        testId="issues-order"
      />
      {sort && (
        <PanelChoices
          name="Direction"
          value={sort.dir}
          options={[
            { id: SORT_DEFAULT_DIR[sort.id], label: SORT_WORDS[sort.id][SORT_DEFAULT_DIR[sort.id]] },
            {
              id: other(SORT_DEFAULT_DIR[sort.id]),
              label: SORT_WORDS[sort.id][other(SORT_DEFAULT_DIR[sort.id])],
            },
          ]}
          onChange={(dir) => onChange({ id: sort.id, dir })}
          testId="issues-direction"
        />
      )}
    </div>
  );
}

/** The other direction — an order's second choice. */
const other = (dir: IssueSort['dir']): IssueSort['dir'] => (dir === 'ascending' ? 'descending' : 'ascending');

/* ---------------- adding a repository ---------------- */

function AddRepoDialog({
  busy,
  error,
  onAdd,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  onAdd: (name: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Add a repository"
        description="Any GitHub repository, by its owner/name. The desk reads and refreshes its issues; no plan of this console can take them, because it has no checkout here."
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd(value);
          }}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={id}>Repository</Label>
            <Input
              id={id}
              value={value}
              placeholder="owner/name"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            {error && (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-meta text-ink-muted"
                data-testid="add-repo-error"
              >
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
              Add the repository
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
