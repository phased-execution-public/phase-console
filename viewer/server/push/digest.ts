/**
 * The digest (control-tower phase 97, #140): one push that says what is
 * waiting, for the operator who wants a summary instead of a stream.
 *
 * The stream is one notification per event, and an operator away from the
 * console reads it least well exactly when it matters: vca P22's card ran out
 * at 21:09Z with nothing forward-looking said anywhere. The digest answers the
 * question that operator actually has — "am I needed, and by when?" — naming
 * every decision waiting with how long it has waited and its deadline, every
 * park, and every detection. It also carries what the channel failed to
 * deliver during an outage (#108): an undelivered push used to be a log line
 * and a health row, and the notification itself was never said again.
 *
 * Off by default (`digest` in the catalogue), hourly when on. Pure: the
 * service gathers the facts and announces the result through
 * `Service.announce`, so the gates every other category obeys hold here too.
 *
 * Since control-tower phase 138 (#215) it leads with Your turn — how many
 * items need the person, how many a check sent back, how many things the AI
 * handled — counted from the page's own answer, so the two never disagree.
 */

/** How often the digest is composed while its category is on. */
export const DIGEST_EVERY_MS = 60 * 60_000;

/** How many undelivered notifications are kept to be said again; the rest are counted. */
export const UNDELIVERED_KEEP = 20;

export type DigestApproval = { slug: string; phase: number | null; title: string; createdAt: string; expiresAt: string };
export type DigestPark = { slug: string; phase: number | null; reason: string };
/** A detection another part of the console made (phase 101's stalls): where, and what. */
export type DigestDetection = { slug: string; phase: number | null; text: string };
export type DigestUndelivered = { category: string; title: string; at: string };

/**
 * Your turn, counted (control-tower phase 138, #215) — read from the page's own
 * answer (`GET /api/turn`), so the digest and the page never disagree: how many
 * items need the person now (*Do now* and *Decide*), how many of those a check
 * sent back, and how many things the AI handled instead of asking — since the
 * last digest, or in the last hour before the first.
 */
export type DigestTurn = { needYou: number; cameBack: number; handled: number; handledSince: 'digest' | 'hour' };

export type DigestFacts = {
  now: number;
  approvals: DigestApproval[];
  parks: DigestPark[];
  detections: DigestDetection[];
  /** Oldest first, as they were lost; at most `UNDELIVERED_KEEP`. */
  undelivered: DigestUndelivered[];
  /** How many were lost in all, when more than were kept. */
  undeliveredTotal?: number;
  /** Your turn's counts; absent where the turn could not be read. */
  turn?: DigestTurn | null;
};

function where(slug: string, phase: number | null): string {
  return phase != null ? `${slug} phase ${phase}` : slug;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Your turn's line, or null when it has nothing to say: "Your turn: 3 need you
 * — 1 came back from a check · 4 handled by the AI since the last digest".
 * A part with nothing in it is left out.
 */
export function turnLine(turn: DigestTurn | null | undefined): string | null {
  if (!turn || (!turn.needYou && !turn.handled)) return null;
  const need = turn.needYou ? `${turn.needYou} ${turn.needYou === 1 ? 'needs' : 'need'} you` : 'nothing needs you';
  const back = turn.needYou && turn.cameBack ? ` — ${turn.cameBack} came back from a check` : '';
  const handled = turn.handled
    ? ` · ${turn.handled} handled by the AI ${turn.handledSince === 'digest' ? 'since the last digest' : 'in the last hour'}`
    : '';
  return `Your turn: ${need}${back}${handled}`;
}

/**
 * The digest's title and body, or null when there is nothing to say — no
 * decision waiting, nothing parked, nothing detected, no item needing the
 * person, nothing lost. Silence is the good news, and a digest that says
 * "nothing" every hour is how the category gets turned off — so what the AI
 * handled is said beside something that waits, never on its own.
 *
 * Your turn leads (control-tower phase 138, #215): it is the page's own count
 * of everything that asks the person for an act, the itemised lines below it
 * are the ones with a clock. The title keeps counting those lines; with none,
 * it is Your turn's count.
 */
export function composeDigest(facts: DigestFacts): { title: string; body: string } | null {
  const lines: string[] = [];
  const needYou = facts.turn?.needYou ?? 0;
  const turn = turnLine(facts.turn);
  if (turn) lines.push(turn);
  for (const card of facts.approvals) {
    const waited = Math.max(0, Math.round((facts.now - Date.parse(card.createdAt)) / 60_000));
    lines.push(`${where(card.slug, card.phase)} — ${card.title} (waiting ${waited} min; expires ${card.expiresAt.slice(11, 16)}Z)`);
  }
  for (const park of facts.parks) lines.push(`${where(park.slug, park.phase)} parked — ${park.reason}`);
  for (const found of facts.detections) lines.push(`${where(found.slug, found.phase)} — ${found.text}`);
  const waiting = facts.approvals.length + facts.parks.length + facts.detections.length;

  const lost = facts.undelivered;
  const lostTotal = Math.max(facts.undeliveredTotal ?? lost.length, lost.length);
  if (lostTotal) {
    const newest = [...lost].reverse().map((push) => push.title);
    lines.push(`Did not arrive: ${newest.join('; ')}`);
    if (lostTotal > lost.length) lines.push(`and ${lostTotal - lost.length} more`);
  }
  if (!waiting && !needYou && !lostTotal) return null;

  const title = waiting
    ? plural(waiting, 'thing waits on you', 'things wait on you')
    : needYou
      ? `Your turn: ${plural(needYou, 'thing needs you', 'things need you')}`
      : `${plural(lostTotal, 'notification', 'notifications')} did not arrive`;
  return { title, body: lines.join('\n') };
}
