/**
 * QA recovery — the round loop's words and arithmetic, with nothing that spawns.
 *
 * Issue #11: a recorded `fail` — and a `pending` — holds every dependent phase,
 * and until this existed there was nothing anyone could press. The ladder's
 * `qa-fix` rung resumed the phase's own session until the `ladder*` attempt and
 * dollar caps were spent and then parked with an errand naming no action; a
 * hand-driven plan never had a rung at all.
 *
 * The loop itself lives on the runner (`runner-attempt.ts` `qaRecover`), because
 * it spawns. What lives HERE is everything about it that can be tested without a
 * process: which verdicts a round may end on, what a fix session is told, how
 * much a round may spend, and what the errand says when the budget is gone. The
 * split is the one `ladder.ts` / `shared/ladder-model.js` already makes and for
 * the same reason — a prompt is easier to get wrong than a spawn, and far
 * cheaper to pin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nextQaRound, qaReportPath } from '../qa-round.ts';
import { qaVerdictInstruction } from '../qa-session.ts';

/**
 * What an operator asked for. Two verbs and not three: `qa-waive` writes a file
 * and starts nothing, so it never reaches this loop.
 *
 *   - `qa-recover` — a FIX session (which dispatches the review itself), round
 *     after round while rounds remain. The answer to "the work is wrong".
 *   - `qa-rerun`   — the review alone, no fix session. The answer to "the review
 *     was wrong": a flake, a missing binary, a reviewer that read the wrong tree.
 */
export type QaRecoverVerb = 'qa-recover' | 'qa-rerun';

/** How the fix session is boarded — `shared/run-settings.js` owns the words. */
export type QaFixStrategy = 'resume' | 'fresh';

/**
 * How much of the last report a fix session is handed, VERBATIM.
 *
 * Verbatim is the requirement, not a nicety: a summary of a QA report is a
 * second opinion about what the reviewer found, written by something that has
 * not read the diff. 12 KB is about four rounds' worth of findings on the
 * largest report in the corpus, and a report longer than that is quoted head and
 * tail (the findings lead; the verdict and the follow-ups close) rather than
 * truncated to its opening.
 */
export const QA_FINDINGS_MAX = 12_000;

/**
 * A round's own budget, when the run names none.
 *
 * `null` — no per-round stop. Deliberately not a number: a shipped default here
 * would silently cap every existing run's rounds at a figure nobody chose, and
 * the phase budget already bounds the whole phase. The round budget exists so an
 * operator can say "each attempt gets $20" for a loop that may run three times,
 * which no other setting can express.
 */
export const DEFAULT_QA_ROUND_BUDGET_USD = null;

/**
 * The last report's findings, read off disk and bounded.
 *
 * Empty string for a report that is not there — which is a real and common
 * state (a `pending` verdict has no report at all, and a reviewer may record a
 * verdict having written none). The caller says so in the prompt rather than
 * pretending: a fix session told "the findings are below" and handed nothing is
 * a session that will invent some.
 */
export function readQaFindings(handoffDir: string | undefined, report: string | undefined): string {
  if (!handoffDir || !report || report === '-') return '';
  let text = '';
  try { text = readFileSync(join(handoffDir, report), 'utf8'); } catch { return ''; }
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length <= QA_FINDINGS_MAX) return text;
  // Head and tail, with the cut named. A QA report leads with its findings and
  // ends with its verdict and follow-ups; dropping either end loses a different
  // half of what the fix session needs.
  const head = Math.floor(QA_FINDINGS_MAX * 0.7);
  const tail = QA_FINDINGS_MAX - head;
  return `${text.slice(0, head)}\n\n…[${text.length - QA_FINDINGS_MAX} characters of this report omitted]…\n\n${text.slice(-tail)}`;
}

/**
 * What the fix session is told — the `qa-recover` round's whole prompt body.
 *
 * Three things it must carry and one it must not. It carries the findings
 * verbatim (above), the exact `qa-record.sh` line with the round and report the
 * ONE chooser picked (never a literal — the four QA rounds of Phase 4 were four
 * different ways of getting that wrong), and the honest out: a finding that is
 * genuinely not this phase's is `waived` with a reason, in writing. What it must
 * NOT carry is permission to record `pass` over something unfixed, which is why
 * that sentence is here rather than left to the model's judgement.
 */
export function qaFixInstruction(input: {
  slug: string;
  phase: number;
  /** The round this session's reviewer will record. */
  round: number;
  /** The report that reviewer must write. */
  report: string;
  /** The report the fix is answering — the newest verdict on file. */
  priorReport?: string;
  findings?: string;
  /** Set on a `fresh` fix session: it has no conversation to continue. */
  fresh?: boolean;
}): string {
  const { slug, phase, round, report, priorReport, findings, fresh } = input;
  const head = fresh
    ? `You are picking up phase ${phase} of the "${slug}" plan because its recorded QA verdict is FAIL, and `
      + 'that verdict is holding every phase that depends on it. You did not build this phase; the findings '
      + 'below are the review of it, quoted in full.'
    : 'QA recorded a FAIL against this phase, and that verdict is holding every phase that depends on it. '
      + 'The findings are quoted below.';
  const where = priorReport
    ? `The report is \`docs/handoffs/${slug}/${priorReport}\`.`
    : 'No report file was found for that verdict.';
  const quoted = findings?.trim()
    ? `\n\n--- the QA report, verbatim ---\n${findings.trim()}\n--- end of the QA report ---\n`
    // Said plainly rather than papered over: a session told the findings are
    // below and handed nothing will invent some.
    : '\n\nThe report file could not be read, so there are no findings to quote — read it yourself, and if it '
      + 'is genuinely absent say so in the handoff rather than guessing what the reviewer meant.\n';
  return `${head} ${where}${quoted}
Fix what it found, re-run the phase's §Verification until it is green, commit, then dispatch a fresh-context QA subagent again and record the new verdict:

    bash scripts/qa-record.sh ${slug} ${phase} <pass|fail|waived> --report ${report} --round ${round}

The reviewer is work inside YOUR turn: wait for it in the foreground and record its verdict before you end — a turn that ends while it is still running records nothing, however good the fix.
If a finding is genuinely out of scope for this phase, say so in the handoff's Outstanding section and record \`waived --reason "<why>"\` — do not record \`pass\` over a finding you did not clear.`;
}

