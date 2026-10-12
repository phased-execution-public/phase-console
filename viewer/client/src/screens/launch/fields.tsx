/**
 * The field primitives every mode of the launch form is made of — and the one
 * thing they all do: say where the value came from.
 *
 * ## "from defaults" vs "changed here"
 *
 * A launch seeded from Settings ▸ Automation looks exactly like a launch
 * somebody typed into. That is how a run ends up on a model nobody chose: the
 * operator reads a value, assumes it is theirs, and it is the preference — or
 * assumes it is the preference, and it is a leftover from the run's own
 * record. `Provenance` is one quiet word beside a control saying which answer
 * is true here, and it costs one comparison.
 *
 * The words are deliberate and exhaustive (`PROVENANCE_WORDS`, `model/seed.ts`):
 * - **from defaults** — this console's own shipped fallback.
 * - **from Settings** — a preference the operator set in Settings ▸ Automation.
 *   A value that differs from what the console ships with because somebody set
 *   it is a different fact from one nobody has touched, and the review lists
 *   the first and not the second.
 * - **from this run** — the run's stored record, which outranks a preference.
 * - **from the plan** — the plan's own bullet (a phase's model, its skills).
 * - **from your last launch** — what this browser launched this plan with last
 *   time (`model/memory.ts`); outranks a preference, never a run.
 * - **from preset** — a posture the operator picked in the quick view's preset
 *   row (`model/presets.ts`): chosen, but not typed.
 * - **changed here** — the operator touched it; this launch differs. The one
 *   word drawn in ink, because it is the only one that is this launch's news.
 */

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { SETTING_EFFECT_LABELS } from '@shared/run-settings.js';
import { cn } from '@/lib/cn';
import { Button, Input, Label } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { NativeSelect } from '@/ui/native-select';
import { PROVENANCE_WORDS, type Source } from './model/seed';
import type { FieldEffect, PressFieldProps, ToggleFieldProps } from './form-context';

// The words belong to the launch model; the sections reach them through the
// controls that draw them.
export { sourceOf, type Source } from './model/seed';
export type { FieldEffect } from './form-context';

export function Provenance({ source }: { source?: Source }) {
  if (!source) return null;
  return (
    <span
      className={cn('text-meta', source === 'changed' ? 'font-medium text-ink' : 'text-ink-muted')}
      data-source={source}
    >
      {PROVENANCE_WORDS[source]}
    </span>
  );
}

/** The effect line beside a control — `SETTING_EFFECT_LABELS`' words, never a sentence of its own. */
export function EffectNote({ effect }: { effect?: FieldEffect | undefined }) {
  if (!effect) return null;
  return (
    <span
      className={cn('text-meta', effect.refused ? 'text-ink' : 'text-ink-muted')}
      data-effect={effect.word}
      {...(effect.refused ? { 'data-refused': '' } : {})}
    >
      {effect.refused ?? SETTING_EFFECT_LABELS[effect.word]}
    </span>
  );
}

/**
 * Where the value came from and when a change lands — each its own word, set a
 * gap apart by the flex row that holds them. The space between them is for the
 * words read as text (an accessible description, a copied line); a flex row
 * never draws a space that sits alone between two of its items.
 */
function Notes({ source, effect }: { source?: Source | undefined; effect?: FieldEffect | undefined }) {
  return (
    <>
      <Provenance source={source} />
      {source && effect ? ' ' : null}
      <EffectNote effect={effect} />
    </>
  );
}

/** The ids a labelled control is wired by: its own, and the two lines that describe it. */
type FieldIds = { id: string; describedBy?: string; invalid: boolean };

/** The control: one element (its `id` and `aria-*` are filled in), or a render prop given the ids. */
type FieldControl = ReactElement | ((ids: FieldIds) => ReactNode);

/**
 * A labelled control with its provenance.
 *
 * The label names the control and is its accessible NAME; the hint, the
 * provenance and the effect are one meta line under it and its DESCRIPTION
 * (`aria-describedby`), so "Branch from defaults" is never the name of a select
 * and `getByLabelText('Branch')` still finds it. An error replaces that line,
 * in the failed hue, announced, and marks the control invalid. `inline` puts
 * the control beside the label rather than under it.
 */
