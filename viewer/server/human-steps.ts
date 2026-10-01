/**
 * A person's turn — the human-step LEDGER, its state machine, and the ingest
 * that informs a person once (control-tower phase 41, §Architecture 12).
 *
 * When a session declares `needs-human --step <kind> …` (and, from phase 44,
 * when the plan or the console does), the step is written HERE first:
 * `<instance state>/human-steps.ndjson`, append-only, one JSON object per line.
 * A step's first line carries all of it (state `declared`); every later line
 * is a move — `{v, id, state, at, …}` — and the reader folds them, LAST STATE
 * WINS, holding each move to `HUMAN_STEP_TRANSITIONS` on the way: a line that
 * moves a settled step is ignored, so the file cannot talk a proven step back
 * open. A last line with no newline is a write the console died inside and is
 * dropped — every writer appends a whole line and its newline in one call, so
 * a torn line is never a real one.
 *
 * What it feeds: ONE `human-step` inbox row per open step (`inbox.ts`), ONE
 * `needs-you` push carrying the step's actions (`push/catalogue.ts`), and the
 * park — the phase waits on a PERSON (`personWaitEntry`), an unbudgeted wait,
 * so no external-wait budget is charged for a person's time.
 *
 * The redaction floor: every string that reaches the ledger has been through
 * `redactSecrets`, a session's `auto-open` is dropped (only a plan's step may
 * open by itself), a link that is not http(s) is dropped, and the one thing a
 * step ever STORES — a `secret-entry`'s secret — goes to the credential
 * registry (`storeStepSecret`: the keychain, else a 0600 file), never here,
 * and nothing in this module reads one back.
 *
 * The verbs that move a step (control-tower phase 43) — open, open again,
 * check, snooze, cannot, dismiss — all go through `HumanStepLedger.move`, and
 * each move line names its `verb` (`HUMAN_STEP_MOVES`), so the fold can count
 * opens, checks and reminders, and the reminder clock (`tickHumanSteps`) can
 * resume its series across a restart. What the clock does: re-announce an open
 * step at +15 m, +1 h, +6 h, then daily (`REMINDER_SERIES_MS`), never inside
 * the reminder quiet hours and never before a snooze ends; expire it at its
 * window's end (seven days when it names none) into an errand; withdraw it
 * when its phase has closed. A step's proof is a WATCH ref (`stepProofOf`):
 * the watch scheduler polls it on phase 6's `cmd:` back-off, bounded by the
 * step's window and never by a wait budget, and a landing proves the step.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { log } from './log.ts';
import {
  CREDENTIAL_ID_RE, DEVICE_CODE_RE, HUMAN_STEP_DEFAULT_WINDOW_MS, HUMAN_STEP_MOVES, HUMAN_STEP_OPEN_STATES,
  HUMAN_STEP_STATES, HUMAN_STEP_WHERE, KIND_META, REMINDER_SERIES_MS,
  canTransition, humanStepKindOf, isOpenableUrl, redactSecrets,
  type HumanStepBirth, type HumanStepKind, type HumanStepMove, type HumanStepState, type HumanStepWhere,
} from '../shared/human-step-model.js';
import { keychainStore, realExec, SECRET_MUST_BE_ONE_LINE, type Exec } from './accounts/credentials.ts';
import type { PhaseRecord } from './runner/state.ts';
import type { WaitAuthor } from './runner/wait-budget.ts';

/** The ledger's file name, under the instance's state directory. */
export const HUMAN_STEPS_FILE = 'human-steps.ndjson';

/** The one line version this reader writes and accepts. */
export const HUMAN_STEP_LINE_VERSION = 1;

/**
 * What a declaration's `step` carries — `phase-outcome.sh`'s object, as
 * `readOutcome` keeps it. Snake case because it is the file's own spelling.
 */
export type DeclaredStep = {
  kind: HumanStepKind;
  title: string;
  open_url?: string;
  open_command?: string;
  where?: HumanStepWhere;
  proof?: string;
  lines?: string[];
  code?: string;
  credential?: string;
};

