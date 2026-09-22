/**
 * Repo — destination 7, for real.
 *
 * ## What this destination is for
 *
 * Until 4.0 the one question a run never answered was *what did it actually do
 * to the tree*: the branch, the commits, the diff, and — once runs began going
 * parallel — WHICH OF SEVERAL TREES. Answering any of it meant leaving the
 * console for a terminal, which is why a phase's diff was the part of a phase
 * nobody read and an orphaned worktree was something you found by running out of
 * disk.
 *
 * Phase 4 shipped this page as an honest stub: `state.repo`, whose `git status`
 * is scoped to the DOCS directory alone. That glance is still here, at the top,
 * still labelled with the corner it looks at — it is the fastest answer to "is
 * there anything uncommitted", and Phase 8's surfaces do not replace it. What
 * they add is everything else.
 *
 * ## Six sections, and the URL is the state
 *
 * `#/repo`, `#/repo/branches`, `#/repo/trees`, `#/repo/diff`, `#/repo/settles`
 * and `#/repo/issues` — the first five over Phase 8's git surfaces, the sixth
 * over the issues estate —
 * each with its own query — `?repo=` picks the target, `?ref=` the graph's
 * walk, `?base=&tip=&path=` the diff's range, `?commit=`/`?branch=`/`?tree=` the
 * open inspector. Every one of them survives a reload and pastes into a message,
 * because the alternative for a surface whose whole job is evidence is a
 * screenshot.
 *
 * ## Disclosure
 *
 * L0 is the section itself; L1 is the row; **L2 is an `Inspector`** the page
 * mounts (never a route — the three overlays are query params owned by
 * `App.tsx`, and a page must not mount its own); **L3 is that inspector's `raw`
 * slot**, carrying the server's record verbatim. A reader who does not trust a
 * badge can read the JSON that produced it — on the three objects a person acts
 * on: a **commit**, a **branch** and a **working tree**. A settle event and a
 * diff row do not get one, deliberately: a settle's row shows every field it
 * carries except the run ID, and a diff row's detail is the patch pane beside
 * it. (An earlier draft of this sentence said the run ID rode in the settle
 * `via` chip's title. It does not — that was transplanted from the CHECKOUTS
 * `ViaChip`, which does carry it. QA round 3, F-6.) If a later phase needs the
 * run ID on screen, the settle row is the place — do not reach for an inspector
 * to hold one field.
 */

import { GitBranch } from 'lucide-react';
import { navigate, type ViewProps } from '@/app/router';
import GraphSection from './graph-section';
import BranchSection from './branch-section';
import TreeSection from './tree-section';
import DiffSection from './diff-section';
import SettleSection from './settle-section';
import IssuesSection from './issues-section';
import { Page } from '@/components/page';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  CardTitle,
  Disclosure,
  Empty,
  PageError,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tile,
} from '@/components/ui';
import { useConsoleState, useRepoTargets } from '@/lib/queries';
import { REPO_SECTIONS, repoHref, sectionFor, type RepoSection } from './routes';

const SUBTITLE = 'Branches, commits and what changed in this source';

/**
 * The six sections ride in the destination's own chunk, and deliberately so.
 *
 * Settings splits its two heavy halves out (a permissions form over a rule
 * grammar, an MCP catalog with a search) because neither is on the path of
 * somebody who opened Settings to flip a theme. Nothing here is that: the whole
 * destination is plain React over six fetchers, with no chart library, no
 * emulator and no parser bigger than the eighty lines in `shared/diff.js`.
 * Splitting it would add six chunks to the service worker's precache — which
 * is to say, make the offline shell BIGGER to save nothing.
 *
 * Issues is the one section that would pull something heavier in: `RunSetup`,
 * for its launch dialog, which is a chunk of its own at 71 KB. It reaches it
 * the way every other launch surface does — through a LAZY boundary
 * (`lazy-issues-launch.tsx`, modelled on `run-setup/lazy-launch-dialog.tsx`) —
 * so a reader who opened this destination for a commit graph pays nothing for a
 * form they have not pressed. `check-dist.mjs` asserts it, because a static
 * import that creeps back in is invisible from the source of any file anyone
 * would think to open.
 *
 * The Pro seventh section, Landscape, is the other: React Flow and d3-dag
 * (~97 KiB gzipped, `test/fixtures/spikes/react-flow-bundle.md`) behind a
 * section most readers never open. It is reached through
 * `pro/lazy-landscape.tsx` for the same reason, and `check-dist.mjs` holds the
 * repo chunk free of React Flow and the landscape chunk out of the precache.
 */
const SECTION_BODY: Record<RepoSection, React.ComponentType<{ route: ViewProps['route'] }>> = {
  graph: GraphSection,
  branches: BranchSection,
  trees: TreeSection,
  diff: DiffSection,
  settles: SettleSection,
  issues: IssuesSection,
};

