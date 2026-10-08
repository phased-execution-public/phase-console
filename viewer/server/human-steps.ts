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
 * open by itself), a link that is not http(s) is dropped, and NO secret is
 * stored anywhere (control-tower phase 133, #210): a `secret-entry` item says
 * where its value goes (`secretWhere`) and is proven by presence by name
 * (`secretPresenceRef`) — the console never takes the value, and nothing in
 * this module reads one.
 *
 * The verbs that move a step (control-tower phase 43) — open, open again,
 * check, snooze, cannot, dismiss — and the owner's moves of phase 133 —
 * answer, decline — all go through `HumanStepLedger.move`; a question and a
 * piece of evidence (`ask`, `attach`) are lines that move no state
 * (`HumanStepLedger.record`). Each move line names its `verb`
 * (`HUMAN_STEP_MOVES`), so the fold can count
 * each move line names its `verb` (`HUMAN_STEP_MOVES`), so the fold can count
 * opens, checks and reminders, and the reminder clock (`tickHumanSteps`) can
 * resume its series across a restart. What the clock does: re-announce an open
 * step at +15 m, +1 h, +6 h, then daily (`REMINDER_SERIES_MS`), never while
 * every device that would hear it is inside its own quiet hours (the ONE
 * quiet-hours setting since control-tower phase 138) and never before a
 * snooze ends; expire it at its
 * window's end (seven days when it names none) into an errand; withdraw it
 * when its phase has closed. A step's proof is a WATCH ref (`stepProofOf`):
 * the watch scheduler polls it on phase 6's `cmd:` back-off, bounded by the
 * step's window and never by a wait budget, and a landing proves the step.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { log } from './log.ts';
import {
  CREDENTIAL_ID_RE, DEVICE_CODE_RE, HUMAN_STEP_DEFAULT_WINDOW_MS, HUMAN_STEP_MOVES, HUMAN_STEP_OPEN_STATES,
  HUMAN_STEP_STATES, HUMAN_STEP_STILL_MOVES, HUMAN_STEP_WHERE, KIND_META, REMINDER_SERIES_MS,
  canTransition, dueRefOk, humanStepKindOf, isOpenableUrl, looksLikeSecret, redactSecrets,
  type HumanStepBirth, type HumanStepKind, type HumanStepMove, type HumanStepState, type HumanStepWhere,
} from '../shared/human-step-model.js';
import {
  GRANT_SCOPES, PROOF_TYPES, RISK_TIERS, RULE_FAMILIES, WALLS, WHY_PERSON, defaultReason, inferProofType, reasonAllowed,
  type GrantScope, type ProofType, type Wall, type WhyPerson,
} from '../shared/turn-model.js';
import type { PermissionDetail, TodayGrant } from './permissions/walls.ts';
import { parseGuide, renderGuide, type Guide } from '../shared/guide-grammar.js';
import { DECISION_KEYS } from '../shared/decisions-model.js';
import { guardStep, refusalFields, type CommandJudge, type GuardRefusal } from './turn/guard.ts';
import type { PhaseRecord } from './runner/state.ts';
import type { WaitAuthor } from './runner/wait-budget.ts';
import type { StepVerdict } from './turn/verdict.ts';

/** The ledger's file name, under the instance's state directory. */
export const HUMAN_STEPS_FILE = 'human-steps.ndjson';

/**
 * The line version this writer stamps (control-tower phase 130: the record of
 * Your turn — a reason, a guide, a proof in words, the waiters). A version-1
 * line, written before it, still reads: as a version-2 item with defaults
 * (`withTurnDefaults`), and never as an error.
 */
export const HUMAN_STEP_LINE_VERSION = 2;

/** Every line version the reader accepts. */
export const HUMAN_STEP_LINE_VERSIONS: readonly number[] = Object.freeze([1, 2]);

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
  /** The watch ref the step is `upcoming` until (control-tower phase 121). */
  due_when?: string;
  /** Your turn (control-tower phase 130): why only a person fits it, and where that came from. */
  why?: string;
  why_source?: 'declared' | 'inferred';
  /** The guide, as `--guide` read it: its text and language, parsed by `guide-grammar.js` here. */
  guide?: { text?: string; lang?: string } | string;
  effort?: number;
  unblocks?: (number | string)[];
  proof_type?: string;
  proof_words?: string;
  options?: { id: string; label: string; consequence?: string }[];
  recommended?: string;
  allow_decline?: boolean;
  /** The `## Decisions` key this decision answers (control-tower phase 133) — its answer goes to the plan's twin. */
  decision_key?: string;
  window_minutes?: number;
  tried?: string;
};

/** One session this item unblocks — the item's own first, then every lane that met the same wall (G7). */
export type StepWaiter = { slug: string; phase: number; runId?: string; sessionId?: string };

