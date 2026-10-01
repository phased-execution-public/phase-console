/**
 * The quick view's nine categories, and which one each field lives in
 * (control-tower phase 22).
 *
 * A staged launch is ONE screen since phase 22: what runs, a preset, nine
 * category tiles that say their state in badges and expand in place, how many
 * values differ, and Launch. `CATEGORY_OF` is the map every reader asks —
 * the tile a control expands under, the review's Change link, the "changed n"
 * count and the reachability test — so it is a table, like `STAGE_OF` beside
 * it, and never an inference.
 *
 * **Each category nests inside exactly one old stage** (`Category.stage`,
 * held by `categories.test.ts`): the stages are still the flat layout's order
 * and the summary's grouping, and a category that straddled two would make
 * "which stage is this on" a question with two answers.
 */

import { ISOLATED } from '@shared/worktree-model.js';
import type { Source } from './fields';
import { parseAccounts, type RunSetupField, type RunSetupValues } from './schema';
import type { ControlStage } from './stages';

export type CategoryId =
  'scope' | 'engine' | 'safety' | 'git' | 'money' | 'review' | 'tools' | 'accounts' | 'decisions';

export interface Category {
  id: CategoryId;
  /** The tile's name, and the Edit button's accessible name after "Edit". */
  label: string;
  /** The old stage it nests in. */
  stage: ControlStage;
  /** What the tile decides, one line — the expanded panel opens on it. */
  blurb: string;
}

/** The nine, in the order the quick view draws them (§Architecture 5's START wireframe). */
export const CATEGORIES: readonly Category[] = Object.freeze([
  {
    id: 'scope',
    label: 'Scope',
    stage: 'what',
    blurb: 'Which phases this run drives, and what it waits for before it starts.',
  },
  {
    id: 'engine',
    label: 'Engine',
    stage: 'how',
    blurb: 'The model and its effort, whether the model may move, and the per-phase overrides.',
  },
  {
    id: 'safety',
    label: 'Safety',
    stage: 'how',
    blurb: 'What a session may do without asking, the CLI permission mode, and how long a card waits.',
  },
  {
    id: 'git',
    label: 'Git',
    stage: 'how',
    blurb: 'The branch it works on, its checkout, what happens to the branch, and how a phase lands.',
  },
  {
    id: 'money',
    label: 'Money and stops',
    stage: 'money',
    blurb: 'What it may spend, and every condition that stops it.',
  },
  {
    id: 'review',
    label: 'Review and QA',
    stage: 'how',
    blurb: 'Who reviews the work: a reviewer per phase, the cloud review, and the QA gate.',
  },
  {
    id: 'tools',
    label: 'Tools',
    stage: 'how',
    blurb: 'What every session is given: skills and MCP servers, and what it may say and file.',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    stage: 'how',
    blurb: 'Who pays, which login each account is right now, and the accounts it may fail over to.',
  },
  {
    id: 'decisions',
    label: 'Decisions',
    stage: 'decisions',
    blurb: 'Everything this run could ask a person mid-run, answered before it starts.',
  },
]);

/**
 * Which category each field is edited in. Every member of `RunSetupValues`
 * has a row — the two that are not run fields (`prompt`, `permissionMode` on a
 * ticket) included, because a flat mode renders them too.
 */