/** One step, folded — every string already redacted. */
export type HumanStep = {
  id: string;
  kind: HumanStepKind;
  title: string;
  where: HumanStepWhere;
  birth: HumanStepBirth;
  slug: string;
  phase: number;
  runId?: string;
  sessionId?: string;
  openUrl?: string;
  openCommand?: string;
  proof?: string;
  lines?: string[];
  /** A device code — the ONE code a step shows on purpose (`DEVICE_CODE_RE`). */
  code?: string;
  /** `secret-entry` only: the registry id its secret is stored under. */
  credential?: string;
  /** A PLAN step only: it may open by itself on the machine. */
  autoOpen?: 'host';
  /** When the step's window closes, if it has one. */
  until?: string;
  state: HumanStepState;
  declaredAt: string;
  /** When the state it is in was reached. */
  at: string;
  /** How often the person opened it — every `open` move, "open again" included. */
  opened: number;
  /** Did the announcing push go out. */
  pushed?: boolean;
  /** `secret-entry`: where the secret went — never what it was. */
  stored?: 'keychain' | 'file';
  /** Why it settled, in words — never a value. */
  note?: string;
  /** The first notification's moment — the reminder series starts here. */
  notifiedAt?: string;
  /** How many reminders went out, and the last one's moment. */
  reminders?: number;
  remindedAt?: string;
  /** The last open. */
  openedAt?: string;
  /** How many checks a person (or the terminal) asked for, and the last one's moment. */
  checks?: number;
  checkedAt?: string;
  /** What the proof read at the last check, in its own words — the card says it when a check does not land. */
  read?: string;
  /** No reminder before this — a person's snooze. */
  snoozeUntil?: string;
  /** The person's last act on the step (an open or a check) — the reminder series waits after it. */
  actedAt?: string;
  /** Who proved it: a person's name, `watch` (the proof's watch landed) or `terminal` (its command exited 0). */
  provenBy?: string;
};

/** A move: every field but the id, the state and the clock is optional. */
type MoveLine = {
  v: number; id: string; state: HumanStepState; at: string;
  by?: string; pushed?: boolean; stored?: 'keychain' | 'file'; note?: string;
  /** Which verb made it (phase 43); absent on a phase-41 line, which reads by its state. */
  verb?: HumanStepMove;
  /** `open`: where it went — `here`, `host`, or `terminal`. */
  where?: 'here' | 'host' | 'terminal';
  /** `snooze`: no reminder before this. */
  snoozeUntil?: string;
};

/** One line of a step's history, as `history` answers it — the datums a card shows. */
export type StepMove = {
  state: HumanStepState; verb: HumanStepMove; at: string;
  by?: string; note?: string; where?: MoveLine['where']; pushed?: boolean; snoozeUntil?: string;
};

/** The verb a move line was made by — its own word, else the one its state implies (a phase-41 line). */
function moveVerbOf(move: Partial<MoveLine>, state: HumanStepState): HumanStepMove {
  if (typeof move.verb === 'string' && (HUMAN_STEP_MOVES as readonly string[]).includes(move.verb)) return move.verb;
  switch (state) {
    case 'opened': return 'open';
    case 'checking': return 'check';
    case 'proven': return 'prove';
    case 'expired': return 'expire';
    case 'cannot': return 'cannot';
    case 'dismissed': return 'dismiss';
    default: return 'notify';
  }
}

