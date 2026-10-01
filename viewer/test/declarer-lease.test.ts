/**
 * One answer about the declarer (#49, control-tower phase 52).
 *
 * A hand terminal — one `claude`, pid 27615 — went through several session ids
 * on run 006df40b. Claude Code fires SessionEnd for the OLD id on a `/clear` or
 * a resume, while the process, and the phase lock the old id claimed, carry on.
 * The inbox gate asked the registry, heard `ended`, called the declarer gone and
 * boarded its `partial`; admission, two seconds later, named that same declarer
 * as the holder of the phase's lock and queued the boarding behind it. The run
 * waited on itself until somebody stopped it — twice in one day.
 *
 * Two readers of one claim disagreed. Now ONE `declarerPresence()` answers the
 * inbox gate (`declarerHold`), admission and the boarding belt-check (through
 * `lockPresenceFor`), and the runner's own resume gate. It is the registry's
 * word with one fact laid over it: an `ended` record the registry could not
 * give an identity (no `procStartedAt` — a hook event delivered late, a record
 * from before #73) whose pid still runs is `unknown`, and `unknown` is decided
 * by the lease.
 *
 *   DL-1  an unexpired lock naming the declaring session, with a live pid,
 *         HOLDS (`session-lease`) even when the registry says `ended` — and the
 *         inbox gate, admission's presence and the declarer read agree.
 *   DL-2  its `partial` stays in the inbox — refused once, kept, nothing
 *         boarded — until the lock is released; then the same file is acted on.
 *   DL-3  a lease that lapses frees it the same way; and an ended session whose
 *         process is gone holds nothing, lock or no lock.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { lockPath, readLock } = await import('../server/store.ts');
const { latestRun } = await import('../server/runner/state.ts');
const { inboxOutcomeFile, inboxOutcomePhase } = await import('../server/runner/outcome.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-09-23
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

type Svc = InstanceType<typeof Service>;
type Presence = 'live' | 'ended' | 'unknown';
/** The service's protected readers, reached the way the other service tests reach them. */
type Readers = {
  declarerPresence: (sessionId: string) => { presence: Presence; pid?: number };
  declarerHold: (slug: string, phase: number, sessionId: string | undefined) =>
    { why: 'session-live' | 'session-lease'; sessionId: string; pid?: number; lock?: string } | null;
  lockPresenceFor: (lock: { owner: string; session?: string }) => Presence;
  ingestOutcomeFile: (slug: string, file: string) => void;
};
const readers = (svc: Svc): Readers => svc as unknown as Readers;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-declarer-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# Phase 1 — schema\n', 'utf8');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const locksDir = (root: string) => join(root, 'docs', 'handoffs', 'alpha', '.locks');

/** A lock exactly as `phase-lock.sh claim --session` writes it. */
function claim(svc: Svc, root: string, phase: number, leaseFromNowS: number, session: string): string {
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), 'alpha', phase);
  mkdirSync(locksDir(root), { recursive: true });
  writeFileSync(file, [
    'slug=alpha', `phase=${phase}`, 'owner=mo@hand', 'host=test', `claimed_at=${now - 600}`,
    `lease_until=${now + leaseFromNowS}`, 'scope=app', `session=${session}`, '',
  ].join('\n'), 'utf8');
  svc.store?.refresh([locksDir(root)]);
  return file;
}

/** A service whose boarding is counted, never spawned — what a `partial` buys is a boarding. */
function service(root: string): { svc: Svc; boards: unknown[]; held: string[] } {
  const boards: unknown[] = [];
  const held: string[] = [];
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true, remoteHosts: [], remoteUsers: [],
  } as never);
  svc.push.announce = ((category: string, message: { title: string }) => {
    if (/A resume is held/.test(message.title)) held.push(category);
  }) as typeof svc.push.announce;
  svc.prefs.convergeEveryMs = 3_600_000;
  (svc as unknown as { startRun: unknown }).startRun = async (slug: string, opts: unknown) => { boards.push({ slug, opts }); return null; };
  assert.equal(svc.open(root).ok, true);
  return { svc, boards, held };
}

