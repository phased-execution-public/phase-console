/**
 * The door: what a browser may send, and what it is told when it sends
 * something else.
 *
 * Every value tested here ends up in a child process's argv or in a run's
 * stored settings, and for a long time the answer to a bad one was to quietly
 * drop it. That is the worst of the three possible answers — the run starts,
 * looks healthy, and is not the run that was asked for. A phase asking for
 * `claude-opus-5` (the spelling the CLI's own `--help` gives as its example)
 * was discarded without a word and ran on the run's default; an effort typo
 * ran a whole plan at the wrong level.
 *
 * So the rule these tests hold: a value the console cannot honour is a 400
 * that names the field, and a value the CLI accepts is accepted here.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

type Captured = { status: number; body: unknown; headers: Record<string, unknown> };

/**
 * Read one response the way a client would.
 *
 * Every body leaves through `sendBody` now, which means it leaves as BYTES and
 * may leave content-encoded. A helper that called `JSON.parse` on whatever
 * `end()` was handed reported `''` for twenty-three tests the moment that
 * changed — so this decodes first, by the headers the response itself
 * declared, and only then decides whether it is JSON, text, or a download
 * whose whole point is its bytes.
 */
function decode(out: Captured, chunk: unknown): void {
  const bytes = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk ?? ''), 'utf8');
  const encoding = String(out.headers['content-encoding'] ?? '');
  const plain = encoding === 'br' ? brotliDecompressSync(bytes)
    : encoding === 'gzip' ? gunzipSync(bytes)
      : bytes;
  // A landing packet is `application/octet-stream` and is asserted on as bytes.
  if (String(out.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
    out.body = plain;
    return;
  }
  const asText = plain.toString('utf8');
  try { out.body = JSON.parse(asText); } catch { out.body = asText; }
}

async function call(
  service: unknown, method: string, path: string,
  { body = {}, header = true, accept = '', ifNoneMatch = '', extraHeaders = {} as Record<string, string> } = {},
): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null, headers: {} };
  // A fresh start answers the prelude's three required fields (phase 11) —
  // merged in for every case that is about some OTHER field, so a case that
  // wants to see the 400 says so by passing `undecided: true` in its body.
  if (method === 'POST' && /\/start$/.test(path) && !(body as Record<string, unknown>).resumeRunId) {
    const b = body as Record<string, unknown>;
    if (b.undecided) delete b.undecided;
    else body = { ...DECIDED, ...b };
  }
  const headers: Record<string, string> = header ? { 'x-phase-console': '1' } : {};
  if (accept) headers['accept-encoding'] = accept;
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  Object.assign(headers, extraHeaders);
  const req = {
    method,
    headers,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {
      if (method !== 'GET') yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    // Node's own `ServerResponse` carries the request it answers; `sendBody`
    // reads `res.req` to negotiate an encoding rather than threading a second
    // argument through 243 call sites. A fake without it negotiates nothing,
    // which is a silently different code path from the server's.
    req,
    writeHead(status: number, responseHeaders?: Record<string, unknown>) {
      out.status = status;
      out.headers = responseHeaders ?? {};
      return this;
    },
    end(chunk: unknown) { decode(out, chunk); },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** Just enough Service for the run door — no source directory needed. */
/** The prelude's three required answers, as the launch form sends them. */
const DECIDED = { resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 0 }] };

function fakeService(over: Record<string, unknown> = {}) {
  const started: { slug: string; options: Record<string, unknown> }[] = [];
  const configured: Record<string, unknown>[] = [];
  return {
    flags: { allowWrites: true, allowRun: true, maxSessions: 4 },
    store: { get: () => ({}), list: () => [] },
    accounts: { has: () => false },
    startRun: async (slug: string, options: Record<string, unknown>) => {
      started.push({ slug, options });
      return { id: 'r1' };
    },
    configureRun: (_slug: string, patch: Record<string, unknown>) => {
      configured.push(patch);
      return { id: 'r1' };
    },
    verificationPreflight: async () => [],
    // What the run currently IS. The settings door reads it to tell a drop
    // from a raise; `null` (no such run) reads as not-isolated, which is the
    // safe direction — you cannot raise a run that does not exist.
    runFor: async () => null as Record<string, unknown> | null,
    _started: started,
    _configured: configured,
    ...over,
  };
}

const err = (out: Captured) => String((out.body as { error?: string })?.error ?? '');

/* ------------------------------------------------------------------ *
 * Models — every spelling the CLI takes, and nothing else
 * ------------------------------------------------------------------ */

test('a run may be started on an alias, a full id, or either at the 1M window', async () => {
  for (const model of ['opus', 'claude-opus-5', 'claude-opus-5[1m]', 'opus[1m]', 'opusplan']) {
    const service = fakeService();
    const out = await call(service, 'POST', '/api/run/demo/start', { body: { model } });
    assert.equal(out.status, 200, `${model} must be accepted`);
    assert.equal(service._started[0].options.model, model, 'and stored byte-for-byte');
  }
});

test('a model that is not a Claude model is a 400 naming the field', async () => {
  for (const model of ['gpt-4', 'bogus-model-xyz', 'llama']) {
    const service = fakeService();
    const out = await call(service, 'POST', '/api/run/demo/start', { body: { model } });
    assert.equal(out.status, 400, model);
    assert.match(err(out), /must name a Claude model/);
    assert.equal(service._started.length, 0, 'and no run was created');
  }
});

test('the same vocabulary governs a settings patch', async () => {
  const okPatch = fakeService();
  assert.equal((await call(okPatch, 'POST', '/api/run/demo/settings', { body: { model: 'sonnet[1m]' } })).status, 200);
  assert.equal(okPatch._configured[0].model, 'sonnet[1m]');

  const bad = fakeService();
  const out = await call(bad, 'POST', '/api/run/demo/settings', { body: { model: 'gpt-4' } });
  assert.equal(out.status, 400);
  assert.equal(bad._configured.length, 0, 'nothing was changed');
});

test('a per-phase model or effort is checked, and the message names the phase', async () => {
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', {
    body: { phaseOptions: { 7: { model: 'gpt-4' } } },
  });
  assert.equal(out.status, 400);
  assert.match(err(out), /phase 7 model/);

  const effort = fakeService();
  const bad = await call(effort, 'POST', '/api/run/demo/start', {
    body: { phaseOptions: { 3: { effort: 'ludicrous' } } },
  });
  assert.equal(bad.status, 400);
  assert.match(err(bad), /phase 3 effort/);
});

/* ------------------------------------------------------------------ *
 * Effort — the CLI only warns, so this is the layer that refuses
 * ------------------------------------------------------------------ */

test('every effort the CLI accepts passes, and nothing else does', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const service = fakeService();
    assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { effort } })).status, 200, effort);
    assert.equal(service._started[0].options.effort, effort);
  }
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', { body: { effort: 'ludicrous' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /effort must be one of: low, medium, high, xhigh, max/);
});

test("an empty effort means this machine's default, not a bad value", async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/settings', { body: { effort: '' } })).status, 200);
  assert.equal(service._configured[0].effort, '', 'the deliberate "no --effort at all" signal survives');
});

test("QA's own model and effort can be set mid-run AND taken back off", async () => {
  // QA round 1 of P4 found the second half missing: the door tested `qaEffort`
  // for truthiness, so `''` — the operator taking the override off, which
  // `applySettings` stores as no key at all — could never be delivered, and its
  // clearing branch was dead code (F6). `effort` above does it right; these now
  // follow the same rule.
  const set = fakeService();
  assert.equal(
    (await call(set, 'POST', '/api/run/demo/settings', { body: { qaModel: 'opus', qaEffort: 'max' } })).status,
    200,
  );
  assert.equal(set._configured[0].qaModel, 'opus');
  assert.equal(set._configured[0].qaEffort, 'max');

  const cleared = fakeService();
  assert.equal(
    (await call(cleared, 'POST', '/api/run/demo/settings', { body: { qaModel: '', qaEffort: '' } })).status,
    200,
  );
  assert.equal(cleared._configured[0].qaModel, '', 'the reviewer goes back to inheriting the builder\'s');
  assert.equal(cleared._configured[0].qaEffort, '');

  // A patch that says nothing about them still leaves them alone.
  const untouched = fakeService();
  await call(untouched, 'POST', '/api/run/demo/settings', { body: { autonomy: 'keep-going' } });
  assert.equal('qaModel' in untouched._configured[0], false);
  assert.equal('qaEffort' in untouched._configured[0], false);

  // …and an unknown effort is still refused, on this door as on the other.
  const bad = fakeService();
  const out = await call(bad, 'POST', '/api/run/demo/settings', { body: { qaEffort: 'ludicrous' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /qaEffort must be one of/);
});

test('the QA round budget is a whole number the door bounds', async () => {
  const ok = fakeService();
  assert.equal((await call(ok, 'POST', '/api/run/demo/start', { body: { qaMaxRounds: 2 } })).status, 200);
  assert.equal(ok._started[0].options.qaMaxRounds, 2);
  // Zero would mean "never review", which is what turning QA off is for.
  const zero = fakeService();
  assert.equal((await call(zero, 'POST', '/api/run/demo/start', { body: { qaMaxRounds: 0 } })).status, 400);
  const huge = fakeService();
  assert.equal((await call(huge, 'POST', '/api/run/demo/start', { body: { qaMaxRounds: 99 } })).status, 400);
});

/* ------------------------------------------------------------------ *
 * The numbers
 * ------------------------------------------------------------------ */

test('maxParallel is a whole number, clamped to this console\'s own ceiling', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { maxParallel: 3 } })).status, 200);
  assert.equal(service._started[0].options.maxParallel, 3);

  const clamped = fakeService();
  await call(clamped, 'POST', '/api/run/demo/start', { body: { maxParallel: 4 } });
  assert.equal(clamped._started[0].options.maxParallel, 4, 'the ceiling itself is allowed');

  for (const bad of [0, -1, 2.5, 'lots', 99]) {
    const s = fakeService();
    const out = await call(s, 'POST', '/api/run/demo/start', { body: { maxParallel: bad } });
    assert.equal(out.status, 400, String(bad));
    assert.match(err(out), /maxParallel must be a whole number between 1 and 4/);
  }
});

test('maxConsecutiveFailures is 1..50, and garbage never reaches the runner as NaN', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/start', { body: { maxConsecutiveFailures: 5 } })).status, 200);
  assert.equal(service._started[0].options.maxConsecutiveFailures, 5);

  for (const bad of [0, 51, 'many', 1.5]) {
    const s = fakeService();
    const out = await call(s, 'POST', '/api/run/demo/settings', { body: { maxConsecutiveFailures: bad } });
    assert.equal(out.status, 400, String(bad));
    assert.match(err(out), /maxConsecutiveFailures must be a whole number between 1 and 50/);
  }

  // The bug this replaced: `Number(undefined)` is NaN, and a run compared its
  // failure count against NaN forever.
  const empty = fakeService();
  await call(empty, 'POST', '/api/run/demo/settings', { body: { maxConsecutiveFailures: '' } });
  assert.ok(!('maxConsecutiveFailures' in empty._configured[0]), 'an empty value changes nothing');
});

/* ------------------------------------------------------------------ *
 * Isolation — one word on `start`, and one direction on `settings`
 * ------------------------------------------------------------------ */

