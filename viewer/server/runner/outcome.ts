/**
 * The session's declared outcome — the machine-readable record that replaces
 * guessing from prose.
 *
 * A session writes it with `scripts/phase-outcome.sh` to a path the runner
 * injects as `PE_OUTCOME_FILE`; the runner reads it once on session exit,
 * journals it, and deletes it. Born from a live run: a phase-8 session ended
 * its turn "waiting on the image build (34–65 min)" in free text, the runner
 * read the clean exit as completion, found no handoff, and halted. The file's
 * absence still means what it always meant — the session declared nothing —
 * so every legacy path is unchanged; the file's presence is new information.
 *
 * Staleness is guarded twice, independently: the runner deletes the path
 * before every spawn, and `readOutcome` rejects anything written before the
 * attempt started or naming a different slug/phase. A leftover file from a
 * crashed attempt must never speak for the next one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { runDir } from './state.ts';
import { OUTCOME_STATUSES } from '../../shared/run-lifecycle.js';
import type { OutcomeStatus } from '../../shared/run-lifecycle.js';

/**
 * `partial` — "work remains; resume me" — is the one a session declares when
 * it must stop before the exit criteria (its budget, its context) without
 * anything being WRONG: the runner reads it as situation `work-in-progress`
 * at once and the ladder's first rung continues the session, where the clean
 * exit used to read as a failed phase and buy a closeout that could not do
 * the work. `reason` conventionally names why: `budget`, `context`, `other`.
 */
/**
 * `no-defect` — "I looked, and there was nothing to fix" — belongs to the
 * REPAIR family rather than the phase-progress one. A repair session is sent to
 * mend a specific thing; when the thing has already mended itself (the board
 * moved, the lock expired, another session finished the work), the honest
 * answer is neither `complete` (it fixed nothing) nor a failure (nothing was
 * wrong). Without the word, nine of ten `plan-repair-agent` rungs settled
 * `failed` by construction — the rung was blamed for the absence of a defect.
 */
export type PhaseOutcomeStatus = OutcomeStatus;

export type PhaseOutcome = {
  version: 1;
  slug: string;
  phase: number;
  status: PhaseOutcomeStatus;
  reason?: string;
  /**
   * The decision KEY a `blocked` / `needs-human` declaration is missing
   * (chapter 10 ZTD-3): one of `DECISION_KEYS`, or a blocker class as its short
   * form (`credential`, `permission`, `gate`, `external`, `lock`). The script
   * requires it on those two statuses; the reader TOLERATES its absence — a
   * 4.1.0 session's file must still park the phase during the rollout, and
   * the classifier then falls back to the prose it always read. Read BEFORE
   * the prose by `situation.ts`, which is what retires `blocked-declared:unknown`.
   */
  needs?: string;
  /** A permission block, structured: the rule that refused … */
  rule?: string;
  /** … and the command it refused. Both optional, both beside `needs`. */
  command?: string;
  /** ISO time the session suggests re-checking at (waiting-external only). */
  resume_after?: string;
  watch: string[];
  written_at: string;
  /**
   * The session that declared it, when it knew its own id (`$PE_SESSION_ID`,
   * runner-injected; else `$CLAUDE_CODE_SESSION_ID`). The console resumes THAT
   * session for an unsupervised `waiting-external` / `partial`, so the
   * declaration from a hand-run session drives the same machinery as a lane's.
   */
  session_id?: string;
};

const STATUSES: readonly string[] = OUTCOME_STATUSES;

/** Where a given attempt's outcome file lives, keyed by run and phase. */
export function outcomeFileFor(root: string, slug: string, runId: string, phase: number): string {
  return join(runDir(root, slug), `run-${runId}-p${phase}-outcome.json`);
}

