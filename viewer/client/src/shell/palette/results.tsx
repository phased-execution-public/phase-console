import { useMemo } from 'react';
import { Spinner } from '@/ui';
import { CommandGroup, CommandItem } from '@/ui/command';
import { useSearch } from '@/data/console';
import { usePlans } from '@/data/plans';
import type { SearchHit } from '@/data/api';
import { closedTitle, isClosed } from '@/lib/closure';
import { handoffHref, phaseHref, planHref } from '../routes';

/**
 * The find leg over the documents — every plan section, phase block and
 * handoff body, from `/api/search`.
 *
 * cmdk scores every item against what has been typed, which is exactly wrong
 * for rows the server already matched: it would filter the results by the
 * term a second time, and a hit whose SNIPPET matched would vanish. So each
 * row's `value` begins with the query, with the row's index appended to keep
 * values unique.
 */

const KIND_LABEL: Record<string, string> = {
  plan: 'plan',
  phase: 'phase',
  handoff: 'handoff',
  document: 'document',
};

/** Where a hit goes — the one place that decision is made. */
export function hrefFor(hit: Pick<SearchHit, 'kind' | 'slug' | 'phase'>): string {
  if (hit.kind === 'handoff' && hit.phase != null) return handoffHref(hit.slug, hit.phase);
  if (hit.kind === 'phase' && hit.phase != null) return phaseHref(hit.slug, hit.phase);
  return planHref(hit.slug, 'source');
}

/**
 * The matched terms, marked. Built by splitting rather than by injecting
 * HTML: the snippet is repository text and the terms are whatever was typed,
 * so neither is ever handed to a parser.
 */
export function Snippet({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    if (!terms.length) return [text];
    const pattern = new RegExp(
      `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
      'ig',
    );
    const out: (string | { mark: string })[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      out.push({ mark: match[0] });
      last = match.index + match[0].length;
      if (match[0] === '') pattern.lastIndex++;
      if (out.length > 40) break;
    }
    out.push(text.slice(last));
    return out;
  }, [text, terms]);

  return (
    <span className="block truncate text-meta text-ink-muted">
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <mark key={i} className="rounded-sm bg-accent/25 px-0.5 text-ink">
            {part.mark}
          </mark>
        ),
      )}
    </span>
  );
}

/** How many hits the palette shows before it stops being a palette. */
const MAX_HITS = 12;

export function SearchResults({ query, onPick }: { query: string; onPick: (href: string) => void }) {
  const text = query.trim();
  const { data, isFetching } = useSearch(text);
  // Search deliberately KEEPS closed plans — an abandoned plan is often exactly
  // what you are looking for — but a result with no marker reads as live work,
  // so closure is joined on from the plan list.
  const { data: plans } = usePlans();
  const closed = useMemo(
    () => new Map((plans ?? []).filter((p) => isClosed(p)).map((p) => [p.slug, p])),
    [plans],
  );
  const terms = useMemo(
    () =>
      text
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1),
    [text],
  );

  // Two characters is the server's own floor (`useSearch` is disabled below it).
  if (text.length < 2) return null;

  const hits = (data?.groups ?? []).flatMap((group) =>
    group.hits.map((hit) => ({ hit, title: group.title, slug: group.slug })),
  );

  if (!hits.length) {
    return isFetching ? (
      <CommandGroup heading="In the documents">
        <CommandItem value={`${text} searching`} disabled>
          <Spinner />
          <span className="text-ink-muted">Searching every plan and handoff…</span>
        </CommandItem>
      </CommandGroup>
    ) : null;
  }

  return (
    <CommandGroup
      heading={`In the documents${data && data.total > hits.length ? ` (${data.total} hits)` : ''}`}
    >
      {hits.slice(0, MAX_HITS).map(({ hit, slug }, i) => (
        <CommandItem
          key={`${slug}-${hit.section}-${i}`}
          value={`${text} ${slug} ${hit.section} ${i}`}
          onSelect={() => onPick(hrefFor(hit))}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-meta text-ink-faint">{slug}</span>
              {closed.has(slug) && (
                <span className="text-meta text-ink-muted" title={closedTitle(closed.get(slug))}>
                  closed
                </span>
              )}
              <span className="truncate text-meta text-ink-faint">
                {KIND_LABEL[hit.kind] ?? hit.kind}, {hit.section}
              </span>
            </span>
            <Snippet text={hit.snippet} terms={terms} />
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