/** Fold one accepted move into the step it moves. */
function foldMove(known: HumanStep, state: HumanStepState, move: MoveLine): HumanStep {
  const verb = moveVerbOf(move, state);
  const next: HumanStep = {
    ...known,
    state,
    at: move.at,
    ...(typeof move.pushed === 'boolean' ? { pushed: move.pushed } : {}),
    ...(move.stored ? { stored: move.stored } : {}),
    ...(typeof move.note === 'string' ? { note: move.note } : {}),
  };
  switch (verb) {
    case 'notify': next.notifiedAt ??= move.at; break;
    case 'remind': next.reminders = (known.reminders ?? 0) + 1; next.remindedAt = move.at; break;
    case 'open': next.opened = known.opened + 1; next.openedAt = move.at; next.actedAt = move.at; break;
    case 'check':
      // The start of a check (`checking`) is the act; its unlanded end (back to
      // `notified`) carries what the proof read.
      if (state === 'checking') { next.checks = (known.checks ?? 0) + 1; next.checkedAt = move.at; next.actedAt = move.at; }
      else if (typeof move.note === 'string') next.read = move.note;
      break;
    case 'prove':
      if (typeof move.note === 'string') next.read = move.note;
      if (move.by) next.provenBy = move.by;
      break;
    case 'snooze': if (move.snoozeUntil) next.snoozeUntil = move.snoozeUntil; break;
    default: break;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Sanitising — what a declaration may put in the ledger
 * ------------------------------------------------------------------ */

const TITLE_MAX = 300;
const LINE_MAX = 300;
const LINES_MAX = 12;
const COMMAND_MAX = 500;
const PROOF_MAX = 1000;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = redactSecrets(value.replace(/[\u0000-\u001f]+/g, ' ').trim()).slice(0, max);
  return clean || undefined;
}

/** A step as a caller offered it, sanitised — or null when it is not a step at all. */
export type CleanStep = {
  step: Omit<HumanStep, 'id' | 'state' | 'at' | 'declaredAt' | 'opened' | 'slug' | 'phase' | 'birth'> & {
    windowMinutes?: number;
  };
  /** The fields that were offered and not kept, by name — never their values. */
  dropped: string[];
};

/**
 * Hold a declared step to the language: a known kind and a title, or nothing.
 * Everything else is kept only in its own shape — a link only if http(s), a
 * device code only on a `device-code` step, a credential id only on a
 * `secret-entry` — and `auto-open` only when the PLAN declared the step: a
 * session's step never opens by itself (the safety floor, HS-4). Every string
 * is redacted, so a file an older script wrote cannot carry a secret further.
 */
export function sanitiseStep(raw: unknown, birth: HumanStepBirth): CleanStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const kind = humanStepKindOf(input.kind);
  const title = text(input.title, TITLE_MAX);
  if (!kind || !title) return null;
  const dropped: string[] = [];
  const whereWord = typeof input.where === 'string' ? input.where.trim().toLowerCase() : '';
  const where: HumanStepWhere = (HUMAN_STEP_WHERE as readonly string[]).includes(whereWord)
    ? (whereWord as HumanStepWhere)
    : KIND_META[kind].where;
  if (whereWord && where !== whereWord) dropped.push('where');
  const step: CleanStep['step'] = { kind, title, where };

  const url = input.open_url ?? input.openUrl;
  if (url !== undefined) {
    if (isOpenableUrl(url)) step.openUrl = redactSecrets(String(url).trim()).slice(0, PROOF_MAX);
    else dropped.push('open_url');
  }
  const command = text(input.open_command ?? input.openCommand, COMMAND_MAX);
  if (command) step.openCommand = command;
  const proof = text(input.proof, PROOF_MAX);
  if (proof) step.proof = proof;
  if (Array.isArray(input.lines)) {
    const lines = input.lines.map((line) => text(line, LINE_MAX)).filter((line): line is string => Boolean(line));
    if (lines.length) step.lines = lines.slice(0, LINES_MAX);
  }
  if (input.code !== undefined) {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (kind === 'device-code' && DEVICE_CODE_RE.test(code)) step.code = code;
    else dropped.push('code');
  }
  if (input.credential !== undefined) {
    const id = typeof input.credential === 'string' ? input.credential.trim() : '';
    if (kind === 'secret-entry' && CREDENTIAL_ID_RE.test(id)) step.credential = id;
    else dropped.push('credential');
  }
  const auto = input.auto_open ?? input.autoOpen;
  if (auto !== undefined) {
    if (birth === 'plan' && auto === 'host') step.autoOpen = 'host';
    else dropped.push('auto-open');
  }
  const minutes = Number(input.windowMinutes ?? input.window_minutes);
  if (Number.isFinite(minutes) && minutes > 0) step.windowMinutes = Math.round(minutes);
  return { step, dropped };
}

/**
 * A step's id: minted once per declaration and distinct across two — the nonce
 * is what keeps two identical declarations in the same millisecond apart, which
 * would otherwise fold into one step and drop the second.
 */
export function stepIdFor(parts: { slug: string; phase: number; declaredAt: string; kind: string; title: string }): string {
  return createHash('sha256')
    .update([parts.slug, parts.phase, parts.declaredAt, parts.kind, parts.title, randomBytes(8).toString('hex')].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

/** What reading the ledger found, beside the steps. `moves` only when asked for (`history`). */
export type LedgerRead = { steps: Map<string, HumanStep>; torn: boolean; skipped: number; moves?: Map<string, StepMove[]> };

/**
 * Read one ledger file's lines. A last line with no newline is TORN — the
 * writer appends a whole line and its newline in one call — and is dropped.
 */
function linesOf(path: string): { lines: string[]; torn: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { lines: [], torn: false };
  }
  const parts = raw.split('\n');
  const tail = parts.pop() ?? '';
  return { lines: parts, torn: tail.trim().length > 0 };
}

/**
 * Fold the ledger — the rotated copy first, then the live file — into one
 * step per id, last state winning. A move the state machine refuses (out of
 * a settled state, or into a word that is not a state) is skipped and counted,
 * as is a line that is not JSON or names a step nobody declared.
 */
export function readLedger(file: string, opts: { history?: boolean } = {}): LedgerRead {
  const steps = new Map<string, HumanStep>();
  const moves = opts.history ? new Map<string, StepMove[]>() : undefined;
  let skipped = 0;
  let torn = false;
  for (const path of [`${file}.1`, file]) {
    const read = linesOf(path);
    if (path === file) torn = read.torn;
    for (const line of read.lines) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        skipped++;
        continue;
      }
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const state = parsed.state as HumanStepState;
      if (parsed.v !== HUMAN_STEP_LINE_VERSION || !id || !(HUMAN_STEP_STATES as readonly string[]).includes(state)) {
        skipped++;
        continue;
      }
      const known = steps.get(id);
      if (!known) {
        if (state !== 'declared' || !humanStepKindOf(parsed.kind)) { skipped++; continue; }
        const { v: _v, ...rest } = parsed;
        const step = rest as unknown as HumanStep;
        steps.set(id, { ...step, opened: typeof step.opened === 'number' ? step.opened : 0 });
        continue;
      }
      if (!canTransition(known.state, state)) { skipped++; continue; }
      const move = parsed as unknown as MoveLine;
      steps.set(id, foldMove(known, state, move));
      if (moves) {
        const list = moves.get(id) ?? [];
        list.push({
          state, verb: moveVerbOf(move, state), at: move.at,
          ...(move.by ? { by: move.by } : {}),
          ...(typeof move.note === 'string' ? { note: move.note } : {}),
          ...(move.where ? { where: move.where } : {}),
          ...(typeof move.pushed === 'boolean' ? { pushed: move.pushed } : {}),
          ...(move.snoozeUntil ? { snoozeUntil: move.snoozeUntil } : {}),
        });
        moves.set(id, list);
      }
    }
  }
  return { steps, torn, skipped, ...(moves ? { moves } : {}) };
}

