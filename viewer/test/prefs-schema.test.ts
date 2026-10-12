/**
 * The settings schema (quiet-console phase 25, §Architecture 5; exit criteria
 * 2 and 3). `shared/prefs-model.js` says what every preference IS — its group,
 * type, words, unit and description, and whether a page can write it — and
 * `GET /api/prefs/schema` answers one row per key with its shipped default, the
 * value the console runs with, where that value came from and the line that
 * changes it from a terminal.
 *
 * A table like that is a claim, so this file holds it to the server:
 *
 *   - its keys are exactly the stored type's: every key with a shipped default
 *     (`DEFAULT_PREFS`, each map spread into its members — `notify.<category>`
 *     and `retention.<key>`) and every key without one (`Prefs`, read off
 *     `server/config.ts`);
 *   - `writable` is exactly what `savePreferences` reads (`patch.<key>`), and a
 *     key no page writes names the line that does — every retention member is a
 *     page's to write since phase 23;
 *   - `PROFILE_META` is exactly the machine profile's settable fields
 *     (`PROFILE_MACHINE_KEYS`) and `autostart`;
 *   - the route's `value` is `loadPrefs()`'s and its `source` the file that
 *     holds it — `default · config · instance · migrated · profile`;
 *   - and `POST /api/prefs {key: null}` takes a key back: out of the file, the
 *     next read the default, however many saves follow.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bareService, call, wire } from './thin-read-harness.ts';
import {
  DEFAULT_PREF_KEYS, INSTANCE, instancePrefsFile, loadPrefs, prefDefault, sharedPrefsFile, type Instance,
} from '../server/config.ts';
import { WITHHELD, prefsSchema, type PrefsSchemaRow } from '../server/prefs-schema.ts';
import { RETENTION_DEFAULTS } from '../server/retention-policy.ts';
import { PREF_GROUPS, PREF_META, PREF_SOURCES, PREF_TYPES, PREF_UNITS, PROFILE_META } from '../shared/prefs-model.js';
import { PROFILE_MACHINE_KEYS, fleetProfilePath, instanceId } from '../shared/instances.mjs';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = sharedPrefsFile();
const sorted = (list: Iterable<string>): string[] => [...list].sort();
const headOf = (key: string): string => key.split('.')[0]!;

/** The keys of `server/config.ts`'s `Prefs` type — `  key:` / `  key?:` at the block's own indent. */
function storedTypeKeys(): string[] {
  const text = readFileSync(join(VIEWER, 'server', 'config.ts'), 'utf8');
  const lines = text.slice(text.indexOf('export type Prefs = {')).split('\n');
  const out: string[] = [];
  for (let i = 1; i < lines.length && !/^\};?\s*$/.test(lines[i]!); i += 1) {
    const m = /^ {2}(\w+)\??:/.exec(lines[i]!);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** `savePreferences`' own body — the one writer a page's settings reach. */
function writerBody(): string {
  const text = readFileSync(join(VIEWER, 'server', 'service.ts'), 'utf8');
  const start = text.indexOf('  savePreferences(input');
  assert.ok(start > 0, 'savePreferences is where it was — teach writerBody where it went');
  return text.slice(start, text.indexOf('\n  }\n', start));
}

const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

function writeJson(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Start from nothing: no person's file, no machine profile. */
function clean(): void {
  rmSync(CONFIG, { force: true });
  rmSync(fleetProfilePath(), { force: true });
}

const rowsOf = (schema: { rows: PrefsSchemaRow[] }): Map<string, PrefsSchemaRow> =>
  new Map(schema.rows.map((row) => [row.key, row]));

/** A map's member, or a flat key, of the loaded preferences. */
function loaded(prefs: Record<string, unknown>, key: string): unknown {
  const [head, member] = key.split('.');
  const value = prefs[head!];
  return member === undefined ? value : (value as Record<string, unknown> | undefined)?.[member];
}

/* ------------------------------------------------------------------ *
 * The table against the server
 * ------------------------------------------------------------------ */

test('PREF_META\'s keys are the stored type\'s: DEFAULT_PREFS with notify.<category> and retention.<key> spread, and every key with no default', () => {
  const meta = Object.keys(PREF_META);
  const notify = Object.keys(prefDefault('notify').value as Record<string, unknown>);
  assert.ok(notify.length >= 15, `only ${notify.length} notify categories — the catalogue is not read`);
  const withDefault = [
    ...DEFAULT_PREF_KEYS.filter((key) => key !== 'notify' && key !== 'retention'),
    ...notify.map((category) => `notify.${category}`),
    ...Object.keys(RETENTION_DEFAULTS).map((key) => `retention.${key}`),
  ];
  assert.deepEqual(
    sorted(meta.filter((key) => DEFAULT_PREF_KEYS.includes(headOf(key)))),
    sorted(withDefault),
    'every key with a shipped default has exactly one row, a map one per member',
  );
  const stored = storedTypeKeys();
  assert.ok(stored.length > 60, `only ${stored.length} Prefs keys parsed — teach storedTypeKeys`);
  assert.deepEqual(
    sorted(meta.filter((key) => !DEFAULT_PREF_KEYS.includes(headOf(key)))),
    sorted(stored.filter((key) => !DEFAULT_PREF_KEYS.includes(key))),
    'and every stored key with no shipped default has one too',
  );
  assert.deepEqual(sorted(new Set(meta.map(headOf))), sorted(stored), 'together: the stored type, whole');
});

test('writable is exactly what savePreferences reads — and a key no page writes names the line that does', () => {
  const body = writerBody();
  for (const [key, meta] of Object.entries(PREF_META)) {
    const read = new RegExp(`\\bpatch\\.${headOf(key)}\\b`).test(body);
    assert.equal(meta.writable, read, `${key} is ${meta.writable ? '' : 'not '}writable and savePreferences ${read ? 'reads' : 'never reads'} patch.${headOf(key)}`);
    if (!meta.writable) {
      assert.ok(meta.cli, `${key} no page writes: its row names the line that does`);
    }
  }
});

test('every row speaks the shared words: a group, a type, a unit for a number, words for a word', () => {
  assert.deepEqual([...PREF_SOURCES], ['default', 'config', 'instance', 'migrated', 'profile']);
  for (const [key, meta] of [...Object.entries(PREF_META), ...Object.entries(PROFILE_META).map(([k, m]) => [`profile.${k}`, m] as const)]) {
    assert.ok(PREF_GROUPS.includes(meta.group), `${key}: ${meta.group}`);
    assert.ok(PREF_TYPES.includes(meta.type), `${key}: ${meta.type}`);
    assert.equal(meta.type === 'word', Array.isArray(meta.words) && meta.words.length > 0, `${key}: a word row lists its words`);
    if (meta.type === 'number') assert.ok(meta.unit && PREF_UNITS.includes(meta.unit), `${key}: a number says its unit`);
    else assert.equal(meta.unit, undefined, `${key}: only a number has a unit`);
    assert.match(meta.description, /^[A-Z].*\.$/, `${key}: a sentence`);
  }
});

test('PROFILE_META is the machine profile\'s settable fields and autostart — none of them a page\'s to write', () => {
  assert.deepEqual(Object.keys(PROFILE_META), [...PROFILE_MACHINE_KEYS, 'autostart']);
  for (const [key, meta] of Object.entries(PROFILE_META)) {
    assert.equal(meta.writable, false, key);
    assert.equal(meta.group, 'profile', key);
  }
});

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

test('GET /api/prefs/schema answers with no source directory open: one row per key, its value loadPrefs\' own', async () => {
  clean();
  writeJson(CONFIG, { theme: 'dark', ladderPerPhaseRungs: 5, notify: { 'needs-you': false } });
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', '/api/prefs/schema');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.files, {
      instance: instancePrefsFile(INSTANCE), config: CONFIG, profile: fleetProfilePath(),
    });
    const rows = out.body.rows as PrefsSchemaRow[];
    assert.deepEqual(
      rows.map((row) => row.key),
      [...Object.keys(PREF_META), ...Object.keys(PROFILE_META).map((key) => `profile.${key}`)],
      'every key once, in the table\'s order',
    );
    const prefs = loadPrefs() as unknown as Record<string, unknown>;
    for (const row of rows) {
      if (row.key.startsWith('profile.')) continue;
      const meta = PREF_META[row.key]!;
      assert.deepEqual(row.value, wire(loaded(prefs, row.key) ?? null), `${row.key}: the value the console runs with`);
      assert.equal(row.writable, meta.writable, row.key);
      assert.equal(row.cli, meta.cli ?? null, row.key);
      assert.equal(row.description, meta.description, row.key);
      const [head, member] = row.key.split('.');
      const shipped = prefDefault(head!);
      if (!shipped.known) assert.ok(!('default' in row), `${row.key} has no shipped default and says none`);
      else {
        const value = member === undefined ? shipped.value : (shipped.value as Record<string, unknown>)[member!];
        assert.deepEqual(row.default, wire(value ?? null), `${row.key}: its shipped default`);
      }
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    assert.deepEqual(
      ['theme', 'ladderPerPhaseRungs', 'notify.needs-you', 'notify.gate', 'qaByDefault'].map((key) => [byKey.get(key)?.value, byKey.get(key)?.source]),
      [['dark', 'config'], [5, 'config'], [false, 'config'], [true, 'default'], [false, 'default']],
    );
  } finally {
    svc.close();
    clean();
  }
});

