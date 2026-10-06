/**
 * A watched CI run GitHub never started — by the repository it belongs to
 * (control-tower phase 111, #166).
 *
 * When an Actions budget or the account's payment method stops a repository's
 * jobs, every run on it ends `completed: failure` in seconds with no runner and
 * no step. The watch probe reads that as `not-run (billing)` and keeps the
 * wait open (`server/watch-refs.ts`); this file is the Tower's reading of the
 * same rows: ONE standing state per repository, however many phases of however
 * many runs are waiting behind it — the wall is the repository's, so the
 * diagnosis is too, never one per phase.
 *
 * Dependency-free: the client draws it and the node suite holds it.
 */

/** Why GitHub refused to start a watched run's jobs — one cause so far. */
export const CI_NOT_RUN_CAUSES = Object.freeze(['billing']);

/** The Tower's word for each cause. */
export const CI_NOT_RUN_LABELS = Object.freeze({ billing: 'CI refused (billing)' });

/**
 * @typedef {{ scope: 'repository' | 'organization', name: string, amount: number, consumed: number, stops: boolean }} CiBudget
 * @typedef {{ cause: string, repo: string, run: string, jobs: number, annotation: string,
 *   budgets?: CiBudget[], unreadable?: string, headroom?: boolean }} CiNotRun
 * @typedef {{ slug: string, runId: string, phase: number, ref: string }} CiRefusedPhase
 * @typedef {{ repo: string, cause: string, label: string, phases: CiRefusedPhase[],
 *   budgets: CiBudget[] | null, unreadable: string | null, headroom: boolean | null }} CiRefusal
 */

/**
 * Every repository GitHub is refusing to run CI for, as the watch rows of the
 * runs passed in read now: a `pending` row carrying `notRun`, on a phase of a
 * run that is not settled. One entry per repository, its phases sorted by plan
 * then phase, the newest budget reading kept.
 *
 * @param {ReadonlyArray<{ id: string, slug: string, status?: string, phases?: Record<string, any> }>} runs
 * @returns {CiRefusal[]}
 */
export function ciRefusalsOf(runs) {
  /** @type {Map<string, CiRefusal>} */
  const byRepo = new Map();
  /** The newest reading kept per repository, by its `checkedAt`. */
  const newest = new Map();
  for (const run of runs ?? []) {
    // A finished run waits on nothing. A parked or halted one may still hold a
    // phase behind the refusal, and the wall is the same wall.
    if (!run || run.status === 'finished') continue;
    for (const record of Object.values(run.phases ?? {})) {
      if (!record || record.status === 'done' || record.status === 'skipped') continue;
      for (const row of record.watchState?.refs ?? []) {
        const notRun = row?.notRun;
        if (row.state !== 'pending' || !notRun || !CI_NOT_RUN_CAUSES.includes(notRun.cause) || !notRun.repo)
          continue;
        const at = row.checkedAt ?? '';
        let entry = byRepo.get(notRun.repo);
        if (!entry) {
          entry = {
            repo: notRun.repo,
            cause: notRun.cause,
            label: CI_NOT_RUN_LABELS[notRun.cause] ?? notRun.cause,
            phases: [],
            budgets: null,
            unreadable: null,
            headroom: null,
          };
          byRepo.set(notRun.repo, entry);
        }
        entry.phases.push({ slug: run.slug, runId: run.id, phase: record.phase, ref: row.ref });
        if (at >= (newest.get(notRun.repo) ?? '')) {
          newest.set(notRun.repo, at);
          entry.budgets = notRun.budgets?.length ? notRun.budgets.map((b) => ({ ...b })) : null;
          entry.unreadable = notRun.unreadable ?? null;
          entry.headroom = typeof notRun.headroom === 'boolean' ? notRun.headroom : null;
        }
      }
    }
  }
  return [...byRepo.values()]
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .map((entry) => ({
      ...entry,
      phases: entry.phases.sort((a, b) => a.slug.localeCompare(b.slug) || a.phase - b.phase),
    }));
}

/** `$10.00` — an Actions budget's amount, as GitHub's billing page writes it. */
export function dollars(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

/**
 * The budget clause of every sentence about a refusal: what was read, or why
 * nothing could be.
 *
 * @param {{ budgets?: CiBudget[] | null, unreadable?: string | null }} notRun
 */
export function budgetClause(notRun) {
  const budgets = notRun.budgets ?? [];
  if (!budgets.length) {
    return notRun.unreadable
      ? `the token cannot read the Actions budget (${notRun.unreadable})`
      : 'no Actions budget names this repository';
  }
  return budgets
    .map(
      (b) =>
        `the ${b.scope === 'repository' ? "repository's" : "organization's"} Actions budget reads ` +
        `${dollars(b.consumed)} of ${dollars(b.amount)} used${b.stops ? ', and it stops usage at the limit' : ''}`,
    )
    .join('; ');
}
