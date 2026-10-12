/**
 * A session's door and how it ended (zero-touch phase 19; chapter 02 SLF-1).
 *
 * For a session the console started against a run — a repair, a QA round, a
 * ladder rung — the run's own ledger names the door that started it and, once
 * it has ended, how it ended and what it cost: the words the run's ledger
 * shows, read from the same journal, so a session and its run cannot disagree
 * about why the session exists. A session that belongs to no run (a shell, a
 * plan wizard) says nothing here: its door is the person who opened it.
 */

import type { TerminalSession } from '@/data/api';
import { useLedger } from '@/data/runs';
import { money } from '@/lib/format';
import type { KeyValueItem } from '@/ui';

/** The ledger's two facts as rows of the vitals — none when the session belongs to no run. */
export function useSessionLedger(session: TerminalSession): KeyValueItem[] {
  const meta = session.meta;
  const slug = meta?.recovery?.slug ?? meta?.qa?.slug;
  const runId = meta?.recovery?.runId ?? undefined;
  const phase = meta?.recovery?.phase ?? meta?.qa?.phase;
  const { data: ledger } = useLedger(slug, runId, Boolean(slug));
  if (!slug || !ledger) return [];

  const newestFirst = [...ledger.starts].reverse();
  const started =
    newestFirst.find(
      (start) => start.event === 'phase.session-start' && (phase == null || start.phase === phase),
    ) ?? newestFirst.find((start) => start.event === 'run.start');
  const claude = meta?.claudeSessionId;
  const ended = claude ? ledger.sessions.find((entry) => entry.sessionId === claude) : undefined;
  const items: KeyValueItem[] = [];
  if (started?.door) {
    const why = `${started.said}${started.trigger ? `, fired by ${started.trigger}` : ''}`;
    items.push([
      'Started by',
      <span key="door" title={why}>
        the {started.door} door
      </span>,
    ]);
  }
  if (ended) {
    const how = `${ended.mode}, ${ended.turns ?? '?'} turns${ended.consoleEnded ? ', ended by the console' : ''}`;
    items.push([
      'Ended',
      <span key="ended" title={how}>
        by {ended.endedBy ?? 'exit'}, {ended.costUsd != null ? money(ended.costUsd) : 'cost unknown'}
      </span>,
    ]);
  }
  return items;
}
