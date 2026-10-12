/**
 * Repo's records in the panel — Inspect, the second door (7.0, quiet-console
 * phases 17 and 18; design.md principle 3).
 *
 * Six records, each handed to the shell whole: a commit, a branch, a working
 * tree, a settle, a changed file and an issue. Overview says every fact the row carried
 * and the ones it had no room for, in words; Actions goes where the record
 * leads (the commit's changes, the branch's walk, the tree's run); Raw is the
 * record as the server sent it, because this place shows the repository rather
 * than telling a reader about it.
 *
 * The address names the inspected record (`?commit=`, `?branch=`, `?tree=`,
 * `?event=`, `?path=`, `?issue=`), so a link opens it: `useAddressed` puts the record in
 * the panel when the address names it, refreshes it in place when its data
 * moves, and leaves the panel alone once a person has inspected something else.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { Issue, RepoBranch, RepoCheckout, RepoDiffFile, RepoIssues, RepoSettleEvent } from '@/data/api';
import { homePath, plural } from '@/lib/format';
import { inspect, useInspected } from '@/shell/panel/inspector-host';
import { phaseHref, planHref, runViewHref } from '@/shell/routes';
import { Button, KeyValue, Mono, RelativeTime } from '@/ui';
import { OpsStatus } from '@/ui/status';
import { RefName, refBlurb } from './graph';
import { RepoActions, ageLine, isOpenIssue, issueRef, planWhere, safeHttpUrl, triageOfIssue } from './issues';
import { decorateRef, type GraphRow } from './lanes';
import {
  ROLE_BLURB,
  SETTLE_BLURB,
  SOURCE_BLURB,
  attributionSentence,
  attributionWord,
  divergenceWords,
  runWords,
  settleKey,
  treeName,
} from './model';
import { repoSectionHref } from './routes';

/* ---------------- the address keeps the panel ---------------- */

/**
 * Keep the panel on the record the address names. The panel opens when the
 * address comes to name a record it did not name before; a refetch refreshes
 * the record in place without opening anything; and once the panel shows
 * another record the person chose, a refetch leaves it alone. `show` must be a
 * stable function and `subject` stable while its data is.
 */
export function useAddressed<T>(
  key: string | undefined,
  subject: T | undefined,
  show: (subject: T, options: { open: boolean }) => void,
): void {
  const shown = useInspected()?.key;
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!key || subject === undefined) return;
    const first = opened.current !== key;
    if (!first && shown !== key) return;
    opened.current = key;
    show(subject, { open: first });
  }, [key, subject, shown, show]);
}

