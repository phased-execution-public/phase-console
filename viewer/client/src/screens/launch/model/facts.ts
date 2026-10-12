/**
 * What the launch knows about the PLAN — the facts the stages and the review
 * show beside the form's values, read from the board this console already
 * holds.
 *
 * `usePlan(slug)` with no include is the board projection: the key every
 * plan page and the palette already read, so opening the launch dialog from
 * the run page costs no request. The verify-preflight is its own read (the
 * plan's health panel asks for the same key, and it is cheap but not free);
 * a server that predates the endpoint answers nothing, and nothing is what
 * the review then shows — never a claim that the plan is clean.
 */

import type {
  BatchGroup,
  GitStrategyLine,
  PhaseLock,
  PhaseView,
  PlanDetail,
  PreflightWarning,
  Prelude,
} from '@/data/api';
import { usePlan, useVerifyPreflight } from '@/data/plans';
import { usePrelude } from '@/data/runs';
import { RELAY_MODES } from '@shared/run-settings.js';
import { useSetupForm } from '../form-context';
import { resumeTarget, runsPrelude } from './modes';
import { parseAccounts, parsePhases } from './schema';

/** Who clears a gate — the gate's category, in a sentence. */
export function gateWho(phase: PhaseView): string | null {
  if (!phase.gated) return null;
  switch (phase.gateKind) {
    case 'human':
      return 'a person approves it';
    case 'ai':
      return 'the session clears it at boarding';
    case 'auto':
      return 'checked at boarding';
    default:
      return 'gated';
  }
}

/** A live claim on the phase — a lapsed one blocks nothing and is not returned. */
export function liveClaim(phase: PhaseView): PhaseLock | undefined {
  return phase.lock && !phase.lock.expired ? phase.lock : undefined;
}

export interface LaunchFactsView {
  slug: string | undefined;
  detail: PlanDetail | undefined;
  /** Every phase the board knows — from the detail when it has arrived, else what the caller passed. */
  phases: PhaseView[];
  /** The typed scope, when it parses. */
  scoped: number[] | undefined;
  /** Ready now, on the board. */
  ready: PhaseView[];
  /** What this launch will board first: the scope when there is one, the phase for a phase launch, else the ready set. */
  willRun: PhaseView[];
  /** Phases that will hold at a gate, among what will run — or among every open phase when unscoped. */
  gated: PhaseView[];
  /** Phases with a live claim this run would queue behind. */
  claimed: PhaseView[];
  batches: BatchGroup[];
  budget: string | undefined;
  resumeRunId: string | undefined;
  /** Boarding-preflight findings for the phases in play. `undefined` = the server could not say. */
  warnings: { phase: number; warnings: PreflightWarning[] }[] | undefined;
}

export function useLaunchFacts(): LaunchFactsView {
  const f = useSetupForm();
  const slug = f.context.slug;
  const { data: detail } = usePlan(slug);
  const { data: preflight } = useVerifyPreflight(slug);
  const phases = detail?.phases ?? f.planPhases;
  const scoped =
    f.mode === 'phase' && f.context.phase != null ? [f.context.phase] : parsePhases(f.values.onlyPhases);
  const open = phases.filter((p) => p.state !== 'done');
  const ready = phases.filter((p) => p.state === 'ready');
  const inScope = (p: PhaseView) => !scoped || scoped.includes(p.phase);
  const willRun = scoped ? open.filter(inScope) : ready;
  const considered = scoped ? willRun : open;
  const gated = considered.filter((p) => p.gated);
  const claimed = considered.filter((p) => liveClaim(p));
  const resumeRunId = f.mode === 'live' ? undefined : resumeTarget(f.mode, f.context.run ?? null);
  const warnings = preflight?.phases.filter((entry) => !scoped || scoped.includes(entry.phase));
  return {
    slug,
    detail,
    phases,
    scoped,
    ready,
    willRun,
    gated,
    claimed,
    batches: detail?.batches?.groups ?? [],
    budget: detail?.batches?.budget,
    resumeRunId,
    warnings,
  };
}