test('the source is the file that holds a value — or `migrated`, when the loader reads it from an older spelling', () => {
  clean();
  // A config from before 3.5.0: resumeAtBoot a boolean, settle never written but implied.
  writeJson(CONFIG, { resumeAtBoot: true, openPrOnComplete: false, sort: 'name' });
  const rows = rowsOf(prefsSchema());
  const prefs = loadPrefs() as unknown as Record<string, unknown>;
  assert.equal(rows.get('resumeAtBoot')?.source, 'migrated', 'a boolean resumeAtBoot is read as a word');
  assert.equal(rows.get('resumeAtBoot')?.value, prefs.resumeAtBoot);
  assert.equal(rows.get('settle')?.source, 'migrated', 'openPrOnComplete: false is read as settle keep');
  assert.equal(rows.get('settle')?.value, prefs.settle);
  assert.equal(rows.get('openPrOnComplete')?.source, 'config');
  assert.equal(rows.get('sort')?.source, 'config');
  assert.equal(rows.get('gitMode')?.source, 'default');
  clean();
});

test('a console of its own: its file is `instance`, the person-wide keys stay `config` — and before its first save it reads the person\'s file whole', () => {
  clean();
  const root = '/tmp/p25-schema-project';
  const own: Instance = { id: instanceId(root), name: 'p25-schema', root, default: false, pinned: true };
  writeJson(CONFIG, { theme: 'light', ladderPerPhaseRungs: 5 });
  try {
    const before = rowsOf(prefsSchema(own));
    assert.deepEqual([before.get('ladderPerPhaseRungs')?.value, before.get('ladderPerPhaseRungs')?.source], [5, 'config'], 'no file of its own yet');

    writeJson(instancePrefsFile(own), { ladderPerPhaseRungs: 7, theme: 'dark' });
    const schema = prefsSchema(own);
    assert.equal(schema.files.instance, instancePrefsFile(own));
    const rows = rowsOf(schema);
    assert.deepEqual([rows.get('ladderPerPhaseRungs')?.value, rows.get('ladderPerPhaseRungs')?.source], [7, 'instance']);
    assert.deepEqual([rows.get('theme')?.value, rows.get('theme')?.source], ['light', 'config'], 'the person\'s keys follow the person');
    assert.equal(rows.get('mcpPolicy')?.source, 'default');
    assert.deepEqual(rows.get('ladderPerPhaseRungs')?.value, loadPrefs(own).ladderPerPhaseRungs);
  } finally {
    rmSync(instancePrefsFile(own), { force: true });
    clean();
  }
});

