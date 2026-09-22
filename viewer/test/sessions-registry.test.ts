/**
 * The session registry — who is in the repository right now, as the hook
 * reports it and as the scheduler, the classifier and the Pulse read it.
 *
 * Pinned: the payload contract (validation, caps, both field spellings), the
 * fold of events into a record (start, heartbeat, end, revival on resume,
 * out-of-order replay), the three-valued presence (ended by hook, ended by a
 * gone process, live, unknown after the window), correlation (strong by
 * `session=`, weak by owner+time — and only strong may ever mean debris), and
 * the registry itself (persist + reload, the inbox drained oldest-first and
 * emptied, junk deleted, pruning, views).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  SessionRegistry, HEARTBEAT_PERSIST_MS, LIVE_WINDOW_MS, RETAIN_ENDED_MS, RETAIN_SILENT_MS,
  applyEvent, correlate, kindOf, parseHookPayload, presenceOf, turnsOf, weaklyCorrelatable, WEAK_MIN_LIFETIME_MS,
  NOTIFICATION_IGNORED, TRANSCRIPT_GRACE_MS, WAIT_ANSWER_CAP_MS,
  INBOX_AGE_REFUSE_MS, INBOX_DEPTH_WATERMARK, INBOX_HISTORY_HORIZON_MS, TURNS_UNKNOWN_AFTER_EVENTS,
  peersSentence, turnsSourceOf, PEER_CLAIM_WINDOW_MS, claimWindowEnds,
} = await import('../server/sessions/registry.ts');
type HookPayload = import('../server/sessions/registry.ts').HookPayload;
type SessionRecord = import('../server/sessions/registry.ts').SessionRecord;
type RunLink = import('../server/sessions/registry.ts').RunLink;

const T0 = '2026-08-21T10:00:00.000Z';
const at = (plusMs: number): string => new Date(Date.parse(T0) + plusMs).toISOString();

function payload(over: Partial<HookPayload> & { event: HookPayload['event'] }): HookPayload {
  return { session_id: 's1', cwd: '/work/hub', ...over };
}

/* ---------------- the payload ---------------- */

test('parseHookPayload: accepts the hook\'s record, caps every string, reads both field spellings, rejects what is not a session event', () => {
  const ok = parseHookPayload({
    version: 1, session_id: 'abc-123', event: 'SessionStart', cwd: '/work/hub', transcript_path: '/t/a.jsonl',
    source: 'startup', owner: 'autopilot/ab12cd34', scope: 'web-app', user: 'sam', host: 'laptop', pid: 4242, root: '/work/hub',
    at: T0,
  });
  assert.deepEqual(ok, {
    session_id: 'abc-123', event: 'SessionStart', cwd: '/work/hub', transcript_path: '/t/a.jsonl',
    source: 'startup', owner: 'autopilot/ab12cd34', scope: 'web-app', user: 'sam', host: 'laptop', pid: 4242, root: '/work/hub', at: T0,
  });
  // The documented spelling of the event field.
  assert.equal(parseHookPayload({ session_id: 's', hook_event_name: 'Stop', cwd: '/x' })?.event, 'Stop');
  // Caps and sanitising.
  const long = parseHookPayload({ session_id: 's', event: 'Stop', cwd: '/x', reason: 'r'.repeat(500), source: 'a\nb' });
  assert.equal(long?.reason?.length, 64);
  assert.equal(long?.source, 'a b');
  // A bad pid or date is dropped, not rejected.
  const loose = parseHookPayload({ session_id: 's', event: 'Stop', cwd: '/x', pid: -3, at: 'yesterday' });
  assert.equal(loose?.pid, undefined);
  assert.equal(loose?.at, undefined);
  // Rejections.
  assert.equal(parseHookPayload(null), null);
  assert.equal(parseHookPayload('x'), null);
  assert.equal(parseHookPayload({ event: 'Stop', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 'has space', event: 'Stop', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'PreToolUse', cwd: '/x' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'Stop', cwd: 'relative' }), null);
  assert.equal(parseHookPayload({ session_id: 's', event: 'Stop' }), null);
});

test('kindOf: the owner vocabulary the locks use', () => {
  assert.equal(kindOf('autopilot/ab12cd34'), 'autopilot');
  assert.equal(kindOf('console/agent-1'), 'agent');
  assert.equal(kindOf('sam@laptop'), 'foreign');
  assert.equal(kindOf(undefined), 'foreign');
});

/* ---------------- the fold ---------------- */

test('applyEvent: start, heartbeat, end — and a resume revives an ended id', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', source: 'startup', user: 'sam', host: 'laptop', pid: 7, at: T0 }), T0);
  assert.deepEqual(started, {
    sessionId: 's1', kind: 'foreign', cwd: '/work/hub', user: 'sam', host: 'laptop', pid: 7,
    startedAt: T0, lastSeen: T0, source: 'startup', turns: 0, events: 1,
  });
  const beat = applyEvent(started, payload({ event: 'Stop', at: at(60_000) }), at(60_000));
  assert.equal(beat.turns, 1);
  assert.equal(beat.lastSeen, at(60_000));
  assert.equal(beat.startedAt, T0);
  const ended = applyEvent(beat, payload({ event: 'SessionEnd', reason: 'prompt_input_exit', at: at(120_000) }), at(120_000));
  assert.equal(ended.endedAt, at(120_000));
  assert.equal(ended.reason, 'prompt_input_exit');
  // REPORTED: the session's own SessionEnd, at the moment it gave (REG-9).
  assert.equal(ended.endedBy, 'hook');
  assert.equal(ended.endedDetectedAt, undefined);
  assert.equal(ended.events, 3, 'every applied hook event is counted');
  // `claude --resume s1`: SessionStart(source: resume) for the same id — live again.
  const revived = applyEvent(ended, payload({ event: 'SessionStart', source: 'resume', at: at(300_000) }), at(300_000));
  assert.equal(revived.endedAt, undefined);
  assert.equal(revived.reason, undefined);
  assert.equal(revived.endedBy, undefined, 'a revived record carries no end provenance');
  assert.equal(revived.source, 'resume');
  assert.equal(revived.startedAt, T0, 'the first start stays the start');
  // An owner arriving later re-kinds the record; facts absent from a payload are kept.
  const owned = applyEvent(revived, payload({ event: 'Stop', owner: 'autopilot/ab12cd34', at: at(360_000) }), at(360_000));
  assert.equal(owned.kind, 'autopilot');
  assert.equal(owned.user, 'sam');
});

test('applyEvent: an event older than the end it would undo (inbox replay out of order) does not revive', () => {
  const ended = applyEvent(
    applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0),
    payload({ event: 'SessionEnd', reason: 'other', at: at(100_000) }), at(100_000),
  );
  const late = applyEvent(ended, payload({ event: 'Stop', at: at(50_000) }), at(200_000));
  assert.equal(late.endedAt, at(100_000));
  assert.equal(late.turns, 1, 'the heartbeat still counts');
  assert.equal(late.lastSeen, at(100_000), 'lastSeen never moves backwards');
  // A payload with no `at` takes the receiver's clock.
  const noAt = applyEvent(undefined, payload({ event: 'SessionStart' }), at(1));
  assert.equal(noAt.startedAt, at(1));
});

/* ---------------- presence ---------------- */

test('presenceOf: ended by the hook, ended by a gone process, live, unknown past the window', () => {
  const live: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99 };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(live, now), 'live');
  assert.equal(presenceOf({ ...live, endedAt: at(10) }, now), 'ended');
  assert.equal(presenceOf(live, now, () => false), 'ended', 'a dead process is an ended session');
  assert.equal(presenceOf(live, now, () => true), 'live');
  assert.equal(presenceOf(live, now, () => { throw new Error('ps broke'); }), 'live', 'a probe that cannot answer never demotes');
  assert.equal(presenceOf(live, Date.parse(T0) + LIVE_WINDOW_MS + 1), 'unknown');
  assert.equal(presenceOf({ ...live, pid: undefined }, now, () => false), 'live', 'no pid, no process verdict');
});

/**
 * autopilot-2: the registry's DEFAULT probe, against the `ps` that broke it.
 *
 * Not `presenceOf` with an injected stub — the bug was never in `presenceOf`,
 * it was in the options the registry handed the real probe. It passed
 * `{ expect: CLAUDE_COMM }`, and `pid.ts` says in its own header that a
 * multi-column `ps` truncates `comm` to MAXCOMLEN (16), so a `claude` started
 * from a long nvm prefix reports `/home/dev/.nvm/v` and matches none of
 * /claude|node|bun/. `processState` then answered `gone` for a process that is
 * plainly alive, `presenceOf` mapped that to `ended`, and `ended` is the one
 * answer that makes a foreign lock debris: the scheduler drops it from the
 * blocking set and boarding shells `phase-lock.sh release --owner <holder>`
 * and starts a second session in the same working tree.
 *
 * So the probe is exercised end to end through a real `SessionRegistry` with
 * no `pidAlive` injected, which is the only way to test the thing that was
 * actually wrong.
 */
