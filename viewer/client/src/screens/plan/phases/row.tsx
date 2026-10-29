/**
 * What a phase row says about the phase beyond its name — in words.
 *
 * The 6.x row carried a dozen chips; 7.0 draws a status as a dot and a word
 * and every other fact as words (design.md §3.1, principle 4). Each of these
 * renders NOTHING when its fact is absent: an older server sends no `proof`
 * or `liveness`, and a blank is the honest rendering of "this console cannot
 * tell you", where a green word would be a lie.
 *
 *   - the board word, linked to its session only while one is observed
 *     working it (`PhaseMark`);
 *   - the evidence — whether the handoff, the §Verification result and the QA
 *     table back a `done` claim, or anything backs an `in-progress` one;
 *   - a live lane's liveness and its context, and the rulings count;
 *   - what the session says it is doing, the branch a lane commits on, the
 *     plan's `Land:` word and where the landing has got to.
 */

import { memo } from 'react';
import { SILENCE_LABELS, STALL_SIGNAL_META } from '@shared/attention-model.js';
import { LAND_LABELS } from '@shared/landing-model.js';
import { taskSummary } from '@shared/task-model.js';
import type {
  EvidenceProof,
  LaneLiveness,
  PhaseLanding,
  PhaseLive,
  PhaseTask,
  PhaseView,
  RunState,
} from '@/data/api';
import { cn } from '@/lib/cn';
import { plural, relativeTime, weight } from '@/lib/format';
import { boardStateTitle } from '@/lib/status-vocab';
import { KeyValue, RelativeTime, SectionHeading } from '@/ui';
import { PhaseStatus, type WordOf } from '@/ui/status';
import { phaseSessionHref } from '@/shell/routes';

const SILENCE_LABEL = SILENCE_LABELS as Readonly<Record<string, string>>;
const STALL_META = STALL_SIGNAL_META as Readonly<Record<string, { label: string; blurb: string }>>;
const LAND_LABEL = LAND_LABELS as Readonly<Record<string, string>>;

/* ---------------- the board word ---------------- */

/**
 * A phase's board word, breathing and linking only while something is
 * observed working it — `live` is the server's one answer from the run
 * record, the lock and the session registry. Never on the board word alone:
 * `in-progress` comes out of a markdown file, and breathing over it is B2(a).
 * The link is the lane's (`?lane=p<N>`), or the console's own terminal for a
 * `pty` caller that knows its id is one.
 */
export const PhaseMark = memo(function PhaseMark({
  slug,
  phase,
  state,
  live,
  pty = false,
  title,
  size = 'sm',
  chrome = 'badge',
  className,
}: {
  slug: string;
  phase: number;
  state: string;
  live?: PhaseLive | undefined;
  pty?: boolean;
  title?: string | undefined;
  size?: 'sm' | 'md';
  /** `tint` where the mark is a strip's ONE lead badge (the phases grid's State column). */
  chrome?: 'badge' | 'tint';
  className?: string;
}) {
  const href = phaseSessionHref({ slug, phase, live: live ?? null, pty });
  const mark = (
    <PhaseStatus
      board={state as WordOf<'board'>}
      chrome={chrome}
      live={Boolean(live)}
      size={size}
      title={title ?? boardStateTitle(state)}
      className={className}
    />
  );
  if (!href) return mark;
  return (
    <a href={href} className="rounded-sm" title={`Phase ${phase} is being worked — open its session`}>
      {mark}
    </a>
  );
});

/* ---------------- evidence ---------------- */

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

/** The evidence's one word: what the claim is, and whether anything backs it. */
export function evidenceWord(proof: EvidenceProof): string | null {
  // `=== true`: `stale` is optional on the wire, and an older server sending
  // nothing reads as "not measured", never as "measured and empty".
  if (proof.stale === true) return 'claimed running';
  if (proof.board !== 'done') return null;
  return proof.evidenced ? 'evidenced' : 'claimed only';
}

/**
 * Claimed versus evidenced. A `done` board word claims work FINISHED and
 * `evidenced` says whether anything ran to back it; an `in-progress` one
 * claims work IS HAPPENING and `stale` says nothing was observed behind it. A
 * claim nothing backs is a caution, never a summons — ink, not amber.
 * `verbose` is the section the drawer and the inspector draw.
 */
