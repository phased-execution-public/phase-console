/**
 * The verdict — what a check of a person's item comes back as (control-tower
 * phase 134, #211; §Architecture 19, the design spec §5).
 *
 * A submission (*I've done this — check*) is checked against the item's proof
 * and answered `passed`, `rejected` with exactly what to redo, or `needs-info`
 * with exactly what to send. The record is `{state, note, redo[], read[], at,
 * by, attempt}` and rides the ledger's move line — no second ledger: `proven`
 * on a pass, `returned` on the other two, and the item keeps every verdict it
 * was given, one per attempt.
 *
 * WHO may write one is the point of this file. A `probe` and the `checker`
 * spawned for THAT item write theirs in-process (`ServiceRecovery`); over HTTP
 * exactly one route writes one — `POST /api/human-steps/:id/override`, the
 * owner's *Accept anyway*, which the door table opens to the owner alone and
 * the hook's forge guard denies to a supervised session. `check` only ASKS for
 * a check. No agent marks its own item passed.
 */

import { redactSecrets } from '../../shared/human-step-model.js';
import { PROOF_TYPES, VERDICTS, VERDICT_BY } from '../../shared/turn-model.js';
import type { HumanStep } from '../human-steps.ts';

/** How a check came back. */
export type VerdictState = (typeof VERDICTS)[number];
/** Who wrote it — a probe, the checking session, or the owner. */
export type VerdictBy = (typeof VERDICT_BY)[number];

/** One verdict, as the ledger keeps it — every string redacted and bounded. */
export type StepVerdict = {
  state: VerdictState;
  /** What the check found, in a sentence or two. */
  note: string;
  /** Exactly what to redo (a rejection) or to send (needs-info) — empty on a pass. */
  redo: string[];
  /** What the check read to decide. */
  read: string[];
  at: string;
  by: VerdictBy;
  /** Which attempt it answers — the item's `attempts` when the check began. */
  attempt: number;
  /** The owner's *Accept anyway*, or an `attest` item's word: nothing read it. */
  unverified?: true;
};

/** The bounds a verdict is held to, whoever offered it. */
export const VERDICT_NOTE_MAX = 600;
export const VERDICT_LIST_MAX = 8;
export const VERDICT_ITEM_MAX = 300;

/** One line of words: control characters folded, secrets redacted, bounded. */
function words(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return redactSecrets(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);
}

/** A list of lines, each shaped like `words`, empties dropped, bounded. */
function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => words(item, VERDICT_ITEM_MAX)).filter(Boolean).slice(0, VERDICT_LIST_MAX);
}

/**
 * A verdict from what a writer offered — or null when it is none: a state the
 * vocabulary lacks, or a rejection that says nothing to redo (a "no" with no
 * "what instead" is a complaint, never a verdict a person can act on).
 */
export function shapeVerdict(
  raw: unknown, meta: { by: VerdictBy; attempt: number; at: string; unverified?: boolean },
): StepVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const offered = raw as Record<string, unknown>;
  const state = typeof offered.state === 'string' ? offered.state.trim().toLowerCase() : '';
  if (!(VERDICTS as readonly string[]).includes(state)) return null;
  if (!(VERDICT_BY as readonly string[]).includes(meta.by)) return null;
  const note = words(offered.note, VERDICT_NOTE_MAX);
  const redo = lines(offered.redo);
  const read = lines(offered.read);
  if (state !== 'passed' && !redo.length && !note) return null;
  return {
    state: state as VerdictState,
    note: note || (state === 'passed' ? 'The proof holds.' : redo[0]!),
    redo: state === 'passed' ? [] : redo.length ? redo : [note],
    read,
    at: meta.at,
    by: meta.by,
    attempt: Math.max(0, Math.trunc(meta.attempt)),
    ...(meta.unverified ? { unverified: true as const } : {}),
  };
}

/**
 * The checking session's verdict: the LAST fenced ```verdict block of what it
 * wrote, parsed — never guessed (the reviewer's discipline, `reviewer.ts`). A
 * session that ends with none, or with one that does not parse, produces NO
 * verdict: the item says the check could not run, and nothing is fabricated in
 * either direction — a pass nobody read, or a rejection a parser invented.
 */
export function parseCheckerVerdict(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // The fence opens a LINE: a block quoted inside framed data (every line of it
  // prefixed `│ `) is never taken for the session's own verdict.
  const blocks = [...text.matchAll(/^```verdict[ \t]*\r?\n([\s\S]*?)^```/gm)];
  const last = blocks.at(-1);
  if (!last) return null;
  try {
    const parsed = JSON.parse(last[1]!.trim()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How an item is checked NOW — one of the proof types, judgement read as attest when it is switched off. */
export type CheckRoute = (typeof PROOF_TYPES)[number];

/**
 * The route a check takes, by the item's proof type (TV-4..7): a `probe` reads
 * a ref — a watch scheme, or `credential:<id>` (presence by name; a
 * `secret-entry` item derives one); an `answer` passes on a valid answer; an
 * `attest` passes only through the owner door, unverified; a `judgement` runs
 * the checker — and with `checkJudgement` off falls back to `attest`.
 */
export function checkRouteOf(
  step: Pick<HumanStep, 'proofType' | 'proof' | 'kind'>, opts: { judgement: boolean; ref?: string | null },
): CheckRoute {
  if (opts.ref) return 'probe';
  switch (step.proofType) {
    case 'answer': return 'answer';
    case 'grant': return 'grant';
    case 'judgement': return opts.judgement ? 'judgement' : 'attest';
    case 'probe': return 'probe';
    default: return 'attest';
  }
}

/** The verdicts of one item, oldest first — the escalation's attempts side by side. */
export function verdictsOf(step: Pick<HumanStep, 'verdicts'>): StepVerdict[] {
  return [...(step.verdicts ?? [])];
}

/** How many of an item's checks came back rejected. */
export function rejectionsOf(step: Pick<HumanStep, 'verdicts'>): number {
  return (step.verdicts ?? []).filter((verdict) => verdict.state === 'rejected').length;
}

/**
 * What a verdict tells a person, once: "Back to you — <note> Redo: …" — the
 * returned item's line on the card and its push. Never a value: every field was
 * redacted when the verdict was shaped.
 */
export function returnedSentence(verdict: StepVerdict): string {
  const ask = verdict.state === 'needs-info' ? 'Send' : 'Redo';
  const list = verdict.redo.length ? ` ${ask}: ${verdict.redo.join('; ')}.` : '';
  return `${verdict.state === 'needs-info' ? 'Needs more from you' : 'Back to you'} (attempt ${verdict.attempt}): `
    + `${verdict.note.replace(/[.\s]+$/, '')}.${list}`;
}
