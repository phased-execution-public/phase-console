/**
 * Your turn's headline, composed by RULES (control-tower phase 136, #213,
 * §Architecture 19; the fourth addendum's ruling on summaries — nothing on the
 * page is written by a model). Pure and import-free, so a console's turn and
 * the fleet's merged list compose their sentence the same way.
 */

/** What the headline is composed from — counts only (#377): it never quotes an item's title. */
export type HeadlineFacts = {
  /** Items that are the person's to do now: *Approve*, *Do now* and *Decide*. */
  open: number;
  checking: number;
  upcoming: number;
  /** Items settled in the last day — *Done*. */
  done: number;
  handled: number;
  /** Is `handled` counted since the person's last look (`seen`) or over the last day? */
  handledSince: 'seen' | 'day';
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
 * summaries — nothing on the page is written by a model). It COUNTS, and never
 * quotes a title (#377: a quoted title was cut mid-word and repeated what the
 * card below already says):
 *   1. how many are the person's to do now — "Nothing needs you now" when none is;
 *   2. how many are being checked;
 *   3. how many are coming up;
 *   4. how many were done today;
 *   5. how many the AI handled since the person last looked (or in the last day).
 * Parts with nothing to say are left out; the parts are joined by " · ":
 * "1 to do now · 5 coming up · 6 done today."
 */
export function headlineOf(facts: HeadlineFacts): string {
  const parts: string[] = [facts.open ? `${facts.open} to do now` : 'Nothing needs you now'];
  if (facts.checking) parts.push(`${facts.checking} being checked`);
  if (facts.upcoming) parts.push(`${facts.upcoming} coming up`);
  if (facts.done) parts.push(`${facts.done} done today`);
  if (facts.handled) parts.push(`${facts.handled} handled ${facts.handledSince === 'seen' ? 'since you last looked' : 'in the last day'}`);
  return `${parts.join(' · ')}.`;
}
