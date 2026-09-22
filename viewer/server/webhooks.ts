/**
 * The same events, to a channel you already watch.
 *
 * Push reaches a phone the operator installed the console on. A webhook reaches
 * everywhere else — the Slack channel a team already has open, a Discord server,
 * a Telegram chat, a personal relay. It is deliberately the *same* event: the
 * category catalogue decides what is worth saying (`push/catalogue.ts`), the
 * global switch in `service-base.ts#announce` decides whether it is said at all,
 * and this is one more leg leaving from that single choke point.
 *
 * Three decisions are worth stating up front, because each is the opposite of
 * what an outbound-HTTP feature usually does.
 *
 * **1. It is off, and the off-ness is structural.** A console that can POST to
 * an arbitrary URL on every run event is a request generator; one that does it
 * from a laptop inside a private network is a request generator on the *inside*.
 * So it is a capability flag (`--allow-webhooks`) like spawning sessions and
 * holding credentials are, the flag is read at delivery time and not only at
 * registration, and a console started without it makes no outbound request even
 * if rows are already on disk from a day it was started with it.
 *
 * **2. The URL is a bearer credential and is never served back.** A Slack
 * incoming-webhook URL is the whole authorisation: whoever holds it can post to
 * that channel. `PublicWebhook` omits it exactly as `PublicDevice` omits a push
 * endpoint, and carries an origin plus a masked tail so two rows can be told
 * apart. Changing one means removing it and adding it again — which is the
 * honest verb for replacing a secret.
 *
 * **3. Payloads carry ids and titles, and are redacted anyway.** A notification
 * body is composed from a run's own words — a verification's failing line, a
 * session's last message — and those are exactly the places a token gets echoed
 * by accident. `redact()` runs over every free-text field on the way out, and
 * `test/webhooks.test.ts` asserts that a payload built from a notification full
 * of secret-shaped strings contains none of them. Nothing from the console's own
 * trust surface travels at all: no push action token (it is same-origin by
 * construction and means nothing to a third party), no file contents, no
 * transcript.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import {
  CATEGORIES, categoryOf, defaultCategories, sanitiseCategories, type CategoryId,
} from './push/catalogue.ts';
import { endpointRefusal } from './push/index.ts';

const FILE = join(INSTANCE_STATE_DIR, 'webhooks.json');

/** How long one POST may take before it is abandoned. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** First backoff step after a failure; doubled per consecutive failure. */
export const WEBHOOK_BACKOFF_BASE_MS = 30_000;

/**
 * The ceiling on backoff, and deliberately not a death sentence.
 *
 * Push drops a device after fifteen failures because a dead endpoint is the push
 * service telling you the app is gone. A webhook URL is something the operator
 * typed, and a relay being down for a weekend is not a reason to forget it —
 * losing the row means losing a secret they have to go and re-issue. So a
 * failing hook backs off to one attempt every half hour and stays registered,
 * with its failure count and last rejection on the card. It costs 48 requests a
 * day and nothing else.
 */
export const WEBHOOK_BACKOFF_MAX_MS = 30 * 60_000;

/** The payload's schema version. A consumer that does not know it should ignore the event. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * Every key a payload carries — the contract, and what `docs/webhooks.md` is
 * held to by `test/docs-parity.test.ts`. Adding a key means documenting it in
 * the same commit; that is the whole point of the list existing.
 */
export const WEBHOOK_PAYLOAD_FIELDS = [
  'version', 'instance', 'at', 'category', 'urgent', 'title', 'body',
  'url', 'link', 'notificationId', 'slug', 'phase', 'runId', 'text', 'content',
] as const;

export type WebhookPayloadField = typeof WEBHOOK_PAYLOAD_FIELDS[number];

export type WebhookPayload = {
  version: number;
  /** Which console spoke — an operator can run several. */
  instance: string;
  at: string;
  category: CategoryId;
  urgent: boolean;
  title: string;
  body: string;
  /** The console-relative route, identical to the one the push carries. */
  url: string;
  /** The same route, absolute, so a chat client makes it clickable. */
  link: string;
  notificationId: string;
  slug: string | null;
  phase: number | null;
  runId: string | null;
  /** `text` is what Slack and Telegram render; `content` is what Discord renders. */
  text: string;
  content: string;
};

