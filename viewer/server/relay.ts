/**
 * The relay — Tier 2 of the zero-touch design, and the ONE place the console
 * answers a question on a session's behalf (zero-touch-console phase 14;
 * sep-review chapter 13 §1.4, QRL-5, QRL-6, TRS-2).
 *
 * Tiers 0 and 1 answer what a plan and a policy can. What is left is a question
 * a session raises mid-run — `AskUserQuestion` — on a run whose manifest armed
 * the relay (`relay: last-resort`) at a CLI that can carry it. Phase 1 measured
 * the transport on CLI 2.1.270: the tool is offered only with a permission host
 * (spike S1), a `PreToolUse` `allow` + `updatedInput.answers` answers it (S1), a
 * `PermissionRequest` hook answers it the same way when the call reaches the
 * permission step and races the host (S2), and a `PreToolUse` `defer` keeps the
 * call across a `--resume` (S3). So a question reaches `relayQuestion` from
 * either hook, and everything that decides its answer is here:
 *
 *   1. the deny list, FIRST — the call's tool, or a denied command written into
 *      an option. A match never starts a window;
 *   2. an answer this console already gave for it — a deferred call the session
 *      resumed, or a question answered at boot — delivered at once;
 *   3. the exclusions, then the per-phase budget — `phase.question-unanswerable
 *      {reason}`, a `needs-human` park and ONE push, and the session told to
 *      hand off and declare rather than guess;
 *   4. one open question per lane — a second call waits for the first;
 *   5. the card — `phase.question-raised`, a `session-ask` push, 60 s in front
 *      of a person — answered at 55 s by the rule table, else the sole
 *      `(Recommended)` option, else the first. A person inside the window wins.
 *      Every answer is `phase.question-answered {by}` plus a ruling row.
 *
 * What the session is told when nobody answered is the runner's
 * (`RunnerControl.tellRelayAnswer`, in `frameQuestion`'s register): the answer,
 * the rule that chose it, that it is not a change to the phase, and to declare
 * `blocked --needs ambiguity` rather than ask again.
 *
 * `invariants.test.ts` holds this file to being the only one that picks an
 * answer (`pickAnswer(`) and the service to calling it from one place.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';
import {
  QUESTION_REASON_LABELS,
  RELAY_ANSWER_MS,
  RELAY_QUESTIONS_PER_PHASE,
  RELAY_WINDOW_MS,
  destructiveOption,
  pickAnswer,
  questionKey,
  type QuestionAnsweredBy,
  type QuestionUnanswerableReason,
  type RelayMechanism,
  type RelayRule,
} from '../shared/relay-model.js';
import {
  matchedDenyRule,
  type Approval,
  type Approvals,
  type AutopilotPolicy,
  type PermissionProfile,
  type QuestionAnswer,
  type QuestionItem,
  type RecoveryVerdict,
} from './runner/approvals.ts';
import type { HaltKind, RunState } from './runner/state.ts';

/** What a hook call carries that the relay reads. */
export type QuestionEnvelope = {
  mechanism: RelayMechanism;
  tool: string;
  input: unknown;
  /** `PreToolUse` bodies only (phase 1 measured none on `PermissionRequest`). */
  toolUseId?: string;
  sessionId?: string;
  cwd?: string;
  /** The run's effective policy, as the hook just classified the call under it. */
  policy: AutopilotPolicy;
  profile: PermissionProfile;
};

/** One answer as the reply carries it. */
export type RelayAnswer = { key: string; question: string; label: string; by: QuestionAnsweredBy; ruleId?: string };

export type RelayReply =
  /** Every question answered: `allow` with `updatedInput` (`questions` echoed, `answers` keyed by question text). */
  | { kind: 'answered'; updatedInput: Record<string, unknown>; answers: RelayAnswer[]; approvalId?: string; reason: string }
  /** The console is going away with the window open: `defer`, and the card kept for the resume. */
  | { kind: 'deferred'; approvalId: string; reason: string }
  /** An exclusion or the budget: `deny`, and the phase parked for a person. */
  | { kind: 'unanswerable'; reason: QuestionUnanswerableReason; message: string; rule?: string }
  /** A person refused the card itself: `deny`, with their words. */
  | { kind: 'declined'; message: string }
  /** Not a question this relay can hold (no run, no phase, a malformed call) — the policy answer stands. */
  | { kind: 'not-relayed' };

