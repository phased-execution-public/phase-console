/**
 * A person's turn (control-tower phase 41) — the ledger, the ingest, the park.
 *
 *   HS-1  the ledger is append-only NDJSON folded last-state-wins, held to the
 *         state machine on read; a torn last line is dropped; the rotated copy
 *         is folded in.
 *   HS-2  a declared step is recorded, raises ONE `needs-you` push naming its
 *         actions, and ONE `human-step` inbox row — through the real Service.
 *   HS-3  a session's `needs-human --step` parks the phase on a PERSON through
 *         the real Runner: the step in the ledger, `declared.step` on the
 *         record, an UNBUDGETED wait of kind `person`, no wait count, no budget
 *         stamp, and the person's situation `blocked-declared:human-acts`.
 *   HS-4  `auto-open: host` is kept only on a PLAN-declared step.
 *   HS-5  `secret-entry` stores into the credential registry — the keychain on
 *         stdin, else a 0600 file — and nothing reads it back.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  HumanStepLedger, declareHumanStep, parkOnStep, phaseWaitKind, readLedger, sanitiseStep, stepKeychainService,
  storeStepSecret,
} = await import('../server/human-steps.ts');
const humanStepsModule = await import('../server/human-steps.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { humanStepPush, HUMAN_STEP_PUSH_ACTIONS } = await import('../server/push/catalogue.ts');
const { KIND_META } = await import('../shared/human-step-model.js');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { journalFile, newRun, phaseRecord } = await import('../server/runner/state.ts');
const { parkedMsOf } = await import('../server/runner/wait-budget.ts');
const { declaredSubKind } = await import('../server/runner/situation.ts');
const { actorFor } = await import('../shared/situation-model.js');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type HumanStep = import('../server/human-steps.ts').HumanStep;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-human-steps-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const STEP = {
  kind: 'browser-login', title: 'Sign the gh CLI in to the acme org', open_command: 'gh auth login',
  proof: 'cmd:"gh auth status"', lines: ['Run the command', 'Approve it in the browser'],
};

/* ------------------------------------------------------------------ *
 * HS-1 — the ledger
 * ------------------------------------------------------------------ */

test('HS-1 — append-only NDJSON, last state wins, the state machine held on read', () => {
  const s = scratch();
  try {
    const file = join(s.dir, 'human-steps.ndjson');
    const ledger = new HumanStepLedger(file);
    const clean = sanitiseStep(STEP, 'session')!;
    const step = ledger.declare({ slug: 'demo', phase: 3, birth: 'session', clean: clean.step });
    assert.equal(step.state, 'declared');
    assert.match(step.id, /^[0-9a-f]{12}$/);
    const sizes = [statSync(file).size];
    for (const to of ['notified', 'opened', 'opened', 'checking'] as const) {
      const moved = ledger.move(step.id, to);
      assert.ok(!('refused' in moved), `${to} refused`);
      const size = statSync(file).size;
      assert.ok(size > sizes[sizes.length - 1], 'every move APPENDS; nothing is rewritten');
      sizes.push(size);
    }
    assert.equal(ledger.get(step.id)!.state, 'checking');
    assert.equal(ledger.get(step.id)!.opened, 2, 'opening again is counted');
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 5);

    const proven = ledger.move(step.id, 'proven', { note: 'gh auth status exited 0' });
    assert.ok(!('refused' in proven) && proven.state === 'proven');
    // A settled step cannot be moved — by the door, or by a line written past it.
    assert.deepEqual(ledger.move(step.id, 'opened'), { refused: 'transition', from: 'proven', to: 'opened' });
    appendFileSync(file, `${JSON.stringify({ v: 1, id: step.id, state: 'notified', at: new Date().toISOString() })}\n`);
    const read = readLedger(file);
    assert.equal(read.steps.get(step.id)!.state, 'proven', 'a line moving a settled step is ignored on read');
    assert.equal(read.skipped, 1);
    assert.deepEqual(ledger.open(), [], 'a proven step raises no row');
    assert.deepEqual(ledger.move('nope', 'opened'), { refused: 'unknown-step', to: 'opened' });
  } finally { s.cleanup(); }
});

