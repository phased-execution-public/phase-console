/**
 * The plan-detail read path: what it must NOT do.
 *
 * Opening a plan in the console was slow, and the first open of an OPEN plan
 * was the worst case by a wide margin. Two causes, measured on the live hub
 * rather than guessed at:
 *
 *  - `detail()` awaited `lint(slug)`, which shells `validate.sh`, which
 *    re-enters `phase-graph.sh` once per handoff file, serially, each re-parsing
 *    the whole plan and every handoff. **11.27 s** on the 22-handoff plan
 *    somebody was actually working on, against 0.58 s for a closed one — closed
 *    plans short-circuit and never walk. The page paid all of it before it
 *    could paint a table the lint does not even appear in.
 *  - Every cache in the path stored the RESOLVED value, so it existed only once
 *    the work had finished. N concurrent opens of one uncached plan therefore
 *    all missed and all spawned their own engine processes.
 *
 * Each test here fails against the code as it was. They are about ABSENCE — no
 * `validate.sh`, no duplicate spawn, no revision bump — which is why they count
 * subprocesses and object identities rather than asserting on rendered output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-readpath-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Store } = await import('../server/store.ts');
const { checkRoot } = await import('../server/config.ts');
const engine = await import('../server/engine.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

/* ------------------------------------------------------------------ *
 * A scratch library with one OPEN, fully-handed-off plan
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: SLUG
created: 2026-08-01
status: active
phases: 2
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

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

const HANDOFF = `---
plan: docs/plans/SLUG.md
phase: 1
title: first
status: complete
completed: 2026-08-01
next_phase: 2
depends_on: []
blocks: [2]
parallel_safe: []
skills_used: []
key_files: []
memory: project_SLUG
---

# Phase 1 → next handoff: first

## What this phase did
Enough of it to be a handoff.

## State now (verified)
Committed.

## Files changed
None worth naming.

## Key decisions / gotchas
None.

## ▶ Start next phase(s) (paste into fresh sessions)
See the plan.

## Outstanding / blockers
None.
`;

function library(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-readpath-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addPlan(root: string, slug: string): void {
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase-01-first.md'), HANDOFF.replaceAll('SLUG', slug));
}

function service(t: { after(fn: () => void): void }, root: string, scriptsDir = SCRIPTS) {
  const svc = new Service({ ...flags, scriptsDir } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

/**
 * A scripts directory that records every script actually EXECUTED, then hands
 * the work to the real one.
 *
 * Counting spawns rather than calls, deliberately. The criteria are about
 * processes — "opening a plan spawns no `validate.sh`", "ten opens spawn one
 * set of engine processes" — and a JS-level spy could be satisfied by a change
 * that merely renamed the call while still starting the child. It also cannot
 * be done from a test: an ES module namespace is frozen, so `engine.run` is not
 * assignable.
 *
 * Each shim `exec`s the real script by its real path, so `$0` still resolves to
 * the skill's own `scripts/` and everything a script sources from a sibling
 * keeps working. The answers are the engine's own, unaltered.
 */