/** A decision's option: what it is called, and what choosing it does. */
export type StepOption = { id: string; label: string; consequence?: string; recommended?: true };

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
  /**
   * The watch ref an `upcoming` step waits on before it is due (control-tower
   * phase 121, #182) — `phase-outcome.sh --due-when`, a plan bullet's `due:`.
   */
  dueWhen?: string;
  /** When its due-when ref landed and it became `declared`. */
  dueAt?: string;
  /** An upcoming step's window, in minutes — it starts at `dueAt`, not at the birth. */
  windowMinutes?: number;
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
  /* ---- Your turn (control-tower phase 130, #207) — v2 fields; a v1 line reads them as defaults ---- */
  /** Why only a person fits it — ALWAYS on the record; `inferred` when the kind's default was taken. */
  why: WhyPerson;
  whySource: 'declared' | 'inferred';
  /** The full guide, parsed by the one grammar. */
  guide?: Guide;
  /** How many minutes it takes the person. */
  effortMin?: number;
  /** The phases it unblocks. */
  unblocks?: { slug: string; phase: number }[];
  /** How it is proven, and where that came from. */
  proofType: ProofType;
  proofTypeSource?: 'declared' | 'inferred';
  /** The proof in words a person can read. */
  proofWords?: string;
  /** A decision's options, one recommended, and whether the person may decline. */
  options?: StepOption[];
  allowDecline?: boolean;
  /** How many times the person said *I've done this — check*. */
  attempts: number;
  /** Every session this one item unblocks (G7: the same wall met again is another waiter, never another item). */
  waiters: StepWaiter[];
  /** What raised it. */
  source?: { kind: string; ref?: string };
  /** What the session tried before asking, and whether that overruled the guard's G4. */
  tried?: string;
  overruled?: true;
  /**
   * A permission item: the wall the AI met, the rule, the command — and, for
   * one the console raised from a recorded wall (control-tower phase 135), the
   * tool, why it was needed, the rule family, the risk tier, the scopes a grant
   * may be offered at (none for `never`, with why and the manual path) and what
   * Grant does today.
   */
  permission?: { wall: Wall; rule?: string; command?: string } & Partial<Omit<PermissionDetail, 'wall' | 'rule' | 'command'>>;
  /* ---- The owner's moves (control-tower phase 133, #210) ---- */
  /** The `## Decisions` key a decision answers: its answer is written to the plan's twin (`decisions.sh`) first. */
  decisionKey?: string;
  /** A decision's answer — an option of the item, a note, or both — and the door it came through. */
  answer?: StepAnswer;
  /** The questions a person asked about it, oldest first — handed to the raising session with its next resume. */
  question?: StepQuestion[];
  /** What a person attached, by content hash — the bytes live in `turn-evidence/`, never here. */
  evidence?: StepEvidence[];
  /* ---- The check (control-tower phase 134, #211) ---- */
  /** The last check's verdict — a probe's, the checker's or the owner's. */
  verdict?: StepVerdict;
  /** Every verdict the item was given, oldest first — one per attempt, side by side once it escalates. */
  verdicts?: StepVerdict[];
  /** When its rejections escalated it to the owner — ONCE. */
  escalatedAt?: string;
};

/** A decision's answer, as the ledger keeps it — the option's label beside its id, the note redacted. */
export type StepAnswer = { option?: string; label?: string; note?: string; at: string; by?: string; door?: string };

/** One question a person asked about an item. */
export type StepQuestion = { at: string; text: string; by?: string; door?: string };

/** One piece of evidence: what it is, where its bytes are (`sha256:<hex>`), and which attempt it belongs to. */
export type StepEvidence = {
  attempt: number; kind: 'note' | 'image' | 'file'; ref: string; bytes: number; mime: string; name?: string; at: string; by?: string;
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
  /** `due`: the window it now has, starting at the due moment. */
  until?: string;
  /** `wait` (G7): the session that met the same wall again. */
  waiter?: StepWaiter;
  /** `answer` (phase 133): the decision's answer. */
  answer?: StepAnswer;
  /** `ask`: the question. */
  question?: StepQuestion;
  /** `attach`: the evidence's record — never its bytes. */
  evidence?: StepEvidence;
  /** The check (phase 134): the verdict this move carries — `return`, `prove` or `override`. */
  verdict?: StepVerdict;
  /** This rejection escalated the item to the owner (phase 134) — written once. */
  escalated?: true;
  /** `return` (phase 134): what the proof read — the card says it, as it did before a check sent anything back. */
  read?: string;
};

/** One line of a step's history, as `history` answers it — the datums a card shows. */
export type StepMove = {
  state: HumanStepState; verb: HumanStepMove; at: string;
  by?: string; note?: string; where?: MoveLine['where']; pushed?: boolean; snoozeUntil?: string;
  /** The verdict the move carried (phase 134). */
  verdict?: StepVerdict;
};

/** The verb a move line was made by — its own word, else the one its state implies (a phase-41 line). */
function moveVerbOf(move: Partial<MoveLine>, state: HumanStepState): HumanStepMove {
  if (typeof move.verb === 'string' && (HUMAN_STEP_MOVES as readonly string[]).includes(move.verb)) return move.verb;
  switch (state) {
    case 'returned': return 'return';
    case 'declined': return 'decline';
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
    case 'override':
      if (typeof move.note === 'string') next.read = move.note;
      if (move.by) next.provenBy = move.by;
      break;
    case 'snooze': if (move.snoozeUntil) next.snoozeUntil = move.snoozeUntil; break;
    case 'due': next.dueAt = move.at; if (move.until) next.until = move.until; break;
    case 'wait':
      if (move.waiter && !next.waiters.some((w) => sameWaiter(w, move.waiter!))) next.waiters = [...next.waiters, move.waiter];
      break;
    case 'answer': if (move.answer) next.answer = move.answer; break;
    case 'return': if (typeof move.read === 'string') next.read = move.read; break;
    case 'ask': if (move.question) next.question = [...(known.question ?? []), move.question]; break;
    case 'attach': if (move.evidence) next.evidence = [...(known.evidence ?? []), move.evidence]; break;
    default: break;
  }
  if (verb === 'check' && state === 'checking') next.attempts = (known.attempts ?? 0) + 1;
  // The check (phase 134): a verdict rides its move — kept as the item's last
  // and appended to its history, one per attempt.
  if (move.verdict && typeof move.verdict === 'object' && typeof move.verdict.state === 'string') {
    next.verdict = move.verdict;
    next.verdicts = [...(known.verdicts ?? []), move.verdict];
  }
  if (move.escalated === true) next.escalatedAt ??= move.at;
  return next;
}

/**
 * The lanes waiting on a step beside its own (G7): each as the slug, phase and
 * run its record parks under, so a proof or a settle reaches every one.
 */
export function otherWaiters(step: Pick<HumanStep, 'slug' | 'phase' | 'runId' | 'waiters'>): { slug: string; phase: number; runId?: string }[] {
  const own: StepWaiter = { slug: step.slug, phase: step.phase, ...(step.runId ? { runId: step.runId } : {}) };
  return (step.waiters ?? [])
    .filter((w) => !sameWaiter(w, own))
    .map((w) => ({ slug: w.slug, phase: w.phase, ...(w.runId ? { runId: w.runId } : {}) }));
}

/** Two waiters are one when they are the same lane — the same plan, phase and run. */
function sameWaiter(a: StepWaiter, b: StepWaiter): boolean {
  return a.slug === b.slug && a.phase === b.phase && (a.runId ?? '') === (b.runId ?? '');
}