export type Webhook = {
  id: string;
  /** What the operator called it. Cosmetic — it is how you tell two rows apart. */
  label: string;
  url: string;
  categories: Record<CategoryId, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
  lastFailure?: { at: string; status: number; reason: string | null };
  /** Epoch ms before which nothing is attempted. Backoff, not a setting. */
  quietUntil?: number;
  /** A row read from the machine profile (`fleet.json`) — delivered to, never persisted or removed here. */
  profile?: true;
};

/** A row as the API serves it: everything except the URL, which is a secret. */
export type PublicWebhook = Omit<Webhook, 'url'> & { origin: string; tail: string };

export type WebhookDelivery = {
  status: number;
  ok: boolean;
  reason?: string | null;
};

export type WebhookFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; ok: boolean }>;

/**
 * What an announcement gives this leg. Deliberately not `NotificationRecord`:
 * a webhook payload is a wire format with its own version, and building it from
 * a narrow argument keeps a future field on the record from leaking into it
 * without anyone deciding it should.
 */
export type WebhookEvent = {
  title: string;
  body: string;
  url: string;
  notificationId: string;
  slug?: string | null;
  phase?: number | null;
  runId?: string | null;
  /** Per-announcement urgency override (the escalated stall). Omitted means
   * the catalogue decides — same rule as the notification record. */
  urgent?: boolean;
};

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

const MASK = '[redacted]';

/**
 * Secret shapes, most specific first.
 *
 * These are recognisers, not a guarantee — a redactor that claimed to catch
 * every secret would be lying, and the honest defence is the one above it: a
 * payload carries ids and titles rather than file contents. What this catches is
 * the accident that actually happens, which is a token echoed into a message
 * because a command printed it.
 *
 * The generic rule at the end is deliberately narrow: forty-plus characters of
 * mixed-case-with-digits, which is what a base64url token looks like and what a
 * git sha, a UUID, a slug and an ISO timestamp all are not. Masking a commit sha
 * would make the feature useless for the one category people actually watch —
 * and the case mix is the whole of what excludes one. A `(?![0-9a-f]{40,})`
 * lookahead stood in front of it until mutation testing showed it could not
 * change an outcome: a hex digest is lowercase, so it fails the `[A-Z]`
 * requirement two characters later. One decision point, not two that look alike.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM blocks — the whole body, not just the header line.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Anthropic, OpenAI-style.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub: the classic prefixes and the fine-grained one.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack bot/user/app tokens — distinct from the webhook URL below.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /\bA(?:KIA|SIA|ROA|IDA)[0-9A-Z]{16}\b/g,
  // A JWT, and by the same shape this console's own action token.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials in a URL's userinfo.
  /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/gi,
  // A vendor webhook or bot URL is itself the credential.
  /\bhttps?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\bhttps?:\/\/discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
  /\bhttps?:\/\/api\.telegram\.org\/bot[A-Za-z0-9:_-]+/g,
  /* `token=…`, `api_key: …`, `Authorization: Bearer …` and their neighbours.
   *
   * The scheme word is part of what must be swallowed, and leaving it out is a
   * hole rather than a cosmetic miss: without `(?:bearer|basic|token)\s+` the
   * value this rule masks in `Authorization: Bearer sk-…` is the word "Bearer",
   * and the credential three characters later survives in full. Found by
   * asserting the WHOLE fixture is consumed rather than that the line changed. */
  /\b(?:authorization|token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[=:]\s*(?:(?:bearer|basic|token)\s+)?("[^"]*"|'[^']*'|\S+)/gi,
  // The same credential with no key name in front of it.
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Anything long enough, mixed enough, and not a hex digest.
  /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}\b/g,
];

/**
 * The entropy backstop — a run of token characters random enough to be a key.
 *
 * Every pattern above names a credential somebody thought of. This one catches
 * the ones nobody did, and it matters because the run bundle exists to be
 * SHARED: a redaction that works on the shapes we listed and not on the vendor
 * prefix that shipped last week is worse than none, since the manifest tells
 * the reader it was redacted.
 *
 * Both numbers are chosen against one false positive each.
 *
 * **32 characters**, because shorter runs of mixed characters are ordinary —
 * a base64'd 16-byte id, a slug, a filename.
 *
 * **4.5 bits**, because a 16-symbol alphabet cannot exceed 4.0 however random
 * it is, and hex is what a log line is FULL of: every sha, every trace id,
 * every span id. Masking those would destroy the bundle's whole purpose. A
 * base64 or base62 secret draws on 62–64 symbols and lands near 5.5–6.0, so
 * the threshold sits in a genuinely empty band rather than being a guess.
 */