/** The one-glance card Phase 4 shipped, kept exactly as honest as it was. */
function DocsGlance() {
  const { data: state, isPending, error, refetch } = useConsoleState();

  if (isPending) return <CardSkeleton loading />;
  if (error) return <PageError error={error} retry={() => void refetch()} />;

  const repo = state?.repo;
  const dirty = repo?.dirty ?? [];

  // No `repo` block at all is not "clean" — it is a server that did not say.
  // Every other optional field in `ConsoleState` is read that way, and drawing
  // reassurance over silence is the defect this page failed QA for once already.
  if (!repo) {
    return (
      <Empty
        icon={<GitBranch size={20} aria-hidden />}
        title="This console did not report a repository"
        body="An older server, or one that could not read the source. Nothing here is a statement about the tree."
      />
    );
  }

  if (repo.available === false) {
    return (
      <Empty
        icon={<GitBranch size={20} aria-hidden />}
        title="This source is not a git repository"
        body="Open a project that is one, and its branch and working tree appear here."
        action={<Button onClick={() => navigate('source')}>Open a different project…</Button>}
      />
    );
  }

  // `repoInfo` leaves BOTH counts undefined when there is no upstream — the
  // branch is not behind by zero, it is not being tracked at all, and `?? 0`
  // would tell every unpushed lane branch it was safely pushed.
  const tracked = repo.ahead !== undefined || repo.behind !== undefined;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Branch</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-3">
          {/* `min-w-0` as well as `truncate`: the grid TRACK is already
              `minmax(0,1fr)`, but the tile inside it keeps `min-width:auto`, so
              a long unbroken branch name (`pe/console-parallel-repaint`) pushes
              the column instead of ellipsing — and the tile's `nowrap` figure
              style raised the floor rather than lowering it. */}
          <Tile
            className="min-w-0"
            label="Checked out"
            value={<span className="block min-w-0 truncate">{repo.branch ?? 'unknown'}</span>}
            hint={tracked ? undefined : 'no upstream'}
          />
          <Tile
            label="Ahead"
            value={tracked ? (repo.ahead ?? 0) : '—'}
            hint={tracked ? (repo.ahead ? 'commits not pushed' : 'nothing to push') : 'not tracked'}
          />
          <Tile
            label="Behind"
            value={tracked ? (repo.behind ?? 0) : '—'}
            hint={tracked ? (repo.behind ? 'commits not pulled' : 'up to date') : 'not tracked'}
          />
        </CardBody>
      </Card>

      <div className="mt-4">
        {dirty.length === 0 ? (
          <Empty
            icon={<GitBranch size={20} aria-hidden />}
            title="Nothing uncommitted under docs/"
            // No `action`, deliberately. Every other Empty in the app invites
            // you to do the thing that would fill it; here the list being empty
            // is good news about somebody else's work, and a button would be an
            // invention. The sentence says which corner this is instead — and
            // now also says where the whole-tree answer lives, which it could
            // not before Phase 8 shipped the git surfaces.
            body="This is the plans-and-handoffs corner of the tree, which is all /api/state reads. The rest of the working tree is under Changes, below."
          />
        ) : (
          <Disclosure label="Uncommitted under docs/" count={dirty.length}>
            <ul className="flex flex-col gap-1 font-mono text-2xs text-ink-muted">
              {dirty.map((path) => (
                <li key={path} className="truncate" title={path}>
                  {path}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </>
  );
}

/**
 * Which repository the sections are about.
 *
 * A key, never a directory — `GET /api/repo/targets` mints them and an unknown
 * one is a 404 rather than a silent fall back to the root, which is what makes a
 * pasted link either right or visibly wrong. One target is not a choice, so the
 * picker does not render.
 */
function TargetPicker({ section, current }: { section: RepoSection; current: string }) {
  const { data } = useRepoTargets();
  const targets = data?.targets ?? [];
  if (targets.length < 2) return null;
  return (
    <div className="flex items-center gap-2 text-2xs text-ink-muted">
      <label htmlFor="repo-target">Repository</label>
      <Select
        value={current}
        onValueChange={(key) => navigate(repoHref(section, { repo: key === 'root' ? undefined : key }))}
      >
        <SelectTrigger id="repo-target" className="min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {targets.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {t.label}
              {t.kind !== 'root' && <span className="text-ink-faint"> · {t.kind}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SectionNav({ current, repo }: { current: RepoSection; repo: string }) {
  return (
    <nav aria-label="Repo sections" className="flex flex-wrap gap-1">
      {REPO_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={repoHref(s.id, { repo: repo === 'root' ? undefined : repo })}
          aria-current={s.id === current ? 'page' : undefined}
          title={s.blurb}
          className={`inline-flex min-h-(--tap-min) items-center rounded px-2 text-sm ${
            s.id === current ? 'bg-surface text-ink' : 'text-ink-muted hover:bg-surface/60 hover:text-ink'
          }`}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

export default function RepoPage({ route }: ViewProps) {
  const section = sectionFor(route.segments[1]);
  const repo = route.query.repo ?? 'root';
  const Body = SECTION_BODY[section];

  return (
    <Page
      title="Repo"
      subtitle={SUBTITLE}
      /*
       * The picker is the five git surfaces' target, and Issues is not one of
       * them: it is estate-wide and offers its own repository FILTER, drawn
       * from the issue inventory rather than `/api/repo/targets`. The two lists
       * genuinely differ — a target may be a linked worktree or a mount, and
       * neither has an issue tracker — so showing this one here would offer
       * choices the board cannot honour. Both write the same `?repo=` key,
       * because both name a repository the same way.
       */
      actions={section === 'issues' ? undefined : <TargetPicker section={section} current={repo} />}
    >
      <DocsGlance />

      <div className="mt-6 flex flex-col gap-3">
        <SectionNav current={section} repo={repo} />
        <Body route={route} />
      </div>
    </Page>
  );
}
