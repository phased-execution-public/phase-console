/**
 * The ladder, drawn: what the machine tried on a phase, what it is doing now,
 * what it tries next — and, when the ladder is exhausted (or the situation
 * was a person's from the start), the ONE errand it left: what is needed and
 * how to give it.
 *
 * Two pieces, both pure renderings of `ladderView()` (`lib/ladder.ts`):
 *
 *   · `LadderStrip` — one line under a Ways-forward group: the situation chip,
 *     the rungs climbed (each with how it ended), the rung in flight, the next
 *     rung. Every word comes from `shared/ladder-model.js`, the table the
 *     server climbs, so the strip and the journal can never disagree.
 *   · `ErrandCard` — the card a person is asked with, once. `need` leads,
 *     `how` follows, and what the autopilot already tried is listed so nobody
 *     repeats it by hand. No buttons of its own: the surface that shows it
 *     puts its Ways forward beside it. A person's errand IS an item of Your
 *     turn (control-tower phase 139, #216) — the step the console raised for
 *     it — so where the inbox holds that item, the card draws the item's row
 *     (its ONE primary, and a link to its place on the page) in place of the
 *     how sentence: the page carries the how, as a guide.
 *
 * Neither renders anything for a resolved run — `ladderView()` is empty there,
 * because a settled question is not relitigated, errand included.
 */

import { ArrowRight, Footprints, Hand, Loader2 } from 'lucide-react';
import { RUNG_DRIVER_LABELS, drivableBy } from '@shared/ladder-model.js';
import { Badge, RelativeTime, type BadgeTone } from '@/components/ui';
import { money, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Errand } from '@/lib/api';
import { useAttentionInbox } from '@/lib/queries';
import { useInboxActions } from '@/components/inbox-row';
import { LazyItemRow } from '@/features/turn/lazy-item-row';
import { errandRow } from '@/features/turn/surfaces';
import type { LadderSituation, LadderView, TriedRung } from '@/lib/ladder';
import { capArithmetic, SituationCategoryMark } from '@/components/halt-mark';

/** What the actor word means for a situation with no rung left to climb. */
const NO_RUNG_WORDS: Record<LadderSituation['actor'], string> = {
  machine: 'no rung left — the next pass leaves an errand',
  person: "a person's to settle — no automatic rung",
  wait: 'settles itself — nothing to climb',
  none: 'nothing is wrong',
};

const SITUATION_TONE: Record<LadderSituation['actor'], BadgeTone> = {
  person: 'accent',
  machine: 'live',
  none: 'ok',
  wait: 'neutral',
};

function when(iso: string | undefined): string | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? relativeTime(ms) : undefined;
}

