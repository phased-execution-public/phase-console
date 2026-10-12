/**
 * The ladder, drawn: what the machine tried on a phase, what it is doing now,
 * what it tries next — and, when the ladder is exhausted (or the situation
 * was a person's from the start), the ONE errand it left: what is needed and
 * how to give it.
 *
 * Two pieces, both pure renderings of `ladderView()` (`lib/ladder.ts`):
 *
 *   · `LadderStrip` — the situation, then the rungs ON THE LINE (design.md
 *     §7): a ladder is a sequence of stops, so each rung is a station — the
 *     ones climbed settled, the one in flight live, the next one still to
 *     come. Every word comes from `shared/ladder-model.js`, the table the
 *     server climbs, so the line and the journal can never disagree.
 *   · `ErrandCard` — the card a person is asked with, once. `need` leads,
 *     `how` follows, and what the autopilot already tried is listed so nobody
 *     repeats it by hand. No buttons of its own: the surface that shows it
 *     puts its ways forward beside it. A person's errand IS an item of Your
 *     turn (control-tower phase 139, #216) — the step the console raised for
 *     it — so where the inbox holds that item, the card draws the item's row
 *     (its ONE primary, and a link to its place on the page) in place of the
 *     how sentence: the page carries the how, as a guide.
 *
 * Neither renders anything for a resolved run — `ladderView()` is empty there,
 * because a settled question is not relitigated, errand included.
 */

import { Hand } from 'lucide-react';
import { RUNG_DRIVER_LABELS, drivableBy } from '@shared/ladder-model.js';
import { describeWord } from '@shared/status-model.js';
import type { Errand } from '@/data/api';
import { useAttentionInbox } from '@/data/inbox';
import { errandRow } from '@/data/turn';
import { money, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { LadderSituation, LadderView, TriedRung } from '@/lib/ladder';
import { RelativeTime } from '@/ui';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { capArithmetic, SituationCategoryMark } from './halt-mark';
import { useInboxActions } from './inbox-row';
import { LazyItemRow } from './lazy-item-row';

/** What the actor means, said once beside the situation. */
const ACTOR_WORDS: Record<LadderSituation['actor'], string> = {
  machine: 'the autopilot climbs its ladder',
  person: 'a person is needed',
  wait: 'nothing to do but wait',
  none: 'nothing is wrong',
};

/** What the actor word means for a situation with no rung left to climb. */
const NO_RUNG_WORDS: Record<LadderSituation['actor'], string> = {
  machine: 'No rung left — the next pass leaves an errand.',
  person: 'A person’s to settle — no automatic rung.',
  wait: 'It settles itself — nothing to climb.',
  none: 'Nothing is wrong.',
};

function when(iso: string | undefined): string | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? relativeTime(ms) : undefined;
}

/** A climbed rung: settled on the line, painted by how it ended; the hover says when, what it cost, who drives it. */
function TriedStation({ rung }: { rung: TriedRung }) {
  const view = describeWord('rung', rung.outcome ?? null);
  // The ladder table's drivability column (control-tower phase 10): who can
  // drive this rung's vehicle — the console, a write, an agent, or nobody.
  const driver = drivableBy(rung.rung);
  const title = [
    when(rung.at),
    typeof rung.costUsd === 'number' ? money(rung.costUsd) : undefined,
    rung.note,
    `driven by ${RUNG_DRIVER_LABELS[driver] ?? driver}`,
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <Station
      paint={view.paint}
      settled={view.tense === 'settled'}
      live={rung.outcome === 'running'}
      data-testid="ladder-tried"
      data-driver={driver}
      title={title}
    >
      <span className="text-ink">{rung.label}</span>
      {rung.outcomeLabel && <span className="ms-2 text-ink-muted">{rung.outcomeLabel}</span>}
    </Station>
  );
}

/**
 * The situation and its rungs. Renders nothing when the view is empty, so a
 * surface can drop it in unconditionally.
 */
