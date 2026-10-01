/**
 * Stored triggers: "when X happens, press Y" (control-tower phase 98, #137).
 *
 * Supervising four runs for a day, the watchdog wrote seven polling scripts —
 * resume when paused, steer when a phase boards, retry P43 when P64 is done,
 * bump an entry when it appears — because the console took only "press Y
 * now". Nobody else could see them, they raced the console, and they died with
 * their shell. A trigger is the same correction kept where the console sees it.
 *
 * TR-1: a trigger fires within moments of its event, EXACTLY ONCE for `once`,
 *       and is journalled armed and fired — with the verb's answer.
 * TR-2: it survives a restart between arming and firing; the firing is
 *       written down BEFORE the verb is pressed, so a console that dies in
 *       between never presses it twice.
 * TR-3: it is cancellable, it expires, and `every` fires again — on a state's
 *       edge, not on every write while the state holds.
 * TR-4: its act is AUTOMATIC — a door of its own (`trigger`) the start ceiling
 *       counts, with the armer as `by` and its note as the reason — and
 *       through the real routes it arms, lists, fires on a run already in its
 *       state, and cancels.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { call, scratch, service, tempDir } from './verb-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { TriggerEngine, triggerActor } = await import('../server/triggers.ts');
const { START_DOORS } = await import('../shared/run-lifecycle.js');
const { isAutomatic, pressActor } = await import('../server/actor.ts');
const { StartCeiling } = await import('../server/start-ceiling.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
type RunFacts = import('../server/triggers.ts').RunFacts;
type Actor = import('../server/runner/state.ts').Actor;

const PERSON: Actor = { by: 'mobin', via: 'cli', origin: 'local', remoteUser: null, reason: 'P43 waits on P64' };

/** An engine over a scratch directory, pressing into a list, journalling into a list. */
function engine(dir: string, facts: RunFacts | null = null, now?: () => Date) {
  const pressed: { slug: string; verb: string; body: Record<string, unknown>; actor: Record<string, unknown> }[] = [];
  const journal: { event: string; payload: Record<string, unknown>; phase?: number }[] = [];
  let answer: () => Promise<{ ok: boolean; status: number; error?: string }> = async () => ({ ok: true, status: 200 });
  const box = new TriggerEngine({
    file: (slug) => join(dir, slug, 'triggers.json'),
    press: async (slug, verb, body, actor) => { pressed.push({ slug, verb, body, actor: actor as never }); return answer(); },
    journal: (_slug, event, payload, phase) => { journal.push({ event, payload, ...(phase !== undefined ? { phase } : {}) }); },
    facts: () => facts,
    ...(now ? { now } : {}),
  });
  return { box, pressed, journal, answering: (fn: typeof answer) => { answer = fn; } };
}

test('TR-1: a trigger fires on its event, exactly once for `once`, and is journalled armed and fired with the answer', async () => {
  const dir = tempDir('triggers');
  const { box, pressed, journal } = engine(dir);
  const armed = box.arm('alpha', {
    when: 'phase-done:64', verb: 'retry', body: { phase: 43, addendum: 'verification only' }, note: 'P43 re-verifies after P64',
  }, PERSON);
  assert.equal(armed.ok, true, JSON.stringify(armed));
  const id = armed.ok ? armed.trigger.id : '';
  assert.deepEqual(journal.map((line) => line.event), ['trigger.armed']);
  assert.equal(journal[0]!.payload.by, 'mobin', 'who armed it');
  assert.equal(journal[0]!.payload.reason, 'P43 waits on P64', 'and why');
  assert.equal(journal[0]!.payload.when, 'phase-done:64');

  box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.start', phase: 64 });
  await box.settled();
  assert.equal(pressed.length, 0, 'P64 boarding is not P64 done');

  const started = Date.now();
  box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.done', phase: 64 });
  box.observe({ slug: 'alpha', kind: 'phase', phase: 64, status: 'done' });
  await box.settled();
  assert.ok(Date.now() - started < 1_000, 'within moments of its event');
  assert.equal(pressed.length, 1, 'once — even though two observations of the same event arrived');
  assert.deepEqual(pressed[0]!.body, { phase: 43, addendum: 'verification only' });
  assert.equal(pressed[0]!.verb, 'retry');

  box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.done', phase: 64 });
  await box.settled();
  assert.equal(pressed.length, 1, 'a `once` trigger is spent');

  const fired = journal.find((line) => line.event === 'trigger.fired');
  assert.ok(fired, 'the firing is journalled');
  assert.equal(fired!.payload.id, id);
  assert.equal(fired!.payload.ok, true, 'with the verb\'s answer');
  assert.equal(fired!.payload.status, 200);
  assert.equal(box.list('alpha')[0]!.state, 'fired');
});

