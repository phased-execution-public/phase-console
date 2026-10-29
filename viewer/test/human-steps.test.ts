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
  HumanStepLedger, bodyCarriesSecret, declareHumanStep, parkOnStep, phaseWaitKind, readLedger, sanitiseStep, secretPlace,
  stepKeychainService,
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

test('HS-1b (EI-6) — a second rotation keeps every OPEN step: its birth and moves are carried into the rotated file', async () => {
  const s = scratch();
  try {
    const { applyRetention } = await import('../server/retention.ts');
    const file = join(s.dir, 'human-steps.ndjson');
    const ledger = new HumanStepLedger(file);
    const clean = sanitiseStep(STEP, 'session')!.step;
    const open = ledger.declare({ slug: 'demo', phase: 1, birth: 'session', clean });
    const settled = ledger.declare({ slug: 'demo', phase: 2, birth: 'session', clean });
    assert.ok(!('refused' in ledger.move(open.id, 'notified')));
    assert.ok(!('refused' in ledger.move(settled.id, 'cannot')));
    const rotate = () => applyRetention([{ kind: 'rotate', sink: 'human-steps', path: file, bytes: 1, why: 'test' }]);
    rotate();
    ledger.move(open.id, 'opened');
    // The second rotation replaces `.1` — the file that held the open step's birth.
    rotate();
    const read = readLedger(file);
    assert.equal(read.steps.get(open.id)?.state, 'opened', 'the open step and its every move survive the second rotation');
    assert.equal(read.steps.has(settled.id), false, 'a settled step is not carried');
    assert.equal(read.skipped, 0, 'nothing is read out of order');
    assert.equal(readFileSync(file, 'utf8'), '', 'the live file starts empty');
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
    // The composer's words (turn-by-turn phase 3): the act, then where and how it is checked.
    assert.equal(String(payload.title), 'Your turn: Enter the code the CLI printed');
    assert.match(String(payload.body), /^Phase 4 of demo\. The code is WDJB-MJHT\./);

    const view = buildInbox({ humanSteps: svc.humanStepsNow().open() });
    const rows = view.items.filter((item) => item.kind === 'human-step' && item.id.includes(step.id));
    assert.equal(rows.length, 1, 'ONE inbox row');
    const row = rows[0];
    assert.equal(row.severity, 'needs-you');
    assert.equal(row.phase, 4);
    assert.equal(row.title, 'Enter the code the CLI printed', 'the row is titled by the act');
    assert.match(row.need, /The code is WDJB-MJHT\./);
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
  assert.match(host.message.body, /at the machine this console runs on/);
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
    assert.match(String(errand?.need), /^Sign in in a browser: Sign the gh CLI in to the acme org\.$/);
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
 * HS-5 — secret-entry stores NOTHING (control-tower phase 133, #210):
 * the item says where its value goes and is proven there by name
 * ------------------------------------------------------------------ */

test('HS-5 — a secret-entry item says where its value goes, and names the ref that proves it there by name', () => {
  const step = { credential: 'npm-token' };
  const mac = secretPlace(step, { dir: '/state/secrets', platform: 'darwin' });
  assert.equal(stepKeychainService('npm-token'), 'phase-console-npm-token', 'the E5.1 item the plan names');
  assert.equal(mac.ref, 'credential:keychain:phase-console-npm-token');
  assert.match(mac.where, /login keychain, as the item `phase-console-npm-token`/);
  assert.match(mac.where, /security add-generic-password -U -s phase-console-npm-token -a "\$USER" -w/, 'a command that ASKS for it');
  const linux = secretPlace(step, { dir: '/state/secrets', platform: 'linux' });
  assert.equal(linux.ref, 'credential:file:/state/secrets/npm-token');
  assert.match(linux.where, /mode 0600/);
  // The item's own credential: proof wins, in its own words.
  assert.equal(secretPlace({ credential: 'x', proof: 'credential:env:NPM_TOKEN' }, { dir: '/d' }).ref, 'credential:env:NPM_TOKEN');
  assert.match(secretPlace({ proof: 'credential:env:NPM_TOKEN' }, { dir: '/d' }).where, /environment variable `NPM_TOKEN`/);
  assert.match(secretPlace({ proof: 'credential:gh' }, { dir: '/d' }).where, /gh auth login/);
  assert.equal(secretPlace({ openCommand: 'vercel env add KEY' }, { dir: '/d' }).ref, undefined, 'a command is words, never a proof');
  assert.equal(secretPlace({ credential: '../escape' }, { dir: '/d' }).ref, undefined, 'a bad id names no file');
});

test('HS-5 — a body carrying a secret is one a verb refuses: a `secret` field at all, or a value shaped like one', () => {
  assert.equal(bodyCarriesSecret({ secret: '' }), true, 'the field itself, whatever it holds');
  assert.equal(bodyCarriesSecret({ note: `use npm_${'s'.repeat(36)}` }), true);
  assert.equal(bodyCarriesSecret({ note: 'password=hunter2hunter2' }), true);
  assert.equal(bodyCarriesSecret({ note: 'It is done — the light is green.' }), false);
  assert.equal(bodyCarriesSecret({}), false);
  assert.equal(bodyCarriesSecret(undefined), false);
});

test('HS-5 — nothing in the module stores or reads a secret: no store, no reader, no keychain call, one file read', () => {
  const exported = Object.keys(humanStepsModule).filter((name) => /secret/i.test(name)).sort();
  assert.deepEqual(exported, ['bodyCarriesSecret', 'secretPlace'], 'a place and a screen — no store and no reader');
  const source = readFileSync(join(SKILL_DIR, 'viewer', 'server', 'human-steps.ts'), 'utf8');
  // Compared as booleans and short lists — an assertion that fails over the
  // whole source makes node diff twenty kilobytes, which takes minutes.
  assert.equal(source.includes('find-generic-password'), false, 'no keychain read');
  assert.equal(source.includes('keychainStore'), false, 'no keychain write');
  assert.equal(source.includes('writeFileSync'), false, 'no file write but the ledger\'s own append');
  const reads = [...source.matchAll(/readFileSync\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(reads, ['path'], 'the one file read is the ledger\'s own (`linesOf`) — never a stored secret');
  assert.ok(/function linesOf\(path: string\)[\s\S]{0,200}readFileSync\(path, 'utf8'\)/.test(source), 'and it is inside linesOf');
});

test('control-tower phase 130: the ledger writes version 2 and still reads version 1', async () => {
  const { HUMAN_STEP_LINE_VERSION, HUMAN_STEP_LINE_VERSIONS, withTurnDefaults } = await import('../server/human-steps.ts');
  assert.equal(HUMAN_STEP_LINE_VERSION, 2);
  assert.deepEqual([...HUMAN_STEP_LINE_VERSIONS], [1, 2]);
  const old = withTurnDefaults({
    id: 'x', kind: 'person-check', title: 'Look at it', where: 'any', birth: 'plan', slug: 's', phase: 1,
    state: 'notified', declaredAt: '2026-10-01T00:00:00Z', at: '2026-10-01T00:00:00Z', opened: 0,
  } as never);
  assert.deepEqual([old.why, old.whySource, old.proofType, old.attempts], ['decision', 'inferred', 'answer', 0]);
  assert.deepEqual(old.waiters, [{ slug: 's', phase: 1 }]);
});

test('phase 132: a console item keeps the source that raised it; a session or a plan cannot name one', async () => {
  const { sanitiseStep } = await import('../server/human-steps.ts');
  const console_ = sanitiseStep({ kind: 'operator-act', title: 'Run the applies', source: { kind: 'errand', ref: 'blocked-declared:human-acts' } }, 'console');
  assert.deepEqual(console_?.step.source, { kind: 'errand', ref: 'blocked-declared:human-acts' });
  for (const birth of ['session', 'plan'] as const) {
    const clean = sanitiseStep({ kind: 'operator-act', title: 'Run the applies', proof_type: 'attest', source: { kind: 'errand' } }, birth);
    assert.equal(clean?.step.source, undefined, `a ${birth} step names no source`);
    assert.ok(clean?.dropped.includes('source'));
  }
  const bad = sanitiseStep({ kind: 'operator-act', title: 'x', source: { kind: 'Not A Word!' } }, 'console');
  assert.equal(bad?.step.source, undefined);
});

/* ------------------------------------------------------------------ *
 * HS-6 — the check's record (control-tower phase 134, #211)
 * ------------------------------------------------------------------ */

test('HS-6 — a verdict rides its move: the item keeps the last and every one, its attempts, and when it escalated', async () => {
  const { shapeVerdict } = await import('../server/turn/verdict.ts');
  const s = scratch();
  try {
    const file = join(s.dir, 'human-steps.ndjson');
    const ledger = new HumanStepLedger(file);
    const step = ledger.declare({ slug: 'demo', phase: 3, birth: 'session', clean: sanitiseStep(STEP, 'session')!.step });
    assert.equal(step.attempts, 0);
    assert.equal(step.verdict, undefined, 'a fresh item has no verdict');
    const at = '2026-10-07T10:00:00.000Z';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.ok(!('refused' in ledger.move(step.id, 'checking', { by: 'mobin', verb: 'check' })));
      const verdict = shapeVerdict({ state: 'rejected', note: `read ${attempt}`, redo: ['do it again'] }, { by: 'probe', attempt, at })!;
      const back = ledger.move(step.id, 'returned', {
        by: 'mobin', verb: 'return', note: 'Back to you', verdict, read: `exit ${attempt}`, ...(attempt === 3 ? { escalated: true as const } : {}),
      });
      assert.ok(!('refused' in back));
    }
    let now = ledger.get(step.id)!;
    assert.equal(now.state, 'returned');
    assert.equal(now.attempts, 3);
    assert.equal(now.read, 'exit 3', 'what the proof read at the last check');
    assert.deepEqual(now.verdicts?.map((v) => [v.attempt, v.state]), [[1, 'rejected'], [2, 'rejected'], [3, 'rejected']]);
    assert.ok(now.escalatedAt, 'escalated, once');
    const owner = shapeVerdict({ state: 'passed', note: 'Accepted anyway by the owner.' }, { by: 'owner', attempt: 3, at, unverified: true })!;
    assert.ok(!('refused' in ledger.move(step.id, 'proven', { by: 'mobin', verb: 'override', note: 'accepted anyway', verdict: owner })));
    now = ledger.get(step.id)!;
    assert.deepEqual([now.state, now.provenBy, now.verdict?.by, now.verdict?.unverified, now.verdicts?.length], ['proven', 'mobin', 'owner', true, 4]);
    const history = ledger.history(step.id);
    assert.deepEqual(history.filter((m) => m.verdict).map((m) => m.verb), ['return', 'return', 'return', 'override']);
    // A line written before phase 134 carries no verdict and reads as it always did.
    const old = ledger.declare({ slug: 'demo', phase: 4, birth: 'session', clean: sanitiseStep({ ...STEP, title: 'Another' }, 'session')!.step });
    appendFileSync(file, `${JSON.stringify({ v: 2, id: old.id, state: 'checking', at, verb: 'check' })}\n`);
    appendFileSync(file, `${JSON.stringify({ v: 2, id: old.id, state: 'notified', at, verb: 'check', note: 'pending' })}\n`);
    const read = readLedger(file).steps.get(old.id)!;
    assert.deepEqual([read.state, read.attempts, read.verdict, read.verdicts, read.read], ['notified', 1, undefined, undefined, 'pending']);
  } finally { s.cleanup(); }
});

// ---- turn-by-turn phase 2: a plan bullet's guide FILE -----------------------

test('turn-by-turn 2: a guide: file becomes the guide; outside the root, a symlink escaping it, oversized or secret-shaped is refused with a sentence', async () => {
  const { readGuideFile } = await import('../server/turn/guide-file.ts');
  const { symlinkSync } = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'pc-guide-file-'));
  const root = join(base, 'root');
  try {
    mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
    writeFileSync(join(base, 'outside.md'), 'Outside.\n\n## Steps\n1. Never read.\n');
    writeFileSync(join(root, 'docs', 'guides', 'ok.md'), 'Why it matters.\n\n## Steps\n1. Open the page.\n   Link: [it](https://example.com/)\n2. Press Save.\n\n## If it goes wrong\n- Nothing saves — press it again.\n');
    const good = readGuideFile(root, 'docs/guides/ok.md');
    assert.equal(good.ok, true);
    assert.deepEqual(good.ok && good.guide.steps.map((s) => s.text), ['Open the page.', 'Press Save.']);
    assert.equal(good.ok && good.guide.trouble.length, 1);

    const refused = (rel: string) => {
      const read = readGuideFile(root, rel);
      assert.equal(read.ok, false, rel);
      return read.ok ? '' : read.why;
    };
    assert.match(refused('../outside.md'), /is not a path under the docs root/);
    assert.match(refused('/etc/hosts'), /is not a path under the docs root/);
    assert.match(refused('docs/guides/missing.md'), /is not a file under the docs root/);
    // A link inside the root that leads out of it is refused as surely as ../
    symlinkSync(join(base, 'outside.md'), join(root, 'docs', 'guides', 'escape.md'));
    assert.match(refused('docs/guides/escape.md'), /leads outside the docs root/);
    // A link that stays inside is read.
    symlinkSync(join(root, 'docs', 'guides', 'ok.md'), join(root, 'docs', 'guides', 'alias.md'));
    assert.equal(readGuideFile(root, 'docs/guides/alias.md').ok, true);
    writeFileSync(join(root, 'docs', 'guides', 'big.md'), `Big.\n\n## Steps\n1. ${'x'.repeat(30 * 1024)}\n`);
    assert.match(refused('docs/guides/big.md'), /bytes, and a guide is 24576 at most/);
    const token = ['gh', 'p_', 'a'.repeat(36)].join('');
    writeFileSync(join(root, 'docs', 'guides', 'secret.md'), `Why.\n\n## Steps\n1. Paste ${token} into the box.\n`);
    const why = refused('docs/guides/secret.md');
    assert.match(why, /line 4 carries a secret-shaped value/);
    assert.ok(!why.includes(token), 'the refusal never carries the value');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * #351 — a reminder keeps a returned step returned
 * ------------------------------------------------------------------ */

test('#351 — a reminder on a returned step leaves it returned, still Redo, and counts the reminder', async () => {
  const { personStatusOf } = await import('../shared/turn-model.js');
  const s = scratch();
  try {
    let now = Date.parse('2026-10-17T08:00:00Z');
    const ledger = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'), () => new Date(now));
    const clean = sanitiseStep(STEP, 'session')!;
    const step = ledger.declare({ slug: 'demo', phase: 4, birth: 'session', runId: 'run-1', clean: clean.step });
    ledger.move(step.id, 'notified', { by: 'console', verb: 'notify', pushed: true });
    ledger.move(step.id, 'checking', { by: 'owner', verb: 'check' });
    ledger.move(step.id, 'returned', { by: 'console', verb: 'return', read: 'pending — exit 1' });
    assert.equal(personStatusOf(ledger.get(step.id)!), 'redo');
    now += 2 * 60 * 60_000;
    const pass = humanStepsModule.tickHumanSteps({ ledger, now, remind: () => true });
    assert.deepEqual(pass.reminded, [step.id], 'the reminder went out');
    const after = ledger.get(step.id)!;
    assert.equal(after.state, 'returned', 'a reminder never turns a Redo into a To do');
    assert.equal(personStatusOf(after), 'redo');
    assert.equal(after.reminders, 1);
    assert.equal(after.read, 'pending — exit 1', 'what the check read stays on the card');
    // The ledger re-read from disk folds the same line the same way.
    const reread = new HumanStepLedger(join(s.dir, 'human-steps.ndjson'), () => new Date(now)).get(step.id)!;
    assert.equal(reread.state, 'returned');
    // An open step that was never checked is still re-notified.
    const other = ledger.declare({ slug: 'demo', phase: 5, birth: 'session', runId: 'run-1', clean: clean.step });
    ledger.move(other.id, 'opened', { by: 'owner', verb: 'open' });
    now += 2 * 60 * 60_000;
    humanStepsModule.tickHumanSteps({ ledger, now, remind: () => true });
    assert.equal(ledger.get(other.id)!.state, 'notified');
  } finally { s.cleanup(); }
});

test('#346 — a Human step bullet inside an HTML comment is no step, on one line, across lines or never closed; nor does it bind an errand row', async () => {
  const { parsePlan, humanStepsFor } = await import('../server/parse/plan.ts');
  const path = join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'commented-human-step.md');
  const plan = parsePlan(readFileSync(path, 'utf8'), 'commented-human-step', path);
  // Phase 1: the template's commented example is gone; the real bullet is read
  // whole, its trailing comment cut — `why: identity`, not a reason carrying
  // the note.
  assert.deepEqual(humanStepsFor(plan, 1), [{
    kind: 'browser-login', what: 'sign the gh CLI in to the org', where: 'host', open: 'gh auth login --web',
    proof: 'cmd:"gh auth status"', why: 'identity',
  }]);
  // Phase 2: three commented bullets across lines, one real one after them.
  assert.deepEqual(humanStepsFor(plan, 2).map((step) => step.what), ['rotate the deploy key (E-1)']);
  // Phase 0: a one-line comment and one never closed leave the section no step.
  assert.deepEqual(humanStepsFor(plan, 0), []);
  assert.equal(plan.operatorErrands, undefined);
  // E-2 is named only by commented bullets, so it binds nothing (F43's twin).
  assert.deepEqual(plan.errandsTable?.unbound, ['E-2']);
  assert.deepEqual(plan.errandsTable?.rows.filter((row) => row.bound).map((row) => row.id), ['E-1']);
});

test('B2 — a deferral on the runner: noted with its call, answered once, spent by its own re-fire and by no other call', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const lines: { event: string; data: Record<string, unknown> }[] = [];
  const runner = new Runner({
    scriptsDir: '/nonexistent',
    onEvent: (name: string, data: { event: string; data: Record<string, unknown> }) => { if (name === 'run:journal') lines.push(data); },
  } as never);
  const state = { id: 'r-b2', slug: 'demo', root: '/nonexistent', status: 'running', phases: { 8: { status: 'running', sessionId: 's1' } } };
  (runner as unknown as { state: unknown }).state = state;
  assert.equal(runner.answerDeferred(8, 'x'), false, 'nothing deferred, nothing to answer');
  runner.noteDeferred(8, { toolUseId: 'toolu_1', sessionId: 's1', command: 'bash phase-outcome.sh demo 8 needs-human', exit: 0 });
  assert.equal(lines.at(-1)?.event, 'phase.deferred');
  assert.deepEqual(lines.at(-1)?.data, { toolUseId: 'toolu_1', sessionId: 's1', exit: 0 });
  assert.equal(runner.takeDeferred(8, 'toolu_other'), null, 'another call is not the deferred one');
  assert.equal(runner.answerDeferred(8, 'proven', 'hs-1'), true);
  assert.deepEqual(runner.takeDeferred(8, 'toolu_1'), { answer: 'proven' });
  const resumed = lines.find((l) => l.event === 'phase.deferred-resumed')!;
  assert.equal(resumed.data.answered, true);
  assert.equal(resumed.data.stepId, 'hs-1');
  assert.equal(runner.takeDeferred(8, 'toolu_1'), null, 'spent once');
  // A re-fire with no answer (a resume for another reason) runs the call as written.
  runner.noteDeferred(8, { toolUseId: 'toolu_2', sessionId: 's1', command: 'c', exit: 0 });
  assert.deepEqual(runner.takeDeferred(8, 'toolu_2'), {});
});