export function LadderStrip({ view, className }: { view: LadderView; className?: string }) {
  if (view.empty) return null;
  const { situation } = view;
  const settled = Boolean(view.errand);
  const rungs = view.tried.length > 0 || view.running || view.next;
  return (
    <div data-testid="ladder" className={cn('flex min-w-0 flex-col gap-1.5 text-meta', className)}>
      {situation && (
        <p className="min-w-0" title={situation.key}>
          <span className="font-medium text-ink">{situation.label}</span>
          <span className="ms-2 text-ink-muted">{ACTOR_WORDS[situation.actor]}</span>
        </p>
      )}
      {rungs && (
        <Track orientation="vertical" label="The rungs" className="ms-0.5">
          {view.tried.map((rung, index) => (
            <TriedStation key={`${rung.rung}-${rung.at}-${index}`} rung={rung} />
          ))}
          {view.running && (
            <Station paint="running" live data-testid="ladder-running">
              <span className="text-ink">{view.running.label}</span>
              <span className="ms-2 text-ink-muted">now</span>
            </Station>
          )}
          {view.next && (
            <Station
              paint="queued"
              data-testid="ladder-next"
              title={`${view.next.blurb}${view.next.spends ? '' : ' Free.'}`}
            >
              <span className="text-ink">{view.next.label}</span>
              <span className="ms-2 text-ink-muted">next</span>
            </Station>
          )}
        </Track>
      )}
      {!view.next && !view.running && !settled && situation && (
        <p className="text-ink-muted" data-testid="ladder-none">
          {NO_RUNG_WORDS[situation.actor]}
        </p>
      )}
    </div>
  );
}

/**
 * The one ask. `compact` drops the tried list (a surface that already shows
 * the ladder); `situationLabel` is the word for the situation when the caller
 * has it, else the raw key the errand carries.
 *
 * A card, because it is acted on as a unit — and the one summons on its
 * surface: its leading edge is the summons hue (`--accent`), the rest is ink.
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
  const cap = capArithmetic(errand);
  return (
    <div
      role="note"
      data-testid="errand"
      aria-label={`Needs you${errand.phase ? ` — phase ${errand.phase}` : ''}`}
      className={cn(
        'state-needs-you flex min-w-0 flex-col gap-1.5 rounded-lg border border-rule border-s-2 border-s-state bg-surface px-3 py-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-meta font-medium text-state">
          <Hand size={13} aria-hidden className="shrink-0" />
          Needs you{errand.phase ? ` — phase ${errand.phase}` : ''}
        </span>
        <span className="text-meta text-ink-muted" title={errand.situation}>
          {situationLabel ?? errand.situation}
        </span>
        {/* The family the halt card uses (control-tower phase 17), so an ask
            reads the same kind of stop wherever it is drawn. */}
        <SituationCategoryMark situation={errand.situation} />
        {errand.at && <RelativeTime at={errand.at} className="ms-auto text-meta text-ink-faint" />}
      </div>
      <p className="max-w-prose text-body text-ink">{errand.need}</p>
      {item ? (
        <LazyItemRow row={item} perform={perform} {...(busy ? { busy } : {})} />
      ) : (
        <p className="max-w-prose text-meta text-ink-muted">
          <span className="font-medium text-ink">How: </span>
          {errand.how}
        </p>
      )}
      {/* A cap's arithmetic and the setting that raises it (#14) — "the
          ladder's sessions did not carry it" with nothing tried told nobody
          what was spent, or where. */}
      {cap && (
        <p className="max-w-prose text-meta text-ink-muted" data-testid="errand-cap">
          {cap}
        </p>
      )}
      {/* Said BEFORE the press (#14 ask 3): a Retry of this phase forgives what the cap counted. */}
      {errand.replenishes && (
        <p className="max-w-prose text-meta text-ink-muted" data-testid="errand-replenishes">
          A Retry of this phase gives the cap back what it counted here — the rungs start again.
        </p>
      )}
      {!compact && errand.said && (
        /*
         * Verbatim, and in the card rather than a tooltip: a refusal cannot be
         * acted on without reading what was refused, and the table's `need`
         * and `how` are fixed sentences that by construction cannot quote it.
         */
        <p className="max-w-prose text-meta text-ink-muted" data-testid="errand-said">
          It said: “{errand.said}”
        </p>
      )}
      {!compact && errand.tried.length > 0 && (
        <p className="max-w-prose text-meta text-ink-muted" data-testid="errand-tried">
          Tried by the autopilot: {errand.tried.join(' · ')}
        </p>
      )}
    </div>
  );
}
