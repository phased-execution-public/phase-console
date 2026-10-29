/**
 * A decision on Your turn is a real decision (2026-10-20, the owner on two hub
 * cards: a stopped phase's errand that said "read the acts the session named in
 * its handoff" with one way on, and a branch conflict with one way on and no box
 * for a comment).
 *
 *   TD-1  An errand that names a step draws THAT step — its title, its guide's
 *         numbered steps (never a pointer to the handoff), its summary, and its
 *         own options, each answered through the errand's own verb with the
 *         choice — whatever became of the step itself.
 *   TD-2  Every open decision offers at least two ways on, the last one
 *         *Hand it to the AI*; a conflict says what conflicts and how it can
 *         end in numbered steps; a person's errand with no step names what the
 *         phase asked for instead of the handoff.
 *   TD-3  The errand's answer carries the choice: the phase boards again told
 *         which option the person chose, and their note.
 *   TD-4  *Hand it to the AI* goes where the item goes: a session's decision is
 *         answered "decide it yourself" with the note, a stopped phase's
 *         errand resumes its session with it, and an item the console builds
 *         is settled as handed over and its run is told.
 *   TD-5  A comment reaches the AI: `POST /api/turn/:id/note` pins it on the
 *         item's phase, and leaves the item open.
 *   TD-6  A choice only a person may make — a gate's Approve, whose login a
 *         run goes on with — offers no hand-off, and the route refuses one.
 *   TD-7  Without `--allow-run` an errand's options and a hand-off of an item
 *         the console builds are drawn off with the run's flag, and the route
 *         refuses that hand-off as the run's own verbs do (403); a session's
 *         decision is still handed over, as its own answer is taken.
 *   TD-8  A plan's own decision has no session to decide it: *Hand it to the
 *         AI* goes with the option the plan recommends (the owner's ruling),
 *         so the plan's answer file gains its line and the card passes; one
 *         that recommends nothing offers no hand-off, and the route refuses.
 */
import './state-sandbox.ts';
import { readStoredRun } from '../server/runner/state.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { invalidate } from '../server/engine.ts';
import { buildInbox } from '../server/inbox.ts';
import { turnView } from '../server/turn/index.ts';
import { HAND_OFF_OPTION_ID } from '../shared/turn-model.js';
import { loadRun, newRun, phaseRecord, saveRun, type RunState } from '../server/runner/state.ts';
import { Service } from '../server/service.ts';

const NOW = Date.parse('2026-10-20T08:00:00.000Z');
const AT = '2026-10-20T00:12:18.094Z';

const GUIDE = {
  lang: 'en', dir: 'ltr',
  summary: 'The public chart feed is correct but every history read takes 6 to 12 seconds, so the checker fails.',
  steps: [
    { text: 'Read the evidence: the verdict, both checker runs, the timings and the cause.', code: 'open docs/handoffs/alpha/releases/release-a-live.md' },
    { text: 'Choose fix to add one feed-backend fix release before Release B.', expect: 'the plan gains one phase' },
    { text: 'Or choose accept to go on to Release B with the slow feed.', expect: 'Phase 13 is waived' },
  ],
};

const DECISION = {
  id: 'step-d1', kind: 'decision', title: 'Add a feed-backend fix release before Release B? The live chart feed is correct but takes 6-12 s per load',
  where: 'any', slug: 'alpha', phase: 13, runId: 'r1', birth: 'session', state: 'dismissed', declaredAt: AT, at: AT,
  opened: 0, attempts: 0, why: 'decision', whySource: 'declared', proofType: 'answer', guide: GUIDE,
  options: [
    { id: 'fix', label: 'Add the fix release', consequence: 'one more phase, then Release B', recommended: true },
    { id: 'accept', label: 'Go on to Release B', consequence: 'Release B ships on the slow feed' },
  ],
  waiters: [{ slug: 'alpha', phase: 13, runId: 'r1' }], source: { kind: 'declaration' },
};