test('only the exact word reaches a start; a typo lets the preference decide', async () => {
  const yes = fakeService();
  assert.equal((await call(yes, 'POST', '/api/run/demo/start', { body: { isolation: 'worktree' } })).status, 200);
  assert.equal(yes._started[0].options.isolation, 'worktree');

  // Unrecognised means "you did not say", NOT "you said queue" — the door
  // leaves it undefined so `startRun` can apply the stored preference. Folding
  // a typo to `queue` here would silently override the very setting an
  // operator turned on.
  for (const near of ['Worktree', 'worktrees', 'true', 1, null]) {
    const service = fakeService();
    const out = await call(service, 'POST', '/api/run/demo/start', { body: { isolation: near } });
    assert.equal(out.status, 200, `${JSON.stringify(near)} is not an error`);
    assert.equal(service._started[0].options.isolation, undefined,
      `${JSON.stringify(near)} must not decide anything`);
  }
});

test('a settings patch may DROP isolation and may never raise it', async () => {
  // The drop lands, and reaches `applySettings` as the word it was given.
  const drop = fakeService({ runFor: async () => ({ id: 'r1', isolation: 'worktree' }) });
  assert.equal((await call(drop, 'POST', '/api/run/demo/settings', { body: { isolation: 'queue' } })).status, 200);
  assert.equal(drop._configured[0].isolation, 'queue');

  // The raise is refused with a 409 rather than dropped, because an operator
  // who ticked a box and got a 200 would believe the run had moved. The run's
  // commits are on the branch in the checkout it started in.
  const raise = fakeService({ runFor: async () => ({ id: 'r1' }) });
  const out = await call(raise, 'POST', '/api/run/demo/settings', { body: { isolation: 'worktree' } });
  assert.equal(out.status, 409);
  assert.match(err(out), /Stop the run and start it again/);
  assert.equal(raise._configured.length, 0, 'and nothing was changed');

  // Re-asserting what a run already is stays a 200 — a settings form that
  // resubmits every field must not 409 on the one it did not touch.
  const same = fakeService({ runFor: async () => ({ id: 'r1', isolation: 'worktree' }) });
  assert.equal((await call(same, 'POST', '/api/run/demo/settings', { body: { isolation: 'worktree' } })).status, 200);
  assert.equal(same._configured[0].isolation, 'worktree');

  // And an unrecognised value is dropped, not passed on.
  const typo = fakeService({ runFor: async () => ({ id: 'r1', isolation: 'worktree' }) });
  assert.equal((await call(typo, 'POST', '/api/run/demo/settings', { body: { isolation: 'Worktree' } })).status, 200);
  assert.equal('isolation' in typo._configured[0], false);
});

test('autoRecover and onlyPhases reach a settings patch', async () => {
  const service = fakeService();
  assert.equal((await call(service, 'POST', '/api/run/demo/settings', {
    body: { autoRecover: false, onlyPhases: [3, 3, 0, -1, '4', 'x'] },
  })).status, 200);
  const patch = service._configured[0];
  assert.equal(patch.autoRecover, false);
  assert.deepEqual(patch.onlyPhases, [3, 4], 'only whole positive phases survive');
});

/* ------------------------------------------------------------------ *
 * The read endpoints Phase 4 adds
 * ------------------------------------------------------------------ */

test('spend answers with no source directory open, and takes no flag', async () => {
  const service = fakeService({ store: null, spend: () => ({ today: { settledUsd: 0 }, runs: [], series: [] }) });
  const out = await call(service, 'GET', '/api/spend', { header: false });
  assert.equal(out.status, 200, 'a read needs neither the console header nor a capability');
  assert.deepEqual((out.body as { series: unknown[] }).series, []);
});

test('the attention inbox answers with no source directory open', async () => {
  // Above the wall on purpose: a sign-in, an unreachable MCP server and a dead
  // watcher all need a person whether or not a plan directory is open.
  const service = fakeService({ store: null, attention: async () => ({ items: [], counts: {} }) });
  const out = await call(service, 'GET', '/api/inbox');
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as { items: unknown[] }).items, []);
});

test('?all=1 is passed through to the builder', async () => {
  const seen: boolean[] = [];
  const service = fakeService({ store: null, attention: async (all: boolean) => { seen.push(all); return { items: [] }; } });
  await call(service, 'GET', '/api/inbox');
  await call(service, 'GET', '/api/inbox?all=1');
  assert.deepEqual(seen, [false, true]);
});

test('acking takes the cross-site check but NOT --allow-writes', async () => {
  const acked: string[] = [];
  const base = { store: null, ackInbox: (id: string) => { acked.push(id); return true; }, unackInbox: () => true };

  const noHeader = fakeService({ ...base, flags: { allowWrites: false, allowRun: false, maxSessions: 4 } });
  assert.equal((await call(noHeader, 'POST', '/api/inbox/ack', { body: { id: 'x' }, header: false })).status, 403);

  // A read-only console is exactly where someone would want to tidy a list
  // they cannot otherwise act on, so `--allow-writes` is deliberately not it.
  const readOnly = fakeService({ ...base, flags: { allowWrites: false, allowRun: false, maxSessions: 4 } });
  assert.equal((await call(readOnly, 'POST', '/api/inbox/ack', { body: { id: 'errand:demo:4' } })).status, 200);
  assert.deepEqual(acked, ['errand:demo:4']);
});

test('an ack is always attributed: the body\'s `by` when offered, else the actor rule (phase 12)', async () => {
  // 184 ledger acks, 0 with a name (chapter 10 §4). The ruling ledger now
  // refuses an unattributed ack, so the route derives one for the browser —
  // a fake req with no user-agent is a `script` — and passes an offered one.
  const seen: { id: string; by: string }[] = [];
  const service = fakeService({
    store: null, unackInbox: () => true,
    ackInbox: (id: string, by: string) => { seen.push({ id, by }); return true; },
    ackInboxMany: (ids: string[], by: string) => ids.map((id) => { seen.push({ id, by }); return { id, ok: true }; }),
  });
  assert.equal((await call(service, 'POST', '/api/inbox/ack', { body: { id: 'errand:demo:4' } })).status, 200);
  assert.equal((await call(service, 'POST', '/api/inbox/ack', { body: { id: 'errand:demo:5', by: 'mo' } })).status, 200);
  assert.equal((await call(service, 'POST', '/api/inbox/ack', { body: { ids: ['a', 'b'] } })).status, 200);
  assert.deepEqual(seen, [
    { id: 'errand:demo:4', by: 'script' }, { id: 'errand:demo:5', by: 'mo' }, { id: 'a', by: 'script' }, { id: 'b', by: 'script' },
  ]);
});

test('POST /api/run/:slug/rulings/:id/remember — plan behind --allow-writes, global behind the header only, the actor derived', async () => {
  const calls: unknown[][] = [];
  const remember = async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true, scope: args[2], key: 'waits', value: 'window', ack: true, detail: 'remembered' };
  };
  const on = fakeService({ rememberRuling: remember });
  const off = fakeService({ rememberRuling: remember, flags: { allowWrites: false, allowRun: true, maxSessions: 4 } });
  const path = '/api/run/demo/rulings/abcdef012345/remember';

  // The scope is the first thing checked — a body without one is a 400, not
  // a 403 that would hide the real cause behind a capability.
  const noScope = await call(on, 'POST', path, { body: {} });
  assert.equal(noScope.status, 400);
  assert.match(err(noScope), /scope/);

  assert.equal((await call(on, 'POST', path, { body: { scope: 'plan' }, header: false })).status, 403, 'the console header');
  const frozen = await call(off, 'POST', path, { body: { scope: 'plan' } });
  assert.equal(frozen.status, 403);
  assert.match(err(frozen), /--allow-writes/);
  // …but a console answer is a preference: no capability flag guards it.
  assert.equal((await call(off, 'POST', path, { body: { scope: 'global' } })).status, 200);

  const ok = await call(on, 'POST', path, { body: { scope: 'plan', by: 'op@mac' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, scope: 'plan', key: 'waits', value: 'window', ack: true, detail: 'remembered' });
  assert.deepEqual(calls, [
    ['demo', 'abcdef012345', 'global', 'script'],
    ['demo', 'abcdef012345', 'plan', 'op@mac'],
  ]);

  // A refusal carries the service's own status and words.
  const refusing = fakeService({ rememberRuling: async () => ({ ok: false, status: 404, error: 'No ruling x in the demo ledger.' }) });
  const gone = await call(refusing, 'POST', path, { body: { scope: 'global' } });
  assert.equal(gone.status, 404);
  assert.match(err(gone), /No ruling/);
  // And it is not a run verb: `--allow-run` off changes nothing here.
  const noRun = fakeService({ rememberRuling: remember, flags: { allowWrites: true, allowRun: false, maxSessions: 4 } });
  assert.equal((await call(noRun, 'POST', path, { body: { scope: 'plan' } })).status, 200);
});