test('the machine profile\'s rows: set in fleet.json is `profile`, read-only, and the line that changes it', () => {
  clean();
  writeJson(fleetProfilePath(), {
    version: 1, heapMb: 4096, maxSessions: 3, instances: { [INSTANCE.id]: { autostart: false } },
  });
  try {
    const rows = rowsOf(prefsSchema());
    assert.deepEqual([rows.get('profile.heapMb')?.value, rows.get('profile.heapMb')?.source], [4096, 'profile']);
    assert.equal(rows.get('profile.heapMb')?.default, 6144);
    assert.deepEqual([rows.get('profile.maxSessions')?.value, rows.get('profile.maxSessions')?.source], [3, 'profile']);
    assert.deepEqual([rows.get('profile.hookScript')?.value, rows.get('profile.hookScript')?.source], [null, 'default']);
    assert.deepEqual([rows.get('profile.autostart')?.value, rows.get('profile.autostart')?.source], ['false', 'profile']);
    for (const key of Object.keys(PROFILE_META)) assert.equal(rows.get(`profile.${key}`)?.writable, false, key);
    let cli: string | null = null;
    assert.equal(rows.get('profile.heapMb')?.cli, cli, 'the free CLI has no profile verb: there, the file is edited by hand');
  } finally {
    clean();
  }
});

