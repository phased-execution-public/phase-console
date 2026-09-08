/**
 * The debug facade — one query over every log, and one bundle for a model.
 *
 * Two surfaces, one gatherer:
 *
 *   - **`index(query)`** answers a person at a keyboard: merge the seven
 *     sources, filter, page. It is the log explorer's whole server side.
 *   - **`bundle()`** answers a MODEL: one JSON snapshot of everything that
 *     would otherwise take a session twenty tool calls to assemble, sized to
 *     be pasted into a context window and redacted so it can be.
 *
 * **Why a deps object rather than a `Service`.** Every fact here is a read, and
 * a read is testable exactly to the degree it can be driven with fixtures. The
 * `Service` is a 5000-line object with a runner, a pty broker and a watcher
 * attached; taking it whole would mean the only way to test the bundle's shape
 * is to boot one. `DebugDeps` names the eight things this module actually
 * needs, `debugDeps(service)` wires them, and every test drives the narrow one.
 *
 * **Redaction is a property of this module, not of its callers.** Everything
 * that leaves here has been through `scrubText`/`scrubValue` (secret shapes,
 * then the operator's home path). The accounts and MCP facades redact upstream
 * too — that is deliberate belt-and-braces, because a bundle is the one payload
 * whose whole purpose is to be pasted somewhere else.
 */

import type {
  DebugBucket, DebugEntry, DebugIndex, DebugQuery, DebugSource, HealthIssue,
} from './sources.ts';
import {
  DEBUG_SOURCES, PER_SOURCE_CAP, clampLimit, deliveryEntries, displayPath, healthEntries,
  journalRunIds, mergeIndex, readConsoleLog, readJournals, readOutcomes, readRulingEntries,
  readSupervisorLogs, scrubText, scrubValue, supervisorLogPaths,
} from './sources.ts';
import type { NotificationRecord } from '../notifications.ts';

/* ------------------------------------------------------------------ *
 * What this module needs from the console
 * ------------------------------------------------------------------ */

export type WatchSnapshot = { passes: number; asked: string[]; open: boolean };

export type DebugDeps = {
  /** The open source directory, or null when none is open. */
  root: () => string | null;
  /** Which plans are worth indexing, most interesting first. Bounded by the caller. */
  slugs: () => string[];
  /** The inbox, newest first — the delivery ledger rides on `record.delivery[]`. */
  notifications: () => readonly NotificationRecord[];
  /** `env-doctor`'s findings plus the runtime ones (`push-broken`). */
  environment: () => readonly HealthIssue[];
  /** `WatchScheduler.snapshot()`. Never `nextDue()` — that one prunes as it reads. */
  watches: () => WatchSnapshot | null;
  /** `GET /api/metrics`, verbatim Prometheus text. */
  metrics: () => Promise<string>;
  /** The console's own identity + capability facts, already facade-redacted. */
  console: () => ConsoleFacts;
  /** When this process started, so undated health rows have a place on the axis. */
  startedAt: () => string;
};

export type ConsoleFacts = {
  version?: string;
  generation?: number;
  platform?: string;
  instance?: { id?: string; name?: string };
  supervisor?: unknown;
  distRev?: string;
  flags?: Record<string, unknown>;
  watcher?: unknown;
  unread?: number;
  /** Anything else the state block carries that is worth a bundle. */
  [key: string]: unknown;
};

/* ------------------------------------------------------------------ *
 * How much of each plan the index reaches
 * ------------------------------------------------------------------ */

/**
 * Plans whose per-run files are read when the caller names no `slug`.
 *
 * Unbounded, this walks every journal of every plan the console has ever run —
 * on this machine that is dozens of files and tens of megabytes, to answer a
 * page that shows 500 rows. The caller orders `slugs()` by interest (live runs
 * first), so the cut keeps what somebody is looking at.
 */
export const UNSCOPED_PLAN_CAP = 8;

/**
 * Why the three per-plan sources are unreadable, in one sentence.
 *
 * One constant rather than three strings: they are unavailable for one reason
 * and a reader comparing the strip's rows should see one reason, not three
 * paraphrases of it.
 */