/** The runner surface the relay writes through. Every call is wrapped: bookkeeping never costs the answer. */
export type RelayRunner = {
  note(event: string, data?: Record<string, unknown>, phase?: number): void;
  park(reason: string, phase: number | null, kind: HaltKind): boolean;
  tellRelayAnswer?(phase: number, answers: readonly RelayAnswer[]): { ok: boolean; mark?: string; reason?: string };
};

/** A ruling row the relay appends (`runner/rulings.ts` `appendRuling`). */
export type RelayRuling = {
  phase: number;
  what: string;
  why: string;
  by: string;
  sessionId?: string;
  relay: { tool: string; key: string; answer: string; answeredBy: QuestionAnsweredBy; ruleId?: string };
};

export type RelayDeps = {
  approvals: Approvals;
  /** The live runner driving a run, or null. */
  runner(runId: string): RelayRunner | null;
  /** A journal line for a run no runner drives — the boot path. */
  journal(slug: string, runId: string, event: string, data: Record<string, unknown>, phase?: number): void;
  announce(
    category: 'needs-you' | 'session-ask',
    message: { title: string; body: string; tag: string; detail?: string },
    context: { slug: string; phase: number; runId: string; approvalId?: string },
  ): void;
  tagFor(...parts: (string | number)[]): string;
  appendRuling(slug: string, ruling: RelayRuling): void;
  /** The rule table in force: shipped defaults, then this console's `relayRules`. */
  rules(): readonly RelayRule[];
  /** `phase-outcome.sh`'s directory, for the words the session is told. */
  scriptsDir: string;
  /** Test seams. */
  answerMs?: number;
  windowMs?: number;
  now?(): number;
  stateFile?: string;
};

/** A question held open: its card, its hook's pending reply, and its timer. */
type Held = {
  approval: Approval;
  run: RunState;
  phase: number;
  envelope: QuestionEnvelope;
  resolve: (reply: RelayReply) => void;
  timer: NodeJS.Timeout | null;
  journalled: Set<string>;
  /** The hook was told `defer`: the window still closes on its own clock, and its answer is KEPT for the resume. */
  deferred?: true;
};

/** An answer kept for a question the session will ask again — or resume. */
type Kept = {
  runId: string;
  phase: number;
  toolUseId?: string;
  keys: string[];
  answers: Record<string, QuestionAnswer>;
  approvalId: string;
  at: string;
};

type RelayFile = { version: 1; asked: Record<string, string[]>; kept: Kept[] };

/** Kept answers older than this are nobody's resume any more. */
const KEPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_KEPT = 200;
const MAX_ASKED_RUNS = 200;

/** The questions a call carries, as the relay reads them — or none, when any of them is malformed. */
export function questionItemsOf(input: unknown): QuestionItem[] {
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || !list.length || list.length > 4) return [];
  const out: QuestionItem[] = [];
  for (const entry of list) {
    const raw = entry as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown } | null;
    if (typeof raw?.question !== 'string' || !raw.question.trim()) return [];
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
        const label = typeof option === 'string' ? option : (option as { label?: unknown } | null)?.label;
        const description = typeof option === 'object' && option ? (option as { description?: unknown }).description : undefined;
        return typeof label === 'string' && label.trim()
          ? [{ label, ...(typeof description === 'string' && description ? { description } : {}) }]
          : [];
      })
      : [];
    // A question with nothing to choose is not one the console can answer —
    // and `answers` must cover every question the call carries.
    if (!options.length) return [];
    const header = typeof raw.header === 'string' && raw.header.trim() ? raw.header : undefined;
    out.push({
      key: questionKey({ question: raw.question, ...(header ? { header } : {}) }),
      question: raw.question,
      ...(header ? { header } : {}),
      options,
      multiSelect: raw.multiSelect === true,
    });
  }
  return out;
}

/** The journal's copy of a call's questions: one entry per question, bounded. */
function journalQuestions(items: readonly QuestionItem[]): { key: string; question: string; options: string[]; multiSelect: boolean }[] {
  return items.map((item) => ({
    key: item.key,
    question: item.question.slice(0, 300),
    options: item.options.map((option) => option.label.slice(0, 80)).slice(0, 8),
    multiSelect: item.multiSelect,
  }));
}

