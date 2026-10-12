/**
 * `#/sessions/locks` — every phase claim this console can see (#24; 7.0,
 * quiet-console phase 15).
 *
 * ```
 * Locks                                                        Every session
 * 1 lapsed and still on disk, 1 holding up other work and 2 held.
 * Sessions 6   Locks 4
 * [Find a claim…]  Filter  View Held now                         ⋯  Everything
 * State                 Phase                       Holder                    Lease      Release
 * Lapsed, still on disk quiet-console P15 Sessions… autopilot/a0de94f27bb4    lapsed     [ Release ]
 * Holding up 2          pe-hub P9 The library        mobin@mac (a person)      1h left    [ Release ]
 * ```
 *
 * The lock decides whether a phase may board, and "why is this phase not
 * starting?" used to take the queue, a shelled `phase-lock.sh status`, the
 * lock files and `ps`. This is one read of `GET /api/locks`, in the order the
 * server ranks it — a lapsed claim still on disk first (it holds for no
 * reason), then a live one holding something up, then a live one holding up
 * nothing — narrowed BY THE SERVER to the held claims, the lapsed ones or one
 * repository's (`?held`, `?lapsed`, `?scope`), with the one Release every
 * other surface uses. The ledger of every claim since (Pro) is the section's
 * second view, at its own address.
 */

import { useMemo, useState } from 'react';
import type { LockFilter, LockRow } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { releaseRefusal, useLockRelease, useLocks } from '@/data/plans';
import { countdown, holderEtaText, plural } from '@/lib/format';
import { Button, Empty, Mono, Page, RelativeTime, Skeleton, useEverything, type Everything } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { NativeSelect } from '@/ui/native-select';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { OpsStatus } from '@/ui/status';
import { Toolbar, type ToolbarSlot, type ToolbarVerb } from '@/ui/toolbar';
import { locksViewOf, phaseHref, sessionsHref, sessionsLocksHref, type Route } from '@/shell/routes';
import { SessionsSections, useSessionRows } from './sections';

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

/** Which claims the server is asked for. */
type LockState = 'any' | 'held' | 'lapsed';

const STATES: readonly { id: LockState; label: string; blurb: string }[] = [
  { id: 'any', label: 'Every claim', blurb: 'Held and lapsed alike, worst first.' },
  { id: 'held', label: 'Held', blurb: 'Claims whose lease still runs and whose session lives.' },
  {
    id: 'lapsed',
    label: 'Lapsed',
    blurb: 'Past their lease, or their session ended — still on disk, holding for no reason.',
  },
];

/** What a claim is doing to the rest of the machine, in words. */
export function lockStateText(row: Pick<LockRow, 'lapsed' | 'blocking'>): string {
  if (row.lapsed) return 'Lapsed, still on disk';
  return row.blocking.length ? `Holding up ${row.blocking.length}` : 'Held';
}

/** Who holds it: the autopilot of a run, or a person by hand. */
function holderText(row: Pick<LockRow, 'holderKind' | 'runId'>): string {
  return row.holderKind === 'autopilot'
    ? `the autopilot${row.runId ? ` of run ${row.runId}` : ''}`
    : 'a person';
}