/**
 * Where a session NOBODY supervises declares its outcome: `phase-outcome.sh`
 * with no `PE_OUTCOME_FILE` writes `runs/<instance>/<slug>/outcomes/phase-NN.json`
 * (the identity rule of `instances.mjs`, mirrored in `scripts/instance.sh`).
 * The console watches this directory and feeds what lands there to the
 * convergence loop — the one channel a human session's declared wait, block
 * or partial has into the autopilot.
 */
export function outcomeInboxDir(root: string, slug: string): string {
  return join(runDir(root, slug), 'outcomes');
}

/**
 * The name an unsupervised declaration lands under.
 *
 * `phase-NN-<written_at>.json`, the stamp in basic ISO form (`20260810T211003Z`).
 * It used to be `phase-NN.json` — ONE name per phase, written with `mv` — so a
 * session that declared `partial` and then `blocked` silently destroyed the
 * first, and a console that had been away long enough to need both got exactly
 * one (S9-a). Two properties earn the stamp: the names are distinct, and
 * because the form is fixed-width and colon-free, sorting them as plain strings
 * IS sorting them chronologically, so a backlog is ingested oldest-first
 * without opening a single file.
 *
 * Nothing in TypeScript WRITES one — `scripts/phase-outcome.sh` does. This
 * names the shape, for tests and for the docs check; with no stamp it spells
 * the legacy name, which `inboxOutcomePhase` still reads and which is what is
 * already sitting in every inbox at upgrade.
 */
export function inboxOutcomeFile(root: string, slug: string, phase: number, writtenAt?: string): string {
  const stamp = writtenAt ? `-${writtenAt.replace(/[:-]/g, '')}` : '';
  return join(outcomeInboxDir(root, slug), `phase-${String(phase).padStart(2, '0')}${stamp}.json`);
}

/**
 * The phase an inbox file name addresses, or null for a name that is not one.
 *
 * Both shapes: `phase-08.json` (written by a 5.0.0 script, and by every one
 * already on disk at upgrade) and `phase-08-20260810T211003Z.json`.
 */
