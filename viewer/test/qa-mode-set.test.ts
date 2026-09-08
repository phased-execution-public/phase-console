/**
 * QA on/off from the console — the write door for `scripts/qa-mode.sh`.
 *
 * The plan file has carried both switches for as long as the engine has read
 * them (`**QA gate:** on|off` in §Session budget; `- **QA:** on|off` in a
 * phase's own block). Until 2026-09-07 the console could only ACTIVATE — turn
 * the gate on through `new-handoff --qa` — never turn it off, never per phase;
 * the inbox told the operator to hand-edit the file. `qa-mode.sh` is the
 * writer, `planWrite` its argv, `Service.setQaMode` the door that reads the
 * postcondition back from the engine instead of trusting an exit code.
 *
 * The words that come back are the ENGINE's, not the directive's: with a
 * ledger on disk a written `off` reads as `waived (plan directive)`, because
 * the recorded rows stay visible and simply stop holding dependents.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PHASE_CONSOLE_LOG = '';

const { planWrite, WriteError } = await import('../server/writes.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'plans', 'qa-per-phase.md');
const SLUG = 'qa-per-phase';

const refused = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (error: unknown) => error instanceof WriteError && re.test((error as Error).message));

/* ------------------------------------------------------------------ *
 * The write plan
 * ------------------------------------------------------------------ */

test('a plan-wide switch is `qa-mode.sh <slug> on|off`, and nothing else rides along', () => {
  assert.deepEqual(planWrite({ action: 'qa-mode', slug: 'alpha', mode: 'off' }, { root: '/r' }).args, ['alpha', 'off']);
  assert.deepEqual(planWrite({ action: 'qa-mode', slug: 'alpha', mode: 'on' }, { root: '/r' }).args, ['alpha', 'on']);
  assert.equal(planWrite({ action: 'qa-mode', slug: 'alpha', mode: 'on' }, { root: '/r' }).script, 'qa-mode.sh');
});

test('a per-phase switch names the phase, and `inherit` is a phase\'s word only', () => {
  assert.deepEqual(
    planWrite({ action: 'qa-mode', slug: 'alpha', phase: 3, mode: 'inherit' }, { root: '/r' }).args,
    ['alpha', '--phase', '3', 'inherit'],
  );
  assert.deepEqual(
    planWrite({ action: 'qa-mode', slug: 'alpha', phase: 12, mode: 'off' }, { root: '/r' }).args,
    ['alpha', '--phase', '12', 'off'],
  );
  // A plan has nothing to inherit from — refused with the sentence, not by the script.
  refused(() => planWrite({ action: 'qa-mode', slug: 'alpha', mode: 'inherit' }, { root: '/r' }), /phase's word/);
});

test('an unknown mode, a bad phase or a bad slug is refused before anything runs', () => {
  refused(() => planWrite({ action: 'qa-mode', slug: 'alpha', mode: 'maybe' }, { root: '/r' }), /on, off, inherit/);
  refused(() => planWrite({ action: 'qa-mode', slug: 'alpha', mode: '' }, { root: '/r' }), /on, off, inherit/);
  refused(() => planWrite({ action: 'qa-mode', slug: 'alpha', phase: 0, mode: 'on' }, { root: '/r' }), /phase/i);
  refused(() => planWrite({ action: 'qa-mode', slug: 'Not A Slug', mode: 'on' }, { root: '/r' }), /slug/i);
});

/* ------------------------------------------------------------------ *
 * The door — a real Service over a scratch root, the real script
 * ------------------------------------------------------------------ */

const OPEN = new Map<string, InstanceType<typeof Service>[]>();

function scratch(): { root: string; plan: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-qa-mode-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', SLUG), { recursive: true });
  const plan = join(root, 'docs', 'plans', `${SLUG}.md`);
  copyFileSync(FIXTURE, plan);
  // A ledger, so the gate is ON and a written `off` reads back as `waived`.
  writeFileSync(join(root, 'docs', 'handoffs', SLUG, 'test-status.md'),
    `# QA / test status — ${SLUG}\n\n## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n`, 'utf8');
  return {
    root, plan,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string, over: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true,
    scriptsDir: SCRIPTS, logFile: null, ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

test('setQaMode switches the plan off and on, and the engine\'s reading follows each write', async () => {
  const { root, plan, cleanup } = scratch();
  try {
    const svc = service(root);
    assert.equal((await svc.qaMode(SLUG)).mode, 'on', 'the fixture gates, and the ledger exists');

    const off = await svc.setQaMode(SLUG, { mode: 'off' });
    assert.equal(off.ok, true, off.detail);
    // The engine's word, not the directive's: rows stay, the gate lets go.
    assert.equal(off.plan?.mode, 'waived');
    assert.match(off.plan?.reason ?? '', /plan directive/);
    assert.match(readFileSync(plan, 'utf8'), /^\*\*QA gate:\*\* off$/m);
    assert.equal((await svc.qaMode(SLUG)).mode, 'waived', 'the cache was dropped with the write');

    const on = await svc.setQaMode(SLUG, { mode: 'on' });
    assert.equal(on.ok, true, on.detail);
    assert.equal(on.plan?.mode, 'on');
    assert.match(readFileSync(plan, 'utf8'), /^\*\*QA gate:\*\* on$/m);
    assert.match(on.detail, /reads on/);
  } finally { cleanup(); }
});

test('setQaMode on one phase writes that phase\'s bullet, and `inherit` removes it', async () => {
  const { root, plan, cleanup } = scratch();
  try {
    const svc = service(root);
    // Phase 1 inherits the plan's `on`; phase 2 says `off` for itself.
    assert.equal((await svc.qaMode(SLUG, 1)).mode, 'on');
    assert.equal((await svc.qaMode(SLUG, 2)).mode, 'off');

    const exempt = await svc.setQaMode(SLUG, { mode: 'off', phase: 1 });
    assert.equal(exempt.ok, true, exempt.detail);
    assert.equal(exempt.phase?.phase, 1);
    assert.equal(exempt.phase?.regime.mode, 'off');
    assert.match(exempt.phase?.regime.reason ?? '', /phase directive/);
    assert.equal(exempt.plan?.mode, 'on', 'the plan-wide regime is untouched');
    assert.equal((await svc.qaMode(SLUG, 1)).mode, 'off', 'the per-phase cache was dropped too');
    // …and the neighbour that already said `off` still does, once.
    assert.equal((readFileSync(plan, 'utf8').match(/^- \*\*QA:\*\* off$/mg) ?? []).length, 2);

    const back = await svc.setQaMode(SLUG, { mode: 'inherit', phase: 1 });
    assert.equal(back.ok, true, back.detail);
    assert.equal(back.phase?.regime.mode, 'on');
    assert.match(back.phase?.regime.reason ?? '', /plan directive/);
    assert.equal((readFileSync(plan, 'utf8').match(/^- \*\*QA:\*\* off$/mg) ?? []).length, 1);
  } finally { cleanup(); }
});

test('the door is write-class, and an unknown plan is a sentence rather than a script error', async () => {
  const { root, cleanup } = scratch();
  try {
    const sealed = service(root, { allowWrites: false });
    const refusal = await sealed.setQaMode(SLUG, { mode: 'off' });
    assert.equal(refusal.ok, false);
    assert.match(refusal.detail, /--allow-writes/);
    assert.equal(refusal.plan, undefined, 'nothing was read back because nothing was written');

    const svc = service(root);
    const missing = await svc.setQaMode('no-such-plan', { mode: 'off' });
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /No plan named/);
  } finally { cleanup(); }
});
