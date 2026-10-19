/**
 * Sessions ▸ Locks ▸ Map (`#/sessions/locks?view=map`, one-pool phase 16,
 * #364) — which plan holds which repository right now, and for how long.
 *
 * ```
 *                  14:00        15:00        16:00   ┊     17:00
 * phased-execution ██ one-pool P16 · autopilot ███████┊███▒          1h 40m left
 *                  ░░░░ hub-x P3 · a person ░░░░░░░░░┊              lapsed
 * site             ██ one-pool P31 · autopilot ███████┊██████
 * everything       ▒▒ docs P2 (no scope) ▒▒▒▒▒▒▒▒▒▒▒▒▒┊             ← drawn on every lane
 * Held · Holding up others · Lapsed (hatched) · ◌ waiting on it · ┊ now
 * ```
 *
 * One lane per repository, from the union of every claim's `scope`; a claim
 * that names no scope collides with everything, so it is drawn on EVERY lane.
 * Each claim is a bar from when it was claimed to the end of its lease, on the
 * run's own swimlane (`ui/figures/swimlane`), painted by what it is doing to
 * the machine: held, holding something up, or lapsed (hatched). Claims that
 * overlap on one repository stack, one under the other, so two plans holding
 * one repository is two bars in one lane at the same moment. A queue entry
 * waiting on a claim is a ghost mark at the claim's end. A bar opens the claim
 * in the panel (Inspect), with the Release the table offers.
 *
 * Read from `GET /api/locks` (the same rows the table draws, the same
 * server-side filters); no route of its own.
 */

import { useMemo, type ReactNode } from 'react';
import type { LockRow } from '@/data/api';
import { useNow } from '@/lib/clock';
import { clockTime, countdown, plural } from '@/lib/format';
import { Empty, Mono, RelativeTime } from '@/ui';
import { FigureNumbers } from '@/ui/figures/numbers';
import { Swimlane, type SwimlaneBar, type SwimlaneRow } from '@/ui/figures/swimlane';
import { inspect } from '@/shell/panel/inspector-host';
import { phaseHref } from '@/shell/routes';

/** The lane a claim with no scope is drawn on, beside every named one. */
export const EVERY_REPO = '';

/** A claim's paint: what it is doing to the rest of the machine. */
export function claimState(row: Pick<LockRow, 'lapsed' | 'blocking'>): string {
  if (row.lapsed) return 'state-skipped';
  return row.blocking.length ? 'state-waiting' : 'state-running';
}

/** One bar on the map: a claim, on one repository's lane, at its sub-lane. */
export interface PlacedClaim {
  row: LockRow;
  repo: string;
  start: number;
  end: number;
  /** Which stacked line of its lane it is drawn on — 0 for the first. */
  stack: number;
}

export interface LockLane {
  repo: string;
  /** How many claims overlap here at most — the lane's stacked lines. */
  depth: number;
  claims: PlacedClaim[];
}

/** A claim's window: claimed to the end of its lease; an unknown edge is now, so the bar still stands. */
function windowOf(row: LockRow, now: number): [number, number] {
  const start = row.claimedAt ?? Math.min(now, row.leaseUntil ?? now);
  const end = Math.max(start + 60_000, row.leaseUntil ?? now);
  return [start, end];
}

/**
 * The lanes, as arithmetic: every repository any claim names (sorted), each
 * claim on each repository it names, a claim naming none on every lane, and
 * overlapping claims stacked by first fit.
 */
export function lockLanes(rows: readonly LockRow[], now: number): LockLane[] {
  const named = [...new Set(rows.flatMap((row) => row.scope))].sort((a, b) => a.localeCompare(b));
  const unscoped = rows.some((row) => !row.scope.length);
  const repos = named.length ? named : unscoped ? [EVERY_REPO] : [];
  return repos.map((repo) => {
    const mine = rows
      .filter((row) => !row.scope.length || row.scope.includes(repo))
      .map((row) => {
        const [start, end] = windowOf(row, now);
        return { row, repo, start, end, stack: 0 };
      })
      .sort((a, b) => a.start - b.start || a.row.slug.localeCompare(b.row.slug) || a.row.phase - b.row.phase);
    const ends: number[] = [];
    for (const claim of mine) {
      let line = ends.findIndex((end) => end <= claim.start);
      if (line < 0) line = ends.length;
      ends[line] = claim.end;
      claim.stack = line;
    }
    return { repo, depth: Math.max(1, ends.length), claims: mine };
  });
}

