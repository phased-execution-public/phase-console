/**
 * QA sessions, from the offering side.
 *
 * The server owns the brief and the guards; this owns the *offer* — what the
 * button says, when it is a chip instead, and how a recorded verdict reads on a
 * row. Pure, and deliberately free of React and of `api.ts`, so
 * `test/qa-session.test.ts` can import it directly and hold `qaKey` equal to
 * the server's rather than trusting two implementations to agree.
 */

import { type QA_RESULT_WORDS } from '../../../shared/plan-vocab.js';
import { planHref } from '../../../shared/routes.js';
import { PROFILE_LABELS } from '../../../shared/run-settings.js';

/** What `qa-record.sh` writes, plus the parser's word for a row it could not read. */
export type QaResult = (typeof QA_RESULT_WORDS)[number];

/** A verdict that answers the question. Mirrors `isVerdict` on the server. */
export function isVerdict(result: string | undefined): boolean {
  return result === 'pass' || result === 'fail' || result === 'waived';
}

/**
 * The identity a duplicate is judged by — `(slug, phase)`, mirroring
 * `qaKey` in `server/qa-session.ts`, which is what actually enforces it.
 *
 * Two reviewers of one phase write the same report path and race each other's
 * `qa-record.sh` row, so the second is never what anyone meant to press.
 */
export function qaKey(target: { slug?: string; phase?: number }): string {
  return `${target.slug ?? ''}#${target.phase ?? ''}`;
}

/** A minimal session shape, so this file need not import the API types. */
type SessionLike = {
  id: string;
  exited?: unknown;
  meta?: { qa?: { slug: string; phase: number } };
};

/**
 * The live QA session for a phase, if one is running.
 *
 * Read off the sessions list every page already holds — which is what makes the
 * button become a chip with no extra request, and change back the moment the
 * `sessions` event says the process ended.
 */
export function liveQa<T extends SessionLike>(
  sessions: readonly T[] | undefined,
  target: { slug?: string; phase?: number },
): T | undefined {
  if (!sessions?.length) return undefined;
  const key = qaKey(target);
  return sessions.find((session) => !session.exited && session.meta?.qa && qaKey(session.meta.qa) === key);
}

/**
 * The two permission profiles a QA session may start under.
 *
 * `trusted` is an autopilot idea — it means no approval card is raised, and
 * there is no card here: a review runs in a terminal a person is looking at, so
 * the only real question is whether the CLI asks that person before acting.
 */
export const QA_PROFILES = ['guarded', 'bypass'] as const;
export type QaProfile = (typeof QA_PROFILES)[number];

export const QA_PROFILE_LABEL: Record<QaProfile, string> = {
  guarded: 'Guarded — the CLI asks you before it acts',
  bypass: PROFILE_LABELS.bypass,
};

/** Which phases are worth reviewing. A phase nobody has finished has no diff to read. */
export function canQa(state: string): boolean {
  return state !== 'waiting';
}

/* ------------------------------------------------------------------ *
 * The per-phase regime, and the report sheet's address (2026-09-07)
 * ------------------------------------------------------------------ */

/**
 * THIS phase's QA regime, for every surface that judges "is this phase held?".
 *
 * `summary.qaMode` is the PLAN's word. A phase carrying its own `- **QA:** off`
 * under a plan-wide `on` is held by nothing, and three surfaces said it was —
 * they read the plan's word because the per-phase one never reached the
 * client. The server resolves it per phase now (`PhaseView.qaMode`); an older
 * server sends none, and the plan's word is then the honest fallback.
 */
export function phaseQaMode(
  view: { qaMode?: { mode: string; source?: string } } | undefined,
  planMode: string | undefined,
): string | undefined {
  return view?.qaMode?.mode ?? planMode;
}

/** Which round a report path is — `reports/phase-07-qa-round3.md` is 3; the plain name is round 1. */
export function qaReportRound(path: string): number {
  const m = /-round(\d+)\.md$/i.exec(path);
  return m ? Number(m[1]) : 1;
}

/**
 * The report sheet's address — `#/plan/<slug>/qa?report=<phase>[:<round>]`.
 * A query, not a route, like every other overlay: open ⟺ the URL says so.
 */
export function qaReportHref(slug: string, phase: number, round?: number): string {
  return `${planHref(slug, 'qa')}?report=${phase}${round && round > 1 ? `:${round}` : ''}`;
}

/** What `?report=` names, or null for anything that is not a phase (and an optional round). */
export function parseReportParam(value: string | undefined | null): { phase: number; round?: number } | null {
  if (!value) return null;
  const m = /^(\d+)(?::(\d+))?$/.exec(value);
  if (!m) return null;
  const phase = Number(m[1]);
  if (phase < 1) return null;
  if (m[2] === undefined) return { phase };
  const round = Number(m[2]);
  // A round that cannot exist is a malformed address, not "the latest".
  return round >= 1 ? { phase, round } : null;
}