test('a credential is never served: a webhook is its origin and a masked tail, the notify command only that it is set', async () => {
  clean();
  const token = 'p25TokenNeverServed0042';
  writeJson(fleetProfilePath(), {
    version: 1,
    notifyCommand: `curl -H 'Authorization: Bearer ${token}' https://relay.example/notify`,
    webhooks: [{ url: `https://hooks.example.com/services/T000/B000/${token}`, name: 'team', categories: ['halted'] }],
  });
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', '/api/prefs/schema');
    assert.equal(out.status, 200);
    assert.ok(!JSON.stringify(out.body).includes(token), 'the token appears nowhere in the answer');
    const rows = rowsOf(out.body as { rows: PrefsSchemaRow[] });
    assert.deepEqual(rows.get('profile.webhooks')?.value, [
      { origin: 'https://hooks.example.com', tail: `…${token.slice(-6)}`, name: 'team', categories: ['halted'] },
    ], 'what Settings ▸ Notifications lists a webhook by');
    assert.equal(rows.get('profile.notifyCommand')?.value, WITHHELD);
    assert.equal(rows.get('profile.notifyCommand')?.source, 'profile', 'where it is set is still said');
    assert.deepEqual(
      [...rows.values()].filter((row) => row.secret).map((row) => row.key),
      ['profile.notifyCommand', 'profile.webhooks'],
      'the two rows that may carry a credential say so',
    );
  } finally {
    svc.close();
    clean();
  }
  // Unset, a secret row is null like any other.
  const unset = rowsOf(prefsSchema());
  assert.equal(unset.get('profile.webhooks')?.value, null);
  assert.equal(unset.get('profile.notifyCommand')?.value, null);
});

/* ------------------------------------------------------------------ *
 * The reset
 * ------------------------------------------------------------------ */

test('POST /api/prefs {key: null} takes a key out of the file — the next read is the default, however many saves follow', async () => {
  clean();
  writeJson(CONFIG, {});
  const svc = await bareService();
  try {
    const post = async (body: unknown) => {
      const out = await call(svc, 'POST', '/api/prefs', body);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return out.body as Record<string, unknown>;
    };
    const source = async (key: string) => {
      const out = await call(svc, 'GET', '/api/prefs/schema');
      const row = (out.body.rows as PrefsSchemaRow[]).find((r) => r.key === key)!;
      return [row.value, row.source];
    };

    await post({ ladderPerPhaseRungs: 6 });
    assert.equal(json(CONFIG).ladderPerPhaseRungs, 6);
    assert.deepEqual(await source('ladderPerPhaseRungs'), [6, 'config']);
    assert.equal((await post({ ladderPerPhaseRungs: null })).ladderPerPhaseRungs, 3);
    assert.ok(!('ladderPerPhaseRungs' in json(CONFIG)), 'the key left the file');
    assert.equal(loadPrefs().ladderPerPhaseRungs, 3, 'and the next read is the shipped default');
    assert.deepEqual(await source('ladderPerPhaseRungs'), [3, 'default']);
    await post({ qaByDefault: true });
    assert.ok(!('ladderPerPhaseRungs' in json(CONFIG)), 'a later save does not write it back');
    assert.equal(json(CONFIG).qaByDefault, true);

    // One member of a map.
    await post({ notify: { 'needs-you': false, gate: false } });
    assert.deepEqual(json(CONFIG).notify, { 'needs-you': false, gate: false });
    await post({ 'notify.needs-you': null });
    assert.deepEqual(json(CONFIG).notify, { gate: false }, 'the one category left the file');
    assert.equal(loadPrefs().notify['needs-you'], (prefDefault('notify').value as Record<string, boolean>)['needs-you']);
    assert.deepEqual(await source('notify.needs-you'), [true, 'default']);

    // A key with no shipped default goes back to unset.
    await post({ model: 'claude-opus-5-5' });
    assert.equal(json(CONFIG).model, 'claude-opus-5-5');
    await post({ model: null });
    assert.ok(!('model' in json(CONFIG)));
    assert.equal(loadPrefs().model, undefined);

    // A value an operator stored at its default keeps its place.
    writeJson(CONFIG, { repoGuard: true });
    const kept = await bareService();
    try {
      await call(kept, 'POST', '/api/prefs', { worktreeCopyEnv: true });
      assert.equal(json(CONFIG).repoGuard, true, 'a write about one setting never drops another the file held');
      assert.ok(!('ladderPerRunRungs' in json(CONFIG)), 'and never adds one at its default');
    } finally {
      kept.close();
    }
  } finally {
    svc.close();
    clean();
  }
});

