/**
 * One form's shape, and what each field is called on the wire.
 *
 * `RunSetupValues` is the whole vocabulary — every choice any launch surface
 * ever offered, in one object. A mode does not get its own type: it gets a
 * subset of these fields to SHOW (`modes.ts`) and a payload builder that reads
 * the same values. That is the point of the consolidation; four shapes with
 * four spellings of "which model" is what let a run start on a model nobody
 * chose.
 *
 * ## The wire map is the contract
 *
 * `WIRE` says which server field each value becomes, or `null` for the ones
 * that never reach a run door (`prompt` is a session's first message;
 * `permissionMode` belongs to an agent ticket). `schema-parity.test.ts` walks
 * it against `shared/run-settings.js` in both directions, so:
 *
 * - a field the server accepts and this form cannot send fails the test, and
 * - a field this form would send that no door reads fails it too.
 *
 * `shared/run-settings.js` in turn is held against the route module's own
 * source by `test/run-settings-parity.test.ts`. Three files, one list.
 *
 * ## Why the numbers are strings
 *
 * Budgets, `maxParallel` and `maxConsecutiveFailures` are `<input type=number>`
 * values, and an empty one is `''`, not `0`. The distinction is load-bearing on
 * every one of them — `''` means "no ceiling" and `0` means "never" — so they
 * stay text through the form and are coerced once, at the payload boundary,
 * where the meaning of empty can be stated per field.
 */

import * as z from 'zod/mini';
import type { Autonomy, McpPolicy, PermissionProfile, PhaseOptions, RelayMode } from '@/lib/api';
import { RELAY_MODES } from '@shared/run-settings.js';
import { RUN_PRIORITIES, type RunPriority } from '@shared/orchestration-model.js';
import {
  DEFAULT_RETENTION,
  DEFAULT_SETTLE,
  ISOLATION_MODES,
  SETTLE_STRATEGIES,
  WORKTREE_RETENTION,
  retentionOf,
  type IsolationMode,
  type SettleStrategy,
} from '@shared/worktree-model.js';
import {
  CONFLICT_POLICIES,
  DEFAULT_CONFLICT,
  DEFAULT_LAND,
  LAND_POLICIES,
  type ConflictPolicy,
  type LandPolicy,
} from '@shared/landing-model.js';
import { DEFAULT_MESSAGING, MESSAGING_WORDS, type MessagingWord } from '@shared/message-model.js';
import { DEFAULT_ISSUES, ISSUE_MODES, type IssueMode } from '@shared/issues-model.js';
import {
  AUTONOMY_MODES,
  GIT_MODES,
  MCP_POLICIES,
  ON_LIMIT_POLICIES,
  REVIEWER_POLICIES,
  ULTRA_REVIEW_MODES,
} from '@shared/run-lifecycle.js';
import type {
  AutonomyMode,
  GitMode,
  OnLimitPolicy,
  ReviewerPolicy,
  UltraReviewMode,
} from '@shared/run-lifecycle.js';

/** The one permission vocabulary. `plan` is offered to sessions only. */
export type PermissionChoice = PermissionProfile | 'plan';

