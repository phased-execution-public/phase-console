/**
 * The field primitives every mode of RunSetup is made of — and the one thing
 * they all do that the old four forms did not: say where the value came from.
 *
 * ## "from defaults" vs "changed here"
 *
 * A launch dialog seeded from Settings ▸ Automation looks exactly like a launch
 * dialog somebody typed into. That is how a run ends up on a model nobody
 * chose: the operator reads a value, assumes it is theirs, and it is the
 * preference — or assumes it is the preference, and it is a leftover from the
 * run's own record. `Provenance` is one muted line under a control saying which
 * answer is true here, and it costs one comparison.
 *
 * The words are deliberate and exhaustive:
 * - **from defaults** — this console's own shipped fallback.
 * - **from Settings** — a preference the operator set in Settings ▸ Automation.
 *   Phase 8 split this out of "from defaults": a value that differs from what
 *   the console ships with because somebody set it is a different fact from one
 *   nobody has touched, and the review stage lists the first and not the second.
 * - **from this run** — the run's stored record, which outranks a preference.
 * - **from the plan** — the plan's own bullet (a phase's model, its skills).
 * - **from your last launch** — what this browser launched this plan with last
 *   time (`launch-memory.ts`); outranks a preference, never a run.
 * - **from preset** — a posture the operator picked in the quick view's preset
 *   row (`presets.ts`, control-tower phase 22): chosen, but not typed.
 * - **changed here** — the operator touched it; this launch differs.
 */

import type { ReactNode } from 'react';
import { SETTING_EFFECT_LABELS } from '@shared/run-settings.js';
import { Button, Checkbox, Field, Input, field as fieldClass } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Where a value came from, once the form and its seed are compared. */
export type Source = 'defaults' | 'prefs' | 'run' | 'plan' | 'last-launch' | 'preset' | 'changed';

export const SOURCE_WORDS: Readonly<Record<Source, string>> = Object.freeze({
  defaults: 'from defaults',
  prefs: 'from Settings',
  run: 'from this run',
  plan: 'from the plan',
  'last-launch': 'from your last launch',
  preset: 'from preset',
  changed: 'changed here',
});

export function Provenance({ source }: { source?: Source }) {
  if (!source) return null;
  return (
    <span
      className={cn('text-2xs', source === 'changed' ? 'text-action' : 'text-ink-muted')}
      data-source={source}
    >
      {SOURCE_WORDS[source]}
    </span>
  );
}

/**
 * When a change to this field lands on a LIVE run (control-tower phase 24,
 * #31): `SETTING_EFFECTS`' word for it — and, while a lane is working on a
 * field the door refuses under a live lane (`LIVE_LANE_LOCKED_FIELDS`), the
 * refusal in the sheet's own words, before the press rather than after it.
 */
export interface FieldEffect {
  word: keyof typeof SETTING_EFFECT_LABELS;
  refused?: string;
}

/** The effect line beside a control — `SETTING_EFFECT_LABELS`' words, never a sentence of its own. */
export function EffectNote({ effect }: { effect?: FieldEffect | undefined }) {
  if (!effect) return null;
  return (
    <span
      className={cn('text-2xs', effect.refused ? 'text-ink' : 'text-ink-muted')}
      data-effect={effect.word}
      {...(effect.refused ? { 'data-refused': '' } : {})}
    >
      {effect.refused ?? SETTING_EFFECT_LABELS[effect.word]}
    </span>
  );
}

/**
 * Which of the seven it is.
 *
 * `seed` is what the form opened on and `origin` is where THAT came from, so a
 * value equal to its seed reports the seed's origin and anything else reports
 * `changed`. Comparison is by JSON because half these values are arrays and
 * objects, and a reference check would call every render a change.
 */
export function sourceOf(value: unknown, seed: unknown, origin: Source): Source {
  return JSON.stringify(value) === JSON.stringify(seed) ? origin : 'changed';
}

