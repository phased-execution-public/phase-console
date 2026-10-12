/**
 * The situation words, in the header on every page and as the Runs home's own
 * heading (7.0, quiet-console phase 7; the Tower's one sentence since
 * control-tower phases 20–21).
 *
 * How many things need you, your turn among them, what is live, waiting and
 * queued, how many phases could start, and what today has cost — only the
 * non-zero figures, each a link to where it is answered. A console with
 * nothing on it says so plainly. With exactly one run live it names that run
 * and its phase, because on the commonest day that IS the situation.
 *
 * The figures are the home's own groups (`useRunGroups`, the ONE fold), so the
 * header and the home can never count differently; `queued` alone is the
 * queue's entries — phases, not runs, since one run may queue several. Loaded
 * after first paint; it reads the SLIM run list (#234), the queue, the plan
 * summaries, the inbox and the day's spend, and never spends an engine read.
 * On a phone the words are plain, on a row of their own with inline padding
 * (#284): a row of links would be six targets under the tap floor, and the
 * Runs tab, one thumb away with the same count on it, is the press.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import type { ConsoleState, SpendView } from '@/data/api';
import { runFocusWords } from '@/data/check-words';
import type { ShellCounts } from '@/data/console';
import { useRunGroups, type RunGroups } from '@/data/run-groups';
import { useSpend } from '@/data/runs';
import { useTurn } from '@/data/turn';
import { insightsHref, runsBayHref, turnHref } from './routes';

export interface SituationPart {
  key: string;
  text: string;
  /** The part a person should read first — something needs them. */
  loud?: boolean;
  /** Where this figure is answered. */
  href: string;
}

export function situationParts(input: {
  /** The home's groups — the fold the header shares with it. */
  model: RunGroups;
  /** Everything waiting on a person, as the shell counts it (the inbox, else the pending cards). */
  needsYou: number;
  /** The items of Your turn — of the things that need you, the ones only you can do. */
  turns: number;
  /** The queue's entries: phases waiting for a scope or a slot. */
  queued: number;
  spend?: SpendView | undefined;
}): SituationPart[] {
  const { model, needsYou, turns, queued, spend } = input;
  const parts: SituationPart[] = [];
  if (needsYou)
    parts.push({
      key: 'needs-you',
      text: `${needsYou} need${needsYou === 1 ? 's' : ''} you`,
      loud: true,
      href: runsBayHref('needs-you'),
    });
  if (turns) parts.push({ key: 'your-turn', text: `Your turn (${turns})`, loud: true, href: turnHref() });

  const live = model.groups.live;
  const liveHref = runsBayHref('live');
  if (live.length === 1) {
    const only = live[0]!.run;
    const focus = runFocusWords(only);
    parts.push({
      key: 'live',
      text: focus ? `${only.slug} is running — ${focus}` : `${only.slug} is running`,
      href: liveHref,
    });
  } else if (live.length > 1) parts.push({ key: 'live', text: `${live.length} live`, href: liveHref });
  else parts.push({ key: 'live', text: 'Nothing running right now', href: liveHref });

  const waiting = model.counts.waiting;
  if (waiting) parts.push({ key: 'waiting', text: `${waiting} waiting`, href: runsBayHref('waiting') });
  if (queued) parts.push({ key: 'queued', text: `${queued} queued`, href: runsBayHref('queued') });
  const ready = model.counts.ready;
  if (ready)
    parts.push({
      key: 'ready',
      text: `${ready} phase${ready === 1 ? '' : 's'} ready`,
      href: runsBayHref('ready'),
    });
  const today = spend?.today?.settledUsd;
  if (today != null && today > 0)
    parts.push({ key: 'spend', text: `${money(today)} today`, href: insightsHref() });
  return parts;
}

/** The parts as one sentence — the home's heading. A screen reader hears the same commas. */
export function situationSentence(parts: readonly SituationPart[]): string {
  return parts.map((part) => part.text).join(', ');
}

/**
 * Which parts one row holds — the desk header is ONE row of a fixed height.
 * The row wraps and clips its second line: a part it cannot hold leaves
 * whole, never half a word, and the parts give way from the end — they are
 * ordered by what it costs to miss them, the money last. What left is made
 * inert too: no keyboard stop and no screen-reader word for a part nobody
 * can see.
 */
function useOneRow(active: boolean, words: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hiddenFrom, setHiddenFrom] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!active || !row) return;
    const measure = () => {
      const parts = [...row.children] as HTMLElement[];
      const first = parts[0]?.offsetTop ?? 0;
      const wrapped = parts.findIndex((part) => part.offsetTop > first);
      setHiddenFrom(wrapped === -1 ? Number.POSITIVE_INFINITY : wrapped);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [active, words]);
  return { ref, hiddenFrom };
}

export function SituationLine({
  parts,
  links,
  className,
}: {
  parts: SituationPart[];
  /** Draw each part as a link to where it is answered — the desk's reading. */
  links: boolean;
  className?: string;
}) {
  const row = useOneRow(links, parts.map((part) => part.text).join('\n'));
  return (
    <span
      ref={row.ref}
      data-testid="situation-line"
      className={cn(
        'flex min-w-0 flex-wrap gap-x-3',
        links ? 'h-6 items-center gap-y-0 overflow-hidden' : 'items-baseline gap-y-0.5',
        className,
      )}
    >
      {parts.map((part, index) => {
        const tone = part.loud ? 'font-medium text-ink' : undefined;
        const gone = index >= row.hiddenFrom;
        return (
          <span
            key={part.key}
            data-part={part.key}
            className={links ? 'shrink-0 whitespace-nowrap' : tone}
            {...(gone ? { inert: true, 'aria-hidden': true } : {})}
          >
            {index > 0 && <span className="sr-only">, </span>}
            {links ? (
              <a
                href={part.href}
                className={cn(
                  'inline-flex min-h-6 items-center rounded-sm underline-offset-2 hover:text-ink hover:underline',
                  'focus-visible:outline-2 focus-visible:outline-focus',
                  tone,
                )}
              >
                {part.text}
              </a>
            ) : (
              part.text
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Your turn's figure: what a person owes NOW — Do now and Needs one detail, the two groups the page's own headline counts. */
export function turnsOf(turn: { counts: { now: number; decide: number } } | undefined): number {
  return turn ? turn.counts.now + turn.counts.decide : 0;
}

export default function SituationSlot({
  state,
  counts,
  phone,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  phone: boolean;
}) {
  // The stale-server guard every run-reading surface keeps: a server that
  // predates the autopilot has no run endpoints to ask.
  const enabled = state != null && state.autopilot !== false;
  const { model, runs, entries } = useRunGroups({ enabled, details: false });
  const { data: turn } = useTurn(enabled);
  const { data: spend } = useSpend(enabled);
  // Nothing to say until the runs have answered: a line reading "Nothing
  // running right now" before the list arrives would be a claim, not a fact.
  if (!enabled || !runs) return null;
  const parts = situationParts({
    model,
    needsYou: counts.needsYou,
    turns: turnsOf(turn),
    queued: entries?.length ?? 0,
    spend,
  });
  if (phone) {
    return (
      <div className="px-3 pb-1.5">
        <SituationLine parts={parts} links={false} className="text-meta text-ink-muted" />
      </div>
    );
  }
  // The end padding keeps the last figure clear of the header's own buttons.
  return <SituationLine parts={parts} links className="pe-3 text-body text-ink-muted" />;
}
