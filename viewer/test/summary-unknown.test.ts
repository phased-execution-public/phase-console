/**
 * SU-1..3 (control-tower phase 84, #96) — a board the engine could not read is
 * UNKNOWN, never zero progress.
 *
 * `GET /api/plans` summarised a plan whose board read had timed out as
 * `done: 0` and 0 %, while `boardText` in the same answer said 41/72: the
 * summary fell back to the empty board and presented it as a reading. Phase 55
 * (#44) served the page the last good board when THIS process had one — which
 * a restart lost, because the map lived in memory — and a read that FAILED
 * rather than timed out never got even that.
 *
 * SU-1  A failed or timed-out read with no good reading summarises
 *       `progress: 'unknown'` with `done` and `percent` null — never 0 / 0 %.
 * SU-2  The last good reading survives a restart: a second console over the
 *       same state serves it with its age, and the summary says `unknown`
 *       beside it (`lastGood`).
 * SU-3  The client renders the unknown state — one shared reading
 *       (`progressReading`) that the plan header and the list row both draw.
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-summary-unknown-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const engine = await import('../server/engine.ts');
const { progressReading } = await import('../shared/plan-vocab.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

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

function library(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-summary-unknown-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function addPlan(root: string, slug: string): void {
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase-01-first.md'), HANDOFF.replaceAll('SLUG', slug));
}

/**
 * A scripts folder whose board read misbehaves while `on()`: `hang` sleeps past
 * the ceiling (a timeout), `fail` answers the engine's own ERROR line and exits 1.
 * Every other read, and every other script, is the real one.
 */
