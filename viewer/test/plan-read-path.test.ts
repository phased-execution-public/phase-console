/**
 * PR-1 (control-tower phase 55, #44) — a lock write is not a plan write.
 *
 * Every phase lock lives at `docs/handoffs/<slug>/.locks/phase-NN.lock`, under
 * the directory the docs watcher watches, and a live autopilot run claims,
 * refreshes and releases one every few minutes. Each of those writes bumped the
 * plan's revision and dropped every cached engine answer for it — although no
 * script the revision keys (`phase-graph.sh`, `validate.sh`) reads `.locks/` —
 * so the plan an autopilot was working, the one a person is most likely to
 * open, was the one whose cache was always newest-dead: a cold 10–55 s page.
 *
 * What must hold: a batch that touches a plan ONLY through its `.locks/` keeps
 * the plan's revision and its cached board (no `phase-graph.sh` spawns), while
 * the plan's own lock list, and the lock ledger's observer, still see it. A
 * handoff write still moves the revision, and a directory flush still forgets
 * everything, since it knows something changed but not what.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-planread-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { lockOnlySlugs, isLockPath } = await import('../server/store.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };
const SLUG = 'plan-read';

const PLAN = `---
slug: ${SLUG}
created: 2026-09-24
status: active
phases: 2
---

# ${SLUG}

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | it works |
| 2 | second | 1 | — | app | it still works |

## Phases

### Phase 1 — first
- **Size:** S

### Phase 2 — second
- **Size:** S
`;

const LOCK = (phase: number, owner: string) =>
  `slug=${SLUG}\nphase=${phase}\nowner=${owner}\nclaimed_at=1790241174\nlease_until=4102444800\nscope=app\n`;

function library(t: { after(fn: () => void): void }): { root: string; handoffs: string; locks: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-planread-'));
  const handoffs = join(root, 'docs', 'handoffs', SLUG);
  const locks = join(handoffs, '.locks');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${SLUG}.md`), PLAN);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, handoffs, locks };
}

/** A scripts folder that logs every script it EXECUTES, then runs the real one (read-path.test's spy). */
function spyScripts(t: { after(fn: () => void): void }): { dir: string; ran(): string[]; clear(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-planread-spy-'));
  const log = join(dir, 'spawned.log');
  writeFileSync(log, '');
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.sh')) continue;
    writeFileSync(join(dir, name),
      `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(log)}\n`
        + `exec bash ${JSON.stringify(join(SCRIPTS, name))} "$@"\n`, { mode: 0o755 });
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, ran: () => readFileSync(log, 'utf8').split('\n').filter(Boolean), clear: () => writeFileSync(log, '') };
}

