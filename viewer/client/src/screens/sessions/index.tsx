/**
 * Sessions — every process this console owns or can see (7.0, quiet-console
 * phase 15; one place since 3.0).
 *
 * ```
 * Sessions                                          [ New session ]  New shell
 * 1 needs you, 3 running and 2 ended.
 * Sessions 6   Locks 2
 * [Find a session…]  Filter  Group Kind  Sort Activity           ⋯  Everything
 * Autopilot lanes  2
 * ● Running                          quiet-console P15   Sessions and the terminal   4 minutes ago
 * ● Live │ needs your permission     pe-hub P9           ~/work/shop       1 minute ago
 * Shells  1
 * ○ Exited                           zsh                 /repo                       an hour ago
 * ```
 *
 * One question: what is running on this machine, and does any of it need me?
 * The lanes the autopilot runs, the shells and Claude sessions opened here,
 * and the sessions the presence hook reports — one line each (`model.ts`
 * folds the four kinds into one row), in the toolbar's grouping and order,
 * a summoned one first whatever the order. A line expands in place to its
 * verbs, inspects in the panel, and goes where the session lives.
 *
 * One place, four addresses: `#/sessions` the list, `#/sessions/locks` the
 * claims, `#/sessions/<id>` one session open — the terminal, owning its height
 * — and `?new=agent|shell` the launch door. The kind of an open session is
 * read off its record, never out of the address.
 */

import { useMemo, useState } from 'react';
import { useConsoleState } from '@/data/console';
import { usePrefs } from '@/lib/prefs';
import { Button, Empty, Page, Skeleton, useEverything } from '@/ui';
import { Toolbar } from '@/ui/toolbar';
import { sessionsNewHref, type Route } from '@/shell/routes';
import { NewSessionPage, NewShellPage, useOpenShell } from './launcher';
import { SessionList } from './list';
import LocksSection from './locks';
import {
  applyFilters,
  groupOf,
  isSortId,
  kindCounts,
  kindOf,
  situationWords,
  sortRows,
  type SessionFilters,
  type SessionSortId,
} from './model';
import { SessionsSections, capWords, useSessionRows } from './sections';
import SessionPage from './session-page';
import { SessionsToolbar } from './toolbar';

/** `?new=` — the only two things a person can start from here. */
function startingOf(route: Route): 'agent' | 'shell' | undefined {
  const value = route.query.new;
  return value === 'agent' || value === 'shell' ? value : undefined;
}

export default function SessionsPlace({ route }: { route: Route }) {
  const sessionId = route.segments[1];
  // `#/sessions/locks` is a section, not a session: an id is a UUID, never this word (#24).
  if (sessionId === 'locks') return <LocksSection route={route} />;
  if (sessionId) return <SessionPage sessionId={sessionId} />;
  const starting = startingOf(route);
  if (starting === 'agent') return <NewSessionPage />;
  if (starting === 'shell') return <NewShellPage />;
  return <SessionsList />;
}

function SessionsList() {
  const { data: state } = useConsoleState();
  const allowAgent = state?.allowAgent === true;
  const allowTerminal = state?.allowTerminal === true;
  const { rows, ready, atCap, limit } = useSessionRows(state);
  const shell = useOpenShell();
  const [prefs, setPrefs] = usePrefs();
  const everything = useEverything('sessions');

  // The words are a question asked a moment ago; the kind is a view left set.
  const [query, setQuery] = useState('');
  const filters: SessionFilters = useMemo(
    () => ({ query, kind: kindOf(prefs.sessionsKind) }),
    [query, prefs.sessionsKind],
  );
  const sort: SessionSortId = isSortId(prefs.sessionsSort) ? prefs.sessionsSort : 'activity';
  const group = groupOf(prefs.sessionsGroup);
  // Counted over everything, never over what a filter left: a kind that read
  // 0 because another is chosen would say this machine runs none of them.
  const counts = useMemo(() => kindCounts(rows), [rows]);
  const shown = useMemo(() => sortRows(applyFilters(rows, filters), sort), [rows, filters, sort]);

  const onFilters = (patch: Partial<SessionFilters>) => {
    if (patch.kind !== undefined) setPrefs({ sessionsKind: patch.kind });
    if (patch.query !== undefined) setQuery(patch.query);
  };
  const clear = () => {
    setQuery('');
    setPrefs({ sessionsKind: '' });
  };

  const situation = situationWords(rows);
  const lead = [situation, atCap && (allowAgent || allowTerminal) ? capWords(limit) : '']
    .filter(Boolean)
    .join(' ');

  const actions =
    allowAgent || allowTerminal ? (
      <>
        {allowAgent &&
          (atCap ? (
            <Button size="sm" variant="primary" disabled>
              New session
            </Button>
          ) : (
            <Button size="sm" variant="primary" asChild>
              <a href={sessionsNewHref('agent')} data-testid="new-session">
                New session
              </a>
            </Button>
          ))}
        {allowTerminal && (
          <Button
            size="sm"
            variant={allowAgent ? 'ghost' : 'primary'}
            disabled={atCap || shell.busy}
            onClick={shell.open}
            data-testid="new-shell"
          >
            {shell.busy ? 'Opening a shell…' : 'New shell'}
          </Button>
        )}
      </>
    ) : undefined;

  const narrowed = Boolean(filters.kind || query.trim());

  return (
    <Page title="Sessions" lead={lead || undefined} actions={actions} data-testid="sessions-list">
      <SessionsSections current="list" sessions={rows.length} />
      {!ready && !rows.length ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      ) : (
        <>
          {/* Controls only where there is something to control: one shell and
              nothing else is a list no search, filter, group or order can
              improve — but its line still folds facts away, so the third door
              stands over a list of one: the bar's last slot alone, and on a
              phone the View sheet with nothing in it but the switch. */}
          {rows.length > 1 || narrowed ? (
            <SessionsToolbar
              filters={filters}
              onFilters={onFilters}
              sort={sort}
              onSort={(id) => setPrefs({ sessionsSort: id })}
              group={group}
              onGroup={(next) => setPrefs({ sessionsGroup: next === 'kind' })}
              everything={everything}
              counts={counts}
              total={rows.length}
              shown={shown.length}
              onClear={clear}
              allowAgent={allowAgent}
            />
          ) : rows.length === 1 ? (
            <Toolbar label="Sessions" everything={everything} />
          ) : null}
          <SessionList
            rows={shown}
            by={group}
            everything={everything}
            sort={sort}
            onSort={(id) => setPrefs({ sessionsSort: id })}
            empty={
              rows.length ? (
                <Empty
                  title="Nothing matches the filters."
                  action={
                    <Button size="sm" onClick={clear}>
                      Clear the filters
                    </Button>
                  }
                />
              ) : allowAgent || allowTerminal ? (
                <Empty
                  title="Nothing is running: no lane, no session of yours, and no other Claude on this machine."
                  action={
                    allowTerminal ? (
                      <Button size="sm" disabled={atCap || shell.busy} onClick={shell.open}>
                        Open a shell
                      </Button>
                    ) : (
                      <Button size="sm" asChild>
                        <a href={sessionsNewHref('agent')}>Start a session</a>
                      </Button>
                    )
                  }
                />
              ) : (
                <Empty title="Nothing is running. This console opens no sessions of its own (no --allow-agent, no --allow-terminal); the autopilot's lanes appear here when they run." />
              )
            }
          />
        </>
      )}
    </Page>
  );
}
