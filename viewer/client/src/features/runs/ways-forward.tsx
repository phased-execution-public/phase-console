/**
 * Why this plan is stopped — and the way forward.
 *
 * A stopped run used to answer "what now?" with a status word: *blocked*,
 * *parked*, *halted* — each true and none actionable. The facts were always on
 * the wire (the blocked handoff's own Outstanding text, the gate conditions
 * the plan wrote, the note the runner recorded when it parked a phase); this
 * card puts each stopped phase's cause IN ITS OWN WORDS next to the one action
 * that actually moves it:
 *
 *   · a phase whose HANDOFF says blocked → the Outstanding excerpt + Repair
 *     with AI (`plan-repair` — its stale-handoff advice is exactly this job);
 *   · a GATED phase the runner parked → the gate's own conditions + where to
 *     read them, and Retry for after the person has confirmed them (a gate is
 *     deliberately a human's call — no button may bypass it);
 *   · a failed/interrupted/parked record → its note + the matching recovery
 *     class + Retry (which now genuinely restarts the run).
 *
 * Rendered only when nothing is driving: while a run is live the tabs and the
 * table are the truth, and stacking advice on a moving run reads as alarm.
 *
 * And it says "stopped" only about something that was going. A plan with no run
 * at all still has things standing between it and a first boarding — that is a
 * checklist, not an incident, and it is titled like one.
 */

import { Button, Card, CardBody, CardHeader, CardTitle, Chip, StateChip } from '@/components/ui';
import { phaseHref } from '@shared/routes.js';
import { RecoveryActions } from '@/components/recovery-actions';
import type { Errand, PhaseView, RunState } from '@/lib/api';

/** One stopped phase, with its cause and its way forward. */
type Row = {
  phase: number;
  title: string;
  state: string;
  why: string;
  /** This run's record of the phase — the shared model computes the offers;
   * its cached situation names the Ways-forward strip. */
  record?: { status: string; resumable: boolean; situation?: { key: string } | undefined } | undefined;
  /** The one ask the ladder left for this phase, when it ran out. */
  errand?: Errand | undefined;
  /** The BOARD calls it stuck (blocked handoff, often no record) — plan-repair's job. */
  stuck?: boolean | undefined;
  /** Offer Retry — with gate rows it re-checks; with records it restarts. */
  retry?: 'restarts' | 'rechecks-gate' | undefined;
  /** Link into the plan, for gates a person has to read before acting. */
  readMore?: string | undefined;
};

/** The first breath of a longer text — enough to know why, not a second page. */
function excerpt(text: string | undefined, max = 300): string | undefined {
  const clean = text?.replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function nextStepRows(slug: string, planPhases: readonly PhaseView[], run: RunState | null): Row[] {
  const rows: Row[] = [];
  for (const p of planPhases) {
    const record = run?.phases?.[String(p.phase)];

    if (p.state === 'done') {
      // A done phase whose QA verdict is not pass or waived is settled as WORK
      // and unsettled as a BLOCKER: the engine holds every dependent behind it.
      // This branch used to `continue` straight past it, and the waiting phases
      // below have no record to match either — so on a plan wedged exactly this
      // way the only row this card produced was for a downstream GATED phase,
      // already approved and six dependencies away. A card titled "Why this is
      // stopped" named a cause that was not the cause, and the real one — a
      // verdict a person had to give — appeared nowhere on the page.
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
      // A red record on a green phase used to be a standing contradiction —
      // the reconcile pass now closes it as "closed outside this run" the
      // moment any read or drive tick sees the board. This branch remains for
      // a record the reconcile has not reached yet (an old console, a stale
      // tab), and the copy says the correction is coming rather than
      // apologising for a permanent state.
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
        // Never "…and records no Outstanding section": that is a claim about
        // the FILE, and `outstanding` is `?include=handoffs` — so a caller that
        // did not ask for it would read the sentence as evidence about a
        // handoff nobody had opened. The run tab does ask; the fallback still
        // must not assert what an absent field cannot tell it.
        why: excerpt(p.handoff?.outstanding) ?? `its handoff is marked ${p.handoff?.status ?? 'blocked'}.`,
        stuck: true,
        readMore: p.handoff?.file ? phaseHref(slug, p.phase) : undefined,
      });
      continue;
    }

    // A gate explains a stop only when the gate is what the phase is actually
    // waiting on. `gated` is a FLAG orthogonal to the board bucket, so a
    // WAITING phase can carry one — and it means "when your turn comes, a
    // person confirms first", not "this is why nothing is moving". Reported:
    // a plan that had never been run once rendered "Why this is stopped"
    // naming the gate on phase 12, eleven un-started dependencies away. The
    // proximate blocker is the gate only when the phase is otherwise ready to
    // board, or when this run already stopped ON the gate and said so.
    const gateHeld = record != null && ['parked', 'gated', 'pending'].includes(record.status);
    if (p.gated && (gateHeld || (record == null && p.state === 'ready'))) {
      rows.push({
        phase: p.phase,
        title: p.title,
        state: p.state,
        why:
          record?.note ??
          (p.gateKind === 'ai'
            ? `gated (ai-clearable) — a booted session verifies and clears it itself${p.gates ? `: ${excerpt(p.gates, 200)}` : '.'}`
            : p.gates
              ? `gated — the plan asks a person to confirm first: ${excerpt(p.gates, 220)}`
              : 'gated — the plan names a condition a person must confirm before this phase runs.'),
        retry: 'rechecks-gate',
        readMore: phaseHref(slug, p.phase),
      });
      continue;
    }

    // The ladder's errand for the phase — present on a parked record, and on a
    // pending one the ladder reset and could not board (a flipped MCP park, a
    // re-board the run halted before). Either way the row leads with its ask.
    const errand = run?.recoveries?.[String(p.phase)]?.errand;
    if (record && (['failed', 'interrupted', 'parked', 'gated'].includes(record.status) || errand)) {
      const haltHere = run?.halt?.phase === p.phase ? run.halt.reason : undefined;
      rows.push({
        phase: p.phase,
        title: p.title,
        // 🔴 The BOARD's word, like both rows above — this passed
        // `record.status` and the two vocabularies are not interchangeable.
        // `StateChip` resolves through `asPhaseState`, which falls back to
        // `waiting` for anything outside the five board buckets, so `failed`,
        // `interrupted`, `parked` and `gated` ALL read "Waiting" — on the strip
        // whose entire job is listing stopped phases and what to do about them.
        // The record's own word is not lost: it rides in `record.status` below,
        // which is what the detail text reads. Same class as the Now row's, and
        // the third instance of it; it pre-dates this plan by three weeks.
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
        retry: 'restarts',
      });
    }
  }
  return rows;
}

