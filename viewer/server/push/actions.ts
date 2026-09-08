/**
 * Answering from the notification itself.
 *
 * A push already reaches a phone that is not looking at the console. What it
 * could not do was let you *answer*: every button on a notification opened the
 * app, and an app that has to open, authenticate a service worker's fetch and
 * find the queue is not a lock-screen answer — it is a reminder to go and do
 * one. This module is the missing half.
 *
 * ------------------------------------------------------------------
 * The shape, and why it is this shape
 * ------------------------------------------------------------------
 *
 * A service worker acting on a payload is a capability, so the question is what
 * the payload is allowed to say. The obvious design — put the endpoint, the
 * method and the body in the payload and let the worker POST them — turns every
 * notification into a general-purpose request generator that outlives the run it
 * was sent for, sitting in a notification shade for as long as the operator
 * leaves it there. That is a bigger promise than answering a question needs.
 *
 * So a payload names **what it is about**, never what to do:
 *
 *   1. the console mints a token over `(inbox item id, allowed verbs, expiry)`,
 *      signed with a per-instance key, and puts it in the payload;
 *   2. the worker posts `{token, action}` to ONE route, `/api/push/action`;
 *   3. the route verifies the signature, checks the verb was one of the ones
 *      bound at mint time, then looks the item up in the LIVE inbox and
 *      executes the action the inbox itself declares.
 *
 * The inbox is the single source of "what would clear this" (`server/inbox.ts`,
 * `shared/attention-model.js`) — including which console capability gates it —
 * so this route re-derives nothing. An item that has been answered, expired or
 * cleared since the push went out is simply not in the inbox any more, and the
 * callback says `gone` rather than acting on a stale intent. That is the whole
 * safety argument: **the token is a claim about identity, and the inbox is the
 * authority.**
 *
 * ------------------------------------------------------------------
 * Why only these three verbs
 * ------------------------------------------------------------------
 *
 * `PUSH_ACTION_VERBS` is deliberately much smaller than the set of verbs the
 * inbox offers. A notification button may ANSWER a question that is already
 * waiting — allow, deny, approve — and may never START or KILL work. `recover`,
 * `steer`, `freeze`, `stop`, `release` and `restart` all set something running
 * or tear something down, and a mis-tap on a lock screen is not the interaction
 * that should be able to do either. Those keep the button they have always had:
 * Open.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.ts';
import { PUSH_DIR } from './vapid.ts';

/**
 * How long a notification's buttons stay live.
 *
 * Long enough that a push arriving at 3am is still answerable over breakfast;
 * short enough that a notification nobody cleared for a week is not a standing
 * capability. An expired token is not an error the operator ever sees — the
 * worker falls back to opening the app, which is what the button did before
 * this module existed.
 */
export const PUSH_ACTION_TTL_MS = 12 * 60 * 60_000;

/** The verbs a notification button may carry, and what each is called on it. */
export const PUSH_ACTION_VERBS = Object.freeze({
  allow: 'Allow',
  deny: 'Deny',
  approve: 'Approve',
} as const);

export type PushActionVerb = keyof typeof PUSH_ACTION_VERBS;

export function isPushActionVerb(value: unknown): value is PushActionVerb {
  return typeof value === 'string' && Object.hasOwn(PUSH_ACTION_VERBS, value);
}

/** One button, as the service worker's `showNotification` wants it. */
export type PushActionButton = { action: string; title: string };

/**
 * Two, and never more.
 *
 * Android shows at most two action buttons and silently drops the rest; iOS
 * ignores the array entirely and shows the notification, which is the correct
 * degradation and the reason a payload must never depend on a button existing.
 * A cap that is enforced here rather than hoped for is what stops a third verb
 * being added one day and vanishing on the only platform that renders any.
 */
export const MAX_NOTIFICATION_ACTIONS = 2;

/** What the signature covers. Short keys: this rides in a 4 KB push payload. */
type Grant = {
  /** Schema version, so a payload minted by an older console is refused, not misread. */
  v: 1;
  /** The inbox item id — `shared/attention-model.js` `inboxItemId` mints it. */
  i: string;
  /** The verbs bound at mint time. A verb absent here cannot be performed. */
  a: PushActionVerb[];
  /** Epoch ms after which this is refused. */
  e: number;
  /** Per-token, so two notifications about the same item are separately spendable. */
  n: string;
};

export type PushActionGrant = { item: string; verbs: PushActionVerb[]; nonce: string };

export type PushActionRefusal = { error: string };

const KEY_FILE = join(PUSH_DIR, 'action-key');

/**
 * The signing key.
 *
 * Kept on disk, unlike a per-process secret, for one reason: a console that
 * restarts overnight would otherwise wake up unable to honour any notification
 * it sent before bed, which is precisely the window this feature exists for.
 *
 * Unlike the VAPID key (`vapid.ts`), losing this one is *harmless* — the worst
 * case is that outstanding buttons stop working and open the app instead. So
 * the failure policy is the opposite of VAPID's: an unreadable file mints a
 * fresh key in memory and carries on, where VAPID refuses and turns push off.
 * Never mint over a readable VAPID key; always carry on without a readable
 * action key.
 */
