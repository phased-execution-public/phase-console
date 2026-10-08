/**
 * MG-1..3 (control-tower phase 107, #174) — a gate the plan marks MANUAL is a
 * person's.
 *
 * An unattended session of another console's plan read its permission line
 * ("all permissions") as delegating a manual gate, wrote its own approval row —
 * `| 6 | yes | ai-session-delegated | … |` — and the engine answered
 * `clear (approved by ai-session-delegated)`. The session then changed
 * production data. It had been told to: the shipped `gates: delegated` booted
 * the phase with a brief to verify the gate and record that very row.
 *
 * MG-1  Never delegated. The runner holds a manual gate whatever the `gates`
 *       row says (runner.test.ts), the classifier's evidence never calls one
 *       delegated, and the boot prompt never tells a session to clear one.
 * MG-2  Refused at the door. `gate-approve.sh` names the door from its own
 *       environment — never from `--by` — and refuses a manual gate from a
 *       session, a script or an `ai-*` approver; the console writes through
 *       its own door only for a person's press (the Gate card from a browser,
 *       a phone's signed Approve, a chat act a person confirmed), and refuses
 *       anything else before the script is asked.
 * MG-3  Ignored when read. `--gate-status` honours a manual row only when a
 *       person's door (`console`, `terminal`) wrote it — so the legacy row
 *       #174's session wrote, or one written by hand, opens nothing.
 * OD-7  (control-tower phase 131, #208) The console's person test is a DOOR,
 *       not a User-Agent: `owner` or `device`, and `local` on a console with
 *       no owner key — where the approval says so. A request that proves it
 *       is a session's or the supervisor's is refused whatever its User-Agent.
 *       (A local process outside a session could already clear a manual gate
 *       through `gate-approve.sh` in a terminal — the `terminal` door — so an
 *       unenrolled console's `local` opens nothing that was shut.)
 */

import '../e2e/fixture/steady-load.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every state-dir consumer this pulls in reads these at module load, so they
// have to be redirected before the imports below.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-manual-gate-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { planWrite, GATE_DOOR_CONSOLE_ENV } = await import('../server/writes.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: SCRIPTS, logFile: null };

const PLAN = `---
slug: SLUG
created: 2026-10-03
status: active
phases: 3
handoffs: docs/handoffs/SLUG/
memory: project_SLUG
---

# SLUG

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | cancel-rows | — | — | app | rows cancelled |
| 2 | verify-staging | — | — | app | staging green |
| 3 | open | — | — | app | it works |

### Phase 1 — cancel-rows *(GATED)*
- **Gates (must clear first):** the owner approves cancelling backtest rows 1–4
- **Gate-check:** manual the owner approves the content change
- **Size:** S

### Phase 2 — verify-staging *(GATED)*
- **Gates (must clear first):** staging deployed and smoke tests green
- **Gate-check:** ai verify staging deploy and smoke tests
- **Size:** S

### Phase 3 — open
- **Size:** S
`;

