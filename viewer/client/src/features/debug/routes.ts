/**
 * The Debug destination's own routes — four sections, and the URL is the state.
 *
 * Every filter is addressable for the same reason Repo's inspectors are: the
 * output of this page is EVIDENCE, and evidence has to be quotable. "The
 * console log went quiet at 14:02" is a screenshot; `#/debug?source=console&
 * until=2026-09-01T14:02:00Z` is something the next person can open.
 *
 * `#/debug` is the log explorer — the section a person means when they say
 * "the logs" — so `logs` has no segment of its own, and an unknown segment
 * resolves to it rather than 404ing. Same rule `app/routes.ts` follows for the
 * eight destinations and `features/repo/routes.ts` follows one level down.
 */

export const DEBUG_SECTIONS = [
  {
    id: 'logs',
    label: 'Logs',
    blurb: 'Every log this console writes, merged onto one time axis.',
  },
  {
    id: 'journal',
    label: 'Journal',
    blurb: 'One run drawn as it happened, and why a phase is not done.',
  },
  {
    id: 'delivery',
    label: 'Delivery',
    blurb: 'What happened to each announcement, per device.',
  },
  {
    id: 'health',
    label: 'Health',
    blurb: 'The environment, the watch clock, the metrics — and the bundle.',
  },
] as const;

export type DebugSection = (typeof DEBUG_SECTIONS)[number]['id'];

const IDS: readonly string[] = DEBUG_SECTIONS.map((s) => s.id);

/** An unknown segment is the log explorer, never a 404 — see the file lead. */
export function sectionFor(segment: string | undefined): DebugSection {
  return segment && IDS.includes(segment) ? (segment as DebugSection) : 'logs';
}

/**
 * A link to a section, carrying only the query that was actually asked for.
 *
 * An empty value is never emitted, for the same reason the API client never
 * emits one: on the server an empty parameter and an absent one are read the
 * same way by a coercion, and a link that sends `?slug=` says something the
 * person clicking it did not.
 *
 * An array value is COMMA-JOINED, not repeated. The hash and the wire want
 * different shapes and this is the hash: `Route.query` is a flat
 * `Record<string, string>` where the last value of a repeated key wins, so
 * `?source=a&source=b` would read back as one source and quietly narrow the
 * page every time somebody followed their own link. The wire wants repeats,
 * and `lib/api/debug.ts` builds those — one conversion, in the layer that
 * talks to the server.
 */
export function debugHref(
  section: DebugSection,
  query: Record<string, string | number | readonly string[] | undefined> = {},
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      const joined = value.filter(Boolean).join(',');
      if (joined) parts.push(`${key}=${encodeURIComponent(joined)}`);
      continue;
    }
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  const path = section === 'logs' ? 'debug' : `debug/${section}`;
  return `#/${path}${parts.length ? `?${parts.join('&')}` : ''}`;
}

/**
 * Read a repeated-or-comma-joined query key back into a list.
 *
 * `Route.query` is a flat `Record<string, string>` — the last value of a
 * repeated key wins — so a link that wrote `?source=a&source=b` reads back as
 * `'b'`. Accepting the comma form as well is what makes both shapes work from
 * a hand-typed URL, and validating against the vocabulary is what stops a typo
 * from selecting nothing and looking like an empty log.
 */
export function listOf<T extends string>(raw: string | undefined, vocabulary: readonly T[]): T[] {
  if (!raw) return [];
  const allowed = new Set<string>(vocabulary);
  return raw
    .split(',')
    .map((word) => word.trim())
    .filter((word): word is T => allowed.has(word));
}