export const NO_ROOT_NOTE =
  'No source directory is open, so there are no runs, journals, outcomes or rulings to read.';

/**
 * A plan slug, as narrow as the rest of the console makes it.
 *
 * `runDir(root, slug)` is a bare `join`, so an unvalidated slug is a path
 * traversal: `?slug=../../../../evil` reached outside the state directory and
 * returned file CONTENTS through the index. The shape is `recovery.ts`'s and
 * `qa-session.ts`'s, which is where this guard should have been copied from in
 * the first place.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/**
 * A run id.
 *
 * `?slug=` was guarded and `?run=` was not, and they reach the SAME bare
 * `join` — so `?run=../../../secrets` read a file outside the state directory,
 * and because `Journal`'s constructor `mkdirSync`s its parent, a GET also
 * CREATED a directory out there. One parameter guarded and its twin left open
 * is the shape of most path-traversal fixes that do not work.
 *
 * `[0-9a-f]{8}` is `recovery.ts`'s vocabulary and `listRuns`'s: a run id is a
 * short hex string and nothing else has ever been one.
 */
export const RUN_ID_RE = /^[0-9a-f]{8}$/i;

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

/* ------------------------------------------------------------------ *
 * The facade
 * ------------------------------------------------------------------ */

export class Debug {
  // A field and an assignment rather than a parameter property: the server
  // tsconfig sets `erasableSyntaxOnly`, because `node server/index.ts` runs
  // TypeScript by type-stripping and a parameter property emits code.
  readonly deps: DebugDeps;

  constructor(deps: DebugDeps) {
    this.deps = deps;
  }

  /** Which plans this answer covers, given the caller's filter. */
  private planScope(query: DebugQuery): string[] {
    // The route validates too. Both, deliberately: the route is where a caller
    // gets a 400 that explains itself, and this is what makes a future route
    // that forgets an unreadable page rather than a file read.
    if (query.slug) return isSlug(query.slug) ? [query.slug] : [];
    return this.deps.slugs().slice(0, UNSCOPED_PLAN_CAP);
  }

  /**
   * Gather every source into buckets.
   *
   * A source that cannot be read is `available: false` with a `note`, never an
   * exception and never silence: "there is no supervisor log on this machine"
   * is an ANSWER, and the difference between that and "the supervisor log is
   * empty" is the whole reason somebody opened this page.
   */
  private gather(query: DebugQuery): Map<DebugSource, DebugBucket> {
    const gathered = new Map<DebugSource, DebugBucket>();
    const wanted = (source: DebugSource) => !query.sources?.length || query.sources.includes(source);
    const root = this.deps.root();
    const slugs = this.planScope(query);

    if (wanted('console')) {
      const { entries, path } = readConsoleLog();
      gathered.set('console', {
        entries,
        available: true,
        ...(path ? { path } : {}),
        ...(path ? {} : { note: 'File output is off (--log-file null); only this process’s in-memory ring is available.' }),
      });
    }

    if (wanted('supervisor')) {
      const { entries, paths, found } = readSupervisorLogs();
      const { out } = supervisorLogPaths();
      gathered.set('supervisor', {
        entries,
        available: found,
        path: paths[0] ?? out,
        ...(found ? {} : {
          note: `No ${displayPath(out)} on this machine — the console was not started by launchd or systemd, so its raw streams went to the terminal.`,
        }),
      });
    }

    if (wanted('journal')) {
      const entries: DebugEntry[] = [];
      // A run id reaches `journalFile()`, which is the same bare `join` the
      // slug reaches. Refusing here as well as at the route is what makes a
      // future caller that forgets read nothing rather than read anything.
      const runId = query.runId && !isRunId(query.runId) ? '\u0000' : query.runId;
      if (root) for (const slug of slugs) entries.push(...readJournals(root, slug, runId));
      gathered.set('journal', {
        entries: entries.slice(0, PER_SOURCE_CAP),
        available: Boolean(root),
        ...(root ? {} : { note: NO_ROOT_NOTE }),
      });
    }

    // Both of these read per-plan files, so both are unavailable for the same
    // reason `journal` is — and both must SAY so. Setting `available: false`
    // with no note left the UI's "Not readable here" strip silent while its
    // empty state said "every source this console can read was searched",
    // which is the reassurance this destination exists not to give.
    if (wanted('outcome')) {
      const entries: DebugEntry[] = [];
      if (root) for (const slug of slugs) entries.push(...readOutcomes(root, slug));
      gathered.set('outcome', {
        entries: entries.slice(0, PER_SOURCE_CAP),
        available: Boolean(root),
        ...(root ? {} : { note: NO_ROOT_NOTE }),
      });
    }

    if (wanted('ruling')) {
      const entries: DebugEntry[] = [];
      if (root) for (const slug of slugs) entries.push(...readRulingEntries(root, slug));
      // Sliced like `journal`: `readRulingEntries` caps per PLAN, so eight
      // plans could contribute eight times the constant that documents itself
      // as "rows one source may contribute before it is cut".
      gathered.set('ruling', {
        entries: entries.slice(0, PER_SOURCE_CAP),
        available: Boolean(root),
        ...(root ? {} : { note: NO_ROOT_NOTE }),
      });
    }

    if (wanted('delivery')) {
      gathered.set('delivery', {
        entries: deliveryEntries(this.deps.notifications()),
        available: true,
      });
    }

    if (wanted('health')) {
      gathered.set('health', {
        entries: healthEntries(this.deps.environment(), this.deps.startedAt()),
        available: true,
      });
    }

    return gathered;
  }

