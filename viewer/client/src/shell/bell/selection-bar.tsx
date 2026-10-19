/**
 * The bar that appears when something is selected (7.0 in quiet-console
 * phase 5) — the bell's bulk verbs, and any list's that picks rows.
 *
 * ## Why a bar and not a menu
 *
 * Every serious triage surface settled on the same shape — a contextual strip
 * that arrives with the first selection, states the count, and offers the
 * verbs. The operator already knows it from every mail client; a novel
 * selection idiom in a console is a thing to learn, not a thing to like.
 *
 * ## What is deliberate here
 *
 * **It is ink, never amber.** Amber is the console's one summons. A bar that
 * appears because you ticked a box has not become urgent; its first shared
 * verb is the one solid button.
 *
 * **It offers only what every selected item can do.** A bulk button that works
 * on nine of twelve is worse than a missing one: it reports success while
 * three asks stay open. `sharedVerbs` takes the intersection.
 *
 * **On a page it is sticky, never fixed** — a fixed bar is positioned against
 * the visual viewport and drifts under iOS's URL chrome — and on a phone it
 * registers its height so toasts stack above it.
 *
 * ## Two placements, one bar
 *
 * On a page the bar rides IN the scroller, sticky at its foot, and arrives
 * with the first tick. In the bell it is `dock`ed: a footer outside the list,
 * present whenever there are rows at all — the bell is where an operator lands
 * from a push at 2am, and a bar that exists only once you have ticked
 * something is a bar nobody discovers.
 */

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { usePhone } from '@/lib/media';
import { useBottomBar } from '@/lib/viewport';
import { cn } from '@/lib/cn';
import { Button, Kbd } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import type { SelectionState } from './selection';

export interface SelectionBarProps {
  count: number;
  state: SelectionState;
  onToggleAll: () => void;
  onClear: () => void;
  /** The verbs every selected item offers, already intersected. */
  verbs: { verb: string; label: string }[];
  onVerb: (verb: string) => void;
  onAcknowledge: () => void;
  /**
   * The word on the button `onAcknowledge` answers — the caller's, because only
   * the caller knows what its press does (#334: a bar that said *Put back* over
   * a press that deleted). "Acknowledge" by default; *Put back* only where the
   * press really puts something back.
   */
  acknowledgeLabel?: string;
  busy?: boolean;
  /** What the count is OF, already agreeing with it: "selected", "unread". */
  noun?: string;
  /**
   * A permanent footer outside a scroller rather than a sticky row inside one.
   * The two halves travel together: a docked bar that vanished at zero would
   * make the list jump, and a sticky bar that never hid would cover its rows.
   */
  dock?: boolean;
  /**
   * The verbs that act on the WHOLE list — "Acknowledge all", "Mark all read" —
   * drawn only while nothing is picked, and only when docked. "These two" and
   * "all hundred and eight" are alternatives, never a choice made in the same
   * glance: side by side they are one mis-click apart.
   */
  children?: ReactNode;
  className?: string;
}

/** The list's keys, each a key and its word — said only where a list answers them. */
const KEYS: readonly [ReactNode, string][] = [
  [<Kbd key="x">x</Kbd>, 'pick'],
  [
    <span key="shift" className="inline-flex items-center gap-0.5">
      <Kbd>shift</Kbd>+<Kbd>j</Kbd>/<Kbd>k</Kbd>
    </span>,
    'extend',
  ],
  [<Kbd key="a">a</Kbd>, 'all'],
  [<Kbd key="esc">esc</Kbd>, 'clear'],
];

export function SelectionBar({
  count,
  state,
  onToggleAll,
  onClear,
  verbs,
  onVerb,
  onAcknowledge,
  acknowledgeLabel = 'Acknowledge',
  busy = false,
  noun = 'selected',
  dock = false,
  children,
  className,
}: SelectionBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  // Only a phone's bar sits at the bottom of the SHELL. A docked bar is the
  // foot of a sheet that floats over the shell, and registering it would
  // offset every toast by a bar the shell does not have.
  useBottomBar(bar, !dock && phone && count > 0);

  if (count === 0 && !dock) return null;
  const picked = count > 0;

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={picked ? `${count} ${noun}` : 'Bulk actions'}
      data-testid="selection-bar"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 bg-surface-raised px-3 py-2',
        dock
          ? // A footer in the sheet's column: nothing to stick to, nothing to
            // lift above. It draws only the edge it shares.
            'shrink-0 border-t border-rule'
          : // Sticky at the foot of the shell's one scroller, at every width; a
            // tone, never a shadow — nothing in the page casts one.
            'sticky bottom-2 z-(--z-sticky) animate-rise rounded-lg border border-rule-strong',
        !dock && phone && 'bottom-0',
        className,
      )}
    >
      <Checkbox
        checked={state === 'all' ? true : state === 'some' ? 'indeterminate' : false}
        onCheckedChange={onToggleAll}
        aria-label={state === 'all' ? 'Clear the selection' : 'Select everything shown'}
      />
      {/* "2 selected" — the words every inbox uses, and the count said once. */}
      <span className="text-meta text-ink-muted tabular-nums">
        {picked ? `${count} ${noun}` : 'Nothing picked'}
      </span>

      <span className="ms-auto flex min-w-0 flex-wrap items-center gap-1.5">
        {picked ? (
          <>
            {verbs.map((action, i) => (
              <Button
                key={action.verb}
                size="sm"
                variant={i === 0 ? 'primary' : 'default'}
                disabled={busy}
                onClick={() => onVerb(action.verb)}
              >
                {action.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onAcknowledge}>
              {acknowledgeLabel}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
              Clear
            </Button>
          </>
        ) : (
          children
        )}
      </span>

      {/* The keys belong to the LIST, and only a list with the triage handler
          has them: the bell draws its rows without one, so a legend there
          would advertise a keyboard that does nothing. */}
      {picked && !phone && !dock && (
        <span className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted">
          {KEYS.map(([key, word]) => (
            <span key={word} className="inline-flex items-center gap-1">
              {key} {word}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