export interface RunSetupValues {
  model: string;
  effort: string;
  autonomy: Autonomy;
  /** Guarded / Trusted / Bypass, plus `plan` where a session is being minted. */
  permissionProfile: PermissionChoice;
  /** A session's CLI `--permission-mode`, when the choice above does not spell it. */
  permissionMode: string;
  accountId: string;
  onLimit: OnLimitPolicy;
  phaseBudgetUsd: string;
  runBudgetUsd: string;
  gitMode: GitMode;
  openPr: boolean;
  /**
   * Whether this run gets a checkout of its own. Rendered only when
   * `gitMode === 'new-branch'` — a run with no branch has nothing to check out.
   */
  isolation: IsolationMode;
  /**
   * What happens to the finished branch. Rendered with `isolation`, and only
   * under `new-branch`, for the same reason: a run with no branch of its own
   * has nothing to settle.
   */
  settle: SettleStrategy;
  /**
   * The seven words many-plans-one-repo phase 15 gave the form. Every one is
   * ALSO a plan line (or a Settings default), and the plan outranks the run:
   * the word chosen here speaks only where the plan is silent, the
   * `mcpPolicy` precedent — the control's hint says so.
   *
   * `baseBranch` — what `pe/<slug>` and every lane branch are cut from
   * (`origin/HEAD`, `head`, or a ref); empty means "the plan's line, else the
   * console's preference". Immutable once the run's branch exists.
   * `maxConcurrentPerRepo` — how many isolated runs this run will stand
   * beside in its repository, clamped to the console's cap; empty means the
   * console's number. A `<input type=number>` value, so a string.
   * `worktreeRetention` — a `WORKTREE_RETENTION` word, or `ttl:<h>`.
   */
  baseBranch: string;
  maxConcurrentPerRepo: string;
  worktreeRetention: string;
  /** What a phase's commits do when it settles, where the plan is silent. */
  landing: LandPolicy;
  /** What a landing that will not merge cleanly does, where the plan is silent. */
  conflictPolicy: ConflictPolicy;
  /** Whether this run's sessions may message each other, where the plan is silent. */
  messaging: MessagingWord;
  /** Whether a session may open an issue outside its phase; tightens only, mid-run. */
  issuesMode: IssueMode;
  /** Which class this run's admissions are scanned in (`shared/orchestration-model.js`). */
  priority: RunPriority;
  /** A plan slug this run begins AFTER. Empty means no chain. Start-only. */
  startAfter: string;
  /** Launch a fresh reviewer session at each phase-finish (`server/reviewer.ts`). */
  reviewEachPhase: boolean;
  /** Whether a reviewer's `requested-changes` may actually hold dependents. */
  reviewerPolicy: ReviewerPolicy;
  /** Carry the standing `ultracode` licence into every prompt this run composes. */
  ultracode: boolean;
  /** When this run spends the operator's cloud budget on `claude ultrareview`. */
  ultraReview: UltraReviewMode;
  qa: boolean;
  /**
   * QA's own three. All optional-by-emptiness: `''` says nothing, and the
   * reviewer then keeps inheriting the builder's model and effort while the
   * round budget keeps its shipped default — which is what every run before
   * these existed did.
   */
  qaMaxRounds: string;
  qaModel: string;
  qaEffort: string;
  /**
   * QA RECOVERY's two — how a Fix & re-QA round boards its fix session, and
   * what ONE round may spend. Only the `qa-fix` mode shows them: they say
   * nothing about a run that is not recovering a verdict.
   */
  qaFixStrategy: string;
  qaRoundBudgetUsd: string;
  attachDefaultSkills: boolean;
  skills: string[];
  mcpServers: string[];
  mcpPolicy: McpPolicy;
  autoRecover: boolean;
  maxParallel: string;
  maxConsecutiveFailures: string;
  /** `"1,3,5-7"` — parsed at the payload boundary, so a half-typed range is not an error yet. */
  onlyPhases: string;
  phaseOptions: Record<string, PhaseOptions>;
  /** A session's first message. Never a run field. */
  prompt: string;
  /**
   * The prelude's answers (phase 11, the Decisions stage). `resumeOnRestart`
   * and `relay` are the run's own words for the `resume.on-restart` and `relay`
   * rows; `accounts` is the list it may spend as `id:minHeadroom%` pairs
   * (parsed at the payload boundary, like `onlyPhases`); `acknowledgedWaivers`
   * names the waived rows the operator has read; `manifestOverride` is the
   * name a person signs a start past a blocking row with — empty means none.
   */
  resumeOnRestart: boolean;
  relay: RelayMode;
  accounts: string;
  acknowledgedWaivers: string[];
  manifestOverride: string;
  /**
   * The answers to the prelude's verification probe (2026-09-18): the exact
   * commands, by fingerprint, the operator approves though the built-in tier
   * would not run them, and the fragments set aside as `<phase>:<fp>`.
   */
  verifyAnswers: { approve: string[]; waive: string[] };
}

export type RunSetupField = keyof RunSetupValues;

/**
 * What each value is called on a run door — `null` where it is not a run field.
 *
 * Every name on the right-hand side must appear in `shared/run-settings.js`,
 * and every field in that module must appear here. The test says so.
 */