test('the registry probe never calls a live long-prefix `claude` ended (autopilot-2)', async () => {
  const { setPsReader, forgetPid } = await import('../server/pid.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-registry-comm-'));
  // A live session of ours, seen a moment ago: only the process verdict is in
  // question. `process.pid` certainly exists, so `kill(0)` succeeds and the
  // answer comes entirely from the `ps` row below.
  const restore = setPsReader((pid) => (pid === process.pid
    ? { stat: 'S', comm: '/home/dev/.nvm/v', lstart: 'Sat Aug 22 20:30:07 2026' }
    : null));
  try {
    forgetPid();
    const nowMs = Date.parse(T0) + 30_000;
    const reg = new SessionRegistry({ dir, now: () => new Date(nowMs) }).load();
    reg.ingest(payload({ event: 'SessionStart', session_id: 'long-prefix', pid: process.pid, cwd: '/work/hub' }));

    assert.equal(reg.presence('long-prefix'), 'live',
      'a truncated `comm` is a `ps` limitation, not a dead session');
    // The two readers that decide whether somebody else's claim is debris.
    assert.notEqual(reg.presenceOfLock({ session: 'long-prefix' }), 'ended',
      'and its lock is never debris — `ended` here is what force-releases it');

    // The death-detection this must not have cost: a pid that genuinely is not
    // there still ends the session and stamps `endedAt`, which is what `prune`
    // measures the 24-hour retention from.
    forgetPid();
    reg.ingest(payload({ event: 'SessionStart', session_id: 'really-gone', pid: 2_147_483_646, cwd: '/work/hub' }));
    assert.equal(reg.presence('really-gone'), 'ended', 'a pid that is truly absent is still a death');
  } finally {
    setPsReader(restore);
    forgetPid();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- correlation ---------------- */

test('correlate: strong by session=, weak by <user>@<host> within the session\'s life — newest claim wins', () => {
  const rec: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', user: 'sam', host: 'laptop', startedAt: T0, lastSeen: at(600_000), turns: 3 };
  const now = Date.parse(T0) + 700_000;
  const t = (ms: number) => Date.parse(T0) + ms;
  assert.deepEqual(
    correlate(rec, [
      { slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) },
      { slug: 'beta', phase: 5, owner: 'other', session: 's1', claimedAt: t(20_000) },
    ], now),
    { slug: 'beta', phase: 5, strong: true },
  );
  assert.deepEqual(
    correlate(rec, [
      { slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) },
      { slug: 'alpha', phase: 3, owner: 'sam@laptop', claimedAt: t(30_000) },
    ], now),
    { slug: 'alpha', phase: 3, strong: false },
  );
  // A claim from long before the session, or after it ended, is not its own.
  assert.equal(correlate(rec, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(-3_600_000) }], now), undefined);
  assert.equal(correlate({ ...rec, endedAt: at(100_000) }, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(200_000) }], now), undefined);
  // A lock that names ANOTHER session is never this one's, whatever the owner says.
  assert.equal(correlate(rec, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', session: 's2', claimedAt: t(10_000) }], now), undefined);
  // No user/host on the record: strong only.
  assert.equal(correlate({ ...rec, user: undefined }, [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) }], now), undefined);
});

test('REG-6: a probe-shaped record — turns 0, sub-minute, no owner — weakly correlates to nothing; a flagged probe never does', () => {
  // The console's own MCP probe: `turns 0`, under a minute, spawned in the
  // operator's name. A hand lock claimed without `--session` used to weakly
  // correlate to a dozen such corpses an hour; a person's session has to be
  // plausible before a `<user>@<host>` match means anything.
  const t = (ms: number) => Date.parse(T0) + ms;
  const lock = { slug: 'alpha', phase: 2, owner: 'sam@laptop', claimedAt: t(10_000) };
  const shaped: SessionRecord = { sessionId: 'p1', kind: 'foreign', cwd: '/w', user: 'sam', host: 'laptop', startedAt: T0, lastSeen: at(20_000), endedAt: at(20_000), turns: 0 };
  assert.equal(correlate(shaped, [lock], t(700_000)), undefined, 'twenty seconds and no turn is nobody\'s session');
  assert.equal(weaklyCorrelatable(shaped, t(700_000)), false);
  // The same record with a turn, or with a minute of life, is a person's again.
  assert.deepEqual(correlate({ ...shaped, turns: 1 }, [lock], t(700_000)), { slug: 'alpha', phase: 2, strong: false });
  assert.deepEqual(correlate({ ...shaped, endedAt: at(WEAK_MIN_LIFETIME_MS) }, [lock], t(700_000)), { slug: 'alpha', phase: 2, strong: false });
  // A live record is measured to now: a 30-second-old one is not yet plausible, a two-minute-old one is.
  assert.equal(correlate({ ...shaped, endedAt: undefined }, [lock], t(30_000)), undefined);
  assert.deepEqual(correlate({ ...shaped, endedAt: undefined }, [lock], t(120_000)), { slug: 'alpha', phase: 2, strong: false });
  // A record the hook FLAGGED as the probe never weakly correlates, whatever its shape.
  const flagged: SessionRecord = { ...shaped, probe: true, turns: 5, endedAt: at(3_600_000) };
  assert.equal(correlate(flagged, [lock], t(4_000_000)), undefined);
  // …and its strong answers still stand: a lock naming the session is the session's.
  assert.deepEqual(correlate(flagged, [{ ...lock, session: 'p1' }], t(4_000_000)), { slug: 'alpha', phase: 2, strong: true });
});

test('SLF-2 / REG-6: the probe\'s payload registers as the console\'s (`agent`), flagged, and stays out of views', () => {
  // The probe now spawns with `PE_OWNER=console/mcp-probe` and
  // `PHASE_CONSOLE_PROBE=1`, and the hook forwards both. It is a record — it
  // ends with a real SessionEnd — but never `foreign`, never in the operator's
  // list, and never weakly correlated.
  const parsed = parseHookPayload({ session_id: 'probe-1', event: 'SessionStart', cwd: '/w', owner: 'console/mcp-probe', probe: 1, user: 'sam', host: 'laptop' });
  assert.ok(parsed);
  assert.equal(parsed!.probe, true);
  assert.equal(parseHookPayload({ session_id: 'x', event: 'SessionStart', cwd: '/w', probe: '1' })!.probe, true);
  assert.equal(parseHookPayload({ session_id: 'x', event: 'SessionStart', cwd: '/w', probe: 0 })!.probe, undefined);
  const { dir, cleanup } = scratch();
  try {
    const reg = new SessionRegistry({ dir, now: () => new Date(at(0)), pidAlive: null }).load();
    reg.ingest(parsed!);
    reg.ingest(payload({ event: 'SessionStart', user: 'sam', host: 'laptop', at: T0 }));
    const probe = reg.get('probe-1')!;
    assert.equal(probe.kind, 'agent', 'console/… is the console\'s own, never foreign');
    assert.equal(probe.probe, true);
    assert.deepEqual(reg.views().map((v) => v.sessionId), ['s1'], 'the operator\'s list leaves the probe out');
    assert.deepEqual(reg.views([], [], { probes: true }).map((v) => v.sessionId).sort(), ['probe-1', 's1'], '…unless asked');
    // The flag survives the file.
    const again = new SessionRegistry({ dir, now: () => new Date(at(5_000)), pidAlive: null }).load();
    assert.equal(again.get('probe-1')?.probe, true);
    assert.equal(again.get('probe-1')?.kind, 'agent');
    reg.close(); again.close();
  } finally { cleanup(); }
});

