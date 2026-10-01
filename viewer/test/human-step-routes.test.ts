/**
 * A person's turn (control-tower phase 43) — the verbs, through the real
 * routes and the real Service.
 *
 *   HR-1  `open` `here` answers the step's link for the caller's own browser,
 *         and every open is counted and journalled `{n, where, by}`.
 *   HR-2  `open` `host` is behind `--allow-terminal` or `--allow-agent`, and
 *         answers the FULL URL for confirmation first: nothing opens and
 *         nothing is counted until the caller sends that URL back.
 *   HR-3  anything but http(s) is refused — at the route, and by the host
 *         opener itself, which never hands such a string to the desktop.
 *   HR-4  a step can be opened again any number of times, in every state
 *         short of settled; a settled one refuses by name.
 *   HR-5  `GET /api/human-steps?open=1` lists the waiting steps with their
 *         window, next reminder and moves; without `open=1`, settled ones too.
 *   HR-6  `check` on a landed proof: `proven`, `phase.human-step-proven`, and
 *         the SAME session resumed with an instruction naming what was proven.
 *   HR-7  `check` on an unlanded proof answers what it read, in its own words;
 *         the step waits on, and nothing resumes.
 *   HR-8  a `third-party-approval` step's window is days, with no wait budget
 *         spent, and its `cmd:` proof rides phase 6's back-off past the retired
 *         12-run limit and the eight-hour default budget; its landing proves
 *         the step and resumes the session.
 *   HR-9  a `one-time-code` / `os-prompt` step opens the embedded terminal with
 *         its command shown and run on Enter, and NOTHING of a code or secret
 *         is in the ticket, the journal or the ledger; the command's exit is
 *         the proof. Plus snooze, cannot (an errand with the reason), dismiss.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Service } = await import('../server/service.ts');
const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { HUMAN_STEPS_FILE, STEP_TERMINAL_SCRIPT, parkOnStep, stepProofOf } = await import('../server/human-steps.ts');
const { openUrlOnHost } = await import('../server/host-open.ts');
const { WatchScheduler } = await import('../server/watch-scheduler.ts');
const { MAX_CMD_RUNS_PER_PHASE, WATCH_CMD_BACKOFF_MS } = await import('../server/watch-refs.ts');
const { parkedMsOf } = await import('../server/runner/wait-budget.ts');
type RunState = import('../server/runner/state.ts').RunState;
type HumanStep = import('../server/human-steps.ts').HumanStep;
type WatchState = import('../server/watch-refs.ts').WatchState;

const SLUG = 'alpha';
const LINK = 'https://github.com/login/device';

type Harness = {
  svc: InstanceType<typeof Service>;
  root: string;
  resumed: { phase: number; mode: string; instruction?: string }[];
  opened: string[];
  cleanup: () => void;
};

function harness(over: Record<string, unknown> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-human-routes-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, ...over,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const resumed: Harness['resumed'] = [];
  const opened: string[] = [];
  const bag = svc as unknown as Record<string, unknown>;
  bag.recoverPhase = async (_slug: string, phase: number, mode: string, opts?: { instruction?: string }) => {
    resumed.push({ phase, mode, ...(opts?.instruction ? { instruction: opts.instruction } : {}) });
    return null;
  };
  bag.retryPhase = async () => null;
  bag.hostOpener = async (url: string) => { opened.push(url); return { opened: true, opener: 'open' }; };
  return {
    svc, root, resumed, opened,
    cleanup: () => { svc.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** A run whose phase 3 is parked on a freshly declared step — the shape every park door leaves. */
function parked(h: Harness, step: Record<string, unknown>, phase = 3): { state: RunState; step: HumanStep } {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [phase] } as never);
  const record = phaseRecord(state, phase);
  const at = new Date().toISOString();
  record.status = 'parked';
  record.sessionId = 'sess-own-1';
  record.declared = { status: 'needs-human', reason: 'a person must act', needs: 'credential', at } as never;
  const declared = h.svc.recordHumanStep({
    slug: SLUG, phase, birth: 'session', step, runId: state.id, sessionId: 'sess-own-1',
  });
  assert.ok(declared, 'the step is recorded');
  parkOnStep(record, declared!, 'session', at);
  state.status = 'parked' as never;
  saveRun(state);
  return { state, step: declared! };
}

type Captured = { status: number; body: Record<string, unknown> };

