/**
 * The operator's verbs, pressed by name.
 *
 * `shared/verb-model.js` is the one table of what a person may do to a run —
 * pause, retry, isolate, board at a boundary, raise a budget — and the CLI,
 * the routes and the stored triggers already read it. This is the page's
 * reading of the same rows: a verb's route with its placeholders filled, and
 * the press through `./press`, so a verb the palette or a panel offers is
 * pressed exactly as `phase-console run <verb>` presses it.
 */

import { verbNamed } from '@shared/verb-model.js';
import { request } from './http';
import { press, type PressOptions, type Pressed } from './press';

/** What fills a route's placeholders: `:slug`, `:phase`, `:id`, `:n`. */
export type VerbArgs = Readonly<Record<string, string | number | undefined>>;

/**
 * A verb's method and path, its placeholders filled and escaped. Throws for a
 * name the table does not hold and for a placeholder with no value: a press
 * aimed at `/api/run//pause` is a 404 that reads like the server's fault.
 */
export function verbRoute(name: string, args: VerbArgs = {}): { method: string; path: string } {
  const row = verbNamed(name);
  if (!row) throw new Error(`No operator verb is called ${name}.`);
  const [method, template] = row.route.split(' ') as [string, string];
  const path = template.replace(/:([a-z]+)/g, (_, key: string) => {
    const value = args[key];
    if (value === undefined || value === '') throw new Error(`The ${name} verb needs its ${key}.`);
    return encodeURIComponent(String(value));
  });
  return { method, path };
}

/**
 * A verb as a terminal spells it — `phase-console run <verb>`, its positional
 * words in the table's order, then its flags — the line a page hands a person
 * to paste where no page presses it. A positional the caller fills is written
 * out (quoted where a shell would split it) and one it does not is `<word>`; a
 * flag is written when the caller gives its body field, or as `<word>` when
 * `template` names it. `null` for a verb the CLI has no spelling of: the line
 * is `bin/run-verb.mjs`'s reading of the same row, never a second one.
 */
export function verbLine(
  name: string,
  args: VerbArgs = {},
  template: Readonly<Record<string, string>> = {},
): string | null {
  const row = verbNamed(name);
  if (!row?.cli) return null;
  const words = ['phase-console', 'run', name];
  for (const arg of row.cli.args) {
    const value = args[arg];
    words.push(value === undefined || value === '' ? `<${arg}>` : shellWord(String(value)));
  }
  for (const [flag, field] of Object.entries(row.cli.flags)) {
    const value = typeof field === 'string' ? args[field] : undefined;
    if (value !== undefined && value !== '') words.push(flag, shellWord(String(value)));
    else if (template[flag]) words.push(flag, `<${template[flag]}>`);
  }
  return words.join(' ');
}

/** One word for a POSIX shell: as it is when nothing in it splits or expands, else single-quoted. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Press a verb: its route, its body — the query for a read — through the one
 * door. A read is pressed too, so a long poll and a pause answer alike.
 */
export function pressVerb<T = unknown>(
  name: string,
  args: VerbArgs = {},
  body: Readonly<Record<string, unknown>> = {},
  options?: PressOptions,
): Promise<Pressed<T>> {
  const { method, path } = verbRoute(name, args);
  if (method === 'GET') {
    const query = new URLSearchParams(
      Object.entries(body).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
    ).toString();
    return press(() => request<T>(query ? `${path}?${query}` : path), options);
  }
  return press(
    () =>
      request<T>(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    options,
  );
}