test('HS-1 — a torn last line is dropped; a garbage line is skipped; the rotated copy is folded in', () => {
  const s = scratch();
  try {
    const file = join(s.dir, 'human-steps.ndjson');
    const ledger = new HumanStepLedger(file);
    const clean = sanitiseStep(STEP, 'session')!.step;
    const old = ledger.declare({ slug: 'demo', phase: 1, birth: 'session', clean });
    // Rotate by hand, as the retention sweep does: the live file becomes `.1`.
    writeFileSync(`${file}.1`, readFileSync(file, 'utf8'));
    writeFileSync(file, '');
    const moved = ledger.move(old.id, 'notified');
    assert.ok(!('refused' in moved), 'a step declared before a rotation is still read after it');
    appendFileSync(file, 'not json\n');
    // A console that died inside a write: a line with no newline.
    appendFileSync(file, JSON.stringify({ v: 1, id: old.id, state: 'cannot', at: new Date().toISOString() }).slice(0, 30));
    const read = readLedger(file);
    assert.equal(read.torn, true);
    assert.equal(read.skipped, 1);
    assert.equal(read.steps.get(old.id)!.state, 'notified', 'the torn move never happened');
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * HS-2 — ONE push, ONE inbox row, through the real Service
 * ------------------------------------------------------------------ */

test('HS-2 — a declared step is recorded, announced ONCE with its actions, and raises ONE inbox row', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-human-steps-root-'));
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
    const before = svc.humanStepsNow().all().length;
    const step = svc.recordHumanStep({
      slug: 'demo', phase: 4, birth: 'session', runId: 'r1',
      step: { kind: 'device-code', title: 'Enter the code the CLI printed', open_url: 'https://github.com/login/device', code: 'WDJB-MJHT' },
    })!;
    assert.ok(step, 'the step was recorded');
    assert.equal(step.state, 'notified');
    assert.equal(step.pushed, true);
    assert.equal(svc.humanStepsNow().all().length, before + 1);

    const mine = pushed.filter((p) => (p.message.step as { id?: string } | undefined)?.id === step.id);
    assert.equal(mine.length, 1, 'ONE push');
    assert.equal(mine[0].category, 'needs-you');
    const payload = mine[0].message;
    assert.deepEqual((payload.step as { actions: unknown }).actions, HUMAN_STEP_PUSH_ACTIONS);
    assert.deepEqual(HUMAN_STEP_PUSH_ACTIONS.map((a) => a.title), ['Open', 'I did it']);
    assert.equal((payload.step as { code?: string }).code, 'WDJB-MJHT', 'a device code rides the push, on purpose');
    assert.match(String(payload.body), /WDJB-MJHT/);
    assert.match(String(payload.title), /^Your turn: enter a device code — demo phase 4$/);

    const view = buildInbox({ humanSteps: svc.humanStepsNow().open() });
    const rows = view.items.filter((item) => item.kind === 'human-step' && item.id.includes(step.id));
    assert.equal(rows.length, 1, 'ONE inbox row');
    const row = rows[0];
    assert.equal(row.severity, 'needs-you');
    assert.equal(row.phase, 4);
    assert.match(row.need, /Enter the code the CLI printed — code WDJB-MJHT/);
    assert.match(row.how, /From any device: open https:\/\/github\.com\/login\/device/);
    assert.equal(row.since, step.declaredAt);

    // Settled, it raises nothing.
    svc.humanStepsNow().move(step.id, 'proven');
    assert.equal(buildInbox({ humanSteps: svc.humanStepsNow().open() }).items.filter((i) => i.id.includes(step.id)).length, 0);
    // Not a step at all: no kind, no title — nothing written, nothing pushed.
    const count = pushed.length;
    assert.equal(svc.recordHumanStep({ slug: 'demo', phase: 4, birth: 'session', step: { kind: 'credential', title: 'x' } }), null);
    assert.equal(pushed.length, count);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HS-2 — the push words name the kind and the phase; the detail a webhook carries never holds the code', () => {
  const push = humanStepPush({
    id: 'abc', kind: 'device-code', label: KIND_META['device-code'].label, title: 'Enter the code', where: 'any',
    slug: 'demo', phase: 2, code: 'ABCD-1234',
  });
  assert.match(push.message.body, /ABCD-1234/);
  assert.doesNotMatch(push.message.detail, /ABCD-1234/);
  const host = humanStepPush({ id: 'x', kind: 'os-prompt', label: KIND_META['os-prompt'].label, title: 'Unlock the keychain', where: 'host', slug: 'demo', phase: 2 });
  assert.match(host.message.body, /at the machine the console runs on/);
  assert.equal(host.step.code, undefined);
});

/* ------------------------------------------------------------------ *
 * HS-3 — the park, through the real Runner
 * ------------------------------------------------------------------ */

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function stubRepo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-human-step-park-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) printf 'done: \\nin-progress: \\nstuck: \\nready: 1\\nwaiting: \\n' ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  --qa-history) exit 0 ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('HS-3 — needs-human --step parks the phase on a PERSON: the ledger, an unbudgeted person wait, no wait count, no budget stamp', async () => {
  const r = stubRepo();
  const s = scratch();
  const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
  const announced: HumanStep[] = [];
  const spawn: SpawnFn = async (request) => {
    writeFileSync(request.env!.PE_OUTCOME_FILE as string, JSON.stringify({
      version: 1, slug: 'demo', phase: 1, written_at: new Date().toISOString(), watch: [],
      status: 'needs-human', needs: 'credential', reason: 'gh is signed out', step: STEP,
    }));
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-1', costUsd: 0, turns: 1,
      resultText: 'declared', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  const runner = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    humanStep: (input) => declareHumanStep({ ledger, announce: (step) => { announced.push(step); return true; } }, input),
  });
  try {
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: false } as never);
    await runner.wait();
    const state = runner.current()!;
    const record = state.phases['1'];
    assert.equal(record.status, 'parked');
    const steps = ledger.all();
    assert.equal(steps.length, 1, 'the step is in the ledger');
    assert.equal(steps[0].state, 'notified');
    assert.equal(steps[0].birth, 'session');
    assert.equal(steps[0].slug, 'demo');
    assert.equal(announced.length, 1, 'ONE push');
    // Phase 43: the proof and the window's end ride the declaration, so the
    // watch clock can poll the proof off the record and stop at the window.
    assert.deepEqual(record.declared?.step, {
      id: steps[0].id, kind: 'browser-login', proof: 'cmd:"gh auth status"',
      until: new Date(Date.parse(steps[0].declaredAt) + 7 * 24 * 3_600_000).toISOString(),
    });
    // The wait: a PERSON, unbudgeted — never the external-wait budget's.
    assert.equal(phaseWaitKind(record), 'person');
    assert.equal(record.waits ?? 0, 0, 'no declared wait is counted');
    assert.equal(record.declared?.budget, undefined, 'no wait budget is stamped on a person\'s turn');
    assert.equal(parkedMsOf(record, Date.now() + 10 * 3_600_000), 0, 'ten hours later, nothing charged');
    // The person's situation: no rung may spend a session on it.
    assert.equal(declaredSubKind(record.declared), 'human-acts');
    assert.equal(actorFor('blocked-declared', 'human-acts'), 'person');
    const errand = state.recoveries?.['1']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:human-acts');
    assert.match(String(errand?.need), /Your turn — sign in in a browser: Sign the gh CLI in to the acme org/);
    const lines = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const journalled = lines.filter((l: { event: string }) => l.event === 'phase.human-step');
    assert.equal(journalled.length, 1);
    assert.equal(journalled[0].data.stepId, steps[0].id);
  } finally {
    runner.close();
    r.cleanup();
    s.cleanup();
  }
});