export function SetupField({
  label,
  hint,
  source,
  effect,
  error,
  inline,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  error?: ReactNode;
  inline?: boolean;
  children: FieldControl;
  className?: string;
}) {
  const id = `field-${useId()}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const notes = Boolean(source || effect);
  const invalid = error != null;
  // The line under the label is shown only while there is no error, and the
  // control is described only by the lines that are on screen.
  const described = (hint != null || notes) && !invalid;
  const describedBy =
    [described ? hintId : null, invalid ? errorId : null].filter(Boolean).join(' ') || undefined;
  const control =
    typeof children === 'function'
      ? children({ id, describedBy, invalid })
      : isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            id,
            'aria-describedby': describedBy,
            'aria-invalid': invalid || undefined,
          })
        : children;
  return (
    <div
      className={cn(
        'grid min-w-0 gap-1',
        inline && 'grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3',
        className,
      )}
    >
      <Label htmlFor={id} className={cn(inline && 'row-start-1')}>
        {label}
      </Label>
      <div className={cn('min-w-0', inline && 'col-start-2 row-start-1')}>{control}</div>
      {described && (
        // The hint, then where the value came from on a line of its own: side
        // by side, a wide sheet set the provenance beside the paragraph, and a
        // field with no hint set it under the control — two places for one fact.
        <p
          id={hintId}
          className={cn('grid min-w-0 gap-0.5 text-meta text-ink-muted', inline && 'col-span-2')}
        >
          {hint != null && <span className="min-w-0 max-w-(--measure)">{hint}</span>}
          {hint != null && notes ? ' ' : null}
          {notes && (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
              <Notes source={source} effect={effect} />
            </span>
          )}
        </p>
      )}
      {invalid && (
        <p id={errorId} role="alert" className={cn('text-meta text-failed', inline && 'col-span-2')}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A select over `[value, label]` pairs — the shape every vocabulary has. */
export function SelectField({
  label,
  hint,
  source,
  effect,
  value,
  options,
  disabled,
  onChange,
  placeholder,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  value: string;
  /** `[value, label]`; a `''` entry is offered by the caller, never invented here. */
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
  onChange: (next: string) => void;
  /** The label for a `''` option the caller wants prepended. */
  placeholder?: string;
}) {
  return (
    <SetupField label={label} hint={hint} source={source} effect={effect}>
      {({ id, describedBy }) => (
        <NativeSelect
          id={id}
          aria-describedby={describedBy}
          // Full width is load-bearing, not cosmetic: a select sizes to its
          // WIDEST option, and "Create a work branch per run (pe/<a long
          // slug>)" once made the control wider than a 390px phone, so the
          // whole page scrolled sideways. The column is `min-w-0`, so full
          // width is bounded by it — and the options here are sentences read
          // whole, so the kit's narrower cap is lifted.
          className="w-full max-w-full"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder != null && <option value="">{placeholder}</option>}
          {options.map(([id_, text]) => (
            <option key={id_} value={id_}>
              {text}
            </option>
          ))}
        </NativeSelect>
      )}
    </SetupField>
  );
}

/**
 * A number that may be blank.
 *
 * `type=number` with a STRING value on purpose: the empty string is a real
 * answer on every one of these ("no ceiling", "this console's default"), and
 * coercing here would turn it into `0`, which means the opposite.
 */
export function NumberField({
  label,
  hint,
  source,
  effect,
  error,
  value,
  min,
  step,
  placeholder = 'none',
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  error?: ReactNode;
  value: string;
  min?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <SetupField label={label} hint={hint} source={source} effect={effect} error={error}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          min={min}
          step={step}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </SetupField>
  );
}

/**
 * A boolean's name, and beside it where its value came from and when a change
 * lands — each its own word, never part of the name.
 */
function BoolName({
  label,
  source,
  effect,
}: {
  label: ReactNode;
  source?: Source | undefined;
  effect?: FieldEffect | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
      <span className="min-w-0 text-ink">{label}</span>
      {source || effect ? ' ' : null}
      <Notes source={source} effect={effect} />
    </span>
  );
}

/**
 * A boolean, as a checkbox.
 *
 * Deliberately NOT a switch, and the reason is a test: the QA dialog's test
 * (`screens/plan/phases/qa-launcher.test.tsx`) asks for `getByRole('checkbox')`
 * with no name, which throws on a second one — that bare query is what holds
 * "the QA activation checkbox is the only checkbox in that dialog" true. A
 * switch has `role="switch"`, so drawing these as one would not fail that
 * assertion, it would make it vacuous, and a gate that cannot fail is worse
 * than no gate.
 *
 * `disabledReason` rather than a bare `disabled`: a capability that exists and
 * is unavailable has to name the flag that turns it on — the same contract the
 * QA and recovery buttons keep. A control that simply greys out teaches
 * nothing.
 *
 * The row is `tap-row`: a checkbox row in a STACK of checkbox rows takes the
 * thumb floor as its box, because the checkbox's own hit area would reach into
 * the rows above and below it (design.md §6).
 */
export function ToggleField({
  label,
  hint,
  source,
  effect,
  value,
  disabledReason,
  disabled,
  onChange,
}: ToggleFieldProps) {
  const off = Boolean(disabledReason) || disabled;
  // The HINT wins over the reason when both are given: `disabledReason` is the
  // terse thing the hover needs ("restart with --allow-writes"), and the hint
  // is the paragraph that says what is still true anyway. Collapsing them
  // loses the second, which is the useful half.
  const note = hint ?? disabledReason;
  return (
    <label className="tap-row flex min-w-0 items-start gap-2.5 text-body">
      {/* The kit's checkbox draws a 16px box and carries the thumb floor as a
          hit area, so it is hittable with a finger without growing in a dense
          form. */}
      <Checkbox
        className="mt-0.5"
        checked={value && !disabledReason}
        disabled={off}
        title={disabledReason}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <BoolName label={label} source={source} effect={effect} />
        {note != null && (
          <span className="max-w-(--measure) break-words text-meta text-ink-muted">{note}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A boolean drawn as a pressed button — the "Attach default skills" shape.
 *
 * Its own component for the same reason as above, stated the other way round:
 * this one must NOT be a checkbox, or the QA dialog gains a second one and the
 * bare `getByRole('checkbox')` pin starts throwing.
 */
export function PressField({
  label,
  hint,
  source,
  effect,
  value,
  disabled,
  on = 'On',
  off = 'Off',
  onChange,
}: PressFieldProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 text-body">
      <span className="flex min-w-0 flex-col gap-0.5">
        <BoolName label={label} source={source} effect={effect} />
        {hint != null && (
          <span className="max-w-(--measure) break-words text-meta text-ink-muted">{hint}</span>
        )}
      </span>
      <Button size="sm" aria-pressed={value} disabled={disabled} onClick={() => onChange(!value)}>
        {value ? on : off}
      </Button>
    </div>
  );
}
