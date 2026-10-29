/**
 * The packs' words into Your turn (measured-console phase 29, §Architecture 6
 * D7). What a plugin pack says to a person reaches the console's own items:
 *
 *   - gstack's `GSTACK_RESULT: skill=<s> status=<status> run=<dir>` line —
 *     `formatResult` / its parser at gstack `lib/headless-artifacts.ts:108-116`;
 *     `status=gate_pending` is a run stopped at its gate (`autoplan/DRIVER.md`
 *     "the run stops at `status=gate_pending`: never approve");
 *   - gstack's run-directory `decisions.jsonl` rows `kind: "approval",
 *     status: "pending"` (`DecisionRow`, `lib/headless-artifacts.ts:34-44`,
 *     written whole by `lib/gate-list.ts:203-212` `decisionRows`), each
 *     option's words from the same directory's `gate.json` (`GateItem`,
 *     `lib/gate-list.ts:25-42`);
 *   - a question with lettered choices, one marked `(recommended …)` — the
 *     shape gstack asks in (`eval-plan/SKILL.md` "A) … (recommended when …)")
 *     and `to-questionnaire`'s `### <question>` sections;
 *   - mattpocock's wizard (`wizard/template.sh`): `stage "<name>"` blocks of
 *     `say`/`step`/`open_url`/`ask`/`ask_secret`/`write_env`/`set_secret`/
 *     `set_var`/`confirm` calls under the STAGES marker — the Task guide's
 *     shape (`compose.ts` `wizardGuide`).
 *
 * And the rule the relay could not cover (it catches only `AskUserQuestion`):
 * a session that ENDS on prose questions and declares no outcome raises ONE
 * Decision item from them (`closingAskOf`, raised by the runner's exit-time
 * check as `phase.prose-question`).
 *
 * The readers are pure — text in, facts out; `readGstackRun` is the one file
 * read, bounded, of the run directory a result line names.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  gstackApprovalStep, gstackGateStep, proseQuestionStep, PACK_QUESTIONS_MAX, wizardGuide,
  type PackQuestion, type PackStep, type WizardStage,
} from './compose.ts';
import { GUIDE_MAX_STEPS, parseGuide, renderGuide, type Guide } from '../../shared/guide-grammar.js';
import { looksLikeSecret } from '../../shared/human-step-model.js';

/* ------------------------------------------------------------------ *
 * gstack — the result line
 * ------------------------------------------------------------------ */

/** gstack's own parser (`lib/headless-artifacts.ts:111-116`), the line's three keys. */
export const GSTACK_RESULT_RE = /^GSTACK_RESULT: skill=(\S+) status=(\S+) run=(.+)$/;

export type GstackResult = { skill: string; status: string; run: string };

/**
 * Every `GSTACK_RESULT` line in a session's words, in order. A line a session
 * quoted — in backticks, a list item or a block quote — is still the line.
 */
export function gstackResultsOf(text: string | null | undefined): GstackResult[] {
  const out: GstackResult[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const bare = raw.trim().replace(/^(?:>\s*|[-*+]\s+)+/, '').replace(/^`+|`+$/g, '').trim();
    const m = GSTACK_RESULT_RE.exec(bare);
    if (m) out.push({ skill: m[1]!, status: m[2]!, run: m[3]!.trim() });
  }
  return out;
}

/** The run a session's words leave at its gate: the LAST result line, when it says `gate_pending`. */
export function gatePendingOf(text: string | null | undefined): GstackResult | null {
  const last = gstackResultsOf(text).at(-1);
  return last && last.status === 'gate_pending' ? last : null;
}

/* ------------------------------------------------------------------ *
 * gstack — the pending approvals
 * ------------------------------------------------------------------ */

export type GstackApproval = {
  run: string;
  id: string;
  label?: string;
  title: string;
  options: { key: string; text: string }[];
  recommended: string | null;
  gateRev: number;
};

function jsonOf(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** The option words a `gate.json` gives each item, by its id (`d3`, `uc1`, `p1`). */
function gateTexts(gateText: string | null | undefined): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const gate = jsonOf(String(gateText ?? '')) as { items?: unknown } | null;
  if (!gate || !Array.isArray(gate.items)) return out;
  for (const item of gate.items as { id?: unknown; options?: unknown }[]) {
    if (typeof item?.id !== 'string' || !Array.isArray(item.options)) continue;
    const texts = new Map<string, string>();
    for (const o of item.options as { key?: unknown; text?: unknown }[]) {
      if (typeof o?.key === 'string' && typeof o.text === 'string') texts.set(o.key, o.text);
    }
    out.set(item.id.toLowerCase(), texts);
  }
  return out;
}

