/**
 * OD-1..4, OD-8 (control-tower phase 131, #208) — the owner door: who pressed
 * is known.
 *
 * Measured on the hub: twelve of fifteen approval cards answered `by: script`
 * by the run's own supervising agent, a phone the fleet supervisor had verified
 * journalled `operator · local`, and the supervisor's decision log handed to
 * every later session as "standing decisions a person recorded". The door is
 * now read off what a request can PROVE:
 *
 * OD-1  Every request has ONE door from `PRESS_DOORS`: a session's run or
 *       message token → `session`; a live chat's bearer → `supervisor`; a
 *       login the fleet or the proxy verified → `device`; anything else →
 *       `local`. An agent's proof outranks everything else it carries.
 * OD-2  `by` in a body is a label and never changes the door: a script that
 *       says `by: operator` is recorded `local`, with its label.
 * OD-3  `DOOR_MAY` and `doorMay`: the door × authority verb × risk table, held
 *       whole in both modes.
 * OD-4  On a console with no owner key, `/api/state` says `ownerDoor:
 *       'unenrolled'`, `local` presses what it could before, and a request
 *       that proves it is a session's or the supervisor's presses no authority
 *       route beyond what the plan's manifest already allows.
 * OD-8  A note the supervisor pinned reaches a later boarding prompt under its
 *       own header — its reading, not a person's decision; a person's pinned
 *       note keeps the operator's.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { handleApi } from '../server/api/routes.ts';
import { actorOfRequest } from '../server/api/actor.ts';
import { isAgentDoor, isPersonsAct, pressDoorOf } from '../server/actor.ts';
import { authorityRefusal, doorOfRequest, ownerDoorMode, stampDoor, stampedDoor } from '../server/owner/door.ts';
import { pinnedNotesBlock } from '../server/runner/runner-core.ts';
import {
  AGENT_DOORS, AUTHORITY_ROUTES, AUTHORITY_VERBS, DOOR_MAY, DOOR_VERDICTS, OWNER_DOOR_MODES, PRESS_DOORS,
  doorMay, isPersonDoor,
} from '../shared/door-model.js';
import { RISK_TIERS } from '../shared/turn-model.js';

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
  scriptsDir: `${SKILL_DIR}/scripts`, logFile: null, remoteHosts: [] as string[], remoteUsers: [] as string[],
};

/** A request as `handleApi` and the access layer read one. */
function fakeReq(method: string, path: string, headers: Record<string, string | string[]> = {}, body: unknown = {}) {
  return {
    method,
    url: path,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body), 'utf8'); },
  };
}

