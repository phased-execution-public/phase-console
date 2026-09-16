/**
 * The push register: which devices asked to be told, and about what.
 *
 * One row per browser that subscribed — a phone on the home screen, a laptop
 * with the tab long closed — each with its own category choices, because the
 * two rarely want the same ones. Rows are persisted, so a console restart does
 * not quietly stop notifying anybody.
 *
 * Everything here is best-effort by construction. A push that fails must never
 * be able to affect a run: failures are logged, dead subscriptions are dropped,
 * and no caller is ever made to wait on a notification being delivered.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { INSTANCE } from '../config.ts';
import { log } from '../log.ts';
import {
  CATEGORIES, categoryOf, defaultCategories, routeFor, sanitiseCategories, type CategoryId,
} from './catalogue.ts';
import { deliver, origin, type PushMessage, type Subscription } from './send.ts';
import { loadVapid, vapidSubject, PUSH_DIR, type Vapid, type VapidRefusal } from './vapid.ts';
import type { DeliveryOutcome } from '../notifications.ts';

// `defaultCategories`/`sanitiseCategories` are re-exported because the catalogue
// is no longer only push's business: the console's own global notification
// switches take their defaults and their sanitising from the same table, so the
// two tiers cannot drift apart on what a category is or what it defaults to.
export {
  CATEGORIES, categoryOf, defaultCategories, isPlanProgress, routeFor, sanitiseCategories,
  PLAN_PROGRESS_CATEGORIES, type Category, type CategoryId,
} from './catalogue.ts';

/**
 * What one device did with one announcement, told to whoever asked.
 *
 * `label` travels with it because a device can be dropped from the register the
 * moment it answers `gone` — and a history row reading "device
 * 4f3a…: gone" with nothing to name it is a row nobody can act on.
 */
export type DeliveryReport = {
  device: string;
  label: string;
  outcome: DeliveryOutcome;
  detail?: string;
};

const FILE = join(PUSH_DIR, 'subscriptions.json');

/**
 * After this many consecutive failures that were not "gone", a subscription is
 * dropped anyway. A push service that has rejected the same endpoint fifteen
 * times running is not going to start accepting it, and a register full of
 * corpses makes every event slower than the one before.
 */
const MAX_FAILURES = 15;

/**
 * A daily do-not-disturb window for one device. `start`/`end` are 'HH:MM' on a
 * 24-hour clock; a window may cross midnight (23:00–08:00 is the normal case).
 * `allowUrgent` keeps the "nothing proceeds without you" categories — and the
 * one escalated stall — breaking through. It defaults ON, because an approval
 * suppressed at 3am still stops the fleet dead until morning.
 */
export type QuietHours = { start: string; end: string; allowUrgent: boolean };

export type Device = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** What the browser called itself. Cosmetic — it is how you tell two rows apart. */
  label: string;
  categories: Record<CategoryId, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
  /** The most recent rejection, classified — what Settings shows beside a
   * device whose pushes stopped landing. Additive JSON. */
  lastReject?: { at: string; status: number; reason: string | null };
  /**
   * Delivery quiet hours for THIS device; absent means off. Evaluated on this
   * server's own clock at send time — the console runs on the operator's
   * machine, so server-local IS operator-local. Suppression, not deferral: the
   * record-first choke point already wrote the inbox record, so the morning
   * finds the night in the bell, and the delivery ledger reads `quiet` for
   * the device instead of reading as a failure. Additive JSON.
   */
  quiet?: QuietHours;
};

export type PublicDevice = Omit<Device, 'endpoint' | 'keys'> & { service: string };

/**
 * Where a register keeps its key and its devices, and who it speaks as. The
 * defaults are this console's own. A supervisor in front of several consoles
 * builds one over a directory of its own — a second VAPID pair, because a
 * subscription belongs to the key that made it — and each announcement it
 * carries names the console that spoke (`message.console`), not the register.
 */