/** Where a record leads, as links: the Actions tab of a record no registry verb acts on. */
export function RecordMoves({
  moves,
}: {
  moves: readonly (readonly [string, string] | false | null | undefined)[];
}) {
  const kept = moves.filter((m): m is readonly [string, string] => Boolean(m));
  if (!kept.length) return <p className="text-body text-ink-muted">Nothing here acts on this record.</p>;
  return (
    <ul className="flex min-w-0 flex-col items-start gap-1">
      {kept.map(([label, href]) => (
        <li key={label} className="min-w-0 max-w-full">
          <Button
            size="sm"
            variant="ghost"
            asChild
            className="h-auto max-w-full whitespace-normal text-start"
          >
            <a href={href}>{label}</a>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A moment twice: how long ago, and when — the second because "3 days ago" is not quotable. */
export function RecordWhen({ at }: { at: string | undefined }) {
  if (!at) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return <>{at}</>;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <RelativeTime at={ms} live={false} />
      <span className="text-meta text-ink-muted">{new Date(ms).toLocaleString()}</span>
    </span>
  );
}

export const recordRaw = (record: unknown): ReactNode => (
  <pre className="m-0 font-mono text-meta wrap-anywhere whitespace-pre-wrap">
    {JSON.stringify(record, null, 2)}
  </pre>
);

/* ---------------- a commit ---------------- */

export interface CommitSubject {
  row: GraphRow;
  repo: string | undefined;
  /** The walk it was found on — carried by the parents' links, which stay in it. */
  ref: string | undefined;
  all: boolean;
  trunk: string | undefined;
}

export const commitKey = (sha: string): string => `repo:commit:${sha}`;

export function inspectCommit(subject: CommitSubject, options: { open?: boolean } = {}): void {
  const { row, repo, ref, all, trunk } = subject;
  const { commit } = row;
  const at = (sha: string) =>
    repoSectionHref('history', { repo, ref, all: all ? 1 : undefined, commit: sha });
  const branches = commit.refs.map((name) => decorateRef(name, trunk)).filter((d) => d.kind !== 'tag');
  inspect(
    {
      key: commitKey(commit.sha),
      title: commit.subject,
      description: (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1">
          Committed by {commit.author} <RelativeTime at={commit.at} live={false} />
        </span>
      ),
      meta: (
        <>
          <Mono value={commit.sha} chars={12} copyable />
          {commit.parents.length > 1 && <span className="text-meta text-ink-muted">Merge</span>}
        </>
      ),
      overview: (
        <KeyValue
          items={[
            ['Commit', <Mono key="sha" value={commit.sha} copyable />],
            ['Author', commit.author],
            ['Committed', <RecordWhen key="at" at={commit.at} />],
            [
              'Parents',
              commit.parents.length === 0 ? (
                'None: a root commit.'
              ) : (
                <span key="parents" className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                  {commit.parents.map((p) => (
                    <a
                      key={p}
                      href={at(p)}
                      className="tap-line underline decoration-ink-faint underline-offset-2"
                    >
                      <Mono value={p} chars={7} className="text-ink" />
                    </a>
                  ))}
                </span>
              ),
            ],
            row.danglingParents.length > 0 && [
              'Outside this walk',
              <span key="dangling" data-testid="dangling-parents">
                {row.danglingParents.map((p) => p.slice(0, 7)).join(', ')}: beyond this walk&rsquo;s limit,
                not missing from the repository.
              </span>,
            ],
            commit.refs.length > 0 && [
              'Refs',
              <ul key="refs" className="flex min-w-0 flex-col gap-1.5">
                {commit.refs.map((name) => {
                  const decorated = decorateRef(name, trunk);
                  return (
                    <li key={name} className="flex min-w-0 flex-col">
                      <RefName decorated={decorated} />
                      <span className="text-meta text-ink-muted">{refBlurb(decorated)}</span>
                    </li>
                  );
                })}
              </ul>,
            ],
          ]}
        />
      ),
      actions: (
        <RecordMoves
          moves={[
            ['What this commit changed', repoSectionHref('changes', { repo, tip: commit.sha })],
            ...branches.map(
              (d) => [`Walk ${d.name} alone`, repoSectionHref('history', { repo, ref: d.name })] as const,
            ),
          ]}
        />
      ),
      raw: recordRaw(commit),
    },
    options,
  );
}

/* ---------------- a branch ---------------- */

export interface BranchSubject {
  branch: RepoBranch;
  repo: string | undefined;
  trunk: string | undefined;
  home: string | undefined;
}

export const branchKey = (repo: string | undefined, name: string): string =>
  `repo:branch:${repo ?? 'root'}:${name}`;

export function inspectBranch(subject: BranchSubject, options: { open?: boolean } = {}): void {
  const { branch, repo, trunk, home } = subject;
  const read = runWords(branch.run);
  const marks = [branch.current && 'Checked out', branch.trunk && 'Trunk'].filter(Boolean).join(', ');
  inspect(
    {
      key: branchKey(repo, branch.name),
      title: branch.name,
      ...(branch.subject ? { description: branch.subject } : {}),
      meta: (
        <>
          <Mono value={branch.short || branch.head} title={branch.head} />
          {marks && <span className="text-meta text-ink-muted">{marks}</span>}
        </>
      ),
      overview: (
        <KeyValue
          items={[
            ['Head', <Mono key="head" value={branch.head} copyable />],
            ['Upstream', branch.upstream ?? 'None: this branch is not tracked.'],
            ['Divergence', divergenceWords(branch)],
            ['Author', branch.author ?? '—'],
            ['Last commit', branch.at ? <RecordWhen key="at" at={branch.at} /> : '—'],
            read !== undefined && [
              'Run, from the name',
              `${read}: read from the branch name. Nothing here consulted a run record.`,
            ],
            [
              'Held by',
              branch.heldBy?.length ? (
                <ul key="held" className="flex min-w-0 flex-col gap-1">
                  {branch.heldBy.map((dir) => (
                    <li key={dir} className="min-w-0 truncate">
                      <Mono value={homePath(dir, home) ?? dir} title={dir} />
                    </li>
                  ))}
                </ul>
              ) : (
                'No working tree stands on it: from the checkout registry, which is evidence rather than a reading.'
              ),
            ],
          ]}
        />
      ),
      actions: (
        <RecordMoves
          moves={[
            ['Walk this branch', repoSectionHref('history', { repo, ref: branch.name })],
            Boolean(trunk) &&
              trunk !== branch.name && [
                `Changes against ${trunk}`,
                repoSectionHref('changes', { repo, base: trunk, tip: branch.name }),
              ],
            Boolean(branch.heldBy?.length) && [
              'The tree that holds it',
              repoSectionHref('trees', { repo, tree: branch.heldBy![0] }),
            ],
          ]}
        />
      ),
      raw: recordRaw(branch),
    },
    options,
  );
}

/* ---------------- a working tree ---------------- */

export interface TreeSubject {
  checkout: RepoCheckout;
  repo: string | undefined;
  home: string | undefined;
}

export const treeKey = (dir: string): string => `repo:tree:${dir}`;

export function inspectTree(subject: TreeSubject, options: { open?: boolean } = {}): void {
  const { checkout, repo, home } = subject;
  const run = checkout.via === 'record' ? checkout.run : undefined;
  inspect(
    {
      key: treeKey(checkout.dir),
      title: treeName(checkout, home),
      description: ROLE_BLURB[checkout.role],
      meta: (
        <>
          <OpsStatus vocab="checkout-role" word={checkout.role} />
          <span className="text-meta text-ink-muted">{attributionWord(checkout)}</span>
        </>
      ),
      overview: (
        <KeyValue
          items={[
            ['Directory', <Mono key="dir" value={checkout.dir} copyable />],
            ['Repository', checkout.repo === 'root' ? 'The repository root' : `Submodule ${checkout.repo}`],
            ['Role', <OpsStatus key="role" vocab="checkout-role" word={checkout.role} />],
            [
              'Standing on',
              checkout.branch ? (
                <Mono key="branch" value={checkout.branch} />
              ) : checkout.detached ? (
                <span key="detached">
                  <Mono value={checkout.detached} />: no branch, so it names where it stands, as its lock
                  does.
                </span>
              ) : (
                '—'
              ),
            ],
            ['Attributed', attributionSentence(checkout)],
            run !== undefined && [
              'Run',
              <OpsStatus
                key="live"
                vocab="presence"
                word={run.live ? 'live' : 'ended'}
                title={run.live ? 'A runner is driving this checkout now.' : `The run has stopped.`}
              />,
            ],
            [
              'Managed',
              checkout.managed
                ? 'Under the console’s own state directory: something it created.'
                : 'Outside the console’s state directory. It did not make this.',
            ],
            checkout.prunable && [
              'Prunable',
              'git still lists this checkout and its directory is gone. `git worktree prune` clears the listing.',
            ],
          ]}
        />
      ),
      actions: (
        <RecordMoves
          moves={[
            Boolean(checkout.branch) && [
              "This tree's branch",
              repoSectionHref('branches', { repo, branch: checkout.branch }),
            ],
            Boolean(checkout.branch) && [
              'Walk it',
              repoSectionHref('history', { repo, ref: checkout.branch }),
            ],
            run !== undefined && [`The run, ${run.slug}`, runViewHref(run.slug, 'history', run.runId)],
          ]}
        />
      ),
      raw: recordRaw(checkout),
    },
    options,
  );
}

/* ---------------- a settle ---------------- */

export const settleInspectKey = (e: RepoSettleEvent): string => `repo:settle:${settleKey(e)}`;

export function inspectSettle(event: RepoSettleEvent, options: { open?: boolean } = {}): void {
  const at = Date.parse(event.at);
  inspect(
    {
      key: settleInspectKey(event),
      title: event.phase === undefined ? event.slug : `${event.slug} P${event.phase}`,
      description: SETTLE_BLURB[event.kind] ?? event.kind,
      meta: (
        <>
          <OpsStatus vocab="settle" word={event.kind} />
          {Number.isFinite(at) && <RelativeTime at={at} live={false} className="text-meta text-ink-muted" />}
        </>
      ),
      overview: (
        <KeyValue
          items={[
            [
              'Plan',
              <a
                key="plan"
                href={planHref(event.slug)}
                className="tap-line underline decoration-ink-faint underline-offset-2"
              >
                {event.slug}
              </a>,
            ],
            event.phase !== undefined && ['Phase', `P${event.phase}`],
            ['Run', <Mono key="run" value={event.runId} copyable />],
            ['Event', <OpsStatus key="kind" vocab="settle" word={event.kind} />],
            ['Branch', event.branch ? <Mono key="branch" value={event.branch} /> : '—'],
            ['Strategy', event.strategy ?? '—'],
            ['Source', SOURCE_BLURB[event.via] ?? event.via],
            ['When', <RecordWhen key="at" at={event.at} />],
            Boolean(event.detail) && ['Detail', event.detail],
          ]}
        />
      ),
      actions: (
        <RecordMoves
          moves={[
            ['The run', runViewHref(event.slug, 'history', event.runId)],
            Boolean(event.branch) && ['Walk its branch', repoSectionHref('history', { ref: event.branch })],
            ['Every settle of this plan', repoSectionHref('settles', { slug: event.slug })],
          ]}
        />
      ),
      raw: recordRaw(event),
    },
    options,
  );
}

/* ---------------- a changed file ---------------- */

export interface FileSubject {
  file: RepoDiffFile;
  repo: string | undefined;
  base: string | undefined;
  tip: string | undefined;
}

export const fileKey = (subject: Pick<FileSubject, 'repo' | 'base' | 'tip'>, path: string): string =>
  `repo:file:${subject.repo ?? 'root'}:${subject.base ?? ''}..${subject.tip ?? ''}:${path}`;

/** The range a diff compares, said. */
export function rangeWords(base: string | undefined, tip: string | undefined): string {
  if (!base && !tip) return 'The working tree against HEAD';
  if (!base) return `What ${tip} changed`;
  return `Between ${base} and ${tip ?? 'the working tree'}`;
}

export function inspectFile(subject: FileSubject, options: { open?: boolean } = {}): void {
  const { file, repo, base, tip } = subject;
  inspect(
    {
      key: fileKey(subject, file.path),
      title: file.path,
      description: rangeWords(base, tip),
      meta: (
        <span className="text-meta text-ink-muted">
          {file.binary ? 'Binary' : `${plural(file.additions, 'line')} added, ${file.deletions} removed`}
        </span>
      ),
      overview: (
        <KeyValue
          items={[
            ['Path', <Mono key="path" value={file.path} copyable />],
            file.oldPath !== undefined && ['Was', <Mono key="old" value={file.oldPath} />],
            ['Change', file.oldPath !== undefined ? 'Renamed' : 'Changed'],
            [
              'Lines',
              file.binary
                ? 'Binary: no lines to count.'
                : `${file.additions} added, ${file.deletions} removed`,
            ],
            ['Range', rangeWords(base, tip)],
          ]}
        />
      ),
      actions: (
        <RecordMoves
          moves={[['Read its patch', repoSectionHref('changes', { repo, base, tip, path: file.path })]]}
        />
      ),
      raw: recordRaw(file),
    },
    options,
  );
}

/* ---------------- an issue ---------------- */

export interface IssueSubject {
  repo: RepoIssues;
  issue: Issue;
  /** Ask this issue's repository again; absent where nothing may. */
  onRefresh?: (repoKey: string) => void;
  refreshing: boolean;
}

export const issueKey = (repo: Pick<RepoIssues, 'key'>, issue: Pick<Issue, 'number'>): string =>
  `repo:issue:${repo.key}#${issue.number}`;

/**
 * The whole issue. The body is TEXT inside a `<pre>`: it came from a stranger,
 * and markdown here would be a renderer executing somebody else's document on
 * a page whose buttons start agents. `whitespace-pre-wrap` keeps the author's
 * line breaks without giving up wrapping.
 */
export function inspectIssue(subject: IssueSubject, options: { open?: boolean } = {}): void {
  const { repo, issue, onRefresh, refreshing } = subject;
  const ref = issueRef(repo, issue);
  const triage = triageOfIssue(issue);
  const where = planWhere(triage);
  const url = safeHttpUrl(issue.url);
  inspect(
    {
      key: issueKey(repo, issue),
      title: issue.title,
      description: (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {ref ? <Mono value={ref} /> : `${repo.label} #${issue.number}`}
          <span className="text-meta text-ink-muted">{ageLine(repo)}</span>
        </span>
      ),
      meta: (
        <>
          <OpsStatus vocab="issue-severity" word={triage.severity} />
          <OpsStatus vocab="issue-plan" word={triage.plan.state} />
        </>
      ),
      overview: (
        <div className="flex min-w-0 flex-col gap-4">
          <KeyValue
            items={[
              ['Repository', <Mono key="repo" value={repo.nameWithOwner ?? repo.label} />],
              [
                'Scope token',
                repo.kind === 'added' ? (
                  'None: this repository is outside this console, so no plan here can take it.'
                ) : (
                  <Mono key="scope" value={repo.scopeToken} />
                ),
              ],
              ['State', isOpenIssue(issue) ? 'Open' : 'Closed'],
              ['Category', <OpsStatus key="category" vocab="issue-category" word={triage.category} />],
              ['Severity', <OpsStatus key="severity" vocab="issue-severity" word={triage.severity} />],
              [
                'Plan status',
                <span key="plan" className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <OpsStatus vocab="issue-plan" word={triage.plan.state} />
                  {where && <span className="text-meta text-ink-muted">{where}</span>}
                </span>,
              ],
              ['Labels', issue.labels.length ? issue.labels.join(', ') : 'None'],
              ['Assignees', issue.assignees.length ? issue.assignees.join(', ') : 'Unassigned'],
              ['Opened by', issue.author ?? 'Not recorded'],
              Boolean(issue.createdAt) && ['Opened', <RecordWhen key="opened" at={issue.createdAt} />],
              ['Updated', <RecordWhen key="updated" at={issue.updatedAt} />],
              Boolean(issue.closedAt) && ['Closed', <RecordWhen key="closed" at={issue.closedAt} />],
              issue.provenance !== undefined && [
                'Filed by',
                <a
                  key="filed"
                  href={phaseHref(issue.provenance.slug, issue.provenance.phase)}
                  className="tap-line underline decoration-ink-faint underline-offset-2"
                  data-testid="provenance-link"
                >
                  A session of {issue.provenance.slug}, phase {issue.provenance.phase}
                </a>,
              ],
            ]}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-meta text-ink-muted">Body</p>
            {issue.body === undefined ? (
              <p className="text-body text-ink-muted">
                No body cached yet: bodies are fetched within a budget during a refresh, and this one has not
                been asked for — not the same as an issue with nothing written in it.
              </p>
            ) : (
              <pre
                data-testid="issue-body"
                className="m-0 min-w-0 font-mono text-meta break-words whitespace-pre-wrap text-ink"
              >
                {issue.body}
              </pre>
            )}
            {issue.bodyTruncated && (
              <p className="text-meta text-ink-muted" data-testid="issue-body-truncated">
                Cut at the server’s byte ceiling: the rest is on GitHub.
              </p>
            )}
          </div>
        </div>
      ),
      actions: (
        <div className="flex min-w-0 flex-col items-start gap-3">
          {url ? (
            <Button
              size="sm"
              variant="ghost"
              asChild
              className="h-auto max-w-full whitespace-normal text-start"
            >
              <a href={url} target="_blank" rel="noreferrer noopener">
                Open on GitHub
              </a>
            </Button>
          ) : (
            <p className="wrap-anywhere text-meta text-ink-muted" data-testid="inspector-url-refused">
              Its address is not http(s), so it is shown rather than linked: {issue.url}
            </p>
          )}
          {(triage.plan.slug || issue.provenance) && (
            <RecordMoves
              moves={[
                Boolean(triage.plan.slug) && ['Open the plan', planHref(triage.plan.slug!)],
                issue.provenance !== undefined && [
                  'The phase that filed it',
                  phaseHref(issue.provenance.slug, issue.provenance.phase),
                ],
              ]}
            />
          )}
          <RepoActions repo={repo} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing} />
        </div>
      ),
      raw: recordRaw(issue),
    },
    options,
  );
}
