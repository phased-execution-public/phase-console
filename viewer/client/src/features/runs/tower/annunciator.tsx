/**
 * The annunciator — one lamp per halt family (control-tower phase 20,
 * §Architecture 4 and 5; exit criterion 2).
 *
 * A cockpit's annunciator panel is a row of labelled lamps that say which
 * system has a fault before anybody reads a message. Here the systems are the
 * halt families (`HALT_CATEGORIES`, phase 17): each lamp counts the stops the
 * Tower draws in that family — exactly the halt card's own `haltView`
 * category, never a second reading — and pressing it narrows the bays to that
 * family. A lamp with nothing behind it is dim and cannot be pressed: there is
 * nothing to narrow to.
 *
 * No hue: a lit lamp is ink, a pressed one ink-solid. Amber is a summons and
 * nothing else, and a family is not a summons — the strips it filters to say
 * which of them wants a person.
 */

import { HALT_CATEGORIES, HALT_CATEGORY_LABELS, type HaltCategory } from '@shared/halt-categories.js';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

/** A lamp's own word — short enough that nine of them wrap in two rows on a phone. */
export const LAMP_LABELS: Record<HaltCategory, string> = {
  decision: 'Decision',
  credentials: 'Accounts',
  limits: 'Limits',
  environment: 'Environment',
  plan: 'Plan',
  verification: 'Verification',
  external: 'External',
  conflict: 'Conflicts',
  operator: 'By you',
};

export interface AnnunciatorProps {
  lamps: Record<HaltCategory, number>;
  /** The family the bays are narrowed to, or null. */
  pressed: HaltCategory | null;
  onPress: (category: HaltCategory | null) => void;
}

export function Annunciator({ lamps, pressed, onPress }: AnnunciatorProps) {
  return (
    <div
      role="group"
      aria-label="Stops by family"
      data-testid="annunciator"
      className="flex min-w-0 flex-wrap gap-1.5"
    >
      {HALT_CATEGORIES.map((category) => {
        const count = lamps[category];
        const lit = count > 0;
        const on = pressed === category;
        return (
          <button
            key={category}
            type="button"
            data-testid="lamp"
            data-category={category}
            data-lit={lit ? 'true' : 'false'}
            aria-pressed={on}
            disabled={!lit && !on}
            onClick={() => onPress(on ? null : category)}
            title={
              lit
                ? `${HALT_CATEGORY_LABELS[category]}: ${plural(count, 'stop')}${on ? ' — press to show every bay' : ' — press to show only these'}`
                : `${HALT_CATEGORY_LABELS[category]}: nothing stopped for this`
            }
            className={cn(
              'inline-flex min-h-7 items-baseline gap-1.5 rounded border px-2 py-1 text-2xs transition-colors duration-fast [@media(hover:none)]:min-h-(--tap-min)',
              on
                ? 'border-ink bg-ink text-surface'
                : lit
                  ? 'border-rule-strong bg-surface text-ink hover:bg-surface-raised'
                  : // Dim on a desk; on a phone a dark lamp gives up its row,
                    // because there it costs a thumb's height of the page.
                    'border-dashed border-rule text-ink-faint opacity-60 max-sm:hidden',
            )}
          >
            <span>{LAMP_LABELS[category]}</span>
            <span className={cn('tabular-nums', lit && 'font-display text-sm leading-none')}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