async function call(svc: unknown, method: string, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method,
    headers: { 'x-phase-console': '1', 'user-agent': 'Mozilla/5.0 (Macintosh)', host: '127.0.0.1:4130' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

function journal(root: string, state: RunState): { event: string; data: Record<string, unknown> }[] {
  return readFileSync(journalFile(root, SLUG, state.id), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
}

const ledgerText = (): string => readFileSync(join(INSTANCE_STATE_DIR, HUMAN_STEPS_FILE), 'utf8');

const BROWSER = {
  kind: 'browser-login', title: 'Sign the gh CLI in to the acme org', open_url: LINK,
  proof: 'cmd:"gh auth status"', where: 'host',
};

test('HR-1 — open `here` answers the link, counted and journalled {n, where, by}', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, BROWSER);
    const first = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'here' });
    assert.equal(first.status, 200);
    const opened = first.body.opened as { n: number; where: string; url: string };
    assert.deepEqual({ n: opened.n, where: opened.where, url: opened.url }, { n: 1, where: 'here', url: LINK });
    assert.equal(h.opened.length, 0, '`here` never touches the machine');
    const lines = journal(h.root, state).filter((l) => l.event === 'phase.human-step-opened');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].data.n, 1);
    assert.equal(lines[0].data.where, 'here');
    assert.equal(typeof lines[0].data.by, 'string');
    assert.equal(lines[0].data.stepId, step.id);
  } finally { h.cleanup(); }
});

test('HR-2 — open `host` needs the flag, and shows the full URL before anything opens', async () => {
  const off = harness();
  try {
    const { step } = parked(off, BROWSER);
    const refused = await call(off.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'host' });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /--allow-terminal or --allow-agent/);
    assert.equal(off.opened.length, 0);
  } finally { off.cleanup(); }

  const h = harness({ allowTerminal: true });
  try {
    const { state, step } = parked(h, BROWSER);
    const ask = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'host' });
    assert.equal(ask.status, 200);
    assert.deepEqual(ask.body.confirm, { url: LINK, where: 'host' }, 'the full URL, for the person to read');
    assert.equal(h.opened.length, 0, 'nothing opened before the confirmation');
    assert.equal((ask.body.step as HumanStep).opened, 0, 'and nothing counted');
    const wrong = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'host', confirm: 'https://evil.example/' });
    assert.ok(wrong.body.confirm, 'a confirmation that is not the step\'s own URL opens nothing');
    assert.equal(h.opened.length, 0);
    const go = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'host', confirm: LINK });
    assert.equal(go.status, 200);
    assert.deepEqual(h.opened, [LINK], 'the machine opened exactly the URL that was shown');
    assert.equal((go.body.opened as { where: string }).where, 'host');
    assert.equal(journal(h.root, state).filter((l) => l.event === 'phase.human-step-opened').length, 1);
  } finally { h.cleanup(); }
});

test('HR-3 — anything but http(s) is refused, at the route and by the opener itself', async () => {
  let ran = 0;
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://host', '-a Terminal', '']) {
    const answer = await openUrlOnHost(bad, { candidates: () => ['open'], run: async () => { ran++; return { ok: true }; } });
    assert.equal(answer.opened, false, `${bad || '(empty)'} is refused`);
  }
  assert.equal(ran, 0, 'the desktop is never handed one');
  const good = await openUrlOnHost(LINK, { candidates: () => ['open'], run: async (file, argv) => { ran++; assert.deepEqual([file, ...argv], ['open', LINK]); return { ok: true }; } });
  assert.equal(good.opened, true);
  const none = await openUrlOnHost(LINK, { candidates: () => [], run: async () => ({ ok: true }) });
  assert.match(String(none.detail), /no desktop opener/);

  const h = harness({ allowTerminal: true });
  try {
    // A declaration's non-http link never reaches the ledger at all (41 §5): the step has nothing to open.
    const { step } = parked(h, { kind: 'captcha', title: 'Pass the bot wall', open_url: 'javascript:alert(1)' });
    assert.equal(step.openUrl, undefined);
    const answer = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'host', confirm: 'javascript:alert(1)' });
    assert.equal(answer.status, 409);
    assert.equal(h.opened.length, 0);
  } finally { h.cleanup(); }
});