test('POST /api/prefs hands the actor to savePreferences, so a changed policy answer is journalled with a name', async () => {
  const seen: { patch: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const service = fakeService({
    store: null,
    savePreferences: (patch: Record<string, unknown>, opts: Record<string, unknown>) => { seen.push({ patch, opts }); return patch; },
  });
  assert.equal((await call(service, 'POST', '/api/prefs', { body: { policy: { gates: 'operator' } } })).status, 200);
  assert.equal((await call(service, 'POST', '/api/prefs', { body: { policy: {}, by: 'mo' } })).status, 200);
  assert.deepEqual(seen.map((s) => s.opts), [{ by: 'script' }, { by: 'mo' }]);
});

test('POST /api/policy answers 400 with the rules named when the editor refuses an inert rule (phase 12)', async () => {
  const { PolicyRuleError } = await import('../server/runner/approvals.ts');
  const service = fakeService({
    store: null,
    editPolicy: () => { throw new PolicyRuleError([{ raw: 'git(:*)', note: 'git is not a tool Claude Code provides' }]); },
  });
  const out = await call(service, 'POST', '/api/policy', { body: { add: { allow: ['git(:*)'] }, scope: 'global' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /would never match/);
  assert.deepEqual((out.body as { rules: unknown }).rules, [{ raw: 'git(:*)', note: 'git is not a tool Claude Code provides' }]);
});

test('POST /api/policy/advisory/acknowledge — a receipt, behind the header alone; a kind that does not stand is a 404', async () => {
  const acked: string[] = [];
  const service = fakeService({
    store: null,
    flags: { allowWrites: false, allowRun: false, maxSessions: 4 },
    acknowledgePolicyAdvisory: (kind: string) => { acked.push(kind); return kind === 'ask-empty'; },
    policyAdvisories: () => [{ kind: 'ask-empty', rules: [], message: 'm', acknowledged: true, fingerprint: 'f' }],
  });
  assert.equal((await call(service, 'POST', '/api/policy/advisory/acknowledge', { body: { kind: 'ask-empty' }, header: false })).status, 403);
  const bad = await call(service, 'POST', '/api/policy/advisory/acknowledge', { body: { kind: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(err(bad), /ask-empty/);
  const ok = await call(service, 'POST', '/api/policy/advisory/acknowledge', { body: { kind: 'ask-empty' } });
  assert.equal(ok.status, 200, 'no --allow-writes needed: nothing about the policy changes');
  assert.deepEqual((ok.body as { advisory: { acknowledged: boolean }[] }).advisory[0].acknowledged, true);
  assert.equal((await call(service, 'POST', '/api/policy/advisory/acknowledge', { body: { kind: 'deny-struck' } })).status, 404);
  assert.deepEqual(acked, ['ask-empty', 'deny-struck']);
});

test('an ack with no id is a 400, and a DELETE with no id never clears everything', async () => {
  const service = fakeService({ store: null, ackInbox: () => true, unackInbox: () => true });
  const post = await call(service, 'POST', '/api/inbox/ack', { body: {} });
  assert.equal(post.status, 400);
  assert.match(err(post), /id/);

  // The most destructive reading must never be the default.
  const del = await call(service, 'DELETE', '/api/inbox/ack');
  assert.equal(del.status, 400);
  assert.match(err(del), /id/);

  const one = await call(service, 'DELETE', '/api/inbox/ack?id=errand%3Ademo%3A4');
  assert.equal(one.status, 200);
});

test('starting a run still needs --allow-run', async () => {
  const service = fakeService({ flags: { allowWrites: true, allowRun: false, maxSessions: 4 } });
  const out = await call(service, 'POST', '/api/run/demo/start', { body: { model: 'opus' } });
  assert.equal(out.status, 403);
  assert.match(err(out), /--allow-run/);
});

/* ------------------------------------------------------------------ *
 * the prelude (phase 11, ZTD-2 / QRL-2, gate ACC-1.2)
 * ------------------------------------------------------------------ */

test('a fresh start must answer resumeOnRestart, relay and accounts — refused 400 by name, never defaulted', async () => {
  const service = fakeService();
  const bare = await call(service, 'POST', '/api/run/demo/start', { body: { model: 'opus', undecided: true } });
  assert.equal(bare.status, 400);
  assert.deepEqual((bare.body as { missing: string[] }).missing, ['resumeOnRestart', 'relay', 'accounts']);
  assert.match(err(bare), /Decisions stage/);
  assert.equal(service._started.length, 0);
  // Two of three: the one left out is the one named.
  const two = await call(service, 'POST', '/api/run/demo/start', {
    body: { model: 'opus', resumeOnRestart: false, accounts: [{ id: 'default', minHeadroomPct: 20 }], undecided: true },
  });
  assert.equal(two.status, 400);
  assert.deepEqual((two.body as { missing: string[] }).missing, ['relay']);
  // A relay word outside the vocabulary is "not answered", not a typo let through.
  const typo = await call(service, 'POST', '/api/run/demo/start', {
    body: { resumeOnRestart: true, relay: 'sideways', accounts: [{ id: 'default' }], undecided: true },
  });
  assert.equal(typo.status, 400);
  // A resume answered at its own door: nothing required.
  const resume = await call(service, 'POST', '/api/run/demo/start', { body: { resumeRunId: 'r0' } });
  assert.equal(resume.status, 200);
  // All three: the answers reach the service as the run's fields, coerced.
  const ok = await call(service, 'POST', '/api/run/demo/start', {
    body: {
      resumeOnRestart: false, relay: 'last-resort',
      accounts: [{ id: 'default', minHeadroomPct: 250 }, { id: 'nobody-registered', minHeadroomPct: 5 }, 'default'],
      acknowledgedWaivers: ['announce', 'not-a-key'],
      manifestOverride: { rows: ['credentials'], by: '  the operator  ' },
    },
  });
  assert.equal(ok.status, 200);
  const options = service._started.at(-1)!.options;
  assert.equal(options.resumeOnRestart, false);
  assert.equal(options.relay, 'last-resort');
  assert.deepEqual(options.accounts, [{ id: 'default', minHeadroomPct: 100 }], 'clamped, deduplicated, unknown ids dropped');
  assert.deepEqual(options.acknowledgedWaivers, ['announce']);
  assert.deepEqual(options.manifestOverride, { rows: ['credentials'], by: 'the operator' });
  // An override with no `by` is signed by the request's actor — never
  // anonymous (a header-less harness call reads as `script`; a browser as
  // `operator`, `api/actor.ts`).
  await call(service, 'POST', '/api/run/demo/start', { body: { manifestOverride: { rows: ['accounts'] } } });
  assert.equal((service._started.at(-1)!.options.manifestOverride as { by: string }).by, 'script');
});

test('the start door answers 409 with every unanswered row when the prelude refuses', async () => {
  const { PreludeRefusal } = await import('../server/prelude.ts');
  const prelude = {
    slug: 'demo', rows: [], probes: {}, waived: [], acknowledged: [], manifestPresent: true, accounts: [],
    credentials: { policy: 'require', ids: [], held: [], missing: [] }, delivery: { ok: true, channels: [], acknowledged: false },
    at: '2026-09-14T00:00:00.000Z',
    blocking: [
      { key: 'credentials', why: 'outstanding — owed by operator' },
      { key: 'accounts', why: 'every declared account is unusable: the machine login — retired' },
    ],
  };
  const service = fakeService({ startRun: async () => { throw new PreludeRefusal(prelude as never); } });
  const out = await call(service, 'POST', '/api/run/demo/start', { body: { model: 'opus' } });
  assert.equal(out.status, 409);
  const body = out.body as { error: string; unanswered: { key: string; why: string }[]; prelude: { blocking: unknown[] } };
  assert.match(body.error, /2 decisions still open — credentials: outstanding/);
  assert.match(body.error, /and 1 more/);
  assert.deepEqual(body.unanswered.map((b) => b.key), ['credentials', 'accounts']);
  assert.equal(body.prelude.blocking.length, 2, 'the whole prelude rides the refusal so the form can render it');
});

test('GET /api/run/:slug/prelude serves the draft its answers and the console its probes', async () => {
  const asked: Record<string, unknown>[] = [];
  const service = fakeService({
    prelude: async (_slug: string, options: Record<string, unknown>) => { asked.push(options); return { slug: 'demo', blocking: [], rows: [] }; },
  });
  const out = await call(service, 'GET',
    '/api/run/demo/prelude?accounts=default:20,ghost:5&relay=last-resort&resumeOnRestart=false&ack=announce,credentials&model=opus&profile=trusted');
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as { prelude: { slug: string } }).prelude.slug, 'demo');
  assert.deepEqual(asked[0], {
    accounts: [{ id: 'default', minHeadroomPct: 20 }], relay: 'last-resort', resumeOnRestart: false,
    acknowledgedWaivers: ['announce', 'credentials'], model: 'opus', permissionProfile: 'trusted',
  });
  // No draft at all: the plan's own answers and the shipped defaults.
  const bare = await call(service, 'GET', '/api/run/demo/prelude');
  assert.equal(bare.status, 200);
  assert.deepEqual(asked[1], {});
  // A plan the console does not have is a 404, not a 500.
  const missing = fakeService({ prelude: async () => { throw new Error('No plan named nope.'); } });
  assert.equal((await call(missing, 'GET', '/api/run/nope/prelude')).status, 404);
});

test('GET /api/doctor serves the console\'s own report — above the no-root wall, no guard, no flag', async () => {
  const report = {
    instance: { id: 'x', name: 'x', root: null, port: 4130, default: false }, mode: 'console',
    rows: [{ id: 'accounts', label: 'Accounts', status: 'ok', blocking: true, reason: 'fine' }],
    ok: true, firstFailing: null, cliFloor: '2.1.268', at: '2026-09-14T00:00:00.000Z',
  };
  // No source directory open, no `--allow-*` flag at all, no header: the
  // console that could not open its directory is the one somebody runs doctor
  // against.
  const service = fakeService({
    store: null, flags: { allowWrites: false, allowRun: false, maxSessions: 4 }, doctor: async () => report,
  });
  const out = await call(service, 'GET', '/api/doctor', { header: false });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, report, 'the body IS the report — the CLI prints exactly this');
});

/* ------------------------------------------------------------------ *
 * the scrape endpoint
 * ------------------------------------------------------------------ */

/** Like `call`, but keeps the response HEADERS — which is the point here. */
async function scrape(
  service: unknown, accept = '',
): Promise<{ status: number; headers: Record<string, string>; body: string; bytes: Buffer }> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, headers: {} as Record<string, string>, body: '', bytes: Buffer.alloc(0) };
  const req = {
    method: 'GET',
    headers: accept ? { 'accept-encoding': accept } : {},
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {},
  };
  const res = {
    req,
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers ?? {};
      return this;
    },
    end(chunk: unknown) {
      out.bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      const encoding = String(out.headers['content-encoding'] ?? '');
      out.body = (encoding === 'br' ? brotliDecompressSync(out.bytes)
        : encoding === 'gzip' ? gunzipSync(out.bytes)
          : out.bytes).toString('utf8');
    },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/api/metrics'));
  return out;
}

test('GET /api/metrics answers Prometheus text, with the version parameter a scraper switches on', async () => {
  const service = fakeService({
    metrics: async () => '# HELP phase_console_up Up.\n# TYPE phase_console_up gauge\nphase_console_up 1\n',
  });
  const out = await scrape(service);
  assert.equal(out.status, 200);
  // `text/plain; charset=utf-8` is a DIFFERENT declaration: a scraper reads the
  // version parameter to decide which parser to use.
  assert.equal(out.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(out.headers['cache-control'], 'no-store');
  // `content-length` describes the BYTES ON THE WIRE, which since the transport
  // work is not the same number as the length of the text a scraper parses —
  // this scrape named no encoding, so here they happen to coincide. Comparing
  // against `out.bytes` is the version of this assertion that stays true when
  // the client does ask for gzip (below).
  assert.equal(Number(out.headers['content-length']), out.bytes.length);
  assert.equal(out.bytes.length, Buffer.byteLength(out.body), 'no encoding was asked for');
  assert.equal(out.headers['content-encoding'], undefined);
  assert.match(out.body, /^# HELP /);
});

test('a scraper that accepts gzip is sent gzip — exposition text is the highest-rate read here', async () => {
  // Prometheus scrapes on a fixed interval forever, and exposition text is the
  // most compressible thing this server produces. Well over the 1 KB floor, so
  // the threshold is not what is being measured.
  const line = '# HELP phase_console_up Up.\n# TYPE phase_console_up gauge\nphase_console_up 1\n';
  const service = fakeService({ metrics: async () => line.repeat(40) });
  const out = await scrape(service, 'gzip');
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-encoding'], 'gzip');
  assert.equal(out.headers['vary'], 'accept-encoding');
  assert.equal(Number(out.headers['content-length']), out.bytes.length);
  assert.ok(out.bytes.length < Buffer.byteLength(out.body), 'the wire is smaller than the text');
  // Decoded by `scrape`, so this is the scraper's view: unchanged.
  assert.equal(out.body, line.repeat(40));
  // A scraper must never be handed a cached sample, so no ETag is offered for
  // it to send back — see the note at the route.
  assert.equal(out.headers['cache-control'], 'no-store');
  assert.equal(out.headers['etag'], undefined);
});

test('a scrape needs no header, no flag and no plan directory — a 409 in a scrape loop alerts on nothing', async () => {
  // No `x-phase-console` header (a scraper sends none), no `--allow-writes`,
  // and `store: null` — the "no source directory is open" wall this route sits
  // deliberately above, exactly like /api/spend.
  const service = fakeService({
    store: null,
    flags: { allowWrites: false, allowRun: false, maxSessions: 4 },
    metrics: async () => 'phase_console_up 1\n',
  });
  const out = await scrape(service);
  assert.equal(out.status, 200);
  assert.equal(out.body, 'phase_console_up 1\n');
});

/* ------------------------------------------------------------------ *
 * The landing packet's door (P15)
 *
 * The packet is how work leaves a console that never pushes, so the two
 * questions here are who may compose one and what a download can name.
 * ------------------------------------------------------------------ */

test('landing: GET is unflagged, POST needs --allow-writes', async () => {
  const view = { slug: 'demo', repo: { available: true, dirty: [], dirtyTruncated: false }, commitCount: 3 };

  const readOnly = fakeService({
    flags: { allowWrites: false, allowRun: false, maxSessions: 4 },
    landing: async () => view,
    composeLandingPacket: async () => ({ ok: false, packet: null, detail: 'writes are disabled' }),
  });
  const read = await call(readOnly, 'GET', '/api/plans/demo/landing');
  assert.equal(read.status, 200, 'reading which branch the work is on is display, not a write');
  assert.equal((read.body as { commitCount: number }).commitCount, 3);

  const refused = await call(readOnly, 'POST', '/api/plans/demo/landing');
  assert.equal(refused.status, 403, 'composing writes files');
  assert.match(err(refused), /--allow-writes/);
});

test('landing: composing is refused without the same-origin header, like every other write', async () => {
  const service = fakeService({
    landing: async () => ({ slug: 'demo' }),
    composeLandingPacket: async () => ({ ok: true, packet: { files: [] }, detail: 'ok' }),
  });
  const out = await call(service, 'POST', '/api/plans/demo/landing', { header: false });
  assert.equal(out.status, 403, 'a cross-origin form post must not compose anything');
});

test('landing: a refusal answers 409 with the reason, not a bare failure', async () => {
  const service = fakeService({
    composeLandingPacket: async () => ({ ok: false, packet: null, detail: 'there is nothing to land' }),
  });
  const out = await call(service, 'POST', '/api/plans/demo/landing');
  assert.equal(out.status, 409);
  assert.match(err(out), /nothing to land/);
});

test('landing: a file the packet lists downloads as an attachment; anything else is a 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-routes-landing-'));
  const bundle = join(dir, 'demo.bundle');
  writeFileSync(bundle, 'BUNDLEBYTES');

  const service = fakeService({
    // The route does no resolution of its own: the service answers with a path
    // or with null, and null is the only thing a 404 is built from.
    landingArtifact: (_slug: string, name: string) => (name === 'demo.bundle' ? bundle : null),
  });

  const ok = await call(service, 'GET', '/api/plans/demo/landing/demo.bundle');
  assert.equal(ok.status, 200);
  assert.equal(String(ok.body), 'BUNDLEBYTES', 'the bytes, not a description of them');
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers['content-disposition'], 'attachment; filename="demo.bundle"');

  for (const name of ['secret.json', '..%2Fsecret.json', 'patches/0001-nope.patch']) {
    const out = await call(service, 'GET', `/api/plans/demo/landing/${name}`);
    assert.equal(out.status, 404, `served ${name}`);
  }

  // A patch is one directory down, so the name is everything after `landing/`
  // — `arg` alone would be the directory and would 404 every patch.
  const patches = fakeService({
    landingArtifact: (_slug: string, name: string) => (name === 'patches/0001-x.patch' ? bundle : null),
  });
  assert.equal((await call(patches, 'GET', '/api/plans/demo/landing/patches/0001-x.patch')).status, 200);

  rmSync(dir, { recursive: true, force: true });
});