test('TR-2: a trigger survives a restart, and a firing is written down before its verb is pressed', async () => {
  const dir = tempDir('triggers-restart');
  const first = engine(dir);
  const armed = first.box.arm('alpha', { when: 'run-paused', verb: 'resume', note: 'take it off the boundary pause' }, PERSON);
  assert.equal(armed.ok, true);
  first.box.close();

  // The console restarted. The run paused while it was up again.
  const second = engine(dir);
  assert.equal(second.box.list('alpha').length, 1, 'the trigger is a file, not a memory');
  second.box.observe({ slug: 'alpha', kind: 'journal', event: 'run.paused' });
  await second.box.settled();
  assert.equal(second.pressed.length, 1, 'armed before the restart, fired after it');
  assert.equal(second.pressed[0]!.verb, 'resume');
  second.box.close();

  const third = engine(dir);
  third.box.observe({ slug: 'alpha', kind: 'journal', event: 'run.paused' });
  await third.box.settled();
  assert.equal(third.pressed.length, 0, 'after another restart it is still spent — exactly once');

  // The console dies DURING the press: the file already says fired.
  const crash = tempDir('triggers-crash');
  const dying = engine(crash);
  dying.box.arm('alpha', { when: 'phase-boarded:7', verb: 'steer', body: { phase: 7, instruction: 'read #134 first' } }, PERSON);
  let onDisk = '';
  dying.answering(async () => {
    onDisk = readFileSync(join(crash, 'alpha', 'triggers.json'), 'utf8');
    throw new Error('the console died mid-press');
  });
  dying.box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.start', phase: 7 });
  await dying.box.settled();
  assert.equal(JSON.parse(onDisk).triggers[0].state, 'fired', 'spent on disk before the verb was pressed');
  const reborn = engine(crash);
  reborn.box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.start', phase: 7 });
  await reborn.box.settled();
  assert.equal(reborn.pressed.length, 0, 'the restarted console does not press it a second time');
  const failed = reborn.box.list('alpha')[0]!.firings.at(-1)!;
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /died mid-press/, 'what happened to the press is on the trigger');
});

test('TR-3: a trigger is cancellable, it expires, and `every` fires on a state\'s edge', async () => {
  const dir = tempDir('triggers-cancel');
  const { box, pressed, journal } = engine(dir);
  const armed = box.arm('alpha', { when: 'entry-queued:43', verb: 'bump', body: { phase: 43 } }, PERSON);
  assert.equal(armed.ok, true);
  const cancelled = box.cancel('alpha', armed.ok ? armed.trigger.id : '', { ...PERSON, reason: 'P43 boarded on its own' });
  assert.equal(cancelled.ok, true);
  const line = journal.find((entry) => entry.event === 'trigger.cancelled');
  assert.equal(line?.payload.by, 'mobin');
  assert.equal(line?.payload.reason, 'P43 boarded on its own');
  box.observe({ slug: 'alpha', kind: 'journal', event: 'phase.queued', phase: 43 });
  await box.settled();
  assert.equal(pressed.length, 0, 'a cancelled trigger fires nothing');
  assert.equal(box.cancel('alpha', armed.ok ? armed.trigger.id : '', PERSON).ok, false, 'and cannot be cancelled twice');

  // An expiry that passes: the clock is the engine's own.
  let clock = Date.parse('2026-09-27T08:00:00Z');
  const timed = engine(tempDir('triggers-expire'), null, () => new Date(clock));
  const soon = timed.box.arm('alpha', { when: 'run-paused', verb: 'resume', expiresAt: '2026-09-27T09:00:00Z' }, PERSON);
  assert.equal(soon.ok, true);
  clock = Date.parse('2026-09-27T09:00:01Z');
  timed.box.evaluate('alpha');
  assert.equal(timed.box.list('alpha')[0]!.state, 'expired');
  assert.ok(timed.journal.some((entry) => entry.event === 'trigger.expired'), 'the expiry is journalled');
  assert.equal(timed.box.arm('alpha', { when: 'run-paused', verb: 'resume', expiresAt: '2026-09-27T08:00:00Z' }, PERSON).ok, false,
    'an expiry already past is refused');

  // `every` on a STATE: once per pause, not once per write of a paused run.
  const facts: RunFacts = { runId: 'r1', status: 'running', phases: {}, queued: [] };
  let now = Date.parse('2026-09-27T10:00:00Z');
  const each = engine(tempDir('triggers-every'), facts, () => new Date(now));
  each.box.arm('alpha', { when: 'run-paused', verb: 'resume', every: true }, PERSON);
  facts.status = 'paused';
  each.box.evaluate('alpha');
  each.box.evaluate('alpha');
  await each.box.settled();
  assert.equal(each.pressed.length, 1, 'three writes of one paused run are one pause');
  facts.status = 'running';
  now += 60_000;
  each.box.evaluate('alpha');
  facts.status = 'paused';
  each.box.evaluate('alpha');
  await each.box.settled();
  assert.equal(each.pressed.length, 2, 'the second pause fires again');
  assert.equal(each.box.list('alpha')[0]!.state, 'armed', '`every` stays armed');

  // Garbage is refused by name, before anything is stored.
  assert.match((box.arm('alpha', { when: 'soonish', verb: 'resume' }, PERSON) as { error: string }).error, /unknown event/);
  assert.match((box.arm('alpha', { when: 'run-paused', verb: 'stop' }, PERSON) as { error: string }).error, /triggerable/);
});

