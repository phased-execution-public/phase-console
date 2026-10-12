/**
 * The run's journal — what the RUNNER did, filterable and deep-linkable (7.0,
 * quiet-console phase 11; the 6.x journal card before it).
 *
 * ```
 * 312 entries, 4 shown                                  [Filter the journal…]
 * 14:07:52  P4  Working in a checkout of its own at … on pe/demo-p4.      #312
 * 14:06:10  P4  phase.board  attempt=1 model=opus                         #311
 * Show 100 older
 * ```
 *
 * A session's console shows what the SESSION said; the journal shows what the
 * runner did — boarded a phase, verified it, parked it, climbed a rung, noticed
 * a stall, ingested a ruling — and it is the only one of the two that survives
 * the process. When a run did something surprising three hours ago, this is the
 * record that still has it.
 *
 * One line per entry, newest first: the clock, the phase, and the entry in
 * words when this build knows the event (`sentence`), else its name and its
 * payload as the machine wrote them. The lines sit in ordinary flow — the shell
 * owns the one scroller — so the DOM is bounded by a PAGE and an explicit
 * "older" step rather than by a scroller of its own.
 *
 * Every line has an address. `seq` is per run and monotonic, so `?j=<seq>`
 * names one entry for as long as the run exists — the server's notification
 * links and the Now panel write it. A linked line is marked, brought into view
 * once, kept through any filter and inside the page that is drawn: a link that
 * silently resolved to nothing because a filter was set, or because the line
 * sat on an older page, is worse than no link.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JournalEntry } from '@/data/api';
import { cn } from '@/lib/cn';
import { clockTime, plural } from '@/lib/format';
import { scrollIntoScroller } from '@/lib/scroll';
import { Button, Empty, Input, Mono, copy } from '@/ui';
import { useRoute } from '@/shell/router';
import { parseHash, withQuery, type Route } from '@/shell/routes';

/** The query key a journal permalink rides on. */
export const JOURNAL_PARAM = 'j';

/** How many entries are drawn before the reader asks for older ones. */
export const PAGE = 100;

