/**
 * Why a plan's status says what it says — the reasons behind the word on its
 * row, in words a person can act on (the Plans page's status button and its
 * drawer, the panel).
 *
 * A status word is a summary: "Needs you", "Running", "Waiting", "Halted",
 * "Complete". Each is answered here by the concrete things behind it, worst
 * first and each with where to act: the items of Your turn the plan holds and
 * a gate a person approves; the run's stop (drawn by the halt card, the one
 * renderer of why a run stopped — `cards/halt-single-source.test.ts`), the
 * board's stuck phases and QA's verdicts; the phases a session is on now; what
 * the run and the phases wait on — a wait's clock, the queue's line, another
 * session's claim, a dependency, a gate that clears itself; what can start
 * next; and for a plan that is over, how it ended.
 *
 * Nothing here decides a status — that is the status model's
 * (`describeRun`, read on the row) and the board's. It reads what the page
 * already holds — the `/api/plans` row, the newest run (slim or whole), the
 * inbox — plus, when the drawer has them, the plan's detail (each phase's
 * dependencies, gate and title) and the queue. Pure, with the clock a
 * parameter, so a test states the moment and the words.
 *
 * The same reasons feed the list's columns (`liveNowOf`, `waitsOnOf`), so a
 * row and its drawer cannot disagree about what a plan is doing or waits on.
 */

import {
  HALT_CATEGORY_LABELS,
  categoryOfSituation,
  haltSentence,
  holderViews,
} from '@shared/halt-categories.js';
import { countsTowardAttention } from '@shared/attention-model.js';
import { runLifecycle } from '@shared/run-lifecycle.js';
import { describeWord, waitNote, waitSentence } from '@shared/status-model.js';
import type { InboxItem, PlanDetail, PhaseView, QueueViewEntry, RunState } from '@/data/api';
import { asRunLike, lanesOf, type RunLike } from '@/data/lanes';
import { runStopOf } from '@/data/run-stop';
import { itemIdOf, itemsNow } from '@/data/turn';
import { waitingLabel } from '@/data/queue-words';
import { CLOSED_HELP, type ClosedStatus } from '@/lib/closure';
import { money, plural } from '@/lib/format';
import { plainText } from '@/lib/plain-text';
import { phaseHref, planHref, planViewHref, runHref, turnHref } from '@/shell/routes';
import { kindWord, markKind, markLabel, type PlanRow } from './model';

/* ------------------------------------------------------------------ *
 * The account
 * ------------------------------------------------------------------ */

/** The drawer's sections, in the order a person acts on them. */
export type WhyKey = 'you' | 'stop' | 'live' | 'waits' | 'next' | 'ended' | 'about';

/** One reason: a sentence, the server's own words beside it, and where to act. */
export interface PlanReason {
  key: string;
  /** The sentence a person reads. */
  text: string;
  /** A second, quieter line — the server's or the plan's own words. */
  detail?: string;
  phase?: number;
  href?: string;
  /** The link's words: what pressing it does. */
  act?: string;
  /** A clock the reason carries, ISO. */
  at?: string;
  /** Whether `at` is when it began, or when it ends. */
  clock?: 'since' | 'until';
  /** What the clock says happened or will happen then — "asked", "resumes". */
  verb?: string;
  /** The Your turn row this reason is — drawn with the card's own words. */
  item?: InboxItem;
  /** A lane's word, drawn through the family. */
  lane?: string;
}

export interface PlanWhySection {
  key: WhyKey;
  title: string;
  reasons: PlanReason[];
}

/** Everything the drawer says about one plan's status. */
export interface PlanWhy {
  /** The word the row's status leads with — what is being explained. */
  word: string;
  /** One sentence answering "why does it say that?". */
  headline: string;
  /**
   * The run's stop, when it has one and is not live — handed whole to the halt
   * card, which says its family, its sentence and the one recovery it
   * recommends. Never re-said here.
   */
  stop: { run: RunState } | null;
  sections: PlanWhySection[];
}

export interface WhyInput {
  row: PlanRow;
  /** The plan's detail, once the drawer has read it — each phase's dependencies, gate and title. */
  detail?: Pick<PlanDetail, 'phases' | 'locks'> | null | undefined;
  /** The queue's entries, once read — a phase's place in line and what it waits on. */
  queue?: readonly QueueViewEntry[] | null | undefined;
  now: number;
}

