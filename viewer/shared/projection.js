/**
 * WHAT A PAGE ASKED FOR — the projection vocabulary, owned in one place.
 *
 * Two read endpoints shipped everything they knew to every caller. Measured on
 * the live hub library:
 *
 *   - `GET /api/plans/console-audit-hardening` — **286.5 KB** to render a table.
 *     `plan.sections` (64.7 KB) and every phase's `bullets` (57.1 KB) have
 *     **zero readers anywhere in the client**; the per-phase prose (goal,
 *     readFirst, files, steps, exitCriteria, verification, handoffMustRecord —
 *     49.9 KB) is read only by the Phases tab, and each phase's `handoff`
 *     reference (46.5 KB, mostly its Outstanding section) only by the same
 *     cells. The Route tab, which is what opens by default, reads none of it.
 *   - `GET /api/state` — one live run of a long plan is a **340 KB** record, of
 *     which `phases[].verification` alone is 227 KB and the run's `rulings`
 *     ledger another 58 KB. Two live runs made a payload every page loads on
 *     every navigation into a third of a megabyte of transcripts.
 *
 * NOTHING IS REMOVED. This module names the groups a caller can ask for, and
 * the server answers the full historical shape for `?include=full`. What
 * changed is the DEFAULT — from "everything this server knows" to "what the
 * page that asked actually renders". `test/route-contract.test.ts` asserts,
 * key by key, that every field the pre-change response carried is still
 * reachable through one of the groups below; that test is what makes "nothing
 * removed" a fact rather than an intention.
 *
 * Dependency-free ESM, in `shared/` for the same reason `status-vocab.js` and
 * `plan-vocab.js` are: the server projects with it, the client's API layer asks
 * with it, and `vocab-owners.test.ts` fails if either re-declares the words.
 *
 * @typedef {'full'|'prose'|'document'|'handoffs'|'memory'} PlanInclude
 * @typedef {'full'|'runs'} StateInclude
 */

/**
 * The groups `GET /api/plans/<slug>?include=` accepts.
 *
 * `full` is not a group but an escape hatch: it means "the shape this endpoint
 * returned before projections existed", and it exists so that a client older
 * than this server — or an operator with `curl` — can always get everything
 * back in one request.
 * @type {readonly PlanInclude[]}
 */
export const PLAN_INCLUDES = Object.freeze(
  /** @type {const} */ (['full', 'prose', 'document', 'handoffs', 'memory']),
);

/**
 * The groups `GET /api/state?include=` accepts.
 * @type {readonly StateInclude[]}
 */
export const STATE_INCLUDES = Object.freeze(/** @type {const} */ (['full', 'runs']));

/**
 * Per-phase prose — what a `### Phase N` section says at LENGTH.
 *
 * ⚠️ **`goal` is deliberately NOT here.** It was, and that was a defect QA
 * caught: `TitleCell` renders one clamped line of it on the Route tab and
 * `phases-tab.tsx` shows an excerpt on every phase card, so projecting it away
 * blanked the default tab of every plan — silently, because a missing field is
 * merely `undefined`. It is 2.5 KB across 23 phases; it was never the problem.
 * The fields below are the ones that run to a page each.
 *
 * `bullets` is in this group rather than deleted outright on purpose: nothing
 * in the client reads it TODAY, but it is the parser's own record of the
 * phase's bullet list and the plan wizard's future input. A field with no
 * reader is a payload problem, not a correctness one, so it moves behind an
 * `include` where it costs nothing and stays reachable.
 * @type {readonly string[]}
 */
export const PROSE_PHASE_FIELDS = Object.freeze([
  'readFirst',
  'files',
  'steps',
  'exitCriteria',
  'verification',
  'handoffMustRecord',
  'bullets',
]);

/**
 * Plan-level prose — the DOCUMENT, as opposed to the board.
 *
 * Its own group (`?include=document`) rather than riding with the phase prose:
 * the two are wanted by different pages, and lumping them made each caller pay
 * for the other's — the Phases tab pulled the 64.7 KB zero-reader
 * `plan.sections`, and the Source tab pulled every phase's steps.
 *
 * `source-tab.tsx` is the ONLY reader of every field here; a grep for each one
 * across `client/src` returns that file and nothing else. `sections` is the
 * whole plan re-shipped as `{title, body}[]` (64.7 KB on the 23-phase plan) and
 * has no reader at all.
 *
 * `context` and `architecture` were the expensive surprise. They look like
 * metadata beside `slug` and `title`, and on the plan this projection was first
 * measured against they are ~1 KB each — but on a 31-phase plan in the same
 * library they are **13.1 KB and 7.4 KB**, and the Route tab was carrying both
 * to render a map. That is why the corpus test scales its budget by phase count
 * instead of trusting one plan: the per-phase cost is stable, the prose is not.
 *
 * `slug`, `title`, `sessionBudget` and `path` stay in the board projection —
 * the header, the phase panel and the Autopilot tab all read the budget.
 * @type {readonly string[]}
 */
export const DOCUMENT_PLAN_FIELDS = Object.freeze([
  'sections',
  'context',
  'architecture',
  'endToEnd',
  'provenance',
  'callouts',
  'graph',
]);

