/**
 * `verify:<slug>/<N>` — a phase waits on its OWN red §Verification lines going
 * green (control-tower phase 88, #129's 2026-09-25 11:55:44Z comment).
 *
 * P41 declared a wait on sibling P43's handoff reading `complete`; a private
 * clone showed it needed THREE siblings' reds cleared. A `phase:` ref on P43
 * would have landed and re-boarded P41 into the two reds left. What the phase
 * really waited for was its own §Verification passing, and only re-running it
 * can say so. So this ref:
 *
 *   - reads the phase's RED lines — the console's own last verdict, else the
 *     session's red proofs (`phase-outcome.sh … verified --exit N`), else the
 *     phase's whole §Verification (`redLinesOf`);
 *   - re-runs them only when the branch head MOVES — never twice on one head,
 *     since nothing that could turn them green has happened — through the same
 *     policy and spawn a §Verification command gets (`runSingleCommand`), in
 *     the phase's own tree, as a job of its own: the watch pass never waits on
 *     a suite, it reads the job's answer on a later pass;
 *   - lands only when every red line passes on one head.
 *
 * What it costs: a `git rev-parse` per ask and the red lines once per new
 * head. It spends no wait budget (`BUDGET_FREE_SCHEMES`): its clock is the
 * branch, which moves only when somebody commits.
 */

import { foldCommand } from './runner/verify.ts';
import type { Proof } from './runner/proofs.ts';
import type { PhaseRecord } from './runner/state.ts';
import type { WatchRefTarget, WatchState } from './watch-refs.ts';

/** Where a phase's red lines were read from — `none` when nothing says what to re-run. */
export type RedLinesSource = 'console' | 'session' | 'plan' | 'none';

/** How long one red line may run on a new head before it is cut and read as still red. */
export const VERIFY_WATCH_TIMEOUT_MS = 30 * 60_000;

/**
 * The declaring phase's red lines, and the head they were red at when that is
 * known. The console's own verdict first — the last attempt of each command
 * that did not pass (a timeout is not a red, #95); else the session's own red
 * proofs; else the whole §Verification, since re-running every line is the
 * conservative superset of "the red ones".
 */
export function redLinesOf(
  record: Pick<PhaseRecord, 'verification'>,
  proofs?: ReadonlyMap<string, Proof> | null,
  planLines?: readonly string[] | null,
): { lines: string[]; from: RedLinesSource; head: string | null } {
  const ran = record.verification?.ran ?? [];
  if (ran.length) {
    const last = new Map<string, (typeof ran)[number]>();
    for (const run of ran) last.set(foldCommand(run.command), run);
    const red = [...last.values()].filter((run) => !run.ok && !run.timedOut && !run.proven);
    if (red.length) return { lines: red.map((run) => foldCommand(run.command)), from: 'console', head: red[0].tree?.head ?? null };
    if (record.verification?.ok) return { lines: [], from: 'console', head: null };
  }
  const redProofs = [...(proofs?.values() ?? [])].filter((proof) => proof.code !== 0);
  if (redProofs.length) return { lines: redProofs.map((proof) => proof.command), from: 'session', head: redProofs[0].head ?? null };
  const whole = (planLines ?? []).map(foldCommand).filter(Boolean);
  if (whole.length) return { lines: whole, from: 'plan', head: null };
  return { lines: [], from: 'none', head: null };
}

export type VerifyLookup = {
  record: Pick<PhaseRecord, 'verification' | 'status' | 'phase'>;
  /** The directory the phase's §Verification runs in — its tree plus `Verify in:`. */
  cwd: string;
  proofs?: ReadonlyMap<string, Proof> | null;
  planLines?: readonly string[] | null;
};

export type VerifyWatchDeps = {
  lookup: (slug: string, phase: number) => Promise<VerifyLookup | null> | VerifyLookup | null;
  /** The branch head at `cwd`, or null when git cannot name it. */
  head: (cwd: string) => Promise<string | null>;
  /** One line under the §Verification policy — `runSingleCommand`. */
  run: (command: string, cwd: string, timeoutMs: number) => Promise<{ ok: boolean; refused?: string; detail?: string }>;
};

type Memo = { head: string; verdict: WatchState; job?: Promise<void> };

const short = (sha: string): string => sha.slice(0, 8);

export class VerifyWatch {
  private deps: VerifyWatchDeps;
  /** Per ref: the head last judged and what it said — in memory; a restart re-runs once. */
  private memo = new Map<string, Memo>();

  constructor(deps: VerifyWatchDeps) {
    this.deps = deps;
  }

  /** Settles when every job started so far has — the harness seam. */
  async settled(): Promise<void> {
    await Promise.all([...this.memo.values()].map((memo) => memo.job).filter(Boolean));
  }

  async probe(target: Extract<WatchRefTarget, { kind: 'verify' }>): Promise<WatchState> {
    const ref = target.ref;
    const found = await this.deps.lookup(target.slug, target.phase);
    if (!found) return { ref, state: 'unknown', detail: `no run record of ${target.slug} phase ${target.phase}` };
    const red = redLinesOf(found.record, found.proofs, found.planLines);
    if (!red.lines.length) {
      return red.from === 'console'
        ? { ref, state: 'landed', detail: `phase ${target.phase}'s §Verification is green` }
        : { ref, state: 'unknown', detail: 'no §Verification line on record to re-run' };
    }
    const head = await this.deps.head(found.cwd);
    if (!head) return { ref, state: 'unknown', detail: `the branch head at ${found.cwd} could not be read` };
    const memo = this.memo.get(ref);
    if (memo?.job) return { ref, state: 'pending', detail: `re-running ${red.lines.length} red line${red.lines.length === 1 ? '' : 's'} at ${short(memo.head)}` };
    if (memo && memo.head === head) return memo.verdict;
    // First sight: the head the red was measured at, when the evidence names
    // one, is the one to move off; otherwise this head is the baseline.
    const baseline = memo ? memo.head : red.head ?? head;
    if (baseline === head) {
      const verdict: WatchState = { ref, state: 'pending', detail: `red at ${short(head)} — re-run when the branch head moves` };
      this.memo.set(ref, { head, verdict });
      return verdict;
    }
    const lines = red.lines;
    const entry: Memo = {
      head,
      verdict: { ref, state: 'pending', detail: `re-running ${lines.length} red line${lines.length === 1 ? '' : 's'} at ${short(head)}` },
    };
    entry.job = (async () => {
      let verdict: WatchState = { ref, state: 'landed', detail: `green at ${short(head)}: ${lines.join(' · ')}`.slice(0, 160) };
      for (const line of lines) {
        let answer: { ok: boolean; refused?: string; detail?: string };
        try { answer = await this.deps.run(line, found.cwd, VERIFY_WATCH_TIMEOUT_MS); } catch (error) {
          answer = { ok: false, detail: String((error as Error)?.message ?? error) };
        }
        if (answer.refused) { verdict = { ref, state: 'refused', detail: `${line}: ${answer.refused}`.slice(0, 160) }; break; }
        if (!answer.ok) { verdict = { ref, state: 'pending', detail: `still red at ${short(head)}: ${line}${answer.detail ? ` — ${answer.detail}` : ''}`.slice(0, 160) }; break; }
      }
      entry.verdict = verdict;
    })().finally(() => { delete entry.job; });
    this.memo.set(ref, entry);
    return entry.verdict;
  }
}