  /** The log explorer's answer: merged, filtered, newest first, capped. */
  index(query: DebugQuery = {}): DebugIndex & { slugs: string[]; delivery?: DeliveryTally } {
    const merged = mergeIndex(this.gather(query), query);
    // The tally rides along when the caller asked for the ledger, so the
    // Delivery section renders the SERVER's answer rather than re-deriving a
    // worse one client-side. `undelivered` is the figure that answers "did
    // anybody get told", and it is not the `failed` count — two implementations
    // of that rule would be two answers.
    const wantsDelivery = !query.sources?.length || query.sources.includes('delivery');
    return {
      ...merged,
      slugs: this.planScope(query),
      ...(wantsDelivery ? { delivery: tallyDelivery(this.deps.notifications()) } : {}),
    };
  }

  /**
   * Which runs a plan has journals for — the run picker's whole data source.
   *
   * Deliberately separate from `index()`: the picker must list every run,
   * including the ones whose entries the row cap dropped, or it would offer
   * fewer runs the busier the console got.
   */
  runIds(slug: string): string[] {
    const root = this.deps.root();
    return root && isSlug(slug) ? journalRunIds(root, slug) : [];
  }

  /**
   * One redacted JSON snapshot, for a model.
   *
   * The schema is versioned because something will read it programmatically —
   * that is the point — and `debug-bundle.test.ts` pins both the version and
   * the top-level key set, so adding a key is a deliberate act with a version
   * bump beside it rather than a silent shape change.
   */
  async bundle(options: { slug?: string } = {}): Promise<DebugBundle> {
    const notes: string[] = [];
    const root = this.deps.root();
    const slugs = options.slug ? [options.slug] : this.deps.slugs().slice(0, BUNDLE_PLAN_CAP);

    const index = this.index({
      ...(options.slug ? { slug: options.slug } : {}),
      limit: BUNDLE_ENTRY_CAP,
    });
    if (index.truncated) {
      notes.push(`Log rows were cut at ${BUNDLE_ENTRY_CAP}. Ask /api/debug/index for more, filtered.`);
    }
    if (!options.slug && this.deps.slugs().length > BUNDLE_PLAN_CAP) {
      notes.push(`Only the ${BUNDLE_PLAN_CAP} most active plans are covered. Add ?slug= for one plan in full.`);
    }
    if (!root) notes.push('No source directory is open: there are no plans, runs or journals in this bundle.');

    let metricsText = '';
    try { metricsText = await this.deps.metrics(); } catch (error) {
      notes.push(`Metrics could not be rendered: ${scrubText((error as Error)?.message ?? 'unknown')}`);
    }

    const delivery = tallyDelivery(this.deps.notifications());

    return {
      schema: BUNDLE_SCHEMA,
      version: BUNDLE_VERSION,
      generatedAt: new Date().toISOString(),
      console: scrubValue(this.deps.console()) as ConsoleFacts,
      root: root ? displayPath(root) : null,
      plans: slugs.map((slug) => ({ slug, runs: this.runIds(slug).slice(0, BUNDLE_RUNS_PER_PLAN) })),
      health: {
        environment: this.deps.environment().map((issue) => ({
          // `kind` too: it is a closed vocabulary today and a free string in
          // the type, and nothing on this object may skip the pass.
          kind: scrubText(issue.kind), detail: scrubText(issue.detail), fix: scrubText(issue.fix),
        })),
        // Scrubbed like everything else, and it is NOT a formality: a watch ref
        // is `cmd:"<an arbitrary command line>"` in one of its five forms, so
        // `asked` is free text a session wrote. This field shipped unscrubbed
        // for one round and carried a token and a home path straight into the
        // one payload whose stated purpose is to be pasted into a model's
        // context. Nothing on this object may skip the pass.
        watches: scrubValue(this.deps.watches()) as WatchSnapshot | null,
      },
      // Scrubbed like everything else. Every label the console emits today is a
      // slug or a state word — but "today" is the part that rots, and this is
      // the payload that gets pasted somewhere else.
      metrics: scrubValue(parseExposition(metricsText)) as MetricFamily[],
      delivery,
      entries: index.entries,
      sources: index.sources,
      notes,
    };
  }
}

