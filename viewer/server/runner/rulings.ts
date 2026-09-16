/**
 * The rulings ledger: what a session DECIDED, as opposed to how it ended.
 *
 * The outcome protocol (`scripts/phase-outcome.sh <slug> <N> <status>`,
 * `outcome.ts`) is the session-to-runner channel and it is about endings: a
 * wait, a block, a partial, a completion. It is read once, acted on, and
 * consumed. There has never been a channel for the other thing a session
 * produces that nobody else can reconstruct — the judgement calls it made on
 * the way.
 *
 * Measured, repeatedly: the plan says "use the existing helper" and there are
 * two; the plan says "keep the old field for readers that predate it" and the
 * session decides one reader does not exist any more; a phase leaves a
 * sub-case deliberately unhandled because handling it belongs to a later
 * phase. Every one of those is a decision the next session will hit again, and
 * every one of them lands — when it lands at all — in a paragraph of a handoff
 * that the next session skims. A ruling is that decision as a record: three
 * kinds, one line each, appended where the console can see them.
 *
 * Nothing acts on a ruling. It does not park a phase, it does not climb the
 * ladder, it does not change what the runner does next — and that is the
 * property that makes it safe for a session to record one whenever it is in
 * doubt. It costs a line and it buys a reader.
 *
 * ------------------------------------------------------------------
 * The file
 * ------------------------------------------------------------------
 *
 * `runs/<instance>/<slug>/rulings.ndjson` — beside `outcomes/`, per PLAN and
 * not per run, because a decision made in phase 3 is still the reason phase 9
 * looks the way it does two runs later. Append-only, one JSON object per line,
 * written by `phase-outcome.sh` (bash 3.2, no `jq`) and by nothing else except
 * this file's own ack appends.
 *
 * Append-only is what makes the concurrency story trivial: several lanes may
 * be recording at once, and appending a single short line is atomic enough on
 * every filesystem the console runs on. It is also what makes an ACK an append
 * rather than an edit — `appendAck` writes a second line naming the first, and
 * `readRulings` folds the two. A reader that rewrote the file to mark one row
 * seen would be a writer racing every live session.
 *
 * A torn last line (a crash mid-append) is dropped rather than fatal: the
 * whole ledger is diagnostic, and losing the newest of a hundred rulings is
 * strictly better than an endpoint that 500s.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { RULING_KINDS } from '../../shared/attention-model.js';
import { DECISION_KEYS, type DecisionKey } from '../../shared/decisions-model.js';
import { log } from '../log.ts';
import { runDir } from './state.ts';

export type RulingKind = (typeof RULING_KINDS)[number];

export type Ruling = {
  /**
   * Stable, content-derived: `sha256(slug, phase, at, what)` truncated. The
   * ledger is append-only and a line never changes, so hashing its own content
   * gives an id that survives a re-read, a restart and a copy of the file —
   * which it has to, because it is the ack key and the inbox item's `subject`.
   * Since phase 12 `phase-outcome.sh` stamps the same digest on the line, and
   * a stamped id is preferred over the derivation: the writer's bytes are the
   * id `decisions.sh promote` was given, and a multi-byte `what` cut at 500
   * characters by bash and at 500 UTF-16 units here would otherwise be two ids.
   */
  id: string;
  slug: string;
  phase: number;
  kind: RulingKind;
  /** The decision itself, in the session's own words. */
  what: string;
  /** Why it went that way. */
  why?: string;
  /** What it costs if the call was wrong — the field that makes a ruling worth reading. */
  costIfWrong?: string;
  /**
   * The decision key the ruling answers (`phase-outcome.sh … --needs <key>`),
   * kept only when it is one of the manifest's keys. This is what turns a
   * ruling from a note into something the inbox can offer to remember and
   * `decisions.sh promote` can file under a row without being told the key.
   */
  decisionKey?: DecisionKey;
  /** The session that made it, when it knew its own id. */
  sessionId?: string;
  /**
   * Who decided, when the ruling was not a session's own — the relay's rows
   * (phase 14) say `relay` or name the person who answered the question.
   */
  by?: string;
  /**
   * A relayed question's answer (phase 14): the tool that asked, the question's
   * key, the option chosen and who chose it. What the inbox offers to turn into
   * a relay RULE — a `## Decisions` row is the wrong home for "this question,
   * this answer".
   */
  relay?: RulingRelay;
  /** ISO. */
  at: string;
  /** Seen by a person. Annotation, never resolution — a ruling is never "done". */
  ack?: { at: string; by?: string };
};

