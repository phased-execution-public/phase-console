/**
 * The journal: the run's audit trail, filterable and deep-linkable.
 *
 * The console shows what the SESSION said. The journal shows what the RUNNER
 * did — boarded a phase, verified it, parked it, climbed a rung, noticed a
 * stall, ingested a ruling — and it is the only one of the two that survives
 * the process. When a run did something surprising three hours ago, this is
 * the record that still has it; the console's buffer is long gone.
 *
 * ## Two renderings, because a phone must not nest a scroller
 *
 * Above the shell breakpoint the list is virtualized in its own bounded
 * scroller (`DataList`) — the desktop journal is a panel among panels and a
 * page that grows to five thousand rows is not readable.
 *
 * On a phone the shell owns the ONE scroller, and a second one inside it is
 * the thing that makes a page impossible to flick past. So the phone gets a
 * bounded PAGE instead of a bounded viewport: the newest `PAGE` entries in
 * ordinary flow, with an explicit "older" step. The DOM stays small for the
 * same reason virtualization keeps it small, without a nested scroll region.
 *
 * ## Every line has an address
 *
 * `seq` is per run and monotonic, so `?j=<seq>` names one entry for as long as
 * the run exists — a real permalink, unlike the console's `?line=`, which can
 * only promise as long as the buffer holds. A linked entry is scrolled to,
 * highlighted, and shown even when the current filter would hide it: a link
 * that silently resolved to nothing because a filter was set is worse than no
 * link.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataList,
  Empty,
  Input,
  RelativeTime,
  copy,
} from '@/components/ui';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
import { scrollIntoScroller } from '@/lib/scroll';
import type { JournalEntry } from '@/lib/api';

/** The query key a journal permalink rides on. */
export const JOURNAL_PARAM = 'j';

/** How many entries a phone renders before asking. */
export const PAGE = 100;

/** The entry a permalink names, or null. */
export function linkedSeq(hash: string = window.location.hash): number | null {
  const query = hash.split('?')[1];
  if (!query) return null;
  const raw = new URLSearchParams(query).get(JOURNAL_PARAM);
  const seq = raw == null ? NaN : Number(raw);
  return Number.isFinite(seq) ? seq : null;
}

/** The same address with `?j=<seq>` on it. */
export function journalHref(seq: number, hash: string = window.location.hash): string {
  const [path, query] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query ?? '');
  params.set(JOURNAL_PARAM, String(seq));
  return `#${path}?${params.toString()}`;
}

/**
 * One entry's searchable text: the event name, the phase, and the flattened
 * data. Kept out of the component because it runs once per entry per keystroke
 * and is the only thing in here worth memoising.
 */
