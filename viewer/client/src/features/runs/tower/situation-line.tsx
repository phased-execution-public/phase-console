/**
 * The situation line — the Tower's one sentence, in the shell's header on
 * every page (control-tower phase 20 drew it under the Runs title; phase 21
 * moved it into the header, §Architecture 5's wireframe).
 *
 * How many things need you, how many are live, waiting and queued, and what
 * today has cost — the numbers of the bays below it, never a second count.
 * A bay with nothing in it is not mentioned, and a console with nothing on it
 * says so plainly. With exactly one run live it names that run and its phase,
 * because on the commonest day that IS the situation.
 *
 * The parts are separate words with a gap between them, not a middle-dotted
 * string; a screen reader hears commas. In the header each part is a link to
 * the bay it counts (`?bay=`), and the day's money to Insights — the line is
 * the glance, and one press on any figure is the answer behind it.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { RunState, SpendView } from '@/lib/api';
import { money, plural } from '@/lib/format';
import { useSpend } from '@/lib/queries';
import { cn } from '@/lib/cn';
import { insightsHref, runsBayHref } from '@/app/routes';
import type { TowerModel } from './tower-model';

export interface SituationPart {
  key: string;
  text: string;
  /** The part a person should read first — something needs them. */
  loud?: boolean;
  /** Where this figure is answered: its bay on the Tower, or Insights for the money. */
  href: string;
}

export function situationParts(input: {
  tower: TowerModel;
  /** Pending approval cards — they need you as much as a stop does. */
  approvals: number;
  spend?: SpendView | undefined;
}): SituationPart[] {
  const { tower, approvals, spend } = input;
  const parts: SituationPart[] = [];
  const needs = tower.counts['needs-you'] + approvals;
  if (needs)
    parts.push({
      key: 'needs-you',
      text: `${needs} need${needs === 1 ? 's' : ''} you`,
      loud: true,
      href: runsBayHref('needs-you'),
    });
  // A person's turn is named on its own (control-tower phase 42): of the
  // things that need you, these are the ones only you can do, and each waits
  // on the act itself — a sign-in, a code, a look — not on a decision.
  const turns = tower.steps?.length ?? 0;
  if (turns)
    parts.push({
      key: 'your-turn',
      text: `Your turn (${turns})`,
      loud: true,
      href: runsBayHref('needs-you'),
    });

  const live = tower.bays.live;
  const liveHref = runsBayHref('live');
  if (live.length === 1) {
    const only: RunState = live[0]!.run;
    parts.push({
      key: 'live',
      text: `${only.slug} is running — phase ${only.activePhase ?? '?'}`,
      href: liveHref,
    });
  } else if (live.length > 1) parts.push({ key: 'live', text: `${live.length} live`, href: liveHref });
  else parts.push({ key: 'live', text: 'Nothing running right now', href: liveHref });

  if (tower.counts.waiting)
    parts.push({ key: 'waiting', text: `${tower.counts.waiting} waiting`, href: runsBayHref('waiting') });
  if (tower.counts.queued)
    parts.push({ key: 'queued', text: `${tower.counts.queued} queued`, href: runsBayHref('queued') });
  if (tower.counts.ready)
    parts.push({
      key: 'ready',
      text: plural(tower.counts.ready, 'phase') + ' ready',
      href: runsBayHref('ready'),
    });
  const today = spend?.today?.settledUsd;
  if (today != null && today > 0)
    parts.push({ key: 'spend', text: `${money(today)} today`, href: insightsHref() });
  return parts;
}

/**
 * Which parts one row holds — the header's reading (control-tower phase 21).
 *
 * The desk header is ONE row of a fixed height. In a no-wrap row the parts
 * shrank past their own words and painted over each other ("10 need you" over
 * "tower is running", measured at 1280 px). So the row WRAPS and clips its
 * second line instead: a part it cannot hold leaves whole, never half a word,
 * and the parts give way from the end — they are ordered by what it costs to
 * miss them, the money last. What left is hidden from the eye, so it is made
 * inert too: no keyboard stop and no screen-reader word for a part nobody can
 * see. The Tower's own bays still say all of it.
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
  tower,
  approvals,
  enabled,
  links = false,
  className,
}: {
  tower: TowerModel;
  approvals: number;
  /** The run endpoints answer — the day's spend is read only then. */
  enabled: boolean;
  /** Draw each part as a link to where it is answered — the header's reading. */
  links?: boolean;
  className?: string;
}) {
  const { data: spend } = useSpend(enabled);
  const parts = situationParts({ tower, approvals, spend });
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
                  // 24 px tall: the WCAG target floor on a desk, beside the
                  // header's own buttons.
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