/** A run parked on phase 13's errand, which names the session's decision — closed since. */
function errandFacts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flags: { allowRun: true },
    humanSteps: [],
    runs: [{
      id: 'r1', slug: 'alpha', status: 'running', updatedAt: AT,
      phases: { 13: { phase: 13, status: 'parked', declared: { status: 'needs-human', needs: 'human-acts', reason: 'the feed is slow', at: AT, step: { id: 'step-d1', kind: 'decision' } } } },
      recoveries: {
        13: {
          errand: {
            phase: 13, situation: 'blocked-declared:human-acts', tried: [], at: AT, stepId: 'step-d1',
            need: 'Make a decision: Add a feed-backend fix release before Release B? The live chart feed is….',
            how: 'From any device. Choose one of the options and send your decision.',
          },
        },
      },
    }],
    plans: [{ slug: 'alpha', closed: false, phases: [] }],
    ...extra,
  };
}

const itemsOf = (answer: ReturnType<typeof turnView>) => Object.values(answer.groups).flat();

test('TD-1: an errand that names a step draws that step — its words, its guide, its own options through the errand', () => {
  const inbox = buildInbox(errandFacts() as never, NOW, { all: true });
  const answer = turnView(inbox, { steps: [DECISION] as never, now: NOW, edition: 'pro' });
  const item = itemsOf(answer).find((one) => one.source === 'errand' && one.phase === 13);
  assert.ok(item, 'the errand is an item');
  assert.equal(item!.record, 'projected', 'still the errand — the step itself is closed');
  assert.match(item!.title, /^Add a feed-backend fix release before Release B\?/);
  assert.equal(item!.stepsFrom, 'guide');
  assert.deepEqual(item!.steps.map((step) => step.text), GUIDE.steps.map((step) => step.text));
  for (const step of item!.steps) assert.doesNotMatch(step.text, /handoff/i);
  assert.equal(item!.step?.guide?.summary, GUIDE.summary, 'the card shows the summary the session wrote');

  const ids = (item!.options ?? []).map((option) => option.id);
  assert.deepEqual(ids, ['fix', 'accept', HAND_OFF_OPTION_ID]);
  const fix = item!.options!.find((option) => option.id === 'fix')!;
  assert.equal(fix.verb.endpoint, '/api/run/alpha/phase/13/errand-answered');
  assert.deepEqual(fix.verb.body, { choice: 'fix', expectRunId: 'r1' });
  assert.equal(fix.says?.field, 'note');
  assert.equal(fix.recommended, true);
});

test('TD-2: every open decision offers two ways at least — the last one Hand it to the AI', () => {
  // A conflict nothing can serialize: the branches belong to no run this console drives.
  const conflict = errandFacts({
    runs: [],
    git: [{ slug: 'alpha', branch: 'pe/alpha', isolation: 'queue', radar: [{ a: 'pe/x', b: 'pe/y', state: 'conflicted', files: ['docs/plans/x.md'] }] }],
  });
  const conflicted = itemsOf(turnView(buildInbox(conflict as never, NOW, { all: true }), { steps: [], now: NOW, edition: 'pro' }))
    .find((one) => one.source === 'conflict');
  assert.ok(conflicted, 'the conflict is an item');
  assert.deepEqual(conflicted!.options!.map((option) => option.id), ['leave', HAND_OFF_OPTION_ID]);
  assert.ok(conflicted!.steps.length >= 2, 'numbered steps, not one paragraph');
  assert.match(conflicted!.steps[0]!.text, /docs\/plans\/x\.md/);
  const hand = conflicted!.options!.at(-1)!;
  assert.equal(hand.verb.endpoint, `/api/turn/${encodeURIComponent(conflicted!.item)}/hand-off`);
  assert.equal(hand.says?.field, 'note');

  // A person's errand with no step behind it names what the phase asked for — never the handoff.
  const bare = errandFacts();
  (bare.runs as { recoveries: Record<string, { errand: Record<string, unknown> }> }[])[0]!.recoveries['13']!.errand.stepId = undefined;
  const errand = itemsOf(turnView(buildInbox(bare as never, NOW, { all: true }), { steps: [], now: NOW, edition: 'pro' }))
    .find((one) => one.source === 'errand');
  assert.ok(errand, 'the errand is an item');
  assert.deepEqual(errand!.options!.map((option) => option.id), ['errand-answered', HAND_OFF_OPTION_ID]);
  for (const step of errand!.steps) assert.doesNotMatch(step.text, /handoff/i);
  assert.match(errand!.steps[0]!.text, /the feed is slow/, 'what the phase asked for, in its own words');

  // A session's open decision: its own options, then the hand-off.
  const open = { ...DECISION, id: 'step-d2', state: 'notified' };
  const ledger = itemsOf(turnView(buildInbox(errandFacts({ runs: [], humanSteps: [open] }) as never, NOW, { all: true }), {
    steps: [open] as never, now: NOW, edition: 'pro',
  })).find((one) => one.item === 'step-d2');
  assert.ok(ledger, 'the decision is an item');
  assert.deepEqual(ledger!.options!.map((option) => option.id), ['fix', 'accept', HAND_OFF_OPTION_ID]);
});

