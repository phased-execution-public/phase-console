/**
 * What a plan is drawn with — read by BOTH views, the list and the cards, so
 * a plan cannot read one way as a line and another as a card.
 *
 * The row leads with its mark (the plan's status badge, and a run's or a
 * person's word beside it) as the button whose *Why* opens the reasons behind
 * it, then the name and the plan as a line drawn in proportion, then its live
 * facts — what is being worked on now, what it waits on, its items on Your
 * turn, the work left, what its runs spent, who pays and on which model — and
 * when it last moved. The line is the console's one graphic (design.md §7):
 * sixty plans stacked are sixty parallel pipelines of different fill, and the
 * shape of the estate reads before a word does. Everything here is drawn from
 * what the list already holds — the plans, the slim runs, the inbox, the
 * accounts — with no per-plan fetch, and a board the engine could not read
 * draws its last reading and the shared words (#96), never a line at 0 %.
 */

import { cn } from '@/lib/cn';
import { etaLabel, etaTitle } from '@/lib/format';
import { Money, Mono } from '@/ui';
import { AttentionMark, DotWord, PhaseStatus, PlanStatus, type WordOf } from '@/ui/status';
import { phaseHref, planHref, runHref } from '@/shell/routes';
import { closedTitle } from '@/lib/closure';
import { concerns, kindWord, leftWords, markKind, markLabel, planView, type PlanRow } from './model';
import { PlanTrack } from './track-bar';
import { liveNowOf, waitsOnOf } from './why';

/**
 * The row's status: the plan's own status as a badge (#361, design.md §1
 * rule 4), and — when a run or a person leads (see `markKind`) — that word
 * BESIDE it, never instead of it: a plan with a run still says what the plan
 * is. A document is not a plan, so it has no status, only its kind.
 */
export function PlanMark({ row, size = 'sm' }: { row: PlanRow; size?: 'sm' | 'md' }) {
  const kind = markKind(row);
  if (kind === 'kind') {
    return <span className="whitespace-nowrap text-meta text-ink-muted">{kindWord(row)}</span>;
  }
  const badge = (
    <PlanStatus
      status={row.status as WordOf<'plan'>}
      chrome="badge"
      size={size}
      withNote={false}
      data-testid="plan-mark"
      {...(row.isClosed ? { title: closedTitle(row) } : {})}
    />
  );
  if (kind === 'plan') return badge;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {kind === 'attention' ? (
        <AttentionMark
          level="needs-you"
          size={size}
          title={`${row.needsYou} waiting on you — on Your turn`}
          data-testid="plan-attention"
        />
      ) : (
        // Never breathing: the run is observed live on Runs, and a library of
        // pulsing dots would spend the page's one motion on every running plan.
        <DotWord view={row.run!.view} size={size} withNote={false} data-testid="plan-run-mark" />
      )}
      {badge}
    </span>
  );
}

/** The words the row's status says, as one phrase — "Running and Active", "Needs you and Active". */
export function statusWordsOf(row: PlanRow): string {
  const kind = markKind(row);
  if (kind === 'kind' || kind === 'plan') return markLabel(row);
  return `${markLabel(row)} and ${planView(row).label}`;
}

/**
 * The row's status as a button: the mark, and *Why* beside it, which opens
 * the plan in the panel on the reasons behind the word — what needs you, what
 * stopped it, what is running, what it waits on, how it ended (`./why`). One
 * press, the same door as Inspect (design.md §1, principle 3). The marks
 * inside it are no tab stops of their own: a status inside a control is the
 * control's (`ui/tooltip.tsx`), and the tap is the button's.
 */
export function PlanStatusButton({
  row,
  onWhy,
  size = 'sm',
  pressed = false,
}: {
  row: PlanRow;
  onWhy: (row: PlanRow) => void;
  size?: 'sm' | 'md';
  /** The panel holds this plan now. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="plan-status-why"
      aria-label={`Why ${row.title} says ${statusWordsOf(row)}`}
      aria-pressed={pressed}
      onClick={() => onWhy(row)}
      className="group inline-flex min-h-6 min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-start [@media(hover:none)]:min-h-(--tap-min)"
    >
      <PlanMark row={row} size={size} />
      <span
        aria-hidden
        className="text-meta text-ink-muted underline-offset-2 group-hover:text-ink group-hover:underline"
      >
        Why
      </span>
    </button>
  );
}

/**
 * What is being worked on NOW — each phase a session or a console check is
 * on, as a way into it with its lane's word (`liveNowOf`). A parked or queued
 * lane is no work being done; the row's *Waiting on* says what holds it.
 */
export function NowCell({ row }: { row: PlanRow }) {
  const lanes = liveNowOf(row);
  if (!lanes.length) return <span className="text-ink-faint">—</span>;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5 text-meta" data-testid="plan-now">
      {lanes.map((lane) => (
        <li key={lane.phase} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <a
            href={phaseHref(row.slug, lane.phase)}
            className="tap-row inline-flex min-h-6 min-w-6 items-center rounded-sm text-ink underline-offset-2 hover:underline"
          >
            P{lane.phase}
          </a>
          <PhaseStatus record={{ status: lane.status as WordOf<'phase'> }} />
        </li>
      ))}
    </ul>
  );
}

/** The ONE thing the plan waits on, in a few words, and the server's own words under them (`waitsOnOf`). */
export function WaitsCell({ row }: { row: PlanRow }) {
  const waits = waitsOnOf(row);
  if (!waits) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-testid="plan-waits">
      <span className="min-w-0 break-words text-meta text-ink">{waits.lead}</span>
      {waits.detail && (
        <span className="line-clamp-2 min-w-0 break-words text-meta text-ink-muted" title={waits.detail}>
          {waits.detail}
        </span>
      )}
    </span>
  );
}