test('landing: a manifest that outlived its file is a 404, never an empty 200', async () => {
  const service = fakeService({ landingArtifact: () => join(tmpdir(), 'pc-landing-not-here.bundle') });
  const out = await call(service, 'GET', '/api/plans/demo/landing/gone.bundle');
  assert.equal(out.status, 404);
  assert.match(err(out), /Compose the packet again/);
});

/* ------------------------------------------------------------------ *
 * The notification action callback
 * ------------------------------------------------------------------ *
 *
 * `POST /api/push/action` is the ONE route a service worker may act through,
 * so what it refuses is more of its value than what it allows. Every refusal
 * below is a way the payload could otherwise have become a general request
 * generator sitting in a notification shade.
 */

test('a notification action needs a token this console signed', async () => {
  const { mintActionToken, SpentTokens } = await import('../server/push/actions.ts');
  const performed: { item: string; verb: string }[] = [];
  const service = fakeService({
    pushActions: new SpentTokens(),
    performInboxAction: async (item: string, verb: string) => {
      performed.push({ item, verb });
      return { ok: true, verb, item };
    },
  });

  const token = mintActionToken('gate:demo:4:', ['approve'])!;
  const ok = await call(service, 'POST', '/api/push/action', { body: { token, action: 'approve' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(performed, [{ item: 'gate:demo:4:', verb: 'approve' }]);

  // Forged, absent, and junk all refuse the same way and perform nothing.
  for (const bad of [undefined, '', 'not-a-token', `${token}x`]) {
    const service2 = fakeService({
      pushActions: new SpentTokens(),
      performInboxAction: async () => { throw new Error('must not be reached'); },
    });
    const out = await call(service2, 'POST', '/api/push/action', { body: { token: bad, action: 'approve' } });
    assert.equal(out.status, 403, `token ${JSON.stringify(bad)} was accepted`);
  }
});

test('a valid token cannot be used for a verb it was not minted for', async () => {
  // The heart of it: the token names its own verbs, so a worker holding a gate
  // token cannot answer a permission card with it.
  const { mintActionToken, SpentTokens } = await import('../server/push/actions.ts');
  const service = fakeService({
    pushActions: new SpentTokens(),
    performInboxAction: async () => { throw new Error('must not be reached'); },
  });
  const token = mintActionToken('gate:demo:4:', ['approve'])!;
  for (const verb of ['allow', 'deny', 'recover', 'stop', '']) {
    const out = await call(service, 'POST', '/api/push/action', { body: { token, action: verb } });
    assert.equal(out.status, 403, `${verb} was accepted against an approve-only token`);
    assert.match(err(out), /not offered/);
  }
});

test('one notification is answerable once', async () => {
  const { mintActionToken, SpentTokens } = await import('../server/push/actions.ts');
  let calls = 0;
  const service = fakeService({
    pushActions: new SpentTokens(),
    performInboxAction: async (item: string, verb: string) => { calls += 1; return { ok: true, verb, item }; },
  });
  const token = mintActionToken('gate:demo:4:', ['approve'])!;
  assert.equal((await call(service, 'POST', '/api/push/action', { body: { token, action: 'approve' } })).status, 200);
  const again = await call(service, 'POST', '/api/push/action', { body: { token, action: 'approve' } });
  assert.equal(again.status, 409);
  assert.match(err(again), /already been answered/);
  assert.equal(calls, 1, 'and the operation ran exactly once');
});

test('the callback still takes the cross-site check', async () => {
  const { mintActionToken, SpentTokens } = await import('../server/push/actions.ts');
  const service = fakeService({
    pushActions: new SpentTokens(),
    performInboxAction: async () => { throw new Error('must not be reached'); },
  });
  const token = mintActionToken('gate:demo:4:', ['approve'])!;
  const out = await call(service, 'POST', '/api/push/action',
    { body: { token, action: 'approve' }, header: false });
  assert.equal(out.status, 403);
  assert.match(err(out), /console header/);
});

test('what the service refuses is passed through with its own status', async () => {
  // An item cleared since the push went out is `gone`, not an error — the
  // worker treats every refusal identically and opens the console.
  const { mintActionToken, SpentTokens } = await import('../server/push/actions.ts');
  const service = fakeService({
    pushActions: new SpentTokens(),
    performInboxAction: async () => ({ ok: false, status: 410, error: 'this is no longer waiting on you' }),
  });
  const token = mintActionToken('gate:demo:4:', ['approve'])!;
  const out = await call(service, 'POST', '/api/push/action', { body: { token, action: 'approve' } });
  assert.equal(out.status, 410);
  assert.match(err(out), /no longer waiting/);
});

/* ------------------------------------------------------------------ *
 * Outbound webhooks — the seventh capability
 * ------------------------------------------------------------------ */

/** Just enough of the register for the door. */
function fakeWebhooks(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    state: () => ({ allowWebhooks: true, hooks: [], categories: [] }),
    add: (url: unknown) => { calls.push(`add:${String(url)}`); return { id: 'w1', origin: 'https://x.example', tail: '/y' }; },
    remove: (id: unknown) => { calls.push(`remove:${String(id)}`); return true; },
    setCategories: () => ({ id: 'w1' }),
    test: async () => ({ ok: true, detail: 'accepted' }),
    _calls: calls,
    ...over,
  };
}

test('the registered list is readable without the flag', async () => {
  const webhooks = fakeWebhooks({ state: () => ({ allowWebhooks: false, hooks: [{ id: 'w1' }], categories: [] }) });
  const service = fakeService({ flags: { allowWebhooks: false }, webhooks });
  const out = await call(service, 'GET', '/api/webhooks');
  assert.equal(out.status, 200);
  // Seeing where your own console WOULD speak is display, exactly as the MCP
  // registry and the account list are. Hiding it is how an operator stops
  // knowing a URL is on file.
  assert.deepEqual((out.body as { hooks: unknown[] }).hooks.length, 1);
});

test('every webhook mutation is refused without --allow-webhooks, by name', async () => {
  for (const [action, body] of [
    ['add', { url: 'https://hooks.example.com/x' }],
    ['remove', { id: 'w1' }],
    ['categories', { id: 'w1', categories: {} }],
    ['test', { id: 'w1' }],
  ] as const) {
    const webhooks = fakeWebhooks();
    const service = fakeService({ flags: { allowWebhooks: false }, webhooks });
    const out = await call(service, 'POST', `/api/webhooks/${action}`, { body });
    assert.equal(out.status, 403, action);
    assert.match(err(out), /--allow-webhooks/, action);
    assert.deepEqual(webhooks._calls, [], `${action} reached the register anyway`);
  }
});

test('with the flag on, the verbs reach the register', async () => {
  const webhooks = fakeWebhooks();
  const service = fakeService({ flags: { allowWebhooks: true }, webhooks });
  assert.equal((await call(service, 'POST', '/api/webhooks/add', { body: { url: 'https://hooks.example.com/x' } })).status, 200);
  assert.equal((await call(service, 'POST', '/api/webhooks/remove', { body: { id: 'w1' } })).status, 200);
  assert.deepEqual(webhooks._calls, ['add:https://hooks.example.com/x', 'remove:w1']);
});

test('a refused URL is a 400 carrying the register\'s own sentence', async () => {
  const webhooks = fakeWebhooks({ add: () => ({ error: 'URL must be https' }) });
  const service = fakeService({ flags: { allowWebhooks: true }, webhooks });
  const out = await call(service, 'POST', '/api/webhooks/add', { body: { url: 'http://x' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /must be https/);
});

test('changing a webhook still takes the cross-site check', async () => {
  const webhooks = fakeWebhooks();
  const service = fakeService({ flags: { allowWebhooks: true }, webhooks });
  const out = await call(service, 'POST', '/api/webhooks/add',
    { body: { url: 'https://hooks.example.com/x' }, header: false });
  assert.equal(out.status, 403);
  assert.match(err(out), /console header/);
  assert.deepEqual(webhooks._calls, []);
});

test('setting categories on a row that is gone is a 404, not a silent 200', async () => {
  const webhooks = fakeWebhooks({ setCategories: () => null });
  const service = fakeService({ flags: { allowWebhooks: true }, webhooks });
  const out = await call(service, 'POST', '/api/webhooks/categories', { body: { id: 'nope', categories: {} } });
  assert.equal(out.status, 404);
  assert.match(err(out), /no such webhook/);
});

/* ------------------------------------------------------------------ *
 * Resuming a session this console never started (Phase 8)
 * ------------------------------------------------------------------ */

/**
 * The door for `POST /api/terminal {kind:'claude', resume}`.
 *
 * The browser sends an id and NOTHING else about the session it names — the
 * same split the recovery briefing, the QA briefing and the account already
 * follow. What makes it load-bearing here rather than merely tidy: `--resume`
 * resolves a conversation globally (measured, Phase 8), so the cwd the mint
 * spawns in never decides whether the session STARTS — only whether it starts
 * in the repository it was working in. A wrong answer here is silent.
 */
function resumeService(views: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  const minted: { launch: Record<string, unknown> | undefined }[] = [];
  return {
    ...fakeService({
      flags: { allowAgent: true, allowWrites: true, scriptsDir: '/opt/pe/scripts', maxSessions: 4 },
      skills: () => [],
      sessionViews: () => views,
      terminals: {
        mint: async (_id: unknown, _size: unknown, launch: Record<string, unknown> | undefined) => {
          minted.push({ launch });
          return { ok: true, sessionId: 'pty-1', token: 't', expiresAt: 0, session: { id: 'pty-1' } };
        },
      },
      ...over,
    }),
    _minted: minted,
  };
}

const RESUMED = '11111111-2222-4333-8444-555555555555';

test('a resume is spawned in the directory the REGISTRY says the conversation lives in', async () => {
  const service = resumeService([
    { sessionId: 'someone-else', cwd: '/work/other' },
    { sessionId: RESUMED, cwd: '/work/hub', kind: 'foreign', plan: { slug: 'demo', phase: 3 } },
  ]);
  const out = await call(service, 'POST', '/api/terminal', { body: { kind: 'claude', resume: RESUMED } });
  assert.equal(out.status, 200);
  const launch = service._minted[0].launch as { cwd?: string; label?: string; args: string[] };
  assert.equal(launch.cwd, '/work/hub', 'the row it matched, not the first row and not the root');
  assert.deepEqual(launch.args.slice(0, 2), ['--resume', RESUMED]);
  assert.equal(launch.label, 'Resumed: demo · P3');
});

test('a resume the registry never heard of still mints — it just keeps the open root', async () => {
  const service = resumeService([{ sessionId: 'other', cwd: '/work/other' }]);
  const out = await call(service, 'POST', '/api/terminal', { body: { kind: 'claude', resume: RESUMED } });
  assert.equal(out.status, 200);
  assert.equal((service._minted[0].launch as { cwd?: string }).cwd, undefined);
});

/* ------------------------------------------------------------------ *
 * The QA reviewer's task channel (2026-09-07)
 * ------------------------------------------------------------------ */

test('GET /api/terminal serves the FOLDED state — a QA reviewer\'s task list rides on its session', async () => {
  // The registry knows processes, not files: the fold that reads each
  // reviewer's inbox is the service's (`terminalState`), and the door serves
  // that rather than the bare `terminals.state()` it used to.
  const service = fakeService({
    terminalState: () => ({
      allowed: true, agentAllowed: true, available: 'yes', limit: 4, live: 1,
      sessions: [{
        id: 'q1', kind: 'claude', meta: { qa: { slug: 'demo', phase: 2 } },
        tasks: [{ id: 'p2.task1', content: 'read the diff', status: 'in_progress' }],
      }],
    }),
  });
  const out = await call(service, 'GET', '/api/terminal');
  assert.equal(out.status, 200, err(out));
  const body = out.body as { sessions: { id: string; tasks?: { content: string }[] }[] };
  assert.equal(body.sessions[0].tasks?.[0].content, 'read the diff');
});

test('a QA session minted from the page is handed its task channel — the inbox the Sessions page folds', async () => {
  // `buildAgentLaunch` derives `PE_TASKS_FILE` from the open root; the door
  // has to hand the root over, or a reviewer minted from the button publishes
  // into the same file by the script's fallback rule and nothing reads it —
  // the measured pre-2026-09-07 shape.
  const minted: { launch: Record<string, unknown> | undefined }[] = [];
  const service = fakeService({
    flags: { allowAgent: true, allowWrites: true, scriptsDir: '/opt/pe/scripts', maxSessions: 4 },
    skills: () => [],
    sessionViews: () => [],
    root: { ok: true, path: '/repo/alpha-root' },
    resolveQa: async (request: { slug: string; phase: number }) => ({
      ok: true,
      facts: {
        ...request, scriptsDir: '/opt/pe/scripts', skillId: 'phased-execution',
        reportPath: 'docs/handoffs/demo/reports/phase-02-qa.md', reportArg: 'reports/phase-02-qa.md',
      },
    }),
    terminals: {
      mint: async (_id: unknown, _size: unknown, launch: Record<string, unknown> | undefined) => {
        minted.push({ launch });
        return { ok: true, sessionId: 'pty-1', token: 't', expiresAt: 0, session: { id: 'pty-1' } };
      },
    },
  });
  const out = await call(service, 'POST', '/api/terminal', {
    body: { kind: 'claude', intent: 'qa', slug: 'demo', phase: 2 },
  });
  assert.equal(out.status, 200, err(out));
  const env = (minted[0].launch as { env?: Record<string, string> }).env ?? {};
  assert.match(env.PE_TASKS_FILE ?? '', /\/demo\/tasks\/phase-02\.ndjson$/, 'the inbox for (demo, 2)');
});

/* ------------------------------------------------------------------ *
 * QA on/off from the console — `POST /api/plans/:slug/qa-mode` (2026-09-07)
 * ------------------------------------------------------------------ */

function qaModeService() {
  const set: { slug: string; request: Record<string, unknown> }[] = [];
  const activated: { slug: string; phase: number }[] = [];
  return {
    ...fakeService({
      setQaMode: async (slug: string, request: Record<string, unknown>) => {
        set.push({ slug, request });
        return { ok: true, plan: { mode: 'on' }, detail: 'QA now reads on for alpha.' };
      },
      activateQa: async (slug: string, phase: number) => {
        activated.push({ slug, phase });
        return { ok: true, mode: 'on', detail: 'QA is now on for alpha.' };
      },
    }),
    _set: set,
    _activated: activated,
  };
}

test('{mode} sets the plan-wide regime and {mode, phase} one phase\'s — through setQaMode', async () => {
  const service = qaModeService();
  let out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { mode: 'off' } });
  assert.equal(out.status, 200, err(out));
  out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { mode: 'inherit', phase: 3 } });
  assert.equal(out.status, 200, err(out));
  assert.deepEqual(service._set, [
    { slug: 'alpha', request: { mode: 'off' } },
    { slug: 'alpha', request: { mode: 'inherit', phase: 3 } },
  ]);
  assert.deepEqual(service._activated, [], 'setting a regime never routes through activation');
});