/**
 * A denied command written into an option — the deny list's second look at a
 * question. Backticked spans and whole labels and descriptions are read as the
 * commands they may be, through the same matcher the hook uses on a Bash call,
 * so `git push --force` in an option is the wall exactly as it would be run.
 */
function deniedInOptions(items: readonly QuestionItem[], policy: AutopilotPolicy): string | null {
  for (const item of items) {
    for (const option of item.options) {
      const texts = [option.label, option.description ?? ''];
      for (const text of [option.label, option.description ?? '']) {
        for (const span of text.matchAll(/`([^`]{1,300})`/g)) texts.push(span[1]);
      }
      for (const text of texts) {
        const command = text.trim();
        if (!command) continue;
        const rule = matchedDenyRule('Bash', { command }, policy);
        if (rule) return rule;
      }
    }
  }
  return null;
}

/** Halted or parked — a question raised now has nobody driving the run to answer it for. */
function runStopped(run: RunState, phase: number): boolean {
  if (run.halt) return true;
  if (run.status === 'halted' || run.status === 'halting' || run.status === 'parked') return true;
  return run.phases?.[String(phase)]?.status === 'parked';
}

export class Relay {
  private readonly deps: RelayDeps;
  private readonly held = new Map<string, Held>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly file: string;
  private state: RelayFile;

  constructor(deps: RelayDeps) {
    this.deps = deps;
    this.file = deps.stateFile ?? join(INSTANCE_STATE_DIR, 'relay', 'state.json');
    this.state = this.read();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /* ---------------- the one call site ---------------- */

  /**
   * Relay one question. Resolves with what the hook must answer — never throws:
   * a hook that throws fails OPEN, and an open `AskUserQuestion` would reach a
   * permission host that never answers.
   */
  async relayQuestion(run: RunState | null, phase: number | null, envelope: QuestionEnvelope): Promise<RelayReply> {
    try {
      const items = questionItemsOf(envelope.input);
      if (!run || typeof phase !== 'number' || !items.length) return { kind: 'not-relayed' };

      // 1. The wall first, and no window for anything it stops.
      const denied = matchedDenyRule(envelope.tool, envelope.input, envelope.policy) ?? deniedInOptions(items, envelope.policy);
      if (denied) return this.refuse(run, phase, envelope, items, 'deny-list', { rule: denied });

      // 2. An answer already given — a deferred call resumed, a question answered at boot.
      const kept = this.takeKept(run.id, phase, envelope, items);
      if (kept) return this.deliverKept(run, phase, envelope, items, kept);

      // 3. The exclusions, in their order, then the budget.
      const multi = items.find((item) => item.multiSelect);
      if (multi) return this.refuse(run, phase, envelope, items, 'multi-select', { key: multi.key });
      for (const item of items) {
        const option = destructiveOption(item.options);
        if (option) return this.refuse(run, phase, envelope, items, 'destructive-option', { key: item.key, option });
      }
      if (runStopped(run, phase)) return this.refuse(run, phase, envelope, items, 'run-stopped', { status: run.status });
      const asked = this.askedKeys(run.id, phase);
      const repeated = items.find((item) => asked.includes(item.key));
      if (repeated) return this.refuse(run, phase, envelope, items, 'repeated-key', { key: repeated.key });
      if (asked.length + items.length > RELAY_QUESTIONS_PER_PHASE) {
        return this.refuse(run, phase, envelope, items, 'budget-spent', { asked: asked.length, budget: RELAY_QUESTIONS_PER_PHASE });
      }
      this.noteAsked(run.id, phase, items.map((item) => item.key));

      // 4. One open question per lane.
      return await this.inTurn(`${run.id}:${phase}`, () => this.hold(run, phase, envelope, items));
    } catch (error) {
      log.warn('relay.failed', { error: String(error) });
      return { kind: 'not-relayed' };
    }
  }

  /* ---------------- a person's answer ---------------- */

  /**
   * A person picks an option inside the window. Each pick lands on its question
   * at once (and on disk); when every question of the call has an answer the
   * card comes down and the session is answered. Questions a person left are the
   * console's to answer when the window closes.
   */
  answer(
    approvalId: string, picks: readonly { key?: string; question?: string; label: string }[], by: string,
  ): { ok: true; answered: string[]; remaining: number } | { ok: false; status: number; error: string } {
    const card = this.deps.approvals.pending().find((approval) => approval.id === approvalId);
    if (!card || card.kind !== 'question' || !card.question) {
      return { ok: false, status: 404, error: 'no question is waiting under that id' };
    }
    const question = card.question;
    if (question.deferred) return { ok: false, status: 409, error: 'this question was deferred for its session to resume' };
    const at = new Date(this.now()).toISOString();
    const chosen: { item: QuestionItem; label: string }[] = [];
    for (const pick of picks) {
      const item = question.items.find((candidate) => (pick.key && candidate.key === pick.key)
        || (pick.question && candidate.question === pick.question));
      if (!item) return { ok: false, status: 400, error: `this card has no question ${pick.key ?? pick.question ?? ''}`.trim() };
      const label = item.options.find((option) => option.label.trim().toLowerCase() === String(pick.label ?? '').trim().toLowerCase())?.label;
      if (!label) return { ok: false, status: 400, error: `"${pick.label}" is not one of that question's options` };
      if (!question.answers[item.key]) chosen.push({ item, label });
    }
    if (!chosen.length && picks.length) {
      return { ok: true, answered: [], remaining: question.items.filter((item) => !question.answers[item.key]).length };
    }
    const who = by.trim().slice(0, 64) || 'person';
    this.deps.approvals.update(card.id, (approval) => {
      for (const { item, label } of chosen) {
        approval.question!.answers[item.key] = { label, by: 'human', who, at };
      }
    });
    const held = this.held.get(card.id);
    for (const { item, label } of chosen) {
      this.journalAnswer(card, item, { label, by: 'human', who, at }, { run: held?.run ?? null });
      held?.journalled.add(item.key);
    }
    const remaining = question.items.filter((item) => !question.answers[item.key]).length;
    if (!remaining) this.deps.approvals.settle(card.id, 'allow', who, 'answered by a person');
    return { ok: true, answered: chosen.map(({ item }) => item.key), remaining };
  }

  /* ---------------- the console going away ---------------- */

  /**
   * End every question still open — for one run (its loop ended) or for all of
   * them (the console is shutting down). A `PreToolUse` question is DEFERRED: the
   * hook is told `defer`, the session ends its turn with the call kept, and the
   * card stays on disk with its `tool_use_id` for the answer that meets the
   * resume. A `PermissionRequest` question cannot defer — the event carries no
   * `tool_use_id` — so it is answered by rule now. Returns how many it ended.
   */
  deferOpen(runId: string | null, why: string): number {
    let ended = 0;
    for (const entry of [...this.held.values()]) {
      if (entry.deferred || (runId && entry.approval.runId !== runId)) continue;
      if (this.end(entry.approval, why)) ended += 1;
    }
    return ended;
  }

  /** The broker's `questionEnding` hook, and `deferOpen`'s one step. True when the relay took the card. */
  end(approval: Approval, why: string): boolean {
    const entry = this.held.get(approval.id);
    const question = approval.question;
    if (!entry || !question) return false;
    if (entry.deferred) return true;
    if (question.mechanism === 'pre-tool-use' && question.toolUseId) {
      const at = new Date(this.now()).toISOString();
      const toolUseId = question.toolUseId;
      this.deps.approvals.update(approval.id, (card) => { card.question!.deferred = { toolUseId, at, why }; });
      // The card and its clock stay: a console that lives on closes the window
      // on time and KEEPS the answer for the resume (`settled`); one that exits
      // leaves the card on disk for the boot to answer (`recoverCard`).
      entry.deferred = true;
      this.note(entry.run, entry.phase, 'phase.question-deferred', {
        approvalId: approval.id, tool: question.tool, toolUseId, why,
        keys: question.items.map((item) => item.key),
      });
      entry.resolve({
        kind: 'deferred',
        approvalId: approval.id,
        reason: `the console is going away (${why}) with this question open — it is kept, answered when its window `
          + 'closes, and given to this session when it resumes',
      });
      return true;
    }
    this.closeWindow(approval.id);
    return true;
  }

  /* ---------------- boot ---------------- */

  /**
   * A question card an earlier console left open (TRS-11, AC-6): answered NOW by
   * the rule table — `waitedMs` spanning the outage — journalled and ruled like
   * any answer, and kept for the session. A DEFERRED card is still answerable:
   * its session resumes and the same hook fires for the same `tool_use_id`. One
   * whose hook closed with the console is `hook-closed`: the answer is recorded
   * as the substitute and given if the session asks the same question again.
   * Never `expired`.
   */
  recoverCard(card: Approval): RecoveryVerdict {
    const question = card.question;
    if (card.kind !== 'question' || !question || typeof card.phase !== 'number') {
      return { unanswerable: 'session-gone' };
    }
    const answers = this.fillByRule(card, question.profile ?? 'guarded');
    for (const item of question.items) {
      const answer = question.answers[item.key];
      if (!answer || answer.by === 'human') continue;
      this.journalAnswer(card, item, answer, { run: null, recovered: true });
    }
    this.keepFor(card);
    log.info('relay.recovered', {
      approvalId: card.id, runId: card.runId, phase: card.phase, deferred: Boolean(question.deferred), answered: answers.length,
    });
    if (question.deferred) {
      return {
        answerable: true,
        settle: { decision: 'allow', by: 'relay', reason: 'answered by the console at boot — given to the session when it resumes' },
      };
    }
    return { unanswerable: 'hook-closed' };
  }

  /* ---------------- internals ---------------- */

  private async hold(run: RunState, phase: number, envelope: QuestionEnvelope, items: QuestionItem[]): Promise<RelayReply> {
    const windowMs = this.deps.windowMs ?? RELAY_WINDOW_MS;
    const answerMs = Math.min(this.deps.answerMs ?? RELAY_ANSWER_MS, windowMs);
    const preview = items.map((item) => {
      const chosen = pickAnswer(item, { rules: this.deps.rules(), tool: envelope.tool, profile: envelope.profile });
      return chosen ? `"${chosen.answer}"` : 'nothing';
    }).join(', ');
    const { approval, decided } = this.deps.approvals.request({
      runId: run.id,
      slug: run.slug,
      phase,
      kind: 'question',
      title: items.length === 1 ? items[0].question.slice(0, 200) : `${items.length} questions — ${items[0].question.slice(0, 160)}`,
      detail: `Phase ${phase} of ${run.slug} asks. Answer within ${Math.round(windowMs / 1000)} s, or the console `
        + `answers ${preview} by rule.`,
      evidence: items.map((item) => ({
        label: item.header ?? 'Question',
        body: [item.question, ...item.options.map((option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)].join('\n'),
      })),
      tool: { name: envelope.tool, input: envelope.input, ...(envelope.cwd ? { cwd: envelope.cwd } : {}) },
      question: {
        mechanism: envelope.mechanism,
        tool: envelope.tool,
        ...(envelope.toolUseId ? { toolUseId: envelope.toolUseId } : {}),
        ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
        profile: envelope.profile,
        items,
        answers: {},
      },
    }, windowMs);

    this.note(run, phase, 'phase.question-raised', {
      tool: envelope.tool,
      key: items[0].key,
      questions: journalQuestions(items).map(({ key, options, multiSelect }) => ({ key, options, multiSelect })),
      source: this.sourceOf(run),
      mechanism: envelope.mechanism,
      approvalId: approval.id,
      ...(envelope.toolUseId ? { toolUseId: envelope.toolUseId } : {}),
    });

    return new Promise<RelayReply>((resolve) => {
      const entry: Held = { approval, run, phase, envelope, resolve, timer: null, journalled: new Set() };
      entry.timer = setTimeout(() => this.closeWindow(approval.id), answerMs);
      entry.timer.unref?.();
      this.held.set(approval.id, entry);
      void decided.then((settled) => this.settled(approval.id, settled));
    });
  }

  /** The window's end: every unanswered question gets the console's answer, and the card comes down. */
  private closeWindow(approvalId: string): void {
    const entry = this.held.get(approvalId);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    this.fillByRule(entry.approval, entry.envelope.profile);
    this.deps.approvals.update(approvalId, () => { /* the answers above, to disk */ });
    this.deps.approvals.settle(approvalId, 'allow', 'relay', 'answered by the console at the end of the window');
  }

  /** Every ending of a held card arrives here — the window, a person, the broker's own clock. */
  private settled(approvalId: string, settled: { decision: string; by: string; reason?: string }): void {
    const entry = this.held.get(approvalId);
    if (!entry) return;
    this.held.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    const card = entry.approval;
    const question = card.question!;
    if (entry.deferred) {
      // The session already ended its turn on `defer`: nothing to reply and
      // nobody to tell. The answer is recorded and kept for the resume, which
      // fires the same hook for the same `tool_use_id`.
      this.fillByRule(card, entry.envelope.profile);
      for (const item of question.items) {
        if (entry.journalled.has(item.key)) continue;
        this.journalAnswer(card, item, question.answers[item.key], { run: entry.run });
      }
      this.keepFor(card);
      return;
    }
    if (settled.decision !== 'allow') {
      entry.resolve({
        kind: 'declined',
        message: `A person declined to answer this question (${settled.by})${settled.reason ? `: ${settled.reason}` : ''}. `
          + 'Decide it from the plan and record a ruling, or declare '
          + `\`bash ${this.deps.scriptsDir}/phase-outcome.sh ${card.slug} ${card.phase} blocked --needs ambiguity --reason "<what you need>"\` and stop.`,
      });
      return;
    }
    // A settle that beat the window — the broker's own clock — still owes the rest.
    this.fillByRule(card, entry.envelope.profile);
    for (const item of question.items) {
      if (entry.journalled.has(item.key)) continue;
      this.journalAnswer(card, item, question.answers[item.key], { run: entry.run });
      entry.journalled.add(item.key);
    }
    const answers = question.items.map((item) => {
      const answer = question.answers[item.key];
      return { key: item.key, question: item.question, label: answer.label, by: answer.by, ...(answer.ruleId ? { ruleId: answer.ruleId } : {}) };
    });
    entry.resolve(this.answeredReply(entry.envelope, question.items, answers, card.id));
    this.tell(entry.run, entry.phase, answers);
  }

  /** Fill every unanswered question by the rule table; returns the answers it added. */
  private fillByRule(card: Approval, profile: PermissionProfile): RelayAnswer[] {
    const question = card.question;
    if (!question) return [];
    const at = new Date(this.now()).toISOString();
    const rules = this.deps.rules();
    const added: RelayAnswer[] = [];
    for (const item of question.items) {
      if (question.answers[item.key]) continue;
      const chosen = pickAnswer(item, { rules, tool: question.tool, profile });
      if (!chosen) continue;
      question.answers[item.key] = { label: chosen.answer, by: chosen.by, at, ...(chosen.ruleId ? { ruleId: chosen.ruleId } : {}) };
      added.push({ key: item.key, question: item.question, label: chosen.answer, by: chosen.by, ...(chosen.ruleId ? { ruleId: chosen.ruleId } : {}) });
    }
    return added;
  }

  private answeredReply(
    envelope: QuestionEnvelope, items: readonly QuestionItem[], answers: RelayAnswer[], approvalId?: string,
  ): RelayReply {
    const input = envelope.input && typeof envelope.input === 'object' ? envelope.input as Record<string, unknown> : {};
    const byText: Record<string, string> = {};
    for (const answer of answers) byText[answer.question] = answer.label;
    const people = answers.every((answer) => answer.by === 'human');
    return {
      kind: 'answered',
      // `questions` echoed exactly as the call sent them, `answers` keyed by
      // each question's TEXT — the shape spike S1 measured honoured.
      updatedInput: { ...input, questions: (input as { questions?: unknown }).questions ?? items, answers: byText },
      answers,
      ...(approvalId ? { approvalId } : {}),
      reason: people
        ? 'answered by a person watching this run'
        : 'no operator answered within the window — answered by the console\'s relay rules',
    };
  }

  private deliverKept(run: RunState, phase: number, envelope: QuestionEnvelope, items: QuestionItem[], kept: Kept): RelayReply {
    const answers: RelayAnswer[] = [];
    for (const item of items) {
      const answer = kept.answers[item.key];
      if (!answer) return { kind: 'not-relayed' };
      answers.push({ key: item.key, question: item.question, label: answer.label, by: answer.by, ...(answer.ruleId ? { ruleId: answer.ruleId } : {}) });
    }
    log.info('relay.kept-answer', {
      runId: run.id, phase, approvalId: kept.approvalId, deferred: Boolean(kept.toolUseId), mechanism: envelope.mechanism,
    });
    this.tell(run, phase, answers);
    return this.answeredReply(envelope, items, answers, kept.approvalId);
  }

  private refuse(
    run: RunState, phase: number, envelope: QuestionEnvelope, items: QuestionItem[],
    reason: QuestionUnanswerableReason, extra: Record<string, unknown>,
  ): RelayReply {
    const label = QUESTION_REASON_LABELS[reason];
    const first = items[0];
    this.note(run, phase, 'phase.question-unanswerable', {
      reason, tool: envelope.tool, key: first.key, mechanism: envelope.mechanism,
      questions: journalQuestions(items), ...extra,
    });
    try {
      this.deps.runner(run.id)?.park(
        `phase ${phase} asked a question the console will not answer (${label}): ${first.question.slice(0, 200)}`,
        phase, 'needs-human',
      );
    } catch (error) { log.warn('relay.bookkeeping-failed', { what: 'park', runId: run.id, phase, error: String(error) }); }
    try {
      this.deps.announce('needs-you', {
        title: `A question needs you — ${run.slug} phase ${phase}`,
        body: `${first.question.slice(0, 240)} — not answered by rule: ${label}.`,
        tag: this.deps.tagFor('needs-you', run.slug, phase, 'question', first.key),
        detail: first.options.map((option) => option.label).join(' · ').slice(0, 200),
      }, { slug: run.slug, phase, runId: run.id });
    } catch (error) { log.warn('relay.bookkeeping-failed', { what: 'announce', runId: run.id, phase, error: String(error) }); }
    const outcome = `bash ${this.deps.scriptsDir}/phase-outcome.sh ${run.slug} ${phase}`;
    return {
      kind: 'unanswerable',
      reason,
      ...(typeof extra.rule === 'string' ? { rule: extra.rule } : {}),
      message: `The console will not answer this question by rule — ${label}. A person has been asked. Do not guess `
        + `and do not ask again: hand off \`in-progress\`, declare \`${outcome} needs-human --needs ambiguity --reason `
        + '"<the question>"`, and stop — the operator answers it.',
    };
  }

  private journalAnswer(
    card: Approval, item: QuestionItem, answer: QuestionAnswer | undefined,
    opts: { run: RunState | null; recovered?: boolean },
  ): void {
    if (!answer || typeof card.phase !== 'number') return;
    const waitedMs = Math.max(0, Date.parse(answer.at) - Date.parse(card.createdAt));
    const data = {
      approvalId: card.id,
      key: item.key,
      question: item.question.slice(0, 300),
      answer: answer.label,
      by: answer.by,
      waitedMs,
      ...(answer.ruleId ? { ruleId: answer.ruleId } : {}),
      ...(answer.who ? { who: answer.who } : {}),
      ...(card.question?.deferred ? { deferred: true } : {}),
      ...(opts.recovered ? { recovered: true } : {}),
    };
    if (opts.run) this.note(opts.run, card.phase, 'phase.question-answered', data);
    else this.journalFor(card.slug, card.runId, 'phase.question-answered', data, card.phase);
    try {
      this.deps.appendRuling(card.slug, {
        phase: card.phase,
        what: `answered "${item.question.slice(0, 200)}" with "${answer.label}"`,
        why: answer.by === 'human'
          ? `a person answered it inside the ${Math.round((this.deps.windowMs ?? RELAY_WINDOW_MS) / 1000)} s window`
          : `no operator answered within the window; the console answered by ${answer.by}${answer.ruleId ? ` (${answer.ruleId})` : ''}`,
        by: answer.by === 'human' ? (answer.who ?? 'person') : 'relay',
        ...(card.question?.sessionId ? { sessionId: card.question.sessionId } : {}),
        relay: {
          tool: card.question?.tool ?? 'AskUserQuestion',
          key: item.key,
          answer: answer.label,
          answeredBy: answer.by,
          ...(answer.ruleId ? { ruleId: answer.ruleId } : {}),
        },
      });
    } catch (error) { log.warn('relay.bookkeeping-failed', { what: 'ruling', slug: card.slug, phase: card.phase, error: String(error) }); }
  }

  private tell(run: RunState, phase: number, answers: readonly RelayAnswer[]): void {
    const machine = answers.filter((answer) => answer.by !== 'human');
    if (!machine.length) return;
    // After the reply is on its way: the hook answer is the tool result the
    // session reads first, and this is the turn after it.
    setImmediate(() => {
      try { this.deps.runner(run.id)?.tellRelayAnswer?.(phase, machine); } catch (error) {
        log.warn('relay.bookkeeping-failed', { what: 'tell', runId: run.id, phase, error: String(error) });
      }
    });
  }

  private note(run: RunState, phase: number, event: string, data: Record<string, unknown>): void {
    try {
      const runner = this.deps.runner(run.id);
      if (runner) runner.note(event, data, phase);
      else this.journalFor(run.slug, run.id, event, data, phase);
    } catch { /* the journal is bookkeeping: it never costs the answer */ }
  }

  private journalFor(slug: string, runId: string, event: string, data: Record<string, unknown>, phase: number): void {
    try { this.deps.journal(slug, runId, event, data, phase); } catch { /* ditto */ }
  }

  /** Why this run relays at all: the manifest row's source, else the run's own answer. */
  private sourceOf(run: RunState): string {
    return run.manifest?.decisions?.find((row) => row.key === 'relay')?.source ?? 'run';
  }

  private inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.lanes.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => { if (this.lanes.get(key) === tail) this.lanes.delete(key); });
    return next;
  }

  /* ---------------- the file ---------------- */

  private askedKeys(runId: string, phase: number): string[] {
    return this.state.asked[`${runId}:${phase}`] ?? [];
  }

  private noteAsked(runId: string, phase: number, keys: string[]): void {
    const slot = `${runId}:${phase}`;
    this.state.asked[slot] = [...new Set([...(this.state.asked[slot] ?? []), ...keys])];
    const slots = Object.keys(this.state.asked);
    for (const stale of slots.slice(0, Math.max(0, slots.length - MAX_ASKED_RUNS))) delete this.state.asked[stale];
    this.write();
  }

  /** Keep a card's answers for the session that will ask again, or resume. */
  private keepFor(card: Approval): void {
    const question = card.question;
    if (!question || typeof card.phase !== 'number') return;
    this.keep({
      runId: card.runId,
      phase: card.phase,
      ...(question.deferred ? { toolUseId: question.deferred.toolUseId } : {}),
      keys: question.items.map((item) => item.key).sort(),
      answers: { ...question.answers },
      approvalId: card.id,
      at: new Date(this.now()).toISOString(),
    });
  }

  private keep(kept: Kept): void {
    const now = this.now();
    this.state.kept = [
      ...this.state.kept.filter((entry) => entry.approvalId !== kept.approvalId && now - Date.parse(entry.at) < KEPT_TTL_MS),
      kept,
    ].slice(-MAX_KEPT);
    this.write();
  }

  private takeKept(runId: string, phase: number, envelope: QuestionEnvelope, items: readonly QuestionItem[]): Kept | null {
    const keys = items.map((item) => item.key).sort().join('\n');
    const index = this.state.kept.findIndex((entry) => entry.runId === runId
      && ((envelope.toolUseId && entry.toolUseId === envelope.toolUseId)
        || (entry.phase === phase && entry.keys.join('\n') === keys)));
    if (index < 0) return null;
    const [kept] = this.state.kept.splice(index, 1);
    this.write();
    return kept;
  }

  private read(): RelayFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RelayFile>;
      if (parsed.version === 1) {
        return {
          version: 1,
          asked: parsed.asked && typeof parsed.asked === 'object' ? parsed.asked as Record<string, string[]> : {},
          kept: Array.isArray(parsed.kept) ? parsed.kept.filter((entry) => entry && typeof entry.runId === 'string') : [],
        };
      }
    } catch { /* never written, or unreadable: start empty */ }
    return { version: 1, asked: {}, kept: [] };
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      log.warn('relay.persist-failed', { file: this.file, error: String(error) });
    }
  }
}
