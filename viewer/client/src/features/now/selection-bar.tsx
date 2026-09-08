/**
 * The bar that appears when something is selected.
 *
 * ## Why a bar and not a menu
 *
 * Every serious triage surface settled on the same shape — a contextual strip
 * that arrives with the first selection, states the count, and offers the
 * verbs. It is worth following rather than reinventing: the operator already
 * knows it from every mail client they have ever used, and a novel selection
 * idiom in a console is a thing to learn, not a thing to like.
 *
 * ## What is deliberate here
 *
 * **It is not amber.** Amber is the console's one alarm colour and it means
 * "this needs you". A bar that appears because you ticked a box has not become
 * urgent. The one amber thing is the primary verb, once, if there is one.
 *
 * **It offers only what every selected item can do.** A bulk button that works
 * on nine of twelve is worse than a missing one: it reports success while
 * three asks stay open. `sharedVerbs` takes the intersection.
 *
 * **It is a grid row on a phone, not `position: fixed`.** The tab bar learned
 * that already — a fixed bar is positioned against the visual viewport, and on
 * iOS the URL chrome grows and shrinks as you scroll, so a fixed bar drifts
 * under it. On a page it registers its height so toasts stack above it.
 *
 * ## Two placements, one bar
 *
 * On a page the bar rides IN the scroller, sticky at its foot, and appears with
 * the first tick. In the bell drawer it is `dock`ed: a flex footer outside the
 * list, present whenever there are rows at all. The drawer is where an operator
 * lands from a push at 2am, and a bar that only exists once you have already
 * ticked something is a bar nobody discovers — which is exactly what happened,
 * with the reported symptom "the drawer has no bulk actions".
 */

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Button, Checkbox, Kbd } from '@/components/ui';
import { useBottomBar } from '@/lib/viewport';
import { usePhone } from '@/lib/media';
import { cn } from '@/lib/cn';
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
  /** All of them are already acknowledged, so the button says the other thing. */
  allAcked?: boolean;
  busy?: boolean;
  /** What the count is OF, already agreeing with it: "selected", "unread". */
  noun?: string;
  /**
   * A permanent footer outside a scroller rather than a sticky row inside one.
   *
   * The two halves travel together and that is why this is one flag: a docked
   * bar that vanished at zero would make the list jump every time a selection
   * emptied, and a sticky bar that never hid would cover the rows it is about.
   */
  dock?: boolean;
  /**
   * The verbs that act on the WHOLE list — "Acknowledge all", "Mark all read".
   *
   * Rendered only while nothing is picked, and only when `dock`ed. "These two"
   * and "all hundred and eight" are alternatives, never a choice to be made in
   * the same glance: side by side they are one mis-click apart, and only one of
   * them can be undone by looking at what you ticked.
   */
  children?: ReactNode;
  className?: string;
}

export function SelectionBar({
  count,
  state,
  onToggleAll,
  onClear,
  verbs,
  onVerb,
  onAcknowledge,
  allAcked = false,
  busy = false,
  noun = 'selected',
  dock = false,
  children,
  className,
}: SelectionBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  // Only a phone's bar sits at the bottom of the SHELL; on a desktop it rides
  // above the list and nothing needs to stack out of its way. A docked bar is
  // not one either — it is the foot of a sheet that floats over the shell, and
  // registering it would offset every toast by a bar the shell does not have.
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
        'flex flex-wrap items-center gap-2 border-rule bg-surface-raised px-3 py-2',
        dock
          ? // A footer in the flex column: the sheet's body is the one scroller
            // and this sits below it, so there is nothing to stick to and
            // nothing to lift above. It draws only the edge it shares.
            'shrink-0 border-t'
          : [
              'animate-rise rounded-lg border shadow-card',
              /*
               * Sticky at the bottom of the shell's scroller, at every width.
               *
               * The first version sat in flow under the list, which on a
               * hundred-and-eight-row inbox meant ticking three boxes and then
               * scrolling past a hundred rows to find the button — the
               * selection was in one place and the verb for it in another. It
               * is `sticky`, never `fixed`: the tab bar learned that a fixed
               * bar drifts under iOS's URL chrome.
               *
               * `--z-sticky` is the phone top bar's layer, and that is the
               * right one: the bar has to cover the rows sliding under it and
               * nothing else on the page ever shares its edge.
               */
              'sticky bottom-2 z-(--z-sticky)',
              // No `pb-safe` here. Whatever is under this bar already carries
              // the home-indicator inset — the tab bar on Now, the sheet in the
              // drawer — and a second copy is a gap the operator reads as a
              // rendering fault.
              phone && 'bottom-0',
            ],
        className,
      )}
    >
      <Checkbox
        checked={state === 'all' ? true : state === 'some' ? 'indeterminate' : false}
        onCheckedChange={onToggleAll}
        aria-label={state === 'all' ? 'Clear the selection' : 'Select everything shown'}
      />
      {/* "2 selected" — the words every inbox uses, and the count said once. */}
      <span className="font-mono text-2xs tabular-nums text-ink-muted">
        {picked ? `${count} ${noun}` : 'Nothing picked'}
      </span>

      <span className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
        {picked ? (
          <>
            {verbs.map((action, i) => (
              <Button
                key={action.verb}
                size="sm"
                // The one amber: the first shared remedy, and only the first.
                variant={i === 0 ? 'action' : 'default'}
                disabled={busy}
                onClick={() => onVerb(action.verb)}
              >
                {action.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onAcknowledge}>
              {allAcked ? 'Put back' : 'Acknowledge'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
              Clear
            </Button>
          </>
        ) : (
          children
        )}
      </span>

      {/* The keys belong to the LIST, and only Now's list has them: the drawer
          renders the same rows without the triage handler, so printing the
          legend there would be advertising a keyboard that does nothing. */}
      {picked && !phone && !dock && (
        <span className="flex w-full items-center gap-1 text-2xs text-ink-faint">
          <Kbd>x</Kbd> pick · <Kbd>shift</Kbd>+<Kbd>j</Kbd>/<Kbd>k</Kbd> extend · <Kbd>a</Kbd> all ·{' '}
          <Kbd>esc</Kbd> clear
        </span>
      )}
    </div>
  );
}