export type PushOptions = {
  dir?: string;
  console?: { id: string; name: string };
  /** The push services' transport — a test seam, like `deliver`'s own. */
  fetchImpl?: typeof fetch;
};

export class Push {
  private devices: Device[] = [];
  private readonly dir: string;
  private readonly file: string;
  private readonly speaker: { id: string; name: string };
  private readonly fetchImpl: typeof fetch | undefined;
  private vapid: Vapid | null = null;
  /**
   * Why push is off, when it is. A key file that could not be READ never mints
   * a replacement — that would unsubscribe every device — so the console comes
   * up with push disabled and this is the sentence the environment card
   * carries. Read once, by `service-base.ts`, right after construction.
   */
  readonly keyFailure: VapidRefusal | null;
  /** Consecutive classified rejections per `service|reason`, reset by any success. */
  private readonly rejectStreaks = new Map<string, number>();
  /** Fired when a service|reason streak crosses 3 (and again at 10). The
   * service wires this to its environment issues — assigned after
   * construction, deliberately optional. */
  onPersistentReject?: (info: {
    service: string; reason: string; streak: number; devices: string[];
  }) => void;
  /**
   * Fired when ONE notification reached none of the devices it was sent to.
   *
   * The streak above answers "is this service refusing us"; this answers the
   * question an operator actually asked after three stall cards reached
   * neither of their two devices and nothing anywhere said so: *did that
   * notification arrive?* A single fan-out where every attempt failed is not a
   * streak (two devices on two services never reach 3 on either key) and it is
   * not visible in `onDelivery` either, which reports per device and leaves the
   * "and therefore nobody heard it" to whoever is reading. Nobody was.
   *
   * Deduped-away devices are not attempts, so a fan-out that sent nothing
   * because an identical push went seconds ago does not fire this.
   */
  onUndelivered?: (info: {
    category: CategoryId; tag: string; title: string;
    devices: { label: string; outcome: string; detail?: string }[];
  }) => void;
  /**
   * Fired when an announcement found NO device to send to (FLT-1): the register
   * holds none, or none takes the category. Before this the fan-out returned
   * before a report existed, and `onUndelivered` — guarded on attempts — never
   * ran, so a console with no device was not "undelivered", it was silent.
   * `subscribed` is how many devices the register holds at all.
   */
  onNoDevice?: (info: { category: CategoryId; tag: string; title: string; subscribed: number }) => void;
  /** Fired after the register gains or loses a device — what the delivery-channel check re-reads. */
  onDevicesChanged?: () => void;
  /** Same notification, same device, twice in a row: send it once. */
  private recent = new Map<string, number>();

  constructor(remoteUsers: string[] = [], opts: PushOptions = {}) {
    this.dir = opts.dir ?? PUSH_DIR;
    this.file = join(this.dir, 'subscriptions.json');
    this.speaker = opts.console ?? CONSOLE;
    this.fetchImpl = opts.fetchImpl;
    const loaded = loadVapid(vapidSubject(remoteUsers), this.dir);
    if ('error' in loaded) {
      this.keyFailure = loaded;
    } else {
      this.vapid = loaded;
      this.keyFailure = null;
    }
    // The register is loaded either way. Devices are NOT dropped because the
    // key is unreadable: the key may come back, and the subscriptions are still
    // theirs. (`read()` here is the DEVICE register, not vapid.ts's.)
    this.devices = read(this.file);
  }

  /** `''` when there is no key — which the client already reads as "push is off". */
  get publicKey(): string {
    return this.vapid?.publicKey ?? '';
  }

  list(): PublicDevice[] {
    return this.devices.map(({ endpoint, keys, ...rest }) => ({ ...rest, service: origin(endpoint) }));
  }

  state(): { publicKey: string; devices: PublicDevice[]; categories: readonly unknown[] } {
    return { publicKey: this.publicKey, devices: this.list(), categories: CATEGORIES };
  }