test('HS-3 — parkOnStep closes the park before it and opens an unbudgeted person wait on the step\'s window', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/none', onlyPhases: [2] } as never);
  const record = phaseRecord(state, 2);
  record.declared = { status: 'needs-human', at: '2026-09-30T10:00:00.000Z' };
  record.waitHistory = [{ parkedFrom: '2026-09-30T08:00:00.000Z', parkedUntil: '2026-09-30T09:00:00.000Z', by: 'session' }];
  parkOnStep(record, { id: 'abc123abc123', kind: 'third-party-approval', until: '2026-10-02T10:00:00.000Z' }, 'unsupervised', '2026-09-30T10:00:00.000Z');
  assert.equal(record.waitHistory![0].resumedAt, '2026-09-30T10:00:00.000Z', 'the earlier park is closed');
  assert.deepEqual(record.waitHistory![1], {
    parkedFrom: '2026-09-30T10:00:00.000Z', parkedUntil: '2026-10-02T10:00:00.000Z', by: 'unsupervised', unbudgeted: true, kind: 'person',
  });
  assert.equal(phaseWaitKind(record), 'person');
  // The earlier park counts until the step superseded it (08:00 → 10:00); a
  // day of waiting on the person after that adds nothing.
  const budgeted = parkedMsOf(record, Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(budgeted, 2 * 3_600_000, 'only the earlier, budgeted park counts');
  assert.equal(parkedMsOf(record, Date.parse('2026-10-05T10:00:00.000Z')), budgeted, 'the person wait is never summed');
});