/* ------------------------------------------------------------------ *
 * The service: the presses
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-10-20
status: active
phases: 2
handoffs: docs/handoffs/alpha/
memory: project_alpha
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | release | — | — | app | it ships |
| 2 | after | 1 | — | app | it works |

## Phases

### Phase 1 — release
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — after
- **Size:** S
- **Verification:** \`true\`
`;

function library(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-decisions-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function open(t: { after(fn: () => void): void }, root: string, allowRun = true): Service {
  invalidate();
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  t.after(() => svc.close());
  return svc;
}

/** The resume doors, stubbed — what each was asked is the evidence. */
function stubPress(svc: Service, root: string, state: RunState): { phase: number; instruction?: string }[] {
  const pressed: { phase: number; instruction?: string }[] = [];
  const svcAny = svc as never as Record<string, unknown>;
  svcAny.recoverPhase = async (_slug: string, phase: number, _mode: string, opts: { instruction?: string }) => {
    pressed.push({ phase, instruction: opts?.instruction });
    return loadRun(root, 'alpha', state.id, null)!;
  };
  svcAny.startRun = async (_slug: string, options: { reboard?: { phase: number; instruction?: string }[] }) => {
    pressed.push({ phase: options.reboard?.[0]?.phase ?? 0, instruction: options.reboard?.[0]?.instruction });
    return loadRun(root, 'alpha', state.id, null)!;
  };
  svcAny.continueAfterPress = () => {};
  return pressed;
}

/** Phase 1 parked on a session's decision, its errand naming it — and the decision closed since. */
function parkedOnClosedDecision(svc: Service, root: string): { state: RunState; stepId: string } {
  const state = newRun({ slug: 'alpha', root });
  const raised = svc.raiseTurn({
    slug: 'alpha', phase: 1, birth: 'session', runId: state.id, sessionId: 'sess-1',
    step: {
      kind: 'decision', title: 'Add a feed-backend fix release before Release B?',
      options: [{ id: 'fix', label: 'Add the fix release' }, { id: 'accept', label: 'Go on to Release B' }], recommended: 'fix',
    },
  });
  assert.ok(raised && !('refused' in raised), JSON.stringify(raised));
  const moved = svc.humanStepsNow().move(raised.id, 'dismissed', { by: 'console', verb: 'dismiss', note: 'the run was resolved' });
  assert.ok(!('refused' in moved), JSON.stringify(moved));
  const at = new Date(Date.now() - 60_000).toISOString();
  state.status = 'parked';
  state.halt = { at, reason: 'phase 1 needs a person', phase: 1, kind: 'needs-human' };
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.sessionId = 'sess-1';
  record.resumeSessionId = 'sess-1';
  record.endedAt = at;
  record.declared = { status: 'needs-human', needs: 'human-acts', reason: 'the feed is slow', at, step: { id: raised.id, kind: 'decision' } } as never;
  state.recoveries = {
    '1': {
      attempts: 0, lastAt: at,
      errand: { phase: 1, situation: 'blocked-declared:human-acts', tried: [], need: `Make a decision: ${raised.title}`, how: 'Choose one.', at, stepId: raised.id },
    },
  } as never;
  saveRun(state);
  return { state, stepId: raised.id };
}

type Captured = { status: number; body: Record<string, unknown> };

async function post(svc: Service, path: string, body: unknown): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('TD-3: the errand’s answer carries the choice — the phase boards again told which option, and the note', async (t) => {
  const root = library(t);
  const svc = open(t, root);
  const { state } = parkedOnClosedDecision(svc, root);
  const pressed = stubPress(svc, root, state);

  const answered = await post(svc, '/api/run/alpha/phase/1/errand-answered', {
    choice: 'fix', note: 'cache the symbol list too', expectRunId: state.id,
  });
  assert.ok(answered.status < 300, JSON.stringify(answered.body));
  assert.equal(pressed.length, 1, 'the phase boards again');
  assert.match(pressed[0]!.instruction ?? '', /Add the fix release/);
  assert.match(pressed[0]!.instruction ?? '', /cache the symbol list too/);
});

