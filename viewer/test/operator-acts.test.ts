/**
 * The operator-acts queue (control-tower phase 121, #182) — "just tell me when
 * the time arrives".
 *
 * An act only the operator does — a command to run, a click path to follow —
 * is a human step of the seventeenth kind, `operator-act`, with a `dueWhen`
 * watch ref and the pre-due state `upcoming` (§Architecture 19, "The seam with
 * phase 121"). No second ledger, no second list model, no bespoke card:
 *
 *   OA-1  declared by a session (`phase-outcome.sh … needs-human --act
 *         --due-when <ref>`), it is born `upcoming` — shown, never pushed,
 *         never reminded, never expired — and its inbox row is *Coming up*;
 *   OA-2  the moment its ref lands it becomes `declared` with ONE push,
 *         "NOW: <command>", then `notified`; its window starts then; a second
 *         landing pushes nothing;
 *   OA-3  the console's own pass probes every upcoming act's due-when ref and
 *         every plan act's proof — a date past is due, a date ahead is not, a
 *         proof that reads true clears the act; a session's act parks its
 *         phase with the proof on the record, so the landing resumes it;
 *   OA-4  one list across plans, worst-first: every act due now before any
 *         that is coming up, each line carrying its exact command.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { HumanStepLedger, declareHumanStep, dueHumanStep, nextReminderAt, parkOnStep, stepProofOf, tickHumanSteps, windowEndOf } =
  await import('../server/human-steps.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { humanStepPush } = await import('../server/push/catalogue.ts');
const { readOutcome } = await import('../server/runner/outcome.ts');
const { doorSteps } = await import('../server/prelude.ts');
const { KIND_META, dueRefOk } = await import('../shared/human-step-model.js');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
type HumanStep = import('../server/human-steps.ts').HumanStep;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-operator-acts-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ACT = {
  kind: 'operator-act', title: 'Restart the hub console on the new build',
  open_command: 'phase-console update hub --when-idle', proof: 'cmd:"curl -sf http://127.0.0.1:4123/api/state"',
  due_when: 'gh:acme/app#run/42',
};

/* ------------------------------------------------------------------ *
 * OA-1 — born upcoming: shown, never pushed, reminded or expired
 * ------------------------------------------------------------------ */

