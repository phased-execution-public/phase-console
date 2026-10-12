/**
 * Every stopped phase, its cause in its own words, and the move that frees it
 * (7.0, quiet-console phase 12; the 6.x ways-forward card).
 *
 * ```
 * P5  Rollout                     ● Stuck
 * The shutdown acceptance test needs a human. Read the full handoff
 * [Repair the plan with a new agent]
 * ───────────────────────────────────────────────────────────────
 * P2  Ship                        ● Next up   Needs your confirmation
 * The plan asks a person to confirm first: confirm the window. Read the gate in the plan
 * [Re-check]
 * ▸ More ways forward (3)
 * ```
 *
 * A status word — blocked, parked, halted — is true and answers nothing about
 * "what now?". The facts are on the wire, so each row says the cause in its own
 * words beside the action that moves it, in the halt card's grammar: the family
 * mark, the sentence, the controls that make the fix (a budget's raise), then
 * the recommended verb first and every other way forward one press behind it
 * (`RecoveryActions`):
 *
 *   - a phase whose HANDOFF says blocked → its Outstanding text, and a repair
 *     of the plan by a new agent;
 *   - a GATED phase → the gate's own conditions and a Re-check: a gate is a
 *     decision the plan reserved for a person, and nothing here bypasses it;
 *   - a failed, interrupted or parked record → its note, or the ladder's
 *     errand, and the recovery its evidence supports;
 *   - a finished phase whose QA verdict holds its dependents → the verdict, and
 *     where to record another.
 *
 * Nothing is drawn while the run is live: the lanes are the truth then, and
 * advice stacked on a moving run reads as alarm. And a plan that has never run
 * has not stopped — what stands before its first boarding is a checklist, and
 * says so. The view lends each recovery its account row (`parts`); a repair
 * agent opens through the one launch door.
 */

import { categoryOfHalt, haltSentence } from '@shared/halt-categories.js';
import type { Errand, PhaseView, RunState } from '@/data/api';
import { boardStateTitle } from '@/lib/status-vocab';
import { phaseHref } from '@/shell/routes';
import { BudgetRaise } from '@/cards/halt-card';
import { HaltCategoryMark, SituationCategoryMark } from '@/cards/halt-mark';
import { RecoveryActions, type RecoveryCtx, type RecoveryParts } from '@/cards/recovery-actions';
import { PhaseStatus, type WordOf } from '@/ui/status';

/** One stopped phase, with its cause and its way forward. */
type WayForwardRow = {
  phase: number;
  title: string;
  /** The BOARD's word — what the row's status draws. */
  state: string;
  why: string;
  /** This run's record of the phase: the recovery model computes the offers from it. */
  record?: { status: string; resumable: boolean; situation?: { key: string } | undefined } | undefined;
  /** The one ask the ladder left for this phase, when it ran out. */
  errand?: Errand | undefined;
  /** The BOARD calls it stuck (a blocked handoff, often no record) — a plan repair's job. */
  stuck?: boolean | undefined;
  /** With gate rows, a re-check; with records, a retry that restarts. */
  retry?: 'restarts' | 'rechecks-gate' | undefined;
  /** Who may clear a gate row's gate — a session's gate asks no person to confirm it. */
  gateKind?: string | undefined;
  /** Where to read what the row only excerpts — the handoff, the gate, the phase. */
  readMore?: string | undefined;
  /** The kind of the phase's OWN stop (its record's halt), for the family mark. */
  haltKind?: string | undefined;
};

/** The record statuses a phase is stopped in. */
const STOPPED = ['failed', 'interrupted', 'parked', 'gated'];

