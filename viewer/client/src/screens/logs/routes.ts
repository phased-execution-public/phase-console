/**
 * Logs' sections, as addresses (7.0, quiet-console phase 20; Debug until 7.0).
 *
 * Every filter is in the address, because what this place shows is evidence
 * and evidence has to be quotable: "the console log went quiet at 14:02" is a
 * screenshot, `#/logs?source=console&until=2026-09-01T14:02:00Z` is something
 * the next person can open.
 *
 * ```
 * #/logs                the log explorer     ?q= &source= &level= &since= &until= &slug= &run= &phase= &trace= &limit= &follow=1
 * #/logs/journal        one run as it happened   ?slug= &run= &phase=
 * #/logs/delivery       the delivery ledger
 * #/logs/timeline       Pro: one run on one axis ?slug= &run= &lanes=
 * #/logs/git            Pro: every git command a run ran ?slug= &run= &q=
 * #/logs/health         the runtime, the doctor, this process, the bundle
 * #/logs/access         who this console has served
 * ```
 *
 * `#/logs` is the explorer — the section a person means by "the logs" — so it
 * has no segment of its own, and a segment nobody knows is the explorer rather
 * than a dead link. Every `#/debug…` address lands here, section and query
 * carried (`shell/redirects.ts`).
 */

import { logsHref } from '@/shell/routes';

export const LOGS_SECTIONS = [
  { id: 'logs', label: 'Logs' },
  { id: 'journal', label: 'Journal' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'health', label: 'Health' },
  { id: 'access', label: 'Access' },
] as const;

export type LogsSectionId = (typeof LOGS_SECTIONS)[number]['id'];

const IDS: readonly string[] = LOGS_SECTIONS.map((s) => s.id);

/** The section a path segment names — anything unknown is the explorer. */
export function logsSectionOf(segment: string | undefined): LogsSectionId {
  return segment && IDS.includes(segment) ? (segment as LogsSectionId) : 'logs';
}

type LogsQuery = Readonly<Record<string, string | number | readonly string[] | null | undefined>>;

/**
 * A section's address, carrying only what was asked for. An empty value is
 * dropped as well as an absent one — the server reads `?slug=` and no slug
 * alike, so a link that sent one would say something its reader did not — and
 * a list is COMMA-JOINED: the hash's query is flat, the last of a repeated key
 * wins, so `?source=a&source=b` would read back as one source. The wire wants
 * repeats, and `data/api/debug.ts` builds those.
 */
export function logsSectionHref(section: LogsSectionId, query: LogsQuery = {}): string {
  const kept: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      const joined = value.filter(Boolean).join(',');
      if (joined) kept[key] = joined;
      continue;
    }
    kept[key] = value as string | number;
  }
  return logsHref(section, kept);
}

/**
 * A repeated-or-comma-joined query key, read back into a list of the words a
 * vocabulary knows. A typo selects nothing rather than everything: a filter
 * that narrows to a word nobody writes would read as an empty log.
 */
export function listOf<T extends string>(raw: string | undefined, vocabulary: readonly T[]): T[] {
  if (!raw) return [];
  const allowed = new Set<string>(vocabulary);
  return raw
    .split(',')
    .map((word) => word.trim())
    .filter((word): word is T => allowed.has(word));
}

/** `?phase=` as a number — an unreadable one is dropped, never sent as NaN. */
export function phaseOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const phase = Number(raw);
  return Number.isInteger(phase) && phase >= 0 ? phase : undefined;
}
