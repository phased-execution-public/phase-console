/**
 * The badges a phase row carries, and the words behind them.
 *
 * Three facts reached the client before this phase and were rendered nowhere:
 *
 *   - **evidence** — `shared/evidence-model.js` `deriveEvidence`, on every
 *     `PhaseView` since Phase 4. The board says a phase is done; this says
 *     whether the handoff, the §Verification result and the QA table agree.
 *     A `done` row that is not `evidenced` is the single most useful thing
 *     this table can tell anyone, and it was invisible.
 *   - **liveness** — `RunDetail.liveness[]`, since Phase 5. A lane that has
 *     not stopped is not the same as a lane that is working.
 *   - **rulings** — the plan's ledger, since Phase 5. A count on the row, the
 *     decisions themselves in the drawer.
 *
 * They live here rather than in `phase-table.tsx` because Phase 9's Phases tab
 * renders the same three against the same shapes, and a badge whose rule was
 * inlined in the run page's table would be a second implementation by the time
 * it got there.
 *
 * Every one of them degrades to rendering NOTHING when its fact is absent —
 * an older server simply does not send `proof` or `liveness`, and a blank cell
 * is the honest rendering of "this console cannot tell you", where a green
 * tick would be a lie.
 */

import { memo } from 'react';
import { Chip, KeyValue, RelativeTime, StateChip } from '@/components/ui';
import { phaseSessionHref } from '@/app/routes';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { EvidenceProof, LaneLiveness, PhaseLive, PhaseLock } from '@/lib/api';
import { PHASE_ACTOR_LABELS } from '@/lib/status-vocab';
import { ACTOR_ICON } from '@/components/actor-icon';
import { STALL_SIGNAL_META } from '@shared/attention-model.js';

/* ---------------- evidence ---------------- */

/**
 * How each verification word reads, and whether it is a problem.
 *
 * `skipped` and `human` are not failures: the first is a command whose lead is
 * not installed on this machine (the supervisor records and moves on), and the
 * second is a §Verification only a person can answer. Painting either red
 * would train people to ignore red.
 */
const VERIFICATION_NOTE: Record<EvidenceProof['verification'], string> = {
  green: 'the §Verification commands ran and passed',
  red: 'a §Verification command failed',
  skipped: 'a §Verification command was skipped — its lead is not installed here',
  human: 'the §Verification needs a person',
  none: 'no §Verification result was recorded',
};

const QA_NOTE: Record<EvidenceProof['qa'], string> = {
  pass: 'QA passed',
  fail: 'QA failed',
  waived: 'QA was waived',
  pending: 'QA has not reported',
  off: 'this plan does not run QA',
};

/**
 * The one-line verdict: claimed, and whether anything on disk backs it.
 *
 * `verbose` is the drawer's rendering — every `why` line spelled out. The row
 * gets the chip alone, because a row with five sentences in it is a row nobody
 * scans.
 *
 * ## Two claims, two chips
 *
 * A `done` board word claims work FINISHED, and `evidenced` says whether
 * anything ran to back it — the chip is "evidenced" or "claimed only".
 *
 * An `in-progress` board word claims work IS HAPPENING, and `stale` says
 * whether anything was observed behind it — the chip is "claimed running".
 * That second claim had no chip at all, which is B2(a): a phase of one plan
 * on this estate painted "Running" for 18 DAYS over no run, no lock and no
 * process, because a board word is a `status:` line in a markdown file
 * and nothing in the console settled it against a fact. The two never collide
 * — a phase is one board word at a time — so `stale` is deliberately not
 * folded into `evidenced`.
 */