/** The first breath of a longer text — enough to know why, not a second page. */
function excerpt(text: string | undefined, max = 300): string | undefined {
  const clean = text?.replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Every stopped phase of the plan, each with its cause and the shape of its way forward. */
export function waysForwardRows(
  slug: string,
  planPhases: readonly PhaseView[],
  run: RunState | null,
): WayForwardRow[] {
  const rows: WayForwardRow[] = [];
  for (const p of planPhases) {
    const record = run?.phases?.[String(p.phase)];

    if (p.state === 'done') {
      // A done phase whose QA verdict is neither pass nor waived is settled as
      // WORK and unsettled as a BLOCKER: the engine holds every dependent
      // behind it, so on a plan wedged this way it is the only true cause.
      const verdict = p.qa?.result;
      if (verdict && verdict !== 'pass' && verdict !== 'waived') {
        const blocks = planPhases
          .filter((other) => other.state === 'waiting' && (other.row?.dependsOn ?? []).includes(p.phase))
          .map((other) => other.phase);
        rows.push({
          phase: p.phase,
          title: p.title,
          state: 'done',
          why:
            `this phase is finished, but its QA verdict is ${verdict}` +
            (blocks.length
              ? ` — which holds phase${blocks.length === 1 ? '' : 's'} ${blocks.join(', ')}.`
              : '.') +
            ' Nothing will move until a verdict of pass or waived is recorded' +
            (p.qa?.report ? ` (the report is at ${p.qa.report})` : '') +
            ' — record it from this phase, or run QA again.',
          readMore: phaseHref(slug, p.phase),
        });
        continue;
      }
      // A red record on a green phase: the reconcile pass closes it as "closed
      // outside this run" on the next read or tick. This row is for a record it
      // has not reached yet, so it says the correction is coming.
      if (record && ['failed', 'interrupted', 'parked', 'waiting', 'gated'].includes(record.status)) {
        rows.push({
          phase: p.phase,
          title: p.title,
          state: 'done',
          why:
            `this run's own attempt stopped (${excerpt(record.note ?? record.status, 160)})` +
            ' — but the phase was finished outside it, and the board reads done.' +
            ' The record reconciles to done on the next run tick; nothing needs fixing.',
          readMore: phaseHref(slug, p.phase),
        });
      }
      continue;
    }

    if (p.state === 'stuck') {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        // Never "…records no Outstanding section": `outstanding` arrives only
        // with the handoffs projection, so the fallback must not assert what an
        // absent field cannot tell it.
        why: excerpt(p.handoff?.outstanding) ?? `its handoff is marked ${p.handoff?.status ?? 'blocked'}.`,
        stuck: true,
        readMore: p.handoff?.file ? phaseHref(slug, p.phase) : undefined,
      });
      continue;
    }

    // A gate explains a stop only when it is what the phase is waiting on.
    // `gated` is a flag orthogonal to the board bucket, so a WAITING phase can
    // carry one while its dependencies are what hold it: the gate is the cause
    // only on a phase otherwise ready to board, or one this run stopped ON it.
    const gateHeld = record != null && ['parked', 'gated', 'pending'].includes(record.status);
    if (p.gated && (gateHeld || (record == null && p.state === 'ready'))) {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        why:
          record?.note ??
          (p.gateKind === 'ai'
            ? `a booted session verifies and clears this gate itself${p.gates ? `: ${excerpt(p.gates, 200)}` : '.'}`
            : p.gates
              ? `the plan asks a person to confirm first: ${excerpt(p.gates, 220)}`
              : 'the plan names a condition a person must confirm before this phase runs.'),
        retry: 'rechecks-gate',
        ...(p.gateKind ? { gateKind: p.gateKind } : {}),
        readMore: phaseHref(slug, p.phase),
      });
      continue;
    }

    // The ladder's errand — on a parked record, and on a pending one the ladder
    // reset and could not board. Either way the row leads with its ask.
    const errand = run?.recoveries?.[String(p.phase)]?.errand;
    if (record && (STOPPED.includes(record.status) || errand)) {
      // The run's stop, when it is this phase's, in the halt card's one
      // sentence: the runner's own words are the card's, one press away there.
      const haltHere = run?.halt?.phase === p.phase ? haltSentence(run.halt) : undefined;
      rows.push({
        phase: p.phase,
        title: p.title,
        // The BOARD's word, never `record.status`: the two vocabularies are not
        // interchangeable, and the record's own word is carried below.
        state: p.state,
        why: errand
          ? errand.need
          : (excerpt(record.note ?? haltHere) ?? `this run recorded it ${record.status}, without a note.`),
        record: {
          status: record.status,
          resumable: Boolean(record.sessionId ?? record.resumeSessionId),
          ...(record.situation ? { situation: { key: record.situation.key } } : {}),
        },
        ...(errand ? { errand } : {}),
        ...(record.halt?.kind ? { haltKind: record.halt.kind } : {}),
        retry: 'restarts',
      });
    }
  }
  return rows;
}

/**
 * A cause as a sentence of its own: the rows' words were written to run on
 * after a heading, and a quoted note or excerpt may end without a stop.
 */
function sentence(words: string): string {
  const said = words.charAt(0).toUpperCase() + words.slice(1);
  return /[.!?…]$/.test(said) ? said : `${said}.`;
}

/** What the row's link to the phase reads, by what is there to read. */
function readMoreWords(row: WayForwardRow): string {
  if (row.state === 'stuck') return 'Read the full handoff';
  if (row.state === 'done') return 'Open the phase';
  return 'Read the gate in the plan';
}