test('HR-4 — opened again any number of times in every open state; a settled step refuses by name', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, BROWSER);
    const ledger = h.svc.humanStepsNow();
    const states: string[] = [];
    for (let n = 1; n <= 5; n++) {
      // Through every open state: notified, opened, checking, and back.
      if (n === 3) ledger.move(step.id, 'checking', { by: 'test', verb: 'check' });
      states.push(ledger.get(step.id)!.state);
      const again = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'here' });
      assert.equal(again.status, 200, `open #${n} from ${states[states.length - 1]}`);
      assert.equal((again.body.opened as { n: number }).n, n);
    }
    assert.deepEqual([...new Set(states)].sort(), ['checking', 'notified', 'opened']);
    const lines = journal(h.root, state).filter((l) => l.event === 'phase.human-step-opened');
    assert.deepEqual(lines.map((l) => l.data.n), [1, 2, 3, 4, 5]);
    ledger.move(step.id, 'proven', { by: 'test', verb: 'prove' });
    const settled = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'here' });
    assert.equal(settled.status, 409);
    assert.equal(settled.body.state, 'proven');
    const unknown = await call(h.svc, 'POST', '/api/human-steps/000000000000/open', {});
    assert.equal(unknown.status, 404);
  } finally { h.cleanup(); }
});

test('HR-5 — the list: open steps with their window, next reminder and moves; settled ones only without open=1', async () => {
  const h = harness();
  try {
    const { step } = parked(h, BROWSER);
    const other = parked(h, { kind: 'decision', title: 'Pick the release name' }, 4).step;
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, { where: 'here' });
    await call(h.svc, 'POST', `/api/human-steps/${other.id}/dismiss`, { note: 'not needed' });
    const open = await call(h.svc, 'GET', '/api/human-steps?open=1');
    assert.equal(open.status, 200);
    const steps = open.body.steps as (HumanStep & { windowEnd: string; nextReminderAt: string | null; moves: { verb: string }[] })[];
    const mine = steps.find((s) => s.id === step.id)!;
    assert.ok(mine, 'the waiting step is listed');
    assert.equal(steps.find((s) => s.id === other.id), undefined, 'the dismissed one is not');
    assert.equal(Date.parse(mine.windowEnd) - Date.parse(mine.declaredAt), 7 * 24 * 3_600_000, 'seven days when it named none');
    assert.ok(mine.nextReminderAt, 'its next reminder is said');
    assert.deepEqual(mine.moves.map((m) => m.verb), ['notify', 'open'], 'each move, oldest first');
    assert.deepEqual((open.body.reminders as { series: number[] }).series, [900_000, 3_600_000, 21_600_000, 86_400_000]);
    const all = await call(h.svc, 'GET', '/api/human-steps');
    assert.ok((all.body.steps as HumanStep[]).find((s) => s.id === other.id)?.state === 'dismissed');
  } finally { h.cleanup(); }
});

test('HR-6 — check on a landed proof: proven, journalled, and the SAME session resumed naming what was proven', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, BROWSER);
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'landed', detail: 'exit 0' });
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body.check, { landed: true, read: 'landed — exit 0', ref: 'cmd:"gh auth status"' });
    assert.deepEqual(checked.body.resumed, { launched: true });
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
    assert.equal(h.resumed.length, 1, 'one resume');
    assert.equal(h.resumed[0].mode, 'resume', 'of the phase\'s OWN session');
    assert.match(String(h.resumed[0].instruction), /person's turn this phase declared is done: a person's turn is PROVEN — Sign in in a browser: "Sign the gh CLI in to the acme org"; proof cmd:"gh auth status" read: landed — exit 0/);
    const lines = journal(h.root, state);
    const proven = lines.filter((l) => l.event === 'phase.human-step-proven');
    assert.equal(proven.length, 1);
    assert.equal(proven[0].data.proof, 'cmd:"gh auth status"');
    const record = loadRun(h.root, SLUG, state.id)!.phases['3'];
    assert.equal(record.declared?.landed?.step?.id, step.id, 'the landing on the declaration says a step was proven');
    // A second press on a proven step refuses: nothing resumes twice.
    const again = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    assert.equal(again.status, 409);
    assert.equal(h.resumed.length, 1);
  } finally { h.cleanup(); }
});

