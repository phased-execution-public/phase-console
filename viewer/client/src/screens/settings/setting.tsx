/**
 * One setting, drawn the one way Settings draws a key (7.0, quiet-console
 * phase 21).
 *
 * ```
 * Repair attempts per phase                         [ 3      ]
 * Before a person is asked.
 * Set here   Reset
 * ```
 *
 * The name at the start, the control at the end, the hint under the name; on a
 * phone the control drops under the name at the row's full width. A boolean is
 * a checkbox BEFORE its name — the launch form's grammar (`screens/launch/
 * fields.tsx`), so the defaults Automation edits inline and the keys around
 * them read as one form.
 *
 * Where a value came from is the schema's answer (`GET /api/prefs/schema`,
 * `usePrefsSchema`): silent for a shipped default, a word for anything else,
 * and Reset beside a key set here — which takes it out of the file. A save
 * moves the word, so the word is how a save says it landed.
 *
 * Every control carries `data-pref` naming the key it writes, ONCE per row:
 * `automation-coverage.test.tsx` counts them, because two controls for one key
 * disagree the day their fallbacks do.
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  prefPatch,
  usePrefReset,
  usePrefsSchema,
  usePrefsWrite,
  type PrefSchemaRow,
  type PrefsSchemaAnswer,
} from '@/data/console';
import type { Pressed } from '@/data/press';
import { Button, Input, Label, SectionHeading, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { NativeSelect } from '@/ui/native-select';

/* ---------------- reading and writing one key ---------------- */

/** A failure in the words it came with, or the honest floor when it had none. */
export function failureWords(error: unknown): string {
  const said = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return said || 'The save failed and said nothing.';
}

/**
 * A failed read's own words as the clause that ends a sentence — `: <words>`,
 * its own full stop dropped so the sentence's is the only one — or nothing
 * when it said nothing.
 */
export function readFailureClause(error: unknown): string {
  const said = error instanceof Error ? error.message.trim().replace(/[.!]+$/, '') : '';
  return said ? `: ${said}` : '';
}

/** A press the owner door turned into a request is not a save: say so, in the server's words. */
function saidAsked(pressed: Pressed<unknown>): boolean {
  if (pressed.state !== 'asked') return false;
  toast(pressed.words, 'info', 6000);
  return true;
}

/**
 * Where a value came from, as a person reads it — or nothing, for a shipped
 * default: a page of "Default" is a page of noise, and the default is what a
 * reader assumes.
 */
export function originWords(
  row: PrefSchemaRow | undefined,
  files?: PrefsSchemaAnswer['files'],
): string | null {
  switch (row?.source) {
    case 'instance':
      return 'Set here';
    case 'config':
      // The default console's own file IS the person's file; any other
      // console reads a key there only when its own file is silent.
      return files && files.instance === files.config ? 'Set here' : 'Set in the shared config';
    case 'migrated':
      return 'Read from an older setting';
    case 'profile':
      return 'Set by the machine profile';
    default:
      return null;
  }
}

/** Whether Reset can take this key back: it is written here, and a page may write it. */
export const resettable = (row: PrefSchemaRow | undefined): boolean =>
  Boolean(row?.writable && (row.source === 'instance' || row.source === 'config'));

export interface SettingState<T> {
  /** The schema's row: the description, the default, the source, whether a page may write it, the CLI line. */
  row: PrefSchemaRow | undefined;
  /** The value being saved while a save is in flight, else the console's, else the shipped default. */
  value: T | undefined;
  save: (next: T) => void;
  saving: boolean;
  /** The schema has not answered yet. */
  reading: boolean;
  files: PrefsSchemaAnswer['files'] | undefined;
}

/** One row of the schema, by key. */
export function useSchemaRow(pref: string): {
  row: PrefSchemaRow | undefined;
  reading: boolean;
  files?: PrefsSchemaAnswer['files'];
} {
  const schema = usePrefsSchema();
  const row = useMemo(() => schema.data?.rows.find((one) => one.key === pref), [schema.data, pref]);
  return { row, reading: schema.isPending, ...(schema.data ? { files: schema.data.files } : {}) };
}

/**
 * Read and write one key. The value a save sends stands on screen until the
 * schema answers again — a control that flicked back to the old value for the
 * length of a round trip would read as a save that failed.
 */