export const WIRE: Readonly<Record<RunSetupField, string | null>> = Object.freeze({
  model: 'model',
  effort: 'effort',
  autonomy: 'autonomy',
  permissionProfile: 'permissionProfile',
  permissionMode: null,
  accountId: 'accountId',
  onLimit: 'onLimit',
  phaseBudgetUsd: 'phaseBudgetUsd',
  runBudgetUsd: 'runBudgetUsd',
  gitMode: 'gitMode',
  openPr: 'openPr',
  isolation: 'isolation',
  settle: 'settle',
  baseBranch: 'baseBranch',
  maxConcurrentPerRepo: 'maxConcurrentPerRepo',
  worktreeRetention: 'worktreeRetention',
  landing: 'landing',
  conflictPolicy: 'conflictPolicy',
  messaging: 'messaging',
  issuesMode: 'issuesMode',
  priority: 'priority',
  startAfter: 'startAfter',
  reviewEachPhase: 'reviewEachPhase',
  reviewerPolicy: 'reviewerPolicy',
  ultracode: 'ultracode',
  ultraReview: 'ultraReview',
  qa: 'qa',
  qaMaxRounds: 'qaMaxRounds',
  qaModel: 'qaModel',
  qaEffort: 'qaEffort',
  qaFixStrategy: 'qaFixStrategy',
  qaRoundBudgetUsd: 'qaRoundBudgetUsd',
  attachDefaultSkills: 'attachDefaultSkills',
  skills: 'skills',
  mcpServers: 'mcpServers',
  mcpPolicy: 'mcpPolicy',
  autoRecover: 'autoRecover',
  maxParallel: 'maxParallel',
  maxConsecutiveFailures: 'maxConsecutiveFailures',
  onlyPhases: 'onlyPhases',
  phaseOptions: 'phaseOptions',
  prompt: null,
  resumeOnRestart: 'resumeOnRestart',
  relay: 'relay',
  accounts: 'accounts',
  acknowledgedWaivers: 'acknowledgedWaivers',
  manifestOverride: 'manifestOverride',
  verifyAnswers: 'verifyAnswers',
});

/**
 * The two run fields no VALUE carries, because they are facts about the
 * launch rather than choices in it: which run to resume, and which phases a
 * "run only this" was scoped to. The payload builders add them from context.
 */
export const CONTEXT_FIELDS = Object.freeze(['resumeRunId']);

/**
 * The resolver's schema.
 *
 * Deliberately permissive on vocabulary — the server re-validates every model
 * name against `scripts/models.env` and answers 400 with the reason, and a
 * client-side allow-list would refuse a name the CLI accepts the morning a new
 * model lands. What is checked here is what the server CANNOT explain as well
 * as the form can: a budget that is not a number, a parallel count outside the
 * console's own ceiling, a phase list that is not a phase list.
 */