const SECTION_TITLE: Readonly<Record<WhyKey, string>> = {
  you: 'What needs you',
  stop: 'What stopped it',
  live: 'Running now',
  waits: 'What it waits on',
  next: 'What can start next',
  ended: 'How it ended',
  about: 'What this is',
};

/** How many dependency lines a section lists before it counts the rest. */
const CHAIN_SHOWN = 5;

/* ------------------------------------------------------------------ *
 * The run, read once
 * ------------------------------------------------------------------ */

/** The newest run as the reasons read it — whole when the drawer holds the record. */
interface RunReading {
  /** The row's own run, slim or whole — what the lane folds read. */
  record: RunLike;
  /** The same run with its phase words as records — what the stop and wait readers take. */
  run: RunState;
  /** A loop is behind it: a session or a check is working. */
  live: boolean;
  /** It is over, or something overtook it — its stop is history. */
  settled: boolean;
  lifeState: string;
  waitKind: string | null;
}

function readRun(row: PlanRow): RunReading | null {
  const view = row.run?.view;
  const record = row.run?.record;
  if (!view || !record || row.isClosed) return null;
  const run = asRunLike(record) as RunState;
  const life = runLifecycle(run as Parameters<typeof runLifecycle>[0]) as {
    state: string;
    wait?: { kind?: string };
  };
  return {
    record,
    run,
    live: view.tense === 'live',
    settled: view.tense === 'settled',
    lifeState: life.state,
    waitKind: life.wait?.kind ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Shared with the list's columns
 * ------------------------------------------------------------------ */

/** One phase a session or a console check is on right now. */
export interface LiveLane {
  phase: number;
  /** The lane's word — `running`, `verifying`, … (`LANE_STATUSES`). */
  status: string;
  startedAt?: string;
}

/**
 * The phases being worked on NOW — a lane with a live session or one of the
 * console's checks behind it. A lane parked, gated or queued is no work being
 * done; it is a wait, and the drawer says what it waits on.
 */
export function liveNowOf(row: PlanRow): LiveLane[] {
  const record = row.run?.record;
  if (!record || row.isClosed) return [];
  return lanesOf([record])
    .filter((lane) => lane.child || lane.check)
    .sort((a, b) => a.phase - b.phase)
    .map((lane) => ({
      phase: lane.phase,
      status: lane.status,
      ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
    }));
}

/** What a plan waits on, in a few words for its row, and the server's words beside them. */
export interface WaitsOn {
  lead: string;
  detail?: string;
  phase?: number;
}

/**
 * The ONE thing a plan's row says it waits on, in the order the drawer says
 * them: a person, then the run's own wait and its clock, then what stopped
 * the run, then a stuck phase, then a gate nobody is checking. Nothing when it
 * waits on nothing — a plan that is moving, or one that is over.
 */
export function waitsOnOf(row: PlanRow, now: number = Date.now()): WaitsOn | null {
  if (!row.isPlan || row.isClosed) return null;
  const asked = itemsNow(row.inbox)[0];
  if (asked) {
    return {
      lead: asked.phase != null ? `You, on phase ${asked.phase}` : 'You',
      detail: asked.title,
      ...(asked.phase != null ? { phase: asked.phase } : {}),
    };
  }
  const reading = readRun(row);
  if (reading && !reading.settled && reading.lifeState === 'waiting') {
    const note = waitNote(reading.run as Parameters<typeof waitNote>[0], now);
    if (note) return { lead: sentenceCase(note.replace(/^on /, '')) };
  }
  const stop = reading && !reading.live && !reading.settled ? runStopOf(reading.run, false) : null;
  if (stop) {
    const holder = holderViews(stop.holders)[0];
    if (holder) return { lead: holderLead(holder), detail: holder.why, phase: holder.phase };
    // The plan waits on its stopped run; the card's own sentence says why.
    const sentence = haltSentence(stop);
    return {
      lead: 'Its stopped run',
      ...(sentence ? { detail: sentence } : {}),
      ...(stop.phase != null ? { phase: stop.phase } : {}),
    };
  }
  if (row.stuck.length) {
    return { lead: `Phase ${row.stuck[0]} is stuck`, phase: row.stuck[0]! };
  }
  const gated = row.gated ?? [];
  if (gated.length && !liveNowOf(row).length) {
    return {
      lead: gated.length === 1 ? `The gate on phase ${gated[0]}` : `The gates on phases ${listed(gated)}`,
      phase: gated[0]!,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The reasons
 * ------------------------------------------------------------------ */

const sentenceCase = (text: string): string => (text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text);

/** A label's first letter in lower case — never an initialism's: "QA verdict" stays as it is. */
const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;

/** What holds a stopped run, as a row says it: whose it is, and on which phase. */
function holderLead(holder: { phase: number; kind: string; label: string; automatic: boolean }): string {
  if (holder.kind === 'errand') return `You, on phase ${holder.phase}`;
  if (holder.kind === 'retry') return `Phase ${holder.phase}, stopped`;
  return `Phase ${holder.phase}’s ${holder.automatic ? 'gate' : lowerFirst(holder.label)}`;
}

/** "1, 2 and 3". */
function listed(phases: readonly number[]): string {
  if (phases.length <= 1) return phases.join('');
  return `${phases.slice(0, -1).join(', ')} and ${phases[phases.length - 1]}`;
}

/** A phase's name for a sentence: its number, and its title when the detail is read. */
const named = (phase: number, titles: ReadonlyMap<number, string>): string =>
  titles.get(phase) ? `Phase ${phase}, ${titles.get(phase)}` : `Phase ${phase}`;

/** A plan's own lock is its run's: `autopilot/<runId>`. */
const ownLock = (owner: string, runId: string | undefined): boolean =>
  Boolean(runId) && owner.endsWith(`/${runId}`);

/** The first line of a gate's written conditions, cut to a line. */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** What each gate kind means for who clears it. */
function gateWords(kind: string | undefined): string {
  if (kind === 'human') return 'which you approve before it starts';
  if (kind === 'ai') return 'which a session checks before it starts';
  if (kind === 'auto') return 'which the console checks by itself';
  return 'which must clear before it starts';
}

/** A dependency's reason in words: not done yet, or its QA verdict. */
function blockerWords(blocker: { phase: number; why: string }, states: ReadonlyMap<number, string>): string {
  if (blocker.why.startsWith('qa:')) {
    const verdict = blocker.why.slice(3);
    return `phase ${blocker.phase} (${verdict === 'fail' ? 'its QA failed' : `its QA reads ${verdict}`})`;
  }
  const state = states.get(blocker.phase);
  const word = state ? describeWord('board', state) : null;
  return word?.known ? `phase ${blocker.phase} (${word.label.toLowerCase()})` : `phase ${blocker.phase}`;
}

function youReasons(row: PlanRow, phases: readonly PhaseView[], holdersShown: boolean): PlanReason[] {
  const out: PlanReason[] = [];
  const now = itemsNow(row.inbox);
  for (const item of now) {
    out.push({
      key: `item:${itemIdOf(item)}`,
      text: item.title,
      ...(item.need && item.need !== item.title ? { detail: item.need } : {}),
      ...(item.phase != null ? { phase: item.phase } : {}),
      href: turnHref(itemIdOf(item)),
      act: 'Open it on Your turn',
      ...(item.since ? { at: item.since, clock: 'since' as const, verb: 'asked' } : {}),
      item,
    });
  }
  // A gate only a person opens, on a phase nothing else holds back — when no
  // item of Your turn already asks for it and the halt card does not list it.
  if (!holdersShown) {
    const asked = new Set(now.map((item) => item.phase));
    for (const phase of phases) {
      if (!phase.gated || phase.gateKind !== 'human' || phase.state !== 'ready' || asked.has(phase.phase))
        continue;
      out.push({
        key: `gate:${phase.phase}`,
        text: `Phase ${phase.phase} is ready, and its gate waits for your approval.`,
        ...(firstLine(phase.gates) ? { detail: firstLine(phase.gates)! } : {}),
        phase: phase.phase,
        href: phaseHref(row.slug, phase.phase),
        act: `Open phase ${phase.phase}`,
      });
    }
  }
  // Something else that asks for a person and is no item of Your turn: a
  // health warning, a lock somebody must release.
  for (const item of row.inbox) {
    if (item.turn || item.severity === 'fyi') continue;
    out.push({
      key: `row:${item.id}`,
      text: item.title,
      ...(item.need && item.need !== item.title ? { detail: item.need } : {}),
      ...(item.phase != null ? { phase: item.phase } : {}),
      ...(item.since ? { at: item.since, clock: 'since' as const, verb: 'raised' } : {}),
    });
  }
  const later = row.turn.open - now.length;
  if (later > 0) {
    out.push({
      key: 'later',
      text: `${plural(later, now.length ? 'more item' : 'item')} of this plan ${later === 1 ? 'is' : 'are'} coming up or being checked on Your turn.`,
      href: planHref(row.slug, 'turn'),
      act: 'Open its Your turn',
    });
  }
  return out;
}

function stopReasons(row: PlanRow, titles: ReadonlyMap<number, string>): PlanReason[] {
  const out: PlanReason[] = [];
  if (row.errors > 0) {
    out.push({
      key: 'error',
      text: 'The console could not read the plan cleanly, so what it says about it may be wrong.',
      ...(row.firstIssue ? { detail: row.firstIssue } : {}),
      href: planHref(row.slug, 'source'),
      act: 'Open its source',
    });
  }
  for (const phase of row.stuck) {
    out.push({
      key: `stuck:${phase}`,
      text: `${named(phase, titles)} is stuck: its handoff reads blocked or in progress, and nobody is working on it.`,
      phase,
      href: phaseHref(row.slug, phase),
      act: `Open phase ${phase}`,
    });
  }
  if (row.qaFailures.length) {
    out.push({
      key: 'qa',
      text: `QA failed at ${row.qaFailures.length === 1 ? 'phase' : 'phases'} ${listed(row.qaFailures)}, and what depends on ${row.qaFailures.length === 1 ? 'it' : 'them'} waits until it passes.`,
      href: planViewHref(row.slug, 'handoffs'),
      act: 'Open the QA verdicts',
    });
  }
  return out;
}

function liveReasons(row: PlanRow, titles: ReadonlyMap<number, string>): PlanReason[] {
  return liveNowOf(row).map((lane) => ({
    key: `live:${lane.phase}`,
    text: named(lane.phase, titles),
    phase: lane.phase,
    lane: lane.status,
    href: phaseHref(row.slug, lane.phase),
    act: `Open phase ${lane.phase}`,
    ...(lane.startedAt ? { at: lane.startedAt, clock: 'since' as const, verb: 'started' } : {}),
  }));
}

function waitReasons(
  row: PlanRow,
  reading: RunReading | null,
  detail: WhyInput['detail'],
  queue: WhyInput['queue'],
  holders: ReadonlySet<number>,
  titles: ReadonlyMap<number, string>,
  now: number,
): PlanReason[] {
  const out: PlanReason[] = [];
  const phases = detail?.phases ?? [];
  const asked = new Set(itemsNow(row.inbox).map((item) => item.phase));

  // The run's own wait, with its clock — a usage window, work outside, the
  // schedule, the network. A wait on a person is the first section's.
  if (reading && !reading.settled && reading.lifeState === 'waiting' && reading.waitKind !== 'person') {
    const sentence = waitSentence(reading.run as Parameters<typeof waitSentence>[0], now);
    if (sentence) {
      out.push({
        key: 'run-wait',
        text: `Its run is ${sentence[0]!.toLowerCase()}${sentence.slice(1)}.`,
        ...(reading.run.waitUntil
          ? {
              at: reading.run.waitUntil,
              clock: 'until' as const,
              verb: reading.waitKind === 'usage-limit' ? 'resets' : 'resumes',
            }
          : {}),
        href: runHref(row.slug),
        act: 'Open its run',
      });
    }
  }

  // A lane the run holds that is not working — parked, gated, queued — and
  // that no item of Your turn already explains.
  if (reading && !reading.settled) {
    const live = new Set(liveNowOf(row).map((lane) => lane.phase));
    for (const lane of lanesOf([reading.record])) {
      if (live.has(lane.phase) || asked.has(lane.phase) || holders.has(lane.phase)) continue;
      const key = (
        reading.run.phases?.[String(lane.phase)] as { situation?: { key?: string } | null } | undefined
      )?.situation?.key;
      const family = categoryOfSituation(key ?? null);
      const word = describeWord('phase', lane.status);
      out.push({
        key: `lane:${lane.phase}`,
        text: `${named(lane.phase, titles)} is ${word.known ? word.label.toLowerCase() : lane.status} in its run.`,
        ...(family ? { detail: HALT_CATEGORY_LABELS[family] } : {}),
        phase: lane.phase,
        lane: lane.status,
        href: phaseHref(row.slug, lane.phase),
        act: `Open phase ${lane.phase}`,
      });
    }
  }

  // Its place in the admission queue — what holds it and how long it has waited.
  for (const entry of queue ?? []) {
    if (entry.slug !== row.slug) continue;
    out.push({
      key: `queue:${entry.id}`,
      text: `${entry.phase != null ? named(entry.phase, titles) : 'Its run'} is queued${entry.position ? `, number ${entry.position} in line` : ''}.`,
      detail: entry.waits || waitingLabel(entry),
      ...(entry.phase != null
        ? { phase: entry.phase, href: phaseHref(row.slug, entry.phase), act: `Open phase ${entry.phase}` }
        : { href: runHref(row.slug), act: 'Open its run' }),
      ...(entry.clocks?.since ? { at: entry.clocks.since, clock: 'since' as const, verb: 'queued' } : {}),
    });
  }

  // A claim somebody else holds — a session by hand, another console.
  for (const lock of detail?.locks ?? []) {
    if (ownLock(lock.owner, row.run?.id)) continue;
    out.push({
      key: `lock:${lock.phase ?? 'plan'}:${lock.owner}`,
      text: lock.expired
        ? `${lock.phase != null ? named(lock.phase, titles) : 'The plan'} still carries a lapsed claim by ${lock.owner}.`
        : `${lock.phase != null ? named(lock.phase, titles) : 'The plan'} is claimed by ${lock.owner}.`,
      ...(lock.phase != null
        ? { phase: lock.phase, href: phaseHref(row.slug, lock.phase), act: `Open phase ${lock.phase}` }
        : {}),
      ...(!lock.expired && lock.leaseUntil
        ? { at: new Date(lock.leaseUntil).toISOString(), clock: 'until' as const, verb: 'its lease ends' }
        : {}),
    });
  }

  // The phases in progress on the board that nothing of this console is on.
  const lanes = new Set(reading ? lanesOf([reading.record]).map((lane) => lane.phase) : []);
  for (const phase of row.inProgress) {
    if (lanes.has(phase) || asked.has(phase)) continue;
    out.push({
      key: `board:${phase}`,
      text: `${named(phase, titles)} reads in progress on the board, and no session of this console is on it.`,
      phase,
      href: phaseHref(row.slug, phase),
      act: `Open phase ${phase}`,
    });
  }

  // A gate that clears itself, on a phase that could otherwise start.
  for (const phase of phases) {
    if (!phase.gated || phase.gateKind === 'human' || phase.state !== 'ready' || holders.has(phase.phase))
      continue;
    out.push({
      key: `gate:${phase.phase}`,
      text: `${named(phase.phase, titles)} has a gate, ${gateWords(phase.gateKind)}.`,
      ...(firstLine(phase.gateCheck ?? phase.gates)
        ? { detail: firstLine(phase.gateCheck ?? phase.gates)! }
        : {}),
      phase: phase.phase,
      href: phaseHref(row.slug, phase.phase),
      act: `Open phase ${phase.phase}`,
    });
  }

  // The dependencies — the front of the chain only: a phase that waits on
  // something that is itself moving or held, never one waiting on a waiter.
  const states = new Map(phases.map((p) => [p.phase, p.state]));
  const waiting = phases.filter((p) => p.state === 'waiting' && p.blockedBy?.length);
  const front = waiting.filter((p) => p.blockedBy!.some((b) => states.get(b.phase) !== 'waiting'));
  for (const phase of front.slice(0, CHAIN_SHOWN)) {
    // What it waits on that is itself moving or held is named; what waits too is counted.
    const moving = phase.blockedBy!.filter((b) => states.get(b.phase) !== 'waiting');
    const alsoWaiting = phase.blockedBy!.length - moving.length;
    const on = moving.slice(0, 3).map((b) => blockerWords(b, states));
    if (moving.length > 3) on.push(plural(moving.length - 3, 'more phase'));
    if (alsoWaiting)
      on.push(`${plural(alsoWaiting, 'phase')} that ${alsoWaiting === 1 ? 'waits' : 'wait'} too`);
    out.push({
      key: `dep:${phase.phase}`,
      text: `${named(phase.phase, titles)} waits on ${on.length > 1 ? `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}` : on[0]}.`,
      phase: phase.phase,
      href: phaseHref(row.slug, phase.phase),
      act: `Open phase ${phase.phase}`,
    });
  }
  const behind = waiting.length - Math.min(front.length, CHAIN_SHOWN);
  if (behind > 0) {
    out.push({
      key: 'chain',
      text: `${plural(behind, 'more phase')} ${behind === 1 ? 'waits' : 'wait'} further down the chain.`,
      href: planHref(row.slug, 'phases'),
      act: 'Open its phases',
    });
  } else if (!phases.length && row.waiting > 0 && !row.readyPhases.length && !row.inProgress.length) {
    // Without the detail, the count is what is known.
    out.push({
      key: 'waiting',
      text: `${plural(row.waiting, 'phase')} ${row.waiting === 1 ? 'waits' : 'wait'} on earlier phases that are not done.`,
      href: planHref(row.slug, 'phases'),
      act: 'Open its phases',
    });
  }
  return out;
}

function nextReasons(
  row: PlanRow,
  reading: RunReading | null,
  titles: ReadonlyMap<number, string>,
  gated: ReadonlySet<number>,
): PlanReason[] {
  if (row.isClosed || !row.readyPhases.length) return [];
  const out: PlanReason[] = row.readyPhases.map((phase) => ({
    key: `ready:${phase}`,
    text: `${named(phase, titles)} can start now${gated.has(phase) ? ', once its gate clears' : ''}.`,
    phase,
    href: phaseHref(row.slug, phase),
    act: `Open phase ${phase}`,
  }));
  if (!reading || reading.settled || (!reading.live && reading.lifeState !== 'waiting')) {
    out.push({
      key: 'start',
      text: reading
        ? 'Its run is not moving, so nothing starts these by itself.'
        : 'No run is driving this plan, so nothing starts these by itself.',
      href: runHref(row.slug),
      act: 'Open its Run view',
    });
  }
  return out;
}

function endedReasons(row: PlanRow): PlanReason[] {
  const out: PlanReason[] = [];
  if (row.closedReason) out.push({ key: 'reason', text: row.closedReason });
  if (row.closedOn) out.push({ key: 'closed-on', text: `Closed on ${row.closedOn}.` });
  if (row.phases) {
    const never = Math.max(0, row.phases - row.done);
    out.push({
      key: 'done',
      text: never
        ? `${row.done} of ${plural(row.phases, 'phase')} done; ${plural(never, 'phase')} never ran.`
        : `All ${plural(row.phases, 'phase')} done.`,
    });
  }
  const last = row.summary?.lastCompleted;
  if (last) out.push({ key: 'last', text: `Its last phase was finished on ${last}.` });
  const run = row.run;
  if (run) {
    out.push({
      key: 'run',
      text:
        run.status === 'finished'
          ? 'Its last run finished.'
          : row.isClosed
            ? `Its last run was left ${run.view.label.toLowerCase()} when the plan was closed.`
            : `Its last run reads ${run.view.label.toLowerCase()}.`,
      href: runHref(row.slug),
      act: 'Open its run',
    });
  }
  if (row.spend.runs > 0) {
    out.push({
      key: 'spent',
      text: `${row.spend.runs === 1 ? 'Its run' : `Its ${row.spend.runs} runs`} spent ${money(row.spend.usd)}.`,
    });
  }
  if (!row.isClosed) {
    out.push({
      key: 'close',
      text: 'Every phase is done, and nobody has closed the plan yet.',
      href: planHref(row.slug),
      act: 'Open the plan to close it',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The headline
 * ------------------------------------------------------------------ */

function headlineOf(
  row: PlanRow,
  reading: RunReading | null,
  stop: RunState['halt'],
  live: readonly LiveLane[],
  at: number,
): string {
  if (!row.isPlan) {
    return row.kind === 'orphan-handoffs'
      ? 'These are handoffs with no plan file beside them, so nothing runs from them.'
      : `This is a ${kindWord(row).toLowerCase()}, not a plan: it has no phase table, so nothing runs from it.`;
  }
  if (row.isClosed) {
    return CLOSED_HELP[row.status as ClosedStatus] ?? `This plan is ${row.status}, so it asks for nothing.`;
  }
  const due = itemsNow(row.inbox);
  // What asks for a person: the items of Your turn first, else any row that
  // summons one (a health warning, a claim to release).
  const asked = due.length ? due : row.inbox.filter((item) => countsTowardAttention(item.severity));
  const kind = markKind(row);
  if (kind === 'attention' || (kind === 'run' && row.run?.view.attention !== 'none' && asked.length)) {
    if (asked.length === 1) return `It needs you: ${asked[0]!.title}.`;
    if (asked.length > 1)
      return `${plural(asked.length, 'thing')} wait on you. The oldest is “${asked[0]!.title}”.`;
  }
  if (reading && !reading.settled) {
    if (stop && !reading.live) return haltSentence(stop) ?? 'Its run stopped.';
    if (reading.lifeState === 'waiting') {
      const sentence = waitSentence(reading.run as Parameters<typeof waitSentence>[0], at);
      if (sentence) return `Its run is ${sentence[0]!.toLowerCase()}${sentence.slice(1)}.`;
    }
    if (live.length || reading.lifeState === 'running') {
      const working =
        live.length === 1
          ? `Its run is working: phase ${live[0]!.phase} is ${describeWord('phase', live[0]!.status).label.toLowerCase()}.`
          : live.length > 1
            ? `Its run is working on phases ${listed(live.map((lane) => lane.phase))}.`
            : 'Its run is live, between phases.';
      // A person's turn on a working run is why its word wears the summons.
      const open = row.turn.open;
      if (row.run?.view.attention !== 'none' && open) {
        return `${working} ${open === 1 ? 'An item of yours is' : `${open} items of yours are`} open on Your turn.`;
      }
      return working;
    }
    const next = row.run?.view.next;
    if (next) return next;
  }
  if (row.isComplete) return 'Every phase is done, and the plan is still open.';
  const view = describeWord('plan', row.status);
  if (!view.known) {
    return `Its status line says “${row.status}”, which is not a word this console knows; the board below is still read.`;
  }
  if (row.status !== 'active') return view.meaning ?? `It is ${view.label.toLowerCase()}.`;
  if (row.stuck.length)
    return `Nothing is running it, and phase ${listed(row.stuck)} ${row.stuck.length === 1 ? 'is' : 'are'} stuck.`;
  if (row.readyPhases.length) {
    return `Nothing is running it, and ${plural(row.readyPhases.length, 'phase')} can start: ${listed(row.readyPhases)}.`;
  }
  if (row.waiting > 0) return 'Nothing is running it, and every phase left waits on another.';
  return view.meaning ?? 'It is active.';
}

/* ------------------------------------------------------------------ *
 * The whole account
 * ------------------------------------------------------------------ */

export function whyOf({ row, detail, queue, now }: WhyInput): PlanWhy {
  const word = markLabel(row);
  // Titles are markdown on disk; a sentence carries their words.
  const titles = new Map(
    (detail?.phases ?? [])
      .map((p) => [p.phase, p.title ? plainText(p.title) : ''] as const)
      .filter(([, title]) => title),
  );
  const reading = readRun(row);
  const stopHalt = reading && !reading.live && !reading.settled ? runStopOf(reading.run, false) : null;
  const holders = new Set(holderViews(stopHalt?.holders).map((holder) => holder.phase));
  const live = liveNowOf(row);
  const sections: PlanWhySection[] = [];
  const section = (key: WhyKey, reasons: PlanReason[]) => {
    if (reasons.length) sections.push({ key, title: SECTION_TITLE[key], reasons });
  };

  if (!row.isPlan) {
    section('about', [
      {
        key: 'files',
        text: 'Its file lives under docs/plans with the plans, and the console lists it so nothing there is hidden.',
        href: planHref(row.slug, 'source'),
        act: 'Open it',
      },
    ]);
  } else if (row.isClosed || row.isComplete) {
    section('ended', endedReasons(row));
  } else {
    section('you', youReasons(row, detail?.phases ?? [], holders.size > 0));
    section('stop', stopReasons(row, titles));
    section('live', liveReasons(row, titles));
    section('waits', waitReasons(row, reading, detail, queue, holders, titles, now));
    section('next', nextReasons(row, reading, titles, new Set(row.gated ?? [])));
  }

  return {
    word,
    headline: headlineOf(row, reading, stopHalt, live, now),
    stop:
      stopHalt && reading
        ? { run: stopHalt === reading.run.halt ? reading.run : { ...reading.run, halt: stopHalt } }
        : null,
    sections,
  };
}
