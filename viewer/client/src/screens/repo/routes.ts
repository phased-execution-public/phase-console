/**
 * Repo's sections, as addresses (7.0, quiet-console phases 17 and 18).
 *
 * Every section, every target and every inspected record is in the address,
 * because a surface whose job is evidence has to be quotable: a link to an
 * orphaned tree is checkable, a screenshot of one is not.
 *
 * ```
 * #/repo                    History — the section a person means by "the repo"
 * #/repo/branches           Branches          ?branch=<name>
 * #/repo/trees              Working trees     ?tree=<dir>
 * #/repo/changes            Changes           ?base= &tip= &path= &unified=
 * #/repo/settles            Settles           ?slug=<plan> &event=<key>
 * #/repo/issues             the Issues desk   ?state= &label= &q= &category= &severity= &plan= &filed= &sort= &dir= &issue=
 * ```
 *
 * `?repo=<key>` names the repository on every section that reads one, and
 * History adds `?ref=` (walk one branch), `?all=1` (walk every branch) and
 * `?commit=<sha>`. 6.2's spellings keep landing: `#/repo/graph` and
 * `#/repo/history` are History, `#/repo/diff` is Changes — read, never
 * written — and any other segment is History rather than a dead link.
 */

import { repoHref } from '@/shell/routes';

export const REPO_SECTIONS = [
  { id: 'history', label: 'History', segment: '' },
  { id: 'branches', label: 'Branches', segment: 'branches' },
  { id: 'trees', label: 'Working trees', segment: 'trees' },
  { id: 'changes', label: 'Changes', segment: 'changes' },
  { id: 'settles', label: 'Settles', segment: 'settles' },
  { id: 'issues', label: 'Issues', segment: 'issues' },
] as const;

export type RepoSectionId = (typeof REPO_SECTIONS)[number]['id'];

/** The words 6.2 wrote for a section, each to the section it is now. */
const SEGMENT_ALIASES: Readonly<Record<string, RepoSectionId>> = {
  graph: 'history',
  history: 'history',
  diff: 'changes',
};

/** The section a path segment names — an alias read as its section, anything else History. */
export function repoSectionOf(segment: string | undefined): RepoSectionId {
  const found = REPO_SECTIONS.find((s) => s.segment !== '' && s.segment === segment);
  if (found) return found.id;
  return (segment && SEGMENT_ALIASES[segment]) || 'history';
}

type RepoQuery = Readonly<Record<string, string | number | null | undefined>>;

/**
 * A section's address, carrying only what was asked for. An empty value is
 * dropped as well as an absent one: the server coerces `?unified=` to 0 and
 * `?ref=` to a named walk of nothing, so a link that sent one would say
 * something its reader did not.
 */
export function repoSectionHref(section: RepoSectionId, query: RepoQuery = {}): string {
  const kept: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    kept[key] = value;
  }
  const segment = REPO_SECTIONS.find((s) => s.id === section)?.segment ?? '';
  return repoHref(segment || undefined, kept);
}

/** `?repo=` as a target key, the root's absence. `root` is never written. */
export function repoTargetOf(query: Readonly<Record<string, string>>): string | undefined {
  const key = query.repo;
  return key && key !== 'root' ? key : undefined;
}

/** git's own context default, and what an absent `unified=` means on the server. */
export const DEFAULT_UNIFIED = 3;

/** The context widths the Changes section offers; `0` is a real request. */
export const UNIFIED_CHOICES = [0, 3, 12] as const;

/**
 * `?unified=` as a number. Absence is tested before the coercion — `Number('')`
 * is 0, and an empty parameter is silence, not "no context" — and a value that
 * is no number falls back once, here, so no link ever splices `NaN`.
 */
export function unifiedOf(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_UNIFIED;
  const asked = Number(value);
  return Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_UNIFIED;
}
