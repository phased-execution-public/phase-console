/**
 * This console's half of the fleet (zero-touch phase 17) — the interim that
 * needs no new identity: the heartbeat that makes liveness a read, the machine
 * lane ceiling every console acquires against, and the one reader of the
 * census a route serves.
 *
 * Everything file-shaped lives in `shared/instances.mjs`, because bash reads the
 * same files (`agent.sh status`, the presence hook); this module is the part
 * only a running console has — a clock, a scheduler, a pid.
 *
 * Never throws into a caller. A heartbeat that cannot be written is a console
 * that reads `stopped` to its siblings a minute later, which is a truer failure
 * than a console that crashed because its registry was read-only.
 */

import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { HEARTBEAT_MS } from '../shared/fleet-model.js';
import {
  acquireLaneToken,
  beatInstance,
  census,
  fleetProfile,
  laneTokensDir,
  liveLaneTokens,
  markInstanceStopped,
  releaseLaneToken,
} from '../shared/instances.mjs';
import { SKILL_DIR } from './config.ts';
import { log } from './log.ts';

/** The package version this console was loaded from — read once, `null` when unreadable. */
export const CONSOLE_VERSION: string | null = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(SKILL_DIR, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
})();

/** What a beat reports about this console, read fresh on every beat. */
export type HeartbeatFacts = {
  port: number;
  supervisor: string | null;
  lanes: { live: number; max: number };
  needsYou: number | null;
  lastRemoteAt: string | null;
  build: { version: string | null; rev: string | null };
};

/**
 * The beat: `lastSeenAt` into this console's registry row every `HEARTBEAT_MS`,
 * with the facts a fleet reader shows beside it. Unref'd, so it never holds a
 * process up; `stop()` on close; `stopped()` is the clean exit's own record.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly id: string;
  private readonly facts: () => HeartbeatFacts;
  private readonly opts: { intervalMs?: number; env?: NodeJS.ProcessEnv };

  constructor(
    id: string,
    facts: () => HeartbeatFacts,
    opts: { intervalMs?: number; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.id = id;
    this.facts = facts;
    this.opts = opts;
  }

  start(): void {
    if (this.timer) return;
    this.beat();
    this.timer = setInterval(() => this.beat(), this.opts.intervalMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }

  beat(): void {
    try {
      const facts = this.facts();
      const row = beatInstance(
        this.id,
        {
          pid: process.pid,
          port: facts.port,
          supervisor: facts.supervisor,
          lanes: facts.lanes,
          needsYou: facts.needsYou,
          lastRemoteAt: facts.lastRemoteAt,
          build: facts.build,
        },
        this.opts.env,
      );
      if (row) this.failures = 0;
      else if (++this.failures === 3) log.warn('fleet.heartbeat-failed', { id: this.id, failures: this.failures });
    } catch (error) {
      if (++this.failures === 3) log.warn('fleet.heartbeat-failed', { id: this.id, failures: this.failures, error: String(error) });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The clean exit, written by the console that is exiting (FLT-5). */
  stopped(): void {
    this.stop();
    try {
      markInstanceStopped(this.id, this.opts.env);
    } catch (error) {
      log.warn('fleet.stopped-write-failed', { id: this.id, error: String(error) });
    }
  }
}

/** `GET /api/instances` — the census, verbatim, so `phase-console list --json` answers the same thing. */
export function instancesView(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof census> {
  return census(env);
}

/** One lane on the machine, as the scheduler reads it. */
export type MachineLane = {
  instance: string;
  name?: string;
  port?: number;
  slug: string;
  phase: number | null;
  runId?: string;
  grant?: string;
  pid: number;
  at: string;
  file: string;
};

/** What the scheduler needs to hold the MACHINE ceiling (FLT-7) — `MachineLanes` below, or a test double. */
export type SchedulerMachine = {
  /** `fleet.json` `maxSessions`, or null for no machine ceiling. */
  max(): number | null;
  /** Every live lane on the machine, this console's included. */
  lanes(): MachineLane[];
  /** Take a lane for this grant; `ok: false` names who holds them all. */
  acquire(grant: { id: string; slug: string; phase: number | null; runId: string }): {
    ok: boolean;
    holders: MachineLane[];
  };
  release(grant: { id: string; slug: string; phase: number | null }): void;
  /** Called whenever a lane anywhere on the machine is taken or given back. Returns the unsubscribe. */
  watch?(onChange: () => void): () => void;
  /** This console's own id — how the scheduler tells its lanes from a sibling's. */
  readonly instanceId: string;
};

/**
 * The machine ceiling over `<stateHome>/fleet/lanes/`, one token file per live
 * lane of every console (`shared/instances.mjs acquireLaneToken`).
 *
 * The profile is read at most once a second: `max()` is asked on every scan,
 * and a settings file edited by hand must land on the next scan without a
 * restart, which a one-second memo still honours.
 */
export class MachineLanes implements SchedulerMachine {
  private cached: { at: number; max: number | null } | null = null;
  readonly instanceId: string;
  private readonly identity: { name: string; port: () => number };
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    instanceId: string,
    identity: { name: string; port: () => number },
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.instanceId = instanceId;
    this.identity = identity;
    this.env = env;
  }

  max(): number | null {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 1_000) return this.cached.max;
    let max: number | null = null;
    try {
      max = fleetProfile(this.env).maxSessions ?? null;
    } catch {
      max = null;
    }
    this.cached = { at: now, max };
    return max;
  }

  lanes(): MachineLane[] {
    try {
      return liveLaneTokens(this.env) as MachineLane[];
    } catch {
      return [];
    }
  }

  acquire(grant: { id: string; slug: string; phase: number | null; runId: string }): {
    ok: boolean;
    holders: MachineLane[];
  } {
    try {
      const result = acquireLaneToken(
        {
          instance: this.instanceId,
          name: this.identity.name,
          port: this.identity.port(),
          slug: grant.slug,
          phase: grant.phase,
          runId: grant.runId,
          grant: grant.id,
        },
        this.max(),
        this.env,
      );
      return { ok: result.ok, holders: (result.holders ?? []) as MachineLane[] };
    } catch (error) {
      // A lane file that cannot be written must not stop the console's own
      // ceiling from admitting: the per-console cap still holds.
      log.warn('fleet.lane-token-failed', { error: String(error) });
      return { ok: true, holders: [] };
    }
  }

  release(grant: { id: string; slug: string; phase: number | null }): void {
    try {
      releaseLaneToken({ instance: this.instanceId, slug: grant.slug, phase: grant.phase, grant: grant.id }, this.env);
    } catch {
      /* a token that could not be removed dies with this process's pid */
    }
  }

  watch(onChange: () => void): () => void {
    let watcher: FSWatcher | null = null;
    try {
      mkdirSync(laneTokensDir(this.env), { recursive: true });
      watcher = watch(laneTokensDir(this.env), () => onChange());
      watcher.on('error', () => {
        /* the idle poll is the backstop */
      });
      watcher.unref?.();
    } catch {
      watcher = null;
    }
    return () => {
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    };
  }
}