/**
 * A labelled control with its provenance.
 *
 * Wraps the design system's `Field` (which owns the label/hint/error wiring and
 * the aria ids) rather than re-implementing it — this adds exactly one thing.
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
  children: Parameters<typeof Field>[0]['children'];
  className?: string;
}) {
  // Provenance rides in the HINT, not in the label. A label is the control's
  // accessible NAME — "Branch from defaults" is the wrong name for a select,
  // and it also breaks every `getByLabelText('Branch')` in the suite. As a
  // description it is exactly right: `aria-describedby`, read after the name,
  // and it is a description of where the value came from.
  // The effect rides beside it for the same reason: when a change lands is
  // a description of the control, never its name.
  const notes =
    source || effect ? (
      <>
        <Provenance source={source} />
        {source && effect ? ' · ' : null}
        <EffectNote effect={effect} />
      </>
    ) : null;
  const described =
    notes && hint != null ? (
      <>
        {hint} {notes}
      </>
    ) : (
      (notes ?? hint)
    );
  return (
    <Field label={label} hint={described} error={error} inline={inline} className={className}>
      {children}
    </Field>
  );
}

/** A `<select>` over `[value, label]` pairs — the shape every vocabulary has. */
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
        <select
          id={id}
          aria-describedby={describedBy}
          // `w-full` is load-bearing, not cosmetic: a bare <select> sizes to
          // its WIDEST option, so "Create a work branch per run
          // (pe/console-frontend-redesign)" made the control 423px inside a
          // 390px phone and the whole page scrolled sideways. The parent is
          // `min-w-0`, so full-width here is bounded by the column.
          className={cn(fieldClass, 'w-full')}
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
        </select>
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
 * A boolean, as the checkbox this console has always used.
 *
 * Deliberately NOT the design system's `Switch`, and the reason is a test:
 * `qa-launcher.test.tsx` asks for `getByRole('checkbox')` with no name, which
 * throws on a second one — that bare query is what holds "the QA activation
 * checkbox is the only checkbox in that dialog" true. A Radix Switch has
 * `role="switch"`, so moving these would not fail that assertion, it would make
 * it vacuous, and a gate that cannot fail is worse than no gate.
 *
 * `disabledReason` rather than a bare `disabled`: a capability that exists and
 * is unavailable has to name the flag that turns it on — the same contract
 * `QaButton` and `RecoveryActions` keep. A control that simply greys out
 * teaches nothing.
 *
 * The row is `tap-row` since Phase 8: a checkbox row in a STACK of checkbox
 * rows takes the floor as its box, because the checkbox's own overlay floor
 * would reach into the row above and below it (`docs/design.md` §6.1).
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
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  value: boolean;
  disabledReason?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const off = Boolean(disabledReason) || disabled;
  return (
    <label className="tap-row flex flex-wrap items-start gap-2 text-sm">
      {/* The primitive, not a bare input: it draws the same 16px box and
          carries the thumb floor as a transparent inset, so the control is
          hittable with a finger without growing in a dense form. */}
      <Checkbox
        className="mt-1"
        checked={value && !disabledReason}
        disabled={off}
        title={disabledReason}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="min-w-0 flex-1">
        {label} <Provenance source={source} /> <EffectNote effect={effect} />
        {/* The HINT wins over the reason when both are given: `disabledReason`
            is the terse thing the tooltip needs ("restart with --allow-writes"),
            and the hint is the paragraph that says what is still true anyway.
            Collapsing them loses the second, which is the useful half. */}
        {(hint ?? disabledReason) != null && (
          <span className="block text-2xs text-ink-muted">{hint ?? disabledReason}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A boolean rendered as a pressed button — the "Attach default skills" shape.
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
}: {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  value: boolean;
  disabled?: boolean;
  on?: string;
  off?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0">
        <span className="text-ink">{label}</span> <Provenance source={source} />{' '}
        <EffectNote effect={effect} />
        {hint != null && <span className="mt-0.5 block text-2xs text-ink-muted">{hint}</span>}
      </span>
      <Button size="sm" aria-pressed={value} disabled={disabled} onClick={() => onChange(!value)}>
        {value ? on : off}
      </Button>
    </div>
  );
}