/** A claim in words — its bar's name and the panel's title. */
export function claimWords(row: LockRow): string {
  const holder = row.holderKind === 'autopilot' ? 'the autopilot' : 'a person';
  const lease = row.lapsed ? 'lapsed' : row.leaseUntil ? countdown(row.leaseUntil) : 'no lease said';
  const held = row.blocking.length ? `, holding up ${plural(row.blocking.length, 'entry', 'entries')}` : '';
  const scope = row.scope.length ? '' : ', on every repository (no scope named)';
  return `${row.slug} P${row.phase} · ${holder}, ${lease}${held}${scope}`;
}

/** Put the claim in the panel, with its Release. */
function inspectClaim(row: LockRow, release: (row: LockRow) => ReactNode): void {
  inspect({
    key: `lock:${row.slug}/${row.phase}`,
    title: `${row.slug} P${row.phase}`,
    description: row.phaseTitle || 'A phase claim',
    overview: (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-meta">
        <dt className="text-ink-muted">Holder</dt>
        <dd className="min-w-0">
          <Mono value={row.owner} className="wrap-anywhere" />
        </dd>
        <dt className="text-ink-muted">Scope</dt>
        <dd className="min-w-0">{row.scope.length ? row.scope.join(', ') : 'everything (no scope named)'}</dd>
        <dt className="text-ink-muted">Claimed</dt>
        <dd>{row.claimedAt ? <RelativeTime at={row.claimedAt} /> : '—'}</dd>
        <dt className="text-ink-muted">Lease</dt>
        <dd className="tnum">{row.lapsed ? 'lapsed' : countdown(row.leaseUntil) || '—'}</dd>
        {row.blocking.length ? (
          <>
            <dt className="text-ink-muted">Holding up</dt>
            <dd className="min-w-0">
              {row.blocking
                .map((one) => `${one.slug}${one.phase === null ? '' : ` P${one.phase}`}`)
                .join(', ')}
            </dd>
          </>
        ) : null}
      </dl>
    ),
    actions: (
      <div className="flex flex-wrap items-center gap-2">
        {release(row)}
        <a
          className="text-meta text-ink underline-offset-2 hover:underline"
          href={phaseHref(row.slug, row.phase)}
        >
          Open the phase
        </a>
      </div>
    ),
  });
}

/** A claim a page clock tick may move — lapses, counts down — so the map ticks while it is on screen. */
const TICK = 30_000;

