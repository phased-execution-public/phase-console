/**
 * The Repo destination's own routes — six sections, and the URL is the state.
 *
 * Every section, every target, every open inspector is addressable, because a
 * surface whose whole job is evidence has to be quotable. The alternative for
 * "look at this orphaned worktree" is a screenshot, and a screenshot is the one
 * form of evidence nobody can check.
 *
 * `#/repo` is the graph — the section a person means when they say "the repo" —
 * so `graph` has no segment of its own and an unknown segment resolves to it
 * rather than 404ing. A head that ever appeared in a bookmark must keep
 * resolving; that is the same rule `app/routes.ts` follows for the eight
 * destinations, applied one level down.
 */

export const REPO_SECTIONS = [
  {
    id: 'graph',
    label: 'History',
    blurb: 'Commits and the lanes they were committed on.',
  },
  {
    id: 'branches',
    label: 'Branches',
    blurb: 'Every local branch, what claims it, and how far it has diverged.',
  },
  {
    id: 'trees',
    label: 'Working trees',
    blurb: 'Where the parallel work physically is — and what is left over from work that ended.',
  },
  {
    id: 'diff',
    label: 'Changes',
    blurb: 'What changed between any two points, one file at a time.',
  },
  {
    id: 'settles',
    label: 'Settles',
    blurb: 'How each run’s work reached the trunk, or why it did not.',
  },
  {
    id: 'issues',
    label: 'Issues',
    blurb: 'Every repository’s open work, and one click from a set of it to a plan.',
  },
] as const;

export type RepoSection = (typeof REPO_SECTIONS)[number]['id'];

const IDS: readonly string[] = REPO_SECTIONS.map((s) => s.id);

/** An unknown segment is the graph, never a 404 — see the file lead. */
export function sectionFor(segment: string | undefined): RepoSection {
  return segment && IDS.includes(segment) ? (segment as RepoSection) : 'graph';
}

/**
 * A link to a section, carrying only the query that was actually asked for.
 *
 * An empty value is never emitted, for the same reason the API client never
 * emits one: on the server an empty parameter and an absent one are read the
 * same way by a coercion, and a link that sends `?repo=` says something the
 * person clicking it did not.
 */
export function repoHref(
  section: RepoSection,
  query: Record<string, string | number | undefined> = {},
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  const path = section === 'graph' ? 'repo' : `repo/${section}`;
  return `#/${path}${parts.length ? `?${parts.join('&')}` : ''}`;
}