export const runSetupSchema = z.object({
  model: z.string(),
  effort: z.string(),
  autonomy: z.enum([...AUTONOMY_MODES] as [AutonomyMode, ...AutonomyMode[]]),
  permissionProfile: z.enum(['guarded', 'trusted', 'bypass', 'plan']),
  permissionMode: z.string(),
  accountId: z.string(),
  onLimit: z.enum([...ON_LIMIT_POLICIES] as [OnLimitPolicy, ...OnLimitPolicy[]]),
  phaseBudgetUsd: money('Budget per phase'),
  runBudgetUsd: money('Budget for the run'),
  gitMode: z.enum([...GIT_MODES] as [GitMode, ...GitMode[]]),
  openPr: z.boolean(),
  // From the owner list, not a second literal — `shared/worktree-model.js` is
  // the one place the two words are spelled, and `vocab-owners.test.ts` scans
  // this file for a copy of them.
  isolation: z.enum(ISOLATION_MODES as unknown as [IsolationMode, ...IsolationMode[]]),
  // From the owner list for the same reason isolation is — see above.
  settle: z.enum(SETTLE_STRATEGIES as unknown as [SettleStrategy, ...SettleStrategy[]]),
  // Phase 15's seven. A ref is free text (the two words that are questions,
  // `origin/HEAD` and `head`, are named by the owner but a branch name is
  // anything git accepts); the cap is a whole number the door clamps to the
  // console's; retention is asked of the owner's coercer because its
  // vocabulary is OPEN (`ttl:<h>` is a member with a parameter); the four
  // words are the owner lists, never a second literal.
  baseBranch: z.string().check(
    z.refine((text) => text.trim() === '' || !/\s/.test(text.trim()), {
      message: 'A base branch is one ref — origin/HEAD, head, or a branch name',
    }),
  ),
  maxConcurrentPerRepo: whole('Runs beside it in the repository', 1, 99),
  worktreeRetention: z.string().check(
    z.refine((text) => retentionOf(text) === text.trim().toLowerCase(), {
      message: `Retention is ${WORKTREE_RETENTION.join(', ')}, or ttl:<hours>`,
    }),
  ),
  landing: z.enum(LAND_POLICIES as unknown as [LandPolicy, ...LandPolicy[]]),
  conflictPolicy: z.enum(CONFLICT_POLICIES as unknown as [ConflictPolicy, ...ConflictPolicy[]]),
  messaging: z.enum(MESSAGING_WORDS as unknown as [MessagingWord, ...MessagingWord[]]),
  issuesMode: z.enum(ISSUE_MODES as unknown as [IssueMode, ...IssueMode[]]),
  // From the owner list for the same reason isolation is — see above.
  priority: z.enum(RUN_PRIORITIES as unknown as [RunPriority, ...RunPriority[]]),
  startAfter: z.string(),
  reviewEachPhase: z.boolean(),
  reviewerPolicy: z.enum([...REVIEWER_POLICIES] as [ReviewerPolicy, ...ReviewerPolicy[]]),
  ultracode: z.boolean(),
  // From the owner list, like the two enums above it: `shared/run-lifecycle.js`
  // is the one place these three words are spelled.
  ultraReview: z.enum(ULTRA_REVIEW_MODES as unknown as [UltraReviewMode, ...UltraReviewMode[]]),
  qa: z.boolean(),
  // The same ceiling the run door enforces, so a refusal is caught in the form
  // rather than as a 400 after the operator has pressed the button.
  qaMaxRounds: whole('QA rounds', 1, 20),
  qaModel: z.string(),
  qaEffort: z.string(),
  qaFixStrategy: z.string(),
  qaRoundBudgetUsd: money('Budget per QA round'),
  attachDefaultSkills: z.boolean(),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  mcpPolicy: z.enum([...MCP_POLICIES] as [McpPolicy, ...McpPolicy[]]),
  autoRecover: z.boolean(),
  maxParallel: whole('Max parallel', 1, 99),
  maxConsecutiveFailures: whole('Stop after N failures', 1, 50),
  onlyPhases: z.string().check(
    z.refine(
      (text) => text.trim() === '' || /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(text),
      {
        message: 'Phases look like 1, 3, 5-7',
      },
    ),
  ),
  phaseOptions: z.record(z.string(), z.any()),
  prompt: z.string(),
  resumeOnRestart: z.boolean(),
  // From the owner list — `shared/run-settings.js` is the one place the relay's
  // two words are spelled.
  relay: z.enum(RELAY_MODES as unknown as [RelayMode, ...RelayMode[]]),
  accounts: z.string().check(
    z.refine((text) => text.trim() === '' || parseAccounts(text) !== undefined, {
      message: 'Accounts look like default:20, work:10 — an id and the minimum headroom percent',
    }),
  ),
  acknowledgedWaivers: z.array(z.string()),
  manifestOverride: z.string(),
  verifyAnswers: z.object({ approve: z.array(z.string()), waive: z.array(z.string()) }),
});

/** `''` is "no ceiling"; anything else must be a non-negative number. */
function money(label: string) {
  return z.string().check(
    z.refine((text) => text.trim() === '' || (Number.isFinite(Number(text)) && Number(text) >= 0), {
      message: `${label} is a number of dollars, or empty for no ceiling`,
    }),
  );
}

/** `''` is "this console's own default"; anything else is a whole number in range. */
function whole(label: string, min: number, max: number) {
  return z
    .string()
    .check(
      z.refine(
        (text) =>
          text.trim() === '' ||
          (Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max),
        { message: `${label} is a whole number between ${min} and ${max}` },
      ),
    );
}

/**
 * A blank form. Never rendered as-is — every mode seeds over it from the
 * preferences, the run's own record, or the plan's bullets — but it is what
 * makes a missing seed a visible default rather than `undefined` reaching a
 * controlled input and turning it uncontrolled mid-edit.
 */
