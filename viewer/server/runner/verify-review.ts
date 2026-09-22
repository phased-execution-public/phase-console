/**
 * The verification REVIEW: one prediction of what boarding and verification
 * will do with a phase's §Verification — asked before a session is bought.
 *
 * Run f0da619a (2026-09-18) halted on a `bats` line because five readers of
 * one rule asked five weaker questions. Lint F14 asked "is any backtick span
 * lettered?", the start response "is anything runnable?", the plan page said
 * "a person MAY be asked", plan health counted zero commands, and the launch
 * door asked nothing — while boarding parked on ANY fragment it would not run
 * under `Person-check: halt`. Every reader now asks this function, which asks
 * the SAME `extractCommands` and `unresolvableLeads` the runner executes with,
 * under the same answers, and writes the SAME park sentence boarding writes —
 * so "the door said clear" and "boarding parked" cannot disagree.
 *
 * Pure: it runs nothing, and it names no journal event. The verdicts, in the
 * order boarding decides them:
 *
 *   - `parks`   — nothing runnable (whatever the Person-check), `halt` with a
 *                 fragment left over, or every command's lead missing here;
 *   - `asks`    — a fragment left over under `halt-on-everything`: a person is
 *                 asked at verification, always;
 *   - `may-ask` — a fragment left over under an owner (the shipped `operator`):
 *                 asked only on a red the board does not vouch for;
 *   - `records` — `Person-check: allow` waives them by policy;
 *   - `clear`   — nothing left over.
 */

import type { RunVerifyApprovals, VerifyNotRun } from './state.ts';
import {
  DEFAULT_PREFLIGHT_SKIP, extractCommands, resolveLead, unresolvableLeads, type VerifyApprovals,
} from './verify.ts';

/**
 * One phase's answers, as the extractor reads them: every approved text (an
 * approval is of a command, wherever it appears) and this phase's waivers.
 */
export function approvalsForPhase(
  answers: RunVerifyApprovals | undefined, phase: number,
): VerifyApprovals | undefined {
  if (!answers) return undefined;
  const approve = new Set(answers.approve.map((entry) => entry.fp));
  const waive = new Set(answers.waive.filter((entry) => entry.phase === phase).map((entry) => entry.fp));
  return approve.size || waive.size ? { approve, waive } : undefined;
}

/**
 * A launch draft's answers — fingerprints, as the Decisions stage sends them —
 * resolved against the reviews into what the run stores: exact texts, and
 * only for what an answer can carry. An `approve` fp must name a command an
 * approval would make run (never the deny wall); a `waive` entry
 * `<phase>:<fp>` must name a fragment of THAT phase. Anything else answers
 * nothing — the draft is a request, the reviews are the facts.
 *
 * `reviews` are the bare reviews, computed WITHOUT answers, so every
 * approvable command is still among their items.
 */
export function resolveVerifyAnswers(
  reviews: readonly PhaseReview[],
  draft: { approve?: readonly string[]; waive?: readonly string[] } | undefined,
): RunVerifyApprovals | undefined {
  if (!draft) return undefined;
  const approvable = new Map<string, string>();
  for (const review of reviews) {
    for (const item of [...review.items, ...review.setup]) {
      if (item.approvable && item.fp) approvable.set(item.fp, item.text);
    }
  }
  const approve = [...new Set(draft.approve ?? [])]
    .filter((fp) => approvable.has(fp))
    .map((fp) => ({ fp, text: approvable.get(fp)! }));
  const waive: RunVerifyApprovals['waive'] = [];
  for (const entry of new Set(draft.waive ?? [])) {
    const match = /^(\d+):([0-9a-f]{64})$/.exec(entry);
    if (!match) continue;
    const phase = Number(match[1]);
    const item = reviews.find((review) => review.phase === phase)?.items.find((candidate) => candidate.fp === match[2]);
    if (item) waive.push({ phase, fp: match[2], text: item.text });
  }
  return approve.length || waive.length ? { approve, waive } : undefined;
}

export type ReviewVerdict = 'clear' | 'records' | 'may-ask' | 'asks' | 'parks';

export type ReviewInput = {
  phase: number;
  /** The phase's §Verification text, as the plan parser hands it over. */
  verification: string | undefined;
  /** The phase's `- **Setup:**` text, when it has one. */
  setup?: string;
  /** Does the plan WRITE a §Verification bullet at all (whatever the parser made of it)? */
  declared: boolean;
  /** The phase's Person-check answer — `allow`, `halt`, an owner, or null for the shipped `operator`. */
  personCheck: string | null;
  autonomy?: string;
  /** This phase's answers: the exact commands approved, the fragments waived. */
  approvals?: VerifyApprovals;
  /** `allowUnverifiedPhases`: a phase whose plan OMITS the bullet boards and passes on its handoff. */
  allowUnverified?: boolean;
  pathEnv?: string;
  preflightSkip?: ReadonlySet<string>;
  /**
   * Ask about the PLAN alone. Plan health describes the plan; a missing binary
   * is a fact about this machine, which the launch door and boarding ask.
   */
  skipPathProbe?: boolean;
  /** Test seam: overrides the on-disk executability probe. Production never sets it. */
  canExecute?: (lead: string) => boolean;
};