function TriedChip({ rung }: { rung: TriedRung }) {
  const tone =
    rung.outcome === 'fixed'
      ? 'ok'
      : rung.outcome === 'running'
        ? 'live'
        : rung.outcome === 'failed'
          ? 'bad'
          : 'neutral';
  // The ladder table's drivability column (phase 10): who can drive this rung's
  // vehicle — the console, a write, an agent, or nobody.
  const driver = drivableBy(rung.rung);
  const title = [
    rung.label,
    rung.outcomeLabel ? `— ${rung.outcomeLabel}` : undefined,
    when(rung.at) ? `(${when(rung.at)})` : undefined,
    typeof rung.costUsd === 'number' ? `· ${money(rung.costUsd)}` : undefined,
    rung.note ? `· ${rung.note}` : undefined,
    `· driven by ${RUNG_DRIVER_LABELS[driver] ?? driver}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Badge tone={tone} title={title} data-testid="ladder-tried" data-driver={driver}>
      {rung.label}
      {rung.outcomeLabel && <span className="text-ink-faint"> → {rung.outcomeLabel}</span>}
    </Badge>
  );
}

/**
 * One line: situation · tried · now · next. Renders nothing when the view is
 * empty, so a surface can drop it in unconditionally.
 */
export function LadderStrip({ view, className }: { view: LadderView; className?: string }) {
  if (view.empty) return null;
  const { situation } = view;
  const settled = Boolean(view.errand);
  return (
    <div
      data-testid="ladder"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-muted', className)}
    >
      {situation && (
        <span className="inline-flex items-center gap-1">
          <span className="text-ink-faint">Situation</span>
          <Badge
            tone={SITUATION_TONE[situation.actor]}
            title={`${situation.key} — ${situation.actor === 'machine' ? 'the autopilot climbs its ladder' : situation.actor === 'person' ? 'a person is needed' : situation.actor === 'wait' ? 'nothing to do but wait' : 'nothing is wrong'}`}
          >
            {situation.label}
          </Badge>
        </span>
      )}
      {view.tried.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Footprints size={11} className="text-ink-faint" aria-hidden />
          <span className="text-ink-faint">tried</span>
          {view.tried.map((rung, index) => (
            <TriedChip key={`${rung.rung}-${rung.at}-${index}`} rung={rung} />
          ))}
        </span>
      )}
      {view.running && (
        <span className="inline-flex items-center gap-1" data-testid="ladder-running">
          <Loader2 size={11} className="animate-spin text-running" aria-hidden />
          <span className="text-ink-faint">now</span>
          <span className="text-ink">{view.running.label}</span>
        </span>
      )}
      {view.next && (
        <span className="inline-flex items-center gap-1" data-testid="ladder-next">
          <ArrowRight size={11} className="text-ink-faint" aria-hidden />
          <span className="text-ink-faint">next</span>
          <Badge tone="live" title={`${view.next.blurb}${view.next.spends ? '' : ' Free.'}`}>
            {view.next.label}
          </Badge>
        </span>
      )}
      {!view.next && !view.running && !settled && situation && (
        <span className="text-ink-faint" data-testid="ladder-none">
          · {NO_RUNG_WORDS[situation.actor]}
        </span>
      )}
    </div>
  );
}

/**
 * The one ask. `compact` drops the tried list (a dashboard card that already
 * shows the strip); `situationLabel` is the word for the chip when the caller
 * has it, else the raw key the errand carries.
 */
export function ErrandCard({
  errand,
  situationLabel,
  compact = false,
  className,
  scope,
}: {
  errand: Errand;
  situationLabel?: string | undefined;
  compact?: boolean;
  className?: string;
  /** The run the errand belongs to — where its item is looked up. */
  scope?: { slug: string; runId?: string | undefined } | undefined;
}) {
  const { data: inbox } = useAttentionInbox(false, Boolean(scope));
  const { perform, busy } = useInboxActions();
  const item = scope
    ? errandRow(inbox?.items ?? [], { slug: scope.slug, runId: scope.runId, phase: errand.phase })
    : undefined;
  return (
    <div
      role="note"
      data-testid="errand"
      aria-label={`Needs you${errand.phase ? ` — phase ${errand.phase}` : ''}`}
      // An errand is the one ask a person owes, so it is amber through `--accent`
      // (tokens 6.0: `--action` is ink and would have quieted it).
      className={cn('rounded-md border border-accent/55 bg-accent/8 px-3 py-2 text-sm', className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Hand size={14} className="text-accent" aria-hidden />
        <strong className="font-medium text-ink">
          Needs you{errand.phase ? ` — phase ${errand.phase}` : ''}
        </strong>
        <Badge tone="accent" title={errand.situation}>
          {situationLabel ?? errand.situation}
        </Badge>
        {/* The family the halt card uses (control-tower phase 17), so an ask
            reads the same kind of stop wherever it is drawn. */}
        <SituationCategoryMark situation={errand.situation} />
        {errand.at && <RelativeTime at={errand.at} className="ml-auto text-2xs text-ink-faint" />}
      </div>
      <p className="mt-1 max-w-prose text-sm text-ink">{errand.need}</p>
      {item ? (
        <LazyItemRow row={item} perform={perform} className="mt-1.5" {...(busy ? { busy } : {})} />
      ) : (
        <p className="mt-0.5 max-w-prose text-2xs text-ink-muted">
          <strong className="font-medium text-ink-muted">How:</strong> {errand.how}
        </p>
      )}
      {/* A cap's arithmetic and the setting that raises it (#14) — "the
          ladder's sessions did not carry it" with nothing tried told nobody
          what was spent, or where. */}
      {capArithmetic(errand) && (
        <p className="mt-0.5 max-w-prose text-2xs text-ink-muted" data-testid="errand-cap">
          {capArithmetic(errand)}
        </p>
      )}
      {/* Said BEFORE the press (#14 ask 3): a Retry of this phase forgives what the cap counted. */}
      {errand.replenishes && (
        <p className="mt-0.5 max-w-prose text-2xs text-ink-muted" data-testid="errand-replenishes">
          A Retry of this phase gives the cap back what it counted here — the rungs start again.
        </p>
      )}
      {!compact && errand.said && (
        /*
         * Verbatim, and in the card rather than a tooltip: a refusal cannot be
         * acted on without reading what was refused, and the table's `need`
         * and `how` are fixed sentences that by construction cannot quote it.
         */
        <p className="mt-1 max-w-prose text-2xs italic text-ink-muted" data-testid="errand-said">
          It said: “{errand.said}”
        </p>
      )}
      {!compact && errand.tried.length > 0 && (
        <p className="mt-1 max-w-prose text-2xs text-ink-faint" data-testid="errand-tried">
          Tried by the autopilot: {errand.tried.join(' · ')}
        </p>
      )}
    </div>
  );
}