export function useSetting<T = unknown>(pref: string): SettingState<T> {
  const schema = usePrefsSchema();
  const row = useMemo(() => schema.data?.rows.find((one) => one.key === pref), [schema.data, pref]);
  const { mutate, isPending } = usePrefsWrite();
  const [draft, setDraft] = useState<{ value: T; at: number } | null>(null);

  useEffect(() => {
    if (draft && schema.dataUpdatedAt > draft.at) setDraft(null);
  }, [schema.dataUpdatedAt, draft]);

  const save = useCallback(
    (next: T) => {
      setDraft({ value: next, at: Date.now() });
      mutate(prefPatch(pref, next), {
        onSuccess: (pressed) => {
          if (saidAsked(pressed)) setDraft(null);
        },
        onError: (error) => {
          setDraft(null);
          toast(failureWords(error), 'error');
        },
      });
    },
    [mutate, pref],
  );

  const held = row ? (row.value ?? row.default) : undefined;
  return {
    row,
    value: (draft ? draft.value : (held ?? undefined)) as T | undefined,
    save,
    saving: isPending,
    reading: schema.isPending,
    files: schema.data?.files,
  };
}

/* ---------------- the frame of a group and of a row ---------------- */

/**
 * A group of rows under one heading — space between rows, a hairline only
 * between groups (design.md §1, principle 7). `id` names the group for a test
 * and an address.
 */
