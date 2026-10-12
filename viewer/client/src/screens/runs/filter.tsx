/**
 * The lamps — one per halt family, as the home's Filter (7.0, quiet-console
 * phase 7; the Tower's annunciator since control-tower phase 20).
 *
 * A cockpit's annunciator is a row of labelled lamps that say which system has
 * a fault before anybody reads a message. Here the systems are the halt
 * families (`HALT_CATEGORIES`): each lamp counts the stops the home draws in
 * that family — exactly the halt card's own `haltView` category, never a
 * second reading — and pressing one narrows the groups to that family. A lamp
 * with nothing behind it is dim and cannot be pressed: there is nothing to
 * narrow to. In 7.0 the lamps are the Filter slot's panel: the glance is the
 * groups, and the families are one press away under the one word every list
 * uses for narrowing.
 *
 * No hue: a lit lamp is ink, a pressed one ink-solid. Amber is a summons and
 * nothing else, and a family is not a summons — the rows it narrows to say
 * which of them wants a person.
 */

import { HALT_CATEGORIES, HALT_CATEGORY_LABELS, type HaltCategory } from '@shared/halt-categories.js';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { Button } from '@/ui';

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

export interface LampsProps {
  lamps: Record<HaltCategory, number>;
  /** The family the groups are narrowed to, or null. */
  pressed: HaltCategory | null;
  onPress: (category: HaltCategory | null) => void;
}

export function Lamps({ lamps, pressed, onPress }: LampsProps) {
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
          <Button
            key={category}
            size="sm"
            variant="ghost"
            data-testid="lamp"
            data-category={category}
            data-lit={lit ? 'true' : 'false'}
            aria-pressed={on}
            disabled={!lit && !on}
            onClick={() => onPress(on ? null : category)}
            title={
              lit
                ? `${HALT_CATEGORY_LABELS[category]}: ${plural(count, 'stop')}${on ? ' — press to show every group' : ' — press to show only these'}`
                : `${HALT_CATEGORY_LABELS[category]}: nothing stopped for this`
            }
            className={cn(
              'gap-1.5 border',
              on
                ? 'border-ink bg-ink text-ground hover:bg-ink hover:text-ground'
                : lit
                  ? 'border-rule-strong text-ink'
                  : 'border-dashed border-rule text-ink-faint',
            )}
          >
            <span>{LAMP_LABELS[category]}</span>
            {/* The count is the LAST span: a test reads it there. */}
            <span className="tnum">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}