test('a body with a phase and no mode still means "activate" — the older client\'s verb', async () => {
  const service = qaModeService();
  const out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { phase: 2 } });
  assert.equal(out.status, 200, err(out));
  assert.deepEqual(service._activated, [{ slug: 'alpha', phase: 2 }]);
  assert.deepEqual(service._set, []);
});

test('an unknown mode, a bad phase, or neither field is refused with the vocabulary named', async () => {
  const service = qaModeService();
  let out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { mode: 'maybe' } });
  assert.equal(out.status, 400);
  assert.match(err(out), /on, off, inherit/);
  out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { mode: 'on', phase: 0 } });
  assert.equal(out.status, 400);
  out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: {} });
  assert.equal(out.status, 400);
  assert.match(err(out), /\{mode, phase\?\}/);
  assert.deepEqual(service._set, []);
  assert.deepEqual(service._activated, []);
});

test('GET qa-report/:phase serves the report the service reads for (phase, round), and only that', async () => {
  const asked: unknown[][] = [];
  const service = fakeService({
    qaReport: (slug: string, phase: number, round?: number) => {
      asked.push([slug, phase, round]);
      return round === 2 ? { path: 'reports/phase-03-qa-round2.md', round: 2, text: '# Round 2\n' } : null;
    },
  });
  let out = await call(service, 'GET', '/api/plans/alpha/qa-report/3?round=2');
  assert.equal(out.status, 200, err(out));
  assert.equal((out.body as { path: string }).path, 'reports/phase-03-qa-round2.md');
  out = await call(service, 'GET', '/api/plans/alpha/qa-report/3');
  assert.equal(out.status, 404, 'nothing on file is a miss, never a read of something else');
  assert.deepEqual(asked, [['alpha', 3, 2], ['alpha', 3, undefined]]);
  out = await call(service, 'GET', '/api/plans/alpha/qa-report/3?round=x');
  assert.equal(out.status, 400);
  out = await call(service, 'GET', '/api/plans/alpha/qa-report/x');
  assert.equal(out.status, 400);
  assert.equal(asked.length, 2, 'a malformed request never reaches the reader');
});

test('the qa-mode door is write-class: refused without --allow-writes', async () => {
  const service = { ...qaModeService(), flags: { allowWrites: false, allowRun: true, maxSessions: 4 } };
  const out = await call(service, 'POST', '/api/plans/alpha/qa-mode', { body: { mode: 'off' } });
  assert.equal(out.status, 403);
  assert.match(err(out), /--allow-writes/);
});

test('a cwd in the BODY is never honoured — only the registry answers that', async () => {
  const service = resumeService([{ sessionId: RESUMED, cwd: '/work/hub' }]);
  await call(service, 'POST', '/api/terminal', {
    body: { kind: 'claude', resume: RESUMED, cwd: '/etc', launch: { cwd: '/etc' } },
  });
  assert.equal((service._minted[0].launch as { cwd?: string }).cwd, '/work/hub');
});

test('resuming a foreign session is --allow-agent’s decision, and the message names the flag', async () => {
  const service = resumeService([{ sessionId: RESUMED, cwd: '/work/hub' }], { flags: { allowAgent: false } });
  const out = await call(service, 'POST', '/api/terminal', { body: { kind: 'claude', resume: RESUMED } });
  assert.equal(out.status, 403);
  assert.match(err(out), /--allow-agent/);
  assert.deepEqual(service._minted, [], 'and nothing was started');
});

test('the registry is READ on this path and never written', async () => {
  // The presence hook is the only writer of a foreign session record. A resume
  // that quietly adopted, renamed or ended the row it read would make the
  // console a second writer of a file it does not own.
  const calls: string[] = [];
  const views = [{ sessionId: RESUMED, cwd: '/work/hub' }];
  const service = resumeService(views, {
    sessions: new Proxy({}, { get: (_t, prop) => { calls.push(String(prop)); return () => undefined; } }),
  });
  await call(service, 'POST', '/api/terminal', { body: { kind: 'claude', resume: RESUMED } });
  assert.deepEqual(calls, [], 'the mint reaches the registry object itself not at all');
  assert.deepEqual(views, [{ sessionId: RESUMED, cwd: '/work/hub' }], 'and the records are untouched');
});

/* ------------------------------------------------------------------ *
 * The inbox door — one ask, or a selection of them
 *
 * `POST /api/inbox/ack` took a scalar `id` and nothing else, so acknowledging
 * seventeen asks was seventeen requests and seventeen whole-file rewrites. The
 * bulk form answers PER ITEM, the shape `/api/locks/release {expired:true}`
 * settled on: fifteen successes must not be able to hide one refusal.
 * ------------------------------------------------------------------ */

function inboxService() {
  const acked: { ids: string[]; by?: string }[] = [];
  const unacked: string[][] = [];
  return {
    flags: { allowWrites: false, allowRun: false },
    store: null,
    ackInbox(id: string, by?: string) {
      acked.push({ ids: [id], ...(by ? { by } : {}) });
      return true;
    },
    ackInboxMany(ids: string[], by?: string) {
      acked.push({ ids, ...(by ? { by } : {}) });
      return ids.map((id) => ({ id, ok: true }));
    },
    unackInbox(id: string) {
      unacked.push([id]);
      return true;
    },
    unackInboxMany(ids: string[]) {
      unacked.push(ids);
      return ids.map((id) => ({ id, ok: true }));
    },
    _acked: acked,
    _unacked: unacked,
  };
}

