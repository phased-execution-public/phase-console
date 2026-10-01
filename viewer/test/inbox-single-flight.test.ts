/**
 * The inbox is computed once per change, not once per request (control-tower
 * phase 56, #75).
 *
 * `GET /api/inbox` was the console's slowest read: 3 652 slow requests in 25 h
 * on the hub, p50 3.4 s, p90 29.4 s — every tab building its own inbox from a
 * dozen sources, with no memo and no single flight, and the build shelling
 * `--gate-status` once per gated phase.
 *
 *   IS-1  N concurrent requests at one revision build it ONCE, and a request
 *         at an unchanged revision builds nothing.
 *   IS-2  The memo is keyed on its inputs' revisions: an inbox-source event,
 *         an ack or the age bound moves it; and a request that arrives while a
 *         build for an OLDER revision is running is never served that build.
 *   IS-3  A request never shells the engine per gated phase: the gate answers
 *         are refilled off the request path, once per plan revision, one at a
 *         time — a slow gate read does not slow a request down.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { invalidate } from '../server/engine.ts';
import { INBOX_MAX_AGE_MS, Service } from '../server/service.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

const PLAN = `---
slug: SLUG
created: 2026-09-24
status: active
phases: 3
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | it works |
| 2 | second | 1 | — | app | it still works |
| 3 | third | 1 | — | app | it works too |

## Phases

### Phase 1 — first
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — second *(GATED)*
- **Size:** S
- **Gates (must clear first):** the operator says so
- **Gate-check:** manual the operator
- **Verification:** \`true\`

### Phase 3 — third *(GATED)*
- **Size:** S
- **Gates (must clear first):** the operator says so
- **Gate-check:** manual the operator
- **Verification:** \`true\`
`;

type Lib = { root: string; slug: string };

function library(t: { after(fn: () => void): void }, slug: string): Lib {
  const root = mkdtempSync(join(tmpdir(), 'pc-inbox-sf-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, slug };
}

/**
 * A scripts directory that logs every script EXECUTED with its arguments, and
 * can hold a `--gate-status` read for `slowGates` seconds — the spawn is the
 * thing counted, never a JS call (an ES module namespace cannot be spied on).
 */
function spyScripts(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-inbox-sf-spy-'));
  const log = join(dir, 'spawned.log');
  const slow = join(dir, 'slow-gates');
  writeFileSync(log, '');
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.sh')) continue;
    writeFileSync(
      join(dir, name),
      `#!/usr/bin/env bash\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n`
        + `case " $* " in *" --gate-status "*) [ -f ${JSON.stringify(slow)} ] && sleep "$(cat ${JSON.stringify(slow)})" ;; esac\n`
        + `exec bash ${JSON.stringify(join(SCRIPTS, name))} "$@"\n`,
      { mode: 0o755 },
    );
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    ran: (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    gateReads: (): string[] => readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('--gate-status')),
    slowGates: (seconds: number | null) => (seconds === null
      ? rmSync(slow, { force: true })
      : writeFileSync(slow, String(seconds))),
  };
}

type Internals = {
  buildAttention(all: boolean): Promise<unknown>;
  inboxMemo: Map<boolean, { at: number }>;
  inboxGateAnswers: Map<string, { revision: number; gates: Map<number, unknown> }>;
};

