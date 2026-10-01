/**
 * Stored triggers: "when X happens, press Y" (control-tower phase 98, #137).
 *
 * Supervising four runs for a day, nearly every correction had that shape, and
 * the console took only "press Y now" — so each became a shell script polling
 * `/api/runs` every 20 s for up to six hours. Seven in one day. Nobody else
 * could see them, they raced the console (a relaunch watcher lost a 20-second
 * pause to a switch the operator made by hand), they died with their shell, and
 * each hand-wrote the console's header. A trigger is the same correction kept
 * where the console can see it:
 *
 *   - `{when, then, once|every, expiresAt, note}` — `when` is `parseWhen`'s
 *     grammar (`shared/verb-model.js`), `then` any verb the table marks
 *     `trigger`, with its body.
 *   - STORED per plan (`runs/<instance>/<slug>/triggers.json`, beside the
 *     mailbox and the ruling ledger) rather than on one run: "when the run
 *     pauses, resume it" is about the plan, and outlives the run it was armed
 *     on. It survives a restart because it is a file.
 *   - EXACTLY ONCE for `once`: the firing is written to the file BEFORE the
 *     verb is pressed, so a console that dies between the two has spent the
 *     trigger rather than pressing its verb twice.
 *   - FIRED THROUGH THE ONE DOOR: `deps.press` is `pressVerb`
 *     (`server/verb-press.ts`), which calls the same `Service` method the
 *     route calls — under an actor of the trigger's OWN door, `trigger`, a
 *     member of `START_DOORS`: whatever it starts is an automatic start, and
 *     the per-instance ceiling counts it. `by` is still the person who armed
 *     it, and the note rides as its `reason`.
 *   - JOURNALLED on the plan's run: `trigger.armed`, `trigger.fired` (with the
 *     verb's answer), `trigger.expired`, `trigger.cancelled`.
 *
 * Two kinds of `when`. An EVENT (`phase-boarded`, `lane-boundary`) fires on
 * the next one observed. A STATE (`run-paused`, `phase-done`, `phase-settled`,
 * `entry-queued`, `at`) also fires when it is found TRUE — at arming, at boot
 * and on every run write — because that is what the polling scripts did, and a
 * run that paused while the console was down must still be resumed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { PHASE_IN_FLIGHT, SETTLED } from '../shared/run-lifecycle.js';
import {
  TRIGGER_MAX_LIFE_MS, TRIGGERS_PER_PLAN, parseWhen, verbNamed, type TRIGGER_MODES, type TRIGGER_STATES,
} from '../shared/verb-model.js';
import { doorActor, type StartActor } from './actor.ts';
import { log } from './log.ts';
import type { Actor } from './runner/state.ts';

/* ------------------------------------------------------------------ *
 * What a run looks like to a predicate
 * ------------------------------------------------------------------ */

/**
 * The facts a `when` or a long poll's `for` is judged against — the slim
 * projection's own fields, so the answer a wait gives is the answer
 * `run status` prints.
 */
export type RunFacts = {
  runId: string | null;
  status: string | null;
  phases: Record<string, string>;
  /** Phases with a live admission-queue entry. */
  queued: number[];
};

export type ParsedWhen = { event: string; phase?: number; at?: string; status?: string };

/**
 * Does a STATE predicate hold on these facts? `null` for a pure event
 * (`lane-boundary`; `phase-boarded` for a trigger) — only an observation can
 * make those true. The long poll passes `wait: true`, under which a phase has
 * "boarded" once its record has left `pending`.
 */
