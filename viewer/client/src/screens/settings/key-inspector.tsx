/**
 * A key in the panel — Inspect, the second door to depth, for the keys of
 * Settings ▸ Everything (7.0, quiet-console phase 27; design.md principle 3).
 *
 * A key's row keeps its glance calm — its name, what it does, its control, its
 * default — and folds the rest under Details; Inspect hands the panel the key's
 * WHOLE record: every fact the schema row carries, in the words its row says
 * them, and the row as the server sent it. Two tabs, Overview and Raw: the
 * console keeps no history of a key, and its one act is the control the row
 * already draws.
 *
 * The record is read LIVE from the one schema answer the page reads, so a save
 * on the row moves the panel with it, and a key the answer stops holding keeps
 * the facts it was inspected with. The words are made where the row makes them
 * (`./everything`), and handed in as `wordsOf`, so the row and the panel cannot
 * say one key two ways — and this file reaches nothing of the row's.
 *
 * A secret stays one. The schema never serves a credential (a `secret` row says
 * only that one is set, a webhook by its origin and a masked tail), and the
 * page never draws even the masked tail: Raw says `[withheld]` in its place.
 */

import { usePrefsSchema, type PrefSchemaRow, type PrefsSchemaAnswer } from '@/data/console';
import { RawTab } from '@/shell/panel/raw-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { KeyValue, Mono } from '@/ui';

type SchemaFiles = PrefsSchemaAnswer['files'] | undefined;

/** The panel's name for a key's record — what `useInspected()` is compared to, to mark the row on show. */
export const keyInspectKey = (key: string): string => `setting:${key}`;

/** Every fact of a key, in the words its row says them. */
export interface KeyWords {
  /** The value it runs with — a secret's said as set, never served. */
  value: string;
  /** Its shipped default; absent for a key that ships none. */
  default?: string;
  /** What it holds: `number in dollars`, `word`, `boolean`. */
  type: string;
  /** Where the value came from: `Set here`, `Set by the machine profile`, `The shipped default`. */
  origin: string;
  /** The file the value is written in, where one holds it. */
  file?: string;
  /** The section that draws it: changed there, or shown there read only. */
  section?: { href: string; where: string; readOnly?: true };
}

/** How the row says a key — `./everything` owns it. */
export type KeyWordsOf = (row: PrefSchemaRow, files: SchemaFiles) => KeyWords;

/** The schema's own word for a value it does not serve (`server/prefs-schema.ts` `WITHHELD`). */
const WITHHELD = '[withheld]';

/** The row as the server sent it, but for a secret's value — said as withheld, masked tail and all. */
export function keyRaw(row: PrefSchemaRow): PrefSchemaRow {
  return row.secret && row.value != null ? { ...row, value: WITHHELD } : row;
}

/** The key as the schema answer holds it now — or as it was inspected, once the answer drops it. */
function useLiveKey(row: PrefSchemaRow, files: SchemaFiles): { row: PrefSchemaRow; files: SchemaFiles } {
  const { data } = usePrefsSchema();
  const live = data?.rows.find((one) => one.key === row.key);
  return live ? { row: live, files: data?.files ?? files } : { row, files };
}

/** Every fact the schema row carries, by what it answers: what it is now, where it lives, what it holds. */
function KeyOverview({
  row: inspected,
  files: then,
  wordsOf,
}: {
  row: PrefSchemaRow;
  files: SchemaFiles;
  wordsOf: KeyWordsOf;
}) {
  const { row, files } = useLiveKey(inspected, then);
  const words = wordsOf(row, files);
  const place = words.section;
  return (
    <div className="flex min-w-0 flex-col" data-testid="key-overview">
      <KeyValue
        items={[
          ['Value', words.value],
          ['Default', words.default ?? 'None shipped'],
          ['Comes from', words.origin],
          words.file
            ? ['Written in', <Mono key="file" value={words.file} copyable className="wrap-anywhere" />]
            : null,
          place
            ? [
                place.readOnly ? 'Shown in' : 'Changed in',
                <a
                  key="where"
                  href={place.href}
                  className="tap-row underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
                >
                  {place.where}
                </a>,
              ]
            : null,
          row.cli
            ? ['Command line', <Mono key="cli" value={row.cli} copyable words className="min-w-0" />]
            : null,
          ['Type', words.type],
          row.words?.length ? ['Words', row.words.join(', ')] : null,
          row.secret ? ['Kept secret', 'Yes: the console never serves its value'] : null,
        ]}
      />
    </div>
  );
}

/** The row as the machine holds it, read live as the Overview is. */
function KeyRawTab({ row: inspected, files }: { row: PrefSchemaRow; files: SchemaFiles }) {
  const { row } = useLiveKey(inspected, files);
  return <RawTab value={keyRaw(row)} />;
}

/** Show one key in the panel: its name, what it does, its every fact, and its row. */
export function inspectKey(row: PrefSchemaRow, files: SchemaFiles, wordsOf: KeyWordsOf): void {
  inspect({
    key: keyInspectKey(row.key),
    title: row.key,
    description: row.description,
    overview: <KeyOverview row={row} files={files} wordsOf={wordsOf} />,
    raw: <KeyRawTab row={row} files={files} />,
  });
}