function library(slug: string) {
  const root = mkdtempSync(join(tmpdir(), 'pc-manual-gate-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN.replaceAll('SLUG', slug));
  return {
    root,
    file: join(root, 'docs', 'handoffs', slug, 'gate-status.md'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function service(t: { after(fn: () => void): void }, root: string) {
  const svc = new Service(flags as never);
  const check = svc.open(root);
  assert.equal(check.ok, true, `expected a readable library: ${JSON.stringify(check)}`);
  t.after(() => svc.close());
  return svc;
}

/** The environment of a session the console supervises — the door #174 came through. */
const UNATTENDED = {
  PE_OWNER: 'autopilot/r1', PE_OUTCOME_FILE: '/tmp/outcome.json', CLAUDECODE: '1', PE_GATE_DOOR: '',
};

/** Run one of the skill's scripts the way a session's Bash call would: no terminal on stdin. */
function script(name: string, args: string[], root: string, env: Record<string, string> = {}) {
  const run = spawnSync('bash', [join(SCRIPTS, name), ...args], {
    env: { ...process.env, PE_OWNER: '', PE_OUTCOME_FILE: '', PE_SESSION_KIND: '', CLAUDECODE: '', PE_GATE_DOOR: '', ...env, DOCS_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}` };
}

/** A gate-status.md as a hand (or an older script) writes it. */
function handRows(file: string, rows: string[], door: boolean) {
  const header = door
    ? '| Phase | Approved | By | Date | Note | Door |\n|------:|----------|----|------|------|------|'
    : '| Phase | Approved | By | Date | Note |\n|------:|----------|----|------|------|';
  writeFileSync(file, `# Gate approvals\n\n## Gate approvals\n\n${header}\n${rows.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * MG-1 — never delegated
 * ------------------------------------------------------------------ */

test('MG-1: the boot prompt never tells a session to clear a manual gate — delegated or not', (t) => {
  const lib = library('nodelegate');
  t.after(lib.cleanup);
  for (const delegate of ['0', '1']) {
    const prompt = script('phase-graph.sh', ['nodelegate', '--boot-prompt', '1'], lib.root, { PE_GATE_DELEGATE: delegate });
    assert.equal(prompt.code, 0, prompt.out);
    assert.match(prompt.out, /GATED phase \(human\) — STOP/);
    assert.match(prompt.out, /Do NOT implement past an unapproved human gate/);
    assert.match(prompt.out, /needs-human --needs gates/, 'unattended, the stop is a declared outcome by key');
    assert.doesNotMatch(prompt.out, /ai-session-delegated|DELEGATED to you/, `PE_GATE_DELEGATE=${delegate}`);
  }
  // An ai gate keeps its own brief, exactly as before.
  const ai = script('phase-graph.sh', ['nodelegate', '--boot-prompt', '2'], lib.root);
  assert.match(ai.out, /GATED phase \(ai-clearable\)/);
  assert.match(ai.out, /--by "ai-session"/);
});

test('MG-1: the classifier\'s evidence never calls a manual gate delegated, under the shipped `gates: delegated`', (t) => {
  const lib = library('evidence');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);
  const deps = (svc as unknown as {
    evidenceDeps(slug: string): { gateDelegated?: (slug: string, phase: number) => boolean };
  }).evidenceDeps('evidence');
  assert.equal(deps.gateDelegated?.('evidence', 1), false, "a manual gate is a person's whatever the policy says");
  assert.equal(deps.gateDelegated?.('evidence', 2), true, 'the shipped answer still reaches a gate the plan did not mark manual');
});

/* ------------------------------------------------------------------ *
 * MG-2 — refused at the door
 * ------------------------------------------------------------------ */

test('MG-2: gate-approve.sh refuses a manual gate from an unattended session, whatever --by says', (t) => {
  const lib = library('door');
  t.after(lib.cleanup);
  for (const by of ['mobin (operator)', 'ai-session-delegated']) {
    const refused = script('gate-approve.sh', ['door', '1', '--by', by, '--note', 'the owner granted all permissions'], lib.root, UNATTENDED);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /MANUAL gate — a person's to clear/);
    assert.match(refused.out, /Gate card/);
  }
  // A session cannot borrow the console's door by exporting its word.
  const borrowed = script('gate-approve.sh', ['door', '1', '--by', 'op'], lib.root, { ...UNATTENDED, PE_GATE_DOOR: 'console' });
  assert.equal(borrowed.code, 1, borrowed.out);
  // A script with no person behind it (no terminal, no door) is refused too.
  const bare = script('gate-approve.sh', ['door', '1', '--by', 'op'], lib.root);
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /the script door/);
  assert.ok(!existsSync(lib.file) || !/^\| 1 \|/m.test(readFileSync(lib.file, 'utf8')), 'nothing was written');

  // The same session may still clear an AI gate — that one is a session's job.
  const ai = script('gate-approve.sh', ['door', '2', '--by', 'ai-session', '--note', 'smoke green'], lib.root, UNATTENDED);
  assert.equal(ai.code, 0, ai.out);
  assert.match(readFileSync(lib.file, 'utf8'), /^\| 2 \| yes \| ai-session \| \d{4}-\d{2}-\d{2} \| smoke green \| session \|$/m);
});

test('MG-2: an ai-* approver is refused even through the console\'s door; a person through it is recorded as console', (t) => {
  const lib = library('approver');
  t.after(lib.cleanup);
  const viaConsole = { ...UNATTENDED, ...GATE_DOOR_CONSOLE_ENV };
  const ai = script('gate-approve.sh', ['approver', '1', '--by', 'ai-session-delegated'], lib.root, viaConsole);
  assert.equal(ai.code, 1, ai.out);
  assert.match(ai.out, /names an automatic approver/);
  const person = script('gate-approve.sh', ['approver', '1', '--by', 'mobin'], lib.root, viaConsole);
  assert.equal(person.code, 0, person.out);
  assert.match(readFileSync(lib.file, 'utf8'), /^\| 1 \| yes \| mobin \| \d{4}-\d{2}-\d{2} \| - \| console \|$/m);
});

test('MG-2: the console opens a manual gate only to a person\'s press — and writes through its own door then', async (t) => {
  const lib = library('press');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);

  // A press with no door — and one through an agent's door (OD-7): refused BEFORE the script runs.
  for (const door of [undefined, 'session', 'supervisor', 'console'] as const) {
    const scripted = await svc.approveGate('press', 1, { approve: true, by: 'operator', note: 'looks fine', ...(door ? { door } : {}) });
    assert.equal(scripted.ok, false, String(door));
    assert.match(scripted.detail, /manual — a person's to clear/);
    assert.match(scripted.detail, /Gate card/);
  }
  assert.ok(!existsSync(lib.file), 'nothing was written for a press that was not a person\'s');
  assert.equal((await svc.gateStatus('press', 1))?.clear, false);

  // A person's door, but naming an automatic approver: the script refuses it.
  const named = await svc.approveGate('press', 1, { approve: true, by: 'ai-session-delegated', door: 'device' });
  assert.equal(named.ok, false);
  assert.equal((await svc.gateStatus('press', 1))?.clear, false);

  // The Gate card from this machine: written through the console's door, clear — and, with no owner key, said so.
  const pressed = await svc.approveGate('press', 1, { approve: true, by: 'mobin', note: 'approved the four rows', door: 'local' });
  assert.equal(pressed.ok, true, pressed.detail);
  assert.equal(pressed.gate?.clear, true);
  assert.match(pressed.detail, /through the local door: this console has no owner key yet/);
  assert.match(readFileSync(lib.file, 'utf8'), /^\| 1 \| yes \| mobin \| \d{4}-\d{2}-\d{2} \| approved the four rows \| console \|$/m);

  // An AI gate is approvable without a person's press, as it always was.
  const ai = await svc.approveGate('press', 2, { approve: true, by: 'phase-2-session' });
  assert.equal(ai.ok, true, ai.detail);
  // …and a revoke needs no person: closing a gate is nobody's privilege.
  const revoked = await svc.approveGate('press', 1, { approve: false, by: 'script' });
  assert.equal(revoked.ok, true, revoked.detail);
  assert.equal((await svc.gateStatus('press', 1))?.clear, false);
});

test('MG-2: the console\'s door is stated, never inherited — a person\'s press clears every session marker', () => {
  const pressed = planWrite({ action: 'gate-approve', slug: 'demo', phase: 1, by: 'mobin', door: 'console' }, { root: '/x' });
  assert.deepEqual(pressed.env, { PE_GATE_DOOR: 'console', PE_OWNER: '', PE_OUTCOME_FILE: '', PE_SESSION_KIND: '', CLAUDECODE: '' });
  const other = planWrite({ action: 'gate-approve', slug: 'demo', phase: 1, by: 'mobin' }, { root: '/x' });
  assert.deepEqual(other.env, { PE_GATE_DOOR: '' }, 'no door claimed, and none inherited from the console\'s own shell');
});

/** A stub service that reads doors as the real one does: a run token is `r1`'s session. */
async function doorStub(seen: Array<Record<string, unknown>>, approveGate: (opts: Record<string, unknown>) => unknown) {
  const { doorOfRequest } = await import('../server/owner/door.ts');
  const stubFlags = { allowWrites: true, allowRun: false, remoteHosts: [] as string[], remoteUsers: [] as string[], scriptsDir: SCRIPTS };
  return {
    root: { ok: true, path: '/tmp/nowhere' },
    store: {},
    flags: stubFlags,
    doorOf: (req: { headers: Record<string, string> }) => doorOfRequest(req, {
      flags: stubFlags, runToken: (h) => (h === 'Bearer run-token' ? 'r1' : null),
    }),
    manifestNamesPress: () => false,
    noteDoorRefused: () => {},
    approveGate: async (_slug: string, _phase: number, opts: Record<string, unknown>) => {
      seen.push(opts);
      return approveGate(opts);
    },
    invalidateAll: () => {},
  };
}

test('OD-7: the gate route hands approveGate the request\'s DOOR — never its User-Agent; a session\'s token never reaches it', async () => {
  const { handleApi } = await import('../server/api/routes.ts');
  const seen: Array<Record<string, unknown>> = [];
  const service = await doorStub(seen, () => ({ ok: true, gate: { clear: true, kind: 'clear', detail: 'approved' }, detail: 'ok' }));
  const post = async (headers: Record<string, string>) => {
    let status = 0;
    const payload = JSON.stringify({ approve: true, by: 'mobin', continueRun: false });
    const req = {
      method: 'POST',
      headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
      on() { return this; },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
    };
    const res = { req, writeHead(code: number) { status = code; return this; }, end() {}, on() { return this; } };
    await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/api/plans/demo/gate/1'));
    return status;
  };
  await post({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15' });
  await post({ 'user-agent': 'curl/8.7.1' });
  await post({ 'user-agent': 'node' });
  assert.deepEqual(seen.map((s) => s.door), ['local', 'local', 'local'],
    'a browser, curl and node are one door on this machine — the person test reads the door, not the User-Agent');
  assert.ok(seen.every((s) => s.by === 'mobin'), 'the offered name rides along — it is never the witness');
  // A session's run token, whatever User-Agent it wears, is refused at the door: approveGate is never asked.
  assert.equal(await post({ 'user-agent': 'Mozilla/5.0 (Macintosh)', authorization: 'Bearer run-token' }), 403);
  assert.equal(seen.length, 3, 'nothing reached the gate');
});

/* ------------------------------------------------------------------ *
 * MG-4 — /api/write takes no door from its body (control-tower phase 129, #218)
 * ------------------------------------------------------------------ */

/** A POST to the real router, as a client with this User-Agent (and these headers) sends it. */
async function postWrite(service: unknown, userAgent: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { handleApi } = await import('../server/api/routes.ts');
  let status = 0;
  let text = '';
  const payload = JSON.stringify(body);
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': userAgent, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { text += chunk ?? ''; },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/api/write'));
  return { status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15';

test('MG-4: /api/write asks the gate route\'s own person test — the door in its body is never read', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const service = await doorStub(seen, () => ({ ok: false, gate: null, detail: 'refused by the stub' }));
  const forged = { action: 'gate-approve', slug: 'demo', phase: 1, by: 'mobin', door: 'console' };
  await postWrite(service, 'curl/8.7.1', forged);
  await postWrite(service, 'node', forged);
  await postWrite(service, BROWSER, forged);
  await postWrite(service, BROWSER, { ...forged, revoke: true });
  assert.deepEqual(seen.map((s) => s.door), ['local', 'local', 'local', 'local'],
    'the request\'s door — whatever door the body claims (OD-7)');
  assert.deepEqual(seen.map((s) => s.approve), [true, true, true, false]);
  assert.ok(seen.every((s) => s.by === 'mobin'), 'the offered name rides along — it is never the witness');
  const refused = await postWrite(service, BROWSER, forged, { authorization: 'Bearer run-token' });
  assert.equal(refused.status, 403, 'a session\'s token is refused at the door, its User-Agent notwithstanding');
  assert.equal(refused.body.door, 'session');
  assert.equal(seen.length, 4, 'and the gate was never asked');
});

test('MG-4 / OD-7: a manual gate through /api/write — a session\'s token is refused, `door: console` in a body is nothing, a local press opens it and says why', async (t) => {
  const lib = library('write-door');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);
  const token = svc.approvals.arm('r-write');

  const forged = await postWrite(svc, 'curl/8.7.1', { action: 'gate-approve', slug: 'write-door', phase: 1, by: 'mobin', door: 'console' },
    { authorization: `Bearer ${token}` });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.door, 'session');
  assert.ok(!existsSync(lib.file), 'nothing was written');
  assert.equal((await svc.gateStatus('write-door', 1))?.clear, false);

  // With no owner key a press from this machine is a person's — curl or a browser alike — and the answer says so.
  const pressed = await postWrite(svc, 'curl/8.7.1', { action: 'gate-approve', slug: 'write-door', phase: 1, by: 'mobin' });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  assert.match(String(pressed.body.detail), /through the local door: this console has no owner key yet/);
  assert.match(readFileSync(lib.file, 'utf8'), /^\| 1 \| yes \| mobin \| \d{4}-\d{2}-\d{2} \| - \| console \|$/m, 'written through the console\'s door');
  assert.equal((await svc.gateStatus('write-door', 1))?.clear, true);
});

/* ------------------------------------------------------------------ *
 * MG-3 — ignored when read
 * ------------------------------------------------------------------ */

test('MG-3: --gate-status ignores a manual row no person\'s door wrote — the By text is never the witness', async (t) => {
  const lib = library('rows');
  t.after(lib.cleanup);
  const svc = service(t, lib.root);
  // The engine's answer is cached by the plan's revision, and a hand-written
  // row moves no watcher here: every read below re-reads the plan first, so
  // each verdict is the engine's on THAT row and not the one before it.
  const status = async (phase: number) => {
    (svc as unknown as { reread(slug: string): void }).reread('rows');
    return svc.gateStatus('rows', phase);
  };

  // The legacy five-column row #174's session wrote.
  handRows(lib.file, ['| 1 | yes | ai-session-delegated | 2026-09-29 | the owner granted all permissions |'], false);
  let gate = await status(1);
  assert.equal(gate?.clear, false);
  assert.equal(gate?.kind, 'manual', 'still a person\'s gate on every surface that reads the verdict word');
  assert.match(gate?.detail ?? '', /the owner approves the content change/);
  assert.match(gate?.detail ?? '', /does not clear a manual gate/);

  // A door-less row naming a person is no better; a session's or a script's door neither.
  for (const row of [
    '| 1 | yes | mobin | 2026-09-29 | - |',
  ]) {
    handRows(lib.file, [row], false);
    gate = await status(1);
    assert.equal(gate?.clear, false, row);
  }
  for (const door of ['session', 'script', 'ai']) {
    handRows(lib.file, [`| 1 | yes | mobin | 2026-09-29 | - | ${door} |`], true);
    gate = await status(1);
    assert.equal(gate?.clear, false, door);
    assert.match(gate?.detail ?? '', new RegExp(`the ${door} door`));
  }
  // A person's door is the one that opens it.
  for (const door of ['console', 'terminal']) {
    handRows(lib.file, [`| 1 | yes | mobin | 2026-09-29 | - | ${door} |`], true);
    gate = await status(1);
    assert.equal(gate?.clear, true, door);
    assert.match(gate?.detail ?? '', /approved by mobin on 2026-09-29/);
  }
  // An AI gate's legacy row still clears it: only a manual gate asks for a person's door.
  handRows(lib.file, ['| 2 | yes | ai-session | 2026-09-29 | - |'], false);
  assert.equal((await status(2))?.clear, true);
});


test('MG-2: a session cannot borrow a person\'s door through its own tools — setting PE_GATE_DOOR, or writing gate-status.md, is walled at the hook', async () => {
  const svc = new Service(flags as never);
  const noted: { event: string; data: Record<string, unknown> }[] = [];
  const state = { id: 'r1', slug: 'gated', activePhase: 6, permissionProfile: 'bypass' };
  (svc as unknown as { runners: Map<string, unknown> }).runners.set('gated', {
    isSpending: () => false, busy: () => true, current: () => state,
    note: (event: string, data: Record<string, unknown>) => noted.push({ event, data }),
    park: () => {}, enterPersonWait: () => {}, leavePersonWait: () => {},
  });
  const decide = async (tool_name: string, tool_input: Record<string, unknown>) => (await svc.decideToolUse({ tool_name, tool_input }, 'r1') as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  }).hookSpecificOutput;
  try {
    // Even on the bypass profile, where nothing else is asked about.
    for (const command of [
      `PE_GATE_DOOR=console PE_OWNER= CLAUDECODE= bash ${SCRIPTS}/gate-approve.sh gated 6 --by operator`,
      `env -u CLAUDECODE PE_GATE_DOOR=console bash ${SCRIPTS}/gate-approve.sh gated 6 --by operator`,
      `export PE_GATE_DOOR=console; bash ${SCRIPTS}/gate-approve.sh gated 6 --by operator`,
      'PE_GATE_DOOR=console',
    ]) {
      const answer = await decide('Bash', { command });
      assert.equal(answer.permissionDecision, 'deny', command);
      assert.match(answer.permissionDecisionReason, /rule: gate-forge/);
      assert.match(answer.permissionDecisionReason, /needs-human --needs gates/, 'and it says what to do instead');
    }
    for (const [tool, input] of [
      ['Write', { file_path: '/repo/docs/handoffs/gated/gate-status.md', content: '| 6 | yes | operator | 2026-10-04 | - | terminal |\n' }],
      ['Edit', { file_path: 'docs/handoffs/gated/gate-status.md', old_string: 'a', new_string: 'b' }],
    ] as [string, Record<string, unknown>][]) {
      assert.equal((await decide(tool, input)).permissionDecision, 'deny', `${tool} of the gate file`);
    }
    assert.equal(noted.filter((n) => n.event === 'phase.tool-denied' && n.data.rule === 'gate-forge').length, 6, 'each journalled');
    // Data is not a door: a search for the name, a fixture of the same name, the gate read back.
    for (const [tool, input] of [
      ['Bash', { command: 'grep -rn "PE_GATE_DOOR=console" scripts/ viewer/server/writes.ts' }],
      ['Bash', { command: `bash ${SCRIPTS}/phase-graph.sh gated --gate-status 6` }],
      ['Write', { file_path: '/repo/tests/fixtures/plans/gate-status.md', content: 'x' }],
    ] as [string, Record<string, unknown>][]) {
      assert.equal((await decide(tool, input)).permissionDecision, 'allow', JSON.stringify(input));
    }
  } finally {
    svc.approvals.disarm();
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * EC6 (control-tower phase 148, #208) — with an owner key, a manual gate
 * is the owner's or a device's; a local press of it is a request
 * ------------------------------------------------------------------ */

test('EC6: on an enrolled console a manual gate needs the owner or a device — a local press becomes a request, never applied', async () => {
  const { Browser, REMOTE_HOST, call, enrolFirst, freshOwnerState, newService } = await import('./owner-harness.ts');
  const { SoftAuthenticator } = await import('./webauthn-authenticator.ts');
  const { isPersonDoor } = await import('../shared/door-model.js');
  const { ownerDoorMode } = await import('../server/owner/door.ts');
  const state = freshOwnerState();
  const service = newService();
  (service.flags as { remoteUsers: string[] }).remoteUsers = ['owner@example.com'];
  const seen: string[] = [];
  // A project open — the gate route answers nothing without one.
  (service as unknown as Record<string, unknown>).root = { ok: true, path: '/tmp/nowhere' };
  (service as unknown as Record<string, unknown>).store = { get: () => undefined, all: () => [], list: () => [] };
  (service as unknown as { approveGate: (slug: string, phase: number, opts: { door?: string }) => unknown }).approveGate = async (_slug, _phase, opts) => {
    seen.push(String(opts?.door));
    return { ok: true, gate: { clear: true, kind: 'clear', detail: 'approved' }, detail: 'ok' };
  };
  try {
    // Before a key: a local press is a person's, as it always was.
    const before = await call(service, 'POST', '/api/plans/demo/gate/1', { body: { approve: true } });
    assert.equal(before.status, 200, JSON.stringify(before.answer));
    assert.deepEqual(seen, ['local']);
    const owner = new Browser(service);
    await enrolFirst(service, owner, new SoftAuthenticator('ES256'));
    assert.equal(ownerDoorMode(), 'enrolled');
    assert.equal(isPersonDoor('local', 'enrolled'), false, 'with a key, a press from this machine is not a person\'s by itself');
    const local = await call(service, 'POST', '/api/plans/demo/gate/1', { body: { approve: true } });
    assert.equal(local.status, 202);
    assert.deepEqual((local.answer.request as { item: unknown }).item, { kind: 'gate', slug: 'demo', phase: 1 });
    const viaWrite = await call(service, 'POST', '/api/write', { body: { action: 'gate-approve', slug: 'demo', phase: 1 } });
    assert.equal(viaWrite.status, 202, 'the console door\'s gate action asks the same');
    assert.deepEqual(seen, ['local'], 'neither press reached the gate');
    // A paired device and the owner press it.
    const device = await call(service, 'POST', '/api/plans/demo/gate/1', { host: REMOTE_HOST, headers: { 'tailscale-user-login': 'owner@example.com' }, body: { approve: true } });
    assert.equal(device.status, 200, JSON.stringify(device.answer));
    assert.equal((await owner.call('POST', '/api/plans/demo/gate/1', { approve: true })).status, 200);
    assert.deepEqual(seen, ['local', 'device', 'owner']);
    // The request stands until the owner answers it — confirmed, it reaches the gate through the owner's door.
    const id = (local.answer.request as { id: string }).id;
    assert.equal((await owner.call('POST', `/api/owner/requests/${id}/confirm`)).status, 200);
    assert.deepEqual(seen, ['local', 'device', 'owner', 'owner']);
    assert.equal(state.requests.get(id)?.state, 'confirmed');
  } finally {
    service.close();
  }
});