/**
 * A born line as a version-2 item: every field phase 130 added, given the
 * default a line written before it implies — the kind's reason (inferred), a
 * proof type read from what it carries (`attest` — a person's *I did it* —
 * when it carries none), no attempts, and the step's own lane as its one waiter.
 */
export function withTurnDefaults(step: HumanStep): HumanStep {
  const why = (WHY_PERSON as readonly string[]).includes(step.why) && reasonAllowed(step.kind, step.why)
    ? step.why : defaultReason(step.kind);
  const proofType = (PROOF_TYPES as readonly string[]).includes(step.proofType)
    ? step.proofType
    : inferProofType(step) ?? 'attest';
  const own: StepWaiter = {
    slug: step.slug, phase: step.phase,
    ...(step.runId ? { runId: step.runId } : {}), ...(step.sessionId ? { sessionId: step.sessionId } : {}),
  };
  return {
    ...step,
    why,
    whySource: why === step.why && step.whySource === 'declared' ? 'declared' : 'inferred',
    proofType,
    ...(proofType === step.proofType ? {} : { proofTypeSource: 'inferred' as const }),
    attempts: typeof step.attempts === 'number' ? step.attempts : 0,
    waiters: Array.isArray(step.waiters) && step.waiters.length ? step.waiters : [own],
  };
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
  step: Omit<HumanStep, 'id' | 'state' | 'at' | 'declaredAt' | 'opened' | 'slug' | 'phase' | 'birth' | 'attempts' | 'waiters'> & {
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
  // G1 at the ledger's own door: a reason the kind allows, else its default —
  // marked inferred, so the page can say so (control-tower phase 130).
  const whyWord = typeof input.why === 'string' ? input.why.trim().toLowerCase() : '';
  const why: WhyPerson = whyWord && reasonAllowed(kind, whyWord) ? (whyWord as WhyPerson) : defaultReason(kind);
  if (whyWord && why !== whyWord) dropped.push('why');
  const whySource = why === whyWord && (input.why_source ?? input.whySource) !== 'inferred' ? 'declared' : 'inferred';
  const proofWords = text(input.proof_words ?? input.proofWords, PROOF_MAX);
  const typeWord = String(input.proof_type ?? input.proofType ?? '').trim().toLowerCase();
  const declaredType = (PROOF_TYPES as readonly string[]).includes(typeWord) ? (typeWord as ProofType) : null;
  if (typeWord && !declaredType) dropped.push('proof_type');
  const proofText = text(input.proof, PROOF_MAX);
  const proofType: ProofType = declaredType ?? inferProofType({ kind, proof: proofText, proofWords }) ?? 'attest';
  const step: CleanStep['step'] = {
    kind, title, where, why, whySource, proofType,
    ...(declaredType ? {} : { proofTypeSource: 'inferred' as const }),
    ...(proofWords ? { proofWords } : {}),
  };

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
  // The moment it becomes due (control-tower phase 121): a watch ref, by its
  // scheme — anything else would leave the step upcoming for ever.
  const due = text(input.due_when ?? input.dueWhen, PROOF_MAX);
  if (due !== undefined) {
    if (dueRefOk(due)) step.dueWhen = due;
    else dropped.push('due_when');
  }
  // The rest of Your turn's record (control-tower phase 130).
  const guide = guideOf(input.guide);
  if (guide) step.guide = guide;
  else if (input.guide !== undefined) dropped.push('guide');
  const effort = Number(input.effort ?? input.effortMin);
  if (Number.isFinite(effort) && effort > 0) step.effortMin = Math.min(Math.round(effort), 7 * 24 * 60);
  const unblocks = unblocksOf(input.unblocks);
  if (unblocks.length) step.unblocks = unblocks;
  const options = optionsOf(input.options, input.recommended);
  if (options.length) step.options = options;
  if ((input.allow_decline ?? input.allowDecline) === true) step.allowDecline = true;
  // The manifest key a decision answers (control-tower phase 133): named only
  // by a declaration that says so, never inferred from `--needs`, whose words
  // are policies (`ambiguity: ruling`) an answer to one question must not
  // overwrite.
  const decisionKey = input.decision_key ?? input.decisionKey;
  if (decisionKey !== undefined) {
    if (typeof decisionKey === 'string' && (DECISION_KEYS as readonly string[]).includes(decisionKey.trim())) step.decisionKey = decisionKey.trim();
    else dropped.push('decision_key');
  }
  const tried = text(input.tried, LINE_MAX * 2);
  if (tried) step.tried = tried;
  // What raised an item the CONSOLE raises (control-tower phase 132, #209) — an
  // errand, a preflight, the relay — so a second raise of the same source is
  // the same item (`turn/index.ts` `raiseTurn`). Never a session's or a plan's
  // word: theirs is their birth.
  if (input.source !== undefined) {
    const source = (input.source ?? {}) as Record<string, unknown>;
    const kind = typeof source.kind === 'string' && /^[a-z][a-z-]{0,31}$/.test(source.kind) ? source.kind : '';
    const ref = text(source.ref, PROOF_MAX);
    if ((birth === 'console' || birth === 'supervisor') && kind) step.source = { kind, ...(ref ? { ref } : {}) };
    else dropped.push('source');
  }
  // A wall the CONSOLE recorded (control-tower phase 135): only its own raise
  // carries the permission record — a session's words name a wall, they never
  // write one (G5 holds the declaration to what was recorded).
  if (input.permission !== undefined) {
    const permission = birth === 'console' && kind === 'permission' ? permissionOf(input.permission) : null;
    if (permission) step.permission = permission;
    else dropped.push('permission');
  }
  return { step, dropped };
}

/** A permission record held to its shape — known words only, every string bounded and redacted. */
function permissionOf(raw: unknown): HumanStep['permission'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const wall = typeof input.wall === 'string' && (WALLS as readonly string[]).includes(input.wall) ? (input.wall as Wall) : null;
  if (!wall) return null;
  const words = <T extends string>(value: unknown, list: readonly T[]): T | undefined =>
    typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined;
  const family = words(input.family, RULE_FAMILIES);
  const risk = words(input.risk, RISK_TIERS);
  const scopes = Array.isArray(input.scopes) ? input.scopes.filter((s): s is GrantScope => (GRANT_SCOPES as readonly string[]).includes(s)) : [];
  const never = input.never && typeof input.never === 'object' ? input.never as Record<string, unknown> : null;
  const grant = input.grant && typeof input.grant === 'object' ? input.grant as Record<string, unknown> : null;
  const grantEffect = grant && (['broker', 'strike', 'capability'] as const).find((effect) => effect === grant.effect);
  const grantLabel = grant ? text(grant.label, LINE_MAX) : undefined;
  const approvalId = grant && typeof grant.approvalId === 'string' && /^[\w-]{1,64}$/.test(grant.approvalId) ? grant.approvalId : undefined;
  const source = words(input.source, ['hook', 'cli', 'landing', 'preflight', 'broker'] as const);
  const at = typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? input.at : undefined;
  return {
    wall,
    ...(text(input.tool, 120) ? { tool: text(input.tool, 120)! } : {}),
    ...(text(input.rule, LINE_MAX) ? { rule: text(input.rule, LINE_MAX)! } : {}),
    ...(text(input.command, COMMAND_MAX) ? { command: text(input.command, COMMAND_MAX)! } : {}),
    ...(text(input.need, LINE_MAX) ? { need: text(input.need, LINE_MAX)! } : {}),
    ...(family ? { family } : {}),
    ...(risk ? { risk } : {}),
    scopes,
    ...(never && text(never.why, LINE_MAX) && text(never.manual, LINE_MAX)
      ? { never: { why: text(never.why, LINE_MAX)!, manual: text(never.manual, LINE_MAX)! } } : {}),
    ...(grantEffect && grantLabel && (grantEffect === 'capability' || approvalId)
      ? { grant: (grantEffect === 'capability' ? { effect: grantEffect, label: grantLabel } : { effect: grantEffect, label: grantLabel, approvalId: approvalId! }) as TodayGrant }
      : {}),
    ...(text(input.ownRule ?? input.own_rule, LINE_MAX) ? { ownRule: text(input.ownRule ?? input.own_rule, LINE_MAX)! } : {}),
    ...(source ? { source } : {}),
    ...(at ? { at } : {}),
  };
}

/** A guide, read by the one grammar — a declaration's `{text, lang}`, bare text, or a parsed guide written again. */
function guideOf(raw: unknown): Guide | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const read = parseGuide(raw);
    return read.ok ? read.guide : undefined;
  }
  if (typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.text === 'string') {
    const read = parseGuide(value.text, { lang: value.lang });
    return read.ok ? read.guide : undefined;
  }
  if (Array.isArray(value.steps)) {
    try {
      const read = parseGuide(renderGuide(value as unknown as Guide), { lang: value.lang });
      return read.ok ? read.guide : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `unblocks` — phase numbers, or `slug/N` — as `{slug, phase}`; the slug is filled in by the declarer. */
function unblocksOf(raw: unknown): { slug: string; phase: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { slug: string; phase: number }[] = [];
  for (const item of raw.slice(0, 20)) {
    const m = /^(?:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/)?0*([1-9][0-9]{0,4})$/.exec(String(item).trim());
    if (m) out.push({ slug: m[1] ?? '', phase: Number(m[2]) });
  }
  return out;
}

/** A decision's options, each id once, one recommended at most. */
function optionsOf(raw: unknown, recommended: unknown): StepOption[] {
  if (!Array.isArray(raw)) return [];
  const out: StepOption[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(o.id) ? o.id : '';
    const label = text(o.label, 120);
    if (!id || !label || out.some((x) => x.id === id)) continue;
    const consequence = text(o.consequence, LINE_MAX);
    out.push({ id, label, ...(consequence ? { consequence } : {}), ...(id === recommended ? { recommended: true as const } : {}) });
  }
  return out;
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
      if (!HUMAN_STEP_LINE_VERSIONS.includes(parsed.v as number) || !id || !(HUMAN_STEP_STATES as readonly string[]).includes(state)) {
        skipped++;
        continue;
      }
      const known = steps.get(id);
      if (!known) {
        // A step is born `declared`, or `upcoming` when it waits on a due-when
        // ref (control-tower phase 121).
        if ((state !== 'declared' && state !== 'upcoming') || !humanStepKindOf(parsed.kind)) { skipped++; continue; }
        const { v: _v, ...rest } = parsed;
        const step = rest as unknown as HumanStep;
        steps.set(id, withTurnDefaults({ ...step, opened: typeof step.opened === 'number' ? step.opened : 0 }));
        continue;
      }
      const move = parsed as unknown as MoveLine;
      // A waiter (G7), a question and a piece of evidence (phase 133) move no
      // state: each is accepted only at the state the step is already in.
      // A still line naming another state is torn history, never a move.
      const still = (HUMAN_STEP_STILL_MOVES as readonly string[]).includes(String(move.verb));
      if (still ? state !== known.state : !canTransition(known.state, state)) { skipped++; continue; }
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
          ...(move.verdict ? { verdict: move.verdict } : {}),
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
  verb?: HumanStepMove; where?: MoveLine['where']; snoozeUntil?: string; until?: string;
  /** `answer` (phase 133) — the decision's answer, already shaped by the verb. */
  answer?: StepAnswer;
  /** The check (phase 134) — a verdict already shaped by `shapeVerdict`, whether it escalated, and what the proof read. */
  verdict?: StepVerdict;
  escalated?: true;
  read?: string;
};

/**
 * The key two declarations of ONE item share (G7): a permission item by its
 * wall, rule and command; any other by its kind and what it opens — the
 * command, the link or the credential, else its title.
 */
export function turnKey(step: Pick<HumanStep, 'kind' | 'title'> & Partial<Pick<HumanStep, 'openCommand' | 'openUrl' | 'credential' | 'permission'>>): string {
  if (step.kind === 'permission' && step.permission) {
    return ['permission', step.permission.wall, step.permission.rule ?? '', step.permission.command ?? ''].join('\u0000');
  }
  const what = step.openCommand ?? step.openUrl ?? step.credential ?? step.title.trim().toLowerCase();
  return [step.kind, what.replace(/\s+/g, ' ').trim()].join('\u0000');
}

/** Is this step still open — one of the states short of settled (an `upcoming` one included)? */
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

  /** The ledger's own clock — what every line it writes is stamped with. */
  clock(): Date {
    return this.now();
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

  /**
   * Write a new step, state `declared` — or `upcoming` when it names a
   * due-when ref (control-tower phase 121): its window then starts when it is
   * due, so the minutes are kept rather than turned into a clock now.
   */
  declare(input: {
    slug: string; phase: number; birth: HumanStepBirth; runId?: string; sessionId?: string; clean: CleanStep['step'];
  }): HumanStep {
    const declaredAt = this.now().toISOString();
    const { windowMinutes, ...fields } = input.clean;
    const id = stepIdFor({ slug: input.slug, phase: input.phase, declaredAt, kind: fields.kind, title: fields.title });
    const upcoming = Boolean(fields.dueWhen);
    const until = windowMinutes && !upcoming ? new Date(Date.parse(declaredAt) + windowMinutes * 60_000).toISOString() : undefined;
    const own: StepWaiter = {
      slug: input.slug, phase: input.phase,
      ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    const step: HumanStep = {
      id, ...fields, birth: input.birth, slug: input.slug, phase: input.phase,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(until ? { until } : {}),
      ...(upcoming && windowMinutes ? { windowMinutes } : {}),
      ...(fields.unblocks ? { unblocks: fields.unblocks.map((u) => ({ slug: u.slug || input.slug, phase: u.phase })) } : {}),
      source: fields.source ?? { kind: input.birth === 'session' ? 'declaration' : input.birth === 'plan' ? 'plan-bullet' : input.birth },
      attempts: 0, waiters: [own],
      state: upcoming ? 'upcoming' : 'declared', declaredAt, at: declaredAt, opened: 0,
    };
    this.append({ v: HUMAN_STEP_LINE_VERSION, ...step });
    this.changed(step);
    return step;
  }

  /**
   * Another lane met the same wall (G7): ONE item, another waiter — a `wait`
   * line that moves no state. A waiter already on the item is no news.
   */
  addWaiter(id: string, waiter: StepWaiter): HumanStep | MoveRefusal {
    const step = this.get(id);
    if (!step) return { refused: 'unknown-step', to: 'notified' };
    if (!isOpenStep(step)) return { refused: 'transition', from: step.state, to: step.state };
    if (step.waiters.some((w) => sameWaiter(w, waiter))) return step;
    this.append({ v: HUMAN_STEP_LINE_VERSION, id, state: step.state, at: this.now().toISOString(), verb: 'wait', by: 'console', waiter });
    const moved = this.get(id)!;
    this.changed(moved);
    return moved;
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
      ...(extra.until ? { until: extra.until } : {}),
      ...(extra.answer ? { answer: extra.answer } : {}),
      ...(extra.verdict ? { verdict: extra.verdict } : {}),
      ...(extra.escalated ? { escalated: true as const } : {}),
      ...(extra.read ? { read: redactSecrets(extra.read.replace(/[\u0000-\u001f]+/g, ' ')).slice(0, 280) } : {}),
    };
    this.append(line);
    const moved = this.get(id)!;
    this.changed(moved);
    return moved;
  }

  /**
   * A line that moves NO state (control-tower phase 133): a person's question
   * about an open item, or the record of a piece of evidence they attached —
   * never its bytes, which live by content hash in `turn-evidence/`. Refused
   * on a step that is not open, exactly as a move out of a settled state is.
   */
  record(
    id: string,
    verb: 'ask' | 'attach',
    extra: { by?: string; question?: StepQuestion; evidence?: StepEvidence },
  ): HumanStep | MoveRefusal {
    const step = this.get(id);
    if (!step) return { refused: 'unknown-step', to: 'notified' };
    if (!isOpenStep(step)) return { refused: 'transition', from: step.state, to: step.state };
    this.append({
      v: HUMAN_STEP_LINE_VERSION, id, state: step.state, at: this.now().toISOString(), verb,
      ...(extra.by ? { by: redactSecrets(extra.by).slice(0, 80) } : {}),
      ...(verb === 'ask' && extra.question ? { question: extra.question } : {}),
      ...(verb === 'attach' && extra.evidence ? { evidence: extra.evidence } : {}),
    });
    const recorded = this.get(id)!;
    this.changed(recorded);
    return recorded;
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
  /**
   * The declaring run's own policy, one command at a time (control-tower phase
   * 130): what the guard's G4 asks "could the AI have run this itself?". Absent
   * means it cannot be asked, and G4 never refuses on a guess.
   */
  judge?: CommandJudge | null;
};

/** A declaration the guard refused at ingest — no item was raised (control-tower phase 130). */
export type TurnRefused = { refused: GuardRefusal };

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
): HumanStep | TurnRefused | null {
  const clean = sanitiseStep(input.step, input.birth);
  if (!clean) return null;
  // The guard, again, at ingest (control-tower phase 130): a session's
  // declaration is held to G1, G2 and G4 whether or not its pre-check ran — a
  // file an older script wrote, or one written while no console answered.
  if (input.birth === 'session') {
    const raw = (input.step ?? {}) as Record<string, unknown>;
    const verdict = guardStep({
      kind: clean.step.kind, title: clean.step.title,
      ...(typeof raw.why === 'string' && raw.why_source !== 'inferred' ? { why: raw.why } : {}),
      ...(typeof raw.proof_type === 'string' ? { proofType: raw.proof_type } : {}),
      ...(clean.step.proof ? { proof: clean.step.proof } : {}),
      ...(clean.step.proofWords ? { proofWords: clean.step.proofWords } : {}),
      guide: clean.step.guide ?? null,
      ...(clean.step.openCommand ? { openCommand: clean.step.openCommand } : {}),
      ...(clean.step.tried ? { tried: clean.step.tried } : {}),
    }, { stage: 'ingest', judge: input.judge ?? null });
    if (!verdict.ok) {
      log.warn('turn.guard-refused', { slug: input.slug, phase: input.phase, kind: clean.step.kind, ...refusalFields(verdict) });
      return { refused: verdict };
    }
    clean.step.why = verdict.why;
    clean.step.whySource = verdict.whySource;
    if (verdict.overruled) clean.step.overruled = true;
    if (verdict.reshape) {
      clean.step.kind = 'permission';
      clean.step.why = 'permission';
      clean.step.proofType = 'grant';
      clean.step.where = KIND_META.permission.where;
      clean.step.permission = {
        wall: verdict.reshape.wall, command: verdict.reshape.command,
        ...(verdict.reshape.rule ? { rule: verdict.reshape.rule } : {}),
      };
    }
  }
  // G7 — the same wall met again by ANOTHER lane of the SAME plan is one item
  // with another waiter. A session's wall only: a plan's bullets are asked
  // phase by phase at the launch door, each withdrawn when its own phase
  // closes. Never across plans: a proof, a check or (from phase 149) a grant
  // made for one plan's item must not resume, or answer for, another plan.
  const key = turnKey(clean.step);
  const twin = input.birth !== 'session' ? undefined : deps.ledger.open().find((open) =>
    open.birth === 'session' && open.slug === input.slug && open.phase !== input.phase && turnKey(open) === key);
  if (twin) {
    const waited = deps.ledger.addWaiter(twin.id, {
      slug: input.slug, phase: input.phase,
      ...(input.runId ? { runId: input.runId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    log.info('turn.waiter-added', { id: twin.id, kind: twin.kind, slug: input.slug, phase: input.phase });
    return 'refused' in waited ? twin : waited;
  }
  const declared = deps.ledger.declare({
    slug: input.slug, phase: input.phase, birth: input.birth, clean: clean.step,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  if (clean.dropped.length) {
    log.warn('human-steps.fields-dropped', { id: declared.id, kind: declared.kind, birth: input.birth, dropped: clean.dropped });
  }
  // Born before it is due (control-tower phase 121): shown as *Coming up*,
  // told to nobody. Its ONE push waits for its due-when ref (`dueHumanStep`).
  if (declared.state === 'upcoming') {
    log.info('human-steps.declared', {
      id: declared.id, kind: declared.kind, where: declared.where, birth: input.birth,
      slug: input.slug, phase: input.phase, pushed: false, upcoming: true,
    });
    return declared;
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
 * An `upcoming` step's due-when ref has LANDED (control-tower phase 121, #182):
 * the step is `declared` — its window starts now — then announced ONCE, then
 * `notified`, exactly the road a step born due takes. A step that is not
 * upcoming is refused (`transition`): an act is due once, and a second landing
 * of the same ref is no news.
 */
export function dueHumanStep(
  deps: { ledger: HumanStepLedger; announce: (step: HumanStep) => boolean },
  id: string,
  opts: { ref: string; detail?: string },
): HumanStep | MoveRefusal {
  const step = deps.ledger.get(id);
  if (!step) return { refused: 'unknown-step', to: 'declared' };
  if (step.state !== 'upcoming') return { refused: 'transition', from: step.state, to: 'declared' };
  const at = deps.ledger.clock().getTime();
  const due = deps.ledger.move(id, 'declared', {
    by: 'console', verb: 'due',
    note: `due — ${opts.ref} landed${opts.detail ? `: ${opts.detail}` : ''}`,
    ...(step.windowMinutes ? { until: new Date(at + step.windowMinutes * 60_000).toISOString() } : {}),
  });
  if ('refused' in due) return due;
  let pushed = false;
  try {
    pushed = deps.announce(due);
  } catch (error) {
    log.warn('human-steps.announce-failed', { id, error: (error as Error)?.message ?? String(error) });
  }
  const moved = deps.ledger.move(id, 'notified', { by: 'console', pushed, verb: 'notify' });
  log.info('human-steps.due', { id, kind: step.kind, slug: step.slug, phase: step.phase, ref: opts.ref, pushed });
  return 'refused' in moved ? due : moved;
}

/**
 * The fields a journal line about a step carries — ids and words, the title
 * redacted like everything in the ledger, and never a code or a secret.
 */
export function stepJournalFields(step: HumanStep): Record<string, unknown> {
  return {
    stepId: step.id, kind: step.kind, where: step.where, birth: step.birth, state: step.state,
    title: step.title, ...(step.proof ? { proof: step.proof } : {}), ...(step.until ? { until: step.until } : {}),
    why: step.why, whySource: step.whySource, proofType: step.proofType,
    ...(step.waiters.length > 1 ? { waiters: step.waiters.length } : {}),
    ...(step.overruled ? { overruled: true } : {}),
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

/**
 * When a step's window closes: its own `until`, else seven days after it
 * became due — `dueAt` for a step that was `upcoming` first, its declaration
 * for one born due.
 */
export function windowEndOf(step: Partial<Pick<HumanStep, 'until' | 'declaredAt' | 'dueAt'>>): number {
  const own = Date.parse(step.until ?? '');
  if (Number.isFinite(own)) return own;
  const declared = Date.parse(step.dueAt ?? step.declaredAt ?? '');
  return (Number.isFinite(declared) ? declared : Date.now()) + HUMAN_STEP_DEFAULT_WINDOW_MS;
}

/**
 * What a resumed session is told when its person's turn is proven — the
 * kind, the step's own words, the proof and what it read, and who saw it —
 * so it can carry on from what was proven rather than re-checking blind.
 */
export function provenDetail(
  step: Pick<HumanStep, 'kind' | 'title' | 'proof'> & Partial<Pick<HumanStep, 'verdict' | 'proofWords'>>, read: string | undefined, by: string,
): string {
  const who = by === 'watch' ? 'its proof landed on the console\'s watch'
    : by === 'terminal' ? 'its command exited 0 in the embedded terminal'
      : `checked by ${by}`;
  const verdict = step.verdict?.state === 'passed' ? step.verdict : undefined;
  // The check's own words (phase 134): what was proven, by whom, and what it read.
  // The owner's word: an override says so; an attest item was proven on a person's word.
  const checked = !verdict ? null
    : verdict.by === 'owner'
      ? verdict.note.startsWith('Accepted anyway')
        ? `; the owner accepted it anyway — nothing read a proof, so it is UNVERIFIED (${verdict.note})`
        : '; it named no proof, and a person said it is done (unverified)'
      : verdict.by === 'checker'
        ? `; the checking session read ${verdict.read.length ? verdict.read.join('; ') : 'what was submitted'} against `
          + `"${step.proofWords ?? step.title}" and passed it: ${verdict.note}`
        : null;
  return `a person's turn is PROVEN — ${KIND_META[step.kind].label}: "${step.title}"`
    + (checked ?? (step.proof ? `; proof ${step.proof}${read ? ` read: ${read}` : ''}`
      : verdict?.unverified ? '; it named no proof, and a person said it is done (unverified)'
        : '; it named no proof, and a person said it is done'))
    + ` (${who})`;
}

/** The instruction a session is resumed with when its step is proven — and what the person asked meanwhile. */
export function provenInstruction(
  step: Pick<HumanStep, 'kind' | 'title' | 'proof'> & Partial<Pick<HumanStep, 'question' | 'verdict' | 'proofWords'>>,
  read: string | undefined, by: string,
): string {
  return [
    `The person's turn this phase declared is done: ${provenDetail(step, read, by)}. `
      + 'Carry on from where you parked — re-run what the step unblocked, then take the phase to its exit '
      + 'criteria: verify, commit, and write the handoff — or declare the next honest outcome with phase-outcome.sh.',
    askedLines(step),
  ].filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ *
 * The road back (control-tower phase 133, #210) — what a waiting session
 * is told. A parked session has no stdin, so whatever the person answered
 * travels as ONE resume the console composes, in the operator's name.
 * ------------------------------------------------------------------ */

/** The most questions one resume hands over — the newest. */
export const QUESTIONS_HANDED = 10;

/**
 * The questions a person asked about an item (`ask`), as the raising
 * session's next resume hands them over (OM-7) — or nothing.
 */
export function askedLines(step: Partial<Pick<HumanStep, 'question'>>): string {
  const asked = (step.question ?? []).slice(-QUESTIONS_HANDED);
  if (!asked.length) return '';
  return [
    ...asked.map((q) => `The person asked: "${q.text}" (${q.at}).`),
    'Answer what they asked in your handoff (or in the next item you raise) — a person reads those; nothing else of yours reaches them.',
  ].join('\n');
}

/** A reason or a note as the middle of a sentence: one line, no closing stop of its own. */
function clause(words: string): string {
  return words.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/**
 * An answered decision — "The operator answered `<option>`: <note>" — with the
 * option's id and the consequence the session itself wrote for it.
 */
export function answeredInstruction(
  step: Pick<HumanStep, 'kind' | 'title'> & Partial<Pick<HumanStep, 'options' | 'question'>>, answer: StepAnswer,
): string {
  const option = answer.option ? (step.options ?? []).find((o) => o.id === answer.option) : undefined;
  const note = answer.note ? clause(answer.note) : '';
  const head = option
    ? `The operator answered \`${option.label}\`${note ? `: ${note}.` : '.'}`
    : `The operator answered: ${note}.`;
  return [
    head,
    `It answers what this phase asked a person to decide — "${step.title}"`
      + `${option ? ` — option ${option.id}${option.consequence ? `, whose consequence you wrote as: ${clause(option.consequence)}` : ''}` : ''}.`,
    'It is the operator\'s decision, not a suggestion: carry on with it, do not ask it again, and say in your handoff what you did with it.',
    askedLines(step),
  ].filter(Boolean).join('\n\n');
}

/** A declined item — "The operator declined: <reason>. Do not ask again; …". */
export function declinedInstruction(
  step: Pick<HumanStep, 'kind' | 'title'> & Partial<Pick<HumanStep, 'question'>>, reason: string,
): string {
  return [
    `The operator declined: ${clause(reason)}. Do not ask again; find another way inside the plan or say what remains.`,
    `What they declined: ${KIND_META[step.kind].label.toLowerCase()} — "${step.title}".`,
    askedLines(step),
  ].filter(Boolean).join('\n\n');
}

/**
 * A denied permission item (control-tower phase 135) — the waiting session is
 * told plainly that the permission is not coming, and what to do instead.
 */
export function deniedInstruction(
  step: Pick<HumanStep, 'kind' | 'title'> & Partial<Pick<HumanStep, 'question' | 'permission'>>, reason?: string | null,
): string {
  const permission = step.permission;
  const what = permission
    ? `${permission.rule ? `\`${permission.rule}\`` : 'the permission'}${permission.command ? ` to run \`${clause(permission.command).slice(0, 200)}\`` : ''}`
    : `"${step.title}"`;
  return [
    `The operator denied ${what}${reason?.trim() ? `: ${clause(reason)}` : ''}.`,
    'Denied — do not retry; find another way inside the plan or say what remains.',
    askedLines(step),
  ].filter(Boolean).join('\n\n');
}

/**
 * The escalation's *Rewrite the guide* (control-tower phase 134, #211): the
 * session that raised the item is resumed with every rejection side by side and
 * told to send a NEW version of it — the guide a person could not follow, or
 * the proof nobody could meet — rather than raise the same one again.
 */
export function rewriteGuideInstruction(
  step: Pick<HumanStep, 'kind' | 'title'> & Partial<Pick<HumanStep, 'verdicts' | 'proofWords' | 'question'>>,
): string {
  const history = (step.verdicts ?? []).filter((verdict) => verdict.state !== 'passed');
  return [
    `The operator could not get "${step.title}" (${KIND_META[step.kind].label.toLowerCase()}) past its check: `
      + `it came back ${history.length} time${history.length === 1 ? '' : 's'}${step.proofWords ? `, against the proof "${step.proofWords}"` : ''}.`,
    ...history.map((verdict) => `Attempt ${verdict.attempt} — ${verdict.state} by the ${verdict.by}: ${clause(verdict.note)}.`
      + `${verdict.redo.length ? ` Redo: ${verdict.redo.map(clause).join('; ')}.` : ''}`),
    'They asked you to rewrite it. Raise a NEW version of the item with phase-outcome.sh — a guide a person can follow '
      + 'step by step, and a proof that reads what they can actually show — or, if the plan can do without it, say so in '
      + 'your handoff. Do not raise the same item again unchanged.',
    askedLines(step),
  ].filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ *
 * The reminder clock (control-tower phase 43)
 * ------------------------------------------------------------------ */

/**
 * A quiet window a reminder waits out, `HH:MM` on the machine's local clock; a
 * window may cross midnight. Since control-tower phase 138 (#215) these are
 * the push devices' OWN quiet hours — ONE setting — and a reminder is handed
 * all of them (`Push.reminderWindows`): it waits while every device that would
 * hear it is inside its window.
 */
export type ReminderQuiet = { start: string; end: string };

/** One window, or every device's — a reminder waits only while all of them are quiet. */
export type ReminderQuietHours = ReminderQuiet | readonly ReminderQuiet[] | null | undefined;

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
 * never dropped: the person hears it when the window closes. Handed every
 * device's window (control-tower phase 138), it waits only while ALL of them
 * hold `at`, to the first one's end — the first device to wake hears it; an
 * empty list is no device to wait for.
 */
export function outsideQuiet(at: number, quiet: ReminderQuietHours, minuteOf: (ms: number) => number = localMinuteOf): number {
  if (!quiet) return at;
  if (Array.isArray(quiet)) {
    const ends = (quiet as readonly ReminderQuiet[]).map((one) => outsideQuiet(at, one, minuteOf));
    return ends.length && ends.every((end) => end !== at) ? Math.min(...ends) : at;
  }
  const window = quiet as ReminderQuiet;
  const start = quietMinutes(window.start);
  const end = quietMinutes(window.end);
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
 * snooze is a floor under it; quiet hours — the devices' own, since phase
 * 138 — defer it to the first one's end while every device is quiet.
 */
export function nextReminderAt(
  step: HumanStep, opts: { quiet?: ReminderQuietHours; minuteOf?: (ms: number) => number } = {},
): number | null {
  // An upcoming step is unreminded: nobody has been told of it yet.
  if (!isOpenStep(step) || step.state === 'upcoming') return null;
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
  /** The windows a reminder waits out — every device's own (control-tower phase 138). */
  quiet?: ReminderQuietHours;
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
    // Upcoming (control-tower phase 121): its window has not started and
    // nobody has been told — the due pass (`dueHumanStep`) is what moves it.
    if (step.state === 'upcoming') continue;
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
 * secret-entry — where the value goes, and the proof that it is there
 * ------------------------------------------------------------------ */

/** The keychain service a `secret-entry`'s value is kept under: `phase-console-<id>`. */
export function stepKeychainService(id: string): string {
  return `phase-console-${id}`;
}

/**
 * Where a `secret-entry` item's value goes, in words a person can act on, and
 * the `credential:` ref that proves it is there BY NAME (control-tower phase
 * 133, #210). The console never takes the value — not in a form, not in a
 * check's body — so it stores nothing and reads nothing back: the person puts
 * it in place themselves, and the check asks the place whether something is
 * held there (`credentials-probe.ts`, presence only). The item's own
 * `credential:` proof wins; a registry id is the keychain item
 * `phase-console-<id>` on macOS, else a 0600 file under the instance's
 * `secrets/`; a step with neither says where its command or its words do.
 */
export function secretPlace(
  step: Pick<HumanStep, 'credential' | 'proof' | 'openCommand'>,
  opts: { dir: string; platform?: NodeJS.Platform },
): { where: string; ref?: string } {
  const keychain = (service: string) =>
    `the login keychain, as the item \`${service}\` (\`security add-generic-password -U -s ${service} -a "$USER" -w\` asks for it)`;
  const proof = step.proof?.startsWith('credential:') ? step.proof : undefined;
  if (proof) {
    const id = proof.slice('credential:'.length);
    const where = id.startsWith('keychain:') ? keychain(id.slice('keychain:'.length))
      : id.startsWith('env:') ? `the environment variable \`${id.slice('env:'.length)}\` of the console's own process`
        : id.startsWith('file:') ? `the file \`${id.slice('file:'.length)}\` (mode 0600)`
          : id === 'gh' ? 'the gh CLI\'s own login (`gh auth login`)'
            : 'the claude CLI\'s own login (`claude auth login`)';
    return { where, ref: proof };
  }
  if (step.credential && CREDENTIAL_ID_RE.test(step.credential)) {
    if ((opts.platform ?? process.platform) === 'darwin') {
      const service = stepKeychainService(step.credential);
      return { where: keychain(service), ref: `credential:keychain:${service}` };
    }
    const path = join(opts.dir, step.credential);
    return { where: `the file \`${path}\` (mode 0600, in a 0700 directory)`, ref: `credential:file:${path}` };
  }
  if (step.openCommand) return { where: `where the item's command puts it: \`${step.openCommand}\`` };
  return { where: 'the place the item names — never this console' };
}

/**
 * Does a body offered to a verb carry a secret — a `secret` field at all, or a
 * string shaped like one (the screen every declaration passes)? A verb refuses
 * such a body whole, and the value is never echoed, logged or stored.
 */
export function bodyCarriesSecret(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body !== 'object') return false;
  if ('secret' in body) return true;
  return Object.values(body).some((value) => typeof value === 'string' && looksLikeSecret(value));
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
export type StepView = HumanStep & {
  windowEnd: string; nextReminderAt: string | null; moves: StepMove[];
  /** `secret-entry` (control-tower phase 133): where its value goes, in words — the console never takes it. */
  secretWhere?: string;
};

/** The most steps a list answers, newest last, and the most moves one step shows. */
export const HUMAN_STEPS_LISTED = 200;
export const HUMAN_STEP_MOVES_SHOWN = 50;

/**
 * How long a step whose phase no longer names it may stand before the clock
 * withdraws it: long enough that the ledger line written a moment before the
 * park's own save is never mistaken for an orphan.
 */
export const STEP_WITHDRAW_GRACE_MS = 10 * 60_000;

export function stepViewOf(step: HumanStep, moves: readonly StepMove[], quiet?: ReminderQuietHours): StepView {
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