/* ---------------- the registry ---------------- */

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-registry-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('registry: ingest persists one record per session; a fresh registry reloads it; presence and views answer', () => {
  const { dir, cleanup } = scratch();
  try {
    const changes: string[] = [];
    const reg = new SessionRegistry({ dir, now: () => new Date(at(0)), pidAlive: null, onChange: (r, e) => changes.push(`${e}:${r.sessionId}`) }).load();
    reg.ingest(payload({ event: 'SessionStart', user: 'sam', host: 'laptop', at: T0 }));
    reg.ingest(payload({ event: 'Stop', at: at(1_000) }));
    reg.ingest({ session_id: 's2', event: 'SessionStart', cwd: '/work/hub', owner: 'autopilot/ab12cd34', at: at(2_000) });
    assert.deepEqual(changes, ['SessionStart:s1', 'Stop:s1', 'SessionStart:s2']);
    assert.ok(existsSync(join(dir, 's1.json')));
    assert.ok(existsSync(join(dir, 's2.json')));
    assert.equal(JSON.parse(readFileSync(join(dir, 's1.json'), 'utf8')).turns, 1);
    assert.equal(reg.presence('s1'), 'live');
    assert.equal(reg.presence('nobody'), 'unknown');
    assert.equal(reg.presenceOfLock({ session: 's1' }), 'live');
    assert.equal(reg.presenceOfLock({}), 'unknown');

    const again = new SessionRegistry({ dir, now: () => new Date(at(5_000)), pidAlive: null }).load();
    assert.equal(again.get('s1')?.turns, 1);
    assert.equal(again.get('s2')?.kind, 'autopilot');
    const views = again.views([{ slug: 'alpha', phase: 4, owner: 'sam@laptop', claimedAt: Date.parse(T0) + 500 }]);
    assert.equal(views.length, 2);
    const s1 = views.find((v) => v.sessionId === 's1')!;
    assert.equal(s1.presence, 'live');
    assert.deepEqual(s1.plan, { slug: 'alpha', phase: 4, strong: false });
    reg.close(); again.close();
  } finally { cleanup(); }
});

test('registry: the inbox is drained oldest-first (by at, then start<stop<end), applied, emptied; junk is deleted', () => {
  const { dir, cleanup } = scratch();
  try {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    // Dropped while the console was down — names in the hook's shape, deliberately out of order.
    writeFileSync(join(inbox, '1700000002-s1-SessionEnd.json'), JSON.stringify(payload({ event: 'SessionEnd', reason: 'other', at: at(2_000) })));
    writeFileSync(join(inbox, '1700000000-s1-SessionStart.json'), JSON.stringify(payload({ event: 'SessionStart', at: at(0) })));
    writeFileSync(join(inbox, '1700000001-s1-Stop.json'), JSON.stringify(payload({ event: 'Stop', at: at(1_000) })));
    // Same second, the two event kinds: start before end.
    writeFileSync(join(inbox, '1700000005-s3-SessionEnd.json'), JSON.stringify({ session_id: 's3', event: 'SessionEnd', cwd: '/w', at: at(5_000) }));
    writeFileSync(join(inbox, '1700000005-s3-SessionStart.json'), JSON.stringify({ session_id: 's3', event: 'SessionStart', cwd: '/w', at: at(5_000) }));
    writeFileSync(join(inbox, 'junk.json'), 'not json');
    writeFileSync(join(inbox, 'wrong.json'), JSON.stringify({ hello: 'world' }));
    const reg = new SessionRegistry({ dir, now: () => new Date(at(10_000)), pidAlive: null }).load();
    assert.equal(reg.get('s1')?.turns, 1);
    assert.equal(reg.get('s1')?.endedAt, at(2_000));
    assert.equal(reg.presence('s1'), 'ended');
    assert.equal(reg.get('s3')?.endedAt, at(5_000), 'start then end within one second');
    assert.deepEqual(readdirSync(inbox), [], 'the inbox is emptied, junk included');
    reg.close();
  } finally { cleanup(); }
});

test('REG-7: a complete `*.json.tmp.<dead pid>` is reclaimed — applied and reported; junk removed and reported; a live pid\'s tmp is left alone', () => {
  const { dir, cleanup } = scratch();
  try {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    // A hook killed between its write and its rename: a valid, complete
    // SessionStart that matched no glob and was reported by nothing. Two were
    // found on the operator's machine, for sessions the console never knew.
    writeFileSync(join(inbox, '1700000000123-s9-SessionStart.json.tmp.424242'), JSON.stringify(payload({ session_id: 's9', event: 'SessionStart', at: at(0) })));
    // …and one whose hook died mid-write: not a payload, gone with a warning.
    writeFileSync(join(inbox, '1700000000456-s8-Stop.json.tmp.424243'), '{"session_id":"s8","ev');
    // …and one whose hook is still alive: mid-write, not ours to touch.
    writeFileSync(join(inbox, '1700000000789-s7-Stop.json.tmp.1'), JSON.stringify(payload({ session_id: 's7', event: 'Stop', at: at(1_000) })));
    const warned: { what: string; detail: Record<string, unknown> }[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(at(10_000)),
      pidAlive: (pid) => pid === 1,
      onWarn: (what, detail) => { warned.push({ what, detail }); },
    }).load();
    assert.equal(reg.get('s9')?.startedAt, at(0), 'the orphan was applied as the SessionStart it was');
    assert.equal(reg.get('s8'), undefined, 'the torn one applied nothing');
    assert.equal(reg.get('s7'), undefined, 'the live hook\'s tmp was not read');
    assert.deepEqual(readdirSync(inbox), ['1700000000789-s7-Stop.json.tmp.1'], 'the orphans are gone, the live tmp stays');
    const orphans = warned.filter((w) => w.what === 'sessions.inbox-orphan');
    assert.equal(orphans.length, 2, 'each reclaim is reported');
    assert.deepEqual(orphans.map((w) => [w.detail.name, w.detail.pid, w.detail.applied]), [
      ['1700000000123-s9-SessionStart.json.tmp.424242', 424242, true],
      ['1700000000456-s8-Stop.json.tmp.424243', 424243, false],
    ]);
    assert.equal(orphans[0].detail.sessionId, 's9');
    reg.close();
  } finally { cleanup(); }
});

test('REG-7: two events of one kind for one session inside a second both survive — the names carry milliseconds', () => {
  const { dir, cleanup } = scratch();
  try {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    // The hook's post-5.0.0 names: a millisecond stamp, and the pid as a
    // tie-break when even that collides. Neither is parsed — the registry
    // orders by the payload's own `at` — so both drops are read.
    writeFileSync(join(inbox, '1700000000123-s1-Stop.json'), JSON.stringify(payload({ event: 'Stop', at: at(0) })));
    writeFileSync(join(inbox, '1700000000123-s1-Stop-51515.json'), JSON.stringify(payload({ event: 'Stop', at: at(0) })));
    writeFileSync(join(inbox, '1700000000000-s1-SessionStart.json'), JSON.stringify(payload({ event: 'SessionStart', at: at(-500) })));
    const reg = new SessionRegistry({ dir, now: () => new Date(at(10_000)), pidAlive: null }).load();
    assert.equal(reg.get('s1')?.turns, 2, 'both Stops counted');
    assert.deepEqual(readdirSync(inbox), []);
    reg.close();
  } finally { cleanup(); }
});

test('registry: prune forgets ended records past their keep and silent ones past a week; the files go with them', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = Date.parse(T0);
    const reg = new SessionRegistry({ dir, now: () => new Date(now), pidAlive: null }).load();
    reg.ingest(payload({ session_id: 'ended', event: 'SessionEnd', at: T0 }));
    reg.ingest(payload({ session_id: 'silent', event: 'SessionStart', at: T0 }));
    reg.ingest(payload({ session_id: 'fresh', event: 'SessionStart', at: T0 }));
    now += RETAIN_ENDED_MS + 1;
    assert.equal(reg.prune(), 1);
    assert.equal(reg.get('ended'), undefined);
    assert.ok(!existsSync(join(dir, 'ended.json')));
    assert.equal(reg.presence('silent'), 'unknown', 'past the live window, not ended');
    now += RETAIN_SILENT_MS;
    assert.equal(reg.prune(), 2);
    assert.equal(reg.list().length, 0);
    reg.close();
  } finally { cleanup(); }
});

test('registry: a gone process reads ended through the injected probe; the probe is not consulted for records without a pid', () => {
  const { dir, cleanup } = scratch();
  try {
    const asked: number[] = [];
    const reg = new SessionRegistry({ dir, now: () => new Date(at(1_000)), pidAlive: (pid) => { asked.push(pid); return pid !== 404; } }).load();
    reg.ingest(payload({ session_id: 'gone', event: 'SessionStart', pid: 404, at: T0 }));
    reg.ingest(payload({ session_id: 'here', event: 'SessionStart', pid: 200, at: T0 }));
    reg.ingest(payload({ session_id: 'nopid', event: 'SessionStart', at: T0 }));
    assert.equal(reg.presence('gone'), 'ended');
    assert.equal(reg.presence('here'), 'live');
    assert.equal(reg.presence('nopid'), 'live');
    assert.deepEqual([...new Set(asked)].sort(), [200, 404]);
    reg.close();
  } finally { cleanup(); }
});