export function SettingsGroup({
  title,
  lead,
  id,
  aside,
  className,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `settings-group-${useId()}`;
  return (
    <section
      aria-labelledby={headingId}
      data-settings-group={id}
      className={cn(
        'flex min-w-0 flex-col gap-4 border-t border-rule pt-6 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <div className="min-w-0">
        <SectionHeading id={headingId} aside={aside}>
          {title}
        </SectionHeading>
        {lead != null && <p className="mt-1 max-w-(--measure) text-meta text-ink-muted">{lead}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}

/**
 * Where the value came from, and Reset where the key is written here. Its own
 * line, never inside the control's label: a button inside a label is a control
 * inside a control. Under a thumb the button is 44 tall, and the line grows to
 * hold it: its desk margins would hang it over the next row or group, which
 * then wins its corners.
 */
export function Origin({
  pref,
  row,
  files,
  className,
}: {
  pref: string;
  row: PrefSchemaRow | undefined;
  files?: PrefsSchemaAnswer['files'] | undefined;
  className?: string;
}) {
  const reset = usePrefReset();
  const words = originWords(row, files);
  if (!words) return null;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-faint',
        className,
      )}
    >
      <span data-origin={row?.source}>{words}</span>
      {resettable(row) && (
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 h-6 px-1.5 [@media(hover:none)]:my-0"
          disabled={reset.isPending}
          onClick={() =>
            reset.mutate(pref, {
              onSuccess: (pressed) => void saidAsked(pressed),
              onError: (error) => toast(failureWords(error), 'error'),
            })
          }
          aria-label={`Reset ${pref} to its default`}
        >
          Reset
        </Button>
      )}
    </div>
  );
}

/** The ids a row hands its control: the control's own, and the hint's when one is on screen. */
export interface ControlIds {
  id: string;
  describedBy: string | undefined;
}

/**
 * A row whose control sits at the END: a select, a number, a text, an editor.
 * `wide` puts the control under the name at the row's width instead (a list, a
 * schedule). `pref` marks the row for the coverage test and draws the origin
 * line; a row with no key of its own (a read-out) leaves it out.
 */
export function SettingRow({
  pref,
  label,
  hint,
  note,
  refused = false,
  facts,
  wide,
  className,
  children,
}: {
  pref?: string;
  label: ReactNode;
  hint?: ReactNode;
  /** One more meta line under the hint — an error, why a control is off. */
  note?: ReactNode;
  /** The note is a refusal of what was just typed: announced, as 6.x announced it, not only described. */
  refused?: boolean;
  /** Facts beside the description (Everything's default and command line), never part of it. */
  facts?: ReactNode;
  wide?: boolean;
  className?: string;
  children: ReactNode | ((ids: ControlIds) => ReactNode);
}) {
  const id = `setting-${useId()}`;
  const hintId = `${id}-hint`;
  const described = hint != null || note != null;
  const control =
    typeof children === 'function' ? children({ id, describedBy: described ? hintId : undefined }) : children;
  return (
    <div
      {...(pref ? { 'data-pref': pref } : {})}
      className={cn(
        'grid min-w-0 gap-x-6 gap-y-1.5',
        !wide && 'sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]',
        className,
      )}
    >
      <Label htmlFor={id} className="min-w-0 break-words">
        {label}
      </Label>
      <div className={cn('min-w-0', !wide && 'sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:self-start')}>
        {control}
      </div>
      {described && (
        <p
          id={hintId}
          className="grid min-w-0 max-w-(--measure) gap-0.5 text-meta text-ink-muted sm:col-start-1"
        >
          {hint != null && <span className="min-w-0 break-words">{hint}</span>}
          {note != null && (
            <span className="min-w-0 break-words" {...(refused ? { role: 'alert' } : {})}>
              {note}
            </span>
          )}
        </p>
      )}
      {facts != null && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-ink-muted sm:col-start-1">
          {facts}
        </div>
      )}
      {pref && <OriginOf pref={pref} className="sm:col-start-1" />}
    </div>
  );
}

function OriginOf({ pref, className }: { pref: string; className?: string }) {
  const { row, files } = useSchemaRow(pref);
  return <Origin pref={pref} row={row} files={files} {...(className ? { className } : {})} />;
}

/* ---------------- the typed rows ---------------- */

/**
 * A boolean: a checkbox before its name, the hint under it, the origin under
 * that. `value`/`onChange` override the schema for a control whose truth lives
 * elsewhere; `disabledReason` says what would turn a control that is off on.
 */
export function BoolSetting({
  pref,
  label,
  hint,
  facts,
  disabledReason,
  value,
  onChange,
}: {
  pref: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Facts beside the description: Everything's default and command line. */
  facts?: ReactNode;
  disabledReason?: string | undefined;
  value?: boolean;
  onChange?: (next: boolean) => void;
}) {
  const setting = useSetting<boolean>(pref);
  const on = value ?? setting.value === true;
  const off = Boolean(disabledReason) || setting.row?.writable === false;
  return (
    <div data-pref={pref} className="flex min-w-0 flex-col gap-1">
      <label className="tap-row flex min-w-0 items-start gap-2.5 text-body">
        <Checkbox
          className="mt-0.5"
          checked={on}
          disabled={off}
          {...(disabledReason ? { title: disabledReason } : {})}
          onCheckedChange={(next) => (onChange ?? setting.save)(next === true)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="min-w-0 break-words text-ink">{label}</span>
          {hint != null && (
            <span className="max-w-(--measure) break-words text-meta text-ink-muted">{hint}</span>
          )}
          {disabledReason && (
            <span className="max-w-(--measure) break-words text-meta text-ink-muted">{disabledReason}</span>
          )}
        </span>
      </label>
      {facts != null && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 ps-[1.625rem] text-meta text-ink-muted">
          {facts}
        </div>
      )}
      <Origin pref={pref} row={setting.row} files={setting.files} className="ps-[1.625rem]" />
    </div>
  );
}

/**
 * One word of a vocabulary. `options` are `[value, label]`; absent, the
 * schema's own words are offered by themselves. A stored word the list does not
 * name is still offered — dropping it would re-point the setting without
 * saying so.
 */
export function WordSetting({
  pref,
  label,
  hint,
  facts,
  options,
  placeholder,
  disabledReason,
  value,
  onChange,
}: {
  pref: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Facts beside the description: Everything's default and command line. */
  facts?: ReactNode;
  options?: readonly (readonly [string, string])[];
  /** The label of a `''` choice the caller wants offered first. */
  placeholder?: string;
  disabledReason?: string | undefined;
  value?: string;
  onChange?: (next: string) => void;
}) {
  const setting = useSetting<string>(pref);
  const current = value ?? (typeof setting.value === 'string' ? setting.value : '');
  const listed = options ?? (setting.row?.words ?? []).map((word) => [word, word] as const);
  const offered =
    current && !listed.some(([id]) => id === current) && current !== ''
      ? [...listed, [current, current] as const]
      : listed;
  return (
    <SettingRow pref={pref} label={label} hint={hint} note={disabledReason} facts={facts}>
      {({ id, describedBy }) => (
        <NativeSelect
          id={id}
          aria-describedby={describedBy}
          className="w-full sm:w-auto sm:max-w-72"
          value={current}
          disabled={Boolean(disabledReason) || setting.row?.writable === false}
          onChange={(event) => (onChange ?? setting.save)(event.target.value)}
        >
          {placeholder != null && <option value="">{placeholder}</option>}
          {offered.map(([word, text]) => (
            <option key={word} value={word}>
              {text}
            </option>
          ))}
        </NativeSelect>
      )}
    </SettingRow>
  );
}

/**
 * A number, committed when the field is left or Enter is pressed — never on
 * every keystroke, which would save "1" on the way to "15". Escape puts the
 * held value back. `scale` shows a stored unit in a person's (`60_000`: ms read
 * as minutes); `unit` is the word after the field.
 */
export function NumberSetting({
  pref,
  label,
  hint,
  facts,
  unit,
  alignUnit = false,
  scale = 1,
  min,
  max,
  step,
  integer = false,
  placeholder,
  disabledReason,
  value,
  onChange,
}: {
  pref: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Facts beside the description: Everything's default and command line. */
  facts?: ReactNode;
  unit?: string;
  /** In a list of mixed units, every field lines up: the unit sits in a slot of one width, empty for a count. */
  alignUnit?: boolean;
  scale?: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  placeholder?: string;
  disabledReason?: string | undefined;
  value?: number | null;
  onChange?: (next: number) => void;
}) {
  const setting = useSetting<number | null>(pref);
  const held = value !== undefined ? value : typeof setting.value === 'number' ? setting.value : null;
  const shown = held == null ? '' : String(round(held / scale));
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === shown) return setError(null);
    const read = Number(trimmed);
    const problem =
      trimmed === '' || !Number.isFinite(read)
        ? 'Type a number.'
        : integer && !Number.isInteger(read)
          ? 'Type a whole number.'
          : min != null && read < min
            ? `Type ${min} or more.`
            : max != null && read > max
              ? `Type ${max} or less.`
              : null;
    if (problem) return setError(problem);
    setError(null);
    (onChange ?? setting.save)(round(read * scale));
  };

  return (
    <SettingRow
      pref={pref}
      label={label}
      hint={hint}
      note={error ?? disabledReason}
      refused={Boolean(error)}
      facts={facts}
    >
      {({ id, describedBy }) => (
        <span className="flex min-w-0 items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="w-28"
            value={text}
            {...(min != null ? { min } : {})}
            {...(max != null ? { max } : {})}
            {...(step != null ? { step } : {})}
            {...(placeholder ? { placeholder } : {})}
            disabled={Boolean(disabledReason) || setting.row?.writable === false}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                setText(shown);
                setError(null);
              }
            }}
          />
          {(unit || alignUnit) && (
            <span className={cn('shrink-0 text-meta text-ink-muted', alignUnit && 'w-10')}>{unit}</span>
          )}
        </span>
      )}
    </SettingRow>
  );
}

