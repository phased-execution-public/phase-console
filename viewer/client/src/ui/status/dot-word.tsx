import { FACT_META, type StatusFact, type StatusView } from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { statusIcon } from './status-icons';
import { isQuiet, viewTitle, type Chrome } from './view';

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
 */

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
  className,
  title,
  ...props
}: { view: StatusView } & Chrome) {
  const note = withNote ? view.note : undefined;
  const quiet = isQuiet(view);
  const pulses = live && view.tense === 'live' && view.paint === 'running';
  const summons = view.attention !== 'none';
  return (
    <span
      data-status={view.word ?? ''}
      data-paint={view.paint}
      data-attention={view.attention}
      data-vocab={view.vocab}
      data-tense={view.tense}
      data-known={view.known ? undefined : 'false'}
      data-quiet={quiet ? '' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums',
        size === 'md' ? 'text-body' : 'text-meta',
        quiet ? 'text-ink-muted' : summons ? 'text-state' : 'text-ink',
        `state-${view.paint}`,
        className,
      )}
      title={title ?? viewTitle(view)}
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
  );
}