export function NextSteps({
  slug,
  planPhases,
  run,
  live,
  authFailure,
}: {
  slug: string;
  planPhases: readonly PhaseView[];
  run: RunState | null;
  live: boolean;
  authFailure: boolean;
}) {
  if (live) return null;
  const rows = nextStepRows(slug, planPhases, run);
  if (!rows.length) return null;

  // A plan nobody has run yet has not STOPPED — it has not started. The rows a
  // runless plan can produce are, structurally, only the three that are true
  // without one (a blocked handoff, a finished phase whose QA verdict holds its
  // dependents, a ready phase behind a gate): every other branch above needs a
  // record, and a record needs a run. So the list is already honest and only
  // the heading was not.
  const neverRan = run === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {neverRan ? 'Before this plan can run' : 'Why this is stopped — and the way forward'}
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.map((row) => {
          return (
            <div
              key={row.phase}
              className="flex flex-col gap-1.5 border-b border-rule pb-3 last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs text-ink-faint">P{row.phase}</span>
                <span className="min-w-0 truncate text-sm font-medium">{row.title}</span>
                <StateChip state={row.state} board />
              </div>
              <p className="max-w-prose text-2xs text-ink-muted">{row.why}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {(row.record || row.stuck || row.retry === 'rechecks-gate') && (
                  <RecoveryActions
                    target={{ slug, phase: row.phase, ...(run?.id ? { runId: run.id } : {}) }}
                    ctx={
                      row.record
                        ? {
                            ...(run ? { run } : {}),
                            record: row.record,
                            ...(authFailure ? { authFailure: true } : {}),
                          }
                        : row.stuck
                          ? { boardState: 'stuck' }
                          : // A gated row used to carry its own "Retry (re-checks
                            // the gate)" button, which called `runRetry` — the
                            // wrong verb under a misleading name, and the last
                            // remedy rendered outside the shared model. A gate is
                            // re-CHECKED: the synthetic record is what lets the
                            // model say so, and Re-check leads because it starts
                            // no session and costs nothing.
                            { boardState: 'gated', record: { status: 'gated' } }
                    }
                    max={2}
                  />
                )}
                {row.readMore && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={row.readMore}>
                      {row.state === 'stuck'
                        ? 'Read the full handoff'
                        : row.state === 'done'
                          ? 'Open the phase'
                          : 'Read the gate (plan)'}
                    </a>
                  </Button>
                )}
                {row.retry === 'rechecks-gate' && (
                  <Chip
                    tone="gate"
                    title="A gate is a decision the plan reserved for a person. The console can re-check it, never take it for you."
                  >
                    needs your confirmation
                  </Chip>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