export const EMPTY: Readonly<RunSetupValues> = Object.freeze({
  model: '',
  effort: '',
  autonomy: 'keep-going',
  permissionProfile: 'guarded',
  permissionMode: '',
  accountId: 'default',
  onLimit: 'wait',
  phaseBudgetUsd: '',
  runBudgetUsd: '',
  gitMode: 'default-branch',
  openPr: true,
  // The shared checkout: exactly what the console did before the setting
  // existed, so a form nobody touched launches the run it always launched.
  isolation: 'queue',
  // The pull request: exactly what a new-branch run has always ended with, so
  // a form nobody touched settles the way this console has always settled.
  settle: DEFAULT_SETTLE,
  // Phase 15's seven, each at its owner's default — and for the three the
  // console also answers, the EMPTY word: a blank ref and a blank cap mean
  // "the plan's line, else the console's preference", which is what every run
  // before the fields existed got. Retention opens on the shipped word (the
  // preference seeds over it), the four words on the fail-safe member each:
  // commits held for a person, a conflict halts, sessions may message, and an
  // outward write is never a default.
  baseBranch: '',
  maxConcurrentPerRepo: '',
  worktreeRetention: DEFAULT_RETENTION,
  landing: DEFAULT_LAND,
  conflictPolicy: DEFAULT_CONFLICT,
  messaging: DEFAULT_MESSAGING,
  issuesMode: DEFAULT_ISSUES,
  // The ordinary class and no chain: a form nobody touched queues exactly the
  // way this console queued before either control existed.
  priority: 'normal',
  startAfter: '',
  // Off, and the cautious policy behind it. This spends money per phase and
  // — under `may-hold` — can park every phase behind the one it reviewed;
  // neither may arrive switched on in a console somebody merely upgraded.
  reviewEachPhase: false,
  reviewerPolicy: 'comment-only',
  // Both ultra tiers off, for the reason above and one more: `ultracode` fans a
  // session out across dozens of agents and `ultraReview` bills a cloud review
  // to whichever account the run spends. Neither may arrive switched on.
  ultracode: false,
  ultraReview: 'off',
  qa: false,
  qaMaxRounds: '',
  qaModel: '',
  qaEffort: '',
  qaFixStrategy: '',
  qaRoundBudgetUsd: '',
  attachDefaultSkills: false,
  skills: [],
  mcpServers: [],
  mcpPolicy: 'continue',
  autoRecover: false,
  maxParallel: '',
  maxConsecutiveFailures: '',
  onlyPhases: '',
  phaseOptions: {},
  prompt: '',
  // The prelude's four (phase 11): continue after a restart (decision 11's
  // `resume.on-restart: continue`), no relay (phase 14 arms it), and an EMPTY
  // account list — the Decisions stage fills it from the plan's clause or the
  // machine login once the prelude answers, and the door refuses a start that
  // never named one. No waiver acknowledged, no override signed.
  resumeOnRestart: true,
  relay: 'off',
  accounts: '',
  acknowledgedWaivers: [],
  manifestOverride: '',
  verifyAnswers: { approve: [], waive: [] },
});

/** `"default:20, work:10"` → `[{id, minHeadroomPct}]`; empty → `[]`; unreadable → `undefined`. */
export function parseAccounts(text: string): { id: string; minHeadroomPct: number }[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: { id: string; minHeadroomPct: number }[] = [];
  for (const part of trimmed.split(',')) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s*:\s*(\d{1,3})\s*%?)?\s*$/.exec(part);
    if (!m) return undefined;
    const min = m[2] === undefined ? 0 : Math.min(100, Number(m[2]));
    if (!out.some((a) => a.id === m[1])) out.push({ id: m[1], minHeadroomPct: min });
  }
  return out;
}

/** The inverse, for seeding the field from a run or the prelude's resolved list. */
export function formatAccounts(
  accounts: readonly { id: string; minHeadroomPct: number }[] | null | undefined,
): string {
  return accounts?.length ? accounts.map((a) => `${a.id}:${a.minHeadroomPct}`).join(', ') : '';
}

/** `"1, 3, 5-7"` → `[1, 3, 5, 6, 7]`; empty or unreadable → `undefined`. */
export function parsePhases(text: string): number[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      // A backwards range is read the way it is written rather than dropped:
      // "7-5" is a typo with an obvious meaning, and silently sending nothing
      // would scope the run to the whole plan.
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) out.add(n);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isInteger(one)) out.add(one);
  }
  return out.size ? [...out].sort((a, b) => a - b) : undefined;
}

/** The inverse, for seeding the field from a run that already has a scope. */
export function formatPhases(phases: number[] | null | undefined): string {
  return phases?.length ? phases.join(', ') : '';
}
