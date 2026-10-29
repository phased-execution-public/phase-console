/**
 * Settings ▸ Everything — every key this console stores (quiet-console phase
 * 21, §Architecture 5): one row per row of `GET /api/prefs/schema`, grouped by
 * the section that owns it.
 *
 * ```
 * Automation  64                                        Open Automation
 * ladderPerRunUsd                                      [ 20 ] dollars
 * Repair dollars per run.
 * Default $20
 * Set here   Reset
 * ```
 *
 * A row is the key's own name, what it does, a control where a page may write
 * it (or the value and the command line that changes it where none may), its
 * shipped default, and where its value came from — silent for a default, a
 * word for anything else, Reset beside a key set here. The section that edits
 * a structured key (a policy table, a schedule) is linked rather than
 * re-drawn: two editors for one key disagree the day their rules do.
 *
 * The three doors, on every key (quiet-console phase 27). Expand: Details, the
 * last word of the row's facts line, folds open under it the facts the glance
 * leaves out — the type, the words, the command line, the file the value is
 * written in — and the way into the panel. Inspect: the key's whole record in
 * the panel (`./key-inspector`). Everything (the toolbar's last slot) puts the
 * type, the words and the line that changes it from a terminal on every row.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { usePrefsSchema, type PrefSchemaRow, type PrefsSchemaAnswer } from '@/data/console';
import { cn } from '@/lib/cn';
import { useInspected } from '@/shell/panel/inspector-host';
import { repoHref, settingsHref } from '@/shell/routes';
import { Banner, Button, Empty, Mono, Skeleton, useEverything } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { Toolbar } from '@/ui/toolbar';
import { inspectKey, keyInspectKey, type KeyWords } from './key-inspector';
import { SETTINGS_SECTIONS, sectionOfGroup, sectionTitle } from './nav';
import { searchSettings } from './search';
import {
  BoolSetting,
  Origin,
  NumberSetting,
  SettingRow,
  SettingsGroup,
  TextSetting,
  WordSetting,
  originWords,
} from './setting';
import { formatUsd } from '@/ui/money';

/* ---------------- a value, in words ---------------- */

const UNIT_AFTER: Readonly<Record<string, string>> = {
  ms: 'ms',
  hours: 'hours',
  days: 'days',
  bytes: 'bytes',
  megabytes: 'MB',
  usd: 'dollars',
  percent: '%',
  count: '',
  factor: 'times the cores',
};

/** A reading longer than this (a path, a list) is drawn under the key's name, not at the row's end. */
const LONG_VALUE = 40;

const DURATIONS: readonly (readonly [number, string])[] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1_000, 'second'],
];

/** A duration in ms as a person says it, when it is a whole number of some unit. */
function durationWords(ms: number): string | null {
  if (ms === 0) return null;
  for (const [size, word] of DURATIONS) {
    if (ms % size === 0) {
      const n = ms / size;
      return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
    }
  }
  return null;
}

