/**
 * Your turn's headline, composed by RULES (control-tower phase 136, #213,
 * §Architecture 19; the fourth addendum's ruling on summaries — nothing on the
 * page is written by a model). Pure and import-free, so a console's turn and
 * the fleet's merged list compose their sentence the same way.
 */

/** What the headline is composed from — counts, the oldest open item, and how many were handled. */
export type HeadlineFacts = {
  /** Items that need the person now: *Do now* and *Decide*. */
  open: number;
  checking: number;
  upcoming: number;
  handled: number;
  /** Is `handled` counted since the person's last look (`seen`) or over the last day? */
  handledSince: 'seen' | 'day';
  /** The oldest open item: its title, since when, and the lanes it holds. */
  oldest: { title: string; since: string; holds: readonly { slug: string; phase: number }[] } | null;
  now: number;
  /** Name the plan of every lane, even when there is one — the fleet's list, where lanes span consoles. */
  namePlans?: boolean;
};

/** "3 h", "12 min", "2 days" — how long something has waited, in one unit. */
export function waitedWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** "phase 117", "phases 117 and 118", "alpha phase 3 and beta phase 4". */
export function holdsWords(lanes: readonly { slug: string; phase: number }[], namePlans = false): string {
  const unique = [...new Map(lanes.map((lane) => [`${lane.slug}#${lane.phase}`, lane])).values()];
  if (!unique.length) return '';
  const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  if (!namePlans && new Set(unique.map((lane) => lane.slug)).size === 1) {
    const phases = unique.map((lane) => String(lane.phase));
    return `${phases.length === 1 ? 'phase' : 'phases'} ${list(phases)}`;
  }
  return list(unique.map((lane) => `${lane.slug} phase ${lane.phase}`));
}

/**
 * The headline, by RULES (§Architecture 19; the fourth addendum's ruling on
 * summaries — nothing on the page is written by a model):
 *   1. how many need the person now, and the oldest — its title, how long it
 *      has waited and what it holds; "Nothing needs you now" when none does;
 *   2. how many are being checked;
 *   3. how many are coming up;
 *   4. how many were handled since the person last looked (or in the last day).
 * Parts with nothing to say are left out; the parts are joined by " · ".
 */
export function headlineOf(facts: HeadlineFacts): string {
  const parts: string[] = [];
  if (!facts.open) parts.push('Nothing needs you now');
  else {
    const oldest = facts.oldest;
    const title = oldest ? (oldest.title.length > 60 ? `${oldest.title.slice(0, 59)}…` : oldest.title) : '';
    const holds = oldest ? holdsWords(oldest.holds, facts.namePlans) : '';
    const waited = oldest ? `has waited ${waitedWords(facts.now - Date.parse(oldest.since))}${holds ? ` and holds ${holds}` : ''}` : '';
    if (facts.open === 1) parts.push(oldest ? `1 needs you now: ${title} ${waited}` : '1 needs you now');
    else parts.push(oldest ? `${facts.open} need you now — the oldest (${title}) ${waited}` : `${facts.open} need you now`);
  }
  if (facts.checking) parts.push(`${facts.checking} ${facts.checking === 1 ? 'is' : 'are'} being checked`);
  if (facts.upcoming) parts.push(`${facts.upcoming} coming up`);
  if (facts.handled) parts.push(`${facts.handled} handled ${facts.handledSince === 'seen' ? 'since you last looked' : 'in the last day'}`);
  return `${parts.join(' · ')}.`;
}