  /**
   * Subscribing twice from the same browser is the normal case, not an error —
   * a permission re-grant, a reinstall, a page that could not tell. The
   * endpoint identifies the device, so a repeat updates rather than duplicates,
   * and an existing row keeps its category choices unless new ones are given.
   */
  subscribe(input: unknown, categories: unknown, label: unknown): PublicDevice | { error: string } {
    const parsed = parseSubscription(input);
    if ('error' in parsed) return parsed;

    const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'a browser';
    const existing = this.devices.find((d) => d.endpoint === parsed.endpoint);

    if (existing) {
      existing.keys = parsed.keys;
      existing.label = name;
      existing.failures = 0;
      if (categories !== undefined) existing.categories = sanitiseCategories(categories);
      this.persist();
      return this.publicOf(existing);
    }

    const device: Device = {
      id: randomUUID(),
      endpoint: parsed.endpoint,
      keys: parsed.keys,
      label: name,
      categories: categories === undefined ? defaultCategories() : sanitiseCategories(categories),
      createdAt: new Date().toISOString(),
      lastOkAt: null,
      failures: 0,
    };
    this.devices.push(device);
    this.persist();
    log.info('push.subscribed', { id: device.id, label: device.label, service: origin(device.endpoint) });
    this.devicesChanged();
    return this.publicOf(device);
  }