test('HR-7 — check on an unlanded proof answers what it read, in its own words; nothing resumes', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, BROWSER);
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({
      ref, state: 'pending', detail: 'exit 1: You are not logged into any GitHub hosts',
    });
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    assert.equal(checked.status, 200);
    const check = checked.body.check as { landed: boolean; read: string };
    assert.equal(check.landed, false);
    assert.equal(check.read, 'pending — exit 1: You are not logged into any GitHub hosts', 'the proof\'s own words');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'notified', 'the step waits on');
    assert.equal(now.read, check.read, 'and remembers what the check read');
    assert.equal(now.checks, 1);
    assert.equal(h.resumed.length, 0, 'nothing resumed');
    assert.equal(journal(h.root, state).filter((l) => l.event === 'phase.human-step-checked').length, 1);
  } finally { h.cleanup(); }
});

test('HR-8 — a third-party approval waits days on no budget; its cmd: proof rides the back-off, and its landing proves the step', async () => {
  const h = harness();
  try {
    const threeDays = 3 * 24 * 60;
    const { state, step } = parked(h, {
      kind: 'third-party-approval', title: 'Ask the acme owner to approve the OAuth app', open_url: 'https://github.com/organizations/acme/settings/oauth_application_policy',
      proof: 'cmd:"gh api orgs/acme/installations"', windowMinutes: threeDays,
    });
    const record = state.phases['3'];
    assert.equal(record.waits ?? 0, 0, 'no declared wait is counted');
    assert.equal(record.declared?.budget, undefined, 'no wait budget is stamped');
    assert.deepEqual(stepProofOf(record), { ref: 'cmd:"gh api orgs/acme/installations"', until: Date.parse(step.until!) });
    let now = Date.parse(record.declared!.at);
    let answer: WatchState['state'] = 'pending';
    const landedCalls: string[] = [];
    const clock = { now: () => now, setTimeout: (): unknown => 0, clearTimeout: (): void => {} };
    const scheduler = new WatchScheduler({
      runs: () => [{ slug: SLUG, state }],
      probe: async (target) => ({ ref: target.ref, state: answer, detail: answer === 'landed' ? 'exit 0' : 'exit 1' }),
      clock,
      onLanded: async (slug, st, phase, landed) => {
        landedCalls.push(landed.ref);
        return (h.svc as unknown as { onWatchLanded: (...a: unknown[]) => Promise<'resumed' | 'deferred' | 'done'> })
          .onWatchLanded(slug, st, phase, landed);
      },
    });
    scheduler.open();
    const gaps: number[] = [];
    for (let run = 1; run <= 14; run++) {
      await scheduler.tick();
      const row = record.watchState?.refs.find((r) => r.ref === 'cmd:"gh api orgs/acme/installations"');
      assert.ok(row, `run ${run}: the proof is watched off the record`);
      assert.equal(row!.state, 'pending', `run ${run}: still pending — never refused inside the window`);
      assert.equal(row!.runs, run);
      gaps.push(row!.nextDueAt! - now);
      now = row!.nextDueAt!;
    }
    assert.deepEqual(gaps.slice(0, 4), [...WATCH_CMD_BACKOFF_MS], 'phase 6\'s back-off: 5 m, 15 m, 1 h, 6 h');
    assert.ok(gaps.slice(4).every((gap) => gap === WATCH_CMD_BACKOFF_MS[3]), 'then six hours, for as long as the window lasts');
    assert.ok(MAX_CMD_RUNS_PER_PHASE > 14, 'the old twelve-run cap is not what bounds it');
    assert.ok(now - Date.parse(record.declared!.at) > 8 * 3_600_000, 'well past the eight-hour default budget');
    assert.equal(parkedMsOf(record, now), 0, 'and nothing was charged to a wait budget');
    // The approval lands: the step is proven by the watch, the session resumed.
    answer = 'landed';
    await scheduler.tick();
    assert.deepEqual(landedCalls, ['cmd:"gh api orgs/acme/installations"']);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.provenBy, 'watch');
    assert.equal(h.resumed.length, 1);
    assert.match(String(h.resumed[0].instruction), /Get an approval elsewhere: "Ask the acme owner to approve the OAuth app".*its proof landed on the console's watch/);
    // Past the window a still-pending proof would be refused in the step's words.
    const late = { ...record, declared: { ...record.declared!, step: { ...record.declared!.step!, until: new Date(Date.parse(record.declared!.at) + 60_000).toISOString() } }, watchState: undefined };
    const lateState = { ...state, phases: { '3': late } } as RunState;
    answer = 'pending';
    const lateScheduler = new WatchScheduler({ runs: () => [{ slug: SLUG, state: lateState }], probe: async (t) => ({ ref: t.ref, state: 'pending' }), clock });
    lateScheduler.open();
    await lateScheduler.tick();
    lateScheduler.close();
    scheduler.close();
    const lateRow = lateState.phases['3'].watchState?.refs[0];
    assert.equal(lateRow?.state, 'refused');
    assert.match(String(lateRow?.detail), /the human step's window ended/);
  } finally { h.cleanup(); }
});

test('HR-9 — a one-time-code step opens the embedded terminal with its command, and no code or secret rides anything', async () => {
  const h = harness({ allowTerminal: true });
  try {
    const PLANTED = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const { state, step } = parked(h, {
      kind: 'one-time-code', title: `Type the 2FA code for npm publish (not ${PLANTED})`, open_command: 'npm publish --access restricted',
      lines: ['Run it', 'Type the six-digit code when npm asks — 123456 is an example'],
    });
    const launches: { args: string[]; meta?: Record<string, unknown> }[] = [];
    (h.svc.terminals as unknown as { mint: unknown }).mint = async (_id: unknown, _size: unknown, launch: { args: string[]; meta?: Record<string, unknown> }) => {
      launches.push(launch);
      return { ok: true, sessionId: 'term-1', token: 'tok-1', expiresAt: Date.now() + 60_000, session: { id: 'term-1' } };
    };
    const answer = await call(h.svc, 'POST', `/api/human-steps/${step.id}/open`, {});
    assert.equal(answer.status, 200);
    const opened = answer.body.opened as { where: string; command: string; terminal: { sessionId: string; token: string } };
    assert.equal(opened.where, 'terminal');
    assert.equal(opened.command, 'npm publish --access restricted');
    assert.equal(opened.terminal.sessionId, 'term-1');
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].args, ['-ilc', STEP_TERMINAL_SCRIPT, 'npm publish --access restricted'], 'the command rides as an argument, prefilled');
    assert.deepEqual(launches[0].meta, { humanStep: { id: step.id } }, 'the ticket carries the step id, nothing else');
    // Nothing of a code or a secret in the ticket, the journal or the ledger.
    for (const [where, text] of [
      ['ticket', JSON.stringify(answer.body)], ['launch', JSON.stringify(launches[0])],
      ['journal', readFileSync(journalFile(h.root, SLUG, state.id), 'utf8')], ['ledger', ledgerText()],
    ] as const) {
      assert.equal(text.includes(PLANTED), false, `${where} carries no token`);
      assert.equal(text.includes('123456'), false, `${where} carries no code`);
    }
    // The command's exit is the proof (the step names none): exit 1 is said, exit 0 proves it.
    await (h.svc as unknown as { humanStepTerminalExited: (id: string, code: number) => Promise<void> }).humanStepTerminalExited(step.id, 1);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.read, 'the command exited 1');
    await (h.svc as unknown as { humanStepTerminalExited: (id: string, code: number) => Promise<void> }).humanStepTerminalExited(step.id, 0);
    const done = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(done.state, 'proven');
    assert.equal(done.provenBy, 'terminal');
    assert.equal(h.resumed.length, 1, 'the session resumes on the exit');
    // Without --allow-terminal the command is answered to run elsewhere, and still counted.
    const off = harness();
    try {
      const other = parked(off, { kind: 'os-prompt', title: 'Unlock the login keychain', open_command: 'security unlock-keychain' }).step;
      const plain = await call(off.svc, 'POST', `/api/human-steps/${other.id}/open`, {});
      const plainOpened = plain.body.opened as { where: string; command: string; why: string; terminal?: unknown };
      assert.equal(plainOpened.where, 'here');
      assert.equal(plainOpened.terminal, undefined);
      assert.match(plainOpened.why, /--allow-terminal/);
    } finally { off.cleanup(); }
  } finally { h.cleanup(); }
});