/**
 * The approvals a gstack run waits on: its `decisions.jsonl` rows `kind:
 * "approval", status: "pending"` of the NEWEST gate revision (an older gate's
 * row is history), in file order, each option in `gate.json`'s words where the
 * file gives them, else its key. A row missing a required field is skipped.
 */
export function pendingApprovalsOf(decisionsText: string | null | undefined, gateText?: string | null): GstackApproval[] {
  const rows: GstackApproval[] = [];
  for (const raw of String(decisionsText ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const row = jsonOf(raw) as Record<string, unknown> | null;
    if (!row || row.kind !== 'approval' || row.status !== 'pending') continue;
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || !row.title.trim() || !Array.isArray(row.options)) continue;
    const gateRev = Number(row.gate_rev);
    if (!Number.isInteger(gateRev) || gateRev < 1) continue;
    rows.push({
      run: typeof row.run === 'string' ? row.run : '',
      id: row.id,
      ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
      title: row.title.trim(),
      options: (row.options as unknown[]).filter((k): k is string => typeof k === 'string').map((key) => ({ key, text: key })),
      recommended: typeof row.recommended === 'string' ? row.recommended : null,
      gateRev,
    });
  }
  const newest = Math.max(0, ...rows.map((r) => r.gateRev));
  const texts = gateTexts(gateText);
  return rows.filter((r) => r.gateRev === newest).map((r) => {
    // The row id is `<run>-<item>` or `<run>-r<rev>-<item>` (`lib/gate-list.ts:197-200`).
    const item = (r.label ?? r.id.slice(r.id.lastIndexOf('-') + 1)).toLowerCase();
    const words = texts.get(item);
    return words ? { ...r, options: r.options.map((o) => ({ key: o.key, text: words.get(o.key) ?? o.key })) } : r;
  });
}

/** The most a run file may weigh before it is not read — a gate is small. */
const RUN_FILE_MAX = 512 * 1024;

function boundedRead(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > RUN_FILE_MAX) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The approvals a result line's run directory holds, read where it names an
 * absolute directory (a relative one is the session's cwd, which this reader
 * does not guess) — empty when nothing there can be read.
 */
export function readGstackRun(run: string): GstackApproval[] {
  if (!run || !isAbsolute(run)) return [];
  const decisions = boundedRead(join(run, 'decisions.jsonl'));
  if (!decisions) return [];
  return pendingApprovalsOf(decisions, boundedRead(join(run, 'gate.json')));
}

/* ------------------------------------------------------------------ *
 * Questions — a questionnaire's and a session's closing words
 * ------------------------------------------------------------------ */

/** A recommendation's mark on a choice: `(Recommended)`, gstack's `(recommended when within the cap)`. */
const CHOICE_RECOMMENDED = /\s*\((?:recommended|the recommended one)\b[^)]*\)/i;

/** A lettered choice — `A) …`, `- B. …`, `(c) …` — or a checkbox — `- [ ] …`. */
const CHOICE_LINE = /^\s*(?:[-*+]\s+)?(?:\(?([A-Ha-h])[).:]\s+|\[[ xX]\]\s+)(.+)$/;

/** A line that gives the answer a question's asker recommends. */
const RECOMMENDS = /^(?:[-*+>]\s*)?[*_]*\s*(?:my recommendation|recommendation|recommended|i(?:'d| would)? recommend|i(?:'d| would)? suggest|suggested)\b[*_]*\s*(?:is|:|—|–|-)?\s*(.+)$/i;

/** The same said after the question mark on its own line: "…? (Recommended: keep it.)", "…? — I recommend yes." */
const TRAILING_RECOMMENDS = /^[\s(—–-]*(?:my recommendation|recommended|i(?:'d| would)? recommend|i(?:'d| would)? suggest|suggested)\b\s*(?:is|:|—|–|-)?\s*(.+?)\)?\s*$/i;

/** Closing courtesy, not a question for a person. */
const PHATIC = /\b(?:let me know|any (?:other |further )?questions|anything else\b|does (?:this|that) help|hope (?:this|that) helps)/i;

/** A line's words without its list marker, heading hashes or emphasis. */
function bareLine(raw: string): string {
  return raw.trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]\s+|\d{1,2}[.)]\s+|>\s*)+/, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
}

type Read = { kind: 'question'; question: string; recommended?: string } | { kind: 'choice'; label: string; recommended: boolean }
  | { kind: 'recommends'; answer: string } | { kind: 'blank' } | { kind: 'other' };

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[*_`]+$/g, '').replace(/^[*_`]+/, '').trim().replace(/[.;]\s*$/, '');
}