/** Why a move was refused. */
export type MoveRefusal = { refused: 'unknown-step' | 'transition'; from?: HumanStepState; to: HumanStepState };

/** What a move may say beside its state — each field redacted or shaped before it is written. */
export type MoveExtra = {
  by?: string; pushed?: boolean; stored?: 'keychain' | 'file'; note?: string;
  verb?: HumanStepMove; where?: MoveLine['where']; snoozeUntil?: string;
};

/** Is this step still open — one of the four states short of settled? */
export function isOpenStep(step: Pick<HumanStep, 'state'>): boolean {
  return (HUMAN_STEP_OPEN_STATES as readonly string[]).includes(step.state);
}

export class HumanStepLedger {
  readonly file: string;
  private readonly now: () => Date;
  /**
   * Told of every step the ledger writes — declared or moved — with the step
   * as it now reads (control-tower phase 42). The console emits it as the
   * `human-step` event, so an open page patches the step's state in place: a
   * proof landing on the phone moves the desk's strip without a reload.
   */
  private readonly onChange: ((step: HumanStep) => void) | undefined;

  constructor(file: string, now: () => Date = () => new Date(), onChange?: (step: HumanStep) => void) {
    this.file = file;
    this.now = now;
    this.onChange = onChange;
  }

  /** Tell the listener — which may never break a write that already landed. */
  private changed(step: HumanStep): void {
    try {
      this.onChange?.(step);
    } catch { /* the ledger line is the durable fact */ }
  }