test('HR-9 — snooze, cannot and dismiss: the reminder floor, an errand with the reason, a withdrawal', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, BROWSER);
    const snoozed = await call(h.svc, 'POST', `/api/human-steps/${step.id}/snooze`, { minutes: 90 });
    assert.equal(snoozed.status, 200);
    const until = Date.parse((snoozed.body.snoozed as { until: string }).until);
    assert.ok(Math.abs(until - (Date.now() + 90 * 60_000)) < 5_000, 'no reminder for ninety minutes');
    assert.ok(Date.parse(String((snoozed.body.step as { nextReminderAt: string }).nextReminderAt)) >= until - 1);
    const huge = await call(h.svc, 'POST', `/api/human-steps/${step.id}/snooze`, { minutes: 100_000 });
    assert.ok(Date.parse((huge.body.snoozed as { until: string }).until) - Date.now() <= 24 * 3_600_000 + 5_000, 'a day at most');

    const empty = await call(h.svc, 'POST', `/api/human-steps/${step.id}/cannot`, { reason: '  ' });
    assert.equal(empty.status, 400, 'an errand needs the reason');
    const cannot = await call(h.svc, 'POST', `/api/human-steps/${step.id}/cannot`, { reason: 'I am not an owner of acme' });
    assert.equal(cannot.status, 200);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'cannot');
    const after = loadRun(h.root, SLUG, state.id)!;
    assert.equal(after.phases['3'].declared?.step?.settled, 'cannot', 'its proof leaves the watch');
    assert.equal(stepProofOf(after.phases['3']), null);
    const errand = after.recoveries?.['3']?.errand;
    assert.equal(errand?.situation, 'blocked-declared:human-acts');
    assert.match(String(errand?.need), /can't do this — sign in in a browser: Sign the gh CLI in to the acme org\. Their reason: I am not an owner of acme\./);
    assert.equal(journal(h.root, state).filter((l) => l.event === 'phase.human-step-cannot').length, 1);

    const second = parked(h, BROWSER, 5);
    const dismissed = await call(h.svc, 'POST', `/api/human-steps/${second.step.id}/dismiss`, {});
    assert.equal(dismissed.status, 200);
    assert.equal(h.svc.humanStepsNow().get(second.step.id)!.state, 'dismissed');
    assert.equal(h.svc.humanStepsNow().get(second.step.id)!.note, 'withdrawn by a person');
    const bad = await call(h.svc, 'POST', `/api/human-steps/${second.step.id}/complete`, {});
    assert.equal(bad.status, 404, 'there is no verb that completes a step');
  } finally { h.cleanup(); }
});