/** What the recovery model is asked about this row — or nothing, for a row only a person's verdict moves. */
function recoveryCtxOf(row: WayForwardRow, run: RunState | null, authFailure: boolean): RecoveryCtx | null {
  if (row.record) {
    return { ...(run ? { run } : {}), record: row.record, ...(authFailure ? { authFailure: true } : {}) };
  }
  if (row.stuck) return { boardState: 'stuck' };
  // A gate is RE-CHECKED, never retried: the synthetic record is what lets the
  // model say so, and Re-check leads because it starts no session and costs nothing.
  if (row.retry === 'rechecks-gate') return { boardState: 'gated', record: { status: 'gated' } };
  return null;
}

function WayForward({
  slug,
  row,
  run,
  authFailure,
  parts,
}: {
  slug: string;
  row: WayForwardRow;
  run: RunState | null;
  authFailure: boolean;
  parts: RecoveryParts;
}) {
  const ctx = recoveryCtxOf(row, run, authFailure);
  return (
    <li
      data-testid="ways-forward-row"
      data-phase={row.phase}
      className="flex min-w-0 flex-col gap-2 py-3 first:pt-1"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={phaseHref(slug, row.phase)}
          title={`Open phase ${row.phase}`}
          className="flex min-w-0 items-baseline gap-2.5 rounded-sm hover:underline [@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:items-center"
        >
          <span className="text-meta text-ink-muted tnum">P{row.phase}</span>
          <span className="min-w-0 break-words text-body text-ink">{row.title}</span>
        </a>
        <PhaseStatus board={row.state as WordOf<'board'>} title={boardStateTitle(row.state)} />
        {row.errand ? (
          <SituationCategoryMark situation={row.errand.situation} />
        ) : (
          row.haltKind && (
            <HaltCategoryMark category={categoryOfHalt(row.haltKind, row.record?.situation?.key)} />
          )
        )}
        {row.retry === 'rechecks-gate' && row.gateKind !== 'ai' && (
          // The gate's word, beside a Re-check that asks nothing of anyone: a
          // gate is a wait, and the item in Your turn is the summons. A
          // session's gate is cleared by the session, so it asks no person.
          <span
            data-testid="ways-forward-gate"
            className="text-meta text-ink-muted"
            title="A gate is a decision the plan reserved for a person. The console can re-check it, never take it for you."
          >
            Needs your confirmation
          </span>
        )}
      </div>
      <p data-testid="ways-forward-why" className="max-w-(--measure) break-words text-body text-ink-muted">
        {sentence(row.why)}
        {row.readMore && (
          <>
            {' '}
            <a href={row.readMore} className="rounded-sm text-ink underline-offset-2 hover:underline">
              {readMoreWords(row)}
            </a>
          </>
        )}
      </p>
      {row.errand?.budget && <BudgetRaise slug={slug} phase={row.phase} fact={row.errand.budget} />}
      {ctx && (
        <RecoveryActions
          target={{ slug, phase: row.phase, ...(run?.id ? { runId: run.id } : {}) }}
          ctx={ctx}
          max={1}
          leadTestId="halt-recommended"
          parts={parts}
        />
      )}
    </li>
  );
}

export function RunWaysForward({
  slug,
  planPhases,
  run,
  live,
  authFailure,
  parts,
}: {
  slug: string;
  planPhases: readonly PhaseView[];
  run: RunState | null;
  live: boolean;
  authFailure: boolean;
  /** The account row a recovery spends, lent by the view (`ACCOUNT_RECOVERY_PARTS`). */
  parts: RecoveryParts;
}) {
  if (live) return null;
  // The RUN-level facts — a spent budget, the streak, an unusable estate — are
  // the halt card's, drawn once above the folds; here are the phases.
  const rows = waysForwardRows(slug, planPhases, run);
  if (!rows.length) {
    return (
      <p data-testid="ways-forward" data-state="empty" className="text-body text-ink-muted">
        No phase is stopped.
      </p>
    );
  }
  return (
    <div data-testid="ways-forward" className="flex min-w-0 flex-col gap-1">
      {/* Only the rows that are true without a run can stand before a first
          boarding — a blocked handoff, a QA verdict, a gate on a ready phase —
          so the list is honest already; what it is called must be too. */}
      {run === null && (
        <p data-testid="ways-forward-lead" className="text-meta text-ink-muted">
          Nothing has run yet. Before this plan can run, each of these needs a move.
        </p>
      )}
      <ul
        className="flex min-w-0 flex-col divide-y divide-rule"
        aria-label={run === null ? 'What stands before the first run' : 'Stopped phases'}
      >
        {rows.map((row) => (
          <WayForward
            key={row.phase}
            slug={slug}
            row={row}
            run={run}
            authFailure={authFailure}
            parts={parts}
          />
        ))}
      </ul>
    </div>
  );
}