test('ACC-7.7 (REG-9): a probe-detected death WRITES endedAt as the last evidence of life — endedDetectedAt the probe\'s clock, endedBy probe — and prune measures the ended rule', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = Date.parse(T0);
    const changes: string[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(now),
      pidAlive: (pid) => pid !== 404,
      onChange: (r, e) => changes.push(`${e}:${r.sessionId}`),
    }).load();
    reg.ingest(payload({ session_id: 'gone', event: 'SessionStart', pid: 404, at: T0 }));
    // Seen again a minute later — the last evidence of life.
    now += 60_000;
    reg.ingest(payload({ session_id: 'gone', event: 'Stop', pid: 404, at: new Date(now).toISOString() }));
    const lastSeen = reg.get('gone')!.lastSeen;
    changes.length = 0;

    // Found gone seventeen hours later: the session did not live those hours.
    now += 17 * 60 * 60_000;
    assert.equal(reg.presence('gone'), 'ended');
    // The line that was missing, then wrong. `presenceOf` answered `ended` and
    // nothing wrote it down, so `prune` fell to the SEVEN-DAY silence rule; the
    // fix stamped `now`, which claimed every hour between the last evidence and
    // the look. An inference is written as one: the end is the last evidence,
    // the look is its own clock, and the provenance says who concluded it.
    assert.equal(reg.get('gone')?.endedAt, lastSeen, 'endedAt is lastSeen, never the moment of the look');
    assert.equal(reg.get('gone')?.endedDetectedAt, new Date(now).toISOString(), 'the probe\'s clock');
    assert.equal(reg.get('gone')?.endedBy, 'probe');
    assert.equal(reg.get('gone')?.reason, 'process-gone');
    assert.deepEqual(changes, ['SessionEnd:gone'], 'the event the hook would have raised, had it been there to raise it');
    // Persisted, not merely in memory: a restart must not re-discover this.
    const reloaded = new SessionRegistry({ dir, now: () => new Date(now), pidAlive: null }).load().get('gone');
    assert.equal(reloaded?.endedAt, lastSeen);
    assert.equal(reloaded?.endedBy, 'probe');

    // Written ONCE — every later read short-circuits on `record.endedAt`.
    const detected = reg.get('gone')!.endedDetectedAt;
    now += 5_000;
    assert.equal(reg.presence('gone'), 'ended');
    assert.equal(reg.get('gone')?.endedDetectedAt, detected, 'the detection does not keep moving');
    assert.deepEqual(changes, ['SessionEnd:gone'], 'and it is announced once');

    // And prune measures the ended rule from the END, which is past already.
    now = Date.parse(lastSeen) + RETAIN_ENDED_MS + 1;
    assert.equal(reg.prune(), 1);
    assert.equal(reg.get('gone'), undefined);
    reg.close();
  } finally { cleanup(); }
});

/* ---------------- the waiting flag (Notification) ---------------- */

test('parseHookPayload: Notification is a session event and its message is capped at 256', () => {
  const ok = parseHookPayload(
    { session_id: 'n1', event: 'Notification', cwd: '/work/hub', message: 'Claude needs your permission to use Bash' },
  );
  assert.ok(ok);
  assert.equal(ok?.event, 'Notification');
  assert.equal(ok?.message, 'Claude needs your permission to use Bash');
  const long = parseHookPayload(
    { session_id: 'n1', event: 'Notification', cwd: '/work/hub', message: 'x'.repeat(999) },
  );
  assert.equal(long?.message?.length, 256);
});

test('applyEvent: `notification_type` decides what the session is waiting for', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0);
  const notify = (over: Record<string, unknown>) =>
    applyEvent(started, payload({ event: 'Notification', at: at(10_000), ...over }), at(10_000));

  const asking = notify({
    notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash',
  });
  assert.deepEqual(asking.waiting, {
    since: at(10_000), at: at(10_000), kind: 'permission', note: 'Claude needs your permission to use Bash',
  });
  assert.equal(notify({ notification_type: 'elicitation_dialog' }).waiting?.kind, 'elicitation');
  assert.equal(notify({ notification_type: 'idle_prompt' }).waiting?.kind, 'input');
  // The documented families this build learned in 5.0.0 (REG-8): a URL
  // elicitation is an elicitation, a background agent needing input is input.
  assert.equal(notify({ notification_type: 'elicitation_url_dialog' }).waiting?.kind, 'elicitation');
  assert.equal(notify({ notification_type: 'agent_needs_input' }).waiting?.kind, 'input');
  // A later ask in the same episode moves `at`, never `since`.
  const again = applyEvent(asking, payload({ event: 'Notification', notification_type: 'permission_prompt', at: at(40_000) }), at(40_000));
  assert.equal(again.waiting?.since, at(10_000));
  assert.equal(again.waiting?.at, at(40_000));
});

test('ACC-7.5 (REG-8): through the registry, an unmapped notification type changes no record and warns ONCE per distinct value; a documented ignored type warns nothing', () => {
  const { dir, cleanup } = scratch();
  try {
    const warned: { what: string; detail: Record<string, unknown> }[] = [];
    const changes: string[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(at(0)), pidAlive: null,
      onChange: (r, e) => changes.push(`${e}:${r.sessionId}`),
      onWarn: (what, detail) => warned.push({ what, detail }),
    }).load();
    reg.ingest(payload({ event: 'SessionStart', at: T0 }));
    const before = JSON.stringify(reg.get('s1'));
    changes.length = 0;
    for (const type of ['something_from_2027', 'tool_use', 'something_from_2027', 'tool_use', 'something_from_2027']) {
      reg.ingest(payload({ event: 'Notification', notification_type: type, message: 'hello', at: at(60_000) }));
    }
    assert.equal(JSON.stringify(reg.get('s1')), before, 'not lastSeen, not a wait, not anything');
    assert.deepEqual(changes, [], 'no persist, no change event');
    const unmapped = warned.filter((w) => w.what === 'sessions.notification-unmapped');
    assert.deepEqual(unmapped.map((w) => w.detail.type), ['something_from_2027', 'tool_use'], 'one warning per distinct value');
    for (const type of NOTIFICATION_IGNORED) {
      reg.ingest(payload({ event: 'Notification', notification_type: type, at: at(70_000) }));
    }
    assert.equal(warned.filter((w) => w.what === 'sessions.notification-unmapped').length, 2, 'a documented, ignored type is a decision, not news');
    assert.equal(JSON.stringify(reg.get('s1')), before);
    // A Notification for a session this registry never saw invents nothing.
    reg.ingest(payload({ session_id: 'stranger', event: 'Notification', notification_type: 'auth_success', at: at(80_000) }));
    assert.equal(reg.get('stranger'), undefined);
  } finally {
    cleanup();
  }
});

test('applyEvent: a Notification the map does not know is NOT a wait, and changes nothing', () => {
  // The hook fires for more than a prompt. Treating every one of them as an ask
  // is what made the urgent push channel fire for the CLI talking to itself,
  // and a channel that fires for everything is one that gets muted for the
  // notification that mattered. An unmapped type leaves the record exactly as
  // it was — not waiting, and (unlike a mapped one) not resurrected either.
  const started = applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0);
  for (const type of ['tool_use', 'plan_mode', 'something_from_2027']) {
    const after = applyEvent(
      started, payload({ event: 'Notification', notification_type: type, message: 'hello', at: at(10_000) }), at(10_000),
    );
    assert.equal(after.waiting, undefined, `'${type}' must not become a wait`);
  }
});

test('applyEvent: with no `notification_type` the old message sniff stands, and only for permission', () => {
  // A CLI predating the field. The sniff is the behaviour that was there, so
  // an older install is no worse off — but guessing that an UNKNOWN message is
  // an idle prompt is exactly how the sniff came to call everything an ask, so
  // a wordless notification is now nothing rather than `input`.
  const started = applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0);
  const sniffed = applyEvent(
    started, payload({ event: 'Notification', message: 'Claude needs your permission to use Bash', at: at(10_000) }), at(10_000),
  );
  assert.equal(sniffed.waiting?.kind, 'permission');
  const wordless = applyEvent(started, payload({ event: 'Notification', at: at(10_000) }), at(10_000));
  assert.equal(wordless.waiting, undefined);
});