/** One request through the real router; the status and the parsed answer. */
async function call(service: Service, method: string, path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  let status = 0;
  let raw = '';
  const req = fakeReq(method, path, headers, body);
  const res = {
    req,
    writeHead(code: number) { status = code; return this; },
    setHeader() {},
    end(chunk?: string | Buffer) { raw += chunk ? chunk.toString() : ''; },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4130${path}`));
  let answer: Record<string, unknown> = {};
  try { answer = JSON.parse(raw) as Record<string, unknown>; } catch { answer = { raw }; }
  return { status, answer };
}

/** A service driving one run (`r1`, plan `demo`, phase 2) — `console-forge.test.ts`'s shape. */
function serviceWithRun(extra: Record<string, unknown> = {}) {
  const service = new Service(flags as never);
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: 'trusted', phases: {}, ...extra }),
    note: () => {},
    noteWaitDenied: () => {},
    park: () => {},
    isSpending: () => false,
  });
  return { service, close: () => { service.approvals.disarm(); service.close(); } };
}

/** A path for a row, its `:names` filled. */
const fill = (path: string) => path.replace(/:([a-z]+)/g, (_, name: string) => (name === 'phase' ? '3' : 'demo'));

/* ------------------------------------------------------------------ *
 * OD-1 — one door per request, from what it proves
 * ------------------------------------------------------------------ */

test('OD-1: a loopback request with the header and nothing more is `local` — a script, the CLI and a browser alike', () => {
  for (const ua of ['curl/8.7.1', 'phase-console/6.1.0', 'Mozilla/5.0 (Macintosh)', '']) {
    const reading = doorOfRequest(fakeReq('POST', '/api/policy', ua ? { 'user-agent': ua } : {}), { flags });
    assert.deepEqual(reading, { door: 'local', label: null, proof: 'transport' }, ua || 'no User-Agent');
  }
});

test('OD-1: a session\'s run token, its message token and a chat\'s bearer are proved, and outrank the rest of the request', () => {
  const deps = {
    flags,
    runToken: (h: string | undefined) => (h === 'Bearer run-t' ? 'r1' : null),
    messageToken: (h: string | undefined) => (h === 'Bearer msg-t' ? 'r2' : null),
    chatBearer: (h: string | undefined) => (h === 'Bearer chat-t' ? 'c1' : null),
  };
  assert.deepEqual(doorOfRequest(fakeReq('POST', '/x', { authorization: 'Bearer run-t' }), deps),
    { door: 'session', label: 'r1', proof: 'run-token' });
  assert.deepEqual(doorOfRequest(fakeReq('POST', '/x', { authorization: 'Bearer msg-t' }), deps),
    { door: 'session', label: 'r2', proof: 'message-token' });
  assert.deepEqual(doorOfRequest(fakeReq('POST', '/x', { authorization: 'Bearer chat-t' }), deps),
    { door: 'supervisor', label: 'c1', proof: 'chat-bearer' });
  assert.equal(doorOfRequest(fakeReq('POST', '/x', { authorization: 'Bearer nobody' }), deps).door, 'local',
    'a bearer nothing minted proves nothing');
  assert.equal(doorOfRequest(fakeReq('POST', '/x', { authorization: 'Bearer run-t', 'user-agent': 'Mozilla/5.0' }), deps).door,
    'session', 'a session cannot pass for a browser by its User-Agent');
});

test('OD-1: a login the --remote proxy verified is a `device`, named by its login', () => {
  const remote = { ...flags, remoteHosts: ['console.tail.ts.net'], remoteUsers: ['mobin@example.com'] };
  const proxied = fakeReq('POST', '/api/approvals/a1', { host: 'console.tail.ts.net', 'tailscale-user-login': 'mobin@example.com' });
  assert.deepEqual(doorOfRequest(proxied, { flags: remote }), { door: 'device', label: 'mobin@example.com', proof: 'remote-login' });
  const stranger = fakeReq('POST', '/api/approvals/a1', { host: 'console.tail.ts.net', 'tailscale-user-login': 'eve@example.com' });
  assert.equal(doorOfRequest(stranger, { flags: remote }).door, 'local', 'a login the console would refuse is no device');
});


test('OD-1: an in-process actor\'s door is read off its transport; a stamped door is the request\'s', () => {
  assert.equal(pressDoorOf({ via: 'supervisor' }), 'supervisor');
  assert.equal(pressDoorOf({ via: 'hook' }), 'session');
  for (const via of ['timer', 'boot', 'event'] as const) assert.equal(pressDoorOf({ via }), 'console', via);
  assert.equal(pressDoorOf({ via: 'signal' }), 'local');
  assert.equal(pressDoorOf({ via: 'api', pressDoor: 'device' }), 'device', 'a stamped door wins');
  assert.equal(pressDoorOf(null), 'local');
  const req = fakeReq('POST', '/api/policy');
  assert.equal(stampedDoor(req), null);
  stampDoor(req, { door: 'session', label: 'r1', proof: 'run-token' });
  assert.equal(actorOfRequest(req, flags, { by: 'operator' }).pressDoor, 'session', 'the router\'s stamp is what the actor carries');
  assert.deepEqual([...AGENT_DOORS], ['session', 'supervisor']);
  assert.ok(isAgentDoor('session') && isAgentDoor('supervisor') && !isAgentDoor('local') && !isAgentDoor('device'));
});

/* ------------------------------------------------------------------ *
 * OD-2 — `by` is a label
 * ------------------------------------------------------------------ */

test('OD-2: a script that says `by: operator` is recorded `local` with its label — never a person by its own say-so', async () => {
  const actor = actorOfRequest(fakeReq('POST', '/api/approvals/a1', { 'user-agent': 'curl/8.7.1' }), flags, { by: 'operator' });
  assert.equal(actor.by, 'operator', 'the label is kept, as offered');
  assert.equal(actor.pressDoor, 'local', 'and the door is the transport\'s');
  assert.equal(actorOfRequest(fakeReq('POST', '/x', { 'user-agent': 'btw' }), flags, {}).via, 'cli', 'btw names itself');

  // Through the real router: what the approvals route hands the service is what the card's answer journals.
  const { service, close } = serviceWithRun();
  try {
    let seen: Record<string, unknown> | null = null;
    (service as unknown as { root: unknown; store: unknown }).root = { ok: true, path: tmpdir() };
    (service as unknown as { store: unknown }).store = { get: () => undefined, all: () => [] };
    (service as unknown as { decideApproval: (...a: unknown[]) => unknown }).decideApproval = (...args: unknown[]) => {
      seen = args[5] as Record<string, unknown>;
      return { ok: true, decision: 'deny' };
    };
    const { status, answer } = await call(service, 'POST', '/api/approvals/a1', { 'user-agent': 'python-requests/2.32' }, { decision: 'deny', by: 'operator' });
    assert.equal(status, 200, JSON.stringify(answer));
    assert.equal(seen!.by, 'operator');
    assert.equal(seen!.pressDoor, 'local');
    assert.equal(isPersonsAct(seen as never), true, 'an unenrolled console still takes a local press as a person\'s');
    assert.equal(isPersonsAct({ by: 'operator', via: 'api', origin: 'local', remoteUser: null, pressDoor: 'session' }), false,
      'an agent\'s door is never a person\'s act, whatever its label');
  } finally {
    close();
  }
});

/* ------------------------------------------------------------------ *
 * OD-3 — the door × verb × risk table
 * ------------------------------------------------------------------ */

/** The table as §Architecture 19 states it, restated here so the shipped one is held to the words. */
function written(door: string, verb: string, risk: string, mode: string, manifest: boolean): string {
  if (risk === 'never') return 'refuse';
  // An override writes a verdict, and no manifest carries one out (phase 134);
  // nor does any manifest hand out the owner keys (phase 148), or a grant —
  // a person's decision by definition (phase 149).
  if (manifest && door !== 'checker' && door !== 'console' && verb !== 'override' && verb !== 'owner-key' && verb !== 'grant') return 'press';
  if (door === 'owner') return 'press';
  if (door === 'device') {
    if (verb === 'decline') return 'press';
    if (['grant', 'answer', 'gate-approve', 'plan-approve'].includes(verb) && risk !== 'high') return 'press';
  }
  if (door === 'local' && verb === 'decline') return 'press';
  if (mode === 'unenrolled') return door === 'local' || door === 'device' ? 'press' : 'refuse';
  // With a key, every door a request comes through ASKS the owner (phase 148, EC4) — a session's token too.
  return door === 'local' || door === 'device' || door === 'supervisor' || door === 'session' ? 'request' : 'refuse';
}

test('OD-3: every door × authority verb × risk × mode × manifest reads as §Architecture 19 writes it', () => {
  assert.deepEqual([...PRESS_DOORS], ['owner', 'device', 'local', 'session', 'supervisor', 'checker', 'console']);
  assert.deepEqual([...OWNER_DOOR_MODES], ['unenrolled', 'enrolled']);
  assert.deepEqual([...DOOR_VERDICTS], ['press', 'request', 'refuse']);
  assert.equal(AUTHORITY_VERBS.length, 12);
  assert.deepEqual(Object.keys(DOOR_MAY), [...PRESS_DOORS], 'one row per door');
  for (const [door, row] of Object.entries(DOOR_MAY)) {
    for (const [verb, tier] of Object.entries(row)) {
      assert.ok((AUTHORITY_VERBS as readonly string[]).includes(verb), `${door}: ${verb} is no authority verb`);
      assert.ok((RISK_TIERS as readonly string[]).includes(tier as string) && tier !== 'never', `${door}.${verb}: ${tier}`);
    }
  }
  let cells = 0;
  for (const door of PRESS_DOORS) {
    for (const verb of AUTHORITY_VERBS) {
      for (const risk of RISK_TIERS) {
        for (const mode of OWNER_DOOR_MODES) {
          for (const manifest of [false, true]) {
            assert.equal(doorMay(door, verb, { risk, mode, manifest }), written(door, verb, risk, mode, manifest),
              `${door} × ${verb} × ${risk} × ${mode}${manifest ? ' × manifest' : ''}`);
            cells += 1;
          }
        }
      }
    }
  }
  assert.equal(cells, 7 * 12 * 4 * 2 * 2);
});

test('OD-3: the rows a person reads — and the words the table does not know', () => {
  assert.equal(doorMay('owner', 'profile-raise', { risk: 'high', mode: 'enrolled' }), 'press');
  assert.equal(doorMay('device', 'grant', { risk: 'medium', mode: 'enrolled' }), 'press', 'a phone grants low and medium');
  assert.equal(doorMay('device', 'grant', { risk: 'high', mode: 'enrolled' }), 'request', 'and only asks for high');
  assert.equal(doorMay('device', 'capability', { mode: 'enrolled' }), 'request', 'a capability is never a device\'s');
  assert.equal(doorMay('local', 'policy-widen', { mode: 'unenrolled' }), 'press', 'unenrolled: local presses what it could before');
  assert.equal(doorMay('local', 'policy-widen', { mode: 'enrolled' }), 'request');
  assert.equal(doorMay('session', 'answer'), 'refuse', 'a session never answers its own card');
  assert.equal(doorMay('session', 'answer', { manifest: true }), 'press', 'unless the manifest already allows it');
  assert.equal(doorMay('supervisor', 'gate-approve'), 'refuse');
  assert.equal(doorMay('supervisor', 'gate-approve', { mode: 'enrolled' }), 'request');
  assert.equal(doorMay('console', 'answer', { manifest: true }), 'refuse', 'the console\'s clocks carry out nobody\'s decision');
  assert.equal(doorMay('owner', 'grant', { risk: 'never' }), 'refuse', 'never is no door\'s, the owner\'s included');
  assert.equal(doorMay('nobody', 'answer'), 'refuse');
  assert.equal(doorMay('owner', 'reboot'), 'refuse');
  assert.equal(doorMay('owner', 'answer', { risk: 'enormous' }), 'refuse');

  // The manual gate's person test, a door: owner and device always; local only with no key.
  assert.equal(isPersonDoor('owner'), true);
  assert.equal(isPersonDoor('device', 'enrolled'), true);
  assert.equal(isPersonDoor('local', 'unenrolled'), true);
  assert.equal(isPersonDoor('local', 'enrolled'), false);
  for (const door of ['session', 'supervisor', 'checker', 'console', undefined, null]) assert.equal(isPersonDoor(door), false, String(door));
});

/* ------------------------------------------------------------------ *
 * OD-4 — an unenrolled console, and an agent's door on an authority route
 * ------------------------------------------------------------------ */

test('OD-4: a console with no owner key says so — `ownerDoor: unenrolled` on /api/state', async () => {
  assert.equal(ownerDoorMode(), 'unenrolled');
  const service = new Service(flags as never);
  try {
    assert.equal((service.state() as { ownerDoor?: string }).ownerDoor, 'unenrolled');
    const { status, answer } = await call(service, 'GET', '/api/state');
    assert.equal(status, 200);
    assert.equal(answer.ownerDoor, 'unenrolled');
  } finally {
    service.close();
  }
});

test('OD-4: a request carrying a session\'s run token presses no authority route — every row refused at the door, named', async () => {
  const { service, close } = serviceWithRun();
  try {
    const token = service.approvals.arm('r1');
    for (const row of AUTHORITY_ROUTES) {
      const { status, answer } = await call(service, row.method, fill(row.path), { authorization: `Bearer ${token}` });
      assert.equal(status, 403, `${row.verb}: ${JSON.stringify(answer)}`);
      assert.equal(answer.door, 'session', row.verb);
      assert.equal(answer.press, row.verb);
      assert.equal(answer.authority, row.authority);
      assert.match(String(answer.error), new RegExp(`--needs ${row.declare.needs}`), `${row.verb}: it names the declaration`);
    }
    // The same presses with no proof are the transport's `local` — past the door, whatever the route does next.
    for (const row of AUTHORITY_ROUTES) {
      const { status, answer } = await call(service, row.method, fill(row.path));
      assert.ok(!(status === 403 && answer.door), `${row.verb}: a local press is not the door's to refuse — ${status} ${JSON.stringify(answer)}`);
    }
    // A read is no press, token or not.
    assert.notEqual((await call(service, 'GET', '/api/policy', { authorization: `Bearer ${token}` })).status, 403);
  } finally {
    close();
  }
});

