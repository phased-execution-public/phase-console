import { FACT_META, type StatusFact, type StatusView } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { helpHref } from '@/shell/routes';
import { useRoute } from '@/shell/router';
import { TapTip } from '@/ui/tooltip';
import { statusIcon } from './status-icons';
import { isQuiet, viewHeadline, type Chrome } from './view';

/**
 * The one renderer every member of the family draws through — a `StatusView`
 * from `shared/status-model.js` as a dot and a word (design.md §3).
 *
 * A 6 px dot carries the hue through `.state-<paint>`; the word beside it is a
 * precise word in ink. It ALWAYS draws both and always carries the three facts
 * a test or a stylesheet asks of a status: `data-status` (the word as given),
 * `data-paint` (the hue) and `data-attention` (does a person have to act).
 * Colour is never the only carrier (WCAG 1.4.1): a dot you cannot see still
 * has its word.
 *
 * Three states of the dot. Live or standing: filled with the hue. Settled:
 * hollow — and quiet (ink-faint, the word muted) unless the outcome was bad.
 * Unknown: hollow and dashed, in ink-faint. A summons paints the WORD in the
 * hue as well, so "needs you" reads from across the room; everything else
 * keeps the page calm.
 *
 * What a word MEANS is one hover, focus or tap away (#365): the kit's
 * `TapTip` says the word, any fact beside it, what it means here, what comes
 * next — the view's `meaning` and `next`, from the model — and links to the
 * reference. A caller's `title` is a sentence about THIS instance, so it joins
 * the tooltip rather than standing as a native title, which a phone and a
 * keyboard never show. The tooltip's content is built only while it is open,
 * and while open it is the mark's accessible description.
 *
 * Standing alone the mark is a tap target, so it is POSITIONED (`relative`):
 * a positioned box paints — and hit-tests — above its neighbours' in-flow
 * boxes, so a pick box's thumb-floor overlay beside it, or the next line of the
 * paragraph it sits in, never takes its corner from the thumb (#393). It moves
 * nothing: `relative` with no offset is a layout no-op.
 */

/**
 * The reference card each vocabulary's table sits on, where it has one; the
 * rest open on the eight states, which say what every paint means.
 */
const REFERENCE_CARD: Readonly<Record<string, string>> = {
  run: 'run-status',
  phase: 'phase-record',
  board: 'board-state',
  plan: 'plan-status',
};

/** The tooltip's body: built only while open, so a page of statuses pays nothing for it. */
function StatusTipBody({ view, context }: { view: StatusView; context?: string }) {
  const route = useRoute();
  return (
    <div data-status-tip className="flex max-w-72 flex-col gap-1 py-0.5 whitespace-normal">
      <div className="font-medium">{viewHeadline(view)}</div>
      {context && <div>{context}</div>}
      <div data-tip="meaning">{view.meaning}</div>
      <div data-tip="next" className="text-ink-muted">
        {view.next}
      </div>
      <a
        href={helpHref('reference', REFERENCE_CARD[view.vocab] ?? 'the-eight-states', route)}
        className="text-action underline-offset-2 hover:underline"
      >
        More in Help
      </a>
    </div>
  );
}

/** A view's fact, as the family draws it: its own icon, its own paint. */
export function FactPart({ fact, size = 'sm' }: { fact: StatusFact; size?: 'sm' | 'md' }) {
  const meta = FACT_META[fact.kind];
  const Icon = statusIcon(meta.icon);
  return (
    <span
      data-fact={fact.kind}
      className={cn('inline-flex items-center gap-1 text-state', `state-${fact.paint ?? meta.paint}`)}
    >
      <Icon size={size === 'md' ? 12 : 10} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {fact.text}
    </span>
  );
}

export function DotWord({
  view,
  size = 'sm',
  live = false,
  withNote = true,
  chrome = 'dot',
  className,
  title,
  ...props
}: { view: StatusView } & Chrome) {
  const note = withNote ? view.note : undefined;
  const quiet = isQuiet(view);
  const pulses = live && view.tense === 'live' && view.paint === 'running';
  const summons = view.attention !== 'none';
  if (chrome === 'badge' || chrome === 'tint') {
    const Icon = statusIcon(view.icon);
    const tint = chrome === 'tint' && view.known;
    return (
      <TapTip content={() => <StatusTipBody view={view} context={title} />}>
        <span
          data-status={view.word ?? ''}
          data-paint={view.paint}
          data-attention={view.attention}
          data-vocab={view.vocab}
          data-tense={view.tense}
          data-known={view.known ? undefined : 'false'}
          data-quiet={quiet ? '' : undefined}
          data-chrome={chrome}
          className={cn(
            // An OUTLINED pill: the hue paints the border, the icon and the
            // word (design.md §1 rule 4). The LEAD badge alone sits on its
            // state's tint, the word still in the state's own AA hue (§3.2).
            'relative inline-flex items-center gap-1 rounded-full border px-2 py-px whitespace-nowrap tabular-nums',
            size === 'md' ? 'text-body' : 'text-meta',
            !view.known
              ? 'border-dashed border-ink-faint text-ink-muted'
              : tint
                ? 'border-state/40 bg-state-tint font-medium text-state'
                : quiet
                  ? 'border-state/30 text-state'
                  : 'border-state/60 text-state',
            `state-${view.paint}`,
            className,
          )}
          {...props}
        >
          <Icon
            aria-hidden
            data-icon
            size={size === 'md' ? 13 : 12}
            strokeWidth={2.25}
            className={cn('shrink-0', tint && 'text-state-vivid', pulses && 'animate-pulse-soft')}
          />
          <span>{view.label}</span>
          {note && (
            <>
              <span className="sr-only">, </span>
              <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-current opacity-35" />
              <FactPart fact={note} size={size} />
            </>
          )}
        </span>
      </TapTip>
    );
  }
  return (
    <TapTip content={() => <StatusTipBody view={view} context={title} />}>
      <span
        data-status={view.word ?? ''}
        data-paint={view.paint}
        data-attention={view.attention}
        data-vocab={view.vocab}
        data-tense={view.tense}
        data-known={view.known ? undefined : 'false'}
        data-quiet={quiet ? '' : undefined}
        className={cn(
          'relative inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums',
          size === 'md' ? 'text-body' : 'text-meta',
          quiet ? 'text-ink-muted' : summons ? 'text-state' : 'text-ink',
          `state-${view.paint}`,
          className,
        )}
        {...props}
      >
        <i
          aria-hidden
          data-dot
          className={cn(
            'inline-block size-1.5 shrink-0 rounded-full',
            !view.known
              ? 'border border-dashed border-ink-faint bg-transparent'
              : quiet
                ? 'border border-ink-faint bg-transparent'
                : view.tense === 'settled'
                  ? 'border border-state bg-transparent'
                  : 'bg-state',
            pulses && 'animate-pulse-soft',
          )}
        />
        <span>{view.label}</span>
        {note && (
          <>
            {/* A divider, not a middle dot: the fact is a second datum, and a
              screen reader hears the comma the eye sees as a rule. */}
            <span className="sr-only">, </span>
            <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-current opacity-35" />
            <FactPart fact={note} size={size} />
          </>
        )}
      </span>
    </TapTip>
  );
}