test('POST /api/prefs {retention} stores each member within sanitiseRetention\'s floors — one that fails is dropped, the stored value kept (quiet-console phase 23)', async () => {
  clean();
  writeJson(CONFIG, {});
  const svc = await bareService();
  try {
    const post = async (body: unknown) => {
      const out = await call(svc, 'POST', '/api/prefs', body);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return out.body as { retention: Record<string, number> };
    };
    const MB = 1024 * 1024;

    // Every member is a page's to write now: the schema says so, and a save lands.
    for (const key of Object.keys(RETENTION_DEFAULTS)) assert.equal(PREF_META[`retention.${key}`]!.writable, true, key);
    const saved = await post({ retention: { runRetainDays: 7, runsMaxBytes: 512 * MB, crashRetainDays: 3 } });
    assert.equal(saved.retention.runRetainDays, 7);
    assert.deepEqual(json(CONFIG).retention, { runRetainDays: 7, runsMaxBytes: 512 * MB, crashRetainDays: 3 });
    assert.equal(loadPrefs().retention.crashRetainDays, 3, 'the sweep reads the file, so the next one uses it');

    // The floors: zero, a negative, a string, NaN and an unknown key are dropped — never defaulted.
    const floored = await post({
      retention: { runRetainDays: 0, runsMaxBytes: -1, taskInboxDays: '9', outcomeInboxMax: Number.NaN, nope: 4 },
    });
    assert.equal(floored.retention.runRetainDays, 7, 'a zero cap means delete everything — refused, the 7 kept');
    assert.equal(floored.retention.runsMaxBytes, 512 * MB);
    assert.equal(floored.retention.taskInboxDays, RETENTION_DEFAULTS.taskInboxDays);
    assert.ok(!('nope' in json(CONFIG).retention));

    // runRetainMin is the one member where zero is an answer: keep no run past its age.
    assert.equal((await post({ retention: { runRetainMin: 0 } })).retention.runRetainMin, 0);

    // A trim's tail stays under the size that triggers it, as the loader keeps it.
    const trimmed = await post({ retention: { supervisorLogMaxBytes: 4 * MB, supervisorLogKeepBytes: 8 * MB } });
    assert.equal(trimmed.retention.supervisorLogMaxBytes, 4 * MB);
    assert.equal(trimmed.retention.supervisorLogKeepBytes, MB);

    // One member back to its shipped number: out of the file, the rest kept.
    const back = await post({ 'retention.runRetainDays': null });
    assert.equal(back.retention.runRetainDays, RETENTION_DEFAULTS.runRetainDays);
    assert.ok(!('runRetainDays' in json(CONFIG).retention), 'the member left the file');
    assert.equal(json(CONFIG).retention.crashRetainDays, 3, 'and the others stayed');
  } finally {
    svc.close();
    clean();
  }
});