test('TD-4: Hand it to the AI goes where the item goes', async (t) => {
  const root = library(t);
  const svc = open(t, root);

  // A stopped phase's errand: its session is resumed, the acts — the decision — its own now.
  const { state } = parkedOnClosedDecision(svc, root);
  const pressed = stubPress(svc, root, state);
  const errandId = (await svc.turnAnswer()).groups.decide.find((one) => one.source === 'errand')?.item;
  assert.ok(errandId, 'the errand asks');
  const handed = await post(svc, `/api/turn/${encodeURIComponent(errandId!)}/hand-off`, { note: 'pick the safer one' });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(pressed.length, 1, 'the phase is resumed');
  assert.match(pressed[0]!.instruction ?? '', /pick the safer one/);

  // A session's open decision: answered — decide it yourself — with the note.
  const second = svc.raiseTurn({
    slug: 'alpha', phase: 2, birth: 'session', runId: state.id, sessionId: 'sess-2',
    step: { kind: 'decision', title: 'Which cache?', options: [{ id: 'redis', label: 'Redis' }, { id: 'memory', label: 'In memory' }] },
  });
  assert.ok(second && !('refused' in second), JSON.stringify(second));
  const decided = await post(svc, `/api/turn/${encodeURIComponent(second.id)}/hand-off`, { note: 'you know the load best' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const after = svc.humanStepsNow().get(second.id);
  assert.notEqual(after?.state, 'notified', 'the decision is no longer the person’s');
  assert.match(after?.answer?.note ?? '', /you know the load best/);
  assert.match(after?.answer?.note ?? '', /yourself/);
});

test('TD-5: a comment reaches the AI — pinned on the item’s phase — and the item stays open', async (t) => {
  const root = library(t);
  const svc = open(t, root);
  const { state } = parkedOnClosedDecision(svc, root);
  const errandId = (await svc.turnAnswer()).groups.decide.find((one) => one.source === 'errand')?.item;
  assert.ok(errandId, 'the errand asks');

  const noted = await post(svc, `/api/turn/${encodeURIComponent(errandId!)}/note`, { text: 'the CFO prefers fix' });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  const notes = (readStoredRun(root, 'alpha', state.id)!).notes ?? [];
  const note = notes.find((one) => one.id === (noted.body.told as { note: string }).note);
  assert.ok(note, 'the note is on the run');
  assert.equal(note!.pinned, true);
  assert.equal(note!.phase, 1);
  assert.match(note!.text, /the CFO prefers fix/);
  assert.equal((await svc.turnAnswer()).groups.decide.some((one) => one.item === errandId), true, 'a comment settles nothing');

  const empty = await post(svc, `/api/turn/${encodeURIComponent(errandId!)}/note`, { text: '  ' });
  assert.equal(empty.status, 400);
});

test('TD-6: a choice only a person may make is never handed over — no option for it, and the press is refused', async (t) => {
  const root = library(t);
  const svc = open(t, root);
  const state = newRun({ slug: 'alpha', root });
  saveRun(state);
  // An item whose proof reads a gate's row is opened by that gate's Approve alone.
  const gated = svc.recordHumanStep({
    slug: 'alpha', phase: 1, birth: 'plan', runId: state.id,
    step: {
      kind: 'decision', title: "Approve the release on Phase 2's Gate card", why: 'decision',
      proof: 'cmd:"grep -q \'| 2 |\' docs/handoffs/alpha/gate-status.md"',
      options: [{ id: 'yes', label: 'Approved' }],
    },
  });
  assert.ok(gated && !('refused' in gated), JSON.stringify(gated));
  const id = (gated as { id: string }).id;
  const item = Object.values((await svc.turnAnswer()).groups).flat().find((one) => one.item === id);
  assert.ok(item, 'the item is on Your turn');
  assert.ok(!item!.options?.some((option) => option.id === HAND_OFF_OPTION_ID), JSON.stringify(item!.options));
  const refused = await post(svc, `/api/turn/${encodeURIComponent(id)}/hand-off`, { note: 'you decide' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(String(refused.body.error), /Only you can make this choice/);
  assert.equal(svc.humanStepsNow().get(id)?.answer, undefined, 'nothing was answered');
});

test('TD-7: without --allow-run a run press and a hand-off through a run are off, and refused; a session\u2019s decision is not', async (t) => {
  // The fold, told the console may not drive a run.
  const inbox = buildInbox(errandFacts({ flags: { allowRun: false } }) as never, NOW, { all: true });
  const item = itemsOf(turnView(inbox, { steps: [DECISION] as never, now: NOW, edition: 'pro', allowRun: false }))
    .find((one) => one.source === 'errand' && one.phase === 13)!;
  assert.ok(item, 'the errand is an item');
  assert.deepEqual(item.options!.map((option) => [option.id, option.flag]), [['fix', 'run'], ['accept', 'run'], [HAND_OFF_OPTION_ID, 'run']]);
  const open2 = { ...DECISION, id: 'step-d3', state: 'notified' };
  const ledger = itemsOf(turnView(buildInbox(errandFacts({ runs: [], humanSteps: [open2], flags: { allowRun: false } }) as never, NOW, { all: true }), {
    steps: [open2] as never, now: NOW, edition: 'pro', allowRun: false,
  })).find((one) => one.item === 'step-d3')!;
  assert.equal(ledger.options!.find((option) => option.id === HAND_OFF_OPTION_ID)?.flag, undefined, 'a session\u2019s decision is answered as its own card is');

  // The route.
  const root = library(t);
  const svc = open(t, root, false);
  parkedOnClosedDecision(svc, root);
  const errandId = (await svc.turnAnswer()).groups.decide.find((one) => one.source === 'errand')?.item;
  assert.ok(errandId, 'the errand asks');
  const refused = await post(svc, `/api/turn/${encodeURIComponent(errandId!)}/hand-off`, { note: 'you decide' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.match(String(refused.body.error), /--allow-run/);
});

test('TD-8: a plan\u2019s own decision handed to the AI goes with its recommendation; one that recommends none is not handed over', async (t) => {
  const root = library(t);
  const svc = open(t, root);
  const answers = join(root, 'docs', 'handoffs', 'alpha', 'owner-answers.md');
  writeFileSync(answers, '## Answers\n');
  const raise = (key: string, recommended?: string) => {
    const raised = svc.raiseTurn({
      slug: 'alpha', phase: 0, birth: 'plan',
      step: {
        kind: 'decision', title: `Decide ${key}`, why: 'decision', where: 'any',
        proof: `cmd:"grep -Eq '^${key}: *[a-z]' ${answers}"`,
        options: [{ id: 'deprecate', label: 'Deprecate with migrations' }, { id: 'keep-and-wire', label: 'Keep and wire' }],
        ...(recommended ? { recommended } : {}), unblocks: [1],
      },
    });
    assert.ok(raised && !('refused' in raised), JSON.stringify(raised));
    return raised;
  };
  const recommends = raise('deprecations', 'deprecate');
  const silent = raise('clock-migration');
  const items = Object.values((await svc.turnAnswer()).groups).flat();
  const offered = items.find((one) => one.item === recommends.id)?.options ?? [];
  const handOff = offered.find((option) => option.id === HAND_OFF_OPTION_ID);
  assert.ok(handOff, `the decision offers the hand-off: ${JSON.stringify(offered.map((one) => one.id))}`);
  assert.match(handOff!.consequence ?? '', /goes with its recommendation, \u201cDeprecate with migrations\u201d; your note goes to Phase 1/);
  assert.ok(!(items.find((one) => one.item === silent.id)?.options ?? []).some((option) => option.id === HAND_OFF_OPTION_ID),
    'a plan decision that recommends nothing is the person\u2019s to make');

  const handed = await post(svc, `/api/turn/${encodeURIComponent(recommends.id)}/hand-off`, { note: 'you know the catalog' });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.how, 'recommended');
  assert.match(readFileSync(answers, 'utf8'), /^deprecations: deprecate$/m, 'the plan\u2019s own line, for its gate to read');
  const after = svc.humanStepsNow().get(recommends.id);
  assert.equal(after?.state, 'proven');
  assert.equal(after?.answer?.option, 'deprecate');
  assert.equal(after?.answer?.note, 'you know the catalog');

  const refused = await post(svc, `/api/turn/${encodeURIComponent(silent.id)}/hand-off`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(svc.humanStepsNow().get(silent.id)?.state === 'proven', false);
});