/* ------------------------------------------------------------------ *
 * HS-4 — auto-open is a plan's alone
 * ------------------------------------------------------------------ */

test('HS-4 — `auto-open: host` is kept on a PLAN-declared step and dropped from a session\'s', () => {
  const offered = { ...STEP, auto_open: 'host' };
  assert.equal(sanitiseStep(offered, 'plan')!.step.autoOpen, 'host');
  const session = sanitiseStep(offered, 'session')!;
  assert.equal(session.step.autoOpen, undefined);
  assert.deepEqual(session.dropped, ['auto-open']);
  assert.equal(sanitiseStep({ ...STEP, auto_open: 'any' }, 'plan')!.step.autoOpen, undefined, 'host is the one value');
  const s = scratch();
  try {
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
    const step = declareHumanStep({ ledger, announce: () => true }, { slug: 'demo', phase: 1, birth: 'session', step: offered })!;
    assert.equal(step.autoOpen, undefined);
    assert.doesNotMatch(readFileSync(ledger.file, 'utf8'), /autoOpen|auto_open/);
    const plan = declareHumanStep({ ledger, announce: () => true }, { slug: 'demo', phase: 1, birth: 'plan', step: offered })!;
    assert.equal(plan.autoOpen, 'host');
  } finally { s.cleanup(); }
});

test('HS-4 — a link that is not http(s), a code off a device-code step, a credential off a secret-entry step: dropped by name', () => {
  const clean = sanitiseStep({
    kind: 'browser-login', title: 'x', open_url: 'javascript:alert(1)', code: 'ABCD-1234', credential: 'npm-token', where: 'phone',
  }, 'session')!;
  assert.equal(clean.step.openUrl, undefined);
  assert.equal(clean.step.code, undefined);
  assert.equal(clean.step.credential, undefined);
  assert.equal(clean.step.where, 'host', 'an unknown where falls back to the kind\'s');
  assert.deepEqual(clean.dropped.sort(), ['code', 'credential', 'open_url', 'where']);
  assert.equal(sanitiseStep({ kind: 'browser-login' }, 'session'), null, 'no title, no step');
  assert.equal(sanitiseStep({ kind: 'nope', title: 'x' }, 'session'), null, 'no kind, no step');
});

