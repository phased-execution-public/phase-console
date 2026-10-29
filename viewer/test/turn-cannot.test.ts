/**
 * *I can't do this* on every item of Your turn (2026-10-20) — the owner's word
 * that an act is not theirs to do, and why: `POST /api/turn/:id/cannot`.
 *
 *   TC-1  An item the console projects (a gate) leaves the open groups for
 *         Done as Not doing, with the reason — and the gate itself stays shut.
 *   TC-2  Its run is told: a pinned note on the item’s phase carries the
 *         reason, which that phase's next session reads at boarding — only on
 *         a console that may run phases (`--allow-run`), as the notes route.
 *   TC-3  A reason is required, and only a person may give one: a session's
 *         door is refused, and nothing is settled either way.
 *   TC-4  A ledger item takes the verb it always had: the step settles as
 *         `cannot`, an errand carrying the reason.
 *   TC-5  (Pro) The supervisor is told too: a chat opened on the item, in the
 *         person’s words, the item itself its chip.
 */
import './state-sandbox.ts';
import { readStoredRun } from '../server/runner/state.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { invalidate } from '../server/engine.ts';
import { sanitiseStep } from '../server/human-steps.ts';
import { newRun, saveRun, type RunState } from '../server/runner/state.ts';
import { Service } from '../server/service.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SLUG = 'tc-release';

const PLAN = `---
slug: ${SLUG}
created: 2026-10-20
status: active
phases: 2
handoffs: docs/handoffs/${SLUG}/
memory: project_${SLUG}
---

# ${SLUG}

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | release | — | — | app | it ships |
| 2 | after | 1 | — | app | it works |

## Phases

### Phase 1 — release *(GATED)*
- **Size:** S
- **Gates (must clear first):** the owner approves the release
- **Gate-check:** manual the owner approves the release
- **Verification:** \`true\`

### Phase 2 — after
- **Size:** S
- **Verification:** \`true\`
`;

function library(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-cannot-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', SLUG), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', `${SLUG}.md`), PLAN);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function open(t: { after(fn: () => void): void }, root: string, allowRun = true): Service {
  invalidate();
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun, scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  t.after(() => svc.close());
  return svc;
}

/** A parked run of the plan, with no loop behind it — where a note lands. */
function storedRun(root: string): RunState {
  const state = newRun({ slug: SLUG, root });
  state.status = 'parked';
  saveRun(state);
  return state;
}

type Captured = { status: number; body: Record<string, unknown> };

/** One POST through the real `handleApi`, as a browser on this machine sends it — or through the door named. */
async function post(svc: Service, path: string, body: unknown, door?: 'session'): Promise<Captured> {
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
  // The router reads the door through `doorOf` — a session's run token, here.
  const reader = svc as unknown as { doorOf?: (req: unknown) => unknown };
  const real = reader.doorOf;
  if (door) reader.doorOf = () => ({ door, label: 'r1', proof: 'run-token' });
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
  try {
    await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  } finally {
    reader.doorOf = real;
  }
  return out;
}

async function until(predicate: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const GATE = `gate:${SLUG}:1::`;
const cannotPath = (id: string) => `/api/turn/${encodeURIComponent(id)}/cannot`;

async function where(svc: Service, id: string) {
  const turn = await svc.turnAnswer();
  for (const [group, items] of Object.entries(turn.groups)) {
    const item = items.find((one) => one.item === id);
    if (item) return { group, item };
  }
  return null;
}

async function gateAsks(svc: Service): Promise<void> {
  assert.ok(await until(async () => (await where(svc, GATE))?.group === 'approve', 15_000), 'the shut gate asks a person');
}

test('TC-1: a projected item goes to Done as Not doing, with the reason; the gate stays shut', async (t) => {
  const root = library(t);
  storedRun(root);
  const svc = open(t, root);
  await gateAsks(svc);

  const reason = 'I cannot reach box #2 from here';
  const pressed = await post(svc, cannotPath(GATE), { reason });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));

  const now = await where(svc, GATE);
  assert.equal(now?.group, 'done', `the item is in ${now?.group ?? 'no group'}`);
  assert.equal(now?.item.personStatus, 'not-doing');
  assert.equal(now?.item.settled?.outcome, 'not-doing');
  assert.match(now?.item.settled?.what ?? '', /I cannot reach box #2 from here/);
  assert.equal((await svc.gateStatus(SLUG, 1))?.clear, false, 'saying you cannot is never approving');
});

test('TC-2: the run is told — a pinned note on the item’s phase carries the reason', async (t) => {
  const root = library(t);
  const run = storedRun(root);
  const svc = open(t, root);
  await gateAsks(svc);

  const pressed = await post(svc, cannotPath(GATE), { reason: 'the release needs the CFO, not me' });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  const told = pressed.body.told as { note: string | null };
  assert.ok(told.note, 'a note was written');

  const notes = (readStoredRun(root, SLUG, run.id)!).notes ?? [];
  const note = notes.find((one) => one.id === told.note);
  assert.ok(note, 'the note is on the run');
  assert.equal(note!.pinned, true, 'a standing note — the next session of the phase reads it');
  assert.equal(note!.phase, 1);
  assert.match(note!.text, /the release needs the CFO, not me/);
  assert.match(note!.text, /Clear the gate/);
});

test('TC-2b: a console that may not run phases pins no note — the item still settles', async (t) => {
  const root = library(t);
  const run = storedRun(root);
  const svc = open(t, root, false);
  await gateAsks(svc);

  const pressed = await post(svc, cannotPath(GATE), { reason: 'the release needs the CFO, not me' });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  assert.equal((pressed.body.told as { note: string | null }).note, null, 'a pinned note reaches every boot prompt');
  const notes = (readStoredRun(root, SLUG, run.id)!).notes ?? [];
  assert.deepEqual(notes, []);
  assert.equal((await where(svc, GATE))?.group, 'done');
});

test('TC-3: a reason is required, and a session may not say it for a person', async (t) => {
  const root = library(t);
  storedRun(root);
  const svc = open(t, root);
  await gateAsks(svc);

  const bare = await post(svc, cannotPath(GATE), { reason: '   ' });
  assert.equal(bare.status, 400);
  const session = await post(svc, cannotPath(GATE), { reason: 'too hard' }, 'session');
  assert.equal(session.status, 403);
  assert.equal(session.body.door, 'session');
  assert.equal((await where(svc, GATE))?.group, 'approve', 'nothing was settled');

  const unknown = await post(svc, cannotPath('gate:nobody:9::'), { reason: 'no' });
  assert.equal(unknown.status, 404);
});

test('TC-4: a ledger item takes the human-step verb — the step settles as cannot', async (t) => {
  const root = library(t);
  storedRun(root);
  const svc = open(t, root);
  const clean = sanitiseStep({
    kind: 'browser-login', title: 'Sign the gh CLI in to the acme org', open_command: 'gh auth login',
    proof: 'cmd:"gh auth status"', lines: ['Run the command', 'Approve it in the browser'],
  }, 'session')!;
  const step = svc.humanStepsNow().declare({ slug: SLUG, phase: 2, birth: 'session', clean: clean.step });
  assert.ok(await until(async () => Boolean(await where(svc, step.id)), 15_000), 'the step is an item');

  const pressed = await post(svc, cannotPath(step.id), { reason: 'the org belongs to a client' });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  assert.equal(svc.humanStepsNow().get(step.id)?.state, 'cannot');
  assert.match(svc.humanStepsNow().get(step.id)?.note ?? '', /the org belongs to a client/);
});