let cached: Buffer | null = null;

export function actionKey(): Buffer {
  if (cached) return cached;
  try {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    const parsed = Buffer.from(raw, 'base64url');
    if (parsed.length === 32) {
      cached = parsed;
      return cached;
    }
    log.warn('push.action-key.malformed', { file: KEY_FILE, bytes: parsed.length });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') log.warn('push.action-key.unreadable', { file: KEY_FILE, code });
  }

  const minted = randomBytes(32);
  try {
    mkdirSync(PUSH_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(KEY_FILE, `${minted.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(KEY_FILE, 0o600);
  } catch (error) {
    // In memory is still a working key for this process; the only cost is that
    // a restart invalidates the buttons of anything sent before it.
    log.warn('push.action-key.unwritable', { file: KEY_FILE, error });
  }
  cached = minted;
  return cached;
}

/** Tests and `--help`-shaped callers: forget the cached key without touching disk. */
export function resetActionKeyForTests(): void {
  cached = null;
}

function sign(body: string): string {
  return createHmac('sha256', actionKey()).update(body).digest('base64url');
}

/**
 * Mint a token for one notification.
 *
 * `verbs` is what the operator may do FROM THE NOTIFICATION — a subset of what
 * the inbox item offers, filtered to `PUSH_ACTION_VERBS`. Minting with none
 * returns `null`, and a payload with no token is exactly the payload this
 * console has always sent.
 */
export function mintActionToken(
  item: string,
  verbs: readonly string[],
  now = Date.now(),
): string | null {
  const bound = [...new Set(verbs.filter(isPushActionVerb))].slice(0, MAX_NOTIFICATION_ACTIONS);
  if (!item.trim() || !bound.length) return null;
  const grant: Grant = { v: 1, i: item, a: bound, e: now + PUSH_ACTION_TTL_MS, n: randomUUID() };
  const body = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Read a token back, or say why not.
 *
 * Order matters: the signature is checked before the contents are trusted for
 * anything, and the comparison is constant-time. A malformed token and a forged
 * one produce the same sentence — a caller learning WHICH is a caller learning
 * something about the key.
 */
export function readActionToken(token: unknown, now = Date.now()): PushActionGrant | PushActionRefusal {
  if (typeof token !== 'string' || !token) return { error: 'no token' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { error: 'token is not valid' };

  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body), 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { error: 'token is not valid' };
  }

  let grant: Grant;
  try {
    grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Grant;
  } catch {
    return { error: 'token is not valid' };
  }
  // Signed, so this cannot be forged — but a token minted by a FUTURE console
  // with a different schema would be read as if it were this one. Refuse.
  if (grant?.v !== 1) return { error: 'token is not valid' };
  if (typeof grant.i !== 'string' || !grant.i) return { error: 'token is not valid' };
  if (!Array.isArray(grant.a) || !grant.a.every(isPushActionVerb)) return { error: 'token is not valid' };
  if (typeof grant.n !== 'string' || !grant.n) return { error: 'token is not valid' };
  if (typeof grant.e !== 'number' || !Number.isFinite(grant.e)) return { error: 'token is not valid' };
  if (now >= grant.e) return { error: 'this notification has expired — open the console instead' };

  return { item: grant.i, verbs: grant.a, nonce: grant.n };
}

/**
 * Tokens already spent.
 *
 * Answering twice is a mis-tap, not an attack, and the operations underneath
 * refuse a second answer on their own (`decideApproval` has no pending card to
 * settle; a gate clearance is idempotent). This is the cheap belt: one entry
 * per answered notification, pruned by its own expiry, and deliberately
 * in-memory — a restart forgets, and the operations below are what actually
 * make a repeat safe.
 */
export class SpentTokens {
  private readonly spent = new Map<string, number>();

  /** `true` the first time a nonce is presented, `false` every time after. */
  claim(nonce: string, expiresAt: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.spent.has(nonce)) return false;
    this.spent.set(nonce, expiresAt);
    return true;
  }

  private prune(now: number): void {
    if (this.spent.size < 256) return;
    for (const [nonce, at] of this.spent) if (at <= now) this.spent.delete(nonce);
  }
}

/**
 * The buttons for a set of verbs, in the catalogue's own order.
 *
 * Order is `PUSH_ACTION_VERBS`' declaration order rather than the caller's, so
 * Allow is always left of Deny however the inbox happened to list them — muscle
 * memory on a lock screen is worth more than call-site convenience.
 */
export function notificationButtons(verbs: readonly string[]): PushActionButton[] {
  const wanted = new Set(verbs.filter(isPushActionVerb));
  return (Object.keys(PUSH_ACTION_VERBS) as PushActionVerb[])
    .filter((verb) => wanted.has(verb))
    .slice(0, MAX_NOTIFICATION_ACTIONS)
    .map((verb) => ({ action: verb, title: PUSH_ACTION_VERBS[verb] }));
}