export function holds(when: ParsedWhen, facts: RunFacts | null, opts: { wait?: boolean; now?: number } = {}): boolean | null {
  const status = (phase?: number) => (phase === undefined ? undefined : facts?.phases[String(phase)]);
  switch (when.event) {
    case 'status': return facts?.status === when.status;
    case 'run-paused': return facts?.status === 'paused';
    case 'phase-done': return status(when.phase) === 'done';
    case 'phase-settled': return (SETTLED as readonly string[]).includes(status(when.phase) ?? '');
    case 'entry-queued': return Boolean(when.phase !== undefined && facts?.queued.includes(when.phase));
    case 'at': return Date.parse(when.at ?? '') <= (opts.now ?? Date.now());
    case 'phase-boarded': {
      if (!opts.wait) return null;
      const now = status(when.phase);
      return Boolean(now && now !== 'pending' && now !== 'queued');
    }
    default: return null;
  }
}

/**
 * One thing that happened, as the service saw it go by: a journal line of a
 * live run, or a phase record changing status.
 */
export type Observation =
  | { slug: string; kind: 'journal'; event: string; phase?: number }
  | { slug: string; kind: 'phase'; phase: number; status: string };

/** Does this observation make an EVENT `when` true? */
export function observed(when: ParsedWhen, seen: Observation): boolean {
  if (seen.kind === 'journal') {
    if (when.event === 'phase-boarded') return seen.event === 'phase.start' && seen.phase === when.phase;
    if (when.event === 'phase-done') return seen.event === 'phase.done' && seen.phase === when.phase;
    if (when.event === 'run-paused') return seen.event === 'run.paused';
    if (when.event === 'entry-queued') return seen.event === 'phase.queued' && seen.phase === when.phase;
    return false;
  }
  const left = !(PHASE_IN_FLIGHT as readonly string[]).includes(seen.status) && seen.status !== 'queued' && seen.status !== 'pending';
  if (when.event === 'lane-boundary') return left;
  if (when.event === 'phase-settled') return seen.phase === when.phase && (SETTLED as readonly string[]).includes(seen.status);
  if (when.event === 'phase-done') return seen.phase === when.phase && seen.status === 'done';
  return false;
}

/* ------------------------------------------------------------------ *
 * The stored trigger
 * ------------------------------------------------------------------ */

/** A trigger's life, derived from the owner (`TRIGGER_STATES`), never re-typed. */
export type TriggerState = (typeof TRIGGER_STATES)[number];

export type TriggerFiring = { at: string; cause: string; ok: boolean; status: number; error?: string };

export type Trigger = {
  id: string;
  slug: string;
  when: string;
  verb: string;
  body: Record<string, unknown>;
  mode: (typeof TRIGGER_MODES)[number];
  expiresAt: string | null;
  note: string | null;
  armedAt: string;
  armedBy: Actor;
  state: TriggerState;
  firings: TriggerFiring[];
  endedAt?: string;
  endedBy?: string;
};

export type TriggerSpec = {
  when?: unknown;
  verb?: unknown;
  body?: unknown;
  every?: unknown;
  mode?: unknown;
  expiresAt?: unknown;
  note?: unknown;
};

/** The firings kept on an `every` trigger — its history, not a log. */
const FIRINGS_KEPT = 20;
/**
 * An `every` trigger fires at most once in this long. Its verb's own writes
 * are events too, and a trigger that answers its own echo is a loop.
 */
export const EVERY_MIN_GAP_MS = 10_000;
/** A note is a sentence. */
const NOTE_MAX = 500;

/** The actor a trigger presses its verb as: its own door, the armer's name, the note as the why. */
export function triggerActor(trigger: Pick<Trigger, 'id' | 'when' | 'armedBy' | 'note'>): StartActor {
  return {
    ...doorActor('trigger', { by: trigger.armedBy.by, via: 'event', origin: 'trigger', trigger: `${trigger.id} ${trigger.when}` }),
    ...(trigger.note ? { reason: trigger.note } : {}),
  };
}

export type VerbAnswer = { ok: boolean; status: number; error?: string; body?: unknown };

