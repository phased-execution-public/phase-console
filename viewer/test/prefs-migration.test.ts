/**
 * Thirty-nine flat automation keys, and the one object they become.
 *
 * The namespace they grew into is R32/R38 in the design register: five attempt
 * budgets in three units, one of which (`autoRecover.attempts`) its own comment
 * called vestigial; four separate auto-continue switches; seven `stall*`
 * numbers; and five git knobs whose invalid combinations degraded in silence.
 * `automation` groups them, and this file is the proof that grouping them loses
 * nothing.
 *
 * The claims, in the order exit criterion 2 states them:
 *
 * 1. every flat key round-trips through the object and back;
 * 2. a config with only flat keys yields the object;
 * 3. a config with both prefers the object;
 * 4. unknown keys survive.
 *
 * ⚠️ **The parity test in `prefs.test.ts` cannot see string-valued drift**, and
 * that is not a hypothetical: it flips a boolean and increments a number, but a
 * string it "flips" to itself, so `same(flipped, after)` is trivially true for
 * every word-valued key. That blind spot is how `settle` came to be in the
 * loader and NOT in the writer — a setting that survives a restart and can
 * never be changed, which is the exact bug that test is named after. It is
 * fixed here, and asserted here, because the migration is what surfaced it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  sanitiseAutomation,
  toAutomation,
  fromAutomation,
  migrateAutomation,
  migrateReminderQuiet,
  instancePrefsFile,
  withAutomation,
  type Prefs,
} from '../server/config.ts';

/** The coerced flat shape with every key present — the round-trip's subject. */
const FLAT = sanitiseAutomation({}) as Partial<Prefs>;

test('every automation key the loader coerces has a home in the object', () => {
  const object = toAutomation(FLAT);
  const back = fromAutomation(object);
  const homeless = Object.keys(FLAT).filter((key) => !(key in back));
  assert.deepEqual(
    homeless,
    [],
    'a key with no row in AUTOMATION_MAP is a setting the object silently drops',
  );
});

test('the round-trip is lossless for all forty', () => {
  const back = fromAutomation(toAutomation(FLAT));
  assert.deepEqual(back, FLAT, 'flat → object → flat changed a value');
  // …and it is stable, so a config re-saved twice does not drift.
  assert.deepEqual(fromAutomation(toAutomation(back)), FLAT);
});

test('the groups are the ones the plan named, and nothing is stranded', () => {
  const object = toAutomation(FLAT);
  // `check` is the check's own group (control-tower phase 134, #211).
  const groups = ['accounts', 'caps', 'check', 'defaults', 'git', 'mcp', 'policy', 'recover', 'schedule', 'stall', 'watch'];
  assert.deepEqual(Object.keys(object).sort(), groups);
  // The schedule is the one group that IS its value rather than a bag of
  // scalars — it is coerced by `sanitiseSchedule` beside the rules it has to
  // agree with, and splitting it would put its shape in two places.
  assert.deepEqual(object.schedule, {
    enabled: false,
    windows: [],
    quiet: [],
    cron: [],
    cronMinutes: 60,
  });
});

test('a config with only flat keys yields the object', () => {
  const legacy = { ladderPerPhaseRungs: 9, stallSilentMs: 1234, gitMode: 'new-branch' as const };
  const object = toAutomation(sanitiseAutomation(legacy) as Partial<Prefs>);
  assert.equal(object.caps.perPhaseRungs, 9);
  assert.equal(object.stall.silentMs, 1234);
  assert.equal(object.git.mode, 'new-branch');
});

test('a config with BOTH prefers the object', () => {
  const both = {
    ladderPerPhaseRungs: 3,
    gitMode: 'default-branch' as const,
    automation: { caps: { perPhaseRungs: 11 }, git: { mode: 'new-branch' } },
  };
  const merged = migrateAutomation(both);
  assert.equal(merged.ladderPerPhaseRungs, 11, 'the object is the shape an edit lands in');
  assert.equal(merged.gitMode, 'new-branch');
});

test('a flat key the object says nothing about is kept, not dropped', () => {
  // The half-migrated case: an operator edits one group in a 3.4 config. The
  // keys the object is silent about must keep the values that config had, or
  // upgrading silently resets settings nobody touched.
  const merged = migrateAutomation({
    stallSilentMs: 999,
    automation: { caps: { perPhaseRungs: 11 } },
  });
  assert.equal(merged.stallSilentMs, 999);
  assert.equal(merged.ladderPerPhaseRungs, 11);
});

test('unknown keys survive the migration', () => {
  // A setting a LATER build knows and this one does not. Dropping it would make
  // downgrading destructive, which is a thing operators do to bisect.
  const merged = migrateAutomation({
    theme: 'dark',
    somethingFromTheFuture: 42,
    automation: { caps: { perPhaseRungs: 4 }, unknownGroup: { x: 1 } },
  } as never) as Record<string, unknown>;
  assert.equal(merged.somethingFromTheFuture, 42);
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.ladderPerPhaseRungs, 4);
});