/** A relayed question's answer, as a ruling carries it. */
export type RulingRelay = { tool: string; key: string; answer: string; answeredBy: string; ruleId?: string };

/** Where a plan's ledger lives. Beside `outcomes/`, and per plan. */
export function rulingsFile(root: string, slug: string): string {
  return join(runDir(root, slug), 'rulings.ndjson');
}

const MAX_WHAT = 500;
const MAX_WHY = 800;
const MAX_COST = 300;

/**
 * How many lines are kept in memory from one ledger.
 *
 * The file itself is never truncated — it is the record — but a plan that has
 * run for months should not turn one endpoint into a megabyte of JSON. The
 * NEWEST are kept: an old ruling that still matters has been read by now.
 */
export const MAX_RULINGS = 500;

export function rulingId(slug: string, phase: number, at: string, what: string): string {
  return createHash('sha256').update(`${slug} ${phase} ${at} ${what}`).digest('hex').slice(0, 12);
}

/** The shape a stamped id must have to be believed: what `rulingId` emits. */
const STAMPED_ID_RE = /^[0-9a-f]{12}$/;

function isDecisionKey(value: unknown): value is DecisionKey {
  return typeof value === 'string' && (DECISION_KEYS as readonly string[]).includes(value);
}

function isKind(value: unknown): value is RulingKind {
  return typeof value === 'string' && (RULING_KINDS as readonly string[]).includes(value);
}

/**
 * One parsed line to a ruling, or null for anything that must not be trusted.
 *
 * `kind` falls back to `ambiguity` rather than rejecting the line: a console
 * one version behind must still show a ruling written under a kind it has not
 * heard of, and the weakest of the three is the honest place to put it.
 */
function toRuling(parsed: Record<string, unknown>): Ruling | null {
  const slug = typeof parsed.slug === 'string' ? parsed.slug : '';
  const phase = Number(parsed.phase);
  const what = typeof parsed.what === 'string' ? parsed.what.slice(0, MAX_WHAT) : '';
  const at = typeof parsed.at === 'string' ? parsed.at : '';
  if (!slug || !what || !at || !Number.isInteger(phase) || phase <= 0) return null;
  const why = typeof parsed.why === 'string' && parsed.why ? parsed.why.slice(0, MAX_WHY) : undefined;
  const cost = typeof parsed.cost_if_wrong === 'string' && parsed.cost_if_wrong
    ? parsed.cost_if_wrong.slice(0, MAX_COST) : undefined;
  const session = typeof parsed.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(parsed.session_id)
    ? parsed.session_id : undefined;
  const stamped = typeof parsed.id === 'string' && STAMPED_ID_RE.test(parsed.id) ? parsed.id : null;
  const by = typeof parsed.by === 'string' && parsed.by.trim() ? parsed.by.trim().slice(0, 64) : undefined;
  const relay = relayOf(parsed.relay);
  return {
    id: stamped ?? rulingId(slug, phase, at, what),
    slug,
    phase,
    kind: isKind(parsed.kind) ? parsed.kind : 'ambiguity',
    what,
    ...(why ? { why } : {}),
    ...(cost ? { costIfWrong: cost } : {}),
    ...(isDecisionKey(parsed.decisionKey) ? { decisionKey: parsed.decisionKey } : {}),
    ...(session ? { sessionId: session } : {}),
    ...(by ? { by } : {}),
    ...(relay ? { relay } : {}),
    at,
  };
}

/** A relay block off a line, or nothing — every field a bounded string. */
function relayOf(value: unknown): RulingRelay | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const text = (field: unknown, max: number) => (typeof field === 'string' && field ? field.slice(0, max) : '');
  const tool = text(raw.tool, 60);
  const key = text(raw.key, 120);
  const answer = text(raw.answer, 120);
  const answeredBy = text(raw.answeredBy, 20);
  if (!tool || !key || !answer || !answeredBy) return undefined;
  const ruleId = text(raw.ruleId, 64);
  return { tool, key, answer, answeredBy, ...(ruleId ? { ruleId } : {}) };
}

/**
 * Append a ruling the CONSOLE made — the relay's answer to a question (phase
 * 14) — in exactly the shape `phase-outcome.sh … ruling` writes, id stamped the
 * same way, plus who decided (`by`) and the relay block. The second writer this
 * ledger has, and the reason `readRulings` never trusted the file to be one
 * process's: an append is one short line, atomic enough beside a live session's.
 * Never throws — the ledger is diagnostic.
 */