/* ------------------------------------------------------------------ *
 * The bundle's schema
 * ------------------------------------------------------------------ */

export const BUNDLE_SCHEMA = 'phase-console/debug-bundle';
/**
 * Bump on any change to the SHAPE — a key added, removed or retyped.
 *
 * Not on a change to what a key contains: a reader keyed on the version must
 * be able to trust that `version: 1` always has these keys, and must not be
 * churned every time a new journal event appears inside `entries`.
 */
export const BUNDLE_VERSION = 1;

/** Plans covered when the caller names none. */
export const BUNDLE_PLAN_CAP = 5;
/** Runs listed per plan. */
export const BUNDLE_RUNS_PER_PLAN = 5;
/**
 * Log rows the bundle carries.
 *
 * 600 rows of the shape above is roughly 150-200 KB of JSON — a few tens of
 * thousands of tokens, which fits any current context window beside the code
 * the reader also needs. More would be a file somebody has to grep, which is
 * the situation this endpoint exists to end.
 */
export const BUNDLE_ENTRY_CAP = 600;

export type MetricSample = { labels: Record<string, string>; value: number };
export type MetricFamily = { name: string; type: string; help: string; samples: MetricSample[] };

export type DeliveryTally = {
  /** One count per `DELIVERY_OUTCOMES` word actually seen. */
  outcomes: Record<string, number>;
  /** Announcements whose fan-out reached nobody at all. */
  undelivered: number;
  /** Announcements with at least one delivery row. */
  announcements: number;
  devices: number;
};

export type DebugBundle = {
  schema: typeof BUNDLE_SCHEMA;
  version: number;
  generatedAt: string;
  console: ConsoleFacts;
  root: string | null;
  plans: { slug: string; runs: string[] }[];
  health: { environment: HealthIssue[]; watches: WatchSnapshot | null };
  metrics: MetricFamily[];
  delivery: DeliveryTally;
  entries: DebugEntry[];
  sources: DebugIndex['sources'];
  /** What was left out, and how to ask for it. Never empty of meaning. */
  notes: string[];
};

/* ------------------------------------------------------------------ *
 * The delivery tally
 * ------------------------------------------------------------------ */

/**
 * Count the ledger.
 *
 * `undelivered` is the figure that matters and it is not "failures": an
 * announcement is undelivered when NO device took it, which is a different
 * question from how many rows said `failed`. A fan-out to three devices where
 * one succeeded is delivered. And `quiet` is held, not failed — a device inside
 * its own quiet hours was never asked, on purpose — so it does not make an
 * announcement undelivered on its own.
 */