test('a malformed automation object is ignored, never thrown on', () => {
  // config.json is hand-editable, so every shape here is reachable.
  for (const automation of [null, 42, 'automation', [], { git: 'not-a-bag' }, { git: null }]) {
    const merged = migrateAutomation({ gitMode: 'new-branch', automation } as never);
    assert.equal(merged.gitMode, 'new-branch', `${JSON.stringify(automation)} lost the flat key`);
  }
});

test('the object still goes through the SAME coercion table', () => {
  // The rule `sanitiseAutomation` exists for — "a typo in config.json must
  // never mint branches" — has to hold whichever shape the typo arrives in.
  // Coercing only the flat path would make the object a way around it.
  const viaObject = sanitiseAutomation(
    migrateAutomation({ automation: { git: { mode: 'new-brunch' } } } as never),
  );
  assert.equal(viaObject.gitMode, 'default-branch');

  const viaFlat = sanitiseAutomation({ gitMode: 'new-brunch' } as never);
  assert.equal(viaFlat.gitMode, 'default-branch');

  // Same for the other direction's exact-word rule.
  assert.equal(
    sanitiseAutomation(migrateAutomation({ automation: { mcp: { policy: 'REQUIRE' } } } as never))
      .mcpPolicy,
    'continue',
  );
});

/* ------------------------------------------------------------------ *
 * The WRITE door — QA round 2's M3
 * ------------------------------------------------------------------ */

test('POST /api/prefs accepts the automation object, and does not merely say 200', async () => {
  // 🔴 It answered 200 and wrote NOTHING. Every branch in `savePreferences`
  // reads `patch.<flatKey>`, and an object patch has none of them, so the
  // allowlist picked nothing, `savePrefs` wrote the unchanged preferences, and
  // the door reported success. Exit criterion 2's "accepts either" was false
  // for a whole release — and silently, which is the part that matters: a
  // settings page sending the new shape would have looked like it worked.
  const { Service } = await import('../server/service.ts');
  const { join } = await import('node:path');
  const { SKILL_DIR } = await import('../server/config.ts');

  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  try {
    const before = svc.prefs.ladderPerRunUsd;
    const after = svc.savePreferences({
      automation: { caps: { perRunUsd: (before ?? 400) + 7 } },
    } as never);
    assert.equal(after.ladderPerRunUsd, (before ?? 400) + 7, 'the object patch was dropped');

    // Both shapes in one patch: the FLAT key wins, which is the opposite of the
    // loader's precedence and deliberate — on disk the object speaks for the
    // file, but in a patch a flat key is what the settings page sends for the
    // one control the operator just touched.
    const both = svc.savePreferences({
      ladderPerRunUsd: 111,
      automation: { caps: { perRunUsd: 222 } },
    } as never);
    assert.equal(both.ladderPerRunUsd, 111);

    // …and the object goes through the SAME coercion table, so it cannot be a
    // second door with its own rules.
    assert.equal(
      svc.savePreferences({ automation: { git: { mode: 'new-brunch' } } } as never).gitMode,
      'default-branch',
    );
  } finally {
    svc.close();
  }
});

test('the published object never disagrees with the flat keys beside it', () => {
  // 🔴 After every successful write the API served two values for one setting:
  // `savePreferences` merged the flat keys it picked and left `automation`
  // exactly as `loadPrefs` found it, so `/api/state` reported
  // `ladderPerRunUsd: 27` beside `automation.caps.perRunUsd: 25` — while
  // `config.json` correctly held 27 in both, because the WRITE re-derives. It
  // never self-healed, and the object is the shape everything after 3.6.0 reads.
  //
  // The rule this pins: the flat keys are the truth and the object is a view of
  // them, so anything that builds or changes a `Prefs` derives it.
  const flat = { ...(sanitiseAutomation({}) as Partial<Prefs>), ladderPerRunUsd: 27 } as Prefs;
  const published = withAutomation(flat) as Prefs & { automation: Record<string, Record<string, unknown>> };
  assert.equal(published.automation.caps.perRunUsd, 27, 'the view disagrees with the value');

  // …and the round trip through the view is still lossless, so deriving it can
  // never quietly drop a key.
  assert.deepEqual(
    fromAutomation(published.automation),
    fromAutomation(toAutomation(flat)),
    'the derived view lost something',
  );
});

/* ------------------------------------------------------------------ *
 * ONE quiet-hours setting (control-tower phase 138, #215)
 *
 * The reminders had quiet hours of their own (`reminderQuiet`, phase 43) and
 * every push device had its own — two settings for one question, which could
 * disagree. The device's is the one: `reminderQuiet` moves onto every device
 * that has no window of its own, and is dropped.
 * ------------------------------------------------------------------ */

test('QH-1: reminderQuiet moves onto every device with no window of its own; a device with one keeps it; the key is dropped', () => {
  const plan = migrateReminderQuiet(
    { reminderQuiet: { start: '22:30', end: '07:15' }, theme: 'dark' },
    [{ id: 'phone' }, { id: 'laptop', quiet: { start: '23:00', end: '06:00', allowUrgent: false } }],
  );
  assert.deepEqual(plan, {
    quiet: { start: '22:30', end: '07:15', allowUrgent: true },
    devices: ['phone'],
    kept: ['laptop'],
    prefs: { theme: 'dark' },
  }, 'urgent still gets through, as a window opened on a device does; nothing else in the preferences moves');
});

