/**
 * A session's door and how it ended (zero-touch phase 19; chapter 02 SLF-1).
 *
 * For a session the console started against a run — a repair, a QA round, a
 * ladder rung — the run's own ledger names the door that started it and, once it
 * has ended, how it ended and what it cost. The same words the run page's ledger
 * shows, read from the same journal, so a session page and its run cannot
 * disagree about why the session exists. A session that belongs to no run (a
 * shell, a plan wizard) shows nothing here: its door is the person who opened it.
 */

import { Chip } from '@/components/ui';
import type { TerminalSession } from '@/lib/api';
import { money } from '@/lib/format';
import { useLedger } from '@/lib/queries';

export function SessionLedger({ session }: { session: TerminalSession }) {
  const meta = session.meta;
  const slug = meta?.recovery?.slug ?? meta?.qa?.slug;
  const runId = meta?.recovery?.runId ?? undefined;
  const phase = meta?.recovery?.phase ?? meta?.qa?.phase;
  const { data: ledger } = useLedger(slug, runId, Boolean(slug));
  if (!slug || !ledger) return null;

  const newestFirst = [...ledger.starts].reverse();
  const started =
    newestFirst.find(
      (start) => start.event === 'phase.session-start' && (phase == null || start.phase === phase),
    ) ?? newestFirst.find((start) => start.event === 'run.start');
  const claude = meta?.claudeSessionId;
  const ended = claude ? ledger.sessions.find((entry) => entry.sessionId === claude) : undefined;
  if (!started?.door && !ended) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="session-ledger">
      {started?.door && (
        <Chip mono title={`${started.said}${started.trigger ? ` · fired by ${started.trigger}` : ''}`}>
          door {started.door}
        </Chip>
      )}
      {ended && (
        <Chip
          title={`${ended.mode} · ${ended.turns ?? '?'} turns${ended.consoleEnded ? ' · ended by the console' : ''}`}
        >
          ended by {ended.endedBy ?? 'exit'}
          {ended.costUsd != null ? ` · ${money(ended.costUsd)}` : ' · cost unknown'}
        </Chip>
      )}
    </span>
  );
}