test('OD-4 (phase 133): the owner\'s moves — a session\'s door may not answer, decline, ask or attach; a local press gets past the door', async () => {
  const { service, close } = serviceWithRun();
  try {
    const token = service.approvals.arm('r1');
    for (const [verb, body] of [
      ['answer', { option: 'o1' }], ['decline', { reason: 'no' }], ['ask', { text: 'why?' }], ['evidence', { kind: 'note', text: 'it worked' }],
    ] as const) {
      const viaSession = await call(service, 'POST', `/api/human-steps/s-1/${verb}`, { authorization: `Bearer ${token}` }, body);
      assert.equal(viaSession.status, 403, `${verb}: ${JSON.stringify(viaSession.answer)}`);
      assert.equal(viaSession.answer.door, 'session', verb);
      const viaLocal = await call(service, 'POST', `/api/human-steps/s-1/${verb}`, {}, body);
      assert.notEqual(viaLocal.status, 403, `${verb}: a local press is past the door — ${JSON.stringify(viaLocal.answer)}`);
    }
    // An answer and a decline carry authority; a question and evidence do not, and the table says so.
    const rows = AUTHORITY_ROUTES.filter((row) => row.path.startsWith('/api/human-steps/:id/'));
    assert.deepEqual(rows.map((row) => `${row.path.split('/').pop()}:${row.authority}`).sort(),
      ['answer:answer', 'check:attest', 'convert:decline', 'decline:decline', 'deny:decline', 'dismiss:decline', 'grant:grant', 'override:override',
        'rewrite:decline']);
    assert.equal(doorMay('device', 'answer'), 'press', 'a paired device answers');
    assert.equal(doorMay('session', 'answer'), 'refuse');
    assert.equal(doorMay('supervisor', 'decline', { mode: 'enrolled' }), 'request', 'the supervisor may only ask the owner');
    assert.equal(doorMay('checker', 'answer'), 'refuse', 'nor the checker');
  } finally {
    close();
  }
});

