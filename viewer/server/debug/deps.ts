/**
 * Wiring: a `Service` in, a `Debug` out.
 *
 * The one file that knows both halves. `debug/index.ts` takes the narrow
 * `DebugDeps` so it can be tested with fixtures; this maps the console's real
 * object onto it, and is where any future "which plans matter" policy lives.
 *
 * The `Service` import is type-only, so nothing here joins the module graph at
 * runtime and adding a debug surface cannot reorder the console's startup.
 */

import { statSync } from 'node:fs';

import type { Service } from '../service.ts';
import { Debug, type ConsoleFacts, type DebugDeps } from './index.ts';
import { consoleDetached, previousRunEndedCleanly } from '../log.ts';
import { INSTANCE, distRev } from '../config.ts';
import { runDir } from '../runner/state.ts';

/**
 * How many announcements the delivery ledger reads back.
 *
 * The store keeps 500 rows / 30 days / 4 MB, so this is "all of them" — the
 * cap is the store's, and asking for more would only paginate a file that is
 * already bounded.
 */
export const LEDGER_LIMIT = 500;

/**
 * Plans, most recently ACTIVE first.
 *
 * The unscoped index and the bundle both cut this list, so the order decides
 * what a reader gets for free — and the plan somebody is debugging is almost
 * always the one that just did something. "Just did something" is the mtime of
 * the plan's run directory, which a live lane writes to on every journal line;
 * a plan that has never run has none, and falls back to its plan file's mtime
 * so it still sorts sensibly among its peers rather than to the bottom as 0.
 */
export function slugsByInterest(service: Service): string[] {
  const root = service.root?.path;
  const records = service.store?.list() ?? [];

  const activity = (slug: string, planMtime: number): number => {
    if (!root) return planMtime;
    try { return Math.max(statSync(runDir(root, slug)).mtimeMs, planMtime); } catch { return planMtime; }
  };

  return records
    .map((record) => ({ slug: record.slug, at: activity(record.slug, record.planMtime ?? 0) }))
    .sort((a, b) => b.at - a.at)
    .map((row) => row.slug);
}

export function debugDeps(service: Service): DebugDeps {
  return {
    root: () => service.root?.path ?? null,
    slugs: () => slugsByInterest(service),
    notifications: () => service.notifications.list({ limit: LEDGER_LIMIT }).items,
    environment: () => service.environment.issues,
    // `snapshot()` and never `nextDue()`: the latter prunes stale rows as it
    // reads, so calling it here would turn a page poll into a state change.
    watches: () => {
      try { return service.watchClock.snapshot(); } catch { return null; }
    },
    metrics: () => service.metrics(),
    startedAt: () => new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    console: (): ConsoleFacts => ({
      // The same pair `phase_console_build_info` is labelled with, read the
      // same way — a bundle and a scrape disagreeing about which console this
      // is would be the first thing to mislead somebody reading both.
      version: distRev() ?? 'unbuilt',
      instance: { id: INSTANCE.id, name: INSTANCE.name },
      generation: service.generation,
      platform: process.platform,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      // Both from `log.ts`, and both are the kind of fact that only matters
      // once: a detached console explains a blank page that answers /api/state,
      // and an unclean previous exit explains why state looks half-written.
      detached: consoleDetached(),
      previousRunEndedCleanly: previousRunEndedCleanly(),
      flags: {
        allowWrites: service.flags.allowWrites,
        allowRun: service.flags.allowRun,
        allowTerminal: service.flags.allowTerminal,
        allowAgent: service.flags.allowAgent,
        allowAccounts: service.flags.allowAccounts,
        allowMcp: service.flags.allowMcp,
        allowWebhooks: service.flags.allowWebhooks,
      },
      unread: safely(() => service.notifications.unread()),
      // Lifted out of `/api/state` rather than read off the service, because
      // `watcher` is protected on `ServiceBase` — and reading the state block
      // is the better answer anyway: the bundle then says what the page says,
      // instead of a second projection that can drift from it.
      ...pick(safely(() => service.state()), STATE_FACTS),
    }),
  };
}

/**
 * The `/api/state` keys a bundle carries.
 *
 * Named rather than spread: `state()` also carries `runs`, `prefs` and the
 * fleet, which are megabytes and are not what a bundle is for. Adding a key is
 * a deliberate act; `debug-bundle.test.ts` pins the resulting shape.
 */
export const STATE_FACTS = [
  'supervisor', 'serverStale', 'distRev', 'staticRoot', 'watcher',
  'port', 'scriptsDir', 'concurrency', 'autopilot',
] as const;

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {};
  const from = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in from) out[key] = from[key];
  return out;
}

/** A fact worth having is never worth failing a bundle for. */
function safely<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

export function debugFor(service: Service): Debug {
  return new Debug(debugDeps(service));
}