test('OA-1 — `--act --due-when` reaches the ledger as an upcoming operator act: no push, no reminder, no expiry', () => {
  const s = scratch();
  try {
    // The door: bash writes the step, the runner's reader keeps it.
    const out = join(s.dir, 'outcome.json');
    const run = spawnSync('bash', [join(SKILL_DIR, 'scripts', 'phase-outcome.sh'), 'demo', '7', 'needs-human',
      '--needs', 'external', '--act', '--title', ACT.title, '--open-command', ACT.open_command,
      '--proof', ACT.proof, '--due-when', ACT.due_when], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: s.dir, XDG_STATE_HOME: join(s.dir, 'state'), DOCS_ROOT: s.dir,
        PE_OUTCOME_FILE: out, PE_NOW: '2026-10-05T10:00:00Z', PHASE_OUTCOME_PROBE: '0',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const declared = readOutcome(out, { slug: 'demo', phase: 7 });
    assert.equal(declared?.step?.kind, 'operator-act', '--act is --step operator-act');
    assert.equal((declared?.step as { due_when?: string } | undefined)?.due_when, ACT.due_when);

    // The ledger: born upcoming, announced to nobody.
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
    const pushed: HumanStep[] = [];
    const step = declareHumanStep({ ledger, announce: (st) => { pushed.push(st); return true; } }, {
      slug: 'demo', phase: 7, birth: 'session', runId: 'r1', step: declared!.step,
    })!;
    assert.equal(step.state, 'upcoming');
    assert.equal(step.dueWhen, ACT.due_when);
    assert.equal(step.until, undefined, 'its window has not started');
    assert.equal(pushed.length, 0, 'an upcoming act is announced to nobody');
    assert.equal(ledger.get(step.id)?.state, 'upcoming', 'and the ledger reads it back so');

    // Unreminded and unexpired, however long it waits for its ref.
    assert.equal(nextReminderAt(step), null);
    const later = Date.parse(step.declaredAt) + 30 * 24 * 3_600_000;
    const pass = tickHumanSteps({ ledger, now: later, remind: () => { throw new Error('reminded an upcoming act'); } });
    assert.deepEqual(pass, { reminded: [], expired: [], dismissed: [] });
    assert.equal(ledger.get(step.id)?.state, 'upcoming');

    // Its inbox row is *Coming up* — not a summons.
    const [row] = buildInbox({ humanSteps: ledger.open() }).items.filter((item) => item.kind === 'human-step');
    assert.ok(row, 'an upcoming act has a row');
    assert.equal(row!.severity, 'fyi', 'coming up is not needs-you');
    assert.equal(row!.humanStep?.state, 'upcoming');
    assert.equal(row!.humanStep?.dueWhen, ACT.due_when);
    assert.match(row!.title, /^Coming up — carry out a task for demo phase 7$/);
    assert.match(row!.how, /due when gh:acme\/app#run\/42 lands/);
  } finally {
    s.cleanup();
  }
});

test('OA-1 — a session\'s act that is not due summons nobody: its park\'s errand pushes nothing and draws no row; the due row is a new summons', async () => {
  const errand = {
    phase: 7, situation: 'blocked-declared:external', tried: [], at: '2026-10-05T10:00:00.000Z',
    need: `Coming up — carry out a task: ${ACT.title}`, how: 'At the machine this console runs on.', upcoming: true,
  };
  // The inbox: the ledger's *Coming up* row is its only face — no needs-you errand beside it.
  const run = {
    // A live run — its phases' errands are drawn while it drives (a stopped one adds a run-level row of its own).
    id: 'r1', slug: 'demo', status: 'running', resolved: false, updatedAt: errand.at,
    phases: {}, recoveries: { 7: { attempts: 0, lastAt: errand.at, errand } },
  };
  const errandRows = (e: object) => buildInbox({ plans: [], runs: [{ ...run, recoveries: { 7: { attempts: 0, lastAt: errand.at, errand: e } } }], flags: {} } as never)
    .items.filter((item) => item.kind === 'errand');
  assert.equal(errandRows(errand).length, 0, 'an upcoming act raises no needs-you errand');
  assert.equal(errandRows({ ...errand, upcoming: undefined }).length, 1, 'the same errand, due, does');

  // The push: the park's phase event announces nothing for it.
  const root = mkdtempSync(join(tmpdir(), 'pc-operator-acts-errand-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: string[] = [];
  svc.push.announce = ((category: string) => { pushed.push(category); return null; }) as never;
  try {
    assert.equal(svc.open(root).ok, true);
    const announceErrand = (svc as unknown as { announceErrand: (d: unknown) => void }).announceErrand.bind(svc);
    announceErrand({ slug: 'demo', runId: 'r1', phase: 7, errand });
    assert.deepEqual(pushed, [], 'no needs-you at declaration — its ONE push is the step\'s, when due');
    announceErrand({ slug: 'demo', runId: 'r1', phase: 7, errand: { ...errand, upcoming: undefined, at: '2026-10-05T10:01:00.000Z' } });
    assert.deepEqual(pushed, ['needs-you'], 'a due errand still summons');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The ack: a *Coming up* row a person dismissed must not hide the act once it is due.
  const s = scratch();
  try {
    let now = Date.parse('2026-10-05T10:00:00Z');
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'), () => new Date(now));
    const step = declareHumanStep({ ledger, announce: () => true }, { slug: 'demo', phase: 7, birth: 'session', step: ACT })!;
    const before = buildInbox({ humanSteps: ledger.open() }).items.find((item) => item.humanStep?.stepId === step.id)!;
    assert.equal(before.since, step.declaredAt);
    now += 2 * 3_600_000;
    const due = dueHumanStep({ ledger, announce: () => true }, step.id, { ref: ACT.due_when });
    assert.ok(due && !('refused' in due));
    const after = buildInbox({ humanSteps: ledger.open() }).items.find((item) => item.humanStep?.stepId === step.id)!;
    assert.equal(after.since, due.dueAt, 'a step that came due is a new summons — an older ack no longer hides it');
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * OA-2 — due: ONE push, "NOW: <command>"
 * ------------------------------------------------------------------ */

test('OA-2 — the due-when ref lands: declared, ONE push saying NOW and the command, notified; the window starts now', () => {
  const s = scratch();
  try {
    let now = Date.parse('2026-10-05T10:00:00Z');
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'), () => new Date(now));
    const pushed: HumanStep[] = [];
    const announce = (st: HumanStep): boolean => { pushed.push(st); return true; };
    const step = declareHumanStep({ ledger, announce }, {
      slug: 'demo', phase: 7, birth: 'session', step: { ...ACT, windowMinutes: 120 },
    })!;
    assert.equal(step.state, 'upcoming');

    now += 3 * 3_600_000;
    const due = dueHumanStep({ ledger, announce }, step.id, { ref: ACT.due_when, detail: 'completed: success' });
    assert.ok(due && !('refused' in due), 'it became due');
    assert.equal(due.state, 'notified');
    assert.equal(due.pushed, true);
    assert.equal(due.dueAt, new Date(now).toISOString(), 'when it became due is on the record');
    assert.equal(due.until, new Date(now + 120 * 60_000).toISOString(), 'its window starts at the due moment');
    assert.equal(windowEndOf(due), now + 120 * 60_000);
    assert.equal(pushed.length, 1, 'ONE push');
    const moves = ledger.history(step.id).map((m) => [m.state, m.verb]);
    assert.deepEqual(moves, [['declared', 'due'], ['notified', 'notify']]);

    // A second landing is no news: nothing moves, nothing is pushed.
    const again = dueHumanStep({ ledger, announce }, step.id, { ref: ACT.due_when });
    assert.ok(again && 'refused' in again, 'an act is due once');
    assert.equal(pushed.length, 1);

    // The words: NOW and the exact command, on the lock screen.
    const push = humanStepPush({ ...due, label: KIND_META['operator-act'].label });
    assert.equal(push.message.title, 'NOW: phase-console update hub --when-idle');
    assert.match(push.message.body, /Restart the hub console on the new build — demo phase 7/);
    // A click path names its act instead.
    const click = humanStepPush({
      id: 'c', kind: 'operator-act', label: KIND_META['operator-act'].label, title: 'Add the signing key in Vercel',
      where: 'any', slug: 'site', phase: 0, openUrl: 'https://vercel.com/acme/site/settings',
    });
    assert.equal(click.message.title, 'NOW: Add the signing key in Vercel');
    assert.match(click.message.body, /the plan site/, 'phase 0 is the plan itself');
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * OA-3 — the console's pass: due-when refs and plan acts' proofs
 * ------------------------------------------------------------------ */

test('OA-3 — the pass makes due what has landed and only that; a plan act whose proof reads true is cleared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-operator-acts-root-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Array<{ category: string; message: Record<string, unknown> }> = [];
  svc.push.announce = ((category: string, message: Record<string, unknown>) => {
    pushed.push({ category, message });
    return null;
  }) as never;
  try {
    assert.equal(svc.open(root).ok, true);
    const past = new Date(Date.now() - 60_000).toISOString();
    const ahead = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const dueNow = svc.recordHumanStep({ slug: 'demo', phase: 3, birth: 'session', step: { ...ACT, due_when: `date:${past}` } })!;
    const notYet = svc.recordHumanStep({ slug: 'demo', phase: 4, birth: 'session', step: { ...ACT, due_when: `date:${ahead}` } })!;
    const planAct = svc.recordHumanStep({
      slug: 'other', phase: 0, birth: 'plan',
      step: { kind: 'operator-act', title: 'Rotate the deploy key', open_command: 'vercel env add KEY', proof: `date:${past}` },
    })!;
    assert.equal(dueNow.state, 'upcoming');
    assert.equal(notYet.state, 'upcoming');
    assert.equal(planAct.state, 'notified', 'a plan act with no due-when is due at once');
    const before = pushed.length;

    await svc.humanStepDuePass();

    const ledger = svc.humanStepsNow();
    assert.equal(ledger.get(dueNow.id)?.state, 'notified', 'a due-when date that has passed is due');
    assert.equal(ledger.get(notYet.id)?.state, 'upcoming', 'a date ahead is not');
    assert.equal(ledger.get(planAct.id)?.state, 'proven', "a plan act's proof that reads true clears it");
    const mine = pushed.slice(before).filter((p) => (p.message.step as { id?: string } | undefined)?.id === dueNow.id);
    assert.equal(mine.length, 1, 'ONE push, at the moment it became due');
    assert.equal(mine[0]!.category, 'needs-you');
    assert.equal(mine[0]!.message.title, `NOW: ${ACT.open_command}`);

    // A second pass is quiet: due once, pushed once.
    await svc.humanStepDuePass();
    assert.equal(pushed.slice(before).filter((p) => (p.message.step as { id?: string } | undefined)?.id === dueNow.id).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OA-3 — a frozen console asks nothing; a due-when the clock refuses makes the act due at once, the refusal named', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-operator-acts-refused-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Array<{ category: string; message: Record<string, unknown> }> = [];
  svc.push.announce = ((category: string, message: Record<string, unknown>) => {
    pushed.push({ category, message });
    return null;
  }) as never;
  try {
    assert.equal(svc.open(root).ok, true);
    const past = new Date(Date.now() - 60_000).toISOString();
    const dated = svc.recordHumanStep({ slug: 'demo', phase: 3, birth: 'session', step: { ...ACT, due_when: `date:${past}` } })!;
    // A host the machine profile does not name: the clock refuses the ref, for good.
    const nowhere = svc.recordHumanStep({
      slug: 'demo', phase: 4, birth: 'session', step: { ...ACT, due_when: 'unit:no-such-host/nightly-build.service' },
    })!;
    assert.equal(nowhere.state, 'upcoming');
    const own = svc as unknown as { fleetHold: () => unknown };
    const realHold = own.fleetHold;
    own.fleetHold = () => ({ at: new Date().toISOString(), by: 'operator' });
    assert.deepEqual(await svc.humanStepDuePass(), { due: [], proven: [] }, 'a frozen console asks nothing');
    assert.equal(svc.humanStepsNow().get(dated.id)?.state, 'upcoming');
    own.fleetHold = realHold;

    const pass = await svc.humanStepDuePass();
    assert.ok(pass.due.includes(dated.id), 'thawed, the landed date is due');
    assert.ok(pass.due.includes(nowhere.id), 'a ref that can never land does not hold the act back, unseen');
    const due = svc.humanStepsNow().history(nowhere.id).find((move) => move.verb === 'due');
    assert.match(due?.note ?? '', /due-when ref was refused .*so it is due now/);
    assert.equal(pushed.filter((p) => (p.message.step as { id?: string } | undefined)?.id === nowhere.id).length, 1, 'ONE push');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OA-3 — a session\'s act parks its phase on the step with its proof on the record, so the proof landing resumes the phase', () => {
  const s = scratch();
  try {
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
    const step = declareHumanStep({ ledger, announce: () => true }, {
      slug: 'demo', phase: 2, birth: 'session', step: ACT,
    })!;
    const state = newRun({ slug: 'demo', root: s.dir, onlyPhases: [2] } as never);
    const record = phaseRecord(state, 2);
    record.declared = { status: 'needs-human', by: 'session', at: step.declaredAt } as never;
    parkOnStep(record, step, 'session', step.declaredAt);
    // The proof rides the record while the act is still coming up: done early,
    // it is proven early, and the same landing resumes the phase that needed it.
    assert.deepEqual(stepProofOf(record)?.ref, ACT.proof);
    assert.equal(record.declared?.step?.kind, 'operator-act');
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * OA-4 — one list across plans, worst-first, each line copyable
 * ------------------------------------------------------------------ */

test('OA-4 — one list across plans: every act due now before any coming up, each row carrying its command', () => {
  const s = scratch();
  try {
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
    const announce = (): boolean => true;
    const upcoming = declareHumanStep({ ledger, announce }, { slug: 'alpha', phase: 2, birth: 'session', step: ACT })!;
    const dueOther = declareHumanStep({ ledger, announce }, {
      slug: 'beta', phase: 5, birth: 'session',
      step: { kind: 'operator-act', title: 'Approve the deploy', open_command: 'gh workflow run deploy.yml -R acme/app' },
    })!;
    const ownAct = declareHumanStep({ ledger, announce }, {
      slug: 'gamma', phase: 0, birth: 'plan', step: { kind: 'operator-act', title: 'Renew the domain', open_url: 'https://registrar.example/renew' },
    })!;
    const rows = buildInbox({ humanSteps: ledger.open() }).items.filter((item) => item.kind === 'human-step');
    const order = rows.map((row) => row.humanStep?.stepId);
    // Due (needs-you) rows sort ahead of the coming-up ones, across plans.
    assert.ok(order.indexOf(upcoming.id) > order.indexOf(dueOther.id), 'coming up sorts after due now');
    assert.ok(order.indexOf(upcoming.id) > order.indexOf(ownAct.id));
    const beta = rows.find((row) => row.humanStep?.stepId === dueOther.id)!;
    assert.equal(beta.severity, 'needs-you');
    assert.equal(beta.humanStep?.openCommand, 'gh workflow run deploy.yml -R acme/app', 'the exact line, to copy');
    // The plan's own act (phase 0) is a row of the plan, not of a phase.
    const gamma = rows.find((row) => row.humanStep?.stepId === ownAct.id)!;
    assert.equal(gamma.slug, 'gamma');
    assert.equal(gamma.phase, undefined);
    assert.match(gamma.title, /for gamma \(the plan's own\)$/);
  } finally {
    s.cleanup();
  }
});

test('OA-4 — the launch door carries a plan act\'s due: ref, so a bullet under ## Operator errands is born upcoming', async () => {
  const steps = await doorSteps([{
    phase: 0,
    step: { kind: 'operator-act', what: 'restart the hub', where: 'host', open: 'phase-console update hub', due: 'phase:demo/2' },
  }], undefined);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.phase, 0);
  assert.equal(steps[0]!.due, 'phase:demo/2');
  assert.deepEqual(steps[0]!.open, { command: 'phase-console update hub' });
  // Read back as a fixture plan would be, the engine and the parser agree on it
  // (engine-parity) — here only that the source text names the field.
  assert.match(readFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'operator-acts.md'), 'utf8'), /due: `phase:operator-acts\/2`/);
});

test('OA-4 — a due: ref is judged by its scheme\'s SHAPE, the same in the parser, the ledger and the F37 lint', () => {
  // human-steps.bats holds the bash twin to the same five refusals.
  for (const bad of ['date:2026-10-06', 'phase:operator-acts', 'unit:-oProxyCommand=x/y', 'gh:acme/app', 'cmd:""', 'next tuesday']) {
    assert.equal(dueRefOk(bad), false, bad);
  }
  for (const good of ['date:2026-10-06T09:00:00Z', 'phase:operator-acts/2', 'unit:build-box/nightly-build.service',
    'gh:acme/app#run/42', 'gh:acme/app#pr/7', 'cmd:"curl -sf http://127.0.0.1:4123/api/state"', 'lock:demo/3', 'verify:demo/3']) {
    assert.equal(dueRefOk(good), true, good);
  }
});