/*
 * What the start door will judge of THIS draft — the prelude (zero-touch-console
 * phase 11): the decision manifest as the console resolves it, the pre-spawn
 * probes, the person's turns, the plan's git lines. Asked of the server
 * (`GET /api/run/:slug/prelude`) with the draft's answers, so what the launch
 * shows is what the door will decide — one computation, never an imitation.
 */

/** The draft the prelude is asked about — its answers, as the door will read them. */
export function preludeDraft(values: {
  accounts: string;
  relay: string;
  resumeOnRestart: boolean;
  acknowledgedWaivers: string[];
  model: string;
  permissionProfile: string;
  mcpPolicy: string;
  onlyPhases?: string;
  autonomy?: string;
  verifyAnswers?: { approve: string[]; waive: string[] };
  gitMode?: string;
  isolation?: string;
}) {
  const accounts = parseAccounts(values.accounts) ?? [];
  const onlyPhases = values.onlyPhases ? (parsePhases(values.onlyPhases) ?? []) : [];
  const answers = values.verifyAnswers;
  return {
    // Probe 5's question (2026-09-18): the phases this run drives, its
    // autonomy, and the answers given so far — so the launch shows what the
    // door will judge, answer by answer.
    ...(onlyPhases.length ? { onlyPhases } : {}),
    ...(values.autonomy ? { autonomy: values.autonomy } : {}),
    ...(answers && (answers.approve.length || answers.waive.length)
      ? { verifyAnswers: { approve: [...answers.approve], waive: [...answers.waive] } }
      : {}),
    ...(accounts.length ? { accounts } : {}),
    relay: (RELAY_MODES as readonly string[]).includes(values.relay)
      ? (values.relay as (typeof RELAY_MODES)[number])
      : 'off',
    resumeOnRestart: values.resumeOnRestart,
    ...(values.acknowledgedWaivers.length ? { acknowledgedWaivers: values.acknowledgedWaivers } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.permissionProfile ? { profile: values.permissionProfile } : {}),
    ...(values.mcpPolicy ? { mcpPolicy: values.mcpPolicy } : {}),
    // Probes 6 and 7 (control-tower phases 40 and 11) judge THIS draft's
    // checkout: without them the prelude reads the run as not isolated, and
    // the git lines against the console's default branch strategy.
    ...(values.gitMode ? { gitMode: values.gitMode } : {}),
    ...(values.gitMode === 'new-branch' && values.isolation ? { isolation: values.isolation } : {}),
  };
}

/**
 * The launch's own prelude query — the same key the form asks for its submit
 * gate, over the SEED and the operator's edits (the form seeds the account
 * list from the answer, so the draft must not include it twice).
 */
export function useDraftPrelude() {
  const f = useSetupForm();
  const asks = runsPrelude(f.mode) && (f.on('resumeOnRestart') || f.on('relay') || f.on('accounts'));
  return usePrelude(
    f.context.slug,
    preludeDraft({
      ...f.values,
      // The seeded list is the prelude's own answer; only a typed one changes the question.
      accounts: f.values.accounts !== f.seed.accounts ? f.values.accounts : '',
    }),
    asks,
  );
}

/** The plan's git lines this launch does not honour (probe 7, #18) — what holds Launch until answered. */
export function gitLinesOf(prelude: Prelude | undefined): GitStrategyLine[] {
  const detail = prelude?.probes['git-strategy']?.detail as { lines?: unknown } | undefined;
  return Array.isArray(detail?.lines) ? (detail.lines as GitStrategyLine[]) : [];
}

/** How many blocking decisions still hold Launch — none once a person signed the override. */
export function openDecisions(prelude: Prelude | undefined, override: string): number {
  return override.trim() ? 0 : (prelude?.blocking.length ?? 0);
}