test('OD-4: what the plan\'s manifest already allows passes an agent\'s door — by CLI form or Console(<press>), for a live phase only', async () => {
  const manifest = (value: string) => ({
    manifest: { decisions: [{ key: 'permission.destructive', state: 'answered', value, source: 'plan' }] },
  });
  const pressWith = async (extra: Record<string, unknown>, method: string, path: string) => {
    const { service, close } = serviceWithRun(extra);
    try {
      const token = service.approvals.arm('r1');
      const { status, answer } = await call(service, method, path, { authorization: `Bearer ${token}` });
      return status === 403 && answer.door ? 'refused' : 'passed';
    } finally {
      close();
    }
  };
  assert.equal(await pressWith(manifest('deny; allow `Console(edit-policy)` — phase 2 only'), 'POST', '/api/policy'), 'passed');
  assert.equal(await pressWith(manifest('deny; allow `Console(edit-policy)` — phase 3 only'), 'POST', '/api/policy'), 'refused',
    'named for a phase that is not live');
  assert.equal(await pressWith(manifest('deny; allow `phase-console run approve` — phase 2 only'), 'POST', '/api/approvals/a1'), 'passed',
    'a CLI form names the route it presses, as the hook guard reads it');
  assert.equal(await pressWith(manifest('deny; allow `Console(edit-policy)` — phase 2 only'), 'POST', '/api/run/demo/settings'), 'refused',
    'one named press opens no other');
  assert.equal(await pressWith(manifest('deny; allow `Bash(git push:*)` — every phase'), 'POST', '/api/policy'), 'refused',
    'a row that names no console press opens none');
  assert.equal(await pressWith({ ...manifest('deny; allow `Console(edit-policy)` — phase 3 only'), activePhase: null, phases: { 3: { phase: 3, status: 'running' } } }, 'POST', '/api/policy'),
    'passed', 'a lane that is running is a live phase too');
});

