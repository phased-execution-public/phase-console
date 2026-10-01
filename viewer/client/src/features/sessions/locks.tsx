/**
 * `#/sessions/locks` — every phase claim this console can see (#24).
 *
 * The lock decides whether a phase may board, and until now it had no page:
 * "why is this phase not starting?" took the queue, a shelled `phase-lock.sh
 * status`, the lock files and `ps`. This section is one read of
 * `GET /api/locks`, in the order the server ranks it — a lapsed claim still on
 * disk first, then a live one holding something up, then a live one holding
 * up nothing — with the same Release verb every other surface uses.
 *
 * Plain on purpose: phase 25 redesigns it, with the history beside it.
 */
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { LockRow } from '@/lib/api';
import { useConsoleState, useLocks } from '@/lib/queries';
import { countdown, holderEtaText, relativeTime } from '@/lib/format';
import { navigate } from '@/app/router';
import { phaseHref } from '@shared/routes.js';
import { Page } from '@/components/page';
import { Button, Empty, MonoId, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { DataTable, type Column } from '@/components/data-table';
import { ForceReleaseButton, ReleaseStaleButton } from '@/components/release-lock';

/** What the row is doing to the rest of the machine, in words. */
export function lockStateText(row: LockRow): string {
  if (row.lapsed) return 'Lapsed — still on disk';
  return row.blocking.length ? `Blocking ${row.blocking.length}` : 'Held';
}

/** The entries a claim holds up, as links — the list itself, not a count behind a tooltip. */
function BlockedList({ blocked }: { blocked: { slug: string; phase: number | null }[] }) {
  if (!blocked.length) return null;
  return (
    <span className="flex flex-wrap gap-x-1.5 text-xs" data-testid="lock-blocks">
      {blocked.map((one) =>
        one.phase === null ? (
          <span key={one.slug} className="text-ink-muted">
            {one.slug}
          </span>
        ) : (
          <a
            key={`${one.slug}/${one.phase}`}
            className="text-action underline"
            href={phaseHref(one.slug, one.phase)}
          >
            {one.slug} P{one.phase}
          </a>
        ),
      )}
    </span>
  );
}

function holderText(row: LockRow): string {
  return row.holderKind === 'autopilot' ? `autopilot run ${row.runId ?? ''}`.trim() : 'person';
}

function columns(allowWrites: boolean): Column<LockRow>[] {
  return [
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 170,
      flex: true,
      identity: true,
      card: 'title',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <a className="truncate font-medium text-ink hover:underline" href={phaseHref(row.slug, row.phase)}>
            {row.slug} P{row.phase}
          </a>
          <span className="truncate text-xs text-ink-muted">{row.phaseTitle}</span>
        </span>
      ),
    },
    {
      id: 'holder',
      head: 'Holder',
      priority: 1,
      min: 170,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs text-ink" title={row.owner}>
            {row.owner}
          </span>
          <span className="truncate text-xs text-ink-muted">
            {holderText(row)}
            {row.host ? ` on ${row.host}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'session',
      head: 'Session',
      priority: 3,
      min: 110,
      cell: (row) =>
        row.session ? (
          <span className="flex flex-col">
            <MonoId id={row.session} />
            <span className="text-xs text-ink-muted">{row.presence}</span>
          </span>
        ) : (
          <span className="text-xs text-ink-muted">none named</span>
        ),
    },
    {
      id: 'scope',
      head: 'Scope',
      priority: 2,
      min: 90,
      cell: (row) =>
        row.scope.length ? (
          <span className="font-mono text-xs">{row.scope.join(', ')}</span>
        ) : (
          <span
            className="text-xs text-ink-muted"
            title="A claim that names no scope collides with every other"
          >
            everything
          </span>
        ),
    },
    {
      id: 'where',
      head: 'Branch and tree',
      priority: 3,
      min: 140,
      cell: (row) =>
        row.branch || row.worktree ? (
          <span className="flex min-w-0 flex-col font-mono text-xs">
            {row.branch && <span className="truncate">{row.branch}</span>}
            {row.worktree && (
              <span className="truncate text-ink-muted" title={row.worktree}>
                {row.worktree}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">not said</span>
        ),
    },
    {
      id: 'lease',
      head: 'Lease',
      priority: 2,
      min: 100,
      cell: (row) => (
        <span className="flex flex-col text-xs">
          <span>{row.lapsed ? 'lapsed' : countdown(row.leaseUntil)}</span>
          {row.claimedAt != null && (
            <span className="text-ink-muted">claimed {relativeTime(row.claimedAt)}</span>
          )}
        </span>
      ),
    },
    {
      id: 'state',
      head: 'State',
      priority: 1,
      min: 120,
      cell: (row) => (
        <span className="flex flex-col text-xs">
          <span className={row.lapsed ? 'font-medium text-warn' : undefined}>{lockStateText(row)}</span>
          <BlockedList blocked={row.blocking} />
          {row.eta?.label && <span className="text-ink-muted">{holderEtaText(row.eta, row.phase)}</span>}
        </span>
      ),
    },
    {
      id: 'release',
      head: 'Release',
      priority: 1,
      min: 150,
      align: 'end',
      cell: (row) =>
        row.lapsed ? (
          <ReleaseStaleButton slug={row.slug} phase={row.phase} allowWrites={allowWrites} />
        ) : (
          <ForceReleaseButton slug={row.slug} phase={row.phase} lock={row} allowWrites={allowWrites} />
        ),
    },
  ];
}

/** What the section can show: the claims now, and — Pro — the ledger of every claim since. */
const VIEWS = [
  { id: 'held', label: 'Held now' },
] as const;
type LocksView = (typeof VIEWS)[number]['id'];

export default function LocksSection() {
  const { data: state } = useConsoleState();
  const allowWrites = state?.allowWrites === true;
  const { data, isLoading } = useLocks();
  const rows = data?.rows ?? [];
  const [view, setView] = useState<LocksView>('held');

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Page
        title="Locks"
        subtitle="Every phase claim this console can see, worst first: who holds it, where its work rides, and what it is holding up."
        actions={
          <Button size="sm" variant="ghost" onClick={() => navigate('sessions')}>
            <ArrowLeft size={14} aria-hidden /> All sessions
          </Button>
        }
      >
        {VIEWS.length > 1 ? (
          <Tabs value={view} onValueChange={(next) => setView(next as LocksView)} className="mb-3">
            <TabsList aria-label="Locks">
              {VIEWS.map((one) => (
                <TabsTrigger key={one.id} value={one.id}>
                  {one.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        {view !== 'held' ? null : isLoading ? (
          <p className="text-sm text-ink-muted">Reading the lock files…</p>
        ) : (
          <DataTable
            label="Phase claims"
            columns={columns(allowWrites)}
            rows={rows}
            getRowKey={(row) => `${row.slug}/${row.phase}`}
            empty={
              <Empty
                title="No phase is claimed right now."
                body="A claim shows here the moment a session takes one — from this console or by hand."
              />
            }
          />
        )}
      </Page>
    </div>
  );
}

