/**
 * Everything the halt card draws for one stopped run — `haltView(run, ctx)` —
 * and the recovery context it asks with (control-tower phase 17).
 *
 * The words live in `halt-categories.js`; this module adds the one thing they
 * cannot carry without weight: the RECOMMENDED verb, which is
 * `recoveryActionsFor(ctx)[0]` — the recovery model's own first verb, never a
 * second opinion. Kept apart because the vocabulary is on the first-paint
 * path (the runs ledger's sentence) and the recovery model is not
 * (`check-dist`: 190 KB served).
 */

import { recoveryActionsFor } from './recovery-model.js';
import {
  HALT_CATEGORY_FIX,
  HALT_CATEGORY_LABELS,
  categoryOfHalt,
  haltReasonOf,
  haltSentence,
  haltSituation,
  holderViews,
  isHaltKind,
} from './halt-categories.js';

/**
 * @typedef {{
 *   status: string,
 *   sessionId?: string | null, resumeSessionId?: string | null,
 *   situation?: { key: string } | null,
 * }} RecordLike
 * @typedef {{
 *   slug: string, status: string, id?: string,
 *   halt?: {
 *     at?: string, reason?: string, phase?: number, kind?: string,
 *     accounts?: { unusable: number, total: number },
 *     holders?: readonly HolderLike[],
 *     budget?: { budget: string } & Record<string, unknown>,
 *     evidence?: { source: string, matched: string, session?: string, phase?: number, slug?: string, runId?: string },
 *   } | null,
 *   phases?: Record<string, RecordLike> | null,
 *   recoveries?: Record<string, { errand?: unknown } | undefined> | null,
 *   errand?: unknown,
 *   consecutiveFailures?: number, maxConsecutiveFailures?: number,
 *   failureRoots?: readonly { phase: number, key: string, label: string }[] | null,
 *   resolved?: unknown,
 * }} HaltRunLike
 */

/**
 * The situation key the phase's errand was written under, when it has one.
 * @param {HaltRunLike} run
 * @param {number} phase
 * @returns {string | undefined}
 */
function errandSituation(run, phase) {
  const errand = /** @type {{ situation?: unknown } | null | undefined} */ (
    run.recoveries?.[String(phase)]?.errand
  );
  return typeof errand?.situation === 'string' ? errand.situation : undefined;
}

/**
 * The recovery context a halt card asks the recovery model with — the same
 * one it hands `RecoveryActions`, so the button it calls recommended is the
 * button that component draws first. The phase's record rides along only
 * while there is something to recover on it: a done or skipped record would
 * answer "nothing to do" for a run that is stopped.
 *
 * Its situation is the record's, once a classifier has written one, and the
 * phase's errand's until then: a declared wall parks with an errand and no
 * classified record, and read from the kind alone `needs-human --needs
 * external` was named a decision (control-tower phase 33).
 * @param {HaltRunLike} run
 * @param {{ authFailure?: boolean }} [opts]
 */
export function haltCtx(run, opts = {}) {
  const phase = run.halt?.phase;
  const record = phase != null ? run.phases?.[String(phase)] : undefined;
  const live = record && record.status !== 'done' && record.status !== 'skipped';
  const key = live
    ? (record.situation?.key ?? errandSituation(run, /** @type {number} */ (phase)))
    : undefined;
  const [id, sub] = key ? key.split(':') : [];
  return {
    run,
    ...(live
      ? {
          record: {
            status: record.status,
            resumable: Boolean(record.sessionId ?? record.resumeSessionId),
            ...(key ? { situation: { key } } : {}),
          },
        }
      : {}),
    ...(id ? { situation: { id, ...(sub ? { sub } : {}) } } : {}),
    ...(opts.authFailure ? { authFailure: true } : {}),
  };
}

/**
 * Everything the halt card draws for one stopped run — or null when the run
 * carries no halt. Pure: `ctx.flags` and `ctx.live` are the console's
 * capabilities and the recovery already running, exactly as
 * `recoveryActionsFor` takes them.
 *
 * @param {HaltRunLike | null | undefined} run
 * @param {{ flags?: { allowRun?: boolean, allowWrites?: boolean, allowAgent?: boolean },
 *   live?: { recoverySessionId?: string | null }, authFailure?: boolean }} [opts]
 */
export function haltView(run, opts = {}) {
  const halt = run?.halt;
  if (!run || !halt) return null;
  const kind = isHaltKind(halt.kind) ? /** @type {string} */ (halt.kind) : null;
  const ctx = haltCtx(run, opts);
  const situation = ctx.record?.situation?.key ?? haltSituation(halt);
  const category = categoryOfHalt(kind, ctx.record?.situation?.key ?? situation);
  const actions = recoveryActionsFor({
    ...ctx,
    ...(opts.flags ? { flags: opts.flags } : {}),
    ...(opts.live ? { live: opts.live } : {}),
  });
  const phase = halt.phase ?? null;
  const slot = phase != null ? run.recoveries?.[String(phase)] : undefined;
  const accounts = halt.accounts ?? null;
  const streak = run.consecutiveFailures ?? 0;
  const max = run.maxConsecutiveFailures ?? 0;
  /** @type {Map<string, { key: string, label: string, phases: number[] }>} */
  const roots = new Map();
  for (const root of run.failureRoots ?? []) {
    const seen = roots.get(root.key);
    if (seen) seen.phases.push(root.phase);
    else roots.set(root.key, { key: root.key, label: root.label, phases: [root.phase] });
  }
  return {
    kind,
    category,
    label: HALT_CATEGORY_LABELS[category],
    fix: HALT_CATEGORY_FIX[category],
    sentence: /** @type {string} */ (haltSentence(halt)),
    reason: haltReasonOf(halt),
    at: halt.at ?? null,
    phase,
    slug: run.slug,
    situation,
    ctx,
    actions,
    recommended: actions[0] ?? null,
    holders: kind === 'nothing-ready' ? holderViews(halt.holders) : [],
    accounts: accounts
      ? { ...accounts, allGone: accounts.total > 0 && accounts.unusable >= accounts.total }
      : null,
    budget: halt.budget ?? null,
    streak:
      streak > 0 || kind === 'failure-streak'
        ? { count: streak, max, atMax: max > 0 && streak >= max }
        : null,
    roots: [...roots.values()],
    evidence: halt.evidence ?? null,
    errand: slot?.errand ?? run.errand ?? null,
  };
}

/** @typedef {NonNullable<ReturnType<typeof haltView>>} HaltView */