test('HR-9 — a secret-entry step stores its secret in the registry, and nothing else ever holds it', async () => {
  const SECRET = 'npm_Zq8vXw2LmN4pR6tY1uI3oP5aS7dF9gH0jK2l';
  const off = harness();
  try {
    const { step } = parked(off, { kind: 'secret-entry', title: 'Paste the npm publish token', credential: 'npm-token' });
    const refused = await call(off.svc, 'POST', `/api/human-steps/${step.id}/check`, { secret: SECRET });
    assert.equal(refused.status, 403, 'holding a credential is --allow-accounts');
    assert.equal(off.svc.humanStepsNow().get(step.id)!.state, 'notified', 'and nothing moved');
  } finally { off.cleanup(); }

  const h = harness({ allowAccounts: true });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pc-step-secrets-'));
    const { storeStepSecret } = await import('../server/human-steps.ts');
    (h.svc as unknown as { stepSecretStore: unknown }).stepSecretStore = (id: string, secret: string) =>
      storeStepSecret({ dir, platform: 'linux' }, id, secret);
    const { state, step } = parked(h, { kind: 'secret-entry', title: 'Paste the npm publish token', credential: 'npm-token' });
    const wrongKind = parked(h, BROWSER, 6).step;
    const notHere = await call(h.svc, 'POST', `/api/human-steps/${wrongKind.id}/check`, { secret: SECRET });
    assert.equal(notHere.status, 400, 'only a secret-entry step takes a secret');
    const answer = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { secret: SECRET });
    assert.equal(answer.status, 200);
    assert.equal((answer.body.check as { landed: boolean }).landed, true, 'the registry answered, so the probe is green');
    const done = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(done.state, 'proven');
    assert.equal(done.stored, 'file', 'the ledger records WHERE it went');
    assert.equal(readFileSync(join(dir, 'npm-token'), 'utf8'), `${SECRET}\n`, 'the registry holds it');
    for (const [where, text] of [
      ['answer', JSON.stringify(answer.body)], ['ledger', ledgerText()],
      ['journal', readFileSync(journalFile(h.root, SLUG, state.id), 'utf8')],
    ] as const) {
      assert.equal(text.includes(SECRET), false, `${where} never holds the secret`);
    }
    assert.equal(h.resumed.length, 1, 'and the session resumes');
    rmSync(dir, { recursive: true, force: true });
  } finally { h.cleanup(); }
});
