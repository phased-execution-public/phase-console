/**
 * A typed doorway onto `shared/console-model.js`.
 *
 * The model itself is **unchanged and stays unchanged**: three pure functions and
 * two tables, imported unmodified by `node --test` and by Vite alike. It is the
 * part with the subtle behaviour — folding streamed fragments into one line,
 * keeping two subagents' sentences apart, replacing partials with the finished
 * block — so it is the part that must not be reimplemented in TypeScript for the
 * pleasure of having types.
 *
 * What this file adds is the boundary. `shared/` is plain JS with JSDoc, so
 * everything crossing into the client arrives as `any`; declaring the shapes
 * once here means the run view is type-checked against them and a change to the
 * model shows up as a compile error in one place rather than as `undefined` on a
 * screen.
 *
 * ## The identity contract
 *
 * `activity()` **returns the state it was given** when an event changes nothing —
 * and roughly nine in ten stream events change nothing (every text delta, every
 * thinking fragment). That is not an optimisation detail, it is the interface:
 * held in `useState`, the same reference means React bails out of the re-render
 * entirely. Copying the result "to be safe" (`{...activity(…)}`) would turn a
 * chatty phase into hundreds of re-renders a second of three panels that did not
 * change. `record()` below relies on it; so does `hydrate()`, which compares
 * against `NO_ACTIVITY` by reference to decide whether a replay produced
 * anything at all.
 */

import type { PhaseTask } from '@/lib/api';
import {
  MAX_LINES as SHARED_MAX_LINES,
  KIND_LABEL as SHARED_KIND_LABEL,
  QUIET as SHARED_QUIET,
  NO_ACTIVITY as SHARED_NO_ACTIVITY,
  toLine as sharedToLine,
  fold as sharedFold,
  activity as sharedActivity,
} from '@shared/console-model.js';

/** One line of the console, after folding. */
export interface ConsoleLine {
  id: number;
  kind: string;
  text: string;
  at: number;
  /** Streaming: the next fragment of the same kind joins this line. */
  partial?: boolean;
  /** A finished block replaces the fragments of this kind it was streamed as. */
  supersedes?: string;
  /** The `Agent` call an subagent fragment belongs to — what keeps two lanes apart. */
  parent?: string;
  tool?: string;
  /** An operator message: emitted undelivered, then again when the CLI echoes it. */
  mark?: string;
  delivered?: boolean;
  /** Came from the transcript rather than the live stream. */
  replayed?: boolean;
}

/**
 * One row of the task list.
 *
 * An alias, not a second declaration: `PhaseTask` is what the run record ships
 * and this is what the panel folds, and they must be the same shape for the
 * panel to be seeded from the record at all. Two structurally-identical
 * interfaces would be two things to keep in step.
 */
export type Todo = PhaseTask;

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  agent?: string;
  parent?: string;
  at: number;
  /** `null` while it is still running — a state the panel renders, not a missing field. */
  ms: number | null;
  ok: boolean | null;
  detail: string;
}

export interface AgentLane {
  id: string;
  agent: string;
  title: string;
  text: string;
  at: number;
  done: boolean;
}

/**
 * One §Verification command on the live checklist.
 *
 * `index` is the runner's own, which is what pairs a start with its result —
 * two identical commands in one bullet are two rows, and matching on the text
 * would have folded them into one.
 */
export interface VerifyRow {
  index: number;
  total: number;
  command: string;
  state: 'running' | 'passed' | 'failed' | 'skipped' | 'unknown';
  at: number;
  ms?: number;
  code?: number;
  /** The second attempt of a command whose first exited red — the verdict's. */
  retry?: boolean;
  /** A tail of output, on failure only. */
  tail?: string;
  /** Why it was not run — a skipped command's missing lead. */
  reason?: string;
}

export interface VerifyState {
  commands: VerifyRow[];
  /** Commands whose lead is not installed here — decided before anything runs. */
  skipped: { command: string; lead: string; reason: string }[];
  /** The verdict, once it lands. Null while the checklist is still filling. */
  summary: { ok: boolean; reason: string; ran: number; notRun: number; skipped: number } | null;
  /** When the last verify event arrived. */
  at: number;
}

export interface Activity {
  todos: Todo[];
  todosAt: number;
  tools: ToolCall[];
  agents: AgentLane[];
  verify: VerifyState;
}

export const MAX_LINES: number = SHARED_MAX_LINES;
export const KIND_LABEL: Record<string, string> = SHARED_KIND_LABEL;
export const QUIET: Set<string> = SHARED_QUIET;
export const NO_ACTIVITY: Activity = SHARED_NO_ACTIVITY;

/** One server event → one console line, or null to ignore it. */
export const toLine = sharedToLine as (
  event: string,
  data: Record<string, unknown>,
) => Omit<ConsoleLine, 'id' | 'at'> | null;

/** Add one line to a window, folding streamed fragments into the line they belong to. */
export const fold = sharedFold as (
  lines: readonly ConsoleLine[],
  line: Omit<ConsoleLine, 'id' | 'at'> & Partial<ConsoleLine>,
  nextId: number,
  at?: number,
) => ConsoleLine[];

/** The same events read as state. Returns `state` itself when nothing changed. */
export const activity = sharedActivity as (
  state: Activity,
  event: string,
  data: Record<string, unknown>,
  at?: number,
) => Activity;