const ENTROPY_MASK = '[high-entropy]';
const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_MIN_BITS = 4.5;
const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

/** Shannon entropy of a string, in bits per character. */
export function shannonBits(text: string): number {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Mask every secret-shaped run in a string.
 *
 * The userinfo and `key=value` patterns keep their non-secret half, because
 * "something was removed from here" is more useful than a payload that reads as
 * if the console had nothing to say.
 */
export function redact(text: string): string {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match, ...rest) => {
      // The userinfo rule keeps the scheme it captured; the key=value rule keeps
      // everything up to the value it matched.
      const first = rest[0];
      if (typeof first === 'string' && match.startsWith(`${first}://`)) return `${first}://${MASK}@`;
      const assignment = /^([^=:]+[=:]\s*)/.exec(match);
      if (assignment && /^(?:authorization|token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key)\b/i.test(match)) {
        return `${assignment[1]}${MASK}`;
      }
      return MASK;
    });
  }
  // Last, so a run a named pattern already replaced is not re-examined: `MASK`
  // is short and low-entropy, and the ones that keep a prefix have already had
  // their secret half removed.
  ENTROPY_RUN.lastIndex = 0;
  out = out.replace(ENTROPY_RUN, (match) =>
    (match.length >= ENTROPY_MIN_LENGTH && shannonBits(match) > ENTROPY_MIN_BITS ? ENTROPY_MASK : match));
  return out;
}

/* ------------------------------------------------------------------ *
 * The payload
 * ------------------------------------------------------------------ */

/** How long a title or body may be before it is cut. A chat line, not a log. */
const MAX_TEXT = 500;

function clip(text: string): string {
  const flat = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * One announcement as a wire payload.
 *
 * Pure, exported and tested directly, because everything interesting about this
 * feature is here rather than in the POST: what travels, what does not, and what
 * is masked on the way.
 */
export function composeWebhookPayload(
  category: CategoryId,
  event: WebhookEvent,
  context: { instance: string; link: (url: string) => string; at: Date },
): WebhookPayload {
  const title = clip(event.title);
  const body = clip(event.body);
  const line = body ? `${title} — ${body}` : title;
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    instance: context.instance,
    at: context.at.toISOString(),
    category,
    urgent: event.urgent ?? categoryOf(category).urgent,
    title,
    body,
    url: event.url,
    link: context.link(event.url),
    notificationId: event.notificationId,
    slug: event.slug ?? null,
    phase: typeof event.phase === 'number' ? event.phase : null,
    runId: event.runId ?? null,
    text: line,
    content: line,
  };
}

/** The delay before the next attempt, after `failures` consecutive rejections. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const step = WEBHOOK_BACKOFF_BASE_MS * 2 ** (failures - 1);
  return Math.min(step, WEBHOOK_BACKOFF_MAX_MS);
}

/**
 * May this console POST to that URL?
 *
 * The same question push asks of a subscription endpoint, and the same answer,
 * for the same reason: an unattended POST to a URL somebody handed the console
 * is exactly the shape of an SSRF, and the interesting targets are all on the
 * inside of the machine this runs on. `push/index.ts#endpointRefusal` already
 * refuses non-https, this host, loopback, link-local (where the cloud metadata
 * address lives), the RFC 1918 blocks, IP literals and dotless intranet names —
 * so it is reused rather than re-derived. Its sentences say "endpoint"; a
 * webhook's operator says "URL", so they are rewritten and nothing else changes.
 */
export function webhookUrlRefusal(url: unknown): string | null {
  const text = String(url ?? '').trim();
  if (!text) return 'a webhook needs a URL';
  const refusal = endpointRefusal(text);
  if (!refusal) return null;
  return refusal
    .replace(/^endpoint must be a push service, not a bare host name$/,
      'that is a bare host name — give a full https URL')
    .replace(/\bendpoint\b/g, 'URL');
}

/** The visible half of a URL: its origin, and enough tail to tell two apart. */
export function maskUrl(url: string): { origin: string; tail: string } {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    const tail = path.length > 6 ? `…${path.slice(-6)}` : path || '/';
    return { origin: parsed.origin, tail };
  } catch {
    return { origin: 'unknown', tail: '' };
  }
}

/* ------------------------------------------------------------------ *
 * The register
 * ------------------------------------------------------------------ */