/** A seq as an address carries it: a whole number, or none at all. */
function seqOf(raw: string | null | undefined): number | null {
  return raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** The same route with `?j=<seq>` on it, everything else it carried kept. */
function hrefFor(route: Route, seq: number): string {
  return withQuery(route, { ...route.query, [JOURNAL_PARAM]: seq });
}

/** The entry a permalink names, or null. */
export function linkedSeq(hash: string = window.location.hash): number | null {
  return seqOf((parseHash(hash) as Route).query[JOURNAL_PARAM]);
}

/** The same address with `?j=<seq>` on it. */
export function journalHref(seq: number, hash: string = window.location.hash): string {
  return hrefFor(parseHash(hash) as Route, seq);
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * One entry's searchable text: the event name, the phase as the line draws it,
 * the seq, the flattened data — and the rendered sentence, so the filter matches
 * what the reader can SEE. A line that says "would not merge" and cannot be
 * found by typing "merge" teaches the operator that the filter is unreliable.
 */
export function entryText(entry: JournalEntry): string {
  const data = entry.data
    ? Object.entries(entry.data)
        .map(([key, value]) => `${key} ${stringify(value)}`)
        .join(' ')
    : '';
  const phase = entry.phase != null ? `phase ${entry.phase} p${entry.phase}` : '';
  const said = sentence(entry) ?? '';
  return `${entry.event} #${entry.seq} ${phase} ${data} ${said}`.toLowerCase();
}

/**
 * The filter, as a pure function. `linked` is always kept (see the header); an
 * empty needle keeps everything, so the caller never special-cases it.
 */
export function filterEntries(
  entries: readonly JournalEntry[],
  needle: string,
  linked: number | null,
): JournalEntry[] {
  if (!needle) return [...entries];
  const q = needle.toLowerCase();
  return entries.filter((entry) => entry.seq === linked || entryText(entry).includes(q));
}

/* ------------------------------------------------------------------ *
 * Word renderings
 * ------------------------------------------------------------------ */

/** A field, as a trimmed string — '' for anything that is not one. */
function text(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return typeof value === 'object' ? '' : String(value).trim();
}

/** A field, as a number — `null` for anything that is not one. */
function count(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}

/**
 * The events this build can say in words — the worktree family, the
 * silent-session watchdog and the freeze that stopped nothing.
 *
 * Two rules hold it honest:
 *
 *   - **A sentence is a claim, so it may only use fields the writer wrote.**
 *     Every read goes through `text`/`count`, which answer '' / null for a
 *     record written by another version rather than printing `undefined` into
 *     prose. A missing field costs the sentence a clause; it never invents one.
 *   - **An unknown event keeps the generic fall-through.** `null` is how an
 *     event this build has never heard of still renders its payload — a default
 *     sentence would make a new event look handled and lose its data. The set
 *     of events grows every phase; the renderer must not be what has to keep up.
 *
 * Exported for its test: a pure function of one entry.
 */
export function sentence(entry: JournalEntry): string | null {
  const data = entry.data ?? {};
  switch (entry.event) {
    case 'run.frozen-idle': {
      // The closing line of a run whose freeze stopped nothing. By the time it
      // is written the freeze is spent (the loop's own `finally` clears the
      // slot when no child survived), so the sentence must not promise a
      // ruling on it — see `runner-loop.ts`'s `frozen` branch.
      const phase = count(data, 'phase');
      return (
        `Frozen with nothing left running${phase == null ? '' : ` — phase ${phase} never started`}` +
        '. The run is paused; Continue picks it up from the next ready phase.'
      );
    }
    case 'phase.auto-nudged': {
      const detail = text(data, 'detail');
      // Two ladders write this event and they mean opposite things about the
      // session: the silent one is about a lane next in line to be recycled,
      // the local-job one about a lane that is WORKING and has merely put its
      // waiting inside the turn. Narrating the second as the first tells an
      // operator their healthy session is about to be killed.
      if (text(data, 'scope') === 'local') {
        return (
          `A Bash call has been open for a while waiting on a job this session started itself${
            detail ? ` (${detail})` : ''
          } — so the console wrote to the session the way an operator would: background the job and ` +
          'carry on. Nothing is killed; if the call is still open much later the phase parks, and ' +
          "the loop's own condition comes with it as a watch ref."
        );
      }
      return (
        `Ten minutes in with nothing produced at all${detail ? ` (${detail})` : ''}, and no tool ` +
        'call has ever opened — so the console wrote to the session itself, the way an operator ' +
        'would. If it is still silent five minutes from now the session is recycled.'
      );
    }
    case 'phase.auto-nudge-refused': {
      const reason = text(data, 'reason');
      const which = text(data, 'scope') === 'local' ? 'waiting' : 'silent';
      return (
        `The console tried to write to this ${which} session and could not` +
        `${reason ? ` — ${reason}` : ''}. Nothing was sent, so nothing is counted against it: ` +
        'the nudge is still available the moment there is a session to nudge.'
      );
    }
    case 'phase.auto-recycled': {
      const session = text(data, 'sessionId');
      return (
        'The nudge did not wake it, so the session was ended and the phase re-boarded' +
        `${session ? ` on the same session id (${session.slice(0, 8)})` : ''}. ` +
        'Nothing was lost: it had made no tool call, spent nothing and left the tree clean.'
      );
    }
    case 'phase.stall-parked': {
      const need = text(data, 'need');
      return (
        'This phase went silent again with both automatic remedies already spent — it was ' +
        'nudged, and it was recycled, and it wedged the same way. It is parked rather than ' +
        `tried a third time${need ? ` — ${need}` : ''}. The rest of the run carries on; Retry ` +
        'clears the two remedies and lets them run once more.'
      );
    }
    case 'phase.worktree': {
      const dir = text(data, 'dir');
      const branch = text(data, 'branch');
      const into = text(data, 'into');
      return (
        `Working in a checkout of its own${dir ? ` at ${dir}` : ''}` +
        `${branch ? ` on ${branch}` : ''}` +
        `${into ? `, to be merged into ${into} when the phase settles` : ''}.`
      );
    }
    case 'phase.worktree-failed': {
      const detail = text(data, 'detail');
      return (
        `Could not create its own checkout${detail ? ` — ${detail}` : ''}. ` +
        'The phase runs in the run’s shared root instead, exactly as every run did ' +
        'before worktree lanes existed.'
      );
    }
    case 'phase.worktree-resynced': {
      const behind = count(data, 'behind');
      const gap =
        behind == null ? 'behind the run branch' : `${plural(behind, 'commit')} behind the run branch`;
      return data.merged === false
        ? `Its checkout was ${gap}, and merging the run branch forward into it did not land.`
        : `Its checkout was ${gap}, so the run branch was merged forward into it before the session boarded.`;
    }
    case 'phase.worktree-landed': {
      const branch = text(data, 'branch') || 'the lane branch';
      const into = text(data, 'into') || 'the run branch';
      const kind = text(data, 'kind');
      const detail = text(data, 'detail');
      if (kind === 'empty') return `${branch} had no commits to land, so ${into} is unchanged.`;
      if (kind === 'merged') {
        const commits = count(data, 'commits');
        const how = data.fastForward ? 'fast-forwarded' : 'merged';
        return (
          `${commits == null ? 'The lane’s commits' : plural(commits, 'commit')} from ${branch} ` +
          `${how} into ${into}.`
        );
      }
      if (kind === 'conflict') {
        const files = text(data, 'files');
        return (
          `${branch} would not merge into ${into}${detail ? `: ${detail}` : ''}. ` +
          `The merge was aborted and nothing was lost — every commit is still on ${branch}` +
          `${files ? `. Conflicted: ${files}` : ''}.`
        );
      }
      if (kind === 'failed') return `Landing ${branch} into ${into} failed${detail ? `: ${detail}` : ''}.`;
      // A kind this build has never heard of is an event shape it does not
      // know: guessing would report a conflict as a merge.
      return null;
    }
    case 'run.isolation': {
      const checkout = text(data, 'checkout');
      const refusal = text(data, 'refusal');
      const reason = text(data, 'reason');
      const dir = text(data, 'dir');
      const branch = text(data, 'branch');
      const mounts = Array.isArray(data.mounts) ? (data.mounts as unknown[]).map(String) : [];
      const skipped = Array.isArray(data.skipped) ? (data.skipped as unknown[]).map(String) : [];
      if (checkout === 'refused') {
        return (
          `Asked for its own checkout and was refused${refusal ? ` — ${refusal}` : ''}` +
          `${reason ? `: ${reason}` : '.'}`
        );
      }
      if (mounts.length) {
        return (
          `Given a mirror checkout${dir ? ` at ${dir}` : ''}${branch ? ` on ${branch}` : ''}, ` +
          `one worktree per scoped repository: ${mounts.join(', ')}.` +
          `${skipped.length ? ` Not mounted (uninitialized): ${skipped.join(', ')}.` : ''}`
        );
      }
      return `Given a checkout of its own${dir ? ` at ${dir}` : ''}${branch ? ` on ${branch}` : ''}.`;
    }
    case 'run.settle-unsupported': {
      const strategy = text(data, 'strategy');
      const mounts = Array.isArray(data.mounts) ? (data.mounts as unknown[]).length : 0;
      return (
        `The ${strategy || 'chosen'} settle cannot span the ${mounts || 'several'} repositories ` +
        'this run’s mirror mounts, so the branches were left as they stand in each — merge by ' +
        'hand, or use the pr settle.'
      );
    }
    case 'run.worktree-unavailable': {
      const reason = text(data, 'reason') || text(data, 'refusal');
      return (
        `Worktree lanes are not available for this run${reason ? ` — ${reason}` : ''}. ` +
        'Every phase shares the run’s root; nothing else changes.'
      );
    }
    case 'run.worktrees-pruned': {
      const error = text(data, 'error');
      if (error) return `Removing this run’s lane checkouts failed: ${error}. They are still on disk.`;
      const removed = count(data, 'removed');
      const kept = count(data, 'kept');
      const first =
        removed == null ? 'Removed this run’s lane checkouts' : `Removed ${plural(removed, 'lane checkout')}`;
      return kept
        ? `${first}; kept ${kept} that still hold commits the run branch does not have.`
        : `${first}.`;
    }
    case 'phase.shared-checkout': {
      const holders = text(data, 'holders');
      const scope = text(data, 'scope');
      return (
        `Another session is live in this checkout${holders ? ` (${holders})` : ''}, so the session ` +
        'was told to work in a linked worktree rather than switch branches under it' +
        `${scope ? `. Scope: ${scope}` : ''}.`
      );
    }
    case 'run.branch-mismatch': {
      const plan = text(data, 'plan');
      const run = text(data, 'run');
      return (
        `The plan’s §Session budget names ${plan || 'a different branch'}, but this run works on ` +
        `${run || 'its own run branch'}. The session is told, and nothing is changed for it.`
      );
    }
    default:
      return null;
  }
}

/** `key=value` pairs, bounded — a journal line is a summary, not a payload dump. */
function summarise(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => `${key}=${stringify(value).slice(0, 120)}`)
    .join('  ');
}

/**
 * A line's clock: the wall time, which lines five hundred entries up against
 * each other, with the day in front once the entry is not from today. The
 * whole moment is the title.
 */
function stampOf(ms: number): string {
  const at = new Date(ms);
  if (at.toDateString() === new Date().toDateString()) return clockTime(ms);
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clockTime(ms)}`;
}

/* ------------------------------------------------------------------ *
 * The journal
 * ------------------------------------------------------------------ */

export function RunJournal({ entries, className }: { entries: readonly JournalEntry[]; className?: string }) {
  const route = useRoute();
  const routed = seqOf(route.query[JOURNAL_PARAM]);
  // A line pressed here is marked without moving the address; an address that
  // changes afterwards (a notification followed) wins over the press.
  const [pressed, setPressed] = useState<{ seq: number; over: number | null } | null>(null);
  const linked = pressed && pressed.over === routed ? pressed.seq : routed;
  const [needle, setNeedle] = useState('');
  const [pages, setPages] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<number | null>(null);

  const filter = needle.trim();
  // Newest first: a journal is read from the end.
  const shown = useMemo(
    () => filterEntries(entries, filter, linked).sort((a, b) => b.seq - a.seq),
    [entries, filter, linked],
  );
  // The page that holds the linked line is drawn, however far back it sits.
  const linkedAt = linked == null ? -1 : shown.findIndex((entry) => entry.seq === linked);
  const drawn = Math.max(pages, linkedAt < 0 ? 1 : Math.floor(linkedAt / PAGE) + 1);
  const visible = useMemo(() => shown.slice(0, drawn * PAGE), [shown, drawn]);
  const missing = routed != null && entries.length > 0 && !entries.some((entry) => entry.seq === routed);

  // Brought into view once per address, never again while the reader is
  // elsewhere on the page — a live journal grows every few seconds, and a page
  // that yanked back to the linked line on each append could not be read.
  useEffect(() => {
    if (routed == null || scrolledTo.current === routed) return;
    const line = box.current?.querySelector(`[data-seq="${routed}"]`);
    if (!line) return;
    scrolledTo.current = routed;
    scrollIntoScroller(line);
  }, [routed, visible]);

  if (!entries.length) {
    return (
      <Empty
        className={className}
        data-testid="journal-empty"
        title="The run has written nothing to its journal yet."
      />
    );
  }

  const copyLink = (seq: number) => {
    setPressed({ seq, over: routed });
    void copy(new URL(hrefFor(route, seq), window.location.href).toString(), 'Link copied');
  };
  const clear = () => {
    setNeedle('');
    setPages(1);
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)} data-testid="run-journal">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p data-testid="journal-count" className="text-meta text-ink-muted tnum">
          {plural(entries.length, 'entry', 'entries')}
          {filter && shown.length !== entries.length ? `, ${shown.length} shown` : ''}
        </p>
        <Input
          type="search"
          value={needle}
          aria-label="Filter the journal"
          placeholder="Filter by event, phase or words"
          className="w-full sm:w-72"
          onChange={(event) => {
            setNeedle(event.currentTarget.value);
            setPages(1);
          }}
        />
      </div>
      {missing && (
        <p data-testid="journal-missing" className="text-meta text-ink-muted">
          This address names entry #{routed}, which is not among these{' '}
          {plural(entries.length, 'entry', 'entries')}.
        </p>
      )}
      {visible.length === 0 ? (
        <Empty
          data-testid="journal-no-match"
          title={`Nothing in the journal matches “${filter}”.`}
          action={
            <Button size="sm" onClick={clear}>
              Show all {plural(entries.length, 'entry', 'entries')}
            </Button>
          }
        />
      ) : (
        <div ref={box} role="log" aria-label="Run journal">
          <ol className="flex min-w-0 flex-col">
            {visible.map((entry) => (
              <JournalLine key={entry.seq} entry={entry} marked={linked === entry.seq} onCopy={copyLink} />
            ))}
          </ol>
        </div>
      )}
      {visible.length > 0 && visible.length < shown.length && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setPages(drawn + 1)}>
          Show {Math.min(PAGE, shown.length - visible.length)} older
        </Button>
      )}
    </div>
  );
}

function JournalLine({
  entry,
  marked,
  onCopy,
}: {
  entry: JournalEntry;
  marked: boolean;
  onCopy: (seq: number) => void;
}) {
  const at = Date.parse(entry.time);
  // Words when this build knows the event, its name and payload when it does
  // not — never both: the sentence exists to SAY what the pairs only imply.
  const said = sentence(entry);
  const summary = !said && entry.data ? summarise(entry.data) : '';
  return (
    <li
      data-seq={entry.seq}
      data-marked={marked ? '' : undefined}
      aria-current={marked ? 'true' : undefined}
      className={cn(
        'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-sm border-s-2 py-1 ps-2',
        marked ? 'border-ink bg-surface-raised' : 'border-transparent',
      )}
    >
      {Number.isFinite(at) ? (
        <time
          dateTime={new Date(at).toISOString()}
          title={new Date(at).toLocaleString()}
          className="text-meta text-ink-faint tnum"
        >
          {stampOf(at)}
        </time>
      ) : (
        <span className="text-meta text-ink-faint">—</span>
      )}
      <p className="min-w-0 break-words text-body text-ink">
        {entry.phase != null && <span className="me-2 text-meta text-ink-muted tnum">P{entry.phase}</span>}
        {said != null ? (
          <span title={entry.event}>{said}</span>
        ) : (
          <>
            <Mono value={entry.event} className="text-ink" />
            {summary && (
              <>
                {' '}
                <Mono value={summary} className="wrap-anywhere" />
              </>
            )}
          </>
        )}
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="tnum"
        title="Copy a link to this entry"
        aria-label={`Copy a link to entry #${entry.seq}`}
        onClick={() => onCopy(entry.seq)}
      >
        #{entry.seq}
      </Button>
    </li>
  );
}