/** The claims at a glance, only the figures that are not zero. */
export function lockSituation(rows: readonly Pick<LockRow, 'lapsed' | 'blocking'>[]): string {
  let lapsed = 0;
  let holding = 0;
  let held = 0;
  for (const row of rows) {
    if (row.lapsed) lapsed++;
    else if (row.blocking.length) holding++;
    else held++;
  }
  const parts = [
    lapsed ? `${lapsed} lapsed and still on disk` : '',
    holding ? `${holding} holding up other work` : '',
    held ? `${held} held` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

/** The scopes the claims name, for the scope filter — read off the UNFILTERED list. */
export function lockScopes(rows: readonly Pick<LockRow, 'scope'>[]): string[] {
  return [...new Set(rows.flatMap((row) => row.scope))].sort((a, b) => a.localeCompare(b));
}

/** Free text over everything that tells two claims apart. */
function matches(row: LockRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [
    row.slug,
    `P${row.phase}`,
    row.phaseTitle,
    row.owner,
    row.host,
    row.session,
    row.branch,
    row.worktree,
    row.runId,
    ...row.scope,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/* ------------------------------------------------------------------ *
 * The columns
 * ------------------------------------------------------------------ */

const none = <span className="text-ink-faint">—</span>;

/** The entries a claim holds up, as links — the list itself, never a count behind a hover. */
function HeldUp({ blocked }: { blocked: readonly { slug: string; phase: number | null }[] }) {
  if (!blocked.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5" data-testid="lock-blocks">
      {blocked.map((one) =>
        one.phase === null ? (
          <span key={one.slug} className="text-ink-muted">
            {one.slug}
          </span>
        ) : (
          <a
            key={`${one.slug}/${one.phase}`}
            className="text-ink underline-offset-2 hover:underline"
            href={phaseHref(one.slug, one.phase)}
          >
            {one.slug} P{one.phase}
          </a>
        ),
      )}
    </span>
  );
}

/** Release: plain on a lapsed claim; behind a confirm that names the holder on a live one. */
function Release({ row, allowWrites }: { row: LockRow; allowWrites: boolean }) {
  const { release, busy } = useLockRelease();
  const refusal = releaseRefusal(allowWrites);
  const name = `${row.slug} P${row.phase}`;
  if (row.lapsed) {
    return (
      <Button
        size="sm"
        disabled={Boolean(refusal) || busy}
        title={refusal ?? `Release the lapsed claim on ${name}`}
        onClick={() => void release(row.slug, row.phase)}
      >
        Release
      </Button>
    );
  }
  const left = countdown(row.leaseUntil);
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      disabled={Boolean(refusal)}
      busy={busy}
      destructive
      title={`Release ${name} while it is held?`}
      confirmLabel="Release the claim anyway"
      cancelLabel="Leave it held"
      description={
        <>
          It is held by <Mono value={row.owner} />
          {row.host ? ` on ${row.host}` : ''}
          {row.claimedAt ? (
            <>
              , claimed <RelativeTime at={row.claimedAt} />
            </>
          ) : null}
          {left && left !== 'expired' ? `, and its lease runs ${left.replace(/ left$/, '')} more` : ''}.
          Booting a second session into this phase is how two agents overwrite each other: release it only if
          you know that session has stopped. The console records every forced release.
        </>
      }
      onConfirm={() => void release(row.slug, row.phase, true)}
    >
      Release
    </ConfirmButton>
  );
}

function lockColumns(allowWrites: boolean): Column<LockRow>[] {
  return [
    {
      id: 'state',
      head: 'State',
      priority: 1,
      // "Lapsed, still on disk" on one line — a claim's state is its first fact.
      min: 168,
      card: 'meta',
      value: (row) => lockStateText(row),
      cell: (row) => (
        <span className={row.lapsed ? 'font-medium break-words text-ink' : 'break-words text-ink-muted'}>
          {lockStateText(row)}
        </span>
      ),
    },
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 200,
      flex: true,
      identity: true,
      card: 'title',
      value: (row) => `${row.slug} P${row.phase}`,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="break-words text-ink">
            {row.slug} P{row.phase}
          </span>
          {row.phaseTitle && <span className="break-words text-meta text-ink-muted">{row.phaseTitle}</span>}
        </span>
      ),
    },
    {
      id: 'holder',
      head: 'Holder',
      priority: 2,
      // `autopilot/<run id>`, the commonest holder, on one line — at 200 its last character wrapped alone.
      min: 224,
      value: (row) => row.owner,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <Mono value={row.owner} className="wrap-anywhere" />
          <span className="text-meta text-ink-muted">{holderText(row)}</span>
        </span>
      ),
    },
    {
      id: 'lease',
      head: 'Lease',
      priority: 2,
      min: 96,
      card: 'meta',
      value: (row) => (row.lapsed ? 0 : (row.leaseUntil ?? null)),
      cell: (row) => (row.lapsed ? 'lapsed' : countdown(row.leaseUntil) || none),
    },
    {
      id: 'release',
      head: 'Release',
      priority: 1,
      min: 104,
      align: 'end',
      card: 'action',
      value: () => null,
      cell: (row) => <Release row={row} allowWrites={allowWrites} />,
    },

    /* ---- Everything ---- */
    {
      id: 'blocks',
      head: 'Holding up',
      min: 180,
      everything: true,
      value: (row) => row.blocking.length,
      cell: (row) => (row.blocking.length ? <HeldUp blocked={row.blocking} /> : none),
    },
    {
      id: 'session',
      head: 'Session',
      min: 176,
      everything: true,
      value: (row) => row.session ?? null,
      cell: (row) =>
        row.session ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <Mono value={row.session} chars={12} copyable />
            <OpsStatus vocab="presence" word={row.presence} />
          </span>
        ) : (
          <span className="text-ink-muted">none named</span>
        ),
    },
    {
      id: 'scope',
      head: 'Scope',
      min: 140,
      everything: true,
      value: (row) => row.scope.join(', ') || null,
      cell: (row) =>
        row.scope.length ? (
          <Mono value={row.scope.join(', ')} className="wrap-anywhere" />
        ) : (
          // A claim that names no scope collides with every other.
          <span className="text-ink-muted">everything</span>
        ),
    },
    {
      id: 'where',
      head: 'Branch and tree',
      min: 200,
      everything: true,
      value: (row) => row.branch ?? row.worktree ?? null,
      cell: (row) =>
        row.branch || row.worktree ? (
          <span className="flex min-w-0 flex-col">
            {row.branch && <Mono value={row.branch} className="wrap-anywhere" />}
            {row.worktree && <Mono value={row.worktree} className="wrap-anywhere text-ink-muted" />}
          </span>
        ) : (
          <span className="text-ink-muted">not said</span>
        ),
    },
    {
      id: 'claimed',
      head: 'Claimed',
      min: 136,
      everything: true,
      value: (row) => row.claimedAt ?? null,
      cell: (row) => (row.claimedAt ? <RelativeTime at={row.claimedAt} /> : none),
    },
    {
      id: 'host',
      head: 'Host',
      min: 120,
      everything: true,
      value: (row) => row.host ?? null,
      cell: (row) => (row.host ? <Mono value={row.host} className="wrap-anywhere" /> : none),
    },
    {
      id: 'eta',
      head: 'Time left',
      min: 180,
      everything: true,
      value: (row) => holderEtaText(row.eta, row.phase) || null,
      cell: (row) => {
        const text = holderEtaText(row.eta, row.phase);
        return text ? <span className="break-words">{text}</span> : none;
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

/** What the section can show: the claims now and — Pro — the ledger of every claim since. */
function viewsOf(): { id: 'held' | 'history'; label: string }[] {
  const views: { id: 'held' | 'history'; label: string }[] = [{ id: 'held', label: 'Held now' }];
  return views;
}

function ViewLinks({ current }: { current: 'held' | 'history' }) {
  return (
    <nav
      aria-label="What the locks show"
      className="flex min-w-0 items-center gap-1"
      data-testid="locks-view"
    >
      {viewsOf().map((one) => (
        <Button
          key={one.id}
          size="sm"
          variant="ghost"
          asChild
          className={one.id === current ? 'text-ink' : undefined}
        >
          <a href={sessionsLocksHref(one.id)} aria-current={one.id === current ? 'page' : undefined}>
            {one.label}
          </a>
        </Button>
      ))}
    </nav>
  );
}

function StatePanel({ value, onChange }: { value: LockState; onChange: (state: LockState) => void }) {
  return (
    <RadioGroup
      aria-label="Which claims"
      value={value}
      onValueChange={(next) => onChange(next as LockState)}
      data-testid="locks-filter-state"
    >
      {STATES.map((state) => (
        <RadioItem
          key={state.id}
          id={`locks-state-${state.id}`}
          value={state.id}
          label={state.label}
          description={state.blurb}
        />
      ))}
    </RadioGroup>
  );
}

export default function LocksSection({ route }: { route: Route }) {
  const { data: state } = useConsoleState();
  const allowWrites = state?.allowWrites === true;
  const { rows: sessions } = useSessionRows(state);
  const everything = useEverything('locks');
  const { releaseLapsed, busy } = useLockRelease();
  const views = viewsOf();
  const view = views.some((one) => one.id === locksViewOf(route)) ? locksViewOf(route) : 'held';

  // Per visit: a claim filter that survived a reload is how a held phase goes unseen for a week.
  const [query, setQuery] = useState('');
  const [which, setWhich] = useState<LockState>('any');
  const [scope, setScope] = useState('');
  const filter: LockFilter = {
    ...(which === 'held' ? { held: true as const } : which === 'lapsed' ? { lapsed: true as const } : {}),
    ...(scope ? { scope } : {}),
  };
  const all = useLocks();
  const narrowed = useLocks(filter, which !== 'any' || Boolean(scope));
  const source = which !== 'any' || scope ? narrowed : all;
  const allRows = useMemo(() => all.data?.rows ?? [], [all.data]);
  const rows = useMemo(
    () => (source.data?.rows ?? []).filter((row) => matches(row, query)),
    [source.data, query],
  );
  const scopes = useMemo(() => lockScopes(allRows), [allRows]);
  const lapsed = allRows.filter((row) => row.lapsed).length;
  const filtering = Number(which !== 'any') + Number(Boolean(scope));
  const clear = () => {
    setQuery('');
    setWhich('any');
    setScope('');
  };

  const verbs: ToolbarVerb[] = [
    {
      id: 'release-lapsed',
      label: lapsed ? `Release every lapsed claim (${lapsed})` : 'Release every lapsed claim',
      onSelect: () => void releaseLapsed(),
      ...(releaseRefusal(allowWrites)
        ? { disabled: releaseRefusal(allowWrites)! }
        : !lapsed
          ? { disabled: 'No claim has lapsed.' }
          : busy
            ? { disabled: 'A release is in flight.' }
            : {}),
    },
  ];
  if (filtering || query.trim()) verbs.push({ id: 'clear', label: 'Clear the filters', onSelect: clear });

  const filterSlot: ToolbarSlot = {
    ...(filtering
      ? {
          value: [which !== 'any' ? STATES.find((s) => s.id === which)?.label : '', scope]
            .filter(Boolean)
            .join(', '),
        }
      : {}),
    active: filtering,
    panel: (
      <div className="flex min-w-0 flex-col gap-3" data-testid="locks-filter">
        <StatePanel value={which} onChange={setWhich} />
        {(scopes.length > 0 || scope) && (
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            Scope
            <NativeSelect
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="w-full max-w-none"
              data-testid="locks-filter-scope"
            >
              <option value="">Any repository</option>
              {scopes.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
      </div>
    ),
  };

  const hidden = Math.max(0, allRows.length - rows.length);
  return (
    <Page
      title="Locks"
      lead={lockSituation(allRows) || undefined}
      actions={
        <Button size="sm" variant="ghost" asChild>
          <a href={sessionsHref()}>Every session</a>
        </Button>
      }
      data-testid="locks-section"
    >
      <SessionsSections current="locks" sessions={sessions.length} />
      <Toolbar
        label="Locks"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Find a claim',
          label: 'Find a claim by plan, phase, holder, host, branch or scope',
        }}
        {...(view === 'held' ? { filter: filterSlot } : {})}
        {...(views.length > 1
          ? {
              view: {
                value: views.find((one) => one.id === view)?.label ?? '',
                panel: <ViewLinks current={view} />,
                inline: <ViewLinks current={view} />,
              },
            }
          : {})}
        more={verbs}
        everything={everything}
        note={
          <>
            {!allowWrites && <span className="min-w-0">{releaseRefusal(false)}</span>}
            {view === 'held' && (filtering || query.trim()) && hidden > 0 ? (
              <>
                <span className="min-w-0" data-testid="locks-filtered">
                  Showing {rows.length} of {plural(allRows.length, 'claim')}: {hidden} hidden by the filters.
                </span>
                <Button size="sm" variant="ghost" onClick={clear}>
                  Clear the filters
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {view === 'held' && (
        <Claims
          loading={source.isLoading}
          error={source.error}
          rows={rows}
          any={allRows.length > 0}
          everything={everything}
          allowWrites={allowWrites}
          onClear={clear}
        />
      )}
    </Page>
  );
}

function Claims({
  loading,
  error,
  rows,
  any,
  everything,
  allowWrites,
  onClear,
}: {
  loading: boolean;
  error: Error | null;
  rows: readonly LockRow[];
  /** Whether any claim exists at all, before the filters. */
  any: boolean;
  everything: Everything;
  allowWrites: boolean;
  onClear: () => void;
}) {
  const columns = useMemo(() => lockColumns(allowWrites), [allowWrites]);
  if (error) return <Empty title={`The claims could not be read: ${error.message}`} />;
  if (loading && !rows.length) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </div>
    );
  }
  // No claims, no table: a header over nothing is a frame with no picture.
  if (!rows.length) {
    return any ? (
      <Empty
        title="No claim matches the filters."
        action={
          <Button size="sm" onClick={onClear}>
            Clear the filters
          </Button>
        }
      />
    ) : (
      <Empty title="No phase is claimed right now. A claim shows here the moment a session takes one, from this console or by hand." />
    );
  }
  return (
    <Grid
      columns={columns}
      rows={rows}
      getRowKey={(row) => `${row.slug}/${row.phase}`}
      label="Phase claims"
      tableId="locks"
      everything={everything}
      rowHref={(row) => phaseHref(row.slug, row.phase)}
      rowProps={(row) => ({
        'data-lock': `${row.slug}/${row.phase}`,
        'data-lapsed': row.lapsed ? '' : undefined,
      })}
    />
  );
}