test('applyEvent: within one episode `since` never moves, the kind may sharpen to permission, and the note follows', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0);
  const first = applyEvent(
    started, payload({ event: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input', at: at(10_000) }), at(10_000),
  );
  const second = applyEvent(
    first, payload({ event: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use WebFetch', at: at(70_000) }), at(70_000),
  );
  assert.equal(second.waiting?.since, at(10_000), 'the episode clock is the FIRST ask — it is the ack clock');
  assert.equal(second.waiting?.kind, 'permission', 'input may sharpen to permission');
  assert.equal(second.waiting?.note, 'Claude needs your permission to use WebFetch');
  const third = applyEvent(
    second, payload({ event: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input', at: at(130_000) }), at(130_000),
  );
  assert.equal(third.waiting?.kind, 'permission', 'permission never softens back while the episode stands');
  // And an elicitation cannot soften a permission either — sharpening is
  // one-way toward the loudest word, because a session that asked for input and
  // then for permission is parked on the permission.
  const fourth = applyEvent(
    third, payload({ event: 'Notification', notification_type: 'elicitation_dialog', at: at(190_000) }), at(190_000),
  );
  assert.equal(fourth.waiting?.kind, 'permission');
});

test('applyEvent: Stop, SessionEnd and a reviving SessionStart each clear the waiting flag', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0);
  const asking = applyEvent(started, payload({ event: 'Notification', message: 'permission', at: at(10_000) }), at(10_000));

  const answered = applyEvent(asking, payload({ event: 'Stop', at: at(20_000) }), at(20_000));
  assert.equal(answered.waiting, undefined, 'the turn ended — whatever it waited on was answered');

  const ended = applyEvent(asking, payload({ event: 'SessionEnd', reason: 'exit', at: at(20_000) }), at(20_000));
  assert.equal(ended.waiting, undefined);

  const revived = applyEvent(ended, payload({ event: 'SessionStart', source: 'resume', at: at(30_000) }), at(30_000));
  assert.equal(revived.waiting, undefined, 'a fresh start is not waiting on anything yet');
  // Every clear leaves how the wait ended (REG-4).
  assert.deepEqual(answered.lastWait, { since: at(10_000), kind: 'permission', note: 'permission', clearedAt: at(20_000), outcome: 'answered' });
  assert.equal(ended.lastWait?.outcome, 'ended');
  // An answering notification ends a wait of ITS kind and no other.
  const eliciting = applyEvent(started, payload({ event: 'Notification', notification_type: 'elicitation_dialog', at: at(10_000) }), at(10_000));
  const completed = applyEvent(eliciting, payload({ event: 'Notification', notification_type: 'elicitation_complete', at: at(15_000) }), at(15_000));
  assert.equal(completed.waiting, undefined, 'an elicitation completing answers the elicitation');
  assert.equal(completed.lastWait?.outcome, 'answered');
  const permission = applyEvent(started, payload({ event: 'Notification', notification_type: 'permission_prompt', at: at(10_000) }), at(10_000));
  assert.equal(
    applyEvent(permission, payload({ event: 'Notification', notification_type: 'elicitation_response', at: at(15_000) }), at(15_000)).waiting?.kind,
    'permission', 'it does not answer a permission prompt',
  );
});

test('ACC-8.9 (REG-4): a wait clears with no hook — progress past the ask, a gone process, or the cap (recorded unanswered)', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = Date.parse(T0);
    const changes: string[] = [];
    let alive = true;
    const reg = new SessionRegistry({
      dir, now: () => new Date(now),
      pidAlive: (pid) => (pid === 7 ? alive : true),
      onChange: (r, e) => changes.push(`${e}:${r.sessionId}`),
    }).load();
    const ask = (id: string, over: Partial<HookPayload> = {}) => {
      reg.ingest(payload({ session_id: id, event: 'SessionStart', at: new Date(now).toISOString(), ...over }));
      reg.ingest(payload({
        session_id: id, event: 'Notification', notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash', at: new Date(now).toISOString(), ...over,
      }));
      assert.equal(reg.get(id)?.waiting?.kind, 'permission');
    };

    // (i) progress: the runner's heartbeat after the latest ask means it was answered.
    ask('lane', { owner: 'autopilot/ab12cd34' });
    changes.length = 0;
    now += 5_000;
    assert.equal(reg.heartbeat('lane'), true);
    assert.equal(reg.get('lane')?.waiting, undefined, 'the session is producing again');
    assert.equal(reg.get('lane')?.lastWait?.outcome, 'answered');
    assert.deepEqual(changes, ['wait-cleared:lane'], 'a transition, told at once whatever the throttle says');

    // (ii) death: a gone pid reads ended, and the wait goes with it.
    ask('dies', { pid: 7 });
    alive = false;
    now += 1_000;
    assert.equal(reg.presence('dies'), 'ended');
    assert.equal(reg.get('dies')?.waiting, undefined, 'a dead session is waiting on nobody');
    assert.equal(reg.get('dies')?.lastWait?.outcome, 'ended');

    // (iii) the transcript moved after the ask.
    const transcript = join(dir, 'moved.jsonl');
    writeFileSync(transcript, '{}\n');
    ask('typed', { transcript_path: transcript });
    const askedAt = Date.parse(reg.get('typed')!.waiting!.at!);
    utimesSync(transcript, new Date(askedAt - 60_000), new Date(askedAt - 60_000));
    assert.equal(reg.settleWaits(), 0, 'a transcript older than the ask says nothing');
    utimesSync(transcript, new Date(askedAt + TRANSCRIPT_GRACE_MS + 5_000), new Date(askedAt + TRANSCRIPT_GRACE_MS + 5_000));
    changes.length = 0;
    assert.equal(reg.settleWaits(), 1);
    assert.equal(reg.get('typed')?.waiting, undefined);
    assert.equal(reg.get('typed')?.lastWait?.outcome, 'answered');
    assert.deepEqual(changes, ['wait-cleared:typed']);

    // (iv) the cap: nobody answered within the hour.
    ask('stuck');
    now += WAIT_ANSWER_CAP_MS - 1_000;
    assert.equal(reg.settleWaits(), 0, 'inside the cap it still waits');
    now += 2_000;
    changes.length = 0;
    assert.equal(reg.settleWaits(), 1);
    assert.equal(reg.get('stuck')?.waiting, undefined);
    assert.equal(reg.get('stuck')?.lastWait?.outcome, 'unanswered', 'recorded unanswered, not silently dropped');
    assert.deepEqual(changes, ['wait-unanswered:stuck'], 'told once');
    assert.equal(reg.settleWaits(), 0, 'and never twice');
    // Persisted: a restart reads the same outcome.
    assert.equal(new SessionRegistry({ dir, now: () => new Date(now), pidAlive: null }).load().get('stuck')?.lastWait?.outcome, 'unanswered');
  } finally {
    cleanup();
  }
});

test('applyEvent: a stale Notification neither resurrects a dead record nor marks it waiting', () => {
  const ended = applyEvent(
    applyEvent(undefined, payload({ event: 'SessionStart', at: T0 }), T0),
    payload({ event: 'SessionEnd', reason: 'exit', at: at(100_000) }), at(100_000),
  );
  const late = applyEvent(ended, payload({ event: 'Notification', message: 'permission', at: at(50_000) }), at(200_000));
  assert.equal(late.endedAt, at(100_000), 'still ended');
  assert.equal(late.waiting, undefined, 'an out-of-order ask claims nothing');
});

test('registry: the waiting flag survives a persist-and-reload, and views carry it', () => {
  const { dir, cleanup } = scratch();
  try {
    const reg = new SessionRegistry({ dir, now: () => new Date(at(0)), pidAlive: null }).load();
    reg.ingest(payload({ event: 'SessionStart', at: T0 }));
    reg.ingest(payload({ event: 'Notification', message: 'Claude needs your permission to use Bash', at: at(10_000) }));
    assert.equal(reg.get('s1')?.waiting?.kind, 'permission');

    const again = new SessionRegistry({ dir, now: () => new Date(at(20_000)), pidAlive: null }).load();
    const view = again.views([]).find((v) => v.sessionId === 's1');
    assert.equal(view?.waiting?.since, at(10_000));
    assert.equal(view?.waiting?.kind, 'permission');

    again.ingest(payload({ event: 'Stop', at: at(30_000) }));
    assert.equal(again.get('s1')?.waiting, undefined);
    assert.ok(!readFileSync(join(dir, 's1.json'), 'utf8').includes('waiting'), 'the clear persists too');
    reg.close(); again.close();
  } finally { cleanup(); }
});

/* ---------------- Phase 8: a session knows its plan ---------------- */

test('correlate: an unresolved run that names the session answers STRONG with no lock on disk, and the answer carries the run id', () => {
  const rec: SessionRecord = {
    sessionId: 's1', kind: 'autopilot', cwd: '/work/hub', owner: 'autopilot/ab12cd34',
    startedAt: T0, lastSeen: at(600_000), turns: 0,
  };
  const now = Date.parse(T0) + 700_000;
  const runs: RunLink[] = [
    { runId: 'ab12cd34', slug: 'alpha', phase: 9, sessionId: 's1', active: true },
    { runId: 'ab12cd34', slug: 'alpha', phase: 8, sessionId: 'other' },
  ];
  // THE incident: the lock was released, so the lock-only correlate said nothing
  // and the row rendered plan-less while the run record named the phase.
  assert.deepEqual(correlate(rec, [], now, runs), { slug: 'alpha', phase: 9, strong: true, runId: 'ab12cd34' });
  // Without the run source it is still the old silence — the regression this pins.
  assert.equal(correlate(rec, [], now), undefined);
});