export function EvidenceLine({
  proof,
  verbose = false,
  className,
}: {
  proof: EvidenceProof;
  verbose?: boolean;
  className?: string;
}) {
  // Only a DONE claim can be unbacked in a way worth a badge. A `ready` phase
  // is not claiming anything yet, and badging it "not evidenced" would put a
  // warning on every plan that has not started.
  const claiming = proof.board === 'done';
  const alarming = claiming && !proof.evidenced;
  // The running claim. `=== true` and not truthiness: `stale` is optional on
  // the wire, and an older server sending nothing must read as "not measured",
  // never as "measured and empty".
  const claimedRunning = proof.stale === true;

  if (!verbose) {
    if (claimedRunning) {
      return (
        <Chip tone="warn" className={className} title={proof.why.join(' · ')}>
          claimed running
        </Chip>
      );
    }
    if (!claiming) return null;
    return (
      <Chip tone={alarming ? 'warn' : 'ok'} className={className} title={proof.why.join(' · ')}>
        {proof.evidenced ? 'evidenced' : 'claimed only'}
      </Chip>
    );
  }

  return (
    <section className={cn('rounded border border-rule bg-ground px-2 py-1.5', className)}>
      <h4 className="flex flex-wrap items-baseline gap-1.5 text-2xs font-semibold text-ink">
        Claimed versus evidenced
        <Chip tone={alarming || claimedRunning ? 'warn' : proof.evidenced ? 'ok' : 'muted'}>
          {claimedRunning
            ? 'claimed running'
            : proof.evidenced
              ? 'evidenced'
              : claiming
                ? 'claimed only'
                : proof.board}
        </Chip>
      </h4>
      {/* The shared fact list — `minmax(0,auto)` rather than the `max-content`
          this was, which has no ceiling: the longest verification sentence
          pushed the value column off the drawer's right edge. */}
      <KeyValue
        className="mt-1 text-2xs"
        items={[
          ['Board', proof.board],
          ['Handoff', proof.handoff],
          ['Verification', VERIFICATION_NOTE[proof.verification] ?? proof.verification],
          ['QA', QA_NOTE[proof.qa] ?? proof.qa],
        ]}
      />
      {proof.why.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-ink-muted">
          {proof.why.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------- the board word, and the fact behind it ---------------- */

/**
 * A phase's board state, pulsing and linking only when something is actually
 * working it.
 *
 * The ONE chip for the three surfaces that render a phase's board word beside
 * a live fact — the plan's Phases tab, the plan's Route tab and the run page's
 * phase table. Written once because the rule is the point, and a rule with
 * three copies is a rule two of them will eventually break:
 *
 *   - **It pulses only on `live`.** Never on the board word. `in-progress`
 *     comes out of a markdown file and `BOARD_STATE_UI` paints it `running`;
 *     breathing over that is B2(a).
 *   - **It links only on `live`.** A dead phase's chip is not an anchor — a
 *     link to a session that ended is the same lie one step quieter. This is
 *     `phaseSessionHref` returning `null`, which is its whole contract.
 *
 * The destination is the phase's LANE on the run page (`?lane=p<N>`), because
 * that is where an autopilot session's pane is; `pty` sends it to
 * `#/sessions/<id>` instead and is for a caller that knows the id is in the
 * console's own terminal registry (`qa-launcher` is the shipped precedent).
 */
export const PhaseStateChip = memo(function PhaseStateChip({
  slug,
  phase,
  state,
  live,
  pty = false,
  title,
  className,
}: {
  slug: string;
  phase: number;
  state: string;
  /** The observed fact. Absent — from an idle phase or an older server — means no pulse, no link. */
  live?: PhaseLive | undefined;
  pty?: boolean;
  title?: string;
  className?: string;
}) {
  const href = phaseSessionHref({ slug, phase, live: live ?? null, pty });
  const chip = <StateChip state={state} board pulse={Boolean(live)} title={title} className={className} />;
  if (!href) return chip;
  return (
    <a href={href} className="rounded-sm" title={`Phase ${phase} is being worked — open its session`}>
      {chip}
    </a>
  );
});

/* ---------------- liveness ---------------- */

/*
 * No local word-book. These two maps were a hand-kept copy of
 * `STALL_SIGNAL_META` and they had already drifted: both were missing
 * `external-wait`, so the one signal that describes a lane holding an exclusive
 * lock while it watches someone else's clock rendered as its raw key with no
 * explanation at all. `label` and `blurb` are read from shared instead.
 */

/**
 * What a lane that has NOT stopped is actually doing.
 *
 * A stall gets a warn chip and its clock; a healthy lane gets the one fact
 * that says it is alive — the last output, or the tool call that is open. No
 * chip at all when there is no lane, which is most rows.
 */
export function LivenessChip({ liveness }: { liveness: LaneLiveness | undefined }) {
  if (!liveness) return null;
  const { stall, openTool, lastOutputAt, retries } = liveness;

  if (stall) {
    return (
      <Chip tone="warn" title={`${STALL_SIGNAL_META[stall.signal]?.blurb ?? ''} ${stall.detail}`.trim()}>
        {STALL_SIGNAL_META[stall.signal]?.label ?? stall.signal} · <RelativeTime at={stall.since} />
      </Chip>
    );
  }

  /*
   * A retry storm, before it is a stall.
   *
   * 450 `phase.api-retry` events were journalled and read by nothing, so a
   * lane retrying every ~16 minutes was indistinguishable from a lane
   * thinking — and one run died to a quota climb with no stall ever raised.
   * This is the chip that makes the difference visible while the count is
   * still under `stallRetryBurst`; past it, the stall chip above takes over
   * and says the same thing louder, from the same counter.
   */
  if (retries && retries.count > 0) {
    return (
      <Chip
        tone="warn"
        title={
          `${retries.count} API retr${retries.count === 1 ? 'y' : 'ies'} since the last productive ` +
          `event, starting ${relativeTime(Date.parse(retries.since))}. The session is alive and ` +
          'spending, and it is not reaching the API — this is what a rate-limit wall looks like ' +
          'from outside.'
        }
      >
        {retries.count}× retry
      </Chip>
    );
  }

  const at = Date.parse(lastOutputAt);
  // "this attempt", not "so far": the count's window is `attemptStartedAt`, so a
  // phase that committed on an earlier attempt reads zero here. Unqualified it
  // told an operator looking at a re-boarded phase that nothing had ever been
  // committed for it, which is a different and much worse claim.
  const tail =
    `${liveness.commitsSinceStart} commit(s) this attempt` + `${liveness.treeDirty ? ', tree dirty' : ''}.`;
  return (
    <Chip
      tone="busy"
      title={
        openTool
          ? `${openTool.name} has been open since ${relativeTime(Date.parse(openTool.since))}. ${tail}`
          : `Last output ${relativeTime(at)}. ${liveness.turnsSinceLastTool} turn(s) since the last tool call, ${tail}`
      }
    >
      {openTool ? openTool.name : <RelativeTime at={at} />}
    </Chip>
  );
}

/* ---------------- who is on it ---------------- */

/**
 * Who is working this phase, named — and who holds the claim beside it.
 *
 * A phone card has no Lock column and no This-run column, so "something is on
 * this" has to fit on one line or it is not said at all. The words are the
 * shared ones (`PHASE_ACTOR_LABELS`), which is the same vocabulary the map and
 * the sessions page use for the same three drivers.
 *
 * No icon, deliberately: the one actor→icon table in this client lives in
 * `components/dag.tsx` and is not exported, and a second copy of it here is
 * exactly the drift the shared vocabulary exists to prevent. Export that map
 * and this line can wear them.
 *
 * Renders nothing at all when the server observed nothing, which is most
 * phases — and how an older server, which sends no `actor`, reads.
 */
export function PhaseActorLine({
  live,
  lock,
  className,
}: {
  live: PhaseLive | undefined;
  /** The claim, when there is one — the holder is the other half of "who". */
  lock?: PhaseLock | undefined;
  className?: string;
}) {
  const actor = live?.actor;
  if (!actor && !lock) return null;
  const held = lock ? `${lock.owner}${lock.host ? ` on ${lock.host}` : ''}` : undefined;
  const label = actor ? PHASE_ACTOR_LABELS[actor] : `claimed by ${held}`;
  const Icon = actor ? ACTOR_ICON[actor] : null;
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1 truncate', className)}
      title={actor && held ? `${label} · held by ${held}` : label}
    >
      {Icon && <Icon size={12} aria-hidden className="shrink-0" />}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/* ---------------- rulings ---------------- */

/** A count, and nothing more — the decisions themselves are in the drawer. */
export function RulingsChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Chip
      tone="muted"
      title={`${count} decision${count === 1 ? '' : 's'} the plan did not make for this phase. Open the drawer to read them.`}
    >
      {count} ruling{count === 1 ? '' : 's'}
    </Chip>
  );
}