/** Rounded to what a person types, so 0.1 + 0.2 never reaches the file. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * A line of text, committed like a number: on leaving the field or on Enter.
 * `emptyIs` is what an emptied field saves — `''` by default, or `null` to take
 * the key back to its default. `check` refuses a value before it is sent, in
 * the sentence it returns, and nothing is saved.
 */
export function TextSetting({
  pref,
  label,
  hint,
  facts,
  placeholder,
  emptyIs = '',
  mono = false,
  check,
  disabledReason,
  value,
  onChange,
}: {
  pref: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Facts beside the description: Everything's default and command line. */
  facts?: ReactNode;
  placeholder?: string;
  emptyIs?: '' | null;
  /** A machine value — a command, a branch, an owner/name — in the mono face. */
  mono?: boolean;
  /** Why a typed value cannot be saved, or null when it can. */
  check?: (next: string) => string | null;
  disabledReason?: string | undefined;
  value?: string;
  onChange?: (next: string | null) => void;
}) {
  const setting = useSetting<string | null>(pref);
  const shown = value ?? (typeof setting.value === 'string' ? setting.value : '');
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text === shown) return setError(null);
    const problem = check?.(text.trim()) ?? null;
    setError(problem);
    if (problem) return;
    // What is sent is what was judged: the text trimmed, as 6.x sent it.
    const next = text.trim() === '' ? emptyIs : text.trim();
    (onChange ?? setting.save)(next);
  };
  return (
    <SettingRow
      pref={pref}
      label={label}
      hint={hint}
      note={error ?? disabledReason}
      refused={Boolean(error)}
      facts={facts}
    >
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn('w-full sm:w-72', mono && 'font-mono')}
          value={text}
          {...(placeholder ? { placeholder } : {})}
          disabled={Boolean(disabledReason) || setting.row?.writable === false}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setText(shown);
              setError(null);
            }
          }}
        />
      )}
    </SettingRow>
  );
}

/**
 * A command's arguments as words that wrap between them and never inside one:
 * a line may break after the hyphen of `--port`, so each argument is a box of
 * its own, and only an argument longer than the line wraps within itself.
 */
export function ArgWords({ args, none = 'none' }: { args: readonly string[]; none?: string }) {
  if (!args.length) return <>{none}</>;
  return (
    <>
      {args.map((arg, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          <span className="inline-block max-w-full wrap-anywhere">{arg}</span>
        </Fragment>
      ))}
    </>
  );
}