function service(t: { after(fn: () => void): void }, root: string, scriptsDir: string) {
  const svc = new Service({ ...flags, scriptsDir } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

/** The watcher's own entry point, called directly so no debounce or fs-event timing is in the proof. */
function changed(svc: unknown, paths: string[]): void {
  (svc as { onChange(paths: string[]): void }).onChange(paths);
}

test('PR-1a: lockOnlySlugs keeps exactly the plans a batch touched only through .locks/', () => {
  const slugOf = (p: string) => (p.startsWith('/d/h/') ? p.split('/')[3] : undefined);
  assert.equal(isLockPath('/d/h/a/.locks/phase-01.lock'), true);
  assert.equal(isLockPath('/d/h/a/.locks'), true);
  assert.equal(isLockPath('/d/h/a/.locks/phase-01.lock.tmp.123'), true, 'phase-lock.sh writes a temp file, then renames');
  assert.equal(isLockPath('/d/h/a/phase-01-first.md'), false);
  assert.equal(isLockPath('/d/h/a/locks.md'), false);
  assert.deepEqual([...lockOnlySlugs(['/d/h/a/.locks/phase-01.lock', '/d/h/b/.locks/phase-02.lock'], slugOf)].sort(), ['a', 'b']);
  assert.deepEqual([...lockOnlySlugs(['/d/h/a/.locks/phase-01.lock', '/d/h/a/phase-01-first.md'], slugOf)], [],
    'a lock AND a handoff of the same plan is a plan write');
  assert.deepEqual([...lockOnlySlugs(['/d/h/a/.locks/phase-01.lock', '/d/plans'], slugOf)], [],
    'a path no plan owns is a directory flush: nothing may be kept');
});

test('PR-1b: a .locks write keeps the revision and the cached board, and the page still shows the lock', async (t) => {
  const lib = library(t);
  const spy = spyScripts(t);
  const svc = service(t, lib.root, spy.dir);

  const first = await svc.detail(SLUG);
  assert.ok(first, 'the plan must render');
  // The render scheduled its lint for a later turn; let it land (joining it,
  // not starting a second) so its spawn is not mistaken for the lock write's.
  await svc.lint(SLUG);
  const revision = svc.store!.get(SLUG)!.revision;
  assert.equal(first.locks.length, 0);

  // A live run claims phase 1: phase-lock.sh writes a temp file and renames it.
  spy.clear();
  const lock = join(lib.locks, 'phase-01.lock');
  writeFileSync(lock, LOCK(1, 'autopilot/test'));
  changed(svc, [`${lock}.tmp.4242`, lock]);

  assert.equal(svc.store!.get(SLUG)!.revision, revision, 'a lock write moved the plan revision');
  const second = await svc.detail(SLUG);
  assert.ok(second);
  assert.deepEqual(spy.ran().filter((s) => s === 'phase-graph.sh' || s === 'validate.sh'), [],
    `the lock write dropped the cached engine answers: re-ran ${spy.ran().join(', ')}`);
  assert.deepEqual(second.locks.map((l) => [l.phase, l.owner]), [[1, 'autopilot/test']],
    'the page must still show the lock the store re-read');

  // …and its release, the same.
  rmSync(lock);
  changed(svc, [lock]);
  assert.equal(svc.store!.get(SLUG)!.revision, revision, 'a lock release moved the plan revision');
  assert.equal((await svc.detail(SLUG))!.locks.length, 0);
  assert.deepEqual(spy.ran().filter((s) => s === 'phase-graph.sh'), [], 'the release re-ran the board');
});

test('PR-1c: a handoff write still moves the revision and re-reads the board; a directory flush still forgets', async (t) => {
  const lib = library(t);
  const spy = spyScripts(t);
  const svc = service(t, lib.root, spy.dir);
  await svc.detail(SLUG);
  const revision = svc.store!.get(SLUG)!.revision;

  spy.clear();
  const handoff = join(lib.handoffs, 'phase-01-first.md');
  writeFileSync(handoff, '---\nplan: docs/plans/plan-read.md\nphase: 1\ntitle: first\nstatus: in-progress\n---\n\n# Phase 1\n');
  const lock = join(lib.locks, 'phase-01.lock');
  writeFileSync(lock, LOCK(1, 'autopilot/test'));
  changed(svc, [lock, handoff]);
  const moved = svc.store!.get(SLUG)!.revision;
  assert.notEqual(moved, revision, 'a handoff is what the engine reads: its write must move the revision');
  const detail = await svc.detail(SLUG);
  assert.ok(detail);
  assert.ok(spy.ran().includes('phase-graph.sh'), 'a moved revision must re-read the board');
  assert.equal(detail.phases.find((p) => p.phase === 1)?.state, 'in-progress', 'the re-read board is the new one');

  spy.clear();
  changed(svc, [join(lib.root, 'docs', 'handoffs')]);
  await svc.detail(SLUG);
  assert.ok(spy.ran().includes('phase-graph.sh'),
    'a directory flush knows something changed but not what — it must still forget the cached board');
});

test('PR-1d: the lock observers still see a lock-only batch — the scheduler is polled', async (t) => {
  const lib = library(t);
  const svc = service(t, lib.root, SCRIPTS);
  let polled = 0;
  const scheduler = svc.scheduler as unknown as { poll(): void };
  const poll = scheduler.poll.bind(scheduler);
  scheduler.poll = () => { polled++; poll(); };
  const lock = join(lib.locks, 'phase-02.lock');
  writeFileSync(lock, LOCK(2, 'someone/else'));
  changed(svc, [lock]);
  assert.equal(polled, 1, 'a lock write must still poke the scheduler — a foreign release is an admission');
});