export type TriggerDeps = {
  /** The plan's trigger file. */
  file: (slug: string) => string;
  /** The one in-process door (`pressVerb`). */
  press: (slug: string, verb: string, body: Record<string, unknown>, actor: StartActor) => Promise<VerbAnswer>;
  /** One journal line on the plan's run. */
  journal: (slug: string, event: TriggerEvent, payload: Record<string, unknown>, phase?: number) => void;
  /** The plan's latest run, as a predicate reads it — null when it has none. */
  facts: (slug: string) => RunFacts | null;
  emit?: (slug: string) => void;
  now?: () => Date;
};

export type TriggerEvent = 'trigger.armed' | 'trigger.fired' | 'trigger.expired' | 'trigger.cancelled';

/**
 * The engine: one per console. Everything it holds in memory is a cache of the
 * files; every change is written before it is acted on.
 */
export class TriggerEngine {
  private readonly deps: TriggerDeps;
  private readonly plans = new Map<string, Trigger[]>();
  /** Ids a firing is queued or running for — a `once` trigger enters at most once. */
  private readonly inFlight = new Set<string>();
  /**
   * What each STATE trigger read last time it was judged: an `every` trigger
   * fires on the state's EDGE, not on every write while it holds — a paused
   * run is written many times, and "when it pauses" means once per pause.
   */
  private readonly lastHeld = new Map<string, boolean>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(deps: TriggerDeps) {
    this.deps = deps;
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** Every trigger of a plan, armed first, newest first within each. */
  list(slug: string): Trigger[] {
    const rank = (t: Trigger) => (t.state === 'armed' ? 0 : 1);
    return [...this.load(slug)].sort((a, b) => rank(a) - rank(b) || b.armedAt.localeCompare(a.armedAt));
  }

  /** Read the plans that have files, judge their states, arm the clock. */
  boot(slugs: readonly string[]): void {
    for (const slug of slugs) {
      if (existsSync(this.deps.file(slug))) this.evaluate(slug);
    }
    this.reschedule();
  }

  arm(slug: string, spec: TriggerSpec, actor: Actor): { ok: true; trigger: Trigger } | { ok: false; status: number; error: string } {
    const when = typeof spec.when === 'string' ? spec.when.trim() : '';
    const parsed = parseWhen(when);
    if ('error' in parsed) return { ok: false, status: 400, error: parsed.error };
    const name = typeof spec.verb === 'string' ? spec.verb.trim() : '';
    const row = verbNamed(name);
    if (!row?.trigger) {
      return { ok: false, status: 400, error: `a trigger presses a verb the table marks triggerable — "${name || '(none)'}" is not one` };
    }
    const body = spec.body && typeof spec.body === 'object' && !Array.isArray(spec.body)
      ? JSON.parse(JSON.stringify(spec.body)) as Record<string, unknown> : {};
    const now = this.now();
    let expiresAt: string | null = null;
    if (spec.expiresAt !== undefined && spec.expiresAt !== null && spec.expiresAt !== '') {
      const ms = Date.parse(String(spec.expiresAt));
      if (!Number.isFinite(ms)) return { ok: false, status: 400, error: 'expiresAt takes an ISO 8601 time' };
      if (ms <= now.getTime()) return { ok: false, status: 400, error: 'expiresAt is already past' };
      expiresAt = new Date(Math.min(ms, now.getTime() + TRIGGER_MAX_LIFE_MS)).toISOString();
    } else {
      expiresAt = new Date(now.getTime() + TRIGGER_MAX_LIFE_MS).toISOString();
    }
    const mode = spec.every === true || spec.mode === 'every' ? 'every' : 'once';
    const plan = this.load(slug);
    if (plan.filter((t) => t.state === 'armed').length >= TRIGGERS_PER_PLAN) {
      return { ok: false, status: 409, error: `${slug} already holds ${TRIGGERS_PER_PLAN} armed triggers — cancel one first` };
    }
    const note = typeof spec.note === 'string' && spec.note.trim() ? spec.note.trim().slice(0, NOTE_MAX) : null;
    const trigger: Trigger = {
      id: randomBytes(6).toString('hex'),
      slug,
      when,
      verb: row.name,
      body,
      mode,
      expiresAt,
      note,
      armedAt: now.toISOString(),
      armedBy: { by: actor.by, via: actor.via, origin: actor.origin, remoteUser: actor.remoteUser ?? null, ...(actor.reason ? { reason: actor.reason } : {}) },
      state: 'armed',
      firings: [],
    };
    plan.push(trigger);
    this.save(slug);
    this.deps.journal(slug, 'trigger.armed', {
      id: trigger.id, when, verb: trigger.verb, body, mode, expiresAt, note, ...actor,
    }, 'phase' in parsed ? parsed.phase : undefined);
    // A STATE already true fires now: arming "when the run pauses" on a run
    // that is paused is what a polling script would have done on its first poll.
    this.evaluate(slug);
    this.reschedule();
    return { ok: true, trigger };
  }

  cancel(slug: string, id: string, actor: Actor): { ok: true; trigger: Trigger } | { ok: false; status: number; error: string } {
    const trigger = this.load(slug).find((t) => t.id === id);
    if (!trigger) return { ok: false, status: 404, error: `no trigger ${id} on ${slug}` };
    if (trigger.state !== 'armed') return { ok: false, status: 409, error: `trigger ${id} is already ${trigger.state}` };
    this.end(trigger, 'cancelled', actor.by);
    this.deps.journal(slug, 'trigger.cancelled', { id, when: trigger.when, verb: trigger.verb, ...actor });
    this.reschedule();
    return { ok: true, trigger };
  }

  /** Something happened: fire every armed trigger it makes true. */
  observe(seen: Observation): void {
    if (this.closed) return;
    // `load` caches an empty list for a plan with no file, so a run that
    // journals hundreds of lines costs one read, not one per line.
    const plan = this.load(seen.slug);
    if (!plan.length) return;
    for (const trigger of plan) {
      if (trigger.state !== 'armed') continue;
      const parsed = parseWhen(trigger.when);
      if ('error' in parsed) continue;
      if (observed(parsed, seen)) this.enqueue(trigger, seen.kind === 'journal' ? seen.event : `phase ${seen.phase} ${seen.status}`);
    }
  }

  /** Judge every armed STATE trigger of a plan against its run as it stands. */
  evaluate(slug: string): void {
    if (this.closed) return;
    const armed = this.load(slug).filter((t) => t.state === 'armed');
    if (!armed.length) return;
    const now = this.now().getTime();
    let facts: RunFacts | null | undefined;
    for (const trigger of armed) {
      if (trigger.expiresAt && Date.parse(trigger.expiresAt) <= now) {
        this.end(trigger, 'expired');
        this.deps.journal(slug, 'trigger.expired', { id: trigger.id, when: trigger.when, verb: trigger.verb });
        continue;
      }
      const parsed = parseWhen(trigger.when);
      if ('error' in parsed) continue;
      if (parsed.event !== 'at' && facts === undefined) facts = this.deps.facts(slug);
      const held = holds(parsed, facts ?? null, { now }) === true;
      const was = this.lastHeld.get(trigger.id) ?? false;
      this.lastHeld.set(trigger.id, held);
      if (held && (trigger.mode === 'once' || !was)) this.enqueue(trigger, `${trigger.when} holds`);
    }
  }

  /** Resolves when every firing queued so far has been pressed and written down. */
  settled(): Promise<void> { return this.queue; }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /* ---- the acting half ---- */

  private enqueue(trigger: Trigger, cause: string): void {
    if (trigger.mode === 'once' && this.inFlight.has(trigger.id)) return;
    this.inFlight.add(trigger.id);
    this.queue = this.queue.then(() => this.fire(trigger, cause)).catch((error) => {
      log.warn('trigger.fire-failed', { id: trigger.id, error: String((error as Error)?.message ?? error) });
    });
  }

  private async fire(trigger: Trigger, cause: string): Promise<void> {
    try {
      if (trigger.state !== 'armed' || this.closed) return;
      const last = trigger.firings.at(-1);
      if (trigger.mode === 'every' && last && this.now().getTime() - Date.parse(last.at) < EVERY_MIN_GAP_MS) return;
      const at = this.now().toISOString();
      const firing: TriggerFiring = { at, cause, ok: false, status: 0 };
      // Spent BEFORE the press, and on disk: a console that dies between the
      // two must not press the verb a second time after its restart.
      if (trigger.mode === 'once') { trigger.state = 'fired'; trigger.endedAt = at; }
      trigger.firings = [...trigger.firings, firing].slice(-FIRINGS_KEPT);
      this.save(trigger.slug);
      let answer: VerbAnswer;
      try {
        answer = await this.deps.press(trigger.slug, trigger.verb, trigger.body, triggerActor(trigger));
      } catch (error) {
        answer = { ok: false, status: 500, error: String((error as Error)?.message ?? error) };
      }
      firing.ok = answer.ok;
      firing.status = answer.status;
      if (!answer.ok && answer.error) firing.error = answer.error.slice(0, 500);
      this.save(trigger.slug);
      const parsed = parseWhen(trigger.when);
      this.deps.journal(trigger.slug, 'trigger.fired', {
        id: trigger.id, when: trigger.when, verb: trigger.verb, cause, mode: trigger.mode,
        ok: firing.ok, status: firing.status, ...(firing.error ? { error: firing.error } : {}),
        by: trigger.armedBy.by, ...(trigger.note ? { note: trigger.note } : {}),
      }, !('error' in parsed) ? parsed.phase : undefined);
    } finally {
      if (trigger.mode === 'every') this.inFlight.delete(trigger.id);
      this.reschedule();
    }
  }

  private end(trigger: Trigger, state: 'expired' | 'cancelled', by?: string): void {
    trigger.state = state;
    trigger.endedAt = this.now().toISOString();
    if (by) trigger.endedBy = by;
    this.save(trigger.slug);
  }

  /** One clock for every `at:` and every expiry, at the soonest of them. */
  private reschedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let soonest = Number.POSITIVE_INFINITY;
    for (const plan of this.plans.values()) {
      for (const trigger of plan) {
        if (trigger.state !== 'armed') continue;
        const parsed = parseWhen(trigger.when);
        if (!('error' in parsed) && parsed.at) soonest = Math.min(soonest, Date.parse(parsed.at));
        if (trigger.expiresAt) soonest = Math.min(soonest, Date.parse(trigger.expiresAt));
      }
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.min(Math.max(soonest - this.now().getTime(), 1000), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const slug of this.plans.keys()) this.evaluate(slug);
      this.reschedule();
    }, delay);
    this.timer.unref?.();
  }

  /* ---- the file ---- */

  private load(slug: string): Trigger[] {
    const cached = this.plans.get(slug);
    if (cached) return cached;
    let triggers: Trigger[] = [];
    try {
      const parsed = JSON.parse(readFileSync(this.deps.file(slug), 'utf8')) as { triggers?: unknown };
      triggers = Array.isArray(parsed.triggers) ? (parsed.triggers as Trigger[]).filter((t) => t && typeof t.id === 'string') : [];
    } catch { /* no file yet — no triggers */ }
    this.plans.set(slug, triggers);
    return triggers;
  }

  private save(slug: string): void {
    const file = this.deps.file(slug);
    const plan = this.plans.get(slug) ?? [];
    // Ended triggers are history: the newest 100 are kept beside every armed one.
    const ended = plan.filter((t) => t.state !== 'armed').slice(-100);
    const kept = [...plan.filter((t) => t.state === 'armed'), ...ended];
    this.plans.set(slug, kept.length === plan.length ? plan : kept);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, triggers: this.plans.get(slug) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    this.deps.emit?.(slug);
  }
}
