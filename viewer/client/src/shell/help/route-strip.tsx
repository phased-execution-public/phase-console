/**
 * The route strip — what the page under the sheet reads and presses, drawn
 * from the surface registry (`data/surface.ts`, quiet-console §Architecture 5)
 * rather than written down a second time.
 *
 * A row belongs to a page when its door is that page: the place is not the
 * shell around every page, the head is the page's head, and the section — a
 * Repo, Logs or Settings section, a plan's tab — is absent or the one on
 * screen. Folded under one quiet line, because it is depth a person asks for:
 * the routes it reads (and the live events), the presses it makes (each naming
 * the capability flag it needs), and the settings that govern it, each a link
 * to Settings ▸ Everything searched for that key.
 *
 * Off first paint by construction: the registry is a large table, and this
 * module rides the help sheet's own lazy chunk.
 */

import { useId, type ReactNode } from 'react';
import { SURFACE, type SurfaceRow } from '@/data/surface';
import { DEFAULT_HEAD, settingsHref, type Route } from '@/shell/routes';
import { Mono } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { logsSectionOf } from '@/screens/logs/routes';
import { resolveTab } from '@/screens/plan/tabs';
import { repoSectionOf } from '@/screens/repo/routes';

/** What a page touches, in the three kinds a person asks about. */
export interface PageSurface {
  /** `GET` routes and live events. */
  reads: SurfaceRow[];
  /** Every other route, and the verbs. */
  presses: SurfaceRow[];
  settings: SurfaceRow[];
}

/** The section of its page an address is on — in the words the registry's doors use. */
function sectionOf(route: Pick<Route, 'segments'>): string | undefined {
  const [head, second, third] = route.segments;
  if (head === 'plan') return resolveTab(third);
  if (head === 'repo') return repoSectionOf(second);
  if (head === 'logs') return logsSectionOf(second);
  return second;
}

/** The registry's rows whose door is the page `route` is on, sorted into the three kinds. */
export function pageSurface(route: Pick<Route, 'segments'>): PageSurface {
  const head = route.segments[0] || DEFAULT_HEAD;
  const section = sectionOf(route);
  const out: PageSurface = { reads: [], presses: [], settings: [] };
  for (const row of SURFACE) {
    const door = row.door;
    if (!door || door.place === 'Shell' || door.head !== head) continue;
    if (door.section !== undefined && door.section !== section) continue;
    if (row.kind === 'setting') out.settings.push(row);
    else if (row.kind === 'sse' || (row.kind === 'route' && row.method === 'GET')) out.reads.push(row);
    else out.presses.push(row);
  }
  return out;
}

/**
 * Settings ▸ Everything lists the keys this console stores (`GET
 * /api/prefs/schema`). A browser's own view state, a run's own field and a
 * launch flag are kept elsewhere, so a search there would find nothing.
 */
const KEPT_ELSEWHERE = /^(?:browser\.|run\.|flag )/;

/** A row as a person reads it: the machine's own spelling. */
function rowName(row: SurfaceRow): string {
  if (row.kind === 'route') return `${row.method} ${row.path}`;
  if (row.kind === 'sse') return row.event ?? row.id;
  if (row.kind === 'verb') return row.verb ?? row.id;
  return row.key ?? row.id;
}

function SurfaceList({
  title,
  rows,
  item,
}: {
  title: string;
  rows: readonly SurfaceRow[];
  item: (row: SurfaceRow) => ReactNode;
}) {
  const id = useId();
  if (!rows.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p id={id} className="text-meta text-ink-muted">
        {title} <span className="text-ink-faint tabular-nums">{rows.length}</span>
      </p>
      <ul aria-labelledby={id} className="flex min-w-0 flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {item(row)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PageRoutes({ route }: { route: Pick<Route, 'segments'> }) {
  const { reads, presses, settings } = pageSurface(route);
  const total = reads.length + presses.length + settings.length;
  if (!total) return null;
  return (
    <Disclosure
      label="What this page reads and presses"
      openLabel="Hide what this page reads and presses"
      count={total}
      bodyClassName="flex min-w-0 flex-col gap-3 pt-2"
    >
      <SurfaceList
        title="What it reads"
        rows={reads}
        item={(row) => (
          <>
            <Mono value={rowName(row)} className="wrap-anywhere" />
            {row.kind === 'sse' && <span className="text-meta text-ink-faint">live event</span>}
          </>
        )}
      />
      <SurfaceList
        title="What it presses"
        rows={presses}
        item={(row) => (
          <>
            <Mono value={rowName(row)} className="wrap-anywhere" />
            {row.flag && (
              <span className="text-meta text-ink-faint">
                needs <Mono value={row.flag} />
              </span>
            )}
          </>
        )}
      />
      <SurfaceList
        title="The settings that govern it"
        rows={settings}
        item={(row) => {
          const key = rowName(row);
          return KEPT_ELSEWHERE.test(key) ? (
            <Mono value={key} className="wrap-anywhere" />
          ) : (
            <a
              href={settingsHref('everything', { q: key })}
              className="tap-row w-fit font-mono text-meta wrap-anywhere text-ink-muted underline decoration-rule-strong underline-offset-2 hover:text-ink hover:decoration-ink"
            >
              {key}
            </a>
          );
        }}
      />
    </Disclosure>
  );
}