export function tallyDelivery(records: readonly NotificationRecord[]): DeliveryTally {
  const outcomes: Record<string, number> = {};
  const devices = new Set<string>();
  let announcements = 0;
  let undelivered = 0;

  for (const record of records) {
    const rows = record.delivery ?? [];
    if (!rows.length) continue;
    announcements += 1;
    let reached = false;
    for (const row of rows) {
      outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
      devices.add(row.device);
      if (row.outcome === 'sent') reached = true;
    }
    // Every row was `quiet` ⇒ nothing was attempted, so nothing failed to
    // arrive. That is held, and counting it as undelivered would raise an
    // alarm about the feature working exactly as the operator configured it.
    const allQuiet = rows.every((row) => row.outcome === 'quiet');
    if (!reached && !allQuiet) undelivered += 1;
  }

  return { outcomes, undelivered, announcements, devices: devices.size };
}

/* ------------------------------------------------------------------ *
 * Prometheus text -> JSON
 * ------------------------------------------------------------------ */

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/;

/**
 * Parse the exposition `GET /api/metrics` serves.
 *
 * The client renders THIS rather than a second server projection, so what the
 * Debug page shows and what a Prometheus scrape sees cannot disagree — the
 * page is a reader of the endpoint, not a sibling of it.
 *
 * Deliberately tolerant: an unparseable line is skipped rather than thrown on.
 * A metrics endpoint that renders is more useful than one that 500s because a
 * future family used a label value this regex did not expect.
 */
export function parseExposition(text: string): MetricFamily[] {
  const families = new Map<string, MetricFamily>();
  const family = (name: string): MetricFamily => {
    let found = families.get(name);
    if (!found) { found = { name, type: 'untyped', help: '', samples: [] }; families.set(name, found); }
    return found;
  };

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const help = /^#\s*HELP\s+(\S+)\s+(.*)$/.exec(line);
      if (help) { family(help[1]).help = help[2]; continue; }
      const type = /^#\s*TYPE\s+(\S+)\s+(\S+)$/.exec(line);
      if (type) { family(type[1]).type = type[2]; continue; }
      continue;
    }
    const m = SAMPLE_LINE.exec(line);
    if (!m) continue;
    const value = Number(m[3].trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    family(m[1]).samples.push({ labels: parseLabels(m[2]), value });
  }

  return [...families.values()];
}

function parseLabels(block: string | undefined): Record<string, string> {
  if (!block) return {};
  const labels: Record<string, string> = {};
  for (const [, key, value] of block.slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
    labels[key] = value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
  }
  return labels;
}

/* ------------------------------------------------------------------ *
 * Query parsing, shared by the two routes
 * ------------------------------------------------------------------ */

/**
 * Read a `DebugQuery` off a URL.
 *
 * Every value is validated against its vocabulary and an unknown one is
 * DROPPED rather than guessed — a URL is user input, and `?source=journals`
 * (plural, a typo) must show everything rather than silently show nothing and
 * look like an empty log.
 */
export function parseDebugQuery(params: URLSearchParams): DebugQuery {
  const list = (key: string): string[] => params.getAll(key)
    .flatMap((raw) => raw.split(','))
    .map((word) => word.trim())
    .filter(Boolean);

  const sources = list('source').filter((word): word is DebugSource =>
    (DEBUG_SOURCES as readonly string[]).includes(word));
  const levels = list('level').filter((word): word is 'info' | 'warn' | 'error' =>
    word === 'info' || word === 'warn' || word === 'error');

  const phaseRaw = params.get('phase');
  const phase = phaseRaw !== null && phaseRaw !== '' && Number.isFinite(Number(phaseRaw))
    ? Number(phaseRaw) : undefined;

  const query: DebugQuery = { limit: clampLimit(Number(params.get('limit') ?? NaN)) };
  if (sources.length) query.sources = sources;
  if (levels.length) query.levels = levels;
  for (const key of ['since', 'until', 'q', 'slug', 'runId'] as const) {
    const value = params.get(key === 'runId' ? 'run' : key);
    if (value) query[key] = value;
  }
  if (phase !== undefined) query.phase = phase;
  return query;
}