export type WebhooksOptions = {
  /** `--allow-webhooks`. Read on every delivery, not only at registration. */
  enabled: boolean;
  /** Which console this is, for the payload. */
  instance: string;
  /** Turns a console-relative route into something a chat client can open. */
  link: (url: string) => string;
  /** Injected by tests; the real one is `globalThis.fetch`. */
  fetch?: WebhookFetch;
  now?: () => number;
  /** The machine profile's rows (`fleet.json` `webhooks[]`), this console's override first. */
  profileHooks?: readonly { url: string; name?: string; categories?: readonly string[] }[];
};

export class Webhooks {
  private hooks: Webhook[] = [];
  private readonly options: WebhooksOptions;
  /** Fired after a row is added or removed — the delivery-channel check re-reads the count. */
  onRowsChanged?: () => void;

  constructor(options: WebhooksOptions) {
    this.options = options;
    this.hooks = read();
    // The machine profile's rows (`fleet.json` `webhooks[]`, FLT-3): every
    // console delivers to them, none persists or removes them — they are the
    // file's, changed where the file is. A URL this console registered itself
    // keeps its own row.
    for (const row of options.profileHooks ?? []) {
      if (webhookUrlRefusal(row.url) || this.hooks.some((hook) => hook.url === row.url)) continue;
      const categories = Array.isArray(row.categories)
        ? Object.fromEntries(row.categories.map((id) => [id, true]))
        : undefined;
      this.hooks.push({
        id: `profile-${createHash('sha256').update(row.url).digest('hex').slice(0, 8)}`,
        label: row.name?.trim().slice(0, 60) || `${maskUrl(row.url).origin.replace(/^https:\/\//, '')} (machine profile)`,
        url: row.url,
        categories: categories ? sanitiseCategories(categories) : defaultCategories(),
        createdAt: '',
        lastOkAt: null,
        failures: 0,
        profile: true,
      });
    }
  }

  /** Whether this console may make an outbound request at all. */
  get enabled(): boolean {
    return this.options.enabled;
  }

  list(): PublicWebhook[] {
    return this.hooks.map((hook) => this.publicOf(hook));
  }

  state(): { allowWebhooks: boolean; hooks: PublicWebhook[]; categories: readonly unknown[] } {
    return { allowWebhooks: this.enabled, hooks: this.list(), categories: CATEGORIES };
  }