function readLine(raw: string): Read {
  if (!raw.trim()) return { kind: 'blank' };
  const choice = CHOICE_LINE.exec(raw);
  if (choice && !/\?\s*$/.test(choice[2]!)) {
    const recommended = CHOICE_RECOMMENDED.test(choice[2]!);
    return { kind: 'choice', label: clean(choice[2]!.replace(CHOICE_RECOMMENDED, '')), recommended };
  }
  const bare = bareLine(raw);
  const recommends = RECOMMENDS.exec(bare);
  if (recommends && !bare.includes('?')) return { kind: 'recommends', answer: clean(recommends[1]!) };
  const mark = bare.lastIndexOf('?');
  if (mark > 0) {
    const question = clean(bare.slice(0, mark + 1));
    const after = bare.slice(mark + 1).replace(/^[*_]+/, '').trim();
    if (PHATIC.test(question)) return { kind: 'other' };
    if (!after) return { kind: 'question', question };
    const trailing = TRAILING_RECOMMENDS.exec(after);
    if (trailing) return { kind: 'question', question, recommended: clean(trailing[1]!) };
  }
  return { kind: 'other' };
}

/** Lines outside fenced code — a fence's body is never a question, and it ends a closing block. */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; out.push('\u0000'); continue; }
    out.push(fenced ? '\u0000' : raw);
  }
  return out;
}

function grouped(reads: readonly Read[]): PackQuestion[] {
  const out: PackQuestion[] = [];
  for (const read of reads) {
    const current = out.at(-1);
    if (read.kind === 'question') {
      out.push({ question: read.question, ...(read.recommended ? { recommended: read.recommended } : {}), choices: [] });
    } else if (read.kind === 'choice' && current) {
      current.choices.push({ label: read.label, ...(read.recommended ? { recommended: true } : {}) });
      if (read.recommended && !current.recommended) current.recommended = read.label;
    } else if (read.kind === 'recommends' && current && !current.recommended) {
      current.recommended = read.answer;
    }
  }
  // Two marked choices recommend nothing (the relay's own rule, `recommendedOption`).
  for (const q of out) {
    if (q.choices.filter((c) => c.recommended).length > 1) {
      q.choices = q.choices.map((c) => ({ label: c.label }));
      delete q.recommended;
    }
  }
  return out.slice(0, PACK_QUESTIONS_MAX);
}

/**
 * The questions a session's last message ENDS on — the prose-question rule's
 * exact trigger. Walking back from the last line, the closing block is every
 * line that is a question (its words end in `?`, or a recommendation follows
 * the `?` on the line), a lettered choice, a recommendation line, or blank; the
 * first line that is none of them — prose, a heading that asks nothing, a
 * fence — ends it. The block must hold at least one question; closing
 * courtesy ("Let me know if …?") is not one. Each question keeps the answer
 * the message recommended for it, and its choices.
 */
export function closingQuestionsOf(text: string | null | undefined): PackQuestion[] {
  const lines = proseLines(String(text ?? ''));
  const block: Read[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i]!;
    if (raw === '\u0000') break;
    const read = readLine(raw);
    if (read.kind === 'other') break;
    block.unshift(read);
  }
  return grouped(block).filter((q) => q.question.length > 1);
}

/**
 * A questionnaire's questions (`to-questionnaire`'s template): each `### …?`
 * section's question, the lettered choices beneath it as the options, the one
 * marked `(recommended)` recommended. The answer stub (`>`) and the *why this
 * matters* line are skipped.
 */