test('correlate: a lock naming the session outranks the run record; the run record outranks a weak owner lock', () => {
  const rec: SessionRecord = {
    sessionId: 's1', kind: 'foreign', cwd: '/work/hub', user: 'sam', host: 'laptop',
    startedAt: T0, lastSeen: at(600_000), turns: 3,
  };
  const now = Date.parse(T0) + 700_000;
  const runs: RunLink[] = [{ runId: 'ab12cd34', slug: 'beta', phase: 2, sessionId: 's1' }];

  // 1 beats 2.
  assert.deepEqual(
    correlate(rec, [{ slug: 'alpha', phase: 7, owner: 'x', session: 's1', claimedAt: Date.parse(T0) }], now, runs),
    { slug: 'alpha', phase: 7, strong: true },
  );
  // 2 beats 3 — and a run naming its own session is strong, not a display guess.
  assert.deepEqual(
    correlate(rec, [{ slug: 'alpha', phase: 7, owner: 'sam@laptop', claimedAt: Date.parse(T0) + 10_000 }], now, runs),
    { slug: 'beta', phase: 2, strong: true, runId: 'ab12cd34' },
  );
  // A run naming a DIFFERENT session is not this session's, whatever its owner says.
  assert.deepEqual(
    correlate(rec, [{ slug: 'alpha', phase: 7, owner: 'sam@laptop', claimedAt: Date.parse(T0) + 10_000 }], now,
      [{ runId: 'zz', slug: 'beta', phase: 2, sessionId: 's9' }]),
    { slug: 'alpha', phase: 7, strong: false },
  );
});

test('correlate: `autopilot/<runId>` is the LAST fallback — weak, and the in-flight phase answers for a run that names no session', () => {
  const rec: SessionRecord = {
    sessionId: 'sX', kind: 'autopilot', cwd: '/work/hub', owner: 'autopilot/ab12cd34',
    startedAt: T0, lastSeen: at(600_000), turns: 0,
  };
  const now = Date.parse(T0) + 700_000;
  const runs: RunLink[] = [
    { runId: 'ab12cd34', slug: 'alpha', phase: 3 },
    { runId: 'ab12cd34', slug: 'alpha', phase: 6, active: true },
    { runId: 'ab12cd34', slug: 'alpha', phase: 11 },
    { runId: 'ffffffff', slug: 'beta', phase: 1, active: true },
  ];
  // In flight first — never merely the highest number.
  assert.deepEqual(correlate(rec, [], now, runs), { slug: 'alpha', phase: 6, strong: false, runId: 'ab12cd34' });
  // Nothing in flight: the newest phase the run touched, still weak.
  assert.deepEqual(
    correlate(rec, [], now, runs.filter((r) => !r.active)),
    { slug: 'alpha', phase: 11, strong: false, runId: 'ab12cd34' },
  );
  // A run this console can no longer see, and an owner that is not a lane's.
  assert.equal(correlate(rec, [], now, [{ runId: 'other', slug: 'beta', phase: 1 }]), undefined);
  assert.equal(correlate({ ...rec, owner: 'console/agent-3' }, [], now, runs), undefined);
  assert.equal(correlate({ ...rec, owner: 'sam@laptop' }, [], now, runs), undefined);
});

test('turnsOf: the hook\'s turns and the stream\'s are the MAX, never the sum — the two writers cannot double-count', () => {
  assert.equal(turnsOf({ turns: 0 }), 0);
  // The autopilot case the phase exists for: the run's settings displaced the
  // Stop hook, so the hook saw one turn and the stream saw four hundred.
  assert.equal(turnsOf({ turns: 1, streamTurns: 400 }), 400);
  // A person's session: no runner is watching, the hook is the only counter.
  assert.equal(turnsOf({ turns: 12, streamTurns: 0 }), 12);
  // Both reporting: they report the SAME turns, so 41 — not 82.
  assert.equal(turnsOf({ turns: 41, streamTurns: 40 }), 41);
});

test('registry.heartbeat: every call advances the in-memory record; the disk and the browser hear it once per window', () => {
  const { dir, cleanup } = scratch();
  try {
    let ms = Date.parse(T0);
    const changes: string[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(ms), pidAlive: null,
      onChange: (r, e) => changes.push(`${e}:${r.sessionId}:${r.streamTurns ?? 0}`),
    }).load();
    reg.ingest({ session_id: 'lane', event: 'SessionStart', cwd: '/work/hub', owner: 'autopilot/ab12cd34', at: T0 });
    assert.deepEqual(changes, ['SessionStart:lane:0']);

    // Sixty events inside one window: sixty in-memory updates, ONE write.
    for (let i = 0; i < 60; i++) {
      ms += 100;
      assert.equal(reg.heartbeat('lane', { turnEnded: i % 10 === 0 }), true);
    }
    assert.equal(reg.get('lane')?.streamTurns, 6);
    assert.equal(reg.get('lane')?.lastSeen, new Date(ms).toISOString());
    // The first heartbeat of a session always lands; nothing after it, in-window.
    assert.deepEqual(changes, ['SessionStart:lane:0', 'heartbeat:lane:1']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'lane.json'), 'utf8')).streamTurns, 1);

    // Past the window, the next beat writes what accumulated.
    ms += HEARTBEAT_PERSIST_MS;
    reg.heartbeat('lane', { turnEnded: true });
    assert.deepEqual(changes, ['SessionStart:lane:0', 'heartbeat:lane:1', 'heartbeat:lane:7']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'lane.json'), 'utf8')).streamTurns, 7);

    // The view reports the merged count, and it survives a reload.
    assert.equal(reg.views().find((v) => v.sessionId === 'lane')?.turns, 7);
    const again = new SessionRegistry({ dir, now: () => new Date(ms), pidAlive: null }).load();
    assert.equal(again.get('lane')?.streamTurns, 7);
    assert.equal(again.views().find((v) => v.sessionId === 'lane')?.turns, 7);
    reg.close(); again.close();
  } finally { cleanup(); }
});

test('registry.heartbeat: an unknown id invents nothing; a hook-ended session stays ended; a probe-ended one is revived by evidence', () => {
  const { dir, cleanup } = scratch();
  try {
    let ms = Date.parse(T0);
    const reg = new SessionRegistry({ dir, now: () => new Date(ms), pidAlive: null }).load();

    // Nothing here invents a session — the module's rule, and a heartbeat
    // carries no cwd to invent one with.
    assert.equal(reg.heartbeat('never-seen', { turnEnded: true }), false);
    assert.equal(reg.get('never-seen'), undefined);
    assert.equal(existsSync(join(dir, 'never-seen.json')), false);

    // The hook said the session ended. A late stream event does not argue.
    reg.ingest({ session_id: 'done', event: 'SessionStart', cwd: '/work/hub', at: T0 });
    reg.ingest({ session_id: 'done', event: 'SessionEnd', cwd: '/work/hub', reason: 'clear', at: at(1_000) });
    ms = Date.parse(at(2_000));
    assert.equal(reg.heartbeat('done', { turnEnded: true }), false);
    assert.equal(reg.get('done')?.endedAt, at(1_000));
    assert.equal(reg.get('done')?.streamTurns, undefined);

    // But a death only the PROBE concluded is an absence of evidence, and this
    // is evidence: the session is streaming.
    reg.ingest({ session_id: 'probed', event: 'SessionStart', cwd: '/work/hub', at: T0 });
    const probed = reg.get('probed')!;
    probed.endedAt = at(1_500);
    probed.reason = 'process-gone';
    assert.equal(reg.heartbeat('probed', { turnEnded: true }), true);
    assert.equal(reg.get('probed')?.endedAt, undefined);
    assert.equal(reg.get('probed')?.reason, undefined);
    assert.equal(reg.get('probed')?.streamTurns, 1);
    reg.close();
  } finally { cleanup(); }
});

test('registry.views: the run source reaches the view, so a live session with no lock is never plan-less', () => {
  const { dir, cleanup } = scratch();
  try {
    const reg = new SessionRegistry({ dir, now: () => new Date(at(1_000)), pidAlive: null }).load();
    reg.ingest({ session_id: 'lane', event: 'SessionStart', cwd: '/work/hub', owner: 'autopilot/ab12cd34', at: T0 });
    const view = reg.views([], [{ runId: 'ab12cd34', slug: 'alpha', phase: 9, sessionId: 'lane', active: true }])[0];
    assert.equal(view.presence, 'live');
    assert.deepEqual(view.plan, { slug: 'alpha', phase: 9, strong: true, runId: 'ab12cd34' });
    // No runs, no locks: the plan-less row the incident produced.
    assert.equal(reg.views()[0].plan, undefined);
    reg.close();
  } finally { cleanup(); }
});

/* ---------------- zero-touch phase 16: the inbox's clock, the drain lock, the peers ---------------- */

