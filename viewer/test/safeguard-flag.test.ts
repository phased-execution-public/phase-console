/**
 * An API safeguard false positive is not the model declining the task
 * (control-tower phase 111, #177).
 *
 * Phase 33, attempt 2, 2026-09-30T22:22:13Z: a session doing routine work had
 * its next call answered with the API's safeguard banner — "Opus 5.5 (1M
 * context)'s safeguards flagged this message … This sometimes happens with
 * safe, normal conversations … Try rephrasing the request in a new session or
 * change your model … Details: [reasoning_extraction] · Request ID: req_… ".
 * The result was `isError: true, terminalReason: api_error` with the stop
 * reason `refusal`, and the classifier's refusal arm read it as "the model
 * declined the task": `needs-human`, the phase halted, the run parked for a
 * person — for twenty hours, until one press of Retry boarded a fresh session
 * that went on normally.
 *
 *   SG-1  the banner classifies as `safeguard-flag`, apart from a refusal of
 *         the task, keeping the classifier token, the request id and the
 *         message id; a plain refusal still asks a person, and a session that
 *         merely QUOTES the banner in a successful turn is still a success;
 *   SG-2  the first remedy boards the phase FRESH — a new session with the
 *         resume brief, never `--resume` of the flagged conversation, which
 *         would re-send the flagged message — and the second a fresh session
 *         again under `pinned`, or the next model under `ladder`;
 *   SG-3  only then a person, worded "the API's safeguards flagged the
 *         session (a false positive is likely)" with what was tried, and the
 *         journal carries the request id to report.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classify } from '../server/runner/errors.ts';
import { Runner } from '../server/runner/runner.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

const PINNED = 'claude-opus-5-5[1m]';

/** The banner, as the phase-33 log carries it (split so no scanner reads it as this file's own words). */
const BANNER = [
  'API Error: Opus 5.5 (1M context)\'s safeguards flagged this message (https://www.anthropic.com/legal/aup). ',
  'This sometimes happens with safe, normal conversations. Claude Code can\'t respond to this message with ',
  'Opus 5.5 (1M context). Try rephrasing the request in a new session or change your model. ',
  'Details: `[reasoning_extraction]` · Request ID: req_011CfaQPqAENfhFS8hCyk2bB · Message ID: msg_011CfaQPrSNJw96qMCDZsXeu',
].join('');

const flaggedSignal = () => ({
  subtype: 'success', code: 0, isError: true, terminalReason: 'api_error', stopReason: 'refusal', text: BANNER,
  turns: 14, costUsd: 3.1,
});

/* ------------------------------------------------------------------ *
 * SG-1 — the classifier
 * ------------------------------------------------------------------ */

test('SG-1: the safeguard banner is a safeguard-flag, apart from a refusal, keeping its classifier and ids', () => {
  const d = classify(flaggedSignal());
  assert.equal(d.kind, 'safeguard-flag');
  if (d.kind !== 'safeguard-flag') return;
  assert.equal(d.classifier, 'reasoning_extraction');
  assert.equal(d.requestId, 'req_011CfaQPqAENfhFS8hCyk2bB');
  assert.equal(d.messageId, 'msg_011CfaQPrSNJw96qMCDZsXeu');
  assert.match(d.reason, /safeguards flagged/);
  assert.doesNotMatch(d.reason, /declined/);
});

test('SG-1: the banner on the API-error channel alone is enough — the stop reason need not say refusal', () => {
  const d = classify({ subtype: 'error_during_execution', code: 1, isError: true, apiText: BANNER, text: '', turns: 3, costUsd: 0.4 });
  assert.equal(d.kind, 'safeguard-flag');
});

test('SG-1: a refusal with no banner still asks a person; a success that quotes the banner is still a success', () => {
  const refusal = classify({ subtype: 'success', code: 0, isError: true, stopReason: 'refusal', text: 'I can\'t help with that.', turns: 2, costUsd: 0.1 });
  assert.equal(refusal.kind, 'needs-human');
  assert.equal(refusal.kind === 'needs-human' && refusal.reason, 'the model declined the task');
  const narrated = classify({ subtype: 'success', code: 0, text: `Fixed #177. The banner reads: ${BANNER}`, turns: 30, costUsd: 9 });
  assert.equal(narrated.kind, 'ok', 'a session narrating the banner did its work');
});