export const CATEGORY_OF: Readonly<Record<RunSetupField, CategoryId>> = Object.freeze({
  onlyPhases: 'scope',
  startAfter: 'scope',

  model: 'engine',
  effort: 'engine',
  modelPolicy: 'engine',
  phaseOptions: 'engine',
  // The licence to fan out is a question about how the work is DONE — the
  // engine's — not about who reviews it.
  ultracode: 'engine',
  prompt: 'engine',

  permissionProfile: 'safety',
  permissionMode: 'safety',
  approvalTimeoutMinutes: 'safety',

  gitMode: 'git',
  openPr: 'git',
  isolation: 'git',
  settle: 'git',
  baseBranch: 'git',
  maxConcurrentPerRepo: 'git',
  worktreeRetention: 'git',
  landing: 'git',
  conflictPolicy: 'git',
  // #18: the answer to the plan's git lines is asked where the git is.
  gitStrategyAck: 'git',

  phaseBudgetUsd: 'money',
  runBudgetUsd: 'money',
  qaRoundBudgetUsd: 'money',
  maxParallel: 'money',
  maxConsecutiveFailures: 'money',
  ladderPerRunRungs: 'money',
  ladderPerPhaseRungs: 'money',
  priority: 'money',
  onLimit: 'money',
  autoRecover: 'money',
  autonomy: 'money',

  reviewEachPhase: 'review',
  reviewerPolicy: 'review',
  ultraReview: 'review',
  qa: 'review',
  qaMaxRounds: 'review',
  qaFixStrategy: 'review',
  qaModel: 'review',
  qaEffort: 'review',

  attachDefaultSkills: 'tools',
  skills: 'tools',
  mcpServers: 'tools',
  mcpPolicy: 'tools',
  messaging: 'tools',
  issuesMode: 'tools',

  accountId: 'accounts',
  accounts: 'accounts',

  resumeOnRestart: 'decisions',
  relay: 'decisions',
  acknowledgedWaivers: 'decisions',
  manifestOverride: 'decisions',
  verifyAnswers: 'decisions',
});

export function categoryOf(field: RunSetupField): CategoryId {
  return CATEGORY_OF[field];
}

export function categoryById(id: CategoryId): Category {
  return CATEGORIES.find((c) => c.id === id)!;
}

/** The fields of one category, in `CATEGORY_OF`'s order. */
export function fieldsIn(id: CategoryId): RunSetupField[] {
  return (Object.keys(CATEGORY_OF) as RunSetupField[]).filter((field) => CATEGORY_OF[field] === id);
}

/** What a tile's glance is read from — the form's answers, never a second copy of them. */
export interface TileInput {
  values: RunSetupValues;
  /** Does the mode show this field? */
  on: (field: RunSetupField) => boolean;
  /** The profile's short name, and who an account id is — the form's own words. */
  permission: (value: string) => string;
  account: (id: string) => string;
  /** This console's own rung caps — what an empty "Recovery rungs" box means. */
  ladderCaps?: { perRun: number; perPhase: number };
  /** A one-phase launch's phase. */
  phase?: number;
  /** How many of the plan's git lines this launch does not honour (probe 7). */
  gitLines?: number;
  /** How many blocking decisions are still open (the prelude's `blocking`). */
  decisionsOpen?: number;
}

/** Is the tile drawn at all? Only when the mode shows one of its fields. */
export function tileShown(id: CategoryId, on: (field: RunSetupField) => boolean): boolean {
  return fieldsIn(id).some(on);
}

const money = (text: string) => `$${Number(text).toFixed(2).replace(/\.00$/, '')}`;

/**
 * A tile's glance: a few precise words, each a badge — what the category is
 * set to right now. Pure, so a test reads the same words the tile draws.
 */