test('ACC-7.1 (REG-2): every drained event carries its lateness; past the horizon it is history; past a week it is refused; the depth watermark is said once per crossing', () => {
  const { dir, cleanup } = scratch();
  try {
    const now = Date.parse(T0) + 30 * 24 * 60 * 60_000;
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const put = (name: string, body: Record<string, unknown>) => writeFileSync(join(inbox, name), JSON.stringify(body));
    put('1-fresh-Stop.json', { session_id: 'fresh', event: 'Stop', cwd: '/work/hub', at: new Date(now - 30_000).toISOString() });
    put('2-late-Stop.json', { session_id: 'late', event: 'Stop', cwd: '/work/hub', at: new Date(now - INBOX_HISTORY_HORIZON_MS - 60_000).toISOString() });
    put('3-ancient-Stop.json', { session_id: 'ancient', event: 'Stop', cwd: '/work/hub', at: new Date(now - INBOX_AGE_REFUSE_MS - 60_000).toISOString() });
    const warned: { what: string; detail: Record<string, unknown> }[] = [];
    const told: { what: string; detail: Record<string, unknown> }[] = [];
    const changes: { id: string; event: string; meta?: { via: string; lateMs: number; history: boolean } }[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(now), pidAlive: null,
      onChange: (r, e, meta) => changes.push({ id: r.sessionId, event: e, ...(meta ? { meta } : {}) }),
      onWarn: (what, detail) => warned.push({ what, detail }),
      onInfo: (what, detail) => told.push({ what, detail }),
    }).load();

    const fresh = reg.get('fresh')!;
    assert.equal(fresh.lastEvent?.via, 'inbox');
    assert.equal(fresh.lastEvent?.lateMs, 30_000);
    assert.equal(fresh.lastEvent?.at, new Date(now - 30_000).toISOString(), 'the session\'s own clock');
    assert.equal(fresh.lastEvent?.appliedAt, new Date(now).toISOString(), 'this process\'s');
    assert.equal(fresh.lastEvent?.history, undefined);
    assert.equal(reg.get('late')?.lastEvent?.history, true, 'past the horizon: applied as history');
    assert.equal(reg.get('ancient'), undefined, 'past a week: never applied');
    assert.ok(warned.some((w) => w.what === 'sessions.inbox-refused' && w.detail.sessionId === 'ancient'));
    assert.deepEqual(readdirSync(inbox), [], 'the refused drop is removed with the rest');
    assert.deepEqual(
      changes.map((c) => [c.id, c.meta?.via, c.meta?.history]),
      [['late', 'inbox', true], ['fresh', 'inbox', false]],
      'the listener is told how late each event was, oldest first',
    );
    const drained = told.find((t) => t.what === 'sessions.inbox-drained');
    assert.deepEqual(drained?.detail, { via: 'inbox', applied: 2, history: 1, refused: 1, lateMsMax: INBOX_HISTORY_HORIZON_MS + 60_000 });
    assert.deepEqual(reg.lastDrain(), { applied: 2, history: 1, refused: 1, lateMsMax: INBOX_HISTORY_HORIZON_MS + 60_000 });

    // A POST is news by definition: lateness is recorded, history never is.
    reg.ingest(payload({ session_id: 'posted', event: 'Stop', at: new Date(now - 2 * INBOX_HISTORY_HORIZON_MS).toISOString() }));
    assert.equal(reg.get('posted')?.lastEvent?.via, 'post');
    assert.equal(reg.get('posted')?.lastEvent?.history, undefined);

    // Depth: the watermark is said once per crossing, not once per pass.
    for (let i = 0; i < INBOX_DEPTH_WATERMARK; i++) {
      put(`d${String(i).padStart(4, '0')}-deep-Stop.json`, { session_id: 'deep', event: 'Stop', cwd: '/work/hub', at: new Date(now - 1_000 + i).toISOString() });
    }
    assert.equal(reg.depth(), INBOX_DEPTH_WATERMARK);
    reg.ingestInbox();
    assert.equal(warned.filter((w) => w.what === 'sessions.inbox-deep').length, 1);
    assert.equal(reg.depth(), 0);
    reg.close();
  } finally { cleanup(); }
});

test('REG-2: one drain at a time across processes — a live holder\'s lock leaves the drops for the next pass; a dead holder\'s is reclaimed', () => {
  const { dir, cleanup } = scratch();
  try {
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, '1-held-Stop.json'), JSON.stringify({ session_id: 'held', event: 'Stop', cwd: '/work/hub', at: at(0) }));
    // Another process draining right now: the test runner's parent is alive.
    writeFileSync(join(dir, 'inbox.lock'), `${process.ppid} ${Date.now()}\n`);
    const reg = new SessionRegistry({ dir, now: () => new Date(at(1_000)) });
    assert.equal(reg.ingestInbox(), 0, 'held: nothing applied beside the holder');
    assert.equal(reg.get('held'), undefined);
    assert.equal(readdirSync(inbox).length, 1, 'the drop is left for the next pass');

    // The holder is gone (a pid nothing has): the lock is debris.
    writeFileSync(join(dir, 'inbox.lock'), `2147483646 ${Date.now()}\n`);
    assert.equal(reg.ingestInbox(), 1);
    assert.equal(reg.get('held')?.turns, 1);
    assert.equal(existsSync(join(dir, 'inbox.lock')), false, 'released after the drain');
    reg.close();
  } finally { cleanup(); }
});

test('ACC-7.3 (REG-3): inRoot is who is IN the repository — live, or unknown with a process behind it; probes, ended sessions and other roots are not', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = Date.parse(T0);
    const reg = new SessionRegistry({ dir, now: () => new Date(now), pidAlive: (pid) => pid !== 404 }).load();
    reg.ingest(payload({ session_id: 'here', event: 'SessionStart', cwd: '/work/hub/app', root: '/work/hub', pid: 7, at: T0 }));
    reg.ingest(payload({ session_id: 'unrooted', event: 'SessionStart', cwd: '/work/hub/docs', pid: 8, at: T0 }));
    reg.ingest(payload({ session_id: 'elsewhere', event: 'SessionStart', cwd: '/work/other', root: '/work/other', pid: 9, at: T0 }));
    reg.ingest(payload({ session_id: 'probe', event: 'SessionStart', cwd: '/work/hub', root: '/work/hub', pid: 10, probe: true, owner: 'console/mcp-probe', at: T0 }));
    reg.ingest(payload({ session_id: 'gone', event: 'SessionStart', cwd: '/work/hub', root: '/work/hub', pid: 404, at: T0 }));
    reg.ingest(payload({ session_id: 'stale-no-pid', event: 'SessionStart', cwd: '/work/hub', root: '/work/hub', at: T0 }));
    reg.ingest(payload({ session_id: 'me', event: 'SessionStart', cwd: '/work/hub', root: '/work/hub', pid: 11, at: T0 }));
    now += LIVE_WINDOW_MS + 60_000;
    // Two of them are still heard from; the rest went quiet past the live window.
    reg.ingest(payload({ session_id: 'here', event: 'Stop', cwd: '/work/hub/app', root: '/work/hub', pid: 7, at: new Date(now).toISOString() }));
    reg.ingest(payload({ session_id: 'me', event: 'Stop', cwd: '/work/hub', root: '/work/hub', pid: 11, at: new Date(now).toISOString() }));

    const inside = reg.inRoot('/work/hub', { excluding: ['me'] });
    assert.deepEqual(
      inside.map((r) => [r.sessionId, r.presence]).sort(),
      [['here', 'live'], ['unrooted', 'unknown']],
      'live, or unknown with a pid behind it; the probe, the dead pid, the pid-less stale record, another root and the excluded session are not',
    );
    reg.close();
  } finally { cleanup(); }
});

test('REG-9 (ii, iii): the turn count names its writer — the stream, the hook, or nobody', () => {
  assert.equal(turnsSourceOf({ turns: 4, streamTurns: 139, events: 3, kind: 'autopilot' }), 'stream');
  assert.equal(turnsSourceOf({ turns: 5, events: 12, kind: 'foreign' }), 'hook');
  assert.equal(turnsSourceOf({ turns: 0, events: 2, kind: 'foreign' }), 'hook', 'a record that barely moved may really have taken no turn');
  assert.equal(turnsSourceOf({ turns: 0, events: TURNS_UNKNOWN_AFTER_EVENTS, kind: 'foreign' }), 'unknown', 'many moves and never a Stop: a 0 nobody counted');
  assert.equal(turnsSourceOf({ turns: 0, events: 40, kind: 'agent' }), 'hook', 'only a foreign record has no other reporter to blame');
});

