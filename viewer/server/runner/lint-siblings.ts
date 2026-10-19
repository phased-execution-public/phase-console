/**
 * The post-finish lint's one exemption (#225): a SIBLING's half-written handoff.
 *
 * `validate.sh` lints the whole plan, and a sibling lane still live in the same
 * `docs/handoffs/` may be between scaffolding its handoff `complete` and writing
 * the body. That transient state used to charge the phase that had just finished
 * a `plan-lint` failure, mark its green verification `failed` and halt the run —
 * for a problem that was neither its own nor, a few minutes later, anyone's.
 *
 * The rule: a lint failure is SKIPPED (journalled `phase.lint-sibling-skipped`,
 * never charged) only when EVERY problem it counts is a sibling's handoff whose
 * lock is live and whose "What this phase did" is still the template. One
 * problem of any other kind — the finishing phase's own, a sibling's that is not
 * live, a plan defect — and the halt stands as before.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseHandoff } from '../parse/handoff.ts';
import { readLock } from '../store.ts';

/** The phase a problem line is about: the lint's `phase N: …`, validate's `✗ phase-NN-….md: …`. */
export function issuePhaseOf(line: string): number | undefined {
  const text = line.trim().replace(/^[✗⚠]\s*/, '');
  const lint = /^phase (\d+):/.exec(text);
  if (lint) return Number(lint[1]);
  const file = /^phase-(\d+)[^\s:]*\.md:/.exec(text);
  return file ? Number.parseInt(file[1]!, 10) : undefined;
}

/** A line the verdict COUNTS that a half-written handoff produces — never an advisory. */
function scaffoldProblem(line: string): boolean {
  const text = line.trim();
  return /^phase \d+: handoff-scaffold-complete\b/.test(text) || /^✗ phase-\d+[^\s:]*\.md:/.test(text);
}

/** What was skipped, for the journal; null when the halt stands. */
export type SiblingLintSkip = { phases: number[]; lines: string[] };

/**
 * Whether a failing verdict is wholly a live sibling's half-written handoff.
 * `summary` is `readLint`'s verdict line, whose count is what every problem
 * line must be accounted for against; `halfWritten(M)` answers for phase M.
 */
export function siblingLintSkip(
  lint: { summary: string; issues: readonly string[] },
  phase: number,
  halfWritten: (sibling: number) => boolean,
): SiblingLintSkip | null {
  const counted = /^LINT FAIL: .* \((\d+) issue/.exec(lint.summary) ?? /^VALIDATE FAIL: .* — (\d+) handoff problem/.exec(lint.summary);
  const count = counted ? Number(counted[1]) : 0;
  if (!count) return null;
  const memo = new Map<number, boolean>();
  const lines = lint.issues.filter((line) => {
    const sibling = issuePhaseOf(line);
    if (sibling === undefined || sibling === phase || !scaffoldProblem(line)) return false;
    if (!memo.has(sibling)) memo.set(sibling, halfWritten(sibling));
    return memo.get(sibling)!;
  });
  if (lines.length !== count) return null;
  return { phases: [...new Set(lines.map((line) => issuePhaseOf(line)!))].sort((a, b) => a - b), lines };
}

/**
 * Phase `sibling`'s handoff is half-written: its lock is live (held, lease not
 * elapsed) and its newest handoff's "What this phase did" is still the template.
 */
export function handoffHalfWritten(docsRoot: string, slug: string, sibling: number, now = Date.now()): boolean {
  const handoffs = join(docsRoot, 'docs', 'handoffs');
  const lock = readLock(handoffs, slug, sibling, now);
  if (!lock || lock.expired) return false;
  const dir = join(handoffs, slug);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((name) => {
    const m = /^phase-(\d+)-.*\.md$/.exec(name);
    return m !== null && Number.parseInt(m[1]!, 10) === sibling;
  });
  if (!files.length) return false;
  // The newest, as the board reads it (F21's handoff side).
  const newest = files
    .map((name) => ({ name, stat: statSync(join(dir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]!;
  const path = join(dir, newest.name);
  const handoff = parseHandoff(readFileSync(path, 'utf8'), slug, newest.name, path, newest.stat);
  return handoff.scaffold;
}