function spyScripts(t: { after(fn: () => void): void }): { dir: string; ran(): string[]; clear(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-readpath-spy-'));
  const log = join(dir, 'spawned.log');
  writeFileSync(log, '');
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.sh')) continue;
    const shim = join(dir, name);
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(log)}\n`
        + `exec bash ${JSON.stringify(join(SCRIPTS, name))} "$@"\n`,
      { mode: 0o755 },
    );
  }
  // Non-script assets a script may look for beside itself (`mcp.env`,
  // `verify.env`, …) are resolved through the real `$0`, so nothing else has to
  // be copied here.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    ran: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    clear: () => writeFileSync(log, ''),
  };
}

/* ------------------------------------------------------------------ *
 * EC1 + EC2 — the validator is off the read path, and still reachable
 * ------------------------------------------------------------------ */

test('EC1: opening an OPEN plan runs no validate.sh', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addPlan(lib.root, 'read-path-open');
  engine.invalidate();

  const spy = spyScripts(t);
  const svc = service(t, lib.root, spy.dir);
  const detail = await svc.detail('read-path-open');

  assert.ok(detail, 'the plan must still render');
  assert.deepEqual(
    spy.ran().filter((s) => s === 'validate.sh'), [],
    'opening a plan shelled validate.sh before it could answer. That walk is O(handoffs²) — '
      + '11.27 s on the live 22-handoff plan — and the page it blocks does not show the lint. '
      + 'It belongs behind GET /api/plans/<slug>/lint and on the `plan:lint` event, not in '
      + 'detail()\'s await set and not inline in the same turn: starting it inline would queue '
      + 'the response behind the walk in the engine\'s 8-slot semaphore, which is most of the '
      + 'cost back.',
  );
  assert.ok(spy.ran().length > 0, 'the spy must still see the engine processes detail() DOES start');

  // …and it is not silently dropped either. The lint follows, off the request,
  // and reaches the page as `plan:lint`.
  const pushed = await new Promise<{ slug: string; lint: { summary: string } } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const off = svc.onEvent((name, data) => {
      if (name !== 'plan:lint') return;
      clearTimeout(timer);
      off();
      resolve(data as { slug: string; lint: { summary: string } });
    });
  });
  assert.ok(pushed, 'the deferred lint never arrived — off the read path must not mean discarded');
  assert.equal(pushed.slug, 'read-path-open');
  assert.ok(pushed.lint.summary.length > 0, 'and the RESULT rides the event, so the client need not ask again');
  assert.ok(
    spy.ran().includes('validate.sh'),
    'the lint is still the engine\'s own answer — this phase moved WHEN validate.sh runs, never whether',
  );
});

test('EC2: the lint route returns the same result the page renders', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addPlan(lib.root, 'read-path-lint');
  engine.invalidate();

  const svc = service(t, lib.root);

  // Nothing has asked yet, so the first open cannot have it — and says so
  // rather than inventing one.
  const cold = await svc.detail('read-path-lint');
  assert.equal(cold!.lint, null, 'a cold open reports no lint yet, never a fabricated verdict');

  // What the route answers is the real thing, computed and awaited.
  const viaRoute = await svc.lint('read-path-lint');
  assert.ok(viaRoute, 'GET /api/plans/<slug>/lint still answers');
  assert.equal(typeof viaRoute.ok, 'boolean');
  assert.ok(viaRoute.summary.length > 0, 'and it carries the engine\'s own summary line');

  // …and once it has landed, the page carries it: same revision, same object.
  const warm = await svc.detail('read-path-lint');
  assert.equal(
    warm!.lint, viaRoute,
    'the second open must serve the lint the route computed — the identical object, since '
      + 'both read one revision-keyed entry. A different object means detail() re-ran it.',
  );
});

/* ------------------------------------------------------------------ *
 * EC3 — concurrent opens share one set of processes
 * ------------------------------------------------------------------ */

test('EC3: ten concurrent opens of one cold plan spawn one set of engine processes', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addPlan(lib.root, 'read-path-herd');
  engine.invalidate();

  const spy = spyScripts(t);
  const svc = service(t, lib.root, spy.dir);

  const details = await Promise.all(
    Array.from({ length: 10 }, () => svc.detail('read-path-herd')),
  );
  assert.ok(details.every(Boolean), 'all ten must render');

  // The comparison that matters is against ONE open of the same plan, so the
  // number is derived from this fixture rather than hard-coded — a phase that
  // adds an engine read should not have to come and edit an integer here.
  //
  // `validate.sh` is excluded from both counts because it is no longer part of
  // an open: it is scheduled on a later turn (EC1), so whether one has landed
  // by the time either count is taken is a race, not a fact about the request.
  const engineRuns = (): number => spy.ran().filter((s) => s !== 'validate.sh').length;

  const concurrent = engineRuns();
  spy.clear();
  engine.invalidate();
  svc.invalidateAll();
  await svc.detail('read-path-herd');
  const single = engineRuns();

  assert.ok(single > 0, 'a cold open must run something, or this test proves nothing');
  assert.equal(
    concurrent, single,
    `ten concurrent opens ran ${concurrent} engine processes where one open runs ${single}. `
      + 'The caches store the RESOLVED value only if the promise is not stored first: every '
      + 'caller that arrives before the first one finishes must join it, not start its own.',
  );
});

/* ------------------------------------------------------------------ *
 * EC4 — the engine cache is bounded
 * ------------------------------------------------------------------ */

test('EC4: the engine cache evicts by age', async (t) => {
  engine.invalidate();
  const previous = engine.setEngineCacheLimits({ ttlMs: 60_000 });
  t.after(() => { engine.setEngineCacheLimits(previous); engine.invalidate(); });

  const root = mkdtempSync(join(tmpdir(), 'pc-readpath-ttl-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = { scriptsDir: SCRIPTS, root };
  const key = { slug: 'no-such-plan-ttl', revision: 1 };

  const first = await engine.run(opts, 'phase-graph.sh', [key.slug, '--qa-mode'], key);
  const immediate = await engine.run(opts, 'phase-graph.sh', [key.slug, '--qa-mode'], key);
  assert.equal(immediate, first, 'inside the TTL the cached object is returned');

  // The clock is moved by narrowing the LIMIT rather than by sleeping.
  // Sleeping past a short TTL is a race against machine load — the entry is a
  // subprocess old by the time the second read is even issued — and it is the
  // age COMPARISON being tested, not setTimeout.
  engine.setEngineCacheLimits({ ttlMs: 1 });
  const afterTtl = await engine.run(opts, 'phase-graph.sh', [key.slug, '--qa-mode'], key);
  assert.notEqual(
    afterTtl, first,
    'an entry outlived its TTL. Without an age bound, a plan whose revision never moves keeps '
      + 'its answer for as long as the process lives.',
  );
});

test('EC4: the engine cache evicts by size and by count when overfilled', async (t) => {
  engine.invalidate();
  const previous = engine.setEngineCacheLimits({ maxEntries: 3, maxBytes: 1024 });
  t.after(() => { engine.setEngineCacheLimits(previous); engine.invalidate(); });

  const root = mkdtempSync(join(tmpdir(), 'pc-readpath-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = { scriptsDir: SCRIPTS, root };

  // Ten distinct keys through a three-entry cache.
  for (let i = 0; i < 10; i++) {
    await engine.run(
      opts, 'phase-graph.sh', [`no-such-plan-cap-${i}`, '--qa-mode'],
      { slug: `no-such-plan-cap-${i}`, revision: 1 },
    );
  }

  const stats = engine.engineCacheStats();
  assert.ok(
    stats.entries <= 3,
    `the cache holds ${stats.entries} entries against a cap of 3 — it is not bounded by count`,
  );
  assert.ok(
    stats.bytes <= stats.limits.maxBytes,
    `the cache holds ${stats.bytes} bytes against a cap of ${stats.limits.maxBytes} — it is not bounded by size`,
  );
  assert.ok(stats.bytes >= 0, 'the byte counter must never go negative — that is an accounting leak');
});

/* ------------------------------------------------------------------ *
 * EC5 — forget() reaches the per-phase QA keys
 * ------------------------------------------------------------------ */

test('EC5: forget(slug) drops the per-phase QA entries, not just the plan-wide one', async (t) => {
  const lib = library();
  t.after(() => lib.cleanup());
  addPlan(lib.root, 'read-path-qa');
  engine.invalidate();

  const svc = service(t, lib.root);
  const maps = svc as unknown as { qaModes: Map<string, unknown>; forget(slug: string): void };

  // The precondition is about `forget()`, not about surviving a boot. Ordering
  // the reads so phase 1 lands last was a first attempt at the same flake and
  // is not enough on its own: any watcher flush inside ANY of these awaits
  // drops the entry, and a serial suite makes that window land differently
  // again. So wait for the boot to settle first, and then re-read until the
  // entry is actually there — the contract under test begins after that.
  await svc.bootSettled;
  await svc.qaMode('read-path-qa');
  await svc.qaMode('read-path-qa', 2);
  const deadline = Date.now() + 2_000;
  do {
    await svc.qaMode('read-path-qa', 1);
  } while (!maps.qaModes.has('read-path-qa#1') && Date.now() < deadline);
  assert.ok(maps.qaModes.has('read-path-qa#1'), 'the per-phase read must be cached, or this proves nothing');

  maps.forget('read-path-qa');

  assert.deepEqual(
    [...maps.qaModes.keys()].filter((k) => k.startsWith('read-path-qa')), [],
    'a per-phase QA entry survived forget(). `qaMode(slug, phase)` writes `<slug>#<phase>` and '
      + 'forget deleted only the bare `<slug>`, so a plan whose phases state their own '
      + '`- **QA:** on|off` kept a stale regime for the life of the process — and deriveEvidence '
      + 'reads that word to decide whether a recorded verdict holds dependents.',
  );
});