export function inboxOutcomePhase(file: string): number | null {
  const m = /(?:^|\/)phase-(\d{2,})(?:-\d{8}T\d{6}Z)?\.json$/.exec(file);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Read and validate an outcome file. Returns null for anything that must not
 * be trusted: unreadable, unparseable, wrong slug/phase, unknown status, or
 * written before this attempt started. Null is always safe — it degrades to
 * the legacy "the session declared nothing" path.
 */
/**
 * The structured half of a `blocked`/`needs-human` declaration, ready to
 * spread into `record.declared` — present only when the session said it, so
 * a record written from a declaration without `--needs` carries no `needs`
 * key at all (the classifier reads absence as "fall back to the prose").
 */
export function needsOf(outcome: Pick<PhaseOutcome, 'needs' | 'rule' | 'command'>): {
  needs?: string; rule?: string; command?: string;
} {
  return {
    ...(outcome.needs ? { needs: outcome.needs } : {}),
    ...(outcome.rule ? { rule: outcome.rule } : {}),
    ...(outcome.command ? { command: outcome.command } : {}),
  };
}

export function readOutcome(
  path: string,
  expect: { slug: string; phase: number; notBefore?: string },
): PhaseOutcome | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: Partial<PhaseOutcome>;
  try {
    parsed = JSON.parse(raw) as Partial<PhaseOutcome>;
  } catch {
    return null;
  }
  if (parsed.version !== 1) return null;
  if (parsed.slug !== expect.slug) return null;
  if (parsed.phase !== expect.phase) return null;
  if (typeof parsed.status !== 'string' || !STATUSES.includes(parsed.status)) return null;
  if (typeof parsed.written_at !== 'string' || !parsed.written_at) return null;
  // Parsed on both sides, never compared as strings. `phase-outcome.sh` writes
  // `written_at` with `date -u +%Y-%m-%dT%H:%M:%SZ` — WHOLE SECONDS — while
  // `notBefore` is a `new Date().toISOString()` carrying milliseconds. Lexically
  // `2026-08-21T10:00:00Z` sorts BEFORE `2026-08-21T10:00:00.500Z`, so a real
  // declaration written in the same second the attempt started was thrown away
  // as stale — and the run read it as "the session declared nothing".
  // A `written_at` that does not parse is treated as stale: a timestamp we
  // cannot place is not evidence that it belongs to this attempt.
  if (expect.notBefore) {
    const wrote = Date.parse(parsed.written_at);
    const floor = Date.parse(expect.notBefore);
    if (!Number.isFinite(wrote)) return null;
    // A floor we cannot parse cannot reject anything — it is our own value, and
    // dropping a good outcome over it would be the worse failure.
    if (Number.isFinite(floor) && wrote < Math.floor(floor / 1000) * 1000) return null;
  }
  const watch = Array.isArray(parsed.watch)
    ? parsed.watch.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0).slice(0, 8)
    : [];
  return {
    version: 1,
    slug: parsed.slug,
    phase: parsed.phase,
    status: parsed.status as PhaseOutcomeStatus,
    ...(typeof parsed.reason === 'string' && parsed.reason ? { reason: parsed.reason.slice(0, 500) } : {}),
    // A word, never a sentence: the same shape the script validates against
    // decisions.env. Membership is the CLASSIFIER's question (an unknown word
    // classifies through the prose, exactly like no word), so a key added to
    // the vocabulary tomorrow is not thrown away by a reader built today.
    ...(typeof parsed.needs === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(parsed.needs) ? { needs: parsed.needs } : {}),
    ...(typeof parsed.rule === 'string' && parsed.rule ? { rule: parsed.rule.slice(0, 200) } : {}),
    ...(typeof parsed.command === 'string' && parsed.command ? { command: parsed.command.slice(0, 500) } : {}),
    ...(typeof parsed.resume_after === 'string' && parsed.resume_after
      ? { resume_after: parsed.resume_after }
      : {}),
    watch,
    written_at: parsed.written_at,
    ...(typeof parsed.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(parsed.session_id)
      ? { session_id: parsed.session_id }
      : {}),
  };
}

/** Remove a consumed outcome file. Never throws — best-effort. */
export function consumeOutcome(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch { /* best-effort */ }
}

/** Why an inbox declaration was set aside instead of acted on (WAI-7). */
export const OUTCOME_IGNORE_REASONS = Object.freeze(['stale', 'invalid', 'failed'] as const);
export type OutcomeIgnoreReason = (typeof OUTCOME_IGNORE_REASONS)[number];

/** The folder under an inbox where set-aside declarations are kept, never deleted. */
export const OUTCOME_IGNORED_DIR = 'ignored';

/**
 * Set an inbox declaration aside WITHOUT destroying it: moved into
 * `<inbox>/ignored/<name>.<reason>` (a `.<n>` suffix when that name already
 * exists — evidence is never overwritten). Returns the new path, or null when
 * the move failed (the caller then deletes, as it always did, and says so).
 *
 * The inbox used to `consumeOutcome` a file BEFORE deciding whether to believe
 * it, so an unparseable or day-old declaration — the one channel a hand session
 * has into the autopilot — vanished with one `console.log` line and nothing on
 * any run's journal. The 24-hour rule stays; the silence does not.
 */
export function ignoreOutcome(path: string, reason: OutcomeIgnoreReason): string | null {
  try {
    const dir = join(dirname(path), OUTCOME_IGNORED_DIR);
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${basename(path)}.${reason}`);
    let target = base;
    for (let n = 1; existsSync(target); n++) target = `${base}.${n}`;
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * The `written_at` of a declaration the strict reader rejected, if the bytes
 * are JSON at all — so `phase.outcome-ignored` can still say when it was
 * written. Null when nothing can be read.
 */
export function peekWrittenAt(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { written_at?: unknown };
    return typeof parsed?.written_at === 'string' ? parsed.written_at : null;
  } catch {
    return null;
  }
}