/** Open a console over the library, counting inbox builds. */
function console_(t: { after(fn: () => void): void }, lib: Lib, scriptsDir: string) {
  invalidate();
  const svc = new Service({ ...flags, scriptsDir } as never);
  const check = svc.open(lib.root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  const inner = svc as unknown as Internals;
  const real = inner.buildAttention.bind(svc);
  const counter = { builds: 0 };
  inner.buildAttention = (all: boolean) => { counter.builds++; return real(all); };
  return { svc, inner, counter };
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test('IS-1: N concurrent requests at one revision build the inbox once', async (t) => {
  const lib = library(t, 'is-one');
  const spy = spyScripts(t);
  const { svc, inner, counter } = console_(t, lib, spy.dir);

  const views = await Promise.all(Array.from({ length: 12 }, () => svc.attention()));
  assert.equal(counter.builds, 1, `12 concurrent requests built the inbox ${counter.builds} times`);
  assert.ok(views.every((view) => view === views[0]), 'every request was answered by the same build');

  // Let the background settle: the gate refill landing IS a change (IS-3).
  assert.ok(await until(() => inner.inboxGateAnswers.has(lib.slug), 15_000));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await svc.attention();
  const settled = counter.builds;
  for (let i = 0; i < 5; i++) await svc.attention();
  assert.equal(counter.builds, settled, 'a request at an unchanged revision builds nothing');

  // The two shapes are two memos: `?all=1` is a different view.
  await svc.attention(true);
  await svc.attention(true);
  assert.equal(counter.builds, settled + 1);
});

test('IS-2: the memo is keyed on its inputs’ revisions, and a newer request never gets an older build', async (t) => {
  const lib = library(t, 'is-two');
  const spy = spyScripts(t);
  const { svc, inner, counter } = console_(t, lib, spy.dir);

  const first = await svc.attention();
  assert.equal(counter.builds, 1);

  // An event the inbox is a function of moves the key.
  svc.emit('approval', { id: 'a-1' });
  const second = await svc.attention();
  assert.equal(counter.builds, 2, 'an inbox-source event invalidates the memo');
  assert.notEqual(second, first);

  // An event it is NOT a function of does not.
  svc.emit('terminal:output', { id: 't-1' });
  await svc.attention();
  assert.equal(counter.builds, 2, 'an unrelated event costs no build');

  // An ack is a change to the inbox too.
  svc.ackInbox('gate:is-two:2', 'test');
  await svc.attention();
  assert.equal(counter.builds, 3, 'an ack invalidates the memo');

  // A build in flight at an OLDER revision is never the answer for a newer one.
  svc.emit('lock', { slug: 'is-two' });
  const older = svc.attention();
  svc.emit('lock', { slug: 'is-two' });
  const newer = svc.attention();
  const alongside = svc.attention();
  const [a, b, c] = await Promise.all([older, newer, alongside]);
  assert.notEqual(b, a, 'the request at the newer revision was served the older build');
  assert.equal(c, b, 'two requests at the newer revision share one build');
  assert.equal(counter.builds, 5, 'one build per revision, not one per request');

  // The age bound catches what announces nothing.
  inner.inboxMemo.get(false)!.at -= INBOX_MAX_AGE_MS;
  await svc.attention();
  assert.equal(counter.builds, 6, 'a memo past INBOX_MAX_AGE_MS is rebuilt');
});

test('IS-3: a request never shells the engine per gated phase', async (t) => {
  const lib = library(t, 'is-three');
  const spy = spyScripts(t);
  const { svc, inner } = console_(t, lib, spy.dir);
  spy.slowGates(3);

  // The first request answers without waiting on a single gate read: they are
  // refilled off the request path, and this build uses what is held (nothing).
  const started = Date.now();
  await svc.attention();
  const took = Date.now() - started;
  assert.ok(took < 2_500, `the request waited ${took} ms — it was held behind a 3 s gate read`);

  // Many more requests while the refill runs: still one read per gated phase.
  svc.emit('approval', { id: 'b' });
  await Promise.all(Array.from({ length: 8 }, () => svc.attention()));
  svc.emit('approval', { id: 'c' });
  await svc.attention();

  assert.ok(await until(() => inner.inboxGateAnswers.has(lib.slug), 15_000), 'the gate answers landed');
  const reads = spy.gateReads();
  assert.equal(reads.length, 2, `one read per gated phase per revision, not per request:\n${reads.join('\n')}`);
  assert.ok(reads.some((line) => / --gate-status 2\b/.test(line)) && reads.some((line) => / --gate-status 3\b/.test(line)));
  assert.equal(inner.inboxGateAnswers.get(lib.slug)!.gates.size, 2);

  // Once held, a request builds from them and shells nothing more.
  spy.slowGates(null);
  svc.emit('approval', { id: 'd' });
  await svc.attention();
  assert.equal(spy.gateReads().length, 2, 'a request after the refill read no gate itself');
  assert.ok(existsSync(join(lib.root, 'docs', 'plans', `${lib.slug}.md`)));
});