export function tileBadges(id: CategoryId, input: TileInput): string[] {
  const { values: v, on } = input;
  const out: string[] = [];
  const say = (when: boolean, text: string) => {
    if (when) out.push(text);
  };
  switch (id) {
    case 'scope': {
      if (input.phase != null && !on('onlyPhases')) out.push(`Phase ${input.phase} only`);
      else if (on('onlyPhases'))
        out.push(v.onlyPhases.trim() ? `Phases ${v.onlyPhases.trim()}` : 'The whole plan');
      say(on('startAfter') && Boolean(v.startAfter.trim()), `After ${v.startAfter.trim()}`);
      break;
    }
    case 'engine':
      say(on('model'), v.model || 'This machine’s model');
      say(on('effort') && Boolean(v.effort), `${v.effort} effort`);
      say(on('modelPolicy') && v.modelPolicy === 'pinned', 'Pinned');
      say(on('phaseOptions') && Object.keys(v.phaseOptions).length > 0, 'Per-phase overrides');
      say(on('ultracode') && v.ultracode, 'Ultracode');
      break;
    case 'safety':
      say(on('permissionProfile'), input.permission(v.permissionProfile));
      say(on('permissionMode') && Boolean(v.permissionMode), v.permissionMode);
      say(
        on('approvalTimeoutMinutes') && Boolean(v.approvalTimeoutMinutes.trim()),
        `Cards wait ${v.approvalTimeoutMinutes.trim()} min`,
      );
      break;
    case 'git': {
      const branch = v.gitMode === 'new-branch';
      say(on('gitMode'), branch ? 'Work branch' : 'Current branch');
      say(on('isolation') && branch, v.isolation === ISOLATED ? 'Own checkout' : 'Shared checkout');
      say(on('landing') && v.landing !== 'hold', `Lands by ${v.landing}`);
      if (on('gitStrategyAck') && (input.gitLines ?? 0) > 0) {
        out.push(v.gitStrategyAck ? `Plan lines: ${v.gitStrategyAck}` : 'Plan lines differ');
      }
      break;
    }
    case 'money': {
      if (on('runBudgetUsd'))
        out.push(v.runBudgetUsd.trim() ? `${money(v.runBudgetUsd)} a run` : 'No run ceiling');
      say(on('phaseBudgetUsd') && Boolean(v.phaseBudgetUsd.trim()), `${money(v.phaseBudgetUsd)} a phase`);
      say(
        on('qaRoundBudgetUsd') && Boolean(v.qaRoundBudgetUsd.trim()),
        `${money(v.qaRoundBudgetUsd)} a QA round`,
      );
      // #14: the run's own recovery cap is part of the glance — the number a
      // spent cap's errand will name, visible before the run can spend it.
      if (on('ladderPerRunRungs')) {
        const rungs = v.ladderPerRunRungs.trim() || (input.ladderCaps ? String(input.ladderCaps.perRun) : '');
        if (rungs) out.push(`${rungs} recovery ${rungs === '1' ? 'rung' : 'rungs'} a run`);
      }
      say(
        on('maxConsecutiveFailures') && Boolean(v.maxConsecutiveFailures.trim()),
        `Stops after ${v.maxConsecutiveFailures.trim()} ${v.maxConsecutiveFailures.trim() === '1' ? 'failure' : 'failures'}`,
      );
      break;
    }
    case 'review':
      say(on('reviewEachPhase'), v.reviewEachPhase ? 'Reviewer each phase' : 'No reviewer');
      say(on('ultraReview') && v.ultraReview !== 'off', 'Cloud review');
      say(on('qa') && v.qa, 'QA gate on');
      say(on('qaFixStrategy'), v.qaFixStrategy === 'fresh' ? 'Fresh fix session' : 'Resumes the fix session');
      say(on('qaMaxRounds') && Boolean(v.qaMaxRounds.trim()), `${v.qaMaxRounds.trim()} QA rounds`);
      break;
    case 'tools':
      if (on('skills'))
        out.push(
          v.skills.length ? `${v.skills.length} ${v.skills.length === 1 ? 'skill' : 'skills'}` : 'No skills',
        );
      say(on('attachDefaultSkills') && v.attachDefaultSkills, 'Default skills');
      say(on('mcpServers') && v.mcpServers.length > 0, `${v.mcpServers.length} MCP`);
      say(on('messaging') && v.messaging === 'off', 'No messaging');
      break;
    case 'accounts': {
      say(on('accountId'), input.account(v.accountId));
      const pool = parseAccounts(v.accounts) ?? [];
      say(on('accounts') && pool.length > 1, `${pool.length} in the pool`);
      break;
    }
    case 'decisions': {
      const open = input.decisionsOpen ?? 0;
      if (open > 0) out.push(`${open} open`);
      say(on('resumeOnRestart'), v.resumeOnRestart ? 'Resumes after a restart' : 'Waits after a restart');
      say(on('relay') && v.relay !== 'off', 'Relay armed');
      break;
    }
  }
  return out;
}

/** The order a tile's provenance word is chosen by when two sources tie: the more deliberate first. */
const SOURCE_RANK: readonly Source[] = ['preset', 'last-launch', 'run', 'plan', 'prefs', 'defaults'];

/**
 * The provenance a tile's untouched values mostly share — the one word its
 * glance carries. Edits are counted separately ("changed n"), so a tile the
 * operator changed everything in has no word left to show.
 */
export function dominantSource(sources: readonly (Source | undefined)[]): Source | undefined {
  const counts = new Map<Source, number>();
  for (const source of sources) {
    if (!source || source === 'changed') continue;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  let best: Source | undefined;
  for (const source of SOURCE_RANK) {
    const n = counts.get(source) ?? 0;
    if (n > 0 && (best === undefined || n > (counts.get(best) ?? 0))) best = source;
  }
  return best;
}