export type PhaseReview = {
  phase: number;
  verdict: ReviewVerdict;
  /** The sentence boarding writes on the record when the verdict is `parks`. */
  park?: string;
  /** Nothing will verify this phase and that is by answer (the opt-in, or every check waived) — the caller journals it. */
  unverified?: boolean;
  /** The commands the runner will execute. */
  runs: string[];
  /** Fragments it will not run and nobody has answered. */
  items: VerifyNotRun[];
  /** Fragments the run's answers set aside. */
  waived: VerifyNotRun[];
  /** Setup commands it will not run — shown, never a park (bring-up cannot colour a phase red). */
  setup: VerifyNotRun[];
  /** Leads of `runs` this machine's PATH cannot resolve: SKIPPED at verification. */
  missing: string[];
  personCheck: string | null;
};

/**
 * The durable PATH fix, which differs by tier: both trees are started from a
 * shell, and only the Pro tree also has an agent whose installer bakes a
 * cleaned PATH into the unit. Assembled from a list so the free tree gets the
 * first sentence alone rather than a pointer to a script it does not ship.
 */
export const PATH_FIX_HINT = [
  ' (start the console from a full shell',
  ')',
].join('');

/** The park for a phase whose every command's lead this machine lacks — boarding and verification write it alike. */
export function allLeadsMissingPark(phase: number, leads: readonly string[]): string {
  return `phase ${phase}'s §Verification cannot run on this machine — every command's lead `
    + `is missing from the PATH (${leads.join(', ')}). Fix the PATH${PATH_FIX_HINT}, rewrite the bullet `
    + 'with what exists, or Repair with AI, then Retry.';
}

/**
 * The park `Person-check: halt` writes — naming the command AND why it was
 * refused. The sentence it replaces printed the fragment alone ("written as
 * prose (first: bats tests/unit/landing.bats …)"), which hid the one fact that
 * explained the halt: "`bats` is not a recognised command".
 */
function haltPark(phase: number, items: readonly VerifyNotRun[]): string {
  const first = items[0];
  const remedy = items.some((item) => item.approvable)
    ? 'approve the exact command when the run is started again (the Decisions stage lists it), '
      + 'fix the bullet, or change the phase\'s Person-check, then Retry.'
    : 'fix the bullet into runnable commands, or change the phase\'s Person-check, then Retry.';
  return `phase ${phase}'s §Verification holds ${items.length} check${items.length === 1 ? '' : 's'} `
    + `the runner will not run (first: ${first.text.slice(0, 120)} — ${first.reason}) `
    + `and the plan says Person-check: halt — ${remedy}`;
}

export function reviewPhase(input: ReviewInput): PhaseReview {
  const { phase } = input;
  const text = input.verification;
  const { commands, notRun, waived } = extractCommands(text, 'verify', input.approvals);
  const setup = input.setup?.trim() ? extractCommands(input.setup, 'setup', input.approvals).notRun : [];
  const base = {
    phase, runs: commands, items: notRun, waived, setup, missing: [] as string[], personCheck: input.personCheck,
  };

  if (!commands.length) {
    // Every check the plan wrote was set aside by the run's own answers: the
    // operator decided at the door that this phase is proved by its handoff.
    if (!notRun.length && waived.length) return { ...base, verdict: 'clear', unverified: true };
    if (text?.trim()) {
      // "0 entries refused" was reachable and read like a bug: a §Verification
      // holding only an environment preamble refuses nothing and runs nothing.
      const specimen = notRun[0];
      return {
        ...base,
        verdict: 'parks',
        park: `phase ${phase}'s §Verification contains nothing the runner can execute — `
          + (notRun.length
            ? `${notRun.length} entr${notRun.length === 1 ? 'y' : 'ies'} refused`
              + (specimen ? ` (first: ${specimen.reason})` : '')
            : 'it sets up an environment but never runs a check')
          + '. Fix the plan bullet into whole, copy-runnable commands, then Retry.',
      };
    }
    // The parser handed over nothing — a plan that DECLARES the bullet sends the
    // author to their formatting, one that omits it to their keyboard.
    if (input.declared) {
      return {
        ...base,
        verdict: 'parks',
        park: `phase ${phase}'s §Verification exists in the plan but the console could not read `
          + 'a runnable command out of it — check the bullet\'s shape against '
          + 'references/plan-format.md §6, or Repair with AI, then Retry.',
      };
    }
    if (input.allowUnverified) return { ...base, verdict: 'clear', unverified: true };
    return {
      ...base,
      verdict: 'parks',
      park: `the plan states no verification for phase ${phase} — nothing would prove the work. `
        + 'Add a §Verification command to the plan, then Retry.',
    };
  }

  // The plan's word for a fragment it will not run (ZTD-6): `halt` stops the
  // phase HERE, before a session is paid for.
  if (notRun.length && input.personCheck === 'halt') {
    return { ...base, verdict: 'parks', park: haltPark(phase, notRun) };
  }

  const missing = input.skipPathProbe ? new Map<string, string>() : unresolvableLeads(
    commands, input.pathEnv ?? process.env.PATH, input.preflightSkip ?? DEFAULT_PREFLIGHT_SKIP, input.canExecute);
  const found = { ...base, missing: [...missing.keys()] };
  // When EVERY command's lead is missing, boarding would buy a session whose
  // verification cannot run at all.
  if (missing.size && !commands.some((command) => {
    const lead = resolveLead(command);
    return !lead || !missing.has(lead);
  })) {
    return { ...found, verdict: 'parks', park: allLeadsMissingPark(phase, found.missing) };
  }

  if (!notRun.length) return { ...found, verdict: 'clear' };
  if (input.personCheck === 'allow') return { ...found, verdict: 'records' };
  if (input.autonomy === 'halt-on-everything') return { ...found, verdict: 'asks' };
  return { ...found, verdict: 'may-ask' };
}