/** A byte count in the largest unit that keeps it whole-ish. */
function byteWords(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'] as const;
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${unit ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n.toLocaleString()} ${units[unit]}`;
}

/** A number with its unit, as a person reads it. */
export function numberWords(n: number, unit?: string): string {
  switch (unit) {
    case 'ms':
      return durationWords(n) ?? `${n.toLocaleString()} ms`;
    case 'bytes':
      return byteWords(n);
    case 'usd':
      return formatUsd(n, 'grouped');
    case 'percent':
      return `${n}%`;
    case 'factor':
      return `${n}×`;
    case 'hours':
    case 'days':
      return `${n.toLocaleString()} ${n === 1 ? unit.slice(0, -1) : unit}`;
    case 'megabytes':
      return `${n.toLocaleString()} MB`;
    default:
      return n.toLocaleString();
  }
}

/** Any value of the schema, in words — never a JSON dump on the glance. */
export function valueWords(
  row: Pick<PrefSchemaRow, 'type' | 'unit' | 'secret' | 'key'>,
  value: unknown,
): string {
  if (value === null || value === undefined) return 'Not set';
  if (row.secret) {
    if (Array.isArray(value)) {
      if (!value.length) return 'None';
      const origins = value.map(
        (one) =>
          (one as { origin?: string; name?: string }).name ?? (one as { origin?: string }).origin ?? 'one',
      );
      return `${value.length} set: ${origins.join(', ')}`;
    }
    return 'Set, and withheld';
  }
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return numberWords(value, row.unit);
  if (typeof value === 'string') return value === '' ? 'Empty' : value;
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    if (value.every((one) => typeof one === 'string')) {
      const shown = value.slice(0, 3).join(', ');
      return value.length > 3 ? `${shown} and ${value.length - 3} more` : shown;
    }
    return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  }
  if (typeof value === 'object') {
    const n = Object.keys(value as object).length;
    return n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : 'None';
  }
  return String(value);
}

/* ---------------- one key ---------------- */

/**
 * The structured keys a section edits whole — linked from their row, never
 * re-drawn here. A queue key is written through the queue's own door.
 */
const EDITED_IN: Readonly<Record<string, { href: string; where: string }>> = {
  policy: { href: settingsHref('automation'), where: 'Automation' },
  relayRules: { href: settingsHref('automation'), where: 'Automation' },
  boardingSchedule: { href: settingsHref('automation'), where: 'Automation' },
  schedulingPolicy: { href: settingsHref('automation'), where: 'Automation' },
  schedulingPolicies: { href: settingsHref('automation'), where: 'Automation' },
  loadGuardFactor: { href: settingsHref('automation'), where: 'Automation' },
  recentRoots: { href: settingsHref('essentials'), where: 'Essentials' },
  lastRoot: { href: settingsHref('essentials'), where: 'Essentials' },
  issueRepos: { href: repoHref('issues'), where: 'Repo, on the Issues desk' },
};

/**
 * Whole namespaces one section draws: the machine profile and the retention
 * policy are This instance's. The profile is the machine's — read there, each
 * field with its line, and changed only from a terminal.
 */
const EDITED_UNDER: readonly (readonly [string, { href: string; where: string; readOnly?: true }])[] = [
  ['profile.', { href: settingsHref('instance'), where: 'This instance', readOnly: true }],
  ['retention.', { href: settingsHref('instance'), where: 'This instance' }],
];

/**
 * Keys a section draws though their schema group belongs to another (one-pool
 * phase 9): the pool's policy and the catalog's price corrections are the pool
 * desk's, Settings ▸ Accounts. Linked as where each is changed; each stays
 * editable here as its type allows.
 */
const DRAWN_IN: Readonly<Record<string, { href: string; where: string }>> = {
};

/** Where a key's own section draws it, if one does. */
function editedIn(key: string): { href: string; where: string; readOnly?: true } | undefined {
  return EDITED_IN[key] ?? DRAWN_IN[key] ?? EDITED_UNDER.find(([prefix]) => key.startsWith(prefix))?.[1];
}

/** Whether the row's own control can edit it here: a writable plain value. */
function editableHere(row: PrefSchemaRow): boolean {
  return (
    row.writable &&
    !row.secret &&
    (row.type === 'boolean' || row.type === 'word' || row.type === 'number' || row.type === 'string') &&
    !(row.key in EDITED_IN && row.type !== 'string')
  );
}

/** What a key holds, in words, its unit after it: `number in dollars`. */
export function keyTypeWords(row: Pick<PrefSchemaRow, 'type' | 'unit'>): string {
  return `${row.type}${row.unit ? ` in ${UNIT_AFTER[row.unit] || row.unit}` : ''}`;
}

/**
 * The file a key's value is written in, where the schema says one holds it.
 * A shipped default is in none, and a migrated value was read from another
 * key's spelling, in a file the schema does not name.
 */
export function keyFileOf(
  row: Pick<PrefSchemaRow, 'source'>,
  files: PrefsSchemaAnswer['files'] | undefined,
): string | undefined {
  switch (row.source) {
    case 'instance':
      return files?.instance;
    case 'config':
      return files?.config;
    case 'profile':
      return files?.profile;
    default:
      return undefined;
  }
}

/**
 * Every fact of a key in the words its row says them — the glance, the fold
 * and the panel read one key one way. The section is the one that draws it:
 * the one that edits it whole when there is one, else the section its group
 * belongs to.
 */
export function keyWordsOf(row: PrefSchemaRow, files: PrefsSchemaAnswer['files'] | undefined): KeyWords {
  const file = keyFileOf(row, files);
  const own = sectionOfGroup(row.group);
  return {
    value: valueWords(row, row.value),
    ...('default' in row ? { default: valueWords(row, row.default) } : {}),
    type: keyTypeWords(row),
    origin: originWords(row, files) ?? 'The shipped default',
    ...(file ? { file } : {}),
    section: editedIn(row.key) ?? { href: settingsHref(own), where: sectionTitle(own) },
  };
}

/** The glance draws a key's command line under Everything, and always for a key no page writes. */
const cliOnGlance = (row: PrefSchemaRow, everything: boolean): boolean =>
  Boolean(row.cli) && (everything || !row.writable);

function Facts({ row, everything }: { row: PrefSchemaRow; everything: boolean }) {
  const parts: ReactNode[] = [];
  if ('default' in row) parts.push(<span key="default">Default {valueWords(row, row.default)}</span>);
  if (everything) {
    parts.push(<span key="type">{keyTypeWords(row)}</span>);
    if (row.words?.length) parts.push(<span key="words">{row.words.join(', ')}</span>);
  }
  const edited = editedIn(row.key);
  if (edited && !editableHere(row)) {
    parts.push(
      <a
        key="where"
        href={edited.href}
        className="tap-row text-ink underline decoration-ink-faint underline-offset-2"
      >
        {edited.readOnly ? 'See it in' : 'Change it in'} {edited.where}
      </a>,
    );
  }
  if (row.cli && cliOnGlance(row, everything)) {
    parts.push(<Mono key="cli" value={row.cli} copyable words className="min-w-0" />);
  }
  return parts.length ? <>{parts}</> : null;
}

/**
 * What a key's fold holds: the facts the glance leaves out, and the way into
 * the panel. Under Everything the glance already says the type, the words and
 * the command line, so the fold keeps the file and Inspect. Mounted only while
 * open, so only an open fold asks which record the panel shows.
 */
function KeyDetailsBody({
  row,
  files,
  everything,
}: {
  row: PrefSchemaRow;
  files: PrefsSchemaAnswer['files'] | undefined;
  everything: boolean;
}) {
  const shown = useInspected()?.key === keyInspectKey(row.key);
  const file = keyFileOf(row, files);
  const facts: ReactNode[] = [];
  if (!everything) {
    facts.push(<span key="type">{keyTypeWords(row)}</span>);
    if (row.words?.length) facts.push(<span key="words">{row.words.join(', ')}</span>);
  }
  if (row.cli && !cliOnGlance(row, everything)) {
    facts.push(<Mono key="cli" value={row.cli} copyable words className="min-w-0" />);
  }
  if (file) {
    facts.push(
      <span key="file" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span>Written in</span>
        <Mono value={file} copyable className="wrap-anywhere" />
      </span>,
    );
  }
  return (
    <>
      {facts.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">{facts}</div>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={shown}
        onClick={() => inspectKey(row, files, keyWordsOf)}
      >
        Inspect
      </Button>
    </>
  );
}

/**
 * The first door on a key: one quiet toggle, the last word of the row's facts
 * line — never inside the control's label, where a press would also work the
 * control. Its wrapper draws no box (`contents`), so the toggle is one more
 * fact on a line the row already has, and the open body takes a line of its
 * own beneath it: two hundred keys, and not one line taller for the door.
 */
function KeyDetails({
  row,
  files,
  everything,
}: {
  row: PrefSchemaRow;
  files: PrefsSchemaAnswer['files'] | undefined;
  everything: boolean;
}) {
  return (
    <Disclosure
      label="Details"
      openLabel="Hide details"
      className="contents [&>.expand-region]:basis-full"
      bodyClassName="flex min-w-0 flex-col items-start gap-1 pt-1"
    >
      <KeyDetailsBody row={row} files={files} everything={everything} />
    </Disclosure>
  );
}

/**
 * One key: its name, what it does, the control or the reading, the facts, the
 * origin. The control is the same typed row every section draws, so a key
 * edited here and in its section is one control written twice, never two.
 */
export function KeyRow({
  row,
  files,
  everything = false,
}: {
  row: PrefSchemaRow;
  files?: PrefsSchemaAnswer['files'] | undefined;
  everything?: boolean;
}) {
  const label = <Mono value={row.key} className="text-body text-ink" />;
  const facts = (
    <>
      <Facts row={row} everything={everything} />
      <KeyDetails row={row} files={files} everything={everything} />
    </>
  );
  if (editableHere(row)) {
    switch (row.type) {
      case 'boolean':
        return <BoolSetting pref={row.key} label={label} hint={row.description} facts={facts} />;
      case 'word':
        return <WordSetting pref={row.key} label={label} hint={row.description} facts={facts} />;
      case 'number':
        return (
          <NumberSetting
            pref={row.key}
            label={label}
            hint={row.description}
            facts={facts}
            {...(row.unit && UNIT_AFTER[row.unit] ? { unit: UNIT_AFTER[row.unit] } : {})}
          />
        );
      default:
        return <TextSetting pref={row.key} label={label} hint={row.description} facts={facts} mono />;
    }
  }
  // A reading longer than a short word — a path, a list — goes under the name at
  // the row's width (`wide`), as a list does: at the row's end its whole length
  // was the column's, and the name and its description were left a sliver.
  const value = valueWords(row, row.value);
  const long = value.length > LONG_VALUE;
  return (
    <div data-key={row.key} className="flex min-w-0 flex-col gap-1">
      <SettingRow label={label} hint={row.description} facts={facts} wide={long}>
        <span
          className={cn('block min-w-0 wrap-anywhere text-body text-ink', !long && 'sm:text-end')}
          data-value
        >
          {value}
        </span>
      </SettingRow>
      <Origin pref={row.key} row={row} files={files} />
    </div>
  );
}

/* ---------------- the section ---------------- */

const SHOWS = [
  ['all', 'Every key'],
  ['set', 'Set, not the default'],
  ['default', 'Shipped defaults'],
  ['read-only', 'Read only here'],
] as const;

type Show = (typeof SHOWS)[number][0];

function shows(row: PrefSchemaRow, show: Show): boolean {
  switch (show) {
    case 'set':
      return row.source !== 'default';
    case 'default':
      return row.source === 'default';
    case 'read-only':
      return !editableHere(row);
    default:
      return true;
  }
}

/** The rows, grouped by the section that owns each, in the sections' order. */
export function groupBySection(rows: readonly PrefSchemaRow[]): { id: string; rows: PrefSchemaRow[] }[] {
  const by = new Map<string, PrefSchemaRow[]>();
  for (const row of rows) {
    const id = sectionOfGroup(row.group);
    by.set(id, [...(by.get(id) ?? []), row]);
  }
  return SETTINGS_SECTIONS.filter((section) => by.has(section.id)).map((section) => ({
    id: section.id,
    rows: by.get(section.id)!,
  }));
}

/**
 * The section. `query` is the place's own search (`?q=`): on Everything it
 * narrows the keys in place rather than leaving for the results.
 */
export function EverythingSection({ query = '' }: { query?: string }) {
  const schema = usePrefsSchema();
  const everything = useEverything('settings-everything');
  const [show, setShow] = useState<Show>('all');

  const rows = schema.data?.rows;
  const kept = useMemo(() => {
    if (!rows) return [];
    const found = query.trim() ? searchSettings(query, rows).keys : rows;
    return found.filter((row) => shows(row, show));
  }, [rows, query, show]);

  if (schema.error && !rows) {
    return (
      <Banner
        severity="error"
        action={
          <Button size="sm" variant="ghost" onClick={() => void schema.refetch()}>
            Try again
          </Button>
        }
      >
        The settings could not be read: {schema.error.message || 'the read failed and said nothing.'}
      </Banner>
    );
  }
  if (!rows) {
    return (
      <div className="flex min-w-0 flex-col gap-4" aria-busy="true" aria-label="Reading every key">
        <Skeleton className="h-9 max-w-md" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  const set = rows.filter((row) => row.source !== 'default').length;
  const picker = (
    <NativeSelect
      aria-label="Show"
      className="w-full md:w-56"
      value={show}
      onChange={(event) => setShow(event.target.value as Show)}
    >
      {SHOWS.map(([id, words]) => (
        <option key={id} value={id}>
          {words}
        </option>
      ))}
    </NativeSelect>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-everything">
      <Toolbar
        label="Every key"
        filter={{
          label: 'Show',
          value: SHOWS.find(([id]) => id === show)![1],
          active: show === 'all' ? 0 : 1,
          panel: picker,
          inline: picker,
        }}
        everything={everything}
        note={
          <span>
            {rows.length} keys, {set} set here or elsewhere
            {kept.length !== rows.length ? `; ${kept.length} shown` : ''}
          </span>
        }
      />
      {kept.length === 0 ? (
        <Empty
          title={query.trim() ? 'No key matches the search.' : 'No key matches what is shown.'}
          action={
            <Button size="sm" onClick={() => setShow('all')}>
              Show every key
            </Button>
          }
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-0">
          {groupBySection(kept).map((group) => (
            <SettingsGroup
              key={group.id}
              id={`everything-${group.id}`}
              title={
                // Two flex items and a gap, never a margin: a Latin title and
                // its count are one left-to-right run under `dir="rtl"`, and a
                // margin on the count's start lands outside that run.
                <span className="inline-flex min-w-0 items-baseline gap-2">
                  <span>{sectionTitle(group.id)}</span>
                  <span className="text-meta font-normal tabular-nums text-ink-faint">
                    {group.rows.length}
                  </span>
                </span>
              }
              aside={
                group.id === 'everything' ? undefined : (
                  <a
                    href={settingsHref(group.id)}
                    className="tap-line text-meta text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink"
                  >
                    Open {sectionTitle(group.id)}
                  </a>
                )
              }
            >
              {group.rows.map((row) => (
                <KeyRow key={row.key} row={row} files={schema.data?.files} everything={everything.on} />
              ))}
            </SettingsGroup>
          ))}
        </div>
      )}
    </div>
  );
}