/**
 * Is this round's spend over the round budget?
 *
 * `>=`, and no budget at all when the cap is null — `overDayCap`'s reading, for
 * its reason. A cap of exactly zero is reached the instant it is set.
 */
export function overRoundBudget(spentUsd: number, capUsd: number | null | undefined): boolean {
  return typeof capUsd === 'number' && spentUsd >= capUsd;
}

/**
 * A round's spend allowance — the run's per-round budget when it has one, else
 * the phase budget's remainder, else nothing.
 *
 * The per-round budget is a hard stop for the ROUND and never for the run, which
 * is the whole reason it exists as a separate number: a loop under a phase
 * budget alone spends the phase's entire allowance on round one and the second
 * round has nothing left to fix anything with.
 */
export function roundBudgetUsd(
  roundCap: number | null | undefined,
  phaseBudgetUsd: number | null | undefined,
): number | null {
  if (typeof roundCap === 'number' && roundCap > 0) return roundCap;
  return typeof phaseBudgetUsd === 'number' ? phaseBudgetUsd : null;
}

/** A verdict that RELEASES the gate — the two words `_is_verified` accepts. */
export function releasesGate(verdict: string | undefined | null): boolean {
  return verdict === 'pass' || verdict === 'waived';
}

/**
 * The one errand a spent round budget leaves, naming the LAST report.
 *
 * Not `errandFor`'s job, because this loop is not a ladder rung: it was asked
 * for by name, it kept its own count, and the operator who pressed it is the one
 * being answered. What it shares with the ladder is the shape — need, how — and
 * the rule that the ask names the report describing the code AS IT STANDS, never
 * the one that started the loop.
 */
export function qaExhaustedErrand(input: {
  phase: number;
  rounds: number;
  maxRounds: number;
  report?: string;
  spentUsd?: number;
  at?: string;
}): { phase: number; situation: string; tried: string[]; need: string; how: string; at: string } {
  const { phase, rounds, maxRounds, report, spentUsd, at = new Date().toISOString() } = input;
  const spent = typeof spentUsd === 'number' && spentUsd > 0 ? ` and $${spentUsd.toFixed(2)}` : '';
  return {
    phase,
    situation: 'qa-failed',
    tried: Array.from({ length: rounds }, (_, i) => `qa round ${i + 1} → fail`),
    need: `A QA verdict of pass or waived for phase ${phase}. Fix & re-QA spent ${rounds} of the `
      + `${maxRounds} rounds this run allows${spent} and every one of them failed, so it has stopped asking. `
      + 'The recorded fail holds every dependent phase.',
    how: (report
      ? `Read ${report} — it describes the code as it stands, not as the loop found it — and decide: `
      : 'Read the latest QA report and decide: ')
      + 'press **Fix & re-QA** again with a stronger model or a bigger round budget, **Waive with a reason** '
      + 'if the remaining findings do not apply to this phase, or fix it by hand and press **Re-run QA**. '
      + 'Three rounds that all failed is usually evidence that nobody is converging rather than that one more '
      + 'round would do it.',
    at,
  };
}

/**
 * What a QA rung tells the phase's OWN session — the one builder for both
 * readers of the rung table.
 *
 * The healer's `vehicleForRung` (`service-runs.ts`) and the drive loop's
 * `hintFor` (`runner.ts`) climb the same `resume-own-session {qa-verdict|qa-fix}`
 * rungs, and each composed its own brief: the healer an inline paragraph with
 * no findings, the drive loop nothing at all — a finished phase resumed with
 * the generic "you were interrupted, carry on", which is the measured shape
 * of "the session never effectively ran". The round and its report come from
 * the ONE chooser (`nextQaRound`), the findings ride verbatim, and the two
 * callers cannot drift apart again.
 */
export function qaRungInstruction(
  mode: 'qa-verdict' | 'qa-fix',
  slug: string,
  phase: number,
  handoffDir: string | undefined,
  /** The verdict already on file, for a re-review's honest opening sentence. */
  recorded?: string,
): string {
  const { round, report } = nextQaRound(handoffDir, phase);
  if (mode === 'qa-verdict') return qaVerdictInstruction(slug, phase, round, report, recorded);
  const priorReport = qaReportPath(phase, Math.max(1, round - 1));
  return qaFixInstruction({
    slug, phase, round, report, priorReport,
    findings: readQaFindings(handoffDir, priorReport),
  });
}
