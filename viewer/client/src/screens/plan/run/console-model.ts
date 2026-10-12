/**
 * The session console's model, typed — a doorway onto `shared/console-model.js`
 * (7.0, quiet-console phase 12).
 *
 * The model is not rewritten here. Three pure functions and their tables, imported
 * unmodified by `node --test` and by Vite alike, hold the behaviour that is easy
 * to get wrong — streamed fragments folded into one line, two subagents' sentences
 * kept apart, the partials replaced by the finished block — so a replayed run and
 * a watched one cannot read differently. `shared/` is plain JS: what crosses into
 * the client arrives untyped, so the shapes are declared once, here, and a change
 * to the model is a compile error in one place rather than `undefined` on a screen.
 *
 * The identity contract: `foldActivity` returns the state it was GIVEN when an
 * event changes nothing — nine stream events in ten (every text delta, every
 * thinking fragment). Held in `useState`, that reference is what makes React skip
 * the render; copying the result "to be safe" re-renders three panels per token.
 */

import { KIND_LABEL, MAX_LINES, NO_ACTIVITY, QUIET, activity, fold, toLine } from '@shared/console-model.js';
import type { PhaseTask } from '@/data/api';

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
  /** The `Agent` call a subagent fragment belongs to — what keeps two agents apart. */
  parent?: string;
  tool?: string;
  /** An operator message: emitted undelivered, then again when the CLI echoes it. */
  mark?: string;
  delivered?: boolean;
  /** Came from the replay rather than the live stream. */
  replayed?: boolean;
}

/**
 * One row of the session's task list — the record's own shape, aliased rather
 * than declared again: the panel is SEEDED from `PhaseRecord.tasks`, which only
 * works while the two are one type.
 */
export type SessionTodo = PhaseTask;

export interface SessionToolCall {
  id: string;
  name: string;
  summary: string;
  agent?: string;
  parent?: string;
  at: number;
  /** `null` while it is still running — a state the panel draws, not a missing field. */
  ms: number | null;
  ok: boolean | null;
  detail: string;
}

export interface SessionAgentLane {
  id: string;
  agent: string;
  title: string;
  text: string;
  at: number;
  done: boolean;
}

/**
 * One §Verification command on the live checklist. `index` is the runner's own,
 * which is what pairs a start with its result: two identical commands are two rows.
 */
export interface VerifyCommandRow {
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

export interface SessionVerify {
  commands: VerifyCommandRow[];
  /** Commands whose lead is not installed here — decided before anything runs. */
  skipped: { command: string; lead: string; reason: string }[];
  /** The verdict, once it lands; null while the checklist is still filling. */
  summary: { ok: boolean; reason: string; ran: number; notRun: number; skipped: number } | null;
  /** When the last verify event arrived. */
  at: number;
}

/** What a session is doing, as state: its task list, its tool calls, its subagents, its checklist. */
export interface SessionActivity {
  todos: SessionTodo[];
  /** When the session last rewrote the list — `0` when nothing says. */
  todosAt: number;
  tools: SessionToolCall[];
  agents: SessionAgentLane[];
  verify: SessionVerify;
}

/** The lines a pane holds; older ones fall off the top. */
export const CONSOLE_MAX_LINES: number = MAX_LINES;
/** A line kind's word, as the console prints it beside the line. */
export const LINE_KIND_LABEL: Readonly<Record<string, string>> = KIND_LABEL;
/** The kinds behind Detail — the model's working and the hook calls. */
export const QUIET_KINDS: ReadonlySet<string> = QUIET;
export const NO_SESSION_ACTIVITY: SessionActivity = NO_ACTIVITY;

/** One server event → one console line, or null to ignore it. */
export const toConsoleLine = toLine as (
  event: string,
  data: Record<string, unknown>,
) => Omit<ConsoleLine, 'id' | 'at'> | null;

/** Add one line to a window, folding streamed fragments into the line they belong to. */
export const foldLine = fold as (
  lines: readonly ConsoleLine[],
  line: Omit<ConsoleLine, 'id' | 'at'> & Partial<ConsoleLine>,
  nextId: number,
  at?: number,
) => ConsoleLine[];

/** The same events read as state. Returns `state` itself when nothing changed. */
export const foldActivity = activity as (
  state: SessionActivity,
  event: string,
  data: Record<string, unknown>,
  at?: number,
) => SessionActivity;
