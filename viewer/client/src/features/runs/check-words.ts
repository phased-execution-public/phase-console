/**
 * The words a console check is drawn with on every lane surface — the board's
 * check row, the Sessions list and the header (control-tower phases 89 and
 * 105, #193). A module of its own, outside `lanes-model.ts`: that one rides
 * first paint, and these are read only by surfaces that load after it.
 */
import type { RunState, VerifyingLane } from '@/lib/api';
import { runChecks } from './lanes-model';

/**
 * What each console check is called — one table for every lane surface (the
 * board's check row, the Sessions list, the header), moved here from the row
 * that first drew it (control-tower phases 89 and 105).
 */
export const CHECK_PURPOSE_WORDS: Readonly<Record<VerifyingLane['purpose'], string>> = {
  verify: '§Verification',
  baseline: 'baseline',
  'wip-gate': 'wrap-up gate',
};

/** A check's pass and place in it: `baseline 9/10`, `baseline setup 1/1` (control-tower phase 105). */
export function checkProgress(check: Pick<VerifyingLane, 'purpose' | 'index' | 'total' | 'stage'>): string {
  const purpose = CHECK_PURPOSE_WORDS[check.purpose] ?? check.purpose;
  return `${purpose}${check.stage === 'setup' ? ' setup' : ''} ${check.index}/${check.total}`;
}

/** A check as a lane's label: `baseline 9/10 · pytest tests/unit …` (#193). */
export function checkLabel(
  check: Pick<VerifyingLane, 'purpose' | 'index' | 'total' | 'stage' | 'command'>,
): string {
  return `${checkProgress(check)} · ${check.command}`;
}

/**
 * The few words that say what a live run is working on, for the header: the
 * phase its session works (`phase 8`), or — when nothing but the console's
 * own check is running for it — the check (`P8 baseline 9/10`). Null when no
 * lane names a phase at all; never a question mark (control-tower phase 105,
 * #193: `running — phase ?` for the half hour a baseline held the lane).
 */
export function runFocusWords(
  run: Pick<RunState, 'activePhase' | 'verifying' | 'children' | 'child'>,
): string | null {
  const checks = runChecks(run);
  const sessions = new Set<number>([
    ...Object.values(run.children ?? {}).map((child) => child.phase),
    ...(run.child ? [run.child.phase] : []),
  ]);
  const phase = run.activePhase ?? [...sessions][0] ?? [...checks.keys()].sort((a, b) => a - b)[0] ?? null;
  if (phase == null) return null;
  const check = checks.get(phase);
  return check && !sessions.has(phase) ? `P${phase} ${checkProgress(check)}` : `phase ${phase}`;
}
