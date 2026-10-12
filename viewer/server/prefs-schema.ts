/**
 * The settings schema as `GET /api/prefs/schema` answers it (quiet-console
 * phase 25, §Architecture 5): one row per preference this console stores
 * (`PREF_META`) and per field of the machine profile (`PROFILE_META`) — its
 * group, type, words, unit and description from the shared table, then its
 * shipped default, the value the console runs with (`loadPrefs()`'s, the
 * profile's), where that value came from, whether a page can write it, and the
 * line that changes it from a terminal where there is one.
 *
 * Read from the files on every call, as `loadPrefs` reads them, so a hand edit
 * shows at once and the value and its source always describe the same file.
 */

import { DEFAULT_HEAP_MB, fleetProfile, fleetProfilePath, profileFor, readAutostart } from '../shared/instances.mjs';
import { PREF_META, PROFILE_META, type PrefMeta, type PrefSource } from '../shared/prefs-model.js';
import { INSTANCE, instancePrefsFile, loadPrefs, prefDefault, prefSources, sharedPrefsFile, type Instance } from './config.ts';
import { maskUrl } from './webhooks.ts';

export type PrefsSchemaRow = Omit<PrefMeta, 'cli'> & {
  /** `theme` · `notify.needs-you` · `retention.runRetainDays` · `profile.heapMb`. */
  key: string;
  /** The shipped default; absent for a key that has none. */
  default?: unknown;
  /** What the console runs with; null for a key nothing sets. A `secret` key's is `withheld`'s. */
  value: unknown;
  source: PrefSource;
  /** The command line that changes it, where one exists — a read-only key's way out. */
  cli: string | null;
};

export type PrefsSchema = {
  /** The files the values are read from: this console's own, the person's, and the machine profile. */
  files: { instance: string; config: string; profile: string };
  rows: PrefsSchemaRow[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function row(key: string, meta: PrefMeta, shipped: { known: boolean; value?: unknown }, value: unknown, source: PrefSource, cli: string | null): PrefsSchemaRow {
  const described: PrefMeta = { ...meta };
  delete described.cli;
  return {
    key, ...described,
    ...(shipped.known ? { default: shipped.value ?? null } : {}),
    value: value ?? null, source, cli,
  };
}

/** The shipped default of a key, a map's member included (`notify.needs-you`). */
function shippedOf(key: string): { known: boolean; value?: unknown } {
  const dot = key.indexOf('.');
  if (dot < 0) return prefDefault(key);
  const table = prefDefault(key.slice(0, dot)).value;
  const member = key.slice(dot + 1);
  return isRecord(table) && member in table ? { known: true, value: table[member] } : { known: false };
}

/** The value a key holds in the loaded preferences, a map's member included. */
function valueOf(prefs: Record<string, unknown>, key: string): unknown {
  const dot = key.indexOf('.');
  if (dot < 0) return prefs[key];
  const map = prefs[key.slice(0, dot)];
  return isRecord(map) ? map[key.slice(dot + 1)] : undefined;
}

/** What a `secret` row answers for a value that is set. */
export const WITHHELD = '[withheld]';

/**
 * A `secret` key's value, said without the secret (`PrefMeta.secret`): a
 * webhook as its origin and a masked tail — what Settings ▸ Notifications
 * lists one by (`webhooks.ts` `maskUrl`), since the URL is the whole
 * authorisation to post to its channel — and anything else only as set. The
 * console's profile view says the notify command the same way (a boolean).
 */
export function withheld(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (key === 'webhooks' && Array.isArray(value)) {
    return value.map((hook) => {
      const entry = isRecord(hook) ? hook : {};
      return {
        ...maskUrl(typeof entry.url === 'string' ? entry.url : ''),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(Array.isArray(entry.categories) ? { categories: entry.categories } : {}),
      };
    });
  }
  return WITHHELD;
}

/** The machine profile's rows: no page writes one, and only Pro has the verbs that do. */
function profileRows(instance: Instance): PrefsSchemaRow[] {
  const machine = fleetProfile() as unknown as Record<string, unknown> & { instances: Record<string, { autostart?: unknown }> };
  const own = profileFor(instance.id) as unknown as Record<string, unknown> & { sources: Record<string, string> };
  const shipped: Record<string, unknown> = {
    maxSessions: null, heapMb: DEFAULT_HEAP_MB, heapSnapshotOnNearLimit: false, autostart: 'true',
  };
  return Object.entries(PROFILE_META).map(([key, meta]) => {
    let cli: string | null = null;
    const known = Object.prototype.hasOwnProperty.call(shipped, key);
    const fallback = known ? { known, value: shipped[key] } : { known };
    if (key === 'autostart') {
      const set = machine.instances?.[instance.id]?.autostart !== undefined;
      return row(`profile.${key}`, meta, fallback, String(readAutostart(instance.id)), set ? 'profile' : 'default', cli);
    }
    const held = own.sources?.[key] ? own[key] : machine[key];
    const source: PrefSource = own.sources?.[key] || machine[key] !== undefined ? 'profile' : 'default';
    return row(`profile.${key}`, meta, fallback, meta.secret ? withheld(key, held) : held, source, cli);
  });
}

export function prefsSchema(instance: Instance = INSTANCE): PrefsSchema {
  const prefs = loadPrefs(instance) as unknown as Record<string, unknown>;
  const sources = prefSources(instance);
  return {
    files: { instance: instancePrefsFile(instance), config: sharedPrefsFile(), profile: fleetProfilePath() },
    rows: [
      ...Object.entries(PREF_META).map(([key, meta]) =>
        row(key, meta, shippedOf(key), valueOf(prefs, key), sources[key] ?? 'default', meta.cli ?? null)),
      ...profileRows(instance),
    ],
  };
}