/**
 * The #49 shape: a session the registry could not stamp with an identity, that
 * has since ENDED by the hook's word while its pid runs on.
 *
 * BOTH events arrive past the stamp's freshness window (`IDENTITY_FRESH_MS`) —
 * a console that was busy or down while the hook wrote to its inbox. That is
 * load-bearing: the registry stamps `procStartedAt` on ANY fresh event of a
 * record with a pid, asynchronously, and once stamped it answers `unknown` for
 * a live process by itself (#73) — so a fresh SessionEnd made the held-partial
 * case pass even with `declarerPresence` reverted (red-proved, phase 52).
 * `stillUnstamped` asserts the precondition at the moment the gate reads.
 */
function endedButRunning(svc: Svc, root: string, sessionId: string, pid = process.pid): void {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  svc.ingestSessionEvent({ version: 1, session_id: sessionId, event: 'SessionStart', cwd: root, pid, source: 'startup', at: ago(120_000) });
  svc.ingestSessionEvent({ version: 1, session_id: sessionId, event: 'SessionEnd', cwd: root, reason: 'clear', at: ago(60_000) });
}

/** The registry's own word is still `ended`, with no identity to prove otherwise. */
function stillUnstamped(svc: Svc, sessionId: string): void {
  assert.equal(svc.sessions.presence(sessionId), 'ended', 'the registry\'s raw word is ended');
  assert.equal(svc.sessions.get(sessionId)?.procStartedAt, undefined, 'and it has no identity to overrule it');
}