export function entryText(entry: JournalEntry): string {
  const data = entry.data
    ? Object.entries(entry.data)
        .map(([k, v]) => `${k} ${stringify(v)}`)
        .join(' ')
    : '';
  // The rendered sentence too, so the filter matches what the reader can SEE.
  // A row that says "would not merge" and cannot be found by typing "merge"
  // teaches the operator that the filter is unreliable, which is worse than a
  // filter that never had words to match.
  const said = sentence(entry) ?? '';
  return `${entry.event} ${entry.phase != null ? `phase ${entry.phase}` : ''} ${data} ${said}`.toLowerCase();
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
 * The filter, as a pure function — what a test asserts without rendering.
 *
 * `linked` is always kept: see the header. An empty needle keeps everything,
 * so the caller never has to special-case it.
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The worktree family, in words.
 *
 * These eight events are the only record an operator ever gets of where a
 * session was actually editing — and `key=value  key=value` is the worst
 * possible rendering of exactly that question. `dir=~/…/worktrees/r7/p4
 * branch=pe/demo-p4 into=pe/demo` is three paths and no verb: it says what the
 * runner wrote down, never what it DID, and the reader has to know the feature
 * before the line means anything.
 *
 * Two rules hold this honest:
 *
 *   - **A sentence is a claim, so it may only use fields the writer wrote.**
 *     Every read goes through `text`/`count`, which answer '' / null for a
 *     record written by another version rather than printing `undefined` into
 *     prose. A missing field degrades the sentence; it never invents one.
 *   - **Unknown events keep the generic fall-through.** Returning `null` here
 *     is how an event this build has never heard of still renders its data —
 *     the alternative, a default sentence, would make a new event look handled
 *     and lose its payload. The set of events grows every phase; the renderer
 *     must not be the thing that has to keep up.
 *
 * Exported for its test: this is a pure function of one entry, and rendering a
 * whole virtualized journal to assert one sentence would test the list instead.
 */
export function sentence(entry: JournalEntry): string | null {
  const data = entry.data ?? {};
  switch (entry.event) {
    case 'run.frozen-idle': {
      // The closing line of a run whose freeze stopped nothing. Every other
      // ending gets a sentence and this one was landing as raw `key=value` —
      // legible to whoever wrote it and to nobody else. By the time it is
      // written the freeze is spent (the loop's own `finally` clears the slot
      // when no child survived), so the sentence must not promise a ruling on
      // it — see `runner-loop.ts`'s `frozen` branch.
      const phase = count(data, 'phase');
      return (
        `Frozen with nothing left running${phase == null ? '' : ` — phase ${phase} never started`}` +
        '. The run is paused; Continue picks it up from the next ready phase.'
      );
    }
    case 'phase.auto-nudged': {
      const detail = text(data, 'detail');
      // Two ladders write this event and they mean opposite things about the
      // session. The silent one is about a lane that has produced nothing and
      // is next in line to be recycled; the local-job one is about a lane that
      // is WORKING and has merely put its waiting inside the turn. Narrating
      // the second as the first tells an operator their healthy session is
      // about to be killed.
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
      const merged = data.merged;
      const gap =
        behind == null ? 'behind the run branch' : `${plural(behind, 'commit')} behind the run branch`;
      return merged === false
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
          `The merge was ABORTED and nothing was lost — every commit is still on ${branch}` +
          `${files ? `. Conflicted: ${files}` : ''}.`
        );
      }
      if (kind === 'failed') return `Landing ${branch} into ${into} failed${detail ? `: ${detail}` : ''}.`;
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
          `Given a MIRROR checkout${dir ? ` at ${dir}` : ''}${branch ? ` on ${branch}` : ''} — ` +
          `one worktree per scoped repository: ${mounts.join(', ')}.` +
          `${skipped.length ? ` Not mounted (uninitialized): ${skipped.join(', ')}.` : ''}`
        );
      }
      return `Given a checkout of its own${dir ? ` at ${dir}` : ''}` + `${branch ? ` on ${branch}` : ''}.`;
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