test('a selection is acknowledged in ONE request, and answered per item', async () => {
  const service = inboxService();
  const out = await call(service, 'POST', '/api/inbox/ack', { body: { ids: ['a', 'b', 'c'], by: 'mobin' } });

  assert.equal(out.status, 200);
  assert.deepEqual(service._acked, [{ ids: ['a', 'b', 'c'], by: 'mobin' }]);
  const body = out.body as { results: { id: string; ok: boolean }[]; acked: number };
  assert.deepEqual(
    body.results.map((r) => r.id),
    ['a', 'b', 'c'],
    'one row per id, so a refusal cannot hide behind the others',
  );
  assert.equal(body.acked, 3);
});

test('a refusal inside a batch is reported, not swallowed', async () => {
  const service = {
    ...inboxService(),
    ackInboxMany: (ids: string[]) =>
      ids.map((id) => (id === 'bad' ? { id, ok: false, error: 'the ledger refused the line' } : { id, ok: true })),
  };
  const out = await call(service, 'POST', '/api/inbox/ack', { body: { ids: ['a', 'bad', 'c'] } });

  const body = out.body as { results: { id: string; ok: boolean; error?: string }[]; acked: number };
  assert.equal(out.status, 200, 'a partial success is not a failed call');
  assert.equal(body.acked, 2, 'and it is not a clean one either');
  assert.equal(body.results.find((r) => r.id === 'bad')?.error, 'the ledger refused the line');
});