test('OD-4: the refusal says who proved what, and what to declare instead', () => {
  const row = AUTHORITY_ROUTES.find((r) => r.verb === 'approve-gate')!;
  const session = authorityRefusal({ door: 'session', label: 'r1', proof: 'run-token' }, row);
  assert.match(session!, /a session's run token/);
  assert.match(session!, /approve-gate: gate-approve/);
  assert.match(session!, /needs-human --needs gates/);
  const chat = authorityRefusal({ door: 'supervisor', label: 'c1', proof: 'chat-bearer' }, row);
  assert.match(chat!, /the supervisor's bearer/);
  assert.match(chat!, /Ask the operator to press it/);
  assert.equal(authorityRefusal({ door: 'local', label: null, proof: 'transport' }, row), null, 'unenrolled: local presses as before');
  assert.equal(authorityRefusal({ door: 'session', label: 'r1', proof: 'run-token' }, row, { manifest: true }), null);
});


/* ------------------------------------------------------------------ *
 * OD-8 — the supervisor's notes under their own header
 * ------------------------------------------------------------------ */

test('OD-8: a note the supervisor pinned reaches a session under its own header; a person\'s keeps the operator\'s', () => {
  const at = '2026-10-06T16:08:00.000Z';
  const notes = [
    { id: 'aaaaaaaaaaaa', at, by: 'mobin', door: 'local' as const, text: 'keep this run on admin@', pinned: true },
    { id: 'bbbbbbbbbbbb', at, by: 'supervisor', door: 'supervisor' as const, text: 'pressed resume for halted-with-ready-work', pinned: true },
    // A note written before the door was recorded: the supervisor signed it by name.
    { id: 'cccccccccccc', at, by: 'supervisor', text: 'pressed switch-account for hot-account', pinned: true },
  ];
  const block = pinnedNotesBlock(notes, 2);
  const operator = block.indexOf('OPERATOR NOTES PINNED ON THIS RUN');
  const supervisor = block.indexOf('SUPERVISOR NOTES PINNED ON THIS RUN');
  assert.ok(operator >= 0 && supervisor > operator, block);
  const operatorPart = block.slice(operator, supervisor);
  const supervisorPart = block.slice(supervisor);
  assert.match(operatorPart, /keep this run on admin@/);
  assert.doesNotMatch(operatorPart, /pressed resume|pressed switch-account/, 'no supervisor line is a person\'s decision');
  assert.match(supervisorPart, /pressed resume for halted-with-ready-work/);
  assert.match(supervisorPart, /pressed switch-account for hot-account/);
  assert.match(supervisorPart, /not a decision a person made/);
  assert.doesNotMatch(supervisorPart, /outranks the plan/, 'the supervisor\'s reading never outranks the plan');

  assert.doesNotMatch(pinnedNotesBlock([notes[1]!], 2), /OPERATOR NOTES/, 'only the supervisor pinned anything');
  assert.doesNotMatch(pinnedNotesBlock([notes[0]!], 2), /SUPERVISOR NOTES/, 'only a person pinned anything');
  assert.equal(pinnedNotesBlock([], 2), '', 'nothing pinned: the prompt is byte-identical to what it was');
});

test('OD-8: a note is stamped with the door it came through — the supervisor\'s pass writes `supervisor`', () => {
  const service = new Service(flags as never);
  try {
    const state: Record<string, unknown> = { id: 'r9', slug: 'demo', notes: [], phases: {} };
    const svc = service as unknown as {
      root: unknown; editStoredRun: (slug: string, fn: (s: Record<string, unknown>) => void) => unknown;
      noteRun: (slug: string, input: { text: string; pinned?: boolean }, actor: Record<string, unknown>) => { ok: boolean; note?: { door?: string } };
    };
    svc.root = { ok: true, path: tmpdir() };
    svc.editStoredRun = (_slug, fn) => { fn(state); return state; };
    const fromSupervisor = svc.noteRun('demo', { text: 'pressed resume', pinned: true },
      { by: 'supervisor', via: 'supervisor', origin: 'pe-hub', remoteUser: null });
    assert.equal(fromSupervisor.note?.door, 'supervisor');
    const fromPage = svc.noteRun('demo', { text: 'keep it', pinned: true },
      { by: 'operator', via: 'api', origin: 'local', remoteUser: null, pressDoor: 'local' });
    assert.equal(fromPage.note?.door, 'local');
  } finally {
    service.close();
  }
});

/* ------------------------------------------------------------------ *
 * EC5 (control-tower phase 148) — the console says which it is
 * ------------------------------------------------------------------ */

test('EC5: `ownerDoor` reads unenrolled, enrolled or unlocked — per request; a console with no key is unchanged', async () => {
  const { Browser, enrolFirst, freshOwnerState, newService } = await import('./owner-harness.ts');
  const { SoftAuthenticator } = await import('./webauthn-authenticator.ts');
  const { OWNER_DOOR_STATES } = await import('../shared/door-model.js');
  assert.deepEqual([...OWNER_DOOR_STATES], ['unenrolled', 'enrolled', 'unlocked']);
  freshOwnerState();
  const service = newService();
  try {
    const owner = new Browser(service);
    const stranger = new Browser(service);
    assert.equal((await stranger.call('GET', '/api/state')).answer.ownerDoor, 'unenrolled');
    assert.equal((await stranger.call('GET', '/api/owner')).answer.state, 'unenrolled');
    await enrolFirst(service, owner, new SoftAuthenticator('EdDSA'));
    assert.equal((await stranger.call('GET', '/api/state')).answer.ownerDoor, 'enrolled', 'a key, and this browser is not the owner');
    assert.equal((await owner.call('GET', '/api/state')).answer.ownerDoor, 'unlocked', 'a key, and this browser is');
    assert.equal(ownerDoorMode(), 'enrolled');
    // The owner door is proved by the cookie alone: a body that says otherwise is a label.
    const reading = service.doorOf({ headers: { host: 'localhost:4130', cookie: owner.cookie! } } as never);
    assert.equal(reading.door, 'owner');
    assert.equal(reading.proof, 'owner-session');
    assert.equal(reading.fresh, true);
    assert.equal(service.doorOf({ headers: { host: 'localhost:4130', cookie: 'pc-owner-4130=0123456789abcdef.forged' } } as never).door, 'local');
    // A session's token outranks a cookie it carries beside it.
    const token = service.approvals.arm('r9');
    assert.equal(service.doorOf({ headers: { host: 'localhost:4130', cookie: owner.cookie!, authorization: `Bearer ${token}` } } as never).door, 'session');
  } finally {
    service.approvals.disarm();
    service.close();
    freshOwnerState();
  }
});