  unsubscribe(idOrEndpoint: unknown): boolean {
    const key = String(idOrEndpoint ?? '');
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== key && d.endpoint !== key);
    if (this.devices.length === before) return false;
    this.persist();
    log.info('push.unsubscribed', { key: key.slice(0, 40) });
    this.devicesChanged();
    return true;
  }

  private devicesChanged(): void {
    try {
      this.onDevicesChanged?.();
    } catch { /* a health re-check must never affect the register */ }
  }

  setCategories(id: unknown, categories: unknown): PublicDevice | null {
    const device = this.devices.find((d) => d.id === String(id ?? ''));
    if (!device) return null;
    device.categories = sanitiseCategories(categories);
    this.persist();
    return this.publicOf(device);
  }

  /** Set or clear one device's quiet hours. `null` clears; a bad shape refuses. */
  setQuiet(id: unknown, value: unknown): PublicDevice | { error: string } | null {
    const device = this.devices.find((d) => d.id === String(id ?? ''));
    if (!device) return null;
    const parsed = parseQuietHours(value);
    if (parsed && 'error' in parsed) return parsed;
    if (parsed) device.quiet = parsed;
    else delete device.quiet;
    this.persist();
    log.info('push.quiet', { id: device.id, label: device.label, quiet: parsed ?? 'off' });
    return this.publicOf(device);
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  /**
   * Tell every device that asked about this category.
   *
   * Deliberately not awaited by callers: this is called from the middle of a
   * run's event handling, and a slow push service must not be able to stall a
   * phase. Everything that can go wrong is handled here and logged.
   *
   * `onDelivery` is how that stops being invisible. Because nothing awaits
   * this, a throttled, refused or undeliverable push reached no further than a
   * log line — so the outcome is now reported back per device, and the
   * notification store keeps it against the record. Called after the fact and
   * never awaited either: it annotates history, it does not gate it.
   */
  announce(
    category: CategoryId,
    message: Omit<PushMessage, 'category'>,
    now = Date.now(),
    onDelivery?: (report: DeliveryReport) => void,
    opts?: {
      /** Overrides the category's urgency — the retraction push rides the
       * halted category (same tag, so the SW replaces the displayed card)
       * but must arrive QUIET: it is the all-clear, not a second alarm. */
      urgent?: boolean;
      /** A corrective REPLACING a displayed card rides the same tag on
       * purpose — and the 5-second same-tag dedupe below would read it as a
       * re-render and swallow it, leaving the stale alarm on the lock screen.
       * `replace` says "same tag, different message: send it anyway". */
      replace?: boolean;
    },
  ): Promise<void> | null {
    // No key, no sends — and deliberately no per-device failure either: a
    // missing key must not burn the 15-strike budget that drops a subscription
    // for good. The environment issue is where this is said, once.
    if (!this.vapid) return null;
    const targets = this.devices.filter((d) => d.categories[category]);
    if (!targets.length) {
      // Nobody to send to is a REPORT, not silence (FLT-1): the record says so,
      // and the service decides whether a console with no channel is broken.
      const subscribed = this.devices.length;
      const report: DeliveryReport = {
        device: '',
        label: subscribed ? 'no device takes this category' : 'no device',
        outcome: 'no-device',
        detail: subscribed
          ? `${subscribed} device${subscribed === 1 ? '' : 's'} subscribed, none to ${category}`
          : 'no device is subscribed to this console',
      };
      if (onDelivery) {
        try {
          onDelivery(report);
        } catch { /* annotating a record must never affect a run */ }
      }
      try {
        this.onNoDevice?.({ category, tag: message.tag, title: message.title, subscribed });
      } catch { /* a health report must never affect delivery */ }
      return null;
    }

    const urgent = opts?.urgent ?? categoryOf(category).urgent;
    // One entry per device this fan-out actually TRIED, so that "it reached
    // nobody" can be answered about the notification rather than about a
    // device. See `onUndelivered`.
    const attempts: Promise<{ label: string; outcome: string; detail?: string }>[] = [];
    for (const device of targets) {
      // Quiet hours: suppression at the last leg only. The record, the bell,
      // the SSE event and the out-of-band notifier have all already fired —
      // this device just is not to be buzzed right now. Urgent traffic breaks
      // through unless the device said otherwise, and the skip is written to
      // the delivery ledger as `quiet` so "did that notification arrive?" has
      // an answer instead of a blank. Not an attempt: a fan-out where every
      // device slept must not raise the "reached nobody" health alarm.
      if (inQuietHours(device.quiet, now) && !(urgent && device.quiet?.allowUrgent)) {
        if (onDelivery) {
          try {
            onDelivery({ device: device.id, label: device.label, outcome: 'quiet' });
          } catch { /* annotating a record must never affect a run */ }
        }
        continue;
      }
      // The same tag to the same device inside a few seconds is a re-render, not
      // a second event. The push service would collapse it by topic anyway; not
      // sending it at all is cheaper and does not race. A corrective opts out:
      // it rides the tag it must replace (see `opts.replace`).
      const key = `${device.id}:${message.tag}`;
      const last = this.recent.get(key);
      if (!opts?.replace && last && now - last < 5_000) continue;
      this.recent.set(key, now);

      // The console that SPOKE: a register in front of several consoles carries
      // each one's name through, so the card says which console it is about.
      const speaker = message.console ?? this.speaker;
      attempts.push(this.sendOne(device, { ...message, category, console: speaker }, urgent).then((result) => {
        const report: DeliveryReport = {
          device: device.id,
          label: device.label,
          outcome: result.kind,
          detail: result.kind === 'failed' ? result.detail
            : result.kind === 'throttled' ? `retry after ${result.retryAfter ?? 'unknown'}s`
              : undefined,
        };
        if (onDelivery) {
          try {
            onDelivery(report);
          } catch { /* annotating a record must never affect a run */ }
        }
        const { device: _id, ...rest } = report;
        return rest;
      }).catch((error: unknown) => (
        // `sendOne` handles everything it can, but a promise that rejected is
        // still a device that did not hear it — and swallowing it here is what
        // keeps the aggregate below from being an unhandled rejection.
        { label: device.label, outcome: 'failed', detail: (error as Error)?.message }
      )));
    }
    // Still not awaited by the caller — a slow push service must not stall a
    // phase — but the fan-out's own verdict is now read, once, when the last
    // attempt lands.
    if (attempts.length && this.onUndelivered) {
      void Promise.all(attempts).then((reports) => {
        if (reports.some((r) => r.outcome === 'sent')) return;
        try {
          this.onUndelivered?.({ category, tag: message.tag, title: message.title, devices: reports });
        } catch { /* a health report must never affect delivery */ }
      });
    }
    this.prune(now);
    // Returned for the one caller that must wait — the shutdown announcement,
    // whose process exits next (SHD-4). Every attempt resolves (failures are
    // reports, not rejections), so awaiting this can never throw. Null when
    // nothing was attempted (every device asleep or just told), which is a
    // different fact from a send still in flight.
    return attempts.length ? Promise.all(attempts).then(() => undefined) : null;
  }

  /** The Settings button: prove the whole chain, on one device, on demand. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const device = this.devices.find((d) => d.id === id);
    if (!device) return { ok: false, detail: 'no such device' };
    if (!this.vapid) {
      return { ok: false, detail: this.keyFailure?.error ?? 'this console has no push signing key' };
    }
    const result = await this.sendOne(device, {
      title: 'Phase Console',
      body: `Notifications are working on ${device.label}.`,
      tag: 'push-test',
      url: routeFor('health'),
      category: 'approval',
      console: this.speaker,
    }, false);
    return result.kind === 'sent'
      ? { ok: true, detail: `accepted by ${origin(device.endpoint)} (${result.status})` }
      : { ok: false, detail: `${result.kind}${'status' in result && result.status ? ` ${result.status}` : ''}` };
  }

  private async sendOne(device: Device, message: PushMessage, urgent: boolean) {
    // Unreachable through `announce`/`test`, which both refuse earlier. Here so
    // the type is honest and a future caller cannot skip the guard — and it
    // returns BEFORE the switch, so no failure is counted against the device.
    if (!this.vapid) {
      return { kind: 'failed' as const, status: 0, detail: this.keyFailure?.error ?? 'no VAPID key' };
    }
    const result = await deliver(this.vapid, device, message, {
      urgent,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    const service = origin(device.endpoint);
    switch (result.kind) {
      case 'sent':
        device.lastOkAt = new Date().toISOString();
        device.failures = 0;
        delete device.lastReject;
        // A success ends every rejection streak for this service — the outage
        // (if there was one) is over.
        for (const key of this.rejectStreaks.keys()) {
          if (key.startsWith(`${service}|`)) this.rejectStreaks.delete(key);
        }
        break;
      case 'gone':
        // Its normal end of life: the app was deleted, or permission revoked.
        log.info('push.gone', { id: device.id, label: device.label });
        this.unsubscribe(device.id);
        return result;
      case 'throttled':
        log.warn('push.throttled', { id: device.id, retryAfter: result.retryAfter });
        break;
      default: {
        if (result.status === 0 && result.reason !== 'encrypt') {
          // No network, DNS down, the machine asleep — `send.ts` answers
          // `status: 0` for "not the subscription's fault". It neither burns
          // the 15-strike budget that drops a device for good nor feeds the
          // per-service rejection streak: a laptop whose push egress was
          // blocked for fifteen announcements used to lose its phone,
          // silently, with the browser subscription still valid. An ENCRYPT
          // failure is the one status-0 that IS the subscription's fault (a
          // key that cannot be encrypted to never will be), so it counts.
          log.warn('push.unreachable', { id: device.id, label: device.label, detail: result.detail });
          break;
        }
        device.failures++;
        device.lastReject = {
          at: new Date().toISOString(), status: result.status, reason: result.reason ?? null,
        };
        // Classified streak per service|cause: 29 real sends died on
        // BadJwtToken/BadWebPushTopic with no surface but log lines — the
        // console's own alarm channel was broken and nothing said so. Fired at
        // 3 (and again at 10), never per send.
        const cause = result.reason ?? String(result.status || 'unreachable');
        const key = `${service}|${cause}`;
        const streak = (this.rejectStreaks.get(key) ?? 0) + 1;
        this.rejectStreaks.set(key, streak);
        if ((streak === 3 || streak === 10) && this.onPersistentReject) {
          try {
            this.onPersistentReject({
              service, reason: cause, streak,
              devices: this.devices.filter((d) => origin(d.endpoint) === service).map((d) => d.label),
            });
          } catch { /* a health report must never affect delivery */ }
        }
        if (device.failures >= MAX_FAILURES) {
          log.warn('push.dropped', { id: device.id, label: device.label, failures: device.failures });
          this.unsubscribe(device.id);
          return result;
        }
      }
    }
    this.persist();
    return result;
  }

  /** The dedupe map is unbounded otherwise, and a long-lived console is the point. */
  private prune(now: number): void {
    if (this.recent.size < 512) return;
    for (const [key, at] of this.recent) if (now - at > 60_000) this.recent.delete(key);
  }

  private publicOf(device: Device): PublicDevice {
    const { endpoint, keys, ...rest } = device;
    return { ...rest, service: origin(endpoint) };
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // These keys let anyone holding them send this device a notification.
      writeFileSync(this.file, `${JSON.stringify(this.devices, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log.warn('push.persist-failed', { error });
    }
  }
}

function read(file: string = FILE): Device[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Device[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d?.endpoint && d?.keys?.p256dh && d?.keys?.auth)
      .map((d) => {
        const { quiet: rawQuiet, ...rest } = d as Device & { quiet?: unknown };
        const quiet = parseQuietHours(rawQuiet);
        return {
          ...rest,
          categories: sanitiseCategories(rest.categories),
          failures: Number(rest.failures) || 0,
          // A hand-edited or half-written window is dropped rather than
          // half-honoured: quiet hours nobody asked for must not exist.
          ...(quiet && !('error' in quiet) ? { quiet } : {}),
        } as Device;
      });
  } catch {
    return [];
  }
}

/**
 * May this server POST to that endpoint?
 *
 * An endpoint is a URL the console fetches with a VAPID `Authorization` header
 * on every matching announcement, unattended, for as long as the row lives.
 * `POST /api/push/subscribe` is gated on the cross-site header and nothing
 * else, so whoever can reach it gets a request generator pointed wherever they
 * like. The comment on this check has always said loopback was refused; only
 * the scheme ever was.
 *
 * Refused: anything not `https:`; this machine by name; the loopback and
 * "this host" blocks; link-local, which is where the cloud metadata address
 * 169.254.169.254 lives; RFC 1918 and IPv6 unique-local; any other IP literal,
 * because no push service publishes one; and any bare hostname with no dot,
 * because an intranet name resolves somewhere only this network can reach.
 *
 * `new URL` normalises the classic evasions before this sees them — `127.1`,
 * `0x7f.0.0.1` and `2130706433` all arrive as `127.0.0.1`, and `999.1.1.1` is
 * not a URL at all. IPv6 arrives bracketed, which is why the brackets come off
 * first, and an IPv4-mapped address is rewritten to hex, which is why both
 * spellings are read.
 *
 * What this deliberately does NOT do is resolve the name: a hostname pointing
 * at 127.0.0.1 still passes, and saying otherwise would be the same
 * over-promise this replaces. It is a literal filter, and the doc says so.
 *
 * Exported for the tests: the table of what is and is not a push service is
 * the whole of this function's value.
 */
export function endpointRefusal(endpoint: string): string | null {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { return 'endpoint is not a URL'; }
  if (parsed.protocol !== 'https:') return 'endpoint must be https';

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const PRIVATE = 'endpoint must not be a loopback, link-local or private address';

  if (host === 'localhost' || host.endsWith('.localhost')) return PRIVATE;

  // An IPv4 literal, plainly or inside an IPv4-mapped IPv6 address. Node writes
  // the mapped form back as hex (`::ffff:7f00:1`), so both spellings are read.
  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  const octets = dotted
    ? dotted.slice(1).map(Number)
    : hexMapped
      ? [parseInt(hexMapped[1], 16) >> 8, parseInt(hexMapped[1], 16) & 0xff,
        parseInt(hexMapped[2], 16) >> 8, parseInt(hexMapped[2], 16) & 0xff]
      : null;
  if (octets) {
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return PRIVATE;          // this host, RFC 1918, loopback
    if (a === 169 && b === 254) return PRIVATE;                    // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return PRIVATE;           // RFC 1918
    if (a === 192 && b === 168) return PRIVATE;                    // RFC 1918
    return 'endpoint must be a push service, not an IP literal';
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return PRIVATE;           // loopback, unspecified
    if (/^f[cd]/.test(host)) return PRIVATE;                       // fc00::/7 unique-local
    if (/^fe[89ab]/.test(host)) return PRIVATE;                    // fe80::/10 link-local
    return 'endpoint must be a push service, not an IP literal';
  }

  if (!host.includes('.')) return 'endpoint must be a push service, not a bare host name';
  return null;
}

const QUIET_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A client may send anything. `null` clears the window; a malformed shape is
 * refused rather than coerced, because quiet hours the operator did not ask
 * for is the one misconfiguration this feature must never produce.
 */
export function parseQuietHours(value: unknown): QuietHours | null | { error: string } {
  if (value == null) return null;
  if (typeof value !== 'object') return { error: 'quiet hours must be an object or null' };
  const raw = value as { start?: unknown; end?: unknown; allowUrgent?: unknown };
  const start = String(raw.start ?? '');
  const end = String(raw.end ?? '');
  if (!QUIET_TIME_RE.test(start) || !QUIET_TIME_RE.test(end)) {
    return { error: 'quiet hours need start and end as HH:MM' };
  }
  if (start === end) return { error: 'quiet hours cannot start and end at the same minute' };
  return { start, end, allowUrgent: raw.allowUrgent !== false };
}

/**
 * Is `at` inside the window, on this process's local clock? Half-open
 * [start, end) so a window ending 08:00 hands over cleanly to one starting
 * 08:00 — and a window that crosses midnight is the union of [start, 24:00)
 * and [00:00, end).
 */
export function inQuietHours(quiet: QuietHours | undefined, at: number): boolean {
  if (!quiet) return false;
  const startM = quietMinutes(quiet.start);
  const endM = quietMinutes(quiet.end);
  if (startM == null || endM == null || startM === endM) return false;
  const t = new Date(at);
  const nowM = t.getHours() * 60 + t.getMinutes();
  return startM < endM ? nowM >= startM && nowM < endM : nowM >= startM || nowM < endM;
}

function quietMinutes(text: string): number | null {
  const m = QUIET_TIME_RE.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseSubscription(input: unknown): (Subscription & { endpoint: string }) | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'no subscription' };
  const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(sub.endpoint ?? '');
  const refusal = endpointRefusal(endpoint);
  if (refusal) return { error: refusal };

  const p256dh = String(sub.keys?.p256dh ?? '');
  const auth = String(sub.keys?.auth ?? '');
  if (Buffer.from(p256dh, 'base64url').length !== 65) return { error: 'p256dh must be a 65-byte P-256 point' };
  if (Buffer.from(auth, 'base64url').length !== 16) return { error: 'auth must be 16 bytes' };

  return { endpoint, keys: { p256dh, auth } };
}

/** This console, as a payload names it. */
const CONSOLE = { id: INSTANCE.id, name: INSTANCE.name };

/**
 * A stable tag for a thing, so repeats about it collapse rather than stack —
 * namespaced by THIS console's instance id before hashing (FLT-4).
 *
 * Without the instance the tag was a function of the parts alone, so
 * `tagFor('health', 'env-doctor')` was byte-identical on every console and
 * `tagFor('needs-you', slug, phase, …)` collided whenever two consoles ran one
 * plan slug: on one device (and on the fleet's one subscription) a card from
 * one console would silently replace another's. `topicFor` hashes the tag, so
 * the topic is namespaced by the same stroke.
 */
export function tagFor(...parts: (string | number | null | undefined)[]): string {
  return tagForInstance(INSTANCE.id, ...parts);
}

/** `tagFor` for a named console — what a test, and a fan-in, compares two consoles with. */
export function tagForInstance(instance: string, ...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256')
    .update([instance, ...parts.filter((p) => p != null)].join(':'))
    .digest('hex')
    .slice(0, 16);
}