  /**
   * Register a URL, or replace the row that already holds it.
   *
   * Adding the same URL twice is a re-paste, not a second destination — it keeps
   * one row, exactly as a repeat push subscription does, so an operator who
   * cannot remember whether they already added it does not end up with two.
   */
  add(url: unknown, label: unknown, categories: unknown): PublicWebhook | { error: string } {
    const refusal = webhookUrlRefusal(url);
    if (refusal) return { error: refusal };
    const href = String(url).trim();
    const name = String(label ?? '').trim().slice(0, 60) || maskUrl(href).origin.replace(/^https:\/\//, '');

    const existing = this.hooks.find((hook) => hook.url === href);
    if (existing) {
      existing.label = name;
      existing.categories = sanitiseCategories(categories ?? existing.categories);
      // A re-paste is also how an operator says "try again now".
      existing.failures = 0;
      delete existing.quietUntil;
      delete existing.lastFailure;
      this.persist();
      return this.publicOf(existing);
    }

    const hook: Webhook = {
      id: randomUUID(),
      label: name,
      url: href,
      categories: categories == null ? defaultCategories() : sanitiseCategories(categories),
      createdAt: new Date().toISOString(),
      lastOkAt: null,
      failures: 0,
    };
    this.hooks.push(hook);
    this.persist();
    this.rowsChanged();
    return this.publicOf(hook);
  }

  remove(id: unknown): boolean {
    const before = this.hooks.length;
    // A machine-profile row is the file's: removing it here would come back on
    // the next boot, so it is refused rather than pretended.
    this.hooks = this.hooks.filter((hook) => hook.id !== id || hook.profile);
    if (this.hooks.length === before) return false;
    this.persist();
    this.rowsChanged();
    return true;
  }

  private rowsChanged(): void {
    try {
      this.onRowsChanged?.();
    } catch { /* a health re-check must never affect the register */ }
  }

  setCategories(id: unknown, categories: unknown): PublicWebhook | null {
    const hook = this.hooks.find((h) => h.id === id);
    if (!hook) return null;
    hook.categories = sanitiseCategories(categories);
    this.persist();
    return this.publicOf(hook);
  }

  /**
   * The fourth leg out of `announce`.
   *
   * Nothing awaits this and nothing here may throw: a relay being down must not
   * be able to touch a run. Every refusal returns before the first `fetch`, and
   * the flag is the first of them — a console started without `--allow-webhooks`
   * makes no outbound request even with rows on disk.
   */
  announce(category: CategoryId, event: WebhookEvent): Promise<void> | null {
    if (!this.enabled) return null;
    const now = this.options.now?.() ?? Date.now();
    const targets = this.hooks.filter((hook) => hook.categories[category]
      && !(hook.quietUntil && hook.quietUntil > now));
    if (!targets.length) return null;

    const payload = composeWebhookPayload(category, event, {
      instance: this.options.instance,
      link: this.options.link,
      at: new Date(now),
    });
    // Fire-and-forget for every caller but the shutdown announcement, which
    // awaits the settled posts before its process exits (SHD-4). Null above
    // means nothing was sent at all.
    return Promise.allSettled(targets.map((hook) => this.post(hook, payload))).then(() => undefined);
  }

  /** The Settings button: prove one URL, on demand, whatever its categories say. */
  async test(id: unknown): Promise<{ ok: boolean; detail: string }> {
    if (!this.enabled) {
      return { ok: false, detail: 'webhooks are disabled. Restart with --allow-webhooks to enable them.' };
    }
    const hook = this.hooks.find((h) => h.id === id);
    if (!hook) return { ok: false, detail: 'no such webhook' };
    const now = this.options.now?.() ?? Date.now();
    const payload = composeWebhookPayload('health', {
      title: 'Phase Console',
      body: `Webhooks are working — this is a test from ${this.options.instance}.`,
      url: '/#/settings/notifications',
      notificationId: 'webhook-test',
    }, { instance: this.options.instance, link: this.options.link, at: new Date(now) });

    const result = await this.post(hook, payload);
    return result.ok
      ? { ok: true, detail: `accepted by ${maskUrl(hook.url).origin} (${result.status})` }
      : { ok: false, detail: `${maskUrl(hook.url).origin} answered ${result.status}${result.reason ? ` — ${result.reason}` : ''}` };
  }

  private async post(hook: Webhook, payload: WebhookPayload): Promise<WebhookDelivery> {
    const send = this.options.fetch ?? defaultFetch;
    const now = () => this.options.now?.() ?? Date.now();
    let result: WebhookDelivery;
    try {
      const response = await send(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Named so a relay can filter without parsing, and so a shared
          // endpoint can tell this console's traffic from anything else's.
          'user-agent': 'phase-console',
          'x-phase-console-category': payload.category,
          'x-phase-console-instance': payload.instance,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      result = { status: response.status, ok: response.ok };
    } catch (error) {
      result = { status: 0, ok: false, reason: reasonOf(error) };
    }

    if (result.ok) {
      hook.lastOkAt = new Date(now()).toISOString();
      hook.failures = 0;
      delete hook.quietUntil;
      delete hook.lastFailure;
    } else {
      hook.failures += 1;
      hook.lastFailure = {
        at: new Date(now()).toISOString(),
        status: result.status,
        reason: result.reason ?? null,
      };
      hook.quietUntil = now() + backoffMs(hook.failures);
      log.warn('webhook.failed', {
        id: hook.id, origin: maskUrl(hook.url).origin, status: result.status, failures: hook.failures,
      });
    }
    this.persist();
    return result;
  }

  private publicOf(hook: Webhook): PublicWebhook {
    const { url, ...rest } = hook;
    return { ...rest, ...maskUrl(url) };
  }

  private persist(): void {
    try {
      mkdirSync(INSTANCE_STATE_DIR, { recursive: true, mode: 0o700 });
      // Each URL is a bearer credential for somebody's chat channel.
      writeFileSync(FILE, `${JSON.stringify(this.hooks.filter((hook) => !hook.profile), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log.warn('webhook.persist-failed', { error });
    }
  }
}

const defaultFetch: WebhookFetch = (url, init) => fetch(url, init as RequestInit);

function reasonOf(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  const message = (error as { message?: string })?.message;
  return typeof message === 'string' && message ? message.slice(0, 120) : 'unreachable';
}

function read(): Webhook[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Webhook[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((hook) => hook?.url && hook?.id)
      .map((hook) => ({
        ...hook,
        categories: sanitiseCategories(hook.categories),
        failures: Number(hook.failures) || 0,
      }));
  } catch {
    return [];
  }
}