/**
 * The handoff reference's OUTSTANDING section — 42.1 KB of the 46.5 KB that
 * `phases[].handoff` costs on the measured plan. The remaining 4.1 KB is
 * `file`, `status`, `title`, `completed`, `skillsUsed` and `prompts`.
 *
 * A SUB-FIELD group, and that is the whole point. `FlagsCell` renders a
 * `handoff <status>` chip on the Route tab and on every phase card, so the
 * reference itself has to stay in the board projection; what nobody renders
 * there is the paragraph hanging off it. Projecting the whole object away —
 * which is what this first shipped as — dropped the chip from the default tab
 * of every plan, and `ways-forward.tsx` went on to print a sentence asserting
 * the handoff "records no Outstanding section" about a field it had not asked
 * for.
 *
 * The top-level `handoffs` ARRAY — the Handoffs tab's actual source, 5.2 KB —
 * is untouched by any of this and stays in the board response.
 * @type {readonly string[]}
 */
export const HANDOFF_PROSE_FIELDS = Object.freeze(['outstanding']);

/**
 * The plan's memory file, read whole. One reader (the Source tab), 18 KB.
 * @type {readonly string[]}
 */
export const MEMORY_FIELDS = Object.freeze(['memory']);

/**
 * A run's ledgers — dropped from a run SUMMARY, kept in the full record.
 *
 * An OMISSION list, not a keep-list, deliberately: a field added to `RunState`
 * tomorrow rides along in the summary by default. The two named here are
 * append-only histories that grow without bound over a run's life and that
 * nothing reads off `/api/state` (`rulings` measured 58.1 KB on one live run).
 * @type {readonly string[]}
 */
export const RUN_SUMMARY_DROP = Object.freeze(['rulings', 'recoveries']);

/**
 * A phase record's transcripts — dropped from a run summary.
 *
 * Same omission-list reasoning, and the same single dominating field:
 * `verification` is the captured stdout of every command a phase ran, 227.2 KB
 * of one 340 KB record. `said` and `tasks` are the session's own words and its
 * published task list; `closeout`, `situation`, `stall`, `lint`, `waits`,
 * `boardingHint`, `preflightDetail` and `note` are prose about the phase.
 *
 * `liveness` is deliberately NOT here: it is the per-lane "is this alive"
 * sample, which is exactly what a summary is for, and it costs 2.8 KB.
 * @type {readonly string[]}
 */
export const RUN_SUMMARY_PHASE_DROP = Object.freeze([
  'verification',
  'said',
  'tasks',
  'closeout',
  'situation',
  'stall',
  'lint',
  'waits',
  'boardingHint',
  'preflightDetail',
  'note',
]);

/**
 * Parse an `include=` query value into a set of groups.
 *
 * Accepts a comma- or space-separated list, ignores anything not in `allowed`,
 * and never throws — an unknown group is a caller asking for something this
 * server does not have, which is a smaller response, not a 400. A missing or
 * empty value is the default projection.
 *
 * @param {string|null|undefined} raw
 * @param {readonly string[]} allowed
 * @returns {Set<string>}
 */
export function parseInclude(raw, allowed) {
  const out = new Set();
  if (!raw) return out;
  for (const part of String(raw).split(/[,\s]+/)) {
    const word = part.trim().toLowerCase();
    if (word && allowed.includes(word)) out.add(word);
  }
  return out;
}

/**
 * Does this include-set want `group`? `full` wants everything.
 * @param {Set<string>|undefined|null} include
 * @param {string} group
 * @returns {boolean}
 */
export function wants(include, group) {
  if (!include) return false;
  return include.has('full') || include.has(group);
}

/**
 * Serialize an include-set back into a query value, stable-ordered.
 *
 * The client uses this to build a request URL AND its query key, so two
 * callers asking for the same groups in a different order share one cache
 * entry instead of fetching twice.
 *
 * @param {Iterable<string>} groups
 * @param {readonly string[]} allowed
 * @returns {string}
 */
export function includeParam(groups, allowed) {
  const set = new Set();
  for (const g of groups) if (allowed.includes(g)) set.add(g);
  return allowed.filter((g) => set.has(g)).join(',');
}

/**
 * A shallow copy of `object` without `fields`.
 * @template {Record<string, unknown>} T
 * @param {T} object
 * @param {readonly string[]} fields
 * @returns {T}
 */
export function omit(object, fields) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(object)) if (!fields.includes(key)) out[key] = object[key];
  return /** @type {T} */ (out);
}

/**
 * One live run without its transcripts — the shape `/api/state` carries by
 * default.
 *
 * A pure function of the record, here rather than on the service, so the node
 * suite can hold it against a real 340 KB run file without standing a runner
 * up. `Service.state()` maps `runStates()` through it; `?include=runs` skips it
 * and answers the records themselves.
 *
 * @template {{ phases?: Record<string, unknown> }} T
 * @param {T} run
 * @returns {T}
 */
export function summarizeRun(run) {
  const summary = omit(/** @type {Record<string, unknown>} */ (run), RUN_SUMMARY_DROP);
  /** @type {Record<string, unknown>} */
  const phases = {};
  for (const [key, record] of Object.entries(run.phases ?? {})) {
    phases[key] =
      record && typeof record === 'object'
        ? omit(/** @type {Record<string, unknown>} */ (record), RUN_SUMMARY_PHASE_DROP)
        : record;
  }
  summary.phases = phases;
  return /** @type {T} */ (summary);
}