export function LockMap({
  rows,
  release,
  now: fixed,
}: {
  rows: readonly LockRow[];
  /** The table's own Release, for the panel. */
  release: (row: LockRow) => ReactNode;
  /** Injectable for a test. */
  now?: number;
}) {
  const ticking = useNow(fixed === undefined, TICK);
  const now = fixed ?? ticking;
  const lanes = useMemo(() => lockLanes(rows, now), [rows, now]);
  if (!rows.length) {
    return <Empty title="No phase is claimed right now, so there is nothing to draw." />;
  }
  const moments = lanes.flatMap((lane) => lane.claims.flatMap((claim) => [claim.start, claim.end]));
  const t0 = Math.min(now - 10 * 60_000, ...moments);
  const t1 = Math.max(now + 10 * 60_000, ...moments);
  const spanMs = t1 - t0;

  const lines: SwimlaneRow[] = lanes.flatMap((lane) =>
    Array.from({ length: lane.depth }, (_, stack) => {
      const claims = lane.claims.filter((claim) => claim.stack === stack);
      const name = lane.repo || 'every repository';
      const bars: SwimlaneBar[] = claims.map((claim) => ({
        key: `${claim.row.slug}/${claim.row.phase}`,
        startMs: claim.start - t0,
        endMs: claim.end - t0,
        state: claimState(claim.row),
        // A lapsed claim is hatched: it is still on disk, holding for no reason.
        open: claim.row.lapsed,
        title: claimWords(claim.row),
        onSelect: () => inspectClaim(claim.row, release),
      }));
      return {
        key: `${lane.repo}#${stack}`,
        label:
          stack === 0 ? (
            <span className="min-w-0 truncate px-1 text-meta text-ink" title={name}>
              {name}
              {lane.depth > 1 ? <span className="ms-1 text-ink-faint tnum">×{lane.depth}</span> : null}
            </span>
          ) : (
            <span className="px-1 text-meta text-ink-faint" aria-hidden>
              ·
            </span>
          ),
        ariaLabel: `${name}${stack ? `, line ${stack + 1}` : ''}: ${
          claims.map((claim) => claimWords(claim.row)).join('; ') || 'free'
        }`,
        bars,
        marks: claims.flatMap((claim) =>
          claim.row.blocking.map((one, i) => ({
            key: `${claim.row.slug}/${claim.row.phase}/wait/${i}`,
            atMs: claim.end - t0,
            glyph: '◌',
            title: `Waiting on it: ${one.slug}${one.phase === null ? '' : ` P${one.phase}`}`,
          })),
        ),
      };
    }),
  );

  const overlaps = lanes.filter((lane) => lane.depth > 1);
  return (
    <section data-testid="lock-map" aria-label="Claims by repository" className="flex min-w-0 flex-col gap-2">
      <p className="text-meta text-ink-muted" data-testid="lock-map-lead">
        {plural(lanes.length, 'repository', 'repositories')} under {plural(rows.length, 'claim')}
        {overlaps.length
          ? `; ${overlaps.map((lane) => lane.repo || 'every repository').join(', ')} ${
              overlaps.length === 1 ? 'is' : 'are'
            } held by more than one at once`
          : ''}
        . A bar runs from the claim to the end of its lease; press one to inspect it.
      </p>
      <Swimlane
        rows={lines}
        spanMs={spanMs}
        nowMs={now - t0}
        hatchId="pe-lock-map-lapsed"
        tickLabel={(ms) => clockTime(t0 + ms).slice(0, 5)}
        labelWidth="9rem"
        ariaLabel={`Claims on ${plural(lanes.length, 'repository', 'repositories')}, from ${clockTime(t0).slice(0, 5)} to ${clockTime(t1).slice(0, 5)}`}
      />
      <ul
        data-slot="legend"
        aria-label="Key"
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted"
      >
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-running h-2 w-3 shrink-0 rounded-sm bg-state" />
          Held
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-waiting h-2 w-3 shrink-0 rounded-sm bg-state" />
          Holding up other work
        </li>
        <li className="flex items-center gap-1.5">
          <i
            aria-hidden
            className="state-skipped h-2 w-3 shrink-0 rounded-sm bg-[repeating-linear-gradient(135deg,var(--state)_0_1.5px,transparent_1.5px_3px)]"
          />
          Lapsed, still on disk (hatched)
        </li>
        <li className="flex items-center gap-1.5">◌ Waiting on it</li>
        <li className="flex items-center gap-1.5">Dashed line: now</li>
      </ul>
      <FigureNumbers
        label="claims on the map"
        caption="Each claim on each repository: who holds it, and how long its lease has left"
        rows={lanes.flatMap((lane) => lane.claims)}
        getRowKey={(claim) => `${claim.repo}/${claim.row.slug}/${claim.row.phase}`}
        columns={[
          { head: 'Repository', cell: (claim) => claim.repo || 'every repository' },
          { head: 'Claim', cell: (claim) => `${claim.row.slug} P${claim.row.phase}` },
          { head: 'Holder', cell: (claim) => claim.row.owner },
          {
            head: 'Lease',
            cell: (claim) => (claim.row.lapsed ? 'lapsed' : countdown(claim.row.leaseUntil) || '—'),
            align: 'end',
          },
        ]}
      />
    </section>
  );
}