export function Journal({ entries, className }: { entries: readonly JournalEntry[]; className?: string }) {
  const phone = usePhone();
  const [needle, setNeedle] = useState('');
  const [page, setPage] = useState(1);
  const [linked, setLinked] = useState<number | null>(() => linkedSeq());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => setLinked(linkedSeq());
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Newest first: a journal is read from the end, and "scroll to the bottom to
  // see what just happened" is the thing every log viewer gets wrong.
  const shown = useMemo(
    () => filterEntries(entries, needle, linked).sort((a, b) => b.seq - a.seq),
    [entries, needle, linked],
  );
  const visible = phone ? shown.slice(0, page * PAGE) : shown;

  useEffect(() => {
    if (linked == null || !box.current) return;
    const el = box.current.querySelector(`[data-seq="${linked}"]`);
    // Desktop: the `DataList` scroller. Phone: the shell's one scroller, since
    // the phone rendering deliberately nests none. `scrollIntoScroller` finds
    // whichever it is and moves only that.
    if (el) scrollIntoScroller(el);
  }, [linked, visible.length]);

  const row = (entry: JournalEntry) => (
    <JournalRow entry={entry} linked={linked === entry.seq} onLink={setLinked} />
  );

  return (
    <Card className={className}>
      <CardHeader className="flex-wrap items-baseline gap-2">
        <CardTitle>Journal</CardTitle>
        <span className="grow text-2xs text-ink-faint">
          What the runner did — {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {needle && shown.length !== entries.length ? `, ${shown.length} shown` : ''}
        </span>
        <Input
          value={needle}
          aria-label="Filter the journal"
          placeholder="Filter…"
          className="h-7 w-40 text-2xs"
          onChange={(event) => {
            setNeedle(event.currentTarget.value);
            setPage(1);
          }}
        />
      </CardHeader>
      <CardBody>
        <div ref={box}>
          {visible.length === 0 ? (
            <Empty
              title={needle ? 'Nothing matches that' : 'No journal yet'}
              body={
                needle
                  ? 'The journal holds what the runner did — boarded, verified, parked, recovered. Try the phase number, or an event name like "phase.stall".'
                  : 'A run writes one line here for every decision it makes. It survives the process, which is what makes it the record worth reading when something happened hours ago.'
              }
              // The only act that can change this screen is the one that made
              // it empty. With no filter on there is genuinely nothing to press
              // — the journal fills itself as the run works — and offering a
              // button that does nothing is worse than offering none.
              action={
                needle && entries.length ? (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      setNeedle('');
                      setPage(1);
                    }}
                  >
                    Show all {entries.length} entries
                  </Button>
                ) : undefined
              }
            />
          ) : phone ? (
            <>
              <ol className="flex flex-col divide-y divide-rule">
                {visible.map((entry) => (
                  <li key={entry.seq}>{row(entry)}</li>
                ))}
              </ol>
              {visible.length < shown.length && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 w-full"
                  onClick={() => setPage((n) => n + 1)}
                >
                  Show {Math.min(PAGE, shown.length - visible.length)} older
                </Button>
              )}
            </>
          ) : (
            <DataList
              items={visible}
              role="log"
              label="Run journal"
              keyOf={(entry) => entry.seq}
              estimateRowHeight={38}
              rowClassName="border-b border-rule"
              renderRow={(entry) => row(entry)}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function JournalRow({
  entry,
  linked,
  onLink,
}: {
  entry: JournalEntry;
  linked: boolean;
  onLink: (seq: number) => void;
}) {
  const at = Date.parse(entry.time);
  // Words when this build knows the event, `key=value` when it does not. Never
  // both: the sentence exists to SAY what the pairs only imply, and printing
  // the pairs underneath would leave the row exactly as unreadable as before.
  const said = sentence(entry);
  const detail = said ?? (entry.data ? summarise(entry.data) : '');
  return (
    <div
      data-seq={entry.seq}
      className={cn(
        'grid grid-cols-[auto_1fr] items-baseline gap-x-2 px-1 py-1.5 text-2xs',
        linked && 'rounded bg-accent/10 shadow-[inset_2px_0_0_0_var(--accent)]',
      )}
    >
      <button
        type="button"
        className="cursor-pointer font-mono text-ink-faint tabular-nums hover:underline"
        title="Copy a link to this entry"
        onClick={() => {
          // The SHARED copy: it falls back to a hidden textarea when the
          // clipboard API is refused (an insecure origin, a browser that has
          // not been granted it) and says which happened either way. The bare
          // `navigator.clipboard?.writeText` this replaces failed silently —
          // the row highlighted as though it had copied, and nothing had.
          void copy(new URL(journalHref(entry.seq), window.location.href).toString(), 'Link copied');
          onLink(entry.seq);
        }}
      >
        #{entry.seq}
      </button>
      <div className="min-w-0">
        <span className="font-mono font-semibold text-ink">{entry.event}</span>
        {entry.phase != null && <span className="ml-1.5 text-ink-faint">phase {entry.phase}</span>}
        {Number.isFinite(at) && (
          <span className="ml-1.5 text-ink-faint">
            <RelativeTime at={at} />
          </span>
        )}
        {detail && <p className={cn('mt-0.5 break-words text-ink-muted', !said && 'font-mono')}>{detail}</p>}
      </div>
    </div>
  );
}

/** `key=value` pairs, bounded — a journal line is a summary, not a payload dump. */
function summarise(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => `${key}=${stringify(value).slice(0, 120)}`)
    .join('  ');
}

export default Journal;