test('REG-3 claim window: it closes PEER_CLAIM_WINDOW_MS after the newest start — a resume re-opens it; a compaction, a replayed start or a stale one does not', () => {
  const started = applyEvent(undefined, payload({ event: 'SessionStart', source: 'startup', pid: 7, at: T0 }), T0);
  assert.equal(started.resumedAt, undefined, 'a first start is `startedAt`, not a resume');
  assert.equal(claimWindowEnds(started), Date.parse(T0) + PEER_CLAIM_WINDOW_MS);

  // A compaction is the same session carrying on with the same work.
  const compacted = applyEvent(started, payload({ event: 'SessionStart', source: 'compact', at: at(3 * PEER_CLAIM_WINDOW_MS) }), at(3 * PEER_CLAIM_WINDOW_MS));
  assert.equal(compacted.resumedAt, undefined);
  assert.equal(claimWindowEnds(compacted), Date.parse(T0) + PEER_CLAIM_WINDOW_MS);

  // `claude --resume` keeps the id, so `startedAt` cannot say that a person just came back to it.
  const resumeAt = at(4 * PEER_CLAIM_WINDOW_MS);
  const resumed = applyEvent(compacted, payload({ event: 'SessionStart', source: 'resume', at: resumeAt }), resumeAt);
  assert.equal(resumed.resumedAt, resumeAt);
  assert.equal(resumed.startedAt, T0, 'the first start stays the start');
  assert.equal(claimWindowEnds(resumed), Date.parse(resumeAt) + PEER_CLAIM_WINDOW_MS);

  // An older resume replayed out of order never pulls the window back.
  const replayed = applyEvent(resumed, payload({ event: 'SessionStart', source: 'resume', at: at(2 * PEER_CLAIM_WINDOW_MS) }), at(5 * PEER_CLAIM_WINDOW_MS));
  assert.equal(replayed.resumedAt, resumeAt);

  // A resume older than the end it would undo revives nothing, so it re-opens nothing.
  const ended = applyEvent(resumed, payload({ event: 'SessionEnd', reason: 'other', at: at(6 * PEER_CLAIM_WINDOW_MS) }), at(6 * PEER_CLAIM_WINDOW_MS));
  const stale = applyEvent(ended, payload({ event: 'SessionStart', source: 'resume', at: at(5 * PEER_CLAIM_WINDOW_MS) }), at(7 * PEER_CLAIM_WINDOW_MS));
  assert.equal(stale.resumedAt, resumeAt);

  // No readable start is no evidence of a recent one: the window is shut.
  assert.equal(claimWindowEnds({ startedAt: 'not a date' }), -Infinity);
});

test('REG-3 (iv): the peers sentence names each live session, where it stands and what it works — or says nothing for nobody', () => {
  assert.equal(peersSentence('/work/hub', []), null);
  const sentence = peersSentence('/work/hub', [
    { sessionId: '7fc6d30c-1111', pid: 94120, cwd: '/work/hub/aws', kind: 'foreign' },
    { sessionId: '7e95ff7b-2222', pid: 97448, cwd: '/work/hub', kind: 'autopilot' },
  ], new Map([['7e95ff7b-2222', { slug: 'alpha', phase: 8 }]]));
  assert.match(String(sentence), /2 other live Claude sessions in this repository/);
  assert.match(String(sentence), /7fc6d30c \(pid 94120, in aws\)/);
  assert.match(String(sentence), /7e95ff7b \(pid 97448, at the repository root, working alpha phase 8, an autopilot lane\)/);
  assert.match(String(sentence), /phase-lock\.sh <slug> conflicts <N>/);
});

/* ------------------------------------------------------------------ *
 * The unowned sink (zero-touch phase 17, FLT-8 / ACC-10.7)
 * ------------------------------------------------------------------ */

test('ACC-10.7 (FLT-8): an event from a directory under neither of two consoles is recorded unowned and visible to a fleet reader — and with one console it is not filed against it', async () => {
  const { spawnSync } = await import('node:child_process');
  const { census, instanceStateDir, registerInstance, unownedInboxDir } = await import('../shared/instances.mjs');
  const box = mkdtempSync(join(tmpdir(), 'pc-unowned-'));
  const env = { ...process.env, XDG_CONFIG_HOME: join(box, 'config'), XDG_STATE_HOME: join(box, 'state'), PHASE_CONSOLE_HOOK_INGEST: '0' };
  delete env.DOCS_ROOT;
  delete env.PHASE_CONSOLE_URL;
  const roots = ['alpha', 'beta', 'elsewhere'].map((name) => {
    const dir = join(box, name);
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    return dir;
  });
  const hook = new URL('../../scripts/session-hook.sh', import.meta.url).pathname;
  const fire = (sessionId: string, cwd: string) => spawnSync('bash', [hook], {
    input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    env, encoding: 'utf8',
  });
  const drops = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []);
  try {
    // ONE console registered: a session in a directory it does not own is not its business.
    const alpha = registerInstance(roots[0]!, { name: 'alpha', port: 4561, default: true }, env);
    assert.ok(alpha);
    assert.equal(fire('lonely', roots[2]!).status, 0);
    assert.deepEqual(drops(join(instanceStateDir(alpha.id, true, env), 'sessions', 'inbox')), [],
      'the only console is not evidence the directory belongs to it — nothing filed against alpha');
    assert.equal(drops(unownedInboxDir(env)).length, 1, 'recorded unowned instead of dropped');

    // TWO consoles registered: the same event, under neither, is recorded unowned too.
    const beta = registerInstance(roots[1]!, { name: 'beta', port: 4562 }, env);
    assert.ok(beta);
    mkdirSync(join(box, 'elsewhere', 'src'), { recursive: true });
    assert.equal(fire('stranger', join(box, 'elsewhere', 'src')).status, 0);
    assert.deepEqual(drops(join(instanceStateDir(beta.id, false, env), 'sessions', 'inbox')), []);
    const sink = drops(unownedInboxDir(env));
    assert.equal(sink.length, 2);
    const record = JSON.parse(readFileSync(join(unownedInboxDir(env), sink.find((name) => name.includes('stranger'))!), 'utf8')) as Record<string, unknown>;
    assert.equal(record.owner_kind, 'unowned');
    assert.equal(record.owner_how, 'candidate', 'it names the project root it would have been, and how that was decided');
    assert.equal(record.root, roots[2]);

    // A fleet reader sees them: the census counts the machine's unowned drops.
    assert.equal(census(env).unowned.count, 2);

  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// ── PRS-1 — `/clear` ends a session that is still running ────────────────────
// Claude Code fires SessionEnd for `/clear`, and the process it fires it for is
// the very process still sitting in front of the operator. `endedAt` was read
// FIRST and answered `ended` outright, so the pid probe — the only witness that
// can tell a finished session from a cleared one — was never consulted.
//
// `ended` is the one answer that makes a foreign lock DEBRIS: converge releases
// it, boarding starts a second session in the same working tree, and the first
// one is still typing. `unknown` is what is actually true — the hook says it
// ended, the process says it did not, and nobody can vouch for it — so lease
// rules apply and nothing is released.
test('PRS-1: endedAt with the process still RUNNING is unknown, never ended', () => {
  const live: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99 };
  const cleared = { ...live, endedAt: at(10) };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(cleared, now, () => true), 'unknown', '/clear on a live process');
  assert.equal(presenceOf(cleared, now, () => 'running'), 'unknown');
});

test('PRS-1: endedAt with the process GONE is still ended', () => {
  // The ordinary case, and the one the demotion must not touch: the session
  // finished, the process exited, the lock is debris and converge may take it.
  const live: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99 };
  const ended = { ...live, endedAt: at(10) };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(ended, now, () => false), 'ended');
  assert.equal(presenceOf(ended, now, () => 'gone'), 'ended');
});

test('PRS-1: endedAt with NO probe, or no pid, is ended exactly as before', () => {
  // The demotion needs a witness. With nobody to ask, the hook's word stands —
  // anything else would make every finished session hold its lock to the lease.
  const rec: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99, endedAt: at(10) };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(rec, now), 'ended', 'no probe');
  assert.equal(presenceOf({ ...rec, pid: undefined }, now, () => true), 'ended', 'no pid');
  assert.equal(presenceOf(rec, now, () => { throw new Error('ps broke'); }), 'ended',
    'a probe that cannot answer never OVERTURNS the hook either');
});

test('PRS-1: a stopped process under endedAt is unknown too', () => {
  const rec: SessionRecord = { sessionId: 's1', kind: 'foreign', cwd: '/w', startedAt: T0, lastSeen: T0, turns: 0, pid: 99, endedAt: at(10) };
  const now = Date.parse(T0) + 60_000;
  assert.equal(presenceOf(rec, now, () => 'stopped'), 'unknown');
  assert.equal(presenceOf(rec, now, () => 'zombie'), 'unknown');
});
