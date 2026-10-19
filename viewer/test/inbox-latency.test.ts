/**
 * The inbox answers in milliseconds, measured (one-pool phase 26, #237).
 *
 * On 2026-10-05 the hub console spent 5,280 s of its one thread on 759 slow
 * `/api/inbox` requests, the worst 266 s — a regression of #75, whose memo and
 * single flight (`inbox-single-flight.test.ts`) were still there. What was
 * left was the fold itself, paid three times per change: the view, then
 * `inboxIds` folding the whole list again to prune the acks, then the other
 * shape's own build on its first request; and inside it a linear table scan
 * per permission item (`riskRowOf`) and a secret pattern compiled per call.
 *
 *   IL-1  the fold of 2,000 items costs under `BUDGET_MS` of CPU (the median
 *         of five folds, CPU time rather than wall time, so a loaded machine
 *         cannot turn the benchmark into the flake #223 describes);
 *   IL-2  a console holding 2,000 items answers `GET /api/inbox` under
 *         `BUDGET_MS` — the first build after a change (an ack), and from the
 *         memo after it, both shapes from that one build.
 *
 * The numbers measured on the build machine are printed with each assertion,
 * and the handoff records them.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { invalidate } from '../server/engine.ts';
import { buildInbox, type InboxFacts } from '../server/inbox.ts';
import { appendRuling, rulingsFile } from '../server/runner/rulings.ts';
import { Service } from '../server/service.ts';

process.env.PHASE_CONSOLE_LOG = '';

/** The answer the plan sets: 2,000 items under 200 ms. */
const BUDGET_MS = 200;
const ITEMS = 2_000;
const KEYS = ['permission.policy', 'credentials', 'accounts', 'mcp', 'gates', 'waits', 'budgets', 'stop'] as const;

/** CPU milliseconds this process spent in `fn` — user and system. */
async function cpuMs(fn: () => unknown): Promise<number> {
  const before = process.cpuUsage();
  await fn();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Facts that raise `ITEMS` rows: permission cards and decision-keyed rulings, the two the hub's inbox was made of. */
function facts(now: number): InboxFacts {
  const approvals = Array.from({ length: ITEMS / 2 }, (_, i) => ({
    id: `card-${i}`, runId: `run${i % 7}`, slug: `plan-${i % 13}`, phase: (i % 40) + 1, kind: 'tool',
    title: `Allow Bash ${i}`, detail: 'a call the profile asks about', createdAt: new Date(now - i * 1_000).toISOString(),
    status: 'pending', tool: { name: 'Bash', input: { command: `npm test -- --shard=${i}` } }, suggestedRule: `Bash(npm test:*)`,
  }));
  const rulings = Array.from({ length: ITEMS / 2 }, (_, i) => ({
    id: `r${i}`, slug: `plan-${i % 13}`, phase: (i % 40) + 1, kind: 'ambiguity', what: `read the line one way (${i})`,
    why: 'the plan admitted two readings', at: new Date(now - i * 60_000).toISOString(), decisionKey: KEYS[i % KEYS.length],
  }));
  return { approvals, rulings } as unknown as InboxFacts;
}

test(`IL-1: the fold of ${ITEMS} items costs under ${BUDGET_MS} ms`, async () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const input = facts(now);
  let items = 0;
  buildInbox(input, now, { all: true }); // warm: the module's own first-call costs are not the fold's
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) runs.push(await cpuMs(() => { items = buildInbox(input, now, { all: true }).items.length; }));
  assert.ok(items >= ITEMS, `the facts raise ${items} rows`);
  const ms = median(runs);
  assert.ok(ms < BUDGET_MS, `the fold of ${items} items took ${ms.toFixed(1)} ms of CPU (median of ${runs.map((r) => r.toFixed(0)).join(', ')}) — over ${BUDGET_MS}`);
  console.log(`# IL-1 fold of ${items} items: ${ms.toFixed(1)} ms CPU (median of 5)`);
});

const PLAN = `---
slug: SLUG
created: 2026-10-18
status: active
phases: 2
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | it works |
| 2 | second | 1 | — | app | it still works |

## Phases

### Phase 1 — first
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — second
- **Size:** S
- **Verification:** \`true\`
`;

test(`IL-2: a console holding ${ITEMS} items answers GET /api/inbox under ${BUDGET_MS} ms — after a change and from the memo`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pc-inbox-latency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  // Four plans, each with a full ledger of decision-keyed rulings: one row each.
  const slugs = ['lat-a', 'lat-b', 'lat-c', 'lat-d'];
  const now = Date.now();
  for (const slug of slugs) {
    mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  }
  invalidate();
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  t.after(() => svc.close());
  for (const slug of slugs) {
    const file = rulingsFile(root, slug);
    for (let i = 0; i < ITEMS / slugs.length; i++) {
      appendRuling(file, {
        slug, phase: (i % 2) + 1, what: `read the line one way (${slug} ${i})`, why: 'two readings',
        decisionKey: KEYS[i % KEYS.length], by: 'test', at: new Date(now - i * 1_000).toISOString(),
      });
    }
  }

  const { handleApi } = await import('../server/api/routes.ts');
  const get = async (path: string): Promise<{ status: number; body: { items?: { id: string }[] } }> => {
    const out = { status: 0, body: {} as { items?: { id: string }[] } };
    const chunks: Buffer[] = [];
    const req = {
      method: 'GET', headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
      socket: { remoteAddress: '127.0.0.1' }, on() { return this; },
      [Symbol.asyncIterator]: async function* () { /* no body */ },
    };
    const res = {
      req, statusCode: 200, headersSent: false,
      writeHead(status: number) { out.status = status; return this; },
      write(chunk: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); },
      setHeader() { return this; }, getHeader() { return undefined; }, on() { return this; }, once() { return this; },
    };
    await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
    try { out.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { out.body = {}; }
    return out;
  };

  // The first answer builds every plan's context (the engine's shells), which
  // is a cost of opening the console, not of the inbox: paid before measuring.
  const first = await get('/api/inbox?all=1');
  assert.equal(first.status, 200);
  const count = first.body.items?.length ?? 0;
  assert.ok(count >= ITEMS, `the console holds ${count} items`);

  // A change: an ack moves the inbox's revision, so the next request folds again.
  svc.ackInbox(first.body.items![0]!.id, 'test');
  const changed = await cpuMs(async () => { assert.equal((await get('/api/inbox')).status, 200); });
  const memo = await cpuMs(async () => { assert.equal((await get('/api/inbox')).status, 200); });
  const other = await cpuMs(async () => { assert.equal((await get('/api/inbox?all=1')).status, 200); });
  console.log(`# IL-2 ${count} items: after a change ${changed.toFixed(1)} ms CPU, memo ${memo.toFixed(1)} ms, other shape ${other.toFixed(1)} ms`);
  assert.ok(changed < BUDGET_MS, `after a change the inbox took ${changed.toFixed(1)} ms of CPU — over ${BUDGET_MS}`);
  assert.ok(memo < BUDGET_MS, `from the memo it took ${memo.toFixed(1)} ms — over ${BUDGET_MS}`);
  assert.ok(other < BUDGET_MS, `the other shape took ${other.toFixed(1)} ms — over ${BUDGET_MS}; one fold answers both`);
});
