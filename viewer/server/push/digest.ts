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

export type DigestFacts = {
  now: number;
  approvals: DigestApproval[];
  parks: DigestPark[];
  detections: DigestDetection[];
  /** Oldest first, as they were lost; at most `UNDELIVERED_KEEP`. */
  undelivered: DigestUndelivered[];
  /** How many were lost in all, when more than were kept. */
  undeliveredTotal?: number;
};

function where(slug: string, phase: number | null): string {
  return phase != null ? `${slug} phase ${phase}` : slug;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The digest's title and body, or null when there is nothing to say — no
 * decision waiting, nothing parked, nothing detected, nothing lost. Silence is
 * the good news, and a digest that says "nothing" every hour is how the
 * category gets turned off.
 */
export function composeDigest(facts: DigestFacts): { title: string; body: string } | null {
  const lines: string[] = [];
  for (const card of facts.approvals) {
    const waited = Math.max(0, Math.round((facts.now - Date.parse(card.createdAt)) / 60_000));
    lines.push(`${where(card.slug, card.phase)} — ${card.title} (waiting ${waited} min; expires ${card.expiresAt.slice(11, 16)}Z)`);
  }
  for (const park of facts.parks) lines.push(`${where(park.slug, park.phase)} parked — ${park.reason}`);
  for (const found of facts.detections) lines.push(`${where(found.slug, found.phase)} — ${found.text}`);
  const waiting = lines.length;

  const lost = facts.undelivered;
  const lostTotal = Math.max(facts.undeliveredTotal ?? lost.length, lost.length);
  if (lostTotal) {
    const newest = [...lost].reverse().map((push) => push.title);
    lines.push(`Did not arrive: ${newest.join('; ')}`);
    if (lostTotal > lost.length) lines.push(`and ${lostTotal - lost.length} more`);
  }
  if (!lines.length) return null;

  const title = waiting
    ? plural(waiting, 'thing waits on you', 'things wait on you')
    : `${plural(lostTotal, 'notification', 'notifications')} did not arrive`;
  return { title, body: lines.join('\n') };
}
