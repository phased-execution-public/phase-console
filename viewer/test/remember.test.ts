/**
 * Ruling memory (zero-touch phase 12, chapter 10 ZTD-7 / QRL-4).
 *
 * 2 315 rulings and 1 874 ledger rows once reached no plan, no template and
 * no default. `Service.rememberRuling` is the feedback loop: a keyed ruling
 * becomes a `## Decisions` row in the plan's twin (through `decisions.sh
 * promote`, the file's one writer) or this console's own `policy.<key>`
 * answer — and is acked in the ledger, attributed, either way.
 *
 * Real scripts, a real Service over a scratch docs root: the join under test
 * is bash ↔ console (one ledger, one id, one row shape), and a stub on either
 * side would pin nothing.
 */

// Redirects the state and config homes before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { readRulings, rulingsFile, rulingId } = await import('../server/runner/rulings.ts');
const { log } = await import('../server/log.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIXTURE = join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'decisions.md');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null, converge: false };

/** A docs root holding the `decisions` fixture plan under its own slug. */
function library(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-remember-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'decisions'), { recursive: true });
  // The fixture plan's own slug is `decisions`; the file name must agree.
  appendFileSync(join(root, 'docs', 'plans', 'decisions.md'), readFileSync(FIXTURE, 'utf8'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function service(t: { after(fn: () => void): void }, root: string, overrides: Record<string, unknown> = {}) {
  const svc = new Service({ ...flags, ...overrides } as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

const AT = '2026-09-14T00:00:00Z';

/** One ledger line the way phase-outcome.sh writes it, stamped id included. */
function ruling(root: string, what: string, extra: Record<string, unknown> = {}): string {
  const file = rulingsFile(root, 'decisions');
  mkdirSync(join(file, '..'), { recursive: true });
  const id = rulingId('decisions', 2, AT, what);
  appendFileSync(file, `${JSON.stringify({ version: 1, type: 'ruling', id, slug: 'decisions', phase: 2, kind: 'ambiguity', what, ...extra, at: AT })}\n`);
  return id;
}

test('remember plan: the row lands in the twin with source ruling, and the ruling is acked by name', async (t) => {
  const root = library(t);
  const svc = service(t, root);
  const id = ruling(root, 'the window is the cap', { why: 'the plan says so', decisionKey: 'waits' });

  const out = await svc.rememberRuling('decisions', id, 'plan', 'operator');
  assert.equal(out.ok, true, out.ok ? '' : out.error);
  if (!out.ok) return;
  assert.equal(out.key, 'waits');
  assert.equal(out.value, 'the window is the cap');
  assert.equal(out.ack, true);

  const twin = join(root, 'docs', 'handoffs', 'decisions', 'decisions.md');
  assert.ok(existsSync(twin), 'decisions.sh wrote the twin');
  assert.match(readFileSync(twin, 'utf8'),
    new RegExp(`\\| \`waits\` \\| the window is the cap \\| operator \\| answered \\| yes \\| ruling \\| ruling ${id} \\| — \\|`));
  // The ledger: the ack names the ruling and who remembered it.
  const [row] = readRulings(rulingsFile(root, 'decisions'));
  assert.deepEqual(row.ack?.by, 'operator');
  // And the store re-read the twin at once — the prelude, the Source tab and
  // the next boot prompt carry the promoted row from here, not from the
  // watcher's next tick.
  const rows = svc.store?.get('decisions')?.decisionsTwin ?? [];
  assert.ok(rows.some((r) => r.key === 'waits' && r.source === 'ruling' && r.value === 'the window is the cap'), JSON.stringify(rows));
});

test('remember global: the console holds the answer, journals policy.changed with the actor, and acks', async (t) => {
  const root = library(t);
  const svc = service(t, root);
  const id = ruling(root, 'waive', { decisionKey: 'qa.exhausted' });
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  const info = log.info;
  log.info = ((event: string, data?: Record<string, unknown>) => { lines.push({ event, data: data ?? {} }); }) as typeof log.info;
  t.after(() => { log.info = info; });

  const out = await svc.rememberRuling('decisions', id, 'global', 'op@mac');
  assert.equal(out.ok, true, out.ok ? '' : out.error);
  assert.equal(svc.prefs.policy?.['qa.exhausted'], 'waive');
  const changed = lines.find((l) => l.event === 'policy.changed');
  assert.deepEqual(changed?.data, { key: 'qa.exhausted', from: null, to: 'waive', by: 'op@mac' });
  assert.ok(lines.some((l) => l.event === 'rulings.remembered' && l.data.scope === 'global'));
  assert.equal(readRulings(rulingsFile(root, 'decisions'))[0].ack?.by, 'op@mac');
  // No docs file was touched: a console answer is not a plan row.
  assert.ok(!existsSync(join(root, 'docs', 'handoffs', 'decisions', 'decisions.md')));
});

test('remember global refuses words the key cannot hold, naming the words; plan needs writes; an un-keyed ruling is refused', async (t) => {
  const root = library(t);
  const svc = service(t, root);
  const prose = ruling(root, 'the window is the cap', { decisionKey: 'waits' });
  const refused = await svc.rememberRuling('decisions', prose, 'global', 'operator');
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.status, 400);
  assert.match(refused.error, /window, refuse/);
  assert.equal(svc.prefs.policy?.waits, undefined, 'nothing written');

  const unkeyed = ruling(root, 'chose A');
  const noKey = await svc.rememberRuling('decisions', unkeyed, 'plan', 'operator');
  assert.equal(noKey.ok, false);
  if (!noKey.ok) { assert.equal(noKey.status, 400); assert.match(noKey.error, /names no decision key/); }

  const missing = await svc.rememberRuling('decisions', 'abcdef012345', 'plan', 'operator');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  const frozen = service(t, root, { allowWrites: false });
  const off = await frozen.rememberRuling('decisions', prose, 'plan', 'operator');
  assert.equal(off.ok, false);
  if (!off.ok) { assert.equal(off.status, 403); assert.match(off.error, /--allow-writes/); }
  // The ruling stays un-acked through every refusal.
  assert.ok(readRulings(rulingsFile(root, 'decisions')).every((r) => !r.ack));
});

test('planFacts digests the estate: outstanding keys by plan, keyed rulings newest first, promoted rows', async (t) => {
  const root = library(t);
  const svc = service(t, root);
  const older = ruling(root, 'waive', { decisionKey: 'qa.exhausted' });
  const file = rulingsFile(root, 'decisions');
  appendFileSync(file, `${JSON.stringify({
    version: 1, type: 'ruling', id: rulingId('decisions', 3, '2026-09-15T00:00:00Z', 'the window is the cap'),
    slug: 'decisions', phase: 3, kind: 'ambiguity', what: 'the window is the cap', decisionKey: 'waits', at: '2026-09-15T00:00:00Z',
  })}\n`);
  appendFileSync(file, `${JSON.stringify({
    version: 1, type: 'ruling', id: 'abcdef012345', slug: 'decisions', phase: 3, kind: 'ambiguity', what: 'no key here', at: '2026-09-16T00:00:00Z',
  })}\n`);

  const before = svc.planFacts();
  assert.equal(before.plans, 1);
  assert.equal(before.promoted, 0);
  assert.ok(before.outstanding.some((o) => o.plans.includes('decisions')), 'the fixture leaves rows outstanding');
  assert.deepEqual(before.rulings.map((r) => r.key), ['waits', 'qa.exhausted'], 'keyed only, newest first');

  const out = await svc.rememberRuling('decisions', older, 'plan', 'operator');
  assert.equal(out.ok, true, out.ok ? '' : out.error);
  const after = svc.planFacts();
  assert.equal(after.promoted, 1, 'the promoted row counts');
});
