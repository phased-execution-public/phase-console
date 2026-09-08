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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  SessionRegistry, HEARTBEAT_PERSIST_MS, LIVE_WINDOW_MS, RETAIN_ENDED_MS, RETAIN_SILENT_MS,
  applyEvent, correlate, kindOf, parseHookPayload, presenceOf, turnsOf,
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
    startedAt: T0, lastSeen: T0, source: 'startup', turns: 0,
  });
  const beat = applyEvent(started, payload({ event: 'Stop', at: at(60_000) }), at(60_000));
  assert.equal(beat.turns, 1);
  assert.equal(beat.lastSeen, at(60_000));
  assert.equal(beat.startedAt, T0);
  const ended = applyEvent(beat, payload({ event: 'SessionEnd', reason: 'prompt_input_exit', at: at(120_000) }), at(120_000));
  assert.equal(ended.endedAt, at(120_000));
  assert.equal(ended.reason, 'prompt_input_exit');
  // `claude --resume s1`: SessionStart(source: resume) for the same id — live again.
  const revived = applyEvent(ended, payload({ event: 'SessionStart', source: 'resume', at: at(300_000) }), at(300_000));
  assert.equal(revived.endedAt, undefined);
  assert.equal(revived.reason, undefined);
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

test('registry: a probe-detected death WRITES endedAt — so prune measures it by the ended rule, not the silence rule', () => {
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
    changes.length = 0;

    now += 1_000;
    assert.equal(reg.presence('gone'), 'ended');
    // The line that was missing. `presenceOf` answered `ended` and nothing
    // wrote it down, so `endedAt` stayed unset, `prune` had no ended-time to
    // measure, and the record fell to the SEVEN-DAY silence rule instead of
    // the 24-hour ended one — a session that finished this morning was still
    // on the page a week later.
    assert.equal(reg.get('gone')?.endedAt, new Date(now).toISOString());
    assert.equal(reg.get('gone')?.reason, 'process-gone');
    assert.deepEqual(changes, ['SessionEnd:gone'], 'the event the hook would have raised, had it been there to raise it');
    // Persisted, not merely in memory: a restart must not re-discover this.
    assert.equal(
      new SessionRegistry({ dir, now: () => new Date(now), pidAlive: null }).load().get('gone')?.endedAt,
      new Date(now).toISOString(),
    );

    // Written ONCE — every later read short-circuits on `record.endedAt`.
    const stamped = now;
    now += 5_000;
    assert.equal(reg.presence('gone'), 'ended');
    assert.equal(reg.get('gone')?.endedAt, new Date(stamped).toISOString(), 'the death does not keep moving');
    assert.deepEqual(changes, ['SessionEnd:gone'], 'and it is announced once');

    // And now prune can do its job on the right clock.
    now = stamped + RETAIN_ENDED_MS + 1;
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
    since: at(10_000), kind: 'permission', note: 'Claude needs your permission to use Bash',
  });
  assert.equal(notify({ notification_type: 'elicitation_dialog' }).waiting?.kind, 'elicitation');
  assert.equal(notify({ notification_type: 'idle_prompt' }).waiting?.kind, 'input');
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