export function appendRuling(file: string, entry: {
  slug: string; phase: number; kind?: RulingKind; what: string; why?: string; decisionKey?: DecisionKey;
  by: string; sessionId?: string; relay?: RulingRelay; at?: string;
}): Ruling | null {
  const at = entry.at ?? new Date().toISOString();
  const what = entry.what.slice(0, MAX_WHAT);
  if (!entry.slug || !what || !Number.isInteger(entry.phase) || entry.phase <= 0) return null;
  const line = {
    version: 1,
    type: 'ruling',
    id: rulingId(entry.slug, entry.phase, at, what),
    slug: entry.slug,
    phase: entry.phase,
    kind: entry.kind ?? 'ambiguity',
    what,
    ...(entry.why ? { why: entry.why.slice(0, MAX_WHY) } : {}),
    ...(entry.decisionKey ? { decisionKey: entry.decisionKey } : {}),
    ...(entry.sessionId ? { session_id: entry.sessionId } : {}),
    by: entry.by.slice(0, 64),
    ...(entry.relay ? { relay: entry.relay } : {}),
    at,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return toRuling(line);
  } catch (error) {
    log.warn('rulings.append-failed', { file, error: (error as Error).message });
    return null;
  }
}

/**
 * Read a ledger, folding acks onto the rulings they name.
 *
 * Order is the file's own — oldest first — because the ledger is a narrative
 * and the surfaces that show it want it that way; `sortInbox` reorders the
 * inbox rows on its own terms and does not consult this.
 *
 * An unreadable file is an empty ledger, not an error: a plan that has never
 * recorded a ruling has no file at all, and that is by far the common case.
 */
export function readRulings(file: string): Ruling[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('rulings.read-failed', { file, error: (error as Error).message });
    }
    return [];
  }

  const rulings: Ruling[] = [];
  const acks = new Map<string, { at: string; by?: string }>();
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let parsed: Record<string, unknown>;
    // A torn tail — the console died between the write and the newline — is
    // one unparseable line, and dropping it is the whole recovery story.
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
    if (parsed.version !== 1) continue;
    if (parsed.type === 'ack') {
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const at = typeof parsed.at === 'string' ? parsed.at : '';
      if (!id || !at) continue;
      // Last ack wins: acknowledging twice is not an error, and the newer
      // stamp is the one a reader wants.
      acks.set(id, { at, ...(typeof parsed.by === 'string' && parsed.by ? { by: parsed.by.slice(0, 64) } : {}) });
      continue;
    }
    const ruling = toRuling(parsed);
    if (ruling) rulings.push(ruling);
  }

  const kept = rulings.length > MAX_RULINGS ? rulings.slice(-MAX_RULINGS) : rulings;
  for (const ruling of kept) {
    const ack = acks.get(ruling.id);
    if (ack) ruling.ack = ack;
  }
  return kept;
}

/**
 * Record that a person has seen one. Best-effort and never throws — an ack is
 * annotation, and losing one is not worth failing the request it rode in on.
 *
 * `by` is required (phase 12): the audit counted 184 acks and 0 with a name,
 * which made every one of them "somebody, at some point". An ack with nobody
 * behind it is refused, not written — the caller derives the actor
 * (`actorOfRequest`) and a script names itself.
 */
export function appendAck(file: string, id: string, by: string, at: string = new Date().toISOString()): boolean {
  if (!id) return false;
  const who = typeof by === 'string' ? by.trim().slice(0, 64) : '';
  if (!who) {
    log.warn('rulings.ack-unattributed', { file, id });
    return false;
  }
  const line = JSON.stringify({ version: 1, type: 'ack', id, at, by: who });
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
    return true;
  } catch (error) {
    log.warn('rulings.ack-failed', { file, id, error: (error as Error).message });
    return false;
  }
}

/**
 * Fold a freshly-read ledger into a run's own copy, returning the ones the run
 * had not seen.
 *
 * Identity is the ruling id, so ingestion is idempotent by construction: the
 * watcher fires on every write to the file, re-reads the whole thing, and only
 * the new lines come back. That is what makes "ingests once" a property rather
 * than a promise about how often the watcher fires.
 */
export function ingestRulings(existing: Ruling[] | undefined, ledger: readonly Ruling[]): {
  rulings: Ruling[];
  added: Ruling[];
} {
  const seen = new Set((existing ?? []).map((ruling) => ruling.id));
  const added = ledger.filter((ruling) => !seen.has(ruling.id));
  const merged = [...(existing ?? []), ...added];
  return { rulings: merged.length > MAX_RULINGS ? merged.slice(-MAX_RULINGS) : merged, added };
}