  private append(line: Record<string, unknown>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // One call, the line and its newline together: a console that dies inside
    // it leaves a torn last line, which the reader drops — never half a step.
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  /** Every step, folded. */
  all(): HumanStep[] {
    return [...readLedger(this.file).steps.values()];
  }

  /** The steps still open — one inbox row each. */
  open(): HumanStep[] {
    return this.all().filter((step) => (HUMAN_STEP_OPEN_STATES as readonly string[]).includes(step.state));
  }

  get(id: string): HumanStep | undefined {
    return readLedger(this.file).steps.get(id);
  }

  /** Every move a step made after its declaration, oldest first — each open, each check and what it read. */
  history(id: string): StepMove[] {
    return readLedger(this.file, { history: true }).moves?.get(id) ?? [];
  }

  /** Every step with its moves, from one read of the file. */
  withHistory(): { step: HumanStep; moves: StepMove[] }[] {
    const read = readLedger(this.file, { history: true });
    return [...read.steps.values()].map((step) => ({ step, moves: read.moves?.get(step.id) ?? [] }));
  }

  /** Write a new step, state `declared`. */
  declare(input: {
    slug: string; phase: number; birth: HumanStepBirth; runId?: string; sessionId?: string; clean: CleanStep['step'];
  }): HumanStep {
    const declaredAt = this.now().toISOString();
    const { windowMinutes, ...fields } = input.clean;
    const id = stepIdFor({ slug: input.slug, phase: input.phase, declaredAt, kind: fields.kind, title: fields.title });
    const until = windowMinutes ? new Date(Date.parse(declaredAt) + windowMinutes * 60_000).toISOString() : undefined;
    const step: HumanStep = {
      id, ...fields, birth: input.birth, slug: input.slug, phase: input.phase,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(until ? { until } : {}),
      state: 'declared', declaredAt, at: declaredAt, opened: 0,
    };
    this.append({ v: HUMAN_STEP_LINE_VERSION, ...step });
    this.changed(step);
    return step;
  }

  /**
   * Move a step to `to`, if the state machine allows it — the one door every
   * verb uses. `note` is words about the move, redacted like everything else.
   */
  move(id: string, to: HumanStepState, extra: MoveExtra = {}): HumanStep | MoveRefusal {
    const step = this.get(id);
    if (!step) return { refused: 'unknown-step', to };
    if (!canTransition(step.state, to)) return { refused: 'transition', from: step.state, to };
    const at = this.now().toISOString();
    const line: MoveLine = {
      v: HUMAN_STEP_LINE_VERSION, id, state: to, at,
      ...(extra.verb ? { verb: extra.verb } : {}),
      ...(extra.by ? { by: redactSecrets(extra.by).slice(0, 80) } : {}),
      ...(typeof extra.pushed === 'boolean' ? { pushed: extra.pushed } : {}),
      ...(extra.stored ? { stored: extra.stored } : {}),
      ...(extra.note ? { note: redactSecrets(extra.note.replace(/[\u0000-\u001f]+/g, ' ')).slice(0, 300) } : {}),
      ...(extra.where ? { where: extra.where } : {}),
      ...(extra.snoozeUntil ? { snoozeUntil: extra.snoozeUntil } : {}),
    };
    this.append(line);
    const moved = this.get(id)!;
    this.changed(moved);
    return moved;
  }
}

/* ------------------------------------------------------------------ *
 * The ingest — ledger, then ONE push, then `notified`
 * ------------------------------------------------------------------ */

export type DeclareInput = {
  slug: string;
  phase: number;
  birth: HumanStepBirth;
  step: unknown;
  runId?: string;
  sessionId?: string;
};

/**
 * Record a declared step and inform a person, once: the ledger line
 * (`declared`), the one `needs-you` push (`announce`, which answers whether it
 * went out), and the move to `notified`. The inbox row is not written — it is
 * DERIVED from the ledger's open steps, so there is exactly one per step by
 * construction. Null when the offer was not a step (no kind, no title).
 */
export function declareHumanStep(
  deps: { ledger: HumanStepLedger; announce: (step: HumanStep) => boolean },
  input: DeclareInput,
): HumanStep | null {
  const clean = sanitiseStep(input.step, input.birth);
  if (!clean) return null;
  const declared = deps.ledger.declare({
    slug: input.slug, phase: input.phase, birth: input.birth, clean: clean.step,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  if (clean.dropped.length) {
    log.warn('human-steps.fields-dropped', { id: declared.id, kind: declared.kind, birth: input.birth, dropped: clean.dropped });
  }
  let pushed = false;
  try {
    pushed = deps.announce(declared);
  } catch (error) {
    log.warn('human-steps.announce-failed', { id: declared.id, error: (error as Error)?.message ?? String(error) });
  }
  const moved = deps.ledger.move(declared.id, 'notified', { by: 'console', pushed, verb: 'notify' });
  log.info('human-steps.declared', {
    id: declared.id, kind: declared.kind, where: declared.where, birth: input.birth,
    slug: input.slug, phase: input.phase, pushed,
  });
  return 'refused' in moved ? declared : moved;
}

/**
 * The fields a journal line about a step carries — ids and words, the title
 * redacted like everything in the ledger, and never a code or a secret.
 */
export function stepJournalFields(step: HumanStep): Record<string, unknown> {
  return {
    stepId: step.id, kind: step.kind, where: step.where, birth: step.birth, state: step.state,
    title: step.title, ...(step.proof ? { proof: step.proof } : {}), ...(step.until ? { until: step.until } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The park — the phase waits on a PERSON
 * ------------------------------------------------------------------ */

/**
 * Park a phase record on a declared step: the declaration names the step, and
 * the record's wait history gains an entry of kind `person` that is
 * UNBUDGETED — `parkedMsOf` never sums it, `record.waits` never counts it —
 * so a person's time is not charged to the external-wait budget a phase has
 * for somebody else's clock. The entry's clock is the step's window, else the
 * declaration's own moment.
 *
 * The declaration carries the step's proof and its window's end (phase 43):
 * the watch scheduler polls the proof from the record (`stepProofOf`) and
 * bounds a `cmd:` proof by that end, never by a wait budget a person's turn
 * does not have.
 */
export function parkOnStep(
  record: PhaseRecord,
  step: Pick<HumanStep, 'id' | 'kind' | 'until'> & Partial<Pick<HumanStep, 'proof' | 'declaredAt'>>,
  by: WaitAuthor, at: string,
): void {
  if (record.declared) {
    record.declared.step = {
      id: step.id, kind: step.kind,
      ...(step.proof ? { proof: step.proof } : {}),
      until: new Date(windowEndOf({ until: step.until, declaredAt: step.declaredAt ?? at })).toISOString(),
    };
  }
  const last = record.waitHistory?.[record.waitHistory.length - 1];
  if (last && !last.resumedAt) last.resumedAt = at;
  (record.waitHistory ??= []).push({
    parkedFrom: at, parkedUntil: step.until ?? at, by, unbudgeted: true, kind: 'person',
  });
}

/** What a phase record is waiting on, by the open entry of its wait history. */
export function phaseWaitKind(record: Pick<PhaseRecord, 'waitHistory'>): 'person' | 'external' | null {
  const last = record.waitHistory?.[record.waitHistory.length - 1];
  if (!last || last.resumedAt) return null;
  return last.kind === 'person' ? 'person' : 'external';
}

/* ------------------------------------------------------------------ *
 * The proof is a watch (control-tower phase 43)
 * ------------------------------------------------------------------ */

/**
 * The proof a phase parked on an OPEN human step waits on — a watch ref the
 * scheduler adds to the phase's rotation, as it adds a `lock:` ref for a phase
 * parked behind a claim — with the end of the step's window. Null when the
 * phase is not parked on a step, the step names no proof, or the step has
 * settled (`declared.step.settled`, which the verbs write).
 */
export function stepProofOf(record: Pick<PhaseRecord, 'declared'>): { ref: string; until: number | null } | null {
  const declared = record.declared;
  const step = declared?.step;
  if (!declared || declared.status !== 'needs-human' || !step?.proof || step.settled) return null;
  const until = Date.parse(step.until ?? '');
  return { ref: step.proof, until: Number.isFinite(until) ? until : null };
}

/**
 * Where a `cmd:` ref of a phase parked on a human step stops being run: the
 * step's window's end. A person's turn has no wait budget (`parkOnStep`), so
 * `waitBudgetEndOf` — the console's eight-hour default for a declaration with
 * no budget stamp — would retire a days-long `third-party-approval` proof on
 * its first evening. Undefined for every other phase, which keeps the budget.
 */
export function stepWindowEndOf(record: Pick<PhaseRecord, 'declared'>): number | null | undefined {
  const step = record.declared?.status === 'needs-human' ? record.declared.step : undefined;
  if (!step) return undefined;
  const until = Date.parse(step.until ?? '');
  return Number.isFinite(until) ? until : null;
}

/** When a step's window closes: its own `until`, else seven days after it was declared. */
export function windowEndOf(step: Partial<Pick<HumanStep, 'until' | 'declaredAt'>>): number {
  const own = Date.parse(step.until ?? '');
  if (Number.isFinite(own)) return own;
  const declared = Date.parse(step.declaredAt ?? '');
  return (Number.isFinite(declared) ? declared : Date.now()) + HUMAN_STEP_DEFAULT_WINDOW_MS;
}

/**
 * What a resumed session is told when its person's turn is proven — the
 * kind, the step's own words, the proof and what it read, and who saw it —
 * so it can carry on from what was proven rather than re-checking blind.
 */
export function provenDetail(step: Pick<HumanStep, 'kind' | 'title' | 'proof'>, read: string | undefined, by: string): string {
  const who = by === 'watch' ? 'its proof landed on the console\'s watch'
    : by === 'terminal' ? 'its command exited 0 in the embedded terminal'
      : `checked by ${by}`;
  return `a person's turn is PROVEN — ${KIND_META[step.kind].label}: "${step.title}"`
    + `${step.proof ? `; proof ${step.proof}${read ? ` read: ${read}` : ''}` : '; it named no proof, and a person said it is done'}`
    + ` (${who})`;
}

/** The instruction a session is resumed with when its step is proven. */
export function provenInstruction(step: Pick<HumanStep, 'kind' | 'title' | 'proof'>, read: string | undefined, by: string): string {
  return `The person's turn this phase declared is done: ${provenDetail(step, read, by)}. `
    + 'Carry on from where you parked — re-run what the step unblocked, then take the phase to its exit '
    + 'criteria: verify, commit, and write the handoff — or declare the next honest outcome with phase-outcome.sh.';
}

/* ------------------------------------------------------------------ *
 * The reminder clock (control-tower phase 43)
 * ------------------------------------------------------------------ */

/** The reminder quiet hours, `HH:MM` on the machine's local clock; a window may cross midnight. */
export type ReminderQuiet = { start: string; end: string };

const QUIET_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function quietMinutes(text: string): number | null {
  const match = QUIET_TIME_RE.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The machine's local minute of the day — the clock quiet hours are written on. */
export function localMinuteOf(ms: number): number {
  const at = new Date(ms);
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * `at`, or — when it falls inside the quiet window, half-open `[start, end)` —
 * the minute that window ends. A reminder is DEFERRED out of quiet hours,
 * never dropped: the person hears it when the window closes.
 */
export function outsideQuiet(at: number, quiet: ReminderQuiet | null | undefined, minuteOf: (ms: number) => number = localMinuteOf): number {
  if (!quiet) return at;
  const start = quietMinutes(quiet.start);
  const end = quietMinutes(quiet.end);
  if (start === null || end === null || start === end) return at;
  const minute = minuteOf(at);
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return at;
  return at - (at % 60_000) + ((end - minute + 1440) % 1440) * 60_000;
}

/**
 * When an open step's next reminder is due, or null — it has settled, or its
 * window closes first (the expiry says it then). The gap is
 * `REMINDER_SERIES_MS[reminders sent]` (the last repeats) after the latest of
 * the first notification, the last reminder and the person's last act; a
 * snooze is a floor under it; quiet hours defer it to their end.
 */
export function nextReminderAt(
  step: HumanStep, opts: { quiet?: ReminderQuiet | null; minuteOf?: (ms: number) => number } = {},
): number | null {
  if (!isOpenStep(step)) return null;
  const anchor = Math.max(
    ...[step.notifiedAt ?? step.declaredAt, step.remindedAt, step.actedAt]
      .map((stamp) => Date.parse(stamp ?? ''))
      .filter((ms) => Number.isFinite(ms)),
  );
  const sent = step.reminders ?? 0;
  let due = anchor + REMINDER_SERIES_MS[Math.min(sent, REMINDER_SERIES_MS.length - 1)];
  const snoozed = Date.parse(step.snoozeUntil ?? '');
  if (Number.isFinite(snoozed) && snoozed > due) due = snoozed;
  due = outsideQuiet(due, opts.quiet, opts.minuteOf);
  return due < windowEndOf(step) ? due : null;
}

/** How often the reminder clock passes over the open steps — a reminder is late by at most this. */
export const HUMAN_STEP_CLOCK_MS = 60_000;

export type StepClockDeps = {
  ledger: HumanStepLedger;
  now: number;
  quiet?: ReminderQuiet | null;
  minuteOf?: (ms: number) => number;
  /** Re-announce a step; true when the push went out. `n` is this reminder's number. */
  remind: (step: HumanStep, n: number) => boolean;
  /** The window closed with nothing proven: the step is `expired`, and becomes an errand. */
  expired?: (step: HumanStep) => void;
  /** Words when the phase that raised this step has closed or moved on — the step is withdrawn. */
  withdrawn?: (step: HumanStep) => string | null;
};

export type StepClockPass = { reminded: string[]; expired: string[]; dismissed: string[] };

/**
 * One pass of the reminder clock over every open step. A withdrawn step is
 * dismissed; a step past its window is expired — once, and never reminded
 * again, because nothing moves out of a settled state; a step whose reminder is
 * due is re-announced and its reminder written, so the series resumes where it
 * was after a restart and a console that was down for a day sends ONE
 * reminder, not a burst.
 */
export function tickHumanSteps(deps: StepClockDeps): StepClockPass {
  const pass: StepClockPass = { reminded: [], expired: [], dismissed: [] };
  for (const step of deps.ledger.open()) {
    const gone = deps.withdrawn?.(step) ?? null;
    if (gone) {
      const moved = deps.ledger.move(step.id, 'dismissed', { by: 'console', verb: 'dismiss', note: gone });
      if (!('refused' in moved)) pass.dismissed.push(step.id);
      continue;
    }
    const end = windowEndOf(step);
    if (deps.now >= end) {
      const moved = deps.ledger.move(step.id, 'expired', {
        by: 'console', verb: 'expire', note: `the window closed at ${new Date(end).toISOString()} with nothing proven`,
      });
      if ('refused' in moved) continue;
      pass.expired.push(step.id);
      try { deps.expired?.(moved); } catch (error) {
        log.warn('human-steps.clock-failed', { id: step.id, error: (error as Error)?.message ?? String(error) });
      }
      continue;
    }
    const due = nextReminderAt(step, deps);
    if (due === null || due > deps.now) continue;
    let pushed = false;
    try { pushed = deps.remind(step, (step.reminders ?? 0) + 1); } catch (error) {
      log.warn('human-steps.clock-failed', { id: step.id, error: (error as Error)?.message ?? String(error) });
    }
    const moved = deps.ledger.move(step.id, 'notified', { by: 'console', verb: 'remind', pushed });
    if (!('refused' in moved)) pass.reminded.push(step.id);
  }
  return pass;
}

/* ------------------------------------------------------------------ *
 * secret-entry — the one kind that STORES something
 * ------------------------------------------------------------------ */

/** The keychain service a `secret-entry` stores under: `phase-console-<id>`. */
export function stepKeychainService(id: string): string {
  return `phase-console-${id}`;
}

/**
 * Store a `secret-entry` step's secret in the credential registry under its
 * id: the login keychain on macOS (`keychainStore` — the value reaches
 * `security` on stdin, never in argv), else a 0600 file in a 0700 directory.
 * Answers WHERE it went and the credential-probe id that proves it
 * (`keychain:SERVICE`, `file:PATH` — `credentials-probe.ts` knows both), and
 * never the value. There is deliberately no reader: nothing in this console
 * reads a stored secret back through any route or view.
 */
export async function storeStepSecret(
  opts: { dir: string; exec?: Exec; platform?: NodeJS.Platform },
  id: string,
  secret: string,
): Promise<{ stored: 'keychain' | 'file'; probe: string }> {
  if (!CREDENTIAL_ID_RE.test(id)) throw new Error('a credential id is a-z, 0-9, . _ - and at most 64 characters');
  if (!secret) throw new Error('an empty secret is not a secret');
  if (/[\r\n]/.test(secret)) throw new Error(SECRET_MUST_BE_ONE_LINE);
  if ((opts.platform ?? process.platform) === 'darwin') {
    const service = stepKeychainService(id);
    await keychainStore(opts.exec ?? realExec, service, secret);
    return { stored: 'keychain', probe: `keychain:${service}` };
  }
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dir, 0o700);
  const path = join(opts.dir, id);
  writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return { stored: 'file', probe: `file:${path}` };
}

/** Is a secret held under this id — yes or no, never the value. */
export function stepSecretHeldAsFile(dir: string, id: string): boolean {
  return CREDENTIAL_ID_RE.test(id) && existsSync(join(dir, id));
}

/* ------------------------------------------------------------------ *
 * The verbs' shapes (control-tower phase 43) — what the routes answer
 * ------------------------------------------------------------------ */

/**
 * One step as `GET /api/human-steps` answers it: the folded step, the moment
 * its window closes (`windowEnd`, seven days when it named none), its next
 * reminder, and its moves — each open, each check and what it read — so every
 * datum is on the card or one fold under it.
 */
export type StepView = HumanStep & { windowEnd: string; nextReminderAt: string | null; moves: StepMove[] };

/** The most steps a list answers, newest last, and the most moves one step shows. */
export const HUMAN_STEPS_LISTED = 200;
export const HUMAN_STEP_MOVES_SHOWN = 50;

/**
 * How long a step whose phase no longer names it may stand before the clock
 * withdraws it: long enough that the ledger line written a moment before the
 * park's own save is never mistaken for an orphan.
 */
export const STEP_WITHDRAW_GRACE_MS = 10 * 60_000;

export function stepViewOf(step: HumanStep, moves: readonly StepMove[], quiet?: ReminderQuiet | null): StepView {
  const next = nextReminderAt(step, { quiet: quiet ?? null });
  return {
    ...step,
    windowEnd: new Date(windowEndOf(step)).toISOString(),
    nextReminderAt: next === null ? null : new Date(next).toISOString(),
    moves: moves.slice(-HUMAN_STEP_MOVES_SHOWN),
  };
}

/** What a verb's route answers. A refusal carries its status and its sentence. */
export type StepVerbResult =
  | ({ ok: true; step?: StepView } & Record<string, unknown>)
  | ({ ok: false; status: number; error: string } & Record<string, unknown>);

/** A move the ledger refused, as a route answers it. */
export function refusedMove(refusal: MoveRefusal): StepVerbResult {
  return refusal.refused === 'unknown-step'
    ? { ok: false, status: 404, error: 'no such step' }
    : { ok: false, status: 409, error: `a step that is ${refusal.from} cannot move to ${refusal.to}`, state: refusal.from };
}

/**
 * What a human step's embedded terminal runs (`$SHELL -ilc <this> <command>`):
 * the step's command printed in full, then run on the person's Enter — never
 * before — so the shell exits with the command's own code, which the exit hook
 * reads as the step's proof. The command rides as `$0`, an argument, and is
 * never spliced into the script.
 */
export const STEP_TERMINAL_SCRIPT = `printf '%s\\n\\n' "$0"; printf 'Press Enter to run it, or Ctrl-C to stop. '; read -r _ && eval "$0"`;
