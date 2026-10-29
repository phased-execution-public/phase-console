/**
 * An approved gate leaves Your turn — and approving it costs one plan's
 * re-read, not the portfolio's (2026-10-20, hub: gate 16 of tradingview-charts
 * was approved four times from its card, and the card stayed every time).
 *
 *   GC-1  Approved on its card, the gate's row is gone from the very next
 *         inbox — never one beat later, never at the next unrelated write.
 *   GC-2  Approved OUTSIDE the console (a terminal's `gate-approve.sh`, a
 *         session's row), the row leaves once the watcher has seen
 *         `gate-status.md` — the plan's revision moves with that file.
 *   GC-3  A gate press re-reads its own plan only: another plan's board is
 *         answered from its cache afterwards, never re-shelled.
 *   GC-4  So does an option bound to the inbox's ack (a conflict's *Leave
 *         them*): its settled record is kept and the page told, and no plan's
 *         board is shelled again for it.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { invalidate } from '../server/engine.ts';
import { Service } from '../server/service.ts';
import { planWrite, runWrite } from '../server/writes.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

const GATED = `---
slug: SLUG
created: 2026-10-20
status: active
phases: 2
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | release | — | — | app | it ships |
| 2 | after | 1 | — | app | it works |

## Phases

### Phase 1 — release *(GATED)*
- **Size:** S
- **Gates (must clear first):** the owner approves the release
- **Gate-check:** manual the owner approves the release
- **Verification:** \`true\`

### Phase 2 — after
- **Size:** S
- **Verification:** \`true\`
`;

const PLAIN = `---
slug: SLUG
created: 2026-10-20
status: active
phases: 1
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | only | — | — | app | it works |

## Phases

### Phase 1 — only
- **Size:** S
- **Verification:** \`true\`
`;

type Lib = { root: string };

function library(t: { after(fn: () => void): void }, plans: Record<string, string>): Lib {
  const root = mkdtempSync(join(tmpdir(), 'pc-gate-card-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  for (const [slug, text] of Object.entries(plans)) {
    mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), text.replaceAll('SLUG', slug));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root };
}

/** A scripts directory that logs every script it runs, with its arguments — the spawn is what is counted. */
function spyScripts(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gate-card-spy-'));
  const log = join(dir, 'spawned.log');
  writeFileSync(log, '');
  for (const name of readdirSync(SCRIPTS)) {
    if (!name.endsWith('.sh')) continue;
    writeFileSync(
      join(dir, name),
      `#!/usr/bin/env bash\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(log)}\n`
        + `exec bash ${JSON.stringify(join(SCRIPTS, name))} "$@"\n`,
      { mode: 0o755 },
    );
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, ran: (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

type Internals = {
  inboxGateAnswers: Map<string, { revision: number; gates: Map<number, unknown> }>;
  onChange(paths: string[]): void;
};

function open(t: { after(fn: () => void): void }, lib: Lib, scriptsDir = SCRIPTS) {
  invalidate();
  const svc = new Service({ ...flags, scriptsDir } as never);
  const check = svc.open(lib.root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return { svc, inner: svc as unknown as Internals };
}

async function until(predicate: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const gateRow = async (svc: Service, slug: string) =>
  (await svc.attention(true)).items.find((item) => item.kind === 'gate' && item.slug === slug && item.phase === 1);

/** The inbox asks for its gate answers off the request path: wait until the gate's row is raised. */
async function raised(svc: Service, slug: string): Promise<void> {
  assert.ok(await until(async () => Boolean(await gateRow(svc, slug)), 15_000), 'the shut gate asks a person');
}

test('GC-1: a gate approved on its card is gone from the very next inbox', async (t) => {
  const lib = library(t, { 'gc-one': GATED });
  const { svc } = open(t, lib);
  await raised(svc, 'gc-one');

  const approved = await svc.approveGate('gc-one', 1, { approve: true, by: 'operator', door: 'local' });
  assert.equal(approved.ok, true, approved.detail);
  assert.equal(approved.gate?.clear, true);

  assert.equal(await gateRow(svc, 'gc-one'), undefined, 'the approved gate still asks for approval');
  // …and it stays gone once every background read has landed.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(await gateRow(svc, 'gc-one'), undefined, 'the approved gate came back');
});

test('GC-2: a gate approved outside the console leaves once the watcher sees gate-status.md', async (t) => {
  const lib = library(t, { 'gc-two': GATED });
  const { svc, inner } = open(t, lib);
  await raised(svc, 'gc-two');

  // The row a terminal or a session writes — the console's own write helper,
  // never `approveGate`, so only the file and the watcher carry the news.
  const written = await runWrite(
    planWrite(
      { action: 'gate-approve', slug: 'gc-two', phase: 1, by: 'operator', door: 'console' },
      { root: lib.root, docsDir: join(lib.root, 'docs') },
    ),
    { scriptsDir: SCRIPTS, root: lib.root },
  );
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal((await svc.gateStatus('gc-two', 1))?.clear, false, 'nothing has told the console yet');

  inner.onChange([join(lib.root, 'docs', 'handoffs', 'gc-two', 'gate-status.md')]);
  assert.equal((await svc.gateStatus('gc-two', 1))?.clear, true, 'the engine reads the new row');
  assert.ok(
    await until(async () => !(await gateRow(svc, 'gc-two')), 15_000),
    'the gate a terminal approved still asks for approval',
  );
});

test('GC-3: a gate press re-reads its own plan, never every plan', async (t) => {
  const lib = library(t, { 'gc-gated': GATED, 'gc-other': PLAIN });
  const spy = spyScripts(t);
  const { svc } = open(t, lib, spy.dir);
  await raised(svc, 'gc-gated');
  // Both boards are cached now.
  await svc.attention(true);
  const before = spy.ran().length;

  const approved = await svc.approveGate('gc-gated', 1, { approve: true, by: 'operator', door: 'local' });
  assert.equal(approved.ok, true, approved.detail);
  await svc.attention(true);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await svc.attention(true);

  const other = spy.ran().slice(before).filter((line) => line.includes('gc-other'));
  assert.deepEqual(other, [], 'approving one plan’s gate re-shelled another plan’s board');
});

test('GC-4: an ack-bound option settles its item without re-shelling any plan', async (t) => {
  const lib = library(t, { 'gc-gated': GATED, 'gc-other': PLAIN });
  const spy = spyScripts(t);
  const { svc } = open(t, lib, spy.dir);
  await raised(svc, 'gc-gated');
  await svc.attention(true);
  // A conflict's row, as the inbox raises it: one option bound to the ack.
  const id = 'conflict::::a × b';
  const real = svc.attention.bind(svc);
  (svc as unknown as { attention: Service['attention'] }).attention = async (all = false) => {
    const view = await real(all);
    return {
      ...view,
      items: [...view.items, {
        id, kind: 'conflict', severity: 'needs-you', title: 'a × b — these branches would not merge', need: '', how: '',
        since: '2026-10-20T00:00:00.000Z', href: '', actions: [],
        options: [{ id: 'leave', label: 'Leave them, and resolve the conflict when the branches meet' }],
        turn: { item: id, source: 'conflict' },
      }],
    } as never;
  };
  const told: string[] = [];
  svc.onEvent((event) => { if (event === 'inbox') told.push(event); });
  const before = spy.ran().length;

  await svc.settleAnsweredRow(id, 'leave', 'operator');

  const settled = svc.settledNow().recent(60_000).find((one) => one.item === id);
  assert.equal(settled?.outcome, 'closed');
  assert.match(settled?.what ?? '', /^Leave them/);
  assert.ok(told.length > 0, 'the page is told the turn moved');
  await svc.attention(true);
  assert.deepEqual(spy.ran().slice(before).filter((line) => line.includes('--memory-block')), [],
    'an answered conflict re-shelled the boards');
});