/* ------------------------------------------------------------------ *
 * HS-5 — secret-entry stores, and nothing reads it back
 * ------------------------------------------------------------------ */

test('HS-5 — on macOS the secret goes to the keychain on stdin, never in argv', async () => {
  const secret = `npm_${'s'.repeat(36)}`;
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec = (async (file: string, args: string[], opts?: { input?: string }) => {
    calls.push({ file, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return { stdout: '' };
  }) as never;
  const stored = await storeStepSecret({ dir: '/nonexistent', exec, platform: 'darwin' }, 'npm-token', secret);
  assert.deepEqual(stored, { stored: 'keychain', probe: `keychain:${stepKeychainService('npm-token')}` });
  assert.equal(stepKeychainService('npm-token'), 'phase-console-npm-token', 'the E5.1 item the plan names');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'security');
  assert.ok(!calls[0].args.some((arg) => arg.includes(secret)), 'never in argv');
  assert.deepEqual(calls[0].args.slice(0, 4), ['add-generic-password', '-U', '-s', 'phase-console-npm-token']);
  assert.equal(calls[0].input, `${secret}\n${secret}\n`, 'twice on stdin — security asks and asks again');
});

test('HS-5 — elsewhere the secret is a 0600 file in a 0700 directory, and a bad id or a two-line value is refused', async () => {
  const s = scratch();
  try {
    const dir = join(s.dir, 'secrets');
    const secret = 'Zq81xk2mP0-the-token';
    const stored = await storeStepSecret({ dir, platform: 'linux' }, 'license.signing_key', secret);
    assert.equal(stored.stored, 'file');
    assert.equal(stored.probe, `file:${join(dir, 'license.signing_key')}`);
    assert.equal(statSync(join(dir, 'license.signing_key')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(dir, 'license.signing_key'), 'utf8'), `${secret}\n`);
    await assert.rejects(storeStepSecret({ dir, platform: 'linux' }, '../escape', secret));
    await assert.rejects(storeStepSecret({ dir, platform: 'linux' }, 'ok-id', 'two\nlines'));
    await assert.rejects(storeStepSecret({ dir, platform: 'linux' }, 'ok-id', ''));

    // The ledger records WHERE it went — never what it was.
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'));
    const step = declareHumanStep({ ledger, announce: () => true }, {
      slug: 'demo', phase: 5, birth: 'session', step: { kind: 'secret-entry', title: 'Paste the signing key', credential: 'license.signing_key' },
    })!;
    const moved = ledger.move(step.id, 'checking', { by: 'person', stored: stored.stored });
    assert.ok(!('refused' in moved) && moved.stored === 'file');
    assert.doesNotMatch(readFileSync(ledger.file, 'utf8'), /Zq81xk2mP0/);
  } finally { s.cleanup(); }
});

test('HS-5 — nothing in the module reads a stored secret back: no reader is exported, no keychain read is made', () => {
  const exported = Object.keys(humanStepsModule).filter((name) => /secret/i.test(name)).sort();
  assert.deepEqual(exported, ['stepSecretHeldAsFile', 'storeStepSecret'], 'a store and a yes/no probe — no reader');
  const source = readFileSync(join(SKILL_DIR, 'viewer', 'server', 'human-steps.ts'), 'utf8');
  // Compared as booleans and short lists — an assertion that fails over the
  // whole source makes node diff twenty kilobytes, which takes minutes.
  assert.equal(source.includes('find-generic-password'), false, 'no keychain read');
  const reads = [...source.matchAll(/readFileSync\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(reads, ['path'], 'the one file read is the ledger\'s own (`linesOf`) — never a stored secret');
  assert.ok(/function linesOf\(path: string\)[\s\S]{0,200}readFileSync\(path, 'utf8'\)/.test(source), 'and it is inside linesOf');
});