test('QH-2: idempotent — with no key there is nothing to do, however many times it runs', () => {
  assert.equal(migrateReminderQuiet({ theme: 'dark' }, [{ id: 'phone' }]), null);
  const once = migrateReminderQuiet({ reminderQuiet: { start: '22:00', end: '08:00' } }, [{ id: 'phone' }])!;
  // The second run reads what the first one wrote: the key gone, the device holding the window.
  assert.equal(migrateReminderQuiet(once.prefs, [{ id: 'phone', quiet: once.quiet }]), null);
});

test('QH-3: a malformed window is dropped, never half-honoured — quiet hours nobody asked for must not exist', () => {
  for (const junk of [{ start: '25:00', end: '07:00' }, { start: '22:00', end: '22:00' }, { start: '22:00' }, 'night', 42, null]) {
    const plan = migrateReminderQuiet({ reminderQuiet: junk } as never, [{ id: 'phone' }]);
    assert.deepEqual(plan, { quiet: null, devices: [], kept: [], prefs: {} }, `${JSON.stringify(junk)} moved somewhere`);
  }
});

test('QH-4: with no device subscribed there is nothing to be quiet on — the key is still dropped', () => {
  assert.deepEqual(
    migrateReminderQuiet({ reminderQuiet: { start: '22:00', end: '08:00' } }, []),
    { quiet: { start: '22:00', end: '08:00', allowUrgent: true }, devices: [], kept: [], prefs: {} },
  );
});

test('QH-5: at boot the console moves it onto its devices and writes the config without it — and a second boot changes nothing', async () => {
  const { Push } = await import('../server/push/index.ts');
  const { Service } = await import('../server/service.ts');
  const { join } = await import('node:path');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const browser = () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    return {
      endpoint: `https://push.example.com/sub/qh5-${randomBytes(4).toString('hex')}`,
      keys: { p256dh: point.toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
  };
  // The register the console will load: one device with no window, one with its own.
  const register = new Push([]);
  for (const device of register.list()) register.unsubscribe(device.id);
  const phone = register.subscribe(browser(), undefined, 'phone') as { id: string };
  const laptop = register.subscribe(browser(), undefined, 'laptop') as { id: string };
  register.setQuiet(laptop.id, { start: '23:00', end: '06:00', allowUrgent: false });
  // A config written before phase 138.
  const file = instancePrefsFile();
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  writeFileSync(file, `${JSON.stringify({ ...before, reminderQuiet: { start: '22:00', end: '07:30' } }, null, 2)}\n`, 'utf8');

  const boot = () => new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const first = boot();
  try {
    const quietOf = (svc: InstanceType<typeof Service>, id: string) => svc.push.list().find((d) => d.id === id)?.quiet;
    assert.deepEqual(quietOf(first, phone.id), { start: '22:00', end: '07:30', allowUrgent: true }, 'the device with none took it');
    assert.deepEqual(quietOf(first, laptop.id), { start: '23:00', end: '06:00', allowUrgent: false }, 'the device with its own kept it');
    assert.ok(!('reminderQuiet' in (first as unknown as { prefs: object }).prefs), 'gone from the preferences in memory…');
    assert.ok(!('reminderQuiet' in (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)), '…and on disk');
  } finally { first.close(); }

  // The person changes the phone's window afterwards; a second boot must not undo it.
  const again = new Push([]);
  again.setQuiet(phone.id, { start: '21:00', end: '06:30', allowUrgent: true });
  const second = boot();
  try {
    assert.deepEqual(second.push.list().find((d) => d.id === phone.id)?.quiet, { start: '21:00', end: '06:30', allowUrgent: true });
  } finally {
    second.close();
    for (const device of second.push.list()) second.push.unsubscribe(device.id);
  }
});

test('a write through the real door leaves the two shapes agreeing', async () => {
  // The assertion above tests the helper; THIS one tests the door, which is
  // where the disagreement actually lived — and the difference matters, because
  // a helper nobody calls on the write path is exactly what the bug was.
  const { Service } = await import('../server/service.ts');
  const { join } = await import('node:path');
  const { SKILL_DIR } = await import('../server/config.ts');

  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  try {
    const next = (svc.prefs.ladderPerRunUsd ?? 400) + 13;
    const after = svc.savePreferences({ ladderPerRunUsd: next }) as Prefs & {
      automation?: Record<string, Record<string, unknown>>;
    };
    assert.equal(after.ladderPerRunUsd, next);
    assert.equal(
      after.automation?.caps?.perRunUsd,
      next,
      'the API published two values for one setting',
    );
    // And what the process keeps agrees with what it just served.
    assert.deepEqual(fromAutomation((svc.prefs as never as { automation: unknown }).automation).ladderPerRunUsd, next);
  } finally {
    svc.close();
  }
});