/** `phase-outcome.sh partial` from a hand shell — the real script, no PE_OUTCOME_FILE — and the inbox file it wrote. */
function declarePartial(root: string, sessionId: string): string {
  const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: sessionId };
  delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
  execFileSync('/bin/bash', [join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'partial', '--reason', 'context'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const inbox = dirname(inboxOutcomeFile(root, 'alpha', 2));
  const landed = readdirSync(inbox).filter((name) => inboxOutcomePhase(name) === 2);
  assert.equal(landed.length, 1, `one declaration, one file: ${landed.join(', ')}`);
  return join(inbox, landed[0]);
}

const poll = async (check: () => boolean, ms = 12_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

/** A pid that ran and exited — a process that is certainly gone. */
function deadPid(): number {
  const child = spawnSync('/bin/sh', ['-c', 'exit 0']);
  assert.ok(child.pid && child.pid > 0);
  return child.pid;
}

test('DL-1: an unexpired lock naming the declarer, with a live pid, holds (session-lease) though the registry says ended — and every reader gives that one answer', async () => {
  const { root, cleanup } = scratch();
  const { svc } = service(root);
  try {
    await svc.bootSettled;
    const file = claim(svc, root, 2, 3600, 's-cleared');
    endedButRunning(svc, root, 's-cleared');

    // The precondition #49 needs, stated: the registry's raw word is `ended`,
    // and it has no identity to prove otherwise.
    stillUnstamped(svc, 's-cleared');

    const r = readers(svc);
    assert.deepEqual(r.declarerPresence('s-cleared'), { presence: 'unknown', pid: process.pid },
      'an ended id whose process still runs: nobody vouches either way, and the lease decides');
    const hold = r.declarerHold('alpha', 2, 's-cleared');
    assert.equal(hold?.why, 'session-lease', 'the inbox gate holds');
    assert.equal(hold?.sessionId, 's-cleared');
    assert.equal(hold?.pid, process.pid);
    assert.equal(hold?.lock, 'mo@hand');

    // Admission and the boarding belt-check read the lock's session through
    // `lockPresenceFor`: the same answer, so neither calls the claim debris
    // while the gate keeps the declaration waiting behind it.
    const lock = readLock(join(root, 'docs', 'handoffs'), 'alpha', 2)!;
    assert.equal(lock.session, 's-cleared');
    assert.equal(r.lockPresenceFor(lock), r.declarerPresence('s-cleared').presence);
    assert.notEqual(r.lockPresenceFor(lock), 'ended', 'not debris to admission either');

    // And the convergence loop, which the SessionEnd woke, released nothing.
    await svc.converger.idle();
    assert.ok(existsSync(file), 'the live declarer\'s lock stands');
    // Nor is a person handed a button that would: the inbox's lock rows read
    // `lockPresenceFor` too, so the claim is not offered for release as debris.
    const rows = (await svc.attention(true)).items.filter((item) => item.kind === 'lock' && item.slug === 'alpha');
    assert.deepEqual(rows.map((row) => row.title), [], 'no Release row for a claim its session still holds');

    // No session id at all holds nothing; a LIVE declarer holds as before.
    assert.equal(r.declarerHold('alpha', 2, undefined), null);
    svc.ingestSessionEvent({ version: 1, session_id: 's-typing', event: 'SessionStart', cwd: root, pid: process.pid, source: 'startup', at: new Date().toISOString() });
    assert.equal(r.declarerHold('alpha', 2, 's-typing')?.why, 'session-live');
  } finally {
    svc.close();
    cleanup();
  }
});

test('DL-2: the declarer\'s partial stays in the inbox — refused once, kept, nothing boarded — until the lock is released; then it is acted on', async () => {
  const { root, cleanup } = scratch();
  const { svc, boards, held } = service(root);
  try {
    await svc.bootSettled;
    const lockFile = claim(svc, root, 2, 3600, 's-cleared');
    endedButRunning(svc, root, 's-cleared');

    const file = declarePartial(root, 's-cleared');
    assert.ok(await poll(() => held.length === 1), 'the held resume is announced');
    stillUnstamped(svc, 's-cleared');
    assert.ok(existsSync(file), 'the declaration is KEPT until its lock goes');
    assert.equal(boards.length, 0, 'nothing boarded behind its own declarer');
    assert.equal(latestRun(root, 'alpha'), null, 'no run minted to queue on itself');

    // Every later sweep reads the same file and refuses it silently: once is the record.
    readers(svc).ingestOutcomeFile('alpha', file);
    readers(svc).ingestOutcomeFile('alpha', file);
    assert.equal(held.length, 1, 'said once, however many sweeps read it');
    assert.equal(boards.length, 0);

    // The declarer releases its claim (`phase-lock.sh release`): the next read acts.
    rmSync(lockFile);
    svc.store?.refresh([locksDir(root)]);
    readers(svc).ingestOutcomeFile('alpha', file);
    assert.ok(await poll(() => boards.length === 1 && !existsSync(file)), 'boarded once the lock is released, and the file consumed');
    const run = latestRun(root, 'alpha')!;
    assert.equal(run.phases['2'].declarations?.partial?.count, 1, 'acted on once');
  } finally {
    svc.close();
    cleanup();
  }
});

test('DL-3: a lease that lapses frees the declaration the same way — and an ended session whose process is gone holds nothing, lock or no lock', async () => {
  const { root, cleanup } = scratch();
  const { svc, boards, held } = service(root);
  try {
    await svc.bootSettled;
    const r = readers(svc);

    // Held while the lease runs…
    claim(svc, root, 2, 3600, 's-cleared');
    endedButRunning(svc, root, 's-cleared');
    const file = declarePartial(root, 's-cleared');
    assert.ok(await poll(() => held.length === 1), 'held while the lease runs');
    stillUnstamped(svc, 's-cleared');
    assert.equal(boards.length, 0);

    // …and free the moment it has lapsed, with nobody releasing anything.
    claim(svc, root, 2, -60, 's-cleared');
    assert.equal(r.declarerHold('alpha', 2, 's-cleared'), null, 'a lapsed lease holds nothing');
    r.ingestOutcomeFile('alpha', file);
    assert.ok(await poll(() => boards.length === 1 && !existsSync(file)), 'acted on once the lease lapsed');

    // A process that is gone: the registry's `ended` stands, and so the
    // unexpired lock it left is debris to every reader alike — the lease is
    // what bounds a WRONG answer, and here there is no doubt to bound.
    const pid = deadPid();
    claim(svc, root, 3, 3600, 's-gone');
    endedButRunning(svc, root, 's-gone', pid);
    assert.deepEqual(r.declarerPresence('s-gone'), { presence: 'ended', pid });
    assert.equal(r.declarerHold('alpha', 3, 's-gone'), null, 'an ended session whose process is gone holds nothing');
    const lock = readLock(join(root, 'docs', 'handoffs'), 'alpha', 3)!;
    assert.equal(r.lockPresenceFor(lock), 'ended', 'and admission agrees: that claim is debris');
  } finally {
    svc.close();
    cleanup();
  }
});