export function questionnaireOf(markdown: string | null | undefined): PackQuestion[] {
  const reads: Read[] = [];
  for (const raw of proseLines(String(markdown ?? ''))) {
    if (raw === '\u0000') continue;
    if (/^#{1,6}\s/.test(raw.trim()) && !/^###\s/.test(raw.trim())) continue;
    if (/^\s*>/.test(raw) || /^\s*_why this matters/i.test(raw)) continue;
    const read = readLine(raw);
    if (read.kind !== 'other' && read.kind !== 'blank') reads.push(read);
  }
  return grouped(reads);
}

/* ------------------------------------------------------------------ *
 * The wizard — the Task guide's shape
 * ------------------------------------------------------------------ */

/** A wizard script: the template's run function and at least one stage. */
export function isWizardScript(text: string | null | undefined): boolean {
  const body = String(text ?? '');
  return /^run_wizard\(\)\s*\{/m.test(body) && /^\s*stage\s+["']/m.test(body);
}

/** A shell line's words, quotes undone — enough for the template's one-call-per-line stages. */
function words(raw: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  const line = raw.replace(/\s+#.*$/, '');
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]!);
  return out;
}

/**
 * The wizard's banner, env file and stages, read from the body of `run_wizard`
 * (below the template's STAGES marker — the library above it is never read).
 */
export function wizardStagesOf(text: string | null | undefined): { title: string; envFile: string; stages: WizardStage[] } {
  const body = String(text ?? '');
  const start = body.search(/^run_wizard\(\)\s*\{/m);
  const env = /^ENV_FILE="\$\{ENV_FILE:-([^}"]+)\}"/m.exec(body);
  const stages: WizardStage[] = [];
  let title = 'A wizard';
  if (start < 0) return { title, envFile: env?.[1] ?? '.env', stages };
  for (const raw of body.slice(start).split('\n')) {
    const [verb, a = '', b = ''] = words(raw.trim());
    const stage = stages.at(-1);
    if (verb === 'banner' && a) title = a;
    else if (verb === 'stage' && a) stages.push({ name: a, says: [], opens: [], asks: [], writesEnv: [], secrets: [], variables: [], confirms: [] });
    else if (!stage) continue;
    else if ((verb === 'say' || verb === 'step') && a) stage.says.push(a);
    else if (verb === 'open_url' && /^https?:\/\//.test(a)) stage.opens.push(a);
    else if ((verb === 'ask' || verb === 'ask_secret') && /^[A-Z_][A-Z0-9_]*$/.test(a)) stage.asks.push({ key: a, prompt: b || a, secret: verb === 'ask_secret' });
    else if (verb === 'write_env' && a) stage.writesEnv.push(a);
    else if (verb === 'set_secret' && a) stage.secrets.push(a);
    else if (verb === 'set_var' && a) stage.variables.push(a);
    else if (verb === 'confirm' && a) stage.confirms.push(a);
  }
  return { title, envFile: env?.[1] ?? '.env', stages };
}

/**
 * A wizard-shaped guide file as a Task guide, held to the one grammar: the
 * composed guide is written in it and read back, so its limits and its secret
 * screen hold exactly as they do for an authored guide. The screen runs on the
 * script's own lines first, as the grammar's does — a secret-shaped value is
 * refused by its line number, never redacted into the guide and never echoed.
 */
export function guideFromWizard(text: string, file: string, lang = 'en'): { ok: true; guide: Guide } | { ok: false; error: string } {
  const planted = String(text).split('\n').findIndex((raw) => looksLikeSecret(raw));
  if (planted >= 0) return { ok: false, error: `line ${planted + 1} looks like a secret — a wizard asks for one at a hidden prompt, never holds it` };
  const wizard = wizardStagesOf(text);
  if (!wizard.stages.length) return { ok: false, error: 'the wizard has no stage' };
  const composed = wizardGuide({ ...wizard, file }, lang);
  const read = parseGuide(renderGuide(composed), { lang });
  if (!read.ok) return { ok: false, error: read.error };
  return read.guide.steps.length <= GUIDE_MAX_STEPS ? { ok: true, guide: read.guide } : { ok: false, error: 'too many stages' };
}

/* ------------------------------------------------------------------ *
 * The exit-time read — what a session's closing words ask a person
 * ------------------------------------------------------------------ */

export type ClosingAsk = {
  /** What raised it — the journal's word. */
  event: 'phase.prose-question' | 'phase.pack-item';
  step: PackStep;
  reason: string;
  /** The journal line's facts. */
  data: Record<string, unknown>;
};

/**
 * What a session that ended with no outcome left for a person, or null: a
 * gstack run at its gate (its first pending approval, read from the run
 * directory, else the gate as one decision), else the questions its last
 * message ends on. ONE item either way — the next ask rises when the session,
 * resumed with the answer, ends again.
 */
export function closingAskOf(
  text: string | null | undefined,
  opts: { ref: string; readRun?: (run: string) => GstackApproval[] },
): ClosingAsk | null {
  const gate = gatePendingOf(text);
  if (gate) {
    const approvals = (opts.readRun ?? readGstackRun)(gate.run);
    const first = approvals[0];
    if (first) {
      const step = gstackApprovalStep({
        skill: gate.skill, id: first.id, ...(first.label ? { label: first.label } : {}), title: first.title,
        options: first.options, recommended: first.recommended, pendingAfter: approvals.length - 1,
      });
      return {
        event: 'phase.pack-item', step,
        reason: `gstack's ${gate.skill} run stopped at its gate on an approval for a person`,
        data: { pack: 'gstack', shape: 'approval', skill: gate.skill, id: first.id, pending: approvals.length },
      };
    }
    return {
      event: 'phase.pack-item', step: gstackGateStep(gate),
      reason: `gstack's ${gate.skill} run stopped at its gate`,
      data: { pack: 'gstack', shape: 'gate', skill: gate.skill, pending: 0 },
    };
  }
  const questions = closingQuestionsOf(text);
  const step = proseQuestionStep(questions, opts.ref);
  if (!step) return null;
  return {
    event: 'phase.prose-question', step,
    reason: `the session ended on ${questions.length === 1 ? 'a question' : `${questions.length} questions`} and declared no outcome`,
    data: { questions: questions.length, recommended: questions.filter((q) => q.recommended).length, options: step.options.length },
  };
}
