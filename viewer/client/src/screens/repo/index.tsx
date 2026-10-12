/**
 * Repo — what the runs did to the repository, and where their work stands
 * (7.0, quiet-console phases 17 and 18).
 *
 * ```
 * Repo
 * On main: 2 commits not pushed, up to date. Nothing uncommitted under docs/.
 * History   Branches   Working trees   Changes   Settles   Issues
 * [Find a commit…]  Filter                                        Everything
 * …the section…
 * ```
 *
 * One question the rest of the console cannot answer without a terminal: what
 * did a run actually do to the tree — its branch, its commits, its changes,
 * which of several checkouts, and did it land. The glance says where the docs
 * corner stands; five sections answer the rest, each an address
 * (`routes.ts`), each a column of rows with one toolbar, each record
 * inspectable in the panel. The Issues desk answers the questions around the
 * code: what is wrong, and which of it is planned.
 *
 * Nothing on this page commits, prunes or deletes. The desk is the one section
 * that starts anything — a session from picked issues, through the one launch
 * door — and its refresh asks GitHub, never git.
 */

import { Suspense, lazy, type ComponentType } from 'react';
import type { Route } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { Page } from '@/ui';
import BranchesSection from './branches';
import ChangesSection from './diff';
import { DocsFold, RepoGlance } from './glance';
import HistorySection from './graph-section';
import { RowsLoading, useTargets } from './parts';
import { REPO_SECTIONS, repoSectionHref, repoSectionOf, repoTargetOf, type RepoSectionId } from './routes';
import SettlesSection from './settles';
import TreesSection from './trees';

/**
 * The issues desk arrives when its section is opened: its filters, its picks
 * and its doors are a reader's second question, and the commit graph is the
 * first.
 */
const IssuesSection = lazy(() => import('./issues-section'));

/**
 * The five git sections ride in the place's own chunk: plain React over five
 * fetchers, nothing heavy — split, they would add five chunks to the offline
 * precache to save nothing.
 */
const BODIES: Readonly<Record<RepoSectionId, ComponentType<{ route: Route }>>> = {
  history: HistorySection,
  branches: BranchesSection,
  trees: TreesSection,
  changes: ChangesSection,
  settles: SettlesSection,
  issues: IssuesSection,
};

export default function RepoPlace({ route }: { route: Route }) {
  const section = repoSectionOf(route.segments[1]);
  const repo = repoTargetOf(route.query);
  const targets = useTargets();
  const Body = BODIES[section];
  // A key the git surfaces do not know — an issue desk's added repository —
  // is not carried into them, where it would only be refused as unknown.
  const carried = !repo || !targets.length || targets.some((t) => t.key === repo) ? repo : undefined;

  return (
    <Page title="Repo" lead={<RepoGlance />} data-testid="repo-page" data-section={section}>
      <DocsFold />
      <div className="flex min-w-0 flex-col gap-4">
        <SectionNav
          label="Repo sections"
          current={section}
          // The repository rides from section to section; what belonged to one
          // section (a commit, a range, a filter) does not.
          sections={REPO_SECTIONS.map((s) => ({
            id: s.id,
            label: s.label,
            href: repoSectionHref(s.id, { repo: carried }),
          }))}
        />
        <Suspense fallback={<RowsLoading label="Opening the section" />}>
          <Body route={route} />
        </Suspense>
      </div>
    </Page>
  );
}
