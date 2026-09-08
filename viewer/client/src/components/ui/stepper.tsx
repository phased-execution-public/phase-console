import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A stepper — the stages of one flow, drawn as a track with a station per
 * stage (`docs/design.md` §7: a line and its stations is the console's own
 * grammar, and a flow somebody moves along is a line).
 *
 * Built on Radix Tabs rather than on a hand-rolled `<ol>` because a stepper
 * that can be entered at any stage IS a tab list: Radix owns the roving
 * tabindex, the arrow keys, `aria-selected` and the panel wiring
 * (`aria-controls`), which is exactly the part a hand-rolled stepper gets
 * wrong. The caller wraps it in the kit's `Tabs` and renders a `TabsContent`
 * per stage.
 *
 * Non-linear on purpose. A wizard that refuses to show stage three before
 * stage two is done is a form that hides what it is about to do; every stage
 * here is one tap away from every other, and the track only says where you
 * ARE and where you have BEEN (`visited`), which is information a reader can
 * use — not a sequence they must obey.
 *
 * Equal columns at every width — never a horizontal scroller. Four stage names
 * side by side overflow a 360px phone, so the phone reads the `short` label
 * and the desk the full one; a stage that scrolls out of the bar is a stage
 * the operator does not know exists.
 */
export interface Step {
  id: string;
  /** The stage's name, as the desk reads it. Sentence case, plain words. */
  label: string;
  /** What the phone reads instead, when the full name will not fit a quarter of 360px. */
  short?: string;
  /** One line under the name on the desk — "2 changed", "1 warning". Drawn only when given. */
  note?: ReactNode;
}

export function Stepper({
  steps,
  visited,
  label,
  onSelect,
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.List>, 'children'> & {
  steps: readonly Step[];
  /** Stages the operator has already been through — drawn as passed stations. */
  visited?: ReadonlySet<string>;
  /** The accessible name of the whole bar. */
  label: string;
  /**
   * A stage was pressed. Radix switches on mousedown (a mouse) and on focus
   * (arrow keys); this fires on CLICK as well, which is what a switch-access
   * device, a screen reader's activate command and a test dispatch — none of
   * them mouse down first. The caller's `Tabs` still owns the value.
   */
  onSelect?: (id: string) => void;
}) {
  const count = Math.max(steps.length, 1);
  return (
    <TabsPrimitive.List
      aria-label={label}
      className={cn('relative grid w-full min-w-0', className)}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      {...props}
    >
      {/* The track: one line under every station, from the first dot's
          centre to the last's. Each cell is 1/n of the bar and its dot sits at
          the cell's centre, so the line starts and ends half a cell in. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[calc(0.5rem+3px)] h-px bg-track"
        style={{ left: `${50 / count}%`, right: `${50 / count}%` }}
      />
      {steps.map((step) => (
        <TabsPrimitive.Trigger
          key={step.id}
          value={step.id}
          onClick={onSelect ? () => onSelect(step.id) : undefined}
          data-visited={visited?.has(step.id) ? '' : undefined}
          className={cn(
            'group relative flex min-w-0 flex-col items-center gap-1.5 rounded-sm px-1 pb-2 pt-1.5 text-center',
            'text-2xs text-ink-muted transition-colors duration-fast ease-transit',
            'hover:text-ink data-[state=active]:text-ink md:text-xs',
            '[@media(hover:none)]:min-h-(--tap-min)',
          )}
        >
          <span className="min-w-0 max-w-full leading-tight">
            {step.short ? (
              <>
                <span className="md:hidden">{step.short}</span>
                <span className="hidden md:inline">{step.label}</span>
              </>
            ) : (
              step.label
            )}
          </span>
          {step.note != null && (
            <span className="hidden min-w-0 max-w-full truncate text-2xs font-normal text-ink-muted md:block">
              {step.note}
            </span>
          )}
          {/* The station. Current: filled ink, a size up. Passed: filled,
              muted. Ahead: hollow. Painted with ink, never a status hue — a
              stage is not a state, and amber is for a person. */}
          <span
            aria-hidden
            className={cn(
              'relative z-(--z-base) mt-auto block size-[7px] rounded-full border bg-surface transition-colors duration-fast ease-transit',
              'border-rule-strong',
              'group-data-[visited]:border-ink-muted group-data-[visited]:bg-ink-muted',
              'group-data-[state=active]:size-[9px] group-data-[state=active]:border-ink group-data-[state=active]:bg-ink',
            )}
          />
        </TabsPrimitive.Trigger>
      ))}
    </TabsPrimitive.List>
  );
}