/* ------------------------------------------------------------------ *
 * EC6 — a directory-only flush does not invalidate the world
 * ------------------------------------------------------------------ */

test('EC6: a watcher flush naming only a directory does not bump an unrelated plan', () => {
  const lib = library();
  try {
    addPlan(lib.root, 'read-path-quiet');
    addPlan(lib.root, 'read-path-other');
    const check = checkRoot(lib.root);
    assert.equal(check.ok, true);

    const store = new Store(check);
    store.scan();
    const before = new Map(store.list().map((r) => [r.slug, r.revision]));
    assert.equal(before.size, 2);

    // Exactly what `DocsWatcher.flushFromDisk()` passes: the WATCHED
    // DIRECTORIES, not a file. It fires from the 60 s deaf-watch heartbeat,
    // which is a timer — so this used to cold-start every plan in the library
    // once a minute on a console nobody was touching.
    store.refresh([check.plansDir!, check.handoffsDir!]);

    for (const record of store.list()) {
      assert.equal(
        record.revision, before.get(record.slug),
        `${record.slug}'s revision moved on a flush that named no file of its own. A rescan is `
          + 'the right answer to "something changed and we do not know what" — claiming every '
          + 'plan changed is not, and the revision is the key every cached engine answer hangs from.',
      );
    }

    // …and the rescan is still a rescan: a plan that really moved takes a new
    // revision, or this would be a cache that never invalidates.
    writeFileSync(
      join(lib.root, 'docs', 'plans', 'read-path-other.md'),
      `${PLAN.replaceAll('SLUG', 'read-path-other')}\n<!-- edited -->\n`,
    );
    store.refresh([check.plansDir!, check.handoffsDir!]);
    assert.notEqual(
      store.get('read-path-other')!.revision, before.get('read-path-other'),
      'the plan that was actually edited must take a fresh revision',
    );
    assert.equal(
      store.get('read-path-quiet')!.revision, before.get('read-path-quiet'),
      'and its neighbour must not',
    );
  } finally {
    lib.cleanup();
  }
});