export function EvidenceWords({
  proof,
  verbose = false,
  className,
}: {
  proof: EvidenceProof;
  verbose?: boolean;
  className?: string;
}) {
  const word = evidenceWord(proof);
  if (!verbose) {
    if (!word) return null;
    return (
      <span className={cn('text-meta text-ink-muted', className)} title={proof.why.join('. ')}>
        {word}
      </span>
    );
  }
  return (
    <section className={cn('flex flex-col gap-1.5', className)} aria-label="Claimed versus evidenced">
      <SectionHeading>Claimed versus evidenced</SectionHeading>
      <p className="text-body text-ink">{word ?? `The board reads ${proof.board}.`}</p>
      <KeyValue
        items={[
          ['Board', proof.board],
          ['Handoff', proof.handoff],
          ['Verification', VERIFICATION_NOTE[proof.verification] ?? proof.verification],
          ['QA', QA_NOTE[proof.qa] ?? proof.qa],
        ]}
      />
      {proof.why.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-meta text-ink-muted">
          {proof.why.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------- a live lane ---------------- */

/**
 * What a lane that has NOT stopped is doing, in one phrase: a stall and how
 * long, a retry storm before it is a stall, the tool that is open, or which
 * silence it is in. Nothing at all when there is no lane, which is most rows.
 */
export function LivenessWords({
  liveness,
  className,
}: {
  liveness: LaneLiveness | undefined;
  className?: string;
}) {
  if (!liveness) return null;
  const { stall, openTool, lastOutputAt, retries } = liveness;
  const tail = `${plural(liveness.commitsSinceStart, 'commit')} this attempt${liveness.treeDirty ? ', tree dirty' : ''}.`;
  if (stall) {
    const meta = STALL_META[stall.signal];
    return (
      <span
        data-testid="lane-stall"
        className={cn('text-meta text-ink', className)}
        title={`${meta?.blurb ?? ''} ${stall.detail}`.trim()}
      >
        {meta?.label ?? stall.signal} since <RelativeTime at={stall.since} />
      </span>
    );
  }
  if (retries && retries.count > 0) {
    return (
      <span
        className={cn('text-meta text-ink', className)}
        title={
          `${plural(retries.count, 'API retry', 'API retries')} since the last productive event, starting ` +
          `${relativeTime(Date.parse(retries.since))}. The session is alive and spending and not reaching the API.`
        }
      >
        {retries.count} retries
      </span>
    );
  }
  const at = Date.parse(lastOutputAt);
  return (
    <span
      data-testid="lane-liveness"
      className={cn('text-meta text-ink-muted', className)}
      title={
        openTool
          ? `${openTool.name} has been open since ${relativeTime(Date.parse(openTool.since))}. ${tail}`
          : `Last output ${relativeTime(at)}. ${plural(liveness.turnsSinceLastTool, 'turn')} since the last tool call. ${tail}`
      }
    >
      {openTool ? (
        <>
          <span className="font-mono">{openTool.name}</span> open
        </>
      ) : liveness.silence ? (
        <>
          {SILENCE_LABEL[liveness.silence.kind] ?? liveness.silence.kind} since{' '}
          <RelativeTime at={liveness.silence.sinceMs} />
        </>
      ) : (
        <>
          last output <RelativeTime at={at} />
        </>
      )}
    </span>
  );
}

/**
 * What a live session costs in context — every tool call re-reads it, so it
 * is the price of the next call. The server owns the thresholds and says the
 * stage; this reads the word, never a fraction.
 */
export function ContextWords({
  liveness,
  className,
}: {
  liveness: LaneLiveness | undefined;
  className?: string;
}) {
  const tokens = liveness?.tokens;
  if (!tokens) return null;
  const share = tokens.window ? Math.round((tokens.context / tokens.window) * 100) : null;
  const said =
    tokens.stage === 'checkpoint'
      ? ' The console is checkpointing this session; the next attempt boards fresh.'
      : tokens.stage === 'wrap-up'
        ? ' The session has been told to wrap up and hand off.'
        : '';
  return (
    <span
      data-stage={tokens.stage}
      className={cn('text-meta tabular-nums', tokens.stage ? 'text-ink' : 'text-ink-muted', className)}
      title={
        `Context ${weight(tokens.context)} now, peak ${weight(tokens.peak)}` +
        `${tokens.window ? ` of a ${weight(tokens.window)} window` : ''}. ` +
        `${plural(tokens.calls, 'API call')} this attempt: ${weight(tokens.cacheRead)} read from cache, ` +
        `${weight(tokens.cacheWrite)} written, ${plural(tokens.rebuilds, 'cache rebuild')}, ` +
        `${plural(tokens.pollCalls, 'status check')}.${said}`
      }
    >
      {weight(tokens.context)} context{share != null ? ` (${share} %)` : ''}
      {tokens.peak > tokens.context ? `, peak ${weight(tokens.peak)}` : ''}
      {tokens.stage === 'wrap-up'
        ? ', told to wrap up'
        : tokens.stage === 'checkpoint'
          ? ', checkpointing'
          : ''}
    </span>
  );
}

/**
 * What the session says it is doing: its task list in one phrase. The live
 * frame's summary first — `run:progress` moves it every few seconds, while the
 * list on the record is only as fresh as the last read of the run — and both
 * through `taskSummary`, so no surface counts a list its own way. Nothing for
 * a session that published no list: "it did not say" is not worth a line.
 */
export function TaskWords({
  tasks,
  live,
  className,
}: {
  tasks?: readonly PhaseTask[] | undefined;
  live?: { total: number; done: number; active: string | null } | undefined;
  className?: string;
}) {
  const { total, done, active } =
    live ?? (taskSummary(tasks) as { total: number; done: number; active: string | null });
  if (!total) return null;
  return (
    <span
      data-testid="task-words"
      className={cn('min-w-0 break-words text-meta text-ink-muted', className)}
      title={
        active
          ? `${done} of ${total} tasks done — the session says it is: ${active}`
          : `${done} of ${total} tasks done`
      }
    >
      <span className="tabular-nums">
        {done} of {total} tasks
      </span>
      {active ? `, ${active}` : ''}
    </span>
  );
}

/**
 * The branch THIS lane commits on, when it took a checkout of its own — read
 * from the run's `children` by the row's own phase, never from `run.child`,
 * the mirror pointer that names only the lowest live lane. Nothing for a lane
 * in the run's shared checkout.
 */
export function BranchWords({
  branch,
  base,
  className,
}: {
  branch?: string | undefined;
  base?: RunState['base'] | undefined;
  className?: string;
}) {
  if (!branch) return null;
  const cut = base ? ` Cut from ${base.ref} at ${base.sha.slice(0, 12)}.` : '';
  return (
    <span
      data-testid="lane-branch"
      className={cn('min-w-0 wrap-anywhere text-meta text-ink-muted', className)}
      title={`This lane commits on ${branch} — its own checkout, not the run’s shared tree.${cut}`}
    >
      on <span className="font-mono">{branch}</span>
    </span>
  );
}

/**
 * What the PLAN says happens to the phase's commits (`Land:`), and which line
 * said it. Nothing for the shipped default — every row would say it, and a
 * word on every row says nothing; a default the plan asked for by name is a
 * decision, and shows.
 */
export function LandWords({ land, className }: { land?: PhaseView['land'] | undefined; className?: string }) {
  if (!land || land.source === 'default') return null;
  return (
    <span
      data-testid="land-words"
      className={cn('min-w-0 text-meta text-ink-muted', className)}
      title={`${LAND_LABEL[land.value] ?? land.value}\nFrom ${land.source === 'phase' ? 'this phase’s own' : 'the plan’s'} \`Land:\` line.`}
    >
      Land: <span className="font-mono">{land.value}</span>
    </span>
  );
}

/** The engine's step, as the sentence a person waits on. */
function landingStepWords(landing: PhaseLanding): string {
  switch (landing.step) {
    case 'local':
      return 'Landing locally.';
    case 'push':
      return 'Pushing the branch.';
    case 'session':
      return 'A landing session is opening the pull request.';
    case 'verify':
      return 'Verifying the pull request with gh.';
    case 'watch':
      return 'Watching the pull request — the phase lands when it merges.';
    case 'done':
      return 'Landed.';
    case 'parked':
      return landing.resumeFrom
        ? `Parked — it resumes from ${landing.resumeFrom} on the next drive.`
        : 'Parked — a person owns the next step.';
    default:
      return String(landing.step);
  }
}

/**
 * Where the landing HAS GOT TO — the engine's word off the run record, its
 * step on the title. A parked landing says so in ink: a person owns the next
 * step, and nothing failed — the engine set the phase aside and drove on.
 */
export function LandingWords({
  landing,
  className,
}: {
  landing?: PhaseLanding | undefined;
  className?: string;
}) {
  if (!landing) return null;
  const parked = landing.step === 'parked';
  return (
    <span
      data-testid="landing-words"
      data-landing-step={landing.step}
      className={cn('min-w-0 text-meta', parked ? 'text-ink' : 'text-ink-muted', className)}
      title={landingStepWords(landing)}
    >
      landing <span className="font-mono">{landing.state}</span>
      {parked ? ', parked' : ''}
    </span>
  );
}

/** How many decisions the plan did not make for this phase — the decisions themselves are in the drawer. */
export function RulingsCount({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn('text-meta text-ink-muted', className)}
      title={`${plural(count, 'decision')} the plan did not make for this phase. Open the row to read them.`}
    >
      {plural(count, 'ruling')}
    </span>
  );
}