test('TR-4: a trigger\'s act is automatic — its own door, counted by the start ceiling, the armer as by, the note as the why', () => {
  assert.ok((START_DOORS as readonly string[]).includes('trigger'), 'a start door of its own');
  const actor = triggerActor({ id: 'abcdefabcdef', when: 'run-paused', armedBy: PERSON, note: 'keep it moving' });
  assert.equal(actor.door, 'trigger');
  assert.equal(actor.via, 'event', 'something the console observed');
  assert.equal(actor.by, 'mobin', 'attributed to the person who armed it');
  assert.equal(actor.reason, 'keep it moving');
  assert.equal(isAutomatic(actor), true);

  const ceiling = new StartCeiling(() => ({ startsPerHour: 1, usdPerHour: 0 }));
  ceiling.charge(actor, 'alpha');
  const verdict = ceiling.admit(actor);
  assert.equal(verdict.ok, false, 'the second automatic start in the hour is refused — the trigger is counted');
  assert.equal((verdict as { door?: string }).door, 'trigger');
  assert.equal(ceiling.admit(pressActor(PERSON)).ok, true, 'a person\'s press never is');
});

test('TR-4: through the routes a trigger arms, fires at once on a run already in its state, lists, and cancels', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    const run = newRun({ slug: 'alpha', root });
    run.status = 'paused';
    phaseRecord(run, 1).status = 'done';
    saveRun(run);

    const armed = await call(svc, 'POST', '/api/run/alpha/triggers', {
      when: 'run-paused', verb: 'note', body: { text: 'resumed by the trigger' }, note: 'the boundary pause was mine', by: 'mobin',
    });
    assert.equal(armed.status, 200, JSON.stringify(armed.body));
    await (svc as unknown as { triggersSettled(): Promise<void> }).triggersSettled();

    const lines = readFileSync(journalFile(root, 'alpha', run.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const events = lines.map((line) => line.event);
    assert.ok(events.includes('trigger.armed') && events.includes('trigger.fired'), events.join(', '));
    const note = lines.find((line) => line.event === 'run.note');
    assert.ok(note, 'the verb ran through its own door');
    assert.equal(note.data.via, 'event');
    assert.equal(note.data.door, 'trigger');
    assert.equal(note.data.by, 'mobin');
    assert.equal(note.data.reason, 'the boundary pause was mine');

    const listed = await call(svc, 'GET', '/api/run/alpha/triggers');
    assert.equal(listed.body.triggers[0].state, 'fired');
    assert.equal(listed.body.triggers[0].firings[0].ok, true);

    const later = await call(svc, 'POST', '/api/run/alpha/triggers', { when: 'phase-done:3', verb: 'retry', body: { phase: 2 } });
    assert.equal(later.status, 200);
    const cancel = await call(svc, 'POST', `/api/run/alpha/triggers/${later.body.trigger.id}/cancel`, { reason: 'not needed' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.trigger.state, 'cancelled');

    const bad = await call(svc, 'POST', '/api/run/alpha/triggers', { when: 'run-paused', verb: 'settings' });
    assert.equal(bad.status, 400);
  } finally {
    svc.close();
  }
});
