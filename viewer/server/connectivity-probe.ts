/**
 * The connectivity probe — one helper for "is the network back?" (control-tower
 * phase 76, #110; phase 80's attempt loop imports it too).
 *
 * A thrown fetch — `fetch failed`, DNS, TLS, a reset connection — says nothing
 * about the account or the credential it was asked with, and the usage poller
 * used to answer each one by doubling that account's back-off. After the
 * 2026-09-24 23:00–00:04Z outage every account had backed off to thirty
 * minutes, so the meters stayed pre-outage for a quarter of an hour after the
 * network was back. The poller now tells this probe instead, and the probe
 * does the waiting for everybody: one HEAD to the API's host — any HTTP answer,
 * a 404 included, proves the network carried the request — at most once per
 * `CONNECTIVITY_PROBE_MS`, and the moment one comes back it tells every
 * listener, which is when the poller reads every account at once.
 *
 * Three rules keep it cheap. The first probe waits a full interval (the
 * failure that armed it was itself the latest probe). Only one probe is ever
 * armed or in flight, however many failures report. And any real answer — a
 * meter read the endpoint served, refused or rate-limited — ends an outage at
 * once, without waiting for the probe's minute.
 */

/** The probe's interval, and the most often it asks: once a minute. */
export const CONNECTIVITY_PROBE_MS = 60_000;

/** How long one probe may take before it counts as "no network". */
const PROBE_TIMEOUT_MS = 10_000;

/** Where a probe asks by default: the host the usage endpoint and every session talk to. */
const DEFAULT_BASE = 'https://api.anthropic.com';

/**
 * Does the network carry a request to `base`? One HEAD, no credential, no
 * body: any HTTP answer is `true`, a thrown fetch (or a timeout) is `false`.
 */
export async function probeReachable(
  base: string, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    await (opts.fetchFn ?? fetch)(base, { method: 'HEAD', signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export type ConnectivityProbeOptions = {
  /** The check itself; defaults to `probeReachable(base)`. */
  probe?: () => Promise<boolean>;
  base?: string;
  fetchFn?: typeof fetch;
  everyMs?: number;
  /** Test seam: arm `fn` after `ms`, answering a cancel. Defaults to an unref'd `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

function unrefTimeout(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class ConnectivityProbe {
  private readonly check: () => Promise<boolean>;
  private readonly everyMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly listeners = new Set<() => void>();
  private cancel: (() => void) | null = null;
  private probing = false;
  private down = false;
  private stopped = false;

  constructor(opts: ConnectivityProbeOptions = {}) {
    const base = opts.base ?? DEFAULT_BASE;
    this.check = opts.probe ?? (() => probeReachable(base, opts.fetchFn ? { fetchFn: opts.fetchFn } : {}));
    this.everyMs = opts.everyMs ?? CONNECTIVITY_PROBE_MS;
    this.schedule = opts.schedule ?? unrefTimeout;
  }

  /** Is the network believed down — a transport failure seen, and nothing answered since? */
  get offline(): boolean {
    return this.down;
  }

  /** Be told, once per outage, the moment the network answers again. Returns the unsubscribe. */
  onRecovered(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A request died in transport. Starts the probe if it is not already running. */
  noteUnreachable(): void {
    if (this.stopped) return;
    this.down = true;
    if (!this.cancel && !this.probing) this.arm();
  }

  /** Something answered over the network: an outage, if there was one, is over. */
  noteReachable(): void {
    if (!this.down) return;
    this.recover();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    this.listeners.clear();
  }

  private arm(): void {
    this.cancel = this.schedule(() => {
      this.cancel = null;
      void this.probeOnce();
    }, this.everyMs);
  }

  private async probeOnce(): Promise<void> {
    if (this.stopped || !this.down) return;
    this.probing = true;
    let answered = false;
    try {
      answered = await this.check();
    } catch {
      answered = false;
    } finally {
      this.probing = false;
    }
    if (this.stopped || !this.down) return;
    if (answered) this.recover();
    else this.arm();
  }

  private recover(): void {
    this.down = false;
    this.cancel?.();
    this.cancel = null;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* one careless listener must not keep the others from hearing */
      }
    }
  }
}