/** Its items on Your turn: every open one, as the way to the plan's own Your turn, and those it asks now. */
export function TurnCell({ row }: { row: PlanRow }) {
  if (!row.turn.open) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-meta" data-testid="plan-turn">
      <a
        href={planHref(row.slug, 'turn')}
        className="tap-row inline-flex min-h-6 items-center self-start rounded-sm text-ink underline-offset-2 hover:underline"
      >
        {row.turn.open} open
      </a>
      {row.turn.now > 0 && <span className="text-ink-muted">{row.turn.now} to do now</span>}
    </span>
  );
}

/** The work left, in sessions, with the server's estimate under it. */
export function LeftCell({ row }: { row: PlanRow }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="tnum">{leftWords(row)}</span>
      {row.eta && !row.isClosed && !row.isComplete && (
        <span className="min-w-0 break-words text-meta text-ink-muted" title={etaTitle(row.eta)}>
          {etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}
        </span>
      )}
    </span>
  );
}

/** What its runs have spent, booked; what is still in flight is said beside it. */
export function SpentCell({ row }: { row: PlanRow }) {
  if (!row.spend.runs) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Money
        usd={row.spend.usd}
        title={`What ${row.spend.runs === 1 ? 'its run has' : `its ${row.spend.runs} runs have`} spent, booked`}
      />
      {row.spend.liveUsd > 0 && (
        <span className="text-meta text-ink-muted">
          <Money usd={row.spend.liveUsd} /> in flight
        </span>
      )}
    </span>
  );
}

/** Who pays for its newest run: the account's own name, and whose models it runs. */
export function AccountCell({ row }: { row: PlanRow }) {
  if (!row.account) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="min-w-0 break-words">{row.account.who}</span>
      <span className="text-meta text-ink-muted">{row.account.provider}</span>
    </span>
  );
}

/** The model its newest run works on, and its effort — else the model the plan names. */
export function ModelCell({ row }: { row: PlanRow }) {
  const record = row.run?.record;
  const model = record?.model ?? row.summary?.targetModel;
  if (!model) return <span className="text-ink-faint">—</span>;
  const effort = record?.effort;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Mono value={model} />
      {record && effort ? (
        <span className="text-meta text-ink-muted">effort {effort}</span>
      ) : (
        !record && <span className="text-meta text-ink-muted">the plan’s</span>
      )}
    </span>
  );
}

/**
 * The plan as a line, at the size of a row: its phases in proportion, each
 * board bucket a segment, the counts in words beside it (#360, `PlanTrack`).
 * A plan with no phases draws nothing; an unread board draws its last reading
 * and says so.
 */
export function PlanLine({ row, className }: { row: PlanRow; className?: string }) {
  if (!row.phases) return <span className={cn('text-meta text-ink-faint', className)}>No phases</span>;
  // A floor of its own: on a phone's card the line rides beside the mark and
  // the clock, which would squeeze the bar to a sliver. At 15rem it takes a
  // line of its own there, and in the list its column (min 280) always holds it.
  return <PlanTrack row={row} className={cn('min-w-60', className)} />;
}

/**
 * The phases that could start now, each a way into itself — never on a closed
 * plan, whose ready phases stay populated by design and are a door nobody
 * will walk through.
 */
export function NextUpLinks({ row, max = 4 }: { row: PlanRow; max?: number }) {
  if (row.isClosed || !row.readyPhases.length) return null;
  const shown = row.readyPhases.slice(0, max);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
      {shown.map((phase) => (
        <a
          key={phase}
          href={phaseHref(row.slug, phase)}
          // A box floor, never an overhang: in a record's fold the next row's links sit
          // right under these (design.md §6.1). 24 px at the least under a fine pointer
          // too (WCAG 2.5.8), side by side as they are.
          className="tap-row inline-flex min-h-6 items-center whitespace-nowrap rounded-sm text-ink underline-offset-2 hover:underline"
        >
          P{phase} next up
        </a>
      ))}
      {row.readyPhases.length > max && (
        <span className="text-ink-muted">{row.readyPhases.length - max} more</span>
      )}
    </span>
  );
}

/** What is wrong with the plan, worst first — red for what is broken, quiet for what is worth knowing. */
export function ConcernLines({ row, skipWaiting = false }: { row: PlanRow; skipWaiting?: boolean }) {
  const list = concerns(row).filter((c) => !skipWaiting || c.key !== 'needs-you');
  if (!list.length) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5 text-meta">
      {list.map((concern) => (
        <li
          key={concern.key}
          data-concern={concern.key}
          className={cn(
            'min-w-0 break-words',
            concern.tone === 'bad' ? 'state-failed text-state' : 'text-ink-muted',
          )}
        >
          {concern.text}
        </li>
      ))}
    </ul>
  );
}

/** The newest run, as a way into its view — its word in context and the phase it is on. */
export function RunLink({ row }: { row: PlanRow }) {
  if (!row.run) return null;
  const { view, activePhase } = row.run;
  return (
    <a
      href={runHref(row.slug)}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:underline"
      title="Open the run"
    >
      <DotWord view={view} withNote={false} />
      {activePhase != null && <span className="tnum text-meta text-ink-muted">P{activePhase}</span>}
    </a>
  );
}