test('the scalar form still works, and is still one ack', async () => {
  const service = inboxService();
  const out = await call(service, 'POST', '/api/inbox/ack', { body: { id: 'just-one' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true });
  // Attributed even when the client sent no name (phase 12): the actor rule.
  assert.deepEqual(service._acked, [{ ids: ['just-one'], by: 'script' }]);
});

test('an empty or unusable selection is a 400 naming what to send', async () => {
  for (const body of [{ ids: [] }, { ids: [null, 42, ''] }, {}]) {
    const service = inboxService();
    const out = await call(service, 'POST', '/api/inbox/ack', { body });
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.match(err(out), /inbox item id/);
    assert.equal(service._acked.length, 0, 'and nothing was acknowledged');
  }
});

test('the batch is capped, and each id is capped', async () => {
  const service = inboxService();
  const ids = Array.from({ length: 1500 }, (_, i) => `id-${i}`);
  await call(service, 'POST', '/api/inbox/ack', { body: { ids: [...ids, 'x'.repeat(400)] } });
  assert.equal(service._acked[0].ids.length, 1000, 'the notification inbox pins the same 1000');
  assert.ok(service._acked[0].ids.every((id) => id.length <= 256));
});

test('undo un-acknowledges the selection, and no id still means no clear-everything', async () => {
  const service = inboxService();

  const many = await call(service, 'DELETE', '/api/inbox/ack?id=a&id=b&id=c');
  assert.equal(many.status, 200);
  assert.deepEqual(service._unacked, [['a', 'b', 'c']]);
  assert.equal((many.body as { unacked: number }).unacked, 3);

  const one = await call(service, 'DELETE', '/api/inbox/ack?id=solo');
  assert.deepEqual(one.body, { ok: true }, 'one id keeps the one-id answer');

  const none = await call(service, 'DELETE', '/api/inbox/ack');
  assert.equal(none.status, 400, 'the most destructive reading is never the default');
});

test('a bulk ack still takes the cross-site check, and still not --allow-writes', async () => {
  // An ack annotates a view and writes nothing in a repository, so a read-only
  // console is exactly where someone would want to tidy a list. Being able to
  // tidy SEVENTEEN of them does not change that.
  const service = inboxService();
  const forged = await call(service, 'POST', '/api/inbox/ack', { body: { ids: ['a'] }, header: false });
  assert.equal(forged.status, 403);
  assert.equal(service._acked.length, 0);

  const readOnly = { ...inboxService(), flags: { allowWrites: false, allowRun: false } };
  const allowed = await call(readOnly, 'POST', '/api/inbox/ack', { body: { ids: ['a'] } });
  assert.equal(allowed.status, 200);
});

/* ------------------------------------------------------------------ *
 * The git door, and the boot-resume question
 * ------------------------------------------------------------------ */

test('isolation without a run branch is refused at the door, not degraded at runtime', async () => {
  // `isolation: worktree` needs a branch to put lanes on, and only
  // `gitMode: new-branch` mints one. Before 3.5.0 this combination was accepted
  // and then failed inside `checkAvailable`, released the tree, and carried on
  // shared — with the reason in the journal and nothing on any screen.
  const svc = fakeService({ prefs: { isolation: 'queue', gitMode: 'default-branch' } });
  const bad = await call(svc, 'POST', '/api/run/demo/start', {
    body: { isolation: 'worktree', gitMode: 'default-branch' },
  });
  assert.equal(bad.status, 400);
  assert.match(err(bad), /isolation needs a run branch/);
  assert.equal(svc._started.length, 0, 'nothing was started');

  // The pair is judged RESOLVED: a body that names only isolation is judged
  // against the stored strategy, which is what the run would actually get.
  const stored = fakeService({ prefs: { isolation: 'queue', gitMode: 'default-branch' } });
  assert.equal(
    (await call(stored, 'POST', '/api/run/demo/start', { body: { isolation: 'worktree' } })).status,
    400,
  );

  // …and the legal pair still starts.
  const ok = fakeService({ prefs: { isolation: 'queue', gitMode: 'new-branch' } });
  assert.equal(
    (await call(ok, 'POST', '/api/run/demo/start', { body: { isolation: 'worktree' } })).status,
    200,
  );
});

test('a typo in the git strategy is dropped, never turned into a refusal', async () => {
  // Every door here reads only words it knows and treats the rest as "you did
  // not say". A refusal that fired on a typo would be the one place that
  // posture broke — and it would fire on silence too.
  const svc = fakeService({ prefs: { isolation: 'queue', gitMode: 'new-branch' } });
  const out = await call(svc, 'POST', '/api/run/demo/start', {
    body: { isolation: 'worktree', gitMode: 'defualt-branch' },
  });
  assert.equal(out.status, 200, 'the typo is dropped and the stored strategy decides');
});

test('the boot-resume answer is run-class, and takes only the two words', async () => {
  const asks = new Map([
    ['r1', { slug: 'alpha', runId: 'r1', phases: [2], sessions: ['s2'], at: 'now' }],
    ['r2', { slug: 'beta', runId: 'r2', phases: [1], sessions: [], at: 'now' }],
  ]);
  const decisions = new Map<string, string>();
  const converged: string[] = [];
  const svc = fakeService({
    resumeAsks: asks,
    resumeDecisions: decisions,
    converger: { converge: async (slug: string) => { converged.push(slug); return null; } },
  });

  assert.equal((await call(svc, 'POST', '/api/boot-resume', { body: { decision: 'maybe' } })).status, 400);

  const out = await call(svc, 'POST', '/api/boot-resume', { body: { decision: 'continue' } });
  assert.equal(out.status, 200);
  // Every waiting run, in one press: "continue all" is the answer an operator
  // gives most often and it must not be four presses.
  assert.deepEqual([...decisions.entries()].sort(), [['r1', 'continue'], ['r2', 'continue']]);
  assert.deepEqual(converged.sort(), ['alpha', 'beta']);

  // A named run answers alone, and dismissing converges nothing — nothing about
  // a dismissed run changed except that nobody is being asked any more.
  const one = fakeService({
    resumeAsks: asks, resumeDecisions: new Map<string, string>(),
    converger: { converge: async () => null },
  });
  const named = await call(one, 'POST', '/api/boot-resume', { body: { decision: 'dismiss', runId: 'r2' } });
  assert.equal(named.status, 200);
  assert.deepEqual((named.body as { answered: string[] }).answered, ['r2']);

  // …and it is behind `--allow-run`, like every other door that can spend.
  const noRun = fakeService({
    flags: { allowWrites: true, allowRun: false, maxSessions: 4 },
    resumeAsks: asks, resumeDecisions: new Map<string, string>(),
  });
  assert.equal((await call(noRun, 'POST', '/api/boot-resume', { body: { decision: 'continue' } })).status, 403);
});

/* ------------------------------------------------------------------ *
 * The repository browse surface — six GETs, and what each refusal MEANS
 *
 * The parsers and the safety envelope are `git-browse.test.ts`'s subject
 * against real git. What is tested here is the DOOR: which query parameters
 * reach the service, and — the half a client actually depends on — that the
 * two refusals are told apart. `unknown repository` and `unusable range` are
 * different mistakes with different fixes, and a surface that answered one
 * status for both would leave Phase 9 unable to say which happened.
 * ------------------------------------------------------------------ */

/** A service that records what the repo surface was asked, and answers plainly. */
function repoService(over: Record<string, unknown> = {}) {
  const asked: Record<string, unknown>[] = [];
  return fakeService({
    repoTargets: async () => [{ key: 'root', dir: '/repo', label: 'repository root', kind: 'root' }],
    repoGraph: async (opts: Record<string, unknown>) => { asked.push(opts); return { commits: [], tips: ['main'], tipsTruncated: false, truncated: false }; },
    repoBranches: async (repo?: string) => { asked.push({ repo }); return { branches: [], truncated: false, divergenceTruncated: false }; },
    repoCheckouts: async () => ({ checkouts: [], truncated: false }),
    repoDiff: async (opts: Record<string, unknown>) => { asked.push(opts); return { files: [], filesTruncated: false, fileCount: 0 }; },
    repoSettles: (opts: Record<string, unknown>) => { asked.push(opts); return { events: [], truncated: false, scanned: { runs: 0, entriesPerRun: 500 } }; },
    _asked: asked,
    ...over,
  });
}

test('every repo surface answers 200, and reading one needs no flag', async () => {
  for (const path of ['targets', 'graph', 'branches', 'checkouts', 'diff', 'settles']) {
    // No `--allow-writes`, no `--allow-run`: seeing the history of the
    // repository you pointed this console at is display.
    const service = repoService({ flags: { allowWrites: false, allowRun: false, maxSessions: 4 } });
    const out = await call(service, 'GET', `/api/repo/${path}`);
    assert.equal(out.status, 200, `${path} must be readable`);
  }
});

test('an unknown repo surface is a 404 rather than a silent nothing', async () => {
  const out = await call(repoService(), 'GET', '/api/repo/nonsense');
  assert.equal(out.status, 404);
  assert.match(err(out), /unknown repository surface/);
  // …and a bare `/api/repo` is the same answer, not a crash.
  assert.equal((await call(repoService(), 'GET', '/api/repo')).status, 404);
});

test('the graph door passes refs, limit, cursor and `all` through', async () => {
  const service = repoService();
  await call(service, 'GET', '/api/repo/graph?repo=lane%2Fp4&ref=main&ref=pe%2Fdemo&limit=25&cursor=50&all=1');
  assert.deepEqual(service._asked[0], {
    repo: 'lane/p4',
    // Repeatable, in order — a graph over two tips is the common ask.
    refs: ['main', 'pe/demo'],
    all: true,
    limit: 25,
    cursor: '50',
  });
});

test('a bad count is dropped rather than passed on as NaN', async () => {
  const service = repoService();
  await call(service, 'GET', '/api/repo/graph?limit=nonsense&cursor=');
  assert.equal(service._asked[0].limit, undefined, 'NaN must never reach a clamp');
  // Zero and a negative are not counts either — the module's own floor is 1.
  await call(service, 'GET', '/api/repo/graph?limit=0');
  assert.equal(service._asked[1].limit, undefined);
  await call(service, 'GET', '/api/repo/graph?limit=-5');
  assert.equal(service._asked[2].limit, undefined);
});

test('unified=0 reaches the diff, and ABSENT unified is not zero', async () => {
  // QA round 1's Low: `--unified=0` asks for hunks with no context, and the
  // shared `> 0` reader dropped it, so a client could never get one.
  const service = repoService();
  await call(service, 'GET', '/api/repo/diff?tip=HEAD&path=a.ts&unified=0');
  assert.equal(service._asked[0].unified, 0);

  // 🔴 QA round 2's High, and the case round 1's fix did not have: `query.get`
  // answers `null` for an absent parameter and `Number(null)` is `0`, so the
  // floor-of-zero that let an explicit `0` through ALSO turned "the client said
  // nothing" into "zero context lines" — every default patch came back with no
  // context at all. Absence must survive the reader.
  await call(service, 'GET', '/api/repo/diff?tip=HEAD&path=a.ts');
  assert.equal(service._asked[1].unified, undefined, 'an absent unified must stay absent');
  // An empty value is absence too, for the same reason: `Number('')` is 0.
  await call(service, 'GET', '/api/repo/diff?tip=HEAD&path=a.ts&unified=');
  assert.equal(service._asked[2].unified, undefined);
  // …and a negative is still not a context width.
  await call(service, 'GET', '/api/repo/diff?tip=HEAD&path=a.ts&unified=-1');
  assert.equal(service._asked[3].unified, undefined);
  // The floor is per-parameter: `limit=0` and `bytes=0` are still dropped.
  await call(service, 'GET', '/api/repo/diff?tip=HEAD&bytes=0');
  assert.equal(service._asked[4].bytes, undefined);
  await call(service, 'GET', '/api/repo/graph?limit=');
  assert.equal(service._asked[5].limit, undefined);
});

test('an unknown repository is a 404 and an unusable range is a 400 — never the same answer', async () => {
  const missing = repoService({
    repoGraph: async () => 'unknown-repo', repoBranches: async () => null,
  });
  assert.equal((await call(missing, 'GET', '/api/repo/graph?repo=nope')).status, 404);
  assert.equal((await call(missing, 'GET', '/api/repo/branches?repo=nope')).status, 404);

  // The graph door tells the same two apart as the diff door: an unknown
  // repository is a 404, a ref this repository does not have is a 400. Quietly
  // answering the DEFAULT graph — which it used to — hands a client a picture
  // of something it did not ask about. (P8 QA round 4, Low.)
  const noRef = repoService({ repoGraph: async () => null });
  const noSuchRef = await call(noRef, 'GET', '/api/repo/graph?ref=ghost');
  assert.equal(noSuchRef.status, 400);
  assert.match(err(noSuchRef), /no such ref here/);

  // The diff door tells the two apart, which is the pair a client renders
  // different messages for.
  const unknownRepo = repoService({ repoDiff: async () => 'unknown-repo' });
  const out404 = await call(unknownRepo, 'GET', '/api/repo/diff?repo=nope&tip=HEAD');
  assert.equal(out404.status, 404);
  assert.match(err(out404), /unknown repository/);

  const badRange = repoService({ repoDiff: async () => null });
  const out400 = await call(badRange, 'GET', '/api/repo/diff?base=--upload-pack%3Dx');
  assert.equal(out400.status, 400);
  assert.match(err(out400), /unusable range or path/);
});

test('the diff door passes the range, the path and both budgets', async () => {
  const service = repoService();
  await call(service, 'GET', '/api/repo/diff?base=HEAD~1&tip=HEAD&path=src%2Fa.ts&bytes=65536&unified=8');
  assert.deepEqual(service._asked[0], {
    repo: undefined, base: 'HEAD~1', tip: 'HEAD', path: 'src/a.ts', bytes: 65536, unified: 8,
  });
  // An absent half stays absent — `base` alone means the WORKING TREE, and a
  // door that substituted `HEAD` for a missing tip would answer a different
  // question from the one asked.
  await call(service, 'GET', '/api/repo/diff?base=HEAD');
  assert.equal(service._asked[1].tip, undefined);
});

test('the settles door carries its window, so a surface can say what it scanned', async () => {
  const service = repoService();
  const out = await call(service, 'GET', '/api/repo/settles?slug=demo&limit=10&runs=5&entries=200');
  assert.deepEqual(service._asked[0], { limit: 10, slug: 'demo', runs: 5, entries: 200 });
  assert.deepEqual((out.body as { scanned: unknown }).scanned, { runs: 0, entriesPerRun: 500 });
});

test('the checkout registry takes no repo key — it is one fact about one repository', async () => {
  const service = repoService();
  const out = await call(service, 'GET', '/api/repo/checkouts?repo=anything');
  assert.equal(out.status, 200);
  // Asked without the key, so a caller cannot make the same registry answer
  // twice under two names.
  assert.equal(service._asked.length, 0);

  const noRoot = repoService({ repoCheckouts: async () => null });
  const out404 = await call(noRoot, 'GET', '/api/repo/checkouts');
  assert.equal(out404.status, 404);
  assert.match(err(out404), /no source directory/);
});

test('a write verb against the repo surface is refused', async () => {
  for (const method of ['POST', 'DELETE']) {
    const out = await call(repoService(), method, '/api/repo/graph');
    assert.notEqual(out.status, 200, `${method} must not be answered by a read surface`);
  }
});

/* ------------------------------------------------------------------ *
 * The actor — derived from the request, never supplied (SHD-3, ACT-11)
 * ------------------------------------------------------------------ */

test('ACT-11: switch-account with no `by` records an actor derived from the request, never the literal console', async () => {
  const switched: unknown[][] = [];
  const service = fakeService({
    accounts: { has: () => true },
    switchAccountRun: (...args: unknown[]) => { switched.push(args); return { ok: true, run: { id: 'r1' } }; },
  });
  // A browser: Mozilla-shaped User-Agent, loopback Host, nothing in the body.
  const out = await call(service, 'POST', '/api/run/demo/switch-account', {
    body: { accountId: 'default' },
    extraHeaders: { host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605' },
  });
  assert.equal(out.status, 200, err(out));
  assert.deepEqual(switched[0].slice(0, 3), ['demo', 'default', { by: 'operator', via: 'api', origin: 'local', remoteUser: null }]);
  // A script — curl, undici, nothing — is told apart from the operator.
  await call(service, 'POST', '/api/run/demo/switch-account', { body: { accountId: 'default' }, extraHeaders: { host: '127.0.0.1:4123', 'user-agent': 'curl/8.4.0' } });
  assert.equal((switched[1][2] as { by: string }).by, 'script');
  // The console's own CLI is the operator, over `cli`.
  await call(service, 'POST', '/api/run/demo/switch-account', { body: { accountId: 'default' }, extraHeaders: { host: '127.0.0.1:4123', 'user-agent': 'btw/1' } });
  assert.deepEqual(switched[2][2], { by: 'operator', via: 'cli', origin: 'local', remoteUser: null });
  // A body may still LABEL `by`; the transport it cannot touch.
  await call(service, 'POST', '/api/run/demo/switch-account', { body: { accountId: 'default', by: 'a test' }, extraHeaders: { host: '127.0.0.1:4123', 'user-agent': 'curl/8.4.0' } });
  assert.deepEqual(switched[3][2], { by: 'a test', via: 'api', origin: 'local', remoteUser: null });
  for (const call_ of switched) assert.notEqual((call_[2] as { by: string }).by, 'console');
});

test('SHD-3: through the --remote proxy the actor carries the login and the hostname the proxy served', async () => {
  const stopped: unknown[][] = [];
  const service = fakeService({
    flags: { allowWrites: true, allowRun: true, maxSessions: 4, remoteHosts: ['mac.tail1234.ts.net'], remoteUsers: ['alice@github'] },
    stopRun: async (...args: unknown[]) => { stopped.push(args); return { id: 'r1' }; },
  });
  const out = await call(service, 'POST', '/api/run/demo/stop', {
    body: {},
    extraHeaders: { host: 'mac.tail1234.ts.net', 'tailscale-user-login': 'alice@github', 'user-agent': 'Mozilla/5.0 (iPhone) Safari/605' },
  });
  assert.equal(out.status, 200, err(out));
  assert.deepEqual(stopped[0][2], { by: 'alice@github', via: 'api', origin: 'mac.tail1234.ts.net', remoteUser: 'alice@github' });
  // The same header on a loopback request vouches for nobody (classify() would have refused it upstream anyway).
  await call(service, 'POST', '/api/run/demo/stop', {
    body: {}, extraHeaders: { host: '127.0.0.1:4123', 'tailscale-user-login': 'alice@github', 'user-agent': 'curl/8' },
  });
  assert.deepEqual(stopped[1][2], { by: 'script', via: 'api', origin: 'local', remoteUser: null });
});

test('SHD-3: restart and shutdown derive their actor, and a body with no `by` never reads console', async () => {
  const seen: unknown[] = [];
  const service = fakeService({
    restart: (who: unknown, force: boolean) => { seen.push(['restart', who, force]); return { ok: true }; },
    shutdown: (who: unknown) => { seen.push(['shutdown', who]); return { ok: true }; },
    restartReadiness: () => ({ ok: true }),
    shutdownReadiness: () => ({}),
  });
  await call(service, 'POST', '/api/restart', { body: {}, extraHeaders: { host: 'localhost:4123', 'user-agent': 'Mozilla/5.0' } });
  await call(service, 'POST', '/api/shutdown', { body: { confirm: true }, extraHeaders: { host: 'localhost:4123', 'user-agent': 'Mozilla/5.0' } });
  assert.deepEqual(seen, [
    ['restart', { by: 'operator', via: 'api', origin: 'local', remoteUser: null }, false],
    ['shutdown', { by: 'operator', via: 'api', origin: 'local', remoteUser: null }],
  ]);
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 8 — the accounts surface: the breaker's clearance
 * verb, and the view fields the dashboard (phase 15) reads
 * ------------------------------------------------------------------ */

test('POST /api/accounts/:id/clear-retired: behind --allow-accounts, 404 for an unknown id, and attributed to the request', async () => {
  const cleared: unknown[][] = [];
  const view = { id: 'work', kind: 'token', builtIn: false, credential: 'abcd', entitlement: { state: 'unknown', via: 'credential' } };
  const service = fakeService({
    flags: { allowWrites: true, allowRun: true, allowAccounts: true, maxSessions: 4 },
    clearRetiredAccount: async (id: string, actor: unknown) => { cleared.push([id, actor]); return id === 'work' ? view : undefined; },
  });
  const out = await call(service, 'POST', '/api/accounts/work/clear-retired', {
    body: {},
    extraHeaders: { host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605' },
  });
  assert.equal(out.status, 200, err(out));
  assert.deepEqual((out.body as { account: unknown }).account, view);
  assert.deepEqual(cleared[0], ['work', { by: 'operator', via: 'api', origin: 'local', remoteUser: null }], 'the clearance names who pressed it');

  const missing = await call(service, 'POST', '/api/accounts/ghost/clear-retired', { body: {}, extraHeaders: { host: '127.0.0.1:4123' } });
  assert.equal(missing.status, 404);
  const malformed = await call(service, 'POST', '/api/accounts/NOT%20AN%20ID/clear-retired', { body: {}, extraHeaders: { host: '127.0.0.1:4123' } });
  assert.equal(malformed.status, 400);

  // A console started without --allow-accounts refuses: widening what every
  // future run may spend is a registration-class act.
  const readOnly = fakeService({
    flags: { allowWrites: true, allowRun: true, allowAccounts: false, maxSessions: 4 },
    clearRetiredAccount: async () => view,
  });
  const refused = await call(readOnly, 'POST', '/api/accounts/work/clear-retired', { body: {}, extraHeaders: { host: '127.0.0.1:4123' } });
  assert.equal(refused.status, 403);
  assert.match(err(refused), /--allow-accounts/);
});

test('GET /api/accounts hands the facade\'s views through verbatim — entitlement, the hashed orgId, lastErrorAt and a tombstone included, never a raw id', async () => {
  const views = [
    {
      id: 'default', kind: 'default', builtIn: true, credential: '0123456789abcdef',
      orgId: 'e462cb3c', entitlement: { state: 'retired', via: 'org', reason: 'organization policy blocks this credential', class: 'org-policy' },
      authState: 'unusable', lastErrorAt: '2026-09-14T04:07:18.517Z',
      usage: { buckets: {}, lastErrorAt: '2026-09-14T04:07:18.517Z', error: 'credential was refused' },
    },
    { id: 'support', kind: 'token', builtIn: false, credential: 'fedcba9876543210', entitlement: { state: 'unknown', via: 'none' }, tombstone: { name: 'Support Max', retiredAt: '2026-09-01T00:00:00Z' } },
  ];
  const tombstones = [{ id: 'support', name: 'Support Max', retiredAt: '2026-09-01T00:00:00Z', credential: 'fedcba9876543210', entitlement: { state: 'unknown', via: 'none' } }];
  const service = fakeService({
    flags: { allowWrites: true, allowRun: true, allowAccounts: false, maxSessions: 4 },
    listAccounts: async () => views,
    accountTombstones: () => tombstones,
  });
  const out = await call(service, 'GET', '/api/accounts');
  assert.equal(out.status, 200, err(out));
  const body = out.body as { accounts: typeof views; allowAccounts: boolean; tombstones: typeof tombstones };
  assert.deepEqual(body.accounts, views);
  assert.equal(body.allowAccounts, false);
  assert.deepEqual(body.tombstones, tombstones, 'the removed registrations ride the same read (phase 15)');
  // A service from before the field still answers the list, with no tombstones.
  const older = await call(fakeService({ listAccounts: async () => views }), 'GET', '/api/accounts');
  assert.deepEqual((older.body as { tombstones: unknown[] }).tombstones, []);
  assert.equal(body.accounts[0].usage.fetchedAt, undefined, 'no successful read, no reading time (ACT-4)');
  assert.equal(JSON.stringify(body).includes('-'), true);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(JSON.stringify(body)), false, 'no UUID-shaped orgId reaches the wire');
});

test('POST /api/accounts/:id/probe-entitlement (phase 15): behind --allow-accounts, attributed to the request, 400/404/409 — and through a real facade the one-turn check writes the learned store and the log', async () => {
  const { EventEmitter } = await import('node:events');
  const { Accounts, ProbeInFlightError } = await import('../server/accounts/index.ts');
  const { recent } = await import('../server/log.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-probe-route-'));
  const accounts = new Accounts({
    platform: 'linux', exec: async () => ({ stdout: '' }),
    learnedFile: join(dir, 'learned.json'), instanceId: 'route-test',
    fetchFn: (async () => new Response('nope', { status: 500 })) as typeof fetch,
  });
  let hold = false;
  const spawnFn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const held = hold;
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.271' })}\n`));
      if (held) return;
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.003 })}\n`));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const asked: unknown[] = [];
  const service = fakeService({
    flags: { allowWrites: true, allowRun: true, allowAccounts: true, maxSessions: 4 },
    probeAccountEntitlement: async (id: string, actor: Record<string, unknown>) => {
      asked.push([id, actor]);
      if (!accounts.has(id)) return undefined;
      return accounts.probeEntitlement(id, {
        actor: { ...(actor as { by: string }), door: 'operator', trigger: 'entitlement-probe' },
        spawnFn, cwd: dir, ...(hold ? { timeoutMs: 150 } : {}),
      });
    },
  });
  const browser = { host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605' };
  // A token account: its login state is `unknown` by construction, so no
  // reading of this machine's own credentials can refuse the check under test.
  const { id } = await accounts.addToken('Route Max', 'sk-ant-oat01-routemax000000000000');
  const path = `/api/accounts/${id}/probe-entitlement`;
  try {
    const out = await call(service, 'POST', path, { body: {}, extraHeaders: browser });
    assert.equal(out.status, 200, err(out));
    const body = out.body as { account: { id: string; probe?: { status: string } }; probe: { status: string; count: number; by: string; costUsd?: number }; spent: boolean };
    assert.equal(body.spent, true);
    assert.equal(body.probe.status, 'ok');
    assert.equal(body.probe.by, 'operator');
    assert.equal(body.probe.costUsd, 0.003);
    assert.equal(body.account.probe?.status, 'ok', 'the row the dashboard redraws carries the answer');
    assert.deepEqual(asked[0], [id, { by: 'operator', via: 'api', origin: 'local', remoteUser: null }], 'the request\'s derived actor, never a console literal');

    // Written where every console reads it: the machine-wide learned store…
    const row = Object.values(accounts.learned.snapshot().credentials).find((c) => c.ids.includes(`route-test/${id}`));
    assert.equal(row?.probe?.status, 'ok');
    assert.equal(row?.probe?.count, 1);
    assert.equal(row?.entitlement.state, 'entitled');
    assert.equal(row?.entitlement.by, 'probe');
    // …and on the console's own log, with the actor whole.
    const ran = recent(200).findLast((line) => line.event === 'accounts.entitlement-probe.ran' && line.data?.account === id);
    assert.equal(ran?.data?.via, 'api');
    assert.equal(ran?.data?.door, 'operator');
    assert.equal(ran?.data?.status, 'ok');

    // One at a time: a press while a check of the same account runs is 409.
    hold = true;
    const first = call(service, 'POST', path, { body: {}, extraHeaders: browser });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await call(service, 'POST', path, { body: {}, extraHeaders: browser });
    assert.equal(busy.status, 409, err(busy));
    assert.match(err(busy), /already running/);
    assert.equal((await first).status, 200);
    hold = false;

    const missing = await call(service, 'POST', '/api/accounts/ghost/probe-entitlement', { body: {}, extraHeaders: browser });
    assert.equal(missing.status, 404);
    const malformed = await call(service, 'POST', '/api/accounts/NOT%20AN%20ID/probe-entitlement', { body: {}, extraHeaders: browser });
    assert.equal(malformed.status, 400);
    assert.ok(ProbeInFlightError, 'the refusal the 409 maps is the facade\'s own');

    // Registration-class: without --allow-accounts the check is refused before anything runs.
    const readOnly = fakeService({
      flags: { allowWrites: true, allowRun: true, allowAccounts: false, maxSessions: 4 },
      probeAccountEntitlement: async () => { throw new Error('must not be reached'); },
    });
    const refused = await call(readOnly, 'POST', path, { body: {}, extraHeaders: browser });
    assert.equal(refused.status, 403);
    assert.match(err(refused), /--allow-accounts/);
  } finally {
    await accounts.remove(id);
    accounts.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The relay's transport and the answer verb (zero-touch-console phase 14)
 * ------------------------------------------------------------------ */

test('POST /hooks/permission-request authenticates on the per-run token ALONE — no console header, no origin; a bad token is 401, a proxied call 403 before the token is read', async () => {
  const { Approvals } = await import('../server/runner/approvals.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-permission-hook-'));
  try {
    const approvals = new Approvals(() => {}, join(dir, 'pending.json'));
    const token = approvals.arm('r1');
    const seen: { body: Record<string, unknown>; runId: unknown }[] = [];
    const service = fakeService({
      approvals,
      decidePermissionRequest: async (body: Record<string, unknown>, runId: unknown) => {
        seen.push({ body, runId });
        return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
      },
    });
    // A `claude` child sends neither the console header nor an origin: the token is the credential.
    const ok = await call(service, 'POST', '/hooks/permission-request', {
      header: false, body: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      extraHeaders: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].runId, 'r1', 'the token says WHICH run asked');
    assert.equal(seen[0].body.tool_name, 'Bash');

    const bad = await call(service, 'POST', '/hooks/permission-request', {
      header: true, extraHeaders: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    assert.equal(bad.status, 401, 'the console header does not stand in for the token');
    const none = await call(service, 'POST', '/hooks/permission-request', { header: true });
    assert.equal(none.status, 401);
    assert.equal((await call(service, 'GET', '/hooks/permission-request', { header: false })).status, 405);
    assert.equal(seen.length, 1, 'nothing unauthenticated reached the decision');

    // In through the remote proxy — a Serve handler on the wrong console must not expose this POST.
    const remote = fakeService({
      approvals,
      flags: { allowWrites: true, allowRun: true, maxSessions: 4, remoteHosts: ['console.example'], remoteUsers: ['me@example.com'] },
      decidePermissionRequest: async () => { throw new Error('must not be reached'); },
    });
    const proxied = await call(remote, 'POST', '/hooks/permission-request', {
      header: false,
      extraHeaders: { authorization: `Bearer ${token}`, host: 'console.example', 'tailscale-user-login': 'me@example.com' },
    });
    assert.equal(proxied.status, 403);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/run/:slug/answer takes a person\'s pick on a relayed question — behind --allow-run, the actor derived, 409 when the window closed', async () => {
  const picks: { slug: string; approvalId: string; picks: unknown; by: string }[] = [];
  const service = fakeService({
    answerQuestion: (slug: string, approvalId: string, chosen: unknown, by: string) => {
      picks.push({ slug, approvalId, picks: chosen, by });
      return approvalId === 'gone'
        ? { ok: false, status: 404, error: 'no question is waiting under that id' }
        : { ok: true, answered: ['choice:which-colour'], remaining: 0 };
    },
  });
  const ok = await call(service, 'POST', '/api/run/demo/answer', { body: { approvalId: 'card-1', key: 'choice:which-colour', label: 'Red', by: 'phone' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(picks[0], { slug: 'demo', approvalId: 'card-1', picks: [{ label: 'Red', key: 'choice:which-colour' }], by: 'phone' });
  const many = await call(service, 'POST', '/api/run/demo/answer', {
    body: { approvalId: 'card-1', answers: [{ key: 'a', label: 'x' }, { question: 'Why?', label: 'y' }] },
  });
  assert.equal(many.status, 200);
  assert.deepEqual(picks[1].picks, [{ label: 'x', key: 'a' }, { label: 'y', question: 'Why?' }]);
  assert.equal((await call(service, 'POST', '/api/run/demo/answer', { body: { approvalId: 'gone', key: 'a', label: 'x' } })).status, 409);
  assert.equal((await call(service, 'POST', '/api/run/demo/answer', { body: { key: 'a', label: 'x' } })).status, 400, 'no card named');
  assert.equal((await call(service, 'POST', '/api/run/demo/answer', { body: { approvalId: 'card-1' } })).status, 400, 'no pick');
  const locked = fakeService({ flags: { allowWrites: true, allowRun: false, maxSessions: 4 }, answerQuestion: () => { throw new Error('must not be reached'); } });
  assert.equal((await call(locked, 'POST', '/api/run/demo/answer', { body: { approvalId: 'card-1', key: 'a', label: 'x' } })).status, 403);
});