function brokenBoards(t: { after(fn: () => void): void }, how: 'hang' | 'fail'): { dir: string; on(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-summary-unknown-scripts-'));
  const flag = join(dir, 'broken');
  const act = how === 'hang' ? 'exec sleep 30' : 'echo "ERROR: the plan table could not be parsed" >&2; exit 1';
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.sh')) continue;
    const trap = name === 'phase-graph.sh'
      ? `if [ -e ${JSON.stringify(flag)} ] && [ "$2" = "--memory-block" ]; then ${act}; fi\n`
      : '';
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${trap}exec bash ${JSON.stringify(join(SCRIPTS, name))} "$@"\n`, { mode: 0o755 });
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, on: () => writeFileSync(flag, '') };
}

function service(t: { after(fn: () => void): void }, root: string, scriptsDir = SCRIPTS) {
  const svc = new Service({ ...flags, scriptsDir } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

type Summary = {
  progress?: string; done: number | null; percent: number | null; phases: number;
  lastGood?: { done: number; phases: number; percent: number; at: number; ageMs: number };
  boardStale?: { at: number; ageMs: number }; engineError?: string;
};

function assertNeverZero(summary: Summary, where: string): void {
  assert.equal(summary.progress, 'unknown', `${where}: an unreadable board is unknown`);
  assert.notEqual(summary.done, 0, `${where}: never done 0 — nothing was read`);
  assert.notEqual(summary.percent, 0, `${where}: never 0 % — nothing was read`);
}

test('SU-1 (#96): a board read that TIMES OUT with no good reading summarises as unknown — done and percent null, never 0 / 0 %, in the detail and the list alike', async (t) => {
  const root = library(t);
  addPlan(root, 'never-read');
  const slow = brokenBoards(t, 'hang');
  const svc = service(t, root, slow.dir);
  slow.on();
  engine.setEngineTimeouts({ board: 1000 });
  t.after(() => engine.setEngineTimeouts(null));

  const detail = await svc.detail('never-read');
  assert.ok(detail);
  const summary = detail.summary as unknown as Summary;
  assertNeverZero(summary, 'the plan detail');
  assert.equal(summary.done, null);
  assert.equal(summary.percent, null);
  assert.equal(summary.lastGood, undefined, 'no good reading was ever taken, so none is invented');
  assert.match(summary.engineError ?? '', /timed out/, 'the reason stays on the summary');

  const listed = (await svc.summaries()).find((s) => s.slug === 'never-read') as unknown as Summary | undefined;
  assert.ok(listed, 'the list carries the plan');
  assertNeverZero(listed, 'GET /api/plans');
});

test('SU-1 (#96): a board read that FAILS — the engine answered an error, not a timeout — is unknown too, with the last good reading beside it', async (t) => {
  const root = library(t);
  addPlan(root, 'fails-later');
  const failing = brokenBoards(t, 'fail');
  const svc = service(t, root, failing.dir);

  const good = await svc.detail('fails-later');
  assert.ok(good);
  const read = good.summary as unknown as Summary;
  assert.equal(read.progress, undefined, 'a board that answered is not unknown');
  assert.equal(read.done, 1);
  assert.equal(read.percent, 50);

  failing.on();
  const path = join(root, 'docs', 'plans', 'fails-later.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  (svc as unknown as { onChange(paths: string[]): void }).onChange([path]);

  const failed = await svc.detail('fails-later');
  assert.ok(failed);
  const summary = failed.summary as unknown as Summary;
  assertNeverZero(summary, 'a failed read');
  assert.match(summary.engineError ?? '', /could not be parsed/, 'the engine\'s own reason is kept');
  assert.ok(summary.lastGood, 'the last good reading rides beside the unknown');
  assert.deepEqual(
    { done: summary.lastGood.done, phases: summary.lastGood.phases, percent: summary.lastGood.percent },
    { done: 1, phases: 2, percent: 50 },
  );
  assert.ok(summary.lastGood.at <= Date.now() && summary.lastGood.ageMs >= 0, 'with when it was read, and its age');
});

test('SU-2 (#96): the last good reading survives a RESTART — a second console over the same state serves it with its age, and the summary says unknown beside it', async (t) => {
  const root = library(t);
  addPlan(root, 'restarted');

  // The first console reads the board once, well.
  const first = new Service({ ...flags } as never);
  assert.equal(first.open(root).ok, true);
  const good = await first.detail('restarted');
  assert.ok(good);
  assert.equal((good.summary as unknown as Summary).done, 1);
  const goodStates = good.phases.map((p) => [p.phase, p.state]);
  first.close();

  // The console restarts onto a machine too busy to read the plan.
  const slow = brokenBoards(t, 'hang');
  slow.on();
  engine.setEngineTimeouts({ board: 1000 });
  t.after(() => engine.setEngineTimeouts(null));
  const second = service(t, root, slow.dir);

  const detail = await second.detail('restarted');
  assert.ok(detail);
  const summary = detail.summary as unknown as Summary;
  assert.equal(summary.progress, 'unknown', 'the read timed out: progress is unknown');
  assert.ok(summary.lastGood, 'the reading the previous process took is carried across the restart');
  assert.deepEqual(
    { done: summary.lastGood.done, phases: summary.lastGood.phases, percent: summary.lastGood.percent },
    { done: 1, phases: 2, percent: 50 },
  );
  assert.ok(summary.lastGood.ageMs >= 0 && summary.lastGood.at <= Date.now());
  assert.ok(summary.boardStale, 'and the page is told its board is the stale one');
  assert.deepEqual(detail.phases.map((p) => [p.phase, p.state]), goodStates,
    'the phases drawn are the last good board\'s, never the empty board\'s');
  assert.notEqual(summary.done, 0);

  const listed = (await second.summaries()).find((s) => s.slug === 'restarted') as unknown as Summary | undefined;
  assert.ok(listed?.lastGood, 'the list carries the last good reading too');
  assert.equal(listed.progress, 'unknown');
});

test('SU-3 (#96): progressReading — the one reading the header and the row draw — says unknown with the last good reading and its age, and never 0 %', () => {
  const now = Date.parse('2026-09-24T17:00:00Z');
  const known = progressReading({ phases: 72, done: 41, percent: 57 }, now);
  assert.equal(known.known, true);
  assert.equal(known.text, '41/72 · 57%');

  const blank = progressReading({ phases: 72, done: null, percent: null, progress: 'unknown' }, now);
  assert.equal(blank.known, false);
  assert.match(blank.text, /unknown/i);
  assert.doesNotMatch(blank.text, /\b0\/72\b|\b0 ?%/, 'nothing was read, so nothing is claimed');

  const withLast = progressReading({
    phases: 72, done: 41, percent: 57, progress: 'unknown',
    lastGood: { done: 41, phases: 72, percent: 57, at: now - 3 * 3_600_000, ageMs: 3 * 3_600_000 },
  }, now);
  assert.equal(withLast.known, false);
  assert.match(withLast.text, /unknown/i);
  assert.match(withLast.text, /41\/72/);
  assert.match(withLast.text, /57%/);
  assert.match(withLast.text, /3h/, 'with its age');

  // A client that ignored the word would still be told: the summary's numbers are absent, not zero.
  const legacy = progressReading({ phases: 72, done: null, percent: null }, now);
  assert.equal(legacy.known, false, 'a null count is not a reading');

  const client = join(HERE, '..', 'client', 'src', 'features', 'plans');
  for (const file of ['header.tsx', 'row.tsx']) {
    const source = readFileSync(join(client, file), 'utf8');
    assert.match(source, /progressReading\(/, `${file} draws the shared reading, not its own 0 %`);
  }
});