/* ------------------------------------------------------------------ *
 * SG-2 / SG-3 — the ladder the runner climbs
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-safeguard-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"; mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done"; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(stub, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

function outcome(n: number, partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: `sess-${n}`, costUsd: 0.5, turns: 6, resultText: 'done', durationMs: 10, argv: [], ...partial,
  };
}

/** A spawn whose first `flags` sessions are flagged, and the rest finish the phase. */
function flagging(r: Repo, flags: number, seen: SpawnRequest[]): SpawnFn {
  return async (request) => {
    seen.push(request);
    if (seen.length <= flags) return outcome(seen.length, { signal: flaggedSignal(), costUsd: 3.1, turns: 14 });
    r.markDone();
    return outcome(seen.length);
  };
}

function runner(r: Repo, spawn: SpawnFn) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

test('SG-2: the first remedy boards FRESH with the resume brief — never --resume of the flagged conversation', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, flagging(r, 1, seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned' });
    await instance.wait();
    assert.equal(seen.length, 2, 'one flagged session, one fresh one that finished');
    assert.equal(seen[1].resume, undefined, 'a new session: resuming re-sends the flagged message');
    assert.notEqual(seen[1].sessionId, 'sess-1');
    assert.match(seen[1].prompt, /safeguards flagged/, 'the resume brief says why it is fresh');
    assert.equal(seen[1].model, PINNED);
    assert.equal(instance.current()!.phases['1'].status, 'done');
    const flags = journalled(events, 'phase.safeguard-flag');
    assert.equal(flags.length, 1);
    assert.equal(flags[0].requestId, 'req_011CfaQPqAENfhFS8hCyk2bB', 'the journal carries the request id to report');
    assert.equal(flags[0].classifier, 'reasoning_extraction');
    assert.equal(flags[0].remedy, 'fresh-session');
    assert.equal(journalled(events, 'phase.needs-human').length, 0, 'nobody was asked');
  } finally { r.cleanup(); }
});

test('SG-2: under `ladder` the second remedy is the next model, fresh', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, flagging(r, 2, seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'ladder' });
    await instance.wait();
    assert.equal(seen.length, 3);
    assert.equal(seen[1].model, PINNED, 'the first remedy keeps the model');
    assert.equal(seen[2].model, 'sonnet', 'the second moves to the next one');
    assert.equal(seen[2].resume, undefined);
    assert.deepEqual(journalled(events, 'phase.safeguard-flag').map((f) => f.remedy), ['fresh-session', 'switch-model']);
    assert.equal(instance.current()!.phases['1'].status, 'done');
  } finally { r.cleanup(); }
});

test('SG-3: under `pinned` the second remedy is a fresh session again, and the third flag asks a person, saying what was tried', async () => {
  const r = repo();
  const seen: SpawnRequest[] = [];
  const { instance, events } = runner(r, flagging(r, 99, seen));
  try {
    await instance.start({ slug: 'demo', root: r.root, model: PINNED, modelPolicy: 'pinned' });
    await instance.wait();
    assert.equal(seen.length, 3, 'three sessions, then a person');
    assert.ok(seen.every((request) => request.model === PINNED), 'pinned: never another model');
    assert.ok(seen.slice(1).every((request) => request.resume === undefined), 'every remedy a new session');
    assert.deepEqual(journalled(events, 'phase.safeguard-flag').map((f) => f.remedy), ['fresh-session', 'fresh-session', 'needs-human']);
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'parked');
    assert.match(record.note ?? '', /^the API's safeguards flagged the session \(a false positive is likely\)/);
    assert.match(record.note ?? '', /two fresh sessions/);
    assert.match(record.note ?? '', /req_011CfaQPqAENfhFS8hCyk2bB/);
    assert.doesNotMatch(record.note ?? '', /declined/);
  } finally { r.cleanup(); }
});
