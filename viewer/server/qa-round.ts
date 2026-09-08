/**
 * Which QA round is next for a phase, and which report file it must write.
 *
 * ## Why this is a module and not four good intentions
 *
 * Six places in this system have to answer that question, and QA failed this
 * phase four times running because they were fixed one at a time: the engine's
 * `--qa-prompt`, its `--boot-prompt`, the interactive launcher (`service.ts`),
 * the warm at-finish chase (`runner-attempt.ts`), and BOTH QA rungs of the
 * ladder (`service-runs.ts`). Each round of review found the sites it named
 * fixed and one more still answering `round 1` — and the cost of a wrong answer
 * is not cosmetic: a reviewer handed a filename that already exists overwrites
 * a committed report, which is the exact defect rounds were introduced to end.
 *
 * So there is one implementation per language now, and nothing else may build a
 * report path. `test/qa-round.test.ts` enforces both halves of that: it scans
 * `server/` for any other file that spells a `reports/phase-NN-qa…` literal,
 * and it holds this module equal to `qa_next_round()` in `scripts/phase-graph.sh`
 * over a corpus of every table shape that exists in the wild. Two halves held by
 * a parity test is the same discipline `shared/scope.js` and `scripts/scope.sh`
 * keep, for the same reason: the bash engine must answer with no node on PATH.
 *
 * ## The rule, in one place
 *
 * The next round is **the highest round on file, plus one, then advanced past
 * any report already on disk**. Each clause is there because something broke
 * without it:
 *
 * - **Highest, not count.** A ledger upgraded from a legacy table starts at
 *   round 2, so counting rows said "2" about a round already recorded.
 * - **The ledger first, the status row only as fallback.** The status row holds
 *   one verdict, and the moment it reads `pending` it has forgotten every round
 *   behind it — which made the launcher answer 1 where the engine answered 3.
 * - **A legacy row carries its round in its FILENAME.** `-roundN.md` is the only
 *   record a three-column row keeps, and reading them all as round 1 is what
 *   sent a reviewer to a file that already existed.
 * - **A `pending` row is roundless**, whatever its cells say (the writer refuses
 *   `--round` with it), and so is a `waived` row with no report and no Round
 *   cell: the latter is the mid-plan activation backfill, which means "finished
 *   before QA was on and nobody reviewed it". **An explicit Round cell on a
 *   verdict row is authoritative** in both halves — QA round 4 found a numbered
 *   waiver discarded by the engine and counted by the launcher.
 * - **Then the disk.** "Wrote a report, recorded nothing" is a first-class
 *   outcome the runner journals, and it leaves a file no row anywhere mentions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseQaRounds, parseTestStatus } from './parse/folder.ts';

/**
 * How many candidate filenames to probe before giving up and using the last.
 *
 * The filesystem is a hint here, not an authority: it catches the reviewer who
 * wrote a report and recorded nothing, and it must never be able to spin. Ten
 * is far past any real phase — the deepest measured is five.
 */
const MAX_PROBES = 20;

/**
 * Where round R's report lives, relative to the plan's handoff folder.
 *
 * Round 1 keeps the plain name so every path already recorded stays correct;
 * every later round carries its own. **This is the only place in `server/` that
 * may build one of these paths** — see the module docstring.
 */
export function qaReportPath(phase: number, round = 1): string {
  const pad = String(phase).padStart(2, '0');
  return round > 1 ? `reports/phase-${pad}-qa-round${round}.md` : `reports/phase-${pad}-qa.md`;
}

/** The highest round `test-status.md` records for a phase, or 0. */
export function highestQaRound(text: string, phase: number): number {
  const ledger = parseQaRounds(text).filter((row) => row.phase === phase);
  if (ledger.length) return Math.max(...ledger.map((row) => row.round));
  // No ledger — a table written before rounds existed, where the status row is
  // the only witness. `QaRow.round` is deliberately `undefined` when the row
  // does not SAY (no cell, no `-roundN.md`), because a parser must not invent a
  // number the file does not carry. The chooser must, though: a `fail` on file
  // with a plainly-named report is a review that happened, and calling it zero
  // would hand the next reviewer that same plain name.
  const row = parseTestStatus(text).find((entry) => entry.phase === phase);
  if (!row) return 0;
  if (row.round) return row.round;
  // The two rows that are no round at all — the same pair `qa_history()` and
  // `parseTestStatus` exclude. `pending` is the absence of a review; a `waived`
  // row with no report is the mid-plan activation backfill, which means the
  // phase finished before QA was on and nobody reviewed it.
  if (row.result === 'pending' || (row.result === 'waived' && !row.report)) return 0;
  if (row.result === 'pass' || row.result === 'fail' || row.result === 'waived') return 1;
  return 0;
}

/**
 * The next round for a phase and the report it must write.
 *
 * `handoffDir` absent, missing or unreadable answers round 1 — the honest
 * degradation, and the same one the engine has: a plan with no `test-status.md`
 * has had no rounds.
 */
export function nextQaRound(handoffDir: string | undefined, phase: number): { round: number; report: string } {
  let round = 1;
  if (handoffDir) {
    try {
      round = highestQaRound(readFileSync(join(handoffDir, 'test-status.md'), 'utf8'), phase) + 1;
    } catch { round = 1; }
    for (let probe = 0; probe < MAX_PROBES; probe += 1) {
      if (!existsSync(join(handoffDir, qaReportPath(phase, round)))) break;
      round += 1;
    }
  }
  return { round, report: qaReportPath(phase, round) };
}

/** One row of `--qa-history`, as every reader of it holds it. */
export type QaHistoryRow = { round: number; verdict: string; reportPath?: string };

/**
 * The engine's `--qa-history` output — tab-separated `round result report
 * recorded`, one line per round, oldest first — as rows.
 *
 * ONE parser: the runner counted the budget from it and the healer's sweep
 * refreshed nothing from it, so a round recorded by a resumed session, by
 * hand or from another clone reached the record only when the ladder next
 * climbed. Empty on every failure mode there is (no engine, no plan, no
 * ledger, a phase nobody reviewed) — every caller uses the length to NUMBER
 * the next round, and under-counting names a report file that may already
 * exist, which a reviewer can see, while over-counting invents a gap nobody
 * can explain.
 */
export function parseQaHistory(stdout: string): QaHistoryRow[] {
  const rows: QaHistoryRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [round, verdict, report] = line.split('\t');
    if (!/^\d+$/.test(round ?? '')) continue;
    rows.push({
      round: Number(round),
      verdict: (verdict ?? '').trim().toLowerCase(),
      ...(report && report.trim() && report.trim() !== '-' ? { reportPath: report.trim() } : {}),
    });
  }
  return rows;
}
